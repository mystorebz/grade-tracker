// Phase 4 of docs/teacher-portal-test-plan.md — Subjects & Classes
// (teacher/subjects/subjects.html), per the "ARCHITECTURAL MANDATE:
// Automated E2E Test Suite (Phases 3 & 4)".
//
// Covers:
//   4.1  Add Subject: validation (missing class, missing name, duplicate
//        name) + a valid submission creates the subject.
//   4.3  Performance tab: class/standing/type/title filters narrow the
//        student-breakdown and filtered-assignments tables correctly.
//   4.5  Add Work (standard): validation (missing title/type/points,
//        points=0, case-insensitive duplicate title) + a valid submission
//        creates a plain (non-assessment) assignment.
//   4.6  Add Work (assessment): Multiple Choice validation (<2 options,
//        no marked correct answer) then a successful save; brief coverage
//        of the other 4 question types' only real requirement (a prompt).
//   4.12 Review Submissions: "N of M submitted"/"N of M graded", the
//        disabled View Answers button for a non-submitter, and the exact
//        ?subjectId=&assignmentId=&studentId= deep link into grade_form.
//   4.2  Destructive — Archive Subject via window.confirm(), on an
//        isolated dynamically-created subject; asserts only
//        {archived, archivedAt} changed.
//   4.11 Destructive — Delete Assignment via window.confirm(), on an
//        isolated dynamically-created assignment; asserts a grade record
//        already on file under that title is untouched.
//
// SOURCE-OF-TRUTH METHODOLOGY (same as phase3-roster.spec.js): every
// selector, validation message, and confirm() string below was read
// directly out of teacher/subjects/subjects.js / subjects.html, not
// guessed from the QA plan's prose. One correction discovered while doing
// that reading is worth flagging up front because it isn't a subjects.js
// bug at all — it's a bug in THIS SUITE'S OWN seed.js that predates this
// file: the grade docs seed.js was writing used field names
// 'subjectName'/'assignmentTitle', but the real schema grade_form.js's
// commitGrade() actually writes (and subjects.js's tile grid / title
// search actually read) is 'subject'/'title'. That mismatch was silent
// through Phase 1-3 because none of those pages read g.subject or g.title
// (only g.score/g.max/g.type, via calculateWeightedAverage). It IS
// load-bearing for this page, so seed.js's grade-doc writer was corrected
// to the real field names before writing this file — see the comments
// at both call sites in seed.js.
//
// DESTRUCTIVE SAFETY: 4.2 and 4.11 never touch the shared SUBJECT_NAME /
// ASSIGNMENT_TITLE fixture (which 4.3 and 4.12 depend on) — each creates
// its own disposable subject/assignment through the real UI first, exactly
// as the mandate requires ("dynamically generated sandbox data that does
// not pollute the primary test environment").
//
// Requires (see playwright.config.js's header comment):
//   1. Firebase emulators already running.
//   2. `npm run seed` already run in this folder (or let beforeEach do it).

const { test, expect } = require('@playwright/test');
const {
    seed,
    TEACHER_ROSTER_ID, TEACHER_ROSTER_PIN,
    TEACHER_EMPTY_ID, TEACHER_EMPTY_PIN,
    CLASS_ROSTER_ID, CLASS_ROSTER_NAME, CLASS_ROSTER_NAME_2,
    STUDENT_ROSTER_A_ID, STUDENT_ROSTER_B_ID,
    SUBJECT_ID, SUBJECT_NAME, ASSIGNMENT_ID, ASSIGNMENT_TITLE,
    findSubjectDoc,
    getGradeDoc,
    setAdHocGrade,
} = require('./seed');

function forwardBrowserLogs(page) {
    page.on('console', msg => console.log('BROWSER LOG:', msg.text()));
    page.on('pageerror', err => console.log('BROWSER ERROR:', err.message));
}

// Same static-server ".html"-stripping tolerance as phase1/phase3 — see
// phase1-login-onboarding.spec.js's header comment for the full rationale.
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

async function gotoSubjects(page) {
    await page.goto('/teacher/subjects/subjects.html');
    // Wait for the initial "Loading subjects…" spinner to resolve one way
    // or the other — either a real tile or the "No subjects yet" empty
    // state — before touching anything in #subjectsGrid.
    await expect(page.locator('#subjectsGrid .fa-spinner')).toHaveCount(0, { timeout: 15_000 });
}

