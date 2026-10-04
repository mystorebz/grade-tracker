// ── ENTERPRISE LESSON REDESIGN, PHASE 1: LESSON DECK CRUD (teacher) ───────
// Lessons replace the old flat-text lesson_plan post type with real,
// slide-based decks. Storage mirrors the same nesting depth posts.js and
// submissions.js already use:
//   schools/{schoolId}/classes/{classId}/subjects/{subjectId}/lessons/{lessonId}
// — main doc (title, status, format, slides[]) — plus:
//   .../lessons/{lessonId}/private/notes
// — a SEPARATE document for teacher-only pacingNotes/standards, because
// Firestore security rules can only grant/deny a whole document, never
// individual fields within one (see firestore.rules' own comment on the
// class-level attendance fan-out for the exact same limitation, hit and
// fixed the same way for a different collection). Splitting these into
// their own doc is what lets firestore.rules deny students read access to
// them outright, rather than merely hiding them client-side (which any
// student could bypass with a raw SDK read).
//
// classId/subjectId resolution reuses resolvePostContext() from posts.js
// rather than duplicating it — same subject shape, same legacy-subject
// fallback behavior.
//
// ── DUAL-FORMAT LESSONS (Slide Deck vs. Document) ─────────────────────────
// A lesson now carries a `format: 'slides' | 'document'` field. Both
// formats share the exact same `slides[]` array field on the main doc — a
// Document-format lesson simply always contains exactly one block:
// newSlide('richtext'). This is deliberate: saveLessonContent(),
// publishLesson(), unpublishLesson(), deleteLesson(), and
// subscribeToLesson() below are already format-agnostic (they just
// read/write whatever is in slides[]), so none of them needed any changes
// to support the new format. Only createLesson() (which now takes format)
// and the three read paths (loadLesson/loadLessonsForSubject/
// subscribeToLesson, which normalize a missing/legacy format to 'slides'
// for backward compatibility with lessons created before this feature
// existed) needed real changes.
import { db, functions } from './firebase-init.js';
import { httpsCallable } from "https://www.gstatic.com/firebasejs/10.7.1/firebase-functions.js";
import { collection, doc, getDoc, getDocs, setDoc, updateDoc, deleteDoc, onSnapshot, serverTimestamp, runTransaction, query, where, writeBatch, deleteField }
    from "https://www.gstatic.com/firebasejs/10.7.1/firebase-firestore.js";
import { createPost } from './posts.js';
import { STAGE, SCHEMA_VERSION, v2ToV3Content, v3ToV2Slides, slideFingerprint } from './lessons/canvas/model.js';

export function genLessonId() {
    return 'lsn_' + Date.now().toString(36) + '_' + Math.random().toString(36).slice(2, 6);
}

export function genSlideId() {
    return 'slide_' + Date.now().toString(36) + '_' + Math.random().toString(36).slice(2, 6);
}

export function genSessionId() {
    return 'live_' + Date.now().toString(36) + '_' + Math.random().toString(36).slice(2, 6);
}

export function genBlockId() {
    return 'block_' + Date.now().toString(36) + '_' + Math.random().toString(36).slice(2, 6);
}

function lessonRef(schoolId, postContext, lessonId) {
    const { classId, subjectId } = postContext;
    return doc(db, 'schools', schoolId, 'classes', classId, 'subjects', subjectId, 'lessons', lessonId);
}

// ── SPLIT LESSON MODEL (contentVersion 2) ────────────────────────────────
// lessons/{lessonId}            metadata only: title, format, status, ids,
//                               author, slideCount, timestamps — cheap to list.
// lessons/{lessonId}/content/main   { slides, theme, updatedAt } — the heavy part.
// Pre-split lessons (slides still on the main doc) keep working: every read
// falls back to the main doc's slides/theme when content/main is missing, and
// the first save moves them over (migrations/02-lesson-content.js does it in bulk).
export const LESSON_CONTENT_VERSION = 3;

// ── CANVAS SCHEMA v3 (per-slide documents) ───────────────────────────────
//   content/main        { schemaVersion: 3, stage, theme, slideOrder, updatedAt }
//   slides/{slideId}    one doc per slide (see lessons/canvas/model.js)
//   doc/main            Document-format lessons: { html, blockId, updatedAt }
// The current editor still works on the v2 slide array; this module converts
// at the storage boundary (v3 → v2 on read, v2 → v3 on write), so v2-era
// callers keep working while readers (viewer/presenter) consume v3 natively
// via lesson.v3. Saves only write slide docs whose content actually changed.
function lessonSlidesCollectionRef(schoolId, postContext, lessonId) {
    const { classId, subjectId } = postContext;
    return collection(db, 'schools', schoolId, 'classes', classId, 'subjects', subjectId, 'lessons', lessonId, 'slides');
}
function lessonSlideRef(schoolId, postContext, lessonId, slideId) {
    const { classId, subjectId } = postContext;
    return doc(db, 'schools', schoolId, 'classes', classId, 'subjects', subjectId, 'lessons', lessonId, 'slides', slideId);
}
function lessonDocMainRef(schoolId, postContext, lessonId) {
    const { classId, subjectId } = postContext;
    return doc(db, 'schools', schoolId, 'classes', classId, 'subjects', subjectId, 'lessons', lessonId, 'doc', 'main');
}

// lessonId -> { order: [slideId], prints: Map(slideId -> fingerprint), docPrint: string|null }
// What we last read/wrote, so a save only touches what changed.
const savedV3State = new Map();

function rememberV3(lessonId, conv) {
    savedV3State.set(lessonId, {
        order: [...conv.content.slideOrder],
        prints: new Map(conv.slides.map((s) => [s.id, slideFingerprint(s)])),
        docPrint: conv.doc ? JSON.stringify(conv.doc) : null,
    });
}

async function readV3Parts(schoolId, postContext, lessonId, format) {
    const [slidesSnap, docSnap] = await Promise.all([
        format === 'document' ? Promise.resolve(null) : getDocs(lessonSlidesCollectionRef(schoolId, postContext, lessonId)),
        format === 'document' ? getDoc(lessonDocMainRef(schoolId, postContext, lessonId)) : Promise.resolve(null),
    ]);
    const slidesById = new Map((slidesSnap ? slidesSnap.docs : []).map((d) => {
        const { updatedAt, _mig03, ...rest } = d.data();
        return [d.id, { ...rest, id: d.id }];
    }));
    const docData = docSnap && docSnap.exists() ? (({ updatedAt, _mig03, ...rest }) => rest)(docSnap.data()) : null;
    return { slidesById, doc: docData };
}

// Stage the v3 writes for `slides` (v2 array) onto `batch`. Returns the
// conversion and a commit hook that records the new saved state.
async function stageV3Writes(batch, schoolId, postContext, lessonId, { slides, theme, format, now, fresh = false }) {
    const conv = v2ToV3Content(slides, { theme, format });
    let prev = fresh ? { order: [], prints: new Map(), docPrint: null, hadDoc: false } : savedV3State.get(lessonId);
    if (!prev) {
        // Unknown baseline (first save of a lesson not loaded in this tab): read the stored order.
        const cs = await getDoc(lessonContentRef(schoolId, postContext, lessonId)).catch(() => null);
        const c = cs && cs.exists() ? cs.data() : null;
        prev = { order: c && c.schemaVersion === SCHEMA_VERSION && Array.isArray(c.slideOrder) ? c.slideOrder : [], prints: new Map(), docPrint: null, hadDoc: true };
    }
    let ops = 0;
    for (const s of conv.slides) {
        if (prev.prints.get(s.id) !== slideFingerprint(s)) { batch.set(lessonSlideRef(schoolId, postContext, lessonId, s.id), { ...s, updatedAt: now }); ops++; }
    }
    const keep = new Set(conv.content.slideOrder);
    for (const id of prev.order) {
        if (!keep.has(id)) { batch.delete(lessonSlideRef(schoolId, postContext, lessonId, id)); ops++; }
    }
    if (conv.doc) {
        if (prev.docPrint !== JSON.stringify(conv.doc)) { batch.set(lessonDocMainRef(schoolId, postContext, lessonId), { ...conv.doc, updatedAt: now }); ops++; }
    } else if (prev.docPrint || prev.hadDoc) {
        batch.delete(lessonDocMainRef(schoolId, postContext, lessonId)); ops++;
    }
    // full replace: drops any v2 `slides` array still on content/main
    batch.set(lessonContentRef(schoolId, postContext, lessonId), { ...conv.content, updatedAt: now }); ops++;
    if (ops > 450) throw new Error(`This lesson has too many slides to save in one step (${ops} writes). Split it into two lessons.`);
    return { conv, commit: () => rememberV3(lessonId, conv) };
}

