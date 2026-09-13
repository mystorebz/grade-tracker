// ── PHASE 3: LIVE SESSION ENGINE — TEACHER LIVE DASHBOARD ─────────────────
// Presents an already-published lesson block-by-block (Slides format: one
// slide at a time; Document format: one top-level block at a time — a
// richtext body counts as a single block here, same granularity the builder
// itself uses for slides[]) and keeps a live_sessions document's
// teacherPositionId in sync with wherever the teacher currently is, so every
// connected student's viewer.js can auto-follow (see that file's
// subscribeToLiveSession handling).
//
// When the current block is interactive_prompt or collaborative_board, this
// page also opens a live onSnapshot on that session's `responses`
// subcollection and renders every student's answer as it arrives — this is
// the one piece of real UI beyond simple navigation; every other block type
// just displays read-only, exactly like the student viewer's own render,
// since the teacher's copy is presentation, not editing.
//
// Cleanup contract mirrors teacher/exams/live.js exactly: every onSnapshot
// this page opens has a matching unsubscribe, called on 'pagehide' AND
// whenever the teacher navigates away from an interactive block (the
// responses listener is re-registered per-block, not left running for a
// block the teacher isn't even looking at anymore).
import { db } from '../../../assets/js/firebase-init.js';
import { requireAuth, awaitAuthReady } from '../../../assets/js/auth.js';
import { injectTeacherLayout } from '../../../assets/js/layout-teachers.js';
import { doc, getDoc } from "https://www.gstatic.com/firebasejs/10.7.1/firebase-firestore.js";
import {
    loadLesson, startLiveSession, endLiveSession,
    updateLiveSessionPosition, subscribeToLiveSession, subscribeToLiveResponses
} from '../../../assets/js/lessons.js';

// ── 1. AUTH & LAYOUT ──────────────────────────────────────────────────────
const session = requireAuth('teacher', '../login.html');
if (session) {
    injectTeacherLayout('lessons', 'Live Session', 'Present this lesson and watch student responses in real time', false);
}

// ── 2. URL PARAMS ─────────────────────────────────────────────────────────
const params = new URLSearchParams(window.location.search);
const urlLessonId = params.get('lessonId');
const urlClassId = params.get('classId');
const urlSubjectId = params.get('subjectId');
const urlSubjectName = params.get('subjectName') || '';

const postContext = { classId: urlClassId, subjectId: urlSubjectId, subjectName: urlSubjectName };

// ── 3. STATE ──────────────────────────────────────────────────────────────
let lesson = null;
let liveSessionId = null;
let currentBlockIndex = 0;
let unsubSession = null;
let unsubResponses = null;
let responsesByStudentBlock = new Map(); // "{studentId}_{blockId}" -> response record, for the CURRENT block only

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
async function init() {
    if (!session) return;
    if (!(await awaitAuthReady('teacher', '../login.html'))) return;

    cacheEls();
    wireEvents();

    if (!urlLessonId || !urlClassId || !urlSubjectId) {
        showFatalError('This live session link is missing information. Please start it again from the Lesson Builder.');
        return;
    }

    try {
        lesson = await loadLesson(session.schoolId, postContext, urlLessonId);
        if (!lesson) {
            showFatalError("This lesson doesn't exist, or it's no longer available.");
            return;
        }
        if (lesson.status !== 'published') {
            showFatalError('This lesson must be published before you can present it live.');
            return;
        }

        // startLiveSession() itself decides resume-vs-create atomically
        // (a Firestore transaction on this lesson's one fixed session doc
        // id — see its own comment in lessons.js) — this page must NOT
        // duplicate that decision with its own separate getActiveLiveSession
        // check first: two teacher tabs each doing "check, then branch on
        // what I saw" non-atomically could both conclude no session exists
        // and both proceed to reset teacherPositionId back to block 0,
        // even though the transaction itself would correctly have let only
        // one of them actually create the document. Always calling
        // startLiveSession() and branching on ITS OWN resumed flag is what
        // keeps the whole decision inside that one atomic transaction.
        const authorContext = { authorId: session.teacherId, authorName: session.teacherData.name };
        const result = await startLiveSession(session.schoolId, postContext, urlLessonId, authorContext);
        liveSessionId = result.id;

        if (result.resumed) {
            currentBlockIndex = Math.max(0, lesson.slides.findIndex(b => b.id === result.teacherPositionId));
        } else {
            currentBlockIndex = 0;
            await updateLiveSessionPosition(session.schoolId, postContext, urlLessonId, liveSessionId, lesson.slides[0]?.id || null);
        }

        registerSessionListener();

        els.dashLoader.classList.add('hidden');
        els.dashBody.classList.remove('hidden');
        els.lessonTitleLabel.textContent = lesson.title || 'Untitled Lesson';
        els.subjectLabel.textContent = postContext.subjectName || '';

        renderCurrentBlock();
    } catch (e) {
        console.error('[Live Session] init:', e);
        showFatalError('Something went wrong starting this live session. Please try again.');
    }
}

