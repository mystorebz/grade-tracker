#!/usr/bin/env node
'use strict';
/**
 * functions/prod-audit-legacy-assignments.js — READ-ONLY audit, PRODUCTION.
 *
 *   node prod-audit-legacy-assignments.js
 *
 * Counts, on school-grade-tracker (production):
 *   • old-style assignments: objects inside a teacher record's subjects[]
 *     (teachers/{id} or schools/{s}/teachers/{id}) instead of their own
 *     assignment documents
 *   • submissions/drafts tied to them, i.e. stored under an assignments/{id}
 *     path whose assignment document does not exist, or (student-level
 *     submissions) pointing at an old-style id / a missing assignment document
 *
 * ZERO WRITES. This file only calls .get() / getAll(); there is no set,
 * update, delete, batch or transaction anywhere in it.
 * Auth: Application Default Credentials (your gcloud login needs read access
 * to the production project).
 */
const PROJECT_ID = 'school-grade-tracker';
for (const v of ['FIRESTORE_EMULATOR_HOST', 'FIREBASE_AUTH_EMULATOR_HOST', 'FIREBASE_EMULATOR_HUB']) delete process.env[v];
process.env.GOOGLE_CLOUD_PROJECT = PROJECT_ID;
process.env.GCLOUD_PROJECT = PROJECT_ID;

const { initializeApp, applicationDefault } = require('firebase-admin/app');
const { getFirestore } = require('firebase-admin/firestore');
const app = initializeApp({ projectId: PROJECT_ID, credential: applicationDefault() }, 'prod-readonly-audit');
const db = getFirestore(app);

const latest = (a, b) => (!a ? b : !b ? a : (String(a) > String(b) ? a : b));

(async () => {
    console.log(`READ-ONLY audit — project ${PROJECT_ID}\n`);

    // ── 1. Old-style assignments inside teacher records ─────────────────────
    const legacyIds = new Set();
    const perSchool = new Map(); // schoolId -> { teachers, assignments }
    let teacherRecords = 0, legacyAssignments = 0;
    const teachers = await db.collectionGroup('teachers').get();
    for (const t of teachers.docs) {
        const subjects = t.get('subjects');
        if (!Array.isArray(subjects)) continue;
        const n = subjects.reduce((sum, s) => sum + (s && Array.isArray(s.assignments) ? s.assignments.length : 0), 0);
        if (!n) continue;
        teacherRecords++;
        legacyAssignments += n;
        subjects.forEach(s => (s && Array.isArray(s.assignments) ? s.assignments : []).forEach(a => { if (a && a.id) legacyIds.add(String(a.id)); }));
        const seg = t.ref.path.split('/');
        const schoolId = seg[0] === 'schools' ? seg[1] : (t.get('currentSchoolId') || '(no current school)');
        const row = perSchool.get(schoolId) || { teachers: 0, assignments: 0 };
        row.teachers++; row.assignments += n;
        perSchool.set(schoolId, row);
    }

    // ── 2. Submissions / drafts tied to them ────────────────────────────────
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

    const tally = { submissions: 0, drafts: 0, students: new Set(), graded: 0, newest: '' };
    const subsPerSchool = new Map();
    const bump = (schoolId) => subsPerSchool.set(schoolId, (subsPerSchool.get(schoolId) || 0) + 1);

    for (const group of ['submissions', 'drafts']) {
        const snap = await db.collectionGroup(group).get();
        for (const d of snap.docs) {
            const seg = d.ref.path.split('/');
            let tied = false, schoolId = '';
            if (seg.length === 10 && seg[0] === 'schools' && seg[6] === 'assignments') {
                schoolId = seg[1];
                tied = !(await assignmentExists(seg.slice(0, 8).join('/')));
            } else if (group === 'submissions' && seg.length === 4 && seg[0] === 'students') {
                const { classId, subjectId, assignmentId } = d.data();
                if (classId && subjectId && assignmentId) {
                    schoolId = await schoolOf(seg[1]);
                    tied = !!schoolId && !(await assignmentExists(`schools/${schoolId}/classes/${classId}/subjects/${subjectId}/assignments/${assignmentId}`));
                } else {
                    tied = !!assignmentId && legacyIds.has(String(assignmentId));
                    schoolId = tied ? await schoolOf(seg[1]) : '';
                }
            }
            if (!tied) continue;
            tally[group]++;
            if (group === 'submissions') {
                bump(schoolId || '(unknown school)');
                tally.students.add(d.get('studentId') || seg[seg.length - 1]);
                if (d.get('status') === 'graded') tally.graded++;
                tally.newest = latest(tally.newest, d.get('submittedAt') || d.get('updatedAt') || '');
            }
        }
    }

    // ── 3. Report ───────────────────────────────────────────────────────────
    console.log('Per school (old-style assignments / tied submissions):');
    const schools = new Set([...perSchool.keys(), ...subsPerSchool.keys()]);
    if (!schools.size) console.log('  (none)');
    [...schools].sort().forEach(s => {
        const r = perSchool.get(s) || { teachers: 0, assignments: 0 };
        console.log(`  ${s}: ${r.assignments} old-style assignment(s) in ${r.teachers} teacher record(s), ${subsPerSchool.get(s) || 0} submission(s)`);
    });
    console.log('\n── TOTALS (production) ──');
    console.log(`Teacher records holding old-style assignments: ${teacherRecords}`);
    console.log(`Old-style assignments:                         ${legacyAssignments}`);
    console.log(`Submissions tied to old-style assignments:     ${tally.submissions}`);
    console.log(`   of which graded:                            ${tally.graded}`);
    console.log(`   distinct students:                          ${tally.students.size}`);
    console.log(`   most recent submission:                     ${tally.newest || '(none)'}`);
    console.log(`Unsent drafts tied to them:                    ${tally.drafts}`);
    console.log('\nRead-only: nothing was written.');
})().then(() => process.exit(0)).catch((e) => { console.error(`[FAIL] ${e.message}`); process.exit(1); });
