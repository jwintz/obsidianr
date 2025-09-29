import { ReaderParameters } from '../core/state';
import { logDebug } from '../core/logger';

interface LineFragment {
    top: number;
    bottom: number;
    left: number;
}

interface PaginationSnapshot {
    pageHeight: number;
    offsets: number[];
    contentHeight: number;
}

const BLOCK_ELEMENT_SELECTORS = [
    'img',
    'svg',
    'video',
    'audio',
    'iframe',
    'canvas',
    '.math-block',
    '.math-inline'
].join(',');

const EPSILON = 0.5;

export class PaginationEngine {
    private containerEl: HTMLElement;
    private contentEl: HTMLElement;
    private offsets: number[] = [0];
    private pageHeight = 0;
    private contentHeight = 0;
    private currentOffset = 0;
    private originalStyles: {
        fontSize: string;
        lineHeight: string;
        letterSpacing: string;
        wordSpacing: string;
        paddingTop: string;
        paddingBottom: string;
        columnCount: string;
        columnGap: string;
        columnFill: string;
        transition: string;
        transform: string;
        width: string;
        opacity: string;
        transformStyle: string;
        backfaceVisibility: string;
    } | null = null;
    private originalPerspective: string | null = null;
    private transitionType: ReaderParameters['transitionType'] = 'none';
    private opacityFrame: number | null = null;
    private activeAnimation: Animation | null = null;

    constructor(
        private readonly viewportEl: HTMLElement,
        contentEl: HTMLElement
    ) {
        this.containerEl = contentEl;
        this.contentEl = contentEl;
    }

    setContentElement(element: HTMLElement): void {
        if (this.contentEl === element) {
            return;
        }
        this.resetAnimationState();
        this.originalStyles = null;
        this.contentEl = element;
        this.resetTransform();
    }

    compute(parameters: ReaderParameters): PaginationSnapshot {
        this.captureOriginalStyles();
        this.prepareLayout(parameters);
        this.resetTransform();

        const measurementTarget = this.getMeasurementTarget();
        const snapshot = this.measure();
        this.offsets = snapshot.offsets;
        this.pageHeight = snapshot.pageHeight;
        this.contentHeight = Math.max(snapshot.contentHeight, measurementTarget.scrollHeight);
        this.currentOffset = this.offsets[0] ?? 0;
        const offsetsSample = this.offsets.slice(0, Math.min(this.offsets.length, 5));
        const offsetSteps = offsetsSample.map((offset, index) =>
            index === 0 ? 0 : Math.round((offset - offsetsSample[index - 1]) * 100) / 100
        );
        const lastOffset = this.offsets[this.offsets.length - 1] ?? 0;
        logDebug('pagination.compute', {
            pageHeight: this.pageHeight,
            contentHeight: this.contentHeight,
            scrollHeight: measurementTarget.scrollHeight,
            offsetCount: this.offsets.length,
            lastOffset,
            offsetsSample,
            offsetSteps
        });
        if (this.offsets.length > offsetsSample.length) {
            logDebug('pagination.compute offsets (sample)', offsetsSample, 'steps', offsetSteps);
        } else {
            logDebug('pagination.compute offsets (all)', offsetsSample, 'steps', offsetSteps);
        }
        return snapshot;
    }