function cacheEls() {
    [
        'dashLoader', 'dashFatalState', 'dashFatalMsg', 'dashBody',
        'lessonTitleLabel', 'subjectLabel', 'blockCounter',
        'prevBlockBtn', 'nextBlockBtn', 'endSessionBtn',
        'presentCanvas', 'responsesPanel', 'responsesGrid', 'responsesEmpty', 'responsesCount'
    ].forEach(id => { els[id] = document.getElementById(id); });
}

function wireEvents() {
    els.prevBlockBtn.addEventListener('click', () => navigateTo(currentBlockIndex - 1));
    els.nextBlockBtn.addEventListener('click', () => navigateTo(currentBlockIndex + 1));
    els.endSessionBtn.addEventListener('click', onEndSession);
}

function showFatalError(message) {
    els.dashLoader.classList.add('hidden');
    els.dashFatalMsg.textContent = message;
    els.dashFatalState.classList.remove('hidden');
}

// ── 5. SESSION DOC LISTENER (own writes reflected back, and so this page
//      notices if another teacher tab or the same teacher elsewhere ends
//      the session) ────────────────────────────────────────────────────
function registerSessionListener() {
    unsubSession = subscribeToLiveSession(session.schoolId, postContext, urlLessonId, liveSessionId, (data) => {
        if (data.endedAt) {
            els.endSessionBtn.disabled = true;
            els.endSessionBtn.textContent = 'Session Ended';
        }
    });
}

// ── 6. NAVIGATION ─────────────────────────────────────────────────────────
async function navigateTo(index) {
    if (!lesson) return;
    const total = lesson.slides.length;
    if (index < 0 || index >= total) return;

    currentBlockIndex = index;
    renderCurrentBlock();

    try {
        await updateLiveSessionPosition(session.schoolId, postContext, urlLessonId, liveSessionId, currentBlock().id);
    } catch (e) {
        console.error('[Live Session] updateLiveSessionPosition:', e);
    }
}

function currentBlock() {
    return lesson.slides[currentBlockIndex] || null;
}

// ── 7. RENDER ─────────────────────────────────────────────────────────────
function renderCurrentBlock() {
    const block = currentBlock();
    const total = lesson.slides.length;

    els.blockCounter.textContent = `Block ${currentBlockIndex + 1} of ${total}`;
    els.prevBlockBtn.disabled = currentBlockIndex === 0;
    els.nextBlockBtn.disabled = currentBlockIndex === total - 1;

    if (!block) { els.presentCanvas.innerHTML = ''; return; }

    els.presentCanvas.innerHTML = renderBlockHtml(block);

    // The live grid view only ever applies to the two interactive block
    // types — every other block type gets no responses listener at all
    // (there is nothing for a student to submit against it), and any
    // PREVIOUS block's listener is torn down here before a new one (or
    // none) is registered, so this page never runs more than one responses
    // listener at a time regardless of how fast the teacher clicks through.
    if (unsubResponses) { unsubResponses(); unsubResponses = null; }
    responsesByStudentBlock.clear();

    if (block.type === 'interactive_prompt' || block.type === 'collaborative_board') {
        els.responsesPanel.classList.remove('hidden');
        registerResponsesListener(block.id);
    } else {
        els.responsesPanel.classList.add('hidden');
    }
}

