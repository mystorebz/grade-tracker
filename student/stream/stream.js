// ── PHASE 1 MILESTONE 2: CLASS STREAM (student) — Module 3: live, paginated,
//    semester-scoped feed with inline comments. Students comment; they never
//    create top-level posts (firestore.rules enforces both). ───────────────
import { getDoc } from "https://www.gstatic.com/firebasejs/10.7.1/firebase-firestore.js";
import { requireAuth } from '../../assets/js/auth.js';
import { injectStudentLayout } from '../../assets/js/layout-student.js';
import { loadTeacherSubjectsCache, getTeacherDocRef, loadSchoolHeaderInfo } from '../../assets/js/utils.js';
import { resolvePostContext, createPostFeed, resolveActiveTermWindow, displayPostText, lessonViewerUrl } from '../../assets/js/posts.js';
import { injectCommentCss, commentsSectionHtml, commentPillHtml, renderPreservingDrafts, handleCommentEvent } from '../../assets/js/stream-comments.js';
import { discussionUrl, focusPostFromUrl, openPostFromCardClick } from '../../assets/js/stream-discussion.js';
import { injectPollCss, pollHtml, handlePollEvent } from '../../assets/js/stream-polls.js';
import { watchAnswers, answersView, isAnswerHiddenForStudent, studentHasAnswered, stopAllAnswerWatches } from '../../assets/js/stream-answers.js';
import { loadPublishedLessonsForSubject } from '../../assets/js/lessons.js';
import { reportStreamActivity, cacheStreamContexts } from '../../assets/js/stream-badge.js';

// ── 1. AUTHENTICATION & LAYOUT ──────────────────────────────────────────────
const session = requireAuth('student', '../login.html');
if (session) {
    injectStudentLayout('stream', 'Class Stream', 'Announcements and lesson plans from your teacher');
}

// ── 2. STATE ──────────────────────────────────────────────────────────────
let postsCache = [];           // every post across every one of this student's subjects
let currentView = 'stream';    // 'stream' | 'lessonPlans'
let currentSubjectFilter = ''; // '' = All Subjects, else a subjectId
// Lesson Plans view: the PUBLISHED lessons of this student's subjects
// (read once, on first open of that view), plus any legacy lesson_plan posts.
let lessonsCache = null;       // null = not loaded yet
let lessonsLoading = false;
let streamContexts = [];

// Live posts subscription teardown (set once init() opens it). MUST be
// called when this page is left so the onSnapshot listeners it holds don't
// keep running — and billing reads — after the student navigates away.
let postFeed = null;
let feedHasMore = false;
let termWindow = { semesterId: null, sinceIso: null, semesterName: '' };

function teardownPostsSubscription() {
    if (postFeed) {
        postFeed.stop();
        postFeed = null;
    }
}

// Multi-page site (real <a href> navigation, no SPA router), so the normal
// case is just the browser tearing down the whole page — but pagehide fires
// reliably for that (including back/forward-cache navigations, unlike
// beforeunload) and costs nothing to also call explicitly on the logout
// button below, so both paths are covered.
window.addEventListener('pagehide', teardownPostsSubscription);
window.addEventListener('pagehide', stopAllAnswerWatches);

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

function formatDate(iso) {
    if (!iso) return '';
    try {
        // Date-only strings (YYYY-MM-DD, used for lessonDate) must be parsed as
        // local calendar components — new Date('YYYY-MM-DD') parses as UTC
        // midnight, which renders a day early in any timezone behind UTC.
        const d = /^\d{4}-\d{2}-\d{2}$/.test(iso)
            ? new Date(Number(iso.slice(0, 4)), Number(iso.slice(5, 7)) - 1, Number(iso.slice(8, 10)))
            : new Date(iso);
        return d.toLocaleDateString(undefined, { month: 'short', day: 'numeric', year: 'numeric' });
    } catch (e) { return iso; }
}

// ── 3. TOGGLE-BUTTON HELPER ──────────────────────────────────────────────
function setToggleActive(activeBtn, allBtnsInGroup) {
    allBtnsInGroup.forEach(btn => btn.classList.toggle('cs-active', btn === activeBtn));
}

