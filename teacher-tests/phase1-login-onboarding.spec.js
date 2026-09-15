// Phase 1 of docs/teacher-portal-test-plan.md — Login & Onboarding.
//
// Covers test cases 1.1, 1.2, 1.3, 1.4, 1.8, 1.9, 1.10 against the REAL
// teacher/login.html and teacher/onboarding/onboarding.html pages (not
// minted tokens), the same "drive the actual UI" philosophy exam-tests/
// already established in this repo.
//
// Deliberately NOT automated in this pass, per the architectural mandate
// that commissioned this suite:
//   1.5 (offline/network error during login) — needs real network-condition
//       simulation (e.g. page.route abort or context.setOffline), which
//       interacts awkwardly with this same page's Firebase Auth SDK retry
//       behavior; left for a dedicated resiliency pass rather than bolted
//       onto this one.
//   1.6 (confirming #forceResetModal / #onboardModal are dead UI) — a
//       negative/absence assertion with no user-facing trigger to drive;
//       better suited to a quick manual dev-tools check than an automated
//       spec, and isn't required for the Login/Onboarding *happy and error
//       paths* this pass is scoped to.
//
// Requires (see playwright.config.js's header comment):
//   1. Firebase emulators already running.
//   2. `npm run seed` already run in this folder (or let beforeAll do it).

const { test, expect } = require('@playwright/test');
const {
    seed,
    TEACHER_ID, TEACHER_PIN,
    TEACHER_ARCHIVED_ID, TEACHER_ARCHIVED_PIN,
    TEACHER_ONBOARDING_ID, TEACHER_ONBOARDING_PIN,
} = require('./seed');

function forwardBrowserLogs(page) {
    page.on('console', msg => console.log('BROWSER LOG:', msg.text()));
    page.on('pageerror', err => console.log('BROWSER ERROR:', err.message));
}

// The local static server this suite's webServer block starts (`npx serve`)
// redirects a request for *.html to the extension-less URL (e.g.
// /teacher/login.html -> /teacher/login) — confirmed against a real run,
// where every waitForURL/toHaveURL requiring a literal ".html" suffix timed
// out even though navigation had already succeeded. exam-tests/
// e2e-exam-flow.spec.js already works around exactly this by matching
// /home\/?/ rather than requiring ".html". This helper builds one regex that
// matches a given path whether or not ".html" (and/or a trailing slash)
// survives, so these assertions pass regardless of static-server behavior.
function urlFor(path) {
    const escaped = path.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    return new RegExp(`${escaped}(\\.html)?/?$`);
}

