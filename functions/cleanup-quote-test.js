/**
 * One-off cleanup: finds the smoke-test quote request (workEmail
 * smoketest@connectusonline.org, school name "QA Smoke Test School") and its
 * two associated `mail` documents (customer confirmation + HQ alert), reports
 * their actual delivery status, and — only with --delete — removes all three
 * documents from production.
 *
 * This does NOT unsend an email that already shows delivery.state === "SUCCESS".
 * It only tells you whether that happened and removes the Firestore records.
 *
 * Usage:
 *   ALLOW_PRODUCTION=1 node cleanup-quote-test.js            (report only)
 *   ALLOW_PRODUCTION=1 node cleanup-quote-test.js --delete    (report + delete)
 */

const admin = require('firebase-admin');

if (process.env.ALLOW_PRODUCTION !== '1') {
    console.error(
        'ALLOW_PRODUCTION=1 was not set. Refusing to run — this targets production Firestore.'
    );
    process.exit(1);
}

admin.initializeApp({
    credential: admin.credential.applicationDefault(),
    projectId: 'school-grade-tracker',
});
const db = admin.firestore();

const TEST_SCHOOL_NAME = 'QA Smoke Test School';
const TEST_EMAIL = 'smoketest@connectusonline.org';
const HQ_EMAIL = 'info@connectusonline.org';
const HQ_SUBJECT = `New Quote Request: ${TEST_SCHOOL_NAME}`;

async function main() {
    const DELETE = process.argv.includes('--delete');
    const toDelete = [];

    console.log('=== quote_requests ===');
    const qrSnap = await db.collection('quote_requests').where('workEmail', '==', TEST_EMAIL).get();
    for (const doc of qrSnap.docs) {
        const d = doc.data();
        console.log(`  ${doc.id} — schoolName="${d.schoolName}" createdAt=${d.createdAt} fulfilled=${d.fulfilled}`);
        toDelete.push(doc.ref);
    }
    if (qrSnap.empty) console.log('  (none found)');

    console.log('\n=== mail -> customer (smoketest@connectusonline.org) ===');
    const custSnap = await db.collection('mail').where('to', '==', TEST_EMAIL).get();
    for (const doc of custSnap.docs) {
        const d = doc.data();
        console.log(`  ${doc.id} — state=${d.delivery?.state || 'UNKNOWN'} subject="${d.message?.subject}"`);
        toDelete.push(doc.ref);
    }
    if (custSnap.empty) console.log('  (none found)');

    console.log('\n=== mail -> HQ (info@connectusonline.org, this test school only) ===');
    const hqSnap = await db.collection('mail').where('to', '==', HQ_EMAIL).get();
    const hqMatches = hqSnap.docs.filter(d => d.data().message?.subject === HQ_SUBJECT);
    for (const doc of hqMatches) {
        const d = doc.data();
        console.log(`  ${doc.id} — state=${d.delivery?.state || 'UNKNOWN'} subject="${d.message?.subject}"`);
        toDelete.push(doc.ref);
    }
    if (hqMatches.length === 0) console.log('  (none found)');

    console.log(`\n${toDelete.length} document(s) matched.`);

    if (DELETE && toDelete.length > 0) {
        const batch = db.batch();
        toDelete.forEach(ref => batch.delete(ref));
        await batch.commit();
        console.log(`Deleted ${toDelete.length} document(s).`);
    } else if (!DELETE) {
        console.log('Report only — re-run with --delete to remove these documents.');
    }
}

main().catch(e => {
    console.error('Script failed:', e);
    process.exitCode = 1;
});
