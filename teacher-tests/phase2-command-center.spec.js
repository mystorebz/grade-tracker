// Phase 2 of docs/teacher-portal-test-plan.md — Command Center
// (teacher/home/home.html).
//
// Covers test cases 2.1, 2.2, 2.4, 2.9, 2.13, per the architectural mandate
// that commissioned this suite.
//
// NOTE ON "mocking the API/Firestore responses": the mandate that requested
// this suite asked for stat-card data (2.1) to come from mocked API/Firestore
// responses. This suite instead seeds real documents into the Firestore
// EMULATOR via the Admin SDK (exactly the pattern exam-tests/ already
// established in this repo) rather than intercepting network calls. That's a
// deliberate substitution, not an oversight: the Firebase JS SDK talks to
// Firestore over a WebChannel/long-polling transport, not plain fetch/XHR
// calls Playwright's page.route() can cleanly intercept, and this repo
// already has a working, emulator-based seeding convention for exactly this
// kind of test. The net effect for these test cases is the same — home.html
// receives deterministic, known-in-advance data — just produced by seeding
// the emulator instead of stubbing the network.
//
// seed() is re-run in beforeEach (not just beforeAll) because test 2.2
// mutates a seeded student's grade directly via the Admin SDK to prove the
// At-Risk banner reacts to a threshold crossing; re-seeding before every
// test restores the known baseline (60% / 67% / 95%) so test order can never
// affect test 2.4's results.
//
// Requires (see playwright.config.js's header comment):
//   1. Firebase emulators already running.
//   2. This file seeds itself (via beforeEach) — no manual `npm run seed`
//      step is required to run just this spec, though it's harmless to do so.

const { test, expect } = require('@playwright/test');
const {
    seed, setStudentScore,
    TEACHER_ID, TEACHER_PIN,
    TEACHER_EMPTY_ID, TEACHER_EMPTY_PIN,
    STUDENT_BELOW_65_ID, STUDENT_67_ID,
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

async function loginAsTeacher(page, teacherId, pin) {
    await page.goto('/teacher/login.html');
    await page.locator('#loginTeacherId').fill(teacherId);
    await page.locator('#loginTeacherCode').fill(pin);
    await page.locator('#loginBtn').click();
    await page.waitForURL(urlFor('/teacher/home/home'), { timeout: 15_000 });
}

// Command Center content only becomes visible once fetchMetrics() finishes
// the FULL path (see home.js) — waiting on analyticsSection losing its
// "hidden" class is a more reliable completion signal than waiting on the
// loader disappearing, since a teacher with zero students hides the loader
// too but never reveals analyticsSection at all (see test 2.13 below).
async function waitForCommandCenter(page) {
    await expect(page.locator('#analyticsSection')).not.toHaveClass(/hidden/, { timeout: 15_000 });
}

test.describe('Phase 2: Command Center dashboard', () => {
    test.beforeEach(async () => {
        await seed();
    });

    test('2.1 — stat cards reflect seeded roster/grade counts', async ({ page }) => {
        forwardBrowserLogs(page);
        await loginAsTeacher(page, TEACHER_ID, TEACHER_PIN);
        await waitForCommandCenter(page);

        // 3 seeded students, 3 seeded grades (one each), exactly 1 below 65%.
        await expect(page.locator('#stat-students')).toHaveText('3');
        await expect(page.locator('#stat-grades')).toHaveText('3');
        await expect(page.locator('#stat-risk')).toHaveText('1');
    });

    test('2.2 — At-Risk banner shows while a student is below 65%, and clears once they cross above it', async ({ page }) => {
        forwardBrowserLogs(page);
        await loginAsTeacher(page, TEACHER_ID, TEACHER_PIN);
        await waitForCommandCenter(page);

        await expect(page.locator('#atRiskBanner')).toBeVisible();
        await expect(page.locator('#atRiskMsg')).toHaveText(
            '1 student is averaging below 65% this period.'
        );

        // Raise the at-risk student's score from 60% to 70% directly via the
        // Admin SDK (bypassing the grading UI, which Phase 5 of the manual
        // plan covers on its own), then reload and confirm the banner reacts.
        await setStudentScore(STUDENT_BELOW_65_ID, 70);
        await page.reload();
        await waitForCommandCenter(page);

        await expect(page.locator('#atRiskBanner')).toBeHidden();
        await expect(page.locator('#stat-risk')).toHaveText('0');
    });

    test('2.4 — At-Risk Flagging (<70%) includes a 67% student that "Needs Attention" (<65%) correctly excludes', async ({ page }) => {
        forwardBrowserLogs(page);
        await loginAsTeacher(page, TEACHER_ID, TEACHER_PIN);
        await waitForCommandCenter(page);

        // stat-risk (the <65% "Needs Attention" count) must be exactly 1 —
        // the 67% student must NOT be counted here.
        await expect(page.locator('#stat-risk')).toHaveText('1');

        // The At-Risk Flagging widget uses a wider <70% net, so it must list
        // BOTH the 60% student and the 67% student.
        const flagList = page.locator('#ccAtRiskFlagList');
        await expect(flagList).toContainText('E2E Student Below65');
        await expect(flagList).toContainText('E2E Student At67');
    });

    test('2.9 — Quick Actions route to the correct pages', async ({ page }) => {
        forwardBrowserLogs(page);
        await loginAsTeacher(page, TEACHER_ID, TEACHER_PIN);

        const destinations = [
            { hrefFragment: 'roster.html', urlPattern: urlFor('/teacher/roster/roster') },
            { hrefFragment: 'grade_form.html', urlPattern: urlFor('/teacher/grade_form/grade_form') },
            { hrefFragment: 'subjects.html', urlPattern: urlFor('/teacher/subjects/subjects') },
            { hrefFragment: 'gradebook.html', urlPattern: urlFor('/teacher/gradebook/gradebook') },
        ];

        for (const { hrefFragment, urlPattern } of destinations) {
            await page.goto('/teacher/home/home.html');
            await page.locator(`a.quick-action-card[href*="${hrefFragment}"]`).click();
            await page.waitForURL(urlPattern, { timeout: 15_000 });
        }
    });

    test('2.13 — a teacher with zero students sees empty states, not broken/blank widgets', async ({ page }) => {
        forwardBrowserLogs(page);
        await loginAsTeacher(page, TEACHER_EMPTY_ID, TEACHER_EMPTY_PIN);

        // The stat cards live OUTSIDE #analyticsSection and are always
        // populated directly by fetchMetrics(), even on its zero-student
        // early-return path.
        await expect(page.locator('#stat-students')).toHaveText('0', { timeout: 15_000 });
        await expect(page.locator('#stat-grades')).toHaveText('0');
        await expect(page.locator('#stat-risk')).toHaveText('0');

        // The Command Center block itself (Class Averages, At-Risk Flagging,
        // Assignment Bottlenecks, Grade Distribution, etc.) is never revealed
        // at all for a zero-student teacher — home.js's fetchMetrics()
        // returns before the line that un-hides #analyticsSection. This is
        // the actual current behavior (confirmed by reading home.js), not an
        // assumption — worth knowing if a future change makes analyticsSection
        // reveal itself with per-widget empty states instead, which would be
        // an equally valid (arguably nicer) design this test would then need
        // updating for.
        await expect(page.locator('#analyticsSection')).toHaveClass(/hidden/);
        await expect(page.locator('#atRiskBanner')).toBeHidden();

        // The "Needs Attention" panel further down the page IS outside
        // #analyticsSection and DOES get its dedicated empty-state message.
        await expect(page.locator('#needsAttentionList')).toContainText('All students on track!');
    });
});
