export const SESSION_TIMEOUT_MS = 60 * 60 * 1000;
const DAY_MS = 24 * 60 * 60 * 1000;
const WEEK_MS = 7 * DAY_MS;
const MONTH_MS = 30 * DAY_MS;
const SESSION_TREND_LIMIT = 60;

export interface SessionContext {
    bookPath: string | null;
    chapterPath: string | null;
}

export interface SerializedActiveSession extends SessionContext {
    start: number;
    lastInteraction: number;
}

interface ActiveSession extends SerializedActiveSession { }

export interface SessionRecord extends SessionContext {
    start: number;
    end: number;
    duration: number;
}

export interface BookTotalsRecord {
    path: string;
    totalMs: number;
    sessionCount: number;
    firstRead: number | null;
    lastRead: number | null;
}

export interface ChapterProgressRecord {
    bookPath: string;
    chapterPath: string;
    firstSeen: number;
    lastSeen: number;
}

export interface SessionDurationRecord {
    timestamp: number;
    duration: number;
}

export interface DailyTotalRecord {
    day: string;
    totalMs: number;
}

export interface WeeklyTotalRecord {
    week: string;
    totalMs: number;
}

export interface TrackerPersistedState {
    history: SessionRecord[];
    activeSession: SerializedActiveSession | null;
    bookTotals?: BookTotalsRecord[];
    chapterProgress?: ChapterProgressRecord[];
    hourBuckets?: number[];
    sessionDurations?: SessionDurationRecord[];
    dailyTotals?: DailyTotalRecord[];
    weeklyTotals?: WeeklyTotalRecord[];
    totalSessionDuration?: number;
    totalSessionCount?: number;
}

interface BookAggregate {
    totalMs: number;
    sessionCount: number;
    firstRead: number | null;
    lastRead: number | null;
}

interface ChapterAggregate {
    firstSeen: number;
    lastSeen: number;
}

export interface RawStatisticsSnapshot {
    session: {
        active: boolean;
        start: number | null;
        lastInteraction: number | null;
        durationMs: number;
        bookPath: string | null;
        chapterPath: string | null;
    };
    totals: {
        dailyMs: number;
        weeklyMs: number;
        monthlyMs: number;
        yearlyMs: number;
        bookDurations: Map<string, number>;
        bookTotals: Map<string, BookAggregate>;
    };
    analytics: {
        peakHours: number[];
        sessionDurations: SessionDurationRecord[];
        totalSessionDuration: number;
        totalSessionCount: number;
        dailyTotals: Map<string, number>;
        weeklyTotals: Map<string, number>;
        chapterProgress: Map<string, Map<string, ChapterAggregate>>;
    };
}

export class ReadingStatisticsTracker {
    private activeSession: ActiveSession | null = null;
    private history: SessionRecord[] = [];
    private bookTotals: Map<string, BookAggregate> = new Map();
    private chapterProgress: Map<string, Map<string, ChapterAggregate>> = new Map();
    private hourBuckets: number[] = new Array(24).fill(0);
    private sessionDurations: SessionDurationRecord[] = [];
    private dailyTotals: Map<string, number> = new Map();
    private weeklyTotals: Map<string, number> = new Map();
    private totalSessionDuration = 0;
    private totalSessionCount = 0;

    constructor(initialState?: TrackerPersistedState) {
        if (initialState?.history) {
            this.history = initialState.history.map((record) => ({ ...record }));
        }
        if (initialState?.activeSession) {
            const restored: ActiveSession = { ...initialState.activeSession };
            const now = Date.now();
            if (now - restored.lastInteraction > SESSION_TIMEOUT_MS) {
                this.activeSession = restored;
                this.finalizeSession(restored.lastInteraction);
                this.activeSession = null;
            } else {
                this.activeSession = restored;
            }
        }
        if (initialState?.bookTotals) {
            for (const record of initialState.bookTotals) {
                this.bookTotals.set(record.path, {
                    totalMs: record.totalMs,
                    sessionCount: record.sessionCount,
                    firstRead: record.firstRead ?? null,
                    lastRead: record.lastRead ?? null
                });
            }
        }
        if (initialState?.chapterProgress) {
            for (const record of initialState.chapterProgress) {
                const chapters = this.chapterProgress.get(record.bookPath) ?? new Map();
                chapters.set(record.chapterPath, {
                    firstSeen: record.firstSeen,
                    lastSeen: record.lastSeen
                });
                this.chapterProgress.set(record.bookPath, chapters);
            }
        }
        if (initialState?.hourBuckets && Array.isArray(initialState.hourBuckets) && initialState.hourBuckets.length === 24) {
            this.hourBuckets = [...initialState.hourBuckets];
        }
        if (initialState?.sessionDurations) {
            this.sessionDurations = initialState.sessionDurations.map((entry) => ({ ...entry })).slice(-SESSION_TREND_LIMIT);
        }
        if (initialState?.dailyTotals) {
            for (const entry of initialState.dailyTotals) {
                this.dailyTotals.set(entry.day, entry.totalMs);
            }
        }
        if (initialState?.weeklyTotals) {
            for (const entry of initialState.weeklyTotals) {
                this.weeklyTotals.set(entry.week, entry.totalMs);
            }
        }
        if (typeof initialState?.totalSessionDuration === 'number') {
            this.totalSessionDuration = initialState.totalSessionDuration;
        }
        if (typeof initialState?.totalSessionCount === 'number') {
            this.totalSessionCount = initialState.totalSessionCount;
        }

        if (this.history.length > 0 && this.bookTotals.size === 0) {
            this.rebuildAggregatesFromHistory();
        }
    }

