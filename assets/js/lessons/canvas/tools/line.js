// assets/js/lessons/canvas/tools/line.js — native line / arrow objects (schema v3)
//
// props: { x1, y1, x2, y2, stroke: { color, width, dash }, startHead, endHead, contentScale: 1 }
//   dash: '' | false (solid) | 'dash' | true (dashed) | 'dot'
//   x1..y2 are FRACTIONS (0..1) of the object box, so dragging / resizing /
//   rotating the box (Moveable) carries the line along unchanged.
//   heads: 'none' | 'arrow' (filled) | 'open' (chevron) | 'circle'
// Rendering is one SVG in the object's own pixel space (viewBox = w×h), so
// arrowheads keep their true shape at any aspect ratio. Heads are drawn as
// plain polygons (no <marker>), and the shaft is shortened under a filled
// head so the tip stays sharp.
//
// createLineHandles(): the two endpoint grips shown when exactly one line is
// selected (Moveable keeps drag; resize/rotate are replaced by the grips).

import { createObject, MIN_SIZE, normalizeRotation } from '../model.js';
import { applyObjectGeometry } from '../renderer.js';
import { normalizeDash } from './shape.js';

export const LINE_HEADS = Object.freeze([
    { value: 'none', label: 'None' },
    { value: 'arrow', label: 'Arrow' },
    { value: 'open', label: 'Open arrow' },
    { value: 'circle', label: 'Dot' },
]);
const HEADS = new Set(LINE_HEADS.map((h) => h.value));

export const LINE_PRESETS = Object.freeze({
    line: { label: 'Line', startHead: 'none', endHead: 'none' },
    arrow: { label: 'Arrow', startHead: 'none', endHead: 'arrow' },
    double: { label: 'Double arrow', startHead: 'arrow', endHead: 'arrow' },
});

