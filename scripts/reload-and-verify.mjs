#!/usr/bin/env node
import { withCDP } from './lib/cdp-client.mjs';
import { setTimeout as delay } from 'node:timers/promises';

async function ensureRuntimeReady(cdp) {
    await cdp.send('Runtime.enable');
    await cdp.send('Page.enable');
}

async function verifyPluginReload(cdp) {
    const evaluation = await cdp.evaluate(`(async () => {
        const pluginId = 'obsidianr';
        const manager = window.app?.plugins;
        if (!manager) {
            return { ok: false, reason: 'Plugin manager not available' };
        }
        const disable = manager.disablePlugin?.bind(manager);
        const enable = manager.enablePlugin?.bind(manager);
        if (typeof disable !== 'function' || typeof enable !== 'function') {
            return { ok: false, reason: 'Enable/disable hooks unavailable' };
        }
        try {
            if (manager.enabledPlugins?.has?.(pluginId)) {
                await disable(pluginId);
            }
            await enable(pluginId);
            await new Promise((resolve) => setTimeout(resolve, 300));
            const plugin = manager.plugins?.[pluginId] ?? null;
            const readerReady = Boolean(plugin?.reader);
            return {
                ok: readerReady,
                reason: readerReady ? null : 'Reader manager missing after reload',
                enabled: manager.enabledPlugins?.has?.(pluginId) ?? false,
                parameters: plugin?.reader?.state?.snapshot?.parameters ?? null
            };
        } catch (error) {
            return { ok: false, reason: error?.message ?? 'Failed to reload plugin' };
        }
    })()`);

    if (!evaluation?.ok) {
        throw new Error(`Plugin reload validation failed: ${evaluation?.reason ?? 'unknown error'}`);
    }
    return evaluation;
}

async function main() {
    const result = await withCDP({}, async (cdp) => {
        await ensureRuntimeReady(cdp);
        const reloadInfo = await verifyPluginReload(cdp);
        console.log('[reload-and-verify] Plugin reloaded successfully', reloadInfo);
        return reloadInfo;
    });
    return result;
}

main().catch((error) => {
    console.error('[reload-and-verify] ERROR', error.message ?? error);
    process.exitCode = 1;
});
