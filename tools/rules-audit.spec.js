'use strict';
/**
 * tools/rules-audit.spec.js — RBAC role-isolation audit of ../firestore.rules
 *
 *   node --test tools/rules-audit.spec.js
 *
 * Requires: emulators running (`npm run emulators`) and the diagnostic accounts
 * seeded (`node tools/seed_accounts.js`). Every authenticated context is built
 * from the REAL custom claims read back from the Auth emulator for each seeded
 * account, so this suite fails if seeding drifts from production claim shapes.
 *
 * Read-only against shared emulator data: never calls clearFirestore(), never
 * writes outside the DIAG-* fixtures. Every write probe below is expected to be
 * denied (and therefore never lands), except where noted.
 *
 * Tests marked `todo` assert the INTENDED policy for known gaps in the current
 * rules. They run and report, but do not fail the suite.
 */

const { test, describe, before, after } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { initializeTestEnvironment, assertSucceeds, assertFails } = require('@firebase/rules-unit-testing');
const { IDS, ACCOUNTS, PROJECT_ID, EMU, getAdmin } = require('./seed_accounts.js');

const RULES_PATH = path.join(__dirname, '..', 'firestore.rules');
const [FS_HOST, FS_PORT] = EMU.firestore.replace(/^\[|\]/g, '').split(/:(?=\d+$)/);

const A = IDS.schoolA;
const B = IDS.schoolB;
const p = {
    adminsA: `schools/${A}/admins/${IDS.adminA}`,
    adminsB: `schools/${B}/admins/${IDS.adminB}`,
    semesterB: `schools/${B}/semesters/${IDS.semesterB}`,
    classA1: `schools/${A}/classes/${IDS.classA1}`,
    classA2: `schools/${A}/classes/${IDS.classA2}`,
    classA1Attendance: `schools/${A}/classes/${IDS.classA1}/attendance/${IDS.attDate}`,
    postA1: `schools/${A}/classes/${IDS.classA1}/subjects/${IDS.subjectA1}/posts/DIAG-PROBE-POST`,
    student: `students/${IDS.student}`,
    studentGradeNew: `students/${IDS.student}/grades/DIAG-PROBE-GRADE`,
    studentSubmission: `students/${IDS.student}/submissions/${IDS.submission1}`,
    classmateSubmission: `students/${IDS.classmate}/submissions/${IDS.submission2}`,
    studentAttendance: `students/${IDS.student}/attendance/${IDS.attDate}`,
    classmateAttendance: `students/${IDS.classmate}/attendance/${IDS.attDate}`,
    outsiderAttendance: `students/${IDS.outsider}/attendance/${IDS.attDate}`,
    parent: `parents/${IDS.parent}`,
    otherParent: `parents/${IDS.otherParent}`,
    unlisted: 'diag_unlisted_collection/DIAG-PROBE',
};

let testEnv;
const as = {}; // role key -> Firestore (compat) bound to that role's real claims

before(async () => {
    testEnv = await initializeTestEnvironment({
        projectId: PROJECT_ID,
        firestore: { rules: fs.readFileSync(RULES_PATH, 'utf8'), host: FS_HOST, port: Number(FS_PORT) },
    });

    const { auth, db } = getAdmin();
    const school = await db.doc(`schools/${A}`).get();
    assert.ok(school.exists, `fixture schools/${A} missing — run: node tools/seed_accounts.js`);

    for (const acct of ACCOUNTS) {
        const user = await auth.getUser(acct.uid).catch(() => null);
        assert.ok(user, `seed account ${acct.key} (${acct.uid}) missing — run: node tools/seed_accounts.js`);
        const claims = user.customClaims || {};
        assert.equal(claims.role, acct.key, `seed account ${acct.key} carries role "${claims.role}"`);
        as[acct.key] = testEnv.authenticatedContext(acct.uid, claims).firestore();
    }
    as.anon = testEnv.unauthenticatedContext().firestore();
});

after(async () => {
    if (testEnv) await testEnv.cleanup(); // releases client apps only; data untouched
});

const read = (db, docPath) => db.doc(docPath).get();
const write = (db, docPath, data) => db.doc(docPath).set({ _diagnostic: true, ...data });

