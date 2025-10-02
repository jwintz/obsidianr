import type { BookmarkEntry } from '../core/data';

export class BookmarkStore {
    private entries: Map<string, BookmarkEntry> = new Map();

    constructor(initial: BookmarkEntry[] = []) {
        for (const entry of initial) {
            this.entries.set(this.makeKey(entry.bookPath, entry.chapterPath, entry.page), { ...entry });
        }
    }

    getEntries(): BookmarkEntry[] {
        return Array.from(this.entries.values()).sort((a, b) => a.created - b.created);
    }

    getEntriesForBook(bookPath: string): BookmarkEntry[] {
        return this.getEntries().filter((entry) => entry.bookPath === bookPath);
    }

    isBookmarked(bookPath: string, chapterPath: string, page: number): boolean {
        return this.entries.has(this.makeKey(bookPath, chapterPath, page));
    }

    toggleBookmark(bookPath: string, chapterPath: string, page: number): { added: boolean; entry: BookmarkEntry | null; } {
        const key = this.makeKey(bookPath, chapterPath, page);
        if (this.entries.has(key)) {
            this.entries.delete(key);
            return { added: false, entry: null };
        }
        const entry: BookmarkEntry = {
            bookPath,
            chapterPath,
            page,
            created: Date.now()
        };
        this.entries.set(key, entry);
        return { added: true, entry };
    }

    upsert(entry: BookmarkEntry): void {
        this.entries.set(this.makeKey(entry.bookPath, entry.chapterPath, entry.page), { ...entry });
    }

    remove(entry: BookmarkEntry): void {
        this.entries.delete(this.makeKey(entry.bookPath, entry.chapterPath, entry.page));
    }

    serialize(): BookmarkEntry[] {
        return this.getEntries().map((entry) => ({ ...entry }));
    }

    private makeKey(bookPath: string, chapterPath: string, page: number): string {
        return `${bookPath}::${chapterPath}::${page}`;
    }
}
