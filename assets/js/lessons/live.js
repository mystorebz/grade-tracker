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
import { v3ObjectToV2Block } from './canvas/model.js';
import { mountStage, renderSlide, NATIVE_TYPES } from './canvas/renderer.js';
import {
    loadLesson, startLiveSession, endLiveSession,
    updateLiveSessionPosition, subscribeToLiveSession, subscribeToLiveResponses,
    setLiveSpotlight, loadQuizKey, saveQuizKey, openLiveActivity, closeLiveActivity
} from '../../../assets/js/lessons.js';
import { createPost, liveSessionPostId, markLiveSessionPostEnded } from '../../../assets/js/posts.js';
import { WIDGET_TYPES, widgetState, updateWidgetLive, bindWidgetEvents, isSpotlighted } from './canvas/tools/interactive.js';
import { setupLiveFullscreen } from './live-fullscreen.js';
import { mountPresenceRoster } from './live-presence.js';
import { openActivityComposer, paintActivity, injectActivityCss, newLiveActivityId, openActivity, activityById, placeActivity, withActivity } from './live-activity.js';

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
// SLIDE DECK REDESIGN: navigation is by SLIDE, same unit the builder's own
// canvas and thumbnails use — a slide is no longer a single fixed-type
// "block" 1:1 (see lessons.js's newSlide('blank')/newBlock()); it can now
// hold several toolbar-inserted blocks presented together, exactly as the
// teacher laid them out. collaborative_board stays the one whole-slide type.
let currentSlideIndex = 0;
let canvasStage = null; // v3 renderer stage for the current slide (lesson.v3 lessons only)
let unsubSession = null;
let unsubResponses = null;
// Phase 4 step 4 widgets
let liveSessionData = null;           // last session snapshot (spotlight, endedAt)
let currentV3Slide = null;            // slide on the stage, incl. the live activity placed on it
let baseV3Slide = null;               // the same slide as saved in the lesson
let slideResponses = [];              // every response for the live blocks/widgets on this slide
const quizKeys = new Map();           // quiz objectId → correct option ids (staff-readable keys)
let unbindWidgets = null;
let presence = null;                  // live roster strip (RTDB, live-presence.js)
let responsesByStudentBlock = new Map(); // "{studentId}_{blockId}" -> response record, for the CURRENT slide's live block(s) only

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
            currentSlideIndex = Math.max(0, lesson.slides.findIndex(s => s.id === result.teacherPositionId));
        } else {
            currentSlideIndex = 0;
            await updateLiveSessionPosition(session.schoolId, postContext, urlLessonId, liveSessionId, lesson.slides[0]?.id || null);
            announceLiveSession(authorContext); // fire-and-forget: never blocks presenting
        }

        presence = mountPresenceRoster({
            host: document.getElementById('presenceStrip'),
            schoolId: session.schoolId, classId: urlClassId, sessionId: liveSessionId,
        });
        registerSessionListener();

        els.dashLoader.classList.add('hidden');
        els.dashBody.classList.remove('hidden');
        els.lessonTitleLabel.textContent = lesson.title || 'Untitled Lesson';
        els.subjectLabel.textContent = postContext.subjectName || '';

        renderCurrentSlide();
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
    els.prevBlockBtn.addEventListener('click', () => navigateTo(currentSlideIndex - 1));
    els.nextBlockBtn.addEventListener('click', () => navigateTo(currentSlideIndex + 1));
    els.endSessionBtn.addEventListener('click', onEndSession);

    // Full screen presenting: the slide + its controls fill the screen.
    setupLiveFullscreen({
        target: document.getElementById('presentColumn'),
        buttonHost: document.getElementById('presentFsHost'),
        stage: els.presentCanvas,
        tone: 'light',
        pad: true,
    });
    setupActivityControls();
    // Clicker / keyboard navigation (also in full screen)
    document.addEventListener('keydown', (e) => {
        if (e.defaultPrevented || e.ctrlKey || e.metaKey || e.altKey || !lesson) return;
        const t = e.target;
        if (t && (t.isContentEditable || /^(INPUT|TEXTAREA|SELECT)$/.test(t.tagName))) return;
        if (document.querySelector('.lact-modal-back')) return; // "Ask the class" dialog open
        if (['ArrowRight', 'PageDown'].includes(e.key)) { e.preventDefault(); navigateTo(currentSlideIndex + 1); }
        if (['ArrowLeft', 'PageUp'].includes(e.key)) { e.preventDefault(); navigateTo(currentSlideIndex - 1); }
    });
}

