// ── PHASE 1 MILESTONE 1: CLASS STREAM & LESSON PLANS ─────────────────────
// Shared post CRUD + the subject → post-path resolution helper, used by
// teacher/stream/stream.js. Kept in its own module (not utils.js) since this
// is a new, self-contained feature area rather than a cross-cutting helper.
//
// Posts live at:
//   schools/{schoolId}/classes/{classId}/subjects/{subjectId}/posts/{postId}
// — the same nesting depth assignments already use. firestore.rules already
// covers this path (see the schools/{schoolId}/{subcollection=**} wildcard
// and its comment, which explicitly anticipates "class-stream posts"), so no
// rules changes are needed for this collection.
import { db } from './firebase-init.js';
import { collection, doc, getDocs, setDoc, updateDoc, deleteDoc, onSnapshot }
    from "https://www.gstatic.com/firebasejs/10.7.1/firebase-firestore.js";

function genPostId() {
    return 'post_' + Date.now().toString(36) + '_' + Math.random().toString(36).slice(2, 6);
}

// ── SUBJECT → POST-PATH RESOLUTION ───────────────────────────────────────
// A _source:'new' subject (from loadTeacherSubjectsCache / mergeTeacher-
// SubjectsFromIndex in utils.js) already carries its own classId. A
// _source:'legacy' subject does not — it's still just an entry embedded in
// the teacher's own document, with no class document of its own attached.
//
// Rather than forking storage the way legacy assignments do (a real
// subcollection for 'new', an embedded array for 'legacy'), every post is
// written to the same real schools/{schoolId}/classes/{classId}/subjects/
// {subjectId}/posts path regardless of the subject's _source — resolving a
// legacy subject's classId fresh, on the fly, from the teacher's own
// resolved class list (resolvedClasses, as returned by
// loadTeacherSubjectsCache()/mergeTeacherSubjectsFromIndex() in utils.js).
// This works because Firestore never requires a parent document (the
// subject doc itself) to exist for a subcollection nested under it to work —
// so a legacy subject can have real posts without first being migrated into
// a real schools/{schoolId}/classes/{classId}/subjects document of its own.
//
// resolvedClasses is assumed to hold at least the teacher's primary class as
// element 0 — the same single-class assumption loadTeacherSubjectsCache()
// itself already makes for a not-yet-migrated teacher/school.
//
// Returns { classId, className, subjectId, subjectName } or null if no class
// could be resolved at all (caller should treat that as "can't post here yet").
export function resolvePostContext(subject, resolvedClasses) {
    if (!subject) return null;

    let classId = subject.classId || null;
    let className = subject.className || '';

    if (!classId) {
        const cls = (resolvedClasses && resolvedClasses[0]) || null;
        if (!cls) return null;
        classId = cls.id;
        className = cls.name;
    }

    return { classId, className, subjectId: subject.id, subjectName: subject.name };
}

// ── READ ──────────────────────────────────────────────────────────────────
// Fetches every post for one subject and sorts newest-first client-side —
// same approach as rawSemesters/evaluations elsewhere in the app — so
// Milestone 1 needs no composite index. The Stream view uses this list as-is
// (with pinned posts floated to the top); the Lesson Plans view filters it to
// type === 'lesson_plan' and re-sorts by lessonDate. Both views are derived
// in the calling page from this one fetch.
export async function loadPostsForSubject(schoolId, postContext) {
    const { classId, subjectId } = postContext;
    const snap = await getDocs(collection(db, 'schools', schoolId, 'classes', classId, 'subjects', subjectId, 'posts'));
    const posts = snap.docs.map(d => ({ id: d.id, ...d.data() }));
    posts.sort((a, b) => new Date(b.createdAt || 0) - new Date(a.createdAt || 0));
    return posts;
}

// ── PHASE 1 MILESTONE 2: MULTI-SUBJECT READ (student combined stream) ────
// A student's Class Stream is one merged feed across every subject their
// teacher has posted to — unlike the teacher's own Stream page, which is
// scoped to one subject at a time. This fetches every given subject's posts
// in parallel (one query per subject, same as loadPostsForSubject — no
// collectionGroup query, so no rules/index changes are needed) and merges
// them into a single newest-first list. Each returned post already carries
// its own subjectId/subjectName (denormalized at write time), so callers can
// filter the merged list by subject client-side without any extra fetches.
export async function loadPostsForSubjects(schoolId, postContexts) {
    const perSubject = await Promise.all(
        postContexts.map(ctx => loadPostsForSubject(schoolId, ctx).catch(e => {
            console.error(`[loadPostsForSubjects] failed for subject ${ctx.subjectId}:`, e);
            return [];
        }))
    );
    const posts = perSubject.flat();
    posts.sort((a, b) => new Date(b.createdAt || 0) - new Date(a.createdAt || 0));
    return posts;
}

