// Phase 7 of docs/teacher-portal-test-plan.md — Attendance
// (teacher/attendance/attendance.html), per the "ARCHITECTURAL MANDATE:
// Authorize Disk Writes & Advance to Phases 7 & 8".
//
// Covers:
//   7.1  State & Reloading: changing the class dropdown reloads the roster
//        to that class's own students; changing the date picker reloads
//        that date's own saved state (not a stale carry-over from whatever
//        date was open before).
//   7.2  Persistence: "Mark all Present" is not just an in-memory reset —
//        it actually overwrites the full class-day document on Save,
//        including replacing any previously-saved Absent/Tardy statuses.
//   7.3  Persistence: individual per-student status buttons persist their
//        own status (not just whichever button was clicked last).
//   7.5  Edge case: a teacher with zero resolved active classes gets the
//        explicit empty state, never a broken/blank roster.
//   7.7  Edge case / known-issue characterization: unlike grade_form.js,
//        gradebook.js, roster.js and subjects.js — which all read
//        activeSem.isLocked and gate accordingly — attendance.js (both the
//        page and the shared assets/js/attendance.js helper) never
//        references isLocked at all. This test locks the active semester
//        and proves Attendance saves anyway, documenting the CURRENT
//        behavior (a real gap, not a guess) for the QA record rather than
//        asserting what "should" happen.
//
// SOURCE-OF-TRUTH METHODOLOGY (same as every prior phase in this suite):
// every selector and state transition below was read directly out of
// teacher/attendance/attendance.js / attendance.html and the shared
// assets/js/attendance.js helper, not guessed from the QA plan's prose.
//
// ROSTER DEFAULT NOTE: attendance.js defaults every student's in-memory
// status to 'present' whenever no saved record exists for that student on
// that date (`existingDayDoc.records?.[s.id]?.status || 'present'`) — a
// fresh, never-saved date already renders every row as Present. Tests that
// need to prove persistence therefore explicitly move a student to a
// DIFFERENT status first, so the eventual "back to Present" transition (or
// lack of one) is actually observable rather than a no-op.
//
// Requires (see playwright.config.js's header comment):
//   1. Firebase emulators already running.
//   2. `npm run seed` already run in this folder (or let beforeEach do it).

const { test, expect } = require('@playwright/test');
const {
    seed,
    TEACHER_ATTENDANCE_ID, TEACHER_ATTENDANCE_PIN,
    CLASS_ATT_A_NAME, CLASS_ATT_A_ID, CLASS_ATT_B_NAME, CLASS_ATT_B_ID,
    STUDENT_ATT_A1_ID, STUDENT_ATT_A2_ID, STUDENT_ATT_A3_ID, STUDENT_ATT_B1_ID,
    TEACHER_EMPTY_ID, TEACHER_EMPTY_PIN,
    SEMESTER_ID,
    setSemesterLocked,
    getAttendanceDoc,
} = require('./seed');

function forwardBrowserLogs(page) {
    page.on('console', msg => console.log('BROWSER LOG:', msg.text()));
    page.on('pageerror', err => console.log('BROWSER ERROR:', err.message));
}

async function loginAsTeacher(page, teacherId, pin) {
    await page.goto('/teacher/login.html');
    await page.locator('#loginTeacherId').fill(teacherId);
    await page.locator('#loginTeacherCode').fill(pin);
    await page.locator('#loginBtn').click();
    await page.waitForURL(/\/teacher\/home\/home(\.html)?\/?$/, { timeout: 15_000 });
}

async function gotoAttendance(page) {
    await page.goto('/teacher/attendance/attendance.html');
    await expect(page.locator('#attLoader')).toBeHidden({ timeout: 15_000 });
}

function studentRow(page, studentName) {
    return page.locator('#attBody > div', { hasText: studentName });
}

async function setStatus(page, studentName, statusLabel) {
    await studentRow(page, studentName).locator(`button[title="${statusLabel}"]`).click();
}

function ymd(date) {
    return `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, '0')}-${String(date.getDate()).padStart(2, '0')}`;
}

