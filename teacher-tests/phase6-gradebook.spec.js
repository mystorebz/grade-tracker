// Phase 6 of docs/teacher-portal-test-plan.md — Gradebook
// (teacher/gradebook/gradebook.html), per the "ARCHITECTURAL MANDATE:
// Commit & Advance to Phases 5 & 6".
//
// Covers:
//   6.3  Auditing: the "Reason for Change" field strictly gates any edit to
//        Score or Max (checkScoreChange()'s #reasonSection toggle, and
//        saveEditedGrade()'s own blocking alert when changed with no
//        reason) — and a no-op save (nothing changed) never demands one.
//   6.6  Grade Weights: inline weight edits are hard-clamped to the room
//        left over after every OTHER category (updateGwWeight()'s dynamic
//        cap), reacting live as room is freed up elsewhere.
//   6.7  Grade Weights: a category with existing grades on file ("in use")
//        can't be deleted — no delete button, an "In Use" lock badge
//        instead — while an unused category has a normal working delete.
//   6.8  Grade Weights: "Save & Recalculate" is strictly disabled unless
//        the total is EXACTLY 100%, including the Add Metric field's own
//        dynamic hard cap.
//   6.4  Destructive: permanently deleting an isolated, disposable grade
//        record via the real confirm()-gated delete flow.
//
// SOURCE-OF-TRUTH METHODOLOGY (same as phase3/phase4/phase5): every
// selector, validation message, and confirm() string below was read
// directly out of teacher/gradebook/gradebook.js / gradebook.html.
//
// DEFAULT WEIGHTING NOTE: TEACHER_GRADE_ID has no teaching_assignments /
// legacy gradeTypes configured, so getGradeTypes() falls back to
// gradebook.js's own "Perfect 100" DEFAULT_GRADE_TYPES — Test 30 / Quiz 20
// / Project 20 / Assignment 20 / Homework 10 — which already sums to
// exactly 100%. Every test below that opens the Grade Weights modal
// accounts for this starting-at-100 baseline explicitly rather than
// assuming the modal opens empty or unbalanced.
//
// DESTRUCTIVE SAFETY: 6.4 only ever touches the isolated
// STUDENT_GRADE_DELETE_ID / GRADEBOOK_DELETE_GRADE_ID fixture seed.js
// carves out specifically for this test — never GRADEBOOK_EDIT_GRADE_ID
// (6.3's own target) or any other student's real grade record. The Grade
// Weights tests (6.6/6.7/6.8) never click "Save & Recalculate" while the
// in-memory category list is unbalanced, and any experimental categories
// they add exist only in this sandbox teacher's own weighting doc — reset
// on the next test's beforeEach(seed) re-run of baseTeacher(), which always
// writes a clean teacher doc with no custom weighting saved.
//
// Requires (see playwright.config.js's header comment):
//   1. Firebase emulators already running.
//   2. `npm run seed` already run in this folder (or let beforeEach do it).

