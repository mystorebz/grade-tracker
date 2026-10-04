#!/usr/bin/env node
'use strict';
/**
 * functions/prod-audit-migrations.js — READ-ONLY audit, PRODUCTION.
 *
 *   node prod-audit-migrations.js
 *
 * Counts how much production data is still in the shape that
 * functions/migrations/01–03 convert (those scripts are dev-locked and have
 * not been run on production):
 *   01  teacher subjects[] entries with no per-class subject document
 *       grades missing classId or subjectId
 *   02  lessons that still carry `slides` on the lesson document
 *   03  lessons not on canvas schema v3 (contentVersion !== 3)
 *
 * ZERO WRITES: only .get() calls. Auth: Application Default Credentials.
 */
const PROJECT_ID = 'school-grade-tracker';
for (const v of ['FIRESTORE_EMULATOR_HOST', 'FIREBASE_AUTH_EMULATOR_HOST', 'FIREBASE_EMULATOR_HUB']) delete process.env[v];
process.env.GOOGLE_CLOUD_PROJECT = PROJECT_ID;
process.env.GCLOUD_PROJECT = PROJECT_ID;

const { initializeApp, applicationDefault } = require('firebase-admin/app');
const { getFirestore } = require('firebase-admin/firestore');
const app = initializeApp({ projectId: PROJECT_ID, credential: applicationDefault() }, 'prod-audit-migrations');
const db = getFirestore(app);

(async () => {
    console.log(`READ-ONLY migration audit — project ${PROJECT_ID}\n`);

    // ── 01a: subjects ───────────────────────────────────────────────────────
    const perClassSubjects = new Set(); // `${schoolId}|${subjectId}`
    const subjSnap = await db.collectionGroup('subjects').get();
    let perClassCount = 0;
    for (const d of subjSnap.docs) {
        const seg = d.ref.path.split('/');
        if (seg.length === 6 && seg[0] === 'schools' && seg[2] === 'classes') {
            perClassSubjects.add(`${seg[1]}|${seg[5]}`);
            perClassCount++;
        }
    }
    let legacySubjects = 0, legacyMissing = 0, teachersAffected = 0;
    const missingBySchool = new Map();
    const teachers = await db.collectionGroup('teachers').get();
    for (const t of teachers.docs) {
        const subjects = t.get('subjects');
        if (!Array.isArray(subjects) || !subjects.length) continue;
        const seg = t.ref.path.split('/');
        const schoolId = seg[0] === 'schools' ? seg[1] : (t.get('currentSchoolId') || '');
        if (!schoolId) continue;
        let missingHere = 0;
        for (const s of subjects) {
            if (!s || !s.id) continue;
            legacySubjects++;
            if (!perClassSubjects.has(`${schoolId}|${s.id}`)) missingHere++;
        }
        if (missingHere) {
            teachersAffected++;
            legacyMissing += missingHere;
            missingBySchool.set(schoolId, (missingBySchool.get(schoolId) || 0) + missingHere);
        }
    }

    // ── 01b: grades ─────────────────────────────────────────────────────────
    const grades = await db.collectionGroup('grades').get();
    let gradesTotal = 0, gradesMissing = 0;
    const gradesBySchool = new Map();
    for (const g of grades.docs) {
        gradesTotal++;
        if (!g.get('classId') || !g.get('subjectId')) {
            gradesMissing++;
            const s = g.get('schoolId') || '(no schoolId)';
            gradesBySchool.set(s, (gradesBySchool.get(s) || 0) + 1);
        }
    }

    // ── 02 / 03: lessons ────────────────────────────────────────────────────
    const lessons = await db.collectionGroup('lessons').get();
    let lessonsTotal = 0, needs02 = 0, needs03 = 0;
    for (const l of lessons.docs) {
        const seg = l.ref.path.split('/');
        if (!(seg.length === 8 && seg[0] === 'schools' && seg[2] === 'classes' && seg[6] === 'lessons')) continue;
        lessonsTotal++;
        if (Array.isArray(l.get('slides'))) needs02++;
        if (l.get('contentVersion') !== 3) needs03++;
    }

    // ── Report ──────────────────────────────────────────────────────────────
    console.log('01  Subjects');
    console.log(`    Per-class subject documents:                 ${perClassCount}`);
    console.log(`    Teacher subject-list entries:                ${legacySubjects}`);
    console.log(`    …with NO per-class subject document:         ${legacyMissing} (in ${teachersAffected} teacher record(s))`);
    [...missingBySchool].sort().forEach(([s, n]) => console.log(`        ${s}: ${n}`));
    console.log('01  Grades');
    console.log(`    Grades total:                                ${gradesTotal}`);
    console.log(`    …missing classId or subjectId:               ${gradesMissing}`);
    [...gradesBySchool].sort().forEach(([s, n]) => console.log(`        ${s}: ${n}`));
    console.log('02/03  Lessons');
    console.log(`    Lessons total:                               ${lessonsTotal}`);
    console.log(`    …still with slides on the lesson doc (02):   ${needs02}`);
    console.log(`    …not on canvas v3 (03):                      ${needs03}`);
    console.log('\nRead-only: nothing was written.');
})().then(() => process.exit(0)).catch((e) => { console.error(`[FAIL] ${e.message}`); process.exit(1); });
