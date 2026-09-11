/**
 * ConnectUs Pass B — Class-Scoping Schema Upgrade migration.
 *
 * Problem: today, teacher↔class and student↔class relationships are pure
 * STRING matching — a teacher doc's `classes` array holds class NAMES, and a
 * student doc's `className` is a name too. Nothing on either doc is a real
 * Firestore document reference, so per-class Firestore rules have nothing
 * trustworthy to check. This script backfills the two new reference fields
 * introduced for Pass B, WITHOUT touching or removing anything that already
 * exists — `className` keeps working exactly as it does today:
 *
 *   1. schools/{schoolId}/classes/{classId}.teacherIds
 *      — every teacher-doc ID currently teaching that class (derived from
 *        each teacher's own `classes`/`className`), so the class doc becomes
 *        the single source of truth for "who may act on this class."
 *
 *   2. students/{studentId}.classId
 *      — the real classes/{classId} doc ID matching that student's current
 *        `className`, so rules can resolve a student to their class without
 *        trusting a display-only string.
 *
 * Going forward, admin/teachers/teachers.js, admin/classes/classes.js,
 * admin/students/students.js, and teacher/roster/roster.js all write and
 * clear these fields live (Pass B frontend update) — this script exists only
 * to backfill data that predates that change. Idempotency is by FIELD
 * PRESENCE, not by value: once `teacherIds` exists on a class doc, or
 * `classId` exists on a student doc — even as `[]` / `''` — that document is
 * considered already migrated and is left alone, because the live code path
 * is what's responsible for keeping it correct from that point on.
 *
 * Orphaned data is surfaced, never guessed at: a student whose `className`
 * doesn't match any class doc at their school gets logged as needing manual
 * review, and `classId` is left UNSET for that student (not written as ''),
 * so the same orphan keeps showing up on every re-run until someone fixes
 * the underlying mismatch rather than being silently swallowed.
 *
 * Run against the LOCAL EMULATOR first, always:
 *   FIRESTORE_EMULATOR_HOST=127.0.0.1:8080 node migrate-class-scoping.js --dry-run
 *   FIRESTORE_EMULATOR_HOST=127.0.0.1:8080 node migrate-class-scoping.js --apply
 *
 * Against production, the same two commands work once a real service-account
 * key is wired up in initAdmin() below and FIRESTORE_EMULATOR_HOST is unset.
 * Do not point this at production without reviewing a dry-run report first —
 * same rollout discipline as migrate-phase0.js / migrate-student-pins.js.
 *
 * --dry-run WRITES NOTHING. It only reads and logs what it WOULD change.
 * --apply performs the real writes.
 */

/**
 * Backfill #1: schools/{schoolId}/classes/{classId}.teacherIds
 *
 * For every school, builds a className -> [teacherId, ...] map from that
 * school's teacher docs (a class can have more than one teacher — homeroom
 * plus subject teachers — so this aggregates every match, deduplicated),
 * then writes that array onto each matching class doc.
 *
 * @param {object} db - Firestore(-shaped) instance. Only uses:
 *   collection(name).get(), collection(name).where(f,'==',v).get(),
 *   collection(name).doc(id).collection(name).get(),
 *   collection(name).doc(id).collection(name).doc(id).update(obj).
 * @param {object} opts
 * @param {boolean} opts.apply - if false (dry-run), no writes are made.
 * @param {(msg: string) => void} opts.log - logging sink.
 */
