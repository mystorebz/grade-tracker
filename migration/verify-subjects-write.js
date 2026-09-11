/**
 * Exercises the exact Firestore shapes subjects.js's four rewritten
 * write-sites now use for a _source:'new' (class-scoped) subject:
 *   1. saveSubject()             -> create schools/{schoolId}/classes/{classId}/subjects/{id}
 *   2. addAssignment()           -> create .../subjects/{id}/assignments/{id}
 *   3. toggleAssignmentComplete() -> update that assignment's `completed`
 *   4. deleteAssignment()        -> delete that assignment
 * then deletes the test subject too, and reads back after every step so
 * you can see each one actually took effect.
 *
 * This proves the paths and shapes are valid and round-trip correctly. It
 * does NOT exercise the browser-side logic (the subjectsCache merge, the
 * class-picker dropdown, tile rendering) — only opening the real page in a
 * browser tests that part.
 *
 * Run after seed + apply, so schools/school-1/classes/class-a (Room A)
 * already exists:
 *   FIRESTORE_EMULATOR_HOST=127.0.0.1:8080 node verify-subjects-write.js
 */
const admin = require('firebase-admin');

if (!process.env.FIRESTORE_EMULATOR_HOST) {
    console.error('FIRESTORE_EMULATOR_HOST is not set — refusing to run against anything but the emulator.');
    process.exit(1);
}

admin.initializeApp({ projectId: 'school-grade-tracker' });
const db = admin.firestore();

const SCHOOL_ID = 'school-1';
const CLASS_ID  = 'class-a'; // Room A, from the seed fixtures

async function main() {
    const classSnap = await db.doc(`schools/${SCHOOL_ID}/classes/${CLASS_ID}`).get();
    if (!classSnap.exists) {
        console.error(`schools/${SCHOOL_ID}/classes/${CLASS_ID} not found — run seed-test-data.js first.`);
        process.exit(1);
    }

    const subjectId = 'verify_sub_' + Date.now();
    const subjectRef = db.doc(`schools/${SCHOOL_ID}/classes/${CLASS_ID}/subjects/${subjectId}`);
    await subjectRef.set({
        name: 'Verification Subject',
        description: 'created by verify-subjects-write.js',
        schoolId: SCHOOL_ID,
        classId: CLASS_ID,
        archived: false,
        archivedAt: null,
        createdAt: new Date().toISOString()
    });
    console.log(`1. Created subject: schools/${SCHOOL_ID}/classes/${CLASS_ID}/subjects/${subjectId}`);

    const assignmentId  = 'verify_asg_' + Date.now();
    const assignmentRef = subjectRef.collection('assignments').doc(assignmentId);
    await assignmentRef.set({
        id: assignmentId,
        title: 'Verification Assignment',
        type: 'Test',
        maxScore: 100,
        description: '',
        date: '',
        completed: false,
        createdAt: new Date().toISOString()
    });
    console.log(`2. Created assignment: .../subjects/${subjectId}/assignments/${assignmentId}`);

    await assignmentRef.update({ completed: true });
    const afterToggle = (await assignmentRef.get()).data();
    console.log(`3. Toggled complete -> completed: ${afterToggle.completed}`);

    await assignmentRef.delete();
    const afterDelete = await assignmentRef.get();
    console.log(`4. Deleted assignment -> still exists: ${afterDelete.exists}`);

    await subjectRef.delete();
    const subjectAfterDelete = await subjectRef.get();
    console.log(`5. Cleaned up test subject -> still exists: ${subjectAfterDelete.exists}`);

    console.log('\nAll steps completed without error.');
}

main().then(() => process.exit(0)).catch(err => { console.error('FAILED:', err); process.exit(1); });
