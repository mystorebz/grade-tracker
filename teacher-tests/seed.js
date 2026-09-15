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

// ── Phase 5 (Grade Entry) & Phase 6 (Gradebook) fixtures ────────────────
// A third, separate sandbox teacher — grade_form.html and gradebook.html
// are two views onto the exact same students/{id}/grades documents, so
// they share one teacher/class/roster here rather than each getting their
// own, the same way Phase 3 and Phase 4 already share TEACHER_ROSTER_ID's
// sandbox. Still fully isolated from every earlier phase's fixtures.
const TEACHER_GRADE_ID = 'T26-TCH06';
const TEACHER_GRADE_PIN = '1234';

const CLASS_GRADE_NAME = 'E2E Grade Entry Homeroom';
const CLASS_GRADE_ID = 'cls-e2e-grade-1';

const SUBJECT_GRADE_ID = 'sub-e2e-grade-1';
const SUBJECT_GRADE_NAME = 'E2E Grade Entry Science';

// Three students with a clean, deterministic roster order isn't guaranteed
// by Firestore — every spec file reads the ACTUAL rendered order out of the
// DOM (#agStudent's options / #gfRosterList's buttons) rather than assuming
// these three come back in id order, especially for 5.7's wraparound test.
// None of the three has any grade yet — every assignment below starts
// fully ungraded across the whole roster.
const STUDENT_GRADE_1_ID = 'S26-GRD01';
const STUDENT_GRADE_2_ID = 'S26-GRD02';
const STUDENT_GRADE_3_ID = 'S26-GRD03';

// A fourth, disposable student that ONLY the Phase 6 destructive-delete
// test (6.4) ever touches — kept off the other three students' roster
// entirely so a deleted grade record can never be confused with anything
// 6.3/6.6/6.7/6.8 depend on.
const STUDENT_GRADE_DELETE_ID = 'S26-GRDDL';

// A real, prepared STANDARD (non-assessment) assignment — used by 5.1 (the
// "select a real prepared assignment" branch of the 3-step router) and 5.7
// (Commit & Next wraparound: simple single-score grading, no per-question
// tally to fill in first).
const ASSIGNMENT_STANDARD_ID = 'asg-e2e-grade-std';
const ASSIGNMENT_STANDARD_TITLE = 'E2E Grade Entry Reading Log';

// A real ASSESSMENT assignment (category:'assessment', real questions[]) —
// one multiple_choice question (auto-gradable) + one free_response question
// (never auto-graded, per functions/index.js's autoGradeWorkSubmission) —
// used by 5.4 (per-question auto-tally) and 5.5 (Request Revision). Answer
// key lives in work_answer_keys/{assignmentId}, mirroring exactly what
// subjects.js's awSaveWork() itself writes for a real Multiple Choice
// question, so grade_form.js's own reads of that collection stay realistic
// even though this suite seeds the "auto-grade result" directly (see the
// submission doc below) rather than depending on the Functions emulator's
// Firestore trigger actually firing during seed — the same
// isolate-from-async-triggers reasoning the rest of this suite already
// follows for anything time-sensitive.
const ASSIGNMENT_ASSESS_ID = 'asg-e2e-grade-assess';
const ASSIGNMENT_ASSESS_TITLE = 'E2E Grade Entry Science Quiz';
const QUESTION_MC_ID = 'q_mc1';
const QUESTION_FR_ID = 'q_fr1';

// Fixed grade-doc ids (Admin SDK .doc(id).set() doesn't care that the real
// app would normally addDoc() a random one) so the Phase 6 spec can read
// them straight back without a lookup-by-field query.
const GRADEBOOK_EDIT_GRADE_ID = 'tch-e2e-gradebook-edit-target';   // 6.3
const GRADEBOOK_DELETE_GRADE_ID = 'tch-e2e-gradebook-delete-target'; // 6.4
const GRADEBOOK_EDIT_TITLE = 'E2E Gradebook Edit Target';

// ── Phase 7 (Attendance) fixtures ────────────────────────────────────────
// A dedicated sandbox teacher with TWO real classes (not one) — 7.1 needs a
// genuine second class to switch the dropdown to and prove the roster
// actually reloads, not just re-renders the same list.
const TEACHER_ATTENDANCE_ID = 'T26-TCH07';
const TEACHER_ATTENDANCE_PIN = '1234';

const CLASS_ATT_A_NAME = 'E2E Attendance Homeroom A';
const CLASS_ATT_A_ID = 'cls-e2e-att-a';
const CLASS_ATT_B_NAME = 'E2E Attendance Homeroom B';
const CLASS_ATT_B_ID = 'cls-e2e-att-b';

// Three students on Class A (enough to prove "Mark all Present" actually
// touches every row, not just the first) and one lone student on Class B
// (enough to prove the roster is genuinely class-scoped on switch).
const STUDENT_ATT_A1_ID = 'S26-ATA01';
const STUDENT_ATT_A2_ID = 'S26-ATA02';
const STUDENT_ATT_A3_ID = 'S26-ATA03';
const STUDENT_ATT_B1_ID = 'S26-ATB01';

// Phase 7.5 (empty state) deliberately reuses TEACHER_EMPTY_ID rather than a
// new fixture — its classes:[CLASS_NAME] already resolves to an EMPTY array
// (no real 'E2E Homeroom' class doc exists anywhere in this file — see
// CLASS_NAME's own comment above), the exact same "zero resolved classes"
// condition attendance.js's init() checks for. Already proven safe to reuse
// this way by phase4-subjects.spec.js's 4.1 test.

// ── Phase 8 (Class Stream) fixtures ──────────────────────────────────────
const TEACHER_STREAM_ID = 'T26-TCH08';
const TEACHER_STREAM_PIN = '1234';
const CLASS_STREAM_NAME = 'E2E Stream Homeroom';
const CLASS_STREAM_ID = 'cls-e2e-stream-1';
const SUBJECT_STREAM_ID = 'sub-e2e-stream-1';
const SUBJECT_STREAM_NAME = 'E2E Stream English';

// Four pre-seeded posts, deliberately timestamped OUT of pin-priority order
// so 8.2 has something real to prove: POST_PINNED is the OLDEST of the four
// by createdAt, yet must render FIRST in the Stream view purely because
// it's pinned (getVisiblePosts() in stream.js floats every pinned post
// above every unpinned one, each group staying newest-first within itself).
// POST_LESSON_PLAN is a type:'lesson_plan' post used by 8.8 — per stream.js's
// own getVisiblePosts(), the Lesson Plans view filters TO only lesson_plan
// posts, but the Stream view does NOT filter lesson_plan posts OUT (it only
// separates pinned from unpinned) — so this fixture is expected to appear
// in BOTH views, not just Lesson Plans. That asymmetry is real, read
// directly out of the source, not a guess.
const POST_PINNED_ID = 'post-e2e-stream-pinned';
const POST_PINNED_TITLE = 'E2E Pinned Announcement';
const POST_UNPINNED_NEW_ID = 'post-e2e-stream-new';
const POST_UNPINNED_NEW_TITLE = 'E2E Newest Announcement';
const POST_UNPINNED_MID_ID = 'post-e2e-stream-mid';
const POST_UNPINNED_MID_TITLE = 'E2E Middle Announcement';
const POST_LESSON_PLAN_ID = 'post-e2e-stream-lesson';
const POST_LESSON_PLAN_TITLE = 'E2E Lesson Plan Fixture';

// ── Phase 9 (Lesson Builder & Live Lessons) sandbox ──────────────────────
const TEACHER_LESSON_ID = 'T26-TCH09';
const TEACHER_LESSON_PIN = '1234';
const CLASS_LESSON_NAME = 'E2E Lesson Homeroom';
const CLASS_LESSON_ID = 'cls-e2e-lesson-1';
const SUBJECT_LESSON_ID = 'sub-e2e-lesson-1';
const SUBJECT_LESSON_NAME = 'E2E Lesson Science';
// 9.3 fixture — a 3-slide draft dedicated to reorder/delete testing.
const LESSON_SLIDES_ID = 'lsn-e2e-slides-1';
const SLIDE_REORDER_A_ID = 'slide-e2e-reorder-a';
const SLIDE_REORDER_B_ID = 'slide-e2e-reorder-b';
const SLIDE_REORDER_C_ID = 'slide-e2e-reorder-c';
// 9.14/9.17 fixture — already-published so its card exposes "Go Live", and
// carrying a live-only interactive_prompt block for the Live Responses test.
const LESSON_LIVE_ID = 'lsn-e2e-live-1';
const SLIDE_LIVE_TITLE_ID = 'slide-e2e-live-title';
const SLIDE_LIVE_PROMPT_ID = 'slide-e2e-live-prompt';

// ── Phase 10 (Exams: grading + live monitor) sandbox ─────────────────────
const TEACHER_EXAM_ID = 'T26-TCH10';
const TEACHER_EXAM_PIN = '1234';
const CLASS_EXAM_NAME = 'E2E Exam Homeroom';
const CLASS_EXAM_ID = 'cls-e2e-exam-1';
const SUBJECT_EXAM_ID = 'sub-e2e-exam-1';
const SUBJECT_EXAM_NAME = 'E2E Exam Science';
const EXAM_ID = 'exam-e2e-1';
const QUESTION_EXAM_MC_ID = 'q-mc-1';
const QUESTION_EXAM_FR_ID = 'q-fr-1';
const STUDENT_EXAM_SUBMITTED_ID = 'S26-EXA01';
const STUDENT_EXAM_INPROGRESS_ID = 'S26-EXA02';
const STUDENT_EXAM_PIN = '1234';
const EXAM_SUBMISSION_SUBMITTED_ID = 'sub-e2e-exam-submitted-1';
const EXAM_SUBMISSION_INPROGRESS_ID = 'sub-e2e-exam-inprogress-1';

// ── PHASE 11: REPORTS (DATA QUERY BUILDER) SANDBOX ───────────────────────
// reports.js's checkbox grids are populated straight from
// session.teacherData.subjects (a plain [{name}] array — the LEGACY
// embedded shape, not the newer per-class subjects subcollection; reports.js
// never reads that subcollection at all) and from getGradeTypes(), which
// falls back to DEFAULT_GRADE_TYPES (plain strings) whenever this teacher
// has neither a schools/{schoolId}/teaching_assignments doc nor legacy
// gradeTypes/customGradeTypes fields — deliberately true for this fixture,
// so calculateWeightedAverage() always takes its activeWeightTotal===0
// failsafe branch (every default type resolves to 0% weight), which is a
// flat mean of every grade's own percentage. That makes every expected
// average in phase11-reports.spec.js plain arithmetic instead of needing to
// replicate the weighting engine.
const TEACHER_REPORTS_ID = 'T26-TCH11';
const TEACHER_REPORTS_PIN = '1234';
const CLASS_REPORTS_NAME = 'E2E Reports Homeroom';
const CLASS_REPORTS_ID = 'cls-e2e-reports-1';
const SUBJECT_REPORTS_A_NAME = 'E2E Reports Math';
const SUBJECT_REPORTS_B_NAME = 'E2E Reports English';
const STUDENT_REPORTS_1_ID = 'S26-RPT01'; // 'One' — Math:{Test 80,Quiz 90}, English:{Test 70} in sem1; Math:{Test 85} in sem2
const STUDENT_REPORTS_2_ID = 'S26-RPT02'; // 'Two' — Math:{Test 60} in sem1, English:{Quiz 100} in sem1; Math:{Test 75} in sem2
const STUDENT_REPORTS_EMPTY_ID = 'S26-RPT03'; // zero grades anywhere — 11.8's "0 results" case