const { test, expect } = require('@playwright/test');
const {
    seed,
    TEACHER_GRADE_ID, TEACHER_GRADE_PIN,
    STUDENT_GRADE_1_ID, STUDENT_GRADE_DELETE_ID,
    GRADEBOOK_EDIT_GRADE_ID, GRADEBOOK_DELETE_GRADE_ID, GRADEBOOK_EDIT_TITLE,
    getGradeDoc,
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

async function gotoGradebook(page) {
    await page.goto('/teacher/gradebook/gradebook.html');
    await expect(page.locator('#gradebookTableBody .fa-spinner')).toHaveCount(0, { timeout: 15_000 });
}

// Scopes to a specific grade row by its assignment title, the same
// ancestor-xpath pattern phase4-subjects.spec.js already uses for a table
// row that has no id of its own.
function gradebookRow(page, title) {
    return page.locator(`xpath=//p[contains(@class,"gb-title") and contains(text(),"${title}")]/ancestor::tr[1]`);
}

// EXACT match on the category's own name span (not a plain substring
// hasText) — 'Quiz' must never also match a later 'Makeup Quiz' row.
function gwRow(page, categoryName) {
    return page.locator('#gwList > div').filter({ has: page.locator(`span:text-is("${categoryName}")`) });
}

async function openGradeWeights(page) {
    await page.locator('#openGradeWeightsBtn').click();
    await expect(page.locator('#gradeWeightsModal')).not.toHaveClass(/hidden/, { timeout: 10_000 });
}

test.describe('Phase 6: Gradebook', () => {
    test.beforeEach(seed);

    test('6.3 — "Reason for Change" strictly gates any edit to Score or Max; a no-op save never demands one', async ({ page }) => {
        forwardBrowserLogs(page);
        await loginAsTeacher(page, TEACHER_GRADE_ID, TEACHER_GRADE_PIN);
        await gotoGradebook(page);

        const row = gradebookRow(page, GRADEBOOK_EDIT_TITLE);
        await expect(row).toBeVisible({ timeout: 10_000 });
        await row.locator('button[title="Edit"]').click();
        await expect(page.locator('#editGradeModal')).not.toHaveClass(/hidden/, { timeout: 10_000 });
        await expect(page.locator('#ed-score')).toHaveValue('15');
        await expect(page.locator('#ed-max')).toHaveValue('20');
        await expect(page.locator('#reasonSection')).not.toHaveClass(/visible/);

        // -- Changing the SCORE reveals the (required) reason section. ------
        await page.locator('#ed-score').fill('18');
        await expect(page.locator('#reasonSection')).toHaveClass(/visible/);

        // Attempting to save changed-but-unexplained is a hard, blocking block.
        let dialogMessage = null;
        page.once('dialog', async (dialog) => { dialogMessage = dialog.message(); await dialog.accept(); });
        await page.locator('#updateGradeBtn').click();
        await expect.poll(() => dialogMessage, { timeout: 5_000 }).toBe('A reason is required when changing the score.');
        // Modal is still open — nothing was saved.
        await expect(page.locator('#editGradeModal')).not.toHaveClass(/hidden/);

        // Supplying a reason lets the same edit through.
        await page.locator('#ed-reason').fill('Re-graded missed question.');
        await page.locator('#updateGradeBtn').click();
        await expect(page.locator('#editGradeModal')).toHaveClass(/hidden/, { timeout: 10_000 });

        let doc = await getGradeDoc(STUDENT_GRADE_1_ID, GRADEBOOK_EDIT_GRADE_ID);
        expect(doc.score).toBe(18);
        expect(doc.max).toBe(20);
        expect(doc.historyLogs).toHaveLength(1);
        expect(doc.historyLogs[0]).toMatchObject({ oldScore: 15, oldMax: 20, newScore: 18, newMax: 20, reason: 'Re-graded missed question.' });

        // -- Changing only the MAX (score unchanged) gates it just the same. -
        await gradebookRow(page, GRADEBOOK_EDIT_TITLE).locator('button[title="Edit"]').click();
        await expect(page.locator('#editGradeModal')).not.toHaveClass(/hidden/, { timeout: 10_000 });
        await expect(page.locator('#ed-score')).toHaveValue('18');
        await expect(page.locator('#ed-max')).toHaveValue('20');
        await page.locator('#ed-max').fill('22');
        await expect(page.locator('#reasonSection')).toHaveClass(/visible/);
        await page.locator('#ed-reason').fill('Max points corrected after review.');
        await page.locator('#updateGradeBtn').click();
        await expect(page.locator('#editGradeModal')).toHaveClass(/hidden/, { timeout: 10_000 });

        doc = await getGradeDoc(STUDENT_GRADE_1_ID, GRADEBOOK_EDIT_GRADE_ID);
        expect(doc.score).toBe(18);
        expect(doc.max).toBe(22);
        expect(doc.historyLogs).toHaveLength(2);

        // -- A no-op save (nothing changed) never demands a reason. ----------
        await gradebookRow(page, GRADEBOOK_EDIT_TITLE).locator('button[title="Edit"]').click();
        await expect(page.locator('#editGradeModal')).not.toHaveClass(/hidden/, { timeout: 10_000 });
        await expect(page.locator('#reasonSection')).not.toHaveClass(/visible/);
        await page.locator('#updateGradeBtn').click();
        await expect(page.locator('#editGradeModal')).toHaveClass(/hidden/, { timeout: 10_000 });

        doc = await getGradeDoc(STUDENT_GRADE_1_ID, GRADEBOOK_EDIT_GRADE_ID);
        expect(doc.score).toBe(18);
        expect(doc.max).toBe(22);
        expect(doc.historyLogs).toHaveLength(2); // unchanged — no new entry
    });

    test('6.6 — Grade Weights: inline edits are hard-clamped to the room left after every other category', async ({ page }) => {
        forwardBrowserLogs(page);
        await loginAsTeacher(page, TEACHER_GRADE_ID, TEACHER_GRADE_PIN);
        await gotoGradebook(page);
        await openGradeWeights(page);

        // Baseline: DEFAULT_GRADE_TYPES already sums to exactly 100%.
        await expect(page.locator('#gwTotalWeight')).toContainText('100%');
        await expect(page.locator('#saveGwBtn')).toBeEnabled();

        // Homework starts at 10% — with the OTHER four already at 90%
        // combined, there is zero room left, so pushing it up to 500 must
        // clamp right back down to its own current value (10), not the
        // typed number.
        const homeworkInput = gwRow(page, 'Homework').locator('input[type="number"]');
        await expect(homeworkInput).toHaveValue('10');
        await homeworkInput.fill('500');
        await expect(homeworkInput).toHaveValue('10');
        await expect(page.locator('#gwTotalWeight')).toContainText('100%');

        // Free up room by reducing Test from 30% to 10% (total now 80%)...
        const testInput = gwRow(page, 'Test').locator('input[type="number"]');
        await testInput.fill('10');
        await expect(page.locator('#gwTotalWeight')).toContainText('80%');
        await expect(page.locator('#saveGwBtn')).toBeDisabled();

        // ...now Homework has real room: the other four sum to 70%, so its
        // own ceiling is 30% — typing 500 clamps to exactly that, not to 0
        // and not to the raw typed value.
        await homeworkInput.fill('500');
        await expect(homeworkInput).toHaveValue('30');
        await expect(page.locator('#gwTotalWeight')).toContainText('100%');
        await expect(page.locator('#saveGwBtn')).toBeEnabled();
    });

    test('6.7 & 6.8 — Grade Weights: an in-use category can\'t be deleted, and Save is strictly gated on exactly 100%', async ({ page }) => {
        forwardBrowserLogs(page);
        await loginAsTeacher(page, TEACHER_GRADE_ID, TEACHER_GRADE_PIN);
        await gotoGradebook(page);
        await openGradeWeights(page);

        await expect(page.locator('#gwTotalWeight')).toContainText('100%');
        await expect(page.locator('#saveGwBtn')).toBeEnabled();

        // -- 6.7: 'Test' has real grades on file in this sandbox (both
        //    Phase 6 fixtures use type:'Test') — it's locked, not deletable.
        const testRow = gwRow(page, 'Test');
        await expect(testRow).toContainText('In Use');
        await expect(testRow.locator('button[title="Delete Metric"]')).toHaveCount(0);

        // 'Quiz' has never been used by any grade in this sandbox — a
        // normal, working delete button.
        const quizRow = gwRow(page, 'Quiz');
        await expect(quizRow.locator('button[title="Delete Metric"]')).toBeVisible();

        // -- 6.8: deleting Quiz (20%) breaks the 100% total -> Save disables
        //    immediately, with the exact "you need N% more" helper text.
        await quizRow.locator('button[title="Delete Metric"]').click();
        await expect(gwRow(page, 'Quiz')).toHaveCount(0);
        await expect(page.locator('#gwTotalWeight')).toContainText('80%');
        await expect(page.locator('#gwTotalWeight')).toContainText('You need');
        await expect(page.locator('#gwTotalWeight')).toContainText('20%');
        await expect(page.locator('#saveGwBtn')).toBeDisabled();

        // -- 6.6 (Add Metric's own clamp): typing well over the 20%
        //    remaining into the Quick Add weight field clamps it down to
        //    exactly the room left, before Add is even clicked.
        await page.locator('#gwNewName').fill('Makeup Quiz');
        await page.locator('#gwNewWeight').fill('999');
        await expect(page.locator('#gwNewWeight')).toHaveValue('20');

        await page.locator('#addGwBtn').click();
        await expect(gwRow(page, 'Makeup Quiz')).toBeVisible();
        await expect(page.locator('#gwTotalWeight')).toContainText('100%');
        await expect(page.locator('#saveGwBtn')).toBeEnabled();

        // Save & Recalculate persists it for real (not just in-memory modal
        // state) — closes the modal and the change survives a fresh load.
        await page.locator('#saveGwBtn').click();
        await expect(page.locator('#gradeWeightsModal')).toHaveClass(/hidden/, { timeout: 10_000 });

        await openGradeWeights(page);
        await expect(gwRow(page, 'Makeup Quiz')).toBeVisible();
        await expect(gwRow(page, 'Quiz')).toHaveCount(0);
        await expect(page.locator('#gwTotalWeight')).toContainText('100%');
    });

    test('6.4 — Destructive: permanently deleting an isolated grade record via the real confirm()-gated flow', async ({ page }) => {
        forwardBrowserLogs(page);
        await loginAsTeacher(page, TEACHER_GRADE_ID, TEACHER_GRADE_PIN);
        await gotoGradebook(page);

        const disposableTitle = 'E2E Gradebook Delete Target';
        const before = await getGradeDoc(STUDENT_GRADE_DELETE_ID, GRADEBOOK_DELETE_GRADE_ID);
        expect(before).not.toBeNull();

        const row = gradebookRow(page, disposableTitle);
        await expect(row).toBeVisible({ timeout: 10_000 });

        let dialogMessage = null;
        page.once('dialog', async (dialog) => { dialogMessage = dialog.message(); await dialog.accept(); });
        await row.locator('button[title="Delete"]').click();

        await expect.poll(() => dialogMessage, { timeout: 5_000 }).toBe('Are you sure you want to permanently delete this grade?');
        await expect(gradebookRow(page, disposableTitle)).toHaveCount(0, { timeout: 10_000 });

        const afterDelete = await getGradeDoc(STUDENT_GRADE_DELETE_ID, GRADEBOOK_DELETE_GRADE_ID);
        expect(afterDelete).toBeNull();

        // Reload and re-verify — proves the delete persisted server-side
        // (a fresh loadGradebook()), not just optimistic local state.
        await page.reload();
        await expect(page.locator('#gradebookTableBody .fa-spinner')).toHaveCount(0, { timeout: 15_000 });
        await expect(gradebookRow(page, disposableTitle)).toHaveCount(0);

        // The OTHER Phase 6 fixture (a real, non-disposable grade) is
        // completely untouched by this.
        const editTarget = await getGradeDoc(STUDENT_GRADE_1_ID, GRADEBOOK_EDIT_GRADE_ID);
        expect(editTarget).not.toBeNull();
    });
});
