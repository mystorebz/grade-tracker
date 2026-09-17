// ── ENTERPRISE LESSON REDESIGN, PHASE 1: TEACHER LESSON BUILDER ───────────
// Two builder UIs sharing one lesson list and one lessonDraft object:
//   - Slide Deck builder (#builderView): slide sidebar (thumbnails,
//     add/delete/reorder), center canvas (the selected slide's editable
//     content), right properties panel (that slide's type-specific fields).
//   - Document builder (#docBuilderView): a single scrolling Quill.js
//     rich-text page, Word/Docs-style, with a custom toolbar button for
//     inserting a non-editable "Linked Assignment" card inline.
// A single in-memory `lessonDraft` object mirrors the lessons/{lessonId}
// schema exactly (including its `format` field); every edit mutates it
// directly (or, in Document mode, mutates the live Quill instance, pulled
// back into lessonDraft only at save time — see currentSlidesForSave()).
import { requireAuth, awaitAuthReady } from '../../../assets/js/auth.js';
import { injectTeacherLayout } from '../../../assets/js/layout-teachers.js';
import { showMsg, loadTeacherSubjectsCache, getTeacherDocRef } from '../../../assets/js/utils.js';
import { resolvePostContext } from '../../../assets/js/posts.js';
import { db } from '../../../assets/js/firebase-init.js';
import { doc, setDoc, updateDoc } from "https://www.gstatic.com/firebasejs/10.7.1/firebase-firestore.js";
import {
    newSlide, newBlock, migrateLegacySlide, parseMediaUrl, isLikelyImageUrl,
    loadLesson, loadLessonPrivateNotes, loadLessonsForSubject,
    createLesson, saveLessonContent, saveLessonPrivateNotes,
    publishLesson, unpublishLesson, deleteLesson
} from '../../../assets/js/lessons.js';

// ── 1. AUTHENTICATION & LAYOUT ──────────────────────────────────────────────
const session = requireAuth('teacher', '../login.html');
if (session) {
    injectTeacherLayout('lessons', 'Lesson Builder', 'Build interactive slide-deck lessons for your subjects', false);
}

// ── 2. STATE ──────────────────────────────────────────────────────────────
let subjectsCache = [];        // merged legacy/new-model subjects, see utils.js
let resolvedClasses = [];      // this teacher's className(s) resolved to real classIds
let currentSubject = null;     // the subject object currently selected in the picker
let currentPostContext = null; // resolvePostContext(currentSubject, resolvedClasses)
let lessonsCache = [];         // every lesson for currentSubject, newest-first

let lessonDraft = null;        // the open lesson's full in-memory doc (schema-shaped)
let currentLessonId = null;    // null while on the picker view
let currentSlideIndex = 0;
let hasUnsavedChanges = false;

// SLIDE DECK REDESIGN: which block (by id) within the current 'blank'
// slide is selected — drives both the canvas's selection ring (see
// wireBlockSelection()) and what renderPropertiesPanel() shows. null means
// no block selected (nothing on the canvas is highlighted, and the panel
// shows a generic hint). Reset to null on every slide switch/add/delete —
// a selection never carries over to a different slide.
let currentBlockId = null;

// Document-format state — Quill is the live source of truth for document
// content while the editor is open; lessonDraft.slides[0].contentHtml is
// only synced from it at save time (see currentSlidesForSave()).
let quill = null;
let pendingAssignmentBlotRange = null; // where to insert once a picker selection is made
let openAssignmentViewId = null; // id of the assignment currently shown in the view/edit modal

// Slide Deck rich-text blocks (Text blocks — see newBlock('text') in
// lessons.js) — unlike Document mode's single long-lived `quill` instance
// above, each of these is a short-lived Quill instance tied to whichever
// Text block is currently on the canvas. renderSlideCanvas() rebuilds
// #slideCanvas's innerHTML from scratch on every slide switch/add/delete,
// which destroys these instances' DOM outright, so there is nothing to
// explicitly tear down — dropping the old references here (see
// wireBlockRichFields()) is enough to let them be garbage collected. Keyed
// by block id for whichever slide is currently on screen.
let slideFieldQuills = {};

// ── FIXED GLOBAL TEXT-FORMATTING TOOLBAR (#slideFormatToolbar) ──────────
// Every Text block's Quill instance is created with `toolbar: false` (see
// wireBlockRichFields()) — there is deliberately no per-block/contextual/
// floating toolbar inside the canvas. Formatting instead goes through the
// ONE toolbar docked in the fixed header (built by hand in builder.html,
// wired here), which always acts on whichever block is currently focused.
// activeQuill/activeQuillRange are that "currently focused" pointer: they
// are set the moment a block's Quill editor gets a real selection, and are
// deliberately left in place when the editor merely blurs (e.g. because
// the person just clicked a toolbar button) so a click on Bold never has
// to be preceded by re-clicking back into the text first — exactly how
// Google Slides' own docked toolbar behaves.
let activeQuill = null;
let activeQuillRange = null;

function setFormatToolbarEnabled(enabled) {
    if (!enabled) { activeQuill = null; activeQuillRange = null; }
    els.slideFormatToolbar.querySelectorAll('button, select, input').forEach(el => { el.disabled = !enabled; });
    els.slideFormatToolbar.classList.toggle('opacity-40', !enabled);
    els.slideFormatToolbar.classList.toggle('pointer-events-none', !enabled);
}

function updateFormatToolbarState() {
    if (!activeQuill) return;
    const range = activeQuill.getSelection() || activeQuillRange;
    const fmt = range ? activeQuill.getFormat(range) : {};
    els.fmtHeaderSelect.value = fmt.header ? String(fmt.header) : '';
    els.slideFormatToolbar.querySelectorAll('[data-fmt]').forEach(btn => {
        btn.classList.toggle('lb-format-btn-active', !!fmt[btn.dataset.fmt]);
    });
    els.slideFormatToolbar.querySelectorAll('[data-fmt-list]').forEach(btn => {
        btn.classList.toggle('lb-format-btn-active', fmt.list === btn.dataset.fmtList);
    });
    els.slideFormatToolbar.querySelectorAll('[data-fmt-align]').forEach(btn => {
        btn.classList.toggle('lb-format-btn-active', (fmt.align || '') === btn.dataset.fmtAlign);
    });
}

// Brings focus + selection back to whichever block was last active — used
// before applying a format from a control (the header <select>, the color
// pickers) whose own native interaction necessarily blurred the editor.
function restoreActiveSelection() {
    if (!activeQuill) return;
    activeQuill.focus();
    if (activeQuillRange) activeQuill.setSelection(activeQuillRange, 'silent');
}

function wireFormatToolbar() {
    // Plain toolbar buttons (Bold/Italic/.../Clear): preventDefault on
    // mousedown keeps the editor's own selection intact right through the
    // click — the same trick Quill's own toolbar module uses internally —
    // so format() always applies to what was actually selected rather than
    // to nothing (focus would otherwise jump to the button first).
    els.slideFormatToolbar.querySelectorAll('button.lb-format-btn').forEach(btn => {
        btn.addEventListener('mousedown', (e) => e.preventDefault());
    });

    els.slideFormatToolbar.querySelectorAll('[data-fmt]').forEach(btn => {
        btn.addEventListener('click', () => {
            if (!activeQuill) return;
            const name = btn.dataset.fmt;
            const range = activeQuill.getSelection() || activeQuillRange;
            if (name === 'link') {
                if (!range || !range.length) { alert('Select some text first to add a link.'); return; }
                const url = prompt('Link URL:');
                if (url) activeQuill.format('link', url);
            } else if (name === 'clean') {
                if (range) activeQuill.removeFormat(range.index, range.length);
            } else {
                const current = activeQuill.getFormat(range || undefined);
                activeQuill.format(name, !current[name]);
            }
            activeQuillRange = activeQuill.getSelection() || activeQuillRange;
            updateFormatToolbarState();
        });
    });

    els.slideFormatToolbar.querySelectorAll('[data-fmt-list]').forEach(btn => {
        btn.addEventListener('click', () => {
            if (!activeQuill) return;
            const value = btn.dataset.fmtList;
            const current = activeQuill.getFormat(activeQuill.getSelection() || activeQuillRange || undefined);
            activeQuill.format('list', current.list === value ? false : value);
            updateFormatToolbarState();
        });
    });

    els.slideFormatToolbar.querySelectorAll('[data-fmt-align]').forEach(btn => {
        btn.addEventListener('click', () => {
            if (!activeQuill) return;
            activeQuill.format('align', btn.dataset.fmtAlign || false);
            updateFormatToolbarState();
        });
    });

    els.fmtHeaderSelect.addEventListener('change', () => {
        if (!activeQuill) return;
        restoreActiveSelection();
        activeQuill.format('header', els.fmtHeaderSelect.value ? Number(els.fmtHeaderSelect.value) : false);
        updateFormatToolbarState();
    });

    els.fmtColorInput.addEventListener('input', () => {
        if (!activeQuill) return;
        restoreActiveSelection();
        activeQuill.format('color', els.fmtColorInput.value);
    });
    els.fmtBgInput.addEventListener('input', () => {
        if (!activeQuill) return;
        restoreActiveSelection();
        activeQuill.format('background', els.fmtBgInput.value);
    });

    setFormatToolbarEnabled(false);
}

// ── SLIDE DECK VISUAL THEMES ───────────────────────────────────────────────
// Purely cosmetic — an accent color + icon applied to the slide stage and
// thumbnail rail (see .lb-slide-stage / renderSlideThumbPreviewHtml()), same
// idea as Google Slides' own Theme picker. Labeled by subject vibe so a
// teacher can find one that feels right at a glance, but any theme can be
// used for any lesson — nothing here is enforced against the lesson's
// actual subject. `lessonDraft.theme` stores just the key; THEMES[key] is
// looked up wherever it's needed, always falling back to 'general' so an
// unrecognized or missing key (every lesson saved before this feature
// existed) never throws — see currentTheme().
const THEMES = {
    general: { label: 'General', accent: '#2563eb', accentSoft: '#eef4ff', icon: 'fa-chalkboard' },
    science: { label: 'Science', accent: '#0d9488', accentSoft: '#f0fdfa', icon: 'fa-flask' },
    math: { label: 'Math', accent: '#7c3aed', accentSoft: '#f5f3ff', icon: 'fa-calculator' },
    language_arts: { label: 'Language Arts', accent: '#b45309', accentSoft: '#fffbeb', icon: 'fa-book-open' },
    history: { label: 'History', accent: '#b91c1c', accentSoft: '#fef2f2', icon: 'fa-landmark' },
    art: { label: 'Art', accent: '#db2777', accentSoft: '#fdf2f8', icon: 'fa-palette' }
};

