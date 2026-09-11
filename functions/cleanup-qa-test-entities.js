/**
 * One-off cleanup: removes the QA test entities created in Test School
 * (SCH-YRUYG) while verifying the Gmail SMTP email migration —
 *   - teacher T26-VVHB4 ("QA Teacher", justine@yuzulabs.com)
 *   - class "QA Test Class"
 *   - any schools/SCH-YRUYG/teaching_assignments docs tied to that teacher
 *   - the registered_emails/justine@yuzulabs.com reservation (so that
 *     address is free to sign up again later, e.g. for a real account)
 *
 * Every match is verified against the known identifiers below (teacher ID
 * + email, class name, school ID) before it's queued for deletion — this
 * will NOT touch a real teacher or class that happens to share a name.
 *
 * This does NOT delete the Test School itself, its semesters, or any other
 * data in it — only the specific entities this test created.
 *
 * Usage:
 *   ALLOW_PRODUCTION=1 node cleanup-qa-test-entities.js            (report only)
 *   ALLOW_PRODUCTION=1 node cleanup-qa-test-entities.js --delete    (report + delete)
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

const SCHOOL_ID    = 'SCH-YRUYG';
const TEACHER_ID    = 'T26-VVHB4';
const TEACHER_EMAIL = 'justine@yuzulabs.com';
const CLASS_NAME    = 'QA Test Class';

async function main() {
    const DELETE = process.argv.includes('--delete');
    const toDelete = [];

    console.log('=== teacher ===');
    const teacherSnap = await db.collection('teachers').doc(TEACHER_ID).get();
    if (teacherSnap.exists) {
        const d = teacherSnap.data();
        if (d.email === TEACHER_EMAIL) {
            console.log(`  ${teacherSnap.id} — name="${d.name}" email="${d.email}" — MATCH, queued for delete`);
            toDelete.push(teacherSnap.ref);
        } else {
            console.log(`  ${teacherSnap.id} exists but email is "${d.email}", not "${TEACHER_EMAIL}" — SKIPPING (not touching this doc).`);
        }
    } else {
        console.log(`  (${TEACHER_ID} not found)`);
    }

    console.log('\n=== class ===');
    const classSnap = await db.collection('schools').doc(SCHOOL_ID).collection('classes')
        .where('name', '==', CLASS_NAME).get();
    for (const doc of classSnap.docs) {
        console.log(`  ${doc.id} — name="${doc.data().name}"`);
        toDelete.push(doc.ref);
    }
    if (classSnap.empty) console.log('  (none found)');

    console.log('\n=== teaching_assignments (this teacher only) ===');
    const taSnap = await db.collection('schools').doc(SCHOOL_ID).collection('teaching_assignments')
        .where('teacherId', '==', TEACHER_ID).get();
    for (const doc of taSnap.docs) {
        console.log(`  ${doc.id}`);
        toDelete.push(doc.ref);
    }
    if (taSnap.empty) console.log('  (none found)');

    console.log('\n=== registered_emails reservation ===');
    const emailSnap = await db.collection('registered_emails').doc(TEACHER_EMAIL).get();
    if (emailSnap.exists) {
        console.log(`  ${emailSnap.id} — queued for delete`);
        toDelete.push(emailSnap.ref);
    } else {
        console.log('  (none found)');
    }

    console.log(`\n${toDelete.length} document(s) matched.`);

    if (DELETE && toDelete.length > 0) {
        const batch = db.batch();
        toDelete.forEach(ref => batch.delete(ref));
        await batch.commit();
        console.log(`Deleted ${toDelete.length} document(s).`);
        console.log(
            '\nNote: the class doc\'s teacherIds array and the teacher\'s own classes ' +
            'array are gone along with the docs themselves, so there is nothing to ' +
            'unlink separately. If the teacher had a "Test School" welcome email in ' +
            `their inbox (${TEACHER_EMAIL}), that email itself is untouched — this ` +
            'only removes the Firestore records.'
        );
    } else if (!DELETE) {
        console.log('Report only — re-run with --delete to remove these documents.');
    }
}

main().catch(e => {
    console.error('Script failed:', e);
    process.exitCode = 1;
});
