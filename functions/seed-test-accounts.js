#!/usr/bin/env node
'use strict';
/**
 * functions/seed-test-accounts.js — throwaway QA accounts on the LIVE dev project
 *
 *   node seed-test-accounts.js             create/refresh the 4 QA accounts
 *   node seed-test-accounts.js --verify    claims + live login via deployed functions + rules read checks
 *   node seed-test-accounts.js --cleanup   delete QA Auth users, Firestore trees, local credentials file
 *
 * Target: dev-school-grade-tracker ONLY (hard-refuses any other project).
 * Auth:   Application Default Credentials (gcloud auth application-default login).
 *
 * Roles → production login paths (functions/index.js):
 *   Admin   → mintAdminToken   (schoolId + adminCode)  claims role=super_admin
 *   Teacher → mintTeacherToken (teacherId + PIN)       claims role=teacher
 *   Student → mintStudentToken (studentId + PIN)       claims role=student
 *   Parent  → mintParentToken  (parentId + PIN)        claims role=parent
 *
 * Fresh random PINs/admin code are generated on every seed and written to
 * functions/.qa-accounts.local (gitignored, excluded from functions deploys)
 * for the E2E suites. Profiles carry no email fields, so the onSchoolCreated /
 * onTeacherCreated / onStudentCreated / onParentCreated triggers send nothing.
 * Every doc is tagged `_qaSeed: true`; the script refuses to overwrite or
 * delete any doc at a QA path that is not tagged.
 */

const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const { isDeepStrictEqual } = require('node:util');

// ── 1. TARGET GUARD ─────────────────────────────────────────────────────────
const PROJECT_ID = 'dev-school-grade-tracker';
const REGION = 'us-central1';
const ALLOWED_PROJECTS = new Set([PROJECT_ID]);

const requested = process.env.QA_PROJECT_ID || PROJECT_ID;
if (!ALLOWED_PROJECTS.has(requested)) {
    console.error(`[FAIL] Refusing to run against "${requested}". Only ${PROJECT_ID} is allowed.`);
    process.exit(2);
}
for (const v of ['FIRESTORE_EMULATOR_HOST', 'FIREBASE_AUTH_EMULATOR_HOST', 'FIREBASE_EMULATOR_HUB']) delete process.env[v];
process.env.GOOGLE_CLOUD_PROJECT = PROJECT_ID;
process.env.GCLOUD_PROJECT = PROJECT_ID;

const { initializeApp, applicationDefault } = require('firebase-admin/app');
const { getAuth } = require('firebase-admin/auth');
const { getFirestore } = require('firebase-admin/firestore');

const app = initializeApp({ projectId: PROJECT_ID, credential: applicationDefault() }, 'qa-seed');
const auth = getAuth(app);
const db = getFirestore(app);

// ── 2. FIXTURE ──────────────────────────────────────────────────────────────
const IDS = Object.freeze({
    school: 'QA-SCHOOL-01',
    klass: 'QA-CLASS-01',
    teacher: 'T99-QA001',
    student: 'S99-QA001',
    parent: 'P99-QA001',
});
const NAMES = Object.freeze({ school: 'QA Test School', klass: 'QA Class 1' });
const QA_UID = /^(QA-SCHOOL-|[TSP]99-QA)/;
const TAG = Object.freeze({ _qaSeed: true, _seededBy: 'functions/seed-test-accounts.js' });
const CREDS_FILE = path.join(__dirname, '.qa-accounts.local');

// Same hash functions as functions/index.js
const sha256Lower = (t) => crypto.createHash('sha256').update(String(t).toLowerCase().trim(), 'utf8').digest('hex');
const sha256Trim = (t) => crypto.createHash('sha256').update(String(t).trim(), 'utf8').digest('hex');
const pin4 = () => String(crypto.randomInt(0, 10000)).padStart(4, '0');

const CLAIMS = Object.freeze({
    admin: { role: 'super_admin', schoolId: IDS.school, schoolName: NAMES.school, schoolType: 'Primary' },
    teacher: { role: 'teacher', schoolId: IDS.school, teacherId: IDS.teacher, schoolType: 'Primary', schoolName: NAMES.school },
    student: { role: 'student', studentId: IDS.student, schoolId: IDS.school, schoolType: 'Primary', schoolName: NAMES.school },
    parent: {
        role: 'parent',
        parentId: IDS.parent,
        linkedStudents: [{ studentId: IDS.student, schoolId: IDS.school }],
        linkedSchoolIds: [IDS.school],
    },
});

