// functions/src/lessonWidgets.js — server-side grading for lesson quiz widgets
//
//   submitLessonQuizAnswer({ schoolId, classId, subjectId, lessonId, sessionId, objectId, choiceIds })
//     → { correct, choiceIds, alreadyAnswered? }
//
// The answer key lives in work_answer_keys/{lessonId}_{objectId}
// (kind: 'lesson_quiz'), which firestore.rules never lets a student read.
// This callable reads it with the Admin SDK, grades, and writes the response
// itself into live_sessions/{sessionId}/responses/{studentId}_{objectId}
// (students are not allowed to write blockType 'quiz' responses directly, so
// `correct` cannot be forged). One attempt per student per quiz.
//
// Before grading it checks, against server data only:
//   - the student is enrolled in the lesson's class (students/{id}.classId,
//     or the legacy className match — same test as firestore.rules)
//   - the quiz exists in the PUBLISHED lesson (slides or document) and every
//     submitted option id is one of that quiz's own options
//   - single-answer quizzes get exactly one option id
// A non-quiz doc sitting at the quiz's response id (written before the rules
// locked that down) does not count as an attempt — it is replaced.

const { onCall, HttpsError } = require('firebase-functions/v2/https');
const admin = require('firebase-admin');

const ID_RE = /^[A-Za-z0-9_-]{1,120}$/;
const MAX_CHOICES = 20;

// ── quiz definition (server truth) ──────────────────────────────────────────
function findObject(objects, objectId) {
    for (const o of Array.isArray(objects) ? objects : []) {
        if (!o || typeof o !== 'object') continue;
        if (o.id === objectId) return o;
        const kids = (o.props && Array.isArray(o.props.children)) ? o.props.children : Array.isArray(o.children) ? o.children : null;
        if (kids && kids.length && typeof kids[0] === 'object') {
            const hit = findObject(kids, objectId);
            if (hit) return hit;
        }
    }
    return null;
}

const unescapeAttr = (s) => s
    .replace(/&quot;/g, '"').replace(/&#39;/g, "'").replace(/&#x27;/g, "'")
    .replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&amp;/g, '&');

function findDocWidget(html, objectId) {
    const tag = new RegExp(`<div\\b[^>]*\\bdata-widget-id="${objectId}"[^>]*>`).exec(String(html || ''));
    if (!tag) return null;
    const type = /\bdata-widget-type="([^"]*)"/.exec(tag[0]);
    const cfg = /\bdata-config="([^"]*)"/.exec(tag[0]) || /\bdata-config='([^']*)'/.exec(tag[0]);
    let config = null;
    try { config = cfg ? JSON.parse(unescapeAttr(cfg[1])) : null; } catch (e) { config = null; }
    return { type: type ? type[1] : '', props: config || {} };
}

async function loadQuizDefinition(lessonRef, lessonData, objectId) {
    let def = null;
    if (lessonData.format === 'document') {
        const docSnap = await lessonRef.collection('doc').doc('main').get();
        def = docSnap.exists ? findDocWidget(docSnap.data().html, objectId) : null;
    } else {
        const slides = await lessonRef.collection('slides').get();
        for (const s of slides.docs) {
            const o = findObject(s.data().objects, objectId);
            if (o) { def = o; break; }
        }
    }
    if (!def || def.type !== 'quiz') return null;
    const props = def.props || {};
    const optionIds = (Array.isArray(props.options) ? props.options : [])
        .map((o) => (o && o.id != null ? String(o.id) : ''))
        .filter(Boolean);
    return { optionIds, multiple: props.multiple === true };
}

// ── enrollment (mirrors firestore.rules studentDocInClass) ──────────────────
async function isEnrolled(db, student, schoolId, classId) {
    if (!student || student.currentSchoolId !== schoolId) return false;
    if (student.classId) return student.classId === classId;
    if (!student.className) return false;
    const classSnap = await db.doc(`schools/${schoolId}/classes/${classId}`).get();
    return classSnap.exists && classSnap.data().name === student.className;
}

