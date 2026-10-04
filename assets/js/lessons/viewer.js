// ── INTERACTIVE STUDENT LESSON VIEWER ─────────────────────────────────────
// Reads one lesson (Slides or Document format) and renders it read-only,
// with embedded assignments completable in place. Mirrors the Teacher
// Builder's rendering logic for each slide type / renders Documents with the
// editor's own Tiptap schema (document.js createDocumentViewer), but every
// control here is view-only — nothing in this file ever
// writes to a lesson document, and it never touches the lessons/{id}/private
// subcollection (pacingNotes/standards are teacher-only; firestore.rules
// denies students that path outright regardless of publish status — see
// firestore.rules' own comment on the lessons match block. This file simply
// never gives students a reason to try: it only ever reads the main lesson
// doc, gated by loadLesson()'s own status == 'published' requirement,
// enforced server-side).
import { db } from '../../../assets/js/firebase-init.js';
import { doc, getDoc, getDocs, collection } from "https://www.gstatic.com/firebasejs/10.7.1/firebase-firestore.js";
import { SCHEMA_VERSION, v3ToV2Slides, v3ObjectToV2Block } from './canvas/model.js';
import { mountStage, renderSlide, NATIVE_TYPES } from './canvas/renderer.js';
import { requireAuth } from '../../../assets/js/auth.js';
import { injectStudentLayout } from '../../../assets/js/layout-student.js';
import { loadTeacherSubjectsCache, getTeacherDocRef, openOverlay, closeOverlay, showMsg, loadSchoolHeaderInfo } from '../../../assets/js/utils.js';
import { resolvePostContext } from '../../../assets/js/posts.js';
import {
    loadSubmission,
    saveSubmission,
    loadGradesIndexForStudent,
    isSubmissionFrozen
} from '../../../assets/js/submissions.js';
import {
    subscribeToActiveLiveSession,
    getLastLiveSessionId,
    subscribeToLiveSession,
    subscribeToLiveResponses,
    saveLiveResponse,
    normalizeLessonSlides,
    loadMyLiveResponse,
    submitLessonQuizAnswer,
    saveLessonResponse,
    loadMyLessonResponse,
    subscribeToLessonBoardNotes
} from '../../../assets/js/lessons.js';
import { WIDGET_TYPES, widgetState, updateWidgetLive, bindWidgetEvents, restoreWidgetDrafts } from './canvas/tools/interactive.js';
import { createDocumentViewer } from './document.js';
import { setupLiveFullscreen } from './live-fullscreen.js';
import { createStudentPresence } from './live-presence.js';
import { paintActivity, injectActivityCss, openActivity, pinCardToBox, withActivity } from './live-activity.js';

// ── 1. AUTHENTICATION & LAYOUT ──────────────────────────────────────────────
const session = requireAuth('student', '../login.html');
if (session) {
    injectStudentLayout('stream', 'Lesson', 'Interactive lesson viewer');
}

// ── 2. URL PARAMS ─────────────────────────────────────────────────────────
// A lesson is opened from a Class Stream post carrying linkedLessonId — the
// post itself already denormalizes classId/subjectId (see posts.js's
// createPost()), so those are passed straight through in the link rather
// than re-derived here. subjectId is technically all this page strictly
// needs alongside classId to build a lessonRef-shaped path, but subjectName
// is accepted too so the top bar can paint instantly without waiting on the
// subjects fetch below.
const params = new URLSearchParams(window.location.search);
const urlLessonId = params.get('lessonId');
const urlClassId = params.get('classId');
const urlSubjectId = params.get('subjectId');
const urlSubjectName = params.get('subjectName') || '';

// ── 3. STATE ──────────────────────────────────────────────────────────────
let lesson = null;             // the loaded lesson doc (format, slides[], etc.)
let postContext = null;        // { classId, className, subjectId, subjectName } — resolved once, reused for every submissions.js call
let currentSlideIndex = 0;     // Slides format only
let canvasStage = null;        // v3 renderer stage handle for the current slide (null on v2 lessons)
let docViewer = null;          // Document format's read-only Tiptap viewer (document.js)
let assignmentsById = new Map(); // linkedAssignmentId -> the real assignment record (for the submission panel)
let gradesById = new Map();      // assignmentId -> grade record | null
let currentPanelAssignmentId = null; // assignment currently open in the slide-in panel
let loadedMediaSlideIds = new Set(); // video block ids whose iframe has already been lazily inserted (Slides format)

// ── PHASE 3: LIVE SESSION ENGINE — student-side state ────────────────────
let liveSessionId = null;          // this lesson's currently-active live session, if any
let liveSessionData = null;        // { teacherPositionId, endedAt, ... } — last snapshot
let unsubLiveSession = null;       // subscribeToLiveSession()'s unsubscribe
let unsubActiveSession = null;     // subscribeToActiveLiveSession()'s unsubscribe (session start / end / restart)
let unsubLiveResponses = null;     // subscribeToLiveResponses()'s unsubscribe — re-registered per block, same as the teacher dashboard
let liveResponsesForCurrentBlock = []; // collaborative_board's shared wall for whichever block is on screen
// Phase 4 step 4 widgets (poll / quiz / open_response / board canvas objects)
let currentV3Slide = null;           // the v3 slide on screen (widgets need its objects) — incl. a live activity placed on it
let baseV3Slide = null;              // the same slide as saved in the lesson
let myWidgetResponses = new Map();   // objectId → this student's own response (loaded on demand)
let widgetResponses = [];            // shared board-widget notes for the slide on screen
let unsubWidgetResponses = null;
let unbindWidgets = null;
let mySubmittedBlockIds = new Set(); // interactive_prompt/collaborative_board block ids this student has already answered this session (so a re-render doesn't blow away an in-progress unsent draft)

// ── LIVE SESSION LOCKDOWN: single source of truth for "is this session
// still accepting submissions right now" ─────────────────────────────────
// liveSessionId is set when a session starts (switchLiveSession(), below) and
// is NOT cleared when it ends — it stays truthy for the rest of the page's life even after
// the teacher ends the session, since it also doubles as "this lesson HAD a
// session, so keep showing read-only session UI (the ended banner, a
// collaborative board's frozen wall)" rather than reverting to the plain
// "never live" slide state. Checking liveSessionId alone therefore is NOT
// enough to gate whether new input should be accepted — every place that
// decides whether to render/wire a LIVE, WRITABLE form (the submit button,
// the answer textarea, the multiple-choice buttons) must check this
// instead, which additionally requires a live session snapshot to exist
// AND that snapshot's endedAt to still be unset.
function isSessionLive() {
    return !!(liveSessionId && liveSessionData && !liveSessionData.endedAt);
}

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

function localStorageKey(lessonId) {
    return `connectus_lesson_progress_${lessonId}`;
}

