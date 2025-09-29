import { TAbstractFile, TFile, TFolder, debounce, parseYaml } from 'obsidian';
import type ObsidianRPlugin from '../main';
import { logDebug } from '../core/logger';

const BOOK_FLAG = 'obsidianr-book-folder';
const FILE_EXPLORER_CLASS = 'nav-folder-title-content';
const BOOK_PILL_BASE_CLASS = 'obsidianr-book-pill';

type Frontmatter = Record<string, unknown> | null;

function normalizePath(path: string): string {
    if (path === '/' || path === '') {
        return '/';
    }
    return path.replace(/\/$/g, '');
}

function escapeForAttribute(value: string): string {
    return value.replace(/\\/g, '\\\\').replace(/"/g, '\\"');
}

interface ChapterInfo {
    file: TFile;
    order: number;
    title: string;
}

interface BookInfo {
    folder: TFolder;
    title: string;
    chapters: ChapterInfo[];
}

interface FolderAggregate {
    folder: TFolder;
    chapters: ChapterInfo[];
    titleVotes: Map<string, number>;
    chapterHints: number;
}

interface FileExplorerItem {
    file: TAbstractFile;
    el?: HTMLElement;
    titleInnerEl?: HTMLElement;
    titleEl?: HTMLElement;
    selfEl?: HTMLElement;
}

interface FileExplorerView {
    fileItems: Record<string, FileExplorerItem>;
}

export class BookCatalog {
    private books: Map<string, BookInfo> = new Map();
    private cleanupFns: Array<() => void> = [];
    private badgeTemplate: HTMLElement | null = null;
    private readonly scheduleScan = debounce(() => {
        void this.recomputeBooks();
    }, 400);
    private readonly updateExplorer = debounce(() => this.renderExplorerBadges(), 120);
    private readonly handleVaultChange = () => this.scheduleScan();
    private readonly handleMetadataChange = () => this.scheduleScan();

    constructor(private readonly plugin: ObsidianRPlugin) { }

    async initialize(): Promise<void> {
        logDebug('BookCatalog: initialize');
        await this.recomputeBooks();
        this.observeVault();
        this.decorateFileExplorer();
    }

    dispose(): void {
        this.cleanupFns.forEach((fn) => fn());
        this.cleanupFns = [];
        this.clearExplorerBadges();
    }

    getBooks(): BookInfo[] {
        return Array.from(this.books.values());
    }

    getChapterNeighbors(file: TFile | null): { previous: TFile | null; next: TFile | null; book: BookInfo | null; } {
        if (!file) {
            return { previous: null, next: null, book: null };
        }

        const parent = file.parent;
        if (!parent) {
            return { previous: null, next: null, book: null };
        }

        const key = normalizePath(parent.path);
        const book = this.books.get(key) ?? null;
        if (!book) {
            return { previous: null, next: null, book: null };
        }

        const index = book.chapters.findIndex((chapter) => chapter.file.path === file.path);
        if (index === -1) {
            return { previous: null, next: null, book };
        }

        const previous = index > 0 ? book.chapters[index - 1].file : null;
        const next = index < book.chapters.length - 1 ? book.chapters[index + 1].file : null;

        return { previous, next, book };
    }

    private observeVault(): void {
        const vault = this.plugin.app.vault;
        const metadata = this.plugin.app.metadataCache;
        logDebug('BookCatalog: observeVault listeners attached');
        this.plugin.registerEvent(vault.on('create', this.handleVaultChange));
        this.plugin.registerEvent(vault.on('modify', this.handleVaultChange));
        this.plugin.registerEvent(vault.on('delete', this.handleVaultChange));
        this.plugin.registerEvent(metadata.on('changed', this.handleMetadataChange));
        this.plugin.registerEvent(metadata.on('resolved', this.handleMetadataChange));
    }

    private async recomputeBooks(): Promise<void> {
        const start = performance.now();
        const books = await this.collectBooks();
        this.books = books;
        this.updateExplorer();
        logDebug('BookCatalog: recomputed books', {
            bookCount: books.size,
            durationMs: Math.round(performance.now() - start)
        });
    }

    private async collectBooks(): Promise<Map<string, BookInfo>> {
        const vault = this.plugin.app.vault;
        const metadataCache = this.plugin.app.metadataCache;
        const aggregates = new Map<string, FolderAggregate>();

        const markdownFiles = vault.getMarkdownFiles();
        logDebug('BookCatalog: scanning markdown files', { count: markdownFiles.length });

        for (const file of markdownFiles) {
            const folder = file.parent;
            if (!folder) {
                continue;
            }

            const key = folder.path;
            const normalizedKey = normalizePath(key);
            if (normalizedKey === '/') {
                continue;
            }
            let aggregate = aggregates.get(normalizedKey);
            if (!aggregate) {
                aggregate = {
                    folder,
                    chapters: [],
                    titleVotes: new Map(),
                    chapterHints: 0
                };
                aggregates.set(normalizedKey, aggregate);
            }

            const cached = metadataCache.getFileCache(file);
            let frontmatter: Frontmatter = (cached?.frontmatter as Record<string, unknown> | undefined) ?? null;
            if (!frontmatter) {
                frontmatter = await this.tryParseFrontmatter(file);
            }

            const chapterInfo: ChapterInfo = {
                file,
                order: this.extractChapterOrder(frontmatter, file),
                title: this.extractChapterTitle(frontmatter, file)
            };
            aggregate.chapters.push(chapterInfo);

            const inferredBook = this.extractBookTitle(frontmatter);
            if (inferredBook) {
                const normalized = inferredBook.trim();
                aggregate.titleVotes.set(normalized, (aggregate.titleVotes.get(normalized) ?? 0) + 1);
            }

            const type = this.extractTypeHint(frontmatter);
            if (type) {
                aggregate.chapterHints += 1;
            }
        }

        const books = new Map<string, BookInfo>();
        for (const [key, aggregate] of aggregates) {
            if (aggregate.chapters.length === 0) {
                logDebug('BookCatalog: skip folder without chapters', key);
                continue;
            }

            const hasBookMetadata = aggregate.titleVotes.size > 0;
            const hasChapterHints = aggregate.chapterHints > 0;

            if (!(hasBookMetadata && hasChapterHints)) {
                logDebug('BookCatalog: folder did not qualify as book', {
                    path: key,
                    chapterCount: aggregate.chapters.length,
                    chapterHints: aggregate.chapterHints,
                    titleVotes: aggregate.titleVotes.size
                });
                continue;
            }

            let title: string;
            if (aggregate.titleVotes.size > 0) {
                const [topTitle] = Array.from(aggregate.titleVotes.entries()).sort((a, b) => b[1] - a[1])[0];
                title = topTitle;
            } else {
                title = this.prettifyFolderName(aggregate.folder.name);
            }

            logDebug('BookCatalog: registering book', {
                path: key,
                title,
                chapters: aggregate.chapters.length
            });

            aggregate.chapters.sort((a, b) => {
                const byOrder = a.order - b.order;
                if (byOrder !== 0) {
                    return byOrder;
                }
                return a.title.localeCompare(b.title, undefined, {
                    numeric: true,
                    sensitivity: 'base'
                });
            });

            books.set(key, {
                folder: aggregate.folder,
                title,
                chapters: aggregate.chapters
            });
        }

        return books;
    }

    private decorateFileExplorer(): void {
        const explorer = this.getFileExplorerView();
        if (!explorer) {
            this.plugin.app.workspace.onLayoutReady(() => this.decorateFileExplorer());
            return;
        }

        const container = (explorer as unknown as { containerEl?: HTMLElement; }).containerEl;
        if (container instanceof HTMLElement) {
            const observer = new MutationObserver((mutations) => {
                if (this.shouldIgnoreExplorerMutations(mutations)) {
                    return;
                }
                this.renderExplorerBadges();
            });
            observer.observe(container, { childList: true, subtree: true });
            this.cleanupFns.push(() => observer.disconnect());
        }

        this.renderExplorerBadges();
    }

    private getFileExplorerView(): FileExplorerView | null {
        const leaf = this.plugin.app.workspace.getLeavesOfType('file-explorer')[0];
        if (!leaf) {
            return null;
        }
        const view = leaf.view as unknown as Partial<FileExplorerView> | undefined;
        if (!view || !view.fileItems) {
            return null;
        }
        return view as FileExplorerView;
    }

    private renderExplorerBadges(): void {
        const explorer = this.getFileExplorerView();
        if (!explorer) {
            logDebug('BookCatalog: file explorer not ready, skipping badge render');
            return;
        }

        const items = explorer.fileItems;
        const knownBooks = Array.from(this.books.keys());
        const explorerKeys = Object.keys(items);
        logDebug('BookCatalog: rendering badges', {
            knownBooks,
            folderCount: explorerKeys.length
        });

        for (const key of explorerKeys) {
            const item = items[key];
            if (!item || !(item.file instanceof TFolder)) {
                continue;
            }
            const path = normalizePath(item.file.path);
            const { containerEl, source } = this.resolveTitleContainer(item);
            if (!containerEl) {
                if (this.books.has(path)) {
                    logDebug('BookCatalog: missing container element for book folder', {
                        path,
                        itemKeys: Object.keys(item)
                    });
                }
                continue;
            }

            if (source !== 'titleInnerEl' && this.books.has(path)) {
                logDebug('BookCatalog: resolved folder title container with fallback', {
                    path,
                    source
                });
            }

            containerEl.classList.add('obsidianr-folder-title');
            const book = this.books.get(path);
            if (!book) {
                this.removeBadge(containerEl, this.resolveFolderElement(item));
                continue;
            }

            this.applyBadge(containerEl, this.resolveFolderElement(item), book);
        }

        for (const bookPath of knownBooks) {
            if (!items[bookPath]) {
                logDebug('BookCatalog: book missing from explorer items', {
                    bookPath,
                    explorerKeys
                });
            }
        }
    }

    private applyBadge(containerEl: HTMLElement, folderEl: HTMLElement | undefined, book: BookInfo): void {
        const hostEl = containerEl.parentElement ?? folderEl ?? containerEl;
        if (!hostEl) {
            return;
        }

        this.removeBadge(containerEl, folderEl);

        if (folderEl) {
            folderEl.classList.add(BOOK_FLAG);
        }

        const pill = this.createBadgeElement(book);
        const reference = containerEl.nextSibling;
        hostEl.insertBefore(pill, reference);
        logDebug('BookCatalog: badge rendered', { path: book.folder.path, title: book.title });
    }

    private removeBadge(
        containerEl: HTMLElement | null | undefined,
        folderEl: HTMLElement | undefined
    ): void {
        this.removeBadgeFromElement(containerEl);
        this.removeBadgeFromElement(containerEl?.parentElement ?? null);
        this.removeBadgeFromElement(folderEl);
        if (folderEl instanceof HTMLElement) {
            folderEl.classList.remove(BOOK_FLAG);
        }
    }

    private removeBadgeFromElement(element: HTMLElement | null | undefined): void {
        if (!(element instanceof HTMLElement)) {
            return;
        }
        const existing = element.querySelector(`.${BOOK_PILL_BASE_CLASS}`);
        if (existing) {
            existing.remove();
        }
    }

    private clearExplorerBadges(): void {
        const explorer = this.getFileExplorerView();
        if (!explorer) {
            return;
        }

        for (const key of Object.keys(explorer.fileItems)) {
            const item = explorer.fileItems[key];
            if (!item) {
                continue;
            }
            const { containerEl } = this.resolveTitleContainer(item);
            if (containerEl) {
                this.removeBadge(containerEl, this.resolveFolderElement(item));
            }
        }
    }

    private createBadgeElement(book: BookInfo): HTMLElement {
        const prototype = this.getBadgePrototype();
        const pill = prototype.cloneNode(false) as HTMLElement;
        pill.classList.add(BOOK_PILL_BASE_CLASS);
        pill.textContent = 'BOOK';
        pill.setAttribute('aria-label', `${book.title} (book)`);
        return pill;
    }

    private getBadgePrototype(): HTMLElement {
        if (!this.badgeTemplate || this.badgeTemplate.dataset.obsidianrFallback === 'true') {
            const template = this.computeBadgeTemplate();
            if (!this.badgeTemplate || template.dataset.obsidianrFallback !== 'true') {
                this.badgeTemplate = template;
            }
        }
        return this.badgeTemplate;
    }

    private computeBadgeTemplate(): HTMLElement {
        const container = this.getExplorerContainer();
        if (container) {
            const native = container.querySelector<HTMLElement>('.nav-folder-title-badge, .nav-file-tag');
            if (native) {
                const clone = native.cloneNode(false) as HTMLElement;
                clone.textContent = '';
                return clone;
            }
        }

        const fallback = document.createElement('div');
        fallback.className = 'nav-folder-title-badge nav-file-tag';
        fallback.dataset.obsidianrFallback = 'true';
        return fallback;
    }

    private getExplorerContainer(): HTMLElement | null {
        const explorer = this.getFileExplorerView();
        if (!explorer) {
            return null;
        }
        const container = (explorer as unknown as { containerEl?: HTMLElement; }).containerEl;
        if (container instanceof HTMLElement) {
            return container;
        }
        return null;
    }

    private resolveTitleContainer(item: FileExplorerItem): { containerEl: HTMLElement | null; source: string; } {
        if (item.titleInnerEl instanceof HTMLElement) {
            return { containerEl: item.titleInnerEl, source: 'titleInnerEl' };
        }

        if (item.titleEl instanceof HTMLElement) {
            const inner = item.titleEl.querySelector<HTMLElement>('.nav-folder-title-content');
            if (inner) {
                item.titleInnerEl = inner;
                return { containerEl: inner, source: 'titleEl.querySelector' };
            }
            return { containerEl: item.titleEl, source: 'titleEl' };
        }

        if (item.el instanceof HTMLElement) {
            const inner = item.el.querySelector<HTMLElement>('.nav-folder-title-content');
            if (inner) {
                item.titleInnerEl = inner;
                return { containerEl: inner, source: 'el.querySelector' };
            }
            return { containerEl: item.el, source: 'el' };
        }

        if (item.selfEl instanceof HTMLElement) {
            const inner = item.selfEl.querySelector<HTMLElement>('.nav-folder-title-content');
            if (inner) {
                item.titleInnerEl = inner;
                return { containerEl: inner, source: 'selfEl.querySelector' };
            }
            return { containerEl: item.selfEl, source: 'selfEl' };
        }

        const fromDom = this.queryFolderTitleByPath(item.file?.path ?? '');
        if (fromDom) {
            return { containerEl: fromDom, source: 'querySelector' };
        }

        return { containerEl: null, source: 'unresolved' };
    }

    private resolveFolderElement(item: FileExplorerItem): HTMLElement | undefined {
        if (item.el instanceof HTMLElement) {
            return item.el;
        }
        if (item.titleEl instanceof HTMLElement) {
            return item.titleEl;
        }
        if (item.selfEl instanceof HTMLElement) {
            return item.selfEl;
        }
        const fromDom = this.queryFolderTitleByPath(item.file?.path ?? '', true);
        if (fromDom) {
            return fromDom;
        }
        return undefined;
    }

    private queryFolderTitleByPath(path: string, returnWrapper = false): HTMLElement | null {
        if (!path) {
            return null;
        }

        const selector = `[data-path="${escapeForAttribute(path)}"]`;
        const target = document.querySelector<HTMLElement>(selector);
        if (!target) {
            return null;
        }
        if (returnWrapper) {
            return target;
        }
        const inner = target.querySelector<HTMLElement>('.nav-folder-title-content');
        return inner ?? target;
    }

    private shouldIgnoreExplorerMutations(mutations: MutationRecord[]): boolean {
        if (mutations.length === 0) {
            return true;
        }
        return mutations.every((mutation) => this.isBadgeOnlyMutation(mutation));
    }

    private isBadgeOnlyMutation(mutation: MutationRecord): boolean {
        if (mutation.type !== 'childList') {
            return false;
        }

        const addedOk = Array.from(mutation.addedNodes).every((node) => this.isBadgeNode(node));
        const removedOk = Array.from(mutation.removedNodes).every((node) => this.isBadgeNode(node));

        return addedOk && removedOk;
    }

    private isBadgeNode(node: Node): boolean {
        if (node.nodeType !== Node.ELEMENT_NODE) {
            return false;
        }
        const element = node as HTMLElement;
        return element.classList.contains(BOOK_PILL_BASE_CLASS);
    }

    private extractBookTitle(frontmatter: Frontmatter): string | null {
        if (!frontmatter) {
            return null;
        }
        const keys = ['book', 'series', 'collection', 'title', 'name'];
        for (const key of keys) {
            const value = frontmatter[key];
            if (typeof value === 'string' && value.trim().length > 0) {
                return value;
            }
        }
        return null;
    }

    private extractTypeHint(frontmatter: Frontmatter): string | null {
        if (!frontmatter) {
            return null;
        }
        const value = frontmatter.type ?? frontmatter.category ?? frontmatter.kind;
        if (!value) {
            return null;
        }
        const normalized = value.toString().toLowerCase().trim();
        if (['chapter', 'chapitre', 'part', 'section'].includes(normalized)) {
            return normalized;
        }
        return null;
    }

    private extractChapterOrder(frontmatter: Frontmatter, file: TFile): number {
        const keys = ['chapter', 'order', 'index', 'position', 'no', 'number'];
        if (frontmatter) {
            for (const key of keys) {
                const value = frontmatter[key];
                if (typeof value === 'number') {
                    return value;
                }
                if (typeof value === 'string') {
                    const parsed = Number(value);
                    if (!Number.isNaN(parsed)) {
                        return parsed;
                    }
                }
            }
        }
        return Number.MAX_SAFE_INTEGER - Math.abs(this.hashString(file.path));
    }

    private extractChapterTitle(frontmatter: Frontmatter, file: TFile): string {
        const keys = ['chapterTitle', 'chapter_name', 'title', 'name'];
        if (frontmatter) {
            for (const key of keys) {
                const value = frontmatter[key];
                if (typeof value === 'string') {
                    const trimmed = value.trim();
                    if (trimmed.length > 0) {
                        return trimmed;
                    }
                }
            }
        }
        return file.basename;
    }

    private prettifyFolderName(name: string): string {
        const cleaned = name
            .replace(/^[0-9]+[\s_-]*/, '')
            .replace(/[_-]+/g, ' ')
            .replace(/\s+/g, ' ')
            .trim();
        return cleaned.length > 0 ? cleaned : name;
    }

    private async tryParseFrontmatter(file: TFile): Promise<Record<string, unknown> | null> {
        try {
            const content = await this.plugin.app.vault.cachedRead(file);
            if (!content.startsWith('---')) {
                return null;
            }
            const endMarkerIndex = content.indexOf('\n---', 3);
            if (endMarkerIndex === -1) {
                return null;
            }
            const raw = content.slice(3, endMarkerIndex).trim();
            if (raw.length === 0) {
                return null;
            }
            const parsed = parseYaml(raw);
            if (parsed && typeof parsed === 'object') {
                return parsed as Record<string, unknown>;
            }
        } catch (error) {
            console.warn('[ObsidianR] Failed to parse frontmatter for', file.path, error);
        }
        return null;
    }

    private hashString(value: string): number {
        let hash = 0;
        for (let i = 0; i < value.length; i += 1) {
            hash = (hash << 5) - hash + value.charCodeAt(i);
            hash |= 0;
        }
        return hash;
    }
}

export function createBookCatalog(plugin: ObsidianRPlugin): BookCatalog {
    return new BookCatalog(plugin);
}