function showFatalError(message) {
    els.dashLoader.classList.add('hidden');
    els.endSessionBtn?.classList.add('hidden'); // no session to end
    els.dashFatalMsg.textContent = message;
    if (urlClassId && urlSubjectId && !els.dashFatalState.querySelector('[data-back]')) {
        const q = new URLSearchParams({ c: urlClassId, s: urlSubjectId, tab: 'lessons' });
        if (urlLessonId) q.set('lesson', urlLessonId);
        const a = document.createElement('a');
        a.dataset.back = '';
        a.href = `../subjects/subject.html?${q.toString()}`;
        a.className = 'inline-flex items-center gap-2 mt-4 px-4 py-2 rounded-xl bg-slate-900 text-white text-[12.5px] font-bold hover:bg-slate-800 transition';
        a.innerHTML = '<i class="fa-solid fa-arrow-left" style="font-size:12px;color:#fff;margin:0"></i> Back to the lesson';
        els.dashFatalState.appendChild(a);
    }
    els.dashFatalState.classList.remove('hidden');
}

// ── 5. SESSION DOC LISTENER (own writes reflected back, and so this page
//      notices if another teacher tab or the same teacher elsewhere ends
//      the session) ────────────────────────────────────────────────────
let endBtnHtml = '';
let ending = false;
function registerSessionListener() {
    if (!endBtnHtml) endBtnHtml = els.endSessionBtn.innerHTML;
    unsubSession = subscribeToLiveSession(session.schoolId, postContext, urlLessonId, liveSessionId, (data) => {
        const wasEnded = !!(liveSessionData && liveSessionData.endedAt);
        liveSessionData = data;
        syncTeacherActivity();
        if (!!data.endedAt !== wasEnded) paintV3Slide(); else refreshPresentWidgets();
        if (presence) presence.setVisible(!data.endedAt);
        if (data.endedAt) {
            els.endSessionBtn.disabled = true;
            els.endSessionBtn.textContent = 'Session Ended';
        } else if (els.endSessionBtn.disabled && !ending) {
            // The first snapshot can come from the offline cache (the previous,
            // ended session) before the server confirms the restart — undo it.
            els.endSessionBtn.disabled = false;
            els.endSessionBtn.innerHTML = endBtnHtml;
        }
    });
}

// ── 6. NAVIGATION ─────────────────────────────────────────────────────────
async function navigateTo(index) {
    if (!lesson) return;
    const total = lesson.slides.length;
    if (index < 0 || index >= total) return;

    currentSlideIndex = index;
    renderCurrentSlide();

    try {
        await updateLiveSessionPosition(session.schoolId, postContext, urlLessonId, liveSessionId, currentSlideData().id);
    } catch (e) {
        console.error('[Live Session] updateLiveSessionPosition:', e);
    }
}

function currentSlideData() {
    return lesson.slides[currentSlideIndex] || null;
}

