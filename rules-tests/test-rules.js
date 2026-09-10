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
    await db.doc('students/student-1').set({ currentSchoolId: 'school-1', name: 'Student One' });
    await db.doc('students/student-2').set({ currentSchoolId: 'school-1', name: 'Student Two' });

    await db.doc('students/student-1/submissions/sub-open').set({ status: 'submitted', assignmentId: 'a1' });
    await db.doc('students/student-1/submissions/sub-graded').set({ status: 'graded', assignmentId: 'a1', score: 90 });

    await db.doc('students/student-1/exam_submissions/exam-sub-open').set({ status: 'in_progress', examId: 'e1' });
    await db.doc('students/student-1/exam_submissions/exam-sub-graded').set({ status: 'graded', examId: 'e1', score: 85 });

    await db.doc('exam_answer_keys/e1').set({ answers: ['A', 'B', 'C'] });
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

  // Call .firestore() exactly once per context and reuse the same instance
  // for every operation below — calling it again after the instance has
  // already been used throws "Firestore has already been started..."
  const student1 = student1Ctx.firestore();
  const student2 = student2Ctx.firestore();
  const teacher1 = teacher1Ctx.firestore();

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

  console.log(`\n${pass} passed, ${fail} failed\n`);

  await testEnv.cleanup();
  process.exit(fail > 0 ? 1 : 0);
}

main().catch((err) => {
  console.error('Test run crashed:', err);
  process.exit(1);
});
