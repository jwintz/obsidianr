This repository is meant to implement a reader mode as an Obsidian plugin, for epub converted set of obsidian notes that form a book. See https://github.com/jwintz/obsidiant for the transcriber.

- Examples are in: ~/Library/Mobile\ Documents/iCloud\~md\~obsidian/Documents/Vault/Books.
- Never ever write into ~/Library/Mobile\ Documents/iCloud\~md\~obsidian/Documents/Vault/ and subfolder
- After each coding session, use the `apply` command to build and copy the plugin into the Vault for testing by the user

# Book detection in Vault

- Detect books in the vault, they are transcribed using https://github.com/jwintz/obsidiant.
- A folder qualifies as a book only if its markdown children expose frontmatter marking them as chapters (`type: chapter`, etc.) and share the same `book` metadata.
- Detection runs from the metadata cache when available and falls back to parsing frontmatter directly from the file when needed. No file writes occur.
- Register the folder as a book with the aggregated chapter list (sorted by explicit chapter order or filename heuristics as a fallback).
- Add a `BOOK` pill to the folder entry in the File Explorer using the native Obsidian badge element:
    * Resolve the File Explorer view (`fileItems`) and reuse the explorer's own DOM nodes when injecting/removing badges.
    * Clone the existing `nav-folder-title-badge` element when present so styling matches the `BASE` pill exactly (works on desktop and mobile).
    * Listen to vault and metadata events with debounced recomputation, and observe the explorer DOM while ignoring mutations caused by the injected badge to avoid loops.

# Pagination algorithm

The pagination algorithm works by:

1. Content Measurement: Measuring the rendered height of text content
2. Page Calculation: Dividing content height by available page height
3. Dynamic Adjustment: Recalculating when parameters change
4. Position Tracking: Maintaining current reading position across parameter changes

## Key Parameters

**Viewport Parameters**

* Viewport Width: Available horizontal space
* Viewport Height: Available vertical space
* Page Margins: Top, bottom, left, right margins
* Column Count: Single or multi-column layout
* Column Gap: Space between columns in multi-column layouts

**Typography Parameters**

* Font Family: Typeface selection (serif, sans-serif, specific fonts)
* Font Size: Text size in pixels, points, or em units
* Line Height: Spacing between lines
* Letter Spacing: Character spacing adjustments
* Word Spacing: Space between words
* Text Alignment: Left, right, center, justified

**Content Flow Parameters**

* Page Break Rules: Honor CSS page-break properties
* Orphan Control: Minimum lines at bottom of page
* No cropping of Contents: First and last lines of the page must be displayed within the dedicated viewport

## Technical Hints

```
// For mobile compatibility, use Vault methods
const fileContent = await this.app.vault.cachedRead(file);
```

```
// Check if running on mobile
if (this.app.isMobile) {
    // Use touch events for page navigation
    this.registerDomEvent(this.containerEl, 'touchstart', this.handleTouchStart);
    this.registerDomEvent(this.containerEl, 'touchend', this.handleTouchEnd);
} else {
    // Use keyboard shortcuts for desktop
    this.registerDomEvent(document, 'keydown', this.handleKeyDown);
}
```

## Layout and ergonomy

- A bottom margin of the same height as `view-header-title-container` must contain the current page number over the total number of computed pages when overlay controls are displayed

- When overlay controls are displayed the note title must change to the number of pages left in the chapter

- next/previous buttons of overlay controls must consider pages instead of chapters

- on mobile, sliding left/right must trigger page transitions, touch events must activate the overlay controls

- Front matter must not be displayed in reader mode

# Settings

```
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
```

Changing the settings dynamically updates everything.

# UI

When in reader mode:

Overlay controls (displays on non page transition click/touch event) must include:

- Increase font size (button)
- Decrease font size (button)
- Previous page (button)
- Next page (button)
- Font family (combobox)
- Zen mode (toggle button)

Overlay controls dismiss after 5 seconds of inactivity with cursor not within its area, it has a glass/blur effect.

Obisidian's top header `view-header-title-container` must add a segment for `X pages left` when overlay controls are displayed.

A bottom area, sam height as `view-header-title-container` must display current page number (global for book), when overlay controls are display, it must be current page number / total number of pages

Entering zen mode hides:
- left hand side panels area
- right hand side panels area
- status bar
- tab bar
- `view-header-left`
- `view-actions`

For the icons, lucide icons must be used, it is built-in. Make sure to retrieve them on mobile platforms (iOS, iPadOS).

# Panels

Finally panel for the reader mode must be implemented. They are activated/deactivated together with the reading mode.

## Link with exisiting panels

**Table of Contents**

Use the existing `Outline` panel to display te book's Table of contents, together with the currently reading chapter.

**Bookmarks**

Use the exisiting `Bookmarks` panel to display the bookmarked pages for the current book.

## New panels

**Statistics**

Implement a `Reading statistics` panel that will include:

- Reading session statistics. A session is reset after an hour not reading.
- Daily reading statistics, with a daily goal and its progress (Daily goal must be set up in the settings)
- Weekly reading statistics
- Monthly reading statistics
- Yearly reading statistics (include the set of books read, TW/ their reading stats summarized)

# Constraints

- Keep the code **minimalistic**
- No dead code
- Avoid dependencies as much as possible
- Have performance tested
- Must work on Desktop (macOS) and Mobile (iOS, iPadOS)
- Whenever this file is updated, make sure everything is consistent and re-plan.

# Reference

1. https://docs.obsidian.md/Home
