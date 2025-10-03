import { EventRef, WorkspaceLeaf, TFile, debounce } from 'obsidian';
import type ObsidianRPlugin from '../../main';
import type { ReaderState, ReaderSessionState } from '../../core/state';
import type { BookInfo } from '../../books';
import { OutlinePanelController } from './outline';
import { BookmarksPanelController, type PageBookmark } from './bookmarks';
import { ReadingStatisticsTracker } from './statistics-tracker';
import { ReaderStatisticsView, STATISTICS_VIEW_TYPE, type StatisticsDisplaySnapshot } from './statistics-view';
import { BookmarkStore } from '../bookmarks';

interface SessionContextPaths {
    bookPath: string | null;
    chapterPath: string | null;
}

export class ReaderPanelManager {
    private outlineController: OutlinePanelController;
    private bookmarksController: BookmarksPanelController;
    private readonly statisticsTracker: ReadingStatisticsTracker;
    private readonly bookmarkStore: BookmarkStore;
    private statisticsViews = new Set<ReaderStatisticsView>();

    private outlineLeaf: WorkspaceLeaf | null = null;
    private outlineManaged = false;
    private bookmarksLeaf: WorkspaceLeaf | null = null;
    private bookmarksManaged = false;
    private statisticsLeaf: WorkspaceLeaf | null = null;
    private statisticsManaged = false;

    private stateChangedRef: EventRef | null = null;
    private interactionRef: EventRef | null = null;
    private layoutChangeRef: EventRef | null = null;

    private active = false;
    private latestContext: SessionContextPaths = { bookPath: null, chapterPath: null };
    private readonly refreshStatistics = debounce(() => this.updateStatistics(), 300);

    constructor(
        private readonly plugin: ObsidianRPlugin,
        private readonly state: ReaderState,
        bookmarkStore: BookmarkStore,
        statisticsTracker: ReadingStatisticsTracker
    ) {
        this.outlineController = new OutlinePanelController(plugin);
        this.bookmarksController = new BookmarksPanelController(plugin);
        this.bookmarkStore = bookmarkStore;
        this.statisticsTracker = statisticsTracker;
    }

    initialize(): void {
        this.plugin.registerView(STATISTICS_VIEW_TYPE, (leaf) => new ReaderStatisticsView(leaf, this.plugin, this));
        this.stateChangedRef = this.state.on('changed', (...args: unknown[]) => {
            const [snapshot, prev] = args as [ReaderSessionState, ReaderSessionState];
            this.handleStateChanged(snapshot, prev);
        });
        this.interactionRef = this.state.on('interaction', (...args: unknown[]) => {
            const [timestamp] = args as [number];
            this.handleInteraction(timestamp);
        });
        this.plugin.register(() => this.dispose());
    }

    dispose(): void {
        if (this.stateChangedRef) {
            this.state.offref(this.stateChangedRef);
            this.stateChangedRef = null;
        }
        if (this.interactionRef) {
            this.state.offref(this.interactionRef);
            this.interactionRef = null;
        }
        this.disablePanels();
        this.statisticsTracker.finalizeCurrentSession(Date.now());
        this.statisticsViews.clear();
    }

    registerStatisticsView(view: ReaderStatisticsView): void {
        this.statisticsViews.add(view);
        view.setStatistics(this.buildStatisticsSnapshot());
    }

    unregisterStatisticsView(view: ReaderStatisticsView): void {
        this.statisticsViews.delete(view);
    }

    isPageBookmarked(file: TFile | null, page: number): boolean {
        if (!file) {
            return false;
        }
        const book = this.resolveCurrentBook(file);
        if (!book) {
            return false;
        }
        return this.bookmarkStore.isBookmarked(book.folder.path, file.path, page);
    }

    toggleBookmark(file: TFile | null, page: number): boolean {
        if (!file) {
            return false;
        }
        const book = this.resolveCurrentBook(file);
        if (!book) {
            return false;
        }
        const result = this.bookmarkStore.toggleBookmark(book.folder.path, file.path, page);
        this.updateBookmarks(this.state.snapshot);
        this.plugin.requestSave();
        return result.added;
    }

    refreshDataAfterReset(): void {
        if (!this.active) {
            this.outlineController.update(null, null);
            this.bookmarksController.update(null, []);
            this.updateStatistics();
            return;
        }
        const snapshot = this.state.snapshot;
        this.updateOutline(snapshot);
        this.updateBookmarks(snapshot);
        this.updateStatistics();
    }

