#!/usr/bin/env node
'use strict';
/**
 * functions/migrations/01-subjects-and-grades.js — legacy subjects → per-class model
 *
 *   node migrations/01-subjects-and-grades.js --dry-run     print the plan, write nothing
 *   node migrations/01-subjects-and-grades.js               apply
 *   node migrations/01-subjects-and-grades.js --verify      check result, exit 1 on any gap
 *   node migrations/01-subjects-and-grades.js --cleanup     roll back everything this script wrote
 *   add --school=QA-SCHOOL-01 to any mode to limit scope
 *
 * Target: dev-school-grade-tracker ONLY. Auth: Application Default Credentials.
 *
 * 1. Every entry of teachers/{t}.subjects[] (ds1–ds8 defaults and custom legacy
 *    subjects; top-level teachers/{t} and schools/{s}/teachers/{t}) becomes
 *    schools/{s}/classes/{c}/subjects/{legacyId} in EACH class the teacher teaches.
 *    The legacy id is kept as the doc id on purpose: lessons/posts/submissions the
 *    app already wrote for legacy subjects live at
 *    classes/{firstClass}/subjects/{legacyId}/… (resolvePostContext fallback),
 *    so they attach to the new subject doc with zero moves.
 * 2. Embedded subjects[].assignments[] → …/subjects/{legacyId}/assignments/{asgId}
 *    (ids kept, so grades' assignmentId and existing submissions stay valid).
 * 3. Every collectionGroup('grades') doc missing subjectId/classId is patched,
 *    resolved by (schoolId, className → classId) then (classId, subject name → subjectId).
 *
 * Non-destructive: teachers/{t}.subjects[] is left untouched. Everything written
 * is tagged (_mig01) so --cleanup removes exactly that and nothing else:
 *   subject/assignment docs: _mig01: true          → deleted (doc only, never subcollections)
 *   grade docs: _mig01: ['subjectId', 'classId']   → those fields removed
 * Idempotent: re-running only adds what is still missing (e.g. grades created since).
 */

const PROJECT_ID = 'dev-school-grade-tracker';
const requested = process.env.QA_PROJECT_ID || PROJECT_ID;
if (requested !== PROJECT_ID) {
    console.error(`[FAIL] Refusing to run against "${requested}". Only ${PROJECT_ID} is allowed.`);
    process.exit(2);
}
for (const v of ['FIRESTORE_EMULATOR_HOST', 'FIREBASE_AUTH_EMULATOR_HOST', 'FIREBASE_EMULATOR_HUB']) delete process.env[v];
process.env.GOOGLE_CLOUD_PROJECT = PROJECT_ID;
process.env.GCLOUD_PROJECT = PROJECT_ID;

const { initializeApp, applicationDefault } = require('firebase-admin/app');
const { getFirestore, FieldValue } = require('firebase-admin/firestore');

const app = initializeApp({ projectId: PROJECT_ID, credential: applicationDefault() }, 'mig-01');
const db = getFirestore(app);
db.settings({ ignoreUndefinedProperties: true });

// ── ARGS ────────────────────────────────────────────────────────────────────
const argv = process.argv.slice(2);
const MODE = argv.includes('--cleanup') ? 'cleanup' : argv.includes('--verify') ? 'verify' : argv.includes('--dry-run') ? 'dry-run' : 'apply';
const SCHOOL = (argv.find((a) => a.startsWith('--school=')) || '').split('=')[1] || null;
const TAG = '_mig01';
const MIG = '01-subjects-and-grades';

const log = (m) => console.log(m);
const sample = (arr, n = 10) => arr.slice(0, n).map((x) => `         ${x}`).join('\n');
const inScope = (schoolId) => !!schoolId && (!SCHOOL || schoolId === SCHOOL);

// ── READ MODEL ──────────────────────────────────────────────────────────────
const classesBySchool = new Map(); // schoolId -> [{id, name}]
const subjectsByClass = new Map(); // `${s}/${c}` -> Map(subjectId -> {name, tagged, planned})

async function getClasses(schoolId) {
    if (!classesBySchool.has(schoolId)) {
        const snap = await db.collection('schools').doc(schoolId).collection('classes').get();
        classesBySchool.set(schoolId, snap.docs.map((d) => ({ id: d.id, name: d.get('name') || '' })));
    }
    return classesBySchool.get(schoolId);
}

