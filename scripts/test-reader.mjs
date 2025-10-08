#!/usr/bin/env node
/**
 * Core test script using Chrome DevTools Protocol (CDP)
 * Tests reader mode functionality in Obsidian
 */

import { WebSocket } from 'ws';

// CDP Client wrapper
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
        });
    }

    async eval(expression) {
        const result = await this.send('Runtime.evaluate', {
            expression,
            returnByValue: true,
            awaitPromise: true
        });
        if (result.exceptionDetails) {
            throw new Error(result.exceptionDetails.text);
        }
        return result.result.value;
    }

    close() { this.ws.close(); }
}

// Get Obsidian page target
async function getTarget() {
    const response = await fetch('http://localhost:9222/json');
    const targets = await response.json();
    const target = targets.find(t => t.type === 'page' && t.url.includes('index.html'));
    if (!target) {
        throw new Error('Obsidian not found. Start with: open -a Obsidian --args --remote-debugging-port=9222');
    }
    return target;
}

// Test: Check all pages render content
async function testAllPages(client) {
    console.log('\n📖 Testing All Pages for Content\n');
    console.log('='.repeat(80));

    const totalPages = await client.eval('app.plugins.plugins.obsidianr.reader.state.snapshot.totalPages');
    const results = [];
    
    for (let page = 0; page < Math.min(totalPages, 5); page++) {
        await client.eval(`app.plugins.plugins.obsidianr.reader.state.update({ currentPage: ${page} })`);
        await new Promise(r => setTimeout(r, 100));
        
        const data = await client.eval(`
            (() => {
                const content = document.querySelector('.obsidianr-reader-content');
                const header = document.querySelector('.view-header .view-header-title-container');
                const indicator = document.querySelector('.obsidianr-reader-page-indicator');
                
                const headerRect = header.getBoundingClientRect();
                const indicatorRect = indicator.getBoundingClientRect();
                const renderTop = headerRect.bottom;
                const renderBottom = indicatorRect.top;
                
                const paragraphs = Array.from(content.querySelectorAll('p'));
                const visible = paragraphs.filter(p => {
                    const rect = p.getBoundingClientRect();
                    return rect.top < renderBottom && rect.bottom > renderTop;
                });
                
                return {
                    visibleCount: visible.length,
                    firstText: visible[0] ? visible[0].textContent.substring(0, 60).replace(/\\s+/g, ' ').trim() : null
                };
            })()
        `);
        
        results.push({ page, ...data });
    }

    console.log(`Total pages: ${totalPages}\n`);
    let failed = 0;
    results.forEach(r => {
        const status = r.visibleCount > 0 ? '✅' : '❌';
        console.log(`${status} Page ${r.page}: ${r.visibleCount} paragraphs visible`);
        if (r.firstText) {
            console.log(`   "${r.firstText}..."`);
        } else {
            console.log(`   (no content visible)`);
            failed++;
        }
    });

    if (failed === 0) {
        console.log(`\n✅ SUCCESS! All tested pages show content!`);
    } else {
        console.log(`\n❌ FAILED: ${failed} page(s) have no visible content!`);
    }
    
    return failed === 0;
}

// Test: Check pagination state
async function testPaginationState(client) {
    console.log('\n📊 Pagination State\n');
    console.log('='.repeat(80));

    const data = await client.eval(`
        (() => {
            const state = app.plugins.plugins.obsidianr.reader.state.snapshot;
            const pagination = app.plugins.plugins.obsidianr.reader.pagination;
            const container = document.querySelector('.obsidianr-reader-container');
            const content = document.querySelector('.obsidianr-reader-content');
            const header = document.querySelector('.view-header .view-header-title-container');
            const indicator = document.querySelector('.obsidianr-reader-page-indicator');
            
            const containerRect = container.getBoundingClientRect();
            const contentRect = content.getBoundingClientRect();
            const headerRect = header.getBoundingClientRect();
            const indicatorRect = indicator.getBoundingClientRect();
            
            return {
                currentPage: state.currentPage,
                totalPages: state.totalPages,
                pageHeight: pagination ? pagination.getPageHeight() : 0,
                contentHeight: pagination ? pagination.getContentHeight() : 0,
                containerTop: Math.round(containerRect.top),
                containerBottom: Math.round(containerRect.bottom),
                contentTop: Math.round(contentRect.top),
                headerBottom: Math.round(headerRect.bottom),
                indicatorTop: Math.round(indicatorRect.top),
                renderHeight: Math.round(indicatorRect.top - headerRect.bottom)
            };
        })()
    `);

    console.log(`Current page: ${data.currentPage} / ${data.totalPages}`);
    console.log(`Page height: ${data.pageHeight}px`);
    console.log(`Content height: ${data.contentHeight}px`);
    console.log(`\nRendering area: ${data.headerBottom} → ${data.indicatorTop} (${data.renderHeight}px)`);
    console.log(`Container: ${data.containerTop} → ${data.containerBottom}`);
    console.log(`Content: ${data.contentTop}px`);
    
    const containerCorrect = data.containerTop === data.headerBottom;
    console.log(`\nContainer position: ${containerCorrect ? '✅ Correct' : '❌ Wrong'}`);
    
    return containerCorrect;
}

// Main test runner
async function main() {
    try {
        console.log('🔍 ObsidianR Reader Mode Tests\n');
        
        const target = await getTarget();
        const ws = new WebSocket(target.webSocketDebuggerUrl);
        await new Promise(r => ws.once('open', r));

        const client = new CDPClient(ws);
        await client.send('Runtime.enable');

        // Run tests
        const test1 = await testPaginationState(client);
        const test2 = await testAllPages(client);

        console.log('\n' + '='.repeat(80));
        console.log('SUMMARY');
        console.log('='.repeat(80));
        console.log(`Pagination State: ${test1 ? '✅ PASS' : '❌ FAIL'}`);
        console.log(`Page Content: ${test2 ? '✅ PASS' : '❌ FAIL'}`);
        
        const allPassed = test1 && test2;
        console.log(`\n${allPassed ? '✅ ALL TESTS PASSED' : '❌ SOME TESTS FAILED'}`);

        client.close();
        process.exit(allPassed ? 0 : 1);
    } catch (error) {
        console.error('❌ Error:', error.message);
        process.exit(1);
    }
}

main();
