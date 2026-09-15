// Phase 12 of docs/teacher-portal-test-plan.md — My Evaluations
// (teacher/analytics/analytics.html), per the "ARCHITECTURAL MANDATE: E2E
// Test Suite (Phases 11 & 12)".
//
// Covers:
//   12.1 State & Rendering: the 4 KPI cards (Average Rating, Total
//        Evaluations, Schools Evaluated At, Latest Action) computed from
//        mock evaluation records spanning the current school and one
//        different (previous) school.
//   12.2 State & Rendering: renderCategories()'s conditional per-category
//        bar — a category with at least one non-null score across the
//        teacher's evaluations gets a bar (3 positive cases:
//        classroomManagement, curriculumDelivery, studentEngagement); a
//        category that is null on every evaluation never gets a bar at all
//        (negative case: professionalConduct, null on all 3 fixture docs).
//   12.6 State & Rendering: the empty state for a teacher with zero
//        evaluations — both the "No evaluations found" list message AND
//        #categorySection staying hidden (catData.length === 0), the
//        fullest negative case for 12.2's same conditional-display logic.
//   12.3 Interactivity: the period filter (#filterPeriod) narrows the
//        rendered list via window.applyFilters()'s exact `e.semesterId ===
//        periodId` match.
//   12.4 Interactivity: window.toggleEval() expand/collapse — the body's
//        display and the chevron's rotation both flip on click, and back
//        on a second click.
//   12.5 Caching: loadEvaluations()'s 5-minute localStorage
//        stale-while-revalidate cache — proven in two parts: (a) a cold
//        load populates connectus_evals_{teacherId} with a fresh
//        {savedAt, data} shape matching what was fetched, and (b) a
//        pre-seeded, still-fresh (<5 min old) cache entry with content
//        that does NOT match Firestore is what actually renders on the
//        very next load — proving the page served the cache instead of
//        waiting on the network — after which refreshEvaluationsInBackground()
//        silently replaces it with the real data with no user action.
//
// SOURCE-OF-TRUTH METHODOLOGY (same as every prior phase in this suite):
// every DOM id, field name, and cache shape below was read directly out of
// teacher/analytics/analytics.html and teacher/analytics/analytics.js in
// full — not guessed from the mandate's prose.
//
// Requires (see playwright.config.js's header comment):
//   1. Firebase emulators already running (Firestore 8080, Auth 9099,
//      Functions 5001, Database 9000).
//   2. `npm run seed` already run in this folder (or let beforeEach do it).

