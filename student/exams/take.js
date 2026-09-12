// ── PHASE 2: STUDENT EXAM-TAKING PAGE ────────────────────────────────────
// Loads a live exam, starts/resumes the student's own attempt via the
// tamper-proof startExamAttempt callable, then keeps three things running
// for the duration of the exam:
//   1. RTDB presence (examPresence/{examId}/{studentId}) — a heartbeat +
//      an onDisconnect() handler registered the moment the page loads, so a
//      genuine network drop is caught server-side even if this tab never
//      gets a chance to run any more JS (see firebase-init.js and
//      docs/phase2-exams-architecture.md, section 5, item 4).
//   2. Raw tab-focus signal logging (Firestore proctoring.tabFocusEvents) —
//      timestamped blur/focus facts only, never an "infraction" verdict.
//      See docs/phase2-exams-architecture.md, section 0.
//   3. Per-question autosave (Firestore answers.{questionId}) — debounced,
//      each write stamped with its own savedAt so autosave is a checkable
//      property of the data, not just a UI claim.
//
// This page assumes the exam identity (schoolId/classId/subjectId/examId)
// arrives via the URL query string — e.g.
//   take.html?classId=class-a&subjectId=sub_a1&examId=exam_test01
// schoolId is never taken from the URL: it always comes from the student's
// own authenticated session, exactly like every other student page in this
// app, so a student can never even attempt to address another school's exam.

import { auth, db, rtdb, functions } from '../../assets/js/firebase-init.js';
import { requireAuth } from '../../assets/js/auth.js';
import { injectStudentLayout } from '../../assets/js/layout-student.js';
import { httpsCallable } from "https://www.gstatic.com/firebasejs/10.7.1/firebase-functions.js";
import {
    doc, getDoc, updateDoc, onSnapshot, arrayUnion
} from "https://www.gstatic.com/firebasejs/10.7.1/firebase-firestore.js";
import {
    ref, set, update, onDisconnect, serverTimestamp as rtdbServerTimestamp
} from "https://www.gstatic.com/firebasejs/10.7.1/firebase-database.js";

// ── 1. AUTHENTICATION & LAYOUT ───────────────────────────────────────────
const session = requireAuth('student', '../login.html');
if (session) {
    injectStudentLayout('exams', 'Exam', 'Complete the exam before time runs out');
}

// ── 2. STATE ──────────────────────────────────────────────────────────────
// Read from the URL HASH fragment (#classId=...&subjectId=...&examId=...),
// not the query string. The local dev server serving this app strips both
// the .html extension AND the entire query string on every page (confirmed
// across unrelated pages too — /student/login.html, /student/home/home.html
// — so it's a blanket "clean URL" rewrite/redirect in the server, not
// anything this app's own code does). A hash fragment is never sent to the
// server at all — it's a pure client-side URL feature — so no server-side
// rewrite/redirect can ever touch or drop it, regardless of hosting
// environment. This makes exam links robust across any static host, not
// just whatever's currently running on localhost:3000.
const params = new URLSearchParams(window.location.hash.substring(1));
const examContext = {
    classId:   params.get('classId')   || '',
    subjectId: params.get('subjectId') || '',
    examId:    params.get('examId')    || '',
};

let examConfig       = null;   // the exams/{examId} doc (questions, timeLimitSeconds, ...)
let examSubmissionId = null;   // students/{studentId}/exam_submissions/{id}
let submissionData   = null;   // local mirror of the submission doc, updated on every autosave
let deadlineMs        = null;  // parsed from submission.serverDeadline, ms epoch
let countdownInterval = null;
let unsubSubmission   = null;  // Firestore onSnapshot unsubscribe, so a stale listener never outlives the page
let pageUnloading     = false; // guards against post-unload writes racing the disconnect handler

// Per-question autosave debouncing — one timer per question so typing in q1
// never resets q2's pending save, and each question's savedAt reflects that
// question's own last write, not whichever field happened to save last.
const AUTOSAVE_DEBOUNCE_MS = 1200;
const pendingAutosaveTimers = new Map(); // questionId -> setTimeout handle
const latestAnswerValues    = new Map(); // questionId -> value currently in the input, source of truth for a debounced save

