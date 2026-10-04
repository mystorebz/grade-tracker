#!/usr/bin/env node
'use strict';
/**
 * tools/seed_accounts.js — Test-All diagnostic accounts (LOCAL EMULATOR ONLY)
 *
 *   node tools/seed_accounts.js             remove stale diagnostics → seed → verify
 *   node tools/seed_accounts.js --verify    verify custom claims + Firestore profiles
 *   node tools/seed_accounts.js --cleanup   delete every diagnostic Auth user + Firestore doc
 *
 * Env (defaults match `npm run emulators`):
 *   FIRESTORE_EMULATOR_HOST       127.0.0.1:8080
 *   FIREBASE_AUTH_EMULATOR_HOST   127.0.0.1:9099
 *   DIAG_PROJECT_ID               dev-school-grade-tracker
 *
 * Safety:
 *   - Refuses to run unless both emulator hosts are loopback addresses.
 *   - GOOGLE_APPLICATION_CREDENTIALS is unset, so the Admin SDK has no path
 *     to a live project.
 *   - Every document carries `_diagnostic: true` and every ID uses a reserved
 *     prefix (DIAG-, T99-DIAG, S99-DIAG, P99-DIAG) so cleanup never touches
 *     other emulator data (teacher-tests/seed.js fixtures included).
 *   - Profiles carry no email/contactEmail, so the onSchoolCreated /
 *     onTeacherCreated / onStudentCreated / onParentCreated triggers exit
 *     early and send nothing. No class-level attendance doc is written, so
 *     onAttendanceSaved never fires.
 *
 * Claim payloads mirror functions/index.js exactly:
 *   mintAdminToken (super_admin, sub_admin), mintTeacherToken,
 *   mintStudentToken, mintParentToken.
 */

const { isDeepStrictEqual } = require('node:util');

// ── 1. EMULATOR-ONLY GUARD (runs before firebase-admin is ever loaded) ──────
const LOOPBACK = /^(127\.0\.0\.1|localhost|\[::1\]):\d+$/;

const EMU = {
    firestore: process.env.FIRESTORE_EMULATOR_HOST || '127.0.0.1:8080',
    auth: process.env.FIREBASE_AUTH_EMULATOR_HOST || '127.0.0.1:9099',
};
const PROJECT_ID = process.env.DIAG_PROJECT_ID || 'dev-school-grade-tracker';

for (const [name, host] of Object.entries(EMU)) {
    if (!LOOPBACK.test(host)) {
        console.error(`[FAIL] Refusing to run: ${name} emulator host "${host}" is not a loopback address.`);
        process.exit(2);
    }
}
process.env.FIRESTORE_EMULATOR_HOST = EMU.firestore;
process.env.FIREBASE_AUTH_EMULATOR_HOST = EMU.auth;
process.env.GCLOUD_PROJECT = PROJECT_ID;
delete process.env.GOOGLE_APPLICATION_CREDENTIALS;

// ── 2. FIXTURE IDS ──────────────────────────────────────────────────────────
const IDS = Object.freeze({
    schoolA: 'DIAG-SCH-A',
    schoolB: 'DIAG-SCH-B',
    adminA: 'DIAG-ADM-A1',
    adminB: 'DIAG-ADM-B1',
    classA1: 'DIAG-CLS-A1',
    classA2: 'DIAG-CLS-A2',
    subjectA1: 'DIAG-SUBJ-A1',
    semesterB: 'DIAG-SEM-B1',
    teacher: 'T99-DIAG1',
    student: 'S99-DIAG1',   // seeded account: school A, class A1
    classmate: 'S99-DIAG2', // fixture: school A, class A2
    outsider: 'S99-DIAG3',  // fixture: school B
    parent: 'P99-DIAG1',    // seeded account: linked to S99-DIAG1
    otherParent: 'P99-DIAG2',
    submission1: 'DIAG-SUBMISSION-1',
    submission2: 'DIAG-SUBMISSION-2',
    grade1: 'DIAG-GRADE-1',
    attDate: '2026-01-05',
});

const UID_PATTERN = /^(DIAG-|[TSP]99-DIAG)/;
const SCHOOL_A_NAME = 'Diagnostic School A';
const SCHOOL_B_NAME = 'Diagnostic School B';
const TAG = Object.freeze({ _diagnostic: true, _seededBy: 'tools/seed_accounts.js' });

