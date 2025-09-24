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

    // Reading Positions
    readingPositions: Record<string, ReadingPosition>; // File path -> reading position
}

// /////////////////////////////////////////////////////////////////////////////
// Pagination Interfaces
// /////////////////////////////////////////////////////////////////////////////

interface ViewportParameters {
    width: number;
    height: number;
    topMargin: number;
    bottomMargin: number;
    leftMargin: number;
    rightMargin: number;
    columnCount: number;
    columnGap: number;
}

interface TypographyParameters {
    fontFamily: string;
    fontSize: number;
    lineHeight: number;
    letterSpacing: number;
    wordSpacing: number;
    textAlign: 'left' | 'right' | 'center' | 'justify';
}

interface PageBreakRules {
    respectCSSPageBreaks: boolean;
    minOrphanLines: number;
    minWidowLines: number;
    avoidBreakInsideImages: boolean;
    avoidBreakInsideTables: boolean;
}

interface PageBoundary {
    startOffset: number;
    endOffset: number;
    startElement: Element | null;
    endElement: Element | null;
    pageIndex: number;
    contentHeight: number;
}

interface PaginationData {
    totalPages: number;
    currentPage: number;
    pages: PageBoundary[];
    viewport: ViewportParameters;
    typography: TypographyParameters;
    contentContainer: HTMLElement | null;
    measurementContainer: HTMLElement | null;
}

interface ReadingPosition {
    chapterFile: TFile;
    pageIndex: number;
    scrollOffset: number;
    characterOffset: number;
    timestamp: number;
}

// /////////////////////////////////////////////////////////////////////////////
// 
// /////////////////////////////////////////////////////////////////////////////

interface ReaderModeState {
    isActive: boolean;
    currentBook: BookStructure | null;
    currentChapter: TFile | null;
    paginationData: PaginationData | null;
    readingPosition: ReadingPosition | null;
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
    showStats: false,
    readingPositions: {}
};

// /////////////////////////////////////////////////////////////////////////////
// Pagination Engine
// /////////////////////////////////////////////////////////////////////////////

/**
 * Core pagination engine that handles content measurement, page calculation, and position tracking
 */
class PaginationEngine {
    private app: App;
    private measurementContainer: HTMLElement | null = null;
    private cachedPagination: Map<string, PaginationData> = new Map();

    // Viewport elements for true pagination
    private paginationViewport?: HTMLElement;
    private paginationContent?: HTMLElement;

    constructor(app: App) {
        this.app = app;
        this.createMeasurementContainer();
    }

    /**
     * Creates an off-screen container for measuring content
     */
    private createMeasurementContainer(): void {
        this.measurementContainer = document.createElement('div');
        this.measurementContainer.id = 'obsidian-r-measurement-container';
        this.measurementContainer.style.cssText = `
            position: absolute;
            left: -9999px;
            top: -9999px;
            visibility: hidden;
            pointer-events: none;
            overflow: hidden;
            white-space: pre-wrap;
            word-wrap: break-word;
        `;
        document.body.appendChild(this.measurementContainer);
    }

    /**
     * Creates a paginated viewport for content display
     */
    createPaginationViewport(contentEl: HTMLElement, availableHeight: number): HTMLElement {
        // Create a wrapper that constrains height and hides overflow
        const viewport = contentEl.createDiv({ cls: 'pagination-viewport' });

        // Set the height to available page height and hide overflow
        viewport.style.height = `${availableHeight}px`;
        viewport.style.overflow = 'hidden';
        viewport.style.position = 'relative';

        // Create inner content container that we'll transform
        const contentContainer = viewport.createDiv({ cls: 'pagination-content' });
        contentContainer.style.position = 'absolute';
        contentContainer.style.top = '0';
        contentContainer.style.left = '0';
        contentContainer.style.width = '100%';
        contentContainer.style.transition = 'transform 0.3s ease-in-out';

        // Move all existing content into the container
        while (contentEl.firstChild && contentEl.firstChild !== viewport) {
            contentContainer.appendChild(contentEl.firstChild);
        }

        // Store references for later use
        this.paginationViewport = viewport;
        this.paginationContent = contentContainer;

        console.log(`📺 Created pagination viewport: ${availableHeight}px height`);
        return viewport;
    }

    /**
     * Calculates pagination for given content and parameters
     */
    async calculatePagination(
        content: string,
        viewport: ViewportParameters,
        typography: TypographyParameters,
        breakRules: PageBreakRules = this.getDefaultBreakRules()
    ): Promise<PaginationData> {
        const cacheKey = this.generateCacheKey(content, viewport, typography, breakRules);
        const cached = this.cachedPagination.get(cacheKey);
        if (cached) {
            return cached;
        }

        if (!this.measurementContainer) {
            this.createMeasurementContainer();
        }

        const paginationData = await this.performPagination(content, viewport, typography, breakRules);
        this.cachedPagination.set(cacheKey, paginationData);

        // Limit cache size to prevent memory issues
        if (this.cachedPagination.size > 50) {
            const firstKey = this.cachedPagination.keys().next().value;
            this.cachedPagination.delete(firstKey);
        }

        return paginationData;
    }