    applyPage(index: number): number {
        const previousOffset = this.currentOffset;
        const offset = this.getOffsetForPage(index);
        this.currentOffset = offset;
        const previousTransform = this.buildTransform(previousOffset);
        const nextTransform = this.buildTransform(offset);
        const direction = offset > previousOffset ? 1 : -1;

        if (Math.abs(offset - previousOffset) <= EPSILON) {
            this.contentEl.style.transform = nextTransform;
            logDebug('pagination.applyPage skipped animation', {
                index,
                offset,
                previousOffset
            });
            return offset;
        }

        this.resetAnimationState();

        switch (this.transitionType) {
            case 'fade':
                this.runFadeAnimation(previousTransform, nextTransform);
                break;
            case 'slide':
                this.runSlideAnimation(previousTransform, nextTransform, direction);
                break;
            case 'scroll':
                this.runTransformAnimation(previousTransform, nextTransform, 320, 'ease-out');
                break;
            case 'page-curl':
                this.runPageCurlAnimation(previousTransform, nextTransform);
                break;
            default:
                this.contentEl.style.transform = nextTransform;
                break;
        }

        const delta = Math.round((offset - previousOffset) * 100) / 100;
        logDebug('pagination.applyPage', {
            index,
            offset,
            previousOffset,
            delta,
            transform: nextTransform,
            transitionType: this.transitionType
        });

        const viewportRect = this.viewportEl.getBoundingClientRect();
        const contentRect = this.contentEl.getBoundingClientRect();
        logDebug('pagination.applyPage layout', {
            index,
            viewportHeight: Math.round(viewportRect.height),
            contentHeight: Math.round(contentRect.height),
            topOffset: Math.round(contentRect.top - viewportRect.top),
            bottomOffset: Math.round(contentRect.bottom - viewportRect.top)
        });

        return offset;
    }

    getCurrentOffset(): number {
        return this.currentOffset;
    }

    getOffsetForPage(index: number): number {
        if (this.offsets.length === 0) {
            return 0;
        }
        const clamped = Math.max(0, Math.min(index, this.offsets.length - 1));
        return this.offsets[clamped];
    }

    getPageForOffset(offset: number): number {
        if (this.offsets.length === 0) {
            return 0;
        }
        const clamped = Math.max(0, Math.min(offset, this.contentHeight));
        for (let i = this.offsets.length - 1; i >= 0; i -= 1) {
            if (clamped + EPSILON >= this.offsets[i]) {
                return i;
            }
        }
        return 0;
    }

    getPageCount(): number {
        return Math.max(1, this.offsets.length);
    }

    getPageHeight(): number {
        return this.pageHeight;
    }

    getContentHeight(): number {
        return this.contentHeight;
    }

    getOffsets(): number[] {
        return [...this.offsets];
    }

    destroy(): void {
        if (!this.originalStyles) {
            return;
        }
        this.resetAnimationState();
        const styles = this.originalStyles;
        this.contentEl.style.fontSize = styles.fontSize;
        this.contentEl.style.lineHeight = styles.lineHeight;
        this.contentEl.style.letterSpacing = styles.letterSpacing;
        this.contentEl.style.wordSpacing = styles.wordSpacing;
        this.contentEl.style.paddingTop = styles.paddingTop;
        this.contentEl.style.paddingBottom = styles.paddingBottom;
        this.contentEl.style.columnCount = styles.columnCount;
        this.contentEl.style.columnGap = styles.columnGap;
        this.contentEl.style.columnFill = styles.columnFill;
        this.contentEl.style.transition = styles.transition;
        this.contentEl.style.transform = styles.transform;
        this.contentEl.style.width = styles.width;
        this.contentEl.style.opacity = styles.opacity;
        this.contentEl.style.transformStyle = styles.transformStyle;
        this.contentEl.style.backfaceVisibility = styles.backfaceVisibility;
        this.originalStyles = null;
        if (this.originalPerspective !== null) {
            this.viewportEl.style.perspective = this.originalPerspective;
        }
        this.originalPerspective = null;
        this.transitionType = 'none';
    }

    private captureOriginalStyles(): void {
        if (this.originalStyles) {
            return;
        }
        const style = this.contentEl.style;
        this.originalPerspective = this.viewportEl.style.perspective;
        this.originalStyles = {
            fontSize: style.fontSize,
            lineHeight: style.lineHeight,
            letterSpacing: style.letterSpacing,
            wordSpacing: style.wordSpacing,
            paddingTop: style.paddingTop,
            paddingBottom: style.paddingBottom,
            columnCount: style.columnCount,
            columnGap: style.columnGap,
            columnFill: style.columnFill,
            transition: style.transition,
            transform: style.transform,
            width: style.width,
            opacity: style.opacity,
            transformStyle: style.transformStyle,
            backfaceVisibility: style.backfaceVisibility
        };
    }

