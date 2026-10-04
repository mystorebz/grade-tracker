// assets/js/lessons/canvas/toolbar.js — the editor's one Format toolbar
//
// A fixed row under the menu bar. The STANDARD tools are always present —
// font, size, style, B/I/U/S, text & highlight colour, alignment, spacing,
// lists, link, clear | fill | border/line colour, weight, dash | corners |
// arrowheads — and each group is DISABLED (not hidden) when nothing selected
// supports it. A group acts on every selected object that supports it, as one
// undoable command (multi-select: Ctrl+A, Shift+click, marquee). After them a
// contextual tail: slide tools (Background · Layout · Theme · Transition) when
// nothing is selected, the object's own settings (image, activity, video…),
// shape type, or count · Align · Group / Ungroup for a multi-selection.
// Controls reflect the selection's current values (.is-active on toggles).
// Nothing is ever scrolled out of view: when the row is too narrow, tools
// move into a "More" (⋯) menu at the end — disabled ones first, then from the
// end — and move back as soon as there is room (layout()).
// Colour / alignment / spacing / layout / link choices open small fixed popovers
// (no positioning library), appended to `popoverRoot` so Focus Mode keeps them on top.
//
//   const tb = createFormatToolbar({ el, popoverRoot, store, getTextTool, host });
//   tb.refresh({ force });  tb.sync();  tb.runTextCommand('bold');  tb.destroy();
// Links: the Link button opens an inline popover (URL · Apply · Remove link) → setLink / unsetLink.
//
// host: {
//   slideContext() → null | { id, empty, background, transition, themeAccent, layouts: [{ key, label, icon }] }
//   setBackground(color|null), setTransition(value), applyLayout(key), openTheme(),
//   renderObject(el, obj) → bool, isSuppressed() → bool,
//   align(edge), distribute(axis), group(), ungroup(),
// }

import { FONT_FAMILIES, FONT_SIZES, LINE_HEIGHTS } from './tools/text.js';
import { SHAPE_KINDS, ROUND_KINDS, DASH_STYLES, normalizeDash } from './tools/shape.js';
import { LINE_HEADS } from './tools/line.js';

export const PALETTE = Object.freeze([
    '#000000', '#374151', '#6b7280', '#9ca3af', '#d1d5db', '#ffffff',
    '#0d1f35', '#2563eb', '#0d9488', '#16a34a', '#ca8a04', '#ea580c',
    '#dc2626', '#db2777', '#7c3aed', '#0891b2', '#65a30d', '#92400e',
    '#dbeafe', '#ccfbf1', '#dcfce7', '#fef3c7', '#fee2e2', '#ede9fe',
]);
const WEIGHTS = [1, 2, 3, 4, 6, 8, 12, 16, 24];
const TRANSITIONS = [['none', 'None'], ['fade', 'Fade'], ['slide', 'Slide'], ['zoom', 'Zoom']];
const ALIGN_ICONS = { left: 'fa-align-left', center: 'fa-align-center', right: 'fa-align-right', justify: 'fa-align-justify' };
const ARRANGE_ALIGN = [
    ['left', 'fa-objects-align-left', 'Align left'], ['center', 'fa-objects-align-center', 'Align center'], ['right', 'fa-objects-align-right', 'Align right'],
    ['top', 'fa-objects-align-top', 'Align top'], ['middle', 'fa-objects-align-middle', 'Align middle'], ['bottom', 'fa-objects-align-bottom', 'Align bottom'],
];

