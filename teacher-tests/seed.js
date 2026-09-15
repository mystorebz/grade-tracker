// Seeds a clean, known-good school/teacher/student fixture set into the
// Firebase emulator for the Teacher Portal Playwright suite in this folder.
//
// Follows the SAME Admin-SDK-against-the-emulator pattern already
// established in this repo by exam-tests/seed.js (and, one level down,
// functions/test-exam-init.js / functions/test-record-manual-grade.js) —
// this is a sibling suite, not a new convention. PINs are hashed with the
// same sha256Trim algorithm the real login pages and functions/index.js
// use, because these tests drive the ACTUAL teacher/login.html form through
// a real browser rather than minting a token directly.
//
// This file is BOTH a standalone script (`npm run seed`, or `node seed.js`)
// AND a module the .spec.js files import for fixture IDs/PINs and to call
// seed() from a Playwright beforeAll/beforeEach. Requiring it does NOT run
// anything by itself — only calling seed() does.
//
// Safe to re-run — every document uses a fixed, deterministic ID and is
// written with .set() (overwrite), matching exam-tests/seed.js's own
// idempotent-seed style. The Phase 2 spec deliberately re-runs seed()
// before EACH test (not just once) because a couple of those tests mutate a
// student's grade directly via the Admin SDK to prove a threshold crossing
// (see phase2-command-center.spec.js) — reseeding restores the known-good
// baseline scores before the next test runs, rather than leaking a mutated
// grade into it.

const admin = require('firebase-admin');
const crypto = require('crypto');

// ── Fixture IDs — shared with the .spec.js files in this folder ─────────
const SCHOOL_ID = 'TCH-E2E-SCHOOL';
const SEMESTER_ID = 'tch-e2e-sem-1';
const SEMESTER_NAME = 'E2E Term 1';
const CLASS_NAME = 'E2E Homeroom'; // display-only pill text on home.html; no real class doc is required for Phase 1/2 assertions

// Fixture ID FORMAT NOTE: functions/index.js's mintTeacherToken/
// mintStudentToken enforce a strict shape server-side —
//   Teacher: /^T\d{2}-[A-Z0-9]{5}$/   e.g. T26-TCH01
//   Student: /^S\d{2}-[A-Z0-9]{5}$/   e.g. S26-STU01
// (T/S + 2-digit year + hyphen + EXACTLY 5 alphanumeric chars). An ID outside
// that shape is rejected with "Invalid Teacher/Student ID format." before
// Firestore is ever queried — this bit an earlier version of this file,
// whose IDs (e.g. 'T26-TCHE2E1') were 7 chars after the hyphen instead of 5,
// causing every seeded login in this suite to fail that regex check up
// front. Kept 2 chars shorter than exam-tests/seed.js's own IDs
// (T26-E2E01 / S26-E2E01) so the two suites' fixtures can never collide if
// both are ever run against the same emulator without a reset in between.

// One fully-onboarded teacher with a small roster + grades, for login (1.1,
// 1.2, 1.3) and the whole Command Center suite (Phase 2).
const TEACHER_ID = 'T26-TCH01';
const TEACHER_PIN = '1234';

// A second teacher, archived, for the deactivated-routing test (1.4).
const TEACHER_ARCHIVED_ID = 'T26-TCH02';
const TEACHER_ARCHIVED_PIN = '1234';

// A third teacher, deliberately incomplete, for the onboarding flow (1.8-1.10).
const TEACHER_ONBOARDING_ID = 'T26-TCH03';
const TEACHER_ONBOARDING_PIN = '1234';

// A fourth teacher with zero students, for the empty-states test (2.13).
const TEACHER_EMPTY_ID = 'T26-TCH04';
const TEACHER_EMPTY_PIN = '1234';

// Three students under TEACHER_ID, each with exactly ONE grade doc. Kept to
// one grade apiece deliberately: with no schools/{id}/teaching_assignments
// weighting doc seeded, assets/js/utils.js's calculateWeightedAverage()
// falls back to a flat average of each grade's (score/max)*100 — with only
// one grade per student that fallback's result is unambiguous and exactly
// equal to that single grade's own percentage, regardless of what grade
// "type" is configured, so these numbers can't drift if the weighting
// system's internals change later.
const STUDENT_BELOW_65_ID = 'S26-STU01'; // 60% -> below BOTH the 65% "Needs Attention" cutoff and the 70% "At-Risk Flagging" cutoff
const STUDENT_67_ID = 'S26-STU02';       // 67% -> below the 70% At-Risk Flagging cutoff only (>= 65, so NOT "Needs Attention")
const STUDENT_HEALTHY_ID = 'S26-STU03';  // 95% -> below neither

