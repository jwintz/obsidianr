import { Plugin, TFile, TFolder, TAbstractFile, PluginSettingTab, App, Setting, Command, Notice, WorkspaceLeaf, MarkdownView } from 'obsidian';

// /////////////////////////////////////////////////////////////////////////////
// 
// /////////////////////////////////////////////////////////////////////////////

type LucideIconName =
    | 'a-arrow-down' | 'a-arrow-up'    // Font size controls
    | 'chevron-left' | 'chevron-right' // Navigation controls
    | 'list' | 'bookmark' | 'bar-chart-3' // Pane toggles  
    | 'eye' | 'eye-off';                // Zen mode toggle

// /////////////////////////////////////////////////////////////////////////////
// 
// /////////////////////////////////////////////////////////////////////////////

interface BookStructure {
    folder: TFolder;
    mainFile: TFile;
    imageFile: TFile | null;
    chapters: TFile[];
    title: string;
}

// /////////////////////////////////////////////////////////////////////////////
// 
// /////////////////////////////////////////////////////////////////////////////

interface ObsidianRSettings {
    // Transitions
    transitionType: 'none' | 'page-curl' | 'slide' | 'fade' | 'scroll';

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

// /////////////////////////////////////////////////////////////////////////////
// 
// /////////////////////////////////////////////////////////////////////////////

interface ReaderModeState {
    isActive: boolean;
    currentBook: BookStructure | null;
    currentChapter: TFile | null;
}

// /////////////////////////////////////////////////////////////////////////////
// 
// /////////////////////////////////////////////////////////////////////////////

const DEFAULT_SETTINGS: ObsidianRSettings = {
    transitionType: 'none',
    justified: true,
    horizontalMargins: 5, // 5% margins
    columns: 1,
    lineSpacing: 1.5, // Improved readability - typical for ebooks
    characterSpacing: 0.00, // Slight letter spacing for better readability
    wordSpacing: 0.0, // Normal word spacing (0 = browser default)
    fontSize: 16,
    fontFamily: 'Charter, "Bitstream Charter", "Sitka Text", Cambria, serif',
    showToc: false,
    showBookmarks: false,
    showStats: false
};

// /////////////////////////////////////////////////////////////////////////////
// 
// /////////////////////////////////////////////////////////////////////////////

/**
 * Font management utility for loading fonts from CDN
 */
class FontManager {
    private static fontsLoaded = false;
    private static fontLoadPromise: Promise<void> | null = null;

    /**
     * Available fonts with their Google Fonts URLs
     */
    private static readonly FONTS = {
        'Charter': {
            name: 'Charter',
            css: 'Charter, "Bitstream Charter", "Sitka Text", Cambria, serif',
            url: null as string | null // Charter is a system font
        },
        'Palatino': {
            name: 'Palatino',
            css: '"Palatino Linotype", Palatino, "Book Antiqua", serif',
            url: null as string | null // Palatino is a system font
        },
        'Georgia': {
            name: 'Georgia',
            css: 'Georgia, "Times New Roman", Times, serif',
            url: null as string | null // Georgia is a system font
        },
        'Crimson Text': {
            name: 'Crimson Text',
            css: '"Crimson Text", serif',
            url: 'https://fonts.googleapis.com/css2?family=Crimson+Text:ital,wght@0,400;0,600;1,400;1,600&display=swap'
        },
        'Lora': {
            name: 'Lora',
            css: 'Lora, serif',
            url: 'https://fonts.googleapis.com/css2?family=Lora:ital,wght@0,400..700;1,400..700&display=swap'
        },
        'Merriweather': {
            name: 'Merriweather',
            css: 'Merriweather, serif',
            url: 'https://fonts.googleapis.com/css2?family=Merriweather:ital,wght@0,300;0,400;0,700;1,300;1,400;1,700&display=swap'
        },
        'Libre Baskerville': {
            name: 'Libre Baskerville',
            css: '"Libre Baskerville", serif',
            url: 'https://fonts.googleapis.com/css2?family=Libre+Baskerville:ital,wght@0,400;0,700;1,400&display=swap'
        },
        'EB Garamond': {
            name: 'EB Garamond',
            css: '"EB Garamond", serif',
            url: 'https://fonts.googleapis.com/css2?family=EB+Garamond:ital,wght@0,400..800;1,400..800&display=swap'
        }
    };

    /**
     * Loads all fonts from CDN
     */
    static async loadFonts(): Promise<void> {
        if (this.fontsLoaded) return;
        if (this.fontLoadPromise) return this.fontLoadPromise;

        this.fontLoadPromise = this.loadGoogleFonts();
        return this.fontLoadPromise;
    }

    /**
     * Loads Google Fonts dynamically
     */
    private static async loadGoogleFonts(): Promise<void> {
        try {
            const fontUrls = Object.values(this.FONTS)
                .map(font => font.url)
                .filter(url => url !== null) as string[];

            // Create link elements for each font
            const loadPromises = fontUrls.map(url => {
                return new Promise<void>((resolve, reject) => {
                    const link = document.createElement('link');
                    link.rel = 'stylesheet';
                    link.href = url;
                    link.onload = () => resolve();
                    link.onerror = () => reject(new Error(`Failed to load font: ${url}`));
                    document.head.appendChild(link);
                });
            });

            await Promise.all(loadPromises);
            this.fontsLoaded = true;
        } catch (error) {
            console.warn('Some fonts failed to load:', error);
            // Continue anyway with system fonts
            this.fontsLoaded = true;
        }
    }

