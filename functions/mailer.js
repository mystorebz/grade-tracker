/**
 * Direct Cloud Functions email sending.
 *
 * Replaces the (now-uninstalled) "Trigger Email from Firestore" extension.
 * The extension used to watch the `mail` collection: any function that wrote
 * a doc there got it relayed via the extension's own SMTP config. That
 * extension is gone now, so those Firestore writes would silently do
 * nothing. This module sends the email directly instead, via Gmail SMTP
 * (nodemailer) authenticated as info@connectusonline.org.
 *
 * SETUP (one-time, per environment):
 *   1. Log into the info@connectusonline.org Google account.
 *   2. Ensure 2-Step Verification is turned on.
 *   3. Google Account -> Security -> App Passwords -> generate a new app
 *      password for "Mail".
 *   4. Store it as a Firebase secret (never commit it to source):
 *        firebase functions:secrets:set GMAIL_APP_PASSWORD
 *      (paste the 16-character app password when prompted)
 *   5. Deploy functions as usual — any function using sendMail() must have
 *      `secrets: [GMAIL_APP_PASSWORD]` in its trigger options (already wired
 *      up on every function below that sends email).
 *
 * Usage (drop-in replacement for the old pattern):
 *   OLD:
 *     await db.collection('mail').add({
 *       to: someEmail,
 *       message: { subject: 'Hi', html: '<p>...</p>' }
 *     });
 *   NEW:
 *     await sendMail({ to: someEmail, subject: 'Hi', html: '<p>...</p>' });
 */

const nodemailer = require('nodemailer');
const { defineSecret } = require('firebase-functions/params');

// Bound to the Firebase secret named GMAIL_APP_PASSWORD. Set/rotate with:
//   firebase functions:secrets:set GMAIL_APP_PASSWORD
const GMAIL_APP_PASSWORD = defineSecret('GMAIL_APP_PASSWORD');

// The mailbox that actually authenticates with Gmail's SMTP servers AND
// appears as the From address. Per explicit instruction: this must be
// info@connectusonline.org, not the old info@mystore.bz account the
// extension was (incorrectly) wired up to.
const SMTP_USER = 'info@connectusonline.org';

let _transporter = null;
function getTransporter() {
    if (!_transporter) {
        _transporter = nodemailer.createTransport({
            service: 'gmail',
            auth: {
                user: SMTP_USER,
                pass: GMAIL_APP_PASSWORD.value()
            }
        });
    }
    return _transporter;
}

/**
 * Send an email immediately via Gmail SMTP.
 * @param {{to: string, subject: string, html: string}} params
 */
async function sendMail({ to, subject, html }) {
    if (!to) {
        console.error(`[sendMail] Refusing to send "${subject}" — no recipient address provided.`);
        return null;
    }
    try {
        const info = await getTransporter().sendMail({
            from: `ConnectUs <${SMTP_USER}>`,
            to,
            subject,
            html
        });
        console.log(`[sendMail] Sent "${subject}" to ${to} — messageId ${info.messageId}`);
        return info;
    } catch (err) {
        console.error(`[sendMail] FAILED to send "${subject}" to ${to}:`, err);
        throw err;
    }
}

module.exports = { sendMail, GMAIL_APP_PASSWORD };
