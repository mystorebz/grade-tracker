// ── PHASE 1 MILESTONE 1: CLASS STREAM & LESSON PLANS (teacher UI) ─────────
import { requireAuth } from '../../assets/js/auth.js';
import { injectTeacherLayout } from '../../assets/js/layout-teachers.js';
import { showMsg, loadTeacherSubjectsCache } from '../../assets/js/utils.js';
import { resolvePostContext, loadPostsForSubject, createPost, updatePost, deletePost } from '../../assets/js/posts.js';

// ── 1. AUTHENTICATION & LAYOUT ──────────────────────────────────────────────
const session = requireAuth('teacher', '../login.html');
if (session) {
    injectTeacherLayout('stream', 'Class Stream', "Announcements and lesson plans for your subjects", false);
}

// ── 2. STATE ──────────────────────────────────────────────────────────────
let subjectsCache = [];       // merged legacy/new-model subjects, see utils.js
let resolvedClasses = [];     // this teacher's className(s) resolved to real classIds
let currentSubject = null;    // the subject object currently selected in the picker
let currentPostContext = null; // resolvePostContext(currentSubject, resolvedClasses)
let postsCache = [];          // every post for currentSubject, newest-first
let currentView = 'stream';   // 'stream' | 'lessonPlans'
let composerType = 'announcement'; // 'announcement' | 'lesson_plan'
let editingPostId = null;     // postId being edited, or null for a new post

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
        // Full ISO timestamps (createdAt/updatedAt) parse as usual.
        const d = /^\d{4}-\d{2}-\d{2}$/.test(iso)
            ? new Date(Number(iso.slice(0, 4)), Number(iso.slice(5, 7)) - 1, Number(iso.slice(8, 10)))
            : new Date(iso);
        return d.toLocaleDateString(undefined, { month: 'short', day: 'numeric', year: 'numeric' });
    } catch (e) { return iso; }
}

// ── 3. TOGGLE-BUTTON HELPERS ─────────────────────────────────────────────
// Both the Stream/Lesson Plans view switch and the composer's Announcement/
// Lesson Plan type switch are plain two-button groups. Tailwind's play-CDN
// build has no notion of a reusable "active" component class here, so the
// active state is a fixed set of utility classes applied/removed directly.
const TOGGLE_ACTIVE = ['bg-white', 'text-[#0d1f35]', 'shadow-sm'];
const TOGGLE_INACTIVE = ['text-[#6b84a0]'];

function setToggleActive(activeBtn, allBtnsInGroup) {
    allBtnsInGroup.forEach(btn => {
        const isActive = btn === activeBtn;
        btn.classList.remove(...TOGGLE_ACTIVE, ...TOGGLE_INACTIVE);
        btn.classList.add(...(isActive ? TOGGLE_ACTIVE : TOGGLE_INACTIVE));
    });
}

// ── 4. INITIALIZATION ───────────────────────────────────────────────────────
async function init() {
    if (!session) return;

    document.getElementById('displayTeacherName').textContent = session.teacherData.name;
    document.getElementById('teacherAvatar').textContent = session.teacherData.name.charAt(0).toUpperCase();
    document.getElementById('sidebarSchoolId').textContent = session.schoolId;
    const classes = session.teacherData.classes || [session.teacherData.className || ''];
    document.getElementById('displayTeacherClasses').innerHTML = classes.map(c => `<span class="class-pill">${escHtml(c)}</span>`).join('');

    cacheEls();
    wireEvents();
    setView('stream');

    els.subjectSelect.innerHTML = '<option value="">Loading subjects…</option>';
    const result = await loadTeacherSubjectsCache(session.schoolId, session.teacherId, session.teacherData);
    subjectsCache = result.subjectsCache;
    resolvedClasses = result.resolvedClasses;

    renderSubjectOptions();
    await onSubjectChange();
}

