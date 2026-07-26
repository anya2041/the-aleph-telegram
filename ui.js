// ui.js
// ---------------------------------------------------------------------------
// Small, dependency-free UI helpers: spinner, toast, issue <select> population,
// the "ticket stub" page indicator, zoom readout, and fullscreen toggling.
// No PDF or page-flip logic lives here — app.js wires this to flipbook.js.
// ---------------------------------------------------------------------------

export function showSpinner(root, message = 'Setting the type\u2026') {
  const el = root.querySelector('.loading-overlay');
  if (!el) return;
  el.querySelector('.loading-message').textContent = message;
  el.classList.remove('is-hidden');
}

export function hideSpinner(root) {
  const el = root.querySelector('.loading-overlay');
  if (el) el.classList.add('is-hidden');
}

export function showError(root, message) {
  const el = root.querySelector('.error-banner');
  if (!el) return;
  el.querySelector('.error-banner__message').textContent = message;
  el.classList.remove('is-hidden');
}

export function hideError(root) {
  const el = root.querySelector('.error-banner');
  if (el) el.classList.add('is-hidden');
}

/**
 * Populate the issue <select>. issues: [{id, title, file, ...}]
 */
export function populateIssueSelect(selectEl, issues, selectedId) {
  selectEl.innerHTML = '';
  for (const issue of issues) {
    const opt = document.createElement('option');
    opt.value = issue.id;
    opt.textContent = issue.title || issue.id;
    if (issue.id === selectedId) opt.selected = true;
    selectEl.appendChild(opt);
  }
}

/** Updates the "PAGE 04 / 32" ticket stub. Shows COVER when on the hard covers. */
export function updatePageIndicator(el, pdfPage, numPdfPages) {
  if (!el) return;
  if (!pdfPage) {
    el.textContent = 'COVER';
    return;
  }
  const safePage = Math.max(1, Math.min(pdfPage, numPdfPages || 1));
  el.textContent = `PAGE ${String(safePage).padStart(2, '0')} / ${String(numPdfPages || 0).padStart(2, '0')}`;
}

export function updateZoomReadout(el, scale) {
  if (!el) return;
  el.textContent = `${Math.round(scale * 100)}%`;
}

export function toggleFullscreen(target) {
  if (!document.fullscreenElement) {
    (target.requestFullscreen || target.webkitRequestFullscreen || function () {}).call(target);
  } else {
    (document.exitFullscreen || document.webkitExitFullscreen || function () {}).call(document);
  }
}

export function setPrevNextDisabled(prevBtn, nextBtn, pdfPage, numPdfPages) {
  if (prevBtn) prevBtn.disabled = pdfPage <= 1;
  if (nextBtn) nextBtn.disabled = pdfPage >= numPdfPages;
}

/** Debounce helper shared by app.js for wheel navigation etc. */
export function debounce(fn, wait) {
  let t = null;
  return (...args) => {
    clearTimeout(t);
    t = setTimeout(() => fn(...args), wait);
  };
}

/** Simple last-read-page bookmarking, scoped per issue id. */
export const Bookmarks = {
  key(issueId) { return `aleph-telegram:bookmark:${issueId}`; },
  save(issueId, pdfPage) {
    try { localStorage.setItem(this.key(issueId), String(pdfPage)); } catch (_) { /* storage disabled */ }
  },
  load(issueId) {
    try {
      const v = localStorage.getItem(this.key(issueId));
      return v ? parseInt(v, 10) : null;
    } catch (_) { return null; }
  },
};
