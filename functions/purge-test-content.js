#!/usr/bin/env node
'use strict';
/**
 * functions/purge-test-content.js — clear test content out of QA-SCHOOL-01 (LIVE dev project)
 *
 *   node purge-test-content.js            dry run: list what would be removed
 *   node purge-test-content.js --apply    remove it, then re-check
 *
 * Keeps the QA accounts (seed-test-accounts.js) and the seeded curriculum
 * lessons (seed-curriculum.js, ids qa-lsn-*). Removes:
 *   1. every other lesson under schools/QA-SCHOOL-01/classes/{c}/subjects/{s}/lessons
 *      (lessons made in the builder while testing, leftover qa-probe-* lessons),
 *      with all subcollections (slides, doc, content, private, live_sessions,
 *      responses) and their uploaded images (schools/QA-SCHOOL-01/lessons/{id}/media/)
 *   2. live sessions and student answers left on the kept qa-lsn-* lessons
 *   3. work_answer_keys of QA-SCHOOL-01 whose lesson no longer exists
 *   4. livePresence/QA-SCHOOL-01 in the Realtime Database
 *
 * Target: dev-school-grade-tracker ONLY. Auth: Application Default Credentials.
 * Refuses to run unless schools/QA-SCHOOL-01 is a tagged QA seed document.
 */

const PROJECT_ID = 'dev-school-grade-tracker';
const requested = process.env.QA_PROJECT_ID || PROJECT_ID;
if (requested !== PROJECT_ID) {
    console.error(`[FAIL] Refusing to run against "${requested}". Only ${PROJECT_ID} is allowed.`);
    process.exit(2);
}
for (const v of ['FIRESTORE_EMULATOR_HOST', 'FIREBASE_AUTH_EMULATOR_HOST', 'FIREBASE_DATABASE_EMULATOR_HOST', 'FIREBASE_STORAGE_EMULATOR_HOST', 'FIREBASE_EMULATOR_HUB']) delete process.env[v];
process.env.GOOGLE_CLOUD_PROJECT = PROJECT_ID;
process.env.GCLOUD_PROJECT = PROJECT_ID;

const { initializeApp, applicationDefault } = require('firebase-admin/app');
const { getFirestore } = require('firebase-admin/firestore');
const { getStorage } = require('firebase-admin/storage');
const { getDatabase } = require('firebase-admin/database');

const app = initializeApp({
    projectId: PROJECT_ID,
    credential: applicationDefault(),
    storageBucket: `${PROJECT_ID}.firebasestorage.app`,
    databaseURL: `https://${PROJECT_ID}-default-rtdb.firebaseio.com`,
}, 'qa-purge');
const db = getFirestore(app);

const SCHOOL = 'QA-SCHOOL-01';
const KEEP_LESSON = /^qa-lsn-/;
const APPLY = process.argv.includes('--apply');

let failures = 0;
const info = (m) => console.log(`[INFO] ${m}`);
const pass = (m) => console.log(`[PASS] ${m}`);
const fail = (m) => { failures++; console.log(`[FAIL] ${m}`); };
const plan = (m) => console.log(`${APPLY ? '[DEL ]' : '[DRY ]'} ${m}`);

async function scan() {
    const lessons = []; // { ref, id, title, keep }
    const classes = await db.collection(`schools/${SCHOOL}/classes`).listDocuments();
    for (const c of classes) {
        const subjects = await c.collection('subjects').listDocuments();
        for (const s of subjects) {
            const refs = await s.collection('lessons').listDocuments();
            for (const ref of refs) {
                const snap = await ref.get();
                lessons.push({ ref, id: ref.id, title: snap.exists ? (snap.get('title') || '(untitled)') : '(no lesson doc)', keep: KEEP_LESSON.test(ref.id) && snap.exists });
            }
        }
    }
    const keys = (await db.collection('work_answer_keys').where('schoolId', '==', SCHOOL).get()).docs;
    return { lessons, keys };
}

async function purge() {
    const school = await db.doc(`schools/${SCHOOL}`).get();
    if (!school.exists || school.get('_qaSeed') !== true) {
        throw new Error(`schools/${SCHOOL} is missing or not a QA seed document — refusing to run.`);
    }
    info(`mode=${APPLY ? 'apply' : 'dry-run'} project=${PROJECT_ID} school=${SCHOOL}`);

    const { lessons, keys } = await scan();
    const kept = new Set(lessons.filter((l) => l.keep).map((l) => l.id));
    const bucket = getStorage(app).bucket();

    // 1. test lessons (whole tree + images)
    for (const l of lessons.filter((x) => !x.keep)) {
        plan(`lesson ${l.ref.path}  "${l.title}"`);
        if (!APPLY) continue;
        await db.recursiveDelete(l.ref);
        await bucket.deleteFiles({ prefix: `schools/${SCHOOL}/lessons/${l.id}/` }).catch((e) => fail(`storage ${l.id}: ${e.message}`));
    }

    // 2. sessions + answers on kept lessons
    for (const l of lessons.filter((x) => x.keep)) {
        for (const sub of ['live_sessions', 'responses']) {
            const docs = await l.ref.collection(sub).listDocuments();
            if (!docs.length) continue;
            plan(`${docs.length} ${sub} doc(s) under kept lesson ${l.id}`);
            if (APPLY) await db.recursiveDelete(l.ref.collection(sub));
        }
    }

    // 3. orphaned quiz answer keys
    for (const k of keys.filter((d) => !kept.has(d.get('lessonId')))) {
        plan(`work_answer_keys/${k.id}  (lesson ${k.get('lessonId')})`);
        if (APPLY) await k.ref.delete();
    }

    // 4. presence
    try {
        const node = getDatabase(app).ref(`livePresence/${SCHOOL}`);
        const snap = await node.get();
        if (snap.exists()) {
            plan(`livePresence/${SCHOOL} (${snap.numChildren()} session node(s))`);
            if (APPLY) await node.remove();
        }
    } catch (e) {
        info(`livePresence check skipped: ${e.message}`);
    }

    if (!APPLY) {
        info(`kept lessons: ${[...kept].join(', ') || 'none'}`);
        info('dry run only — re-run with --apply to delete');
        return;
    }

    // Re-check
    const after = await scan();
    const left = after.lessons.filter((l) => !l.keep);
    if (left.length) fail(`${left.length} test lesson(s) survived: ${left.map((l) => l.id).join(', ')}`);
    else pass('no test lessons left');
    for (const l of after.lessons.filter((x) => x.keep)) {
        const n = (await l.ref.collection('live_sessions').listDocuments()).length + (await l.ref.collection('responses').listDocuments()).length;
        if (n) fail(`${l.id} still has ${n} session/answer doc(s)`);
    }
    const keptAfter = new Set(after.lessons.filter((l) => l.keep).map((l) => l.id));
    const orphans = after.keys.filter((d) => !keptAfter.has(d.get('lessonId')));
    if (orphans.length) fail(`${orphans.length} orphaned answer key(s) survived`);
    else pass('no orphaned answer keys');
    pass(`kept seeded lessons: ${[...keptAfter].join(', ') || 'none'}`);
}

purge()
    .then(() => {
        console.log(failures === 0 ? `[TRUE] purge-test-content ${APPLY ? 'apply' : 'dry-run'} OK` : `[FALSE] purge-test-content: ${failures} failure(s)`);
        process.exit(failures === 0 ? 0 : 1);
    })
    .catch((e) => {
        console.error(`[FALSE] ${e.message}`);
        process.exit(1);
    });