// ── Phase 3 (Roster) & Phase 4 (Subjects) fixtures ──────────────────────
// Deliberately a SEPARATE teacher/class/roster from TEACHER_ID above, not
// an extension of it. Phase 2's Command Center tests hard-code exact
// student/grade/at-risk counts for TEACHER_ID's 3-student roster — adding
// students, grades, or classes there for Roster/Subjects testing would
// silently break already-passing Phase 1/2 assertions. This whole block is
// its own sandbox that Phase 1/2 never reads.
const TEACHER_ROSTER_ID = 'T26-TCH05';
const TEACHER_ROSTER_PIN = '1234';

// Two classes assigned to this teacher (so roster.js's class-filter
// dropdown — hidden whenever a teacher has <=1 class — is visible for
// 3.6), plus a third class that exists at the SCHOOL level but is assigned
// to NO teacher at all, used only as a promotion destination to exercise
// the "0 or 2+ owning teachers -> teacherId left blank, reported as
// unresolved" branch in roster.js's promote flow (3.20).
const CLASS_ROSTER_NAME = 'E2E Roster Homeroom';
const CLASS_ROSTER_ID = 'cls-e2e-roster-1';
const CLASS_ROSTER_NAME_2 = 'E2E Roster Second Period'; // assigned to the teacher, deliberately empty (no students) — exists purely so classes.length >= 2
const CLASS_ROSTER_ID_2 = 'cls-e2e-roster-2';
const CLASS_ROSTER_NAME_ORPHAN = 'E2E Roster Orphan Class'; // exists at the school, owned by no teacher
const CLASS_ROSTER_ID_ORPHAN = 'cls-e2e-roster-orphan';

// Three static students under CLASS_ROSTER_NAME for the non-destructive
// Roster tests (3.6 search/filters, 3.7 deep-link, 3.10 evaluations, 3.12-
// 3.14 report cards) and for Subjects' Review Submissions roster (4.12).
// Destructive tests (3.17-3.22) must NEVER touch these three — per the
// architectural mandate, each of those tests creates its own disposable
// student through the real Add Student UI at run time instead (see
// createDisposableStudent() in phase3-roster.spec.js).
const STUDENT_ROSTER_A_ID = 'S26-RST01'; // 85% -> "Good Standing"; submits (but is not graded against) the Phase 4 fixture assignment
const STUDENT_ROSTER_B_ID = 'S26-RST02'; // 55% -> "At Risk"; IS graded against the Phase 4 fixture assignment (that grade doubles as this student's only grade)
const STUDENT_ROSTER_NO_CLASS_ID = 'S26-RST03'; // className:'' and zero grades -> "No Grades" standing tier, and the 3.7 "not assigned to a class" alert case

// One subject + one standard (non-assessment) assignment under
// CLASS_ROSTER_ID, for Subjects-page tests 4.3 (Performance filters) and
// 4.12 (Review Submissions N-of-M + deep link). Lives in the SAME class as
// the three roster students above so Review Submissions' roster naturally
// includes them.
const SUBJECT_ID = 'sub-e2e-1';
const SUBJECT_NAME = 'E2E Geography'; // distinct from any other grade doc's plain-string subject name in this file, so the subject-name-uniqueness check (4.1) never accidentally collides with it
const ASSIGNMENT_ID = 'asg-e2e-1';
const ASSIGNMENT_TITLE = 'E2E Map Quiz';

// A second semester, WITH a midterm window configured, alongside the
// existing SEMESTER_ID (which deliberately has none) — lets the Report
// Card tests (3.13, 3.14) exercise both the "no midterm configured" block
// and the "midterm configured" success path just by picking a different
// grading period in the same modal, rather than mutating shared state
// mid-test.
const SEMESTER_MIDTERM_ID = 'tch-e2e-sem-2';
const SEMESTER_MIDTERM_NAME = 'E2E Term 2 (Midterm Configured)';

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

