import { Plugin, TFile, TFolder, TAbstractFile, PluginSettingTab, App, Setting, Command, Notice, WorkspaceLeaf, MarkdownView } from 'obsidian';

// Lucide icon names for the plugin
type LucideIconName =
    | 'book-open' | 'bookmark' | 'list' | 'bar-chart-3' | 'eye-off' | 'eye'
    | 'plus' | 'minus' | 'a-arrow-up' | 'a-arrow-down' | 'type' | 'chevron-left' | 'chevron-right'
    | 'x' | 'settings' | 'maximize' | 'minimize' | 'moon' | 'sun';

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
    // Add rendering-based pagination state
    renderedPages: Map<string, number>; // file path -> total pages in that file
    currentScrollPosition: number;
    pageHeight: number;
    contentHeight: number;
    // Add missing properties for global pagination
    files: string[]; // ordered list of file paths in the book
    globalPage: number; // current page in the entire book
    globalTotalPages: number; // total pages in the entire book
}

const DEFAULT_SETTINGS: ObsidianRSettings = {
    transitionType: 'page-curl',
    justified: true,
    horizontalMargins: 10, // 10% margins
    columns: 1,
    lineSpacing: 1.5, // Improved readability - typical for ebooks
    characterSpacing: 0.02, // Slight letter spacing for better readability
    wordSpacing: 0.0, // Normal word spacing (0 = browser default)
    fontSize: 16,
    fontFamily: 'Charter',
    showToc: false,
    showBookmarks: false,
    showStats: false
};

/**
 * Icon utility functions for Lucide icons with mobile fallback loading
 */
class IconManager {
    private static lucideLoaded = false;
    private static lucideLoadPromise: Promise<void> | null = null;

    /**
     * Ensures Lucide is available, loading it on mobile if necessary
     */
    static async ensureLucideAvailable(): Promise<void> {
        // Check if Lucide is already available (desktop)
        if ((window as any).setIcon || (window as any).lucide) {
            this.lucideLoaded = true;
            return;
        }

        // If already loading, wait for it
        if (this.lucideLoadPromise) {
            return this.lucideLoadPromise;
        }

        // Load Lucide for mobile
        this.lucideLoadPromise = this.loadLucide();
        return this.lucideLoadPromise;
    }

    /**
     * Loads Lucide library dynamically for mobile
     */
    private static async loadLucide(): Promise<void> {
        try {
            // Try to load from CDN
            const script = document.createElement('script');
            script.src = 'https://unpkg.com/lucide@latest/dist/umd/lucide.js';

            await new Promise<void>((resolve, reject) => {
                script.onload = () => {
                    console.log('Lucide loaded successfully from CDN');
                    this.lucideLoaded = true;
                    resolve();
                };
                script.onerror = () => reject(new Error('Failed to load Lucide from CDN'));
                document.head.appendChild(script);
            });
        } catch (error) {
            console.error('Failed to load Lucide:', error);
            throw error;
        }
    }

    /**
     * Creates an icon element using Lucide
     */
    static async createIcon(iconName: LucideIconName, className?: string): Promise<HTMLElement> {
        await this.ensureLucideAvailable();

        const iconEl = document.createElement('span');
        if (className) {
            iconEl.className = className;
        }

        try {
            // Try Obsidian's setIcon first (desktop) - this is the proper way in Obsidian
            if (typeof (window as any).setIcon === 'function') {
                (window as any).setIcon(iconEl, iconName);
                return iconEl;
            }

            // Mobile fallback: Use Lucide directly
            if ((window as any).lucide) {
                // Use Lucide's icons object if available for direct SVG creation
                if ((window as any).lucide.icons && (window as any).lucide.icons[iconName.replace(/-([a-z])/g, (g) => g[1].toUpperCase())]) {
                    const iconData = (window as any).lucide.icons[iconName.replace(/-([a-z])/g, (g) => g[1].toUpperCase())];
                    iconEl.innerHTML = iconData;
                } else {
                    // Fallback to data-lucide attribute method
                    iconEl.setAttribute('data-lucide', iconName);
                    // Add to DOM temporarily for processing
                    const tempContainer = document.createElement('div');
                    tempContainer.style.display = 'none';
                    tempContainer.appendChild(iconEl);
                    document.body.appendChild(tempContainer);
                    (window as any).lucide.createIcons();
                    document.body.removeChild(tempContainer);
                }
                return iconEl;
            }

            throw new Error('Lucide not available');
        } catch (error) {
            console.error('Failed to create Lucide icon:', iconName, error);

            // Last resort: create a placeholder that can be replaced later
            iconEl.setAttribute('data-icon-name', iconName);
            iconEl.textContent = iconName; // Temporary text fallback
            iconEl.style.fontSize = '12px';
            iconEl.style.opacity = '0.5';
            return iconEl;
        }
    }

    /**
     * Creates a button with an icon
     */
    static async createIconButton(iconName: LucideIconName, title: string, onClick: () => void): Promise<HTMLButtonElement> {
        const button = document.createElement('button');
        button.className = 'obsidian-r-icon-button';
        button.title = title;
        button.setAttribute('aria-label', title);

        const icon = await this.createIcon(iconName, 'obsidian-r-icon');
        button.appendChild(icon);

        button.addEventListener('click', onClick);
        return button;
    }

    /**
     * Refreshes Lucide icons in a container (useful for mobile after DOM insertion)
     */
    static refreshIcons(container: HTMLElement): void {
        if ((window as any).lucide && (window as any).lucide.createIcons) {
            (window as any).lucide.createIcons({
                nameAttr: 'data-lucide'
            });
        }
    }

