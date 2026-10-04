#!/usr/bin/env node
'use strict';
/**
 * functions/dev-final-cleanup.js — one-off cleanup, LIVE dev project only.
 *
 *   node dev-final-cleanup.js            DRY RUN: counts only, changes nothing
 *   node dev-final-cleanup.js --apply    make the changes
 *
 * PART A — wipe old-style ("legacy") assignments
 *   Old-style assignments are objects inside a teacher record's `subjects[]`
 *   (teachers/{id} or schools/{s}/teachers/{id}), not documents of their
 *   own, so the database rules could never lock them. This removes the
 *   `assignments` list from every one of those embedded subjects (the
 *   subject entries themselves stay), then deletes every submission/draft
 *   that belongs to an assignment with no assignment document:
 *     • schools/…/assignments/{a}/submissions|drafts/{id} whose assignment
 *       document doesn't exist
 *     • students/{id}/submissions/{x} pointing at a legacy id or at an
 *       assignment document that doesn't exist
 *   Grades are NOT touched.
 *
 * PART B — move Stream Question answers out of the post document
 *   Answers to Question posts used to sit in the post's `comments` array,
 *   which every student in the class could read. Each one is copied into
 *   posts/{postId}/answers (student: doc id = studentId; teacher: 't_…'),
 *   then the post's `comments` array is emptied.
 *
 * Target: dev-school-grade-tracker ONLY. Auth: Application Default Credentials.
 */
const PROJECT_ID = 'dev-school-grade-tracker';
if ((process.env.QA_PROJECT_ID || PROJECT_ID) !== PROJECT_ID) {
    console.error(`[FAIL] Refusing to run against anything but ${PROJECT_ID}.`);
    process.exit(2);
}
for (const v of ['FIRESTORE_EMULATOR_HOST', 'FIREBASE_AUTH_EMULATOR_HOST', 'FIREBASE_EMULATOR_HUB']) delete process.env[v];
process.env.GOOGLE_CLOUD_PROJECT = PROJECT_ID;
process.env.GCLOUD_PROJECT = PROJECT_ID;

const { initializeApp, applicationDefault } = require('firebase-admin/app');
const { getFirestore } = require('firebase-admin/firestore');
const app = initializeApp({ projectId: PROJECT_ID, credential: applicationDefault() }, 'dev-final-cleanup');
const db = getFirestore(app);

const APPLY = process.argv.includes('--apply');
const MODE = APPLY ? 'APPLY' : 'DRY RUN';

// ── PART A ────────────────────────────────────────────────────────────────
async function wipeLegacyAssignments() {
    console.log('\n── PART A: old-style assignments ──');
    const legacyIds = new Set();
    let teacherDocs = 0, embedded = 0;

    const teachers = await db.collectionGroup('teachers').get();
    for (const t of teachers.docs) {
        const subjects = t.get('subjects');
        if (!Array.isArray(subjects)) continue;
        const withAsg = subjects.filter(s => s && Array.isArray(s.assignments) && s.assignments.length);
        if (!withAsg.length) continue;
        teacherDocs++;
        withAsg.forEach(s => s.assignments.forEach(a => { embedded++; if (a && a.id) legacyIds.add(String(a.id)); }));
        console.log(`[INFO] ${t.ref.path}: ${withAsg.reduce((n, s) => n + s.assignments.length, 0)} old-style assignment(s)`);
        if (APPLY) {
            const cleaned = subjects.map(s => {
                if (!s || typeof s !== 'object' || !('assignments' in s)) return s;
                const { assignments, ...rest } = s; // eslint-disable-line no-unused-vars
                return rest;
            });
            await t.ref.update({ subjects: cleaned });
        }
    }

    // Submissions + drafts tied to an assignment with no document.
    const asgExists = new Map();
    const assignmentExists = async (path) => {
        if (!asgExists.has(path)) asgExists.set(path, (await db.doc(path).get()).exists);
        return asgExists.get(path);
    };
    const studentSchool = new Map();
    const schoolOf = async (studentId) => {
        if (!studentSchool.has(studentId)) {
            const s = await db.doc(`students/${studentId}`).get();
            studentSchool.set(studentId, s.exists ? (s.get('currentSchoolId') || '') : '');
        }
        return studentSchool.get(studentId);
    };

    const doomed = [];
    for (const group of ['submissions', 'drafts']) {
        const snap = await db.collectionGroup(group).get();
        for (const d of snap.docs) {
            const seg = d.ref.path.split('/');
            // schools/{s}/classes/{c}/subjects/{sub}/assignments/{a}/{group}/{id}
            if (seg.length === 10 && seg[0] === 'schools' && seg[6] === 'assignments') {
                const asgPath = seg.slice(0, 8).join('/');
                if (!(await assignmentExists(asgPath))) doomed.push(d.ref);
                continue;
            }
            // students/{id}/submissions/{x} (pointer fields)
            if (group === 'submissions' && seg.length === 4 && seg[0] === 'students') {
                const { classId, subjectId, assignmentId } = d.data();
                if (!(classId && subjectId && assignmentId)) {
                    // no pointers to check: only remove it if it names an old-style id
                    if (assignmentId && legacyIds.has(String(assignmentId))) doomed.push(d.ref);
                    continue;
                }
                {
                    const schoolId = await schoolOf(seg[1]);
                    if (schoolId && !(await assignmentExists(`schools/${schoolId}/classes/${classId}/subjects/${subjectId}/assignments/${assignmentId}`))) {
                        doomed.push(d.ref);
                    }
                }
            }
        }
    }
    doomed.forEach(r => console.log(`[INFO] submission/draft for old-style assignment: ${r.path}`));
    if (APPLY) for (const r of doomed) await db.recursiveDelete(r);

    console.log(`[${APPLY ? 'PASS' : 'INFO'}] teacher records with old-style assignments: ${teacherDocs}`);
    console.log(`[${APPLY ? 'PASS' : 'INFO'}] old-style assignments ${APPLY ? 'removed' : 'found'}: ${embedded}`);
    console.log(`[${APPLY ? 'PASS' : 'INFO'}] submissions/drafts ${APPLY ? 'deleted' : 'to delete'}: ${doomed.length}`);
}