function currentTheme() {
    return THEMES[lessonDraft?.theme] || THEMES.general;
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

function formatDate(iso) {
    if (!iso) return '';
    try {
        return new Date(iso).toLocaleDateString(undefined, { month: 'short', day: 'numeric', year: 'numeric' });
    } catch (e) { return iso; }
}

// ── 3. INITIALIZATION ───────────────────────────────────────────────────────
async function init() {
    if (!session) return;

    cacheEls();
    wireEvents();

    // Wait for the auth-identity-drift check to actually resolve before
    // firing any Firestore read/write. requireAuth()'s own drift check is
    // fire-and-forget (it can't block a synchronous call), so without this,
    // a browser profile whose Firebase Auth session drifted to a different
    // role in another tab (see auth.js's checkAuthDrift) would race ahead —
    // loadTeacherSubjectsCache/loadLessonsForSubject fire immediately, hit
    // real "Missing or insufficient permissions" errors, and the page limps
    // along broken until the drift check's own logout() catches up moments
    // later. Waiting here means the redirect happens first, cleanly, with
    // no failed reads and no confusing permission errors in between.
    const authOk = await awaitAuthReady('teacher', '../login.html');
    if (!authOk) return; // logout()/redirect already under way

    els.subjectSelect.innerHTML = '<option value="">Loading subjects…</option>';
    const result = await loadTeacherSubjectsCache(session.schoolId, session.teacherId, session.teacherData);
    subjectsCache = result.subjectsCache;
    resolvedClasses = result.resolvedClasses;

    renderSubjectOptions();

    // Deep-link support: teacher/subjects/subjects.js's Lessons tab (and the
    // "+ Create New Lesson" button there) links here with
    // ?subjectId=&classId=&subjectName=&lessonId= — the same querystring
    // shape lessons/live.js already reads. classId/subjectName are accepted
    // but not read below: onSubjectChange() re-resolves the full postContext
    // itself from resolvedClasses once subjectId is selected, so they'd be
    // redundant here. Only pre-selects the subject and, once its lessons have
    // loaded, opens one specific lesson — it never auto-opens the "new
    // lesson" format-choice modal, so landing here from Subjects never pops
    // up an unexpected modal on load.
    const deepLinkParams = new URLSearchParams(window.location.search);
    const urlSubjectId = deepLinkParams.get('subjectId');
    const urlLessonId = deepLinkParams.get('lessonId');
    if (urlSubjectId && [...els.subjectSelect.options].some(o => o.value === urlSubjectId)) {
        els.subjectSelect.value = urlSubjectId;
    }

    await onSubjectChange();

    if (urlLessonId && lessonsCache.some(l => l.id === urlLessonId)) {
        await openBuilder(urlLessonId);
    }
}

function cacheEls() {
    [
        'lessonPickerView', 'builderView', 'docBuilderView',
        'subjectSelect', 'newLessonBtn', 'lessonListCount', 'lessonList',
        'backToListBtn', 'slideThumbList', 'addSlideBtn', 'addCollabBoardBtn',
        'lessonTitleInput', 'statusPill', 'saveMsg', 'notesBtn', 'saveBtn', 'publishBtn', 'publishBtnLabel',
        'slideCanvas', 'propertiesPanel',
        // SLIDE DECK REDESIGN: persistent insert toolbar + its Image/Video/
        // Theme popovers — see wireInsertToolbar()/wireThemeMenu().
        'slideInsertToolbar',
        'insertImageBtn', 'insertImageMenu', 'insertImageUploadRow',
        'insertImageUrlInput', 'insertImageUrlBtn', 'insertImageFileInput',
        'insertVideoBtn', 'insertVideoMenu', 'insertVideoUrlInput', 'insertVideoUrlBtn', 'insertVideoError',
        'themeBtn', 'themeBtnDot', 'themeMenu',
        // Fixed global text-formatting toolbar (replaces the old per-block
        // in-canvas Quill toolbar) — see wireFormatToolbar().
        'slideFormatToolbar', 'fmtHeaderSelect', 'fmtColorInput', 'fmtBgInput',
        'docBackToListBtn', 'docLessonTitleInput', 'docStatusPill', 'docSaveMsg',
        'docNotesBtn', 'docSaveBtn', 'docPublishBtn', 'docPublishBtnLabel',
        'docToolbar', 'docEditor',
        'formatChoiceOverlay', 'closeFormatChoiceBtn',
        'importOptionsBtn', 'importOptionsOverlay', 'importOptionsPanel', 'closeImportOptionsBtn',
        'importDocxInput', 'importDocxTrigger', 'importDocxStatus',
        'importSlidesUrlInput', 'importSlidesBtn', 'importSlidesStatus',
        'importPptxInput', 'importPptxTrigger', 'importPptxStatus',
        'assignmentPickerOverlay', 'assignmentPickerPanel', 'closeAssignmentPickerBtn', 'assignmentPickerList',
        'notesOverlay', 'pacingNotesInput', 'standardsInput', 'closeNotesBtn', 'cancelNotesBtn', 'saveNotesBtn',
        'assignmentViewOverlay', 'assignmentViewPanel', 'closeAssignmentViewBtn',
        'assignmentViewTitle', 'assignmentViewMeta', 'assignmentViewInstructions',
        'assignmentViewSaveBtn', 'assignmentViewMsg'
    ].forEach(id => { els[id] = document.getElementById(id); });
}

function wireEvents() {
    els.subjectSelect.addEventListener('change', onSubjectChange);
    els.newLessonBtn.addEventListener('click', openFormatChoiceModal);
    els.lessonList.addEventListener('click', onLessonListClick);

    // ── Format choice modal ──
    els.closeFormatChoiceBtn.addEventListener('click', closeFormatChoiceModal);
    els.formatChoiceOverlay.addEventListener('click', (e) => {
        if (e.target === els.formatChoiceOverlay) closeFormatChoiceModal();
    });
    document.querySelectorAll('.format-choice-btn').forEach(btn => {
        btn.addEventListener('click', () => onCreateLesson(btn.dataset.format));
    });

    // ── Slide builder top bar ──
    els.backToListBtn.addEventListener('click', () => {
        if (hasUnsavedChanges && !confirm('You have unsaved changes. Leave without saving?')) return;
        closeBuilder();
    });

    // SLIDE DECK REDESIGN: "Add Slide" is now always a plain blank slide
    // (content is added afterward from the persistent insert toolbar), and
    // Collaborative Board is its own dedicated action — see
    // addBlankSlide()/addCollaborativeBoardSlide() below.
    els.addSlideBtn.addEventListener('click', () => addBlankSlide());
    els.addCollabBoardBtn.addEventListener('click', () => addCollaborativeBoardSlide());

    els.slideThumbList.addEventListener('click', onSlideThumbClick);

    wireInsertToolbar();
    wireThemeMenu();
    wireFormatToolbar();

    els.lessonTitleInput.addEventListener('input', () => {
        lessonDraft.title = els.lessonTitleInput.value;
        hasUnsavedChanges = true;
        renderSlideThumbs(); // thumbnail list doesn't show title, but keep state consistent
    });

    els.saveBtn.addEventListener('click', onSaveDraft);
    els.publishBtn.addEventListener('click', onPublishToggle);

    els.notesBtn.addEventListener('click', openNotesModal);

    // ── Document builder top bar (mirrors the Slide bar's handlers) ──
    els.docBackToListBtn.addEventListener('click', () => {
        if (hasUnsavedChanges && !confirm('You have unsaved changes. Leave without saving?')) return;
        closeBuilder();
    });

    els.docLessonTitleInput.addEventListener('input', () => {
        lessonDraft.title = els.docLessonTitleInput.value;
        hasUnsavedChanges = true;
    });

    els.docSaveBtn.addEventListener('click', onSaveDraft);
    els.docPublishBtn.addEventListener('click', onPublishToggle);
    els.docNotesBtn.addEventListener('click', openNotesModal);

    // ── Teacher-only notes modal (shared by both formats) ──
    els.closeNotesBtn.addEventListener('click', closeNotesModal);
    els.cancelNotesBtn.addEventListener('click', closeNotesModal);
    els.saveNotesBtn.addEventListener('click', onSaveNotes);

    // ── Assignment-embed picker (Document mode only) ──
    els.closeAssignmentPickerBtn.addEventListener('click', closeAssignmentPicker);
    els.assignmentPickerOverlay.addEventListener('click', (e) => {
        if (e.target === els.assignmentPickerOverlay) closeAssignmentPicker();
    });
    els.assignmentPickerList.addEventListener('click', onAssignmentPickerClick);

    // ── Assignment-embed view/edit modal (Document mode only) ──
    els.closeAssignmentViewBtn?.addEventListener('click', closeAssignmentViewModal);
    els.assignmentViewOverlay?.addEventListener('click', (e) => {
        if (e.target === els.assignmentViewOverlay) closeAssignmentViewModal();
    });
    els.assignmentViewSaveBtn?.addEventListener('click', onSaveAssignmentViewEdits);

    // ── Import Options modal ──
    els.importOptionsBtn.addEventListener('click', openImportOptionsModal);
    els.closeImportOptionsBtn.addEventListener('click', closeImportOptionsModal);
    els.importOptionsOverlay.addEventListener('click', (e) => {
        if (e.target === els.importOptionsOverlay) closeImportOptionsModal();
    });
    els.importDocxTrigger.addEventListener('click', () => els.importDocxInput.click());
    els.importDocxInput.addEventListener('change', onImportDocxFileSelected);
    els.importSlidesBtn.addEventListener('click', onImportSlidesClick);

    // ── PowerPoint (.pptx) import — upload + clipboard-paste ──
    els.importPptxTrigger.addEventListener('click', () => els.importPptxInput.click());
    els.importPptxInput.addEventListener('change', onImportPptxFileSelected);
    // Document-wide (not scoped to the modal's DOM) because a 'paste'
    // event only fires on a focused, pasteable target by default — the
    // modal has no such target for this. onImportPptxPaste itself checks
    // whether the modal is actually open before doing anything, so this is
    // a no-op everywhere else on the page (e.g. pasting text into the
    // lesson title input is untouched).
    document.addEventListener('paste', onImportPptxPaste);
}

// ── 4. SUBJECT SELECTION ─────────────────────────────────────────────────
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

    if (!currentSubject) {
        currentPostContext = null;
        lessonsCache = [];
        renderLessonList();
        return;
    }

    currentPostContext = resolvePostContext(currentSubject, resolvedClasses);
    if (!currentPostContext) {
        lessonsCache = [];
        renderLessonList("Couldn't resolve this subject to a class — check your class assignment in Settings.");
        return;
    }

    els.lessonList.innerHTML = '<div class="text-center py-10 text-[#9ab0c6] text-[13px] font-bold"><i class="fa-solid fa-spinner fa-spin text-[#2563eb] text-2xl mb-3 block"></i>Loading lessons…</div>';
    try {
        lessonsCache = await loadLessonsForSubject(session.schoolId, currentPostContext);
    } catch (e) {
        console.error('[Lesson Builder] loadLessonsForSubject:', e);
        lessonsCache = [];
    }
    renderLessonList();
}

// ── 5. LESSON PICKER LIST ────────────────────────────────────────────────
function renderLessonList(emptyMessage) {
    els.lessonListCount.textContent = `${lessonsCache.length} lesson${lessonsCache.length === 1 ? '' : 's'}`;

    if (!lessonsCache.length) {
        els.lessonList.innerHTML = `<div class="text-center py-10 text-[#9ab0c6] text-[13px] font-bold bg-white rounded-xl border border-[#dce3ed]">
            ${escHtml(emptyMessage || (currentSubject ? 'No lessons yet for this subject.' : 'Select a subject above to see its lessons.'))}
        </div>`;
        return;
    }

    els.lessonList.innerHTML = lessonsCache.map(renderLessonCard).join('');
}

function renderLessonCard(lesson) {
    const isPublished = lesson.status === 'published';
    const pillClasses = isPublished
        ? 'bg-[#ecfdf5] text-[#059669] border-[#a7f3d0]'
        : 'bg-[#f4f7fb] text-[#6b84a0] border-[#dce3ed]';
    const isDocument = lesson.format === 'document';
    const slideCount = (lesson.slides || []).length;
    const metaLabel = isDocument ? 'Document' : `${slideCount} slide${slideCount === 1 ? '' : 's'}`;
    const formatIcon = isDocument ? 'fa-file-lines' : 'fa-images';

    return `
    <div class="lesson-card bg-white rounded-xl shadow-sm border border-[#dce3ed] p-4 flex items-center justify-between gap-3" data-lesson-id="${escHtml(lesson.id)}">
        <div class="min-w-0 cursor-pointer flex-1 flex items-center gap-3" data-action="open">
            <div class="w-8 h-8 rounded-lg bg-[#eef4ff] text-[#2563eb] border border-[#c7d9fd] flex items-center justify-center flex-shrink-0">
                <i class="fa-solid ${formatIcon} text-[12px]"></i>
            </div>
            <div class="min-w-0">
                <div class="flex items-center gap-2 flex-wrap mb-1">
                    <p class="font-bold text-[#0d1f35] text-[14px] m-0">${escHtml(lesson.title) || 'Untitled Lesson'}</p>
                    <span class="text-[10px] font-black uppercase tracking-wide px-2 py-0.5 rounded-md border ${pillClasses}">${isPublished ? 'Published' : 'Draft'}</span>
                </div>
                <p class="text-[11px] text-[#9ab0c6] font-semibold m-0">${metaLabel} · Updated ${escHtml(formatDate(lesson.updatedAt))}</p>
            </div>
        </div>
        ${isPublished ? `
        <button data-action="golive" class="text-[#6b84a0] hover:text-[#0d9488] hover:bg-[#f0fdfa] h-8 w-8 rounded flex items-center justify-center transition flex-shrink-0" title="Go Live">
            <i class="fa-solid fa-tower-broadcast text-xs"></i>
        </button>` : ''}
        <button data-action="delete" class="text-[#6b84a0] hover:text-[#e31b4a] hover:bg-[#fff0f3] h-8 w-8 rounded flex items-center justify-center transition flex-shrink-0" title="Delete">
            <i class="fa-solid fa-trash text-xs"></i>
        </button>
    </div>`;
}

async function onLessonListClick(e) {
    const card = e.target.closest('[data-lesson-id]');
    if (!card) return;
    const lessonId = card.dataset.lessonId;
    const btn = e.target.closest('[data-action]');
    if (!btn) return;

    if (btn.dataset.action === 'open') {
        await openBuilder(lessonId);
    } else if (btn.dataset.action === 'golive') {
        // New tab, not a same-tab navigation: the teacher's own builder/
        // lesson-list state is left exactly as it was, same reasoning as any
        // other "open in a new context" action elsewhere in this app.
        const params = new URLSearchParams({
            lessonId,
            classId: currentPostContext.classId,
            subjectId: currentPostContext.subjectId,
            subjectName: currentPostContext.subjectName || ''
        });
        window.open(`../lessons/live.html?${params.toString()}`, '_blank');
    } else if (btn.dataset.action === 'delete') {
        const lesson = lessonsCache.find(l => l.id === lessonId);
        if (!confirm(`Delete "${lesson?.title || 'this lesson'}"? This cannot be undone.`)) return;
        try {
            await deleteLesson(session.schoolId, currentPostContext, lessonId);
            lessonsCache = lessonsCache.filter(l => l.id !== lessonId);
            renderLessonList();
        } catch (err) {
            console.error('[Lesson Builder] deleteLesson:', err);
            alert('Failed to delete this lesson. Please try again.');
        }
    }
}

// ── 6. FORMAT CHOICE MODAL + CREATE ──────────────────────────────────────
function openFormatChoiceModal() {
    if (!currentPostContext) { alert('Select a subject first.'); return; }
    els.formatChoiceOverlay.classList.remove('hidden');
}

function closeFormatChoiceModal() {
    els.formatChoiceOverlay.classList.add('hidden');
}

async function onCreateLesson(format) {
    closeFormatChoiceModal();
    try {
        const authorContext = { authorId: session.teacherId, authorName: session.teacherData.name };
        const lesson = await createLesson(session.schoolId, currentPostContext, authorContext, { title: 'Untitled Lesson', format });
        lessonsCache.unshift(lesson);
        await openBuilder(lesson.id);
    } catch (e) {
        console.error('[Lesson Builder] createLesson:', e);
        alert('Failed to create a new lesson. Please try again.');
    }
}

// ── 7. OPEN / CLOSE BUILDER ──────────────────────────────────────────────
async function openBuilder(lessonId) {
    try {
        const lesson = await loadLesson(session.schoolId, currentPostContext, lessonId);
        if (!lesson) {
            alert('This lesson could not be found. It may have just been deleted.');
            return;
        }
        lessonDraft = lesson;
        currentLessonId = lessonId;
        currentSlideIndex = 0;
        currentBlockId = null;
        hasUnsavedChanges = false;

        els.lessonPickerView.classList.add('hidden');

        if (lessonDraft.format === 'document') {
            els.builderView.classList.add('hidden');
            els.builderView.classList.remove('flex');
            els.docBuilderView.classList.remove('hidden');
            els.docBuilderView.classList.add('flex');
            renderDocAll();
        } else {
            els.docBuilderView.classList.add('hidden');
            els.docBuilderView.classList.remove('flex');
            els.builderView.classList.remove('hidden');
            els.builderView.classList.add('flex');
            renderAll();
        }
    } catch (e) {
        console.error('[Lesson Builder] openBuilder:', e);
        alert('Failed to open this lesson. Please try again.');
    }
}

function closeBuilder() {
    lessonDraft = null;
    currentLessonId = null;
    hasUnsavedChanges = false;

    els.builderView.classList.add('hidden');
    els.builderView.classList.remove('flex');
    els.docBuilderView.classList.add('hidden');
    els.docBuilderView.classList.remove('flex');
    els.lessonPickerView.classList.remove('hidden');

    // Refresh the list so title/status/slide-count edits made in the
    // builder are reflected immediately without a full page reload.
    onSubjectChange();
}

// Single format-aware bridge between whichever UI is live and what actually
// gets persisted: for Slides mode, lessonDraft.slides is already kept live
// by the per-field mutation handlers below, so it's returned as-is. For
// Document mode, Quill (not lessonDraft) is the live source of truth while
// the editor is open, so its current HTML is pulled into the lesson's
// single richtext block right before saving.
function currentSlidesForSave() {
    if (lessonDraft.format === 'document') {
        const block = lessonDraft.slides[0] || newSlide('richtext');
        block.contentHtml = quill ? quill.root.innerHTML : (block.contentHtml || '');
        lessonDraft.slides = [block];
    }
    return lessonDraft.slides;
}

function renderAll() {
    els.lessonTitleInput.value = lessonDraft.title || '';
    renderStatusPill();
    renderPublishButton();
    renderSlideThumbs();
    renderSlideCanvas();
    renderPropertiesPanel();
}

function renderStatusPill() {
    const isPublished = lessonDraft.status === 'published';
    const label = isPublished ? 'Published' : 'Draft';
    const classes = 'text-[10px] font-black uppercase tracking-wide px-2.5 py-1 rounded-md flex-shrink-0 whitespace-nowrap ' +
        (isPublished ? 'bg-[#ecfdf5] text-[#059669] border border-[#a7f3d0]' : 'bg-[#f4f7fb] text-[#6b84a0] border border-[#dce3ed]');
    els.statusPill.textContent = label;
    els.statusPill.className = classes;
    els.docStatusPill.textContent = label;
    els.docStatusPill.className = classes;
}