const esc = (v) => String(v ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#039;' }[c]));
const num = (v, d) => (typeof v === 'number' && Number.isFinite(v) ? v : d);
const r3 = (v) => Math.round(v * 1000) / 1000;
const r2 = (v) => Math.round(v * 100) / 100;

export function createLine(preset = 'line', siblings = [], overrides = {}) {
    const p = LINE_PRESETS[preset] || LINE_PRESETS.line;
    return createObject('line', {
        w: 480, h: 48, ...overrides,
        props: { startHead: p.startHead, endHead: p.endHead, ...(overrides.props || {}) },
    }, siblings);
}

function headPolygon(tip, from, size, kind, color, sw) {
    const ang = Math.atan2(tip.y - from.y, tip.x - from.x);
    if (kind === 'circle') {
        const r = Math.max(size * 0.42, sw * 1.2);
        return `<circle cx="${r2(tip.x)}" cy="${r2(tip.y)}" r="${r2(r)}" fill="${esc(color)}"/>`;
    }
    const spread = Math.PI / 7;
    const a = { x: tip.x - size * Math.cos(ang - spread), y: tip.y - size * Math.sin(ang - spread) };
    const b = { x: tip.x - size * Math.cos(ang + spread), y: tip.y - size * Math.sin(ang + spread) };
    if (kind === 'open') {
        return `<polyline points="${r2(a.x)},${r2(a.y)} ${r2(tip.x)},${r2(tip.y)} ${r2(b.x)},${r2(b.y)}" fill="none" stroke="${esc(color)}" stroke-width="${sw}" stroke-linecap="round" stroke-linejoin="round"/>`;
    }
    return `<polygon points="${r2(tip.x)},${r2(tip.y)} ${r2(a.x)},${r2(a.y)} ${r2(b.x)},${r2(b.y)}" fill="${esc(color)}" stroke="${esc(color)}" stroke-width="${Math.max(1, sw * 0.5)}" stroke-linejoin="round"/>`;
}

// Inner markup for one line object. opts.thumb: sidebar preview (0..100 box).
export function lineMarkup(obj, { thumb = false } = {}) {
    const p = (obj && obj.props) || {};
    const cs = num(p.contentScale, 1) || 1;
    const W = thumb ? 100 : Math.max(1, (obj.w || 1) / cs);
    const H = thumb ? 100 : Math.max(1, (obj.h || 1) / cs);
    const s = p.stroke || {};
    const color = s.color || '#0d1f35';
    const sw = thumb ? 2 : Math.max(0.5, num(s.width, 4));
    const P1 = { x: num(p.x1, 0) * W, y: num(p.y1, 0.5) * H };
    const P2 = { x: num(p.x2, 1) * W, y: num(p.y2, 0.5) * H };
    const startHead = HEADS.has(p.startHead) ? p.startHead : 'none';
    const endHead = HEADS.has(p.endHead) ? p.endHead : 'none';
    const size = Math.max(18, sw * 3.4);
    const len = Math.hypot(P2.x - P1.x, P2.y - P1.y) || 1;
    const ux = (P2.x - P1.x) / len, uy = (P2.y - P1.y) / len;
    // shorten the shaft under a filled arrow so the tip stays crisp
    const inset = (h) => (h === 'arrow' ? Math.min(size * 0.8, len / 3) : 0);
    const a = { x: P1.x + ux * inset(startHead), y: P1.y + uy * inset(startHead) };
    const b = { x: P2.x - ux * inset(endHead), y: P2.y - uy * inset(endHead) };
    const ds = normalizeDash(s.dash);
    const dash = ds === 'dash' ? ` stroke-dasharray="${r2(sw * 2.6)} ${r2(sw * 1.8)}"` : ds === 'dot' ? ` stroke-dasharray="0.01 ${r2(sw * 2)}"` : '';
    let out = `<line x1="${r2(a.x)}" y1="${r2(a.y)}" x2="${r2(b.x)}" y2="${r2(b.y)}" stroke="${esc(color)}" stroke-width="${sw}" stroke-linecap="${ds === 'dash' ? 'butt' : 'round'}"${dash}/>`;
    if (!thumb) {
        if (startHead !== 'none') out += headPolygon(P1, P2, size, startHead, color, sw);
        if (endHead !== 'none') out += headPolygon(P2, P1, size, endHead, color, sw);
    }
    return `<svg class="cv-fill cv-line" viewBox="0 0 ${r2(W)} ${r2(H)}" preserveAspectRatio="none" style="overflow:visible;display:block;width:100%;height:100%">${out}</svg>`;
}

// Picker icons (Insert ▸ Line / Arrow menu).
export function lineIcon(preset) {
    const p = LINE_PRESETS[preset] || LINE_PRESETS.line;
    return lineMarkup({ w: 60, h: 24, props: { x1: 0.08, y1: 0.5, x2: 0.92, y2: 0.5, stroke: { color: '#2563eb', width: 3 }, startHead: p.startHead, endHead: p.endHead, contentScale: 1 } })
        .replace('style="overflow:visible;display:block;width:100%;height:100%"', 'width="40" height="16" style="overflow:visible"');
}

// ── geometry helpers (stage units) ───────────────────────────────────────
function rotatePoint(pt, c, deg) {
    if (!deg) return pt;
    const a = (deg * Math.PI) / 180, cos = Math.cos(a), sin = Math.sin(a);
    const dx = pt.x - c.x, dy = pt.y - c.y;
    return { x: c.x + dx * cos - dy * sin, y: c.y + dx * sin + dy * cos };
}

// Absolute stage endpoints of a line object (honours box rotation).
export function lineEndpoints(obj) {
    const p = obj.props || {};
    const c = { x: obj.x + obj.w / 2, y: obj.y + obj.h / 2 };
    const raw1 = { x: obj.x + num(p.x1, 0) * obj.w, y: obj.y + num(p.y1, 0.5) * obj.h };
    const raw2 = { x: obj.x + num(p.x2, 1) * obj.w, y: obj.y + num(p.y2, 0.5) * obj.h };
    return [rotatePoint(raw1, c, obj.rotation || 0), rotatePoint(raw2, c, obj.rotation || 0)];
}

// Unrotated box + fractional endpoints for two absolute stage points. The box
// keeps a minimum thickness so horizontal/vertical lines stay grabbable.
export function boxFromEndpoints(p1, p2, strokeWidth = 4) {
    const pad = Math.max(MIN_SIZE, 12, strokeWidth * 3);
    let minX = Math.min(p1.x, p2.x), maxX = Math.max(p1.x, p2.x);
    let minY = Math.min(p1.y, p2.y), maxY = Math.max(p1.y, p2.y);
    if (maxX - minX < pad * 2) { const c = (minX + maxX) / 2; minX = c - pad; maxX = c + pad; }
    if (maxY - minY < pad * 2) { const c = (minY + maxY) / 2; minY = c - pad; maxY = c + pad; }
    const w = maxX - minX, h = maxY - minY;
    return {
        x: r2(minX), y: r2(minY), w: r2(w), h: r2(h), rotation: 0,
        x1: r3((p1.x - minX) / w), y1: r3((p1.y - minY) / h),
        x2: r3((p2.x - minX) / w), y2: r3((p2.y - minY) / h),
    };
}

// ── endpoint grips ───────────────────────────────────────────────────────
const GRIP_CSS = `
.cv-line-grip { position: absolute; width: 14px; height: 14px; margin: -7px 0 0 -7px; border-radius: 50%; background: #fff;
  border: 2px solid #2563eb; box-shadow: 0 1px 3px rgba(13,31,53,.25); cursor: crosshair; z-index: 3100; touch-action: none; }
.cv-line-grip:hover { background: #eef4ff; }
`;
function ensureGripStyles() {
    if (document.getElementById('cv-line-grip-styles')) return;
    const st = document.createElement('style');
    st.id = 'cv-line-grip-styles';
    st.textContent = GRIP_CSS;
    document.head.appendChild(st);
}

export function createLineHandles({ handle, store, container }) {
    ensureGripStyles();
    const grips = [0, 1].map((i) => {
        const g = document.createElement('div');
        g.className = 'cv-line-grip';
        g.dataset.end = String(i);
        g.hidden = true;
        container.appendChild(g);
        return g;
    });
    let targetId = null;
    let drag = null;

    const toLocal = (pt) => {
        const sr = handle.stage.getBoundingClientRect(), cr = container.getBoundingClientRect(), k = handle.scale || 1;
        return { left: sr.left - cr.left + pt.x * k, top: sr.top - cr.top + pt.y * k };
    };
    const toStage = (clientX, clientY) => {
        const sr = handle.stage.getBoundingClientRect(), k = handle.scale || 1;
        return { x: (clientX - sr.left) / k, y: (clientY - sr.top) / k };
    };
    // Live box from the element's inline style (follows Moveable drag previews).
    function liveObject() {
        const o = targetId ? store.getObject(targetId) : null;
        const node = targetId ? handle.nodes.get(targetId) : null;
        if (!o || !node) return null;
        const st = node.el.style;
        const rot = /rotate\(([-\d.]+)deg\)/.exec(st.transform || '');
        return { ...o, x: parseFloat(st.left) || o.x, y: parseFloat(st.top) || o.y, w: parseFloat(st.width) || o.w, h: parseFloat(st.height) || o.h, rotation: rot ? parseFloat(rot[1]) : 0 };
    }

    function refresh() {
        const o = drag ? drag.preview : liveObject();
        if (!o) { grips.forEach((g) => { g.hidden = true; }); return; }
        lineEndpoints(o).forEach((pt, i) => {
            const pos = toLocal(pt);
            grips[i].style.left = `${pos.left}px`;
            grips[i].style.top = `${pos.top}px`;
            grips[i].hidden = false;
        });
    }

    function sync(obj) {
        targetId = obj && obj.type === 'line' && !obj.locked ? obj.id : null;
        if (!drag) refresh();
    }

    function onDown(e) {
        const o = liveObject();
        if (!o) return;
        e.preventDefault();
        e.stopPropagation();
        const end = Number(e.currentTarget.dataset.end);
        const pts = lineEndpoints(o);
        drag = { end, fixed: pts[1 - end], start: o, preview: o, slideId: store.getState().activeSlideId, pointerId: e.pointerId };
        e.currentTarget.setPointerCapture(e.pointerId);
    }

    function onMove(e) {
        if (!drag || e.pointerId !== drag.pointerId) return;
        let pt = toStage(e.clientX, e.clientY);
        const f = drag.fixed;
        if (e.shiftKey) { // 15° steps
            const ang = Math.round(Math.atan2(pt.y - f.y, pt.x - f.x) / (Math.PI / 12)) * (Math.PI / 12);
            const len = Math.hypot(pt.x - f.x, pt.y - f.y);
            pt = { x: f.x + len * Math.cos(ang), y: f.y + len * Math.sin(ang) };
        } else { // light snap to horizontal / vertical
            if (Math.abs(pt.y - f.y) < 6 / (handle.scale || 1)) pt.y = f.y;
            if (Math.abs(pt.x - f.x) < 6 / (handle.scale || 1)) pt.x = f.x;
        }
        const p1 = drag.end === 0 ? pt : f, p2 = drag.end === 0 ? f : pt;
        const b = boxFromEndpoints(p1, p2, num(drag.start.props?.stroke?.width, 4));
        const preview = { ...drag.start, x: b.x, y: b.y, w: b.w, h: b.h, rotation: 0, props: { ...drag.start.props, x1: b.x1, y1: b.y1, x2: b.x2, y2: b.y2 } };
        drag.preview = preview;
        const node = handle.nodes.get(drag.start.id);
        if (node) {
            applyObjectGeometry(node, preview, preview);
            node.content.innerHTML = lineMarkup(preview);
            node.print = null;
        }
        refresh();
    }

    function onUp(e) {
        if (!drag || e.pointerId !== drag.pointerId) return;
        const d = drag;
        drag = null;
        const before = store.getObject(d.start.id);
        if (before && d.preview !== d.start) {
            const after = { ...before, x: d.preview.x, y: d.preview.y, w: d.preview.w, h: d.preview.h, rotation: normalizeRotation(0), props: { ...before.props, ...d.preview.props } };
            store.dispatch({ label: 'Edit line', slideId: d.slideId, before: { [before.id]: before }, after: { [before.id]: after } });
        }
        refresh();
    }

    grips.forEach((g) => {
        g.addEventListener('pointerdown', onDown);
        g.addEventListener('pointermove', onMove);
        g.addEventListener('pointerup', onUp);
        g.addEventListener('pointercancel', onUp);
    });

    return {
        sync, refresh,
        isDragging: () => !!drag,
        destroy() { grips.forEach((g) => g.remove()); targetId = null; drag = null; },
    };
}
