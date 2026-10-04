// assets/js/lessons/canvas/renderer.js — universal slide renderer (schema v3)
//
// One renderer for every surface: student viewer, live presenter, and (Phase 4
// step 2) the editor and thumbnails.
//
//   const stage = mountStage(container, { theme });     // 1600×900 logical stage, scaled to fit
//   renderSlide(stage, slide, { mode, renderContent }); // objects → absolutely-positioned DOM
//   stage.setZoom('fit' | k);                           // editor: fixed zoom (viewport becomes w·k × h·k px)
//   stage.destroy();
//
// Geometry is pure CSS on each object element:
//   left/top/width/height (stage units = CSS px inside the stage),
//   transform: rotate(deg) about the box centre, z-index = rank of the z key.
// The stage element is exactly STAGE.w × STAGE.h CSS px and is fitted to its
// container with a single `transform: scale(k)` (k = fit width/height), so
// every surface shows the same composition at any size.
//
// renderContent(obj, mode) lets a host supply the inner markup for object
// types it owns (the viewer's interactive prompts / assignment cards, the
// presenter's response-aware blocks). Return a string or Node; return
// undefined to fall back to the built-in content for that type.
// props.contentScale scales an object's inner DOM (v2 content was authored on
// an 860px-wide stage; v3-native objects use 1).

import { STAGE, sortByZ, themeFor } from './model.js';
import { shapeMarkup } from './tools/shape.js';
import { lineMarkup } from './tools/line.js';
import { imageMarkup, IMAGE_CSS } from './tools/image-render.js';
import { WIDGET_TYPES, widgetMarkup, widgetKey, WIDGET_CSS } from './tools/interactive.js';

// Object types the renderer draws itself on every surface (hosts should
// return undefined from renderContent for these). Widgets get per-object
// live state through renderSlide's `widgetContext(obj)` option.
export const NATIVE_TYPES = new Set(['shape', 'line', 'image', ...WIDGET_TYPES]);

const STYLE_ID = 'cv-renderer-styles';
const CSS = `
.cv-viewport { position: relative; width: 100%; max-width: 100%; aspect-ratio: var(--cv-aspect, 16 / 9); overflow: hidden; margin: 0 auto; }
.cv-viewport.cv-fixed { aspect-ratio: auto; max-width: none; flex-shrink: 0; }
.cv-stage { position: absolute; top: 0; left: 0; transform-origin: 0 0; background: #fff; overflow: hidden;
            box-sizing: border-box; border-top: 9px solid var(--cv-accent, #2563eb); }
.cv-obj { position: absolute; box-sizing: border-box; transform-origin: 50% 50%; }
.cv-obj-content { position: absolute; top: 0; left: 0; transform-origin: 0 0; overflow: auto; box-sizing: border-box; }
.cv-obj-content > .cv-fill { width: 100%; height: 100%; }
.cv-obj img.cv-img { width: 100%; height: 100%; object-fit: contain; display: block; }
.cv-obj iframe { width: 100%; height: 100%; border: 0; display: block; }
.cv-obj .ql-editor h1, .cv-obj .ql-editor h2, .cv-obj .ql-editor h3 { font-weight: 700; line-height: 1.25; }
.cv-obj .ql-editor li > p { display: inline; margin: 0; }
.cv-obj .ql-editor:not(.ProseMirror) p:empty::before { content: '\\00a0'; }
.cv-obj .ql-editor mark { color: inherit; border-radius: 2px; padding: 0 1px; }
.cv-obj .ql-editor a { color: #2563eb; text-decoration: underline; }
.cv-obj .ql-editor pre { white-space: pre-wrap; font-family: 'DM Mono', ui-monospace, SFMono-Regular, Menlo, monospace; background: #f4f7fb; border: 1px solid #e5eaf1; border-radius: 6px; padding: .45em .6em; margin: .3em 0; font-size: .9em; line-height: 1.5; }
.cv-obj .ql-editor blockquote { border-left: 4px solid #dce3ed; margin: .25em 0; padding-left: .8em; color: #374f6b; }
.cv-obj .ql-editor hr { border: 0; border-top: 2px solid #dce3ed; margin: .6em 0; }
/* indent (same values as Quill's stylesheet, which not every page loads) */
.cv-obj .ql-editor .ql-indent-1 { padding-left: 3em; } .cv-obj .ql-editor li.ql-indent-1 { padding-left: 4.5em; }
.cv-obj .ql-editor .ql-indent-2 { padding-left: 6em; } .cv-obj .ql-editor li.ql-indent-2 { padding-left: 7.5em; }
.cv-obj .ql-editor .ql-indent-3 { padding-left: 9em; } .cv-obj .ql-editor li.ql-indent-3 { padding-left: 10.5em; }
.cv-obj .ql-editor .ql-indent-4 { padding-left: 12em; } .cv-obj .ql-editor li.ql-indent-4 { padding-left: 13.5em; }
.cv-obj .ql-editor .ql-indent-5 { padding-left: 15em; } .cv-obj .ql-editor li.ql-indent-5 { padding-left: 16.5em; }
.cv-obj .ql-editor .ql-indent-6 { padding-left: 18em; } .cv-obj .ql-editor li.ql-indent-6 { padding-left: 19.5em; }
.cv-obj .ql-editor .ql-indent-7 { padding-left: 21em; } .cv-obj .ql-editor li.ql-indent-7 { padding-left: 22.5em; }
.cv-obj .ql-editor .ql-indent-8 { padding-left: 24em; } .cv-obj .ql-editor li.ql-indent-8 { padding-left: 25.5em; }
.cv-obj-shape > .cv-obj-content, .cv-obj-line > .cv-obj-content { overflow: visible !important; }
.cv-empty { position: absolute; inset: 0; display: flex; align-items: center; justify-content: center; color: #94a3b8; font-weight: 600; font-size: 28px; }
`;