test.describe('Phase 7: Attendance', () => {
    test.beforeEach(seed);

    test('7.1 — Changing the class dropdown or the date reloads the roster/state, never a stale carry-over', async ({ page }) => {
        forwardBrowserLogs(page);
        await loginAsTeacher(page, TEACHER_ATTENDANCE_ID, TEACHER_ATTENDANCE_PIN);
        await gotoAttendance(page);

        // Class A (this teacher's first resolved class) is selected by
        // default, showing only Class A's 3 students.
        await expect(page.locator('#classPicker')).toHaveValue(CLASS_ATT_A_ID);
        await expect(page.locator('#attBody')).toContainText('E2E Attendance Student A1');
        await expect(page.locator('#attBody')).toContainText('E2E Attendance Student A3');
        await expect(page.locator('#attBody')).not.toContainText('E2E Attendance Student B1');

        // Switching to Class B reloads to ONLY Class B's roster.
        await page.locator('#classPicker').selectOption(CLASS_ATT_B_ID);
        await expect(page.locator('#attBody')).toContainText('E2E Attendance Student B1');
        await expect(page.locator('#attBody')).not.toContainText('E2E Attendance Student A1');

        // Mark and save an Absent for B1 on a specific past date, so this
        // test can prove the DATE switch below re-fetches real per-date
        // state rather than resetting everything to the 'present' default.
        const pastDate = ymd(new Date(Date.now() - 5 * 86400000));
        await page.locator('#attDate').fill(pastDate);
        await expect(page.locator('#attLastSaved')).toHaveText('Not yet taken for this date');
        await setStatus(page, 'E2E Attendance Student B1', 'Absent');
        await page.locator('#saveAttendanceBtn').click();
        await expect(page.locator('#attSaveMsg')).toContainText('Attendance saved.', { timeout: 10_000 });

        // Switch to today (a different, never-taken date) — B1 reverts to
        // the fresh-date 'present' default, not the Absent we just saved
        // for pastDate.
        const today = ymd(new Date());
        await page.locator('#attDate').fill(today);
        await expect(page.locator('#attLastSaved')).toHaveText('Not yet taken for this date');
        await expect(studentRow(page, 'E2E Attendance Student B1').locator('button[title="Present"]'))
            .toHaveClass(/bg-emerald-600/);

        // Switch BACK to pastDate — the real saved Absent status for B1
        // reloads correctly, proving the date change actually re-fetches
        // per-date state rather than just clearing/re-defaulting blindly.
        await page.locator('#attDate').fill(pastDate);
        await expect(page.locator('#attLastSaved')).toContainText('Last saved');
        await expect(studentRow(page, 'E2E Attendance Student B1').locator('button[title="Absent"]'))
            .toHaveClass(/bg-red-600/);
    });

    test('7.2 & 7.3 — "Mark all Present" and individual per-student status buttons both persist correctly on Save', async ({ page }) => {
        forwardBrowserLogs(page);
        await loginAsTeacher(page, TEACHER_ATTENDANCE_ID, TEACHER_ATTENDANCE_PIN);
        await gotoAttendance(page);
        await expect(page.locator('#classPicker')).toHaveValue(CLASS_ATT_A_ID);

        const today = ymd(new Date());

        // -- 7.3: three DIFFERENT individual statuses, one per student. -----
        await setStatus(page, 'E2E Attendance Student A1', 'Absent');
        await setStatus(page, 'E2E Attendance Student A2', 'Tardy');
        await setStatus(page, 'E2E Attendance Student A3', 'Excused');
        await page.locator('#saveAttendanceBtn').click();
        await expect(page.locator('#attSaveMsg')).toContainText('Attendance saved.', { timeout: 10_000 });

        let doc = await getAttendanceDoc(CLASS_ATT_A_ID, today);
        expect(doc).not.toBeNull();
        expect(doc.records[STUDENT_ATT_A1_ID].status).toBe('absent');
        expect(doc.records[STUDENT_ATT_A2_ID].status).toBe('tardy');
        expect(doc.records[STUDENT_ATT_A3_ID].status).toBe('excused');
        expect(doc.records[STUDENT_ATT_A1_ID].markedBy).toBe(TEACHER_ATTENDANCE_ID);

        // -- 7.2: "Mark all Present" (in-memory) + Save overwrites the WHOLE
        //    day-doc — the three distinct statuses above are fully replaced,
        //    not merged/left lingering (saveAttendanceForDate() is a setDoc,
        //    never a merge — see assets/js/attendance.js's own comment). ----
        await page.locator('#markAllPresentBtn').click();
        await expect(studentRow(page, 'E2E Attendance Student A1').locator('button[title="Present"]')).toHaveClass(/bg-emerald-600/);
        await expect(studentRow(page, 'E2E Attendance Student A2').locator('button[title="Present"]')).toHaveClass(/bg-emerald-600/);
        await expect(studentRow(page, 'E2E Attendance Student A3').locator('button[title="Present"]')).toHaveClass(/bg-emerald-600/);

        await page.locator('#saveAttendanceBtn').click();
        await expect(page.locator('#attSaveMsg')).toContainText('Attendance saved.', { timeout: 10_000 });

        doc = await getAttendanceDoc(CLASS_ATT_A_ID, today);
        expect(doc.records[STUDENT_ATT_A1_ID].status).toBe('present');
        expect(doc.records[STUDENT_ATT_A2_ID].status).toBe('present');
        expect(doc.records[STUDENT_ATT_A3_ID].status).toBe('present');

        // Reload and re-verify — proves this persisted server-side (a fresh
        // loadAttendanceForDate()), not just optimistic local state.
        await page.reload();
        await expect(page.locator('#attLoader')).toBeHidden({ timeout: 15_000 });
        await expect(page.locator('#attLastSaved')).toContainText('Last saved');
        await expect(studentRow(page, 'E2E Attendance Student A1').locator('button[title="Present"]')).toHaveClass(/bg-emerald-600/);
    });

    test('7.5 — Edge case: a teacher with zero resolved active classes sees the explicit empty state', async ({ page }) => {
        forwardBrowserLogs(page);
        await loginAsTeacher(page, TEACHER_EMPTY_ID, TEACHER_EMPTY_PIN);
        await gotoAttendance(page);

        await expect(page.locator('#attEmpty')).toBeVisible({ timeout: 10_000 });
        await expect(page.locator('#attEmpty')).toContainText('You have no active classes assigned. Contact your administrator to assign classes to your account.');
        await expect(page.locator('#attBody')).toBeHidden();
    });

    test('7.7 — Known-issue characterization: Attendance saves successfully even while the active semester is LOCKED', async ({ page }) => {
        forwardBrowserLogs(page);
        // Every other write-capable teacher page in this app (Grade Entry,
        // Gradebook, Roster, Subjects) reads activeSem.isLocked and blocks.
        // attendance.js never does — confirmed by reading the file, not
        // assumed. This locks the real active semester via the Admin SDK
        // and proves the save still goes through, for the QA record.
        await setSemesterLocked(SEMESTER_ID, true);

        await loginAsTeacher(page, TEACHER_ATTENDANCE_ID, TEACHER_ATTENDANCE_PIN);
        await gotoAttendance(page);

        // No locked-notice banner exists anywhere in attendance.html at all
        // (unlike grade_form.html's #lockedGradeNotice) — nothing even
        // attempts to warn the teacher this semester is locked. The shared
        // topbar's own #topbarLockedBadge (layout-teachers.js) starts with
        // class="hidden" and is only ever un-hidden by a page that
        // explicitly checks isSemesterLocked — attendance.js never does, so
        // it stays hidden here (present in the DOM, just never toggled).
        await expect(page.locator('#topbarLockedBadge')).toHaveClass(/hidden/);

        const today = ymd(new Date());
        await setStatus(page, 'E2E Attendance Student A1', 'Absent');
        await page.locator('#saveAttendanceBtn').click();

        // The save succeeds — no block, no error banner.
        await expect(page.locator('#attSaveMsg')).toContainText('Attendance saved.', { timeout: 10_000 });
        await expect(page.locator('#attSaveMsg')).not.toContainText('locked');

        const doc = await getAttendanceDoc(CLASS_ATT_A_ID, today);
        expect(doc).not.toBeNull();
        expect(doc.records[STUDENT_ATT_A1_ID].status).toBe('absent');
    });
});
