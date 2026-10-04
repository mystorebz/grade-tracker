#!/usr/bin/env node
'use strict';
/**
 * functions/seed-test-accounts.js — throwaway QA accounts on the LIVE dev project
 *
 *   node seed-test-accounts.js             create/refresh the 5 QA accounts
 *   node seed-test-accounts.js --verify    claims + live login via deployed functions + rules checks
 *                                          (stream post RBAC, live lesson response security incl. cross-class,
 *                                           quiz grading callable, async worksheet answers in Document lessons)
 *   node seed-test-accounts.js --cleanup   delete QA Auth users, Firestore trees, local credentials file
 *
 * Target: dev-school-grade-tracker by default. PRODUCTION (school-grade-tracker)
 *   only with --prod --confirm-production on every mode, e.g.
 *     node seed-test-accounts.js --prod --confirm-production
 *   Production credentials go to functions/.qa-accounts.prod.local (gitignored).
 * Auth:   Application Default Credentials (gcloud auth application-default login).
 *
 * Roles → production login paths (functions/index.js):
 *   Admin   → mintAdminToken   (schoolId + adminCode)  claims role=super_admin
 *   Teacher → mintTeacherToken (teacherId + PIN)       claims role=teacher
 *   Student → mintStudentToken (studentId + PIN)       claims role=student
 *   Parent  → mintParentToken  (parentId + PIN)        claims role=parent
 *
 * Random PINs/admin code are generated on the first seed and saved to
 * functions/.qa-accounts.local (gitignored, excluded from functions deploys);
 * later seeds reuse them and merge into existing profiles, so populated QA
 * data survives a re-seed. --cleanup removes everything, including the file.
 * Profiles carry no email fields, so the onSchoolCreated /
 * onTeacherCreated / onStudentCreated / onParentCreated triggers send nothing.
 * Every doc is tagged `_qaSeed: true`; the script refuses to overwrite or
 * delete any doc at a QA path that is not tagged.
 */

const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const { isDeepStrictEqual } = require('node:util');

// ── 1. TARGET GUARD ─────────────────────────────────────────────────────────
const ON_PROD = process.argv.includes('--prod');
if (ON_PROD && !process.argv.includes('--confirm-production')) {
    console.error('[FAIL] Production QA accounts need --prod --confirm-production. Nothing was written.');
    process.exit(2);
}
const PROJECT_ID = ON_PROD ? 'school-grade-tracker' : 'dev-school-grade-tracker';
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
    klass2: 'QA-CLASS-02',      // second class: S99-QA002 is enrolled here, NOT in QA-CLASS-01
    teacher: 'T99-QA001',
    student: 'S99-QA001',
    student2: 'S99-QA002',
    parent: 'P99-QA001',
});
const NAMES = Object.freeze({ school: 'QA Test School', klass: 'QA Class 1', klass2: 'QA Class 2', student: 'QA Student', student2: 'QA Student Two' });
const QA_UID = /^(QA-SCHOOL-|[TSP]99-QA)/;
const TAG = Object.freeze({ _qaSeed: true, _seededBy: 'functions/seed-test-accounts.js' });
const CREDS_FILE = path.join(__dirname, ON_PROD ? '.qa-accounts.prod.local' : '.qa-accounts.local');

// Same hash functions as functions/index.js
const sha256Lower = (t) => crypto.createHash('sha256').update(String(t).toLowerCase().trim(), 'utf8').digest('hex');
const sha256Trim = (t) => crypto.createHash('sha256').update(String(t).trim(), 'utf8').digest('hex');
const pin4 = () => String(crypto.randomInt(0, 10000)).padStart(4, '0');

const CLAIMS = Object.freeze({
    admin: { role: 'super_admin', schoolId: IDS.school, schoolName: NAMES.school, schoolType: 'Primary' },
    teacher: { role: 'teacher', schoolId: IDS.school, teacherId: IDS.teacher, schoolType: 'Primary', schoolName: NAMES.school },
    student: { role: 'student', studentId: IDS.student, schoolId: IDS.school, schoolType: 'Primary', schoolName: NAMES.school },
    student2: { role: 'student', studentId: IDS.student2, schoolId: IDS.school, schoolType: 'Primary', schoolName: NAMES.school },
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
    { role: 'student', uid: IDS.student, displayName: NAMES.student, profile: `students/${IDS.student}` },
    { role: 'student2', uid: IDS.student2, displayName: NAMES.student2, profile: `students/${IDS.student2}` },
    { role: 'parent', uid: IDS.parent, displayName: 'QA Parent', profile: `parents/${IDS.parent}` },
]);

