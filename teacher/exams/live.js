// ── PHASE 2: TEACHER LIVE PROCTORING DASHBOARD ───────────────────────────
// Read-only view merging two independent live data streams for one exam:
//   1. RTDB examPresence/{examId} — connection/focus signals, written by
//      each student's own take.js (see student/exams/take.js, section 4-5).
//   2. Firestore exam_submissions (collection-group query) — the
//      AUTHORITATIVE status (in_progress / submitted / auto_submitted_*),
//      written by startExamAttempt, the student's own submit action, or the
//      server-side autoSubmitExpiredExams sweep.
//
// This page has NO write paths of its own — it only listens (see
// docs/phase2-exams-architecture.md, section 6, step 7: "purely a reader").
// Every signal rendered here is a raw, timestamped fact — never a verdict.
// A student shown "Tab Blurred" or "Disconnected" is exactly that: their
// tab lost focus, or their connection dropped. This page does not label,
// score, or flag it as suspicious — that judgment is left entirely to the
// teacher looking at the roster, per the design principle carried through
// this whole feature (see that same doc, section 0).

import { db, rtdb } from '../../assets/js/firebase-init.js';
import { requireAuth } from '../../assets/js/auth.js';
import { injectTeacherLayout } from '../../assets/js/layout-teachers.js';
import {
    collectionGroup, query, where, onSnapshot, doc, getDoc
} from "https://www.gstatic.com/firebasejs/10.7.1/firebase-firestore.js";
import { ref, onValue } from "https://www.gstatic.com/firebasejs/10.7.1/firebase-database.js";

// ── 1. AUTH & LAYOUT ──────────────────────────────────────────────────────
const session = requireAuth('teacher', '../login.html');
if (session) {
    injectTeacherLayout('exams', 'Live Exam Monitor', 'Real-time presence and progress for this exam', false);
}

// ── 2. EXAM CONTEXT (hash fragment, not query string) ────────────────────
// Read from window.location.hash, exactly like student/exams/take.js —
// this project's local dev server strips the query string (and the .html
// extension) from every page on load, confirmed across multiple unrelated
// pages during Phase 2 testing, not something either page's own code does.
// A hash fragment is never sent to or touched by the server at all, so it
// survives regardless of hosting environment.
const params = new URLSearchParams(window.location.hash.substring(1));
const examContext = {
    classId:   params.get('classId')   || '',
    subjectId: params.get('subjectId') || '',
    examId:    params.get('examId')    || '',
};

// ── 3. STATE ──────────────────────────────────────────────────────────────
// Two independent maps, keyed by studentId, merged only at render time —
// never combined into one shared object, so a slow/late RTDB update can
// never overwrite a Firestore field or vice versa. Each stream owns its own
// map and its own listener; rendering just reads both.
const presenceByStudent   = new Map(); // studentId -> { connectionState, tabFocused, lastSeenAt, lastFocusChangeAt, clientReportedProgress }
const submissionByStudent = new Map(); // studentId -> { status, examSubmissionId, startedAt, serverDeadline, submittedAt, autoSubmitReason }
const knownStudentIds     = new Set(); // union of every studentId seen from either stream, so the roster includes
                                        // a student even if only one of the two streams has reported them yet
                                        // (e.g. RTDB presence arrives before the Firestore listener's first snapshot)

let unsubFirestore = null;
let unsubRTDB       = null;

const els = {};