function cacheEls() {
    ['subjectSelect', 'viewStreamBtn', 'viewLessonPlansBtn',
     'typeAnnouncementBtn', 'typeLessonPlanBtn',
     'composerTitle', 'composerMsg', 'titleRequiredMark',
     'postTitle', 'postBody', 'postObjectives', 'postLessonDate', 'postPinned',
     'lessonDateField', 'objectivesField', 'pinnedField',
     'savePostBtn', 'savePostBtnLabel', 'cancelEditBtn',
     'postListCount', 'postList'
    ].forEach(id => { els[id] = document.getElementById(id); });
}

function wireEvents() {
    els.subjectSelect.addEventListener('change', onSubjectChange);

    els.viewStreamBtn.addEventListener('click', () => setView('stream'));
    els.viewLessonPlansBtn.addEventListener('click', () => setView('lessonPlans'));

    els.typeAnnouncementBtn.addEventListener('click', () => setComposerType('announcement'));
    els.typeLessonPlanBtn.addEventListener('click', () => setComposerType('lesson_plan'));

    els.savePostBtn.addEventListener('click', savePost);
    els.cancelEditBtn.addEventListener('click', resetComposer);

    els.postList.addEventListener('click', onPostListClick);
}

// ── 5. SUBJECT SELECTION ────────────────────────────────────────────────────
function renderSubjectOptions() {
    const active = subjectsCache.filter(s => !s.archived);
    if (!active.length) {
        els.subjectSelect.innerHTML = '<option value="">No subjects yet</option>';
        return;
    }
    els.subjectSelect.innerHTML = active.map(s => `<option value="${escHtml(s.id)}">${escHtml(s.name)}</option>`).join('');
}

async function onSubjectChange() {
    const subjectId = els.subjectSelect.value;
    currentSubject = subjectsCache.find(s => s.id === subjectId) || null;
    resetComposer();

    if (!currentSubject) {
        currentPostContext = null;
        postsCache = [];
        setComposerEnabled(false, 'Select a subject to post to its stream.');
        renderPostList();
        return;
    }

    currentPostContext = resolvePostContext(currentSubject, resolvedClasses);
    if (!currentPostContext) {
        postsCache = [];
        setComposerEnabled(false, "Couldn't resolve this subject to a class — check your class assignment in Settings.");
        renderPostList();
        return;
    }

    setComposerEnabled(true);
    els.postList.innerHTML = '<div class="text-center py-10 text-[#9ab0c6] text-[13px] font-bold"><i class="fa-solid fa-spinner fa-spin text-[#2563eb] text-2xl mb-3 block"></i>Loading posts…</div>';
    try {
        postsCache = await loadPostsForSubject(session.schoolId, currentPostContext);
    } catch (e) {
        console.error('[Stream] loadPostsForSubject:', e);
        postsCache = [];
    }
    renderPostList();
}

function setComposerEnabled(enabled, message) {
    els.savePostBtn.disabled = !enabled;
    els.savePostBtn.classList.toggle('opacity-50', !enabled);
    els.savePostBtn.classList.toggle('cursor-not-allowed', !enabled);
    if (!enabled && message) {
        showMsg('composerMsg', message, true);
    }
}

// ── 6. VIEW TOGGLE (Stream vs. Lesson Plans) ────────────────────────────────
function setView(view) {
    currentView = view;
    setToggleActive(view === 'stream' ? els.viewStreamBtn : els.viewLessonPlansBtn, [els.viewStreamBtn, els.viewLessonPlansBtn]);
    renderPostList();
}

// ── 7. COMPOSER ──────────────────────────────────────────────────────────
function setComposerType(type) {
    composerType = type;
    setToggleActive(type === 'announcement' ? els.typeAnnouncementBtn : els.typeLessonPlanBtn, [els.typeAnnouncementBtn, els.typeLessonPlanBtn]);

    const isLessonPlan = type === 'lesson_plan';
    els.lessonDateField.classList.toggle('hidden', !isLessonPlan);
    els.objectivesField.classList.toggle('hidden', !isLessonPlan);
    els.pinnedField.classList.toggle('hidden', isLessonPlan);
    els.titleRequiredMark.classList.toggle('hidden', !isLessonPlan);
}

