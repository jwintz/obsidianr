import { Plugin, WorkspaceLeaf, addIcon } from 'obsidian';
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

    async onload(): Promise<void> {
        await this.loadSettings();

        this.state = new ReaderState(createInitialState());
        this.syncStateWithSettings();

        this.reader = createReaderManager(this, this.state);
        this.commands = createCommandCenter(this, this.reader, this.state);
        this.commands.register();

        this.books = createBookCatalog(this);
        await this.books.initialize();

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
        this.books?.dispose();
    }

    async loadSettings(): Promise<void> {
        const loaded = await this.loadData();
        this.settings = Object.assign({}, DEFAULT_SETTINGS, loaded);
    }

    async saveSettings(): Promise<void> {
        await this.saveData(this.settings);
        this.syncStateWithSettings();
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
            fontFamily: this.settings.fontFamily
        };
    }

    private handleActiveLeafChange(leaf: WorkspaceLeaf | null): void {
        this.reader.onActiveLeafChange(leaf);
    }
}