// ── 4. INITIALIZATION ───────────────────────────────────────────────────────
async function init() {
    if (!session) return;

    cacheEls();
    wireEvents();

    // Fire-and-forget header fill-in, same pattern as student/stream/stream.js
    // and student/lessons/lessons.js (injectStudentLayout only has the
    // student's own cached session data — the school name/active semester
    // need their own fetch). Missing this call is why #displaySchoolName and
    // #activeSemesterDisplay were stuck on their static "Loading..."
    // placeholders on this page specifically.
    loadSchoolHeaderInfo(session.schoolId).then(({ schoolName, semesterName }) => {
        const schoolEl = document.getElementById('displaySchoolName');
        const semEl = document.getElementById('activeSemesterDisplay');
        if (schoolEl) schoolEl.textContent = schoolName;
        if (semEl) semEl.textContent = semesterName;
    });

    if (!urlLessonId || !urlClassId || !urlSubjectId) {
        showError("This lesson link looks incomplete — try opening it again from Class Stream.");
        return;
    }

    try {
        // ── Fetch the lesson ─────────────────────────────────────────────
        // This reads ONLY the main lesson document — never the
        // lessons/{id}/private subcollection, which firestore.rules denies
        // students outright regardless of publish status. The main doc's
        // own read rule (also enforced server-side) allows a student to
        // read it ONLY when resource.data.status == 'published'; a draft or
        // deleted lesson simply comes back permission-denied / not-found
        // here, handled below exactly like any other failed fetch.
        const snap = await getDoc(doc(db, 'schools', session.schoolId, 'classes', urlClassId, 'subjects', urlSubjectId, 'lessons', urlLessonId));
        if (!snap.exists()) {
            showError("This lesson doesn't exist, or it's no longer available.");
            return;
        }
        const data = snap.data();
        if (data.status !== 'published') {
            // Belt-and-suspenders: firestore.rules already prevents a
            // student from ever reaching this branch for a real draft (the
            // read itself would have been denied), but a lesson unpublished
            // moments after this student's link was generated could still
            // race here — same failure mode as any other draft-status
            // guard elsewhere in the app, handled the same way (a plain
            // message, not a crash).
            showError('This lesson is no longer published.');
            return;
        }
        // normalizeLessonSlides() upgrades any pre-redesign ('title'/
        // 'content'/'media'/'assignment'/'interactive_prompt') slide into
        // the current { type:'blank', blocks:[...] } shape on read — this
        // page bypasses lessons.js's own loadLesson() (see the fetch
        // comment above), so it has to call this explicitly rather than
        // getting it "for free" the way builder.js/live.js do. See
        // lessons.js's migrateLegacySlide() for the full rationale.
        // Split lesson model: slides/theme live in lessons/{id}/content/main
        // (readable by students only while the lesson is published). Pre-split
        // lessons still carry slides on the main doc — fall back to those.
        const contentSnap = await getDoc(doc(snap.ref, 'content', 'main')).catch(() => null);
        const content = contentSnap && contentSnap.exists() ? contentSnap.data() : null;
        const isV3 = !!(content && content.schemaVersion === SCHEMA_VERSION);
        let slidesSrc = content && Array.isArray(content.slides) ? content.slides : data.slides;
        let v3 = null;
        if (isV3) {
            // Canvas schema v3: per-slide docs (slides/{slideId}) + doc/main for Documents.
            const isDoc = data.format === 'document';
            const [slidesSnap, docSnap] = await Promise.all([
                isDoc ? null : getDocs(collection(snap.ref, 'slides')),
                isDoc ? getDoc(doc(snap.ref, 'doc', 'main')).catch(() => null) : null,
            ]);
            const slidesById = new Map((slidesSnap ? slidesSnap.docs : []).map(d => [d.id, { ...d.data(), id: d.id }]));
            const docData = docSnap && docSnap.exists() ? docSnap.data() : null;
            if (isDoc || slidesById.size || !(content.slideOrder || []).length) {
                slidesSrc = v3ToV2Slides({ content, slidesById, doc: docData, format: isDoc ? 'document' : 'slides' });
                v3 = { stage: content.stage, theme: content.theme || 'general', slidesById };
            }
            // else: slideOrder points at slides that don't exist (yet) → fall through to v2 data, if any
        }
        lesson = { id: snap.id, ...data, theme: (content && content.theme) || data.theme || 'general', format: data.format === 'document' ? 'document' : 'slides', slides: normalizeLessonSlides(slidesSrc) || [] };
        lesson.v3 = v3;
        postContext = { classId: urlClassId, className: data.className || '', subjectId: urlSubjectId, subjectName: data.subjectName || urlSubjectName };

        // ── Resolve this student's real assignment records ───────────────
        // The embedded assignment card (Slide-format 'assignment' blocks,
        // and Document-format assignmentEmbed nodes) stores only
        // {id, title} — the submission workflow needs the REAL assignment
        // record (maxScore, locked, instructions, etc.), so this fetches
        // this student's full teacher-subjects cache once and indexes every
        // assignment by id. Same fetch shape student/assignments/
        // assignments.js already uses; not reused directly since this page
        // only needs the lookup map, not the full merged/sorted list.
        const teacherId = session.studentData?.teacherId;
        if (teacherId) {
            try {
                const teacherSnap = await getDoc(getTeacherDocRef(session.schoolId, teacherId));
                const legacyTeacherData = teacherSnap.exists() ? teacherSnap.data() : null;
                const { subjectsCache, resolvedClasses } = await loadTeacherSubjectsCache(session.schoolId, teacherId, legacyTeacherData);
                subjectsCache.forEach(subject => {
                    const ctx = resolvePostContext(subject, resolvedClasses);
                    if (!ctx) return;
                    (subject.assignments || []).forEach(a => assignmentsById.set(a.id, { ...a, ...ctx }));
                });
                gradesById = await loadGradesIndexForStudent(session.schoolId, session.studentId);
            } catch (e) {
                // Non-fatal: the lesson itself still renders — only the
                // embedded assignment cards degrade to "unavailable" (see
                // renderAssignmentEmbedHtml() below) rather than the whole
                // page failing to load over what is, from the student's
                // point of view, a completely separate feature.
                console.error('[Lesson Viewer] Failed to load assignments/grades index:', e);
            }
        }

        renderTopBar();
        els.lessonLoader.classList.add('hidden');
        els.lessonViewerRoot.classList.remove('hidden');
        els.lessonViewerRoot.classList.add('flex');

        if (lesson.format === 'document') {
            renderDocumentView();
        } else {
            renderDeckView();
        }

        // ── PHASE 3: join this lesson's live session, if the teacher has
        // one running right now. Non-fatal if this fails — the lesson still
        // renders and functions exactly as a normal, non-live lesson; only
        // auto-follow/live-response features are unavailable.
        // Real-time: the teacher may go live (or end and restart) at any
        // point after this page loads — no reload needed.
        unsubActiveSession = subscribeToActiveLiveSession(session.schoolId, postContext, urlLessonId, switchLiveSession);
    } catch (e) {
        console.error('[Lesson Viewer] init:', e);
        showError('Something went wrong loading this lesson. Please try again later.');
    }
}

function cacheEls() {
    [
        'lessonLoader', 'lessonErrorState', 'lessonErrorMsg', 'lessonViewerRoot',
        'lvTitle', 'lvSubject', 'lvSlideCount', 'lvProgressFill',
        'lvDeckView', 'lvSlideCanvas', 'lvPrevBtn', 'lvNextBtn', 'lvDotRow',
        'lvDocView', 'lvTocList', 'docViewerEditor',
        'lvAssignmentOverlay', 'lvAssignmentInner', 'lvAsgSubjectLabel', 'lvAsgTitle', 'lvAsgMetaRow', 'lvAssignmentBody', 'lvCloseAssignmentBtn',
        'lvLiveBanner'
    ].forEach(id => { els[id] = document.getElementById(id); });
}

function wireEvents() {
    els.lvPrevBtn.addEventListener('click', () => manualGoToSlide(currentSlideIndex - 1));
    els.lvNextBtn.addEventListener('click', () => manualGoToSlide(currentSlideIndex + 1));

    document.addEventListener('keydown', (e) => {
        // Only steer the deck with arrow keys when the Slide Deck view is
        // actually the one showing, and never while the assignment panel is
        // open (a student typing into the response textarea must not have
        // ArrowLeft/ArrowRight hijacked into changing slides underneath them).
        if (lesson?.format === 'document') return;
        if (!els.lvAssignmentOverlay.classList.contains('hidden')) return;
        if (e.key === 'ArrowLeft') manualGoToSlide(currentSlideIndex - 1);
        if (e.key === 'ArrowRight') manualGoToSlide(currentSlideIndex + 1);
    });

    els.lvCloseAssignmentBtn.addEventListener('click', closeAssignmentPanel);

    // Event delegation for assignment-embed clicks: the Slide canvas
    // re-renders wholesale and the Document viewer's cards are node views,
    // so listeners are attached once at a stable ancestor rather than
    // re-wired after every render.
    els.lvSlideCanvas.addEventListener('click', onEmbeddedContentClick);
    els.docViewerEditor.addEventListener('click', onEmbeddedContentClick);
}

function showError(message) {
    els.lessonLoader.classList.add('hidden');
    els.lessonErrorMsg.textContent = message;
    els.lessonErrorState.classList.remove('hidden');
}

// ── 5. TOP BAR (title, subject, progress) ────────────────────────────────
function renderTopBar() {
    els.lvTitle.textContent = lesson.title || 'Untitled Lesson';
    els.lvSubject.textContent = postContext.subjectName || '';
}

function updateProgressBar() {
    let pct = 0;
    if (lesson.format === 'document') {
        // Document format has no discrete "slide count" — progress instead
        // tracks scroll position through the rendered content (see the
        // scroll listener wired in renderDocumentView()).
        const scroller = els.lvDocView;
        const scrollable = scroller.scrollHeight - scroller.clientHeight;
        pct = scrollable > 0 ? Math.min(100, Math.round((scroller.scrollTop / scrollable) * 100)) : 100;
        els.lvSlideCount.classList.add('hidden');
    } else {
        const total = lesson.slides.length;
        pct = total > 1 ? Math.round((currentSlideIndex / (total - 1)) * 100) : 100;
        els.lvSlideCount.textContent = `Slide ${currentSlideIndex + 1} of ${total}`;
        els.lvSlideCount.classList.remove('hidden');
    }
    els.lvProgressFill.style.width = `${pct}%`;
}

// ── 6. SLIDE DECK FORMAT ──────────────────────────────────────────────────
function renderDeckView() {
    els.lvDeckView.classList.remove('hidden');
    els.lvDeckView.classList.add('flex');

    // Resume where the student left off, scoped per-lesson so progress in
    // one lesson never bleeds into another. An out-of-range saved index
    // (the teacher removed slides since the student's last visit) clamps
    // safely back into range rather than rendering a blank canvas.
    let startIndex = 0;
    try {
        const saved = Number(localStorage.getItem(localStorageKey(lesson.id)));
        if (Number.isInteger(saved) && saved >= 0 && saved < lesson.slides.length) startIndex = saved;
    } catch (e) {
        // Private-browsing / storage-disabled: not fatal, just start at 0.
        console.warn('[Lesson Viewer] Could not read saved slide progress:', e);
    }

    renderDots();
    goToSlide(startIndex, /* skipSave */ true);
}

function renderDots() {
    els.lvDotRow.innerHTML = lesson.slides.map((_, i) =>
        `<button type="button" data-dot-index="${i}" class="rounded-full transition" style="width:${i === currentSlideIndex ? '20px' : '7px'};height:7px;background:${i === currentSlideIndex ? '#4338ca' : '#c7d2fe'}"></button>`
    ).join('');
    els.lvDotRow.querySelectorAll('[data-dot-index]').forEach(btn => {
        btn.addEventListener('click', () => manualGoToSlide(Number(btn.dataset.dotIndex)));
    });
}

function goToSlide(index, skipSave = false) {
    if (!lesson || lesson.format === 'document') return;
    const total = lesson.slides.length;
    if (index < 0 || index >= total) return;

    currentSlideIndex = index;
    els.lvPrevBtn.disabled = index === 0;
    els.lvNextBtn.disabled = index === total - 1;

    renderSlideCanvas();
    renderDots();
    updateProgressBar();

    if (!skipSave) {
        try {
            localStorage.setItem(localStorageKey(lesson.id), String(currentSlideIndex));
        } catch (e) {
            console.warn('[Lesson Viewer] Could not save slide progress:', e);
        }
    }
}

function currentSlide() {
    return lesson.slides[currentSlideIndex] || null;
}

// A student's own prev/next click or arrow key, as opposed to
// joinLiveSession()'s teacher-driven goToSlide() call. Blocked outright
// while this student is actively following a live, not-yet-ended session —
// without this, a student's manual navigation would save that slide as
// their new "resume position" (goToSlide()'s own localStorage write), only
// for the very next teacherPositionId update to silently snap them back
// with no explanation. Once the session ends (liveSessionData.endedAt is
// set), manual navigation is freely allowed again — the lesson behaves like
// any other non-live lesson from that point on.
function manualGoToSlide(index) {
    if (isSessionLive()) {
        showLiveBanner('Your teacher is presenting live — navigation follows their position.');
        return;
    }
    goToSlide(index);
}