function subjectTile(page, name) {
    return page.locator('.subject-tile', { hasText: name });
}

async function openSubject(page, name) {
    await subjectTile(page, name).click();
    await expect(page.locator('#subjectPanel')).not.toHaveClass(/hidden/, { timeout: 10_000 });
    await expect(page.locator('#spPanelTitle')).toHaveText(name);
}

async function switchTab(page, tab) {
    const ids = { performance: '#spTabPerformance', assignments: '#spTabAssignments', lessons: '#spTabLessons' };
    await page.locator(ids[tab]).click();
}

// Drives the real Add Subject modal end-to-end — used by 4.2 to create an
// isolated, disposable subject rather than touching SUBJECT_NAME.
async function createSubjectViaUI(page, name, className) {
    await page.locator('button', { hasText: 'Add Subject' }).click();
    await expect(page.locator('#subjectFormModal')).not.toHaveClass(/hidden/);
    await page.locator('#subjectFormClass').selectOption({ label: className });
    await page.locator('#subjectFormName').fill(name);
    await page.locator('#saveSubjectFormBtn').click();
    await expect(page.locator('#subjectFormModal')).toHaveClass(/hidden/, { timeout: 10_000 });
    await expect(subjectTile(page, name)).toBeVisible({ timeout: 10_000 });
}

