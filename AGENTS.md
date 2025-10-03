This repository is meant to implement a reader mode as an Obsidian plugin, for epub converted set of obsidian notes that form a book. See https://github.com/jwintz/obsidiant for the transcriber.

- Examples are in: ~/Library/Mobile\ Documents/iCloud\~md\~obsidian/Documents/Vault/Books.
- Never ever write into ~/Library/Mobile\ Documents/iCloud\~md\~obsidian/Documents/Vault/ and subfolder
- After each coding session, use the `apply` command to build and copy the plugin into the Vault for testing by the user

# Current Progress

- Reader mode overlay controls are in place with font-size adjustments, previous/next page navigation, font family selector, and zen toggle, including auto dismissal and bottom page indicator behaviour.
- Zen mode successfully hides ribbons, side panels, status bar, tab bar, `view-header-left`, and `view-actions` on desktop and mobile builds.
- Book detection promotes qualifying folders with native `BOOK` badges using metadata cache frontmatter parsing; no file writes occur.
- Panels are integrated: Outline mirrors chapter context, Bookmarks lists per-book page markers, and the Statistics view aggregates session/daily/weekly/monthly/yearly data.
- Statistics view highlights:
    * Session trend keeps a 14-day history and adjusts bar count responsively to chart width (falling back to 7 or 3 bars when space is limited) while marking estimated values.
    * Peak-hour chips use hour-specific `clock-1`…`clock-12` icons, suppress the icon when the "Top" badge is displayed, and scale intensity bars.
    * Gauges, streaks, and all-time analytics cards render with responsive layouts and live data bindings.
- Build + deploy workflow verified via `npm run build` and `npm run apply`, copying artifacts into the testing vault on macOS/iOS/iPadOS.

## Implementation Plan · Pagination + Layout Fixes

1. **Unify parameter propagation and live updates**
    - Introduce a shared `ReaderLayoutContext` so `ReaderManager.applyParameters` and `PaginationEngine.prepareLayout` operate on the same computed values (margins, guards, indicator height) instead of duplicating logic.
    - Ensure settings sliders broadcast incremental updates by wiring `refreshReaderModeIfActive` to wait for the next animation frame before re-running pagination, preventing stale padding from persisting.
    - Expose an explicit `pagination.updateParameters()` hook so horizontal margins, spacing, and font metrics always reapply before measurement.

2. **Fix multi-column pagination order**
    - Rework `PaginationEngine.normalizeFragments` to derive column geometry from computed `column-width`/`column-gap`, quantize column origins with tolerance, and project fragments into a linear stream based on `(columnIndex * pageHeight) + intraColumnY`.
    - Force measurement mode to use `column-fill: auto` during compute to avoid column balancing altering fragment order, then restore author settings after pagination.
    - Add regression tests (or debug assertions) to guarantee offsets remain strictly increasing across column transitions.

3. **Eliminate cropped content at page boundaries**
    - Expand guard padding calculations to account for line-height and column gaps; ensure `collectFragments` includes first/last rendered nodes so offsets never slice a fragment mid-line.
    - Clamp each computed offset to the previous fragment’s top and snap the final offset to `contentHeight - pageHeight` to avoid over-scroll.
    - Add a verification pass that simulates scrolling to each offset and checks the visible range covers the targeted fragments without clipping.

4. **Stabilize page transitions**
    - Replace `currentOffset` math based solely on floats with a page model capturing `{ startOffset, endOffset }`, using these bounds when animating to avoid repeats or drops.
    - Reset animations if offsets mutate mid-transition and debounce `applyPage` requests during recompute to keep navigation deterministic.