const ACCOUNTS = Object.freeze([
    { role: 'admin', uid: IDS.school, displayName: 'QA Admin', profile: `schools/${IDS.school}` },
    { role: 'teacher', uid: IDS.teacher, displayName: 'QA Teacher', profile: `teachers/${IDS.teacher}` },
    { role: 'student', uid: IDS.student, displayName: 'QA Student', profile: `students/${IDS.student}` },
    { role: 'parent', uid: IDS.parent, displayName: 'QA Parent', profile: `parents/${IDS.parent}` },
]);

// Roots removed by --cleanup (recursive). Order: leaves first is not required.
const ROOTS = Object.freeze([
    `schools/${IDS.school}`,
    `teachers/${IDS.teacher}`,
    `students/${IDS.student}`,
    `parents/${IDS.parent}`,
]);

function buildDocs(creds) {
    return {
        [`schools/${IDS.school}`]: {
            ...TAG,
            schoolName: NAMES.school,
            schoolType: 'Primary',
            isVerified: true,
            adminCode: sha256Lower(creds.admin.adminCode),
            requiresPinReset: false,
            securityQuestionsSet: true,
            subscriptionStatus: 'Active',
        },
        [`schools/${IDS.school}/classes/${IDS.klass}`]: {
            ...TAG, name: NAMES.klass, teacherIds: [IDS.teacher],
        },
        [`teachers/${IDS.teacher}`]: {
            ...TAG,
            name: 'QA Teacher',
            pin: sha256Trim(creds.teacher.pin),
            currentSchoolId: IDS.school,
            classes: [NAMES.klass],
            className: NAMES.klass,
            archived: false,
            profileComplete: true,
            securityQuestionsSet: true,
        },
        [`students/${IDS.student}`]: {
            ...TAG,
            name: 'QA Student',
            pin: sha256Trim(creds.student.pin),
            currentSchoolId: IDS.school,
            classId: IDS.klass,
            className: NAMES.klass,
            teacherId: IDS.teacher,
            enrollmentStatus: 'Active',
            securityQuestionsSet: true,
        },
        [`parents/${IDS.parent}`]: {
            ...TAG,
            name: 'QA Parent',
            pin: sha256Trim(creds.parent.pin),
            linkedStudents: [{ studentId: IDS.student, schoolId: IDS.school }],
            archived: false,
        },
    };
}

// ── 3. HELPERS ──────────────────────────────────────────────────────────────
let failures = 0;
const pass = (m) => console.log(`[PASS] ${m}`);
const fail = (m) => { failures++; console.log(`[FAIL] ${m}`); };
const info = (m) => console.log(`[INFO] ${m}`);
const isNotFound = (e) => e && e.code === 'auth/user-not-found';

function readCreds() {
    if (!fs.existsSync(CREDS_FILE)) throw new Error(`${path.basename(CREDS_FILE)} not found — run the seed first.`);
    return JSON.parse(fs.readFileSync(CREDS_FILE, 'utf8'));
}

function readApiKey() {
    if (process.env.QA_FIREBASE_API_KEY) return process.env.QA_FIREBASE_API_KEY;
    const envFile = path.join(__dirname, '..', '.env.development');
    if (fs.existsSync(envFile)) {
        const m = fs.readFileSync(envFile, 'utf8').match(/^NEXT_PUBLIC_FIREBASE_API_KEY=(.+)$/m);
        if (m && m[1].trim()) return m[1].trim();
    }
    throw new Error('Dev web API key not found (set QA_FIREBASE_API_KEY or fill .env.development).');
}

async function assertQaOwned(docPath) {
    const snap = await db.doc(docPath).get();
    if (snap.exists && snap.get('_qaSeed') !== true) {
        throw new Error(`${docPath} exists and is NOT a QA seed document — refusing to touch it.`);
    }
    return snap;
}

async function postJson(url, body, headers = {}) {
    const res = await fetch(url, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', ...headers },
        body: JSON.stringify(body),
        signal: AbortSignal.timeout(30000),
    });
    const json = await res.json().catch(() => ({}));
    return { status: res.status, json };
}

function decodeJwt(token) {
    return JSON.parse(Buffer.from(token.split('.')[1], 'base64url').toString('utf8'));
}

