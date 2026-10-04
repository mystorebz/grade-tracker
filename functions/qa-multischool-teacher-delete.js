#!/usr/bin/env node
'use strict';
/**
 * functions/qa-multischool-teacher-delete.js — throwaway QA test, LIVE dev project
 *
 *   node qa-multischool-teacher-delete.js
 *
 * Verifies permanentDeleteTeacher when a teacher belongs to TWO schools:
 * deleting from QA-SCHOOL-01 must strip only QA-SCHOOL-01's footprint and
 * leave the registry record + QA-SCHOOL-02's data intact.
 *
 * Path under test = the exact production path the admin Archives "Delete"
 * button uses: QA super admin logs in through the deployed mintAdminToken
 * (credentials from functions/.qa-accounts.local, written by
 * seed-test-accounts.js) → ID token → deployed permanentDeleteTeacher callable.
 *
 * Fixture (all tagged _qaSeed: true, removed in a finally block):
 *   schools/QA-SCHOOL-02                    second school (verified, no email → no trigger mail)
 *   teachers/T99-QAMULTA  case A: ACTIVE at QA-SCHOOL-02, archived from QA-SCHOOL-01
 *   teachers/T99-QAMULTB  case B: archived from BOTH schools
 *   each teacher: one evaluation + one teachingHistory snapshot per school
 *
 * Target: dev-school-grade-tracker ONLY. Auth: Application Default Credentials.
 */
const fs = require('node:fs');
const path = require('node:path');

// ── 1. TARGET GUARD ─────────────────────────────────────────────────────────
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
const app = initializeApp({ projectId: PROJECT_ID, credential: applicationDefault() }, 'qa-multischool');
const db = getFirestore(app);

const S1 = 'QA-SCHOOL-01';
const S2 = 'QA-SCHOOL-02';
const T_A = 'T99-QAMULTA';
const T_B = 'T99-QAMULTB';
const TAG = { _qaSeed: true };
const CREDS_FILE = path.join(__dirname, '.qa-accounts.local');

// ── 2. HELPERS ──────────────────────────────────────────────────────────────
let failures = 0;
const pass = (m) => console.log(`[PASS] ${m}`);
const fail = (m) => { failures++; console.log(`[FAIL] ${m}`); };
const info = (m) => console.log(`[INFO] ${m}`);
const check = (cond, m) => (cond ? pass(m) : fail(m));

function readApiKey() {
    if (process.env.QA_FIREBASE_API_KEY) return process.env.QA_FIREBASE_API_KEY;
    const envFile = path.join(__dirname, '..', '.env.development');
    if (fs.existsSync(envFile)) {
        const m = fs.readFileSync(envFile, 'utf8').match(/^NEXT_PUBLIC_FIREBASE_API_KEY=(.+)$/m);
        if (m && m[1].trim()) return m[1].trim();
    }
    throw new Error('Dev web API key not found (set QA_FIREBASE_API_KEY or fill .env.development).');
}

async function postJson(url, body, headers = {}) {
    const res = await fetch(url, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', ...headers },
        body: JSON.stringify(body),
        signal: AbortSignal.timeout(60000),
    });
    const json = await res.json().catch(() => ({}));
    return { status: res.status, json };
}

const fnUrl = (fn) => `https://${REGION}-${PROJECT_ID}.cloudfunctions.net/${fn}`;

async function assertFreeOrQa(docPath) {
    const snap = await db.doc(docPath).get();
    if (snap.exists && snap.get('_qaSeed') !== true) {
        throw new Error(`${docPath} exists and is NOT a QA document — refusing to touch it.`);
    }
}

async function evalSchools(teacherId) {
    const snap = await db.collection('teachers').doc(teacherId).collection('evaluations').get();
    return snap.docs.map((d) => d.get('schoolId')).sort();
}

// ── 3. FIXTURE ──────────────────────────────────────────────────────────────
function snapshot(schoolId, now) {
    return { schoolId, semesterId: 'QA-SEM', semesterName: 'QA Term', classes: [], subjects: [],
             studentCount: 0, subjectAverages: {}, evaluations: [], snapshotDate: now };
}

async function seed() {
    const now = new Date().toISOString();
    await db.doc(`schools/${S2}`).set({ ...TAG, schoolName: 'QA School 02', isVerified: true, createdAt: now });
    const teachers = {
        [T_A]: { currentSchoolId: S2, archived: false, archivedSchoolIds: [S1] },
        [T_B]: { currentSchoolId: '', archived: true, archivedSchoolIds: [S1, S2] },
    };
    for (const [id, state] of Object.entries(teachers)) {
        const ref = db.doc(`teachers/${id}`);
        await ref.set({
            ...TAG, name: `QA Multi-School ${id.slice(-1)}`, classes: [], className: '',
            teachingHistory: [snapshot(S1, now), snapshot(S2, now)], createdAt: now, ...state,
        });
        for (const sid of [S1, S2]) {
            await ref.collection('evaluations').add({ ...TAG, schoolId: sid, type: 'QA Test', overallRating: 3, timestamp: now });
        }
    }
    info(`seeded ${S2}, ${T_A} (active at ${S2}), ${T_B} (archived from both) — 2 evaluations + 2 history snapshots each`);
}

