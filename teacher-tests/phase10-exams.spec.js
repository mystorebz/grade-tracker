// Phase 10 of docs/teacher-portal-test-plan.md — Exams: teacher grading and
// live proctoring (teacher/exams/grade.html and teacher/exams/live.html),
// per the "ARCHITECTURAL MANDATE: E2E Test Suite (Phases 9 & 10)".
//
// Covers:
//   10.1 Security & Roster: both pages read their exam context from the URL
//        HASH fragment, not the query string (see each file's own comment
//        on why — this project's local dev server strips the query string
//        from every page on load). Missing classId/subjectId/examId shows
//        the fatal-error state, never a broken/blank dashboard.
//   10.2 Security & Roster: grade.html's roster is built from
//        TERMINAL_STATUSES only — a still-in_progress submission has
//        nothing gradable yet and must never appear in the roster at all.
//   10.4 Grading Engine: point-cap clamping on free-response grading —
//        handleSaveGrade()'s own client-side bounds check (mirroring
//        recordManualGrade's real server-side one) blocks an out-of-range
//        point value with an explicit message and never calls the
//        callable; a valid in-range value succeeds and the card converts
//        to its read-only "already graded" summary.
//   10.6 Grading Engine: multiple_choice questions are strictly excluded
//        from this manual grading view — renderDetail()'s own
//        relevantQuestionIds is built only from pendingManualQuestionIds +
//        Object.keys(manualGrades), and an auto-graded MC question is
//        never present in either set.
//   10.8 Live Monitor: the live monitor UI is strictly read-only — no
//        input fields anywhere on the page (this dashboard "has NO write
//        paths of its own", per live.js's own top-of-file comment).
//   10.9 & 10.10 Live Monitor (mock student sync): a background mock
//        student connection — direct RTDB writes to examPresence/{examId}/
//        {studentId}, this suite's stand-in for a real student's take.js
//        (not available to cross-reference in this environment — see
//        seed.js's setExamPresence() for the full explanation) — updates
//        the Connected/Disconnected and Tab Focused/Blurred chips and the
//        "N questions answered" progress text live, with NO page refresh.
//
// SOURCE-OF-TRUTH METHODOLOGY (same as every prior phase in this suite):
// every selector, status list, and data shape below was read directly out
// of teacher/exams/grade.html, teacher/exams/grade.js, teacher/exams/
// live.html, teacher/exams/live.js, and functions/index.js's
// startExamAttempt/recordManualGrade — not guessed from the mandate's
// prose. student/exams/take.js and database.rules.json were NOT available
// in this environment; see the 10.9/10.10 test's own comment for how that
// gap was handled.
//
// Requires (see playwright.config.js's header comment):
//   1. Firebase emulators already running (Firestore 8080, Auth 9099,
//      Functions 5001, Database 9000).
//   2. `npm run seed` already run in this folder (or let beforeEach do it).

