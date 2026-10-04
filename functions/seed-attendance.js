#!/usr/bin/env node
'use strict';
/**
 * functions/seed-attendance.js — school-day attendance for QA Class 1 (LIVE dev project)
 *
 *   node seed-attendance.js          last 20 school days (Mon–Fri), ending today
 *   node seed-attendance.js 30       last 30 school days
 *
 * Writes schools/QA-SCHOOL-01/classes/QA-CLASS-01/attendance/{YYYY-MM-DD}, same
 * shape as assets/js/attendance.js saveAttendanceForDate(). The deployed
 * onAttendanceSaved trigger fans each day out to students/{id}/attendance/{date}.
 * Statuses: present ~85%, tardy ~7%, absent ~6%, excused ~2%.
 * Re-runs overwrite seeded days; days marked by hand in the app are skipped.
 * Target: dev-school-grade-tracker ONLY. Auth: Application Default Credentials.
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
const { getFirestore } = require('firebase-admin/firestore');

const app = initializeApp({ projectId: PROJECT_ID, credential: applicationDefault() }, 'qa-attendance');
const db = getFirestore(app);

const SCHOOL = 'QA-SCHOOL-01';
const CLASS_ID = 'QA-CLASS-01';
const CLASS_NAME = 'QA Class 1';
const TEACHER = 'T99-QA001';
const DAYS = Math.max(1, parseInt(process.argv[2], 10) || 20);
const TAG = Object.freeze({ _qaSeed: true, _seededBy: 'functions/seed-attendance.js' });

const classRef = db.collection('schools').doc(SCHOOL).collection('classes').doc(CLASS_ID);

const pad = (n) => String(n).padStart(2, '0');
const ymd = (d) => `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`; // local date, like the app's date input

function lastSchoolDays(n) {
    const out = [];
    const d = new Date();
    while (out.length < n) {
        const dow = d.getDay();
        if (dow !== 0 && dow !== 6) out.push(ymd(d));
        d.setDate(d.getDate() - 1);
    }
    return out.reverse();
}

function randomStatus() {
    const r = Math.random();
    if (r < 0.85) return 'present';
    if (r < 0.92) return 'tardy';
    if (r < 0.98) return 'absent';
    return 'excused';
}

async function main() {
    if (!(await classRef.get()).exists) throw new Error(`${classRef.path} not found. Run: node seed-test-accounts.js`);

    const snap = await db.collection('students')
        .where('currentSchoolId', '==', SCHOOL)
        .where('enrollmentStatus', '==', 'Active')
        .get();
    const students = snap.docs
        .map((d) => ({ id: d.id, ...d.data() }))
        .filter((s) => s.classId === CLASS_ID || s.className === CLASS_NAME);
    if (!students.length) throw new Error(`No active students in ${CLASS_NAME}.`);

    const dates = lastSchoolDays(DAYS);
    const existing = await db.getAll(...dates.map((dt) => classRef.collection('attendance').doc(dt)));
    const manual = new Set(existing.filter((s) => s.exists && s.get('_qaSeed') !== true).map((s) => s.id));

    const totals = Object.fromEntries(students.map((s) => [s.id, { present: 0, tardy: 0, absent: 0, excused: 0 }]));
    const batch = db.batch();
    let written = 0;

    for (const date of dates) {
        if (manual.has(date)) { console.log(`[SKIP] ${date} marked by hand in the app`); continue; }
        const markedAt = new Date(`${date}T08:15:00`).toISOString();
        const records = {};
        for (const s of students) {
            const status = randomStatus();
            records[s.id] = { status, markedAt, markedBy: TEACHER };
            totals[s.id][status]++;
        }
        batch.set(classRef.collection('attendance').doc(date), {
            ...TAG, date, classId: CLASS_ID, records, updatedAt: markedAt, updatedBy: TEACHER,
        });
        written++;
    }

    await batch.commit();

    console.log(`[OK]   ${written} school days written: ${dates[0]} .. ${dates[dates.length - 1]}`);
    console.log('       student                 present  tardy  absent  excused');
    for (const s of students) {
        const t = totals[s.id];
        console.log(`       ${(s.name || s.id).padEnd(22)}  ${String(t.present).padStart(7)}  ${String(t.tardy).padStart(5)}  ${String(t.absent).padStart(6)}  ${String(t.excused).padStart(7)}`);
    }
    console.log('[DONE] onAttendanceSaved copies each day to every student\'s record within a few seconds.');
}

main().then(() => process.exit(0)).catch((e) => {
    console.error(`[FAIL] ${e.message}`);
    process.exit(1);
});
