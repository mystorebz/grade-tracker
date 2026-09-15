// Playwright config for the Teacher Portal E2E suite (Phases 1 & 2 of
// docs/teacher-portal-test-plan.md — Login/Onboarding and the Command
// Center dashboard). Structured identically to exam-tests/playwright.config.js
// so anyone who already knows how to run that suite can run this one the
// same way.
//
// IMPORTANT — two separate processes this config does NOT start for you:
//   1. Firebase emulators (Firestore 8080, Auth 9099, Functions 5001,
//      Database 9000) — must already be running via `firebase emulators:start`
//      from the repo root, in a separate terminal, BEFORE running these
//      tests. Playwright has no way to manage that suite; it's a live
//      dependency, same as it is for rules-tests/ and exam-tests/.
//   2. seed.js — must be run once per test session (or per run, since it's
//      idempotent) to populate the emulator with the teachers/students these
//      tests expect. See package.json's "seed" script. The Phase 2 spec
//      additionally re-seeds before every individual test (see that file's
//      own comment for why).
//
// What THIS config does start automatically: the static file server serving
// the app itself (`npx serve -p 3000` from the repo root), via the
// `webServer` block below. assets/js/firebase-init.js's emulator switch only
// activates when location.hostname is 'localhost' or '127.0.0.1' (see that
// file's own comment) — baseURL below matches that exactly, so these tests
// can never accidentally touch the production Firebase project.

const { defineConfig, devices } = require('@playwright/test');
const path = require('path');

module.exports = defineConfig({
    testDir: '.',
    timeout: 60_000,
    expect: {
        timeout: 10_000,
    },
    fullyParallel: false, // shares seeded emulator state across tests in a file; run serially to avoid cross-test interference
    forbidOnly: !!process.env.CI,
    retries: 0, // a retry masking a flaky threshold/state assertion is worse than a visible failure for tests this new
    workers: 1,
    reporter: [['list']],

    use: {
        baseURL: 'http://localhost:3000',
        trace: 'retain-on-failure',
        screenshot: 'only-on-failure',
        video: 'retain-on-failure',
    },

    projects: [
        {
            name: 'chromium',
            use: { ...devices['Desktop Chrome'] },
        },
    ],

    // Starts the app's static file server automatically. Does NOT start the
    // Firebase emulators — those are a separate, already-running dependency
    // (see the header comment above). reuseExistingServer:true means if you
    // already have `npx serve -p 3000` running yourself (e.g. because
    // exam-tests is also running against it), Playwright will use that
    // instead of failing on a port conflict — both suites serve the exact
    // same static files, so sharing one instance is safe.
    webServer: {
        command: 'npx serve -p 3000',
        cwd: path.join(__dirname, '..'),
        url: 'http://localhost:3000',
        reuseExistingServer: true,
        timeout: 30_000,
    },
});
