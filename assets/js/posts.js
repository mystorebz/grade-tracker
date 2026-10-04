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
import { collection, doc, getDoc, getDocs, setDoc, updateDoc, deleteDoc, onSnapshot,
         query, where, orderBy, limit, startAfter, arrayUnion, runTransaction, Timestamp }
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
export async function createPost(schoolId, postContext, authorContext, postData, { id: fixedId } = {}) {
    const { classId, className, subjectId, subjectName } = postContext;
    const isLessonPlan = postData.type === 'lesson_plan';
    const isLive = postData.type === 'live_session';
    const isPoll = postData.type === 'poll';
    const isQuestion = postData.type === 'question';
    const id = fixedId || genPostId();
    const now = new Date().toISOString();

    const post = {
        type: isLessonPlan ? 'lesson_plan' : isLive ? 'live_session' : isPoll ? 'poll' : isQuestion ? 'question' : 'announcement',
        title: (postData.title || '').trim(),
        body: (postData.body || '').trim(),
        lessonDate: isLessonPlan ? (postData.lessonDate || null) : null,
        objectives: isLessonPlan ? ((postData.objectives || '').trim() || null) : null,
        pinned: !isLessonPlan && !!postData.pinned,

        authorId: authorContext.authorId,
        authorName: authorContext.authorName,

        schoolId, classId, className: className || '',
        subjectId, subjectName: subjectName || '',
        semesterId: postData.semesterId || null,

        attachments: [],   // reserved for a later milestone — always empty for now
        comments: [],      // inline discussion — see addPostComment()

        // live_session posts: { linkedLessonId, liveSessionId, live } — set
        // in the same write so no client ever sees a half-built card.
        // Module 3.5: poll + open votes (map keyed by studentId), question settings.
        ...(isPoll ? buildPollFields(postData.poll) : {}),
        ...(isQuestion ? { question: { blindReplies: !!(postData.question && postData.question.blindReplies) } } : {}),
        ...(isLive ? {
            linkedLessonId: postData.linkedLessonId || null,
            liveSessionId: postData.liveSessionId || null,
            live: true,
        } : {}),

        createdAt: now,
        updatedAt: now
    };

    await setDoc(doc(db, 'schools', schoolId, 'classes', classId, 'subjects', subjectId, 'posts', id), post);
    return { id, ...post };
}

