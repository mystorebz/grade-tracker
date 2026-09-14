// ── STUDENT UX OVERHAUL: LESSONS HUB (read-only, browse across subjects) ──
// New centralized directory so a student doesn't have to hunt through Class
// Stream posts to find a lesson — every PUBLISHED lesson across every one
// of this student's subjects, filterable by subject. Mirrors
// student/stream/stream.js's own teacher/subject resolution exactly (same
// session.studentData.teacherId → loadTeacherSubjectsCache →
// resolvePostContext fan-out), since that's what already guarantees a
// student only ever sees their own teacher's subjects.
import { getDoc } from "https://www.gstatic.com/firebasejs/10.7.1/firebase-firestore.js";
import { requireAuth } from '../../assets/js/auth.js';
import { injectStudentLayout } from '../../assets/js/layout-student.js';
import { loadTeacherSubjectsCache, getTeacherDocRef, loadSchoolHeaderInfo } from '../../assets/js/utils.js';
import { resolvePostContext } from '../../assets/js/posts.js';
import { loadLessonsForSubjects } from '../../assets/js/lessons.js';

// ── 1. AUTHENTICATION & LAYOUT ──────────────────────────────────────────────
const session = requireAuth('student', '../login.html');
if (session) {
    injectStudentLayout('lessons', 'Lessons', 'Browse every interactive lesson your teacher has published');
}

// ── 2. STATE ──────────────────────────────────────────────────────────────
let lessonsCache = [];         // every published lesson across every one of this student's subjects
let currentSubjectFilter = ''; // '' = All Subjects, else a subjectId

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
    try { return new Date(iso).toLocaleDateString(undefined, { month: 'short', day: 'numeric', year: 'numeric' }); }
    catch (e) { return iso; }
}

// ── 3. INITIALIZATION ───────────────────────────────────────────────────────
async function init() {
    if (!session) return;

    cacheEls();
    wireEvents();

    // Fire-and-forget header fill-in, same pattern as student/stream/stream.js
    // (injectStudentLayout only has the student's own cached session data —
    // the school name needs its own fetch).
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
        // Same resolution path Class Stream uses for itself — guarantees a
        // student only ever sees lessons belonging to their own teacher's
        // subjects, never any other class's.
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

        lessonsCache = await loadLessonsForSubjects(session.schoolId, postContexts);
        els.lessonsLoader.classList.add('hidden');
        els.lessonListCount.classList.remove('hidden');
        renderLessonGrid();
    } catch (e) {
        console.error('[Student Lessons] init:', e);
        showEmptyState('Something went wrong loading your lessons. Please try again later.');
    }
}

function cacheEls() {
    ['subjectFilter', 'lessonsLoader', 'lessonListCount', 'lessonGrid']
        .forEach(id => { els[id] = document.getElementById(id); });
}

function wireEvents() {
    els.subjectFilter.addEventListener('change', () => {
        currentSubjectFilter = els.subjectFilter.value;
        renderLessonGrid();
    });
}

function showEmptyState(message) {
    els.lessonsLoader.classList.add('hidden');
    els.lessonListCount.classList.add('hidden');
    els.lessonGrid.innerHTML = `<div class="col-span-full text-center py-10 text-slate-400 text-[13px] font-bold bg-white rounded-xl border border-slate-200">${escHtml(message)}</div>`;
}

// ── 4. SUBJECT FILTER ────────────────────────────────────────────────────
function renderSubjectFilterOptions(postContexts) {
    const options = ['<option value="">All Subjects</option>']
        .concat(postContexts.map(ctx => `<option value="${escHtml(ctx.subjectId)}">${escHtml(ctx.subjectName)}</option>`));
    els.subjectFilter.innerHTML = options.join('');
}

// ── 5. LESSON GRID ───────────────────────────────────────────────────────
function getVisibleLessons() {
    if (!currentSubjectFilter) return lessonsCache;
    return lessonsCache.filter(l => l.subjectId === currentSubjectFilter);
}

// classId/subjectId/subjectName are already denormalized onto every lesson
// doc by createLesson() (assets/js/lessons.js) — no extra fetch needed to
// build the viewer link.
function lessonViewerUrl(lesson) {
    const params = new URLSearchParams({
        lessonId: lesson.id,
        classId: lesson.classId,
        subjectId: lesson.subjectId,
        subjectName: lesson.subjectName || ''
    });
    return `../lessons/view.html?${params.toString()}`;
}

function renderLessonGrid() {
    const lessons = getVisibleLessons();
    els.lessonListCount.textContent = `${lessons.length} lesson${lessons.length === 1 ? '' : 's'}`;

    if (!lessons.length) {
        els.lessonGrid.innerHTML = `<div class="col-span-full text-center py-10 text-slate-400 text-[13px] font-bold bg-white rounded-xl border border-slate-200">
            No lessons yet${currentSubjectFilter ? ' for this subject' : ''}.
        </div>`;
        return;
    }

    els.lessonGrid.innerHTML = lessons.map(renderLessonCard).join('');
}

function renderLessonCard(lesson) {
    const isDocument = lesson.format === 'document';
    const iconBg = isDocument ? 'bg-amber-50 text-amber-600 border-amber-200' : 'bg-indigo-50 text-indigo-600 border-indigo-200';
    const icon = isDocument ? 'fa-file-lines' : 'fa-images';
    const slideCount = (lesson.slides || []).length;
    const metaLabel = isDocument ? 'Document' : `${slideCount} slide${slideCount === 1 ? '' : 's'}`;

    return `
    <a href="${escHtml(lessonViewerUrl(lesson))}" class="ls-card">
        <div class="ls-card-icon ${iconBg} border">
            <i class="fa-solid ${icon}"></i>
        </div>
        <div class="min-w-0">
            <p class="font-black text-slate-800 text-[14px] m-0 leading-tight truncate">${escHtml(lesson.title) || 'Untitled Lesson'}</p>
            <p class="text-[11px] font-bold text-indigo-500 mt-1 mb-0">${escHtml(lesson.subjectName || '')}</p>
        </div>
        <p class="text-[11px] text-slate-400 font-semibold m-0 mt-auto">${metaLabel} · ${escHtml(formatDate(lesson.publishedAt || lesson.updatedAt))}</p>
    </a>`;
}

init();
