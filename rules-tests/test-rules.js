const { initializeTestEnvironment, assertSucceeds, assertFails } = require('@firebase/rules-unit-testing');
const fs = require('fs');
const path = require('path');

let pass = 0;
let fail = 0;

async function check(label, promise, shouldSucceed) {
  try {
    if (shouldSucceed) {
      await assertSucceeds(promise);
    } else {
      await assertFails(promise);
    }
    console.log(`PASS - ${label}`);
    pass++;
  } catch (err) {
    console.log(`FAIL - ${label}`);
    console.log(`       ${String((err && err.message) || err).split('\n')[0]}`);
    fail++;
  }
}

async function main() {
  const testEnv = await initializeTestEnvironment({
    projectId: 'demo-connectus',
    firestore: {
      rules: fs.readFileSync(path.join(__dirname, '..', 'firestore.rules'), 'utf8'),
      host: '127.0.0.1',
      port: 8080,
    },
  });

  await testEnv.clearFirestore();

  // Seed data directly, bypassing rules entirely (admin-equivalent access)
  await testEnv.withSecurityRulesDisabled(async (ctx) => {
    const db = ctx.firestore();
    await db.doc('schools/school-1').set({ isVerified: true, name: 'Test School' });
    // PASS B PART 2: classId placed on each student fixture — student-1 in
    // class-1, student-2 in class-2 — so the per-class isolation tests below
    // can prove a student is only let into THEIR OWN class's document.
    await db.doc('students/student-1').set({ currentSchoolId: 'school-1', name: 'Student One', classId: 'class-1' });
    await db.doc('students/student-2').set({ currentSchoolId: 'school-1', name: 'Student Two', classId: 'class-2' });

    await db.doc('students/student-1/submissions/sub-open').set({ status: 'submitted', assignmentId: 'a1' });
    await db.doc('students/student-1/submissions/sub-graded').set({ status: 'graded', assignmentId: 'a1', score: 90 });

    await db.doc('students/student-1/exam_submissions/exam-sub-open').set({ status: 'in_progress', examId: 'e1' });
    await db.doc('students/student-1/exam_submissions/exam-sub-graded').set({ status: 'graded', examId: 'e1', score: 85 });

    // ── Cross-tenant isolation fixture for exam_submissions (ConnectUs
    // Phase 3 — Grading & Results) ─────────────────────────────────────────
    // The existing school-2 fixture elsewhere in this file is deliberately
    // INACTIVE (isVerified: false) — it exists to prove the isSchoolActive
    // wildcard denies an inactive school, which is a different property than
    // "two ACTIVE schools can't see each other's data." Reusing it here would
    // conflate the two: a denial in that case could be explained by either
    // gate, so it wouldn't isolate the tenant-boundary check this exam_
    // submissions rule actually relies on (resource.data.schoolId ==
    // request.auth.token.schoolId, plus the get()-based check on `allow get`).
    // school-3 below is a second, genuinely ACTIVE school, used only for this
    // isolation test, so a denial here can only be explained by the schoolId
    // mismatch itself.
    await db.doc('schools/school-3').set({ isVerified: true, name: 'Second Active School' });
    await db.doc('students/student-3').set({ currentSchoolId: 'school-3', name: 'Student Three', classId: 'class-3' });

    // Full Phase 3 schema (schoolId/isSchoolActive denormalized by
    // startExamAttempt; pendingManualQuestionIds/manualGrades written by
    // autoGradeObjectiveAnswers) — matches what a real submission looks like
    // after auto-grading, not just the older two-field fixture above.
    await db.doc('students/student-1/exam_submissions/exam-sub-crosstenant').set({
      status: 'submitted',
      examId: 'e1',
      schoolId: 'school-1',
      classId: 'class-1',
      subjectId: 'subj-1',
      isSchoolActive: true,
      score: 10,
      pendingManualPoints: 5,
      pendingManualQuestionIds: ['q2'],
      manualGrades: {},
    });

    // school-3's OWN exam submission — used by the companion "same-school
    // list still works" positive test, so the cross-tenant FAIL/PASS above
    // is provably about tenant isolation specifically, not the collection-
    // group query mechanism being broken outright for everyone.
    await db.doc('students/student-3/exam_submissions/exam-sub-ownschool').set({
      status: 'submitted',
      examId: 'e3',
      schoolId: 'school-3',
      classId: 'class-3',
      subjectId: 'subj-3',
      isSchoolActive: true,
      score: 8,
      pendingManualPoints: 0,
      pendingManualQuestionIds: [],
      manualGrades: {},
    });

    // Fanned-out per-student attendance copy (Phase 1 Milestone 6 privacy
    // fix) — onAttendanceSaved writes this via the Admin SDK from the
    // shared class-day document; seeded directly here (bypassing rules,
    // same as every other fixture in this block) to test the READ rule at
    // students/{studentId}/attendance/{attDate} in isolation.
    await db.doc('students/student-1/attendance/2026-09-01').set({ status: 'present', classId: 'class-1' });

    await db.doc('exam_answer_keys/e1').set({ answers: ['A', 'B', 'C'] });

    // ── Phase 0 correction: subjects/assignments/teaching_assignments, nested
    // under schools/{schoolId}, relying on the existing isSchoolActive()
    // wildcard rather than a new rule block. school-1 is active (isVerified
    // true, seeded above); school-2 below is deliberately NOT verified, to
    // confirm the same wildcard correctly denies access once a school goes
    // inactive.
    await db.doc('schools/school-2').set({ isVerified: false, name: 'Inactive School' });

    await db.doc('schools/school-1/classes/class-1').set({ name: 'Room A', order: 0, teacherIds: ['teacher-1'] });
    // PASS B PART 2 fixture: a second class at the SAME school, assigned to a
    // DIFFERENT teacher (teacher-3) — used to prove per-class (not just
    // per-school) isolation. teacher-3 belongs to school-1 just like
    // teacher-1, so isCallerInSchool() alone would let either one through;
    // only the new teacherIds get() check should distinguish them.
    await db.doc('schools/school-1/classes/class-2').set({ name: 'Room B', order: 1, teacherIds: ['teacher-3'] });
    await db.doc('schools/school-1/classes/class-1/subjects/subj-1').set({
      name: 'Mathematics', schoolId: 'school-1', classId: 'class-1', archived: false,
    });
    await db.doc('schools/school-1/classes/class-1/subjects/subj-1/assignments/asg-1').set({
      title: 'Fractions Test', subjectId: 'subj-1', classId: 'class-1', schoolId: 'school-1',
    });
    await db.doc('schools/school-1/teaching_assignments/ta-1').set({
      teacherId: 'teacher-1', classId: 'class-1', subjectId: 'subj-1',
      subjectName: 'Mathematics', weighting: [{ name: 'Test', weight: 40 }],
    });

    // Same shapes under the inactive school-2, to confirm the wildcard's
    // denial applies here too, not just to the collections it already covered.
    await db.doc('schools/school-2/classes/class-x').set({ name: 'Room X', order: 0 });
    await db.doc('schools/school-2/classes/class-x/subjects/subj-x').set({
      name: 'History', schoolId: 'school-2', classId: 'class-x', archived: false,
    });
    await db.doc('schools/school-2/teaching_assignments/ta-x').set({
      teacherId: 'teacher-x', classId: 'class-x', subjectId: 'subj-x', subjectName: 'History', weighting: [],
    });

    // ── Pass A: tenant-isolation fixtures ─────────────────────────────────
    // An admin doc under school-1's own admins subcollection, to prove
    // isCallerInSchool() correctly gates the admins block both ways (same
    // school succeeds, cross-tenant fails).
    await db.doc('schools/school-1/admins/admin-1').set({
      name: 'Admin One', role: 'super_admin', email: 'admin1@school1.test',
    });

    // Two disposable subjects that exist solely to be deleted by the
    // cross-tenant and same-school delete tests below, so deleting one
    // doesn't affect any other test's fixtures.
    await db.doc('schools/school-1/classes/class-1/subjects/subj-delete-crosstenant').set({
      name: 'Delete Target (cross-tenant, expect denied)', schoolId: 'school-1', classId: 'class-1', archived: false,
    });
    await db.doc('schools/school-1/classes/class-1/subjects/subj-delete-sameschool').set({
      name: 'Delete Target (same-school, expect allowed)', schoolId: 'school-1', classId: 'class-1', archived: false,
    });

    // ── ATTENDANCE fixtures ─────────────────────────────────────────────
    // One doc per class per day, records keyed by studentId — the actual
    // shape used by teacher/student/admin attendance.js, not the per-student
    // fan-out the original plan doc sketched. class-1 (teacher-1, student-1)
    // and class-2 (teacher-3, student-2) already exist from PASS B PART 2
    // above, so these reuse that same roster rather than adding new fixtures.
    await db.doc('schools/school-1/classes/class-1/attendance/2026-09-01').set({
      records: { 'student-1': 'present' },
    });
    await db.doc('schools/school-1/classes/class-2/attendance/2026-09-01').set({
      records: { 'student-2': 'present' },
    });
    // Same shape under the inactive school-2, for the isSchoolActive-denial
    // check below — matching every other inactive-school test in this file,
    // which always targets a real seeded doc rather than a missing one.
    await db.doc('schools/school-2/classes/class-x/attendance/2026-09-01').set({
      records: {},
    });
  });

  const student1Ctx = testEnv.authenticatedContext('uid-student-1', {
    role: 'student', studentId: 'student-1', schoolId: 'school-1',
  });
  const student2Ctx = testEnv.authenticatedContext('uid-student-2', {
    role: 'student', studentId: 'student-2', schoolId: 'school-1',
  });
  const teacher1Ctx = testEnv.authenticatedContext('uid-teacher-1', {
    role: 'teacher', teacherId: 'teacher-1', schoolId: 'school-1',
  });
  // PASS B PART 2: a second teacher at the SAME school as teacher-1, but
  // assigned to a DIFFERENT class (class-2, not class-1) — proves per-class
  // isolation is actually keyed on teacherIds, not merely on being at the
  // right school (teacher2Ctx below already covers the school-level case).
  const teacher3Ctx = testEnv.authenticatedContext('uid-teacher-3', {
    role: 'teacher', teacherId: 'teacher-3', schoolId: 'school-1',
  });
  const unauthedCtx = testEnv.unauthenticatedContext();

  // ── Pass A: cross-tenant contexts ───────────────────────────────────────
  // Scoped to school-2 (or, for the admin case, an entirely separate admin
  // identity) — used only to prove that a caller whose OWN token carries a
  // different schoolId is denied access to school-1's data, even though
  // school-1 is active and previously the only gate (isSchoolActive) would
  // have let any active-school caller through.
  const teacher2Ctx = testEnv.authenticatedContext('uid-teacher-2', {
    role: 'teacher', teacherId: 'teacher-2', schoolId: 'school-2',
  });
  const admin1Ctx = testEnv.authenticatedContext('uid-admin-1', {
    role: 'super_admin', adminId: 'admin-1', schoolId: 'school-1',
  });
  const admin2Ctx = testEnv.authenticatedContext('uid-admin-2', {
    role: 'super_admin', adminId: 'admin-2', schoolId: 'school-2',
  });

  // Genuinely active-school counterparts, scoped to school-3 — see the
  // school-3 fixture comment above for why school-2 (inactive) can't be
  // reused for this specific isolation check.
  const teacher3SchoolCtx = testEnv.authenticatedContext('uid-teacher-school3', {
    role: 'teacher', teacherId: 'teacher-school3', schoolId: 'school-3',
  });
  const student3Ctx = testEnv.authenticatedContext('uid-student-3', {
    role: 'student', studentId: 'student-3', schoolId: 'school-3',
  });

  // Call .firestore() exactly once per context and reuse the same instance
  // for every operation below — calling it again after the instance has
  // already been used throws "Firestore has already been started..."
  const student1 = student1Ctx.firestore();
  const student2 = student2Ctx.firestore();
  const teacher1 = teacher1Ctx.firestore();
  const teacher3 = teacher3Ctx.firestore();
  const unauthed = unauthedCtx.firestore();
  const teacher2 = teacher2Ctx.firestore();
  const admin1 = admin1Ctx.firestore();
  const admin2 = admin2Ctx.firestore();
  const teacherSchool3 = teacher3SchoolCtx.firestore();
  const studentSchool3 = student3Ctx.firestore();

  console.log('\n--- students/{id}/submissions (assignment submissions) ---');

  await check(
    'Student reads own submission',
    student1.doc('students/student-1/submissions/sub-open').get(),
    true
  );

  await check(
    "Student reads another student's submission (should be blocked)",
    student2.doc('students/student-1/submissions/sub-open').get(),
    false
  );

  await check(
    'Teacher at same school reads a submission',
    teacher1.doc('students/student-1/submissions/sub-open').get(),
    true
  );

  await check(
    'Student edits their own not-yet-graded submission',
    student1.doc('students/student-1/submissions/sub-open').update({ answerText: 'updated answer' }),
    true
  );

  await check(
    'Student tries to edit their own ALREADY-GRADED submission (should be blocked)',
    student1.doc('students/student-1/submissions/sub-graded').update({ answerText: 'trying to change it' }),
    false
  );

  await check(
    'Teacher grades (updates) a submission',
    teacher1.doc('students/student-1/submissions/sub-open').update({ status: 'graded', score: 100 }),
    true
  );

  console.log('\n--- students/{id}/exam_submissions ---');

  await check(
    // firestore.rules' exam_submissions block has `allow create: if false`
    // unconditionally (see that rule's own comment: the doc must only ever
    // be created by startExamAttempt, an Admin-SDK callable, so it can
    // compute serverDeadline from the server's own clock rather than trust
    // a client-supplied one). This test previously expected a plain client
    // create with no score field to succeed — that was never true against
    // the actual deployed rule; it was a stale expectation nobody had
    // caught because this suite had not been run against a live emulator
    // until now. Corrected to match the rule as written.
    'Student tries to CREATE their own exam submission directly, even with no score field (should be blocked — only startExamAttempt may create this doc)',
    student1.doc('students/student-1/exam_submissions/new-exam-sub').set({ status: 'in_progress', examId: 'e1', answers: ['A'] }),
    false
  );

  await check(
    'Student tries to CREATE an exam submission that includes a score field (should be blocked for this reason too, on top of create being disabled entirely)',
    student1.doc('students/student-1/exam_submissions/cheat-attempt').set({ status: 'in_progress', examId: 'e1', score: 100 }),
    false
  );

  await check(
    'Student tries to set their own score via UPDATE (should be blocked)',
    student1.doc('students/student-1/exam_submissions/exam-sub-open').update({ score: 100 }),
    false
  );

  await check(
    'Student updates their own exam submission answers (no score field touched)',
    student1.doc('students/student-1/exam_submissions/exam-sub-open').update({ answers: ['A', 'B'] }),
    true
  );

  await check(
    // ConnectUs Phase 3 — Grading & Results: a teacher's client no longer
    // has ANY update path to exam_submissions. Manual grading now goes
    // exclusively through the recordManualGrade callable (functions/
    // index.js), which runs under the Admin SDK and bypasses these rules
    // entirely — so this direct client-side write, which the old Phase 2
    // rule allowed, must now be rejected. See firestore.rules' exam_submissions
    // `allow update` comment for the full reasoning.
    'Teacher tries to set the score directly on a student exam submission (should be blocked — must go through recordManualGrade)',
    teacher1.doc('students/student-1/exam_submissions/exam-sub-open').update({ score: 95, status: 'graded' }),
    false
  );

  await check(
    'Student submits their own exam (in_progress -> submitted, no grading fields touched)',
    student1.doc('students/student-1/exam_submissions/exam-sub-open').update({ status: 'submitted', submittedAt: '2026-01-01T00:00:00.000Z' }),
    true
  );

  await check(
    'Student tries to mark their own exam as graded (should be blocked)',
    student1.doc('students/student-1/exam_submissions/exam-sub-open').update({ status: 'graded' }),
    false
  );

  await check(
    'Student tries to write manualGrades on their own submission (should be blocked)',
    student1.doc('students/student-1/exam_submissions/exam-sub-open').update({ manualGrades: { q1: { pointsAwarded: 5 } } }),
    false
  );

  console.log('\n--- exam_submissions: cross-tenant isolation (school-3 is ACTIVE, unlike the inactive school-2 used elsewhere in this file) ---');

  await check(
    "Cross-tenant: teacher at active school-3 tries to GET school-1's exam submission directly by ID (should be blocked)",
    teacherSchool3.doc('students/student-1/exam_submissions/exam-sub-crosstenant').get(),
    false
  );

  await check(
    // Exercises the top-level `match /{path=**}/exam_submissions/{id}` collection-group
    // rule (allow list), not the nested per-document `allow get` rule above —
    // this is the actual rule teacher/exams/live.js's live proctoring dashboard
    // depends on.
    //
    // CORRECTED (was wrongly asserted as shouldSucceed:true in an earlier
    // draft of this test): firestore.rules' own inline comment on this rule
    // says plainly that collection-group `list` rules are "all or nothing"
    // — Firestore proves a rule can permit a query BEFORE running it, by
    // checking the rule's condition against the query's own filters, not by
    // running the query and filtering results after the fact. This query's
    // where('schoolId','==','school-1') combined with the CALLER's token
    // carrying schoolId:'school-3' means resource.data.schoolId ==
    // request.auth.token.schoolId can never be true for anything this query
    // could return — so Firestore rejects the ENTIRE QUERY up front with
    // permission-denied, exactly like the reachability failure mode this
    // same comment describes for a missing rule block, not a partial result
    // silently filtered down to zero rows. Asserting shouldSucceed:true (as
    // this test originally did) was actually asserting the INSECURE
    // behavior — a query that runs and merely happens to return nothing.
    // assertFails on the whole query is what proves the secure behavior:
    // school-3 cannot even ask the question about school-1's data.
    "Cross-tenant: teacher at active school-3 runs a collection-group LIST on exam_submissions filtered to school-1 (the whole query should be rejected outright — 'queries are all or nothing', not silently filtered to zero rows)",
    teacherSchool3.collectionGroup('exam_submissions')
      .where('isSchoolActive', '==', true)
      .where('schoolId', '==', 'school-1')
      .get(),
    false
  );

  await check(
    // Companion positive test: without this, the FAIL above could just as
    // easily mean "this rule now blocks ALL collection-group list queries,
    // even legitimate same-school ones" — which would be a correctness
    // regression breaking teacher/exams/live.js entirely, not a security
    // property. This proves the rule still lets a school-3 teacher list
    // school-3's OWN exam data via the identical query shape, isolating the
    // cross-tenant test above to actually be about tenant isolation, not
    // about the query mechanism being broken outright.
    "Same-school: teacher at active school-3 runs the identical collection-group LIST query filtered to their OWN school (school-3) — should succeed and return the seeded doc",
    (async () => {
      const snap = await teacherSchool3.collectionGroup('exam_submissions')
        .where('isSchoolActive', '==', true)
        .where('schoolId', '==', 'school-3')
        .get();
      if (snap.size !== 1) {
        throw new Error(`Expected exactly 1 doc (school-3's own submission), got ${snap.size}.`);
      }
    })(),
    true
  );

  await check(
    "Cross-tenant: student at active school-3 tries to read school-1's exam submission (should be blocked)",
    studentSchool3.doc('students/student-1/exam_submissions/exam-sub-crosstenant').get(),
    false
  );

  await check(
    "Cross-tenant: student at active school-3 tries to write manualGrades onto school-1's exam submission (should be blocked)",
    studentSchool3.doc('students/student-1/exam_submissions/exam-sub-crosstenant').update({ manualGrades: { q2: { pointsAwarded: 5 } } }),
    false
  );

  console.log('\n--- exam_answer_keys (should be locked to everyone, even teachers) ---');

  await check(
    'Teacher tries to read the answer key directly (should be blocked - Cloud Function only)',
    teacher1.doc('exam_answer_keys/e1').get(),
    false
  );

  await check(
    'Student tries to read the answer key directly (should be blocked)',
    student1.doc('exam_answer_keys/e1').get(),
    false
  );

  console.log('\n--- schools/{schoolId}/classes/.../subjects, assignments, teaching_assignments ---');
  console.log('    (Phase 0 correction: nested under the school, no new rule block — verifying');
  console.log('     the existing isSchoolActive() wildcard actually covers these as expected)');

  await check(
    'Teacher at the active school reads a subject',
    teacher1.doc('schools/school-1/classes/class-1/subjects/subj-1').get(),
    true
  );

  await check(
    'Student at the active school reads a subject',
    student1.doc('schools/school-1/classes/class-1/subjects/subj-1').get(),
    true
  );

  await check(
    'PASS A: Unauthenticated caller reads a subject at an active school (previously succeeded — the wildcard\'s isSchoolActive-only gate never checked identity; now correctly blocked)',
    unauthed.doc('schools/school-1/classes/class-1/subjects/subj-1').get(),
    false
  );

  await check(
    'Teacher creates a new subject at the active school',
    teacher1.doc('schools/school-1/classes/class-1/subjects/subj-new').set({ name: 'Science', schoolId: 'school-1', classId: 'class-1', archived: false }),
    true
  );

  await check(
    'Teacher reads an assignment nested under a subject',
    teacher1.doc('schools/school-1/classes/class-1/subjects/subj-1/assignments/asg-1').get(),
    true
  );

  await check(
    'Teacher reads the teaching_assignments document (weighting)',
    teacher1.doc('schools/school-1/teaching_assignments/ta-1').get(),
    true
  );

  await check(
    'Student reads the teaching_assignments document (weighting is not sensitive on its own)',
    student1.doc('schools/school-1/teaching_assignments/ta-1').get(),
    true
  );

  await check(
    "Teacher updates the teaching_assignments document's weighting",
    teacher1.doc('schools/school-1/teaching_assignments/ta-1').update({ weighting: [{ name: 'Test', weight: 50 }, { name: 'Quiz', weight: 50 }] }),
    true
  );

  await check(
    'Anyone reading a subject at an INACTIVE school is blocked (school-2 has isVerified: false)',
    teacher1.doc('schools/school-2/classes/class-x/subjects/subj-x').get(),
    false
  );

  await check(
    'Anyone reading a teaching_assignments document at an INACTIVE school is blocked',
    student1.doc('schools/school-2/teaching_assignments/ta-x').get(),
    false
  );

  await check(
    'Writing a subject at an INACTIVE school is blocked',
    teacher1.doc('schools/school-2/classes/class-x/subjects/subj-x').update({ name: 'Changed' }),
    false
  );

  console.log('\n--- PASS A: cross-tenant isolation (schools/{schoolId}/admins and the main wildcard) ---');

  await check(
    'Admin reads their OWN school\'s admin doc',
    admin1.doc('schools/school-1/admins/admin-1').get(),
    true
  );

  await check(
    'Cross-tenant: admin scoped to school-2 tries to read school-1\'s admin doc (should be blocked)',
    admin2.doc('schools/school-1/admins/admin-1').get(),
    false
  );

  await check(
    'Cross-tenant: admin scoped to school-2 tries to update school-1\'s admin doc (should be blocked)',
    admin2.doc('schools/school-1/admins/admin-1').update({ name: 'Hijacked' }),
    false
  );

  await check(
    'Cross-tenant: teacher scoped to school-2 tries to read a subject at school-1 (should be blocked)',
    teacher2.doc('schools/school-1/classes/class-1/subjects/subj-1').get(),
    false
  );

  await check(
    'Cross-tenant: teacher scoped to school-2 tries to create a subject at school-1 (should be blocked)',
    teacher2.doc('schools/school-1/classes/class-1/subjects/subj-crosstenant').set({ name: 'Injected', schoolId: 'school-1', classId: 'class-1', archived: false }),
    false
  );

  await check(
    'Cross-tenant: teacher scoped to school-2 tries to update school-1\'s teaching_assignments (should be blocked)',
    teacher2.doc('schools/school-1/teaching_assignments/ta-1').update({ weighting: [{ name: 'Tampered', weight: 100 }] }),
    false
  );

  await check(
    'Cross-tenant: teacher scoped to school-2 tries to DELETE a subject at school-1 (should be blocked)',
    teacher2.doc('schools/school-1/classes/class-1/subjects/subj-delete-crosstenant').delete(),
    false
  );

  await check(
    'Same-school: teacher at school-1 deletes a subject at school-1 (should be allowed)',
    teacher1.doc('schools/school-1/classes/class-1/subjects/subj-delete-sameschool').delete(),
    true
  );

  console.log('\n--- PASS A: onboarding bootstrap still works, and the create-replay hole is closed ---');

  await check(
    'Onboarding bootstrap: unauthenticated batch creates a BRAND-NEW school doc + its first semester doc together (should still succeed)',
    (() => {
      const batch = unauthed.batch();
      const schoolRef = unauthed.doc('schools/SCH-BOOTSTRAP-TEST');
      const semRef = unauthed.doc('schools/SCH-BOOTSTRAP-TEST/semesters/sem_1');
      batch.set(schoolRef, { isVerified: true, name: 'New Onboarding School' });
      batch.set(semRef, { name: 'Term 1', order: 1, archived: false });
      return batch.commit();
    })(),
    true
  );

  await check(
    'Replay guard: unauthenticated caller tries to create a semester doc under an ALREADY-EXISTING active school (school-1) — the old bootstrap OR-clause would have let this through; should now be blocked',
    unauthed.doc('schools/school-1/semesters/sem-replay-attempt').set({ name: 'Malicious Replay', order: 99 }),
    false
  );

  console.log('\n--- PASS B PART 2: per-class isolation (schools/{schoolId}/classes/{classId}) ---');

  await check(
    "Teacher A (assigned to class-1) reads their OWN class's document",
    teacher1.doc('schools/school-1/classes/class-1').get(),
    true
  );

  await check(
    "Teacher A blocked from reading Teacher B's class (class-2) — same school, wrong class",
    teacher1.doc('schools/school-1/classes/class-2').get(),
    false
  );

  await check(
    "Teacher B (assigned to class-2) reads their OWN class's document",
    teacher3.doc('schools/school-1/classes/class-2').get(),
    true
  );

  await check(
    "Teacher B blocked from reading Teacher A's class (class-1) — same school, wrong class",
    teacher3.doc('schools/school-1/classes/class-1').get(),
    false
  );

  await check(
    'Student A (classId: class-1) reads their OWN class document',
    student1.doc('schools/school-1/classes/class-1').get(),
    true
  );

  await check(
    "Student A blocked from reading Student B's class (class-2) — same school, wrong class",
    student1.doc('schools/school-1/classes/class-2').get(),
    false
  );

  await check(
    'Student B (classId: class-2) reads their OWN class document',
    student2.doc('schools/school-1/classes/class-2').get(),
    true
  );

  await check(
    'Admin at the school reads ANY class regardless of teacherIds (class-1)',
    admin1.doc('schools/school-1/classes/class-1').get(),
    true
  );

  await check(
    'Admin at the school reads ANY class regardless of teacherIds (class-2)',
    admin1.doc('schools/school-1/classes/class-2').get(),
    true
  );

  await check(
    "Cross-tenant: teacher scoped to school-2 still blocked from reading school-1's class-1 (tenant isolation unchanged on this newly-carved-out path)",
    teacher2.doc('schools/school-1/classes/class-1').get(),
    false
  );

  await check(
    'Regression: LIST on classes is still unfiltered/open to any same-school caller (unchanged — admin/classes.js, teacher/roster.js, etc. still work)',
    teacher1.collection('schools/school-1/classes').get(),
    true
  );

  await check(
    "Regression: UPDATE on a class doc is still same-school-only, not per-class, in this pass — Teacher A can still update class-2 even though they aren't in its teacherIds (flagged as a follow-up, not tightened here)",
    teacher1.doc('schools/school-1/classes/class-2').update({ order: 5 }),
    true
  );

  console.log('\n--- ATTENDANCE: schools/{schoolId}/classes/{classId}/attendance/{date} ---');
  console.log('    (per-class read, teacher/admin-only write — students never write,');
  console.log('     regardless of what the UI hides)');

  await check(
    "Teacher assigned to class-1 (teacher-1) reads class-1's attendance",
    teacher1.doc('schools/school-1/classes/class-1/attendance/2026-09-01').get(),
    true
  );

  await check(
    "Teacher assigned to class-2 (teacher-3) blocked from reading class-1's attendance — same school, wrong class",
    teacher3.doc('schools/school-1/classes/class-1/attendance/2026-09-01').get(),
    false
  );

  await check(
    // firestore.rules' own comment on this match block (search "Phase 1
    // Milestone 6 privacy fix") is explicit: this class-day document is
    // admin/teacher-only for BOTH read and write, on purpose — a student
    // branch here would let one student's query see every other student's
    // row in the same document. Students are meant to read only the
    // fanned-out per-student copy at students/{studentId}/attendance/{date}
    // (written by onAttendanceSaved via the Admin SDK) — see the next test
    // below, which is what actually proves a student CAN read their own
    // attendance, at the correct path. This test previously expected the
    // wrong path to succeed for a student; corrected to match the rule
    // (and the privacy fix) as actually written.
    "Student in class-1 (student-1) tries to read the shared class-day attendance doc directly (should be blocked — wrong path; see the fanned-out per-student path test below for the correct one)",
    student1.doc('schools/school-1/classes/class-1/attendance/2026-09-01').get(),
    false
  );

  await check(
    "Student in class-2 (student-2) also blocked from reading class-1's shared attendance doc — same reason as above, not merely wrong class",
    student2.doc('schools/school-1/classes/class-1/attendance/2026-09-01').get(),
    false
  );

  await check(
    // THE CORRECT PATH: students never read the shared class-day document
    // above — they read their own fanned-out copy, written by
    // onAttendanceSaved (Admin SDK) to students/{studentId}/attendance/
    // {date}. This is the test the two corrected cases above were meant to
    // be testing all along; added here since no coverage of this path
    // existed anywhere in this suite before now.
    "Student-1 reads their OWN fanned-out attendance record at students/student-1/attendance/2026-09-01 (the actual correct read path)",
    student1.doc('students/student-1/attendance/2026-09-01').get(),
    true
  );

  await check(
    "Student-2 blocked from reading student-1's fanned-out attendance record (cross-student isolation on the correct path)",
    student2.doc('students/student-1/attendance/2026-09-01').get(),
    false
  );

  await check(
    "Admin reads class-1's attendance (unrestricted, like the class doc itself)",
    admin1.doc('schools/school-1/classes/class-1/attendance/2026-09-01').get(),
    true
  );

  await check(
    "Admin reads class-2's attendance too (unrestricted across classes)",
    admin1.doc('schools/school-1/classes/class-2/attendance/2026-09-01').get(),
    true
  );

  await check(
    "Unauthenticated caller blocked from reading class-1's attendance at an active school",
    unauthed.doc('schools/school-1/classes/class-1/attendance/2026-09-01').get(),
    false
  );

  await check(
    'Teacher-1 creates a new attendance record for their OWN class (class-1)',
    teacher1.doc('schools/school-1/classes/class-1/attendance/2026-09-02').set({ records: { 'student-1': 'absent' } }),
    true
  );

  await check(
    "Teacher-1 corrects (updates) an existing class-1 attendance record",
    teacher1.doc('schools/school-1/classes/class-1/attendance/2026-09-01').update({ 'records.student-1': 'tardy' }),
    true
  );

  await check(
    "Teacher-3 (class-2's teacher) blocked from updating class-1's attendance — wrong class, even same school",
    teacher3.doc('schools/school-1/classes/class-1/attendance/2026-09-01').update({ 'records.student-1': 'excused' }),
    false
  );

  await check(
    "Student-1 blocked from CREATING an attendance record for their own class (should be teacher/admin-only)",
    student1.doc('schools/school-1/classes/class-1/attendance/2026-09-03').set({ records: { 'student-1': 'present' } }),
    false
  );

  await check(
    'THE GAP THIS PASS CLOSES: Student-1 blocked from UPDATING the existing class-1 attendance record',
    student1.doc('schools/school-1/classes/class-1/attendance/2026-09-01').update({ 'records.student-1': 'present' }),
    false
  );

  await check(
    "Student-1 blocked from DELETING the class-1 attendance record",
    student1.doc('schools/school-1/classes/class-1/attendance/2026-09-01').delete(),
    false
  );

  await check(
    "Admin can also write attendance directly (override), e.g. correcting a record on a teacher's behalf",
    admin1.doc('schools/school-1/classes/class-1/attendance/2026-09-01').update({ 'records.student-1': 'present' }),
    true
  );

  await check(
    "Cross-tenant: teacher scoped to school-2 blocked from reading school-1's class-1 attendance",
    teacher2.doc('schools/school-1/classes/class-1/attendance/2026-09-01').get(),
    false
  );

  await check(
    "Cross-tenant: teacher scoped to school-2 blocked from creating an attendance record under school-1/class-1",
    teacher2.doc('schools/school-1/classes/class-1/attendance/2026-09-04').set({ records: {} }),
    false
  );

  await check(
    'Inactive school: teacher blocked from reading attendance at school-2 (isVerified: false)',
    teacher1.doc('schools/school-2/classes/class-x/attendance/2026-09-01').get(),
    false
  );

  console.log(`\n${pass} passed, ${fail} failed\n`);

  await testEnv.cleanup();
  process.exit(fail > 0 ? 1 : 0);
}

main().catch((err) => {
  console.error('Test run crashed:', err);
  process.exit(1);
});
