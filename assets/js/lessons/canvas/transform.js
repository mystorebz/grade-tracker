// assets/js/lessons/canvas/transform.js — direct manipulation for the canvas editor
//
// Moveable (drag / resize / rotate / snap) + Selecto (click, Shift-click,
// marquee) over a renderer.js stage handle. Pure view layer:
//   - reads geometry from the store, previews gestures by writing styles on the
//     object elements directly (applyObjectGeometry), and
//   - commits exactly ONE store command per gesture on *End
//     (store.commands.setGeometry), so every move/resize/rotate is one undo step.
//
// Coordinates: object elements live inside .cv-stage, which is scaled with
// `transform: scale(k)`. Moveable measures targets through their full CSS
// transform chain, so beforeTranslate / width / height / rotate arrive in the
// target's own (unscaled) CSS px = stage units. Guidelines, however, are read
// in SCREEN px relative to snapContainer (the stage), so they are re-scaled by
// k on every zoom change (setGuidelines) — verified at 0.5×/1×/2×.
//
//   const engine = createTransformEngine({ handle, store, controlsContainer, selectArea, onEditText });
//   engine.sync();          // after every renderSlide(): targets ← store selection
//   engine.setEditing(id);  // hide controls while an inline text editor is open (null to end)
//   engine.destroy();

import { STAGE, normalizeRotation } from './model.js';
import { applyObjectGeometry } from './renderer.js';
import { createLineHandles } from './tools/line.js';

const r2 = (v) => Math.round(v * 100) / 100;
const DIRS = { top: true, left: true, bottom: true, right: true, center: true, middle: true };