// ── 4. INITIALIZATION ───────────────────────────────────────────────────────
async function init() {
    if (!session) return;

    cacheEls();
    wireEvents();
    injectCommentCss();
    injectPollCss();
    setView('stream');

    // The sidebar/topbar ship with static "Loading..." placeholders for the
    // school name and active period — injectStudentLayout() only has the
    // student's own cached session data to render immediately, so the
    // school name (and semester name) need their own fetch, exactly like
    // every other student page already does (this page just never gained
    // one). Fire-and-forget: it paints the header whenever it resolves,
    // independent of the posts fetch below.
    loadSchoolHeaderInfo(session.schoolId).then(({ schoolName, semesterName }) => {
        const schoolEl = document.getElementById('displaySchoolName');
        const semEl = document.getElementById('activeSemesterDisplay');
        if (schoolEl) schoolEl.textContent = schoolName;
        if (semEl) semEl.textContent = semesterName;
    });

    const teacherId = session.studentData?.teacherId;
    if (!teacherId) {
        showEmptyState("You don't have a teacher assigned yet — check back once you're enrolled in a class.");
        return;
    }

    try {
        // Same resolution path the teacher's own Stream page uses for itself —
        // this is what guarantees a student only ever sees posts belonging to
        // their own teacher's subjects: every query below is built from this
        // student's own session.studentData.teacherId, never any other class's.
        const teacherSnap = await getDoc(getTeacherDocRef(session.schoolId, teacherId));
        const legacyTeacherData = teacherSnap.exists() ? teacherSnap.data() : null;

        const [{ subjectsCache, resolvedClasses }, term] = await Promise.all([
            loadTeacherSubjectsCache(session.schoolId, teacherId, legacyTeacherData),
            resolveActiveTermWindow(session.schoolId),
        ]);
        termWindow = term;
        const activeSubjects = subjectsCache.filter(s => !s.archived);

        const postContexts = activeSubjects
            .map(s => resolvePostContext(s, resolvedClasses))
            .filter(Boolean);

        streamContexts = postContexts;
        cacheStreamContexts(postContexts); // sidebar badge: subjects for the cross-page check
        renderSubjectFilterOptions(postContexts);
        if (currentView === 'lessonPlans') loadLessonsOnce();

        if (!postContexts.length) {
            showEmptyState("Your teacher hasn't set up any subjects yet.");
            return;
        }

        // Live subscription: any post the teacher adds, edits, pins, or
        // deletes across these subjects re-renders this list automatically,
        // with no page reload — this is what makes Class Stream update the
        // moment a teacher posts, instead of only on next visit.
        // Module 3: per subject, the newest 20 posts of the active term are
        // live (plus pinned); older ones load on demand.
        teardownPostsSubscription(); // guard against a stray double-init
        postFeed = createPostFeed(session.schoolId, postContexts, {
            sinceIso: termWindow.sinceIso,
            onChange: (merged, { hasMore, ready }) => {
                postsCache = merged;
                feedHasMore = hasMore;
                if (!ready) return;
                reportStreamActivity(merged); // sidebar badge
                els.streamLoader.classList.add('hidden');
                els.postListCount.classList.remove('hidden');
                renderPostList();
            },
        });
    } catch (e) {
        console.error('[Student Stream] init:', e);
        showEmptyState('Something went wrong loading your class stream. Please try again later.');
    }
}

function cacheEls() {
    ['subjectFilter', 'viewStreamBtn', 'viewLessonPlansBtn',
     'streamLoader', 'postListCount', 'postList', 'loadOlderBtn'
    ].forEach(id => { els[id] = document.getElementById(id); });
}

function wireEvents() {
    els.subjectFilter.addEventListener('change', () => {
        currentSubjectFilter = els.subjectFilter.value;
        renderPostList();
    });
    els.viewStreamBtn.addEventListener('click', () => setView('stream'));
    els.viewLessonPlansBtn.addEventListener('click', () => setView('lessonPlans'));
    els.postList.addEventListener('click', async (e) => {
        if (openPostFromCardClick(e)) return; // card body → full post page
        if (await handlePollEvent(e, {
            schoolId: session.schoolId,
            findPost: (id) => postsCache.find(p => p.id === id) || null,
            voter: { studentId: session.studentId, name: session.studentData?.name || 'Student' },
        })) return;
        handleCommentEvent(e, commentCfg());
    });
    els.postList.addEventListener('keydown', (e) => handleCommentEvent(e, commentCfg()));
    els.loadOlderBtn.addEventListener('click', async () => {
        if (!postFeed) return;
        const label = els.loadOlderBtn.querySelector('span');
        els.loadOlderBtn.disabled = true;
        label.textContent = 'Loading…';
        try { await postFeed.loadOlder(); } finally {
            els.loadOlderBtn.disabled = false;
            label.textContent = 'Load Older Announcements';
        }
    });
}

