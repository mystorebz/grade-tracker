/**
 * Reads teachers/T05-8KQ2M directly and shows exactly what's stored,
 * plus what the PIN hash for "1234" should look like — settles whether
 * the login is failing because the doc is missing, the pin field is
 * missing, or the hash just doesn't match.
 *
 *   FIRESTORE_EMULATOR_HOST=127.0.0.1:8080 node check-teacher-a.js
 * (PowerShell: set $env:FIRESTORE_EMULATOR_HOST = "127.0.0.1:8080" first)
 */
const admin  = require('firebase-admin');
const crypto = require('crypto');

if (!process.env.FIRESTORE_EMULATOR_HOST) {
    console.error('FIRESTORE_EMULATOR_HOST is not set — refusing to run against anything but the emulator.');
    process.exit(1);
}

admin.initializeApp({ projectId: 'school-grade-tracker' });
const db = admin.firestore();

function sha256Trim(text) {
    return crypto.createHash('sha256').update(String(text).trim(), 'utf8').digest('hex');
}

async function main() {
    const expectedHash = sha256Trim('1234');
    console.log('Expected pin hash for "1234":', expectedHash);
    console.log('');

    const snap = await db.doc('teachers/T05-8KQ2M').get();
    if (!snap.exists) {
        console.log('NOT FOUND: teachers/T05-8KQ2M does not exist in this emulator instance.');
        console.log('-> Run seed-test-data.js again.');
        process.exit(1);
    }

    const data = snap.data();
    console.log('FOUND: teachers/T05-8KQ2M');
    console.log('currentSchoolId:', data.currentSchoolId);
    console.log('archived:', data.archived);
    console.log('stored pin hash:', data.pin);
    console.log('hashes match:', data.pin === expectedHash);

    if (data.currentSchoolId) {
        const schoolSnap = await db.doc(`schools/${data.currentSchoolId}`).get();
        console.log('');
        console.log(`schools/${data.currentSchoolId} exists:`, schoolSnap.exists);
        if (schoolSnap.exists) {
            console.log('isVerified:', schoolSnap.data().isVerified);
        }
    }
}

main().then(() => process.exit(0)).catch(err => { console.error('FAILED:', err); process.exit(1); });
