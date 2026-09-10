/**
 * ConnectUs Phase 0 migration: subjects, assignments, and grade-weighting
 * out of the embedded teacher-profile arrays and into their own collections.
 *
 * Run against the LOCAL EMULATOR first, always:
 *   FIRESTORE_EMULATOR_HOST=127.0.0.1:8080 node migrate-phase0.js --dry-run
 *   FIRESTORE_EMULATOR_HOST=127.0.0.1:8080 node migrate-phase0.js --apply
 *
 * Against production, the same two commands work once a real service-account
 * key is wired up in initAdmin() below and FIRESTORE_EMULATOR_HOST is unset —
 * do not point this at production before a pilot-school dry run has been
 * reviewed by hand, per the plan's rollout section.
 *
 * --dry-run WRITES NOTHING. It only reads and produces migration-report.json
 * plus a console summary. Read that report by hand before ever running
 * --apply, per the plan: "Review that report by hand before the second pass
 * ever runs."
 *
 * --apply performs the real writes. It is idempotent by construction: every
 * new document is created at a deterministic ID derived from the legacy
 * record it came from, and the script checks for that document's existence
 * before creating it rather than overwriting — so re-running after fixing
 * orphaned class-name records never duplicates anything already migrated
 * correctly, and never clobbers a document you or the app has since touched.
 */

const admin = require('firebase-admin');
const fs = require('fs');
const path = require('path');

const MODE = process.argv.includes('--apply') ? 'apply'
           : process.argv.includes('--dry-run') ? 'dry-run'
           : null;

if (!MODE) {
  console.error('Usage: node migrate-phase0.js --dry-run | --apply');
  process.exit(1);
}

function initAdmin() {
  // Emulator mode: FIRESTORE_EMULATOR_HOST is set, no real credentials needed.
  // Production mode: replace this with
  //   admin.initializeApp({ credential: admin.credential.cert(require('./serviceAccountKey.json')) });
  // — deliberately not wired up yet. This script has not been run against
  // production, and per the plan's rollout section it shouldn't be until a
  // single pilot school's dry run has been reviewed by hand.
  if (process.env.FIRESTORE_EMULATOR_HOST) {
    admin.initializeApp({ projectId: 'demo-connectus' });
  } else {
    console.error(
      'FIRESTORE_EMULATOR_HOST is not set. Refusing to run against production ' +
      'without a deliberate credential setup — see the comment in initAdmin().'
    );
    process.exit(1);
  }
}
initAdmin();
const db = admin.firestore();

// ── Legacy-shape detectors ──────────────────────────────────────────────────
// Both confirmed by reading the real code (teacher/login.js, assets/js/utils.js)
// during the Phase 0 audit — not guessed.

// Old subjects shape: a plain array of strings, e.g. ['Math', 'English'],
// instead of the current array of {id, name, description, archived, assignments}
// objects. teacher/login.js already auto-fixes this on next login, so a
// teacher stuck here just needs to log in once before this script can touch
// their data — this script does not attempt that normalization itself.
function isLegacyStringSubjects(subjects) {
  return Array.isArray(subjects) && subjects.length > 0 && typeof subjects[0] === 'string';
}

// Old grade-weighting shape: gradeTypes/customGradeTypes holds a plain string
// ID instead of the current array of {name, weight} objects — that string was
// only ever a key into one browser's localStorage cache
// (`connectus_gradeTypes_<id>`), which a server-side script has no way to
// read. Genuinely unreachable — has to be re-entered through the gradebook
// UI before this script can migrate that teacher's weighting.
function isLegacyLocalStorageWeighting(gradeTypesValue) {
  return typeof gradeTypesValue === 'string' && gradeTypesValue.length > 0;
}

// ── Teacher location parsing ─────────────────────────────────────────────────
// collectionGroup('teachers') returns docs from both teachers/{id} (global)
// and schools/{schoolId}/teachers/{id} (school-scoped) — this is the only
// reliable way to enumerate every teacher regardless of location.
function parseTeacherLocation(docRef) {
  const segments = docRef.path.split('/'); // e.g. ['teachers','T05-...'] or ['schools','SCH-1','teachers','T05-...']
  if (segments.length === 2 && segments[0] === 'teachers') {
    return { location: 'top-level', schoolId: null };
  }
  if (segments.length === 4 && segments[0] === 'schools' && segments[2] === 'teachers') {
    return { location: 'school-scoped', schoolId: segments[1] };
  }
  return { location: 'unknown', schoolId: null };
}

// A teacher's class links are either a `classes` array of name strings, or a
// single `className` string on older records — normalize to a deduped array.
function getTeacherClassNames(teacherData) {
  const names = Array.isArray(teacherData.classes) && teacherData.classes.length
    ? teacherData.classes
    : (teacherData.className ? [teacherData.className] : []);
  return [...new Set(names.filter(Boolean))];
}

// ── Class-name → classId resolution, cached per school ──────────────────────
const classesByNameCache = new Map(); // schoolId -> Map(className -> classId)