function ensureStyles() {
    if (typeof document === 'undefined' || document.getElementById(STYLE_ID)) return;
    const style = document.createElement('style');
    style.id = STYLE_ID;
    style.textContent = CSS + IMAGE_CSS + WIDGET_CSS;
    document.head.appendChild(style);
}

const esc = (v) => String(v ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#039;' }[c]));

// ── STAGE ────────────────────────────────────────────────────────────────
export function mountStage(container, { stage = STAGE, theme = 'general', className = '' } = {}) {
    ensureStyles();
    const w = stage.w || STAGE.w, h = stage.h || STAGE.h;
    container.innerHTML = '';

    const viewport = document.createElement('div');
    viewport.className = `cv-viewport ${className}`.trim();
    viewport.style.setProperty('--cv-aspect', `${w} / ${h}`);

    const stageEl = document.createElement('div');
    stageEl.className = 'cv-stage';
    stageEl.style.width = `${w}px`;
    stageEl.style.height = `${h}px`;
    viewport.appendChild(stageEl);
    container.appendChild(viewport);

    const handle = {
        viewport, stage: stageEl, size: { w, h }, scale: 1, zoom: 'fit',
        nodes: new Map(),           // object id -> { el, content, print }
        listeners: new Set(),       // fn(scale) after every fit()
        setTheme(name) {
            const t = themeFor(name);
            stageEl.style.setProperty('--cv-accent', t.accent);
            stageEl.style.setProperty('--cv-accent-soft', t.accentSoft);
        },
        fit() {
            let k;
            if (handle.zoom === 'fit') {
                const vw = viewport.clientWidth, vh = viewport.clientHeight;
                if (!vw || !vh) return handle.scale;
                k = Math.min(vw / w, vh / h);
            } else {
                k = handle.zoom;
            }
            const changed = k !== handle.scale;
            handle.scale = k;
            stageEl.style.transform = `scale(${k})`;
            if (changed) handle.listeners.forEach((fn) => { try { fn(k); } catch (e) { console.error(e); } });
            return k;
        },
        // 'fit' = fill the container width (aspect-ratio box); a number = exact
        // scale, viewport sized to w·k × h·k CSS px so a parent can scroll it.
        setZoom(z) {
            const k = z === 'fit' ? 'fit' : Math.max(0.05, Number(z) || 1);
            handle.zoom = k;
            viewport.classList.toggle('cv-fixed', k !== 'fit');
            viewport.style.width = k === 'fit' ? '' : `${Math.round(w * k)}px`;
            viewport.style.height = k === 'fit' ? '' : `${Math.round(h * k)}px`;
            return handle.fit();
        },
        onScale(fn) { handle.listeners.add(fn); return () => handle.listeners.delete(fn); },
        // stage units ↔ screen px (for the editor's pointer math)
        toStage(clientX, clientY) {
            const r = viewport.getBoundingClientRect();
            return { x: (clientX - r.left) / handle.scale, y: (clientY - r.top) / handle.scale };
        },
        destroy() {
            ro && ro.disconnect();
            handle.nodes.clear();
            handle.listeners.clear();
            if (viewport.parentNode === container) container.removeChild(viewport);
        },
    };
    handle.setTheme(theme);

    const ro = typeof ResizeObserver !== 'undefined' ? new ResizeObserver(() => handle.fit()) : null;
    if (ro) ro.observe(viewport);
    handle.fit();
    requestAnimationFrame(() => handle.fit()); // after layout settles (fonts/scrollbars)
    return handle;
}

// ── OBJECT GEOMETRY ──────────────────────────────────────────────────────
export function objectStyle(obj, zIndex) {
    const parts = [
        `left:${obj.x}px`, `top:${obj.y}px`, `width:${obj.w}px`, `height:${obj.h}px`,
        `z-index:${zIndex}`,
    ];
    if (obj.rotation) parts.push(`transform:rotate(${obj.rotation}deg)`);
    if (typeof obj.opacity === 'number' && obj.opacity < 1) parts.push(`opacity:${obj.opacity}`);
    return parts.join(';') + ';';
}

function contentScaleOf(obj) {
    return obj.props && typeof obj.props.contentScale === 'number' && obj.props.contentScale > 0 ? obj.props.contentScale : 1;
}

function contentStyle(obj) {
    const cs = contentScaleOf(obj);
    return `width:${obj.w / cs}px;height:${obj.h / cs}px;transform:scale(${cs});`;
}

// Live geometry update during a drag/resize/rotate (no re-render): `geom` is
// { x, y, w, h, rotation } in stage units; obj supplies contentScale.
export function applyObjectGeometry(node, obj, geom) {
    const el = node.el, cs = contentScaleOf(obj);
    el.style.left = `${geom.x}px`;
    el.style.top = `${geom.y}px`;
    el.style.width = `${geom.w}px`;
    el.style.height = `${geom.h}px`;
    el.style.transform = geom.rotation ? `rotate(${geom.rotation}deg)` : '';
    node.content.style.width = `${geom.w / cs}px`;
    node.content.style.height = `${geom.h / cs}px`;
}

// ── BUILT-IN CONTENT ─────────────────────────────────────────────────────
export function defaultContent(obj, mode = 'student', ctx = null) {
    const p = obj.props || {};
    if (WIDGET_TYPES.has(obj.type)) return widgetMarkup(obj, mode, ctx || {});
    switch (obj.type) {
        case 'text':
            return `<div class="cv-text ql-editor" style="padding:0;">${p.html || ''}</div>`;
        case 'image':
            return imageMarkup(obj, { emptyHtml: mode === 'editor' ? '<div class="cv-img-wrap" style="background:#f4f7fb;border:2px dashed #dce3ed;border-radius:12px;color:#9ab0c6;font-weight:600;font-size:14px">No image yet — add one from the formatting toolbar</div>' : '' });
        case 'video':
        case 'embed':
            return p.embedUrl
                ? `<iframe src="${esc(p.embedUrl)}" allowfullscreen loading="lazy" sandbox="allow-scripts allow-same-origin allow-presentation allow-popups"></iframe>`
                : '';
        case 'shape':
            return shapeMarkup(obj);
        case 'line':
            return lineMarkup(obj);
        default:
            return '';
    }
}

function setContent(node, c) {
    if (c === undefined || c === null) c = '';
    if (typeof c === 'string') node.innerHTML = c;
    else { node.innerHTML = ''; node.appendChild(c); }
}

// ── SLIDE ────────────────────────────────────────────────────────────────
// Slide background colour. v2-era slides carry it as a slide field, which the
// v2→v3 bridge keeps under `extra`.
const BG_RE = /^(#[0-9a-f]{3,8}|rgba?\([\d\s.,%]+\)|transparent)$/i;
export function slideBackground(slide) {
    const v = slide && (slide.background || (slide.extra && slide.extra.background));
    return typeof v === 'string' && BG_RE.test(v.trim()) ? v.trim() : '';
}
// Slide transition ('none' | 'fade' | 'slide' | 'zoom'), same storage as background.
export function slideTransition(slide) {
    const v = slide && (slide.transition || (slide.extra && slide.extra.transition));
    return ['fade', 'slide', 'zoom'].includes(v) ? v : 'none';
}

// Keyed render: objects are matched by id; geometry is re-applied every call,
// inner content is rebuilt only when the object's props (or mode) changed.
// skipIds: objects whose inner content must NOT be rebuilt this pass (the
// editor's live inline text editor) — geometry is still applied.
// Returns the list of { obj, el, content } actually on the stage.
export function renderSlide(handle, slide, { mode = 'student', renderContent = null, emptyText = 'This slide has no content yet.', skipIds = null, widgetContext = null } = {}) {
    const stageEl = handle.stage;
    const visible = sortByZ((slide && slide.objects) || []).filter((o) => !o.hidden);
    const seen = new Set();

    stageEl.querySelector(':scope > .cv-empty')?.remove();
    stageEl.style.background = slideBackground(slide) || '';

    let prev = null;
    // Keep DOM order == paint order, but only move nodes that are out of place:
    // re-inserting a node would blur a focused editor inside it.
    const place = (el) => {
        const want = prev ? prev.nextSibling : stageEl.firstChild;
        if (el !== want) stageEl.insertBefore(el, want);
        prev = el;
    };

    visible.forEach((obj, i) => {
        seen.add(obj.id);
        let node = handle.nodes.get(obj.id);
        if (!node) {
            const el = document.createElement('div');
            el.className = `cv-obj cv-obj-${obj.type}`;
            el.dataset.objectId = obj.id;
            const content = document.createElement('div');
            content.className = 'cv-obj-content';
            el.appendChild(content);
            node = { el, content, print: null };
            handle.nodes.set(obj.id, node);
        }
        node.el.style.cssText = objectStyle(obj, i + 1);
        node.el.classList.toggle('cv-locked', !!obj.locked);
        node.content.style.cssText = contentStyle(obj);
        if (skipIds && skipIds.has(obj.id)) { place(node.el); return; }
        // lines and (cropped) images lay out in their own pixel space, so their
        // markup depends on the box size; widgets also depend on live state
        const geo = obj.type === 'line' || obj.type === 'image' ? `|${obj.w}x${obj.h}` : '';
        const ctx = WIDGET_TYPES.has(obj.type) && widgetContext ? widgetContext(obj) : null;
        const wkey = WIDGET_TYPES.has(obj.type) ? `|${widgetKey(obj, mode, ctx || {})}` : '';
        const print = `${mode}|${obj.type}|${JSON.stringify(obj.props || {})}${geo}${wkey}`;
        if (node.print !== print) {
            const hosted = renderContent ? renderContent(obj, mode) : undefined;
            setContent(node.content, hosted === undefined ? defaultContent(obj, mode, ctx) : hosted);
            node.print = print;
        }
        place(node.el);
    });

    for (const [id, node] of handle.nodes) {
        if (!seen.has(id)) { node.el.remove(); handle.nodes.delete(id); }
    }

    if (!visible.length && emptyText) {
        const empty = document.createElement('div');
        empty.className = 'cv-empty';
        empty.textContent = emptyText;
        stageEl.appendChild(empty);
    }
    handle.fit();
    return visible.map((obj) => ({ obj, el: handle.nodes.get(obj.id).el, content: handle.nodes.get(obj.id).content }));
}

// Convenience: mount + render in one call (read-only surfaces).
export function renderSlideInto(container, slide, { theme, stage, mode, renderContent, emptyText } = {}) {
    const handle = mountStage(container, { theme, stage });
    renderSlide(handle, slide, { mode, renderContent, emptyText });
    return handle;
}
