// Phase 13 of docs/teacher-portal-test-plan.md — Archives
// (teacher/archives/archives.html), per the "ARCHITECTURAL MANDATE: E2E
// Test Suite (Phases 13, 14, 15)".
//
// Covers:
//   13.1 UI & State: list composition — archivesStudentCount/archivesSubjCount
//        reflect exactly the records that should show. archives.js's
//        archived-student query is two separate Firestore queries merged
//        client-side, then filtered again in JS to `teacherId ===
//        session.teacherId || !teacherId`, so the fixture deliberately
//        includes an orphan (no teacherId — must still appear), an active
//        student under this same teacher (must NOT appear), and an archived
//        student belonging to a DIFFERENT teacher (must NOT appear) to
//        actually exercise that filter.
//   13.2 UI & State: filterArchivedStudents() — the search box hides/shows
//        `.archive-student-row` elements by a case-insensitive substring
//        match against the row's own textContent.
//   13.8 UI & State: the static Danger Zone messaging.
//   13.4 Restoration: restoreStudent() — sets enrollmentStatus:'Active',
//        archived:false, clears archivedSchoolIds, and the row leaves the
//        archive list on the very next loadArchivesTab() re-fetch (no reload).
//   13.6 Restoration: restoreSubject() — the new-model per-class subject
//        branch (sub._source==='new'): flips archived:false directly on the
//        subject document, and the row leaves the list.
//   13.5 Permanent Deletion (DESTRUCTIVE): permanentDeleteStudent() — real
//        confirm()-gated flow; Cancel leaves the student (and their grades)
//        untouched, Accept deletes the global student doc AND cascade-
//        deletes its grades subcollection (Firestore never does this on
//        its own).
//   13.7 Permanent Deletion (DESTRUCTIVE): permanentDeleteSubject() — same
//        cancel/confirm pattern; Accept deletes the subject doc AND
//        cascade-deletes its assignments subcollection.
//
// All destructive/restore actions here run against STRICTLY DISPOSABLE,
// dedicated Phase 13 fixture data (TEACHER_ARCHIVES_ID's own roster/
// subjects) — never the shared/main fixtures.
//
// SOURCE-OF-TRUTH METHODOLOGY (same as every prior phase in this suite):
// every selector, query shape, and confirm() message string below was read
// directly out of teacher/archives/archives.html and
// teacher/archives/archives.js — not guessed from the mandate's prose.
//
// Requires (see playwright.config.js's header comment):
//   1. Firebase emulators already running (Firestore 8080, Auth 9099,
//      Functions 5001, Database 9000).
//   2. `npm run seed` already run in this folder (or let beforeEach do it).

const { test, expect } = require('@playwright/test');
const {
    seed,
    TEACHER_ARCHIVES_ID, TEACHER_ARCHIVES_PIN,
    CLASS_ARCHIVES_ID,
    SUBJECT_ARCHIVES_RESTORE_ID, SUBJECT_ARCHIVES_RESTORE_NAME,
    SUBJECT_ARCHIVES_DELETE_ID, SUBJECT_ARCHIVES_DELETE_NAME,
    ASSIGNMENT_ARCHIVES_DELETE_ID,
    STUDENT_ARCHIVES_RESTORE_ID,
    STUDENT_ARCHIVES_DELETE_ID,
    getStudentDoc,
    getSubjectDoc,
    getSubjectAssignmentIds,
    getGradeDoc,
} = require('./seed');

const NAME_RESTORE = 'E2E Archives Restore Target';
const NAME_DELETE = 'E2E Archives Delete Target';
const NAME_ZEPHYR = 'E2E Archives Zephyr Ostrowski';
const NAME_QUINCY = 'E2E Archives Quincy Delgado';
const NAME_ORPHAN = 'E2E Archives Orphan Student';
const NAME_ACTIVE_CONTROL = 'E2E Archives Active Control';
const NAME_OTHERTEACHER_CONTROL = 'E2E Archives OtherTeacher Control';

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

async function gotoArchives(page) {
    await page.goto('/teacher/archives/archives.html');
    // loadArchivesTab() replaces the loading spinner with either real rows
    // or an explicit "No archived students." placeholder — waiting for a
    // real row here is safe since every test in this file logs in as
    // TEACHER_ARCHIVES_ID, which always has at least one archived student.
    await expect(page.locator('.archive-student-row').first()).toBeVisible({ timeout: 10_000 });
}

