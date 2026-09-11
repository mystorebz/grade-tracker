/**
 * Reads one exact document straight from Firestore by its known path — no
 * query, no UI — to settle whether schools/school-1/teaching_assignments/
 * T05-8KQ2M_class-a_sub_a1 really exists and what it actually contains,
 * independent of whatever the emulator UI's collection tree is or isn't
 * showing.
 *
 *   FIRESTORE_EMULATOR_HOST=127.0.0.1:8080 node read-teaching-assignment.js
 */
const admin = require('firebase-admin');

if (!process.env.FIRESTORE_EMULATOR_HOST) {
    console.error('FIRESTORE_EMULATOR_HOST is not set — refusing to run against anything but the emulator.');
    process.exit(1);
}

admin.initializeApp({ projectId: 'school-grade-tracker' });
const db = admin.firestore();

const PATH = 'schools/school-1/teaching_assignments/T05-8KQ2M_class-a_sub_a1';

async function main() {
    const snap = await db.doc(PATH).get();
    if (!snap.exists) {
        console.log(`NOT FOUND: ${PATH}`);
        process.exit(1);
    }
    console.log(`FOUND: ${PATH}`);
    console.log(JSON.stringify(snap.data(), null, 2));
}

main().then(() => process.exit(0)).catch(err => { console.error('Failed:', err); process.exit(1); });
