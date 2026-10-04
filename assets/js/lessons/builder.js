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
    createLesson, insertLesson, saveLessonContent, saveLessonPrivateNotes,
    publishLesson, unpublishLesson, deleteLesson, saveQuizKey, loadQuizKey, pruneLessonQuizKeys
} from '../../../assets/js/lessons.js';
import {
    STAGE, MIN_SIZE, v2SlideToV3, v3SlideToV2, v2BlockToV3Object, v3ObjectToV2Block,
    keyAbove, generateKeyBetween, stableStringify, createObject, newObjectId, newSlideId, LEGACY_CONTENT_SCALE
} from './canvas/model.js';
import { mountStage, renderSlide, slideBackground, slideTransition } from './canvas/renderer.js';
import { createFormatToolbar } from './canvas/toolbar.js';
import { openSlideshow } from './slideshow.js';
import { openDocumentPresentation } from './doc-present.js';
import { createDocumentEditor, DOC_WIDGET_TYPES } from './document.js';
import { createCanvasStore } from './canvas/store.js';
import { createTransformEngine } from './canvas/transform.js';
import { createTextTool, loadTextLibs, readEditorState, FONT_FAMILIES, FONT_SIZES, LINE_HEIGHTS } from './canvas/tools/text.js';
import { textFormatMenu, textFormatCommand } from './canvas/tools/text-formats.js';
import { SHAPE_KINDS, createShape, shapeMarkup, shapeIcon } from './canvas/tools/shape.js';
import { LINE_PRESETS, createLine, lineMarkup, lineIcon } from './canvas/tools/line.js';
import { uploadLessonImage, dataUrlToBlob, measureImage, searchStock, importStock, normalizeCrop } from './canvas/tools/image.js';
import { WIDGET_TYPES, WIDGET_META, createWidget, newOption, widgetThumbHtml } from './canvas/tools/interactive.js';