// Which block(s) on the current slide are LIVE-INTERACTIVE (i.e. get a
// responses listener + grid) — Interactive Prompt blocks within a 'blank'
// slide (a slide may now hold more than one, unlike the old one-type-per-
// slide schema), or the whole slide itself for collaborative_board (still
// the one special, non-blocks whole-slide type). `label` is only set when
// there's more than one live block on the same slide, so the grid can tell
// them apart — the common single-block case stays unlabeled, matching the
// old UI exactly.
function liveBlocksForSlide(slide) {
    if (!slide) return [];
    if (slide.type === 'collaborative_board') return [{ id: slide.id, label: null }];
    const prompts = (slide.blocks || []).filter(b => b.type === 'interactive_prompt');
    const widgets = (slide.blocks || []).filter(b => WIDGET_TYPES.has(b.type));
    return [
        ...prompts.map((b, i) => ({ id: b.id, label: prompts.length > 1 ? `Prompt ${i + 1}` : null })),
        // widgets show their results on the stage itself; listed here so the
        // responses listener covers them (the side grid labels them by type)
        ...widgets.map(b => ({ id: b.id, label: { poll: 'Poll', quiz: 'Quiz', open_response: 'Response', board: 'Board' }[b.type] })),
    ];
}

// ── 7. RENDER ─────────────────────────────────────────────────────────────
function renderCurrentSlide() {
    const slide = currentSlideData();
    const total = lesson.slides.length;

    els.blockCounter.textContent = `Slide ${currentSlideIndex + 1} of ${total}`;
    els.prevBlockBtn.disabled = currentSlideIndex === 0;
    els.nextBlockBtn.disabled = currentSlideIndex === total - 1;

    if (!slide) { els.presentCanvas.innerHTML = ''; return; }

    // Schema v3 lessons render through the shared 1600×900 renderer (same
    // composition as the student viewer); v2 lessons keep the percent stage.
    const v3Slide = lesson.v3 && slide.type !== 'collaborative_board' ? lesson.v3.slidesById.get(slide.id) : null;
    if (canvasStage) { canvasStage.destroy(); canvasStage = null; }
    if (v3Slide && v3Slide.kind === 'canvas') {
        els.presentCanvas.innerHTML = '<div class="lb-v3-wrap" style="width:100%;"></div>';
        canvasStage = mountStage(els.presentCanvas.firstElementChild, { stage: lesson.v3.stage, theme: lesson.v3.theme });
        baseV3Slide = v3Slide;
        currentV3Slide = withActivity(v3Slide, shownActivity());
        loadQuizKeysFor(v3Slide);
        paintV3Slide();
    } else {
        baseV3Slide = null;
        currentV3Slide = null;
        els.presentCanvas.innerHTML = renderSlideHtml(slide);
    }

    // Any PREVIOUS slide's listener is torn down here before a new one (or
    // none) is registered, so this page never runs more than one responses
    // listener at a time regardless of how fast the teacher clicks through.
    if (unsubResponses) { unsubResponses(); unsubResponses = null; }
    responsesByStudentBlock.clear();
    slideResponses = [];

    const liveBlocks = liveBlocksForSlide(slide);
    if (liveBlocks.length) {
        els.responsesPanel.classList.remove('hidden');
        registerResponsesListener(liveBlocks);
    } else {
        els.responsesPanel.classList.add('hidden');
    }
    paintTeacherActivity(); // on this slide → on the stage; otherwise the card below it
}

// SLIDE DECK REDESIGN: a 'blank' slide's presentation is now its blocks
// stacked together (matching the builder's own canvas) rather than one
// fixed-type slide. collaborative_board is unchanged — still a special,
// non-blocks whole-slide type.
function renderSlideHtml(slide) {
    if (slide.type === 'collaborative_board') {
        return `
        <div class="lb-block-card">
            <span class="lb-live-badge lb-live-badge-board"><i class="fa-solid fa-people-group"></i> Collaborative Board</span>
            ${slide.heading ? `<h2 class="text-lg md:text-xl font-black text-slate-800 mt-3 mb-3">${escHtml(slide.heading)}</h2>` : ''}
            ${slide.instructions ? `<p class="text-[13.5px] text-slate-600 leading-relaxed whitespace-pre-wrap">${escHtml(slide.instructions)}</p>` : ''}
        </div>`;
    }

    const blocks = slide.blocks || [];
    if (!blocks.length) {
        return `<div class="lb-block-card"><p class="text-slate-400 font-semibold">This slide has no content yet.</p></div>`;
    }
    // FREE-FORM CANVAS: each block is positioned absolutely inside the 16:9
    // stage using its saved x/y/w/h (percentages of the stage box), exactly
    // matching how the builder's own canvas lays them out — read-only here,
    // just the position/size, no drag or resize handles.
    return `<div class="lb-block-card lb-live-stage">${blocks.map(b => `<div class="lb-live-block" style="${liveBlockPositionStyle(b)}">${renderLiveBlockHtml(b)}</div>`).join('')}</div>`;
}