function studentRow(page, name) {
    return page.locator('.archive-student-row', { hasText: name });
}
function subjectRow(page, name) {
    return page.locator('.archive-subj-row', { hasText: name });
}

test.describe('Phase 13: Archives', () => {
    test.beforeEach(seed);

    test('13.1 — list composition: shows archived-and-mine (and orphaned) records, excludes active and other-teacher records', async ({ page }) => {
        forwardBrowserLogs(page);
        await loginAsTeacher(page, TEACHER_ARCHIVES_ID, TEACHER_ARCHIVES_PIN);
        await gotoArchives(page);

        // Students: restore + delete + search A/B + orphan = 5.
        await expect(page.locator('#archivesStudentCount')).toHaveText('5');
        for (const name of [NAME_RESTORE, NAME_DELETE, NAME_ZEPHYR, NAME_QUINCY, NAME_ORPHAN]) {
            await expect(studentRow(page, name)).toHaveCount(1);
        }
        // Negative cases: an active student under this teacher, and an
        // archived student belonging to a DIFFERENT teacher, must both be excluded.
        await expect(studentRow(page, NAME_ACTIVE_CONTROL)).toHaveCount(0);
        await expect(studentRow(page, NAME_OTHERTEACHER_CONTROL)).toHaveCount(0);

        // Subjects: restore + delete = 2, active control excluded.
        await expect(page.locator('#archivesSubjCount')).toHaveText('2');
        await expect(subjectRow(page, SUBJECT_ARCHIVES_RESTORE_NAME)).toHaveCount(1);
        await expect(subjectRow(page, SUBJECT_ARCHIVES_DELETE_NAME)).toHaveCount(1);
        await expect(subjectRow(page, 'E2E Archives Active Subject')).toHaveCount(0);
    });

    test('13.2 — search filters the archived-student list by name, case-insensitively', async ({ page }) => {
        forwardBrowserLogs(page);
        await loginAsTeacher(page, TEACHER_ARCHIVES_ID, TEACHER_ARCHIVES_PIN);
        await gotoArchives(page);

        const search = page.locator('#archiveStudentSearch');

        await search.fill('zephyr'); // lowercase — filterArchivedStudents() lowercases both sides
        await expect(studentRow(page, NAME_ZEPHYR)).toBeVisible();
        await expect(studentRow(page, NAME_QUINCY)).toBeHidden();
        await expect(studentRow(page, NAME_RESTORE)).toBeHidden();

        await search.fill('Quincy');
        await expect(studentRow(page, NAME_QUINCY)).toBeVisible();
        await expect(studentRow(page, NAME_ZEPHYR)).toBeHidden();

        await search.fill('');
        await expect(studentRow(page, NAME_ZEPHYR)).toBeVisible();
        await expect(studentRow(page, NAME_QUINCY)).toBeVisible();
        await expect(studentRow(page, NAME_RESTORE)).toBeVisible();
    });

    test('13.8 — Danger Zone messaging', async ({ page }) => {
        forwardBrowserLogs(page);
        await loginAsTeacher(page, TEACHER_ARCHIVES_ID, TEACHER_ARCHIVES_PIN);
        await gotoArchives(page);

        await expect(page.locator('text=Permanent deletions cannot be undone.')).toBeVisible();
        await expect(page.locator('text=Archive a student first from the Roster, then permanently delete them from Archived Students above.')).toBeVisible();
        await expect(page.locator('text=Archive a subject first from Subjects, then permanently delete it from Archived Subjects above.')).toBeVisible();
    });

    test('13.4 — restoreStudent() reactivates the student and removes them from the archive list', async ({ page }) => {
        forwardBrowserLogs(page);
        await loginAsTeacher(page, TEACHER_ARCHIVES_ID, TEACHER_ARCHIVES_PIN);
        await gotoArchives(page);

        await studentRow(page, NAME_RESTORE).locator('button:has-text("Restore")').click();
        await expect(studentRow(page, NAME_RESTORE)).toHaveCount(0, { timeout: 10_000 });
        await expect(page.locator('#archivesStudentCount')).toHaveText('4');

        const restored = await getStudentDoc(STUDENT_ARCHIVES_RESTORE_ID);
        expect(restored.enrollmentStatus).toBe('Active');
        expect(restored.archived).toBe(false);
    });

    test('13.6 — restoreSubject() (new-model) clears archived and removes it from the archive list', async ({ page }) => {
        forwardBrowserLogs(page);
        await loginAsTeacher(page, TEACHER_ARCHIVES_ID, TEACHER_ARCHIVES_PIN);
        await gotoArchives(page);

        await subjectRow(page, SUBJECT_ARCHIVES_RESTORE_NAME).locator('button:has-text("Restore")').click();
        await expect(subjectRow(page, SUBJECT_ARCHIVES_RESTORE_NAME)).toHaveCount(0, { timeout: 10_000 });
        await expect(page.locator('#archivesSubjCount')).toHaveText('1');

        const restored = await getSubjectDoc(CLASS_ARCHIVES_ID, SUBJECT_ARCHIVES_RESTORE_ID);
        expect(restored.archived).toBe(false);
        expect(restored.archivedAt).toBeNull();
    });

    test('13.5 — permanentDeleteStudent() (DESTRUCTIVE): Cancel leaves data untouched, Accept deletes the student AND cascade-deletes their grades', async ({ page }) => {
        forwardBrowserLogs(page);
        await loginAsTeacher(page, TEACHER_ARCHIVES_ID, TEACHER_ARCHIVES_PIN);
        await gotoArchives(page);

        const row = studentRow(page, NAME_DELETE);
        const deleteBtn = row.locator('button:has-text("Delete")');

        // ── Cancel path: nothing changes ─────────────────────────────────
        let dialogMessage = null;
        page.once('dialog', async d => { dialogMessage = d.message(); await d.dismiss(); });
        await deleteBtn.click();
        await expect.poll(() => dialogMessage, { timeout: 5_000 }).not.toBeNull();
        expect(dialogMessage).toBe(`Permanently delete ${NAME_DELETE} and ALL their grades?\n\nWARNING: This action CANNOT be undone.`);
        await expect(row).toHaveCount(1); // still there
        expect(await getStudentDoc(STUDENT_ARCHIVES_DELETE_ID)).not.toBeNull();

        // ── Confirm path: real deletion + cascade ────────────────────────
        page.once('dialog', d => d.accept());
        await deleteBtn.click();
        await expect(row).toHaveCount(0, { timeout: 10_000 });
        await expect(page.locator('#archivesStudentCount')).toHaveText('4');

        expect(await getStudentDoc(STUDENT_ARCHIVES_DELETE_ID)).toBeNull();
        expect(await getGradeDoc(STUDENT_ARCHIVES_DELETE_ID, 'grd-e2e-archives-delete-1')).toBeNull();
    });

    test('13.7 — permanentDeleteSubject() (DESTRUCTIVE): Cancel leaves data untouched, Accept deletes the subject AND cascade-deletes its assignments', async ({ page }) => {
        forwardBrowserLogs(page);
        await loginAsTeacher(page, TEACHER_ARCHIVES_ID, TEACHER_ARCHIVES_PIN);
        await gotoArchives(page);

        const row = subjectRow(page, SUBJECT_ARCHIVES_DELETE_NAME);
        const deleteBtn = row.locator('button:has-text("Delete")');

        // Precondition: the assignment cascade target actually exists before deletion.
        expect(await getSubjectAssignmentIds(CLASS_ARCHIVES_ID, SUBJECT_ARCHIVES_DELETE_ID)).toContain(ASSIGNMENT_ARCHIVES_DELETE_ID);

        // ── Cancel path ───────────────────────────────────────────────────
        let dialogMessage = null;
        page.once('dialog', async d => { dialogMessage = d.message(); await d.dismiss(); });
        await deleteBtn.click();
        await expect.poll(() => dialogMessage, { timeout: 5_000 }).not.toBeNull();
        expect(dialogMessage).toBe(`Permanently delete "${SUBJECT_ARCHIVES_DELETE_NAME}"?\n\nWARNING: Existing student grades will still reference this subject name text, but the subject will be removed from your curriculum lists entirely.`);
        await expect(row).toHaveCount(1);
        expect(await getSubjectDoc(CLASS_ARCHIVES_ID, SUBJECT_ARCHIVES_DELETE_ID)).not.toBeNull();

        // ── Confirm path: real deletion + cascade ────────────────────────
        page.once('dialog', d => d.accept());
        await deleteBtn.click();
        await expect(row).toHaveCount(0, { timeout: 10_000 });
        await expect(page.locator('#archivesSubjCount')).toHaveText('1');

        expect(await getSubjectDoc(CLASS_ARCHIVES_ID, SUBJECT_ARCHIVES_DELETE_ID)).toBeNull();
        expect(await getSubjectAssignmentIds(CLASS_ARCHIVES_ID, SUBJECT_ARCHIVES_DELETE_ID)).toEqual([]);
    });
});
