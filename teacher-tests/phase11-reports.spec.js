// Phase 11 of docs/teacher-portal-test-plan.md — Reports / Data Query
// Builder (teacher/reports/reports.html), per the "ARCHITECTURAL MANDATE:
// E2E Test Suite (Phases 11 & 12)".
//
// Covers:
//   11.1 Validation & UI: the on-page report title (#reportOutputTitle) is
//        set fresh on every Generate click from ONLY currentQueryMeta.mode/
//        subMode/scope — never left over from a previous query. This test
//        drives the query builder through all four real title branches in
//        one page session and asserts each replaces the last: 'Term
//        Summary Report' (Mode A single-term) -> 'Multi-Term Comparison'
//        (Mode A multi-term) -> 'Aggregated Class Data' (Mode B/C, class
//        scope) -> 'Student Academic Profile' (Mode B/C, student scope).
//        There is no feature literally named "title mismatch" anywhere in
//        reports.js/reports.html (confirmed by a repo-wide grep) — this is
//        the read of that mandate item that actually maps onto real code.
//   11.2 Validation & UI: scope=student with no student selected blocks
//        with an alert, before any query runs.
//   11.6 Validation & UI: the "Select All" button above each checkbox grid
//        (toggleAllCheckboxes(containerId, true)) checks every checkbox in
//        that grid and applies the checked visual state to each label.
//   11.7 Validation & UI: generating with zero periods selected blocks
//        with an alert — tested in the default 'class' scope so 11.2's
//        student-target check (which runs first in executeIntelligentQuery)
//        never has a chance to fire instead.
//   11.8 Validation & UI: Export Data / Print Official Report both block
//        with an alert when currentQueryResults is empty (scope=student,
//        target = the zero-grades fixture student).
//   11.3 Generation Modes: Mode A (no subjects checked) — both the
//        single-term (Student | Subject columns | Overall) and multi-term
//        (Student | Term columns | Cumulative) table shapes, using the
//        fixture's flat-average grade data (see seed.js's Phase 11 comment
//        for why every average here is a plain arithmetic mean).
//   11.4 Generation Modes: Mode B (subjects checked, no types) — a flat,
//        unfiltered-by-type table; asserted against Mode C below to show
//        the real structural distinction between them (row count / which
//        types appear), since on-page Mode B and Mode C in this app share
//        the same 8-column table shape and differ only in which rows the
//        query includes (the actual grouped-by-type/by-student breakdown
//        lives only in the separate printReport() document, not on-page).
//   11.5 Generation Modes: Mode C (subjects AND types checked) — the same
//        query as 11.4 but with an additional type filter, producing a
//        strictly narrower result set (Quiz rows excluded, only Test rows
//        remain) — the real "Mode B vs Mode C" structural difference this
//        app has on-page.
//
// SOURCE-OF-TRUTH METHODOLOGY (same as every prior phase in this suite):
// every selector, validation order, mode-detection rule, and column shape
// below was read directly out of teacher/reports/reports.html and
// teacher/reports/reports.js (including the full printReport() tail and
// assets/js/utils.js's calculateWeightedAverage()/resolveGradeWeights()) —
// not guessed from the mandate's prose.
//
// Requires (see playwright.config.js's header comment):
//   1. Firebase emulators already running (Firestore 8080, Auth 9099,
//      Functions 5001, Database 9000).
//   2. `npm run seed` already run in this folder (or let beforeEach do it).

