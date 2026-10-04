#!/usr/bin/env node
'use strict';
/**
 * functions/migrations/02-lesson-content.js — split lesson docs (contentVersion 2)
 *
 *   node migrations/02-lesson-content.js --dry-run    print the plan, write nothing
 *   node migrations/02-lesson-content.js              apply
 *   node migrations/02-lesson-content.js --verify     every lesson split, exit 1 on any gap
 *   node migrations/02-lesson-content.js --cleanup    roll back (slides/theme back onto the lesson doc)
 *   add --school=QA-SCHOOL-01 to any mode to limit scope
 *
 * Target: dev-school-grade-tracker by default; production (school-grade-tracker)
 *   only with --prod (+ --confirm-production for apply/cleanup). Auth: ADC.
 *
 * For every schools/{s}/classes/{c}/subjects/{sub}/lessons/{id} that still
 * carries `slides` on the main doc:
 *   lessons/{id}/content/main  ← { slides, theme, updatedAt, _mig02: true }
 *   lessons/{id}               ← slideCount, contentVersion: 2, _mig02: true; slides/theme removed
 * One batch per lesson (atomic per lesson). Idempotent: already-split lessons
 * are skipped. The app reads both shapes, so the migration can run at any time.
 */

// Default target is dev. Production only with --prod; any mode that WRITES on
// production (apply, cleanup) also needs --confirm-production. --dry-run and
// --verify only read.
const ON_PROD = process.argv.includes('--prod');
const PROJECT_ID = ON_PROD ? 'school-grade-tracker' : 'dev-school-grade-tracker';
if (ON_PROD && !process.argv.includes('--dry-run') && !process.argv.includes('--verify') &&
    !process.argv.includes('--confirm-production')) {
    console.error('[FAIL] Writing to PRODUCTION needs --confirm-production. Nothing was written.');
    process.exit(2);
}
const requested = process.env.QA_PROJECT_ID || PROJECT_ID;
if (requested !== PROJECT_ID) {
    console.error(`[FAIL] Refusing to run against "${requested}". Only ${PROJECT_ID} is allowed.`);
    process.exit(2);
}
for (const v of ['FIRESTORE_EMULATOR_HOST', 'FIREBASE_AUTH_EMULATOR_HOST', 'FIREBASE_EMULATOR_HUB']) delete process.env[v];
process.env.GOOGLE_CLOUD_PROJECT = PROJECT_ID;
process.env.GCLOUD_PROJECT = PROJECT_ID;

const { initializeApp, applicationDefault } = require('firebase-admin/app');
const { getFirestore, FieldValue } = require('firebase-admin/firestore');

const app = initializeApp({ projectId: PROJECT_ID, credential: applicationDefault() }, 'mig-02');
const db = getFirestore(app);
db.settings({ ignoreUndefinedProperties: true });

const argv = process.argv.slice(2);
const MODE = argv.includes('--cleanup') ? 'cleanup' : argv.includes('--verify') ? 'verify' : argv.includes('--dry-run') ? 'dry-run' : 'apply';
const SCHOOL = (argv.find((a) => a.startsWith('--school=')) || '').split('=')[1] || null;
const TAG = '_mig02';
const MAX_DOC_BYTES = 1_000_000; // Firestore hard limit is 1 MiB per document

const log = (m) => console.log(m);
const sample = (arr, n = 10) => arr.slice(0, n).map((x) => `         ${x}`).join('\n');

// schools/{s}/classes/{c}/subjects/{sub}/lessons/{id}
async function loadLessons() {
    const snap = await db.collectionGroup('lessons').get();
    return snap.docs.filter((d) => {
        const p = d.ref.path.split('/');
        return p.length === 8 && p[0] === 'schools' && p[2] === 'classes' && p[4] === 'subjects' && p[6] === 'lessons'
            && (!SCHOOL || p[1] === SCHOOL);
    });
}

const contentRef = (lessonRef) => lessonRef.collection('content').doc('main');
const approxBytes = (v) => Buffer.byteLength(JSON.stringify(v ?? null), 'utf8');