const { test, expect } = require('@playwright/test');
const {
    seed,
    TEACHER_EVAL_ID, TEACHER_EVAL_PIN,
    TEACHER_EVAL_EMPTY_ID, TEACHER_EVAL_EMPTY_PIN,
    EVAL_RECENT_ID, EVAL_MID_ID, EVAL_OLD_ID,
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

async function gotoAnalytics(page) {
    await page.goto('/teacher/analytics/analytics.html');
    // showSkeleton() fills #evalKpiCards/#evalList with shimmer placeholders
    // synchronously, then the DOMContentLoaded handler replaces them once
    // loadEvaluations()/renderKpis() resolve — waiting for the count badge
    // (only ever set by renderList(), never part of the skeleton) is a
    // reliable "the real render happened" signal.
    await expect(page.locator('#evalCountBadge')).not.toHaveText('', { timeout: 10_000 });
}

test.describe('Phase 12: My Evaluations', () => {
    test.beforeEach(seed);

    test('12.1 — KPI cards reflect the mock evaluation records', async ({ page }) => {
        forwardBrowserLogs(page);
        await loginAsTeacher(page, TEACHER_EVAL_ID, TEACHER_EVAL_PIN);
        await gotoAnalytics(page);

        // The 4 cards render in this fixed order: Average Rating, Total
        // Evaluations, Schools Evaluated At, Latest Action.
        const cards = page.locator('#evalKpiCards > div');
        await expect(cards).toHaveCount(4);

        // 3 evals: ratings 4.5, 3.5, 2.0 -> avg (10/3).toFixed(1) = '3.3'.
        const avgCard = await cards.nth(0).innerText();
        expect(avgCard).toContain('3.3');
        expect(avgCard).toContain('/ 5');
        expect(avgCard).toContain('Average Rating');

        const countCard = await cards.nth(1).innerText();
        expect(countCard).toContain('3');
        expect(countCard).toContain('evaluations on record');
        expect(countCard).toContain('Total Evaluations');

        // schoolIds across the 3 fixture evals: SCHOOL_ID (x2), EVAL_PREV_SCHOOL_ID (x1) -> 2 distinct.
        const schoolsCard = await cards.nth(2).innerText();
        expect(schoolsCard).toContain('2');
        expect(schoolsCard).toContain('schools on record');
        expect(schoolsCard).toContain('Schools Evaluated At');

        // Sorted by date desc, evals[0] = EVAL_RECENT -> recommendedAction 'Commendation'.
        const latestCard = await cards.nth(3).innerText();
        expect(latestCard).toContain('Commendation');
        expect(latestCard).toContain('Latest recommendation');
        expect(latestCard).toContain('Latest Action');
    });

    test('12.2 — category bars: shown for categories with at least one score, hidden for one with none', async ({ page }) => {
        forwardBrowserLogs(page);
        await loginAsTeacher(page, TEACHER_EVAL_ID, TEACHER_EVAL_PIN);
        await gotoAnalytics(page);

        await expect(page.locator('#categorySection')).not.toHaveClass(/hidden/);

        const barsText = await page.locator('#categoryBars').innerText();
        // Positive cases: classroomManagement avg (5+3)/2=4 -> 80%; curriculumDelivery
        // avg 4/1=4 -> 80%; studentEngagement avg (5+4)/2=4.5 -> 90%.
        expect(barsText).toContain('Classroom Management');
        expect(barsText).toContain('4.0 / 5');
        expect(barsText).toContain('Curriculum Delivery');
        expect(barsText).toContain('Student Engagement');
        expect(barsText).toContain('4.5 / 5');
        // Negative case: professionalConduct is null on every one of this
        // teacher's 3 evaluations -> never gets a bar of its own.
        expect(barsText).not.toContain('Professional Conduct');
    });

    test('12.6 — empty state: no evaluations at all shows the empty message and keeps category bars hidden', async ({ page }) => {
        forwardBrowserLogs(page);
        await loginAsTeacher(page, TEACHER_EVAL_EMPTY_ID, TEACHER_EVAL_EMPTY_PIN);
        await gotoAnalytics(page);

        await expect(page.locator('#evalCountBadge')).toHaveText('0 evaluations');
        await expect(page.locator('#evalList')).toContainText('No evaluations found for this period.');
        // catData.length === 0 -> renderCategories() returns early, the
        // section's default 'hidden' class from analytics.html is never removed.
        await expect(page.locator('#categorySection')).toHaveClass(/hidden/);
    });

    test('12.3 — the period filter narrows the evaluation list', async ({ page }) => {
        forwardBrowserLogs(page);
        await loginAsTeacher(page, TEACHER_EVAL_ID, TEACHER_EVAL_PIN);
        await gotoAnalytics(page);

        await expect(page.locator('#evalCountBadge')).toHaveText('3 evaluations');

        // SEMESTER_ID -> only EVAL_RECENT matches e.semesterId.
        const semesterOption = await page.locator('#filterPeriod option').nth(1).getAttribute('value');
        await page.locator('#filterPeriod').selectOption(semesterOption);
        await expect(page.locator('#evalCountBadge')).toHaveText('1 evaluation');
        await expect(page.locator(`[id="eval-body-${EVAL_RECENT_ID}"]`)).toHaveCount(1);
        await expect(page.locator(`[id="eval-body-${EVAL_MID_ID}"]`)).toHaveCount(0);

        // Back to "All Periods" -> all 3 again.
        await page.locator('#filterPeriod').selectOption('');
        await expect(page.locator('#evalCountBadge')).toHaveText('3 evaluations');
    });

    test('12.4 — expand/collapse toggles the card body and chevron rotation', async ({ page }) => {
        forwardBrowserLogs(page);
        await loginAsTeacher(page, TEACHER_EVAL_ID, TEACHER_EVAL_PIN);
        await gotoAnalytics(page);

        const body = page.locator(`#eval-body-${EVAL_RECENT_ID}`);
        const chevron = page.locator(`#eval-chevron-${EVAL_RECENT_ID}`);
        const header = page.locator(`[onclick="window.toggleEval('${EVAL_RECENT_ID}')"]`);

        await expect(body).toHaveCSS('display', 'none');

        await header.click();
        await expect(body).toHaveCSS('display', 'block');
        await expect(chevron).toHaveCSS('transform', /matrix/); // rotate(180deg) resolves to a matrix()

        await header.click();
        await expect(body).toHaveCSS('display', 'none');
    });

    test('12.5 — the 5-minute evaluations cache is populated on load and served (utilized) on the next load', async ({ page }) => {
        forwardBrowserLogs(page);
        await loginAsTeacher(page, TEACHER_EVAL_ID, TEACHER_EVAL_PIN);

        // ── Part A: a cold load populates the cache ─────────────────────
        await gotoAnalytics(page);
        await expect(page.locator('#evalCountBadge')).toHaveText('3 evaluations');

        const cacheKey = `connectus_evals_${TEACHER_EVAL_ID}`;
        const cachedRaw = await page.evaluate((key) => localStorage.getItem(key), cacheKey);
        expect(cachedRaw).not.toBeNull();
        const cached = JSON.parse(cachedRaw);
        expect(Date.now() - cached.savedAt).toBeLessThan(60_000);
        expect(cached.data.map(e => e.id).sort()).toEqual([EVAL_MID_ID, EVAL_OLD_ID, EVAL_RECENT_ID].sort());

        // ── Part B: a fresh (<5 min old) but WRONG cache entry is what
        //    actually renders on the very next load — proving the cache is
        //    read and used, not just written and ignored. ─────────────────
        const fakePayload = {
            savedAt: Date.now(),
            data: [{
                id: 'fake-eval-cache-test',
                overallRating: 5,
                schoolId: 'FAKE-CACHE-SCHOOL',
                recommendedAction: 'None',
                classroomManagement: null, curriculumDelivery: null,
                studentEngagement: null, professionalConduct: null,
                date: '2026-08-01',
            }],
        };
        await page.addInitScript(([key, val]) => {
            localStorage.setItem(key, val);
        }, [cacheKey, JSON.stringify(fakePayload)]);

        await gotoAnalytics(page);
        // Rendered instantly from the fake cache — 1 evaluation, not 3.
        await expect(page.locator('#evalCountBadge')).toHaveText('1 evaluation');

        // refreshEvaluationsInBackground() then silently replaces it with
        // the real 3-record Firestore data, with no reload and no user action.
        await expect(page.locator('#evalCountBadge')).toHaveText('3 evaluations', { timeout: 10_000 });
        const refreshedRaw = await page.evaluate((key) => localStorage.getItem(key), cacheKey);
        const refreshed = JSON.parse(refreshedRaw);
        expect(refreshed.data.map(e => e.id).sort()).toEqual([EVAL_MID_ID, EVAL_OLD_ID, EVAL_RECENT_ID].sort());
    });
});
