#!/usr/bin/env node
import fs from 'node:fs/promises';
import path from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { withCDP } from './lib/cdp-client.mjs';

const CHAPTER_PATH = process.env.OBSIDIANR_TEST_CHAPTER ?? 'Books/Dossier 64/Dossier 64 - Chapter 1.md';
const SCREENSHOT_DIR = path.resolve(process.cwd(), 'artifacts/screenshots');
const SCREENSHOT_BASENAME = 'reader';
const DIAGNOSTICS_DIR = path.resolve(process.cwd(), 'artifacts/dom');

async function ensureRuntimeReady(cdp) {
    await cdp.send('Runtime.enable');
    await cdp.send('Page.enable');
}

async function ensurePluginPresent(cdp) {
    const status = await cdp.evaluate(`(() => {
        const plugin = window.app?.plugins?.plugins?.obsidianr ?? null;
        return {
            ok: Boolean(plugin),
            active: plugin?.enabled ?? false,
            hasReader: Boolean(plugin?.reader)
        };
    })()`);
    if (!status?.ok || !status?.hasReader) {
        throw new Error('ObsidianR plugin not available or reader manager missing');
    }
    return status;
}

async function openChapter(cdp) {
    const result = await cdp.evaluate(`(async () => {
        const targetPath = ${JSON.stringify(CHAPTER_PATH)};
        const vault = window.app?.vault;
        const workspace = window.app?.workspace;
        const currentFile = workspace?.getActiveFile?.() ?? null;
        if (currentFile?.path === targetPath) {
            return { ok: true, reopened: false };
        }
        const file = vault?.getAbstractFileByPath?.(targetPath) ?? null;
        if (!file) {
            return { ok: false, reason: 'Target chapter not found: ' + targetPath };
        }
        const leaf = workspace?.getMostRecentLeaf?.() ?? workspace?.getLeaf?.(true) ?? workspace?.getLeaf?.(false) ?? null;
        if (!leaf) {
            return { ok: false, reason: 'Unable to resolve workspace leaf' };
        }
        await leaf.openFile(file, { active: true });
        await new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve)));
        return { ok: true, reopened: true };
    })()`);

    if (!result?.ok) {
        throw new Error(result?.reason ?? 'Unknown failure opening chapter');
    }
}

async function setViewportBounds(cdp, viewport) {
    if (!viewport || (viewport.width == null && viewport.height == null)) {
        return;
    }

    const bounds = {};
    if (Number.isFinite(viewport.width) && viewport.width > 0) {
        bounds.width = Math.round(viewport.width);
    }
    if (Number.isFinite(viewport.height) && viewport.height > 0) {
        bounds.height = Math.round(viewport.height);
    }
    if (Object.keys(bounds).length === 0) {
        return;
    }

    try {
        const params = cdp.targetId ? { targetId: cdp.targetId } : {};
        const { windowId } = await cdp.send('Browser.getWindowForTarget', params);
        if (windowId == null) {
            return;
        }
        await cdp.send('Browser.setWindowBounds', {
            windowId,
            bounds: {
                ...bounds,
                windowState: 'normal'
            }
        });
        await delay(400);
    } catch (error) {
        console.warn('[test-reader] Window resize skipped:', error.message ?? error);
    }
}

