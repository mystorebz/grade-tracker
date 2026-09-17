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
import { db } from './firebase-init.js';
import { collection, doc, getDoc, getDocs, setDoc, updateDoc, deleteDoc, onSnapshot, serverTimestamp, runTransaction, query, where }
    from "https://www.gstatic.com/firebasejs/10.7.1/firebase-firestore.js";
import { createPost } from './posts.js';

export function genLessonId() {
    return 'lsn_' + Date.now().toString(36) + '_' + Math.random().toString(36).slice(2, 6);
}

export function genSlideId() {
    return 'slide_' + Date.now().toString(36) + '_' + Math.random().toString(36).slice(2, 6);
}

export function genSessionId() {
    return 'live_' + Date.now().toString(36) + '_' + Math.random().toString(36).slice(2, 6);
}

function lessonRef(schoolId, postContext, lessonId) {
    const { classId, subjectId } = postContext;
    return doc(db, 'schools', schoolId, 'classes', classId, 'subjects', subjectId, 'lessons', lessonId);
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
    const snap = await getDoc(lessonRef(schoolId, postContext, lessonId));
    if (!snap.exists()) return null;
    const data = snap.data();
    return { id: snap.id, ...data, format: normalizeFormat(data) };
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
    const lessons = snap.docs.map(d => {
        const data = d.data();
        return { id: d.id, ...data, format: normalizeFormat(data) };
    });
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
    const lessons = snap.docs.map(d => {
        const data = d.data();
        return { id: d.id, ...data, format: normalizeFormat(data) };
    });
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
    const { classId, className, subjectId, subjectName } = postContext;
    const id = genLessonId();
    const now = new Date().toISOString();
    const resolvedFormat = format === 'document' ? 'document' : 'slides';

    const lesson = {
        title: (title || '').trim() || 'Untitled Lesson',
        format: resolvedFormat,
        status: 'draft',
        schoolId, classId, className,
        subjectId, subjectName,
        authorId: authorContext.authorId,
        authorName: authorContext.authorName,
        slides: resolvedFormat === 'document' ? [newSlide('richtext')] : [newSlide('title')],
        createdAt: now,
        updatedAt: now,
        publishedAt: null
    };

    await setDoc(lessonRef(schoolId, postContext, id), lesson);
    return { id, ...lesson };
}

// ── WRITE: save the main lesson doc (title, slides, status) ──────────────
// Does NOT touch status/publishedAt — use publishLesson()/unpublishLesson()
// for those, so "Save" (draft editing) and "Publish" (the one-way action
// that also fires the Class Stream announcement) can never be confused
// with each other at the call site. Format-agnostic: works identically for
// a Slides lesson's array of blocks or a Document lesson's single richtext
// block — the caller (builder.js's currentSlidesForSave()) is what decides
// what `slides` actually contains before calling this.
export async function saveLessonContent(schoolId, postContext, lessonId, { title, slides }) {
    const updates = {
        title: (title || '').trim() || 'Untitled Lesson',
        slides,
        updatedAt: new Date().toISOString()
    };
    await updateDoc(lessonRef(schoolId, postContext, lessonId), updates);
    return updates;
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
    await deleteDoc(lessonRef(schoolId, postContext, lessonId));
}

// ── LIVE: one lesson's main doc, for the builder to reflect concurrent
//         edits (e.g. the teacher has this lesson open in two tabs) ──────
// Mirrors posts.js's subscribeToPostsForSubjects() cleanup contract exactly:
// returns an unsubscribe function the caller MUST invoke when done.
export function subscribeToLesson(schoolId, postContext, lessonId, onChange) {
    return onSnapshot(lessonRef(schoolId, postContext, lessonId), (snap) => {
        if (snap.exists()) {
            const data = snap.data();
            onChange({ id: snap.id, ...data, format: normalizeFormat(data) });
        }
    }, (error) => {
        console.error(`[Lessons] subscribeToLesson failed for ${lessonId}:`, error);
    });
}

// ── PHASE 3: LIVE SESSION ENGINE — CRUD ──────────────────────────────────