    /**
     * Gets the font configuration
     */
    static getFonts() {
        return this.FONTS;
    }
}

// /////////////////////////////////////////////////////////////////////////////
// 
// /////////////////////////////////////////////////////////////////////////////

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

        button.addEventListener('click', (e) => {
            e.stopPropagation();
            onClick();
        });
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
        await this.ensureLucideAvailable();

        try {
            // Try Obsidian's setIcon first (desktop)
            if (typeof (window as any).setIcon === 'function') {
                iconEl.innerHTML = ''; // Clear existing content
                iconEl.removeAttribute('data-lucide'); // Clear any existing data attribute
                (window as any).setIcon(iconEl, newIconName);
                return;
            }

            // Mobile fallback: Use Lucide directly
            if ((window as any).lucide) {
                // Clear existing content and attributes
                iconEl.innerHTML = '';
                iconEl.removeAttribute('data-lucide');

                // Convert kebab-case to camelCase for Lucide icon names
                const camelCaseIconName = newIconName.replace(/-([a-z])/g, (g) => g[1].toUpperCase());

                // Try direct SVG insertion first
                if ((window as any).lucide.icons && (window as any).lucide.icons[camelCaseIconName]) {
                    const iconData = (window as any).lucide.icons[camelCaseIconName];
                    iconEl.innerHTML = iconData;
                } else {
                    // Fallback: create a new icon element and copy its content
                    const tempIcon = await this.createIcon(newIconName);
                    iconEl.innerHTML = tempIcon.innerHTML;
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

// /////////////////////////////////////////////////////////////////////////////
// 
// /////////////////////////////////////////////////////////////////////////////

export default class ObsidianRPlugin extends Plugin {
    settings: ObsidianRSettings;
    private detectedBooks: Map<string, BookStructure> = new Map();
    private scanTimeoutId: number | null = null; // For debouncing scans
    private decorationTimeoutId: number | null = null; // For debouncing decorations
    private readerModeState: ReaderModeState = {
        isActive: false,
        currentBook: null,
        currentChapter: null
    };
    private originalContentBackup: string | null = null; // Store original content before any modifications
    private readerModeEl: HTMLElement | null = null;
    private controlsEl: HTMLElement | null = null;
    private hideControlsTimeout: number | null = null;
    private readerClickHandler: ((event: Event) => void) | null = null;
    private readerKeyboardHandler: ((event: KeyboardEvent) => void) | null = null;
    private zenMode: boolean = false;
    private originalViewMode: 'source' | 'preview' | null = null;

    async onload() {
        // Load settings
        await this.loadSettings();

        // Initialize fonts from CDN
        FontManager.loadFonts();

        // Add settings tab
        this.addSettingTab(new ObsidianRSettingTab(this.app, this));

        // Add commands
        this.addCommand({
            id: 'toggle-reader-mode',
            name: 'Toggle Reader Mode',
            callback: () => {
                this.toggleReaderMode();
            },
            hotkeys: []
        });

        // Initial scan for books
        await this.scanForBooks();

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
            // French: [Title] - Chapitre X.md
            new RegExp(`^${this.escapeRegex(folderName)} - (Chapitre \\d+|Épilogue|Prologue|Préambule|Avant-propos|Postface)$`),
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

            // Check for prologue (case insensitive, multi-language)
            const aIsPrologue = /prologue|préambule|avant-propos/i.test(aBasename);
            const bIsPrologue = /prologue|préambule|avant-propos/i.test(bBasename);

            // Prologue comes first
            if (aIsPrologue && !bIsPrologue) return -1;
            if (!aIsPrologue && bIsPrologue) return 1;

            // Check for epilogue (case insensitive, multi-language)
            const aIsEpilogue = /epilogue|épilogue|postface/i.test(aBasename);
            const bIsEpilogue = /epilogue|épilogue|postface/i.test(bBasename);

            // Epilogue comes last
            if (aIsEpilogue && !bIsEpilogue) return 1;
            if (!aIsEpilogue && bIsEpilogue) return -1;

            // Notes/appendix come after chapters but before epilogue
            const aIsNote = /notes?|appendix|index|glossary|bibliography/i.test(aBasename);
            const bIsNote = /notes?|appendix|index|glossary|bibliography/i.test(bBasename);

            if (aIsNote && !bIsNote) return 1;  // a (note) comes after b (chapter)
            if (!aIsNote && bIsNote) return -1; // a (chapter) comes before b (note)

            // Extract chapter numbers for regular chapters (case insensitive)
            const aMatch = aBasename.match(/chapter\s+(\d+)/i) || aBasename.match(/chapitre\s+(\d+)/i);
            const bMatch = bBasename.match(/chapter\s+(\d+)/i) || bBasename.match(/chapitre\s+(\d+)/i);

            if (aMatch && bMatch) {
                return parseInt(aMatch[1]) - parseInt(bMatch[1]);
            }

            // If one is a chapter and the other isn't, chapter comes first (unless it's a note)
            if (aMatch && !bMatch && !bIsNote && !bIsPrologue && !bIsEpilogue) return -1;
            if (!aMatch && bMatch && !aIsNote && !aIsPrologue && !aIsEpilogue) return 1;

            // Fallback to alphabetical
            return aBasename.localeCompare(bBasename);
        });
    }    /**
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

                // Also refresh reader mode if active
                if (this.readerModeState.isActive) {
                    setTimeout(() => {
                        this.refreshReaderModeIfActive();
                    }, 300);
                }
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


        // Use requestAnimationFrame to avoid forced reflows during execution
        requestAnimationFrame(() => {
            // First, remove all existing BOOK pills to avoid duplicates
            document.querySelectorAll('.book-pill').forEach(pill => pill.remove());

            // Find all nav-folder elements with more patience
            const folderElements = document.querySelectorAll('.nav-folder');

            folderElements.forEach((folderElement) => {
                const titleElement = folderElement.querySelector('.nav-folder-title-content');
                if (!titleElement) return;

                const folderName = titleElement.textContent;
                if (!folderName) return;

                // Check if this folder name matches any detected book folder
                const isBook = bookFolderNames.has(folderName);

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

        const activeFile = this.app.workspace.getActiveFile();
        if (!activeFile) {
            new Notice('No file is currently open');
            return;
        }

        // Check if the current file is part of a book
        const book = this.findBookForFile(activeFile);
        if (!book) {
            new Notice('Current file is not part of a detected book');
            return;
        }

        this.readerModeState.isActive = true;
        this.readerModeState.currentBook = book;
        this.readerModeState.currentChapter = activeFile;

        // Switch to reading view for better reading experience
        await this.switchToReadingView();

        // Create reader mode UI
        await this.createReaderModeUI();
        this.showReaderControls();

        // Apply visual styling to content area
        this.applyReaderModeStyles();

        // Add reader mode keyboard handlers
        this.addReaderModeKeyboardHandlers();

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

        // Switch to preview mode if not already
        if (this.originalViewMode !== 'preview') {
            await activeMarkdownView.setState({ mode: 'preview' }, { history: false });
        }
    }

    /**
     * Restores the original view mode when exiting reader mode
     */
    private async restoreOriginalViewMode() {
        if (!this.originalViewMode) return;

        const activeMarkdownView = this.app.workspace.getActiveViewOfType(MarkdownView);
        if (!activeMarkdownView) return;

        await activeMarkdownView.setState({ mode: this.originalViewMode }, { history: false });
        this.originalViewMode = null;
    }

    /**
     * Applies reader mode visual styling to the content area
     */
    private applyReaderModeStyles() {

        // Create or update the style element
        let styleEl = document.getElementById('obsidian-r-reader-styles') as HTMLStyleElement;
        if (!styleEl) {
            styleEl = document.createElement('style');
            styleEl.id = 'obsidian-r-reader-styles';
            document.head.appendChild(styleEl);
        }

        const horizontalMarginPx = (window.innerWidth * this.settings.horizontalMargins) / 100;
        const contentWidth = window.innerWidth - (horizontalMarginPx * 2);

        // Apply styles to current view mode and add class for identification
        const activeLeaf = this.app.workspace.activeLeaf;
        if (activeLeaf?.view?.containerEl) {
            activeLeaf.view.containerEl.classList.add('obsidian-r-active');
        }

        // Hide view actions and view header left for cleaner reader experience
        const viewActionsElements = document.querySelectorAll('.view-actions') as NodeListOf<HTMLElement>;
        viewActionsElements.forEach((viewActionsEl) => {
            viewActionsEl.style.display = 'none';
        });

        const viewHeaderLeftElements = document.querySelectorAll('.view-header-left') as NodeListOf<HTMLElement>;
        viewHeaderLeftElements.forEach((viewHeaderLeftEl) => {
            viewHeaderLeftEl.style.display = 'none';
        });

        const css = `
            /* Reader mode typography and layout styles */
            .obsidian-r-active .markdown-preview-sizer,
            .workspace-leaf.has-obsidian-r-controls .markdown-preview-sizer,
            .workspace-leaf-content.has-obsidian-r-controls .markdown-preview-sizer {
                max-width: ${contentWidth}px !important;
                margin: 0 auto !important;
                padding-left: ${horizontalMarginPx}px !important;
                padding-right: ${horizontalMarginPx}px !important;
                padding-top: 60px !important; /* Top margin for breathing room */
                padding-bottom: 120px !important; /* Bottom margin to avoid pills/controls overlap */
                box-sizing: border-box !important;
                font-family: ${this.settings.fontFamily} !important;
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
                /* Reader mode styles - removed pagination constraints for now */
            }

            /* Reader mode typography and layout styles */

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
                font-family: ${this.settings.fontFamily} !important;
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
                padding: 0 !important; /* Reset padding for accurate margin computation */
            }

            /* Reset padding on rendered content containers */
            .obsidian-r-active .markdown-preview-view .markdown-rendered,
            .workspace-leaf.has-obsidian-r-controls .markdown-preview-view .markdown-rendered,
            .workspace-leaf-content.has-obsidian-r-controls .markdown-preview-view .markdown-rendered {
                padding: 0 !important; /* Reset padding for accurate margin computation */
            }

            /* Hide frontmatter in reader mode - for any tab with reader mode, not just active */
            .obsidian-r-active .metadata-container,
            .workspace-leaf.has-obsidian-r-controls .metadata-container,
            .workspace-leaf-content.has-obsidian-r-controls .metadata-container {
                display: none !important;
            }

            /* Hide navigation elements in reader mode - only in active tab */
            .workspace-leaf.mod-active .obsidian-r-active .nav-header,
            .workspace-leaf.mod-active .obsidian-r-active .backlink-pane,
            .workspace-leaf.mod-active .obsidian-r-active .mod-footer,
            .workspace-leaf.mod-active.has-obsidian-r-controls .nav-header,
            .workspace-leaf.mod-active.has-obsidian-r-controls .backlink-pane,
            .workspace-leaf.mod-active.has-obsidian-r-controls .mod-footer {
                display: none !important;
            }

            /* Hide heading collapse indicators in reader mode - only in markdown content, not file explorer or sidebars */
            .workspace-leaf.mod-active .obsidian-r-active .markdown-preview-view .heading-collapse-indicator,
            .workspace-leaf.mod-active .obsidian-r-active .markdown-preview-view .collapse-indicator,
            .workspace-leaf.mod-active .obsidian-r-active .markdown-preview-view .collapse-icon,
            .workspace-leaf.mod-active .obsidian-r-active .markdown-reading-view .heading-collapse-indicator,
            .workspace-leaf.mod-active .obsidian-r-active .markdown-reading-view .collapse-indicator,
            .workspace-leaf.mod-active .obsidian-r-active .markdown-reading-view .collapse-icon,
            .workspace-leaf.mod-active .obsidian-r-active .markdown-source-view .heading-collapse-indicator,
            .workspace-leaf.mod-active .obsidian-r-active .markdown-source-view .collapse-indicator,
            .workspace-leaf.mod-active .obsidian-r-active .markdown-source-view .collapse-icon,
            .workspace-leaf.mod-active.has-obsidian-r-controls .markdown-preview-view .heading-collapse-indicator,
            .workspace-leaf.mod-active.has-obsidian-r-controls .markdown-preview-view .collapse-indicator,
            .workspace-leaf.mod-active.has-obsidian-r-controls .markdown-preview-view .collapse-icon,
            .workspace-leaf.mod-active.has-obsidian-r-controls .markdown-reading-view .heading-collapse-indicator,
            .workspace-leaf.mod-active.has-obsidian-r-controls .markdown-reading-view .collapse-indicator,
            .workspace-leaf.mod-active.has-obsidian-r-controls .markdown-reading-view .collapse-icon,
            .workspace-leaf.mod-active.has-obsidian-r-controls .markdown-source-view .heading-collapse-indicator,
            .workspace-leaf.mod-active.has-obsidian-r-controls .markdown-source-view .collapse-indicator,
            .workspace-leaf.mod-active.has-obsidian-r-controls .markdown-source-view .collapse-icon {
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
    }

    /**
     * Removes reader mode visual styling
     */
    private removeReaderModeStyles() {
        const styleEl = document.getElementById('obsidian-r-reader-styles');
        if (styleEl) {
            styleEl.remove();
        }

        // Remove active class from view container
        const activeLeaf = this.app.workspace.activeLeaf;
        if (activeLeaf?.view?.containerEl) {
            activeLeaf.view.containerEl.classList.remove('obsidian-r-active');
        }

        // Restore view actions and view header left
        const viewActionsElements = document.querySelectorAll('.view-actions') as NodeListOf<HTMLElement>;
        viewActionsElements.forEach((viewActionsEl) => {
            viewActionsEl.style.display = '';
        });

        const viewHeaderLeftElements = document.querySelectorAll('.view-header-left') as NodeListOf<HTMLElement>;
        viewHeaderLeftElements.forEach((viewHeaderLeftEl) => {
            viewHeaderLeftEl.style.display = '';
        });
    }

    /**
     * Updates page navigation button states
     */
    private updatePageNavigation() {
        // For now, just enable the buttons for chapter navigation
    }

    /**
     * Applies page transition effects based on settings
     */
    private applyPageTransition(contentEl: HTMLElement, newContent: string, isInitialLoad: boolean = false) {
        const transitionType = this.settings.transitionType;


        // Skip animation for initial load - just update content directly
        if (isInitialLoad) {
            contentEl.innerHTML = newContent;

            // Force a repaint to ensure content is visible
            contentEl.style.display = 'none';
            contentEl.offsetHeight; // Trigger reflow
            contentEl.style.display = '';
            return;
        }

        // Remove any existing transition classes
        contentEl.classList.remove('obsidian-r-page-transition', 'page-curl', 'slide', 'fade', 'scroll');

        switch (transitionType) {
            case 'none':
                // No transition, just update content immediately
                contentEl.innerHTML = newContent;

                // Force a repaint to ensure content is visible
                contentEl.style.display = 'none';
                contentEl.offsetHeight; // Trigger reflow
                contentEl.style.display = '';
                break;
            case 'fade':
                this.applyFadeTransition(contentEl, newContent);
                break;
            case 'slide':
                this.applySlideTransition(contentEl, newContent);
                break;
            case 'page-curl':
                this.applyPageCurlTransition(contentEl, newContent);
                break;
            case 'scroll':
                this.applyScrollTransition(contentEl, newContent);
                break;
            default:
                // No transition, just update content immediately
                contentEl.innerHTML = newContent;

                // Force a repaint to ensure content is visible
                contentEl.style.display = 'none';
                contentEl.offsetHeight; // Trigger reflow
                contentEl.style.display = '';
                break;
        }
    }

    /**
     * Applies fade transition
     */
    private applyFadeTransition(contentEl: HTMLElement, newContent: string) {
        contentEl.style.transition = 'opacity 0.3s ease-in-out';
        contentEl.style.opacity = '0';

        setTimeout(() => {
            contentEl.innerHTML = newContent;
            contentEl.style.opacity = '1';
        }, 150);
    }

    /**
     * Applies slide transition
     */
    private applySlideTransition(contentEl: HTMLElement, newContent: string) {
        contentEl.style.transition = 'transform 0.3s ease-in-out';
        contentEl.style.transform = 'translateX(-100%)';

        setTimeout(() => {
            contentEl.innerHTML = newContent;
            contentEl.style.transform = 'translateX(100%)';

            // Slide in from right
            setTimeout(() => {
                contentEl.style.transform = 'translateX(0)';
            }, 50);
        }, 150);
    }

    /**
     * Applies page curl transition
     */
    private applyPageCurlTransition(contentEl: HTMLElement, newContent: string) {
        contentEl.style.transition = 'transform 0.5s cubic-bezier(0.25, 0.46, 0.45, 0.94)';
        contentEl.style.transformOrigin = 'top left';
        contentEl.style.transform = 'rotateY(-15deg) scale(0.95)';
        contentEl.style.opacity = '0.8';

        setTimeout(() => {
            contentEl.innerHTML = newContent;
            contentEl.style.transform = 'rotateY(15deg) scale(0.95)';

            // Rotate back to normal
            setTimeout(() => {
                contentEl.style.transform = 'rotateY(0deg) scale(1)';
                contentEl.style.opacity = '1';
            }, 50);
        }, 250);
    }

    /**
     * Applies scroll transition
     */
    private applyScrollTransition(contentEl: HTMLElement, newContent: string) {
        contentEl.style.transition = 'transform 0.4s ease-out';
        contentEl.style.transform = 'translateY(-20px)';
        contentEl.style.opacity = '0.7';

        setTimeout(() => {
            contentEl.innerHTML = newContent;
            contentEl.style.transform = 'translateY(20px)';

            // Slide in from bottom
            setTimeout(() => {
                contentEl.style.transform = 'translateY(0)';
                contentEl.style.opacity = '1';
            }, 50);
        }, 200);
    }

    /**
     * Navigates to next chapter
     */
    private async nextChapter() {
        if (!this.readerModeState.currentBook) return;

        const chapters = this.readerModeState.currentBook.chapters;
        const currentIndex = chapters.findIndex(ch => ch.path === this.readerModeState.currentChapter?.path);

        if (currentIndex >= 0 && currentIndex < chapters.length - 1) {
            const nextChapter = chapters[currentIndex + 1];
            // Open the next chapter file
            await this.app.workspace.openLinkText(nextChapter.path, '', false);
        }
    }

    /**
     * Navigates to previous chapter
     */
    private async previousChapter() {
        if (!this.readerModeState.currentBook) return;

        const chapters = this.readerModeState.currentBook.chapters;
        const currentIndex = chapters.findIndex(ch => ch.path === this.readerModeState.currentChapter?.path);

        if (currentIndex > 0) {
            const prevChapter = chapters[currentIndex - 1];
            // Open the previous chapter file
            await this.app.workspace.openLinkText(prevChapter.path, '', false);
        }
    }

    /**
     * Exits reader mode
     */
    async exitReaderMode() {
        if (!this.readerModeState.isActive) {
            return;
        }

        this.readerModeState.isActive = false;
        this.readerModeState.currentBook = null;
        this.readerModeState.currentChapter = null;

        // Clear content backup
        this.originalContentBackup = null;


        // Restore UI elements if zen mode was enabled
        if (this.zenMode) {
            this.restoreZenMode();
        }

        // Remove reader mode keyboard handlers
        this.removeReaderModeKeyboardHandlers();

        // Restore original view mode
        await this.restoreOriginalViewMode();

        // Remove reader mode styles
        this.removeReaderModeStyles();

        // Clean up UI
        this.destroyReaderModeUI();

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
    private async createReaderModeUI() {
        if (this.readerModeEl) return;


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

        // Create controls overlay
        await this.createReaderControls();

    }

    /**
     * Creates the reader controls overlay
     */
    private async createReaderControls() {
        if (this.controlsEl) {
            return;
        }

        this.controlsEl = document.createElement('div');
        this.controlsEl.className = 'obsidian-r-controls';

        // Prevent clicks on controls from bubbling up to document
        this.controlsEl.addEventListener('click', (e) => {
            e.stopPropagation();
        });

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
        const fontSizePromise = Promise.all([
            IconManager.createIconButton('a-arrow-down', 'Decrease font size', () => this.adjustFontSize(-1)),
            IconManager.createIconButton('a-arrow-up', 'Increase font size', () => this.adjustFontSize(1))
        ]).then(([decreaseFontBtn, increaseFontBtn]) => {
            fontSizeGroup.appendChild(decreaseFontBtn);
            fontSizeGroup.appendChild(increaseFontBtn);
            // Refresh icons after DOM insertion for mobile compatibility
            IconManager.refreshIcons(fontSizeGroup);
        });

        // Page navigation controls
        const pageNavGroup = document.createElement('div');
        pageNavGroup.className = 'obsidian-r-page-nav-group';

        // Create navigation buttons with proper icons
        const pageNavPromise = Promise.all([
            IconManager.createIconButton('chevron-left', 'Previous chapter', () => this.previousChapter()),
            IconManager.createIconButton('chevron-right', 'Next chapter', () => this.nextChapter())
        ]).then(([prevBtn, nextBtn]) => {
            pageNavGroup.appendChild(prevBtn);
            pageNavGroup.appendChild(nextBtn);
            // Refresh icons after DOM insertion for mobile compatibility
            IconManager.refreshIcons(pageNavGroup);
        });


        // Font family dropdown
        const fontGroup = document.createElement('div');
        fontGroup.className = 'obsidian-r-font-group';

        const fontSelect = document.createElement('select');
        fontSelect.className = 'obsidian-r-font-select';
        const fonts = FontManager.getFonts();
        Object.values(fonts).forEach(font => {
            const option = document.createElement('option');
            option.value = font.css;
            option.textContent = font.name;
            option.selected = font.css === this.settings.fontFamily;
            fontSelect.appendChild(option);
        });
        fontSelect.addEventListener('change', (e) => {
            e.stopPropagation(); // Prevent event from bubbling up
            const target = e.target as HTMLSelectElement;
            this.changeFontFamily(target.value);
        });

        fontGroup.appendChild(fontSelect);

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
            this.zenMode = checked;
            this.toggleZenMode();
            this.saveSettings();
        }, async (toggleButton: HTMLElement, checked: boolean) => {
            // Update zen mode icon based on state
            const newIconName = checked ? 'eye-off' : 'eye';

            try {
                // Find the icon element within the toggle button
                const iconEl = toggleButton.querySelector('.obsidian-r-toggle-icon') as HTMLElement;
                if (!iconEl) {
                    console.error('Could not find icon element in toggle button');
                    return;
                }


                // CRITICAL: Update the data-lucide attribute FIRST
                iconEl.setAttribute('data-lucide', newIconName);

                // Create a completely new icon element
                const newIcon = await IconManager.createIcon(newIconName, 'obsidian-r-toggle-icon');

                // Replace the entire icon element
                iconEl.parentNode?.replaceChild(newIcon, iconEl);

            } catch (error) {
                console.error('Failed to update zen icon:', error);
            }
        });

        // Create all toggles asynchronously
        const panePromise = Promise.all([tocToggle, bookmarksToggle, statsToggle, zenToggle]).then(([tocEl, bookmarksEl, statsEl, zenEl]) => {
            paneGroup.appendChild(tocEl);
            paneGroup.appendChild(bookmarksEl);
            paneGroup.appendChild(statsEl);

            // Add special class to zen toggle for separate spacing
            zenEl.classList.add('obsidian-r-zen-toggle');
            paneGroup.appendChild(zenEl);

            // CRITICAL: Update zen icon data-lucide attribute BEFORE refresh
            this.updateZenIconAttribute(zenEl);

            // Refresh icons after DOM insertion for mobile compatibility
            IconManager.refreshIcons(paneGroup);
        });

        // Wait for async operations to complete before assembling the bottom bar
        await Promise.all([fontSizePromise, pageNavPromise, panePromise]);


        bottomBar.appendChild(fontSizeGroup);
        bottomBar.appendChild(pageNavGroup);
        bottomBar.appendChild(fontGroup);
        bottomBar.appendChild(paneGroup);

        this.controlsEl.appendChild(bottomBar);

        // Append controls to the active workspace leaf container
        this.appendControlsToActiveTab();
    }

    /**
     * Appends controls to the active tab's viewport
     */
    private appendControlsToActiveTab() {
        const workspaceLeaf = this.app.workspace.activeLeaf;


        // Try different approaches to find the right container
        let targetContainer: HTMLElement | null = null;

        // Approach 1: Try the workspace leaf view container
        if (workspaceLeaf?.view?.containerEl) {
            targetContainer = workspaceLeaf.view.containerEl;
        }

        // Approach 2: Try finding the active tab container by class
        if (!targetContainer) {
            const activeTabContainer = document.querySelector('.workspace-tabs.mod-active .workspace-tab-container') as HTMLElement;
            if (activeTabContainer) {
                targetContainer = activeTabContainer;
            }
        }

        // Approach 3: Try finding the workspace leaf content
        if (!targetContainer) {
            const leafContent = document.querySelector('.workspace-leaf.mod-active .workspace-leaf-content') as HTMLElement;
            if (leafContent) {
                targetContainer = leafContent;
            }
        }

        if (targetContainer) {

            // Add class to ensure relative positioning
            targetContainer.classList.add('has-obsidian-r-controls');
            targetContainer.appendChild(this.controlsEl!);


            // CRITICAL: Refresh all icons after controls are appended to DOM with delay
            setTimeout(() => {
                IconManager.refreshIcons(this.controlsEl!);
            }, 100);
        } else {
            document.body.appendChild(this.controlsEl!);

            // CRITICAL: Refresh all icons after controls are appended to DOM with delay
            setTimeout(() => {
                IconManager.refreshIcons(this.controlsEl!);
            }, 100);
        }
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
        toggle.addEventListener('click', (e) => {
            e.stopPropagation(); // Prevent event from bubbling up
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
        if (!this.controlsEl) {
            return;
        }


        this.controlsEl.style.display = 'block';
        this.controlsEl.classList.add('visible');


        // Debug computed styles
        const computedStyle = window.getComputedStyle(this.controlsEl);

        // Debug element positioning
        const rect = this.controlsEl.getBoundingClientRect();

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
        this.settings.fontSize = Math.max(10, Math.min(32, this.settings.fontSize + delta));
        this.saveSettings();

        // Use the comprehensive refresh method for reader mode updates
        this.refreshReaderModeIfActive();
    }

    /**
     * Changes font family
     */
    private changeFontFamily(fontFamily: string) {
        this.settings.fontFamily = fontFamily;
        this.saveSettings();

        // Use the comprehensive refresh method for reader mode updates
        this.refreshReaderModeIfActive();
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

        // Toggle left sidebar visibility
        const leftSidebarEl = document.querySelector('.workspace-split.mod-left-split') as HTMLElement;
        if (leftSidebarEl) {
            const isHidden = leftSidebarEl.style.display === 'none';
            leftSidebarEl.style.display = isHidden ? '' : 'none';
        } else {
        }

        // Toggle right sidebar visibility  
        const rightSidebarEl = document.querySelector('.workspace-split.mod-right-split') as HTMLElement;
        if (rightSidebarEl) {
            const isHidden = rightSidebarEl.style.display === 'none';
            rightSidebarEl.style.display = isHidden ? '' : 'none';
        } else {
        }

        // Toggle status bar visibility
        const statusBarElements = document.querySelectorAll('.status-bar') as NodeListOf<HTMLElement>;
        statusBarElements.forEach((statusBarEl, index) => {
            const isHidden = statusBarEl.style.display === 'none';
            statusBarEl.style.display = isHidden ? '' : 'none';
        });

        // Toggle tab bar visibility

        // Target all .workspace-tab-header-container elements
        const tabBarElements = document.querySelectorAll('.workspace-tab-header-container') as NodeListOf<HTMLElement>;

        tabBarElements.forEach((tabBarEl, index) => {
            const isHidden = tabBarEl.style.display === 'none';
            tabBarEl.style.display = isHidden ? '' : 'none';
        });

        if (tabBarElements.length === 0) {
        }


        // Force a small delay and then refresh controls to ensure icon state is preserved
        setTimeout(() => {
            if (this.controlsEl) {
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
            return;
        }

        const currentAttribute = iconEl.getAttribute('data-lucide');
        const expectedAttribute = this.zenMode ? 'eye-off' : 'eye';


        iconEl.setAttribute('data-lucide', expectedAttribute);

    }

    /**
     * Updates the zen icon to match the current zen mode state
     */
    private async updateZenIcon() {
        if (!this.controlsEl) return;

        // Find ALL zen buttons, not just the first one
        const zenButtons = this.controlsEl.querySelectorAll('.obsidian-r-pane-toggle') as NodeListOf<HTMLElement>;

        // Find the zen button specifically (it should be the last one in the pane group)
        let zenButton: HTMLElement | null = null;
        zenButtons.forEach((button, index) => {
            const iconEl = button.querySelector('.obsidian-r-toggle-icon') as HTMLElement;
            const iconName = iconEl?.getAttribute('data-lucide');

            // The zen button should have either 'eye' or 'eye-off' icon
            if (iconName === 'eye' || iconName === 'eye-off') {
                zenButton = button;
            }
        });

        if (!zenButton) {
            return;
        }

        const iconEl = zenButton.querySelector('.obsidian-r-toggle-icon') as HTMLElement;
        if (!iconEl) {
            return;
        }

        const currentIconName = iconEl.getAttribute('data-lucide');
        const expectedIconName = this.zenMode ? 'eye-off' : 'eye';


        if (currentIconName === expectedIconName) {
            return;
        }

        try {
            // CRITICAL: Update the data-lucide attribute FIRST
            iconEl.setAttribute('data-lucide', expectedIconName);

            const newIcon = await IconManager.createIcon(expectedIconName, 'obsidian-r-toggle-icon');
            iconEl.parentNode?.replaceChild(newIcon, iconEl);
        } catch (error) {
            console.error('❌ Failed to update zen icon:', error);
        }
    }

    /**
     * Restores UI elements to their normal state (shows sidebars and tab bar)
     */
    private restoreZenMode() {

        // Show left sidebar
        const leftSidebarEl = document.querySelector('.workspace-split.mod-left-split') as HTMLElement;
        if (leftSidebarEl) {
            leftSidebarEl.style.display = '';
        }

        // Show right sidebar  
        const rightSidebarEl = document.querySelector('.workspace-split.mod-right-split') as HTMLElement;
        if (rightSidebarEl) {
            rightSidebarEl.style.display = '';
        }

        // Show status bar
        const statusBarElements = document.querySelectorAll('.status-bar') as NodeListOf<HTMLElement>;
        statusBarElements.forEach((statusBarEl, index) => {
            statusBarEl.style.display = '';
        });

        // Show tab bar

        // Restore all .workspace-tab-header-container elements
        const tabBarElements = document.querySelectorAll('.workspace-tab-header-container') as NodeListOf<HTMLElement>;

        tabBarElements.forEach((tabBarEl, index) => {
            tabBarEl.style.display = '';
        });

        if (tabBarElements.length === 0) {
        }

    }

    /**
     * Sets up keyboard event handlers for reader mode
     */
    private addReaderModeKeyboardHandlers() {

        const testHandler = (e: KeyboardEvent) => {
            if (!this.readerModeState.isActive) return;

            // Page navigation
            if (e.key === 'ArrowLeft' || e.key === 'ArrowUp' || e.key === 'PageUp') {
                if (!e.ctrlKey && !e.metaKey && !e.altKey && !e.shiftKey) {
                    e.preventDefault();
                    // Chapter navigation could be implemented here
                    return;
                }
            }

            if (e.key === 'ArrowRight' || e.key === 'ArrowDown' || e.key === 'PageDown' || e.key === ' ') {
                if (!e.ctrlKey && !e.metaKey && !e.altKey && !e.shiftKey) {
                    e.preventDefault();
                    // Chapter navigation could be implemented here
                    return;
                }
            }

            // Home/End for first/last page
            if (e.key === 'Home') {
                if (!e.ctrlKey && !e.metaKey && !e.altKey && !e.shiftKey) {
                    e.preventDefault();
                    // Could scroll to top if needed
                    return;
                }
            }

            if (e.key === 'End') {
                if (!e.ctrlKey && !e.metaKey && !e.altKey && !e.shiftKey) {
                    e.preventDefault();
                    // Could scroll to bottom if needed
                    return;
                }
            }

            // Test for font size keys (without modifiers)
            if (e.key === '+' || e.key === '=') {
                if (!e.ctrlKey && !e.metaKey && !e.altKey && !e.shiftKey) {
                    e.preventDefault();
                    this.adjustFontSize(1);
                    return;
                }
            }

            if (e.key === '-') {
                if (!e.ctrlKey && !e.metaKey && !e.altKey && !e.shiftKey) {
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

    }

    /**
     * Calculates page numbers based on actual rendering and layout
     */
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
            // Update current chapter and refresh reader mode UI
            this.readerModeState.currentChapter = activeFile;
            // Refresh reader mode UI for the new chapter
            this.refreshReaderModeIfActive();
        } else {
            // File is not part of current book - check if it's part of any book
            const newBook = this.findBookForFile(activeFile);
            if (newBook) {
                // File is part of a different book - switch to new book's reader mode
                this.readerModeState.currentBook = newBook;
                this.readerModeState.currentChapter = activeFile;
                this.refreshReaderModeIfActive();
            } else {
                // File is not part of any book - remove reader mode from current tab only
                this.exitReaderMode();
            }
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
        }
        if (this.settings.characterSpacing === 0.0) {
            this.settings.characterSpacing = 0.02;
            settingsUpdated = true;
        }

        // Save migrated settings
        if (settingsUpdated) {
            await this.saveSettings();
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
        if (this.readerModeState.isActive) {
            this.applyReaderModeStyles();

            // Only recreate controls if they don't exist
            // Don't destroy existing controls just to refresh settings
            if (!this.controlsEl) {
                this.createReaderControls();
            }

        } else {
        }
    }

    /**
     * Forces recreation of reader controls (used when settings change from outside)
     */
    public recreateReaderControlsIfActive() {
        if (this.readerModeState.isActive) {
            this.applyReaderModeStyles();

            // Recreate controls to reflect updated settings
            if (this.controlsEl) {
                this.controlsEl.remove();
                this.controlsEl = null;
                this.createReaderControls();
            }
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

// /////////////////////////////////////////////////////////////////////////////
// 
// /////////////////////////////////////////////////////////////////////////////

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
                .addOption('none', 'None')
                .addOption('page-curl', 'Page Curl')
                .addOption('slide', 'Slide')
                .addOption('fade', 'Fade')
                .addOption('scroll', 'Scroll')
                .setValue(this.plugin.settings.transitionType)
                .onChange(async (value: 'none' | 'page-curl' | 'slide' | 'fade' | 'scroll') => {
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