// Phase 9 of docs/teacher-portal-test-plan.md — Lesson Builder & Live
// Lessons (teacher/lessons/builder.html and teacher/lessons/live.html), per
// the "ARCHITECTURAL MANDATE: E2E Test Suite (Phases 9 & 10)".
//
// Covers:
//   9.1  Creation & Formats: the "New Lesson" format-choice modal creates
//        both a Slide Deck lesson (opens the slide-thumbnail builder,
//        starting from a single 'title' slide) and a Document lesson
//        (opens the Quill-based single-page builder, starting empty).
//   9.3  Slide Management: drag-to-reorder actually persists a new slide
//        order to Firestore on Save Draft; deleting slides down to the
//        last remaining one removes the per-slide delete control entirely
//        (renderSlideThumb only renders it when lessonDraft.slides.length
//        > 1) rather than allowing a click that would empty the deck.
//   9.4  State & Sync: a still-draft lesson creates no Class Stream
//        announcement; publishing one does — publishLesson() always saves
//        current draft content first, flips status, and fires a real
//        posts.js createPost() carrying linkedLessonId — confirmed here by
//        reading the actual announcement post back via Admin SDK, not just
//        trusting the UI's own "Published — posted to Class Stream" toast.
//   9.14 Live Sessions: clicking a published lesson's "Go Live" button
//        opens teacher/lessons/live.html in a NEW TAB (window.open(...,
//        '_blank') in builder.js's onLessonListClick) with the correct
//        lessonId/classId/subjectId/subjectName query params, and that tab
//        actually loads the lesson (not just a plausible-looking URL).
//   9.17 Live Sessions: once the live dashboard is presenting an
//        interactive_prompt block, the Live Responses panel appears and
//        updates in real time (onSnapshot) the moment a student response
//        doc is written — proven by writing directly via the Admin SDK
//        (this suite's stand-in for a second real student browser — see
//        seed.js's writeLiveResponse() for why) and asserting the UI
//        updates with NO reload.
//
// SOURCE-OF-TRUTH METHODOLOGY (same as every prior phase in this suite):
// every selector, class-toggle condition, and data shape below was read
// directly out of assets/js/lessons.js, assets/js/lessons/builder.js,
// teacher/lessons/builder.html, assets/js/lessons/live.js, and
// teacher/lessons/live.html — not guessed from the mandate's prose.
//
// Requires (see playwright.config.js's header comment):
//   1. Firebase emulators already running (Firestore 8080, Auth 9099,
//      Functions 5001, Database 9000).
//   2. `npm run seed` already run in this folder (or let beforeEach do it).

