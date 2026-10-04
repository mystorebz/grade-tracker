// teacher/assessments/live.js — Live Command Center for one assignment
// URL: live.html?c={classId}&s={subjectId}&a={assignmentId}
//
// RTDB assessmentLive/{schoolId}/{assignmentId}:
//   control      (teacher writes) paused · extraMinutes · collectAt · broadcast
//   presence/*   (students)       online while their page is open
//   starts/*     (students)       first open time, for timed assessments
//   violations/* (students)       integrity log (tab switch, copy, paste…)
// Firestore: submissions (live listener), drafts (read on force collect).

import { db, rtdb } from '../../assets/js/firebase-init.js';
import { requireAuth, awaitAuthReady } from '../../assets/js/auth.js';
import { injectTeacherLayout } from '../../assets/js/layout-teachers.js';
import { doc, getDoc, getDocs, collection, onSnapshot, updateDoc }
    from "https://www.gstatic.com/firebasejs/10.7.1/firebase-firestore.js";
import { ref, onValue, update, set, remove, runTransaction, serverTimestamp }
    from "https://www.gstatic.com/firebasejs/10.7.1/firebase-database.js";
import { loadClassRoster, initialsOf } from '../../assets/js/lessons/live-presence.js';
import { saveSubmission } from '../../assets/js/submissions.js';
import { normalizeControl, remainingMs, formatClock, draftToSubmission } from '../../assets/js/assessment/engine-core.js';

const session = requireAuth('teacher', '../login.html');
if (session) injectTeacherLayout('subjects', 'Live Command Center', 'Monitor and control a live assessment', false);

const params = new URLSearchParams(location.search);
const classId = params.get('c');
const subjectId = params.get('s');
const assignmentId = params.get('a');