// SLIDE DECK REDESIGN: a 'blank' slide's presentation is now its blocks
// stacked together — the exact content/order the teacher laid out with the
// builder's own toolbar — rather than one fixed-type slide dispatch table.
// collaborative_board is unchanged: still a special, non-blocks whole-slide
// type, rendered directly.
function renderSlideCanvas() {
    const slide = currentSlide();
    if (!slide) { els.lvSlideCanvas.innerHTML = ''; return; }

    const v3Slide = lesson.v3 && slide.type !== 'collaborative_board' ? lesson.v3.slidesById.get(slide.id) : null;
    if (canvasStage) { canvasStage.destroy(); canvasStage = null; }
    if (v3Slide && v3Slide.kind === 'canvas') {
        // Schema v3: shared 1600×900 renderer; block markup (prompts, assignment
        // cards, lazy media) still comes from this page, so wiring below is unchanged.
        els.lvSlideCanvas.innerHTML = '<div class="lv-v3-wrap" style="width:100%;"></div>';
        canvasStage = mountStage(els.lvSlideCanvas.firstElementChild, { stage: lesson.v3.stage, theme: lesson.v3.theme });
        baseV3Slide = v3Slide;
        currentV3Slide = withActivity(v3Slide, currentStudentActivity());
        paintV3Slide();
        setupWidgetsForSlide(currentV3Slide);
        syncStudentActivity();
    } else {
        baseV3Slide = null;
        currentV3Slide = null;
        setupWidgetsForSlide(null);
        syncStudentActivity();
        els.lvSlideCanvas.innerHTML = slide.type === 'collaborative_board'
            ? renderCollaborativeBoardHtml(slide)
            : renderBlankSlideHtml(slide);
    }

    // Lazy-load: a video block's <iframe> is only ever inserted once this
    // exact slide becomes the active one (here, right after it's rendered
    // as the current slide) — see mountLazyMediaFrame() below. Re-visiting
    // an already-loaded block does not reload the iframe (loadedMediaSlideIds
    // guards that), so a student paging back and forth doesn't restart video
    // playback on every pass. A slide can now hold more than one video block,
    // so every [data-lazy-media] node on screen is mounted, not just one.
    els.lvSlideCanvas.querySelectorAll('[data-lazy-media]').forEach(mountLazyMediaFrame);

    // ── PHASE 3: live-response wiring. Only meaningful while the session is
    // ACTIVELY live — isSessionLive() (not the bare liveSessionId, which
    // stays truthy after the session ends) gates this so a submit button is
    // never wired once the session is over. liveBlocksForSlide() below finds
    // every live-interactive item on the current slide: any Interactive
    // Prompt block(s) within a 'blank' slide (there can now be more than
    // one), or the whole slide itself for collaborative_board.
    if (isSessionLive()) {
        liveBlocksForSlide(slide).forEach(item => wireLiveBlockForm(item));
    }
    // The live responses LISTENER (as opposed to the submission FORM above)
    // is only ever opened for collaborative_board. interactive_prompt is
    // intentionally private (Nearpod-style — a student's answer is never
    // shown to classmates), and firestore.rules' responses collection-group
    // rule enforces that server-side: a student listing responses for an
    // interactive_prompt block is denied outright (confirmed via live
    // testing — this used to be attempted here and simply threw a
    // permission-denied on every prompt block until this guard was added).
    // "Did I already submit this prompt" is tracked locally instead, via
    // mySubmittedBlockIds.add() right inside submitLiveResponse() itself —
    // it doesn't need a listener at all.
    //
    // Deliberately gated on the bare liveSessionId here, NOT isSessionLive()
    // — this is a READ-ONLY listener (the LIST rule doesn't care whether the
    // session has ended), and the whole point of the Live Session Lockdown
    // is that a student can still review the board's frozen wall of
    // everyone's cards after the session ends, even though they can no
    // longer add a new one. renderCollaborativeBoardHtml() keeps rendering
    // the #lvBoardWall container in its "session ended" branch specifically
    // so this listener always has somewhere to render into.
    if (liveSessionId && slide.type === 'collaborative_board') {
        registerBlockResponsesListener(slide.id, slide.type);
    } else if (unsubLiveResponses) {
        // Navigated away from the board (or a live session isn't active) —
        // tear down any listener left over from the previous slide rather
        // than let it keep running unseen.
        unsubLiveResponses();
        unsubLiveResponses = null;
    }
}

// Which item(s) on the current slide are live-interactive (get a submit
// form wired, keyed by data-live-block-id) — mirrors live.js's own
// liveBlocksForSlide(), same reasoning: a 'blank' slide's Interactive
// Prompt block(s), or the whole slide for collaborative_board.
function liveBlocksForSlide(slide) {
    if (!slide) return [];
    if (slide.type === 'collaborative_board') return [slide];
    return (slide.blocks || []).filter(b => b.type === 'interactive_prompt');
}

function renderBlankSlideHtml(slide) {
    const blocks = slide.blocks || [];
    if (!blocks.length) {
        return `<div class="lv-slide-card"><p class="text-slate-400 font-semibold m-0">This slide has no content yet.</p></div>`;
    }
    // FREE-FORM CANVAS: each block is positioned absolutely inside the 16:9
    // stage using its saved x/y/w/h (percentages of the stage box), the same
    // layout the teacher's builder canvas and live-session dashboard use.
    return `<div class="lv-slide-card lv-live-stage">${blocks.map(b => `<div class="lv-live-block" style="${liveBlockPositionStyle(b)}">${renderLiveBlockDisplayHtml(b)}</div>`).join('')}</div>`;
}

// Mirrors builder.js's blockPositionStyle()/live.js's liveBlockPositionStyle();
// ensureBlockLayout() (run by normalizeLessonSlides()/loadLesson()) guarantees
// every block has numeric x/y/w/h by the time it reaches this page, but the
// numeric guard keeps this resilient even against unmigrated data.
function liveBlockPositionStyle(block) {
    if (typeof block.x !== 'number' || typeof block.y !== 'number' || typeof block.w !== 'number' || typeof block.h !== 'number') {
        return 'position:static;';
    }
    return `left:${block.x}%; top:${block.y}%; width:${block.w}%; height:${block.h}%;`;
}

// The `.ql-editor` class reuses Quill's own CSS (already loaded on this page
// for the Document-format read-only editor below) purely for its typography
// rules — a plain div, not a live Quill instance.
function renderLiveBlockDisplayHtml(block) {
    switch (block.type) {
        case 'image':
            return block.imageUrl
                ? `<div class="h-full flex flex-col">
                     <img src="${escHtml(block.imageUrl)}" alt="${escHtml(block.imageAlt)}" class="w-full flex-1 min-h-0 object-contain rounded-xl bg-slate-50 border border-slate-200"
                          onerror="this.outerHTML = '<div class=\\'lv-media-frame\\'><div class=\\'lv-media-placeholder\\'><p class=\\'text-[12.5px] font-semibold\\'>This image couldn\\'t be loaded.</p></div></div>'">
                     ${block.caption ? `<p class="text-[12px] text-slate-400 font-semibold mt-2 text-center flex-shrink-0">${escHtml(block.caption)}</p>` : ''}
                   </div>`
                : `<div class="lv-media-frame h-full" style="aspect-ratio:auto;"><div class="lv-media-placeholder"><p class="text-[12.5px] font-semibold">No image was added to this slide.</p></div></div>`;
        case 'video':
            return `<div class="h-full flex flex-col">
                       <div class="lv-media-frame flex-1 min-h-0" style="aspect-ratio:auto;" data-lazy-media data-block-id="${escHtml(block.id)}" data-embed-url="${escHtml(block.embedUrl || '')}"><div class="lv-media-placeholder"><i class="fa-solid fa-circle-play text-3xl"></i></div></div>
                       ${block.caption ? `<p class="text-[12px] text-slate-400 font-semibold mt-2 text-center flex-shrink-0">${escHtml(block.caption)}</p>` : ''}
                    </div>`;
        case 'assignment':
            return `<div>${renderAssignmentEmbedHtml(block.linkedAssignmentId)}</div>`;
        case 'interactive_prompt':
            return renderInteractivePromptBlockHtml(block);
        case 'text':
        default:
            return `<div class="ql-editor" style="padding:0;">${block.html || ''}</div>`;
    }
}