// ── PART B ────────────────────────────────────────────────────────────────
async function moveQuestionAnswers() {
    console.log('\n── PART B: Stream Question answers → answers sub-collection ──');
    let posts = 0, moved = 0;
    const snap = await db.collectionGroup('posts').get();
    for (const p of snap.docs) {
        const seg = p.ref.path.split('/');
        if (!(seg.length === 8 && seg[0] === 'schools' && seg[2] === 'classes')) continue;
        if (p.get('type') !== 'question') continue;
        const comments = (p.get('comments') || []).filter(c => c && c.text);
        if (!comments.length) continue;
        posts++;

        const answers = new Map(); // docId -> data
        for (const c of comments) {
            const isStudent = c.role === 'student' && c.authorId;
            const id = isStudent
                ? String(c.authorId)
                : `t_${String(c.id || Date.now().toString(36)).replace(/[^A-Za-z0-9]/g, '').slice(0, 40).padEnd(4, '0')}`;
            const prev = answers.get(id);
            if (prev) { // a student answered more than once: keep one answer, both texts
                prev.text = `${prev.text}\n\n${c.text}`.slice(0, 1000);
                continue;
            }
            answers.set(id, {
                text: String(c.text).slice(0, 1000),
                authorId: String(c.authorId || ''),
                authorName: String(c.authorName || '').slice(0, 80),
                role: isStudent ? 'student' : 'teacher',
                createdAt: c.createdAt || p.get('createdAt') || new Date().toISOString(),
            });
        }
        console.log(`[INFO] ${p.ref.path}: ${comments.length} answer(s) → ${answers.size} answer doc(s)`);
        moved += answers.size;
        if (APPLY) {
            const batch = db.batch();
            answers.forEach((data, id) => batch.set(p.ref.collection('answers').doc(id), data, { merge: false }));
            batch.update(p.ref, { comments: [] });
            await batch.commit();
        }
    }
    console.log(`[${APPLY ? 'PASS' : 'INFO'}] question posts ${APPLY ? 'moved' : 'to move'}: ${posts}`);
    console.log(`[${APPLY ? 'PASS' : 'INFO'}] answer docs ${APPLY ? 'written' : 'to write'}: ${moved}`);
}

(async () => {
    console.log(`dev-final-cleanup — ${MODE} — ${PROJECT_ID}`);
    await wipeLegacyAssignments();
    await moveQuestionAnswers();
    console.log(APPLY ? '\n[PASS] Done.' : '\nDry run only. Re-run with --apply to make these changes.');
})().then(() => process.exit(0)).catch((e) => { console.error(`[FAIL] ${e.message}`); process.exit(1); });
