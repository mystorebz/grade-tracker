#!/usr/bin/env node
'use strict';
/**
 * functions/prod-wipe-legacy-assignments.js — PRODUCTION cleanup.
 *
 *   node prod-wipe-legacy-assignments.js                       DRY RUN (reads only)
 *   node prod-wipe-legacy-assignments.js --apply --confirm-production --expect=11,2
 *
 * Same logic as dev-final-cleanup.js PART A, pointed at school-grade-tracker:
 *   • removes the `assignments` list from every subject embedded in a teacher
 *     record (teachers/{id} or schools/{s}/teachers/{id}); the subject
 *     entries themselves stay
 *   • deletes submissions/drafts tied to an assignment with no assignment
 *     document (class-level path), and student-level submissions pointing at
 *     a missing assignment document or an old-style id
 *
 * Deliberately NOT included: dev-final-cleanup PART B (moving Stream Question
 * answers). Production still runs the old stream code, which reads answers
 * from the post itself; that move happens with the production deploy.
 *
 * Safety:
 *   • nothing is written without BOTH --apply and --confirm-production
 *   • --expect=<assignments>,<submissions+drafts> must match what the scan
 *     finds right now, or the script stops without writing (guards against
 *     the data having changed since the read-only audit)
 * Auth: Application Default Credentials.
 */
const PROJECT_ID = 'school-grade-tracker';
for (const v of ['FIRESTORE_EMULATOR_HOST', 'FIREBASE_AUTH_EMULATOR_HOST', 'FIREBASE_EMULATOR_HUB']) delete process.env[v];
process.env.GOOGLE_CLOUD_PROJECT = PROJECT_ID;
process.env.GCLOUD_PROJECT = PROJECT_ID;

const { initializeApp, applicationDefault } = require('firebase-admin/app');
const { getFirestore } = require('firebase-admin/firestore');
const app = initializeApp({ projectId: PROJECT_ID, credential: applicationDefault() }, 'prod-wipe-legacy');
const db = getFirestore(app);

const APPLY = process.argv.includes('--apply') && process.argv.includes('--confirm-production');
const expectArg = (process.argv.find(a => a.startsWith('--expect=')) || '').slice('--expect='.length);

(async () => {
    console.log(`prod-wipe-legacy-assignments — ${APPLY ? 'APPLY' : 'DRY RUN'} — ${PROJECT_ID}\n`);

    // ── Scan: old-style assignments ─────────────────────────────────────────
    const legacyIds = new Set();
    const teacherDocs = [];
    let embedded = 0;
    const teachers = await db.collectionGroup('teachers').get();
    for (const t of teachers.docs) {
        const subjects = t.get('subjects');
        if (!Array.isArray(subjects)) continue;
        const n = subjects.reduce((sum, s) => sum + (s && Array.isArray(s.assignments) ? s.assignments.length : 0), 0);
        if (!n) continue;
        embedded += n;
        subjects.forEach(s => (s && Array.isArray(s.assignments) ? s.assignments : []).forEach(a => { if (a && a.id) legacyIds.add(String(a.id)); }));
        teacherDocs.push({ ref: t.ref, subjects });
        console.log(`[INFO] ${t.ref.path}: ${n} old-style assignment(s)`);
    }

    // ── Scan: submissions / drafts tied to them ─────────────────────────────
    const asgExists = new Map();
    const assignmentExists = async (path) => {
        if (!asgExists.has(path)) asgExists.set(path, (await db.doc(path).get()).exists);
        return asgExists.get(path);
    };
    const studentSchool = new Map();
    const schoolOf = async (sid) => {
        if (!studentSchool.has(sid)) {
            const s = await db.doc(`students/${sid}`).get();
            studentSchool.set(sid, s.exists ? (s.get('currentSchoolId') || '') : '');
        }
        return studentSchool.get(sid);
    };
    const doomed = [];
    for (const group of ['submissions', 'drafts']) {
        const snap = await db.collectionGroup(group).get();
        for (const d of snap.docs) {
            const seg = d.ref.path.split('/');
            if (seg.length === 10 && seg[0] === 'schools' && seg[6] === 'assignments') {
                if (!(await assignmentExists(seg.slice(0, 8).join('/')))) doomed.push(d.ref);
                continue;
            }
            if (group === 'submissions' && seg.length === 4 && seg[0] === 'students') {
                const { classId, subjectId, assignmentId } = d.data();
                if (!(classId && subjectId && assignmentId)) {
                    if (assignmentId && legacyIds.has(String(assignmentId))) doomed.push(d.ref);
                    continue;
                }
                const schoolId = await schoolOf(seg[1]);
                if (schoolId && !(await assignmentExists(`schools/${schoolId}/classes/${classId}/subjects/${subjectId}/assignments/${assignmentId}`))) {
                    doomed.push(d.ref);
                }
            }
        }
    }
    doomed.forEach(r => console.log(`[INFO] tied submission/draft: ${r.path}`));
    console.log(`\nFound: ${embedded} old-style assignment(s) in ${teacherDocs.length} teacher record(s); ${doomed.length} tied submission(s)/draft(s).`);

    if (!APPLY) {
        console.log('\nDry run only — nothing written. To wipe, re-run with:');
        console.log(`  node prod-wipe-legacy-assignments.js --apply --confirm-production --expect=${embedded},${doomed.length}`);
        return;
    }

    // ── Guard: counts must match what the operator approved ─────────────────
    const [expA, expS] = expectArg.split(',').map(x => parseInt(x, 10));
    if (!(expA === embedded && expS === doomed.length)) {
        console.error(`[FAIL] --expect=${expectArg || '(missing)'} does not match the scan (${embedded},${doomed.length}). Nothing was written.`);
        process.exitCode = 1;
        return;
    }

    // ── Write ───────────────────────────────────────────────────────────────
    for (const { ref, subjects } of teacherDocs) {
        const cleaned = subjects.map(s => {
            if (!s || typeof s !== 'object' || !('assignments' in s)) return s;
            const { assignments, ...rest } = s; // eslint-disable-line no-unused-vars
            return rest;
        });
        await ref.update({ subjects: cleaned });
        console.log(`[PASS] cleared old-style assignments from ${ref.path}`);
    }
    for (const r of doomed) {
        await db.recursiveDelete(r);
        console.log(`[PASS] deleted ${r.path}`);
    }

    // ── Verify ──────────────────────────────────────────────────────────────
    const again = await db.collectionGroup('teachers').get();
    const left = again.docs.reduce((sum, t) => {
        const subs = t.get('subjects');
        return sum + (Array.isArray(subs) ? subs.reduce((n, s) => n + (s && Array.isArray(s.assignments) ? s.assignments.length : 0), 0) : 0);
    }, 0);
    let subsLeft = 0;
    for (const r of doomed) if ((await r.get()).exists) subsLeft++;
    console.log(`\n[${left === 0 && subsLeft === 0 ? 'PASS' : 'FAIL'}] Old-style assignments left: ${left}. Tied submissions/drafts left: ${subsLeft}.`);
    if (left || subsLeft) process.exitCode = 1;
})().then(() => process.exit(process.exitCode || 0)).catch((e) => { console.error(`[FAIL] ${e.message}`); process.exit(1); });