function resetComposer() {
    editingPostId = null;
    els.composerTitle.textContent = 'New Post';
    els.savePostBtnLabel.textContent = 'Post';
    els.cancelEditBtn.classList.add('hidden');
    els.postTitle.value = '';
    els.postBody.value = '';
    els.postObjectives.value = '';
    els.postLessonDate.value = '';
    els.postPinned.checked = false;
    setComposerType('announcement');
    if (els.composerMsg) els.composerMsg.classList.add('hidden');
}

function beginEditPost(post) {
    editingPostId = post.id;
    els.composerTitle.textContent = 'Edit Post';
    els.savePostBtnLabel.textContent = 'Save Changes';
    els.cancelEditBtn.classList.remove('hidden');
    setComposerType(post.type);
    els.postTitle.value = post.title || '';
    els.postBody.value = post.body || '';
    els.postObjectives.value = post.objectives || '';
    els.postLessonDate.value = post.lessonDate || '';
    els.postPinned.checked = !!post.pinned;
    window.scrollTo({ top: 0, behavior: 'smooth' });
}

async function savePost() {
    if (!currentPostContext) return;

    const isLessonPlan = composerType === 'lesson_plan';
    const title = els.postTitle.value.trim();
    const body = els.postBody.value.trim();

    if (isLessonPlan && !title) {
        showMsg('composerMsg', 'Lesson plans need a title.', true);
        return;
    }
    if (!title && !body) {
        showMsg('composerMsg', 'Write something before posting.', true);
        return;
    }

    const postData = {
        type: composerType,
        title,
        body,
        lessonDate: els.postLessonDate.value || null,
        objectives: els.postObjectives.value.trim(),
        pinned: els.postPinned.checked
    };

    const prevLabel = els.savePostBtnLabel.textContent;
    els.savePostBtn.disabled = true;
    els.savePostBtnLabel.textContent = editingPostId ? 'Saving…' : 'Posting…';

    try {
        if (editingPostId) {
            const updates = await updatePost(session.schoolId, currentPostContext, editingPostId, postData);
            const idx = postsCache.findIndex(p => p.id === editingPostId);
            if (idx !== -1) postsCache[idx] = { ...postsCache[idx], ...updates };
        } else {
            const authorContext = { authorId: session.teacherId, authorName: session.teacherData.name };
            const newPost = await createPost(session.schoolId, currentPostContext, authorContext, postData);
            postsCache.unshift(newPost);
        }
        resetComposer();
        renderPostList();
    } catch (e) {
        console.error('[Stream] savePost:', e);
        showMsg('composerMsg', 'Something went wrong saving this post. Please try again.', true);
        els.savePostBtnLabel.textContent = prevLabel;
    } finally {
        els.savePostBtn.disabled = false;
    }
}

// ── 8. POST LIST ─────────────────────────────────────────────────────────
function getVisiblePosts() {
    if (currentView === 'lessonPlans') {
        return postsCache
            .filter(p => p.type === 'lesson_plan')
            .sort((a, b) => {
                if (!a.lessonDate && !b.lessonDate) return 0;
                if (!a.lessonDate) return 1;
                if (!b.lessonDate) return -1;
                return a.lessonDate.localeCompare(b.lessonDate);
            });
    }
    // Stream view: pinned first (preserving newest-first order within each group)
    const pinned = postsCache.filter(p => p.pinned);
    const rest = postsCache.filter(p => !p.pinned);
    return [...pinned, ...rest];
}

function renderPostList() {
    const posts = getVisiblePosts();
    const label = currentView === 'lessonPlans' ? 'lesson plan' : 'post';
    els.postListCount.textContent = `${posts.length} ${label}${posts.length === 1 ? '' : 's'}`;

    if (!posts.length) {
        els.postList.innerHTML = `<div class="text-center py-10 text-[#9ab0c6] text-[13px] font-bold bg-white rounded-xl border border-[#dce3ed]">
            ${currentSubject ? `No ${label}s yet for this subject.` : 'Select a subject above to see its stream.'}
        </div>`;
        return;
    }

    els.postList.innerHTML = posts.map(renderPostCard).join('');
}

