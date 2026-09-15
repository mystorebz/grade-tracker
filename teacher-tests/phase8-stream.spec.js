// Phase 8 of docs/teacher-portal-test-plan.md — Class Stream
// (teacher/stream/stream.html), per the "ARCHITECTURAL MANDATE: Authorize
// Disk Writes & Advance to Phases 7 & 8".
//
// Covers:
//   8.1  Composer validation: a post with both Title and Details left blank
//        is blocked ("Write something before posting."); a Title-only post
//        (Details blank) is valid and saves — savePost()'s own guard is
//        `!title && !body`, an OR, not an AND.
//   8.2  Pinned posts sort above newer unpinned posts: getVisiblePosts()
//        floats every pinned post above every unpinned one in the Stream
//        view, even when a pinned post is chronologically OLDER than an
//        unpinned one.
//   8.3  Destructive-adjacent: edit an isolated, dynamically-created post,
//        Cancel discards the in-progress edit (server doc untouched), then
//        a real save persists the change.
//   8.4  Destructive: permanently deleting an isolated, dynamically-created
//        announcement via the real confirm()-gated flow — never touching
//        this subject's 4 pre-seeded fixture posts.
//   8.8  View toggle: the Lesson Plans view is STRICTLY filtered to
//        type:'lesson_plan' posts only (announcements excluded) — but the
//        Stream view is NOT symmetric: per getVisiblePosts()'s own source,
//        it only separates pinned from unpinned and does NOT exclude
//        lesson_plan posts, so a lesson plan appears in BOTH views. This is
//        real, read directly out of stream.js, not an assumption.
//
// SOURCE-OF-TRUTH METHODOLOGY (same as every prior phase in this suite):
// every selector, validation message, and confirm() string below was read
// directly out of teacher/stream/stream.js / stream.html and the shared
// assets/js/posts.js helper.
//
// DESTRUCTIVE SAFETY: 8.3 and 8.4 each create their OWN disposable post
// through the real Composer UI first — neither ever touches
// POST_PINNED_ID/POST_UNPINNED_NEW_ID/POST_UNPINNED_MID_ID/
// POST_LESSON_PLAN_ID, the shared fixtures 8.2 and 8.8 depend on.
//
// Requires (see playwright.config.js's header comment):
//   1. Firebase emulators already running.
//   2. `npm run seed` already run in this folder (or let beforeEach do it).