function inferFormat(slides, fallback) {
    if (fallback === 'document' || fallback === 'slides') return fallback;
    return Array.isArray(slides) && slides[0] && slides[0].type === 'richtext' ? 'document' : 'slides';
}

function lessonContentRef(schoolId, postContext, lessonId) {
    const { classId, subjectId } = postContext;
    return doc(db, 'schools', schoolId, 'classes', classId, 'subjects', subjectId, 'lessons', lessonId, 'content', 'main');
}

// Strip the heavy fields from a main-doc snapshot for list views.
function toLessonMeta(id, data) {
    const { slides, theme, ...meta } = data;
    return {
        id, ...meta,
        format: normalizeFormat(data),
        slideCount: Number.isInteger(data.slideCount) ? data.slideCount : (Array.isArray(slides) ? slides.length : 0),
    };
}

// Merge main doc + content doc into the full lesson object every editor/player uses.
function toFullLesson(id, data, content) {
    const slides = content && Array.isArray(content.slides) ? content.slides : data.slides;
    const theme = (content && content.theme) || data.theme || 'general';
    return { id, ...data, theme, format: normalizeFormat(data), slides: normalizeLessonSlides(slides) || [] };
}

function lessonPrivateRef(schoolId, postContext, lessonId) {
    const { classId, subjectId } = postContext;
    return doc(db, 'schools', schoolId, 'classes', classId, 'subjects', subjectId, 'lessons', lessonId, 'private', 'notes');
}

// ── PHASE 3: LIVE SESSION ENGINE ──────────────────────────────────────────
// A live_sessions doc is nested under its own lesson (same nesting depth as
// the lessons/{id}/private doc above), NOT top-level — this keeps its
// firestore.rules block reachable from the same isCallerInSchool/
// isSchoolActive checks already governing lessons/{lessonId}, without a new
// top-level collection needing its own from-scratch rule design. Exactly one
// field on the session doc actually changes during a live session
// (teacherPositionId, written every time the teacher navigates) — the rest
// (activeLessonId, startedAt, endedAt) are set once and read many times, by
// both the teacher dashboard and every connected student's viewer.
//
// `responses` is a SEPARATE subcollection (not an array field on the session
// doc) for the same reason submissions.js keeps grades/submissions as their
// own documents rather than array entries: many students write concurrently,
// and Firestore array-union writes from dozens of clients on one document
// would serialize into a write-contention bottleneck (and blow the 1MB
// document cap on a big class). One response doc per student per block
// keeps every student's write independent and lets the teacher dashboard
// onSnapshot the whole subcollection as one live-updating list.
function liveSessionRef(schoolId, postContext, lessonId, sessionId) {
    const { classId, subjectId } = postContext;
    return doc(db, 'schools', schoolId, 'classes', classId, 'subjects', subjectId, 'lessons', lessonId, 'live_sessions', sessionId);
}

function liveResponsesCollectionRef(schoolId, postContext, lessonId, sessionId) {
    const { classId, subjectId } = postContext;
    return collection(db, 'schools', schoolId, 'classes', classId, 'subjects', subjectId, 'lessons', lessonId, 'live_sessions', sessionId, 'responses');
}

function liveResponseRef(schoolId, postContext, lessonId, sessionId, responseDocId) {
    const { classId, subjectId } = postContext;
    // responseDocId is a composite "{studentId}_{blockId}" id (built by
    // saveLiveResponse() below), not a bare studentId — a student
    // re-submitting the SAME block (e.g. updating their collaborative_board
    // card) overwrites their own prior response rather than accumulating
    // duplicates, exactly like grades/submissions.js's one-doc-per-student
    // model for a single assignment, while still keeping their answers to
    // DIFFERENT blocks in the same session as separate documents.
    return doc(db, 'schools', schoolId, 'classes', classId, 'subjects', subjectId, 'lessons', lessonId, 'live_sessions', sessionId, 'responses', responseDocId);
}

// ── SLIDE / BLOCK TEMPLATES ───────────────────────────────────────────────
// One factory per slide type, so the builder's "add slide" action and any
// future template additions have a single source of truth for a new slide's
// default shape. Every slide always carries id + type; everything else is
// type-specific and always present (even if empty/null) so renderer code
// never has to guess whether a field exists.
export function newSlide(type) {
    const id = genSlideId();
    switch (type) {
        case 'blank':
            // ── SLIDE DECK REDESIGN: generic slide + insertable blocks ──
            // Every Slide Deck slide the builder creates going forward uses
            // THIS shape — no more fixed "kind" of slide chosen up front.
            // What used to be separate slide types (Title/Content/Media/
            // Assignment/Interactive Prompt) are now blocks a teacher
            // inserts from the persistent toolbar at the top of the canvas
            // — see newBlock() just below. collaborative_board (further
            // down in this switch) is the one deliberate exception: it
            // stays a special, distinct whole-slide type, added via its own
            // "Add Collaboration Board" action rather than a toolbar block.
            //
            // The OLD typed cases below ('title'/'content'/'media'/
            // 'assignment'/'interactive_prompt') are kept in this file only
            // as migration TARGETS for migrateLegacySlide() (also just
            // below) and as a safety net for any not-yet-updated call site
            // — no new code should construct them going forward.
            return { id, type: 'blank', blocks: [] };
        case 'title':
            // headingHtml/objectiveHtml: rich-text (Quill) versions of
            // heading/objective, added for Slide Deck toolbar parity with
            // the Document format. heading/objective themselves stay
            // plain-text mirrors — kept in sync by the builder on every
            // edit — because other code (slide-thumb labels, list
            // previews) still expects plain text there. A slide with no
            // *Html value is a legacy slide that predates this field, and
            // every renderer treats that as "fall back to the escaped
            // plain-text value" rather than throwing — see builder.js's
            // wireRichFields() and lessons/live.js + lessons/viewer.js's
            // title-slide renderers.
            return { id, type: 'title', heading: '', subheading: '', objective: '', headingHtml: '', objectiveHtml: '' };
        case 'media':
            // mediaKind picks which of the two sub-modes this slide is in —
            // 'video' (external iframe embed: YouTube/Vimeo/Drive, via
            // provider+embedUrl below) or 'image' (a directly hosted image
            // URL, rendered as a plain <img>, via imageUrl below). Both
            // sub-modes' fields always exist on every media slide (rather
            // than only the active one) so switching kinds in the builder
            // never has to delete/recreate fields — just clears the ones
            // that no longer apply.
            return { id, type: 'media', mediaKind: 'video', heading: '', provider: null, mediaUrl: '', embedUrl: '', imageUrl: '', imageAlt: '', caption: '' };
        case 'assignment':
            return { id, type: 'assignment', heading: '', prompt: '', linkedAssignmentId: null };
        case 'interactive_prompt':
            // Nearpod-style: one question, every student answers privately.
            // promptKind picks the input shape ('short_answer' free-text, or
            // 'multiple_choice' against the choices[] list below) — both
            // fields always exist (same "every field always present"
            // convention newSlide() already follows for 'media' above) so
            // switching kinds in a future builder UI never has to
            // delete/recreate fields, only clear the ones that no longer
            // apply. Live-only: this block does nothing outside an active
            // live_sessions document — see lessons/live.js and
            // lessons/viewer.js's live-session handling.
            return { id, type: 'interactive_prompt', heading: '', promptText: '', promptKind: 'short_answer', choices: [] };
        case 'collaborative_board':
            // Padlet-style: every connected student's submitted card is
            // visible to the whole class in real time (not just the
            // teacher) — the one block type where onSnapshot on `responses`
            // is wired on BOTH sides, not just the teacher dashboard. See
            // lessons/viewer.js's renderCollaborativeBoardLive().
            return { id, type: 'collaborative_board', heading: '', instructions: '' };
        case 'richtext':
            // The single block a Document-format lesson holds (see
            // createLesson() below) — contentHtml is Quill's own sanitized
            // HTML output for the entire flowing document, including any
            // embedded Linked Assignment cards (saved as part of the same
            // HTML string). Kept as one block inside the same slides[]
            // array every other lesson type already uses, rather than a
            // new top-level field, so every existing save/load/publish/
            // delete function below works on a Document lesson completely
            // unchanged.
            return { id, type: 'richtext', contentHtml: '' };
        case 'content':
        default:
            // bodyHtml: rich-text (Quill) version of body — same
            // legacy-fallback convention as headingHtml/objectiveHtml on
            // 'title' above (see that case's comment).
            return { id, type: 'content', heading: '', body: '', bullets: [], bodyHtml: '' };
    }
}