// ── 3. ACCOUNTS (uid + exact production claim shape) ───────────────────────
const ACCOUNTS = Object.freeze([
    {
        key: 'super_admin',
        uid: IDS.schoolA, // mintAdminToken mints super_admin with uid = schoolId
        displayName: 'DIAG Super Admin',
        profile: `schools/${IDS.schoolA}`,
        claims: { role: 'super_admin', schoolId: IDS.schoolA, schoolName: SCHOOL_A_NAME, schoolType: 'Primary' },
    },
    {
        key: 'sub_admin',
        uid: IDS.adminA,
        displayName: 'DIAG Sub Admin',
        profile: `schools/${IDS.schoolA}/admins/${IDS.adminA}`,
        claims: { role: 'sub_admin', schoolId: IDS.schoolA, adminId: IDS.adminA, schoolName: SCHOOL_A_NAME, schoolType: 'Primary' },
    },
    {
        key: 'teacher',
        uid: IDS.teacher,
        displayName: 'DIAG Teacher',
        profile: `teachers/${IDS.teacher}`,
        claims: { role: 'teacher', schoolId: IDS.schoolA, teacherId: IDS.teacher, schoolType: 'Primary', schoolName: SCHOOL_A_NAME },
    },
    {
        key: 'student',
        uid: IDS.student,
        displayName: 'DIAG Student',
        profile: `students/${IDS.student}`,
        claims: { role: 'student', studentId: IDS.student, schoolId: IDS.schoolA, schoolType: 'Primary', schoolName: SCHOOL_A_NAME },
    },
    {
        key: 'parent',
        uid: IDS.parent,
        displayName: 'DIAG Parent',
        profile: `parents/${IDS.parent}`,
        claims: {
            role: 'parent',
            parentId: IDS.parent,
            linkedStudents: [{ studentId: IDS.student, schoolId: IDS.schoolA }],
            linkedSchoolIds: [IDS.schoolA],
        },
    },
]);

// ── 4. FIRESTORE PROFILES + RULES FIXTURES ─────────────────────────────────
const A = IDS.schoolA;
const B = IDS.schoolB;
const DOCS = Object.freeze({
    [`schools/${A}`]: { ...TAG, schoolName: SCHOOL_A_NAME, schoolType: 'Primary', isVerified: true, superAdminId: A },
    [`schools/${B}`]: { ...TAG, schoolName: SCHOOL_B_NAME, schoolType: 'Secondary', isVerified: true },
    [`schools/${A}/admins/${IDS.adminA}`]: { ...TAG, name: 'DIAG Sub Admin A', isArchived: false },
    [`schools/${B}/admins/${IDS.adminB}`]: { ...TAG, name: 'DIAG Sub Admin B', isArchived: false },
    [`schools/${B}/semesters/${IDS.semesterB}`]: { ...TAG, name: 'DIAG Term B', order: 1 },
    [`schools/${A}/classes/${IDS.classA1}`]: { ...TAG, name: 'DIAG Class A1', teacherIds: [IDS.teacher] },
    [`schools/${A}/classes/${IDS.classA2}`]: { ...TAG, name: 'DIAG Class A2', teacherIds: [] },
    [`schools/${A}/classes/${IDS.classA1}/subjects/${IDS.subjectA1}`]: { ...TAG, name: 'DIAG Subject A1' },
    [`teachers/${IDS.teacher}`]: { ...TAG, name: 'DIAG Teacher', currentSchoolId: A, classes: ['DIAG Class A1'], className: 'DIAG Class A1' },
    [`students/${IDS.student}`]: { ...TAG, name: 'DIAG Student', currentSchoolId: A, classId: IDS.classA1, className: 'DIAG Class A1', teacherId: IDS.teacher, enrollmentStatus: 'Active' },
    [`students/${IDS.classmate}`]: { ...TAG, name: 'DIAG Classmate', currentSchoolId: A, classId: IDS.classA2, className: 'DIAG Class A2', enrollmentStatus: 'Active' },
    [`students/${IDS.outsider}`]: { ...TAG, name: 'DIAG Outsider', currentSchoolId: B, enrollmentStatus: 'Active' },
    [`students/${IDS.student}/submissions/${IDS.submission1}`]: { ...TAG, status: 'submitted' },
    [`students/${IDS.classmate}/submissions/${IDS.submission2}`]: { ...TAG, status: 'submitted' },
    [`students/${IDS.student}/attendance/${IDS.attDate}`]: { ...TAG, status: 'present' },
    [`students/${IDS.outsider}/attendance/${IDS.attDate}`]: { ...TAG, status: 'present' },
    [`students/${IDS.student}/grades/${IDS.grade1}`]: { ...TAG, score: 9, max: 10, type: 'Quiz' },
    [`parents/${IDS.parent}`]: { ...TAG, name: 'DIAG Parent', linkedStudents: [{ studentId: IDS.student, schoolId: A }] },
    [`parents/${IDS.otherParent}`]: { ...TAG, name: 'DIAG Other Parent', linkedStudents: [] },
});

