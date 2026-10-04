#!/usr/bin/env node
'use strict';
/**
 * functions/migrations/03-lesson-canvas-v3.js — lesson content v2 → canvas schema v3
 *
 *   node migrations/03-lesson-canvas-v3.js --dry-run    print the plan, write nothing
 *   node migrations/03-lesson-canvas-v3.js              apply
 *   node migrations/03-lesson-canvas-v3.js --verify     schema + round-trip checks, exit 1 on any gap
 *   node migrations/03-lesson-canvas-v3.js --cleanup    roll back to v2 (content/main.slides)
 *   add --school=QA-SCHOOL-01 to any mode to limit scope
 *
 * Target: dev-school-grade-tracker ONLY. Auth: Application Default Credentials.
 * Prerequisite: migration 02 (lessons carry content/main). Lessons that still
 * have slides on the main doc are reported and skipped.
 *
 * Per lesson (one atomic batch each), using the same converter the app uses
 * (assets/js/lessons/canvas/model.js):
 *   - v2 block percentages → stage units on a fixed 1600×900 stage
 *     (x·16, y·9, w·16, h·9), rotation 0, opacity 1
 *   - sequential fractional z keys in the existing block order ('a0','a1',…)
 *   - lessons/{id}/slides/{slideId}  one doc per slide
 *     (collaborative boards → kind 'board'; pre-redesign slide types → kind 'legacy', verbatim)
 *   - lessons/{id}/doc/main          Document-format lessons ({ html, blockId })
 *   - lessons/{id}/content/main      { schemaVersion: 3, stage, theme, slideOrder, updatedAt }
 *   - lessons/{id}/content/v2_backup { slides, theme, updatedAt } (kept for --cleanup safety)
 *   - lessons/{id}                   contentVersion: 3, slideCount
 * Everything written is tagged _mig03. --cleanup rebuilds v2 from the CURRENT
 * v3 docs (so edits made after migrating are kept), then removes the v3 docs.
 */

const fs = require('node:fs');
const path = require('node:path');

const PROJECT_ID = 'dev-school-grade-tracker';
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

const app = initializeApp({ projectId: PROJECT_ID, credential: applicationDefault() }, 'mig-03');
const db = getFirestore(app);
db.settings({ ignoreUndefinedProperties: true });

const argv = process.argv.slice(2);
const MODE = argv.includes('--cleanup') ? 'cleanup' : argv.includes('--verify') ? 'verify' : argv.includes('--dry-run') ? 'dry-run' : 'apply';
const SCHOOL = (argv.find((a) => a.startsWith('--school=')) || '').split('=')[1] || null;
const TAG = '_mig03';

const log = (m) => console.log(m);
const sample = (arr, n = 10) => arr.slice(0, n).map((x) => `         ${x}`).join('\n');

// The browser module is plain ESM with no imports — load it as-is so the
// migration and the app share one converter.
const MODEL_PATH = path.resolve(__dirname, '../../assets/js/lessons/canvas/model.js');
async function loadModel() {
    const src = fs.readFileSync(MODEL_PATH, 'utf8');
    return import('data:text/javascript;base64,' + Buffer.from(src, 'utf8').toString('base64'));
}

async function loadLessons() {
    const snap = await db.collectionGroup('lessons').get();
    return snap.docs.filter((d) => {
        const p = d.ref.path.split('/');
        return p.length === 8 && p[0] === 'schools' && p[2] === 'classes' && p[4] === 'subjects' && p[6] === 'lessons'
            && (!SCHOOL || p[1] === SCHOOL);
    });
}

const contentRef = (lessonRef) => lessonRef.collection('content').doc('main');
const backupRef = (lessonRef) => lessonRef.collection('content').doc('v2_backup');
const docMainRef = (lessonRef) => lessonRef.collection('doc').doc('main');
const slideRef = (lessonRef, id) => lessonRef.collection('slides').doc(id);
const fmt = (lesson) => (lesson.get('format') === 'document' ? 'document' : 'slides');
const strip = ({ updatedAt, _mig03, ...rest }) => rest;