    /**
     * Performs the actual pagination calculation
     */
    private async performPagination(
        content: string,
        viewport: ViewportParameters,
        typography: TypographyParameters,
        breakRules: PageBreakRules
    ): Promise<PaginationData> {
        console.log('🔍 Starting pagination calculation...');

        // Set up measurement container with exact typography and viewport settings
        this.setupMeasurementContainer(viewport, typography);

        // Parse and render content with proper encoding handling
        const tempDiv = document.createElement('div');
        tempDiv.innerHTML = content;
        // Ensure proper text rendering for French and special characters
        tempDiv.style.cssText = `
            font-variant-ligatures: common-ligatures;
            text-rendering: optimizeLegibility;
            -webkit-font-smoothing: antialiased;
            -moz-osx-font-smoothing: grayscale;
        `;
        this.measurementContainer!.appendChild(tempDiv);

        // Calculate available page height
        const availableHeight = viewport.height - viewport.topMargin - viewport.bottomMargin;
        console.log('📏 Available height for pagination:', availableHeight, 'px');

        // Measure total content height
        const totalHeight = this.measureContentHeight(tempDiv);
        console.log('📏 Total content height:', totalHeight, 'px');

        // Calculate page boundaries
        const pages = await this.calculatePageBoundaries(tempDiv, availableHeight, breakRules);
        console.log('📄 Calculated pages:', pages.length);

        // Clean up
        this.measurementContainer!.removeChild(tempDiv);

        const paginationData: PaginationData = {
            totalPages: pages.length,
            currentPage: 0,
            pages,
            viewport,
            typography,
            contentContainer: null,
            measurementContainer: this.measurementContainer
        };

        return paginationData;
    }

    /**
     * Sets up the measurement container with exact typography and viewport settings
     */
    private setupMeasurementContainer(viewport: ViewportParameters, typography: TypographyParameters): void {
        if (!this.measurementContainer) return;

        const contentWidth = viewport.width - viewport.leftMargin - viewport.rightMargin;
        const columnWidth = viewport.columnCount > 1
            ? (contentWidth - (viewport.columnGap * (viewport.columnCount - 1))) / viewport.columnCount
            : contentWidth;

        this.measurementContainer.style.cssText += `
            width: ${contentWidth}px;
            max-width: ${contentWidth}px;
            font-family: ${typography.fontFamily};
            font-size: ${typography.fontSize}px;
            line-height: ${typography.lineHeight};
            letter-spacing: ${typography.letterSpacing}em;
            word-spacing: ${typography.wordSpacing === 0 ? 'normal' : typography.wordSpacing + 'em'};
            text-align: ${typography.textAlign};
            white-space: pre-wrap;
            word-wrap: break-word;
            overflow-wrap: break-word;
            hyphens: auto;
            ${viewport.columnCount > 1 ? `
                column-count: ${viewport.columnCount};
                column-gap: ${viewport.columnGap}px;
                column-width: ${columnWidth}px;
            ` : ''}
        `;

        console.log(`📐 Setup measurement container: ${contentWidth}px width, font: ${typography.fontFamily} ${typography.fontSize}px`);
    }

    /**
     * Measures the total height of rendered content
     */
    private measureContentHeight(contentEl: HTMLElement): number {
        // Force layout and get accurate measurement of the complete content
        contentEl.style.display = 'block';
        contentEl.style.visibility = 'visible';
        contentEl.style.position = 'static';

        // Force browser to calculate layout
        contentEl.offsetHeight; // Trigger reflow

        const rect = contentEl.getBoundingClientRect();
        const computedHeight = rect.height;

        console.log(`📏 Measured content height: ${computedHeight}px (from complete vault content)`);
        return computedHeight;
    }

    /**
     * Calculates page boundaries based on available height and break rules
     */
    private async calculatePageBoundaries(
        contentEl: HTMLElement,
        availableHeight: number,
        breakRules: PageBreakRules
    ): Promise<PageBoundary[]> {
        console.log(`📏 Calculating pages for available height: ${availableHeight}px`);

        // Get the total content height
        const totalHeight = this.measureContentHeight(contentEl);
        console.log(`📏 Total content height: ${totalHeight}px`);

        // Calculate how many pages we need based on simple division
        const pagesNeeded = Math.ceil(totalHeight / availableHeight);
        console.log(`📄 Pages needed: ${pagesNeeded} (${totalHeight}px ÷ ${availableHeight}px = ${totalHeight / availableHeight})`);

        // Ensure we have at least 1 page
        const finalPages = Math.max(1, pagesNeeded);
        console.log(`📄 Final pages: ${finalPages}`);

        const pages: PageBoundary[] = [];

        // Create page boundaries based on height divisions
        for (let i = 0; i < finalPages; i++) {
            const startOffset = i * availableHeight;
            const endOffset = Math.min((i + 1) * availableHeight, totalHeight);

            pages.push({
                startOffset: startOffset,
                endOffset: endOffset,
                startElement: contentEl.firstElementChild, // Simplified - all pages share same start element
                endElement: contentEl.lastElementChild,
                pageIndex: i,
                contentHeight: availableHeight
            });

            console.log(`📄 Page ${i + 1}: ${startOffset}px - ${endOffset}px`);
        }

        return pages.length > 0 ? pages : [{
            startOffset: 0,
            endOffset: totalHeight,
            startElement: contentEl.firstElementChild,
            endElement: contentEl.lastElementChild,
            pageIndex: 0,
            contentHeight: totalHeight
        }];
    }

    /**
     * Gets all text-containing elements for pagination calculation
     */
    private getAllTextElements(container: HTMLElement): Element[] {
        const elements: Element[] = [];
        const walker = document.createTreeWalker(
            container,
            NodeFilter.SHOW_ELEMENT,
            {
                acceptNode: (node: Element) => {
                    // Include paragraphs, headings, list items, and other text containers
                    const tagName = node.tagName.toLowerCase();
                    if (['p', 'div', 'h1', 'h2', 'h3', 'h4', 'h5', 'h6', 'li', 'blockquote', 'pre'].includes(tagName)) {
                        return NodeFilter.FILTER_ACCEPT;
                    }
                    return NodeFilter.FILTER_SKIP;
                }
            }
        );

        let node: Element | null;
        while (node = walker.nextNode() as Element) {
            elements.push(node);
        }

        return elements;
    }

