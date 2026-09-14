// ── INTERACTIVE STUDENT LESSON VIEWER ─────────────────────────────────────
// Reads one lesson (Slides or Document format) and renders it read-only,
// with embedded assignments completable in place. Mirrors the Teacher
// Builder's rendering logic for each slide type / the Document's Quill
// content, but every control here is view-only — nothing in this file ever
// writes to a lesson document, and it never touches the lessons/{id}/private
// subcollection (pacingNotes/standards are teacher-only; firestore.rules
// denies students that path outright regardless of publish status — see
// firestore.rules' own comment on the lessons match block. This file simply
// never gives students a reason to try: it only ever reads the main lesson
// doc, gated by loadLesson()'s own status == 'published' requirement,
// enforced server-side).
import { db } from '../../../assets/js/firebase-init.js';
import { doc, getDoc } from "https://www.gstatic.com/firebasejs/10.7.1/firebase-firestore.js";
import { requireAuth } from '../../../assets/js/auth.js';
import { injectStudentLayout } from '../../../assets/js/layout-student.js';
import { loadTeacherSubjectsCache, getTeacherDocRef, openOverlay, closeOverlay, showMsg } from '../../../assets/js/utils.js';
import { resolvePostContext } from '../../../assets/js/posts.js';
import {
    loadSubmission,
    saveSubmission,
    loadGradesIndexForStudent,
    isSubmissionFrozen
} from '../../../assets/js/submissions.js';
import {
    getActiveLiveSession,
    subscribeToLiveSession,
    subscribeToLiveResponses,
    saveLiveResponse
} from '../../../assets/js/lessons.js';

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
let quillViewer = null;        // Document format's read-only Quill instance
let assignmentsById = new Map(); // linkedAssignmentId -> the real assignment record (for the submission panel)
let gradesById = new Map();      // assignmentId -> grade record | null
let currentPanelAssignmentId = null; // assignment currently open in the slide-in panel
let loadedMediaSlideIds = new Set(); // slide ids whose iframe has already been lazily inserted (Slides format)

// ── PHASE 3: LIVE SESSION ENGINE — student-side state ────────────────────
let liveSessionId = null;          // this lesson's currently-active live session, if any
let liveSessionData = null;        // { teacherPositionId, endedAt, ... } — last snapshot
let unsubLiveSession = null;       // subscribeToLiveSession()'s unsubscribe
let unsubLiveResponses = null;     // subscribeToLiveResponses()'s unsubscribe — re-registered per block, same as the teacher dashboard
let liveResponsesForCurrentBlock = []; // collaborative_board's shared wall for whichever block is on screen
let mySubmittedBlockIds = new Set(); // interactive_prompt/collaborative_board block ids this student has already answered this session (so a re-render doesn't blow away an in-progress unsent draft)

// ── LIVE SESSION LOCKDOWN: single source of truth for "is this session
// still accepting submissions right now" ─────────────────────────────────
// liveSessionId is set once at page load (init(), below) and NEVER cleared
// afterward — it stays truthy for the rest of the page's life even after
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

// ── ASSIGNMENT EMBED BLOT (read-only viewer) ─────────────────────────────
// Mirrors builder.js's registerAssignmentBlot() exactly. Quill's own
// DOM-to-Delta normalization pass (confirmed via diagnostic logging to run
// asynchronously, on the very next tick after any root.innerHTML mutation)
// only preserves elements it has a registered Blot for — anything else gets
// flattened to plain text on that pass, regardless of how the initial HTML
// was assembled. builder.js registers this Blot and never sees the embed
// get flattened; this file never registered it, which is the actual root
// cause of the flattening bug (building the HTML string before Quill saw it
// was necessary but not sufficient on its own). Registering it here, before
// the read-only Quill instance is constructed, is what's actually needed.
let assignmentBlotRegistered = false;

