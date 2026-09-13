// ── PHASE 1 MILESTONE 2: CLASS STREAM (student, read-only) ────────────────
import { getDoc } from "https://www.gstatic.com/firebasejs/10.7.1/firebase-firestore.js";
import { requireAuth } from '../../assets/js/auth.js';
import { injectStudentLayout } from '../../assets/js/layout-student.js';
import { loadTeacherSubjectsCache, getTeacherDocRef, loadSchoolHeaderInfo } from '../../assets/js/utils.js';
import { resolvePostContext, subscribeToPostsForSubjects } from '../../assets/js/posts.js';

// ── 1. AUTHENTICATION & LAYOUT ──────────────────────────────────────────────
const session = requireAuth('student', '../login.html');
if (session) {
    injectStudentLayout('stream', 'Class Stream', 'Announcements and lesson plans from your teacher');
}

// ── 2. STATE ──────────────────────────────────────────────────────────────
let postsCache = [];           // every post across every one of this student's subjects
let currentView = 'stream';    // 'stream' | 'lessonPlans'
let currentSubjectFilter = ''; // '' = All Subjects, else a subjectId

// Live posts subscription teardown (set once init() opens it). MUST be
// called when this page is left so the onSnapshot listeners it holds don't
// keep running — and billing reads — after the student navigates away.
let unsubscribePosts = null;

function teardownPostsSubscription() {
    if (unsubscribePosts) {
        unsubscribePosts();
        unsubscribePosts = null;
    }
}

// Multi-page site (real <a href> navigation, no SPA router), so the normal
// case is just the browser tearing down the whole page — but pagehide fires
// reliably for that (including back/forward-cache navigations, unlike
// beforeunload) and costs nothing to also call explicitly on the logout
// button below, so both paths are covered.
window.addEventListener('pagehide', teardownPostsSubscription);

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

        const { subjectsCache, resolvedClasses } = await loadTeacherSubjectsCache(session.schoolId, teacherId, legacyTeacherData);
        const activeSubjects = subjectsCache.filter(s => !s.archived);

        const postContexts = activeSubjects
            .map(s => resolvePostContext(s, resolvedClasses))
            .filter(Boolean);

        renderSubjectFilterOptions(postContexts);

        if (!postContexts.length) {
            showEmptyState("Your teacher hasn't set up any subjects yet.");
            return;
        }

        // Live subscription: any post the teacher adds, edits, pins, or
        // deletes across these subjects re-renders this list automatically,
        // with no page reload — this is what makes Class Stream update the
        // moment a teacher posts, instead of only on next visit.
        teardownPostsSubscription(); // guard against a stray double-init
        unsubscribePosts = subscribeToPostsForSubjects(session.schoolId, postContexts, (merged) => {
            postsCache = merged;
            els.streamLoader.classList.add('hidden');
            els.postListCount.classList.remove('hidden');
            renderPostList();
        });
    } catch (e) {
        console.error('[Student Stream] init:', e);
        showEmptyState('Something went wrong loading your class stream. Please try again later.');
    }
}

function cacheEls() {
    ['subjectFilter', 'viewStreamBtn', 'viewLessonPlansBtn',
     'streamLoader', 'postListCount', 'postList'
    ].forEach(id => { els[id] = document.getElementById(id); });
}

function wireEvents() {
    els.subjectFilter.addEventListener('change', () => {
        currentSubjectFilter = els.subjectFilter.value;
        renderPostList();
    });
    els.viewStreamBtn.addEventListener('click', () => setView('stream'));
    els.viewLessonPlansBtn.addEventListener('click', () => setView('lessonPlans'));
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
    setToggleActive(view === 'stream' ? els.viewStreamBtn : els.viewLessonPlansBtn, [els.viewStreamBtn, els.viewLessonPlansBtn]);
    renderPostList();
}

// ── 7. POST LIST ─────────────────────────────────────────────────────────
function getVisiblePosts() {
    let posts = postsCache;
    if (currentSubjectFilter) {
        posts = posts.filter(p => p.subjectId === currentSubjectFilter);
    }

    if (currentView === 'lessonPlans') {
        return posts
            .filter(p => p.type === 'lesson_plan')
            .sort((a, b) => {
                if (!a.lessonDate && !b.lessonDate) return 0;
                if (!a.lessonDate) return 1;
                if (!b.lessonDate) return -1;
                return a.lessonDate.localeCompare(b.lessonDate);
            });
    }
    // Stream view: pinned first (preserving newest-first order within each group)
    const pinned = posts.filter(p => p.pinned);
    const rest = posts.filter(p => !p.pinned);
    return [...pinned, ...rest];
}

function renderPostList() {
    if (!els.postListCount) return;
    const posts = getVisiblePosts();
    const label = currentView === 'lessonPlans' ? 'lesson plan' : 'post';
    els.postListCount.textContent = `${posts.length} ${label}${posts.length === 1 ? '' : 's'}`;

    if (!posts.length) {
        els.postList.innerHTML = `<div class="text-center py-10 text-slate-400 text-[13px] font-bold bg-white rounded-xl border border-slate-200">
            No ${label}s yet${currentSubjectFilter ? ' for this subject' : ''}.
        </div>`;
        return;
    }

    els.postList.innerHTML = posts.map(renderPostCard).join('');
}

function renderPostCard(post) {
    const isLessonPlan = post.type === 'lesson_plan';
    const iconBg = isLessonPlan ? 'bg-amber-50 text-amber-700 border-amber-200' : 'bg-indigo-50 text-indigo-600 border-indigo-200';
    const icon = isLessonPlan ? 'fa-calendar-days' : 'fa-bullhorn';

    return `
    <div class="bg-white rounded-xl shadow-sm border border-slate-200 p-4">
        <div class="flex items-start gap-3">
            <div class="w-8 h-8 rounded-lg ${iconBg} border flex items-center justify-center flex-shrink-0 mt-0.5">
                <i class="fa-solid ${icon} text-sm"></i>
            </div>
            <div class="min-w-0 flex-1">
                <div class="flex items-center gap-2 flex-wrap">
                    ${post.pinned ? '<i class="fa-solid fa-thumbtack text-[10px] text-rose-500" title="Pinned"></i>' : ''}
                    <p class="font-black text-slate-800 text-[14px] m-0">${escHtml(post.title) || (isLessonPlan ? 'Untitled Lesson' : 'Announcement')}</p>
                    ${isLessonPlan && post.lessonDate ? `<span class="text-[10.5px] font-black bg-amber-50 text-amber-700 px-2 py-0.5 rounded border border-amber-200">${escHtml(formatDate(post.lessonDate))}</span>` : ''}
                    <span class="text-[10.5px] font-bold bg-slate-100 text-slate-500 px-2 py-0.5 rounded">${escHtml(post.subjectName || '')}</span>
                </div>
                ${post.body ? `<p class="text-[12.5px] text-slate-600 mt-1.5 mb-0 whitespace-pre-wrap">${escHtml(post.body)}</p>` : ''}
                ${isLessonPlan && post.objectives ? `<p class="text-[11.5px] text-slate-500 mt-1.5 mb-0"><span class="font-bold">Objectives:</span> ${escHtml(post.objectives)}</p>` : ''}
                <p class="text-[10.5px] text-slate-400 font-semibold mt-2 mb-0">${escHtml(post.authorName || '')} · ${escHtml(formatDate(post.createdAt))}</p>
            </div>
        </div>
    </div>`;
}

init();
