// Cross-Cutting Regressions, per the "ARCHITECTURAL MANDATE: E2E Test Suite
// (Cross-Cutting Regressions)" — the final section of the QA plan, run
// after Phases 1-15 are all committed. Unlike every prior phase.spec.js,
// this file does not test one page — it tests invariants that are supposed
// to hold ACROSS pages: the semester lock's real boundaries, whether
// several pages' independently-coded bucketing logic actually agrees with
// itself, whether a Gradebook weight change actually reaches every other
// page that displays an average, sidebar nav completeness, and whether a
// forged/bogus URL parameter degrades gracefully instead of crashing.
//
// Covers:
//   X.1 A locked semester blocks grade entry (grade_form, roster's quick-
//       grade shortcut), grade edit/delete and weight changes (gradebook)
//       — but does NOT block preparing/editing assignments or subjects
//       (subjects.js deliberately allows this; see its own "read-only
//       grading, editable prep" notice).
//   X.2 The per-assignment `locked` flag (subjects.js's due-date-style
//       lock, toggled per assignment) is cosmetic only and never blocks
//       grading — only the semester-level `isLocked` does. Also
//       re-confirms, in this cross-cutting context, the standing Phase 7
//       finding (7.7) that attendance.js's save flow never reads
//       activeSem.isLocked at all.
//   X.3 A student sitting at the exact 70% boundary is bucketed
//       identically ("On Track" / "ontrack") by home.js's, roster.js's,
//       and reports.js's three SEPARATELY-CODED threshold implementations
//       (none of the three actually calls the shared standingText()/
//       standingBadge() helpers in utils.js — see each file's own
//       getFilteredSubjectData()/renderClassroomAnalytics()/standing-filter
//       block).
//   X.5 Changing grade weights via the Gradebook's real "Save &
//       Recalculate" flow (saveTeacherWeightingEverywhere) is picked up by
//       the Dashboard's distribution buckets, the Roster's per-student
//       average, and a Reports query — all three re-resolve weighting
//       fresh via resolveGradeWeights() rather than caching a stale value.
//   X.4 The sidebar's nav item list (assets/js/layout-teachers.js) is
//       complete and unchanged: 12 items across Main / Reports & Analytics
//       / System, each with the href this suite's other 15 phases assume.
//   X.6 Deep-link robustness: a bogus subjectId/assignmentId/lessonId in
//       the URL degrades gracefully (silent console.warn + a normal,
//       working picker) rather than crashing — grade_form.html's own
//       applyDeepLinkFromUrl() and lessons/builder.js's init() both guard
//       every param against the real cache before using it.
//
// SOURCE-OF-TRUTH METHODOLOGY (same as every prior phase in this suite):
// every threshold, selector, alert string, and lock check below was read
// directly out of teacher/home/home.js, teacher/roster/roster.js,
// teacher/gradebook/gradebook.js, teacher/grade_form/grade_form.js,
// teacher/subjects/subjects.js, teacher/attendance/attendance.js,
// teacher/reports/reports.js, assets/js/layout-teachers.js,
// assets/js/utils.js, and assets/js/lessons/builder.js — not guessed from
// the mandate's prose.
//
// Requires (see playwright.config.js's header comment):
//   1. Firebase emulators already running (Firestore 8080, Auth 9099,
//      Functions 5001, Database 9000).
//   2. `npm run seed` already run in this folder (or let beforeEach do it).

const { test, expect } = require('@playwright/test');
const {
    seed,
    SEMESTER_ID, SEMESTER_NAME,
    TEACHER_XCUT_ID, TEACHER_XCUT_PIN,
    CLASS_XCUT_ID, CLASS_XCUT_NAME, SUBJECT_XCUT_NAME,
    STUDENT_XCUT_BOUNDARY_ID, STUDENT_XCUT_WEIGHT_ID,
    ASSIGNMENT_XCUT_LOCKED_ID, ASSIGNMENT_XCUT_LOCKED_TITLE,
    setSemesterLocked,
    getTeacherDoc,
    findGradeByAssignment,
    findSubjectDoc,
} = require('./seed');

function forwardBrowserLogs(page) {
    page.on('console', msg => console.log('BROWSER LOG:', msg.text()));
    page.on('pageerror', err => console.log('BROWSER ERROR:', err.message));
}