// A failed save's status text ("Could not save — retrying…") self-clears
// after this long if nothing else has overwritten it by then (a later
// successful save, or the page moving to renderTerminalState() entirely) —
// see saveAnswer()'s catch block for why this exists.
const STATUS_MESSAGE_RESET_MS = 6000;
const pendingStatusResetTimers = new Map(); // questionId -> setTimeout handle

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

// ── 3. INITIALIZATION ───────────────────────────────────────────────────
async function init() {
    if (!session) return;

    cacheEls();

    if (!examContext.classId || !examContext.subjectId || !examContext.examId) {
        showFatalError('This exam link is missing information and can’t be opened. Please use the link your teacher provided.');
        return;
    }

    try {
        // ── 3a. Load the exam config (questions, time limit) ──────────────
        const examRef = doc(db, 'schools', session.schoolId, 'classes', examContext.classId,
            'subjects', examContext.subjectId, 'exams', examContext.examId);
        const examSnap = await getDoc(examRef);

        if (!examSnap.exists()) {
            showFatalError('This exam could not be found.');
            return;
        }
        examConfig = examSnap.data();

        if (examConfig.isLive !== true) {
            showFatalError('This exam is not currently live. Check back when your teacher starts it.');
            return;
        }

        // ── 3b. Start (or resume) the attempt — server computes the real
        // deadline; the client never supplies or trusts one of its own ────
        const startExamAttempt = httpsCallable(functions, 'startExamAttempt');
        const result = await startExamAttempt({
            classId:   examContext.classId,
            subjectId: examContext.subjectId,
            examId:    examContext.examId,
        });

        examSubmissionId = result.data.examSubmissionId;
        submissionData    = result.data.submission;
        deadlineMs        = new Date(submissionData.serverDeadline).getTime();

        if (submissionData.status !== 'in_progress') {
            // Resumed a page load after the exam already ended server-side
            // (auto-submitted while this tab was closed/asleep) — show the
            // result state, not the exam form.
            renderTerminalState(submissionData.status);
            return;
        }

        // ── 3c. Wire up everything that must run for the rest of the exam ──
        registerPresence();
        registerDisconnectWatcher();
        registerVisibilityLogging();
        registerBeforeUnloadWarning();
        watchSubmissionForServerSideChanges();

        renderExam();
        startCountdown();
    } catch (e) {
        console.error('[Take Exam] init:', e);
        const message = e?.code === 'functions/failed-precondition'
            ? (e.message || 'This exam is not currently available.')
            : 'Something went wrong loading your exam. Please try again.';
        showFatalError(message);
    }
}

function cacheEls() {
    ['examLoader', 'examBody', 'examTitle', 'examTimer', 'examTimerWrap',
     'examQuestionList', 'examSubmitBtn', 'examSubmitMsg', 'examFatalState', 'examFatalMsg'
    ].forEach(id => { els[id] = document.getElementById(id); });
}

function showFatalError(message) {
    if (els.examLoader) els.examLoader.classList.add('hidden');
    if (els.examBody) els.examBody.classList.add('hidden');
    if (els.examFatalMsg) els.examFatalMsg.textContent = message;
    if (els.examFatalState) els.examFatalState.classList.remove('hidden');
}

// ── 4. RTDB PRESENCE ─────────────────────────────────────────────────────
// One node per (examId, studentId), written only by that student (RTDB
// rules enforce this: .write requires auth.token.studentId === $studentId).
function presenceRef() {
    return ref(rtdb, `examPresence/${examContext.examId}/${session.studentId}`);
}

