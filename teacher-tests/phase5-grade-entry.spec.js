// Phase 5 of docs/teacher-portal-test-plan.md — Grade Entry
// (teacher/grade_form/grade_form.html), per the "ARCHITECTURAL MANDATE:
// Commit & Advance to Phases 5 & 6".
//
// Covers:
//   5.1  Standard & Manual Flows: the 3-step router (subject -> assignment
//        -> grading panel), both the "real prepared assignment" branch and
//        the "type one manually" branch, plus "Change subject" / "Switch /
//        Reset" navigating back.
//   5.2  Manual entry -> "Post to Class" converts a typed-in-place entry
//        into a real, persisted assignment template (ensureAssignmentDoc())
//        with NO grade written for anyone.
//   5.4  Granular scoring: a real Add Work assessment's multiple_choice
//        question pre-fills its own score from the server-computed
//        objectiveAutoGrade, and the read-only #agScore total recomputes
//        live as the free-response question is graded.
//   5.5  Request Revision: checking a question's toggle and committing
//        flips the live submission's status to 'revision_requested';
//        unchecking and re-committing flips it back to 'graded' while the
//        revision record itself is preserved (never deleted), just
//        requested:false.
//   5.6  Score bounds: live clamping of #agScore to [0, max] with the exact
//        hint text, plus a hard, blocking alert at submit time for an
//        empty/invalid score (commitGrade()'s own isNaN guard).
//   5.7  "Commit & Next" wraparound: grading the LAST-listed student in the
//        roster advances back to the FIRST-listed one (true circular/modulo
//        search, not just "stop at the end of the list").
//
// SOURCE-OF-TRUTH METHODOLOGY (same as phase3/phase4): every selector,
// validation message, and state transition below was read directly out of
// teacher/grade_form/grade_form.js / grade_form.html, not guessed from the
// QA plan's prose.
//
// ROSTER ORDER NOTE: grade_form.js's loadStudents() sorts teacherStudents
// alphabetically by name client-side (Array.prototype.sort + localeCompare)
// — NOT by Firestore's own (unordered) enumeration — so this sandbox's
// roster order is technically deterministic. 5.7 still reads the actual
// rendered DOM order at runtime rather than hard-coding that assumption, in
// case that sort or these fixtures' names ever change.
//
// SANDBOX NOTE: TEACHER_GRADE_ID's roster has 4 active students, not 3 —
// STUDENT_GRADE_DELETE_ID (seed.js's disposable Phase 6 delete-flow
// fixture) shares this same class/teacher, so it legitimately shows up
// here too as a 4th, permanently-ungraded-in-this-suite roster entry. Every
// test below is written to work regardless of which/how-many students are
// "ungraded" at any given moment, rather than assuming exactly 3.
//
// DESTRUCTIVE SAFETY: nothing here touches STUDENT_GRADE_DELETE_ID or the
// Phase 6 gradebook fixtures (GRADEBOOK_EDIT_GRADE_ID /
// GRADEBOOK_DELETE_GRADE_ID) — this file only ever grades
// STUDENT_GRADE_1_ID (for the assessment tests) or whichever student
// happens to render last in the roster (5.7, on the STANDARD assignment,
// which no other test in this file also grades).
//
// Requires (see playwright.config.js's header comment):
//   1. Firebase emulators already running.
//   2. `npm run seed` already run in this folder (or let beforeEach do it).