function registerAssignmentBlot() {
    if (assignmentBlotRegistered || !window.Quill) return;
    const Embed = Quill.import('blots/embed');

    class AssignmentBlot extends Embed {
        static create(value) {
            const node = super.create();
            node.setAttribute('contenteditable', 'false');
            node.setAttribute('data-assignment-id', value.id || '');
            node.setAttribute('data-assignment-title', value.title || '');
            node.innerHTML = buildAssignmentEmbedInnerHtml(value.id || '', value.title || 'Assignment');
            return node;
        }
        static value(node) {
            return {
                id: node.getAttribute('data-assignment-id') || '',
                title: node.getAttribute('data-assignment-title') || ''
            };
        }
    }
    AssignmentBlot.blotName = 'assignmentEmbed';
    AssignmentBlot.tagName = 'span';
    AssignmentBlot.className = 'assignment-embed';

    Quill.register(AssignmentBlot);
    assignmentBlotRegistered = true;
}

// ── 4. INITIALIZATION ───────────────────────────────────────────────────────
async function init() {
    if (!session) return;

    cacheEls();
    wireEvents();

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
        lesson = { id: snap.id, ...data, format: data.format === 'document' ? 'document' : 'slides' };
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
        try {
            const active = await getActiveLiveSession(session.schoolId, postContext, urlLessonId);
            if (active) {
                liveSessionId = active.id;
                joinLiveSession();
            }
        } catch (e) {
            console.error('[Lesson Viewer] Failed to check for an active live session:', e);
        }
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

    // Event delegation for assignment-embed clicks: both the Slide canvas
    // and the Quill document body re-render/re-parse their innerHTML
    // wholesale, so listeners are attached once at a stable ancestor rather
    // than re-wired after every render.
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

function renderSlideCanvas() {
    const slide = currentSlide();
    if (!slide) { els.lvSlideCanvas.innerHTML = ''; return; }

    const renderers = {
        title: renderTitleSlideHtml,
        content: renderContentSlideHtml,
        media: renderMediaSlideHtml,
        assignment: renderAssignmentSlideHtml,
        interactive_prompt: renderInteractivePromptHtml,
        collaborative_board: renderCollaborativeBoardHtml
    };
    els.lvSlideCanvas.innerHTML = (renderers[slide.type] || renderContentSlideHtml)(slide);

    // Lazy-load: a media slide's <iframe> is only ever inserted once this
    // exact slide becomes the active one (here, right after it's rendered
    // as the current slide) — see mountLazyMediaFrame() below. Re-visiting
    // an already-loaded slide does not reload the iframe (loadedMediaSlideIds
    // guards that), so a student paging back and forth doesn't restart video
    // playback on every pass.
    if (slide.type === 'media') mountLazyMediaFrame(slide, els.lvSlideCanvas.querySelector('[data-lazy-media]'));

    // ── PHASE 3: live-response wiring for the two interactive block types.
    // Only meaningful while the session is ACTIVELY live — isSessionLive()
    // (not the bare liveSessionId, which stays truthy after the session
    // ends) gates this so a submit button is never wired once the session
    // is over. The two render functions below only emit a submit button/
    // textarea/choice buttons in the first place when isSessionLive() is
    // true, so this stays in sync with what's actually on screen — outside
    // that, these blocks render either their read-only "session ended"
    // state or their static "no live session" prompt text.
    if (isSessionLive() && (slide.type === 'interactive_prompt' || slide.type === 'collaborative_board')) {
        wireLiveBlockForm(slide);
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

function renderTitleSlideHtml(slide) {
    return `
    <div class="lv-slide-card items-center text-center">
        <p class="text-[11px] font-black text-indigo-400 uppercase tracking-widest mb-3">${escHtml(slide.subheading || '')}</p>
        <h2 class="text-2xl md:text-3xl font-black text-slate-800 leading-tight mb-4">${escHtml(slide.heading) || 'Untitled Slide'}</h2>
        ${slide.objective ? `<p class="text-[14px] text-slate-500 font-semibold max-w-md mx-auto leading-relaxed">${escHtml(slide.objective)}</p>` : ''}
    </div>`;
}

function renderContentSlideHtml(slide) {
    return `
    <div class="lv-slide-card">
        ${slide.heading ? `<h2 class="text-xl md:text-2xl font-black text-slate-800 mb-4">${escHtml(slide.heading)}</h2>` : ''}
        <p class="text-[14.5px] text-slate-600 leading-relaxed whitespace-pre-wrap m-0">${escHtml(slide.body)}</p>
    </div>`;
}

function renderMediaSlideHtml(slide) {
    const isImage = slide.mediaKind === 'image';
    return `
    <div class="lv-slide-card">
        ${slide.heading ? `<h2 class="text-lg md:text-xl font-black text-slate-800 mb-4">${escHtml(slide.heading)}</h2>` : ''}
        ${isImage
            ? (slide.imageUrl
                ? `<img src="${escHtml(slide.imageUrl)}" alt="${escHtml(slide.imageAlt)}" class="w-full max-h-[420px] object-contain rounded-xl bg-slate-50 border border-slate-200"
                       onerror="this.outerHTML = '<div class=\\'lv-media-frame\\'><div class=\\'lv-media-placeholder\\'><p class=\\'text-[12.5px] font-semibold\\'>This image couldn\\'t be loaded.</p></div></div>'">`
                : `<div class="lv-media-frame"><div class="lv-media-placeholder"><p class="text-[12.5px] font-semibold">No image was added to this slide.</p></div></div>`)
            : `<div class="lv-media-frame" data-lazy-media data-embed-url="${escHtml(slide.embedUrl || '')}"><div class="lv-media-placeholder"><i class="fa-solid fa-circle-play text-3xl"></i></div></div>`}
        ${slide.caption ? `<p class="text-[12px] text-slate-400 font-semibold mt-3 text-center">${escHtml(slide.caption)}</p>` : ''}
    </div>`;
}

function renderAssignmentSlideHtml(slide) {
    return `
    <div class="lv-slide-card">
        ${slide.heading ? `<h2 class="text-lg md:text-xl font-black text-slate-800 mb-3">${escHtml(slide.heading)}</h2>` : ''}
        ${slide.prompt ? `<p class="text-[13.5px] text-slate-600 leading-relaxed whitespace-pre-wrap mb-5">${escHtml(slide.prompt)}</p>` : ''}
        ${renderAssignmentEmbedHtml(slide.linkedAssignmentId)}
    </div>`;
}

// ── PHASE 3: LIVE SESSION ENGINE — interactive block rendering ──────────
// Both block types render their prompt text unconditionally (a teacher
// paging through the deck outside a live session, or a student opening the
// lesson later for review, should still see what was asked). The
// submission form itself has THREE possible states, not two:
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
function renderInteractivePromptHtml(slide) {
    const alreadySubmitted = mySubmittedBlockIds.has(slide.id);
    const sessionEnded = !!(liveSessionId && liveSessionData && liveSessionData.endedAt);
    return `
    <div class="lv-slide-card">
        <span class="lv-live-badge"><i class="fa-solid fa-bolt"></i> Live Prompt</span>
        ${slide.heading ? `<h2 class="text-lg md:text-xl font-black text-slate-800 mt-3 mb-3">${escHtml(slide.heading)}</h2>` : ''}
        <p class="text-[14px] text-slate-700 font-semibold leading-relaxed mb-4">${escHtml(slide.promptText) || 'No prompt text set.'}</p>
        ${isSessionLive() ? `
            <div id="lvLiveFormWrap">
                ${slide.promptKind === 'multiple_choice' && (slide.choices || []).length
                    ? `<div class="space-y-2 mb-3">${slide.choices.map((c, i) => `
                        <button type="button" data-live-choice="${escHtml(c)}" class="lv-choice-btn w-full text-left px-3.5 py-2.5 rounded-xl border border-slate-200 hover:border-indigo-400 hover:bg-indigo-50 font-semibold text-[13px] text-slate-700 transition">${escHtml(c)}</button>`).join('')}</div>`
                    : `<textarea id="lvLiveAnswerText" placeholder="Type your answer…" class="form-input w-full p-3 bg-white border border-slate-200 rounded-xl text-sm resize-none leading-relaxed mb-3" style="height:6rem;"></textarea>
                       <button id="lvLiveSubmitBtn" class="bg-gradient-to-r from-indigo-600 to-indigo-700 hover:from-indigo-700 hover:to-indigo-800 text-white font-black py-2.5 px-5 rounded-xl transition shadow-md text-sm"><i class="fa-solid fa-paper-plane mr-1"></i> Submit</button>`}
                <p id="lvLiveMsg" class="text-[12px] font-bold mt-2 hidden"></p>
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
    <div class="lv-slide-card">
        <span class="lv-live-badge lv-live-badge-board"><i class="fa-solid fa-people-group"></i> Collaborative Board</span>
        ${slide.heading ? `<h2 class="text-lg md:text-xl font-black text-slate-800 mt-3 mb-3">${escHtml(slide.heading)}</h2>` : ''}
        ${slide.instructions ? `<p class="text-[13.5px] text-slate-600 leading-relaxed whitespace-pre-wrap mb-4">${escHtml(slide.instructions)}</p>` : ''}
        ${isSessionLive() ? `
            <div id="lvLiveFormWrap" class="mb-4">
                <textarea id="lvLiveAnswerText" placeholder="Add your card…" class="form-input w-full p-3 bg-white border border-slate-200 rounded-xl text-sm resize-none leading-relaxed mb-3" style="height:4.5rem;"></textarea>
                <button id="lvLiveSubmitBtn" class="bg-gradient-to-r from-indigo-600 to-indigo-700 hover:from-indigo-700 hover:to-indigo-800 text-white font-black py-2.5 px-5 rounded-xl transition shadow-md text-sm"><i class="fa-solid fa-plus mr-1"></i> ${alreadySubmitted ? 'Update My Card' : 'Add My Card'}</button>
                <p id="lvLiveMsg" class="text-[12px] font-bold mt-2 hidden"></p>
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
// choice button) for whichever interactive block is currently on screen.
// Re-called every renderSlideCanvas(), so no stale listener from a previous
// slide's form can fire against the wrong block.
function wireLiveBlockForm(slide) {
    const submitBtn = document.getElementById('lvLiveSubmitBtn');
    if (submitBtn) {
        submitBtn.addEventListener('click', () => submitLiveResponse(slide, document.getElementById('lvLiveAnswerText')?.value || ''));
    }
    document.querySelectorAll('[data-live-choice]').forEach(btn => {
        btn.addEventListener('click', () => submitLiveResponse(slide, btn.dataset.liveChoice));
    });
}

async function submitLiveResponse(slide, answerText) {
    const text = (answerText || '').trim();
    if (!text) {
        const msg = document.getElementById('lvLiveMsg');
        if (msg) { msg.textContent = 'Write an answer before submitting.'; msg.className = 'text-[12px] font-bold mt-2 text-rose-600'; msg.classList.remove('hidden'); }
        return;
    }
    const btn = document.getElementById('lvLiveSubmitBtn');
    if (btn) { btn.disabled = true; btn.innerHTML = '<i class="fa-solid fa-spinner fa-spin"></i>'; }

    try {
        const studentName = session.studentData?.name || '';
        await saveLiveResponse(session.schoolId, postContext, lesson.id, liveSessionId, session.studentId, studentName, slide.id, slide.type, { answerText: text });
        mySubmittedBlockIds.add(slide.id);
        const msg = document.getElementById('lvLiveMsg');
        if (msg) { msg.textContent = 'Submitted!'; msg.className = 'text-[12px] font-bold mt-2 text-emerald-600'; msg.classList.remove('hidden'); }
        const textarea = document.getElementById('lvLiveAnswerText');
        if (slide.type === 'collaborative_board' && textarea) textarea.value = ''; // board keeps accepting new/updated cards; prompt is one-and-done
        if (btn) { btn.disabled = false; btn.innerHTML = slide.type === 'collaborative_board' ? '<i class="fa-solid fa-plus mr-1"></i> Update My Card' : '<i class="fa-solid fa-paper-plane mr-1"></i> Submit'; }
    } catch (e) {
        console.error('[Lesson Viewer] submitLiveResponse:', e);
        const msg = document.getElementById('lvLiveMsg');
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

// ── PHASE 3: JOIN A LIVE SESSION + AUTO-FOLLOW ───────────────────────────
// Subscribes to the session doc itself. Every time teacherPositionId
// changes, this student's screen jumps to match — Slides format navigates
// straight to that block's index; Document format (a single richtext block,
// no discrete positions) has nothing to auto-follow to, so this is a no-op
// there beyond the "session ended" banner, which still applies to both
// formats.
function joinLiveSession() {
    unsubLiveSession = subscribeToLiveSession(session.schoolId, postContext, lesson.id, liveSessionId, (data) => {
        const wasLive = isSessionLive();
        liveSessionData = data;

        if (data.endedAt) {
            showLiveBanner('🔴 Live Session Ended - Read Only', /* ended */ true);
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
            if (wasLive && lesson.format !== 'document') renderSlideCanvas();
            return;
        }

        if (lesson.format === 'document') return; // no discrete position to follow

        const targetIndex = lesson.slides.findIndex(s => s.id === data.teacherPositionId);
        if (targetIndex >= 0 && targetIndex !== currentSlideIndex) {
            goToSlide(targetIndex, /* skipSave */ true); // don't clobber this student's own saved resume position with the teacher's live position
        }
    });
    showLiveBanner('Following your teacher live.');
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

// Lazy iframe mount: called only when a media slide's canvas node has just
// been inserted into the DOM as the CURRENT slide — never for an off-screen
// slide, and never twice for the same slide (loadedMediaSlideIds is the
// guard). This is what keeps a 20-slide deck with 20 video embeds from ever
// loading more than one iframe's worth of external network/JS at a time.
function mountLazyMediaFrame(slide, frameEl) {
    if (!frameEl || loadedMediaSlideIds.has(slide.id)) return;
    if (!slide.embedUrl) return; // placeholder already covers "no video yet"
    loadedMediaSlideIds.add(slide.id);
    frameEl.innerHTML = `<iframe src="${escHtml(slide.embedUrl)}" allowfullscreen loading="lazy"></iframe>`;
}

// ── 7. DOCUMENT FORMAT (Quill read-only + Table of Contents) ─────────────
function renderDocumentView() {
    els.lvDocView.classList.remove('hidden');
    els.lvDocView.classList.add('flex');
    els.lvSlideCount.classList.add('hidden');

    const block = lesson.slides[0] || { contentHtml: '' };

    // MUST happen before `new Quill(...)` below — Quill's async DOM
    // normalization pass only preserves elements it has a registered Blot
    // for (see registerAssignmentBlot() above for why).
    registerAssignmentBlot();

    quillViewer = new Quill(els.docViewerEditor, {
        theme: 'snow',
        readOnly: true,
        modules: { toolbar: false }
    });
    // The embed's live status pill is baked into the HTML string BEFORE it
    // ever reaches Quill's root — not patched onto the embed node afterward.
    // Quill wires up its own MutationObserver the moment it's constructed;
    // mutating a child of an already-mounted node later (as the old
    // reviveAssignmentEmbeds() did, via node.innerHTML =) gave that
    // observer a change to react to. Building the finished string first AND
    // having a registered Blot for assignment-embed together are what keep
    // Quill's own DOM-to-Delta normalization from collapsing it to plain
    // text on the next tick.
    quillViewer.root.innerHTML = reviveAssignmentEmbedsHtml(block.contentHtml || '');
    // Quill's read-only mode still leaves its root contenteditable="false"
    // wrapper focusable/selectable for text — that's fine and expected
    // (students can still select/copy text); only the assignment embed
    // itself is ever behaviorally special, via the click delegation wired
    // in wireEvents() rather than anything Quill-specific here.
    lazifyDocumentMedia();
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
    const headings = els.docViewerEditor.querySelectorAll('h1, h2, h3');
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
            const headingsNow = els.docViewerEditor.querySelectorAll('h1, h2, h3');
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

// Quill's saved HTML for an assignmentEmbed node is exactly what
// AssignmentBlot.create() produced in the Teacher Builder — a
// contenteditable="false" span carrying data-assignment-id/
// data-assignment-title, with static clipboard-icon + title markup inside.
// That markup already looks right; this just re-marks each one as
// clickable in this read-only context and layers a live submission-status
// pill on top (Submitted/Not submitted), which the teacher-side editable
// version never shows since a teacher has no submission of their own.
//
// Operates on the raw HTML STRING, via a detached <template> (never
// attached to the document, never touched by Quill) — not on the live
// nodes inside quillViewer.root. Quill wires a MutationObserver onto its
// root the moment it's constructed; patching an embed node's innerHTML
// after that (the previous approach) gave that observer a live mutation
// to react to, and Quill's DOM-to-Delta normalization doesn't know what
// an assignment-embed span is, so it flattened it to plain text. Building
// the finished string here and handing Quill fully-formed content exactly
// once (see renderDocumentView()) avoids that entirely.
function reviveAssignmentEmbedsHtml(html) {
    const template = document.createElement('template');
    template.innerHTML = html;
    template.content.querySelectorAll('.assignment-embed[data-assignment-id]').forEach(node => {
        const assignmentId = node.getAttribute('data-assignment-id');
        const title = node.getAttribute('data-assignment-title') || 'Assignment';
        node.innerHTML = buildAssignmentEmbedInnerHtml(assignmentId, title);
    });
    return template.innerHTML;
}

// Re-renders the Document view's embed status pills after a grade/submission
// may have changed (panel closed, or a submission just saved). Always
// rebuilds from lesson.slides[0].contentHtml — the untouched, originally
// saved string — rather than patching whatever's currently live in
// quillViewer.root, for the same reason renderDocumentView() builds the
// full string before ever handing it to Quill: patching an embed node's
// innerHTML on an already-mounted Quill root is what caused the embed to
// get flattened to plain text in the first place (Quill's own DOM
// normalization reacts to that live mutation and doesn't recognize the
// assignment-embed span). One full, pre-built reassignment sidesteps that.
function refreshDocumentEmbedStatuses() {
    if (!quillViewer) return;
    const block = lesson.slides[0] || { contentHtml: '' };
    quillViewer.root.innerHTML = reviveAssignmentEmbedsHtml(block.contentHtml || '');
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

// Lazy-load for Document format's own media: any <iframe> present in saved
// Quill HTML (a student never sees an <iframe> in the *editor* — Quill's
// ql-video embed produces one on save) is stripped of its live src at
// render time and wrapped in the same lazy-mount pattern the Slide Deck
// uses, keyed to actual viewport visibility via IntersectionObserver rather
// than "current slide" (Document format has no discrete slide concept —
// visibility on scroll is the equivalent signal).
function lazifyDocumentMedia() {
    const iframes = els.docViewerEditor.querySelectorAll('iframe');
    if (!iframes.length) return;

    const observer = new IntersectionObserver((entries) => {
        entries.forEach(entry => {
            if (!entry.isIntersecting) return;
            const wrapper = entry.target;
            const src = wrapper.getAttribute('data-src');
            if (src && !wrapper.querySelector('iframe')) {
                wrapper.innerHTML = `<iframe src="${escHtml(src)}" allowfullscreen loading="lazy"></iframe>`;
            }
            observer.unobserve(wrapper);
        });
    }, { root: els.lvDocView, rootMargin: '200px' });

    iframes.forEach(iframe => {
        const src = iframe.src;
        const wrapper = document.createElement('div');
        wrapper.className = 'lv-lazy-media';
        wrapper.setAttribute('data-src', src);
        iframe.replaceWith(wrapper);
        observer.observe(wrapper);
    });
}

// ── 8. TABLE OF CONTENTS (Document format only) ──────────────────────────
function buildTableOfContents() {
    const headings = [...els.docViewerEditor.querySelectorAll('h1, h2, h3')];
    if (!headings.length) {
        els.lvTocList.innerHTML = `<p class="text-[11.5px] text-slate-400 font-semibold">No headings in this document yet.</p>`;
        return;
    }
    els.lvTocList.innerHTML = headings.map((h, i) => {
        h.id = h.id || `lv-heading-${i}`;
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
            const studentName = session.studentData?.name || '';
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
window.addEventListener('pagehide', () => {
    if (unsubLiveSession) { unsubLiveSession(); unsubLiveSession = null; }
    if (unsubLiveResponses) { unsubLiveResponses(); unsubLiveResponses = null; }
});

init();
