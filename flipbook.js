// flipbook.js
// ---------------------------------------------------------------------------
// Wraps St.PageFlip (the "page-flip" library, MIT licensed, successor of
// StPageFlip) and feeds it live, on-demand PDF.js renders instead of
// pre-baked page images.
//
// Only a small "render window" around the current spread is ever rasterized:
//   previous page, current page, next page, and two pages ahead.
// Everything else is torn down (bitmap released, PDF.js page proxy freed)
// so memory stays flat no matter how long the issue is.
//
// Two implementation notes worth knowing before you touch this file:
//
// 1. No synthetic cover. Page 1 and the last page of the PDF *are* the hard
//    covers (data-density="hard") — we don't insert an extra title card in
//    front of them. Whatever you designed as your PDF's first/last page is
//    what readers see as the cover.
//
// 2. PDF.js renders into an offscreen <canvas>, but the page's visible
//    layer is an <img>, not the canvas itself. This is deliberate: when
//    page-flip animates a soft-page flip it clones the page's DOM node
//    (cloneNode) to drive the 3D peel. Cloning a <canvas> copies the
//    element but not its drawn pixels — the browser just doesn't clone
//    canvas bitmaps — so a live <canvas> page goes blank/glitchy mid-flip.
//    An <img> clones its bitmap correctly, so the flip stays smooth. The
//    PDF is still rendered fresh on demand by PDF.js for every page; the
//    <img> is just a disposable, in-memory Blob URL snapshot of that
//    render used as the display layer, revoked as soon as the page is torn
//    down. Nothing is written to disk or reused across sessions.
// ---------------------------------------------------------------------------

const KEEP_BEHIND = 1; // pages behind current to keep rendered
const KEEP_AHEAD = 3; // pages ahead of current to keep rendered (spec: next + two ahead)
const RESIZE_DEBOUNCE_MS = 180;
const ZOOM_SETTLE_MS = 250;

export class Flipbook {
  /**
   * @param {HTMLElement} el mount point
   * @param {object} opts
   * @param {(info: {pageIndex:number, totalItems:number, orientation:string}) => void} opts.onPageChange
   * @param {() => void} opts.onReady
   */
  constructor(el, opts = {}) {
    this.el = el;
    this.opts = opts;
    this.pageFlip = null;
    this.renderer = null; // PDFRenderer
    this.numPdfPages = 0;
    this.itemEls = []; // one element per PDF page; item[0] and item[last] are the hard covers
    this.imgByPage = new Map(); // pdfPageNumber -> <img>
    this._blobUrls = new Map(); // pdfPageNumber -> object URL currently assigned to its <img>
    this.renderedPages = new Set();
    this._zoomScale = 1;
    this._resizeTimer = null;
    this._zoomTimer = null;
    this._destroyed = false;

    this._onResize = this._onResize.bind(this);
    window.addEventListener('resize', this._onResize);
  }

  /** item index maps 1:1 to PDF page number (item 0 = PDF page 1). */
  _itemIndexToPdfPage(itemIndex) {
    const pn = itemIndex + 1;
    if (pn < 1 || pn > this.numPdfPages) return null;
    return pn;
  }

  async loadDocument(renderer) {
    this.renderer = renderer;
    this.numPdfPages = renderer.numPages;
    this.el.innerHTML = '';
    this.itemEls = [];
    this.imgByPage.clear();
    this._revokeAllBlobUrls();
    this.renderedPages.clear();

    // page-flip's own destroy() removes its container element from the DOM
    // (`this.block.remove()`), so we can't hand it the same persistent node
    // across issue switches — it would be detached (and 0x0) on the next
    // load. Give every load a fresh, disposable mount div instead.
    const mount = document.createElement('div');
    mount.className = 'flipbook-mount';
    this.el.appendChild(mount);
    this.mountEl = mount;

    // --- one element per live PDF page — first and last are hard covers ----
    for (let p = 1; p <= this.numPdfPages; p++) {
      const pageEl = document.createElement('div');
      pageEl.className = 'page';
      pageEl.dataset.pageNumber = String(p);
      if (p === 1 || p === this.numPdfPages) {
        pageEl.dataset.density = 'hard';
        pageEl.classList.add('page--cover');
      }

      const inner = document.createElement('div');
      inner.className = 'page-canvas-wrap';
      const img = document.createElement('img');
      img.className = 'page-canvas';
      img.alt = `Page ${p}`;
      img.draggable = false;
      inner.appendChild(img);
      pageEl.appendChild(inner);

      if (p !== 1 && p !== this.numPdfPages) {
        const num = document.createElement('div');
        num.className = 'page-folio';
        num.textContent = String(p);
        pageEl.appendChild(num);
      }

      this.imgByPage.set(p, img);
      this.itemEls.push(pageEl);
    }

    const ratio = renderer.aspectRatio || 0.75;
    const baseHeight = 900;
    const baseWidth = Math.round(baseHeight * ratio);
    const reducedMotion = window.matchMedia && window.matchMedia('(prefers-reduced-motion: reduce)').matches;

    // eslint-disable-next-line no-undef
    this.pageFlip = new St.PageFlip(mount, {
      width: baseWidth,
      height: baseHeight,
      size: 'stretch',
      minWidth: 240,
      maxWidth: 2200,
      minHeight: 320,
      maxHeight: 2800,
      drawShadow: true,
      flippingTime: reducedMotion ? 1 : 700,
      usePortrait: true,
      startZIndex: 10,
      autoSize: true,
      maxShadowOpacity: 0.55,
      showCover: true,
      mobileScrollSupport: false,
      swipeDistance: 25,
      clickEventForward: true,
      useMouseEvents: true,
      showPageCorners: true,
      disableFlipByClick: false,
    });

    this.pageFlip.loadFromHTML(this.itemEls);

    this.pageFlip.on('init', () => {
      this._updateRenderWindow();
      if (this.opts.onReady) this.opts.onReady();
      this._emitPageChange();
    });

    this.pageFlip.on('flip', () => {
      this._updateRenderWindow();
      this._emitPageChange();
    });

    this.pageFlip.on('changeOrientation', () => {
      this._updateRenderWindow();
    });
  }