async function configureReader(cdp, scenario) {
    const setupResult = await cdp.evaluate(`(async () => {
        const payload = ${JSON.stringify(scenario ?? {})};
        const desiredColumns = Number.isFinite(payload?.columns) ? payload.columns : 1;
        const desiredMargins = Number.isFinite(payload?.horizontalMargins) ? payload.horizontalMargins : null;
        const desiredFontSize = Number.isFinite(payload?.fontSize) ? payload.fontSize : null;
        const desiredLineSpacing = Number.isFinite(payload?.lineSpacing) ? payload.lineSpacing : null;
        const desiredLetterSpacing = Number.isFinite(payload?.letterSpacing) ? payload.letterSpacing : null;
        const desiredWordSpacing = Number.isFinite(payload?.wordSpacing) ? payload.wordSpacing : null;
        const plugin = window.app?.plugins?.plugins?.obsidianr ?? null;
        const reader = plugin?.reader ?? null;
        if (!reader) {
            return { ok: false, reason: 'Reader manager not available' };
        }
        reader.updateParameters({
            columns: desiredColumns,
            horizontalMargins: desiredMargins ?? reader.state.snapshot.parameters.horizontalMargins,
            fontSize: desiredFontSize ?? reader.state.snapshot.parameters.fontSize,
            lineSpacing: desiredLineSpacing ?? reader.state.snapshot.parameters.lineSpacing,
            letterSpacing: desiredLetterSpacing ?? reader.state.snapshot.parameters.letterSpacing,
            wordSpacing: desiredWordSpacing ?? reader.state.snapshot.parameters.wordSpacing,
            justified: reader.state.snapshot.parameters.justified,
            transitionType: 'none',
            fontFamily: reader.state.snapshot.parameters.fontFamily
        });
        if (reader.state.snapshot.active) {
            reader.toggleReaderMode();
            await new Promise((resolve) => setTimeout(resolve, 150));
            reader.toggleReaderMode();
        } else {
            reader.toggleReaderMode();
        }
        await new Promise((resolve) => setTimeout(resolve, 400));
        const pagination = reader?.pagination ?? reader?.['pagination'] ?? null;
        if (!pagination) {
            return { ok: false, reason: 'Pagination engine unavailable' };
        }
        if (desiredColumns > 0) {
            let attempts = 0;
            while (attempts < 6) {
                const activeColumns = pagination.getColumnsPerPage?.() ?? null;
                if ((desiredColumns === 1 && (activeColumns ?? 1) <= 1) || activeColumns === desiredColumns) {
                    break;
                }
                await new Promise((resolve) => setTimeout(resolve, 150));
                attempts += 1;
            }
        }
        const pageCount = pagination.getPageCount?.() ?? 0;
        const offsets = pagination.getOffsets?.() ?? [];
        const axis = pagination.getPageAxis?.() ?? null;
        if (typeof reader.state?.update === 'function') {
            reader.state.update({ currentPage: 0 });
            pagination.applyPage?.(0);
        }
        const measurementTarget = pagination?.contentEl ?? reader?.contentEl ?? null;
        const computedColumns = measurementTarget
            ? parseInt(window.getComputedStyle(measurementTarget).columnCount, 10)
            : NaN;
        return {
            ok: true,
            pageCount,
            offsets,
            axis,
            columnsPerPage: pagination.getColumnsPerPage?.() ?? null,
            totalColumns: pagination.getTotalColumns?.() ?? null,
            contentExtent: pagination.getContentHeight?.() ?? null,
            pageWidth: pagination.getPageWidth?.() ?? null,
            columnWidth: pagination.getColumnWidth?.() ?? null,
            columnGap: pagination.getColumnGap?.() ?? null,
            readerStatePages: reader.state.snapshot.totalPages ?? null,
            appliedColumns: desiredColumns,
            effectiveColumns: reader.state.snapshot.parameters.columns,
            computedColumnCount: Number.isNaN(computedColumns) ? null : computedColumns,
            fontSize: reader.state.snapshot.parameters.fontSize,
            horizontalMargins: reader.state.snapshot.parameters.horizontalMargins
        };
    })()`);

    if (!setupResult?.ok) {
        throw new Error(setupResult?.reason ?? 'Failed to configure reader');
    }
    return setupResult;
}