// Top-level roots; recursiveDelete() on these removes every nested fixture.
const ROOTS = Object.freeze([
    `schools/${A}`, `schools/${B}`,
    `teachers/${IDS.teacher}`,
    `students/${IDS.student}`, `students/${IDS.classmate}`, `students/${IDS.outsider}`,
    `parents/${IDS.parent}`, `parents/${IDS.otherParent}`,
]);
const SWEEP_COLLECTIONS = Object.freeze(['schools', 'teachers', 'students', 'parents']);

// ── 5. ADMIN SDK (lazy, named app) ──────────────────────────────────────────
let _admin = null;
function getAdmin() {
    if (_admin) return _admin;
    const { initializeApp, getApps } = require('firebase-admin/app');
    const { getAuth } = require('firebase-admin/auth');
    const { getFirestore } = require('firebase-admin/firestore');
    const app = getApps().find(a => a.name === 'diag') || initializeApp({ projectId: PROJECT_ID }, 'diag');
    _admin = { auth: getAuth(app), db: getFirestore(app) };
    return _admin;
}

// ── 6. HELPERS ──────────────────────────────────────────────────────────────
const log = {
    pass: (m) => console.log(`[PASS] ${m}`),
    fail: (m) => console.log(`[FAIL] ${m}`),
    info: (m) => console.log(`[INFO] ${m}`),
};

async function assertEmulatorsUp() {
    for (const [name, host] of Object.entries(EMU)) {
        try {
            await fetch(`http://${host}/`, { signal: AbortSignal.timeout(3000) });
        } catch (e) {
            throw new Error(`${name} emulator not reachable at ${host}. Start it with: npm run emulators`);
        }
    }
}

function isNotFound(e) {
    return e && (e.code === 'auth/user-not-found' || /no user record/i.test(String(e.message)));
}

// ── 7. SEED ─────────────────────────────────────────────────────────────────
async function seed() {
    const { auth, db } = getAdmin();

    for (const acct of ACCOUNTS) {
        try {
            await auth.createUser({ uid: acct.uid, displayName: acct.displayName, disabled: false });
        } catch (e) {
            if (e.code !== 'auth/uid-already-exists') throw e;
            await auth.updateUser(acct.uid, { displayName: acct.displayName, disabled: false });
        }
        await auth.setCustomUserClaims(acct.uid, acct.claims);
        log.pass(`auth user ${acct.key.padEnd(11)} ${acct.uid}`);
    }

    const batch = db.batch();
    for (const [path, data] of Object.entries(DOCS)) batch.set(db.doc(path), data);
    await batch.commit();
    log.pass(`firestore ${Object.keys(DOCS).length} diagnostic documents written (project ${PROJECT_ID})`);
}

// ── 8. VERIFY ───────────────────────────────────────────────────────────────
async function verify() {
    const { auth, db } = getAdmin();
    let failures = 0;

    for (const acct of ACCOUNTS) {
        try {
            const user = await auth.getUser(acct.uid);
            if (isDeepStrictEqual(user.customClaims || {}, acct.claims)) {
                log.pass(`claims ${acct.key.padEnd(11)} role=${acct.claims.role}`);
            } else {
                failures++;
                log.fail(`claims ${acct.key} mismatch: expected ${JSON.stringify(acct.claims)} got ${JSON.stringify(user.customClaims)}`);
            }
        } catch (e) {
            failures++;
            log.fail(`auth user ${acct.key} (${acct.uid}) missing: ${e.message}`);
        }
    }

    const snaps = await db.getAll(...Object.keys(DOCS).map(p => db.doc(p)));
    snaps.forEach((snap) => {
        const path = snap.ref.path;
        if (!snap.exists) { failures++; log.fail(`doc missing ${path}`); return; }
        if (snap.get('_diagnostic') !== true) { failures++; log.fail(`doc untagged ${path}`); return; }
    });
    if (snaps.every(s => s.exists && s.get('_diagnostic') === true)) {
        log.pass(`firestore ${snaps.length}/${snaps.length} diagnostic documents present`);
    }

    for (const acct of ACCOUNTS) {
        const snap = await db.doc(acct.profile).get();
        if (snap.exists) log.pass(`profile ${acct.key.padEnd(10)} ${acct.profile}`);
        else { failures++; log.fail(`profile ${acct.key} missing at ${acct.profile}`); }
    }

    return failures;
}