    private handleStateChanged(snapshot: ReaderSessionState, prev: ReaderSessionState): void {
        this.latestContext = this.extractContext(snapshot);

        if (snapshot.active && !prev.active) {
            this.active = true;
            this.statisticsTracker.startOrExtendSession(Date.now(), this.latestContext);
            this.plugin.requestSave();
            void this.enablePanels();
        } else if (!snapshot.active && prev.active) {
            this.statisticsTracker.finalizeCurrentSession(Date.now());
            this.active = false;
            this.disablePanels();
            this.plugin.requestSave();
        } else if (snapshot.active) {
            this.statisticsTracker.updateContext(this.latestContext);
        }

        if (snapshot.active) {
            this.updateOutline(snapshot);
            this.updateBookmarks(snapshot);
            this.refreshStatistics();
        } else {
            this.outlineController.update(null, null);
            this.bookmarksController.update(null, []);
            this.refreshStatistics();
        }
    }

    private handleInteraction(timestamp: number): void {
        if (!this.active) {
            return;
        }
        this.statisticsTracker.startOrExtendSession(timestamp, this.latestContext);
        this.refreshStatistics();
        this.plugin.requestSave();
    }

    private async enablePanels(): Promise<void> {
        const outlineLeaf = await this.ensureBuiltinLeaf('outline');
        if (outlineLeaf) {
            this.outlineLeaf = outlineLeaf.leaf;
            this.outlineManaged = outlineLeaf.managed;
            this.outlineController.attach(outlineLeaf.leaf);
        }

        const bookmarksLeaf = await this.ensureBuiltinLeaf('bookmarks');
        if (bookmarksLeaf) {
            this.bookmarksLeaf = bookmarksLeaf.leaf;
            this.bookmarksManaged = bookmarksLeaf.managed;
            this.bookmarksController.attach(bookmarksLeaf.leaf);
        }

        const statisticsLeaf = await this.ensureStatisticsLeaf();
        if (statisticsLeaf) {
            this.statisticsLeaf = statisticsLeaf.leaf;
            this.statisticsManaged = statisticsLeaf.managed;
        }

        if (!this.layoutChangeRef) {
            this.layoutChangeRef = this.plugin.app.workspace.on('layout-change', () => {
                this.outlineController.sync();
                this.bookmarksController.sync();
            });
        }

        this.updateOutline(this.state.snapshot);
        this.updateBookmarks(this.state.snapshot);
        this.updateStatistics();
    }

    private disablePanels(): void {
        this.outlineController.detach();
        this.bookmarksController.detach();

        if (this.layoutChangeRef) {
            this.plugin.app.workspace.offref(this.layoutChangeRef);
            this.layoutChangeRef = null;
        }

        if (this.outlineManaged && this.outlineLeaf) {
            this.outlineLeaf.detach();
        }
        if (this.bookmarksManaged && this.bookmarksLeaf) {
            this.bookmarksLeaf.detach();
        }
        if (this.statisticsManaged && this.statisticsLeaf) {
            this.statisticsLeaf.detach();
        }

        this.outlineLeaf = null;
        this.bookmarksLeaf = null;
        this.statisticsLeaf = null;
        this.outlineManaged = false;
        this.bookmarksManaged = false;
        this.statisticsManaged = false;
        this.updateStatistics();
    }

    private async ensureBuiltinLeaf(viewType: 'outline' | 'bookmarks'): Promise<{ leaf: WorkspaceLeaf; managed: boolean; } | null> {
        const existing = this.plugin.app.workspace.getLeavesOfType(viewType);
        if (existing.length > 0) {
            return { leaf: existing[0], managed: false };
        }
        let leaf = this.plugin.app.workspace.getRightLeaf(false);
        if (!leaf) {
            leaf = this.plugin.app.workspace.getLeftLeaf(false);
        }
        if (!leaf) {
            leaf = this.plugin.app.workspace.getRightLeaf(true) ?? this.plugin.app.workspace.getLeaf(true);
        }
        if (!leaf) {
            return null;
        }
        await leaf.setViewState({ type: viewType, active: false });
        return { leaf, managed: true };
    }

    private async ensureStatisticsLeaf(): Promise<{ leaf: WorkspaceLeaf; managed: boolean; } | null> {
        const existing = this.plugin.app.workspace.getLeavesOfType(STATISTICS_VIEW_TYPE);
        if (existing.length > 0) {
            return { leaf: existing[0], managed: false };
        }
        let leaf = this.plugin.app.workspace.getLeftLeaf(false);
        if (!leaf) {
            leaf = this.plugin.app.workspace.getRightLeaf(false);
        }
        if (!leaf) {
            leaf = this.plugin.app.workspace.getLeftLeaf(true) ?? this.plugin.app.workspace.getLeaf(true);
        }
        if (!leaf) {
            return null;
        }
        await leaf.setViewState({ type: STATISTICS_VIEW_TYPE, active: false });
        return { leaf, managed: true };
    }

    private updateOutline(snapshot: ReaderSessionState): void {
        const book = this.resolveCurrentBook(snapshot.currentFile ?? null);
        this.outlineController.update(book, snapshot.currentFile ?? null);
    }