function renderPostCard(post) {
    const isLessonPlan = post.type === 'lesson_plan';
    const iconBg = isLessonPlan ? 'bg-[#fef3c7] text-[#92400e] border-[#fde68a]' : 'bg-[#eef4ff] text-[#2563eb] border-[#c7d9fd]';
    const icon = isLessonPlan ? 'fa-calendar-days' : 'fa-bullhorn';

    return `
    <div class="post-card bg-white rounded-xl shadow-sm border border-[#dce3ed] p-4" data-post-id="${escHtml(post.id)}">
        <div class="flex items-start justify-between gap-3">
            <div class="flex items-start gap-3 min-w-0">
                <div class="w-8 h-8 rounded ${iconBg} border flex items-center justify-center flex-shrink-0 mt-0.5">
                    <i class="fa-solid ${icon} text-sm"></i>
                </div>
                <div class="min-w-0">
                    <div class="flex items-center gap-2 flex-wrap">
                        ${post.pinned ? '<i class="fa-solid fa-thumbtack text-[10px] text-[#e31b4a]" title="Pinned"></i>' : ''}
                        <p class="font-bold text-[#0d1f35] text-[14px] m-0">${escHtml(post.title) || (isLessonPlan ? 'Untitled Lesson' : 'Announcement')}</p>
                        ${isLessonPlan && post.lessonDate ? `<span class="text-[10.5px] font-bold bg-[#fef3c7] text-[#92400e] px-2 py-0.5 rounded border border-[#fde68a]">${escHtml(formatDate(post.lessonDate))}</span>` : ''}
                    </div>
                    ${post.body ? `<p class="text-[12.5px] text-[#374f6b] mt-1.5 mb-0 whitespace-pre-wrap">${escHtml(post.body)}</p>` : ''}
                    ${isLessonPlan && post.objectives ? `<p class="text-[11.5px] text-[#6b84a0] mt-1.5 mb-0"><span class="font-bold">Objectives:</span> ${escHtml(post.objectives)}</p>` : ''}
                    <p class="text-[10.5px] text-[#9ab0c6] font-semibold mt-2 mb-0">${escHtml(post.authorName || '')} · ${escHtml(formatDate(post.createdAt))}</p>
                </div>
            </div>
            <div class="flex items-center gap-1 flex-shrink-0">
                <button data-action="edit" class="text-[#6b84a0] hover:text-[#2563eb] hover:bg-[#eef4ff] h-7 w-7 rounded flex items-center justify-center transition" title="Edit">
                    <i class="fa-solid fa-pen text-xs"></i>
                </button>
                <button data-action="delete" class="text-[#6b84a0] hover:text-[#e31b4a] hover:bg-[#fff0f3] h-7 w-7 rounded flex items-center justify-center transition" title="Delete">
                    <i class="fa-solid fa-trash text-xs"></i>
                </button>
            </div>
        </div>
    </div>`;
}

async function onPostListClick(e) {
    const btn = e.target.closest('[data-action]');
    if (!btn) return;
    const card = e.target.closest('[data-post-id]');
    const postId = card && card.dataset.postId;
    const post = postsCache.find(p => p.id === postId);
    if (!post) return;

    if (btn.dataset.action === 'edit') {
        beginEditPost(post);
    } else if (btn.dataset.action === 'delete') {
        if (!confirm(`Delete "${post.title || (post.type === 'lesson_plan' ? 'this lesson plan' : 'this announcement')}"? This cannot be undone.`)) return;
        try {
            await deletePost(session.schoolId, currentPostContext, postId);
            postsCache = postsCache.filter(p => p.id !== postId);
            if (editingPostId === postId) resetComposer();
            renderPostList();
        } catch (err) {
            console.error('[Stream] deletePost:', err);
            alert('Failed to delete this post. Please try again.');
        }
    }
}

init();