function baseTeacher(overrides) {
    return {
        currentSchoolId: SCHOOL_ID,
        name: 'E2E Teacher',
        firstName: 'E2E',
        lastName: 'Teacher',
        archived: false,
        classes: [CLASS_NAME],
        subjects: [],
        ...overrides,
    };
}

async function seed() {
    ensureApp();
    const db = admin.firestore();

    console.log('=== Seeding teacher-tests fixtures into the Firestore emulator ===');

    // ── School + active semester (home.js reads schools/{id}.activeSemesterId
    //    and schools/{id}/semesters to populate the period selector and to
    //    scope the grades query — both are required for fetchMetrics() to
    //    return anything other than the "no semester" empty branch). ────────
    await db.collection('schools').doc(SCHOOL_ID).set({
        isVerified: true,
        schoolName: 'Teacher-Tests E2E School',
        schoolType: 'Secondary',
        activeSemesterId: SEMESTER_ID,
    });
    await db.collection('schools').doc(SCHOOL_ID)
        .collection('semesters').doc(SEMESTER_ID)
        .set({ name: SEMESTER_NAME, order: 0 });

    // ── Teachers ──────────────────────────────────────────────────────────
    await db.collection('teachers').doc(TEACHER_ID).set(baseTeacher({
        pin: sha256Trim(TEACHER_PIN),
        name: 'E2E Complete Teacher',
        securityQuestionsSet: true,
        requiresPinReset: false,
        profileComplete: true,
    }));

    await db.collection('teachers').doc(TEACHER_ARCHIVED_ID).set(baseTeacher({
        pin: sha256Trim(TEACHER_ARCHIVED_PIN),
        name: 'E2E Archived Teacher',
        archived: true,
        securityQuestionsSet: true,
        requiresPinReset: false,
        profileComplete: true,
    }));

    // Deliberately incomplete: requiresPinReset true / securityQuestionsSet
    // false lands on onboarding.js's Step 1 (Security); profileComplete
    // false is what makes teacher/login.js route here at all instead of
    // straight to home.html.
    await db.collection('teachers').doc(TEACHER_ONBOARDING_ID).set(baseTeacher({
        pin: sha256Trim(TEACHER_ONBOARDING_PIN),
        name: 'E2E Onboarding Teacher',
        securityQuestionsSet: false,
        requiresPinReset: true,
        profileComplete: false,
    }));

    await db.collection('teachers').doc(TEACHER_EMPTY_ID).set(baseTeacher({
        pin: sha256Trim(TEACHER_EMPTY_PIN),
        name: 'E2E Empty Teacher',
        securityQuestionsSet: true,
        requiresPinReset: false,
        profileComplete: true,
    }));

    // ── Students (global `students` collection — home.js queries it with
    //    where('currentSchoolId','==',schoolId) + where('enrollmentStatus',
    //    '==','Active'), then filters client-side by teacherId). ───────────
    const students = [
        { id: STUDENT_BELOW_65_ID, name: 'E2E Student Below65', score: 60 },
        { id: STUDENT_67_ID, name: 'E2E Student At67', score: 67 },
        { id: STUDENT_HEALTHY_ID, name: 'E2E Student Healthy', score: 95 },
    ];

    for (const s of students) {
        await db.collection('students').doc(s.id).set({
            currentSchoolId: SCHOOL_ID,
            teacherId: TEACHER_ID,
            name: s.name,
            enrollmentStatus: 'Active',
            className: CLASS_NAME,
        });

        // Clear any grade left over from a previous run before writing the
        // fresh one, same defensive reasoning as exam-tests/seed.js's
        // stale-submission cleanup: a leftover doc from an earlier mutated
        // (2.2's threshold-crossing) run must never coexist with this run's
        // fixture doc under a different auto-generated id.
        const existing = await db.collection('students').doc(s.id).collection('grades').get();
        if (!existing.empty) {
            const batch = db.batch();
            existing.docs.forEach(d => batch.delete(d.ref));
            await batch.commit();
        }

        // FIELD NAMES: matches the REAL schema grade_form.js's commitGrade()
        // writes via saveGrade() (fields = {schoolId, teacherId, semesterId,
        // className, subject, type, date, title, score, max, notes}) — NOT
        // 'subjectName'/'assignmentTitle'/'classId', which don't exist
        // anywhere in that write path. An earlier version of this file used
        // those wrong names; it went undetected because Phase 1/2's
        // assertions (home.js/roster.js standing badges) only ever read
        // score/max/type via calculateWeightedAverage(), never subject/title.
        // Phase 4's subjects.js DOES read g.subject (tile grid, line ~253)
        // and g.title (search filter, line ~446), so getting this right here
        // is load-bearing for Phase 4, not just cosmetic.
        await db.collection('students').doc(s.id).collection('grades').doc('tch-e2e-grade-1').set({
            studentId: s.id,
            schoolId: SCHOOL_ID,
            teacherId: TEACHER_ID,
            semesterId: SEMESTER_ID,
            className: CLASS_NAME,
            subject: 'E2E Subject',
            title: 'E2E Seeded Assignment',
            type: 'Test',
            score: s.score,
            max: 100,
            date: new Date().toISOString(),
            notes: '',
        });
    }

    // ── Phase 3/4 sandbox: second semester with a midterm window ─────────
    await db.collection('schools').doc(SCHOOL_ID)
        .collection('semesters').doc(SEMESTER_MIDTERM_ID)
        .set({
            name: SEMESTER_MIDTERM_NAME,
            order: 1,
            midterm: { name: 'Midterm Check', startDate: '2026-01-01', endDate: '2026-02-15' },
        });

    // ── Phase 3/4 sandbox: classes ────────────────────────────────────────
    await db.collection('schools').doc(SCHOOL_ID)
        .collection('classes').doc(CLASS_ROSTER_ID)
        .set({ name: CLASS_ROSTER_NAME, order: 0 });
    await db.collection('schools').doc(SCHOOL_ID)
        .collection('classes').doc(CLASS_ROSTER_ID_2)
        .set({ name: CLASS_ROSTER_NAME_2, order: 1 });
    await db.collection('schools').doc(SCHOOL_ID)
        .collection('classes').doc(CLASS_ROSTER_ID_ORPHAN)
        .set({ name: CLASS_ROSTER_NAME_ORPHAN, order: 2 });

    // ── Phase 3/4 sandbox: teacher ─────────────────────────────────────────
    await db.collection('teachers').doc(TEACHER_ROSTER_ID).set(baseTeacher({
        pin: sha256Trim(TEACHER_ROSTER_PIN),
        name: 'E2E Roster Teacher',
        classes: [CLASS_ROSTER_NAME, CLASS_ROSTER_NAME_2],
        securityQuestionsSet: true,
        requiresPinReset: false,
        profileComplete: true,
    }));

    // ── Phase 3/4 sandbox: students ─────────────────────────────────────────
    const rosterStudents = [
        { id: STUDENT_ROSTER_A_ID, name: 'E2E Roster Student Good', className: CLASS_ROSTER_NAME, score: 85, gradeId: 'tch-e2e-roster-grade-a' },
        { id: STUDENT_ROSTER_B_ID, name: 'E2E Roster Student Risk', className: CLASS_ROSTER_NAME, score: 55, gradeId: 'tch-e2e-roster-grade-b', assignmentId: ASSIGNMENT_ID },
    ];
    for (const s of rosterStudents) {
        await db.collection('students').doc(s.id).set({
            currentSchoolId: SCHOOL_ID,
            teacherId: TEACHER_ROSTER_ID,
            name: s.name,
            enrollmentStatus: 'Active',
            className: s.className,
        });

        const existing = await db.collection('students').doc(s.id).collection('grades').get();
        if (!existing.empty) {
            const batch = db.batch();
            existing.docs.forEach(d => batch.delete(d.ref));
            await batch.commit();
        }

        // Same real-schema correction as the Phase 1/2 loop above: subject/
        // title (not subjectName/assignmentTitle), no classId. This is what
        // makes this student actually show up under E2E Geography's tile
        // (subjects.js's getAllGrades().filter(g => g.subject === sub.name))
        // and match the 4.3 title-search filter (g.title).
        const gradeDoc = {
            studentId: s.id,
            schoolId: SCHOOL_ID,
            teacherId: TEACHER_ROSTER_ID,
            semesterId: SEMESTER_ID,
            className: s.className,
            subject: SUBJECT_NAME,
            title: s.assignmentId ? ASSIGNMENT_TITLE : 'E2E Roster Seeded Assignment',
            type: 'Test',
            score: s.score,
            max: 100,
            date: new Date().toISOString(),
            notes: '',
        };
        if (s.assignmentId) gradeDoc.assignmentId = s.assignmentId; // ties this grade to the Review Submissions fixture assignment (4.12) — matches assets/js/utils.js's saveGrade() convention
        await db.collection('students').doc(s.id).collection('grades').doc(s.gradeId).set(gradeDoc);
    }

    // Student with no class assigned at all (className:'') and zero grades —
    // 3.7's "not assigned to a class" alert case, and the "No Grades"
    // standing-filter tier (3.6).
    await db.collection('students').doc(STUDENT_ROSTER_NO_CLASS_ID).set({
        currentSchoolId: SCHOOL_ID,
        teacherId: TEACHER_ROSTER_ID,
        name: 'E2E Roster Student Unassigned',
        enrollmentStatus: 'Active',
        className: '',
    });
    const staleNoClassGrades = await db.collection('students').doc(STUDENT_ROSTER_NO_CLASS_ID).collection('grades').get();
    if (!staleNoClassGrades.empty) {
        const batch = db.batch();
        staleNoClassGrades.docs.forEach(d => batch.delete(d.ref));
        await batch.commit();
    }

    // Evaluations accumulate via addDoc() in the real app (no fixed doc id
    // to overwrite), unlike everything else in this file — clear them on
    // every reseed so repeated local test runs don't pile up stale records
    // under the fixture students (harmless to correctness, but keeps the
    // emulator's state actually reflecting "a fresh run").
    for (const id of [STUDENT_ROSTER_A_ID, STUDENT_ROSTER_B_ID]) {
        const staleEvals = await db.collection('students').doc(id).collection('evaluations').get();
        if (!staleEvals.empty) {
            const batch = db.batch();
            staleEvals.docs.forEach(d => batch.delete(d.ref));
            await batch.commit();
        }
    }

    // ── Phase 3/4 sandbox: subject + one standard assignment ────────────────
    await db.collection('schools').doc(SCHOOL_ID)
        .collection('classes').doc(CLASS_ROSTER_ID)
        .collection('subjects').doc(SUBJECT_ID)
        .set({
            name: SUBJECT_NAME,
            description: '',
            schoolId: SCHOOL_ID,
            classId: CLASS_ROSTER_ID,
            archived: false,
            archivedAt: null,
            createdAt: new Date().toISOString(),
        });

    const assignmentRef = db.collection('schools').doc(SCHOOL_ID)
        .collection('classes').doc(CLASS_ROSTER_ID)
        .collection('subjects').doc(SUBJECT_ID)
        .collection('assignments').doc(ASSIGNMENT_ID);
    await assignmentRef.set({
        id: ASSIGNMENT_ID,
        title: ASSIGNMENT_TITLE,
        type: 'Test',
        maxScore: 100,
        date: null,
        instructions: '',
        description: '',
        locked: false,
        lockedAt: null,
        completed: false,
        attachments: [],
        category: 'standard',
        questions: [],
        teacherId: TEACHER_ROSTER_ID,
        createdAt: new Date().toISOString(),
        updatedAt: new Date().toISOString(),
    });

    // Clear and reseed the assignment's submissions subcollection — only
    // STUDENT_ROSTER_A_ID has submitted (STUDENT_ROSTER_B_ID is graded
    // instead, via the grade doc above with assignmentId set; the
    // no-class student never appears in this class's roster at all), so
    // Review Submissions (4.12) has a deterministic "1 of 2 submitted" /
    // "1 of 2 graded" to assert against.
    const staleSubmissions = await assignmentRef.collection('submissions').get();
    if (!staleSubmissions.empty) {
        const batch = db.batch();
        staleSubmissions.docs.forEach(d => batch.delete(d.ref));
        await batch.commit();
    }
    await assignmentRef.collection('submissions').doc(STUDENT_ROSTER_A_ID).set({
        studentId: STUDENT_ROSTER_A_ID,
        studentName: 'E2E Roster Student Good',
        assignmentId: ASSIGNMENT_ID,
        assignmentTitle: ASSIGNMENT_TITLE,
        workType: 'Test',
        subjectId: SUBJECT_ID,
        subjectName: SUBJECT_NAME,
        classId: CLASS_ROSTER_ID,
        className: CLASS_ROSTER_NAME,
        status: 'submitted',
        responseText: 'E2E seeded submission text.',
        submittedAt: new Date().toISOString(),
        updatedAt: new Date().toISOString(),
    });

    console.log('Seed complete:');
    console.log(`  School:              ${SCHOOL_ID} (active semester: ${SEMESTER_ID})`);
    console.log(`  Complete teacher:    ${TEACHER_ID} / PIN ${TEACHER_PIN}`);
    console.log(`  Archived teacher:    ${TEACHER_ARCHIVED_ID} / PIN ${TEACHER_ARCHIVED_PIN}`);
    console.log(`  Onboarding teacher:  ${TEACHER_ONBOARDING_ID} / PIN ${TEACHER_ONBOARDING_PIN}`);
    console.log(`  Empty-roster teacher:${TEACHER_EMPTY_ID} / PIN ${TEACHER_EMPTY_PIN}`);
    console.log(`  Students (all under ${TEACHER_ID}): ${STUDENT_BELOW_65_ID} (60%), ${STUDENT_67_ID} (67%), ${STUDENT_HEALTHY_ID} (95%)`);
    console.log(`  Roster/Subjects teacher: ${TEACHER_ROSTER_ID} / PIN ${TEACHER_ROSTER_PIN} (classes: ${CLASS_ROSTER_NAME}, ${CLASS_ROSTER_NAME_2}; orphan class: ${CLASS_ROSTER_NAME_ORPHAN})`);
    console.log(`  Roster students (under ${CLASS_ROSTER_NAME}): ${STUDENT_ROSTER_A_ID} (85%, submitted), ${STUDENT_ROSTER_B_ID} (55%, graded), ${STUDENT_ROSTER_NO_CLASS_ID} (no class, no grades)`);
    console.log(`  Subject/assignment: ${SUBJECT_NAME} / ${ASSIGNMENT_TITLE}`);
}