function commentCfg() {
    return {
        schoolId: session.schoolId,
        findPost: (id) => postsCache.find(p => p.id === id) || null,
        author: { authorId: session.studentId, authorName: session.studentData?.name || 'Student', role: 'student' },
        rerender: renderPostList,
        onPatched: (postId, comments) => postFeed && postFeed.patchLocal(postId, { comments }),
    };
}

function showEmptyState(message) {
    els.streamLoader.classList.add('hidden');
    els.postListCount.classList.add('hidden');
    els.postList.innerHTML = `<div class="text-center py-10 text-slate-400 text-[13px] font-bold bg-white rounded-xl border border-slate-200">${escHtml(message)}</div>`;
}

// ── 5. SUBJECT FILTER ────────────────────────────────────────────────────
function renderSubjectFilterOptions(postContexts) {
    const options = ['<option value="">All Subjects</option>']
        .concat(postContexts.map(ctx => `<option value="${escHtml(ctx.subjectId)}">${escHtml(ctx.subjectName)}</option>`));
    els.subjectFilter.innerHTML = options.join('');
}

// ── 6. VIEW TOGGLE (Stream vs. Lesson Plans) ────────────────────────────────
function setView(view) {
    currentView = view;
    if (view === 'lessonPlans') loadLessonsOnce();
    setToggleActive(view === 'stream' ? els.viewStreamBtn : els.viewLessonPlansBtn, [els.viewStreamBtn, els.viewLessonPlansBtn]);
    renderPostList();
}

async function loadLessonsOnce() {
    if (lessonsCache || lessonsLoading || !streamContexts.length) return;
    lessonsLoading = true;
    renderPostList();
    try {
        const per = await Promise.all(streamContexts.map(ctx => loadPublishedLessonsForSubject(session.schoolId, ctx)
            .then(list => list.map(l => ({ ...l, _ctx: ctx })))
            .catch(e => { console.error('[Student Stream] lessons for', ctx.subjectId, e); return []; })));
        lessonsCache = per.flat();
    } finally {
        lessonsLoading = false;
        renderPostList();
    }
}

// ── 7. POST LIST ─────────────────────────────────────────────────────────
function getVisiblePosts() {
    let posts = postsCache;
    if (currentSubjectFilter) {
        posts = posts.filter(p => p.subjectId === currentSubjectFilter);
    }

    if (currentView === 'lessonPlans') {
        // published lessons (newest first), then any legacy lesson-plan posts
        const lessons = (lessonsCache || [])
            .filter(l => !currentSubjectFilter || l._ctx.subjectId === currentSubjectFilter)
            .map(l => ({ ...l, _kind: 'lesson' }))
            .sort((a, b) => new Date(b.publishedAt || b.createdAt || 0) - new Date(a.publishedAt || a.createdAt || 0));
        return lessons.concat(posts
            .filter(p => p.type === 'lesson_plan')
            .sort((a, b) => {
                if (!a.lessonDate && !b.lessonDate) return 0;
                if (!a.lessonDate) return 1;
                if (!b.lessonDate) return -1;
                return a.lessonDate.localeCompare(b.lessonDate);
            }));
    }
    // Stream view: pinned first (preserving newest-first order within each group)
    const pinned = posts.filter(p => p.pinned);
    const rest = posts.filter(p => !p.pinned);
    return [...pinned, ...rest];
}

function renderPostList() {
    if (!els.postListCount) return;
    const posts = getVisiblePosts();
    const label = currentView === 'lessonPlans' ? 'lesson' : 'post';
    if (els.loadOlderBtn) els.loadOlderBtn.classList.toggle('hidden', !(feedHasMore && currentView === 'stream'));
    els.postListCount.textContent = `${posts.length} ${label}${posts.length === 1 ? '' : 's'}`;
    if (currentView === 'lessonPlans' && lessonsLoading && !posts.length) {
        els.postList.innerHTML = `<div class="text-center py-10 text-slate-400 text-[13px] font-bold bg-white rounded-xl border border-slate-200"><i class="fa-solid fa-circle-notch fa-spin mr-2"></i>Loading lessons…</div>`;
        return;
    }

    if (!posts.length) {
        els.postList.innerHTML = `<div class="text-center py-10 text-slate-400 text-[13px] font-bold bg-white rounded-xl border border-slate-200">
            No ${label}s yet${currentSubjectFilter ? ' for this subject' : ''}.
        </div>`;
        return;
    }

    renderPreservingDrafts(els.postList, () => {
        els.postList.innerHTML = posts.map(p => (p._kind === 'lesson' ? renderLessonCard(p) : renderPostCard(p))).join('');
    });
    focusPostFromUrl(els.postList);
}

