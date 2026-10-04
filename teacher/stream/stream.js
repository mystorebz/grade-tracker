// ── PHASE 1 MILESTONE 1: CLASS STREAM & LESSON PLANS (teacher UI) ─────────
import { requireAuth } from '../../assets/js/auth.js';
import { injectTeacherLayout } from '../../assets/js/layout-teachers.js';
import { showMsg, loadTeacherSubjectsCache } from '../../assets/js/utils.js';
import { resolvePostContext, createPost, updatePost, deletePost, createLessonLinkedPost,
         createPostFeed, resolveActiveTermWindow, displayPostText } from '../../assets/js/posts.js';
import { injectCommentCss, commentsSectionHtml, commentPillHtml, renderPreservingDrafts, handleCommentEvent } from '../../assets/js/stream-comments.js';
import { discussionUrl, focusPostFromUrl, openPostFromCardClick } from '../../assets/js/stream-discussion.js';
import { loadLessonsForSubject } from '../../assets/js/lessons.js';
import { injectPollCss, pollHtml, handlePollEvent } from '../../assets/js/stream-polls.js';
import { watchAnswers, answersView, stopAllAnswerWatches } from '../../assets/js/stream-answers.js';
import { POLL_MIN_OPTIONS, POLL_MAX_OPTIONS } from '../../assets/js/posts.js';
import { db } from '../../assets/js/firebase-init.js';
import { reportStreamActivity, cacheStreamContexts } from '../../assets/js/stream-badge.js';
import { collection, query, where, getDocs } from "https://www.gstatic.com/firebasejs/10.7.1/firebase-firestore.js";

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
let editingPostId = null;     // postId being edited, or null for a new post
let lessonsCache = [];        // this subject's lessons (for the "Stream a Lesson" modal), loaded lazily on first open
// MODULE 3: live, semester-scoped, paginated feed for the selected subject.
let feed = null;              // createPostFeed() handle — stop() on subject change / page leave
let feedHasMore = false;
let feedReady = false;
let termWindow = { semesterId: null, sinceIso: null };

function stopFeed() { if (feed) { feed.stop(); feed = null; } }

// MODULE 3.5: composer post type + class rosters for poll "Not voted yet".
let composerType = 'announcement';   // 'announcement' | 'poll' | 'question'
let editingType = null;              // type of the post being edited (locked)
const rosterByClass = new Map();     // classId -> { list: [{id,name}] } | 'loading'

// Active students of a class — same membership test as the gradebook and
// firestore.rules: classId first, className fallback for older records.
function ensureRoster(classId, className) {
    if (!classId || rosterByClass.has(classId)) return;
    rosterByClass.set(classId, 'loading');
    getDocs(query(collection(db, 'students'), where('currentSchoolId', '==', session.schoolId), where('enrollmentStatus', '==', 'Active')))
        .then(snap => {
            const list = snap.docs.map(d => ({ id: d.id, ...d.data() }))
                .filter(s => s.classId ? s.classId === classId : (!!className && s.className === className))
                .map(s => ({ id: s.id, name: s.name || s.id }))
                .sort((a, b) => a.name.localeCompare(b.name));
            rosterByClass.set(classId, { list });
            renderPostList();
        })
        .catch(e => { console.error('[Stream] roster:', e); rosterByClass.set(classId, { list: null }); });
}

function rosterFor(classId) {
    const r = rosterByClass.get(classId);
    return r && r !== 'loading' ? r.list : null;
}
window.addEventListener('pagehide', stopFeed);
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
    injectCommentCss();
    setView('stream');

    els.subjectSelect.innerHTML = '<option value="">Loading subjects…</option>';
    const [result, term] = await Promise.all([
        loadTeacherSubjectsCache(session.schoolId, session.teacherId, session.teacherData),
        resolveActiveTermWindow(session.schoolId),
    ]);
    termWindow = term;
    subjectsCache = result.subjectsCache;
    resolvedClasses = result.resolvedClasses;
    // Sidebar badge: remember this teacher's subjects for the cross-page check.
    cacheStreamContexts(subjectsCache.filter(s => !s.archived).map(s => resolvePostContext(s, resolvedClasses)).filter(Boolean));

    renderSubjectOptions();
    // Back from a discussion page: reopen the same subject, then focus the post.
    const wantSubject = new URLSearchParams(location.search).get('subject');
    if (wantSubject && [...els.subjectSelect.options].some(o => o.value === wantSubject)) els.subjectSelect.value = wantSubject;
    await onSubjectChange();
}

