import { MarkdownView, WorkspaceLeaf, Platform, MarkdownRenderer, TFile } from 'obsidian';
import type ObsidianRPlugin from '../main';
import { ReaderState, ReaderParameters } from '../core/state';
import { PaginationEngine } from './pagination';

const BODY_CLASS = 'obsidianr-reader';

export class ReaderManager {
    private activeLeaf: WorkspaceLeaf | null = null;
    private viewportEl: HTMLElement | null = null;
    private contentEl: HTMLElement | null = null;
    private pagination: PaginationEngine | null = null;
    private resizeObserver: ResizeObserver | null = null;
    private pendingFrame: number | null = null;
    private preservePositionOnFrame = false;
    private originalViewportStyles: Partial<CSSStyleDeclaration> | null = null;
    private originalContentStyles: Partial<CSSStyleDeclaration> | null = null;
    private cleanupCallbacks: Array<() => void> = [];
    private renderedSource: string | null = null;
    private loadedFile: TFile | null = null;
    private renderedFileVersion: number | null = null;
    private originalPreviewEl: HTMLElement | null = null;
    private originalPreviewIndex: number | null = null;
    private pageIndicatorEl: HTMLElement | null = null;
    private pageIndicatorHeight = 0;
    private pendingInitialPage: number | 'last' | null = null;
    private chapterNavigationLock = false;

    constructor(
        private readonly plugin: ObsidianRPlugin,
        private readonly state: ReaderState
    ) { }

    toggleReaderMode(): void {
        if (this.state.snapshot.active) {
            this.disableReaderMode();
        } else {
            this.enableReaderMode();
        }
    }

    enableReaderMode(): void {
        const view = this.getActiveMarkdownView();
        if (!view) {
            return;
        }

        if (!this.setupView(view)) {
            return;
        }

        this.activeLeaf = view.leaf;
        document.body.classList.add(BODY_CLASS);
        this.state.update({
            active: true,
            currentFile: view.file ?? null,
            currentPage: 0,
            totalPages: 0,
            pageHeight: 0
        });

        this.applyParameters(this.state.snapshot.parameters);
        this.attachInteractionHandlers(view);
        this.schedulePagination(false);
    }

    disableReaderMode(): void {
        const view = this.getActiveMarkdownView();
        document.body.classList.remove(BODY_CLASS);
        this.state.update({
            active: false,
            overlayVisible: false,
            zenMode: false
        });

        if (view) {
            this.detachInteractionHandlers(view);
        }

        this.teardownView();
        this.activeLeaf = null;
    }

    refreshCurrentView(preservePosition = true): void {
        if (!this.state.snapshot.active) {
            return;
        }

        const view = this.getActiveMarkdownView();
        if (!view) {
            return;
        }

        if (!this.viewportEl || !this.contentEl || !this.pagination) {
            if (!this.setupView(view)) {
                return;
            }
        }

        this.applyParameters(this.state.snapshot.parameters);
        this.schedulePagination(preservePosition);
    }

    updateParameters(partial: Partial<ReaderParameters>): void {
        this.state.updateParameters(partial);
        this.refreshCurrentView();
    }

    onActiveLeafChange(leaf: WorkspaceLeaf | null): void {
        if (!this.state.snapshot.active) {
            return;
        }

        let targetView: MarkdownView | null = null;
        if (leaf && leaf.view instanceof MarkdownView) {
            targetView = leaf.view;
        } else {
            targetView = this.getActiveMarkdownView();
        }

        if (!targetView) {
            this.disableReaderMode();
            return;
        }

        this.activeLeaf = targetView.leaf;
        if (!this.setupView(targetView)) {
            return;
        }
        this.state.update({
            currentFile: targetView.file ?? null,
            currentPage: 0,
            totalPages: 0,
            pageHeight: 0
        });
        this.schedulePagination(false);
    }

    private getActiveMarkdownView(): MarkdownView | null {
        const view = this.plugin.app.workspace.getActiveViewOfType(MarkdownView);
        return view ?? null;
    }

