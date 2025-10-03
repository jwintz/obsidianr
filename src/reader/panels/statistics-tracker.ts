export const SESSION_TIMEOUT_MS = 60 * 60 * 1000;
const DAY_MS = 24 * 60 * 60 * 1000;
const WEEK_MS = 7 * DAY_MS;
const MONTH_MS = 30 * DAY_MS;

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

export interface TrackerPersistedState {
    history: SessionRecord[];
    activeSession: SerializedActiveSession | null;
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
    };
}

export class ReadingStatisticsTracker {
    private activeSession: ActiveSession | null = null;
    private history: SessionRecord[] = [];

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
    }

    startOrExtendSession(timestamp: number, context: SessionContext): void {
        if (!this.activeSession) {
            this.activeSession = {
                start: timestamp,
                lastInteraction: timestamp,
                bookPath: context.bookPath,
                chapterPath: context.chapterPath
            };
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
            return;
        }

        this.activeSession.lastInteraction = timestamp;
        if (context.bookPath) {
            this.activeSession.bookPath = context.bookPath;
        }
        if (context.chapterPath) {
            this.activeSession.chapterPath = context.chapterPath;
        }
    }

    updateContext(context: SessionContext): void {
        if (!this.activeSession) {
            return;
        }
        if (context.bookPath) {
            this.activeSession.bookPath = context.bookPath;
        }
        if (context.chapterPath) {
            this.activeSession.chapterPath = context.chapterPath;
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
            activeSession: this.activeSession ? { ...this.activeSession } : null
        };
    }

    reset(): void {
        this.activeSession = null;
        this.history = [];
    }

    getSnapshot(now: number): RawStatisticsSnapshot {
        this.pruneHistory(now - 366 * DAY_MS);

        const bookDurations = new Map<string, number>();
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
                bookDurations
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
        this.history.push({
            start,
            end,
            duration,
            bookPath: this.activeSession.bookPath,
            chapterPath: this.activeSession.chapterPath
        });
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
}