    private prepareLayout(parameters: ReaderParameters): void {
        this.resetAnimationState();
        this.transitionType = parameters.transitionType;
        const viewport = this.viewportEl;
        viewport.style.overflow = 'hidden';
        viewport.style.position = viewport.style.position || 'relative';

        if (parameters.transitionType === 'page-curl') {
            viewport.style.perspective = '1200px';
            this.contentEl.style.transformStyle = 'preserve-3d';
            this.contentEl.style.backfaceVisibility = 'hidden';
        } else {
            viewport.style.perspective = '';
            this.contentEl.style.transformStyle = '';
            this.contentEl.style.backfaceVisibility = '';
        }

        const indicatorHeightAttr = this.viewportEl.dataset?.obsidianrIndicatorHeight;
        const indicatorHeight = indicatorHeightAttr ? parseFloat(indicatorHeightAttr) || 0 : 0;

        const horizontalPadding = `${parameters.horizontalMargins}%`;
        viewport.style.paddingLeft = horizontalPadding;
        viewport.style.paddingRight = horizontalPadding;

        const verticalPadding = Math.max(16, Math.round(parameters.fontSize * 0.9));
        viewport.style.paddingTop = `${verticalPadding}px`;
        viewport.style.paddingBottom = `${verticalPadding + indicatorHeight}px`;

        const target = this.getMeasurementTarget();
        target.style.fontSize = `${parameters.fontSize}px`;
        target.style.lineHeight = `${parameters.lineSpacing}`;
        target.style.letterSpacing = `${parameters.letterSpacing}em`;
        target.style.wordSpacing = `${parameters.wordSpacing}em`;
        target.classList.toggle('is-justified', parameters.justified);

        const guardPadding = Math.max(12, Math.round(parameters.fontSize * 0.6));
        target.style.paddingTop = `${guardPadding}px`;
        target.style.paddingBottom = `${guardPadding}px`;

        const columnCount = Math.max(1, Math.round(parameters.columns));
        if (columnCount > 1) {
            const columnGap = this.computeColumnGap(parameters);
            target.style.columnCount = `${columnCount}`;
            target.style.columnGap = `${columnGap}px`;
            target.style.columnFill = 'balance';
        } else {
            target.style.removeProperty('column-count');
            target.style.removeProperty('column-gap');
            target.style.removeProperty('column-fill');
        }
        target.style.removeProperty('height');
        target.style.width = '100%';
        this.contentEl.style.transition = this.getTransition(parameters.transitionType);
        this.contentEl.style.width = '100%';
        if (parameters.transitionType === 'fade') {
            this.contentEl.style.opacity = '1';
        }
    }

    private computeColumnGap(parameters: ReaderParameters): number {
        if (parameters.columns <= 1) {
            return 0;
        }
        return Math.max(16, Math.round(parameters.fontSize * 0.6));
    }

    private getTransition(_type: ReaderParameters['transitionType']): string {
        return 'none';
    }

    private resetTransform(): void {
        this.contentEl.style.transform = 'translate3d(0, 0, 0)';
    }

    private resetAnimationState(): void {
        if (this.opacityFrame !== null) {
            cancelAnimationFrame(this.opacityFrame);
            this.opacityFrame = null;
        }
        if (this.activeAnimation) {
            this.activeAnimation.cancel();
            this.activeAnimation = null;
        }
        this.contentEl.style.opacity = '1';
        this.contentEl.style.transformOrigin = '';
    }

    private runTransformAnimation(
        previousTransform: string,
        nextTransform: string,
        duration: number,
        easing: string
    ): void {
        if (typeof this.contentEl.animate !== 'function') {
            this.contentEl.style.transform = nextTransform;
            return;
        }

        const animation = this.contentEl.animate(
            [
                { transform: previousTransform },
                { transform: nextTransform }
            ],
            {
                duration,
                easing,
                fill: 'forwards'
            }
        );

        animation.addEventListener('finish', () => {
            this.contentEl.style.transform = nextTransform;
            this.activeAnimation = null;
        });

        animation.addEventListener('cancel', () => {
            this.contentEl.style.transform = nextTransform;
            this.activeAnimation = null;
        });

        this.activeAnimation = animation;
    }