test.describe('Phase 4: Subjects & Classes', () => {
    test.beforeEach(seed);

    test('4.1 — Add Subject: missing class, missing name, and duplicate name are blocked; a valid submission creates it', async ({ page }) => {
        forwardBrowserLogs(page);

        // -- Missing-class branch: TEACHER_EMPTY_ID's only "class" (teacher
        //    doc's classes:['E2E Homeroom']) has no matching real class doc
        //    under schools/{id}/classes anywhere in this fixture set, so
        //    loadTeacherSubjectsCache()'s resolveClassNamesToIds() resolves
        //    it to an EMPTY array (utils.js). openSubjectFormModal() then
        //    disables #subjectFormClass with value="" ("No classes found
        //    for this school") — the one real, reachable way to hit
        //    saveSubject()'s `if (!classId)` branch, unlike Phase 3's Add
        //    Student class field (documented there as unreachable). ------
        await loginAsTeacher(page, TEACHER_EMPTY_ID, TEACHER_EMPTY_PIN);
        await gotoSubjects(page);

        await page.locator('button', { hasText: 'Add Subject' }).click();
        await expect(page.locator('#subjectFormClass')).toBeDisabled();
        await expect(page.locator('#subjectFormClass')).toHaveValue('');
        await page.locator('#subjectFormName').fill('Should Never Save');
        await page.locator('#saveSubjectFormBtn').click();
        await expect(page.locator('#subjectFormMsg')).toBeVisible({ timeout: 5_000 });
        await expect(page.locator('#subjectFormMsg')).toContainText('Please choose a class.');
        // Modal must still be open — nothing was saved.
        await expect(page.locator('#subjectFormModal')).not.toHaveClass(/hidden/);
        await page.locator('button[onclick="closeSubjectFormModal()"]').click();

        // -- Missing-name and duplicate-name branches, plus a valid create,
        //    all under TEACHER_ROSTER_ID (a real, resolvable class). ------
        await loginAsTeacher(page, TEACHER_ROSTER_ID, TEACHER_ROSTER_PIN);
        await gotoSubjects(page);

        await page.locator('button', { hasText: 'Add Subject' }).click();
        await expect(page.locator('#subjectFormClass')).toBeEnabled();
        // Default-selected class is the first of the teacher's resolved
        // classes (CLASS_ROSTER_NAME) — left as-is for this first attempt.
        await page.locator('#subjectFormName').fill('');
        await page.locator('#saveSubjectFormBtn').click();
        await expect(page.locator('#subjectFormMsg')).toBeVisible({ timeout: 5_000 });
        await expect(page.locator('#subjectFormMsg')).toContainText('Subject name is required.');

        // Duplicate name: saveSubject()'s check is `s.name === name` — an
        // EXACT, case-sensitive match (see the Known-Issue Register entry
        // this suite's research already added to the QA plan doc: unlike
        // Add Work's title check, this one is case-sensitive). Using the
        // identical case here is the one guaranteed-reachable collision.
        await page.locator('#subjectFormName').fill(SUBJECT_NAME);
        await page.locator('#saveSubjectFormBtn').click();
        await expect(page.locator('#subjectFormMsg')).toBeVisible({ timeout: 5_000 });
        await expect(page.locator('#subjectFormMsg')).toContainText('Subject already exists.');

        // Valid submission — unique name, explicit class selection (the
        // second class, to prove the select actually drives which class
        // the new subject is created under, not just whichever was
        // pre-selected).
        const newName = `E2E New Subject ${Date.now()}`;
        await page.locator('#subjectFormClass').selectOption({ label: CLASS_ROSTER_NAME_2 });
        await page.locator('#subjectFormName').fill(newName);
        await page.locator('#subjectFormDesc').fill('Created by phase4-subjects.spec.js test 4.1.');
        await page.locator('#saveSubjectFormBtn').click();

        await expect(page.locator('#subjectFormModal')).toHaveClass(/hidden/, { timeout: 10_000 });
        await expect(subjectTile(page, newName)).toBeVisible({ timeout: 10_000 });
    });

    test('4.3 — Performance tab: class, standing, type, and title-search filters narrow both tables correctly', async ({ page }) => {
        forwardBrowserLogs(page);
        await loginAsTeacher(page, TEACHER_ROSTER_ID, TEACHER_ROSTER_PIN);
        await gotoSubjects(page);
        await openSubject(page, SUBJECT_NAME);

        // Baseline: both roster students (A=85% good-standing/submitted,
        // B=55% at-risk/graded) show up with no filters applied.
        await expect(page.locator('#spPanelMeta')).toContainText('2 students', { timeout: 10_000 });
        await expect(page.locator('#subjectPanelBody')).toContainText('2 records');

        // -- Standing filter: exactly 5 real tiers + "All Standings". -----
        const standingOptions = await page.locator('#spFilterStanding option').allTextContents();
        expect(standingOptions).toHaveLength(6);
        expect(standingOptions.join(' ')).toMatch(/Excelling/);
        expect(standingOptions.join(' ')).toMatch(/Good Standing/);
        expect(standingOptions.join(' ')).toMatch(/On Track/);
        expect(standingOptions.join(' ')).toMatch(/Needs Attention/);
        expect(standingOptions.join(' ')).toMatch(/At Risk/);

        await page.locator('#spFilterStanding').selectOption('atrisk');
        await expect(page.locator('#spPanelMeta')).toContainText('1 students');
        await expect(page.locator('#subjectPanelBody')).toContainText('E2E Roster Student Risk');
        await expect(page.locator('#subjectPanelBody')).not.toContainText('E2E Roster Student Good');

        await page.locator('#spFilterStanding').selectOption('good');
        await expect(page.locator('#spPanelMeta')).toContainText('1 students');
        await expect(page.locator('#subjectPanelBody')).toContainText('E2E Roster Student Good');
        await expect(page.locator('#subjectPanelBody')).not.toContainText('E2E Roster Student Risk');

        await page.locator('#spFilterStanding').selectOption('');

        // -- Class filter: 2 classes (from the teacher doc), the second of
        //    which (CLASS_ROSTER_NAME_2) has zero students in this subject
        //    at all. ---------------------------------------------------
        const classOptions = await page.locator('#spFilterClass option').allTextContents();
        expect(classOptions).toEqual(['All Classes', CLASS_ROSTER_NAME, CLASS_ROSTER_NAME_2]);

        await page.locator('#spFilterClass').selectOption(CLASS_ROSTER_NAME_2);
        await expect(page.locator('#spPanelMeta')).toContainText('0 students');
        await expect(page.locator('#subjectPanelBody')).toContainText('No students match filter.');

        await page.locator('#spFilterClass').selectOption('');

        // -- Title search: A's grade is titled 'E2E Roster Seeded
        //    Assignment' (no assignmentId), B's is titled ASSIGNMENT_TITLE
        //    ('E2E Map Quiz', tied to the Review Submissions fixture) — a
        //    partial, case-insensitive search for "map" must isolate B. --
        await page.locator('#spSearchTitle').fill('map');
        await expect(page.locator('#subjectPanelBody')).toContainText('1 record');
        await expect(page.locator('#subjectPanelBody')).toContainText(ASSIGNMENT_TITLE);
        await expect(page.locator('#subjectPanelBody')).not.toContainText('E2E Roster Seeded Assignment');
        await page.locator('#spSearchTitle').fill('');

        // -- Type filter: both grades are type 'Test', so selecting it
        //    keeps both. -----------------------------------------------
        await page.locator('#spFilterType').selectOption('Test');
        await expect(page.locator('#subjectPanelBody')).toContainText('2 records');
    });

    test('4.5 — Add Work (standard): missing title/type/points, points=0, and a case-insensitive duplicate title are all blocked; a valid submission saves', async ({ page }) => {
        forwardBrowserLogs(page);
        await loginAsTeacher(page, TEACHER_ROSTER_ID, TEACHER_ROSTER_PIN);
        await gotoSubjects(page);
        await openSubject(page, SUBJECT_NAME);
        await switchTab(page, 'assignments');

        await page.locator('button', { hasText: 'Create Assignment / Assessment' }).click();
        await expect(page.locator('#addWorkModalOverlay')).not.toHaveClass(/hidden/, { timeout: 10_000 });

        // -- Missing title (type + points valid) --------------------------
        await page.locator('#awType').selectOption({ index: 1 });
        await page.locator('#awPoints').fill('50');
        await page.locator('#awSaveBtn').click();
        await expect(page.locator('#awErrorBanner')).toBeVisible({ timeout: 5_000 });
        await expect(page.locator('#awErrorBannerText')).toContainText('Title is required.');

        // -- Missing type ---------------------------------------------------
        await page.locator('#awTitle').fill('E2E Standard Work Validation Test');
        await page.locator('#awType').selectOption('');
        await page.locator('#awSaveBtn').click();
        await expect(page.locator('#awErrorBannerText')).toContainText('Type is required.');

        // -- Missing points (empty -> NaN) ----------------------------------
        await page.locator('#awType').selectOption({ index: 1 });
        await page.locator('#awPoints').fill('');
        await page.locator('#awSaveBtn').click();
        await expect(page.locator('#awErrorBannerText')).toContainText('Points possible must be a whole number of at least 1.');

        // -- Points = 0 -------------------------------------------------------
        await page.locator('#awPoints').fill('0');
        await page.locator('#awSaveBtn').click();
        await expect(page.locator('#awErrorBannerText')).toContainText('Points possible must be a whole number of at least 1.');

        // -- Duplicate title, case-insensitive: awValidate lowercases both
        //    sides, unlike Subjects' own exact-match check tested in 4.1. -
        await page.locator('#awPoints').fill('50');
        await page.locator('#awTitle').fill(ASSIGNMENT_TITLE.toLowerCase());
        await page.locator('#awSaveBtn').click();
        await expect(page.locator('#awErrorBannerText')).toContainText('An assignment with that title already exists for this subject.');

        // -- Valid submission -------------------------------------------------
        const uniqueTitle = `E2E Standard Work ${Date.now()}`;
        await page.locator('#awTitle').fill(uniqueTitle);
        await page.locator('#awSaveBtn').click();
        await expect(page.locator('#addWorkModalOverlay')).toHaveClass(/hidden/, { timeout: 10_000 });
        await expect(page.locator('#subjectPanelBody')).toContainText(uniqueTitle);
    });

    test('4.6 — Add Work (assessment): Multiple Choice blocks on <2 options and no marked answer, then saves; other question types only require a prompt', async ({ page }) => {
        forwardBrowserLogs(page);
        await loginAsTeacher(page, TEACHER_ROSTER_ID, TEACHER_ROSTER_PIN);
        await gotoSubjects(page);
        await openSubject(page, SUBJECT_NAME);
        await switchTab(page, 'assignments');

        await page.locator('button', { hasText: 'Create Assignment / Assessment' }).click();
        await expect(page.locator('#addWorkModalOverlay')).not.toHaveClass(/hidden/, { timeout: 10_000 });

        const uniqueTitle = `E2E Assessment ${Date.now()}`;
        await page.locator('#awTitle').fill(uniqueTitle);
        await page.locator('#awType').selectOption({ index: 1 });
        await page.locator('#awPoints').fill('100');

        // -- Question 1: Multiple Choice (the default type for a freshly
        //    added question) ------------------------------------------------
        await page.locator('button[data-aw-action="add-question"]').click();
        const q1 = page.locator('#addWorkBuilderContainer > div[data-question-id]').first();
        await q1.locator('textarea[data-field="prompt"]').fill('What is the capital of France?');

        // Fill only ONE of the two default options -> "at least 2" blocks.
        const q1Options = q1.locator('input[data-aw-input="option-text"]');
        await q1Options.nth(0).fill('Paris');
        await page.locator('#awSaveBtn').click();
        await expect(page.locator('#awErrorBanner')).toBeVisible({ timeout: 5_000 });
        await expect(page.locator('#awErrorBannerText')).toContainText('at least 2 non-empty options are required');

        // Fill the second option but still mark no correct answer.
        await q1Options.nth(1).fill('London');
        await page.locator('#awSaveBtn').click();
        await expect(page.locator('#awErrorBannerText')).toContainText('select which option is correct');

        // Mark option A (index 0, "Paris") as correct.
        await q1.locator('input[data-aw-action="set-correct"][data-option-index="0"]').check();

        // -- Questions 2-5: one of each remaining type, each needing only
        //    a prompt (awValidate has no per-type requirement beyond that
        //    for free_response/short_answer/math/attachment_response). ----
        const otherTypes = [
            { value: 'free_response', label: 'Free Response', prompt: 'Describe the water cycle in your own words.' },
            { value: 'short_answer', label: 'Short Answer', prompt: 'Name one noble gas.' },
            { value: 'math', label: 'Math / Equation', prompt: 'Solve for x: 2x + 4 = 10.' },
            { value: 'attachment_response', label: 'Attachment / Draw / Photo Response', prompt: 'Upload a photo of your completed worksheet.' },
        ];
        for (const t of otherTypes) {
            await page.locator('button[data-aw-action="add-question"]').click();
            const card = page.locator('#addWorkBuilderContainer > div[data-question-id]').last();
            await card.locator('select[data-aw-change="question-type"]').selectOption(t.value);
            // Leaving the prompt blank must still block save, generically.
            await page.locator('#awSaveBtn').click();
            await expect(page.locator('#awErrorBannerText')).toContainText('a prompt is required');
            await card.locator('textarea[data-field="prompt"]').fill(t.prompt);
        }

        // attachment_response's own field renders its response-type select.
        const lastCard = page.locator('#addWorkBuilderContainer > div[data-question-id]').last();
        await expect(lastCard.locator('select[data-field="responseType"]')).toBeVisible();

        // -- All 5 questions now valid: save succeeds. -----------------------
        await page.locator('#awSaveBtn').click();
        await expect(page.locator('#addWorkModalOverlay')).toHaveClass(/hidden/, { timeout: 10_000 });
        await expect(page.locator('#subjectPanelBody')).toContainText(uniqueTitle);
    });

    test('4.12 — Review Submissions: "N of M submitted/graded", disabled View Answers for a non-submitter, and the exact grade_form deep link', async ({ page }) => {
        forwardBrowserLogs(page);
        await loginAsTeacher(page, TEACHER_ROSTER_ID, TEACHER_ROSTER_PIN);
        await gotoSubjects(page);
        await openSubject(page, SUBJECT_NAME);
        await switchTab(page, 'assignments');

        // Only one assignment exists under this subject on a fresh seed, so
        // the review button is unambiguous without row-scoping.
        await page.locator('button[title="Review submissions and grade inline"]').click();

        await expect(page.locator('#reviewSubmissionsModal')).not.toHaveClass(/hidden/, { timeout: 10_000 });
        await expect(page.locator('#reviewTitle')).toHaveText(ASSIGNMENT_TITLE);
        await expect(page.locator('#reviewMeta')).toContainText(SUBJECT_NAME);
        await expect(page.locator('#reviewMeta')).toContainText(CLASS_ROSTER_NAME);
        await expect(page.locator('#reviewMeta')).toContainText('out of 100');

        // Only STUDENT_ROSTER_A_ID submitted; only STUDENT_ROSTER_B_ID is
        // graded (via the grade doc seeded with assignmentId=ASSIGNMENT_ID).
        await expect(page.locator('#reviewBody')).toContainText('1 of 2 submitted');
        await expect(page.locator('#reviewBody')).toContainText('1 of 2 graded');

        const rowA = page.locator('#reviewBody >> text=E2E Roster Student Good').locator('xpath=ancestor::div[contains(@class,"rounded-2xl")][1]');
        const rowB = page.locator('#reviewBody >> text=E2E Roster Student Risk').locator('xpath=ancestor::div[contains(@class,"rounded-2xl")][1]');

        // A: submitted, not graded -> View Answers enabled, badge "Not
        // graded", action button reads "Grade" (not "Regrade").
        await expect(rowA.locator('button', { hasText: 'View Answers' })).toBeEnabled();
        await expect(rowA).toContainText('Not graded');
        await expect(rowA).not.toContainText('Regrade');

        // B: graded, not submitted -> View Answers DISABLED, badge shows
        // the real score, action button reads "Regrade".
        await expect(rowB.locator('button', { hasText: 'View Answers' })).toBeDisabled();
        await expect(rowB).toContainText('55/100');
        await expect(rowB.locator('button', { hasText: 'Regrade' })).toBeVisible();
        await expect(rowB).toContainText('Not submitted yet.');

        // View Answers for A shows exactly the seeded submission text (this
        // is a 'standard' category assignment, not an assessment, so
        // renderViewAnswersBody() takes the plain responseText branch).
        await rowA.locator('button', { hasText: 'View Answers' }).click();
        await expect(page.locator('#viewAnswersModal')).not.toHaveClass(/hidden/, { timeout: 10_000 });
        await expect(page.locator('#viewAnswersMeta')).toContainText(ASSIGNMENT_TITLE);
        await expect(page.locator('#viewAnswersBody')).toContainText('E2E seeded submission text.');
        await page.locator('button[onclick="closeViewAnswers()"]').click();

        // Deep link: routeToGrade(studentId) navigates to grade_form.html
        // with exactly {subjectId, assignmentId, studentId} — assert via
        // the URL's real query params rather than a regex on the whole
        // URL, so the static server's ".html"-stripping can't affect it.
        await rowA.locator('button', { hasText: 'Grade' }).click();
        await page.waitForURL(/grade_form/, { timeout: 15_000 });
        const url = new URL(page.url());
        expect(url.searchParams.get('subjectId')).toBe(SUBJECT_ID);
        expect(url.searchParams.get('assignmentId')).toBe(ASSIGNMENT_ID);
        expect(url.searchParams.get('studentId')).toBe(STUDENT_ROSTER_A_ID);
    });

    test('4.2 — Destructive: Archive Subject on an isolated dynamically-created subject only flips {archived, archivedAt}', async ({ page }) => {
        forwardBrowserLogs(page);
        await loginAsTeacher(page, TEACHER_ROSTER_ID, TEACHER_ROSTER_PIN);
        await gotoSubjects(page);

        const disposableName = `E2E Archive Target ${Date.now()}`;
        await createSubjectViaUI(page, disposableName, CLASS_ROSTER_NAME);

        const before = await findSubjectDoc(CLASS_ROSTER_ID, disposableName);
        expect(before).not.toBeNull();
        expect(before.archived).toBe(false);
        expect(before.archivedAt).toBeNull();

        let dialogMessage = null;
        page.once('dialog', async (dialog) => {
            dialogMessage = dialog.message();
            await dialog.accept();
        });
        // archiveSubject()'s button has event.stopPropagation() + opacity-0
        // until the tile is hovered (a group-hover reveal, not a truly
        // hidden control) — force is used here for the same reason
        // phase3-roster.spec.js forces roster row-hover actions.
        await subjectTile(page, disposableName).locator('button[title="Archive subject"]').click({ force: true });

        await expect.poll(() => dialogMessage, { timeout: 5_000 }).toContain(
            `Archive "${disposableName}"? It'll be hidden from this page and moved to Archives, where you can restore it or delete it permanently.`
        );

        // Hidden from the active grid immediately (getActiveSubjects()
        // filters on !archived).
        await expect(subjectTile(page, disposableName)).toHaveCount(0, { timeout: 10_000 });

        const after = await findSubjectDoc(CLASS_ROSTER_ID, disposableName);
        expect(after).not.toBeNull();
        expect(after.id).toBe(before.id);
        expect(after.archived).toBe(true);
        expect(after.archivedAt).not.toBeNull();
        // Everything else on the document is untouched.
        expect(after.name).toBe(before.name);
        expect(after.description).toBe(before.description);
        expect(after.classId).toBe(before.classId);
        expect(after.schoolId).toBe(before.schoolId);
        expect(after.createdAt).toBe(before.createdAt);
    });

    test('4.11 — Destructive: Delete Assignment on an isolated dynamically-created assignment leaves an already-recorded grade untouched', async ({ page }) => {
        forwardBrowserLogs(page);
        await loginAsTeacher(page, TEACHER_ROSTER_ID, TEACHER_ROSTER_PIN);
        await gotoSubjects(page);
        await openSubject(page, SUBJECT_NAME);
        await switchTab(page, 'assignments');

        // Isolated, disposable assignment — deliberately NOT the shared
        // ASSIGNMENT_ID/ASSIGNMENT_TITLE fixture 4.3/4.12 depend on.
        const disposableTitle = `E2E Delete Target ${Date.now()}`;
        await page.locator('button', { hasText: 'Create Assignment / Assessment' }).click();
        await page.locator('#awTitle').fill(disposableTitle);
        await page.locator('#awType').selectOption({ index: 1 });
        await page.locator('#awPoints').fill('10');
        await page.locator('#awSaveBtn').click();
        await expect(page.locator('#addWorkModalOverlay')).toHaveClass(/hidden/, { timeout: 10_000 });
        await expect(page.locator('#subjectPanelBody')).toContainText(disposableTitle);

        // Simulate "a grade already recorded with this title" — exactly
        // the scenario deleteAssignment()'s own confirm() text describes —
        // via the Admin SDK, in the real schema shape (subject/title).
        const gradeDocId = 'tch-e2e-delete-test-grade';
        await setAdHocGrade(STUDENT_ROSTER_A_ID, gradeDocId, {
            subject: SUBJECT_NAME,
            title: disposableTitle,
            type: 'Test',
            score: 8,
            max: 10,
            className: CLASS_ROSTER_NAME,
            semesterId: 'tch-e2e-sem-1',
            teacherId: TEACHER_ROSTER_ID,
            date: new Date().toISOString(),
        });
        const before = await getGradeDoc(STUDENT_ROSTER_A_ID, gradeDocId);
        expect(before).not.toBeNull();

        // Scope to the disposable assignment's own row — the shared
        // ASSIGNMENT_ID fixture is also present in this list (from seed())
        // and has its own "Remove assignment" button, so this can't just
        // be the first match on the page.
        const disposableRow = page.locator('xpath=//p[contains(@class,"font-black") and contains(text(),"' + disposableTitle + '")]/ancestor::div[contains(@class,"hover:bg-slate-50")][1]');

        let dialogMessage = null;
        page.once('dialog', async (dialog) => {
            dialogMessage = dialog.message();
            await dialog.accept();
        });
        await disposableRow.locator('button[title="Remove assignment"]').click();

        await expect.poll(() => dialogMessage, { timeout: 5_000 }).toBe(
            'Remove this prepared assignment? Grades already recorded with this title are not affected.'
        );

        await expect(page.locator('#subjectPanelBody')).not.toContainText(disposableTitle, { timeout: 10_000 });

        // Reload the whole page and re-navigate — proves the delete
        // actually persisted server-side (a fresh loadSubjectsCache()),
        // not just optimistic local state.
        await page.reload();
        await expect(page.locator('#subjectsGrid .fa-spinner')).toHaveCount(0, { timeout: 15_000 });
        await openSubject(page, SUBJECT_NAME);
        await switchTab(page, 'assignments');
        await expect(page.locator('#subjectPanelBody')).not.toContainText(disposableTitle);

        // The grade record recorded under that title is completely
        // untouched — deleteAssignment() only ever calls deleteDoc() on
        // the assignment template itself, never on students/{id}/grades.
        const after = await getGradeDoc(STUDENT_ROSTER_A_ID, gradeDocId);
        expect(after).toEqual(before);
    });
});
