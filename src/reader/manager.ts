import { MarkdownView, WorkspaceLeaf, Platform, MarkdownRenderer, TFile, setIcon } from 'obsidian';
import type ObsidianRPlugin from '../main';
import { ReaderState, ReaderParameters } from '../core/state';
import { PaginationEngine } from './pagination';
import type { BookInfo } from '../books';
import { logDebug } from '../core/logger';
import { FONT_CHOICES, normalizeFontFamily } from '../core/fonts';

const BODY_CLASS = 'obsidianr-reader';
const ZEN_BODY_CLASS = 'obsidianr-zen';
const OVERLAY_AUTO_HIDE_MS = 5000;

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
    private pendingLeafResolution: number | null = null;
    private leafResolutionAttempts = 0;
    private chapterPageCounts: Map<string, number> = new Map();
    private chapterPageComputePromises: Map<string, Promise<number | null>> = new Map();
    private overlayEl: HTMLElement | null = null;
    private overlayHideTimeout: number | null = null;
    private overlayHover = false;
    private fontSelectEl: HTMLSelectElement | null = null;
    private zenToggleButtonEl: HTMLButtonElement | null = null;
    private bookmarkToggleButtonEl: HTMLButtonElement | null = null;
    private touchStartX: number | null = null;
    private touchStartY: number | null = null;
    private touchStartTime = 0;
    private handleViewportPointerUp = (event: PointerEvent) => {
        if (!this.state.snapshot.active) {
            return;
        }
        if (this.overlayEl && event.target instanceof Node && this.overlayEl.contains(event.target)) {
            return;
        }
        if (event.pointerType === 'mouse' && event.button !== 0) {
            return;
        }
        this.state.markInteraction();
        if (this.state.snapshot.overlayVisible) {
            this.scheduleOverlayAutoHide();
        } else {
            this.showOverlayControls();
        }
    };

    private handleOverlayPointerEnter = () => {
        this.overlayHover = true;
        this.clearOverlayTimer();
    };

    private handleOverlayPointerLeave = () => {
        this.overlayHover = false;
        if (this.state.snapshot.overlayVisible) {
            this.scheduleOverlayAutoHide();
        }
    };

    private handleOverlayPointerDown = () => {
        this.overlayHover = true;
        this.state.markInteraction();
        this.clearOverlayTimer();
    };

    private handleOverlayFocusIn = () => {
        this.overlayHover = true;
        this.clearOverlayTimer();
    };

    private handleOverlayFocusOut = () => {
        this.overlayHover = false;
        if (this.state.snapshot.overlayVisible) {
            this.scheduleOverlayAutoHide();
        }
    };

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

        this.ensurePreviewMode(view);

        if (!this.setupView(view)) {
            return;
        }

        this.activeLeaf = view.leaf;
        document.body.classList.add(BODY_CLASS);
        this.applyZenModeClass(false);
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
        this.applyZenModeClass(false);
        this.hideOverlayControls(true);

        this.resetHeaderTitle();
        this.clearPendingLeafResolution();

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

        const container = leaf?.view?.containerEl ?? null;
        if (container?.classList.contains('obsidianr-bookmarks-leaf')) {
            return;
        }

        if (container?.querySelector('[data-obsidianr-bookmarks-host="true"]')) {
            return;
        }

        const targetView = this.resolveMarkdownView(leaf);
        if (!targetView) {
            this.deferLeafResolution();
            return;
        }

        this.clearPendingLeafResolution();

        this.ensurePreviewMode(targetView);

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

    private resolveMarkdownView(leaf: WorkspaceLeaf | null): MarkdownView | null {
        if (leaf && leaf.view instanceof MarkdownView) {
            return leaf.view;
        }
        return this.getActiveMarkdownView();
    }

    private deferLeafResolution(): void {
        if (this.pendingLeafResolution !== null) {
            return;
        }
        this.leafResolutionAttempts = 0;
        this.scheduleLeafResolutionAttempt();
    }

    private scheduleLeafResolutionAttempt(): void {
        const delay = Math.min(180, 80 + this.leafResolutionAttempts * 40);
        this.pendingLeafResolution = window.setTimeout(() => {
            this.pendingLeafResolution = null;
            if (!this.state.snapshot.active) {
                return;
            }
            const view = this.getActiveMarkdownView();
            if (view) {
                this.leafResolutionAttempts = 0;
                this.onActiveLeafChange(view.leaf);
                return;
            }

            if (this.chapterNavigationLock || this.pendingInitialPage !== null) {
                this.scheduleLeafResolutionAttempt();
                return;
            }

            this.leafResolutionAttempts += 1;
            if (this.leafResolutionAttempts < 6) {
                this.scheduleLeafResolutionAttempt();
                return;
            }

            this.leafResolutionAttempts = 0;
            this.disableReaderMode();
        }, delay);
    }

    private clearPendingLeafResolution(): void {
        if (this.pendingLeafResolution !== null) {
            window.clearTimeout(this.pendingLeafResolution);
            this.pendingLeafResolution = null;
        }
        this.leafResolutionAttempts = 0;
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
        const normalizedFont = normalizeFontFamily(parameters.fontFamily);

        target.style.fontSize = `${parameters.fontSize}px`;
        target.style.lineHeight = `${parameters.lineSpacing}`;
        target.style.letterSpacing = `${parameters.letterSpacing}em`;
        target.style.wordSpacing = `${parameters.wordSpacing}em`;
        target.style.fontFamily = normalizedFont;
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
        this.viewportEl.style.setProperty('--obsidianr-indicator-height', `${indicatorHeight}px`);

        if (this.pageIndicatorEl) {
            const desiredHeight = this.computePageIndicatorHeight(this.viewportEl);
            if (Math.abs(desiredHeight - this.pageIndicatorHeight) > 0.5) {
                this.pageIndicatorHeight = desiredHeight;
                this.pageIndicatorEl.style.height = `${desiredHeight}px`;
                if (this.contentEl) {
                    this.contentEl.style.bottom = `${desiredHeight}px`;
                }
                this.viewportEl.dataset.obsidianrIndicatorHeight = `${desiredHeight}`;
                this.viewportEl.style.paddingBottom = `${verticalPadding + desiredHeight}px`;
                this.viewportEl.style.setProperty('--obsidianr-indicator-height', `${desiredHeight}px`);
            }
        }

        this.syncOverlayControls();
    }

    private computePageIndicatorHeight(viewport: HTMLElement): number {
        const doc = viewport.ownerDocument ?? document;
        const profile = doc.querySelector<HTMLElement>('.workspace-sidedock-vault-profile');
        const profileHeight = profile ? Math.round(profile.getBoundingClientRect().height) : 0;
        const leafHeader = viewport.closest('.workspace-leaf')?.querySelector<HTMLElement>('.view-header-title-container');
        const header = leafHeader ?? doc.querySelector<HTMLElement>('.view-header-title-container');
        const headerHeight = header?.offsetHeight ?? header?.clientHeight ?? 0;
        const observed = profileHeight || headerHeight;
        const indicator = Math.max(24, Math.round(observed || 0));
        return Number.isFinite(indicator) ? indicator : 32;
    }

    private updatePageIndicator(): void {
        if (!this.pageIndicatorEl) {
            return;
        }
        const snapshot = this.state.snapshot;
        const { current, total } = this.computeGlobalPageProgress(
            snapshot.currentFile,
            snapshot.currentPage,
            snapshot.totalPages
        );

        if (!Number.isFinite(current) || current <= 0) {
            this.pageIndicatorEl.textContent = '';
            this.pageIndicatorEl.classList.remove('is-visible');
        } else {
            const hasTotal = Number.isFinite(total) && total > 0;
            if (snapshot.overlayVisible && hasTotal) {
                this.pageIndicatorEl.textContent = `Page ${current} / ${total}`;
            } else {
                this.pageIndicatorEl.textContent = `Page ${current}`;
            }
            this.pageIndicatorEl.classList.add('is-visible');
        }

        if (snapshot.currentFile && this.plugin.books) {
            const neighbors = this.plugin.books.getChapterNeighbors(snapshot.currentFile);
            if (neighbors.book) {
                this.ensureBookPageCounts(neighbors.book);
            }
        }

        if (snapshot.overlayVisible) {
            this.updateHeaderPagesLeft(snapshot.totalPages, snapshot.currentPage);
        } else {
            this.resetHeaderTitle();
        }
    }

    private createOverlay(viewport: HTMLElement): void {
        if (this.overlayEl) {
            return;
        }

        const doc = viewport.ownerDocument ?? document;
        const overlay = doc.createElement('div');
        overlay.classList.add('obsidianr-reader-overlay');
        overlay.setAttribute('role', 'toolbar');
        overlay.setAttribute('aria-hidden', 'true');

        const navigationGroup = doc.createElement('div');
        navigationGroup.classList.add('obsidianr-overlay-group');
        navigationGroup.appendChild(this.createOverlayButton(doc, 'chevron-left', 'Previous page', () => this.previousPage()));
        navigationGroup.appendChild(this.createOverlayButton(doc, 'chevron-right', 'Next page', () => this.nextPage()));
        overlay.appendChild(navigationGroup);

        const typographyGroup = doc.createElement('div');
        typographyGroup.classList.add('obsidianr-overlay-group');
        typographyGroup.appendChild(this.createOverlayButton(doc, 'a-arrow-down', 'Decrease font size', () => this.decreaseFont()));
        typographyGroup.appendChild(this.createOverlayButton(doc, 'a-arrow-up', 'Increase font size', () => this.increaseFont()));

        const selectWrapper = doc.createElement('div');
        selectWrapper.classList.add('obsidianr-overlay-select-wrapper');
        const select = doc.createElement('select');
        select.classList.add('obsidianr-overlay-select');
        select.setAttribute('aria-label', 'Font family');
        for (const option of FONT_CHOICES) {
            const optionEl = doc.createElement('option');
            optionEl.value = option.value;
            optionEl.textContent = option.label;
            select.appendChild(optionEl);
        }
        const currentFont = normalizeFontFamily(this.state.snapshot.parameters.fontFamily);
        if (!FONT_CHOICES.some((option) => option.value === currentFont)) {
            const customOption = doc.createElement('option');
            customOption.value = currentFont;
            customOption.textContent = currentFont;
            select.appendChild(customOption);
        }
        select.value = currentFont;
        select.addEventListener('change', (event) => {
            event.stopPropagation();
            const value = (event.target as HTMLSelectElement).value;
            this.updateFontFamily(value);
            this.scheduleOverlayAutoHide();
        });
        select.addEventListener('pointerdown', (event) => {
            event.stopPropagation();
        });
        select.addEventListener('touchstart', (event) => {
            event.stopPropagation();
        });
        selectWrapper.appendChild(select);
        typographyGroup.appendChild(selectWrapper);
        overlay.appendChild(typographyGroup);
        this.fontSelectEl = select;

        const bookmarkGroup = doc.createElement('div');
        bookmarkGroup.classList.add('obsidianr-overlay-group');
        const bookmarkButton = this.createOverlayButton(doc, 'bookmark', 'Toggle bookmark for current page', () => {
            this.toggleBookmark();
        });
        bookmarkButton.classList.add('obsidianr-overlay-toggle');
        bookmarkGroup.appendChild(bookmarkButton);
        overlay.appendChild(bookmarkGroup);
        this.bookmarkToggleButtonEl = bookmarkButton;

        const zenGroup = doc.createElement('div');
        zenGroup.classList.add('obsidianr-overlay-group');
        const zenButton = this.createOverlayButton(doc, 'eye', 'Toggle zen mode', () => {
            this.toggleZenMode();
        });
        zenButton.classList.add('obsidianr-overlay-toggle');
        zenGroup.appendChild(zenButton);
        overlay.appendChild(zenGroup);
        this.zenToggleButtonEl = zenButton;

        viewport.appendChild(overlay);
        this.overlayEl = overlay;

        overlay.addEventListener('pointerenter', this.handleOverlayPointerEnter);
        overlay.addEventListener('pointerleave', this.handleOverlayPointerLeave);
        overlay.addEventListener('pointerdown', this.handleOverlayPointerDown);
        overlay.addEventListener('focusin', this.handleOverlayFocusIn);
        overlay.addEventListener('focusout', this.handleOverlayFocusOut);

        this.syncOverlayControls();
    }

    private createOverlayButton(doc: Document, icon: string, label: string, action: () => void): HTMLButtonElement {
        const button = doc.createElement('button');
        button.type = 'button';
        button.classList.add('obsidianr-overlay-button');
        button.setAttribute('aria-label', label);
        button.title = label;
        setIcon(button, icon);
        button.addEventListener('pointerdown', (event) => {
            event.stopPropagation();
        });
        button.addEventListener('click', (event) => {
            event.preventDefault();
            event.stopPropagation();
            this.state.markInteraction();
            action();
            this.scheduleOverlayAutoHide();
        });
        return button;
    }

    private destroyOverlay(): void {
        this.hideOverlayControls(true);
        this.clearOverlayTimer();
        this.overlayHover = false;
        if (!this.overlayEl) {
            this.fontSelectEl = null;
            this.zenToggleButtonEl = null;
            return;
        }

        this.overlayEl.removeEventListener('pointerenter', this.handleOverlayPointerEnter);
        this.overlayEl.removeEventListener('pointerleave', this.handleOverlayPointerLeave);
        this.overlayEl.removeEventListener('pointerdown', this.handleOverlayPointerDown);
        this.overlayEl.removeEventListener('focusin', this.handleOverlayFocusIn);
        this.overlayEl.removeEventListener('focusout', this.handleOverlayFocusOut);
        this.overlayEl.remove();
        this.overlayEl = null;
        this.fontSelectEl = null;
        this.zenToggleButtonEl = null;
        this.bookmarkToggleButtonEl = null;
    }

    private showOverlayControls(): void {
        if (!this.overlayEl) {
            return;
        }
        this.state.markInteraction();
        this.overlayEl.classList.add('is-visible');
        this.overlayEl.setAttribute('aria-hidden', 'false');
        this.overlayHover = false;
        if (!this.state.snapshot.overlayVisible) {
            this.state.update({ overlayVisible: true });
        }
        this.updatePageIndicator();
        this.scheduleOverlayAutoHide();
    }

    private hideOverlayControls(skipStateUpdate = false): void {
        if (!this.overlayEl) {
            return;
        }
        this.overlayHover = false;
        this.overlayEl.classList.remove('is-visible');
        this.overlayEl.setAttribute('aria-hidden', 'true');
        this.clearOverlayTimer();
        if (!skipStateUpdate && this.state.snapshot.overlayVisible) {
            this.state.update({ overlayVisible: false });
        }
        this.updatePageIndicator();
    }

    private scheduleOverlayAutoHide(): void {
        if (!this.overlayEl) {
            return;
        }
        this.clearOverlayTimer();
        this.overlayHideTimeout = window.setTimeout(() => {
            if (!this.overlayEl) {
                return;
            }
            if (this.overlayHover) {
                this.scheduleOverlayAutoHide();
                return;
            }
            this.hideOverlayControls();
        }, OVERLAY_AUTO_HIDE_MS);
    }

    private clearOverlayTimer(): void {
        if (this.overlayHideTimeout !== null) {
            window.clearTimeout(this.overlayHideTimeout);
            this.overlayHideTimeout = null;
        }
    }

    private syncOverlayControls(): void {
        const snapshot = this.state.snapshot;
        if (this.fontSelectEl) {
            const desired = normalizeFontFamily(snapshot.parameters.fontFamily);
            const exists = Array.from(this.fontSelectEl.options).some((option) => option.value === desired);
            if (!exists) {
                const optionEl = this.fontSelectEl.ownerDocument.createElement('option');
                optionEl.value = desired;
                optionEl.textContent = desired;
                this.fontSelectEl.appendChild(optionEl);
            }
            if (this.fontSelectEl.value !== desired) {
                this.fontSelectEl.value = desired;
            }
        }
        if (this.zenToggleButtonEl) {
            const zenEnabled = snapshot.zenMode;
            this.zenToggleButtonEl.classList.toggle('is-active', zenEnabled);
            this.zenToggleButtonEl.setAttribute('aria-pressed', zenEnabled ? 'true' : 'false');
        }
        if (this.bookmarkToggleButtonEl) {
            const bookmarked = this.plugin.isPageBookmarked(snapshot.currentFile ?? null, snapshot.currentPage);
            this.bookmarkToggleButtonEl.classList.toggle('is-active', bookmarked);
            this.bookmarkToggleButtonEl.setAttribute('aria-pressed', bookmarked ? 'true' : 'false');
        }
    }

    private toggleZenMode(): void {
        this.setZenMode(!this.state.snapshot.zenMode);
        if (this.state.snapshot.overlayVisible) {
            this.scheduleOverlayAutoHide();
        }
    }

    private toggleBookmark(): void {
        const snapshot = this.state.snapshot;
        if (!snapshot.currentFile) {
            return;
        }
        this.state.markInteraction();
        const isActive = this.plugin.toggleBookmarkFor(snapshot.currentFile, snapshot.currentPage);
        if (this.bookmarkToggleButtonEl) {
            this.bookmarkToggleButtonEl.classList.toggle('is-active', isActive);
            this.bookmarkToggleButtonEl.setAttribute('aria-pressed', isActive ? 'true' : 'false');
        }
        if (this.state.snapshot.overlayVisible) {
            this.scheduleOverlayAutoHide();
        }
    }

    private setZenMode(enabled: boolean): void {
        if (this.state.snapshot.zenMode !== enabled) {
            this.state.update({ zenMode: enabled });
        }
        this.applyZenModeClass(enabled);
        this.syncOverlayControls();
    }

    private applyZenModeClass(enabled: boolean): void {
        document.body.classList.toggle(ZEN_BODY_CLASS, enabled);
    }

    private updateFontFamily(fontFamily: string): void {
        const normalized = normalizeFontFamily(fontFamily);
        if (this.state.snapshot.parameters.fontFamily === normalized) {
            return;
        }
        this.state.markInteraction();
        if (this.plugin.settings.fontFamily !== normalized) {
            this.plugin.settings.fontFamily = normalized;
            void this.plugin.saveSettings();
        }
        this.updateParameters({ fontFamily: normalized });
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

    private handleTouchStart(event: TouchEvent): void {
        if (!this.state.snapshot.active || event.touches.length !== 1) {
            return;
        }
        const touch = event.touches[0];
        this.touchStartX = touch.clientX;
        this.touchStartY = touch.clientY;
        this.touchStartTime = event.timeStamp;
        this.state.markInteraction();
        this.showOverlayControls();
    }

    private handleTouchEnd(event: TouchEvent): void {
        if (!this.state.snapshot.active || event.changedTouches.length === 0) {
            return;
        }
        const touch = event.changedTouches[0];
        const startX = this.touchStartX ?? touch.clientX;
        const startY = this.touchStartY ?? touch.clientY;
        const dx = touch.clientX - startX;
        const dy = touch.clientY - startY;
        const dt = event.timeStamp - this.touchStartTime;
        const absDx = Math.abs(dx);
        const absDy = Math.abs(dy);
        const threshold = this.viewportEl ? Math.max(45, this.viewportEl.clientWidth * 0.08) : 45;

        if (dt < 600 && absDx > threshold && absDx > absDy * 1.2) {
            if (dx < 0) {
                this.nextPage();
            } else {
                this.previousPage();
            }
        }

        this.touchStartX = null;
        this.touchStartY = null;
        this.touchStartTime = 0;
        this.scheduleOverlayAutoHide();
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
            if (this.hasGlobalPreviousPage()) {
                void this.navigateChapter('previous');
            }
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
            container.style.bottom = `${this.pageIndicatorHeight}px`;
            viewport.dataset.obsidianrIndicatorHeight = `${this.pageIndicatorHeight}`;
            viewport.style.setProperty('--obsidianr-indicator-height', `${this.pageIndicatorHeight}px`);
            this.updatePageIndicator();

            this.createOverlay(viewport);
            container.addEventListener('pointerup', this.handleViewportPointerUp);

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

        if (this.contentEl) {
            this.contentEl.removeEventListener('pointerup', this.handleViewportPointerUp);
        }

        if (this.viewportEl && this.originalViewportStyles) {
            const original = this.originalViewportStyles;
            this.viewportEl.style.overflow = original.overflow ?? '';
            this.viewportEl.style.position = original.position ?? '';
            this.viewportEl.style.paddingLeft = original.paddingLeft ?? '';
            this.viewportEl.style.paddingRight = original.paddingRight ?? '';
            this.viewportEl.style.paddingTop = original.paddingTop ?? '';
            this.viewportEl.style.paddingBottom = original.paddingBottom ?? '';
            this.viewportEl.style.removeProperty('--obsidianr-indicator-height');
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

        this.destroyOverlay();

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

        logDebug('schedulePagination', {
            preservePosition,
            pendingFrame: this.pendingFrame !== null
        });

        this.pendingFrame = requestAnimationFrame(() => {
            this.pendingFrame = null;
            const preserve = this.preservePositionOnFrame;
            this.preservePositionOnFrame = false;
            logDebug('schedulePagination -> rebuild', {
                preserve
            });
            this.rebuildPagination(preserve);
        });
    }

    async openChapter(target: TFile, page: number | 'last' = 0): Promise<void> {
        if (!target) {
            return;
        }

        this.state.markInteraction();
        const leaf = this.activeLeaf ?? this.getActiveMarkdownView()?.leaf ?? null;
        const desiredPage = page;

        const applyInPlace = (pageIndex: number): void => {
            const snapshot = this.state.snapshot;
            const total = Math.max(1, snapshot.totalPages);
            const clamped = Math.min(Math.max(pageIndex, 0), total - 1);
            if (clamped !== snapshot.currentPage) {
                this.state.update({ currentPage: clamped });
                this.applyCurrentPage();
            }
        };

        const currentFile = this.state.snapshot.currentFile;
        if (currentFile && currentFile.path === target.path) {
            if (desiredPage === 'last') {
                applyInPlace(Math.max(this.state.snapshot.totalPages - 1, 0));
            } else {
                applyInPlace(Math.round(desiredPage));
            }
            this.pendingInitialPage = null;
            return;
        }

        const pendingPage = desiredPage === 'last'
            ? 'last'
            : Math.max(0, Math.round(typeof desiredPage === 'number' ? desiredPage : 0));

        this.pendingInitialPage = pendingPage;

        if (!leaf) {
            await this.plugin.app.workspace.getLeaf(false)?.openFile(target, { active: true });
            return;
        }

        if (this.chapterNavigationLock) {
            return;
        }

        this.chapterNavigationLock = true;
        try {
            await leaf.openFile(target, { active: true });
        } catch (error) {
            console.error('[ObsidianR] Failed to open requested chapter', {
                target: target.path,
                error
            });
            this.pendingInitialPage = null;
        } finally {
            this.chapterNavigationLock = false;
        }
    }

    private rebuildPagination(preservePosition: boolean): void {
        if (!this.pagination || !this.viewportEl || !this.contentEl) {
            return;
        }

        const snapshot = this.state.snapshot;
        const previousContentHeight = this.pagination.getContentHeight() || 1;
        const previousOffset = this.pagination.getOffsetForPage(snapshot.currentPage);
        const progress = previousOffset / previousContentHeight;

        logDebug('rebuildPagination: before render', {
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
                logDebug('Active file changed during pagination rebuild, aborting render');
                return;
            }

            const stateAfterRender = this.state.snapshot;
            this.pagination.compute(stateAfterRender.parameters);
            const totalPages = this.pagination.getPageCount();

            let stableTotalPages = totalPages;
            if (targetFile) {
                stableTotalPages = this.registerChapterPageCount(targetFile, totalPages);
                const neighbors = this.plugin.books.getChapterNeighbors(targetFile);
                if (neighbors.book) {
                    this.ensureBookPageCounts(neighbors.book);
                }
            }

            logDebug('pagination computed', {
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

            const clampedPage = Math.min(Math.max(targetPage, 0), Math.max(stableTotalPages - 1, 0));
            this.state.update({
                totalPages: stableTotalPages,
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
        this.syncOverlayControls();
    }

    private hasGlobalPreviousPage(): boolean {
        const snapshot = this.state.snapshot;
        if (!snapshot.currentFile) {
            return snapshot.currentPage > 0;
        }

        const catalog = this.plugin.books;
        if (!catalog) {
            return snapshot.currentPage > 0;
        }

        const neighbors = catalog.getChapterNeighbors(snapshot.currentFile);
        if (neighbors.book) {
            const firstChapter = neighbors.book.chapters[0]?.file.path;
            if (firstChapter && firstChapter === snapshot.currentFile.path && snapshot.currentPage <= 0) {
                return false;
            }
        }

        if (snapshot.currentPage > 0) {
            return true;
        }

        return Boolean(neighbors.previous);
    }

    private ensurePreviewMode(view: MarkdownView): void {
        try {
            const getMode = typeof view.getMode === 'function' ? view.getMode.bind(view) : null;
            if (getMode && getMode() === 'preview') {
                return;
            }

            const setMode = (view as unknown as { setMode?: (mode: unknown) => void; modes?: { preview?: unknown; }; }).setMode;
            const previewMode = (view as unknown as { modes?: { preview?: unknown; }; }).modes?.preview;
            if (setMode && previewMode) {
                setMode.call(view, previewMode);
                return;
            }

            const leaf = view.leaf;
            if (leaf && typeof leaf.getViewState === 'function' && typeof leaf.setViewState === 'function') {
                const currentState = leaf.getViewState();
                const nextState = {
                    ...currentState,
                    state: {
                        ...(currentState.state ?? {}),
                        mode: 'preview'
                    }
                };
                void leaf.setViewState(nextState);
            }
        } catch (error) {
            console.warn('[ObsidianR] Failed to enforce preview mode', error);
        }
    }

    private registerChapterPageCount(file: TFile, totalPages: number): number {
        if (!file || !Number.isFinite(totalPages) || totalPages <= 0) {
            const existing = file ? this.chapterPageCounts.get(file.path) : undefined;
            return existing ?? Math.max(1, Math.round(totalPages) || 1);
        }
        const normalized = Math.max(1, Math.round(totalPages));
        this.chapterPageCounts.set(file.path, normalized);
        return normalized;
    }

    private ensureBookPageCounts(book: BookInfo): void {
        if (!this.viewportEl) {
            return;
        }

        for (const chapter of book.chapters) {
            const path = chapter.file.path;
            if (this.chapterPageCounts.has(path) || this.chapterPageComputePromises.has(path)) {
                continue;
            }

            const promise = this.computeChapterPageCount(chapter.file)
                .then((count) => {
                    if (typeof count === 'number' && count > 0) {
                        const normalized = Math.max(1, Math.round(count));
                        this.chapterPageCounts.set(path, normalized);
                        this.updatePageIndicator();
                    }
                    return count;
                })
                .catch((error) => {
                    console.error('[ObsidianR] Failed to precompute chapter pages', {
                        path,
                        error
                    });
                    return null;
                })
                .finally(() => {
                    this.chapterPageComputePromises.delete(path);
                });

            this.chapterPageComputePromises.set(path, promise);
        }
    }

    private async computeChapterPageCount(file: TFile): Promise<number | null> {
        if (!this.viewportEl) {
            return null;
        }

        const width = Math.max(this.viewportEl.clientWidth, 1);
        const height = Math.max(this.viewportEl.clientHeight, 1);
        const doc = this.viewportEl.ownerDocument ?? document;
        const tempViewport = doc.createElement('div');
        tempViewport.className = 'markdown-reading-view obsidianr-reader-probe';
        tempViewport.style.position = 'fixed';
        tempViewport.style.visibility = 'hidden';
        tempViewport.style.pointerEvents = 'none';
        tempViewport.style.left = '0';
        tempViewport.style.top = '0';
        tempViewport.style.width = `${width}px`;
        tempViewport.style.height = `${height}px`;
        tempViewport.style.overflow = 'hidden';
        if (this.pageIndicatorHeight > 0) {
            tempViewport.dataset.obsidianrIndicatorHeight = `${this.pageIndicatorHeight}`;
        }

        const container = doc.createElement('div');
        container.classList.add('obsidianr-reader-container', 'markdown-preview-view', 'markdown-rendered');
        container.style.position = 'absolute';
        container.style.top = '0';
        container.style.right = '0';
        container.style.bottom = '0';
        container.style.left = '0';
        container.style.width = '100%';
        container.style.height = '100%';
        container.style.overflow = 'hidden';
        tempViewport.appendChild(container);

        const fragment = doc.createElement('div');
        fragment.className = 'obsidianr-reader-content';
        container.appendChild(fragment);

        doc.body.appendChild(tempViewport);

        let engine: PaginationEngine | null = null;

        try {
            const raw = await this.plugin.app.vault.cachedRead(file);
            const stripped = this.stripFrontmatter(raw);
            await MarkdownRenderer.renderMarkdown(stripped, fragment, file.path, this.plugin);

            engine = new PaginationEngine(tempViewport, fragment);
            const snapshot = engine.compute(this.state.snapshot.parameters);
            return snapshot.offsets.length;
        } catch (error) {
            console.error('[ObsidianR] Failed to measure chapter pages', {
                path: file.path,
                error
            });
            return null;
        } finally {
            try {
                engine?.destroy();
            } catch (disposeError) {
                console.warn('[ObsidianR] Failed to dispose pagination probe', disposeError);
            }
            tempViewport.remove();
        }
    }

    private computeGlobalPageProgress(
        file: TFile | null,
        currentPageIndex: number,
        fallbackTotal: number
    ): { current: number; total: number; } {
        const defaultCurrent = Math.max(1, currentPageIndex + 1);
        const defaultTotal = Math.max(defaultCurrent, fallbackTotal);

        if (!file) {
            return { current: defaultCurrent, total: defaultTotal };
        }

        const catalog = this.plugin.books;
        if (!catalog) {
            return { current: defaultCurrent, total: defaultTotal };
        }

        const { book } = catalog.getChapterNeighbors(file);
        if (!book) {
            return { current: defaultCurrent, total: defaultTotal };
        }

        let total = 0;
        let current = defaultCurrent;
        let currentIncluded = false;

        for (const chapter of book.chapters) {
            const path = chapter.file.path;
            if (path === file.path) {
                const chapterPages = this.chapterPageCounts.get(path) ?? fallbackTotal;
                const safePages = Math.max(1, chapterPages);
                current = total + Math.min(defaultCurrent, safePages);
                total += safePages;
                currentIncluded = true;
            } else {
                const chapterPages = this.chapterPageCounts.get(path);
                if (typeof chapterPages === 'number' && chapterPages > 0) {
                    total += chapterPages;
                }
            }
        }

        if (!currentIncluded) {
            total += fallbackTotal > 0 ? fallbackTotal : defaultCurrent;
        }

        const safeTotal = Math.max(total, defaultTotal);
        const safeCurrent = Math.min(Math.max(1, current), safeTotal);
        return { current: safeCurrent, total: safeTotal };
    }

    private updateHeaderPagesLeft(totalPages: number, currentPage: number): void {
        const titleEl = this.getHeaderTitleElement();
        if (!titleEl) {
            return;
        }

        const leaf = this.activeLeaf ?? this.getActiveMarkdownView()?.leaf ?? null;
        const baseTitle = leaf?.getDisplayText?.() ?? titleEl.dataset.obsidianrBaseTitle ?? titleEl.textContent ?? '';
        titleEl.dataset.obsidianrBaseTitle = baseTitle;

        const pagesLeft = Math.max(0, totalPages - currentPage - 1);
        const suffix = ` - ${pagesLeft} page${pagesLeft === 1 ? '' : 's'} left in chapter`;
        titleEl.textContent = `${baseTitle}${suffix}`;
    }

    private resetHeaderTitle(): void {
        const titleEl = this.getHeaderTitleElement();
        if (!titleEl) {
            return;
        }
        const baseTitle = titleEl.dataset.obsidianrBaseTitle ?? titleEl.textContent ?? '';
        titleEl.textContent = baseTitle;
        delete titleEl.dataset.obsidianrBaseTitle;
    }

    private getHeaderTitleElement(): HTMLElement | null {
        const leaf = this.activeLeaf ?? this.getActiveMarkdownView()?.leaf ?? null;
        const container = leaf?.view?.containerEl ?? this.viewportEl?.closest('.workspace-leaf') ?? null;
        if (!container) {
            return null;
        }
        return container.querySelector<HTMLElement>('.view-header-title');
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
            logDebug('navigateChapter: no adjacent chapter', {
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
            logDebug('renderActiveFile: start', {
                file: file.path,
                length: raw.length,
                strippedLength: stripped.length
            });
            this.contentEl.empty();

            const fragment = this.contentEl.ownerDocument.createElement('div');
            fragment.className = 'obsidianr-reader-content';
            this.contentEl.appendChild(fragment);

            await MarkdownRenderer.renderMarkdown(stripped, fragment, file.path, view);

            logDebug('renderActiveFile: rendered', {
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