// ── 1. AUTHENTICATION & LAYOUT ──────────────────────────────────────────────
const session = requireAuth('teacher', '../login.html');
// teacher/lessons/builder.html is now the lesson PICKER only (subject select,
// lesson list, New Lesson, Import). The editor itself mounts in-context inside
// teacher/subjects/subject.html via mountLessonEditor() — see section 0 below.
const STANDALONE = !!document.getElementById('lessonPickerView');
if (session && STANDALONE) {
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
let dirtyVersion = 0;          // bumps on every edit; a save only clears dirty if no edit landed mid-save
let saveInFlight = null;       // the pending saveLessonContent() promise, if any
let autosaveTimer = null;
const AUTOSAVE_MS = 2000;
let embedded = null;           // { container, onExit, onSaved, onCreated, onTitleChange, author } while mounted in-context
let isNewDraft = false;        // true while the open lesson exists only in memory (never written yet)
let editorAbort = null;        // AbortController for the mounted editor's document/window listeners

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

// Canvas editor engine (section 9b). canvasStore lives for the open lesson;
// canvasStage/canvasEngine for the canvas slide currently on screen.
let canvasStore = null;
let canvasUnsub = null;
let canvasStage = null;
let canvasEngine = null;
let canvasSlideId = null;
let zoomObserver = null;
let canvasWritingBack = false;        // store → draft write in progress (markDirty must not sync back)
const draftPrints = new Map();        // slideId → v2 fingerprint both sides last agreed on
let editingTextId = null;             // object id with a live inline Tiptap editor (tools/text.js)
let textTool = null;
let formatToolbar = null;             // canvas/toolbar.js — the selection-driven Format toolbar
let suppressPanelRender = false;      // a Properties control is mid-edit: don't rebuild it under the pointer
let canvasClipboard = null;           // JSON payload of the last copy/cut (survives lesson switches)
let lastPaste = { sig: null, slideId: null, n: 0 };

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

// ── SLIDE DECK REDESIGN: slide-layout gallery ("Add Slide" popover) ────────
// PowerPoint's "New Slide" gallery, adapted here now that blocks are
// free-form positioned objects (x/y/w/h — see lessons.js's newBlock()):
// each entry is just a starting arrangement of ordinary Text/Video blocks
// at sensible positions, nothing more. Nothing this creates is locked in —
// every block it places can still be dragged, resized, edited or deleted
// exactly like a block inserted from the toolbar, because it IS one. Layout
// percentages here are hand-picked to look right on the 16:9 stage, not
// computed.
//
// `role`/`placeholder` (not `html`) carry each block's "Click to add…"
// copy — a REAL Quill placeholder (see wireBlockRichFields()'s `placeholder:`
// option and the .ql-editor.ql-blank::before CSS rules), not literal saved
// text. This is deliberate: html stays '' until the teacher actually types,
// so an untouched slide renders as a genuinely empty text box everywhere
// else (live.js, viewer.js, thumbnails) instead of leaking the words
// "Click to add title" to students. `role` also picks the placeholder's
// look (title/subtitle/heading — see the CSS) so it reads at a glance which
// kind of box it is, the same way Google Slides' placeholder boxes do.
const SLIDE_LAYOUTS = {
    blank: { label: 'Blank', icon: 'fa-square', blocks: [] },
    title: {
        label: 'Title Slide', icon: 'fa-heading', blocks: [
            { type: 'text', layout: { x: 10, y: 36, w: 80, h: 16 }, role: 'title', placeholder: 'Click to add title' },
            { type: 'text', layout: { x: 15, y: 54, w: 70, h: 12 }, role: 'subtitle', placeholder: 'Click to add subtitle' }
        ]
    },
    title_content: {
        label: 'Title + Content', icon: 'fa-align-left', blocks: [
            { type: 'text', layout: { x: 6, y: 6, w: 88, h: 14 }, role: 'heading', placeholder: 'Click to add title' },
            { type: 'text', layout: { x: 6, y: 24, w: 88, h: 70 }, role: 'body', placeholder: 'Click to add text' }
        ]
    },
    two_content: {
        label: 'Two Content', icon: 'fa-table-columns', blocks: [
            { type: 'text', layout: { x: 6, y: 6, w: 88, h: 14 }, role: 'heading', placeholder: 'Click to add title' },
            { type: 'text', layout: { x: 6, y: 24, w: 42, h: 70 }, role: 'body', placeholder: 'Click to add text' },
            { type: 'text', layout: { x: 52, y: 24, w: 42, h: 70 }, role: 'body', placeholder: 'Click to add text' }
        ]
    },
    title_media: {
        label: 'Title + Media', icon: 'fa-photo-film', blocks: [
            { type: 'text', layout: { x: 6, y: 6, w: 88, h: 14 }, role: 'heading', placeholder: 'Click to add title' },
            { type: 'video', layout: { x: 12, y: 24, w: 76, h: 68 } }
        ]
    }
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
    // Deep link straight to a lesson: skip the picker entirely.
    if (urlSubjectId && urlLessonId) {
        const urlClassId = deepLinkParams.get('classId');
        const sub = subjectsCache.find(s => s.id === urlSubjectId && (!urlClassId || !s.classId || s.classId === urlClassId));
        const ctx = sub ? resolvePostContext(sub, resolvedClasses) : null;
        if (ctx) { window.location.replace(subjectLessonUrl(ctx, urlLessonId)); return; }
    }
    if (urlSubjectId && [...els.subjectSelect.options].some(o => o.value === urlSubjectId)) {
        els.subjectSelect.value = urlSubjectId;
    }

    await onSubjectChange();

    if (urlLessonId && currentPostContext) {
        openInContext(urlLessonId);
    }
}

// Every "open this lesson" from the picker lands in the subject page's Lessons
// tab, where the editor mounts in-context (teacher never loses their place).
function subjectLessonUrl(ctx, lessonId) {
    const params = new URLSearchParams({ c: ctx.classId, s: ctx.subjectId, tab: 'lessons' });
    if (lessonId) params.set('lesson', lessonId);
    return `../subjects/subject.html?${params.toString()}`;
}

function openInContext(lessonId) {
    if (!currentPostContext) return;
    window.location.href = subjectLessonUrl(currentPostContext, lessonId);
}

function cacheEls() {
    [
        'lessonPickerView', 'builderView', 'docBuilderView',
        'subjectSelect', 'newLessonBtn', 'lessonListCount', 'lessonList',
        'backToListBtn', 'slideThumbList', 'addSlideBtn', 'addCollabBoardBtn',
        'lessonTitleInput', 'statusPill', 'saveMsg', 'notesBtn', 'saveBtn', 'publishBtn', 'publishBtnLabel',
        'slideCanvas', 'formatContext', 'menuBar', 'slideshowBtn', 'lessonEditorRoot',
        'slideCanvasArea', 'slideCanvasWrap', 'canvasUndoBtn', 'canvasRedoBtn', 'canvasZoomGroup', 'canvasZoomLabel', 'canvasZoomBtn',
        // SLIDE DECK REDESIGN: persistent insert toolbar + its Image/Video
        // popovers — see wireInsertToolbar().
        'slideInsertToolbar',
        'insertImageBtn', 'insertImageMenu', 'insertImageUploadRow',
        'insertImageUrlInput', 'insertImageUrlBtn', 'insertImageFileInput',
        'insertVideoBtn', 'insertVideoMenu', 'insertVideoUrlInput', 'insertVideoUrlBtn', 'insertVideoError',
        // Theme is a real gallery modal now (see openThemeGallery()), not a
        // corner dropdown — opened from Slide ▸ Change theme / the slide tools.
        'themeBtn', 'themeBtnDot', 'themeOverlay', 'closeThemeBtn', 'themeGallery',
        // "Add Slide" is a split button: the main button instantly inserts
        // the default Title+Content layout, and addSlideLayoutToggleBtn
        // opens the layout gallery popover (see wireAddSlideLayoutMenu())
        // for picking a different starting arrangement.
        'addSlideLayoutToggleBtn', 'addSlideLayoutMenu',
        // Insert ▸ Shapes / Line menus (Phase 4 step 3)
        'insertShapeBtn', 'insertShapeMenu', 'insertShapeGrid', 'insertLineBtn', 'insertLineMenu',
        // Phase 4 step 4: photo library + student activities
        'insertImageStockRow', 'insertWidgetBtn', 'insertWidgetMenu',
        'docBackToListBtn', 'docLessonTitleInput', 'docStatusPill', 'docSaveMsg',
        'docNotesBtn', 'docSaveBtn', 'docPublishBtn', 'docPublishBtnLabel', 'docSlideshowBtn', 'docWorkspace',
        'docMenuBar', 'docFormatToolbar', 'docFormatContext', 'docUndoBtn', 'docRedoBtn',
        'docInsertVideoBtn', 'docInsertWidgetBtn', 'docInsertWidgetMenu', 'docEditor',
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
    if (STANDALONE) wirePickerEvents();
}

// Picker page (teacher/lessons/builder.html): subject select, lesson list,
// New Lesson format choice, Import Options.
function wirePickerEvents() {
    els.subjectSelect.addEventListener('change', onSubjectChange);
    els.newLessonBtn.addEventListener('click', openFormatChoiceModal);
    els.lessonList.addEventListener('click', onLessonListClick);

    els.closeFormatChoiceBtn.addEventListener('click', closeFormatChoiceModal);
    els.formatChoiceOverlay.addEventListener('click', (e) => {
        if (e.target === els.formatChoiceOverlay) closeFormatChoiceModal();
    });
    document.querySelectorAll('.format-choice-btn').forEach(btn => {
        btn.addEventListener('click', () => onCreateLesson(btn.dataset.format));
    });

    els.importOptionsBtn.addEventListener('click', openImportOptionsModal);
    els.closeImportOptionsBtn.addEventListener('click', closeImportOptionsModal);
    els.importOptionsOverlay.addEventListener('click', (e) => {
        if (e.target === els.importOptionsOverlay) closeImportOptionsModal();
    });
    els.importDocxTrigger.addEventListener('click', () => els.importDocxInput.click());
    els.importDocxInput.addEventListener('change', onImportDocxFileSelected);
    els.importSlidesBtn.addEventListener('click', onImportSlidesClick);

    els.importPptxTrigger.addEventListener('click', () => els.importPptxInput.click());
    els.importPptxInput.addEventListener('change', onImportPptxFileSelected);
    document.addEventListener('paste', onImportPptxPaste);
    document.addEventListener('paste', onImportDocxPaste);
}

// Mounted editor (lesson-editor.html fragment). Element listeners die with the
// fragment's DOM; document/window listeners use editorAbort.signal.
// ── Focus Mode: the editor covers the whole browser window ────────────────
// Toggles .editor-focus-mode on the editor root (position:fixed; inset:0;
// z 9999 — see lesson-editor.css). The ResizeObserver on .editor-workspace
// (ensureCanvasStage) re-fits the 1600×900 stage; it is also re-fitted here
// right away so the slide never shows one frame at the old size.
let focusMode = false;

function editorRootEl() {
    return embedded?.container?.querySelector('#lessonEditorRoot') || document.getElementById('lessonEditorRoot');
}

function setFocusMode(on) {
    on = !!on;
    const root = editorRootEl();
    focusMode = on && !!root;
    root?.classList.toggle('editor-focus-mode', focusMode);
    document.documentElement.classList.toggle('lb-focus-active', focusMode);
    root?.querySelectorAll('[data-focus-toggle]').forEach((b) => {
        const label = focusMode ? 'Exit full screen (Esc)' : 'Expand to full screen';
        b.title = label;
        b.setAttribute('aria-label', label);
        b.setAttribute('aria-pressed', String(focusMode));
        const i = b.querySelector('i');
        i?.classList.toggle('fa-expand', !focusMode);
        i?.classList.toggle('fa-compress', focusMode);
    });
    if (!root) return;
    closeAllInsertPopovers();
    closeMenus();
    formatToolbar?.closePopover();
    docFormatToolbar?.closePopover();
    applyCanvasZoom(); // layout is synchronous: the fit is right on this frame
    requestAnimationFrame(() => {
        applyCanvasZoom();
        window.dispatchEvent(new Event('resize')); // floating toolbars, Moveable, thumbnails
    });
}

function editorModalOpen() {
    const ids = ['themeOverlay', 'notesOverlay', 'assignmentPickerOverlay', 'assignmentViewOverlay', 'formatChoiceOverlay', 'importOptionsOverlay'];
    if (ids.some(id => els[id] && !els[id].classList.contains('hidden'))) return true;
    if (docEditor?.isModalOpen()) return true;
    if (document.querySelector('dialog.doc-present[open], dialog.slideshow-modal[open]')) return true;
    const stock = document.getElementById('lbStockOverlay');
    return !!(stock && !stock.classList.contains('hidden'));
}

function insertPopoverOpen() {
    return ['canvasZoomGroup', 'insertShapeMenu', 'insertWidgetMenu', 'insertLineMenu', 'insertImageMenu', 'insertVideoMenu', 'addSlideLayoutMenu', 'docInsertWidgetMenu']
        .some(id => els[id] && !els[id].classList.contains('hidden'));
}

// Esc order: finish text editing (onCanvasKeydown) → close a modal (its own
// handler) → close an open menu → leave a focused field → exit Focus Mode.
function onFocusModeKeydown(e) {
    if (!focusMode || e.key !== 'Escape' || e.isComposing) return;
    // ProseMirror marks every Esc as handled (preventDefault) without using it —
    // in the document page it must still reach Focus Mode
    const inDocPage = isDocMode() && !!e.target?.closest?.('#docEditor');
    if (e.defaultPrevented && !inDocPage) return;
    if (editorModalOpen()) return;
    if (menuState.open) { closeMenus(); return; }
    if (insertPopoverOpen()) { closeAllInsertPopovers(); return; }
    // a field (title, toolbar input) gives up focus first; the document page itself
    // is where a teacher types all the time, so Esc there leaves Focus Mode at once
    if (focusIsTyping() && !inDocPage) { document.activeElement.blur(); return; }
    e.preventDefault();
    setFocusMode(false);
}

function wireFocusMode() {
    focusMode = false;
    document.documentElement.classList.remove('lb-focus-active');
    editorRootEl()?.querySelectorAll('[data-focus-toggle]').forEach((b) => {
        b.addEventListener('click', () => setFocusMode(!focusMode));
    });
    document.addEventListener('keydown', onFocusModeKeydown, { signal: editorAbort?.signal });
}

// ── MENU BAR (File · Edit · View · Insert · Format · Slide · Arrange) ─────
// State machine: menuState.open = the open top-level menu (or null),
// menuState.sub = the open submenu's parent item. One click listener on
// .menu-bar handles toggles, submenus and commands (the dropdown panels live
// inside .menu-bar, position:fixed so the editor's overflow never clips
// them); any click outside closes everything. Menu models are rebuilt on
// every open, so labels / checkmarks / disabled states are always current.
// Every item runs a command id through runCommand() — the same store /
// transform-engine commands the keyboard shortcuts and toolbar use.
const menuState = { open: null, sub: null, panel: null, subPanel: null, subTimer: 0 };
const SLIDE_MENU_KEYS = ['file', 'edit', 'view', 'insert', 'format', 'slide', 'arrange'];
const DOC_MENU_KEYS = ['file', 'edit', 'view', 'insert', 'format'];
// Slides and Documents each have their own .menu-bar (#menuBar / #docMenuBar);
// the one for the open lesson's format is live.
const isDocMode = () => lessonDraft?.format === 'document';
const menuBarEl = () => (isDocMode() ? els.docMenuBar : els.menuBar);
const menuKeys = () => (isDocMode() ? DOC_MENU_KEYS : SLIDE_MENU_KEYS);
const IS_MAC = /Mac|iPhone|iPad/.test(navigator.platform || '');
const kbd = (k) => (IS_MAC ? k.replace(/Ctrl\+/g, '⌘').replace(/Shift\+/g, '⇧').replace(/Alt\+/g, '⌥') : k);

function canvasReady() {
    const slide = currentSlide();
    return !!(canvasStore && slide && slide.type === 'blank' && canvasSlideId === slide.id);
}
const selCount = () => (canvasReady() ? selectedIds().length : 0);
const textContext = () => !!(canvasReady() && formatToolbar?.isTextContext());
const editingNow = () => !!(textTool && textTool.isEditing());

const item = (cmd, label, opts = {}) => ({ cmd, label, ...opts });
const SEP = { sep: true };

function menuModel(key) {
    if (isDocMode()) return docMenuModel(key);
    const ready = canvasReady();
    const n = selCount();
    const sel = ready ? selectedIds() : [];
    const objs = sel.map(id => canvasStore.getObject(id)).filter(Boolean);
    const published = lessonDraft?.status === 'published';
    const z = canvasStore?.getState().zoom;
    const slide = currentSlide();
    const isBlank = slide?.type === 'blank';
    const text = textContext();
    const st = text ? textTool?.state?.(sel[0] || textTool.editingId()) : null;
    switch (key) {
        case 'file': return [
            item('file.save', 'Save draft', { icon: 'fa-floppy-disk', kbd: 'Ctrl+S' }),
            item('file.publish', published ? 'Unpublish' : 'Publish to students', { icon: 'fa-paper-plane' }),
            SEP,
            item('file.slideshow', 'Slideshow from this slide', { icon: 'fa-display', kbd: 'Ctrl+Enter' }),
            item('file.slideshowStart', 'Slideshow from the beginning', { icon: 'fa-backward-step', kbd: 'Ctrl+Shift+Enter' }),
            item('file.live', 'Present live to the class…', { icon: 'fa-tower-broadcast', disabled: !published, hint: published ? '' : 'Publish first' }),
            SEP,
            item('file.notes', 'Teacher notes…', { icon: 'fa-note-sticky' }),
            item('file.exit', 'Back to all lessons', { icon: 'fa-arrow-left' }),
        ];
        case 'edit': return [
            item('edit.undo', 'Undo', { icon: 'fa-rotate-left', kbd: 'Ctrl+Z', disabled: !(editingNow() || canvasStore?.canUndo()) }),
            item('edit.redo', 'Redo', { icon: 'fa-rotate-right', kbd: 'Ctrl+Y', disabled: !(editingNow() || canvasStore?.canRedo()) }),
            SEP,
            item('edit.cut', 'Cut', { icon: 'fa-scissors', kbd: 'Ctrl+X', disabled: !(editingNow() || n) }),
            item('edit.copy', 'Copy', { icon: 'fa-copy', kbd: 'Ctrl+C', disabled: !(editingNow() || n) }),
            item('edit.paste', 'Paste', { icon: 'fa-paste', kbd: 'Ctrl+V', disabled: !ready }),
            item('edit.duplicate', 'Duplicate', { icon: 'fa-clone', kbd: 'Ctrl+D', disabled: !n || editingNow() }),
            item('edit.delete', 'Delete', { icon: 'fa-trash-can', kbd: 'Del', disabled: !n || editingNow() }),
            SEP,
            item('edit.selectAll', 'Select all', { icon: 'fa-object-group', kbd: 'Ctrl+A', disabled: !ready }),
        ];
        case 'view': return [
            item('view.zoom', 'Zoom', { icon: 'fa-magnifying-glass', disabled: !ready, sub: [
                item('view.zoom.fit', 'Fit to window', { checked: z === 'fit' }),
                ...[0.5, 0.75, 1, 1.5, 2].map(v => item(`view.zoom.${v}`, `${Math.round(v * 100)}%`, { checked: z === v })),
            ] }),
            SEP,
            item('view.focus', 'Full-screen editing', { icon: 'fa-expand', checked: focusMode, kbd: focusMode ? 'Esc' : '' }),
            item('file.slideshow', 'Slideshow', { icon: 'fa-display', kbd: 'Ctrl+Enter' }),
        ];
        case 'insert': return [
            item('insert.text', 'Text box', { icon: 'fa-font', disabled: !ready }),
            item('insert.image', 'Image', { icon: 'fa-image', disabled: !ready, sub: [
                item('insert.image.upload', 'Upload from computer…', { icon: 'fa-upload' }),
                item('insert.image.stock', 'Free photo library…', { icon: 'fa-images' }),
                item('insert.image.url', 'By URL…', { icon: 'fa-link' }),
            ] }),
            item('insert.shape', 'Shape', { icon: 'fa-shapes', disabled: !ready, grid: SHAPE_KINDS.map(k => ({ cmd: `insert.shape.${k.kind}`, label: k.label, html: shapeIcon(k.kind) })) }),
            item('insert.line', 'Line', { icon: 'fa-arrow-right-long', disabled: !ready, sub: Object.entries(LINE_PRESETS).map(([k, p]) => item(`insert.line.${k}`, p.label, { html: lineIcon(k) })) }),
            item('insert.widget', 'Student activity', { icon: 'fa-bolt', disabled: !ready, sub: WIDGET_INSERT_ORDER.map(t => item(`insert.widget.${t}`, WIDGET_META[t].label, { icon: WIDGET_META[t].icon })) }),
            item('insert.video', 'Video…', { icon: 'fa-video', disabled: !ready }),
            item('insert.assignment', 'Assignment', { icon: 'fa-clipboard-check', disabled: !ready }),
            SEP,
            item('slide.new', 'New slide', { icon: 'fa-plus', kbd: 'Ctrl+M' }),
        ];
        case 'format': {
            // same Format menu as Documents (text-formats.js)
            const list = textFormatMenu({ item, SEP, st: text ? st : null, disabled: !text, fonts: FONT_FAMILIES, sizes: FONT_SIZES, lineHeights: LINE_HEIGHTS });
            return text ? list : [item('format.none', 'Select a text box to format its text', { disabled: true, hint: true }), SEP, ...list];
        }
        case 'slide': return [
            item('slide.new', 'New slide', { icon: 'fa-plus', kbd: 'Ctrl+M' }),
            item('slide.newLayout', 'New slide with layout', { icon: 'fa-table-cells-large', sub: Object.entries(SLIDE_LAYOUTS).map(([k, d]) => item(`slide.newLayout.${k}`, d.label, { icon: d.icon })) }),
            item('slide.board', 'New collaboration board', { icon: 'fa-people-group' }),
            item('slide.duplicate', 'Duplicate slide', { icon: 'fa-clone' }),
            item('slide.delete', 'Delete slide', { icon: 'fa-trash-can', disabled: (lessonDraft?.slides.length || 0) <= 1 }),
            SEP,
            item('slide.up', 'Move slide up', { icon: 'fa-arrow-up', disabled: currentSlideIndex <= 0 }),
            item('slide.down', 'Move slide down', { icon: 'fa-arrow-down', disabled: currentSlideIndex >= (lessonDraft?.slides.length || 1) - 1 }),
            SEP,
            item('slide.background', 'Change background…', { icon: 'fa-fill-drip', disabled: !isBlank || !ready }),
            item('slide.layout', (slide?.blocks || []).length ? 'Layout (adds a new slide)' : 'Apply layout', { icon: 'fa-table-cells-large', disabled: !isBlank, sub: Object.entries(SLIDE_LAYOUTS).map(([k, d]) => item(`slide.layout.${k}`, d.label, { icon: d.icon })) }),
            item('slide.theme', 'Change theme…', { icon: 'fa-palette' }),
            item('slide.transition', 'Transition', { icon: 'fa-wand-magic-sparkles', disabled: !isBlank, sub: [['none', 'None'], ['fade', 'Fade'], ['slide', 'Slide'], ['zoom', 'Zoom']].map(([v, l]) => item(`slide.transition.${v}`, l, { checked: slideTransition(slide) === v })) }),
        ];
        case 'arrange': {
            const grouped = objs.some(o => canvasStore.groupOf(o));
            const oneGroup = objs.length > 1 && objs.every(o => canvasStore.groupOf(o) && canvasStore.groupOf(o) === canvasStore.groupOf(objs[0]));
            const allLocked = objs.length && objs.every(o => o.locked);
            return [
                item('arrange.order', 'Order', { icon: 'fa-layer-group', disabled: !n, sub: [
                    item('arrange.order.front', 'Bring to front', { icon: 'fa-angles-up', kbd: '' }),
                    item('arrange.order.forward', 'Bring forward', { icon: 'fa-angle-up' }),
                    item('arrange.order.backward', 'Send backward', { icon: 'fa-angle-down' }),
                    item('arrange.order.back', 'Send to back', { icon: 'fa-angles-down' }),
                ] }),
                item('arrange.align', n === 1 ? 'Align on slide' : 'Align', { icon: 'fa-objects-align-left', disabled: !n, sub: [
                    item('arrange.align.left', 'Left', { icon: 'fa-objects-align-left' }),
                    item('arrange.align.center', 'Center', { icon: 'fa-objects-align-center' }),
                    item('arrange.align.right', 'Right', { icon: 'fa-objects-align-right' }),
                    SEP,
                    item('arrange.align.top', 'Top', { icon: 'fa-objects-align-top' }),
                    item('arrange.align.middle', 'Middle', { icon: 'fa-objects-align-middle' }),
                    item('arrange.align.bottom', 'Bottom', { icon: 'fa-objects-align-bottom' }),
                    ...(n >= 3 ? [SEP, item('arrange.distribute.h', 'Distribute horizontally', { icon: 'fa-arrows-left-right' }), item('arrange.distribute.v', 'Distribute vertically', { icon: 'fa-arrows-up-down' })] : []),
                ] }),
                SEP,
                item('arrange.group', 'Group', { icon: 'fa-object-group', kbd: 'Ctrl+G', disabled: n < 2 || oneGroup }),
                item('arrange.ungroup', 'Ungroup', { icon: 'fa-object-ungroup', kbd: 'Ctrl+Shift+G', disabled: !grouped }),
                SEP,
                item('arrange.lock', allLocked ? 'Unlock' : 'Lock in place', { icon: allLocked ? 'fa-lock-open' : 'fa-lock', disabled: !n }),
            ];
        }
        default: return [];
    }
}

function menuItemsHtml(items) {
    return items.map(it => {
        if (it.sep) return '<div class="mb-sep" role="separator"></div>';
        if (it.hint === true) return `<div class="mb-hint">${escHtml(it.label)}</div>`;
        const hasSub = !!(it.sub || it.grid);
        const ico = it.checked !== undefined && it.checked
            ? '<i class="mb-ico mb-check fa-solid fa-check"></i>'
            : it.html ? `<span class="mb-ico">${it.html}</span>` : `<i class="mb-ico fa-solid ${it.icon || ''}"></i>`;
        const right = hasSub ? '<i class="mb-arrow fa-solid fa-chevron-right"></i>'
            : it.kbd ? `<span class="mb-kbd">${escHtml(kbd(it.kbd))}</span>`
            : it.hint ? `<span class="mb-kbd">${escHtml(it.hint)}</span>` : '';
        const role = it.checked !== undefined ? 'menuitemcheckbox' : 'menuitem';
        return `<button type="button" class="mb-item" role="${role}" ${it.checked !== undefined ? `aria-checked="${!!it.checked}"` : ''}
            ${hasSub ? `data-sub="${escHtml(it.cmd)}" aria-haspopup="menu" aria-expanded="false"` : `data-cmd="${escHtml(it.cmd)}"`} ${it.disabled ? 'disabled' : ''}>
            ${ico}<span class="mb-label">${escHtml(it.label)}</span>${right}</button>`;
    }).join('');
}

function placePanel(panel, anchorRect, { side = 'below' } = {}) {
    const vw = window.innerWidth, vh = window.innerHeight;
    const b = panel.getBoundingClientRect();
    let left, top;
    if (side === 'right') {
        left = anchorRect.right - 2;
        if (left + b.width > vw - 6) left = Math.max(6, anchorRect.left - b.width + 2); // flip left
        top = Math.min(anchorRect.top - 6, vh - b.height - 6);
    } else {
        left = Math.min(anchorRect.left, vw - b.width - 6);
        top = anchorRect.bottom + 2;
    }
    panel.style.left = `${Math.max(6, Math.round(left))}px`;
    panel.style.top = `${Math.max(6, Math.round(top))}px`;
}

function openMenu(key, { focusFirst = false } = {}) {
    const bar = menuBarEl();
    if (!bar || !menuKeys().includes(key)) return;
    closeMenus({ keepFocus: true });
    formatToolbar?.closePopover();
    docFormatToolbar?.closePopover();
    closeAllInsertPopovers();
    const btn = bar.querySelector(`[data-menu="${key}"]`);
    const panel = document.createElement('div');
    panel.className = 'mb-panel';
    panel.setAttribute('role', 'menu');
    panel.setAttribute('aria-label', btn?.textContent.trim() || key);
    panel.innerHTML = menuItemsHtml(menuModel(key));
    bar.appendChild(panel);
    placePanel(panel, btn.getBoundingClientRect());
    btn.setAttribute('aria-expanded', 'true');
    menuState.open = key;
    menuState.panel = panel;
    if (focusFirst) focusMenuItem(panel, 0);
}

function openSubmenu(itemEl, { focusFirst = false } = {}) {
    const parentKey = itemEl.dataset.sub;
    if (menuState.sub === parentKey && menuState.subPanel) { if (focusFirst) focusMenuItem(menuState.subPanel, 0); return; }
    closeSubmenu();
    const model = menuModel(menuState.open).find(it => it.cmd === parentKey);
    if (!model) return;
    const panel = document.createElement('div');
    panel.className = 'mb-panel mb-sub';
    panel.setAttribute('role', 'menu');
    panel.setAttribute('aria-label', model.label);
    panel.innerHTML = model.grid
        ? `<div class="mb-grid">${model.grid.map(g => `<button type="button" class="mb-item" role="menuitem" data-cmd="${escHtml(g.cmd)}" title="${escHtml(g.label)}" aria-label="${escHtml(g.label)}">${g.html}</button>`).join('')}</div>`
        : menuItemsHtml(model.sub);
    menuBarEl().appendChild(panel);
    placePanel(panel, itemEl.getBoundingClientRect(), { side: 'right' });
    itemEl.classList.add('mb-open');
    itemEl.setAttribute('aria-expanded', 'true');
    menuState.sub = parentKey;
    menuState.subPanel = panel;
    if (focusFirst) focusMenuItem(panel, 0);
}

function closeSubmenu() {
    clearTimeout(menuState.subTimer);
    menuState.subPanel?.remove();
    menuState.subPanel = null;
    menuState.panel?.querySelectorAll('.mb-open').forEach(el => { el.classList.remove('mb-open'); el.setAttribute('aria-expanded', 'false'); });
    menuState.sub = null;
}

function closeMenus({ keepFocus = false } = {}) {
    if (!menuState.open) return;
    const bar = menuState.panel?.parentElement || menuBarEl();
    const btn = bar?.querySelector(`[data-menu="${menuState.open}"]`);
    closeSubmenu();
    menuState.panel?.remove();
    menuState.panel = null;
    [els.menuBar, els.docMenuBar].forEach(b => b?.querySelectorAll('[data-menu]').forEach(m => m.setAttribute('aria-expanded', 'false')));
    menuState.open = null;
    if (!keepFocus && btn && bar.contains(document.activeElement)) btn.focus();
}

const focusables = (panel) => [...panel.querySelectorAll('.mb-item:not(:disabled)')];
function focusMenuItem(panel, index) {
    const list = focusables(panel);
    if (!list.length) return;
    list[(index + list.length) % list.length].focus();
}

function wireMenuBar() {
    [els.menuBar, els.docMenuBar].forEach(bar => { if (bar) wireOneMenuBar(bar); });
    const signal = editorAbort?.signal;
    // Esc anywhere closes an open menu first (before text-edit / Focus Mode Esc)
    document.addEventListener('keydown', (e) => {
        if (e.key !== 'Escape' || !menuState.open || menuBarEl()?.contains(e.target)) return;
        e.preventDefault(); e.stopPropagation();
        closeMenus({ keepFocus: true });
    }, { capture: true, signal });
    // any click outside the menu bar closes the open menu
    document.addEventListener('click', (e) => {
        if (menuState.open && !menuBarEl()?.contains(e.target)) closeMenus({ keepFocus: true });
    }, { signal });
    window.addEventListener('resize', () => closeMenus({ keepFocus: true }), { signal });
    window.addEventListener('blur', () => closeMenus({ keepFocus: true }), { signal });
}

function wireOneMenuBar(bar) {
    // menus must not steal the inline editor's (or the document's) focus/selection
    bar.addEventListener('mousedown', (e) => { if ((editingNow() || isDocMode()) && e.target.closest('.mb-btn, .mb-item')) e.preventDefault(); });
    bar.addEventListener('click', (e) => {
        const top = e.target.closest('[data-menu]');
        if (top) {
            e.stopPropagation();
            if (menuState.open === top.dataset.menu) closeMenus({ keepFocus: true }); else openMenu(top.dataset.menu);
            return;
        }
        const sub = e.target.closest('[data-sub]');
        if (sub && !sub.disabled) { e.stopPropagation(); openSubmenu(sub); return; }
        const cmdEl = e.target.closest('[data-cmd]');
        if (cmdEl && !cmdEl.disabled) {
            e.stopPropagation();
            const cmd = cmdEl.dataset.cmd;
            closeMenus({ keepFocus: true });
            runCommand(cmd);
        }
    });
    bar.addEventListener('mouseover', (e) => {
        if (!menuState.open) return;
        const top = e.target.closest('[data-menu]');
        if (top && top.dataset.menu !== menuState.open) { openMenu(top.dataset.menu); return; }
        const it = e.target.closest('.mb-item');
        if (!it || !menuState.panel?.contains(it)) return;
        clearTimeout(menuState.subTimer);
        if (it.dataset.sub && !it.disabled) menuState.subTimer = setTimeout(() => openSubmenu(it), 120);
        else if (menuState.sub) menuState.subTimer = setTimeout(closeSubmenu, 220);
    });
    bar.addEventListener('keydown', (e) => {
        const k = e.key;
        const top = e.target.closest('[data-menu]');
        if (top) {
            const keys = menuKeys();
            const i = keys.indexOf(top.dataset.menu);
            if (k === 'ArrowDown' || k === 'Enter' || k === ' ') { e.preventDefault(); openMenu(top.dataset.menu, { focusFirst: true }); }
            else if (k === 'ArrowRight' || k === 'ArrowLeft') {
                e.preventDefault();
                const next = keys[(i + (k === 'ArrowRight' ? 1 : -1) + keys.length) % keys.length];
                bar.querySelector(`[data-menu="${next}"]`)?.focus();
                if (menuState.open) openMenu(next);
            } else if (k === 'Escape' && menuState.open) { e.preventDefault(); e.stopPropagation(); closeMenus(); }
            return;
        }
        const it = e.target.closest('.mb-item');
        if (!it) return;
        const panel = it.closest('.mb-panel');
        const list = focusables(panel);
        const idx = list.indexOf(it);
        const inSub = panel === menuState.subPanel;
        if (k === 'ArrowDown') { e.preventDefault(); focusMenuItem(panel, idx + 1); }
        else if (k === 'ArrowUp') { e.preventDefault(); focusMenuItem(panel, idx - 1); }
        else if (k === 'Home') { e.preventDefault(); focusMenuItem(panel, 0); }
        else if (k === 'End') { e.preventDefault(); focusMenuItem(panel, list.length - 1); }
        else if (k === 'ArrowRight' && it.dataset.sub) { e.preventDefault(); openSubmenu(it, { focusFirst: true }); }
        else if (k === 'ArrowLeft' && inSub) {
            e.preventDefault();
            const parent = menuState.panel?.querySelector(`[data-sub="${menuState.sub}"]`);
            closeSubmenu();
            parent?.focus();
        } else if (k === 'ArrowRight' || k === 'ArrowLeft') {
            e.preventDefault();
            const keys = menuKeys();
            const i = keys.indexOf(menuState.open);
            openMenu(keys[(i + (k === 'ArrowRight' ? 1 : -1) + keys.length) % keys.length], { focusFirst: true });
        } else if (k === 'Escape') {
            e.preventDefault(); e.stopPropagation();
            if (inSub) { const parent = menuState.panel?.querySelector(`[data-sub="${menuState.sub}"]`); closeSubmenu(); parent?.focus(); }
            else closeMenus();
        } else if (k === 'Tab') closeMenus({ keepFocus: true });
    });
}

// ── commands (menus, toolbar, shortcuts share these) ──────────────────────
async function menuClipboard(kind) {
    const ed = textTool?.getEditor();
    if (editingNow() && ed) {
        if (kind === 'paste') {
            try { const t = await navigator.clipboard.readText(); if (t) ed.chain().focus().insertContent(t).run(); }
            catch (e) { setSaveStatus('Use Ctrl+V to paste here', true); }
        } else {
            ed.commands.focus();
            try { document.execCommand(kind); } catch (e) { /* browser refused */ }
        }
        return;
    }
    if (!canvasReady()) return;
    if (kind === 'paste') {
        let objs = null;
        try { objs = parseCanvasClipboard(await navigator.clipboard.readText()); } catch (e) { /* no permission: use our copy */ }
        objs = objs || parseCanvasClipboard(canvasClipboard);
        if (objs) pasteCanvasObjects(objs);
        else setSaveStatus('Nothing to paste — copy an object first', true);
        return;
    }
    const objs = canvasStore.getSelectedObjects();
    if (!objs.length) return;
    canvasClipboard = JSON.stringify({ kind: CANVAS_CLIPBOARD_KIND, v: 3, objects: objs });
    navigator.clipboard?.writeText(canvasClipboard).catch(() => {});
    if (kind === 'cut') canvasStore.commands.removeObjects(canvasSlideId, objs.map(o => o.id), { label: 'Cut' });
}

function openLiveSession() {
    if (!currentPostContext || !currentLessonId || lessonDraft?.status !== 'published') return;
    const params = new URLSearchParams({
        lessonId: currentLessonId,
        classId: currentPostContext.classId,
        subjectId: currentPostContext.subjectId,
        subjectName: currentPostContext.subjectName || '',
    });
    window.open(new URL(`../../../teacher/lessons/live.html?${params.toString()}`, import.meta.url).href, '_blank');
}

function runCommand(cmd) {
    if (isDocMode()) return runDocCommand(cmd);
    const [group, action, arg] = cmd.split('.');
    const slideId = canvasSlideId;
    const ids = selectedIds();
    const ed = textTool?.getEditor();
    switch (group) {
        case 'file':
            if (action === 'save') return onSaveDraft();
            if (action === 'publish') return onPublishToggle();
            if (action === 'slideshow') return startSlideshow();
            if (action === 'slideshowStart') return startSlideshow({ fromStart: true });
            if (action === 'live') return openLiveSession();
            if (action === 'notes') return openNotesModal();
            if (action === 'exit') return exitEditor();
            return undefined;
        case 'edit':
            if (action === 'undo') return editingNow() && ed ? ed.chain().focus().undo().run() : canvasStore?.undo();
            if (action === 'redo') return editingNow() && ed ? ed.chain().focus().redo().run() : canvasStore?.redo();
            if (action === 'cut' || action === 'copy' || action === 'paste') return menuClipboard(action);
            if (!canvasReady()) return undefined;
            if (action === 'duplicate') return ids.length ? afterCopies(canvasStore.commands.duplicate(slideId, ids)) : undefined;
            if (action === 'delete') return ids.length ? canvasStore.commands.removeObjects(slideId, ids) : undefined;
            if (action === 'selectAll') {
                if (editingNow() && ed) return ed.chain().focus().selectAll().run();
                return canvasStore.setSelection((canvasStore.getSlide(slideId)?.objects || []).filter(o => !o.hidden).map(o => o.id));
            }
            return undefined;
        case 'view':
            if (action === 'focus') return setFocusMode(!focusMode);
            if (action === 'zoom' && canvasStore) { canvasStore.setZoom(arg === 'fit' ? 'fit' : Number(cmd.slice('view.zoom.'.length))); return applyCanvasZoom(); }
            return undefined;
        case 'insert':
            if (!canvasReady()) return undefined;
            if (action === 'text') return insertBlock('text');
            if (action === 'assignment') return insertBlock('assignment');
            if (action === 'shape') return insertShape(arg);
            if (action === 'line') return insertLine(arg);
            if (action === 'widget') return insertWidget(arg);
            if (action === 'video') { els.insertVideoBtn?.click(); return undefined; }
            if (action === 'image') {
                if (arg === 'upload') return els.insertImageFileInput?.click();
                if (arg === 'stock') return openStockModal();
                if (arg === 'url') { els.insertImageBtn?.click(); setTimeout(() => els.insertImageUrlInput?.focus(), 0); }
            }
            return undefined;
        case 'format': {
            const fc = textFormatCommand(cmd, FONT_FAMILIES);
            return fc && formatToolbar ? formatToolbar.runTextCommand(...fc) : undefined;
        }
        case 'slide':
            if (action === 'new') return addSlideFromLayout(DEFAULT_ADD_SLIDE_LAYOUT);
            if (action === 'newLayout') return addSlideFromLayout(arg);
            if (action === 'board') return addCollaborativeBoardSlide();
            if (action === 'duplicate') return duplicateSlide();
            if (action === 'delete') return deleteSlideAt(currentSlideIndex);
            if (action === 'up') return moveSlide(-1);
            if (action === 'down') return moveSlide(1);
            if (action === 'theme') return openThemeGallery();
            if (action === 'layout') return applyLayoutToCurrentSlide(arg);
            if (action === 'transition') return setSlideField('transition', arg === 'none' ? null : arg);
            if (action === 'background' && canvasReady()) {
                endTextEdit();
                canvasStore.setSelection([]);
                formatToolbar?.refresh();
                // open the Background colour popover in the toolbar's slide tools
                requestAnimationFrame(() => els.formatContext?.querySelector('[data-ft="slideBg"]')?.click());
            }
            return undefined;
        case 'arrange':
            if (!canvasReady() || !ids.length) return undefined;
            if (action === 'order') return canvasStore.commands.reorder(slideId, ids, arg);
            if (action === 'align') return canvasStore.commands.align(slideId, ids, arg);
            if (action === 'distribute') return canvasStore.commands.distribute(slideId, ids, arg);
            if (action === 'group') return canvasStore.commands.group(slideId, ids);
            if (action === 'ungroup') return canvasStore.commands.ungroup(slideId, ids);
            if (action === 'lock') return toggleLock(ids);
            return undefined;
        default:
            return undefined;
    }
}

function wireEditorEvents() {
    const onBack = () => { exitEditor(); };
    els.backToListBtn.addEventListener('click', onBack);
    els.docBackToListBtn.addEventListener('click', onBack);

    els.addCollabBoardBtn.addEventListener('click', () => addCollaborativeBoardSlide());

    els.slideThumbList.addEventListener('click', onSlideThumbClick);

    wireInsertToolbar();
    wireAddSlideLayoutMenu();
    wireThemeGallery();
    wireCanvasControls();
    wireMenuBar();
    wireDocToolbar();
    wireFocusMode(); // after wireCanvasControls: its Esc (finish text edit / deselect) runs first

    els.lessonTitleInput.addEventListener('input', () => {
        lessonDraft.title = els.lessonTitleInput.value;
        markDirty();
        embedded?.onTitleChange?.(lessonDraft.title);
        renderSlideThumbs(); // thumbnail list doesn't show title, but keep state consistent
    });

    els.saveBtn.addEventListener('click', onSaveDraft);
    els.publishBtn.addEventListener('click', onPublishToggle);
    els.slideshowBtn?.addEventListener('click', () => startSlideshow());

    els.notesBtn.addEventListener('click', openNotesModal);

    els.docLessonTitleInput.addEventListener('input', () => {
        lessonDraft.title = els.docLessonTitleInput.value;
        markDirty();
        embedded?.onTitleChange?.(lessonDraft.title);
    });

    els.docSaveBtn.addEventListener('click', onSaveDraft);
    els.docPublishBtn.addEventListener('click', onPublishToggle);
    els.docNotesBtn.addEventListener('click', openNotesModal);
    els.docSlideshowBtn?.addEventListener('click', () => startSlideshow());

    els.closeNotesBtn.addEventListener('click', closeNotesModal);
    els.cancelNotesBtn.addEventListener('click', closeNotesModal);
    els.saveNotesBtn.addEventListener('click', onSaveNotes);

    els.closeAssignmentPickerBtn.addEventListener('click', closeAssignmentPicker);
    els.assignmentPickerOverlay.addEventListener('click', (e) => {
        if (e.target === els.assignmentPickerOverlay) closeAssignmentPicker();
    });
    els.assignmentPickerList.addEventListener('click', onAssignmentPickerClick);

    els.closeAssignmentViewBtn?.addEventListener('click', closeAssignmentViewModal);
    els.assignmentViewOverlay?.addEventListener('click', (e) => {
        if (e.target === els.assignmentViewOverlay) closeAssignmentViewModal();
    });
    els.assignmentViewSaveBtn?.addEventListener('click', onSaveAssignmentViewEdits);

    window.addEventListener('beforeunload', onBeforeUnload, { signal: editorAbort.signal });
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
    const slideCount = Number.isInteger(lesson.slideCount) ? lesson.slideCount : (lesson.slides || []).length;
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
        openInContext(lessonId);
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
    // Nothing is written here: the subject page opens an in-memory draft
    // (lesson=new-slides|new-document) that is created on first save.
    openInContext(format === 'document' ? 'new-document' : 'new-slides');
}

// ── 7. OPEN / CLOSE BUILDER ──────────────────────────────────────────────
async function openBuilder(lessonId, draft = null) {
    try {
        const lesson = draft || await loadLesson(session.schoolId, currentPostContext, lessonId);
        isNewDraft = !!(draft && draft.isNew);
        if (!lesson) {
            console.warn('[Lesson Builder] lesson not found:', lessonId);
            if (STANDALONE) alert('This lesson could not be found. It may have just been deleted.');
            return;
        }
        lessonDraft = lesson;
        currentLessonId = lessonId;
        currentSlideIndex = 0;
        currentBlockId = null;
        hasUnsavedChanges = false;

        els.lessonPickerView?.classList.add('hidden');

        if (lessonDraft.format === 'document') {
            teardownCanvas();
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
            initCanvasStore();
            quizKeyCache.clear();
            renderAll();
            setTimeout(() => { migrateInlineImages().catch(e => console.warn('[Lesson Builder] image migration:', e)); }, 600);
        }
    } catch (e) {
        console.error('[Lesson Builder] openBuilder:', e);
        if (STANDALONE) alert('Failed to open this lesson. Please try again.');
    }
}

function closeBuilder() {
    setFocusMode(false);
    teardownCanvas();
    lessonDraft = null;
    currentLessonId = null;
    hasUnsavedChanges = false;

    els.builderView?.classList.add('hidden');
    els.builderView?.classList.remove('flex');
    els.docBuilderView?.classList.add('hidden');
    els.docBuilderView?.classList.remove('flex');
    els.lessonPickerView?.classList.remove('hidden');

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
        block.contentHtml = docEditor ? docEditor.getHTML() : (block.contentHtml || '');
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
        <div class="slide-thumb-preview rounded bg-white" style="border-top: 3px solid ${theme.accent};${slideBackground(slide) ? ` background:${slideBackground(slide)};` : ''}">
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
    // FREE-FORM CANVAS: absolutely positioned at the same x/y/w/h percentages
    // as the real canvas (see blockPositionStyle()), so the "live preview"
    // thumbnail actually reflects where things are, not just what's on the
    // slide — matters now that blocks can be placed/sized anywhere instead
    // of always flowing top-to-bottom.
    return `<div class="w-full h-full relative overflow-hidden">${blocks.map(renderThumbBlockHtml).join('')}</div>`;
}

function renderThumbBlockHtml(block) {
    const pos = `position:absolute; ${blockPositionStyle(block)} overflow:hidden;`;
    switch (block.type) {
        case 'image':
            return block.imageUrl
                ? `<div style="${pos}"><img src="${escHtml(block.imageUrl)}" alt="" class="w-full h-full rounded-sm object-cover" onerror="this.style.display='none'"></div>`
                : `<div style="${pos}" class="rounded-sm bg-slate-100 flex items-center justify-center"><i class="fa-solid fa-image text-[7px] text-slate-300"></i></div>`;
        case 'video':
            return `<div style="${pos}" class="rounded-sm bg-slate-100 flex items-center justify-center"><i class="fa-solid fa-circle-play text-[8px] text-slate-300"></i></div>`;
        case 'interactive_prompt':
            return `<div style="${pos}" class="flex items-center gap-0.5 rounded-sm bg-indigo-50 px-1"><i class="fa-solid fa-bolt text-[6px] text-indigo-400 flex-shrink-0"></i><span class="text-[5.5px] font-bold text-indigo-500 truncate">${escHtml(block.promptText || 'Interactive prompt')}</span></div>`;
        case 'assignment':
            return `<div style="${pos}" class="flex items-center gap-0.5 rounded-sm bg-amber-50 px-1"><i class="fa-solid fa-clipboard-check text-[6px] text-amber-500 flex-shrink-0"></i><span class="text-[5.5px] font-bold text-amber-600 truncate">${escHtml(block.prompt || 'Assignment')}</span></div>`;
        case 'poll':
        case 'quiz':
        case 'open_response':
        case 'board':
            return `<div style="${pos}">${widgetThumbHtml(block.type, block)}</div>`;
        case 'shape':
            return `<div style="position:absolute; ${blockPositionStyle(block)} overflow:visible;">${shapeMarkup(v2BlockToV3Object(block, 'a0'), { thumb: true })}</div>`;
        case 'line':
            return `<div style="position:absolute; ${blockPositionStyle(block)} overflow:visible;">${lineMarkup(v2BlockToV3Object(block, 'a0'), { thumb: true })}</div>`;
        case 'text':
        default:
            return block.html
                ? `<div style="${pos} padding:0; font-size:5px; line-height:1.25; color:#374f6b;" class="ql-editor slide-thumb-clip">${block.html}</div>`
                : '';
    }
}

function onSlideThumbClick(e) {
    const delBtn = e.target.closest('[data-action="delete-slide"]');
    if (delBtn) {
        e.stopPropagation();
        deleteSlideAt(Number(delBtn.dataset.slideIndex));
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
    if (!thumb || !(els.slideThumbList && els.slideThumbList.contains(thumb))) return;
    dragFromIndex = Number(thumb.dataset.slideIndex);
});
document.addEventListener('dragover', (e) => {
    const thumb = e.target.closest('[data-slide-index]');
    if (!thumb || !(els.slideThumbList && els.slideThumbList.contains(thumb)) || dragFromIndex === null) return;
    e.preventDefault();
});
document.addEventListener('drop', (e) => {
    const thumb = e.target.closest('[data-slide-index]');
    if (!thumb || !(els.slideThumbList && els.slideThumbList.contains(thumb)) || dragFromIndex === null) return;
    e.preventDefault();
    const toIndex = Number(thumb.dataset.slideIndex);
    if (toIndex === dragFromIndex) { dragFromIndex = null; return; }

    const [moved] = lessonDraft.slides.splice(dragFromIndex, 1);
    lessonDraft.slides.splice(toIndex, 0, moved);
    if (currentSlideIndex === dragFromIndex) currentSlideIndex = toIndex;
    dragFromIndex = null;
    markDirty();
    renderSlideThumbs();
});

// SLIDE DECK REDESIGN: "Add Slide" opens the SLIDE_LAYOUTS gallery (see
// renderSlideLayoutMenu()/wireAddSlideLayoutMenu() below) instead of always
// dropping in one empty blank slide; this is what actually builds whichever
// layout was picked (Blank included — it's just an empty blocks[] entry in
// SLIDE_LAYOUTS). "Add Collaboration Board" stays its own dedicated action
// since that slide type is special and whole-slide, never blocks-based (see
// newSlide()'s own comment in lessons.js for why).
function addSlideFromLayout(key) {
    const def = SLIDE_LAYOUTS[key] || SLIDE_LAYOUTS.blank;
    const slide = newSlide('blank');
    def.blocks.forEach(spec => {
        const block = newBlock(spec.type, spec.layout);
        if (spec.html !== undefined) block.html = spec.html;
        if (spec.role !== undefined) block.role = spec.role;
        if (spec.placeholder !== undefined) block.placeholder = spec.placeholder;
        slide.blocks.push(block);
    });
    lessonDraft.slides.splice(currentSlideIndex + 1, 0, slide);
    currentSlideIndex += 1;
    currentBlockId = null;
    markDirty();
    renderSlideThumbs();
    renderSlideCanvas();
    renderPropertiesPanel();
}

function renderSlideLayoutMenu() {
    els.addSlideLayoutMenu.innerHTML = Object.entries(SLIDE_LAYOUTS).map(([key, def]) => `
        <button type="button" data-layout-key="${key}" class="lb-layout-card" title="${escHtml(def.label)}">
            <i class="fa-solid ${def.icon}"></i>
            <span>${escHtml(def.label)}</span>
        </button>`).join('');
}

// Google Slides' own "+" always drops in a Title+Content slide with no
// dialog — this is that same default, used by the main "Add Slide" button.
// The gallery (via addSlideLayoutToggleBtn) stays available for anyone who
// wants a different starting arrangement instead.
const DEFAULT_ADD_SLIDE_LAYOUT = 'title_content';

function wireAddSlideLayoutMenu() {
    renderSlideLayoutMenu();
    els.addSlideBtn.addEventListener('click', (e) => {
        e.stopPropagation();
        closeAllInsertPopovers();
        addSlideFromLayout(DEFAULT_ADD_SLIDE_LAYOUT);
    });
    els.addSlideLayoutToggleBtn.addEventListener('click', (e) => {
        e.stopPropagation();
        const wasOpen = !els.addSlideLayoutMenu.classList.contains('hidden');
        closeAllInsertPopovers();
        els.addSlideLayoutMenu.classList.toggle('hidden', wasOpen);
    });
    els.addSlideLayoutMenu.addEventListener('click', (e) => {
        const btn = e.target.closest('[data-layout-key]');
        if (!btn) return;
        addSlideFromLayout(btn.dataset.layoutKey);
        closeAllInsertPopovers();
    });
}

function addCollaborativeBoardSlide() {
    // Phase 4 step 4: the board is a sticky-note WIDGET on an ordinary canvas
    // slide (movable, resizable, can share the slide with other content).
    // Older whole-slide 'collaborative_board' slides still open and present.
    const slide = newSlide('blank');
    const board = createWidget('board', [], { x: 80, y: 60, w: STAGE.w - 160, h: STAGE.h - 120 });
    slide.blocks = [v3ObjectToV2Block(board)];
    lessonDraft.slides.splice(currentSlideIndex + 1, 0, slide);
    currentSlideIndex += 1;
    currentBlockId = null;
    markDirty();
    renderSlideThumbs();
    renderSlideCanvas();
    renderPropertiesPanel();
}

// ── Slide operations (Slide menu, Format toolbar slide tools) ─────────────
function goToSlide(index) {
    if (!lessonDraft || index < 0 || index >= lessonDraft.slides.length) return;
    currentSlideIndex = index;
    currentBlockId = null;
    renderSlideThumbs();
    renderSlideCanvas();
    renderPropertiesPanel();
}

function deleteSlideAt(idx) {
    if (!lessonDraft || lessonDraft.slides.length <= 1 || idx < 0 || idx >= lessonDraft.slides.length) return;
    if (!confirm('Delete this slide?')) return;
    endTextEdit({ repaint: false });
    lessonDraft.slides.splice(idx, 1);
    if (currentSlideIndex >= lessonDraft.slides.length) currentSlideIndex = lessonDraft.slides.length - 1;
    else if (idx < currentSlideIndex) currentSlideIndex -= 1;
    currentBlockId = null;
    markDirty();
    renderSlideThumbs();
    renderSlideCanvas();
    renderPropertiesPanel();
}

function moveSlide(delta) {
    const from = currentSlideIndex, to = from + delta;
    if (!lessonDraft || to < 0 || to >= lessonDraft.slides.length) return;
    const [moved] = lessonDraft.slides.splice(from, 1);
    lessonDraft.slides.splice(to, 0, moved);
    currentSlideIndex = to;
    markDirty();
    renderSlideThumbs();
    syncCanvasSlideList();
}

// Deep copy after the current slide: fresh slide/object ids, grouped objects
// get fresh group ids, quiz questions keep their answer key.
function duplicateSlide() {
    const src = currentSlide();
    if (!src) return;
    textTool?.flush();
    const copy = JSON.parse(JSON.stringify(src));
    copy.id = newSlideId();
    const quizPairs = [];
    if (Array.isArray(copy.blocks)) {
        const groups = new Map();
        copy.blocks = copy.blocks.map(b => {
            const id = newObjectId();
            if (b.type === 'quiz') quizPairs.push([b.id, id]);
            const out = { ...b, id };
            if (typeof b.groupId === 'string' && b.groupId) {
                if (!groups.has(b.groupId)) groups.set(b.groupId, `grp_${Date.now().toString(36)}_${groups.size}`);
                out.groupId = groups.get(b.groupId);
            }
            return out;
        });
    }
    lessonDraft.slides.splice(currentSlideIndex + 1, 0, copy);
    currentSlideIndex += 1;
    currentBlockId = null;
    markDirty();
    renderSlideThumbs();
    renderSlideCanvas();
    renderPropertiesPanel();
    quizPairs.forEach(([from, to]) => copyQuizKey(from, to));
}

// Slide-level fields (not objects): background colour, transition. Stored on
// the v2 slide; mirrored into the store slide's `extra` (what the renderer and
// the write-back read) so the canvas repaints at once.
function setSlideField(field, value) {
    const slide = currentSlide();
    if (!slide || slide.type !== 'blank') return;
    if (value === null || value === undefined || value === '') delete slide[field];
    else slide[field] = value;
    const st = canvasStore?.getSlide(slide.id);
    if (st) {
        st.extra = { ...(st.extra || {}) };
        if (slide[field] === undefined) delete st.extra[field];
        else st.extra[field] = slide[field];
    }
    markDirty();
    paintCanvasStage();
    renderSlideThumbs();
    formatToolbar?.sync();
}

// Layout: an empty slide takes the layout's placeholders; a slide with
// content gets a NEW slide with that layout after it (nothing is replaced).
function applyLayoutToCurrentSlide(key) {
    const slide = currentSlide();
    const def = SLIDE_LAYOUTS[key];
    if (!slide || slide.type !== 'blank' || !def) return;
    if ((slide.blocks || []).length) { addSlideFromLayout(key); return; }
    endTextEdit({ repaint: false });
    def.blocks.forEach(spec => {
        const block = newBlock(spec.type, spec.layout);
        if (spec.role !== undefined) block.role = spec.role;
        if (spec.placeholder !== undefined) block.placeholder = spec.placeholder;
        slide.blocks.push(block);
    });
    currentBlockId = null;
    markDirty();
    renderSlideThumbs();
    renderSlideCanvas();
    renderPropertiesPanel();
}

// ── Slideshow (local, in-memory — no live session) ──────────────────────
// Presents the editor's own state: the canvas store's slides (unsaved edits
// included), legacy board slides from the draft. See ../slideshow.js.
function presentObjectContent(obj) {
    const b = v3ObjectToV2Block(obj);
    switch (b.type) {
        case 'text':
            return `<div class="cv-ed-wrap ql-snow" data-role="${escHtml(b.role || '')}"><div class="ql-editor">${isBlankHtml(b.html) ? '' : b.html}</div></div>`;
        case 'interactive_prompt': {
            const mc = b.promptKind === 'multiple_choice';
            return `<div class="cv-ed-card">
                <span class="inline-flex items-center gap-1.5 text-[10.5px] font-black uppercase tracking-wide px-2.5 py-1 rounded-full bg-[#eef2ff] text-[#4338ca] border border-[#c7d2fe]"><i class="fa-solid fa-bolt"></i> Live prompt</span>
                <p class="cv-ed-prompt">${escHtml(b.promptText || '')}</p>
                ${mc ? (b.choices || []).filter(Boolean).map(c => `<div class="cv-ed-choice"><i class="fa-regular fa-circle"></i>${escHtml(c)}</div>`).join('') : ''}
            </div>`;
        }
        case 'assignment': {
            const a = (currentSubject?.assignments || []).find(x => x.id === b.linkedAssignmentId);
            return `<div class="cv-ed-card">
                <span class="inline-flex items-center gap-1.5 text-[10.5px] font-black uppercase tracking-wide px-2.5 py-1 rounded-full bg-[#eef4ff] text-[#2563eb] border border-[#c7d9fd]"><i class="fa-solid fa-clipboard-check"></i> Assignment</span>
                <p class="cv-ed-prompt">${escHtml(b.prompt || '')}</p>
                ${a ? `<p class="cv-ed-muted"><i class="fa-solid fa-link mr-1"></i>${escHtml(a.title)}</p>` : ''}
            </div>`;
        }
        default:
            return undefined; // shapes, lines, images, widgets, video: the renderer's own
    }
}

function startSlideshow({ fromStart = false } = {}) {
    if (lessonDraft?.format === 'document') return startDocumentPresent({ fromStart });
    if (!lessonDraft || !lessonDraft.slides.length) return;
    textTool?.flush();           // in-progress typing → store
    closeMenus();
    closeAllInsertPopovers();
    formatToolbar?.closePopover();
    const slides = lessonDraft.slides.map(s => {
        const live = s.type === 'blank' && canvasStore ? canvasStore.getSlide(s.id) : null;
        return live || v2SlideToV3(s);
    });
    openSlideshow({
        slides,
        theme: lessonDraft.theme || 'general',
        startIndex: fromStart ? 0 : currentSlideIndex,
        title: lessonDraft.title || '',
        renderContent: presentObjectContent,
        onClose: (i) => { if (lessonDraft && i !== currentSlideIndex) goToSlide(i); },
    });
}

// Document Present Mode (doc-present.js): full-screen, read-only US Letter
// page of the editor's CURRENT content (unsaved edits included), opened at the
// block the teacher is looking at (or the top, "from the beginning").
function startDocumentPresent({ fromStart = false } = {}) {
    if (!docEditor) return;
    closeMenus();
    closeAllInsertPopovers();
    docFormatToolbar?.closePopover();
    let startBlock = 0;
    if (!fromStart && els.docWorkspace) {
        const top = els.docWorkspace.getBoundingClientRect().top + 8;
        const blocks = [...docEditor.editor.view.dom.children];
        startBlock = Math.max(0, blocks.findIndex(b => b.getBoundingClientRect().bottom > top));
    }
    openDocumentPresentation({ html: docEditor.getHTML(), title: lessonDraft.title || '', startBlock });
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
    let slide = currentSlide();
    if (!slide) {
        destroyCanvasStage();
        setCanvasHostMode(false);
        els.slideCanvas.innerHTML = '';
        els.slideInsertToolbar.classList.add('hidden');
        return;
    }

    // Safety net: a slide that hasn't gone through migrateLegacySlide() yet
    // (in-memory imports still emit the old fixed-type shape) is converted in
    // place here. Every *loaded* lesson is already migrated by loadLesson().
    if (slide.type !== 'blank' && slide.type !== 'collaborative_board') {
        slide = migrateLegacySlide(slide);
        lessonDraft.slides[currentSlideIndex] = slide;
    }

    applyThemeToStage();

    if (slide.type === 'collaborative_board') {
        destroyCanvasStage();
        setCanvasHostMode(false);
        els.slideInsertToolbar.classList.add('hidden');
        els.slideInsertToolbar.classList.remove('flex');
        els.slideCanvas.innerHTML = renderCollaborativeBoardCanvas(slide);
        wireCollaborativeBoardInputs(slide);
        return;
    }

    els.slideInsertToolbar.classList.remove('hidden');
    els.slideInsertToolbar.classList.add('flex');

    // 'blank' slide → the canvas engine (section 9b).
    if (!canvasStore) initCanvasStore();
    syncCanvasSlideList();
    syncStoreFromDraft(slide);
    const switching = canvasSlideId !== slide.id;
    if (switching) endTextEdit({ repaint: false });
    if (!canvasStage) { setCanvasHostMode(true); ensureCanvasStage(); }
    canvasStore.setActiveSlide(slide.id);
    canvasSlideId = slide.id;
    const sel = canvasStore.getState().selection;
    if (currentBlockId && !sel.includes(currentBlockId)) canvasStore.setSelection([currentBlockId]);
    else if (!currentBlockId && switching && sel.length) canvasStore.setSelection([]);
    paintCanvasStage();
    updateHistoryButtons();
}

// Applies the current lesson theme's accent color to the stage as a CSS
// custom property — read by .lb-slide-stage's border-top (see
// builder.html) and, in future, the sidebar thumbnails (Task #9). Purely
// cosmetic; see THEMES/currentTheme() near the top of this file.
function applyThemeToStage() {
    els.slideCanvas.style.setProperty('--lb-accent', currentTheme().accent);
    canvasStage?.setTheme(lessonDraft?.theme || 'general');
    updateThemeBtnDot();
}

// Whether a video/image block's URL field currently fails validation —
// keyed by BLOCK id (was slide id before this redesign, back when a slide
// itself was the media item), for the same reason as before: this is pure
// transient UI state (never saved), and renderSlideCanvas() rebuilds the
// canvas's innerHTML wholesale on every insert/delete/reorder, so a handler
// that reached into the old DOM and toggled a hidden class directly would
// lose that change the instant the next render rebuilt the element fresh.
const blockUrlInvalid = new Map();

// Percent geometry of a v2 block — used by the sidebar thumbnails.
function blockPositionStyle(block) {
    return `left:${block.x}%; top:${block.y}%; width:${block.w}%; height:${block.h}%;`;
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
            markDirty();
            renderSlideThumbs();
        });
    });
}