// ── LIVE MULTI-SUBJECT SUBSCRIPTION (student combined stream) ────────────
// Real-time counterpart to loadPostsForSubjects(): opens one onSnapshot
// listener per subject (same one-query-per-subject shape as the one-time
// read above — still no collectionGroup query, so no rules/index changes)
// and keeps a merged, newest-first list in sync as posts are added, edited,
// or removed by the teacher. `onChange` is called with the full merged list
// every time any one subject's slice changes.
//
// Returns an `unsubscribe` function. CALLERS MUST call it when the
// subscription is no longer needed (the student navigates to a different
// page, or the view is torn down) — an onSnapshot listener left running
// keeps billing reads and holding memory for as long as the tab is open
// otherwise ("zombie listener").
export function subscribeToPostsForSubjects(schoolId, postContexts, onChange) {
    const bySubject = new Map(); // subjectId -> that subject's current posts[]

    function emitMerged() {
        const merged = [...bySubject.values()].flat();
        merged.sort((a, b) => new Date(b.createdAt || 0) - new Date(a.createdAt || 0));
        onChange(merged);
    }

    const unsubscribers = postContexts.map(ctx => {
        const { classId, subjectId } = ctx;
        const ref = collection(db, 'schools', schoolId, 'classes', classId, 'subjects', subjectId, 'posts');
        return onSnapshot(ref, (snap) => {
            bySubject.set(subjectId, snap.docs.map(d => ({ id: d.id, ...d.data() })));
            emitMerged();
        }, (error) => {
            console.error(`[subscribeToPostsForSubjects] listener failed for subject ${subjectId}:`, error);
            bySubject.set(subjectId, []); // don't let one bad subject silently freeze the merged list
            emitMerged();
        });
    });

    return () => unsubscribers.forEach(unsub => unsub());
}

// ── WRITE ─────────────────────────────────────────────────────────────────
// postData: { type: 'announcement'|'lesson_plan', title, body, lessonDate,
//             objectives, pinned }
// authorContext: { authorId, authorName }
export async function createPost(schoolId, postContext, authorContext, postData) {
    const { classId, className, subjectId, subjectName } = postContext;
    const isLessonPlan = postData.type === 'lesson_plan';
    const id = genPostId();
    const now = new Date().toISOString();

    const post = {
        type: isLessonPlan ? 'lesson_plan' : 'announcement',
        title: (postData.title || '').trim(),
        body: (postData.body || '').trim(),
        lessonDate: isLessonPlan ? (postData.lessonDate || null) : null,
        objectives: isLessonPlan ? ((postData.objectives || '').trim() || null) : null,
        pinned: !isLessonPlan && !!postData.pinned,

        authorId: authorContext.authorId,
        authorName: authorContext.authorName,

        schoolId, classId, className,
        subjectId, subjectName,

        attachments: [],   // reserved for a later milestone — always empty for now

        createdAt: now,
        updatedAt: now
    };

    await setDoc(doc(db, 'schools', schoolId, 'classes', classId, 'subjects', subjectId, 'posts', id), post);
    return { id, ...post };
}

export async function updatePost(schoolId, postContext, postId, patch) {
    const { classId, subjectId } = postContext;
    const isLessonPlan = patch.type === 'lesson_plan';
    const updates = {
        ...patch,
        title: (patch.title || '').trim(),
        body: (patch.body || '').trim(),
        lessonDate: isLessonPlan ? (patch.lessonDate || null) : null,
        objectives: isLessonPlan ? ((patch.objectives || '').trim() || null) : null,
        pinned: !isLessonPlan && !!patch.pinned,
        updatedAt: new Date().toISOString()
    };
    await updateDoc(doc(db, 'schools', schoolId, 'classes', classId, 'subjects', subjectId, 'posts', postId), updates);
    return updates;
}

export async function deletePost(schoolId, postContext, postId) {
    const { classId, subjectId } = postContext;
    await deleteDoc(doc(db, 'schools', schoolId, 'classes', classId, 'subjects', subjectId, 'posts', postId));
}