// ── PHASE 12: MY EVALUATIONS SANDBOX ─────────────────────────────────────
// Real evaluations accumulate via addDoc() (no fixed doc id in the real
// app), but a fixed id here is fine and simpler since this fixture is
// reseeded with plain idempotent .set() calls, same as every ad-hoc grade
// elsewhere in this file.
const TEACHER_EVAL_ID = 'T26-TCH12';
const TEACHER_EVAL_PIN = '1234';
const TEACHER_EVAL_EMPTY_ID = 'T26-TCHEM'; // zero evaluation docs — 12.6's empty state
const TEACHER_EVAL_EMPTY_PIN = '1234';
const EVAL_RECENT_ID = 'eval-e2e-recent-1'; // most recent date -> evals[0] after sort -> drives "Latest Action"
const EVAL_MID_ID = 'eval-e2e-mid-1';
const EVAL_OLD_ID = 'eval-e2e-old-1';
const EVAL_PREV_SCHOOL_ID = 'PREV-SCHOOL-E2E-001'; // a school OTHER than SCHOOL_ID, for the "Schools Evaluated At" count (12.1) and the "Previous school" badge

// ── PHASE 13: ARCHIVES SANDBOX ───────────────────────────────────────────
// archives.js's archived-student query is TWO separate Firestore queries
// merged client-side (currentSchoolId+enrollmentStatus-in-[...] OR
// archivedSchoolIds array-contains-schoolId), then filtered again in JS to
// `teacherId === session.teacherId || !teacherId || teacherId === ''` —
// so the fixture below deliberately includes an orphan (no teacherId, must
// still appear) and an archived student that belongs to a DIFFERENT
// teacher (must NOT appear), plus an ACTIVE student under this same
// teacher (must NOT appear), to actually exercise that filter rather than
// just seeding a uniform "all archived, all mine" roster.
// Archived SUBJECTS use the new-model per-class subjects collection (same
// as Phase 4's SUBJECT_ID), since that is what loadTeacherSubjectsCache()
// actually resolves for a teacher with a real class — restoreSubject()/
// permanentDeleteSubject() both branch on sub._source, and the 'new'
// branch is the one exercised here.
const TEACHER_ARCHIVES_ID = 'T26-TCH13';
const TEACHER_ARCHIVES_PIN = '1234';
const CLASS_ARCHIVES_NAME = 'E2E Archives Homeroom';
const CLASS_ARCHIVES_ID = 'cls-e2e-archives-1';
const SUBJECT_ARCHIVES_RESTORE_ID = 'sub-e2e-archives-restore';
const SUBJECT_ARCHIVES_RESTORE_NAME = 'E2E Archives Restore Subject';
const SUBJECT_ARCHIVES_DELETE_ID = 'sub-e2e-archives-delete';
const SUBJECT_ARCHIVES_DELETE_NAME = 'E2E Archives Delete Subject';
const SUBJECT_ARCHIVES_ACTIVE_ID = 'sub-e2e-archives-active';
const SUBJECT_ARCHIVES_ACTIVE_NAME = 'E2E Archives Active Subject'; // NOT archived — negative control for list composition (13.1)
const ASSIGNMENT_ARCHIVES_DELETE_ID = 'asg-e2e-archives-delete'; // proves permanentDeleteSubject()'s cascade-delete of the assignments subcollection (13.7)
const STUDENT_ARCHIVES_RESTORE_ID = 'S26-ARC01';
const STUDENT_ARCHIVES_DELETE_ID = 'S26-ARC02'; // has 1 grade doc, to prove permanentDeleteStudent()'s cascade-delete of the grades subcollection (13.5)
const STUDENT_ARCHIVES_SEARCH_A_ID = 'S26-ARC03'; // name contains 'Zephyr'
const STUDENT_ARCHIVES_SEARCH_B_ID = 'S26-ARC04'; // name contains 'Quincy'
const STUDENT_ARCHIVES_ORPHAN_ID = 'S26-ARC05'; // teacherId '' — must still appear (the `!teacherId` clause)
const STUDENT_ARCHIVES_ACTIVE_ID = 'S26-ARC06'; // enrollmentStatus 'Active' — must NOT appear (negative control)
const STUDENT_ARCHIVES_OTHERTEACHER_ID = 'S26-ARC07'; // archived, but belongs to TEACHER_ID — must NOT appear in TEACHER_ARCHIVES_ID's list

// ── PHASE 14: DEACTIVATED ACCOUNT SANDBOX ────────────────────────────────
// deactivated.html is reached for real via auth.js's requireAuth() "TEACHER
// ARCHIVE WATCHER" (an onSnapshot on the teacher's own doc, active on every
// teacher page): when an admin flips `archived: true` on a teacher who is
// currently logged in elsewhere in the app, that listener fires client-side
// and redirects them here WITHOUT logging them out — session preserved on
// purpose so this page can render their own career summary. That is the
// real, load-bearing path tested here (rather than only a directly-mocked
// session), since normal login already blocks archived teachers up front
// (see the 1.4 finding this mandate references) — login is NOT how a real
// teacher ever ends up on this page.
const TEACHER_DEACT_ID = 'T26-TCH14'; // starts NOT archived at seed time — the test itself flips it via Admin SDK mid-session
const TEACHER_DEACT_PIN = '1234';
const TEACHER_DEACT_EMPTY_ID = 'T26-DEACT'; // seeded ALREADY archived, zero teachingHistory/evaluations — 14.3's empty state
const TEACHER_DEACT_EMPTY_PIN = '1234';