function registerPresence() {
    const node = presenceRef();

    // Initial "I'm here" write. lastSeenAt/lastFocusChangeAt use RTDB's own
    // server clock (serverTimestamp()), never the client's — a client clock
    // can be wrong or deliberately spoofed, and this value feeds a teacher's
    // live dashboard, so it needs to be trustworthy the same way
    // serverDeadline is.
    set(node, {
        connectionState: 'connected',
        lastSeenAt: rtdbServerTimestamp(),
        tabFocused: document.visibilityState === 'visible',
        lastFocusChangeAt: rtdbServerTimestamp(),
    }).catch(e => console.error('[Take Exam] registerPresence initial write failed:', e));

    // Lightweight heartbeat — refreshes lastSeenAt every 20s so a teacher's
    // dashboard can distinguish "connected and actively holding a session"
    // from a stale node whose onDisconnect somehow never fired (e.g. an
    // ungraceful process kill in rare cases the RTDB backend itself can't
    // observe). Deliberately NOT the mechanism that detects disconnects —
    // that's onDisconnect() below, which is server-executed and does not
    // depend on this interval ever running again.
    setInterval(() => {
        if (pageUnloading) return;
        update(node, { lastSeenAt: rtdbServerTimestamp() })
            .catch(e => console.error('[Take Exam] presence heartbeat failed:', e));
    }, 20000);
}

// Registered the moment the page loads — this is the whole point of using
// RTDB instead of a Firestore heartbeat doc. onDisconnect() is queued
// SERVER-SIDE the instant this call resolves; if the socket then dies for
// any reason (Wi-Fi drops, laptop sleeps, tab is force-closed), the RTDB
// backend itself writes connectionState: 'disconnected' — no further
// client-side code has to run for that write to happen. See
// docs/phase2-exams-architecture.md, section 5, item 4.
function registerDisconnectWatcher() {
    const node = presenceRef();
    onDisconnect(node).update({
        connectionState: 'disconnected',
        lastSeenAt: rtdbServerTimestamp(),
    }).catch(e => console.error('[Take Exam] registerDisconnectWatcher failed to arm:', e));
}

// ── 5. RAW TAB-FOCUS SIGNAL LOGGING (Firestore) ──────────────────────────
// Every blur/focus is appended as its own timestamped event — never
// aggregated into a counter, never labeled as an infraction. See
// docs/phase2-exams-architecture.md, section 0. Duration is attached to the
// FOCUS event (how long the tab was blurred for), matching the schema in
// section 2.2 of that doc, computed from the last blur logged locally
// rather than re-read from Firestore each time (avoids a read on every
// single focus change).
let lastBlurAt = null;

function registerVisibilityLogging() {
    document.addEventListener('visibilitychange', () => {
        if (!examSubmissionId || pageUnloading) return;

        const now = new Date();
        const nowIso = now.toISOString();

        if (document.visibilityState === 'hidden') {
            lastBlurAt = now;
            appendProctoringEvent('tabFocusEvents', { type: 'blur', at: nowIso });
            updatePresenceFocusState(false, nowIso);
        } else if (document.visibilityState === 'visible') {
            const event = { type: 'focus', at: nowIso };
            if (lastBlurAt) {
                event.blurDurationMs = now.getTime() - lastBlurAt.getTime();
            }
            appendProctoringEvent('tabFocusEvents', event);
            updatePresenceFocusState(true, nowIso);
            lastBlurAt = null;
        }
    });
}

function updatePresenceFocusState(tabFocused, nowIso) {
    update(presenceRef(), {
        tabFocused,
        lastFocusChangeAt: rtdbServerTimestamp(),
        lastSeenAt: rtdbServerTimestamp(),
    }).catch(e => console.error('[Take Exam] updatePresenceFocusState failed:', e));
}

// Shared append helper for both tabFocusEvents and (if ever needed)
// disconnectEvents — arrayUnion so concurrent writes from this same tab
// never clobber each other, and so this never has to read-modify-write the
// whole proctoring object just to add one event.
function appendProctoringEvent(arrayName, event) {
    const ref = doc(db, 'students', session.studentId, 'exam_submissions', examSubmissionId);
    updateDoc(ref, {
        [`proctoring.${arrayName}`]: arrayUnion(event)
    }).catch(e => console.error(`[Take Exam] appendProctoringEvent(${arrayName}) failed:`, e));
}

// A student closing the tab mid-exam is exactly as valid a raw signal as a
// network drop — this does not attempt to distinguish "deliberate" from
// "accidental," matching the disconnect-scope decision made before writing
// any of this code. beforeunload here only warns the student; it never
// blocks navigation, and it never writes anything itself — the actual
// disconnected-state write is onDisconnect()'s job (registered above),
// which fires from the server side regardless of whether this handler runs.
function registerBeforeUnloadWarning() {
    window.addEventListener('beforeunload', (e) => {
        if (!examSubmissionId || pageUnloading) return;
        if (submissionData && submissionData.status !== 'in_progress') return;
        e.preventDefault();
        e.returnValue = '';
    });
}

