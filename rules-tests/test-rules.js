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
    'Student creates their own exam submission (no score field)',
    student1.doc('students/student-1/exam_submissions/new-exam-sub').set({ status: 'in_progress', examId: 'e1', answers: ['A'] }),
    true
  );

  await check(
    'Student tries to CREATE an exam submission that includes a score field (should be blocked)',
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
    'Teacher sets the score on a student exam submission',
    teacher1.doc('students/student-1/exam_submissions/exam-sub-open').update({ score: 95, status: 'graded' }),
    true
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

  console.log(`\n${pass} passed, ${fail} failed\n`);

  await testEnv.cleanup();
  process.exit(fail > 0 ? 1 : 0);
}

main().catch((err) => {
  console.error('Test run crashed:', err);
  process.exit(1);
});
