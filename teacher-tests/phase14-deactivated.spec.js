// Phase 14 of docs/teacher-portal-test-plan.md — Deactivated Account
// (teacher/deactivated/deactivated.html), per the "ARCHITECTURAL MANDATE:
// E2E Test Suite (Phases 13, 14, 15)".
//
// Reachability, addressed directly: normal login already blocks archived
// teachers up front (the 1.4 finding this mandate references — teacher/
// login.js rejects an archived account before any session is ever created),
// so login is NOT how a real teacher ends up on this page. The real path in
// is auth.js's requireAuth() "TEACHER ARCHIVE WATCHER": an onSnapshot on the
// teacher's own doc, set up on every teacher page, that fires and redirects
// here — WITHOUT logging the teacher out, session preserved on purpose — the
// moment an admin flips `archived: true` on a teacher who is CURRENTLY
// logged in elsewhere in the app. 14.1 below drives that exact real trigger
// (login while not archived -> land on home.html -> Admin SDK flips
// archived:true -> assert the client redirects here on its own, no reload)
// rather than only asserting against a directly-mocked session. 14.2/14.3
// then use a directly-injected session for speed/focus, since this page's
// own script never re-checks the `archived` flag itself (see below) —
// reachability is already proven for real by 14.1.
//
// Covers:
//   14.6 Reachability & Guards: with no session at all, the page's own
//        guard (`if (!session || !session.teacherId) location.replace(...)`)
//        redirects straight to ../login.html.
//   14.1 Reachability & Guards: the real archive-mid-session trigger above,
//        landing on a page with NO navigation chrome at all — this page
//        never calls injectTeacherLayout() and has no #layout-sidebar-
//        container/#layout-topbar-container/<nav> anywhere in its markup,
//        unlike every other teacher page in this app.
//   14.2 Read-Only State: the identity grid, teaching history cards (both
//        the subjectAverages-pill shape and the plain subjects[]-pill
//        fallback shape), and evaluation list all render straight from the
//        teacher doc/evaluations subcollection with zero editable form
//        controls anywhere on the page.
//   14.3 Read-Only State: empty states — a teacher with no teachingHistory
//        and no evaluations sees the explicit "No teaching history
//        recorded yet." / "No evaluations on record." messages.
//
// SOURCE-OF-TRUTH METHODOLOGY (same as every prior phase in this suite):
// every selector and message string below was read directly out of
// teacher/deactivated/deactivated.html's inline <script type="module"> (this
// page has no separate deactivated.js file — the whole thing is inline) and
// assets/js/auth.js's requireAuth() — not guessed from the mandate's prose.
//
// Requires (see playwright.config.js's header comment):
//   1. Firebase emulators already running (Firestore 8080, Auth 9099,
//      Functions 5001, Database 9000).
//   2. `npm run seed` already run in this folder (or let beforeEach do it).