    /**
     * Updates an existing icon element with a new icon
     */
    static async updateIcon(iconEl: HTMLElement, newIconName: LucideIconName): Promise<void> {
        console.log('updateIcon called with:', newIconName, 'for element:', iconEl);
        await this.ensureLucideAvailable();

        try {
            // Try Obsidian's setIcon first (desktop)
            if (typeof (window as any).setIcon === 'function') {
                console.log('Using Obsidian setIcon for:', newIconName);
                iconEl.innerHTML = ''; // Clear existing content
                iconEl.removeAttribute('data-lucide'); // Clear any existing data attribute
                (window as any).setIcon(iconEl, newIconName);
                console.log('setIcon completed, element innerHTML:', iconEl.innerHTML);
                return;
            }

            // Mobile fallback: Use Lucide directly
            if ((window as any).lucide) {
                console.log('Using Lucide directly for:', newIconName);

                // Clear existing content and attributes
                iconEl.innerHTML = '';
                iconEl.removeAttribute('data-lucide');

                // Convert kebab-case to camelCase for Lucide icon names
                const camelCaseIconName = newIconName.replace(/-([a-z])/g, (g) => g[1].toUpperCase());

                // Try direct SVG insertion first
                if ((window as any).lucide.icons && (window as any).lucide.icons[camelCaseIconName]) {
                    const iconData = (window as any).lucide.icons[camelCaseIconName];
                    iconEl.innerHTML = iconData;
                    console.log('Direct SVG insertion successful, innerHTML:', iconEl.innerHTML);
                } else {
                    // Fallback: create a new icon element and copy its content
                    console.log('Trying createIcon fallback for:', newIconName);
                    const tempIcon = await this.createIcon(newIconName);
                    iconEl.innerHTML = tempIcon.innerHTML;
                    console.log('CreateIcon fallback successful, innerHTML:', iconEl.innerHTML);
                }

                return;
            }

            throw new Error('Lucide not available');
        } catch (error) {
            console.error('Failed to update Lucide icon:', newIconName, error);

            // Last resort: update text content
            iconEl.innerHTML = '';
            iconEl.textContent = newIconName;
            iconEl.style.fontSize = '12px';
            iconEl.style.opacity = '0.5';
        }
    }
}

export default class ObsidianRPlugin extends Plugin {
    settings: ObsidianRSettings;
    private detectedBooks: Map<string, BookStructure> = new Map();
    private scanTimeoutId: number | null = null; // For debouncing scans
    private decorationTimeoutId: number | null = null; // For debouncing decorations
    private readerModeState: ReaderModeState = {
        isActive: false,
        currentBook: null,
        currentChapter: null,
        currentPage: 1,
        totalPages: 1,
        chapterPage: 1,
        chapterTotalPages: 1,
        renderedPages: new Map(),
        currentScrollPosition: 0,
        pageHeight: 0,
        contentHeight: 0,
        files: [],
        globalPage: 1,
        globalTotalPages: 1
    };
    private readerModeEl: HTMLElement | null = null;
    private controlsEl: HTMLElement | null = null;
    private hideControlsTimeout: number | null = null;
    private readerClickHandler: ((event: Event) => void) | null = null;
    private scrollHandler: ((event: Event) => void) | null = null;
    private scrollContainer: HTMLElement | null = null;
    private readerKeyboardHandler: ((event: KeyboardEvent) => void) | null = null;
    private zenMode: boolean = false;
    private originalViewMode: 'source' | 'preview' | null = null;