    /**
     * Measures the height of a single element
     */
    private measureElementHeight(element: Element): number {
        // Create a temporary element with the same content and styling
        const tempEl = element.cloneNode(true) as HTMLElement;
        tempEl.style.visibility = 'hidden';
        tempEl.style.position = 'absolute';
        tempEl.style.left = '-9999px';

        this.measurementContainer!.appendChild(tempEl);
        const height = tempEl.getBoundingClientRect().height;
        this.measurementContainer!.removeChild(tempEl);

        return height;
    }

    /**
     * Gets the character offset of an element within the content
     */
    private getElementOffset(element: Element): number {
        // Find the root container to calculate offset from
        const rootContainer = this.measurementContainer?.querySelector('div');
        if (!rootContainer) return 0;

        // Use TreeWalker to calculate character position
        let offset = 0;
        const walker = document.createTreeWalker(
            rootContainer,
            NodeFilter.SHOW_TEXT,
            null
        );

        let currentNode: Node | null;
        while (currentNode = walker.nextNode()) {
            // Check if we've reached our target element
            if (currentNode.parentElement === element || element.contains(currentNode.parentElement!)) {
                break;
            }
            // Add text length of this node
            offset += currentNode.textContent?.length || 0;
        }

        return offset;
    }

    /**
     * Calculates character position for a given page
     */
    calculateCharacterPosition(pageIndex: number, paginationData: PaginationData): number {
        if (pageIndex >= paginationData.pages.length) {
            return 0;
        }
        return paginationData.pages[pageIndex].startOffset;
    }

    /**
     * Finds the page containing a specific character position
     */
    findPageForCharacterPosition(characterPosition: number, paginationData: PaginationData): number {
        for (let i = 0; i < paginationData.pages.length; i++) {
            const page = paginationData.pages[i];
            if (characterPosition >= page.startOffset && characterPosition <= page.endOffset) {
                return i;
            }
        }
        return 0; // Default to first page
    }

    /**
     * Generates a cache key for pagination data
     */
    private generateCacheKey(
        content: string,
        viewport: ViewportParameters,
        typography: TypographyParameters,
        breakRules: PageBreakRules
    ): string {
        const contentHash = this.simpleHash(content);
        return `${contentHash}-${viewport.width}x${viewport.height}-${typography.fontSize}-${typography.fontFamily}`;
    }

    /**
     * Simple hash function for cache keys
     */
    private simpleHash(str: string): string {
        let hash = 0;
        if (str.length === 0) return hash.toString();
        for (let i = 0; i < str.length; i++) {
            const char = str.charCodeAt(i);
            hash = ((hash << 5) - hash) + char;
            hash = hash & hash; // Convert to 32-bit integer
        }
        return Math.abs(hash).toString(16);
    }

    /**
     * Gets default page break rules
     */
    private getDefaultBreakRules(): PageBreakRules {
        return {
            respectCSSPageBreaks: true,
            minOrphanLines: 2,
            minWidowLines: 2,
            avoidBreakInsideImages: true,
            avoidBreakInsideTables: true
        };
    }

    /**
     * Navigates to a specific page in the paginated content
     */
    async navigateToPage(paginationData: PaginationData, pageIndex: number): Promise<boolean> {
        console.log(`🎯 Navigate to page ${pageIndex + 1}/${paginationData.totalPages}`);

        if (!paginationData.contentContainer || pageIndex < 0 || pageIndex >= paginationData.totalPages) {
            console.log('❌ Invalid navigation parameters');
            return false;
        }

        const targetPage = paginationData.pages[pageIndex];
        if (!targetPage) {
            console.log('❌ Target page not found');
            return false;
        }

        // REAL PAGINATION: Use transform to show only the target page
        const container = paginationData.contentContainer;
        const pageHeight = paginationData.viewport.height - paginationData.viewport.topMargin - paginationData.viewport.bottomMargin;

        // Calculate the Y offset to show this page
        const offsetY = -(pageIndex * pageHeight);

        console.log(`📐 Moving content by ${offsetY}px (page height: ${pageHeight}px)`);

        // Apply the transform to show only this page
        container.style.transform = `translateY(${offsetY}px)`;
        container.style.transition = 'transform 0.3s ease-in-out';

        // Ensure the container has pagination constraints
        this.enablePaginationMode(container, pageHeight);

        paginationData.currentPage = pageIndex;
        console.log(`✅ Navigated to page ${pageIndex + 1}`);
        return true;
    }

    /**
     * Enables pagination mode by constraining the viewport
     */
    enablePaginationMode(container: HTMLElement, pageHeight: number): void {
        const parent = container.parentElement;
        if (!parent) {
            console.error('❌ No parent element found for content container');
            return;
        }

        console.log(`🔧 Enabling pagination mode: ${pageHeight}px page height`);

        // Set up the pagination viewport on the parent - THIS constrains what's visible
        parent.style.height = `${pageHeight}px`;
        parent.style.overflow = 'hidden';
        parent.style.position = 'relative';
        parent.classList.add('pagination-viewport');

        // CRITICAL: The content container must NOT be height-constrained
        // It needs to contain ALL content, but positioned via transforms
        container.style.position = 'absolute';
        container.style.top = '0';
        container.style.left = '0';
        container.style.width = '100%';
        container.style.height = 'auto'; // Let it be as tall as the content needs
        container.style.minHeight = '100%'; // At least fill the viewport
        container.style.maxHeight = 'none'; // No maximum height constraint
        container.style.transition = 'transform 0.3s ease-in-out';
        container.classList.add('pagination-content');

        console.log(`✅ Pagination viewport enabled: viewport = ${pageHeight}px, content = unconstrained`);
    }

    /**
     * Clears the pagination cache
     */
    clearCache(): void {
        this.cachedPagination.clear();
    }