// A post created by Lesson Builder's "Publish" action (see publishLesson()
// in assets/js/lessons.js) carries linkedLessonId, patched on right after
// createPost() — plus classId/subjectId, already denormalized onto every
// post by createPost() itself. That's everything the viewer's URL needs;
// no extra fetch required just to build the link.
function renderLessonCard(l) {
    const ctx = l._ctx;
    const url = `../lessons/view.html?${new URLSearchParams({ lessonId: l.id, classId: ctx.classId, subjectId: ctx.subjectId, subjectName: ctx.subjectName || '' }).toString()}`;
    const isDoc = l.format === 'document';
    const slides = !isDoc && l.slideCount ? `${l.slideCount} slide${l.slideCount === 1 ? '' : 's'}` : '';
    return `
    <div class="bg-white rounded-xl shadow-sm border border-slate-200 p-4">
        <div class="flex items-start gap-3">
            <div class="w-8 h-8 rounded-lg bg-amber-50 text-amber-700 border-amber-200 border flex items-center justify-center flex-shrink-0 mt-0.5">
                <i class="fa-solid ${isDoc ? 'fa-file-lines' : 'fa-person-chalkboard'} text-sm" aria-hidden="true"></i>
            </div>
            <div class="min-w-0 flex-1">
                <div class="flex items-center gap-2 flex-wrap">
                    <p class="font-black text-slate-800 text-[14px] m-0">${escHtml(l.title) || 'Untitled Lesson'}</p>
                    <span class="text-[10.5px] font-black bg-amber-50 text-amber-700 px-2 py-0.5 rounded border border-amber-200">${isDoc ? 'Document' : 'Slides'}</span>
                    <span class="text-[10.5px] font-bold bg-slate-100 text-slate-500 px-2 py-0.5 rounded">${escHtml(ctx.subjectName || '')}</span>
                </div>
                <p class="text-[11.5px] text-slate-500 font-semibold mt-1.5 mb-0">
                    ${l.publishedAt ? `Posted ${escHtml(formatDate(l.publishedAt))}` : ''}${l.createdAt ? `${l.publishedAt ? ' · ' : ''}Created ${escHtml(formatDate(l.createdAt))}` : ''}${slides ? ` · ${escHtml(slides)}` : ''}${l.authorName ? ` · ${escHtml(l.authorName)}` : ''}
                </p>
                <a href="${escHtml(url)}" class="inline-flex items-center gap-1.5 mt-2 text-[12px] font-black text-indigo-600 hover:text-indigo-700">
                    <i class="fa-solid fa-arrow-right" aria-hidden="true"></i> Open Lesson
                </a>
            </div>
        </div>
    </div>`;
}

// System-generated posts get a distinct card with a primary call to action:
//   live_session + live  → red "Live now" card, "Join Live Lesson"
//   live_session ended   → muted, "Review Lesson"
//   linkedLessonId       → "Open Lesson" button
function renderActionBulletin(post) {
    if (post.type === 'live_session') {
        if (post.live) {
            return `<div class="mt-3 flex items-center gap-2 flex-wrap">
                <span class="inline-flex items-center gap-1.5 text-[10.5px] font-black uppercase tracking-wider text-white bg-rose-600 px-2 py-1 rounded"><span class="cs-live-dot"></span>Live now</span>
                <a href="${escHtml(lessonViewerUrl(post))}" class="inline-flex items-center gap-2 bg-rose-600 hover:bg-rose-700 text-white font-black py-2 px-4 rounded-lg transition text-[13px] shadow-sm"><i class="fa-solid fa-tower-broadcast text-[11px]"></i>Join Live Lesson</a>
            </div>`;
        }
        return `<div class="mt-3 flex items-center gap-2 flex-wrap">
            <span class="inline-flex items-center gap-1.5 text-[10.5px] font-black uppercase tracking-wider text-slate-500 bg-slate-100 px-2 py-1 rounded"><i class="fa-solid fa-circle-stop text-[9px]"></i>Session ended</span>
            <a href="${escHtml(lessonViewerUrl(post))}" class="inline-flex items-center gap-1.5 bg-white hover:bg-indigo-50 text-indigo-600 border border-indigo-200 font-black py-1.5 px-3 rounded-lg transition text-[12px]"><i class="fa-solid fa-arrow-right text-[10px]"></i>Review Lesson</a>
        </div>`;
    }
    if (post.linkedLessonId) {
        return `<div class="mt-3"><a href="${escHtml(lessonViewerUrl(post))}" class="inline-flex items-center gap-2 bg-indigo-600 hover:bg-indigo-700 text-white font-black py-2 px-4 rounded-lg transition text-[13px] shadow-sm"><i class="fa-solid fa-arrow-right text-[11px]"></i>Open Lesson</a></div>`;
    }
    return '';
}

