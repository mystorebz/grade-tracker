// Seeds a clean, known-good school/class/teacher/student/exam into the
// Firebase emulator for the Playwright suite in this folder.
//
// Follows the same Admin-SDK-against-the-emulator pattern already
// established in this project by functions/test-exam-init.js and
// functions/test-record-manual-grade.js — the difference here is that the
// seeded teacher/student PINs must be correctly hashed with the SAME
// sha256Trim algorithm the real login pages and functions/index.js use
// (trim whitespace only, preserve case, SHA-256 hex), because these tests
// drive the ACTUAL login.html forms through a real browser, not a minted
// token — startExamAttempt/recordManualGrade-style scripts never needed
// this because they mint tokens directly and skip the login UI entirely.
//
// This file is BOTH a standalone script (`npm run seed`, or `node seed.js`)
// AND a module the .spec.js files import for the fixture IDs/PINs and to
// call seed() from a Playwright beforeAll. Requiring it does NOT run
// anything by itself — only calling seed() does — so importing it from a
// test file never re-seeds or exits the test process by accident.
//
// Safe to re-run — every document uses a fixed, deterministic ID and is
// written with .set() (overwrite), not .add(), matching the idempotent-seed
// style already used by migration/seed-test-data.js and
// migration/seed-pin-test-student.js elsewhere in this repo.

const admin = require('firebase-admin');
const crypto = require('crypto');

// ── Fixture IDs — shared with the .spec.js files in this folder ─────────
const SCHOOL_ID = 'E2E-SCHOOL-1';
const CLASS_ID = 'e2e-class-1';
const SUBJECT_ID = 'e2e-subj-1';
const EXAM_ID = 'e2e-exam-01';
const TEACHER_ID = 'T26-E2E01';
const STUDENT_ID = 'S26-E2E01';

const TEACHER_PIN = '1234';
const STUDENT_PIN = '5678';

// Matches sha256Trim in functions/index.js and assets/js/crypto-utils.js
// exactly: trim whitespace only, preserve case, SHA-256, lowercase hex.
function sha256Trim(text) {
    return crypto.createHash('sha256').update(String(text).trim(), 'utf8').digest('hex');
}

let appInitialized = false;
function ensureApp() {
    if (appInitialized) return;
    process.env.FIRESTORE_EMULATOR_HOST = process.env.FIRESTORE_EMULATOR_HOST || '127.0.0.1:8080';
    process.env.FIREBASE_AUTH_EMULATOR_HOST = process.env.FIREBASE_AUTH_EMULATOR_HOST || '127.0.0.1:9099';
    if (admin.apps.length === 0) {
        admin.initializeApp({ projectId: 'school-grade-tracker' });
    }
    appInitialized = true;
}

