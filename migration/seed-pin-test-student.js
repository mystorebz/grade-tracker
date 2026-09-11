/**
 * Seeds the LOCAL EMULATOR ONLY with one throwaway student doc carrying a
 * real plain-text PIN, so migrate-student-pins.js has something genuine to
 * migrate — the emulator's existing students collection (just the STU-0001
 * attendance-test fixture) has no pin field at all to exercise the real
 * write path against.
 *
 * This does NOT touch production. It refuses to run unless
 * FIRESTORE_EMULATOR_HOST is set, same as migrate-student-pins.js and
 * seed-test-data.js.
 *
 * Run once, then run the migration dry-run / apply cycle, then delete this
 * test student again with delete-pin-test-student.js to restore a clean
 * baseline:
 *   $env:FIRESTORE_EMULATOR_HOST = "127.0.0.1:8080"
 *   node seed-pin-test-student.js
 *   node migrate-student-pins.js --dry-run
 *   node migrate-student-pins.js --apply
 *   node delete-pin-test-student.js
 */
const admin = require('firebase-admin');

if (!process.env.FIRESTORE_EMULATOR_HOST) {
    console.error('FIRESTORE_EMULATOR_HOST is not set — refusing to seed. This must only ever run against the emulator.');
    process.exit(1);
}

admin.initializeApp({ projectId: 'school-grade-tracker' });
const db = admin.firestore();

const TEST_ID = 'S26-TESTP1';
const PLAINTEXT_PIN = '4321'; // deliberately obvious/fake — this is a throwaway test fixture, not a real student

async function main() {
    await db.collection('students').doc(TEST_ID).set({
        name: 'PIN Migration Test Student',
        currentSchoolId: 'school-1',
        enrollmentStatus: 'Active',
        pin: PLAINTEXT_PIN, // real plain-text PIN, exactly what a not-yet-hashed student doc looks like
        createdAt: new Date().toISOString(),
    });
    console.log(`Seeded test student ${TEST_ID} with plain-text pin "${PLAINTEXT_PIN}".`);
    console.log('Now run: node migrate-student-pins.js --dry-run   (then --apply)');
}

main().catch((e) => {
    console.error('Seed script crashed:', e);
    process.exitCode = 1;
});