5. **Instrumentation & QA**
    - Introduce a temporary debug overlay (toggled via developer command) that renders the computed offsets, column maps, and guard zones for visual inspection while iterating.
    - Craft scripted smoke flows (desktop + mobile emulation) covering: dynamic horizontal margins, 2–3 column layouts, rapid parameter tweaks, and forward/backward navigation to catch regressions before release.

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

    display(): void {
        const { containerEl } = this;
        containerEl.empty();
        containerEl.classList.add('obsidianr-settings');

        containerEl.createEl('h3', { text: 'Format' });

        new Setting(containerEl)
            .setName('Justified')
            .setDesc('Enable text justification by default in reader mode')
            .addToggle((toggle) =>
                toggle
                    .setValue(this.plugin.settings.justified)
                    .onChange(async (value) => {
                        this.plugin.settings.justified = value;
                        await this.plugin.saveSettings();
                        this.plugin.refreshReaderModeIfActive();
                    })
            );

        const horizontalMargins = new Setting(containerEl)
            .setName('Horizontal Margins')
            .setDesc('Set the horizontal margins as a percentage of screen width')
            .addSlider((slider) =>
                slider
                    .setLimits(0, 30, 1)
                    .setValue(this.plugin.settings.horizontalMargins)
                    .setDynamicTooltip()
                    .onChange(async (value) => {
                        this.plugin.settings.horizontalMargins = value;
                        await this.plugin.saveSettings();
                        this.plugin.refreshReaderModeIfActive();
                    })
            );
        horizontalMargins.controlEl.classList.add('obsidianr-settings-control');

        const columnsSetting = new Setting(containerEl)
            .setName('Columns')
            .setDesc('Number of text columns in reader mode')
            .addSlider((slider) =>
                slider
                    .setLimits(1, 3, 1)
                    .setValue(this.plugin.settings.columns)
                    .setDynamicTooltip()
                    .onChange(async (value) => {
                        this.plugin.settings.columns = value;
                        await this.plugin.saveSettings();
                        this.plugin.refreshReaderModeIfActive();
                    })
            );
        columnsSetting.controlEl.classList.add('obsidianr-settings-control');

        const lineSpacingSetting = new Setting(containerEl)
            .setName('Line Spacing')
            .setDesc('Adjust line spacing (1.0 = normal, 1.5 = 1.5x spacing)')
            .addSlider((slider) =>
                slider
                    .setLimits(0.8, 2.5, 0.1)
                    .setValue(this.plugin.settings.lineSpacing)
                    .setDynamicTooltip()
                    .onChange(async (value) => {
                        this.plugin.settings.lineSpacing = Math.round(value * 10) / 10;
                        await this.plugin.saveSettings();
                        this.plugin.refreshReaderModeIfActive();
                    })
            );
        lineSpacingSetting.controlEl.classList.add('obsidianr-settings-control');

        const charSpacingSetting = new Setting(containerEl)
            .setName('Character Spacing')
            .setDesc('Adjust spacing between characters (0 = normal)')
            .addSlider((slider) =>
                slider
                    .setLimits(-0.1, 0.5, 0.01)
                    .setValue(this.plugin.settings.characterSpacing)
                    .setDynamicTooltip()
                    .onChange(async (value) => {
                        this.plugin.settings.characterSpacing = Math.round(value * 100) / 100;
                        await this.plugin.saveSettings();
                        this.plugin.refreshReaderModeIfActive();
                    })
            );
        charSpacingSetting.controlEl.classList.add('obsidianr-settings-control');

        const wordSpacingSetting = new Setting(containerEl)
            .setName('Word Spacing')
            .setDesc('Adjust spacing between words (0 = normal, small values recommended)')
            .addSlider((slider) =>
                slider
                    .setLimits(0.0, 0.5, 0.01)
                    .setValue(this.plugin.settings.wordSpacing)
                    .setDynamicTooltip()
                    .onChange(async (value) => {
                        this.plugin.settings.wordSpacing = Math.round(value * 100) / 100;
                        await this.plugin.saveSettings();
                        this.plugin.refreshReaderModeIfActive();
                    })
            );
        wordSpacingSetting.controlEl.classList.add('obsidianr-settings-control');

        const fontSizeSetting = new Setting(containerEl)
            .setName('Font Size')
            .setDesc('Default font size in pixels (can be adjusted in reader mode)')
            .addSlider((slider) =>
                slider
                    .setLimits(8, 48, 1)
                    .setValue(this.plugin.settings.fontSize)
                    .setDynamicTooltip()
                    .onChange(async (value) => {
                        this.plugin.settings.fontSize = value;
                        await this.plugin.saveSettings();
                        this.plugin.refreshReaderModeIfActive();
                    })
            );
        fontSizeSetting.controlEl.classList.add('obsidianr-settings-control');

        const fontFamilySetting = new Setting(containerEl)
            .setName('Font Family')
            .setDesc('Default font family used in reader mode')
            .addDropdown((dropdown) => {
                for (const option of FONT_CHOICES) {
                    dropdown.addOption(option.value, option.label);
                }
                const current = normalizeFontFamily(this.plugin.settings.fontFamily);
                dropdown.setValue(current);
                dropdown.onChange(async (value) => {
                    this.plugin.settings.fontFamily = normalizeFontFamily(value);
                    await this.plugin.saveSettings();
                    this.plugin.refreshReaderModeIfActive();
                });
            });
        fontFamilySetting.controlEl.classList.add('obsidianr-settings-control');

        containerEl.createEl('h3', { text: 'Transitions' });

        const transitionSetting = new Setting(containerEl)
            .setName('Transition Type')
            .setDesc('Choose the page transition animation for reader mode')
            .addDropdown((dropdown) =>
                dropdown
                    .addOption('none', 'None')
                    .addOption('page-curl', 'Page Curl')
                    .addOption('slide', 'Slide')
                    .addOption('fade', 'Fade')
                    .addOption('scroll', 'Scroll')
                    .setValue(this.plugin.settings.transitionType)
                    .onChange(async (value) => {
                        this.plugin.settings.transitionType = value as typeof this.plugin.settings.transitionType;
                        await this.plugin.saveSettings();
                        this.plugin.refreshReaderModeIfActive();
                    })
            );
        transitionSetting.controlEl.classList.add('obsidianr-settings-control');

        containerEl.createEl('h3', { text: 'Goals' });

        const goalSetting = new Setting(containerEl)
            .setName('Daily reading goal (minutes)')
            .setDesc('Used for daily statistics and streaks')
            .addSlider((slider) =>
                slider
                    .setLimits(5, 240, 5)
                    .setDynamicTooltip()
                    .setValue(this.plugin.settings.dailyGoalMinutes)
                    .onChange(async (value) => {
                        this.plugin.settings.dailyGoalMinutes = value;
                        await this.plugin.saveSettings();
                        this.plugin.refreshReaderModeIfActive();
                    })
            );
        goalSetting.controlEl.classList.add('obsidianr-settings-control');

        containerEl.createEl('h3', { text: 'Reset' });

        const resetDefaultsSetting = new Setting(containerEl)
            .setName('Reset to Defaults')
            .setDesc('Reset all settings to their default values')
            .addButton((button) =>
                button
                    .setButtonText('Reset All Settings')
                    .setCta()
                    .onClick(async () => {
                        this.plugin.settings = Object.assign({}, DEFAULT_SETTINGS);
                        await this.plugin.saveSettings();
                        this.plugin.refreshReaderModeIfActive();
                        this.display();
                        new Notice('All settings have been reset to defaults');
                    })
            );
        resetDefaultsSetting.controlEl.classList.add('obsidianr-settings-control');

        const resetDataSetting = new Setting(containerEl)
            .setName('Reset Data')
            .setDesc('Clear saved bookmarks, statistics, and reading positions')
            .addButton((button) =>
                button
                    .setButtonText('Reset Data')
                    .setWarning()
                    .onClick(async () => {
                        const modal = new ConfirmResetDataModal(this.app, async () => {
                            await this.plugin.resetStoredData();
                            this.display();
                            new Notice('All reading data has been cleared');
                        });
                        modal.open();
                    })
            );
        resetDataSetting.controlEl.classList.add('obsidianr-settings-control');
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

The destructive "Reset Data" action opens `ConfirmResetDataModal`, mirroring the implementation in `src/settings/index.ts` to require explicit confirmation before clearing saved progress.

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