    private updateBookmarks(snapshot: ReaderSessionState): void {
        const book = this.resolveCurrentBook(snapshot.currentFile ?? null);
        const bookPath = book?.folder.path ?? null;
        const bookmarks: PageBookmark[] = [];
        if (bookPath) {
            const entries = this.bookmarkStore.getEntriesForBook(bookPath);
            const chapterOrder = new Map<string, number>();
            if (book) {
                book.chapters.forEach((chapter, index) => {
                    chapterOrder.set(chapter.file.path, index);
                });
            }
            entries.sort((a, b) => {
                const aOrder = chapterOrder.get(a.chapterPath) ?? Number.MAX_SAFE_INTEGER;
                const bOrder = chapterOrder.get(b.chapterPath) ?? Number.MAX_SAFE_INTEGER;
                if (aOrder !== bOrder) {
                    return aOrder - bOrder;
                }
                return a.page - b.page;
            });
            for (const entry of entries) {
                const file = this.plugin.app.vault.getAbstractFileByPath(entry.chapterPath);
                if (file instanceof TFile) {
                    bookmarks.push({
                        chapter: file,
                        page: entry.page,
                        note: entry.note
                    });
                }
            }
        }
        this.bookmarksController.update(book?.title ?? null, bookmarks);
    }

    private updateStatistics(): void {
        const snapshot = this.buildStatisticsSnapshot();
        for (const view of this.statisticsViews) {
            view.setStatistics(snapshot);
        }
        this.plugin.requestSave();
    }

    private buildStatisticsSnapshot(): StatisticsDisplaySnapshot {
        const now = Date.now();
        const raw = this.statisticsTracker.getSnapshot(now);
        const goalMs = Math.max(0, this.plugin.settings.dailyGoalMinutes * 60 * 1000);

        const sessionBookTitle = raw.session.bookPath ? this.resolveBookTitle(raw.session.bookPath) : null;
        const sessionChapterTitle = raw.session.chapterPath ? this.resolveChapterTitle(raw.session.chapterPath) : null;
        const sessionCover = raw.session.bookPath ? this.resolveBookCover(raw.session.bookPath) : null;

        const books: Array<{ title: string; totalMs: number; }> = [];
        for (const [path, totalMs] of raw.totals.bookDurations.entries()) {
            books.push({
                title: this.resolveBookTitle(path) ?? this.basenameFromPath(path),
                totalMs
            });
        }
        books.sort((a, b) => b.totalMs - a.totalMs);

        return {
            session: {
                active: raw.session.active,
                durationMs: raw.session.durationMs,
                start: raw.session.start,
                lastInteraction: raw.session.lastInteraction,
                bookTitle: sessionBookTitle,
                chapterTitle: sessionChapterTitle,
                coverSrc: sessionCover
            },
            daily: {
                totalMs: raw.totals.dailyMs,
                goalMs
            },
            weekly: {
                totalMs: raw.totals.weeklyMs,
                goalMs: goalMs * 7
            },
            monthly: {
                totalMs: raw.totals.monthlyMs,
                goalMs: goalMs * 30
            },
            yearly: {
                totalMs: raw.totals.yearlyMs,
                goalMs: goalMs * 365,
                books
            }
        };
    }

    private extractContext(snapshot: ReaderSessionState): SessionContextPaths {
        const book = this.resolveCurrentBook(snapshot.currentFile ?? null);
        return {
            bookPath: book?.folder.path ?? null,
            chapterPath: snapshot.currentFile?.path ?? null
        };
    }

    private resolveCurrentBook(file: TFile | null): BookInfo | null {
        if (!file) {
            return null;
        }
        if (!this.plugin.books) {
            return null;
        }
        const neighbors = this.plugin.books.getChapterNeighbors(file);
        return neighbors.book;
    }

    private resolveBookTitle(bookPath: string): string | null {
        if (!this.plugin.books) {
            return null;
        }
        const books = this.plugin.books.getBooks();
        for (const book of books) {
            if (book.folder.path === bookPath) {
                return book.title;
            }
        }
        return null;
    }

    private resolveBookCover(bookPath: string): string | null {
        if (!this.plugin.books) {
            return null;
        }
        const books = this.plugin.books.getBooks();
        for (const book of books) {
            if (book.folder.path === bookPath && book.cover) {
                return this.plugin.app.vault.getResourcePath(book.cover);
            }
        }
        return null;
    }

    private resolveChapterTitle(chapterPath: string): string | null {
        const file = this.plugin.app.vault.getAbstractFileByPath(chapterPath);
        if (file instanceof TFile) {
            return file.basename;
        }
        return null;
    }

    private basenameFromPath(path: string): string {
        const parts = path.split('/');
        return parts[parts.length - 1] ?? path;
    }
}

export function createPanelManager(
    plugin: ObsidianRPlugin,
    state: ReaderState,
    bookmarkStore: BookmarkStore,
    statisticsTracker: ReadingStatisticsTracker
): ReaderPanelManager {
    const manager = new ReaderPanelManager(plugin, state, bookmarkStore, statisticsTracker);
    manager.initialize();
    return manager;
}