// ── 9b. CANVAS EDITOR ENGINE (Phase 4 step 2) ─────────────────────────────
// A 'blank' slide is edited on the shared 1600×900 renderer stage
// (canvas/renderer.js) with Moveable + Selecto (canvas/transform.js). The
// source of truth while a slide is on screen is the canvas store
// (canvas/store.js): every gesture, keyboard shortcut, paste and inline text
// edit is ONE undoable command there.
//
// Bridge to the v2 lessonDraft (which save/thumbnails/lessons.js still use):
//   store → draft: 'content' events from commands/undo/redo rewrite that
//                  slide's v2 blocks (v3SlideToV2) and markDirty() → autosave.
//   draft → store: legacy mutations (properties panel, layouts, slide ops)
//                  edit the v2 slide and call markDirty()/renderSlideCanvas(),
//                  which push a snapshot into the store via
//                  replaceSlideObjects() — recorded as an undoable step with
//                  origin 'external', never written back (no loop).
// draftPrints holds the last v2 fingerprint the two sides agreed on, so a
// render that changed nothing is free and never adds an undo step.
const NUDGE = 4;                         // stage units per arrow press (Shift = ×10)
const CANVAS_CLIPBOARD_KIND = 'connectus/canvas-objects';
const canvasHistoryOverlays = ['themeOverlay', 'notesOverlay', 'assignmentPickerOverlay', 'assignmentViewOverlay'];

function isBlankHtml(html) {
    if (!html) return true;
    if (/<(img|iframe|video|span class="assignment-embed")/i.test(html)) return false;
    return !html.replace(/<[^>]*>/g, '').replace(/&nbsp;/g, ' ').trim();
}

// Give every block of a v2 slide a z key (blocks inserted by layouts / older
// code have none): missing keys go on top in array order, which is exactly
// how such blocks used to paint.
function ensureBlockZ(slide) {
    if (!slide || slide.type !== 'blank' || !Array.isArray(slide.blocks)) return;
    const zs = slide.blocks.map(b => b.z).filter(z => typeof z === 'string' && z).sort();
    let top = zs.length ? zs[zs.length - 1] : null;
    slide.blocks.forEach(b => {
        if (typeof b.z !== 'string' || !b.z) { b.z = generateKeyBetween(top, null); top = b.z; }
    });
}

function initCanvasStore() {
    teardownCanvas();
    lessonDraft.slides.forEach(ensureBlockZ);
    canvasStore = createCanvasStore({ lesson: lessonDraft, slides: lessonDraft.slides.map(v2SlideToV3) });
    draftPrints.clear();
    lessonDraft.slides.forEach(s => draftPrints.set(s.id, stableStringify(s)));
    canvasUnsub = canvasStore.subscribe(onCanvasEvent);
    // after the builder's own listener, so currentBlockId / write-back are current
    formatToolbar = createFormatToolbar({
        el: els.formatContext,
        popoverRoot: els.lessonEditorRoot || document.body,
        store: canvasStore,
        getTextTool: () => textTool,
        host: formatHost,
    });
    updateHistoryButtons();
}

function teardownCanvas() {
    if (formatToolbar) { formatToolbar.destroy(); formatToolbar = null; }
    destroyCanvasStage();
    if (canvasUnsub) { canvasUnsub(); canvasUnsub = null; }
    if (canvasStore) { canvasStore.destroy(); canvasStore = null; }
    draftPrints.clear();
}

function destroyCanvasStage() {
    endTextEdit({ repaint: false });
    textTool = null;
    editingTextId = null;
    if (zoomObserver) { zoomObserver.disconnect(); zoomObserver = null; }
    if (canvasEngine) { canvasEngine.destroy(); canvasEngine = null; }
    if (canvasStage) { canvasStage.destroy(); canvasStage = null; }
    canvasSlideId = null;
}

// Board slides keep the legacy padded card; canvas slides get the bare host.
function setCanvasHostMode(isCanvas) {
    els.slideCanvas.className = isCanvas ? 'lb-cv-host' : 'lb-slide-stage bg-white rounded-xl shadow-sm border border-[#dce3ed]';
    els.slideCanvasWrap.className = isCanvas ? 'lb-cv-wrap' : 'lb-stage-wrap mx-auto';
}

function syncCanvasSlideList() {
    if (!canvasStore) return;
    canvasStore.syncSlides(lessonDraft.slides.map(s => canvasStore.getSlide(s.id) || v2SlideToV3(s)));
}

// Coalesce a run of keystrokes in one panel field into one undo step.
function externalCoalesceKey(slideId) {
    const a = document.activeElement;
    if (a && els.formatContext?.contains(a) && ['INPUT', 'TEXTAREA', 'SELECT'].includes(a.tagName)) {
        return `panel:${slideId}:${currentBlockId}:${a.id || a.dataset.promptField || a.dataset.choiceIndex || a.name || a.tagName}`;
    }
    return null;
}

// draft → store (see the section comment). Objects whose v2 projection is
// unchanged keep their exact store values, so % rounding never drifts them.
function syncStoreFromDraft(slide) {
    if (!canvasStore || !slide || !slide.id || slide.type !== 'blank') return false;
    ensureBlockZ(slide);
    const print = stableStringify(slide);
    if (draftPrints.get(slide.id) === print) return false;
    draftPrints.set(slide.id, print);
    const next = v2SlideToV3(slide);
    const cur = canvasStore.getSlide(slide.id);
    if (cur) {
        const prev = new Map((cur.objects || []).map(o => [o.id, o]));
        next.objects = next.objects.map(o => {
            const p = prev.get(o.id);
            return p && stableStringify(v3ObjectToV2Block(p)) === stableStringify(v3ObjectToV2Block(o)) ? p : o;
        });
    }
    return canvasStore.replaceSlideObjects(next, { label: 'Edit', coalesceKey: externalCoalesceKey(slide.id) });
}

// store → draft
function writeBackSlide(slideId) {
    const s = canvasStore?.getSlide(slideId);
    if (!s || s.kind !== 'canvas') return;
    const i = lessonDraft.slides.findIndex(x => x.id === slideId);
    if (i < 0) return;
    lessonDraft.slides[i] = { ...lessonDraft.slides[i], ...v3SlideToV2(s) };
    draftPrints.set(slideId, stableStringify(lessonDraft.slides[i]));
}

