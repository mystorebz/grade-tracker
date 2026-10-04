// assets/js/lessons/slideshow.js — local, in-memory slideshow (no live session)
//
// For a teacher presenting from their own screen (projector / screen share).
// Renders the slides it is GIVEN — the editor passes its in-memory canvas
// store, so unsaved draft edits show — through the shared renderer. Nothing
// is read from or written to Firestore; no live_sessions document is created.
//
//   const show = openSlideshow({ slides, theme, startIndex, title, renderContent });
//   show.close();
//
// <dialog class="slideshow-modal"> is shown modal (top layer, above Focus
// Mode) and asks for browser full screen. Keys (scoped to the dialog):
//   → Space Enter PageDown ↓ : next      ← PageUp ↑ Backspace : previous
//   Home / End : first / last            Esc : close (destroys the renderer)
// Leaving browser full screen (the browser's own Esc) also ends the show.
// Slide transitions ('fade' | 'slide' | 'zoom') come from slideTransition().

import { mountStage, renderSlide, slideTransition } from './canvas/renderer.js';

const STYLE_ID = 'slideshow-styles';
const CSS = `
dialog.slideshow-modal { position: fixed; inset: 0; width: 100vw; height: 100vh; max-width: none; max-height: none; margin: 0; padding: 0; border: 0;
  background: #000; color: #fff; overflow: hidden; outline: none; }
dialog.slideshow-modal::backdrop { background: #000; }
.ss-host { position: absolute; inset: 0; overflow: hidden; }
.ss-layer { position: absolute; inset: 0; display: flex; align-items: center; justify-content: center; will-change: opacity, transform; }
.ss-frame { width: min(100vw, calc(100vh * 16 / 9)); }
.ss-frame .cv-viewport { box-shadow: 0 0 0 1px rgba(255,255,255,.04); }
.ss-frame .cv-obj-content { overflow: hidden; }
.ss-frame .cv-obj-video iframe, .ss-frame .cv-obj-embed iframe { pointer-events: auto; }
.ss-note { position: absolute; inset: 0; display: flex; flex-direction: column; align-items: center; justify-content: center; text-align: center; gap: 18px; padding: 80px 140px; color: #0d1f35; font-family: 'DM Sans', sans-serif; }
.ss-note h2 { font-size: 64px; font-weight: 800; margin: 0; line-height: 1.15; }
.ss-note p { font-size: 32px; font-weight: 500; color: #374f6b; margin: 0; line-height: 1.45; white-space: pre-wrap; }
.ss-note .ss-badge { font-size: 22px; font-weight: 800; letter-spacing: .08em; text-transform: uppercase; color: #0f766e; background: #f0fdfa; border: 2px solid #99f6e4; border-radius: 999px; padding: 8px 22px; }
.ss-bar { position: absolute; left: 50%; bottom: 22px; transform: translateX(-50%); display: flex; align-items: center; gap: 4px; padding: 6px; border-radius: 12px;
  background: rgba(13,31,53,.82); box-shadow: 0 8px 24px rgba(0,0,0,.35); opacity: 0; transition: opacity .25s; font-family: 'DM Sans', sans-serif; }
dialog.slideshow-modal.ss-show-ui .ss-bar, .ss-bar:focus-within, .ss-bar:hover { opacity: 1; }
dialog.slideshow-modal:not(.ss-show-ui) { cursor: none; }
.ss-bar button { width: 38px; height: 38px; border-radius: 8px; border: 0; background: transparent; color: #fff; font-size: 15px; cursor: pointer; display: inline-flex; align-items: center; justify-content: center; }
.ss-bar button:hover:not(:disabled) { background: rgba(255,255,255,.14); }
.ss-bar button:disabled { opacity: .35; cursor: default; }
.ss-bar button:focus-visible { outline: 2px solid #93c5fd; outline-offset: 1px; }
.ss-count { min-width: 74px; text-align: center; font-size: 13px; font-weight: 800; font-variant-numeric: tabular-nums; color: #dbeafe; }
.ss-sep { width: 1px; height: 22px; background: rgba(255,255,255,.18); margin: 0 4px; }
`;

function ensureStyles() {
    if (document.getElementById(STYLE_ID)) return;
    const st = document.createElement('style');
    st.id = STYLE_ID;
    st.textContent = CSS;
    document.head.appendChild(st);
}

