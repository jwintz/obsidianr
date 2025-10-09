import { ReaderParameters } from '../core/state';
import { logDebug } from '../core/logger';

type PaginationAxis = 'x' | 'y';

interface LineFragment {
    top: number;
    bottom: number;
    left: number;
}

interface PaginationSnapshot {
    axis: PaginationAxis;
    pageHeight: number;
    pageWidth: number;
    offsets: number[];
    contentExtent: number;
    totalColumns: number;
    columnsPerPage: number;
    columnWidth: number;
    columnGap: number;
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
    private pageAxis: PaginationAxis = 'y';
    private pageHeight = 0;
    private pageWidth = 0;
    private contentExtent = 0;
    private currentOffset = 0;
    private columnsPerPage = 1;
    private totalColumns = 1;
    private columnWidth = 0;
    private columnGap = 0;
    private guardPadding = 0;

    private lastViewportInnerWidth = 0;
    private lastViewportPadding = {
        top: 0,
        bottom: 0,
        left: 0,
        right: 0
    };
    private debugOverlay: HTMLElement | null = null;
    private originalStyles: {
        fontSize: string;
        lineHeight: string;
        letterSpacing: string;
        wordSpacing: string;
        fontFamily: string;
        paddingTop: string;
        paddingBottom: string;
        columnCount: string;
        columnGap: string;
        columnFill: string;
        columnWidth: string;
        transition: string;
        transform: string;
        height: string;
        maxHeight: string;
        width: string;
        maxWidth: string;
        opacity: string;
        transformStyle: string;
        backfaceVisibility: string;
    } | null = null;
    private originalPerspective: string | null = null;
    private transitionType: ReaderParameters['transitionType'] = 'none';
    private opacityFrame: number | null = null;
    private activeAnimation: Animation | null = null;

    private normalize(value: number, precision = 100000): number {
        if (!Number.isFinite(value)) {
            return 0;
        }
        return Math.round(value * precision) / precision;
    }

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
        this.pageAxis = snapshot.axis;
        this.pageHeight = snapshot.pageHeight;
        this.pageWidth = snapshot.pageWidth;
        this.contentExtent = snapshot.axis === 'x'
            ? snapshot.contentExtent
            : Math.max(snapshot.contentExtent, measurementTarget.scrollHeight, snapshot.pageHeight);
        this.columnsPerPage = snapshot.columnsPerPage;
        this.totalColumns = snapshot.totalColumns;
        this.columnWidth = snapshot.columnWidth;
        this.columnGap = snapshot.columnGap;
        this.currentOffset = this.offsets[0] ?? 0;

