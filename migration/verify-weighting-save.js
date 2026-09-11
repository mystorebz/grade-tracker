/**
 * Exercises the exact same Firestore write pattern as
 * assets/js/utils.js's saveTeacherWeightingEverywhere() — one atomic batch
 * that updates the teacher's own doc AND every schools/{schoolId}/
 * teaching_assignments doc belonging to that teacher — so the data-
 * integrity part of the gradebook.js fix can be checked directly against
 * the emulator, without needing a full browser login (which needs a PIN
 * field the seed fixtures were never given).
 *
 * Run after seed + apply, so Teacher A (T05-8KQ2M) already has a
 * schools/school-1/teaching_assignments document to update:
 *
 *   FIRESTORE_EMULATOR_HOST=127.0.0.1:8080 node seed-test-data.js
 *   FIRESTORE_EMULATOR_HOST=127.0.0.1:8080 node migrate-phase0.js --apply
 *   FIRESTORE_EMULATOR_HOST=127.0.0.1:8080 node verify-weighting-save.js
 */
const admin = require('firebase-admin');

if (!process.env.FIRESTORE_EMULATOR_HOST) {
    console.error('FIRESTORE_EMULATOR_HOST is not set — refusing to run against anything but the emulator.');
    process.exit(1);
}

admin.initializeApp({ projectId: 'school-grade-tracker' });
const db = admin.firestore();

const TEACHER_ID = 'T05-8KQ2M';
const SCHOOL_ID  = 'school-1';

const NEW_WEIGHTING = [
    { name: 'Test',       weight: 50 },
    { name: 'Quiz',       weight: 30 },
    { name: 'Assignment', weight: 20 },
];

async function main() {
    const teacherRef  = db.collection('teachers').doc(TEACHER_ID);
    const teacherSnap = await teacherRef.get();
    if (!teacherSnap.exists) {
        console.error(`teachers/${TEACHER_ID} not found — run seed-test-data.js first.`);
        process.exit(1);
    }

    const taSnap = await db.collection('schools').doc(SCHOOL_ID).collection('teaching_assignments')
        .where('teacherId', '==', TEACHER_ID).get();

    console.log(`Found ${taSnap.size} teaching_assignments doc(s) for ${TEACHER_ID}.`);
    if (taSnap.empty) {
        console.warn('None found — run migrate-phase0.js --apply first so there is at least one to update.');
    }

    const batch = db.batch();
    batch.update(teacherRef, { gradeTypes: NEW_WEIGHTING, customGradeTypes: NEW_WEIGHTING });
    taSnap.forEach(d => batch.update(d.ref, { weighting: NEW_WEIGHTING }));

    await batch.commit();

    console.log('\nDone. Go check in the emulator UI (Firestore tab, already open):');
    console.log(`  1. teachers > ${TEACHER_ID} > gradeTypes and customGradeTypes should now read:`);
    console.log('     ', JSON.stringify(NEW_WEIGHTING));
    taSnap.forEach(d => console.log(`  2. schools > ${SCHOOL_ID} > teaching_assignments > ${d.id} > weighting should match the same array.`));
}

main().then(() => process.exit(0)).catch(err => { console.error('Failed:', err); process.exit(1); });
