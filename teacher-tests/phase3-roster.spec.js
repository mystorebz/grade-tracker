// Phase 3 of docs/teacher-portal-test-plan.md — Roster
// (teacher/roster/roster.html).
//
// Covers test cases 3.1-3.4, 3.6, 3.7, 3.10, 3.12-3.14, 3.17-3.18, 3.20-3.21,
// 3.22, per the "ARCHITECTURAL MANDATE: Automated E2E Test Suite (Phases 3
// & 4)" that commissioned this file.
//
// Every selector, validation message, and Firestore write shape referenced
// below was confirmed by reading the real source (roster.html/roster.js,
// plus the shared assets/js/utils.js and functions/index.js where noted) —
// not assumed from the manual QA plan's wording, which in a couple of
// places (see inline notes) turned out to describe intended-but-not-
// actually-implemented behavior.
//
// Uses its own sandbox teacher/class/roster (TEACHER_ROSTER_ID etc. from
// seed.js) entirely separate from the Phase 1/2 fixtures, so nothing here
// can ever perturb Phase 1/2's exact student/grade/count assertions.
//
// Destructive actions (3.17-3.22) never touch the three static seeded
// students — each such test creates its own disposable student through the
// real Add Student UI at run time (createDisposableStudent() below), per
// the mandate's explicit "dynamically create disposable ... students"
// instruction.
//
// Requires (see playwright.config.js's header comment):
//   1. Firebase emulators already running.
//   2. This file seeds itself (via beforeEach) — no manual `npm run seed`
//      step is required to run just this spec, though it's harmless to do so.

const { test, expect } = require('@playwright/test');
const {
    seed,
    SEMESTER_NAME, SEMESTER_MIDTERM_NAME,
    TEACHER_ROSTER_ID, TEACHER_ROSTER_PIN,
    CLASS_ROSTER_NAME, CLASS_ROSTER_NAME_2, CLASS_ROSTER_NAME_ORPHAN,
    STUDENT_ROSTER_A_ID, STUDENT_ROSTER_B_ID, STUDENT_ROSTER_NO_CLASS_ID,
    getStudentDoc, findNotification,
} = require('./seed');

function forwardBrowserLogs(page) {
    page.on('console', msg => console.log('BROWSER LOG:', msg.text()));
    page.on('pageerror', err => console.log('BROWSER ERROR:', err.message));
}

// See phase1-login-onboarding.spec.js's identical helper for why this
// exists: the local `npx serve` static server redirects *.html requests to
// the extension-less URL, so a literal ".html" in a URL regex never matches
// the browser's real post-navigation URL.
function urlFor(path) {
    const escaped = path.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    return new RegExp(`${escaped}(\\.html)?/?$`);
}

async function loginAsTeacher(page, teacherId, pin) {
    await page.goto('/teacher/login.html');
    await page.locator('#loginTeacherId').fill(teacherId);
    await page.locator('#loginTeacherCode').fill(pin);
    await page.locator('#loginBtn').click();
    await page.waitForURL(urlFor('/teacher/home/home'), { timeout: 15_000 });
}

async function gotoRoster(page) {
    await page.goto('/teacher/roster/roster.html');
    // loadStudents() populates #studentsTableBody asynchronously — wait for
    // at least one seeded row rather than a fixed sleep.
    await expect(page.locator('#studentsTableBody tr.trow').first()).toBeVisible({ timeout: 15_000 });
}

function studentRow(page, name) {
    return page.locator('#studentsTableBody tr.trow', { hasText: name });
}

// Extracts a generated Student ID (format confirmed in functions/index.js:
// /^S\d{2}-[A-Z0-9]{5}$/) from a roster row's full text content, rather than
// depending on the row's exact internal markup.
async function idFromRow(row) {
    const text = await row.textContent();
    const match = text.match(/S\d{2}-[A-Z0-9]{5}/);
    return match ? match[0] : null;
}

