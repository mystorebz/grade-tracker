/**
 * ConnectUs Security Hardening — Student PIN migration.
 *
 * Problem: mintStudentToken (functions/index.js) used to accept a plain-text
 * PIN as a fallback and silently upgrade it to a hash on that student's first
 * login. That fallback has now been removed (hash-only, matching
 * mintTeacherToken/mintAdminToken) — see the "IMPORTANT DEPLOY ORDER" comment
 * on mintStudentToken. Any student who created their account but never
 * logged in is still sitting on a plain-text `pin` field, and once the
 * fallback is gone, that student would be locked out with no way in.
 *
 * This script scans every document in the top-level `students` collection,
 * leaves anything that already looks like a SHA-256 hex digest alone, and
 * hashes everything else in place — using the exact same sha256Trim
 * algorithm as functions/index.js and assets/js/crypto-utils.js, so a
 * migrated PIN still authenticates correctly afterward.
 *
 * DEPLOY ORDER: run this against production and review the log BEFORE
 * deploying the updated mintStudentToken (the one with no plain-text
 * fallback). Running it after would already be too late for any student
 * who tried to log in during the gap.
 *
 * Run against the LOCAL EMULATOR first, always:
 *   FIRESTORE_EMULATOR_HOST=127.0.0.1:8080 node migrate-student-pins.js --dry-run
 *   FIRESTORE_EMULATOR_HOST=127.0.0.1:8080 node migrate-student-pins.js --apply
 *
 * Against production, the same two commands work once a real service-account
 * key is wired up in initAdmin() below and FIRESTORE_EMULATOR_HOST is unset.
 * Do not point this at production without reviewing a dry-run report first —
 * same rollout discipline as migrate-phase0.js.
 *
 * --dry-run WRITES NOTHING. It only reads and logs what it WOULD change.
 * --apply performs the real writes. It is idempotent by construction: a
 * document whose pin is already a 64-char hex hash is left untouched, so
 * re-running after a partial failure never double-hashes anything.
 *
 * Privacy note: the log deliberately never prints an actual PIN value
 * (plain-text or hash) in full — only the plain-text length and a short
 * hash prefix — so a captured terminal/CI log can't leak working PINs.
 */

const crypto = require('crypto');

// ── Shared hash function — IDENTICAL to sha256Trim in functions/index.js ────
// and assets/js/crypto-utils.js. Must not diverge from either, or a migrated
// PIN will stop matching what mintStudentToken computes at login time.
function sha256Trim(text) {
    return crypto.createHash('sha256').update(String(text).trim(), 'utf8').digest('hex');
}

// A value that already looks like a SHA-256 hex digest (64 lowercase hex
// characters) is treated as already migrated and left alone. Anything else
// (a 4-6 digit numeric PIN, or any other plain-text value) gets hashed.
const HASH_PATTERN = /^[0-9a-f]{64}$/;

function isAlreadyHashed(pin) {
    return typeof pin === 'string' && HASH_PATTERN.test(pin);
}

/**
 * Core migration logic — factored out so it can run against any
 * Firestore-shaped `db` (the real Admin SDK instance in production/emulator,
 * or an in-memory mock in the Node test harness). Only calls `db` methods
 * that exist identically on both: collection(name).get() -> {size, docs:
 * [{id, data()}]}, and collection(name).doc(id).update(obj).
 *
 * @param {object} db - Firestore(-shaped) instance.
 * @param {object} opts
 * @param {boolean} opts.apply - if false (dry-run), no writes are made.
 * @param {(msg: string) => void} opts.log - logging sink.
 * @returns {Promise<object>} summary
 */
async function migrateStudentPins(db, { apply = false, log = console.log } = {}) {
    const summary = {
        scanned: 0,
        alreadyHashed: 0,
        migrated: 0,
        skippedNoPin: 0,
        errors: 0,
        changes: [], // [{ id, plaintextLength, newHashPrefix }]
    };

    const snap = await db.collection('students').get();
    summary.scanned = snap.size;

    for (const docSnap of snap.docs) {
        const data = docSnap.data();
        const id = docSnap.id;
        const pin = data.pin;

        if (pin === undefined || pin === null || pin === '') {
            summary.skippedNoPin++;
            log(`[skip]      ${id} — no pin field present.`);
            continue;
        }

        if (isAlreadyHashed(pin)) {
            summary.alreadyHashed++;
            continue; // common, already-safe case — no per-doc log spam
        }

        try {
            const hashed = sha256Trim(pin);
            if (apply) {
                await db.collection('students').doc(id).update({ pin: hashed });
            }
            summary.migrated++;
            const change = { id, plaintextLength: String(pin).length, newHashPrefix: hashed.slice(0, 12) };
            summary.changes.push(change);
            log(`[migrated]  ${id} — plain-text pin (${change.plaintextLength} chars) -> hash ${change.newHashPrefix}…${apply ? '' : '  [DRY RUN — not written]'}`);
        } catch (e) {
            summary.errors++;
            log(`[ERROR]     ${id} — failed to migrate: ${e.message}`);
        }
    }

    log('-'.repeat(70));
    log(
        `Scanned: ${summary.scanned}  |  Already hashed: ${summary.alreadyHashed}  |  ` +
        `Migrated: ${summary.migrated}  |  Skipped (no pin): ${summary.skippedNoPin}  |  Errors: ${summary.errors}`
    );
    if (!apply && summary.migrated > 0) {
        log('This was a DRY RUN — nothing was written. Re-run with --apply to perform the writes.');
    }

    return summary;
}

module.exports = { sha256Trim, isAlreadyHashed, migrateStudentPins };

// ── CLI entry point — only runs when this file is executed directly ─────────
// (never when required by the test harness, so the test process never hits
// the process.exit() calls or tries to contact a real/emulated Firestore).
if (require.main === module) {
    const admin = require('firebase-admin');

    const MODE = process.argv.includes('--apply') ? 'apply'
               : process.argv.includes('--dry-run') ? 'dry-run'
               : null;

    if (!MODE) {
        console.error('Usage: node migrate-student-pins.js --dry-run | --apply');
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

    migrateStudentPins(db, { apply: MODE === 'apply' })
        .then((summary) => {
            console.log('\nMigration complete.');
            if (summary.errors > 0) process.exitCode = 1;
        })
        .catch((e) => {
            console.error('Migration script crashed:', e);
            process.exitCode = 1;
        });
}
