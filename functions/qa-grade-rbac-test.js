#!/usr/bin/env node
'use strict';
/**
 * functions/qa-grade-rbac-test.js — throwaway QA security test, LIVE dev project
 *
 *   node qa-grade-rbac-test.js
 *
 * Verifies the grade lockdown in firestore.rules: a teacher can read grades
 * only for classes they are assigned to (class doc teacherIds).
 *
 * Fixture (all tagged _qaSeed: true, removed in a finally block):
 *   schools/QA-SCHOOL-01/classes/QA-CLASS-RBAC   class with NO teachers assigned
 *   students/S99-QARBAC                          student in that class (no PIN, no email)
 *   students/S99-QARBAC/grades/qa-rbac-grade     one grade, classId QA-CLASS-RBAC
 *
 * Caller: the real QA teacher (T99-QA001), logged in through the deployed
 * mintTeacherToken (PIN from functions/.qa-accounts.local) → ID token →
 * Firestore REST API, i.e. exactly what the browser SDK sends. Control
 * queries against QA-CLASS-01 (which T99-QA001 teaches) must still succeed.
 *
 * Target: dev-school-grade-tracker ONLY. Auth: Application Default Credentials.
 */
const fs = require('node:fs');
const path = require('node:path');

const PROJECT_ID = 'dev-school-grade-tracker';
const REGION = 'us-central1';
if ((process.env.QA_PROJECT_ID || PROJECT_ID) !== PROJECT_ID) {
    console.error(`[FAIL] Refusing to run against anything but ${PROJECT_ID}.`);
    process.exit(2);
}
for (const v of ['FIRESTORE_EMULATOR_HOST', 'FIREBASE_AUTH_EMULATOR_HOST', 'FIREBASE_EMULATOR_HUB']) delete process.env[v];
process.env.GOOGLE_CLOUD_PROJECT = PROJECT_ID;
process.env.GCLOUD_PROJECT = PROJECT_ID;

const { initializeApp, applicationDefault } = require('firebase-admin/app');
const { getFirestore } = require('firebase-admin/firestore');
const app = initializeApp({ projectId: PROJECT_ID, credential: applicationDefault() }, 'qa-grade-rbac');
const db = getFirestore(app);

const SCHOOL = 'QA-SCHOOL-01';
const OWN_CLASS = 'QA-CLASS-01';
const FOREIGN_CLASS = 'QA-CLASS-RBAC';
const STUDENT = 'S99-QARBAC';
const GRADE = 'qa-rbac-grade';
const ASSIGNMENT = 'qa-rbac-asg';
const SEMESTER = 'QA-SEM-01';
const TEACHER = 'T99-QA001';
const TAG = { _qaSeed: true };
const CREDS_FILE = path.join(__dirname, '.qa-accounts.local');
const DOCS_BASE = `https://firestore.googleapis.com/v1/projects/${PROJECT_ID}/databases/(default)/documents`;

let failures = 0;
const pass = (m) => console.log(`[PASS] ${m}`);
const fail = (m) => { failures++; console.log(`[FAIL] ${m}`); };
const info = (m) => console.log(`[INFO] ${m}`);

function readApiKey() {
    if (process.env.QA_FIREBASE_API_KEY) return process.env.QA_FIREBASE_API_KEY;
    const envFile = path.join(__dirname, '..', '.env.development');
    if (fs.existsSync(envFile)) {
        const m = fs.readFileSync(envFile, 'utf8').match(/^NEXT_PUBLIC_FIREBASE_API_KEY=(.+)$/m);
        if (m && m[1].trim()) return m[1].trim();
    }
    throw new Error('Dev web API key not found (set QA_FIREBASE_API_KEY or fill .env.development).');
}

async function http(method, url, body, headers = {}) {
    const res = await fetch(url, {
        method,
        headers: { 'Content-Type': 'application/json', ...headers },
        body: body === undefined ? undefined : JSON.stringify(body),
        signal: AbortSignal.timeout(60000),
    });
    const json = await res.json().catch(() => ({}));
    return { status: res.status, json };
}

async function assertFreeOrQa(docPath) {
    const snap = await db.doc(docPath).get();
    if (snap.exists && snap.get('_qaSeed') !== true) throw new Error(`${docPath} exists and is NOT a QA document — refusing to touch it.`);
}

const PATHS = [
    `students/${STUDENT}/grades/${GRADE}`,
    `students/${STUDENT}`,
    `schools/${SCHOOL}/classes/${FOREIGN_CLASS}`,
];

async function seed() {
    const now = new Date().toISOString();
    await db.doc(`schools/${SCHOOL}/classes/${FOREIGN_CLASS}`).set({ ...TAG, name: 'QA RBAC Class (no teacher)', teacherIds: [], createdAt: now });
    await db.doc(`students/${STUDENT}`).set({ ...TAG, name: 'QA RBAC Student', currentSchoolId: SCHOOL, enrollmentStatus: 'Active',
        classId: FOREIGN_CLASS, className: 'QA RBAC Class (no teacher)', teacherId: '', archivedSchoolIds: [], createdAt: now });
    await db.doc(`students/${STUDENT}/grades/${GRADE}`).set({ ...TAG, schoolId: SCHOOL, classId: FOREIGN_CLASS, subjectId: 'QA-RBAC-SUBJ',
        semesterId: SEMESTER, assignmentId: ASSIGNMENT, title: 'QA RBAC grade', score: 9, max: 10, createdAt: now });
    info(`seeded ${FOREIGN_CLASS} (teacherIds: []), ${STUDENT} in it, and grade ${GRADE} (classId ${FOREIGN_CLASS})`);
}