/**
 * Directly overwrites one seeded student's grade score via the Admin SDK,
 * bypassing the UI entirely — used only by the Phase 2 test that proves the
 * At-Risk banner disappears once a student's average crosses back above the
 * 65% threshold (see the QA plan's test 2.2). Kept here rather than duplicated
 * inline in the spec so the grade doc's shape only needs to be correct in
 * one place.
 */
async function setStudentScore(studentId, score) {
    ensureApp();
    const db = admin.firestore();
    await db.collection('students').doc(studentId)
        .collection('grades').doc('tch-e2e-grade-1')
        .set({ score }, { merge: true });
}

/**
 * Reads back a student document's raw fields via the Admin SDK — used by
 * the Phase 3 destructive-action tests (archive/promote, 3.17-3.22) to
 * verify the *actual* Firestore field changes those actions write (per
 * roster.js's real update/batch calls), not just what the UI visibly does.
 * Returns null if the student doesn't exist (e.g. a bad id was passed).
 */
async function getStudentDoc(studentId) {
    ensureApp();
    const db = admin.firestore();
    const snap = await db.collection('students').doc(studentId).get();
    return snap.exists ? snap.data() : null;
}

/**
 * Reads back a school-level notification document — used by the 3.18
 * (Archive/Release) test to confirm the `student_enrollment_closed`
 * notification roster.js writes as a side effect of closing enrollment.
 * Returns the first matching doc's data, or null if none exists yet.
 */
