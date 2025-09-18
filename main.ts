import { Plugin, TFile, TFolder, PluginSettingTab, App, Setting, Command, Notice, WorkspaceLeaf } from 'obsidian';

interface BookStructure {
    folder: TFolder;
    mainFile: TFile;
    imageFile: TFile | null;
    chapters: TFile[];
    title: string;
}

interface ObsidianRSettings {
    // Transitions
    transitionType: 'page-curl' | 'slide' | 'fade' | 'scroll';

    // Format
    justified: boolean;
    horizontalMargins: number; // percentage of width
    columns: number;
    lineSpacing: number; // multiplier (1.0 = normal, 1.5 = 1.5x spacing)
    characterSpacing: number; // em units
    wordSpacing: number; // multiplier (1.0 = normal)

    // Reader Mode
    fontSize: number; // base font size in px
    fontFamily: string;
    showToc: boolean;
    showBookmarks: boolean;
    showStats: boolean;
}

interface ReaderModeState {
    isActive: boolean;
    currentBook: BookStructure | null;
    currentChapter: TFile | null;
    currentPage: number;
    totalPages: number;
    chapterPage: number;
    chapterTotalPages: number;
}const DEFAULT_SETTINGS: ObsidianRSettings = {
    transitionType: 'page-curl',
    justified: true,
    horizontalMargins: 10, // 10% margins
    columns: 1,
    lineSpacing: 1.0,
    characterSpacing: 0.0,
    wordSpacing: 1.0,
    fontSize: 16,
    fontFamily: 'Charter',
    showToc: false,
    showBookmarks: false,
    showStats: false
}; export default class ObsidianRPlugin extends Plugin {
    settings: ObsidianRSettings;
    private detectedBooks: Map<string, BookStructure> = new Map();
    private readerModeState: ReaderModeState = {
        isActive: false,
        currentBook: null,
        currentChapter: null,
        currentPage: 1,
        totalPages: 1,
        chapterPage: 1,
        chapterTotalPages: 1
    };
    private readerModeEl: HTMLElement | null = null;
    private controlsEl: HTMLElement | null = null;
    private hideControlsTimeout: number | null = null;
    private readerClickHandler: ((event: Event) => void) | null = null;
    private readerKeyboardHandler: ((event: KeyboardEvent) => void) | null = null;
    private zenMode: boolean = false;

    async onload() {
        console.log('Loading Obsidian:R plugin');

        // Load settings
        await this.loadSettings();

        // Add settings tab
        this.addSettingTab(new ObsidianRSettingTab(this.app, this));

        // Add commands
        this.addCommand({
            id: 'toggle-reader-mode',
            name: 'Toggle Reader Mode',
            callback: () => this.toggleReaderMode(),
            hotkeys: []
        });

        // Add escape command for reader mode (no hotkey - using direct handler)
        this.addCommand({
            id: 'exit-reader-mode',
            name: 'Exit Reader Mode',
            callback: () => {
                console.log('Exit Reader Mode command triggered, reader mode active:', this.readerModeState.isActive);
                if (this.readerModeState.isActive) {
                    this.exitReaderMode();
                } else {
                    console.log('Reader mode not active, ignoring exit command');
                }
            }
        });

        // Add font size commands (no hotkeys - using direct handler)
        this.addCommand({
            id: 'increase-font-size',
            name: 'Increase Font Size',
            callback: () => {
                console.log('Increase Font Size command triggered, reader mode active:', this.readerModeState.isActive);
                if (this.readerModeState.isActive) {
                    this.adjustFontSize(1);
                } else {
                    console.log('Reader mode not active, ignoring font size command');
                }
            }
        });

        this.addCommand({
            id: 'decrease-font-size',
            name: 'Decrease Font Size',
            callback: () => {
                console.log('Decrease Font Size command triggered, reader mode active:', this.readerModeState.isActive);
                if (this.readerModeState.isActive) {
                    this.adjustFontSize(-1);
                } else {
                    console.log('Reader mode not active, ignoring font size command');
                }
            }
        });

        // Initial scan for books
        await this.scanForBooks();        // Listen for file/folder changes
        this.registerEvent(
            this.app.vault.on('create', () => {
                this.scanForBooks().then(() => {
                    setTimeout(() => this.updateFileExplorerDecorations(), 100);
                });
            })
        );
        this.registerEvent(
            this.app.vault.on('delete', () => {
                this.scanForBooks().then(() => {
                    setTimeout(() => this.updateFileExplorerDecorations(), 100);
                });
            })
        );
        this.registerEvent(
            this.app.vault.on('rename', () => {
                this.scanForBooks().then(() => {
                    setTimeout(() => this.updateFileExplorerDecorations(), 100);
                });
            })
        );

        // Listen for active file changes to update reader mode pills
        this.registerEvent(
            this.app.workspace.on('active-leaf-change', () => {
                if (this.readerModeState.isActive) {
                    this.updateReaderModeForCurrentFile();
                }
            })
        );

        // Add file explorer decorations
        this.addFileExplorerDecorations();
    }

    onunload() {
        console.log('Unloading Obsidian:R plugin');
        this.detectedBooks.clear();
        this.exitReaderMode();
    }    /**
     * Scans the vault for book structures
     * Books have the pattern:
     * [Title]/
     *   [Title].md
     *   [Title].(png|jpg|jpeg)
     *   [Title] - Chapter 1.md
     *   ...
     *   [Title] - (Epilogue|Prologue).md # Optional
     */
    private async scanForBooks(): Promise<void> {
        this.detectedBooks.clear();

        const folders = this.app.vault.getAllLoadedFiles()
            .filter(file => file instanceof TFolder) as TFolder[];

        for (const folder of folders) {
            const bookStructure = await this.analyzeFolder(folder);
            if (bookStructure) {
                this.detectedBooks.set(folder.path, bookStructure);
            }
        }

        console.log(`Detected ${this.detectedBooks.size} books:`,
            Array.from(this.detectedBooks.keys()));
    }

    /**
     * Analyzes a folder to determine if it contains a book structure
     */
    private async analyzeFolder(folder: TFolder): Promise<BookStructure | null> {
        const folderName = folder.name;
        const children = folder.children;

        // Look for main book file: [Title].md
        const mainFile = children.find(child =>
            child instanceof TFile &&
            child.extension === 'md' &&
            child.basename === folderName
        ) as TFile;

        if (!mainFile) {
            return null;
        }

        // Look for image file: [Title].(png|jpg|jpeg)
        const imageExtensions = ['png', 'jpg', 'jpeg'];
        const imageFile = children.find(child =>
            child instanceof TFile &&
            imageExtensions.includes(child.extension) &&
            child.basename === folderName
        ) as TFile || null;

        // Look for chapter files with flexible patterns
        const chapterPatterns = [
            // Standard: [Title] - Chapter X.md
            new RegExp(`^${this.escapeRegex(folderName)} - (Chapter \\d+|Epilogue|Prologue)$`),
            // Alternative: [Title] - Chapitre X.md (French)
            new RegExp(`^${this.escapeRegex(folderName)} - (Chapitre \\d+|Épilogue|Prologue)$`),
            // Part-based: [Title] - Part X - Chapter Y.md
            new RegExp(`^${this.escapeRegex(folderName)} - Part \\d+ - .+$`),
            // Direct numbering: [Title] - X.md
            new RegExp(`^${this.escapeRegex(folderName)} - \\d+$`),
            // Any file that starts with [Title] - and has content (but exclude main file)
            new RegExp(`^${this.escapeRegex(folderName)} - .+$`)
        ];

        let chapters: TFile[] = [];

        // Try each pattern until we find chapters
        for (const pattern of chapterPatterns) {
            const foundChapters = children.filter(child => {
                if (!(child instanceof TFile)) return false;
                if (child.extension !== 'md') return false;
                if (child.basename === folderName) return false; // Exclude the main file
                return pattern.test(child.basename);
            }) as TFile[];

            if (foundChapters.length > 0) {
                chapters = foundChapters;
                break;
            }
        }

        // A book needs at least the main file and one chapter
        if (chapters.length === 0) {
            return null;
        }

        return {
            folder,
            mainFile,
            imageFile,
            chapters: this.sortChapters(chapters),
            title: folderName
        };
    }

    /**
     * Sorts chapter files in logical order
     */
    private sortChapters(chapters: TFile[]): TFile[] {
        return chapters.sort((a, b) => {
            const aBasename = a.basename;
            const bBasename = b.basename;

            // Prologue comes first
            if (aBasename.includes('Prologue')) return -1;
            if (bBasename.includes('Prologue')) return 1;

            // Epilogue comes last
            if (aBasename.includes('Epilogue')) return 1;
            if (bBasename.includes('Epilogue')) return -1;

            // Extract chapter numbers for regular chapters
            const aMatch = aBasename.match(/Chapter (\d+)/);
            const bMatch = bBasename.match(/Chapter (\d+)/);

            if (aMatch && bMatch) {
                return parseInt(aMatch[1]) - parseInt(bMatch[1]);
            }

            // Fallback to alphabetical
            return aBasename.localeCompare(bBasename);
        });
    }

    /**
     * Escapes special regex characters in a string
     */
    private escapeRegex(string: string): string {
        return string.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    }

    /**
     * Adds BOOK pill decorations to the file explorer
     */
    private addFileExplorerDecorations(): void {
        // Update decorations when layout changes
        this.registerEvent(
            this.app.workspace.on('layout-change', () => {
                setTimeout(() => this.updateFileExplorerDecorations(), 200);
            })
        );

        // Also update on active leaf change (when switching between files)
        this.registerEvent(
            this.app.workspace.on('active-leaf-change', () => {
                setTimeout(() => this.updateFileExplorerDecorations(), 200);
            })
        );

        // Update multiple times to catch different loading states
        setTimeout(() => this.updateFileExplorerDecorations(), 500);
        setTimeout(() => this.updateFileExplorerDecorations(), 1500);
        setTimeout(() => this.updateFileExplorerDecorations(), 3000);
        setTimeout(() => this.updateFileExplorerDecorations(), 5000);

        // Also trigger when the workspace layout is ready
        this.app.workspace.onLayoutReady(() => {
            setTimeout(() => this.updateFileExplorerDecorations(), 1000);
        });
    }

    /**
     * Updates BOOK pill decorations in the file explorer
     */
    private updateFileExplorerDecorations(): void {
        // Get all detected book folder names for easier lookup
        const bookFolderNames = new Set(
            Array.from(this.detectedBooks.keys()).map(path => path.split('/').pop()).filter(Boolean)
        );

        console.log('Updating file explorer decorations. Detected books:', Array.from(bookFolderNames));

        // First, remove all existing BOOK pills to avoid duplicates
        document.querySelectorAll('.book-pill').forEach(pill => pill.remove());

        // Find all nav-folder elements with more patience
        const folderElements = document.querySelectorAll('.nav-folder');
        console.log('Found folder elements:', folderElements.length);

        folderElements.forEach((folderElement) => {
            const titleElement = folderElement.querySelector('.nav-folder-title-content');
            if (!titleElement) return;

            const folderName = titleElement.textContent;
            if (!folderName) return;

            // Check if this folder name matches any detected book folder
            const isBook = bookFolderNames.has(folderName);
            console.log(`Folder "${folderName}": isBook=${isBook}`);

            if (isBook) {
                this.addBookPill(folderElement as HTMLElement);
            }
        });
    }

    /**
     * Gets the folder name from a folder DOM element
     * We only need the folder name now, not the full path
     */
    private getFolderNameFromElement(folderElement: HTMLElement): string {
        const titleElement = folderElement.querySelector('.nav-folder-title-content');
        return titleElement?.textContent || '';
    }

    /**
     * Adds a BOOK pill to a folder element
     */
    private addBookPill(folderElement: HTMLElement): void {
        // Check if pill already exists
        if (folderElement.querySelector('.book-pill')) {
            return;
        }

        const titleElement = folderElement.querySelector('.nav-folder-title');
        if (!titleElement) {
            return;
        }

        // Create the pill element matching Obsidian's native nav-file-tag styling
        const pill = document.createElement('span');
        pill.className = 'book-pill nav-file-tag';
        pill.textContent = 'BOOK';

        // Remove custom styling to let Obsidian's CSS handle it
        // The nav-file-tag class will automatically apply the correct styling

        titleElement.appendChild(pill);
    }

    /**
     * Removes a BOOK pill from a folder element
     */
    private removeBookPill(folderElement: HTMLElement): void {
        const pill = folderElement.querySelector('.book-pill');
        if (pill) {
            pill.remove();
        }
    }

    /**
     * Toggles reader mode on/off
     */
    async toggleReaderMode() {
        if (this.readerModeState.isActive) {
            this.exitReaderMode();
        } else {
            await this.enterReaderMode();
        }
    }

    /**
     * Enters reader mode for the current book
     */
    async enterReaderMode() {
        console.log('Entering reader mode...');
        const activeFile = this.app.workspace.getActiveFile();
        if (!activeFile) {
            console.log('No active file found');
            new Notice('No file is currently open');
            return;
        }

        console.log('Active file:', activeFile.path);

        // Check if the current file is part of a book
        const book = this.findBookForFile(activeFile);
        if (!book) {
            console.log('File is not part of a detected book');
            new Notice('Current file is not part of a detected book');
            return;
        }

        console.log('Found book:', book.title);

        this.readerModeState.isActive = true;
        this.readerModeState.currentBook = book;
        this.readerModeState.currentChapter = activeFile;

        console.log('Reader mode state set to active');

        // Calculate page numbers
        await this.calculatePageNumbers();

        // Create reader mode UI
        this.createReaderModeUI();
        this.showReaderControls();

        // Add reader mode keyboard handlers
        this.addReaderModeKeyboardHandlers();

        console.log('Reader mode UI created and controls shown');
        new Notice('Reader mode activated');
    }

    /**
     * Exits reader mode
     */
    exitReaderMode() {
        console.log('Exiting reader mode...');
        if (!this.readerModeState.isActive) {
            console.log('Reader mode not active, nothing to exit');
            return;
        }

        this.readerModeState.isActive = false;
        this.readerModeState.currentBook = null;
        this.readerModeState.currentChapter = null;

        console.log('Reader mode state cleared');

        // Restore UI elements if zen mode was enabled
        if (this.zenMode) {
            this.restoreZenMode();
        }

        // Remove reader mode keyboard handlers
        this.removeReaderModeKeyboardHandlers();

        // Clean up UI
        this.destroyReaderModeUI();

        console.log('Reader mode UI destroyed');
        new Notice('Reader mode deactivated');
    }

    /**
     * Finds the book that contains the given file
     */
    private findBookForFile(file: TFile): BookStructure | null {
        for (const book of this.detectedBooks.values()) {
            if (book.mainFile === file || book.chapters.includes(file)) {
                return book;
            }
        }
        return null;
    }

    /**
     * Creates the reader mode UI - pills and controls only, no overlay
     */
    private createReaderModeUI() {
        if (this.readerModeEl) return;

        console.log('Creating reader mode UI without blocking overlay...');

        // Create a container just for reference, but don't add it to DOM
        this.readerModeEl = document.createElement('div');
        this.readerModeEl.className = 'obsidian-r-reader-mode-container';

        // Create click handler for showing controls
        this.readerClickHandler = (e: Event) => {
            if (this.readerModeState.isActive) {
                const target = e.target as HTMLElement;
                if (!target.closest('.obsidian-r-controls')) {
                    this.showReaderControls();
                }
            }
        };

        document.addEventListener('click', this.readerClickHandler);
        document.addEventListener('touchstart', this.readerClickHandler);

        // Create top pill (chapter progress) and append to active tab
        const topPill = document.createElement('div');
        topPill.className = 'obsidian-r-top-pill';
        topPill.textContent = `${this.readerModeState.chapterPage}/${this.readerModeState.chapterTotalPages}`;
        this.appendPillToActiveTab(topPill);

        // Create bottom pill (total progress) and append to active tab
        const bottomPill = document.createElement('div');
        bottomPill.className = 'obsidian-r-bottom-pill';
        bottomPill.textContent = `${this.readerModeState.currentPage}/${this.readerModeState.totalPages}`;
        this.appendPillToActiveTab(bottomPill);

        // Store pills for later cleanup
        this.readerModeEl.appendChild(topPill.cloneNode(true));
        this.readerModeEl.appendChild(bottomPill.cloneNode(true));

        // Create controls overlay
        this.createReaderControls();

        // Update pills with calculated values
        this.updatePills();

        console.log('Reader mode UI created - sidebars should remain visible');
    }

    /**
     * Creates the reader controls overlay
     */
    private createReaderControls() {
        console.log('createReaderControls() called');
        if (this.controlsEl) {
            console.log('Controls element already exists, returning early');
            return;
        }

        console.log('Creating new controls element...');
        this.controlsEl = document.createElement('div');
        this.controlsEl.className = 'obsidian-r-controls';

        // Add mouse enter/leave handlers for hover behavior
        this.controlsEl.addEventListener('mouseenter', () => {
            this.cancelControlsHide();
        });

        this.controlsEl.addEventListener('mouseleave', () => {
            this.scheduleControlsHide();
        });

        // Bottom bar controls
        const bottomBar = document.createElement('div');
        bottomBar.className = 'obsidian-r-bottom-bar';

        // Font size controls
        const fontSizeGroup = document.createElement('div');
        fontSizeGroup.className = 'obsidian-r-font-size-group';

        const decreaseFontBtn = document.createElement('button');
        decreaseFontBtn.textContent = 'A-';
        decreaseFontBtn.title = 'Decrease font size';
        decreaseFontBtn.addEventListener('click', () => this.adjustFontSize(-1));

        const increaseFontBtn = document.createElement('button');
        increaseFontBtn.textContent = 'A+';
        increaseFontBtn.title = 'Increase font size';
        increaseFontBtn.addEventListener('click', () => this.adjustFontSize(1));

        fontSizeGroup.appendChild(decreaseFontBtn);
        fontSizeGroup.appendChild(increaseFontBtn);

        // Font family dropdown
        const fontSelect = document.createElement('select');
        fontSelect.className = 'obsidian-r-font-select';
        const fonts = ['Canela', 'Charter', 'Publico', 'New York', 'San Francisco', 'Palatino', 'Georgia', 'Iowan'];
        fonts.forEach(font => {
            const option = document.createElement('option');
            option.value = font;
            option.textContent = font;
            option.selected = font === this.settings.fontFamily;
            fontSelect.appendChild(option);
        });
        fontSelect.addEventListener('change', (e) => {
            const target = e.target as HTMLSelectElement;
            this.changeFontFamily(target.value);
        });

        // Pane toggles
        const paneGroup = document.createElement('div');
        paneGroup.className = 'obsidian-r-pane-group';

        const tocToggle = this.createPaneToggle('ToC', this.settings.showToc, (checked) => {
            this.settings.showToc = checked;
            this.saveSettings();
        });

        const bookmarksToggle = this.createPaneToggle('Bookmarks', this.settings.showBookmarks, (checked) => {
            this.settings.showBookmarks = checked;
            this.saveSettings();
        });

        const statsToggle = this.createPaneToggle('Stats', this.settings.showStats, (checked) => {
            this.settings.showStats = checked;
            this.saveSettings();
        });

        const zenToggle = this.createPaneToggle('Zen', this.zenMode, (checked) => {
            console.log('Zen toggle clicked, new state will be:', checked);
            this.zenMode = checked;
            this.toggleZenMode();
            this.saveSettings();
        });

        paneGroup.appendChild(tocToggle);
        paneGroup.appendChild(bookmarksToggle);
        paneGroup.appendChild(statsToggle);
        paneGroup.appendChild(zenToggle);

        bottomBar.appendChild(fontSizeGroup);
        bottomBar.appendChild(fontSelect);
        bottomBar.appendChild(paneGroup);

        this.controlsEl.appendChild(bottomBar);

        console.log('Controls element created, about to append to active tab...');
        // Append controls to the active workspace leaf container
        this.appendControlsToActiveTab();
    }

    /**
     * Appends controls to the active tab's viewport
     */
    private appendControlsToActiveTab() {
        const workspaceLeaf = this.app.workspace.activeLeaf;

        console.log('Active leaf:', workspaceLeaf);
        console.log('Leaf view:', workspaceLeaf?.view);

        // Try different approaches to find the right container
        let targetContainer: HTMLElement | null = null;

        // Approach 1: Try the workspace leaf view container
        if (workspaceLeaf?.view?.containerEl) {
            targetContainer = workspaceLeaf.view.containerEl;
            console.log('Using view containerEl:', targetContainer);
        }

        // Approach 2: Try finding the active tab container by class
        if (!targetContainer) {
            const activeTabContainer = document.querySelector('.workspace-tabs.mod-active .workspace-tab-container') as HTMLElement;
            if (activeTabContainer) {
                targetContainer = activeTabContainer;
                console.log('Using active tab container:', targetContainer);
            }
        }

        // Approach 3: Try finding the workspace leaf content
        if (!targetContainer) {
            const leafContent = document.querySelector('.workspace-leaf.mod-active .workspace-leaf-content') as HTMLElement;
            if (leafContent) {
                targetContainer = leafContent;
                console.log('Using leaf content:', targetContainer);
            }
        }

        if (targetContainer) {
            console.log('Appending controls to target container');
            console.log('Container element:', targetContainer);
            console.log('Container element classes:', targetContainer.className);

            // Add class to ensure relative positioning
            targetContainer.classList.add('has-obsidian-r-controls');
            targetContainer.appendChild(this.controlsEl!);

            console.log('Controls appended. ControlsEl:', this.controlsEl);
            console.log('Controls element display style:', this.controlsEl?.style.display);
            console.log('Controls element classes:', this.controlsEl?.className);
        } else {
            console.log('No suitable container found, falling back to document body');
            document.body.appendChild(this.controlsEl!);
        }
    }

    /**
     * Appends a pill to the active tab's viewport
     */
    private appendPillToActiveTab(pill: HTMLElement) {
        // Try different approaches to find the right container
        let targetContainer: HTMLElement | null = null;

        // Approach 1: Try finding the active tab container by class
        const activeTabContainer = document.querySelector('.workspace-tabs.mod-active .workspace-tab-container') as HTMLElement;
        if (activeTabContainer) {
            targetContainer = activeTabContainer;
            console.log('Using active tab container for pill:', targetContainer);
        }

        // Approach 2: Try finding the workspace leaf content
        if (!targetContainer) {
            const leafContent = document.querySelector('.workspace-leaf.mod-active .workspace-leaf-content') as HTMLElement;
            if (leafContent) {
                targetContainer = leafContent;
                console.log('Using leaf content for pill:', targetContainer);
            }
        }

        // Approach 3: Try the workspace leaf view container
        if (!targetContainer) {
            const workspaceLeaf = this.app.workspace.activeLeaf;
            if (workspaceLeaf?.view?.containerEl) {
                targetContainer = workspaceLeaf.view.containerEl;
                console.log('Using view containerEl for pill:', targetContainer);
            }
        }

        if (targetContainer) {
            console.log('Appending pill to target container:', pill.className);
            // Add class to ensure relative positioning
            targetContainer.classList.add('has-obsidian-r-controls');
            targetContainer.appendChild(pill);
        } else {
            console.log('No suitable container found for pill, falling back to document body');
            document.body.appendChild(pill);
        }
    }

    /**
     * Creates a pane toggle button/switch
     */
    private createPaneToggle(label: string, checked: boolean, onChange: (checked: boolean) => void): HTMLElement {
        const toggle = document.createElement('label');
        toggle.className = 'obsidian-r-pane-toggle';

        const checkbox = document.createElement('input');
        checkbox.type = 'checkbox';
        checkbox.checked = checked;
        checkbox.addEventListener('change', () => onChange(checkbox.checked));

        const span = document.createElement('span');
        span.textContent = label;

        toggle.appendChild(checkbox);
        toggle.appendChild(span);

        return toggle;
    }

    /**
     * Shows reader controls and auto-hide after 3 seconds
     */
    private showReaderControls() {
        if (!this.controlsEl) {
            console.log('No controlsEl found in showReaderControls');
            return;
        }

        console.log('Showing reader controls');
        console.log('Controls element before show:', this.controlsEl);
        console.log('Controls parent:', this.controlsEl.parentElement);

        this.controlsEl.style.display = 'block';
        this.controlsEl.classList.add('visible');

        console.log('Controls element after show - display:', this.controlsEl.style.display);
        console.log('Controls element after show - classes:', this.controlsEl.className);

        // Schedule auto-hide
        this.scheduleControlsHide();
    }

    /**
     * Schedules controls to hide after 3 seconds
     */
    private scheduleControlsHide() {
        // Clear existing timeout
        this.cancelControlsHide();

        // Auto-hide after 3 seconds
        this.hideControlsTimeout = window.setTimeout(() => {
            this.hideReaderControls();
        }, 3000);
    }

    /**
     * Cancels the scheduled controls hide
     */
    private cancelControlsHide() {
        if (this.hideControlsTimeout) {
            clearTimeout(this.hideControlsTimeout);
            this.hideControlsTimeout = null;
        }
    }

    /**
     * Hides reader controls
     */
    private hideReaderControls() {
        if (!this.controlsEl) return;

        this.controlsEl.classList.remove('visible');
        setTimeout(() => {
            if (this.controlsEl) {
                this.controlsEl.style.display = 'none';
            }
        }, 300); // Allow fade-out animation
    }

    /**
     * Adjusts font size
     */
    private adjustFontSize(delta: number) {
        console.log('Adjusting font size by:', delta, 'current size:', this.settings.fontSize);
        this.settings.fontSize = Math.max(10, Math.min(32, this.settings.fontSize + delta));
        console.log('New font size:', this.settings.fontSize);
        this.saveSettings();
        this.applyReaderStyles();
    }

    /**
     * Changes font family
     */
    private changeFontFamily(fontFamily: string) {
        this.settings.fontFamily = fontFamily;
        this.saveSettings();
        this.applyReaderStyles();
    }

    /**
     * Applies reader mode styles
     */
    private applyReaderStyles() {
        if (!this.readerModeEl) return;

        const style = `
			font-size: ${this.settings.fontSize}px;
			font-family: ${this.settings.fontFamily};
			line-height: ${this.settings.lineSpacing};
			letter-spacing: ${this.settings.characterSpacing}em;
			word-spacing: ${this.settings.wordSpacing}em;
			text-align: ${this.settings.justified ? 'justify' : 'left'};
			margin: 0 ${this.settings.horizontalMargins}%;
			column-count: ${this.settings.columns};
		`;

        this.readerModeEl.style.cssText += style;
    }

    /**
     * Toggles zen mode (hides/shows sidebars and tab bar)
     */
    private toggleZenMode() {
        console.log('Zen mode toggle activated, current zenMode state:', this.zenMode);

        // Toggle left sidebar visibility
        const leftSidebarEl = document.querySelector('.workspace-split.mod-left-split') as HTMLElement;
        if (leftSidebarEl) {
            const isHidden = leftSidebarEl.style.display === 'none';
            leftSidebarEl.style.display = isHidden ? '' : 'none';
            console.log('Left sidebar:', isHidden ? 'shown' : 'hidden');
        } else {
            console.log('Left sidebar element not found');
        }

        // Toggle right sidebar visibility  
        const rightSidebarEl = document.querySelector('.workspace-split.mod-right-split') as HTMLElement;
        if (rightSidebarEl) {
            const isHidden = rightSidebarEl.style.display === 'none';
            rightSidebarEl.style.display = isHidden ? '' : 'none';
            console.log('Right sidebar:', isHidden ? 'shown' : 'hidden');
        } else {
            console.log('Right sidebar element not found');
        }

        // Toggle tab bar visibility
        console.log('Attempting to hide all tab bar containers...');

        // Target all .workspace-tab-header-container elements
        const tabBarElements = document.querySelectorAll('.workspace-tab-header-container') as NodeListOf<HTMLElement>;
        console.log(`Found ${tabBarElements.length} tab bar container(s)`);

        tabBarElements.forEach((tabBarEl, index) => {
            const isHidden = tabBarEl.style.display === 'none';
            tabBarEl.style.display = isHidden ? '' : 'none';
            console.log(`Tab bar container ${index + 1}:`, isHidden ? 'shown' : 'hidden');
            console.log(`  Classes: ${tabBarEl.className}`);
            console.log(`  New display style: ${tabBarEl.style.display}`);
            console.log(`  Element:`, tabBarEl);
        });

        if (tabBarElements.length === 0) {
            console.log('No .workspace-tab-header-container elements found');
        }

        console.log('Zen mode toggle completed');
    }

    /**
     * Restores UI elements to their normal state (shows sidebars and tab bar)
     */
    private restoreZenMode() {
        console.log('Restoring zen mode - showing all UI elements');

        // Show left sidebar
        const leftSidebarEl = document.querySelector('.workspace-split.mod-left-split') as HTMLElement;
        if (leftSidebarEl) {
            leftSidebarEl.style.display = '';
            console.log('Left sidebar restored');
        }

        // Show right sidebar  
        const rightSidebarEl = document.querySelector('.workspace-split.mod-right-split') as HTMLElement;
        if (rightSidebarEl) {
            rightSidebarEl.style.display = '';
            console.log('Right sidebar restored');
        }

        // Show tab bar
        console.log('Restoring all tab bar containers...');

        // Restore all .workspace-tab-header-container elements
        const tabBarElements = document.querySelectorAll('.workspace-tab-header-container') as NodeListOf<HTMLElement>;
        console.log(`Found ${tabBarElements.length} tab bar container(s) to restore`);

        tabBarElements.forEach((tabBarEl, index) => {
            tabBarEl.style.display = '';
            console.log(`Tab bar container ${index + 1} restored`);
        });

        if (tabBarElements.length === 0) {
            console.log('No tab bar containers found to restore');
        }

        console.log('Zen mode restoration completed');
    }

    /**
     * Sets up keyboard event handlers for reader mode
     */
    private addReaderModeKeyboardHandlers() {
        console.log('Setting up reader mode keyboard handlers...');

        const testHandler = (e: KeyboardEvent) => {
            if (!this.readerModeState.isActive) return;

            console.log('Reader mode key pressed:', e.key, 'Code:', e.code, 'Modifiers:', {
                ctrl: e.ctrlKey,
                meta: e.metaKey,
                alt: e.altKey,
                shift: e.shiftKey
            });

            // Test for font size keys (without modifiers)
            if (e.key === '+' || e.key === '=') {
                if (!e.ctrlKey && !e.metaKey && !e.altKey && !e.shiftKey) {
                    console.log('Plus key detected - increasing font size');
                    e.preventDefault();
                    this.adjustFontSize(1);
                    return;
                }
            }

            if (e.key === '-') {
                if (!e.ctrlKey && !e.metaKey && !e.altKey && !e.shiftKey) {
                    console.log('Minus key detected - decreasing font size');
                    e.preventDefault();
                    this.adjustFontSize(-1);
                    return;
                }
            }
        };

        document.addEventListener('keydown', testHandler, { capture: true });

        // Store for cleanup
        this.readerKeyboardHandler = testHandler;
    }

    /**
     * Removes the reader mode keyboard event handlers
     */
    private removeReaderModeKeyboardHandlers() {
        if (this.readerKeyboardHandler) {
            document.removeEventListener('keydown', this.readerKeyboardHandler, { capture: true });
            this.readerKeyboardHandler = null;
            console.log('Removed reader mode keyboard handlers');
        }
    }

    /**
     * Destroys reader mode UI
     */
    private destroyReaderModeUI() {
        if (this.hideControlsTimeout) {
            clearTimeout(this.hideControlsTimeout);
            this.hideControlsTimeout = null;
        }

        // Remove click handlers
        if (this.readerClickHandler) {
            document.removeEventListener('click', this.readerClickHandler);
            document.removeEventListener('touchstart', this.readerClickHandler);
            this.readerClickHandler = null;
        }

        // Remove pills directly from body
        document.querySelectorAll('.obsidian-r-top-pill, .obsidian-r-bottom-pill').forEach(pill => {
            pill.remove();
        });

        // Remove controls
        if (this.controlsEl) {
            this.controlsEl.remove();
            this.controlsEl = null;
        }

        // Clean up CSS classes from workspace leaves
        document.querySelectorAll('.has-obsidian-r-controls').forEach(el => {
            el.classList.remove('has-obsidian-r-controls');
        });

        // Clean up container reference
        if (this.readerModeEl) {
            this.readerModeEl = null;
        }

        console.log('Reader mode UI destroyed, sidebars should be unaffected');
    }

    /**
     * Calculates page numbers for the current book and chapter
     */
    private async calculatePageNumbers() {
        if (!this.readerModeState.currentBook || !this.readerModeState.currentChapter) {
            return;
        }

        const book = this.readerModeState.currentBook;
        const currentChapter = this.readerModeState.currentChapter;

        // Calculate total pages (number of chapters + main file)
        this.readerModeState.totalPages = book.chapters.length + (book.mainFile ? 1 : 0);

        // Find current page number
        if (currentChapter === book.mainFile) {
            this.readerModeState.currentPage = 1;
            this.readerModeState.chapterPage = 1;
            this.readerModeState.chapterTotalPages = 1;
        } else {
            const chapterIndex = book.chapters.indexOf(currentChapter);
            if (chapterIndex >= 0) {
                this.readerModeState.currentPage = chapterIndex + (book.mainFile ? 2 : 1);
                this.readerModeState.chapterPage = 1; // Always 1 for single file chapters
                this.readerModeState.chapterTotalPages = 1; // Always 1 for single file chapters
            }
        }
    }

    /**
     * Updates the pill displays with current page information
     */
    private updatePills() {
        const topPill = document.querySelector('.obsidian-r-top-pill') as HTMLElement;
        const bottomPill = document.querySelector('.obsidian-r-bottom-pill') as HTMLElement;

        if (topPill) {
            topPill.textContent = `${this.readerModeState.chapterPage}/${this.readerModeState.chapterTotalPages}`;
        }

        if (bottomPill) {
            bottomPill.textContent = `${this.readerModeState.currentPage}/${this.readerModeState.totalPages}`;
        }
    }

    /**
     * Updates reader mode when the active file changes
     */
    private async updateReaderModeForCurrentFile() {
        const activeFile = this.app.workspace.getActiveFile();
        if (!activeFile || !this.readerModeState.currentBook) {
            return;
        }

        // Check if the new file is part of the current book
        const book = this.findBookForFile(activeFile);
        if (book === this.readerModeState.currentBook) {
            // Update current chapter
            this.readerModeState.currentChapter = activeFile;
            // Recalculate page numbers
            await this.calculatePageNumbers();
            // Update pills
            this.updatePills();
        } else {
            // File is not part of current book, exit reader mode
            this.exitReaderMode();
        }
    }

    /**
     * Loads plugin settings
     */
    async loadSettings() {
        this.settings = Object.assign({}, DEFAULT_SETTINGS, await this.loadData());
    }    /**
     * Saves plugin settings
     */
    async saveSettings() {
        await this.saveData(this.settings);
    }

    /**
     * Returns all detected books
     */
    public getDetectedBooks(): Map<string, BookStructure> {
        return new Map(this.detectedBooks);
    }

    /**
     * Checks if a folder is a detected book
     */
    public isBook(folderPath: string): boolean {
        return this.detectedBooks.has(folderPath);
    }
}

