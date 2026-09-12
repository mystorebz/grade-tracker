// Emulator verification script for recordManualGrade (ConnectUs Phase 3 —
// Grading & Results). Run against the Firebase emulators, NOT production.
//
// Follows the exact same pattern as test-exam-init.js in this same folder:
// mint a REAL Firebase Auth ID token via the Auth emulator's
// signInWithCustomToken REST endpoint (not a mocked auth object), then call
// the actual DEPLOYED function over HTTP against the Functions emulator
// (127.0.0.1:5001) — this exercises the real onCall handler exactly as a
// browser would, not an in-process import of the function body. The Admin
// SDK is used only for seeding fixtures and reading back the result to
// verify it, mirroring test-exam-init.js's own division of responsibility.
//
// Confirms:
//   1. Happy path: a teacher grades a pending free-response question within
//      [0, maxPoints] — score increases correctly, the question is removed
//      from pendingManualQuestionIds, and manualGrades records
//      pointsAwarded/feedback/gradedBy/gradedAt.
//   2. Atomic finalization: grading the LAST pending question in one call
//      flips status to 'graded' and sets gradedAt/gradedBy on the
//      submission itself, in the same write — no separate "finalize" step.
//   3. Points-bounds rejection: pointsAwarded above maxPoints, or below 0,
//      is rejected with invalid-argument and the submission is left
//      unchanged.
//   4. Double-grading prevention: grading the same question a second time
//      is rejected with failed-precondition.
//   5. Cross-tenant block: a teacher whose OWN token carries a DIFFERENT
//      schoolId than the submission's is rejected with permission-denied,
//      and the submission is verified unchanged afterward — this is the one
//      path with ZERO prior automated coverage anywhere in this project.
//   6. Auth/role enforcement: an unauthenticated call, and a call from a
//      token with role:'student', are both rejected.
//
// Usage:
//   cd functions
//   node test-record-manual-grade.js
//
// Requires the emulators already running (firebase emulators:start), which
// brings up Firestore (8080), Auth (9099), and Functions (5001) together per
// this project's firebase.json. Does NOT require a real exam config or
// answer key to be seeded — unlike startExamAttempt, recordManualGrade only
// reads the exam config for the target question's points value (see
// functions/index.js), so this script seeds a minimal exam doc with just
// enough shape for that lookup, plus exam_submissions docs directly via the
// Admin SDK (bypassing rules entirely, same as every other emulator-only
// seeding script in this project).

process.env.FIRESTORE_EMULATOR_HOST = process.env.FIRESTORE_EMULATOR_HOST || '127.0.0.1:8080';
process.env.FIREBASE_AUTH_EMULATOR_HOST = process.env.FIREBASE_AUTH_EMULATOR_HOST || '127.0.0.1:9099';

const admin = require('firebase-admin');
admin.initializeApp({ projectId: 'school-grade-tracker' });

const PROJECT_ID = 'school-grade-tracker';
const REGION = 'us-central1';
const FUNCTIONS_HOST = process.env.FUNCTIONS_EMULATOR_HOST || '127.0.0.1:5001';

const SCHOOL_ID_A = 'school-1';
const SCHOOL_ID_B = 'school-2'; // separate, active tenant — used only for the cross-tenant check
const CLASS_ID = 'class-a';
const SUBJECT_ID = 'sub_a1';
const EXAM_ID = 'exam_manual_test01';
const STUDENT_ID = 'STU-MANUAL-01';

let pass = 0;
let fail = 0;

function log(label, obj) {
    console.log(`\n── ${label} ──`);
    console.log(typeof obj === 'string' ? obj : JSON.stringify(obj, null, 2));
}

function ok(label) {
    console.log(`PASS - ${label}`);
    pass++;
}

function bad(label, detail) {
    console.log(`FAIL - ${label}`);
    if (detail !== undefined) console.log(`       ${detail}`);
    fail++;
}

async function mintIdToken(uid, claims) {
    // Mirrors test-exam-init.js's mintStudentIdToken, generalized for any
    // role's claim shape.
    const customToken = await admin.auth().createCustomToken(uid, claims);

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
        throw new Error(`Failed to exchange custom token for ID token (uid=${uid}): ${JSON.stringify(json)}`);
    }
    return json.idToken;
}