async function getClassIdByName(schoolId, className) {
  if (!classesByNameCache.has(schoolId)) {
    const snap = await db.collection('schools').doc(schoolId).collection('classes').get();
    const map = new Map();
    snap.docs.forEach(d => map.set(d.data().name, d.id));
    classesByNameCache.set(schoolId, map);
  }
  return classesByNameCache.get(schoolId).get(className) || null;
}

// ── Core traversal, shared by both passes ────────────────────────────────────
// Building the report and doing the real writes off ONE shared traversal
// guarantees pass 2 never diverges from what pass 1 told you it would do.
async function traverseTeachers({ apply }) {
  const report = {
    generatedAt: new Date().toISOString(),
    mode: apply ? 'apply' : 'dry-run',
    teachersScanned: 0,
    teachersByLocation: { 'top-level': 0, 'school-scoped': 0, unknown: 0 },
    subjectsFound: 0,
    subjectsCreated: 0,
    subjectsAlreadyMigrated: 0,
    assignmentsFound: 0,
    assignmentsCreated: 0,
    assignmentsAlreadyMigrated: 0,
    teachingAssignmentsCreated: 0,
    teachingAssignmentsAlreadyMigrated: 0,
    orphanedClassNames: [],       // className didn't resolve to a real class doc
    legacyStringSubjectsTeachers: [],      // needs a login before this script can touch them
    legacyLocalStorageWeightingTeachers: [], // weighting unreachable, needs manual re-entry
    skippedTeachersNoSchoolId: [], // top-level teacher with no currentSchoolId — can't resolve classes
    errors: [],
  };

  const snap = await db.collectionGroup('teachers').get();

  for (const teacherDoc of snap.docs) {
    report.teachersScanned++;
    const teacherData = teacherDoc.data();
    const teacherId = teacherDoc.id;
    const { location, schoolId: schoolIdFromPath } = parseTeacherLocation(teacherDoc.ref);
    report.teachersByLocation[location] = (report.teachersByLocation[location] || 0) + 1;

    const schoolId = schoolIdFromPath || teacherData.currentSchoolId || null;
    if (!schoolId) {
      report.skippedTeachersNoSchoolId.push({ teacherId, path: teacherDoc.ref.path });
      continue;
    }

    // ── Legacy-shape pre-migration cleanup cases — log and skip, never guess ──
    const rawSubjects = teacherData.subjects;
    if (isLegacyStringSubjects(rawSubjects)) {
      report.legacyStringSubjectsTeachers.push({ teacherId, path: teacherDoc.ref.path, schoolId });
      continue; // whole teacher skipped for subjects/assignments until they've logged in once
    }

    const rawWeighting = teacherData.gradeTypes || teacherData.customGradeTypes;
    if (isLegacyLocalStorageWeighting(rawWeighting)) {
      report.legacyLocalStorageWeightingTeachers.push({ teacherId, path: teacherDoc.ref.path, schoolId });
      // Note: this only blocks *weighting* migration for this teacher, not
      // subjects/assignments — those are independent, so we do NOT `continue` here.
    }

    const classNames = getTeacherClassNames(teacherData);
    const subjects = Array.isArray(rawSubjects) ? rawSubjects : [];

    // Map className -> resolved classId once per teacher, logging orphans.
    const resolvedClassIds = new Map();
    for (const className of classNames) {
      const classId = await getClassIdByName(schoolId, className);
      if (classId) {
        resolvedClassIds.set(className, classId);
      } else {
        report.orphanedClassNames.push({ teacherId, path: teacherDoc.ref.path, schoolId, className });
        // Deliberately just this one class relationship is skipped — never
        // drop the teacher's other, resolvable subjects/classes, and never
        // fabricate a placeholder class document to force a match.
      }
    }

    // Subjects aren't tied to a specific class in the legacy shape — a
    // teacher's subject list is shared across all their classes. Per the new
    // schema each subject document belongs to exactly one class, so a
    // subject migrates once per (teacher, resolved class) pair.
    for (const [className, classId] of resolvedClassIds) {
      for (const subject of subjects) {
        if (subject.archived) continue; // archived legacy subjects are not carried forward
        report.subjectsFound++;

        const subjectDocId = subject.id; // reuse legacy id verbatim — this IS the idempotency key
        const subjectRef = db
          .collection('schools').doc(schoolId)
          .collection('classes').doc(classId)
          .collection('subjects').doc(subjectDocId);

        let subjectAlreadyExists = false;
        if (apply) {
          const existing = await subjectRef.get();
          subjectAlreadyExists = existing.exists;
          if (!subjectAlreadyExists) {
            await subjectRef.set({
              name: subject.name,
              description: subject.description || '',
              schoolId,
              classId,
              archived: false,
              archivedAt: null,
              createdAt: subject.createdAt || new Date().toISOString(),
              migratedFrom: { legacySubjectId: subject.id, legacyTeacherPath: teacherDoc.ref.path },
            });
          }
        }
        if (subjectAlreadyExists) report.subjectsAlreadyMigrated++; else report.subjectsCreated++;

        // ── Assignments nested inside this legacy subject ──
        const assignments = Array.isArray(subject.assignments) ? subject.assignments : [];
        for (const assignment of assignments) {
          report.assignmentsFound++;
          const assignmentDocId = assignment.id;
          const assignmentRef = subjectRef.collection('assignments').doc(assignmentDocId);

          let assignmentAlreadyExists = false;
          if (apply) {
            const existingA = await assignmentRef.get();
            assignmentAlreadyExists = existingA.exists;
            if (!assignmentAlreadyExists) {
              await assignmentRef.set({
                title: assignment.title,
                type: assignment.type,
                maxScore: assignment.maxScore,
                description: assignment.description || '',
                date: assignment.date || null,
                completed: !!assignment.completed,
                subjectId: subjectDocId,
                classId,
                schoolId,
                createdAt: assignment.createdAt || new Date().toISOString(),
                migratedFrom: { legacyAssignmentId: assignment.id },
              });
            }
          }
          if (assignmentAlreadyExists) report.assignmentsAlreadyMigrated++; else report.assignmentsCreated++;
        }

        // ── teaching_assignments: one per (teacher, class, subject) ──
        // Deterministic ID keeps this idempotent without an extra query.
        // Weighting is only carried forward if it's on the current shape —
        // a teacher flagged above under legacyLocalStorageWeightingTeachers
        // gets an empty weighting array here, not a guessed one; that's the
        // signal for whoever reviews the report to go re-enter it by hand.
        const taId = `${teacherId}_${classId}_${subjectDocId}`;
        const taRef = db.collection('schools').doc(schoolId).collection('teaching_assignments').doc(taId);

        let taAlreadyExists = false;
        if (apply) {
          const existingTA = await taRef.get();
          taAlreadyExists = existingTA.exists;
          if (!taAlreadyExists) {
            const weighting = Array.isArray(rawWeighting) ? rawWeighting : [];
            await taRef.set({
              teacherId,
              coTeacherIds: [],
              classId,
              subjectId: subjectDocId,
              subjectName: subject.name,
              studentGroup: null,
              academicTermId: teacherData.activeSemesterId || null,
              status: 'active',
              weighting,
              createdAt: new Date().toISOString(),
              migratedFrom: {
                legacyTeacherPath: teacherDoc.ref.path,
                legacyWeightField: teacherData.gradeTypes ? 'gradeTypes' : 'customGradeTypes',
              },
            });
          }
        }
        if (taAlreadyExists) report.teachingAssignmentsAlreadyMigrated++; else report.teachingAssignmentsCreated++;
      }
    }
  }

  return report;
}

