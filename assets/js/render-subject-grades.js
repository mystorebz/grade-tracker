// ── SHARED SUBJECT GRADES PAGE (student + parent) ────────────────────────
// Replaces the old nested pop-ups on Current Grades. One page per subject:
//   header (subject, average + letter, standing, term; child name for parents)
//   → row of assignment-type cards (Tests, Quizzes, …) with average/count;
//     with none selected every assignment shows, grouped under its type;
//     tapping a type shows only that type (tap again / "Show all types" clears)
//   → clicking an assignment opens a read-only slide-in panel with the actual
//     assignment: instructions, materials, worksheet, questions with the
//     student's own answers and per-question marks, score and teacher feedback.
//
// Parity: data comes from render-grades.js's fetchStudentGrades() (same
// query, same semester, same teacher rubric) and the subject average uses the
// same calculateWeightedAverage() the Current Grades tiles use; per-type
// averages use the same typeAverage() the old type tiles used.
//
// Pages render into #subjectPageHost and pass their own back link.
// The selected type (?type=…) and open assignment (?item=<gradeId>) are kept
// in the URL so reload/bookmark keep them.
//
// Panel data: the grade's assignment doc (classes/{c}/subjects/{s}/assignments/{a})
// and the student's submission (…/submissions/{studentId}). Both are already
// readable by the student themself and by a linked parent; answer keys are
// never shown — only the student's answers and the teacher's marks/notes.
import { db } from './firebase-init.js';
import { doc, getDoc } from "https://www.gstatic.com/firebasejs/10.7.1/firebase-firestore.js";
import { calculateWeightedAverage } from './utils.js';
import {
    fetchStudentGrades, esc, gradeStyle, standing, isNew,
    weightFor, typeAverage, groupBySubject,
} from './render-grades.js';