function assertPaginationMetrics(metrics, diagnostics, expectations) {
    const expectedColumns = Math.max(1, expectations?.columns ?? 1);
    if (!diagnostics || !Array.isArray(diagnostics.pages) || diagnostics.pages.length === 0) {
        throw new Error('Missing page diagnostics for validation');
    }

    if (metrics.columnsPerPage !== expectedColumns) {
        throw new Error(`Pagination reports ${metrics.columnsPerPage} columns per page, expected ${expectedColumns}`);
    }

    const expectedAxis = expectedColumns === 1 ? 'y' : 'x';
    if (metrics.axis !== expectedAxis) {
        throw new Error(`Pagination axis mismatch: expected ${expectedAxis}, received ${metrics.axis}`);
    }

    const computedColumns = diagnostics.computedColumnCount ?? null;
    const firstPage = diagnostics.pages[0];
    const observedColumns = firstPage?.columnCount ?? null;
    if (expectedColumns > 1) {
        if (computedColumns != null) {
            if (computedColumns < expectedColumns) {
                throw new Error(`Computed column count ${computedColumns} < expected ${expectedColumns}`);
            }
        } else if (observedColumns != null && observedColumns < expectedColumns) {
            throw new Error(`Page 1 displays ${observedColumns} columns, expected ${expectedColumns}`);
        }
    } else if (observedColumns != null && observedColumns > 1) {
        throw new Error(`Single-column layout unexpectedly rendered ${observedColumns} columns`);
    }

    for (const page of diagnostics.pages) {
        if ((page.textLength ?? 0) <= 0) {
            throw new Error(`Page ${page.page + 1} is empty (text length ${page.textLength ?? 0})`);
        }
        if (expectedColumns > 1 && diagnostics.containerWidth != null) {
            const tolerance = expectations?.marginTolerance ?? 2.5;
            if (page.minColumnLeft != null && page.minColumnLeft < -tolerance) {
                throw new Error(`Page ${page.page + 1} columns start outside viewport by ${Math.abs(page.minColumnLeft).toFixed(2)}px`);
            }
            if (page.maxColumnRight != null && page.maxColumnRight > diagnostics.containerWidth + tolerance) {
                const overflow = page.maxColumnRight - diagnostics.containerWidth;
                throw new Error(`Page ${page.page + 1} columns overflow viewport by ${overflow.toFixed(2)}px`);
            }
        }
    }

    const padding = diagnostics.viewportPadding ?? {};
    const expectedMargin = Number.isFinite(expectations?.horizontalMargins)
        ? expectations.horizontalMargins
        : 12;
    const marginTolerance = expectations?.marginTolerance ?? 1;
    if (padding.leftPercent != null) {
        const delta = Math.abs(padding.leftPercent - expectedMargin);
        if (delta > marginTolerance) {
            throw new Error(`Horizontal left margin expected ~${expectedMargin}% (±${marginTolerance}), observed ${padding.leftPercent}%`);
        }
    }
    if (padding.rightPercent != null) {
        const delta = Math.abs(padding.rightPercent - expectedMargin);
        if (delta > marginTolerance) {
            throw new Error(`Horizontal right margin expected ~${expectedMargin}% (±${marginTolerance}), observed ${padding.rightPercent}%`);
        }
    }

    if (!Array.isArray(metrics.offsets) || metrics.offsets.length === 0) {
        throw new Error('Pagination offsets missing');
    }
    for (let i = 1; i < metrics.offsets.length; i += 1) {
        if (metrics.offsets[i] < metrics.offsets[i - 1]) {
            throw new Error('Pagination offsets are not sorted in ascending order');
        }
    }
    const expectedPages = Math.max(1, Math.ceil((metrics.totalColumns ?? 0) / Math.max(metrics.columnsPerPage ?? 1, 1)));
    const offsetCount = metrics.offsets.length;
    if (metrics.axis === 'y') {
        if (offsetCount < expectedPages) {
            throw new Error(`Vertical pagination yielded ${offsetCount} offsets < expected ${expectedPages}`);
        }
        if (offsetCount > expectedPages + 1) {
            throw new Error(`Vertical pagination yielded ${offsetCount} offsets > expected ${expectedPages} (+1 tolerance)`);
        }
    } else if (offsetCount !== expectedPages) {
        throw new Error(`Expected ${expectedPages} page offsets, received ${offsetCount}`);
    }
    if (metrics.pageCount != null) {
        if (metrics.axis === 'y') {
            if (metrics.pageCount < expectedPages) {
                throw new Error(`Vertical pagination reported ${metrics.pageCount} pages < expected ${expectedPages}`);
            }
            if (metrics.pageCount > expectedPages + 1) {
                throw new Error(`Vertical pagination reported ${metrics.pageCount} pages > expected ${expectedPages} (+1 tolerance)`);
            }
        } else if (metrics.pageCount !== expectedPages) {
            throw new Error(`Page count mismatch: expected ${expectedPages}, received ${metrics.pageCount}`);
        }
    }
    if (metrics.readerStatePages != null && metrics.readerStatePages > 0) {
        if (metrics.axis === 'y') {
            if (metrics.readerStatePages < expectedPages) {
                throw new Error(`Reader state reports ${metrics.readerStatePages} pages < expected ${expectedPages}`);
            }
            if (metrics.readerStatePages > expectedPages + 1) {
                throw new Error(`Reader state reports ${metrics.readerStatePages} pages > expected ${expectedPages} (+1 tolerance)`);
            }
        } else if (metrics.readerStatePages !== expectedPages) {
            throw new Error(`Reader state reports ${metrics.readerStatePages} pages, expected ${expectedPages}`);
        }
    }
    if ((metrics.columnsPerPage ?? 0) > 1 && (metrics.columnWidth ?? 0) <= 0) {
        throw new Error('Column width missing for multi-column pagination');
    }
}