    private runSlideAnimation(
        previousTransform: string,
        nextTransform: string,
        direction: number
    ): void {
        if (typeof this.contentEl.animate !== 'function') {
            this.contentEl.style.transform = nextTransform;
            return;
        }

        const horizontal = direction >= 0 ? -14 : 14;
        const animation = this.contentEl.animate(
            [
                { transform: `${previousTransform} translateX(0%)`, opacity: 1 },
                { transform: `${previousTransform} translateX(${horizontal}%)`, opacity: 0.9, offset: 0.45 },
                { transform: `${nextTransform} translateX(${horizontal * -1}%)`, opacity: 0.9, offset: 0.65 },
                { transform: `${nextTransform} translateX(0%)`, opacity: 1 }
            ],
            {
                duration: 260,
                easing: 'ease-in-out',
                fill: 'forwards'
            }
        );

        animation.addEventListener('finish', () => {
            this.contentEl.style.transform = nextTransform;
            this.contentEl.style.opacity = '1';
            this.activeAnimation = null;
        });

        animation.addEventListener('cancel', () => {
            this.contentEl.style.transform = nextTransform;
            this.contentEl.style.opacity = '1';
            this.activeAnimation = null;
        });

        this.activeAnimation = animation;
    }

    private runFadeAnimation(previousTransform: string, nextTransform: string): void {
        if (typeof this.contentEl.animate === 'function') {
            const animation = this.contentEl.animate(
                [
                    { transform: previousTransform, opacity: 1 },
                    { transform: nextTransform, opacity: 0.1 },
                    { transform: nextTransform, opacity: 1 }
                ],
                {
                    duration: 260,
                    easing: 'ease-in-out',
                    fill: 'forwards'
                }
            );

            animation.addEventListener('finish', () => {
                this.contentEl.style.transform = nextTransform;
                this.contentEl.style.opacity = '1';
                this.activeAnimation = null;
            });

            animation.addEventListener('cancel', () => {
                this.contentEl.style.transform = nextTransform;
                this.contentEl.style.opacity = '1';
                this.activeAnimation = null;
            });

            this.activeAnimation = animation;
            return;
        }

        this.contentEl.style.opacity = '0';
        this.opacityFrame = requestAnimationFrame(() => {
            this.opacityFrame = null;
            this.contentEl.style.transform = nextTransform;
            this.opacityFrame = requestAnimationFrame(() => {
                this.opacityFrame = null;
                this.contentEl.style.opacity = '1';
            });
        });
    }

    private runPageCurlAnimation(previousTransform: string, nextTransform: string): void {
        if (typeof this.contentEl.animate !== 'function') {
            this.contentEl.style.transform = nextTransform;
            return;
        }

        const midTransform = `${previousTransform} rotateX(-16deg)`;

        const animation = this.contentEl.animate(
            [
                { transform: `${previousTransform} rotateX(0deg)`, transformOrigin: '50% 100%', opacity: 1 },
                { transform: midTransform, transformOrigin: '50% 100%', opacity: 0.85 },
                { transform: `${nextTransform} rotateX(0deg)`, transformOrigin: '50% 100%', opacity: 1 }
            ],
            {
                duration: 360,
                easing: 'ease-in-out',
                fill: 'forwards'
            }
        );

        animation.addEventListener('finish', () => {
            this.contentEl.style.transform = nextTransform;
            this.contentEl.style.transformOrigin = '';
            this.contentEl.style.opacity = '1';
            this.activeAnimation = null;
        });

        animation.addEventListener('cancel', () => {
            this.contentEl.style.transform = nextTransform;
            this.contentEl.style.transformOrigin = '';
            this.contentEl.style.opacity = '1';
            this.activeAnimation = null;
        });

        this.activeAnimation = animation;
    }

