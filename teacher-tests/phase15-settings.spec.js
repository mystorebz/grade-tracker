// Phase 15 of docs/teacher-portal-test-plan.md — Settings
// (teacher/settings/settings.html), per the "ARCHITECTURAL MANDATE: E2E
// Test Suite (Phases 13, 14, 15)".
//
// Covers:
//   15.1 Profile Validation: the Save Profile handler's own ordered
//        checks — empty name, empty email, then an invalid email format —
//        each blocks with an inline #profileMsg, never a window.alert().
//   15.2 Profile Validation: an email change to an address already present
//        in registered_emails/{email} blocks with an inline message and
//        leaves the teacher's own doc untouched; changing to a genuinely
//        free address then succeeds, swapping the registered_emails
//        registration (this second half isn't explicitly asked for, but is
//        the natural positive counterpart to the collision block, and
//        confirms the batch actually commits both writes together).
//   15.3 Completeness Gates: isProfileComplete()'s five required fields
//        (license number, license type, education level, employment type,
//        address.city) drive #profileIncompleteWarning's visibility in
//        real time, with no reload, on both the incomplete and now-complete
//        states. #profileCompleteBadge is asserted too — read in full,
//        settings.js never writes to that element at all in either state;
//        this is a known-issue characterization (dead markup), the same
//        kind of finding as the 7.7 "Attendance saves while LOCKED" test
//        elsewhere in this suite, not a bug this spec works around.
//   15.4 Security: editing security questions is strictly gated on the
//        CURRENT pin — no PIN blocks before any Firestore read even
//        happens, a wrong PIN blocks after the read (storedPin comparison),
//        and the two questions must differ; a correct PIN with two
//        distinct questions succeeds, and the stored answer hashes are
//        verified against sha256(answer.toLowerCase().trim()) — the exact
//        algorithm settings.js's own sha256() uses (case/whitespace-
//        insensitive answers).
//   15.5 Security: Change PIN's own ordered checks — all-fields-required,
//        mismatch, minimum length, then a wrong current PIN — before a
//        correct current PIN succeeds and the stored hash is verified
//        against sha256Trim(newPin) (trim-only, matching the server's own
//        PIN hashing convention used everywhere else in this app).
//
// SOURCE-OF-TRUTH METHODOLOGY (same as every prior phase in this suite):
// every selector, validation order, and message string below was read
// directly out of teacher/settings/settings.html and
// teacher/settings/settings.js in full — not guessed from the mandate's
// prose.
//
// Requires (see playwright.config.js's header comment):
//   1. Firebase emulators already running (Firestore 8080, Auth 9099,
//      Functions 5001, Database 9000).
//   2. `npm run seed` already run in this folder (or let beforeEach do it).

const crypto = require('crypto');
const { test, expect } = require('@playwright/test');
const {
    seed,
    TEACHER_SETTINGS_ID, TEACHER_SETTINGS_PIN,
    TEACHER_SETTINGS_EMAIL, TEACHER_SETTINGS_TAKEN_EMAIL, TEACHER_SETTINGS_NEW_EMAIL,
    getTeacherDoc,
    getRegisteredEmailDoc,
} = require('./seed');

// Mirrors settings.js's own sha256()/sha256Trim() exactly (Web Crypto
// subtle.digest('SHA-256', ...) over a UTF-8-encoded string is bit-for-bit
// the same digest Node's crypto module produces for the same bytes).
function sha256Lower(text) {
    return crypto.createHash('sha256').update(String(text).toLowerCase().trim(), 'utf8').digest('hex');
}
function sha256Trim(text) {
    return crypto.createHash('sha256').update(String(text).trim(), 'utf8').digest('hex');
}

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

async function gotoSettings(page) {
    await page.goto('/teacher/settings/settings.html');
    // DOMContentLoaded's handler populates #displayName from the session
    // synchronously, then the profile doc fetch fills in the security
    // badge — waiting for the badge to leave "Loading..." is this page's
    // "init() has actually finished" signal.
    await expect(page.locator('#secQBadge')).not.toHaveText('Loading...', { timeout: 10_000 });
}