// ── PHASE 3: LIVE SESSION ENGINE — interactive block rendering ──────────
// Prompt text renders unconditionally (a teacher paging through the deck
// outside a live session, or a student opening the lesson later for review,
// should still see what was asked). The submission form itself has THREE
// possible states, not two:
//   1. isSessionLive() — the writable form (textarea/choices/submit button),
//      wired by wireLiveBlockForm() in renderSlideCanvas() above.
//   2. liveSessionId set but the session has ENDED (liveSessionData.endedAt)
//      — LIVE SESSION LOCKDOWN: no writable form at all, just a locked
//      notice (plus the existing "you already answered" confirmation, which
//      still applies — reviewing that you submitted is not the same as
//      being able to submit again).
//   3. liveSessionId never set at all (no session has ever run for this
//      lesson) — the original static "only live during an active session"
//      copy.
// SLIDE DECK REDESIGN: a slide can now hold more than one Interactive
// Prompt block, so every id that used to be a page-global id (lvLiveSubmitBtn
// etc.) is now a data-attribute scoped inside [data-live-block-id="<id>"] —
// see wireLiveBlockForm()/submitLiveResponse() below, which query within
// that scope rather than the whole document. collaborative_board (still
// exactly one per slide) uses the same scoped pattern now too, for one
// unified code path instead of two.
function renderInteractivePromptBlockHtml(block) {
    const alreadySubmitted = mySubmittedBlockIds.has(block.id);
    const sessionEnded = !!(liveSessionId && liveSessionData && liveSessionData.endedAt);
    return `
    <div data-live-block-id="${escHtml(block.id)}">
        <span class="lv-live-badge"><i class="fa-solid fa-bolt"></i> Live Prompt</span>
        <p class="text-[14px] text-slate-700 font-semibold leading-relaxed mb-4 mt-2">${escHtml(block.promptText) || 'No prompt text set.'}</p>
        ${isSessionLive() ? `
            <div data-live-form-wrap>
                ${block.promptKind === 'multiple_choice' && (block.choices || []).length
                    ? `<div class="space-y-2 mb-3">${block.choices.map((c, i) => `
                        <button type="button" data-live-choice="${escHtml(c)}" class="lv-choice-btn w-full text-left px-3.5 py-2.5 rounded-xl border border-slate-200 hover:border-indigo-400 hover:bg-indigo-50 font-semibold text-[13px] text-slate-700 transition">${escHtml(c)}</button>`).join('')}</div>`
                    : `<textarea data-live-answer-text placeholder="Type your answer…" class="form-input w-full p-3 bg-white border border-slate-200 rounded-xl text-sm resize-none leading-relaxed mb-3" style="height:6rem;"></textarea>
                       <button type="button" data-live-submit-btn class="bg-gradient-to-r from-indigo-600 to-indigo-700 hover:from-indigo-700 hover:to-indigo-800 text-white font-black py-2.5 px-5 rounded-xl transition shadow-md text-sm"><i class="fa-solid fa-paper-plane mr-1"></i> Submit</button>`}
                <p data-live-msg class="text-[12px] font-bold mt-2 hidden"></p>
                ${alreadySubmitted ? `<p class="text-[11.5px] font-bold text-emerald-600 mt-2"><i class="fa-solid fa-circle-check"></i> Your answer was submitted.</p>` : ''}
            </div>`
            : sessionEnded
                ? `<div class="flex items-center gap-2 bg-slate-50 border border-slate-200 rounded-xl px-3.5 py-2.5">
                       <i class="fa-solid fa-lock text-slate-400 text-xs"></i>
                       <p class="text-[12px] font-semibold text-slate-500 m-0">This live session has ended — answers are read-only.</p>
                   </div>
                   ${alreadySubmitted ? `<p class="text-[11.5px] font-bold text-emerald-600 mt-2"><i class="fa-solid fa-circle-check"></i> Your answer was submitted.</p>` : ''}`
                : `<p class="text-[12px] font-semibold text-slate-400">This prompt is only live during an active session.</p>`}
    </div>`;
}

function renderCollaborativeBoardHtml(slide) {
    const alreadySubmitted = mySubmittedBlockIds.has(slide.id);
    const sessionEnded = !!(liveSessionId && liveSessionData && liveSessionData.endedAt);
    // LIVE SESSION LOCKDOWN: the write form (textarea + Add/Update button)
    // only ever renders while isSessionLive() — but #lvBoardWall itself
    // still renders in the "ended" branch too, deliberately, so the read-
    // only registerBlockResponsesListener() wired in renderSlideCanvas()
    // (gated on the bare liveSessionId, not isSessionLive() — see that
    // function's own comment) has somewhere to keep showing everyone's
    // already-submitted cards for review.
    return `
    <div class="lv-slide-card" data-live-block-id="${escHtml(slide.id)}">
        <span class="lv-live-badge lv-live-badge-board"><i class="fa-solid fa-people-group"></i> Collaborative Board</span>
        ${slide.heading ? `<h2 class="text-lg md:text-xl font-black text-slate-800 mt-3 mb-3">${escHtml(slide.heading)}</h2>` : ''}
        ${slide.instructions ? `<p class="text-[13.5px] text-slate-600 leading-relaxed whitespace-pre-wrap mb-4">${escHtml(slide.instructions)}</p>` : ''}
        ${isSessionLive() ? `
            <div data-live-form-wrap class="mb-4">
                <textarea data-live-answer-text placeholder="Add your card…" class="form-input w-full p-3 bg-white border border-slate-200 rounded-xl text-sm resize-none leading-relaxed mb-3" style="height:4.5rem;"></textarea>
                <button type="button" data-live-submit-btn class="bg-gradient-to-r from-indigo-600 to-indigo-700 hover:from-indigo-700 hover:to-indigo-800 text-white font-black py-2.5 px-5 rounded-xl transition shadow-md text-sm"><i class="fa-solid fa-plus mr-1"></i> ${alreadySubmitted ? 'Update My Card' : 'Add My Card'}</button>
                <p data-live-msg class="text-[12px] font-bold mt-2 hidden"></p>
            </div>
            <div id="lvBoardWall" class="grid grid-cols-1 sm:grid-cols-2 gap-2.5"></div>`
            : sessionEnded
                ? `<div class="flex items-center gap-2 bg-slate-50 border border-slate-200 rounded-xl px-3.5 py-2.5 mb-4">
                       <i class="fa-solid fa-lock text-slate-400 text-xs"></i>
                       <p class="text-[12px] font-semibold text-slate-500 m-0">This live session has ended — the board is read-only.</p>
                   </div>
                   <div id="lvBoardWall" class="grid grid-cols-1 sm:grid-cols-2 gap-2.5"></div>`
                : `<p class="text-[12px] font-semibold text-slate-400">This board is only live during an active session.</p>`}
    </div>`;
}

// Wires the Submit/Add-card button (and, for multiple_choice prompts, each
// choice button) for ONE live-interactive item (an Interactive Prompt block,
// or the collaborative_board slide itself), scoped to its own
// [data-live-block-id] subtree so multiple prompts on the same slide never
// cross-wire each other's buttons. Re-called every renderSlideCanvas(), so
// no stale listener from a previous slide's form can fire against the wrong
// item.
function wireLiveBlockForm(item) {
    const scope = els.lvSlideCanvas.querySelector(`[data-live-block-id="${item.id}"]`);
    if (!scope) return;
    const submitBtn = scope.querySelector('[data-live-submit-btn]');
    if (submitBtn) {
        submitBtn.addEventListener('click', () => submitLiveResponse(item, scope.querySelector('[data-live-answer-text]')?.value || ''));
    }
    scope.querySelectorAll('[data-live-choice]').forEach(btn => {
        btn.addEventListener('click', () => submitLiveResponse(item, btn.dataset.liveChoice));
    });
}

async function submitLiveResponse(item, answerText) {
    const scope = els.lvSlideCanvas.querySelector(`[data-live-block-id="${item.id}"]`);
    const text = (answerText || '').trim();
    if (!text) {
        const msg = scope?.querySelector('[data-live-msg]');
        if (msg) { msg.textContent = 'Write an answer before submitting.'; msg.className = 'text-[12px] font-bold mt-2 text-rose-600'; msg.classList.remove('hidden'); }
        return;
    }
    const btn = scope?.querySelector('[data-live-submit-btn]');
    if (btn) { btn.disabled = true; btn.innerHTML = '<i class="fa-solid fa-spinner fa-spin"></i>'; }

    try {
        const studentName = session.studentData?.name || session.studentData?.fullName || '';
        await saveLiveResponse(session.schoolId, postContext, lesson.id, liveSessionId, session.studentId, studentName, item.id, item.type, { answerText: text });
        mySubmittedBlockIds.add(item.id);
        const msg = scope?.querySelector('[data-live-msg]');
        if (msg) { msg.textContent = 'Submitted!'; msg.className = 'text-[12px] font-bold mt-2 text-emerald-600'; msg.classList.remove('hidden'); }
        const textarea = scope?.querySelector('[data-live-answer-text]');
        if (item.type === 'collaborative_board' && textarea) textarea.value = ''; // board keeps accepting new/updated cards; prompt is one-and-done
        if (btn) { btn.disabled = false; btn.innerHTML = item.type === 'collaborative_board' ? '<i class="fa-solid fa-plus mr-1"></i> Update My Card' : '<i class="fa-solid fa-paper-plane mr-1"></i> Submit'; }
    } catch (e) {
        console.error('[Lesson Viewer] submitLiveResponse:', e);
        const msg = scope?.querySelector('[data-live-msg]');
        if (msg) { msg.textContent = 'Could not submit — please try again.'; msg.className = 'text-[12px] font-bold mt-2 text-rose-600'; msg.classList.remove('hidden'); }
        if (btn) { btn.disabled = false; btn.innerHTML = '<i class="fa-solid fa-paper-plane mr-1"></i> Submit'; }
    }
}

// One responses listener at a time, scoped to whichever collaborative_board
// block is currently on screen — mirrors the teacher dashboard's own
// registerResponsesListener() (same subscribeToLiveResponses() call, same
// "list the session, filter to this block client-side" approach). Callers
// (renderSlideCanvas() above) only ever invoke this for collaborative_board
// — never interactive_prompt, which firestore.rules denies students list
// access to entirely (see that rule's own comment for why).
function registerBlockResponsesListener(blockId, blockType) {
    if (unsubLiveResponses) { unsubLiveResponses(); unsubLiveResponses = null; }
    // callerRole: 'student' — MUST match firestore.rules' student list
    // branch, which requires the QUERY ITSELF to filter on blockType (see
    // subscribeToLiveResponses()'s own comment in lessons.js: an unfiltered
    // query is denied outright for a student regardless of role, since
    // Firestore can't prove a data-dependent rule condition safe for a query
    // that doesn't filter on that same field). This function is only ever
    // registered for collaborative_board blocks (see this function's own
    // comment above), so the filter applied for a 'student' caller always
    // matches what this listener actually wants.
    unsubLiveResponses = subscribeToLiveResponses(session.schoolId, postContext, lesson.id, liveSessionId, (responses) => {
        const forThisBlock = responses.filter(r => r.blockId === blockId);
        liveResponsesForCurrentBlock = forThisBlock;
        if (forThisBlock.some(r => r.studentId === session.studentId)) mySubmittedBlockIds.add(blockId);

        if (blockType === 'collaborative_board') {
            const wall = document.getElementById('lvBoardWall');
            if (wall) {
                const sorted = [...forThisBlock].sort((a, b) => new Date(a.submittedAt || 0) - new Date(b.submittedAt || 0));
                wall.innerHTML = sorted.map(r => `
                    <div class="bg-indigo-50 border border-indigo-100 rounded-xl p-3">
                        <p class="text-[10.5px] font-black text-indigo-500 uppercase tracking-wide mb-1">${escHtml(r.studentName || r.studentId)}</p>
                        <p class="text-[13px] font-semibold text-slate-700 m-0 whitespace-pre-wrap">${escHtml(r.answerText)}</p>
                    </div>`).join('');
            }
        }
    }, 'student');
}