    private measure(): PaginationSnapshot {
        const computed = window.getComputedStyle(this.viewportEl);
        const paddingTop = parseFloat(computed.paddingTop) || 0;
        const paddingBottom = parseFloat(computed.paddingBottom) || 0;
        const availableHeight = Math.max(
            0,
            this.viewportEl.clientHeight - paddingTop - paddingBottom
        );

        if (availableHeight <= 0) {
            return { pageHeight: 0, offsets: [0], contentHeight: 0 };
        }

        const measurementTarget = this.getMeasurementTarget();
        const measurementStyle = window.getComputedStyle(measurementTarget);
        const guardPadding = Math.max(0, parseFloat(measurementStyle.paddingBottom) || 0);
        const scrollHeight = Math.max(availableHeight, measurementTarget.scrollHeight);

        try {
            const fragments = this.collectFragments();
            if (fragments.length > 0) {
                const contentRect = measurementTarget.getBoundingClientRect();
                const { normalizedFragments, contentHeight, maxFragmentBottom } = this.normalizeFragments(
                    fragments,
                    contentRect,
                    availableHeight,
                    measurementTarget
                );
                const preciseSnapshot = this.buildSnapshotFromFragments(
                    normalizedFragments,
                    availableHeight,
                    contentHeight,
                    guardPadding,
                    maxFragmentBottom
                );
                if (preciseSnapshot) {
                    this.debugVerifyCoverage(normalizedFragments, preciseSnapshot.offsets, availableHeight);
                    return preciseSnapshot;
                }
            }
        } catch (error) {
            console.warn('[ObsidianR] pagination.measure failed to derive fragments', error);
        }

        return this.applyFallback(
            {
                pageHeight: availableHeight,
                offsets: [0],
                contentHeight: scrollHeight
            },
            scrollHeight,
            availableHeight,
            guardPadding
        );
    }

    private normalizeFragments(
        fragments: LineFragment[],
        contentRect: DOMRect,
        availableHeight: number,
        measurementTarget: HTMLElement
    ): {
        normalizedFragments: Array<{ top: number; bottom: number; }>;
        contentHeight: number;
        maxFragmentBottom: number;
    } {
        const style = window.getComputedStyle(measurementTarget);
        const declaredColumnCount = parseInt(style.columnCount, 10);
        const columnCount = Number.isNaN(declaredColumnCount) ? 1 : Math.max(1, declaredColumnCount);
        const quantize = (value: number) => Math.round(value * 100) / 100;
        const columnPositions = new Map<number, number>();
        const resolveColumnIndex = (left: number) => {
            const key = quantize(left - contentRect.left);
            if (!columnPositions.has(key)) {
                columnPositions.set(key, columnPositions.size);
            }
            return columnPositions.get(key) ?? 0;
        };

        const normalized = fragments.map((fragment) => {
            let top = fragment.top - contentRect.top;
            let bottom = fragment.bottom - contentRect.top;

            if (columnCount > 1 && availableHeight > 0) {
                const columnIndex = Math.min(columnCount - 1, resolveColumnIndex(fragment.left));
                const rowIndex = Math.floor(top / availableHeight);
                const positionWithinRow = top - rowIndex * availableHeight;
                const baseRowOffset = rowIndex * columnCount * availableHeight;
                const columnOffset = columnIndex * availableHeight;
                top = baseRowOffset + columnOffset + positionWithinRow;

                const bottomRowIndex = Math.floor(bottom / availableHeight);
                const bottomWithinRow = bottom - bottomRowIndex * availableHeight;
                const bottomBaseOffset = bottomRowIndex * columnCount * availableHeight;
                const bottomColumnOffset = columnIndex * availableHeight;
                bottom = bottomBaseOffset + bottomColumnOffset + bottomWithinRow;
            }

            return { top, bottom };
        });

        normalized.sort((a, b) => {
            if (Math.abs(a.top - b.top) > EPSILON) {
                return a.top - b.top;
            }
            return a.bottom - b.bottom;
        });

        let maxBottom = 0;
        const deduped: Array<{ top: number; bottom: number; }> = [];
        for (const fragment of normalized) {
            if (
                deduped.length > 0 &&
                Math.abs(deduped[deduped.length - 1].top - fragment.top) < EPSILON &&
                Math.abs(deduped[deduped.length - 1].bottom - fragment.bottom) < EPSILON
            ) {
                continue;
            }
            deduped.push(fragment);
            maxBottom = Math.max(maxBottom, fragment.bottom);
        }

        const estimatedColumns = Math.max(1, Math.ceil(maxBottom / Math.max(availableHeight, 1)));
        const columnHeight = estimatedColumns * Math.max(availableHeight, 1);
        const contentHeight = Math.max(maxBottom, columnHeight, availableHeight);
        return { normalizedFragments: deduped, contentHeight, maxFragmentBottom: maxBottom };
    }

