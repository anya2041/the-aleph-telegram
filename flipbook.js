// flipbook.js
// ---------------------------------------------------------------------------
// Wraps St.PageFlip (the "page-flip" library, MIT licensed, successor of
// StPageFlip) and feeds it live PDF.js canvases instead of pre-baked images.
//
// Only a small "render window" around the current spread is ever rasterized:
//   previous page, current page, next page, and two pages ahead.
// Everything else is torn down (canvas cleared + shrunk to 0x0, PDF.js page
// proxy released) so memory stays flat no matter how long the issue is.
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
    this.itemEls = []; // index 0 = front cover, last = back cover
    this.canvasByPage = new Map(); // pdfPageNumber -> canvas
    this.renderedPages = new Set();
    this._zoomScale = 1;
    this._resizeTimer = null;
    this._zoomTimer = null;
    this._destroyed = false;

    this._onResize = this._onResize.bind(this);
    window.addEventListener('resize', this._onResize);
  }

  /** item index 1..numPdfPages map 1:1 to PDF page numbers. 0 and last are covers. */
  _itemIndexToPdfPage(itemIndex) {
    if (itemIndex < 1 || itemIndex > this.numPdfPages) return null;
    return itemIndex;
  }

  async loadDocument(renderer, { title, issueLabel } = {}) {
    this.renderer = renderer;
    this.numPdfPages = renderer.numPages;
    this.el.innerHTML = '';
    this.itemEls = [];
    this.canvasByPage.clear();
    this.renderedPages.clear();

    // page-flip's own destroy() removes its container element from the DOM
    // (`this.block.remove()`), so we can't hand it the same persistent node
    // across issue switches — it would be detached (and 0x0) on the next
    // load. Give every load a fresh, disposable mount div instead.
    const mount = document.createElement('div');
    mount.className = 'flipbook-mount';
    this.el.appendChild(mount);
    this.mountEl = mount;

    const frag = document.createDocumentFragment();

    // --- front hard cover -------------------------------------------------
    const front = this._buildCover('front', title, issueLabel);
    frag.appendChild(front);
    this.itemEls.push(front);

    // --- one element per live PDF page ------------------------------------
    for (let p = 1; p <= this.numPdfPages; p++) {
      const pageEl = document.createElement('div');
      pageEl.className = 'page';
      pageEl.dataset.pageNumber = String(p);

      const inner = document.createElement('div');
      inner.className = 'page-canvas-wrap';
      const canvas = document.createElement('canvas');
      canvas.className = 'page-canvas';
      inner.appendChild(canvas);
      pageEl.appendChild(inner);

      const num = document.createElement('div');
      num.className = 'page-folio';
      num.textContent = String(p);
      pageEl.appendChild(num);

      this.canvasByPage.set(p, canvas);
      frag.appendChild(pageEl);
      this.itemEls.push(pageEl);
    }

    // --- back hard cover ----------------------------------------------------
    const back = this._buildCover('back', title, issueLabel);
    frag.appendChild(back);
    this.itemEls.push(back);

    // Note: no need to attach `frag` anywhere — page-flip's loadFromHTML()
    // moves each item element into its own internal wrapper inside `mount`.

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

  _buildCover(kind, title, issueLabel) {
    const el = document.createElement('div');
    el.className = `page page-cover page-cover--${kind}`;
    el.dataset.density = 'hard';
    el.setAttribute('data-density', 'hard');
    el.innerHTML = `
      <div class="cover-content">
        <div class="cover-rule"></div>
        <div class="cover-title">${title || 'The Aleph Telegram'}</div>
        <div class="cover-issue">${kind === 'front' ? (issueLabel || '') : 'fin.'}</div>
        <div class="cover-rule"></div>
      </div>
    `;
    return el;
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
    const canvas = this.canvasByPage.get(pageNumber);
    if (!canvas || !this.renderer) return;
    const wrap = canvas.parentElement;
    const cssWidth = wrap.clientWidth || canvas.width || 400;
    const cssHeight = wrap.clientHeight || canvas.height || 560;
    if (cssWidth === 0 || cssHeight === 0) return;
    try {
      await this.renderer.renderPageToCanvas(pageNumber, canvas, cssWidth, cssHeight, extraScale);
      this.renderedPages.add(pageNumber);
      canvas.classList.add('is-rendered');
    } catch (err) {
      // eslint-disable-next-line no-console
      console.warn(`Failed to render page ${pageNumber}`, err);
    }
  }

  _teardownPage(pageNumber) {
    this.renderer.destroyPage(pageNumber);
    const canvas = this.canvasByPage.get(pageNumber);
    if (canvas) {
      const ctx = canvas.getContext('2d');
      if (ctx) ctx.clearRect(0, 0, canvas.width, canvas.height);
      canvas.width = 0;
      canvas.height = 0;
      canvas.classList.remove('is-rendered');
    }
    this.renderedPages.delete(pageNumber);
  }

  // --- navigation ----------------------------------------------------------
  next() { if (this.pageFlip) this.pageFlip.flipNext(); }
  prev() { if (this.pageFlip) this.pageFlip.flipPrev(); }
  goToItem(index) { if (this.pageFlip) this.pageFlip.turnToPage(index); }
  goToPdfPage(pdfPageNumber) { if (this.pageFlip) this.pageFlip.turnToPage(pdfPageNumber); }

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
    this.el.innerHTML = '';
  }
}