// Starts a new live session for a lesson (teacher action only — enforced by
// firestore.rules, not just by which pages call this). teacherPositionId
// starts pointed at the lesson's own first block, so a student who joins
// before the teacher's first navigation still lands somewhere valid rather
// than on a null position.
//
// RACE GUARD: two teacher tabs (or one teacher double-clicking "Go Live")
// calling this concurrently, if each did its own read-then-write, could
// both see "no active session" and each create a SEPARATE live_sessions
// doc — splitting connected students across two sessions with no error
// surfaced to either tab. Fixed by giving every lesson's live session a
// FIXED, deterministic doc id ('current') instead of a random one, and
// deciding "start fresh vs. resume" inside a single Firestore transaction
// on that one document reference — transactions only support get() on
// specific doc refs, not collection queries, which is exactly why this
// needed a fixed id rather than the previous "list every session, filter
// client-side" approach getActiveLiveSession() still uses for its own
// (non-authoritative, read-only) resume check. Two concurrent calls now
// both transact against the SAME document; Firestore's transaction retry
// guarantees only one of them wins the "doesn't exist / already ended, so
// create fresh" branch — the other sees the just-created doc and resumes
// it instead, exactly like the intended-but-previously-racy behavior.
export async function startLiveSession(schoolId, postContext, lessonId, authorContext) {
    const ref = liveSessionRef(schoolId, postContext, lessonId, 'current');
    const now = new Date().toISOString();

    const result = await runTransaction(db, async (tx) => {
        const snap = await tx.get(ref);
        if (snap.exists() && !snap.data().endedAt) {
            // Another concurrent call (or an already-running tab) already
            // has this lesson live — resume it rather than overwrite its
            // teacherPositionId back to null.
            return { id: 'current', ...snap.data(), resumed: true };
        }
        const session = {
            activeLessonId: lessonId,
            teacherPositionId: null, // set by the caller once it knows the lesson's first block id — see live.js's init()
            startedAt: now,
            startedBy: authorContext?.authorId || null,
            endedAt: null
        };
        tx.set(ref, session);
        return { id: 'current', ...session, resumed: false };
    });
    return result;
}

// Ends a live session — students' onSnapshot listeners see endedAt flip and
// should stop trying to auto-follow the teacher (see viewer.js's
// subscribeToLiveSession handling). The doc itself is left in place (not
// deleted) so `responses` remains readable afterward — a teacher reviewing
// what students submitted during a session that already ended is a
// legitimate, expected use, not a leftover to clean up.
export async function endLiveSession(schoolId, postContext, lessonId, sessionId) {
    const now = new Date().toISOString();
    await updateDoc(liveSessionRef(schoolId, postContext, lessonId, sessionId), { endedAt: now });
    return { endedAt: now };
}

// Teacher navigation — the one field that changes on every slide/scroll
// step during a live session. Called frequently (every navigation), so this
// stays a single-field updateDoc rather than a full document rewrite.
export async function updateLiveSessionPosition(schoolId, postContext, lessonId, sessionId, teacherPositionId) {
    await updateDoc(liveSessionRef(schoolId, postContext, lessonId, sessionId), { teacherPositionId });
}

// Finds the currently-active (not yet ended) live session for a lesson, if
// any — used by viewer.js on load to decide whether to attach the live
// listener at all, and by live.js's dashboard to decide whether to resume
// instead of starting fresh. A single getDoc on the fixed 'current' doc id
// (see startLiveSession()'s race-guard comment) rather than listing/
// filtering/sorting the whole live_sessions collection — there is only ever
// at most one live session per lesson now, so there is nothing to sort.
export async function getActiveLiveSession(schoolId, postContext, lessonId) {
    const snap = await getDoc(liveSessionRef(schoolId, postContext, lessonId, 'current'));
    if (!snap.exists()) return null;
    const data = snap.data();
    return data.endedAt ? null : { id: 'current', ...data };
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
export function subscribeToLiveResponses(schoolId, postContext, lessonId, sessionId, onChange, callerRole) {
    const baseRef = liveResponsesCollectionRef(schoolId, postContext, lessonId, sessionId);
    const ref = callerRole === 'student'
        ? query(baseRef, where('schoolId', '==', schoolId), where('blockType', '==', 'collaborative_board'))
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
export async function saveLiveResponse(schoolId, postContext, lessonId, sessionId, studentId, studentName, blockId, blockType, { answerText }) {
    const now = new Date().toISOString();
    const record = {
        schoolId,
        studentId,
        studentName: studentName || '',
        blockId,
        blockType,
        answerText: (answerText || '').trim(),
        submittedAt: now
    };
    await setDoc(liveResponseRef(schoolId, postContext, lessonId, sessionId, `${studentId}_${blockId}`), record);
    return record;
}