const { test, expect } = require('@playwright/test');
const {
    seed,
    TEACHER_GRADE_ID, TEACHER_GRADE_PIN,
    CLASS_GRADE_ID, SUBJECT_GRADE_ID, SUBJECT_GRADE_NAME,
    STUDENT_GRADE_1_ID,
    ASSIGNMENT_STANDARD_TITLE,
    ASSIGNMENT_ASSESS_ID, ASSIGNMENT_ASSESS_TITLE,
    QUESTION_MC_ID, QUESTION_FR_ID,
    findAssignmentDoc,
    getSubmissionDoc,
    findGradeByAssignment,
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

async function gotoGradeForm(page) {
    await page.goto('/teacher/grade_form/grade_form.html');
    // Wait for the initial "Loading subjects…" spinner to resolve before
    // touching the subject picker.
    await expect(page.locator('#subjectPickerList .fa-spinner')).toHaveCount(0, { timeout: 15_000 });
}

function subjectBtn(page, name) {
    return page.locator('.gf-subject-btn', { hasText: name });
}
function assignmentBtn(page, name) {
    return page.locator('.gf-asg-btn', { hasText: name });
}
function rosterBtn(page, studentName) {
    return page.locator('#gfRosterList button', { hasText: studentName });
}

async function selectSubjectUI(page, name) {
    await subjectBtn(page, name).click();
    await expect(page.locator('#assignmentPickerSection')).not.toHaveClass(/hidden/, { timeout: 10_000 });
}

test.describe('Phase 5: Grade Entry', () => {
    test.beforeEach(seed);

    test('5.1 — 3-step routing: subject -> assignment (real or manual) -> grading panel, with back-navigation at each step', async ({ page }) => {
        forwardBrowserLogs(page);
        await loginAsTeacher(page, TEACHER_GRADE_ID, TEACHER_GRADE_PIN);
        await gotoGradeForm(page);

        // -- Step 1 only, initially. --------------------------------------
        await expect(page.locator('#subjectPickerSection')).not.toHaveClass(/hidden/);
        await expect(page.locator('#assignmentPickerSection')).toHaveClass(/hidden/);
        await expect(page.locator('#gradingSection')).toHaveClass(/hidden/);

        // -- Step 1 -> 2. ----------------------------------------------------
        await selectSubjectUI(page, SUBJECT_GRADE_NAME);
        await expect(page.locator('#subjectPickerSection')).toHaveClass(/hidden/);
        await expect(page.locator('#gradingSection')).toHaveClass(/hidden/);
        await expect(page.locator('#assignmentPickerSubject')).toHaveText(SUBJECT_GRADE_NAME);

        // "Change subject" returns to step 1.
        await page.locator('button', { hasText: 'Change subject' }).click();
        await expect(page.locator('#subjectPickerSection')).not.toHaveClass(/hidden/);
        await expect(page.locator('#assignmentPickerSection')).toHaveClass(/hidden/);

        // -- Step 1 -> 2 -> 3, via a REAL prepared assignment. ---------------
        await selectSubjectUI(page, SUBJECT_GRADE_NAME);
        await assignmentBtn(page, ASSIGNMENT_STANDARD_TITLE).click();
        await expect(page.locator('#assignmentPickerSection')).toHaveClass(/hidden/);
        await expect(page.locator('#gradingSection')).not.toHaveClass(/hidden/, { timeout: 10_000 });

        // A real assignment's title/type/max come in locked (read-only /
        // disabled + the gf-locked visual treatment) — not freely editable.
        await expect(page.locator('#agTitle')).toHaveValue(ASSIGNMENT_STANDARD_TITLE);
        await expect(page.locator('#agTitle')).toHaveClass(/gf-locked/);
        expect(await page.locator('#agTitle').evaluate(el => el.readOnly)).toBe(true);
        await expect(page.locator('#agType')).toBeDisabled();
        await expect(page.locator('#agMax')).toHaveValue('20');
        // "Post to Class" only makes sense for a brand-new manual entry.
        await expect(page.locator('#postToClassBtn')).toHaveClass(/hidden/);

        // "Switch / Reset" returns all the way to step 1.
        await page.locator('button', { hasText: 'Switch / Reset' }).click();
        await expect(page.locator('#subjectPickerSection')).not.toHaveClass(/hidden/);
        await expect(page.locator('#gradingSection')).toHaveClass(/hidden/);

        // -- Step 1 -> 2 -> 3 again, this time via "Type one manually". ------
        await selectSubjectUI(page, SUBJECT_GRADE_NAME);
        await page.locator('button', { hasText: 'Type one manually' }).click();
        await expect(page.locator('#gradingSection')).not.toHaveClass(/hidden/, { timeout: 10_000 });

        // A manual entry starts fully blank and freely editable.
        await expect(page.locator('#agTitle')).toHaveValue('');
        await expect(page.locator('#agTitle')).not.toHaveClass(/gf-locked/);
        expect(await page.locator('#agTitle').evaluate(el => el.readOnly)).toBe(false);
        await expect(page.locator('#agType')).toBeEnabled();
        await expect(page.locator('#agMax')).toHaveValue('100');
        await expect(page.locator('#postToClassBtn')).not.toHaveClass(/hidden/);
    });

    test('5.2 — Manual entry: "Post to Class" converts it into a real, persisted assignment template with no grade written', async ({ page }) => {
        forwardBrowserLogs(page);
        await loginAsTeacher(page, TEACHER_GRADE_ID, TEACHER_GRADE_PIN);
        await gotoGradeForm(page);

        await selectSubjectUI(page, SUBJECT_GRADE_NAME);
        await page.locator('button', { hasText: 'Type one manually' }).click();
        await expect(page.locator('#gradingSection')).not.toHaveClass(/hidden/, { timeout: 10_000 });

        const uniqueTitle = `E2E Manual Entry ${Date.now()}`;
        await page.locator('#agTitle').fill(uniqueTitle);
        await page.locator('#agType').selectOption({ index: 1 });
        const chosenType = await page.locator('#agType').inputValue();
        await page.locator('#agMax').fill('40');

        await expect(page.locator('#postToClassBtn')).not.toHaveClass(/hidden/);
        await page.locator('#postToClassBtn').click();

        await expect(page.locator('#gradeSavedBanner')).not.toHaveClass(/hidden/, { timeout: 10_000 });
        await expect(page.locator('#gradeSavedBannerTitle')).toContainText(`"${uniqueTitle}" was posted to the class.`);
        // Now a real template — "Post to Class" no longer applies.
        await expect(page.locator('#postToClassBtn')).toHaveClass(/hidden/);

        const created = await findAssignmentDoc(CLASS_GRADE_ID, SUBJECT_GRADE_ID, uniqueTitle);
        expect(created).not.toBeNull();
        expect(created.type).toBe(chosenType);
        expect(created.maxScore).toBe(40);
        expect(created.completed).toBe(false);
        // A legacy-shape template (typed manually here), not an Add Work
        // assessment — no category/questions were ever set on it.
        expect(created.category).toBeUndefined();

        // No grade was recorded for anyone — posting is not grading. Back on
        // the assignment picker, this now shows the "Needs Grading" badge
        // (zero entries under this title for the whole roster).
        await page.locator('button', { hasText: 'Switch / Reset' }).click();
        await selectSubjectUI(page, SUBJECT_GRADE_NAME);
        await expect(assignmentBtn(page, uniqueTitle)).toContainText('Needs Grading');
    });

    test('5.4 — Assessment grading: the auto-graded MC question prefills its own score; the read-only total recomputes live', async ({ page }) => {
        forwardBrowserLogs(page);
        await loginAsTeacher(page, TEACHER_GRADE_ID, TEACHER_GRADE_PIN);
        await gotoGradeForm(page);

        await selectSubjectUI(page, SUBJECT_GRADE_NAME);
        await assignmentBtn(page, ASSIGNMENT_ASSESS_TITLE).click();
        await expect(page.locator('#gradingSection')).not.toHaveClass(/hidden/, { timeout: 10_000 });

        // Pick the student with a real, already-auto-graded submission.
        await rosterBtn(page, 'E2E Grade Student One').click();
        await expect(page.locator('#gfResponseViewer')).not.toContainText('Loading submission', { timeout: 10_000 });
        await expect(page.locator('#gfResponseViewer')).toContainText('Auto-graded 1/1 objective question(s) — 2/2 pt(s).');

        // The MC question (2 pts, answered correctly, index 0) is pre-filled
        // from the server-computed objectiveAutoGrade — never left blank for
        // the teacher to type in themselves — and shows a "Correct" badge.
        const mcScoreInput = page.locator(`.pq-score-input[data-question-id="${QUESTION_MC_ID}"]`);
        await expect(mcScoreInput).toHaveValue('2');
        await expect(page.locator('#gfResponseViewer')).toContainText('Correct');

        // #agScore is read-only/auto-tallied for a real assessment — right
        // now the sum is just the MC question's 2 pts (free-response blank).
        expect(await page.locator('#agScore').evaluate(el => el.readOnly)).toBe(true);
        await expect(page.locator('#agScore')).toHaveValue('2');

        // Grading the free-response question (3 pts) live-updates the total.
        const frScoreInput = page.locator(`.pq-score-input[data-question-id="${QUESTION_FR_ID}"]`);
        await frScoreInput.fill('3');
        await expect(page.locator('#agScore')).toHaveValue('5');

        // A per-question score over ITS OWN max clamps to it (sanitizePQScore
        // scopes to data-max, not the overall #agMax).
        await frScoreInput.fill('10');
        await expect(frScoreInput).toHaveValue('3');
        await expect(page.locator('#agScore')).toHaveValue('5');
    });

    test('5.5 — Request Revision flips the live submission to "revision_requested", then back to "graded" once resolved', async ({ page }) => {
        forwardBrowserLogs(page);
        await loginAsTeacher(page, TEACHER_GRADE_ID, TEACHER_GRADE_PIN);
        await gotoGradeForm(page);

        await selectSubjectUI(page, SUBJECT_GRADE_NAME);
        await assignmentBtn(page, ASSIGNMENT_ASSESS_TITLE).click();
        await expect(page.locator('#gradingSection')).not.toHaveClass(/hidden/, { timeout: 10_000 });
        await rosterBtn(page, 'E2E Grade Student One').click();
        await expect(page.locator('#gfResponseViewer')).not.toContainText('Loading submission', { timeout: 10_000 });

        // Request a revision on the free-response question.
        await page.locator(`.pq-revision-toggle[data-question-id="${QUESTION_FR_ID}"]`).check();
        const promptBox = page.locator(`#pqRevisionPrompt_${QUESTION_FR_ID}`);
        await expect(promptBox).not.toHaveClass(/hidden/);
        const revisionPrompt = 'Please add more detail on the energy conversion.';
        await promptBox.locator('.pq-revision-prompt-input').fill(revisionPrompt);

        await page.locator('#saveGradeBtn').click();
        await expect(page.locator('#gradeSavedBanner')).not.toHaveClass(/hidden/, { timeout: 10_000 });

        const subAfterRequest = await getSubmissionDoc(CLASS_GRADE_ID, SUBJECT_GRADE_ID, ASSIGNMENT_ASSESS_ID, STUDENT_GRADE_1_ID);
        expect(subAfterRequest.status).toBe('revision_requested');

        const gradeAfterRequest = await findGradeByAssignment(STUDENT_GRADE_1_ID, ASSIGNMENT_ASSESS_ID);
        expect(gradeAfterRequest).not.toBeNull();
        expect(gradeAfterRequest.perQuestion[QUESTION_FR_ID].revision.requested).toBe(true);
        expect(gradeAfterRequest.perQuestion[QUESTION_FR_ID].revision.prompt).toBe(revisionPrompt);

        // Resolve it: jump back to this student (Commit & Next likely moved
        // focus on to another ungraded student after that commit), uncheck
        // the toggle, and re-commit.
        await rosterBtn(page, 'E2E Grade Student One').click();
        await expect(page.locator('#gfResponseViewer')).not.toContainText('Loading submission', { timeout: 10_000 });
        await expect(page.locator(`.pq-revision-toggle[data-question-id="${QUESTION_FR_ID}"]`)).toBeChecked();

        await page.locator(`.pq-revision-toggle[data-question-id="${QUESTION_FR_ID}"]`).uncheck();
        await page.locator('#saveGradeBtn').click();
        await expect(page.locator('#gradeSavedBanner')).not.toHaveClass(/hidden/, { timeout: 10_000 });

        const subAfterResolve = await getSubmissionDoc(CLASS_GRADE_ID, SUBJECT_GRADE_ID, ASSIGNMENT_ASSESS_ID, STUDENT_GRADE_1_ID);
        expect(subAfterResolve.status).toBe('graded');

        // The revision RECORD itself is preserved (original prompt/response
        // intact) — only its `requested` flag flips, never deleted outright.
        const gradeAfterResolve = await findGradeByAssignment(STUDENT_GRADE_1_ID, ASSIGNMENT_ASSESS_ID);
        expect(gradeAfterResolve.perQuestion[QUESTION_FR_ID].revision.requested).toBe(false);
        expect(gradeAfterResolve.perQuestion[QUESTION_FR_ID].revision.prompt).toBe(revisionPrompt);
        expect(gradeAfterResolve.perQuestion[QUESTION_FR_ID].revision.originalResponse.responseText)
            .toBe('Plants convert sunlight into chemical energy.');
    });

    test('5.6 — Score bounds: #agScore live-clamps to [0, max]; an empty score at submit time is a hard, blocking alert', async ({ page }) => {
        forwardBrowserLogs(page);
        await loginAsTeacher(page, TEACHER_GRADE_ID, TEACHER_GRADE_PIN);
        await gotoGradeForm(page);

        await selectSubjectUI(page, SUBJECT_GRADE_NAME);
        await assignmentBtn(page, ASSIGNMENT_STANDARD_TITLE).click();
        await expect(page.locator('#gradingSection')).not.toHaveClass(/hidden/, { timeout: 10_000 });
        await rosterBtn(page, 'E2E Grade Student One').click();
        await expect(page.locator('#agMax')).toHaveValue('20');

        // Negative score clamps to 0, with the exact (curly-apostrophe) hint.
        await page.locator('#agScore').fill('-5');
        await expect(page.locator('#agScore')).toHaveValue('0');
        await expect(page.locator('#agScoreHint')).not.toHaveClass(/hidden/);
        await expect(page.locator('#agScoreHint')).toContainText('Score can’t be negative.');

        // Over-max score clamps to the max, with its own exact hint.
        await page.locator('#agScore').fill('999');
        await expect(page.locator('#agScore')).toHaveValue('20');
        await expect(page.locator('#agScoreHint')).toContainText('Score can’t exceed the max of 20.');

        // A perfectly in-range score clears the hint.
        await page.locator('#agScore').fill('18');
        await expect(page.locator('#agScoreHint')).toHaveClass(/hidden/);

        // Empty score at submit time is a HARD block — commitGrade()'s own
        // isNaN(score) guard, via a real blocking alert (not just the live
        // hint above, which never even fires for a blank field).
        await page.locator('#agScore').fill('');
        let dialogMessage = null;
        page.once('dialog', async (dialog) => { dialogMessage = dialog.message(); await dialog.accept(); });
        await page.locator('#saveGradeBtn').click();

        await expect.poll(() => dialogMessage, { timeout: 5_000 }).toBe('Please enter valid score and max values.');
        // Nothing committed — still sitting on the same grading panel.
        await expect(page.locator('#gradingSection')).not.toHaveClass(/hidden/);
        await expect(page.locator('#agTitle')).toHaveValue(ASSIGNMENT_STANDARD_TITLE);
    });

    test('5.7 — "Commit & Next" wraps around: grading the last-listed student advances back to the first', async ({ page }) => {
        forwardBrowserLogs(page);
        await loginAsTeacher(page, TEACHER_GRADE_ID, TEACHER_GRADE_PIN);
        await gotoGradeForm(page);

        await selectSubjectUI(page, SUBJECT_GRADE_NAME);
        await assignmentBtn(page, ASSIGNMENT_STANDARD_TITLE).click();
        await expect(page.locator('#gradingSection')).not.toHaveClass(/hidden/, { timeout: 10_000 });

        // Read the ACTUAL rendered roster order — see this file's header
        // comment on why this doesn't hard-code an assumed order.
        const names = await page.locator('#gfRosterList button .block').allTextContents();
        expect(names.length).toBeGreaterThanOrEqual(2);
        const firstName = names[0];
        const lastName = names[names.length - 1];

        // Grade the LAST-listed student. Nobody else on the roster is graded
        // for this assignment yet, so the only way advanceToNextUngraded()
        // can find a next candidate is by wrapping past the end of the
        // array back to index 0 — true circular/modulo search, not merely
        // "stop, there's nothing after this."
        await rosterBtn(page, lastName).click();
        await page.locator('#agScore').fill('15');
        await page.locator('#saveGradeBtn').click();
        await expect(page.locator('#gradeSavedBanner')).not.toHaveClass(/hidden/, { timeout: 10_000 });

        // Selection wrapped to the first-listed student — its roster row is
        // now the highlighted/active one.
        await expect(rosterBtn(page, firstName)).toHaveClass(/border-\[#0ea871\]/, { timeout: 10_000 });
        await expect(page.locator('#gfRosterProgress')).toHaveText(`1 of ${names.length} graded`);
    });
});