// Mirrors builder.js's blockPositionStyle(); ensureBlockLayout() (run by
// normalizeLessonSlides()/loadLesson()) guarantees every block has numeric
// x/y/w/h by the time it reaches this page, but the numeric guard keeps this
// resilient even against unmigrated data.
function liveBlockPositionStyle(block) {
    if (typeof block.x !== 'number' || typeof block.y !== 'number' || typeof block.w !== 'number' || typeof block.h !== 'number') {
        return 'position:static;';
    }
    return `left:${block.x}%; top:${block.y}%; width:${block.w}%; height:${block.h}%;`;
}

function renderLiveBlockHtml(block) {
    switch (block.type) {
        case 'image':
            return block.imageUrl
                ? `<div class="h-full flex flex-col">
                     <img src="${escHtml(block.imageUrl)}" alt="${escHtml(block.imageAlt)}" class="w-full flex-1 min-h-0 object-contain rounded-xl bg-slate-50 border border-slate-200">
                     ${block.caption ? `<p class="text-[12px] text-slate-400 font-semibold mt-2 text-center flex-shrink-0">${escHtml(block.caption)}</p>` : ''}
                   </div>`
                : `<div class="lb-media-placeholder h-full">No image on this slide.</div>`;
        case 'video':
            return block.embedUrl
                ? `<div class="h-full flex flex-col">
                     <div class="lb-media-frame flex-1 min-h-0" style="aspect-ratio:auto;"><iframe src="${escHtml(block.embedUrl)}" allowfullscreen loading="lazy"></iframe></div>
                     ${block.caption ? `<p class="text-[12px] text-slate-400 font-semibold mt-2 text-center flex-shrink-0">${escHtml(block.caption)}</p>` : ''}
                   </div>`
                : `<div class="lb-media-placeholder h-full">No video on this slide.</div>`;
        case 'assignment':
            return `<div>${block.prompt ? `<p class="text-[13.5px] text-slate-600 leading-relaxed whitespace-pre-wrap">${escHtml(block.prompt)}</p>` : '<p class="text-slate-400 font-semibold">Embedded assignment.</p>'}</div>`;
        case 'interactive_prompt':
            return `
            <div>
                <span class="lb-live-badge"><i class="fa-solid fa-bolt"></i> Interactive Prompt</span>
                <p class="text-[14px] text-slate-700 font-semibold leading-relaxed mt-2">${escHtml(block.promptText) || 'No prompt text set.'}</p>
                ${block.promptKind === 'multiple_choice' && (block.choices || []).length
                    ? `<ul class="mt-3 space-y-1.5">${block.choices.map(c => `<li class="text-[13px] text-slate-600 font-semibold bg-slate-50 border border-slate-200 rounded-lg px-3 py-2">${escHtml(c)}</li>`).join('')}</ul>`
                    : ''}
            </div>`;
        case 'text':
        default:
            return `<div class="lb-richtext">${block.html || ''}</div>`; // empty boxes stay invisible to the class
    }
}

