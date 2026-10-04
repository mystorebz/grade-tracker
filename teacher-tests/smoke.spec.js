// teacher-tests/smoke.spec.js — Test-All smoke subset (LOCAL EMULATOR ONLY)
//
// Fast, read-only gate run by tools/audit-all.sh. For each portal login page:
//   1. the page loads with no uncaught JavaScript errors,
//   2. assets/js/firebase-init.js reports it is wired to the local emulators,
//   3. the browser never contacts a live Firebase/Google backend.
//
// Uses playwright.config.js in this folder (baseURL http://localhost:3000,
// auto-started `npx serve`). Emulators must already be running.

const { test, expect } = require('@playwright/test');

const PORTALS = [
    { name: 'teacher', path: '/teacher/login.html' },
    { name: 'student', path: '/student/login.html' },
    { name: 'admin', path: '/admin/login.html' },
];

// Any request to these hosts from localhost means emulator wiring is broken.
const LIVE_BACKENDS = [
    /firestore\.googleapis\.com/,
    /identitytoolkit\.googleapis\.com/,
    /securetoken\.googleapis\.com/,
    /cloudfunctions\.net/,
    /\.run\.app/,
    /firebasedatabase\.app/,
    /firebaseio\.com/,
    /firebasestorage\.googleapis\.com/,
];

const EMULATOR_LOG = /Localhost detected .* using local emulators/;
const INIT_LOG = /Firebase initialized \((development|production): ([\w-]+)\)/;

for (const portal of PORTALS) {
    test(`smoke: ${portal.name} login loads on emulators`, async ({ page }) => {
        const pageErrors = [];
        const liveCalls = [];
        const consoleLines = [];

        page.on('pageerror', (err) => pageErrors.push(err.message));
        page.on('console', (msg) => consoleLines.push(msg.text()));
        page.on('request', (req) => {
            const url = req.url();
            if (LIVE_BACKENDS.some((re) => re.test(url))) liveCalls.push(url);
        });

        const response = await page.goto(portal.path, { waitUntil: 'domcontentloaded' });
        expect(response, `no response for ${portal.path}`).not.toBeNull();
        expect(response.status(), `${portal.path} HTTP status`).toBeLessThan(400);

        await expect
            .poll(() => consoleLines.some((l) => EMULATOR_LOG.test(l)), {
                message: 'firebase-init.js did not report emulator wiring',
                timeout: 15_000,
            })
            .toBe(true);

        await expect
            .poll(() => consoleLines.some((l) => INIT_LOG.test(l)), {
                message: 'firebase-init.js did not finish initializing',
                timeout: 15_000,
            })
            .toBe(true);

        await page.waitForLoadState('networkidle', { timeout: 5_000 }).catch(() => {});

        const init = consoleLines.map((l) => l.match(INIT_LOG)).find(Boolean);
        test.info().annotations.push({ type: 'firebase', description: `${init[1]}: ${init[2]}` });

        expect(pageErrors, `uncaught errors on ${portal.path}`).toEqual([]);
        expect(liveCalls, `live backend contacted from ${portal.path}`).toEqual([]);
    });
}