function injectCss() {
    if (document.getElementById('subject-grades-css')) return;
    const st = document.createElement('style');
    st.id = 'subject-grades-css';
    st.textContent = `
    .sg-wrap { padding: 24px 40px 48px; max-width: 1100px; }
    .sg-back { display: inline-flex; align-items: center; gap: 8px; font-size: 13px; font-weight: 700; color: #4f46e5; text-decoration: none; margin-bottom: 16px; }
    .sg-back:hover { text-decoration: underline; }
    .sg-head { background: #fff; border: 1.5px solid #e2e8f0; border-radius: 14px; padding: 22px 24px; display: flex; align-items: center; gap: 22px; flex-wrap: wrap; }
    .sg-ring { width: 92px; height: 92px; border-radius: 50%; display: flex; flex-direction: column; align-items: center; justify-content: center; flex-shrink: 0; border: 3px solid; }
    .sg-ring .num { font-size: 26px; font-weight: 900; line-height: 1; font-family: 'DM Mono', monospace; }
    .sg-ring .unit { font-size: 10px; font-weight: 700; opacity: 0.7; margin-top: 3px; letter-spacing: 0.06em; }
    .sg-title { flex: 1; min-width: 200px; }
    .sg-title h1 { font-size: 22px; font-weight: 800; color: #0f172a; margin: 0; letter-spacing: -0.3px; }
    .sg-meta { font-size: 13px; color: #64748b; font-weight: 600; margin: 4px 0 0; }
    .sg-child { display: inline-flex; align-items: center; gap: 6px; font-size: 11.5px; font-weight: 800; color: #7f1d3d; background: #fdf2f8; border: 1px solid #fbcfe8; border-radius: 99px; padding: 3px 10px; margin-bottom: 6px; }
    .sg-standing { display: inline-flex; margin-top: 8px; font-size: 12px; font-weight: 700; padding: 3px 11px; border-radius: 99px; background: #f1f5f9; color: #334155; border: 1px solid #e2e8f0; }
    .sg-letter { font-size: 20px; font-weight: 900; padding: 8px 16px; border-radius: 10px; border: 2px solid; }
    .sg-types { display: flex; gap: 12px; overflow-x: auto; padding: 4px 2px 10px; margin: 20px 0 6px; scroll-snap-type: x proximity; -webkit-overflow-scrolling: touch; }
    .sg-type { flex: 0 0 auto; min-width: 150px; scroll-snap-align: start; text-align: left; background: #fff; border: 1.5px solid #e2e8f0; border-radius: 12px; padding: 13px 15px; cursor: pointer; font: inherit; display: flex; flex-direction: column; gap: 6px; transition: border-color 0.15s, box-shadow 0.15s; }
    .sg-type:hover { border-color: #a5b4fc; }
    .sg-type[aria-pressed="true"] { border-color: #4f46e5; box-shadow: 0 0 0 3px rgba(79,70,229,0.15); }
    .sg-type-name { font-size: 13px; font-weight: 800; color: #0f172a; }
    .sg-type-sub { font-size: 10.5px; font-weight: 600; color: #94a3b8; }
    .sg-type-avg { font-size: 22px; font-weight: 900; line-height: 1; }
    .sg-list-head { font-size: 11px; font-weight: 800; color: #94a3b8; text-transform: uppercase; letter-spacing: 0.08em; margin: 14px 0 10px; }
    .sg-list { display: flex; flex-direction: column; gap: 10px; }
    .sg-item { background: #fff; border: 1px solid #e2e8f0; border-radius: 12px; padding: 15px 16px; display: flex; flex-direction: column; gap: 10px; }
    .sg-item-top { display: flex; align-items: flex-start; justify-content: space-between; gap: 12px; }
    .sg-item-title { font-size: 14px; font-weight: 700; color: #0f172a; line-height: 1.3; }
    .sg-item-meta { font-size: 11.5px; color: #94a3b8; margin-top: 4px; font-weight: 500; }
    .sg-score { text-align: right; flex-shrink: 0; }
    .sg-score .pts { font-size: 17px; font-weight: 800; }
    .sg-pill { display: inline-block; font-size: 11.5px; font-weight: 700; padding: 2px 9px; border-radius: 5px; border: 1px solid; margin-top: 3px; }
    .sg-bar { height: 6px; background: #f1f5f9; border-radius: 99px; overflow: hidden; }
    .sg-bar > div { height: 100%; border-radius: 99px; }
    .sg-feedback { font-size: 12px; color: #475569; background: #f8fafc; padding: 9px 12px; border-radius: 8px; border-left: 3px solid #4f46e5; line-height: 1.5; white-space: pre-wrap; }
    .sg-feedback b { display: block; font-size: 10px; text-transform: uppercase; letter-spacing: 0.06em; color: #94a3b8; margin-bottom: 2px; }
    .sg-modified { font-size: 11px; color: #92400e; background: #fffbeb; border: 1px solid #fde68a; border-radius: 8px; padding: 7px 11px; font-weight: 600; }
    .sg-tag { font-size: 9px; font-weight: 800; padding: 2px 6px; border-radius: 4px; margin-left: 6px; vertical-align: middle; }
    .sg-group { margin-top: 18px; }
    .sg-group-head { display: flex; align-items: baseline; gap: 10px; font-size: 12px; font-weight: 800; color: #334155; text-transform: uppercase; letter-spacing: 0.06em; margin: 0 0 9px; }
    .sg-group-head .avg { font-family: 'DM Mono', monospace; text-transform: none; letter-spacing: 0; }
    .sg-group-head .cnt { color: #94a3b8; font-weight: 700; text-transform: none; letter-spacing: 0; }
    .sg-filter { display: inline-flex; align-items: center; gap: 8px; margin: 6px 0 0; font-size: 12px; font-weight: 700; color: #475569; }
    .sg-clear { display: inline-flex; align-items: center; gap: 6px; background: #eef2ff; color: #4338ca; border: 1px solid #c7d2fe; border-radius: 99px; padding: 4px 11px; font: inherit; font-size: 12px; font-weight: 800; cursor: pointer; }
    .sg-clear:hover { background: #e0e7ff; }
    button.sg-item { width: 100%; text-align: left; font: inherit; cursor: pointer; transition: border-color 0.15s, box-shadow 0.15s; }
    button.sg-item:hover { border-color: #a5b4fc; box-shadow: 0 4px 14px rgba(15,23,42,0.06); }
    .sg-open { font-size: 11px; font-weight: 800; color: #4f46e5; }
    /* slide-in assignment panel */
    .sg-overlay { position: fixed; inset: 0; background: rgba(15,23,42,0.45); z-index: 70; opacity: 0; transition: opacity 0.2s; }
    .sg-overlay.open { opacity: 1; }
    .sg-panel { position: fixed; top: 0; right: 0; bottom: 0; width: min(580px, 100vw); background: #f8fafc; z-index: 71; display: flex; flex-direction: column; box-shadow: -12px 0 40px rgba(15,23,42,0.18); transform: translateX(100%); transition: transform 0.22s ease; }
    .sg-panel.open { transform: translateX(0); }
    .sg-panel-head { background: #fff; border-bottom: 1px solid #e2e8f0; padding: 16px 18px; display: flex; align-items: flex-start; gap: 12px; }
    .sg-panel-head h2 { font-size: 17px; font-weight: 800; color: #0f172a; margin: 0; line-height: 1.3; }
    .sg-panel-sub { font-size: 12px; color: #64748b; font-weight: 600; margin-top: 3px; }
    .sg-x { margin-left: auto; flex-shrink: 0; width: 34px; height: 34px; border-radius: 8px; border: 1px solid #e2e8f0; background: #fff; color: #64748b; cursor: pointer; font-size: 15px; }
    .sg-x:hover { background: #fee2e2; color: #dc2626; border-color: #fecaca; }
    .sg-panel-body { flex: 1; overflow-y: auto; padding: 18px; display: flex; flex-direction: column; gap: 14px; }
    .sg-sec-label { font-size: 10.5px; font-weight: 800; color: #94a3b8; text-transform: uppercase; letter-spacing: 0.08em; margin: 0 0 6px; }
    .sg-box { background: #fff; border: 1px solid #e2e8f0; border-radius: 12px; padding: 13px 14px; font-size: 13px; color: #334155; line-height: 1.55; white-space: pre-wrap; word-break: break-word; }
    .sg-scorebox { display: flex; align-items: center; gap: 14px; background: #fff; border: 1px solid #e2e8f0; border-radius: 12px; padding: 14px; }
    .sg-scorebox .big { font-size: 26px; font-weight: 900; font-family: 'DM Mono', monospace; }
    .sg-q { background: #fff; border: 1px solid #e2e8f0; border-radius: 12px; padding: 13px 14px; }
    .sg-q-top { display: flex; gap: 9px; align-items: flex-start; }
    .sg-q-num { width: 24px; height: 24px; flex-shrink: 0; border-radius: 6px; background: #eef2ff; color: #4f46e5; font-size: 11px; font-weight: 900; display: flex; align-items: center; justify-content: center; }
    .sg-q-prompt { font-size: 13.5px; font-weight: 700; color: #1e293b; white-space: pre-wrap; }
    .sg-q-pts { font-size: 11px; font-weight: 700; color: #94a3b8; margin-top: 2px; }
    .sg-ans { margin: 9px 0 0 33px; font-size: 13px; color: #334155; }
    .sg-ans-text { background: #f8fafc; border: 1px solid #e2e8f0; border-radius: 8px; padding: 9px 11px; white-space: pre-wrap; word-break: break-word; }
    .sg-opt { display: flex; align-items: center; gap: 8px; padding: 5px 9px; border-radius: 8px; color: #64748b; }
    .sg-opt.sel { background: #eef2ff; border: 1px solid #c7d2fe; color: #1e293b; font-weight: 700; }
    .sg-badge { display: inline-block; font-size: 10px; font-weight: 800; text-transform: uppercase; letter-spacing: 0.05em; padding: 2px 8px; border-radius: 5px; border: 1px solid; margin-top: 6px; }
    .sg-note { margin: 9px 0 0 33px; background: #eef2ff; border: 1px solid #c7d2fe; border-radius: 8px; padding: 8px 11px; font-size: 12.5px; color: #312e81; white-space: pre-wrap; }
    .sg-note b { display: block; font-size: 9.5px; text-transform: uppercase; letter-spacing: 0.06em; color: #6366f1; margin-bottom: 2px; }
    .sg-muted { font-size: 12.5px; color: #94a3b8; font-style: italic; }
    .sg-link { color: #4f46e5; font-weight: 700; text-decoration: none; word-break: break-all; }
    .sg-link:hover { text-decoration: underline; }
    .sg-msg { text-align: center; padding: 70px 20px; color: #94a3b8; font-size: 13.5px; font-weight: 600; background: #fff; border: 1.5px dashed #e2e8f0; border-radius: 14px; }
    .sg-msg i { display: block; font-size: 30px; margin-bottom: 12px; color: #c7d2fe; }
    @media (max-width: 767px) {
        .sg-wrap { padding: 16px 16px 40px; }
        .sg-head { padding: 18px; gap: 14px; }
        .sg-ring { width: 74px; height: 74px; }
        .sg-ring .num { font-size: 21px; }
        .sg-title h1 { font-size: 19px; }
        .sg-type { min-width: 132px; }
    }`;
    document.head.appendChild(st);
}

