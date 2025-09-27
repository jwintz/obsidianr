import { MarkdownView, WorkspaceLeaf, Platform } from 'obsidian';
import type ObsidianRPlugin from '../main';
import { ReaderState, ReaderParameters } from '../core/state';

const BODY_CLASS = 'obsidianr-reader';

export class ReaderManager {
    private activeLeaf: WorkspaceLeaf | null = null;

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

        this.activeLeaf = view.leaf;
        document.body.classList.add(BODY_CLASS);
        this.state.update({
            active: true,
            currentFile: view.file ?? null
        });

        this.applyParameters(view, this.state.snapshot.parameters);
        this.attachInteractionHandlers(view);
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
            this.resetStyles(view);
        }

        this.activeLeaf = null;
    }

    refreshCurrentView(): void {
        if (!this.state.snapshot.active) {
            return;
        }

        const view = this.getActiveMarkdownView();
        if (!view) {
            return;
        }

        this.applyParameters(view, this.state.snapshot.parameters);
    }

    updateParameters(partial: Partial<ReaderParameters>): void {
        this.state.updateParameters(partial);
        this.refreshCurrentView();
    }

    onActiveLeafChange(leaf: WorkspaceLeaf | null): void {
        if (!this.state.snapshot.active) {
            return;
        }

        if (!leaf || !(leaf.view instanceof MarkdownView)) {
            this.disableReaderMode();
            return;
        }

        this.activeLeaf = leaf;
        this.state.update({ currentFile: leaf.view.file ?? null });
        this.refreshCurrentView();
    }

    private getActiveMarkdownView(): MarkdownView | null {
        const view = this.plugin.app.workspace.getActiveViewOfType(MarkdownView);
        return view ?? null;
    }

    private applyParameters(view: MarkdownView, parameters: ReaderParameters): void {
        const { contentEl } = view;
        contentEl.toggleClass('is-justified', parameters.justified);
        contentEl.style.setProperty('--obsidianr-font-size', `${parameters.fontSize}px`);
        contentEl.style.setProperty('--obsidianr-line-height', `${parameters.lineSpacing}`);
        contentEl.style.setProperty('--obsidianr-letter-spacing', `${parameters.letterSpacing}em`);
        contentEl.style.setProperty('--obsidianr-word-spacing', `${parameters.wordSpacing}em`);
        contentEl.style.setProperty('--obsidianr-columns', `${parameters.columns}`);
        contentEl.style.setProperty('--obsidianr-horizontal-margin', `${parameters.horizontalMargins}%`);
    }

    private resetStyles(view: MarkdownView): void {
        const { contentEl } = view;
        contentEl.removeClass('is-justified');
        contentEl.style.removeProperty('--obsidianr-font-size');
        contentEl.style.removeProperty('--obsidianr-line-height');
        contentEl.style.removeProperty('--obsidianr-letter-spacing');
        contentEl.style.removeProperty('--obsidianr-word-spacing');
        contentEl.style.removeProperty('--obsidianr-columns');
        contentEl.style.removeProperty('--obsidianr-horizontal-margin');
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
        const next = Math.min(snapshot.totalPages - 1, snapshot.currentPage + 1);
        if (next !== snapshot.currentPage) {
            this.state.update({ currentPage: next });
            this.refreshCurrentView();
        }
    }

    previousPage(): void {
        const snapshot = this.state.snapshot;
        const prev = Math.max(0, snapshot.currentPage - 1);
        if (prev !== snapshot.currentPage) {
            this.state.update({ currentPage: prev });
            this.refreshCurrentView();
        }
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
}

export function createReaderManager(
    plugin: ObsidianRPlugin,
    state: ReaderState
): ReaderManager {
    return new ReaderManager(plugin, state);
}
