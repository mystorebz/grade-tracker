// assets/js/lessons/doc-present.js — Document Present Mode (local, read-only)
//
// The Document counterpart of slideshow.js: a full-screen, read-only view of
// the lesson's US Letter page for a projector / screen share. Renders the HTML
// it is GIVEN (the editor passes its current, possibly unsaved content) with
// the student viewer's renderer (document.js createDocumentViewer), so the
// page looks exactly as students see it. Nothing is read from or written to
// Firestore; no live session is created.
//
//   const p = openDocumentPresentation({ html, title, startBlock, onClose });
//   p.close();
//
// <dialog class="doc-present"> is shown modal (top layer, above Focus Mode)
// and asks for browser full screen. The page scrolls; the Exit button is
// always visible. Keys: Esc exit · + / − zoom · 0 fit width · F full screen ·
// arrows / Space / Page keys / Home / End scroll (native, on the page).
// Leaving browser full screen (the browser's own Esc) also ends Present Mode.

import { createDocumentViewer } from './document.js';

const STYLE_ID = 'doc-present-styles';
const PAGE_W = 816;   // .doc-page width (8.5in @ 96dpi)
const ZOOM_MIN = 0.5, ZOOM_MAX = 3, ZOOM_STEP = 0.1;
const CSS = `
dialog.doc-present { position: fixed; inset: 0; width: 100vw; height: 100vh; max-width: none; max-height: none; margin: 0; padding: 0; border: 0;
  background: #3c4043; overflow: hidden; outline: none; font-family: 'DM Sans', sans-serif; }
dialog.doc-present::backdrop { background: #3c4043; }
.dp-scroll { position: absolute; inset: 0; overflow: auto; outline: none; overscroll-behavior: contain; }
.dp-zoom { zoom: var(--dp-zoom, 1); padding: 32px 16px 96px; }
.dp-zoom .doc-page.dp-page { margin: 0 auto; box-shadow: 0 2px 6px rgba(0,0,0,.3), 0 12px 40px rgba(0,0,0,.35); }
.dp-loading { color: #cbd5e1; text-align: center; padding: 80px 0; font-size: 15px; font-weight: 600; }
.dp-bar { position: absolute; top: 14px; right: 18px; display: flex; align-items: center; gap: 6px; z-index: 2; }
.dp-tools { display: flex; align-items: center; gap: 2px; padding: 5px; border-radius: 12px; background: rgba(13,31,53,.82); box-shadow: 0 8px 24px rgba(0,0,0,.35);
  opacity: 0; transition: opacity .25s; }
dialog.doc-present.dp-show-ui .dp-tools, .dp-tools:hover, .dp-tools:focus-within { opacity: 1; }
.dp-tools button { height: 34px; min-width: 34px; padding: 0 8px; border-radius: 8px; border: 0; background: transparent; color: #fff; font-size: 14px; font-weight: 700;
  cursor: pointer; display: inline-flex; align-items: center; justify-content: center; gap: 6px; }
.dp-tools button:hover { background: rgba(255,255,255,.14); }
.dp-zoomv { min-width: 52px; text-align: center; font-size: 12.5px; font-weight: 800; font-variant-numeric: tabular-nums; color: #dbeafe; }
.dp-sep { width: 1px; height: 20px; background: rgba(255,255,255,.18); margin: 0 3px; }
.dp-title { max-width: 32vw; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; color: #e2e8f0; font-size: 13px; font-weight: 700; padding: 0 8px 0 6px; }
.dp-exit { height: 40px; padding: 0 16px; border-radius: 10px; border: 0; background: #fff; color: #0d1f35; font-size: 14px; font-weight: 800; cursor: pointer;
  display: inline-flex; align-items: center; gap: 8px; box-shadow: 0 8px 24px rgba(0,0,0,.35); }
.dp-exit:hover { background: #eef4ff; color: #2563eb; }
.dp-tools button:focus-visible, .dp-exit:focus-visible { outline: 2px solid #93c5fd; outline-offset: 2px; }
@media (max-width: 640px) { .dp-title { display: none; } }
`;

function ensureStyles() {
    if (document.getElementById(STYLE_ID)) return;
    const st = document.createElement('style');
    st.id = STYLE_ID;
    st.textContent = CSS;
    document.head.appendChild(st);
}