    private applyParameters(parameters: ReaderParameters): void {
        if (!this.viewportEl || !this.contentEl) {
            return;
        }

        const target = this.contentEl.querySelector<HTMLElement>('.obsidianr-reader-content') ?? this.contentEl;

        target.style.fontSize = `${parameters.fontSize}px`;
        target.style.lineHeight = `${parameters.lineSpacing}`;
        target.style.letterSpacing = `${parameters.letterSpacing}em`;
        target.style.wordSpacing = `${parameters.wordSpacing}em`;
        target.classList.toggle('is-justified', parameters.justified);

        const guardPadding = Math.max(12, Math.round(parameters.fontSize * 0.6));
        target.style.paddingTop = `${guardPadding}px`;
        target.style.paddingBottom = `${guardPadding}px`;

        const columnCount = Math.max(1, Math.round(parameters.columns));
        target.style.breakInside = 'avoid';
        if (columnCount > 1) {
            const columnGap = Math.max(16, Math.round(parameters.fontSize * 0.6));
            target.style.columnCount = `${columnCount}`;
            target.style.columnGap = `${columnGap}px`;
            target.style.columnFill = 'balance';
        } else {
            target.style.removeProperty('column-count');
            target.style.removeProperty('column-gap');
            target.style.removeProperty('column-fill');
        }
        target.style.removeProperty('height');

        const horizontalPadding = `${parameters.horizontalMargins}%`;
        this.viewportEl.style.paddingLeft = horizontalPadding;
        this.viewportEl.style.paddingRight = horizontalPadding;

        const verticalPadding = Math.max(16, Math.round(parameters.fontSize * 0.9));
        this.viewportEl.style.paddingTop = `${verticalPadding}px`;
        const indicatorHeight = this.pageIndicatorHeight;
        this.viewportEl.style.paddingBottom = `${verticalPadding + indicatorHeight}px`;

        if (this.pageIndicatorEl) {
            const desiredHeight = this.computePageIndicatorHeight(this.viewportEl);
            if (Math.abs(desiredHeight - this.pageIndicatorHeight) > 0.5) {
                this.pageIndicatorHeight = desiredHeight;
                this.pageIndicatorEl.style.height = `${desiredHeight}px`;
                this.pageIndicatorEl.style.lineHeight = `${desiredHeight}px`;
                if (this.contentEl) {
                    this.contentEl.style.bottom = `${desiredHeight}px`;
                }
                this.viewportEl.dataset.obsidianrIndicatorHeight = `${desiredHeight}`;
                this.viewportEl.style.paddingBottom = `${verticalPadding + desiredHeight}px`;
            }
        }
    }

    private computePageIndicatorHeight(viewport: HTMLElement): number {
        const doc = viewport.ownerDocument ?? document;
        const leafHeader = viewport.closest('.workspace-leaf')?.querySelector<HTMLElement>('.view-header-title-container');
        const header = leafHeader ?? doc.querySelector<HTMLElement>('.view-header-title-container');
        const observed = header?.offsetHeight ?? header?.clientHeight ?? 0;
        const indicator = Math.max(24, Math.round(observed || 0));
        return Number.isFinite(indicator) ? indicator : 32;
    }

    private updatePageIndicator(): void {
        if (!this.pageIndicatorEl) {
            return;
        }
        const snapshot = this.state.snapshot;
        const total = snapshot.totalPages;
        if (!Number.isFinite(total) || total <= 0) {
            this.pageIndicatorEl.textContent = '';
            this.pageIndicatorEl.classList.remove('is-visible');
            return;
        }

        const current = Math.min(snapshot.currentPage + 1, total);
        this.pageIndicatorEl.textContent = `Page ${current} / ${total}`;
        this.pageIndicatorEl.classList.add('is-visible');
    }

    private attachInteractionHandlers(view: MarkdownView): void {
        const container = view.containerEl;
        if (Platform.isMobile) {
            const touchStart = (event: TouchEvent) => {
                this.state.markInteraction();
                this.handleTouchStart(event);
            };
            const touchEnd = (event: TouchEvent) => {
                this.state.markInteraction();
                this.handleTouchEnd(event);
            };
            container.addEventListener('touchstart', touchStart, { passive: true });
            container.addEventListener('touchend', touchEnd, { passive: true });
            this.plugin.register(() => {
                container.removeEventListener('touchstart', touchStart);
                container.removeEventListener('touchend', touchEnd);
            });
        } else {
            const keyHandler = (event: KeyboardEvent) => {
                this.state.markInteraction();
                this.handleKeyDown(event);
            };
            document.addEventListener('keydown', keyHandler);
            this.plugin.register(() => {
                document.removeEventListener('keydown', keyHandler);
            });
        }
    }