// ── 8. LIVE RESPONSES GRID (interactive_prompt block(s) / collaborative_board) ──
function registerResponsesListener(liveBlocks) {
    const idSet = new Set(liveBlocks.map(b => b.id));
    // callerRole: 'teacher' — an unfiltered query (every response in the
    // session, every blockType included) is correct and necessary here: the
    // teacher needs interactive_prompt answers too, which the student-side
    // query deliberately excludes (see subscribeToLiveResponses()'s own
    // comment in lessons.js). firestore.rules' teacher/admin branch is
    // role-based, not data-dependent, so an unfiltered query is provable and
    // stays allowed regardless of blockType.
    unsubResponses = subscribeToLiveResponses(session.schoolId, postContext, urlLessonId, liveSessionId, (responses) => {
        // The subscription is on the WHOLE session's responses (every block
        // touched so far), not just this slide's — filtered client-side to
        // whichever block id(s) are actually live on the current slide, same
        // "list once, filter in memory" approach teacher/exams/live.js takes
        // with its own two merged streams. Re-registered per slide (see
        // renderCurrentSlide()) so this filter is cheap and the listener
        // itself never has to survive across a navigation.
        const forThisSlide = responses.filter(r => idSet.has(r.blockId));
        responsesByStudentBlock = new Map(forThisSlide.map(r => [r.id, r]));
        slideResponses = forThisSlide;
        refreshPresentWidgets();
        renderResponsesGrid(forThisSlide, liveBlocks);
    }, 'teacher');
}

function renderResponsesGrid(responses, liveBlocks) {
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
    const labelFor = (blockId) => liveBlocks.find(b => b.id === blockId)?.label;
    els.responsesGrid.innerHTML = sorted.map(r => `
        <div class="response-card">
            ${labelFor(r.blockId) ? `<p class="text-[9.5px] font-black text-indigo-400 uppercase tracking-widest mb-1">${escHtml(labelFor(r.blockId))}</p>` : ''}
            <p class="response-card-student">${escHtml(r.studentName || r.studentId)}</p>
            <p class="response-card-text">${escHtml(r.answerText) || (r.choiceIds ? `<span class="text-slate-500">${r.blockType === 'quiz' ? (r.correct ? '✓ correct' : '✗ incorrect') : `${r.choiceIds.length} choice${r.choiceIds.length === 1 ? '' : 's'}`}</span>` : '<span class="text-slate-300">(no answer text)</span>')}</p>
        </div>`).join('');
}

// ── 8b. CANVAS WIDGETS (teacher side: live results on the stage) ─────────
function presentCtx(obj) {
    return {
        state: widgetState({ sessionId: liveSessionId, sessionData: liveSessionData }),
        responses: obj.id === viewActivityId ? activityResponses : slideResponses,
        spotlight: liveSessionData && liveSessionData.spotlight ? liveSessionData.spotlight : null,
        correctIds: quizKeys.get(obj.id) || [],
    };
}

function paintV3Slide() {
    if (!canvasStage || !currentV3Slide) return;
    renderSlide(canvasStage, currentV3Slide, {
        mode: 'present',
        renderContent: (obj) => (NATIVE_TYPES.has(obj.type) ? undefined : renderLiveBlockHtml(v3ObjectToV2Block(obj))),
        widgetContext: presentCtx,
    });
    refreshPresentWidgets();
    if (!unbindWidgets) {
        unbindWidgets = bindWidgetEvents(els.presentCanvas, {
            getObject: (id) => (currentV3Slide?.objects || []).find(o => o.id === id) || null,
            onSubmit: async () => {},
            onSpotlight: toggleSpotlight,
        });
    }
}

function refreshPresentWidgets() {
    if (!canvasStage || !currentV3Slide) return;
    (currentV3Slide.objects || []).forEach(obj => {
        if (!WIDGET_TYPES.has(obj.type)) return;
        const node = canvasStage.nodes.get(obj.id);
        if (node) updateWidgetLive(node.el, obj, 'present', presentCtx(obj));
    });
}