    private findFragmentBeyondThreshold(
        fragments: Array<{ top: number; bottom: number; }>,
        threshold: number,
        startIndex: number
    ): number {
        for (let index = Math.max(0, startIndex); index < fragments.length; index += 1) {
            if (fragments[index].bottom > threshold + EPSILON) {
                return index;
            }
        }
        return -1;
    }

    private buildTransform(offset: number): string {
        return `translate3d(0, ${-offset}px, 0)`;
    }

    private collectFragments(): LineFragment[] {
        const measurementTarget = this.getMeasurementTarget();
        const rects: LineFragment[] = [];
        const walker = document.createTreeWalker(
            measurementTarget,
            NodeFilter.SHOW_TEXT,
            {
                acceptNode(node) {
                    return node.nodeValue && node.nodeValue.trim().length > 0
                        ? NodeFilter.FILTER_ACCEPT
                        : NodeFilter.FILTER_REJECT;
                }
            }
        );

        let current = walker.nextNode();
        while (current) {
            const range = document.createRange();
            range.selectNodeContents(current);
            const clientRects = range.getClientRects();
            for (const rect of Array.from(clientRects)) {
                if (rect.width <= EPSILON || rect.height <= EPSILON) {
                    continue;
                }
                rects.push({
                    top: rect.top,
                    bottom: rect.bottom,
                    left: rect.left
                });
            }
            range.detach();
            current = walker.nextNode();
        }

        if (BLOCK_ELEMENT_SELECTORS.length > 0) {
            const elements = measurementTarget.querySelectorAll<HTMLElement>(BLOCK_ELEMENT_SELECTORS);
            elements.forEach((element) => {
                const rect = element.getBoundingClientRect();
                if (rect.width <= EPSILON || rect.height <= EPSILON) {
                    return;
                }
                rects.push({
                    top: rect.top,
                    bottom: rect.bottom,
                    left: rect.left
                });
            });
        }

        rects.sort((a, b) => {
            if (Math.abs(a.top - b.top) > EPSILON) {
                return a.top - b.top;
            }
            return a.left - b.left;
        });

        const filtered: LineFragment[] = [];
        for (const rect of rects) {
            const last = filtered[filtered.length - 1];
            if (
                last &&
                Math.abs(last.top - rect.top) < EPSILON &&
                Math.abs(last.bottom - rect.bottom) < EPSILON &&
                Math.abs(last.left - rect.left) < EPSILON
            ) {
                continue;
            }
            filtered.push(rect);
        }

        return filtered;
    }

    private getMeasurementTarget(): HTMLElement {
        return this.contentEl;
    }