async function getClassSubjects(schoolId, classId) {
    const key = `${schoolId}/${classId}`;
    if (!subjectsByClass.has(key)) {
        const snap = await classRef(schoolId, classId).collection('subjects').get();
        subjectsByClass.set(key, new Map(snap.docs.map((d) => [d.id, { name: d.get('name'), tagged: d.get(TAG) === true, planned: false }])));
    }
    return subjectsByClass.get(key);
}

const classRef = (s, c) => db.collection('schools').doc(s).collection('classes').doc(c);
const subjectRef = (s, c, sub) => classRef(s, c).collection('subjects').doc(sub);

async function loadTeachers() {
    // collectionGroup covers both teachers/{t} (global) and schools/{s}/teachers/{t} (legacy)
    const snap = await db.collectionGroup('teachers').get();
    const out = [];
    for (const d of snap.docs) {
        const segs = d.ref.path.split('/');
        if (!(segs.length === 2 || (segs.length === 4 && segs[0] === 'schools'))) continue;
        const schoolId = segs.length === 4 ? segs[1] : d.get('currentSchoolId');
        if (!inScope(schoolId)) continue;
        const data = d.data();
        const classNames = (Array.isArray(data.classes) && data.classes.length ? data.classes : [data.className]).filter(Boolean);
        const schoolClasses = await getClasses(schoolId);
        const byName = new Map(schoolClasses.map((c) => [c.name, c.id]));
        const classes = classNames.map((n) => ({ name: n, id: byName.get(n) })).filter((c) => c.id);
        out.push({
            path: d.ref.path, id: d.id, schoolId, classNames, classes,
            subjects: Array.isArray(data.subjects) ? data.subjects : [],
        });
    }
    return out;
}

// ── PLAN ────────────────────────────────────────────────────────────────────
async function plan() {
    const teachers = await loadTeachers();
    const p = {
        teachers, subjectCreates: [], assignmentCreates: [], gradePatches: [],
        unresolvedTeachers: [], conflicts: [], shadowed: [], unresolvedGrades: [], gradesAlreadyOk: 0,
    };
    const teacherFirstClass = new Map(); // `${schoolId}/${teacherId}` -> classId
    const asgSeen = new Set();

    for (const t of teachers) {
        if (t.classes.length) teacherFirstClass.set(`${t.schoolId}/${t.id}`, t.classes[0].id);
        if (!t.subjects.length) continue;
        if (!t.classes.length) {
            p.unresolvedTeachers.push(`${t.path} classes=${JSON.stringify(t.classNames)}`);
            continue;
        }

        for (const cls of t.classes) {
            const subs = await getClassSubjects(t.schoolId, cls.id);
            for (const legacy of t.subjects) {
                if (!legacy || !legacy.id || !legacy.name) continue;
                const at = `${t.schoolId}/${cls.id}/${legacy.id}`;
                const existing = subs.get(legacy.id);

                if (existing && existing.name !== legacy.name) {
                    p.conflicts.push(`${at}: exists as "${existing.name}", legacy "${legacy.name}" (${t.path})`);
                    continue;
                }
                if (!existing) {
                    const sameName = [...subs.entries()].find(([, v]) => v.name === legacy.name);
                    if (sameName) {
                        p.shadowed.push(`${at}: "${legacy.name}" already exists as ${sameName[0]} (${t.path})`);
                        continue;
                    }
                    const { assignments, id, ...fields } = legacy;
                    p.subjectCreates.push({
                        ref: subjectRef(t.schoolId, cls.id, legacy.id),
                        data: {
                            ...fields,
                            name: legacy.name,
                            description: legacy.description || '',
                            schoolId: t.schoolId,
                            classId: cls.id,
                            archived: !!legacy.archived,
                            archivedAt: legacy.archivedAt || null,
                            createdAt: legacy.createdAt || new Date().toISOString(),
                            [TAG]: true,
                            _migratedFrom: t.path,
                        },
                    });
                    subs.set(legacy.id, { name: legacy.name, tagged: true, planned: true });
                }

                for (const asg of Array.isArray(legacy.assignments) ? legacy.assignments : []) {
                    if (!asg || !asg.id) continue;
                    const ref = subjectRef(t.schoolId, cls.id, legacy.id).collection('assignments').doc(asg.id);
                    if (asgSeen.has(ref.path)) continue;
                    asgSeen.add(ref.path);
                    p.assignmentCreates.push({ ref, data: { ...asg, [TAG]: true } });
                }
            }
        }
    }

    // drop assignment creates that already exist
    for (let i = 0; i < p.assignmentCreates.length; i += 300) {
        const chunk = p.assignmentCreates.slice(i, i + 300);
        const snaps = await db.getAll(...chunk.map((a) => a.ref));
        snaps.forEach((s, j) => { if (s.exists) chunk[j].skip = true; });
    }
    p.assignmentCreates = p.assignmentCreates.filter((a) => !a.skip);

    // grades
    const gSnap = await db.collectionGroup('grades').get();
    for (const g of gSnap.docs) {
        const d = g.data();
        if (!inScope(d.schoolId)) continue;
        if (d.subjectId && d.classId) { p.gradesAlreadyOk++; continue; }

        const classes = await getClasses(d.schoolId);
        let classId = d.classId || (classes.find((c) => c.name === d.className) || {}).id
            || teacherFirstClass.get(`${d.schoolId}/${d.teacherId}`) || null;
        let subjectId = d.subjectId || null;
        if (classId && !subjectId) {
            const subs = await getClassSubjects(d.schoolId, classId);
            subjectId = ([...subs.entries()].find(([, v]) => v.name === d.subject) || [])[0] || null;
        }
        if (!classId || !subjectId) {
            p.unresolvedGrades.push(`${g.ref.path} class="${d.className || ''}" subject="${d.subject || ''}"`);
            continue;
        }
        const patch = {};
        const set = [];
        if (!d.classId) { patch.classId = classId; set.push('classId'); }
        if (!d.subjectId) { patch.subjectId = subjectId; set.push('subjectId'); }
        patch[TAG] = set;
        p.gradePatches.push({ ref: g.ref, data: patch });
    }
    return p;
}

