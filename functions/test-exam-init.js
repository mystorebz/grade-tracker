// ── test-exam-init.js ─────────────────────────────────────────────────────
// Quick emulator verification script for startExamAttempt (ConnectUs Phase 2
// — Exams foundation, Step 2). Run against the Firebase emulators, NOT
// production. Confirms:
//   1. A student can call startExamAttempt and get back a submission with a
//      serverDeadline computed by the SERVER, not supplied by the client.
//   2. Calling it again for the same exam returns the SAME submission
//      (idempotent) rather than minting a second deadline.
//   3. A client cannot forge its own serverDeadline by writing directly to
//      Firestore (exam_submissions create is now `allow create: if false`
//      for every client, per the updated firestore.rules).
//
// This is a Node script using the Admin SDK against the emulator (not a
// browser test) so it can call the onCall function directly without needing
// a real signed-in browser session. Point it at the running emulator via the
// FIRESTORE_EMULATOR_HOST / FIREBASE_AUTH_EMULATOR_HOST env vars, same as
// any other emulator-only script in this project.
//
// Usage:
//   cd functions
//   node test-exam-init.js
//
// Requires the emulators already running (firebase emulators:start). The
// script seeds its own exam config at
// schools/school-1/classes/class-a/subjects/sub_a1/exams/exam_test01 (via
// the Admin SDK, which bypasses firestore.rules — appropriate here since
// this is test SETUP, not something exercising rules enforcement; rules
// enforcement is separately and correctly tested in step 5 below using a
// real client token, not the Admin SDK) so the whole script is
// self-contained and safe to run cold, with no manual/undocumented setup
// step required first. Exam authoring still has no teacher-facing UI in
// this project — this seed step exists only to make this verification
// script reproducible, not as a stand-in for that feature.

process.env.FIRESTORE_EMULATOR_HOST = process.env.FIRESTORE_EMULATOR_HOST || '127.0.0.1:8080';
process.env.FIREBASE_AUTH_EMULATOR_HOST = process.env.FIREBASE_AUTH_EMULATOR_HOST || '127.0.0.1:9099';

const admin = require('firebase-admin');
admin.initializeApp({ projectId: 'school-grade-tracker' });

const PROJECT_ID = 'school-grade-tracker';
const REGION = 'us-central1';
const FUNCTIONS_HOST = process.env.FUNCTIONS_EMULATOR_HOST || '127.0.0.1:5001';

const STUDENT_ID = 'STU-0001'; // must exist in the emulator, matching class-a / school-1
const SCHOOL_ID = 'school-1';
const CLASS_ID = 'class-a';
const SUBJECT_ID = 'sub_a1';
const EXAM_ID = 'exam_test01';

function log(label, obj) {
    console.log(`\n── ${label} ──`);
    console.log(typeof obj === 'string' ? obj : JSON.stringify(obj, null, 2));
}

async function mintStudentIdToken(studentId, claims) {
    // Mirrors what mintStudentToken (functions/index.js) does server-side,
    // then exchanges the resulting custom token for a real ID token via the
    // Auth emulator's REST endpoint — the same signInWithCustomToken flow
    // the real student login page uses (assets/js/auth.js), just done here
    // without a browser.
    const customToken = await admin.auth().createCustomToken(studentId, claims);

    const apiKey = 'fake-api-key'; // any non-empty string works against the Auth emulator
    const res = await fetch(
        `http://${process.env.FIREBASE_AUTH_EMULATOR_HOST}/identitytoolkit.googleapis.com/v1/accounts:signInWithCustomToken?key=${apiKey}`,
        {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ token: customToken, returnSecureToken: true }),
        }
    );
    const json = await res.json();
    if (!json.idToken) {
        throw new Error(`Failed to exchange custom token for ID token: ${JSON.stringify(json)}`);
    }
    return json.idToken;
}

async function callStartExamAttempt(idToken, data) {
    const res = await fetch(
        `http://${FUNCTIONS_HOST}/${PROJECT_ID}/${REGION}/startExamAttempt`,
        {
            method: 'POST',
            headers: {
                'Content-Type': 'application/json',
                'Authorization': `Bearer ${idToken}`,
            },
            body: JSON.stringify({ data }),
        }
    );
    const json = await res.json();
    return { status: res.status, body: json };
}