function renderPublishButton() {
    const isPublished = lessonDraft.status === 'published';
    els.publishBtnLabel.textContent = isPublished ? 'Unpublish' : 'Publish';
    els.docPublishBtnLabel.textContent = isPublished ? 'Unpublish' : 'Publish';
    [els.publishBtn, els.docPublishBtn].forEach(btn => {
        btn.classList.toggle('bg-[#0d1f35]', !isPublished);
        btn.classList.toggle('hover:bg-[#2563eb]', !isPublished);
        btn.classList.toggle('bg-white', isPublished);
        btn.classList.toggle('text-[#0d1f35]', isPublished);
        btn.classList.toggle('border', isPublished);
        btn.classList.toggle('border-[#dce3ed]', isPublished);
        btn.classList.toggle('text-white', !isPublished);
    });
}

// ── 8. SLIDE SIDEBAR (thumbnails, select, delete, reorder) ───────────────
function renderSlideThumbs() {
    els.slideThumbList.innerHTML = lessonDraft.slides.map((slide, i) => renderSlideThumb(slide, i)).join('');
}

// SLIDE DECK REDESIGN: slides no longer have a fixed "type" that implies an
// icon — a 'blank' slide's icon is now inferred from what it actually
// contains (its first image/video/interactive/assignment block), falling
// back to a generic page icon for a text-only or empty slide.
// collaborative_board remains the one special whole-slide type.
function slideThumbIcon(slide) {
    if (slide.type === 'collaborative_board') return 'fa-people-group';
    const blocks = slide.blocks || [];
    const firstMedia = blocks.find(b => b.type === 'image' || b.type === 'video');
    if (firstMedia) return firstMedia.type === 'image' ? 'fa-image' : 'fa-video';
    const firstInteractive = blocks.find(b => b.type === 'interactive_prompt' || b.type === 'assignment');
    if (firstInteractive) return firstInteractive.type === 'interactive_prompt' ? 'fa-bolt' : 'fa-clipboard-check';
    return 'fa-file-lines';
}

// Plain-text thumbnail label — the first non-empty Text block's content
// (HTML-stripped), since a slide no longer carries its own dedicated
// `heading` field (that was the old fixed-type schema's job). Falls back to
// a generic label per slide state. Shown as the small caption line below
// the live visual preview (renderSlideThumbPreviewHtml()) — the caption is
// deliberately plain text (not scaled HTML) since it needs to stay legible
// at 10.5px, unlike the preview box above it.
function slideThumbLabel(slide) {
    if (slide.type === 'collaborative_board') return slide.heading?.trim() || 'Collaboration Board';
    const firstText = (slide.blocks || []).find(b => b.type === 'text' && b.html && b.html.replace(/<[^>]*>/g, '').trim());
    if (firstText) {
        const stripped = firstText.html.replace(/<[^>]*>/g, ' ').replace(/\s+/g, ' ').trim();
        if (stripped) return stripped.slice(0, 60);
    }
    return (slide.blocks || []).length ? 'Slide' : 'Blank Slide';
}

function renderSlideThumb(slide, i) {
    const isActive = i === currentSlideIndex;
    // Active-thumb accent follows the lesson's own theme (Task #9) — via
    // inline style, not a Tailwind arbitrary-value class, since the color
    // is only known at runtime and inline style is the same reliable
    // pattern already used for the theme swatches/button dot above.
    const theme = currentTheme();
    const activeStyle = isActive ? `style="border-color:${theme.accent}; background:${theme.accentSoft};"` : '';
    return `
    <div class="slide-thumb group relative rounded-lg border p-1.5 cursor-pointer transition ${isActive ? '' : 'border-[#dce3ed] bg-white hover:border-[#9ab0c6]'}"
         ${activeStyle} data-slide-index="${i}" draggable="true">
        <div class="slide-thumb-preview rounded bg-white" style="border-top: 3px solid ${theme.accent};">
            ${renderSlideThumbPreviewHtml(slide, theme)}
        </div>
        <div class="flex items-center gap-1.5 mt-1.5 px-0.5">
            <span class="text-[10px] font-black text-[#9ab0c6] w-3.5 flex-shrink-0">${i + 1}</span>
            <i class="fa-solid ${slideThumbIcon(slide)} text-[9.5px] flex-shrink-0" ${isActive ? `style="color:${theme.accent}"` : 'style="color:#9ab0c6"'}></i>
            <span class="text-[10.5px] font-bold ${isActive ? 'text-[#0d1f35]' : 'text-[#374f6b]'} truncate flex-1">${escHtml(slideThumbLabel(slide))}</span>
            ${lessonDraft.slides.length > 1 ? `<button data-action="delete-slide" data-slide-index="${i}" class="opacity-0 group-hover:opacity-100 text-[#9ab0c6] hover:text-[#e31b4a] flex-shrink-0 transition"><i class="fa-solid fa-xmark text-[11px]"></i></button>` : ''}
        </div>
    </div>`;
}

// SLIDE DECK REDESIGN (Task #6): a true scaled-down rendering of the
// slide's own blocks, Google-Slides-style, rendered at real thumbnail
// size (see .slide-thumb-preview's comment in builder.html for why no
// transform/scale trick is needed). This intentionally does NOT try to
// pixel-match the real canvas's layout (spacing, exact font sizes) — the
// goal is a glance-level "shape" of the slide (what kind of content is on
// it and roughly where), same level of fidelity Google Slides' own
// thumbnail rail gives at this size, not a miniature replica.
function renderSlideThumbPreviewHtml(slide, theme) {
    if (slide.type === 'collaborative_board') {
        return `
        <div class="w-full h-full flex flex-col items-center justify-center gap-1 p-2" style="background:${theme.accentSoft};">
            <i class="fa-solid fa-people-group" style="color:${theme.accent}; font-size:13px;"></i>
            <p class="slide-thumb-clip text-center font-bold m-0" style="font-size:6px; line-height:1.2; color:#374f6b; -webkit-line-clamp:2;">${escHtml(slide.heading?.trim() || 'Collaboration Board')}</p>
        </div>`;
    }
    const blocks = slide.blocks || [];
    if (!blocks.length) {
        return `<div class="w-full h-full flex items-center justify-center"><span class="text-[8px] font-semibold text-[#c2cedd]">Empty slide</span></div>`;
    }
    // Only the first few blocks are shown — a long slide's later content
    // would be clipped by the box's fixed height anyway, so rendering more
    // is wasted work.
    return `<div class="w-full h-full overflow-hidden p-1.5 flex flex-col gap-1">${blocks.slice(0, 4).map(renderThumbBlockHtml).join('')}</div>`;
}

function renderThumbBlockHtml(block) {
    switch (block.type) {
        case 'image':
            return block.imageUrl
                ? `<img src="${escHtml(block.imageUrl)}" alt="" class="w-full rounded object-cover flex-shrink-0" style="height:20px;" onerror="this.replaceWith(Object.assign(document.createElement('div'), {className:'w-full rounded bg-slate-100 flex-shrink-0', style:'height:20px'}))">`
                : `<div class="w-full rounded bg-slate-100 flex items-center justify-center flex-shrink-0" style="height:20px;"><i class="fa-solid fa-image text-[8px] text-slate-300"></i></div>`;
        case 'video':
            return `<div class="w-full rounded bg-slate-100 flex items-center justify-center flex-shrink-0" style="height:20px;"><i class="fa-solid fa-circle-play text-[9px] text-slate-300"></i></div>`;
        case 'interactive_prompt':
            return `<div class="flex items-center gap-1 rounded bg-indigo-50 px-1 py-0.5 flex-shrink-0"><i class="fa-solid fa-bolt text-[6.5px] text-indigo-400 flex-shrink-0"></i><span class="text-[6px] font-bold text-indigo-500 truncate">${escHtml(block.promptText || 'Interactive prompt')}</span></div>`;
        case 'assignment':
            return `<div class="flex items-center gap-1 rounded bg-amber-50 px-1 py-0.5 flex-shrink-0"><i class="fa-solid fa-clipboard-check text-[6.5px] text-amber-500 flex-shrink-0"></i><span class="text-[6px] font-bold text-amber-600 truncate">${escHtml(block.prompt || 'Assignment')}</span></div>`;
        case 'text':
        default:
            return block.html
                ? `<div class="ql-editor slide-thumb-clip" style="padding:0; font-size:5px; line-height:1.3; color:#374f6b;">${block.html}</div>`
                : '';
    }
}

function onSlideThumbClick(e) {
    const delBtn = e.target.closest('[data-action="delete-slide"]');
    if (delBtn) {
        e.stopPropagation();
        const idx = Number(delBtn.dataset.slideIndex);
        if (!confirm('Delete this slide?')) return;
        lessonDraft.slides.splice(idx, 1);
        if (currentSlideIndex >= lessonDraft.slides.length) currentSlideIndex = lessonDraft.slides.length - 1;
        currentBlockId = null;
        hasUnsavedChanges = true;
        renderSlideThumbs();
        renderSlideCanvas();
        renderPropertiesPanel();
        return;
    }

    const thumb = e.target.closest('[data-slide-index]');
    if (!thumb) return;
    currentSlideIndex = Number(thumb.dataset.slideIndex);
    currentBlockId = null;
    renderSlideThumbs();
    renderSlideCanvas();
    renderPropertiesPanel();
}

// Drag-to-reorder: minimal HTML5 drag/drop, no library. Reordering is
// entirely an in-memory array splice — persisted on the next Save Draft,
// same as every other edit in this builder.
let dragFromIndex = null;
document.addEventListener('dragstart', (e) => {
    const thumb = e.target.closest('[data-slide-index]');
    if (!thumb || !els.slideThumbList.contains(thumb)) return;
    dragFromIndex = Number(thumb.dataset.slideIndex);
});
document.addEventListener('dragover', (e) => {
    const thumb = e.target.closest('[data-slide-index]');
    if (!thumb || !els.slideThumbList.contains(thumb) || dragFromIndex === null) return;
    e.preventDefault();
});
document.addEventListener('drop', (e) => {
    const thumb = e.target.closest('[data-slide-index]');
    if (!thumb || !els.slideThumbList.contains(thumb) || dragFromIndex === null) return;
    e.preventDefault();
    const toIndex = Number(thumb.dataset.slideIndex);
    if (toIndex === dragFromIndex) { dragFromIndex = null; return; }

    const [moved] = lessonDraft.slides.splice(dragFromIndex, 1);
    lessonDraft.slides.splice(toIndex, 0, moved);
    if (currentSlideIndex === dragFromIndex) currentSlideIndex = toIndex;
    dragFromIndex = null;
    hasUnsavedChanges = true;
    renderSlideThumbs();
});

// SLIDE DECK REDESIGN: "Add Slide" is a plain blank slide (content is added
// afterward from the persistent insert toolbar — see wireInsertToolbar());
// "Add Collaboration Board" stays its own dedicated action since that slide
// type is special and whole-slide, never blocks-based (see newSlide()'s own
// comment in lessons.js for why).
function addBlankSlide() {
    const slide = newSlide('blank');
    lessonDraft.slides.splice(currentSlideIndex + 1, 0, slide);
    currentSlideIndex += 1;
    currentBlockId = null;
    hasUnsavedChanges = true;
    renderSlideThumbs();
    renderSlideCanvas();
    renderPropertiesPanel();
}

function addCollaborativeBoardSlide() {
    const slide = newSlide('collaborative_board');
    lessonDraft.slides.splice(currentSlideIndex + 1, 0, slide);
    currentSlideIndex += 1;
    currentBlockId = null;
    hasUnsavedChanges = true;
    renderSlideThumbs();
    renderSlideCanvas();
    renderPropertiesPanel();
}

// ── 9. SLIDE CANVAS (center pane — the fixed 16:9 stage) ──────────────────
// SLIDE DECK REDESIGN: a 'blank' slide's canvas is now just its blocks[]
// stacked top-to-bottom, each inserted from the persistent toolbar above
// (see wireInsertToolbar()) rather than picked as a whole-slide "type" up
// front. collaborative_board remains the one special whole-slide type — its
// own renderer (renderCollaborativeBoardCanvas, unchanged in content) is
// still used directly, with no blocks/toolbar involved.
function currentSlide() {
    return lessonDraft.slides[currentSlideIndex] || null;
}

function currentBlock() {
    const slide = currentSlide();
    if (!slide || slide.type !== 'blank') return null;
    return (slide.blocks || []).find(b => b.id === currentBlockId) || null;
}

function fieldWrap(label, inputHtml) {
    return `<div class="mb-4"><label class="block text-[10px] font-bold text-[#6b84a0] uppercase tracking-widest mb-1.5">${label}</label>${inputHtml}</div>`;
}

function renderSlideCanvas() {
    // Any re-render replaces #slideCanvas's innerHTML wholesale, which
    // destroys every Quill instance currently on screen — reset the fixed
    // format toolbar's "currently focused block" pointer unconditionally,
    // on every branch below, so it can never end up pointing at a Quill
    // instance whose DOM no longer exists. wireBlockRichFields() re-arms it
    // the moment a Text block on the new canvas actually gets focus.
    setFormatToolbarEnabled(false);

    let slide = currentSlide();
    if (!slide) { els.slideCanvas.innerHTML = ''; els.slideInsertToolbar.classList.add('hidden'); return; }

    // Safety net: a slide that hasn't gone through migrateLegacySlide() yet
    // — e.g. one just created in-memory this session by the PPTX importer
    // or the "Import Presentation" embed-link flow (still emit the OLD
    // fixed-type shape as of this writing) — is converted in place here so
    // the canvas never has to know about the old shapes at all. Every
    // *loaded* lesson is already migrated by lessons.js's loadLesson().
    if (slide.type !== 'blank' && slide.type !== 'collaborative_board') {
        slide = migrateLegacySlide(slide);
        lessonDraft.slides[currentSlideIndex] = slide;
    }

    applyThemeToStage();

    if (slide.type === 'collaborative_board') {
        els.slideInsertToolbar.classList.add('hidden');
        els.slideInsertToolbar.classList.remove('flex');
        els.slideCanvas.innerHTML = renderCollaborativeBoardCanvas(slide);
        wireCollaborativeBoardInputs(slide);
        return;
    }

    els.slideInsertToolbar.classList.remove('hidden');
    els.slideInsertToolbar.classList.add('flex');
    renderThemeMenu();

    const blocks = slide.blocks || [];
    if (!blocks.length) {
        els.slideCanvas.innerHTML = `
        <div class="h-full min-h-[280px] flex items-center justify-center">
            <div class="text-center text-[#9ab0c6] max-w-xs">
                <i class="fa-solid fa-wand-magic-sparkles text-3xl mb-3 block"></i>
                <p class="text-[13px] font-bold text-[#374f6b] mb-1">This slide is empty</p>
                <p class="text-[11.5px] font-semibold">Use the toolbar above to add text, an image, a video, or interactive content.</p>
            </div>
        </div>`;
        return;
    }

    els.slideCanvas.innerHTML = blocks.map(renderBlock).join('');
    wireBlockSelection(slide);
    wireBlockRichFields(slide);
    wireBlockInputs(slide);
}

// Applies the current lesson theme's accent color to the stage as a CSS
// custom property — read by .lb-slide-stage's border-top (see
// builder.html) and, in future, the sidebar thumbnails (Task #9). Purely
// cosmetic; see THEMES/currentTheme() near the top of this file.
function applyThemeToStage() {
    els.slideCanvas.style.setProperty('--lb-accent', currentTheme().accent);
}

