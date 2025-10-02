import { Plugin, WorkspaceLeaf, TFile, addIcon, debounce } from 'obsidian';
import { ReaderManager, createReaderManager } from './reader/manager';
import {
    createInitialState,
    ReaderParameters,
    ReaderState
} from './core/state';
import {
    DEFAULT_SETTINGS,
    ObsidianRSettingTab,
    ObsidianRSettings
} from './settings';
import {
    CommandCenter,
    createCommandCenter
} from './core/commands';
import { BookCatalog, createBookCatalog } from './books';
import { ReaderPanelManager, createPanelManager } from './reader/panels/manager';
import { normalizeFontFamily } from './core/fonts';
import { BookmarkStore } from './reader/bookmarks';
import { normalizePersistedData, DATA_VERSION } from './core/data';
import { ReadingStatisticsTracker } from './reader/panels/statistics-tracker';

const RIBBON_ICON_ID = 'obsidianr-book-open';

addIcon(
    RIBBON_ICON_ID,
    `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M2 4h7a4 4 0 0 1 4 4v12"/><path d="M22 4h-7a4 4 0 0 0-4 4v12"/><path d="M2 6v14a2 2 0 0 0 2 2h7"/><path d="M22 6v14a2 2 0 0 1-2 2h-7"/></svg>`
);

export default class ObsidianRPlugin extends Plugin {
    settings: ObsidianRSettings = DEFAULT_SETTINGS;
    state!: ReaderState;
    reader!: ReaderManager;
    commands!: CommandCenter;
    books!: BookCatalog;
    panels!: ReaderPanelManager;
    bookmarkStore!: BookmarkStore;
    statisticsTracker!: ReadingStatisticsTracker;

    private saveDataDebounced: (() => void) | null = null;

    async onload(): Promise<void> {
        await this.initializeData();

        this.state = new ReaderState(createInitialState());
        this.syncStateWithSettings();

        this.reader = createReaderManager(this, this.state);
        this.commands = createCommandCenter(this, this.reader, this.state);
        this.commands.register();

        this.books = createBookCatalog(this);
        await this.books.initialize();

        this.panels = createPanelManager(this, this.state, this.bookmarkStore, this.statisticsTracker);

        this.addSettingTab(new ObsidianRSettingTab(this.app, this));

        this.addRibbonIcon(RIBBON_ICON_ID, 'Toggle reader mode', () => {
            this.reader.toggleReaderMode();
        });

        this.registerEvent(
            this.app.workspace.on('active-leaf-change', (leaf) =>
                this.handleActiveLeafChange(leaf)
            )
        );

        this.registerEvent(
            this.app.workspace.on('file-open', (file) => {
                if (!this.state.snapshot.active) {
                    return;
                }
                if (file && this.state.snapshot.currentFile !== file) {
                    this.state.update({ currentFile: file, currentPage: 0 });
                    this.reader.refreshCurrentView(false);
                }
            })
        );
    }

    onunload(): void {
        if (this.reader) {
            this.reader.disableReaderMode();
        }
        void this.saveDataBundle();
        this.panels?.dispose();
        this.books?.dispose();
    }

    async saveSettings(): Promise<void> {
        this.settings.fontFamily = normalizeFontFamily(this.settings.fontFamily);
        this.syncStateWithSettings();
        this.requestSave();
    }

    refreshReaderModeIfActive(): void {
        this.syncStateWithSettings();
        this.reader?.refreshCurrentView();
    }

    increaseFontTemporarily(): void {
        this.reader.increaseFont();
    }

    decreaseFontTemporarily(): void {
        this.reader.decreaseFont();
    }

    isPageBookmarked(file: TFile | null, page: number): boolean {
        return this.panels?.isPageBookmarked(file, page) ?? false;
    }

    toggleBookmarkFor(file: TFile | null, page: number): boolean {
        return this.panels?.toggleBookmark(file, page) ?? false;
    }

    openChapter(target: TFile, page?: number | 'last'): Promise<void> {
        if (!target || !this.reader) {
            return Promise.resolve();
        }
        return this.reader.openChapter(target, page ?? 0);
    }

    requestSave(): void {
        if (!this.saveDataDebounced) {
            return;
        }
        this.saveDataDebounced();
    }

    private syncStateWithSettings(): void {
        if (!this.state) {
            return;
        }
        const parameters = this.settingsToParameters();
        this.state.updateParameters(parameters);
    }

    private settingsToParameters(): ReaderParameters {
        return {
            fontSize: this.settings.fontSize,
            lineSpacing: this.settings.lineSpacing,
            letterSpacing: this.settings.characterSpacing,
            wordSpacing: this.settings.wordSpacing,
            columns: this.settings.columns,
            horizontalMargins: this.settings.horizontalMargins,
            justified: this.settings.justified,
            transitionType: this.settings.transitionType,
            fontFamily: normalizeFontFamily(this.settings.fontFamily)
        };
    }

    private handleActiveLeafChange(leaf: WorkspaceLeaf | null): void {
        this.reader.onActiveLeafChange(leaf);
    }

    private async initializeData(): Promise<void> {
        const raw = normalizePersistedData(await this.loadData());
        this.settings = Object.assign({}, DEFAULT_SETTINGS, raw.settings);
        this.settings.fontFamily = normalizeFontFamily(this.settings.fontFamily);
        this.bookmarkStore = new BookmarkStore(raw.bookmarks);
        this.statisticsTracker = new ReadingStatisticsTracker(raw.statistics);
        this.saveDataDebounced = debounce(() => {
            void this.saveDataBundle();
        }, 800);
    }

    private async saveDataBundle(): Promise<void> {
        const payload = {
            version: DATA_VERSION,
            settings: this.settings,
            bookmarks: this.bookmarkStore?.serialize() ?? [],
            statistics: this.statisticsTracker?.serialize() ?? { history: [], activeSession: null }
        };
        await this.saveData(payload);
    }
}
