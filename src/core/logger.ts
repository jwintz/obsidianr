const DEBUG_FLAG = 'obsidianrDebug';

let cachedDebugEnabled: boolean | null = null;

function readDebugFlag(): boolean {
    try {
        if (typeof localStorage !== 'undefined') {
            const stored = localStorage.getItem(DEBUG_FLAG);
            if (stored !== null) {
                return stored === 'true';
            }
        }
    } catch (error) {
        console.warn('[ObsidianR] Unable to access localStorage for debug flag', error);
    }
    return false;
}

function isDebugEnabled(): boolean {
    if (cachedDebugEnabled === null) {
        cachedDebugEnabled = readDebugFlag();
    }
    return cachedDebugEnabled;
}

function setDebugCache(value: boolean): void {
    cachedDebugEnabled = value;
}

export function logDebug(...values: unknown[]): void {
    if (!isDebugEnabled()) {
        return;
    }
    console.debug('[ObsidianR]', ...values);
}

export function enableDebugLogging(): void {
    try {
        if (typeof localStorage !== 'undefined') {
            localStorage.setItem(DEBUG_FLAG, 'true');
        }
    } catch (error) {
        console.warn('[ObsidianR] Failed to enable debug logging', error);
    }
    setDebugCache(true);
}

export function disableDebugLogging(): void {
    try {
        if (typeof localStorage !== 'undefined') {
            localStorage.setItem(DEBUG_FLAG, 'false');
        }
    } catch (error) {
        console.warn('[ObsidianR] Failed to disable debug logging', error);
    }
    setDebugCache(false);
}

export function isDebugLoggingEnabled(): boolean {
    return isDebugEnabled();
}