async function apply(M) {
    log(`[INFO] mode=${MODE} project=${PROJECT_ID} scope=${SCHOOL || 'ALL schools'} stage=${M.STAGE.w}x${M.STAGE.h}`);
    const lessons = await loadLessons();
    const plan = [], already = [], notSplit = [], invalid = [];
    for (let i = 0; i < lessons.length; i += 200) {
        const chunk = lessons.slice(i, i + 200);
        const contents = await db.getAll(...chunk.map((d) => contentRef(d.ref)));
        chunk.forEach((d, j) => {
            const c = contents[j];
            if (Array.isArray(d.get('slides'))) { notSplit.push(d.ref.path); return; }
            if (!c.exists) { notSplit.push(`${d.ref.path} (no content/main)`); return; }
            if (c.get('schemaVersion') === M.SCHEMA_VERSION) { already.push(d.ref.path); return; }
            const v2 = Array.isArray(c.get('slides')) ? c.get('slides') : [];
            const conv = M.v2ToV3Content(v2, { theme: c.get('theme') || 'general', format: fmt(d) });
            const errs = conv.slides.flatMap((s) => M.validateSlide(s).errors.map((e) => `${s.id}: ${e}`));
            if (errs.length) { invalid.push(`${d.ref.path}: ${errs.slice(0, 3).join('; ')}`); return; }
            plan.push({ lesson: d, content: c, v2, conv });
        });
    }
    const objects = plan.reduce((n, p) => n + p.conv.slides.reduce((m, s) => m + s.objects.length, 0), 0);
    log(`[PLAN] lessons scanned: ${lessons.length}, to convert: ${plan.length} (${plan.reduce((n, p) => n + p.conv.slides.length, 0)} slide docs, ${objects} objects), already v3: ${already.length}`);
    if (plan.length) log(sample(plan.map((p) => `~ ${p.lesson.ref.path} "${p.lesson.get('title') || ''}" ${fmt(p.lesson)} → ${p.conv.slides.length} slide doc(s)${p.conv.doc ? ' + doc/main' : ''}`)));
    if (notSplit.length) log(`[SKIP] ${notSplit.length} lesson(s) not on the split model yet — run migrations/02-lesson-content.js first:\n${sample(notSplit)}`);
    if (invalid.length) log(`[WARN] ${invalid.length} lesson(s) failed validation, skipped:\n${sample(invalid)}`);
    if (MODE === 'dry-run') { log('[DONE] dry run — nothing written'); return 0; }

    let done = 0, failed = 0;
    for (const p of plan) {
        const now = new Date().toISOString();
        const ref = p.lesson.ref;
        const batch = db.batch();
        batch.set(backupRef(ref), { slides: p.v2, theme: p.content.get('theme') || 'general', updatedAt: p.content.get('updatedAt') || now, [TAG]: true });
        p.conv.slides.forEach((s) => batch.set(slideRef(ref, s.id), { ...s, updatedAt: now, [TAG]: true }));
        if (p.conv.doc) batch.set(docMainRef(ref), { ...p.conv.doc, updatedAt: now, [TAG]: true });
        batch.set(contentRef(ref), { ...p.conv.content, updatedAt: p.content.get('updatedAt') || now, [TAG]: true }); // full replace
        batch.update(ref, { contentVersion: M.SCHEMA_VERSION, slideCount: p.conv.doc ? 1 : p.conv.slides.length, [TAG]: true });
        try { await batch.commit(); done++; } catch (e) { failed++; console.error(`[FAIL] ${ref.path}: ${e.message}`); }
    }
    log(failed ? `[FAIL] ${failed} lesson(s) failed, ${done} converted` : `[DONE] ${done} lesson(s) converted. Next: --verify`);
    return failed ? 1 : 0;
}

