// assets/js/lessons/canvas/store.js — canvas editor state + undoable commands
//
// State:
//   { lesson, slides: Map<slideId, slide>, order: [slideId], activeSlideId,
//     selection: [objectId], zoom: 'fit' | number }
//
// Every content mutation is a Command { label, slideId, before, after, coalesceKey }
// where before/after map objectId → object | null (null = absent). That one
// shape covers move, resize, rotate, property edits, add, delete, duplicate,
// paste, z-order and whole-slide snapshots, so undo/redo is uniform:
// do = write `after`, undo = write `before`.
//
// Consecutive commands with the same coalesceKey inside COALESCE_MS merge into
// one undo step (typing, slider drags, arrow-key nudges).
//
// subscribe(fn) → fn({ type, slideIds, origin }) where
//   type:   'content' | 'selection' | 'activeSlide' | 'zoom' | 'history'
//   origin: 'command' | 'undo' | 'redo' | 'external'
// The builder bridges 'content' events to the lesson draft + persistDraft()
// autosave (see builder.js).

import { normalizeObject, sortByZ, generateKeyBetween, keyAbove, newObjectId, slideFingerprint, STAGE } from './model.js';

const COALESCE_MS = 900;
const HISTORY_LIMIT = 200;
const clone = (v) => (v === undefined ? undefined : JSON.parse(JSON.stringify(v)));

