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
    newSlide, parseMediaUrl, isLikelyImageUrl,
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

// Document-format state — Quill is the live source of truth for document
// content while the editor is open; lessonDraft.slides[0].contentHtml is
// only synced from it at save time (see currentSlidesForSave()).
let quill = null;
let pendingAssignmentBlotRange = null; // where to insert once a picker selection is made
let openAssignmentViewId = null; // id of the assignment currently shown in the view/edit modal

const ASSIGNMENT_TEMPLATE_LABELS = {
    title: 'Title / Objective',
    content: 'Rich Content',
    media: 'Media',
    assignment: 'Embedded Assignment',
    interactive_prompt: 'Interactive Prompt',
    collaborative_board: 'Collaborative Board'
};

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
    await onSubjectChange();
}

function cacheEls() {
    [
        'lessonPickerView', 'builderView', 'docBuilderView',
        'subjectSelect', 'newLessonBtn', 'lessonListCount', 'lessonList',
        'backToListBtn', 'slideThumbList', 'addSlideBtn', 'slideTemplateMenu',
        'lessonTitleInput', 'statusPill', 'saveMsg', 'notesBtn', 'saveBtn', 'publishBtn', 'publishBtnLabel',
        'slideCanvas', 'propertiesPanel',
        'docBackToListBtn', 'docLessonTitleInput', 'docStatusPill', 'docSaveMsg',
        'docNotesBtn', 'docSaveBtn', 'docPublishBtn', 'docPublishBtnLabel',
        'docToolbar', 'docEditor',
        'formatChoiceOverlay', 'closeFormatChoiceBtn',
        'importOptionsBtn', 'importOptionsOverlay', 'importOptionsPanel', 'closeImportOptionsBtn',
        'importDocxInput', 'importDocxTrigger', 'importDocxStatus',
        'importSlidesUrlInput', 'importSlidesBtn', 'importSlidesStatus',
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

    els.addSlideBtn.addEventListener('click', (e) => {
        e.stopPropagation();
        els.slideTemplateMenu.classList.toggle('hidden');
    });
    document.addEventListener('click', (e) => {
        if (!els.slideTemplateMenu.contains(e.target) && e.target !== els.addSlideBtn) {
            els.slideTemplateMenu.classList.add('hidden');
        }
    });
    els.slideTemplateMenu.addEventListener('click', (e) => {
        const btn = e.target.closest('[data-template]');
        if (!btn) return;
        addSlide(btn.dataset.template);
        els.slideTemplateMenu.classList.add('hidden');
    });

    els.slideThumbList.addEventListener('click', onSlideThumbClick);

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

function slideThumbIcon(type) {
    return { title: 'fa-heading', content: 'fa-align-left', media: 'fa-photo-film', assignment: 'fa-clipboard-check', interactive_prompt: 'fa-bolt', collaborative_board: 'fa-people-group' }[type] || 'fa-file';
}

function slideThumbLabel(slide) {
    return slide.heading?.trim() || ASSIGNMENT_TEMPLATE_LABELS[slide.type] || 'Slide';
}

function renderSlideThumb(slide, i) {
    const isActive = i === currentSlideIndex;
    return `
    <div class="slide-thumb group relative rounded-lg border p-2.5 cursor-pointer transition ${isActive ? 'border-[#2563eb] bg-[#eef4ff]' : 'border-[#dce3ed] bg-white hover:border-[#9ab0c6]'}"
         data-slide-index="${i}" draggable="true">
        <div class="flex items-center gap-2">
            <span class="text-[10px] font-black text-[#9ab0c6] w-4 flex-shrink-0">${i + 1}</span>
            <i class="fa-solid ${slideThumbIcon(slide.type)} text-[11px] ${isActive ? 'text-[#2563eb]' : 'text-[#6b84a0]'} flex-shrink-0"></i>
            <span class="text-[11.5px] font-bold ${isActive ? 'text-[#0d1f35]' : 'text-[#374f6b]'} truncate flex-1">${escHtml(slideThumbLabel(slide))}</span>
            ${lessonDraft.slides.length > 1 ? `<button data-action="delete-slide" data-slide-index="${i}" class="opacity-0 group-hover:opacity-100 text-[#9ab0c6] hover:text-[#e31b4a] flex-shrink-0 transition"><i class="fa-solid fa-xmark text-[11px]"></i></button>` : ''}
        </div>
    </div>`;
}

function onSlideThumbClick(e) {
    const delBtn = e.target.closest('[data-action="delete-slide"]');
    if (delBtn) {
        e.stopPropagation();
        const idx = Number(delBtn.dataset.slideIndex);
        if (!confirm('Delete this slide?')) return;
        lessonDraft.slides.splice(idx, 1);
        if (currentSlideIndex >= lessonDraft.slides.length) currentSlideIndex = lessonDraft.slides.length - 1;
        hasUnsavedChanges = true;
        renderSlideThumbs();
        renderSlideCanvas();
        renderPropertiesPanel();
        return;
    }

    const thumb = e.target.closest('[data-slide-index]');
    if (!thumb) return;
    currentSlideIndex = Number(thumb.dataset.slideIndex);
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

function addSlide(type) {
    const slide = newSlide(type);
    lessonDraft.slides.splice(currentSlideIndex + 1, 0, slide);
    currentSlideIndex += 1;
    hasUnsavedChanges = true;
    renderSlideThumbs();
    renderSlideCanvas();
    renderPropertiesPanel();
}

// ── 9. SLIDE CANVAS (center pane — the slide's main editable content) ────
function currentSlide() {
    return lessonDraft.slides[currentSlideIndex] || null;
}

function renderSlideCanvas() {
    const slide = currentSlide();
    if (!slide) { els.slideCanvas.innerHTML = ''; return; }

    const renderers = {
        title: renderTitleCanvas,
        content: renderContentCanvas,
        media: renderMediaCanvas,
        assignment: renderAssignmentCanvas,
        interactive_prompt: renderInteractivePromptCanvas,
        collaborative_board: renderCollaborativeBoardCanvas
    };
    els.slideCanvas.innerHTML = (renderers[slide.type] || renderContentCanvas)(slide);
    wireCanvasInputs(slide);
}

// Whether a media slide's URL field currently fails validation — keyed by
// slide id, not stored on the slide object itself, because it's pure
// transient UI state (never saved, never loaded from Firestore). This
// exists because renderSlideCanvas() replaces the canvas's innerHTML
// wholesale on every keystroke to refresh the embed/image preview; a
// property-panel handler that reached into the old DOM and toggled
// `#mediaUrlError`'s `hidden` class directly would have that change
// discarded the instant the very next render rebuilt the element fresh.
// Computing the hidden state from this map inside renderMediaCanvas keeps
// the error message correct across every re-render instead of only until
// the next one.
const mediaUrlInvalid = new Map();

function fieldWrap(label, inputHtml) {
    return `<div class="mb-4"><label class="block text-[10px] font-bold text-[#6b84a0] uppercase tracking-widest mb-1.5">${label}</label>${inputHtml}</div>`;
}

function renderTitleCanvas(slide) {
    return `
    <div class="bg-white rounded-xl shadow-sm border border-[#dce3ed] p-8 min-h-[360px] flex flex-col justify-center">
        ${fieldWrap('Heading', `<input data-field="heading" type="text" value="${escHtml(slide.heading)}" placeholder="Lesson title" class="form-input w-full p-3 bg-white border border-[#dce3ed] rounded text-[22px] font-bold text-[#0d1f35] outline-none focus:border-[#2563eb]">`)}
        ${fieldWrap('Subheading', `<input data-field="subheading" type="text" value="${escHtml(slide.subheading)}" placeholder="Unit 4, Lesson 2" class="form-input w-full p-2.5 bg-white border border-[#dce3ed] rounded text-[14px] text-[#374f6b] outline-none focus:border-[#2563eb]">`)}
        ${fieldWrap('Objective', `<textarea data-field="objective" rows="2" placeholder="Students will be able to..." class="form-input w-full p-2.5 bg-white border border-[#dce3ed] rounded text-[13px] text-[#0d1f35] outline-none focus:border-[#2563eb] resize-none">${escHtml(slide.objective)}</textarea>`)}
    </div>`;
}

function renderContentCanvas(slide) {
    return `
    <div class="bg-white rounded-xl shadow-sm border border-[#dce3ed] p-8 min-h-[360px]">
        ${fieldWrap('Heading', `<input data-field="heading" type="text" value="${escHtml(slide.heading)}" placeholder="Slide heading" class="form-input w-full p-2.5 bg-white border border-[#dce3ed] rounded text-[16px] font-bold text-[#0d1f35] outline-none focus:border-[#2563eb]">`)}
        ${fieldWrap('Body', `<textarea data-field="body" rows="8" placeholder="Write this slide's content..." class="form-input w-full p-3 bg-white border border-[#dce3ed] rounded text-[13.5px] text-[#0d1f35] outline-none focus:border-[#2563eb] resize-none leading-relaxed">${escHtml(slide.body)}</textarea>`)}
    </div>`;
}

function renderMediaCanvas(slide) {
    const isImage = slide.mediaKind === 'image';

    const videoPreview = slide.embedUrl
        ? `<div class="aspect-video w-full bg-black rounded-lg overflow-hidden border border-[#dce3ed]">
             <iframe src="${escHtml(slide.embedUrl)}" class="w-full h-full" frameborder="0" allowfullscreen></iframe>
           </div>`
        : `<div class="aspect-video w-full bg-[#f4f7fb] rounded-lg border border-dashed border-[#dce3ed] flex items-center justify-center text-[#9ab0c6]">
             <div class="text-center">
               <i class="fa-solid fa-photo-film text-3xl mb-2 block"></i>
               <p class="text-[12px] font-semibold">Paste a YouTube, Vimeo, or Google Drive link</p>
             </div>
           </div>`;

    // onerror swaps the broken <img> for the same placeholder markup a media
    // slide already shows with no URL — a dead/incorrect image link degrades
    // to "no image yet" rather than a browser broken-image icon. Handled
    // inline (not addEventListener) because this string is re-parsed into
    // innerHTML on every render, same as every other slide preview here.
    const imagePreview = slide.imageUrl
        ? `<img src="${escHtml(slide.imageUrl)}" alt="${escHtml(slide.imageAlt)}"
               class="w-full max-h-[320px] object-contain rounded-lg border border-[#dce3ed] bg-[#f4f7fb]"
               onerror="this.closest('[data-media-preview]').innerHTML = document.getElementById('imgPreviewFallback').innerHTML">`
        : `<div class="w-full h-[220px] bg-[#f4f7fb] rounded-lg border border-dashed border-[#dce3ed] flex items-center justify-center text-[#9ab0c6]">
             <div class="text-center">
               <i class="fa-solid fa-image text-3xl mb-2 block"></i>
               <p class="text-[12px] font-semibold">Paste a direct image link</p>
             </div>
           </div>`;

    return `
    <div class="bg-white rounded-xl shadow-sm border border-[#dce3ed] p-8 min-h-[360px]">
        ${fieldWrap('Heading', `<input data-field="heading" type="text" value="${escHtml(slide.heading)}" placeholder="Slide heading" class="form-input w-full p-2.5 bg-white border border-[#dce3ed] rounded text-[16px] font-bold text-[#0d1f35] outline-none focus:border-[#2563eb]">`)}

        <div class="flex items-center gap-1 bg-[#f4f7fb] border border-[#dce3ed] rounded-lg p-1 w-fit mb-3">
            <button type="button" data-media-kind="video" class="px-3 py-1.5 rounded text-[12px] font-bold transition ${!isImage ? 'bg-white text-[#0d1f35] shadow-sm' : 'text-[#6b84a0]'}">
                <i class="fa-solid fa-video text-[11px] mr-1"></i>Video
            </button>
            <button type="button" data-media-kind="image" class="px-3 py-1.5 rounded text-[12px] font-bold transition ${isImage ? 'bg-white text-[#0d1f35] shadow-sm' : 'text-[#6b84a0]'}">
                <i class="fa-solid fa-image text-[11px] mr-1"></i>Image
            </button>
        </div>

        <div data-media-preview class="mb-2">${isImage ? imagePreview : videoPreview}</div>
        <p id="mediaUrlError" class="text-[11px] font-bold text-[#e31b4a] mb-2 ${mediaUrlInvalid.get(slide.id) ? '' : 'hidden'}">${isImage ? "That doesn't look like a direct image link (needs to end in .jpg, .png, etc.)." : "Couldn't recognize that as a YouTube, Vimeo, or Google Drive link."}</p>
        ${fieldWrap('Caption', `<input data-field="caption" type="text" value="${escHtml(slide.caption)}" placeholder="Optional caption" class="form-input w-full p-2.5 bg-white border border-[#dce3ed] rounded text-[13px] text-[#0d1f35] outline-none focus:border-[#2563eb]">`)}
    </div>
    <div id="imgPreviewFallback" class="hidden">
        <div class="w-full h-[220px] bg-[#fff0f3] rounded-lg border border-dashed border-[#e31b4a] flex items-center justify-center text-[#e31b4a]">
            <div class="text-center">
                <i class="fa-solid fa-triangle-exclamation text-3xl mb-2 block"></i>
                <p class="text-[12px] font-semibold">This image link couldn't be loaded</p>
            </div>
        </div>
    </div>`;
}

function renderAssignmentCanvas(slide) {
    return `
    <div class="bg-white rounded-xl shadow-sm border border-[#dce3ed] p-8 min-h-[360px]">
        ${fieldWrap('Heading', `<input data-field="heading" type="text" value="${escHtml(slide.heading)}" placeholder="e.g. Check for Understanding" class="form-input w-full p-2.5 bg-white border border-[#dce3ed] rounded text-[16px] font-bold text-[#0d1f35] outline-none focus:border-[#2563eb]">`)}
        ${fieldWrap('Prompt', `<textarea data-field="prompt" rows="4" placeholder="What should students do on this slide?" class="form-input w-full p-3 bg-white border border-[#dce3ed] rounded text-[13.5px] text-[#0d1f35] outline-none focus:border-[#2563eb] resize-none leading-relaxed">${escHtml(slide.prompt)}</textarea>`)}
        <p class="text-[11.5px] text-[#6b84a0] font-semibold"><i class="fa-solid fa-circle-info mr-1"></i>Pick which assignment this slide submits to in the panel on the right.</p>
    </div>`;
}

// ── PHASE 3: LIVE SESSION ENGINE — canvas renderers ───────────────────────
// Both block types are LIVE-ONLY: their student-facing form/wall only ever
// renders inside an active live_sessions document (see lessons/live.js's
// teacher dashboard and lessons/viewer.js's student auto-follow view) —
// there is no "preview" of the interactive experience itself here, same
// reason renderAssignmentCanvas above doesn't try to preview the student's
// submission form. The canvas here is purely the teacher's AUTHORING form
// for the block's own content (the prompt text / instructions), plus a
// static banner explaining that the interactive part only appears once a
// live session is started from this lesson's card in the Lesson Builder
// list (see builder.js's onLessonListClick 'golive' branch).
function liveOnlyBanner(text) {
    return `
    <p class="text-[11.5px] text-[#6b84a0] font-semibold bg-[#f4f7fb] border border-[#dce3ed] rounded-lg px-3 py-2.5 mt-2">
        <i class="fa-solid fa-tower-broadcast mr-1.5 text-[#2563eb]"></i>${text}
    </p>`;
}

function renderInteractivePromptCanvas(slide) {
    const isMultipleChoice = slide.promptKind === 'multiple_choice';
    const choicesHtml = (slide.choices || []).map((choice, i) => `
        <div class="flex items-center gap-2 mb-2" data-choice-row="${i}">
            <input data-choice-index="${i}" type="text" value="${escHtml(choice)}" placeholder="Choice ${i + 1}"
                   class="form-input flex-1 p-2 bg-white border border-[#dce3ed] rounded text-[13px] text-[#0d1f35] outline-none focus:border-[#2563eb]">
            <button type="button" data-remove-choice="${i}" class="text-[#9ab0c6] hover:text-[#e31b4a] w-7 h-7 flex-shrink-0 flex items-center justify-center transition">
                <i class="fa-solid fa-xmark text-[12px]"></i>
            </button>
        </div>`).join('');

    return `
    <div class="bg-white rounded-xl shadow-sm border border-[#dce3ed] p-8 min-h-[360px]">
        <span class="lb-live-badge inline-flex items-center gap-1.5 text-[10.5px] font-black uppercase tracking-wide px-2.5 py-1 rounded-full bg-[#eef2ff] text-[#4338ca] border border-[#c7d2fe] mb-3">
            <i class="fa-solid fa-bolt"></i> Interactive Prompt
        </span>
        ${fieldWrap('Heading', `<input data-field="heading" type="text" value="${escHtml(slide.heading)}" placeholder="e.g. Quick Check" class="form-input w-full p-2.5 bg-white border border-[#dce3ed] rounded text-[16px] font-bold text-[#0d1f35] outline-none focus:border-[#2563eb]">`)}
        ${fieldWrap('Prompt Text', `<textarea data-field="promptText" rows="3" placeholder="What question do you want students to answer?" class="form-input w-full p-3 bg-white border border-[#dce3ed] rounded text-[13.5px] text-[#0d1f35] outline-none focus:border-[#2563eb] resize-none leading-relaxed">${escHtml(slide.promptText)}</textarea>`)}

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
            <div id="promptChoicesList">${choicesHtml}</div>
            <button type="button" id="addChoiceBtn" class="text-[#2563eb] hover:text-[#1d4ed8] text-[12px] font-bold mt-1">
                <i class="fa-solid fa-plus mr-1"></i>Add Choice
            </button>
        </div>` : ''}

        ${liveOnlyBanner('Students answer this privately — only you see individual responses. This only works during a live session (use the broadcast icon on the lesson list).')}
    </div>`;
}

function renderCollaborativeBoardCanvas(slide) {
    return `
    <div class="bg-white rounded-xl shadow-sm border border-[#dce3ed] p-8 min-h-[360px]">
        <span class="lb-live-badge inline-flex items-center gap-1.5 text-[10.5px] font-black uppercase tracking-wide px-2.5 py-1 rounded-full bg-[#f0fdfa] text-[#0f766e] border border-[#99f6e4] mb-3">
            <i class="fa-solid fa-people-group"></i> Collaborative Board
        </span>
        ${fieldWrap('Heading', `<input data-field="heading" type="text" value="${escHtml(slide.heading)}" placeholder="e.g. Share One Idea" class="form-input w-full p-2.5 bg-white border border-[#dce3ed] rounded text-[16px] font-bold text-[#0d1f35] outline-none focus:border-[#2563eb]">`)}
        ${fieldWrap('Instructions', `<textarea data-field="instructions" rows="3" placeholder="What should students post to the board?" class="form-input w-full p-3 bg-white border border-[#dce3ed] rounded text-[13.5px] text-[#0d1f35] outline-none focus:border-[#2563eb] resize-none leading-relaxed">${escHtml(slide.instructions)}</textarea>`)}
        ${liveOnlyBanner('Every connected student\\'s card is visible to the whole class in real time. This only works during a live session (use the broadcast icon on the lesson list).')}
    </div>`;
}

function wireCanvasInputs(slide) {
    els.slideCanvas.querySelectorAll('[data-field]').forEach(input => {
        input.addEventListener('input', () => {
            slide[input.dataset.field] = input.value;
            hasUnsavedChanges = true;
            renderSlideThumbs(); // heading changes should update the thumbnail label live
        });
    });

    // Video/Image toggle only exists on a media slide's canvas. Switching
    // kinds doesn't clear the other kind's fields (mediaUrl/embedUrl stay
    // put when flipping to image, and vice versa) — so flipping back and
    // forth doesn't lose what was already typed in either one.
    els.slideCanvas.querySelectorAll('[data-media-kind]').forEach(btn => {
        btn.addEventListener('click', () => {
            const kind = btn.dataset.mediaKind;
            if (slide.mediaKind === kind) return;
            slide.mediaKind = kind;
            hasUnsavedChanges = true;
            renderSlideCanvas();
            renderPropertiesPanel();
        });
    });

    // Interactive Prompt: Short Answer / Multiple Choice toggle — same
    // pattern as the media video/image toggle above. Switching to
    // 'short_answer' intentionally leaves slide.choices untouched (so
    // flipping back to 'multiple_choice' doesn't lose what was typed).
    els.slideCanvas.querySelectorAll('[data-prompt-kind]').forEach(btn => {
        btn.addEventListener('click', () => {
            const kind = btn.dataset.promptKind;
            if (slide.promptKind === kind) return;
            slide.promptKind = kind;
            if (kind === 'multiple_choice' && !(slide.choices || []).length) {
                slide.choices = ['', ''];
            }
            hasUnsavedChanges = true;
            renderSlideCanvas();
        });
    });

    // Multiple Choice: Add Choice button — appends one empty choice and
    // re-renders so the new input row appears.
    els.slideCanvas.querySelector('#addChoiceBtn')?.addEventListener('click', () => {
        slide.choices = [...(slide.choices || []), ''];
        hasUnsavedChanges = true;
        renderSlideCanvas();
    });

    // Multiple Choice: per-choice text inputs — updates in place, no
    // full re-render needed (matches the generic [data-field] pattern
    // above; avoids losing focus/cursor position while typing).
    els.slideCanvas.querySelectorAll('[data-choice-index]').forEach(input => {
        input.addEventListener('input', () => {
            const i = Number(input.dataset.choiceIndex);
            if (!Array.isArray(slide.choices)) slide.choices = [];
            slide.choices[i] = input.value;
            hasUnsavedChanges = true;
        });
    });

    // Multiple Choice: remove-choice buttons — splice out the entry and
    // re-render so remaining rows re-index correctly.
    els.slideCanvas.querySelectorAll('[data-remove-choice]').forEach(btn => {
        btn.addEventListener('click', () => {
            const i = Number(btn.dataset.removeChoice);
            slide.choices = (slide.choices || []).filter((_, idx) => idx !== i);
            hasUnsavedChanges = true;
            renderSlideCanvas();
        });
    });
}

// ── 10. PROPERTIES PANEL (right pane — type-specific extras) ─────────────
function renderPropertiesPanel() {
    const slide = currentSlide();
    if (!slide) { els.propertiesPanel.innerHTML = ''; return; }

    if (slide.type === 'media') {
        renderMediaProperties(slide);
    } else if (slide.type === 'assignment') {
        renderAssignmentProperties(slide);
    } else {
        els.propertiesPanel.innerHTML = `
        <p class="text-[10px] font-bold text-[#6b84a0] uppercase tracking-widest mb-3">Slide Properties</p>
        <p class="text-[12px] text-[#9ab0c6] font-semibold">This slide type has no additional properties — everything is edited on the canvas.</p>`;
    }
}

function renderMediaProperties(slide) {
    if (slide.mediaKind === 'image') {
        renderImageProperties(slide);
    } else {
        renderVideoProperties(slide);
    }
}

function renderVideoProperties(slide) {
    els.propertiesPanel.innerHTML = `
    <p class="text-[10px] font-bold text-[#6b84a0] uppercase tracking-widest mb-3">Media Source</p>
    ${fieldWrap('Video URL', `<input id="mediaUrlInput" type="url" value="${escHtml(slide.mediaUrl)}" placeholder="https://youtube.com/watch?v=..." class="form-input w-full p-2.5 bg-white border border-[#dce3ed] rounded text-[13px] text-[#0d1f35] outline-none focus:border-[#2563eb]">`)}
    <p class="text-[11px] text-[#9ab0c6] font-semibold leading-relaxed">
        <i class="fa-solid fa-circle-info mr-1"></i>
        Paste a full YouTube, Vimeo, or Google Drive link. It's parsed into a safe embed automatically — raw video files aren't supported; only external links.
    </p>`;

    const input = document.getElementById('mediaUrlInput');
    input.addEventListener('input', () => {
        const parsed = parseMediaUrl(input.value);
        slide.mediaUrl = input.value;
        if (input.value.trim() && !parsed) {
            slide.provider = null;
            slide.embedUrl = '';
            mediaUrlInvalid.set(slide.id, true);
        } else {
            slide.provider = parsed?.provider || null;
            slide.embedUrl = parsed?.embedUrl || '';
            mediaUrlInvalid.set(slide.id, false);
        }
        hasUnsavedChanges = true;
        renderSlideCanvas(); // re-render to update the live embed preview + error message
    });
}

function renderImageProperties(slide) {
    els.propertiesPanel.innerHTML = `
    <p class="text-[10px] font-bold text-[#6b84a0] uppercase tracking-widest mb-3">Media Source</p>
    ${fieldWrap('Image URL', `<input id="imageUrlInput" type="url" value="${escHtml(slide.imageUrl)}" placeholder="https://example.com/photo.jpg" class="form-input w-full p-2.5 bg-white border border-[#dce3ed] rounded text-[13px] text-[#0d1f35] outline-none focus:border-[#2563eb]">`)}
    ${fieldWrap('Alt Text', `<input id="imageAltInput" type="text" value="${escHtml(slide.imageAlt)}" placeholder="Describe the image for screen readers" class="form-input w-full p-2.5 bg-white border border-[#dce3ed] rounded text-[13px] text-[#0d1f35] outline-none focus:border-[#2563eb]">`)}
    <p class="text-[11px] text-[#9ab0c6] font-semibold leading-relaxed">
        <i class="fa-solid fa-circle-info mr-1"></i>
        Paste a direct link to an image file. No uploads — this keeps storage costs at zero, same as video slides.
    </p>`;

    const urlInput = document.getElementById('imageUrlInput');
    urlInput.addEventListener('input', () => {
        slide.imageUrl = urlInput.value;
        mediaUrlInvalid.set(slide.id, !!urlInput.value.trim() && !isLikelyImageUrl(urlInput.value));
        hasUnsavedChanges = true;
        renderSlideCanvas(); // re-render to update the live image preview + error message
    });

    document.getElementById('imageAltInput').addEventListener('input', (e) => {
        slide.imageAlt = e.target.value;
        hasUnsavedChanges = true;
        // No canvas re-render needed here — alt text isn't visible in the
        // preview itself, only in the <img alt> attribute.
    });
}

function renderAssignmentProperties(slide) {
    const assignments = (currentSubject?.assignments || []).filter(a => !a.archived);
    const options = ['<option value="">Select an assignment…</option>']
        .concat(assignments.map(a => `<option value="${escHtml(a.id)}" ${slide.linkedAssignmentId === a.id ? 'selected' : ''}>${escHtml(a.title)} (/${a.maxScore})</option>`));

    els.propertiesPanel.innerHTML = `
    <p class="text-[10px] font-bold text-[#6b84a0] uppercase tracking-widest mb-3">Linked Assignment</p>
    ${fieldWrap('Assignment', `<select id="linkedAssignmentSelect" class="form-input w-full p-2.5 bg-white border border-[#dce3ed] rounded text-[13px] text-[#0d1f35] outline-none focus:border-[#2563eb]">${options.join('')}</select>`)}
    <p class="text-[11px] text-[#9ab0c6] font-semibold leading-relaxed">
        <i class="fa-solid fa-circle-info mr-1"></i>
        Students submit directly on this slide — grading, locking, and submission history all use this subject's existing assignment records, unchanged.
    </p>
    ${!assignments.length ? `<p class="text-[11px] font-bold text-[#e31b4a] mt-2">No assignments exist for this subject yet — create one from Enter Grade first.</p>` : ''}`;

    document.getElementById('linkedAssignmentSelect').addEventListener('change', (e) => {
        slide.linkedAssignmentId = e.target.value || null;
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
    const payload = { title: lessonDraft.title, slides: currentSlidesForSave() };
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
    const payload = { title: lessonDraft.title, slides: currentSlidesForSave() };
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

// ── IMPORT MATERIALS (Phase 3 scaffolding) ───────────────────────────────
// Two import paths, both reachable from one "Import Options" modal next to
// "New Lesson": a Google Slides / PowerPoint "Publish to Web" embed link
// (works today — see onImportSlidesClick, below), and a .docx file picker
// (stubbed per this phase's scope — reads the file and reports back; actual
// .docx → lesson-content conversion is intentionally NOT implemented yet).
function openImportOptionsModal() {
    if (!currentPostContext) { alert('Select a subject first.'); return; }
    els.importDocxInput.value = '';
    els.importDocxStatus.classList.add('hidden');
    els.importSlidesUrlInput.value = '';
    els.importSlidesStatus.classList.add('hidden');
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
// real, working 'media' slide (mediaKind: 'video', reusing the exact same
// iframe-embed rendering path parseMediaUrl()'s YouTube/Vimeo/Drive results
// already use — see newSlide('media') in lessons.js) rather than a UI-only
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
        const slide = newSlide('media');
        slide.mediaKind = 'video';
        slide.provider = 'embed';
        slide.embedUrl = embedUrl;
        slide.heading = 'Imported Presentation';
        lessonDraft.slides.splice(currentSlideIndex + 1, 0, slide);
        currentSlideIndex += 1;
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