    private detachInteractionHandlers(view: MarkdownView): void {
        if (Platform.isMobile) {
            // Handlers automatically cleaned up via register callbacks.
            return;
        }
        // Desktop handlers removed when plugin unloads; nothing extra required here.
        void view;
    }

    private handleTouchStart(_event: TouchEvent): void {
        // Placeholder: will implement swipe detection later
    }

    private handleTouchEnd(_event: TouchEvent): void {
        // Placeholder
    }

    private handleKeyDown(event: KeyboardEvent): void {
        if (!this.state.snapshot.active) {
            return;
        }

        if (event.key === 'ArrowRight' || event.key === 'PageDown') {
            this.nextPage();
            event.preventDefault();
        } else if (event.key === 'ArrowLeft' || event.key === 'PageUp') {
            this.previousPage();
            event.preventDefault();
        } else if (event.key === '+') {
            this.increaseFont();
            event.preventDefault();
        } else if (event.key === '-') {
            this.decreaseFont();
            event.preventDefault();
        }
    }

    nextPage(): void {
        const snapshot = this.state.snapshot;
        if (snapshot.totalPages <= 0) {
            return;
        }
        if (snapshot.currentPage >= snapshot.totalPages - 1) {
            void this.navigateChapter('next');
            return;
        }
        const next = snapshot.currentPage + 1;
        this.state.update({ currentPage: next });
        this.applyCurrentPage();
    }

    previousPage(): void {
        const snapshot = this.state.snapshot;
        if (snapshot.currentPage <= 0) {
            void this.navigateChapter('previous');
            return;
        }
        const prev = snapshot.currentPage - 1;
        this.state.update({ currentPage: prev });
        this.applyCurrentPage();
    }

    increaseFont(): void {
        const snapshot = this.state.snapshot;
        const fontSize = Math.min(72, snapshot.parameters.fontSize + 1);
        if (fontSize !== snapshot.parameters.fontSize) {
            this.updateParameters({ fontSize });
        }
    }

    decreaseFont(): void {
        const snapshot = this.state.snapshot;
        const fontSize = Math.max(8, snapshot.parameters.fontSize - 1);
        if (fontSize !== snapshot.parameters.fontSize) {
            this.updateParameters({ fontSize });
        }
    }

    private setupView(view: MarkdownView): boolean {
        const viewport = view.contentEl.querySelector<HTMLElement>('.markdown-reading-view') ?? view.contentEl;
        if (!viewport) {
            return false;
        }

        if (this.viewportEl !== viewport) {
            this.teardownView();

            this.viewportEl = viewport;
            this.originalViewportStyles = {
                overflow: viewport.style.overflow,
                position: viewport.style.position,
                paddingLeft: viewport.style.paddingLeft,
                paddingRight: viewport.style.paddingRight,
                paddingTop: viewport.style.paddingTop,
                paddingBottom: viewport.style.paddingBottom
            };

            viewport.style.overflow = 'hidden';
            if (!viewport.style.position) {
                viewport.style.position = 'relative';
            }

            if (!this.originalPreviewEl) {
                const existingPreview = viewport.querySelector<HTMLElement>('.markdown-preview-view');
                if (existingPreview) {
                    const siblings = Array.from(viewport.children);
                    this.originalPreviewIndex = siblings.indexOf(existingPreview);
                    this.originalPreviewEl = existingPreview;
                    viewport.removeChild(existingPreview);
                }
            }

            const container = viewport.ownerDocument.createElement('div');
            container.classList.add('obsidianr-reader-container', 'markdown-preview-view', 'markdown-rendered');
            container.style.transform = 'translate3d(0, 0, 0)';
            container.style.willChange = 'transform';
            container.style.position = 'absolute';
            container.style.top = '0';
            container.style.right = '0';
            container.style.bottom = '0';
            container.style.left = '0';
            container.style.width = '100%';
            container.style.height = '100%';
            container.style.overflow = 'hidden';
            viewport.appendChild(container);

            this.contentEl = container;
            this.originalContentStyles = {
                transform: container.style.transform,
                transition: container.style.transition,
                position: container.style.position,
                top: container.style.top,
                right: container.style.right,
                bottom: container.style.bottom,
                left: container.style.left,
                height: container.style.height,
                width: container.style.width,
                overflow: container.style.overflow,
                columnCount: container.style.columnCount,
                columnGap: container.style.columnGap,
                columnFill: container.style.columnFill,
                letterSpacing: container.style.letterSpacing,
                wordSpacing: container.style.wordSpacing,
                fontSize: container.style.fontSize,
                lineHeight: container.style.lineHeight
            };

            const indicator = viewport.ownerDocument.createElement('div');
            indicator.classList.add('obsidianr-reader-page-indicator');
            indicator.setAttribute('aria-live', 'polite');
            viewport.appendChild(indicator);
            this.pageIndicatorEl = indicator;
            this.pageIndicatorHeight = this.computePageIndicatorHeight(viewport);
            indicator.style.height = `${this.pageIndicatorHeight}px`;
            indicator.style.lineHeight = `${this.pageIndicatorHeight}px`;
            container.style.bottom = `${this.pageIndicatorHeight}px`;
            viewport.dataset.obsidianrIndicatorHeight = `${this.pageIndicatorHeight}`;
            this.updatePageIndicator();

            this.pagination = new PaginationEngine(viewport, container);
            if (typeof ResizeObserver !== 'undefined') {
                this.resizeObserver = new ResizeObserver(() => this.schedulePagination(true));
                this.resizeObserver.observe(viewport);
            }
        }

        return true;
    }

