/**
 * Deletes the throwaway test student created by seed-pin-test-student.js,
 * restoring the local emulator to a clean baseline. Refuses to run unless
 * FIRESTORE_EMULATOR_HOST is set, same as every other script in this folder.
 *
 *   $env:FIRESTORE_EMULATOR_HOST = "127.0.0.1:8080"
 *   node delete-pin-test-student.js
 */
const admin = require('firebase-admin');

if (!process.env.FIRESTORE_EMULATOR_HOST) {
    console.error('FIRESTORE_EMULATOR_HOST is not set — refusing to run against anything but the emulator.');
    process.exit(1);
}

admin.initializeApp({ projectId: 'school-grade-tracker' });
const db = admin.firestore();

const TEST_ID = 'S26-TESTP1';

async function main() {
    const snap = await db.collection('students').doc(TEST_ID).get();
    if (!snap.exists) {
        console.log(`${TEST_ID} does not exist — nothing to clean up.`);
        return;
    }
    await db.collection('students').doc(TEST_ID).delete();
    console.log(`Deleted test student ${TEST_ID}. Emulator restored to clean baseline.`);
}

main().catch((e) => {
    console.error('Cleanup script crashed:', e);
    process.exitCode = 1;
});