// ── PHASE 4 STEP 4: CANVAS WIDGETS (student side) ────────────────────────
// Quiz answers the teacher's screen put on the session when it ended.
function revealedFor(id) {
    const r = liveSessionData && liveSessionData.endedAt && liveSessionData.revealedAnswers;
    return r && Array.isArray(r[id]) ? r[id] : [];
}

// ── half-typed answers (open response / sticky note) ──
// Kept per lesson + session in sessionStorage, so a slide change, a re-render
// or a reload never throws away what a student was typing.
const widgetDrafts = {
    _key() { return liveSessionId && lesson ? `gt-wdraft:${lesson.id}:${liveSessionId}` : null; },
    _read() { try { const k = this._key(); return k ? JSON.parse(sessionStorage.getItem(k) || '{}') : {}; } catch (e) { return {}; } },
    _write(o) { try { const k = this._key(); if (k) sessionStorage.setItem(k, JSON.stringify(o)); } catch (e) { /* storage off */ } },
    get(id) { const v = this._read()[id]; return typeof v === 'string' ? v : undefined; },
    set(id, text) { const o = this._read(); o[id] = String(text).slice(0, 4000); this._write(o); },
    delete(id) { const o = this._read(); delete o[id]; this._write(o); },
};

function restoreDrafts() {
    if (!isSessionLive()) return;
    restoreWidgetDrafts(els.lvSlideCanvas, widgetDrafts);
    if (activityCard) restoreWidgetDrafts(activityCard, widgetDrafts);
}

function widgetCtx(obj) {
    return {
        correctIds: revealedFor(obj.id),
        state: widgetState({ sessionId: liveSessionId, sessionData: liveSessionData }),
        mine: myWidgetResponses.get(obj.id) || null,
        responses: obj.type === 'board' ? widgetResponses : [],
        spotlight: liveSessionData && liveSessionData.spotlight ? liveSessionData.spotlight : null,
    };
}

function paintV3Slide() {
    if (!canvasStage || !currentV3Slide) return;
    renderSlide(canvasStage, currentV3Slide, {
        mode: 'student',
        renderContent: (obj) => (NATIVE_TYPES.has(obj.type) ? undefined : renderLiveBlockDisplayHtml(v3ObjectToV2Block(obj))),
        widgetContext: widgetCtx,
    });
    refreshWidgets(false);
    restoreDrafts();
}

// Re-render widget shells whose structure changed, then refresh live regions.
function refreshWidgets(repaint = true) {
    if (!canvasStage || !currentV3Slide) return;
    if (repaint) { paintV3Slide(); return; }
    (currentV3Slide.objects || []).forEach(obj => {
        if (!WIDGET_TYPES.has(obj.type)) return;
        const node = canvasStage.nodes.get(obj.id);
        if (node) updateWidgetLive(node.el, obj, 'student', widgetCtx(obj));
    });
}

function setupWidgetsForSlide(v3Slide) {
    if (unsubWidgetResponses) { unsubWidgetResponses(); unsubWidgetResponses = null; }
    widgetResponses = [];
    if (!unbindWidgets && els.lvSlideCanvas) {
        unbindWidgets = bindWidgetEvents(els.lvSlideCanvas, {
            drafts: widgetDrafts,
            getObject: (id) => (currentV3Slide?.objects || []).find(o => o.id === id) || null,
            onSubmit: submitWidget,
        });
    }
    const widgets = (v3Slide?.objects || []).filter(o => WIDGET_TYPES.has(o.type));
    if (!widgets.length || !liveSessionId) return;
    // own answers (so a returning student sees what they already sent)
    const missing = widgets.filter(w => !myWidgetResponses.has(w.id));
    if (missing.length) {
        Promise.all(missing.map(w => loadMyLiveResponse(session.schoolId, postContext, lesson.id, liveSessionId, session.studentId, w.id)
            .then(r => { if (r) myWidgetResponses.set(w.id, r); })))
            .then(() => { if (currentV3Slide === v3Slide) refreshWidgets(); });
    }
    const boardIds = new Set(widgets.filter(w => w.type === 'board').map(w => w.id));
    if (boardIds.size) {
        unsubWidgetResponses = subscribeToLiveResponses(session.schoolId, postContext, lesson.id, liveSessionId, (responses) => {
            widgetResponses = responses.filter(r => boardIds.has(r.blockId));
            widgetResponses.filter(r => r.studentId === session.studentId).forEach(r => myWidgetResponses.set(r.blockId, r));
            refreshWidgets(false);
        }, 'student', 'board');
    }
}

async function submitWidget(obj, payload) {
    if (!isSessionLive()) throw new Error('This live session has ended.');
    if (obj.type === 'quiz') {
        const res = await submitLessonQuizAnswer({
            schoolId: session.schoolId, classId: postContext.classId, subjectId: postContext.subjectId,
            lessonId: lesson.id, sessionId: liveSessionId, objectId: obj.id, choiceIds: payload.choiceIds,
        });
        // the server returns the picks it actually graded (or the earlier attempt's)
        myWidgetResponses.set(obj.id, { choiceIds: Array.isArray(res.choiceIds) ? res.choiceIds : payload.choiceIds, correct: res.correct === true });
    } else {
        const studentName = session.studentData?.name || session.studentData?.fullName || '';
        const rec = await saveLiveResponse(session.schoolId, postContext, lesson.id, liveSessionId, session.studentId, studentName, obj.id, obj.type, payload);
        myWidgetResponses.set(obj.id, rec);
    }
    refreshWidgets();
    paintStudentActivity();
}

// ── LIVE ACTIVITIES (questions the teacher asks during the session) ──────
// The open one (session.activityId) shows as a card over the lesson — inside
// lessonViewerRoot, so it stays visible in full screen. It answers through
// submitWidget() like any lesson widget. "Hide" folds it to its title bar.
let activityCard = null;
let activityShownId = null;
let activityNotes = [];
let unsubActivityNotes = null;
let activityMinimized = false;
let unbindActivity = null;

function currentStudentActivity() {
    return liveSessionId && liveSessionData ? openActivity(liveSessionData) : null;
}

function ensureActivityCard() {
    if (activityCard) return activityCard;
    injectActivityCss();
    const root = els.lessonViewerRoot;
    activityCard = document.createElement('section');
    activityCard.className = 'lact-card lact-student';
    activityCard.setAttribute('role', 'region');
    activityCard.setAttribute('aria-label', 'Question from your teacher');
    activityCard.innerHTML = `<div class="lact-card-bar"><span class="lact-live-dot" aria-hidden="true"></span><span class="lact-grow" aria-live="assertive">Question from your teacher</span><button type="button" data-min aria-expanded="true">Hide</button></div><div class="lact-card-body" data-body></div>`;
    root.appendChild(activityCard); // inside the full-screen element
    // sits over the slide itself (or the document page area), never outside it
    pinCardToBox(activityCard, () => {
        const target = lesson && lesson.format === 'document'
            ? els.lvDocView
            : (els.lvSlideCanvas && (els.lvSlideCanvas.querySelector('.cv-viewport, .lv-slide-card') || els.lvSlideCanvas));
        return target ? target.getBoundingClientRect() : null;
    });
    activityCard.querySelector('[data-min]').addEventListener('click', () => {
        activityMinimized = !activityMinimized;
        paintStudentActivity();
    });
    unbindActivity = bindWidgetEvents(activityCard.querySelector('[data-body]'), {
        drafts: widgetDrafts,
        getObject: (id) => { const a = currentStudentActivity(); return a && a.id === id ? a : null; },
        onSubmit: submitWidget,
    });
    return activityCard;
}

// true when the open activity is drawn on the slide on screen (no card needed)
function activityOnStage(act) {
    return !!(act && baseV3Slide && act.slideId === baseV3Slide.id && typeof act.x === 'number');
}

function syncStudentActivity() {
    const act = currentStudentActivity();
    // keep the slide on screen in step: activity added to / removed from it
    if (baseV3Slide && canvasStage) {
        const next = withActivity(baseV3Slide, act);
        const shownIds = (currentV3Slide?.objects || []).map(o => o.id).join('|');
        const nextIds = (next.objects || []).map(o => o.id).join('|');
        currentV3Slide = next;
        if (shownIds !== nextIds) { paintV3Slide(); setupWidgetsForSlide(currentV3Slide); }
    }
    // a card only when it can't be drawn on the slide on screen (document
    // lessons, older slides, or the student is on a different slide)
    const cardId = act && !activityOnStage(act) ? act.id : null;
    if (cardId !== activityShownId) {
        activityShownId = cardId;
        activityNotes = [];
        activityMinimized = false;
        if (unsubActivityNotes) { unsubActivityNotes(); unsubActivityNotes = null; }
        if (cardId) {
            ensureActivityCard();
            const body = activityCard.querySelector('[data-body]');
            body.innerHTML = ''; body.__lactKey = null;
            if (!myWidgetResponses.has(cardId)) {
                loadMyLiveResponse(session.schoolId, postContext, lesson.id, liveSessionId, session.studentId, cardId)
                    .then(r => { if (r && activityShownId === cardId) { myWidgetResponses.set(cardId, r); paintStudentActivity(); } });
            }
            if (act.type === 'board') {
                unsubActivityNotes = subscribeToLiveResponses(session.schoolId, postContext, lesson.id, liveSessionId, (responses) => {
                    activityNotes = responses.filter(r => r.blockId === cardId);
                    activityNotes.filter(r => r.studentId === session.studentId).forEach(r => myWidgetResponses.set(r.blockId, r));
                    paintStudentActivity();
                }, 'student', 'board');
            }
        }
    }
    paintStudentActivity();
}