const $ = (id) => document.getElementById(id);
const esc = (v) => String(v ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#039;' }[c]));
const VIOLATION_LABEL = { tab_switch: 'Switched tab', window_blur: 'Left window', copy: 'Copy', paste: 'Paste', cut: 'Cut', context_menu: 'Right-click', exit_fullscreen: 'Left full screen' };
const COLORS = ['#6366f1', '#0ea5e9', '#10b981', '#f59e0b', '#ef4444', '#8b5cf6', '#ec4899', '#14b8a6'];
const colorFor = (id) => COLORS[[...String(id)].reduce((h, c) => (h * 31 + c.charCodeAt(0)) >>> 0, 0) % COLORS.length];

let assignment = null;
let roster = [];
let presence = {};
let starts = {};
let violations = {};
let control = normalizeControl(null);
let submissions = new Map();
const unsubs = [];
let base = '';

function fatal(msg) { $('ccLoading').hidden = true; $('ccError').hidden = false; $('ccErrorMsg').textContent = msg; }

async function init() {
    if (!session) return;
    if (!(await awaitAuthReady('teacher', '../login.html'))) return;
    if (!classId || !subjectId || !assignmentId) { fatal('This link is missing the class, subject or assignment.'); return; }
    base = `assessmentLive/${session.schoolId}/${assignmentId}`;
    const asgRef = doc(db, 'schools', session.schoolId, 'classes', classId, 'subjects', subjectId, 'assignments', assignmentId);
    try {
        const [aSnap, sSnap, cSnap, r] = await Promise.all([
            getDoc(asgRef),
            getDoc(doc(db, 'schools', session.schoolId, 'classes', classId, 'subjects', subjectId)).catch(() => null),
            getDoc(doc(db, 'schools', session.schoolId, 'classes', classId)).catch(() => null),
            loadClassRoster(session.schoolId, classId),
        ]);
        if (!aSnap.exists()) { fatal('This assignment no longer exists.'); return; }
        assignment = {
            id: assignmentId, classId, subjectId, ...aSnap.data(),
            subjectName: sSnap?.exists() ? (sSnap.data().name || '') : '',
            className: cSnap?.exists() ? (cSnap.data().name || '') : '',
        };
        roster = r.sort((x, y) => x.name.localeCompare(y.name));
    } catch (e) {
        console.error('[Command Center] load:', e);
        fatal('Could not load this assignment. Check your connection and try again.');
        return;
    }

    document.title = `${assignment.title || 'Assessment'} · Live | ConnectUs`;
    $('ccTitle').textContent = assignment.title || 'Untitled assessment';
    $('ccMeta').textContent = [assignment.subjectName, assignment.className,
        assignment.timeLimitMin ? `${assignment.timeLimitMin} min limit` : 'Untimed',
        assignment.theme === 'strict' ? 'Strict mode' : assignment.theme === 'k5' ? 'K–5 mode' : null,
        assignment.locked ? 'Locked' : null].filter(Boolean).join(' · ');
    $('ccLoading').hidden = true;
    $('ccBody').hidden = false;

    unsubs.push(onValue(ref(rtdb, `${base}/presence`), (s) => { presence = s.val() || {}; paint(); }));
    unsubs.push(onValue(ref(rtdb, `${base}/starts`), (s) => { starts = s.val() || {}; paint(); }));
    unsubs.push(onValue(ref(rtdb, `${base}/violations`), (s) => { violations = s.val() || {}; paint(); paintLog(); }));
    unsubs.push(onValue(ref(rtdb, `${base}/control`), (s) => { control = normalizeControl(s.val()); paintControls(); paint(); }));
    unsubs.push(onSnapshot(collection(asgRef, 'submissions'), (snap) => {
        submissions = new Map(snap.docs.map((d) => [d.id, d.data()]));
        paint();
    }, (e) => console.warn('[Command Center] submissions:', e)));
    setInterval(paint, 1000);
    wire();
}

function rowsData() {
    const ids = new Set(roster.map((s) => s.id));
    const extra = Object.keys(presence).filter((id) => !ids.has(id)).map((id) => ({ id, name: presence[id]?.name || id }));
    return [...roster, ...extra].map((s) => {
        const p = presence[s.id];
        const sub = submissions.get(s.id);
        const v = violations[s.id] ? Object.values(violations[s.id]) : [];
        v.sort((a, b) => (a.at || 0) - (b.at || 0));
        const status = sub && sub.status && (!p || control.collectAt) ? 'submitted' : p ? (p.state === 'away' ? 'away' : 'working') : sub ? 'submitted' : 'offline';
        const ms = remainingMs({ timeLimitMin: Number(assignment.timeLimitMin) || 0, extraMinutes: control.extraMinutes, startedAt: Number(starts[s.id]) || 0 });
        return { ...s, status, ms, violations: v, submitted: !!sub };
    });
}

function paint() {
    if (!assignment) return;
    const rows = rowsData();
    $('ccWorking').textContent = rows.filter((r) => r.status === 'working').length;
    $('ccAway').textContent = rows.filter((r) => r.status === 'away').length;
    $('ccSubmitted').textContent = rows.filter((r) => r.submitted).length;
    $('ccViolations').textContent = rows.reduce((n, r) => n + r.violations.length, 0);
    $('ccExtra').textContent = `+${control.extraMinutes}`;
    const label = { working: 'Working', away: 'Away from test', offline: 'Not started / offline', submitted: 'Submitted' };
    $('ccRows').innerHTML = rows.map((r) => {
        const last = r.violations[r.violations.length - 1];
        return `<tr>
            <td><div class="flex items-center"><span class="cc-av" style="background:${colorFor(r.id)}" aria-hidden="true">${esc(initialsOf(r.name, r.id))}</span><div><div class="font-bold">${esc(r.name)}</div><div class="text-[11px] text-[#6b84a0]">${esc(r.id)}</div></div></div></td>
            <td><span class="cc-chip cc-${r.status}">${label[r.status]}</span>${r.submitted && r.status !== 'submitted' ? ' <span class="cc-chip cc-submitted">Submitted</span>' : ''}</td>
            <td class="cc-mono">${r.ms == null ? (assignment.timeLimitMin ? '—' : 'Untimed') : formatClock(r.ms)}</td>
            <td>${r.violations.length ? `<span class="cc-viol"><i class="fa-solid fa-triangle-exclamation"></i> ${r.violations.length} · ${esc(VIOLATION_LABEL[last.type] || last.type)}</span>` : '<span class="text-[#9ab0c6] text-[12px] font-semibold">Clean</span>'}</td>
        </tr>`;
    }).join('') || '<tr><td colspan="4" class="text-center text-[#9ab0c6] py-8">No students in this class.</td></tr>';
}

function paintLog() {
    const names = Object.fromEntries(roster.map((s) => [s.id, s.name]));
    const all = [];
    Object.entries(violations).forEach(([sid, list]) => Object.values(list || {}).forEach((v) => all.push({ sid, ...v })));
    all.sort((a, b) => (b.at || 0) - (a.at || 0));
    $('ccLog').innerHTML = all.slice(0, 40).map((v) => `<li><b>${esc(names[v.sid] || v.sid)}</b> — ${esc(VIOLATION_LABEL[v.type] || v.type)}<br><span class="text-[11px] text-[#9ab0c6]">${v.at ? new Date(v.at).toLocaleTimeString() : ''}</span></li>`).join('')
        || '<li class="text-[#9ab0c6]">Nothing yet.</li>';
}

function paintControls() {
    const btn = $('ccPause');
    btn.setAttribute('aria-pressed', String(control.paused));
    btn.querySelector('span').textContent = control.paused ? 'Resume all' : 'Pause all';
    btn.querySelector('i').className = `fa-solid ${control.paused ? 'fa-play' : 'fa-pause'}`;
    $('ccCollect').disabled = !!control.collectAt;
    $('ccAddTime').disabled = !(Number(assignment.timeLimitMin) > 0);
}

function wire() {
    const ctlRef = ref(rtdb, `${base}/control`);
    $('ccPause').addEventListener('click', () => update(ctlRef, { paused: !control.paused, updatedAt: serverTimestamp() }).catch(err));
    $('ccAddTime').addEventListener('click', () => runTransaction(ref(rtdb, `${base}/control/extraMinutes`), (cur) => Math.min(600, (Number(cur) || 0) + 5)).catch(err));
    $('ccBroadcastForm').addEventListener('submit', (e) => {
        e.preventDefault();
        const text = $('ccBroadcast').value.trim();
        if (!text) return;
        set(ref(rtdb, `${base}/control/broadcast`), { id: `b${Date.now().toString(36)}`, text: text.slice(0, 280), at: serverTimestamp() })
            .then(() => { $('ccBroadcast').value = ''; }).catch(err);
    });
    $('ccCollect').addEventListener('click', forceCollect);
    $('ccReset').addEventListener('click', () => {
        if (!confirm('Reset live controls? This clears pause, extra time, the last broadcast and the collect signal (it does not unlock the assignment).')) return;
        remove(ctlRef).catch(err);
    });
}

const err = (e) => { console.error('[Command Center]', e); alert('That action did not go through. Check your connection and try again.'); };

// Students' open pages submit themselves the moment collectAt appears. After
// a short wait, anyone still without a submission is collected from their
// saved draft, and the assignment is locked.
async function forceCollect() {
    if (!confirm('Force collect now? Every open student page submits immediately, saved drafts are submitted for everyone else, and the assignment is locked.')) return;
    const btn = $('ccCollect');
    btn.disabled = true;
    btn.innerHTML = '<i class="fa-solid fa-spinner fa-spin"></i>Collecting…';
    try {
        await update(ref(rtdb, `${base}/control`), { collectAt: serverTimestamp(), paused: false });
        await new Promise((r) => setTimeout(r, 6000));
        const draftSnap = await getDocs(collection(db, 'schools', session.schoolId, 'classes', classId, 'subjects', subjectId, 'assignments', assignmentId, 'drafts'));
        let collected = 0;
        for (const d of draftSnap.docs) {
            if (submissions.has(d.id)) continue;
            const student = roster.find((s) => s.id === d.id);
            const payload = draftToSubmission({ questions: assignment.questions || [], pdfFields: assignment.pdfWorksheet?.fields || [], fields: d.data().fields || {} });
            await saveSubmission(session.schoolId, assignment, d.id, student?.name || d.id, {
                ...(payload.responses ? { responses: payload.responses } : { responseText: payload.responseText, linkUrl: payload.linkUrl }),
                pdfAnswers: payload.pdfAnswers, workUploads: payload.workUploads, collectedBy: session.teacherId,
            });
            collected++;
        }
        const nowIso = new Date().toISOString();
        await updateDoc(doc(db, 'schools', session.schoolId, 'classes', classId, 'subjects', subjectId, 'assignments', assignmentId), { locked: true, lockedAt: nowIso, updatedAt: nowIso });
        assignment.locked = true;
        btn.innerHTML = `<i class="fa-solid fa-check"></i>Collected${collected ? ` (+${collected} from drafts)` : ''}`;
    } catch (e) {
        btn.disabled = false;
        btn.innerHTML = '<i class="fa-solid fa-box-archive"></i>Force collect';
        err(e);
    }
}

window.addEventListener('pagehide', () => unsubs.forEach((u) => u()));
init();