function isImageUrl(url) {
    return /^data:image\//i.test(url) || /\.(png|jpe?g|gif|webp)(\?|$)/i.test(url);
}

function safeUrl(url) {
    const u = String(url || '');
    return /^(https?:|data:image\/)/i.test(u) ? u : '';
}

function fmtDate(v) {
    if (!v) return '';
    const d = typeof v === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(v) ? new Date(v + 'T00:00:00')
        : (v && typeof v.toDate === 'function' ? v.toDate() : new Date(v));
    return isNaN(d) ? String(v) : d.toLocaleDateString(undefined, { month: 'short', day: 'numeric', year: 'numeric' });
}

/**
 * @param {{ studentId: string, schoolId: string, subject: string,
 *           backHref: string, backLabel?: string, showChildName?: boolean,
 *           initialType?: string, initialItem?: string }} cfg
 */
export async function initSubjectGradesPage(cfg) {
    injectCss();
    const host = document.getElementById('subjectPageHost');
    const back = `<a class="sg-back" href="${esc(cfg.backHref)}"><i class="fa-solid fa-arrow-left"></i> ${esc(cfg.backLabel || 'Back to Current Grades')}</a>`;
    const message = (icon, text) => {
        host.innerHTML = `<div class="sg-wrap">${back}<div class="sg-msg"><i class="fa-solid ${icon}"></i>${esc(text)}</div></div>`;
    };

    if (!cfg.subject) { message('fa-link-slash', 'This subject link is incomplete.'); return; }
    host.innerHTML = `<div class="sg-wrap">${back}<div class="sg-msg"><i class="fa-solid fa-circle-notch fa-spin" style="color:#6366f1;"></i>Loading grades…</div></div>`;

    let data;
    try {
        data = await fetchStudentGrades(cfg.studentId, cfg.schoolId);
    } catch (e) {
        console.error('[SubjectGrades] load:', e);
        message('fa-triangle-exclamation', e && e.code === 'permission-denied'
            ? "You don't have access to these grades."
            : 'Failed to load grades. Please refresh.');
        return;
    }

    // Sidebar/topbar fields owned by the layouts (guarded: not every layout has them).
    const setText = (id, v) => { const el = document.getElementById(id); if (el) el.textContent = v; };
    setText('displaySchoolName', data.schoolData.schoolName || 'ConnectUs');
    if (data.noSemester) { message('fa-calendar-xmark', 'No active grading period set by the school.'); return; }
    setText('activeSemesterDisplay', data.semName);

    const grades = groupBySubject(data.grades)[cfg.subject] || [];
    document.title = `${cfg.subject} | Current Grades | ConnectUs`;
    if (!grades.length) { message('fa-folder-open', `No grades recorded for ${cfg.subject} this period.`); return; }

    const isParent = !!cfg.showChildName;
    const rubric = data.rubric;
    const avg = calculateWeightedAverage(grades, rubric);
    const avgRnd = avg !== null ? Math.round(avg) : null;
    const st = avgRnd !== null ? gradeStyle(avgRnd) : null;

    const byType = {};
    grades.forEach(g => { const t = g.type || 'Other'; (byType[t] = byType[t] || []).push(g); });
    const types = Object.keys(byType).sort((a, b) => a.localeCompare(b));
    let selected = cfg.initialType && byType[cfg.initialType] ? cfg.initialType : null; // null = every type
    const childName = isParent ? (data.studentData.name || 'Student') : '';
    const byDateDesc = (a, b) => String(b.date || '').localeCompare(String(a.date || ''));

    function typeCard(type) {
        const list = byType[type];
        const tAvg = typeAverage(list);
        const tSt = tAvg !== null ? gradeStyle(tAvg) : null;
        const w = weightFor(rubric, type);
        const n = list.length;
        return `
        <button type="button" class="sg-type" data-type="${esc(type)}" aria-pressed="${selected === type}">
            <span class="sg-type-name">${esc(type)}</span>
            <span class="sg-type-avg" style="color:${tSt?.color || '#94a3b8'};">${tAvg !== null ? tAvg + '%' : '—'}</span>
            <span class="sg-type-sub">${n} ${n === 1 ? 'item' : 'items'}${w !== null ? ` · ${w}% of grade` : ''}</span>
        </button>`;
    }

    function itemHtml(g) {
        const pct = g.max ? Math.round((g.score / g.max) * 100) : null;
        const gSt = pct !== null ? gradeStyle(pct) : null;
        const who = g.enteredByAdmin ? (g.adminName || 'Administrator') : (data.teachers[g.teacherId] || 'Teacher');
        const tags = (isNew(g.date, g.createdAt) ? '<span class="sg-tag" style="background:#dbeafe;color:#1d4ed8;">NEW</span>' : '')
            + (g.enteredByAdmin ? '<span class="sg-tag" style="background:#eff6ff;color:#2563eb;border:1px solid #bfdbfe;">ADMIN</span>' : '');
        return `
        <button type="button" class="sg-item" data-item="${esc(g.id)}" aria-label="Open ${esc(g.title || 'assignment')}">
            <div class="sg-item-top">
                <div style="min-width:0;">
                    <div class="sg-item-title">${esc(g.title || '—')}${tags}</div>
                    <div class="sg-item-meta">${esc(fmtDate(g.date) || '—')} · ${esc(g.type || 'Other')} · ${esc(who)}</div>
                </div>
                <div class="sg-score">
                    <div class="pts" style="color:${gSt?.color || '#1e293b'};">${esc(g.score)} / ${esc(g.max ?? '?')}</div>
                    <span class="sg-pill" style="background:${gSt?.bg || '#f1f5f9'};color:${gSt?.color || '#475569'};border-color:${gSt?.border || '#cbd5e1'};">${pct !== null ? pct + '%' : '—'}</span>
                </div>
            </div>
            <div class="sg-bar"><div style="width:${Math.min(pct || 0, 100)}%;background:${gSt?.bar || '#94a3b8'};"></div></div>
            ${g.notes ? `<div class="sg-feedback"><b>Teacher feedback</b>${esc(g.notes)}</div>` : ''}
            ${g.historyLogs?.length ? '<div class="sg-modified"><i class="fa-solid fa-clock-rotate-left" style="margin-right:5px;"></i>Grade was modified after initial entry.</div>' : ''}
            <span class="sg-open">View assignment <i class="fa-solid fa-arrow-right" style="font-size:10px;"></i></span>
        </button>`;
    }

    function groupHtml(type) {
        const list = byType[type].slice().sort(byDateDesc);
        const tAvg = typeAverage(list);
        const tSt = tAvg !== null ? gradeStyle(tAvg) : null;
        return `
        <section class="sg-group">
            <h3 class="sg-group-head">${esc(type)}
                <span class="avg" style="color:${tSt?.color || '#94a3b8'};">${tAvg !== null ? tAvg + '%' : '—'}</span>
                <span class="cnt">${list.length} ${list.length === 1 ? 'item' : 'items'}</span></h3>
            <div class="sg-list">${list.map(itemHtml).join('')}</div>
        </section>`;
    }

    function render() {
        const body = selected
            ? `<div class="sg-filter">Showing ${esc(selected)} only
                   <button type="button" class="sg-clear" data-clear-type><i class="fa-solid fa-xmark"></i> Show all types</button></div>
               ${groupHtml(selected)}`
            : types.map(groupHtml).join('');
        host.innerHTML = `
        <div class="sg-wrap">
            ${back}
            <div class="sg-head">
                <div class="sg-ring" style="color:${st?.color || '#94a3b8'};border-color:${st?.border || '#e2e8f0'};background:${st?.bg || '#f8fafc'};">
                    <span class="num">${avgRnd !== null ? avgRnd : '--'}</span>
                    <span class="unit">AVERAGE</span>
                </div>
                <div class="sg-title">
                    ${childName ? `<div class="sg-child"><i class="fa-solid fa-user-graduate"></i>${esc(childName)}</div>` : ''}
                    <h1>${esc(cfg.subject)}</h1>
                    <p class="sg-meta">${esc(data.semName)} · ${grades.length} graded ${grades.length === 1 ? 'item' : 'items'}</p>
                    ${avgRnd !== null ? `<span class="sg-standing">${esc(standing(avgRnd))}</span>` : ''}
                </div>
                ${st ? `<span class="sg-letter" style="color:${st.color};background:${st.bg};border-color:${st.border};">${st.letter}</span>` : ''}
            </div>
            ${types.length > 1 ? `<div class="sg-types" role="group" aria-label="Filter by assignment type">${types.map(typeCard).join('')}</div>` : ''}
            ${body}
        </div>`;
    }

    function setUrl(key, value) {
        const url = new URL(location.href);
        if (value) url.searchParams.set(key, value); else url.searchParams.delete(key);
        history.replaceState(null, '', url.pathname + url.search);
    }

    function setType(type) {
        selected = type;
        setUrl('type', type);
        const scroller = host.querySelector('.sg-types');
        const keepScroll = scroller ? scroller.scrollLeft : 0;
        render();
        const again = host.querySelector('.sg-types');
        if (again) again.scrollLeft = keepScroll;
    }

    // ── ASSIGNMENT PANEL ─────────────────────────────────────────────────
    const detailCache = new Map(); // gradeId -> Promise<{ assignment, submission }>
    let panel = null, overlay = null, lastFocus = null;

    function loadDetail(g) {
        if (!detailCache.has(g.id)) {
            const p = (async () => {
                if (!g.assignmentId || !g.classId || !g.subjectId) return { assignment: null, submission: null };
                const base = ['schools', cfg.schoolId, 'classes', g.classId, 'subjects', g.subjectId, 'assignments', g.assignmentId];
                const [aSnap, sSnap] = await Promise.all([
                    getDoc(doc(db, ...base)).catch(e => { console.warn('[SubjectGrades] assignment', e.code || e); return null; }),
                    getDoc(doc(db, ...base, 'submissions', cfg.studentId)).catch(e => { console.warn('[SubjectGrades] submission', e.code || e); return null; }),
                ]);
                return {
                    assignment: aSnap && aSnap.exists() ? { id: aSnap.id, ...aSnap.data() } : null,
                    submission: sSnap && sSnap.exists() ? sSnap.data() : null,
                };
            })();
            detailCache.set(g.id, p);
        }
        return detailCache.get(g.id);
    }

    function answerHtml(q, saved, autoGrade) {
        if (q.type === 'multiple_choice') {
            const sel = saved && saved.responseText !== '' && saved.responseText != null ? Number(saved.responseText) : null;
            const graded = !!autoGrade && Object.prototype.hasOwnProperty.call(autoGrade.perQuestion || {}, q.id);
            const opts = (q.options || []).map((opt, i) => `
                <div class="sg-opt${sel === i ? ' sel' : ''}"><b style="width:16px;">${sel === i ? '<i class="fa-solid fa-check"></i>' : String.fromCharCode(65 + i)}</b>${esc(opt)}</div>`).join('');
            const badge = sel === null
                ? '<span class="sg-badge" style="color:#64748b;background:#f8fafc;border-color:#e2e8f0;">Not answered</span>'
                : !graded ? ''
                    : autoGrade.perQuestion[q.id]
                        ? '<span class="sg-badge" style="color:#047857;background:#ecfdf5;border-color:#a7f3d0;"><i class="fa-solid fa-check"></i> Correct</span>'
                        : '<span class="sg-badge" style="color:#b91c1c;background:#fef2f2;border-color:#fecaca;"><i class="fa-solid fa-xmark"></i> Incorrect</span>';
            return `<div class="sg-ans">${opts}${badge}</div>`;
        }
        if (q.type === 'attachment_response') {
            const url = safeUrl(saved?.attachmentUrl);
            if (!url) return `<div class="sg-ans sg-muted">No file or drawing submitted.</div>`;
            return isImageUrl(url)
                ? `<div class="sg-ans"><a href="${esc(url)}" target="_blank" rel="noopener noreferrer"><img src="${esc(url)}" alt="Submitted answer" style="max-height:200px;border-radius:8px;border:1px solid #e2e8f0;"></a></div>`
                : `<div class="sg-ans"><a class="sg-link" href="${esc(url)}" target="_blank" rel="noopener noreferrer"><i class="fa-solid fa-paperclip"></i> View submitted file</a></div>`;
        }
        const text = saved?.responseText || '';
        return text ? `<div class="sg-ans"><div class="sg-ans-text">${esc(text)}</div></div>` : `<div class="sg-ans sg-muted">No answer provided.</div>`;
    }

    function detailBody(g, assignment, submission) {
        const pct = g.max ? Math.round((g.score / g.max) * 100) : null;
        const gSt = pct !== null ? gradeStyle(pct) : null;
        const parts = [];

        parts.push(`
        <div class="sg-scorebox">
            <span class="big" style="color:${gSt?.color || '#1e293b'};">${esc(g.score)} / ${esc(g.max ?? '?')}</span>
            ${pct !== null ? `<span class="sg-pill" style="background:${gSt.bg};color:${gSt.color};border-color:${gSt.border};font-size:13px;">${pct}% · ${gSt.letter}</span>` : ''}
        </div>`);
        if (g.notes) parts.push(`<div><p class="sg-sec-label">Teacher feedback</p><div class="sg-box">${esc(g.notes)}</div></div>`);

        if (!g.assignmentId) {
            parts.push(`<div class="sg-box sg-muted" style="font-style:normal;">This grade was entered directly by the teacher, so there's no assignment page to show.</div>`);
            return parts.join('');
        }
        if (!assignment) {
            parts.push(`<div class="sg-box sg-muted" style="font-style:normal;">The assignment details for this grade aren't available (it may have been removed). The score and feedback above are still on record.</div>`);
            return parts.join('');
        }

        if (assignment.instructions) parts.push(`<div><p class="sg-sec-label">Instructions</p><div class="sg-box">${esc(assignment.instructions)}</div></div>`);
        const mats = (Array.isArray(assignment.attachments) ? assignment.attachments : []).filter(a => safeUrl(a && a.url));
        if (mats.length) parts.push(`<div><p class="sg-sec-label">Materials</p><div class="sg-box" style="white-space:normal;">${mats.map(a =>
            `<div style="padding:3px 0;"><a class="sg-link" href="${esc(safeUrl(a.url))}" target="_blank" rel="noopener noreferrer"><i class="fa-solid fa-paperclip"></i> ${esc(a.name || a.url)}</a></div>`).join('')}</div></div>`);
        if (safeUrl(assignment.pdfWorksheet?.url)) parts.push(`<div><p class="sg-sec-label">Worksheet</p><div class="sg-box" style="white-space:normal;"><a class="sg-link" href="${esc(safeUrl(assignment.pdfWorksheet.url))}" target="_blank" rel="noopener noreferrer"><i class="fa-solid fa-file-pdf"></i> Open the worksheet</a></div></div>`);

        const questions = Array.isArray(assignment.questions) ? assignment.questions : [];
        if (questions.length) {
            const saved = new Map((submission?.responses || []).map(r => [r.questionId, r]));
            const autoGrade = submission?.objectiveAutoGrade || null;
            const cards = questions.map((q, i) => {
                const pq = g.perQuestion?.[q.id] || null;
                const hasScore = pq && typeof pq.score === 'number';
                const pts = q.points ?? 0;
                return `
                <div class="sg-q">
                    <div class="sg-q-top">
                        <span class="sg-q-num">${i + 1}</span>
                        <div style="min-width:0;flex:1;">
                            <div class="sg-q-prompt">${esc(q.prompt || '')}</div>
                            <div class="sg-q-pts" style="${hasScore ? 'color:#059669;' : ''}">${hasScore ? `${esc(pq.score)} / ${esc(pts)}` : esc(pts)} ${pts === 1 ? 'point' : 'points'}</div>
                        </div>
                    </div>
                    ${answerHtml(q, saved.get(q.id), autoGrade)}
                    ${pq && pq.revision && pq.revision.requested && !pq.revision.submittedAt
                        ? `<div class="sg-note" style="background:#fff7ed;border-color:#fed7aa;color:#9a3412;"><b style="color:#ea580c;">Revision requested</b>${esc(pq.revision.prompt || '')}</div>` : ''}
                    ${pq && pq.note ? `<div class="sg-note"><b>Teacher's note</b>${esc(pq.note)}</div>` : ''}
                </div>`;
            }).join('');
            parts.push(`<div><p class="sg-sec-label">Questions & ${isParent ? 'answers' : 'your answers'}</p><div style="display:flex;flex-direction:column;gap:10px;">${cards}</div></div>`);
            if (!submission) parts.push(`<div class="sg-box sg-muted" style="font-style:normal;">No submission on file.</div>`);
        } else if (submission) {
            const link = safeUrl(submission.linkUrl);
            parts.push(`<div><p class="sg-sec-label">${isParent ? 'Submission' : 'Your submission'}</p><div class="sg-box">${
                submission.responseText ? esc(submission.responseText) : ''}${
                link ? `${submission.responseText ? '\n\n' : ''}<a class="sg-link" href="${esc(link)}" target="_blank" rel="noopener noreferrer"><i class="fa-solid fa-link"></i> ${esc(link)}</a>` : ''}${
                !submission.responseText && !link ? '<span class="sg-muted">Submitted with no text or link.</span>' : ''}${
                submission.submittedAt ? `\n\n<span class="sg-muted" style="font-style:normal;">Submitted ${esc(fmtDate(submission.submittedAt))}</span>` : ''}</div></div>`);
        } else {
            parts.push(`<div class="sg-box sg-muted" style="font-style:normal;">No submission on file.</div>`);
        }
        return parts.join('');
    }

    function closePanel() {
        if (!panel) return;
        const p = panel, o = overlay;
        panel = overlay = null;
        p.classList.remove('open'); o.classList.remove('open');
        setTimeout(() => { p.remove(); o.remove(); }, 230);
        document.removeEventListener('keydown', onKey);
        setUrl('item', null);
        if (lastFocus && document.contains(lastFocus)) lastFocus.focus();
    }
    function onKey(e) { if (e.key === 'Escape') closePanel(); }

    async function openPanel(gradeId) {
        const g = grades.find(x => x.id === gradeId);
        if (!g) { setUrl('item', null); return; }
        if (panel) closePanel();
        lastFocus = document.activeElement;
        setUrl('item', g.id);
        overlay = document.createElement('div');
        overlay.className = 'sg-overlay';
        panel = document.createElement('aside');
        panel.className = 'sg-panel';
        panel.setAttribute('role', 'dialog');
        panel.setAttribute('aria-modal', 'true');
        panel.setAttribute('aria-label', g.title || 'Assignment');
        const who = g.enteredByAdmin ? (g.adminName || 'Administrator') : (data.teachers[g.teacherId] || 'Teacher');
        panel.innerHTML = `
            <div class="sg-panel-head">
                <div style="min-width:0;">
                    <h2>${esc(g.title || 'Assignment')}</h2>
                    <div class="sg-panel-sub">${esc(cfg.subject)} · ${esc(g.type || 'Other')} · ${esc(fmtDate(g.date) || '—')} · ${esc(who)}</div>
                </div>
                <button type="button" class="sg-x" data-close aria-label="Close"><i class="fa-solid fa-xmark"></i></button>
            </div>
            <div class="sg-panel-body"><div class="sg-msg" style="padding:50px 10px;"><i class="fa-solid fa-circle-notch fa-spin" style="color:#6366f1;"></i>Loading assignment…</div></div>`;
        document.body.append(overlay, panel);
        overlay.addEventListener('click', closePanel);
        panel.querySelector('[data-close]').addEventListener('click', closePanel);
        document.addEventListener('keydown', onKey);
        requestAnimationFrame(() => { overlay && overlay.classList.add('open'); panel && panel.classList.add('open'); });
        panel.querySelector('[data-close]').focus();

        const mine = panel;
        try {
            const { assignment, submission } = await loadDetail(g);
            if (panel !== mine) return; // closed or replaced meanwhile
            const ins = assignment && (assignment.dueDate || assignment.date);
            if (ins) panel.querySelector('.sg-panel-sub').insertAdjacentHTML('beforeend', ` · Due ${esc(fmtDate(ins))}`);
            panel.querySelector('.sg-panel-body').innerHTML = detailBody(g, assignment, submission);
        } catch (e) {
            console.error('[SubjectGrades] detail:', e);
            if (panel === mine) panel.querySelector('.sg-panel-body').innerHTML = `<div class="sg-box sg-muted" style="font-style:normal;">Could not load this assignment. Please try again.</div>`;
        }
    }

    host.addEventListener('click', (e) => {
        if (e.target.closest('[data-clear-type]')) { setType(null); return; }
        const typeBtn = e.target.closest('[data-type]');
        if (typeBtn) { setType(selected === typeBtn.dataset.type ? null : typeBtn.dataset.type); return; }
        const item = e.target.closest('[data-item]');
        if (item) openPanel(item.dataset.item);
    });

    render();
    if (cfg.initialItem) openPanel(cfg.initialItem);
}