    private buildSnapshotFromFragments(
        fragments: Array<{ top: number; bottom: number; }>,
        availableHeight: number,
        contentHeight: number,
        _guardPadding = 0,
        maxFragmentBottom?: number
    ): PaginationSnapshot | null {
        if (fragments.length === 0 || availableHeight <= 0) {
            return null;
        }

        const offsets: number[] = [0];
        const effectiveHeight = Math.max(1, availableHeight);
        const fragmentExtent = typeof maxFragmentBottom === 'number'
            ? Math.max(maxFragmentBottom, availableHeight)
            : Math.max(contentHeight, availableHeight);
        const maxOffset = Math.max(0, fragmentExtent - effectiveHeight);
        let currentOffset = 0;
        let searchIndex = 0;

        while (currentOffset < maxOffset - EPSILON) {
            const threshold = currentOffset + effectiveHeight;
            const nextIndex = this.findFragmentBeyondThreshold(fragments, threshold, searchIndex);
            if (nextIndex === -1) {
                break;
            }

            let nextOffset = fragments[nextIndex].top;
            nextOffset = Math.max(currentOffset + 1, nextOffset);
            nextOffset = Math.min(nextOffset, maxOffset);

            offsets.push(nextOffset);
            currentOffset = nextOffset;
            searchIndex = nextIndex;

            if (maxOffset - currentOffset <= 1) {
                break;
            }
        }

        const lastOffset = offsets[offsets.length - 1] ?? 0;
        if (maxOffset > EPSILON && maxOffset - lastOffset > EPSILON) {
            offsets.push(maxOffset);
        }

        const normalize = (value: number) => Math.max(0, Math.round(value * 100) / 100);
        const normalizedOffsets: number[] = [];
        for (const offset of offsets) {
            const rounded = normalize(offset);
            if (
                normalizedOffsets.length === 0 ||
                Math.abs(rounded - normalizedOffsets[normalizedOffsets.length - 1]) > 0.5
            ) {
                normalizedOffsets.push(Math.min(rounded, normalize(maxOffset)));
            }
        }

        if (normalizedOffsets.length === 0) {
            normalizedOffsets.push(0);
        }

        if (normalizedOffsets[normalizedOffsets.length - 1] < normalize(maxOffset) && maxOffset > 0) {
            normalizedOffsets.push(normalize(maxOffset));
        }

        const uniqueOffsets = Array.from(new Set(normalizedOffsets)).sort((a, b) => a - b);
        if (uniqueOffsets.length === 0) {
            uniqueOffsets.push(0);
        }

        return {
            pageHeight: Math.max(effectiveHeight, 1),
            offsets: uniqueOffsets,
            contentHeight: Math.max(fragmentExtent, availableHeight)
        };
    }

    private applyFallback(
        snapshot: PaginationSnapshot,
        scrollHeight: number,
        availableHeight: number,
        _guardPadding = 0
    ): PaginationSnapshot {
        const normalizedScrollHeight = Math.max(scrollHeight, availableHeight);
        const effectiveAvailableHeight = Math.max(availableHeight, 1);
        const requiredPages = Math.max(1, Math.ceil(normalizedScrollHeight / effectiveAvailableHeight));
        const maxOffset = Math.max(0, normalizedScrollHeight - effectiveAvailableHeight);

        const offsets: number[] = [];
        for (let pageIndex = 0; pageIndex < requiredPages; pageIndex += 1) {
            const offset = Math.min(pageIndex * effectiveAvailableHeight, maxOffset);
            if (offsets.length === 0 || offset - offsets[offsets.length - 1] > EPSILON) {
                offsets.push(offset);
            }
        }

        if (offsets.length === 0) {
            offsets.push(0);
        }

        const lastOffset = offsets[offsets.length - 1];
        if (maxOffset - lastOffset > EPSILON) {
            offsets.push(maxOffset);
        }

        return {
            pageHeight: Math.max(effectiveAvailableHeight, 1),
            offsets,
            contentHeight: normalizedScrollHeight
        };
    }

    private debugVerifyCoverage(
        fragments: Array<{ top: number; bottom: number; }>,
        offsets: number[],
        availableHeight: number
    ): void {
        if (!this.isDebugMode() || fragments.length === 0 || offsets.length === 0) {
            return;
        }

        const uncovered = fragments.filter((fragment) => {
            for (const offset of offsets) {
                const topVisible = offset - EPSILON;
                const bottomVisible = offset + availableHeight + EPSILON;
                if (fragment.top >= topVisible && fragment.bottom <= bottomVisible) {
                    return false;
                }
            }
            return true;
        });

        if (uncovered.length > 0) {
            console.warn('[ObsidianR] pagination coverage gap detected', {
                uncovered: uncovered.slice(0, 5),
                fragmentCount: fragments.length,
                offsets,
                availableHeight
            });
        }
    }

    private isDebugMode(): boolean {
        const globalWindow = window as unknown as { obsidianrDebugPagination?: boolean; };
        return globalWindow?.obsidianrDebugPagination === true;
    }
}