async function findNotification(studentId, type) {
    ensureApp();
    const db = admin.firestore();
    const snap = await db.collection('schools').doc(SCHOOL_ID)
        .collection('notifications')
        .where('studentId', '==', studentId)
        .where('type', '==', type)
        .limit(1)
        .get();
    return snap.empty ? null : snap.docs[0].data();
}

/**
 * Reads back a real per-class subject doc — used by the 4.2 (Archive
 * Subject) test to confirm the write is exactly {archived:true,
 * archivedAt:<iso>} and nothing else on the document changed (name,
 * description, classId, createdAt all untouched).
 */
async function getSubjectDoc(classId, subjectId) {
    ensureApp();
    const db = admin.firestore();
    const snap = await db.collection('schools').doc(SCHOOL_ID)
        .collection('classes').doc(classId)
        .collection('subjects').doc(subjectId)
        .get();
    return snap.exists ? snap.data() : null;
}

/**
 * Finds a real per-class subject doc by its (unique, teacher-chosen) name
 * rather than its Firestore id — subjects.js's saveSubject() generates the
 * id client-side via genId(), so a test that created the subject through
 * the real Add Subject UI has no way to know that id ahead of time. Used by
 * the 4.2 (Archive Subject) test.
 */
async function findSubjectDoc(classId, name) {
    ensureApp();
    const db = admin.firestore();
    const snap = await db.collection('schools').doc(SCHOOL_ID)
        .collection('classes').doc(classId)
        .collection('subjects')
        .where('name', '==', name)
        .limit(1)
        .get();
    return snap.empty ? null : { id: snap.docs[0].id, ...snap.docs[0].data() };
}