// Collects every uncaught page error (thrown exception) for the rest of
// this test — the direct signal X.6 needs ("did a bogus URL param crash
// the page") that plain console forwarding doesn't give a return value for.
function capturePageErrors(page) {
    const errors = [];
    page.on('pageerror', err => errors.push(err.message));
    return errors;
}

async function loginAsTeacher(page, teacherId, pin) {
    await page.goto('/teacher/login.html');
    await page.locator('#loginTeacherId').fill(teacherId);
    await page.locator('#loginTeacherCode').fill(pin);
    await page.locator('#loginBtn').click();
    await page.waitForURL(/\/teacher\/home\/home(\.html)?\/?$/, { timeout: 15_000 });
}

async function gotoHome(page) {
    await page.goto('/teacher/home/home.html');
    await expect(page.locator('#analyticsSection')).toBeVisible({ timeout: 15_000 });
}

async function gotoRoster(page) {
    await page.goto('/teacher/roster/roster.html');
    await expect(page.locator('#studentsTableBody tr.trow').first()).toBeVisible({ timeout: 15_000 });
}

async function gotoGradebook(page) {
    await page.goto('/teacher/gradebook/gradebook.html');
    await expect(page.locator('#gradebookTableBody tr.gb-row').first()).toBeVisible({ timeout: 15_000 });
}

async function gotoSubjects(page) {
    await page.goto('/teacher/subjects/subjects.html');
    await expect(page.locator('.subject-tile').first()).toBeVisible({ timeout: 15_000 });
}

async function gotoGradeForm(page) {
    await page.goto('/teacher/grade_form/grade_form.html');
    await expect(page.locator('.gf-subject-btn').first()).toBeVisible({ timeout: 15_000 });
}

async function gotoAttendance(page) {
    await page.goto('/teacher/attendance/attendance.html');
    await expect(page.locator('#attBody')).toBeVisible({ timeout: 15_000 });
    await expect(page.locator('#attBody')).not.toBeEmpty();
}

async function gotoReports(page) {
    await page.goto('/teacher/reports/reports.html');
    await expect(page.locator('#rb-semester-grid input[type="checkbox"]').first()).toBeVisible({ timeout: 15_000 });
}

function rosterRow(page, studentName) {
    return page.locator('#studentsTableBody tr.trow', { hasText: studentName });
}

// Selects the SEMESTER_ID checkbox in the Reports "Term" grid by its
// display name and runs the query with default scope (Class, no
// subject/type filters -> Mode A single-term summary).
async function runReportsClassQuery(page, standingValue) {
    await page.locator('#rb-semester-grid label', { hasText: SEMESTER_NAME }).locator('input[type="checkbox"]').check();
    if (standingValue !== undefined) await page.locator('#rb-standing').selectOption(standingValue);
    await page.locator('#generateReportBtn').click();
    await expect(page.locator('#reportTableBody')).toBeVisible({ timeout: 15_000 });
    await expect(page.locator('#reportOutputMeta')).not.toHaveText('', { timeout: 15_000 });
}

