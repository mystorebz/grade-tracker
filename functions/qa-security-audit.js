#!/usr/bin/env node
'use strict';
/**
 * functions/qa-security-audit.js — throwaway QA audit, LIVE dev project
 *
 *   node qa-security-audit.js
 *
 * PART 1 (read-only): counts grade documents that have NO classId, per school.
 *   After the grade lockdown, teachers can no longer see those grades through
 *   the class-scoped queries (admins still can).
 *
 * PART 2 (security): can a teacher read student work (submissions, unsent
 *   drafts) or change subjects/assignments of a class they do not teach?
 *   Seeds a class with no teachers + one student + a submission in each of
 *   the two places submissions live + a draft, then acts as the real QA
 *   teacher (T99-QA001, via the deployed mintTeacherToken + Firestore REST,
 *   exactly what the browser sends). Every attempt SHOULD be denied.
 *   CONTROL: the same teacher must still read submissions and create/delete
 *   an assignment in their OWN class (QA-CLASS-01).
 *
 * All seeded docs are tagged _qaSeed: true and removed in a finally block.
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
const app = initializeApp({ projectId: PROJECT_ID, credential: applicationDefault() }, 'qa-security-audit');
const db = getFirestore(app);

const SCHOOL = 'QA-SCHOOL-01';
const CLASS = 'QA-CLASS-AUDIT';
const SUBJECT = 'QA-AUDIT-SUBJ';
const ASSIGNMENT = 'qa-audit-asg';
const STUDENT = 'S99-QAAUDIT';
const TEACHER = 'T99-QA001';
const TAG = { _qaSeed: true };
const CREDS_FILE = path.join(__dirname, '.qa-accounts.local');
const DOCS_BASE = `https://firestore.googleapis.com/v1/projects/${PROJECT_ID}/databases/(default)/documents`;

const OWN_CLASS = 'QA-CLASS-01';
const OWN_SUBJECT = 'QA-SUBJ-ELA4';
const OWN_ASSIGNMENT = 'qa-asg-4th-grade-language-arts-u1';
const OWN_STUDENT = 'S99-QA001';
const ASG_BASE = `schools/${SCHOOL}/classes/${CLASS}/subjects/${SUBJECT}/assignments`;
const CLASS_SUB = `${ASG_BASE}/${ASSIGNMENT}/submissions/${STUDENT}`;
const DRAFT = `${ASG_BASE}/${ASSIGNMENT}/drafts/${STUDENT}`;
const STUDENT_SUB = `students/${STUDENT}/submissions/${ASSIGNMENT}`;
const FOREIGN_NEW_ASG = `${ASG_BASE}/qa-audit-asg-new`;
const OWN_TEMP_ASG = `schools/${SCHOOL}/classes/${OWN_CLASS}/subjects/${OWN_SUBJECT}/assignments/qa-audit-own-temp`;
const PATHS = [
    OWN_TEMP_ASG,
    FOREIGN_NEW_ASG,
    DRAFT,
    CLASS_SUB,
    `schools/${SCHOOL}/classes/${CLASS}/subjects/${SUBJECT}/assignments/${ASSIGNMENT}`,
    `schools/${SCHOOL}/classes/${CLASS}/subjects/${SUBJECT}`,
    STUDENT_SUB,
    `students/${STUDENT}`,
    `schools/${SCHOOL}/classes/${CLASS}`,
];

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

// ── PART 1 ──────────────────────────────────────────────────────────────────
async function auditGradesWithoutClassId() {
    console.log('── PART 1: grades with no classId (teachers can no longer see these) ──');
    const snap = await db.collectionGroup('grades').select('schoolId', 'classId').get();
    const perSchool = {};
    let missing = 0;
    snap.docs.forEach((d) => {
        const s = d.get('schoolId') || '(no schoolId)';
        perSchool[s] = perSchool[s] || { total: 0, missing: 0 };
        perSchool[s].total++;
        if (!d.get('classId')) { perSchool[s].missing++; missing++; }
    });
    Object.entries(perSchool).sort().forEach(([s, c]) => info(`${s}: ${c.total} grades, ${c.missing} without classId`));
    if (missing === 0) pass(`all ${snap.size} grade documents in dev have a classId`);
    else fail(`${missing} of ${snap.size} grade documents have no classId — teachers cannot see them until classId is filled in`);
}

// ── PART 2 ──────────────────────────────────────────────────────────────────
async function seed() {
    const now = new Date().toISOString();
    await db.doc(`schools/${SCHOOL}/classes/${CLASS}`).set({ ...TAG, name: 'QA Audit Class (no teacher)', teacherIds: [], createdAt: now });
    await db.doc(`schools/${SCHOOL}/classes/${CLASS}/subjects/${SUBJECT}`).set({ ...TAG, name: 'QA Audit Subject', classId: CLASS, createdAt: now });
    await db.doc(`schools/${SCHOOL}/classes/${CLASS}/subjects/${SUBJECT}/assignments/${ASSIGNMENT}`).set({ ...TAG, title: 'QA Audit Assignment', classId: CLASS, subjectId: SUBJECT, maxScore: 10, createdAt: now });
    await db.doc(`students/${STUDENT}`).set({ ...TAG, name: 'QA Audit Student', currentSchoolId: SCHOOL, enrollmentStatus: 'Active',
        classId: CLASS, className: 'QA Audit Class (no teacher)', teacherId: '', archivedSchoolIds: [], createdAt: now });
    const submission = { ...TAG, studentId: STUDENT, classId: CLASS, subjectId: SUBJECT, assignmentId: ASSIGNMENT, status: 'submitted', answers: { q1: 'private answer' }, submittedAt: now };
    await db.doc(CLASS_SUB).set(submission);
    await db.doc(STUDENT_SUB).set(submission);
    await db.doc(DRAFT).set({ ...TAG, studentId: STUDENT, assignmentId: ASSIGNMENT, fields: { q1: 'unsent private answer' }, updatedAt: now, savedAt: new Date() });
    info(`seeded ${CLASS} (teacherIds: []), ${STUDENT} in it, and one submission at each path`);
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
    info(`logged in as ${TEACHER} via mintTeacherToken`);
    return signIn.json.idToken;
}

async function readAs(tok, docPath) {
    const r = await http('GET', `${DOCS_BASE}/${docPath}`, undefined, { Authorization: `Bearer ${tok}` });
    return r.status;
}
async function listAs(tok, parentPath, collectionId) {
    const r = await http('GET', `${DOCS_BASE}/${parentPath}/${collectionId}`, undefined, { Authorization: `Bearer ${tok}` });
    return r.status;
}
async function writeAs(tok, docPath, fields) {
    const body = { fields: Object.fromEntries(Object.entries(fields).map(([k, v]) =>
        [k, typeof v === 'boolean' ? { booleanValue: v } : typeof v === 'number' ? { integerValue: String(v) } : { stringValue: String(v) }])) };
    const r = await http('PATCH', `${DOCS_BASE}/${docPath}`, body, { Authorization: `Bearer ${tok}` });
    return r.status;
}
async function deleteAs(tok, docPath) {
    const r = await http('DELETE', `${DOCS_BASE}/${docPath}`, undefined, { Authorization: `Bearer ${tok}` });
    return r.status;
}
function expectDenied(label, status) {
    if (status === 403) pass(`${label} → PERMISSION_DENIED`);
    else fail(`${label} → HTTP ${status} (teacher CAN do it — hole is open)`);
}
function expectAllowed(label, status) {
    if (status === 200) pass(`${label} → allowed`);
    else if (status === 404) pass(`${label} → allowed (document not present)`);
    else fail(`${label} → HTTP ${status} (teacher is blocked from their OWN class — lockdown too strict)`);
}

async function cleanup() {
    console.log('\n── CLEANUP ──');
    for (const p of PATHS) {
        try { await assertFreeOrQa(p); await db.doc(p).delete(); } catch (e) { fail(`cleanup ${p}: ${e.message}`); }
    }
    let left = 0;
    for (const p of PATHS) if ((await db.doc(p).get()).exists) { left++; fail(`${p} still exists`); }
    if (!left) pass(`all ${PATHS.length} seeded documents deleted`);
}

async function main() {
    console.log(`QA security audit — project ${PROJECT_ID}\n`);
    await auditGradesWithoutClassId();

    console.log(`\n── PART 2: ${TEACHER} reading SUBMISSIONS of a class they do not teach (${CLASS}) ──`);
    for (const p of PATHS) await assertFreeOrQa(p);
    try {
        await seed();
        const tok = await teacherIdToken();
        expectDenied(`S1 read class-level submission (${CLASS_SUB.split('/').slice(-4).join('/')})`, await readAs(tok, CLASS_SUB));
        expectDenied(`S2 list class-level submissions for that assignment`, await listAs(tok, CLASS_SUB.split('/').slice(0, -2).join('/'), 'submissions'));
        expectDenied(`S3 read student-level submission (${STUDENT_SUB})`, await readAs(tok, STUDENT_SUB));
        expectDenied(`S4 list student-level submissions (students/${STUDENT}/submissions)`, await listAs(tok, `students/${STUDENT}`, 'submissions'));
        expectDenied(`S5 read unsent draft answers (drafts/${STUDENT})`, await readAs(tok, DRAFT));
        expectDenied(`W1 create an assignment in ${CLASS}`, await writeAs(tok, FOREIGN_NEW_ASG, { _qaSeed: true, title: 'QA audit (should be blocked)', classId: CLASS, subjectId: SUBJECT }));
        expectDenied(`W2 edit the subject in ${CLASS}`, await writeAs(tok, `schools/${SCHOOL}/classes/${CLASS}/subjects/${SUBJECT}`, { _qaSeed: true, name: 'tampered', classId: CLASS }));
        expectDenied(`W3 delete the assignment in ${CLASS}`, await deleteAs(tok, `${ASG_BASE}/${ASSIGNMENT}`));

        console.log(`\n── CONTROL: ${TEACHER} in their OWN class (${OWN_CLASS}) must still work ──`);
        const ownAsg = `schools/${SCHOOL}/classes/${OWN_CLASS}/subjects/${OWN_SUBJECT}/assignments/${OWN_ASSIGNMENT}`;
        expectAllowed(`C1 read ${OWN_STUDENT}'s submission for ${OWN_ASSIGNMENT}`, await readAs(tok, `${ownAsg}/submissions/${OWN_STUDENT}`));
        expectAllowed(`C2 list all submissions for ${OWN_ASSIGNMENT}`, await listAs(tok, ownAsg, 'submissions'));
        expectAllowed(`C3 list student-level submissions of ${OWN_STUDENT}`, await listAs(tok, `students/${OWN_STUDENT}`, 'submissions'));
        expectAllowed(`C4 create a temporary assignment in ${OWN_CLASS}`, await writeAs(tok, OWN_TEMP_ASG, { _qaSeed: true, title: 'QA audit temp (auto-deleted)', classId: OWN_CLASS, subjectId: OWN_SUBJECT }));
        expectAllowed(`C5 delete that temporary assignment`, await deleteAs(tok, OWN_TEMP_ASG));
    } catch (e) {
        fail(`unexpected error: ${e.message}`);
    } finally {
        await cleanup();
    }
    console.log(`\n${failures ? `RESULT: ${failures} FAILURE(S)` : 'RESULT: ALL ASSERTIONS PASSED'}`);
    process.exit(failures ? 1 : 0);
}

main();