// ── 9. CLEANUP (aggressive, prefix + tag scoped) ────────────────────────────
async function cleanup({ quiet = false } = {}) {
    const { auth, db } = getAdmin();

    // Auth: known uids + any user matching the reserved diagnostic prefixes.
    const uids = new Set(ACCOUNTS.map(a => a.uid));
    let pageToken;
    do {
        const page = await auth.listUsers(1000, pageToken);
        page.users.forEach(u => { if (UID_PATTERN.test(u.uid)) uids.add(u.uid); });
        pageToken = page.pageToken;
    } while (pageToken);

    let deletedUsers = 0;
    for (const uid of uids) {
        try { await auth.deleteUser(uid); deletedUsers++; }
        catch (e) { if (!isNotFound(e)) throw e; }
    }

    // Firestore: known roots + any tagged doc or reserved-prefix ID in the
    // four root collections, each removed with all nested subcollections.
    const refs = new Map(ROOTS.map(p => [p, db.doc(p)]));
    for (const col of SWEEP_COLLECTIONS) {
        const tagged = await db.collection(col).where('_diagnostic', '==', true).get();
        tagged.docs.forEach(d => refs.set(d.ref.path, d.ref));
        const listed = await db.collection(col).listDocuments();
        listed.filter(r => UID_PATTERN.test(r.id)).forEach(r => refs.set(r.path, r));
    }
    for (const ref of refs.values()) await db.recursiveDelete(ref);

    // Confirm nothing survived.
    let leftovers = 0;
    const snaps = await db.getAll(...Object.keys(DOCS).map(p => db.doc(p)));
    snaps.filter(s => s.exists).forEach(s => { leftovers++; log.fail(`doc survived cleanup ${s.ref.path}`); });
    for (const uid of ACCOUNTS.map(a => a.uid)) {
        try { await auth.getUser(uid); leftovers++; log.fail(`auth user survived cleanup ${uid}`); }
        catch (e) { if (!isNotFound(e)) throw e; }
    }

    if (!quiet && leftovers === 0) log.pass(`cleanup removed ${deletedUsers} auth users, ${refs.size} document trees`);
    return leftovers;
}

// ── 10. CLI ─────────────────────────────────────────────────────────────────
async function main() {
    const args = process.argv.slice(2);
    const known = new Set(['--verify', '--cleanup']);
    const unknown = args.filter(a => !known.has(a));
    if (unknown.length || (args.includes('--verify') && args.includes('--cleanup'))) {
        console.error('Usage: node tools/seed_accounts.js [--verify | --cleanup]');
        process.exit(2);
    }
    const mode = args.includes('--cleanup') ? 'cleanup' : args.includes('--verify') ? 'verify' : 'seed';

    log.info(`mode=${mode} project=${PROJECT_ID} firestore=${EMU.firestore} auth=${EMU.auth}`);
    await assertEmulatorsUp();

    let failures;
    if (mode === 'cleanup') {
        failures = await cleanup();
    } else if (mode === 'verify') {
        failures = await verify();
    } else {
        const stale = await cleanup({ quiet: true });
        if (stale) throw new Error('stale diagnostic data could not be removed');
        await seed();
        failures = await verify();
    }

    console.log(failures === 0 ? `[PASS] seed_accounts ${mode} OK` : `[FAIL] seed_accounts ${mode}: ${failures} problem(s)`);
    process.exitCode = failures === 0 ? 0 : 1;
}

module.exports = { IDS, ACCOUNTS, DOCS, PROJECT_ID, EMU, getAdmin };

if (require.main === module) {
    main().catch((e) => {
        console.error(`[FAIL] ${e.message}`);
        process.exit(1);
    });
}
