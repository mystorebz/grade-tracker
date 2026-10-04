#!/usr/bin/env node
'use strict';
/**
 * functions/qa-mail-test.js — live nodemailer test, LIVE dev project only.
 *
 *   node qa-mail-test.js you@example.com
 *
 * Fires the deployed onPinResetRequested function (it sends mail through
 * functions/mailer.js → nodemailer → Gmail SMTP) by creating one throwaway
 * reset_vault document addressed to the email you pass. The document carries
 * no user/account id, so its "Reset My PIN" link can't reset anything.
 * The script waits for the function to run, then deletes the document.
 *
 * Then check: the inbox you passed, and
 *   firebase functions:log --only onPinResetRequested --project dev-school-grade-tracker
 * for "[sendMail] Sent "ConnectUs: Reset Your PIN" … messageId …".
 *
 * Target: dev-school-grade-tracker ONLY. Auth: Application Default Credentials.
 */
const PROJECT_ID = 'dev-school-grade-tracker';
if ((process.env.QA_PROJECT_ID || PROJECT_ID) !== PROJECT_ID) {
    console.error(`[FAIL] Refusing to run against anything but ${PROJECT_ID}.`);
    process.exit(2);
}
for (const v of ['FIRESTORE_EMULATOR_HOST', 'FIREBASE_AUTH_EMULATOR_HOST', 'FIREBASE_EMULATOR_HUB']) delete process.env[v];
process.env.GOOGLE_CLOUD_PROJECT = PROJECT_ID;
process.env.GCLOUD_PROJECT = PROJECT_ID;

const to = String(process.argv[2] || '').trim();
if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(to)) {
    console.error('[FAIL] Pass the address to send the test email to:  node qa-mail-test.js you@example.com');
    process.exit(2);
}

const { initializeApp, applicationDefault } = require('firebase-admin/app');
const { getFirestore } = require('firebase-admin/firestore');
const app = initializeApp({ projectId: PROJECT_ID, credential: applicationDefault() }, 'qa-mail-test');
const db = getFirestore(app);

(async () => {
    const id = `qa-mailtest-${Date.now().toString(36)}`;
    const ref = db.doc(`reset_vault/${id}`);
    const now = new Date();
    await ref.set({
        _qaSeed: true, _seededBy: 'functions/qa-mail-test.js',
        email: to, name: 'QA Mail Test', roleLabel: 'QA Test (not a real account)',
        createdAt: now.toISOString(), expiresAt: now.toISOString(), used: true,
    });
    console.log(`[INFO] Created reset_vault/${id} → onPinResetRequested should email ${to}`);
    console.log('[INFO] Waiting 30 s for the function to run…');
    await new Promise(r => setTimeout(r, 30000));
    await ref.delete();
    console.log(`[PASS] Deleted reset_vault/${id}`);
    console.log('\nNow check:');
    console.log(`  1. The inbox for ${to} (subject "ConnectUs: Reset Your PIN"; check spam too).`);
    console.log('  2. firebase functions:log --only onPinResetRequested --project dev-school-grade-tracker');
    console.log('     Look for: [sendMail] Sent "ConnectUs: Reset Your PIN" … messageId …');
})().then(() => process.exit(0)).catch((e) => { console.error(`[FAIL] ${e.message}`); process.exit(1); });