// ── 6. WATCH THE SUBMISSION DOC FOR SERVER-SIDE CHANGES ──────────────────
// autoSubmitExpiredExams (a Cloud Function, not this client) can flip this
// student's own status to auto_submitted_timeout at any moment, independent
// of anything happening in this tab. This listener is what notices that and
// locks the UI immediately, rather than letting a student keep typing into
// a form whose writes the tightened firestore.rules will now silently
// reject (student loses write access the instant status leaves
// in_progress — see docs/phase2-exams-architecture.md, section 3.2).
//
// This listener must keep running PAST the first terminal status, not just
// until the exam leaves in_progress. status can transition a SECOND time —
// submitted -> graded — whenever a teacher finishes manual grading via
// recordManualGrade, which can happen while the student's own tab is still
// open on this page. Terminal is not final: renderTerminalState() no longer
// tears this listener down (it used to unsubscribe on its very first call,
// which meant a student watching this page at the moment their exam got
// graded would keep seeing "Your exam has been submitted." forever, with no
// way to see the real "graded" message short of a manual reload — the exact
// same stale-terminal-message bug class already found and fixed once this
// phase for examSubmitMsg, just triggered by a second real status
// transition instead of a leftover DOM state). The listener now only ever
// stops via cleanupBeforePageExit(), on actual page teardown.
function watchSubmissionForServerSideChanges() {
    const ref = doc(db, 'students', session.studentId, 'exam_submissions', examSubmissionId);
    unsubSubmission = onSnapshot(ref, (snap) => {
        if (!snap.exists()) return;
        const data = snap.data();
        submissionData = data;
        if (data.status !== 'in_progress') {
            renderTerminalState(data.status);
        }
    }, (error) => {
        console.error('[Take Exam] submission watcher error:', error);
    });
}

// ── 7. RENDER ─────────────────────────────────────────────────────────────
function renderExam() {
    els.examLoader.classList.add('hidden');
    els.examBody.classList.remove('hidden');
    els.examTimerWrap.classList.remove('hidden');

    // examSubmitMsg can be left visible from a PRIOR page-lifetime state —
    // a terminal message from renderTerminalState(), or a failed-submit
    // error from the submit button's catch block — and nothing before this
    // point ever cleared it. Since renderExam() only ever runs when the
    // submission is genuinely in_progress (the caller checks status first),
    // any leftover text here is stale by definition: re-hide and clear it
    // on every fresh render so a resumed or newly-started attempt never
    // shows a contradictory terminal/error message alongside live questions.
    if (els.examSubmitMsg) {
        els.examSubmitMsg.textContent = '';
        els.examSubmitMsg.classList.add('hidden');
    }

    els.examTitle.textContent = examConfig.title || 'Exam';

    els.examQuestionList.innerHTML = (examConfig.questions || []).map(renderQuestion).join('');

    (examConfig.questions || []).forEach(q => {
        const existing = submissionData.answers?.[q.id]?.value;
        if (existing !== undefined) latestAnswerValues.set(q.id, existing);
        wireQuestionInput(q);
    });
}

