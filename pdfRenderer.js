// pdfRenderer.js
// ---------------------------------------------------------------------------
// Thin wrapper around PDF.js. The PDF file is the single source of truth.
// Nothing is ever rasterized into a stored PNG/JPEG — each page is rendered
// straight into a live <canvas> at request time, at full devicePixelRatio,
// and can be torn down again once it scrolls out of the "keep warm" window.
// ---------------------------------------------------------------------------

import * as pdfjsLib from './lib/pdf.min.mjs';

pdfjsLib.GlobalWorkerOptions.workerSrc = new URL('./lib/pdf.worker.min.mjs', import.meta.url).href;

// Cap how sharp we go so a 6000x8000 4K request doesn't melt a phone.
const MAX_RENDER_SCALE = 3.5;

export class PDFRenderer {
  /**
   * @param {string} url Path to the PDF (source of truth, never converted).
   */
  constructor(url) {
    this.url = url;
    this.pdfDoc = null;
    this.numPages = 0;
    this._pageProxyCache = new Map(); // pageNumber -> Promise<PDFPageProxy>
    this._renderTasks = new Map(); // pageNumber -> {task, token}
    this._baseViewport = null; // viewport at scale 1 for page 1, used for aspect ratio
  }

  async load(onProgress) {
    const loadingTask = pdfjsLib.getDocument({
      url: this.url,
      // Keep memory reasonable — we don't need font/stream caching beyond one doc.
      disableAutoFetch: false,
      disableStream: false,
    });
    if (onProgress) {
      loadingTask.onProgress = (p) => {
        if (p && p.total) onProgress(p.loaded / p.total);
      };
    }
    this.pdfDoc = await loadingTask.promise;
    this.numPages = this.pdfDoc.numPages;
    const firstPage = await this._getPage(1);
    this._baseViewport = firstPage.getViewport({ scale: 1 });
    return this.numPages;
  }

  /** Intrinsic width/height ratio of the document, assumed uniform across pages. */
  get aspectRatio() {
    if (!this._baseViewport) return 0.75;
    return this._baseViewport.width / this._baseViewport.height;
  }

  async _getPage(pageNumber) {
    if (!this._pageProxyCache.has(pageNumber)) {
      this._pageProxyCache.set(pageNumber, this.pdfDoc.getPage(pageNumber));
    }
    return this._pageProxyCache.get(pageNumber);
  }

  /**
   * Render a page into the given canvas at CSS size (cssWidth x cssHeight),
   * scaled up for devicePixelRatio so text stays crisp at any zoom level.
   * Cancels any in-flight render for the same canvas/page first.
   */
  async renderPageToCanvas(pageNumber, canvas, cssWidth, cssHeight, extraScale = 1) {
    if (pageNumber < 1 || pageNumber > this.numPages) return;

    // Cancel a stale render task targeting this page, if any.
    this.cancelRender(pageNumber);

    const page = await this._getPage(pageNumber);
    const dpr = Math.min(window.devicePixelRatio || 1, MAX_RENDER_SCALE) * extraScale;

    const unscaledViewport = page.getViewport({ scale: 1 });
    const scale = (cssWidth / unscaledViewport.width) * dpr;
    const viewport = page.getViewport({ scale });

    canvas.width = Math.ceil(viewport.width);
    canvas.height = Math.ceil(viewport.height);
    canvas.style.width = `${cssWidth}px`;
    canvas.style.height = `${cssHeight}px`;

    const ctx = canvas.getContext('2d', { alpha: false });
    const token = Symbol('render');
    const renderTask = page.render({ canvasContext: ctx, viewport });
    this._renderTasks.set(pageNumber, { task: renderTask, token });

    try {
      await renderTask.promise;
    } catch (err) {
      if (err && err.name === 'RenderingCancelledException') return;
      throw err;
    } finally {
      const entry = this._renderTasks.get(pageNumber);
      if (entry && entry.token === token) this._renderTasks.delete(pageNumber);
    }
  }

  cancelRender(pageNumber) {
    const entry = this._renderTasks.get(pageNumber);
    if (entry) {
      try { entry.task.cancel(); } catch (_) { /* no-op */ }
      this._renderTasks.delete(pageNumber);
    }
  }

  /** Drop cached page proxy + any render state so memory is freed. */
  destroyPage(pageNumber) {
    this.cancelRender(pageNumber);
    const proxyPromise = this._pageProxyCache.get(pageNumber);
    if (proxyPromise) {
      proxyPromise.then((p) => p && p.cleanup && p.cleanup()).catch(() => {});
      this._pageProxyCache.delete(pageNumber);
    }
  }

  destroy() {
    for (const pn of Array.from(this._renderTasks.keys())) this.cancelRender(pn);
    this._pageProxyCache.clear();
    if (this.pdfDoc) {
      this.pdfDoc.destroy();
      this.pdfDoc = null;
    }
  }
}