// Whether a video/image block's URL field currently fails validation —
// keyed by BLOCK id (was slide id before this redesign, back when a slide
// itself was the media item), for the same reason as before: this is pure
// transient UI state (never saved), and renderSlideCanvas() rebuilds the
// canvas's innerHTML wholesale on every insert/delete/reorder, so a handler
// that reached into the old DOM and toggled a hidden class directly would
// lose that change the instant the next render rebuilt the element fresh.
const blockUrlInvalid = new Map();

// One wrapper per block: the hover/selection ring, and the small floating
// move-up/move-down/delete toolbar (Google Slides-style per-element
// controls) — every block type shares this shell; only what's inside
// differs. See wireBlockSelection() for how clicking a block (vs. its own
// inner controls) sets currentBlockId.
function blockWrap(block, innerHtml) {
    const selected = block.id === currentBlockId;
    return `
    <div class="lb-block ${selected ? 'lb-block-selected' : ''}" data-block-id="${escHtml(block.id)}">
        <div class="lb-block-toolbar">
            <button type="button" data-block-action="up" title="Move up"><i class="fa-solid fa-arrow-up"></i></button>
            <button type="button" data-block-action="down" title="Move down"><i class="fa-solid fa-arrow-down"></i></button>
            <button type="button" data-block-action="delete" title="Delete"><i class="fa-solid fa-trash"></i></button>
        </div>
        ${innerHtml}
    </div>`;
}

function renderBlock(block) {
    switch (block.type) {
        case 'image': return renderImageBlock(block);
        case 'video': return renderVideoBlock(block);
        case 'interactive_prompt': return renderInteractivePromptBlock(block);
        case 'assignment': return renderAssignmentBlock(block);
        case 'text':
        default: return renderTextBlock(block);
    }
}

function renderTextBlock(block) {
    return blockWrap(block, `<div data-rich-block="${escHtml(block.id)}" class="lb-rich-field"></div>`);
}

function renderImageBlock(block) {
    // onerror swaps the broken <img> for the same placeholder markup an
    // image block already shows with no URL — a dead/incorrect image link
    // degrades to "couldn't load" rather than a browser broken-image icon.
    const preview = block.imageUrl
        ? `<img src="${escHtml(block.imageUrl)}" alt="${escHtml(block.imageAlt)}"
               class="w-full max-h-[280px] object-contain rounded-lg border border-[#dce3ed] bg-[#f4f7fb]"
               onerror="this.nextElementSibling.classList.remove('hidden'); this.classList.add('hidden');">
           <div class="hidden w-full h-[180px] bg-[#fff0f3] rounded-lg border border-dashed border-[#e31b4a] flex items-center justify-center text-[#e31b4a]">
               <div class="text-center"><i class="fa-solid fa-triangle-exclamation text-2xl mb-1.5 block"></i><p class="text-[11.5px] font-semibold">This image link couldn't be loaded</p></div>
           </div>`
        : `<div class="w-full h-[180px] bg-[#f4f7fb] rounded-lg border border-dashed border-[#dce3ed] flex items-center justify-center text-[#9ab0c6]">
             <div class="text-center"><i class="fa-solid fa-image text-2xl mb-1.5 block"></i><p class="text-[11.5px] font-semibold">No image yet — set one from the panel on the right</p></div>
           </div>`;
    const caption = block.caption ? `<p class="text-[11.5px] text-[#6b84a0] font-semibold text-center mt-1.5">${escHtml(block.caption)}</p>` : '';
    return blockWrap(block, `${preview}${caption}`);
}

function renderVideoBlock(block) {
    const preview = block.embedUrl
        ? `<div class="aspect-video w-full bg-black rounded-lg overflow-hidden border border-[#dce3ed]">
             <iframe src="${escHtml(block.embedUrl)}" class="w-full h-full" frameborder="0" allowfullscreen></iframe>
           </div>`
        : `<div class="aspect-video w-full bg-[#f4f7fb] rounded-lg border border-dashed border-[#dce3ed] flex items-center justify-center text-[#9ab0c6]">
             <div class="text-center"><i class="fa-solid fa-video text-2xl mb-1.5 block"></i><p class="text-[11.5px] font-semibold">No video yet — set one from the panel on the right</p></div>
           </div>`;
    const caption = block.caption ? `<p class="text-[11.5px] text-[#6b84a0] font-semibold text-center mt-1.5">${escHtml(block.caption)}</p>` : '';
    return blockWrap(block, `${preview}${caption}`);
}

// ── PHASE 3: LIVE SESSION ENGINE — block/canvas renderers ─────────────────
// Interactive Prompt and Assignment (like Collaborative Board) are LIVE-ONLY
// or submission-only: their student-facing form only ever renders inside an
// active live_sessions document (interactive_prompt — see lessons/live.js's
// teacher dashboard and lessons/viewer.js's student auto-follow view) or the
// real assignment/submission workflow (assignment — see viewer.js). What's
// authored here is purely the block's own content (prompt text / choices),
// plus, for interactive_prompt, a static banner explaining that the
// interactive part only appears once a live session is started from this
// lesson's card in the Lesson Builder list (see onLessonListClick's
// 'golive' branch).
function liveOnlyBanner(text) {
    return `
    <p class="text-[11.5px] text-[#6b84a0] font-semibold bg-[#f4f7fb] border border-[#dce3ed] rounded-lg px-3 py-2.5 mt-2">
        <i class="fa-solid fa-tower-broadcast mr-1.5 text-[#2563eb]"></i>${text}
    </p>`;
}

function renderInteractivePromptBlock(block) {
    const isMultipleChoice = block.promptKind === 'multiple_choice';
    const choicesHtml = (block.choices || []).map((choice, i) => `
        <div class="flex items-center gap-2 mb-2" data-choice-row="${i}">
            <input data-choice-index="${i}" type="text" value="${escHtml(choice)}" placeholder="Choice ${i + 1}"
                   class="form-input flex-1 p-2 bg-white border border-[#dce3ed] rounded text-[13px] text-[#0d1f35] outline-none focus:border-[#2563eb]">
            <button type="button" data-remove-choice="${i}" class="text-[#9ab0c6] hover:text-[#e31b4a] w-7 h-7 flex-shrink-0 flex items-center justify-center transition">
                <i class="fa-solid fa-xmark text-[12px]"></i>
            </button>
        </div>`).join('');

    return blockWrap(block, `
        <span class="lb-live-badge inline-flex items-center gap-1.5 text-[10.5px] font-black uppercase tracking-wide px-2.5 py-1 rounded-full bg-[#eef2ff] text-[#4338ca] border border-[#c7d2fe] mb-3">
            <i class="fa-solid fa-bolt"></i> Interactive Prompt
        </span>
        ${fieldWrap('Prompt Text', `<textarea data-block-field="promptText" rows="3" placeholder="What question do you want students to answer?" class="form-input w-full p-3 bg-white border border-[#dce3ed] rounded text-[13.5px] text-[#0d1f35] outline-none focus:border-[#2563eb] resize-none leading-relaxed">${escHtml(block.promptText)}</textarea>`)}

        <div class="flex items-center gap-1 bg-[#f4f7fb] border border-[#dce3ed] rounded-lg p-1 w-fit mb-3">
            <button type="button" data-prompt-kind="short_answer" class="px-3 py-1.5 rounded text-[12px] font-bold transition ${!isMultipleChoice ? 'bg-white text-[#0d1f35] shadow-sm' : 'text-[#6b84a0]'}">
                <i class="fa-solid fa-keyboard text-[11px] mr-1"></i>Short Answer
            </button>
            <button type="button" data-prompt-kind="multiple_choice" class="px-3 py-1.5 rounded text-[12px] font-bold transition ${isMultipleChoice ? 'bg-white text-[#0d1f35] shadow-sm' : 'text-[#6b84a0]'}">
                <i class="fa-solid fa-list-check text-[11px] mr-1"></i>Multiple Choice
            </button>
        </div>

        ${isMultipleChoice ? `
        <div class="mb-2">
            <label class="block text-[10px] font-bold text-[#6b84a0] uppercase tracking-widest mb-1.5">Choices</label>
            <div data-choices-list>${choicesHtml}</div>
            <button type="button" data-add-choice class="text-[#2563eb] hover:text-[#1d4ed8] text-[12px] font-bold mt-1">
                <i class="fa-solid fa-plus mr-1"></i>Add Choice
            </button>
        </div>` : ''}

        ${liveOnlyBanner('Students answer this privately — only you see individual responses. This only works during a live session (use the broadcast icon on the lesson list).')}
    `);
}

function renderAssignmentBlock(block) {
    return blockWrap(block, `
        <span class="lb-live-badge inline-flex items-center gap-1.5 text-[10.5px] font-black uppercase tracking-wide px-2.5 py-1 rounded-full bg-[#eef4ff] text-[#2563eb] border border-[#c7d9fd] mb-3">
            <i class="fa-solid fa-clipboard-check"></i> Assignment
        </span>
        ${fieldWrap('Prompt', `<textarea data-block-field="prompt" rows="4" placeholder="What should students do on this slide?" class="form-input w-full p-3 bg-white border border-[#dce3ed] rounded text-[13.5px] text-[#0d1f35] outline-none focus:border-[#2563eb] resize-none leading-relaxed">${escHtml(block.prompt)}</textarea>`)}
        <p class="text-[11.5px] text-[#6b84a0] font-semibold"><i class="fa-solid fa-circle-info mr-1"></i>Pick which assignment this submits to in the panel on the right.</p>
    `);
}

// Collaborative Board — UNCHANGED content/behavior, still a special
// whole-slide type (never blocks-based). Only its outer wrapper changed:
// #slideCanvas IS the white bordered stage now (see .lb-slide-stage in
// builder.html), so this no longer draws its own nested white card.
function renderCollaborativeBoardCanvas(slide) {
    return `
    <div class="min-h-full flex flex-col justify-center">
        <span class="lb-live-badge inline-flex items-center gap-1.5 text-[10.5px] font-black uppercase tracking-wide px-2.5 py-1 rounded-full bg-[#f0fdfa] text-[#0f766e] border border-[#99f6e4] mb-3 w-fit">
            <i class="fa-solid fa-people-group"></i> Collaborative Board
        </span>
        ${fieldWrap('Heading', `<input data-field="heading" type="text" value="${escHtml(slide.heading)}" placeholder="e.g. Share One Idea" class="form-input w-full p-2.5 bg-white border border-[#dce3ed] rounded text-[16px] font-bold text-[#0d1f35] outline-none focus:border-[#2563eb]">`)}
        ${fieldWrap('Instructions', `<textarea data-field="instructions" rows="3" placeholder="What should students post to the board?" class="form-input w-full p-3 bg-white border border-[#dce3ed] rounded text-[13.5px] text-[#0d1f35] outline-none focus:border-[#2563eb] resize-none leading-relaxed">${escHtml(slide.instructions)}</textarea>`)}
        ${liveOnlyBanner("Every connected student's card is visible to the whole class in real time. This only works during a live session (use the broadcast icon on the lesson list).")}
    </div>`;
}

function wireCollaborativeBoardInputs(slide) {
    els.slideCanvas.querySelectorAll('[data-field]').forEach(input => {
        input.addEventListener('input', () => {
            slide[input.dataset.field] = input.value;
            hasUnsavedChanges = true;
            renderSlideThumbs();
        });
    });
}

// Instantiates a Quill editor over every [data-rich-block] container the
// just-rendered canvas contains (one per Text block on this slide — every
// other block type has none). Must run AFTER els.slideCanvas.innerHTML has
// been set — Quill needs the target element already attached to the
// document. Mirrors the old per-FIELD wireRichFields(), generalized to
// per-BLOCK: a slide can now hold any number of Text blocks, not just one
// fixed heading/objective/body field.
function wireBlockRichFields(slide) {
    slideFieldQuills = {};
    // Every re-render tears down the previous slide's Quill instances (see
    // this function's own top-of-file comment) — any pointer the fixed
    // format toolbar was holding onto is now stale, so it's reset here
    // unconditionally and only re-armed once a block on the NEW canvas
    // actually receives a selection (below).
    setFormatToolbarEnabled(false);

    els.slideCanvas.querySelectorAll('[data-rich-block]').forEach(container => {
        const blockId = container.dataset.richBlock;
        const block = (slide.blocks || []).find(b => b.id === blockId);
        if (!block) return;

        // toolbar: false — no per-block/contextual/floating toolbar inside
        // the canvas. All formatting goes through the one fixed toolbar
        // docked in the header (wireFormatToolbar()), which this editor's
        // selection-change handler below points at itself whenever it's
        // the one focused.
        const editor = new Quill(container, { theme: 'snow', modules: { toolbar: false } });
        editor.root.innerHTML = block.html || '';
        editor.history.clear();

        editor.on('text-change', (delta, oldDelta, source) => {
            if (source !== 'user') return;
            block.html = editor.root.innerHTML;
            hasUnsavedChanges = true;
            renderSlideThumbs(); // the first Text block's content drives the thumbnail label
            if (activeQuill === editor) updateFormatToolbarState();
        });
        // Clicking into a Text block to edit it also selects it (so the
        // block-management toolbar shows and it visually reads as
        // "selected") and hands this editor to the fixed format toolbar —
        // without a full canvas re-render that would tear down this very
        // editor.
        editor.on('selection-change', (range) => {
            if (!range) return;
            activeQuill = editor;
            activeQuillRange = range;
            setFormatToolbarEnabled(true);
            updateFormatToolbarState();
            if (currentBlockId !== blockId) {
                currentBlockId = blockId;
                els.slideCanvas.querySelectorAll('[data-block-id]').forEach(w => w.classList.toggle('lb-block-selected', w.dataset.blockId === blockId));
                renderPropertiesPanel();
            }
        });

        slideFieldQuills[blockId] = editor;
    });
}

// Selecting a block only updates the DOM's selection classes + the
// properties panel — never a full renderSlideCanvas() — so clicking a
// block never interrupts an actively-focused Quill editor inside another
// Text block on the same slide. The move-up/move-down/delete actions DO
// re-render (nothing is mid-edit when you click a toolbar icon).
function wireBlockSelection(slide) {
    els.slideCanvas.querySelectorAll('[data-block-id]').forEach(wrap => {
        wrap.addEventListener('mousedown', (e) => {
            if (e.target.closest('[data-block-action]')) return; // handled below
            const id = wrap.dataset.blockId;
            // A non-Text block has no Quill editor of its own to hand the
            // fixed format toolbar to — disable it (its own Quill selection-
            // change handler is what re-enables it, for a Text block).
            const block = (slide.blocks || []).find(b => b.id === id);
            if (block && block.type !== 'text') setFormatToolbarEnabled(false);
            if (id === currentBlockId) return;
            currentBlockId = id;
            els.slideCanvas.querySelectorAll('[data-block-id]').forEach(w => w.classList.toggle('lb-block-selected', w.dataset.blockId === id));
            renderPropertiesPanel();
        });
    });

    els.slideCanvas.querySelectorAll('[data-block-action]').forEach(btn => {
        btn.addEventListener('click', (e) => {
            e.stopPropagation();
            const wrap = btn.closest('[data-block-id]');
            const id = wrap.dataset.blockId;
            const idx = slide.blocks.findIndex(b => b.id === id);
            if (idx === -1) return;
            const action = btn.dataset.blockAction;
            if (action === 'delete') {
                slide.blocks.splice(idx, 1);
                if (currentBlockId === id) currentBlockId = null;
                blockUrlInvalid.delete(id);
            } else if (action === 'up' && idx > 0) {
                [slide.blocks[idx - 1], slide.blocks[idx]] = [slide.blocks[idx], slide.blocks[idx - 1]];
            } else if (action === 'down' && idx < slide.blocks.length - 1) {
                [slide.blocks[idx + 1], slide.blocks[idx]] = [slide.blocks[idx], slide.blocks[idx + 1]];
            }
            hasUnsavedChanges = true;
            renderSlideCanvas();
            renderPropertiesPanel();
            renderSlideThumbs();
        });
    });
}

