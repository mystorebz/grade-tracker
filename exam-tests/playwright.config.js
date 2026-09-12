// Playwright config for ConnectUs Phase 2/3 exam-taking and grading E2E +
// offline-persistence tests.
//
// IMPORTANT — two separate processes this config does NOT start for you:
//   1. Firebase emulators (Firestore 8080, Auth 9099, Functions 5001,
//      Database 9000) — must already be running via `firebase emulators:start`
//      from the repo root, in a separate terminal, BEFORE running these
//      tests. Playwright has no way to manage that suite; it's a live
//      dependency, same as it is for rules-tests/ and functions/test-*.js.
//   2. seed.js — must be run once per test session (or per run, since it
//      clears and re-seeds) to populate the emulator with the students,
//      teachers, exam config, and answer key these tests expect. See
//      package.json's "seed" script.
//
// What THIS config does start automatically: the static file server serving
// the app itself (`npx serve -p 3000` from the repo root), via the
// `webServer` block below — this is the one piece that plausibly varies by
// machine, so automating it here removes one manual step, not all of them.
// firebase-init.js's emulator switch only activates when
// location.hostname is 'localhost' or '127.0.0.1' (see that file's own
// comment) — baseURL below matches that exactly.

const { defineConfig, devices } = require('@playwright/test');
const path = require('path');

module.exports = defineConfig({
    testDir: '.',
    timeout: 60_000,
    expect: {
        timeout: 10_000,
    },
    fullyParallel: false, // these tests share seeded emulator state; run serially to avoid cross-test interference
    forbidOnly: !!process.env.CI,
    retries: 0, // a retry masking a flaky autosave/offline race is worse than a visible failure for tests this new
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
    // already have `npx serve -p 3000` running yourself, Playwright will use
    // it rather than fail on a port conflict.
    webServer: {
        command: 'npx serve -p 3000',
        cwd: path.join(__dirname, '..'),
        url: 'http://localhost:3000',
        reuseExistingServer: true,
        timeout: 30_000,
    },
});