function onCanvasEvent(evt) {
    if (!lessonDraft || !canvasStore) return;
    if (evt.type === 'content') {
        if (evt.origin !== 'external') {
            canvasWritingBack = true;
            try {
                evt.slideIds.forEach(writeBackSlide);
                markDirty();
            } finally { canvasWritingBack = false; }
            renderSlideThumbs();
            // the Format toolbar re-syncs itself from this same event (canvas/toolbar.js)
        }
        if (evt.slideIds.includes(canvasSlideId)) paintCanvasStage();
    } else if (evt.type === 'selection') {
        const sel = canvasStore.getState().selection;
        if (editingTextId && !(sel.length === 1 && sel[0] === editingTextId)) endTextEdit();
        currentBlockId = sel.length === 1 ? sel[0] : null;
        canvasEngine?.sync();
    } else if (evt.type === 'activeSlide') {
        // undo/redo can jump to the slide its step belongs to
        const idx = lessonDraft.slides.findIndex(s => s.id === canvasStore.getState().activeSlideId);
        if (idx >= 0 && idx !== currentSlideIndex) {
            currentSlideIndex = idx;
            currentBlockId = null;
            renderSlideThumbs();
            renderSlideCanvas();
            renderPropertiesPanel();
        }
    } else if (evt.type === 'history') {
        updateHistoryButtons();
    } else if (evt.type === 'zoom') {
        applyCanvasZoom();
    }
}

function updateHistoryButtons() {
    if (!els.canvasUndoBtn) return;
    els.canvasUndoBtn.disabled = !canvasStore?.canUndo();
    els.canvasRedoBtn.disabled = !canvasStore?.canRedo();
    els.canvasUndoBtn.classList.toggle('opacity-40', els.canvasUndoBtn.disabled);
    els.canvasRedoBtn.classList.toggle('opacity-40', els.canvasRedoBtn.disabled);
}

function ensureCanvasStage() {
    if (canvasStage) return;
    canvasStage = mountStage(els.slideCanvas, { theme: lessonDraft.theme || 'general', className: 'lb-cv-viewport' });
    canvasEngine = createTransformEngine({
        handle: canvasStage,
        store: canvasStore,
        controlsContainer: els.slideCanvasWrap,
        selectArea: els.slideCanvasArea,
        onEditText: (id, e) => beginTextEdit(id, { x: e?.clientX, y: e?.clientY }),
    });
    textTool = createTextTool({
        handle: canvasStage,
        store: canvasStore,
        engine: canvasEngine,
        onDirty: markTypingDirty,
        onChange: (id) => {
            const was = editingTextId;
            editingTextId = id;
            if (was && !id) paintCanvasStage(); // back to the static render
            formatToolbar?.refresh();
        },
        onEditorChange: () => formatToolbar?.sync(),  // caret moved / marks toggled → toolbar state
        isUiTarget: isEditorUiTarget,                  // toolbar / menu / popover presses keep the edit open
    });
    loadTextLibs().catch(() => {}); // warm the editor bundle so the first double-click is instant
    // .editor-workspace resize (window, Focus Mode, rail collapse) → recompute
    // the stage's transform: scale(k) so the 1600×900 slide fills the new bounds.
    zoomObserver = new ResizeObserver(() => { if (canvasStore?.getState().zoom === 'fit') applyCanvasZoom(); });
    zoomObserver.observe(els.slideCanvasArea);
    applyCanvasZoom();
}

function isEditorUiTarget(el) {
    return !!(el && el.closest && el.closest('.format-toolbar, .menu-bar, .ft-pop, .mb-panel'));
}

// 'Fit' = the whole slide visible inside the pane; fixed levels scroll.
function applyCanvasZoom() {
    if (!canvasStage || !canvasStore) return;
    const z = canvasStore.getState().zoom;
    let k = z;
    if (z === 'fit') {
        const area = els.slideCanvasArea, cs = getComputedStyle(area);
        const aw = area.clientWidth - parseFloat(cs.paddingLeft) - parseFloat(cs.paddingRight);
        const ah = area.clientHeight - parseFloat(cs.paddingTop) - parseFloat(cs.paddingBottom);
        k = Math.max(0.1, Math.floor(Math.min(aw / STAGE.w, ah / STAGE.h) * 1000) / 1000);
    }
    canvasStage.setZoom(k);
    els.canvasZoomLabel.textContent = z === 'fit' ? 'Fit' : `${Math.round(k * 100)}%`;
    els.canvasZoomBtn.title = `Zoom: ${Math.round(k * 100)}%`;
    els.canvasZoomGroup.querySelectorAll('[data-zoom]').forEach(b => b.classList.toggle('lb-zoom-active', b.dataset.zoom === String(z)));
    canvasEngine?.updateRect();
}

function renderEditorObjectContent(obj) {
    const b = v3ObjectToV2Block(obj);
    switch (b.type) {
        case 'text': {
            const blank = isBlankHtml(b.html);
            return `<div class="cv-ed-wrap ql-snow" data-role="${escHtml(b.role || '')}"><div class="ql-editor${blank ? ' ql-blank' : ''}" data-placeholder="${escHtml(b.placeholder || 'Double-click to add text')}">${blank ? '' : b.html}</div></div>`;
        }
        case 'video':
            return `<div class="cv-ed-wrap"><div class="cv-ed-media">${b.embedUrl
                ? `<iframe src="${escHtml(b.embedUrl)}" tabindex="-1" loading="lazy" allowfullscreen></iframe>`
                : `<div class="cv-ed-placeholder"><div><i class="fa-solid fa-video text-2xl mb-1.5 block"></i>No video yet — add a link in the formatting toolbar</div></div>`}
                ${b.caption ? `<p class="cv-ed-caption">${escHtml(b.caption)}</p>` : ''}</div></div>`;
        case 'interactive_prompt': {
            const mc = b.promptKind === 'multiple_choice';
            const choices = mc ? (b.choices || []).map((c, i) => `<div class="cv-ed-choice"><i class="fa-regular fa-circle"></i>${escHtml(c) || `<span class="cv-ed-muted">Choice ${i + 1}</span>`}</div>`).join('') : '';
            return `<div class="cv-ed-card">
                <span class="inline-flex items-center gap-1.5 text-[10.5px] font-black uppercase tracking-wide px-2.5 py-1 rounded-full bg-[#eef2ff] text-[#4338ca] border border-[#c7d2fe]"><i class="fa-solid fa-bolt"></i> Interactive Prompt · ${mc ? 'Multiple Choice' : 'Short Answer'}</span>
                <p class="cv-ed-prompt">${escHtml(b.promptText) || '<span class="cv-ed-muted">No question yet — write it in the formatting toolbar</span>'}</p>
                ${choices}
                ${mc ? '' : '<div class="cv-ed-choice"><i class="fa-solid fa-keyboard"></i><span class="cv-ed-muted">Students type their answer here</span></div>'}
            </div>`;
        }
        case 'assignment': {
            const a = (currentSubject?.assignments || []).find(x => x.id === b.linkedAssignmentId);
            return `<div class="cv-ed-card">
                <span class="inline-flex items-center gap-1.5 text-[10.5px] font-black uppercase tracking-wide px-2.5 py-1 rounded-full bg-[#eef4ff] text-[#2563eb] border border-[#c7d9fd]"><i class="fa-solid fa-clipboard-check"></i> Assignment</span>
                <p class="cv-ed-prompt">${escHtml(b.prompt) || '<span class="cv-ed-muted">No question yet — write it in the formatting toolbar</span>'}</p>
                <p class="cv-ed-muted"><i class="fa-solid fa-link mr-1"></i>${a ? escHtml(a.title) : 'No assignment linked yet'}</p>
            </div>`;
        }
        default:
            return undefined; // renderer's built-in content (shapes, lines…)
    }
}

function paintCanvasStage() {
    if (!canvasStage || !canvasSlideId || !canvasStore) return;
    const slide = canvasStore.getSlide(canvasSlideId);
    if (!slide) return;
    renderSlide(canvasStage, slide, {
        mode: 'editor',
        renderContent: renderEditorObjectContent,
        emptyText: 'This slide is empty — use the toolbar above to add text, an image, a video, or interactive content.',
        skipIds: editingTextId ? new Set([editingTextId]) : null,
    });
    canvasEngine?.sync();
}

// ── inline text editing (double-click / Enter / new Text box) ────────────
// Delegated to canvas/tools/text.js (Tiptap 2; formatting via the Format toolbar). The tool
// commits ONE undoable { html, h } command when the edit ends.
function beginTextEdit(id, { x, y } = {}) {
    if (!textTool) return;
    textTool.begin(id, { x, y }).catch(e => console.error('[Lesson Builder] text edit failed:', e));
}

function endTextEdit({ repaint = true, commit = true } = {}) {
    if (!textTool || !textTool.isEditing()) return;
    textTool.end({ commit });
    if (repaint) paintCanvasStage();
}

// Typing marks the lesson dirty (autosave flushes the editor first — see persistDraft()).
function markTypingDirty() {
    hasUnsavedChanges = true;
    dirtyVersion++;
    scheduleAutosave();
}

// ── keyboard + clipboard ─────────────────────────────────────────────────
function canvasIsLive() {
    return !!(lessonDraft && lessonDraft.format !== 'document' && canvasStore && canvasStage && canvasSlideId
        && els.builderView && !els.builderView.classList.contains('hidden'));
}

function canvasOverlayOpen() {
    return canvasHistoryOverlays.some(id => els[id] && !els[id].classList.contains('hidden'));
}

function focusIsTyping() {
    const a = document.activeElement;
    return !!(a && (a.isContentEditable || ['INPUT', 'TEXTAREA', 'SELECT'].includes(a.tagName)));
}

function onCanvasKeydown(e) {
    if (!canvasIsLive() || canvasOverlayOpen()) return;
    const key = e.key;
    const mod = e.ctrlKey || e.metaKey;
    const sel = canvasStore.getState().selection;
    const lk = key.length === 1 ? key.toLowerCase() : key;
    // editor-wide shortcuts (work while typing too)
    if (mod && !e.altKey && lk === 's') { e.preventDefault(); onSaveDraft(); return; }
    if (mod && !e.altKey && key === 'Enter') { e.preventDefault(); startSlideshow({ fromStart: e.shiftKey }); return; }
    if (key === 'Escape') {
        if (editingTextId) { e.preventDefault(); const id = editingTextId; endTextEdit(); canvasStore.setSelection([id]); }
        else if (!focusIsTyping() && sel.length) canvasStore.setSelection([]);
        return;
    }
    if (focusIsTyping()) return; // text fields / the inline editor keep their own keys (incl. Quill undo)
    const slideId = canvasSlideId;
    const k = key.length === 1 ? key.toLowerCase() : key;
    if (mod && k === 'z' && !e.shiftKey) { e.preventDefault(); canvasStore.undo(); return; }
    if (mod && (k === 'y' || (k === 'z' && e.shiftKey))) { e.preventDefault(); canvasStore.redo(); return; }
    if (mod && k === 'd') { e.preventDefault(); if (sel.length) afterCopies(canvasStore.commands.duplicate(slideId, sel)); return; }
    if (mod && k === 'g') { e.preventDefault(); if (e.shiftKey) canvasStore.commands.ungroup(slideId, sel); else canvasStore.commands.group(slideId, sel); return; }
    if (mod && k === 'm') { e.preventDefault(); addSlideFromLayout(DEFAULT_ADD_SLIDE_LAYOUT); return; }
    // Ctrl+B / I / U on a selected (not editing) text box formats the whole box
    if (mod && !e.shiftKey && (k === 'b' || k === 'i' || k === 'u') && formatToolbar?.hasTextSelection()) {
        e.preventDefault();
        formatToolbar.runTextCommand(k === 'b' ? 'bold' : k === 'i' ? 'italic' : 'underline');
        return;
    }
    if (mod && k === 'a') { e.preventDefault(); canvasStore.setSelection((canvasStore.getSlide(slideId)?.objects || []).filter(o => !o.hidden).map(o => o.id)); return; }
    if (key === 'Delete' || key === 'Backspace') {
        if (!sel.length) return;
        e.preventDefault();
        canvasStore.commands.removeObjects(slideId, sel);
        return;
    }
    const arrows = { ArrowLeft: [-1, 0], ArrowRight: [1, 0], ArrowUp: [0, -1], ArrowDown: [0, 1] };
    if (arrows[key] && !mod) {
        if (!sel.length) return;
        e.preventDefault();
        const step = e.shiftKey ? NUDGE * 10 : NUDGE;
        canvasStore.commands.nudge(slideId, sel, arrows[key][0] * step, arrows[key][1] * step);
        return;
    }
    if (key === 'Enter' && sel.length === 1 && canvasStore.getObject(sel[0])?.type === 'text') {
        e.preventDefault();
        beginTextEdit(sel[0]);
    }
}

// Copy/cut put a JSON payload on the system clipboard (so it also works
// between tabs) and in canvasClipboard (module-level: survives switching
// lessons in this page). Paste prefers what the system clipboard holds: an
// image becomes an Image box, our payload becomes copies, anything else is
// ignored (Quill handles text pastes while editing).
function onCanvasCopy(e, cut = false) {
    if (!canvasIsLive() || canvasOverlayOpen() || focusIsTyping()) return;
    const objs = canvasStore.getSelectedObjects();
    if (!objs.length) return;
    const payload = JSON.stringify({ kind: CANVAS_CLIPBOARD_KIND, v: 3, objects: objs });
    canvasClipboard = payload;
    if (e.clipboardData) { e.clipboardData.setData('text/plain', payload); e.preventDefault(); }
    if (cut) canvasStore.commands.removeObjects(canvasSlideId, objs.map(o => o.id), { label: 'Cut' });
}

function parseCanvasClipboard(text) {
    if (!text || text.charAt(0) !== '{' || !text.includes(CANVAS_CLIPBOARD_KIND)) return null;
    try {
        const p = JSON.parse(text);
        return p && p.kind === CANVAS_CLIPBOARD_KIND && Array.isArray(p.objects) && p.objects.length ? p.objects : null;
    } catch (e) { return null; }
}

async function onCanvasPaste(e) {
    if (!canvasIsLive() || canvasOverlayOpen()) return;
    const items = [...(e.clipboardData?.items || [])];
    const imageItem = items.find(it => it.type && it.type.startsWith('image/'));
    const editingHere = editingTextId && els.slideCanvas.contains(document.activeElement);
    if (imageItem && (!focusIsTyping() || editingHere)) {
        e.preventDefault();
        const file = imageItem.getAsFile();
        if (file) { endTextEdit(); await insertImageFromFile(file); }
        return;
    }
    if (focusIsTyping()) return;
    const objs = parseCanvasClipboard(e.clipboardData ? e.clipboardData.getData('text/plain') : canvasClipboard);
    if (!objs) return;
    e.preventDefault();
    pasteCanvasObjects(objs);
}

function pasteCanvasObjects(objs) {
    const slide = canvasStore.getSlide(canvasSlideId);
    if (!slide) return;
    const sig = stableStringify(objs.map(o => o.id));
    const repeat = lastPaste.sig === sig && lastPaste.slideId === slide.id;
    // offset only when the copies would land exactly on top of something
    const clash = objs.some(o => (slide.objects || []).some(s => Math.abs(s.x - o.x) < 1 && Math.abs(s.y - o.y) < 1));
    const n = repeat ? lastPaste.n + 1 : (clash ? 1 : 0);
    afterCopies(canvasStore.commands.insertCopies(slide.id, objs, { dx: 24 * n, dy: 24 * n, label: 'Paste' }));
    lastPaste = { sig, slideId: slide.id, n };
}

// Copies of quiz questions keep their correct answer (the key lives in
// work_answer_keys under the object id, so a new id needs its own key doc).
function afterCopies(copies) {
    if (!Array.isArray(copies) || !copies.fromIds || !currentLessonId) return copies;
    copies.forEach((c, i) => {
        if (c.type !== 'quiz') return;
        copyQuizKey(copies.fromIds[i], c.id);
    });
    return copies;
}

async function copyQuizKey(fromId, toId) {
    try {
        const cached = quizKeyCache.get(fromId);
        const key = Array.isArray(cached) ? cached : await loadQuizKey(currentLessonId, fromId);
        if (!Array.isArray(key) || !key.length) return;
        quizKeyCache.set(toId, key);
        if (currentBlockId === toId) renderPropertiesPanel(true);
        await saveQuizKey(session.schoolId, currentLessonId, toId, key);
        noteQuizKey(toId, key);
    } catch (e) {
        console.warn('[Lesson Builder] could not copy a quiz answer key:', e);
    }
}

function wireCanvasControls() {
    els.canvasUndoBtn.addEventListener('click', () => canvasStore?.undo());
    els.canvasRedoBtn.addEventListener('click', () => canvasStore?.redo());
    [els.canvasUndoBtn, els.canvasRedoBtn].forEach(b => b.addEventListener('mousedown', (e) => e.preventDefault()));
    els.canvasZoomBtn.addEventListener('mousedown', (e) => e.preventDefault());
    els.canvasZoomBtn.addEventListener('click', (e) => {
        e.stopPropagation();
        const open = els.canvasZoomGroup.classList.contains('hidden');
        closeAllInsertPopovers();
        els.canvasZoomGroup.classList.toggle('hidden', !open);
    });
    els.canvasZoomGroup.addEventListener('mousedown', (e) => e.preventDefault());
    els.canvasZoomGroup.addEventListener('click', (e) => {
        const btn = e.target.closest('[data-zoom]');
        if (!btn || !canvasStore) return;
        canvasStore.setZoom(btn.dataset.zoom === 'fit' ? 'fit' : Number(btn.dataset.zoom));
        applyCanvasZoom();
        els.canvasZoomGroup.classList.add('hidden');
    });
    const signal = editorAbort.signal;
    document.addEventListener('keydown', onCanvasKeydown, { signal });
    document.addEventListener('copy', (e) => onCanvasCopy(e, false), { signal });
    document.addEventListener('cut', (e) => onCanvasCopy(e, true), { signal });
    document.addEventListener('paste', onCanvasPaste, { signal });
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
    if (!slide || slide.type !== 'blank' || !canvasStore) return null;
    syncStoreFromDraft(slide);
    endTextEdit();
    const siblings = canvasStore.getSlide(slide.id)?.objects || [];
    // FREE-FORM CANVAS: a small cascade so several quick inserts don't all land
    // in the exact same spot (same idea as PowerPoint's repeated insert).
    const n = siblings.length % 5;
    const block = newBlock(type);
    // centred on the slide, nudged a little per insert so repeats don't stack exactly
    block.x = Math.max(0, Math.min(100 - block.w, (100 - block.w) / 2 + n * 2.5));
    block.y = Math.max(0, Math.min(100 - block.h, (100 - block.h) / 2 + n * 3.5));
    if (extraProps) Object.assign(block, extraProps);
    const obj = v2BlockToV3Object(block, keyAbove(siblings));
    canvasStore.commands.addObjects(slide.id, [obj], { label: 'Insert' });
    // "Insert > Text" lands you ready to type, same as Slides/Docs; anything that
    // still needs a source/question opens its settings.
    if (type === 'text') beginTextEdit(obj.id);
    return block; // the Format toolbar switches to the new object's settings
}

// Native shape / line objects (canvas/tools) go straight into the store.
function insertCanvasObject(obj, label) {
    const slide = currentSlide();
    if (!slide || slide.type !== 'blank' || !canvasStore) return null;
    syncStoreFromDraft(slide);
    endTextEdit();
    canvasStore.commands.addObjects(slide.id, [obj], { label });
    return obj;
}

function siblingsForInsert() {
    const slide = currentSlide();
    return (slide && canvasStore?.getSlide(slide.id)?.objects) || [];
}

function insertShape(kind) {
    const sib = siblingsForInsert();
    const n = sib.length % 4;
    const obj = createShape(kind, sib);
    obj.x += n * 40; obj.y += n * 40;
    return insertCanvasObject(obj, 'Insert shape');
}

function insertLine(preset) {
    const sib = siblingsForInsert();
    const n = sib.length % 4;
    const obj = createLine(preset, sib);
    obj.x += n * 40; obj.y += n * 40;
    return insertCanvasObject(obj, preset === 'line' ? 'Insert line' : 'Insert arrow');
}

function wireShapeLineMenus() {
    els.insertShapeGrid.innerHTML = SHAPE_KINDS.map(k => `
        <button type="button" data-shape-kind="${k.kind}" title="${escHtml(k.label)}" class="h-11 rounded-md flex items-center justify-center hover:bg-[#eef4ff] border border-transparent hover:border-[#c7d9fd] transition">${shapeIcon(k.kind)}</button>`).join('');
    els.insertLineMenu.innerHTML = Object.entries(LINE_PRESETS).map(([key, p]) => `
        <button type="button" data-line-preset="${key}" class="lb-zoom-item lb-menu-row">${lineIcon(key)}<span>${escHtml(p.label)}</span></button>`).join('');
    const toggle = (btn, menu) => btn.addEventListener('click', (e) => {
        e.stopPropagation();
        const open = menu.classList.contains('hidden');
        closeAllInsertPopovers();
        menu.classList.toggle('hidden', !open);
    });
    toggle(els.insertShapeBtn, els.insertShapeMenu);
    toggle(els.insertLineBtn, els.insertLineMenu);
    els.insertShapeGrid.addEventListener('click', (e) => {
        const b = e.target.closest('[data-shape-kind]');
        if (!b) return;
        closeAllInsertPopovers();
        insertShape(b.dataset.shapeKind);
    });
    els.insertLineMenu.addEventListener('click', (e) => {
        const b = e.target.closest('[data-line-preset]');
        if (!b) return;
        closeAllInsertPopovers();
        insertLine(b.dataset.linePreset);
    });
}

// ── 9c. IMAGES (Storage pipeline + photo library) & STUDENT WIDGETS ──────
// Images never go into Firestore as pixels: tools/image.js downscales to a
// 2400px edge, encodes WebP and uploads to
//   schools/{s}/lessons/{lessonId}/media/{objectId}.webp
// and the object keeps only props.media = { storagePath, url, w, h }.
// Stock photos are copied into the same place by the importStockImage
// Cloud Function (attribution → props.credit).
const fileBaseName = (name) => String(name || '').replace(/\.[^.]+$/, '').replace(/[_-]+/g, ' ').trim().slice(0, 120);

function fitImageBox(media, maxW = 800, maxH = 450) {
    const ar = media && media.w && media.h ? media.w / media.h : 16 / 9;
    let w = maxW, h = maxW / ar;
    if (h > maxH) { h = maxH; w = maxH * ar; }
    return { w: Math.round(w), h: Math.round(h) };
}

function insertImageObject({ id, media, alt = '', credit = null }) {
    const sib = siblingsForInsert();
    const n = sib.length % 5;
    const { w, h } = fitImageBox(media);
    const obj = createObject('image', {
        id: id || newObjectId(), w, h,
        x: Math.round((STAGE.w - w) / 2 + n * 24), y: Math.round((STAGE.h - h) / 2 + n * 24),
        props: { imageUrl: media.url, media, imageAlt: alt, credit, contentScale: LEGACY_CONTENT_SCALE },
    }, sib);
    return insertCanvasObject(obj, 'Insert image');
}