/**
 * Reads back a single grade doc by its known id — used by the 4.11
 * (Delete Assignment) test to confirm a grade record already on file under
 * the deleted assignment's title is untouched by deleteAssignment() (which,
 * per subjects.js's own confirm() text, only ever deletes the assignment
 * template doc itself, never touches students/{id}/grades).
 */
async function getGradeDoc(studentId, gradeDocId) {
    ensureApp();
    const db = admin.firestore();
    const snap = await db.collection('students').doc(studentId)
        .collection('grades').doc(gradeDocId).get();
    return snap.exists ? snap.data() : null;
}

/**
 * Writes a one-off grade record directly via the Admin SDK, in the REAL
 * schema shape grade_form.js's commitGrade() produces (subject/title, not
 * subjectName/assignmentTitle — see the corrected rosterStudents grade docs
 * above). Used only by the 4.11 Delete Assignment test to simulate "a grade
 * already recorded with this [assignment's] title" ahead of deleting the
 * assignment template, without having to drive the full Enter Grade UI just
 * to set up that precondition.
 */
async function setAdHocGrade(studentId, gradeDocId, fields) {
    ensureApp();
    const db = admin.firestore();
    await db.collection('students').doc(studentId).collection('grades').doc(gradeDocId).set({
        studentId,
        schoolId: SCHOOL_ID,
        historyLogs: [],
        createdAt: new Date().toISOString(),
        ...fields,
    });
}