const esc = (v) => String(v ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#039;' }[c]));
const clone = (v) => JSON.parse(JSON.stringify(v));
const isHex = (v) => /^#[0-9a-f]{6}$/i.test(v || '');

function toHex(c) {
    if (isHex(c)) return c.toLowerCase();
    const m = /^#([0-9a-f])([0-9a-f])([0-9a-f])$/i.exec(c || '');
    if (m) return `#${m[1]}${m[1]}${m[2]}${m[2]}${m[3]}${m[3]}`.toLowerCase();
    const r = /rgba?\(\s*(\d+)[\s,]+(\d+)[\s,]+(\d+)/i.exec(c || '');
    if (r) return `#${[r[1], r[2], r[3]].map((n) => Number(n).toString(16).padStart(2, '0')).join('')}`;
    return '';
}

const CSS = `
.ft-row { display: flex; align-items: center; gap: 8px; height: 100%; }
.ft-sep { width: 1px; height: 20px; background: #dce3ed; flex-shrink: 0; }
.ft-label { font-size: 10px; font-weight: 800; color: #6b84a0; text-transform: uppercase; letter-spacing: .07em; white-space: nowrap; flex-shrink: 0; }
.ft-group { display: inline-flex; align-items: center; gap: 2px; flex-shrink: 0; }
.ft-btn { height: 30px; min-width: 30px; padding: 0 7px; border-radius: 6px; border: 1px solid transparent; background: transparent; color: #374f6b; font-size: 12.5px; font-weight: 700;
  display: inline-flex; align-items: center; justify-content: center; gap: 6px; white-space: nowrap; flex-shrink: 0; cursor: pointer; transition: background .12s, border-color .12s, color .12s; }
.ft-btn:hover:not(:disabled) { background: #f4f7fb; border-color: #dce3ed; }
.ft-btn.is-active { background: #eef4ff; border-color: #2563eb; color: #2563eb; }
.ft-btn:disabled, .ft-select:disabled, .ft-num:disabled { opacity: .5; pointer-events: none; cursor: default; }
.ft-std { display: flex; align-items: center; gap: 8px; flex-shrink: 0; }
.ft-grp { display: inline-flex; align-items: center; gap: 8px; flex-shrink: 0; }
.ft-grp.is-disabled .ft-label, .ft-grp.is-disabled .ft-sep { opacity: .5; }
.ft-tail { display: flex; align-items: center; height: 100%; flex-shrink: 0; }
.ft-sep[hidden] { display: none; }
.ft-btn .ft-caret { font-size: 8px; color: #9ab0c6; }
.ft-swatch-btn { flex-direction: column; gap: 1px; padding: 0 6px; }
.ft-swatch-btn i { font-size: 12px; line-height: 1; }
.ft-swatch-bar { width: 16px; height: 4px; border-radius: 2px; border: 1px solid rgba(13,31,53,.18); box-sizing: border-box; }
.ft-chip { width: 16px; height: 16px; border-radius: 4px; border: 1px solid rgba(13,31,53,.2); display: inline-block; flex-shrink: 0; }
.ft-select { height: 30px; border-radius: 6px; border: 1px solid #dce3ed; background: #fff; color: #0d1f35; font-size: 12px; font-weight: 600; padding: 0 6px; flex-shrink: 0; cursor: pointer; }
.ft-select:hover { border-color: #b9c8da; }
.ft-num { height: 30px; width: 46px; border-radius: 6px; border: 1px solid #dce3ed; background: #fff; color: #0d1f35; font-size: 12.5px; font-weight: 700; text-align: center; padding: 0 2px; font-variant-numeric: tabular-nums; -moz-appearance: textfield; }
.ft-num::-webkit-outer-spin-button, .ft-num::-webkit-inner-spin-button { -webkit-appearance: none; margin: 0; }
.ft-num:focus, .ft-select:focus { outline: none; border-color: #2563eb; }
.ft-size { display: inline-flex; align-items: center; gap: 1px; flex-shrink: 0; }
.ft-size .ft-btn { min-width: 24px; width: 24px; padding: 0; font-size: 11px; }
.ft-hint { font-size: 12px; font-weight: 600; color: #9ab0c6; white-space: nowrap; }
.ft-count { font-size: 12px; font-weight: 800; color: #0d1f35; white-space: nowrap; }
.ft-pop { position: fixed; z-index: 150; background: #fff; border: 1px solid #dce3ed; border-radius: 10px; box-shadow: 0 10px 28px rgba(13,31,53,.18); padding: 8px; font-family: 'DM Sans', sans-serif; }
.ft-pop-title { font-size: 10px; font-weight: 800; color: #6b84a0; text-transform: uppercase; letter-spacing: .08em; margin: 2px 2px 6px; }
.ft-pal { display: grid; grid-template-columns: repeat(6, 24px); gap: 5px; }
.ft-pal button { width: 24px; height: 24px; border-radius: 6px; border: 1px solid rgba(13,31,53,.15); cursor: pointer; padding: 0; }
.ft-pal button:hover { transform: scale(1.12); }
.ft-pal button.is-active { outline: 2px solid #2563eb; outline-offset: 1px; }
.ft-pop-row { display: flex; align-items: center; gap: 6px; margin-top: 8px; }
.ft-pop-row .ft-btn { height: 28px; border-color: #dce3ed; font-size: 12px; }
.ft-custom { position: relative; overflow: hidden; }
.ft-custom input { position: absolute; inset: 0; opacity: 0; width: 100%; height: 100%; cursor: pointer; border: 0; padding: 0; }
.ft-menu-list { display: flex; flex-direction: column; min-width: 170px; }
.ft-menu-item { display: flex; align-items: center; gap: 10px; width: 100%; text-align: left; padding: 7px 10px; border-radius: 6px; font-size: 12.5px; font-weight: 600; color: #0d1f35; background: transparent; border: 0; cursor: pointer; }
.ft-menu-item:hover { background: #f4f7fb; }
.ft-menu-item.is-active { color: #2563eb; background: #eef4ff; }
.ft-menu-item i { width: 16px; color: #2563eb; text-align: center; }
.ft-icons { display: flex; gap: 2px; }
.ft-link { width: 280px; }
.ft-link-input { width: 100%; box-sizing: border-box; height: 32px; border: 1px solid #dce3ed; border-radius: 6px; padding: 0 9px; font-size: 12.5px; color: #0d1f35; background: #fff; outline: none; }
.ft-link-input:focus { border-color: #2563eb; box-shadow: 0 0 0 3px rgba(37,99,235,.15); }
.ft-link-input[aria-invalid="true"] { border-color: #e31b4a; }
.ft-link-err { margin: 5px 1px 0; font-size: 11px; font-weight: 700; color: #e31b4a; }
.ft-btn.ft-btn-primary { background: #2563eb; border-color: #2563eb; color: #fff; }
.ft-row[data-ft-row] { width: 100%; min-width: 0; overflow: hidden; flex-wrap: nowrap; }
.ft-unit { display: inline-flex; align-items: center; gap: 8px; flex-shrink: 0; }
.ft-row[data-ft-row] > .ft-unit:first-child > .ft-sep:first-child { display: none; }
.ft-row[data-ft-row] > .ft-tail { display: contents; }
.ft-tailpart .ft-row { height: auto; }
.ft-more { margin-left: auto; }
.ft-more[hidden] { display: none; }
.ft-more-pop { position: fixed; z-index: 140; display: flex; flex-wrap: wrap; align-items: center; gap: 8px 10px; padding: 8px 10px; max-width: min(620px, calc(100vw - 16px));
  background: #fff; border: 1px solid #dce3ed; border-radius: 10px; box-shadow: 0 10px 28px rgba(13,31,53,.18); }
.ft-more-pop[hidden] { display: none; }
.ft-more-pop .ft-sep { display: none; }
.ft-more-pop .ft-tailpart, .ft-more-pop .ft-tailpart .ft-row { flex-wrap: wrap; height: auto; }
.ft-btn.ft-btn-primary:hover { background: #1d4ed8; border-color: #1d4ed8; }
`;
function ensureStyles() {
    if (document.getElementById('ft-styles')) return;
    const st = document.createElement('style');
    st.id = 'ft-styles';
    st.textContent = CSS;
    document.head.appendChild(st);
}

// options.groups: which standard groups exist (default all; Document mode: ['text']).
export function createFormatToolbar({ el, popoverRoot = document.body, store, getTextTool, host, groups = null }) {
    ensureStyles();
    let ctx = { kind: 'none', key: '', ids: [], textIds: [], shapeIds: [], lineIds: [], strokeIds: [], roundIds: [] };
    let pop = null;
    const tt = () => (getTextTool ? getTextTool() : null);
    const slideId = () => store.getState().activeSlideId;
    const objs = () => ctx.ids.map((id) => store.getObject(id)).filter(Boolean);

    // ── context ──────────────────────────────────────────────────────────
    // The standard tools never unmount: each group is enabled when at least one
    // selected object supports it, and acts on exactly those objects.
    //   textIds   → font / size / style / marks / colours / alignment / lists
    //   shapeIds  → fill          strokeIds (shapes + lines) → colour, weight, dash
    //   roundIds  → corner radius lineIds → arrowheads
    // The tail after the standard tools is contextual: slide tools (nothing
    // selected), the object's own settings (image, activity…), shape type, or
    // the multi-selection cluster (count · Align · Group / Ungroup).
    const EMPTY = { textIds: [], shapeIds: [], lineIds: [], strokeIds: [], roundIds: [] };
    function contextOf() {
        const sc = host.slideContext();
        if (!sc) return { kind: 'none', key: 'none', ids: [], ...EMPTY };
        const editing = tt()?.editingId() || null;
        const ids = editing ? [editing] : store.getState().selection.filter((id) => store.getObject(id));
        const list = ids.map((id) => store.getObject(id));
        const of = (fn) => list.filter(fn).map((o) => o.id);
        const caps = {
            textIds: of((o) => o.type === 'text' && !o.locked),
            shapeIds: of((o) => o.type === 'shape' && !o.locked),
            lineIds: of((o) => o.type === 'line' && !o.locked),
            roundIds: of((o) => o.type === 'shape' && !o.locked && ROUND_KINDS.has(o.props?.kind)),
        };
        caps.strokeIds = [...caps.shapeIds, ...caps.lineIds];
        // text tools are never greyed out: with no text box selected they act on
        // every (unlocked) text box on the slide
        let textFallback = false;
        if (!editing && !caps.textIds.length && typeof store.getSlide === 'function') {
            caps.textIds = (store.getSlide(sc.id)?.objects || []).filter((o) => o.type === 'text' && !o.locked && !o.hidden).map((o) => o.id);
            textFallback = true;
        }
        let kind;
        if (!ids.length) kind = 'slide';
        else if (ids.length > 1) kind = 'multi';
        else if (['text', 'line'].includes(list[0].type)) kind = 'plain';
        else if (list[0].type === 'shape') kind = 'shape';
        else kind = 'object';
        return { kind, key: `${kind}|${kind === 'slide' ? sc.id : ids.join(',')}`, ids, editing: !!editing, textFallback, ...caps };
    }

    function refresh({ force = false } = {}) {
        const next = contextOf();
        const changed = next.key !== ctx.key;
        ctx = next;
        if (!el.querySelector('[data-ft-std]')) { renderStandard(); force = true; }
        if (changed || force) {
            closePopover();
            renderTail();
        }
        enableGroups();
        sync();
        layout();
    }

    // ── render ───────────────────────────────────────────────────────────
    const btn = (cmd, icon, title, extra = '') => `<button type="button" class="ft-btn" data-ft="${cmd}" title="${esc(title)}" aria-label="${esc(title)}" ${extra}><i class="fa-solid ${icon}"></i></button>`;
    const sep = '<span class="ft-sep"></span>';
    const sel = (name, options, title, width) => `<select class="ft-select" data-ft-input="${name}" title="${esc(title)}" aria-label="${esc(title)}" style="width:${width}px">${options.map(([v, l]) => `<option value="${esc(v)}">${esc(l)}</option>`).join('')}</select>`;
    const swatch = (cmd, icon, title) => `<button type="button" class="ft-btn ft-swatch-btn" data-ft="${cmd}" title="${esc(title)}" aria-label="${esc(title)}"><i class="fa-solid ${icon}"></i><span class="ft-swatch-bar" data-ft-swatch="${cmd}"></span></button>`;
    const heads = LINE_HEADS.map((h) => [h.value, h.label]);

    // Rendered once; enableGroups() flips disabled states as the selection changes.
    // One flat row of units (each moves into the More menu as a whole when space runs out).
    function renderStandard() {
        let n = 0;
        // pri: what stays in the row longest when space runs out (10 = last to move)
        // pri 100 = pinned: always in the row, never moved to More (font, size, B/I/U/S)
        const unit = (grp, html, label = '', pri = 5) => `<span class="ft-unit ft-grp" data-ft-unit data-order="${n++}" data-pri="${pri}"${pri >= 100 ? ' data-pin' : ''} data-grp="${grp}"${label ? ` role="group" aria-label="${esc(label)}"` : ''}>${html}</span>`;
        el.innerHTML = `<div class="ft-row" data-ft-row data-ft-std role="group" aria-label="Formatting">
                ${unit('text', sel('font', FONT_FAMILIES.map(([v, l]) => [v, l]), 'Font', 116), 'Font', 100)}
                ${unit('text', `<span class="ft-size" title="Font size (px)">
                        <button type="button" class="ft-btn" data-ft="sizeDown" title="Decrease font size" aria-label="Decrease font size"><i class="fa-solid fa-minus"></i></button>
                        <input type="number" class="ft-num" data-ft-input="size" min="6" max="200" step="1" aria-label="Font size in pixels">
                        <button type="button" class="ft-btn" data-ft="sizeUp" title="Increase font size" aria-label="Increase font size"><i class="fa-solid fa-plus"></i></button>
                    </span>`, 'Font size', 100)}
                ${unit('text', sel('block', [['p', 'Normal text'], ['1', 'Heading 1'], ['2', 'Heading 2'], ['3', 'Heading 3']], 'Text style', 104), 'Text style', 5)}
                ${unit('text', `${sep}<span class="ft-group">${btn('bold', 'fa-bold', 'Bold (Ctrl+B)')}${btn('italic', 'fa-italic', 'Italic (Ctrl+I)')}${btn('underline', 'fa-underline', 'Underline (Ctrl+U)')}${btn('strike', 'fa-strikethrough', 'Strikethrough')}</span>`, 'Bold, italic, underline, strikethrough', 100)}
                ${unit('text', `<span class="ft-group">${swatch('color', 'fa-font', 'Text colour')}${swatch('highlight', 'fa-highlighter', 'Highlight colour')}</span>`, 'Colours', 8)}
                ${unit('text', `${sep}<span class="ft-group">
                        <button type="button" class="ft-btn" data-ft="alignText" title="Alignment" aria-label="Alignment"><i class="fa-solid fa-align-left" data-ft-icon="align"></i><i class="fa-solid fa-chevron-down ft-caret"></i></button>
                        <button type="button" class="ft-btn" data-ft="lineHeight" title="Line spacing" aria-label="Line spacing"><i class="fa-solid fa-arrows-up-down"></i><i class="fa-solid fa-chevron-down ft-caret"></i></button>
                    </span>`, 'Alignment and spacing', 7)}
                ${unit('text', `<span class="ft-group">${btn('bullet', 'fa-list-ul', 'Bulleted list')}${btn('ordered', 'fa-list-ol', 'Numbered list')}${btn('outdent', 'fa-outdent', 'Decrease indent (Shift+Tab)')}${btn('indent', 'fa-indent', 'Increase indent (Tab)')}</span>`, 'Lists and indent', 6)}
                ${unit('text', `${sep}<span class="ft-group">${btn('link', 'fa-link', 'Link')}${btn('clear', 'fa-text-slash', 'Clear formatting')}</span>`, 'Link and clear formatting', 4)}
                ${unit('fill', `${sep}${swatch('fill', 'fa-fill-drip', 'Fill colour')}`, 'Fill', 8)}
                ${unit('stroke', `${swatch('stroke', 'fa-pen', 'Border / line colour')}
                    ${sel('weight', [['0', 'None'], ...WEIGHTS.map((w) => [String(w), `${w} px`])], 'Border / line weight', 76)}
                    ${sel('dash', DASH_STYLES.map((d) => [d.value, d.label]), 'Border / line dash', 84)}`, 'Border / line', 7)}
                ${unit('round', `<span class="ft-label" title="Corner radius">Corners</span><input type="number" class="ft-num" data-ft-input="radius" min="0" max="450" step="1" aria-label="Corner radius" title="Corner radius">`, 'Corners', 5)}
                ${unit('line', `${sel('startHead', heads, 'Start arrowhead', 96)}${sel('endHead', heads, 'End arrowhead', 96)}`, 'Arrowheads', 6)}
                <span class="ft-tail" data-ft-tail></span>
                <button type="button" class="ft-btn ft-more" data-ft="more" title="More tools" aria-label="More tools" aria-haspopup="true" aria-expanded="false" hidden><i class="fa-solid fa-ellipsis"></i></button>
            </div>
            <div class="ft-more-pop" data-ft-more-pop role="group" aria-label="More tools" hidden></div>`;
        if (groups) el.querySelectorAll('[data-grp]').forEach((g) => { if (!groups.includes(g.dataset.grp)) g.remove(); });
    }

    // ── overflow: units that don't fit go into the More menu ─────────────
    const rowEl = () => el.querySelector('[data-ft-row]');
    const moreBtn = () => el.querySelector('[data-ft="more"]');
    const morePop = () => el.querySelector('[data-ft-more-pop]');
    const byOrder = (a, b) => Number(a.dataset.order) - Number(b.dataset.order);
    // Decides from cached unit widths which units belong in More, then moves only
    // the units whose place changes (re-parenting a control blurs it / drops its click).
    const unitW = new WeakMap();
    function measure(u) {
        if (u.parentElement === rowEl() || !morePop()?.hidden) { const w = u.offsetWidth; if (w || !u.children.length) unitW.set(u, w); }
        return unitW.has(u) ? unitW.get(u) : u.offsetWidth;
    }
    function layout() {
        const row = rowEl(), more = moreBtn(), pop = morePop();
        if (!row || !more || !pop) return;
        const units = [...el.querySelectorAll('[data-ft-unit]')].sort(byOrder);
        const GAP = 8;
        const width = (u) => { const w = measure(u); return w ? w + GAP : 0; };
        const avail = row.clientWidth;
        let total = units.reduce((t, u) => t + width(u), 0);
        const target = new Set();
        if (total > avail + 1) {
            const moreW = 34 + GAP;
            // disabled tools first, then the least-used ones (low data-pri), later ones first on a tie
            const off = (u) => u.classList.contains('is-disabled');
            const rank = (x, y) => Number(x.dataset.pri) - Number(y.dataset.pri) || Number(y.dataset.order) - Number(x.dataset.order);
            const movable = units.filter((u) => !u.hasAttribute('data-pin'));
            const queue = [...movable.filter(off).sort(rank), ...movable.filter((u) => !off(u)).sort(rank)];
            for (const u of queue) {
                if (total + moreW <= avail + 1) break;
                if (!width(u)) continue;
                target.add(u);
                total -= width(u);
            }
            // refill: anything moved that still fits in the leftover space comes back
            // (enabled and most-used first), so the row is never emptier than needed
            let room = avail - moreW - total;
            const back = [...target].filter((u) => !off(u)).sort((x, y) => Number(y.dataset.pri) - Number(x.dataset.pri) || byOrder(x, y)); // greyed-out tools never refill the row
            for (const u of back) {
                if (width(u) <= room) { target.delete(u); room -= width(u); }
            }
        }
        // move only what changes place
        units.forEach((u) => {
            const inPop = u.parentElement === pop;
            if (target.has(u) && !inPop) {
                const next = [...pop.children].find((c) => byOrder(c, u) > 0);
                pop.insertBefore(u, next || null);
            } else if (!target.has(u) && inPop) {
                const next = [...row.querySelectorAll(':scope > [data-ft-unit]')].find((c) => byOrder(c, u) > 0);
                row.insertBefore(u, next || more);
            }
        });
        more.hidden = !pop.children.length;
        if (!pop.children.length) closeMore();
        else if (!pop.hidden) placeMore();
        // widths can change with the content (e.g. the contextual tail): settle once more
        if (row.scrollWidth > row.clientWidth + 1 && !layout.again) { layout.again = true; requestAnimationFrame(() => { layout.again = false; units.forEach((u) => { if (u.parentElement === row) unitW.set(u, u.offsetWidth); }); layout(); }); }
    }
    function placeMore() {
        const pop = morePop(), more = moreBtn();
        const r = more.getBoundingClientRect(), b = pop.getBoundingClientRect();
        pop.style.left = `${Math.round(Math.max(8, Math.min(r.right - b.width, window.innerWidth - b.width - 8)))}px`;
        pop.style.top = `${Math.round(r.bottom + 6)}px`;
    }
    let moreCleanup = null;
    function openMore() {
        const pop = morePop(), more = moreBtn();
        if (!pop || !more) return;
        pop.hidden = false;
        more.setAttribute('aria-expanded', 'true');
        more.classList.add('is-active');
        placeMore();
        const outside = (e) => {
            if (pop.contains(e.target) || more.contains(e.target) || e.target.closest?.('.ft-pop')) return;
            closeMore();
        };
        const onKey = (e) => { if (e.key === 'Escape' && !document.querySelector('.ft-pop')) { e.preventDefault(); e.stopPropagation(); closeMore(); more.focus(); } };
        const onResize = () => closeMore();
        document.addEventListener('pointerdown', outside, true);
        document.addEventListener('keydown', onKey, true);
        window.addEventListener('resize', onResize);
        moreCleanup = () => { document.removeEventListener('pointerdown', outside, true); document.removeEventListener('keydown', onKey, true); window.removeEventListener('resize', onResize); };
    }
    function closeMore() {
        const pop = morePop(), more = moreBtn();
        if (moreCleanup) { moreCleanup(); moreCleanup = null; }
        if (pop) pop.hidden = true;
        if (more) { more.setAttribute('aria-expanded', 'false'); more.classList.remove('is-active'); }
    }
    let layoutRaf = 0;
    const ro = typeof ResizeObserver === 'function' ? new ResizeObserver(() => { cancelAnimationFrame(layoutRaf); layoutRaf = requestAnimationFrame(layout); }) : null;
    if (ro) ro.observe(el);

    const tail = () => el.querySelector('[data-ft-tail]');
    // The contextual tools are separate units ("parts") so a narrow row keeps as
    // many of them as fit; each part moves to More on its own.
    function renderTail() {
        const t = tail();
        if (!t) return;
        el.querySelectorAll('[data-ft-tailpart]').forEach((n) => n.remove());
        t.innerHTML = '';
        let parts = [];
        if (ctx.kind === 'none') parts = ['<span class="ft-hint">This slide type has no formatting options.</span>'];
        else if (ctx.kind === 'slide') parts = slideParts();
        else if (ctx.kind === 'shape') parts = [sel('kind', SHAPE_KINDS.map((k) => [k.kind, k.label]), 'Shape type', 140)];
        else if (ctx.kind === 'multi') parts = [`<span class="ft-count">${ctx.ids.length} selected</span>`,
            '<button type="button" class="ft-btn" data-ft="alignMenu" title="Align"><i class="fa-solid fa-objects-align-left"></i>Align<i class="fa-solid fa-chevron-down ft-caret"></i></button>',
            '<button type="button" class="ft-btn" data-ft="group" title="Group (Ctrl+G)"><i class="fa-solid fa-object-group"></i>Group</button>',
            '<button type="button" class="ft-btn" data-ft="ungroup" title="Ungroup (Ctrl+Shift+G)"><i class="fa-solid fa-object-ungroup"></i>Ungroup</button>'];
        else if (ctx.kind === 'object') {
            const o = store.getObject(ctx.ids[0]);
            if (o && host.renderObject(t, o)) {
                // the object's own settings: one part
                const part = makePart(0);
                while (t.firstChild) part.appendChild(t.firstChild);
                t.appendChild(part);
                return;
            }
            parts = ['<span class="ft-hint">Drag to move · handles resize and rotate</span>'];
        }
        parts.forEach((html, i) => {
            const part = makePart(i);
            part.innerHTML = `${i === 0 ? sep : ''}${html}`;
            t.appendChild(part);
        });
    }
    function makePart(i) {
        const part = document.createElement('span');
        part.className = 'ft-unit ft-tailpart';
        part.setAttribute('data-ft-unit', '');
        part.setAttribute('data-ft-tailpart', '');
        part.dataset.order = String(1000 + i);
        part.dataset.pri = '10';
        return part;
    }
    function slideParts() {
        return [
            '<button type="button" class="ft-btn" data-ft="slideBg" title="Slide background colour"><span class="ft-chip" data-ft-swatch="slideBg"></span>Background</button>',
            '<button type="button" class="ft-btn" data-ft="slideLayout" title="Slide layout"><i class="fa-solid fa-table-cells-large"></i>Layout<i class="fa-solid fa-chevron-down ft-caret"></i></button>',
            '<button type="button" class="ft-btn" data-ft="slideTheme" title="Lesson theme"><span class="ft-chip" data-ft-swatch="slideTheme" style="border-radius:999px"></span>Theme</button>',
            `<span class="ft-label">Transition</span>${sel('transition', TRANSITIONS, 'Slide transition (slideshow)', 92)}`,
        ];
    }

    // disabled (not hidden) when the selection has nothing the group applies to
    function enableGroups() {
        const on = {
            text: true, fill: ctx.shapeIds.length > 0, stroke: ctx.strokeIds.length > 0,
            round: ctx.roundIds.length > 0, line: ctx.lineIds.length > 0,
        };
        el.querySelectorAll('[data-grp]').forEach((g) => {
            const enabled = !!on[g.dataset.grp];
            g.classList.toggle('is-disabled', !enabled);
            g.setAttribute('aria-disabled', String(!enabled));
            g.querySelectorAll('button, select, input').forEach((c) => { c.disabled = !enabled; });
        });
        const scope = ctx.textFallback ? ' — applies to all text on this slide (no text box selected)' : '';
        el.querySelectorAll('[data-grp="text"] [data-ft], [data-grp="text"] [data-ft-input], [data-grp="text"] .ft-size').forEach((c) => {
            if (c.dataset.baseTitle === undefined) c.dataset.baseTitle = c.getAttribute('title') || '';
            if (c.dataset.baseTitle) c.title = c.dataset.baseTitle + scope;
        });
        // lines can't go to 0 width
        const none = el.querySelector('select[data-ft-input="weight"] option[value="0"]');
        if (none) none.disabled = ctx.shapeIds.length === 0;
    }

    // the relevant tools stay in the row; the rest go to the More menu
    function reveal() { layout(); }

    // ── sync (values / .is-active from the selected nodes) ──────────────
    const q = (s) => el.querySelector(s);
    const setVal = (name, v) => { const i = q(`[data-ft-input="${name}"]`); if (i && document.activeElement !== i) i.value = v; };
    const active = (cmd, on) => q(`[data-ft="${cmd}"]`)?.classList.toggle('is-active', !!on);
    const paint = (cmd, color) => { const s = q(`[data-ft-swatch="${cmd}"]`); if (s) s.style.background = color || 'transparent'; };
    const first = (ids) => (ids.length ? store.getObject(ids[0]) : null);

    function sync() {
        syncText();
        const shape = first(ctx.shapeIds);
        paint('fill', shape && shape.props?.fill && shape.props.fill !== 'transparent' ? shape.props.fill : '');
        const so = first(ctx.strokeIds);
        const s = (so && so.props?.stroke) || {};
        const w = so ? Math.round(s.width || (so.type === 'line' ? 4 : 0)) : 0;
        paint('stroke', so && (so.type === 'line' || w > 0) ? (s.color || '#0d1f35') : '');
        ensureOption('weight', w);
        setVal('weight', so ? String(w) : '0');
        setVal('dash', so ? normalizeDash(s.dash) : '');
        const ro = first(ctx.roundIds);
        setVal('radius', ro ? String(Math.round(ro.props?.radius || 0)) : '');
        const lo = first(ctx.lineIds);
        setVal('startHead', lo ? lo.props?.startHead || 'none' : 'none');
        setVal('endHead', lo ? lo.props?.endHead || 'none' : 'none');
        if (ctx.kind === 'shape') setVal('kind', shape?.props?.kind || 'rect');
        if (ctx.kind === 'slide') {
            const sc = host.slideContext();
            if (sc) {
                paint('slideBg', sc.background || '#ffffff');
                paint('slideTheme', sc.themeAccent);
                setVal('transition', sc.transition || 'none');
            }
        }
        if (ctx.kind === 'multi') {
            const groups = ctx.ids.map((id) => store.groupOf(store.getObject(id)));
            const oneGroup = groups.every((g) => g && g === groups[0]);
            const g = q('[data-ft="group"]'), u = q('[data-ft="ungroup"]');
            if (g) g.disabled = oneGroup;
            if (u) u.disabled = !groups.some(Boolean);
        }
    }

    function ensureOption(name, value) {
        const s = q(`select[data-ft-input="${name}"]`);
        if (!s || [...s.options].some((o) => o.value === String(value))) return;
        const opt = document.createElement('option');
        opt.value = String(value); opt.textContent = `${value} px`;
        s.appendChild(opt);
    }

    // Combined state of every selected text box (a toggle is "on" only when it
    // is on in all of them; a value shows only when they all agree).
    function textState() {
        const t = tt();
        if (!t || !ctx.textIds.length) return null;
        const states = ctx.textIds.map((id) => t.state(id)).filter(Boolean);
        if (!states.length) return null;
        const f = states[0];
        if (states.length === 1) return f;
        const all = (k) => states.every((x) => x[k]);
        const same = (k) => (states.every((x) => x[k] === f[k]) ? f[k] : '');
        return { ...f, bold: all('bold'), italic: all('italic'), underline: all('underline'), strike: all('strike'), bullet: all('bullet'), ordered: all('ordered'), link: all('link'),
            align: same('align') || 'left', lineHeight: same('lineHeight'), block: same('block') || 'p', fontFamily: same('fontFamily'), fontSize: same('fontSize'), color: same('color'), highlight: same('highlight') };
    }

    function syncText() {
        const st = textState();
        const t = tt();
        const comp = t && ctx.textIds.length ? t.computedStyle(ctx.textIds[0]) : null;
        ['bold', 'italic', 'underline', 'strike', 'bullet', 'ordered', 'link'].forEach((k) => active(k, st && st[k]));
        const fam = st && st.fontFamily && FONT_FAMILIES.some(([v]) => v === st.fontFamily) ? st.fontFamily : '';
        setVal('font', fam);
        let px = '';
        if (st && st.fontSize) px = parseFloat(st.fontSize);
        else if (st && comp && comp.fontSize && ctx.textIds.length === 1) px = Math.round(comp.fontSize * 10) / 10; // mixed boxes: blank
        setVal('size', px === '' || Number.isNaN(px) ? '' : String(Math.round(px * 10) / 10));
        setVal('block', st ? st.block : 'p');
        paint('color', st ? (st.color || (comp && comp.color) || '#0d1f35') : '');
        paint('highlight', (st && st.highlight) || '');
        const ai = q('[data-ft-icon="align"]');
        if (ai) ai.className = `fa-solid ${ALIGN_ICONS[(st && st.align) || 'left']}`;
        active('alignText', st && st.align && st.align !== 'left');
        active('lineHeight', st && st.lineHeight);
    }

    // ── text commands ────────────────────────────────────────────────────
    // Live editor: editor.chain().focus().toggleBold().run(). Selected box(es):
    // the same chain over each box's whole text, written as ONE undoable store
    // command for the whole selection (text.js formatObjects).
    const MARKS = {
        bold: ['toggleBold', 'setBold', 'unsetBold'], italic: ['toggleItalic', 'setItalic', 'unsetItalic'],
        underline: ['toggleUnderline', 'setUnderline', 'unsetUnderline'], strike: ['toggleStrike', 'setStrike', 'unsetStrike'],
    };
    function runText(fn, { coalesce = null } = {}) {
        const t = tt();
        if (!t || !ctx.textIds.length) return;
        const ed = t.getEditor();
        if (ctx.editing && ed && t.editingId() === ctx.textIds[0]) { fn(ed.chain().focus()).run(); sync(); return; }
        const key = coalesce ? `fmt:${coalesce}:${ctx.textIds.join(',')}` : null;
        t.formatObjects(ctx.textIds, fn, { coalesceKey: key }).then(() => sync());
    }
    function runTextCommand(cmd, value) {
        if (MARKS[cmd]) {
            const [toggle, set, unset] = MARKS[cmd];
            if (ctx.editing) return runText((c) => c[toggle]());
            const on = !!(textState() || {})[cmd]; // all on → turn off everywhere, else on everywhere
            return runText((c) => (on ? c[unset]() : c[set]()));
        }
        switch (cmd) {
            case 'bullet': return runText((c) => c.toggleBulletList());
            case 'indent': return runText((c) => c.indent());
            case 'outdent': return runText((c) => c.outdent());
            case 'ordered': return runText((c) => c.toggleOrderedList());
            case 'clear': return runText((c) => c.unsetAllMarks().clearNodes());
            case 'align': return runText((c) => c.setTextAlign(value));
            case 'lineHeight': return runText((c) => (value ? c.setLineHeight(value) : c.unsetLineHeight()));
            case 'font': return runText((c) => (value ? c.setFontFamily(value) : c.unsetFontFamily()));
            case 'size': return runText((c) => (value ? c.setFontSize(value) : c.unsetFontSize()), { coalesce: 'size' });
            case 'block': return runText((c) => (value === 'p' ? c.setParagraph() : c.setHeading({ level: Number(value) })));
            case 'color': return runText((c) => (value ? c.setColor(value) : c.unsetColor()), { coalesce: 'color' });
            case 'highlight': return runText((c) => (value ? c.setHighlight({ color: value }) : c.unsetHighlight()), { coalesce: 'highlight' });
            case 'link': {
                // value: an address → set (or insert as linked text at a bare caret); '' → remove
                const ed = tt()?.getEditor();
                if (!ctx.editing || !ed) return runText((c) => (value ? c.setLink({ href: value }) : c.unsetLink())); // whole box(es)
                if (!value) return runText((c) => c.extendMarkRange('link').unsetLink());
                const { empty } = ed.state.selection;
                if (empty && !ed.isActive('link')) {
                    return runText((c) => c.insertContent({ type: 'text', text: value, marks: [{ type: 'link', attrs: { href: value } }] }));
                }
                return runText((c) => c.extendMarkRange('link').setLink({ href: value }));
            }
            default: return undefined;
        }
    }

    function stepSize(dir) {
        const cur = Number(q('[data-ft-input="size"]')?.value) || 14;
        const sizes = FONT_SIZES.map((x) => parseInt(x, 10));
        const next = dir > 0 ? sizes.find((x) => x > cur) || Math.min(200, cur + 8) : [...sizes].reverse().find((x) => x < cur) || Math.max(6, cur - 1);
        setVal('size', String(next));
        runTextCommand('size', `${next}px`);
    }

    // ── shape / line commands: one undo step for every object the control applies to ──
    function patchObjects(ids, patchFn, key) {
        if (!ids.length) return;
        store.commands.updateObjects(slideId(), ids.map((id) => {
            const o = store.getObject(id);
            return o ? { id, props: patchFn(o.props || {}, o) } : null;
        }).filter(Boolean), { label: 'Style', coalesceKey: `style:${key}:${ids.join(',')}` });
    }
    const strokeOf = (p, o) => ({ color: o.type === 'line' ? '#0d1f35' : '#2563eb', width: o.type === 'line' ? 4 : 0, ...(p.stroke || {}) });

    // ── popovers ─────────────────────────────────────────────────────────
    function closePopover() {
        if (!pop) return;
        const hadFocus = pop.el.contains(document.activeElement);
        pop.cleanup();
        pop.el.remove();
        pop = null;
        if (hadFocus && ctx.editing) tt()?.getEditor()?.commands.focus(); // back to the text being edited
    }
    function openPopover(trigger, html, onPick) {
        const same = pop && pop.trigger === trigger;
        closePopover();
        if (same) return null; // second click on the trigger closes it
        const box = document.createElement('div');
        box.className = 'ft-pop';
        box.setAttribute('role', 'dialog');
        box.innerHTML = html;
        popoverRoot.appendChild(box);
        const r = trigger.getBoundingClientRect(), b = box.getBoundingClientRect();
        const vw = window.innerWidth, vh = window.innerHeight;
        let left = Math.min(Math.max(8, r.left), vw - b.width - 8);
        let top = r.bottom + 6;
        if (top + b.height > vh - 8) top = Math.max(8, r.top - b.height - 6);
        box.style.left = `${Math.round(left)}px`;
        box.style.top = `${Math.round(top)}px`;
        // keep the text editor's selection: only inputs take focus
        box.addEventListener('mousedown', (e) => { if (!e.target.closest('input, select')) e.preventDefault(); });
        box.addEventListener('click', (e) => {
            const t = e.target.closest('[data-pick]');
            if (!t) return;
            if (onPick(t.dataset.pick, t) !== false) closePopover(); // false = keep open (e.g. invalid input)
        });
        box.querySelectorAll('input[type="color"]').forEach((input) => input.addEventListener('change', () => { onPick(input.value, input); closePopover(); }));
        const outside = (e) => { if (!box.contains(e.target) && !trigger.contains(e.target)) closePopover(); };
        const onKey = (e) => { if (e.key === 'Escape') { e.preventDefault(); e.stopPropagation(); closePopover(); } };
        const onResize = () => closePopover();
        document.addEventListener('pointerdown', outside, true);
        document.addEventListener('keydown', onKey, true);
        window.addEventListener('resize', onResize);
        el.addEventListener('scroll', onResize, { passive: true });
        pop = {
            el: box, trigger,
            cleanup() {
                document.removeEventListener('pointerdown', outside, true);
                document.removeEventListener('keydown', onKey, true);
                window.removeEventListener('resize', onResize);
                el.removeEventListener('scroll', onResize);
            },
        };
        return box;
    }

    function colorPopover(trigger, { title, current, none = null }, onPick) {
        const cur = toHex(current);
        const html = `<p class="ft-pop-title">${esc(title)}</p>
            <div class="ft-pal">${PALETTE.map((c) => `<button type="button" data-pick="${c}" title="${c}" aria-label="${c}" style="background:${c}" class="${cur === c ? 'is-active' : ''}"></button>`).join('')}</div>
            <div class="ft-pop-row">
                ${none ? `<button type="button" class="ft-btn" data-pick="">${esc(none)}</button>` : ''}
                <label class="ft-btn ft-custom" title="Custom colour"><i class="fa-solid fa-eye-dropper"></i>Custom<input type="color" value="${cur || '#2563eb'}" aria-label="Custom colour"></label>
            </div>`;
        openPopover(trigger, html, onPick);
    }

    function listPopover(trigger, title, items, onPick) {
        const html = `${title ? `<p class="ft-pop-title">${esc(title)}</p>` : ''}<div class="ft-menu-list">${items.map((it) => `<button type="button" class="ft-menu-item ${it.active ? 'is-active' : ''}" data-pick="${esc(it.value)}">${it.icon ? `<i class="fa-solid ${it.icon}"></i>` : ''}${esc(it.label)}</button>`).join('')}</div>`;
        openPopover(trigger, html, onPick);
    }

    // Link editor: URL field + Apply, and Remove when the caret / selection is
    // already inside a link. Enter applies, Esc closes (editor selection kept).
    function normalizeUrl(raw) {
        const u = String(raw || '').trim();
        if (!u || /\s/.test(u)) return null;
        if (/^(https?:\/\/|mailto:|tel:)/i.test(u)) return u;
        if (/^[a-z][a-z0-9+.-]*:(?!\d)/i.test(u)) return null; // javascript:, data: … never (host:port is fine)
        if (/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(u)) return `mailto:${u}`;
        return /\.[a-z]{2,}([/:?#]|$)/i.test(u) ? `https://${u}` : null;
    }
    function linkPopover(trigger) {
        const ed = ctx.editing ? tt()?.getEditor() : null;
        const prev = ed ? ed.getAttributes('link').href || '' : '';
        const html = `<p class="ft-pop-title">${prev ? 'Edit link' : 'Insert link'}</p>
            <div class="ft-link">
                <input type="text" inputmode="url" class="ft-link-input" data-link-url value="${esc(prev)}" placeholder="Paste or type a link" aria-label="Link address" autocomplete="off" spellcheck="false">
                <p class="ft-link-err" data-link-err hidden>Enter a web address like example.com</p>
                <div class="ft-pop-row">
                    <button type="button" class="ft-btn ft-btn-primary" data-pick="apply">Apply</button>
                    ${prev ? '<button type="button" class="ft-btn" data-pick="remove"><i class="fa-solid fa-link-slash"></i>Remove link</button>' : ''}
                </div>
            </div>`;
        const box = openPopover(trigger, html, (v) => {
            if (v === 'remove') { runTextCommand('link', ''); return true; }
            return apply();
        });
        if (!box) return;
        const input = box.querySelector('[data-link-url]');
        const err = box.querySelector('[data-link-err]');
        function apply() {
            const url = normalizeUrl(input.value);
            if (!url) { err.hidden = false; input.setAttribute('aria-invalid', 'true'); input.focus(); return false; }
            runTextCommand('link', url);
            return true;
        }
        input.addEventListener('input', () => { err.hidden = true; input.removeAttribute('aria-invalid'); });
        input.addEventListener('keydown', (e) => {
            if (e.key !== 'Enter') return;
            e.preventDefault();
            if (apply()) closePopover();
        });
        input.focus();
        input.select();
    }

    // ── events (delegated, wired once) ───────────────────────────────────
    el.addEventListener('mousedown', (e) => {
        // buttons keep the inline editor's focus/selection; fields take focus
        if (e.target.closest('button') && !e.target.closest('input, select, label')) e.preventDefault();
    });

    el.addEventListener('click', (e) => {
        const b = e.target.closest('[data-ft]');
        if (!b || b.disabled || !el.contains(b)) return;
        const cmd = b.dataset.ft;
        // text
        if (cmd === 'link') return linkPopover(b);
        if (cmd === 'more') return morePop()?.hidden ? openMore() : closeMore();
        if (MARKS[cmd] || ['bullet', 'ordered', 'clear', 'indent', 'outdent'].includes(cmd)) return runTextCommand(cmd);
        if (cmd === 'sizeUp' || cmd === 'sizeDown') return stepSize(cmd === 'sizeUp' ? 1 : -1);
        if (cmd === 'color') {
            const st = textState(), comp = tt()?.computedStyle(ctx.textIds[0]);
            return colorPopover(b, { title: 'Text colour', current: (st && st.color) || (comp && comp.color), none: 'Default' }, (v) => runTextCommand('color', v));
        }
        if (cmd === 'highlight') return colorPopover(b, { title: 'Highlight', current: textState()?.highlight, none: 'None' }, (v) => runTextCommand('highlight', v));
        if (cmd === 'alignText') {
            const a = textState()?.align || 'left';
            return listPopover(b, 'Alignment', Object.keys(ALIGN_ICONS).map((k) => ({ value: k, label: k[0].toUpperCase() + k.slice(1), icon: ALIGN_ICONS[k], active: a === k })), (v) => runTextCommand('align', v));
        }
        if (cmd === 'lineHeight') {
            const lh = textState()?.lineHeight || '';
            return listPopover(b, 'Line spacing', [{ value: '', label: 'Default', active: !lh }, ...LINE_HEIGHTS.map(([v, l]) => ({ value: v, label: l, active: lh === v }))], (v) => runTextCommand('lineHeight', v));
        }
        // shapes / lines
        if (cmd === 'fill') {
            return colorPopover(b, { title: 'Fill colour', current: first(ctx.shapeIds)?.props?.fill, none: 'Transparent' }, (v) => patchObjects(ctx.shapeIds, () => ({ fill: v || 'transparent' }), 'fill'));
        }
        if (cmd === 'stroke') {
            const so = first(ctx.strokeIds), s = so?.props?.stroke || {};
            const shapes = ctx.shapeIds.length > 0;
            return colorPopover(b, { title: shapes && !ctx.lineIds.length ? 'Border colour' : shapes ? 'Border / line colour' : 'Line colour', current: so?.type === 'line' || s.width ? s.color : '', none: shapes ? 'No border' : null }, (v) => {
                patchObjects(ctx.strokeIds, (p, o) => {
                    const st = strokeOf(p, o);
                    if (!v) return o.type === 'shape' ? { stroke: { ...st, width: 0 } } : {};
                    return { stroke: { ...st, color: v, width: st.width || (o.type === 'shape' ? 3 : 4) } };
                }, 'stroke');
            });
        }
        // contextual tail
        if (ctx.kind === 'slide') {
            const sc = host.slideContext();
            if (cmd === 'slideBg') return colorPopover(b, { title: 'Slide background', current: sc?.background || '#ffffff', none: 'Reset' }, (v) => { host.setBackground(v || null); sync(); });
            if (cmd === 'slideTheme') return host.openTheme();
            if (cmd === 'slideLayout') {
                return listPopover(b, sc?.empty ? 'Apply layout' : 'New slide with layout', (sc?.layouts || []).map((l) => ({ value: l.key, label: l.label, icon: l.icon })), (v) => host.applyLayout(v));
            }
        }
        if (cmd === 'alignMenu') {
            return listPopover(b, 'Align', [
                ...ARRANGE_ALIGN.map(([v, icon, label]) => ({ value: v, label, icon })),
                ...(ctx.ids.length >= 3 ? [{ value: 'dist-h', label: 'Distribute horizontally', icon: 'fa-arrows-left-right' }, { value: 'dist-v', label: 'Distribute vertically', icon: 'fa-arrows-up-down' }] : []),
            ], (v) => (v.startsWith('dist-') ? host.distribute(v.slice(5)) : host.align(v)));
        }
        if (cmd === 'group') return host.group();
        if (cmd === 'ungroup') return host.ungroup();
        return undefined;
    });

    el.addEventListener('change', (e) => {
        const i = e.target.closest('[data-ft-input]');
        if (!i || i.disabled) return;
        const name = i.dataset.ftInput, v = i.value;
        if (name === 'font') return runTextCommand('font', v);
        if (name === 'block') return runTextCommand('block', v);
        if (name === 'size') {
            const n = Math.min(200, Math.max(6, Number(v) || 0));
            if (n) runTextCommand('size', `${n}px`);
            return undefined;
        }
        if (name === 'transition') return host.setTransition(v);
        if (name === 'kind') {
            patchObjects(ctx.shapeIds, (p) => ({ kind: v, radius: v === 'roundRect' && !p.radius ? 28 : p.radius || 0 }), 'kind');
            return refresh({ force: true }); // corners availability depends on the kind
        }
        if (name === 'weight') return patchObjects(ctx.strokeIds, (p, o) => ({ stroke: { ...strokeOf(p, o), width: o.type === 'line' ? Math.max(1, Number(v) || 1) : Number(v) || 0 } }), 'weight');
        if (name === 'dash') return patchObjects(ctx.strokeIds, (p, o) => ({ stroke: { ...strokeOf(p, o), dash: v } }), 'dash');
        if (name === 'radius') return patchObjects(ctx.roundIds, (p, o) => ({ radius: Math.max(0, Math.min(Math.round(Math.min(o.w, o.h) / 2), Number(v) || 0)) }), 'radius');
        if (name === 'startHead' || name === 'endHead') return patchObjects(ctx.lineIds, () => ({ [name]: v }), name);
        return undefined;
    });

    el.addEventListener('keydown', (e) => {
        const i = e.target.closest('input[data-ft-input]');
        if (!i) return;
        if (e.key === 'Enter') { e.preventDefault(); i.dispatchEvent(new Event('change', { bubbles: true })); if (ctx.editing) tt()?.getEditor()?.commands.focus(); }
        else if (e.key === 'Escape') { e.preventDefault(); e.stopPropagation(); i.blur(); sync(); }
    });

    // ── store wiring ─────────────────────────────────────────────────────
    const unsub = store.subscribe((evt) => {
        if (evt.type === 'selection' || evt.type === 'activeSlide') refresh();
        else if (evt.type === 'content') {
            // standard tools and the slide / shape / multi tails only re-sync;
            // an object's own settings rebuild (unless one of its fields is mid-edit)
            const rebuild = ctx.kind === 'object' && evt.origin !== 'external' && !host.isSuppressed();
            refresh({ force: rebuild });
        }
    });

    return {
        el,
        refresh,
        sync,
        // menu / keyboard entry point (Format menu, Ctrl+B on selected boxes)
        runTextCommand: (cmd, value) => { refresh(); if (ctx.textIds.length) runTextCommand(cmd, value); },
        isTextContext: () => contextOf().textIds.length > 0,
        // a text box is actually selected / being edited (not the whole-slide fallback)
        hasTextSelection: () => { const c = contextOf(); return c.textIds.length > 0 && !c.textFallback; },
        context: () => ctx,
        closePopover,
        destroy() { unsub(); closePopover(); closeMore(); if (ro) ro.disconnect(); cancelAnimationFrame(layoutRaf); el.innerHTML = ''; },
    };
}