function printPlan(p) {
    log(`[INFO] mode=${MODE} project=${PROJECT_ID} scope=${SCHOOL || 'ALL schools'}`);
    log(`[INFO] teachers scanned: ${p.teachers.length}, with legacy subjects: ${p.teachers.filter((t) => t.subjects.length).length}`);
    log(`[PLAN] subject docs to create:     ${p.subjectCreates.length}`);
    log(`[PLAN] assignment docs to create:  ${p.assignmentCreates.length}`);
    log(`[PLAN] grade docs to patch:        ${p.gradePatches.length} (already have subjectId+classId: ${p.gradesAlreadyOk})`);
    if (p.subjectCreates.length) log(sample(p.subjectCreates.map((s) => `+ ${s.ref.path} "${s.data.name}"`)));
    if (p.shadowed.length) log(`[SKIP] ${p.shadowed.length} legacy subject(s) already exist under another id:\n${sample(p.shadowed)}`);
    if (p.conflicts.length) log(`[WARN] ${p.conflicts.length} id conflict(s), skipped:\n${sample(p.conflicts)}`);
    if (p.unresolvedTeachers.length) log(`[WARN] ${p.unresolvedTeachers.length} teacher(s) with no resolvable class, skipped:\n${sample(p.unresolvedTeachers)}`);
    if (p.unresolvedGrades.length) log(`[WARN] ${p.unresolvedGrades.length} grade(s) unresolved, left unpatched:\n${sample(p.unresolvedGrades)}`);
}

// ── MODES ───────────────────────────────────────────────────────────────────
async function apply() {
    const p = await plan();
    printPlan(p);
    if (MODE === 'dry-run') { log('[DONE] dry run — nothing written'); return 0; }

    const writer = db.bulkWriter();
    let failed = 0;
    writer.onWriteError((err) => { failed++; console.error(`[FAIL] ${err.documentRef.path}: ${err.message}`); return false; });
    p.subjectCreates.forEach((s) => writer.create(s.ref, s.data));
    p.assignmentCreates.forEach((a) => writer.create(a.ref, a.data));
    p.gradePatches.forEach((g) => writer.update(g.ref, g.data));
    await writer.close();

    const total = p.subjectCreates.length + p.assignmentCreates.length + p.gradePatches.length;
    log(failed ? `[FAIL] ${failed}/${total} writes failed` : `[DONE] ${total} writes applied. Next: --verify`);
    return failed ? 1 : 0;
}