function renderQuestion(q, index) {
    const savedValue = submissionData.answers?.[q.id]?.value;

    const inputHtml = q.type === 'multiple_choice'
        ? (q.options || []).map((opt, i) => `
            <label class="flex items-center gap-2.5 p-3 border border-slate-200 rounded-xl cursor-pointer hover:bg-slate-50">
                <input type="radio" name="q_${escHtml(q.id)}" value="${escHtml(opt)}"
                    data-question-id="${escHtml(q.id)}" class="exam-answer-input"
                    ${savedValue === opt ? 'checked' : ''}>
                <span class="text-[13.5px] text-slate-700 font-semibold">${escHtml(opt)}</span>
            </label>`).join('')
        : `<textarea data-question-id="${escHtml(q.id)}" class="exam-answer-input form-input w-full p-3 bg-white border border-slate-200 rounded-xl text-sm resize-none leading-relaxed" style="height: 8rem;" placeholder="Write your answer here…">${escHtml(savedValue || '')}</textarea>`;

    return `
    <div class="bg-white rounded-xl shadow-sm border border-slate-200 p-4 mb-4">
        <div class="flex items-center justify-between mb-2">
            <p class="font-black text-slate-800 text-[14px] m-0">Question ${index + 1}</p>
            <span class="text-[10.5px] font-bold bg-slate-100 text-slate-500 px-2 py-0.5 rounded">${q.points} pt${q.points === 1 ? '' : 's'}</span>
        </div>
        <p class="text-[13.5px] text-slate-700 mb-3 whitespace-pre-wrap">${escHtml(q.prompt)}</p>
        <div class="space-y-2">${inputHtml}</div>
        <p class="text-[10.5px] text-slate-400 font-semibold mt-2" id="qSaveStatus_${escHtml(q.id)}"></p>
    </div>`;
}

function wireQuestionInput(q) {
    const inputs = document.querySelectorAll(`.exam-answer-input[data-question-id="${q.id}"]`);
    inputs.forEach(input => {
        const eventName = input.tagName === 'TEXTAREA' ? 'input' : 'change';
        input.addEventListener(eventName, () => {
            const value = input.type === 'radio'
                ? document.querySelector(`input[name="q_${q.id}"]:checked`)?.value
                : input.value;
            latestAnswerValues.set(q.id, value ?? '');
            scheduleAutosave(q.id);
        });
    });
}

// ── 8. PER-QUESTION AUTOSAVE ─────────────────────────────────────────────
// Debounced per question — a burst of keystrokes in a free-response box
// collapses into one write, not one per keystroke, while a different
// question's own debounce timer is completely independent of this one.
function scheduleAutosave(questionId) {
    const statusEl = document.getElementById(`qSaveStatus_${questionId}`);
    if (statusEl) statusEl.textContent = 'Saving…';

    if (pendingAutosaveTimers.has(questionId)) {
        clearTimeout(pendingAutosaveTimers.get(questionId));
    }
    const timer = setTimeout(() => {
        pendingAutosaveTimers.delete(questionId);
        saveAnswer(questionId);
    }, AUTOSAVE_DEBOUNCE_MS);
    pendingAutosaveTimers.set(questionId, timer);
}

async function saveAnswer(questionId) {
    const statusEl = document.getElementById(`qSaveStatus_${questionId}`);
    const value = latestAnswerValues.get(questionId) ?? '';
    const savedAt = new Date().toISOString();

    try {
        const ref = doc(db, 'students', session.studentId, 'exam_submissions', examSubmissionId);
        await updateDoc(ref, {
            [`answers.${questionId}`]: { value, savedAt }
        });
        // Keep the local mirror in sync so a later renderExam() (unlikely,
        // but e.g. after resuming from a terminal-state race) still shows
        // the right saved value.
        if (!submissionData.answers) submissionData.answers = {};
        submissionData.answers[questionId] = { value, savedAt };

        // A prior failed save on this same question may have queued a
        // reset timer (see the catch block below) to blank a stale error
        // message after a few seconds. This save just succeeded and wrote
        // its own "Saved …" text, so that queued reset must not later fire
        // and blank THIS message out from under it.
        clearTimeout(pendingStatusResetTimers.get(questionId));
        pendingStatusResetTimers.delete(questionId);

        if (statusEl) statusEl.textContent = `Saved ${new Date(savedAt).toLocaleTimeString()}`;

        updatePresenceProgress();
    } catch (e) {
        console.error(`[Take Exam] saveAnswer(${questionId}) failed:`, e);
        if (statusEl) {
            // A permission-denied write here means status has left in_progress
            // server-side — but watchSubmissionForServerSideChanges (the
            // onSnapshot listener registered in init()) is the single source
            // of truth for that transition: it already swaps the ENTIRE page
            // to renderTerminalState() the moment it observes the real status
            // change, which normally happens before or immediately alongside
            // this catch running. This message must therefore never claim the
            // exam has ended on its own authority — a stale in-memory
            // examSubmissionId (e.g. a page instance that outlived its own
            // submission for any reason) would otherwise show a permanent,
            // wrong, unrecoverable-sounding "this exam has ended" on a
            // question that may still be perfectly live, with no way for the
            // student to tell the difference or recover short of a reload.
            // Kept deliberately generic and transient-sounding instead;
            // watchSubmissionForServerSideChanges is what actually locks the
            // UI when the exam is genuinely over.
            statusEl.textContent = 'Could not save — retrying…';

            // Clear this question's status line back to neutral once the
            // underlying cause resolves, instead of leaving stale text
            // sitting in the DOM indefinitely. Three independent ways this
            // can resolve:
            //  1. The exam genuinely ended server-side: the onSnapshot
            //     listener above replaces the whole page with
            //     renderTerminalState(), so this line becomes moot — no
            //     special-casing needed here.
            //  2. The failure was transient (network blip, a write that
            //     landed just before rules picked up a fresh document): the
            //     next successful autosave on this question overwrites this
            //     text with "Saved …" on its own, via the try block above.
            //  3. Neither happens within a few seconds (e.g. this specific
            //     question is never edited again): fall back to clearing the
            //     line to blank rather than leaving an alarming, possibly
            //     inaccurate message on screen forever.
            clearTimeout(pendingStatusResetTimers.get(questionId));
            const resetTimer = setTimeout(() => {
                pendingStatusResetTimers.delete(questionId);
                const el = document.getElementById(`qSaveStatus_${questionId}`);
                if (el && el.textContent === 'Could not save — retrying…') {
                    el.textContent = '';
                }
            }, STATUS_MESSAGE_RESET_MS);
            pendingStatusResetTimers.set(questionId, resetTimer);
        }
    }
}

