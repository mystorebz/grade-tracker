// ── ENTERPRISE LESSON REDESIGN, PHASE 1: TEACHER SLIDE-DECK BUILDER ───────
// Three-pane authoring UI: slide sidebar (thumbnails, add/delete/reorder),
// center canvas (the selected slide's editable content), right properties
// panel (that slide's type-specific fields — media URL + live embed
// preview, or the linked-assignment picker). A single in-memory
// `lessonDraft` object mirrors the lessons/{lessonId} schema exactly;
// every edit mutates it directly and re-renders only what changed.
import { requireAuth } from '../../../assets/js/auth.js';
import { injectTeacherLayout } from '../../../assets/js/layout-teachers.js';
import { showMsg, loadTeacherSubjectsCache } from '../../../assets/js/utils.js';
import { resolvePostContext } from '../../../assets/js/posts.js';
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

const ASSIGNMENT_TEMPLATE_LABELS = {
    title: 'Title / Objective',
    content: 'Rich Content',
    media: 'Media',
    assignment: 'Embedded Assignment'
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

    els.subjectSelect.innerHTML = '<option value="">Loading subjects…</option>';
    const result = await loadTeacherSubjectsCache(session.schoolId, session.teacherId, session.teacherData);
    subjectsCache = result.subjectsCache;
    resolvedClasses = result.resolvedClasses;

    renderSubjectOptions();
    await onSubjectChange();
}

function cacheEls() {
    [
        'lessonPickerView', 'builderView',
        'subjectSelect', 'newLessonBtn', 'lessonListCount', 'lessonList',
        'backToListBtn', 'slideThumbList', 'addSlideBtn', 'slideTemplateMenu',
        'lessonTitleInput', 'statusPill', 'saveMsg', 'notesBtn', 'saveBtn', 'publishBtn', 'publishBtnLabel',
        'slideCanvas', 'propertiesPanel',
        'notesOverlay', 'pacingNotesInput', 'standardsInput', 'closeNotesBtn', 'cancelNotesBtn', 'saveNotesBtn'
    ].forEach(id => { els[id] = document.getElementById(id); });
}