    startOrExtendSession(timestamp: number, context: SessionContext): void {
        if (!this.activeSession) {
            this.activeSession = {
                start: timestamp,
                lastInteraction: timestamp,
                bookPath: context.bookPath,
                chapterPath: context.chapterPath
            };
            this.markChapterVisit(context.chapterPath, timestamp);
            return;
        }

        if (timestamp - this.activeSession.lastInteraction > SESSION_TIMEOUT_MS) {
            this.finalizeSession(this.activeSession.lastInteraction);
            this.activeSession = {
                start: timestamp,
                lastInteraction: timestamp,
                bookPath: context.bookPath,
                chapterPath: context.chapterPath
            };
            this.markChapterVisit(context.chapterPath, timestamp);
            return;
        }

        if (context.bookPath && this.activeSession.bookPath && context.bookPath !== this.activeSession.bookPath) {
            this.finalizeSession(timestamp);
            this.activeSession = {
                start: timestamp,
                lastInteraction: timestamp,
                bookPath: context.bookPath,
                chapterPath: context.chapterPath ?? null
            };
            this.markChapterVisit(context.chapterPath, timestamp);
            return;
        }

        this.activeSession.lastInteraction = timestamp;
        if (context.bookPath) {
            this.activeSession.bookPath = context.bookPath;
        }
        if (context.chapterPath) {
            this.activeSession.chapterPath = context.chapterPath;
            this.markChapterVisit(context.chapterPath, timestamp);
        }
    }

    updateContext(context: SessionContext): void {
        if (!this.activeSession) {
            return;
        }
        const now = Date.now();
        if (context.bookPath && this.activeSession.bookPath && context.bookPath !== this.activeSession.bookPath) {
            this.finalizeSession(now);
            this.activeSession = {
                start: now,
                lastInteraction: now,
                bookPath: context.bookPath,
                chapterPath: context.chapterPath ?? null
            };
            this.markChapterVisit(context.chapterPath ?? null, now);
            return;
        }

        if (context.bookPath) {
            this.activeSession.bookPath = context.bookPath;
        }
        if (context.chapterPath) {
            this.activeSession.chapterPath = context.chapterPath;
            this.markChapterVisit(context.chapterPath, now);
        }
    }

    finalizeCurrentSession(timestamp: number): void {
        if (!this.activeSession) {
            return;
        }
        this.finalizeSession(timestamp);
        this.activeSession = null;
    }

    serialize(): TrackerPersistedState {
        return {
            history: this.history.map((record) => ({ ...record })),
            activeSession: this.activeSession ? { ...this.activeSession } : null,
            bookTotals: Array.from(this.bookTotals.entries()).map(([path, data]) => ({
                path,
                totalMs: data.totalMs,
                sessionCount: data.sessionCount,
                firstRead: data.firstRead,
                lastRead: data.lastRead
            })),
            chapterProgress: this.serializeChapterProgress(),
            hourBuckets: [...this.hourBuckets],
            sessionDurations: this.sessionDurations.map((entry) => ({ ...entry })),
            dailyTotals: Array.from(this.dailyTotals.entries()).map(([day, totalMs]) => ({ day, totalMs })),
            weeklyTotals: Array.from(this.weeklyTotals.entries()).map(([week, totalMs]) => ({ week, totalMs })),
            totalSessionDuration: this.totalSessionDuration,
            totalSessionCount: this.totalSessionCount
        };
    }