async function seed() {
    ensureApp();
    const db = admin.firestore();

    console.log('=== Seeding exam-tests fixtures into the Firestore emulator ===');

    // ── Clear any exam_submissions left over from a PREVIOUS run of this
    //    suite for this same fixture student/exam. Without this, a second
    //    run leaves multiple submission docs for the same (studentId, examId)
    //    pair sitting in the emulator — and this suite's own query for "the"
    //    submission (`where('examId','==',EXAM_ID).limit(1)`, no orderBy) has
    //    no way to distinguish a fresh in_progress doc this run just created
    //    from an old already-graded one left over from a prior run. Firestore
    //    gives no ordering guarantee on which doc a limit(1) query with no
    //    orderBy returns, so a stale graded doc (pendingManualQuestionIds:
    //    already emptied out by a previous pass) can be returned instead of
    //    the real, freshly-created one — which is exactly what produced a
    //    confusing "auto-grading returned []" failure the first time this
    //    suite was re-run, when the actual bug was test-fixture leakage, not
    //    the grading logic. Deleting here, before startExamAttempt ever
    //    creates a new one, keeps every run starting from a genuinely clean
    //    slate. ──────────────────────────────────────────────────────────────
    const staleSubmissions = await db.collection('students').doc(STUDENT_ID)
        .collection('exam_submissions')
        .where('examId', '==', EXAM_ID)
        .get();
    if (!staleSubmissions.empty) {
        const batch = db.batch();
        staleSubmissions.docs.forEach(doc => batch.delete(doc.ref));
        await batch.commit();
        console.log(`  Cleared ${staleSubmissions.size} leftover exam_submissions doc(s) from a previous run.`);
    }

    // ── School ────────────────────────────────────────────────────────────
    await db.collection('schools').doc(SCHOOL_ID).set({
        isVerified: true,
        schoolName: 'E2E Test School',
        schoolType: 'Secondary',
    });

    // ── Teacher (global teacher model — matches mintTeacherToken's
    //    /teachers/{teacherId} lookup in functions/index.js) ───────────────
    await db.collection('teachers').doc(TEACHER_ID).set({
        pin: sha256Trim(TEACHER_PIN),
        currentSchoolId: SCHOOL_ID,
        name: 'E2E Test Teacher',
        firstName: 'E2E',
        lastName: 'Teacher',
        archived: false,
        securityQuestionsSet: true, // skip the first-time-setup redirect in teacher/login.js
        profileComplete: true,
        subjects: [{ id: SUBJECT_ID, name: 'E2E Subject', description: '', archived: false, archivedAt: null }],
        classes: [CLASS_ID],
    });

    // ── Student (matches mintStudentToken's /students/{studentId} lookup) ──
    await db.collection('students').doc(STUDENT_ID).set({
        pin: sha256Trim(STUDENT_PIN),
        currentSchoolId: SCHOOL_ID,
        name: 'E2E Test Student',
        firstName: 'E2E',
        lastName: 'Student',
        classId: CLASS_ID,
        enrollmentStatus: 'Active',
        securityQuestionsSet: true, // skip the first-time-setup redirect in student/login.js
    });

    // ── Class / Subject (nested under the school, per Phase 0's model) ─────
    await db.collection('schools').doc(SCHOOL_ID)
        .collection('classes').doc(CLASS_ID)
        .set({ name: 'E2E Class', order: 0, teacherIds: [TEACHER_ID] });

    await db.collection('schools').doc(SCHOOL_ID)
        .collection('classes').doc(CLASS_ID)
        .collection('subjects').doc(SUBJECT_ID)
        .set({ name: 'E2E Subject', schoolId: SCHOOL_ID, classId: CLASS_ID, archived: false });

    // ── Exam config — one multiple_choice (auto-graded) + one free_response
    //    (manually graded via recordManualGrade, since no grading UI exists
    //    yet — see this repo's Phase 3 standing note) ────────────────────────
    await db.collection('schools').doc(SCHOOL_ID)
        .collection('classes').doc(CLASS_ID)
        .collection('subjects').doc(SUBJECT_ID)
        .collection('exams').doc(EXAM_ID)
        .set({
            title: 'E2E Test Exam',
            isLive: true,
            timeLimitSeconds: 1800, // 30 minutes — long enough that the countdown never interferes with a normal test run
            questions: [
                {
                    id: 'q1',
                    type: 'multiple_choice',
                    prompt: 'What is 2 + 2?',
                    points: 5,
                    options: ['3', '4', '5', '6'],
                },
                {
                    id: 'q2',
                    type: 'free_response',
                    prompt: 'Explain your reasoning in one sentence.',
                    points: 5,
                },
            ],
        });

    // ── Answer key — exam_answer_keys is `allow read, write: if false` for
    //    every client; only the Admin SDK (this script, or
    //    autoGradeObjectiveAnswers) ever touches it ──────────────────────────
    await db.collection('exam_answer_keys').doc(EXAM_ID).set({
        answers: {
            q1: { correctValue: '4' },
        },
    });

    console.log('Seed complete:');
    console.log(`  School:  ${SCHOOL_ID}`);
    console.log(`  Teacher: ${TEACHER_ID} / PIN ${TEACHER_PIN}`);
    console.log(`  Student: ${STUDENT_ID} / PIN ${STUDENT_PIN}`);
    console.log(`  Exam:    ${EXAM_ID} (class ${CLASS_ID}, subject ${SUBJECT_ID}) — q1 multiple_choice (correct: "4"), q2 free_response`);
}

module.exports = {
    SCHOOL_ID, CLASS_ID, SUBJECT_ID, EXAM_ID, TEACHER_ID, STUDENT_ID, TEACHER_PIN, STUDENT_PIN,
    seed,
};

// Only run automatically when invoked directly (`node seed.js` / `npm run
// seed`) — NOT when required as a module by a .spec.js file, which needs
// the exported constants/seed() without triggering a run or a process exit.
if (require.main === module) {
    seed()
        .then(() => process.exit(0))
        .catch((err) => {
            console.error('Seed failed:', err);
            process.exit(1);
        });
}
