import { EventRef, WorkspaceLeaf, TFile, TFolder, debounce } from 'obsidian';
import type ObsidianRPlugin from '../../main';
import type { ReaderState, ReaderSessionState } from '../../core/state';
import type { BookInfo } from '../../books';
import { OutlinePanelController } from './outline';
import { BookmarksPanelController, type PageBookmark } from './bookmarks';
import { ReadingStatisticsTracker, type SessionDurationRecord, type RawStatisticsSnapshot } from './statistics-tracker';
import { ReaderStatisticsView, STATISTICS_VIEW_TYPE, type StatisticsDisplaySnapshot } from './statistics-view';
import { BookmarkStore } from '../bookmarks';

const DAY_MS = 24 * 60 * 60 * 1000;

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

        const streaks = this.computeStreaks(raw.analytics.dailyTotals, raw.analytics.weeklyTotals, now);
        const trend = this.computeSessionTrend(
            raw.analytics.sessionDurations,
            raw.analytics.totalSessionDuration,
            raw.analytics.totalSessionCount,
            now,
            raw.session
        );
        const peakHours = this.computePeakHours(raw.analytics.peakHours);

        const allTimeBooks: Array<{
            path: string;
            title: string;
            coverSrc: string | null;
            totalMs: number;
            sessionCount: number;
            averageSessionMs: number;
            lastRead: number | null;
            firstRead: number | null;
            share: number;
            status: 'not-started' | 'in-progress' | 'completed';
            chaptersVisited: number;
            totalChapters: number;
            completionPercent: number;
            chaptersRemaining: number;
            timeToCompleteMs: number | null;
        }> = [];

        let allTimeTotal = 0;
        for (const [, aggregate] of raw.totals.bookTotals.entries()) {
            allTimeTotal += aggregate.totalMs;
        }

        for (const [path, aggregate] of raw.totals.bookTotals.entries()) {
            const totalMs = aggregate.totalMs;
            const sessionCount = aggregate.sessionCount;
            const averageSessionMs = sessionCount > 0 ? totalMs / sessionCount : 0;
            const progress = raw.analytics.chapterProgress.get(path) ?? null;
            const bookInfo = this.resolveBookByPath(path);
            const totalChapters = bookInfo?.chapters.length ?? 0;
            let chaptersVisited = 0;
            let earliestVisit: number | null = null;
            let latestVisit: number | null = null;
            if (progress) {
                for (const aggregateVisit of progress.values()) {
                    if (aggregateVisit.lastSeen > 0) {
                        chaptersVisited += 1;
                        earliestVisit = earliestVisit == null ? aggregateVisit.firstSeen : Math.min(earliestVisit, aggregateVisit.firstSeen);
                        latestVisit = latestVisit == null ? aggregateVisit.lastSeen : Math.max(latestVisit, aggregateVisit.lastSeen);
                    }
                }
            }

            let status: 'not-started' | 'in-progress' | 'completed';
            if (totalChapters > 0) {
                if (chaptersVisited === 0) {
                    status = 'not-started';
                } else if (chaptersVisited >= totalChapters) {
                    status = 'completed';
                } else {
                    status = 'in-progress';
                }
            } else {
                status = totalMs > 0 ? 'in-progress' : 'not-started';
            }

            const completionPercent = totalChapters > 0
                ? Math.min(1, chaptersVisited / Math.max(1, totalChapters))
                : (totalMs > 0 ? 1 : 0);
            const chaptersRemaining = totalChapters > 0 ? Math.max(0, totalChapters - chaptersVisited) : 0;
            const timeToCompleteMs = status === 'completed' && earliestVisit != null && latestVisit != null
                ? Math.max(0, latestVisit - earliestVisit)
                : null;

            allTimeBooks.push({
                path,
                title: this.resolveBookTitle(path) ?? this.basenameFromPath(path),
                coverSrc: this.resolveBookCover(path),
                totalMs,
                sessionCount,
                averageSessionMs,
                lastRead: aggregate.lastRead ?? null,
                firstRead: aggregate.firstRead ?? null,
                share: allTimeTotal > 0 ? totalMs / allTimeTotal : 0,
                status,
                chaptersVisited,
                totalChapters,
                completionPercent,
                chaptersRemaining,
                timeToCompleteMs
            });
        }
        allTimeBooks.sort((a, b) => b.totalMs - a.totalMs);

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
            },
            allTime: {
                totalMs: allTimeTotal,
                books: allTimeBooks
            },
            streaks,
            trend,
            peakHours
        };
    }

    private computeStreaks(
        dailyTotals: Map<string, number>,
        weeklyTotals: Map<string, number>,
        now: number
    ): { daily: { current: number; best: number; }; weekly: { current: number; best: number; }; } {
        const dailyActive = new Set<number>();
        for (const [dayKey, total] of dailyTotals.entries()) {
            if (total > 0) {
                const idx = this.dayIndexFromKey(dayKey);
                if (idx != null) {
                    dailyActive.add(idx);
                }
            }
        }

        const todayIndex = this.dayIndexFromTimestamp(now);
        let currentDaily = 0;
        let cursor = todayIndex;
        while (dailyActive.has(cursor)) {
            currentDaily += 1;
            cursor -= 1;
        }

        let bestDaily = 0;
        let prevDay = Number.NaN;
        let run = 0;
        const orderedDays = Array.from(dailyActive).sort((a, b) => a - b);
        for (const index of orderedDays) {
            if (!Number.isNaN(prevDay) && index === prevDay + 1) {
                run += 1;
            } else {
                run = 1;
            }
            if (run > bestDaily) {
                bestDaily = run;
            }
            prevDay = index;
        }

        const weeklyActive = new Set<number>();
        for (const [weekKey, total] of weeklyTotals.entries()) {
            if (total > 0) {
                const idx = this.isoWeekIndexFromKey(weekKey);
                if (idx != null) {
                    weeklyActive.add(idx);
                }
            }
        }

        const currentWeekParts = this.isoWeekFromTimestamp(now);
        let currentWeekly = 0;
        let weekCursor = { ...currentWeekParts };
        while (weeklyActive.has(this.isoWeekIndex(weekCursor.year, weekCursor.week))) {
            currentWeekly += 1;
            weekCursor = this.previousIsoWeek(weekCursor.year, weekCursor.week);
        }

        let bestWeekly = 0;
        let prevIndex = Number.NaN;
        run = 0;
        const orderedWeeks = Array.from(weeklyActive).sort((a, b) => a - b);
        for (const index of orderedWeeks) {
            if (!Number.isNaN(prevIndex) && index === prevIndex + 1) {
                run += 1;
            } else {
                run = 1;
            }
            if (run > bestWeekly) {
                bestWeekly = run;
            }
            prevIndex = index;
        }

        return {
            daily: { current: currentDaily, best: bestDaily },
            weekly: { current: currentWeekly, best: bestWeekly }
        };
    }

    private computeSessionTrend(
        entries: SessionDurationRecord[],
        totalDuration: number,
        totalCount: number,
        now: number,
        session: RawStatisticsSnapshot['session']
    ): { points: Array<{ timestamp: number; duration: number; hasData: boolean; }>; rollingAverageMs: number; lifetimeAverageMs: number; } {
        const lifetimeAverageMs = totalCount > 0 ? totalDuration / Math.max(1, totalCount) : 0;
        const DAY_MS = 24 * 60 * 60 * 1000;
        const todayStart = this.startOfDay(now);
        const windowStart = todayStart - (13 * DAY_MS);

        const dayTotals = new Map<number, number>();
        for (const entry of entries) {
            const dayKey = this.startOfDay(entry.timestamp);
            dayTotals.set(dayKey, (dayTotals.get(dayKey) ?? 0) + entry.duration);
        }

        if (session.active) {
            const activeDay = this.startOfDay(session.start ?? now);
            const existing = dayTotals.get(activeDay) ?? 0;
            dayTotals.set(activeDay, existing + Math.max(0, session.durationMs));
        }

        const points: Array<{ timestamp: number; duration: number; hasData: boolean; }> = [];
        const rollingWindow: number[] = [];
        for (let offset = 0; offset < 14; offset += 1) {
            const dayTimestamp = windowStart + offset * DAY_MS;
            const totalMs = dayTotals.get(dayTimestamp) ?? 0;
            const hasData = totalMs > 0;
            if (hasData) {
                rollingWindow.push(totalMs);
            }
            points.push({ timestamp: dayTimestamp, duration: totalMs, hasData });
        }

        const rollingAverageMs = rollingWindow.length > 0
            ? rollingWindow.reduce((sum, value) => sum + value, 0) / rollingWindow.length
            : 0;

        return {
            points,
            rollingAverageMs,
            lifetimeAverageMs
        };
    }

    private computePeakHours(buckets: number[]): {
        buckets: Array<{ hour: number; totalMs: number; share: number; }>;
        top: { hour: number; totalMs: number; share: number; } | null;
    } {
        if (!buckets.length) {
            return { buckets: [], top: null };
        }

        const sanitized = buckets.map((value) => Math.max(0, value));
        const total = sanitized.reduce((sum, value) => sum + value, 0);
        const distribution = sanitized.map((value, hour) => ({
            hour,
            totalMs: value,
            share: total > 0 ? value / total : 0
        }));

        if (total <= 0) {
            return { buckets: distribution, top: null };
        }

        const top = distribution.reduce((best, current) => current.totalMs > best.totalMs ? current : best, distribution[0]!);
        return { buckets: distribution, top: { ...top } };
    }

    private dayIndexFromTimestamp(timestamp: number): number {
        return Math.floor(this.startOfDay(timestamp) / DAY_MS);
    }

    private dayIndexFromKey(key: string): number | null {
        const [yearStr, monthStr, dayStr] = key.split('-');
        if (!yearStr || !monthStr || !dayStr) {
            return null;
        }
        const year = Number(yearStr);
        const month = Number(monthStr);
        const day = Number(dayStr);
        if (!Number.isFinite(year) || !Number.isFinite(month) || !Number.isFinite(day)) {
            return null;
        }
        const date = new Date(year, month - 1, day);
        date.setHours(0, 0, 0, 0);
        return Math.floor(date.getTime() / DAY_MS);
    }

    private startOfDay(timestamp: number): number {
        const date = new Date(timestamp);
        date.setHours(0, 0, 0, 0);
        return date.getTime();
    }

    private isoWeekFromTimestamp(timestamp: number): { year: number; week: number; } {
        const date = new Date(timestamp);
        const target = new Date(Date.UTC(date.getFullYear(), date.getMonth(), date.getDate()));
        const dayNumber = (target.getUTCDay() + 6) % 7;
        target.setUTCDate(target.getUTCDate() - dayNumber + 3);
        const firstThursday = new Date(Date.UTC(target.getUTCFullYear(), 0, 4));
        const week = 1 + Math.round(((target.getTime() - firstThursday.getTime()) / DAY_MS - 3) / 7);
        return { year: target.getUTCFullYear(), week };
    }

    private isoWeekIndex(year: number, week: number): number {
        return year * 100 + week;
    }

    private isoWeekIndexFromKey(key: string): number | null {
        const match = /^([0-9]{4})-W([0-9]{2})$/.exec(key);
        if (!match) {
            return null;
        }
        const year = Number(match[1]);
        const week = Number(match[2]);
        if (!Number.isFinite(year) || !Number.isFinite(week)) {
            return null;
        }
        return this.isoWeekIndex(year, week);
    }

    private previousIsoWeek(year: number, week: number): { year: number; week: number; } {
        if (week > 1) {
            return { year, week: week - 1 };
        }
        const prevYear = year - 1;
        const weeksInPrevYear = this.isoWeeksInYear(prevYear);
        return { year: prevYear, week: weeksInPrevYear };
    }

    private isoWeeksInYear(year: number): number {
        const dec28 = Date.UTC(year, 11, 28);
        return this.isoWeekFromTimestamp(dec28).week;
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

    private resolveBookByPath(bookPath: string): BookInfo | null {
        if (!this.plugin.books) {
            return null;
        }
        const books = this.plugin.books.getBooks();
        for (const book of books) {
            if (book.folder.path === bookPath) {
                return book;
            }
        }
        return null;
    }

    private resolveBookTitle(bookPath: string): string | null {
        return this.resolveBookByPath(bookPath)?.title ?? null;
    }

    private resolveBookCover(bookPath: string): string | null {
        const book = this.resolveBookByPath(bookPath);
        if (book?.cover) {
            return this.plugin.app.vault.getResourcePath(book.cover);
        }
        const folder = this.plugin.app.vault.getAbstractFileByPath(bookPath);
        if (folder instanceof TFolder) {
            const fallback = this.findFolderCover(folder);
            if (fallback) {
                return this.plugin.app.vault.getResourcePath(fallback);
            }
        }
        return null;
    }

    private findFolderCover(folder: TFolder): TFile | null {
        const candidates: TFile[] = [];
        const lowerFolderName = folder.name.toLowerCase();
        for (const child of folder.children) {
            if (!(child instanceof TFile)) {
                continue;
            }
            if (!this.isImageFile(child)) {
                continue;
            }
            candidates.push(child);
        }
        if (candidates.length === 0) {
            return null;
        }
        const coverLike = candidates.find((file) => /cover/i.test(file.name));
        if (coverLike) {
            return coverLike;
        }
        const matchingName = candidates.find((file) => file.name.toLowerCase().startsWith(lowerFolderName));
        if (matchingName) {
            return matchingName;
        }
        return candidates[0];
    }

    private isImageFile(file: TFile): boolean {
        const ext = file.extension.toLowerCase();
        return ['png', 'jpg', 'jpeg', 'webp', 'avif', 'gif'].includes(ext);
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
