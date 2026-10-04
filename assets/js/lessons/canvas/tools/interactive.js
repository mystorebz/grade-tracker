// assets/js/lessons/canvas/tools/interactive.js — student widgets as canvas objects
//
// Four free-floating object types (drag / resize / rotate like any object):
//   poll           single or multiple choice; teacher sees a live bar chart
//   quiz           auto-graded multiple choice; the answer key lives ONLY in
//                  work_answer_keys/{lessonId}_{objectId} (staff-readable,
//                  never sent to students). Students submit through the
//                  submitLessonQuizAnswer callable, which grades server-side.
//   open_response  short / long text; teacher can spotlight an answer
//   board          sticky-note wall shared with the class
//
// Responses reuse live_sessions/{sessionId}/responses/{studentId}_{objectId}
// (blockType = the object type), so firestore.rules' live-session lockdown,
// privacy split and schoolId denormalisation apply unchanged.
//
// Render modes (renderer.js passes the mode through):
//   'editor'  — setup preview (configured in the formatting toolbar)
//   'student' — the interactive form (viewer.js)
//   'present' — the teacher's live view with results (live.js)
// ctx (per object, supplied by the host through renderSlide's widgetContext):
//   { state: 'idle' | 'live' | 'ended', mine, responses: [], spotlight, correctIds }
// Markup has two parts: the static shell + form (rebuilt only when
// widgetKey() changes, so a half-typed answer survives snapshots) and the
// [data-w-live] region (results / wall), refreshed by updateWidgetLive().

import { createObject, newOptionId, WIDGET_TYPES as TYPES } from '../model.js';

export const WIDGET_TYPES = new Set(TYPES);
export const WIDGET_META = Object.freeze({
    poll: { label: 'Poll', icon: 'fa-square-poll-horizontal', blurb: 'Quick vote, live bar chart' },
    quiz: { label: 'Quiz question', icon: 'fa-circle-check', blurb: 'Auto-graded multiple choice' },
    open_response: { label: 'Open response', icon: 'fa-pen-to-square', blurb: 'Written answers, spotlight the best' },
    board: { label: 'Sticky-note board', icon: 'fa-note-sticky', blurb: 'Everyone posts a note' },
});