function escHtml(str) {
    if (!str) return '';
    return String(str)
        .replace(/&/g, '&amp;')
        .replace(/</g, '&lt;')
        .replace(/>/g, '&gt;')
        .replace(/"/g, '&quot;')
        .replace(/'/g, '&#039;');
}

// ── 4. INITIALIZATION ────────────────────────────────────────────────────
function init() {
    if (!session) return;

    cacheEls();

    if (!examContext.classId || !examContext.subjectId || !examContext.examId) {
        showFatalError('This dashboard link is missing information and can’t be opened. Please use the link generated for this exam.');
        return;
    }

    registerFirestoreListener();
    registerRTDBListener();
    loadActiveSemesterLabel();

    els.dashLoader.classList.add('hidden');
    els.dashBody.classList.remove('hidden');
}

function cacheEls() {
    ['dashLoader', 'dashBody', 'dashFatalState', 'dashFatalMsg', 'rosterList', 'rosterEmpty',
     'countConnected', 'countDisconnected', 'countBlurred', 'countSubmitted', 'activeSemester'
    ].forEach(id => { els[id] = document.getElementById(id); });
}

// injectTeacherLayout() ships this topbar with a static <select id=
// "activeSemester"><option>Loading…</option></select> — every teacher page
// is responsible for populating it itself (same pattern as utils.js'
// loadSchoolHeaderInfo(), which does the equivalent lookup for student
// pages' read-only #activeSemesterDisplay span). This page never did, so
// the dropdown was stuck on its placeholder forever. This page has no
// write path and no reason to let a teacher switch semesters mid-exam, so
// rather than fetch every semester and wire up a real switcher, this
// mirrors loadSchoolHeaderInfo()'s read-only behavior: show the school's
// current activeSemesterId as the one selected option.
async function loadActiveSemesterLabel() {
    if (!els.activeSemester) return;
    let semesterName = 'Unknown Period';
    try {
        const schoolSnap = await getDoc(doc(db, 'schools', session.schoolId));
        const schoolData = schoolSnap.exists() ? schoolSnap.data() : null;
        if (schoolData?.activeSemesterId) {
            const semSnap = await getDoc(doc(db, 'schools', session.schoolId, 'semesters', schoolData.activeSemesterId));
            if (semSnap.exists() && semSnap.data().name) semesterName = semSnap.data().name;
        }
    } catch (e) {
        console.error('[Live Exam Monitor] Failed to load active semester:', e);
    }
    els.activeSemester.innerHTML = `<option value="">${escHtml(semesterName)}</option>`;
}

function showFatalError(message) {
    if (els.dashLoader) els.dashLoader.classList.add('hidden');
    if (els.dashFatalMsg) els.dashFatalMsg.textContent = message;
    if (els.dashFatalState) els.dashFatalState.classList.remove('hidden');
}

// ── 5. FIRESTORE LISTENER (authoritative status) ─────────────────────────
// Collection-group query, scoped by schoolId, isSchoolActive, AND examId.
// The schoolId and isSchoolActive filters are not optional set-dressing —
// they are what make this query legal at all under firestore.rules' `allow
// list` rule for exam_submissions: Firestore security rules cannot act as a
// post-hoc filter for a `list` operation ("queries are all or nothing" —
// https://firebase.google.com/docs/firestore/security/rules-query), so the
// rule can only permit this query if it can prove, from the query's own
// where() clauses, that every possible result belongs to the caller's own
// active school. The rule checks resource.data.isSchoolActive == true
// directly (a boolean denormalized onto each submission doc by
// startExamAttempt — see functions/index.js) rather than calling a
// get()-based isSchoolActive(schoolId) helper, because a rule that calls
// get()/exists() anywhere in its evaluation can't be proven safe for a
// list/collection-group query and gets rejected outright, even when the
// get() target is a per-request constant rather than a per-document
// lookup. Dropping either where() clause here would make Firestore reject
// the whole query outright with permission-denied, not silently return
// fewer results — see firestore.rules' own comment on that rule for the
// full explanation.
function registerFirestoreListener() {
    const q = query(
        collectionGroup(db, 'exam_submissions'),
        where('schoolId', '==', session.schoolId),
        where('isSchoolActive', '==', true),
        where('examId', '==', examContext.examId)
    );

    unsubFirestore = onSnapshot(q, (snap) => {
        snap.docChanges().forEach(change => {
            const data = change.doc.data();
            const studentId = data.studentId;
            if (!studentId) return; // defensive: every real submission carries this, but never trust blindly

            if (change.type === 'removed') {
                submissionByStudent.delete(studentId);
                return;
            }
            knownStudentIds.add(studentId);
            submissionByStudent.set(studentId, {
                examSubmissionId: change.doc.id,
                status: data.status,
                startedAt: data.startedAt,
                serverDeadline: data.serverDeadline,
                submittedAt: data.submittedAt,
                autoSubmitReason: data.autoSubmitReason,
                score: data.score,
                pendingManualPoints: data.pendingManualPoints,
            });
        });
        render();
    }, (error) => {
        console.error('[Live Exam Monitor] Firestore listener error:', error);
        showFatalError('Could not load submission data for this exam. Check the console for details.');
    });
}

// ── 6. RTDB LISTENER (presence / connection / focus) ─────────────────────
// One listener on the whole examPresence/{examId} node (all students under
// it at once) rather than one per student — cheaper, and it means a student
// starting the exam mid-session (their presence node appearing for the
// first time) is picked up automatically without this page needing to know
// in advance who's taking the exam. Read-only: this page's firestore.rules
// / database.rules.json grant it .read but never .write on this path (see
// database.rules.json — a teacher may read any student's presence node
// under their own school's exam, but can never write one, so this
// dashboard cannot fabricate presence data even by accident).
//
// IMPORTANT — why .read for teacher/admin is declared at examPresence/$examId
// in database.rules.json, not one level deeper at $studentId: this listener
// subscribes to the $examId node itself (every student under it, in one
// stream), and RTDB does not grant read access upward to a listener at a
// parent path just because every individual child would separately pass a
// child-level .read check. The .read condition must be satisfiable at (or
// above) the exact node a client subscribes to — the RTDB analog of
// Firestore's "queries are all or nothing": a bulk read has to be provably
// safe at the level it's issued from, not proven safe child-by-child after
// the fact. A .read defined only at $examId/$studentId would make this
// exact listener permission_denied even though a teacher could legally read
// any single student's node directly by path.
function registerRTDBListener() {
    const node = ref(rtdb, `examPresence/${examContext.examId}`);
    unsubRTDB = onValue(node, (snap) => {
        const allPresence = snap.val() || {};
        presenceByStudent.clear();
        for (const [studentId, presenceData] of Object.entries(allPresence)) {
            knownStudentIds.add(studentId);
            presenceByStudent.set(studentId, presenceData);
        }
        render();
    }, (error) => {
        console.error('[Live Exam Monitor] RTDB listener error:', error);
        // Not fatal — Firestore submission status is still authoritative and
        // still renders; only the live presence column degrades. A teacher
        // can still see who's submitted/in-progress even if presence itself
        // is temporarily unavailable.
    });
}

// ── 7. RENDER ─────────────────────────────────────────────────────────────
// Recomputes the whole roster on every change from either stream. This
// dashboard is expected to track a single class's exam (tens of students,
// not thousands), so a full re-render per update is simpler and safer than
// incremental DOM patching, and avoids an entire class of bugs where a
// stale row lingers after a student's data is removed.
function render() {
    const studentIds = Array.from(knownStudentIds).sort();

    if (!studentIds.length) {
        els.rosterList.innerHTML = '';
        els.rosterEmpty.classList.remove('hidden');
        updateCounts([]);
        return;
    }
    els.rosterEmpty.classList.add('hidden');

    const rows = studentIds.map(studentId => buildRowModel(studentId));
    els.rosterList.innerHTML = rows.map(renderRow).join('');
    updateCounts(rows);
}

function buildRowModel(studentId) {
    const presence   = presenceByStudent.get(studentId) || null;
    const submission = submissionByStudent.get(studentId) || null;

    const connectionState = presence?.connectionState || 'unknown';
    const tabFocused       = presence ? presence.tabFocused !== false : null; // null = no presence data at all yet
    const status           = submission?.status || 'not_started';
    const questionsAnswered = presence?.clientReportedProgress?.questionsAnswered;

    return { studentId, presence, submission, connectionState, tabFocused, status, questionsAnswered };
}

const STATUS_META = {
    not_started:                          { label: 'Not Started',        classes: 'bg-slate-100 text-slate-500 border-slate-200' },
    in_progress:                          { label: 'In Progress',        classes: 'bg-emerald-50 text-emerald-700 border-emerald-200' },
    submitted:                            { label: 'Submitted',          classes: 'bg-teal-50 text-teal-700 border-teal-200' },
    auto_submitted_timeout:               { label: 'Auto-Submitted (Timeout)',    classes: 'bg-amber-50 text-amber-700 border-amber-200' },
    auto_submitted_disconnect_grace_expired: { label: 'Auto-Submitted (Disconnect)', classes: 'bg-amber-50 text-amber-700 border-amber-200' },
    graded:                               { label: 'Graded',              classes: 'bg-indigo-50 text-indigo-700 border-indigo-200' },
};

function renderRow(row) {
    const statusMeta = STATUS_META[row.status] || STATUS_META.not_started;

    // ── Raw signal chips — connection and focus are rendered independently
    // and objectively. No combined "risk" score, no accusatory language.
    const signalChips = [];

    if (row.connectionState === 'disconnected') {
        signalChips.push(`<span class="signal-chip signal-chip-alert"><i class="fa-solid fa-plug-circle-xmark"></i> Disconnected</span>`);
    } else if (row.connectionState === 'connected') {
        signalChips.push(`<span class="signal-chip signal-chip-ok"><i class="fa-solid fa-signal"></i> Connected</span>`);
    } else {
        signalChips.push(`<span class="signal-chip signal-chip-neutral"><i class="fa-solid fa-circle-question"></i> No signal yet</span>`);
    }

    if (row.tabFocused === false) {
        signalChips.push(`<span class="signal-chip signal-chip-alert"><i class="fa-solid fa-eye-slash"></i> Tab Blurred</span>`);
    } else if (row.tabFocused === true) {
        signalChips.push(`<span class="signal-chip signal-chip-ok"><i class="fa-solid fa-eye"></i> Tab Focused</span>`);
    }

    const progressText = row.questionsAnswered !== undefined
        ? `${row.questionsAnswered} question${row.questionsAnswered === 1 ? '' : 's'} answered`
        : '—';

    return `
    <div class="roster-row">
        <div class="roster-row-student">
            <p class="roster-row-id">${escHtml(row.studentId)}</p>
        </div>
        <div class="roster-row-status">
            <span class="status-pill ${statusMeta.classes}">${statusMeta.label}</span>
        </div>
        <div class="roster-row-signals">
            ${signalChips.join('')}
        </div>
        <div class="roster-row-progress">${escHtml(progressText)}</div>
    </div>`;
}

function updateCounts(rows) {
    const connected    = rows.filter(r => r.connectionState === 'connected').length;
    const disconnected = rows.filter(r => r.connectionState === 'disconnected').length;
    const blurred       = rows.filter(r => r.tabFocused === false).length;
    const submitted     = rows.filter(r => ['submitted', 'auto_submitted_timeout', 'auto_submitted_disconnect_grace_expired', 'graded'].includes(r.status)).length;

    if (els.countConnected)    els.countConnected.textContent    = connected;
    if (els.countDisconnected) els.countDisconnected.textContent = disconnected;
    if (els.countBlurred)       els.countBlurred.textContent       = blurred;
    if (els.countSubmitted)     els.countSubmitted.textContent     = submitted;
}

// ── 8. CLEANUP ────────────────────────────────────────────────────────────
// Detach both listeners on navigation away — this page has no writes to
// flush and no beforeunload warning of its own (a teacher should be able to
// leave this dashboard freely; only the student-side exam page needs to
// guard against an accidental close).
window.addEventListener('pagehide', () => {
    if (unsubFirestore) { unsubFirestore(); unsubFirestore = null; }
    if (unsubRTDB) { unsubRTDB(); unsubRTDB = null; }
});

init();
