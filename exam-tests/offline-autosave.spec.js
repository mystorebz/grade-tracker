// Real network-cut offline-persistence test — replaces the flaky
// goOffline()-based simulation this project used in Phase 0/1 (per this
// session's own discussion: that approach calls the Firestore SDK's own
// internal offline flag rather than actually severing the connection, which
// doesn't reproduce a genuine dropped connection the same way, and was
// already flagged as unreliable before this suite existed).
//
// This test uses Playwright's browserContext.setOffline(true), which cuts
// the ACTUAL network at the browser context level — every request the page
// tries to make genuinely fails, exactly like a real Wi-Fi drop — then
// verifies take.js's per-question autosave (backed by Firestore's
// persistentLocalCache, configured in assets/js/firebase-init.js) queues the
// write locally and flushes it to the emulator once connectivity returns,
// with no data loss and no student-facing error left stuck on screen.
//
// Requires the same two preconditions as e2e-exam-flow.spec.js: emulators
// running, and this file's own beforeAll re-seeds via seed.js (idempotent,
// safe to run alongside the other spec in the same suite run).

const { test, expect } = require('@playwright/test');
const { seed, CLASS_ID, SUBJECT_ID, EXAM_ID, STUDENT_ID, STUDENT_PIN } = require('./seed');

const admin = require('firebase-admin');

test.describe('Exam offline autosave: real network cut, verify no data loss', () => {
    test.beforeAll(async () => {
        await seed();
    });

    test('answer entered while offline survives and syncs on reconnect', async ({ page, context }) => {
        // ── 1. Log in and open the exam while still online — the initial
        //      startExamAttempt call, presence registration, and exam config
        //      load all need real connectivity to complete; only the ANSWER
        //      entry itself happens offline below. ─────────────────────────
        await page.goto('/student/login.html');
        await page.locator('#loginStudentId').fill(STUDENT_ID);
        await page.locator('#loginPin').fill(STUDENT_PIN);
        await page.locator('#loginBtn').click();
        await page.waitForURL(/home\/?/, { timeout: 15_000 });

        await page.goto(`/student/exams/take.html#classId=${CLASS_ID}&subjectId=${SUBJECT_ID}&examId=${EXAM_ID}`);
        await expect(page.locator('#examQuestionList')).not.toBeEmpty({ timeout: 15_000 });

        // Capture the submission ID now, while online, via the Admin SDK —
        // needed later to verify the write actually landed server-side
        // after reconnect (a purely UI-level check could be fooled by
        // Firestore's local cache showing an optimistic "Saved" state that
        // never actually reaches the emulator).
        const submissionsSnap = await admin.firestore()
            .collection('students').doc(STUDENT_ID)
            .collection('exam_submissions')
            .where('examId', '==', EXAM_ID)
            .where('status', '==', 'in_progress')
            .limit(1)
            .get();
        expect(submissionsSnap.empty).toBe(false);
        const submissionRef = submissionsSnap.docs[0].ref;

        // ── 2. Cut the network for real ──────────────────────────────────
        await context.setOffline(true);

        // ── 3. Answer q2 (free_response) while genuinely offline. take.js's
        //      autosave has no special offline branch of its own — it just
        //      calls updateDoc(), and Firestore's persistentLocalCache
        //      (configured in assets/js/firebase-init.js) is what queues
        //      this write locally instead of the call rejecting outright. ──
        const offlineAnswerText = 'Answered while genuinely offline — this must survive reconnect.';
        await page.locator('textarea.exam-answer-input[data-question-id="q2"]').fill(offlineAnswerText);

        // The debounced autosave will fire (AUTOSAVE_DEBOUNCE_MS = 1200ms in
        // take.js) and attempt updateDoc() — with the network down, this
        // does NOT resolve/reject immediately; persistentLocalCache queues
        // it. Give the debounce timer time to fire before reconnecting, so
        // this genuinely tests "write queued while offline" rather than
        // "write started after we already reconnected."
        await page.waitForTimeout(2000);

        // Confirm the server has NOT received this write yet — this is the
        // actual proof the cut was real (not a no-op), not just an assumption.
        const whileOfflineSnap = await submissionRef.get();
        const whileOfflineValue = whileOfflineSnap.data().answers?.q2?.value;
        expect(whileOfflineValue).not.toBe(offlineAnswerText);

        // ── 4. Restore connectivity ───────────────────────────────────────
        await context.setOffline(false);

        // ── 5. Confirm the queued write flushes and reaches the emulator —
        //      polling the ACTUAL server document via the Admin SDK, not the
        //      page's own optimistic UI state, so this proves real
        //      persistence rather than a locally-cached illusion of success. ──
        await expect.poll(async () => {
            const snap = await submissionRef.get();
            return snap.data().answers?.q2?.value;
        }, { timeout: 20_000, message: 'waiting for the offline-queued autosave to flush to Firestore after reconnect' })
            .toBe(offlineAnswerText);

        // ── 6. Confirm the student-facing UI itself reflects success, not
        //      a stuck "Could not save — retrying…" message left over from
        //      the offline window (see take.js's saveAnswer() catch block,
        //      which is exactly the kind of stale-error-message class of bug
        //      this session already found and fixed once for examSubmitMsg —
        //      this test is what proves the SAME class of bug isn't present
        //      here too). ────────────────────────────────────────────────────
        await expect(page.locator('#qSaveStatus_q2')).toContainText('Saved', { timeout: 15_000 });
        await expect(page.locator('#qSaveStatus_q2')).not.toContainText('Could not save');

        // ── 7. Confirm the exam is still fully usable after the reconnect —
        //      submit still works, proving this wasn't a one-off write that
        //      happened to succeed while leaving the page in some broken
        //      in-between state. ──────────────────────────────────────────────
        await page.locator('input.exam-answer-input[data-question-id="q1"][value="4"]').check();
        await expect(page.locator('#qSaveStatus_q1')).toContainText('Saved', { timeout: 10_000 });

        await page.locator('#examSubmitBtn').click();
        await expect(page.locator('#examSubmitMsg')).toContainText('submitted', { timeout: 15_000 });
    });
});