    /**
     * Cleanup method to remove measurement container
     */
    destroy(): void {
        if (this.measurementContainer) {
            document.body.removeChild(this.measurementContainer);
            this.measurementContainer = null;
        }
        this.clearCache();
    }
}

// /////////////////////////////////////////////////////////////////////////////
// Font management utility for loading fonts from CDN
// /////////////////////////////////////////////////////////////////////////////
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
        currentChapter: null,
        paginationData: null,
        readingPosition: null
    };
    private originalContentBackup: string | null = null; // Store original content before any modifications
    private readerModeEl: HTMLElement | null = null;
    private controlsEl: HTMLElement | null = null;
    private hideControlsTimeout: number | null = null;
    private readerClickHandler: ((event: Event) => void) | null = null;
    private readerKeyboardHandler: ((event: KeyboardEvent) => void) | null = null;
    private zenMode: boolean = false;
    private originalViewMode: 'source' | 'preview' | null = null;
    private paginationEngine: PaginationEngine;

    async onload() {
        // Initialize pagination engine
        this.paginationEngine = new PaginationEngine(this.app);
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

        // Clean up pagination engine
        if (this.paginationEngine) {
            this.paginationEngine.destroy();
        }
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

        // Check if it's a markdown file
        if (activeFile.extension !== 'md') {
            new Notice('Reader mode only works with Markdown files');
            return;
        }

        // Check if the current file is part of a book (preferred)
        const book = this.findBookForFile(activeFile);

        // If no book detected, create a minimal book structure for this single file
        const effectiveBook = book || this.createSingleFileBook(activeFile);

        this.readerModeState.isActive = true;
        this.readerModeState.currentBook = effectiveBook;
        this.readerModeState.currentChapter = activeFile;

        // Switch to reading view for better reading experience
        await this.switchToReadingView();

        // Initialize pagination for the current chapter
        await this.initializePagination();

        // Apply visual styling to content area immediately after view switch
        this.applyReaderModeStyles();

        // Create reader mode UI
        await this.createReaderModeUI();
        this.showReaderControls();

        // Add reader mode keyboard handlers
        this.addReaderModeKeyboardHandlers();

        // Add mobile touch handlers
        this.addMobileTouchHandlers();

        // Add window resize handler for pagination recalculation
        this.addWindowResizeHandler();

        new Notice('Reader mode activated');
    }

    /**
     * Converts Markdown content to HTML for accurate measurement
     */
    private async convertMarkdownToHtml(markdown: string): Promise<string> {
        try {
            console.log('🔄 Converting complete markdown content to HTML for pagination');

            // ALWAYS use the complete markdown content from vault, never DOM content
            // This ensures we measure the complete content, not lazy-loaded portions

            // Remove YAML frontmatter if present
            let content = markdown.replace(/^---\s*\n[\s\S]*?\n---\s*\n/, '');

            // First, handle code blocks to prevent them from being processed by other rules
            const codeBlocks: string[] = [];
            content = content.replace(/```[\s\S]*?```/gm, (match) => {
                const placeholder = `__CODEBLOCK_${codeBlocks.length}__`;
                codeBlocks.push(`<pre><code>${match.slice(3, -3).trim()}</code></pre>`);
                return placeholder;
            });

            // Process other markdown elements
            let html = content
                // Headers (with proper hierarchy)
                .replace(/^#### (.*$)/gim, '<h4>$1</h4>')
                .replace(/^### (.*$)/gim, '<h3>$1</h3>')
                .replace(/^## (.*$)/gim, '<h2>$1</h2>')
                .replace(/^# (.*$)/gim, '<h1>$1</h1>')
                // Bold and italic (handle nested cases)
                .replace(/\*\*\*(.*?)\*\*\*/gim, '<strong><em>$1</em></strong>')
                .replace(/\*\*(.*?)\*\*/gim, '<strong>$1</strong>')
                .replace(/\_\_(.*?)\_\_/gim, '<strong>$1</strong>')
                .replace(/\*(.*?)\*/gim, '<em>$1</em>')
                .replace(/\_(.*?)\_/gim, '<em>$1</em>')
                // Inline code
                .replace(/`([^`]+)`/gim, '<code>$1</code>')
                // Links
                .replace(/\[([^\]]+)\]\(([^)]+)\)/gim, '<a href="$2">$1</a>')
                // Horizontal rules
                .replace(/^---+$/gim, '<hr>')
                .replace(/^\*\*\*+$/gim, '<hr>')
                // Blockquotes
                .replace(/^> (.*)$/gim, '<blockquote>$1</blockquote>');

            // Handle lists and paragraphs - split by double newlines for paragraphs
            const paragraphs = html.split(/\n\s*\n/).map(para => para.trim()).filter(para => para.length > 0);

            const processedParagraphs: string[] = [];

            for (const paragraph of paragraphs) {
                const lines = paragraph.split('\n');
                const processedLines: string[] = [];
                let inList = false;
                let listType = '';

                for (const line of lines) {
                    const trimmedLine = line.trim();

                    if (!trimmedLine) continue;

                    // Unordered list item
                    if (trimmedLine.match(/^\s*[\*\-\+]\s+/)) {
                        if (!inList || listType !== 'ul') {
                            if (inList) processedLines.push(`</${listType}>`);
                            processedLines.push('<ul>');
                            inList = true;
                            listType = 'ul';
                        }
                        processedLines.push(`<li>${trimmedLine.replace(/^\s*[\*\-\+]\s+/, '')}</li>`);
                    }
                    // Ordered list item
                    else if (trimmedLine.match(/^\s*\d+\.\s+/)) {
                        if (!inList || listType !== 'ol') {
                            if (inList) processedLines.push(`</${listType}>`);
                            processedLines.push('<ol>');
                            inList = true;
                            listType = 'ol';
                        }
                        processedLines.push(`<li>${trimmedLine.replace(/^\s*\d+\.\s+/, '')}</li>`);
                    }
                    // Regular content
                    else {
                        if (inList) {
                            processedLines.push(`</${listType}>`);
                            inList = false;
                        }
                        processedLines.push(trimmedLine);
                    }
                }

                // Close any remaining list
                if (inList) {
                    processedLines.push(`</${listType}>`);
                }

                let processedParagraph = processedLines.join('\n');

                // Don't wrap block elements in paragraphs
                if (processedParagraph.match(/^<(h[1-6]|ul|ol|pre|blockquote|hr)/i)) {
                    processedParagraphs.push(processedParagraph);
                } else {
                    // Handle long text lines - add soft breaks at sentence boundaries for better wrapping
                    processedParagraph = processedParagraph
                        .replace(/\.\s+([A-ZÀÂÄÇÉÈÊËÏÎÔÙÛÜŸ])/g, '. <wbr>$1') // French capital letters
                        .replace(/\?\s+([A-ZÀÂÄÇÉÈÊËÏÎÔÙÛÜŸ])/g, '? <wbr>$1')
                        .replace(/!\s+([A-ZÀÂÄÇÉÈÊËÏÎÔÙÛÜŸ])/g, '! <wbr>$1')
                        .replace(/»\s+([A-ZÀÂÄÇÉÈÊËÏÎÔÙÛÜŸ])/g, '» <wbr>$1')
                        .replace(/"\s+([A-ZÀÂÄÇÉÈÊËÏÎÔÙÛÜŸ])/g, '" <wbr>$1');

                    processedParagraphs.push(`<p>${processedParagraph}</p>`);
                }
            }

            html = processedParagraphs.join('\n');

            // Restore code blocks
            codeBlocks.forEach((block, index) => {
                html = html.replace(`__CODEBLOCK_${index}__`, block);
            });

            console.log('✅ Converted complete markdown to HTML with proper text wrapping');
            console.log(`📊 Generated ${html.length} characters of HTML from ${markdown.length} characters of markdown`);
            return html;
        } catch (error) {
            console.error('Failed to convert markdown to HTML:', error);
            // Return the original markdown wrapped in paragraphs as last resort
            return `<p>${markdown.replace(/\n\n/g, '</p><p>').replace(/\n/g, '<br>')}</p>`;
        }
    }

    /**
     * Initializes pagination for the current chapter content
     */
    private async initializePagination(): Promise<void> {
        if (!this.readerModeState.currentChapter || !this.paginationEngine) {
            console.log('❌ Cannot initialize pagination: missing chapter or engine');
            return;
        }

        try {
            console.log('🔧 Initializing pagination for:', this.readerModeState.currentChapter.path);

            // Get the content of the current chapter
            const content = await this.app.vault.cachedRead(this.readerModeState.currentChapter);
            console.log('📄 Complete content from vault:', content.length, 'characters');
            console.log('📄 Content lines count:', content.split('\n').length);
            console.log('📄 First 200 chars:', content.substring(0, 200) + '...');
            console.log('📄 Last 200 chars:', '...' + content.substring(content.length - 200));

            // Convert Markdown to HTML for accurate measurement
            const htmlContent = await this.convertMarkdownToHtml(content);
            console.log('🔄 Converted to HTML, length:', htmlContent.length);
            console.log('🔄 HTML paragraphs count:', (htmlContent.match(/<p>/g) || []).length);
            console.log('🔄 HTML preview:', htmlContent.substring(0, 300) + '...');

            // Calculate viewport parameters
            const viewport = this.calculateViewportParameters();
            console.log('📐 Viewport:', viewport);

            // Calculate typography parameters 
            const typography = this.calculateTypographyParameters();
            console.log('🔤 Typography:', typography);

            // Calculate pagination using HTML content
            const paginationData = await this.paginationEngine.calculatePagination(
                htmlContent,
                viewport,
                typography
            );

            console.log('📚 Pagination calculated:', paginationData.totalPages, 'pages');

            // Store pagination data
            this.readerModeState.paginationData = paginationData;

            // Update the content container reference
            const activeLeaf = this.app.workspace.activeLeaf;
            if (activeLeaf?.view?.containerEl) {
                const contentContainer = activeLeaf.view.containerEl.querySelector('.markdown-preview-sizer') as HTMLElement ||
                    activeLeaf.view.containerEl.querySelector('.cm-content') as HTMLElement;
                if (contentContainer) {
                    paginationData.contentContainer = contentContainer;
                    console.log('✅ Found content container:', contentContainer.className);

                    // IMMEDIATELY apply pagination viewport constraints
                    const pageHeight = viewport.height - viewport.topMargin - viewport.bottomMargin;
                    console.log(`🔧 Applying pagination constraints: ${pageHeight}px per page`);

                    // CRITICAL: Ensure the DOM container has the complete content
                    // Obsidian might be lazy-loading, so we need to inject the full HTML
                    this.ensureCompleteContentRendered(contentContainer, htmlContent);

                    // Enable pagination mode on the content container
                    this.paginationEngine.enablePaginationMode(contentContainer, pageHeight);

                    // Navigate to first page to ensure pagination is visible
                    await this.paginationEngine.navigateToPage(paginationData, 0);

                } else {
                    console.log('⚠️ No content container found');
                }
            }

            // Restore reading position if available
            await this.restoreReadingPosition();

        } catch (error) {
            console.error('❌ Failed to initialize pagination:', error);
        }
    }

    /**
     * Calculates viewport parameters based on current window size and settings
     */
    private calculateViewportParameters(): ViewportParameters {
        const windowWidth = window.innerWidth;
        const windowHeight = window.innerHeight;

        // Calculate margins based purely on settings
        const horizontalMarginPx = (windowWidth * this.settings.horizontalMargins) / 100;

        // Calculate vertical margins as a proportion of horizontal margins to maintain aspect ratio
        const verticalMarginPx = horizontalMarginPx * (windowHeight / windowWidth);

        // Calculate space needed for UI elements (proportional to font size)
        const controlsSpacePx = this.settings.fontSize * 5; // 5x font size for controls

        const params = {
            width: windowWidth,
            height: windowHeight,
            topMargin: verticalMarginPx,
            bottomMargin: verticalMarginPx + controlsSpacePx,
            leftMargin: horizontalMarginPx,
            rightMargin: horizontalMarginPx,
            columnCount: this.settings.columns,
            columnGap: this.settings.fontSize // Use font size as column gap base
        };

        console.log('📐 Calculated viewport parameters (computed from settings):', params);
        console.log(`📏 Effective page height: ${params.height - params.topMargin - params.bottomMargin}px`);
        return params;
    }

    /**
     * Ensures the DOM container has the complete content from vault, not lazy-loaded content
     */
    private ensureCompleteContentRendered(container: HTMLElement, completeHtml: string): void {
        console.log('🔄 Ensuring complete content is rendered in DOM container');

        // Check if the container has significantly less content than expected
        const currentContentLength = container.innerHTML.length;
        const expectedContentLength = completeHtml.length;

        console.log(`📊 Current DOM content: ${currentContentLength} chars, Expected: ${expectedContentLength} chars`);

        // If DOM content is significantly shorter, replace it with complete content
        if (currentContentLength < expectedContentLength * 0.8) { // Less than 80% of expected
            console.log('⚠️ DOM content appears incomplete, injecting complete content');
            container.innerHTML = completeHtml;
            console.log('✅ Complete content injected into DOM container');
        } else {
            console.log('✅ DOM content appears complete');
        }
    }

    /**
     * Calculates typography parameters based on current settings
     */
    private calculateTypographyParameters(): TypographyParameters {
        return {
            fontFamily: this.settings.fontFamily,
            fontSize: this.settings.fontSize,
            lineHeight: this.settings.lineSpacing,
            letterSpacing: this.settings.characterSpacing,
            wordSpacing: this.settings.wordSpacing,
            textAlign: this.settings.justified ? 'justify' : 'left'
        };
    }

    /**
     * Adds window resize handler to recalculate pagination on viewport changes
     */
    private addWindowResizeHandler(): void {
        let resizeTimeout: number;

        const handleResize = () => {
            // Debounce resize events
            clearTimeout(resizeTimeout);
            resizeTimeout = window.setTimeout(async () => {
                if (this.readerModeState.isActive) {
                    await this.recalculatePagination();
                }
            }, 300);
        };

        this.registerDomEvent(window, 'resize', handleResize);
    }

    /**
     * Adds mobile touch handlers for swipe navigation and control activation
     */
    private addMobileTouchHandlers(): void {
        // Check if we're on mobile by checking platform or screen size
        const isMobile = /Android|iPhone|iPad|iPod|BlackBerry|IEMobile|Opera Mini/i.test(navigator.userAgent) ||
            window.innerWidth < 768;

        if (!isMobile) {
            return;
        }

        const activeLeaf = this.app.workspace.activeLeaf;
        if (!activeLeaf?.view?.containerEl) {
            return;
        }

        const container = activeLeaf.view.containerEl;
        let startX = 0;
        let startY = 0;
        let startTime = 0;

        const handleTouchStart = (e: TouchEvent) => {
            if (!this.readerModeState.isActive) return;

            const touch = e.touches[0];
            startX = touch.clientX;
            startY = touch.clientY;
            startTime = Date.now();
        };

        const handleTouchEnd = (e: TouchEvent) => {
            if (!this.readerModeState.isActive) return;

            const touch = e.changedTouches[0];
            const endX = touch.clientX;
            const endY = touch.clientY;
            const endTime = Date.now();

            const deltaX = endX - startX;
            const deltaY = endY - startY;
            const deltaTime = endTime - startTime;

            // Check for swipe gestures (minimum distance and maximum time)
            const minSwipeDistance = 50;
            const maxSwipeTime = 500;

            if (Math.abs(deltaX) > minSwipeDistance &&
                Math.abs(deltaY) < Math.abs(deltaX) / 2 &&
                deltaTime < maxSwipeTime) {

                if (deltaX > 0) {
                    // Swipe right - previous page
                    this.previousPage();
                } else {
                    // Swipe left - next page  
                    this.nextPage();
                }
            } else if (deltaTime < 300 && Math.abs(deltaX) < 30 && Math.abs(deltaY) < 30) {
                // Tap to show controls
                this.showReaderControls();
            }
        };

        this.registerDomEvent(container, 'touchstart', handleTouchStart);
        this.registerDomEvent(container, 'touchend', handleTouchEnd);
    }

    /**
     * Navigates to the next page
     */
    private async nextPage(): Promise<void> {
        console.log('➡️ Next page requested');

        if (!this.readerModeState.paginationData) {
            console.log('⚠️ No pagination data, falling back to chapter navigation');
            // Fall back to chapter navigation if pagination not available
            await this.nextChapter();
            return;
        }

        const paginationData = this.readerModeState.paginationData;
        const nextPageIndex = paginationData.currentPage + 1;

        console.log(`📄 Current page: ${paginationData.currentPage + 1}/${paginationData.totalPages}`);

        if (nextPageIndex < paginationData.totalPages) {
            console.log(`🔄 Navigating to page ${nextPageIndex + 1}`);
            // Navigate to next page in current chapter
            const success = await this.paginationEngine.navigateToPage(paginationData, nextPageIndex);
            if (success) {
                console.log('✅ Navigation successful');
                this.updatePageDisplay();
                this.applyPageTransition();
                this.saveReadingPosition(); // Save position after navigation
            } else {
                console.log('❌ Navigation failed');
            }
        } else {
            console.log('📚 At last page, trying next chapter');
            // Navigate to next chapter
            await this.nextChapter();
        }
    }

    /**
     * Navigates to the previous page
     */
    private async previousPage(): Promise<void> {
        console.log('⬅️ Previous page requested');

        if (!this.readerModeState.paginationData) {
            console.log('⚠️ No pagination data, falling back to chapter navigation');
            // Fall back to chapter navigation if pagination not available
            await this.previousChapter();
            return;
        }

        const paginationData = this.readerModeState.paginationData;
        const prevPageIndex = paginationData.currentPage - 1;

        console.log(`📄 Current page: ${paginationData.currentPage + 1}/${paginationData.totalPages}`);

        if (prevPageIndex >= 0) {
            console.log(`🔄 Navigating to page ${prevPageIndex + 1}`);
            // Navigate to previous page in current chapter
            const success = await this.paginationEngine.navigateToPage(paginationData, prevPageIndex);
            if (success) {
                console.log('✅ Navigation successful');
                this.updatePageDisplay();
                this.applyPageTransition();
                this.saveReadingPosition(); // Save position after navigation
            } else {
                console.log('❌ Navigation failed');
            }
        } else {
            console.log('📚 At first page, trying previous chapter');
            // Navigate to previous chapter
            await this.previousChapter();
        }
    }

    /**
     * Saves the current reading position
     */
    private saveReadingPosition(): void {
        if (!this.readerModeState.currentChapter || !this.readerModeState.paginationData) {
            return;
        }

        const filePath = this.readerModeState.currentChapter.path;
        const { currentPage } = this.readerModeState.paginationData;

        const position: ReadingPosition = {
            chapterFile: this.readerModeState.currentChapter,
            pageIndex: currentPage,
            scrollOffset: window.scrollY,
            characterOffset: this.paginationEngine.calculateCharacterPosition(currentPage, this.readerModeState.paginationData),
            timestamp: Date.now()
        };

        this.settings.readingPositions[filePath] = position;
        this.saveSettings();
    }

    /**
     * Restores the reading position for the current chapter
     */
    private async restoreReadingPosition(): Promise<void> {
        if (!this.readerModeState.currentChapter || !this.readerModeState.paginationData) {
            return;
        }

        const filePath = this.readerModeState.currentChapter.path;
        const savedPosition = this.settings.readingPositions[filePath];

        if (!savedPosition) {
            return; // No saved position
        }

        // Navigate to the saved page
        const success = await this.paginationEngine.navigateToPage(
            this.readerModeState.paginationData,
            savedPosition.pageIndex
        );

        if (success) {
            this.updatePageDisplay();

            // Update the reading position in state
            this.readerModeState.readingPosition = savedPosition;
        }
    }

    /**
     * Updates the page number displays in the UI
     */
    private updatePageDisplay(): void {
        if (!this.readerModeState.paginationData) return;

        const { currentPage, totalPages } = this.readerModeState.paginationData;

        // Update page pills if they exist
        const topPill = document.querySelector('.obsidian-r-top-pill');
        const bottomPill = document.querySelector('.obsidian-r-bottom-pill');

        if (topPill) {
            topPill.textContent = `Page ${currentPage + 1}`;
        }

        if (bottomPill) {
            bottomPill.textContent = `${currentPage + 1} / ${totalPages}`;
        }

        // Update window title to show pages remaining
        const pagesRemaining = totalPages - currentPage - 1;
        if (pagesRemaining > 0) {
            document.title = `${pagesRemaining} pages remaining`;
        } else {
            document.title = 'Last page';
        }
    }

    /**
     * Applies page transition animation for page navigation
     */
    private applyPageTransition(): void {
        if (!this.readerModeState.paginationData?.contentContainer) return;

        const contentEl = this.readerModeState.paginationData.contentContainer;
        const transitionType = this.settings.transitionType;

        // Apply the existing transition logic but for page changes
        this.applyPageTransitionEffect(contentEl, transitionType);
    }

    /**
     * Applies page transition effects based on settings
     */
    private applyPageTransitionEffect(contentEl: HTMLElement, transitionType: string): void {
        // Remove any existing transition classes
        contentEl.classList.remove('obsidian-r-page-transition', 'page-curl', 'slide', 'fade', 'scroll');

        switch (transitionType) {
            case 'fade':
                contentEl.classList.add('obsidian-r-page-transition', 'fade');
                contentEl.style.opacity = '0.7';
                setTimeout(() => {
                    contentEl.style.opacity = '1';
                }, 150);
                break;

            case 'slide':
                contentEl.classList.add('obsidian-r-page-transition', 'slide');
                contentEl.style.transform = 'translateX(-10px)';
                setTimeout(() => {
                    contentEl.style.transform = 'translateX(0)';
                }, 50);
                break;

            case 'page-curl':
                contentEl.classList.add('obsidian-r-page-transition', 'page-curl');
                contentEl.style.transform = 'rotateY(-2deg) scale(0.98)';
                setTimeout(() => {
                    contentEl.style.transform = 'rotateY(0deg) scale(1)';
                }, 100);
                break;

            case 'scroll':
                contentEl.classList.add('obsidian-r-page-transition', 'scroll');
                contentEl.style.transform = 'translateY(-5px)';
                contentEl.style.opacity = '0.8';
                setTimeout(() => {
                    contentEl.style.transform = 'translateY(0)';
                    contentEl.style.opacity = '1';
                }, 100);
                break;
        }
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
     * Applies content transition effects based on settings for content replacement
     */
    private applyContentTransition(contentEl: HTMLElement, newContent: string, isInitialLoad: boolean = false) {
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
     * Navigates to next chapter or page
     */
    private async nextChapter() {
        // Use page navigation if available
        if (this.readerModeState.paginationData &&
            this.readerModeState.paginationData.currentPage < this.readerModeState.paginationData.totalPages - 1) {
            await this.nextPage();
            return;
        }

        // Navigate to next chapter only if we have multiple chapters
        if (!this.readerModeState.currentBook || this.readerModeState.currentBook.chapters.length <= 1) {
            new Notice('No next chapter available');
            return;
        }

        const chapters = this.readerModeState.currentBook.chapters;
        const currentIndex = chapters.findIndex(ch => ch.path === this.readerModeState.currentChapter?.path);

        if (currentIndex >= 0 && currentIndex < chapters.length - 1) {
            const nextChapter = chapters[currentIndex + 1];
            // Open the next chapter file
            await this.app.workspace.openLinkText(nextChapter.path, '', false);
        } else {
            new Notice('No next chapter available');
        }
    }

    /**
     * Navigates to previous chapter or page
     */
    private async previousChapter() {
        // Use page navigation if available
        if (this.readerModeState.paginationData &&
            this.readerModeState.paginationData.currentPage > 0) {
            await this.previousPage();
            return;
        }

        // Navigate to previous chapter only if we have multiple chapters
        if (!this.readerModeState.currentBook || this.readerModeState.currentBook.chapters.length <= 1) {
            new Notice('No previous chapter available');
            return;
        }

        const chapters = this.readerModeState.currentBook.chapters;
        const currentIndex = chapters.findIndex(ch => ch.path === this.readerModeState.currentChapter?.path);

        if (currentIndex > 0) {
            const prevChapter = chapters[currentIndex - 1];
            // Open the previous chapter file
            await this.app.workspace.openLinkText(prevChapter.path, '', false);
        } else {
            new Notice('No previous chapter available');
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
     * Creates a minimal book structure for a single file
     */
    private createSingleFileBook(file: TFile): BookStructure {
        return {
            folder: file.parent as TFolder,
            mainFile: file,
            imageFile: null,
            chapters: [file], // Single chapter
            title: file.basename
        };
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
            IconManager.createIconButton('chevron-left', 'Previous page', () => this.previousPage()),
            IconManager.createIconButton('chevron-right', 'Next page', () => this.nextPage())
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

        // Create and show page indicators
        this.createPageIndicators();
    }

    /**
     * Creates page indicator pills (top and bottom)
     */
    private createPageIndicators(): void {
        // Remove any existing pills
        document.querySelectorAll('.obsidian-r-top-pill, .obsidian-r-bottom-pill').forEach(pill => pill.remove());

        const workspaceLeaf = this.app.workspace.activeLeaf;
        if (!workspaceLeaf?.view?.containerEl) return;

        const targetContainer = workspaceLeaf.view.containerEl;

        // Create top pill (current page)
        const topPill = document.createElement('div');
        topPill.className = 'obsidian-r-top-pill';
        topPill.textContent = this.getTopPillText();
        targetContainer.appendChild(topPill);

        // Create bottom pill (page X of Y)
        const bottomPill = document.createElement('div');
        bottomPill.className = 'obsidian-r-bottom-pill';
        bottomPill.textContent = this.getBottomPillText();
        targetContainer.appendChild(bottomPill);

        // Update page display
        this.updatePageDisplay();
    }

    /**
     * Gets the text for the top pill (current page or chapter progress)
     */
    private getTopPillText(): string {
        if (!this.readerModeState.paginationData) {
            return 'Reader Mode';
        }

        const { currentPage } = this.readerModeState.paginationData;
        return `Page ${currentPage + 1}`;
    }

    /**
     * Gets the text for the bottom pill (total progress)
     */
    private getBottomPillText(): string {
        if (!this.readerModeState.paginationData) {
            return 'Loading...';
        }

        const { currentPage, totalPages } = this.readerModeState.paginationData;
        return `${currentPage + 1} / ${totalPages}`;
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

        const keyHandler = (e: KeyboardEvent) => {
            if (!this.readerModeState.isActive || !this.readerModeState.paginationData) return;

            // Arrow key navigation for pagination
            if (e.key === 'ArrowRight' || e.key === 'ArrowDown') {
                e.preventDefault();
                this.nextPage();
                return;
            }

            if (e.key === 'ArrowLeft' || e.key === 'ArrowUp') {
                e.preventDefault();
                this.previousPage();
                return;
            }

            // Page Up/Down navigation
            if (e.key === 'PageDown') {
                e.preventDefault();
                this.nextPage();
                return;
            }

            if (e.key === 'PageUp') {
                e.preventDefault();
                this.previousPage();
                return;
            }

            // Font size keys (without modifiers)
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

        document.addEventListener('keydown', keyHandler, { capture: true });

        // Store for cleanup
        this.readerKeyboardHandler = keyHandler;
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
     * Recalculates pagination when settings change while preserving reading position
     */
    private async recalculatePagination(): Promise<void> {
        if (!this.readerModeState.isActive || !this.readerModeState.currentChapter) {
            return;
        }

        // Store current reading position
        const currentPage = this.readerModeState.paginationData?.currentPage || 0;

        // Recalculate pagination
        await this.initializePagination();

        // Try to maintain reading position
        if (this.readerModeState.paginationData && currentPage < this.readerModeState.paginationData.totalPages) {
            await this.paginationEngine.navigateToPage(this.readerModeState.paginationData, currentPage);
            this.updatePageDisplay();
        }
    }

    /**
     * Refreshes reader mode rendering when settings change
     */
    public refreshReaderModeIfActive() {
        if (this.readerModeState.isActive) {
            this.applyReaderModeStyles();

            // Recalculate pagination when typography settings change
            this.recalculatePagination();

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