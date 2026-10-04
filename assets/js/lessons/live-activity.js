// assets/js/lessons/live-activity.js — questions the teacher asks DURING a live
// session (not part of the saved lesson): poll, quiz question, open response,
// sticky-note board.
//
//   Teacher (lessons/live.js)   openActivityComposer() → launch → monitor card
//   Student (lessons/viewer.js) the open activity appears as a card over the lesson
//
// Storage — the live session doc (teacher-writable, student-readable):
//   activities: [{ id, type, props, slideId, x, y, w, h, z, openedAt }]
//               every activity asked this session; slideId + geometry (1600×900
//               stage units) put it ON the slide the teacher was showing, in a
//               free spot, so every screen draws it in the same place
//   activityId: id | null                          the one open right now
// On a slide it is rendered as a normal canvas widget (withActivity()); in a
// document lesson it shows as a card pinned over the page (pinCardToBox()).
// Answers use the same responses subcollection as lesson widgets
// ({studentId}_{activityId}, blockType = type), so firestore.rules' caps,
// identity, enrollment and one-vote locks apply unchanged. A quiz's correct
// answer goes to work_answer_keys/{lessonId}_{activityId} (never on the
// session doc); submitLessonQuizAnswer reads the options from `activities`.
// Activity ids start with "live_" so pruneLessonQuizKeys keeps their keys.

import { WIDGET_META, WIDGET_CSS, widgetMarkup, widgetKey, updateWidgetLive, newOption, createWidget } from './canvas/tools/interactive.js';
import { STAGE, keyAbove } from './canvas/model.js';

export const LIVE_ACTIVITY_TYPES = Object.freeze(['poll', 'quiz', 'open_response', 'board']);
const MAX_OPTIONS = 8;