// clientReportedProgress is advisory-only for the teacher's live dashboard
// (see docs/phase2-exams-architecture.md, section 2.4) — never read back
// as authoritative by anything, including this page itself.
function updatePresenceProgress() {
    const answeredCount = (examConfig.questions || [])
        .filter(q => {
            const v = submissionData.answers?.[q.id]?.value;
            return v !== undefined && v !== null && v !== '';
        }).length;

    update(presenceRef(), {
        lastSeenAt: rtdbServerTimestamp(),
        clientReportedProgress: {
            questionsAnswered: answeredCount,
            lastSavedAt: rtdbServerTimestamp(),
        },
    }).catch(e => console.error('[Take Exam] updatePresenceProgress failed:', e));
}

// ── 9. COUNTDOWN ─────────────────────────────────────────────────────────
// Purely a UI convenience — this countdown reaching zero does NOT submit
// the exam itself. The real enforcement is server-side
// (autoSubmitExpiredExams, running on its own schedule against
// serverDeadline) exactly per the "server-side enforcement" requirement;
// this timer existing only in the client would be trivially defeated by
// pausing JS execution or editing the DOM. If this countdown and the
// server's sweep ever disagree, watchSubmissionForServerSideChanges() above
// is what actually locks the form — this display is cosmetic.
function startCountdown() {
    updateCountdownDisplay();
    countdownInterval = setInterval(updateCountdownDisplay, 1000);
}

function updateCountdownDisplay() {
    const remainingMs = deadlineMs - Date.now();
    if (remainingMs <= 0) {
        els.examTimer.textContent = '0:00';
        els.examTimer.classList.add('text-rose-600');
        clearInterval(countdownInterval);
        return;
    }
    const totalSeconds = Math.floor(remainingMs / 1000);
    const minutes = Math.floor(totalSeconds / 60);
    const seconds = totalSeconds % 60;
    els.examTimer.textContent = `${minutes}:${String(seconds).padStart(2, '0')}`;
    if (remainingMs < 60000) els.examTimer.classList.add('text-rose-600');
}