function cacheEls() {
    ['subjectSelect', 'viewStreamBtn', 'viewLessonPlansBtn',
     'composerTitle', 'composerMsg',
     'postTitle', 'postBody', 'postPinned', 'pinnedField',
     'savePostBtn', 'savePostBtnLabel', 'cancelEditBtn',
     'postListCount', 'postList',
     'streamLessonBtn', 'streamLessonModalOverlay', 'closeStreamLessonModalBtn',
     'streamLessonModalMsg', 'streamLessonList', 'loadOlderBtn',
     'postTypeField', 'pollFields', 'questionFields', 'pollOptionList', 'addPollOptionBtn',
     'pollAllowChange', 'pollClosesAt', 'questionBlind'
    ].forEach(id => { els[id] = document.getElementById(id); });
}

function wireEvents() {
    els.subjectSelect.addEventListener('change', onSubjectChange);

    els.viewStreamBtn.addEventListener('click', () => setView('stream'));
    els.viewLessonPlansBtn.addEventListener('click', () => setView('lessonPlans'));

    els.savePostBtn.addEventListener('click', savePost);
    els.cancelEditBtn.addEventListener('click', resetComposer);

    els.postList.addEventListener('click', onPostListClick);
    els.postList.addEventListener('keydown', (e) => handleCommentEvent(e, commentCfg()));
    els.loadOlderBtn.addEventListener('click', onLoadOlder);

    document.querySelectorAll('[data-post-type]').forEach(btn =>
        btn.addEventListener('click', () => setComposerType(btn.dataset.postType)));
    els.addPollOptionBtn.addEventListener('click', () => {
        const values = readPollOptionInputs();
        if (values.length >= POLL_MAX_OPTIONS) return;
        renderPollOptionInputs([...values, '']);
        els.pollOptionList.querySelector('.poll-option-row:last-child input')?.focus();
    });
    els.pollOptionList.addEventListener('click', (e) => {
        const rm = e.target.closest('[data-remove-option]');
        if (!rm) return;
        const values = readPollOptionInputs();
        if (values.length <= POLL_MIN_OPTIONS) return;
        values.splice(Number(rm.dataset.removeOption), 1);
        renderPollOptionInputs(values);
    });
    injectPollCss();

    els.streamLessonBtn.addEventListener('click', openStreamLessonModal);
    els.closeStreamLessonModalBtn.addEventListener('click', closeStreamLessonModal);
    els.streamLessonModalOverlay.addEventListener('click', (e) => {
        if (e.target === els.streamLessonModalOverlay) closeStreamLessonModal();
    });
    els.streamLessonList.addEventListener('click', onStreamLessonListClick);
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
    stopFeed();
    feedHasMore = false;
    feedReady = false;
    lessonsCache = []; // invalidate — re-fetched lazily next time the modal opens for this subject

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
    postsCache = [];
    els.postList.innerHTML = '<div class="text-center py-10 text-[#9ab0c6] text-[13px] font-bold"><i class="fa-solid fa-spinner fa-spin text-[#2563eb] text-2xl mb-3 block"></i>Loading posts…</div>';

    // Live listener: newest 20 posts of the active term (+ pinned), so a
    // post from another tab or device (e.g. a "Live now" bulletin) appears
    // without a refresh. Older posts load on demand (Load Older button).
    feed = createPostFeed(session.schoolId, [currentPostContext], {
        sinceIso: termWindow.sinceIso,
        onChange: (list, { hasMore, ready }) => {
            postsCache = list;
            feedHasMore = hasMore;
            feedReady = ready;
            if (ready) reportStreamActivity(list); // sidebar badge
            if (ready) renderPostList();
        },
    });
}

async function onLoadOlder() {
    if (!feed) return;
    const label = els.loadOlderBtn.querySelector('span');
    els.loadOlderBtn.disabled = true;
    label.textContent = 'Loading…';
    try { await feed.loadOlder(); } finally {
        els.loadOlderBtn.disabled = false;
        label.textContent = 'Load Older Announcements';
    }
}

