// app.js
// ---------------------------------------------------------------------------
// Glue code: loads issues.json, wires the issue selector, boots the
// PDFRenderer + Flipbook for the selected issue, and hooks up all the reader
// chrome (nav buttons, keyboard, wheel, zoom, fullscreen, download, bookmarks).
// ---------------------------------------------------------------------------

import { PDFRenderer } from './pdfRenderer.js';
import { Flipbook } from './flipbook.js';
import * as ui from './ui.js';

const stage = document.getElementById('stage');
const flipbookEl = document.getElementById('flipbook');
const flipbookWrap = document.getElementById('flipbookWrap');
const issueSelect = document.getElementById('issueSelect');
const downloadBtn = document.getElementById('downloadBtn');
const fullscreenBtn = document.getElementById('fullscreenBtn');
const prevBtn = document.getElementById('prevBtn');
const nextBtn = document.getElementById('nextBtn');
const pageIndicator = document.getElementById('pageIndicator');
const zoomInBtn = document.getElementById('zoomInBtn');
const zoomOutBtn = document.getElementById('zoomOutBtn');
const zoomReadout = document.getElementById('zoomReadout');
const retryBtn = document.getElementById('retryBtn');
const resumeToast = document.getElementById('resumeToast');
const resumeText = document.getElementById('resumeText');
const resumeBtn = document.getElementById('resumeBtn');
const dismissResumeBtn = document.getElementById('dismissResumeBtn');

const ZOOM_MIN = 1;
const ZOOM_MAX = 2.5;
const ZOOM_STEP = 0.25;
const ZOOM_DOUBLE_CLICK = 1.8;

let issues = [];
let currentIssue = null;
let renderer = null;
let flipbook = null;
let zoomScale = 1;
let wheelCooldown = false;

async function boot() {
  try {
    issues = await loadIssueList();
  } catch (err) {
    ui.showError(stage, 'Could not load the issue list. Check issues.json and try again.');
    console.error(err);
    return;
  }

  if (!issues.length) {
    ui.showError(stage, 'No issues are configured yet. Add entries to issues.json.');
    return;
  }

  const params = new URLSearchParams(location.search);
  const requested = params.get('issue');
  const startId = issues.some((i) => i.id === requested) ? requested : issues[0].id;

  ui.populateIssueSelect(issueSelect, issues, startId);
  await openIssue(startId);
}

async function loadIssueList() {
  const res = await fetch('issues.json', { cache: 'no-store' });
  if (!res.ok) throw new Error(`issues.json responded ${res.status}`);
  return res.json();
}

async function openIssue(issueId) {
  const issue = issues.find((i) => i.id === issueId);
  if (!issue) return;
  currentIssue = issue;

  ui.hideError(stage);
  ui.showSpinner(stage, 'Setting the type\u2026');
  resumeToast.classList.add('is-hidden');

  if (flipbook) {
    flipbook.destroy();
    flipbook = null;
  }
  if (renderer) {
    renderer.destroy();
    renderer = null;
  }
  zoomScale = 1;
  applyZoom(zoomScale, 0.5, 0.5);

  downloadBtn.href = issue.file;
  downloadBtn.setAttribute('download', deriveFilename(issue.file));

  try {
    renderer = new PDFRenderer(issue.file);
    await renderer.load((frac) => {
      ui.showSpinner(stage, `Setting the type\u2026 ${Math.round(frac * 100)}%`);
    });

    flipbook = new Flipbook(flipbookEl, {
      onReady: () => {
        ui.hideSpinner(stage);
        maybeOfferResume(issue.id);
      },
      onPageChange: ({ pdfPage, numPdfPages }) => {
        ui.updatePageIndicator(pageIndicator, pdfPage, numPdfPages);
        ui.setPrevNextDisabled(prevBtn, nextBtn, pdfPage || 1, numPdfPages || 1);
        if (pdfPage) ui.Bookmarks.save(issue.id, pdfPage);
      },
    });

    await flipbook.loadDocument(renderer, {
      title: 'The Aleph Telegram',
      issueLabel: issue.title,
    });
  } catch (err) {
    console.error(err);
    ui.hideSpinner(stage);
    ui.showError(stage, `Couldn't open "${issue.title || issue.id}". The PDF may be missing or corrupt.`);
  }
}