// ── 4. SEED ─────────────────────────────────────────────────────────────────
async function seed() {
    const creds = {
        project: PROJECT_ID,
        createdAt: new Date().toISOString(),
        admin: { schoolId: IDS.school, adminCode: `qa-${crypto.randomBytes(6).toString('hex')}` },
        teacher: { teacherId: IDS.teacher, pin: pin4() },
        student: { studentId: IDS.student, pin: pin4() },
        parent: { parentId: IDS.parent, pin: pin4() },
    };
    const docs = buildDocs(creds);

    for (const p of Object.keys(docs)) await assertQaOwned(p);

    for (const acct of ACCOUNTS) {
        try {
            await auth.createUser({ uid: acct.uid, displayName: acct.displayName });
        } catch (e) {
            if (e.code !== 'auth/uid-already-exists') throw e;
            await auth.updateUser(acct.uid, { displayName: acct.displayName, disabled: false });
        }
        await auth.setCustomUserClaims(acct.uid, CLAIMS[acct.role]);
        pass(`auth   ${acct.role.padEnd(8)} uid=${acct.uid}`);
    }

    const batch = db.batch();
    for (const [p, data] of Object.entries(docs)) batch.set(db.doc(p), data);
    await batch.commit();
    pass(`firestore ${Object.keys(docs).length} QA documents written`);

    fs.writeFileSync(CREDS_FILE, JSON.stringify(creds, null, 2), { mode: 0o600 });
    pass(`credentials written to functions/${path.basename(CREDS_FILE)}`);

    console.log('');
    console.log(`  Admin    School ID ${IDS.school}   Admin Code ${creds.admin.adminCode}`);
    console.log(`  Teacher  ${IDS.teacher}   PIN ${creds.teacher.pin}`);
    console.log(`  Student  ${IDS.student}   PIN ${creds.student.pin}`);
    console.log(`  Parent   ${IDS.parent}   PIN ${creds.parent.pin}`);
    console.log('');
}

// ── 5. VERIFY ───────────────────────────────────────────────────────────────
async function verify() {
    const creds = readCreds();
    const apiKey = readApiKey();
    const docs = buildDocs(creds);

    // 5a. Auth users + custom claims
    for (const acct of ACCOUNTS) {
        try {
            const u = await auth.getUser(acct.uid);
            if (isDeepStrictEqual(u.customClaims || {}, CLAIMS[acct.role])) pass(`claims ${acct.role.padEnd(8)} role=${CLAIMS[acct.role].role}`);
            else fail(`claims ${acct.role} mismatch: ${JSON.stringify(u.customClaims)}`);
        } catch (e) {
            fail(`auth user ${acct.uid} missing (${e.code || e.message})`);
        }
    }

    // 5b. Firestore profiles exist, tagged, credential hashes match
    for (const [p, expected] of Object.entries(docs)) {
        const snap = await db.doc(p).get();
        if (!snap.exists) { fail(`doc missing ${p}`); continue; }
        if (snap.get('_qaSeed') !== true) { fail(`doc untagged ${p}`); continue; }
        if (expected.pin && snap.get('pin') !== expected.pin) { fail(`pin hash mismatch ${p}`); continue; }
        if (expected.adminCode && snap.get('adminCode') !== expected.adminCode) { fail(`adminCode hash mismatch ${p}`); continue; }
        pass(`doc    ${p}`);
    }

    // 5c. Live login through the deployed callables → ID token → claims
    const logins = {
        admin: ['mintAdminToken', { schoolId: IDS.school, adminCode: creds.admin.adminCode }],
        teacher: ['mintTeacherToken', { teacherId: IDS.teacher, pin: creds.teacher.pin }],
        student: ['mintStudentToken', { studentId: IDS.student, pin: creds.student.pin }],
        parent: ['mintParentToken', { parentId: IDS.parent, pin: creds.parent.pin }],
    };
    const idTokens = {};
    for (const [role, [fn, data]] of Object.entries(logins)) {
        const callable = await postJson(`https://${REGION}-${PROJECT_ID}.cloudfunctions.net/${fn}`, { data });
        const customToken = callable.json && callable.json.result && callable.json.result.token;
        if (!customToken) { fail(`login  ${role.padEnd(8)} ${fn} HTTP ${callable.status} ${JSON.stringify(callable.json.error || {})}`); continue; }

        const signIn = await postJson(
            `https://identitytoolkit.googleapis.com/v1/accounts:signInWithCustomToken?key=${apiKey}`,
            { token: customToken, returnSecureToken: true },
        );
        if (!signIn.json.idToken) { fail(`login  ${role} signInWithCustomToken HTTP ${signIn.status}`); continue; }

        const payload = decodeJwt(signIn.json.idToken);
        const expected = CLAIMS[role];
        const mismatched = Object.keys(expected).filter((k) => !isDeepStrictEqual(payload[k], expected[k]));
        if (mismatched.length) fail(`login  ${role} token claims differ: ${mismatched.join(', ')}`);
        else pass(`login  ${role.padEnd(8)} ${fn} → ID token role=${payload.role}`);
        idTokens[role] = signIn.json.idToken;
    }

    // 5d. Live rules: one allowed read per role + one deny-all read
    const base = `https://firestore.googleapis.com/v1/projects/${PROJECT_ID}/databases/(default)/documents`;
    const allowed = {
        admin: `schools/${IDS.school}/classes/${IDS.klass}`,
        teacher: `schools/${IDS.school}/classes/${IDS.klass}`,
        student: `schools/${IDS.school}/classes/${IDS.klass}`,
        parent: `parents/${IDS.parent}`,
    };
    for (const [role, token] of Object.entries(idTokens)) {
        const headers = { Authorization: `Bearer ${token}` };
        const ok = await fetch(`${base}/${allowed[role]}`, { headers, signal: AbortSignal.timeout(30000) });
        if (ok.status === 200) pass(`rules  ${role.padEnd(8)} read ${allowed[role]} → 200`);
        else fail(`rules  ${role} read ${allowed[role]} → ${ok.status} (expected 200)`);

        const denied = await fetch(`${base}/parent_emails/qa-probe`, { headers, signal: AbortSignal.timeout(30000) });
        if (denied.status === 403) pass(`rules  ${role.padEnd(8)} read parent_emails → 403`);
        else fail(`rules  ${role} read parent_emails → ${denied.status} (expected 403)`);
    }
}