// ── BLOCK TEMPLATES (toolbar-insertable content within a 'blank' slide) ───
// One factory per block type, mirroring newSlide()'s own "id + type always
// present, every field always present (even empty/null)" convention. These
// are what the persistent top toolbar inserts into a slide's blocks[]
// array — Text / Image / Video / Interactive Prompt / Assignment. Field
// shapes intentionally match the old fixed-type slides' own fields
// one-for-one (mediaUrl/embedUrl/provider for video, promptKind/choices for
// interactive_prompt, linkedAssignmentId for assignment) so every existing
// renderer/behavior (parseMediaUrl() below, assignment-gradebook linking,
// live-session prompt mechanics) keeps functioning exactly as it already
// does — only how a block gets ONTO a slide is changing, not what it does
// once there.
//
// FREE-FORM CANVAS: every block also carries x/y/w/h — percentages (0-100)
// of the slide stage's box, not pixels, so a saved layout still makes sense
// at any screen size / on the student-facing viewer's own stage. This is
// what lets a block be dragged and resized anywhere on the slide, PowerPoint/
// Google-Slides style, instead of always flowing top-to-bottom in a fixed
// stack. BLOCK_DEFAULT_SIZE is the starting w/h for a freshly-inserted
// block of each type; x/y default to a small cascade (see builder.js's
// insertBlock()) so several quick inserts don't all land exactly on top of
// one another. ensureBlockLayout() below is what backfills x/y/w/h for a
// block that predates this feature (an already-migrated 'blank' slide
// saved before free-form positioning existed) — every read path runs
// through it via migrateLegacySlide(), so no lesson saved before this
// change loses or overlaps its content the first time it's opened.
export const BLOCK_DEFAULT_SIZE = {
    text: { w: 60, h: 16 },
    image: { w: 50, h: 38 },
    video: { w: 55, h: 34 },
    interactive_prompt: { w: 65, h: 26 },
    assignment: { w: 60, h: 18 }
};

export function newBlock(type, layout) {
    const id = genBlockId();
    const size = BLOCK_DEFAULT_SIZE[type] || BLOCK_DEFAULT_SIZE.text;
    const pos = { x: 12, y: 10, w: size.w, h: size.h, ...(layout || {}) };
    switch (type) {
        case 'image':
            return { id, type: 'image', imageUrl: '', imageAlt: '', caption: '', ...pos };
        case 'video':
            // provider/mediaUrl/embedUrl: same fields/semantics as the old
            // 'media' slide's video sub-mode — populated via
            // parseMediaUrl() below, unchanged (YouTube/Vimeo/Drive only).
            return { id, type: 'video', provider: null, mediaUrl: '', embedUrl: '', caption: '', ...pos };
        case 'interactive_prompt':
            return { id, type: 'interactive_prompt', promptText: '', promptKind: 'short_answer', choices: [], ...pos };
        case 'assignment':
            return { id, type: 'assignment', prompt: '', linkedAssignmentId: null, ...pos };
        case 'text':
        default:
            // html: Quill-produced rich HTML, same convention as the old
            // title/content slides' headingHtml/objectiveHtml/bodyHtml
            // fields — a block with an empty html is just an empty text
            // box, never a legacy/fallback case (blocks are new; there is
            // no plain-text mirror to fall back to).
            return { id, type: 'text', html: '', ...pos };
    }
}

// Backfills x/y/w/h on any block of a 'blank' slide that doesn't already
// have real numbers there — a simple top-to-bottom auto-stack, so a slide
// migrated straight from the old fixed-type schema (or saved by this app
// before free-form positioning existed) still reads top-to-bottom in its
// original order rather than piling every block into the same corner.
// Idempotent and non-destructive: a block that already has a stored
// position is never touched, so once a teacher (or this function, on first
// load) has placed something, that placement sticks.
function ensureBlockLayout(slide) {
    if (!slide || slide.type !== 'blank' || !Array.isArray(slide.blocks)) return slide;
    let cursorY = 6;
    slide.blocks.forEach(block => {
        if (typeof block.x === 'number' && typeof block.y === 'number' && typeof block.w === 'number' && typeof block.h === 'number') {
            return;
        }
        const size = BLOCK_DEFAULT_SIZE[block.type] || BLOCK_DEFAULT_SIZE.text;
        block.x = 8;
        block.w = size.w;
        block.h = size.h;
        block.y = Math.min(cursorY, Math.max(0, 100 - size.h - 2));
        cursorY = block.y + size.h + 3;
    });
    return slide;
}