const { test, expect } = require('@playwright/test');
const {
    seed,
    TEACHER_EXAM_ID, TEACHER_EXAM_PIN,
    CLASS_EXAM_ID, SUBJECT_EXAM_ID,
    EXAM_ID, QUESTION_EXAM_MC_ID, QUESTION_EXAM_FR_ID,
    STUDENT_EXAM_SUBMITTED_ID, STUDENT_EXAM_INPROGRESS_ID,
    findExamSubmission,
    setExamPresence,
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

// Both exam pages read their context from window.location.hash, not the
// query string or path — see each file's own top-of-file comment for why.
function gradeUrl({ classId, subjectId, examId }) {
    const parts = [];
    if (classId !== undefined) parts.push(`classId=${classId}`);
    if (subjectId !== undefined) parts.push(`subjectId=${subjectId}`);
    if (examId !== undefined) parts.push(`examId=${examId}`);
    return `/teacher/exams/grade.html#${parts.join('&')}`;
}
function liveMonitorUrl({ classId, subjectId, examId }) {
    const parts = [];
    if (classId !== undefined) parts.push(`classId=${classId}`);
    if (subjectId !== undefined) parts.push(`subjectId=${subjectId}`);
    if (examId !== undefined) parts.push(`examId=${examId}`);
    return `/teacher/exams/live.html#${parts.join('&')}`;
}

test.describe('Phase 10: Exams — Grading & Live Monitor', () => {
    test.beforeEach(seed);

    test('10.1 — Missing exam-context params show the fatal-error state, on both pages', async ({ page }) => {
        forwardBrowserLogs(page);
        await loginAsTeacher(page, TEACHER_EXAM_ID, TEACHER_EXAM_PIN);

        // grade.html — examId omitted entirely.
        await page.goto(gradeUrl({ classId: CLASS_EXAM_ID, subjectId: SUBJECT_EXAM_ID }));
        await expect(page.locator('#dashFatalState')).toBeVisible({ timeout: 10_000 });
        await expect(page.locator('#dashFatalMsg')).toContainText('missing information');
        await expect(page.locator('#dashBody')).toBeHidden();

        // grade.html — a well-formed but NONEXISTENT examId reaches the
        // separate "exam not found" branch, not the missing-params one.
        await page.goto(gradeUrl({ classId: CLASS_EXAM_ID, subjectId: SUBJECT_EXAM_ID, examId: 'exam-does-not-exist' }));
        await expect(page.locator('#dashFatalState')).toBeVisible({ timeout: 10_000 });
        await expect(page.locator('#dashFatalMsg')).toContainText('could not be found');

        // live.html — classId omitted entirely.
        await page.goto(liveMonitorUrl({ subjectId: SUBJECT_EXAM_ID, examId: EXAM_ID }));
        await expect(page.locator('#dashFatalState')).toBeVisible({ timeout: 10_000 });
        await expect(page.locator('#dashFatalMsg')).toContainText('missing information');
        await expect(page.locator('#dashBody')).toBeHidden();
    });

    test('10.2 — A still-in_progress submission never appears in the grading roster', async ({ page }) => {
        forwardBrowserLogs(page);
        await loginAsTeacher(page, TEACHER_EXAM_ID, TEACHER_EXAM_PIN);
        await page.goto(gradeUrl({ classId: CLASS_EXAM_ID, subjectId: SUBJECT_EXAM_ID, examId: EXAM_ID }));
        await expect(page.locator('#dashBody')).toBeVisible({ timeout: 15_000 });

        // The submitted student is on the roster; the in_progress one is
        // filtered out by buildRosterRows()'s own TERMINAL_STATUSES list —
        // not merely rendered differently, absent entirely.
        await expect(page.locator('#rosterList')).toContainText(STUDENT_EXAM_SUBMITTED_ID);
        await expect(page.locator('#rosterList')).not.toContainText(STUDENT_EXAM_INPROGRESS_ID);
        await expect(page.locator('[data-student-id]')).toHaveCount(1);

        // countTotal counts the WHOLE submissionByStudent map (both
        // students the listener has seen), while countSubmitted only
        // counts the terminal-status roster rows — this distinction is
        // exactly what proves the in_progress student is being tracked
        // and deliberately excluded, not simply never received.
        await expect(page.locator('#countSubmitted')).toHaveText('1');
        await expect(page.locator('#countTotal')).toHaveText('2');
    });

    test('10.6 — Multiple-choice questions are excluded from the manual grading view', async ({ page }) => {
        forwardBrowserLogs(page);
        await loginAsTeacher(page, TEACHER_EXAM_ID, TEACHER_EXAM_PIN);
        await page.goto(gradeUrl({ classId: CLASS_EXAM_ID, subjectId: SUBJECT_EXAM_ID, examId: EXAM_ID }));
        await expect(page.locator('#dashBody')).toBeVisible({ timeout: 15_000 });

        await page.locator('[data-student-id]', { hasText: STUDENT_EXAM_SUBMITTED_ID }).click();
        await expect(page.locator('#detailContent')).toBeVisible();

        // Exactly one question card — the free-response one. The
        // multiple_choice question (auto-graded, 5/5, never pending and
        // never in manualGrades) must never render as a card at all, and
        // its own prompt text must never appear anywhere in the panel.
        await expect(page.locator('#detailQuestionList .question-card')).toHaveCount(1);
        await expect(page.locator('#detailQuestionList')).toContainText('Explain photosynthesis in one sentence.');
        await expect(page.locator('#detailQuestionList')).not.toContainText('What is 2 + 2?');
        await expect(page.locator(`[data-question-id="${QUESTION_EXAM_MC_ID}"]`)).toHaveCount(0);
        await expect(page.locator(`[data-question-id="${QUESTION_EXAM_FR_ID}"]`)).toHaveCount(1);
    });

    test('10.4 — Point-cap clamping: an out-of-range score is blocked client-side; an in-range one saves', async ({ page }) => {
        forwardBrowserLogs(page);
        await loginAsTeacher(page, TEACHER_EXAM_ID, TEACHER_EXAM_PIN);
        await page.goto(gradeUrl({ classId: CLASS_EXAM_ID, subjectId: SUBJECT_EXAM_ID, examId: EXAM_ID }));
        await expect(page.locator('#dashBody')).toBeVisible({ timeout: 15_000 });

        await page.locator('[data-student-id]', { hasText: STUDENT_EXAM_SUBMITTED_ID }).click();
        const card = page.locator(`[data-question-id="${QUESTION_EXAM_FR_ID}"]`);
        await expect(card).toBeVisible();
        const maxPoints = Number(await card.getAttribute('data-max-points'));
        expect(maxPoints).toBe(10);

        // Over the cap — handleSaveGrade()'s own client-side bounds check
        // blocks this BEFORE recordManualGrade is ever called: the
        // submission must still show q-fr-1 as pending afterward.
        await card.locator('.grade-points-input').fill(String(maxPoints + 5));
        await card.locator('.grade-save-btn').click();
        await expect(card.locator('.grade-save-msg')).toContainText(`Points must be between 0 and ${maxPoints}.`);
        await expect(card.locator('.grade-save-msg')).toHaveClass(/is-error/);

        let submission = await findExamSubmission(STUDENT_EXAM_SUBMITTED_ID, EXAM_ID);
        expect(submission.pendingManualQuestionIds).toContain(QUESTION_EXAM_FR_ID);
        expect(submission.manualGrades[QUESTION_EXAM_FR_ID]).toBeUndefined();

        // Negative is blocked the same way.
        await card.locator('.grade-points-input').fill('-1');
        await card.locator('.grade-save-btn').click();
        await expect(card.locator('.grade-save-msg')).toContainText(`Points must be between 0 and ${maxPoints}.`);

        // In-range succeeds — recordManualGrade actually runs (a real
        // Cloud Function call against the Functions emulator), the
        // submission flips to fully graded, and the card converts to its
        // read-only "already graded" summary.
        await card.locator('.grade-points-input').fill('8');
        await card.locator('.grade-feedback-input').fill('Solid explanation, missing the word "chlorophyll".');
        await card.locator('.grade-save-btn').click();
        await expect(card.locator('.grade-save-msg')).toContainText('Saved.', { timeout: 10_000 });

        await expect.poll(async () => {
            const s = await findExamSubmission(STUDENT_EXAM_SUBMITTED_ID, EXAM_ID);
            return s.status;
        }, { timeout: 10_000 }).toBe('graded');

        submission = await findExamSubmission(STUDENT_EXAM_SUBMITTED_ID, EXAM_ID);
        expect(submission.manualGrades[QUESTION_EXAM_FR_ID].pointsAwarded).toBe(8);
        expect(submission.score).toBe(13); // 5 (auto-graded MC) + 8 (manual FR)
        expect(submission.pendingManualQuestionIds).toEqual([]);

        // The onSnapshot listener re-renders this exact card as the
        // read-only "already graded" summary — renderQuestionCard()'s own
        // is-graded branch drops data-question-id entirely (only the
        // still-editable branch carries it), so the editable card's own
        // locator must now resolve to nothing, replaced by exactly one
        // read-only summary card.
        await expect(page.locator(`[data-question-id="${QUESTION_EXAM_FR_ID}"]`)).toHaveCount(0);
        await expect(page.locator('.question-card.is-graded')).toHaveCount(1);
        await expect(page.locator('.already-graded-summary')).toContainText('8 / 10 pt');
    });

    test('10.8 — The Live Exam Monitor is strictly read-only, with no input fields anywhere', async ({ page }) => {
        forwardBrowserLogs(page);
        await loginAsTeacher(page, TEACHER_EXAM_ID, TEACHER_EXAM_PIN);
        await page.goto(liveMonitorUrl({ classId: CLASS_EXAM_ID, subjectId: SUBJECT_EXAM_ID, examId: EXAM_ID }));
        await expect(page.locator('#dashBody')).toBeVisible({ timeout: 15_000 });

        // No <input>, <textarea>, <select>, or <button> that isn't part of
        // the shared page chrome (topbar/sidebar) exists inside this page's
        // own dashboard body — this dashboard "has NO write paths of its
        // own" per live.js's own top-of-file comment. The topbar's own
        // read-only activeSemester <select> is explicitly excluded, since
        // it's shared chrome injected by layout-teachers.js, not something
        // this page itself offers as an action.
        await expect(page.locator('#dashBody input, #dashBody textarea, #dashBody button')).toHaveCount(0);
        await expect(page.locator('#dashBody select')).toHaveCount(0);
    });

    test('10.9 & 10.10 — Live presence chips and progress update in real time from a background mock student connection', async ({ page }) => {
        forwardBrowserLogs(page);
        await loginAsTeacher(page, TEACHER_EXAM_ID, TEACHER_EXAM_PIN);
        await page.goto(liveMonitorUrl({ classId: CLASS_EXAM_ID, subjectId: SUBJECT_EXAM_ID, examId: EXAM_ID }));
        await expect(page.locator('#dashBody')).toBeVisible({ timeout: 15_000 });

        const row = page.locator('.roster-row', { hasText: STUDENT_EXAM_INPROGRESS_ID });
        await expect(row).toBeVisible();

        // seed.js clears examPresence/{EXAM_ID} on every reseed, so this
        // student starts with no RTDB presence node at all —
        // buildRowModel() reads that as connectionState 'unknown' /
        // tabFocused null, rendering the neutral "No signal yet" chip and
        // no focus chip at all (renderRow()'s own tri-state branching).
        await expect(row).toContainText('No signal yet');
        await expect(row).not.toContainText('Tab Focused');
        await expect(row).not.toContainText('Tab Blurred');
        await expect(page.locator('#countConnected')).toHaveText('0');
        await expect(page.locator('#countDisconnected')).toHaveText('0');
        await expect(page.locator('#countBlurred')).toHaveText('0');

        // ── Background mock student connection #1: connects, tab focused,
        //    0 questions answered so far. No reload anywhere in this test —
        //    every assertion below proves the RTDB onValue() push, not a
        //    fresh page load. ──────────────────────────────────────────────
        await setExamPresence(EXAM_ID, STUDENT_EXAM_INPROGRESS_ID, {
            connectionState: 'connected', tabFocused: true, questionsAnswered: 0,
        });
        await expect(row).toContainText('Connected', { timeout: 10_000 });
        await expect(row).toContainText('Tab Focused');
        await expect(row).toContainText('0 questions answered');
        await expect(page.locator('#countConnected')).toHaveText('1');
        await expect(page.locator('#countBlurred')).toHaveText('0');

        // ── Progress ticks up as the mock student "answers" questions —
        //    singular/plural text both proven (1 question vs. 2
        //    questions). ────────────────────────────────────────────────
        await setExamPresence(EXAM_ID, STUDENT_EXAM_INPROGRESS_ID, {
            connectionState: 'connected', tabFocused: true, questionsAnswered: 1,
        });
        await expect(row).toContainText('1 question answered', { timeout: 10_000 });

        await setExamPresence(EXAM_ID, STUDENT_EXAM_INPROGRESS_ID, {
            connectionState: 'connected', tabFocused: true, questionsAnswered: 2,
        });
        await expect(row).toContainText('2 questions answered', { timeout: 10_000 });

        // ── The student switches tabs, then loses connection entirely —
        //    both alert-styled chips replace the ok-styled ones live, and
        //    the summary tiles track the flip. ───────────────────────────
        await setExamPresence(EXAM_ID, STUDENT_EXAM_INPROGRESS_ID, {
            connectionState: 'connected', tabFocused: false, questionsAnswered: 2,
        });
        await expect(row).toContainText('Tab Blurred', { timeout: 10_000 });
        await expect(row).not.toContainText('Tab Focused');
        await expect(page.locator('#countBlurred')).toHaveText('1');

        await setExamPresence(EXAM_ID, STUDENT_EXAM_INPROGRESS_ID, {
            connectionState: 'disconnected', tabFocused: false, questionsAnswered: 2,
        });
        await expect(row).toContainText('Disconnected', { timeout: 10_000 });
        await expect(row).not.toContainText('Connected');
        await expect(page.locator('#countConnected')).toHaveText('0');
        await expect(page.locator('#countDisconnected')).toHaveText('1');
    });
});