async function migrateClassTeacherIds(db, { apply = false, log = console.log } = {}) {
    const summary = {
        schoolsScanned: 0,
        classesScanned: 0,
        alreadyPresent: 0,
        migrated: 0,
        migratedEmpty: 0, // teacherIds field written, but resolved to [] (no teacher currently assigned)
        errors: 0,
        changes: [], // [{ schoolId, classId, className, teacherIds }]
    };

    const schoolsSnap = await db.collection('schools').get();
    summary.schoolsScanned = schoolsSnap.size;

    for (const schoolDoc of schoolsSnap.docs) {
        const schoolId = schoolDoc.id;

        try {
            const [classesSnap, teachersSnap] = await Promise.all([
                db.collection('schools').doc(schoolId).collection('classes').get(),
                db.collection('teachers').where('currentSchoolId', '==', schoolId).get(),
            ]);

            // className -> [teacherId, ...], deduplicated
            const teacherIdsByClassName = {};
            for (const tDoc of teachersSnap.docs) {
                const t = tDoc.data();
                const classes = (t.classes && t.classes.length) ? t.classes : (t.className ? [t.className] : []);
                for (const cls of classes) {
                    if (!cls) continue;
                    if (!teacherIdsByClassName[cls]) teacherIdsByClassName[cls] = [];
                    if (!teacherIdsByClassName[cls].includes(tDoc.id)) teacherIdsByClassName[cls].push(tDoc.id);
                }
            }

            for (const classDoc of classesSnap.docs) {
                summary.classesScanned++;
                const classData = classDoc.data();

                if ('teacherIds' in classData) {
                    summary.alreadyPresent++;
                    continue; // already in the new shape — the live code path owns it now
                }

                const derivedIds = teacherIdsByClassName[classData.name] || [];

                try {
                    if (apply) {
                        await db.collection('schools').doc(schoolId).collection('classes').doc(classDoc.id).update({ teacherIds: derivedIds });
                    }
                    if (derivedIds.length === 0) {
                        summary.migratedEmpty++;
                        log(`[migrated]  ${schoolId}/classes/${classDoc.id} ("${classData.name}") — no teacher currently assigned -> teacherIds: []${apply ? '' : '  [DRY RUN]'}`);
                    } else {
                        summary.migrated++;
                        log(`[migrated]  ${schoolId}/classes/${classDoc.id} ("${classData.name}") -> teacherIds: [${derivedIds.join(', ')}]${apply ? '' : '  [DRY RUN]'}`);
                    }
                    summary.changes.push({ schoolId, classId: classDoc.id, className: classData.name, teacherIds: derivedIds });
                } catch (e) {
                    summary.errors++;
                    log(`[ERROR]     ${schoolId}/classes/${classDoc.id} — failed to migrate: ${e.message}`);
                }
            }
        } catch (e) {
            summary.errors++;
            log(`[ERROR]     school ${schoolId} — failed to process: ${e.message}`);
        }
    }

    log('-'.repeat(70));
    log(
        `Classes — Schools scanned: ${summary.schoolsScanned}  |  Classes scanned: ${summary.classesScanned}  |  ` +
        `Already present: ${summary.alreadyPresent}  |  Migrated: ${summary.migrated}  |  ` +
        `Migrated (empty): ${summary.migratedEmpty}  |  Errors: ${summary.errors}`
    );

    return summary;
}

/**
 * Backfill #2: students/{studentId}.classId
 *
 * For every student with a non-empty `className`, resolves it to the real
 * class-doc ID at that student's school and writes `classId`. A student with
 * no className gets classId explicitly set to '' (so the field is present
 * and consistent going forward, matching what every live write path now
 * does). A className with no matching class doc at that school is an
 * orphan — logged for manual review, classId left UNSET (not ''), so it
 * keeps surfacing on every re-run rather than being silently accepted.
 *
 * @param {object} db - Firestore(-shaped) instance (same shape as above).
 * @param {object} opts
 * @param {boolean} opts.apply - if false (dry-run), no writes are made.
 * @param {(msg: string) => void} opts.log - logging sink.
 */
async function migrateStudentClassIds(db, { apply = false, log = console.log } = {}) {
    const summary = {
        scanned: 0,
        alreadyPresent: 0,
        migrated: 0,
        unassigned: 0, // no className at all -> classId written as ''
        orphaned: 0,   // className present but no matching class doc -> flagged, left unset
        errors: 0,
        changes: [],    // [{ id, className, classId }]
        orphans: [],    // [{ id, className, schoolId }]
    };

    const classDocsBySchool = new Map(); // schoolId -> [{id, name}], fetched once per school

    async function classDocsFor(schoolId) {
        if (!classDocsBySchool.has(schoolId)) {
            const snap = await db.collection('schools').doc(schoolId).collection('classes').get();
            classDocsBySchool.set(schoolId, snap.docs.map(d => ({ id: d.id, ...d.data() })));
        }
        return classDocsBySchool.get(schoolId);
    }

    const studentsSnap = await db.collection('students').get();
    summary.scanned = studentsSnap.size;

    for (const sDoc of studentsSnap.docs) {
        const data = sDoc.data();
        const id = sDoc.id;

        if ('classId' in data) {
            summary.alreadyPresent++;
            continue; // already in the new shape — the live code path owns it now
        }

        const className = data.className;
        const schoolId = data.currentSchoolId;

        if (!className) {
            try {
                if (apply) await db.collection('students').doc(id).update({ classId: '' });
                summary.unassigned++;
            } catch (e) {
                summary.errors++;
                log(`[ERROR]     ${id} — failed to write empty classId: ${e.message}`);
            }
            continue;
        }

        if (!schoolId) {
            summary.orphaned++;
            summary.orphans.push({ id, className, schoolId: '' });
            log(`[ORPHAN]    ${id} — has className "${className}" but no currentSchoolId, so there's no school to resolve a class doc against. Needs manual review; classId left unset.`);
            continue;
        }

        try {
            const classDocs = await classDocsFor(schoolId);
            const match = classDocs.find(c => c.name === className);

            if (!match) {
                summary.orphaned++;
                summary.orphans.push({ id, className, schoolId });
                log(`[ORPHAN]    ${id} — className "${className}" at school ${schoolId} has no matching class doc. Needs manual review; classId left unset.`);
                continue;
            }

            if (apply) {
                await db.collection('students').doc(id).update({ classId: match.id });
            }
            summary.migrated++;
            summary.changes.push({ id, className, classId: match.id });
            log(`[migrated]  ${id} — "${className}" -> classId ${match.id}${apply ? '' : '  [DRY RUN]'}`);
        } catch (e) {
            summary.errors++;
            log(`[ERROR]     ${id} — failed to migrate: ${e.message}`);
        }
    }

    log('-'.repeat(70));
    log(
        `Students — Scanned: ${summary.scanned}  |  Already present: ${summary.alreadyPresent}  |  ` +
        `Migrated: ${summary.migrated}  |  Unassigned (classId set to ''): ${summary.unassigned}  |  ` +
        `Orphaned (needs review): ${summary.orphaned}  |  Errors: ${summary.errors}`
    );
    if (summary.orphaned > 0) {
        log(`⚠  ${summary.orphaned} student(s) have a className that doesn't match any class doc. Review the [ORPHAN] lines above before considering this migration complete.`);
    }

    return summary;
}