function loadQuizKeysFor(v3Slide) {
    (v3Slide.objects || []).filter(o => o.type === 'quiz' && !quizKeys.has(o.id)).forEach(o => {
        quizKeys.set(o.id, []);
        loadQuizKey(urlLessonId, o.id).then(ids => { quizKeys.set(o.id, ids); refreshPresentWidgets(); });
    });
}

async function toggleSpotlight(obj, responseId) {
    const current = liveSessionData && liveSessionData.spotlight;
    const r = slideResponses.find(x => x.id === responseId) || activityResponses.find(x => x.id === responseId);
    try {
        // matched by widget + text (the spotlight carries no student id)
        if (r && isSpotlighted(current, obj, r.answerText)) await setLiveSpotlight(session.schoolId, postContext, urlLessonId, liveSessionId, null);
        else if (r) await setLiveSpotlight(session.schoolId, postContext, urlLessonId, liveSessionId, { objectId: obj.id, text: r.answerText });
    } catch (e) {
        console.error('[Live Session] spotlight:', e);
        alert('Could not update the spotlight. Please try again.');
    }
}

// ── 8c. LIVE ACTIVITIES (questions asked during the session) ──────────────
// "Ask the class" → poll / quiz / open response / sticky notes, sent to
// students at once (live-activity.js). The card under the slide shows the
// answers as they arrive; it stays after Close so the results can be
// discussed, until Dismiss.
let askBtn = null;
let activityPanel = null;
let activityBody = null;
let viewActivityId = null;          // activity shown in the panel (open or just closed)
let activityResponses = [];
let unsubActivityResponses = null;
let activityBusy = false;

function setupActivityControls() {
    injectActivityCss();
    askBtn = document.createElement('button');
    askBtn.type = 'button';
    askBtn.className = 'lfs-btn lfs-light';
    askBtn.innerHTML = '<i class="fa-solid fa-circle-question"></i><span>Ask the class</span>';
    askBtn.title = 'Ask a poll, quiz question, open response or sticky-note board right now';
    askBtn.addEventListener('click', onAskClass);
    document.getElementById('presentFsHost')?.prepend(askBtn);

    activityPanel = document.createElement('section');
    activityPanel.className = 'lact-card lact-teacher hidden';
    activityPanel.setAttribute('aria-label', 'Live question');
    activityPanel.innerHTML = '<div class="lact-card-bar" data-bar></div><div class="lact-card-body" data-body></div>';
    els.presentCanvas.insertAdjacentElement('afterend', activityPanel);
    activityBody = activityPanel.querySelector('[data-body]');
    bindWidgetEvents(activityBody, {
        getObject: (id) => (liveSessionData ? activityById(liveSessionData, id) : null),
        onSubmit: async () => {},
        onSpotlight: toggleSpotlight,
    });
    activityPanel.querySelector('[data-bar]').addEventListener('click', async (e) => {
        const b = e.target.closest('button');
        if (!b || activityBusy) return;
        if (b.dataset.act === 'close') {
            activityBusy = true;
            try { await closeLiveActivity(session.schoolId, postContext, urlLessonId, liveSessionId); }
            catch (err) { console.error('[Live Session] close activity:', err); alert('Could not close the question. Please try again.'); }
            finally { activityBusy = false; }
        } else if (b.dataset.act === 'dismiss') {
            showActivity(null);
        }
    });
}

function onAskClass() {
    if (!liveSessionId || !liveSessionData || liveSessionData.endedAt) return;
    openActivityComposer({
        onLaunch: async ({ type, props, correctIds }) => {
            if (!liveSessionData || liveSessionData.endedAt) throw new Error('This live session has ended.');
            const id = newLiveActivityId();
            if (type === 'quiz') {
                await saveQuizKey(session.schoolId, urlLessonId, id, correctIds);
                quizKeys.set(id, correctIds);
            }
            // goes ON the slide being shown, in its emptiest spot
            const rec = { id, type, props };
            if (baseV3Slide) Object.assign(rec, { slideId: baseV3Slide.id }, placeActivity(type, props, baseV3Slide.objects));
            await openLiveActivity(session.schoolId, postContext, urlLessonId, liveSessionId, rec);
            showActivity(id);
        },
    });
}