// ── 4. LOGIN AS QA-SCHOOL-01 SUPER ADMIN (production path) ─────────────────
async function adminIdToken() {
    if (!fs.existsSync(CREDS_FILE)) throw new Error(`${path.basename(CREDS_FILE)} not found — run seed-test-accounts.js first.`);
    const creds = JSON.parse(fs.readFileSync(CREDS_FILE, 'utf8'));
    const minted = await postJson(fnUrl('mintAdminToken'), { data: { schoolId: S1, adminCode: creds.admin.adminCode } });
    const customToken = minted.json && minted.json.result && minted.json.result.token;
    if (!customToken) throw new Error(`mintAdminToken failed: HTTP ${minted.status} ${JSON.stringify(minted.json.error || {})}`);
    const signIn = await postJson(
        `https://identitytoolkit.googleapis.com/v1/accounts:signInWithCustomToken?key=${readApiKey()}`,
        { token: customToken, returnSecureToken: true },
    );
    if (!signIn.json.idToken) throw new Error(`signInWithCustomToken failed: HTTP ${signIn.status}`);
    const claims = JSON.parse(Buffer.from(signIn.json.idToken.split('.')[1], 'base64url').toString('utf8'));
    info(`logged in via mintAdminToken → role=${claims.role} schoolId=${claims.schoolId}`);
    return signIn.json.idToken;
}

async function callDelete(idToken, teacherId) {
    return postJson(fnUrl('permanentDeleteTeacher'), { data: { teacherId } }, { Authorization: `Bearer ${idToken}` });
}

// ── 5. TEST ─────────────────────────────────────────────────────────────────
async function runCase(idToken, teacherId, label, expectCurrent, expectArchived) {
    console.log(`\n── ${label} ──`);
    const res = await callDelete(idToken, teacherId);
    const result = res.json && res.json.result;
    check(res.status === 200 && result && result.ok === true, `permanentDeleteTeacher(${teacherId}) as ${S1} admin → HTTP ${res.status}`);
    check(result && result.fullyRemoved === false, `function reports fullyRemoved=false (record kept)`);

    const snap = await db.doc(`teachers/${teacherId}`).get();
    check(snap.exists, `registry record teachers/${teacherId} STILL EXISTS`);
    if (!snap.exists) return;
    const t = snap.data();
    const historySchools = (t.teachingHistory || []).map((h) => h.schoolId).sort();
    const evals = await evalSchools(teacherId);

    check((t.currentSchoolId || '') === expectCurrent, `currentSchoolId = '${t.currentSchoolId || ''}' (expected '${expectCurrent}')`);
    check(JSON.stringify(t.archivedSchoolIds || []) === JSON.stringify(expectArchived),
        `archivedSchoolIds = ${JSON.stringify(t.archivedSchoolIds || [])} (expected ${JSON.stringify(expectArchived)})`);
    check(historySchools.includes(S2), `${S2} teachingHistory snapshot STILL EXISTS`);
    check(evals.includes(S2), `${S2} evaluation STILL EXISTS`);
    check(!historySchools.includes(S1), `${S1} teachingHistory snapshot is GONE`);
    check(!evals.includes(S1), `${S1} evaluation is GONE`);
    check(!(t.archivedSchoolIds || []).includes(S1), `${S1} archive link is GONE`);

    const again = await callDelete(idToken, teacherId);
    const status = again.json && again.json.error && again.json.error.status;
    check(again.status !== 200 && status === 'PERMISSION_DENIED', `second delete from ${S1} is refused (${status || again.status}) — no ${S1} link left`);
}

async function cleanup() {
    console.log('\n── CLEANUP ──');
    for (const p of [`teachers/${T_A}`, `teachers/${T_B}`, `schools/${S2}`]) {
        try {
            await assertFreeOrQa(p);
            await db.recursiveDelete(db.doc(p));
        } catch (e) {
            fail(`cleanup ${p}: ${e.message}`);
        }
    }
    for (const p of [`teachers/${T_A}`, `teachers/${T_B}`, `schools/${S2}`]) {
        const gone = !(await db.doc(p).get()).exists;
        check(gone, `${p} deleted`);
    }
    for (const id of [T_A, T_B]) {
        const left = (await db.collection('teachers').doc(id).collection('evaluations').get()).size;
        check(left === 0, `teachers/${id}/evaluations empty (${left} left)`);
    }
}

async function main() {
    console.log(`QA multi-school teacher delete — project ${PROJECT_ID}\n`);
    for (const p of [`schools/${S2}`, `teachers/${T_A}`, `teachers/${T_B}`]) await assertFreeOrQa(p);
    try {
        await seed();
        const idToken = await adminIdToken();
        await runCase(idToken, T_A, `CASE A: active at ${S2}, archived from ${S1}`, S2, []);
        await runCase(idToken, T_B, `CASE B: archived from both schools`, '', [S2]);
    } catch (e) {
        fail(`unexpected error: ${e.message}`);
    } finally {
        await cleanup();
    }
    console.log(`\n${failures ? `RESULT: ${failures} FAILURE(S)` : 'RESULT: ALL ASSERTIONS PASSED'}`);
    process.exit(failures ? 1 : 0);
}

main();
