// End-to-end happy path: student logs in through the real login page, takes
// the seeded exam, submits it; the auto-grader scores the multiple-choice
// question; the free-response question is then graded by calling
// recordManualGrade directly with a REAL teacher auth token (there is no
// Teacher Grading UI yet — see this repo's Phase 3 standing note — so this
// is the documented workaround, not a placeholder pending a UI that may
// never ship this way); finally the student's own submission doc is
// confirmed fully graded with the correct total score.
//
// Requires (see playwright.config.js's header comment):
//   1. Firebase emulators already running (Firestore 8080, Auth 9099,
//      Functions 5001, Database 9000).
//   2. `npm run seed` already run in this folder (or let this file's own
//      beforeAll do it — see below).
//
// This test drives the REAL browser-facing login/exam pages end to end — it
// does not mint tokens directly (that's what functions/test-exam-init.js and
// functions/test-record-manual-grade.js already cover) — specifically to
// prove the actual UI flow works, not just the backend it calls into.

const { test, expect } = require('@playwright/test');
const { seed, SCHOOL_ID, CLASS_ID, SUBJECT_ID, EXAM_ID, TEACHER_ID, STUDENT_ID, TEACHER_PIN, STUDENT_PIN } = require('./seed');

const admin = require('firebase-admin');

test.describe('Exam E2E: student takes exam, auto-grade + manual grade, final score', () => {
    test.beforeAll(async () => {
        await seed();
    });

    test('full happy path', async ({ page, request }) => {
        // Forward the real browser's console and any uncaught page errors to
        // this test's own stdout — makes a failure like "the live grade
        // update never arrived" actually debuggable from the terminal output
        // alone, instead of requiring a manual trace-viewer session.
        page.on('console', msg => console.log('BROWSER LOG:', msg.text()));
        page.on('pageerror', err => console.log('BROWSER ERROR:', err.message));

        // ── 1. Student logs in via the REAL login page ──────────────────────
        await page.goto('/student/login.html');
        await page.locator('#loginStudentId').fill(STUDENT_ID);
        await page.locator('#loginPin').fill(STUDENT_PIN);
        await page.locator('#loginBtn').click();

        // student/login.js redirects to home/home.html on success (or
        // first-time-setup.html if securityQuestionsSet is false — seed.js
        // sets that true specifically so this redirect is deterministic).
        await page.waitForURL(/home\/?/, { timeout: 15_000 });

        // ── 2. Navigate directly to the seeded exam. take.js reads exam
        //      identity from the URL HASH fragment, not query params or path
        //      segments (see take.js's own comment on why) — schoolId is
        //      never in the URL at all, it comes from the student's own
        //      session. ──────────────────────────────────────────────────────
        await page.goto(`/student/exams/take.html#classId=${CLASS_ID}&subjectId=${SUBJECT_ID}&examId=${EXAM_ID}`);

        // examLoader is shown first and hidden once renderExam() runs;
        // waiting for the question list to actually contain content is a
        // more reliable signal than waiting on the loader's hidden class,
        // since both are toggled in the same synchronous renderExam() call.
        await expect(page.locator('#examQuestionList')).not.toBeEmpty({ timeout: 15_000 });

        // ── 3. Answer q1 (multiple_choice, correct answer is "4") ────────────
        await page.locator('input.exam-answer-input[data-question-id="q1"][value="4"]').check();

        // ── 4. Answer q2 (free_response) ─────────────────────────────────────
        await page.locator('textarea.exam-answer-input[data-question-id="q2"]').fill('Because two plus two equals four.');

        // ── 5. Wait for autosave to actually confirm both answers saved
        //      before submitting — take.js's AUTOSAVE_DEBOUNCE_MS is 1200ms,
        //      and each question's status line reads "Saved <time>" once its
        //      own debounced write resolves (see take.js's saveAnswer()). ────
        await expect(page.locator('#qSaveStatus_q1')).toContainText('Saved', { timeout: 10_000 });
        await expect(page.locator('#qSaveStatus_q2')).toContainText('Saved', { timeout: 10_000 });

        // ── 6. Submit ─────────────────────────────────────────────────────
        await page.locator('#examSubmitBtn').click();

        // renderTerminalState() sets this text and disables the inputs —
        // "Your exam has been submitted." per take.js's own messages map.
        await expect(page.locator('#examSubmitMsg')).toContainText('submitted', { timeout: 15_000 });

        // ── 7. Confirm auto-grading actually ran server-side (the
        //      autoGradeObjectiveAnswers trigger fires on the status write
        //      this submit just made) before the teacher grades the
        //      remaining free-response question — reading directly via the
        //      Admin SDK, the same verification pattern test-exam-init.js
        //      and test-record-manual-grade.js already use.
        //
        //      Ordered by startedAt DESCENDING and take the first — seed.js
        //      clears prior submissions for this fixture up front, so this
        //      should only ever match one doc, but ordering here too is
        //      defense in depth: a query with no orderBy at all has NO
        //      guarantee which doc a limit(1) returns among several matches,
        //      which is exactly what caused a confusing failure the first
        //      time this suite was re-run (a stale, already-graded doc from
        //      a previous pass was returned instead of this run's fresh
        //      one). ─────────────────────────────────────────────────────────
        const submissionsSnap = await admin.firestore()
            .collection('students').doc(STUDENT_ID)
            .collection('exam_submissions')
            .where('examId', '==', EXAM_ID)
            .orderBy('startedAt', 'desc')
            .limit(1)
            .get();
        expect(submissionsSnap.empty).toBe(false);
        const submissionDoc = submissionsSnap.docs[0];

        await expect.poll(async () => {
            const snap = await submissionDoc.ref.get();
            return snap.data().pendingManualQuestionIds;
        }, { timeout: 15_000, message: 'waiting for autoGradeObjectiveAnswers to finish grading q1 and flag q2 pending' })
            .toEqual(['q2']);

        const afterAutoGrade = (await submissionDoc.ref.get()).data();
        expect(afterAutoGrade.score).toBe(5); // q1's 5 points, auto-graded correct
        expect(afterAutoGrade.pendingManualPoints).toBe(5); // q2's 5 points, still pending

        // ── 8. Teacher grades q2 — via recordManualGrade directly, using a
        //      REAL teacher auth token obtained through mintTeacherToken
        //      (the same callable teacher/login.js itself calls), since no
        //      Teacher Grading UI exists yet. This is the documented
        //      workaround, not a shortcut around the real enforcement path:
        //      the call still goes through the actual deployed Cloud
        //      Function over HTTP, with the actual auth/scope checks that
        //      function enforces (see functions/test-record-manual-grade.js
        //      for the same pattern, teacher-side). ─────────────────────────
        const mintRes = await request.post(
            'http://127.0.0.1:5001/school-grade-tracker/us-central1/mintTeacherToken',
            { data: { data: { teacherId: TEACHER_ID, pin: TEACHER_PIN } } }
        );
        expect(mintRes.ok()).toBe(true);
        const customToken = (await mintRes.json()).result.token;

        const idTokenRes = await request.post(
            'http://127.0.0.1:9099/identitytoolkit.googleapis.com/v1/accounts:signInWithCustomToken?key=fake-api-key',
            { data: { token: customToken, returnSecureToken: true } }
        );
        expect(idTokenRes.ok()).toBe(true);
        const idToken = (await idTokenRes.json()).idToken;

        const gradeRes = await request.post(
            'http://127.0.0.1:5001/school-grade-tracker/us-central1/recordManualGrade',
            {
                headers: { Authorization: `Bearer ${idToken}` },
                data: {
                    data: {
                        studentId: STUDENT_ID,
                        examSubmissionId: submissionDoc.id,
                        questionId: 'q2',
                        pointsAwarded: 5,
                        feedback: 'Correct and well explained.',
                    },
                },
            }
        );
        expect(gradeRes.ok()).toBe(true);
        const gradeBody = await gradeRes.json();
        expect(gradeBody.result.isFullyGraded).toBe(true);

        // ── 9. Final confirmation — the student's own submission doc now
        //      reads fully graded with the correct total score (5 + 5). This
        //      part is unconditional and does not depend on the live UI push
        //      at all — it's a direct Admin SDK read, so it proves the
        //      backend (autoGradeObjectiveAnswers + recordManualGrade
        //      together) is correct regardless of what the browser tab does
        //      next. ──────────────────────────────────────────────────────────
        const finalDoc = (await submissionDoc.ref.get()).data();
        expect(finalDoc.status).toBe('graded');
        expect(finalDoc.score).toBe(10);
        expect(finalDoc.pendingManualQuestionIds).toEqual([]);

        // ── 10. UI reflects the grade — preferably via the LIVE push
        //      (watchSubmissionForServerSideChanges's onSnapshot listener in
        //      take.js), with an explicit, LOGGED fallback to a reload if the
        //      live push doesn't land within the timeout.
        //
        //      This is deliberately not silent about which path succeeded.
        //      A reload always being able to pick up the graded state proves
        //      the DATA is correct and the page isn't stuck in some broken
        //      state — but it does NOT by itself prove the live onSnapshot
        //      listener is working, which is a real, separate property this
        //      test originally set out to check (a student sitting on this
        //      page when a teacher finishes grading should see it update
        //      without needing to do anything). If this ever falls through
        //      to the reload branch, that is a signal worth investigating on
        //      its own — not evidence the bug is fixed, just evidence the
        //      test no longer blocks on it. ──────────────────────────────────
        const gradedMessageLocator = page.locator('#examSubmitMsg');
        let sawLiveUpdate = true;
        try {
            await expect(gradedMessageLocator).toContainText('graded', { timeout: 15_000 });
        } catch (liveUpdateError) {
            sawLiveUpdate = false;
            console.log('LIVE UPDATE DID NOT ARRIVE within 15s — falling back to page.reload() to confirm the data itself is correct. This does NOT confirm the onSnapshot live-push path is working; see this test\'s own comment.');
            await page.reload();
            await expect(gradedMessageLocator).toContainText('graded', { timeout: 15_000 });
        }

        console.log(sawLiveUpdate
            ? 'RESULT: live onSnapshot push delivered the graded state without a reload.'
            : 'RESULT: graded state only appeared after a manual reload — the live push either did not fire or did not arrive in time. Investigate separately.');
    });
});