const esc = (v) => String(v ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#039;' }[c]));

export function createWidget(type, siblings = [], overrides = {}) {
    if (!WIDGET_TYPES.has(type)) throw new Error(`Unknown widget type: ${type}`);
    return createObject(type, overrides, siblings);
}

export function newOption(text = '') { return { id: newOptionId(), text }; }

const optionsOf = (p) => (Array.isArray(p.options) ? p.options : []).filter((o) => o && o.id);

// Live-session state helpers (hosts call these to build ctx).
export function widgetState({ sessionId, sessionData }) {
    if (!sessionId) return 'idle';
    return sessionData && sessionData.endedAt ? 'ended' : 'live';
}

// ── structure key (renderer print) ───────────────────────────────────────
export function widgetKey(obj, mode, ctx = {}) {
    if (mode === 'editor') return 'e';
    if (mode === 'present') return `p|${ctx.state || 'idle'}`;
    const m = ctx.mine;
    const mine = m ? `${(m.choiceIds || []).join(',')}|${m.correct === undefined ? '' : m.correct}|${obj.type === 'board' ? '' : (m.answerText || '').length}` : '';
    return `s|${ctx.state || 'idle'}|${mine}|${(ctx.correctIds || []).join(',')}`;
}

const qText = (obj) => {
    const p = obj.props || {};
    return String((obj.type === 'open_response' || obj.type === 'board' ? p.prompt : p.question) || '').trim();
};

// Spotlights carry no student id or name (live session doc is readable by the
// class) — an answer is matched by widget + text.
export function isSpotlighted(spotlight, obj, answerText) {
    return !!(spotlight && spotlight.objectId === obj.id && answerText && spotlight.text === String(answerText).slice(0, 2000));
}

// Half-typed answers survive re-renders (slide changes, snapshots): the host
// keeps `drafts` (objectId → text) and calls this after painting widgets.
export function restoreWidgetDrafts(rootEl, drafts) {
    if (!rootEl || !drafts) return;
    rootEl.querySelectorAll('.cv-obj[data-object-id] [data-w-text]').forEach((field) => {
        if (field.disabled || field === document.activeElement) return;
        const id = field.closest('.cv-obj[data-object-id]').dataset.objectId;
        const d = drafts.get(id);
        if (typeof d === 'string' && field.value !== d) field.value = d;
    });
}

// ── markup ───────────────────────────────────────────────────────────────
function head(obj, extra = '') {
    const meta = WIDGET_META[obj.type];
    return `<div class="cv-w-head"><span class="cv-w-badge cv-w-badge-${obj.type}"><i class="fa-solid ${meta.icon}"></i>${esc(meta.label)}</span>${extra}</div>`;
}

function questionHtml(obj, mode) {
    const p = obj.props || {};
    const q = obj.type === 'open_response' || obj.type === 'board' ? p.prompt : p.question;
    if (q) return `<p class="cv-w-q">${esc(q)}</p>`;
    return `<p class="cv-w-q cv-w-muted">${mode === 'editor' ? 'Write the question in the formatting toolbar' : 'No question yet'}</p>`;
}

function idleNote(ctx) {
    if (ctx.state === 'ended') return '<p class="cv-w-note"><i class="fa-solid fa-lock"></i> This live session has ended — answers are closed.</p>';
    return '<p class="cv-w-note"><i class="fa-solid fa-tower-broadcast"></i> Opens when your teacher starts a live session.</p>';
}

export function widgetMarkup(obj, mode, ctx = {}) {
    if (!WIDGET_TYPES.has(obj.type)) return '';
    const fn = { poll: choiceMarkup, quiz: choiceMarkup, open_response: openMarkup, board: boardMarkup }[obj.type];
    return `<div class="cv-w cv-w-${obj.type} cv-w-mode-${mode}" data-widget="${obj.type}">${fn(obj, mode, ctx)}</div>`;
}

function choiceMarkup(obj, mode, ctx) {
    const p = obj.props || {};
    const opts = optionsOf(p);
    const isQuiz = obj.type === 'quiz';
    const tag = isQuiz ? `<span class="cv-w-tag">${Number(p.points) || 1} pt${Number(p.points) === 1 || !p.points ? '' : 's'} · auto-graded</span>` : (p.multiple ? '<span class="cv-w-tag">Pick any</span>' : '');
    if (mode === 'editor') {
        const list = opts.length
            ? opts.map((o, i) => `<div class="cv-w-opt cv-w-opt-static"><span class="cv-w-mark">${p.multiple && !isQuiz ? '<i class="fa-regular fa-square"></i>' : '<i class="fa-regular fa-circle"></i>'}</span>${esc(o.text) || `<span class="cv-w-muted">Option ${i + 1}</span>`}</div>`).join('')
            : '<p class="cv-w-muted">Add options in the formatting toolbar</p>';
        return `${head(obj, tag)}${questionHtml(obj, mode)}<div class="cv-w-opts">${list}</div><p class="cv-w-note"><i class="fa-solid fa-tower-broadcast"></i> Students answer during a live session.</p>`;
    }
    if (mode === 'present') {
        return `${head(obj, tag)}${questionHtml(obj, mode)}<div class="cv-w-results" data-w-live>${resultsHtml(obj, ctx)}</div>`;
    }
    // student
    const mine = ctx.mine;
    const chosen = new Set((mine && mine.choiceIds) || []);
    const live = ctx.state === 'live';
    const locked = !live || !!mine; // one answer per poll / quiz (firestore.rules locks it too)
    // after the session the teacher's answer key is revealed (live.js puts it on the ended session)
    const reveal = isQuiz && ctx.state === 'ended' ? new Set(ctx.correctIds || []) : new Set();
    const optsHtml = opts.map((o, i) => {
        const label = esc(o.text) || `Option ${i + 1}`;
        const right = reveal.has(o.id);
        const sr = `${chosen.has(o.id) ? ', your answer' : ''}${right ? ', correct answer' : ''}`;
        return `
        <button type="button" class="cv-w-opt ${chosen.has(o.id) ? 'cv-w-opt-on' : ''} ${right ? 'cv-w-opt-correct' : ''}" data-w-opt="${esc(o.id)}" aria-pressed="${chosen.has(o.id)}" aria-label="${label}${sr}" ${locked ? 'disabled' : ''}>
            <span class="cv-w-mark">${p.multiple && !isQuiz ? `<i class="fa-${chosen.has(o.id) ? 'solid fa-square-check' : 'regular fa-square'}"></i>` : `<i class="fa-${chosen.has(o.id) ? 'solid fa-circle-dot' : 'regular fa-circle'}"></i>`}</span>
            <span>${label}</span>${right ? '<span class="cv-w-correct-tag" aria-hidden="true"><i class="fa-solid fa-check"></i> Correct answer</span>' : ''}
        </button>`;
    }).join('');
    let footer = '';
    if (isQuiz && mine) {
        footer = mine.correct === true
            ? '<p class="cv-w-result cv-w-good" role="status" tabindex="-1"><i class="fa-solid fa-circle-check" aria-hidden="true"></i> Correct!</p>'
            : mine.correct === false
                ? `<p class="cv-w-result cv-w-bad" role="status" tabindex="-1"><i class="fa-solid fa-circle-xmark" aria-hidden="true"></i> ${reveal.size ? 'Not quite — the correct answer is marked.' : 'Not quite — your answer is saved.'}</p>`
                : '<p class="cv-w-result" role="status" tabindex="-1"><i class="fa-solid fa-circle-check" aria-hidden="true"></i> Answer submitted.</p>';
    } else if (mine) {
        footer = `<p class="cv-w-result cv-w-good" role="status" tabindex="-1"><i class="fa-solid fa-circle-check" aria-hidden="true"></i> ${live ? 'Your vote is in.' : 'Your vote is shown above.'}</p>`;
    } else if (live) {
        footer = `<div class="cv-w-actions"><button type="button" class="cv-w-btn" data-w-submit>${isQuiz ? 'Submit answer' : 'Vote'}</button><span class="cv-w-msg" data-w-msg role="status" aria-live="polite"></span></div>`;
    } else if (ctx.state === 'ended') {
        footer = `<p class="cv-w-note"><i class="fa-solid fa-lock" aria-hidden="true"></i> ${reveal.size ? "You didn't answer this one — the correct answer is marked." : "This live session has ended — you didn't answer this one."}</p>`;
    } else {
        footer = idleNote(ctx);
    }
    return `${head(obj, tag)}${questionHtml(obj, mode)}<div class="cv-w-opts" role="group" aria-label="${esc(qText(obj) || 'Answer options')}">${optsHtml}</div>${footer}`;
}

function openMarkup(obj, mode, ctx) {
    const p = obj.props || {};
    const long = p.mode === 'long';
    const max = Math.max(20, Math.min(4000, Number(p.maxLength) || 500));
    if (mode === 'editor') {
        return `${head(obj, `<span class="cv-w-tag">${long ? 'Long answer' : 'Short answer'}</span>`)}${questionHtml(obj, mode)}
            <div class="cv-w-field cv-w-field-static ${long ? 'cv-w-long' : ''}"><span class="cv-w-muted">Students type here…</span></div>
            <p class="cv-w-note"><i class="fa-solid fa-eye-slash"></i> Answers are private to you until you spotlight one.</p>`;
    }
    if (mode === 'present') {
        return `${head(obj)}${questionHtml(obj, mode)}<div class="cv-w-answers" data-w-live>${answersHtml(obj, ctx)}</div>`;
    }
    const mine = ctx.mine;
    const live = ctx.state === 'live';
    const aria = `aria-label="${esc(qText(obj) ? `Your answer: ${qText(obj)}` : 'Your answer')}"`;
    const field = !live && mine
        ? `<div class="cv-w-mine"><span class="cv-w-mine-label">Your answer</span><p>${esc(mine.answerText)}</p></div>`
        : long
            ? `<textarea class="cv-w-input cv-w-long" data-w-text maxlength="${max}" placeholder="Type your answer…" ${aria} ${live ? '' : 'disabled'}>${esc(mine ? mine.answerText : '')}</textarea>`
            : `<input class="cv-w-input" data-w-text maxlength="${max}" placeholder="Type your answer…" ${aria} value="${esc(mine ? mine.answerText : '')}" ${live ? '' : 'disabled'}>`;
    const footer = live
        ? `<div class="cv-w-actions"><button type="button" class="cv-w-btn" data-w-submit>${mine ? 'Update answer' : 'Submit'}</button><span class="cv-w-msg" data-w-msg role="status" aria-live="polite">${mine ? 'Submitted.' : ''}</span></div>`
        : mine ? '<p class="cv-w-note"><i class="fa-solid fa-lock" aria-hidden="true"></i> Session ended — this is the answer you sent.</p>' : idleNote(ctx);
    return `${head(obj)}${questionHtml(obj, mode)}${field}${footer}<div data-w-live>${spotlightHtml(obj, ctx)}</div>`;
}

function boardMarkup(obj, mode, ctx) {
    const p = obj.props || {};
    if (mode === 'editor') {
        const sample = ['Idea…', 'Question…', 'Example…'].map((t) => `<div class="cv-w-note-card" style="background:${esc(p.noteColor || '#fef3c7')}"><span class="cv-w-muted">${t}</span></div>`).join('');
        return `${head(obj)}${questionHtml(obj, mode)}<div class="cv-w-wall">${sample}</div><p class="cv-w-note"><i class="fa-solid fa-people-group"></i> Every student's note is visible to the class during a live session.</p>`;
    }
    const live = ctx.state === 'live';
    const form = mode === 'student' && live
        ? `<div class="cv-w-board-form"><input class="cv-w-input" data-w-text maxlength="280" placeholder="${ctx.mine ? 'Update your note…' : 'Add your note…'}" aria-label="${ctx.mine ? 'Update your sticky note' : 'Your sticky note'}"><button type="button" class="cv-w-btn" data-w-submit>${ctx.mine ? 'Update' : 'Post'}</button><span class="cv-w-msg" data-w-msg role="status" aria-live="polite"></span></div>`
        : mode === 'student' && !ctx.mine ? idleNote(ctx) : '';
    return `${head(obj)}${questionHtml(obj, mode)}${form}<div class="cv-w-wall" data-w-live>${wallHtml(obj, ctx)}</div>`;
}

// ── live regions ─────────────────────────────────────────────────────────
function resultsHtml(obj, ctx) {
    const opts = optionsOf(obj.props || {});
    const responses = (ctx.responses || []).filter((r) => r.blockId === obj.id);
    const counts = new Map(opts.map((o) => [o.id, 0]));
    responses.forEach((r) => (r.choiceIds || []).forEach((id) => counts.has(id) && counts.set(id, counts.get(id) + 1)));
    const total = responses.length;
    const correct = new Set(ctx.correctIds || []);
    const isQuiz = obj.type === 'quiz';
    const rows = opts.map((o, i) => {
        const n = counts.get(o.id) || 0;
        const pct = total ? Math.round((n / total) * 100) : 0;
        const ok = isQuiz && correct.has(o.id);
        return `<div class="cv-w-bar-row" title="${esc(o.text || `Option ${i + 1}`)}: ${n} (${pct}%)">
            <div class="cv-w-bar-label">${ok ? '<i class="fa-solid fa-circle-check cv-w-good" aria-label="Correct answer"></i> ' : ''}${esc(o.text) || `Option ${i + 1}`}</div>
            <div class="cv-w-bar-track"><div class="cv-w-bar-fill ${ok ? 'cv-w-bar-correct' : ''}" style="width:${pct}%"></div></div>
            <div class="cv-w-bar-val">${n}<span> · ${pct}%</span></div>
        </div>`;
    }).join('');
    const right = isQuiz ? responses.filter((r) => r.correct === true).length : null;
    const summary = `${total} response${total === 1 ? '' : 's'}${isQuiz && total ? ` · ${right} correct (${Math.round((right / total) * 100)}%)` : ''}${ctx.state === 'idle' ? ' · start a live session to collect answers' : ''}`;
    return `${rows}<p class="cv-w-summary">${summary}</p>`;
}

function answersHtml(obj, ctx) {
    const responses = (ctx.responses || []).filter((r) => r.blockId === obj.id && r.answerText)
        .sort((a, b) => new Date(b.submittedAt || 0) - new Date(a.submittedAt || 0));
    const spotOn = (r) => isSpotlighted(ctx.spotlight, obj, r.answerText);
    if (!responses.length) return `<p class="cv-w-summary">${ctx.state === 'idle' ? 'Start a live session to collect answers.' : 'No answers yet.'}</p>`;
    return `<p class="cv-w-summary">${responses.length} answer${responses.length === 1 ? '' : 's'}</p>` + responses.map((r) => `
        <div class="cv-w-answer ${spotOn(r) ? 'cv-w-answer-spot' : ''}">
            <div class="cv-w-answer-who">${esc(r.studentName || 'Student')}</div>
            <div class="cv-w-answer-text">${esc(r.answerText)}</div>
            <button type="button" class="cv-w-spot-btn" data-w-spot="${esc(r.id)}" aria-pressed="${spotOn(r)}" title="${spotOn(r) ? 'Remove from spotlight' : 'Show this answer to the class (anonymously)'}"><i class="fa-solid fa-${spotOn(r) ? 'eye-slash' : 'lightbulb'}" aria-hidden="true"></i>${spotOn(r) ? 'Unspotlight' : 'Spotlight'}</button>
        </div>`).join('');
}

function spotlightHtml(obj, ctx) {
    const s = ctx.spotlight;
    if (!s || s.objectId !== obj.id || !s.text) return '';
    return `<div class="cv-w-spotlight"><span class="cv-w-spot-label"><i class="fa-solid fa-lightbulb"></i> Spotlight</span><p>${esc(s.text)}</p></div>`;
}

function wallHtml(obj, ctx) {
    const color = esc((obj.props && obj.props.noteColor) || '#fef3c7');
    const notes = (ctx.responses || []).filter((r) => r.blockId === obj.id && r.answerText)
        .sort((a, b) => new Date(a.submittedAt || 0) - new Date(b.submittedAt || 0));
    if (!notes.length) return `<p class="cv-w-summary">${ctx.state === 'idle' ? 'Notes appear here during a live session.' : 'No notes yet — be the first!'}</p>`;
    return notes.map((r) => `<div class="cv-w-note-card" style="background:${color}"><p>${esc(r.answerText)}</p><span>${esc(r.studentName || '')}</span></div>`).join('');
}

const LIVE_FNS = {
    poll: { present: resultsHtml },
    quiz: { present: resultsHtml },
    open_response: { present: answersHtml, student: spotlightHtml },
    board: { present: wallHtml, student: wallHtml },
};

// Refresh only the [data-w-live] region (results / wall / spotlight).
export function updateWidgetLive(rootEl, obj, mode, ctx = {}) {
    const fn = LIVE_FNS[obj.type] && LIVE_FNS[obj.type][mode];
    const region = rootEl && rootEl.querySelector('[data-w-live]');
    if (!fn || !region) return;
    const html = fn(obj, ctx);
    if (region.__html !== html) { region.innerHTML = html; region.__html = html; }
}

// ── events (one delegated listener per stage) ────────────────────────────
// handlers: { getObject(id), onSubmit(obj, payload, ui) → Promise, onSpotlight(obj, responseId) }
// ui: { setMessage(text, tone), setBusy(bool) }
export function bindWidgetEvents(container, handlers) {
    function onClick(e) {
        const objEl = e.target.closest('.cv-obj[data-object-id]');
        if (!objEl || !container.contains(objEl)) return;
        const obj = handlers.getObject(objEl.dataset.objectId);
        if (!obj || !WIDGET_TYPES.has(obj.type)) return;
        const optBtn = e.target.closest('[data-w-opt]');
        if (optBtn && !optBtn.disabled) {
            const multiple = obj.type === 'poll' && obj.props && obj.props.multiple;
            const on = optBtn.getAttribute('aria-pressed') !== 'true';
            if (!multiple) objEl.querySelectorAll('[data-w-opt]').forEach((b) => setOpt(b, false, multiple));
            setOpt(optBtn, multiple ? on : true, multiple);
            return;
        }
        const submit = e.target.closest('[data-w-submit]');
        if (submit && !submit.disabled) { doSubmit(obj, objEl, submit); return; }
        const spot = e.target.closest('[data-w-spot]');
        if (spot && handlers.onSpotlight) handlers.onSpotlight(obj, spot.dataset.wSpot);
    }
    function onInput(e) {
        if (!handlers.drafts || !e.target.matches('[data-w-text]')) return;
        const objEl = e.target.closest('.cv-obj[data-object-id]');
        if (objEl) handlers.drafts.set(objEl.dataset.objectId, e.target.value);
    }
    function onKey(e) {
        if (e.key !== 'Enter' || !e.target.matches('input[data-w-text]')) return;
        const objEl = e.target.closest('.cv-obj[data-object-id]');
        const btn = objEl && objEl.querySelector('[data-w-submit]');
        if (btn) { e.preventDefault(); btn.click(); }
    }
    function setOpt(btn, on, multiple) {
        btn.setAttribute('aria-pressed', String(on));
        btn.classList.toggle('cv-w-opt-on', on);
        const i = btn.querySelector('.cv-w-mark i');
        if (i) i.className = multiple ? `fa-${on ? 'solid fa-square-check' : 'regular fa-square'}` : `fa-${on ? 'solid fa-circle-dot' : 'regular fa-circle'}`;
    }
    // the widget may be re-rendered while a submit is in flight: always talk to the current one
    const current = (obj, fallback) => {
        const el = container.querySelector(`.cv-obj[data-object-id="${CSS.escape(obj.id)}"]`);
        return el || fallback;
    };
    async function doSubmit(obj, objEl, btn) {
        const hadFocusInside = objEl.contains(document.activeElement);
        const ui = {
            setMessage(text, tone = '') {
                const msg = current(obj, objEl).querySelector('[data-w-msg]');
                if (msg) { msg.textContent = text; msg.dataset.tone = tone; }
            },
            setBusy(b) {
                const bt = current(obj, objEl).querySelector('[data-w-submit]') || btn;
                bt.disabled = b; bt.classList.toggle('cv-w-busy', b);
            },
        };
        let payload;
        if (obj.type === 'poll' || obj.type === 'quiz') {
            const choiceIds = [...objEl.querySelectorAll('[data-w-opt][aria-pressed="true"]')].map((b) => b.dataset.wOpt);
            if (!choiceIds.length) { ui.setMessage('Pick an answer first.', 'bad'); return; }
            payload = { choiceIds };
        } else {
            const field = objEl.querySelector('[data-w-text]');
            const text = (field && field.value || '').trim();
            if (!text) { ui.setMessage('Write something first.', 'bad'); return; }
            payload = { answerText: text };
        }
        ui.setBusy(true);
        ui.setMessage('Sending…');
        try {
            await handlers.onSubmit(obj, payload, ui);
            if (handlers.drafts) handlers.drafts.delete(obj.id);
            const el = current(obj, objEl);
            if (obj.type === 'board') { const f = el.querySelector('[data-w-text]'); if (f) f.value = ''; }
            ui.setMessage(obj.type === 'board' ? 'Posted!' : 'Submitted!', 'good');
            // keep keyboard / screen-reader users where they were after the re-render
            if (hadFocusInside || document.activeElement === document.body || !document.activeElement) {
                const target = el.querySelector('[data-w-text]:not(:disabled), [data-w-submit]:not(:disabled), .cv-w-result');
                if (target) try { target.focus({ preventScroll: true }); } catch (e) { /* detached */ }
            }
        } catch (err) {
            console.error('[widget] submit failed:', err);
            ui.setMessage(err && err.message && /already|closed|ended|teacher|not available|pick an answer|pick exactly|not one of the options|not enrolled|not in the lesson/i.test(err.message) ? err.message : 'Could not send — try again.', 'bad');
        } finally {
            ui.setBusy(false);
        }
    }
    container.addEventListener('click', onClick);
    container.addEventListener('keydown', onKey);
    container.addEventListener('input', onInput);
    return () => { container.removeEventListener('click', onClick); container.removeEventListener('keydown', onKey); container.removeEventListener('input', onInput); };
}

// ── sidebar thumbnail ────────────────────────────────────────────────────
export function widgetThumbHtml(type, props = {}) {
    const meta = WIDGET_META[type] || { icon: 'fa-bolt', label: 'Activity' };
    const q = type === 'open_response' || type === 'board' ? props.prompt : props.question;
    return `<div class="w-full h-full flex items-center gap-0.5 rounded-sm bg-indigo-50 px-1 overflow-hidden"><i class="fa-solid ${meta.icon} text-[6px] text-indigo-400 flex-shrink-0"></i><span class="text-[5.5px] font-bold text-indigo-500 truncate">${esc(q || meta.label)}</span></div>`;
}

// ── styles (injected by renderer.js) ─────────────────────────────────────
export const WIDGET_CSS = `
.cv-w { width: 100%; height: 100%; box-sizing: border-box; display: flex; flex-direction: column; gap: 7px; padding: 12px 14px; overflow: hidden;
  background: #fff; border: 1px solid #dce3ed; border-radius: 12px; box-shadow: 0 1px 2px rgba(13,31,53,.06); font-family: 'DM Sans', system-ui, sans-serif; color: #0d1f35; font-size: 13px; text-align: left; }
.cv-w-head { display: flex; align-items: center; gap: 6px; flex-wrap: wrap; }
.cv-w-badge { display: inline-flex; align-items: center; gap: 5px; font-size: 9.5px; font-weight: 800; text-transform: uppercase; letter-spacing: .06em; padding: 3px 8px; border-radius: 999px; background: #eef2ff; color: #4338ca; border: 1px solid #c7d2fe; }
.cv-w-badge-quiz { background: #ecfdf5; color: #047857; border-color: #a7f3d0; }
.cv-w-badge-open_response { background: #fff7ed; color: #c2410c; border-color: #fed7aa; }
.cv-w-badge-board { background: #fefce8; color: #a16207; border-color: #fde68a; }
.cv-w-tag { font-size: 10px; font-weight: 700; color: #6b84a0; }
.cv-w-q { margin: 0; font-size: 14.5px; font-weight: 700; line-height: 1.35; color: #0d1f35; }
.cv-w-muted { color: #9ab0c6 !important; font-weight: 600; }
.cv-w-opts { display: flex; flex-direction: column; gap: 5px; min-height: 0; overflow-y: auto; }
.cv-w-opt { display: flex; align-items: center; gap: 8px; width: 100%; text-align: left; padding: 7px 10px; border-radius: 9px; border: 1px solid #dce3ed; background: #fff;
  font: inherit; font-size: 12.5px; font-weight: 600; color: #374f6b; cursor: pointer; transition: border-color .12s, background .12s; }
.cv-w-opt:hover:not(:disabled) { border-color: #818cf8; background: #f5f7ff; }
.cv-w-opt-on { border-color: #4f46e5 !important; background: #eef2ff !important; color: #312e81; }
.cv-w-opt:disabled { cursor: default; }
.cv-w-opt-static { cursor: default; }
.cv-w-mark { color: #9ab0c6; width: 14px; text-align: center; }
.cv-w-opt-on .cv-w-mark { color: #4f46e5; }
.cv-w-note { margin: auto 0 0; font-size: 10.5px; font-weight: 600; color: #6b84a0; display: flex; align-items: center; gap: 6px; }
.cv-w-actions { display: flex; align-items: center; gap: 8px; margin-top: auto; }
.cv-w-btn { border: 0; border-radius: 9px; padding: 7px 14px; background: #4f46e5; color: #fff; font: inherit; font-size: 12px; font-weight: 800; cursor: pointer; flex-shrink: 0; }
.cv-w-btn:hover:not(:disabled) { background: #4338ca; }
.cv-w-btn:disabled { opacity: .55; cursor: default; }
.cv-w-msg { font-size: 11px; font-weight: 700; color: #6b84a0; }
.cv-w-msg[data-tone="good"] { color: #047857; }
.cv-w-msg[data-tone="bad"] { color: #be123c; }
.cv-w-result { margin: auto 0 0; font-size: 12.5px; font-weight: 800; display: flex; align-items: center; gap: 6px; color: #374f6b; }
.cv-w-good { color: #047857; }
.cv-w-opt-correct { border-color: #059669 !important; background: #ecfdf5 !important; }
.cv-w-correct-tag { margin-left: auto; font-size: 10.5px; font-weight: 800; color: #047857; display: inline-flex; align-items: center; gap: 4px; white-space: nowrap; }
.cv-w-mine { border: 1px solid #dce3ed; border-radius: 9px; padding: 8px 10px; background: #f8fafc; }
.cv-w-mine p { margin: 3px 0 0; font-size: 13px; color: #0d1f35; white-space: pre-wrap; }
.cv-w-mine-label { font-size: 10px; font-weight: 800; text-transform: uppercase; letter-spacing: .06em; color: #6b84a0; }
.cv-w-result:focus { outline: 2px solid #6366f1; outline-offset: 2px; border-radius: 6px; }
.cv-w-bad { color: #be123c; }
.cv-w-input { width: 100%; box-sizing: border-box; border: 1px solid #dce3ed; border-radius: 9px; padding: 8px 10px; font: inherit; font-size: 12.5px; color: #0d1f35; background: #fff; outline: none; resize: none; }
.cv-w-input:focus { border-color: #4f46e5; box-shadow: 0 0 0 3px rgba(79,70,229,.12); }
.cv-w-input.cv-w-long, .cv-w-field.cv-w-long { flex: 1; min-height: 70px; }
.cv-w-field { border: 1px dashed #dce3ed; border-radius: 9px; padding: 8px 10px; font-size: 12px; }
.cv-w-results, .cv-w-answers { display: flex; flex-direction: column; gap: 6px; overflow-y: auto; min-height: 0; flex: 1; }
.cv-w-bar-row { display: grid; grid-template-columns: minmax(70px, 34%) 1fr auto; align-items: center; gap: 8px; }
.cv-w-bar-label { font-size: 12px; font-weight: 600; color: #374f6b; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.cv-w-bar-track { height: 14px; background: #eef1f5; border-radius: 4px; overflow: hidden; }
.cv-w-bar-fill { height: 100%; background: #2563eb; border-radius: 0 4px 4px 0; transition: width .35s ease; min-width: 0; }
.cv-w-bar-correct { background: #047857; }
.cv-w-bar-val { font-size: 12px; font-weight: 800; color: #0d1f35; font-variant-numeric: tabular-nums; white-space: nowrap; }
.cv-w-bar-val span { font-weight: 600; color: #6b84a0; }
.cv-w-summary { margin: 2px 0 0; font-size: 10.5px; font-weight: 700; color: #6b84a0; }
.cv-w-answer { position: relative; border: 1px solid #e5eaf1; border-radius: 9px; padding: 7px 9px; background: #f8fafc; }
.cv-w-answer-spot { border-color: #f59e0b; background: #fffbeb; }
.cv-w-answer-who { font-size: 9.5px; font-weight: 800; color: #6b84a0; text-transform: uppercase; letter-spacing: .04em; }
.cv-w-answer-text { font-size: 12px; color: #0d1f35; white-space: pre-wrap; margin-top: 2px; padding-right: 88px; }
.cv-w-spot-btn { position: absolute; top: 6px; right: 6px; display: inline-flex; align-items: center; gap: 4px; border: 1px solid #fde68a; background: #fff; color: #a16207; border-radius: 7px; padding: 3px 7px; font: inherit; font-size: 10px; font-weight: 800; cursor: pointer; }
.cv-w-spotlight { border: 1px solid #fde68a; background: #fffbeb; border-radius: 9px; padding: 7px 10px; }
.cv-w-spotlight p { margin: 3px 0 0; font-size: 12.5px; color: #0d1f35; white-space: pre-wrap; }
.cv-w-spot-label { font-size: 9.5px; font-weight: 800; color: #a16207; text-transform: uppercase; letter-spacing: .06em; }
.cv-w-board-form { display: flex; gap: 6px; align-items: center; }
.cv-w-board-form .cv-w-msg { min-width: 0; }
.cv-w-wall { flex: 1; min-height: 0; overflow-y: auto; display: grid; grid-template-columns: repeat(auto-fill, minmax(110px, 1fr)); gap: 7px; align-content: start; }
.cv-w-wall > .cv-w-summary { grid-column: 1 / -1; }
.cv-w-note-card { border-radius: 6px; padding: 8px 9px; box-shadow: 0 1px 2px rgba(13,31,53,.12); min-height: 54px; display: flex; flex-direction: column; justify-content: space-between; }
.cv-w-note-card p { margin: 0; font-size: 12px; font-weight: 600; color: #3f3f46; white-space: pre-wrap; word-break: break-word; }
.cv-w-note-card span { font-size: 9px; font-weight: 800; color: #78716c; margin-top: 4px; }
.cv-w-mode-editor * { pointer-events: none; }
`;