async function apply() {
    log(`[INFO] mode=${MODE} project=${PROJECT_ID} scope=${SCHOOL || 'ALL schools'}`);
    const lessons = await loadLessons();
    const todo = lessons.filter((d) => Array.isArray(d.get('slides')));
    const tooBig = todo.filter((d) => approxBytes({ slides: d.get('slides'), theme: d.get('theme') }) > MAX_DOC_BYTES);
    log(`[PLAN] lessons scanned: ${lessons.length}, to split: ${todo.length}, already split: ${lessons.length - todo.length}`);
    if (todo.length) log(sample(todo.map((d) => `~ ${d.ref.path} "${d.get('title') || ''}" (${d.get('slides').length} slides, ~${Math.round(approxBytes(d.get('slides')) / 1024)} KB)`)));
    if (tooBig.length) log(`[WARN] ${tooBig.length} lesson(s) exceed 1 MB of content and will be skipped:\n${sample(tooBig.map((d) => d.ref.path))}`);
    if (MODE === 'dry-run') { log('[DONE] dry run — nothing written'); return 0; }

    let done = 0, failed = 0;
    for (const d of todo) {
        if (tooBig.includes(d)) continue;
        const slides = d.get('slides');
        const now = new Date().toISOString();
        const batch = db.batch();
        batch.set(contentRef(d.ref), { slides, theme: d.get('theme') || 'general', updatedAt: d.get('updatedAt') || now, [TAG]: true });
        batch.update(d.ref, {
            slideCount: slides.length,
            contentVersion: 2,
            slides: FieldValue.delete(),
            theme: FieldValue.delete(),
            [TAG]: true,
        });
        try { await batch.commit(); done++; } catch (e) { failed++; console.error(`[FAIL] ${d.ref.path}: ${e.message}`); }
    }
    log(failed ? `[FAIL] ${failed} lesson(s) failed, ${done} split` : `[DONE] ${done} lesson(s) split. Next: --verify`);
    return failed ? 1 : 0;
}

async function verify() {
    log(`[INFO] mode=verify project=${PROJECT_ID} scope=${SCHOOL || 'ALL schools'}`);
    const lessons = await loadLessons();
    const problems = [];
    for (let i = 0; i < lessons.length; i += 200) {
        const chunk = lessons.slice(i, i + 200);
        const contents = await db.getAll(...chunk.map((d) => contentRef(d.ref)));
        chunk.forEach((d, j) => {
            const c = contents[j];
            if (Array.isArray(d.get('slides'))) problems.push(`slides still on main doc: ${d.ref.path}`);
            if (!c.exists || !Array.isArray(c.get('slides'))) problems.push(`missing content/main: ${d.ref.path}`);
            else if (Number.isInteger(d.get('slideCount')) && d.get('slideCount') !== c.get('slides').length) problems.push(`slideCount mismatch: ${d.ref.path}`);
        });
    }
    log(`[PASS] lessons checked: ${lessons.length}`);
    if (problems.length) { log(`[FAIL] ${problems.length} problem(s):\n${sample(problems, 25)}`); return 1; }
    log('[DONE] verify: all PASS');
    return 0;
}

async function cleanup() {
    log(`[INFO] mode=cleanup project=${PROJECT_ID} scope=${SCHOOL || 'ALL schools'}`);
    const lessons = (await loadLessons()).filter((d) => d.get(TAG) === true);
    let restored = 0;
    for (const d of lessons) {
        const c = await contentRef(d.ref).get();
        const batch = db.batch();
        if (c.exists) {
            // restore the CURRENT content (may include edits made after the split)
            batch.update(d.ref, { slides: c.get('slides') || [], theme: c.get('theme') || 'general' });
            batch.delete(c.ref);
        }
        batch.update(d.ref, { slideCount: FieldValue.delete(), contentVersion: FieldValue.delete(), [TAG]: FieldValue.delete() });
        await batch.commit();
        restored++;
    }
    log(`[DONE] rolled back ${restored} lesson(s)`);
    return 0;
}

const run = MODE === 'verify' ? verify : MODE === 'cleanup' ? cleanup : apply;
run().then((code) => process.exit(code)).catch((e) => {
    console.error(`[FAIL] 02-lesson-content: ${e.stack || e.message}`);
    process.exit(1);
});