// 3.17-3.22's own disposable-student factory — drives the REAL Add Student
// modal (also exercising 3.1-3.4's creation path once per call) rather than
// seeding directly via the Admin SDK, per the mandate's explicit
// instruction that destructive tests must use dynamically-created students,
// never the shared static roster.
async function createDisposableStudent(page, namePrefix) {
    const unique = `${Date.now()}-${Math.random().toString(36).slice(2, 6)}`;
    const name = `${namePrefix} ${unique}`;
    const email = `e2e-disposable-${unique}@example.com`;

    await page.locator('button[onclick="openAddStudentModal()"]').click();
    await expect(page.locator('#addStudentModal')).not.toHaveClass(/hidden/);
    await page.locator('#sName').fill(name);
    await page.locator('#sEmail').fill(email);
    await page.locator('#sClass').selectOption({ label: CLASS_ROSTER_NAME });
    await page.locator('#saveStudentBtn').click();

    const row = studentRow(page, name);
    await expect(row).toBeVisible({ timeout: 15_000 });
    const id = await idFromRow(row);
    return { name, id };
}

test.describe('Phase 3: Roster', () => {
    test.beforeEach(async () => {
        await seed();
    });

    test('3.1-3.4 — Add Student: validation blocks missing/invalid fields; a valid submission (with parent auto-link) creates the student', async ({ page }) => {
        forwardBrowserLogs(page);
        const dialogMessages = [];
        page.on('dialog', async d => { dialogMessages.push(d.message()); await d.accept(); });

        await loginAsTeacher(page, TEACHER_ROSTER_ID, TEACHER_ROSTER_PIN);
        await gotoRoster(page);

        await page.locator('button[onclick="openAddStudentModal()"]').click();
        await expect(page.locator('#addStudentModal')).not.toHaveClass(/hidden/);

        // -- No name --
        await page.locator('#saveStudentBtn').click();
        await expect(page.locator('#addStudentMsg')).toContainText('Student name is required.');

        // -- Name present, no email --
        const name = `E2E Add-Student ${Date.now()}`;
        await page.locator('#sName').fill(name);
        await page.locator('#saveStudentBtn').click();
        await expect(page.locator('#addStudentMsg')).toContainText(
            'Email address is required so the parent can recover their PIN.'
        );

        // -- Invalid email format --
        await page.locator('#sEmail').fill('not-an-email');
        await page.locator('#saveStudentBtn').click();
        await expect(page.locator('#addStudentMsg')).toContainText('Please enter a valid email address.');

        // CONFIRMED AGAINST SOURCE (roster.js's saveStudentBtn click handler):
        // unlike the manual QA plan's assumption ("no class selected while
        // classes exist" is blocked), there is NO validation check on #sClass
        // at all — the field is visually marked required (red *) but the
        // handler happily writes className: '' if nothing is picked. This is
        // a real gap, not a guess; see the Known-Issue Register entry this
        // finding was logged under. Leaving the class unset here deliberately
        // exercises that actual (undocumented) behavior rather than the
        // plan's incorrect expectation of a block.
        const validEmail = `e2e-parent-${Date.now()}@example.com`;
        await page.locator('#sEmail').fill(validEmail);
        await page.locator('#saveStudentBtn').click();

        const row = studentRow(page, name);
        await expect(row).toBeVisible({ timeout: 15_000 });
        const newId = await idFromRow(row);
        expect(newId).toMatch(/^S\d{2}-[A-Z0-9]{5}$/);

        // 3.4 — parent auto-link is awaited synchronously in the same click
        // handler (confirmed: `await linkOrCreateParentFn(...)` runs before
        // the modal closes). Its ONLY observable failure signal is a
        // window.alert() with a specific warning text; success has no
        // separate toast at all. So "no such alert fired" is the correct,
        // fully-observable success signal for this path — asserting on it
        // rather than guessing at an unconfirmed parent-doc field name.
        expect(dialogMessages).not.toContain(
            'The student was created, but linking the parent account failed. Please try again later.'
        );
    });

    test('3.6 — Search and standing/class filters narrow the roster correctly', async ({ page }) => {
        forwardBrowserLogs(page);
        await loginAsTeacher(page, TEACHER_ROSTER_ID, TEACHER_ROSTER_PIN);
        await gotoRoster(page);

        // Class filter wrap is hidden via inline style when a teacher has
        // <=1 class; TEACHER_ROSTER_ID has 2 (CLASS_ROSTER_NAME +
        // CLASS_ROSTER_NAME_2), so it must be visible here.
        await expect(page.locator('#classFilterWrap')).toBeVisible();

        // -- Search: partial name match --
        await page.locator('#searchInput').fill('Risk');
        await expect(studentRow(page, 'E2E Roster Student Risk')).toBeVisible();
        await expect(studentRow(page, 'E2E Roster Student Good')).toBeHidden();
        await page.locator('#searchInput').fill('');

        // -- Standing filter: exact 6-tier value set confirmed against
        //    assets/js/utils.js's standingText() (the QA plan assumed only
        //    5 tiers — 'none' / "No Grades" is a real 6th value). --
        await page.locator('#rf-standing').selectOption('atrisk');
        await expect(page.locator('tr.trow[data-standing="atrisk"]')).toHaveCount(1);
        await expect(studentRow(page, 'E2E Roster Student Risk')).toBeVisible();
        await expect(studentRow(page, 'E2E Roster Student Good')).toBeHidden();

        await page.locator('#rf-standing').selectOption('good');
        await expect(studentRow(page, 'E2E Roster Student Good')).toBeVisible();
        await expect(studentRow(page, 'E2E Roster Student Risk')).toBeHidden();

        await page.locator('#rf-standing').selectOption('none');
        await expect(studentRow(page, 'E2E Roster Student Unassigned')).toBeVisible();
        await expect(studentRow(page, 'E2E Roster Student Good')).toBeHidden();

        await page.locator('#rf-standing').selectOption('');

        // -- Class filter --
        await page.locator('#rf-class').selectOption({ label: CLASS_ROSTER_NAME });
        await expect(studentRow(page, 'E2E Roster Student Good')).toBeVisible();
        await page.locator('#rf-class').selectOption({ label: CLASS_ROSTER_NAME_2 });
        // CLASS_ROSTER_NAME_2 has zero students seeded — every row should hide.
        await expect(studentRow(page, 'E2E Roster Student Good')).toBeHidden();
        await expect(studentRow(page, 'E2E Roster Student Risk')).toBeHidden();
    });

    test('3.7 — Enter Grade quick action deep-links via localStorage, and blocks with an alert for an unclassed student', async ({ page }) => {
        forwardBrowserLogs(page);
        const dialogMessages = [];
        page.on('dialog', async d => { dialogMessages.push(d.message()); await d.accept(); });

        await loginAsTeacher(page, TEACHER_ROSTER_ID, TEACHER_ROSTER_PIN);
        await gotoRoster(page);

        // CONFIRMED AGAINST SOURCE: quickGradeStudent() has NO URL query-
        // string deep link at all (the QA plan's "deep-links correctly into
        // grade_form" wording could be read as implying URL params). The
        // real mechanism is `localStorage.setItem('connectus_quick_grade_
        // student', studentId)` followed by a plain navigation with zero
        // query params — so the assertion here reads localStorage on the
        // destination page instead of the URL.
        await studentRow(page, 'E2E Roster Student Good').locator('.row-btn-grade').click();
        await page.waitForURL(urlFor('/teacher/grade_form/grade_form'), { timeout: 15_000 });
        const stored = await page.evaluate(() => localStorage.getItem('connectus_quick_grade_student'));
        expect(stored).toBe(STUDENT_ROSTER_A_ID);

        // -- Unclassed student: blocked with a window.alert(), exact text
        //    (including the literal blank line) confirmed from source. --
        await gotoRoster(page);
        await studentRow(page, 'E2E Roster Student Unassigned').locator('.row-btn-grade').click();
        await expect.poll(() => dialogMessages.length).toBeGreaterThan(0);
        expect(dialogMessages[dialogMessages.length - 1]).toContain(
            'is not assigned to a class yet.'
        );
        // Must NOT have navigated away from Roster.
        await expect(page).toHaveURL(urlFor('/teacher/roster/roster'));
    });

    test('3.10 — New Evaluation blocks save until every required rating is set, then saves successfully', async ({ page }) => {
        forwardBrowserLogs(page);
        const dialogMessages = [];
        page.on('dialog', async d => { dialogMessages.push(d.message()); await d.accept(); });

        await loginAsTeacher(page, TEACHER_ROSTER_ID, TEACHER_ROSTER_PIN);
        await gotoRoster(page);

        await studentRow(page, 'E2E Roster Student Good').locator('.row-btn-view').click();
        await expect(page.locator('#studentPanel')).not.toHaveClass(/hidden/);
        await page.locator('#tabBtnEvaluations').click();

        const evaluationsBefore = await page.locator('#evaluationsList > *').count();

        await page.locator('button:has-text("New Evaluation")').click();
        await expect(page.locator('#evalModal')).not.toHaveClass(/hidden/);

        await page.locator('#evalType').selectOption('academic');
        await page.locator('#evalSemester').selectOption({ label: SEMESTER_NAME });
        await page.locator('#evalDate').fill('2026-01-15');

        // Fill 5 of the 6 required Academic Progress ratings, deliberately
        // leaving "academicMastery" at 0, to hit the per-type blocking check.
        const ACADEMIC_FIELDS = [
            'academicMastery', 'taskExecution', 'engagement',
            'criticalThinking', 'writtenCommunication', 'oralParticipation',
        ];
        for (const field of ACADEMIC_FIELDS.slice(1)) {
            await page.locator(`.rating-row[data-field="${field}"] .star-btn[data-val="3"]`).click();
        }

        await page.locator('#btnSubmitEval').click();
        await expect.poll(() => dialogMessages.length).toBeGreaterThan(0);
        expect(dialogMessages[dialogMessages.length - 1]).toBe('Please rate all Academic Progress metrics.');
        await expect(page.locator('#evalModal')).not.toHaveClass(/hidden/); // still open

        // Fill the missing rating and save for real.
        await page.locator('.rating-row[data-field="academicMastery"] .star-btn[data-val="4"]').click();
        await page.locator('#btnSubmitEval').click();

        await expect(page.locator('#evalModal')).toHaveClass(/hidden/, { timeout: 10_000 });
        await expect.poll(
            () => page.locator('#evaluationsList > *').count(),
            { timeout: 10_000 }
        ).toBeGreaterThan(evaluationsBefore);
    });

    test('3.12-3.14 — Report Card blocks on incomplete ratings and an unconfigured midterm, then succeeds and triggers print once complete', async ({ page }) => {
        forwardBrowserLogs(page);
        const dialogMessages = [];
        page.on('dialog', async d => { dialogMessages.push(d.message()); await d.accept(); });

        await loginAsTeacher(page, TEACHER_ROSTER_ID, TEACHER_ROSTER_PIN);
        await gotoRoster(page);

        await studentRow(page, 'E2E Roster Student Good').locator('.row-btn-view').click();
        await expect(page.locator('#studentPanel')).not.toHaveClass(/hidden/);
        await page.locator('#tabBtnEvaluations').click();

        await page.locator('button:has-text("Generate Report Card")').click();
        await expect(page.locator('#reportCardModal')).not.toHaveClass(/hidden/);

        // -- 3.12 (partial): incomplete ratings block save on the Term type --
        await page.locator('#rcTypeTerm').click();
        await page.locator('#rcSemester').selectOption({ label: SEMESTER_NAME });
        await page.locator('#btnSaveGenerate').click();
        await expect.poll(() => dialogMessages.length).toBeGreaterThan(0);
        expect(dialogMessages[dialogMessages.length - 1]).toContain(
            'Please complete all ratings before generating the report card.'
        );
        dialogMessages.length = 0;

        // -- 3.13: Midterm type, but SEMESTER_NAME has no midterm configured
        //    -- inline info box, not an alert, then a blocking alert on save. --
        await page.locator('#rcTypeMidterm').click();
        await expect(page.locator('#rcMidtermInfo')).toContainText('No midterm configured for this term');
        await page.locator('#btnSaveGenerate').click();
        await expect.poll(() => dialogMessages.length).toBeGreaterThan(0);
        expect(dialogMessages[dialogMessages.length - 1]).toContain(
            'No midterm has been configured for this term.'
        );
        dialogMessages.length = 0;

        // -- 3.14: switching to the semester that DOES have a midterm window
        //    configured flips the inline info box to the success variant. --
        await page.locator('#rcSemester').selectOption({ label: SEMESTER_MIDTERM_NAME });
        await expect(page.locator('#rcMidtermInfo')).toContainText('will be included');

        // -- 3.12 (complete): back to Term type, fill all 16 ratings, save
        //    for real, and confirm it triggers the print flow. --
        await page.locator('#rcTypeTerm').click();
        await page.locator('#rcSemester').selectOption({ label: SEMESTER_NAME });

        const RC_FIELDS = [
            'characterValues', 'respectCourtesy', 'responsibilityReliability',
            'cooperationTeamwork', 'leadershipInitiative', 'culturalAwareness',
            'behavior', 'organization', 'respectfulness', 'kindness',
            'attitudeWork', 'attitudePeers', 'academicComprehension',
            'effortResilience', 'participation', 'punctualityRating',
        ];
        for (const field of RC_FIELDS) {
            await page.locator(`.rc-rating-row[data-field="${field}"] .star-btn[data-val="4"]`).click();
        }

        // generateFormalReportCardPDF() opens a new window and calls
        // w.print() on IT (not the main page) ~800ms after writing its HTML
        // — confirmed from source. Catch the popup rather than expecting any
        // signal on the main page.
        const [popup] = await Promise.all([
            page.context().waitForEvent('popup', { timeout: 15_000 }),
            page.locator('#btnSaveGenerate').click(),
        ]);
        await popup.waitForLoadState('domcontentloaded');
        await expect.poll(() => popup.title()).toContain('OFFICIAL GRADE REPORT');
        expect(dialogMessages.length).toBe(0); // no validation alert this time
        await popup.close();
    });

    test('3.17-3.18 — Archive (Internal) and Archive (Release/Close Enrollment) on disposable students', async ({ page }) => {
        forwardBrowserLogs(page);
        const dialogMessages = [];
        page.on('dialog', async d => { dialogMessages.push(d.message()); await d.accept(); });

        await loginAsTeacher(page, TEACHER_ROSTER_ID, TEACHER_ROSTER_PIN);
        await gotoRoster(page);

        // -- 3.17: Internal archive --
        const internal = await createDisposableStudent(page, 'E2E Archive Internal');
        await studentRow(page, internal.name).locator('.row-btn-view').click();
        await expect(page.locator('#studentPanel')).not.toHaveClass(/hidden/);
        await page.locator('button:has-text("Archive This Student")').click();
        await expect(page.locator('#archiveModal')).not.toHaveClass(/hidden/);
        // #optArchive is the default-checked radio — no extra fields needed.
        await page.locator('#confirmArchiveBtn').click();
        await expect(studentRow(page, internal.name)).toHaveCount(0, { timeout: 15_000 }); // gone from the Active roster

        const internalDoc = await getStudentDoc(internal.id);
        expect(internalDoc).toBeTruthy();
        expect(internalDoc.enrollmentStatus).toBe('Archived');
        expect(internalDoc.archived).toBe(true);
        expect(internalDoc.currentSchoolId).not.toBe(''); // internal archive keeps the school link (only Release clears it)
        expect(Array.isArray(internalDoc.academicHistory)).toBe(true);
        expect(internalDoc.academicHistory.length).toBeGreaterThan(0);

        // -- 3.18: Release / Close Enrollment --
        await gotoRoster(page);
        const release = await createDisposableStudent(page, 'E2E Archive Release');
        await studentRow(page, release.name).locator('.row-btn-view').click();
        await expect(page.locator('#studentPanel')).not.toHaveClass(/hidden/);
        await page.locator('button:has-text("Archive This Student")').click();
        await expect(page.locator('#archiveModal')).not.toHaveClass(/hidden/);
        await page.locator('#optRelease').check();

        // Departure Reason is required — confirm the block before filling it.
        await page.locator('#confirmArchiveBtn').click();
        await expect.poll(() => dialogMessages.length).toBeGreaterThan(0);
        expect(dialogMessages[dialogMessages.length - 1]).toContain(
            'Please select a departure reason to close enrollment.'
        );
        dialogMessages.length = 0;

        await page.locator('#releaseReason').selectOption('Transferred');
        await page.locator('#confirmArchiveBtn').click();
        await expect(studentRow(page, release.name)).toHaveCount(0, { timeout: 15_000 });

        const releaseDoc = await getStudentDoc(release.id);
        expect(releaseDoc.enrollmentStatus).toBe('Transferred');
        expect(releaseDoc.archived).toBe(true);
        expect(releaseDoc.currentSchoolId).toBe(''); // release clears the school link
        const notification = await findNotification(release.id, 'student_enrollment_closed');
        expect(notification).toBeTruthy();
        expect(notification.reason).toBe('Transferred');
    });

    test('3.20-3.21 — Promote (to a class with no owning teacher) and Promote (Repeat) on disposable students', async ({ page }) => {
        forwardBrowserLogs(page);
        const dialogMessages = [];
        page.on('dialog', async d => { dialogMessages.push(d.message()); await d.accept(); });

        await loginAsTeacher(page, TEACHER_ROSTER_ID, TEACHER_ROSTER_PIN);
        await gotoRoster(page);

        // -- 3.20: promote a disposable student into CLASS_ROSTER_NAME_ORPHAN
        //    -- a real school class assigned to NO teacher at all, so
        //    roster.js's promoteClassTeacherMap can't resolve exactly one
        //    owner and must leave teacherId blank + report it unresolved. --
        const promoted = await createDisposableStudent(page, 'E2E Promote Single');
        await studentRow(page, promoted.name).locator('.row-btn-view').click();
        await expect(page.locator('#studentPanel')).not.toHaveClass(/hidden/);
        await page.locator('button:has-text("Promote / Advance")').click();
        await expect(page.locator('#promoteModal')).not.toHaveClass(/hidden/);

        const promotedRow = page.locator('.promote-row', { hasText: promoted.name });
        await promotedRow.locator('input.promote-check').check();
        await promotedRow.locator('select.promote-dest').selectOption({ label: CLASS_ROSTER_NAME_ORPHAN });
        await page.locator('#confirmPromoteBtn').click();

        await expect.poll(() => dialogMessages.length, { timeout: 15_000 }).toBeGreaterThan(0);
        expect(dialogMessages[dialogMessages.length - 1]).toContain('Promotion complete.');
        expect(dialogMessages[dialogMessages.length - 1]).toContain('could not be auto-assigned to a teacher');
        dialogMessages.length = 0;

        const promotedDoc = await getStudentDoc(promoted.id);
        expect(promotedDoc.className).toBe(CLASS_ROSTER_NAME_ORPHAN);
        expect(promotedDoc.teacherId).toBe(''); // left blank — no single owning teacher for the orphan class
        expect(Array.isArray(promotedDoc.classHistory)).toBe(true);
        expect(promotedDoc.classHistory[promotedDoc.classHistory.length - 1].reason).toBe('Promoted');
        // Promoted OUT of this teacher's roster entirely (teacherId cleared).
        await gotoRoster(page);
        await expect(studentRow(page, promoted.name)).toHaveCount(0, { timeout: 15_000 });

        // -- 3.21: "Repeat" keeps the student in the SAME class/roster --
        const repeated = await createDisposableStudent(page, 'E2E Promote Repeat');
        await studentRow(page, repeated.name).locator('.row-btn-view').click();
        await expect(page.locator('#studentPanel')).not.toHaveClass(/hidden/);
        await page.locator('button:has-text("Promote / Advance")').click();
        await expect(page.locator('#promoteModal')).not.toHaveClass(/hidden/);

        const repeatRow = page.locator('.promote-row', { hasText: repeated.name });
        await repeatRow.locator('input.promote-check').check();
        await repeatRow.locator('select.promote-dest').selectOption('__repeat__');
        await page.locator('#confirmPromoteBtn').click();
        await expect(page.locator('#promoteModal')).toHaveClass(/hidden/, { timeout: 15_000 });

        const repeatedDoc = await getStudentDoc(repeated.id);
        expect(repeatedDoc.className).toBe(CLASS_ROSTER_NAME); // unchanged
        expect(repeatedDoc.classHistory[repeatedDoc.classHistory.length - 1].reason).toBe('Repeated');
        await gotoRoster(page);
        await expect(studentRow(page, repeated.name)).toBeVisible(); // still in this teacher's roster
    });

    test('3.22 — Bulk promotion processes only the ticked students, leaving others untouched', async ({ page }) => {
        forwardBrowserLogs(page);
        const dialogMessages = [];
        page.on('dialog', async d => { dialogMessages.push(d.message()); await d.accept(); });

        await loginAsTeacher(page, TEACHER_ROSTER_ID, TEACHER_ROSTER_PIN);
        await gotoRoster(page);

        const ticked1 = await createDisposableStudent(page, 'E2E Bulk Ticked1');
        await gotoRoster(page);
        const ticked2 = await createDisposableStudent(page, 'E2E Bulk Ticked2');
        await gotoRoster(page);
        const untickedBefore = await getStudentDoc(STUDENT_ROSTER_B_ID); // control — must stay untouched

        // Bulk entry point: roster header "More actions" menu.
        await page.locator('#rosterMoreBtn').click();
        await expect(page.locator('#rosterMoreMenu')).toBeVisible();
        await page.locator('button:has-text("Promote Students")').click();
        await expect(page.locator('#promoteModal')).not.toHaveClass(/hidden/);

        const row1 = page.locator('.promote-row', { hasText: ticked1.name });
        const row2 = page.locator('.promote-row', { hasText: ticked2.name });
        await row1.locator('input.promote-check').check();
        await row1.locator('select.promote-dest').selectOption('__repeat__');
        await row2.locator('input.promote-check').check();
        await row2.locator('select.promote-dest').selectOption({ label: CLASS_ROSTER_NAME_ORPHAN });
        await page.locator('#promoteNote').fill('E2E bulk promotion note');
        // Every other row (including STUDENT_ROSTER_B_ID) stays unchecked.

        await page.locator('#confirmPromoteBtn').click();
        await expect.poll(() => dialogMessages.length, { timeout: 15_000 }).toBeGreaterThan(0); // the "unresolved teacher" summary alert (ticked2's destination)

        const ticked1Doc = await getStudentDoc(ticked1.id);
        const ticked2Doc = await getStudentDoc(ticked2.id);
        expect(ticked1Doc.classHistory[ticked1Doc.classHistory.length - 1].reason).toBe('Repeated');
        expect(ticked1Doc.classHistory[ticked1Doc.classHistory.length - 1].note).toBe('E2E bulk promotion note');
        expect(ticked2Doc.className).toBe(CLASS_ROSTER_NAME_ORPHAN);
        expect(ticked2Doc.classHistory[ticked2Doc.classHistory.length - 1].note).toBe('E2E bulk promotion note');

        // The unticked control student must be completely untouched.
        const untickedAfter = await getStudentDoc(STUDENT_ROSTER_B_ID);
        expect(untickedAfter).toEqual(untickedBefore);
    });
});