    reset(): void {
        this.activeSession = null;
        this.history = [];
        this.bookTotals.clear();
        this.chapterProgress.clear();
        this.hourBuckets.fill(0);
        this.sessionDurations = [];
        this.dailyTotals.clear();
        this.weeklyTotals.clear();
        this.totalSessionDuration = 0;
        this.totalSessionCount = 0;
    }

    getSnapshot(now: number): RawStatisticsSnapshot {
        this.pruneHistory(now - 366 * DAY_MS);

        const bookDurations = new Map<string, number>();
        const bookTotals = new Map<string, BookAggregate>();
        for (const [path, data] of this.bookTotals) {
            bookTotals.set(path, { ...data });
        }

        let dailyMs = 0;
        let weeklyMs = 0;
        let monthlyMs = 0;
        let yearlyMs = 0;

        const dailyStart = this.startOfDay(now);
        const weeklyStart = now - WEEK_MS;
        const monthlyStart = now - MONTH_MS;
        const yearStart = this.startOfYear(now);

        for (const record of this.history) {
            const duration = record.duration;
            const { start, end, bookPath } = record;
            if (bookPath) {
                bookDurations.set(bookPath, (bookDurations.get(bookPath) ?? 0) + duration);
            }
            dailyMs += this.windowContribution(start, end, dailyStart, now);
            weeklyMs += this.windowContribution(start, end, weeklyStart, now);
            monthlyMs += this.windowContribution(start, end, monthlyStart, now);
            yearlyMs += this.windowContribution(start, end, yearStart, now);
        }

        let activeDuration = 0;
        const peakHours = [...this.hourBuckets];
        const dailyTotals = new Map(this.dailyTotals);
        const weeklyTotals = new Map(this.weeklyTotals);
        if (this.activeSession) {
            const { start, bookPath } = this.activeSession;
            const end = now;
            activeDuration = Math.max(0, end - start);
            if (bookPath) {
                bookDurations.set(bookPath, (bookDurations.get(bookPath) ?? 0) + activeDuration);
            }
            dailyMs += this.windowContribution(start, end, dailyStart, now);
            weeklyMs += this.windowContribution(start, end, weeklyStart, now);
            monthlyMs += this.windowContribution(start, end, monthlyStart, now);
            yearlyMs += this.windowContribution(start, end, yearStart, now);
            this.distributeAcrossHours(start, end, (hour, portion) => {
                peakHours[hour] += portion;
            });
            this.distributeAcrossDays(start, end, (dayKey, portion) => {
                dailyTotals.set(dayKey, (dailyTotals.get(dayKey) ?? 0) + portion);
            });
            this.distributeAcrossWeeks(start, end, (weekKey, portion) => {
                weeklyTotals.set(weekKey, (weeklyTotals.get(weekKey) ?? 0) + portion);
            });
            if (bookPath) {
                const activeAggregate = this.mergeActiveSessionIntoTotals(bookTotals, bookPath, activeDuration, this.activeSession.start, this.activeSession.lastInteraction ?? end);
                bookTotals.set(bookPath, activeAggregate);
            }
        }

        return {
            session: {
                active: Boolean(this.activeSession),
                start: this.activeSession?.start ?? null,
                lastInteraction: this.activeSession?.lastInteraction ?? null,
                durationMs: activeDuration,
                bookPath: this.activeSession?.bookPath ?? null,
                chapterPath: this.activeSession?.chapterPath ?? null
            },
            totals: {
                dailyMs,
                weeklyMs,
                monthlyMs,
                yearlyMs,
                bookDurations,
                bookTotals
            },
            analytics: {
                peakHours,
                sessionDurations: this.sessionDurations.map((entry) => ({ ...entry })),
                totalSessionDuration: this.totalSessionDuration,
                totalSessionCount: this.totalSessionCount,
                dailyTotals,
                weeklyTotals,
                chapterProgress: this.cloneChapterProgress()
            }
        };
    }