function escHtmlForMigration(str) {
    if (!str) return '';
    return String(str)
        .replace(/&/g, '&amp;')
        .replace(/</g, '&lt;')
        .replace(/>/g, '&gt;')
        .replace(/"/g, '&quot;')
        .replace(/'/g, '&#39;');
}

// ── LEGACY SLIDE → BLOCKS MIGRATION (applied on READ, never a one-time DB
//    rewrite) ────────────────────────────────────────────────────────────
// Converts a slide saved under the OLD fixed-type Slide Deck schema
// ('title'/'content'/'media'/'assignment'/'interactive_prompt') into the
// new generic { type:'blank', blocks:[...] } shape, using the richest
// available source for each field (an *Html rich-text field before its
// plain-text mirror, itself escaped) exactly like Phase 2's headingHtml/
// objectiveHtml/bodyHtml backward-compat convention. This is idempotent and
// safe to run on every read: an already-new-shape slide, a
// collaborative_board slide, or a Document-format richtext slide all pass
// through UNCHANGED. The lesson doc itself is only ever rewritten in the
// new shape the next time a teacher hits Save (builder.js's
// currentSlidesForSave() only ever emits the new shape) — this function
// never writes anything.
export function migrateLegacySlide(slide) {
    if (!slide || typeof slide !== 'object') return slide;
    // Already new-shape — still runs through ensureBlockLayout() (a
    // 'blank' slide saved before free-form positioning existed has blocks
    // with no x/y/w/h yet), or one of the two whole-slide types that never
    // become blocks and pass through completely untouched.
    if (slide.type === 'blank' && Array.isArray(slide.blocks)) return ensureBlockLayout(slide);
    if (slide.type === 'collaborative_board' || slide.type === 'richtext') return slide;

    const blocks = [];
    switch (slide.type) {
        case 'title':
            if (slide.headingHtml || slide.heading) {
                blocks.push({ id: genBlockId(), type: 'text', html: slide.headingHtml || escHtmlForMigration(slide.heading) });
            }
            if (slide.objectiveHtml || slide.objective) {
                blocks.push({ id: genBlockId(), type: 'text', html: slide.objectiveHtml || escHtmlForMigration(slide.objective) });
            }
            break;
        case 'content':
            if (slide.heading) {
                blocks.push({ id: genBlockId(), type: 'text', html: `<h2>${escHtmlForMigration(slide.heading)}</h2>` });
            }
            if (slide.bodyHtml || slide.body) {
                blocks.push({ id: genBlockId(), type: 'text', html: slide.bodyHtml || escHtmlForMigration(slide.body) });
            }
            break;
        case 'media':
            if (slide.heading) {
                blocks.push({ id: genBlockId(), type: 'text', html: `<h2>${escHtmlForMigration(slide.heading)}</h2>` });
            }
            if (slide.mediaKind === 'image') {
                blocks.push({ id: genBlockId(), type: 'image', imageUrl: slide.imageUrl || '', imageAlt: slide.imageAlt || '', caption: slide.caption || '' });
            } else {
                blocks.push({ id: genBlockId(), type: 'video', provider: slide.provider || null, mediaUrl: slide.mediaUrl || '', embedUrl: slide.embedUrl || '', caption: slide.caption || '' });
            }
            break;
        case 'assignment':
            if (slide.heading) {
                blocks.push({ id: genBlockId(), type: 'text', html: `<h2>${escHtmlForMigration(slide.heading)}</h2>` });
            }
            blocks.push({ id: genBlockId(), type: 'assignment', prompt: slide.prompt || '', linkedAssignmentId: slide.linkedAssignmentId || null });
            break;
        case 'interactive_prompt':
            if (slide.heading) {
                blocks.push({ id: genBlockId(), type: 'text', html: `<h2>${escHtmlForMigration(slide.heading)}</h2>` });
            }
            blocks.push({
                id: genBlockId(),
                type: 'interactive_prompt',
                promptText: slide.promptText || '',
                promptKind: slide.promptKind || 'short_answer',
                choices: Array.isArray(slide.choices) ? slide.choices : []
            });
            break;
        default:
            // Unrecognized legacy type — surface whatever text-ish content
            // it has as a single text block rather than silently dropping
            // the slide's data.
            if (slide.heading || slide.body) {
                blocks.push({ id: genBlockId(), type: 'text', html: slide.bodyHtml || escHtmlForMigration(slide.heading || slide.body || '') });
            }
            break;
    }

    return ensureBlockLayout({ id: slide.id || genSlideId(), type: 'blank', blocks });
}

// Applies migrateLegacySlide() across an entire lesson's slides[] array —
// the single shared entry point every read path funnels through (see
// loadLesson/loadLessonsForSubject/loadPublishedLessonsForSubject/
// subscribeToLesson below, and lessons/viewer.js's own separate getDoc,
// which calls migrateLegacySlide() directly since it doesn't go through
// loadLesson() at all).
export function normalizeLessonSlides(slides) {
    return Array.isArray(slides) ? slides.map(migrateLegacySlide) : slides;
}

// ── YOUTUBE / VIMEO URL → SANITIZED EMBED URL ────────────────────────────
// Zero video storage cost: this only ever produces an <iframe src>, never a
// file upload. Returns { provider, embedUrl } or null if the URL isn't a
// recognized YouTube/Vimeo link — callers should treat null as "show an
// error, don't save a broken embed."
export function parseMediaUrl(rawUrl) {
    const url = (rawUrl || '').trim();
    if (!url) return null;

    // youtu.be/VIDEOID
    let m = url.match(/^https?:\/\/(?:www\.)?youtu\.be\/([\w-]{6,})/i);
    // youtube.com/watch?v=VIDEOID (allow any query-string order/extra params)
    if (!m) m = url.match(/^https?:\/\/(?:www\.)?youtube\.com\/watch\?(?:.*&)?v=([\w-]{6,})/i);
    // youtube.com/embed/VIDEOID (already an embed link — pass through)
    if (!m) m = url.match(/^https?:\/\/(?:www\.)?youtube\.com\/embed\/([\w-]{6,})/i);
    // youtube.com/shorts/VIDEOID
    if (!m) m = url.match(/^https?:\/\/(?:www\.)?youtube\.com\/shorts\/([\w-]{6,})/i);
    if (m) return { provider: 'youtube', embedUrl: `https://www.youtube.com/embed/${m[1]}` };

    // vimeo.com/VIDEOID (numeric)
    m = url.match(/^https?:\/\/(?:www\.)?vimeo\.com\/(\d+)/i);
    if (!m) m = url.match(/^https?:\/\/player\.vimeo\.com\/video\/(\d+)/i);
    if (m) return { provider: 'vimeo', embedUrl: `https://player.vimeo.com/video/${m[1]}` };

    // Google Drive file link (.../file/d/FILEID/view) → its /preview embed form
    m = url.match(/^https?:\/\/drive\.google\.com\/file\/d\/([\w-]+)/i);
    if (m) return { provider: 'drive', embedUrl: `https://drive.google.com/file/d/${m[1]}/preview` };

    return null;
}

// ── IMAGE URL VALIDATION ──────────────────────────────────────────────────
// No upload, no Storage cost — this is a link-only feature, same "zero
// storage cost" principle as parseMediaUrl() above, just for a plain <img>
// instead of an <iframe>. There's no transformation to do (unlike a
// YouTube/Vimeo link, an image URL IS its own src), so this only validates
// that what was pasted looks like a real, directly-loadable image link
// rather than a webpage — catches the easy mistake of pasting a Google
// Images *search result* page or a Drive *view* link (neither of which
// serves raw image bytes) instead of a direct file URL. Returns true/false;
// callers show an error on false rather than silently accepting a broken
// <img src>.
export function isLikelyImageUrl(rawUrl) {
    const url = (rawUrl || '').trim();
    if (!url) return false;
    if (!/^https:\/\//i.test(url)) return false; // http:// images trigger mixed-content warnings/blocks on an https:// page
    // A recognized image file extension, optionally followed by a query
    // string (Google Drive's uc?export=view&id=... and most CDNs append
    // one) — this is a heuristic, not a guarantee the URL truly serves an
    // image, so the caller's <img> still needs its own onerror fallback.
    return /\.(png|jpe?g|gif|webp|svg|avif)(\?.*)?$/i.test(url) ||
           /^https:\/\/drive\.google\.com\/uc\?/i.test(url); // Drive's direct-image export form
}

// Normalizes a raw Firestore lesson doc's format field: any lesson saved
// before this feature existed has no `format` field at all, and should be
// treated exactly like an explicit 'slides' lesson — never crash or show a
// blank builder for old data.
function normalizeFormat(data) {
    return data.format === 'document' ? 'document' : 'slides';
}

// ── READ: one lesson's main document ─────────────────────────────────────
export async function loadLesson(schoolId, postContext, lessonId) {
    const [snap, contentSnap] = await Promise.all([
        getDoc(lessonRef(schoolId, postContext, lessonId)),
        getDoc(lessonContentRef(schoolId, postContext, lessonId)).catch(() => null),
    ]);
    if (!snap.exists()) return null;
    const data = snap.data();
    const content = contentSnap && contentSnap.exists() ? contentSnap.data() : null;
    if (content && content.schemaVersion === SCHEMA_VERSION) {
        const format = normalizeFormat(data);
        const { slidesById, doc: docData } = await readV3Parts(schoolId, postContext, lessonId, format);
        const v2 = v3ToV2Slides({ content, slidesById, doc: docData, format });
        rememberV3(lessonId, v2ToV3Content(v2, { theme: content.theme, format }));
        const full = toFullLesson(snap.id, data, { slides: v2, theme: content.theme });
        full.v3 = { stage: content.stage || { ...STAGE }, theme: content.theme || 'general', slideOrder: content.slideOrder || [], slidesById, doc: docData };
        return full;
    }
    return toFullLesson(snap.id, data, content);
}

// ── READ: this teacher-only private doc (pacingNotes/standards) ─────────
// Callers must be teacher/admin — firestore.rules denies this path to
// students outright, so a student-context call here simply fails/returns
// permission-denied rather than an empty object; this module doesn't need
// its own role check on top of that, the backend already enforces it.
export async function loadLessonPrivateNotes(schoolId, postContext, lessonId) {
    const snap = await getDoc(lessonPrivateRef(schoolId, postContext, lessonId));
    return snap.exists() ? snap.data() : { pacingNotes: '', standards: [] };
}

// ── READ: every lesson for one subject (teacher builder's lesson list) ───
export async function loadLessonsForSubject(schoolId, postContext) {
    const { classId, subjectId } = postContext;
    const snap = await getDocs(collection(db, 'schools', schoolId, 'classes', classId, 'subjects', subjectId, 'lessons'));
    const lessons = snap.docs.map(d => toLessonMeta(d.id, d.data()));
    lessons.sort((a, b) => new Date(b.updatedAt || 0) - new Date(a.updatedAt || 0));
    return lessons;
}

// ── READ: every PUBLISHED lesson for one subject (student-safe) ──────────
// NOT a convenience wrapper around loadLessonsForSubject() — the
// where('status','==','published') filter here is load-bearing for
// permissions, not just a data preference. firestore.rules' own read rule
// for lessons is:
//   isCallerInSchool(schoolId) && isSchoolActive(schoolId) &&
//   (role in ['teacher','super_admin','sub_admin'] || resource.data.status == 'published')
// For a teacher/admin caller the role branch is true independent of any
// document's own data, so loadLessonsForSubject()'s plain unfiltered
// getDocs() already resolves that OR uniformly true and lists fine (as
// teacher/lessons/builder.js's already-established, working list proves).
// For a STUDENT caller the role branch is false for every document, so the
// rule's truth value collapses entirely onto resource.data.status —  a
// genuinely per-document condition. Per Firestore's query-rule model (the
// same "list requires the query to itself prove the rule, or Firestore
// denies the whole request" rule this codebase already hit and fixed for
// the grades collection-group query and exam_submissions), an unfiltered
// list would be REJECTED OUTRIGHT for a student the moment even one draft
// lesson exists alongside a published one in that subject — not just have
// the draft silently omitted. This filter is what makes the query
// provable: every document Firestore could return already satisfies
// resource.data.status == 'published', matching the rule's own branch
// exactly.
export async function loadPublishedLessonsForSubject(schoolId, postContext) {
    const { classId, subjectId } = postContext;
    const snap = await getDocs(query(
        collection(db, 'schools', schoolId, 'classes', classId, 'subjects', subjectId, 'lessons'),
        where('status', '==', 'published')
    ));
    const lessons = snap.docs.map(d => toLessonMeta(d.id, d.data()));
    lessons.sort((a, b) => new Date(b.updatedAt || 0) - new Date(a.updatedAt || 0));
    return lessons;
}

// ── READ: every published lesson across MULTIPLE subjects (student hub) ──
// Mirrors posts.js's own loadPostsForSubjects() exactly: one read per
// subject in parallel, a per-subject try/catch so one bad subject can't
// blank the whole merged list, and a newest-first merge by updatedAt.
// Built on loadPublishedLessonsForSubject() above, NOT the plain
// loadLessonsForSubject() the teacher builder uses — see that function's
// own comment for why an unfiltered read is actually unsafe (denied
// outright, not merely showing extra drafts) for a student caller.
export async function loadLessonsForSubjects(schoolId, postContexts) {
    const perSubject = await Promise.all(
        postContexts.map(ctx => loadPublishedLessonsForSubject(schoolId, ctx).catch(e => {
            console.error(`[loadLessonsForSubjects] failed for subject ${ctx.subjectId}:`, e);
            return [];
        }))
    );
    const lessons = perSubject.flat();
    lessons.sort((a, b) => new Date(b.updatedAt || 0) - new Date(a.updatedAt || 0));
    return lessons;
}

// ── WRITE: create a new lesson (always starts as a draft) ────────────────
// authorContext: { authorId, authorName } — same shape posts.js's
// createPost() already takes. format: 'slides' | 'document' — defaults to
// 'slides' for any caller that doesn't pass one (keeps this function
// backward-compatible with any future call site that forgets the option).
export async function createLesson(schoolId, postContext, authorContext, { title, format }) {
    const lesson = buildNewLesson(schoolId, postContext, authorContext, { title, format });
    return insertLesson(schoolId, postContext, lesson);
}

// ── LOCAL DRAFT (no Firestore write) ─────────────────────────────────────
// "New Lesson" builds the lesson in memory only (isNew: true). Nothing is
// written until the teacher saves, publishes, or an autosave fires after a
// real edit — see insertLesson() and builder.js persistDraft(). Returns the
// same full shape loadLesson() does, with a client-generated id.
export function buildNewLesson(schoolId, postContext, authorContext, { title, format } = {}) {
    const { classId, className, subjectId, subjectName } = postContext;
    const id = genLessonId();
    const now = new Date().toISOString();
    const resolvedFormat = format === 'document' ? 'document' : 'slides';

    // A brand-new Slide Deck lesson starts on a Title Slide — Title +
    // Subtitle placeholder text boxes — matching how Google Slides' own
    // "Untitled presentation" always opens, per Justine's explicit request.
    // This is deliberately the same arrangement as builder.js's
    // SLIDE_LAYOUTS.title (the "Title Slide" entry in the "Add Slide"
    // layout gallery); it's just applied automatically here as the
    // starting point instead of requiring the teacher to pick it.
    //
    // `role`/`placeholder` (not `html`) are what carry "Click to add
    // title"/"Click to add subtitle" — a REAL Quill placeholder (see
    // wireBlockRichFields() in builder.js), not literal saved text. html
    // stays '' until the teacher actually types something. This matters:
    // the old approach embedded the placeholder words as real HTML
    // content, which meant an untouched slide would show the literal text
    // "Click to add title" to students in the live session and viewer —
    // role/placeholder can never leak that way, because live.js/viewer.js
    // simply render nothing for an empty html field, exactly like a real
    // empty text box.
    const firstSlideDeckSlide = newSlide('blank');
    const titleBlock = newBlock('text', { x: 10, y: 36, w: 80, h: 16 });
    titleBlock.role = 'title';
    titleBlock.placeholder = 'Click to add title';
    const subtitleBlock = newBlock('text', { x: 15, y: 54, w: 70, h: 12 });
    subtitleBlock.role = 'subtitle';
    subtitleBlock.placeholder = 'Click to add subtitle';
    firstSlideDeckSlide.blocks.push(titleBlock, subtitleBlock);

    const slides = resolvedFormat === 'document' ? [newSlide('richtext')] : [firstSlideDeckSlide];
    const lesson = {
        title: (title || '').trim() || 'Untitled Lesson',
        format: resolvedFormat,
        status: 'draft',
        schoolId, classId, className,
        subjectId, subjectName,
        authorId: authorContext.authorId,
        authorName: authorContext.authorName,
        slides,
        // Slide Deck visual theme (accent color/icon — see builder.js's
        // THEMES config and its "Theme" button). Document lessons have no
        // canvas to theme, so this is meaningless there but harmless to
        // always include — one less format-specific branch for every
        // caller to worry about. A lesson saved before this field existed
        // has none; every reader treats a missing/unknown theme as
        // 'general' rather than throwing (see builder.js's THEMES lookup).
        theme: 'general',
        createdAt: now,
        updatedAt: now,
        publishedAt: null
    };

    return { id, ...lesson, slideCount: slides.length, contentVersion: LESSON_CONTENT_VERSION, isNew: true };
}

// First write of a lesson (local draft → Firestore). Split write: metadata on
// the lesson doc, slides/theme in content/main, one atomic batch. `lesson` is
// a buildNewLesson() object, possibly edited (title/slides/theme).
export async function insertLesson(schoolId, postContext, lesson) {
    const now = new Date().toISOString();
    const { id, isNew: _isNew, slides, theme, slideCount: _sc, contentVersion: _cv, v3: _v3, ...rest } = lesson;
    const safeSlides = Array.isArray(slides) ? slides : [];
    const meta = {
        ...rest,
        title: (rest.title || '').trim() || 'Untitled Lesson',
        slideCount: safeSlides.length,
        contentVersion: LESSON_CONTENT_VERSION,
        createdAt: rest.createdAt || now,
        updatedAt: now,
    };
    const batch = writeBatch(db);
    batch.set(lessonRef(schoolId, postContext, id), meta);
    const staged = await stageV3Writes(batch, schoolId, postContext, id, {
        slides: safeSlides, theme: theme || 'general', format: inferFormat(safeSlides, rest.format), now, fresh: true,
    });
    await batch.commit();
    staged.commit();
    return { id, ...meta, slides: safeSlides, theme: theme || 'general' };
}

// ── WRITE: save the main lesson doc (title, slides, status) ──────────────
// Does NOT touch status/publishedAt — use publishLesson()/unpublishLesson()
// for those, so "Save" (draft editing) and "Publish" (the one-way action
// that also fires the Class Stream announcement) can never be confused
// with each other at the call site. Format-agnostic: works identically for
// a Slides lesson's array of blocks or a Document lesson's single richtext
// block — the caller (builder.js's currentSlidesForSave()) is what decides
// what `slides` actually contains before calling this.
export async function saveLessonContent(schoolId, postContext, lessonId, { title, slides, theme }) {
    const now = new Date().toISOString();
    const meta = {
        title: (title || '').trim() || 'Untitled Lesson',
        slideCount: Array.isArray(slides) ? slides.length : 0,
        contentVersion: LESSON_CONTENT_VERSION,
        updatedAt: now,
        // move any pre-split heavy fields off the main doc
        slides: deleteField(),
        theme: deleteField(),
    };
    const batch = writeBatch(db);
    // theme is optional for some callers (a Document save); keep the stored one then
    let effectiveTheme = theme;
    if (!effectiveTheme) {
        const cs = await getDoc(lessonContentRef(schoolId, postContext, lessonId)).catch(() => null);
        effectiveTheme = (cs && cs.exists() && cs.data().theme) || 'general';
    }
    const staged = await stageV3Writes(batch, schoolId, postContext, lessonId, {
        slides, theme: effectiveTheme, format: inferFormat(slides), now, fresh: false,
    });
    batch.update(lessonRef(schoolId, postContext, lessonId), meta);
    await batch.commit();
    staged.commit();
    return { title: meta.title, slides, theme: effectiveTheme, slideCount: meta.slideCount, updatedAt: now };
}

// ── WRITE: teacher-only pacing notes / standards ─────────────────────────
export async function saveLessonPrivateNotes(schoolId, postContext, lessonId, { pacingNotes, standards }) {
    const record = {
        pacingNotes: (pacingNotes || '').trim(),
        standards: Array.isArray(standards) ? standards.filter(Boolean) : []
    };
    await setDoc(lessonPrivateRef(schoolId, postContext, lessonId), record);
    return record;
}

// ── PUBLISH: flip status, stamp publishedAt, and auto-post to Class Stream ─
// The lightweight Stream announcement is a real post (posts.js's own
// createPost()) carrying a linkedLessonId so the student-side stream card
// can render a "View Lesson" link straight into the (not-yet-built) student
// viewer, instead of duplicating the lesson's content into the post body.
// This is the one and only place a lesson's publish action and its Stream
// announcement are wired together — the Student Viewer itself never needs
// to know posts.js exists. Format-agnostic, same reasoning as
// saveLessonContent() above.
export async function publishLesson(schoolId, postContext, lessonId, lesson, authorContext) {
    const now = new Date().toISOString();
    await updateDoc(lessonRef(schoolId, postContext, lessonId), {
        status: 'published',
        publishedAt: now,
        updatedAt: now
    });

    const post = await createPost(schoolId, postContext, authorContext, {
        type: 'announcement',
        title: `New Lesson: ${lesson.title || 'Untitled Lesson'}`,
        body: 'A new interactive lesson has been posted. Tap to view it.',
        pinned: false
    });
    // linkedLessonId isn't part of createPost()'s own known fields, so it's
    // patched on right after create rather than widening that shared
    // function's signature for one caller — the Stream UI (and eventually
    // the Student Viewer's "came from a post" entry point) only needs this
    // field to exist on lesson-originated posts, never on plain ones.
    await updateDoc(doc(db, 'schools', schoolId, 'classes', postContext.classId, 'subjects', postContext.subjectId, 'posts', post.id),
        { linkedLessonId: lessonId });

    return { status: 'published', publishedAt: now, postId: post.id };
}

// ── UNPUBLISH: revert to draft (does not retract/delete the Stream post) ──
// Deliberately leaves any already-created announcement post alone — a
// teacher pulling a lesson back to draft to keep editing shouldn't also
// silently delete something students may have already seen in their
// stream; that would need its own explicit "retract" action if ever asked
// for, not an implicit side effect of unpublishing.
export async function unpublishLesson(schoolId, postContext, lessonId) {
    const now = new Date().toISOString();
    await updateDoc(lessonRef(schoolId, postContext, lessonId), { status: 'draft', updatedAt: now });
    return { status: 'draft', updatedAt: now };
}

export async function deleteLesson(schoolId, postContext, lessonId) {
    // Firestore does not cascade-delete subcollections — the private/notes
    // doc is removed explicitly first so a deleted lesson doesn't leave an
    // orphaned teacher-notes document behind with nothing pointing at it.
    try {
        await deleteDoc(lessonPrivateRef(schoolId, postContext, lessonId));
    } catch (e) {
        // Most likely cause: no private notes doc was ever created for this
        // lesson (teacher never added pacing notes/standards) — nothing to
        // clean up, so this is expected and not worth failing the whole
        // delete over.
        console.warn('[Lessons] deleteLesson: no private notes doc to remove (or it failed):', e);
    }
    const slidesSnap = await getDocs(lessonSlidesCollectionRef(schoolId, postContext, lessonId)).catch(() => null);
    const batch = writeBatch(db);
    (slidesSnap ? slidesSnap.docs : []).forEach((d) => batch.delete(d.ref));
    batch.delete(lessonDocMainRef(schoolId, postContext, lessonId));
    batch.delete(lessonContentRef(schoolId, postContext, lessonId));
    batch.delete(lessonRef(schoolId, postContext, lessonId));
    await batch.commit();
    savedV3State.delete(lessonId);
    await pruneLessonQuizKeys(schoolId, postContext, lessonId); // its quiz answer keys go too
}

// ── LIVE: one lesson's main doc, for the builder to reflect concurrent
//         edits (e.g. the teacher has this lesson open in two tabs) ──────
// Mirrors posts.js's subscribeToPostsForSubjects() cleanup contract exactly:
// returns an unsubscribe function the caller MUST invoke when done.
export function subscribeToLesson(schoolId, postContext, lessonId, onChange) {
    // Two listeners (metadata + content/main), merged. Emits once both have
    // reported at least once; a missing content doc means a pre-split lesson.
    let meta = null, content = null, metaSeen = false, contentSeen = false;
    let seq = 0;
    const emit = async () => {
        if (!(metaSeen && contentSeen && meta)) return;
        if (content && content.schemaVersion === SCHEMA_VERSION) {
            const mine = ++seq;
            const format = normalizeFormat(meta);
            const { slidesById, doc: docData } = await readV3Parts(schoolId, postContext, lessonId, format);
            if (mine !== seq) return;
            const full = toFullLesson(lessonId, meta, { slides: v3ToV2Slides({ content, slidesById, doc: docData, format }), theme: content.theme });
            full.v3 = { stage: content.stage || { ...STAGE }, theme: content.theme || 'general', slideOrder: content.slideOrder || [], slidesById, doc: docData };
            onChange(full);
            return;
        }
        onChange(toFullLesson(lessonId, meta, content));
    };
    const onErr = (what) => (error) => {
        console.error(`[Lessons] subscribeToLesson (${what}) failed for ${lessonId}:`, error);
        if (what === 'content') { contentSeen = true; content = null; emit(); }
    };
    const unsubMeta = onSnapshot(lessonRef(schoolId, postContext, lessonId), (snap) => {
        metaSeen = true;
        meta = snap.exists() ? snap.data() : null;
        emit();
    }, onErr('meta'));
    const unsubContent = onSnapshot(lessonContentRef(schoolId, postContext, lessonId), (snap) => {
        contentSeen = true;
        content = snap.exists() ? snap.data() : null;
        emit();
    }, onErr('content'));
    return () => { unsubMeta(); unsubContent(); };
}

// ── PHASE 3: LIVE SESSION ENGINE — CRUD ──────────────────────────────────

// SESSION LIFECYCLE: every Go Live gets its own live_sessions/{autoId} doc,
// so a new session always starts with an empty responses subcollection.
// live_sessions/current is only a POINTER ({ sessionId, live }) that the
// teacher dashboard transacts on (two tabs / a double click still resume one
// session instead of starting two) and that student viewers listen to, so a
// session starting, ending or restarting reaches them without a reload.
// The pointer's endedAt is a non-null marker on purpose: firestore.rules
// (responses need endedAt == null) and submitLessonQuizAnswer (rejects a
// truthy endedAt) both refuse answers written under the pointer itself.
const LIVE_POINTER_ID = 'current';
const POINTER_MARK = 'pointer';

function pointerSessionId(data) {
    if (!data) return null;
    if (data.endedAt === POINTER_MARK) return data.live && data.sessionId ? data.sessionId : null;
    return data.endedAt ? null : LIVE_POINTER_ID; // legacy single 'current' session doc
}

export async function startLiveSession(schoolId, postContext, lessonId, authorContext) {
    const pointerRef = liveSessionRef(schoolId, postContext, lessonId, LIVE_POINTER_ID);
    const { classId, subjectId } = postContext;
    const sessionsCol = collection(db, 'schools', schoolId, 'classes', classId, 'subjects', subjectId, 'lessons', lessonId, 'live_sessions');
    const now = new Date().toISOString();

    return runTransaction(db, async (tx) => {
        const pointer = await tx.get(pointerRef);
        const activeId = pointerSessionId(pointer.exists() ? pointer.data() : null);
        if (activeId) {
            const activeSnap = activeId === LIVE_POINTER_ID ? pointer : await tx.get(liveSessionRef(schoolId, postContext, lessonId, activeId));
            if (activeSnap.exists() && !activeSnap.data().endedAt) return { id: activeId, ...activeSnap.data(), resumed: true };
        }
        const newRef = doc(sessionsCol);
        const session = {
            activeLessonId: lessonId,
            teacherPositionId: null, // set by live.js once it knows the first block id
            startedAt: now,
            startedBy: authorContext?.authorId || null,
            endedAt: null,
        };
        tx.set(newRef, session);
        tx.set(pointerRef, { sessionId: newRef.id, live: true, startedAt: now, updatedAt: now, endedAt: POINTER_MARK });
        return { id: newRef.id, ...session, resumed: false };
    });
}

// Ends a live session: the session doc keeps its responses (teachers review
// them afterwards) and the pointer flips to not-live, so viewers lock at once.
// extra: more session fields written with the end (live.js passes
// revealedAnswers — the quiz keys, shown to students once answering is over).
export async function endLiveSession(schoolId, postContext, lessonId, sessionId, extra = {}) {
    const now = new Date().toISOString();
    const pointerRef = liveSessionRef(schoolId, postContext, lessonId, LIVE_POINTER_ID);
    const sessionRef = liveSessionRef(schoolId, postContext, lessonId, sessionId);
    await runTransaction(db, async (tx) => {
        const pointer = sessionId === LIVE_POINTER_ID ? null : await tx.get(pointerRef);
        tx.update(sessionRef, { ...extra, endedAt: now });
        if (pointer && pointer.exists() && pointer.data().sessionId === sessionId) {
            tx.update(pointerRef, { live: false, updatedAt: now });
        }
    });
    return { endedAt: now };
}

// Teacher navigation — the one field that changes on every slide/scroll
// step during a live session. Called frequently (every navigation), so this
// stays a single-field updateDoc rather than a full document rewrite.
export async function updateLiveSessionPosition(schoolId, postContext, lessonId, sessionId, teacherPositionId) {
    await updateDoc(liveSessionRef(schoolId, postContext, lessonId, sessionId), { teacherPositionId });
}

// The lesson's currently-active session (or null), via the pointer.
// The most recent session of this lesson, live or ended (null if none ever ran)
// — the student viewer shows students their answers from it afterwards.
export async function getLastLiveSessionId(schoolId, postContext, lessonId) {
    const pointer = await getDoc(liveSessionRef(schoolId, postContext, lessonId, LIVE_POINTER_ID));
    if (!pointer.exists()) return null;
    const d = pointer.data();
    if (d.endedAt === POINTER_MARK) return d.sessionId || null;
    return LIVE_POINTER_ID; // legacy single 'current' session doc
}

export async function getActiveLiveSession(schoolId, postContext, lessonId) {
    const pointer = await getDoc(liveSessionRef(schoolId, postContext, lessonId, LIVE_POINTER_ID));
    const id = pointerSessionId(pointer.exists() ? pointer.data() : null);
    if (!id) return null;
    const snap = id === LIVE_POINTER_ID ? pointer : await getDoc(liveSessionRef(schoolId, postContext, lessonId, id));
    if (!snap.exists() || snap.data().endedAt) return null;
    return { id, ...snap.data() };
}

// Real-time: onChange(sessionId | null) whenever the lesson goes live, ends,
// or restarts with a new session. Returns the unsubscribe function.
export function subscribeToActiveLiveSession(schoolId, postContext, lessonId, onChange) {
    let last;
    return onSnapshot(liveSessionRef(schoolId, postContext, lessonId, LIVE_POINTER_ID), (snap) => {
        const id = pointerSessionId(snap.exists() ? snap.data() : null);
        if (id !== last) { last = id; onChange(id); }
    }, (error) => {
        console.error('[Lessons] subscribeToActiveLiveSession failed:', error);
    });
}

// LIVE: the session document itself — teacherPositionId (drives student
// auto-follow) and endedAt (drives "session ended" banners on both sides).
// Returns an unsubscribe function the caller MUST invoke when done — same
// cleanup contract as subscribeToLesson() above and
// teacher/exams/live.js's own listeners.
export function subscribeToLiveSession(schoolId, postContext, lessonId, sessionId, onChange) {
    return onSnapshot(liveSessionRef(schoolId, postContext, lessonId, sessionId), (snap) => {
        if (snap.exists()) onChange({ id: snap.id, ...snap.data() });
    }, (error) => {
        console.error(`[Lessons] subscribeToLiveSession failed for ${sessionId}:`, error);
    });
}

// LIVE: every response for one session, keyed by "{studentId}_{blockId}" doc
// ids (see saveLiveResponse below) — used by both the teacher dashboard
// (every student's answers, for the block currently in view) and, for
// collaborative_board blocks only, every connected student (everyone's
// cards, rendered as a shared wall). Returns an unsubscribe function; MUST
// be re-registered (old one unsubscribed first) whenever the teacher
// navigates to a different block — see live.js's onTeacherPositionChange().
//
// callerRole ('teacher' | 'student') decides the query SHAPE, not just what
// the caller is allowed to see. firestore.rules' own `allow list` rule on
// this path is:
//   allow list: if request.auth != null &&
//                  resource.data.schoolId == request.auth.token.schoolId && (
//                    request.auth.token.role in ['teacher', ...] ||
//                    resource.data.blockType == 'collaborative_board'
//                  );
// Firestore requires a list/collection query's rule to be provable from the
// QUERY DEFINITION alone, before any data is read. A first pass (found via
// live end-to-end testing) only filtered the STUDENT query on blockType,
// reasoning that the teacher/admin branch is purely role-based (read from
// the caller's token, not resource.data) and therefore needs no query
// constraint. That reasoning was wrong and was caught by a second live test:
// even for a teacher caller, an otherwise-unfiltered query still failed with
// "Missing or insufficient permissions" — confirmed directly via a raw
// getDocs() with a freshly re-authenticated, verified teacher token, and
// confirmed fixed by adding where('schoolId', '==', schoolId) alone (no
// blockType filter needed for teacher). The reason: the rule's leading
// condition — resource.data.schoolId == request.auth.token.schoolId — is
// ANDed onto BOTH branches of the role/blockType OR, so it constrains every
// caller's query, teacher included, not just the student branch's OR
// operand. An unfiltered query can't be proven to only ever touch documents
// matching that schoolId condition, so Firestore rejects it outright
// regardless of which OR branch a given caller would actually satisfy.
// Every caller therefore needs at least a schoolId filter; a student
// additionally needs the blockType filter for their own OR branch to be
// provable.
// sharedType: which class-visible blockType a STUDENT lists — 'collaborative_board'
// (whole-slide board) or 'board' (sticky-note board widget). firestore.rules
// only lets students list those two types, and the query must filter on it.
export function subscribeToLiveResponses(schoolId, postContext, lessonId, sessionId, onChange, callerRole, sharedType = 'collaborative_board') {
    const baseRef = liveResponsesCollectionRef(schoolId, postContext, lessonId, sessionId);
    const ref = callerRole === 'student'
        ? query(baseRef, where('schoolId', '==', schoolId), where('blockType', '==', sharedType === 'board' ? 'board' : 'collaborative_board'))
        : query(baseRef, where('schoolId', '==', schoolId));
    return onSnapshot(ref, (snap) => {
        const responses = snap.docs.map(d => ({ id: d.id, ...d.data() }));
        onChange(responses);
    }, (error) => {
        console.error(`[Lessons] subscribeToLiveResponses failed for session ${sessionId}:`, error);
    });
}

// WRITE: a student's answer to one interactive_prompt or collaborative_board
// block. Doc id is "{studentId}_{blockId}" (not a bare studentId) so the
// same student can hold one live response PER BLOCK across a session that
// touches several interactive blocks, while still overwriting their own
// prior answer to the SAME block on resubmission (setDoc, not addDoc) rather
// than accumulating duplicate cards on a collaborative board every time a
// student edits their answer. schoolId is denormalized onto the record
// itself (never used for authorization on this doc's own per-document rule,
// which already has schoolId from the caller's token — but REQUIRED for
// firestore.rules' top-level responses collection-group rule, which backs
// the teacher dashboard's onSnapshot(collection(...)) listener across every
// student's response at once; see that rule's own comment for why a
// collection-group list rule can't use get() and must read this field
// straight off each document instead — exactly the same reason
// exam_submissions carries the same two fields).
//
// blockType is ALSO denormalized here — added after live testing surfaced a
// real privacy gap: collaborative_board answers are meant to be visible to
// the whole class (a shared wall), but interactive_prompt answers are
// explicitly private, Nearpod-style, never shown to classmates. A single
// same-school student grant on the responses collection-group list rule
// would leak every student's private prompt answers to the whole class if
// it didn't have some field to tell the two block types apart WITHOUT a
// get() lookup (collection-group list rules can't use get(), same
// constraint as schoolId above) — blockType is that field, checked directly
// in firestore.rules rather than trusted to client-side rendering choices
// alone (viewer.js's own choice to simply not render the prompt wall was
// never a real security boundary on its own).
// choiceIds: poll widgets (option ids). Quiz widgets never come through here —
// they are graded server-side (submitLessonQuizAnswer below).
export async function saveLiveResponse(schoolId, postContext, lessonId, sessionId, studentId, studentName, blockId, blockType, { answerText, choiceIds } = {}) {
    const now = new Date().toISOString();
    const record = {
        schoolId,
        studentId,
        studentName: String(studentName || ''),
        blockId,
        blockType,
        // firestore.rules caps: board notes 280 chars, other answers 4000
        answerText: String(answerText || '').trim().slice(0, blockType === 'board' ? 280 : 4000),
        submittedAt: now
    };
    if (Array.isArray(choiceIds)) record.choiceIds = choiceIds.slice(0, 20).map(String);
    await setDoc(liveResponseRef(schoolId, postContext, lessonId, sessionId, `${studentId}_${blockId}`), record);
    return record;
}


// ── PHASE 4 STEP 4: canvas widgets ─────────────────────────────────────────
// Spotlight one open-response answer on every student screen (teacher only —
// the live session doc is teacher-writable). null clears it. Anonymous: the
// session doc is readable by the whole class, so no student id / name / doc
// id goes on it — only the widget id and the answer text.
export async function setLiveSpotlight(schoolId, postContext, lessonId, sessionId, spotlight) {
    await updateDoc(liveSessionRef(schoolId, postContext, lessonId, sessionId), {
        spotlight: spotlight ? {
            objectId: String(spotlight.objectId),
            text: String(spotlight.text || '').slice(0, 2000), at: new Date().toISOString(),
        } : null,
    });
}

// ── Live activities (questions asked during a session; live-activity.js) ──
// activities[] keeps everything asked this session; activityId is the open one.
export async function openLiveActivity(schoolId, postContext, lessonId, sessionId, activity) {
    const ref = liveSessionRef(schoolId, postContext, lessonId, sessionId);
    await runTransaction(db, async (tx) => {
        const snap = await tx.get(ref);
        if (!snap.exists()) throw new Error('The live session was not found.');
        const data = snap.data();
        if (data.endedAt) throw new Error('This live session has ended.');
        const rec = { id: String(activity.id), type: String(activity.type), props: activity.props || {}, openedAt: new Date().toISOString() };
        if (activity.slideId && typeof activity.x === 'number') {
            Object.assign(rec, { slideId: String(activity.slideId), x: activity.x, y: activity.y, w: activity.w, h: activity.h, z: String(activity.z || 'zz') });
        }
        const list = (Array.isArray(data.activities) ? data.activities : []).filter((a) => a && a.id !== rec.id);
        list.push(rec);
        tx.update(ref, { activities: list.slice(-40), activityId: rec.id });
    });
}

export async function closeLiveActivity(schoolId, postContext, lessonId, sessionId) {
    await updateDoc(liveSessionRef(schoolId, postContext, lessonId, sessionId), { activityId: null });
}

// Quiz answer keys: work_answer_keys/{lessonId}_{objectId}. Staff-only
// (firestore.rules); students never read this collection — the
// submitLessonQuizAnswer Cloud Function grades with the Admin SDK.
export function quizKeyId(lessonId, objectId) { return `${lessonId}_${objectId}`; }

export async function saveQuizKey(schoolId, lessonId, objectId, correctIds) {
    await setDoc(doc(db, 'work_answer_keys', quizKeyId(lessonId, objectId)), {
        kind: 'lesson_quiz', schoolId, lessonId, objectId,
        correct: (correctIds || []).map(String),
        updatedAt: new Date().toISOString(),
    });
}

export async function loadQuizKey(lessonId, objectId) {
    try {
        const snap = await getDoc(doc(db, 'work_answer_keys', quizKeyId(lessonId, objectId)));
        return snap.exists() ? (snap.data().correct || []) : [];
    } catch (e) {
        return []; // not created yet (a get on a missing doc is still allowed) or no access
    }
}

// ── Worksheet answers (activities inside a Document lesson) ───────────────
// No live session: lessons/{lessonId}/responses/{studentId}_{objectId}, same
// record shape and the same firestore.rules checks as live answers (own id +
// real name, enrolled, size caps, one poll vote / quiz attempt), but gated on
// the lesson being published instead of a session being open. Quiz answers go
// through submitLessonQuizAnswer without a sessionId.
function lessonResponseRef(schoolId, postContext, lessonId, responseId) {
    const { classId, subjectId } = postContext;
    return doc(db, 'schools', schoolId, 'classes', classId, 'subjects', subjectId, 'lessons', lessonId, 'responses', responseId);
}

export async function saveLessonResponse(schoolId, postContext, lessonId, studentId, studentName, blockId, blockType, { answerText, choiceIds } = {}) {
    const record = {
        schoolId, studentId, studentName: String(studentName || ''), blockId, blockType,
        answerText: String(answerText || '').trim().slice(0, blockType === 'board' ? 280 : 4000),
        submittedAt: new Date().toISOString(),
    };
    if (Array.isArray(choiceIds)) record.choiceIds = choiceIds.slice(0, 20).map(String);
    await setDoc(lessonResponseRef(schoolId, postContext, lessonId, `${studentId}_${blockId}`), record);
    return record;
}

export async function loadMyLessonResponse(schoolId, postContext, lessonId, studentId, blockId) {
    try {
        const snap = await getDoc(lessonResponseRef(schoolId, postContext, lessonId, `${studentId}_${blockId}`));
        return snap.exists() ? { id: snap.id, ...snap.data() } : null;
    } catch (e) {
        return null;
    }
}

// Shared sticky notes of a document lesson (students: board notes only).
export function subscribeToLessonBoardNotes(schoolId, postContext, lessonId, onChange) {
    const { classId, subjectId } = postContext;
    const q = query(collection(db, 'schools', schoolId, 'classes', classId, 'subjects', subjectId, 'lessons', lessonId, 'responses'),
        where('schoolId', '==', schoolId), where('blockType', '==', 'board'));
    return onSnapshot(q, (snap) => onChange(snap.docs.map(d => ({ id: d.id, ...d.data() }))),
        (error) => console.error('[Lessons] subscribeToLessonBoardNotes failed:', error));
}

// Deletes this lesson's answer keys whose quiz is no longer in its SAVED
// content (students and teachers can't delete keys directly — firestore.rules).
// → [{ objectId, correct }] for the keys removed. Never throws.
const pruneQuizKeysFn = httpsCallable(functions, 'pruneLessonQuizKeys');
export async function pruneLessonQuizKeys(schoolId, postContext, lessonId) {
    try {
        const res = await pruneQuizKeysFn({ schoolId, classId: postContext.classId, subjectId: postContext.subjectId, lessonId });
        return (res.data && Array.isArray(res.data.deleted)) ? res.data.deleted : [];
    } catch (e) {
        console.warn('[Lessons] pruneLessonQuizKeys failed:', e);
        return [];
    }
}

const submitQuizFn = httpsCallable(functions, 'submitLessonQuizAnswer');
// → { correct: boolean, choiceIds: string[] (the graded picks), alreadyAnswered?: boolean }
export async function submitLessonQuizAnswer({ schoolId, classId, subjectId, lessonId, sessionId, objectId, choiceIds }) {
    // sessionId omitted → worksheet answer (document lesson, no live session)
    const res = await submitQuizFn(sessionId ? { schoolId, classId, subjectId, lessonId, sessionId, objectId, choiceIds } : { schoolId, classId, subjectId, lessonId, objectId, choiceIds });
    return res.data;
}

// A student's own response to one live block/widget (per-document get — allowed
// for the owning student by firestore.rules). null when they haven't answered.
export async function loadMyLiveResponse(schoolId, postContext, lessonId, sessionId, studentId, blockId) {
    try {
        const snap = await getDoc(liveResponseRef(schoolId, postContext, lessonId, sessionId, `${studentId}_${blockId}`));
        return snap.exists() ? { id: snap.id, ...snap.data() } : null;
    } catch (e) {
        return null;
    }
}