async function collectPageDiagnostics(cdp, pageCount) {
    const requestedPages = Number.isFinite(pageCount) && pageCount > 0
        ? Math.max(0, Math.round(pageCount))
        : null;

    const result = await cdp.evaluate(`(async () => {
        const requestedPages = ${JSON.stringify(requestedPages)};
        const plugin = window.app?.plugins?.plugins?.obsidianr ?? null;
        const reader = plugin?.reader ?? null;
        const pagination = reader?.pagination ?? reader?.['pagination'] ?? null;
        const viewport = reader?.viewportEl ?? reader?.['viewportEl'] ?? null;
        const container = pagination?.contentEl ?? reader?.contentEl ?? null;
        if (!reader || !pagination || !container || !viewport) {
            return { ok: false, reason: 'Reader container unavailable' };
        }
        const resolvedPages = Number.isFinite(requestedPages) && requestedPages > 0
            ? Math.max(0, Math.round(requestedPages))
            : (pagination.getPageCount?.() ?? reader.state.snapshot.totalPages ?? 0);

    const diagnostics = [];
    const initialViewportRect = viewport.getBoundingClientRect();
    const initialContainerRect = container.getBoundingClientRect();
    const containerWidth = initialContainerRect.width;
        const viewportStyle = window.getComputedStyle(viewport);
        const paddingLeftPx = parseFloat(viewportStyle.paddingLeft) || 0;
        const paddingRightPx = parseFloat(viewportStyle.paddingRight) || 0;
        const paddingLeftPercent = initialViewportRect.width > 0 ? (paddingLeftPx / initialViewportRect.width) * 100 : null;
        const paddingRightPercent = initialViewportRect.width > 0 ? (paddingRightPx / initialViewportRect.width) * 100 : null;

        const blockSelector = 'p, h1, h2, h3, h4, h5, h6, blockquote, li';
        const originalPage = reader.state.snapshot.currentPage ?? 0;

        for (let index = 0; index < resolvedPages; index += 1) {
            pagination.applyPage(index);
            await new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve)));

            const viewportRect = viewport.getBoundingClientRect();
            const containerRect = container.getBoundingClientRect();
            const blocks = Array.from(container.querySelectorAll(blockSelector));
            const viewportTop = viewportRect.top + 0.5;
            const viewportBottom = viewportRect.bottom - 0.5;
            const columnPositions = new Set();
            const rawColumnPositions = [];
            let visibleBlocks = 0;
            let textLength = 0;
            let minLeft = Number.POSITIVE_INFINITY;
            let maxRight = 0;

            const horizontalAllowance = 1.5;
            const viewportLeft = containerRect.left - horizontalAllowance;
            const viewportRight = containerRect.right + horizontalAllowance;

            for (const element of blocks) {
                const text = element.innerText ?? '';
                let textRegistered = false;
                const rects = Array.from(element.getClientRects());
                for (const rect of rects) {
                    if (rect.width <= 0 || rect.height <= 0) {
                        continue;
                    }
                    if (rect.bottom <= viewportTop || rect.top >= viewportBottom) {
                        continue;
                    }
                    if (rect.right <= viewportLeft || rect.left >= viewportRight) {
                        continue;
                    }
                    visibleBlocks += 1;
                    const relativeLeft = rect.left - containerRect.left;
                    const relativeRight = rect.right - containerRect.left;
                    columnPositions.add(Math.round(relativeLeft));
                    rawColumnPositions.push(relativeLeft);
                    minLeft = Math.min(minLeft, relativeLeft);
                    maxRight = Math.max(maxRight, relativeRight);
                    if (!textRegistered) {
                        textLength += text.trim().length;
                        textRegistered = true;
                    }
                }
            }

            diagnostics.push({
                page: index,
                textLength,
                visibleBlocks,
                columnPositions: Array.from(columnPositions).sort((a, b) => a - b),
                columnCount: columnPositions.size,
                rawColumnPositions,
                minColumnLeft: Number.isFinite(minLeft) ? Math.round(minLeft * 100) / 100 : null,
                maxColumnRight: Math.round(maxRight * 100) / 100
            });
        }

        pagination.applyPage(originalPage);

        const computedColumnCount = parseInt(window.getComputedStyle(container).columnCount, 10);

        return {
            ok: true,
            pages: diagnostics,
            containerWidth: Math.round(containerWidth * 100) / 100,
            computedColumnCount: Number.isNaN(computedColumnCount) ? null : computedColumnCount,
            viewportPadding: {
                leftPx: Math.round(paddingLeftPx * 100) / 100,
                rightPx: Math.round(paddingRightPx * 100) / 100,
                leftPercent: paddingLeftPercent != null ? Math.round(paddingLeftPercent * 100) / 100 : null,
                rightPercent: paddingRightPercent != null ? Math.round(paddingRightPercent * 100) / 100 : null
            }
        };
    })()`);

    if (!result?.ok) {
        throw new Error(result?.reason ?? 'Unable to collect page diagnostics');
    }
    return result;
}