async function teacherIdToken() {
    if (!fs.existsSync(CREDS_FILE)) throw new Error(`${path.basename(CREDS_FILE)} not found — run seed-test-accounts.js first.`);
    const creds = JSON.parse(fs.readFileSync(CREDS_FILE, 'utf8'));
    const minted = await http('POST', `https://${REGION}-${PROJECT_ID}.cloudfunctions.net/mintTeacherToken`, { data: { teacherId: TEACHER, pin: creds.teacher.pin } });
    const customToken = minted.json && minted.json.result && minted.json.result.token;
    if (!customToken) throw new Error(`mintTeacherToken failed: HTTP ${minted.status} ${JSON.stringify(minted.json.error || {})}`);
    const signIn = await http('POST', `https://identitytoolkit.googleapis.com/v1/accounts:signInWithCustomToken?key=${readApiKey()}`,
        { token: customToken, returnSecureToken: true });
    if (!signIn.json.idToken) throw new Error(`signInWithCustomToken failed: HTTP ${signIn.status}`);
    const claims = JSON.parse(Buffer.from(signIn.json.idToken.split('.')[1], 'base64url').toString('utf8'));
    info(`logged in via mintTeacherToken → role=${claims.role} teacherId=${claims.teacherId} schoolId=${claims.schoolId}`);
    return signIn.json.idToken;
}

const eq = (field, value) => ({ fieldFilter: { field: { fieldPath: field }, op: 'EQUAL', value: { stringValue: value } } });

async function gradesQuery(idToken, filters) {
    const r = await http('POST', `${DOCS_BASE}:runQuery`, {
        structuredQuery: {
            from: [{ collectionId: 'grades', allDescendants: true }],
            where: { compositeFilter: { op: 'AND', filters: filters.map(([f, v]) => eq(f, v)) } },
        },
    }, { Authorization: `Bearer ${idToken}` });
    // runQuery answers with an array of results, or (on error) an error object
    // or an array containing one.
    const arr = Array.isArray(r.json) ? r.json : [r.json];
    const rows = arr.filter((x) => x && x.document).length;
    const err = arr.find((x) => x && x.error);
    return { status: r.status, rows, errStatus: err && err.error.status };
}

async function getDoc(idToken, docPath) {
    const r = await http('GET', `${DOCS_BASE}/${docPath}`, undefined, { Authorization: `Bearer ${idToken}` });
    return { status: r.status, errStatus: r.json.error && r.json.error.status };
}

function expectDenied(label, r) {
    if (r.status === 403 || r.errStatus === 'PERMISSION_DENIED') pass(`${label} → PERMISSION_DENIED`);
    else fail(`${label} → expected PERMISSION_DENIED, got HTTP ${r.status}${r.errStatus ? ' ' + r.errStatus : ''}${r.rows !== undefined ? ` (${r.rows} docs)` : ''}`);
}
function expectAllowed(label, r) {
    if (r.status === 200 && !r.errStatus) pass(`${label} → allowed${r.rows !== undefined ? ` (${r.rows} docs)` : ''}`);
    else fail(`${label} → expected allowed, got HTTP ${r.status} ${r.errStatus || ''}`);
}

async function cleanup() {
    console.log('\n── CLEANUP ──');
    for (const p of PATHS) {
        try { await assertFreeOrQa(p); await db.doc(p).delete(); } catch (e) { fail(`cleanup ${p}: ${e.message}`); }
    }
    for (const p of PATHS) {
        if ((await db.doc(p).get()).exists) fail(`${p} still exists`); else pass(`${p} deleted`);
    }
}

async function main() {
    console.log(`QA grade read lockdown — project ${PROJECT_ID}\n`);
    for (const p of PATHS) await assertFreeOrQa(p);
    try {
        await seed();
        const tok = await teacherIdToken();

        console.log(`\n── TEST B: ${TEACHER} reading a class they do NOT teach (${FOREIGN_CLASS}) ──`);
        expectDenied(`B1 grades query, classId=${FOREIGN_CLASS} + assignmentId`,
            await gradesQuery(tok, [['schoolId', SCHOOL], ['classId', FOREIGN_CLASS], ['assignmentId', ASSIGNMENT]]));
        expectDenied(`B2 grades query, classId=${FOREIGN_CLASS} + subjectId + semesterId`,
            await gradesQuery(tok, [['schoolId', SCHOOL], ['classId', FOREIGN_CLASS], ['subjectId', 'QA-RBAC-SUBJ'], ['semesterId', SEMESTER]]));
        expectDenied(`B3 school-wide grades query (no classId filter)`,
            await gradesQuery(tok, [['schoolId', SCHOOL], ['assignmentId', ASSIGNMENT]]));
        expectDenied(`B4 direct read students/${STUDENT}/grades/${GRADE}`,
            await getDoc(tok, `students/${STUDENT}/grades/${GRADE}`));

        console.log(`\n── CONTROL: ${TEACHER} reading their own class (${OWN_CLASS}) ──`);
        expectAllowed(`C1 grades query, classId=${OWN_CLASS} + assignmentId`,
            await gradesQuery(tok, [['schoolId', SCHOOL], ['classId', OWN_CLASS], ['assignmentId', 'qa-asg-4th-grade-language-arts-u1']]));
        expectAllowed(`C2 grades query, classId=${OWN_CLASS} + subjectId + semesterId`,
            await gradesQuery(tok, [['schoolId', SCHOOL], ['classId', OWN_CLASS], ['subjectId', 'QA-SUBJ-ELA4'], ['semesterId', SEMESTER]]));
    } catch (e) {
        fail(`unexpected error: ${e.message}`);
    } finally {
        await cleanup();
    }
    console.log(`\n${failures ? `RESULT: ${failures} FAILURE(S)` : 'RESULT: ALL ASSERTIONS PASSED'}`);
    process.exit(failures ? 1 : 0);
}

main();