async function main() {
  const apply = MODE === 'apply';
  console.log(`Running Phase 0 migration in ${apply ? 'APPLY (writes real data)' : 'DRY-RUN (no writes)'} mode...`);

  const report = await traverseTeachers({ apply });

  const outPath = path.join(__dirname, apply ? 'migration-report.apply.json' : 'migration-report.dry-run.json');
  fs.writeFileSync(outPath, JSON.stringify(report, null, 2));

  console.log('\n=== Phase 0 Migration Report ===');
  console.log(`Mode:                          ${report.mode}`);
  console.log(`Teachers scanned:              ${report.teachersScanned}`);
  console.log(`  top-level:                   ${report.teachersByLocation['top-level']}`);
  console.log(`  school-scoped:               ${report.teachersByLocation['school-scoped']}`);
  console.log(`  unknown path shape:          ${report.teachersByLocation.unknown}`);
  console.log(`Subjects found / created / already-migrated:               ${report.subjectsFound} / ${report.subjectsCreated} / ${report.subjectsAlreadyMigrated}`);
  console.log(`Assignments found / created / already-migrated:            ${report.assignmentsFound} / ${report.assignmentsCreated} / ${report.assignmentsAlreadyMigrated}`);
  console.log(`teaching_assignments created / already-migrated:           ${report.teachingAssignmentsCreated} / ${report.teachingAssignmentsAlreadyMigrated}`);
  console.log(`Orphaned className records (need manual resolution):       ${report.orphanedClassNames.length}`);
  console.log(`Teachers on legacy string-array subjects (need a login):   ${report.legacyStringSubjectsTeachers.length}`);
  console.log(`Teachers on legacy localStorage weighting (need re-entry): ${report.legacyLocalStorageWeightingTeachers.length}`);
  console.log(`Teachers skipped, no schoolId resolvable:                  ${report.skippedTeachersNoSchoolId.length}`);
  console.log(`\nFull report written to: ${outPath}`);

  if (!apply) {
    console.log(
      '\nThis was a dry run — nothing was written. Review the orphaned/legacy ' +
      'lists in the report file by hand, resolve what needs resolving, then ' +
      'run again with --apply.'
    );
  }
}

main().catch(err => {
  console.error('Migration failed:', err);
  process.exit(1);
});
