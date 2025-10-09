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

### 1. Available Height Calculation

**Problem:** Page height was not correct, causing wrong page count.

**Discovery:**
- Old calculation: `viewportHeight - padding - indicator` (WRONG)
- Actual rendering area: `header.bottom → indicator.top` (CORRECT)

**Result:** Correct page height and page count

### 2. Viewport Padding Removal

**Problem:** Content had 16px offset even with container positioned correctly.

**Discovery:**
- Old approach used viewport padding to create space for header/indicator
- With absolute container positioning, viewport padding is unnecessary and causes offset

### 3. Multi-Column Layout Challenge (Current)

**Problem:** Columns flow ACROSS pages instead of WITHIN pages.

**Current Behavior:**
- `column-fill: balance` creates balanced columns VERTICALLY
- Must read column 1 across all pages, then go back for column 2 (WRONG for ebook!)

**Expected Ebook Behavior:**
- Each page shows N columns side-by-side (depending on the settings)
- Read all columns on page 1 (left to right), then page 2
- Example with 2 columns:
  - Page 1: [Column 1 | Column 2]
  - Page 2: [Column 3 | Column 4]

**Proposed Solution:**
1. Set **fixed height** on content element = `availableHeight`
2. Use **`column-fill: auto`** for sequential filling (not balanced)
3. CSS creates columns that fill to height, flowing left-to-right
4. Each "page" shows exactly N columns side-by-side

## Technical Architecture

### Rendering Area
- **Top boundary**: Bottom of `.view-header-title-container`
- **Bottom boundary**: Top of `.obsidianr-reader-page-indicator`
- **Height**: `indicator.top - header.bottom`

### Key Principles
- Container positioned absolutely at rendering area, NEVER moves
- Transform applied to CONTENT element only
- Viewport has `overflow: hidden` to clip content outside rendering area
- Result: **No cropping within viewport** - all visible content is fully readable

## Implementation plan

- The settings are dynamic parameters of both the pagination and rendering engine
- The pagination engine computes, for a note, which is a chapter within a book, the set of pages that fit the rendering area (which is variable depending on the application width, height and setup (sidebars visible or not)), so that setting are honored and content is neither visually cropped, nor parts of it repeated or dropped when navigating through pages
- The rendering engine makes sure computed pages are correctly displayed depending on the set of settings (that must dynamically apply)
- Fix the rendering engine for N pages (N is in [1, 2, 3])
- Fix the pagination algorithm

## Progress log

- [x] **Audit current pagination & rendering**
  - `PaginationEngine` currently derives page offsets from text line fragments while the viewport padding injects header/indicator spacing, so the measured `availableHeight` still depends on external padding rather than the direct header→indicator slice.
  - Multi-column support relies on CSS `column-fill: balance` and maps fragments vertically, which causes columns to span across pages instead of yielding N side-by-side columns per page.
  - Rendering manager (`ReaderManager`) mirrors the same padding/column-fill assumptions, so content sizing and transforms move the entire column flow vertically instead of paging through contiguous column groups.
- [x] **Refactor pagination engine for multi-column flow**
  - Pagination now records axis-aware metadata (page width, horizontal offsets, column metrics) so downstream rendering can translate along X when multiple columns are active.
  - Measurement uses sequential column flow (`column-fill: auto`), computes deterministic virtual offsets per column group, and exposes total column counts for progress/bookmark consumers.
  - Fallback pagination mirrors the axis-aware logic to keep page counts consistent during error paths, and debugging validation respects the wider window span per multi-column page.
- [x] **Automate CDP regression checks**
  - Added `scripts/reload-and-verify.mjs` to toggle the plugin via CDP and ensure the reader manager is rehydrated after each build.
  - Added `scripts/test-reader.mjs` to open a reference chapter, enforce a 2-column layout, assert pagination metadata (axis, offsets, column metrics), and capture timestamped screenshots in `artifacts/screenshots` for visual diffing.
  - Shared CDP helper (`scripts/lib/cdp-client.mjs`) handles target discovery and command dispatch without external dependencies so every step can run under `npm test`.
  - Current run intentionally fails: 2-column layout computes 3 pages and leaves pages 2–3 empty, confirming the pagination/rendering bug before refactoring.
  - Regression now records DOM diagnostics alongside screenshots (`artifacts/dom/*.json`) and exposes the visual bug clearly: the first page renders 57 columns instead of 2, so screenshots + JSON capture the mismatch in addition to the empty page metrics.

## Validation

Since there is an MCP and CDP toolchain, scripts unders the `scripts` folder must validate each step, everytime the plugin is built using `npm run apply`. They must include visual analysis by grabbing screenshots of the rendering throughout pages. For the pagination, the computation must be deterministic and exact. Given the state of the application and the set of settings, there is ONE mathematically correct way to compute the set of pages to satisfy the constraints listed in the immplementation plan.

## Constraints

- Keep code **minimalistic**
- No dead code
- Avoid dependencies
- Must work on Desktop (macOS) and Mobile (iOS, iPadOS)

## References

1. https://docs.obsidian.md/Home