// ── 1. Tenant isolation (schoolId claim) ───────────────────────────────────
describe('tenant isolation', () => {
    test('super_admin reads own school admins', () => assertSucceeds(read(as.super_admin, p.adminsA)));
    test('super_admin denied other school admins', () => assertFails(read(as.super_admin, p.adminsB)));
    test('sub_admin reads own school admins', () => assertSucceeds(read(as.sub_admin, p.adminsA)));
    test('sub_admin denied other school semesters', () => assertFails(read(as.sub_admin, p.semesterB)));
    test('teacher denied other school semesters', () => assertFails(read(as.teacher, p.semesterB)));
    test('student denied other school admins', () => assertFails(read(as.student, p.adminsB)));
    test('parent denied other school semesters', () => assertFails(read(as.parent, p.semesterB)));
});

// ── 2. Per-class isolation (teacherIds / student classId) ─────────────────
describe('class isolation', () => {
    test('teacher reads assigned class', () => assertSucceeds(read(as.teacher, p.classA1)));
    test('teacher denied unassigned class', () => assertFails(read(as.teacher, p.classA2)));
    test('student reads own class', () => assertSucceeds(read(as.student, p.classA1)));
    test('student denied other class', () => assertFails(read(as.student, p.classA2)));
    test('super_admin reads any class in own school', () => assertSucceeds(read(as.super_admin, p.classA2)));
});

// ── 3. Attendance privacy ──────────────────────────────────────────────────
describe('attendance privacy', () => {
    test('teacher reads assigned class attendance', () => assertSucceeds(read(as.teacher, p.classA1Attendance)));
    test('student denied class-wide attendance', () => assertFails(read(as.student, p.classA1Attendance)));
    test('parent denied class-wide attendance', () => assertFails(read(as.parent, p.classA1Attendance)));
    test('student reads own fanned-out attendance', () => assertSucceeds(read(as.student, p.studentAttendance)));
    test('student denied classmate attendance', () => assertFails(read(as.student, p.classmateAttendance)));
    test('parent reads linked child attendance', () => assertSucceeds(read(as.parent, p.studentAttendance)));
    test('parent denied unlinked student attendance', () => assertFails(read(as.parent, p.outsiderAttendance)));
    test('student cannot write own attendance', () => assertFails(write(as.student, p.studentAttendance, { status: 'present' })));
});

// ── 4. Submissions ─────────────────────────────────────────────────────────
describe('submissions', () => {
    test('student reads own submission', () => assertSucceeds(read(as.student, p.studentSubmission)));
    test('student denied classmate submission', () => assertFails(read(as.student, p.classmateSubmission)));
    test('teacher reads same-school submission', () => assertSucceeds(read(as.teacher, p.studentSubmission)));
    test('parent reads linked child submission', () => assertSucceeds(read(as.parent, p.studentSubmission)));
    test('parent denied unlinked submission', () => assertFails(read(as.parent, p.classmateSubmission)));
});

// ── 5. Parent is read-only, self-scoped ────────────────────────────────────
describe('parent', () => {
    test('parent reads own parent doc', () => assertSucceeds(read(as.parent, p.parent)));
    test('parent denied other parent doc', () => assertFails(read(as.parent, p.otherParent)));
    test('parent reads linked student profile', () => assertSucceeds(read(as.parent, p.student)));
    test('parent cannot create grades', () => assertFails(write(as.parent, p.studentGradeNew, { score: 10, max: 10 })));
    test('parent cannot update student profile', () => assertFails(as.parent.doc(p.student).update({ name: 'tampered' })));
    test('parent cannot write own parent doc', () => assertFails(as.parent.doc(p.parent).update({ name: 'tampered' })));
});

// ── 6. Unauthenticated + default deny ──────────────────────────────────────
describe('unauthenticated', () => {
    test('anon denied school admins', () => assertFails(read(as.anon, p.adminsA)));
    test('anon denied parent doc', () => assertFails(read(as.anon, p.parent)));
    test('anon denied class doc', () => assertFails(read(as.anon, p.classA1)));
    test('anon denied class attendance', () => assertFails(read(as.anon, p.classA1Attendance)));
    test('anon denied submissions', () => assertFails(read(as.anon, p.studentSubmission)));
    test('unlisted collection denied to every role', async () => {
        for (const key of ['super_admin', 'sub_admin', 'teacher', 'student', 'parent', 'anon']) {
            await assertFails(read(as[key], p.unlisted));
        }
    });
});

// ── 7. Known gaps (intended policy; reported, non-blocking) ────────────────
describe('known gaps', () => {
    test('student denied school admin records', { todo: 'schools/{id}/admins grants any same-school caller' },
        () => assertFails(read(as.student, p.adminsA)));
    test('student cannot create class-stream posts', { todo: 'posts grant write to any same-school caller' },
        () => assertFails(write(as.student, p.postA1, { title: 'probe' })));
});