function paintStudentActivity() {
    const act = currentStudentActivity();
    if (activityOnStage(act)) refreshWidgets(false); // drawn on the slide itself
    if (!act || act.id !== activityShownId) {
        if (activityCard) activityCard.classList.add('hidden');
        return;
    }
    ensureActivityCard();
    activityCard.classList.remove('hidden');
    activityCard.classList.toggle('lact-min', activityMinimized);
    const minBtn = activityCard.querySelector('[data-min]');
    minBtn.textContent = activityMinimized ? 'Show' : 'Hide';
    minBtn.setAttribute('aria-expanded', String(!activityMinimized));
    paintActivity(activityCard.querySelector('[data-body]'), act, 'student', {
        state: widgetState({ sessionId: liveSessionId, sessionData: liveSessionData }),
        mine: myWidgetResponses.get(act.id) || null,
        responses: act.type === 'board' ? activityNotes : [],
        spotlight: liveSessionData && liveSessionData.spotlight ? liveSessionData.spotlight : null,
        correctIds: revealedFor(act.id),
    });
    restoreWidgetDrafts(activityCard, widgetDrafts);
}

// ── PHASE 3: JOIN A LIVE SESSION + AUTO-FOLLOW ───────────────────────────
// Subscribes to the session doc itself. Every time teacherPositionId
// changes, this student's screen jumps to match — Slides format navigates
// straight to that block's index; Document format (a single richtext block,
// no discrete positions) has nothing to auto-follow to, so this is a no-op
// there beyond the "session ended" banner, which still applies to both
// formats.
// A new session id: drop the previous session's listeners and answers, then
// join it. null (not live) leaves the joined session's own listener to show
// "ended" and lock the page.
// No live session right now: once per page, open the lesson's last (ended)
// session read-only so students see what they answered and the correct quiz
// answers. A session that starts later replaces it as usual.
let reviewChecked = false;
let reviewing = false;
function switchLiveSession(id) {
    if (!id && !liveSessionId && !reviewChecked) {
        reviewChecked = true;
        getLastLiveSessionId(session.schoolId, postContext, lesson.id).then((last) => {
            if (!last || liveSessionId) return;
            reviewing = true;
            liveSessionId = last;
            joinLiveSession();
        }).catch((e) => console.warn('[Lesson Viewer] last session lookup:', e));
        return;
    }
    if (!id || id === liveSessionId) return;
    reviewing = false;
    syncPresence(false);
    if (unsubLiveSession) { unsubLiveSession(); unsubLiveSession = null; }
    if (unsubLiveResponses) { unsubLiveResponses(); unsubLiveResponses = null; }
    if (unsubWidgetResponses) { unsubWidgetResponses(); unsubWidgetResponses = null; }
    liveSessionData = null;
    myWidgetResponses = new Map();
    widgetResponses = [];
    liveResponsesForCurrentBlock = [];
    mySubmittedBlockIds = new Set();
    liveSessionId = id;
    syncStudentActivity();
    joinLiveSession();
}

// Full screen control for live lessons — added the first time this page
// joins a live session (a lesson read on its own has no Full screen button).
let liveFullscreen = null;
function ensureLiveFullscreen() {
    if (liveFullscreen) return;
    liveFullscreen = setupLiveFullscreen({
        target: document.getElementById('lessonViewerRoot'),
        buttonHost: document.getElementById('lvHeadActions'),
        stage: lesson.format === 'document' ? null : els.lvSlideCanvas,
        tone: 'dark',
    });
}

// Presence (RTDB): this student shows on the teacher's roster while the
// session is live; onDisconnect() removes them server-side if the socket drops.
let presence = null;
function syncPresence(live) {
    if (!live) { if (presence) presence.leave(); return; }
    if (!presence) {
        presence = createStudentPresence({
            schoolId: session.schoolId,
            studentId: session.studentId,
            name: session.studentData?.name || session.studentData?.fullName || '',
        });
    }
    presence.join(liveSessionId);
}

let endedPaintedFor = null;
function joinLiveSession() {
    unsubLiveSession = subscribeToLiveSession(session.schoolId, postContext, lesson.id, liveSessionId, (data) => {
        const wasLive = isSessionLive();
        liveSessionData = data;
        if (!data.endedAt) { ensureLiveFullscreen(); liveFullscreen.setAvailable(true); }
        else if (liveFullscreen) liveFullscreen.setAvailable(false); // nothing live to follow any more
        syncPresence(!data.endedAt && !reviewing);
        syncStudentActivity();

        if (data.endedAt) {
            showLiveBanner(reviewing ? 'Last live session — showing your answers (read only)' : '🔴 Live Session Ended - Read Only', /* ended */ true);
            if (unsubLiveResponses) { unsubLiveResponses(); unsubLiveResponses = null; }
            // LIVE SESSION LOCKDOWN: re-render the slide that's on screen
            // RIGHT NOW so it locks immediately, the moment the teacher ends
            // the session — without this, a student already looking at an
            // interactive_prompt/collaborative_board slide would keep seeing
            // its live, writable form indefinitely (isSessionLive() only
            // gets re-checked inside renderSlideCanvas(), which nothing else
            // would otherwise call again until the student next navigates).
            // Skipped for Document format, which has no slide canvas to
            // re-render — the banner above is the only UI that format needs.
            // (also once for a session opened for review, so answers / correct answers show)
            if ((wasLive || endedPaintedFor !== liveSessionId) && lesson.format !== 'document') {
                endedPaintedFor = liveSessionId;
                renderSlideCanvas();
            }
            return;
        }

        if (!wasLive) showLiveBanner('Following your teacher live.');
        if (lesson.format === 'document') return; // no discrete position to follow

        const targetIndex = lesson.slides.findIndex(s => s.id === data.teacherPositionId);
        if (targetIndex >= 0 && targetIndex !== currentSlideIndex) {
            goToSlide(targetIndex, /* skipSave */ true); // don't clobber this student's own saved resume position with the teacher's live position
        } else if (!wasLive) {
            renderSlideCanvas(); // just went live: unlock this slide's answer forms
        } else {
            refreshWidgets(); // spotlight changes, etc.
        }
    });
}

function showLiveBanner(text, ended = false) {
    if (!els.lvLiveBanner) return;
    // Text goes into the inner <span>, not the banner element itself — the
    // banner also carries a static font-awesome icon as a sibling node,
    // which a direct .textContent assignment on the outer element would
    // silently wipe out.
    const label = els.lvLiveBanner.querySelector('span') || els.lvLiveBanner;
    label.textContent = text;
    els.lvLiveBanner.classList.remove('hidden');
    // Visually distinguish "still live, following the teacher" (green, the
    // original styling) from "session ended — read only" (rose) — this
    // banner is meant to be a persistent, impossible-to-miss lock notice
    // once the session ends, not just the same friendly "you're connected"
    // indicator with different words.
    els.lvLiveBanner.classList.toggle('text-emerald-300', !ended);
    els.lvLiveBanner.classList.toggle('text-rose-300', ended);
}

// Lazy iframe mount: called only when a video block's canvas node has just
// been inserted into the DOM as part of the CURRENT slide — never for an
// off-screen slide, and never twice for the same block (loadedMediaSlideIds
// is the guard, now keyed by block id since a single slide can hold more
// than one video block). This is what keeps a 20-slide deck with 20 video
// embeds from ever loading more than one iframe's worth of external
// network/JS at a time.
function mountLazyMediaFrame(frameEl) {
    if (!frameEl) return;
    const blockId = frameEl.dataset.blockId;
    if (!blockId || loadedMediaSlideIds.has(blockId)) return;
    const embedUrl = frameEl.dataset.embedUrl;
    if (!embedUrl) return; // placeholder already covers "no video yet"
    loadedMediaSlideIds.add(blockId);
    frameEl.innerHTML = `<iframe src="${escHtml(embedUrl)}" allowfullscreen loading="lazy"></iframe>`;
}

// ── 7. DOCUMENT FORMAT (Tiptap read-only + Table of Contents) ────────────
// The saved HTML is mounted with the teacher editor's own schema
// (document.js createDocumentViewer), on the same US Letter page, so every
// font, size, colour, spacing and block renders exactly as designed.
// Assignment cards get this page's live status pill (node view, refreshed
// by refreshDocumentEmbedStatuses()), videos are real players mounted as
// they scroll near, and activity cards are read-only until step 3e.
async function renderDocumentView() {
    els.lvDocView.classList.remove('hidden');
    els.lvDocView.classList.add('flex');
    els.lvSlideCount.classList.add('hidden');

    const block = lesson.slides[0] || { contentHtml: '' };
    try {
        docViewer = await createDocumentViewer({
            element: els.docViewerEditor,
            html: block.contentHtml || '',
            renderAssignment: (id, title) => buildAssignmentEmbedInnerHtml(id, title),
            lazyRoot: els.lvDocView,
            renderWidget: (dom, obj) => renderDocWidget(dom, obj),
        });
    } catch (e) {
        console.error('[Lesson Viewer] document viewer failed to load:', e);
        els.docViewerEditor.innerHTML = `<div class="bg-rose-50 border border-rose-200 rounded-xl p-4 text-[12.5px] font-bold text-rose-600">This lesson couldn't be displayed. Please reload the page.</div>`;
        return;
    }
    if (docViewer.isEmpty()) {
        els.docViewerEditor.insertAdjacentHTML('beforeend', '<p class="lv-doc-empty">This lesson has no content yet.</p>');
    }
    buildTableOfContents();

    // Progress persistence for Document format: since there's no discrete
    // slide index, the "resume position" is the last heading anchor the
    // student scrolled past, saved as its index in the heading list. On
    // load, jump straight there instead of always restarting at the top —
    // scoped per-lesson via the same localStorage key Slides format uses,
    // so the two formats never collide even if a lesson somehow changed
    // format after a student had already started it.
    let resumeHeadingIndex = -1;
    try {
        const saved = Number(localStorage.getItem(localStorageKey(lesson.id)));
        if (Number.isInteger(saved) && saved >= 0) resumeHeadingIndex = saved;
    } catch (e) {
        console.warn('[Lesson Viewer] Could not read saved document progress:', e);
    }
    const headings = docViewer.headings();
    if (resumeHeadingIndex >= 0 && headings[resumeHeadingIndex]) {
        // Deferred a tick so layout has settled before scrolling.
        requestAnimationFrame(() => headings[resumeHeadingIndex].scrollIntoView({ block: 'start' }));
    }

    let scrollSaveTimer = null;
    els.lvDocView.addEventListener('scroll', () => {
        updateProgressBar();
        // Debounced so scrolling doesn't hammer localStorage on every frame.
        clearTimeout(scrollSaveTimer);
        scrollSaveTimer = setTimeout(() => {
            const headingsNow = docViewer ? docViewer.headings() : [];
            let closestIndex = -1;
            headingsNow.forEach((h, i) => {
                if (h.getBoundingClientRect().top - els.lvDocView.getBoundingClientRect().top <= 80) closestIndex = i;
            });
            if (closestIndex >= 0) {
                try { localStorage.setItem(localStorageKey(lesson.id), String(closestIndex)); }
                catch (e) { /* private browsing — not fatal, resume just won't stick */ }
            }
        }, 400);
    });

    updateProgressBar();
}