function renderBlockHtml(block) {
    switch (block.type) {
        case 'title':
            return `
            <div class="lb-block-card items-center text-center">
                <p class="text-[11px] font-black text-teal-500 uppercase tracking-widest mb-3">${escHtml(block.subheading || '')}</p>
                <h2 class="text-2xl md:text-3xl font-black text-slate-800 leading-tight mb-4">${escHtml(block.heading) || 'Untitled Slide'}</h2>
                ${block.objective ? `<p class="text-[14px] text-slate-500 font-semibold max-w-md mx-auto leading-relaxed">${escHtml(block.objective)}</p>` : ''}
            </div>`;
        case 'media':
            return `
            <div class="lb-block-card">
                ${block.heading ? `<h2 class="text-lg md:text-xl font-black text-slate-800 mb-4">${escHtml(block.heading)}</h2>` : ''}
                ${block.mediaKind === 'image'
                    ? (block.imageUrl ? `<img src="${escHtml(block.imageUrl)}" alt="${escHtml(block.imageAlt)}" class="w-full max-h-[420px] object-contain rounded-xl bg-slate-50 border border-slate-200">` : `<div class="lb-media-placeholder">No image on this slide.</div>`)
                    : (block.embedUrl ? `<div class="lb-media-frame"><iframe src="${escHtml(block.embedUrl)}" allowfullscreen loading="lazy"></iframe></div>` : `<div class="lb-media-placeholder">No video on this slide.</div>`)}
                ${block.caption ? `<p class="text-[12px] text-slate-400 font-semibold mt-3 text-center">${escHtml(block.caption)}</p>` : ''}
            </div>`;
        case 'assignment':
            return `
            <div class="lb-block-card">
                ${block.heading ? `<h2 class="text-lg md:text-xl font-black text-slate-800 mb-3">${escHtml(block.heading)}</h2>` : ''}
                ${block.prompt ? `<p class="text-[13.5px] text-slate-600 leading-relaxed whitespace-pre-wrap">${escHtml(block.prompt)}</p>` : ''}
            </div>`;
        case 'richtext':
            return `<div class="lb-block-card lb-richtext">${block.contentHtml || '<p class="text-slate-400 font-semibold">This document has no content yet.</p>'}</div>`;
        case 'interactive_prompt':
            return `
            <div class="lb-block-card">
                <span class="lb-live-badge"><i class="fa-solid fa-bolt"></i> Interactive Prompt</span>
                ${block.heading ? `<h2 class="text-lg md:text-xl font-black text-slate-800 mt-3 mb-3">${escHtml(block.heading)}</h2>` : ''}
                <p class="text-[14px] text-slate-700 font-semibold leading-relaxed">${escHtml(block.promptText) || 'No prompt text set.'}</p>
                ${block.promptKind === 'multiple_choice' && (block.choices || []).length
                    ? `<ul class="mt-3 space-y-1.5">${block.choices.map(c => `<li class="text-[13px] text-slate-600 font-semibold bg-slate-50 border border-slate-200 rounded-lg px-3 py-2">${escHtml(c)}</li>`).join('')}</ul>`
                    : ''}
            </div>`;
        case 'collaborative_board':
            return `
            <div class="lb-block-card">
                <span class="lb-live-badge lb-live-badge-board"><i class="fa-solid fa-people-group"></i> Collaborative Board</span>
                ${block.heading ? `<h2 class="text-lg md:text-xl font-black text-slate-800 mt-3 mb-3">${escHtml(block.heading)}</h2>` : ''}
                ${block.instructions ? `<p class="text-[13.5px] text-slate-600 leading-relaxed whitespace-pre-wrap">${escHtml(block.instructions)}</p>` : ''}
            </div>`;
        case 'content':
        default:
            return `
            <div class="lb-block-card">
                ${block.heading ? `<h2 class="text-xl md:text-2xl font-black text-slate-800 mb-4">${escHtml(block.heading)}</h2>` : ''}
                <p class="text-[14.5px] text-slate-600 leading-relaxed whitespace-pre-wrap">${escHtml(block.body || '')}</p>
            </div>`;
    }
}