test.describe('Phase 15: Settings', () => {
    test.beforeEach(seed);

    test('15.1 — Save Profile validation: empty name, empty email, invalid email format', async ({ page }) => {
        forwardBrowserLogs(page);
        await loginAsTeacher(page, TEACHER_SETTINGS_ID, TEACHER_SETTINGS_PIN);
        await gotoSettings(page);

        await page.locator('button:has-text("Update Profile Info")').click();
        await expect(page.locator('#profileModal')).toBeVisible();

        await page.locator('#settingName').fill('');
        await page.locator('#saveProfileBtn').click();
        await expect(page.locator('#profileMsg')).toHaveText('Name is required.');
        await expect(page.locator('#profileMsg')).not.toHaveClass(/hidden/);

        await page.locator('#settingName').fill('E2E Settings Teacher');
        await page.locator('#settingEmail').fill('');
        await page.locator('#saveProfileBtn').click();
        await expect(page.locator('#profileMsg')).toHaveText('Email is required for PIN recovery.');

        await page.locator('#settingEmail').fill('not-a-valid-email');
        await page.locator('#saveProfileBtn').click();
        await expect(page.locator('#profileMsg')).toHaveText('Please enter a valid email address.');

        // Modal never closed on any of these — all three are blocking, inline validations.
        await expect(page.locator('#profileModal')).toBeVisible();
    });

    test('15.2 — email collision blocks the save; a genuinely free email then succeeds', async ({ page }) => {
        forwardBrowserLogs(page);
        await loginAsTeacher(page, TEACHER_SETTINGS_ID, TEACHER_SETTINGS_PIN);
        await gotoSettings(page);

        await page.locator('button:has-text("Update Profile Info")').click();
        await page.locator('#settingEmail').fill(TEACHER_SETTINGS_TAKEN_EMAIL);
        await page.locator('#saveProfileBtn').click();
        await expect(page.locator('#profileMsg')).toHaveText('This email is already registered to another account.');

        let unchanged = await getTeacherDoc(TEACHER_SETTINGS_ID);
        expect(unchanged.email).toBe(TEACHER_SETTINGS_EMAIL);

        // A genuinely free email succeeds.
        await page.locator('#settingEmail').fill(TEACHER_SETTINGS_NEW_EMAIL);
        await page.locator('#saveProfileBtn').click();
        await expect(page.locator('#profileMsg')).toHaveText('Profile saved successfully!');
        await expect(page.locator('#displayEmail')).toHaveText(TEACHER_SETTINGS_NEW_EMAIL);

        const updated = await getTeacherDoc(TEACHER_SETTINGS_ID);
        expect(updated.email).toBe(TEACHER_SETTINGS_NEW_EMAIL);
        const registration = await getRegisteredEmailDoc(TEACHER_SETTINGS_NEW_EMAIL);
        expect(registration).not.toBeNull();
        expect(registration.referenceId).toBe(TEACHER_SETTINGS_ID);
        expect(registration.role).toBe('teacher');
    });

    test('15.3 — completeness gate warning toggles in real time; #profileCompleteBadge stays empty/hidden regardless (known dead markup)', async ({ page }) => {
        forwardBrowserLogs(page);
        await loginAsTeacher(page, TEACHER_SETTINGS_ID, TEACHER_SETTINGS_PIN);
        await gotoSettings(page);

        // Incomplete at seed time (no license/education/employment/city).
        await expect(page.locator('#profileIncompleteWarning')).not.toHaveClass(/hidden/);
        await expect(page.locator('#profileCompleteBadge')).toHaveClass(/hidden/);
        expect((await page.locator('#profileCompleteBadge').innerHTML()).trim()).toBe('');

        // Fill in every field isProfileComplete() checks, then save.
        await page.locator('button:has-text("Update Profile Info")').click();
        await page.locator('#profLicenseNumber').fill('BZ-TCH-00015');
        await page.locator('#profLicenseType').selectOption('Trained Teacher');
        await page.locator('#profEmploymentType').selectOption('Full-Time');
        await page.locator('#profEducationLevel').selectOption("Bachelor's Degree");
        await page.locator('#profAddressCity').fill('Belmopan');
        await page.locator('#saveProfileBtn').click();
        await expect(page.locator('#profileMsg')).toHaveText('Profile saved successfully!');

        // The warning clears immediately, no reload.
        await expect(page.locator('#profileIncompleteWarning')).toHaveClass(/hidden/);
        // The badge is untouched either way — dead markup, characterized rather than worked around.
        await expect(page.locator('#profileCompleteBadge')).toHaveClass(/hidden/);
        expect((await page.locator('#profileCompleteBadge').innerHTML()).trim()).toBe('');

        const saved = await getTeacherDoc(TEACHER_SETTINGS_ID);
        expect(saved.teacherLicenseNumber).toBe('BZ-TCH-00015');
        expect(saved.address.city).toBe('Belmopan');
    });

    test('15.4 — editing security questions strictly requires the current PIN', async ({ page }) => {
        forwardBrowserLogs(page);
        await loginAsTeacher(page, TEACHER_SETTINGS_ID, TEACHER_SETTINGS_PIN);
        await gotoSettings(page);

        await expect(page.locator('#secQBadge')).toHaveText('⚠ Not Set');

        await page.locator('button:has-text("Edit")').click();
        await expect(page.locator('#securityQModal')).toBeVisible();

        const Q1 = "What was the name of your first pet?";
        const Q2 = "What city were you born in?";

        // No PIN at all — blocks before any field-content check.
        await page.locator('#secQ1').selectOption(Q1);
        await page.locator('#secA1').fill('Milo');
        await page.locator('#secQ2').selectOption(Q2);
        await page.locator('#secA2').fill('Belmopan');
        await page.locator('#saveSecQBtn').click();
        await expect(page.locator('#secQMsg')).toHaveText('Enter your current PIN to confirm your identity.');

        // Same question for both — blocks (all other fields valid, wrong current PIN doesn't matter for this check since it's evaluated after the field checks but the wrong-PIN case is tested separately below).
        await page.locator('#secQCurrentPin').fill(TEACHER_SETTINGS_PIN);
        await page.locator('#secQ2').selectOption(Q1);
        await page.locator('#saveSecQBtn').click();
        await expect(page.locator('#secQMsg')).toHaveText('Please choose two different questions.');

        // Wrong current PIN, otherwise fully valid — blocks after the Firestore read.
        await page.locator('#secQ2').selectOption(Q2);
        await page.locator('#secQCurrentPin').fill('000000');
        await page.locator('#saveSecQBtn').click();
        await expect(page.locator('#secQMsg')).toHaveText('Current PIN is incorrect.');

        // Correct PIN, two distinct questions — succeeds.
        await page.locator('#secQCurrentPin').fill(TEACHER_SETTINGS_PIN);
        await page.locator('#saveSecQBtn').click();
        await expect(page.locator('#secQMsg')).toHaveText('Security questions updated successfully!');
        await expect(page.locator('#secQBadge')).toHaveText('✓ Set');
        await expect(page.locator('#displaySecQ1')).toHaveText(Q1);
        await expect(page.locator('#displaySecQ2')).toHaveText(Q2);

        const saved = await getTeacherDoc(TEACHER_SETTINGS_ID);
        expect(saved.securityQuestionsSet).toBe(true);
        expect(saved.securityQ1).toBe(Q1);
        expect(saved.securityQ2).toBe(Q2);
        expect(saved.securityA1).toBe(sha256Lower('Milo'));
        expect(saved.securityA2).toBe(sha256Lower('Belmopan'));
    });

    test('15.5 — Change PIN validation: required fields, mismatch, minimum length, wrong current PIN, then success', async ({ page }) => {
        forwardBrowserLogs(page);
        await loginAsTeacher(page, TEACHER_SETTINGS_ID, TEACHER_SETTINGS_PIN);
        await gotoSettings(page);

        await page.locator('button:has-text("Change PIN")').click();
        await expect(page.locator('#changePinModal')).toBeVisible();

        await page.locator('#savePinBtn').click();
        await expect(page.locator('#pinMsg')).toHaveText('All three fields are required.');

        await page.locator('#currentPin').fill(TEACHER_SETTINGS_PIN);
        await page.locator('#newPin').fill('654321');
        await page.locator('#confirmPin').fill('999999');
        await page.locator('#savePinBtn').click();
        await expect(page.locator('#pinMsg')).toHaveText('New PINs do not match.');

        await page.locator('#newPin').fill('123');
        await page.locator('#confirmPin').fill('123');
        await page.locator('#savePinBtn').click();
        await expect(page.locator('#pinMsg')).toHaveText('PIN must be at least 6 characters.');

        await page.locator('#currentPin').fill('000000');
        await page.locator('#newPin').fill('654321');
        await page.locator('#confirmPin').fill('654321');
        await page.locator('#savePinBtn').click();
        await expect(page.locator('#pinMsg')).toHaveText('Current PIN is incorrect.');

        await page.locator('#currentPin').fill(TEACHER_SETTINGS_PIN);
        await page.locator('#savePinBtn').click();
        await expect(page.locator('#pinMsg')).toHaveText('PIN updated successfully!');

        const saved = await getTeacherDoc(TEACHER_SETTINGS_ID);
        expect(saved.pin).toBe(sha256Trim('654321'));
    });
});