const { test, expect } = require('@playwright/test');
const {
    seed,
    TEACHER_LESSON_ID, TEACHER_LESSON_PIN,
    CLASS_LESSON_ID, CLASS_LESSON_NAME, SUBJECT_LESSON_ID, SUBJECT_LESSON_NAME,
    LESSON_SLIDES_ID, SLIDE_REORDER_A_ID, SLIDE_REORDER_B_ID, SLIDE_REORDER_C_ID,
    LESSON_LIVE_ID, SLIDE_LIVE_PROMPT_ID,
    getLessonDoc,
    writeLiveResponse,
    findPostByTitle,
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

async function gotoBuilder(page) {
    await page.goto('/teacher/lessons/builder.html');
    // The picker view's subject select starts as "Loading subjects…" and is
    // repopulated by renderSubjectOptions() — waiting for a real option
    // (not the placeholder) is the reliable "ready" signal, same pattern
    // Phase 5/6's own subject-picker waits already use.
    await expect(page.locator('#subjectSelect option').first()).not.toHaveText('Loading subjects…', { timeout: 15_000 });
}

function lessonCard(page, lessonId) {
    return page.locator(`[data-lesson-id="${lessonId}"]`);
}

test.describe('Phase 9: Lesson Builder & Live Lessons', () => {
    test.beforeEach(seed);

    test('9.1 — "New Lesson" creates both a Slide Deck lesson and a Document lesson', async ({ page }) => {
        forwardBrowserLogs(page);
        await loginAsTeacher(page, TEACHER_LESSON_ID, TEACHER_LESSON_PIN);
        await gotoBuilder(page);

        // ── Slide Deck ────────────────────────────────────────────────────
        await page.locator('#newLessonBtn').click();
        await expect(page.locator('#formatChoiceOverlay')).toBeVisible();
        await page.locator('[data-format="slides"]').click();

        // Opens the Slide builder view (not the Document view), starting
        // from newSlide('title') per createLesson()'s own format branch —
        // one thumbnail, and the canvas shows the Title slide's Heading
        // field.
        await expect(page.locator('#builderView')).toBeVisible();
        await expect(page.locator('#docBuilderView')).toBeHidden();
        await expect(page.locator('#slideThumbList [data-slide-index]')).toHaveCount(1);
        await expect(page.locator('#slideCanvas [data-field="heading"]')).toBeVisible();
        await expect(page.locator('#statusPill')).toHaveText('Draft');

        await page.locator('#backToListBtn').click();
        await expect(page.locator('#lessonPickerView')).toBeVisible();

        // ── Document ──────────────────────────────────────────────────────
        await page.locator('#newLessonBtn').click();
        await page.locator('[data-format="document"]').click();

        await expect(page.locator('#docBuilderView')).toBeVisible();
        await expect(page.locator('#builderView')).toBeHidden();
        await expect(page.locator('#docStatusPill')).toHaveText('Draft');
        // Quill's own editing surface should be mounted and empty (a fresh
        // richtext block starts with contentHtml: '').
        await expect(page.locator('#docEditor .ql-editor')).toBeVisible();

        // Both lessons now exist for this subject — confirms creation
        // actually persisted, not just that the builder view swapped.
        await page.locator('#docBackToListBtn').click();
        await expect(page.locator('#lessonListCount')).toContainText('4 lessons'); // 2 fixtures + the 2 just created
    });

    test('9.3 — Slide reorder persists on Save, and the last remaining slide cannot be deleted', async ({ page }) => {
        forwardBrowserLogs(page);
        await loginAsTeacher(page, TEACHER_LESSON_ID, TEACHER_LESSON_PIN);
        await gotoBuilder(page);

        await lessonCard(page, LESSON_SLIDES_ID).locator('[data-action="open"]').click();
        await expect(page.locator('#builderView')).toBeVisible();

        const thumbs = page.locator('#slideThumbList [data-slide-index]');
        await expect(thumbs).toHaveCount(3);
        // Fixture order is A, B, C.
        await expect(thumbs.nth(0)).toContainText('Slide A');
        await expect(thumbs.nth(1)).toContainText('Slide B');
        await expect(thumbs.nth(2)).toContainText('Slide C');

        // Drag Slide C (index 2) to the top — HTML5 drag/drop, handled by
        // builder.js's own document-level dragstart/dragover/drop listeners
        // (see that file's own comment: "minimal HTML5 drag/drop, no
        // library"), so Playwright's dragTo() exercises the real listeners
        // rather than a synthetic reorder.
        await thumbs.nth(2).dragTo(thumbs.nth(0));

        await expect(thumbs.nth(0)).toContainText('Slide C');
        await expect(thumbs.nth(1)).toContainText('Slide A');
        await expect(thumbs.nth(2)).toContainText('Slide B');

        await page.locator('#saveBtn').click();
        await expect(page.locator('#saveMsg')).toContainText('Saved', { timeout: 10_000 });

        // Reload and re-verify from a FRESH load (renderAll() rebuilds the
        // thumb list from the reloaded lessonDraft) — proves the reorder
        // persisted server-side, not just in the open tab's own DOM state.
        await page.reload();
        await expect(page.locator('#subjectSelect option').first()).not.toHaveText('Loading subjects…', { timeout: 15_000 });
        await lessonCard(page, LESSON_SLIDES_ID).locator('[data-action="open"]').click();
        const reloadedThumbs = page.locator('#slideThumbList [data-slide-index]');
        await expect(reloadedThumbs.nth(0)).toContainText('Slide C');
        await expect(reloadedThumbs.nth(1)).toContainText('Slide A');
        await expect(reloadedThumbs.nth(2)).toContainText('Slide B');

        const persisted = await getLessonDoc(CLASS_LESSON_ID, SUBJECT_LESSON_ID, LESSON_SLIDES_ID);
        expect(persisted.slides.map(s => s.id)).toEqual([SLIDE_REORDER_C_ID, SLIDE_REORDER_A_ID, SLIDE_REORDER_B_ID]);

        // Delete down to one slide — each delete removes the FIRST
        // thumbnail's own delete control (⋯ its own [data-action=
        // "delete-slide"] button), confirming each click via the real
        // confirm('Delete this slide?') dialog.
        for (let i = 0; i < 2; i++) {
            let dialogMessage = null;
            page.once('dialog', async (dialog) => { dialogMessage = dialog.message(); await dialog.accept(); });
            await reloadedThumbs.first().locator('[data-action="delete-slide"]').click();
            await expect.poll(() => dialogMessage, { timeout: 5_000 }).toBe('Delete this slide?');
        }

        // Exactly one slide left — renderSlideThumb() only renders
        // [data-action="delete-slide"] when lessonDraft.slides.length > 1,
        // so with one slide remaining the control must not exist at all
        // (never merely disabled, and never blocked by a confirm() a
        // teacher could still accidentally dismiss-through).
        await expect(reloadedThumbs).toHaveCount(1);
        await expect(page.locator('[data-action="delete-slide"]')).toHaveCount(0);
    });

    test('9.4 — A draft lesson posts nothing to Class Stream; publishing it does', async ({ page }) => {
        forwardBrowserLogs(page);
        await loginAsTeacher(page, TEACHER_LESSON_ID, TEACHER_LESSON_PIN);
        await gotoBuilder(page);

        await page.locator('#newLessonBtn').click();
        await page.locator('[data-format="slides"]').click();
        await expect(page.locator('#builderView')).toBeVisible();

        const draftTitle = `E2E Publish Test Lesson ${Date.now()}`;
        await page.locator('#lessonTitleInput').fill(draftTitle);
        await page.locator('#saveBtn').click();
        await expect(page.locator('#saveMsg')).toContainText('Saved', { timeout: 10_000 });

        // Still a draft — no announcement should exist for this title yet.
        await expect(page.locator('#statusPill')).toHaveText('Draft');
        let announcement = await findPostByTitle(CLASS_LESSON_ID, SUBJECT_LESSON_ID, `New Lesson: ${draftTitle}`);
        expect(announcement).toBeNull();

        // Publish — onPublishToggle() saves current content first, flips
        // status, and (per publishLesson()'s own comment) fires a real
        // posts.js createPost() carrying linkedLessonId.
        await page.locator('#publishBtn').click();
        await expect(page.locator('#saveMsg')).toContainText('Published', { timeout: 10_000 });
        await expect(page.locator('#statusPill')).toHaveText('Published');
        await expect(page.locator('#publishBtnLabel')).toHaveText('Unpublish');

        announcement = await findPostByTitle(CLASS_LESSON_ID, SUBJECT_LESSON_ID, `New Lesson: ${draftTitle}`);
        expect(announcement).not.toBeNull();
        expect(announcement.type).toBe('announcement');
        expect(announcement.linkedLessonId).toBeTruthy();

        const persisted = await getLessonDoc(CLASS_LESSON_ID, SUBJECT_LESSON_ID, announcement.linkedLessonId);
        expect(persisted.status).toBe('published');
        expect(persisted.title).toBe(draftTitle);
    });

    test('9.14 — "Go Live" on a published lesson opens live.html in a new tab with the correct context', async ({ page, context }) => {
        forwardBrowserLogs(page);
        await loginAsTeacher(page, TEACHER_LESSON_ID, TEACHER_LESSON_PIN);
        await gotoBuilder(page);

        // Only a PUBLISHED lesson's card renders the "Go Live" button at
        // all (renderLessonCard's own isPublished-gated markup) — confirm
        // the draft-reorder fixture has none, then use the published one.
        await expect(lessonCard(page, LESSON_SLIDES_ID).locator('[data-action="golive"]')).toHaveCount(0);

        const [liveTab] = await Promise.all([
            context.waitForEvent('page'),
            lessonCard(page, LESSON_LIVE_ID).locator('[data-action="golive"]').click(),
        ]);
        await liveTab.waitForLoadState();

        const liveUrl = new URL(liveTab.url());
        expect(liveUrl.pathname).toContain('/teacher/lessons/live.html');
        expect(liveUrl.searchParams.get('lessonId')).toBe(LESSON_LIVE_ID);
        expect(liveUrl.searchParams.get('classId')).toBe(CLASS_LESSON_ID);
        expect(liveUrl.searchParams.get('subjectId')).toBe(SUBJECT_LESSON_ID);
        expect(liveUrl.searchParams.get('subjectName')).toBe(SUBJECT_LESSON_NAME);

        // The route doesn't just carry the right params — the dashboard
        // actually starts the live session and renders the lesson.
        await expect(liveTab.locator('#dashLoader')).toBeHidden({ timeout: 15_000 });
        await expect(liveTab.locator('#dashBody')).toBeVisible();
        await expect(liveTab.locator('#lessonTitleLabel')).toHaveText('E2E Live Session Lesson');

        await liveTab.close();
    });

    test('9.17 — The Live Responses panel appears for an Interactive Prompt block and updates live, no reload', async ({ page, context }) => {
        forwardBrowserLogs(page);
        await loginAsTeacher(page, TEACHER_LESSON_ID, TEACHER_LESSON_PIN);
        await gotoBuilder(page);

        const [liveTab] = await Promise.all([
            context.waitForEvent('page'),
            lessonCard(page, LESSON_LIVE_ID).locator('[data-action="golive"]').click(),
        ]);
        forwardBrowserLogs(liveTab);
        await expect(liveTab.locator('#dashBody')).toBeVisible({ timeout: 15_000 });

        // Block 1 of 2 is the 'title' slide — no responses panel for it.
        await expect(liveTab.locator('#blockCounter')).toHaveText('Block 1 of 2');
        await expect(liveTab.locator('#responsesPanel')).toBeHidden();

        // Advance to block 2, the interactive_prompt — the panel appears
        // and starts empty (registerResponsesListener() is (re)registered
        // per navigateTo(), per renderCurrentBlock()'s own comment).
        await liveTab.locator('#nextBlockBtn').click();
        await expect(liveTab.locator('#blockCounter')).toHaveText('Block 2 of 2');
        await expect(liveTab.locator('#responsesPanel')).toBeVisible();
        await expect(liveTab.locator('#responsesEmpty')).toBeVisible();
        await expect(liveTab.locator('#responsesCount')).toHaveText('0 responses');

        // Write a response directly via the Admin SDK (this suite's
        // stand-in for a second real student browser — see seed.js's
        // writeLiveResponse() for why) and confirm it appears on the
        // ALREADY-OPEN tab with NO reload — proving the onSnapshot push,
        // not just that the data is correct.
        await writeLiveResponse(
            CLASS_LESSON_ID, SUBJECT_LESSON_ID, LESSON_LIVE_ID,
            'S26-LIVE01', 'E2E Live Student', SLIDE_LIVE_PROMPT_ID, 'interactive_prompt',
            'Oxygen, because it lets us breathe.'
        );

        await expect(liveTab.locator('#responsesCount')).toHaveText('1 response', { timeout: 10_000 });
        await expect(liveTab.locator('#responsesEmpty')).toBeHidden();
        await expect(liveTab.locator('.response-card')).toHaveCount(1);
        await expect(liveTab.locator('.response-card')).toContainText('E2E Live Student');
        await expect(liveTab.locator('.response-card')).toContainText('Oxygen, because it lets us breathe.');

        // A second response from a different student pushes the count to
        // 2 and both cards render — proves this isn't a one-shot listener.
        await writeLiveResponse(
            CLASS_LESSON_ID, SUBJECT_LESSON_ID, LESSON_LIVE_ID,
            'S26-LIVE02', 'E2E Live Student Two', SLIDE_LIVE_PROMPT_ID, 'interactive_prompt',
            'Carbon, it forms the backbone of all known life.'
        );
        await expect(liveTab.locator('#responsesCount')).toHaveText('2 responses', { timeout: 10_000 });
        await expect(liveTab.locator('.response-card')).toHaveCount(2);

        await liveTab.close();
    });
});