// Re-renders the Document view's assignment status pills after a grade /
// submission may have changed (panel closed, or a submission just saved):
// each card is a node view built from buildAssignmentEmbedInnerHtml().
function refreshDocumentEmbedStatuses() {
    docViewer?.refreshAssignments();
}

function renderAssignmentEmbedHtml(linkedAssignmentId) {
    if (!linkedAssignmentId) {
        return `<div class="bg-slate-50 border border-dashed border-slate-200 rounded-xl p-4 text-[12.5px] text-slate-400 font-semibold">No assignment has been linked to this slide yet.</div>`;
    }
    const a = assignmentsById.get(linkedAssignmentId);
    const title = a?.title || 'Assignment';
    return `<span class="assignment-embed" data-assignment-id="${escHtml(linkedAssignmentId)}" data-assignment-title="${escHtml(title)}">${buildAssignmentEmbedInnerHtml(linkedAssignmentId, title)}</span>`;
}

function buildAssignmentEmbedInnerHtml(assignmentId, title) {
    const a = assignmentsById.get(assignmentId);
    if (!a) {
        // The embed points at an assignment this student's teacher-subjects
        // index didn't resolve (deleted since the lesson was written, or the
        // assignments/grades fetch in init() failed) — shown plainly rather
        // than silently pretending the card is clickable when it has nowhere
        // useful to send the student.
        return `<i class="fa-solid fa-clipboard-question"></i><span>${escHtml(title)}</span><span class="lv-embed-status" style="background:#f1f5f9;color:#64748b;">Unavailable</span>`;
    }
    // Only the graded/not-graded distinction is shown on the embed itself;
    // "submitted but not yet graded" vs. "not submitted at all" would need
    // a submission fetch per embed on page load, which openAssignmentPanel()
    // deliberately defers to open-time instead (see its own comment) — so
    // the embed's pill is coarser than the panel's own status by design.
    const grade = gradesById.get(assignmentId);
    const statusHtml = grade
        ? `<span class="lv-embed-status lv-status-done">Graded</span>`
        : `<span class="lv-embed-status lv-status-pending">Open</span>`;
    return `<i class="fa-solid fa-clipboard-check"></i><span>${escHtml(title)}</span>${statusHtml}`;
}

// ── 8. TABLE OF CONTENTS (Document format only) ──────────────────────────
function buildTableOfContents() {
    const headings = docViewer ? docViewer.headings() : [];
    if (!headings.length) {
        els.lvTocList.innerHTML = `<p class="text-[11.5px] text-slate-400 font-semibold">No headings in this document yet.</p>`;
        return;
    }
    // (headings are the viewer's own DOM: read, never modified)
    els.lvTocList.innerHTML = headings.map((h, i) => {
        const isSub = h.tagName === 'H2' || h.tagName === 'H3';
        return `<a class="lv-toc-link${isSub ? ' lv-toc-h2' : ''}" data-toc-index="${i}">${escHtml(h.textContent)}</a>`;
    }).join('');
    els.lvTocList.querySelectorAll('[data-toc-index]').forEach(link => {
        link.addEventListener('click', () => {
            headings[Number(link.dataset.tocIndex)].scrollIntoView({ behavior: 'smooth', block: 'start' });
        });
    });
}

// ── 9. EMBEDDED ASSIGNMENT → SUBMISSION PANEL ────────────────────────────
function onEmbeddedContentClick(e) {
    const embed = e.target.closest('.assignment-embed[data-assignment-id]');
    if (!embed) return;
    openAssignmentPanel(embed.getAttribute('data-assignment-id'));
}

async function openAssignmentPanel(assignmentId) {
    const a = assignmentsById.get(assignmentId);
    if (!a) {
        // Unresolved embed (see buildAssignmentEmbedInnerHtml) — nothing
        // to open a panel for, so this is a silent no-op rather than an
        // error state for the whole page.
        return;
    }
    currentPanelAssignmentId = assignmentId;

    els.lvAsgSubjectLabel.textContent = a.subjectName || '';
    els.lvAsgTitle.textContent = a.title || 'Assignment';

    const metaChips = [
        `<span class="text-[10px] font-black uppercase bg-indigo-50 text-indigo-600 border border-indigo-200 px-2 py-0.5 rounded-md">${escHtml(a.type || 'Assignment')}</span>`,
        `<span class="text-[10px] font-black text-slate-500 bg-slate-100 border border-slate-200 px-2 py-0.5 rounded-md">/ ${a.maxScore ?? '—'} pts</span>`
    ];
    if (a.date) metaChips.push(`<span class="text-[10.5px] text-slate-400 font-semibold"><i class="fa-regular fa-calendar mr-1"></i>Due ${escHtml(a.date)}</span>`);
    if (a.locked) metaChips.push(`<span class="text-[10px] font-black uppercase bg-amber-50 text-amber-600 border border-amber-200 px-2 py-0.5 rounded-md flex items-center gap-1"><i class="fa-solid fa-lock text-[9px]"></i>Locked</span>`);
    els.lvAsgMetaRow.innerHTML = metaChips.join('');

    els.lvAssignmentBody.innerHTML = `<div class="page-loader" style="padding:60px 20px;"><i class="fa-solid fa-circle-notch fa-spin"></i><p>Loading…</p></div>`;
    openOverlay('lvAssignmentOverlay', 'lvAssignmentInner', true);

    // The submission itself is fetched on open (not pre-fetched for every
    // embed on the page) — a lesson may embed several assignments, and
    // this keeps init() from paying for N submission reads before the
    // student has looked at any of them.
    try {
        const submission = await loadSubmission(session.schoolId, a, session.studentId);
        els.lvAssignmentBody.innerHTML = renderAssignmentPanelBody(a, submission);
        wireAssignmentPanelForm(a);
    } catch (e) {
        console.error('[Lesson Viewer] loadSubmission:', e);
        els.lvAssignmentBody.innerHTML = `<div class="bg-rose-50 border border-rose-200 rounded-xl p-4 text-[12.5px] font-bold text-rose-600">Couldn't load your submission. Please try again.</div>`;
    }
}

function closeAssignmentPanel() {
    closeOverlay('lvAssignmentOverlay', 'lvAssignmentInner', true);
    currentPanelAssignmentId = null;
    // Refresh the embed's status pill in whichever view is showing, in case
    // a submission/grade just changed — cheapest correct approach is simply
    // re-rendering the current view's content rather than diffing.
    if (lesson.format === 'document') {
        refreshDocumentEmbedStatuses();
    } else {
        renderSlideCanvas();
    }
}