// Interactive Prompt / Assignment blocks' own inline authoring fields —
// mirrors the old wireCanvasInputs(), scoped to whichever block each input
// lives inside (a slide can now hold more than one of these, unlike the
// old one-type-per-slide schema).
function wireBlockInputs(slide) {
    const blockFor = (el) => {
        const wrap = el.closest('[data-block-id]');
        return wrap ? (slide.blocks || []).find(b => b.id === wrap.dataset.blockId) : null;
    };

    els.slideCanvas.querySelectorAll('[data-block-field]').forEach(input => {
        input.addEventListener('input', () => {
            const block = blockFor(input);
            if (!block) return;
            block[input.dataset.blockField] = input.value;
            hasUnsavedChanges = true;
        });
    });

    // Interactive Prompt: Short Answer / Multiple Choice toggle. Switching
    // to 'short_answer' intentionally leaves choices untouched (so flipping
    // back to 'multiple_choice' doesn't lose what was typed).
    els.slideCanvas.querySelectorAll('[data-prompt-kind]').forEach(btn => {
        btn.addEventListener('click', () => {
            const block = blockFor(btn);
            if (!block) return;
            const kind = btn.dataset.promptKind;
            if (block.promptKind === kind) return;
            block.promptKind = kind;
            if (kind === 'multiple_choice' && !(block.choices || []).length) {
                block.choices = ['', ''];
            }
            hasUnsavedChanges = true;
            currentBlockId = block.id;
            renderSlideCanvas();
        });
    });

    els.slideCanvas.querySelectorAll('[data-add-choice]').forEach(btn => {
        btn.addEventListener('click', () => {
            const block = blockFor(btn);
            if (!block) return;
            block.choices = [...(block.choices || []), ''];
            hasUnsavedChanges = true;
            currentBlockId = block.id;
            renderSlideCanvas();
        });
    });

    els.slideCanvas.querySelectorAll('[data-choice-index]').forEach(input => {
        input.addEventListener('input', () => {
            const block = blockFor(input);
            if (!block) return;
            const i = Number(input.dataset.choiceIndex);
            if (!Array.isArray(block.choices)) block.choices = [];
            block.choices[i] = input.value;
            hasUnsavedChanges = true;
        });
    });

    els.slideCanvas.querySelectorAll('[data-remove-choice]').forEach(btn => {
        btn.addEventListener('click', () => {
            const block = blockFor(btn);
            if (!block) return;
            const i = Number(btn.dataset.removeChoice);
            block.choices = (block.choices || []).filter((_, idx) => idx !== i);
            hasUnsavedChanges = true;
            currentBlockId = block.id;
            renderSlideCanvas();
        });
    });
}

// ── SLIDE DECK REDESIGN: persistent insert toolbar ────────────────────────
// Text/Interactive Prompt/Assignment insert directly; Image/Video open a
// small popover first since those need a source before there's anything to
// show — Image mirrors Google Slides' own Insert > Image submenu (Upload
// from computer / By URL / paste-anywhere). Only ever active while a
// 'blank' slide is on screen (the toolbar itself is hidden for the special
// Collaborative Board slide type — see renderSlideCanvas()).
function insertBlock(type, extraProps) {
    const slide = currentSlide();
    if (!slide || slide.type !== 'blank') return null;
    const block = newBlock(type);
    if (extraProps) Object.assign(block, extraProps);
    const afterIndex = currentBlockId ? slide.blocks.findIndex(b => b.id === currentBlockId) : slide.blocks.length - 1;
    slide.blocks.splice(afterIndex + 1, 0, block);
    currentBlockId = block.id;
    hasUnsavedChanges = true;
    renderSlideCanvas();
    renderPropertiesPanel();
    renderSlideThumbs();
    // A newly-inserted block may be below the fold on a long slide — bring
    // it into view, and hand a fresh Text block focus immediately (matching
    // "Insert > Text" landing you ready to type, same as Slides/Docs).
    requestAnimationFrame(() => {
        els.slideCanvas.querySelector(`[data-block-id="${block.id}"]`)?.scrollIntoView({ block: 'nearest' });
        if (type === 'text') slideFieldQuills[block.id]?.focus();
    });
    return block;
}

function closeAllInsertPopovers() {
    els.insertImageMenu.classList.add('hidden');
    els.insertVideoMenu.classList.add('hidden');
    els.themeMenu.classList.add('hidden');
}

function wireInsertToolbar() {
    els.slideInsertToolbar.addEventListener('click', (e) => {
        const btn = e.target.closest('[data-insert]');
        if (!btn) return;
        closeAllInsertPopovers();
        insertBlock(btn.dataset.insert);
    });

    // ── Image: Upload from computer / By URL ──
    els.insertImageBtn.addEventListener('click', (e) => {
        e.stopPropagation();
        const wasOpen = !els.insertImageMenu.classList.contains('hidden');
        closeAllInsertPopovers();
        els.insertImageMenu.classList.toggle('hidden', wasOpen);
    });
    els.insertImageUploadRow.addEventListener('click', () => els.insertImageFileInput.click());
    els.insertImageFileInput.addEventListener('change', async () => {
        const file = els.insertImageFileInput.files?.[0];
        els.insertImageFileInput.value = '';
        if (!file) return;
        const dataUrl = await fileToDataUrl(file);
        if (dataUrl) insertBlock('image', { imageUrl: dataUrl, imageAlt: file.name.replace(/\.[^.]+$/, '') });
        closeAllInsertPopovers();
    });
    els.insertImageUrlBtn.addEventListener('click', () => {
        const url = els.insertImageUrlInput.value.trim();
        if (!url) return;
        insertBlock('image', { imageUrl: url });
        els.insertImageUrlInput.value = '';
        closeAllInsertPopovers();
    });

    // ── Video: URL only — unchanged YouTube/Vimeo/Drive parsing ──
    els.insertVideoBtn.addEventListener('click', (e) => {
        e.stopPropagation();
        const wasOpen = !els.insertVideoMenu.classList.contains('hidden');
        closeAllInsertPopovers();
        els.insertVideoMenu.classList.toggle('hidden', wasOpen);
        if (!wasOpen) els.insertVideoUrlInput.focus();
    });
    els.insertVideoUrlBtn.addEventListener('click', () => {
        const url = els.insertVideoUrlInput.value.trim();
        const parsed = parseMediaUrl(url);
        if (!url || !parsed) {
            els.insertVideoError.classList.remove('hidden');
            return;
        }
        insertBlock('video', { provider: parsed.provider, mediaUrl: url, embedUrl: parsed.embedUrl });
        els.insertVideoUrlInput.value = '';
        els.insertVideoError.classList.add('hidden');
        closeAllInsertPopovers();
    });

    // Close any open popover when clicking elsewhere on the page.
    document.addEventListener('click', (e) => {
        if (e.target.closest('#insertImageBtn, #insertImageMenu, #insertVideoBtn, #insertVideoMenu, #themeBtn, #themeMenu')) return;
        closeAllInsertPopovers();
    });

    // "Copy and paste the image" — pasting an image anywhere on the slide
    // stage (while a 'blank' slide is open) inserts it as a new Image
    // block, the same zero-extra-step gesture Google Slides offers.
    // Scoped to the canvas so pasting text into a Text block's own Quill
    // editor is completely unaffected — Quill handles that paste itself;
    // this listener only ever acts on actual image clipboard data.
    els.slideCanvas.addEventListener('paste', async (e) => {
        const slide = currentSlide();
        if (!slide || slide.type !== 'blank') return;
        const items = e.clipboardData?.items || [];
        const imageItem = [...items].find(it => it.type.startsWith('image/'));
        if (!imageItem) return; // let Quill (or nothing) handle a plain-text paste as usual
        e.preventDefault();
        const file = imageItem.getAsFile();
        if (!file) return;
        const dataUrl = await fileToDataUrl(file);
        if (dataUrl) insertBlock('image', { imageUrl: dataUrl });
    });
}

// FileReader → base64 data: URL — used by the Image toolbar's "Upload from
// computer" row, the paste-to-insert handler above, and the Image block's
// own "Upload from computer" button in the properties panel. No Storage
// upload pipeline exists in ConnectUs (see the PPTX importer's own images,
// inlined the exact same way), so describeSaveFailure() already has a
// specific, actionable error message for the Firestore 1MB document cap
// this can run into on a large image — same safety net as the PPTX path.
function fileToDataUrl(file) {
    return new Promise((resolve) => {
        const reader = new FileReader();
        reader.onload = () => resolve(reader.result);
        reader.onerror = () => resolve(null);
        reader.readAsDataURL(file);
    });
}

// ── SLIDE DECK REDESIGN: theme popover ─────────────────────────────────────
function renderThemeMenu() {
    els.themeBtnDot.style.background = currentTheme().accent;
    els.themeMenu.innerHTML = Object.entries(THEMES).map(([key, theme]) => `
        <button type="button" data-theme-key="${key}" class="lb-theme-swatch ${(lessonDraft.theme || 'general') === key ? 'lb-theme-selected' : ''}" title="${escHtml(theme.label)}">
            <span class="lb-theme-swatch-dot" style="background:${theme.accent}"></span>
            <span class="text-[9.5px] font-bold text-[#374f6b]">${escHtml(theme.label)}</span>
        </button>`).join('');
}

function wireThemeMenu() {
    els.themeBtn.addEventListener('click', (e) => {
        e.stopPropagation();
        const wasOpen = !els.themeMenu.classList.contains('hidden');
        closeAllInsertPopovers();
        els.themeMenu.classList.toggle('hidden', wasOpen);
    });
    els.themeMenu.addEventListener('click', (e) => {
        const btn = e.target.closest('[data-theme-key]');
        if (!btn) return;
        lessonDraft.theme = btn.dataset.themeKey;
        hasUnsavedChanges = true;
        applyThemeToStage();
        renderThemeMenu();
        renderSlideThumbs();
        closeAllInsertPopovers();
    });
}

// ── 10. PROPERTIES PANEL (right pane — the SELECTED BLOCK's extra fields) ─
// SLIDE DECK REDESIGN: block-scoped now, not slide-scoped. A 'blank'
// slide's own content lives entirely in its blocks (edited directly on the
// canvas), so this panel only ever shows the selected block's source/config
// fields — the ones that aren't naturally "click and type on the slide" (an
// image/video's URL, which assignment a slide submits to). Text and
// Interactive Prompt blocks have nothing here, same as the old builder's
// Title/Content/Interactive Prompt slides never populated this panel either.
function renderPropertiesPanel() {
    const slide = currentSlide();
    if (!slide) { els.propertiesPanel.innerHTML = ''; return; }

    if (slide.type === 'collaborative_board') {
        els.propertiesPanel.innerHTML = `
        <p class="text-[10px] font-bold text-[#6b84a0] uppercase tracking-widest mb-3">Slide Properties</p>
        <p class="text-[12px] text-[#9ab0c6] font-semibold">This slide type has no additional properties — everything is edited on the canvas.</p>`;
        return;
    }

    const block = currentBlock();
    if (!block) {
        els.propertiesPanel.innerHTML = `
        <p class="text-[10px] font-bold text-[#6b84a0] uppercase tracking-widest mb-3">Slide Properties</p>
        <p class="text-[12px] text-[#9ab0c6] font-semibold">${(slide.blocks || []).length ? 'Select a block on the slide to see its properties.' : 'Use the toolbar above to add content to this slide.'}</p>`;
        return;
    }

    if (block.type === 'image') {
        renderImageBlockProperties(block);
    } else if (block.type === 'video') {
        renderVideoBlockProperties(block);
    } else if (block.type === 'assignment') {
        renderAssignmentBlockProperties(block);
    } else {
        els.propertiesPanel.innerHTML = `
        <p class="text-[10px] font-bold text-[#6b84a0] uppercase tracking-widest mb-3">Block Properties</p>
        <p class="text-[12px] text-[#9ab0c6] font-semibold">This block has no additional properties — everything is edited directly on the slide.</p>`;
    }
}

function renderImageBlockProperties(block) {
    els.propertiesPanel.innerHTML = `
    <p class="text-[10px] font-bold text-[#6b84a0] uppercase tracking-widest mb-3">Image</p>
    ${fieldWrap('Image URL', `<input id="blockImageUrlInput" type="url" value="${escHtml(block.imageUrl)}" placeholder="https://example.com/photo.jpg" class="form-input w-full p-2.5 bg-white border border-[#dce3ed] rounded text-[13px] text-[#0d1f35] outline-none focus:border-[#2563eb]">`)}
    <button type="button" id="blockImageUploadBtn" class="w-full mb-4 -mt-2.5 bg-[#f4f7fb] hover:bg-[#eef4ff] text-[#0d1f35] font-bold py-2 px-3 rounded text-[12px] border border-[#dce3ed] transition flex items-center justify-center gap-2">
        <i class="fa-solid fa-upload"></i> Upload from computer
    </button>
    <input type="file" id="blockImageUploadInput" accept="image/*" class="hidden">
    ${fieldWrap('Alt Text', `<input id="blockImageAltInput" type="text" value="${escHtml(block.imageAlt)}" placeholder="Describe the image for screen readers" class="form-input w-full p-2.5 bg-white border border-[#dce3ed] rounded text-[13px] text-[#0d1f35] outline-none focus:border-[#2563eb]">`)}
    ${fieldWrap('Caption', `<input id="blockImageCaptionInput" type="text" value="${escHtml(block.caption)}" placeholder="Optional caption" class="form-input w-full p-2.5 bg-white border border-[#dce3ed] rounded text-[13px] text-[#0d1f35] outline-none focus:border-[#2563eb]">`)}
    <p class="text-[11px] text-[#9ab0c6] font-semibold leading-relaxed">
        <i class="fa-solid fa-circle-info mr-1"></i>
        Paste a direct image link, upload a file, or paste (Ctrl/Cmd+V) an image directly onto the slide.
    </p>`;

    document.getElementById('blockImageUrlInput').addEventListener('input', (e) => {
        block.imageUrl = e.target.value;
        blockUrlInvalid.set(block.id, !!e.target.value.trim() && !isLikelyImageUrl(e.target.value));
        hasUnsavedChanges = true;
        renderSlideCanvas(); // re-render to update the live image preview
        renderPropertiesPanel();
    });
    document.getElementById('blockImageUploadBtn').addEventListener('click', () => document.getElementById('blockImageUploadInput').click());
    document.getElementById('blockImageUploadInput').addEventListener('change', async (e) => {
        const file = e.target.files?.[0];
        e.target.value = '';
        if (!file) return;
        const dataUrl = await fileToDataUrl(file);
        if (dataUrl) {
            block.imageUrl = dataUrl;
            hasUnsavedChanges = true;
            renderSlideCanvas();
            renderPropertiesPanel();
        }
    });
    document.getElementById('blockImageAltInput').addEventListener('input', (e) => {
        block.imageAlt = e.target.value;
        hasUnsavedChanges = true;
        // No canvas re-render needed — alt text isn't visible in the
        // preview itself, only in the <img alt> attribute.
    });
    document.getElementById('blockImageCaptionInput').addEventListener('input', (e) => {
        block.caption = e.target.value;
        hasUnsavedChanges = true;
        renderSlideCanvas();
    });
}