test.describe('Phase 1.1-1.4: Login', () => {
    test.beforeAll(async () => {
        await seed();
    });

    test('1.1 — valid login routes to home.html', async ({ page }) => {
        forwardBrowserLogs(page);

        await page.goto('/teacher/login.html');
        await page.locator('#loginTeacherId').fill(TEACHER_ID);
        await page.locator('#loginTeacherCode').fill(TEACHER_PIN);
        await page.locator('#loginBtn').click();

        await page.waitForURL(urlFor('/teacher/home/home'), { timeout: 15_000 });
        await expect(page.locator('#displayTeacherName')).toHaveText('E2E Complete Teacher');
    });

    test('1.2 — invalid PIN is rejected with the generic invalid-credentials message', async ({ page }) => {
        forwardBrowserLogs(page);

        await page.goto('/teacher/login.html');
        await page.locator('#loginTeacherId').fill(TEACHER_ID);
        await page.locator('#loginTeacherCode').fill('0000-wrong-pin');
        await page.locator('#loginBtn').click();

        await expect(page.locator('#loginMsg')).toBeVisible({ timeout: 15_000 });
        await expect(page.locator('#loginMsg')).toContainText('Invalid Teacher ID or PIN');
        // Must NOT have navigated away from the login page.
        await expect(page).toHaveURL(urlFor('/teacher/login'));
    });

    test('1.3 — nonexistent Teacher ID gets the SAME message as a wrong PIN (no field-level leak)', async ({ page }) => {
        forwardBrowserLogs(page);

        // Must be well-FORMED (matches functions/index.js's
        // /^T\d{2}-[A-Z0-9]{5}$/ shape check) but never seeded, so this
        // actually exercises the Firestore "not-found" path rather than
        // getting rejected earlier by the format check with a different
        // error message ("Invalid Teacher ID format." instead of "Invalid
        // Teacher ID or PIN.").
        await page.goto('/teacher/login.html');
        await page.locator('#loginTeacherId').fill('T26-NOPE1');
        await page.locator('#loginTeacherCode').fill(TEACHER_PIN);
        await page.locator('#loginBtn').click();

        await expect(page.locator('#loginMsg')).toBeVisible({ timeout: 15_000 });
        await expect(page.locator('#loginMsg')).toContainText('Invalid Teacher ID or PIN');
        await expect(page).toHaveURL(urlFor('/teacher/login'));
    });

    test('1.4 — archived teacher is blocked at login with a clear message, not silently treated as a bad password', async ({ page }) => {
        forwardBrowserLogs(page);

        // CORRECTED against real source (see functions/index.js's
        // mintTeacherToken, step "5. Check teacher is not archived", and
        // teacher/login.js's catch block): the archived check happens
        // server-side, INSIDE mintTeacherToken, before any custom token is
        // ever minted. It throws HttpsError('permission-denied', 'Account
        // archived. Contact your administrator.'), which login.js's catch
        // block maps straight into #loginMsg and leaves the user on the
        // login page — it never reaches signInWithCustomToken, so it can
        // never reach the tData.archived redirect-to-deactivated.html branch
        // further down login.js (that branch is dead code for THIS path;
        // whatever route still reaches it, if any, is out of this test's
        // scope). This test originally asserted a redirect to
        // deactivated/deactivated.html, which a real run proved wrong
        // (timed out — the app never navigates away at all).
        await page.goto('/teacher/login.html');
        await page.locator('#loginTeacherId').fill(TEACHER_ARCHIVED_ID);
        await page.locator('#loginTeacherCode').fill(TEACHER_ARCHIVED_PIN);
        await page.locator('#loginBtn').click();

        await expect(page.locator('#loginMsg')).toBeVisible({ timeout: 15_000 });
        await expect(page.locator('#loginMsg')).toContainText('Account archived');
        await expect(page).toHaveURL(urlFor('/teacher/login'));
    });
});