  _emitPageChange() {
    if (!this.pageFlip || !this.opts.onPageChange) return;
    const idx = this.pageFlip.getCurrentPageIndex();
    this.opts.onPageChange({
      pageIndex: idx,
      totalItems: this.itemEls.length,
      orientation: this.pageFlip.getOrientation ? this.pageFlip.getOrientation() : 'double',
      pdfPage: this._itemIndexToPdfPage(idx),
      numPdfPages: this.numPdfPages,
    });
  }

  /** Render current +/- window, tear down everything else. */
  async _updateRenderWindow(extraScale = this._zoomScale) {
    if (!this.pageFlip || !this.renderer) return;
    const current = this.pageFlip.getCurrentPageIndex();

    const wanted = new Set();
    for (let d = -KEEP_BEHIND; d <= KEEP_AHEAD; d++) {
      const pn = this._itemIndexToPdfPage(current + d);
      if (pn) wanted.add(pn);
    }

    // Tear down pages that fell out of the window.
    for (const pn of Array.from(this.renderedPages)) {
      if (!wanted.has(pn)) this._teardownPage(pn);
    }

    // Render newly-wanted pages.
    const jobs = [];
    for (const pn of wanted) {
      jobs.push(this._renderPage(pn, extraScale));
    }
    await Promise.all(jobs);
  }

  async _renderPage(pageNumber, extraScale = 1) {
    const img = this.imgByPage.get(pageNumber);
    if (!img || !this.renderer) return;
    const wrap = img.parentElement;
    const cssWidth = wrap.clientWidth || 400;
    const cssHeight = wrap.clientHeight || 560;
    if (cssWidth === 0 || cssHeight === 0) return;

    // Render into a throwaway offscreen canvas — never inserted into the
    // DOM, so it never has to survive being cloned during a flip animation.
    const scratch = document.createElement('canvas');
    try {
      await this.renderer.renderPageToCanvas(pageNumber, scratch, cssWidth, cssHeight, extraScale);
      const blob = await new Promise((resolve) => scratch.toBlob(resolve, 'image/png'));
      if (!blob) return;
      const url = URL.createObjectURL(blob);
      const prevUrl = this._blobUrls.get(pageNumber);
      img.src = url;
      this._blobUrls.set(pageNumber, url);
      if (prevUrl) URL.revokeObjectURL(prevUrl);
      this.renderedPages.add(pageNumber);
      img.classList.add('is-rendered');
    } catch (err) {
      // eslint-disable-next-line no-console
      console.warn(`Failed to render page ${pageNumber}`, err);
    }
  }

  _teardownPage(pageNumber) {
    this.renderer.destroyPage(pageNumber);
    const img = this.imgByPage.get(pageNumber);
    if (img) {
      img.classList.remove('is-rendered');
      img.removeAttribute('src');
    }
    const url = this._blobUrls.get(pageNumber);
    if (url) {
      URL.revokeObjectURL(url);
      this._blobUrls.delete(pageNumber);
    }
    this.renderedPages.delete(pageNumber);
  }

  _revokeAllBlobUrls() {
    for (const url of this._blobUrls.values()) URL.revokeObjectURL(url);
    this._blobUrls.clear();
  }

  // --- navigation ----------------------------------------------------------
  next() { if (this.pageFlip) this.pageFlip.flipNext(); }
  prev() { if (this.pageFlip) this.pageFlip.flipPrev(); }
  goToItem(index) { if (this.pageFlip) this.pageFlip.turnToPage(index); }
  goToPdfPage(pdfPageNumber) { if (this.pageFlip) this.pageFlip.turnToPage(pdfPageNumber - 1); }

  get currentPdfPage() {
    if (!this.pageFlip) return 1;
    return this._itemIndexToPdfPage(this.pageFlip.getCurrentPageIndex()) || 1;
  }

  get totalPdfPages() { return this.numPdfPages; }

  // --- zoom: re-render visible pages sharper once zoom settles -------------
  setZoomScale(scale) {
    this._zoomScale = scale;
    clearTimeout(this._zoomTimer);
    this._zoomTimer = setTimeout(() => this._updateRenderWindow(scale), ZOOM_SETTLE_MS);
  }

  // --- resize: page-flip handles layout reflow itself (autoSize), we just --
  // --- need to re-rasterize visible pages at the new CSS pixel size. -------
  _onResize() {
    clearTimeout(this._resizeTimer);
    this._resizeTimer = setTimeout(() => {
      if (this._destroyed) return;
      for (const pn of Array.from(this.renderedPages)) {
        this.renderer.cancelRender(pn);
        this.renderedPages.delete(pn);
      }
      this._updateRenderWindow();
    }, RESIZE_DEBOUNCE_MS);
  }

  destroy() {
    this._destroyed = true;
    window.removeEventListener('resize', this._onResize);
    clearTimeout(this._resizeTimer);
    clearTimeout(this._zoomTimer);
    if (this.pageFlip) {
      try { this.pageFlip.destroy(); } catch (_) { /* no-op */ }
      this.pageFlip = null;
    }
    for (const pn of Array.from(this.renderedPages)) this._teardownPage(pn);
    this._revokeAllBlobUrls();
    this.el.innerHTML = '';
  }
}