// options: [text…] (2–6, trimmed, blanks dropped). closesAt: Date|null.
export const POLL_MIN_OPTIONS = 2;
export const POLL_MAX_OPTIONS = 6;
function buildPollFields(poll = {}) {
    const texts = (poll.options || []).map(t => String(t || '').trim().slice(0, 120)).filter(Boolean).slice(0, POLL_MAX_OPTIONS);
    const options = texts.map((text, i) => ({ id: `opt${i + 1}`, text }));
    return {
        poll: {
            options,
            optionIds: options.map(o => o.id),
            allowChange: !!poll.allowChange,
            closesAt: poll.closesAt instanceof Date && !isNaN(poll.closesAt) ? Timestamp.fromDate(poll.closesAt) : null,
            closed: false,
        },
        votes: {},
    };
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

// ── LESSON-LINKED POST: "Share to Stream" from the Class Stream's lesson
// picker ─────────────────────────────────────────────────────────────────
// Mirrors lessons.js's own publishLesson() exactly (create the announcement,
// then patch linkedLessonId on afterward — that field isn't part of
// createPost()'s known schema, so it's patched on rather than widening that
// shared function's signature for these two callers). Kept as a distinct
// function rather than exported from lessons.js because it's a Stream
// action, not a lesson-state transition: unlike publishLesson(), this never
// touches the lesson doc itself, and can be called again for an
// already-published lesson (a teacher re-sharing a reminder), which is why
// its copy says "Lesson shared" rather than "New Lesson:" — avoiding the
// false implication that the lesson itself is new every time this runs.
export async function createLessonLinkedPost(schoolId, postContext, authorContext, { lessonId, lessonTitle }) {
    const post = await createPost(schoolId, postContext, authorContext, {
        type: 'announcement',
        title: `Lesson shared: ${lessonTitle || 'Untitled Lesson'}`,
        body: 'Your teacher shared a lesson. Tap to view it.',
        pinned: false
    });
    const { classId, subjectId } = postContext;
    await updateDoc(doc(db, 'schools', schoolId, 'classes', classId, 'subjects', subjectId, 'posts', post.id),
        { linkedLessonId: lessonId });
    return { ...post, linkedLessonId: lessonId };
}


// ═══════════════════════════════════════════════════════════════════════════
// MODULE 3: SEMESTER-SCOPED, PAGINATED, REAL-TIME FEED + INLINE COMMENTS
// ═══════════════════════════════════════════════════════════════════════════

export const FEED_PAGE_SIZE = 20;

// Active term window for the stream: posts created on/after the active
// semester's startDate. Scoping by createdAt (not a semesterId field) keeps
// every post written before semesterId existed in the right term, and
// needs only the automatic single-field index on createdAt.
export async function resolveActiveTermWindow(schoolId) {
    try {
        const schoolSnap = await getDoc(doc(db, 'schools', schoolId));
        const semesterId = schoolSnap.exists() ? (schoolSnap.data().activeSemesterId || null) : null;
        if (!semesterId) return { semesterId: null, sinceIso: null, semesterName: '' };
        const semSnap = await getDoc(doc(db, 'schools', schoolId, 'semesters', semesterId));
        const sem = semSnap.exists() ? semSnap.data() : {};
        return { semesterId, sinceIso: sem.startDate || null, semesterName: sem.name || '' };
    } catch (e) {
        console.error('[posts] resolveActiveTermWindow:', e);
        return { semesterId: null, sinceIso: null, semesterName: '' };
    }
}

function postsCol(schoolId, ctx) {
    return collection(db, 'schools', schoolId, 'classes', ctx.classId, 'subjects', ctx.subjectId, 'posts');
}

function sortFeed(list) {
    return list.sort((a, b) => (b.pinned ? 1 : 0) - (a.pinned ? 1 : 0) || String(b.createdAt || '').localeCompare(String(a.createdAt || '')));
}

// One feed over one or more subjects. Per subject:
//   • a live onSnapshot on the newest FEED_PAGE_SIZE posts of the term,
//   • a live onSnapshot on that subject's pinned posts (few; kept visible
//     even when older than the newest page),
//   • older pages fetched on demand with loadOlder() (one-time reads,
//     FEED_PAGE_SIZE per subject, cursor = oldest createdAt seen so far).
// onChange(posts, { hasMore }) fires with the merged list (pinned first,
// then newest first) on every change. Call stop() when leaving the page.
export function createPostFeed(schoolId, contexts, { sinceIso = null, pageSize = FEED_PAGE_SIZE, onChange, onError } = {}) {
    const state = new Map(); // subjectId -> { ctx, live: Map, pinned: Map, older: Map, hasMore, ready }
    const unsubs = [];

    const emit = () => {
        const merged = new Map();
        state.forEach(st => {
            st.older.forEach((p, id) => merged.set(id, p));
            st.pinned.forEach((p, id) => merged.set(id, p));
            st.live.forEach((p, id) => merged.set(id, p));
        });
        const list = sortFeed([...merged.values()]);
        const hasMore = [...state.values()].some(st => st.hasMore);
        const ready = [...state.values()].every(st => st.ready);
        onChange && onChange(list, { hasMore, ready });
    };

    contexts.forEach(ctx => {
        const st = { ctx, live: new Map(), pinned: new Map(), older: new Map(), hasMore: false, ready: false };
        state.set(ctx.subjectId, st);

        const constraints = [];
        if (sinceIso) constraints.push(where('createdAt', '>=', sinceIso));
        constraints.push(orderBy('createdAt', 'desc'), limit(pageSize));

        unsubs.push(onSnapshot(query(postsCol(schoolId, ctx), ...constraints), (snap) => {
            const next = new Map(snap.docs.map(d => [d.id, { id: d.id, ...d.data() }]));
            const windowFloor = snap.size === pageSize ? String(snap.docs[snap.size - 1].data().createdAt || '') : null;
            // A post that slid out of the newest-N window because newer ones
            // arrived is still a real post — keep it as an "older" post
            // instead of making it vanish until the next page load.
            snap.docChanges().forEach(ch => {
                if (ch.type !== 'removed') return;
                const old = st.live.get(ch.doc.id);
                if (old && windowFloor && String(old.createdAt || '') <= windowFloor) st.older.set(ch.doc.id, old);
                else st.older.delete(ch.doc.id); // genuinely deleted
            });
            next.forEach((_, id) => st.older.delete(id));
            st.live = next;
            if (!st.ready) st.hasMore = snap.size === pageSize;
            st.ready = true;
            emit();
        }, (err) => {
            console.error(`[posts] feed listener failed for subject ${ctx.subjectId}:`, err);
            st.ready = true;
            onError && onError(err, ctx);
            emit();
        }));

        unsubs.push(onSnapshot(query(postsCol(schoolId, ctx), where('pinned', '==', true)), (snap) => {
            st.pinned = new Map(snap.docs
                .map(d => [d.id, { id: d.id, ...d.data() }])
                .filter(([, p]) => !sinceIso || String(p.createdAt || '') >= sinceIso));
            emit();
        }, (err) => console.error(`[posts] pinned listener failed for subject ${ctx.subjectId}:`, err)));
    });

    async function loadOlder() {
        await Promise.all([...state.values()].filter(st => st.hasMore).map(async st => {
            const all = [...st.live.values(), ...st.older.values()];
            if (!all.length) { st.hasMore = false; return; }
            const oldest = all.reduce((m, p) => (String(p.createdAt || '') < m ? String(p.createdAt || '') : m), String(all[0].createdAt || ''));
            const constraints = [];
            if (sinceIso) constraints.push(where('createdAt', '>=', sinceIso));
            constraints.push(orderBy('createdAt', 'desc'), startAfter(oldest), limit(pageSize));
            try {
                const snap = await getDocs(query(postsCol(schoolId, st.ctx), ...constraints));
                snap.docs.forEach(d => { if (!st.live.has(d.id)) st.older.set(d.id, { id: d.id, ...d.data() }); });
                st.hasMore = snap.size === pageSize;
            } catch (e) {
                console.error(`[posts] loadOlder failed for subject ${st.ctx.subjectId}:`, e);
                st.hasMore = false;
            }
        }));
        emit();
    }

    // Older pages aren't live — after a comment add/delete on one of them,
    // patch the local copy so the UI reflects it without a re-fetch.
    function patchLocal(postId, fields) {
        state.forEach(st => {
            if (st.older.has(postId)) st.older.set(postId, { ...st.older.get(postId), ...fields });
        });
        emit();
    }

    return { loadOlder, patchLocal, stop: () => unsubs.splice(0).forEach(u => u()) };
}

// ── INLINE COMMENTS (stored on the post doc: zero extra reads) ───────────
// comments: [{ id, text, authorId, authorName, role, createdAt }]
// firestore.rules lets an enrolled student append exactly one comment
// authored by themselves; class teachers/admins may append or remove.
export const COMMENT_MAX_LENGTH = 1000;

function postRef(schoolId, ctx, postId) {
    return doc(db, 'schools', schoolId, 'classes', ctx.classId, 'subjects', ctx.subjectId, 'posts', postId);
}

export async function addPostComment(schoolId, ctx, postId, { text, authorId, authorName, role }) {
    const clean = String(text || '').trim().slice(0, COMMENT_MAX_LENGTH);
    if (!clean) throw new Error('empty-comment');
    const comment = {
        id: 'c_' + Date.now().toString(36) + '_' + Math.random().toString(36).slice(2, 6),
        text: clean,
        authorId: String(authorId || ''),
        authorName: String(authorName || '').slice(0, 80),
        role,
        createdAt: new Date().toISOString(),
    };
    await updateDoc(postRef(schoolId, ctx, postId), { comments: arrayUnion(comment) });
    return comment;
}

// Removes one comment by id (transaction: no stale-object arrayRemove misses).
export async function deletePostComment(schoolId, ctx, postId, commentId) {
    const ref = postRef(schoolId, ctx, postId);
    return runTransaction(db, async (tx) => {
        const snap = await tx.get(ref);
        if (!snap.exists()) return [];
        const next = (snap.data().comments || []).filter(c => c && c.id !== commentId);
        tx.update(ref, { comments: next });
        return next;
    });
}

// Join URL for a lesson-linked / live-session post (student viewer follows
// the live session pointer on its own).
export function lessonViewerUrl(post, base = '../lessons/view.html') {
    const params = new URLSearchParams({
        lessonId: post.linkedLessonId,
        classId: post.classId,
        subjectId: post.subjectId,
        subjectName: post.subjectName || '',
    });
    return `${base}?${params.toString()}`;
}

// Deterministic id so the live-session post can be flipped to "ended".
export function liveSessionPostId(lessonId, sessionId) {
    return `live_${lessonId}_${sessionId}`.replace(/[^A-Za-z0-9_-]/g, '_');
}

export const LIVE_ENDED_BODY = 'This live session has ended. You can review the lesson anytime.';

// Title/body to show for a post: an ended live-session bulletin reads as a
// past session (older ended posts still carry the "Live now" wording).
export function displayPostText(post) {
    if (post && post.type === 'live_session' && !post.live) {
        return {
            title: String(post.title || '').replace(/^Live now:\s*/, 'Live lesson: '),
            body: LIVE_ENDED_BODY,
        };
    }
    return { title: post ? post.title : '', body: post ? post.body : '' };
}

export async function markLiveSessionPostEnded(schoolId, ctx, lessonId, sessionId) {
    try {
        await updateDoc(postRef(schoolId, ctx, liveSessionPostId(lessonId, sessionId)), { live: false, endedAt: new Date().toISOString(), body: LIVE_ENDED_BODY });
    } catch (e) {
        if (e && e.code !== 'not-found') console.error('[posts] markLiveSessionPostEnded:', e);
    }
}