function renderVideoBlockProperties(block) {
    els.propertiesPanel.innerHTML = `
    <p class="text-[10px] font-bold text-[#6b84a0] uppercase tracking-widest mb-3">Video</p>
    ${fieldWrap('Video URL', `<input id="blockVideoUrlInput" type="url" value="${escHtml(block.mediaUrl)}" placeholder="https://youtube.com/watch?v=..." class="form-input w-full p-2.5 bg-white border border-[#dce3ed] rounded text-[13px] text-[#0d1f35] outline-none focus:border-[#2563eb]">`)}
    <p class="text-[11px] font-bold text-[#e31b4a] mb-3 ${blockUrlInvalid.get(block.id) ? '' : 'hidden'}">Couldn't recognize that as a YouTube, Vimeo, or Google Drive link.</p>
    ${fieldWrap('Caption', `<input id="blockVideoCaptionInput" type="text" value="${escHtml(block.caption)}" placeholder="Optional caption" class="form-input w-full p-2.5 bg-white border border-[#dce3ed] rounded text-[13px] text-[#0d1f35] outline-none focus:border-[#2563eb]">`)}
    <p class="text-[11px] text-[#9ab0c6] font-semibold leading-relaxed">
        <i class="fa-solid fa-circle-info mr-1"></i>
        Paste a full YouTube, Vimeo, or Google Drive link. It's parsed into a safe embed automatically — raw video files aren't supported; only external links.
    </p>`;

    document.getElementById('blockVideoUrlInput').addEventListener('input', (e) => {
        const parsed = parseMediaUrl(e.target.value);
        block.mediaUrl = e.target.value;
        if (e.target.value.trim() && !parsed) {
            block.provider = null;
            block.embedUrl = '';
            blockUrlInvalid.set(block.id, true);
        } else {
            block.provider = parsed?.provider || null;
            block.embedUrl = parsed?.embedUrl || '';
            blockUrlInvalid.set(block.id, false);
        }
        hasUnsavedChanges = true;
        renderSlideCanvas(); // re-render to update the live embed preview + error message
        renderPropertiesPanel();
    });
    document.getElementById('blockVideoCaptionInput').addEventListener('input', (e) => {
        block.caption = e.target.value;
        hasUnsavedChanges = true;
        renderSlideCanvas();
    });
}

function renderAssignmentBlockProperties(block) {
    const assignments = (currentSubject?.assignments || []).filter(a => !a.archived);
    const options = ['<option value="">Select an assignment…</option>']
        .concat(assignments.map(a => `<option value="${escHtml(a.id)}" ${block.linkedAssignmentId === a.id ? 'selected' : ''}>${escHtml(a.title)} (/${a.maxScore})</option>`));

    els.propertiesPanel.innerHTML = `
    <p class="text-[10px] font-bold text-[#6b84a0] uppercase tracking-widest mb-3">Linked Assignment</p>
    ${fieldWrap('Assignment', `<select id="blockLinkedAssignmentSelect" class="form-input w-full p-2.5 bg-white border border-[#dce3ed] rounded text-[13px] text-[#0d1f35] outline-none focus:border-[#2563eb]">${options.join('')}</select>`)}
    <p class="text-[11px] text-[#9ab0c6] font-semibold leading-relaxed">
        <i class="fa-solid fa-circle-info mr-1"></i>
        Students submit directly on this slide — grading, locking, and submission history all use this subject's existing assignment records, unchanged.
    </p>
    ${!assignments.length ? `<p class="text-[11px] font-bold text-[#e31b4a] mt-2">No assignments exist for this subject yet — create one from Enter Grade first.</p>` : ''}`;

    document.getElementById('blockLinkedAssignmentSelect').addEventListener('change', (e) => {
        block.linkedAssignmentId = e.target.value || null;
        hasUnsavedChanges = true;
        renderSlideThumbs();
    });
}

// ── 11. SAVE / PUBLISH (shared by both formats) ──────────────────────────
// ── SAVE-FAILURE DIAGNOSIS ────────────────────────────────────────────────
// Logs the specific, actionable reason a lesson save/publish failed —
// Firestore's own error code and message, plus payload size and a scan for
// undefined/function values that would otherwise silently serialize as
// missing fields — instead of a bare "Failed to save" with no way to tell
// a permissions problem from a payload problem from a stale-token problem.
// Returns a short, user-facing message tailored to the most common causes;
// the full diagnostic detail goes to console.error only, exactly like
// showSaveError() in grade_form.js already does for the grade-entry form.
function describeSaveFailure(context, e, payload) {
    const code = e?.code || '';
    const rawMessage = e?.message || String(e);

    let payloadJson = '';
    let payloadBytes = null;
    let undefinedPaths = [];
    try {
        payloadJson = JSON.stringify(payload, (key, value) => {
            if (value === undefined) undefinedPaths.push(key || '(root)');
            return value;
        });
        payloadBytes = new Blob([payloadJson]).size;
    } catch (jsonErr) {
        payloadJson = `<could not stringify payload: ${jsonErr.message}>`;
    }

    console.error(
        `[Lesson Builder] ${context} failed —`,
        `code: ${code || '(none)'};`,
        `message: ${rawMessage};`,
        `payload size: ${payloadBytes === null ? 'unknown' : payloadBytes + ' bytes'};`,
        `undefined fields found: ${undefinedPaths.length ? undefinedPaths.join(', ') : 'none'}`,
        e
    );

    if (code === 'permission-denied' || /permission/i.test(rawMessage)) {
        return 'You do not have permission to save this lesson right now. If you were just signed in as a different role in another tab, try reloading this page and signing back in as a teacher.';
    }
    if (code === 'invalid-argument' || undefinedPaths.length) {
        return 'This lesson could not be saved because part of its content is invalid or missing. Please check recent edits and try again; if the problem persists, contact support.';
    }
    if (payloadBytes !== null && payloadBytes > 1_000_000) {
        return 'This lesson is too large to save (Firestore documents are capped at 1MB). Try removing large embedded content or splitting it into multiple pages.';
    }
    if (code === 'unavailable' || /network|offline/i.test(rawMessage)) {
        return 'Connection error — this lesson was not saved. Check your connection and try again.';
    }
    return 'Failed to save this lesson. Please try again or contact support if this keeps happening.';
}

async function onSaveDraft() {
    const btn = lessonDraft.format === 'document' ? els.docSaveBtn : els.saveBtn;
    const prevLabel = btn.textContent;
    btn.disabled = true;
    btn.textContent = 'Saving…';
    const payload = { title: lessonDraft.title, slides: currentSlidesForSave(), theme: lessonDraft.theme };
    try {
        await saveLessonContent(session.schoolId, currentPostContext, currentLessonId, payload);
        hasUnsavedChanges = false;
        flashSaveMsg('Saved');
    } catch (e) {
        alert(describeSaveFailure('saveLessonContent (Save Draft)', e, payload));
    } finally {
        btn.disabled = false;
        btn.textContent = prevLabel;
    }
}

function flashSaveMsg(text) {
    const target = lessonDraft?.format === 'document' ? els.docSaveMsg : els.saveMsg;
    target.textContent = text;
    target.classList.remove('hidden');
    setTimeout(() => target.classList.add('hidden'), 2500);
}

async function onPublishToggle() {
    // Publishing (and unpublishing) always saves current draft content
    // first, so a teacher who edited content and immediately hits Publish
    // never publishes stale content from the last explicit Save.
    const btn = lessonDraft.format === 'document' ? els.docPublishBtn : els.publishBtn;
    btn.disabled = true;
    const payload = { title: lessonDraft.title, slides: currentSlidesForSave(), theme: lessonDraft.theme };
    try {
        await saveLessonContent(session.schoolId, currentPostContext, currentLessonId, payload);
        hasUnsavedChanges = false;

        if (lessonDraft.status === 'published') {
            if (!confirm('Unpublish this lesson? Students will no longer be able to open it. (Its Class Stream announcement, if any, stays visible.)')) {
                btn.disabled = false;
                return;
            }
            await unpublishLesson(session.schoolId, currentPostContext, currentLessonId);
            lessonDraft.status = 'draft';
        } else {
            const authorContext = { authorId: session.teacherId, authorName: session.teacherData.name };
            await publishLesson(session.schoolId, currentPostContext, currentLessonId, lessonDraft, authorContext);
            lessonDraft.status = 'published';
            lessonDraft.publishedAt = new Date().toISOString();
        }
        renderStatusPill();
        renderPublishButton();
        flashSaveMsg(lessonDraft.status === 'published' ? 'Published — posted to Class Stream' : 'Unpublished');
    } catch (e) {
        alert(describeSaveFailure('onPublishToggle (Publish/Unpublish)', e, payload));
    } finally {
        btn.disabled = false;
    }
}

// ── 12. TEACHER-ONLY NOTES MODAL (shared by both formats) ────────────────
async function openNotesModal() {
    els.notesOverlay.classList.remove('hidden');
    els.pacingNotesInput.value = '';
    els.standardsInput.value = '';
    try {
        const notes = await loadLessonPrivateNotes(session.schoolId, currentPostContext, currentLessonId);
        els.pacingNotesInput.value = notes.pacingNotes || '';
        els.standardsInput.value = (notes.standards || []).join(', ');
    } catch (e) {
        console.error('[Lesson Builder] loadLessonPrivateNotes:', e);
    }
}

function closeNotesModal() {
    els.notesOverlay.classList.add('hidden');
}

async function onSaveNotes() {
    const prevLabel = els.saveNotesBtn.textContent;
    els.saveNotesBtn.disabled = true;
    els.saveNotesBtn.textContent = 'Saving…';
    try {
        const standards = els.standardsInput.value.split(',').map(s => s.trim()).filter(Boolean);
        await saveLessonPrivateNotes(session.schoolId, currentPostContext, currentLessonId, {
            pacingNotes: els.pacingNotesInput.value,
            standards
        });
        closeNotesModal();
        flashSaveMsg('Notes saved');
    } catch (e) {
        console.error('[Lesson Builder] saveLessonPrivateNotes:', e);
        alert('Failed to save notes. Please try again.');
    } finally {
        els.saveNotesBtn.disabled = false;
        els.saveNotesBtn.textContent = prevLabel;
    }
}

// ── 13. DOCUMENT BUILDER (Quill.js rich-text editor) ─────────────────────
// A Document-format lesson always holds exactly one 'richtext' block in
// lessonDraft.slides[0]. Quill itself — not lessonDraft — is the live
// source of truth for content while the editor is open; contentHtml is
// only pulled out of it at save time via currentSlidesForSave() above.

let assignmentBlotRegistered = false;