// Mirrors student/assignments/assignments.js's renderDetailBody() almost
// exactly (same frozen-state copy, same field layout) so a student sees an
// identical submission experience whether they got here from the
// Assignments page or from inside a lesson — deliberately not shared as an
// imported function since the two pages' surrounding DOM (ids, overlay
// wiring) differ enough that forcing a shared renderer would need its own
// options-object indirection for little real benefit over keeping both
// small and readable.
function renderAssignmentPanelBody(a, submission) {
    const grade = gradesById.get(a.id);
    const frozen = isSubmissionFrozen(a, gradesById);

    const instructionsBlock = `
        <div>
            <p class="text-[11px] font-black text-slate-400 uppercase tracking-wider mb-1.5">Instructions</p>
            ${a.instructions
                ? `<div class="bg-white border border-slate-200 rounded-xl p-4 text-[13px] text-slate-700 whitespace-pre-wrap leading-relaxed">${escHtml(a.instructions)}</div>`
                : `<div class="bg-slate-50 border border-dashed border-slate-200 rounded-xl p-4 text-[12.5px] text-slate-400 font-semibold">No additional instructions were provided for this assignment.</div>`}
        </div>`;

    const gradeBlock = grade ? `
        <div class="bg-emerald-50 border border-emerald-200 rounded-xl p-4">
            <p class="text-[11px] font-black text-emerald-600 uppercase tracking-wider mb-1"><i class="fa-solid fa-circle-check mr-1"></i>Your Grade</p>
            <p class="text-2xl font-black text-emerald-700">${grade.score}<span class="text-base text-emerald-500">/${grade.max}</span></p>
            ${grade.notes ? `<p class="text-[12.5px] text-emerald-800 font-semibold mt-1 whitespace-pre-wrap">${escHtml(grade.notes)}</p>` : ''}
        </div>` : '';

    let submissionBlock;
    if (frozen) {
        const note = grade
            ? 'This assignment has been graded, so your submission is now locked.'
            : 'Your teacher has closed submissions for this assignment.';
        submissionBlock = `
        <div>
            <p class="text-[11px] font-black text-slate-400 uppercase tracking-wider mb-1.5">Your Submission</p>
            <div class="bg-amber-50 border border-amber-200 rounded-xl p-3 mb-3 text-[12px] font-bold text-amber-700 flex items-center gap-2">
                <i class="fa-solid fa-lock"></i> ${escHtml(note)}
            </div>
            ${submission
                ? `<div class="bg-white border border-slate-200 rounded-xl p-4 space-y-2">
                        ${submission.responseText ? `<p class="text-[13px] text-slate-700 whitespace-pre-wrap">${escHtml(submission.responseText)}</p>` : ''}
                        ${submission.linkUrl ? `<p class="text-[12.5px]"><a href="${escHtml(submission.linkUrl)}" target="_blank" rel="noopener" class="text-indigo-600 font-bold hover:underline"><i class="fa-solid fa-link mr-1"></i>${escHtml(submission.linkUrl)}</a></p>` : ''}
                        <p class="text-[10.5px] text-slate-400 font-semibold">Submitted ${escHtml(submission.submittedAt || '')}</p>
                   </div>`
                : `<div class="bg-slate-50 border border-dashed border-slate-200 rounded-xl p-4 text-[12.5px] text-slate-400 font-semibold">No submission was made.</div>`}
        </div>`;
    } else {
        submissionBlock = `
        <div>
            <p class="text-[11px] font-black text-slate-400 uppercase tracking-wider mb-1.5">Your Submission</p>
            <div class="mb-3">
                <label class="block text-[11px] font-black text-slate-500 uppercase tracking-wider mb-1.5">Response</label>
                <textarea id="lvResponseText" placeholder="Write your response here…"
                    class="form-input w-full p-3 bg-white border border-slate-200 rounded-xl text-sm resize-none leading-relaxed" style="height: 8rem;">${escHtml(submission?.responseText || '')}</textarea>
            </div>
            <div class="mb-3">
                <label class="block text-[11px] font-black text-slate-500 uppercase tracking-wider mb-1.5">Link <span class="normal-case font-semibold text-slate-400">(optional)</span></label>
                <input type="url" id="lvLinkUrl" placeholder="https://…" value="${escHtml(submission?.linkUrl || '')}"
                    class="form-input w-full p-2.5 bg-white border border-slate-200 rounded-xl text-sm">
            </div>
            <button id="lvSubmitBtn" class="w-full bg-gradient-to-r from-indigo-600 to-indigo-700 hover:from-indigo-700 hover:to-indigo-800 text-white font-black py-3 rounded-xl transition shadow-md text-sm flex items-center justify-center gap-2">
                <i class="fa-solid ${submission ? 'fa-rotate' : 'fa-paper-plane'}"></i> ${submission ? 'Update Submission' : 'Submit'}
            </button>
            ${submission ? `<p class="text-[10.5px] text-slate-400 font-semibold text-center mt-2">Last updated ${escHtml(submission.updatedAt || '')}</p>` : ''}
            <p id="lvSubMsg" class="text-sm hidden font-bold p-2.5 mt-2 rounded-xl text-center"></p>
        </div>`;
    }

    return instructionsBlock + gradeBlock + submissionBlock;
}

function wireAssignmentPanelForm(a) {
    const btn = document.getElementById('lvSubmitBtn');
    if (!btn) return; // frozen state has no form to wire

    btn.addEventListener('click', async () => {
        if (isSubmissionFrozen(a, gradesById)) return; // guard against a stale panel

        const responseText = document.getElementById('lvResponseText').value.trim();
        const linkUrl = document.getElementById('lvLinkUrl').value.trim();

        if (!responseText && !linkUrl) {
            showMsg('lvSubMsg', 'Add a response or a link before submitting.', true);
            return;
        }
        if (linkUrl && !/^https?:\/\//i.test(linkUrl)) {
            showMsg('lvSubMsg', 'Links must start with http:// or https://', true);
            return;
        }

        const prevHtml = btn.innerHTML;
        btn.innerHTML = '<i class="fa-solid fa-spinner fa-spin"></i> Saving…';
        btn.disabled = true;

        try {
            const studentName = session.studentData?.name || session.studentData?.fullName || '';
            const record = await saveSubmission(session.schoolId, a, session.studentId, studentName, { responseText, linkUrl });
            els.lvAssignmentBody.innerHTML = renderAssignmentPanelBody(a, record);
            wireAssignmentPanelForm(a);
            // Reflect the fresh submission status on whichever embed card
            // triggered this panel, without waiting for the panel to close.
            if (lesson.format === 'document') refreshDocumentEmbedStatuses();
            else renderSlideCanvas();
        } catch (e) {
            console.error('[Lesson Viewer] saveSubmission:', e);
            showMsg('lvSubMsg', 'Could not save your submission. Please try again.', true);
            btn.innerHTML = prevHtml;
            btn.disabled = false;
        }
    });
}

// ── PHASE 3: MEMORY LEAK GUARDRAIL ───────────────────────────────────────
// Every onSnapshot this page can open — joinLiveSession()'s session listener
// and registerBlockResponsesListener()'s per-block responses listener (which
// is also individually torn down and re-registered on every slide change;
// see renderSlideCanvas() above) — is unsubscribed here as the final safety
// net for whichever one is still live when the student actually leaves this
// page. Same cleanup contract as teacher/exams/live.js and this feature's
// own teacher-side dashboard (lessons/live.js).
// ── WORKSHEET ACTIVITIES (Document lessons) ──────────────────────────────
// Polls, quiz questions, open responses and sticky-note boards inside a
// document are answered whenever the student reads it — no live session.
// Answers: lessons/{id}/responses (lessons.js saveLessonResponse); quizzes are
// graded by submitLessonQuizAnswer without a session. One vote / attempt,
// open responses and notes can be updated; half-typed text is kept.
const docWidgets = new Map();   // objectId → { dom, obj }
const docAnswers = new Map();   // objectId → this student's saved answer
let docBoardNotes = [];
let unsubDocBoard = null;
let docWidgetsBound = false;
const docDrafts = {
    _key() { return lesson ? `gt-wdraft:${lesson.id}:doc` : null; },
    _read() { try { const k = this._key(); return k ? JSON.parse(sessionStorage.getItem(k) || '{}') : {}; } catch (e) { return {}; } },
    _write(o) { try { const k = this._key(); if (k) sessionStorage.setItem(k, JSON.stringify(o)); } catch (e) { /* storage off */ } },
    get(id) { const v = this._read()[id]; return typeof v === 'string' ? v : undefined; },
    set(id, text) { const o = this._read(); o[id] = String(text).slice(0, 4000); this._write(o); },
    delete(id) { const o = this._read(); delete o[id]; this._write(o); },
};

function docWidgetCtx(obj) {
    return {
        state: 'live', // worksheet: always open
        mine: docAnswers.get(obj.id) || null,
        responses: obj.type === 'board' ? docBoardNotes : [],
        spotlight: null,
        correctIds: [],
    };
}

function paintDocWidget(id) {
    const w = docWidgets.get(id);
    if (!w || !w.dom.isConnected) return;
    paintActivity(w.dom, w.obj, 'student', docWidgetCtx(w.obj));
    restoreWidgetDrafts(w.dom, docDrafts);
}

function renderDocWidget(dom, obj) {
    injectActivityCss();
    docWidgets.set(obj.id, { dom, obj });
    if (!docWidgetsBound && els.docViewerEditor) {
        docWidgetsBound = true;
        bindWidgetEvents(els.docViewerEditor, {
            drafts: docDrafts,
            getObject: (id) => (docWidgets.get(id) || {}).obj || null,
            onSubmit: submitDocWidget,
        });
    }
    // node views are created synchronously inside the editor; paint on the next tick
    setTimeout(() => paintDocWidget(obj.id), 0);
    if (!docAnswers.has(obj.id)) {
        loadMyLessonResponse(session.schoolId, postContext, lesson.id, session.studentId, obj.id)
            .then((r) => { if (r) { docAnswers.set(obj.id, r); paintDocWidget(obj.id); } });
    }
    if (obj.type === 'board' && !unsubDocBoard) {
        unsubDocBoard = subscribeToLessonBoardNotes(session.schoolId, postContext, lesson.id, (notes) => {
            docBoardNotes = notes;
            notes.filter(n => n.studentId === session.studentId).forEach(n => docAnswers.set(n.blockId, n));
            docWidgets.forEach((w, id) => { if (w.obj.type === 'board') paintDocWidget(id); });
        });
    }
}

async function submitDocWidget(obj, payload) {
    if (obj.type === 'quiz') {
        const res = await submitLessonQuizAnswer({
            schoolId: session.schoolId, classId: postContext.classId, subjectId: postContext.subjectId,
            lessonId: lesson.id, objectId: obj.id, choiceIds: payload.choiceIds,
        });
        docAnswers.set(obj.id, { choiceIds: Array.isArray(res.choiceIds) ? res.choiceIds : payload.choiceIds, correct: res.correct === true });
    } else {
        const studentName = session.studentData?.name || session.studentData?.fullName || '';
        const rec = await saveLessonResponse(session.schoolId, postContext, lesson.id, session.studentId, studentName, obj.id, obj.type, payload);
        docAnswers.set(obj.id, rec);
    }
    paintDocWidget(obj.id);
}

window.addEventListener('pagehide', () => {
    syncPresence(false);
    if (unsubDocBoard) { unsubDocBoard(); unsubDocBoard = null; }
    if (unsubActivityNotes) { unsubActivityNotes(); unsubActivityNotes = null; }
    if (unsubWidgetResponses) { unsubWidgetResponses(); unsubWidgetResponses = null; }
    if (unsubActiveSession) { unsubActiveSession(); unsubActiveSession = null; }
    if (unsubLiveSession) { unsubLiveSession(); unsubLiveSession = null; }
    if (unsubLiveResponses) { unsubLiveResponses(); unsubLiveResponses = null; }
});
// back/forward cache restore: the listeners above are gone, but the page is
// still on screen — put this student back on the roster
window.addEventListener('pageshow', (e) => {
    if (e.persisted && isSessionLive() && !reviewing) syncPresence(true);
});

init();
