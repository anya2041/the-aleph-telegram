# The Aleph Telegram — digital magazine reader

A complete rewrite of the flipbook reader. The PDF is the source of truth —
pages are rendered live by PDF.js straight into `<canvas>` elements, on
demand, at full device pixel ratio. Nothing is ever pre-baked into stored
PNG/JPEG images, so text stays sharp at any zoom level (the old
`pdfToImages()` + `pageFlip.loadFromImages()` pipeline is gone entirely).

No build step, no npm, no React. Open `index.html` directly or deploy the
folder as-is to GitHub Pages.

## File structure

```
index.html        Page shell: masthead, stage, toolbar. Loads page-flip as a
                   classic script, then app.js as an ES module.
style.css          All styling — parchment background, type system, ticket-
                   stub page indicator, hard covers, responsive rules.
app.js             Orchestration: issue loading, all UI wiring (keyboard,
                   wheel, zoom, fullscreen, download, bookmarks).
pdfRenderer.js      PDF.js wrapper. Loads a PDF and renders individual pages
                   into a given canvas on request. No image conversion, ever.
flipbook.js        Wraps the page-flip library (MIT licensed). Builds hard
                   covers + one element per PDF page, and manages a sliding
                   "render window" so only nearby pages are ever rasterized.
ui.js              Small DOM helpers: spinner, error banner, issue <select>
                   population, page indicator, zoom readout, fullscreen.
lib/               Third-party libraries, vendored locally (no CDN, no npm
                   at runtime):
                     - pdf.min.mjs / pdf.worker.min.mjs  (PDF.js, Apache-2.0)
                     - page-flip.browser.js               (page-flip, MIT)
issues.json        The issue manifest driving the selector + downloads.
issues/            Your PDF files.
```

## Swapping in your real issues

1. Drop your PDFs into `issues/` (they can be large — pages are streamed
   and rendered on demand, not pre-processed).
2. Edit `issues.json`:

```json
[
  { "id": "issue-1", "title": "Issue No. 1 — Spring 2025", "file": "issues/Issue-1.pdf" },
  { "id": "issue-2", "title": "Issue No. 2 — Summer 2025", "file": "issues/Issue-2.pdf" }
]
```

`id` just needs to be unique and URL-safe — it's used for the `?issue=`
deep link and for the per-issue "resume where you left off" bookmark. The
two PDFs currently in `issues/` are placeholder samples generated for
testing; replace or remove them.

## How the rendering pipeline works

- `PDFRenderer.load()` opens the PDF via `pdfjsLib.getDocument()` and reads
  page 1's aspect ratio to size the book.
- `Flipbook.loadDocument()` builds one lightweight `<div class="page">` per
  PDF page (plus a front and back hard cover), each holding an empty
  `<canvas>`, and hands them to `page-flip`'s `loadFromHTML()`.
- On `init` / `flip` / `changeOrientation`, `Flipbook._updateRenderWindow()`
  computes which PDF pages should be visible soon (1 behind, current, and
  3 ahead) and calls `PDFRenderer.renderPageToCanvas()` for each — sized to
  the canvas's actual CSS pixels × `devicePixelRatio` (capped at 3.5×, and
  multiplied further while zoomed in, so text stays crisp).
- Pages that fall out of that window are torn down: the render task is
  cancelled, the canvas is cleared and shrunk to `0×0`, and the PDF.js page
  proxy is released — so memory stays flat no matter how long the issue is.
- Resizing the window re-rasterizes the currently visible pages (debounced)
  so they stay sharp at the new size instead of just being CSS-scaled and
  blurry.

## Notable implementation detail

`page-flip`'s own `destroy()` removes its container element from the DOM
(`this.block.remove()`). Because issues can be switched at runtime, each
`loadDocument()` call creates a fresh, disposable `<div class="flipbook-mount">`
inside the persistent `#flipbook` wrapper, rather than handing page-flip the
same node twice — otherwise the second issue would silently render into a
detached, zero-size element.

## Features

- Realistic page curl with shadows, hard front/back covers, opens from cover
- Mouse drag, touch swipe, arrow keys, and mouse wheel navigation
- Automatic single-page (portrait/mobile) vs. two-page spread (desktop)
- Zoom via buttons, double-click (zooms toward the click point), `+`/`-`/`0`
  keys, with a native-scroll pan while zoomed
- Fullscreen toggle (button, `F` key)
- Loading spinner with progress, error banner with retry
- Per-issue "resume where you left off" bookmark (localStorage)
- Download button for the current issue's PDF

## Browser support

Uses ES modules, `<canvas>`, `IntersectionObserver`-free lazy rendering,
and `fetch`. Any evergreen browser (Chrome, Firefox, Safari, Edge) from the
last few years is fine. No transpilation is performed or needed.