    private finalizeSession(timestamp: number): void {
        if (!this.activeSession) {
            return;
        }
        const start = this.activeSession.start;
        const end = Math.max(timestamp, start);
        const duration = end - start;
        if (duration <= 0) {
            return;
        }
        const { bookPath, chapterPath } = this.activeSession;
        this.history.push({
            start,
            end,
            duration,
            bookPath,
            chapterPath
        });
        if (bookPath) {
            this.updateBookTotals(bookPath, duration, end, start);
            if (chapterPath) {
                this.markChapterRange(bookPath, chapterPath, start, end);
            }
        }
        this.totalSessionDuration += duration;
        this.totalSessionCount += 1;
        this.recordSessionDuration(end, duration);
        this.distributeAcrossHours(start, end, (hour, portion) => {
            this.hourBuckets[hour] += portion;
        });
        this.distributeAcrossDays(start, end, (dayKey, portion) => {
            this.dailyTotals.set(dayKey, (this.dailyTotals.get(dayKey) ?? 0) + portion);
        });
        this.distributeAcrossWeeks(start, end, (weekKey, portion) => {
            this.weeklyTotals.set(weekKey, (this.weeklyTotals.get(weekKey) ?? 0) + portion);
        });
    }

    private recordSessionDuration(timestamp: number, duration: number): void {
        this.sessionDurations.push({ timestamp, duration });
        if (this.sessionDurations.length > SESSION_TREND_LIMIT) {
            this.sessionDurations.splice(0, this.sessionDurations.length - SESSION_TREND_LIMIT);
        }
    }

    private markChapterVisit(chapterPath: string | null, timestamp: number): void {
        if (!chapterPath || !this.activeSession?.bookPath) {
            return;
        }
        this.markChapterRange(this.activeSession.bookPath, chapterPath, timestamp, timestamp);
    }

    private markChapterRange(bookPath: string, chapterPath: string, start: number, end: number): void {
        if (!bookPath || !chapterPath) {
            return;
        }
        const chapters = this.chapterProgress.get(bookPath) ?? new Map<string, ChapterAggregate>();
        const current = chapters.get(chapterPath) ?? { firstSeen: start, lastSeen: start };
        current.firstSeen = Math.min(current.firstSeen, start);
        current.lastSeen = Math.max(current.lastSeen, end);
        chapters.set(chapterPath, current);
        this.chapterProgress.set(bookPath, chapters);
    }

    private pruneHistory(threshold: number): void {
        if (this.history.length === 0) {
            return;
        }
        let idx = 0;
        while (idx < this.history.length && this.history[idx].end < threshold) {
            idx += 1;
        }
        if (idx > 0) {
            this.history.splice(0, idx);
        }
    }

    private updateBookTotals(path: string, duration: number, end: number, start: number): void {
        const current = this.bookTotals.get(path) ?? { totalMs: 0, sessionCount: 0, firstRead: null, lastRead: null };
        current.totalMs += duration;
        current.sessionCount += 1;
        current.firstRead = current.firstRead == null ? start : Math.min(current.firstRead, start);
        current.lastRead = current.lastRead == null ? end : Math.max(current.lastRead, end);
        this.bookTotals.set(path, current);
    }

    private rebuildAggregatesFromHistory(): void {
        this.bookTotals.clear();
        this.chapterProgress.clear();
        this.hourBuckets.fill(0);
        this.sessionDurations = [];
        this.dailyTotals.clear();
        this.weeklyTotals.clear();
        this.totalSessionDuration = 0;
        this.totalSessionCount = 0;

        for (const record of this.history) {
            const { start, end, duration, bookPath, chapterPath } = record;
            if (bookPath) {
                this.updateBookTotals(bookPath, duration, end, start);
                if (chapterPath) {
                    this.markChapterRange(bookPath, chapterPath, start, end);
                }
            }
            this.totalSessionDuration += duration;
            this.totalSessionCount += 1;
            this.recordSessionDuration(end, duration);
            this.distributeAcrossHours(start, end, (hour, portion) => {
                this.hourBuckets[hour] += portion;
            });
            this.distributeAcrossDays(start, end, (dayKey, portion) => {
                this.dailyTotals.set(dayKey, (this.dailyTotals.get(dayKey) ?? 0) + portion);
            });
            this.distributeAcrossWeeks(start, end, (weekKey, portion) => {
                this.weeklyTotals.set(weekKey, (this.weeklyTotals.get(weekKey) ?? 0) + portion);
            });
        }
    }

    private serializeChapterProgress(): ChapterProgressRecord[] {
        const records: ChapterProgressRecord[] = [];
        for (const [bookPath, chapters] of this.chapterProgress.entries()) {
            for (const [chapterPath, aggregate] of chapters.entries()) {
                records.push({
                    bookPath,
                    chapterPath,
                    firstSeen: aggregate.firstSeen,
                    lastSeen: aggregate.lastSeen
                });
            }
        }
        return records;
    }

