// assets/js/lessons/canvas/tools/shape.js — native shape objects (schema v3)
//
// props: { kind, fill, stroke: { color, width, dash }, radius, contentScale: 1 }
//   dash: '' (solid) | 'dash' | 'dot'  (legacy `true` = 'dash')
//   kind: rect | roundRect | ellipse | triangle | diamond | star | speech
// Rendering:
//   rect / roundRect / ellipse → a box with CSS border + border-radius, so the
//     corner radius stays circular at any size (radius is in stage units);
//   everything else → one SVG path in a 0..100 viewBox with
//     preserveAspectRatio="none" (stretches cleanly to the object box) and
//     vector-effect="non-scaling-stroke" (stroke width never distorts).
// Shapes use contentScale 1, so fill/stroke numbers are stage units.

import { createObject } from '../model.js';

export const SHAPE_KINDS = Object.freeze([
    { kind: 'rect', label: 'Rectangle' },
    { kind: 'roundRect', label: 'Rounded rectangle' },
    { kind: 'ellipse', label: 'Ellipse' },
    { kind: 'triangle', label: 'Triangle' },
    { kind: 'diamond', label: 'Diamond' },
    { kind: 'star', label: 'Star' },
    { kind: 'speech', label: 'Speech bubble' },
]);
const KIND_SET = new Set(SHAPE_KINDS.map((k) => k.kind));
export const ROUND_KINDS = new Set(['rect', 'roundRect']); // corner radius applies

function starPath(points = 5, outer = 50, inner = 20, cx = 50, cy = 52) {
    const pts = [];
    for (let i = 0; i < points * 2; i++) {
        const r = i % 2 ? inner : outer;
        const a = (Math.PI / points) * i - Math.PI / 2;
        pts.push(`${(cx + r * Math.cos(a)).toFixed(2)} ${(cy + r * Math.sin(a)).toFixed(2)}`);
    }
    return `M${pts.join(' L')} Z`;
}

export const SHAPE_PATHS = Object.freeze({
    triangle: 'M50 0 L100 100 L0 100 Z',
    diamond: 'M50 0 L100 50 L50 100 L0 50 Z',
    star: starPath(),
    speech: 'M10 0 H90 Q100 0 100 10 V62 Q100 72 90 72 H40 L18 100 L24 72 H10 Q0 72 0 62 V10 Q0 0 10 0 Z',
});

const esc = (v) => String(v ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#039;' }[c]));
const num = (v, d = 0) => (typeof v === 'number' && Number.isFinite(v) ? v : d);

export const DASH_STYLES = Object.freeze([
    { value: '', label: 'Solid' },
    { value: 'dash', label: 'Dashed' },
    { value: 'dot', label: 'Dotted' },
]);
export function normalizeDash(v) { return v === true ? 'dash' : v === 'dash' || v === 'dot' ? v : ''; }

export const DEFAULT_SHAPE_STYLE = Object.freeze({ fill: '#dbeafe', stroke: { color: '#2563eb', width: 3 } });

// New shape object, centred on the stage above `siblings`.
export function createShape(kind = 'rect', siblings = [], overrides = {}) {
    const k = KIND_SET.has(kind) ? kind : 'rect';
    const size = k === 'speech' ? { w: 420, h: 300 } : k === 'rect' || k === 'roundRect' ? { w: 400, h: 260 } : { w: 320, h: 320 };
    return createObject('shape', {
        ...size,
        ...overrides,
        props: { kind: k, radius: k === 'roundRect' ? 28 : 0, ...(overrides.props || {}) },
    }, siblings);
}

// Inner markup for one shape object. opts.thumb: tiny sidebar preview
// (everything as SVG, 1px stroke).
export function shapeMarkup(obj, { thumb = false } = {}) {
    const p = (obj && obj.props) || {};
    const kind = KIND_SET.has(p.kind) ? p.kind : 'rect';
    const fill = p.fill || 'transparent';
    const stroke = p.stroke || {};
    const sw = Math.max(0, num(stroke.width));
    const sc = sw > 0 ? (stroke.color || '#0d1f35') : 'transparent';
    const dash = normalizeDash(stroke.dash);

    if (!thumb && (kind === 'rect' || kind === 'roundRect' || kind === 'ellipse')) {
        const radius = kind === 'ellipse' ? '50%' : `${Math.max(0, num(p.radius, kind === 'roundRect' ? 28 : 0))}px`;
        const style = dash === 'dash' ? 'dashed' : dash === 'dot' ? 'dotted' : 'solid';
        return `<div class="cv-shape" style="width:100%;height:100%;box-sizing:border-box;background:${esc(fill)};border:${sw}px ${style} ${esc(sc)};border-radius:${radius};"></div>`;
    }

    const w = thumb ? 1 : sw;
    let el;
    if (kind === 'ellipse') {
        el = `<ellipse cx="50" cy="50" rx="50" ry="50"`;
    } else if (kind === 'rect' || kind === 'roundRect') {
        const r = Math.min(50, (num(p.radius) / Math.max(1, Math.min(obj.w || 100, obj.h || 100))) * 100);
        el = `<rect x="0" y="0" width="100" height="100" rx="${r.toFixed(2)}" ry="${r.toFixed(2)}"`;
    } else {
        el = `<path d="${SHAPE_PATHS[kind]}"`;
    }
    return `<svg class="cv-fill cv-shape" viewBox="0 0 100 100" preserveAspectRatio="none" style="overflow:visible;display:block;width:100%;height:100%">`
        + `${el} fill="${esc(fill)}" stroke="${esc(sc)}" stroke-width="${w}" stroke-linejoin="round"${svgDash(dash, w)} vector-effect="non-scaling-stroke"/></svg>`;
}

// stroke-dasharray for a dash style (non-scaling stroke → screen units).
export function svgDash(dash, sw) {
    if (!sw) return '';
    if (dash === 'dash') return ` stroke-dasharray="${Math.max(2, sw * 3)} ${Math.max(2, sw * 2)}"`;
    if (dash === 'dot') return ` stroke-dasharray="0.01 ${Math.max(2, sw * 2)}" stroke-linecap="round"`;
    return '';
}

// Picker icon (Insert ▸ Shapes grid).
export function shapeIcon(kind) {
    const common = 'fill="#dbeafe" stroke="#2563eb" stroke-width="6" stroke-linejoin="round"';
    let el;
    if (kind === 'rect') el = `<rect x="6" y="18" width="88" height="64" ${common}/>`;
    else if (kind === 'roundRect') el = `<rect x="6" y="18" width="88" height="64" rx="16" ${common}/>`;
    else if (kind === 'ellipse') el = `<ellipse cx="50" cy="50" rx="44" ry="34" ${common}/>`;
    else el = `<path d="${SHAPE_PATHS[kind] || SHAPE_PATHS.triangle}" transform="translate(8 8) scale(0.84)" ${common}/>`;
    return `<svg viewBox="0 0 100 100" width="26" height="26" aria-hidden="true">${el}</svg>`;
}