    async onload() {
        console.log('Loading Obsidian:R plugin');

        // Load settings
        await this.loadSettings();
        console.log('Settings loaded:', this.settings);

        // Add settings tab
        this.addSettingTab(new ObsidianRSettingTab(this.app, this));

        // Add commands
        this.addCommand({
            id: 'toggle-reader-mode',
            name: 'Toggle Reader Mode',
            callback: () => {
                console.log('Toggle Reader Mode command triggered via Command Palette');
                this.toggleReaderMode();
            },
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
        console.log('Starting initial book scan...');
        await this.scanForBooks();
        console.log('Initial book scan completed. Found books:', this.detectedBooks.size);

        // Listen for file/folder changes with debouncing
        this.registerEvent(
            this.app.vault.on('create', (file) => {
                // Only scan if a folder was created or if it's in a potential book directory
                if (file instanceof TFolder || this.isPotentialBookFile(file)) {
                    this.debouncedScanForBooks();
                }
            })
        );
        this.registerEvent(
            this.app.vault.on('delete', (file) => {
                // Only scan if a folder was deleted or if it's in a potential book directory
                if (file instanceof TFolder || this.isPotentialBookFile(file)) {
                    this.debouncedScanForBooks();
                }
            })
        );
        this.registerEvent(
            this.app.vault.on('rename', (file) => {
                // Only scan if a folder was renamed or if it's in a potential book directory
                if (file instanceof TFolder || this.isPotentialBookFile(file)) {
                    this.debouncedScanForBooks();
                }
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
        // Clear any pending timeouts
        if (this.scanTimeoutId) {
            clearTimeout(this.scanTimeoutId);
        }
        if (this.decorationTimeoutId) {
            clearTimeout(this.decorationTimeoutId);
        }
        this.detectedBooks.clear();
        this.exitReaderMode();
    }

    /**
     * Debounced scan for books to prevent infinite loops
     */
    private debouncedScanForBooks(): void {
        if (this.scanTimeoutId) {
            clearTimeout(this.scanTimeoutId);
        }
        this.scanTimeoutId = window.setTimeout(() => {
            this.scanForBooks().then(() => {
                this.debouncedUpdateFileExplorerDecorations();
            });
        }, 500); // 500ms debounce
    }

    /**
     * Debounced update for file explorer decorations
     */
    private debouncedUpdateFileExplorerDecorations(): void {
        if (this.decorationTimeoutId) {
            clearTimeout(this.decorationTimeoutId);
        }
        this.decorationTimeoutId = window.setTimeout(() => {
            this.updateFileExplorerDecorations();
        }, 200); // 200ms debounce
    }

    /**
     * Check if a file could be part of a book structure
     */
    private isPotentialBookFile(file: TAbstractFile): boolean {
        if (!(file instanceof TFile)) return false;

        // Check if it's a markdown file that could be a book chapter or main file
        if (file.extension === 'md') {
            const name = file.basename;
            const path = file.path;

            // Check if it matches book patterns:
            // - Main book file: "BookName.md" 
            // - Chapter file: "BookName - Chapter X.md", "BookName - Prologue.md", etc.
            const isMainBookFile = /^[^/]+\.md$/.test(path.split('/').pop() || '');
            const isChapterFile = / - (Chapter \d+|Prologue|Epilogue)\.md$/i.test(name);

            return isMainBookFile || isChapterFile;
        }

        // Check if it's a book cover image
        if (['png', 'jpg', 'jpeg'].includes(file.extension)) {
            // Could be a book cover if it's in a folder with the same name
            const folderName = file.parent?.name;
            const fileName = file.basename;
            return folderName === fileName;
        }

        return false;
    }

    /**
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

        // Use requestAnimationFrame to avoid forced reflows during execution
        requestAnimationFrame(() => {
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
        console.log('Currently detected books:', Array.from(this.detectedBooks.keys()));

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
            console.log('Available books:', Array.from(this.detectedBooks.values()).map(b => b.title));
            new Notice('Current file is not part of a detected book');
            return;
        }

        console.log('Found book:', book.title);

        this.readerModeState.isActive = true;
        this.readerModeState.currentBook = book;
        this.readerModeState.currentChapter = activeFile;

        console.log('Reader mode state set to active');

        // Switch to reading view for better reading experience
        await this.switchToReadingView();

        // Calculate page numbers
        await this.calculatePageNumbers();

        // Create reader mode UI
        this.createReaderModeUI();
        this.showReaderControls();

        // Apply visual styling to content area
        this.applyReaderModeStyles();

        // Add reader mode keyboard handlers
        this.addReaderModeKeyboardHandlers();

        console.log('Reader mode UI created and controls shown');
        new Notice('Reader mode activated');
    }

    /**
     * Switches the current view to reading mode and stores original mode
     */
    private async switchToReadingView() {
        const activeMarkdownView = this.app.workspace.getActiveViewOfType(MarkdownView);
        if (!activeMarkdownView) return;

        // Store the original view mode
        this.originalViewMode = activeMarkdownView.getMode() as 'source' | 'preview';
        console.log('📖 Storing original view mode:', this.originalViewMode);

        // Switch to preview mode if not already
        if (this.originalViewMode !== 'preview') {
            console.log('📖 Switching to reading view...');
            await activeMarkdownView.setState({ mode: 'preview' }, { history: false });
            console.log('📖 Switched to reading view');
        }
    }

    /**
     * Restores the original view mode when exiting reader mode
     */
    private async restoreOriginalViewMode() {
        if (!this.originalViewMode) return;

        const activeMarkdownView = this.app.workspace.getActiveViewOfType(MarkdownView);
        if (!activeMarkdownView) return;

        console.log('📖 Restoring original view mode:', this.originalViewMode);
        await activeMarkdownView.setState({ mode: this.originalViewMode }, { history: false });
        this.originalViewMode = null;
        console.log('📖 Original view mode restored');
    }

    /**
     * Applies reader mode visual styling to the content area
     */
    private applyReaderModeStyles() {
        console.log('🎨 Applying reader mode styles to content area...');

        // Create or update the style element
        let styleEl = document.getElementById('obsidian-r-reader-styles') as HTMLStyleElement;
        if (!styleEl) {
            styleEl = document.createElement('style');
            styleEl.id = 'obsidian-r-reader-styles';
            document.head.appendChild(styleEl);
        }

        const horizontalMarginPx = (window.innerWidth * this.settings.horizontalMargins) / 100;
        const contentWidth = window.innerWidth - (horizontalMarginPx * 2);

        console.log('🎨 Style calculations:', {
            windowWidth: window.innerWidth,
            marginPercent: this.settings.horizontalMargins,
            horizontalMarginPx,
            contentWidth,
            fontSize: this.settings.fontSize,
            fontFamily: this.settings.fontFamily,
            lineSpacing: this.settings.lineSpacing,
            characterSpacing: this.settings.characterSpacing,
            wordSpacing: this.settings.wordSpacing
        });

        // Apply styles to current view mode and add class for identification
        const activeLeaf = this.app.workspace.activeLeaf;
        if (activeLeaf?.view?.containerEl) {
            activeLeaf.view.containerEl.classList.add('obsidian-r-active');
            console.log('🎨 Added obsidian-r-active class to active view container');
        }

        const css = `
            /* Target the actual content container - the markdown-preview-sizer */
            .obsidian-r-active .markdown-preview-sizer,
            .workspace-leaf.has-obsidian-r-controls .markdown-preview-sizer,
            .workspace-leaf-content.has-obsidian-r-controls .markdown-preview-sizer {
                max-width: ${contentWidth}px !important;
                margin: 0 auto !important;
                padding-left: ${horizontalMarginPx}px !important;
                padding-right: ${horizontalMarginPx}px !important;
                box-sizing: border-box !important;
                font-family: '${this.settings.fontFamily}', serif !important;
                font-size: ${this.settings.fontSize}px !important;
                line-height: ${this.settings.lineSpacing} !important;
                letter-spacing: ${this.settings.characterSpacing}em !important;
                word-spacing: ${this.settings.wordSpacing === 0 ? 'normal' : this.settings.wordSpacing + 'em'} !important;
                ${this.settings.justified ? `
                    text-align: justify !important;
                    text-justify: inter-word !important;
                    hyphens: auto !important;
                    -webkit-hyphens: auto !important;
                    -moz-hyphens: auto !important;
                    -ms-hyphens: auto !important;
                    word-break: normal !important;
                    overflow-wrap: break-word !important;
                ` : 'text-align: left !important;'}
                ${this.settings.columns > 1 ? `
                    column-count: ${this.settings.columns};
                    column-gap: 30px;
                    column-fill: auto;
                ` : ''}
            }

            /* Also apply to CM editor for edit mode */
            .obsidian-r-active .cm-editor,
            .obsidian-r-active .cm-content,
            .workspace-leaf.has-obsidian-r-controls .cm-editor,
            .workspace-leaf.has-obsidian-r-controls .cm-content,
            .workspace-leaf-content.has-obsidian-r-controls .cm-editor,
            .workspace-leaf-content.has-obsidian-r-controls .cm-content {
                max-width: ${contentWidth}px !important;
                margin: 0 auto !important;
                padding-left: ${horizontalMarginPx}px !important;
                padding-right: ${horizontalMarginPx}px !important;
                box-sizing: border-box !important;
                font-family: '${this.settings.fontFamily}', serif !important;
                font-size: ${this.settings.fontSize}px !important;
                line-height: ${this.settings.lineSpacing} !important;
                letter-spacing: ${this.settings.characterSpacing}em !important;
                word-spacing: ${this.settings.wordSpacing === 0 ? 'normal' : this.settings.wordSpacing + 'em'} !important;
                ${this.settings.justified ? `
                    text-align: justify !important;
                    text-justify: inter-word !important;
                    hyphens: auto !important;
                    -webkit-hyphens: auto !important;
                    -moz-hyphens: auto !important;
                    -ms-hyphens: auto !important;
                    word-break: normal !important;
                    overflow-wrap: break-word !important;
                ` : 'text-align: left !important;'}
            }

            /* Ensure outer containers don't interfere */
            .obsidian-r-active .markdown-preview-view,
            .workspace-leaf.has-obsidian-r-controls .markdown-preview-view,
            .workspace-leaf-content.has-obsidian-r-controls .markdown-preview-view {
                width: 100% !important;
                max-width: none !important;
            }

            /* Hide frontmatter in reader mode */
            .obsidian-r-active .metadata-container,
            .workspace-leaf.has-obsidian-r-controls .metadata-container,
            .workspace-leaf-content.has-obsidian-r-controls .metadata-container {
                display: none !important;
            }

            /* Hide navigation elements in reader mode */
            .obsidian-r-active .nav-header,
            .obsidian-r-active .backlink-pane,
            .obsidian-r-active .mod-footer,
            .workspace-leaf.has-obsidian-r-controls .nav-header,
            .workspace-leaf.has-obsidian-r-controls .backlink-pane,
            .workspace-leaf.has-obsidian-r-controls .mod-footer,
            .workspace-leaf-content.has-obsidian-r-controls .nav-header,
            .workspace-leaf-content.has-obsidian-r-controls .backlink-pane,
            .workspace-leaf-content.has-obsidian-r-controls .mod-footer {
                display: none !important;
            }

            /* Improve readability and background */
            .obsidian-r-active .markdown-preview-view,
            .obsidian-r-active .markdown-reading-view,
            .obsidian-r-active .markdown-source-view,
            .workspace-leaf.has-obsidian-r-controls .markdown-preview-view,
            .workspace-leaf.has-obsidian-r-controls .markdown-reading-view,
            .workspace-leaf.has-obsidian-r-controls .markdown-source-view,
            .workspace-leaf-content.has-obsidian-r-controls .markdown-preview-view,
            .workspace-leaf-content.has-obsidian-r-controls .markdown-reading-view,
            .workspace-leaf-content.has-obsidian-r-controls .markdown-source-view {
                background: var(--background-primary) !important;
                color: var(--text-normal) !important;
            }

            /* Paragraph spacing for better readability */
            .obsidian-r-active p,
            .workspace-leaf.has-obsidian-r-controls p,
            .workspace-leaf-content.has-obsidian-r-controls p {
                margin-bottom: 1.2em !important;
                text-indent: ${this.settings.justified ? '1.5em' : '0'} !important;
            }
        `;

        styleEl.textContent = css;
        console.log('🎨 Reader mode styles applied:', {
            fontSize: this.settings.fontSize,
            fontFamily: this.settings.fontFamily,
            columns: this.settings.columns,
            contentWidth: contentWidth,
            margins: horizontalMarginPx
        });
    }

    /**
     * Removes reader mode visual styling
     */
    private removeReaderModeStyles() {
        console.log('🎨 Removing reader mode styles...');
        const styleEl = document.getElementById('obsidian-r-reader-styles');
        if (styleEl) {
            styleEl.remove();
            console.log('🎨 Reader mode styles removed');
        }

        // Remove active class from view container
        const activeLeaf = this.app.workspace.activeLeaf;
        if (activeLeaf?.view?.containerEl) {
            activeLeaf.view.containerEl.classList.remove('obsidian-r-active');
            console.log('🎨 Removed obsidian-r-active class from view container');
        }
    }

    /**
     * Exits reader mode
     */
    async exitReaderMode() {
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

        // Clean up scroll listener
        this.removeScrollListener();

        // Restore original view mode
        await this.restoreOriginalViewMode();

        // Remove reader mode styles
        this.removeReaderModeStyles();

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

        // Add scroll listener for real-time page updates
        this.addScrollListener();

        // Create top pill (chapter progress) and append to active tab
        const topPill = document.createElement('div');
        topPill.className = 'obsidian-r-top-pill';
        topPill.textContent = `${this.readerModeState.chapterPage}/${this.readerModeState.chapterTotalPages}`;
        console.log('🏷️ Creating top pill:', topPill.textContent, topPill.className);
        this.appendPillToActiveTab(topPill);

        // Create bottom pill (global book progress) and append to active tab  
        const bottomPill = document.createElement('div');
        bottomPill.className = 'obsidian-r-bottom-pill';
        bottomPill.textContent = `${this.readerModeState.globalPage}/${this.readerModeState.globalTotalPages}`;
        console.log('🏷️ Creating bottom pill:', bottomPill.textContent, bottomPill.className);
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

        // Create font size buttons asynchronously
        Promise.all([
            IconManager.createIconButton('a-arrow-down', 'Decrease font size', () => this.adjustFontSize(-1)),
            IconManager.createIconButton('a-arrow-up', 'Increase font size', () => this.adjustFontSize(1))
        ]).then(([decreaseFontBtn, increaseFontBtn]) => {
            fontSizeGroup.appendChild(decreaseFontBtn);
            fontSizeGroup.appendChild(increaseFontBtn);
            // Refresh icons after DOM insertion for mobile compatibility
            IconManager.refreshIcons(fontSizeGroup);
        });

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

        const tocToggle = this.createPaneToggle('ToC', 'list', this.settings.showToc, (checked: boolean) => {
            this.settings.showToc = checked;
            this.saveSettings();
        });

        const bookmarksToggle = this.createPaneToggle('Bookmarks', 'bookmark', this.settings.showBookmarks, (checked: boolean) => {
            this.settings.showBookmarks = checked;
            this.saveSettings();
        });

        const statsToggle = this.createPaneToggle('Stats', 'bar-chart-3', this.settings.showStats, (checked: boolean) => {
            this.settings.showStats = checked;
            this.saveSettings();
        });

        const zenToggle = this.createPaneToggle('Zen', this.zenMode ? 'eye-off' : 'eye', this.zenMode, (checked: boolean) => {
            console.log('Zen toggle clicked, new state will be:', checked);
            this.zenMode = checked;
            this.toggleZenMode();
            this.saveSettings();
        }, async (toggleButton: HTMLElement, checked: boolean) => {
            // Update zen mode icon based on state
            const newIconName = checked ? 'eye-off' : 'eye';
            console.log('ICON CALLBACK TRIGGERED - Updating zen icon to:', newIconName, 'for checked state:', checked);
            console.log('Button classes before update:', toggleButton.className);
            console.log('Button active state:', toggleButton.classList.contains('active'));

            try {
                // Find the icon element within the toggle button
                const iconEl = toggleButton.querySelector('.obsidian-r-toggle-icon') as HTMLElement;
                if (!iconEl) {
                    console.error('Could not find icon element in toggle button');
                    return;
                }

                console.log('Current icon data-lucide attribute:', iconEl.getAttribute('data-lucide'));
                console.log('Found icon element, updating with complete replacement...');

                // CRITICAL: Update the data-lucide attribute FIRST
                iconEl.setAttribute('data-lucide', newIconName);

                // Create a completely new icon element
                const newIcon = await IconManager.createIcon(newIconName, 'obsidian-r-toggle-icon');

                // Replace the entire icon element
                iconEl.parentNode?.replaceChild(newIcon, iconEl);

                console.log('Icon element completely replaced with:', newIconName);
                console.log('New icon data-lucide attribute:', newIcon.getAttribute('data-lucide'));
            } catch (error) {
                console.error('Failed to update zen icon:', error);
            }
        });

        // Create all toggles asynchronously
        Promise.all([tocToggle, bookmarksToggle, statsToggle, zenToggle]).then(([tocEl, bookmarksEl, statsEl, zenEl]) => {
            paneGroup.appendChild(tocEl);
            paneGroup.appendChild(bookmarksEl);
            paneGroup.appendChild(statsEl);
            paneGroup.appendChild(zenEl);

            // CRITICAL: Update zen icon data-lucide attribute BEFORE refresh
            this.updateZenIconAttribute(zenEl);

            // Refresh icons after DOM insertion for mobile compatibility
            console.log('🔄 Calling IconManager.refreshIcons on paneGroup');
            IconManager.refreshIcons(paneGroup);
            console.log('🔄 IconManager.refreshIcons completed');
        });

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
        // Find the active tab's content container
        const activeTab = document.querySelector('.workspace-leaf.mod-active .workspace-leaf-content') ||
            document.querySelector('.workspace-leaf-content.obsidian-r-active');

        if (activeTab) {
            console.log('🏷️ Found active tab container, appending pill:', pill.className);
            console.log('🏷️ Pill content:', pill.textContent);

            // Append pill to the active tab's content area
            activeTab.appendChild(pill);
            console.log('🏷️ Pill appended to active tab. Pill in DOM:', activeTab.contains(pill));
        } else {
            console.warn('🏷️ No active tab found, falling back to body append');
            document.body.appendChild(pill);
        }

        // Log pill styles to verify they're applied
        const computedStyle = window.getComputedStyle(pill);
        console.log('🏷️ Pill computed styles:');
        console.log('  position:', computedStyle.position);
        console.log('  display:', computedStyle.display);
        console.log('  visibility:', computedStyle.visibility);
        console.log('  opacity:', computedStyle.opacity);
        console.log('  z-index:', computedStyle.zIndex);
        console.log('  top:', computedStyle.top);
        console.log('  bottom:', computedStyle.bottom);
        console.log('  left:', computedStyle.left);
        console.log('  transform:', computedStyle.transform);
    }

    /**
     * Creates a pane toggle button/switch with icon support
     */
    private async createPaneToggle(label: string, iconName: LucideIconName, checked: boolean, onChange: (checked: boolean) => void, iconChangeCallback?: (iconEl: HTMLElement, checked: boolean) => void): Promise<HTMLElement> {
        const toggle = document.createElement('button');
        toggle.className = 'obsidian-r-pane-toggle';
        toggle.type = 'button';
        toggle.setAttribute('aria-label', label); // Keep accessibility label

        // Set initial active state
        if (checked) {
            toggle.classList.add('active');
        }

        const checkbox = document.createElement('input');
        checkbox.type = 'checkbox';
        checkbox.checked = checked;

        const icon = await IconManager.createIcon(iconName, 'obsidian-r-toggle-icon');

        // Handle toggle click
        toggle.addEventListener('click', () => {
            checkbox.checked = !checkbox.checked;
            const newChecked = checkbox.checked;

            // Update visual state
            if (newChecked) {
                toggle.classList.add('active');
            } else {
                toggle.classList.remove('active');
            }

            // Call the onChange handler FIRST (before icon change)
            onChange(newChecked);

            // Call icon change callback AFTER onChange to ensure it's not overwritten
            if (iconChangeCallback) {
                iconChangeCallback(toggle, newChecked);
            }
        });

        const span = document.createElement('span');
        span.textContent = label;

        toggle.appendChild(checkbox);
        toggle.appendChild(icon);
        toggle.appendChild(span);

        return toggle;
    }

    /**
     * Shows reader controls and auto-hide after 3 seconds
     */
    private showReaderControls() {
        console.log('📍 showReaderControls() called');
        console.trace('showReaderControls() call stack');
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

        // Debug computed styles
        const computedStyle = window.getComputedStyle(this.controlsEl);
        console.log('Controls computed styles:');
        console.log('  position:', computedStyle.position);
        console.log('  bottom:', computedStyle.bottom);
        console.log('  left:', computedStyle.left);
        console.log('  transform:', computedStyle.transform);
        console.log('  opacity:', computedStyle.opacity);
        console.log('  z-index:', computedStyle.zIndex);
        console.log('  width:', computedStyle.width);
        console.log('  height:', computedStyle.height);

        // Debug element positioning
        const rect = this.controlsEl.getBoundingClientRect();
        console.log('Controls bounding rect:', rect);
        console.log('Controls visible in viewport:', rect.top >= 0 && rect.left >= 0 && rect.top < window.innerHeight && rect.left < window.innerWidth);

        // Ensure zen icon is in correct state after showing controls
        setTimeout(() => this.updateZenIcon(), 50);

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
        }, 5000);
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
        console.log('🔧 Adjusting font size by:', delta, 'current size:', this.settings.fontSize);
        this.settings.fontSize = Math.max(10, Math.min(32, this.settings.fontSize + delta));
        console.log('🔧 New font size:', this.settings.fontSize);
        this.saveSettings();
        // Use the comprehensive style application method
        this.applyReaderModeStyles();
    }

    /**
     * Changes font family
     */
    private changeFontFamily(fontFamily: string) {
        console.log('🔧 Changing font family to:', fontFamily);
        this.settings.fontFamily = fontFamily;
        this.saveSettings();
        // Use the comprehensive style application method
        this.applyReaderModeStyles();
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

        // Force a small delay and then refresh controls to ensure icon state is preserved
        setTimeout(() => {
            if (this.controlsEl) {
                console.log('🔄 Post-zen-toggle: Ensuring zen icon state is correct');
                this.updateZenIcon();
            }
        }, 100);
    }

    /**
     * Updates the zen icon data-lucide attribute before refreshIcons() is called
     */
    private updateZenIconAttribute(zenElement: HTMLElement): void {
        const iconEl = zenElement.querySelector('.obsidian-r-toggle-icon') as HTMLElement;
        if (!iconEl) {
            console.log('❌ Zen icon element not found for attribute update');
            return;
        }

        const currentAttribute = iconEl.getAttribute('data-lucide');
        const expectedAttribute = this.zenMode ? 'eye-off' : 'eye';

        console.log('🎯 Updating zen icon data-lucide from', currentAttribute, 'to', expectedAttribute, '(zenMode:', this.zenMode + ')');

        iconEl.setAttribute('data-lucide', expectedAttribute);

        console.log('✅ Zen icon data-lucide attribute updated, refreshIcons will now load correct icon');
    }

    /**
     * Updates the zen icon to match the current zen mode state
     */
    private async updateZenIcon() {
        if (!this.controlsEl) return;

        // Find ALL zen buttons, not just the first one
        const zenButtons = this.controlsEl.querySelectorAll('.obsidian-r-pane-toggle') as NodeListOf<HTMLElement>;
        console.log('🔍 Found', zenButtons.length, 'pane toggle buttons');

        // Find the zen button specifically (it should be the last one in the pane group)
        let zenButton: HTMLElement | null = null;
        zenButtons.forEach((button, index) => {
            const iconEl = button.querySelector('.obsidian-r-toggle-icon') as HTMLElement;
            const iconName = iconEl?.getAttribute('data-lucide');
            console.log(`  Button ${index}: icon="${iconName}", classes="${button.className}"`);

            // The zen button should have either 'eye' or 'eye-off' icon
            if (iconName === 'eye' || iconName === 'eye-off') {
                zenButton = button;
                console.log(`  ✅ Found zen button at index ${index}`);
            }
        });

        if (!zenButton) {
            console.log('❌ Zen button not found among', zenButtons.length, 'buttons');
            return;
        }

        const iconEl = zenButton.querySelector('.obsidian-r-toggle-icon') as HTMLElement;
        if (!iconEl) {
            console.log('❌ Zen icon element not found in button');
            return;
        }

        const currentIconName = iconEl.getAttribute('data-lucide');
        const expectedIconName = this.zenMode ? 'eye-off' : 'eye';

        console.log('🎯 Current icon:', currentIconName, '| Expected:', expectedIconName, '| Zen mode:', this.zenMode);

        if (currentIconName === expectedIconName) {
            console.log('✅ Icon is already correct, no update needed');
            return;
        }

        try {
            // CRITICAL: Update the data-lucide attribute FIRST
            iconEl.setAttribute('data-lucide', expectedIconName);

            const newIcon = await IconManager.createIcon(expectedIconName, 'obsidian-r-toggle-icon');
            iconEl.parentNode?.replaceChild(newIcon, iconEl);
            console.log('✅ Zen icon successfully updated from', currentIconName, 'to', expectedIconName);
        } catch (error) {
            console.error('❌ Failed to update zen icon:', error);
        }
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
        // console.log('Setting up reader mode keyboard handlers...');

        const testHandler = (e: KeyboardEvent) => {
            if (!this.readerModeState.isActive) return;

            // console.log('Reader mode key pressed:', e.key, 'Code:', e.code, 'Modifiers:', {
            //     ctrl: e.ctrlKey,
            //     meta: e.metaKey,
            //     alt: e.altKey,
            //     shift: e.shiftKey
            // });

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
            // console.log('Removed reader mode keyboard handlers');
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
     * Calculates page numbers based on actual rendering and layout
     */
    private async calculatePageNumbers() {
        console.log('🔢 calculatePageNumbers() called');
        if (!this.readerModeState.currentBook || !this.readerModeState.currentChapter) {
            console.log('❌ Missing book or chapter, returning early');
            return;
        }

        const book = this.readerModeState.currentBook;
        const currentChapter = this.readerModeState.currentChapter;

        console.log('📚 Processing book:', book.folder.name, 'Chapter:', currentChapter.name);

        // Build ordered list of files in the book
        this.readerModeState.files = [];
        if (book.mainFile) {
            this.readerModeState.files.push(book.mainFile.path);
        }
        for (const chapter of book.chapters) {
            this.readerModeState.files.push(chapter.path);
        }
        console.log('📄 Files in book:', this.readerModeState.files);

        // Calculate rendering metrics for current chapter
        console.log('🔍 Calculating rendering metrics...');
        await this.calculateRenderingMetrics(currentChapter);

        // Calculate total pages for the entire book
        let totalBookPages = 0;
        let currentChapterGlobalStartPage = 1;

        console.log('📏 Calculating pages for entire book...');

        // Process main file first (if exists)
        if (book.mainFile) {
            const mainFilePages = await this.getOrCalculateFilePages(book.mainFile);
            totalBookPages += mainFilePages;

            if (currentChapter === book.mainFile) {
                currentChapterGlobalStartPage = 1;
            }
        }

        // Process all chapters
        for (const chapter of book.chapters) {
            const chapterPages = await this.getOrCalculateFilePages(chapter);

            if (currentChapter === chapter) {
                currentChapterGlobalStartPage = totalBookPages + 1;
            }

            totalBookPages += chapterPages;
        }

        // Update state with rendering-based calculations
        this.readerModeState.totalPages = totalBookPages;
        this.readerModeState.globalTotalPages = totalBookPages;
        this.readerModeState.chapterTotalPages = this.readerModeState.renderedPages.get(currentChapter.path) || 1;

        // Calculate current page within chapter based on scroll position
        this.updateCurrentPageFromScroll();

        // Calculate global page number
        this.readerModeState.globalPage = currentChapterGlobalStartPage + this.readerModeState.chapterPage - 1;

        console.log('📊 Rendering-based pagination calculated:');
        console.log('  Current chapter pages:', this.readerModeState.chapterTotalPages);
        console.log('  Current page in chapter:', this.readerModeState.chapterPage);
        console.log('  Global page:', this.readerModeState.globalPage);
        console.log('  Total book pages:', this.readerModeState.globalTotalPages);
    }

    /**
     * Adds scroll listener to update page numbers in real-time
     */
    private addScrollListener() {
        const activeMarkdownView = this.app.workspace.getActiveViewOfType(MarkdownView);
        if (!activeMarkdownView?.containerEl) return;

        const scrollContainer = activeMarkdownView.containerEl.querySelector('.markdown-source-view, .markdown-preview-view, .markdown-reading-view');
        if (!scrollContainer) return;

        console.log('📜 Adding scroll listener to:', scrollContainer.className);

        // Throttle scroll events for performance
        let scrollTimeout: NodeJS.Timeout;
        const scrollHandler = () => {
            clearTimeout(scrollTimeout);
            scrollTimeout = setTimeout(() => {
                this.updateCurrentPageFromScroll();
            }, 100); // Update every 100ms when scrolling stops
        };

        scrollContainer.addEventListener('scroll', scrollHandler);

        // Store reference for cleanup
        this.scrollHandler = scrollHandler;
        this.scrollContainer = scrollContainer as HTMLElement;
    }

    /**
     * Updates current page based on scroll position
     */
    private updateCurrentPageFromScroll() {
        if (!this.readerModeState.renderedPages || !this.readerModeState.pageHeight) return;

        const activeMarkdownView = this.app.workspace.getActiveViewOfType(MarkdownView);
        if (!activeMarkdownView?.file) return;

        const scrollContainer = activeMarkdownView.containerEl.querySelector('.markdown-source-view, .markdown-preview-view, .markdown-reading-view') as HTMLElement;
        if (!scrollContainer) return;

        const scrollTop = scrollContainer.scrollTop;
        const currentPage = Math.floor(scrollTop / this.readerModeState.pageHeight) + 1;

        console.log('📜 Scroll update:', {
            scrollTop,
            pageHeight: this.readerModeState.pageHeight,
            currentPage,
            totalPages: this.readerModeState.chapterTotalPages
        });

        // Update chapter page
        this.readerModeState.chapterPage = Math.min(currentPage, this.readerModeState.chapterTotalPages);
        this.readerModeState.currentScrollPosition = scrollTop;

        // Calculate global page (book-wide)
        if (this.readerModeState.renderedPages.has(activeMarkdownView.file.path)) {
            let globalPage = 0;
            const currentFilePages = this.readerModeState.renderedPages.get(activeMarkdownView.file.path) || 0;

            // Add pages from previous files
            for (const filePath of this.readerModeState.files) {
                if (filePath === activeMarkdownView.file.path) {
                    globalPage += currentPage;
                    break;
                }
                globalPage += this.readerModeState.renderedPages.get(filePath) || 0;
            }

            this.readerModeState.globalPage = globalPage;
        }

        // Update pill displays
        this.updatePillDisplays();
    }

    /**
     * Updates pill displays with current page information
     */
    private updatePillDisplays() {
        // Update top pill (chapter progress)
        const topPill = document.querySelector('.obsidian-r-top-pill') as HTMLElement;
        if (topPill) {
            topPill.textContent = `${this.readerModeState.chapterPage}/${this.readerModeState.chapterTotalPages}`;
        }

        // Update bottom pill (book progress)
        const bottomPill = document.querySelector('.obsidian-r-bottom-pill') as HTMLElement;
        if (bottomPill) {
            bottomPill.textContent = `${this.readerModeState.globalPage}/${this.readerModeState.globalTotalPages}`;
        }
    }

    /**
     * Removes scroll listener
     */
    private removeScrollListener() {
        if (this.scrollHandler && this.scrollContainer) {
            this.scrollContainer.removeEventListener('scroll', this.scrollHandler);
            this.scrollHandler = null;
            this.scrollContainer = null;
        }
    }

    /**
     * Gets cached page count or calculates it for a file
     */
    private async getOrCalculateFilePages(file: TFile): Promise<number> {
        const cached = this.readerModeState.renderedPages.get(file.path);
        if (cached !== undefined) {
            return cached;
        }

        const pages = await this.calculateFilePages(file);
        this.readerModeState.renderedPages.set(file.path, pages);
        return pages;
    }

    /**
     * Calculates the number of pages for a specific file based on rendering
     */
    private async calculateFilePages(file: TFile): Promise<number> {
        console.log('📊 calculateFilePages() called for:', file.name);
        try {
            const content = await this.app.vault.read(file);
            console.log('📖 Read file content, length:', content.length);

            const processedContent = this.processContentForRendering(content);
            console.log('✨ Processed content, length:', processedContent.length);

            // Create a temporary element to measure content height
            const tempEl = document.createElement('div');
            tempEl.style.cssText = this.getReaderModeStyles();
            tempEl.style.position = 'absolute';
            tempEl.style.top = '-9999px';
            tempEl.style.left = '-9999px';
            tempEl.style.visibility = 'hidden';

            // Set content and measure
            const htmlContent = this.renderMarkdownToHTML(processedContent);
            tempEl.innerHTML = htmlContent;
            document.body.appendChild(tempEl);

            const contentHeight = tempEl.scrollHeight;
            const pageHeight = this.calculatePageHeight();
            const pages = Math.max(1, Math.ceil(contentHeight / pageHeight));

            document.body.removeChild(tempEl);

            console.log(`📄 File "${file.basename}": ${contentHeight}px content / ${pageHeight}px per page = ${pages} pages`);
            return pages;
        } catch (error) {
            console.error('❌ Error calculating file pages:', error);
            return 1;
        }
    }

    /**
     * Processes content for rendering (removes frontmatter, applies formatting)
     */
    private processContentForRendering(content: string): string {
        console.log('🔧 Processing content for rendering. Original length:', content.length);

        // Remove frontmatter in reader mode
        let processedContent = content.replace(/^---\n[\s\S]*?\n---\n/, '');

        const frontmatterRemoved = content.length !== processedContent.length;
        console.log('📝 Frontmatter removed:', frontmatterRemoved, 'New length:', processedContent.length);

        // Remove any leading/trailing whitespace
        processedContent = processedContent.trim();

        return processedContent;
    }

    /**
     * Converts markdown to HTML for measurement
     */
    private renderMarkdownToHTML(markdown: string): string {
        // Simple markdown to HTML conversion for measurement
        // In a real implementation, you'd use Obsidian's markdown processor
        return markdown
            .replace(/^# (.*$)/gim, '<h1>$1</h1>')
            .replace(/^## (.*$)/gim, '<h2>$1</h2>')
            .replace(/^### (.*$)/gim, '<h3>$1</h3>')
            .replace(/\*\*(.*?)\*\*/g, '<strong>$1</strong>')
            .replace(/\*(.*?)\*/g, '<em>$1</em>')
            .replace(/\n\n/g, '</p><p>')
            .replace(/^(.+)$/gm, '<p>$1</p>')
            .replace(/<p><\/p>/g, '');
    }

    /**
     * Generates CSS styles for content measurement
     */
    private getReaderModeStyles(): string {
        const horizontalMarginPx = (window.innerWidth * this.settings.horizontalMargins) / 100;
        const contentWidth = window.innerWidth - (horizontalMarginPx * 2);
        const columnWidth = this.settings.columns > 1 ?
            (contentWidth - (this.settings.columns - 1) * 20) / this.settings.columns :
            contentWidth;

        const styles = `
            font-family: ${this.settings.fontFamily};
            font-size: ${this.settings.fontSize}px;
            line-height: ${this.settings.lineSpacing};
            letter-spacing: ${this.settings.characterSpacing}em;
            word-spacing: ${this.settings.wordSpacing}em;
            text-align: ${this.settings.justified ? 'justify' : 'left'};
            width: ${columnWidth}px;
            column-count: ${this.settings.columns};
            column-gap: 20px;
            margin: 0 ${horizontalMarginPx}px;
            padding: 20px;
            box-sizing: border-box;
        `;

        console.log('🎨 Generated reader mode styles:', {
            fontSize: this.settings.fontSize,
            fontFamily: this.settings.fontFamily,
            columns: this.settings.columns,
            margins: this.settings.horizontalMargins,
            width: columnWidth
        });

        return styles;
    }

    /**
     * Calculates the height of one page based on current settings
     */
    private calculatePageHeight(): number {
        // Use viewport height minus margins for page height
        const verticalMargin = 40; // Top and bottom margins
        return window.innerHeight - verticalMargin;
    }

    /**
     * Calculates current rendering metrics for the active content
     */
    private async calculateRenderingMetrics(file: TFile) {
        console.log('📐 calculateRenderingMetrics() called for file:', file.name);

        // Use the comprehensive rendering calculation instead of simple metrics
        const pages = await this.calculateFilePages(file);
        console.log('📄 Calculated pages for', file.name, ':', pages);

        // Cache the result
        this.readerModeState.renderedPages.set(file.path, pages);

        // Update current chapter pages
        this.readerModeState.chapterTotalPages = pages;

        // Calculate page height based on viewport
        this.readerModeState.pageHeight = this.calculatePageHeight();
        console.log('📏 Page height:', this.readerModeState.pageHeight);

        // Get current scroll position
        const contentEl = document.querySelector('.workspace-leaf.mod-active .markdown-source-view, .workspace-leaf.mod-active .markdown-reading-view, .workspace-leaf.mod-active .markdown-preview-view') as HTMLElement;
        if (contentEl) {
            this.readerModeState.contentHeight = contentEl.scrollHeight;
            this.readerModeState.currentScrollPosition = contentEl.scrollTop;
            console.log('📏 Content height:', this.readerModeState.contentHeight, 'Scroll pos:', this.readerModeState.currentScrollPosition);
        }
    }

    /**
     * Updates the pill displays with current page information
     */
    private updatePills() {
        const topPill = document.querySelector('.obsidian-r-top-pill') as HTMLElement;
        const bottomPill = document.querySelector('.obsidian-r-bottom-pill') as HTMLElement;

        console.log('🔄 Updating pills:', {
            topPill: !!topPill,
            bottomPill: !!bottomPill,
            chapterPage: this.readerModeState.chapterPage,
            chapterTotal: this.readerModeState.chapterTotalPages,
            globalPage: this.readerModeState.globalPage,
            globalTotal: this.readerModeState.globalTotalPages
        });

        if (topPill) {
            topPill.textContent = `${this.readerModeState.chapterPage}/${this.readerModeState.chapterTotalPages}`;
            console.log('🏷️ Updated top pill:', topPill.textContent);
        } else {
            console.log('❌ Top pill not found in DOM');
        }

        if (bottomPill) {
            bottomPill.textContent = `${this.readerModeState.globalPage}/${this.readerModeState.globalTotalPages}`;
            console.log('🏷️ Updated bottom pill:', bottomPill.textContent);
        } else {
            console.log('❌ Bottom pill not found in DOM');
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
        const loadedData = await this.loadData();
        this.settings = Object.assign({}, DEFAULT_SETTINGS, loadedData);

        // Migration: Update typography defaults if they're still at old values
        let settingsUpdated = false;
        if (this.settings.lineSpacing === 1.0) {
            this.settings.lineSpacing = 1.5;
            settingsUpdated = true;
            console.log('📖 Migrated lineSpacing to new default: 1.5');
        }
        if (this.settings.characterSpacing === 0.0) {
            this.settings.characterSpacing = 0.02;
            settingsUpdated = true;
            console.log('📖 Migrated characterSpacing to new default: 0.02');
        }

        // Save migrated settings
        if (settingsUpdated) {
            await this.saveSettings();
            console.log('📖 Settings migrated and saved');
        }
    }    /**
     * Saves plugin settings
     */
    async saveSettings() {
        await this.saveData(this.settings);
    }

    /**
     * Refreshes reader mode rendering when settings change
     */
    public refreshReaderModeIfActive() {
        console.log('🔄 refreshReaderModeIfActive called - isActive:', this.readerModeState.isActive);
        if (this.readerModeState.isActive) {
            console.log('🔄 Settings changed while in reader mode, refreshing styles...');
            this.applyReaderModeStyles();

            // Also recalculate pagination if it affects layout
            this.calculatePageNumbers();
            this.updatePills();
            console.log('🔄 Reader mode refresh completed');
        } else {
            console.log('🔄 Reader mode not active, skipping refresh');
        }
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
                    console.log('🔧 Justified setting changed to:', value);
                    this.plugin.settings.justified = value;
                    await this.plugin.saveSettings();
                    this.plugin.refreshReaderModeIfActive();
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
                    this.plugin.refreshReaderModeIfActive();
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
                    this.plugin.refreshReaderModeIfActive();
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
                    this.plugin.refreshReaderModeIfActive();
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
                    this.plugin.refreshReaderModeIfActive();
                }));

        new Setting(containerEl)
            .setName('Word Spacing')
            .setDesc('Adjust spacing between words (0 = normal, small values recommended)')
            .addSlider(slider => slider
                .setLimits(0.0, 0.5, 0.01)
                .setValue(this.plugin.settings.wordSpacing)
                .setDynamicTooltip()
                .onChange(async (value) => {
                    this.plugin.settings.wordSpacing = Math.round(value * 100) / 100;
                    await this.plugin.saveSettings();
                    this.plugin.refreshReaderModeIfActive();
                }));

        new Setting(containerEl)
            .setName('Font Size')
            .setDesc('Default font size in pixels (can be adjusted in reader mode)')
            .addSlider(slider => slider
                .setLimits(8, 48, 1)
                .setValue(this.plugin.settings.fontSize)
                .setDynamicTooltip()
                .onChange(async (value) => {
                    console.log('🔧 Font size setting changed to:', value);
                    this.plugin.settings.fontSize = value;
                    await this.plugin.saveSettings();
                    this.plugin.refreshReaderModeIfActive();
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
                    this.plugin.refreshReaderModeIfActive();
                }));

        // Reset Section
        containerEl.createEl('h3', { text: 'Reset' });

        new Setting(containerEl)
            .setName('Reset to Defaults')
            .setDesc('Reset all settings to their default values')
            .addButton(button => button
                .setButtonText('Reset All Settings')
                .setCta()
                .onClick(async () => {
                    // Reset settings to defaults
                    this.plugin.settings = Object.assign({}, DEFAULT_SETTINGS);
                    await this.plugin.saveSettings();

                    // Refresh reader mode if active
                    this.plugin.refreshReaderModeIfActive();

                    // Refresh the settings display
                    this.display();

                    // Show confirmation
                    new Notice('All settings have been reset to defaults');
                }));

    }
}