# ObsidianR - Ebook Reader Plugin for Obsidian

Reader mode plugin for epub-converted notes that form a book. See https://github.com/jwintz/obsidiant for the transcriber.

## Setup

- **Examples**: `~/Library/Mobile Documents/iCloud~md~obsidian/Documents/Vault/Books`
- **Never write** to the Vault - read-only access for examples
- **After coding**: Run `npm run apply` to build and copy plugin to Vault for testing

## Testing with Chrome DevTools Protocol (CDP)

**Prerequisites:**
```bash
# Start Obsidian with remote debugging
open -a Obsidian --args --remote-debugging-port=9222
```

**Workflow:**
```bash
npm run apply    # Build and deploy plugin to vault
npm test         # Automated test suite
```

**Manual CDP Commands:**
```javascript
// Get plugin instance
const plugin = app.plugins.plugins.obsidianr;

// Reload Obsidian
app.commands.executeCommandById("app:reload");

// Toggle reader mode
plugin.reader.toggleReaderMode();

// Navigate pages
plugin.reader.state.update({ currentPage: 5 });

// Update parameters
plugin.reader.updateParameters({ 
    columns: 2, 
    fontSize: 20,
    horizontalMargins: 15 
});
```

**Test Requirements:**
- Open a book chapter with frontmatter: `type: chapter`, `book: <book-name>`
- Example: `~/Library/Mobile Documents/iCloud~md~obsidian/Documents/Vault/Books/Dossier 64/Dossier 64 - Chapter 1.md`

## Breakthrough Discoveries

### 1. Container vs Content Element (October 7, 2025)

**Problem:** Content was invisible on pages > 0 because transform was applied to the wrong element.

**Discovery:**
- `PaginationEngine` constructor set both `containerEl` and `contentEl` to the same element
- Transform moved the ENTIRE container off-screen (e.g., position -771 on page 1)
- Content was displaced way above viewport

**Solution:**
```typescript
// WRONG (old code):
this.containerEl = contentEl;
this.contentEl = contentEl;  // Same element!

// CORRECT (fixed):
this.containerEl = containerEl;  // Container = .obsidianr-reader-container
this.contentEl = getContentElement();  // Content = .obsidianr-reader-content (inside container)
```

**Implementation:**
- Created `getContentElement()` to find `.obsidianr-reader-content` inside container
- Created `setTransform()` to apply transform to content element only
- Container stays fixed at rendering area (77-926), content moves inside it

**Result:** All pages now show content correctly ✅

### 2. Available Height Calculation (October 7, 2025)

**Problem:** Page height was 779px instead of 849px, causing wrong page count.

**Discovery:**
- Old calculation: `viewportHeight - padding - indicator = 779px` (WRONG)
- Actual rendering area: `header.bottom → indicator.top = 849px` (CORRECT)

**Solution:**
```typescript
// Calculate rendering area directly
const header = document.querySelector('.view-header-title-container');
const indicator = document.querySelector('.obsidianr-reader-page-indicator');
const availableHeight = indicator.top - header.bottom;  // 849px
```

**Result:** Correct page height and page count ✅

### 3. Viewport Padding Removal (October 7, 2025)

**Problem:** Content had 16px offset even with container positioned correctly.

**Discovery:**
- Old approach used viewport padding to create space for header/indicator
- With absolute container positioning, viewport padding is unnecessary and causes offset

**Solution:**
```typescript
// Remove viewport padding when using absolute container positioning
this.viewportEl.style.setProperty('padding-top', '0px', 'important');
this.viewportEl.style.setProperty('padding-bottom', '0px', 'important');
```

**Result:** No more 16px offset ✅

### 4. Multi-Column Layout Challenge (Current)

**Problem:** Columns flow ACROSS pages instead of WITHIN pages.

**Current Behavior:**
- `column-fill: balance` creates balanced columns VERTICALLY
- Content split into shorter columns: 2 cols → 9,496px, 3 cols → 9,130px
- Must read column 1 across all pages, then go back for column 2 (WRONG for ebook!)

**Expected Ebook Behavior:**
- Each page shows N columns side-by-side
- Read all columns on page 1 (left to right), then page 2
- Example with 2 columns:
  - Page 1: [Column 1 | Column 2]
  - Page 2: [Column 3 | Column 4]

**Proposed Solution:**
1. Set **fixed height** on content element = `availableHeight` (849px)
2. Use **`column-fill: auto`** for sequential filling (not balanced)
3. CSS creates columns that fill to height, flowing left-to-right
4. Paginate **horizontally**: calculate page width, transform via `translateX(-offset)`
5. Each "page" shows exactly N columns side-by-side

**Implementation Plan:**
```typescript
// In applyParameters():
if (context.columns > 1) {
    target.style.height = `${availableHeight}px`;  // Fixed height
    target.style.columnFill = 'auto';  // Sequential, not balanced
}

// In measure():
if (columns > 1 && hasFixedHeight) {
    // Horizontal pagination for ebook columns
    const scrollWidth = measurementTarget.scrollWidth;
    const viewportWidth = this.viewportEl.clientWidth;
    const totalPages = Math.ceil(scrollWidth / viewportWidth);
    // Transform: translateX(-pageWidth * pageIndex)
} else {
    // Vertical pagination (current)
    const totalPages = Math.ceil(scrollHeight / availableHeight);
    // Transform: translateY(-availableHeight * pageIndex)
}
```

## Technical Architecture

### Rendering Area
- **Top boundary**: Bottom of `.view-header-title-container`
- **Bottom boundary**: Top of `.obsidianr-reader-page-indicator`
- **Height**: `indicator.top - header.bottom` (e.g., 849px)

### Element Hierarchy
```
.markdown-reading-view (viewport)
  └─ .obsidianr-reader-container (fixed at header → indicator)
      └─ .obsidianr-reader-content (transform moves this)
          └─ [Rendered markdown content]
```

### Key Principles
- Container positioned absolutely at rendering area, NEVER moves
- Transform applied to CONTENT element only
- Viewport has `overflow: hidden` to clip content outside rendering area
- Result: **No cropping within viewport** - all visible content is fully readable

### Pagination System

**Current (Single-Column & Multi-Column WRONG):**
```typescript
const availableHeight = indicator.top - header.bottom;  // 849px
const scrollHeight = content.scrollHeight;               // 11,207px
const totalPages = Math.ceil(scrollHeight / availableHeight);
const offsets = [0, 849, 1698, ...];  // Vertical offsets
// Transform: translate3d(0, -offset[N], 0)
```

**Status:**
- ✅ Single-column: Works perfectly
- ❌ Multi-column: Flows across pages (needs horizontal pagination)

## Constraints

- Keep code **minimalistic**
- No dead code
- Avoid dependencies
- Must work on Desktop (macOS) and Mobile (iOS, iPadOS)

## References

1. https://docs.obsidian.md/Home