class ObsidianRSettingTab extends PluginSettingTab {
    plugin: ObsidianRPlugin;

    constructor(app: App, plugin: ObsidianRPlugin) {
        super(app, plugin);
        this.plugin = plugin;
    }

    display(): void {
        const { containerEl } = this;

        containerEl.empty();

        // Format Section
        containerEl.createEl('h3', { text: 'Format' });

        new Setting(containerEl)
            .setName('Justified')
            .setDesc('Enable text justification by default in reader mode')
            .addToggle(toggle => toggle
                .setValue(this.plugin.settings.justified)
                .onChange(async (value) => {
                    this.plugin.settings.justified = value;
                    await this.plugin.saveSettings();
                }));

        new Setting(containerEl)
            .setName('Horizontal Margins')
            .setDesc('Set the horizontal margins as a percentage of screen width')
            .addSlider(slider => slider
                .setLimits(0, 30, 1)
                .setValue(this.plugin.settings.horizontalMargins)
                .setDynamicTooltip()
                .onChange(async (value) => {
                    this.plugin.settings.horizontalMargins = value;
                    await this.plugin.saveSettings();
                }));

        new Setting(containerEl)
            .setName('Columns')
            .setDesc('Number of text columns in reader mode')
            .addSlider(slider => slider
                .setLimits(1, 3, 1)
                .setValue(this.plugin.settings.columns)
                .setDynamicTooltip()
                .onChange(async (value) => {
                    this.plugin.settings.columns = value;
                    await this.plugin.saveSettings();
                }));

        new Setting(containerEl)
            .setName('Line Spacing')
            .setDesc('Adjust line spacing (1.0 = normal, 1.5 = 1.5x spacing)')
            .addSlider(slider => slider
                .setLimits(0.8, 2.5, 0.1)
                .setValue(this.plugin.settings.lineSpacing)
                .setDynamicTooltip()
                .onChange(async (value) => {
                    this.plugin.settings.lineSpacing = Math.round(value * 10) / 10;
                    await this.plugin.saveSettings();
                }));

        new Setting(containerEl)
            .setName('Character Spacing')
            .setDesc('Adjust spacing between characters (0 = normal)')
            .addSlider(slider => slider
                .setLimits(-0.1, 0.5, 0.01)
                .setValue(this.plugin.settings.characterSpacing)
                .setDynamicTooltip()
                .onChange(async (value) => {
                    this.plugin.settings.characterSpacing = Math.round(value * 100) / 100;
                    await this.plugin.saveSettings();
                }));

        new Setting(containerEl)
            .setName('Word Spacing')
            .setDesc('Adjust spacing between words (1.0 = normal)')
            .addSlider(slider => slider
                .setLimits(0.5, 2.0, 0.1)
                .setValue(this.plugin.settings.wordSpacing)
                .setDynamicTooltip()
                .onChange(async (value) => {
                    this.plugin.settings.wordSpacing = Math.round(value * 10) / 10;
                    await this.plugin.saveSettings();
                }));

        // Transitions Section
        containerEl.createEl('h3', { text: 'Transitions' });

        new Setting(containerEl)
            .setName('Transition Type')
            .setDesc('Choose the page transition animation for reader mode')
            .addDropdown(dropdown => dropdown
                .addOption('page-curl', 'Page Curl')
                .addOption('slide', 'Slide')
                .addOption('fade', 'Fade')
                .addOption('scroll', 'Scroll')
                .setValue(this.plugin.settings.transitionType)
                .onChange(async (value: 'page-curl' | 'slide' | 'fade' | 'scroll') => {
                    this.plugin.settings.transitionType = value;
                    await this.plugin.saveSettings();
                }));
    }
}