    private teardownView(): void {
        if (this.pendingFrame !== null) {
            cancelAnimationFrame(this.pendingFrame);
            this.pendingFrame = null;
        }

        this.resizeObserver?.disconnect();
        this.resizeObserver = null;

        this.pagination?.destroy();
        this.pagination = null;

        this.flushRenderedContent();

        if (this.viewportEl && this.originalViewportStyles) {
            const original = this.originalViewportStyles;
            this.viewportEl.style.overflow = original.overflow ?? '';
            this.viewportEl.style.position = original.position ?? '';
            this.viewportEl.style.paddingLeft = original.paddingLeft ?? '';
            this.viewportEl.style.paddingRight = original.paddingRight ?? '';
            this.viewportEl.style.paddingTop = original.paddingTop ?? '';
            this.viewportEl.style.paddingBottom = original.paddingBottom ?? '';
        }

        if (this.contentEl && this.originalContentStyles) {
            const original = this.originalContentStyles;
            this.contentEl.style.transform = original.transform ?? '';
            this.contentEl.style.transition = original.transition ?? '';
            this.contentEl.style.position = original.position ?? '';
            this.contentEl.style.top = original.top ?? '';
            this.contentEl.style.right = original.right ?? '';
            this.contentEl.style.bottom = original.bottom ?? '';
            this.contentEl.style.left = original.left ?? '';
            this.contentEl.style.height = original.height ?? '';
            this.contentEl.style.width = original.width ?? '';
            this.contentEl.style.overflow = original.overflow ?? '';
            this.contentEl.style.columnCount = original.columnCount ?? '';
            this.contentEl.style.columnGap = original.columnGap ?? '';
            this.contentEl.style.columnFill = original.columnFill ?? '';
            this.contentEl.style.letterSpacing = original.letterSpacing ?? '';
            this.contentEl.style.wordSpacing = original.wordSpacing ?? '';
            this.contentEl.style.fontSize = original.fontSize ?? '';
            this.contentEl.style.lineHeight = original.lineHeight ?? '';
            this.contentEl.style.breakInside = '';
            this.contentEl.classList.remove('is-justified');
            this.contentEl.style.willChange = '';
            if (this.viewportEl && this.contentEl.parentElement === this.viewportEl) {
                this.viewportEl.removeChild(this.contentEl);
            }
        }
        this.renderedSource = null;
        this.loadedFile = null;
        this.renderedFileVersion = null;

        if (this.originalPreviewEl && this.viewportEl) {
            const targetIndex = this.originalPreviewIndex ?? null;
            const children = Array.from(this.viewportEl.children);
            const insertBefore = targetIndex !== null && targetIndex >= 0 && targetIndex < children.length
                ? children[targetIndex]
                : null;
            if (insertBefore) {
                this.viewportEl.insertBefore(this.originalPreviewEl, insertBefore);
            } else {
                this.viewportEl.appendChild(this.originalPreviewEl);
            }
            this.originalPreviewEl.style.display = '';
            this.originalPreviewEl.style.visibility = '';
            this.originalPreviewEl.style.pointerEvents = '';
        }

        if (this.pageIndicatorEl) {
            this.pageIndicatorEl.remove();
        }
        if (this.viewportEl?.dataset) {
            delete this.viewportEl.dataset.obsidianrIndicatorHeight;
        }
        this.pageIndicatorEl = null;
        this.pageIndicatorHeight = 0;

        this.viewportEl = null;
        this.contentEl = null;
        this.originalViewportStyles = null;
        this.originalContentStyles = null;
        this.originalPreviewEl = null;
        this.originalPreviewIndex = null;
    }