// Called on every session snapshot.
function syncTeacherActivity() {
    const ended = !!(liveSessionData && liveSessionData.endedAt);
    if (askBtn) askBtn.disabled = ended || !liveSessionId;
    const open = openActivity(liveSessionData);
    if (open && open.id !== viewActivityId) showActivity(open.id);
    else paintTeacherActivity();
}

function showActivity(id) {
    if (id === viewActivityId) { paintTeacherActivity(); return; }
    viewActivityId = id;
    activityResponses = [];
    if (unsubActivityResponses) { unsubActivityResponses(); unsubActivityResponses = null; }
    if (activityBody) { activityBody.innerHTML = ''; activityBody.__lactKey = null; }
    if (id) {
        const act = activityById(liveSessionData, id);
        if (act && act.type === 'quiz' && !quizKeys.has(id)) {
            quizKeys.set(id, []);
            loadQuizKey(urlLessonId, id).then(ids => { quizKeys.set(id, ids); paintTeacherActivity(); });
        }
        unsubActivityResponses = subscribeToLiveResponses(session.schoolId, postContext, urlLessonId, liveSessionId, (responses) => {
            activityResponses = responses.filter(r => r.blockId === id);
            paintTeacherActivity();
            refreshPresentWidgets();
        }, 'teacher');
    }
    paintTeacherActivity();
}

function shownActivity() {
    return viewActivityId && liveSessionData ? activityById(liveSessionData, viewActivityId) : null;
}

function paintTeacherActivity() {
    if (!activityPanel) return;
    const act = shownActivity();
    // the stage shows the activity when it belongs to this slide
    if (baseV3Slide && canvasStage) {
        const next = withActivity(baseV3Slide, act);
        const ids = (o) => (o?.objects || []).map(x => x.id).join('|');
        const changed = ids(next) !== ids(currentV3Slide);
        currentV3Slide = next;
        if (changed) paintV3Slide();
    }
    const onStage = !!(act && baseV3Slide && act.slideId === baseV3Slide.id && typeof act.x === 'number');
    activityPanel.classList.toggle('lact-bar-only', onStage);
    if (!act) { activityPanel.classList.add('hidden'); return; }
    activityPanel.classList.remove('hidden');
    const isOpen = liveSessionData.activityId === act.id && !liveSessionData.endedAt;
    const n = activityResponses.length;
    const label = { poll: 'Poll', quiz: 'Quiz question', open_response: 'Open response', board: 'Sticky notes' }[act.type] || 'Question';
    const barHtml = `${isOpen ? '<span class="lact-live-dot" aria-hidden="true"></span>' : '<i class="fa-solid fa-lock" aria-hidden="true"></i>'}
        <span class="lact-grow">${isOpen ? 'Live' : 'Closed'} · ${escHtml(label)} · <span aria-live="polite">${n} ${act.type === 'board' ? 'note' : 'response'}${n === 1 ? '' : 's'}</span></span>
        ${isOpen ? '<button type="button" class="lact-danger" data-act="close"><i class="fa-solid fa-stop"></i> Close question</button>' : '<button type="button" data-act="dismiss">Dismiss</button>'}`;
    const bar = activityPanel.querySelector('[data-bar]');
    if (bar.__html !== barHtml) { bar.innerHTML = barHtml; bar.__html = barHtml; }
    if (onStage) return; // results are on the slide; the bar keeps Close / Dismiss
    paintActivity(activityBody, act, 'present', {
        state: 'live',
        responses: activityResponses,
        spotlight: liveSessionData.spotlight || null,
        correctIds: quizKeys.get(act.id) || [],
    });
}