export function createTransformEngine({ handle, store, controlsContainer, selectArea, onEditText = null, onGestureEnd = null }) {
    const MoveableCtor = window.Moveable;
    const SelectoCtor = window.Selecto;
    if (!MoveableCtor || !SelectoCtor) throw new Error('Moveable/Selecto not loaded');

    const stageEl = handle.stage;
    let targets = [];
    let editingId = null;
    let gesture = null;          // { slideId, start: Map(id → obj), frame: Map(id → geom) }
    let shiftDown = false;

    const idOf = (el) => el && el.dataset ? el.dataset.objectId : null;
    const elOf = (id) => handle.nodes.get(id)?.el || null;

    const moveable = new MoveableCtor(controlsContainer, {
        target: [],
        className: 'cv-moveable',
        draggable: true, resizable: true, rotatable: true, snappable: true,
        origin: false, keepRatio: false, checkInput: true,
        throttleDrag: 0, throttleResize: 0, throttleRotate: 0,
        rotationPosition: 'top',
        renderDirections: ['nw', 'n', 'ne', 'w', 'e', 'sw', 's', 'se'],
        snapContainer: stageEl,
        snapThreshold: 6,
        snapDirections: DIRS,
        elementSnapDirections: DIRS,
        verticalGuidelines: [],
        horizontalGuidelines: [],
        elementGuidelines: [],
        isDisplaySnapDigit: false,
        isDisplayInnerSnapDigit: false,
        snapRotationThreshold: 4,
        snapRotationDegrees: [0, 90, 180, 270],
    });

    // Single selected line: Moveable only drags it; its two endpoint grips
    // replace resize/rotate (tools/line.js).
    const lineHandles = createLineHandles({ handle, store, container: controlsContainer });

    const selecto = new SelectoCtor({
        container: selectArea,
        dragContainer: selectArea,
        rootContainer: selectArea,
        selectableTargets: [],
        selectByClick: true,
        selectFromInside: false,
        continueSelect: false,
        toggleContinueSelect: [['shift'], ['ctrl'], ['meta']],
        keyContainer: window,
        hitRate: 0,
        ratio: 0,
        checkInput: true,
        preventClickEventOnDrag: true,
    });

    // ── gesture bookkeeping ─────────────────────────────────────────────
    function begin(els) {
        const slideId = store.getState().activeSlideId;
        const start = new Map(), frame = new Map();
        els.forEach((el) => {
            const id = idOf(el);
            const o = store.getObject(id);
            if (!o) return;
            start.set(id, o);
            frame.set(id, { x: o.x, y: o.y, w: o.w, h: o.h, rotation: o.rotation || 0 });
        });
        gesture = { slideId, start, frame };
    }

    function preview(el, patch) {
        if (!gesture) return;
        const id = idOf(el);
        const f = gesture.frame.get(id), o = gesture.start.get(id), node = handle.nodes.get(id);
        if (!f || !o || !node) return;
        Object.assign(f, patch);
        applyObjectGeometry(node, o, f);
        if (o.type === 'line') lineHandles.refresh();
    }

    function commit(label, moved) {
        const g = gesture;
        gesture = null;
        if (!g) return;
        if (moved) {
            const updates = [...g.frame].map(([id, f]) => ({
                id, x: r2(f.x), y: r2(f.y), w: r2(f.w), h: r2(f.h), rotation: normalizeRotation(r2(f.rotation)),
            }));
            const changed = store.commands.setGeometry(g.slideId, updates, { label });
            if (!changed) restore(g);
        } else {
            restore(g);
        }
        onGestureEnd && onGestureEnd(label);
        moveable.updateRect();
    }

    function restore(g) {
        g.start.forEach((o, id) => { const node = handle.nodes.get(id); if (node) applyObjectGeometry(node, o, o); });
    }

    const delta = (start, t) => ({ x: start.x + t[0], y: start.y + t[1] });

    // ── drag ────────────────────────────────────────────────────────────
    moveable.on('dragStart', (e) => { begin([e.target]); e.set([0, 0]); })
        .on('drag', (e) => { const s = gesture?.start.get(idOf(e.target)); if (s) preview(e.target, delta(s, e.beforeTranslate)); })
        .on('dragEnd', (e) => commit('Move', e.isDrag))
        .on('dragGroupStart', (e) => { begin(e.targets); e.events.forEach((ev) => ev.set([0, 0])); })
        .on('dragGroup', (e) => e.events.forEach((ev) => { const s = gesture?.start.get(idOf(ev.target)); if (s) preview(ev.target, delta(s, ev.beforeTranslate)); }))
        .on('dragGroupEnd', (e) => commit('Move', e.isDrag));

    // ── resize ──────────────────────────────────────────────────────────
    const resizeStart = (ev) => { ev.setOrigin(['%', '%']); ev.dragStart && ev.dragStart.set([0, 0]); };
    const resizeMove = (ev) => {
        const s = gesture?.start.get(idOf(ev.target));
        if (!s) return;
        preview(ev.target, { w: ev.width, h: ev.height, ...delta(s, ev.drag.beforeTranslate) });
    };
    moveable.on('resizeStart', (e) => { begin([e.target]); resizeStart(e); })
        .on('resize', resizeMove)
        .on('resizeEnd', (e) => commit('Resize', e.isDrag))
        .on('resizeGroupStart', (e) => { begin(e.targets); e.events.forEach(resizeStart); })
        .on('resizeGroup', (e) => e.events.forEach(resizeMove))
        .on('resizeGroupEnd', (e) => commit('Resize', e.isDrag));

    // ── rotate ──────────────────────────────────────────────────────────
    const rotateStart = (ev) => {
        const s = gesture?.start.get(idOf(ev.target));
        ev.set(s ? s.rotation || 0 : 0);
        ev.dragStart && ev.dragStart.set([0, 0]);
    };
    const rotateMove = (ev) => {
        const s = gesture?.start.get(idOf(ev.target));
        if (!s) return;
        let deg = ev.rotate;
        if (shiftDown) deg = Math.round(deg / 15) * 15;
        const patch = { rotation: deg };
        if (ev.drag) Object.assign(patch, delta(s, ev.drag.beforeTranslate));
        preview(ev.target, patch);
    };
    moveable.on('rotateStart', (e) => { begin([e.target]); rotateStart(e); })
        .on('rotate', rotateMove)
        .on('rotateEnd', (e) => commit('Rotate', e.isDrag))
        .on('rotateGroupStart', (e) => { begin(e.targets); e.events.forEach(rotateStart); })
        .on('rotateGroup', (e) => e.events.forEach(rotateMove))
        .on('rotateGroupEnd', (e) => commit('Rotate', e.isDrag));

    // ── selection ───────────────────────────────────────────────────────
    // Topmost object element under a point (the group control box sits above
    // the objects, so e.target alone can't tell which object was pressed).
    function objectAt(x, y) {
        for (const el of document.elementsFromPoint(x, y)) {
            if (moveable.isMoveableElement(el)) continue;
            const o = el.closest && el.closest('.cv-obj');
            if (o && o.parentNode === stageEl) return o;
            if (el === stageEl) return null;
        }
        return null;
    }

    // A press that is released before the hand-off frame was a plain click:
    // starting the drag then would leave Moveable dragging with no button down.
    let pointerIsDown = false;
    let pendingHandoff = null;   // { ids, x, y } while a press waits for its drag hand-off frame
    const onDown = () => { pointerIsDown = true; };
    const onUp = (e) => {
        pointerIsDown = false;
        // Released before the hand-off frame: a fast flick still moves the object.
        if (pendingHandoff && e && typeof e.clientX === 'number') {
            const p = pendingHandoff;
            pendingHandoff = null;
            const k = handle.scale || 1;
            const dx = (e.clientX - p.x) / k, dy = (e.clientY - p.y) / k;
            if (Math.hypot(e.clientX - p.x, e.clientY - p.y) > 3) {
                const slideId = store.getState().activeSlideId;
                store.commands.setGeometry(slideId, p.ids.map((id) => {
                    const o = store.getObject(id);
                    return o ? { id, x: r2(o.x + dx), y: r2(o.y + dy) } : null;
                }).filter(Boolean), { label: 'Move' });
            }
        }
        // Moveable normally ends its gesture on this same pointerup; if it
        // didn't (hand-off raced the release), finish it so nothing stays stuck.
        setTimeout(() => { if (gesture && !pointerIsDown) commit('Move', true); }, 0);
    };
    window.addEventListener('pointerdown', onDown, true);
    window.addEventListener('pointerup', onUp, true);
    window.addEventListener('pointercancel', onUp, true);

    function selectAndDrag(ids, inputEvent) {
        inputEvent.preventDefault();
        const ready = moveable.waitToChangeTarget();
        const unlocked = ids.filter((id) => !store.getObject(id)?.locked);
        pendingHandoff = unlocked.length ? { ids: unlocked, x: inputEvent.clientX, y: inputEvent.clientY } : null;
        store.setSelection(ids);
        // Moveable finishes wiring the new target's ables one frame later;
        // starting the drag earlier throws inside Draggable (dragInfo null).
        ready.then(() => requestAnimationFrame(() => {
            if (!pendingHandoff) return;          // already released (handled in onUp)
            pendingHandoff = null;
            if (!gesture && pointerIsDown) moveable.dragStart(inputEvent);
        }));
    }

    selecto.on('dragStart', (e) => {
        const ev = e.inputEvent, t = ev.target;
        if (t && t.closest && t.closest('.cv-line-grip')) { e.stop(); return; }
        if (gesture && pointerIsDown) { e.stop(); return; }
        if (gesture) commit('Move', true); // stale gesture from a lost pointerup
        if (editingId) {
            const editEl = elOf(editingId);
            if (editEl && editEl.contains(t)) { e.stop(); return; }
        }
        // The control box (incl. a group's drag area) belongs to Moveable; a
        // plain/Shift click inside a group arrives via 'clickGroup' below.
        if (moveable.isMoveableElement(t)) { e.stop(); return; }
        const hit = objectAt(ev.clientX, ev.clientY);
        const additive = ev.shiftKey || ev.ctrlKey || ev.metaKey;
        if (additive && hit) {
            // Shift/Ctrl-click toggles one object; Shift-drag on empty space = additive marquee.
            e.stop();
            const id = idOf(hit), sel = store.getState().selection;
            store.setSelection(sel.includes(id) ? sel.filter((x) => x !== id) : [...sel, id]);
            return;
        }
        if (hit && targets.includes(hit)) e.stop();
    });

    // Click (no drag) inside a group box: select / toggle the object actually
    // under the pointer. A plain click drills into a grouped object (exact).
    moveable.on('clickGroup', (e) => {
        const hit = objectAt(e.inputEvent.clientX, e.inputEvent.clientY);
        if (!hit) return;
        const id = idOf(hit), sel = store.getState().selection;
        const additive = e.inputEvent.shiftKey || e.inputEvent.ctrlKey || e.inputEvent.metaKey;
        if (additive) store.setSelection(sel.includes(id) ? sel.filter((x) => x !== id) : [...sel, id], { exact: true });
        else store.setSelection([id], { exact: true });
    });

    selecto.on('selectEnd', (e) => {
        const ids = e.selected.map(idOf).filter(Boolean);
        const same = ids.length === targets.length && ids.every((id, i) => id === idOf(targets[i]));
        if (e.isDragStartEnd && ids.length && !same) {
            // Press-and-drag on an unselected object: select it, then hand the
            // same pointer-down to Moveable so the drag continues in one motion.
            selectAndDrag(ids, e.inputEvent);
            return;
        }
        store.setSelection(ids);
    });

    // On the select area (not the stage): a group's control box sits above the objects.
    const onDblClick = (e) => {
        const id = idOf(objectAt(e.clientX, e.clientY));
        if (!id || id === editingId) return;
        const o = store.getObject(id);
        if (o && !o.locked && onEditText) onEditText(id, e);
    };
    selectArea.addEventListener('dblclick', onDblClick);

    // Shift: keep aspect ratio while resizing, 15° steps while rotating.
    const onKey = (e) => {
        if (e.key !== 'Shift') return;
        shiftDown = e.type === 'keydown';
        moveable.keepRatio = shiftDown;
    };
    const onBlur = () => { shiftDown = false; moveable.keepRatio = false; };
    window.addEventListener('keydown', onKey);
    window.addEventListener('keyup', onKey);
    window.addEventListener('blur', onBlur);

    function setGuidelines() {
        const k = handle.scale || 1;
        moveable.verticalGuidelines = [0, STAGE.w / 2, STAGE.w].map((v) => v * k);
        moveable.horizontalGuidelines = [0, STAGE.h / 2, STAGE.h].map((v) => v * k);
    }
    setGuidelines();
    const offScale = handle.onScale(() => { setGuidelines(); moveable.updateRect(); lineHandles.refresh(); });

    // ── public ──────────────────────────────────────────────────────────
    function sync() {
        if (gesture && pointerIsDown) return; // never swap targets mid-gesture
        const st = store.getState();
        const all = [...stageEl.querySelectorAll(':scope > .cv-obj')];
        selecto.selectableTargets = all;
        const selected = editingId ? [] : st.selection.map(elOf).filter(Boolean);
        targets = selected;
        const selObjs = editingId ? [] : st.selection.map((id) => store.getObject(id)).filter(Boolean);
        const locked = selObjs.some((o) => o.locked);
        const singleLine = selObjs.length === 1 && selObjs[0].type === 'line';
        moveable.draggable = !locked;
        moveable.resizable = !locked && !singleLine;
        moveable.rotatable = !locked && !singleLine;
        lineHandles.sync(singleLine ? selObjs[0] : null);
        moveable.elementGuidelines = all.filter((el) => !selected.includes(el));
        moveable.target = selected;
        selecto.setSelectedTargets(st.selection.map(elOf).filter(Boolean));
        moveable.updateRect();
        lineHandles.refresh();
    }

    function setEditing(id) {
        editingId = id || null;
        sync();
    }

    function destroy() {
        window.removeEventListener('keydown', onKey);
        window.removeEventListener('keyup', onKey);
        window.removeEventListener('blur', onBlur);
        selectArea.removeEventListener('dblclick', onDblClick);
        window.removeEventListener('pointerdown', onDown, true);
        window.removeEventListener('pointerup', onUp, true);
        window.removeEventListener('pointercancel', onUp, true);
        offScale();
        lineHandles.destroy();
        try { moveable.destroy(); } catch (e) { /* already gone */ }
        try { selecto.destroy(); } catch (e) { /* already gone */ }
        gesture = null;
        targets = [];
    }

    return {
        sync, setEditing, destroy,
        updateRect: () => { moveable.updateRect(); lineHandles.refresh(); },
        isGesturing: () => !!gesture,
        get moveable() { return moveable; },
        get selecto() { return selecto; },
    };
}