function wireEvents() {
    els.subjectSelect.addEventListener('change', onSubjectChange);
    els.newLessonBtn.addEventListener('click', onCreateLesson);
    els.lessonList.addEventListener('click', onLessonListClick);

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
    els.closeNotesBtn.addEventListener('click', closeNotesModal);
    els.cancelNotesBtn.addEventListener('click', closeNotesModal);
    els.saveNotesBtn.addEventListener('click', onSaveNotes);
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
    const slideCount = (lesson.slides || []).length;

    return `
    <div class="lesson-card bg-white rounded-xl shadow-sm border border-[#dce3ed] p-4 flex items-center justify-between gap-3" data-lesson-id="${escHtml(lesson.id)}">
        <div class="min-w-0 cursor-pointer flex-1" data-action="open">
            <div class="flex items-center gap-2 flex-wrap mb-1">
                <p class="font-bold text-[#0d1f35] text-[14px] m-0">${escHtml(lesson.title) || 'Untitled Lesson'}</p>
                <span class="text-[10px] font-black uppercase tracking-wide px-2 py-0.5 rounded-md border ${pillClasses}">${isPublished ? 'Published' : 'Draft'}</span>
            </div>
            <p class="text-[11px] text-[#9ab0c6] font-semibold m-0">${slideCount} slide${slideCount === 1 ? '' : 's'} · Updated ${escHtml(formatDate(lesson.updatedAt))}</p>
        </div>
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

async function onCreateLesson() {
    if (!currentPostContext) {
        alert('Select a subject first.');
        return;
    }
    try {
        const authorContext = { authorId: session.teacherId, authorName: session.teacherData.name };
        const lesson = await createLesson(session.schoolId, currentPostContext, authorContext, { title: 'Untitled Lesson' });
        lessonsCache.unshift(lesson);
        await openBuilder(lesson.id);
    } catch (e) {
        console.error('[Lesson Builder] createLesson:', e);
        alert('Failed to create a new lesson. Please try again.');
    }
}

// ── 6. OPEN / CLOSE BUILDER ──────────────────────────────────────────────
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
        els.builderView.classList.remove('hidden');
        els.builderView.classList.add('flex');

        renderAll();
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
    els.lessonPickerView.classList.remove('hidden');

    // Refresh the list so title/status/slide-count edits made in the
    // builder are reflected immediately without a full page reload.
    onSubjectChange();
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
    els.statusPill.textContent = isPublished ? 'Published' : 'Draft';
    els.statusPill.className = 'text-[10px] font-black uppercase tracking-wide px-2.5 py-1 rounded-md flex-shrink-0 whitespace-nowrap ' +
        (isPublished ? 'bg-[#ecfdf5] text-[#059669] border border-[#a7f3d0]' : 'bg-[#f4f7fb] text-[#6b84a0] border border-[#dce3ed]');
}

function renderPublishButton() {
    const isPublished = lessonDraft.status === 'published';
    els.publishBtnLabel.textContent = isPublished ? 'Unpublish' : 'Publish';
    els.publishBtn.classList.toggle('bg-[#0d1f35]', !isPublished);
    els.publishBtn.classList.toggle('hover:bg-[#2563eb]', !isPublished);
    els.publishBtn.classList.toggle('bg-white', isPublished);
    els.publishBtn.classList.toggle('text-[#0d1f35]', isPublished);
    els.publishBtn.classList.toggle('border', isPublished);
    els.publishBtn.classList.toggle('border-[#dce3ed]', isPublished);
    els.publishBtn.classList.toggle('text-white', !isPublished);
}

// ── 7. SLIDE SIDEBAR (thumbnails, select, delete, reorder) ───────────────
function renderSlideThumbs() {
    els.slideThumbList.innerHTML = lessonDraft.slides.map((slide, i) => renderSlideThumb(slide, i)).join('');
}

function slideThumbIcon(type) {
    return { title: 'fa-heading', content: 'fa-align-left', media: 'fa-photo-film', assignment: 'fa-clipboard-check' }[type] || 'fa-file';
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

// ── 8. SLIDE CANVAS (center pane — the slide's main editable content) ────
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
        assignment: renderAssignmentCanvas
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
}

// ── 9. PROPERTIES PANEL (right pane — type-specific extras) ──────────────
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
        // Re-focus + restore cursor since renderSlideCanvas rebuilds the DOM;
        // the properties panel input isn't rebuilt so it keeps focus, but the
        // canvas's own preview needs the fresh embedUrl to show immediately.
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

// ── 10. SAVE / PUBLISH ───────────────────────────────────────────────────
async function onSaveDraft() {
    const prevLabel = els.saveBtn.textContent;
    els.saveBtn.disabled = true;
    els.saveBtn.textContent = 'Saving…';
    try {
        await saveLessonContent(session.schoolId, currentPostContext, currentLessonId, {
            title: lessonDraft.title,
            slides: lessonDraft.slides
        });
        hasUnsavedChanges = false;
        flashSaveMsg('Saved');
    } catch (e) {
        console.error('[Lesson Builder] saveLessonContent:', e);
        alert('Failed to save this lesson. Please try again.');
    } finally {
        els.saveBtn.disabled = false;
        els.saveBtn.textContent = prevLabel;
    }
}

function flashSaveMsg(text) {
    els.saveMsg.textContent = text;
    els.saveMsg.classList.remove('hidden');
    setTimeout(() => els.saveMsg.classList.add('hidden'), 2500);
}

async function onPublishToggle() {
    // Publishing (and unpublishing) always saves current draft content
    // first, so a teacher who edited slides and immediately hits Publish
    // never publishes stale content from the last explicit Save.
    els.publishBtn.disabled = true;
    try {
        await saveLessonContent(session.schoolId, currentPostContext, currentLessonId, {
            title: lessonDraft.title,
            slides: lessonDraft.slides
        });
        hasUnsavedChanges = false;

        if (lessonDraft.status === 'published') {
            if (!confirm('Unpublish this lesson? Students will no longer be able to open it. (Its Class Stream announcement, if any, stays visible.)')) {
                els.publishBtn.disabled = false;
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
        console.error('[Lesson Builder] onPublishToggle:', e);
        alert('Failed to update this lesson\'s publish status. Please try again.');
    } finally {
        els.publishBtn.disabled = false;
    }
}

// ── 11. TEACHER-ONLY NOTES MODAL ─────────────────────────────────────────
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

init();