// ── 8b. CLASS STREAM ACTION BULLETIN ────────────────────────────────────
// A new (not resumed) live session posts a "Live now" card to this
// subject's Class Stream; students' live stream listeners show it at once
// with a Join button. Ending the session flips it to "ended".
async function announceLiveSession(authorContext) {
    try {
        await createPost(session.schoolId, postContext, authorContext, {
            type: 'live_session',
            title: `Live now: ${lesson.title || 'Untitled Lesson'}`,
            body: 'Your teacher is presenting this lesson live. Join to follow along.',
            linkedLessonId: urlLessonId,
            liveSessionId,
        }, { id: liveSessionPostId(urlLessonId, liveSessionId) });
    } catch (e) {
        console.error('[Live Session] announceLiveSession:', e);
    }
}

// ── 9. END SESSION ────────────────────────────────────────────────────────
async function onEndSession() {
    if (!liveSessionId) return;
    if (!confirm('End this live session? Students will stop auto-following your position.')) return;

    ending = true;
    els.endSessionBtn.disabled = true;
    els.endSessionBtn.textContent = 'Ending…';
    try {
        await endLiveSession(session.schoolId, postContext, urlLessonId, liveSessionId, { revealedAnswers: await collectRevealedAnswers() });
        markLiveSessionPostEnded(session.schoolId, postContext, urlLessonId, liveSessionId);
        els.endSessionBtn.textContent = 'Session Ended';
    } catch (e) {
        console.error('[Live Session] endLiveSession:', e);
        ending = false;
        els.endSessionBtn.disabled = false;
        els.endSessionBtn.innerHTML = endBtnHtml || 'End Session';
        alert('Could not end the session. Please try again.');
    }
}

// Correct answers students may see once the session is over: every quiz in
// the lesson plus every quiz asked live. { objectId: [optionId] }
async function collectRevealedAnswers() {
    const ids = new Set();
    if (lesson && lesson.v3) {
        const walk = (objs) => (objs || []).forEach((o) => {
            if (!o) return;
            if (o.type === 'quiz') ids.add(o.id);
            if (o.props && Array.isArray(o.props.children) && typeof o.props.children[0] === 'object') walk(o.props.children);
        });
        lesson.v3.slidesById.forEach((sl) => walk(sl.objects));
    }
    if (lesson && lesson.format === 'document') {
        const html = (lesson.slides[0] && lesson.slides[0].contentHtml) || '';
        for (const m of html.matchAll(/data-widget-id="([^"]+)" data-widget-type="quiz"/g)) ids.add(m[1]);
    }
    ((liveSessionData && liveSessionData.activities) || []).forEach((a) => { if (a && a.type === 'quiz') ids.add(a.id); });
    const out = {};
    await Promise.all([...ids].map(async (id) => {
        try {
            const key = quizKeys.has(id) && quizKeys.get(id).length ? quizKeys.get(id) : await loadQuizKey(urlLessonId, id);
            if (Array.isArray(key) && key.length) out[id] = key.slice(0, 20).map(String);
        } catch (e) { /* no key → nothing to reveal */ }
    }));
    return out;
}

// ── 10. CLEANUP (memory leak guardrail) ──────────────────────────────────
// Every onSnapshot this page opens (registerSessionListener,
// registerResponsesListener) has a matching unsubscribe here. The responses
// listener is ALSO individually torn down and re-registered on every
// navigation (see renderCurrentSlide()) — this pagehide handler is the
// final safety net for whichever listener is still live when the tab
// actually closes, not the only place either one is ever unsubscribed.
window.addEventListener('pagehide', () => {
    if (presence) { presence.stop(); presence = null; }
    if (unsubActivityResponses) { unsubActivityResponses(); unsubActivityResponses = null; }
    if (unsubSession) { unsubSession(); unsubSession = null; }
    if (unsubResponses) { unsubResponses(); unsubResponses = null; }
});

init();