    private schedulePagination(preservePosition: boolean): void {
        if (!this.pagination || !this.viewportEl || !this.contentEl) {
            return;
        }

        this.preservePositionOnFrame = this.preservePositionOnFrame || preservePosition;
        if (this.pendingFrame !== null) {
            return;
        }

        console.debug('[ObsidianR] schedulePagination', {
            preservePosition,
            pendingFrame: this.pendingFrame !== null
        });

        this.pendingFrame = requestAnimationFrame(() => {
            this.pendingFrame = null;
            const preserve = this.preservePositionOnFrame;
            this.preservePositionOnFrame = false;
            console.debug('[ObsidianR] schedulePagination -> rebuild', {
                preserve
            });
            this.rebuildPagination(preserve);
        });
    }

    private rebuildPagination(preservePosition: boolean): void {
        if (!this.pagination || !this.viewportEl || !this.contentEl) {
            return;
        }

        const snapshot = this.state.snapshot;
        const previousContentHeight = this.pagination.getContentHeight() || 1;
        const previousOffset = this.pagination.getOffsetForPage(snapshot.currentPage);
        const progress = previousOffset / previousContentHeight;

        console.debug('[ObsidianR] rebuildPagination: before render', {
            preservePosition,
            previousContentHeight,
            previousOffset,
            progress,
            currentPage: snapshot.currentPage
        });

        const view = this.getActiveMarkdownView();
        if (!view || !view.file) {
            console.warn('[ObsidianR] No active markdown view or file during pagination rebuild');
            return;
        }

        const targetFile = view.file;

        void this.renderActiveFile(view).then((loaded) => {
            if (!loaded || !this.pagination) {
                return;
            }

            if (this.state.snapshot.currentFile && this.state.snapshot.currentFile !== targetFile) {
                console.debug('[ObsidianR] Active file changed during pagination rebuild, aborting render');
                return;
            }

            const stateAfterRender = this.state.snapshot;
            this.pagination.compute(stateAfterRender.parameters);
            const totalPages = this.pagination.getPageCount();

            console.debug('[ObsidianR] pagination computed', {
                file: view.file?.path ?? null,
                totalPages,
                pageHeight: this.pagination.getPageHeight(),
                contentHeight: this.pagination.getContentHeight(),
                offsets: this.pagination.getOffsets()
            });

            let targetPage = 0;
            if (this.pendingInitialPage !== null) {
                if (this.pendingInitialPage === 'last') {
                    targetPage = Math.max(totalPages - 1, 0);
                } else {
                    targetPage = this.pendingInitialPage;
                }
                this.pendingInitialPage = null;
            } else if (preservePosition) {
                const targetOffset = progress * Math.max(1, this.pagination.getContentHeight());
                targetPage = this.pagination.getPageForOffset(targetOffset);
            } else {
                targetPage = Math.min(stateAfterRender.currentPage, Math.max(totalPages - 1, 0));
            }

            const clampedPage = Math.min(Math.max(targetPage, 0), Math.max(totalPages - 1, 0));
            this.state.update({
                totalPages,
                currentPage: clampedPage,
                pageHeight: this.pagination.getPageHeight()
            });

            this.pagination.applyPage(clampedPage);
            this.updatePageIndicator();
        });
    }