const esc = (v) => String(v ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#039;' }[c]));
const clamp = (v) => Math.min(ZOOM_MAX, Math.max(ZOOM_MIN, Math.round(v * 100) / 100));

export function openDocumentPresentation({ html = '', title = '', startBlock = 0, onClose = null } = {}) {
    ensureStyles();
    const opener = document.activeElement;
    const dlg = document.createElement('dialog');
    dlg.className = 'doc-present';
    dlg.setAttribute('aria-label', `Presenting ${title || 'lesson'}`);
    dlg.innerHTML = `
        <div class="dp-scroll" tabindex="-1" aria-label="Lesson page"><div class="dp-zoom"><div class="doc-page dp-page"><p class="dp-loading">Loading…</p></div></div></div>
        <div class="dp-bar">
            <div class="dp-tools" role="toolbar" aria-label="Present Mode">
                ${title ? `<span class="dp-title" title="${esc(title)}">${esc(title)}</span><span class="dp-sep"></span>` : ''}
                <button type="button" data-dp="out" title="Zoom out (−)" aria-label="Zoom out"><i class="fa-solid fa-minus"></i></button>
                <span class="dp-zoomv" data-dp-zoom aria-live="polite">100%</span>
                <button type="button" data-dp="in" title="Zoom in (+)" aria-label="Zoom in"><i class="fa-solid fa-plus"></i></button>
                <button type="button" data-dp="fit" title="Fit page width (0)">Fit</button>
                <span class="dp-sep"></span>
                <button type="button" data-dp="fullscreen" title="Full screen (F)" aria-label="Full screen"><i class="fa-solid fa-expand"></i></button>
            </div>
            <button type="button" class="dp-exit" data-dp="close" title="Exit Present Mode (Esc)"><i class="fa-solid fa-xmark"></i>Exit</button>
        </div>`;
    document.body.appendChild(dlg);
    const scroller = dlg.querySelector('.dp-scroll');
    const zoomEl = dlg.querySelector('.dp-zoom');
    const pageEl = dlg.querySelector('.dp-page');
    const zoomLabel = dlg.querySelector('[data-dp-zoom]');
    let viewer = null;
    let closed = false;
    let zoom = 1;
    let uiTimer = 0;

    // fit: the page fills the width (minus a margin), up to 2× on big projectors
    const fitZoom = () => clamp(Math.min(2, (scroller.clientWidth - 48) / (PAGE_W + 32)));
    function setZoom(z, { keepPosition = true } = {}) {
        const next = clamp(z);
        const ratio = keepPosition && scroller.scrollHeight > scroller.clientHeight ? (scroller.scrollTop + scroller.clientHeight / 2) / scroller.scrollHeight : null;
        zoom = next;
        zoomEl.style.setProperty('--dp-zoom', String(next));
        zoomLabel.textContent = `${Math.round(next * 100)}%`;
        if (ratio !== null) scroller.scrollTop = ratio * scroller.scrollHeight - scroller.clientHeight / 2;
    }

    function pokeUi() {
        dlg.classList.add('dp-show-ui');
        clearTimeout(uiTimer);
        uiTimer = setTimeout(() => dlg.classList.remove('dp-show-ui'), 2200);
    }

    function toggleFullscreen() {
        if (document.fullscreenElement === dlg) document.exitFullscreen?.().catch(() => {});
        else dlg.requestFullscreen?.().catch(() => {});
    }
    function updateFsIcon() {
        const i = dlg.querySelector('[data-dp="fullscreen"] i');
        if (i) i.className = `fa-solid ${document.fullscreenElement === dlg ? 'fa-compress' : 'fa-expand'}`;
    }

    function onKey(e) {
        if (e.defaultPrevented) return;
        const k = e.key;
        if (k === 'Escape') { e.preventDefault(); close(); return; }
        if (e.ctrlKey || e.metaKey || e.altKey) return;
        if (e.target.closest && e.target.closest('iframe, input, textarea, select')) return;
        if (k === '+' || k === '=') { e.preventDefault(); setZoom(zoom + ZOOM_STEP); pokeUi(); }
        else if (k === '-' || k === '_') { e.preventDefault(); setZoom(zoom - ZOOM_STEP); pokeUi(); }
        else if (k === '0') { e.preventDefault(); setZoom(fitZoom()); pokeUi(); }
        else if (k === 'f' || k === 'F') { e.preventDefault(); toggleFullscreen(); }
        // scrolling keys reach the page even when a toolbar button has focus
        else if (['ArrowDown', 'ArrowUp', 'PageDown', 'PageUp', 'Home', 'End', ' '].includes(k) && !scroller.contains(e.target)) {
            if (k === ' ' && e.target.closest && e.target.closest('button')) return; // Space activates the focused button
            scroller.focus({ preventScroll: true });
        }
    }

    function onClick(e) {
        const b = e.target.closest('[data-dp]');
        if (!b) return;
        const a = b.dataset.dp;
        if (a === 'close') close();
        else if (a === 'in') setZoom(zoom + ZOOM_STEP);
        else if (a === 'out') setZoom(zoom - ZOOM_STEP);
        else if (a === 'fit') setZoom(fitZoom());
        else if (a === 'fullscreen') toggleFullscreen();
    }

    let wasFullscreen = false;
    function onFullscreenChange() {
        updateFsIcon();
        if (document.fullscreenElement === dlg) { wasFullscreen = true; return; }
        // the browser's own Esc leaves full screen first — end Present Mode with it
        if (wasFullscreen && !closed) close();
    }
    const onCancel = (e) => { e.preventDefault(); close(); }; // native dialog Esc
    let resizeRaf = 0;
    const onResize = () => { cancelAnimationFrame(resizeRaf); resizeRaf = requestAnimationFrame(() => { if (!userZoomed) setZoom(fitZoom()); }); };
    let userZoomed = false;
    dlg.addEventListener('click', (e) => { if (e.target.closest('[data-dp="in"], [data-dp="out"]')) userZoomed = true; if (e.target.closest('[data-dp="fit"]')) userZoomed = false; }, true);
    dlg.addEventListener('keydown', (e) => { if (['+', '=', '-', '_'].includes(e.key)) userZoomed = true; if (e.key === '0') userZoomed = false; }, true);

    function close() {
        if (closed) return;
        closed = true;
        clearTimeout(uiTimer);
        cancelAnimationFrame(resizeRaf);
        dlg.removeEventListener('keydown', onKey);
        dlg.removeEventListener('click', onClick);
        dlg.removeEventListener('cancel', onCancel);
        dlg.removeEventListener('mousemove', pokeUi);
        document.removeEventListener('fullscreenchange', onFullscreenChange);
        window.removeEventListener('resize', onResize);
        if (document.fullscreenElement === dlg) document.exitFullscreen?.().catch(() => {});
        try { viewer && viewer.destroy(); } catch (e) { /* gone */ }
        viewer = null;
        try { dlg.close(); } catch (e) { /* not open */ }
        dlg.remove();
        try { opener && opener.focus && opener.focus({ preventScroll: true }); } catch (e) { /* gone */ }
        try { onClose && onClose(); } catch (e) { console.error(e); }
    }

    dlg.addEventListener('keydown', onKey);
    dlg.addEventListener('click', onClick);
    dlg.addEventListener('cancel', onCancel);
    dlg.addEventListener('mousemove', pokeUi);
    document.addEventListener('fullscreenchange', onFullscreenChange);
    window.addEventListener('resize', onResize);

    dlg.showModal();
    // must run inside the click that opened Present Mode (user activation)
    dlg.requestFullscreen?.().catch(() => { /* blocked or unsupported: the modal still covers the window */ });
    setZoom(fitZoom(), { keepPosition: false });
    scroller.focus({ preventScroll: true });
    pokeUi();

    // mount after the dialog is up (the renderer loads asynchronously)
    createDocumentViewer({ element: pageEl, html, lazyRoot: scroller, renderAssignment: (id, t) => `<i class="fa-solid fa-clipboard-check"></i><span>${esc(t)}</span>` })
        .then((v) => {
            if (closed) { v.destroy(); return; }
            viewer = v;
            setZoom(fitZoom(), { keepPosition: false });
            // start where the teacher was in the editor (same top-level block)
            const block = startBlock > 0 ? v.editor.view.dom.children[startBlock] : null;
            if (block) scroller.scrollTop += block.getBoundingClientRect().top - scroller.getBoundingClientRect().top - 24;
        })
        .catch((e) => {
            console.error('[Present Mode] could not render the document:', e);
            if (!closed) pageEl.innerHTML = '<p class="dp-loading">This document could not be displayed.</p>';
        });

    return {
        close,
        el: dlg,
        zoom: () => zoom,
        setZoom: (z) => { userZoomed = true; setZoom(z); },
    };
}