const esc = (v) => String(v ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#039;' }[c]));

export function newLiveActivityId() {
    return `live_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 8)}`;
}

export function activityById(sessionData, id) {
    const list = sessionData && Array.isArray(sessionData.activities) ? sessionData.activities : [];
    return list.find((a) => a && a.id === id) || null;
}

// The activity students should see now (null when none is open / session over).
export function openActivity(sessionData) {
    if (!sessionData || sessionData.endedAt || !sessionData.activityId) return null;
    return activityById(sessionData, sessionData.activityId);
}

// ── on the slide ──────────────────────────────────────────────────────────
function activitySize(type, props) {
    const n = Array.isArray(props && props.options) ? props.options.length : 0;
    if (type === 'poll' || type === 'quiz') return { w: 760, h: Math.min(780, 330 + n * 86) };
    if (type === 'open_response') return { w: 860, h: props && props.mode === 'long' ? 520 : 420 };
    return { w: 1100, h: 620 }; // board
}

// Free spot for a new activity on a slide: the position (on a 20-unit grid,
// 40 units from the edges) that covers the least of what is already there;
// ties go to the spot nearest the centre.
export function placeActivity(type, props, objects = []) {
    const W = STAGE.w, H = STAGE.h, M = 40;
    let { w, h } = activitySize(type, props);
    w = Math.min(w, W - 2 * M);
    h = Math.min(h, H - 2 * M);
    const boxes = (objects || []).filter((o) => o && !o.hidden && (o.opacity === undefined || o.opacity > 0))
        .map((o) => ({ x0: o.x, y0: o.y, x1: o.x + o.w, y1: o.y + o.h }));
    let best = null;
    for (let y = M; y <= H - M - h; y += 20) {
        for (let x = M; x <= W - M - w; x += 20) {
            let cover = 0;
            for (const b of boxes) {
                const ix = Math.min(x + w, b.x1) - Math.max(x, b.x0);
                const iy = Math.min(y + h, b.y1) - Math.max(y, b.y0);
                if (ix > 0 && iy > 0) cover += ix * iy;
            }
            const dist = Math.hypot(x + w / 2 - W / 2, y + h / 2 - H / 2);
            if (!best || cover < best.cover - 1 || (Math.abs(cover - best.cover) <= 1 && dist < best.dist)) best = { x, y, cover, dist };
        }
    }
    return { x: best ? best.x : M, y: best ? best.y : M, w, h, z: keyAbove(objects || []) };
}

// The activity as a canvas widget object.
export function activityObject(act) {
    return createWidget(act.type, [], {
        id: act.id, x: act.x, y: act.y, w: act.w, h: act.h, z: act.z || 'zz',
        props: { ...(act.props || {}), contentScale: 2 },
    });
}

// The slide with the activity drawn on it (when the activity belongs to it).
export function withActivity(slide, act) {
    if (!slide || !act || act.slideId !== slide.id || typeof act.x !== 'number') return slide;
    return { ...slide, objects: [...(slide.objects || []).filter((o) => o.id !== act.id), activityObject(act)] };
}

// Same checks as the editor's publish gate. → string[] (empty = ok)
export function activityProblems(type, props, correctIds = []) {
    const out = [];
    const p = props || {};
    if (type === 'poll' || type === 'quiz') {
        const opts = Array.isArray(p.options) ? p.options : [];
        if (!String(p.question || '').trim()) out.push('Type a question.');
        if (opts.length < 2) out.push('Add at least two options.');
        else if (opts.some((o) => !String((o && o.text) || '').trim())) out.push('Fill in every option (or remove the empty one).');
        if (type === 'quiz' && !correctIds.some((id) => opts.some((o) => o.id === id))) out.push('Mark the correct answer.');
    } else if (!String(p.prompt || '').trim()) {
        out.push(type === 'board' ? 'Type a prompt for the board.' : 'Type a question.');
    }
    return out;
}

// ── styles ────────────────────────────────────────────────────────────────
const CSS = `
.lact-modal-back { position: fixed; inset: 0; z-index: 2147483100; background: rgba(13,31,53,.55); display: flex; align-items: center; justify-content: center; padding: 16px; }
.lact-modal { width: min(560px, 100%); max-height: calc(100vh - 32px); overflow: auto; background: #fff; border-radius: 16px; box-shadow: 0 24px 60px rgba(13,31,53,.35); font-family: 'DM Sans', system-ui, sans-serif; color: #0d1f35; }
.lact-modal header { display: flex; align-items: center; justify-content: space-between; gap: 12px; padding: 16px 20px 6px; }
.lact-modal h2 { margin: 0; font-size: 17px; font-weight: 900; }
.lact-modal .lact-sub { margin: 0 20px 12px; font-size: 12px; font-weight: 600; color: #6b84a0; }
.lact-x { border: 0; background: none; width: 34px; height: 34px; border-radius: 8px; color: #6b84a0; cursor: pointer; font-size: 15px; }
.lact-x:hover { background: #f1f5f9; color: #0d1f35; }
.lact-body { padding: 0 20px 6px; display: flex; flex-direction: column; gap: 14px; }
.lact-types { display: grid; grid-template-columns: repeat(4, 1fr); gap: 6px; }
.lact-type { display: flex; flex-direction: column; align-items: center; gap: 4px; padding: 10px 6px; border-radius: 10px; border: 1.5px solid #dce3ed; background: #fff; cursor: pointer; font: inherit; font-size: 11.5px; font-weight: 800; color: #374f6b; }
.lact-type i { font-size: 16px; color: #6366f1; }
.lact-type[aria-pressed="true"] { border-color: #4f46e5; background: #eef2ff; color: #312e81; }
.lact-label { font-size: 11px; font-weight: 900; text-transform: uppercase; letter-spacing: .06em; color: #6b84a0; margin-bottom: 5px; display: block; }
.lact-input { width: 100%; box-sizing: border-box; border: 1.5px solid #dce3ed; border-radius: 9px; padding: 9px 11px; font: inherit; font-size: 14px; color: #0d1f35; }
.lact-input:focus { outline: none; border-color: #6366f1; box-shadow: 0 0 0 3px rgba(99,102,241,.15); }
.lact-opt { display: flex; align-items: center; gap: 6px; margin-bottom: 6px; }
.lact-opt .lact-input { padding: 7px 10px; font-size: 13.5px; }
.lact-ok { flex-shrink: 0; width: 34px; height: 34px; border-radius: 8px; border: 1.5px solid #dce3ed; background: #fff; color: #9ab0c6; cursor: pointer; }
.lact-ok[aria-pressed="true"] { border-color: #059669; background: #ecfdf5; color: #047857; }
.lact-rm { flex-shrink: 0; width: 30px; height: 30px; border: 0; border-radius: 8px; background: none; color: #9ab0c6; cursor: pointer; }
.lact-rm:hover:not(:disabled) { background: #fef2f2; color: #dc2626; }
.lact-rm:disabled { opacity: .35; cursor: default; }
.lact-add { border: 1.5px dashed #c7d2fe; background: #f8faff; color: #4338ca; border-radius: 9px; padding: 7px 12px; font: inherit; font-size: 12.5px; font-weight: 800; cursor: pointer; }
.lact-add:disabled { opacity: .4; cursor: default; }
.lact-seg { display: inline-flex; border: 1.5px solid #dce3ed; border-radius: 9px; overflow: hidden; }
.lact-seg button { border: 0; background: #fff; padding: 7px 12px; font: inherit; font-size: 12.5px; font-weight: 700; color: #374f6b; cursor: pointer; }
.lact-seg button[aria-pressed="true"] { background: #eef2ff; color: #312e81; }
.lact-errors { margin: 0; padding: 9px 12px; border-radius: 9px; background: #fef2f2; color: #b91c1c; font-size: 12.5px; font-weight: 700; list-style: none; }
.lact-errors li + li { margin-top: 3px; }
.lact-foot { display: flex; justify-content: flex-end; gap: 8px; padding: 14px 20px 18px; }
.lact-btn { border: 0; border-radius: 10px; padding: 10px 16px; font: inherit; font-size: 13px; font-weight: 800; cursor: pointer; }
.lact-btn-ghost { background: #f1f5f9; color: #374f6b; }
.lact-btn-go { background: #4f46e5; color: #fff; }
.lact-btn-go:disabled { opacity: .6; cursor: default; }
.lact-btn:focus-visible, .lact-type:focus-visible, .lact-ok:focus-visible { outline: 2px solid #6366f1; outline-offset: 2px; }

.lact-card { position: relative; border-radius: 14px; border: 2px solid #6366f1; background: #fff; box-shadow: 0 10px 30px rgba(49,46,129,.18); font-family: 'DM Sans', system-ui, sans-serif; overflow: hidden; }
.lact-card-bar { display: flex; align-items: center; gap: 8px; padding: 8px 10px 8px 14px; background: #eef2ff; color: #312e81; font-size: 12px; font-weight: 900; }
.lact-card-bar .lact-live-dot { width: 8px; height: 8px; border-radius: 50%; background: #ef4444; box-shadow: 0 0 0 3px rgba(239,68,68,.2); flex-shrink: 0; }
.lact-card-bar .lact-grow { flex: 1; min-width: 0; }
.lact-card-bar button { border: 0; border-radius: 8px; padding: 6px 10px; font: inherit; font-size: 11.5px; font-weight: 800; cursor: pointer; background: #fff; color: #312e81; }
.lact-card-bar button:hover { background: #e0e7ff; }
.lact-card-bar .lact-danger { background: #e11d48; color: #fff; }
.lact-card-bar .lact-danger:hover { background: #be123c; }
.lact-card .cv-obj { position: static; }
.lact-card .cv-w { height: auto; max-height: min(52vh, 460px); overflow-y: auto; border: 0; border-radius: 0; box-shadow: none; font-size: 14px; }
.lact-card .cv-w-q { font-size: 16px; }
.lact-card .cv-w-opt { font-size: 14px; padding: 9px 12px; }
.lact-card.lact-min .lact-card-body { display: none; }

.lact-student { position: fixed; z-index: 40; display: flex; flex-direction: column; box-sizing: border-box; }
.lact-student .lact-card-body { min-height: 0; overflow-y: auto; }
.lact-student .cv-w { max-height: none; overflow: visible; }
.lact-teacher { margin: 0 0 16px; }
.lact-teacher.lact-bar-only { border-width: 1.5px; box-shadow: none; }
.lact-teacher.lact-bar-only .lact-card-body { display: none; }
`;

export function injectActivityCss() {
    if (!document.getElementById('lact-css')) {
        const s = document.createElement('style');
        s.id = 'lact-css';
        s.textContent = CSS;
        document.head.appendChild(s);
    }
    // the widget styles normally come with a slide stage; documents may not have one
    if (!['lact-widget-css', 'cv-renderer-styles', 'doc-widget-styles'].some((id) => document.getElementById(id))) {
        const w = document.createElement('style');
        w.id = 'lact-widget-css';
        w.textContent = WIDGET_CSS;
        document.head.appendChild(w);
    }
}

// Paint one activity into a card body; the form is rebuilt only when its
// structure changes, so a half-typed answer survives snapshots.
export function paintActivity(bodyEl, obj, mode, ctx) {
    const key = `${obj.id}|${widgetKey(obj, mode, ctx)}`;
    if (bodyEl.__lactKey !== key) {
        bodyEl.innerHTML = `<div class="cv-obj" data-object-id="${esc(obj.id)}">${widgetMarkup(obj, mode, ctx)}</div>`;
        bodyEl.__lactKey = key;
    }
    updateWidgetLive(bodyEl, obj, mode, ctx);
}

// ── student: keep the card inside the slide ───────────────────────────────
// Pins `card` (position: fixed) over the box returned by getBox() — the slide
// on screen, or the document reading area — centred near its bottom edge and
// scaled with it (CSS zoom), so it looks the same on a phone, a laptop or in
// full screen and never spills outside the lesson. Follows the box every
// frame while shown (slide changes, resizes, full screen). → stop()
export function pinCardToBox(card, getBox) {
    let raf = 0;
    let last = '';
    function place() {
        raf = requestAnimationFrame(place);
        if (card.classList.contains('hidden')) return;
        const box = getBox();
        if (!box || !box.width || !box.height) return;
        const z = Math.max(0.55, Math.min(1.3, box.width / 760));
        const width = Math.min(box.width * 0.88, 640 * z);
        const maxH = box.height * 0.9;
        const key = `${Math.round(box.left)}|${Math.round(box.top)}|${Math.round(box.width)}|${Math.round(box.height)}`;
        if (key !== last) {
            last = key;
            card.style.zoom = String(z);
            card.style.width = `${width / z}px`;
            card.style.maxHeight = `${maxH / z}px`;
        }
        const h = card.getBoundingClientRect().height; // already zoomed
        const left = box.left + (box.width - width) / 2;
        const top = Math.max(box.top + box.height * 0.05, box.bottom - h - box.height * 0.05);
        // fixed coordinates are in unzoomed CSS px; zoom scales them, so divide
        card.style.left = `${left / z}px`;
        card.style.top = `${top / z}px`;
    }
    place();
    return () => cancelAnimationFrame(raf);
}

// ── teacher: composer ─────────────────────────────────────────────────────
// onLaunch({ type, props, correctIds }) → Promise (throws to keep the form open)
export function openActivityComposer({ onLaunch }) {
    injectActivityCss();
    const host = document.fullscreenElement || document.body;
    const prevFocus = document.activeElement;
    const state = {
        type: 'poll',
        text: '',
        options: [newOption(''), newOption('')],
        correct: [],
        multiple: false,
        mode: 'short',
    };
    const back = document.createElement('div');
    back.className = 'lact-modal-back';
    back.innerHTML = `<div class="lact-modal" role="dialog" aria-modal="true" aria-labelledby="lactTitle"></div>`;
    const modal = back.firstElementChild;
    host.appendChild(back);

    let errors = [];
    let busy = false;
    const isChoice = () => state.type === 'poll' || state.type === 'quiz';

    function render() {
        const optRows = state.options.map((o, i) => `
            <div class="lact-opt">
                ${state.type === 'quiz' ? `<button type="button" class="lact-ok" data-ok="${esc(o.id)}" aria-pressed="${state.correct.includes(o.id)}" title="${state.correct.includes(o.id) ? 'Correct answer' : 'Mark as correct'}" aria-label="Mark option ${i + 1} as the correct answer"><i class="fa-solid fa-check"></i></button>` : ''}
                <input class="lact-input" data-opt="${esc(o.id)}" value="${esc(o.text)}" placeholder="Option ${i + 1}" maxlength="200" aria-label="Option ${i + 1}">
                <button type="button" class="lact-rm" data-rm="${esc(o.id)}" ${state.options.length <= 2 ? 'disabled' : ''} title="Remove option" aria-label="Remove option ${i + 1}"><i class="fa-solid fa-xmark"></i></button>
            </div>`).join('');
        const label = state.type === 'board' ? 'Prompt' : 'Question';
        modal.innerHTML = `
            <header><h2 id="lactTitle">Ask the class</h2><button type="button" class="lact-x" data-close aria-label="Close"><i class="fa-solid fa-xmark"></i></button></header>
            <p class="lact-sub">Students see it as soon as you launch it. It isn't added to the saved lesson.</p>
            <div class="lact-body">
                <div class="lact-types" role="group" aria-label="Activity type">
                    ${LIVE_ACTIVITY_TYPES.map((t) => `<button type="button" class="lact-type" data-type="${t}" aria-pressed="${state.type === t}"><i class="fa-solid ${WIDGET_META[t].icon}"></i>${esc(t === 'quiz' ? 'Quiz' : t === 'board' ? 'Sticky notes' : WIDGET_META[t].label)}</button>`).join('')}
                </div>
                <div><label class="lact-label" for="lactText">${label}</label>
                    <textarea id="lactText" class="lact-input" rows="2" maxlength="500" placeholder="${state.type === 'board' ? 'Post one thing you noticed…' : state.type === 'open_response' ? 'Explain how you solved it…' : 'Which word is a noun?'}">${esc(state.text)}</textarea></div>
                ${isChoice() ? `<div><span class="lact-label">Options${state.type === 'quiz' ? ' · ✓ = correct answer' : ''}</span>${optRows}
                    <button type="button" class="lact-add" data-add ${state.options.length >= MAX_OPTIONS ? 'disabled' : ''}><i class="fa-solid fa-plus"></i> Add option</button></div>` : ''}
                ${state.type === 'poll' ? `<div><span class="lact-label">Answers</span><div class="lact-seg"><button type="button" data-multi="0" aria-pressed="${!state.multiple}">One choice</button><button type="button" data-multi="1" aria-pressed="${state.multiple}">Pick any</button></div></div>` : ''}
                ${state.type === 'open_response' ? `<div><span class="lact-label">Answer box</span><div class="lact-seg"><button type="button" data-mode="short" aria-pressed="${state.mode === 'short'}">Short</button><button type="button" data-mode="long" aria-pressed="${state.mode === 'long'}">Long</button></div></div>` : ''}
                ${errors.length ? `<ul class="lact-errors" role="alert">${errors.map((e) => `<li>${esc(e)}</li>`).join('')}</ul>` : ''}
            </div>
            <div class="lact-foot"><button type="button" class="lact-btn lact-btn-ghost" data-close>Cancel</button><button type="button" class="lact-btn lact-btn-go" data-launch ${busy ? 'disabled' : ''}><i class="fa-solid fa-paper-plane"></i> ${busy ? 'Launching…' : 'Launch'}</button></div>`;
    }

    function props() {
        const text = state.text.trim();
        if (state.type === 'poll') return { question: text, options: state.options.map((o) => ({ id: o.id, text: o.text.trim() })), multiple: state.multiple, contentScale: 1 };
        if (state.type === 'quiz') return { question: text, options: state.options.map((o) => ({ id: o.id, text: o.text.trim() })), points: 1, contentScale: 1 };
        if (state.type === 'open_response') return { prompt: text, mode: state.mode, maxLength: state.mode === 'long' ? 2000 : 500, contentScale: 1 };
        return { prompt: text, noteColor: '#fef3c7', contentScale: 1 };
    }

    function close() {
        back.remove();
        document.removeEventListener('keydown', onKey, true);
        if (prevFocus && prevFocus.focus) try { prevFocus.focus(); } catch (e) { /* gone */ }
    }

    async function launch() {
        if (busy) return;
        const p = props();
        const correctIds = state.type === 'quiz' ? state.correct.filter((id) => state.options.some((o) => o.id === id)) : [];
        errors = activityProblems(state.type, p, correctIds);
        if (errors.length) { render(); return; }
        busy = true; render();
        try {
            await onLaunch({ type: state.type, props: p, correctIds });
            close();
        } catch (e) {
            busy = false;
            errors = [e && e.message ? e.message : 'Could not launch — please try again.'];
            render();
        }
    }

    modal.addEventListener('input', (e) => {
        if (e.target.id === 'lactText') state.text = e.target.value;
        const o = e.target.dataset && e.target.dataset.opt && state.options.find((x) => x.id === e.target.dataset.opt);
        if (o) o.text = e.target.value;
    });
    modal.addEventListener('click', (e) => {
        const b = e.target.closest('button');
        if (!b) return;
        if (b.dataset.close !== undefined) { close(); return; }
        if (b.dataset.launch !== undefined) { launch(); return; }
        if (b.dataset.type) { state.type = b.dataset.type; errors = []; render(); modal.querySelector('#lactText')?.focus(); return; }
        if (b.dataset.add !== undefined) {
            state.options.push(newOption(''));
            render();
            const inputs = modal.querySelectorAll('[data-opt]');
            inputs[inputs.length - 1]?.focus();
            return;
        }
        if (b.dataset.rm) { state.options = state.options.filter((o) => o.id !== b.dataset.rm); state.correct = state.correct.filter((id) => id !== b.dataset.rm); render(); return; }
        if (b.dataset.ok) { state.correct = state.correct.includes(b.dataset.ok) ? [] : [b.dataset.ok]; render(); return; }
        if (b.dataset.multi) { state.multiple = b.dataset.multi === '1'; render(); return; }
        if (b.dataset.mode) { state.mode = b.dataset.mode; render(); }
    });
    back.addEventListener('mousedown', (e) => { if (e.target === back) close(); });
    function onKey(e) {
        if (e.key === 'Escape') { e.preventDefault(); e.stopPropagation(); close(); return; }
        if (e.key === 'Enter' && (e.ctrlKey || e.metaKey)) { e.preventDefault(); launch(); return; }
        if (e.key === 'Tab') { // keep focus inside the dialog
            const f = [...modal.querySelectorAll('button:not(:disabled), input, textarea')];
            if (!f.length) return;
            const i = f.indexOf(document.activeElement);
            if (e.shiftKey && i <= 0) { e.preventDefault(); f[f.length - 1].focus(); }
            else if (!e.shiftKey && i === f.length - 1) { e.preventDefault(); f[0].focus(); }
        }
    }
    document.addEventListener('keydown', onKey, true);
    render();
    modal.querySelector('#lactText')?.focus();
    return { close };
}