    private cloneChapterProgress(): Map<string, Map<string, ChapterAggregate>> {
        const clone = new Map<string, Map<string, ChapterAggregate>>();
        for (const [bookPath, chapters] of this.chapterProgress.entries()) {
            const chapterClone = new Map<string, ChapterAggregate>();
            for (const [chapterPath, aggregate] of chapters.entries()) {
                chapterClone.set(chapterPath, { ...aggregate });
            }
            clone.set(bookPath, chapterClone);
        }
        return clone;
    }

    private mergeActiveSessionIntoTotals(
        totals: Map<string, BookAggregate>,
        bookPath: string,
        activeDuration: number,
        start: number,
        lastInteraction: number
    ): BookAggregate {
        const existing = totals.get(bookPath) ?? { totalMs: 0, sessionCount: 0, firstRead: null, lastRead: null };
        const aggregate: BookAggregate = {
            totalMs: existing.totalMs + Math.max(0, activeDuration),
            sessionCount: existing.sessionCount + (activeDuration > 0 ? 1 : existing.sessionCount === 0 ? 1 : 0),
            firstRead: existing.firstRead == null ? start : Math.min(existing.firstRead, start),
            lastRead: existing.lastRead == null ? lastInteraction : Math.max(existing.lastRead, lastInteraction)
        };
        return aggregate;
    }

    private distributeAcrossHours(start: number, end: number, callback: (hour: number, portion: number) => void): void {
        let cursor = start;
        while (cursor < end) {
            const date = new Date(cursor);
            const hour = date.getHours();
            const nextHour = new Date(date.getFullYear(), date.getMonth(), date.getDate(), hour + 1, 0, 0, 0).getTime();
            const segmentEnd = Math.min(end, nextHour);
            callback(hour, segmentEnd - cursor);
            cursor = segmentEnd;
        }
    }

    private distributeAcrossDays(start: number, end: number, callback: (dayKey: string, portion: number) => void): void {
        let cursor = start;
        while (cursor < end) {
            const dayStart = this.startOfDay(cursor);
            const dayEnd = dayStart + DAY_MS;
            const segmentEnd = Math.min(end, dayEnd);
            callback(this.dayKey(dayStart), segmentEnd - cursor);
            cursor = segmentEnd;
        }
    }

    private distributeAcrossWeeks(start: number, end: number, callback: (weekKey: string, portion: number) => void): void {
        let cursor = start;
        while (cursor < end) {
            const weekKey = this.weekKey(cursor);
            const weekEnd = this.endOfIsoWeek(cursor);
            const segmentEnd = Math.min(end, weekEnd);
            callback(weekKey, segmentEnd - cursor);
            cursor = segmentEnd;
        }
    }

    private startOfDay(timestamp: number): number {
        const date = new Date(timestamp);
        date.setHours(0, 0, 0, 0);
        return date.getTime();
    }

    private startOfYear(timestamp: number): number {
        const date = new Date(timestamp);
        date.setMonth(0, 1);
        date.setHours(0, 0, 0, 0);
        return date.getTime();
    }

    private windowContribution(start: number, end: number, windowStart: number, windowEnd: number): number {
        if (end <= windowStart || start >= windowEnd) {
            return 0;
        }
        const from = Math.max(start, windowStart);
        const to = Math.min(end, windowEnd);
        return Math.max(0, to - from);
    }

    private dayKey(dayStart: number): string {
        const date = new Date(dayStart);
        return `${date.getFullYear()}-${(date.getMonth() + 1).toString().padStart(2, '0')}-${date.getDate().toString().padStart(2, '0')}`;
    }

    private weekKey(timestamp: number): string {
        const date = new Date(timestamp);
        const target = new Date(Date.UTC(date.getFullYear(), date.getMonth(), date.getDate()));
        const dayNumber = (target.getUTCDay() + 6) % 7;
        target.setUTCDate(target.getUTCDate() - dayNumber + 3);
        const firstThursday = new Date(Date.UTC(target.getUTCFullYear(), 0, 4));
        const weekNumber = 1 + Math.round(((target.getTime() - firstThursday.getTime()) / DAY_MS - 3) / 7);
        return `${target.getUTCFullYear()}-W${weekNumber.toString().padStart(2, '0')}`;
    }

    private endOfIsoWeek(timestamp: number): number {
        const date = new Date(timestamp);
        const day = date.getDay();
        const diff = day === 0 ? 0 : 7 - day;
        const end = new Date(date.getFullYear(), date.getMonth(), date.getDate() + diff + 1, 0, 0, 0, 0);
        return end.getTime();
    }
}