async function verify(M) {
    log(`[INFO] mode=verify project=${PROJECT_ID} scope=${SCHOOL || 'ALL schools'}`);
    const lessons = await loadLessons();
    const problems = [];
    let ok = 0;
    for (const d of lessons) {
        const c = await contentRef(d.ref).get();
        if (!c.exists) { problems.push(`no content/main: ${d.ref.path}`); continue; }
        const content = c.data();
        if (content.schemaVersion !== M.SCHEMA_VERSION) { problems.push(`not v3: ${d.ref.path}`); continue; }
        if (Array.isArray(content.slides)) problems.push(`content/main still has a v2 slides array: ${d.ref.path}`);
        if (!content.stage || content.stage.w !== M.STAGE.w || content.stage.h !== M.STAGE.h) problems.push(`bad stage: ${d.ref.path}`);
        const format = fmt(d);
        const order = Array.isArray(content.slideOrder) ? content.slideOrder : [];
        let slidesById = new Map(), docData = null;
        if (format === 'document') {
            const ds = await docMainRef(d.ref).get();
            if (!ds.exists) problems.push(`missing doc/main: ${d.ref.path}`); else docData = strip(ds.data());
        } else {
            const ss = await d.ref.collection('slides').get();
            slidesById = new Map(ss.docs.map((s) => [s.id, { ...strip(s.data()), id: s.id }]));
            order.forEach((id) => { if (!slidesById.has(id)) problems.push(`slideOrder → missing slides/${id}: ${d.ref.path}`); });
            for (const id of slidesById.keys()) if (!order.includes(id)) problems.push(`orphan slides/${id} not in slideOrder: ${d.ref.path}`);
            for (const s of slidesById.values()) {
                const v = M.validateSlide(s);
                if (!v.ok) problems.push(`invalid slide ${s.id} (${v.errors.slice(0, 2).join('; ')}): ${d.ref.path}`);
            }
        }
        // round trip: v3 → v2 → v3 must be stable (what the editor will write back)
        const v2 = M.v3ToV2Slides({ content, slidesById, doc: docData, format });
        const again = M.v2ToV3Content(v2, { theme: content.theme, format });
        const stored = order.filter((id) => slidesById.has(id)).map((id) => M.slideFingerprint(slidesById.get(id)));
        if (format !== 'document' && JSON.stringify(again.slides.map(M.slideFingerprint)) !== JSON.stringify(stored)) {
            problems.push(`round-trip mismatch: ${d.ref.path}`);
        }
        if (d.get('slideCount') !== (format === 'document' ? 1 : order.length)) problems.push(`slideCount mismatch: ${d.ref.path}`);
        ok++;
    }
    log(`[PASS] lessons checked: ${ok}/${lessons.length}`);
    if (problems.length) { log(`[FAIL] ${problems.length} problem(s):\n${sample(problems, 25)}`); return 1; }
    log('[DONE] verify: all PASS');
    return 0;
}

async function cleanup(M) {
    log(`[INFO] mode=cleanup project=${PROJECT_ID} scope=${SCHOOL || 'ALL schools'}`);
    const lessons = (await loadLessons()).filter((d) => d.get(TAG) === true);
    let restored = 0;
    for (const d of lessons) {
        const c = await contentRef(d.ref).get();
        const content = c.exists ? c.data() : null;
        const format = fmt(d);
        const ss = await d.ref.collection('slides').get();
        const ds = await docMainRef(d.ref).get();
        const slidesById = new Map(ss.docs.map((s) => [s.id, { ...strip(s.data()), id: s.id }]));
        const v2 = content && content.schemaVersion === M.SCHEMA_VERSION
            ? M.v3ToV2Slides({ content, slidesById, doc: ds.exists ? strip(ds.data()) : null, format })
            : ((await backupRef(d.ref).get()).get('slides') || []);
        const batch = db.batch();
        batch.set(contentRef(d.ref), { slides: v2, theme: (content && content.theme) || 'general', updatedAt: new Date().toISOString() });
        ss.docs.forEach((s) => batch.delete(s.ref));
        batch.delete(docMainRef(d.ref));
        batch.delete(backupRef(d.ref));
        batch.update(d.ref, { contentVersion: 2, slideCount: v2.length, [TAG]: FieldValue.delete() });
        await batch.commit();
        restored++;
    }
    log(`[DONE] rolled back ${restored} lesson(s) to v2`);
    return 0;
}

loadModel()
    .then((M) => (MODE === 'verify' ? verify(M) : MODE === 'cleanup' ? cleanup(M) : apply(M)))
    .then((code) => process.exit(code))
    .catch((e) => { console.error(`[FAIL] 03-lesson-canvas-v3: ${e.stack || e.message}`); process.exit(1); });