// ── 10. MANUAL SUBMIT ─────────────────────────────────────────────────────
window.submitExam = async function() {
    if (!examSubmissionId || !submissionData || submissionData.status !== 'in_progress') return;

    // Flush any pending debounced autosaves immediately rather than let the
    // student submit while a save is still in flight — a submit racing an
    // unsaved keystroke would silently drop that last answer.
    for (const [questionId, timer] of pendingAutosaveTimers.entries()) {
        clearTimeout(timer);
        pendingAutosaveTimers.delete(questionId);
        await saveAnswer(questionId);
    }

    const btn = els.examSubmitBtn;
    const prevHtml = btn.innerHTML;
    btn.innerHTML = '<i class="fa-solid fa-spinner fa-spin"></i> Submitting…';
    btn.disabled = true;

    try {
        const ref = doc(db, 'students', session.studentId, 'exam_submissions', examSubmissionId);
        await updateDoc(ref, {
            status: 'submitted',
            submittedAt: new Date().toISOString(),
        });
        // watchSubmissionForServerSideChanges() picks up this same write via
        // its own onSnapshot listener and calls renderTerminalState() — no
        // need to call it again here, which would risk it running twice.
    } catch (e) {
        console.error('[Take Exam] submitExam failed:', e);
        btn.innerHTML = prevHtml;
        btn.disabled = false;
        if (els.examSubmitMsg) {
            const message = e?.code === 'permission-denied'
                ? 'This exam has already ended — it could not be submitted again.'
                : 'Could not submit. Please check your connection and try again.';
            els.examSubmitMsg.textContent = message;
            els.examSubmitMsg.classList.remove('hidden');
        }
    }
};

// ── 11. TERMINAL STATE (submitted / auto-submitted / graded) ────────────
// Called every time status leaves in_progress OR changes to a different
// terminal value — submitted -> graded is a real, later re-entry into this
// same function, not a one-time event. Must stay safe to call more than
// once (disabling already-disabled inputs, clearing an already-cleared
// countdown, etc. are all no-ops) and must NOT tear down the submission
// listener — see watchSubmissionForServerSideChanges()'s own comment for
// why that used to happen here and what it broke.
function renderTerminalState(status) {
    if (countdownInterval) clearInterval(countdownInterval);

    // Disarm further local writes — the rules would reject them anyway
    // (student loses write access the instant status leaves in_progress),
    // but not scheduling them at all avoids a burst of console errors on an
    // already-answered submission.
    for (const timer of pendingAutosaveTimers.values()) clearTimeout(timer);
    pendingAutosaveTimers.clear();

    document.querySelectorAll('.exam-answer-input').forEach(input => { input.disabled = true; });
    if (els.examSubmitBtn) {
        els.examSubmitBtn.disabled = true;
        // submitExam()'s try block puts the button into a transient
        // "Submitting…" spinner state and never restores it on success —
        // it relies on this function replacing the whole view instead. But
        // the button itself stays in the DOM (just disabled), so without
        // this its innerHTML is left showing the spinner/"Submitting…"
        // markup forever, even though the write succeeded and this
        // terminal message is now the actual source of truth. Restore it
        // to plain, final label text so a disabled button never lies
        // about still being in flight.
        els.examSubmitBtn.innerHTML = '<i class="fa-solid fa-circle-check"></i> Submitted';
    }

    const messages = {
        submitted: 'Your exam has been submitted.',
        auto_submitted_timeout: 'Time ran out — your exam was automatically submitted.',
        auto_submitted_disconnect_grace_expired: 'Your exam was automatically submitted after a prolonged disconnection.',
        graded: 'Your exam has been graded.',
    };
    if (els.examSubmitMsg) {
        els.examSubmitMsg.textContent = messages[status] || 'This exam is no longer in progress.';
        els.examSubmitMsg.classList.remove('hidden');
    }
    if (els.examTimerWrap) els.examTimerWrap.classList.add('hidden');
};

// ── 12. CLEANUP ───────────────────────────────────────────────────────────
// Best-effort only — onDisconnect() (registered in section 4) is what
// actually guarantees the presence node reflects reality even if this
// handler never runs at all (e.g. the process is killed rather than
// closed). This just marks pageUnloading so in-flight intervals/listeners
// stop trying to write during an unload that's already happening, and tears
// down the submission listener now that renderTerminalState() no longer
// does — the listener needs to survive submitted -> graded (a real, later
// transition it must still notice), so actual page teardown is the only
// correct place left to unsubscribe it.
window.addEventListener('pagehide', () => {
    pageUnloading = true;
    if (unsubSubmission) { unsubSubmission(); unsubSubmission = null; }
});

init();
