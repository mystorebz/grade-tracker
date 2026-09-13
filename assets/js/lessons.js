// ── ENTERPRISE LESSON REDESIGN, PHASE 1: LESSON DECK CRUD (teacher) ───────
// Lessons replace the old flat-text lesson_plan post type with real,
// slide-based decks. Storage mirrors the same nesting depth posts.js and
// submissions.js already use:
//   schools/{schoolId}/classes/{classId}/subjects/{subjectId}/lessons/{lessonId}
// — main doc (title, status, slides[]) — plus:
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
import { db } from './firebase-init.js';
import { collection, doc, getDoc, getDocs, setDoc, updateDoc, deleteDoc, onSnapshot, serverTimestamp }
    from "https://www.gstatic.com/firebasejs/10.7.1/firebase-firestore.js";
import { createPost } from './posts.js';

export function genLessonId() {
    return 'lsn_' + Date.now().toString(36) + '_' + Math.random().toString(36).slice(2, 6);
}

export function genSlideId() {
    return 'slide_' + Date.now().toString(36) + '_' + Math.random().toString(36).slice(2, 6);
}

function lessonRef(schoolId, postContext, lessonId) {
    const { classId, subjectId } = postContext;
    return doc(db, 'schools', schoolId, 'classes', classId, 'subjects', subjectId, 'lessons', lessonId);
}

function lessonPrivateRef(schoolId, postContext, lessonId) {
    const { classId, subjectId } = postContext;
    return doc(db, 'schools', schoolId, 'classes', classId, 'subjects', subjectId, 'lessons', lessonId, 'private', 'notes');
}

// ── SLIDE TEMPLATES ───────────────────────────────────────────────────────
// One factory per slide type, so the builder's "add slide" action and any
// future template additions have a single source of truth for a new slide's
// default shape. Every slide always carries id + type; everything else is
// type-specific and always present (even if empty/null) so renderer code
// never has to guess whether a field exists.
export function newSlide(type) {
    const id = genSlideId();
    switch (type) {
        case 'title':
            return { id, type: 'title', heading: '', subheading: '', objective: '' };
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
        case 'content':
        default:
            return { id, type: 'content', heading: '', body: '', bullets: [] };
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

// ── READ: one lesson's main document ─────────────────────────────────────
export async function loadLesson(schoolId, postContext, lessonId) {
    const snap = await getDoc(lessonRef(schoolId, postContext, lessonId));
    return snap.exists() ? { id: snap.id, ...snap.data() } : null;
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
    const lessons = snap.docs.map(d => ({ id: d.id, ...d.data() }));
    lessons.sort((a, b) => new Date(b.updatedAt || 0) - new Date(a.updatedAt || 0));
    return lessons;
}

// ── WRITE: create a new lesson (always starts as a draft) ────────────────
// authorContext: { authorId, authorName } — same shape posts.js's
// createPost() already takes.
export async function createLesson(schoolId, postContext, authorContext, { title }) {
    const { classId, className, subjectId, subjectName } = postContext;
    const id = genLessonId();
    const now = new Date().toISOString();

    const lesson = {
        title: (title || '').trim() || 'Untitled Lesson',
        status: 'draft',
        schoolId, classId, className,
        subjectId, subjectName,
        authorId: authorContext.authorId,
        authorName: authorContext.authorName,
        slides: [newSlide('title')],
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
// with each other at the call site.
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
// to know posts.js exists.
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
        if (snap.exists()) onChange({ id: snap.id, ...snap.data() });
    }, (error) => {
        console.error(`[Lessons] subscribeToLesson failed for ${lessonId}:`, error);
    });
}
