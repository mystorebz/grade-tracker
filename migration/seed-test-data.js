/**
 * Seeds the LOCAL EMULATOR ONLY with realistic fake teacher/class fixtures
 * so migrate-phase0.js has something to actually migrate. The emulator's
 * Firestore is wiped every time it restarts, and rules-tests (which shares
 * the same emulator) never creates any teacher documents — so without this,
 * a fresh dry-run correctly reports "0 teachers scanned" because there's
 * genuinely nothing there yet.
 *
 * This does NOT touch production. It refuses to run unless
 * FIRESTORE_EMULATOR_HOST is set, same as migrate-phase0.js.
 *
 * Run once, then run the dry-run / apply cycle against this seeded data:
 *   FIRESTORE_EMULATOR_HOST=127.0.0.1:8080 node seed-test-data.js
 *   FIRESTORE_EMULATOR_HOST=127.0.0.1:8080 npm run dry-run
 *   FIRESTORE_EMULATOR_HOST=127.0.0.1:8080 npm run apply
 *
 * Each fixture below is deliberately named for the exact case it's testing —
 * read the comment on each one to see what the report should say about it.
 */

const admin = require('firebase-admin');
const crypto = require('crypto');

if (!process.env.FIRESTORE_EMULATOR_HOST) {
  console.error('FIRESTORE_EMULATOR_HOST is not set — refusing to seed. This must only ever run against the emulator.');
  process.exit(1);
}

admin.initializeApp({ projectId: 'school-grade-tracker' });
const db = admin.firestore();

// Matches functions/index.js's sha256Trim() exactly, so this hash verifies
// against the real mintTeacherToken Cloud Function running in the emulator.
function hashPin(pin) {
  return crypto.createHash('sha256').update(String(pin).trim(), 'utf8').digest('hex');
}

// Matches functions/index.js's sha256Lower() exactly (lowercase + trim) —
// mintAdminToken hashes the admin portal's code this way, distinct from
// hashPin() above (teacher PINs are trim-only, no lowercasing).
function hashAdminCode(code) {
  return crypto.createHash('sha256').update(String(code).toLowerCase().trim(), 'utf8').digest('hex');
}

// Plaintext test PIN for Teacher A (T05-8KQ2M) — type this into the login
// screen at teacher/login.html along with teacherId T05-8KQ2M.
const TEST_PIN = '1234';

// Plaintext super_admin code for school-1 — type this into admin/login.html
// along with School ID school-1. Without this, the school doc has no
// adminCode field at all and admin login always fails with "Incorrect
// Admin Code", no matter what's typed.
const TEST_ADMIN_CODE = '1234';