test.describe.serial('Phase 1.8-1.10: Onboarding flow (sequential — each step depends on the last)', () => {
    test.beforeAll(async () => {
        await seed();
    });

    test('1.8 — Step 1 (Security): validation, then a valid submit advances to Step 2', async ({ page }) => {
        forwardBrowserLogs(page);

        await page.goto('/teacher/login.html');
        await page.locator('#loginTeacherId').fill(TEACHER_ONBOARDING_ID);
        await page.locator('#loginTeacherCode').fill(TEACHER_ONBOARDING_PIN);
        await page.locator('#loginBtn').click();

        // teacher/login.js routes an incomplete profile straight to onboarding.
        await page.waitForURL(urlFor('/teacher/onboarding/onboarding'), { timeout: 15_000 });
        await expect(page.locator('#step1Container')).toBeVisible();
        await expect(page.locator('#step2Container')).toBeHidden();

        // -- PIN too short: blocked --
        await page.locator('#newPin').fill('123');
        await page.locator('#confirmPin').fill('123');
        await page.locator('#secQ1').selectOption({ index: 1 });
        await page.locator('#secA1').fill('answer one');
        await page.locator('#secQ2').selectOption({ index: 2 });
        await page.locator('#secA2').fill('answer two');
        await page.locator('#saveStep1Btn').click();
        await expect(page.locator('#step1Msg')).toBeVisible({ timeout: 5_000 });
        await expect(page.locator('#step1Container')).toBeVisible(); // still on Step 1

        // -- PIN / confirm mismatch: blocked --
        await page.locator('#newPin').fill('123456');
        await page.locator('#confirmPin').fill('654321');
        await page.locator('#saveStep1Btn').click();
        await expect(page.locator('#step1Msg')).toBeVisible({ timeout: 5_000 });
        await expect(page.locator('#step1Container')).toBeVisible();

        // -- Security questions: onboarding.js DOES ship a mutual-exclusion
        //    guard (setupSecurityQuestionLogic() disables/hides any option in
        //    one select whose value matches the other select's current
        //    value) — but onboarding.html's #secQ1 options (pet/school/
        //    street) and #secQ2 options (city/maiden/model) are two entirely
        //    DISJOINT value sets. No value from one list can ever equal a
        //    value in the other, so that guard can never actually disable
        //    anything with the current question lists — it's live code
        //    guarding against a collision that's structurally impossible
        //    today. A real run proved this: asserting an option in #secQ2
        //    became disabled after picking #secQ1's value timed out because
        //    no such option (matching value) exists in #secQ2 at all.
        //    Confirmed by reading both onboarding.html and onboarding.js
        //    directly rather than guessed — worth a mention to the team as a
        //    latent/inert code path, not something this test can exercise
        //    without the app first offering overlapping question choices.

        // -- Fully valid submit --
        await page.locator('#newPin').fill('123456');
        await page.locator('#confirmPin').fill('123456');
        await page.locator('#saveStep1Btn').click();

        await expect(page.locator('#step1Container')).toBeHidden({ timeout: 10_000 });
        await expect(page.locator('#step2Container')).toBeVisible();
    });

    test('1.9 — Step 2 (Profile): empty Country is blocked, a valid submit reaches home.html', async ({ page }) => {
        forwardBrowserLogs(page);

        // Continuing the SAME onboarding account from 1.8 — Firestore state
        // (requiresPinReset:false, securityQuestionsSet:true) persists in the
        // emulator across tests/pages, so logging in fresh here lands
        // directly on Step 2 rather than Step 1.
        await page.goto('/teacher/login.html');
        await page.locator('#loginTeacherId').fill(TEACHER_ONBOARDING_ID);
        await page.locator('#loginTeacherCode').fill('123456'); // the PIN set in 1.8
        await page.locator('#loginBtn').click();

        await page.waitForURL(urlFor('/teacher/onboarding/onboarding'), { timeout: 15_000 });
        await expect(page.locator('#step2Container')).toBeVisible();
        await expect(page.locator('#step1Container')).toBeHidden();

        // -- No country selected: only Country is required, so clearing it
        //    (if the control allows a blank selection) must block save. --
        const countrySelect = page.locator('#obCountry');
        const hasBlankOption = await countrySelect.locator('option[value=""]').count();
        if (hasBlankOption > 0) {
            await countrySelect.selectOption('');
            await page.locator('#saveStep2Btn').click();
            await expect(page.locator('#step2Msg')).toBeVisible({ timeout: 5_000 });
            await expect(page).toHaveURL(urlFor('/teacher/onboarding/onboarding')); // still here, not routed away
        }

        // -- Valid submit (Country only; every other Step 2 field is optional) --
        await countrySelect.selectOption({ index: 1 });
        await page.locator('#saveStep2Btn').click();

        await page.waitForURL(urlFor('/teacher/home/home'), { timeout: 15_000 });
    });

    test('1.10 — bypass: a fully-onboarded account skips onboarding entirely on next login', async ({ page }) => {
        forwardBrowserLogs(page);

        await page.goto('/teacher/login.html');
        await page.locator('#loginTeacherId').fill(TEACHER_ONBOARDING_ID);
        await page.locator('#loginTeacherCode').fill('123456');
        await page.locator('#loginBtn').click();

        // Must go straight to home.html — never touching onboarding.html at all.
        await page.waitForURL(urlFor('/teacher/home/home'), { timeout: 15_000 });
    });
});