function commentCfg() {
    return {
        schoolId: session.schoolId,
        findPost: (id) => postsCache.find(p => p.id === id) || null,
        author: { authorId: session.teacherId, authorName: session.teacherData.name, role: 'teacher' },
        rerender: renderPostList,
        onPatched: (postId, comments) => feed && feed.patchLocal(postId, { comments }),
    };
}

function setComposerEnabled(enabled, message) {
    els.savePostBtn.disabled = !enabled;
    els.savePostBtn.classList.toggle('opacity-50', !enabled);
    els.savePostBtn.classList.toggle('cursor-not-allowed', !enabled);
    els.streamLessonBtn.disabled = !enabled;
    els.streamLessonBtn.classList.toggle('opacity-50', !enabled);
    els.streamLessonBtn.classList.toggle('cursor-not-allowed', !enabled);
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
// The composer only ever creates/edits plain announcement posts now — lesson
// authoring lives in the Subjects Hub's Lessons tab, and broadcasting a
// lesson happens through the "Stream a Lesson" modal (section 7b) instead of
// this form. Editing is still allowed for legacy type:'lesson_plan' posts'
// pinned/body/title via this composer is intentionally NOT offered (see the
// edit-button guard in renderPostCard) — updatePost() nulls out
// lessonDate/objectives for any patch whose type isn't 'lesson_plan', so
// letting this always-'announcement' composer edit one of those posts would
// silently destroy its lesson-plan-specific fields.
// ── 7a. POST TYPE (Announcement | Poll | Question) ───────────────────────
function setComposerType(type) {
    composerType = ['poll', 'question'].includes(type) ? type : 'announcement';
    const btns = [...document.querySelectorAll('[data-post-type]')];
    setToggleActive(btns.find(b => b.dataset.postType === composerType), btns);
    const editingPoll = editingPostId && editingType === 'poll';
    els.pollFields.classList.toggle('hidden', composerType !== 'poll' || editingPoll);
    els.questionFields.classList.toggle('hidden', composerType !== 'question');
    els.postTitle.placeholder = composerType === 'poll' ? 'e.g. Where should we go for our class trip?'
        : composerType === 'question' ? 'e.g. What should we build for the science fair?'
        : "e.g. Reminder about Friday's quiz";
    els.postBody.placeholder = composerType === 'poll' ? 'Add any details for the poll (optional)…'
        : composerType === 'question' ? 'Add context for the question (optional)…'
        : 'Write your announcement...';
}

function readPollOptionInputs() {
    return [...els.pollOptionList.querySelectorAll('input')].map(i => i.value);
}

function renderPollOptionInputs(values) {
    const list = values.length >= POLL_MIN_OPTIONS ? values : [...values, ...Array(POLL_MIN_OPTIONS - values.length).fill('')];
    els.pollOptionList.innerHTML = list.map((v, i) => `
        <div class="poll-option-row flex items-center gap-2">
            <span class="w-6 text-center text-[11px] font-bold text-[#9ab0c6]">${i + 1}</span>
            <input type="text" maxlength="120" value="${escHtml(v)}" placeholder="Choice ${i + 1}" class="form-input flex-1 p-2 bg-white border border-[#dce3ed] rounded text-[13px] text-[#0d1f35] outline-none focus:border-[#2563eb]">
            <button type="button" data-remove-option="${i}" class="text-[#9ab0c6] hover:text-[#e31b4a] h-8 w-8 rounded flex items-center justify-center ${list.length <= POLL_MIN_OPTIONS ? 'invisible' : ''}" title="Remove choice" aria-label="Remove choice ${i + 1}"><i class="fa-solid fa-xmark text-xs"></i></button>
        </div>`).join('');
    els.addPollOptionBtn.classList.toggle('hidden', list.length >= POLL_MAX_OPTIONS);
}

function resetComposer() {
    editingPostId = null;
    editingType = null;
    if (els.postTypeField) {
        els.postTypeField.classList.remove('hidden');
        renderPollOptionInputs(['', '']);
        els.pollAllowChange.checked = false;
        els.pollClosesAt.value = '';
        els.questionBlind.checked = false;
        setComposerType('announcement');
    }
    els.composerTitle.textContent = 'New Post';
    els.savePostBtnLabel.textContent = 'Post';
    els.cancelEditBtn.classList.add('hidden');
    els.postTitle.value = '';
    els.postBody.value = '';
    els.postPinned.checked = false;
    if (els.composerMsg) els.composerMsg.classList.add('hidden');
}

function beginEditPost(post) {
    editingPostId = post.id;
    els.composerTitle.textContent = 'Edit Post';
    els.savePostBtnLabel.textContent = 'Save Changes';
    els.cancelEditBtn.classList.remove('hidden');
    els.postTitle.value = post.title || '';
    els.postBody.value = post.body || '';
    els.postPinned.checked = !!post.pinned;
    // Type is fixed once posted. Poll choices/settings are managed on the
    // card itself (Close/Reopen, Reset Votes) so existing votes stay valid.
    editingType = ['poll', 'question'].includes(post.type) ? post.type : 'announcement';
    els.postTypeField.classList.add('hidden');
    els.questionBlind.checked = !!(post.question && post.question.blindReplies);
    setComposerType(editingType);
    window.scrollTo({ top: 0, behavior: 'smooth' });
}

async function savePost() {
    if (!currentPostContext) return;

    const title = els.postTitle.value.trim();
    const body = els.postBody.value.trim();

    if (!title && !body) {
        showMsg('composerMsg', 'Write something before posting.', true);
        return;
    }

    const type = editingPostId ? editingType : composerType;
    const postData = {
        type,
        title,
        body,
        pinned: els.postPinned.checked,
    };
    if (!editingPostId) postData.semesterId = termWindow.semesterId;
    if (type === 'question') postData.question = { blindReplies: els.questionBlind.checked };
    if (type === 'poll' && !editingPostId) {
        const options = readPollOptionInputs().map(v => v.trim()).filter(Boolean);
        if (options.length < POLL_MIN_OPTIONS) {
            showMsg('composerMsg', `A poll needs at least ${POLL_MIN_OPTIONS} choices.`, true);
            return;
        }
        if (new Set(options.map(o => o.toLowerCase())).size !== options.length) {
            showMsg('composerMsg', 'Each poll choice must be different.', true);
            return;
        }
        const closesAt = els.pollClosesAt.value ? new Date(els.pollClosesAt.value) : null;
        if (closesAt && closesAt.getTime() <= Date.now()) {
            showMsg('composerMsg', 'The closing time must be in the future.', true);
            return;
        }
        postData.poll = { options, allowChange: els.pollAllowChange.checked, closesAt };
    }

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
            await createPost(session.schoolId, currentPostContext, authorContext, postData); // live feed renders it
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

// ── 7b. "STREAM A LESSON" MODAL ──────────────────────────────────────────
// Broadcasting trigger only — lessons themselves are authored in the
// Subjects Hub's Lessons tab (teacher/subjects/subjects.js's
// renderLessonsTab()) via the Lesson Builder. This modal lists this
// subject's PUBLISHED lessons (a draft can't be presented live — see
// lessons/live.js's own status gate — and re-sharing a draft to the stream
// makes little sense either, so drafts are filtered out here rather than
// shown disabled) and offers two actions per lesson:
//   - "Start Live Session": navigates to the existing, already-URL-param-
//     aware live.js/live.html presenter — no new live-session logic here.
//   - "Share to Stream": posts.js's createLessonLinkedPost(), a manual
//     re-share for a lesson that was already auto-announced once when first
//     published (lessons.js's publishLesson() does that automatically) —
//     useful as a reminder post without requiring the teacher to unpublish/
//     republish the lesson itself.
async function openStreamLessonModal() {
    if (!currentPostContext) return;
    els.streamLessonModalOverlay.classList.remove('hidden');
    els.streamLessonModalMsg.classList.add('hidden');
    els.streamLessonList.innerHTML = '<div class="text-center py-8 text-[#9ab0c6] text-[13px] font-bold"><i class="fa-solid fa-spinner fa-spin text-[#2563eb] text-xl mb-2 block"></i>Loading lessons…</div>';

    try {
        lessonsCache = await loadLessonsForSubject(session.schoolId, currentPostContext);
    } catch (e) {
        console.error('[Stream] loadLessonsForSubject:', e);
        lessonsCache = [];
        showMsg('streamLessonModalMsg', 'Could not load lessons for this subject. Please try again.', true);
    }
    renderStreamLessonList();
}

function closeStreamLessonModal() {
    els.streamLessonModalOverlay.classList.add('hidden');
}

function renderStreamLessonList() {
    const published = lessonsCache.filter(l => l.status === 'published');

    if (!published.length) {
        els.streamLessonList.innerHTML = `<div class="text-center py-8 text-[#9ab0c6] text-[13px] font-bold">
            No published lessons yet for this subject. Publish a lesson from the Subjects Hub's Lessons tab first.
        </div>`;
        return;
    }

    els.streamLessonList.innerHTML = published.map(lesson => `
        <div class="flex items-center justify-between gap-3 border border-[#dce3ed] rounded-lg p-3" data-lesson-id="${escHtml(lesson.id)}">
            <div class="min-w-0">
                <p class="font-bold text-[#0d1f35] text-[13px] m-0 truncate">${escHtml(lesson.title) || 'Untitled Lesson'}</p>
                <p class="text-[10.5px] text-[#9ab0c6] font-semibold m-0">${lesson.format === 'document' ? 'Document' : 'Slides'} · Updated ${escHtml(formatDate(lesson.updatedAt))}</p>
            </div>
            <div class="flex items-center gap-1.5 flex-shrink-0">
                <button data-action="live" class="bg-[#0d1f35] hover:bg-[#2563eb] text-white font-bold py-1.5 px-3 rounded transition text-[11.5px] flex items-center gap-1.5">
                    <i class="fa-solid fa-tower-broadcast text-[10px]"></i>Start Live Session
                </button>
                <button data-action="share" class="bg-white hover:bg-[#eef4ff] text-[#2563eb] border border-[#c7d9fd] font-bold py-1.5 px-3 rounded transition text-[11.5px] flex items-center gap-1.5">
                    <i class="fa-solid fa-share text-[10px]"></i>Share to Stream
                </button>
            </div>
        </div>`).join('');
}

async function onStreamLessonListClick(e) {
    const btn = e.target.closest('[data-action]');
    if (!btn) return;
    const row = e.target.closest('[data-lesson-id]');
    const lessonId = row && row.dataset.lessonId;
    const lesson = lessonsCache.find(l => l.id === lessonId);
    if (!lesson || !currentPostContext) return;

    if (btn.dataset.action === 'live') {
        const params = new URLSearchParams({
            lessonId: lesson.id,
            classId: currentPostContext.classId,
            subjectId: currentPostContext.subjectId,
            subjectName: currentPostContext.subjectName || ''
        });
        window.location.href = `../lessons/live.html?${params.toString()}`;
        return;
    }

    if (btn.dataset.action === 'share') {
        btn.disabled = true;
        const prevHtml = btn.innerHTML;
        btn.innerHTML = 'Sharing…';
        try {
            const authorContext = { authorId: session.teacherId, authorName: session.teacherData.name };
            await createLessonLinkedPost(session.schoolId, currentPostContext, authorContext, {
                lessonId: lesson.id,
                lessonTitle: lesson.title
            }); // live feed renders it
            closeStreamLessonModal();
            setView('stream');
            showMsg('composerMsg', `Shared "${lesson.title || 'Untitled Lesson'}" to the stream.`, false);
        } catch (err) {
            console.error('[Stream] createLessonLinkedPost:', err);
            btn.disabled = false;
            btn.innerHTML = prevHtml;
            showMsg('streamLessonModalMsg', 'Failed to share this lesson. Please try again.', true);
        }
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

    if (els.loadOlderBtn) els.loadOlderBtn.classList.toggle('hidden', !(feedReady && feedHasMore && currentView === 'stream'));

    if (!posts.length) {
        els.postList.innerHTML = `<div class="text-center py-10 text-[#9ab0c6] text-[13px] font-bold bg-white rounded-xl border border-[#dce3ed]">
            ${currentSubject ? `No ${label}s yet for this subject${termWindow.semesterName ? ` in ${escHtml(termWindow.semesterName)}` : ''}.` : 'Select a subject above to see its stream.'}
        </div>`;
        return;
    }

    renderPreservingDrafts(els.postList, () => { els.postList.innerHTML = posts.map(renderPostCard).join(''); });
    focusPostFromUrl(els.postList);
}

// System-generated posts: a live session bulletin, or a lesson shared /
// published from the Lesson Builder. Rendered distinctly with a CTA.
function liveUrl(post) {
    return `../lessons/live.html?${new URLSearchParams({ lessonId: post.linkedLessonId, classId: post.classId, subjectId: post.subjectId, subjectName: post.subjectName || '' }).toString()}`;
}

function renderSystemBanner(post) {
    if (post.type === 'live_session') {
        return post.live
            ? `<div class="mt-3 flex items-center gap-2 flex-wrap">
                   <span class="inline-flex items-center gap-1.5 text-[10.5px] font-black uppercase tracking-wider text-white bg-[#e31b4a] px-2 py-1 rounded"><span class="w-1.5 h-1.5 rounded-full bg-white animate-pulse"></span>Live now</span>
                   <a href="${escHtml(liveUrl(post))}" class="inline-flex items-center gap-1.5 bg-[#0d1f35] hover:bg-[#2563eb] text-white font-bold py-1.5 px-3 rounded transition text-[12px]"><i class="fa-solid fa-tower-broadcast text-[10px]"></i>Return to Live Presenter</a>
               </div>`
            : `<div class="mt-3"><span class="inline-flex items-center gap-1.5 text-[10.5px] font-black uppercase tracking-wider text-[#6b84a0] bg-[#f0f4f8] px-2 py-1 rounded border border-[#dce3ed]"><i class="fa-solid fa-circle-stop text-[9px]"></i>Session ended${post.endedAt ? ' · ' + escHtml(formatDate(post.endedAt)) : ''}</span></div>`;
    }
    if (post.linkedLessonId) {
        return `<div class="mt-3"><span class="inline-flex items-center gap-1.5 text-[10.5px] font-black uppercase tracking-wider text-[#2563eb] bg-[#eef4ff] px-2 py-1 rounded border border-[#c7d9fd]"><i class="fa-solid fa-person-chalkboard text-[10px]"></i>Lesson post · students see an Open Lesson button</span></div>`;
    }
    return '';
}

function displayTitle(post) { return displayPostText(post).title; }

function renderPostCard(post) {
    const isLessonPlan = post.type === 'lesson_plan';
    const isLive = post.type === 'live_session';
    const isLiveNow = isLive && post.live;
    const iconBg = isLiveNow ? 'bg-[#fff0f3] text-[#e31b4a] border-[#fecaca]'
        : isLive || post.linkedLessonId ? 'bg-[#eef4ff] text-[#2563eb] border-[#c7d9fd]'
        : isLessonPlan ? 'bg-[#fef3c7] text-[#92400e] border-[#fde68a]' : 'bg-[#eef4ff] text-[#2563eb] border-[#c7d9fd]';
    const icon = isLive ? 'fa-tower-broadcast' : post.linkedLessonId ? 'fa-person-chalkboard' : isLessonPlan ? 'fa-calendar-days'
        : post.type === 'poll' ? 'fa-square-poll-horizontal' : post.type === 'question' ? 'fa-circle-question' : 'fa-bullhorn';
    if (post.type === 'poll') ensureRoster(post.classId, post.className);
    const cardTone = isLiveNow ? 'border-[#fecaca] ring-2 ring-[#fecaca]/60' : (isLive || post.linkedLessonId) ? 'border-[#c7d9fd]' : 'border-[#dce3ed]';
    const isQuestion = post.type === 'question';
    // Answers live in posts/{postId}/answers (live listener per question).
    if (isQuestion) watchAnswers(session.schoolId, post, { role: 'teacher', id: session.teacherId }, renderPostList);
    const href = discussionUrl(post);
    const text = displayPostText(post);

    return `
    <div class="post-card bg-white rounded-xl shadow-sm border ${cardTone} p-4" data-post-id="${escHtml(post.id)}" data-open-href="${escHtml(href)}">
        <div class="flex items-start justify-between gap-3">
            <div class="flex items-start gap-3 min-w-0">
                <div class="w-8 h-8 rounded ${iconBg} border flex items-center justify-center flex-shrink-0 mt-0.5">
                    <i class="fa-solid ${icon} text-sm"></i>
                </div>
                <div class="min-w-0 flex-1">
                    <div class="flex items-center gap-2 flex-wrap">
                        ${post.pinned ? '<i class="fa-solid fa-thumbtack text-[10px] text-[#e31b4a]" title="Pinned"></i>' : ''}
                        <p class="font-bold text-[#0d1f35] text-[14px] m-0"><a class="cs-title-link" href="${escHtml(href)}">${escHtml(text.title) || (isLessonPlan ? 'Untitled Lesson' : 'Announcement')}</a></p>
                        ${isLessonPlan && post.lessonDate ? `<span class="text-[10.5px] font-bold bg-[#fef3c7] text-[#92400e] px-2 py-0.5 rounded border border-[#fde68a]">${escHtml(formatDate(post.lessonDate))}</span>` : ''}
                        ${post.subjectName ? `<span class="text-[10.5px] font-bold bg-[#f0f4f8] text-[#6b84a0] px-2 py-0.5 rounded">${escHtml(post.subjectName)}</span>` : ''}
                    </div>
                    <p class="text-[10.5px] text-[#9ab0c6] font-semibold mt-1 mb-0">${escHtml(post.authorName || '')} · ${escHtml(formatDate(post.createdAt))}</p>
                    ${text.body ? `<p class="text-[12.5px] text-[#374f6b] mt-1.5 mb-0 cs-clamp">${escHtml(text.body)}</p>` : ''}
                    ${post.type === 'question' && post.question && post.question.blindReplies ? '<p class="mt-2 mb-0"><span class="inline-flex items-center gap-1.5 text-[10.5px] font-black uppercase tracking-wider text-[#6b84a0] bg-[#f0f4f8] px-2 py-1 rounded border border-[#dce3ed]"><i class="fa-solid fa-eye-slash text-[9px]"></i>Blind replies · students see answers after posting their own</span></p>' : ''}
                    ${pollHtml(post, { role: 'teacher', roster: rosterFor(post.classId) })}
                    ${renderSystemBanner(post)}
                    ${isQuestion ? '' : commentPillHtml(post, href)}
                </div>
            </div>
            <div class="flex items-center gap-1 flex-shrink-0">
                ${isLessonPlan || isLive ? '' : `
                <button data-action="edit" class="text-[#6b84a0] hover:text-[#2563eb] hover:bg-[#eef4ff] h-7 w-7 rounded flex items-center justify-center transition" title="Edit">
                    <i class="fa-solid fa-pen text-xs"></i>
                </button>`}
                <button data-action="delete" class="text-[#6b84a0] hover:text-[#e31b4a] hover:bg-[#fff0f3] h-7 w-7 rounded flex items-center justify-center transition" title="Delete">
                    <i class="fa-solid fa-trash text-xs"></i>
                </button>
            </div>
        </div>
        ${isQuestion ? commentsSectionHtml(answersView(post), { canComment: true, canDelete: () => true, discussionUrl }) : ''}
    </div>`;
}

async function onPostListClick(e) {
    if (openPostFromCardClick(e)) return; // card body → full post page (edit/delete are buttons, so excluded)
    if (await handlePollEvent(e, { schoolId: session.schoolId, findPost: (id) => postsCache.find(p => p.id === id) || null })) return;
    if (await handleCommentEvent(e, commentCfg())) return;
    const btn = e.target.closest('[data-action]');
    if (!btn) return;
    const card = e.target.closest('[data-post-id]');
    const postId = card && card.dataset.postId;
    const post = postsCache.find(p => p.id === postId);
    if (!post) return;

    if (btn.dataset.action === 'edit') {
        if (post.type === 'lesson_plan') return; // defense-in-depth: renderPostCard already omits this button for legacy lesson-plan posts
        beginEditPost(post);
    } else if (btn.dataset.action === 'delete') {
        if (!confirm(`Delete "${post.title || (post.type === 'lesson_plan' ? 'this lesson plan' : 'this announcement')}"? This cannot be undone.`)) return;
        try {
            await deletePost(session.schoolId, currentPostContext, postId);
            postsCache = postsCache.filter(p => p.id !== postId); // listener confirms
            if (editingPostId === postId) resetComposer();
            renderPostList();
        } catch (err) {
            console.error('[Stream] deletePost:', err);
            alert('Failed to delete this post. Please try again.');
        }
    }
}

init();
