#!/usr/bin/env node
import { WebSocket } from 'ws';

const CDP_PORT = 9222;

async function getTarget() {
    const response = await fetch(`http://localhost:${CDP_PORT}/json`);
    const targets = await response.json();
    return targets.find(t => t.type === 'page' && t.url.includes('index.html'));
}

class CDPClient {
    constructor(ws) {
        this.ws = ws;
        this.messageId = 1;
        this.callbacks = new Map();
        ws.on('message', (data) => {
            const msg = JSON.parse(data);
            if (msg.id && this.callbacks.has(msg.id)) {
                const { resolve, reject } = this.callbacks.get(msg.id);
                this.callbacks.delete(msg.id);
                if (msg.error) reject(new Error(msg.error.message));
                else resolve(msg.result);
            }
        });
    }

    send(method, params = {}) {
        return new Promise((resolve, reject) => {
            const id = this.messageId++;
            this.callbacks.set(id, { resolve, reject });
            this.ws.send(JSON.stringify({ id, method, params }));
            setTimeout(() => {
                if (this.callbacks.has(id)) {
                    this.callbacks.delete(id);
                    reject(new Error(`Timeout: ${method}`));
                }
            }, 15000);
        });
    }

    async eval(expression) {
        const result = await this.send('Runtime.evaluate', {
            expression,
            returnByValue: true,
            awaitPromise: true
        });
        if (result.exceptionDetails) {
            throw new Error(result.exceptionDetails.exception?.description || 'Unknown error');
        }
        return result.result.value;
    }

    close() { this.ws.close(); }
}

const wait = (ms) => new Promise(resolve => setTimeout(resolve, ms));

async function main() {
    console.log('🔄 Reloading Obsidian and verifying margins...\n');
    
    const target = await getTarget();
    if (!target) throw new Error('Obsidian not found');

    const ws = new WebSocket(target.webSocketDebuggerUrl);
    await new Promise((resolve, reject) => {
        ws.once('open', resolve);
        ws.once('error', reject);
    });

    const client = new CDPClient(ws);
    await client.send('Runtime.enable');

    // Reload Obsidian
    console.log('📥 Reloading Obsidian...');
    await client.eval('app.commands.executeCommandById("app:reload")');
    await wait(3000);
    console.log('✅ Obsidian reloaded\n');

    // Wait for plugin to load
    console.log('⏳ Waiting for plugin...');
    let retries = 10;
    let hasPlugin = false;
    while (retries > 0 && !hasPlugin) {
        try {
            hasPlugin = await client.eval('Boolean(app?.plugins?.plugins?.obsidianr)');
            if (hasPlugin) break;
        } catch (e) {}
        await wait(500);
        retries--;
    }

    if (!hasPlugin) {
        console.log('❌ Plugin not loaded');
        client.close();
        return;
    }
    console.log('✅ Plugin loaded\n');

    // Check if reader mode is active
    const isActive = await client.eval('app.plugins.plugins.obsidianr.reader.state.snapshot.active');
    
    if (!isActive) {
        console.log('📖 Enabling reader mode...');
        await client.eval('app.plugins.plugins.obsidianr.reader.toggleReaderMode()');
        await wait(1500);
        console.log('✅ Reader mode enabled\n');
    } else {
        console.log('📖 Reader mode already active\n');
        // Refresh it
        console.log('🔄 Refreshing reader mode...');
        await client.eval('app.plugins.plugins.obsidianr.reader.toggleReaderMode()');
        await wait(500);
        await client.eval('app.plugins.plugins.obsidianr.reader.toggleReaderMode()');
        await wait(1500);
        console.log('✅ Reader mode refreshed\n');
    }

    // Now verify margins
    console.log('🔍 Inspecting margins...\n');
    
    const data = await client.eval(`
        (() => {
            const viewport = document.querySelector('.markdown-reading-view');
            const container = document.querySelector('.obsidianr-reader-container');
            const settings = app.plugins.plugins.obsidianr.reader.state.snapshot.parameters.horizontalMargins;
            
            if (!viewport || !container) return { error: 'Elements not found' };
            
            const vRect = viewport.getBoundingClientRect();
            const cRect = container.getBoundingClientRect();
            const vStyle = window.getComputedStyle(viewport);
            const cStyle = window.getComputedStyle(container);
            
            return {
                settings: settings,
                viewportWidth: Math.round(vRect.width),
                viewportLeft: Math.round(vRect.left),
                viewportRight: Math.round(vRect.right),
                containerWidth: Math.round(cRect.width),
                containerLeft: Math.round(cRect.left),
                containerRight: Math.round(cRect.right),
                leftMargin: Math.round(cRect.left - vRect.left),
                rightMargin: Math.round(vRect.right - cRect.right),
                cssVar: vStyle.getPropertyValue('--obsidianr-horizontal-margin'),
                computedLeft: cStyle.left,
                computedRight: cStyle.right,
                viewportPaddingLeft: vStyle.paddingLeft,
                viewportPaddingRight: vStyle.paddingRight
            };
        })()
    `);

    if (data.error) {
        console.log('❌', data.error);
        client.close();
        return;
    }

    console.log('📊 Margin Analysis:');
    console.log('─'.repeat(60));
    console.log(`  Setting: ${data.settings}%`);
    console.log(`  CSS Variable: ${data.cssVar}`);
    console.log('');
    console.log('  Viewport:');
    console.log(`    Width: ${data.viewportWidth}px`);
    console.log(`    Padding Left: ${data.viewportPaddingLeft}`);
    console.log(`    Padding Right: ${data.viewportPaddingRight}`);
    console.log('');
    console.log('  Container:');
    console.log(`    Width: ${data.containerWidth}px`);
    console.log(`    Computed left: ${data.computedLeft}`);
    console.log(`    Computed right: ${data.computedRight}`);
    console.log('');
    console.log('  Actual Margins:');
    console.log(`    Left margin: ${data.leftMargin}px`);
    console.log(`    Right margin: ${data.rightMargin}px`);
    
    const marginDiff = Math.abs(data.leftMargin - data.rightMargin);
    const expectedMargin = Math.round((data.viewportWidth * data.settings) / 100);
    
    console.log('');
    console.log('  Expected margin: ' + expectedMargin + 'px (each side)');
    console.log(`  Difference between left/right: ${marginDiff}px`);
    console.log('');
    
    if (marginDiff <= 1) {
        console.log('  ✅ SUCCESS! Margins are symmetric!');
    } else {
        console.log('  ❌ FAIL! Margins are NOT symmetric!');
        console.log(`     Left: ${data.leftMargin}px, Right: ${data.rightMargin}px`);
    }
    
    const leftCorrect = Math.abs(data.leftMargin - expectedMargin) <= 2;
    const rightCorrect = Math.abs(data.rightMargin - expectedMargin) <= 2;
    
    console.log('');
    if (leftCorrect && rightCorrect) {
        console.log('  ✅ Margins match expected value!');
    } else {
        console.log('  ⚠️  Margins don\'t match expected:');
        if (!leftCorrect) console.log(`     Left: expected ${expectedMargin}px, got ${data.leftMargin}px`);
        if (!rightCorrect) console.log(`     Right: expected ${expectedMargin}px, got ${data.rightMargin}px`);
    }

    client.close();
}

main().catch(err => {
    console.error('\n❌ Error:', err.message);
    process.exit(1);
});