async function main() {
  console.log('Clearing any existing emulator data under schools/ and teachers/...');
  // Emulator-only convenience: real teardown isn't needed since this is
  // scoped to the demo-connectus project, but re-running the seed script
  // twice in a row without restarting the emulator would otherwise create
  // duplicate class docs — hard-delete anything from a previous seed run.
  for (const collName of ['teachers']) {
    const snap = await db.collection(collName).get();
    await Promise.all(snap.docs.map(d => d.ref.delete()));
  }
  const schoolTeachers = await db.collectionGroup('teachers').get();
  await Promise.all(schoolTeachers.docs.map(d => d.ref.delete()));
  const classesSnap = await db.collectionGroup('classes').get();
  await Promise.all(classesSnap.docs.map(d => d.ref.delete()));

  console.log('Seeding school doc (isVerified:true, required by mintTeacherToken; adminCode set for admin login)...');
  // {merge:true} so this never clobbers whatever the rules-tests suite
  // (which shares this same emulator) has already set on schools/school-1 —
  // it only guarantees isVerified/adminCode/name are present so login can succeed.
  // securityQuestionsSet:true skips the first-time-setup onboarding redirect,
  // same reason Teacher A's fixture below sets it.
  await db.doc('schools/school-1').set({
    name: 'Test School',
    isVerified: true,
    schoolType: 'K12',
    adminCode: hashAdminCode(TEST_ADMIN_CODE),
    securityQuestionsSet: true,
  }, { merge: true });

  console.log('Seeding classes...');
  await db.doc('schools/school-1/classes/class-a').set({ name: 'Room A', order: 0 });
  await db.doc('schools/school-1/classes/class-b').set({ name: 'Room B', order: 1 });
  // Deliberately NOT creating a class doc named 'Room Z (renamed)' or
  // 'Room Y (old name)' — those are supposed to fail to resolve.

  console.log('Seeding teacher fixtures...');

  // A — top-level, current shape throughout. Should migrate cleanly:
  // 1 subject (with 1 nested assignment) under Room A, weighting carried
  // forward from gradeTypes. Has a real PIN (see TEST_PIN above) so it can
  // log in through teacher/login.html for manual browser verification.
  await db.doc('teachers/T05-8KQ2M').set({
    name: 'Teacher A (top-level, clean current shape)',
    currentSchoolId: 'school-1',
    classes: ['Room A'],
    activeSemesterId: 'sem-fall-2026',
    pin: hashPin(TEST_PIN),
    profileComplete: true,
    securityQuestionsSet: true, // skips onboarding/first-time-setup.html so login goes straight to home/home.html
    gradeTypes: [{ name: 'Test', weight: 100 }],
    subjects: [
      {
        id: 'sub_a1', name: 'Mathematics', description: 'Core math', archived: false,
        assignments: [{
          id: 'asg_a1', title: 'Fractions Test', type: 'Test', maxScore: 100,
          description: '', date: '2026-09-22', completed: false, createdAt: '2026-09-01T00:00:00.000Z',
        }],
      },
      // Reading — deliberately left un-migrated. Every other subject in this
      // fixture (Mathematics included, historically) has already been carried
      // over to a schools/{schoolId}/classes/{classId}/subjects document by an
      // earlier `npm run apply` pass, so subjectsCache would merge them all as
      // _source:'new' and the legacy fallback branch in archiveSubject() /
      // restoreSubject() / permanentDeleteSubject() would never actually run.
      // This one has no counterpart in the new per-class collection, so it
      // merges in as _source:'legacy' — the real shape a not-yet-migrated
      // school's data is still in today. Use it to walk through archive →
      // restore → permanent delete once and confirm the legacy branch writes
      // straight back to this embedded array (via getTeacherDocRef()) with no
      // new-model document ever created for it.
      {
        id: 'sub_a2', name: 'Reading', description: 'Legacy fixture — not migrated to the new model on purpose.', archived: false,
        assignments: [{
          id: 'asg_a2', title: 'Reading Log', type: 'Homework', maxScore: 20,
          description: '', date: '2026-09-15', completed: false, createdAt: '2026-09-01T00:00:00.000Z',
        }],
      },
    ],
  });

  // B — school-scoped (schools/school-1/teachers/{id}). Confirms
  // collectionGroup('teachers') catches this location too.
  await db.doc('schools/school-1/teachers/T09-QQ111').set({
    name: 'Teacher B (school-scoped, clean current shape)',
    classes: ['Room B'],
    customGradeTypes: [{ name: 'Quiz', weight: 100 }],
    subjects: [{ id: 'sub_b1', name: 'Science', description: '', archived: false, assignments: [] }],
  });

  // C — legacy string-array subjects. Should be flagged in
  // legacyStringSubjectsTeachers and skipped entirely for subjects/assignments
  // (not crash, not silently guess a shape for it).
  await db.doc('teachers/T11-STR001').set({
    name: 'Teacher C (legacy string-array subjects)',
    currentSchoolId: 'school-1',
    classes: ['Room A'],
    subjects: ['Math', 'English'],
    gradeTypes: [{ name: 'Test', weight: 100 }],
  });

  // D — legacy localStorage-key weighting, but CURRENT-shape subjects.
  // Subjects/assignments should still migrate; weighting should come through
  // as an empty array with this teacher flagged in
  // legacyLocalStorageWeightingTeachers — confirming the two legacy shapes
  // are handled independently, not conflated.
  await db.doc('teachers/T12-LSW001').set({
    name: 'Teacher D (legacy localStorage weighting)',
    currentSchoolId: 'school-1',
    classes: ['Room A'],
    gradeTypes: 'connectus_gradeTypes_T12-LSW001',
    subjects: [{ id: 'sub_d1', name: 'Art', description: '', archived: false, assignments: [] }],
  });

  // E — orphaned className: 'Room Z (renamed)' matches no real class doc.
  // Should appear in orphanedClassNames, and since it's this teacher's ONLY
  // class, their subject should NOT be migrated this run (no resolvable
  // class to attach it to) — not dropped silently, just not yet possible.
  await db.doc('teachers/T13-ORPH01').set({
    name: 'Teacher E (orphaned class name only)',
    currentSchoolId: 'school-1',
    classes: ['Room Z (renamed)'],
    gradeTypes: [{ name: 'Test', weight: 100 }],
    subjects: [{ id: 'sub_e1', name: 'History', description: '', archived: false, assignments: [] }],
  });

  // F — TWO classes, one resolves (Room A) and one doesn't (Room Y (old
  // name)). Confirms partial resolution: the orphan is logged, but the
  // teacher's other, resolvable subject still migrates under Room A rather
  // than the whole teacher being skipped.
  await db.doc('teachers/T14-PART01').set({
    name: 'Teacher F (partial class resolution)',
    currentSchoolId: 'school-1',
    classes: ['Room A', 'Room Y (old name)'],
    gradeTypes: [{ name: 'Test', weight: 100 }],
    subjects: [{ id: 'sub_f1', name: 'Music', description: '', archived: false, assignments: [] }],
  });

  // G — top-level teacher with NO currentSchoolId set at all (e.g. an
  // unclaimed/orphaned teacher record). Should be logged in
  // skippedTeachersNoSchoolId and nothing else attempted for them.
  await db.doc('teachers/T15-NOSCH1').set({
    name: 'Teacher G (no resolvable schoolId)',
    classes: ['Room A'],
    subjects: [{ id: 'sub_g1', name: 'Drama', description: '', archived: false, assignments: [] }],
  });

  // Real seeded student for Teacher A (Room A) — needed for manual browser
  // testing of grade_form.js. Without at least one real student doc, any
  // grade write is correctly PERMISSION_DENIED by firestore.rules (the
  // students/{id}/grades create rule does get(students/{studentId}) and
  // requires currentSchoolId to resolve to an active school — a
  // nonexistent studentId always fails that check, by design).
  console.log('Seeding a real student for Teacher A (Room A)...');
  await db.doc('students/STU-0001').set({
    name: 'Alex Sample',
    currentSchoolId: 'school-1',
    enrollmentStatus: 'Active',
    teacherId: 'T05-8KQ2M',
    className: 'Room A',
    createdAt: new Date().toISOString(),
  });

  console.log('\nSeed complete: 7 teacher fixtures, 1 student, 2 class docs, under project demo-connectus.');
  console.log('Expected on the next dry-run: teachersScanned=7 (6 top-level, 1 school-scoped),');
  console.log('subjectsFound=4 (A, B, D, F), assignmentsFound=1 (A only),');
  console.log('orphanedClassNames=2 (E\'s Room Z, F\'s Room Y), legacyStringSubjectsTeachers=1 (C),');
  console.log('legacyLocalStorageWeightingTeachers=1 (D), skippedTeachersNoSchoolId=1 (G).');
  console.log('\nTo log in as Teacher A in the browser: teacherId T05-8KQ2M, PIN ' + TEST_PIN);
  console.log('To log in as admin in the browser: School ID school-1, Admin Code ' + TEST_ADMIN_CODE);
  console.log('Teacher A\'s "Reading" subject is deliberately NOT migrated — do not run `npm run apply` again after seeding, or it will be swept into the new model too.');
}

main()
  .then(() => process.exit(0))
  .catch(err => { console.error('Seed failed:', err); process.exit(1); });