test.describe('Cross-Cutting Regressions', () => {
    test.beforeEach(seed);

    test('X.1 — a locked semester blocks grade entry, editing, deletion, and weight changes, but never blocks preparing assignments or subjects', async ({ page }) => {
        forwardBrowserLogs(page);
        try {
            await setSemesterLocked(SEMESTER_ID, true);

            // Roster: quickGradeStudent()'s shortcut is blocked with an alert
            // and never navigates to grade_form.html.
            await loginAsTeacher(page, TEACHER_XCUT_ID, TEACHER_XCUT_PIN);
            await gotoRoster(page);
            const rosterDialog = page.waitForEvent('dialog');
            await rosterRow(page, 'E2E XCut Boundary Student').locator('.row-btn-grade').click();
            const d1 = await rosterDialog;
            expect(d1.message()).toBe('The current grading period is locked.');
            await d1.accept();
            await expect(page).toHaveURL(/\/teacher\/roster\/roster\.html$/);

            // Grade Form: commitGrade() blocks with its own alert and writes
            // nothing — verified independently via the Admin SDK below.
            await gotoGradeForm(page);
            await page.locator('.gf-subject-btn', { hasText: SUBJECT_XCUT_NAME }).click();
            await page.locator('.gf-asg-btn', { hasText: ASSIGNMENT_XCUT_LOCKED_TITLE }).click();
            await expect(page.locator('#agScore')).toBeVisible();
            await page.locator('#agScore').fill('55');
            const gfDialog = page.waitForEvent('dialog');
            await page.locator('#saveGradeBtn').click();
            const d2 = await gfDialog;
            expect(d2.message()).toBe('This semester is locked. Grades are read-only.');
            await d2.accept();
            expect(await findGradeByAssignment(STUDENT_XCUT_BOUNDARY_ID, ASSIGNMENT_XCUT_LOCKED_ID)).toBeNull();

            // Gradebook: existing grade rows show a lock icon instead of
            // Edit/Delete buttons, and the weight editor refuses to open.
            await gotoGradebook(page);
            await expect(page.locator('.gb-btn-edit')).toHaveCount(0);
            await expect(page.locator('.gb-btn-delete')).toHaveCount(0);
            await expect(page.locator('#gradebookTableBody .fa-lock').first()).toBeVisible();
            const gwDialog = page.waitForEvent('dialog');
            await page.locator('#openGradeWeightsBtn').click();
            const d3 = await gwDialog;
            expect(d3.message()).toBe('The current grading period is locked. Grade weights cannot be changed at this time.');
            await d3.accept();
            await expect(page.locator('#gradeWeightsModal')).toBeHidden();

            // Subjects: grading is read-only (notice shown), but preparing a
            // NEW assignment is explicitly still allowed — the button stays
            // visible and enabled, unlike every gated action above.
            await gotoSubjects(page);
            await page.locator('.subject-tile', { hasText: SUBJECT_XCUT_NAME }).click();
            await page.locator('#spTabAssignments').click();
            await expect(page.locator('text=This period is locked. You can still prepare assignments')).toBeVisible();
            const createBtn = page.locator('button', { hasText: 'Create Assignment / Assessment' });
            await expect(createBtn).toBeVisible();
            await expect(createBtn).toBeEnabled();
        } finally {
            await setSemesterLocked(SEMESTER_ID, false);
        }
    });

    test('X.2 — the per-assignment locked flag never blocks grading, and Attendance saves successfully even while the semester is locked', async ({ page }) => {
        forwardBrowserLogs(page);

        // Part 1 (semester unlocked): the LOCKED assignment's badge is purely
        // cosmetic — grading it succeeds exactly like any other assignment.
        await loginAsTeacher(page, TEACHER_XCUT_ID, TEACHER_XCUT_PIN);
        await gotoGradeForm(page);
        await page.locator('.gf-subject-btn', { hasText: SUBJECT_XCUT_NAME }).click();
        const lockedAsgBtn = page.locator('.gf-asg-btn', { hasText: ASSIGNMENT_XCUT_LOCKED_TITLE });
        await expect(lockedAsgBtn.locator('text=Locked')).toBeVisible();
        await lockedAsgBtn.click();
        await page.locator('#agStudent').selectOption(STUDENT_XCUT_BOUNDARY_ID);
        await page.locator('#agScore').fill('85');
        await page.locator('#saveGradeBtn').click();
        await expect.poll(
            async () => findGradeByAssignment(STUDENT_XCUT_BOUNDARY_ID, ASSIGNMENT_XCUT_LOCKED_ID),
            { timeout: 10_000 }
        ).not.toBeNull();

        // Part 2 (semester locked): re-confirms 7.7 — attendance.js's own
        // save flow never once reads activeSem.isLocked.
        try {
            await setSemesterLocked(SEMESTER_ID, true);
            await gotoAttendance(page);
            await page.locator('#markAllPresentBtn').click();
            await page.locator('#saveAttendanceBtn').click();
            await expect(page.locator('#attSaveMsg')).toContainText('saved', { ignoreCase: true, timeout: 10_000 });
            await expect(page.locator('#attSaveMsg')).not.toContainText('locked', { ignoreCase: true });
        } finally {
            await setSemesterLocked(SEMESTER_ID, false);
        }
    });

    test('X.3 — a student at the exact 70% boundary is bucketed identically on the Dashboard, Roster, and Reports', async ({ page }) => {
        forwardBrowserLogs(page);
        await loginAsTeacher(page, TEACHER_XCUT_ID, TEACHER_XCUT_PIN);

        // Dashboard: home.js's own inline distribution — both fixture
        // students are exactly 70% under the seeded 50/50 rubric, so the
        // "On Track" (70-79%) bucket alone should hold both of them.
        await gotoHome(page);
        await expect(page.locator('#dist-track')).toHaveText('2');
        await expect(page.locator('#dist-excelling')).toHaveText('0');
        await expect(page.locator('#dist-good')).toHaveText('0');
        await expect(page.locator('#dist-attention')).toHaveText('0');
        await expect(page.locator('#dist-risk')).toHaveText('0');

        // Roster: standingLabelHtml()'s own separately-coded thresholds.
        await gotoRoster(page);
        const row = rosterRow(page, 'E2E XCut Boundary Student');
        await expect(row).toHaveAttribute('data-standing', 'ontrack');
        await expect(row.locator('.standing-label')).toHaveText(/On Track/);
        await expect(row.locator('.grade-num')).toHaveText('70%');

        // Reports: the standing FILTER's own separately-coded thresholds —
        // filtering the class scope to "On Track" must include both
        // students (both 70%), proving reports.js's bucketing agrees with
        // home.js's and roster.js's.
        await gotoReports(page);
        await runReportsClassQuery(page, 'ontrack');
        await expect(page.locator('#reportTableBody')).toContainText('E2E XCut Boundary Student');
        await expect(page.locator('#reportTableBody')).toContainText('E2E XCut Weight-Change Student');
        await expect(page.locator('#reportTableBody')).toContainText('70%');
    });

    test('X.5 — changing grade weights in the Gradebook recalculates averages on the Dashboard, Roster, and Reports', async ({ page }) => {
        forwardBrowserLogs(page);
        await loginAsTeacher(page, TEACHER_XCUT_ID, TEACHER_XCUT_PIN);

        // Drive the real Gradebook "Save & Recalculate" flow: Quiz down to
        // 20 first, then Test up to 80 (the modal hard-caps each input at
        // 100 minus the OTHER type's current weight, so this order is the
        // only one that reaches 80/20 without an intermediate clamp).
        await gotoGradebook(page);
        await page.locator('#openGradeWeightsBtn').click();
        await expect(page.locator('#gradeWeightsModal')).toBeVisible();
        await expect(page.locator('#gwTotalWeight')).toContainText('100%');
        const quizInput = page.locator('div', { has: page.locator('span', { hasText: 'Quiz' }) }).locator('input[type="number"]').first();
        const testInput = page.locator('div', { has: page.locator('span', { hasText: 'Test' }) }).locator('input[type="number"]').first();
        await quizInput.fill('20');
        await quizInput.dispatchEvent('input');
        await testInput.fill('80');
        await testInput.dispatchEvent('input');
        await expect(page.locator('#gwTotalWeight')).toContainText('100%');
        await page.locator('#saveGwBtn').click();
        await expect(page.locator('#gradeWeightsModal')).toBeHidden({ timeout: 10_000 });

        await expect.poll(async () => {
            const t = await getTeacherDoc(TEACHER_XCUT_ID);
            const test = (t?.gradeTypes || []).find(g => g.name === 'Test');
            return test?.weight;
        }).toBe(80);

        // Roster: weight student's average jumps from 70% to 88%; boundary
        // student stays at 70% (both types were equal for them).
        await gotoRoster(page);
        await expect(rosterRow(page, 'E2E XCut Weight-Change Student').locator('.grade-num')).toHaveText('88%');
        await expect(rosterRow(page, 'E2E XCut Boundary Student').locator('.grade-num')).toHaveText('70%');

        // Dashboard: the distribution shifts from track:2/good:0 to
        // track:1 (boundary student only) / good:1 (weight student, now
        // in the 80-89% band).
        await gotoHome(page);
        await expect(page.locator('#dist-track')).toHaveText('1');
        await expect(page.locator('#dist-good')).toHaveText('1');

        // Reports: a fresh class-scope single-term query shows the weight
        // student's recalculated 88% in its own independently-computed
        // subject/overall column.
        await gotoReports(page);
        await runReportsClassQuery(page);
        const reportsBody = page.locator('#reportTableBody');
        await expect(reportsBody.locator('tr', { hasText: 'E2E XCut Weight-Change Student' })).toContainText('88%');
        await expect(reportsBody.locator('tr', { hasText: 'E2E XCut Boundary Student' })).toContainText('70%');
    });

    test('X.4 — the sidebar navigation is complete: 12 items across Main, Reports & Analytics, and System', async ({ page }) => {
        forwardBrowserLogs(page);
        await loginAsTeacher(page, TEACHER_XCUT_ID, TEACHER_XCUT_PIN);
        await gotoHome(page);

        const expectedNav = [
            ['nav-overview', '../home/home.html', 'Overview'],
            ['nav-students', '../roster/roster.html', 'My Roster'],
            ['nav-attendance', '../attendance/attendance.html', 'Attendance'],
            ['nav-enter-grade', '../grade_form/grade_form.html', 'Enter Grade'],
            ['nav-subjects', '../subjects/subjects.html', 'Subjects'],
            ['nav-stream', '../stream/stream.html', 'Class Stream'],
            ['nav-gradebook', '../gradebook/gradebook.html', 'Gradebook'],
            ['nav-lessons', '../lessons/builder.html', 'Lesson Builder'],
            ['nav-analytics', '../analytics/analytics.html', 'My Evaluations'],
            ['nav-archives', '../archives/archives.html', 'Archives'],
            ['nav-reports', '../reports/reports.html', 'Reports'],
            ['nav-settings', '../settings/settings.html', 'Settings'],
        ];

        for (const [id, href, label] of expectedNav) {
            const link = page.locator(`#${id}`);
            await expect(link).toBeVisible();
            await expect(link).toHaveAttribute('href', href);
            await expect(link).toContainText(label);
        }

        await expect(page.locator('.sidebar-nav .nav-item')).toHaveCount(expectedNav.length);
        await expect(page.locator('#nav-overview')).toHaveClass(/active/);
    });

    test('X.6 — bogus deep-link IDs degrade gracefully instead of crashing', async ({ page }) => {
        forwardBrowserLogs(page);
        await loginAsTeacher(page, TEACHER_XCUT_ID, TEACHER_XCUT_PIN);

        // grade_form.html: applyDeepLinkFromUrl() only acts on a subjectId
        // that actually matches one of this teacher's active subjects —
        // a bogus one is silently ignored (console.warn only) and the
        // teacher lands on a normal, working subject picker.
        let errors = capturePageErrors(page);
        await page.goto('/teacher/grade_form/grade_form.html?subjectId=bogus-subject-xyz&assignmentId=bogus-assignment-999&studentId=bogus-student-000');
        await expect(page.locator('.gf-subject-btn').first()).toBeVisible({ timeout: 15_000 });
        await expect(page.locator('#subjectPickerSection')).toBeVisible();
        expect(errors).toEqual([]);

        // Same page, a REAL subjectId but a bogus assignmentId: the subject
        // is selected (deep link partially resolves) but the bogus
        // assignment is rejected, landing on the assignment picker rather
        // than a half-initialized grading panel.
        errors = capturePageErrors(page);
        // Resolve the real subject id from Firestore directly rather than
        // guessing the app's generated id format.
        const subDoc = await findSubjectDoc(CLASS_XCUT_ID, SUBJECT_XCUT_NAME);
        await page.goto(`/teacher/grade_form/grade_form.html?subjectId=${subDoc.id}&assignmentId=bogus-assignment-999`);
        await expect(page.locator('.gf-asg-btn').first()).toBeVisible({ timeout: 15_000 });
        await expect(page.locator('#assignmentPickerSection')).toBeVisible();
        expect(errors).toEqual([]);

        // Lesson Builder: init()'s own deep-link guards only apply a
        // urlSubjectId/urlLessonId that actually exists in the current
        // dropdown/cache — bogus values are ignored, landing on the normal
        // lesson picker view instead of throwing on a missing lesson.
        errors = capturePageErrors(page);
        await page.goto('/teacher/lessons/builder.html?subjectId=bogus-subject-xyz&lessonId=bogus-lesson-999');
        await expect(page.locator('#lessonPickerView')).toBeVisible({ timeout: 15_000 });
        expect(errors).toEqual([]);
    });
});