function displayTitle(post) { return displayPostText(post).title; }

// Compact card: title, subject, 2-line preview, CTA, comment pill. Polls
// and question answers stay usable on the card; clicking anywhere else on
// the card opens the full post page (openPostFromCardClick).
function renderPostCard(post) {
    const isLessonPlan = post.type === 'lesson_plan';
    const isLive = post.type === 'live_session';
    const isLiveNow = isLive && post.live;
    const isSystem = isLive || !!post.linkedLessonId;
    const isQuestion = post.type === 'question';
    const iconBg = isLiveNow ? 'bg-rose-50 text-rose-600 border-rose-200'
        : isSystem ? 'bg-indigo-50 text-indigo-600 border-indigo-200'
        : isLessonPlan ? 'bg-amber-50 text-amber-700 border-amber-200' : 'bg-indigo-50 text-indigo-600 border-indigo-200';
    const icon = isLive ? 'fa-tower-broadcast' : post.linkedLessonId ? 'fa-person-chalkboard' : isLessonPlan ? 'fa-calendar-days'
        : post.type === 'poll' ? 'fa-square-poll-horizontal' : isQuestion ? 'fa-circle-question' : 'fa-bullhorn';
    // Answers live in posts/{postId}/answers; the rules only hand this
    // student classmates' answers once their own answer exists (blind).
    if (isQuestion) watchAnswers(session.schoolId, post, { role: 'student', id: session.studentId }, renderPostList);
    const blind = isQuestion && isAnswerHiddenForStudent(post);
    const answered = isQuestion && studentHasAnswered(post);
    const cardTone = isLiveNow ? 'border-rose-300 ring-2 ring-rose-100' : isSystem ? 'border-indigo-200' : 'border-slate-200';
    const href = discussionUrl(post);
    const text = displayPostText(post);

    return `
    <div class="bg-white rounded-xl shadow-sm border ${cardTone} p-4" data-post-id="${escHtml(post.id)}" data-open-href="${escHtml(href)}">
        <div class="flex items-start gap-3">
            <div class="w-8 h-8 rounded-lg ${iconBg} border flex items-center justify-center flex-shrink-0 mt-0.5">
                <i class="fa-solid ${icon} text-sm"></i>
            </div>
            <div class="min-w-0 flex-1">
                <div class="flex items-center gap-2 flex-wrap">
                    ${post.pinned ? '<i class="fa-solid fa-thumbtack text-[10px] text-rose-500" title="Pinned"></i>' : ''}
                    <p class="font-black text-slate-800 text-[14px] m-0"><a class="cs-title-link" href="${escHtml(href)}">${escHtml(text.title) || (isLessonPlan ? 'Untitled Lesson' : 'Announcement')}</a></p>
                    ${isLessonPlan && post.lessonDate ? `<span class="text-[10.5px] font-black bg-amber-50 text-amber-700 px-2 py-0.5 rounded border border-amber-200">${escHtml(formatDate(post.lessonDate))}</span>` : ''}
                    <span class="text-[10.5px] font-bold bg-slate-100 text-slate-500 px-2 py-0.5 rounded">${escHtml(post.subjectName || '')}</span>
                </div>
                <p class="text-[10.5px] text-slate-400 font-semibold mt-1 mb-0">${escHtml(post.authorName || '')} · ${escHtml(formatDate(post.createdAt))}</p>
                ${text.body ? `<p class="text-[12.5px] text-slate-600 mt-1.5 mb-0 cs-clamp">${escHtml(text.body)}</p>` : ''}
                ${pollHtml(post, { role: 'student', viewerId: session.studentId })}
                ${renderActionBulletin(post)}
                ${isQuestion ? '' : commentPillHtml(post, href)}
            </div>
        </div>
        ${isQuestion ? commentsSectionHtml(answersView(post), { canComment: !answered, canDelete: () => false, discussionUrl, hideList: blind }) : ''}
    </div>`;
}

init();