// ── 8. LIVE RESPONSES GRID (interactive_prompt / collaborative_board) ───
function registerResponsesListener(blockId) {
    // callerRole: 'teacher' — an unfiltered query (every response in the
    // session, every blockType included) is correct and necessary here: the
    // teacher needs interactive_prompt answers too, which the student-side
    // query deliberately excludes (see subscribeToLiveResponses()'s own
    // comment in lessons.js). firestore.rules' teacher/admin branch is
    // role-based, not data-dependent, so an unfiltered query is provable and
    // stays allowed regardless of blockType.
    unsubResponses = subscribeToLiveResponses(session.schoolId, postContext, urlLessonId, liveSessionId, (responses) => {
        // The subscription is on the WHOLE session's responses (every block
        // touched so far), not just this one — filtered client-side to the
        // block currently on screen, same "list once, filter in memory"
        // approach teacher/exams/live.js takes with its own two merged
        // streams. Re-registered per block (see renderCurrentBlock()) so
        // this filter is cheap and the listener itself never has to survive
        // across a navigation.
        const forThisBlock = responses.filter(r => r.blockId === blockId);
        responsesByStudentBlock = new Map(forThisBlock.map(r => [r.id, r]));
        renderResponsesGrid(forThisBlock);
    }, 'teacher');
}

function renderResponsesGrid(responses) {
    els.responsesCount.textContent = `${responses.length} response${responses.length === 1 ? '' : 's'}`;

    if (!responses.length) {
        els.responsesGrid.innerHTML = '';
        els.responsesEmpty.classList.remove('hidden');
        return;
    }
    els.responsesEmpty.classList.add('hidden');

    // Newest first — a teacher watching the wall fill in wants the latest
    // submissions visible without scrolling, same ordering principle
    // loadLessonsForSubject() uses for its own list.
    const sorted = [...responses].sort((a, b) => new Date(b.submittedAt || 0) - new Date(a.submittedAt || 0));
    els.responsesGrid.innerHTML = sorted.map(r => `
        <div class="response-card">
            <p class="response-card-student">${escHtml(r.studentName || r.studentId)}</p>
            <p class="response-card-text">${escHtml(r.answerText) || '<span class="text-slate-300">(no answer text)</span>'}</p>
        </div>`).join('');
}

// ── 9. END SESSION ────────────────────────────────────────────────────────
async function onEndSession() {
    if (!liveSessionId) return;
    if (!confirm('End this live session? Students will stop auto-following your position.')) return;

    els.endSessionBtn.disabled = true;
    els.endSessionBtn.textContent = 'Ending…';
    try {
        await endLiveSession(session.schoolId, postContext, urlLessonId, liveSessionId);
        els.endSessionBtn.textContent = 'Session Ended';
    } catch (e) {
        console.error('[Live Session] endLiveSession:', e);
        els.endSessionBtn.disabled = false;
        els.endSessionBtn.textContent = 'End Session';
        alert('Could not end the session. Please try again.');
    }
}

// ── 10. CLEANUP (memory leak guardrail) ──────────────────────────────────
// Every onSnapshot this page opens (registerSessionListener,
// registerResponsesListener) has a matching unsubscribe here. The responses
// listener is ALSO individually torn down and re-registered on every
// navigation (see renderCurrentBlock()) — this pagehide handler is the
// final safety net for whichever listener is still live when the tab
// actually closes, not the only place either one is ever unsubscribed.
window.addEventListener('pagehide', () => {
    if (unsubSession) { unsubSession(); unsubSession = null; }
    if (unsubResponses) { unsubResponses(); unsubResponses = null; }
});

init();
