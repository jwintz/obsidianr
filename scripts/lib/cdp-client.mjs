import { setTimeout as delay } from 'node:timers/promises';

const DEFAULT_HOST = '127.0.0.1';
const DEFAULT_PORT = 9222;
const DEFAULT_TIMEOUT_MS = 10_000;

class CDPConnection {
    constructor(socket) {
        this.socket = socket;
        this.messageId = 0;
        this.pending = new Map();
        this.closed = false;

        this.socket.addEventListener('message', (event) => {
            if (!event?.data) {
                return;
            }
            let payload;
            try {
                payload = JSON.parse(event.data);
            } catch (error) {
                console.error('[CDP] Failed to parse message', event.data, error);
                return;
            }

            if (payload.id && this.pending.has(payload.id)) {
                const { resolve, reject } = this.pending.get(payload.id);
                this.pending.delete(payload.id);
                if (payload.error) {
                    reject(new Error(`${payload.error.message || 'CDP error'} (${payload.error.code ?? 'unknown'})`));
                } else {
                    resolve(payload.result ?? payload);
                }
                return;
            }
        });

        const handleClose = (event) => {
            if (this.closed) {
                return;
            }
            this.closed = true;
            const error = new Error(`CDP connection closed: ${event?.reason || 'unknown reason'}`);
            for (const { reject } of this.pending.values()) {
                reject(error);
            }
            this.pending.clear();
        };

        this.socket.addEventListener('close', handleClose);
        this.socket.addEventListener('error', handleClose);
    }

    async send(method, params = {}) {
        if (this.closed) {
            throw new Error('CDP connection already closed');
        }
        const id = ++this.messageId;
        const message = JSON.stringify({ id, method, params });
        return new Promise((resolve, reject) => {
            this.pending.set(id, { resolve, reject });
            try {
                this.socket.send(message);
            } catch (error) {
                this.pending.delete(id);
                reject(error);
            }
        });
    }

    async evaluate(expression, { awaitPromise = true, returnByValue = true } = {}) {
        const response = await this.send('Runtime.evaluate', {
            expression,
            awaitPromise,
            returnByValue
        });

        if (response.exceptionDetails) {
            const { text, description } = response.exceptionDetails?.exception ?? {};
            throw new Error(`Evaluation failed: ${description || text || 'unknown error'}`);
        }

        return response.result?.value;
    }

    async callFunction({ source, args = [] }) {
        const serializedArgs = args.map((value) => ({ value }));
        const response = await this.send('Runtime.callFunctionOn', {
            functionDeclaration: source,
            arguments: serializedArgs,
            executionContextId: 0,
            awaitPromise: true,
            returnByValue: true
        });
        if (response.exceptionDetails) {
            const { text, description } = response.exceptionDetails?.exception ?? {};
            throw new Error(`Function call failed: ${description || text || 'unknown error'}`);
        }
        return response.result?.value;
    }

    async close() {
        if (this.closed) {
            return;
        }
        this.closed = true;
        try {
            this.socket.close();
        } catch (error) {
            console.warn('[CDP] Failed to close socket cleanly', error);
        }
        for (const { reject } of this.pending.values()) {
            reject(new Error('CDP connection closed'));
        }
        this.pending.clear();
    }
}

async function waitForTarget({ host, port, timeoutMs }) {
    const deadline = Date.now() + timeoutMs;
    let lastError;
    while (Date.now() < deadline) {
        try {
            const response = await fetch(`http://${host}:${port}/json/list`);
            if (!response.ok) {
                throw new Error(`Unexpected status ${response.status}`);
            }
            const targets = await response.json();
            const pageTarget = targets.find((target) => target.type === 'page' && /obsidian/i.test(target.title));
            if (pageTarget?.webSocketDebuggerUrl) {
                return pageTarget;
            }
        } catch (error) {
            lastError = error;
        }
        await delay(250);
    }
    throw new Error(`Unable to find Obsidian CDP target: ${lastError?.message ?? 'unknown error'}`);
}

export async function connectToObsidianTarget(options = {}) {
    const host = options.host ?? DEFAULT_HOST;
    const port = options.port ?? DEFAULT_PORT;
    const timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;

    const target = await waitForTarget({ host, port, timeoutMs });
    if (typeof WebSocket !== 'function') {
        throw new Error('WebSocket API is not available in this Node runtime');
    }

    const socket = new WebSocket(target.webSocketDebuggerUrl);
    await new Promise((resolve, reject) => {
        socket.addEventListener('open', resolve, { once: true });
        socket.addEventListener('error', (event) => reject(new Error(event?.message || 'Failed to open CDP socket')), { once: true });
    });

    return new CDPConnection(socket);
}

export async function withCDP(options, fn) {
    const connection = await connectToObsidianTarget(options);
    try {
        return await fn(connection);
    } finally {
        await connection.close();
    }
}