    private applyCurrentPage(): void {
        if (!this.pagination) {
            return;
        }
        this.pagination.applyPage(this.state.snapshot.currentPage);
        this.updatePageIndicator();
    }

    private async navigateChapter(direction: 'next' | 'previous'): Promise<void> {
        if (this.chapterNavigationLock) {
            return;
        }

        const catalog = this.plugin.books;
        const currentFile = this.state.snapshot.currentFile;
        if (!catalog || !currentFile) {
            return;
        }

        const { previous, next } = catalog.getChapterNeighbors(currentFile);
        const target = direction === 'next' ? next : previous;
        if (!target) {
            console.debug('[ObsidianR] navigateChapter: no adjacent chapter', {
                direction,
                file: currentFile.path
            });
            return;
        }

        const leaf = this.activeLeaf ?? this.getActiveMarkdownView()?.leaf ?? null;
        if (!leaf) {
            console.warn('[ObsidianR] navigateChapter: no active leaf available', {
                direction,
                target: target.path
            });
            return;
        }

        this.chapterNavigationLock = true;
        this.pendingInitialPage = direction === 'next' ? 0 : 'last';

        try {
            await leaf.openFile(target);
        } catch (error) {
            console.error('[ObsidianR] Failed to open adjacent chapter', {
                direction,
                target: target.path,
                error
            });
            this.pendingInitialPage = null;
        } finally {
            this.chapterNavigationLock = false;
        }
    }

    private async renderActiveFile(view: MarkdownView): Promise<boolean> {
        if (!this.contentEl || !this.viewportEl) {
            return false;
        }

        const file = view.file;
        if (!file) {
            this.contentEl.empty();
            this.renderedSource = null;
            this.loadedFile = null;
            this.renderedFileVersion = null;
            return false;
        }

        const version = file.stat?.mtime ?? null;
        if (this.renderedSource && this.loadedFile === file && this.renderedFileVersion === version) {
            return true;
        }

        try {
            this.flushRenderedContent();
            const raw = await this.plugin.app.vault.cachedRead(file);
            const stripped = this.stripFrontmatter(raw);
            console.debug('[ObsidianR] renderActiveFile: start', {
                file: file.path,
                length: raw.length,
                strippedLength: stripped.length
            });
            this.contentEl.empty();

            const fragment = this.contentEl.ownerDocument.createElement('div');
            fragment.className = 'obsidianr-reader-content';
            this.contentEl.appendChild(fragment);

            await MarkdownRenderer.renderMarkdown(stripped, fragment, file.path, view);

            console.debug('[ObsidianR] renderActiveFile: rendered', {
                file: file.path,
                childCount: fragment.childElementCount,
                textLength: fragment.textContent?.length ?? 0
            });

            this.pagination?.setContentElement(fragment);

            this.cleanupCallbacks.push(() => {
                fragment.remove();
            });

            this.renderedSource = stripped;
            this.loadedFile = file;
            this.renderedFileVersion = version;
            return true;
        } catch (error) {
            console.error('[ObsidianR] Failed to render reader content', error);
            this.contentEl.empty();
            this.contentEl.createEl('p', { text: 'Unable to render this file in reader mode.' });
            this.pagination?.setContentElement(this.contentEl);
            this.renderedSource = null;
            this.loadedFile = null;
            this.renderedFileVersion = null;
            return false;
        }
    }

    private stripFrontmatter(source: string): string {
        const FRONTMATTER_REGEX = /^---\s*\n[\s\S]*?\n---\s*\n/;
        const match = source.match(FRONTMATTER_REGEX);
        if (!match) {
            return source;
        }
        return source.slice(match[0].length);
    }

    private flushRenderedContent(): void {
        while (this.cleanupCallbacks.length > 0) {
            const dispose = this.cleanupCallbacks.pop();
            try {
                dispose?.();
            } catch (error) {
                console.error('[ObsidianR] Failed to cleanup reader content', error);
            }
        }

        if (this.pagination && this.contentEl) {
            this.pagination.setContentElement(this.contentEl);
        }

        this.renderedSource = null;
        this.loadedFile = null;
        this.renderedFileVersion = null;
    }

}

export function createReaderManager(
    plugin: ObsidianRPlugin,
    state: ReaderState
): ReaderManager {
    return new ReaderManager(plugin, state);
}
