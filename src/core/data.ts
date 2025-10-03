import type { ObsidianRSettings } from '../settings';
import type {
    BookTotalsRecord,
    ChapterProgressRecord,
    DailyTotalRecord,
    SessionDurationRecord,
    TrackerPersistedState,
    WeeklyTotalRecord
} from '../reader/panels/statistics-tracker';

export interface BookmarkEntry {
    bookPath: string;
    chapterPath: string;
    page: number;
    created: number;
    note?: string;
}

export interface PersistedData {
    version: number;
    settings: Partial<ObsidianRSettings>;
    bookmarks: BookmarkEntry[];
    statistics: TrackerPersistedState;
}

export const DATA_VERSION = 2;

export function normalizePersistedData(raw: unknown): PersistedData {
    const base: PersistedData = {
        version: DATA_VERSION,
        settings: {},
        bookmarks: [],
        statistics: {
            history: [],
            activeSession: null,
            bookTotals: [],
            chapterProgress: [],
            hourBuckets: new Array(24).fill(0),
            sessionDurations: [],
            dailyTotals: [],
            weeklyTotals: [],
            totalSessionDuration: 0,
            totalSessionCount: 0
        }
    };

    if (!raw || typeof raw !== 'object') {
        return base;
    }

    const source = raw as Record<string, unknown>;

    const hasStructuredFields = 'settings' in source || 'bookmarks' in source || 'statistics' in source;

    if (hasStructuredFields) {
        if (source.settings && typeof source.settings === 'object') {
            base.settings = source.settings as Partial<ObsidianRSettings>;
        }
        if (Array.isArray(source.bookmarks)) {
            base.bookmarks = source.bookmarks.filter(isValidBookmarkEntry);
        }
        if (source.statistics && typeof source.statistics === 'object') {
            const stats = source.statistics as TrackerPersistedState;
            const bookTotals = Array.isArray(stats.bookTotals) ? stats.bookTotals.filter(isValidBookTotalsRecord) : [];
            const chapterProgress = Array.isArray(stats.chapterProgress) ? stats.chapterProgress.filter(isValidChapterProgressRecord) : [];
            const hourBuckets = isValidHourBuckets(stats.hourBuckets) ? [...stats.hourBuckets!] : new Array(24).fill(0);
            const sessionDurations = Array.isArray(stats.sessionDurations) ? stats.sessionDurations.filter(isValidSessionDurationRecord).slice(-60) : [];
            const dailyTotals = Array.isArray(stats.dailyTotals) ? stats.dailyTotals.filter(isValidDailyTotalRecord) : [];
            const weeklyTotals = Array.isArray(stats.weeklyTotals) ? stats.weeklyTotals.filter(isValidWeeklyTotalRecord) : [];
            const totalSessionDuration = typeof stats.totalSessionDuration === 'number' ? stats.totalSessionDuration : 0;
            const totalSessionCount = typeof stats.totalSessionCount === 'number' ? stats.totalSessionCount : 0;

            base.statistics = {
                history: Array.isArray(stats.history) ? stats.history.filter(isValidSessionRecord) : [],
                activeSession: isValidActiveSession(stats.activeSession) ? stats.activeSession : null,
                bookTotals,
                chapterProgress,
                hourBuckets,
                sessionDurations,
                dailyTotals,
                weeklyTotals,
                totalSessionDuration,
                totalSessionCount
            };
        }
    } else {
        base.settings = source as Partial<ObsidianRSettings>;
    }

    if (typeof source.version === 'number') {
        base.version = source.version;
    }

    return base;
}

function isValidBookmarkEntry(entry: unknown): entry is BookmarkEntry {
    if (!entry || typeof entry !== 'object') {
        return false;
    }
    const candidate = entry as Record<string, unknown>;
    return typeof candidate.bookPath === 'string'
        && typeof candidate.chapterPath === 'string'
        && typeof candidate.page === 'number'
        && Number.isFinite(candidate.page)
        && typeof candidate.created === 'number';
}

function isValidSessionRecord(record: unknown): record is TrackerPersistedState['history'][number] {
    if (!record || typeof record !== 'object') {
        return false;
    }
    const candidate = record as Record<string, unknown>;
    if (typeof candidate.start !== 'number'
        || typeof candidate.end !== 'number'
        || typeof candidate.duration !== 'number') {
        return false;
    }
    const { bookPath, chapterPath } = candidate;
    if (bookPath != null && typeof bookPath !== 'string') {
        return false;
    }
    if (chapterPath != null && typeof chapterPath !== 'string') {
        return false;
    }
    return true;
}

function isValidActiveSession(active: unknown): TrackerPersistedState['activeSession'] {
    if (!active || typeof active !== 'object') {
        return null;
    }
    const candidate = active as Record<string, unknown>;
    if (typeof candidate.start !== 'number' || typeof candidate.lastInteraction !== 'number') {
        return null;
    }
    const bookPath = candidate.bookPath;
    const chapterPath = candidate.chapterPath;
    return {
        start: candidate.start,
        lastInteraction: candidate.lastInteraction,
        bookPath: typeof bookPath === 'string' ? bookPath : null,
        chapterPath: typeof chapterPath === 'string' ? chapterPath : null
    };
}

function isValidBookTotalsRecord(record: unknown): record is BookTotalsRecord {
    if (!record || typeof record !== 'object') {
        return false;
    }
    const candidate = record as Record<string, unknown>;
    return typeof candidate.path === 'string'
        && typeof candidate.totalMs === 'number'
        && typeof candidate.sessionCount === 'number'
        && (candidate.lastRead == null || typeof candidate.lastRead === 'number')
        && (candidate.firstRead == null || typeof candidate.firstRead === 'number');
}

function isValidChapterProgressRecord(record: unknown): record is ChapterProgressRecord {
    if (!record || typeof record !== 'object') {
        return false;
    }
    const candidate = record as Record<string, unknown>;
    return typeof candidate.bookPath === 'string'
        && typeof candidate.chapterPath === 'string'
        && typeof candidate.firstSeen === 'number'
        && typeof candidate.lastSeen === 'number';
}

function isValidSessionDurationRecord(record: unknown): record is SessionDurationRecord {
    if (!record || typeof record !== 'object') {
        return false;
    }
    const candidate = record as Record<string, unknown>;
    return typeof candidate.timestamp === 'number'
        && typeof candidate.duration === 'number';
}

function isValidDailyTotalRecord(record: unknown): record is DailyTotalRecord {
    if (!record || typeof record !== 'object') {
        return false;
    }
    const candidate = record as Record<string, unknown>;
    return typeof candidate.day === 'string'
        && typeof candidate.totalMs === 'number';
}

function isValidWeeklyTotalRecord(record: unknown): record is WeeklyTotalRecord {
    if (!record || typeof record !== 'object') {
        return false;
    }
    const candidate = record as Record<string, unknown>;
    return typeof candidate.week === 'string'
        && typeof candidate.totalMs === 'number';
}

function isValidHourBuckets(value: unknown): value is number[] {
    if (!Array.isArray(value) || value.length !== 24) {
        return false;
    }
    return value.every((item) => typeof item === 'number');
}