// ── PHASE 15: SETTINGS SANDBOX ───────────────────────────────────────────
const TEACHER_SETTINGS_ID = 'T26-TCH15';
const TEACHER_SETTINGS_PIN = '1234';
const TEACHER_SETTINGS_EMAIL = 'e2e.settings.teacher@example.com';
const TEACHER_SETTINGS_TAKEN_EMAIL = 'e2e.settings.taken@example.com'; // pre-registered to a DIFFERENT teacher, for the 15.2 email-collision block
const TEACHER_SETTINGS_NEW_EMAIL = 'e2e.settings.newemail@example.com'; // NOT pre-registered — the 15.2 successful-change counterpart

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
    // Phase 9/10: admin.database() (setExamPresence/writeLiveResponse's
    // sibling for RTDB, used by the Live Exam Monitor tests) needs a
    // databaseURL to resolve a namespace even once FIREBASE_DATABASE_
    // EMULATOR_HOST is set — that env var only redirects WHERE the request
    // goes, not which namespace it targets. "<projectId>-default-rtdb" is
    // the default namespace the Firebase emulator suite assigns, matching
    // assets/js/firebase-init.js's own connectDatabaseEmulator(rtdb,
    // '127.0.0.1', 9000) call on the client side.
    process.env.FIREBASE_DATABASE_EMULATOR_HOST = process.env.FIREBASE_DATABASE_EMULATOR_HOST || '127.0.0.1:9000';
    if (admin.apps.length === 0) {
        admin.initializeApp({
            projectId: 'school-grade-tracker',
            databaseURL: 'http://127.0.0.1:9000?ns=school-grade-tracker-default-rtdb',
        });
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

    // ── Phase 5/6 sandbox: class + subject ──────────────────────────────
    await db.collection('schools').doc(SCHOOL_ID)
        .collection('classes').doc(CLASS_GRADE_ID)
        .set({ name: CLASS_GRADE_NAME, order: 3 });

    await db.collection('schools').doc(SCHOOL_ID)
        .collection('classes').doc(CLASS_GRADE_ID)
        .collection('subjects').doc(SUBJECT_GRADE_ID)
        .set({
            name: SUBJECT_GRADE_NAME,
            description: '',
            schoolId: SCHOOL_ID,
            classId: CLASS_GRADE_ID,
            archived: false,
            archivedAt: null,
            createdAt: new Date().toISOString(),
        });

    // ── Phase 5/6 sandbox: teacher ───────────────────────────────────────
    await db.collection('teachers').doc(TEACHER_GRADE_ID).set(baseTeacher({
        pin: sha256Trim(TEACHER_GRADE_PIN),
        name: 'E2E Grade Entry Teacher',
        classes: [CLASS_GRADE_NAME],
        securityQuestionsSet: true,
        requiresPinReset: false,
        profileComplete: true,
    }));

    // ── Phase 5/6 sandbox: roster (3 ungraded students + 1 disposable) ──
    const gradeRoster = [
        { id: STUDENT_GRADE_1_ID, name: 'E2E Grade Student One' },
        { id: STUDENT_GRADE_2_ID, name: 'E2E Grade Student Two' },
        { id: STUDENT_GRADE_3_ID, name: 'E2E Grade Student Three' },
        { id: STUDENT_GRADE_DELETE_ID, name: 'E2E Grade Student Disposable' },
    ];
    for (const s of gradeRoster) {
        await db.collection('students').doc(s.id).set({
            currentSchoolId: SCHOOL_ID,
            teacherId: TEACHER_GRADE_ID,
            name: s.name,
            enrollmentStatus: 'Active',
            className: CLASS_GRADE_NAME,
        });
        const staleGrades = await db.collection('students').doc(s.id).collection('grades').get();
        if (!staleGrades.empty) {
            const batch = db.batch();
            staleGrades.docs.forEach(d => batch.delete(d.ref));
            await batch.commit();
        }
    }

    // ── Phase 5/6 sandbox: a real, prepared STANDARD assignment (5.1, 5.7) ──
    await db.collection('schools').doc(SCHOOL_ID)
        .collection('classes').doc(CLASS_GRADE_ID)
        .collection('subjects').doc(SUBJECT_GRADE_ID)
        .collection('assignments').doc(ASSIGNMENT_STANDARD_ID)
        .set({
            id: ASSIGNMENT_STANDARD_ID,
            title: ASSIGNMENT_STANDARD_TITLE,
            type: 'Test',
            maxScore: 20,
            date: null,
            instructions: '',
            description: '',
            locked: false,
            lockedAt: null,
            completed: false,
            attachments: [],
            category: 'standard',
            questions: [],
            teacherId: TEACHER_GRADE_ID,
            createdAt: new Date().toISOString(),
            updatedAt: new Date().toISOString(),
        });

    // ── Phase 5/6 sandbox: a real ASSESSMENT assignment (5.4, 5.5) ──────
    const assessRef = db.collection('schools').doc(SCHOOL_ID)
        .collection('classes').doc(CLASS_GRADE_ID)
        .collection('subjects').doc(SUBJECT_GRADE_ID)
        .collection('assignments').doc(ASSIGNMENT_ASSESS_ID);
    await assessRef.set({
        id: ASSIGNMENT_ASSESS_ID,
        title: ASSIGNMENT_ASSESS_TITLE,
        type: 'Test',
        maxScore: 5,
        date: null,
        instructions: '',
        description: '',
        locked: false,
        lockedAt: null,
        completed: false,
        attachments: [],
        category: 'assessment',
        questions: [
            { id: QUESTION_MC_ID, type: 'multiple_choice', prompt: 'What is H2O?', points: 2, options: ['Water', 'Salt', 'Sugar', 'Oxygen'], attachments: [] },
            { id: QUESTION_FR_ID, type: 'free_response', prompt: 'Explain photosynthesis in one sentence.', points: 3, hint: '', attachments: [] },
        ],
        teacherId: TEACHER_GRADE_ID,
        createdAt: new Date().toISOString(),
        updatedAt: new Date().toISOString(),
    });

    // Mirrors awSaveWork()'s own write in subjects.js — the answer key for
    // the one multiple_choice question (option index 0, "Water", is correct).
    await db.collection('work_answer_keys').doc(ASSIGNMENT_ASSESS_ID).set({
        assignmentId: ASSIGNMENT_ASSESS_ID,
        schoolId: SCHOOL_ID,
        keys: { [QUESTION_MC_ID]: 0 },
        createdAt: new Date().toISOString(),
    });

    // STUDENT_GRADE_1_ID has already submitted this assessment — answered
    // the MC question correctly (index 0) and the free_response question
    // with real text — with objectiveAutoGrade seeded directly in the exact
    // shape functions/index.js's autoGradeWorkSubmission() itself writes
    // (points/maxObjectivePoints/correctCount/totalObjective/perQuestion),
    // rather than relying on that Firestore trigger actually firing before
    // the test reads it back.
    const staleAssessSubs = await assessRef.collection('submissions').get();
    if (!staleAssessSubs.empty) {
        const batch = db.batch();
        staleAssessSubs.docs.forEach(d => batch.delete(d.ref));
        await batch.commit();
    }
    await assessRef.collection('submissions').doc(STUDENT_GRADE_1_ID).set({
        studentId: STUDENT_GRADE_1_ID,
        studentName: 'E2E Grade Student One',
        assignmentId: ASSIGNMENT_ASSESS_ID,
        assignmentTitle: ASSIGNMENT_ASSESS_TITLE,
        workType: 'Test',
        subjectId: SUBJECT_GRADE_ID,
        subjectName: SUBJECT_GRADE_NAME,
        classId: CLASS_GRADE_ID,
        className: CLASS_GRADE_NAME,
        status: 'submitted',
        responses: [
            { questionId: QUESTION_MC_ID, responseText: '0' },
            { questionId: QUESTION_FR_ID, responseText: 'Plants convert sunlight into chemical energy.' },
        ],
        objectiveAutoGrade: {
            points: 2,
            maxObjectivePoints: 2,
            correctCount: 1,
            totalObjective: 1,
            perQuestion: { [QUESTION_MC_ID]: true },
            gradedAt: new Date().toISOString(),
        },
        submittedAt: new Date().toISOString(),
        updatedAt: new Date().toISOString(),
    });

    // ── Phase 6 sandbox: pre-existing committed grades for the gradebook ──
    // Type 'Test' on both is deliberate — it's the ONLY grade type this
    // sandbox ever uses, so 6.7's "in-use categories can't be deleted" test
    // has exactly one protected category (Test) and every other DEFAULT_
    // GRADE_TYPES category (Quiz/Project/Assignment/Homework) stays free to
    // delete.
    await db.collection('students').doc(STUDENT_GRADE_1_ID)
        .collection('grades').doc(GRADEBOOK_EDIT_GRADE_ID).set({
            studentId: STUDENT_GRADE_1_ID,
            schoolId: SCHOOL_ID,
            teacherId: TEACHER_GRADE_ID,
            semesterId: SEMESTER_ID,
            className: CLASS_GRADE_NAME,
            subject: SUBJECT_GRADE_NAME,
            title: GRADEBOOK_EDIT_TITLE,
            type: 'Test',
            score: 15,
            max: 20,
            date: new Date().toISOString().split('T')[0],
            notes: '',
            historyLogs: [],
        });

    await db.collection('students').doc(STUDENT_GRADE_DELETE_ID)
        .collection('grades').doc(GRADEBOOK_DELETE_GRADE_ID).set({
            studentId: STUDENT_GRADE_DELETE_ID,
            schoolId: SCHOOL_ID,
            teacherId: TEACHER_GRADE_ID,
            semesterId: SEMESTER_ID,
            className: CLASS_GRADE_NAME,
            subject: SUBJECT_GRADE_NAME,
            title: 'E2E Gradebook Delete Target',
            type: 'Test',
            score: 10,
            max: 10,
            date: new Date().toISOString().split('T')[0],
            notes: '',
            historyLogs: [],
        });

    // ── Phase 7 (Attendance) sandbox: two real classes + roster ─────────
    await db.collection('schools').doc(SCHOOL_ID)
        .collection('classes').doc(CLASS_ATT_A_ID)
        .set({ name: CLASS_ATT_A_NAME, order: 4 });
    await db.collection('schools').doc(SCHOOL_ID)
        .collection('classes').doc(CLASS_ATT_B_ID)
        .set({ name: CLASS_ATT_B_NAME, order: 5 });

    await db.collection('teachers').doc(TEACHER_ATTENDANCE_ID).set(baseTeacher({
        pin: sha256Trim(TEACHER_ATTENDANCE_PIN),
        name: 'E2E Attendance Teacher',
        classes: [CLASS_ATT_A_NAME, CLASS_ATT_B_NAME], // ORDER MATTERS — 7.1 asserts Class A is picked by default (resolveClassNamesToIds() preserves this array's order)
        securityQuestionsSet: true,
        requiresPinReset: false,
        profileComplete: true,
    }));

    const attRoster = [
        { id: STUDENT_ATT_A1_ID, name: 'E2E Attendance Student A1', className: CLASS_ATT_A_NAME },
        { id: STUDENT_ATT_A2_ID, name: 'E2E Attendance Student A2', className: CLASS_ATT_A_NAME },
        { id: STUDENT_ATT_A3_ID, name: 'E2E Attendance Student A3', className: CLASS_ATT_A_NAME },
        { id: STUDENT_ATT_B1_ID, name: 'E2E Attendance Student B1', className: CLASS_ATT_B_NAME },
    ];
    for (const s of attRoster) {
        await db.collection('students').doc(s.id).set({
            currentSchoolId: SCHOOL_ID,
            teacherId: TEACHER_ATTENDANCE_ID,
            name: s.name,
            enrollmentStatus: 'Active',
            className: s.className,
        });
    }

    // Clear any attendance day-docs a previous run of this suite left behind
    // (fixed YYYY-MM-DD doc ids mean today's/yesterday's docs genuinely
    // persist across reseeds within the same day otherwise) — every 7.x test
    // needs to start from "this date has never been taken" for both classes.
    for (const classId of [CLASS_ATT_A_ID, CLASS_ATT_B_ID]) {
        const staleAtt = await db.collection('schools').doc(SCHOOL_ID)
            .collection('classes').doc(classId).collection('attendance').get();
        if (!staleAtt.empty) {
            const batch = db.batch();
            staleAtt.docs.forEach(d => batch.delete(d.ref));
            await batch.commit();
        }
    }

    // ── Phase 8 (Class Stream) sandbox: class + subject + 4 seeded posts ──
    await db.collection('schools').doc(SCHOOL_ID)
        .collection('classes').doc(CLASS_STREAM_ID)
        .set({ name: CLASS_STREAM_NAME, order: 6 });

    await db.collection('schools').doc(SCHOOL_ID)
        .collection('classes').doc(CLASS_STREAM_ID)
        .collection('subjects').doc(SUBJECT_STREAM_ID)
        .set({
            name: SUBJECT_STREAM_NAME,
            description: '',
            schoolId: SCHOOL_ID,
            classId: CLASS_STREAM_ID,
            archived: false,
            archivedAt: null,
            createdAt: new Date().toISOString(),
        });

    await db.collection('teachers').doc(TEACHER_STREAM_ID).set(baseTeacher({
        pin: sha256Trim(TEACHER_STREAM_PIN),
        name: 'E2E Stream Teacher',
        classes: [CLASS_STREAM_NAME],
        securityQuestionsSet: true,
        requiresPinReset: false,
        profileComplete: true,
    }));

    const streamPostsRef = db.collection('schools').doc(SCHOOL_ID)
        .collection('classes').doc(CLASS_STREAM_ID)
        .collection('subjects').doc(SUBJECT_STREAM_ID)
        .collection('posts');

    // Idempotent reseed — 8.1/8.3/8.4 all create/edit/delete additional posts
    // of their own through the real UI, so this subject's posts must start
    // from EXACTLY these 4 known fixtures every run, nothing left behind.
    const staleStreamPosts = await streamPostsRef.get();
    if (!staleStreamPosts.empty) {
        const batch = db.batch();
        staleStreamPosts.docs.forEach(d => batch.delete(d.ref));
        await batch.commit();
    }

    const streamNow = Date.now();
    const streamAuthor = { authorId: TEACHER_STREAM_ID, authorName: 'E2E Stream Teacher' };
    const streamBaseFields = {
        schoolId: SCHOOL_ID, classId: CLASS_STREAM_ID, className: CLASS_STREAM_NAME,
        subjectId: SUBJECT_STREAM_ID, subjectName: SUBJECT_STREAM_NAME,
        attachments: [],
        ...streamAuthor,
    };

    await streamPostsRef.doc(POST_PINNED_ID).set({
        ...streamBaseFields,
        type: 'announcement',
        title: POST_PINNED_TITLE,
        body: 'This is pinned and must sort above every unpinned post, even newer ones.',
        lessonDate: null, objectives: null,
        pinned: true,
        createdAt: new Date(streamNow - 3 * 3600 * 1000).toISOString(), // oldest of the 4 — pin alone keeps it first
        updatedAt: new Date(streamNow - 3 * 3600 * 1000).toISOString(),
    });
    await streamPostsRef.doc(POST_UNPINNED_MID_ID).set({
        ...streamBaseFields,
        type: 'announcement',
        title: POST_UNPINNED_MID_TITLE,
        body: 'Unpinned, middle timestamp.',
        lessonDate: null, objectives: null,
        pinned: false,
        createdAt: new Date(streamNow - 2 * 3600 * 1000).toISOString(),
        updatedAt: new Date(streamNow - 2 * 3600 * 1000).toISOString(),
    });
    await streamPostsRef.doc(POST_LESSON_PLAN_ID).set({
        ...streamBaseFields,
        type: 'lesson_plan',
        title: POST_LESSON_PLAN_TITLE,
        body: 'Lesson plan body — read-only from the Stream composer (no edit button).',
        lessonDate: new Date(streamNow).toISOString().split('T')[0],
        objectives: 'Understand pin priority vs. view filtering.',
        pinned: false, // createPost() always forces this false for lesson_plan
        createdAt: new Date(streamNow - 1.5 * 3600 * 1000).toISOString(),
        updatedAt: new Date(streamNow - 1.5 * 3600 * 1000).toISOString(),
    });
    await streamPostsRef.doc(POST_UNPINNED_NEW_ID).set({
        ...streamBaseFields,
        type: 'announcement',
        title: POST_UNPINNED_NEW_TITLE,
        body: 'Unpinned, newest timestamp — chronologically first, but must NOT out-rank the pinned post.',
        lessonDate: null, objectives: null,
        pinned: false,
        createdAt: new Date(streamNow - 1 * 3600 * 1000).toISOString(), // newest of the 4
        updatedAt: new Date(streamNow - 1 * 3600 * 1000).toISOString(),
    });

    // ── Phase 9 (Lesson Builder & Live Lessons) sandbox ──────────────────
    await db.collection('schools').doc(SCHOOL_ID)
        .collection('classes').doc(CLASS_LESSON_ID)
        .set({ name: CLASS_LESSON_NAME, order: 7 });

    await db.collection('schools').doc(SCHOOL_ID)
        .collection('classes').doc(CLASS_LESSON_ID)
        .collection('subjects').doc(SUBJECT_LESSON_ID)
        .set({
            name: SUBJECT_LESSON_NAME,
            description: '',
            schoolId: SCHOOL_ID,
            classId: CLASS_LESSON_ID,
            archived: false,
            archivedAt: null,
            createdAt: new Date().toISOString(),
        });

    await db.collection('teachers').doc(TEACHER_LESSON_ID).set(baseTeacher({
        pin: sha256Trim(TEACHER_LESSON_PIN),
        name: 'E2E Lesson Teacher',
        classes: [CLASS_LESSON_NAME],
        securityQuestionsSet: true,
        requiresPinReset: false,
        profileComplete: true,
    }));

    const lessonsRef = db.collection('schools').doc(SCHOOL_ID)
        .collection('classes').doc(CLASS_LESSON_ID)
        .collection('subjects').doc(SUBJECT_LESSON_ID)
        .collection('lessons');

    // Idempotent reseed — 9.1's "New Lesson" flow creates real lessons of its
    // own through the actual UI every run, so this subject's lesson list
    // (and the two fixtures below) must start from a known, empty-except-
    // fixtures state every time, exactly like Phase 8's own posts reseed.
    // Each lesson may also carry its own private/notes doc and a
    // live_sessions subtree — Firestore doesn't cascade-delete
    // subcollections, so both are cleared explicitly here (same reasoning
    // as lessons.js's own deleteLesson(), which does this one doc at a
    // time for exactly this reason).
    const staleLessons = await lessonsRef.get();
    if (!staleLessons.empty) {
        const batch = db.batch();
        for (const d of staleLessons.docs) {
            const privateSnap = await d.ref.collection('private').doc('notes').get();
            if (privateSnap.exists) batch.delete(privateSnap.ref);
            const sessionsSnap = await d.ref.collection('live_sessions').get();
            for (const s of sessionsSnap.docs) {
                const responsesSnap = await s.ref.collection('responses').get();
                responsesSnap.docs.forEach(r => batch.delete(r.ref));
                batch.delete(s.ref);
            }
            batch.delete(d.ref);
        }
        await batch.commit();
    }

    const lessonNow = new Date().toISOString();

    // 9.3 fixture: a 3-slide Slides-format DRAFT lesson dedicated to
    // reorder/delete testing — pre-seeded (rather than built slide-by-slide
    // through the Add Slide menu) so its drag-reorder and delete-down-to-
    // one assertions aren't entangled with the separate "does Add Slide
    // work" concern 9.1 already covers on its own.
    await lessonsRef.doc(LESSON_SLIDES_ID).set({
        title: 'E2E Slides Reorder Lesson',
        format: 'slides',
        status: 'draft',
        schoolId: SCHOOL_ID, classId: CLASS_LESSON_ID, className: CLASS_LESSON_NAME,
        subjectId: SUBJECT_LESSON_ID, subjectName: SUBJECT_LESSON_NAME,
        authorId: TEACHER_LESSON_ID, authorName: 'E2E Lesson Teacher',
        slides: [
            { id: SLIDE_REORDER_A_ID, type: 'title', heading: 'Slide A', subheading: '', objective: '' },
            { id: SLIDE_REORDER_B_ID, type: 'content', heading: 'Slide B', body: 'Body B', bullets: [] },
            { id: SLIDE_REORDER_C_ID, type: 'content', heading: 'Slide C', body: 'Body C', bullets: [] },
        ],
        createdAt: lessonNow, updatedAt: lessonNow, publishedAt: null,
    });

    // 9.14/9.17 fixture: an already-PUBLISHED Slides lesson whose second
    // block is an interactive_prompt — published so its lesson-list card
    // exposes the "Go Live" broadcast button (builder.js's renderLessonCard
    // only renders that button when status === 'published'), and carrying a
    // live-only interactive block so a live session immediately has
    // something for 9.17's Live Responses panel to react to.
    await lessonsRef.doc(LESSON_LIVE_ID).set({
        title: 'E2E Live Session Lesson',
        format: 'slides',
        status: 'published',
        schoolId: SCHOOL_ID, classId: CLASS_LESSON_ID, className: CLASS_LESSON_NAME,
        subjectId: SUBJECT_LESSON_ID, subjectName: SUBJECT_LESSON_NAME,
        authorId: TEACHER_LESSON_ID, authorName: 'E2E Lesson Teacher',
        slides: [
            { id: SLIDE_LIVE_TITLE_ID, type: 'title', heading: 'Welcome', subheading: 'E2E Live Session', objective: '' },
            { id: SLIDE_LIVE_PROMPT_ID, type: 'interactive_prompt', heading: 'Quick Check', promptText: 'What is your favorite element?', promptKind: 'short_answer', choices: [] },
        ],
        createdAt: lessonNow, updatedAt: lessonNow, publishedAt: lessonNow,
    });

    // ── Phase 10 (Exams: grading + live monitor) sandbox ─────────────────
    await db.collection('schools').doc(SCHOOL_ID)
        .collection('classes').doc(CLASS_EXAM_ID)
        .set({ name: CLASS_EXAM_NAME, order: 8 });

    await db.collection('schools').doc(SCHOOL_ID)
        .collection('classes').doc(CLASS_EXAM_ID)
        .collection('subjects').doc(SUBJECT_EXAM_ID)
        .set({
            name: SUBJECT_EXAM_NAME,
            description: '',
            schoolId: SCHOOL_ID,
            classId: CLASS_EXAM_ID,
            archived: false,
            archivedAt: null,
            createdAt: new Date().toISOString(),
        });

    await db.collection('teachers').doc(TEACHER_EXAM_ID).set(baseTeacher({
        pin: sha256Trim(TEACHER_EXAM_PIN),
        name: 'E2E Exam Teacher',
        classes: [CLASS_EXAM_NAME],
        securityQuestionsSet: true,
        requiresPinReset: false,
        profileComplete: true,
    }));

    await db.collection('schools').doc(SCHOOL_ID)
        .collection('classes').doc(CLASS_EXAM_ID)
        .collection('subjects').doc(SUBJECT_EXAM_ID)
        .collection('exams').doc(EXAM_ID)
        .set({
            title: 'E2E Grading Exam',
            isLive: true,
            timeLimitSeconds: 1800,
            questions: [
                { id: QUESTION_EXAM_MC_ID, type: 'multiple_choice', prompt: 'What is 2 + 2?', points: 5, options: ['3', '4', '5', '6'] },
                { id: QUESTION_EXAM_FR_ID, type: 'free_response', prompt: 'Explain photosynthesis in one sentence.', points: 10 },
            ],
        });

    // exam_answer_keys is `allow read, write: if false` for every client —
    // only the Admin SDK (this script) or autoGradeObjectiveAnswers ever
    // touches it. Not read by grade.js/live.js at all (this suite's own
    // fixtures hand-seed each submission's post-auto-grade shape directly,
    // bypassing that trigger — see the submission docs below), but kept
    // here so this exam's fixture is a complete, self-consistent record,
    // matching the convention already established by exam-tests/seed.js.
    await db.collection('exam_answer_keys').doc(EXAM_ID).set({
        answers: { [QUESTION_EXAM_MC_ID]: { correctValue: '4' } },
    });

    await db.collection('students').doc(STUDENT_EXAM_SUBMITTED_ID).set({
        pin: sha256Trim(STUDENT_EXAM_PIN),
        currentSchoolId: SCHOOL_ID,
        name: 'E2E Exam Student Submitted', firstName: 'E2E', lastName: 'ExamSubmitted',
        classId: CLASS_EXAM_ID, enrollmentStatus: 'Active', securityQuestionsSet: true,
    });
    await db.collection('students').doc(STUDENT_EXAM_INPROGRESS_ID).set({
        pin: sha256Trim(STUDENT_EXAM_PIN),
        currentSchoolId: SCHOOL_ID,
        name: 'E2E Exam Student In Progress', firstName: 'E2E', lastName: 'ExamInProgress',
        classId: CLASS_EXAM_ID, enrollmentStatus: 'Active', securityQuestionsSet: true,
    });

    // Idempotent reseed — clear any submission docs a previous run's
    // UI-driven grading (10.4) left behind, keyed by these two fixed
    // student/submission ids, same reasoning as exam-tests/seed.js's own
    // stale-submission clear.
    for (const sid of [STUDENT_EXAM_SUBMITTED_ID, STUDENT_EXAM_INPROGRESS_ID]) {
        const stale = await db.collection('students').doc(sid).collection('exam_submissions')
            .where('examId', '==', EXAM_ID).get();
        if (!stale.empty) {
            const staleBatch = db.batch();
            stale.docs.forEach(d => staleBatch.delete(d.ref));
            await staleBatch.commit();
        }
    }

    const examStartedAt = new Date(Date.now() - 10 * 60000).toISOString();
    const examDeadline = new Date(Date.now() + 20 * 60000).toISOString();

    // Already SUBMITTED, already auto-graded (q1's 5 points banked), q2
    // still awaiting manual grading — the exact steady-state grade.html's
    // roster/detail panel is built around. Shape matches functions/
    // index.js's startExamAttempt + autoGradeObjectiveAnswers output
    // exactly (read directly from that file, not guessed), even though
    // this fixture bypasses both by writing the post-auto-grade state
    // directly via the Admin SDK.
    await db.collection('students').doc(STUDENT_EXAM_SUBMITTED_ID)
        .collection('exam_submissions').doc(EXAM_SUBMISSION_SUBMITTED_ID)
        .set({
            examId: EXAM_ID, studentId: STUDENT_EXAM_SUBMITTED_ID, schoolId: SCHOOL_ID,
            classId: CLASS_EXAM_ID, subjectId: SUBJECT_EXAM_ID,
            isSchoolActive: true,
            status: 'submitted',
            startedAt: examStartedAt, serverDeadline: examDeadline,
            submittedAt: new Date().toISOString(), autoSubmitReason: null,
            answers: {
                [QUESTION_EXAM_MC_ID]: { value: '4' },
                [QUESTION_EXAM_FR_ID]: { value: 'Plants convert sunlight into chemical energy.' },
            },
            score: 5, gradedAt: null, gradedBy: null,
            pendingManualPoints: 10, pendingManualQuestionIds: [QUESTION_EXAM_FR_ID], manualGrades: {},
            proctoring: { tabFocusEvents: [], disconnectEvents: [] },
        });

    // Still IN_PROGRESS — must never appear in grade.html's roster at all
    // (10.2's terminal-status filter), and is the student whose live
    // presence 10.9/10.10 exercise, since "currently taking the exam" is
    // the realistic case a teacher actually watches on the live monitor.
    await db.collection('students').doc(STUDENT_EXAM_INPROGRESS_ID)
        .collection('exam_submissions').doc(EXAM_SUBMISSION_INPROGRESS_ID)
        .set({
            examId: EXAM_ID, studentId: STUDENT_EXAM_INPROGRESS_ID, schoolId: SCHOOL_ID,
            classId: CLASS_EXAM_ID, subjectId: SUBJECT_EXAM_ID,
            isSchoolActive: true,
            status: 'in_progress',
            startedAt: examStartedAt, serverDeadline: examDeadline,
            submittedAt: null, autoSubmitReason: null,
            answers: {}, score: null, gradedAt: null, gradedBy: null,
            proctoring: { tabFocusEvents: [], disconnectEvents: [] },
        });

    // RTDB presence — cleared to a known-empty state for this exam so
    // 10.9/10.10 start from "no signal yet" and can prove every chip update
    // they assert is really coming from the write the test itself makes
    // next, not stale data left behind by a previous run.
    await admin.database().ref(`examPresence/${EXAM_ID}`).remove();

    // ── PHASE 11: REPORTS SANDBOX ────────────────────────────────────────
    await db.collection('schools').doc(SCHOOL_ID)
        .collection('classes').doc(CLASS_REPORTS_ID)
        .set({ name: CLASS_REPORTS_NAME, order: 4 });

    // NO teaching_assignments doc for this teacher (deliberate — see the
    // constants-block comment above), and baseTeacher() sets no legacy
    // gradeTypes/customGradeTypes either, so getGradeTypes() always falls
    // back to DEFAULT_GRADE_TYPES for every report generated by this
    // fixture.
    await db.collection('teachers').doc(TEACHER_REPORTS_ID).set(baseTeacher({
        pin: sha256Trim(TEACHER_REPORTS_PIN),
        name: 'E2E Reports Teacher',
        classes: [CLASS_REPORTS_NAME],
        subjects: [{ name: SUBJECT_REPORTS_A_NAME }, { name: SUBJECT_REPORTS_B_NAME }],
        securityQuestionsSet: true,
        requiresPinReset: false,
        profileComplete: true,
    }));

    const reportsRoster = [
        { id: STUDENT_REPORTS_1_ID, name: 'E2E Reports Student One' },
        { id: STUDENT_REPORTS_2_ID, name: 'E2E Reports Student Two' },
        { id: STUDENT_REPORTS_EMPTY_ID, name: 'E2E Reports Student Empty' },
    ];
    for (const s of reportsRoster) {
        await db.collection('students').doc(s.id).set({
            currentSchoolId: SCHOOL_ID,
            teacherId: TEACHER_REPORTS_ID,
            name: s.name,
            enrollmentStatus: 'Active',
            className: CLASS_REPORTS_NAME,
        });
        // STUDENT_REPORTS_EMPTY_ID is left with zero grades on purpose (11.8).
        const staleReportsGrades = await db.collection('students').doc(s.id).collection('grades').get();
        if (!staleReportsGrades.empty) {
            const batch = db.batch();
            staleReportsGrades.docs.forEach(d => batch.delete(d.ref));
            await batch.commit();
        }
    }

    // Fixed-id ad-hoc grades via the same setAdHocGrade() helper every
    // other manual-grade fixture in this file uses (schoolId/historyLogs/
    // createdAt are set automatically by that helper) — idempotent .set(),
    // same reseed pattern as everywhere else.
    //
    //                         Semester 1 (SEMESTER_ID)              Semester 2 (SEMESTER_MIDTERM_ID)
    // Student One (Math avg 85, Eng avg 70 -> overall 78)           Math avg 85 -> overall 85
    // Student Two (Math avg 60, Eng avg 100 -> overall 80)          Math avg 75 -> overall 75
    await setAdHocGrade(STUDENT_REPORTS_1_ID, 'grd-rpt-s1-sem1-math-test', {
        teacherId: TEACHER_REPORTS_ID, semesterId: SEMESTER_ID, className: CLASS_REPORTS_NAME,
        subject: SUBJECT_REPORTS_A_NAME, type: 'Test', date: '2026-01-10',
        title: 'E2E Reports Math Test 1', score: 80, max: 100, notes: '',
    });
    await setAdHocGrade(STUDENT_REPORTS_1_ID, 'grd-rpt-s1-sem1-math-quiz', {
        teacherId: TEACHER_REPORTS_ID, semesterId: SEMESTER_ID, className: CLASS_REPORTS_NAME,
        subject: SUBJECT_REPORTS_A_NAME, type: 'Quiz', date: '2026-01-15',
        title: 'E2E Reports Math Quiz 1', score: 90, max: 100, notes: '',
    });
    await setAdHocGrade(STUDENT_REPORTS_1_ID, 'grd-rpt-s1-sem1-eng-test', {
        teacherId: TEACHER_REPORTS_ID, semesterId: SEMESTER_ID, className: CLASS_REPORTS_NAME,
        subject: SUBJECT_REPORTS_B_NAME, type: 'Test', date: '2026-01-12',
        title: 'E2E Reports English Test 1', score: 70, max: 100, notes: '',
    });
    await setAdHocGrade(STUDENT_REPORTS_2_ID, 'grd-rpt-s2-sem1-math-test', {
        teacherId: TEACHER_REPORTS_ID, semesterId: SEMESTER_ID, className: CLASS_REPORTS_NAME,
        subject: SUBJECT_REPORTS_A_NAME, type: 'Test', date: '2026-01-10',
        title: 'E2E Reports Math Test 1', score: 60, max: 100, notes: '',
    });
    await setAdHocGrade(STUDENT_REPORTS_2_ID, 'grd-rpt-s2-sem1-eng-quiz', {
        teacherId: TEACHER_REPORTS_ID, semesterId: SEMESTER_ID, className: CLASS_REPORTS_NAME,
        subject: SUBJECT_REPORTS_B_NAME, type: 'Quiz', date: '2026-01-15',
        title: 'E2E Reports English Quiz 1', score: 100, max: 100, notes: '',
    });
    await setAdHocGrade(STUDENT_REPORTS_1_ID, 'grd-rpt-s1-sem2-math-test', {
        teacherId: TEACHER_REPORTS_ID, semesterId: SEMESTER_MIDTERM_ID, className: CLASS_REPORTS_NAME,
        subject: SUBJECT_REPORTS_A_NAME, type: 'Test', date: '2026-03-10',
        title: 'E2E Reports Math Test 2', score: 85, max: 100, notes: '',
    });
    await setAdHocGrade(STUDENT_REPORTS_2_ID, 'grd-rpt-s2-sem2-math-test', {
        teacherId: TEACHER_REPORTS_ID, semesterId: SEMESTER_MIDTERM_ID, className: CLASS_REPORTS_NAME,
        subject: SUBJECT_REPORTS_A_NAME, type: 'Test', date: '2026-03-10',
        title: 'E2E Reports Math Test 2', score: 75, max: 100, notes: '',
    });

    // ── PHASE 12: MY EVALUATIONS SANDBOX ─────────────────────────────────
    // Evaluations accumulate via addDoc() in the real app, so clear this
    // teacher's subcollection first (same reasoning as the Phase 3/4
    // students-evaluations cleanup above) before writing this run's fixed
    // ids, then reseed both fixture teachers.
    await db.collection('teachers').doc(TEACHER_EVAL_ID).set(baseTeacher({
        pin: sha256Trim(TEACHER_EVAL_PIN),
        name: 'E2E Evaluations Teacher',
        securityQuestionsSet: true,
        requiresPinReset: false,
        profileComplete: true,
    }));
    await db.collection('teachers').doc(TEACHER_EVAL_EMPTY_ID).set(baseTeacher({
        pin: sha256Trim(TEACHER_EVAL_EMPTY_PIN),
        name: 'E2E Evaluations Empty Teacher',
        securityQuestionsSet: true,
        requiresPinReset: false,
        profileComplete: true,
    }));

    const staleEvalDocs = await db.collection('teachers').doc(TEACHER_EVAL_ID).collection('evaluations').get();
    if (!staleEvalDocs.empty) {
        const batch = db.batch();
        staleEvalDocs.docs.forEach(d => batch.delete(d.ref));
        await batch.commit();
    }
    const staleEmptyEvalDocs = await db.collection('teachers').doc(TEACHER_EVAL_EMPTY_ID).collection('evaluations').get();
    if (!staleEmptyEvalDocs.empty) {
        const batch = db.batch();
        staleEmptyEvalDocs.docs.forEach(d => batch.delete(d.ref));
        await batch.commit();
    }

    // Most recent (sorts first -> drives the "Latest Action" KPI). Full
    // category set, current school, Commendation.
    await db.collection('teachers').doc(TEACHER_EVAL_ID)
        .collection('evaluations').doc(EVAL_RECENT_ID)
        .set({
            overallRating: 4.5,
            classroomManagement: 5, curriculumDelivery: 4, studentEngagement: 5, professionalConduct: null,
            recommendedAction: 'Commendation',
            schoolId: SCHOOL_ID, semesterId: SEMESTER_ID,
            date: '2026-06-01',
            strengths: 'Excellent rapport with students and strong command of the room.',
            areasForImprovement: null,
            additionalNotes: 'Keep up the great work this term.',
            evaluatorName: 'Principal Rivera',
        });

    // Middle (different semester, one category missing, Professional
    // Development recommendation).
    await db.collection('teachers').doc(TEACHER_EVAL_ID)
        .collection('evaluations').doc(EVAL_MID_ID)
        .set({
            overallRating: 3.5,
            classroomManagement: 3, curriculumDelivery: null, studentEngagement: 4, professionalConduct: null,
            recommendedAction: 'Professional Development',
            schoolId: SCHOOL_ID, semesterId: SEMESTER_MIDTERM_ID,
            date: '2026-02-01',
            strengths: 'Good energy with students.',
            areasForImprovement: 'Consider more structured lesson pacing.',
            additionalNotes: null,
            evaluatorName: 'Vice Principal Chen',
        });

    // Oldest, a DIFFERENT (previous) school, no category scores at all, no
    // semesterId (so it only ever shows up under "All Periods") — the
    // negative case for 12.2's category-bar conditional display test
    // (professionalConduct is null on every doc above too, so it must
    // never render a bar of its own) and the second distinct schoolId for
    // 12.1's "Schools Evaluated At" count.
    await db.collection('teachers').doc(TEACHER_EVAL_ID)
        .collection('evaluations').doc(EVAL_OLD_ID)
        .set({
            overallRating: 2.0,
            classroomManagement: null, curriculumDelivery: null, studentEngagement: null, professionalConduct: null,
            recommendedAction: 'None',
            schoolId: EVAL_PREV_SCHOOL_ID, semesterId: null,
            date: '2025-09-01',
            strengths: null,
            areasForImprovement: null,
            additionalNotes: null,
            evaluatorName: 'Former Principal Diaz',
        });

    // ── PHASE 13: ARCHIVES SANDBOX ────────────────────────────────────────
    await db.collection('schools').doc(SCHOOL_ID)
        .collection('classes').doc(CLASS_ARCHIVES_ID)
        .set({ name: CLASS_ARCHIVES_NAME, order: 5 });

    await db.collection('teachers').doc(TEACHER_ARCHIVES_ID).set(baseTeacher({
        pin: sha256Trim(TEACHER_ARCHIVES_PIN),
        name: 'E2E Archives Teacher',
        classes: [CLASS_ARCHIVES_NAME],
        securityQuestionsSet: true,
        requiresPinReset: false,
        profileComplete: true,
    }));

    // New-model per-class subjects (same shape as Phase 4's SUBJECT_ID) —
    // two archived (restore + delete targets) and one active negative control.
    const archivesSubjects = [
        { id: SUBJECT_ARCHIVES_RESTORE_ID, name: SUBJECT_ARCHIVES_RESTORE_NAME, archived: true, archivedAt: '2026-01-05T00:00:00.000Z' },
        { id: SUBJECT_ARCHIVES_DELETE_ID, name: SUBJECT_ARCHIVES_DELETE_NAME, archived: true, archivedAt: '2026-01-06T00:00:00.000Z' },
        { id: SUBJECT_ARCHIVES_ACTIVE_ID, name: SUBJECT_ARCHIVES_ACTIVE_NAME, archived: false, archivedAt: null },
    ];
    for (const sub of archivesSubjects) {
        await db.collection('schools').doc(SCHOOL_ID)
            .collection('classes').doc(CLASS_ARCHIVES_ID)
            .collection('subjects').doc(sub.id)
            .set({
                name: sub.name,
                description: '',
                schoolId: SCHOOL_ID,
                classId: CLASS_ARCHIVES_ID,
                archived: sub.archived,
                archivedAt: sub.archivedAt,
                createdAt: new Date().toISOString(),
            });
    }

    // One assignment under the delete-target subject, so 13.7 can prove
    // permanentDeleteSubject()'s cascade-delete of the assignments
    // subcollection actually ran (Firestore never does this on its own).
    await db.collection('schools').doc(SCHOOL_ID)
        .collection('classes').doc(CLASS_ARCHIVES_ID)
        .collection('subjects').doc(SUBJECT_ARCHIVES_DELETE_ID)
        .collection('assignments').doc(ASSIGNMENT_ARCHIVES_DELETE_ID)
        .set({
            id: ASSIGNMENT_ARCHIVES_DELETE_ID,
            title: 'E2E Archives Delete-Cascade Assignment',
            type: 'Test',
            maxScore: 100,
            date: null,
            instructions: '', description: '',
            locked: false, lockedAt: null, completed: false,
            attachments: [], category: 'standard', questions: [],
            teacherId: TEACHER_ARCHIVES_ID,
            createdAt: new Date().toISOString(),
            updatedAt: new Date().toISOString(),
        });

    // Archived-student roster — deliberately mixed ownership (see the
    // constants-block comment above for why): the orphan and other-teacher
    // students prove archives.js's `teacherId === session.teacherId ||
    // !teacherId` filter actually discriminates, not just "shows everything
    // archived at this school".
    const archivesStudents = [
        { id: STUDENT_ARCHIVES_RESTORE_ID, name: 'E2E Archives Restore Target', teacherId: TEACHER_ARCHIVES_ID, status: 'Archived', archivedAt: '2026-01-05', archiveReason: 'Transferred to another school' },
        { id: STUDENT_ARCHIVES_DELETE_ID, name: 'E2E Archives Delete Target', teacherId: TEACHER_ARCHIVES_ID, status: 'Archived', archivedAt: '2026-01-06', archiveReason: 'Graduated' },
        { id: STUDENT_ARCHIVES_SEARCH_A_ID, name: 'E2E Archives Zephyr Ostrowski', teacherId: TEACHER_ARCHIVES_ID, status: 'Archived', archivedAt: '2026-01-04', archiveReason: '' },
        { id: STUDENT_ARCHIVES_SEARCH_B_ID, name: 'E2E Archives Quincy Delgado', teacherId: TEACHER_ARCHIVES_ID, status: 'Archived', archivedAt: '2026-01-03', archiveReason: '' },
        { id: STUDENT_ARCHIVES_ORPHAN_ID, name: 'E2E Archives Orphan Student', teacherId: '', status: 'Archived', archivedAt: '2026-01-02', archiveReason: '' },
        { id: STUDENT_ARCHIVES_ACTIVE_ID, name: 'E2E Archives Active Control', teacherId: TEACHER_ARCHIVES_ID, status: 'Active', archivedAt: null, archiveReason: '' },
        { id: STUDENT_ARCHIVES_OTHERTEACHER_ID, name: 'E2E Archives OtherTeacher Control', teacherId: TEACHER_ID, status: 'Archived', archivedAt: '2026-01-01', archiveReason: '' },
    ];
    for (const s of archivesStudents) {
        const doc = {
            currentSchoolId: SCHOOL_ID,
            teacherId: s.teacherId,
            name: s.name,
            enrollmentStatus: s.status,
            className: CLASS_ARCHIVES_NAME,
        };
        if (s.status !== 'Active') doc.archivedAt = s.archivedAt;
        if (s.archiveReason) doc.archiveReason = s.archiveReason;
        await db.collection('students').doc(s.id).set(doc);

        const staleArchiveGrades = await db.collection('students').doc(s.id).collection('grades').get();
        if (!staleArchiveGrades.empty) {
            const batch = db.batch();
            staleArchiveGrades.docs.forEach(d => batch.delete(d.ref));
            await batch.commit();
        }
    }
    // One grade doc on the delete-target student, to prove
    // permanentDeleteStudent()'s cascade-delete of the grades subcollection.
    await db.collection('students').doc(STUDENT_ARCHIVES_DELETE_ID)
        .collection('grades').doc('grd-e2e-archives-delete-1')
        .set({
            studentId: STUDENT_ARCHIVES_DELETE_ID, schoolId: SCHOOL_ID, teacherId: TEACHER_ARCHIVES_ID,
            semesterId: SEMESTER_ID, className: CLASS_ARCHIVES_NAME,
            subject: SUBJECT_ARCHIVES_RESTORE_NAME, type: 'Test', date: '2025-12-01',
            title: 'E2E Archives Pre-Archive Grade', score: 75, max: 100, notes: '',
            historyLogs: [], createdAt: new Date().toISOString(),
        });

    // ── PHASE 14: DEACTIVATED ACCOUNT SANDBOX ─────────────────────────────
    // Starts NOT archived — the spec's own test flips `archived: true` via
    // the Admin SDK mid-session, the same real trigger auth.js's teacher
    // archive watcher (requireAuth()) reacts to on every teacher page.
    await db.collection('teachers').doc(TEACHER_DEACT_ID).set(baseTeacher({
        pin: sha256Trim(TEACHER_DEACT_PIN),
        name: 'E2E Deactivated Teacher',
        email: 'e2e.deact.teacher@example.com',
        phone: '501-555-0114',
        teacherLicenseNumber: 'BZ-TCH-99914',
        licenseType: 'Trained Teacher',
        employmentType: 'Full-Time',
        highestEducationLevel: "Bachelor's Degree",
        archived: false,
        securityQuestionsSet: true,
        requiresPinReset: false,
        profileComplete: true,
        teachingHistory: [
            {
                schoolId: 'E2E Prior School Alpha',
                semesterName: 'Fall 2024',
                classes: ['Grade 5A'],
                studentCount: 22,
                snapshotDate: '2024-12-01T00:00:00.000Z',
                subjectAverages: { Math: 82, Science: 77 },
            },
            // Deliberately missing semesterName/classes/studentCount/
            // snapshotDate/subjectAverages — exercises the `subjects[]`
            // pill fallback and confirms those optional bullet lines are
            // just omitted, not rendered as "undefined".
            { schoolId: 'E2E Prior School Beta', subjects: ['English', 'History'] },
        ],
    }));
    const staleDeactEvals = await db.collection('teachers').doc(TEACHER_DEACT_ID).collection('evaluations').get();
    if (!staleDeactEvals.empty) {
        const batch = db.batch();
        staleDeactEvals.docs.forEach(d => batch.delete(d.ref));
        await batch.commit();
    }
    await db.collection('teachers').doc(TEACHER_DEACT_ID)
        .collection('evaluations').doc('eval-e2e-deact-1')
        .set({
            overallRating: 4, recommendedAction: 'Commendation',
            date: '2026-05-01', evaluatorName: 'Principal X',
            schoolId: 'E2E Prior School Alpha',
            strengths: 'Great lesson planning.', areasForImprovement: null,
            comments: 'Keep it up.', type: 'end_of_year',
        });
    await db.collection('teachers').doc(TEACHER_DEACT_ID)
        .collection('evaluations').doc('eval-e2e-deact-2')
        .set({
            overallRating: 3, recommendedAction: 'None',
            date: '2026-01-01', evaluatorName: 'Principal Y',
            schoolId: 'E2E Prior School Beta',
            strengths: null, areasForImprovement: 'Needs more parent communication.',
            comments: null, type: 'academic',
        });

    // Already archived at seed time, with nothing on record — 14.3's empty state.
    await db.collection('teachers').doc(TEACHER_DEACT_EMPTY_ID).set(baseTeacher({
        pin: sha256Trim(TEACHER_DEACT_EMPTY_PIN),
        name: 'E2E Deactivated Empty Teacher',
        archived: true,
        securityQuestionsSet: true,
        requiresPinReset: false,
        profileComplete: true,
    }));
    const staleDeactEmptyEvals = await db.collection('teachers').doc(TEACHER_DEACT_EMPTY_ID).collection('evaluations').get();
    if (!staleDeactEmptyEvals.empty) {
        const batch = db.batch();
        staleDeactEmptyEvals.docs.forEach(d => batch.delete(d.ref));
        await batch.commit();
    }

    // ── PHASE 15: SETTINGS SANDBOX ────────────────────────────────────────
    // requiresPinReset:false guarantees this teacher logs in straight to
    // home.html (same routing rule Phase 1 established), regardless of
    // securityQuestionsSet — deliberately false here so 15.4 exercises a
    // real "Not Set" -> "Set" transition. No teacherLicenseNumber/
    // licenseType/highestEducationLevel/employmentType/address.city — an
    // intentionally incomplete profile for 15.3's initial state.
    await db.collection('teachers').doc(TEACHER_SETTINGS_ID).set(baseTeacher({
        pin: sha256Trim(TEACHER_SETTINGS_PIN),
        name: 'E2E Settings Teacher',
        email: TEACHER_SETTINGS_EMAIL,
        phone: '501-555-0115',
        securityQuestionsSet: false,
        requiresPinReset: false,
        profileComplete: true,
    }));

    // Registered to a DIFFERENT (fictional) teacher — the 15.2 collision target.
    await db.collection('registered_emails').doc(TEACHER_SETTINGS_TAKEN_EMAIL).set({
        email: TEACHER_SETTINGS_TAKEN_EMAIL,
        name: 'E2E Some Other Teacher',
        role: 'teacher',
        referenceId: 'T26-SOMEOTHER',
        createdAt: new Date().toISOString(),
    });
    // Clear out any registration this teacher's OWN email, or the
    // successful-change target email, may have picked up from a previous
    // run's assertions, so every fresh seed starts from the same known state.
    await db.collection('registered_emails').doc(TEACHER_SETTINGS_EMAIL).delete();
    await db.collection('registered_emails').doc(TEACHER_SETTINGS_NEW_EMAIL).delete();

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
    console.log(`  Grade Entry/Gradebook teacher: ${TEACHER_GRADE_ID} / PIN ${TEACHER_GRADE_PIN} (class: ${CLASS_GRADE_NAME}, subject: ${SUBJECT_GRADE_NAME})`);
    console.log(`  Grade Entry roster (all ungraded): ${STUDENT_GRADE_1_ID}, ${STUDENT_GRADE_2_ID}, ${STUDENT_GRADE_3_ID}; disposable: ${STUDENT_GRADE_DELETE_ID}`);
    console.log(`  Standard assignment: ${ASSIGNMENT_STANDARD_TITLE} (max ${20})`);
    console.log(`  Assessment assignment: ${ASSIGNMENT_ASSESS_TITLE} (1 MC + 1 free-response; ${STUDENT_GRADE_1_ID} has a submitted, auto-graded submission)`);
    console.log(`  Gradebook fixtures: ${GRADEBOOK_EDIT_GRADE_ID} (edit target, 15/20) on ${STUDENT_GRADE_1_ID}; ${GRADEBOOK_DELETE_GRADE_ID} (delete target, 10/10) on ${STUDENT_GRADE_DELETE_ID}`);
    console.log(`  Attendance teacher: ${TEACHER_ATTENDANCE_ID} / PIN ${TEACHER_ATTENDANCE_PIN} (classes: ${CLASS_ATT_A_NAME} [${STUDENT_ATT_A1_ID}, ${STUDENT_ATT_A2_ID}, ${STUDENT_ATT_A3_ID}], ${CLASS_ATT_B_NAME} [${STUDENT_ATT_B1_ID}])`);
    console.log(`  Stream teacher: ${TEACHER_STREAM_ID} / PIN ${TEACHER_STREAM_PIN} (subject: ${SUBJECT_STREAM_NAME})`);
    console.log(`  Stream posts (newest first, ignoring pin): ${POST_UNPINNED_NEW_ID}, ${POST_LESSON_PLAN_ID} (lesson_plan), ${POST_UNPINNED_MID_ID}; pinned (sorts first in Stream view): ${POST_PINNED_ID}`);
    console.log(`  Lesson teacher: ${TEACHER_LESSON_ID} / PIN ${TEACHER_LESSON_PIN} (subject: ${SUBJECT_LESSON_NAME})`);
    console.log(`  Lesson fixtures: ${LESSON_SLIDES_ID} (3-slide draft, reorder/delete target), ${LESSON_LIVE_ID} (published, title + interactive_prompt "${SLIDE_LIVE_PROMPT_ID}")`);
    console.log(`  Exam teacher: ${TEACHER_EXAM_ID} / PIN ${TEACHER_EXAM_PIN} (subject: ${SUBJECT_EXAM_NAME})`);
    console.log(`  Exam: ${EXAM_ID} — q-mc-1 multiple_choice (auto-graded, excluded from grading UI), q-fr-1 free_response (10 pt max, manually graded)`);
    console.log(`  Exam submissions: ${STUDENT_EXAM_SUBMITTED_ID} (submitted, q-fr-1 pending), ${STUDENT_EXAM_INPROGRESS_ID} (in_progress, hidden from grading roster); RTDB presence cleared`);
    console.log(`  Reports teacher: ${TEACHER_REPORTS_ID} / PIN ${TEACHER_REPORTS_PIN} (subjects: ${SUBJECT_REPORTS_A_NAME}, ${SUBJECT_REPORTS_B_NAME}; no teaching_assignments/legacy weighting -> flat averaging)`);
    console.log(`  Reports roster: ${STUDENT_REPORTS_1_ID} (sem1 overall 78, sem2 overall 85), ${STUDENT_REPORTS_2_ID} (sem1 overall 80, sem2 overall 75), ${STUDENT_REPORTS_EMPTY_ID} (zero grades)`);
    console.log(`  Evaluations teacher: ${TEACHER_EVAL_ID} / PIN ${TEACHER_EVAL_PIN} (${EVAL_RECENT_ID} Commendation, ${EVAL_MID_ID} Professional Development, ${EVAL_OLD_ID} None/${EVAL_PREV_SCHOOL_ID})`);
    console.log(`  Evaluations empty teacher: ${TEACHER_EVAL_EMPTY_ID} / PIN ${TEACHER_EVAL_EMPTY_PIN} (zero evaluations)`);
    console.log(`  Archives teacher: ${TEACHER_ARCHIVES_ID} / PIN ${TEACHER_ARCHIVES_PIN} (class: ${CLASS_ARCHIVES_NAME})`);
    console.log(`  Archived subjects: ${SUBJECT_ARCHIVES_RESTORE_ID} (restore target), ${SUBJECT_ARCHIVES_DELETE_ID} (delete target, has 1 assignment), ${SUBJECT_ARCHIVES_ACTIVE_ID} (active control)`);
    console.log(`  Archived students: ${STUDENT_ARCHIVES_RESTORE_ID} (restore), ${STUDENT_ARCHIVES_DELETE_ID} (delete, has 1 grade), ${STUDENT_ARCHIVES_SEARCH_A_ID}/${STUDENT_ARCHIVES_SEARCH_B_ID} (search), ${STUDENT_ARCHIVES_ORPHAN_ID} (orphan, must show), ${STUDENT_ARCHIVES_ACTIVE_ID}/${STUDENT_ARCHIVES_OTHERTEACHER_ID} (must NOT show)`);
    console.log(`  Deactivated teacher: ${TEACHER_DEACT_ID} / PIN ${TEACHER_DEACT_PIN} (starts non-archived; test flips archived:true mid-session), ${TEACHER_DEACT_EMPTY_ID} / PIN ${TEACHER_DEACT_EMPTY_PIN} (already archived, empty history/evals)`);
    console.log(`  Settings teacher: ${TEACHER_SETTINGS_ID} / PIN ${TEACHER_SETTINGS_PIN} (email ${TEACHER_SETTINGS_EMAIL}, securityQuestionsSet:false, incomplete profile); collision email ${TEACHER_SETTINGS_TAKEN_EMAIL} pre-registered`);
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

/**
 * Reads back a real assignment's live submission doc by its known
 * classId/subjectId/assignmentId/studentId path — the exact path
 * submissions.js writes to and grade_form.js's own loadSubmission() reads
 * from (via resolvePostContext()). Used by the 5.5 (Request Revision) test
 * to confirm commitGrade() actually flipped the submission's `status`
 * field (rather than just trusting the in-page banner).
 */
async function getSubmissionDoc(classId, subjectId, assignmentId, studentId) {
    ensureApp();
    const db = admin.firestore();
    const snap = await db.collection('schools').doc(SCHOOL_ID)
        .collection('classes').doc(classId)
        .collection('subjects').doc(subjectId)
        .collection('assignments').doc(assignmentId)
        .collection('submissions').doc(studentId)
        .get();
    return snap.exists ? snap.data() : null;
}

/**
 * Finds a student's grade doc by its assignmentId field rather than its
 * Firestore doc id — saveGrade() in utils.js always addDoc()s a fresh
 * random id the first time it grades a given student+assignment pair (see
 * that file's own comment), so a test driving the real Commit & Next UI has
 * no way to know that id ahead of time. Used by the 5.5 (Request Revision)
 * test to read back the perQuestion/revision payload commitGrade() wrote.
 */
async function findGradeByAssignment(studentId, assignmentId) {
    ensureApp();
    const db = admin.firestore();
    const snap = await db.collection('students').doc(studentId)
        .collection('grades')
        .where('assignmentId', '==', assignmentId)
        .limit(1)
        .get();
    return snap.empty ? null : { id: snap.docs[0].id, ...snap.docs[0].data() };
}

/**
 * Finds a real per-class assignment doc by its (unique, teacher-chosen)
 * title rather than its Firestore id — grade_form.js's ensureAssignmentDoc()
 * generates the id client-side via genId() when converting a manual entry
 * into a real assignment template, so a test that drove that conversion
 * through the real "Post to Class" UI has no way to know that id ahead of
 * time. Used by the 5.2 (manual entry → real assignment template) test.
 */
async function findAssignmentDoc(classId, subjectId, title) {
    ensureApp();
    const db = admin.firestore();
    const snap = await db.collection('schools').doc(SCHOOL_ID)
        .collection('classes').doc(classId)
        .collection('subjects').doc(subjectId)
        .collection('assignments')
        .where('title', '==', title)
        .limit(1)
        .get();
    return snap.empty ? null : { id: snap.docs[0].id, ...snap.docs[0].data() };
}

/**
 * Locks or unlocks the ACTIVE semester (SEMESTER_ID) via a plain .update()
 * (not .set(), which would wipe the doc's other fields) — used only by the
 * 7.7 test to prove attendance.js's own save flow never once reads
 * activeSem.isLocked (unlike grade_form.js/gradebook.js/roster.js/
 * subjects.js, which all gate on it — see the comment on this constant's
 * declaration). seed()'s own semester write is a full .set() with no
 * isLocked field, so this always resets back to unlocked on the very next
 * reseed — no explicit unlock-afterward cleanup needed in the test itself.
 */
async function setSemesterLocked(semesterId, locked) {
    ensureApp();
    const db = admin.firestore();
    await db.collection('schools').doc(SCHOOL_ID)
        .collection('semesters').doc(semesterId)
        .update({ isLocked: !!locked });
}

/**
 * Reads back one class's attendance-for-one-day doc directly — the exact
 * schools/{schoolId}/classes/{classId}/attendance/{date} path
 * assets/js/attendance.js's saveAttendanceForDate()/loadAttendanceForDate()
 * both use. Returns null when that date has never been taken (no
 * setDoc has ever run for it), same as a raw Firestore read would.
 */
async function getAttendanceDoc(classId, date) {
    ensureApp();
    const db = admin.firestore();
    const snap = await db.collection('schools').doc(SCHOOL_ID)
        .collection('classes').doc(classId)
        .collection('attendance').doc(date)
        .get();
    return snap.exists ? snap.data() : null;
}

/**
 * Reads back one Class Stream post by its known doc id — the exact
 * schools/{schoolId}/classes/{classId}/subjects/{subjectId}/posts/{postId}
 * path posts.js's createPost()/updatePost()/deletePost() all use. Used to
 * verify a save/edit actually persisted (8.1/8.3) or that a delete actually
 * removed the document server-side (8.4), not just from the in-page cache.
 */
async function getPostDoc(classId, subjectId, postId) {
    ensureApp();
    const db = admin.firestore();
    const snap = await db.collection('schools').doc(SCHOOL_ID)
        .collection('classes').doc(classId)
        .collection('subjects').doc(subjectId)
        .collection('posts').doc(postId)
        .get();
    return snap.exists ? snap.data() : null;
}

/**
 * Finds a post by its (unique, teacher-chosen) title rather than its
 * Firestore id — posts.js's createPost() generates the id client-side via
 * genPostId(), so a test that created a post through the real Composer UI
 * (8.1's valid-submission case, 8.3/8.4's disposable posts) has no way to
 * know that id ahead of time.
 */
async function findPostByTitle(classId, subjectId, title) {
    ensureApp();
    const db = admin.firestore();
    const snap = await db.collection('schools').doc(SCHOOL_ID)
        .collection('classes').doc(classId)
        .collection('subjects').doc(subjectId)
        .collection('posts')
        .where('title', '==', title)
        .limit(1)
        .get();
    return snap.empty ? null : { id: snap.docs[0].id, ...snap.docs[0].data() };
}

/**
 * Returns a lesson's full main document (title/status/format/slides), or
 * null. Used to confirm Save Draft / Publish / slide-reorder actually
 * persisted to Firestore, not just to the in-memory lessonDraft the builder
 * keeps client-side — the same "reload and re-verify" discipline this
 * suite's other getXDoc() helpers already follow.
 */
async function getLessonDoc(classId, subjectId, lessonId) {
    ensureApp();
    const db = admin.firestore();
    const snap = await db.collection('schools').doc(SCHOOL_ID)
        .collection('classes').doc(classId)
        .collection('subjects').doc(subjectId)
        .collection('lessons').doc(lessonId)
        .get();
    return snap.exists ? snap.data() : null;
}

/**
 * The live_sessions/current doc for one lesson — 'current' is the ONLY
 * session id lessons.js's startLiveSession()/endLiveSession() ever use (a
 * fixed id, not a random one — see that function's own race-guard comment
 * on why), so no lookup is needed to find "the" session.
 */
async function getLiveSessionDoc(classId, subjectId, lessonId) {
    ensureApp();
    const db = admin.firestore();
    const snap = await db.collection('schools').doc(SCHOOL_ID)
        .collection('classes').doc(classId)
        .collection('subjects').doc(subjectId)
        .collection('lessons').doc(lessonId)
        .collection('live_sessions').doc('current')
        .get();
    return snap.exists ? snap.data() : null;
}

/**
 * Writes one student's live-session response directly via the Admin SDK,
 * mirroring lessons.js's saveLiveResponse() exactly (same "{studentId}_
 * {blockId}" doc id, same field shape). This is 9.17's stand-in for a real
 * connected student's browser submitting an interactive_prompt answer —
 * it exercises the teacher dashboard's live.js onSnapshot push the same way
 * a genuine student write would, without needing a second real browser
 * context in this suite.
 */
async function writeLiveResponse(classId, subjectId, lessonId, studentId, studentName, blockId, blockType, answerText) {
    ensureApp();
    const db = admin.firestore();
    const record = {
        schoolId: SCHOOL_ID,
        studentId,
        studentName: studentName || '',
        blockId,
        blockType,
        answerText: (answerText || '').trim(),
        submittedAt: new Date().toISOString(),
    };
    await db.collection('schools').doc(SCHOOL_ID)
        .collection('classes').doc(classId)
        .collection('subjects').doc(subjectId)
        .collection('lessons').doc(lessonId)
        .collection('live_sessions').doc('current')
        .collection('responses').doc(`${studentId}_${blockId}`)
        .set(record);
    return record;
}

/**
 * Finds one student's exam_submissions doc for a given exam. Submissions
 * live at students/{studentId}/exam_submissions/{id} — NOT nested under the
 * exam's own class/subject/exam tree — confirmed against this repo's own
 * exam-tests/seed.js and functions/index.js's startExamAttempt, which both
 * write to exactly this path. grade.js/live.js's own
 * collectionGroup('exam_submissions') queries match at any nesting depth,
 * so this is purely a lookup convenience for the tests, not a claim about
 * how firestore.rules scopes the path.
 */
async function findExamSubmission(studentId, examId) {
    ensureApp();
    const db = admin.firestore();
    const snap = await db.collection('students').doc(studentId)
        .collection('exam_submissions')
        .where('examId', '==', examId)
        .limit(1)
        .get();
    return snap.empty ? null : { id: snap.docs[0].id, ...snap.docs[0].data() };
}

/**
 * Overwrites one student's Realtime Database presence node for one exam —
 * examPresence/{examId}/{studentId}, exactly the path/shape teacher/exams/
 * live.js's registerRTDBListener() reads (see that file's own state-shape
 * comment: connectionState, tabFocused, clientReportedProgress.
 * questionsAnswered). student/exams/take.js — the real writer of this data
 * — was not available to cross-reference in this environment, so this
 * shape is taken directly from live.js's OWN read/render logic
 * (buildRowModel/renderRow), the consumer this suite is actually testing,
 * rather than guessed.
 */
async function setExamPresence(examId, studentId, { connectionState, tabFocused, questionsAnswered }) {
    ensureApp();
    const now = new Date().toISOString();
    const record = {
        connectionState,
        tabFocused,
        lastSeenAt: now,
        lastFocusChangeAt: now,
        clientReportedProgress: { questionsAnswered: questionsAnswered ?? 0 },
    };
    await admin.database().ref(`examPresence/${examId}/${studentId}`).set(record);
    return record;
}

/**
 * Reads back a teacher document's raw fields via the Admin SDK — used by
 * the Phase 14 (Deactivated) archive-watcher test and the Phase 15
 * (Settings) tests to confirm PIN hashes, security question answers, and
 * profile field writes actually land in Firestore exactly as settings.js's
 * own save handlers write them, not just what the UI shows. Returns null
 * if the teacher doesn't exist.
 */
async function getTeacherDoc(teacherId) {
    ensureApp();
    const db = admin.firestore();
    const snap = await db.collection('teachers').doc(teacherId).get();
    return snap.exists ? snap.data() : null;
}

/**
 * Flips a teacher's `archived` flag via the Admin SDK — used by the Phase
 * 14 (Deactivated) test to trigger auth.js's requireAuth() "TEACHER ARCHIVE
 * WATCHER" (an onSnapshot on this exact doc, live on every teacher page)
 * for real, the same way an admin archiving a currently-logged-in teacher
 * would in production — rather than only asserting against a directly
 * mocked session.
 */
async function setTeacherArchived(teacherId, archived) {
    ensureApp();
    const db = admin.firestore();
    await db.collection('teachers').doc(teacherId).update({ archived });
}

/**
 * Returns the ids of every assignment doc under one per-class subject's
 * assignments subcollection — used by the 13.7 (Permanent Delete Subject)
 * test to confirm permanentDeleteSubject()'s cascade-delete of that
 * subcollection actually ran (Firestore never cascade-deletes a
 * subcollection on its own just because its parent doc was deleted).
 */
async function getSubjectAssignmentIds(classId, subjectId) {
    ensureApp();
    const db = admin.firestore();
    const snap = await db.collection('schools').doc(SCHOOL_ID)
        .collection('classes').doc(classId)
        .collection('subjects').doc(subjectId)
        .collection('assignments').get();
    return snap.docs.map(d => d.id);
}

/**
 * Reads back a registered_emails/{email} doc — used by the 15.2 (Email
 * Collision) test to confirm a successful email change swaps the
 * registration (old email's doc removed, new email's doc created) exactly
 * as settings.js's save handler's batch does. Returns null if no such
 * registration exists.
 */
async function getRegisteredEmailDoc(email) {
    ensureApp();
    const db = admin.firestore();
    const snap = await db.collection('registered_emails').doc(email).get();
    return snap.exists ? snap.data() : null;
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
    // Phase 5 (Grade Entry) & Phase 6 (Gradebook) sandbox
    TEACHER_GRADE_ID, TEACHER_GRADE_PIN,
    CLASS_GRADE_NAME, CLASS_GRADE_ID,
    SUBJECT_GRADE_ID, SUBJECT_GRADE_NAME,
    STUDENT_GRADE_1_ID, STUDENT_GRADE_2_ID, STUDENT_GRADE_3_ID,
    STUDENT_GRADE_DELETE_ID,
    ASSIGNMENT_STANDARD_ID, ASSIGNMENT_STANDARD_TITLE,
    ASSIGNMENT_ASSESS_ID, ASSIGNMENT_ASSESS_TITLE,
    QUESTION_MC_ID, QUESTION_FR_ID,
    GRADEBOOK_EDIT_GRADE_ID, GRADEBOOK_DELETE_GRADE_ID, GRADEBOOK_EDIT_TITLE,
    // Phase 7 (Attendance) sandbox
    TEACHER_ATTENDANCE_ID, TEACHER_ATTENDANCE_PIN,
    CLASS_ATT_A_NAME, CLASS_ATT_A_ID, CLASS_ATT_B_NAME, CLASS_ATT_B_ID,
    STUDENT_ATT_A1_ID, STUDENT_ATT_A2_ID, STUDENT_ATT_A3_ID, STUDENT_ATT_B1_ID,
    // Phase 8 (Class Stream) sandbox
    TEACHER_STREAM_ID, TEACHER_STREAM_PIN,
    CLASS_STREAM_ID, CLASS_STREAM_NAME, SUBJECT_STREAM_ID, SUBJECT_STREAM_NAME,
    POST_PINNED_ID, POST_PINNED_TITLE,
    POST_UNPINNED_NEW_ID, POST_UNPINNED_NEW_TITLE,
    POST_UNPINNED_MID_ID, POST_UNPINNED_MID_TITLE,
    POST_LESSON_PLAN_ID, POST_LESSON_PLAN_TITLE,
    // Phase 9 (Lesson Builder & Live Lessons) sandbox
    TEACHER_LESSON_ID, TEACHER_LESSON_PIN,
    CLASS_LESSON_ID, CLASS_LESSON_NAME, SUBJECT_LESSON_ID, SUBJECT_LESSON_NAME,
    LESSON_SLIDES_ID, SLIDE_REORDER_A_ID, SLIDE_REORDER_B_ID, SLIDE_REORDER_C_ID,
    LESSON_LIVE_ID, SLIDE_LIVE_TITLE_ID, SLIDE_LIVE_PROMPT_ID,
    // Phase 10 (Exams: grading + live monitor) sandbox
    TEACHER_EXAM_ID, TEACHER_EXAM_PIN,
    CLASS_EXAM_ID, CLASS_EXAM_NAME, SUBJECT_EXAM_ID, SUBJECT_EXAM_NAME,
    EXAM_ID, QUESTION_EXAM_MC_ID, QUESTION_EXAM_FR_ID,
    STUDENT_EXAM_SUBMITTED_ID, STUDENT_EXAM_INPROGRESS_ID, STUDENT_EXAM_PIN,
    EXAM_SUBMISSION_SUBMITTED_ID, EXAM_SUBMISSION_INPROGRESS_ID,
    // Phase 11 (Reports / Data Query Builder) sandbox
    TEACHER_REPORTS_ID, TEACHER_REPORTS_PIN,
    CLASS_REPORTS_ID, CLASS_REPORTS_NAME,
    SUBJECT_REPORTS_A_NAME, SUBJECT_REPORTS_B_NAME,
    STUDENT_REPORTS_1_ID, STUDENT_REPORTS_2_ID, STUDENT_REPORTS_EMPTY_ID,
    // Phase 12 (My Evaluations) sandbox
    TEACHER_EVAL_ID, TEACHER_EVAL_PIN,
    TEACHER_EVAL_EMPTY_ID, TEACHER_EVAL_EMPTY_PIN,
    EVAL_RECENT_ID, EVAL_MID_ID, EVAL_OLD_ID, EVAL_PREV_SCHOOL_ID,
    // Phase 13 (Archives) sandbox
    TEACHER_ARCHIVES_ID, TEACHER_ARCHIVES_PIN,
    CLASS_ARCHIVES_ID, CLASS_ARCHIVES_NAME,
    SUBJECT_ARCHIVES_RESTORE_ID, SUBJECT_ARCHIVES_RESTORE_NAME,
    SUBJECT_ARCHIVES_DELETE_ID, SUBJECT_ARCHIVES_DELETE_NAME,
    SUBJECT_ARCHIVES_ACTIVE_ID, SUBJECT_ARCHIVES_ACTIVE_NAME,
    ASSIGNMENT_ARCHIVES_DELETE_ID,
    STUDENT_ARCHIVES_RESTORE_ID, STUDENT_ARCHIVES_DELETE_ID,
    STUDENT_ARCHIVES_SEARCH_A_ID, STUDENT_ARCHIVES_SEARCH_B_ID,
    STUDENT_ARCHIVES_ORPHAN_ID, STUDENT_ARCHIVES_ACTIVE_ID, STUDENT_ARCHIVES_OTHERTEACHER_ID,
    // Phase 14 (Deactivated Account) sandbox
    TEACHER_DEACT_ID, TEACHER_DEACT_PIN,
    TEACHER_DEACT_EMPTY_ID, TEACHER_DEACT_EMPTY_PIN,
    // Phase 15 (Settings) sandbox
    TEACHER_SETTINGS_ID, TEACHER_SETTINGS_PIN,
    TEACHER_SETTINGS_EMAIL, TEACHER_SETTINGS_TAKEN_EMAIL, TEACHER_SETTINGS_NEW_EMAIL,
    seed,
    setStudentScore,
    getStudentDoc,
    findNotification,
    getSubjectDoc,
    findSubjectDoc,
    getGradeDoc,
    setAdHocGrade,
    findAssignmentDoc,
    getSubmissionDoc,
    findGradeByAssignment,
    setSemesterLocked,
    getAttendanceDoc,
    getPostDoc,
    findPostByTitle,
    getLessonDoc,
    getLiveSessionDoc,
    writeLiveResponse,
    findExamSubmission,
    setExamPresence,
    getTeacherDoc,
    setTeacherArchived,
    getSubjectAssignmentIds,
    getRegisteredEmailDoc,
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
