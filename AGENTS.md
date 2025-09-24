This repository is meant to implment a reader mode, for epub converted set of obsidian notes that form a book. See https://github.com/jwintz/obsidiant for the transcriber.

# Pagination algorithm

The pagination algorithm works by:

1. Content Measurement: Measuring the rendered height of text content
2. Page Calculation: Dividing content height by available page height
3. Dynamic Adjustment: Recalculating when parameters change
4. Position Tracking: Maintaining current reading position across parameter changes

## Key Parameters

**Viewport Parameters**

* Viewport Width: Available horizontal space (e.g., 800px)
* Viewport Height: Available vertical space (e.g., 1200px)
* Page Margins: Top, bottom, left, right margins (e.g., 40px each)
* Column Count: Single or multi-column layout
* Column Gap: Space between columns in multi-column layouts

**Typography Parameters**

* Font Family: Typeface selection (serif, sans-serif, specific fonts)
* Font Size: Text size in pixels, points, or em units (e.g., 16px)
* Line Height: Spacing between lines (e.g., 1.4x font size)
* Letter Spacing: Character spacing adjustments
* Word Spacing: Space between words
* Text Alignment: Left, right, center, justified

**Content Flow Parameters**

* Page Break Rules: Honor CSS page-break properties
* Orphan Control: Minimum lines at bottom of page
* Widow Control: Minimum lines at top of page
* Image Handling: How images fit within page boundaries
* Table Breaking: Rules for splitting tables across pages

## Algorithmic Hints

1. Content Preparation

```
1. Load XHTML content from EPUB
2. Apply CSS stylesheets (default + user preferences)
3. Create virtual rendering container
4. Apply typography and layout parameters
```

2. Measurement Phase

```
FOR each content element:
    1. Render element with current parameters
    2. Measure actual height after text reflow
    3. Account for images, tables, and other media
    4. Calculate break points (paragraph, section boundaries)
```

3. Page Calculation

```
available_page_height = viewport_height - top_margin - bottom_margin
content_height = sum(all_rendered_elements_height)
estimated_pages = ceil(content_height / available_page_height)

FOR each estimated page:
    1. Determine actual content that fits
    2. Handle widow/orphan rules
    3. Respect CSS page-break properties
    4. Adjust for images that don't fit
    5. Calculate precise page boundaries
```

4. Position Mapping

```
Create mapping of:
- Character positions to page numbers
- Page numbers to scroll/offset positions
- Bookmark locations to page coordinates
```

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

# Panels

...

## Link with exisiting panels

**Table of Contents**

...

**Bookmarks**

...

## New panels

**Statistics**

...