/**
 * Runs both backfills in sequence (classes first, then students — students
 * don't depend on classes having just been written, since they read class
 * docs fresh either way, but doing classes first means a freshly-derived
 * teacherIds list is available if anyone wants to sanity-check it against
 * the student-side results in the same run).
 */
async function migrateClassScoping(db, { apply = false, log = console.log } = {}) {
    log('=== Backfilling classes/{classId}.teacherIds ===');
    const classSummary = await migrateClassTeacherIds(db, { apply, log });
    log('');
    log('=== Backfilling students/{studentId}.classId ===');
    const studentSummary = await migrateStudentClassIds(db, { apply, log });

    if (!apply && (classSummary.migrated + classSummary.migratedEmpty + studentSummary.migrated) > 0) {
        log('');
        log('This was a DRY RUN — nothing was written. Re-run with --apply to perform the writes.');
    }

    return { classSummary, studentSummary };
}

module.exports = { migrateClassTeacherIds, migrateStudentClassIds, migrateClassScoping };

// ── CLI entry point — only runs when this file is executed directly ─────────
// (never when required by the test harness, so the test process never hits
// the process.exit() calls or tries to contact a real/emulated Firestore).
if (require.main === module) {
    const admin = require('firebase-admin');

    const MODE = process.argv.includes('--apply') ? 'apply'
               : process.argv.includes('--dry-run') ? 'dry-run'
               : null;

    if (!MODE) {
        console.error('Usage: node migrate-class-scoping.js --dry-run | --apply');
        process.exit(1);
    }

    function initAdmin() {
        // Emulator mode: FIRESTORE_EMULATOR_HOST is set, no real credentials needed.
        if (process.env.FIRESTORE_EMULATOR_HOST) {
            admin.initializeApp({ projectId: 'school-grade-tracker' });
            return;
        }

        // Production mode: requires BOTH real Application Default Credentials
        // (via `gcloud auth application-default login`, or GOOGLE_APPLICATION_CREDENTIALS
        // pointing at a downloaded service-account key) AND an explicit
        // ALLOW_PRODUCTION=1 flag — so forgetting to set FIRESTORE_EMULATOR_HOST can
        // never silently run --apply against the real database. Do not run --apply
        // against production without having reviewed a --dry-run report by hand first.
        if (process.env.ALLOW_PRODUCTION !== '1') {
            console.error(
                'FIRESTORE_EMULATOR_HOST is not set, and ALLOW_PRODUCTION=1 was not passed. ' +
                'Refusing to run — set ALLOW_PRODUCTION=1 only when you deliberately intend ' +
                'to target production Firestore, after authenticating via `gcloud auth ' +
                'application-default login`.'
            );
            process.exit(1);
        }

        admin.initializeApp({
            credential: admin.credential.applicationDefault(),
            projectId: 'school-grade-tracker',
        });
    }
    initAdmin();
    const db = admin.firestore();

    console.log(MODE === 'dry-run' ? 'Running in DRY-RUN mode — no writes will be made.\n' : 'Running LIVE (--apply) — this WILL modify Firestore.\n');

    migrateClassScoping(db, { apply: MODE === 'apply' })
        .then(({ classSummary, studentSummary }) => {
            console.log('\nMigration complete.');
            if (classSummary.errors > 0 || studentSummary.errors > 0) process.exitCode = 1;
        })
        .catch((e) => {
            console.error('Migration script crashed:', e);
            process.exitCode = 1;
        });
}
