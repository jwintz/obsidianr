const DEBUG_FLAG = 'obsidianrDebug';

function isDebugEnabled(): boolean {
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
    return true;
}

export function logDebug(...values: unknown[]): void {
    if (!isDebugEnabled()) {
        return;
    }
    console.log('[ObsidianR]', ...values);
}

export function enableDebugLogging(): void {
    try {
        if (typeof localStorage !== 'undefined') {
            localStorage.setItem(DEBUG_FLAG, 'true');
        }
    } catch (error) {
        console.warn('[ObsidianR] Failed to enable debug logging', error);
    }
}

export function disableDebugLogging(): void {
    try {
        if (typeof localStorage !== 'undefined') {
            localStorage.setItem(DEBUG_FLAG, 'false');
        }
    } catch (error) {
        console.warn('[ObsidianR] Failed to disable debug logging', error);
    }
}