exports.submitLessonQuizAnswer = onCall({ region: 'us-central1', maxInstances: 20 }, async (request) => {
    const t = request.auth && request.auth.token;
    if (!t || t.role !== 'student' || !t.studentId) throw new HttpsError('permission-denied', 'Only students can answer quiz questions.');
    const d = request.data || {};
    // no sessionId = worksheet answer in a Document lesson (answered any time)
    const worksheet = d.sessionId === undefined || d.sessionId === null || d.sessionId === '';
    const ids = worksheet ? ['schoolId', 'classId', 'subjectId', 'lessonId', 'objectId'] : ['schoolId', 'classId', 'subjectId', 'lessonId', 'sessionId', 'objectId'];
    if (!ids.every((k) => typeof d[k] === 'string' && ID_RE.test(d[k]))) throw new HttpsError('invalid-argument', 'Missing quiz details.');
    if (t.schoolId !== d.schoolId) throw new HttpsError('permission-denied', 'School mismatch.');

    if (!Array.isArray(d.choiceIds)) throw new HttpsError('invalid-argument', 'Pick an answer first.');
    if (d.choiceIds.length > MAX_CHOICES || !d.choiceIds.every((c) => typeof c === 'string' && ID_RE.test(c))) {
        throw new HttpsError('invalid-argument', 'That answer is not one of the options.');
    }
    const choiceIds = [...new Set(d.choiceIds)];
    if (!choiceIds.length) throw new HttpsError('invalid-argument', 'Pick an answer first.');

    const db = admin.firestore();
    const lessonRef = db.doc(`schools/${d.schoolId}/classes/${d.classId}/subjects/${d.subjectId}/lessons/${d.lessonId}`);
    const sessionRef = worksheet ? null : lessonRef.collection('live_sessions').doc(d.sessionId);
    const keyRef = db.collection('work_answer_keys').doc(`${d.lessonId}_${d.objectId}`);
    const responseRef = (worksheet ? lessonRef : sessionRef).collection('responses').doc(`${t.studentId}_${d.objectId}`);

    const [lessonSnap, sessionSnap, keySnap, studentSnap] = await Promise.all([
        lessonRef.get(), worksheet ? Promise.resolve(null) : sessionRef.get(), keyRef.get(), db.doc(`students/${t.studentId}`).get(),
    ]);
    const student = studentSnap.exists ? studentSnap.data() : null;

    // 3. enrollment
    if (!(await isEnrolled(db, student, d.schoolId, d.classId))) {
        throw new HttpsError('permission-denied', 'You are not enrolled in this class.');
    }
    if (!lessonSnap.exists || lessonSnap.data().status !== 'published') throw new HttpsError('not-found', 'This lesson is not available.');
    let session = null;
    if (worksheet) {
        if (lessonSnap.data().format !== 'document') throw new HttpsError('failed-precondition', 'This question opens during a live session.');
    } else {
        session = sessionSnap.exists ? sessionSnap.data() : null;
        // 'pointer' marks the lesson's live_sessions/current pointer doc, which is never a session
        if (!session || !('endedAt' in session) || session.endedAt === 'pointer') throw new HttpsError('failed-precondition', 'There is no live session for this lesson.');
        if (session.endedAt) throw new HttpsError('failed-precondition', 'This live session has ended.');
    }

    const key = keySnap.exists ? keySnap.data() : null;
    if (!key || key.kind !== 'lesson_quiz' || key.schoolId !== d.schoolId || key.lessonId !== d.lessonId || !Array.isArray(key.correct) || !key.correct.length) {
        throw new HttpsError('failed-precondition', "Your teacher hasn't set the correct answer yet.");
    }

    // 1. option validation — against the quiz's own options in the published
    // lesson, or a quiz the teacher asked live (session.activities, live-activity.js)
    let quiz = await loadQuizDefinition(lessonRef, lessonSnap.data(), d.objectId);
    if (!quiz && session) {
        const act = (Array.isArray(session.activities) ? session.activities : []).find((a) => a && a.id === d.objectId && a.type === 'quiz');
        if (act) {
            if (session.activityId !== act.id) throw new HttpsError('failed-precondition', 'This question is closed.');
            const opts = act.props && Array.isArray(act.props.options) ? act.props.options : [];
            quiz = { optionIds: opts.map((o) => (o && o.id != null ? String(o.id) : '')).filter(Boolean), multiple: false };
        }
    }
    if (!quiz || !quiz.optionIds.length) throw new HttpsError('not-found', 'This quiz question is not in the lesson.');
    const validIds = new Set(quiz.optionIds);
    const correctIds = key.correct.map(String).filter((c) => validIds.has(c));
    if (!correctIds.length) throw new HttpsError('failed-precondition', "Your teacher hasn't set the correct answer yet.");
    if (!choiceIds.every((c) => validIds.has(c))) throw new HttpsError('invalid-argument', 'That answer is not one of the options.');

    // 2. single-answer enforcement
    if (!quiz.multiple && choiceIds.length !== 1) throw new HttpsError('invalid-argument', 'Pick exactly one answer.');

    const correctSet = new Set(correctIds);
    const correct = quiz.multiple
        ? choiceIds.length === correctSet.size && choiceIds.every((c) => correctSet.has(c))
        : correctSet.has(choiceIds[0]); // single answer: any option marked correct counts
    const studentName = (student && (student.name || student.fullName)) || '';

    return db.runTransaction(async (tx) => {
        const existing = await tx.get(responseRef);
        const prev = existing.exists ? existing.data() : null;
        // 4. a real quiz attempt is final; anything else at this id is replaced
        if (prev && prev.blockType === 'quiz') {
            return {
                correct: prev.correct === true,
                choiceIds: Array.isArray(prev.choiceIds) ? prev.choiceIds.map(String) : [],
                alreadyAnswered: true,
            };
        }
        tx.set(responseRef, {
            schoolId: d.schoolId, studentId: t.studentId, studentName,
            blockId: d.objectId, blockType: 'quiz', choiceIds, answerText: '',
            correct, submittedAt: new Date().toISOString(),
        });
        // 5. the picks that were actually graded
        return { correct, choiceIds };
    });
});