        const offsetsSample = this.offsets.slice(0, Math.min(this.offsets.length, 5));
        const offsetSteps = offsetsSample.map((offset, index) =>
            index === 0 ? 0 : Math.round((offset - offsetsSample[index - 1]) * 100) / 100
        );
        const lastOffset = this.offsets[this.offsets.length - 1] ?? 0;
        logDebug('pagination.compute', {
            axis: this.pageAxis,
            pageHeight: this.pageHeight,
            pageWidth: this.pageWidth,
            contentExtent: this.contentExtent,
            columnsPerPage: this.columnsPerPage,
            totalColumns: this.totalColumns,
            columnWidth: this.columnWidth,
            columnGap: this.columnGap,
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

        if (this.pageAxis === 'x') {
            const constrainedHeight = Math.max(1, Math.round(this.pageHeight));
            const constrainedWidth = Math.max(
                1,
                Math.round(this.lastViewportInnerWidth || this.viewportEl.clientWidth || this.pageWidth)
            );
            this.contentEl.style.height = `${constrainedHeight}px`;
            this.contentEl.style.maxHeight = `${constrainedHeight}px`;
            this.contentEl.style.width = `${constrainedWidth}px`;
            this.contentEl.style.maxWidth = `${constrainedWidth}px`;
            if (this.columnWidth > 0) {
                const preciseColumnWidth = Math.max(1, this.columnWidth);
                this.contentEl.style.columnWidth = `${this.normalize(preciseColumnWidth, 1000)}px`;
            }
        } else {
            this.contentEl.style.removeProperty('height');
            this.contentEl.style.removeProperty('max-height');
            const fallbackWidth = Math.max(
                1,
                Math.round(this.pageWidth || this.lastViewportInnerWidth || this.viewportEl.clientWidth)
            );
            this.contentEl.style.width = `${fallbackWidth}px`;
            this.contentEl.style.maxWidth = `${fallbackWidth}px`;
            this.contentEl.style.removeProperty('column-width');
        }

        this.updateDebugOverlay(snapshot);
        return snapshot;
    }

    applyPage(index: number): number {
        const previousOffset = this.currentOffset;
        const rawOffset = this.getOffsetForPage(index);
        const offset = this.pageAxis === 'x' ? this.normalize(rawOffset) : rawOffset;
        this.currentOffset = offset;

        const previousTransform = this.buildTransform(previousOffset);
        const nextTransform = this.buildTransform(offset);
        const direction = offset > previousOffset ? 1 : -1;

        if (!Number.isFinite(offset)) {
            console.warn('[ObsidianR] applyPage received invalid offset', { index, offset });
            return previousOffset;
        }

        if (Math.abs(offset - previousOffset) <= EPSILON) {
            this.contentEl.style.transform = nextTransform;
            logDebug('pagination.applyPage skipped animation', {
                index,
                offset,
                previousOffset,
                axis: this.pageAxis
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
            axis: this.pageAxis,
            transform: nextTransform,
            transitionType: this.transitionType
        });

        const viewportRect = this.viewportEl.getBoundingClientRect();
        const contentRect = this.contentEl.getBoundingClientRect();
        logDebug('pagination.applyPage layout', {
            index,
            viewportHeight: Math.round(viewportRect.height),
            viewportWidth: Math.round(viewportRect.width),
            contentHeight: Math.round(contentRect.height),
            contentWidth: Math.round(contentRect.width),
            axis: this.pageAxis,
            topOffset: Math.round(contentRect.top - viewportRect.top),
            leftOffset: Math.round(contentRect.left - viewportRect.left)
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
        const clamped = Math.max(0, Math.min(offset, this.contentExtent));
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
        return this.contentExtent;
    }

    getOffsets(): number[] {
        return [...this.offsets];
    }

    getPageAxis(): PaginationAxis {
        return this.pageAxis;
    }

    getPageWidth(): number {
        return this.pageWidth;
    }

    getColumnsPerPage(): number {
        return this.columnsPerPage;
    }

    getColumnWidth(): number {
        return this.columnWidth;
    }

    getColumnGap(): number {
        return this.columnGap;
    }

    getTotalColumns(): number {
        return this.totalColumns;
    }

    destroy(): void {
        if (!this.originalStyles) {
            return;
        }
        this.resetAnimationState();
        if (this.debugOverlay) {
            this.debugOverlay.remove();
            this.debugOverlay = null;
        }
        const styles = this.originalStyles;
        this.contentEl.style.fontSize = styles.fontSize;
        this.contentEl.style.lineHeight = styles.lineHeight;
        this.contentEl.style.letterSpacing = styles.letterSpacing;
        this.contentEl.style.wordSpacing = styles.wordSpacing;
        this.contentEl.style.fontFamily = styles.fontFamily;
        this.contentEl.style.paddingTop = styles.paddingTop;
        this.contentEl.style.paddingBottom = styles.paddingBottom;
        this.contentEl.style.columnCount = styles.columnCount;
        this.contentEl.style.columnGap = styles.columnGap;
        this.contentEl.style.columnFill = styles.columnFill;
        this.contentEl.style.columnWidth = styles.columnWidth;
        this.contentEl.style.transition = styles.transition;
        this.contentEl.style.transform = styles.transform;
        this.contentEl.style.height = styles.height;
        this.contentEl.style.maxHeight = styles.maxHeight;
        this.contentEl.style.width = styles.width;
        this.contentEl.style.maxWidth = styles.maxWidth;
        this.contentEl.style.opacity = styles.opacity;
        this.contentEl.style.transformStyle = styles.transformStyle;
        this.contentEl.style.backfaceVisibility = styles.backfaceVisibility;
        this.originalStyles = null;
        if (this.originalPerspective !== null) {
            this.viewportEl.style.perspective = this.originalPerspective;
        }
        this.originalPerspective = null;
        this.transitionType = 'none';
        this.pageAxis = 'y';
        this.pageHeight = 0;
        this.pageWidth = 0;
        this.contentExtent = 0;
        this.columnsPerPage = 1;
        this.totalColumns = 1;
        this.columnWidth = 0;
        this.columnGap = 0;
        this.offsets = [0];
        this.currentOffset = 0;
        this.lastViewportInnerWidth = 0;
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
            fontFamily: style.fontFamily,
            paddingTop: style.paddingTop,
            paddingBottom: style.paddingBottom,
            columnCount: style.columnCount,
            columnGap: style.columnGap,
            columnFill: style.columnFill,
            columnWidth: style.columnWidth,
            transition: style.transition,
            transform: style.transform,
            height: style.height,
            maxHeight: style.maxHeight,
            width: style.width,
            maxWidth: style.maxWidth,
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

        const viewportComputed = window.getComputedStyle(viewport);
        const paddingLeftPx = parseFloat(viewportComputed.paddingLeft) || 0;
        const paddingRightPx = parseFloat(viewportComputed.paddingRight) || 0;
        const paddingTopPx = parseFloat(viewportComputed.paddingTop) || 0;
        const paddingBottomPx = parseFloat(viewportComputed.paddingBottom) || 0;
        const viewportRect = viewport.getBoundingClientRect();
        const rawViewportWidth = viewportRect.width || viewport.clientWidth || viewport.offsetWidth || 0;
        const innerWidth = Math.max(1, rawViewportWidth - paddingLeftPx - paddingRightPx);
        this.lastViewportInnerWidth = innerWidth;
        this.lastViewportPadding = {
            top: paddingTopPx,
            bottom: paddingBottomPx,
            left: paddingLeftPx,
            right: paddingRightPx
        };

        const availableViewportHeight = Math.max(
            1,
            Math.round(
                (viewportRect.height || viewport.clientHeight || viewport.offsetHeight || 0) -
                paddingTopPx -
                paddingBottomPx
            )
        );
        this.containerEl.style.left = `${paddingLeftPx}px`;
        this.containerEl.style.right = `${paddingRightPx}px`;
        this.containerEl.style.top = `${paddingTopPx}px`;
        this.containerEl.style.bottom = `${paddingBottomPx}px`;
        this.containerEl.style.width = `${innerWidth}px`;
        this.containerEl.style.height = `${availableViewportHeight}px`;

        const target = this.getMeasurementTarget();
        target.style.boxSizing = 'border-box';
        target.style.fontSize = `${parameters.fontSize}px`;
        target.style.lineHeight = `${parameters.lineSpacing}`;
        target.style.letterSpacing = `${parameters.letterSpacing}em`;
        target.style.wordSpacing = `${parameters.wordSpacing}em`;
        target.style.fontFamily = parameters.fontFamily;
        target.classList.toggle('is-justified', parameters.justified);
        target.style.marginLeft = '0px';
        target.style.marginRight = '0px';
        target.style.paddingLeft = '0px';
        target.style.paddingRight = '0px';
        target.style.wordBreak = 'break-word';
        target.style.overflowWrap = 'anywhere';

        const guardPadding = Math.max(16, Math.round(parameters.fontSize * 0.75));
        this.guardPadding = guardPadding;
        this.containerEl.style.paddingTop = `${guardPadding}px`;
        this.containerEl.style.paddingBottom = `${guardPadding}px`;
        this.containerEl.style.paddingLeft = '0';
        this.containerEl.style.paddingRight = '0';
        target.style.paddingTop = '0';
        target.style.paddingBottom = '0';

        const columnCount = Math.max(1, Math.round(parameters.columns));
        if (columnCount > 1) {
            const columnGap = this.computeColumnGap(parameters);
            const totalGap = columnGap * Math.max(0, columnCount - 1);
            const usableWidth = Math.max(1, innerWidth - totalGap);
            const columnWidth = Math.max(1, usableWidth / columnCount);
            target.style.columnCount = `${columnCount}`;
            target.style.columnGap = `${columnGap}px`;
            target.style.columnFill = 'auto';
            target.style.columnWidth = `${columnWidth}px`;
            logDebug('pagination.prepareLayout columns', {
                innerWidth,
                columnCount,
                columnGap,
                totalGap,
                usableWidth,
                columnWidth,
                marginLeft: window.getComputedStyle(target).marginLeft,
                paddingLeft: window.getComputedStyle(target).paddingLeft
            });
        } else {
            target.style.removeProperty('column-count');
            target.style.removeProperty('column-gap');
            target.style.removeProperty('column-fill');
            target.style.removeProperty('column-width');
        }

        target.style.removeProperty('height');
        target.style.width = `${innerWidth}px`;
        target.style.maxWidth = `${innerWidth}px`;
        this.contentEl.style.transition = this.getTransition(parameters.transitionType);
        this.contentEl.style.width = `${innerWidth}px`;
        this.contentEl.style.maxWidth = `${innerWidth}px`;
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

    private computeColumnWidth(
        target: HTMLElement,
        columnsPerPage: number,
        columnGap: number
    ): number {
        const inlineWidth = parseFloat(target.style.columnWidth);
        if (!Number.isNaN(inlineWidth) && inlineWidth > 0) {
            return inlineWidth;
        }
        const computed = window.getComputedStyle(target);
        const declared = parseFloat(computed.columnWidth);
        if (!Number.isNaN(declared) && declared > 0) {
            return declared;
        }
        if (columnsPerPage <= 1) {
            const rect = target.getBoundingClientRect();
            if (rect.width > 0) {
                return rect.width;
            }
            return Math.max(1, this.lastViewportInnerWidth || target.clientWidth || target.scrollWidth || 0);
        }
        const availableWidth = this.lastViewportInnerWidth || target.clientWidth || target.scrollWidth;
        const residual = availableWidth - columnGap * Math.max(0, columnsPerPage - 1);
        return Math.max(1, residual / Math.max(1, columnsPerPage));
    }

    private computePageWidth(
        columnsPerPage: number,
        columnWidth: number,
        columnGap: number
    ): number {
        if (columnsPerPage <= 1) {
            return Math.max(1, this.lastViewportInnerWidth || columnWidth || this.viewportEl.clientWidth);
        }
        return Math.max(1, this.lastViewportInnerWidth || this.viewportEl.clientWidth);
    }

    private buildHorizontalSnapshot(
        totalWidth: number,
        availableHeight: number,
        metrics: { columnsPerPage: number; pageWidth: number; columnWidth: number; columnGap: number; },
        measurementTarget: HTMLElement
    ): PaginationSnapshot {
        const columnHeight = Math.max(availableHeight, 1);
        const columnWidth = Math.max(1, this.normalize(metrics.columnWidth));
        const columnGap = Math.max(0, this.normalize(metrics.columnGap));
        const blockWidth = Math.max(1, columnWidth + columnGap);
        const normalizedTotalWidth = Math.max(totalWidth, blockWidth);
        const totalColumns = Math.max(1, Math.ceil((normalizedTotalWidth + columnGap) / blockWidth));
        const columnsPerPage = Math.max(1, metrics.columnsPerPage);
        const totalPages = Math.max(1, Math.ceil(totalColumns / columnsPerPage));

        let columnPositions: number[] = [];
        for (let columnIndex = 0; columnIndex < totalColumns; columnIndex += 1) {
            columnPositions.push(this.normalize(columnIndex * blockWidth));
        }
        if (columnPositions.length === 0) {
            columnPositions.push(0);
        }

        if (totalColumns > 1) {
            const offsets = this.collectColumnOffsets(totalColumns, measurementTarget);
            if (offsets.length === totalColumns) {
                const baseOffset = offsets[0];
                columnPositions = offsets.map((offset) => this.normalize(Math.max(0, offset - baseOffset)));
            }
        }

        const offsets: number[] = [];
        const maxStartIndex = Math.max(0, totalColumns - columnsPerPage);
        for (let pageIndex = 0; pageIndex < totalPages; pageIndex += 1) {
            const startIndex = Math.min(pageIndex * columnsPerPage, maxStartIndex);
            const baseOffset = columnPositions[startIndex] ?? 0;
            offsets.push(this.normalize(Math.max(0, baseOffset)));
        }
        if (offsets.length === 0) {
            offsets.push(0);
        }

        const contentExtent = this.normalize((totalColumns - 1) * blockWidth + columnWidth);

        return {
            axis: 'x',
            pageHeight: columnHeight,
            pageWidth: this.normalize(columnsPerPage * blockWidth),
            offsets,
            contentExtent,
            totalColumns,
            columnsPerPage,
            columnWidth,
            columnGap
        };
    }

    private collectColumnOffsets(totalColumns: number, measurementTarget: HTMLElement): number[] {
        try {
            const fragments = this.collectFragments();
            if (fragments.length === 0) {
                return [];
            }
            const contentRect = measurementTarget.getBoundingClientRect();
            const precision = 1000;
            const offsets: number[] = [];
            const seen = new Set<number>();
            for (const fragment of fragments) {
                const relativeLeft = fragment.left - contentRect.left;
                if (!Number.isFinite(relativeLeft)) {
                    continue;
                }
                const normalized = Math.round(relativeLeft * precision) / precision;
                if (normalized < -8 || normalized > contentRect.width + 8) {
                    continue;
                }
                if (!seen.has(normalized)) {
                    seen.add(normalized);
                    offsets.push(normalized);
                    if (offsets.length >= totalColumns) {
                        break;
                    }
                }
            }
            offsets.sort((a, b) => a - b);
            return offsets;
        } catch (error) {
            console.warn('[ObsidianR] pagination.collectColumnOffsets failed', error);
            return [];
        }
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

        const vertical = direction >= 0 ? -12 : 12;
        const animation = this.contentEl.animate(
            [
                { transform: `${previousTransform} translateY(0%)`, opacity: 1 },
                { transform: `${previousTransform} translateY(${vertical}%)`, opacity: 0.92, offset: 0.45 },
                { transform: `${nextTransform} translateY(${vertical * -1}%)`, opacity: 0.92, offset: 0.65 },
                { transform: `${nextTransform} translateY(0%)`, opacity: 1 }
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
            this.viewportEl.clientHeight - paddingTop - paddingBottom - this.guardPadding * 2
        );

        const defaultPageWidth = Math.max(1, Math.round(this.lastViewportInnerWidth || this.viewportEl.clientWidth || 0));

        if (availableHeight <= 0) {
            return {
                axis: 'y',
                pageHeight: 0,
                pageWidth: defaultPageWidth,
                offsets: [0],
                contentExtent: 0,
                totalColumns: 1,
                columnsPerPage: 1,
                columnWidth: defaultPageWidth,
                columnGap: 0
            };
        }

        const measurementTarget = this.getMeasurementTarget();
        const measurementStyle = window.getComputedStyle(measurementTarget);
        const columnGap = Math.max(0, parseFloat(measurementStyle.columnGap) || 0);
        const declaredColumnCount = parseInt(measurementStyle.columnCount, 10);
        const columnsPerPage = Number.isNaN(declaredColumnCount) ? 1 : Math.max(1, declaredColumnCount);
        const columnWidth = this.computeColumnWidth(measurementTarget, columnsPerPage, columnGap);
        const pageWidth = this.computePageWidth(columnsPerPage, columnWidth, columnGap);
        const axis: PaginationAxis = columnsPerPage > 1 ? 'x' : 'y';
        const metrics = {
            columnsPerPage,
            pageWidth,
            columnWidth,
            columnGap
        };
        if (axis === 'x') {
            const contentHeight = Math.max(1, availableHeight);
            measurementTarget.style.height = `${contentHeight}px`;
            measurementTarget.style.maxHeight = `${contentHeight}px`;
            const viewportWidth = Math.max(1, this.lastViewportInnerWidth || pageWidth);
            measurementTarget.style.width = `${viewportWidth}px`;
            measurementTarget.style.maxWidth = `${viewportWidth}px`;
            measurementTarget.style.columnFill = 'auto';
            // Force layout so scrollWidth accounts for the new constraints.
            void measurementTarget.offsetWidth;
            const totalWidth = Math.max(viewportWidth, measurementTarget.scrollWidth);
            return this.buildHorizontalSnapshot(totalWidth, contentHeight, metrics, measurementTarget);
        }

        measurementTarget.style.removeProperty('height');
        measurementTarget.style.removeProperty('max-height');

        const scrollHeight = Math.max(availableHeight, measurementTarget.scrollHeight);

        try {
            const fragments = this.collectFragments();
            if (fragments.length > 0) {
                const contentRect = measurementTarget.getBoundingClientRect();
                const {
                    normalizedFragments,
                    virtualExtent,
                    maxFragmentBottom,
                    totalColumns
                } = this.normalizeFragments(
                    fragments,
                    contentRect,
                    availableHeight,
                    1
                );
                const preciseSnapshot = this.buildSnapshotFromFragments(
                    normalizedFragments,
                    availableHeight,
                    virtualExtent,
                    totalColumns,
                    maxFragmentBottom,
                    defaultPageWidth
                );
                if (preciseSnapshot) {
                    this.debugVerifyCoverage(normalizedFragments, preciseSnapshot.offsets, availableHeight);
                    return preciseSnapshot;
                }
            }
        } catch (error) {
            console.warn('[ObsidianR] pagination.measure failed to derive fragments', error);
        }

        return this.applyFallback(scrollHeight, availableHeight, axis, metrics, defaultPageWidth);
    }

    private normalizeFragments(
        fragments: LineFragment[],
        contentRect: DOMRect,
        availableHeight: number,
        columnsPerPage: number
    ): {
        normalizedFragments: Array<{ top: number; bottom: number; }>;
        virtualExtent: number;
        maxFragmentBottom: number;
        totalColumns: number;
    } {
        const columnCount = Math.max(1, columnsPerPage);
        const quantize = (value: number) => Math.round(value * 100) / 100;
        const columnPositions = new Map<number, number>();
        const resolveColumnIndex = (left: number) => {
            const key = quantize(left - contentRect.left);
            if (!columnPositions.has(key)) {
                columnPositions.set(key, columnPositions.size);
            }
            return columnPositions.get(key) ?? 0;
        };

        let maxBottom = 0;
        let maxGlobalColumnIndex = 0;
        const normalized = fragments.map((fragment) => {
            const originalTop = fragment.top - contentRect.top;
            const originalBottom = fragment.bottom - contentRect.top;

            if (columnCount > 1 && availableHeight > 0) {
                const columnIndex = Math.min(columnCount - 1, resolveColumnIndex(fragment.left));
                const rowIndex = Math.max(0, Math.floor(originalTop / availableHeight));
                const offsetWithinColumn = originalTop - rowIndex * availableHeight;
                const globalColumnIndex = rowIndex * columnCount + columnIndex;
                const normalizedTop = globalColumnIndex * availableHeight + offsetWithinColumn;
                const fragmentHeight = Math.max(1, originalBottom - originalTop);
                const normalizedBottom = normalizedTop + fragmentHeight;
                maxGlobalColumnIndex = Math.max(maxGlobalColumnIndex, globalColumnIndex);
                maxBottom = Math.max(maxBottom, normalizedBottom);
                return { top: normalizedTop, bottom: normalizedBottom };
            }

            maxBottom = Math.max(maxBottom, originalBottom);
            return {
                top: originalTop,
                bottom: originalBottom
            };
        });

        normalized.sort((a, b) => {
            if (Math.abs(a.top - b.top) > EPSILON) {
                return a.top - b.top;
            }
            return a.bottom - b.bottom;
        });

        const deduped: Array<{ top: number; bottom: number; }> = [];
        for (const fragment of normalized) {
            const last = deduped[deduped.length - 1];
            if (
                last &&
                Math.abs(last.top - fragment.top) < EPSILON &&
                Math.abs(last.bottom - fragment.bottom) < EPSILON
            ) {
                continue;
            }
            deduped.push(fragment);
        }

        const totalColumns = columnCount > 1
            ? Math.max(1, maxGlobalColumnIndex + 1)
            : Math.max(1, Math.ceil(maxBottom / Math.max(availableHeight, 1)));
        const virtualExtent = columnCount > 1
            ? Math.max(maxBottom, totalColumns * Math.max(availableHeight, 1))
            : Math.max(maxBottom, availableHeight);

        return {
            normalizedFragments: deduped,
            virtualExtent,
            maxFragmentBottom: maxBottom,
            totalColumns
        };
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
        if (this.pageAxis === 'x') {
            const normalized = this.normalize(offset);
            return `translate3d(${-normalized}px, 0, 0)`;
        }
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
        virtualExtent: number,
        totalColumns: number,
        maxFragmentBottom: number,
        defaultPageWidth: number
    ): PaginationSnapshot | null {
        if (fragments.length === 0 || availableHeight <= 0) {
            return null;
        }

        const stride = Math.max(1, availableHeight);
        const fragmentExtent = Math.max(virtualExtent, maxFragmentBottom, stride);
        const maxOffset = Math.max(0, fragmentExtent - stride);
        const offsets: number[] = [0];
        let currentOffset = 0;
        let searchIndex = 0;

        while (currentOffset < maxOffset - EPSILON) {
            const threshold = currentOffset + stride;
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

        const inferredColumns = Math.max(1, Math.ceil(fragmentExtent / stride));
        const pageWidth = Math.max(1, Math.round(defaultPageWidth || this.lastViewportInnerWidth || this.viewportEl.clientWidth));

        return {
            axis: 'y',
            pageHeight: stride,
            pageWidth,
            offsets: uniqueOffsets,
            contentExtent: fragmentExtent,
            totalColumns: Math.max(totalColumns, inferredColumns),
            columnsPerPage: 1,
            columnWidth: pageWidth,
            columnGap: 0
        };
    }


    private applyFallback(
        extent: number,
        availableHeight: number,
        axis: PaginationAxis,
        metrics: { columnsPerPage: number; pageWidth: number; columnWidth: number; columnGap: number; },
        defaultPageWidth: number
    ): PaginationSnapshot {
        if (axis === 'x') {
            return this.buildHorizontalSnapshot(extent, availableHeight, metrics, this.contentEl);
        }

        const normalizedScrollExtent = Math.max(extent, availableHeight);
        const baseUnit = Math.max(availableHeight, 1);
        const requiredSteps = Math.max(1, Math.ceil(normalizedScrollExtent / baseUnit));
        const maxOffset = Math.max(0, normalizedScrollExtent - baseUnit);

        const offsets: number[] = [];
        for (let step = 0; step < requiredSteps; step += 1) {
            const offset = Math.min(step * baseUnit, maxOffset);
            if (offsets.length === 0 || offset - offsets[offsets.length - 1] > EPSILON) {
                offsets.push(offset);
            }
        }

        if (offsets.length === 0) {
            offsets.push(0);
        }

        const pageWidth = Math.max(1, Math.round(defaultPageWidth || metrics.pageWidth));
        const totalColumns = Math.max(1, Math.ceil(normalizedScrollExtent / baseUnit));

        return {
            axis: 'y',
            pageHeight: baseUnit,
            pageWidth,
            offsets,
            contentExtent: normalizedScrollExtent,
            totalColumns,
            columnsPerPage: 1,
            columnWidth: pageWidth,
            columnGap: 0
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

    private updateDebugOverlay(snapshot: PaginationSnapshot): void {
        if (!this.isDebugMode()) {
            if (this.debugOverlay) {
                this.debugOverlay.remove();
                this.debugOverlay = null;
            }
            return;
        }

        if (!this.debugOverlay) {
            const overlay = document.createElement('div');
            overlay.className = 'obsidianr-reader-debug-overlay';
            overlay.style.position = 'absolute';
            overlay.style.pointerEvents = 'none';
            overlay.style.zIndex = '4';
            overlay.style.mixBlendMode = 'soft-light';
            this.viewportEl.appendChild(overlay);
            this.debugOverlay = overlay;
        }

        const overlay = this.debugOverlay;
        const padding = this.lastViewportPadding;
        overlay.style.left = `${padding.left}px`;
        overlay.style.right = `${padding.right}px`;
        overlay.style.top = `${padding.top}px`;
        overlay.style.bottom = `${padding.bottom}px`;
        overlay.style.border = '1px dashed rgba(52, 152, 219, 0.28)';
        overlay.style.display = 'block';

        if (snapshot.columnsPerPage > 1 && snapshot.columnWidth > 0) {
            const columnWidth = Math.max(1, snapshot.columnWidth);
            const columnGap = Math.max(0, snapshot.columnGap);
            const blockWidth = Math.max(1, columnWidth + columnGap);
            overlay.style.backgroundImage = `repeating-linear-gradient(
                to right,
                rgba(52, 152, 219, 0.2) 0,
                rgba(52, 152, 219, 0.2) ${columnWidth}px,
                rgba(52, 152, 219, 0.05) ${columnWidth}px,
                rgba(52, 152, 219, 0.05) ${blockWidth}px
            )`;
            overlay.style.backgroundSize = `${blockWidth}px ${snapshot.pageHeight}px`;
        } else {
            const height = Math.max(1, snapshot.pageHeight);
            overlay.style.backgroundImage = `repeating-linear-gradient(
                to bottom,
                rgba(52, 152, 219, 0.2) 0,
                rgba(52, 152, 219, 0.2) ${height}px,
                rgba(52, 152, 219, 0.05) ${height}px,
                rgba(52, 152, 219, 0.05) ${height + 4}px
            )`;
            overlay.style.backgroundSize = `100% ${height + 4}px`;
        }
    }

    private isDebugMode(): boolean {
        const globalWindow = window as unknown as { obsidianrDebugPagination?: boolean; };
        return globalWindow?.obsidianrDebugPagination === true;
    }
}