const { test, expect } = require('@playwright/test');
const {
    seed,
    TEACHER_STREAM_ID, TEACHER_STREAM_PIN,
    CLASS_STREAM_ID, SUBJECT_STREAM_ID, SUBJECT_STREAM_NAME,
    POST_PINNED_TITLE, POST_UNPINNED_NEW_TITLE, POST_UNPINNED_MID_TITLE,
    POST_LESSON_PLAN_TITLE,
    getPostDoc,
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

async function gotoStream(page) {
    await page.goto('/teacher/stream/stream.html');
    // Wait for the subject picker to resolve past "Loading subjects…" and
    // for the initial post-list fetch for that subject to settle.
    await expect(page.locator('#subjectSelect option', { hasText: SUBJECT_STREAM_NAME })).toHaveCount(1, { timeout: 15_000 });
    await expect(page.locator('#postList')).not.toContainText('Loading posts', { timeout: 15_000 });
}

function postCard(page, title) {
    return page.locator('.post-card', { hasText: title });
}

async function createPostViaUI(page, title, body) {
    await page.locator('#postTitle').fill(title);
    await page.locator('#postBody').fill(body || '');
    await page.locator('#savePostBtn').click();
    await expect(postCard(page, title)).toBeVisible({ timeout: 10_000 });
}

test.describe('Phase 8: Class Stream', () => {
    test.beforeEach(seed);

    test('8.1 — Composer validation: blank title+body is blocked; a title-only post is valid and saves', async ({ page }) => {
        forwardBrowserLogs(page);
        await loginAsTeacher(page, TEACHER_STREAM_ID, TEACHER_STREAM_PIN);
        await gotoStream(page);

        // -- Both blank: blocked. ---------------------------------------------
        await page.locator('#postTitle').fill('');
        await page.locator('#postBody').fill('');
        await page.locator('#savePostBtn').click();
        await expect(page.locator('#composerMsg')).toBeVisible({ timeout: 5_000 });
        await expect(page.locator('#composerMsg')).toContainText('Write something before posting.');

        // -- Title only (Details left blank): the guard is `!title && !body`,
        //    an OR — either field alone is enough to pass. ---------------------
        const uniqueTitle = `E2E Title-Only Post ${Date.now()}`;
        await page.locator('#postTitle').fill(uniqueTitle);
        await page.locator('#savePostBtn').click();
        await expect(postCard(page, uniqueTitle)).toBeVisible({ timeout: 10_000 });

        const created = await findPostByTitle(CLASS_STREAM_ID, SUBJECT_STREAM_ID, uniqueTitle);
        expect(created).not.toBeNull();
        expect(created.body).toBe('');
        expect(created.type).toBe('announcement');
        expect(created.pinned).toBe(false);

        // Composer resets to "New Post" after a successful save.
        await expect(page.locator('#composerTitle')).toHaveText('New Post');
        await expect(page.locator('#postTitle')).toHaveValue('');
    });

    test('8.2 — Pinned posts sort above newer unpinned posts in the Stream view', async ({ page }) => {
        forwardBrowserLogs(page);
        await loginAsTeacher(page, TEACHER_STREAM_ID, TEACHER_STREAM_PIN);
        await gotoStream(page);

        // Stream view is the default. The pinned post is the OLDEST of the
        // 4 seeded fixtures by createdAt, yet must render FIRST.
        const titles = await page.locator('#postList .post-card p.font-bold').allTextContents();
        const pinnedIdx = titles.indexOf(POST_PINNED_TITLE);
        const newIdx = titles.indexOf(POST_UNPINNED_NEW_TITLE);
        const midIdx = titles.indexOf(POST_UNPINNED_MID_TITLE);

        expect(pinnedIdx).toBeGreaterThanOrEqual(0);
        expect(newIdx).toBeGreaterThanOrEqual(0);
        expect(midIdx).toBeGreaterThanOrEqual(0);
        expect(pinnedIdx).toBeLessThan(newIdx);
        expect(pinnedIdx).toBeLessThan(midIdx);
        // Within the unpinned group, newest-first is preserved.
        expect(newIdx).toBeLessThan(midIdx);

        // The pinned post's card shows the pin indicator; the others don't.
        await expect(postCard(page, POST_PINNED_TITLE).locator('.fa-thumbtack')).toBeVisible();
        await expect(postCard(page, POST_UNPINNED_NEW_TITLE).locator('.fa-thumbtack')).toHaveCount(0);
    });

    test('8.3 — Editing an isolated post: Cancel discards the change, then a real save persists it', async ({ page }) => {
        forwardBrowserLogs(page);
        await loginAsTeacher(page, TEACHER_STREAM_ID, TEACHER_STREAM_PIN);
        await gotoStream(page);

        // Three DELIBERATELY unrelated titles (not one extended with
        // suffixes) — postCard()'s hasText match is a substring match, so a
        // renamed title that merely appended to the original would still
        // satisfy a "the old title is gone" check against its own prefix.
        const originalTitle = `E2E Edit Target Alpha ${Date.now()}`;
        const abandonedTitle = `E2E Edit Target Beta Should Not Persist ${Date.now()}`;
        const savedTitle = `E2E Edit Target Gamma Persisted ${Date.now()}`;
        await createPostViaUI(page, originalTitle, 'Original body text.');

        // -- Open for editing, change it, then CANCEL. -----------------------
        await postCard(page, originalTitle).locator('button[title="Edit"]').click();
        await expect(page.locator('#composerTitle')).toHaveText('Edit Post');
        await expect(page.locator('#postTitle')).toHaveValue(originalTitle);
        await expect(page.locator('#postBody')).toHaveValue('Original body text.');

        await page.locator('#postTitle').fill(abandonedTitle);
        await page.locator('#cancelEditBtn').click();

        // Composer resets; nothing was sent to the server.
        await expect(page.locator('#composerTitle')).toHaveText('New Post');
        await expect(page.locator('#postTitle')).toHaveValue('');
        await expect(postCard(page, abandonedTitle)).toHaveCount(0);
        await expect(postCard(page, originalTitle)).toBeVisible();

        const afterCancel = await findPostByTitle(CLASS_STREAM_ID, SUBJECT_STREAM_ID, originalTitle);
        expect(afterCancel).not.toBeNull();
        expect(afterCancel.body).toBe('Original body text.');

        // -- Re-open and actually save a change this time. --------------------
        await postCard(page, originalTitle).locator('button[title="Edit"]').click();
        await expect(page.locator('#composerTitle')).toHaveText('Edit Post');
        await page.locator('#postTitle').fill(savedTitle);
        await page.locator('#postBody').fill('Updated body text.');
        await page.locator('#postPinned').check();
        await page.locator('#savePostBtn').click();

        await expect(postCard(page, savedTitle)).toBeVisible({ timeout: 10_000 });
        await expect(postCard(page, originalTitle)).toHaveCount(0);

        // Same document id throughout (updatePost() patches in place, it
        // never creates a new doc) — the id from BEFORE the rename still
        // resolves to the renamed content.
        const afterSave = await getPostDoc(CLASS_STREAM_ID, SUBJECT_STREAM_ID, afterCancel.id);
        expect(afterSave.title).toBe(savedTitle);
        expect(afterSave.body).toBe('Updated body text.');
        expect(afterSave.pinned).toBe(true);
    });

    test('8.4 — Destructive: permanently deleting an isolated announcement via the real confirm()-gated flow', async ({ page }) => {
        forwardBrowserLogs(page);
        await loginAsTeacher(page, TEACHER_STREAM_ID, TEACHER_STREAM_PIN);
        await gotoStream(page);

        const disposableTitle = `E2E Delete Target ${Date.now()}`;
        await createPostViaUI(page, disposableTitle, 'Disposable — safe to delete.');
        const created = await findPostByTitle(CLASS_STREAM_ID, SUBJECT_STREAM_ID, disposableTitle);
        expect(created).not.toBeNull();

        let dialogMessage = null;
        page.once('dialog', async (dialog) => { dialogMessage = dialog.message(); await dialog.accept(); });
        await postCard(page, disposableTitle).locator('button[title="Delete"]').click();

        await expect.poll(() => dialogMessage, { timeout: 5_000 }).toBe(`Delete "${disposableTitle}"? This cannot be undone.`);
        await expect(postCard(page, disposableTitle)).toHaveCount(0, { timeout: 10_000 });

        const afterDelete = await getPostDoc(CLASS_STREAM_ID, SUBJECT_STREAM_ID, created.id);
        expect(afterDelete).toBeNull();

        // Reload and re-verify — proves the delete persisted server-side
        // (a fresh loadPostsForSubject()), not just optimistic local state.
        await page.reload();
        await expect(page.locator('#postList')).not.toContainText('Loading posts', { timeout: 15_000 });
        await expect(postCard(page, disposableTitle)).toHaveCount(0);

        // The 4 shared fixture posts are completely untouched.
        await expect(postCard(page, POST_PINNED_TITLE)).toBeVisible();
        await expect(postCard(page, POST_UNPINNED_NEW_TITLE)).toBeVisible();
        await expect(postCard(page, POST_UNPINNED_MID_TITLE)).toBeVisible();
    });

    test('8.8 — View toggle: Lesson Plans excludes announcements, but Stream does NOT exclude lesson plans', async ({ page }) => {
        forwardBrowserLogs(page);
        await loginAsTeacher(page, TEACHER_STREAM_ID, TEACHER_STREAM_PIN);
        await gotoStream(page);

        // Stream (default) view: ALL 4 fixtures show, lesson plan included —
        // getVisiblePosts()'s Stream branch only separates pinned/unpinned,
        // it never filters out type:'lesson_plan'.
        await expect(postCard(page, POST_PINNED_TITLE)).toBeVisible();
        await expect(postCard(page, POST_UNPINNED_NEW_TITLE)).toBeVisible();
        await expect(postCard(page, POST_UNPINNED_MID_TITLE)).toBeVisible();
        await expect(postCard(page, POST_LESSON_PLAN_TITLE)).toBeVisible();
        await expect(page.locator('#postListCount')).toHaveText('4 posts');
        // The lesson plan's card has no Edit button (renderPostCard omits it
        // for type:'lesson_plan') — only Delete.
        await expect(postCard(page, POST_LESSON_PLAN_TITLE).locator('button[title="Edit"]')).toHaveCount(0);
        await expect(postCard(page, POST_LESSON_PLAN_TITLE).locator('button[title="Delete"]')).toBeVisible();

        // Switch to Lesson Plans: STRICTLY only the lesson_plan post shows —
        // all 3 announcements (including the pinned one) disappear.
        await page.locator('#viewLessonPlansBtn').click();
        await expect(page.locator('#postListCount')).toHaveText('1 lesson plan');
        await expect(postCard(page, POST_LESSON_PLAN_TITLE)).toBeVisible();
        await expect(postCard(page, POST_PINNED_TITLE)).toHaveCount(0);
        await expect(postCard(page, POST_UNPINNED_NEW_TITLE)).toHaveCount(0);
        await expect(postCard(page, POST_UNPINNED_MID_TITLE)).toHaveCount(0);

        // Switching back to Stream restores all 4.
        await page.locator('#viewStreamBtn').click();
        await expect(page.locator('#postListCount')).toHaveText('4 posts');
        await expect(postCard(page, POST_PINNED_TITLE)).toBeVisible();
    });
});