const { test, expect } = require('@playwright/test');
const {
    seed,
    SCHOOL_ID,
    TEACHER_DEACT_ID, TEACHER_DEACT_PIN,
    TEACHER_DEACT_EMPTY_ID,
    setTeacherArchived,
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

// Writes the exact shape auth.js's getSessionData('teacher') expects
// (connectus_teacher_session, {schoolId, teacherId, teacherData}) directly
// into localStorage BEFORE the page's own scripts run, bypassing a real
// login — used only for 14.2/14.3's content-rendering checks, since
// deactivated.html's own script never re-validates `archived` itself (it
// only checks `session && session.teacherId` — see this file's header
// comment for why 14.1 is the real reachability proof instead).
async function injectTeacherSession(page, teacherId) {
    const session = { schoolId: SCHOOL_ID, teacherId, teacherData: {} };
    await page.addInitScript(([key, val]) => {
        localStorage.setItem(key, val);
    }, ['connectus_teacher_session', JSON.stringify(session)]);
}

test.describe('Phase 14: Deactivated Account', () => {
    test.beforeEach(seed);

    test('14.6 — no session redirects to the teacher login page', async ({ page }) => {
        forwardBrowserLogs(page);
        await page.goto('/teacher/deactivated/deactivated.html');
        await page.waitForURL(/\/teacher\/login\.html$/, { timeout: 10_000 });
    });

    test('14.1 — a teacher archived mid-session is redirected here in real time, landing on a page with no navigation chrome', async ({ page }) => {
        forwardBrowserLogs(page);
        await loginAsTeacher(page, TEACHER_DEACT_ID, TEACHER_DEACT_PIN);

        // requireAuth()'s teacher archive watcher (an onSnapshot on this
        // exact doc) is now live on home.html. Flip it for real, the same
        // way an admin's Archive Teacher action would.
        await setTeacherArchived(TEACHER_DEACT_ID, true);

        // The client redirects itself — no reload, no further action from this test.
        await page.waitForURL(/\/teacher\/deactivated\/deactivated\.html$/, { timeout: 15_000 });

        await expect(page.locator('#layout-sidebar-container')).toHaveCount(0);
        await expect(page.locator('#layout-topbar-container')).toHaveCount(0);
        await expect(page.locator('nav')).toHaveCount(0);
        await expect(page.locator('text=Account Deactivated')).toBeVisible();
    });

    test('14.2 — identity, teaching history, and evaluations render read-only from the real teacher doc', async ({ page }) => {
        forwardBrowserLogs(page);
        await injectTeacherSession(page, TEACHER_DEACT_ID);
        await page.goto('/teacher/deactivated/deactivated.html');
        await expect(page.locator('#identityGrid')).toBeVisible({ timeout: 10_000 });

        const identityText = await page.locator('#identityGrid').innerText();
        expect(identityText).toContain('E2E Deactivated Teacher');
        expect(identityText).toContain(TEACHER_DEACT_ID);
        expect(identityText).toContain('e2e.deact.teacher@example.com');
        expect(identityText).toContain('501-555-0114');
        expect(identityText).toContain('BZ-TCH-99914');
        expect(identityText).toContain('Trained Teacher');
        expect(identityText).toContain('Full-Time');
        expect(identityText).toContain("Bachelor's Degree");

        // Teaching history: one card with subjectAverages pills, one with
        // the plain subjects[] pill fallback (no semesterName/classes/
        // studentCount/snapshotDate at all on that second entry).
        const historyText = await page.locator('#historyList').innerText();
        expect(historyText).toContain('E2E Prior School Alpha');
        expect(historyText).toContain('Fall 2024');
        expect(historyText).toContain('Grade 5A');
        expect(historyText).toContain('22 students');
        expect(historyText).toContain('Math: 82%');
        expect(historyText).toContain('Science: 77%');
        expect(historyText).toContain('E2E Prior School Beta');
        expect(historyText).toContain('English');
        expect(historyText).toContain('History');

        // Evaluations: sorted most-recent-first, first one expanded by default.
        const evalText = await page.locator('#evalList').innerText();
        expect(evalText).toContain('Commendation');
        expect(evalText).toContain('Principal X');
        await expect(page.locator('#eval-body-eval-e2e-deact-1')).not.toHaveClass(/hidden/);
        await expect(page.locator('#eval-body-eval-e2e-deact-2')).toHaveClass(/hidden/);

        // Strictly read-only: zero editable form controls anywhere on the page.
        await expect(page.locator('input, textarea, select')).toHaveCount(0);
    });

    test('14.3 — empty states: no teaching history and no evaluations render explicit empty messages', async ({ page }) => {
        forwardBrowserLogs(page);
        await injectTeacherSession(page, TEACHER_DEACT_EMPTY_ID);
        await page.goto('/teacher/deactivated/deactivated.html');
        await expect(page.locator('#identityGrid')).toBeVisible({ timeout: 10_000 });

        await expect(page.locator('#historyList')).toContainText('No teaching history recorded yet.');
        await expect(page.locator('#evalList')).toContainText('No evaluations on record.');
        await expect(page.locator('input, textarea, select')).toHaveCount(0);
    });
});