const { test, expect } = require('@playwright/test');
const {
    seed,
    TEACHER_REPORTS_ID, TEACHER_REPORTS_PIN,
    SUBJECT_REPORTS_A_NAME,
    STUDENT_REPORTS_1_ID, STUDENT_REPORTS_EMPTY_ID,
    SEMESTER_ID, SEMESTER_MIDTERM_ID,
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

async function gotoReports(page) {
    await page.goto('/teacher/reports/reports.html');
    // populateStaticCheckboxes()/loadSemesters() run inside init(), which is
    // fired from top-level module code with no explicit "ready" signal of
    // its own — waiting for the semester grid to actually contain a
    // checkbox (it starts as a plain "Loading periods..." placeholder <div>
    // with none) is the same reliable proxy every earlier phase in this
    // suite has used for "this page's init() has finished".
    await expect(page.locator('#rb-semester-grid input[type="checkbox"]').first()).toBeVisible({ timeout: 10_000 });
}

// Checkbox `value` attributes: semester grid uses the semester ID, subject
// grid uses the subject name, type grid uses the type string — all three
// confirmed directly from reports.js's three buildCheckbox(...) call sites.
async function checkInGrid(page, gridId, value) {
    await page.locator(`#${gridId} input[type="checkbox"][value="${value}"]`).check();
}

async function setScope(page, scope) {
    await page.locator('#rb-scope').selectOption(scope);
}

async function generateAndWaitForTitle(page, expectedTitle) {
    await page.locator('#generateReportBtn').click();
    await expect(page.locator('#reportOutputTitle')).toHaveText(expectedTitle, { timeout: 10_000 });
}

async function captureAlert(page, action) {
    let message = null;
    page.once('dialog', async d => { message = d.message(); await d.accept(); });
    await action();
    await expect.poll(() => message, { timeout: 5_000 }).not.toBeNull();
    return message;
}

test.describe('Phase 11: Reports / Data Query Builder', () => {
    test.beforeEach(seed);

    test('11.1 — the report title is set fresh on every Generate, never stale from a previous query', async ({ page }) => {
        forwardBrowserLogs(page);
        await loginAsTeacher(page, TEACHER_REPORTS_ID, TEACHER_REPORTS_PIN);
        await gotoReports(page);

        // Q1: Mode A, single term -> 'Term Summary Report'.
        await checkInGrid(page, 'rb-semester-grid', SEMESTER_ID);
        await generateAndWaitForTitle(page, 'Term Summary Report');

        // Q2: Mode A, both terms selected -> 'Multi-Term Comparison'
        // (must overwrite Q1's title, not append to it).
        await checkInGrid(page, 'rb-semester-grid', SEMESTER_MIDTERM_ID);
        await generateAndWaitForTitle(page, 'Multi-Term Comparison');

        // Q3: Mode B (a subject checked, no types), class scope ->
        // 'Aggregated Class Data' (must overwrite Q2's title).
        await checkInGrid(page, 'rb-subject-grid', SUBJECT_REPORTS_A_NAME);
        await generateAndWaitForTitle(page, 'Aggregated Class Data');

        // Q4: same Mode B query, but scope switched to an individual
        // student -> 'Student Academic Profile' (must overwrite Q3's
        // title — this is the real "on-page title" branch; printReport()'s
        // OWN separate reportTitle variable would say 'Student Academic
        // Report' for this same query, which is a different string in a
        // different place, not a bug in the on-page title tested here).
        await setScope(page, 'student');
        await page.locator('#rb-student').selectOption(STUDENT_REPORTS_1_ID);
        await generateAndWaitForTitle(page, 'Student Academic Profile');
    });

    test('11.2 — scope=student with no student selected blocks with an alert', async ({ page }) => {
        forwardBrowserLogs(page);
        await loginAsTeacher(page, TEACHER_REPORTS_ID, TEACHER_REPORTS_PIN);
        await gotoReports(page);

        await setScope(page, 'student');
        await checkInGrid(page, 'rb-semester-grid', SEMESTER_ID);

        const message = await captureAlert(page, () => page.locator('#generateReportBtn').click());
        expect(message).toBe('Please select a target student to generate an individual report.');

        // Nothing rendered — the results area must still be hidden.
        await expect(page.locator('#reportResultsArea')).toHaveClass(/hidden/);
    });

    test('11.6 — "Select All" checks every checkbox in its grid and applies the checked visual state', async ({ page }) => {
        forwardBrowserLogs(page);
        await loginAsTeacher(page, TEACHER_REPORTS_ID, TEACHER_REPORTS_PIN);
        await gotoReports(page);

        // Three "Select All" buttons in document order: periods, subjects, types.
        const selectAllButtons = page.locator('button:has-text("Select All")');
        await expect(selectAllButtons).toHaveCount(3);

        await selectAllButtons.nth(1).click(); // Subjects grid — this fixture teacher has exactly 2.
        const subjectCheckboxes = page.locator('#rb-subject-grid input[type="checkbox"]');
        await expect(subjectCheckboxes).toHaveCount(2);
        const count = await subjectCheckboxes.count();
        for (let i = 0; i < count; i++) {
            await expect(subjectCheckboxes.nth(i)).toBeChecked();
            // Each checkbox's own <label> parent gets the checked visual
            // state (buildCheckbox()'s markup: <label id="wrap-..."><input>...</label>).
            const wrapClass = await subjectCheckboxes.nth(i).locator('xpath=..').getAttribute('class');
            expect(wrapClass).toContain('bg-[#eef4ff]');
        }
    });

    test('11.7 — generating with zero periods selected blocks with an alert (class scope)', async ({ page }) => {
        forwardBrowserLogs(page);
        await loginAsTeacher(page, TEACHER_REPORTS_ID, TEACHER_REPORTS_PIN);
        await gotoReports(page);

        // Default scope is 'class' — leaves 11.2's own check with nothing
        // to trip, so this is exercising only the period-count check.
        const message = await captureAlert(page, () => page.locator('#generateReportBtn').click());
        expect(message).toBe('Please select at least one Term to generate a report.');
    });

    test('11.8 — Export Data and Print Official Report both block when the query returned zero results', async ({ page }) => {
        forwardBrowserLogs(page);
        await loginAsTeacher(page, TEACHER_REPORTS_ID, TEACHER_REPORTS_PIN);
        await gotoReports(page);

        await setScope(page, 'student');
        await page.locator('#rb-student').selectOption(STUDENT_REPORTS_EMPTY_ID);
        await checkInGrid(page, 'rb-semester-grid', SEMESTER_ID);
        await generateAndWaitForTitle(page, 'Term Summary Report');

        // The zero-grades fixture student -> 0 filtered grades either way.
        await expect(page.locator('#resCount')).toHaveText('0 students');

        const exportMessage = await captureAlert(page, () => page.locator('button:has-text("Export Data")').click());
        expect(exportMessage).toBe('No data to export.');

        const printMessage = await captureAlert(page, () => page.locator('button:has-text("Print Official Report")').click());
        expect(printMessage).toBe('No data to print.');
    });

    test('11.3 — Mode A: single-term (Student | Subject columns | Overall) and multi-term (Student | Term columns | Cumulative)', async ({ page }) => {
        forwardBrowserLogs(page);
        await loginAsTeacher(page, TEACHER_REPORTS_ID, TEACHER_REPORTS_PIN);
        await gotoReports(page);

        // ── Single-term ──────────────────────────────────────────────────
        await checkInGrid(page, 'rb-semester-grid', SEMESTER_ID);
        await generateAndWaitForTitle(page, 'Term Summary Report');

        await expect(page.locator('#resCount')).toHaveText('2 students');
        await expect(page.locator('#resAvg')).toContainText('79');
        await expect(page.locator('#resHigh')).toContainText('80');
        await expect(page.locator('#resLow')).toContainText('78');

        // Subject columns sorted alphabetically: English before Math.
        const headCells = page.locator('#reportResultsArea table thead th');
        await expect(headCells).toHaveCount(4); // Student, English, Math, Overall
        await expect(headCells.nth(1)).toContainText('English');
        await expect(headCells.nth(2)).toContainText('Math');
        await expect(headCells.nth(3)).toContainText('Overall');

        const rows = page.locator('#reportTableBody tr');
        await expect(rows).toHaveCount(2);
        const rowOne = rows.filter({ hasText: 'Student One' });
        await expect(rowOne.locator('td').nth(1)).toContainText('70%'); // English
        await expect(rowOne.locator('td').nth(2)).toContainText('85%'); // Math
        await expect(rowOne.locator('td').nth(3)).toContainText('78%'); // Overall
        const rowTwo = rows.filter({ hasText: 'Student Two' });
        await expect(rowTwo.locator('td').nth(1)).toContainText('100%'); // English
        await expect(rowTwo.locator('td').nth(2)).toContainText('60%');  // Math
        await expect(rowTwo.locator('td').nth(3)).toContainText('80%'); // Overall

        // ── Multi-term (add the second period) ──────────────────────────
        await checkInGrid(page, 'rb-semester-grid', SEMESTER_MIDTERM_ID);
        await generateAndWaitForTitle(page, 'Multi-Term Comparison');

        const multiHeadCells = page.locator('#reportResultsArea table thead th');
        await expect(multiHeadCells).toHaveCount(4); // Student, Term1, Term2, Cumulative

        const multiRows = page.locator('#reportTableBody tr');
        await expect(multiRows).toHaveCount(2);
        const multiRowOne = multiRows.filter({ hasText: 'Student One' });
        await expect(multiRowOne.locator('td').nth(1)).toContainText('78%'); // Sem 1
        await expect(multiRowOne.locator('td').nth(2)).toContainText('85%'); // Sem 2
        await expect(multiRowOne.locator('td').nth(3)).toContainText('82%'); // Cumulative
        const multiRowTwo = multiRows.filter({ hasText: 'Student Two' });
        await expect(multiRowTwo.locator('td').nth(1)).toContainText('80%'); // Sem 1
        await expect(multiRowTwo.locator('td').nth(2)).toContainText('75%'); // Sem 2
        await expect(multiRowTwo.locator('td').nth(3)).toContainText('78%'); // Cumulative
    });

    test('11.4 — Mode B: subjects checked, no types, includes every type for that subject', async ({ page }) => {
        forwardBrowserLogs(page);
        await loginAsTeacher(page, TEACHER_REPORTS_ID, TEACHER_REPORTS_PIN);
        await gotoReports(page);

        await checkInGrid(page, 'rb-semester-grid', SEMESTER_ID);
        await checkInGrid(page, 'rb-subject-grid', SUBJECT_REPORTS_A_NAME);
        await generateAndWaitForTitle(page, 'Aggregated Class Data');

        // Math, semester 1: Student One Test(80%)+Quiz(90%), Student Two
        // Test(60%) -> 3 rows, both Test and Quiz types present.
        await expect(page.locator('#resCount')).toHaveText('3');
        const headCells = page.locator('#reportResultsArea table thead th');
        await expect(headCells).toHaveCount(8); // Date/Student/Subject/Assignment/Type/Weight/Score/%

        const rows = page.locator('#reportTableBody tr');
        await expect(rows).toHaveCount(3);
        await expect(rows.filter({ hasText: 'Quiz' })).toHaveCount(1);
        await expect(rows.filter({ hasText: 'Test' })).toHaveCount(2);
        // Weight column is always '—' for this fixture (no teaching_assignments/legacy weighting).
        await expect(rows.first().locator('td').nth(5)).toHaveText('—');
    });

    test('11.5 — Mode C: subjects AND types checked, strictly narrower than Mode B', async ({ page }) => {
        forwardBrowserLogs(page);
        await loginAsTeacher(page, TEACHER_REPORTS_ID, TEACHER_REPORTS_PIN);
        await gotoReports(page);

        await checkInGrid(page, 'rb-semester-grid', SEMESTER_ID);
        await checkInGrid(page, 'rb-subject-grid', SUBJECT_REPORTS_A_NAME);
        await checkInGrid(page, 'rb-type-grid', 'Test');
        await generateAndWaitForTitle(page, 'Aggregated Class Data');

        // Same subject+period as 11.4, but Type=Test only -> the Quiz row
        // is excluded, leaving 2 rows instead of 11.4's 3 — the real
        // structural difference between Mode B and Mode C on this page.
        await expect(page.locator('#resCount')).toHaveText('2');
        const rows = page.locator('#reportTableBody tr');
        await expect(rows).toHaveCount(2);
        await expect(rows.filter({ hasText: 'Quiz' })).toHaveCount(0);
        await expect(rows.filter({ hasText: 'Test' })).toHaveCount(2);
    });
});