async function callRecordManualGrade(idToken, data) {
    const res = await fetch(
        `http://${FUNCTIONS_HOST}/${PROJECT_ID}/${REGION}/recordManualGrade`,
        {
            method: 'POST',
            headers: {
                'Content-Type': 'application/json',
                ...(idToken ? { 'Authorization': `Bearer ${idToken}` } : {}),
            },
            body: JSON.stringify({ data }),
        }
    );
    const json = await res.json();
    return { status: res.status, body: json };
}

function isRejected(callResult) {
    // The Functions emulator's onCall HTTP transport returns a non-2xx
    // status with an `error` body for a thrown HttpsError — same shape
    // test-exam-init.js already relies on for its rejected-write check.
    return callResult.status < 200 || callResult.status >= 300 || !!callResult.body.error;
}

async function main() {
    console.log('=== recordManualGrade emulator verification ===');

    const db = admin.firestore();

    // ── 0. Seed: two active schools, one exam config (shared by both
    //      submissions below — its points values are what recordManualGrade
    //      looks up server-side; the exam itself doesn't need to belong to
    //      one school specifically, since the function scopes on the
    //      SUBMISSION's own schoolId, not the exam's) ─────────────────────
    await db.collection('schools').doc(SCHOOL_ID_A).set({ isVerified: true, schoolName: 'School A' });
    await db.collection('schools').doc(SCHOOL_ID_B).set({ isVerified: true, schoolName: 'School B' });

    await db
        .collection('schools').doc(SCHOOL_ID_A)
        .collection('classes').doc(CLASS_ID)
        .collection('subjects').doc(SUBJECT_ID)
        .collection('exams').doc(EXAM_ID)
        .set({
            title: 'Manual Grading Test Exam',
            isLive: true,
            timeLimitSeconds: 1800,
            questions: [
                { id: 'q1', type: 'free_response', points: 10 },
                { id: 'q2', type: 'free_response', points: 5 },
            ],
        });

    // Two independent submissions, both mid-manual-grading (q1 and q2 both
    // still pending) so the happy-path/finalization tests and the points-
    // bounds/double-grade tests don't step on each other's state.
    async function seedSubmission(docId, schoolId) {
        const ref = db.collection('students').doc(STUDENT_ID).collection('exam_submissions').doc(docId);
        await ref.set({
            examId: EXAM_ID,
            studentId: STUDENT_ID,
            schoolId,
            classId: CLASS_ID,
            subjectId: SUBJECT_ID,
            isSchoolActive: true,
            status: 'submitted',
            score: 0,
            pendingManualPoints: 15,
            pendingManualQuestionIds: ['q1', 'q2'],
            manualGrades: {},
        });
        return ref;
    }

    const submissionHappyRef = await seedSubmission('sub-happy-path', SCHOOL_ID_A);
    const submissionBoundsRef = await seedSubmission('sub-bounds-check', SCHOOL_ID_A);
    const submissionDoubleGradeRef = await seedSubmission('sub-double-grade', SCHOOL_ID_A);
    const submissionCrossTenantRef = await seedSubmission('sub-cross-tenant', SCHOOL_ID_A);

    log('0. Seed complete', 'Exam config + 4 independent submissions, all pending q1 (10pt) + q2 (5pt).');

    // ── 1. Mint tokens ────────────────────────────────────────────────────
    const teacherAToken = await mintIdToken('teacher-a', {
        role: 'teacher', teacherId: 'TEACHER-A', schoolId: SCHOOL_ID_A,
    });
    const teacherBToken = await mintIdToken('teacher-b', {
        role: 'teacher', teacherId: 'TEACHER-B', schoolId: SCHOOL_ID_B,
    });
    const studentToken = await mintIdToken(STUDENT_ID, {
        role: 'student', studentId: STUDENT_ID, schoolId: SCHOOL_ID_A,
    });
    log('1. Minted tokens', 'OK — teacherA (school-1), teacherB (school-2), student (school-1)');

    // ── 2. Happy path ─────────────────────────────────────────────────────
    {
        const res = await callRecordManualGrade(teacherAToken, {
            studentId: STUDENT_ID,
            examSubmissionId: 'sub-happy-path',
            questionId: 'q1',
            pointsAwarded: 8,
            feedback: 'Good reasoning, minor arithmetic slip.',
        });

        if (isRejected(res)) {
            bad('Happy path: teacher grades a pending question within range', JSON.stringify(res.body));
        } else {
            const snap = await submissionHappyRef.get();
            const data = snap.data();
            const gradeEntry = data.manualGrades && data.manualGrades.q1;

            const scoreCorrect = data.score === 8;
            const pendingUpdated = Array.isArray(data.pendingManualQuestionIds) && !data.pendingManualQuestionIds.includes('q1') && data.pendingManualQuestionIds.includes('q2');
            const pendingPointsCorrect = data.pendingManualPoints === 5; // 15 - 10 (q1's max)
            const gradeRecorded = gradeEntry && gradeEntry.pointsAwarded === 8 && gradeEntry.feedback === 'Good reasoning, minor arithmetic slip.' && gradeEntry.gradedBy === 'TEACHER-A' && !!gradeEntry.gradedAt;
            const notYetFinalized = data.status === 'submitted'; // q2 still pending

            if (scoreCorrect && pendingUpdated && pendingPointsCorrect && gradeRecorded && notYetFinalized) {
                ok('Happy path: score, pendingManualQuestionIds, pendingManualPoints, and manualGrades entry all correct after grading q1');
            } else {
                bad('Happy path: submission state after grading q1', JSON.stringify(data, null, 2));
            }
        }
    }

    // ── 3. Atomic finalization — grade the LAST pending question (q2) on
    //      the SAME submission, confirm status flips to 'graded' in the
    //      same write ──────────────────────────────────────────────────────
    {
        const res = await callRecordManualGrade(teacherAToken, {
            studentId: STUDENT_ID,
            examSubmissionId: 'sub-happy-path',
            questionId: 'q2',
            pointsAwarded: 5,
        });

        if (isRejected(res)) {
            bad('Atomic finalization: grading the last pending question', JSON.stringify(res.body));
        } else {
            const snap = await submissionHappyRef.get();
            const data = snap.data();

            const fullyGraded = res.body.result && res.body.result.isFullyGraded === true;
            const statusFlipped = data.status === 'graded';
            const gradedFieldsSet = !!data.gradedAt && data.gradedBy === 'TEACHER-A';
            const finalScoreCorrect = data.score === 13; // 8 (q1) + 5 (q2)
            const pendingEmpty = Array.isArray(data.pendingManualQuestionIds) && data.pendingManualQuestionIds.length === 0;

            if (fullyGraded && statusFlipped && gradedFieldsSet && finalScoreCorrect && pendingEmpty) {
                ok('Atomic finalization: status flips to graded, gradedAt/gradedBy set, final score correct, all in the grading call for the last question');
            } else {
                bad('Atomic finalization: submission state after grading q2', JSON.stringify(data, null, 2));
            }
        }
    }

    // ── 4. Points-bounds rejection: above max ────────────────────────────
    {
        const res = await callRecordManualGrade(teacherAToken, {
            studentId: STUDENT_ID,
            examSubmissionId: 'sub-bounds-check',
            questionId: 'q1', // max 10
            pointsAwarded: 11,
        });

        const rejected = isRejected(res) && res.body.error && res.body.error.status === 'INVALID_ARGUMENT';
        if (!rejected) {
            bad('Points-bounds: pointsAwarded above maxPoints should be rejected with invalid-argument', JSON.stringify(res.body));
        } else {
            const snap = await submissionBoundsRef.get();
            const untouched = snap.data().pendingManualQuestionIds.includes('q1') && snap.data().score === 0;
            if (untouched) {
                ok('Points-bounds: over-max pointsAwarded rejected, submission left unchanged');
            } else {
                bad('Points-bounds: submission was modified despite the rejected call', JSON.stringify(snap.data()));
            }
        }
    }

    // ── 5. Points-bounds rejection: below zero ───────────────────────────
    {
        const res = await callRecordManualGrade(teacherAToken, {
            studentId: STUDENT_ID,
            examSubmissionId: 'sub-bounds-check',
            questionId: 'q1',
            pointsAwarded: -1,
        });

        const rejected = isRejected(res) && res.body.error && res.body.error.status === 'INVALID_ARGUMENT';
        if (rejected) {
            ok('Points-bounds: negative pointsAwarded rejected with invalid-argument');
        } else {
            bad('Points-bounds: negative pointsAwarded should be rejected', JSON.stringify(res.body));
        }
    }

    // ── 6. Double-grading prevention ─────────────────────────────────────
    {
        const first = await callRecordManualGrade(teacherAToken, {
            studentId: STUDENT_ID,
            examSubmissionId: 'sub-double-grade',
            questionId: 'q1',
            pointsAwarded: 7,
        });

        if (isRejected(first)) {
            bad('Double-grading setup: first grade of q1 should succeed', JSON.stringify(first.body));
        } else {
            const second = await callRecordManualGrade(teacherAToken, {
                studentId: STUDENT_ID,
                examSubmissionId: 'sub-double-grade',
                questionId: 'q1',
                pointsAwarded: 3, // different value — proves it's rejected outright, not just idempotent
            });

            const rejected = isRejected(second) && second.body.error && second.body.error.status === 'FAILED_PRECONDITION';
            if (!rejected) {
                bad('Double-grading: second grade of the same question should be rejected with failed-precondition', JSON.stringify(second.body));
            } else {
                const snap = await submissionDoubleGradeRef.get();
                const scorePreserved = snap.data().score === 7; // still the FIRST grade's value, not overwritten
                if (scorePreserved) {
                    ok('Double-grading: second call on an already-graded question rejected, first grade preserved unchanged');
                } else {
                    bad('Double-grading: score was altered by the rejected second call', JSON.stringify(snap.data()));
                }
            }
        }
    }

    // ── 7. Cross-tenant block — the path with ZERO prior coverage ───────
    // teacherB's token carries schoolId: school-2; the target submission
    // belongs to school-1. This is the exact boundary functions/index.js's
    // recordManualGrade enforces at "── 3. Scope check" (submission.schoolId
    // !== schoolId → permission-denied) and the one piece of the Phase 3
    // backend this project had never actually run a test against.
    {
        const res = await callRecordManualGrade(teacherBToken, {
            studentId: STUDENT_ID,
            examSubmissionId: 'sub-cross-tenant',
            questionId: 'q1',
            pointsAwarded: 10,
        });

        const rejected = isRejected(res) && res.body.error && res.body.error.status === 'PERMISSION_DENIED';
        if (!rejected) {
            bad('CROSS-TENANT: teacher at school-2 grading a school-1 submission should be rejected with permission-denied', JSON.stringify(res.body));
        } else {
            const snap = await submissionCrossTenantRef.get();
            const untouched = snap.data().score === 0 && snap.data().pendingManualQuestionIds.includes('q1') && snap.data().status === 'submitted';
            if (untouched) {
                ok('CROSS-TENANT: teacher at school-2 blocked from grading school-1\'s submission; submission left completely unchanged');
            } else {
                bad('CROSS-TENANT: submission was modified despite the cross-tenant call being rejected', JSON.stringify(snap.data()));
            }
        }
    }

    // ── 8. Auth/role enforcement ──────────────────────────────────────────
    {
        const res = await callRecordManualGrade(null, {
            studentId: STUDENT_ID,
            examSubmissionId: 'sub-cross-tenant',
            questionId: 'q1',
            pointsAwarded: 5,
        });
        const rejected = isRejected(res) && res.body.error && res.body.error.status === 'UNAUTHENTICATED';
        if (rejected) {
            ok('Auth: unauthenticated call rejected with unauthenticated');
        } else {
            bad('Auth: unauthenticated call should be rejected', JSON.stringify(res.body));
        }
    }

    {
        const res = await callRecordManualGrade(studentToken, {
            studentId: STUDENT_ID,
            examSubmissionId: 'sub-cross-tenant',
            questionId: 'q1',
            pointsAwarded: 5,
        });
        const rejected = isRejected(res) && res.body.error && res.body.error.status === 'PERMISSION_DENIED';
        if (rejected) {
            ok('Auth: a student\'s own token cannot call recordManualGrade — rejected with permission-denied');
        } else {
            bad('Auth: student-role call should be rejected', JSON.stringify(res.body));
        }
    }

    console.log(`\n${pass} passed, ${fail} failed\n`);
    process.exit(fail > 0 ? 1 : 0);
}

main().catch((err) => {
    console.error('\n=== SCRIPT ERROR ===');
    console.error(err);
    process.exit(1);
});
