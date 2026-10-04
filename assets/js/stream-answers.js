// ── CLASS STREAM: QUESTION ANSWERS (blind-reply lockdown, 2026-10-04) ────
// Answers to a Stream Question live in their own sub-collection:
//   schools/{s}/classes/{c}/subjects/{sub}/posts/{postId}/answers/{answerId}
// instead of the post's `comments` array, so the DATABASE (firestore.rules,
// posts/{postId}/answers block) decides who can read them — not the screen.
//
//   • A student's answer has doc id == their studentId (one answer each).
//   • A teacher/admin reply has doc id 't_…'.
//   • Blind question: a student can read ONLY their own answer until it
//     exists; after that, the whole list. Non-blind: the whole list.
//   • Teachers/admins of the class: always the whole list.
//
// This module keeps one live listener set per question post and hands the
// pages a post-shaped view ({ ...post, comments: answers }) so the existing
// comment UI (stream-comments.js) renders answers unchanged.
import { db } from './firebase-init.js';
import { collection, deleteDoc, doc, onSnapshot, orderBy, query, setDoc }
    from "https://www.gstatic.com/firebasejs/10.7.1/firebase-firestore.js";
import { COMMENT_MAX_LENGTH } from './posts.js';

const watches = new Map(); // postId -> watch state

function answersCol(schoolId, post) {
    return collection(db, 'schools', schoolId, 'classes', post.classId, 'subjects', post.subjectId, 'posts', post.id, 'answers');
}

function isBlindPost(post) {
    return post.type === 'question' && !!(post.question && post.question.blindReplies);
}

function startAll(w) {
    if (w.unsubAll) return;
    w.unsubAll = onSnapshot(query(w.col, orderBy('createdAt')), (snap) => {
        w.list = snap.docs.map(d => ({ id: d.id, ...d.data() }));
        w.listLoaded = true;
        w.notify();
    }, (err) => {
        console.error('[Stream answers] list listener:', err);
        w.unsubAll = null;
        w.listLoaded = true;
        // A student who just answered can race the server by a moment;
        // retry a few times once their own answer is confirmed.
        if (w.viewer.role === 'student' && w.own && (w.retries = (w.retries || 0) + 1) <= 3) {
            setTimeout(() => syncListAccess(w), 1500 * w.retries);
        }
        w.notify();
    });
}

function stopAll(w) {
    if (w.unsubAll) { w.unsubAll(); w.unsubAll = null; }
    w.list = [];
    w.listLoaded = false;
}

// A student may see the full list on a non-blind question, or once their own
// answer exists. Staff always may.
function syncListAccess(w) {
    if (w.viewer.role !== 'student' || !w.blind || w.own) startAll(w);
    else stopAll(w);
}

/**
 * Start (once) the live listeners for a question post. Safe to call on every
 * render; a later call only refreshes the blind setting.
 * @param {string} schoolId
 * @param {object} post   needs id, classId, subjectId, type, question
 * @param {{ role: 'student'|'teacher', id: string }} viewer
 * @param {() => void} onChange   re-render callback
 */
export function watchAnswers(schoolId, post, viewer, onChange) {
    if (!post || post.type !== 'question' || !post.classId || !post.subjectId) return;
    let w = watches.get(post.id);
    if (w) {
        w.onChange = onChange;
        const blind = isBlindPost(post);
        if (blind !== w.blind) { w.blind = blind; syncListAccess(w); }
        return;
    }
    let pending = false;
    w = {
        col: answersCol(schoolId, post), viewer, onChange, blind: isBlindPost(post),
        own: null, ownLoaded: viewer.role !== 'student', list: [], listLoaded: false,
        unsubOwn: null, unsubAll: null,
        // Several snapshots can land together; repaint once. A short timer,
        // not requestAnimationFrame: rAF never fires in a background tab, so
        // a teacher's stream left open in another tab would never refresh.
        notify() {
            if (pending) return;
            pending = true;
            setTimeout(() => { pending = false; w.onChange && w.onChange(); }, 16);
        },
    };
    watches.set(post.id, w);

    if (viewer.role === 'student') {
        // includeMetadataChanges: the first snapshot after the student posts
        // is the local copy (hasPendingWrites); the database only lets them
        // read classmates' answers once the server has stored theirs, so
        // the full list is opened on the server-confirmed snapshot.
        w.unsubOwn = onSnapshot(doc(w.col, viewer.id), { includeMetadataChanges: true }, (snap) => {
            w.own = snap.exists() ? { id: snap.id, ...snap.data() } : null;
            w.ownLoaded = true;
            if (!snap.metadata.hasPendingWrites) syncListAccess(w);
            w.notify();
        }, (err) => {
            console.error('[Stream answers] own-answer listener:', err);
            w.ownLoaded = true;
            w.notify();
        });
    } else {
        startAll(w);
    }
}

/** Post-shaped view for the comment UI: comments = the answers this viewer may see. */
export function answersView(post) {
    const w = watches.get(post.id);
    if (!w) return { ...post, comments: [] };
    const visible = w.unsubAll ? w.list : (w.own ? [w.own] : []);
    return { ...post, comments: visible };
}

/** Blind question and this student hasn't answered yet → hide classmates' answers. */
export function isAnswerHiddenForStudent(post) {
    if (!isBlindPost(post)) return false;
    const w = watches.get(post.id);
    return !(w && w.own);
}

/** True once the signed-in student's own answer exists (one answer per student). */
export function studentHasAnswered(post) {
    const w = watches.get(post.id);
    return !!(w && w.own);
}

/** Write an answer. Student: doc id = studentId. Teacher/admin: 't_' + random id. */
export async function addAnswer(schoolId, post, { text, authorId, authorName, role }) {
    const clean = String(text || '').trim().slice(0, COMMENT_MAX_LENGTH);
    if (!clean) throw new Error('Empty answer');
    const isStudent = role === 'student';
    const id = isStudent ? authorId : `t_${Date.now().toString(36)}${Math.random().toString(36).slice(2, 8)}`;
    const answer = {
        text: clean,
        authorId,
        authorName: String(authorName || '').slice(0, 80),
        role: isStudent ? 'student' : 'teacher',
        createdAt: new Date().toISOString(),
    };
    await setDoc(doc(answersCol(schoolId, post), id), answer);
    return { id, ...answer };
}

/** Teacher/admin moderation: remove one answer. */
export async function deleteAnswer(schoolId, post, answerId) {
    await deleteDoc(doc(answersCol(schoolId, post), answerId));
}

/** Stop every listener (page teardown). */
export function stopAllAnswerWatches() {
    watches.forEach(w => {
        if (w.unsubOwn) w.unsubOwn();
        if (w.unsubAll) w.unsubAll();
    });
    watches.clear();
}