// Roots removed by --cleanup (recursive). Order: leaves first is not required.
const ROOTS = Object.freeze([
    `schools/${IDS.school}`,
    `teachers/${IDS.teacher}`,
    `students/${IDS.student}`,
    `students/${IDS.student2}`,
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
        [`schools/${IDS.school}/classes/${IDS.klass2}`]: {
            ...TAG, name: NAMES.klass2, teacherIds: [IDS.teacher],
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
            name: NAMES.student,
            pin: sha256Trim(creds.student.pin),
            currentSchoolId: IDS.school,
            classId: IDS.klass,
            className: NAMES.klass,
            teacherId: IDS.teacher,
            enrollmentStatus: 'Active',
            securityQuestionsSet: true,
        },
        [`students/${IDS.student2}`]: {
            ...TAG,
            name: NAMES.student2,
            pin: sha256Trim(creds.student2.pin),
            currentSchoolId: IDS.school,
            classId: IDS.klass2,
            className: NAMES.klass2,
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
    const creds = JSON.parse(fs.readFileSync(CREDS_FILE, 'utf8'));
    if (!creds.student2) throw new Error(`${path.basename(CREDS_FILE)} has no second student — run the seed again (node seed-test-accounts.js).`);
    return creds;
}

function readApiKey() {
    if (process.env.QA_FIREBASE_API_KEY) return process.env.QA_FIREBASE_API_KEY;
    const envFile = path.join(__dirname, '..', ON_PROD ? '.env.production' : '.env.development');
    if (fs.existsSync(envFile)) {
        const m = fs.readFileSync(envFile, 'utf8').match(/^NEXT_PUBLIC_FIREBASE_API_KEY=(.+)$/m);
        if (m && m[1].trim()) return m[1].trim();
    }
    throw new Error(`Web API key not found (set QA_FIREBASE_API_KEY or fill ${ON_PROD ? '.env.production' : '.env.development'}).`);
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
    // Re-seeding keeps existing credentials (and, via merge below, any data
    // already populated on the QA profiles). Run --cleanup to start fresh.
    let creds = null;
    if (fs.existsSync(CREDS_FILE)) {
        try {
            const saved = JSON.parse(fs.readFileSync(CREDS_FILE, 'utf8'));
            if (saved.project === PROJECT_ID && saved.admin && saved.teacher && saved.student && saved.parent) creds = saved;
        } catch (_) { /* unreadable → regenerate */ }
    }
    const reused = !!creds;
    if (creds && !creds.student2) creds.student2 = { studentId: IDS.student2, pin: pin4() }; // added later
    if (!creds) {
        creds = {
            project: PROJECT_ID,
            createdAt: new Date().toISOString(),
            admin: { schoolId: IDS.school, adminCode: `qa-${crypto.randomBytes(6).toString('hex')}` },
            teacher: { teacherId: IDS.teacher, pin: pin4() },
            student: { studentId: IDS.student, pin: pin4() },
            student2: { studentId: IDS.student2, pin: pin4() },
            parent: { parentId: IDS.parent, pin: pin4() },
        };
    }
    info(reused ? 'reusing existing credentials from .qa-accounts.local' : 'generated new credentials');
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
    for (const [p, data] of Object.entries(docs)) batch.set(db.doc(p), data, { merge: true });
    await batch.commit();
    pass(`firestore ${Object.keys(docs).length} QA documents written`);

    fs.writeFileSync(CREDS_FILE, JSON.stringify(creds, null, 2), { mode: 0o600 });
    pass(`credentials written to functions/${path.basename(CREDS_FILE)}`);

    console.log('');
    console.log(`  Admin    School ID ${IDS.school}   Admin Code ${creds.admin.adminCode}`);
    console.log(`  Teacher  ${IDS.teacher}   PIN ${creds.teacher.pin}`);
    console.log(`  Student  ${IDS.student}   PIN ${creds.student.pin}   (${NAMES.klass})`);
    console.log(`  Student  ${IDS.student2}   PIN ${creds.student2.pin}   (${NAMES.klass2})`);
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
        student2: ['mintStudentToken', { studentId: IDS.student2, pin: creds.student2.pin }],
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
        student2: `schools/${IDS.school}/classes/${IDS.klass2}`,
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

    await verifyPostRbac(idTokens);
    await verifyLiveResponses(idTokens);
    await verifyQuizGrading(idTokens);
    await verifyWorksheetResponses(idTokens);
}

// ── 5e. Class Stream post RBAC (teacher writes; student reads only) ──────
// Throwaway post at a probe subject path; removed in `finally` even if a
// step fails. Expectations mirror firestore.rules' posts block.
async function verifyPostRbac(idTokens) {
    if (!idTokens.teacher || !idTokens.student) {
        fail('posts  RBAC skipped: teacher/student login failed above');
        return;
    }
    const base = `https://firestore.googleapis.com/v1/projects/${PROJECT_ID}/databases/(default)/documents`;
    const postsPath = `schools/${IDS.school}/classes/${IDS.klass}/subjects/QA-SUBJ-PROBE/posts`;
    const postId = `qa-probe-${Date.now().toString(36)}`;
    const studentPostId = `${postId}-student`;
    // authorId is required: firestore.rules only lets a class teacher create a
    // post that names them as its author (RBAC fix, 2026-10-02).
    const fields = (title) => ({ fields: { title: { stringValue: title }, authorId: { stringValue: IDS.teacher }, _qaSeed: { booleanValue: true } } });

    const call = async (method, token, url, body) => {
        const res = await fetch(url, {
            method,
            headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
            body: body ? JSON.stringify(body) : undefined,
            signal: AbortSignal.timeout(30000),
        });
        return res.status;
    };
    const expect = (label, status, want) => {
        if (status === want) pass(`posts  ${label} → ${status}`);
        else fail(`posts  ${label} → ${status} (expected ${want})`);
    };

    try {
        const T = idTokens.teacher;
        const S = idTokens.student;
        expect('teacher create', await call('POST', T, `${base}/${postsPath}?documentId=${postId}`, fields('QA probe')), 200);
        expect('teacher read  ', await call('GET', T, `${base}/${postsPath}/${postId}`), 200);
        expect('teacher update', await call('PATCH', T, `${base}/${postsPath}/${postId}?updateMask.fieldPaths=title`, fields('QA probe edited')), 200);
        expect('student read  ', await call('GET', S, `${base}/${postsPath}/${postId}`), 200);
        expect('student create', await call('POST', S, `${base}/${postsPath}?documentId=${studentPostId}`, fields('student probe')), 403);
        expect('student update', await call('PATCH', S, `${base}/${postsPath}/${postId}?updateMask.fieldPaths=title`, fields('tampered')), 403);
        expect('student delete', await call('DELETE', S, `${base}/${postsPath}/${postId}`), 403);
        expect('teacher delete', await call('DELETE', T, `${base}/${postsPath}/${postId}`), 200);
    } finally {
        await db.doc(`${postsPath}/${postId}`).delete().catch(() => {});
        await db.doc(`${postsPath}/${studentPostId}`).delete().catch(() => {});
    }
}

// ── 5f. Live lesson responses (firestore.rules live_sessions/responses) ──
// Throwaway lesson + live session in QA-CLASS-01 (probe subject), written
// with the Admin SDK and removed in `finally`. Students then hit the live
// rules over REST with their real ID tokens:
//   S99-QA001 is enrolled in QA-CLASS-01, S99-QA002 is in QA-CLASS-02.
async function verifyLiveResponses(idTokens) {
    const need = ['teacher', 'student', 'student2'].filter((r) => !idTokens[r]);
    if (need.length) { fail(`live   responses skipped: ${need.join(', ')} login failed above`); return; }

    const base = `https://firestore.googleapis.com/v1/projects/${PROJECT_ID}/databases/(default)/documents`;
    const lessonId = `qa-probe-live-${Date.now().toString(36)}`;
    const lessonPath = `schools/${IDS.school}/classes/${IDS.klass}/subjects/QA-SUBJ-PROBE/lessons/${lessonId}`;
    const sessionId = `qa-sess-${crypto.randomBytes(4).toString('hex')}`;
    const sessionPath = `${lessonPath}/live_sessions/${sessionId}`;
    const respPath = `${sessionPath}/responses`;
    const BOARD = 'ob_qa_board', POLL = 'ob_qa_poll', OPEN = 'ob_qa_open', QUIZ = 'ob_qa_quiz';
    const S1 = IDS.student, S2 = IDS.student2;

    const enc = (v) => {
        if (v === null) return { nullValue: null };
        if (Array.isArray(v)) return { arrayValue: { values: v.map(enc) } };
        if (typeof v === 'boolean') return { booleanValue: v };
        if (typeof v === 'number') return Number.isInteger(v) ? { integerValue: String(v) } : { doubleValue: v };
        return { stringValue: String(v) };
    };
    const body = (obj) => ({ fields: Object.fromEntries(Object.entries(obj).map(([k, v]) => [k, enc(v)])) });
    const answer = (studentId, studentName, blockId, blockType, extra = {}) => ({
        schoolId: IDS.school, studentId, studentName, blockId, blockType,
        answerText: '', submittedAt: new Date().toISOString(), ...extra,
    });
    const req = async (method, token, url, payload) => {
        const res = await fetch(url, {
            method,
            headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
            body: payload ? JSON.stringify(payload) : undefined,
            signal: AbortSignal.timeout(30000),
        });
        const json = await res.json().catch(() => null);
        return { status: res.status, json };
    };
    // PATCH without an update mask = setDoc (create or replace)
    const put = (token, id, data) => req('PATCH', token, `${base}/${respPath}/${id}`, body(data)).then((r) => r.status);
    const listBoard = (token) => req('POST', token, `${base}/${sessionPath}:runQuery`, {
        structuredQuery: {
            from: [{ collectionId: 'responses' }],
            where: { compositeFilter: { op: 'AND', filters: [
                { fieldFilter: { field: { fieldPath: 'schoolId' }, op: 'EQUAL', value: enc(IDS.school) } },
                { fieldFilter: { field: { fieldPath: 'blockType' }, op: 'EQUAL', value: enc('board') } },
            ] } },
        },
    });
    const expect = (label, status, want) => {
        if (status === want) pass(`live   ${label} → ${status}`);
        else fail(`live   ${label} → ${status} (expected ${want})`);
    };

    try {
        // Fixture (Admin SDK bypasses rules)
        await db.doc(lessonPath).set({ ...TAG, title: 'QA live probe', status: 'published', format: 'slides', schoolId: IDS.school });
        await db.doc(sessionPath).set({ ...TAG, activeLessonId: lessonId, startedAt: new Date().toISOString(), endedAt: null, teacherPositionId: null });
        await db.doc(`${respPath}/${S1}_${QUIZ}`).set({ ...answer(S1, NAMES.student, QUIZ, 'quiz', { choiceIds: ['a'] }), correct: true });
        await db.doc(`${respPath}/${S1}_${BOARD}`).set(answer(S1, NAMES.student, BOARD, 'board', { answerText: 'Seeded note' }));

        const T = idTokens.teacher, A = idTokens.student, B = idTokens.student2;

        // Privacy: board notes readable only by students enrolled in this class
        const own = await listBoard(A);
        expect(`enrolled student lists board notes (${Array.isArray(own.json) ? own.json.filter((x) => x.document).length : 0} found)`, own.status, 200);
        expect('other-class student lists board notes', (await listBoard(B)).status, 403);
        expect('other-class student reads a note by id', (await req('GET', B, `${base}/${respPath}/${S1}_${BOARD}`)).status, 403);
        expect('teacher lists board notes', (await listBoard(T)).status, 200);

        // Enrollment + identity on writes
        expect('other-class student posts a board note', await put(B, `${S2}_${BOARD}`, answer(S2, NAMES.student2, BOARD, 'board', { answerText: 'Not my class' })), 403);
        expect('student writes as another student', await put(A, `${S2}_${OPEN}`, answer(S2, NAMES.student2, OPEN, 'open_response', { answerText: 'spoof' })), 403);
        expect('student uses a different name', await put(A, `${S1}_${OPEN}`, answer(S1, 'Someone Else', OPEN, 'open_response', { answerText: 'x' })), 403);

        // Field whitelist + size caps
        expect('extra field (score)', await put(A, `${S1}_${OPEN}`, answer(S1, NAMES.student, OPEN, 'open_response', { answerText: 'x', score: 5 })), 403);
        expect('open response 4001 chars', await put(A, `${S1}_${OPEN}`, answer(S1, NAMES.student, OPEN, 'open_response', { answerText: 'a'.repeat(4001) })), 403);
        expect('board note 281 chars', await put(A, `${S1}_${BOARD}`, answer(S1, NAMES.student, BOARD, 'board', { answerText: 'a'.repeat(281) })), 403);
        expect('open response 4000 chars', await put(A, `${S1}_${OPEN}`, answer(S1, NAMES.student, OPEN, 'open_response', { answerText: 'a'.repeat(4000) })), 200);
        expect('open response edited', await put(A, `${S1}_${OPEN}`, answer(S1, NAMES.student, OPEN, 'open_response', { answerText: 'Edited' })), 200);
        expect('board note edited', await put(A, `${S1}_${BOARD}`, answer(S1, NAMES.student, BOARD, 'board', { answerText: 'Edited note' })), 200);

        // One vote / one attempt
        expect('poll vote', await put(A, `${S1}_${POLL}`, answer(S1, NAMES.student, POLL, 'poll', { choiceIds: ['a'] })), 200);
        expect('poll vote changed', await put(A, `${S1}_${POLL}`, answer(S1, NAMES.student, POLL, 'poll', { choiceIds: ['b'] })), 403);
        expect('quiz overwritten as poll', await put(A, `${S1}_${QUIZ}`, answer(S1, NAMES.student, QUIZ, 'poll', { choiceIds: ['b'] })), 403);
        expect('quiz written directly', await put(A, `${S1}_ob_qa_quiz2`, answer(S1, NAMES.student, 'ob_qa_quiz2', 'quiz', { choiceIds: ['a'] })), 403);
        const quiz = (await db.doc(`${respPath}/${S1}_${QUIZ}`).get()).data();
        if (quiz.blockType === 'quiz' && quiz.correct === true) pass('live   graded quiz unchanged');
        else fail(`live   graded quiz changed: ${JSON.stringify(quiz)}`);

        // Session ended → no more writes
        await db.doc(sessionPath).update({ endedAt: new Date().toISOString() });
        expect('write after session ended', await put(A, `${S1}_${OPEN}`, answer(S1, NAMES.student, OPEN, 'open_response', { answerText: 'late' })), 403);
    } finally {
        await db.recursiveDelete(db.doc(lessonPath)).catch((e) => fail(`live   cleanup ${lessonPath}: ${e.message}`));
    }
}

// ── 5g. Quiz grading callable (functions/src/lessonWidgets.js) ───────────
// Throwaway published slides lesson + document lesson, each with one quiz
// (options a/b/c, correct = b) and a live session. Calls the deployed
// submitLessonQuizAnswer with the students' real ID tokens. Removed in finally.
async function verifyQuizGrading(idTokens) {
    const need = ['student', 'student2'].filter((r) => !idTokens[r]);
    if (need.length) { fail(`quiz   grading skipped: ${need.join(', ')} login failed above`); return; }

    const stamp = Date.now().toString(36);
    const subjectPath = `schools/${IDS.school}/classes/${IDS.klass}/subjects/QA-SUBJ-PROBE`;
    const QUIZ = 'ob_qa_quiz', GHOST = 'ob_qa_ghost';
    const options = [{ id: 'opt_a', text: 'A' }, { id: 'opt_b', text: 'B' }, { id: 'opt_c', text: 'C' }];
    const lessons = {
        slides: { id: `qa-probe-quiz-s-${stamp}`, format: 'slides' },
        document: { id: `qa-probe-quiz-d-${stamp}`, format: 'document' },
    };
    const keys = [];
    const url = `https://${REGION}-${PROJECT_ID}.cloudfunctions.net/submitLessonQuizAnswer`;
    const call = async (token, data) => {
        const r = await postJson(url, { data }, { Authorization: `Bearer ${token}` });
        if (r.json && r.json.result) return { ok: true, ...r.json.result };
        const e = (r.json && r.json.error) || {};
        return { ok: false, status: e.status || `HTTP ${r.status}`, message: e.message || '' };
    };
    const expectErr = (label, res, status) => {
        if (!res.ok && res.status === status) pass(`quiz   ${label} → ${status} (${res.message})`);
        else fail(`quiz   ${label} → ${JSON.stringify(res)} (expected ${status})`);
    };
    const expectOk = (label, res, want) => {
        const okAll = res.ok && Object.entries(want).every(([k, v]) => isDeepStrictEqual(res[k], v));
        if (okAll) pass(`quiz   ${label} → ${JSON.stringify(want)}`);
        else fail(`quiz   ${label} → ${JSON.stringify(res)} (expected ${JSON.stringify(want)})`);
    };

    try {
        // Fixture
        for (const L of Object.values(lessons)) {
            const lp = `${subjectPath}/lessons/${L.id}`;
            L.path = lp;
            L.session = `qa-sess-${crypto.randomBytes(4).toString('hex')}`;
            await db.doc(lp).set({ ...TAG, title: `QA quiz probe (${L.format})`, status: 'published', format: L.format, schoolId: IDS.school });
            if (L.format === 'slides') {
                await db.doc(`${lp}/slides/slide_qa_1`).set({ ...TAG, objects: [{ id: QUIZ, type: 'quiz', props: { question: 'Pick B', options, points: 1 } }] });
            } else {
                const cfg = JSON.stringify({ question: 'Pick B', options, points: 1 }).replace(/&/g, '&amp;').replace(/"/g, '&quot;');
                await db.doc(`${lp}/doc/main`).set({ ...TAG, html: `<p>Doc probe</p><div class="lesson-widget" data-widget-id="${QUIZ}" data-widget-type="quiz" data-config="${cfg}"></div>` });
            }
            await db.doc(`${lp}/live_sessions/${L.session}`).set({ ...TAG, activeLessonId: L.id, startedAt: new Date().toISOString(), endedAt: null });
            await db.doc(`${lp}/live_sessions/current`).set({ ...TAG, sessionId: L.session, live: true, endedAt: 'pointer' });
            for (const obj of [QUIZ, GHOST]) {
                const k = `${L.id}_${obj}`;
                keys.push(k);
                await db.doc(`work_answer_keys/${k}`).set({ ...TAG, kind: 'lesson_quiz', schoolId: IDS.school, lessonId: L.id, objectId: obj, correct: ['opt_b'] });
            }
        }

        const A = idTokens.student, B = idTokens.student2;
        const S = lessons.slides;
        const req = (L, extra = {}) => ({ schoolId: IDS.school, classId: IDS.klass, subjectId: 'QA-SUBJ-PROBE', lessonId: L.id, sessionId: L.session, objectId: QUIZ, ...extra });

        // 3. enrollment
        expectErr('other-class student submits', await call(B, req(S, { choiceIds: ['opt_b'] })), 'PERMISSION_DENIED');
        // 1. option validation
        expectErr('option not in the quiz', await call(A, req(S, { choiceIds: ['opt_zzz'] })), 'INVALID_ARGUMENT');
        expectErr('valid + invalid option', await call(A, req(S, { choiceIds: ['opt_b', 'opt_zzz'] })), 'INVALID_ARGUMENT');
        expectErr('no option', await call(A, req(S, { choiceIds: [] })), 'INVALID_ARGUMENT');
        expectErr('quiz not in the lesson', await call(A, req(S, { objectId: GHOST, choiceIds: ['opt_b'] })), 'NOT_FOUND');
        // 2. single answer
        expectErr('two options on a single-answer quiz', await call(A, req(S, { choiceIds: ['opt_a', 'opt_b'] })), 'INVALID_ARGUMENT');
        // pointer doc is not a session
        expectErr('pointer doc used as session', await call(A, req(S, { sessionId: 'current', choiceIds: ['opt_b'] })), 'FAILED_PRECONDITION');
        const noAttempt = await db.doc(`${S.path}/live_sessions/${S.session}/responses/${IDS.student}_${QUIZ}`).get();
        if (!noAttempt.exists) pass('quiz   rejected submissions saved nothing');
        else fail('quiz   a rejected submission was saved');

        // 4. a non-quiz doc at the quiz's response id does not block the attempt
        const respRef = db.doc(`${S.path}/live_sessions/${S.session}/responses/${IDS.student}_${QUIZ}`);
        await respRef.set({ schoolId: IDS.school, studentId: IDS.student, studentName: NAMES.student, blockId: QUIZ, blockType: 'poll', choiceIds: ['opt_a'], answerText: '', submittedAt: new Date().toISOString() });
        // 5. graded picks returned
        expectOk('attempt over a planted poll doc', await call(A, req(S, { choiceIds: ['opt_b'] })), { correct: true, choiceIds: ['opt_b'] });
        const stored = (await respRef.get()).data();
        if (stored.blockType === 'quiz' && stored.correct === true && isDeepStrictEqual(stored.choiceIds, ['opt_b'])) pass('quiz   stored as a graded quiz attempt');
        else fail(`quiz   stored attempt wrong: ${JSON.stringify(stored)}`);
        expectOk('second attempt returns the first', await call(A, req(S, { choiceIds: ['opt_a'] })), { correct: true, choiceIds: ['opt_b'], alreadyAnswered: true });

        // document-format lesson
        expectOk('document quiz, wrong answer', await call(A, req(lessons.document, { choiceIds: ['opt_c'] })), { correct: false, choiceIds: ['opt_c'] });
        expectErr('document quiz, unknown option', await call(A, { ...req(lessons.document, { choiceIds: ['opt_x'] }) }), 'INVALID_ARGUMENT');

        // ended session
        await db.doc(`${lessons.document.path}/live_sessions/${lessons.document.session}`).update({ endedAt: new Date().toISOString() });
        await db.doc(`${lessons.document.path}/live_sessions/${lessons.document.session}/responses/${IDS.student}_${QUIZ}`).delete();
        expectErr('submit after session ended', await call(A, req(lessons.document, { choiceIds: ['opt_b'] })), 'FAILED_PRECONDITION');
    } finally {
        for (const L of Object.values(lessons)) {
            if (L.path) await db.recursiveDelete(db.doc(L.path)).catch((e) => fail(`quiz   cleanup ${L.path}: ${e.message}`));
        }
        for (const k of keys) await db.doc(`work_answer_keys/${k}`).delete().catch(() => {});
    }
}

// ── 5h. Async worksheet answers (Document lessons, no live session) ─────
// Throwaway published Document lesson holding a poll, quiz, open response and
// sticky-note board, plus a draft Document lesson and a published Slides
// lesson. Students answer through the same paths the viewer uses:
// lessons/{id}/responses/{studentId}_{objectId} (rules 3e) and
// submitLessonQuizAnswer without a sessionId. Teacher reads them back.
async function verifyWorksheetResponses(idTokens) {
    const need = ['teacher', 'student', 'student2'].filter((r) => !idTokens[r]);
    if (need.length) { fail(`sheet  worksheet checks skipped: ${need.join(', ')} login failed above`); return; }

    const base = `https://firestore.googleapis.com/v1/projects/${PROJECT_ID}/databases/(default)/documents`;
    const stamp = Date.now().toString(36);
    const subjectPath = `schools/${IDS.school}/classes/${IDS.klass}/subjects/QA-SUBJ-PROBE`;
    const POLL = 'ob_ws_poll', QUIZ = 'ob_ws_quiz', OPEN = 'ob_ws_open', BOARD = 'ob_ws_board';
    const S1 = IDS.student, S2 = IDS.student2;
    const options = [{ id: 'opt_a', text: 'A' }, { id: 'opt_b', text: 'B' }];
    const L = {
        doc: { id: `qa-probe-ws-d-${stamp}`, status: 'published', format: 'document' },
        draft: { id: `qa-probe-ws-x-${stamp}`, status: 'draft', format: 'document' },
        slides: { id: `qa-probe-ws-s-${stamp}`, status: 'published', format: 'slides' },
    };
    Object.values(L).forEach((l) => { l.path = `${subjectPath}/lessons/${l.id}`; });
    const keyId = `${L.doc.id}_${QUIZ}`;

    const enc = (v) => {
        if (v === null) return { nullValue: null };
        if (Array.isArray(v)) return { arrayValue: { values: v.map(enc) } };
        if (typeof v === 'boolean') return { booleanValue: v };
        if (typeof v === 'number') return Number.isInteger(v) ? { integerValue: String(v) } : { doubleValue: v };
        return { stringValue: String(v) };
    };
    const body = (obj) => ({ fields: Object.fromEntries(Object.entries(obj).map(([k, v]) => [k, enc(v)])) });
    const answer = (studentId, studentName, blockId, blockType, extra = {}) => ({
        schoolId: IDS.school, studentId, studentName, blockId, blockType,
        answerText: '', submittedAt: new Date().toISOString(), ...extra,
    });
    const req = async (method, token, url, payload) => {
        const res = await fetch(url, {
            method,
            headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
            body: payload ? JSON.stringify(payload) : undefined,
            signal: AbortSignal.timeout(30000),
        });
        return { status: res.status, json: await res.json().catch(() => null) };
    };
    const put = (token, lesson, id, data) => req('PATCH', token, `${base}/${lesson.path}/responses/${id}`, body(data)).then((r) => r.status);
    const list = (token, boardOnly) => req('POST', token, `${base}/${L.doc.path}:runQuery`, {
        structuredQuery: {
            from: [{ collectionId: 'responses' }],
            where: { compositeFilter: { op: 'AND', filters: [
                { fieldFilter: { field: { fieldPath: 'schoolId' }, op: 'EQUAL', value: enc(IDS.school) } },
                ...(boardOnly ? [{ fieldFilter: { field: { fieldPath: 'blockType' }, op: 'EQUAL', value: enc('board') } }] : []),
            ] } },
        },
    });
    const docs = (r) => (Array.isArray(r.json) ? r.json.filter((x) => x.document).map((x) => x.document) : []);
    const expect = (label, status, want) => {
        if (status === want) pass(`sheet  ${label} → ${status}`);
        else fail(`sheet  ${label} → ${status} (expected ${want})`);
    };
    const callQuiz = async (token, extra) => {
        const r = await postJson(`https://${REGION}-${PROJECT_ID}.cloudfunctions.net/submitLessonQuizAnswer`, {
            data: { schoolId: IDS.school, classId: IDS.klass, subjectId: 'QA-SUBJ-PROBE', lessonId: L.doc.id, objectId: QUIZ, ...extra },
        }, { Authorization: `Bearer ${token}` });
        if (r.json && r.json.result) return { ok: true, ...r.json.result };
        const e = (r.json && r.json.error) || {};
        return { ok: false, status: e.status || `HTTP ${r.status}`, message: e.message || '' };
    };

    try {
        // Fixture (Admin SDK bypasses rules)
        const cfg = (o) => JSON.stringify(o).replace(/&/g, '&amp;').replace(/"/g, '&quot;');
        const widget = (id, type, c) => `<div class="lesson-widget" data-widget-id="${id}" data-widget-type="${type}" data-config="${cfg(c)}"></div>`;
        const html = '<p>Worksheet probe</p>' +
            widget(POLL, 'poll', { question: 'Pick one', options }) +
            widget(QUIZ, 'quiz', { question: 'Pick B', options, points: 1 }) +
            widget(OPEN, 'open_response', { question: 'Explain' }) +
            widget(BOARD, 'board', { question: 'Post a note' });
        for (const l of Object.values(L)) {
            await db.doc(l.path).set({ ...TAG, title: `QA worksheet probe (${l.status} ${l.format})`, status: l.status, format: l.format, schoolId: IDS.school });
            if (l.format === 'document') await db.doc(`${l.path}/doc/main`).set({ ...TAG, html });
        }
        await db.doc(`work_answer_keys/${keyId}`).set({ ...TAG, kind: 'lesson_quiz', schoolId: IDS.school, lessonId: L.doc.id, objectId: QUIZ, correct: ['opt_b'] });

        const T = idTokens.teacher, A = idTokens.student, B = idTokens.student2;

        // Answers outside a live session
        expect('poll vote', await put(A, L.doc, `${S1}_${POLL}`, answer(S1, NAMES.student, POLL, 'poll', { choiceIds: ['opt_a'] })), 200);
        expect('poll vote changed', await put(A, L.doc, `${S1}_${POLL}`, answer(S1, NAMES.student, POLL, 'poll', { choiceIds: ['opt_b'] })), 403);
        expect('open response', await put(A, L.doc, `${S1}_${OPEN}`, answer(S1, NAMES.student, OPEN, 'open_response', { answerText: 'Because nouns name things.' })), 200);
        expect('open response edited', await put(A, L.doc, `${S1}_${OPEN}`, answer(S1, NAMES.student, OPEN, 'open_response', { answerText: 'Nouns name people, places and things.' })), 200);
        expect('board note', await put(A, L.doc, `${S1}_${BOARD}`, answer(S1, NAMES.student, BOARD, 'board', { answerText: 'Dog is a noun' })), 200);
        expect('quiz written directly', await put(A, L.doc, `${S1}_${QUIZ}`, answer(S1, NAMES.student, QUIZ, 'quiz', { choiceIds: ['opt_b'] })), 403);

        const graded = await callQuiz(A, { choiceIds: ['opt_b'] });
        if (graded.ok && graded.correct === true) pass('sheet  quiz graded by submitLessonQuizAnswer (no session) → correct');
        else fail(`sheet  quiz grading → ${JSON.stringify(graded)}`);
        const again = await callQuiz(A, { choiceIds: ['opt_a'] });
        if (again.ok && again.alreadyAnswered === true && isDeepStrictEqual(again.choiceIds, ['opt_b'])) pass('sheet  second quiz attempt returns the first');
        else fail(`sheet  second quiz attempt → ${JSON.stringify(again)}`);

        // Who may write
        expect('other-class student answers', await put(B, L.doc, `${S2}_${OPEN}`, answer(S2, NAMES.student2, OPEN, 'open_response', { answerText: 'x' })), 403);
        const other = await callQuiz(B, { choiceIds: ['opt_b'] });
        if (!other.ok && other.status === 'PERMISSION_DENIED') pass('sheet  other-class student quiz → PERMISSION_DENIED');
        else fail(`sheet  other-class student quiz → ${JSON.stringify(other)}`);
        expect('answer in a draft lesson', await put(A, L.draft, `${S1}_${OPEN}`, answer(S1, NAMES.student, OPEN, 'open_response', { answerText: 'x' })), 403);
        expect('answer in a slides lesson (live only)', await put(A, L.slides, `${S1}_${OPEN}`, answer(S1, NAMES.student, OPEN, 'open_response', { answerText: 'x' })), 403);

        // Storage: everything lands in lessons/{id}/responses and the teacher reads it
        const stored = Object.fromEntries((await db.collection(`${L.doc.path}/responses`).get()).docs.map((d) => [d.id, d.data()]));
        const want = {
            [`${S1}_${POLL}`]: (d) => d.blockType === 'poll' && isDeepStrictEqual(d.choiceIds, ['opt_a']),
            [`${S1}_${QUIZ}`]: (d) => d.blockType === 'quiz' && d.correct === true && isDeepStrictEqual(d.choiceIds, ['opt_b']),
            [`${S1}_${OPEN}`]: (d) => d.blockType === 'open_response' && d.answerText === 'Nouns name people, places and things.',
            [`${S1}_${BOARD}`]: (d) => d.blockType === 'board' && d.answerText === 'Dog is a noun',
        };
        for (const [id, ok] of Object.entries(want)) {
            if (stored[id] && ok(stored[id])) pass(`sheet  stored ${id.replace(`${S1}_`, '')} (${stored[id].blockType})`);
            else fail(`sheet  stored ${id} wrong: ${JSON.stringify(stored[id] || null)}`);
        }
        if (Object.keys(stored).length === 4) pass('sheet  no stray response docs');
        else fail(`sheet  ${Object.keys(stored).length} response docs (expected 4)`);

        const teacherList = await list(T, false);
        expect(`teacher lists all answers (${docs(teacherList).length} found)`, teacherList.status, 200);
        if (docs(teacherList).length !== 4) fail(`sheet  teacher sees ${docs(teacherList).length} answers (expected 4)`);
        expect('student lists every answer', (await list(A, false)).status, 403);
        expect('enrolled student lists board notes', (await list(A, true)).status, 200);
        expect('other-class student lists board notes', (await list(B, true)).status, 403);
        expect('student reads own answer', (await req('GET', A, `${base}/${L.doc.path}/responses/${S1}_${OPEN}`)).status, 200);
        expect('other-class student reads an answer', (await req('GET', B, `${base}/${L.doc.path}/responses/${S1}_${OPEN}`)).status, 403);
    } finally {
        for (const l of Object.values(L)) await db.recursiveDelete(db.doc(l.path)).catch((e) => fail(`sheet  cleanup ${l.path}: ${e.message}`));
        await db.doc(`work_answer_keys/${keyId}`).delete().catch(() => {});
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
    const args = process.argv.slice(2).filter((a) => a !== '--prod' && a !== '--confirm-production');
    const valid = args.every((a) => a === '--verify' || a === '--cleanup') && args.length <= 1;
    if (!valid) {
        console.error('Usage: node seed-test-accounts.js [--verify | --cleanup] [--prod --confirm-production]');
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