const esc = (v) => String(v ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#039;' }[c]));
const reduceMotion = () => window.matchMedia && window.matchMedia('(prefers-reduced-motion: reduce)').matches;

const ENTER = {
    fade: [{ opacity: 0 }, { opacity: 1 }],
    slide: (dir) => [{ transform: `translateX(${dir > 0 ? 100 : -100}%)` }, { transform: 'translateX(0)' }],
    zoom: [{ opacity: 0, transform: 'scale(.92)' }, { opacity: 1, transform: 'scale(1)' }],
};
const LEAVE = {
    fade: [{ opacity: 1 }, { opacity: 0 }],
    slide: (dir) => [{ transform: 'translateX(0)' }, { transform: `translateX(${dir > 0 ? -100 : 100}%)` }],
    zoom: [{ opacity: 1 }, { opacity: 0 }],
};

export function openSlideshow({ slides = [], theme = 'general', startIndex = 0, title = '', renderContent = null, onClose = null } = {}) {
    ensureStyles();
    const list = (slides || []).filter(Boolean);
    let index = Math.min(Math.max(0, startIndex | 0), Math.max(0, list.length - 1));
    let layer = null;          // { el, handle }
    let closed = false;
    let uiTimer = 0;
    const opener = document.activeElement;

    const dlg = document.createElement('dialog');
    dlg.className = 'slideshow-modal ss-show-ui';
    dlg.setAttribute('aria-label', `Slideshow${title ? `: ${title}` : ''}`);
    dlg.setAttribute('aria-roledescription', 'slideshow');
    dlg.innerHTML = `
        <div class="ss-host" aria-live="polite"></div>
        <div class="ss-bar" role="toolbar" aria-label="Slideshow controls">
            <button type="button" data-ss="prev" title="Previous (←)" aria-label="Previous slide"><i class="fa-solid fa-chevron-left"></i></button>
            <span class="ss-count" data-ss-count></span>
            <button type="button" data-ss="next" title="Next (→ / Space)" aria-label="Next slide"><i class="fa-solid fa-chevron-right"></i></button>
            <span class="ss-sep"></span>
            <button type="button" data-ss="fullscreen" title="Full screen" aria-label="Toggle full screen"><i class="fa-solid fa-expand"></i></button>
            <button type="button" data-ss="close" title="Exit slideshow (Esc)" aria-label="Exit slideshow"><i class="fa-solid fa-xmark"></i></button>
        </div>`;
    document.body.appendChild(dlg);
    const host = dlg.querySelector('.ss-host');
    const countEl = dlg.querySelector('[data-ss-count]');

    function slideHtml(slide) {
        if (slide.kind === 'board') {
            const b = slide.board || {};
            return `<div class="ss-note"><span class="ss-badge">Collaborative board</span><h2>${esc(b.heading || 'Collaboration Board')}</h2>${b.instructions ? `<p>${esc(b.instructions)}</p>` : ''}<p style="font-size:24px;color:#6b84a0">Students post to this board during a live session.</p></div>`;
        }
        return `<div class="ss-note"><p>This slide can't be shown in the slideshow.</p></div>`;
    }

    function buildLayer(slide) {
        const el = document.createElement('div');
        el.className = 'ss-layer';
        const frame = document.createElement('div');
        frame.className = 'ss-frame';
        el.appendChild(frame);
        host.appendChild(el);
        const handle = mountStage(frame, { theme });
        if (slide.kind === 'canvas' || !slide.kind) {
            renderSlide(handle, slide, {
                mode: 'present',
                renderContent,
                emptyText: '',
                widgetContext: () => ({ state: 'idle', responses: [], mine: null, spotlight: null }),
            });
        } else {
            renderSlide(handle, { objects: [] }, { mode: 'present', emptyText: '' });
            handle.stage.insertAdjacentHTML('beforeend', slideHtml(slide));
        }
        el.setAttribute('aria-label', `Slide ${list.indexOf(slide) + 1} of ${list.length}`);
        return { el, handle };
    }

    function updateBar() {
        countEl.textContent = list.length ? `${index + 1} / ${list.length}` : '0 / 0';
        dlg.querySelector('[data-ss="prev"]').disabled = index <= 0;
        dlg.querySelector('[data-ss="next"]').disabled = index >= list.length - 1;
        const fs = dlg.querySelector('[data-ss="fullscreen"] i');
        if (fs) fs.className = `fa-solid ${document.fullscreenElement === dlg ? 'fa-compress' : 'fa-expand'}`;
    }

    function show(i, dir = 1) {
        if (closed || !list.length) { updateBar(); return; }
        index = Math.min(Math.max(0, i), list.length - 1);
        const slide = list[index];
        const next = buildLayer(slide);
        const prev = layer;
        layer = next;
        updateBar();
        if (!prev) return;
        const kind = slideTransition(slide);
        if (kind === 'none' || reduceMotion() || typeof next.el.animate !== 'function') { destroyLayer(prev); return; }
        const opts = { duration: kind === 'slide' ? 420 : 360, easing: 'cubic-bezier(.2,.7,.2,1)', fill: 'both' };
        const enter = typeof ENTER[kind] === 'function' ? ENTER[kind](dir) : ENTER[kind];
        const leave = typeof LEAVE[kind] === 'function' ? LEAVE[kind](dir) : LEAVE[kind];
        prev.el.animate(leave, opts);
        next.el.animate(enter, opts).finished.catch(() => {}).finally(() => destroyLayer(prev));
    }

    function destroyLayer(l) {
        if (!l) return;
        try { l.handle.destroy(); } catch (e) { /* gone */ }
        l.el.remove();
    }

    const go = (d) => {
        const target = index + d;
        if (target < 0 || target >= list.length) return;
        show(target, d);
    };

    function pokeUi() {
        dlg.classList.add('ss-show-ui');
        clearTimeout(uiTimer);
        uiTimer = setTimeout(() => dlg.classList.remove('ss-show-ui'), 2200);
    }

    function onKey(e) {
        if (e.defaultPrevented) return;
        const k = e.key;
        if (e.target.closest && e.target.closest('iframe, input, textarea, select')) return;
        if (k === 'ArrowRight' || k === ' ' || k === 'Enter' || k === 'PageDown' || k === 'ArrowDown') {
            if (k === 'Enter' && e.target.closest && e.target.closest('.ss-bar button')) return; // activate the focused control
            e.preventDefault(); go(1);
        } else if (k === 'ArrowLeft' || k === 'PageUp' || k === 'ArrowUp' || k === 'Backspace') { e.preventDefault(); go(-1); }
        else if (k === 'Home') { e.preventDefault(); show(0, -1); }
        else if (k === 'End') { e.preventDefault(); show(list.length - 1, 1); }
        else if (k === 'Escape') { e.preventDefault(); close(); }
    }

    function onClick(e) {
        const b = e.target.closest('[data-ss]');
        if (b) {
            const a = b.dataset.ss;
            if (a === 'prev') go(-1);
            else if (a === 'next') go(1);
            else if (a === 'close') close();
            else if (a === 'fullscreen') toggleFullscreen();
            return;
        }
        // click on the slide advances (like Slides); links / videos / widgets keep their clicks
        if (e.target.closest('a, button, input, textarea, select, iframe, label')) return;
        go(1);
    }

    function toggleFullscreen() {
        if (document.fullscreenElement === dlg) document.exitFullscreen?.().catch(() => {});
        else dlg.requestFullscreen?.().catch(() => {});
    }

    let wasFullscreen = false;
    function onFullscreenChange() {
        if (document.fullscreenElement === dlg) { wasFullscreen = true; updateBar(); return; }
        // the browser's Esc leaves full screen first — end the show, like Slides
        if (wasFullscreen && !closed) close();
    }

    // native dialog Esc → our close (renderer teardown)
    const onCancel = (e) => { e.preventDefault(); close(); };

    function close() {
        if (closed) return;
        closed = true;
        clearTimeout(uiTimer);
        dlg.removeEventListener('keydown', onKey);
        dlg.removeEventListener('click', onClick);
        dlg.removeEventListener('cancel', onCancel);
        dlg.removeEventListener('mousemove', pokeUi);
        document.removeEventListener('fullscreenchange', onFullscreenChange);
        if (document.fullscreenElement === dlg) document.exitFullscreen?.().catch(() => {});
        host.querySelectorAll('.ss-layer').forEach((el) => el.getAnimations?.().forEach((a) => a.cancel()));
        destroyLayer(layer);
        layer = null;
        host.innerHTML = '';
        try { dlg.close(); } catch (e) { /* not open */ }
        dlg.remove();
        try { opener && opener.focus && opener.focus({ preventScroll: true }); } catch (e) { /* gone */ }
        try { onClose && onClose(index); } catch (e) { console.error(e); }
    }

    dlg.addEventListener('keydown', onKey);
    dlg.addEventListener('click', onClick);
    dlg.addEventListener('cancel', onCancel);
    dlg.addEventListener('mousemove', pokeUi);
    document.addEventListener('fullscreenchange', onFullscreenChange);

    dlg.showModal();
    // must run inside the click that opened the show (user activation)
    dlg.requestFullscreen?.().catch(() => { /* blocked or unsupported: the modal still covers the window */ });
    dlg.focus();
    show(index, 1);
    pokeUi();

    return {
        close,
        next: () => go(1),
        prev: () => go(-1),
        goTo: (i) => show(i, i >= index ? 1 : -1),
        get index() { return index; },
        el: dlg,
    };
}