// Custom embed Blot for a "Linked Assignment" card. Registered once, the
// first time Document mode is opened (Quill must already be loaded from
// the CDN by then — it always is, since builder.html loads it eagerly).
// static create(value): builds the DOM node Quill inserts into the editor.
// static value(node): reconstructs the embed's data object FROM that saved
// DOM/HTML on load — necessary because only the rendered HTML string is
// what's actually persisted to Firestore, never the original JS object.
function registerAssignmentBlot() {
    if (assignmentBlotRegistered || !window.Quill) return;
    const Embed = Quill.import('blots/embed');

    class AssignmentBlot extends Embed {
        static create(value) {
            const node = super.create();
            node.setAttribute('contenteditable', 'false');
            node.setAttribute('data-assignment-id', value.id || '');
            node.setAttribute('data-assignment-title', value.title || '');
            node.innerHTML = `<i class="fa-solid fa-clipboard-check"></i><span>${escHtml(value.title || 'Assignment')}</span>`;
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

    // Divider ("Insert Horizontal Line") — registered here too, not just
    // AssignmentBlot, because it hit the exact same class of bug: Quill
    // 1.3.7 ships no formats/divider or formats/hr at all, so a raw <hr>
    // handed to quill.clipboard.dangerouslyPasteHTML() has no matcher to
    // convert it into a Delta op and gets silently dropped — confirmed live
    // (button click produced zero DOM change, zero console error). A
    // registered BlockEmbed is what actually makes Quill treat the tag as
    // real content instead of discarding it, same fix shape as the
    // assignment-embed flattening bug.
    const BlockEmbed = Quill.import('blots/block/embed');
    class DividerBlot extends BlockEmbed {
        static create() {
            return super.create();
        }
    }
    DividerBlot.blotName = 'divider';
    DividerBlot.tagName = 'hr';

    Quill.register(AssignmentBlot);
    Quill.register(DividerBlot);
    assignmentBlotRegistered = true;
}

function initQuillIfNeeded() {
    if (quill) return;
    registerAssignmentBlot();

    // Custom toolbar: standard Quill formatting controls plus one extra
    // custom button (the clipboard icon) for inserting a Linked Assignment
    // embed. Quill's toolbar module supports arbitrary custom buttons by id
    // — 'insertAssignment' is wired to openAssignmentPicker() below via the
    // handlers option, same as any built-in toolbar action.
    els.docToolbar.innerHTML = `
        <span class="ql-formats">
            <select class="ql-header">
                <option value="1"></option>
                <option value="2"></option>
                <option value="3"></option>
                <option selected></option>
            </select>
            <select class="ql-font"></select>
            <select class="ql-size"></select>
        </span>
        <span class="ql-formats">
            <button class="ql-bold"></button>
            <button class="ql-italic"></button>
            <button class="ql-underline"></button>
            <button class="ql-strike"></button>
        </span>
        <span class="ql-formats">
            <select class="ql-color"></select>
            <select class="ql-background"></select>
        </span>
        <span class="ql-formats">
            <button class="ql-list" value="ordered"></button>
            <button class="ql-list" value="bullet"></button>
            <!-- Indent/align (Google Docs parity) — unlike the 'divider'/
                 'assignmentEmbed' blots above, 'indent' and 'align' are
                 built into Quill 1.3.7 itself, so no Quill.register() call
                 is needed for these to work — only the toolbar buttons. -->
            <button class="ql-indent" value="-1"></button>
            <button class="ql-indent" value="+1"></button>
        </span>
        <span class="ql-formats">
            <button class="ql-align" value=""></button>
            <button class="ql-align" value="center"></button>
            <button class="ql-align" value="right"></button>
            <button class="ql-align" value="justify"></button>
        </span>
        <span class="ql-formats">
            <button class="ql-link"></button>
            <button class="ql-image"></button>
            <button class="ql-video"></button>
        </span>
        <span class="ql-formats">
            <button id="insertDividerBtn" title="Insert Horizontal Line">
                <i class="fa-solid fa-minus"></i>
            </button>
            <button id="insertAssignmentBtn" title="Insert Linked Assignment">
                <i class="fa-solid fa-clipboard-check"></i>
            </button>
        </span>
        <span class="ql-formats">
            <button id="addDocPageBtn" title="Add New Page" class="!w-auto px-2 gap-1.5 inline-flex items-center">
                <i class="fa-solid fa-plus text-[11px]"></i><span class="text-[11.5px] font-bold">Page</span>
            </button>
        </span>
    `;

    quill = new Quill(els.docEditor, {
        theme: 'snow',
        modules: {
            toolbar: {
                container: els.docToolbar,
                handlers: {
                    // Built-in handlers (bold/italic/list/etc.) are left to
                    // Quill's own defaults — only custom buttons need a
                    // handler wired here.
                }
            }
        }
    });

    document.getElementById('insertDividerBtn').addEventListener('click', () => {
        const range = quill.getSelection(true) || { index: quill.getLength(), length: 0 };
        // insertEmbed on the registered 'divider' BlockEmbed (see
        // registerAssignmentBlot() above) — NOT dangerouslyPasteHTML with a
        // raw <hr> string. That was tried first and silently inserted
        // nothing: Quill 1.3.7 has no built-in divider/hr format, so an
        // unregistered tag passed through its HTML clipboard matcher has no
        // conversion rule and gets dropped with no error. insertEmbed goes
        // straight through Quill's own Delta API, which only works once the
        // format is actually registered — confirmed live after the fix.
        quill.insertEmbed(range.index, 'divider', true, 'user');
        quill.setSelection(range.index + 1, 0, 'user');
        hasUnsavedChanges = true;
    });

    document.getElementById('insertAssignmentBtn').addEventListener('click', () => {
        pendingAssignmentBlotRange = quill.getSelection(true);
        openAssignmentPicker();
    });

    // "Add New Page" — Document-format lessons are a single scrolling page
    // today (one slides[0] richtext block; see renderDocAll()), so there is
    // no second page to navigate to yet. Rather than silently doing nothing,
    // this inserts a clearly-marked page-break divider into the current
    // document — a lightweight stand-in that gives teachers a visual section
    // break to organize long documents, until true multi-page Document
    // lessons are a real data-model feature.
    document.getElementById('addDocPageBtn').addEventListener('click', () => {
        // Same registered 'divider' BlockEmbed the toolbar's own divider
        // button uses (see registerAssignmentBlot()) — NOT
        // dangerouslyPasteHTML, which silently drops any tag Quill has no
        // format registered for (confirmed live; see the divider button fix
        // above for the full explanation). insertEmbed at the end of the
        // document, followed by a real newline so there's an editable line
        // after it to land the cursor on, stands in for a "new page" until
        // Document lessons support true multiple pages as a data-model
        // feature.
        const endIndex = quill.getLength();
        quill.insertEmbed(endIndex - 1, 'divider', true, 'user');
        quill.insertText(endIndex, '\n', 'user');
        quill.setSelection(endIndex + 1, 0, 'user');
        quill.scrollingContainer?.scrollTo?.(0, quill.scrollingContainer.scrollHeight);
        hasUnsavedChanges = true;
    });

    quill.on('text-change', (delta, oldDelta, source) => {
        if (source === 'user') hasUnsavedChanges = true;
    });

    // Delegated click listener on the editor's contenteditable root (not
    // els.docEditor — Quill wraps that container and quill.root is the
    // actual .ql-editor node the rendered .assignment-embed spans live
    // inside). A previously-inserted embed just sat there inert; this
    // opens a view/edit modal for the specific card clicked, reading the
    // id straight off the embed's own data attribute (see
    // registerAssignmentBlot()'s AssignmentBlot.create above).
    quill.root.addEventListener('click', (e) => {
        const card = e.target.closest('.assignment-embed');
        if (!card) return;
        openAssignmentViewModal(card.getAttribute('data-assignment-id'));
    });
}

function renderDocAll() {
    els.docLessonTitleInput.value = lessonDraft.title || '';
    renderStatusPill();
    renderPublishButton();

    initQuillIfNeeded();

    const block = lessonDraft.slides[0] || newSlide('richtext');
    quill.root.innerHTML = block.contentHtml || '';
    // Loading existing content into Quill would otherwise itself become an
    // undo-able step (Ctrl+Z right after opening would blank the editor) —
    // clearing history right after the load makes the loaded content the
    // new baseline instead.
    quill.history.clear();
}

// ── 14. ASSIGNMENT-EMBED PICKER (Document mode's toolbar button) ─────────
function openAssignmentPicker() {
    const assignments = (currentSubject?.assignments || []).filter(a => !a.archived);
    if (!assignments.length) {
        els.assignmentPickerList.innerHTML = `<p class="text-[12px] font-semibold text-[#9ab0c6] text-center py-6">No assignments exist for this subject yet — create one from Enter Grade first.</p>`;
    } else {
        els.assignmentPickerList.innerHTML = assignments.map(a => `
            <button type="button" data-assignment-id="${escHtml(a.id)}" data-assignment-title="${escHtml(a.title)}"
                class="w-full text-left px-3 py-2.5 rounded-lg border border-[#dce3ed] hover:border-[#2563eb] hover:bg-[#f8fafd] transition flex items-center justify-between gap-2">
                <span class="text-[13px] font-bold text-[#0d1f35]">${escHtml(a.title)}</span>
                <span class="text-[11px] font-semibold text-[#9ab0c6]">/${a.maxScore}</span>
            </button>`).join('');
    }
    // Fade the backdrop in and scale/fade the panel up from 96% — the CSS
    // transition is declared on both elements in builder.html
    // (.modal-backdrop / .modal-panel); toggling 'hidden' off one frame,
    // then removing the opacity-0/scale-95 starting classes on the next
    // frame, is what actually gives the transition something to animate
    // from (flipping them off in the same frame the element becomes
    // visible would just snap straight to the end state, same as before).
    els.assignmentPickerOverlay.classList.remove('hidden');
    requestAnimationFrame(() => {
        els.assignmentPickerOverlay.classList.remove('opacity-0');
        els.assignmentPickerPanel?.classList.remove('scale-95');
    });
}

function closeAssignmentPicker() {
    els.assignmentPickerOverlay.classList.add('opacity-0');
    els.assignmentPickerPanel?.classList.add('scale-95');
    setTimeout(() => els.assignmentPickerOverlay.classList.add('hidden'), 200);
    pendingAssignmentBlotRange = null;
}

// ── 14b. ASSIGNMENT-EMBED VIEW/EDIT MODAL (click on an inserted card) ────
// The embed itself only stores {id, title} (see AssignmentBlot.value above)
// — everything else a teacher would want to see (points, instructions) is
// re-fetched here from currentSubject.assignments by matching on id, since
// that's the same in-memory cache the picker itself reads from.
function openAssignmentViewModal(assignmentId) {
    const a = (currentSubject?.assignments || []).find(x => x.id === assignmentId);
    if (!els.assignmentViewOverlay) return;
    if (!a) {
        els.assignmentViewTitle.textContent = 'Assignment not found';
        els.assignmentViewMeta.textContent = 'This assignment may have been deleted or archived.';
        els.assignmentViewInstructions.value = '';
        els.assignmentViewInstructions.disabled = true;
        if (els.assignmentViewSaveBtn) els.assignmentViewSaveBtn.classList.add('hidden');
        openAssignmentViewId = null;
    } else {
        els.assignmentViewTitle.textContent = a.title || 'Untitled Assignment';
        els.assignmentViewMeta.textContent = `${a.type || 'Assignment'} · /${a.maxScore ?? '—'}${a.date ? ' · Due ' + a.date : ''}`;
        els.assignmentViewInstructions.value = a.instructions || '';
        els.assignmentViewInstructions.disabled = false;
        if (els.assignmentViewSaveBtn) els.assignmentViewSaveBtn.classList.remove('hidden');
        openAssignmentViewId = a.id;
    }
    if (els.assignmentViewMsg) { els.assignmentViewMsg.textContent = ''; els.assignmentViewMsg.classList.add('hidden'); }

    els.assignmentViewOverlay.classList.remove('hidden');
    requestAnimationFrame(() => {
        els.assignmentViewOverlay.classList.remove('opacity-0');
        els.assignmentViewPanel?.classList.remove('scale-95');
    });
}

function closeAssignmentViewModal() {
    if (!els.assignmentViewOverlay) return;
    els.assignmentViewOverlay.classList.add('opacity-0');
    els.assignmentViewPanel?.classList.add('scale-95');
    setTimeout(() => els.assignmentViewOverlay.classList.add('hidden'), 200);
    openAssignmentViewId = null;
}

// Saves the edited instructions text back to wherever this subject's
// assignments actually live — its own assignments subcollection for a
// new-model subject (sub._source === 'new'), or the legacy embedded array
// on the teacher document otherwise — the same dual-path write
// grade_form.js's ensureAssignmentDoc() uses for the same data shape.
async function onSaveAssignmentViewEdits() {
    if (!openAssignmentViewId || !currentSubject) return;
    const sub = currentSubject;
    const existing = Array.isArray(sub.assignments) ? sub.assignments : [];
    const idx = existing.findIndex(a => a.id === openAssignmentViewId);
    if (idx === -1) return;

    const newInstructions = els.assignmentViewInstructions.value;
    const updatedAsg = { ...existing[idx], instructions: newInstructions };

    if (els.assignmentViewSaveBtn) {
        els.assignmentViewSaveBtn.disabled = true;
        els.assignmentViewSaveBtn.textContent = 'Saving…';
    }

    try {
        if (sub._source === 'new') {
            await setDoc(doc(db, 'schools', session.schoolId, 'classes', sub.classId, 'subjects', sub.id, 'assignments', updatedAsg.id), updatedAsg);
        } else {
            const updatedAssignments = existing.map((a, i) => i === idx ? updatedAsg : a);
            const subjects = (session.teacherData.subjects || []).map(s => {
                if (s.id !== sub.id) return s;
                return { ...s, assignments: updatedAssignments };
            });
            await updateDoc(getTeacherDocRef(session.schoolId, session.teacherId), { subjects });
            session.teacherData.subjects = subjects;
        }
        sub.assignments = existing.map((a, i) => i === idx ? updatedAsg : a);

        if (els.assignmentViewMsg) {
            els.assignmentViewMsg.textContent = 'Saved.';
            els.assignmentViewMsg.classList.remove('hidden');
        }
        setTimeout(closeAssignmentViewModal, 700);
    } catch (e) {
        console.error('[Lesson Builder] onSaveAssignmentViewEdits failed:', e);
        if (els.assignmentViewMsg) {
            els.assignmentViewMsg.textContent = 'Could not save — please try again.';
            els.assignmentViewMsg.classList.remove('hidden');
        }
    } finally {
        if (els.assignmentViewSaveBtn) {
            els.assignmentViewSaveBtn.disabled = false;
            els.assignmentViewSaveBtn.textContent = 'Save Instructions';
        }
    }
}

// ── IMPORT MATERIALS ──────────────────────────────────────────────────────
// Three import paths, all reachable from one "Import Options" modal next to
// "New Lesson" (on the lesson picker — no lesson is open yet when any of
// these run): a Google Slides / PowerPoint "Publish to Web" embed link
// (see onImportSlidesClick, below), a .docx file picker (stubbed — reads
// the file and reports back; actual .docx → lesson-content conversion is
// intentionally NOT implemented yet), and native .pptx upload/paste (see
// runPptxImport, below), which — unlike the other two — always creates a
// brand-new Slide Deck lesson from the parsed content, since there's no
// open lesson here to import into.
function openImportOptionsModal() {
    if (!currentPostContext) { alert('Select a subject first.'); return; }
    els.importDocxInput.value = '';
    els.importDocxStatus.classList.add('hidden');
    els.importSlidesUrlInput.value = '';
    els.importSlidesStatus.classList.add('hidden');
    els.importPptxInput.value = '';
    els.importPptxStatus.classList.add('hidden');
    els.importOptionsOverlay.classList.remove('hidden');
    requestAnimationFrame(() => {
        els.importOptionsOverlay.classList.remove('opacity-0');
        els.importOptionsPanel?.classList.remove('scale-95');
    });
}

function closeImportOptionsModal() {
    els.importOptionsOverlay.classList.add('opacity-0');
    els.importOptionsPanel?.classList.add('scale-95');
    setTimeout(() => els.importOptionsOverlay.classList.add('hidden'), 200);
}

function showImportStatus(el, text, isError = false) {
    el.textContent = text;
    el.classList.remove('hidden');
    el.classList.toggle('text-rose-600', isError);
    el.classList.toggle('text-[#6b84a0]', !isError);
}

// .docx import stub: reads the selected file (confirms it's real and
// readable) and reports back, but does NOT parse Word's XML into lesson
// content yet — that conversion is out of scope for this phase. Wiring the
// listener now means the real parser can be dropped in later without any
// UI changes.
async function onImportDocxFileSelected(e) {
    const file = e.target.files?.[0];
    if (!file) return;

    showImportStatus(els.importDocxStatus, `Reading ${file.name}…`);
    try {
        // Confirms the file is actually readable end-to-end (not just that
        // the browser accepted the picker selection) without doing
        // anything with the bytes yet — real .docx parsing (e.g. via
        // mammoth.js or a server-side conversion function) is a follow-up
        // phase, not this one.
        await file.arrayBuffer();
        showImportStatus(els.importDocxStatus, `"${file.name}" received (${(file.size / 1024).toFixed(0)} KB). Word import isn't implemented yet — this is a placeholder for a future phase.`);
    } catch (err) {
        console.error('[Lesson Builder] .docx import stub:', err);
        showImportStatus(els.importDocxStatus, 'Could not read that file. Please try a different .docx file.', true);
    }
}

// Google Slides ("File → Share → Publish to web" → Embed tab, which yields
// an <iframe src="https://docs.google.com/presentation/d/.../embed?...">
// link) or any other already-hosted presentation embed URL. This inserts a
// real, working Video block (provider: 'embed', reusing the exact same
// iframe-embed rendering path parseMediaUrl()'s YouTube/Vimeo/Drive results
// already use — see newBlock('video') in lessons.js) rather than a UI-only
// stub, since accepting an already-published embed URL needs no server-side
// conversion at all: the teacher did the "export" step themselves via
// Google's own Publish to Web flow.
function onImportSlidesClick() {
    const rawUrl = els.importSlidesUrlInput.value.trim();
    if (!rawUrl) {
        showImportStatus(els.importSlidesStatus, 'Paste a Google Slides "Publish to web" embed link (or PowerPoint Online embed link) first.', true);
        return;
    }

    let embedUrl;
    try {
        const parsed = new URL(rawUrl);
        if (parsed.protocol !== 'https:') throw new Error('not https');
        embedUrl = parsed.href;
    } catch {
        showImportStatus(els.importSlidesStatus, 'That doesn\'t look like a valid link. Copy the embed URL from Google Slides\' Publish to Web dialog (or PowerPoint Online\'s Embed option).', true);
        return;
    }

    if (lessonDraft.format === 'slides') {
        // SLIDE DECK REDESIGN: built directly in the current blocks-based
        // shape (a blank slide holding one Video block) rather than the old
        // fixed 'media' slide type, so the sidebar thumbnail and canvas
        // render correctly on the very first paint — no reliance on
        // renderSlideCanvas()'s migrateLegacySlide() safety net, which only
        // runs once that slide is actually selected.
        const slide = newSlide('blank');
        const block = newBlock('video');
        block.provider = 'embed';
        block.embedUrl = embedUrl;
        slide.blocks.push(block);
        lessonDraft.slides.splice(currentSlideIndex + 1, 0, slide);
        currentSlideIndex += 1;
        currentBlockId = block.id;
        hasUnsavedChanges = true;
        renderSlideThumbs();
        renderSlideCanvas();
        renderPropertiesPanel();
    } else {
        // Document format has no media-slide concept — embed it inline in
        // the Quill content instead, at the end of the document, using
        // Quill's own built-in 'video' format via insertEmbed (registered
        // out of the box in 1.3.7, unlike 'divider' above) — NOT
        // dangerouslyPasteHTML with a raw <iframe> string. That was tried
        // first and silently inserted nothing, same root cause as the
        // divider bug: Quill's HTML clipboard matcher has no conversion
        // rule for an unrecognized tag and drops it with no error.
        // insertEmbed goes straight through Quill's Delta API, which is
        // reliable specifically because 'video' IS a real, always-registered
        // format — no custom Blot needed for this one.
        initQuillIfNeeded();
        const endIndex = quill.getLength();
        quill.insertText(endIndex - 1, '\n', 'user');
        quill.insertEmbed(endIndex, 'video', embedUrl, 'user');
        quill.insertText(quill.getLength() - 1, '\n', 'user');
        hasUnsavedChanges = true;
    }

    showImportStatus(els.importSlidesStatus, 'Embedded — close this and check the canvas.');
    setTimeout(closeImportOptionsModal, 900);
}

// ── NATIVE POWERPOINT (.PPTX) IMPORT ──────────────────────────────────────
// Unlike the embed-link import above, this parses the actual file: a .pptx
// is a ZIP archive of OOXML (an XML dialect) parts — JSZip (loaded via CDN,
// see builder.html) unzips it, and the browser's own built-in DOMParser
// reads the XML; no second parsing library is pulled in for this. Only
// JSZip is a genuinely new dependency the browser doesn't already have.
//
// Scope of what this reads, by design: each slide's TITLE placeholder text,
// its other text placeholders (body/subtitle/content — concatenated, in
// document order, as that slide's body), and its first embedded raster
// image (png/jpg/gif/bmp/webp — vector formats like EMF/WMF, which
// PowerPoint sometimes uses for pasted charts/icons, are skipped, since
// browsers can't render them as an <img> anyway). It does NOT read speaker
// notes, tables, charts, SmartArt, grouped/rotated shapes, animations, or
// slide masters/layouts (placeholder text that comes ONLY from a slide's
// layout — nothing typed directly on the slide itself — won't be picked
// up). A slide that parses to no usable content is still imported as a
// blank slide with a placeholder Text block rather than silently dropped,
// so the deck's slide count and order always match the source file.
//
// SLIDE DECK REDESIGN: each parsed slide becomes one 'blank' slide holding
// the blocks below, in reading order (see parseOnePptxSlide()) — the same
// content mapping the old fixed slide types used, just expressed as blocks
// instead of a slide type:
//   - text + a picture, or text with no picture  → a heading Text block
//     (if a title was found) plus a body Text block; a picture here is
//     noted in the body text, not dropped, since a Text block has no image
//     field of its own.
//   - a picture with no other text                → a heading Text block
//     (if any) plus one Image block.
//   - title text only, nothing else                → a single heading
//     Text block.
//
// Images are inlined as base64 data: URIs directly into the Image block's
// imageUrl field — there is no image-upload/Storage pipeline wired into
// this builder today (an Image block only ever accepts an already-hosted
// external URL or a manual upload via its own properties panel), and
// adding a dedicated import-time upload pipeline is a bigger piece of work
// than this import feature itself. This is a real trade-off, not a bug:
// a deck with several large images can hit Firestore's 1MB-per-document
// cap on save — describeSaveFailure() already has a specific, clear error
// message for exactly that case, so it fails loud and explained rather
// than silently, but it WILL fail for image-heavy decks until real image
// upload exists.
function isPptxFile(file) {
    return /\.pptx$/i.test(file?.name || '') ||
        file?.type === 'application/vnd.openxmlformats-officedocument.presentationml.presentation';
}

async function onImportPptxFileSelected(e) {
    const file = e.target.files?.[0];
    e.target.value = ''; // allow re-selecting the same filename after a failed attempt
    if (!file) return;
    await runPptxImport(file);
}

async function onImportPptxPaste(e) {
    if (els.importOptionsOverlay.classList.contains('hidden')) return; // only act while this modal is open
    const file = [...(e.clipboardData?.files || [])].find(isPptxFile);
    if (!file) return;
    e.preventDefault();
    await runPptxImport(file);
}

async function runPptxImport(file) {
    if (!currentPostContext) { alert('Select a subject first.'); return; }
    if (typeof JSZip === 'undefined') {
        showImportStatus(els.importPptxStatus, "PowerPoint import isn't available right now (a required library failed to load) — please reload the page and try again.", true);
        return;
    }

    showImportStatus(els.importPptxStatus, `Reading ${file.name}…`);
    els.importPptxTrigger.classList.add('opacity-50', 'pointer-events-none');

    try {
        const slides = await parsePptxFile(file);
        const title = (file.name || 'Imported Presentation')
            .replace(/\.pptx$/i, '').replace(/[_-]+/g, ' ').trim() || 'Imported Presentation';

        // No lesson is open on the picker view this modal lives on (see
        // this section's top comment), so importing always creates a new
        // Slide Deck lesson — createLesson() seeds one default title slide,
        // immediately overwritten by saveLessonContent() with the real
        // parsed slides, same two-step create-then-populate pattern
        // onCreateLesson() + openBuilder() already use for a manually
        // created lesson.
        const authorContext = { authorId: session.teacherId, authorName: session.teacherData.name };
        const lesson = await createLesson(session.schoolId, currentPostContext, authorContext, { title, format: 'slides' });
        await saveLessonContent(session.schoolId, currentPostContext, lesson.id, { title, slides });
        lessonsCache.unshift({ ...lesson, title, slides });

        showImportStatus(els.importPptxStatus, `Imported ${slides.length} slide${slides.length === 1 ? '' : 's'} — opening "${title}"…`);
        setTimeout(async () => {
            closeImportOptionsModal();
            await openBuilder(lesson.id);
        }, 700);
    } catch (err) {
        console.error('[Lesson Builder] PPTX import failed:', err);
        const message = (err?.message && err.message.length < 160) ? err.message : 'Could not read that PowerPoint file. Please try a different file.';
        showImportStatus(els.importPptxStatus, message, true);
    } finally {
        els.importPptxTrigger.classList.remove('opacity-50', 'pointer-events-none');
    }
}

// Resolves a package-relative or ..-relative OOXML rels Target against a
// base directory — e.g. normalizeZipPath('ppt/slides/', '../media/image1.png')
// → 'ppt/media/image1.png'. Needed because rels Targets are written
// relative to the folder the .rels file's SUBJECT part lives in, not to
// the package root.
function normalizeZipPath(base, target) {
    if (!target) return '';
    if (target.startsWith('/')) return target.slice(1);
    const baseDir = base.endsWith('/') ? base : base + '/';
    const stack = [];
    for (const part of (baseDir + target).split('/')) {
        if (!part || part === '.') continue;
        if (part === '..') stack.pop();
        else stack.push(part);
    }
    return stack.join('/');
}

async function readZipXml(zip, path) {
    const entry = zip.file(path);
    if (!entry) return null;
    const text = await entry.async('text');
    const doc = new DOMParser().parseFromString(text, 'application/xml');
    if (doc.getElementsByTagName('parsererror').length) return null;
    return doc;
}

const PPTX_IMAGE_MIME = { png: 'image/png', jpg: 'image/jpeg', jpeg: 'image/jpeg', gif: 'image/gif', bmp: 'image/bmp', webp: 'image/webp' };

async function parsePptxFile(file) {
    let zip;
    try {
        zip = await JSZip.loadAsync(file);
    } catch (err) {
        throw new Error("That file couldn't be opened — make sure it's a real, unmodified .pptx file.");
    }

    // The presentation's own slide-id list (ppt/presentation.xml) is the
    // only authoritative slide ORDER — PowerPoint does not guarantee
    // slide N's part is actually named slideN.xml, so this resolves each
    // <p:sldId>'s r:id through presentation.xml.rels rather than just
    // listing ppt/slides/*.xml alphabetically.
    const presentationDoc = await readZipXml(zip, 'ppt/presentation.xml');
    const presentationRels = await readZipXml(zip, 'ppt/_rels/presentation.xml.rels');
    if (!presentationDoc || !presentationRels) {
        throw new Error("This doesn't look like a valid .pptx file (its presentation.xml is missing or unreadable).");
    }

    const relIdToTarget = {};
    presentationRels.querySelectorAll('Relationship').forEach(rel => {
        relIdToTarget[rel.getAttribute('Id')] = rel.getAttribute('Target');
    });

    const slidePaths = [...presentationDoc.getElementsByTagName('p:sldId')]
        .map(node => node.getAttribute('r:id'))
        .filter(Boolean)
        .map(rid => relIdToTarget[rid])
        .filter(Boolean)
        .map(target => normalizeZipPath('ppt/', target));

    if (!slidePaths.length) throw new Error('No slides were found in this file.');

    const slides = [];
    for (const slidePath of slidePaths) {
        try {
            slides.push(await parseOnePptxSlide(zip, slidePath));
        } catch (err) {
            // One malformed slide shouldn't sink the whole import — skip it
            // but keep going, same "degrade, don't crash" approach
            // describeSaveFailure()/renderImageBlock's onerror take
            // elsewhere in this file. It IS still logged so a genuinely
            // bad import is diagnosable rather than mysteriously short a
            // slide.
            console.warn(`[Lesson Builder] Skipped an unreadable slide (${slidePath}):`, err);
        }
    }
    if (!slides.length) throw new Error("Slides were found, but none of their content could be read.");
    return slides;
}

async function parseOnePptxSlide(zip, slidePath) {
    const doc = await readZipXml(zip, slidePath);
    if (!doc) return newSlide('blank'); // malformed slide XML — still counts as a slide, just an empty one

    // Sibling _rels/<partName>.rels is where OOXML always keeps a part's
    // own relationships (here: which rId a <a:blip r:embed="rId"> points
    // to in ppt/media/).
    const relsPath = slidePath.replace(/([^/]+)$/, '_rels/$1.rels');
    const relsDoc = await readZipXml(zip, relsPath);
    const imageRelIdToTarget = {};
    if (relsDoc) {
        relsDoc.querySelectorAll('Relationship').forEach(rel => {
            if ((rel.getAttribute('Type') || '').indexOf('/image') !== -1) {
                imageRelIdToTarget[rel.getAttribute('Id')] = rel.getAttribute('Target');
            }
        });
    }

    let title = '';
    const bodyParagraphs = [];
    [...doc.getElementsByTagName('p:sp')].forEach(shape => {
        const phType = shape.getElementsByTagName('p:ph')[0]?.getAttribute('type') || '';
        const isTitlePh = phType === 'title' || phType === 'ctrTitle';

        const paragraphs = [...shape.getElementsByTagName('a:p')]
            .map(p => [...p.getElementsByTagName('a:t')].map(t => t.textContent).join(''))
            .filter(text => text.length);
        if (!paragraphs.length) return;

        if (isTitlePh && !title) title = paragraphs.join(' ');
        else bodyParagraphs.push(...paragraphs);
    });

    // First browser-renderable embedded image on the slide, if any (see
    // this section's top comment on why only raster formats are kept).
    let imageDataUrl = null;
    const blipRid = doc.getElementsByTagName('a:blip')[0]?.getAttribute('r:embed');
    const mediaTarget = blipRid && imageRelIdToTarget[blipRid];
    if (mediaTarget) {
        const mediaPath = normalizeZipPath(slidePath.replace(/slides\/[^/]+$/, ''), mediaTarget);
        const mime = PPTX_IMAGE_MIME[(mediaPath.split('.').pop() || '').toLowerCase()];
        const mediaEntry = mime && zip.file(mediaPath);
        if (mediaEntry) {
            const base64 = await mediaEntry.async('base64');
            imageDataUrl = `data:${mime};base64,${base64}`;
        }
    }

    const bodyText = bodyParagraphs.join('\n');

    // SLIDE DECK REDESIGN: builds directly in the current blocks-based shape
    // (a 'blank' slide holding Text/Image blocks in reading order) rather
    // than the old fixed slide types (media/title/content) — same mapping
    // of parsed content to slide shape as before, just expressed as blocks,
    // so the sidebar thumbnail and canvas render correctly on first paint
    // with no reliance on renderSlideCanvas()'s migrateLegacySlide() safety
    // net. A heading, when present, is always its own Text block wrapped as
    // <h2>...</h2> — mirrors migrateLegacySlide()'s own convention in
    // lessons.js, so an imported deck's headings look identical to a
    // migrated legacy deck's.
    const slide = newSlide('blank');
    const headingHtml = title ? `<h2>${escHtml(title)}</h2>` : '';

    if (imageDataUrl && !bodyText) {
        // Picture with no other text → a heading Text block (if any) plus
        // one Image block.
        if (headingHtml) {
            const headingBlock = newBlock('text');
            headingBlock.html = headingHtml;
            slide.blocks.push(headingBlock);
        }
        const imageBlock = newBlock('image');
        imageBlock.imageUrl = imageDataUrl;
        slide.blocks.push(imageBlock);
        return slide;
    }
    if (title && !bodyText && !imageDataUrl) {
        // Title text only, nothing else → a single heading Text block.
        const headingBlock = newBlock('text');
        headingBlock.html = headingHtml;
        slide.blocks.push(headingBlock);
        return slide;
    }

    // Text + a picture, or text with no picture → a heading Text block (if
    // any) plus a body Text block. A Text block has no image field of its
    // own (same limitation the old Content slide type had), so a picture
    // found alongside body text is noted in the body text rather than
    // dropped silently — unchanged behavior from before this rewrite.
    if (headingHtml) {
        const headingBlock = newBlock('text');
        headingBlock.html = headingHtml;
        slide.blocks.push(headingBlock);
    }
    let bodyHtml = bodyText
        ? bodyText.split('\n').map(line => `<p>${escHtml(line) || '<br>'}</p>`).join('')
        : (title ? '' : '<p>This slide had no readable text.</p>');
    if (imageDataUrl) {
        bodyHtml += '<p>[This slide also had an image, which was not imported — recreate it as an Image block if you need it.]</p>';
    }
    if (bodyHtml) {
        const bodyBlock = newBlock('text');
        bodyBlock.html = bodyHtml;
        slide.blocks.push(bodyBlock);
    }
    return slide;
}

function onAssignmentPickerClick(e) {
    const btn = e.target.closest('[data-assignment-id]');
    if (!btn) return;

    const value = { id: btn.dataset.assignmentId, title: btn.dataset.assignmentTitle };
    const range = pendingAssignmentBlotRange || quill.getSelection(true) || { index: quill.getLength(), length: 0 };

    quill.insertEmbed(range.index, 'assignmentEmbed', value, 'user');
    // Leave a space after the card so the cursor doesn't land glued to a
    // non-editable node (which can otherwise trap typing/backspace focus).
    quill.insertText(range.index + 1, ' ', 'user');
    quill.setSelection(range.index + 2, 0, 'user');

    hasUnsavedChanges = true;
    closeAssignmentPicker();
}

init();