async function insertImageFromFile(file, { replaceId = null } = {}) {
    const slide = currentSlide();
    if (!slide || slide.type !== 'blank' || !canvasStore) return null;
    if (!file || !/^image\//.test(file.type || '')) { setSaveStatus('That file is not an image', true); return null; }
    const objectId = replaceId || newObjectId();
    const slideId = slide.id;
    setSaveStatus('Uploading image…');
    try {
        const media = await uploadLessonImage({ schoolId: session.schoolId, lessonId: currentLessonId, objectId, file });
        if (!canvasStore) return null;
        if (replaceId) {
            const o = canvasStore.getObject(replaceId, slideId);
            if (!o) return null;
            const fresh = { ...media, url: `${media.url}&v=${Date.now()}` }; // same path → bust the browser cache
            const { h } = fitImageBox(fresh, o.w, 10000);
            canvasStore.dispatch({
                label: 'Replace image', slideId,
                before: { [o.id]: o },
                after: { [o.id]: { ...o, h, props: { ...o.props, media: fresh, imageUrl: fresh.url, crop: null, credit: null, imageAlt: o.props.imageAlt || fileBaseName(file.name) } } },
            });
        } else {
            insertImageObject({ id: objectId, media, alt: fileBaseName(file.name) });
        }
        setSaveStatus('Image uploaded', true);
        return objectId;
    } catch (e) {
        console.error('[Lesson Builder] image upload failed:', e);
        setSaveStatus('Image upload failed');
        alert(e?.code === 'storage/unauthorized'
            ? 'You do not have permission to upload images to this lesson.'
            : `The image could not be uploaded. ${e?.message || ''}`.trim());
        return null;
    }
}

// Lessons saved before the Storage pipeline embedded images as data: URLs
// inside the slide docs. Move them to Storage in the background once, on open.
async function migrateInlineImages() {
    const store = canvasStore;
    if (!store || !currentLessonId) return;
    const jobs = [];
    store.getState().slides.forEach((slide, slideId) => {
        (slide.objects || []).forEach(o => {
            const url = o.type === 'image' && o.props && o.props.imageUrl;
            if (url && url.startsWith('data:') && !(o.props.media && o.props.media.storagePath)) jobs.push({ slideId, id: o.id, url });
        });
    });
    if (!jobs.length) return;
    let done = 0;
    for (const j of jobs) {
        if (canvasStore !== store) return; // editor closed / lesson switched
        try {
            setSaveStatus(`Moving images to storage (${done + 1}/${jobs.length})…`);
            const blob = await dataUrlToBlob(j.url);
            const media = await uploadLessonImage({ schoolId: session.schoolId, lessonId: currentLessonId, objectId: j.id, file: blob });
            if (canvasStore !== store) return;
            store.commands.updateProps(j.slideId, j.id, { media, imageUrl: media.url }, { label: 'Move image to storage' });
            done++;
        } catch (e) {
            console.warn('[Lesson Builder] could not migrate an inline image:', e);
        }
    }
    if (done) setSaveStatus(`Moved ${done} image${done === 1 ? '' : 's'} to storage`, true);
}

// ── photo library modal ──
let stockState = { query: '', page: 1, totalPages: 0, results: [], busy: false, replaceId: null };

function ensureStockModal() {
    let el = document.getElementById('lbStockOverlay');
    if (el) return el;
    el = document.createElement('div');
    el.id = 'lbStockOverlay';
    el.className = 'hidden fixed inset-0 z-50 bg-[#0d1f35]/40 flex items-center justify-center p-4';
    el.innerHTML = `
    <div class="bg-white rounded-2xl shadow-2xl w-full max-w-[860px] max-h-[86vh] flex flex-col overflow-hidden" role="dialog" aria-modal="true" aria-labelledby="lbStockTitle">
        <div class="px-5 py-4 border-b border-[#dce3ed] flex items-center gap-3">
            <div class="flex-1 min-w-0">
                <p id="lbStockTitle" class="text-[15px] font-black text-[#0d1f35] m-0">Free photo library</p>
                <p class="text-[11.5px] font-semibold text-[#6b84a0] m-0">Free photos from Unsplash — copied into your school's storage, with the photographer credited on the slide.</p>
            </div>
            <button type="button" data-stock-close class="w-9 h-9 rounded-lg hover:bg-[#f4f7fb] text-[#6b84a0]" title="Close"><i class="fa-solid fa-xmark"></i></button>
        </div>
        <form data-stock-form class="px-5 py-3 flex items-center gap-2 border-b border-[#eef1f5]">
            <input data-stock-q type="search" placeholder="Search photos (e.g. volcano, fractions, rainforest)" class="lb-pinput flex-1" style="height:36px">
            <button type="submit" class="lb-pbtn" style="height:36px"><i class="fa-solid fa-magnifying-glass"></i>Search</button>
        </form>
        <div data-stock-body class="flex-1 overflow-y-auto p-4"></div>
        <div class="px-5 py-2.5 border-t border-[#eef1f5] flex items-center justify-between">
            <p data-stock-status class="text-[11.5px] font-semibold text-[#6b84a0] m-0"></p>
            <button type="button" data-stock-more class="lb-pbtn hidden">Load more</button>
        </div>
    </div>`;
    (els.builderView || document.body).appendChild(el);
    el.addEventListener('click', (e) => {
        if (e.target === el || e.target.closest('[data-stock-close]')) { closeStockModal(); return; }
        if (e.target.closest('[data-stock-more]')) { runStockSearch(stockState.page + 1); return; }
        const pick = e.target.closest('[data-stock-pick]');
        if (pick) pickStockPhoto(pick.dataset.stockPick, pick);
    });
    el.querySelector('[data-stock-form]').addEventListener('submit', (e) => {
        e.preventDefault();
        stockState.query = el.querySelector('[data-stock-q]').value.trim();
        if (stockState.query) runStockSearch(1);
    });
    el.addEventListener('keydown', (e) => { if (e.key === 'Escape') { e.stopPropagation(); closeStockModal(); } });
    return el;
}

function openStockModal({ replaceId = null } = {}) {
    const el = ensureStockModal();
    const host = isDocMode() ? els.docBuilderView : els.builderView;
    if (host && el.parentElement !== host) host.appendChild(el);
    stockState.replaceId = replaceId;
    el.classList.remove('hidden');
    if (!stockState.results.length) {
        el.querySelector('[data-stock-body]').innerHTML = `<div class="h-48 flex items-center justify-center text-[13px] font-semibold text-[#9ab0c6]">Search for a photo to get started.</div>`;
    }
    setTimeout(() => el.querySelector('[data-stock-q]').focus(), 30);
}

function closeStockModal() {
    document.getElementById('lbStockOverlay')?.classList.add('hidden');
}

async function runStockSearch(page) {
    const el = ensureStockModal();
    if (stockState.busy) return;
    stockState.busy = true;
    const status = el.querySelector('[data-stock-status]');
    const body = el.querySelector('[data-stock-body]');
    status.textContent = 'Searching…';
    if (page === 1) body.innerHTML = `<div class="h-48 flex items-center justify-center"><i class="fa-solid fa-spinner fa-spin text-[#2563eb] text-xl"></i></div>`;
    try {
        const res = await searchStock({ query: stockState.query, page });
        stockState.page = res.page;
        stockState.totalPages = res.totalPages;
        stockState.results = page === 1 ? res.results : [...stockState.results, ...res.results];
        body.innerHTML = stockState.results.length ? `<div class="grid grid-cols-2 sm:grid-cols-3 md:grid-cols-4 gap-2.5">${stockState.results.map((r, i) => `
            <button type="button" data-stock-pick="${i}" class="group relative rounded-lg overflow-hidden bg-[#eef1f5] aspect-[4/3] text-left focus:outline-none focus:ring-2 focus:ring-[#2563eb]" style="${r.color ? `background:${escHtml(r.color)}` : ''}" title="${escHtml(r.alt || 'Photo')}">
                <img src="${escHtml(r.thumb)}" alt="${escHtml(r.alt || '')}" loading="lazy" class="w-full h-full object-cover">
                <span class="absolute inset-x-0 bottom-0 px-2 py-1 text-[10px] font-bold text-white bg-gradient-to-t from-black/70 to-transparent truncate">${escHtml(r.credit?.name || '')} · ${escHtml(r.credit?.provider || '')}</span>
                <span data-stock-busy class="hidden absolute inset-0 bg-white/70 flex items-center justify-center"><i class="fa-solid fa-spinner fa-spin text-[#2563eb] text-lg"></i></span>
            </button>`).join('')}</div>`
            : `<div class="h-48 flex items-center justify-center text-[13px] font-semibold text-[#9ab0c6]">No photos found — try another word.</div>`;
        status.textContent = stockState.results.length ? 'Photos from Unsplash · click one to add it' : '';
        el.querySelector('[data-stock-more]').classList.toggle('hidden', !(res.page < res.totalPages));
    } catch (e) {
        console.error('[Lesson Builder] stock search failed:', e);
        body.innerHTML = `<div class="h-48 flex items-center justify-center text-center text-[13px] font-semibold text-[#e31b4a] px-6">${escHtml(e?.message || 'The photo library is unavailable right now.')}</div>`;
        status.textContent = '';
    } finally {
        stockState.busy = false;
    }
}

// Document: the photo is copied into the school's Storage (importStockImage)
// and goes in as an image block with the photographer credit as its title.
async function pickStockPhotoForDoc(r, tile) {
    if (!docEditor) return;
    tile.dataset.loading = '1';
    tile.querySelector('[data-stock-busy]')?.classList.remove('hidden');
    try {
        const out = await importStock({ schoolId: session.schoolId, lessonId: currentLessonId, objectId: newObjectId(), id: r.id });
        const c = out.credit || {};
        const credit = c.name ? `Photo: ${c.name}${c.provider ? ` / ${c.provider}` : ''}` : null;
        docEditor.insertImageUrl(out.media.url, { alt: out.alt || r.alt || '', title: credit });
        closeStockModal();
    } catch (e) {
        console.error('[Lesson Builder] stock import failed:', e);
        alert(e?.message || 'That photo could not be added. Please try another one.');
    } finally {
        delete tile.dataset.loading;
        tile.querySelector('[data-stock-busy]')?.classList.add('hidden');
    }
}

async function pickStockPhoto(index, tile) {
    const r = stockState.results[Number(index)];
    if (!r || tile.dataset.loading) return;
    if (isDocMode()) { pickStockPhotoForDoc(r, tile); return; }
    const slide = currentSlide();
    if (!slide || slide.type !== 'blank' || !canvasStore) return;
    tile.dataset.loading = '1';
    tile.querySelector('[data-stock-busy]')?.classList.remove('hidden');
    const replaceId = stockState.replaceId;
    const objectId = replaceId || newObjectId();
    try {
        const out = await importStock({ schoolId: session.schoolId, lessonId: currentLessonId, objectId, id: r.id });
        if (!canvasStore) return;
        if (replaceId) {
            const o = canvasStore.getObject(replaceId, slide.id);
            if (o) {
                const media = { ...out.media, url: `${out.media.url}&v=${Date.now()}` };
                const { h } = fitImageBox(media, o.w, 10000);
                canvasStore.dispatch({ label: 'Replace image', slideId: slide.id, before: { [o.id]: o },
                    after: { [o.id]: { ...o, h, props: { ...o.props, media, imageUrl: media.url, crop: null, credit: out.credit, imageAlt: o.props.imageAlt || out.alt || '' } } } });
            }
        } else {
            insertImageObject({ id: objectId, media: out.media, alt: out.alt || '', credit: out.credit });
        }
        closeStockModal();
    } catch (e) {
        console.error('[Lesson Builder] stock import failed:', e);
        alert(e?.message || 'That photo could not be added. Please try another one.');
    } finally {
        delete tile.dataset.loading;
        tile.querySelector('[data-stock-busy]')?.classList.add('hidden');
    }
}

// ── image properties (native v3 props; store commands) ──
function imagePropsHtml(o) {
    if (!o) return '';
    const p = o.props || {};
    const alt = p.imageAlt || '';
    const crop = normalizeCrop(p.crop) || { x: 0, y: 0, w: 1, h: 1 };
    const canCrop = !!(p.media && p.media.w && p.media.h);
    const pct = (v) => Math.round(v * 100);
    const cropInput = (k, v, title) => `<label class="lb-pmini" title="${title}"><span>${k}</span><input type="number" min="0" max="100" step="1" data-crop="${k}" value="${pct(v)}" ${canCrop ? '' : 'disabled'} class="lb-pinput" style="width:58px"></label>`;
    const external = p.imageUrl && !(p.media && p.media.storagePath) && !p.imageUrl.startsWith('data:');
    return pgroup('Image', `<div class="lb-pgroup-row">
            <button type="button" data-img="upload" class="lb-pbtn"><i class="fa-solid fa-upload"></i>${p.imageUrl ? 'Replace' : 'Upload'}</button>
            <button type="button" data-img="stock" class="lb-pbtn"><i class="fa-solid fa-images"></i>Photo library</button>
            <input type="file" data-img="file" accept="image/*" class="hidden">
        </div>`)
        + pgroup(`Alt text <span style="color:#e31b4a">*</span>`, `<input data-img="alt" type="text" value="${escHtml(alt)}" placeholder="Describe the image for screen readers" class="lb-pinput ${alt.trim() ? '' : 'lb-pinput-error'}" style="width:230px" aria-required="true">`)
        + pgroup('Caption', `<input data-img="caption" type="text" value="${escHtml(p.caption || '')}" placeholder="Optional" class="lb-pinput" style="width:170px">`)
        + pgroup(canCrop ? 'Crop (%)' : 'Crop · re-upload to enable', `<div class="lb-pgroup-row">${cropInput('x', crop.x, 'Left edge')}${cropInput('y', crop.y, 'Top edge')}${cropInput('w', crop.w, 'Width')}${cropInput('h', crop.h, 'Height')}
            <button type="button" data-img="cropReset" class="lb-picon" title="Reset crop" ${canCrop ? '' : 'disabled'}><i class="fa-solid fa-rotate-left"></i></button></div>`)
        + pgroup('Flip', `<div class="lb-pgroup-row">
            <button type="button" data-img="flipH" class="lb-picon ${p.flipH ? 'lb-on' : ''}" title="Flip horizontally"><i class="fa-solid fa-left-right"></i></button>
            <button type="button" data-img="flipV" class="lb-picon ${p.flipV ? 'lb-on' : ''}" title="Flip vertically"><i class="fa-solid fa-up-down"></i></button></div>`)
        + (p.credit && p.credit.name ? pgroup('Credit', `<a href="${escHtml(p.credit.url || '#')}" target="_blank" rel="noopener noreferrer" class="lb-phint" style="color:#2563eb">${escHtml(p.credit.name)} · ${escHtml(p.credit.provider || '')}</a>`) : '')
        + (external ? pgroup('', `<span class="lb-phint">Linked from another site — upload a copy so it can't break</span>`) : '');
}

function wireImageProps(id) {
    const slideId = canvasSlideId;
    const panel = els.formatContext;
    const obj = () => canvasStore?.getObject(id, slideId);
    const set = (patch, key, live = false) => {
        suppressPanelRender = live;
        try { canvasStore.commands.updateProps(slideId, id, patch, { label: 'Image', coalesceKey: `img:${id}:${key}` }); }
        finally { suppressPanelRender = false; }
    };
    const fileInput = panel.querySelector('[data-img="file"]');
    panel.querySelector('[data-img="upload"]')?.addEventListener('click', () => fileInput.click());
    fileInput?.addEventListener('change', () => {
        const f = fileInput.files?.[0];
        fileInput.value = '';
        if (f) insertImageFromFile(f, { replaceId: id });
    });
    panel.querySelector('[data-img="stock"]')?.addEventListener('click', () => openStockModal({ replaceId: id }));
    const alt = panel.querySelector('[data-img="alt"]');
    alt?.addEventListener('input', () => { alt.classList.toggle('lb-pinput-error', !alt.value.trim()); set({ imageAlt: alt.value }, 'alt', true); });
    const cap = panel.querySelector('[data-img="caption"]');
    cap?.addEventListener('input', () => set({ caption: cap.value }, 'caption', true));
    panel.querySelectorAll('[data-crop]').forEach(input => input.addEventListener('change', () => {
        const o = obj();
        if (!o) return;
        const cur = normalizeCrop(o.props.crop) || { x: 0, y: 0, w: 1, h: 1 };
        const v = Math.min(100, Math.max(0, Number(input.value) || 0)) / 100;
        const next = normalizeCrop({ ...cur, [input.dataset.crop]: input.dataset.crop === 'w' || input.dataset.crop === 'h' ? Math.max(0.05, v) : v });
        applyCrop(o, next);
    }));
    panel.querySelector('[data-img="cropReset"]')?.addEventListener('click', () => { const o = obj(); if (o) applyCrop(o, null); });
    panel.querySelector('[data-img="flipH"]')?.addEventListener('click', () => { const o = obj(); if (o) set({ flipH: !o.props.flipH }, 'flipH'); });
    panel.querySelector('[data-img="flipV"]')?.addEventListener('click', () => { const o = obj(); if (o) set({ flipV: !o.props.flipV }, 'flipV'); });

    // New crop → reshape the box to the cropped region's proportions, fitted
    // inside the box's current footprint (centre kept) so it never grows off
    // the slide. One undo step.
    function applyCrop(o, crop) {
        const m = o.props.media || {};
        const c = crop || { x: 0, y: 0, w: 1, h: 1 };
        const ra = m.w && m.h ? (c.w * m.w) / (c.h * m.h) : o.w / o.h;
        let w = o.w, h = o.w / ra;
        if (h > o.h) { h = o.h; w = o.h * ra; }
        w = Math.max(MIN_SIZE, Math.round(w)); h = Math.max(MIN_SIZE, Math.round(h));
        const x = Math.round(o.x + (o.w - w) / 2), y = Math.round(o.y + (o.h - h) / 2);
        canvasStore.dispatch({ label: 'Crop image', slideId, before: { [o.id]: o }, after: { [o.id]: { ...o, x, y, w, h, props: { ...o.props, crop } } } });
    }
}

// Publishing requires alt text on every image (accessibility).
function imagesMissingAlt() {
    const missing = [];
    (lessonDraft?.slides || []).forEach((s, i) => (s.blocks || []).forEach(b => {
        if (b.type === 'image' && (b.imageUrl || (b.media && b.media.url)) && !String(b.imageAlt || '').trim()) missing.push({ slideIndex: i, id: b.id });
    }));
    return missing;
}

// ── student widgets ──
const WIDGET_INSERT_ORDER = ['poll', 'quiz', 'open_response', 'board'];
const quizKeyCache = new Map(); // objectId → string[] | 'loading'

// ── quiz answer-key sync (work_answer_keys follows the editor) ──
// quizKeyIntent: the answer(s) the teacher marked — kept when the quiz or an
//   option is deleted, so Undo brings the correct answer back with it.
// quizKeySaved:  what work_answer_keys holds now (null = no key doc).
// syncQuizKeys() writes intent ∩ the quiz's current options for every quiz in
// the editor (option removed / restored by undo → key follows). Keys of quizzes
// that left the lesson are deleted server-side after each save
// (pruneLessonQuizKeys); a later undo re-creates them from the intent.
const quizKeyIntent = new Map();
const quizKeySaved = new Map();
let quizKeyLessonId = null;
let quizSyncTimer = null;

function quizKeyMapsForLesson() {
    if (quizKeyLessonId !== currentLessonId) {
        quizKeyIntent.clear();
        quizKeySaved.clear();
        quizKeyLessonId = currentLessonId;
    }
}

function noteQuizKey(id, ids, { saved = true } = {}) {
    quizKeyMapsForLesson();
    const list = (Array.isArray(ids) ? ids : []).map(String);
    quizKeyIntent.set(id, list);
    if (saved) quizKeySaved.set(id, list);
}

const sameIds = (a, b) => Array.isArray(a) && Array.isArray(b) && a.length === b.length && a.every((x, i) => x === b[i]);

// Every poll / quiz / open response / board in the open lesson, in order.
// → [{ id, type, props, slideIndex }]  (slideIndex -1 for documents)
function collectLessonWidgets() {
    const out = [];
    if (!lessonDraft) return out;
    if (lessonDraft.format === 'document') {
        const html = docEditor ? docEditor.getHTML() : (lessonDraft.slides[0]?.contentHtml || '');
        const tpl = document.createElement('template');
        tpl.innerHTML = html;
        tpl.content.querySelectorAll('.lesson-widget[data-widget-id]').forEach((el) => {
            let props = {};
            try { props = JSON.parse(el.getAttribute('data-config') || '{}') || {}; } catch (e) { props = {}; }
            out.push({ id: el.getAttribute('data-widget-id'), type: el.getAttribute('data-widget-type'), props, slideIndex: -1 });
        });
        return out;
    }
    if (!canvasStore) return out;
    const st = canvasStore.getState();
    const walk = (objects, slideIndex) => (objects || []).forEach((o) => {
        if (!o) return;
        if (WIDGET_TYPES.has(o.type)) out.push({ id: o.id, type: o.type, props: o.props || {}, slideIndex });
        const kids = o.props && Array.isArray(o.props.children) ? o.props.children : null;
        if (kids && kids.length && typeof kids[0] === 'object') walk(kids, slideIndex);
    });
    lessonDraft.slides.forEach((s, i) => walk((st.slides.get(s.id) || {}).objects, i));
    return out;
}

const optionIdsOf = (w) => (Array.isArray(w.props.options) ? w.props.options : []).map((o) => String(o && o.id)).filter(Boolean);

function scheduleQuizKeySync() {
    clearTimeout(quizSyncTimer);
    quizSyncTimer = setTimeout(() => { syncQuizKeys().catch((e) => console.warn('[Lesson Builder] quiz key sync:', e)); }, 600);
}

async function syncQuizKeys() {
    if (!lessonDraft || !currentLessonId || isNewDraft) return;
    quizKeyMapsForLesson();
    const lessonId = currentLessonId;
    for (const w of collectLessonWidgets()) {
        if (w.type !== 'quiz' || !quizKeyIntent.has(w.id)) continue;
        const opts = optionIdsOf(w);
        const eff = quizKeyIntent.get(w.id).filter((x) => opts.includes(x));
        const saved = quizKeySaved.get(w.id);
        if (saved !== undefined && saved !== null && sameIds(saved, eff)) continue;
        if (saved === undefined && !eff.length) continue; // new quiz, nothing marked yet
        quizKeySaved.set(w.id, eff);
        if (quizKeyCache.has(w.id) && quizKeyCache.get(w.id) !== 'loading') {
            quizKeyCache.set(w.id, eff);
            if (currentBlockId === w.id) renderPropertiesPanel(true);
        }
        try {
            await saveQuizKey(session.schoolId, lessonId, w.id, eff);
        } catch (e) {
            if (currentLessonId === lessonId) quizKeySaved.delete(w.id);
            console.warn('[Lesson Builder] could not sync a quiz answer key:', e);
        }
        if (currentLessonId !== lessonId) return;
    }
}

let pruneInFlight = null;
let prunePending = false;
function pruneQuizKeysAfterSave() {
    if (!currentLessonId || !currentPostContext) return;
    // a save landed while a prune was running: prune again against the newer content
    if (pruneInFlight) { prunePending = true; return; }
    const lessonId = currentLessonId;
    pruneInFlight = pruneLessonQuizKeys(session.schoolId, currentPostContext, lessonId).then((deleted) => {
        if (currentLessonId !== lessonId) return;
        quizKeyMapsForLesson();
        deleted.forEach(({ objectId, correct }) => {
            if (!quizKeyIntent.has(objectId)) quizKeyIntent.set(objectId, (correct || []).map(String));
            quizKeySaved.set(objectId, null);
        });
        // a quiz restored by undo while the prune ran gets its key back
        if (deleted.length) return syncQuizKeys();
    }).catch((e) => console.warn('[Lesson Builder] quiz key prune:', e))
        .finally(() => {
            pruneInFlight = null;
            if (prunePending) { prunePending = false; pruneQuizKeysAfterSave(); }
        });
}

// Publish check: every activity must be answerable and every quiz gradeable.
// → [{ id, slideIndex, index, text }]
async function widgetPublishProblems() {
    const problems = [];
    const widgets = collectLessonWidgets();
    for (let i = 0; i < widgets.length; i++) {
        const w = widgets[i];
        const where = w.slideIndex >= 0 ? ` on slide ${w.slideIndex + 1}` : '';
        const label = (WIDGET_META[w.type] && WIDGET_META[w.type].label) || 'Activity';
        const add = (text) => problems.push({ id: w.id, slideIndex: w.slideIndex, index: i, text: `${label}${where} ${text}` });
        const p = w.props || {};
        if (w.type === 'poll' || w.type === 'quiz') {
            const opts = Array.isArray(p.options) ? p.options : [];
            if (!String(p.question || '').trim()) add('has no question.');
            if (opts.length < 2) add('needs at least two options.');
            else if (opts.some((o) => !String((o && o.text) || '').trim())) add('has an empty option.');
            if (w.type === 'quiz') {
                let key = quizKeyCache.get(w.id);
                if (!Array.isArray(key)) key = quizKeyIntent.get(w.id);
                if (!Array.isArray(key)) key = await loadQuizKey(currentLessonId, w.id);
                const ids = optionIdsOf(w);
                if (!(key || []).some((x) => ids.includes(String(x)))) add('has no correct answer marked.');
            }
        } else if (w.type === 'open_response') {
            if (!String(p.prompt || '').trim()) add('has no question.');
        }
    }
    return problems;
}

function showWidgetProblem(first) {
    if (!first) return;
    if (lessonDraft.format === 'document') {
        const el = els.docEditor?.querySelectorAll('.doc-widget')[first.index];
        if (el) {
            el.scrollIntoView({ block: 'center', behavior: 'smooth' });
            el.style.outline = '3px solid #e31b4a';
            el.style.outlineOffset = '3px';
            setTimeout(() => { el.style.outline = ''; el.style.outlineOffset = ''; }, 2600);
        }
        return;
    }
    currentSlideIndex = first.slideIndex;
    currentBlockId = first.id;
    renderSlideThumbs();
    renderSlideCanvas();
    try { canvasStore?.setSelection([first.id]); } catch (e) { /* selection is best effort */ }
    renderPropertiesPanel(true);
}

function insertWidget(type) {
    const obj = createWidget(type, siblingsForInsert());
    if (type === 'quiz') { quizKeyCache.set(obj.id, []); noteQuizKey(obj.id, [], { saved: false }); } // new question: no key yet
    insertCanvasObject(obj, `Insert ${WIDGET_META[type].label.toLowerCase()}`);
}

function wireWidgetMenu() {
    els.insertWidgetMenu.innerHTML = WIDGET_INSERT_ORDER.map(t => `
        <button type="button" data-widget-type="${t}" class="lb-zoom-item lb-menu-row" style="align-items:flex-start">
            <i class="fa-solid ${WIDGET_META[t].icon}" style="color:#4f46e5;margin-top:2px;width:16px"></i>
            <span><span style="display:block">${escHtml(WIDGET_META[t].label)}</span><span style="display:block;font-size:10.5px;font-weight:600;color:#9ab0c6">${escHtml(WIDGET_META[t].blurb)}</span></span>
        </button>`).join('');
    els.insertWidgetBtn.addEventListener('click', (e) => {
        e.stopPropagation();
        const open = els.insertWidgetMenu.classList.contains('hidden');
        closeAllInsertPopovers();
        els.insertWidgetMenu.classList.toggle('hidden', !open);
    });
    els.insertWidgetMenu.addEventListener('click', (e) => {
        const b = e.target.closest('[data-widget-type]');
        if (!b) return;
        closeAllInsertPopovers();
        insertWidget(b.dataset.widgetType);
    });
}

function widgetPropsHtml(o) {
    if (!o) return '';
    const p = o.props || {};
    const text = (key, value, placeholder, width = 300) => `<input data-wp="${key}" type="text" value="${escHtml(value || '')}" placeholder="${escHtml(placeholder)}" class="lb-pinput" style="width:${width}px">`;
    if (o.type === 'poll' || o.type === 'quiz') {
        const isQuiz = o.type === 'quiz';
        const key = isQuiz ? quizKeyCache.get(o.id) : null;
        const correct = new Set(Array.isArray(key) ? key : []);
        const rows = (p.options || []).map((opt, i) => `
            <div class="lb-pgroup-row" style="gap:2px">
                ${isQuiz ? `<button type="button" data-wp-correct="${escHtml(opt.id)}" class="lb-picon ${correct.has(opt.id) ? 'lb-good' : ''}" title="${correct.has(opt.id) ? 'Correct answer' : 'Mark as correct'}" ${key === 'loading' ? 'disabled' : ''}><i class="fa-solid fa-check"></i></button>` : ''}
                <input data-wp-opt="${escHtml(opt.id)}" type="text" value="${escHtml(opt.text)}" placeholder="Option ${i + 1}" class="lb-pinput" style="width:130px">
                <button type="button" data-wp-remove="${escHtml(opt.id)}" class="lb-picon lb-danger" title="Remove option" ${(p.options || []).length <= 2 ? 'disabled' : ''}><i class="fa-solid fa-xmark"></i></button>
            </div>`).join('');
        return pgroup('Question', text('question', p.question, isQuiz ? 'What is 7 × 8?' : 'Which topic should we review?'))
            + pgroup(isQuiz ? (Array.isArray(key) && !key.length ? 'Options · <span style="color:#e31b4a">mark the correct one</span>' : 'Options · ✓ = correct') : 'Options',
                `<div class="lb-pgroup-row">${rows}<button type="button" data-wp-add class="lb-pbtn" ${(p.options || []).length >= 8 ? 'disabled' : ''}><i class="fa-solid fa-plus"></i>Add</button></div>`)
            + (isQuiz
                ? pgroup('Points', `<input data-wp-num="points" type="number" min="0" max="100" step="1" value="${Number(p.points) || 1}" class="lb-pinput" style="width:64px">`)
                : pgroup('Answers', `<div class="lb-pseg"><button type="button" data-wp-bool="multiple" data-v="0" class="${p.multiple ? '' : 'lb-on'}">One choice</button><button type="button" data-wp-bool="multiple" data-v="1" class="${p.multiple ? 'lb-on' : ''}">Pick any</button></div>`));
    }
    if (o.type === 'open_response') {
        return pgroup('Prompt', text('prompt', p.prompt, 'Explain how you solved it…'))
            + pgroup('Answer box', `<div class="lb-pseg"><button type="button" data-wp-mode="short" class="${p.mode !== 'long' ? 'lb-on' : ''}">Short</button><button type="button" data-wp-mode="long" class="${p.mode === 'long' ? 'lb-on' : ''}">Long</button></div>`)
            + pgroup('Max characters', `<input data-wp-num="maxLength" type="number" min="20" max="4000" step="10" value="${Number(p.maxLength) || 500}" class="lb-pinput" style="width:80px">`)
            + pgroup('', `<span class="lb-phint">Spotlight answers from the live presenter view</span>`);
    }
    if (o.type === 'board') {
        return pgroup('Prompt', text('prompt', p.prompt, 'Post one thing you noticed…'))
            + pgroup('Note color', `<div class="lb-pgroup-row">${['#fef3c7', '#dcfce7', '#dbeafe', '#fce7f3', '#ede9fe'].map(c => `<button type="button" data-wp-color="${c}" class="lb-picon ${p.noteColor === c ? 'lb-on' : ''}" style="background:${c}" title="${c}"></button>`).join('')}</div>`)
            + pgroup('', `<span class="lb-phint">Every student's note is shown to the class</span>`);
    }
    return '';
}

function wireWidgetProps(id) {
    const slideId = canvasSlideId;
    const panel = els.formatContext;
    const obj = () => canvasStore?.getObject(id, slideId);
    const update = (patch, key, live = false) => {
        suppressPanelRender = live;
        try { canvasStore.commands.updateProps(slideId, id, patch, { label: 'Activity', coalesceKey: `w:${id}:${key}` }); }
        finally { suppressPanelRender = false; }
    };
    panel.querySelectorAll('[data-wp]').forEach(input => input.addEventListener('input', () => update({ [input.dataset.wp]: input.value }, input.dataset.wp, true)));
    panel.querySelectorAll('[data-wp-opt]').forEach(input => input.addEventListener('input', () => {
        const o = obj();
        if (!o) return;
        update({ options: (o.props.options || []).map(opt => opt.id === input.dataset.wpOpt ? { ...opt, text: input.value } : opt) }, `opt:${input.dataset.wpOpt}`, true);
    }));
    panel.querySelector('[data-wp-add]')?.addEventListener('click', () => {
        const o = obj();
        if (!o) return;
        update({ options: [...(o.props.options || []), newOption('')] }, 'add');
        const inputs = els.formatContext.querySelectorAll('[data-wp-opt]');
        inputs[inputs.length - 1]?.focus();
    });
    panel.querySelectorAll('[data-wp-remove]').forEach(btn => btn.addEventListener('click', () => {
        const o = obj();
        if (!o) return;
        // the saved answer key drops a removed option via syncQuizKeys(); the marked
        // answer is remembered, so undoing the removal restores it as correct
        update({ options: (o.props.options || []).filter(opt => opt.id !== btn.dataset.wpRemove) }, 'remove');
    }));
    panel.querySelectorAll('[data-wp-correct]').forEach(btn => btn.addEventListener('click', () => {
        const cur = Array.isArray(quizKeyCache.get(id)) ? quizKeyCache.get(id) : [];
        const optId = btn.dataset.wpCorrect;
        // one correct answer per quiz question (single choice); click again to clear
        setQuizCorrect(id, cur.includes(optId) ? [] : [optId]);
    }));
    panel.querySelectorAll('[data-wp-num]').forEach(input => input.addEventListener('change', () => update({ [input.dataset.wpNum]: Number(input.value) || 0 }, input.dataset.wpNum)));
    panel.querySelectorAll('[data-wp-bool]').forEach(btn => btn.addEventListener('click', () => update({ [btn.dataset.wpBool]: btn.dataset.v === '1' }, btn.dataset.wpBool)));
    panel.querySelectorAll('[data-wp-mode]').forEach(btn => btn.addEventListener('click', () => update({ mode: btn.dataset.wpMode }, 'mode')));
    panel.querySelectorAll('[data-wp-color]').forEach(btn => btn.addEventListener('click', () => update({ noteColor: btn.dataset.wpColor }, 'color')));
}

async function ensureQuizKey(id) {
    if (quizKeyCache.has(id) || !currentLessonId) return;
    quizKeyCache.set(id, 'loading');
    const key = await loadQuizKey(currentLessonId, id);
    if (quizKeyCache.get(id) !== 'loading') return; // set meanwhile (copied / marked)
    quizKeyCache.set(id, key);
    noteQuizKey(id, key);
    if (currentBlockId === id) renderPropertiesPanel(true);
}

async function setQuizCorrect(id, correctIds) {
    const prev = quizKeyCache.get(id);
    quizKeyCache.set(id, correctIds);
    if (currentBlockId === id) renderPropertiesPanel(true);
    try {
        await saveQuizKey(session.schoolId, currentLessonId, id, correctIds);
        noteQuizKey(id, correctIds);
    } catch (e) {
        console.error('[Lesson Builder] saveQuizKey failed:', e);
        quizKeyCache.set(id, prev);
        if (currentBlockId === id) renderPropertiesPanel(true);
        alert('The correct answer could not be saved. Please try again.');
    }
}

function closeAllInsertPopovers() {
    els.canvasZoomGroup?.classList.add('hidden');
    els.insertShapeMenu?.classList.add('hidden');
    els.insertWidgetMenu?.classList.add('hidden');
    els.insertLineMenu?.classList.add('hidden');
    els.insertImageMenu.classList.add('hidden');
    els.insertVideoMenu.classList.add('hidden');
    els.addSlideLayoutMenu.classList.add('hidden');
    els.docInsertWidgetMenu?.classList.add('hidden');
    els.docInsertWidgetBtn?.setAttribute('aria-expanded', 'false');
}

function wireInsertToolbar() {
    wireShapeLineMenus();
    wireWidgetMenu();
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
        closeAllInsertPopovers();
        if (file) await insertImageFromFile(file);
    });
    els.insertImageStockRow?.addEventListener('click', () => { closeAllInsertPopovers(); openStockModal(); });
    els.insertImageUrlBtn.addEventListener('click', async () => {
        const url = els.insertImageUrlInput.value.trim();
        if (!url) return;
        els.insertImageUrlInput.value = '';
        closeAllInsertPopovers();
        // linked image: record its pixel size so crop works (no copy is made)
        const dim = await measureImage(url);
        const media = { storagePath: null, url, w: dim ? dim.w : 0, h: dim ? dim.h : 0 };
        insertImageObject({ media, alt: '' });
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

    // Close any open popover when clicking elsewhere on the page. Theme is
    // a modal now, not a popover in this flow — it isn't listed here.
    document.addEventListener('click', (e) => {
        if (!lessonDraft) return;
        if (e.target.closest('#insertImageBtn, #insertImageMenu, #insertVideoBtn, #insertVideoMenu, #insertShapeBtn, #insertShapeMenu, #insertLineBtn, #insertLineMenu, #insertWidgetBtn, #insertWidgetMenu, #addSlideBtn, #addSlideLayoutToggleBtn, #addSlideLayoutMenu, #canvasZoomBtn, #canvasZoomGroup')) return;
        closeAllInsertPopovers();
    }, { signal: editorAbort?.signal });

    // Delete/Backspace, nudge, undo/redo, duplicate and copy/cut/paste
    // (incl. pasting an image onto the slide) live in section 9b
    // (onCanvasKeydown / onCanvasCopy / onCanvasPaste).
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

// ── SLIDE DECK REDESIGN: theme gallery (top-bar Theme button → modal) ─────
// A real "come look and choose" gallery, not a dropdown tucked in a corner
// of the insert toolbar — openThemeGallery() shows #themeOverlay with a
// full-size preview card per theme; wireThemeGallery() only needs to run
// once (at init), same as the other modals in this file.
function updateThemeBtnDot() {
    if (els.themeBtnDot) els.themeBtnDot.style.background = currentTheme().accent;
    formatToolbar?.sync(); // the slide tools' Theme chip
}

function renderThemeGallery() {
    els.themeGallery.innerHTML = Object.entries(THEMES).map(([key, theme]) => `
        <button type="button" data-theme-key="${key}" class="lb-theme-card ${(lessonDraft.theme || 'general') === key ? 'lb-theme-selected' : ''}" title="${escHtml(theme.label)}">
            <span class="lb-theme-card-dot" style="background:${theme.accent}"><i class="fa-solid ${theme.icon}"></i></span>
            <span class="text-[11px] font-bold text-[#374f6b]">${escHtml(theme.label)}</span>
        </button>`).join('');
}

function openThemeGallery() {
    renderThemeGallery();
    els.themeOverlay.classList.remove('hidden');
}

function closeThemeGallery() {
    els.themeOverlay.classList.add('hidden');
}

function wireThemeGallery() {
    els.themeBtn?.addEventListener('click', openThemeGallery);
    els.closeThemeBtn.addEventListener('click', closeThemeGallery);
    els.themeOverlay.addEventListener('click', (e) => {
        if (e.target === els.themeOverlay) closeThemeGallery();
    });
    els.themeGallery.addEventListener('click', (e) => {
        const btn = e.target.closest('[data-theme-key]');
        if (!btn) return;
        lessonDraft.theme = btn.dataset.themeKey;
        markDirty();
        applyThemeToStage();
        renderThemeGallery();
        renderSlideThumbs();
        closeThemeGallery();
    });
}

// ── 10. FORMAT TOOLBAR (selection-driven tools under the menu bar) ──────
// canvas/toolbar.js owns the toolbar: slide tools, text / shape / line tools
// and the multi-selection cluster. Everything else (image, activities, video,
// assignment, interactive prompt) is rendered by formatHost.renderObject()
// below as one compact row: [LABEL control…] groups.
const OBJECT_LABELS = { text: 'Text', image: 'Image', video: 'Video', interactive_prompt: 'Prompt', assignment: 'Assignment', shape: 'Shape', line: 'Line', poll: 'Poll', quiz: 'Quiz', open_response: 'Response', board: 'Board' };
const pgroup = (title, inner, style = '') => `<div class="lb-pgroup" ${style ? `style="${style}"` : ''}>${title ? `<span class="lb-pgroup-title">${title}</span>` : ''}${inner}</div>`;

// force: rebuild even when the selection context is unchanged (async data
// arrived, a control changed which fields exist…).
function renderPropertiesPanel(force = false) {
    if (formatToolbar) { formatToolbar.refresh({ force }); return; }
    if (els.formatContext) els.formatContext.innerHTML = '';
}

const selectedIds = () => (canvasStore ? canvasStore.getState().selection : []);

const formatHost = {
    slideContext() {
        const slide = currentSlide();
        if (!slide || slide.type !== 'blank' || !canvasStore || canvasStore.getState().activeSlideId !== slide.id) return null;
        return {
            id: slide.id,
            empty: !(slide.blocks || []).length,
            background: slideBackground(slide),
            transition: slideTransition(slide),
            themeAccent: currentTheme().accent,
            layouts: Object.entries(SLIDE_LAYOUTS).map(([key, d]) => ({ key, label: d.label, icon: d.icon })),
        };
    },
    setBackground: (color) => setSlideField('background', color || null),
    setTransition: (v) => setSlideField('transition', v && v !== 'none' ? v : null),
    applyLayout: (key) => applyLayoutToCurrentSlide(key),
    openTheme: () => openThemeGallery(),
    isSuppressed: () => suppressPanelRender,
    align: (edge) => canvasStore?.commands.align(canvasSlideId, selectedIds(), edge),
    distribute: (axis) => canvasStore?.commands.distribute(canvasSlideId, selectedIds(), axis),
    group: () => canvasStore?.commands.group(canvasSlideId, selectedIds()),
    ungroup: () => canvasStore?.commands.ungroup(canvasSlideId, selectedIds()),
    renderObject(el, obj) {
        const slide = currentSlide();
        const block = (slide?.blocks || []).find(b => b.id === obj.id) || null;
        let html = '';
        if (obj.type === 'quiz') ensureQuizKey(obj.id);
        if (obj.type === 'image') html = imagePropsHtml(obj);
        else if (WIDGET_TYPES.has(obj.type)) html = widgetPropsHtml(obj);
        else if (block && obj.type === 'video') html = videoPropsHtml(block);
        else if (block && obj.type === 'assignment') html = assignmentPropsHtml(block);
        else if (block && obj.type === 'interactive_prompt') html = promptPropsHtml(block);
        if (!html) return false;
        el.innerHTML = `<div class="lb-props-row" role="group" aria-label="${escHtml(OBJECT_LABELS[obj.type] || 'Object')} settings">${html}</div>`;
        if (obj.type === 'image') wireImageProps(obj.id);
        else if (WIDGET_TYPES.has(obj.type)) wireWidgetProps(obj.id);
        else if (obj.type === 'video') wireVideoProps(block);
        else if (obj.type === 'assignment') wireAssignmentProps(block);
        else if (obj.type === 'interactive_prompt') wirePromptProps(block);
        return true;
    },
};

function toggleLock(ids) {
    const objs = ids.map(id => canvasStore?.getObject(id, canvasSlideId)).filter(Boolean);
    if (!objs.length) return;
    const lock = !objs.every(o => o.locked);
    canvasStore.dispatch({
        label: lock ? 'Lock' : 'Unlock', slideId: canvasSlideId,
        before: Object.fromEntries(objs.map(o => [o.id, o])),
        after: Object.fromEntries(objs.map(o => [o.id, { ...o, locked: lock }])),
    });
}

// ── video ──
function videoPropsHtml(block) {
    return pgroup('Video link', `<div class="lb-pgroup-row"><input id="blockVideoUrlInput" type="url" value="${escHtml(block.mediaUrl)}" placeholder="YouTube, Vimeo or Google Drive link" class="lb-pinput" style="width:300px">
            <span id="blockVideoUrlError" class="lb-perror ${blockUrlInvalid.get(block.id) ? '' : 'hidden'}">Not a YouTube, Vimeo or Drive link</span></div>`)
        + pgroup('Caption', `<input id="blockVideoCaptionInput" type="text" value="${escHtml(block.caption)}" placeholder="Optional" class="lb-pinput" style="width:200px">`);
}
function wireVideoProps(block) {
    document.getElementById('blockVideoUrlInput').addEventListener('input', (e) => {
        const url = e.target.value.trim();
        const parsed = parseMediaUrl(url);
        block.mediaUrl = url;
        block.provider = parsed?.provider || null;
        block.embedUrl = parsed?.embedUrl || '';
        const bad = !!url && !parsed;
        blockUrlInvalid.set(block.id, bad);
        document.getElementById('blockVideoUrlError').classList.toggle('hidden', !bad);
        markDirty();
    });
    document.getElementById('blockVideoCaptionInput').addEventListener('input', (e) => { block.caption = e.target.value; markDirty(); });
}

// ── assignment ──
function assignmentPropsHtml(block) {
    const assignments = (currentSubject?.assignments || []).filter(a => !a.archived);
    const options = ['<option value="">Select an assignment…</option>']
        .concat(assignments.map(a => `<option value="${escHtml(a.id)}" ${block.linkedAssignmentId === a.id ? 'selected' : ''}>${escHtml(a.title)}${a.maxScore ? ` (/${a.maxScore})` : ''}</option>`));
    return pgroup('Prompt', `<input id="blockAssignmentPromptInput" type="text" value="${escHtml(block.prompt)}" placeholder="What should students do on this slide?" class="lb-pinput" style="width:300px">`)
        + pgroup('Submits to', `<select id="blockLinkedAssignmentSelect" class="lb-pinput" style="width:240px">${options.join('')}</select>`) + (assignments.length ? '' : pgroup('', '<span class="lb-perror">No assignments in this subject yet — create one in the Assignments tab.</span>'));
}
function wireAssignmentProps(block) {
    document.getElementById('blockAssignmentPromptInput').addEventListener('input', (e) => { block.prompt = e.target.value; markDirty(); });
    document.getElementById('blockLinkedAssignmentSelect').addEventListener('change', (e) => {
        block.linkedAssignmentId = e.target.value || null;
        markDirty();
        renderSlideThumbs();
    });
}

// ── interactive prompt ──
function promptPropsHtml(block) {
    const mc = block.promptKind === 'multiple_choice';
    const choices = (block.choices || []).map((c, i) => `
        <div class="lb-pgroup-row" style="gap:2px">
            <input data-choice-index="${i}" type="text" value="${escHtml(c)}" placeholder="Choice ${i + 1}" class="lb-pinput" style="width:130px">
            <button type="button" data-remove-choice="${i}" class="lb-picon lb-danger" title="Remove choice"><i class="fa-solid fa-xmark"></i></button>
        </div>`).join('');
    return pgroup('Question', `<input id="blockPromptTextInput" data-prompt-field="promptText" type="text" value="${escHtml(block.promptText)}" placeholder="What do you want students to answer?" class="lb-pinput" style="width:300px">`)
        + pgroup('Answer type', `<div class="lb-pseg" title="Answered during a live session — only you see each student's answer.">
            <button type="button" data-prompt-kind="short_answer" class="${!mc ? 'lb-on' : ''}">Short answer</button>
            <button type="button" data-prompt-kind="multiple_choice" class="${mc ? 'lb-on' : ''}">Multiple choice</button>
        </div>`)
        + (mc ? pgroup('Choices', `<div class="lb-pgroup-row">${choices}<button type="button" data-add-choice class="lb-pbtn"><i class="fa-solid fa-plus"></i>Add</button></div>`) : '');
}
function wirePromptProps(block) {
    const panel = els.formatContext;
    panel.querySelector('#blockPromptTextInput').addEventListener('input', (e) => { block.promptText = e.target.value; markDirty(); });
    panel.querySelectorAll('[data-prompt-kind]').forEach(btn => btn.addEventListener('click', () => {
        const kind = btn.dataset.promptKind;
        if (block.promptKind === kind) return;
        block.promptKind = kind;
        // switching to short answer keeps the choices (flipping back loses nothing)
        if (kind === 'multiple_choice' && !(block.choices || []).length) block.choices = ['', ''];
        markDirty();
        renderPropertiesPanel(true);
    }));
    panel.querySelectorAll('[data-choice-index]').forEach(input => input.addEventListener('input', () => {
        if (!Array.isArray(block.choices)) block.choices = [];
        block.choices[Number(input.dataset.choiceIndex)] = input.value;
        markDirty();
    }));
    panel.querySelectorAll('[data-remove-choice]').forEach(btn => btn.addEventListener('click', () => {
        const i = Number(btn.dataset.removeChoice);
        block.choices = (block.choices || []).filter((_, idx) => idx !== i);
        markDirty();
        renderPropertiesPanel(true);
    }));
    panel.querySelector('[data-add-choice]')?.addEventListener('click', () => {
        block.choices = [...(block.choices || []), ''];
        markDirty();
        renderPropertiesPanel(true);
        const inputs = els.formatContext.querySelectorAll('[data-choice-index]');
        inputs[inputs.length - 1]?.focus();
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
    const prevHtml = btn.innerHTML;
    btn.disabled = true;
    btn.innerHTML = '<i class="fa-solid fa-spinner fa-spin"></i>';
    try {
        await persistDraft({ silent: false });
    } finally {
        btn.disabled = false;
        btn.innerHTML = prevHtml;
    }
}

// ── AUTOSAVE (2 s debounce) ──────────────────────────────────────────────
function markDirty() {
    hasUnsavedChanges = true;
    dirtyVersion++;
    // Any v2 edit of the open canvas slide (panel fields, layouts…) is mirrored
    // into the canvas store as one undoable step (section 9b).
    if (!canvasWritingBack && canvasStore && lessonDraft && lessonDraft.format !== 'document') {
        const s = currentSlide();
        if (s && s.type === 'blank') syncStoreFromDraft(s);
    }
    scheduleQuizKeySync();
    scheduleAutosave();
}

function scheduleAutosave() {
    if (!lessonDraft || !currentLessonId) return;
    clearTimeout(autosaveTimer);
    setSaveStatus('Unsaved changes');
    autosaveTimer = setTimeout(() => { persistDraft({ silent: true }); }, AUTOSAVE_MS);
}

// Single save path for Save Draft, autosave and unmount. Returns true when the
// lesson on the server matches what the teacher sees.
async function persistDraft({ silent = false } = {}) {
    clearTimeout(autosaveTimer);
    textTool?.flush(); // in-progress inline text edit → store → lessonDraft
    if (!lessonDraft || !currentLessonId) return true;
    if (saveInFlight) { await saveInFlight.catch(() => {}); }
    if (!lessonDraft || !currentLessonId) return true;
    if (silent && !hasUnsavedChanges) return true;   // autosave only after a real edit

    const version = dirtyVersion;
    const payload = { title: lessonDraft.title, slides: currentSlidesForSave(), theme: lessonDraft.theme };
    setSaveStatus('Saving…');
    const creating = isNewDraft;
    saveInFlight = creating
        ? insertLesson(session.schoolId, currentPostContext, { ...lessonDraft, ...payload, id: currentLessonId })
        : saveLessonContent(session.schoolId, currentPostContext, currentLessonId, payload);
    try {
        await saveInFlight;
        if (creating) {
            isNewDraft = false;
            if (lessonDraft) lessonDraft.isNew = false;
            embedded?.onCreated?.(currentLessonId);
        }
        if (dirtyVersion === version) hasUnsavedChanges = false;
        pruneQuizKeysAfterSave();
        setSaveStatus(hasUnsavedChanges ? 'Unsaved changes' : 'All changes saved', !hasUnsavedChanges);
        embedded?.onSaved?.({ id: currentLessonId, title: payload.title, slideCount: payload.slides.length });
        if (hasUnsavedChanges) scheduleAutosave();
        return true;
    } catch (e) {
        if (e?.code === 'not-found') {
            // deleted in another tab/session: stop retrying a save that can never land
            setSaveStatus('This lesson was deleted — changes are not being saved');
            hasUnsavedChanges = false;
            console.warn('[Lesson Builder] lesson no longer exists:', currentLessonId);
            return false;
        }
        setSaveStatus('Save failed — will retry on your next change');
        if (silent) console.error('[Lesson Builder] autosave failed:', e);
        else alert(describeSaveFailure('saveLessonContent (Save Draft)', e, payload));
        return false;
    } finally {
        saveInFlight = null;
    }
}

// Persistent status next to Save Draft (autosave feedback). fade=true hides it after a moment.
let saveStatusTimer = null;
function setSaveStatus(text, fade = false) {
    const target = lessonDraft?.format === 'document' ? els.docSaveMsg : els.saveMsg;
    if (!target) return;
    target.textContent = text;
    target.title = text;
    target.classList.remove('hidden');
    clearTimeout(saveStatusTimer);
    if (fade) saveStatusTimer = setTimeout(() => target.classList.add('hidden'), 2500);
}

function onBeforeUnload(e) {
    if (!hasUnsavedChanges && !saveInFlight) return;
    persistDraft({ silent: true }); // best effort while the browser shows its prompt
    e.preventDefault();
    e.returnValue = '';
}

function flashSaveMsg(text) {
    const target = lessonDraft?.format === 'document' ? els.docSaveMsg : els.saveMsg;
    target.textContent = text;
    target.title = text;
    target.classList.remove('hidden');
    setTimeout(() => target.classList.add('hidden'), 2500);
}

async function onPublishToggle() {
    // Publishing (and unpublishing) always saves current draft content
    // first, so a teacher who edited content and immediately hits Publish
    // never publishes stale content from the last explicit Save.
    const btn = lessonDraft.format === 'document' ? els.docPublishBtn : els.publishBtn;
    if (lessonDraft.status !== 'published' && lessonDraft.format !== 'document') {
        textTool?.flush();
        const missing = imagesMissingAlt();
        if (missing.length) {
            const slidesList = [...new Set(missing.map(m => m.slideIndex + 1))].join(', ');
            alert(`Add alt text to ${missing.length} image${missing.length === 1 ? '' : 's'} before publishing (slide ${slidesList}). Alt text describes the picture for students who use screen readers.`);
            currentSlideIndex = missing[0].slideIndex;
            currentBlockId = missing[0].id;
            renderSlideThumbs();
            renderSlideCanvas();
            renderPropertiesPanel(true);
            els.formatContext?.querySelector('[data-img="alt"]')?.focus();
            return;
        }
    }
    if (lessonDraft.status !== 'published') {
        if (lessonDraft.format !== 'document') textTool?.flush();
        btn.disabled = true;
        let problems = [];
        try { problems = await widgetPublishProblems(); }
        finally { btn.disabled = false; }
        if (problems.length) {
            const list = problems.slice(0, 8).map((p) => `• ${p.text}`).join('\n');
            const more = problems.length > 8 ? `\n…and ${problems.length - 8} more.` : '';
            alert(`Fix ${problems.length === 1 ? 'this activity' : 'these activities'} before publishing:\n\n${list}${more}`);
            showWidgetProblem(problems[0]);
            return;
        }
    }
    btn.disabled = true;
    clearTimeout(autosaveTimer);
    if (saveInFlight) await saveInFlight.catch(() => {});
    const version = dirtyVersion;
    const payload = { title: lessonDraft.title, slides: currentSlidesForSave(), theme: lessonDraft.theme };
    try {
        if (isNewDraft) {
            // Publish on a never-saved lesson: create it first (explicit action).
            if (!(await persistDraft({ silent: false }))) { btn.disabled = false; return; }
        } else {
            await saveLessonContent(session.schoolId, currentPostContext, currentLessonId, payload);
            if (dirtyVersion === version) hasUnsavedChanges = false;
        }

        if (lessonDraft.status === 'published') {
            if (!confirm('Unpublish this lesson? Students will no longer be able to open it. (Its Class Stream announcement, if any, stays visible.)')) {
                btn.disabled = false;
                return;
            }
            await unpublishLesson(session.schoolId, currentPostContext, currentLessonId);
            lessonDraft.status = 'draft';
        } else {
            const authorContext = embedded?.author || { authorId: session.teacherId, authorName: session.teacherData.name };
            await publishLesson(session.schoolId, currentPostContext, currentLessonId, lessonDraft, authorContext);
            lessonDraft.status = 'published';
            lessonDraft.publishedAt = new Date().toISOString();
        }
        renderStatusPill();
        renderPublishButton();
        embedded?.onSaved?.({ id: currentLessonId, title: lessonDraft.title, status: lessonDraft.status });
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
        if (isNewDraft && !(await persistDraft({ silent: false }))) return;
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

// ── 13. DOCUMENT BUILDER (Tiptap 2 — ./document.js) ──────────────────────
// A Document-format lesson always holds exactly one 'richtext' block in
// lessonDraft.slides[0]. The Tiptap editor — not lessonDraft — is the live
// source of truth while the editor is open; contentHtml is pulled out of it
// (Quill-compatible HTML, see document.js) at save time by
// currentSlidesForSave(), and saveLessonContent() writes it to doc/main.
let docEditor = null;          // createDocumentEditor() handle
let docEditorSeq = 0;          // a newer renderDocAll() wins over a still-loading one
let docFormatToolbar = null;   // the shared Format toolbar (canvas/toolbar.js), Document mode
let docToolbarStore = null;    // its store adapter (fed by editor transactions)

function docImageUpload(file) {
    const objectId = newObjectId();
    return uploadLessonImage({ schoolId: session.schoolId, lessonId: currentLessonId, objectId, file })
        .then(media => ({ url: media.url, alt: fileBaseName(file.name) }));
}

async function renderDocAll() {
    els.docLessonTitleInput.value = lessonDraft.title || '';
    renderStatusPill();
    renderPublishButton();

    const block = lessonDraft.slides[0] || newSlide('richtext');
    const seq = ++docEditorSeq;
    try {
        if (!docEditor) {
            const lessonId = currentLessonId;
            const ed = await createDocumentEditor({
                element: els.docEditor,
                html: block.contentHtml || '',
                onChange: () => markDirty(),
                onTransaction: () => onDocTransaction(),
                onAssignmentClick: (id) => openAssignmentViewModal(id),
                uploadImage: (file) => { setSaveStatus('Uploading image…'); return docImageUpload(file).then(r => { setSaveStatus('Image uploaded', true); return r; }); },
                parseVideoUrl: (url) => parseMediaUrl(url)?.embedUrl || null,
                // the editor is reused when another document is opened: always the open lesson's keys
                loadQuizKey: (wid) => (currentLessonId ? loadQuizKey(currentLessonId, wid).then((k) => { noteQuizKey(wid, k); return k; }) : Promise.resolve([])),
                saveQuizKey: (wid, ids) => saveQuizKey(session.schoolId, currentLessonId, wid, ids).then((r) => { noteQuizKey(wid, ids); return r; }),
                onError: (msg) => { setSaveStatus(msg); alert(msg); },
            });
            if (seq !== docEditorSeq || !lessonDraft || lessonDraft.format !== 'document' || currentLessonId !== lessonId) { ed.destroy(); return; }
            docEditor = ed;
            createDocFormatToolbar();
        } else {
            docEditor.setHTML(block.contentHtml || '');
        }
    } catch (e) {
        console.error('[Lesson Builder] document editor failed to load:', e);
        setSaveStatus('The document editor could not load — reload the page');
        return;
    }
    // opening a lesson starts clean
    hasUnsavedChanges = false;
    clearTimeout(autosaveTimer);
    onDocTransaction();
    migrateDocImages();
}

function destroyDocEditor() {
    docEditorSeq++;
    if (docFormatToolbar) { docFormatToolbar.destroy(); docFormatToolbar = null; }
    if (docToolbarStore) { docToolbarStore.destroy(); docToolbarStore = null; }
    if (docEditor) { docEditor.destroy(); docEditor = null; }
}

// ── the shared Format toolbar on the document ──
// canvas/toolbar.js drives a canvas store + text tool. The document is
// presented to it as ONE text object ('doc') that is always being edited, so
// every text control runs editor.chain().focus()…run() on the live Tiptap
// editor — the same code path as a text box being edited on a slide. Only the
// Text group exists (font, size, styles, marks, colours, alignment, line
// spacing, lists, link, clear); the student viewer renders all of it (step 3c).
const DOC_OBJECT = Object.freeze({ id: 'doc', type: 'text', props: {} });

function createDocToolbarStore() {
    const subs = new Set();
    let raf = 0;
    return {
        getState: () => ({ selection: ['doc'], activeSlideId: 'doc' }),
        getObject: (id) => (id === 'doc' ? DOC_OBJECT : null),
        groupOf: () => null,
        subscribe(fn) { subs.add(fn); return () => subs.delete(fn); },
        commands: { updateObjects: () => false },
        dispatch: () => false,
        emit() {
            if (raf) return;
            raf = requestAnimationFrame(() => { raf = 0; subs.forEach(fn => fn({ type: 'content', origin: 'external' })); });
        },
        destroy() { cancelAnimationFrame(raf); raf = 0; subs.clear(); },
    };
}

const docTextTool = {
    editingId: () => (docEditor ? 'doc' : null),
    isEditing: () => !!docEditor,
    getEditor: () => docEditor?.editor || null,
    state: () => (docEditor ? readEditorState(docEditor.editor) : null),
    computedStyle() {
        const ed = docEditor?.editor;
        if (!ed) return null;
        let el = null;
        try { const at = ed.view.domAtPos(ed.state.selection.from); el = at.node.nodeType === 1 ? at.node : at.node.parentElement; } catch (e) { el = null; }
        if (!el) return null;
        const cs = getComputedStyle(el);
        return { fontSize: parseFloat(cs.fontSize) || null, fontFamily: cs.fontFamily || '', color: cs.color || '' };
    },
    async formatObjects(ids, fn) { const ed = docEditor?.editor; if (ed) fn(ed.chain().focus()).run(); },
};

const docFormatHost = {
    slideContext: () => (docEditor ? { id: 'doc' } : null),
    renderObject: () => false,
    isSuppressed: () => false,
    setBackground() {}, setTransition() {}, applyLayout() {}, openTheme() {},
    align() {}, distribute() {}, group() {}, ungroup() {},
};

function createDocFormatToolbar() {
    if (docFormatToolbar || !els.docFormatContext) return;
    docToolbarStore = createDocToolbarStore();
    docFormatToolbar = createFormatToolbar({
        el: els.docFormatContext,
        popoverRoot: els.lessonEditorRoot || document.body,
        store: docToolbarStore,
        getTextTool: () => docTextTool,
        host: docFormatHost,
        groups: ['text'],
    });
    docFormatToolbar.refresh({ force: true });
}

function onDocTransaction() {
    docToolbarStore?.emit();
    if (els.docUndoBtn) els.docUndoBtn.disabled = !docEditor?.canUndo();
    if (els.docRedoBtn) els.docRedoBtn.disabled = !docEditor?.canRedo();
}

// ── Document menus (File · Edit · View · Insert · Format) ──
function docMenuModel(key) {
    const ready = !!docEditor;
    const published = lessonDraft?.status === 'published';
    const st = ready ? readEditorState(docEditor.editor) : null;
    const ed = docEditor?.editor;
    switch (key) {
        case 'file': return [
            item('file.save', 'Save draft', { icon: 'fa-floppy-disk', kbd: 'Ctrl+S' }),
            item('file.publish', published ? 'Unpublish' : 'Publish to students', { icon: 'fa-paper-plane' }),
            SEP,
            item('file.slideshow', 'Present from here', { icon: 'fa-display', kbd: 'Ctrl+Enter', disabled: !ready }),
            item('file.slideshowStart', 'Present from the beginning', { icon: 'fa-backward-step', kbd: 'Ctrl+Shift+Enter', disabled: !ready }),
            SEP,
            item('file.notes', 'Teacher notes…', { icon: 'fa-note-sticky' }),
            item('file.exit', 'Back to all lessons', { icon: 'fa-arrow-left' }),
        ];
        case 'edit': return [
            item('edit.undo', 'Undo', { icon: 'fa-rotate-left', kbd: 'Ctrl+Z', disabled: !(ready && docEditor.canUndo()) }),
            item('edit.redo', 'Redo', { icon: 'fa-rotate-right', kbd: 'Ctrl+Y', disabled: !(ready && docEditor.canRedo()) }),
            SEP,
            item('edit.cut', 'Cut', { icon: 'fa-scissors', kbd: 'Ctrl+X', disabled: !ready || ed.state.selection.empty }),
            item('edit.copy', 'Copy', { icon: 'fa-copy', kbd: 'Ctrl+C', disabled: !ready || ed.state.selection.empty }),
            item('edit.paste', 'Paste', { icon: 'fa-paste', kbd: 'Ctrl+V', disabled: !ready }),
            SEP,
            item('edit.selectAll', 'Select all', { icon: 'fa-object-group', kbd: 'Ctrl+A', disabled: !ready }),
        ];
        case 'view': return [
            item('view.focus', 'Full-screen editing', { icon: 'fa-expand', checked: focusMode, kbd: focusMode ? 'Esc' : '' }),
            item('file.slideshow', 'Present (read-only, full screen)', { icon: 'fa-display', kbd: 'Ctrl+Enter', disabled: !ready }),
        ];
        case 'insert': return [
            item('insert.image', 'Image…', { icon: 'fa-image', disabled: !ready, hint: 'Upload · library · URL' }),
            item('insert.video', 'Video…', { icon: 'fa-video', disabled: !ready }),
            item('insert.hr', 'Horizontal line', { icon: 'fa-minus', disabled: !ready }),
            item('insert.page', 'Page break', { icon: 'fa-file-circle-plus', disabled: !ready }),
            item('insert.assignment', 'Linked assignment…', { icon: 'fa-clipboard-check', disabled: !ready }),
            SEP,
            item('insert.widget', 'Student activity', { icon: 'fa-bolt', disabled: !ready, sub: DOC_WIDGET_TYPES.map(t => item(`insert.widget.${t}`, WIDGET_META[t].label, { icon: WIDGET_META[t].icon })) }),
        ];
        case 'format': return textFormatMenu({ item, SEP, st, disabled: !ready, fonts: FONT_FAMILIES, sizes: FONT_SIZES, lineHeights: LINE_HEIGHTS }); // same as Slides
        default: return [];
    }
}

async function docClipboard(kind) {
    const ed = docEditor?.editor;
    if (!ed) return;
    if (kind === 'paste') {
        try { const t = await navigator.clipboard.readText(); if (t) ed.chain().focus().insertContent(t).run(); }
        catch (e) { setSaveStatus('Use Ctrl+V to paste here', true); }
        return;
    }
    ed.commands.focus();
    try { document.execCommand(kind); } catch (e) { /* browser refused */ }
}

function runDocCommand(cmd, anchor = null) {
    const [group, action, arg] = cmd.split('.');
    if (group === 'file') {
        if (action === 'save') return onSaveDraft();
        if (action === 'publish') return onPublishToggle();
        if (action === 'notes') return openNotesModal();
        if (action === 'exit') return exitEditor();
        if (action === 'slideshow') return startDocumentPresent();
        if (action === 'slideshowStart') return startDocumentPresent({ fromStart: true });
        return undefined;
    }
    if (group === 'view') return action === 'focus' ? setFocusMode(!focusMode) : undefined;
    if (!docEditor) return undefined;
    const ed = docEditor.editor;
    switch (group) {
        case 'edit':
            if (action === 'undo') return docEditor.undo();
            if (action === 'redo') return docEditor.redo();
            if (action === 'cut' || action === 'copy' || action === 'paste') return docClipboard(action);
            if (action === 'selectAll') return ed.chain().focus().selectAll().run();
            return undefined;
        case 'insert':
            if (action === 'image') {
                const trig = (anchor && anchor.isConnected && anchor.offsetParent) ? anchor
                    : els.docBuilderView?.querySelector('[data-doc-cmd="insert.image"]');
                return docEditor.openImagePrompt(trig, { onLibrary: () => openStockModal() });
            }
            if (action === 'video') return docEditor.openVideoPrompt(anchor || els.docInsertVideoBtn);
            if (action === 'hr') return docEditor.insertDivider();
            if (action === 'page') return docEditor.addPage();
            if (action === 'assignment') return openAssignmentPicker();
            if (action === 'widget') return docEditor.insertWidget(arg);
            return undefined;
        case 'format': {
            const fc = textFormatCommand(cmd, FONT_FAMILIES);
            return fc && docFormatToolbar ? docFormatToolbar.runTextCommand(...fc) : undefined;
        }
        default:
            return undefined;
    }
}

// Fixed tools of the document toolbar row (undo / redo / inserts / Activities ▾)
function wireDocToolbar() {
    const bar = els.docFormatToolbar;
    if (!bar) return;
    bar.addEventListener('mousedown', (e) => { if (e.target.closest('.ft-fixed button')) e.preventDefault(); });
    bar.addEventListener('click', (e) => {
        const b = e.target.closest('[data-doc-cmd]');
        if (!b || b.disabled || !bar.contains(b)) return;
        closeAllInsertPopovers();
        runDocCommand(b.dataset.docCmd, b);
    });
    els.docInsertWidgetMenu.innerHTML = DOC_WIDGET_TYPES.map(t => `
        <button type="button" data-doc-widget="${t}" class="lb-zoom-item lb-menu-row" style="align-items:flex-start">
            <i class="fa-solid ${WIDGET_META[t].icon}" style="color:#4f46e5;margin-top:2px;width:16px"></i>
            <span><span style="display:block">${escHtml(WIDGET_META[t].label)}</span><span style="display:block;font-size:10.5px;font-weight:600;color:#9ab0c6">${escHtml(WIDGET_META[t].blurb)}</span></span>
        </button>`).join('');
    els.docInsertWidgetBtn.addEventListener('click', (e) => {
        e.stopPropagation();
        const open = els.docInsertWidgetMenu.classList.contains('hidden');
        closeAllInsertPopovers();
        els.docInsertWidgetMenu.classList.toggle('hidden', !open);
        els.docInsertWidgetBtn.setAttribute('aria-expanded', String(open));
    });
    els.docInsertWidgetMenu.addEventListener('mousedown', (e) => e.preventDefault());
    els.docInsertWidgetMenu.addEventListener('click', (e) => {
        const b = e.target.closest('[data-doc-widget]');
        if (!b) return;
        e.stopPropagation();
        closeAllInsertPopovers();
        docEditor?.insertWidget(b.dataset.docWidget);
    });
    const signal = editorAbort?.signal;
    document.addEventListener('click', (e) => {
        if (!els.docInsertWidgetMenu.classList.contains('hidden') && !els.docInsertWidgetMenu.contains(e.target) && !els.docInsertWidgetBtn.contains(e.target)) {
            els.docInsertWidgetMenu.classList.add('hidden');
            els.docInsertWidgetBtn.setAttribute('aria-expanded', 'false');
        }
    }, { signal });
    // Ctrl+Enter → Present Mode (Ctrl+Shift+Enter: from the beginning). Capture
    // phase + stopPropagation: Tiptap would otherwise insert a line break (Mod-Enter).
    document.addEventListener('keydown', (e) => {
        if (!isDocMode() || !docEditor || editorModalOpen() || e.key !== 'Enter' || !(e.ctrlKey || e.metaKey) || e.altKey) return;
        e.preventDefault();
        e.stopPropagation();
        startDocumentPresent({ fromStart: e.shiftKey });
    }, { capture: true, signal });
    // editor-wide shortcuts for documents (Tiptap owns B / I / U / Z / Y)
    document.addEventListener('keydown', (e) => {
        if (!isDocMode() || !docEditor || editorModalOpen()) return;
        const mod = e.ctrlKey || e.metaKey;
        if (mod && !e.altKey && e.key.toLowerCase() === 's') { e.preventDefault(); onSaveDraft(); return; }
        if (e.key === 'Escape' && !els.docInsertWidgetMenu.classList.contains('hidden')) { e.preventDefault(); closeAllInsertPopovers(); els.docInsertWidgetBtn.focus(); }
    }, { signal });
}

// Word imports / pre-Storage documents carry images as data: URLs inside the
// HTML. Move them to Storage once, in the background, after opening.
async function migrateDocImages() {
    const ed = docEditor, lessonId = currentLessonId;
    if (!ed || !lessonId) return;
    const srcs = [...new Set(ed.dataImages().map(i => i.src))];
    let done = 0;
    for (const src of srcs) {
        if (docEditor !== ed || currentLessonId !== lessonId) return;
        try {
            setSaveStatus(`Moving images to storage (${done + 1}/${srcs.length})…`);
            const blob = await dataUrlToBlob(src);
            const media = await uploadLessonImage({ schoolId: session.schoolId, lessonId, objectId: newObjectId(), file: blob });
            if (docEditor !== ed) return;
            if (ed.replaceImageSrc(src, media.url)) { done++; markDirty(); }
        } catch (e) {
            console.warn('[Lesson Builder] could not migrate a document image:', e);
        }
    }
    if (done) setSaveStatus(`Moved ${done} image${done === 1 ? '' : 's'} to storage`, true);
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
// these run): a Google Slides / PowerPoint "Publish to Web" embed link (see
// onImportSlidesClick, below), native .docx upload/paste — a real Word →
// Document-lesson conversion via mammoth.js, see runDocxImport below — and
// native .pptx upload/paste (see runPptxImport, below). The two file-based
// imports always create a brand-new lesson from the parsed content (Document
// for .docx, Slide Deck for .pptx), since there's no open lesson here to
// import into. A Google Slides deck or Google Doc comes in through these
// same two file imports — File → Download → PowerPoint/Word from Google,
// then upload that file here — deliberately with no Google account
// authorization or API integration anywhere in this flow.
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

// ── NATIVE WORD (.DOCX) IMPORT ─────────────────────────────────────────────
// mammoth.js (loaded via CDN, see builder.html) converts the uploaded
// .docx's XML into semantic HTML entirely client-side — headings, lists,
// bold/italic/underline/strikethrough, images (inlined as base64 data:
// URIs, same approach the .pptx importer already uses for pictures), and
// links all come through. Mammoth deliberately does NOT preserve exact
// fonts/colors, table borders, or page breaks — it maps Word's own
// "Heading 1"-style semantic markup to HTML rather than trying to
// pixel-match the original page, which is a good fit here since the
// Document format's Quill editor isn't a pixel-exact layout engine either.
//
// This is the same import path a Google Doc goes through: File → Download →
// Microsoft Word (.docx) from Google Docs, then upload that file here.
// Deliberately no Google account authorization or API integration anywhere
// in this flow — see this section's own note above.
//
// Like native .pptx import, this always creates a brand-new lesson (this
// modal only ever opens from the lesson picker, before any lesson is open)
// — same create-then-populate pattern runPptxImport() uses below, just
// targeting format: 'document' with one richtext block instead of
// format: 'slides' with several blank slides.
function isDocxFile(file) {
    return /\.docx$/i.test(file?.name || '') ||
        file?.type === 'application/vnd.openxmlformats-officedocument.wordprocessingml.document';
}

async function onImportDocxFileSelected(e) {
    const file = e.target.files?.[0];
    e.target.value = ''; // allow re-selecting the same filename after a failed attempt
    if (!file) return;
    await runDocxImport(file);
}

async function onImportDocxPaste(e) {
    if (els.importOptionsOverlay.classList.contains('hidden')) return; // only act while this modal is open
    const file = [...(e.clipboardData?.files || [])].find(isDocxFile);
    if (!file) return;
    e.preventDefault();
    await runDocxImport(file);
}

async function runDocxImport(file) {
    if (!currentPostContext) { alert('Select a subject first.'); return; }
    if (typeof mammoth === 'undefined') {
        showImportStatus(els.importDocxStatus, "Word import isn't available right now (a required library failed to load) — please reload the page and try again.", true);
        return;
    }

    showImportStatus(els.importDocxStatus, `Reading ${file.name}…`);
    els.importDocxTrigger.classList.add('opacity-50', 'pointer-events-none');

    try {
        const arrayBuffer = await file.arrayBuffer();
        const result = await mammoth.convertToHtml({ arrayBuffer });
        const contentHtml = (result?.value || '').trim();
        if (!contentHtml) throw new Error('No readable text was found in that document.');
        if (result?.messages?.length) {
            // Non-fatal notes from mammoth (e.g. an unrecognized style) —
            // logged for diagnosability, same "degrade, don't crash"
            // approach as parsePptxFile()'s per-slide warnings below.
            console.warn('[Lesson Builder] .docx import messages:', result.messages);
        }

        const title = (file.name || 'Imported Document')
            .replace(/\.docx$/i, '').replace(/[_-]+/g, ' ').trim() || 'Imported Document';

        const authorContext = { authorId: session.teacherId, authorName: session.teacherData.name };
        const lesson = await createLesson(session.schoolId, currentPostContext, authorContext, { title, format: 'document' });
        const richtextSlide = newSlide('richtext');
        richtextSlide.contentHtml = contentHtml;
        await saveLessonContent(session.schoolId, currentPostContext, lesson.id, { title, slides: [richtextSlide] });
        lessonsCache.unshift({ ...lesson, title, slides: [richtextSlide] });

        showImportStatus(els.importDocxStatus, `Imported "${title}" — opening it…`);
        setTimeout(async () => {
            closeImportOptionsModal();
            openInContext(lesson.id);
        }, 700);
    } catch (err) {
        console.error('[Lesson Builder] .docx import failed:', err);
        const message = (err?.message && err.message.length < 160) ? err.message : 'Could not read that Word file. Please try a different .docx file.';
        showImportStatus(els.importDocxStatus, message, true);
    } finally {
        els.importDocxTrigger.classList.remove('opacity-50', 'pointer-events-none');
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

    if (!lessonDraft) {
        showImportStatus(els.importSlidesStatus, 'Open a lesson first — the link is embedded into the lesson you are editing.', true);
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
        markDirty();
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
        if (!docEditor) { showImportStatus(els.importSlidesStatus, 'The document is still loading — try again in a moment.', true); return; }
        docEditor.editor.commands.focus('end');
        docEditor.insertVideo(embedUrl);
        markDirty();
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
// Scope of what this reads, by design: EVERY text shape (<p:sp>) and
// picture (<p:pic>) directly on the slide, or nested one or more levels
// deep inside a group (<p:grpSp>) — each becomes its own block, placed at
// its own real position and size, not lumped into one heading + one body
// box. Position/size come from each shape's own <a:xfrm> (offset + extent,
// in EMU) converted to the same x/y/w/h percentages every other block on
// this canvas already uses, against the deck's actual slide size
// (<p:sldSz> in presentation.xml — this is what makes an imported slide
// land close to its source layout instead of two generic boxes). A
// shape inside a group has its own offset/extent in the GROUP's local
// coordinate space (<a:chOff>/<a:chExt>), which is composed through the
// group's own transform before converting to percentages — see
// composeGroupTransform() below. Basic run-level formatting (bold,
// italic, underline) is preserved on text; embedded raster images
// (png/jpg/gif/bmp/webp — vector formats like EMF/WMF, which PowerPoint
// sometimes uses for pasted charts/icons, are skipped, since browsers
// can't render them as an <img>) are inlined as base64 data: URIs, one
// Image block per picture shape.
//
// Still NOT read, by design — a later, separate pass if ever needed: speaker
// notes, tables (<a:tbl>), charts, SmartArt, connectors, animations, or
// slide masters/layouts (placeholder text that comes ONLY from a slide's
// layout — nothing typed directly on the slide itself — won't be picked
// up). A slide with no shape this parser recognizes is still imported as a
// blank slide with a placeholder Text block rather than silently dropped,
// so the deck's slide count and order always match the source file. A
// shape with no <a:xfrm> of its own (common for a placeholder that
// inherits its position from the slide layout, which isn't parsed) falls
// back to a simple top-to-bottom cascade rather than stacking on top of
// other shapes.
//
// This is also the path a Google Slides deck comes in through: File →
// Download → Microsoft PowerPoint (.pptx) from Google Slides, then upload
// that file here. Google's own PowerPoint export writes real per-shape
// <a:xfrm> transforms, so this same parser carries it over with no
// Google-specific handling needed.
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
            openInContext(lesson.id);
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

    // The deck's own slide dimensions (EMU) — every shape's <a:xfrm> is
    // measured against this, so it's what makes EMU → percentage
    // conversion land shapes in the right place. Falls back to PowerPoint's
    // modern 16:9 default (13.333in × 7.5in) if a slide size is somehow
    // missing, rather than throwing over one malformed field.
    const sldSzNode = presentationDoc.getElementsByTagName('p:sldSz')[0];
    const slideSizeEmu = {
        cx: parseFloat(sldSzNode?.getAttribute('cx')) || 12192000,
        cy: parseFloat(sldSzNode?.getAttribute('cy')) || 6858000
    };

    const slides = [];
    for (const slidePath of slidePaths) {
        try {
            slides.push(await parseOnePptxSlide(zip, slidePath, slideSizeEmu));
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

// Composes a group shape's own transform with its parent's, so a shape
// nested inside one or more <p:grpSp> levels still converts to the
// correct ABSOLUTE slide position. A group's <a:xfrm> carries both its
// own off/ext (where the group itself sits on the slide, or its parent
// group) and a chOff/chExt (the coordinate space its CHILDREN's own
// off/ext are written in) — a child's local rect is rescaled out of that
// child space and offset into the group's own, then handed to the parent
// compose to keep unwinding outward until it reaches the slide's own
// coordinate space (the identity compose parseOnePptxSlide() starts with).
function composeGroupTransform(parent, groupXfrm) {
    const scaleX = groupXfrm.chExtCX ? groupXfrm.extCX / groupXfrm.chExtCX : 1;
    const scaleY = groupXfrm.chExtCY ? groupXfrm.extCY / groupXfrm.chExtCY : 1;
    return {
        mapRect(r) {
            return parent.mapRect({
                x: groupXfrm.offX + (r.x - groupXfrm.chOffX) * scaleX,
                y: groupXfrm.offY + (r.y - groupXfrm.chOffY) * scaleY,
                cx: r.cx * scaleX,
                cy: r.cy * scaleY
            });
        }
    };
}

// A shape's own <p:spPr>/<a:xfrm>/<a:off>+<a:ext> — its position/size in
// EMU, in whatever coordinate space its parent (the slide, or an
// enclosing group) uses. Returns null when the shape has none of its own
// (it inherits position from the slide layout instead, which this parser
// doesn't read) — callers fall back to a cascade layout in that case.
function readShapeXfrm(spPrEl) {
    const xfrm = spPrEl?.getElementsByTagName('a:xfrm')[0];
    const off = xfrm?.getElementsByTagName('a:off')[0];
    const ext = xfrm?.getElementsByTagName('a:ext')[0];
    if (!off || !ext) return null;
    return {
        x: parseFloat(off.getAttribute('x')) || 0,
        y: parseFloat(off.getAttribute('y')) || 0,
        cx: parseFloat(ext.getAttribute('cx')) || 0,
        cy: parseFloat(ext.getAttribute('cy')) || 0
    };
}

// A <p:grpSp>'s own <p:grpSpPr>/<a:xfrm> — its off/ext (where the group
// sits in its parent's space) PLUS chOff/chExt (the coordinate space its
// children's own off/ext are written in). Falls back to a 1:1 child
// space (chOff = 0, chExt = ext) when chOff/chExt are missing, which is a
// rare but valid OOXML shape.
function readGroupXfrm(grpSpPrEl) {
    const xfrm = grpSpPrEl?.getElementsByTagName('a:xfrm')[0];
    const off = xfrm?.getElementsByTagName('a:off')[0];
    const ext = xfrm?.getElementsByTagName('a:ext')[0];
    if (!off || !ext) return null;
    const chOff = xfrm.getElementsByTagName('a:chOff')[0];
    const chExt = xfrm.getElementsByTagName('a:chExt')[0];
    const extCX = parseFloat(ext.getAttribute('cx')) || 0;
    const extCY = parseFloat(ext.getAttribute('cy')) || 0;
    return {
        offX: parseFloat(off.getAttribute('x')) || 0,
        offY: parseFloat(off.getAttribute('y')) || 0,
        extCX, extCY,
        chOffX: chOff ? (parseFloat(chOff.getAttribute('x')) || 0) : 0,
        chOffY: chOff ? (parseFloat(chOff.getAttribute('y')) || 0) : 0,
        chExtCX: chExt ? (parseFloat(chExt.getAttribute('cx')) || extCX) : extCX,
        chExtCY: chExt ? (parseFloat(chExt.getAttribute('cy')) || extCY) : extCY
    };
}

// EMU rect (already in slide-absolute coordinates) → this canvas's x/y/w/h
// percentage convention, clamped so an odd shape near a slide edge can't
// produce a negative position or push a block off the visible stage.
function emuRectToPct(rectEmu, slideSizeEmu) {
    const xPct = Math.min(Math.max((rectEmu.x / slideSizeEmu.cx) * 100, 0), 96);
    const yPct = Math.min(Math.max((rectEmu.y / slideSizeEmu.cy) * 100, 0), 96);
    const wPct = Math.min(Math.max((rectEmu.cx / slideSizeEmu.cx) * 100, 4), 100 - xPct);
    const hPct = Math.min(Math.max((rectEmu.cy / slideSizeEmu.cy) * 100, 4), 100 - yPct);
    return { x: xPct, y: yPct, w: wPct, h: hPct };
}

// One <a:r> run → an HTML fragment with its own bold/italic/underline
// preserved — the closest this parser gets to real text styling without
// pulling in theme/color resolution (a bigger, separate piece of work).
function pptxRunToHtml(runEl) {
    const text = runEl.getElementsByTagName('a:t')[0]?.textContent || '';
    if (!text) return '';
    let html = escHtml(text);
    const rPr = runEl.getElementsByTagName('a:rPr')[0];
    if (rPr) {
        if (rPr.getAttribute('b') === '1') html = `<strong>${html}</strong>`;
        if (rPr.getAttribute('i') === '1') html = `<em>${html}</em>`;
        const underline = rPr.getAttribute('u');
        if (underline && underline !== 'none') html = `<u>${html}</u>`;
    }
    return html;
}

function pptxParagraphToHtml(pEl) {
    return [...pEl.getElementsByTagName('a:r')].map(pptxRunToHtml).join('');
}

async function resolvePptxImage(zip, slidePath, imageRelIdToTarget, blipRid) {
    const mediaTarget = blipRid && imageRelIdToTarget[blipRid];
    if (!mediaTarget) return null;
    // BUG FIX (caught by testing this rewrite against a real .pptx): a
    // rels Target like "../media/image1.png" is relative to the FOLDER
    // slidePath's own part lives in ("ppt/slides/"), not to slidePath's
    // grandparent. The previous expression, slidePath.replace(/slides\/
    // [^/]+$/, ''), stripped "slides/slideN.xml" (not just the filename),
    // leaving "ppt/" instead of "ppt/slides/" — one directory level too
    // shallow — so the target's "../" canceled out the wrong segment and
    // resolved to "media/image1.png" instead of "ppt/media/image1.png",
    // silently failing zip.file() below and dropping every picture. This
    // strips only the last path segment (the filename), which is correct
    // for any slide path, not just the "ppt/slides/slideN.xml" shape.
    const slideDir = slidePath.replace(/\/[^/]*$/, '/');
    const mediaPath = normalizeZipPath(slideDir, mediaTarget);
    const mime = PPTX_IMAGE_MIME[(mediaPath.split('.').pop() || '').toLowerCase()];
    const mediaEntry = mime && zip.file(mediaPath);
    if (!mediaEntry) return null;
    const base64 = await mediaEntry.async('base64');
    return `data:${mime};base64,${base64}`;
}

async function parseOnePptxSlide(zip, slidePath, slideSizeEmu) {
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

    const slide = newSlide('blank');
    const spTree = doc.getElementsByTagName('p:spTree')[0];
    if (!spTree) return slide;

    // A shape with no <a:xfrm> of its own (inherits position from the
    // slide layout, which this parser doesn't read) falls back to this
    // simple top-to-bottom cascade instead of stacking on top of others.
    let fallbackCursorY = 6;
    function nextFallbackLayout() {
        const layout = { x: 8, y: fallbackCursorY, w: 84, h: 16 };
        fallbackCursorY = Math.min(fallbackCursorY + 18, 80);
        return layout;
    }

    const identityCompose = { mapRect: (r) => r };

    function handleTextShape(spEl, compose) {
        const phType = spEl.getElementsByTagName('p:ph')[0]?.getAttribute('type') || '';
        const isTitlePh = phType === 'title' || phType === 'ctrTitle';
        const paragraphHtmls = [...spEl.getElementsByTagName('a:p')]
            .map(pptxParagraphToHtml)
            .filter(html => html.length);
        if (!paragraphHtmls.length) return;

        const spPr = spEl.getElementsByTagName('p:spPr')[0];
        const localRect = readShapeXfrm(spPr);
        const layout = localRect ? emuRectToPct(compose.mapRect(localRect), slideSizeEmu)
            : (isTitlePh ? { x: 8, y: 6, w: 84, h: 16 } : nextFallbackLayout());

        const block = newBlock('text', layout);
        block.html = isTitlePh ? `<h2>${paragraphHtmls.join(' ')}</h2>` : paragraphHtmls.map(h => `<p>${h}</p>`).join('');
        slide.blocks.push(block);
    }

    async function handlePicShape(picEl, compose) {
        const blipRid = picEl.getElementsByTagName('a:blip')[0]?.getAttribute('r:embed');
        const imageDataUrl = await resolvePptxImage(zip, slidePath, imageRelIdToTarget, blipRid);
        if (!imageDataUrl) return;

        const spPr = picEl.getElementsByTagName('p:spPr')[0];
        const localRect = readShapeXfrm(spPr);
        const layout = localRect ? emuRectToPct(compose.mapRect(localRect), slideSizeEmu) : nextFallbackLayout();

        const block = newBlock('image', layout);
        block.imageUrl = imageDataUrl;
        slide.blocks.push(block);
    }

    async function walk(nodes, compose) {
        for (const node of nodes) {
            if (node.tagName === 'p:sp') {
                handleTextShape(node, compose);
            } else if (node.tagName === 'p:pic') {
                await handlePicShape(node, compose);
            } else if (node.tagName === 'p:grpSp') {
                const groupXfrm = readGroupXfrm(node.getElementsByTagName('p:grpSpPr')[0]);
                const childCompose = groupXfrm ? composeGroupTransform(compose, groupXfrm) : compose;
                await walk([...node.children], childCompose);
            }
            // p:graphicFrame (tables/charts), p:cxnSp (connectors) — not
            // read yet, see this section's top comment.
        }
    }

    await walk([...spTree.children], identityCompose);

    if (!slide.blocks.length) {
        // No shape this parser recognizes had usable content — still a
        // real slide with a placeholder block, so the deck's slide count
        // and order always match the source file.
        const placeholder = newBlock('text', { x: 10, y: 40, w: 80, h: 16 });
        placeholder.html = '<p>This slide had no readable text or images.</p>';
        slide.blocks.push(placeholder);
    }
    return slide;
}

function onAssignmentPickerClick(e) {
    const btn = e.target.closest('[data-assignment-id]');
    if (!btn || !docEditor) return;
    // the card is followed by a space so the caret never sticks to the atom
    docEditor.insertAssignment({ id: btn.dataset.assignmentId, title: btn.dataset.assignmentTitle });
    markDirty();
    closeAssignmentPicker();
}

// ── 0. IN-CONTEXT EDITOR (mounted by teacher/subjects/tabs/lessons.js) ───
const EDITOR_TEMPLATE_URL = new URL('../../../teacher/lessons/lesson-editor.html', import.meta.url).href;
const EDITOR_CSS_URL = new URL('../../css/lesson-editor.css', import.meta.url).href;
const QUILL_CSS_URL = 'https://cdnjs.cloudflare.com/ajax/libs/quill/1.3.7/quill.snow.min.css';
// Canvas engine libraries, vendored (MIT): globals window.Moveable / window.Selecto.
const MOVEABLE_JS_URL = new URL('../../vendor/moveable-0.53.0.min.js', import.meta.url).href;
const SELECTO_JS_URL = new URL('../../vendor/selecto-1.26.3.min.js', import.meta.url).href;
let templatePromise = null;
let mountSeq = 0;              // latest mountLessonEditor() call wins
const assetPromises = new Map();

function loadCss(href) {
    if (assetPromises.has(href)) return assetPromises.get(href);
    const p = new Promise((resolve) => {
        if ([...document.styleSheets].some(s => s.href === href)) return resolve();
        const link = Object.assign(document.createElement('link'), { rel: 'stylesheet', href });
        link.onload = () => resolve();
        link.onerror = () => resolve(); // styling only; never block the editor
        document.head.appendChild(link);
    });
    assetPromises.set(href, p);
    return p;
}

function loadScript(src, readyCheck) {
    if (readyCheck()) return Promise.resolve();
    if (assetPromises.has(src)) return assetPromises.get(src);
    const p = new Promise((resolve, reject) => {
        const s = Object.assign(document.createElement('script'), { src, async: true });
        s.onload = () => resolve();
        s.onerror = () => { assetPromises.delete(src); reject(new Error(`Failed to load ${src}`)); };
        document.head.appendChild(s);
    });
    assetPromises.set(src, p);
    return p;
}

function loadEditorTemplate() {
    if (!templatePromise) {
        templatePromise = fetch(EDITOR_TEMPLATE_URL, { cache: 'no-cache' })
            .then(r => { if (!r.ok) throw new Error(`Editor template HTTP ${r.status}`); return r.text(); })
            .catch(e => { templatePromise = null; throw e; });
    }
    return templatePromise;
}

function loadEditorAssets() {
    return Promise.all([
        loadEditorTemplate(), loadCss(EDITOR_CSS_URL), loadCss(QUILL_CSS_URL),
        loadScript(MOVEABLE_JS_URL, () => typeof window.Moveable !== 'undefined'),
        loadScript(SELECTO_JS_URL, () => typeof window.Selecto !== 'undefined'),
    ]);
}

// Warm the editor's assets (template, CSS, Quill) without mounting — the
// Lessons tab calls this when it first shows, so opening a lesson is instant.
export function preloadLessonEditor() {
    return loadEditorAssets().catch(e => console.warn('[Lesson Builder] preload failed:', e));
}

// Mount the full editor for one lesson inside `container`.
//   opts: { schoolId, classId, subjectId, lessonId, author, onExit,
//           subjectName?, className?, assignments?, onSaved?, onTitleChange? }
// Resolves to { lesson, unmount, isDirty, save }; throws if the lesson can't be opened.
export async function mountLessonEditor(container, opts) {
    const { schoolId, classId, subjectId, lessonId } = opts || {};
    if (!session) throw new Error('Not signed in as a teacher.');
    if (!container || !classId || !subjectId || !lessonId) throw new Error('mountLessonEditor: container, classId, subjectId and lessonId are required.');
    if (opts.draft && opts.draft.id !== lessonId) throw new Error('mountLessonEditor: draft.id must equal lessonId.');
    if (schoolId && schoolId !== session.schoolId) throw new Error('mountLessonEditor: school mismatch.');
    const seq = ++mountSeq;
    if (embedded) await unmountLessonEditor({ force: true });

    const [html] = await loadEditorAssets();
    if (seq !== mountSeq) throw new Error('superseded');
    if (embedded) await unmountLessonEditor({ force: true });
    if (seq !== mountSeq) throw new Error('superseded');

    container.innerHTML = html;
    editorAbort = new AbortController();
    embedded = {
        container,
        onExit: opts.onExit,
        onSaved: opts.onSaved,
        onCreated: opts.onCreated,
        onTitleChange: opts.onTitleChange,
        author: opts.author || null,
    };
    // fresh editor instances for the fresh DOM
    teardownCanvas();
    destroyDocEditor();
    quill = null;
    slideFieldQuills = {};
    Object.keys(els).forEach(k => delete els[k]);
    cacheEls();
    wireEditorEvents();

    currentPostContext = { classId, className: opts.className || '', subjectId, subjectName: opts.subjectName || '' };
    currentSubject = {
        id: subjectId, classId, className: opts.className || '', name: opts.subjectName || '',
        _source: 'new', assignments: Array.isArray(opts.assignments) ? opts.assignments : [],
    };

    const mine = embedded;
    await openBuilder(lessonId, opts.draft || null);
    if (embedded !== mine || seq !== mountSeq) throw new Error('superseded');
    if (!lessonDraft || currentLessonId !== lessonId) {
        await unmountLessonEditor({ force: true });
        throw new Error('This lesson could not be opened.');
    }
    return {
        lesson: { id: currentLessonId, title: lessonDraft.title, format: lessonDraft.format, status: lessonDraft.status, isNew: isNewDraft },
        // only ever tears down THIS mount, never a newer one
        unmount: (o) => (embedded === mine ? unmountLessonEditor(o) : Promise.resolve(true)),
        isDirty: () => hasUnsavedChanges || !!saveInFlight,
        save: () => persistDraft({ silent: false }),
    };
}

// Flush pending edits, then tear the editor down. Resolves false only when a
// save failed and the teacher chose to stay (never with force).
export async function unmountLessonEditor({ force = false } = {}) {
    if (!embedded) return true;
    const mine = embedded;
    endTextEdit({ repaint: false }); // commit an open text edit before deciding what to save
    if (isNewDraft && !saveInFlight) {
        // Never written. Untouched → just drop it. Edited → ask.
        if (hasUnsavedChanges) {
            clearTimeout(autosaveTimer);
            const keep = confirm('This new lesson has not been saved.\n\nOK = Save as Draft\nCancel = Discard');
            if (embedded !== mine) return true;
            if (keep) {
                const ok = await persistDraft({ silent: false });
                if (embedded !== mine) return true;
                if (!ok && !force && !confirm('The lesson could not be saved. Leave anyway and discard it?')) return false;
            }
        }
        hasUnsavedChanges = false;
    } else if (hasUnsavedChanges || saveInFlight) {
        const ok = await persistDraft({ silent: true });
        if (embedded !== mine) return true; // a concurrent unmount/mount already took over
        if (!ok && !force && !confirm('Your latest changes could not be saved. Leave anyway?')) return false;
    }
    if (embedded !== mine) return true;
    clearTimeout(autosaveTimer);
    setFocusMode(false);
    teardownCanvas();
    editorAbort?.abort();
    editorAbort = null;
    document.body.classList.remove('lb-dragging');
    const { container } = embedded;
    embedded = null;
    lessonDraft = null;
    currentLessonId = null;
    hasUnsavedChanges = false;
    isNewDraft = false;
    destroyDocEditor();
    quill = null;
    slideFieldQuills = {};
    Object.keys(els).forEach(k => delete els[k]);
    if (container && container.isConnected) container.innerHTML = '';
    return true;
}

export function isLessonEditorDirty() {
    return !!embedded && (hasUnsavedChanges || !!saveInFlight);
}

// The editor's own "All Lessons" buttons.
async function exitEditor() {
    if (!embedded) { closeBuilder(); return; }
    const onExit = embedded.onExit;
    if (typeof onExit === 'function') onExit();
    else await unmountLessonEditor();
}

if (STANDALONE) init();