export function createCanvasStore({ lesson = null, slides = [], activeSlideId = null } = {}) {
    const state = {
        lesson,
        slides: new Map(slides.map((s) => [s.id, clone(s)])),
        order: slides.map((s) => s.id),
        activeSlideId: activeSlideId || (slides[0] && slides[0].id) || null,
        selection: [],
        zoom: 'fit',
    };
    const undoStack = [];
    const redoStack = [];
    const listeners = new Set();

    const emit = (evt) => listeners.forEach((fn) => { try { fn(evt); } catch (e) { console.error('[canvas store] listener failed:', e); } });

    // ── reads ────────────────────────────────────────────────────────────
    const getState = () => state;
    const getSlide = (id = state.activeSlideId) => state.slides.get(id) || null;
    const getObject = (id, slideId = state.activeSlideId) => (getSlide(slideId)?.objects || []).find((o) => o.id === id) || null;
    const getSelectedObjects = () => state.selection.map((id) => getObject(id)).filter(Boolean);

    // ── low-level write (used by do/undo) ────────────────────────────────
    function writeObjects(slideId, map) {
        const slide = state.slides.get(slideId);
        if (!slide) return;
        const byId = new Map((slide.objects || []).map((o) => [o.id, o]));
        for (const [id, obj] of Object.entries(map)) {
            if (obj === null) byId.delete(id);
            else byId.set(id, normalizeObject(clone(obj)));
        }
        slide.objects = sortByZ([...byId.values()]);
        // drop selection of objects that no longer exist
        const alive = new Set(slide.objects.map((o) => o.id));
        if (slideId === state.activeSlideId) state.selection = state.selection.filter((id) => alive.has(id));
    }

    function apply(cmd, which, origin) {
        writeObjects(cmd.slideId, which === 'undo' ? cmd.before : cmd.after);
        emit({ type: 'content', slideIds: [cmd.slideId], origin, label: cmd.label });
    }

    // ── dispatch ─────────────────────────────────────────────────────────
    // cmd: { label, slideId, before: {id: obj|null}, after: {id: obj|null}, coalesceKey?, origin? }
    function dispatch(cmd) {
        if (!cmd || !cmd.slideId || !state.slides.has(cmd.slideId)) return false;
        const changed = Object.keys(cmd.after).some((id) => JSON.stringify(cmd.after[id]) !== JSON.stringify(cmd.before[id] ?? null));
        if (!changed) return false;
        const now = Date.now();
        const top = undoStack[undoStack.length - 1];
        // coalesceMs: Infinity merges every step of one session (e.g. one inline text edit)
        const windowMs = typeof cmd.coalesceMs === 'number' ? cmd.coalesceMs : COALESCE_MS;
        if (cmd.coalesceKey && top && top.coalesceKey === cmd.coalesceKey && top.slideId === cmd.slideId && now - top.at < windowMs) {
            top.after = { ...top.after, ...cmd.after };
            Object.keys(cmd.before).forEach((id) => { if (!(id in top.before)) top.before[id] = cmd.before[id]; });
            top.at = now;
        } else {
            undoStack.push({ ...cmd, before: { ...cmd.before }, after: { ...cmd.after }, at: now });
            if (undoStack.length > HISTORY_LIMIT) undoStack.shift();
        }
        redoStack.length = 0;
        apply(cmd, 'do', cmd.origin || 'command');
        emit({ type: 'history' });
        return true;
    }

    function undo() {
        const cmd = undoStack.pop();
        if (!cmd) return false;
        redoStack.push(cmd);
        if (state.activeSlideId !== cmd.slideId && state.slides.has(cmd.slideId)) setActiveSlide(cmd.slideId);
        apply(cmd, 'undo', 'undo');
        emit({ type: 'history' });
        return true;
    }

    function redo() {
        const cmd = redoStack.pop();
        if (!cmd) return false;
        undoStack.push({ ...cmd, at: 0 }); // never coalesce into a redone step
        if (state.activeSlideId !== cmd.slideId && state.slides.has(cmd.slideId)) setActiveSlide(cmd.slideId);
        apply(cmd, 'redo', 'redo');
        emit({ type: 'history' });
        return true;
    }

    // ── non-undoable view state ──────────────────────────────────────────
    // Groups: selecting any member selects the whole group (props.groupId),
    // unless `exact` (drill-down into a group, inline text editing).
    const groupOf = (o) => (o && o.props && typeof o.props.groupId === 'string' && o.props.groupId) || null;
    function expandGroups(ids, slide) {
        const objs = slide?.objects || [];
        const groups = new Set(ids.map((id) => groupOf(objs.find((o) => o.id === id))).filter(Boolean));
        if (!groups.size) return ids;
        return [...ids, ...objs.filter((o) => groups.has(groupOf(o))).map((o) => o.id)];
    }
    function setSelection(ids, { exact = false } = {}) {
        const slide = getSlide();
        const alive = new Set((slide?.objects || []).map((o) => o.id));
        const wanted = (ids || []).filter((id) => alive.has(id));
        const next = [...new Set(exact ? wanted : expandGroups(wanted, slide))];
        if (JSON.stringify(next) === JSON.stringify(state.selection)) return;
        state.selection = next;
        emit({ type: 'selection', slideIds: [state.activeSlideId] });
    }
    function setActiveSlide(id) {
        if (!state.slides.has(id) || id === state.activeSlideId) return;
        state.activeSlideId = id;
        state.selection = [];
        emit({ type: 'activeSlide', slideIds: [id] });
    }
    function setZoom(z) {
        const next = z === 'fit' ? 'fit' : Math.min(4, Math.max(0.1, Number(z) || 1));
        if (next === state.zoom) return;
        state.zoom = next;
        emit({ type: 'zoom' });
    }

    // ── slide structure (outside undo: slide add/remove/reorder stays with the slide sidebar) ──
    function syncSlides(slidesArray) {
        const ids = slidesArray.map((s) => s.id);
        for (const id of [...state.slides.keys()]) if (!ids.includes(id)) state.slides.delete(id);
        slidesArray.forEach((s) => { if (!state.slides.has(s.id)) state.slides.set(s.id, clone(s)); });
        state.order = ids;
        if (!state.slides.has(state.activeSlideId)) { state.activeSlideId = ids[0] || null; state.selection = []; }
    }

    // External edit (properties panel, insert toolbar, layouts…) arriving as a
    // whole-slide snapshot: recorded as ONE undoable step, no write-back loop.
    function replaceSlideObjects(slide, { coalesceKey = null, label = 'Edit' } = {}) {
        const current = state.slides.get(slide.id);
        if (!current) { state.slides.set(slide.id, clone(slide)); if (!state.order.includes(slide.id)) state.order.push(slide.id); return true; }
        // carry non-object slide fields (kind/extra/board…) silently
        const { objects: _o, ...rest } = slide;
        Object.assign(current, clone(rest));
        if (slideFingerprint({ objects: current.objects }) === slideFingerprint({ objects: slide.objects })) return false;
        const before = {}, after = {};
        const prev = new Map((current.objects || []).map((o) => [o.id, o]));
        const next = new Map((slide.objects || []).map((o) => [o.id, o]));
        for (const [id, o] of prev) { if (!next.has(id)) { before[id] = clone(o); after[id] = null; } }
        for (const [id, o] of next) {
            const p = prev.get(id);
            if (!p || JSON.stringify(p) !== JSON.stringify(o)) { before[id] = p ? clone(p) : null; after[id] = clone(o); }
        }
        return dispatch({ label, slideId: slide.id, before, after, coalesceKey, origin: 'external' });
    }

    // ── command helpers ──────────────────────────────────────────────────
    const commands = {
        // updates: [{ id, x?, y?, w?, h?, rotation? }]
        setGeometry(slideId, updates, { label = 'Move', coalesceKey = null } = {}) {
            const before = {}, after = {};
            updates.forEach((u) => {
                const o = getObject(u.id, slideId);
                if (!o || o.locked) return;
                before[u.id] = clone(o);
                const n = clone(o);
                ['x', 'y', 'w', 'h', 'rotation'].forEach((k) => { if (typeof u[k] === 'number') n[k] = u[k]; });
                after[u.id] = n;
            });
            return dispatch({ label, slideId, before, after, coalesceKey });
        },
        nudge(slideId, ids, dx, dy) {
            return commands.setGeometry(slideId, ids.map((id) => {
                const o = getObject(id, slideId);
                return o ? { id, x: o.x + dx, y: o.y + dy } : null;
            }).filter(Boolean), { label: 'Nudge', coalesceKey: `nudge:${ids.join(',')}` });
        },
        updateProps(slideId, id, patch, { label = 'Edit', coalesceKey = null } = {}) {
            const o = getObject(id, slideId);
            if (!o) return false;
            const n = clone(o);
            n.props = { ...(n.props || {}), ...clone(patch) };
            return dispatch({ label, slideId, before: { [id]: clone(o) }, after: { [id]: n }, coalesceKey });
        },
        // Batch edit as ONE undoable command: updates = [{ id, props?: {…merged}, ...topLevel }].
        // Locked objects are skipped. Used by the Format toolbar for multi-selection.
        updateObjects(slideId, updates, { label = 'Edit', coalesceKey = null } = {}) {
            const before = {}, after = {};
            (updates || []).forEach((u) => {
                const o = u && getObject(u.id, slideId);
                if (!o || o.locked) return;
                const { id, props, ...rest } = u;
                before[id] = clone(o);
                after[id] = { ...clone(o), ...clone(rest), props: props ? { ...(o.props || {}), ...clone(props) } : clone(o.props || {}) };
            });
            if (!Object.keys(after).length) return false;
            return dispatch({ label, slideId, before, after, coalesceKey });
        },
        updateObject(slideId, id, patch, opts = {}) {
            const o = getObject(id, slideId);
            if (!o) return false;
            return dispatch({ label: opts.label || 'Edit', slideId, before: { [id]: clone(o) }, after: { [id]: { ...clone(o), ...clone(patch) } }, coalesceKey: opts.coalesceKey || null });
        },
        addObjects(slideId, objs, { label = 'Add', select = true } = {}) {
            const before = {}, after = {};
            objs.forEach((o) => { before[o.id] = null; after[o.id] = clone(o); });
            const ok = dispatch({ label, slideId, before, after });
            if (ok && select && slideId === state.activeSlideId) setSelection(objs.map((o) => o.id));
            return ok;
        },
        removeObjects(slideId, ids, { label = 'Delete' } = {}) {
            const before = {}, after = {};
            ids.forEach((id) => { const o = getObject(id, slideId); if (o && !o.locked) { before[id] = clone(o); after[id] = null; } });
            return dispatch({ label, slideId, before, after });
        },
        // Copies of `objs` (from any slide) placed onto slideId above everything, offset by (dx,dy).
        insertCopies(slideId, objs, { dx = 0, dy = 0, label = 'Paste' } = {}) {
            const slide = getSlide(slideId);
            if (!slide || !objs.length) return [];
            let z = keyAbove(slide.objects || []);
            const groupMap = new Map(); // copies form their own group(s), never join the originals'
            const sorted = sortByZ(objs);
            const copies = sorted.map((o) => {
                const c = { ...clone(o), id: newObjectId(), x: o.x + dx, y: o.y + dy, z, locked: false };
                const g = groupOf(o);
                if (g) {
                    if (!groupMap.has(g)) groupMap.set(g, `grp_${Date.now().toString(36)}_${groupMap.size}${Math.random().toString(36).slice(2, 6)}`);
                    c.props = { ...c.props, groupId: groupMap.get(g) };
                }
                z = generateKeyBetween(z, null);
                return c;
            });
            commands.addObjects(slideId, copies, { label });
            copies.fromIds = sorted.map((o) => o.id); // copies[i] was made from fromIds[i]
            return copies;
        },
        duplicate(slideId, ids) {
            const objs = ids.map((id) => getObject(id, slideId)).filter(Boolean);
            return commands.insertCopies(slideId, objs, { dx: 24, dy: 24, label: 'Duplicate' });
        },
        // z-order: 'front' | 'back' | 'forward' | 'backward'
        reorder(slideId, ids, where) {
            const slide = getSlide(slideId);
            if (!slide) return false;
            const sorted = sortByZ(slide.objects || []);
            const sel = new Set(ids);
            const before = {}, after = {};
            const set = (o, z) => { before[o.id] = clone(o); after[o.id] = { ...clone(o), z }; };
            if (where === 'front' || where === 'back') {
                const moving = sorted.filter((o) => sel.has(o.id));
                const rest = sorted.filter((o) => !sel.has(o.id));
                let lo = where === 'front' ? (rest.length ? rest[rest.length - 1].z : null) : null;
                const hi = where === 'front' ? null : (rest.length ? rest[0].z : null);
                moving.forEach((o) => { const z = generateKeyBetween(lo, hi); set(o, z); lo = z; });
            } else {
                const up = where === 'forward';
                const list = up ? [...sorted].reverse() : sorted;
                list.forEach((o, i) => {
                    if (!sel.has(o.id)) return;
                    const neighbour = list[i - 1];          // the one just above (forward) / below (backward)
                    if (!neighbour || sel.has(neighbour.id)) return;
                    const beyond = list[i - 2];
                    const z = up
                        ? generateKeyBetween(neighbour.z, beyond ? beyond.z : null)
                        : generateKeyBetween(beyond ? beyond.z : null, neighbour.z);
                    set(o, z);
                });
            }
            return dispatch({ label: 'Arrange', slideId, before, after });
        },
        // edge: left | center | right | top | middle | bottom. One object aligns
        // to the slide; several align to their combined bounds.
        align(slideId, ids, edge) {
            const objs = ids.map((id) => getObject(id, slideId)).filter((o) => o && !o.locked);
            if (!objs.length) return false;
            const box = objs.length === 1 && ids.length === 1
                ? { x0: 0, y0: 0, x1: STAGE.w, y1: STAGE.h }
                : boundsOf(ids.map((id) => getObject(id, slideId)).filter(Boolean));
            const cx = (box.x0 + box.x1) / 2, cy = (box.y0 + box.y1) / 2;
            const r2 = (v) => Math.round(v * 100) / 100;
            return commands.setGeometry(slideId, objs.map((o) => {
                const u = { id: o.id };
                if (edge === 'left') u.x = box.x0;
                else if (edge === 'center') u.x = cx - o.w / 2;
                else if (edge === 'right') u.x = box.x1 - o.w;
                else if (edge === 'top') u.y = box.y0;
                else if (edge === 'middle') u.y = cy - o.h / 2;
                else if (edge === 'bottom') u.y = box.y1 - o.h;
                if (typeof u.x === 'number') u.x = r2(u.x);
                if (typeof u.y === 'number') u.y = r2(u.y);
                return u;
            }), { label: 'Align' });
        },
        // axis: 'h' | 'v' — equal gaps between 3+ objects, outermost stay put.
        distribute(slideId, ids, axis) {
            const objs = ids.map((id) => getObject(id, slideId)).filter(Boolean);
            if (objs.length < 3) return false;
            const pos = axis === 'v' ? 'y' : 'x', size = axis === 'v' ? 'h' : 'w';
            const sorted = [...objs].sort((a, b) => a[pos] - b[pos]);
            const first = sorted[0], last = sorted[sorted.length - 1];
            const span = last[pos] + last[size] - first[pos];
            const gap = (span - sorted.reduce((t, o) => t + o[size], 0)) / (sorted.length - 1);
            let at = first[pos] + first[size] + gap;
            const updates = [];
            sorted.slice(1, -1).forEach((o) => { updates.push({ id: o.id, [pos]: Math.round(at * 100) / 100 }); at += o[size] + gap; });
            return commands.setGeometry(slideId, updates, { label: 'Distribute' });
        },
        group(slideId, ids) {
            const objs = ids.map((id) => getObject(id, slideId)).filter(Boolean);
            if (objs.length < 2) return false;
            const gid = `grp_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 7)}`;
            const before = {}, after = {};
            objs.forEach((o) => { before[o.id] = clone(o); after[o.id] = { ...clone(o), props: { ...(o.props || {}), groupId: gid } }; });
            return dispatch({ label: 'Group', slideId, before, after });
        },
        ungroup(slideId, ids) {
            const objs = ids.map((id) => getObject(id, slideId)).filter((o) => groupOf(o));
            if (!objs.length) return false;
            const before = {}, after = {};
            objs.forEach((o) => {
                const { groupId, ...props } = o.props || {};
                before[o.id] = clone(o); after[o.id] = { ...clone(o), props };
            });
            return dispatch({ label: 'Ungroup', slideId, before, after });
        },
    };

    function boundsOf(objs) {
        return objs.reduce((b, o) => ({
            x0: Math.min(b.x0, o.x), y0: Math.min(b.y0, o.y), x1: Math.max(b.x1, o.x + o.w), y1: Math.max(b.y1, o.y + o.h),
        }), { x0: Infinity, y0: Infinity, x1: -Infinity, y1: -Infinity });
    }

    return {
        getState, getSlide, getObject, getSelectedObjects,
        dispatch, undo, redo,
        canUndo: () => undoStack.length > 0,
        canRedo: () => redoStack.length > 0,
        setSelection, setActiveSlide, setZoom, syncSlides, replaceSlideObjects,
        commands, groupOf,
        subscribe(fn) { listeners.add(fn); return () => listeners.delete(fn); },
        destroy() { listeners.clear(); undoStack.length = 0; redoStack.length = 0; },
    };
}