async function verify() {
    log(`[INFO] mode=verify project=${PROJECT_ID} scope=${SCHOOL || 'ALL schools'}`);
    const teachers = await loadTeachers();
    const problems = [];
    let subjectsOk = 0, asgOk = 0, gradesOk = 0;

    for (const t of teachers) {
        if (!t.subjects.length || !t.classes.length) continue;
        for (const cls of t.classes) {
            const subs = await getClassSubjects(t.schoolId, cls.id);
            for (const legacy of t.subjects) {
                if (!legacy || !legacy.id || !legacy.name) continue;
                const byId = subs.get(legacy.id);
                const byName = [...subs.entries()].find(([, v]) => v.name === legacy.name);
                if (!byId && !byName) { problems.push(`missing subject ${t.schoolId}/${cls.id}/${legacy.id} "${legacy.name}"`); continue; }
                subjectsOk++;
                if (!byId || byId.name !== legacy.name) continue; // shadowed/conflict: assignments not migrated by design
                const asgs = (legacy.assignments || []).filter((a) => a && a.id);
                if (!asgs.length) continue;
                const snaps = await db.getAll(...asgs.map((a) => subjectRef(t.schoolId, cls.id, legacy.id).collection('assignments').doc(a.id)));
                snaps.forEach((s, i) => (s.exists ? asgOk++ : problems.push(`missing assignment ${s.ref.path} "${asgs[i].title || ''}"`)));
            }
        }
    }

    const gSnap = await db.collectionGroup('grades').get();
    const subjectExists = new Map();
    for (const g of gSnap.docs) {
        const d = g.data();
        if (!inScope(d.schoolId)) continue;
        if (!d.subjectId || !d.classId) { problems.push(`grade missing subjectId/classId ${g.ref.path} subject="${d.subject || ''}"`); continue; }
        const key = `${d.schoolId}/${d.classId}/${d.subjectId}`;
        if (!subjectExists.has(key)) subjectExists.set(key, (await subjectRef(d.schoolId, d.classId, d.subjectId).get()).exists);
        if (!subjectExists.get(key)) { problems.push(`grade points at missing subject ${key} ${g.ref.path}`); continue; }
        gradesOk++;
    }

    log(`[PASS] subjects present: ${subjectsOk}`);
    log(`[PASS] assignments present: ${asgOk}`);
    log(`[PASS] grades with valid subjectId+classId: ${gradesOk}`);
    if (problems.length) {
        log(`[FAIL] ${problems.length} problem(s):\n${sample(problems, 25)}`);
        return 1;
    }
    log('[DONE] verify: all PASS');
    return 0;
}

async function cleanup() {
    log(`[INFO] mode=cleanup project=${PROJECT_ID} scope=${SCHOOL || 'ALL schools'}`);
    const writer = db.bulkWriter();
    let subjects = 0, assignments = 0, grades = 0;

    const gSnap = await db.collectionGroup('grades').get();
    for (const g of gSnap.docs) {
        const d = g.data();
        if (!inScope(d.schoolId) || !Array.isArray(d[TAG])) continue;
        const patch = { [TAG]: FieldValue.delete() };
        d[TAG].forEach((f) => { patch[f] = FieldValue.delete(); });
        writer.update(g.ref, patch);
        grades++;
    }

    const schoolIds = SCHOOL ? [SCHOOL] : (await db.collection('schools').get()).docs.map((d) => d.id);
    for (const s of schoolIds) {
        for (const c of await getClasses(s)) {
            const subSnap = await classRef(s, c.id).collection('subjects').get();
            for (const sub of subSnap.docs) {
                const asgSnap = await sub.ref.collection('assignments').where(TAG, '==', true).get();
                asgSnap.docs.forEach((a) => { writer.delete(a.ref); assignments++; });
                if (sub.get(TAG) === true) { writer.delete(sub.ref); subjects++; } // doc only; subcollections untouched
            }
        }
    }

    await writer.close();
    log(`[DONE] rolled back: ${subjects} subject docs, ${assignments} assignment docs, ${grades} grade patches`);
    return 0;
}

const run = MODE === 'verify' ? verify : MODE === 'cleanup' ? cleanup : apply;
run().then((code) => process.exit(code)).catch((e) => {
    console.error(`[FAIL] ${MIG}: ${e.stack || e.message}`);
    process.exit(1);
});