module.exports = {
    SCHOOL_ID, SEMESTER_ID, SEMESTER_NAME, CLASS_NAME,
    TEACHER_ID, TEACHER_PIN,
    TEACHER_ARCHIVED_ID, TEACHER_ARCHIVED_PIN,
    TEACHER_ONBOARDING_ID, TEACHER_ONBOARDING_PIN,
    TEACHER_EMPTY_ID, TEACHER_EMPTY_PIN,
    STUDENT_BELOW_65_ID, STUDENT_67_ID, STUDENT_HEALTHY_ID,
    // Phase 3 (Roster) & Phase 4 (Subjects) sandbox
    TEACHER_ROSTER_ID, TEACHER_ROSTER_PIN,
    CLASS_ROSTER_NAME, CLASS_ROSTER_ID,
    CLASS_ROSTER_NAME_2, CLASS_ROSTER_ID_2,
    CLASS_ROSTER_NAME_ORPHAN, CLASS_ROSTER_ID_ORPHAN,
    STUDENT_ROSTER_A_ID, STUDENT_ROSTER_B_ID, STUDENT_ROSTER_NO_CLASS_ID,
    SUBJECT_ID, SUBJECT_NAME, ASSIGNMENT_ID, ASSIGNMENT_TITLE,
    SEMESTER_MIDTERM_ID, SEMESTER_MIDTERM_NAME,
    seed,
    setStudentScore,
    getStudentDoc,
    findNotification,
    getSubjectDoc,
    findSubjectDoc,
    getGradeDoc,
    setAdHocGrade,
};

// Only run automatically when invoked directly (`node seed.js` / `npm run
// seed`) — NOT when required as a module by a .spec.js file.
if (require.main === module) {
    seed()
        .then(() => process.exit(0))
        .catch((err) => {
            console.error('Seed failed:', err);
            process.exit(1);
        });
}