// ── 6. CLEANUP ──────────────────────────────────────────────────────────────
async function cleanup() {
    const uids = new Set(ACCOUNTS.map((a) => a.uid));
    let pageToken;
    do {
        const page = await auth.listUsers(1000, pageToken);
        page.users.forEach((u) => { if (QA_UID.test(u.uid)) uids.add(u.uid); });
        pageToken = page.pageToken;
    } while (pageToken);

    for (const uid of uids) {
        try { await auth.deleteUser(uid); pass(`auth   deleted ${uid}`); }
        catch (e) { if (!isNotFound(e)) throw e; }
    }

    for (const root of ROOTS) {
        await assertQaOwned(root);
        await db.recursiveDelete(db.doc(root));
        pass(`doc    deleted tree ${root}`);
    }

    if (fs.existsSync(CREDS_FILE)) { fs.unlinkSync(CREDS_FILE); pass(`credentials file removed`); }

    // Confirm nothing survived
    for (const root of ROOTS) if ((await db.doc(root).get()).exists) fail(`doc survived cleanup ${root}`);
    for (const uid of ACCOUNTS.map((a) => a.uid)) {
        try { await auth.getUser(uid); fail(`auth user survived cleanup ${uid}`); }
        catch (e) { if (!isNotFound(e)) throw e; }
    }
}

// ── 7. CLI ──────────────────────────────────────────────────────────────────
async function main() {
    const args = process.argv.slice(2);
    const valid = args.every((a) => a === '--verify' || a === '--cleanup') && args.length <= 1;
    if (!valid) {
        console.error('Usage: node seed-test-accounts.js [--verify | --cleanup]');
        process.exit(2);
    }
    const mode = args[0] === '--verify' ? 'verify' : args[0] === '--cleanup' ? 'cleanup' : 'seed';
    info(`mode=${mode} project=${PROJECT_ID}`);

    if (mode === 'seed') await seed();
    else if (mode === 'verify') await verify();
    else await cleanup();

    console.log(failures === 0 ? `[TRUE] seed-test-accounts ${mode} OK` : `[FALSE] seed-test-accounts ${mode}: ${failures} failure(s)`);
    process.exit(failures === 0 ? 0 : 1);
}

main().catch((e) => {
    console.error(`[FALSE] ${e.message}`);
    process.exit(1);
});