// ── Self-contained seed: the exact exam config this script's own
// assertions depend on. timeLimitSeconds is real and load-bearing — step 3
// below computes an expected serverDeadline directly from it, so this must
// stay a plausible, positive exam duration, not a placeholder value.
const EXAM_CONFIG_SEED = {
    isLive: true,
    title: 'test-exam-init.js verification exam (auto-seeded, not real coursework)',
    timeLimitSeconds: 1800, // 30 minutes
    questions: [
        { id: 'q1', type: 'multiple_choice', prompt: 'Seed question 1', points: 5, correctAnswer: '4' },
        { id: 'q2', type: 'free_response', prompt: 'Seed question 2', points: 5 },
    ],
};

async function seedExamConfig(db) {
    const examRef = db
        .collection('schools').doc(SCHOOL_ID)
        .collection('classes').doc(CLASS_ID)
        .collection('subjects').doc(SUBJECT_ID)
        .collection('exams').doc(EXAM_ID);

    // set() with merge:false intentionally — this script owns exam_test01
    // outright and always seeds it to this exact known state, so a stale
    // doc from a previous run (or a previous version of this script) can
    // never leave a mismatched field behind.
    await examRef.set(EXAM_CONFIG_SEED);
    return examRef;
}

async function main() {
    console.log('=== startExamAttempt emulator verification ===');
    console.log(`Student: ${STUDENT_ID} | Exam: ${SCHOOL_ID}/${CLASS_ID}/${SUBJECT_ID}/${EXAM_ID}`);

    // ── 0. Seed the exam config this script depends on, then confirm it
    //      reads back as expected — self-contained, no manual setup step ──
    const db = admin.firestore();
    await seedExamConfig(db);

    const examSnap = await db
        .collection('schools').doc(SCHOOL_ID)
        .collection('classes').doc(CLASS_ID)
        .collection('subjects').doc(SUBJECT_ID)
        .collection('exams').doc(EXAM_ID)
        .get();

    if (!examSnap.exists) {
        console.error(`FAIL: exam config ${EXAM_ID} was seeded but could not be read back. Check Firestore emulator connectivity.`);
        process.exit(1);
    }
    if (examSnap.data().isLive !== true) {
        console.error(`FAIL: exam config ${EXAM_ID} was seeded but isLive is not true — seed data itself is wrong, check EXAM_CONFIG_SEED above.`);
        process.exit(1);
    }
    log('0. Exam config seeded and confirmed live', examSnap.data());

    // ── 1. Mint a real student ID token (same claims shape mintStudentToken produces) ──
    const idToken = await mintStudentIdToken(STUDENT_ID, {
        role: 'student',
        studentId: STUDENT_ID,
        schoolId: SCHOOL_ID,
        schoolType: 'K12',
        schoolName: '',
    });
    log('1. Minted student ID token', 'OK (token acquired)');

    // ── 2. Call startExamAttempt — first attempt ──────────────────────────────
    const before = Date.now();
    const first = await callStartExamAttempt(idToken, { classId: CLASS_ID, subjectId: SUBJECT_ID, examId: EXAM_ID });
    const after = Date.now();

    if (first.status !== 200) {
        console.error('FAIL: startExamAttempt did not return 200:', first);
        process.exit(1);
    }

    const firstResult = first.body.result;
    log('2. First startExamAttempt call', firstResult);

    // ── 3. Verify serverDeadline is server-computed, not client-suppliable ────
    // We never sent a deadline in the request payload at all — confirm the
    // function computed one anyway, and that it falls within
    // [call time, call time + timeLimitSeconds] with a little slack.
    const deadlineMs = new Date(firstResult.submission.serverDeadline).getTime();
    const startedMs = new Date(firstResult.submission.startedAt).getTime();
    const expectedDeadlineMs = before + examSnap.data().timeLimitSeconds * 1000;

    const startedInWindow = startedMs >= before && startedMs <= after;
    const deadlineCloseToExpected = Math.abs(deadlineMs - expectedDeadlineMs) < 5000; // 5s slack for request latency

    if (!startedInWindow) {
        console.error(`FAIL: startedAt (${firstResult.submission.startedAt}) is not within the call window [${before}, ${after}].`);
        process.exit(1);
    }
    if (!deadlineCloseToExpected) {
        console.error(`FAIL: serverDeadline (${deadlineMs}) is not close to expected (${expectedDeadlineMs}). Diff: ${deadlineMs - expectedDeadlineMs}ms`);
        process.exit(1);
    }
    log('3. serverDeadline is server-computed and tamper-proof', {
        startedAt: firstResult.submission.startedAt,
        serverDeadline: firstResult.submission.serverDeadline,
        timeLimitSeconds: examSnap.data().timeLimitSeconds,
        withinExpectedWindow: true,
    });

    // ── 4. Call startExamAttempt AGAIN — must be idempotent ──────────────────
    const second = await callStartExamAttempt(idToken, { classId: CLASS_ID, subjectId: SUBJECT_ID, examId: EXAM_ID });
    if (second.status !== 200) {
        console.error('FAIL: second startExamAttempt call did not return 200:', second);
        process.exit(1);
    }
    const secondResult = second.body.result;

    if (secondResult.examSubmissionId !== firstResult.examSubmissionId) {
        console.error(`FAIL: idempotency broken — second call returned a DIFFERENT submission ID (${secondResult.examSubmissionId} vs ${firstResult.examSubmissionId}). This means calling startExamAttempt twice (e.g. a page refresh mid-exam) mints a fresh deadline and could orphan the student's answers.`);
        process.exit(1);
    }
    if (secondResult.submission.serverDeadline !== firstResult.submission.serverDeadline) {
        console.error('FAIL: idempotency broken — second call returned a DIFFERENT serverDeadline for the same submission.');
        process.exit(1);
    }
    log('4. Idempotency confirmed', 'Second call returned the SAME submission ID and serverDeadline — no double-deadline bug.');

    // ── 5. Confirm a direct client write to exam_submissions is rejected ─────
    // (This exercises the updated firestore.rules: allow create: if false.)
    // Uses a fresh, unauthenticated-as-admin client -- we deliberately do NOT
    // use the Admin SDK here, since Admin SDK writes bypass rules entirely
    // and would prove nothing about client-side enforcement.
    const clientCreateRes = await fetch(
        `http://${process.env.FIRESTORE_EMULATOR_HOST}/v1/projects/${PROJECT_ID}/databases/(default)/documents/students/${STUDENT_ID}/exam_submissions?documentId=forged_attempt`,
        {
            method: 'POST',
            headers: {
                'Content-Type': 'application/json',
                'Authorization': `Bearer ${idToken}`,
            },
            body: JSON.stringify({
                fields: {
                    examId: { stringValue: EXAM_ID },
                    studentId: { stringValue: STUDENT_ID },
                    status: { stringValue: 'in_progress' },
                    serverDeadline: { stringValue: new Date(Date.now() + 999999999).toISOString() }, // absurd, student-forged deadline
                },
            }),
        }
    );
    const clientCreateJson = await clientCreateRes.json();

    if (clientCreateRes.status === 200) {
        console.error('FAIL: a direct client create() to exam_submissions SUCCEEDED. The rules change (allow create: if false) did not take effect — a student could forge their own serverDeadline.');
        console.error(JSON.stringify(clientCreateJson, null, 2));
        process.exit(1);
    }
    log('5. Direct client create() correctly rejected', {
        httpStatus: clientCreateRes.status,
        error: clientCreateJson.error?.message || clientCreateJson,
    });

    console.log('\n=== ALL CHECKS PASSED ===');
    console.log('- startExamAttempt creates a submission with a server-computed serverDeadline.');
    console.log('- Calling it twice for the same exam is idempotent (no orphaned second deadline).');
    console.log('- A student cannot forge their own submission/serverDeadline via a direct client write.');
    process.exit(0);
}

main().catch(err => {
    console.error('\n=== SCRIPT ERROR ===');
    console.error(err);
    process.exit(1);
});