// ── pruneLessonQuizKeys ─────────────────────────────────────────────────────
//   pruneLessonQuizKeys({ schoolId, classId, subjectId, lessonId })
//     → { deleted: [{ objectId, correct }] }
//
// Deletes this lesson's quiz answer keys (work_answer_keys, kind lesson_quiz)
// whose quiz is no longer in the lesson's SAVED content — a deleted quiz, an
// undone insert, or the whole lesson deleted. Staff of the lesson's school
// only (students can never touch keys). Clients can't delete keys themselves
// (firestore.rules), so the lesson editor calls this after every save and
// deleteLesson() after removing a lesson. The deleted keys are returned so
// the editor can put them back if the teacher undoes the delete.
async function quizIdsInLesson(lessonRef, lessonData) {
    const ids = new Set();
    const walk = (objects) => (Array.isArray(objects) ? objects : []).forEach((o) => {
        if (!o || typeof o !== 'object') return;
        if (o.type === 'quiz' && o.id) ids.add(String(o.id));
        const kids = (o.props && Array.isArray(o.props.children)) ? o.props.children : Array.isArray(o.children) ? o.children : null;
        if (kids && kids.length && typeof kids[0] === 'object') walk(kids);
    });
    if (lessonData && lessonData.format === 'document') {
        const docSnap = await lessonRef.collection('doc').doc('main').get();
        const html = docSnap.exists ? String(docSnap.data().html || '') : '';
        const tagRe = /<div\b[^>]*\bdata-widget-id="([A-Za-z0-9_-]+)"[^>]*>/g;
        let m;
        while ((m = tagRe.exec(html))) {
            if (/\bdata-widget-type="quiz"/.test(m[0])) ids.add(m[1]);
        }
    } else if (lessonData) {
        const slides = await lessonRef.collection('slides').get();
        slides.docs.forEach((s) => walk(s.data().objects));
    }
    return ids;
}

exports.pruneLessonQuizKeys = onCall({ region: 'us-central1', maxInstances: 20 }, async (request) => {
    const t = request.auth && request.auth.token;
    if (!t || !['teacher', 'super_admin', 'sub_admin'].includes(t.role)) throw new HttpsError('permission-denied', 'Only staff can manage quiz answers.');
    const d = request.data || {};
    const ids = ['schoolId', 'classId', 'subjectId', 'lessonId'];
    if (!ids.every((k) => typeof d[k] === 'string' && ID_RE.test(d[k]))) throw new HttpsError('invalid-argument', 'Missing lesson details.');
    if (t.schoolId !== d.schoolId) throw new HttpsError('permission-denied', 'School mismatch.');

    const db = admin.firestore();
    const lessonRef = db.doc(`schools/${d.schoolId}/classes/${d.classId}/subjects/${d.subjectId}/lessons/${d.lessonId}`);
    const lessonSnap = await lessonRef.get();
    // lesson gone → every key of it is an orphan
    const keep = lessonSnap.exists ? await quizIdsInLesson(lessonRef, lessonSnap.data()) : new Set();
    // quizzes asked during a live session ("live_…" ids) aren't in the lesson
    // content; their keys stay while the lesson exists
    const keepLive = lessonSnap.exists;

    const keys = await db.collection('work_answer_keys').where('lessonId', '==', d.lessonId).get();
    const deleted = [];
    const batch = db.batch();
    keys.docs.forEach((k) => {
        const v = k.data();
        if (v.kind !== 'lesson_quiz' || v.schoolId !== d.schoolId) return;
        const objectId = String(v.objectId || k.id.slice(d.lessonId.length + 1));
        if (keep.has(objectId) || (keepLive && objectId.startsWith('live_'))) return;
        batch.delete(k.ref);
        deleted.push({ objectId, correct: Array.isArray(v.correct) ? v.correct.map(String) : [] });
    });
    if (deleted.length) await batch.commit();
    return { deleted };
});