async function writeDiagnostics(timestamp, payload) {
    await fs.mkdir(DIAGNOSTICS_DIR, { recursive: true });
    const filePath = path.join(DIAGNOSTICS_DIR, `reader-${timestamp}.json`);
    await fs.writeFile(filePath, JSON.stringify(payload, null, 2), 'utf8');
    return filePath;
}

async function captureScreenshot(cdp, suffix = 'latest') {
    await fs.mkdir(SCREENSHOT_DIR, { recursive: true });
    await cdp.send('Page.bringToFront');
    await delay(200);
    const { data } = await cdp.send('Page.captureScreenshot', {
        format: 'png',
        captureBeyondViewport: true
    });
    const fileName = `${SCREENSHOT_BASENAME}-${suffix}.png`;
    const targetPath = path.join(SCREENSHOT_DIR, fileName);
    await fs.writeFile(targetPath, Buffer.from(data, 'base64'));
    return targetPath;
}

async function main() {
    const payload = await withCDP({}, async (cdp) => {
        await ensureRuntimeReady(cdp);
        await ensurePluginPresent(cdp);
        await openChapter(cdp);

        const scenarios = [
            {
                label: '1col-default',
                columns: 1,
                fontSize: 18,
                horizontalMargins: 12,
                viewport: { width: 1180, height: 820 }
            },
            {
                label: '1col-compact',
                columns: 1,
                fontSize: 16,
                horizontalMargins: 6,
                viewport: { width: 960, height: 720 }
            },
            {
                label: '2col-standard',
                columns: 2,
                fontSize: 18,
                horizontalMargins: 10,
                viewport: { width: 1280, height: 880 },
                marginTolerance: 5
            },
            {
                label: '2col-wide',
                columns: 2,
                fontSize: 20,
                horizontalMargins: 14,
                viewport: { width: 1480, height: 900 },
                marginTolerance: 5
            },
            {
                label: '3col-compact',
                columns: 3,
                fontSize: 17,
                horizontalMargins: 8,
                viewport: { width: 1380, height: 820 },
                marginTolerance: 5.5
            },
            {
                label: '3col-tall',
                columns: 3,
                fontSize: 19,
                horizontalMargins: 12,
                viewport: { width: 1420, height: 1020 },
                marginTolerance: 5.5
            }
        ];
        const results = [];

        for (const scenario of scenarios) {
            let attempt = 0;
            // eslint-disable-next-line no-constant-condition
            while (true) {
                try {
                    await setViewportBounds(cdp, scenario.viewport);
                    const paginationMetrics = await configureReader(cdp, scenario);
                    const diagnostics = await collectPageDiagnostics(
                        cdp,
                        paginationMetrics.pageCount ?? paginationMetrics.offsets.length ?? 0
                    );
                    paginationMetrics.diagnostics = diagnostics;

                    const timestamp = new Date().toISOString().replace(/[:.]/g, '-');
                    const suffix = `${scenario.label}-${timestamp}`;
                    const screenshotPath = await captureScreenshot(cdp, suffix);
                    const diagnosticsPayload = {
                        metrics: { ...paginationMetrics },
                        diagnostics,
                        screenshotPath,
                        scenario
                    };
                    const diagnosticsPath = await writeDiagnostics(suffix, diagnosticsPayload);
                    paginationMetrics.screenshotPath = screenshotPath;
                    paginationMetrics.diagnosticsPath = diagnosticsPath;

                    console.log(`[test-reader] (${scenario.label}) Captured screenshot at`, screenshotPath);
                    console.log(`[test-reader] (${scenario.label}) Diagnostics written to`, diagnosticsPath);

                    assertPaginationMetrics(paginationMetrics, diagnostics, {
                        columns: scenario.columns,
                        horizontalMargins: scenario.horizontalMargins,
                        marginTolerance: scenario.marginTolerance ?? 1.5
                    });

                    console.log(`[test-reader] (${scenario.label}) Pagination metrics`, paginationMetrics);

                    results.push({
                        label: scenario.label,
                        parameters: scenario,
                        metrics: paginationMetrics,
                        diagnosticsPath,
                        screenshotPath
                    });
                    break;
                } catch (error) {
                    attempt += 1;
                    const message = error?.message ?? String(error);
                    if (attempt <= 2 && /Promise was collected|Target closed|Execution context was destroyed/.test(message)) {
                        console.warn(`[test-reader] (${scenario.label}) transient error (${message.trim()}) retry ${attempt}/2`);
                        await delay(600);
                        continue;
                    }
                    throw error;
                }
            }
        }

        return results;
    });

    console.log('[test-reader] SUCCESS', payload);
}

main().catch((error) => {
    console.error('[test-reader] ERROR', error.message ?? error);
    process.exitCode = 1;
});