function deriveFilename(path) {
  const parts = path.split('/');
  return parts[parts.length - 1] || 'issue.pdf';
}

function maybeOfferResume(issueId) {
  const saved = ui.Bookmarks.load(issueId);
  if (saved && saved > 1) {
    resumeText.textContent = `You left off on page ${saved}.`;
    resumeToast.classList.remove('is-hidden');
    resumeBtn.onclick = () => {
      flipbook.goToPdfPage(saved);
      resumeToast.classList.add('is-hidden');
    };
    dismissResumeBtn.onclick = () => resumeToast.classList.add('is-hidden');
  }
}

// --- issue selector ----------------------------------------------------------
issueSelect.addEventListener('change', () => openIssue(issueSelect.value));
retryBtn.addEventListener('click', () => currentIssue && openIssue(currentIssue.id));

// --- nav buttons ---------------------------------------------------------------
prevBtn.addEventListener('click', () => flipbook && flipbook.prev());
nextBtn.addEventListener('click', () => flipbook && flipbook.next());

// --- keyboard --------------------------------------------------------------
window.addEventListener('keydown', (e) => {
  const tag = (document.activeElement && document.activeElement.tagName) || '';
  if (tag === 'SELECT' || tag === 'INPUT' || tag === 'TEXTAREA') return;
  if (!flipbook) return;

  switch (e.key) {
    case 'ArrowRight':
      flipbook.next();
      break;
    case 'ArrowLeft':
      flipbook.prev();
      break;
    case '+':
    case '=':
      e.preventDefault();
      setZoom(zoomScale + ZOOM_STEP, 0.5, 0.5);
      break;
    case '-':
      e.preventDefault();
      setZoom(zoomScale - ZOOM_STEP, 0.5, 0.5);
      break;
    case '0':
      setZoom(1, 0.5, 0.5);
      break;
    case 'f':
    case 'F':
      ui.toggleFullscreen(stage);
      break;
    case 'Escape':
      if (zoomScale !== 1) setZoom(1, 0.5, 0.5);
      break;
    default:
      break;
  }
});

// --- mouse wheel: page turn when at 100%, native scroll/pan when zoomed ------
stage.addEventListener('wheel', (e) => {
  if (!flipbook) return;
  if (zoomScale > 1) return; // let the browser pan the zoomed spread
  e.preventDefault();
  if (wheelCooldown) return;
  wheelCooldown = true;
  setTimeout(() => { wheelCooldown = false; }, 550);
  if (e.deltaY > 0 || e.deltaX > 0) flipbook.next();
  else if (e.deltaY < 0 || e.deltaX < 0) flipbook.prev();
}, { passive: false });

// --- double-click to zoom toward the click point -----------------------------
flipbookWrap.addEventListener('dblclick', (e) => {
  const rect = flipbookWrap.getBoundingClientRect();
  const originX = (e.clientX - rect.left) / rect.width;
  const originY = (e.clientY - rect.top) / rect.height;
  const target = zoomScale > 1 ? 1 : ZOOM_DOUBLE_CLICK;
  setZoom(target, originX, originY);
});

// --- zoom buttons --------------------------------------------------------------
zoomInBtn.addEventListener('click', () => setZoom(zoomScale + ZOOM_STEP, 0.5, 0.5));
zoomOutBtn.addEventListener('click', () => setZoom(zoomScale - ZOOM_STEP, 0.5, 0.5));

function setZoom(scale, originX = 0.5, originY = 0.5) {
  zoomScale = Math.min(ZOOM_MAX, Math.max(ZOOM_MIN, Math.round(scale * 100) / 100));
  applyZoom(zoomScale, originX, originY);
  ui.updateZoomReadout(zoomReadout, zoomScale);
  if (flipbook) flipbook.setZoomScale(zoomScale);
}

function applyZoom(scale, originX, originY) {
  flipbookWrap.style.transformOrigin = `${originX * 100}% ${originY * 100}%`;
  flipbookWrap.style.transform = `scale(${scale})`;
  stage.classList.toggle('is-zoomed', scale > 1);
}

// --- fullscreen ----------------------------------------------------------------
fullscreenBtn.addEventListener('click', () => ui.toggleFullscreen(stage));

boot();
