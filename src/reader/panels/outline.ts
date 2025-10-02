import type { TFile, WorkspaceLeaf } from 'obsidian';
import type ObsidianRPlugin from '../../main';
import type { BookInfo } from '../../books';

const WRAPPER_CLASS = 'obsidianr-outline-wrapper';
const ACTIVE_CLASS = 'is-active';
const PREVIEW_LENGTH = 220;

export class OutlinePanelController {
    private wrapperEl: HTMLElement | null = null;
    private leaf: WorkspaceLeaf | null = null;
    private previewTickets: Map<string, number> = new Map();
    private ticketCounter = 0;

    constructor(private readonly plugin: ObsidianRPlugin) { }

    attach(leaf: WorkspaceLeaf): void {
        if (this.leaf === leaf && this.wrapperEl) {
            return;
        }
        this.detach();
        this.leaf = leaf;
        const container = this.resolveHostContainer(leaf);
        if (!container) {
            return;
        }
        const wrapper = container.ownerDocument.createElement('div');
        wrapper.classList.add(WRAPPER_CLASS);
        container.insertBefore(wrapper, container.firstChild);
        this.wrapperEl = wrapper;
    }

    detach(): void {
        if (this.wrapperEl) {
            this.wrapperEl.remove();
            this.wrapperEl = null;
        }
        this.leaf = null;
        this.previewTickets.clear();
    }

    update(book: BookInfo | null, activeFile: TFile | null): void {
        if (!this.wrapperEl) {
            return;
        }
        const doc = this.wrapperEl.ownerDocument;
        this.wrapperEl.replaceChildren();

        const header = doc.createElement('div');
        header.classList.add('obsidianr-outline-header');
        header.textContent = 'Book contents';
        this.wrapperEl.appendChild(header);

        if (!book) {
            const emptyState = doc.createElement('div');
            emptyState.classList.add('obsidianr-outline-empty');
            emptyState.textContent = 'Open a book chapter to view its table of contents.';
            this.wrapperEl.appendChild(emptyState);
            return;
        }

        const list = doc.createElement('ul');
        list.classList.add('obsidianr-outline-list');

        for (const chapter of book.chapters) {
            const item = doc.createElement('li');
            item.classList.add('obsidianr-outline-item');

            if (activeFile && chapter.file.path === activeFile.path) {
                item.classList.add(ACTIVE_CLASS);
            }

            const card = doc.createElement('div');
            card.classList.add('obsidianr-card', 'obsidianr-outline-card');
            card.setAttribute('role', 'button');
            card.tabIndex = 0;

            const title = doc.createElement('div');
            title.classList.add('obsidianr-card-title');
            title.textContent = chapter.title;
            card.appendChild(title);

            const meta = doc.createElement('div');
            meta.classList.add('obsidianr-card-meta');
            meta.textContent = chapter.file.basename;
            card.appendChild(meta);

            const preview = doc.createElement('div');
            preview.classList.add('obsidianr-card-preview');
            preview.textContent = '…';
            card.appendChild(preview);
            this.loadPreview(chapter.file, preview);

            const openChapter = () => {
                void this.plugin.openChapter(chapter.file, 0);
            };

            card.addEventListener('pointerdown', (event) => {
                event.stopPropagation();
            });
            card.addEventListener('click', (event) => {
                event.preventDefault();
                event.stopPropagation();
                openChapter();
            });
            card.addEventListener('keydown', (event) => {
                if (event.key === 'Enter' || event.key === ' ') {
                    event.preventDefault();
                    event.stopPropagation();
                    openChapter();
                }
            });

            item.appendChild(card);
            list.appendChild(item);
        }

        this.wrapperEl.appendChild(list);
    }

    private resolveHostContainer(leaf: WorkspaceLeaf): HTMLElement | null {
        const view = leaf.view as { containerEl?: HTMLElement; };
        const container = view.containerEl;
        if (!container) {
            return null;
        }
        return container.querySelector('.nav-outline') ?? container.querySelector('.tree-container') ?? container;
    }

    private loadPreview(file: TFile, target: HTMLElement): void {
        const ticket = ++this.ticketCounter;
        this.previewTickets.set(file.path, ticket);

        void this.plugin.app.vault.cachedRead(file)
            .then((raw) => {
                if (this.previewTickets.get(file.path) !== ticket) {
                    return;
                }
                target.textContent = this.extractPreview(raw);
            })
            .catch(() => {
                if (this.previewTickets.get(file.path) === ticket) {
                    target.textContent = '';
                }
            })
            .finally(() => {
                if (this.previewTickets.get(file.path) === ticket) {
                    this.previewTickets.delete(file.path);
                }
            });
    }

    private extractPreview(raw: string): string {
        if (!raw) {
            return '';
        }
        const sanitized = raw
            .replace(/^---\s*[\s\S]*?\n---\s*/m, ' ')
            .replace(/```[\s\S]*?```/g, ' ')
            .replace(/<[^>]+>/g, ' ')
            .replace(/\r/g, '');

        const lines = sanitized.split(/\n/);
        const paragraphs: string[] = [];
        let current: string[] = [];

        const flush = () => {
            if (current.length === 0) {
                return;
            }
            const merged = current.join(' ').trim();
            if (merged) {
                paragraphs.push(merged);
            }
            current = [];
        };

        for (const rawLine of lines) {
            const line = rawLine.trim();
            if (!line) {
                flush();
                continue;
            }
            if (/^#{1,6}\s+/.test(line) || /^={3,}$/.test(line) || /^-{3,}$/.test(line)) {
                flush();
                continue;
            }
            if (/^\d+[.)]?$/.test(line)) {
                flush();
                continue;
            }
            const words = line.split(/\s+/);
            if (line.length < 16 && words.length < 4) {
                flush();
                continue;
            }
            current.push(line.replace(/^>\s*/, ''));
        }
        flush();

        const candidate = paragraphs.find((text) => this.hasEnoughContent(text))
            ?? paragraphs[0]
            ?? '';

        return candidate ? this.formatSnippet(candidate) : '';
    }

    private formatSnippet(source: string): string {
        const normalized = source
            .replace(/!\[[^\]]*\]\([^)]*\)/g, ' ')
            .replace(/\[([^\]]+)\]\([^)]*\)/g, '$1')
            .replace(/\*\*([^*]+)\*\*/g, '$1')
            .replace(/\*([^*]+)\*/g, '$1')
            .replace(/_([^_]+)_/g, '$1')
            .replace(/`+/g, '')
            .replace(/\s+/g, ' ')
            .trim();

        if (!normalized) {
            return '';
        }

        const sentences = normalized.match(/[^.!?]+[.!?]*/g) ?? [normalized];
        let assembled = '';
        let count = 0;
        for (const rawSentence of sentences) {
            const sentence = rawSentence.trim();
            if (!sentence) {
                continue;
            }
            assembled = assembled ? `${assembled} ${sentence}` : sentence;
            if (/[.!?]$/.test(sentence)) {
                count += 1;
            } else if (count === 0) {
                count = 1;
            }
            if (assembled.length >= PREVIEW_LENGTH || count >= 2) {
                break;
            }
        }

        const result = assembled || normalized;
        if (result.length <= PREVIEW_LENGTH) {
            return result;
        }
        return `${result.slice(0, PREVIEW_LENGTH - 1).trim()}…`;
    }

    private hasEnoughContent(text: string): boolean {
        const words = text.split(/\s+/).filter(Boolean);
        return text.length >= 60 || words.length >= 8;
    }
}
