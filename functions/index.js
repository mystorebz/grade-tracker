const { onCall, HttpsError, onRequest } = require('firebase-functions/v2/https');
const admin                  = require('firebase-admin');
const crypto                 = require('crypto');
const { onSchedule }         = require('firebase-functions/v2/scheduler');

admin.initializeApp();
const db = admin.firestore();

// Admin portal: toLowerCase().trim() before hashing
function sha256Lower(text) {
    return crypto.createHash('sha256').update(String(text).toLowerCase().trim(), 'utf8').digest('hex');
}

// HQ portal: trim() only — no toLowerCase
function sha256Trim(text) {
    return crypto.createHash('sha256').update(String(text).trim(), 'utf8').digest('hex');
}

async function mintToken(uid, claims) {
    return admin.auth().createCustomToken(uid, claims);
}


// ═══════════════════════════════════════════════════════════════════════════════
// FUNCTION 1: mintAdminToken
// ═══════════════════════════════════════════════════════════════════════════════
exports.mintAdminToken = onCall({ region: 'us-central1' }, async (request) => {

    const { schoolId, adminCode } = request.data;

    if (!schoolId || !adminCode) {
        throw new HttpsError('invalid-argument', 'schoolId and adminCode are required.');
    }

    let schoolSnap = null;
    for (const id of [schoolId.toUpperCase(), schoolId.toLowerCase(), schoolId]) {
        const snap = await db.collection('schools').doc(id).get();
        if (snap.exists) { schoolSnap = snap; break; }
    }

    if (!schoolSnap) {
        throw new HttpsError('not-found', 'School ID not found.');
    }

    const schoolData       = schoolSnap.data();
    const resolvedSchoolId = schoolSnap.id;

    if (schoolData.isVerified !== true) {
        throw new HttpsError('failed-precondition', 'Account suspended.');
    }

    const hashedInput = sha256Lower(adminCode);

    // Path 1: Super Admin
    if (hashedInput === schoolData.adminCode) {
        const token = await mintToken(resolvedSchoolId, {
            role:       'super_admin',
            schoolId:   resolvedSchoolId,
            schoolName: schoolData.schoolName || '',
            schoolType: schoolData.schoolType || 'Primary'
        });
        return { token };
    }

    // Path 2: Sub Admin
    const adminsSnap = await db
        .collection('schools').doc(resolvedSchoolId)
        .collection('admins')
        .where('isArchived', '==', false)
        .get();

    for (const adminDoc of adminsSnap.docs) {
        if (hashedInput === adminDoc.data().adminCode) {
            const token = await mintToken(adminDoc.id, {
                role:       'sub_admin',
                schoolId:   resolvedSchoolId,
                adminId:    adminDoc.id,
                schoolName: schoolData.schoolName || '',
                schoolType: schoolData.schoolType || 'Primary'
            });
            return { token };
        }
    }

    throw new HttpsError('unauthenticated', 'Incorrect Admin Code.');
});

// ═══════════════════════════════════════════════════════════════════════════════
// FUNCTION 2: mintTeacherToken
// --- START: mintTeacherToken ---
// ═══════════════════════════════════════════════════════════════════════════════
exports.mintTeacherToken = onCall({ region: 'us-central1' }, async (request) => {

    const { schoolId, pin } = request.data;

    if (!schoolId || !pin) {
        throw new HttpsError('invalid-argument', 'schoolId and pin are required.');
    }

    // Hash the incoming pin exactly as entered (trim whitespace only, preserve case)
    const pinTrimmed = String(pin).trim();
    const pinHashed  = sha256Trim(pinTrimmed);

    const variants = [schoolId.toUpperCase(), schoolId.toLowerCase(), schoolId];

    // ── Path 1: Global /teachers ──────────────────────────────────────────────
    for (const sid of variants) {

        // Step 1: Try hashed comparison first (new secure path)
        let globalSnap = await db.collection('teachers')
            .where('currentSchoolId', '==', sid)
            .where('pin', '==', pinHashed)
            .get();

        // Step 2: Fall back to plain text comparison (migration path for existing pins)
        if (globalSnap.empty) {
            globalSnap = await db.collection('teachers')
                .where('currentSchoolId', '==', sid)
                .where('pin', '==', pinTrimmed)
                .get();

            // If plain text matched, silently upgrade the stored pin to a hash
            if (!globalSnap.empty) {
                try {
                    await db.collection('teachers')
                        .doc(globalSnap.docs[0].id)
                        .update({ pin: pinHashed });
                } catch (upgradeErr) {
                    console.warn('[mintTeacherToken] Pin upgrade failed silently:', upgradeErr.message);
                }
            }
        }

        if (!globalSnap.empty) {
            const teacherDoc  = globalSnap.docs[0];
            const teacherData = teacherDoc.data();

            if (teacherData.archived) {
                throw new HttpsError('permission-denied', 'Account archived. Contact your administrator.');
            }

            const schoolSnap = await db.collection('schools').doc(sid).get();
            if (!schoolSnap.exists || schoolSnap.data().isVerified !== true) {
                throw new HttpsError('permission-denied', 'School account is pending approval.');
            }

            const token = await mintToken(teacherDoc.id, {
                role:       'teacher',
                schoolId:   sid,
                teacherId:  teacherDoc.id,
                schoolType: schoolSnap.data().schoolType || 'Primary',
                schoolName: schoolSnap.data().schoolName || ''
            });
            return { token };
        }
    }

    // ── Path 2: Legacy siloed /schools/{schoolId}/teachers ────────────────────
    for (const sid of variants) {
        try {
            // Try hashed first
            let legacySnap = await db
                .collection('schools').doc(sid)
                .collection('teachers')
                .where('loginCode', '==', pinHashed)
                .get();

            // Fall back to plain text
            if (legacySnap.empty) {
                legacySnap = await db
                    .collection('schools').doc(sid)
                    .collection('teachers')
                    .where('loginCode', '==', pinTrimmed)
                    .get();

                // Silently upgrade if plain text matched
                if (!legacySnap.empty) {
                    try {
                        await db
                            .collection('schools').doc(sid)
                            .collection('teachers')
                            .doc(legacySnap.docs[0].id)
                            .update({ loginCode: pinHashed });
                    } catch (upgradeErr) {
                        console.warn('[mintTeacherToken] Legacy pin upgrade failed silently:', upgradeErr.message);
                    }
                }
            }

            if (!legacySnap.empty) {
                const teacherDoc = legacySnap.docs[0];

                const schoolSnap = await db.collection('schools').doc(sid).get();
                if (!schoolSnap.exists || schoolSnap.data().isVerified !== true) {
                    throw new HttpsError('permission-denied', 'School account is pending approval.');
                }

                const token = await mintToken(teacherDoc.id, {
                    role:       'teacher',
                    schoolId:   sid,
                    teacherId:  teacherDoc.id,
                    schoolType: schoolSnap.data().schoolType || 'Primary',
                    schoolName: schoolSnap.data().schoolName || '',
                    legacy:     true
                });
                return { token };
            }
        } catch (e) {
            if (e instanceof HttpsError) throw e;
            continue;
        }
    }

    throw new HttpsError('unauthenticated', 'Invalid School ID or Teacher Code.');
});
// --- END: mintTeacherToken ---


// ═══════════════════════════════════════════════════════════════════════════════
// FUNCTION 3: mintStudentToken
// --- START: mintStudentToken ---
// ═══════════════════════════════════════════════════════════════════════════════
exports.mintStudentToken = onCall({ region: 'us-central1' }, async (request) => {

    const { studentId, pin } = request.data;

    if (!studentId || !pin) {
        throw new HttpsError('invalid-argument', 'studentId and pin are required.');
    }

    const rawId = String(studentId).trim().toUpperCase();

    if (!/^S\d{2}-[A-Z0-9]{5}$/.test(rawId)) {
        throw new HttpsError('invalid-argument', 'Invalid Student ID format.');
    }

    const studentSnap = await db.collection('students').doc(rawId).get();

    if (!studentSnap.exists) {
        throw new HttpsError('not-found', 'Student ID not found.');
    }

    const studentData = studentSnap.data();

    // Hash the incoming pin exactly as entered (trim whitespace only, preserve case)
    const pinTrimmed = String(pin).trim();
    const pinHashed  = sha256Trim(pinTrimmed);

    // Step 1: Try hashed comparison first (new secure path)
    let pinMatched = studentData.pin === pinHashed;

    // Step 2: Fall back to plain text comparison (migration path for existing pins)
    if (!pinMatched && studentData.pin === pinTrimmed) {
        pinMatched = true;

        // Silently upgrade the stored pin to a hash
        try {
            await db.collection('students').doc(rawId).update({ pin: pinHashed });
        } catch (upgradeErr) {
            console.warn('[mintStudentToken] Pin upgrade failed silently:', upgradeErr.message);
        }
    }

    if (!pinMatched) {
        throw new HttpsError('unauthenticated', 'Incorrect PIN.');
    }

    const schoolId = studentData.currentSchoolId || '';
    let schoolType = 'Primary';
    let schoolName = '';

    if (schoolId) {
        try {
            const schoolSnap = await db.collection('schools').doc(schoolId).get();
            if (schoolSnap.exists) {
                if (schoolSnap.data().isVerified !== true) {
                    throw new HttpsError('permission-denied', 'School account is pending approval.');
                }
                schoolType = schoolSnap.data().schoolType || 'Primary';
                schoolName = schoolSnap.data().schoolName || '';
            }
        } catch (e) {
            if (e instanceof HttpsError) throw e;
        }
    }

    const token = await mintToken(rawId, {
        role:      'student',
        studentId: rawId,
        schoolId,
        schoolType,
        schoolName
    });

    return { token };
});
// --- END: mintStudentToken ---

// ═══════════════════════════════════════════════════════════════════════════════
// FUNCTION 4: mintHQToken
// ═══════════════════════════════════════════════════════════════════════════════
exports.mintHQToken = onCall({ region: 'us-central1' }, async (request) => {

    const { hqId, pin } = request.data;

    if (!hqId || !pin) {
        throw new HttpsError('invalid-argument', 'hqId and pin are required.');
    }

    const normalizedId = String(hqId).trim().toUpperCase();

    if (!normalizedId.startsWith('HQ-')) {
        throw new HttpsError('invalid-argument', 'Invalid Authorization ID format.');
    }

    const adminSnap = await db.collection('platform_admins').doc(normalizedId).get();

    if (!adminSnap.exists) {
        throw new HttpsError('not-found', 'Authentication failed. Invalid credentials.');
    }

    const adminData = adminSnap.data();

    const hashedPin = sha256Trim(pin);

    if (adminData.pin !== hashedPin) {
        throw new HttpsError('unauthenticated', 'Authentication failed. Invalid credentials.');
    }

    if (!adminData.isActive) {
        throw new HttpsError('permission-denied', 'Your access has been suspended.');
    }

    const token = await mintToken(normalizedId, {
        role:   'platform_admin',
        hqId:   normalizedId,
        name:   adminData.name || '',
        hqRole: adminData.role || 'admin'
    });

    return { token };
});


// ═══════════════════════════════════════════════════════════════════════════════
//
//                          EMAIL AUTOMATION FUNCTIONS
//
// ═══════════════════════════════════════════════════════════════════════════════

const { onDocumentCreated, onDocumentUpdated } = require("firebase-functions/v2/firestore");

const HQ_EMAIL_ADDRESS = "info@connectusonline.org";

// ── Shared email wrapper ───────────────────────────────────────────────────────
function buildEmailWrapper(accentColor, logoUrl, bodyHtml) {
    return `
    <!DOCTYPE html>
    <html>
    <head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"></head>
    <body style="margin:0;padding:0;background-color:#f1f5f9;font-family:'Helvetica Neue',Helvetica,Arial,sans-serif;color:#1e293b;">
      <table width="100%" cellpadding="0" cellspacing="0" border="0" style="background-color:#f1f5f9;padding:40px 20px;">
        <tr>
          <td align="center">
            <table width="100%" cellpadding="0" cellspacing="0" border="0" style="max-width:580px;background-color:#ffffff;border-radius:16px;overflow:hidden;box-shadow:0 4px 24px rgba(0,0,0,0.08);">

              <!-- Top accent bar -->
              <tr><td height="6" style="background:linear-gradient(to right,${accentColor});"></td></tr>

              <!-- Logo -->
              <tr>
                <td style="text-align:center;padding:36px 40px 20px;">
                  <img src="${logoUrl}" alt="ConnectUs" style="height:52px;display:block;margin:0 auto;">
                </td>
              </tr>

              <!-- Body -->
              <tr><td style="padding:0 40px 40px;">${bodyHtml}</td></tr>

              <!-- Footer -->
              <tr>
                <td style="background-color:#f8fafc;padding:24px 40px;text-align:center;border-top:1px solid #e2e8f0;">
                  <p style="margin:0 0 4px;font-size:12px;font-weight:700;color:#94a3b8;">&copy; ${new Date().getFullYear()} ConnectUs. All rights reserved.</p>
                  <p style="margin:0;font-size:11px;color:#cbd5e1;">Powered by Kismet Code Digital &nbsp;|&nbsp; Belize, Central America</p>
                </td>
              </tr>

            </table>
          </td>
        </tr>
      </table>
    </body>
    </html>`;
}

function credentialRow(label, value, mono = false) {
    return `
    <tr>
      <td style="padding:10px 16px;font-size:12px;font-weight:700;color:#64748b;text-transform:uppercase;letter-spacing:0.08em;width:40%;border-bottom:1px solid #f1f5f9;">${label}</td>
      <td style="padding:10px 16px;font-size:${mono ? '15px' : '14px'};font-weight:800;color:#0f172a;${mono ? 'font-family:monospace;letter-spacing:0.12em;' : ''}border-bottom:1px solid #f1f5f9;">${value}</td>
    </tr>`;
}

const LOGO_URL = 'https://connectusonline.org/assets/images/logo.png';


// --- START: onSchoolCreated ---
// Fires when a school is fully onboarded and its doc is created.
// Sends a welcome email to the school admin.
exports.onSchoolCreated = onDocumentCreated("schools/{schoolId}", async (event) => {
    const data     = event.data.data();
    const schoolId = event.params.schoolId;

    if (!data || !data.contactEmail || data.isVerified !== true) return null;

    const adminId    = data.superAdminId  || 'N/A';
    const schoolName = data.schoolName    || 'Your School';
    const firstName  = data.contactName   ? data.contactName.split(' ')[0] : 'Administrator';
    const loginLink  = 'https://connectusonline.org/admin/login.html';

    const body = `
      <h2 style="margin:0 0 8px;font-size:26px;font-weight:900;color:#0f172a;text-align:center;">Welcome to ConnectUs!</h2>
      <p style="margin:0 0 28px;font-size:15px;color:#64748b;text-align:center;line-height:1.6;">Your school has been successfully onboarded onto the ConnectUs platform.</p>

      <p style="margin:0 0 20px;font-size:15px;color:#334155;line-height:1.7;">Hello <strong>${firstName}</strong>,<br><br>
      Congratulations — <strong>${schoolName}</strong> is now live on ConnectUs. Your infrastructure has been initialized and your administrator credentials are ready. Keep the details below in a safe place.</p>

      <!-- Credentials table -->
      <table width="100%" cellpadding="0" cellspacing="0" border="0" style="background-color:#f8fafc;border:1px solid #e2e8f0;border-radius:12px;overflow:hidden;margin-bottom:28px;">
        <tr><td colspan="2" style="padding:14px 16px;background-color:#0f172a;">
          <p style="margin:0;font-size:10px;font-weight:800;color:#94a3b8;text-transform:uppercase;letter-spacing:0.15em;">Your Credentials</p>
        </td></tr>
        ${credentialRow('School Name', schoolName)}
        ${credentialRow('School ID', schoolId, true)}
        ${credentialRow('Admin ID', adminId, true)}
        ${credentialRow('School Type', data.schoolType || 'N/A')}
        ${credentialRow('Subscription', data.subscriptionName || 'N/A')}
      </table>

      <!-- CTA -->
      <div style="text-align:center;margin-bottom:28px;">
        <a href="${loginLink}" style="display:inline-block;background:linear-gradient(135deg,#10b981,#0ea5e9);color:#ffffff;text-decoration:none;font-size:15px;font-weight:800;padding:16px 36px;border-radius:12px;letter-spacing:0.04em;box-shadow:0 4px 14px rgba(16,185,129,0.35);">
          Log In to Your Admin Portal &rarr;
        </a>
      </div>

      <div style="background-color:#fffbeb;border:1px solid #fde68a;border-radius:10px;padding:16px 20px;margin-bottom:20px;">
        <p style="margin:0;font-size:13px;font-weight:700;color:#92400e;line-height:1.6;">
          <strong>Security Reminder:</strong> Your Admin Code was set during onboarding. If you need to reset it, use the Forgot PIN option on the login page. Never share your credentials with anyone.
        </p>
      </div>

      <p style="margin:0;font-size:14px;color:#64748b;line-height:1.7;">If you have any questions or need assistance getting started, our team is always here to help. Simply reply to this email or reach us at <a href="mailto:info@connectusonline.org" style="color:#0ea5e9;font-weight:700;">info@connectusonline.org</a>.</p>
      <p style="margin:20px 0 0;font-size:15px;color:#0f172a;">Warm regards,<br><strong style="color:#10b981;">The ConnectUs Team</strong></p>`;

    const html = buildEmailWrapper('#10b981,#0ea5e9,#3b82f6', LOGO_URL, body);

    try {
        await db.collection('mail').add({
            to: data.contactEmail,
            message: { subject: `Welcome to ConnectUs — ${schoolName} is Live!`, html }
        });
        console.log(`Admin welcome email sent for school: ${schoolId}`);
    } catch (error) {
        console.error(`Failed to send admin welcome email for ${schoolId}:`, error);
    }

    return null;
});
// --- END: onSchoolCreated ---


// --- START: onTeacherCreated ---
// Fires when a new teacher doc is created in the national registry.
// Sends a welcome & credential email to the teacher.
exports.onTeacherCreated = onDocumentCreated("teachers/{teacherId}", async (event) => {
    const data      = event.data.data();
    const teacherId = event.params.teacherId;

    if (!data || !data.email || !data.currentSchoolId) return null;

    let schoolName = data.currentSchoolId;
    try {
        const schoolSnap = await db.collection('schools').doc(data.currentSchoolId).get();
        if (schoolSnap.exists) schoolName = schoolSnap.data().schoolName || data.currentSchoolId;
    } catch (_) {}

    const firstName = data.firstName || data.name?.split(' ')[0] || 'there';
    const pin       = data.pin       || 'See your administrator';
    const loginLink = 'https://connectusonline.org/teacher/login.html';

    const body = `
      <h2 style="margin:0 0 8px;font-size:26px;font-weight:900;color:#0f172a;text-align:center;">You're on ConnectUs!</h2>
      <p style="margin:0 0 28px;font-size:15px;color:#64748b;text-align:center;line-height:1.6;">You have been successfully onboarded as an educator on the ConnectUs platform.</p>

      <p style="margin:0 0 20px;font-size:15px;color:#334155;line-height:1.7;">Hello <strong>${firstName}</strong>,<br><br>
      Welcome to the ConnectUs National Teacher Registry. You have been enrolled at <strong>${schoolName}</strong>. Your credentials are listed below — please log in and complete your profile setup on first login.</p>

      <table width="100%" cellpadding="0" cellspacing="0" border="0" style="background-color:#f8fafc;border:1px solid #e2e8f0;border-radius:12px;overflow:hidden;margin-bottom:28px;">
        <tr><td colspan="2" style="padding:14px 16px;background-color:#0f172a;">
          <p style="margin:0;font-size:10px;font-weight:800;color:#94a3b8;text-transform:uppercase;letter-spacing:0.15em;">Your Credentials</p>
        </td></tr>
        ${credentialRow('Full Name', data.name || `${data.firstName} ${data.lastName}`)}
        ${credentialRow('Teacher ID', teacherId, true)}
        ${credentialRow('School ID', data.currentSchoolId, true)}
        ${credentialRow('School Name', schoolName)}
        ${credentialRow('Temporary PIN', pin, true)}
      </table>

      <div style="text-align:center;margin-bottom:28px;">
        <a href="${loginLink}" style="display:inline-block;background:linear-gradient(135deg,#2563eb,#7c3aed);color:#ffffff;text-decoration:none;font-size:15px;font-weight:800;padding:16px 36px;border-radius:12px;letter-spacing:0.04em;box-shadow:0 4px 14px rgba(37,99,235,0.35);">
          Log In to Teacher Portal &rarr;
        </a>
      </div>

      <div style="background-color:#fffbeb;border:1px solid #fde68a;border-radius:10px;padding:16px 20px;margin-bottom:20px;">
        <p style="margin:0;font-size:13px;font-weight:700;color:#92400e;line-height:1.6;">
          <strong>Important:</strong> Your PIN above is temporary. You will be required to set a new PIN and answer security questions on your first login. Keep your Teacher ID safe — it follows you throughout your career.
        </p>
      </div>

      <p style="margin:0;font-size:14px;color:#64748b;line-height:1.7;">For support, contact us at <a href="mailto:info@connectusonline.org" style="color:#2563eb;font-weight:700;">info@connectusonline.org</a>.</p>
      <p style="margin:20px 0 0;font-size:15px;color:#0f172a;">Warm regards,<br><strong style="color:#2563eb;">The ConnectUs Team</strong></p>`;

    const html = buildEmailWrapper('#2563eb,#7c3aed,#0ea5e9', LOGO_URL, body);

    try {
        await db.collection('mail').add({
            to: data.email,
            message: { subject: `Welcome to ConnectUs — Your Teacher Account is Ready`, html }
        });
        console.log(`Teacher welcome email sent for: ${teacherId}`);
    } catch (error) {
        console.error(`Failed to send teacher welcome email for ${teacherId}:`, error);
    }

    return null;
});
// --- END: onTeacherCreated ---


// --- START: onTeacherUpdated (Claim) ---
// Fires when a teacher's currentSchoolId changes from empty to a new school.
// Sends an enrollment notification email.
exports.onTeacherUpdated = onDocumentUpdated("teachers/{teacherId}", async (event) => {
    const before    = event.data.before.data();
    const after     = event.data.after.data();
    const teacherId = event.params.teacherId;

    // Detect claim: currentSchoolId went from empty to a value, and pin changed
    const wasClaimed = (!before.currentSchoolId || before.currentSchoolId === '') &&
                       after.currentSchoolId && after.currentSchoolId !== '' &&
                       before.pin !== after.pin;

    if (!wasClaimed) return null;
    if (!after.email) return null;

    let schoolName = after.currentSchoolId;
    try {
        const schoolSnap = await db.collection('schools').doc(after.currentSchoolId).get();
        if (schoolSnap.exists) schoolName = schoolSnap.data().schoolName || after.currentSchoolId;
    } catch (_) {}

    const firstName = after.firstName || after.name?.split(' ')[0] || 'there';
    const pin       = after.pin       || 'See your administrator';
    const loginLink = 'https://connectusonline.org/teacher/login.html';

    const body = `
      <h2 style="margin:0 0 8px;font-size:26px;font-weight:900;color:#0f172a;text-align:center;">New School Enrollment</h2>
      <p style="margin:0 0 28px;font-size:15px;color:#64748b;text-align:center;line-height:1.6;">You have been successfully enrolled at a new school on ConnectUs.</p>

      <p style="margin:0 0 20px;font-size:15px;color:#334155;line-height:1.7;">Hello <strong>${firstName}</strong>,<br><br>
      Your national teacher profile has been claimed by <strong>${schoolName}</strong>. A new temporary PIN has been generated for your login. Please log in to complete your setup at the new school.</p>

      <table width="100%" cellpadding="0" cellspacing="0" border="0" style="background-color:#f8fafc;border:1px solid #e2e8f0;border-radius:12px;overflow:hidden;margin-bottom:28px;">
        <tr><td colspan="2" style="padding:14px 16px;background-color:#0f172a;">
          <p style="margin:0;font-size:10px;font-weight:800;color:#94a3b8;text-transform:uppercase;letter-spacing:0.15em;">Your Updated Credentials</p>
        </td></tr>
        ${credentialRow('Full Name', after.name || `${after.firstName} ${after.lastName}`)}
        ${credentialRow('Teacher ID', teacherId, true)}
        ${credentialRow('New School ID', after.currentSchoolId, true)}
        ${credentialRow('School Name', schoolName)}
        ${credentialRow('New Temporary PIN', pin, true)}
      </table>

      <div style="text-align:center;margin-bottom:28px;">
        <a href="${loginLink}" style="display:inline-block;background:linear-gradient(135deg,#2563eb,#7c3aed);color:#ffffff;text-decoration:none;font-size:15px;font-weight:800;padding:16px 36px;border-radius:12px;letter-spacing:0.04em;box-shadow:0 4px 14px rgba(37,99,235,0.35);">
          Log In to Teacher Portal &rarr;
        </a>
      </div>

      <div style="background-color:#fffbeb;border:1px solid #fde68a;border-radius:10px;padding:16px 20px;margin-bottom:20px;">
        <p style="margin:0;font-size:13px;font-weight:700;color:#92400e;line-height:1.6;">
          <strong>Important:</strong> Your temporary PIN must be reset on first login at the new school. If you did not authorize this enrollment, contact us immediately at <a href="mailto:info@connectusonline.org" style="color:#92400e;">info@connectusonline.org</a>.
        </p>
      </div>

      <p style="margin:0;font-size:14px;color:#64748b;line-height:1.7;">For support, contact us at <a href="mailto:info@connectusonline.org" style="color:#2563eb;font-weight:700;">info@connectusonline.org</a>.</p>
      <p style="margin:20px 0 0;font-size:15px;color:#0f172a;">Warm regards,<br><strong style="color:#2563eb;">The ConnectUs Team</strong></p>`;

    const html = buildEmailWrapper('#2563eb,#7c3aed,#0ea5e9', LOGO_URL, body);

    try {
        await db.collection('mail').add({
            to: after.email,
            message: { subject: `ConnectUs — You've Been Enrolled at ${schoolName}`, html }
        });
        console.log(`Teacher claim email sent for: ${teacherId}`);
    } catch (error) {
        console.error(`Failed to send teacher claim email for ${teacherId}:`, error);
    }

    return null;
});
// --- END: onTeacherUpdated ---


// --- START: onStudentCreated ---
// Fires when a new student doc is created in the national registry.
// Sends a welcome & credential email to the student/parent.
exports.onStudentCreated = onDocumentCreated("students/{studentId}", async (event) => {
    const data      = event.data.data();
    const studentId = event.params.studentId;

    if (!data || !data.email || !data.currentSchoolId) return null;

    let schoolName = data.currentSchoolId;
    try {
        const schoolSnap = await db.collection('schools').doc(data.currentSchoolId).get();
        if (schoolSnap.exists) schoolName = schoolSnap.data().schoolName || data.currentSchoolId;
    } catch (_) {}

    const firstName = data.firstName || data.name?.split(' ')[0] || 'there';
    const pin       = data.pin       || 'See your administrator';
    const loginLink = 'https://connectusonline.org/student/login.html';

    const body = `
      <h2 style="margin:0 0 8px;font-size:26px;font-weight:900;color:#0f172a;text-align:center;">Welcome to ConnectUs!</h2>
      <p style="margin:0 0 28px;font-size:15px;color:#64748b;text-align:center;line-height:1.6;">Your student account has been successfully created on the ConnectUs platform.</p>

      <p style="margin:0 0 20px;font-size:15px;color:#334155;line-height:1.7;">Hello <strong>${firstName}</strong>,<br><br>
      You have been successfully enrolled at <strong>${schoolName}</strong> on ConnectUs. Your Academic Passport has been initialized — this ID will follow you throughout your entire academic journey in Belize. Keep your credentials below safe.</p>

      <table width="100%" cellpadding="0" cellspacing="0" border="0" style="background-color:#f8fafc;border:1px solid #e2e8f0;border-radius:12px;overflow:hidden;margin-bottom:28px;">
        <tr><td colspan="2" style="padding:14px 16px;background-color:#0f172a;">
          <p style="margin:0;font-size:10px;font-weight:800;color:#94a3b8;text-transform:uppercase;letter-spacing:0.15em;">Your Credentials</p>
        </td></tr>
        ${credentialRow('Full Name', data.name || `${data.firstName} ${data.lastName}`)}
        ${credentialRow('Student ID', studentId, true)}
        ${credentialRow('School ID', data.currentSchoolId, true)}
        ${credentialRow('School Name', schoolName)}
        ${credentialRow('Temporary PIN', pin, true)}
      </table>

      <div style="text-align:center;margin-bottom:28px;">
        <a href="${loginLink}" style="display:inline-block;background:linear-gradient(135deg,#7c3aed,#db2777);color:#ffffff;text-decoration:none;font-size:15px;font-weight:800;padding:16px 36px;border-radius:12px;letter-spacing:0.04em;box-shadow:0 4px 14px rgba(124,58,237,0.35);">
          Log In to Student Portal &rarr;
        </a>
      </div>

      <div style="background-color:#fffbeb;border:1px solid #fde68a;border-radius:10px;padding:16px 20px;margin-bottom:20px;">
        <p style="margin:0;font-size:13px;font-weight:700;color:#92400e;line-height:1.6;">
          <strong>Important:</strong> Your PIN is temporary. You will be asked to set a new PIN and security questions on your first login. Your Student ID is permanent and unique to you — it will never change.
        </p>
      </div>

      <p style="margin:0;font-size:14px;color:#64748b;line-height:1.7;">For support, contact us at <a href="mailto:info@connectusonline.org" style="color:#7c3aed;font-weight:700;">info@connectusonline.org</a>.</p>
      <p style="margin:20px 0 0;font-size:15px;color:#0f172a;">Warm regards,<br><strong style="color:#7c3aed;">The ConnectUs Team</strong></p>`;

    const html = buildEmailWrapper('#7c3aed,#db2777,#0ea5e9', LOGO_URL, body);

    try {
        await db.collection('mail').add({
            to: data.email,
            message: { subject: `Welcome to ConnectUs — Your Student Account is Ready`, html }
        });
        console.log(`Student welcome email sent for: ${studentId}`);
    } catch (error) {
        console.error(`Failed to send student welcome email for ${studentId}:`, error);
    }

    return null;
});
// --- END: onStudentCreated ---


// --- START: onStudentUpdated (Claim) ---
// Fires when a student's currentSchoolId changes from empty to a new school.
// Sends an enrollment notification email.
exports.onStudentUpdated = onDocumentUpdated("students/{studentId}", async (event) => {
    const before    = event.data.before.data();
    const after     = event.data.after.data();
    const studentId = event.params.studentId;

    // Detect claim: currentSchoolId went from empty to a value
    const wasClaimed = (!before.currentSchoolId || before.currentSchoolId === '') &&
                       after.currentSchoolId && after.currentSchoolId !== '';

    if (!wasClaimed) return null;
    if (!after.email) return null;

    let schoolName = after.currentSchoolId;
    try {
        const schoolSnap = await db.collection('schools').doc(after.currentSchoolId).get();
        if (schoolSnap.exists) schoolName = schoolSnap.data().schoolName || after.currentSchoolId;
    } catch (_) {}

    const firstName = after.firstName || after.name?.split(' ')[0] || 'there';
    const pin       = after.pin       || 'See your administrator';
    const loginLink = 'https://connectusonline.org/student/login.html';

    const body = `
      <h2 style="margin:0 0 8px;font-size:26px;font-weight:900;color:#0f172a;text-align:center;">New School Enrollment</h2>
      <p style="margin:0 0 28px;font-size:15px;color:#64748b;text-align:center;line-height:1.6;">You have been successfully enrolled at a new school on ConnectUs.</p>

      <p style="margin:0 0 20px;font-size:15px;color:#334155;line-height:1.7;">Hello <strong>${firstName}</strong>,<br><br>
      Your ConnectUs Academic Passport has been linked to <strong>${schoolName}</strong>. You can now log in to view your grades, academic records, and progress.</p>

      <table width="100%" cellpadding="0" cellspacing="0" border="0" style="background-color:#f8fafc;border:1px solid #e2e8f0;border-radius:12px;overflow:hidden;margin-bottom:28px;">
        <tr><td colspan="2" style="padding:14px 16px;background-color:#0f172a;">
          <p style="margin:0;font-size:10px;font-weight:800;color:#94a3b8;text-transform:uppercase;letter-spacing:0.15em;">Your Updated Credentials</p>
        </td></tr>
        ${credentialRow('Full Name', after.name || `${after.firstName} ${after.lastName}`)}
        ${credentialRow('Student ID', studentId, true)}
        ${credentialRow('New School ID', after.currentSchoolId, true)}
        ${credentialRow('School Name', schoolName)}
        ${credentialRow('Temporary PIN', pin, true)}
      </table>

      <div style="text-align:center;margin-bottom:28px;">
        <a href="${loginLink}" style="display:inline-block;background:linear-gradient(135deg,#7c3aed,#db2777);color:#ffffff;text-decoration:none;font-size:15px;font-weight:800;padding:16px 36px;border-radius:12px;letter-spacing:0.04em;box-shadow:0 4px 14px rgba(124,58,237,0.35);">
          Log In to Student Portal &rarr;
        </a>
      </div>

      <div style="background-color:#fffbeb;border:1px solid #fde68a;border-radius:10px;padding:16px 20px;margin-bottom:20px;">
        <p style="margin:0;font-size:13px;font-weight:700;color:#92400e;line-height:1.6;">
          <strong>Important:</strong> If you did not authorize this enrollment, please contact us immediately at <a href="mailto:info@connectusonline.org" style="color:#92400e;">info@connectusonline.org</a>.
        </p>
      </div>

      <p style="margin:0;font-size:14px;color:#64748b;line-height:1.7;">For support, contact us at <a href="mailto:info@connectusonline.org" style="color:#7c3aed;font-weight:700;">info@connectusonline.org</a>.</p>
      <p style="margin:20px 0 0;font-size:15px;color:#0f172a;">Warm regards,<br><strong style="color:#7c3aed;">The ConnectUs Team</strong></p>`;

    const html = buildEmailWrapper('#7c3aed,#db2777,#0ea5e9', LOGO_URL, body);

    try {
        await db.collection('mail').add({
            to: after.email,
            message: { subject: `ConnectUs — You've Been Enrolled at ${schoolName}`, html }
        });
        console.log(`Student claim email sent for: ${studentId}`);
    } catch (error) {
        console.error(`Failed to send student claim email for ${studentId}:`, error);
    }

    return null;
});
// --- END: onStudentUpdated ---


// --- START: onQuoteRequestCreated ---
// Fires when a new quote_requests doc is created.
// PayPal-sourced requests (source: 'paypal') skip this — onQuoteApproved handles their email.
// Manual quote form submissions get the 24-48hr follow-up email + HQ alert.
exports.onQuoteRequestCreated = onDocumentCreated("quote_requests/{reqId}", async (event) => {
    const data  = event.data.data();
    const reqId = event.params.reqId;

    if (!data || !data.workEmail) return null;

    // PayPal-sourced requests: skip — onQuoteApproved sends the onboarding link
    if (data.source === 'paypal') return null;

    const customerHtml = `
    <div style="background-color: #f8fafc; padding: 40px 20px; font-family: 'Helvetica Neue', Helvetica, Arial, sans-serif; color: #334155;">
      <table width="100%" cellpadding="0" cellspacing="0" border="0" style="max-width: 600px; margin: 0 auto; background-color: #ffffff; border-radius: 12px; border: 1px solid #e2e8f0;">
        <tr>
          <td style="text-align: center; padding: 40px 20px 10px 20px;">
            <img src="https://connectusonline.org/assets/images/logo.png" alt="ConnectUs Logo" style="height: 55px; display: block; margin: 0 auto;">
          </td>
        </tr>
        <tr>
          <td style="padding: 20px 40px;">
            <h2 style="color: #1e3a8a; font-size: 24px; font-weight: 800; margin-top: 0; margin-bottom: 16px; text-align: center; letter-spacing: -0.5px;">Thank you, ${data.firstName || 'there'}.</h2>
            <p style="font-size: 16px; line-height: 1.6; margin-bottom: 24px; color: #475569; text-align: center;">We have received your request to bring <strong>${data.schoolName || 'your institution'}</strong> onto the ConnectUs platform. Our team is reviewing your requirements and will be in touch shortly.</p>
            <div style="background-color: #f1f5f9; border-radius: 8px; padding: 24px; margin: 30px 0;">
              <h3 style="color: #0f172a; font-size: 12px; text-transform: uppercase; letter-spacing: 1.5px; margin-top: 0; margin-bottom: 16px; border-bottom: 1px solid #cbd5e1; padding-bottom: 10px;">Request Summary</h3>
              <table width="100%" cellpadding="0" cellspacing="0" border="0" style="font-size: 15px; line-height: 2;">
                <tr>
                  <td style="font-weight: 700; width: 35%; color: #64748b;">Request ID</td>
                  <td style="font-family: monospace; font-weight: bold; color: #1e3a8a; text-align: right;">${reqId}</td>
                </tr>
                <tr>
                  <td style="font-weight: 700; color: #64748b;">Institution</td>
                  <td style="color: #0f172a; text-align: right; font-weight: 500;">${data.schoolName || 'N/A'} (${data.schoolType || 'N/A'})</td>
                </tr>
                <tr>
                  <td style="font-weight: 700; color: #64748b;">Location</td>
                  <td style="color: #0f172a; text-align: right; font-weight: 500;">${data.city || 'N/A'}, ${data.country || 'N/A'}</td>
                </tr>
                <tr>
                  <td style="font-weight: 700; color: #64748b;">Estimated Scale</td>
                  <td style="color: #0f172a; text-align: right; font-weight: 500;">${data.studentsCount || 0} Students | ${data.teachersCount || 0} Staff</td>
                </tr>
                <tr>
                  <td style="font-weight: 700; color: #64748b;">Preferred Term</td>
                  <td style="color: #0f172a; text-align: right; font-weight: 500;">${data.contractTerm || 'Not Specified'}</td>
                </tr>
              </table>
            </div>
            <p style="font-size: 15px; line-height: 1.6; margin-bottom: 30px; color: #475569; text-align: center;">If you have any questions, simply reply to this email.</p>
            <p style="font-size: 16px; line-height: 1.6; margin-bottom: 10px; text-align: center; color: #0f172a;">Warm regards,<br><strong style="color: #1e3a8a;">The ConnectUs Team</strong></p>
          </td>
        </tr>
        <tr>
          <td style="background-color: #f8fafc; text-align: center; padding: 24px 20px; border-top: 1px solid #e2e8f0; border-bottom-left-radius: 12px; border-bottom-right-radius: 12px;">
            <p style="font-size: 12px; color: #94a3b8; margin: 0; font-weight: 600;">&copy; ${new Date().getFullYear()} ConnectUs. All rights reserved.</p>
          </td>
        </tr>
      </table>
    </div>
    `;

    const hqHtml = `
    <div style="background-color: #f8fafc; padding: 40px 20px; font-family: 'Helvetica Neue', Helvetica, Arial, sans-serif; color: #334155;">
      <table width="100%" cellpadding="0" cellspacing="0" border="0" style="max-width: 600px; margin: 0 auto; background-color: #ffffff; border-radius: 12px; border: 1px solid #e2e8f0;">
        <tr>
          <td style="text-align: center; padding: 40px 20px 10px 20px;">
            <img src="https://connectusonline.org/assets/images/logo.png" alt="ConnectUs Logo" style="height: 45px; display: block; margin: 0 auto;">
          </td>
        </tr>
        <tr>
          <td style="padding: 10px 40px 30px 40px;">
            <h2 style="color: #1e3a8a; font-size: 22px; font-weight: 800; margin-top: 0; margin-bottom: 8px; text-align: center;">New Quote Request</h2>
            <p style="text-align: center; color: #64748b; font-size: 14px; margin: 0;">Request ID: <strong style="color: #1e3a8a; font-family: monospace; font-size: 16px;">${reqId}</strong></p>
            <div style="background-color: #f1f5f9; border-radius: 8px; padding: 24px; margin-top: 30px; margin-bottom: 20px;">
              <h3 style="color: #0f172a; font-size: 12px; text-transform: uppercase; letter-spacing: 1.5px; margin-top: 0; margin-bottom: 16px; border-bottom: 1px solid #cbd5e1; padding-bottom: 10px;">Contact Details</h3>
              <table width="100%" cellpadding="0" cellspacing="0" border="0" style="font-size: 14px; line-height: 2;">
                <tr><td style="font-weight: 700; width: 35%; color: #64748b;">Name</td><td style="color: #0f172a; text-align: right; font-weight: 500;">${data.firstName || ''} ${data.lastName || ''}</td></tr>
                <tr><td style="font-weight: 700; color: #64748b;">Title</td><td style="color: #0f172a; text-align: right; font-weight: 500;">${data.jobTitle || 'N/A'}</td></tr>
                <tr><td style="font-weight: 700; color: #64748b;">Email</td><td style="text-align: right; font-weight: 500;"><a href="mailto:${data.workEmail}" style="color: #2563eb; text-decoration: none;">${data.workEmail}</a></td></tr>
                <tr><td style="font-weight: 700; color: #64748b;">Phone</td><td style="color: #0f172a; text-align: right; font-weight: 500;">${data.phone || 'N/A'}</td></tr>
              </table>
            </div>
            <div style="background-color: #f1f5f9; border-radius: 8px; padding: 24px;">
              <h3 style="color: #0f172a; font-size: 12px; text-transform: uppercase; letter-spacing: 1.5px; margin-top: 0; margin-bottom: 16px; border-bottom: 1px solid #cbd5e1; padding-bottom: 10px;">School Profile</h3>
              <table width="100%" cellpadding="0" cellspacing="0" border="0" style="font-size: 14px; line-height: 2;">
                <tr><td style="font-weight: 700; width: 35%; color: #64748b;">Institution</td><td style="color: #0f172a; text-align: right; font-weight: 500;">${data.schoolName || 'N/A'}</td></tr>
                <tr><td style="font-weight: 700; color: #64748b;">Type</td><td style="color: #0f172a; text-align: right; font-weight: 500;">${data.schoolType || 'N/A'}</td></tr>
                <tr><td style="font-weight: 700; color: #64748b;">Location</td><td style="color: #0f172a; text-align: right; font-weight: 500;">${data.city || 'N/A'}, ${data.country || 'N/A'}</td></tr>
                <tr><td style="font-weight: 700; color: #64748b;">Scale</td><td style="color: #0f172a; text-align: right; font-weight: 500;">${data.studentsCount || 0} Students | ${data.teachersCount || 0} Staff</td></tr>
                <tr><td style="font-weight: 700; color: #64748b;">Contract</td><td style="color: #0f172a; text-align: right; font-weight: 500;">${data.contractTerm || 'Not Specified'}</td></tr>
              </table>
            </div>
          </td>
        </tr>
      </table>
    </div>
    `;

    try {
        const batch = db.batch();
        batch.set(db.collection('mail').doc(), {
            to: data.workEmail,
            message: { subject: "We received your ConnectUs quote request", html: customerHtml }
        });
        batch.set(db.collection('mail').doc(), {
            to: HQ_EMAIL_ADDRESS,
            message: { subject: `New Quote Request: ${data.schoolName || 'Unknown School'}`, html: hqHtml }
        });
        await batch.commit();
        console.log(`Quote emails sent for Request ID: ${reqId}`);
    } catch (error) {
        console.error(`Failed to send quote emails for ${reqId}:`, error);
    }

    return null;
});
// --- END: onQuoteRequestCreated ---


// --- START: onQuoteApproved ---
exports.onQuoteApproved = onDocumentUpdated("quote_requests/{reqId}", async (event) => {
    const before = event.data.before.data();
    const after  = event.data.after.data();
    const reqId  = event.params.reqId;

    const justApproved = !before.paymentCleared && after.paymentCleared;
    const manualResend = before.resendTrigger !== after.resendTrigger;

    if (!justApproved && !manualResend) return null;
    if (!after.workEmail) return null;

    const onboardingLink = `https://connectusonline.org/onboarding/onboarding.html?req=${reqId}`;

    const approvedHtml = `
    <!DOCTYPE html>
    <html>
    <head><meta charset="utf-8"></head>
    <body style="margin: 0; padding: 0; background-color: #f8faff; font-family: 'Helvetica Neue', Helvetica, Arial, sans-serif; color: #1e293b;">
        <table width="100%" cellpadding="0" cellspacing="0" border="0" style="background-color: #f8faff; padding: 40px 20px;">
            <tr>
                <td align="center">
                    <table width="100%" max-width="600" cellpadding="0" cellspacing="0" border="0" style="background-color: #ffffff; border-radius: 16px; border: 1px solid #e2e8f0; max-width: 500px; overflow: hidden; box-shadow: 0 4px 6px -1px rgba(0, 0, 0, 0.05);">
                        <tr><td height="6" style="background: linear-gradient(to right, #10b981, #0ea5e9, #3b82f6);"></td></tr>
                        <tr>
                            <td style="padding: 40px 40px 30px;">
                                <div style="text-align: center; margin-bottom: 30px;">
                                    <img src="https://connectusonline.org/assets/images/logo.png" alt="ConnectUs Logo" style="width: 70px; height: auto;">
                                </div>
                                <h2 style="margin: 0 0 20px; font-size: 22px; font-weight: 800; color: #0f172a; text-align: center;">Account Approved!</h2>
                                <p style="margin: 0 0 15px; font-size: 15px; line-height: 1.6; color: #475569;">Hello <strong>${after.firstName || 'there'}</strong>,</p>
                                <p style="margin: 0 0 25px; font-size: 15px; line-height: 1.6; color: #475569;">Great news! Payment for <strong>${after.schoolName || 'your school'}</strong> has been verified and your secure cloud infrastructure is ready to be initialized.</p>
                                <p style="margin: 0 0 25px; font-size: 15px; line-height: 1.6; color: #475569;">Please click the button below to set up your Master Admin Code and generate your official School ID.</p>
                                <div style="text-align: center; margin-bottom: 35px; margin-top: 16px;">
                                    <a href="${onboardingLink}" style="display: inline-block; background-color: #10b981; color: #ffffff; text-decoration: none; font-size: 15px; font-weight: bold; padding: 14px 28px; border-radius: 12px; box-shadow: 0 4px 6px -1px rgba(16, 185, 129, 0.3);">
                                        Initialize My School &rarr;
                                    </a>
                                </div>
                                <p style="margin: 0 0 15px; font-size: 13px; line-height: 1.6; color: #64748b;">Welcome to the ConnectUs family! If you need any assistance during setup, our team is standing by.</p>
                            </td>
                        </tr>
                        <tr>
                            <td style="background-color: #f1f5f9; padding: 20px; text-align: center; border-top: 1px solid #e2e8f0;">
                                <p style="margin: 0; font-size: 12px; font-weight: bold; color: #94a3b8;">&copy; ${new Date().getFullYear()} ConnectUs. All rights reserved.</p>
                            </td>
                        </tr>
                    </table>
                </td>
            </tr>
        </table>
    </body>
    </html>
    `;

    try {
        await db.collection('mail').add({
            to: after.workEmail,
            message: { subject: "Your ConnectUs Account is Approved & Ready", html: approvedHtml }
        });
        console.log(`Onboarding email sent successfully for Request ID: ${reqId}`);
    } catch (error) {
        console.error(`Failed to send onboarding email for ${reqId}:`, error);
    }

    return null;
});
// --- END: onQuoteApproved ---


// --- START: onPinResetRequested ---
exports.onPinResetRequested = onDocumentCreated("reset_vault/{tokenId}", async (event) => {
    const data    = event.data.data();
    const tokenId = event.params.tokenId;

    if (!data || !data.email) return null;

    const resetLink     = `https://connectusonline.org/onboarding/reset-pin.html?token=${tokenId}`;
    const userName      = data.name      || 'ConnectUs User';
    const userRoleLabel = data.roleLabel || data.userType || 'Account';

    const resetHtml = `
    <!DOCTYPE html>
    <html>
    <head><meta charset="utf-8"></head>
    <body style="margin: 0; padding: 0; background-color: #f8faff; font-family: 'Helvetica Neue', Helvetica, Arial, sans-serif; color: #1e293b;">
        <table width="100%" cellpadding="0" cellspacing="0" border="0" style="background-color: #f8faff; padding: 40px 20px;">
            <tr>
                <td align="center">
                    <table width="100%" max-width="600" cellpadding="0" cellspacing="0" border="0" style="background-color: #ffffff; border-radius: 16px; border: 1px solid #e2e8f0; max-width: 500px; overflow: hidden; box-shadow: 0 4px 6px -1px rgba(0, 0, 0, 0.05);">
                        <tr><td height="6" style="background: linear-gradient(to right, #3b82f6, #22d3ee, #2563eb);"></td></tr>
                        <tr>
                            <td style="padding: 40px 40px 30px;">
                                <div style="text-align: center; margin-bottom: 30px;">
                                    <img src="https://connectusonline.org/assets/images/logo.png" alt="ConnectUs Logo" style="width: 70px; height: auto;">
                                </div>
                                <h2 style="margin: 0 0 20px; font-size: 22px; font-weight: 800; color: #1e3a8a; text-align: center;">Reset Your PIN</h2>
                                <p style="margin: 0 0 15px; font-size: 15px; line-height: 1.6; color: #475569;">Hello <strong>${userName}</strong>,</p>
                                <p style="margin: 0 0 25px; font-size: 15px; line-height: 1.6; color: #475569;">A request has been made to reset the secure PIN for your <strong>${userRoleLabel}</strong> account on ConnectUs.</p>
                                <div style="text-align: center; margin-bottom: 25px;">
                                    <a href="${resetLink}" style="display: inline-block; background-color: #2563eb; color: #ffffff; text-decoration: none; font-size: 15px; font-weight: bold; padding: 14px 28px; border-radius: 12px;">
                                        Reset My PIN &rarr;
                                    </a>
                                </div>
                                <p style="margin: 0 0 15px; font-size: 13px; line-height: 1.6; color: #64748b;"><em>Security Notice:</em> This link is only valid for <strong>15 minutes</strong>. If you did not request this reset, you can safely ignore this email. Your current PIN will remain active and secure.</p>
                            </td>
                        </tr>
                        <tr>
                            <td style="background-color: #f1f5f9; padding: 20px; text-align: center; border-top: 1px solid #e2e8f0;">
                                <p style="margin: 0; font-size: 12px; font-weight: bold; color: #94a3b8;">&copy; ${new Date().getFullYear()} ConnectUs. All rights reserved.</p>
                            </td>
                        </tr>
                    </table>
                </td>
            </tr>
        </table>
    </body>
    </html>
    `;

    try {
        await db.collection('mail').add({
            to: data.email,
            message: { subject: "ConnectUs: Reset Your PIN", html: resetHtml }
        });
        console.log(`PIN Reset email sent successfully for Vault ID: ${tokenId}`);
    } catch (error) {
        console.error(`Failed to send PIN Reset email for ${tokenId}:`, error);
    }

    return null;
});
// --- END: onPinResetRequested ----

// ═══════════════════════════════════════════════════════════════════════════════
// FUNCTION: onPayPalWebhook
// PayPal calls this HTTP endpoint after every subscription event.
//
// ACTIVATED      → Check registered_emails for existing school:
//                    EXISTING SCHOOL → reactivation/upgrade/downgrade:
//                      restore isVerified, update limits + renewal, send access-restored email
//                    NEW SUBSCRIBER → create quote_requests doc → onboarding email
//                    + Always sends HQ notification email
// CANCELLED      → Log on school, send access-end warning email with resubscribe link
// EXPIRED        → set isVerified: false
// SUSPENDED      → set isVerified: false + send warning email
// RE-ACTIVATED   → set isVerified: true
// PAYMENT_FAILED → send payment warning email
// ═══════════════════════════════════════════════════════════════════════════════

// ── Plan ID → metadata ────────────────────────────────────────────────────────
const PAYPAL_PLAN_MAP = {
    'P-0UL37863M97063045NIW37PI': { name: 'Starter',    billing: 'Monthly', studentLimit: 50,  teacherLimit: 10, adminLimit: 1  },
    'P-5J910723KW0535525NIW4G4A': { name: 'Starter',    billing: 'Annual',  studentLimit: 50,  teacherLimit: 10, adminLimit: 1  },
    'P-28435725CS726141KNIW4B6Q': { name: 'Growth',     billing: 'Monthly', studentLimit: 150, teacherLimit: 20, adminLimit: 3  },
    'P-03P84578KM718651VNIW4HWY': { name: 'Growth',     billing: 'Annual',  studentLimit: 150, teacherLimit: 20, adminLimit: 3  },
    'P-0RT15498C13842600NIW4DRY': { name: 'Enterprise', billing: 'Monthly', studentLimit: 300, teacherLimit: 30, adminLimit: 10 },
    'P-70B49562LT272180NNIW4IPI': { name: 'Enterprise', billing: 'Annual',  studentLimit: 300, teacherLimit: 30, adminLimit: 10 },
};

// ── PayPal credentials ────────────────────────────────────────────────────────
const PAYPAL_CLIENT_ID     = 'BAAhXsbZgDW5jGo0Si8njtFHI2dGsZJPVxyoinNCz_HiewmcGQ6us-loylu319j9noes5xkUZ39n4TbCXQ';
const PAYPAL_CLIENT_SECRET = 'EHsJv8Uy_gWWJBY7KQTaMzgjTGkF6DGodak09KVQHL63U63uFeXdre5dJfrsZ65FtoEt2E_iNBttB4cw';
const PAYPAL_WEBHOOK_ID    = '70Y5330321971452U';
const PAYPAL_API_BASE      = 'https://api-m.paypal.com';

// ── Get PayPal access token ───────────────────────────────────────────────────
async function getPayPalAccessToken() {
    const response = await fetch(`${PAYPAL_API_BASE}/v1/oauth2/token`, {
        method:  'POST',
        headers: {
            'Content-Type':  'application/x-www-form-urlencoded',
            'Authorization': 'Basic ' + Buffer.from(`${PAYPAL_CLIENT_ID}:${PAYPAL_CLIENT_SECRET}`).toString('base64')
        },
        body: 'grant_type=client_credentials'
    });
    const data = await response.json();
    return data.access_token;
}

// ── Verify PayPal webhook signature ──────────────────────────────────────────
async function verifyPayPalWebhook(headers, rawBody) {
    try {
        const accessToken = await getPayPalAccessToken();
        const response    = await fetch(`${PAYPAL_API_BASE}/v1/notifications/verify-webhook-signature`, {
            method:  'POST',
            headers: {
                'Content-Type':  'application/json',
                'Authorization': `Bearer ${accessToken}`
            },
            body: JSON.stringify({
                auth_algo:         headers['paypal-auth-algo'],
                cert_url:          headers['paypal-cert-url'],
                transmission_id:   headers['paypal-transmission-id'],
                transmission_sig:  headers['paypal-transmission-sig'],
                transmission_time: headers['paypal-transmission-time'],
                webhook_id:        PAYPAL_WEBHOOK_ID,
                webhook_event:     JSON.parse(rawBody)
            })
        });
        const result = await response.json();
        return result.verification_status === 'SUCCESS';
    } catch (err) {
        console.error('[onPayPalWebhook] Signature verification failed:', err);
        return false;
    }
}

// ── Find school by PayPal subscription ID ────────────────────────────────────
async function findSchoolBySubscription(subscriptionId) {
    const snap = await db.collection('schools')
        .where('paypalSubscriptionId', '==', subscriptionId)
        .limit(1)
        .get();
    return snap.empty ? null : { id: snap.docs[0].id, ...snap.docs[0].data() };
}

// ── Find existing school by subscriber email via registered_emails ────────────
// Used to detect reactivations, upgrades, and downgrades.
// Returns { schoolId, schoolData } or null if no existing school found.
async function findExistingSchoolByEmail(email) {
    if (!email) return null;
    const normalizedEmail = email.toLowerCase().trim();
    try {
        const regSnap = await db.collection('registered_emails').doc(normalizedEmail).get();
        if (!regSnap.exists) return null;
        const regData = regSnap.data();
        if (regData.role !== 'admin' || !regData.referenceId) return null;
        const schoolSnap = await db.collection('schools').doc(regData.referenceId).get();
        if (!schoolSnap.exists) return null;
        return { schoolId: schoolSnap.id, schoolData: schoolSnap.data() };
    } catch (err) {
        console.error('[findExistingSchoolByEmail] Error:', err);
        return null;
    }
}

// ── Generate Request ID ───────────────────────────────────────────────────────
function generateReqId() {
    const chars = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
    let rand = '';
    for (let i = 0; i < 5; i++) rand += chars.charAt(Math.floor(Math.random() * chars.length));
    return `REQ-${rand}`;
}

// ── Main webhook handler ──────────────────────────────────────────────────────
exports.onPayPalWebhook = onRequest({ region: 'us-central1' }, async (req, res) => {

    if (req.method !== 'POST') {
        res.status(405).send('Method Not Allowed');
        return;
    }

    // Collect raw body for signature verification
    let rawBody = '';
    req.on('data', chunk => { rawBody += chunk.toString(); });
    await new Promise(resolve => req.on('end', resolve));

    // ── Verify the request is genuinely from PayPal ───────────────────────────
    const isValid = await verifyPayPalWebhook(req.headers, rawBody);
    if (!isValid) {
        console.warn('[onPayPalWebhook] Invalid signature — request rejected.');
        res.status(400).send('Invalid signature');
        return;
    }

    let event;
    try {
        event = JSON.parse(rawBody);
    } catch (e) {
        res.status(400).send('Invalid JSON');
        return;
    }

    const eventType       = event.event_type;
    const resource        = event.resource || {};
    const subscriptionId  = resource.id || resource.billing_agreement_id || '';
    const planId          = resource.plan_id || '';
    const subscriberEmail = resource.subscriber?.email_address || '';
    const subscriberName  = resource.subscriber?.name || {};
    const firstName       = subscriberName.given_name || '';
    const lastName        = subscriberName.surname    || '';

    console.log(`[onPayPalWebhook] Event: ${eventType} | Subscription: ${subscriptionId} | Plan: ${planId}`);

    try {

        // ════════════════════════════════════════════════════════════════════
        // ACTIVATED
        // Handles: new subscribers, reactivations, upgrades, downgrades,
        // and billing cycle changes (monthly ↔ annual).
        // ════════════════════════════════════════════════════════════════════
        if (eventType === 'BILLING.SUBSCRIPTION.ACTIVATED') {

            const plan = PAYPAL_PLAN_MAP[planId];
            if (!plan) {
                console.error(`[onPayPalWebhook] Unknown plan ID: ${planId}`);
                res.status(200).send('OK');
                return;
            }

            const now       = new Date();
            const expiresAt = plan.billing === 'Annual'
                ? new Date(new Date().setFullYear(now.getFullYear() + 1)).toISOString()
                : new Date(new Date().setMonth(now.getMonth() + 1)).toISOString();

            // ── Check if this subscriber already has a school ─────────────────
            const existing = await findExistingSchoolByEmail(subscriberEmail);

            if (existing) {
                // ── REACTIVATION / UPGRADE / DOWNGRADE ────────────────────────
                // School already exists — restore access and update plan details.
                // No new onboarding needed. All data is preserved.
                const { schoolId, schoolData } = existing;

                await db.collection('schools').doc(schoolId).update({
                    isVerified:              true,
                    isActive:                true,
                    subscriptionStatus:      'Active',
                    statusReason:            null,
                    subscriptionEndedAt:     null,
                    paypalSubscriptionId:    subscriptionId,
                    paypalPlanId:            planId,
                    subscriptionName:        `ConnectUs ${plan.name}`,
                    subscriptionPlanId:      planId,
                    billingCycle:            plan.billing,
                    nextRenewalDate:         expiresAt,
                    subscriptionActivatedAt: now.toISOString(),
                    limits: {
                        studentLimit: plan.studentLimit,
                        teacherLimit: plan.teacherLimit,
                        adminLimit:   plan.adminLimit
                    }
                });

                console.log(`[onPayPalWebhook] REACTIVATION — restored school ${schoolId} for ${subscriberEmail} on plan ${plan.name} ${plan.billing}`);

                // ── Send access-restored email to the school ──────────────────
                const contactEmail = schoolData.contactEmail || subscriberEmail;
                const schoolName   = schoolData.schoolName   || 'Your School';
                const schoolId2    = schoolId;

                const restoredHtml = `
                <!DOCTYPE html><html><head><meta charset="utf-8"></head>
                <body style="margin:0;padding:0;background:#f8faff;font-family:'Helvetica Neue',Arial,sans-serif;">
                <table width="100%" cellpadding="0" cellspacing="0" style="padding:40px 20px;">
                  <tr><td align="center">
                    <table width="100%" cellpadding="0" cellspacing="0" style="max-width:520px;background:#fff;border-radius:16px;border:1px solid #e2e8f0;overflow:hidden;box-shadow:0 4px 20px rgba(0,0,0,0.06);">
                      <tr><td height="6" style="background:linear-gradient(to right,#10b981,#0ea5e9,#3b82f6);"></td></tr>
                      <tr><td style="padding:40px 40px 30px;text-align:center;">
                        <img src="https://connectusonline.org/assets/images/logo.png" style="height:48px;margin-bottom:24px;display:block;margin-left:auto;margin-right:auto;">
                        <h2 style="color:#0f172a;font-size:22px;font-weight:800;margin:0 0 16px;">Access Restored!</h2>
                        <p style="color:#475569;font-size:15px;line-height:1.6;margin:0 0 20px;">
                          Your ConnectUs subscription for <strong>${schoolName}</strong> has been reactivated successfully.
                          All your school data — teachers, students, grades — is exactly as you left it.
                        </p>

                        <table width="100%" cellpadding="0" cellspacing="0" style="background:#f8fafc;border:1px solid #e2e8f0;border-radius:12px;overflow:hidden;margin:0 0 28px;text-align:left;">
                          <tr><td colspan="2" style="padding:12px 16px;background:#0f172a;">
                            <p style="margin:0;font-size:10px;font-weight:800;color:#94a3b8;text-transform:uppercase;letter-spacing:0.15em;">Your Subscription</p>
                          </td></tr>
                          <tr>
                            <td style="padding:10px 16px;font-size:12px;font-weight:700;color:#64748b;text-transform:uppercase;letter-spacing:0.08em;width:40%;border-bottom:1px solid #f1f5f9;">Plan</td>
                            <td style="padding:10px 16px;font-size:14px;font-weight:800;color:#0f172a;border-bottom:1px solid #f1f5f9;">ConnectUs ${plan.name} — ${plan.billing}</td>
                          </tr>
                          <tr>
                            <td style="padding:10px 16px;font-size:12px;font-weight:700;color:#64748b;text-transform:uppercase;letter-spacing:0.08em;width:40%;border-bottom:1px solid #f1f5f9;">Limits</td>
                            <td style="padding:10px 16px;font-size:14px;font-weight:800;color:#0f172a;border-bottom:1px solid #f1f5f9;">${plan.studentLimit} Students · ${plan.teacherLimit} Teachers · ${plan.adminLimit} Admins</td>
                          </tr>
                          <tr>
                            <td style="padding:10px 16px;font-size:12px;font-weight:700;color:#64748b;text-transform:uppercase;letter-spacing:0.08em;width:40%;border-bottom:1px solid #f1f5f9;">Next Renewal</td>
                            <td style="padding:10px 16px;font-size:14px;font-weight:800;color:#10b981;border-bottom:1px solid #f1f5f9;">${new Date(expiresAt).toLocaleDateString('en-US', { year: 'numeric', month: 'long', day: 'numeric' })}</td>
                          </tr>
                          <tr>
                            <td style="padding:10px 16px;font-size:12px;font-weight:700;color:#64748b;text-transform:uppercase;letter-spacing:0.08em;width:40%;">School ID</td>
                            <td style="padding:10px 16px;font-size:14px;font-weight:800;color:#0f172a;font-family:monospace;letter-spacing:0.1em;">${schoolId2}</td>
                          </tr>
                        </table>

                        <a href="https://connectusonline.org/admin/login.html" style="display:inline-block;background:linear-gradient(135deg,#10b981,#0ea5e9);color:#fff;text-decoration:none;font-size:15px;font-weight:800;padding:14px 28px;border-radius:12px;box-shadow:0 4px 14px rgba(16,185,129,0.3);">
                          Log In to Your Portal &rarr;
                        </a>
                        <p style="color:#64748b;font-size:13px;margin:24px 0 0;line-height:1.6;">
                          Questions? Email us at <a href="mailto:info@connectusonline.org" style="color:#2563eb;font-weight:700;">info@connectusonline.org</a>
                        </p>
                      </td></tr>
                      <tr><td style="background:#f8fafc;padding:20px;text-align:center;border-top:1px solid #e2e8f0;">
                        <p style="margin:0;font-size:12px;color:#94a3b8;font-weight:700;">&copy; ${new Date().getFullYear()} ConnectUs. All rights reserved.</p>
                      </td></tr>
                    </table>
                  </td></tr>
                </table>
                </body></html>`;

                await db.collection('mail').add({
                    to: contactEmail,
                    message: {
                        subject: `Welcome Back — ${schoolName} Access Restored on ConnectUs`,
                        html:    restoredHtml
                    }
                });

                // ── HQ notification for reactivation ─────────────────────────
                await db.collection('mail').add({
                    to: HQ_EMAIL_ADDRESS,
                    message: {
                        subject: `🔄 Reactivation: ${schoolName} (${schoolId}) — ConnectUs ${plan.name} ${plan.billing}`,
                        html: `<p style="font-family:sans-serif;font-size:14px;color:#334155;">
                            <strong>${schoolName}</strong> (${schoolId}) has reactivated their ConnectUs subscription.<br><br>
                            <strong>Plan:</strong> ConnectUs ${plan.name} — ${plan.billing}<br>
                            <strong>Limits:</strong> ${plan.studentLimit} students · ${plan.teacherLimit} teachers · ${plan.adminLimit} admins<br>
                            <strong>Renewal:</strong> ${new Date(expiresAt).toLocaleDateString('en-US', { year: 'numeric', month: 'long', day: 'numeric' })}<br>
                            <strong>Subscriber Email:</strong> ${subscriberEmail}<br>
                            <strong>PayPal Subscription ID:</strong> ${subscriptionId}
                        </p>`
                    }
                });

            } else {
                // ── NEW SUBSCRIBER ────────────────────────────────────────────
                // No existing school found — create quote_requests doc.
                // onQuoteApproved fires automatically (paymentCleared: true)
                // and sends the onboarding email.
                const reqId = generateReqId();

                await db.collection('quote_requests').doc(reqId).set({
                    requestId:             reqId,
                    source:                'paypal',
                    paypalSubscriptionId:  subscriptionId,
                    paypalPlanId:          planId,
                    firstName,
                    lastName,
                    fullName:              `${firstName} ${lastName}`.trim(),
                    jobTitle:              '',
                    workEmail:             subscriberEmail,
                    phone:                 '',
                    schoolName:            '',
                    schoolType:            '',
                    country:               '',
                    city:                  '',
                    stateProvince:         '',
                    studentsCount:         plan.studentLimit,
                    teachersCount:         plan.teacherLimit,
                    contractTerm:          plan.billing,
                    hearAboutUs:           'PayPal Subscription',
                    message:               '',
                    status:                'Paid',
                    fulfilled:             false,
                    paymentCleared:        true,
                    approvedPlanId:        planId,
                    approvedPlanName:      `ConnectUs ${plan.name}`,
                    approvedBillingCycle:  plan.billing,
                    calculatedRenewalDate: expiresAt,
                    approvedLimits: {
                        studentLimit: plan.studentLimit,
                        teacherLimit: plan.teacherLimit,
                        adminLimit:   plan.adminLimit
                    },
                    createdAt: now.toISOString()
                });

                console.log(`[onPayPalWebhook] NEW SUBSCRIBER — created quote_requests/${reqId} for ${subscriberEmail}`);

                // ── HQ notification for new subscriber ────────────────────────
                const hqNotificationHtml = `
                <!DOCTYPE html>
                <html>
                <head><meta charset="utf-8"></head>
                <body style="margin:0;padding:0;background:#f1f5f9;font-family:'Helvetica Neue',Helvetica,Arial,sans-serif;color:#1e293b;">
                  <table width="100%" cellpadding="0" cellspacing="0" border="0" style="background:#f1f5f9;padding:40px 20px;">
                    <tr><td align="center">
                      <table width="100%" cellpadding="0" cellspacing="0" border="0" style="max-width:580px;background:#ffffff;border-radius:16px;overflow:hidden;box-shadow:0 4px 24px rgba(0,0,0,0.08);">
                        <tr><td height="6" style="background:linear-gradient(to right,#10b981,#0ea5e9,#3b82f6);"></td></tr>
                        <tr>
                          <td style="text-align:center;padding:36px 40px 20px;">
                            <img src="https://connectusonline.org/assets/images/logo.png" alt="ConnectUs" style="height:48px;display:block;margin:0 auto;">
                          </td>
                        </tr>
                        <tr>
                          <td style="padding:0 40px 40px;">
                            <div style="background:#dcfce7;border:1px solid #86efac;border-radius:12px;padding:16px 20px;margin-bottom:28px;text-align:center;">
                              <p style="margin:0;font-size:13px;font-weight:800;color:#15803d;">
                                <span style="font-size:20px;margin-right:8px;">💳</span>
                                New PayPal Subscription Received
                              </p>
                            </div>
                            <h2 style="margin:0 0 6px;font-size:22px;font-weight:900;color:#0f172a;">New School Subscribed</h2>
                            <p style="margin:0 0 28px;font-size:14px;color:#64748b;font-weight:600;">
                              Payment confirmed via PayPal. Onboarding link has been sent to the subscriber automatically.
                            </p>
                            <table width="100%" cellpadding="0" cellspacing="0" border="0" style="background:#f8fafc;border:1px solid #e2e8f0;border-radius:12px;overflow:hidden;margin-bottom:20px;">
                              <tr><td colspan="2" style="padding:12px 16px;background:#0f172a;">
                                <p style="margin:0;font-size:10px;font-weight:800;color:#94a3b8;text-transform:uppercase;letter-spacing:0.15em;">Subscription Details</p>
                              </td></tr>
                              <tr>
                                <td style="padding:10px 16px;font-size:12px;font-weight:700;color:#64748b;text-transform:uppercase;letter-spacing:0.08em;width:40%;border-bottom:1px solid #f1f5f9;">Subscriber</td>
                                <td style="padding:10px 16px;font-size:14px;font-weight:800;color:#0f172a;border-bottom:1px solid #f1f5f9;">${`${firstName} ${lastName}`.trim() || 'Unknown'}</td>
                              </tr>
                              <tr>
                                <td style="padding:10px 16px;font-size:12px;font-weight:700;color:#64748b;text-transform:uppercase;letter-spacing:0.08em;width:40%;border-bottom:1px solid #f1f5f9;">Email</td>
                                <td style="padding:10px 16px;font-size:14px;font-weight:800;color:#2563eb;border-bottom:1px solid #f1f5f9;">${subscriberEmail}</td>
                              </tr>
                              <tr>
                                <td style="padding:10px 16px;font-size:12px;font-weight:700;color:#64748b;text-transform:uppercase;letter-spacing:0.08em;width:40%;border-bottom:1px solid #f1f5f9;">Plan</td>
                                <td style="padding:10px 16px;font-size:14px;font-weight:800;color:#0f172a;border-bottom:1px solid #f1f5f9;">ConnectUs ${plan.name} — ${plan.billing}</td>
                              </tr>
                              <tr>
                                <td style="padding:10px 16px;font-size:12px;font-weight:700;color:#64748b;text-transform:uppercase;letter-spacing:0.08em;width:40%;border-bottom:1px solid #f1f5f9;">Limits</td>
                                <td style="padding:10px 16px;font-size:14px;font-weight:800;color:#0f172a;border-bottom:1px solid #f1f5f9;">${plan.studentLimit} Students · ${plan.teacherLimit} Teachers · ${plan.adminLimit} Admin</td>
                              </tr>
                              <tr>
                                <td style="padding:10px 16px;font-size:12px;font-weight:700;color:#64748b;text-transform:uppercase;letter-spacing:0.08em;width:40%;border-bottom:1px solid #f1f5f9;">Renewal</td>
                                <td style="padding:10px 16px;font-size:14px;font-weight:800;color:#0f172a;border-bottom:1px solid #f1f5f9;">${new Date(expiresAt).toLocaleDateString('en-US', { year: 'numeric', month: 'long', day: 'numeric' })}</td>
                              </tr>
                              <tr>
                                <td style="padding:10px 16px;font-size:12px;font-weight:700;color:#64748b;text-transform:uppercase;letter-spacing:0.08em;width:40%;">Subscription ID</td>
                                <td style="padding:10px 16px;font-size:13px;font-weight:800;color:#0f172a;font-family:monospace;letter-spacing:0.08em;">${subscriptionId}</td>
                              </tr>
                            </table>
                            <p style="margin:0;font-size:13px;color:#64748b;line-height:1.6;">
                              You can view and manage this subscriber in the
                              <a href="https://connectusonline.org/platform_dashboard/approvals/approvals.html" style="color:#2563eb;font-weight:800;">HQ Approvals Dashboard</a>.
                            </p>
                          </td>
                        </tr>
                        <tr>
                          <td style="background:#f8fafc;padding:24px 40px;text-align:center;border-top:1px solid #e2e8f0;">
                            <p style="margin:0;font-size:12px;font-weight:700;color:#94a3b8;">&copy; ${new Date().getFullYear()} ConnectUs. All rights reserved.</p>
                          </td>
                        </tr>
                      </table>
                    </td></tr>
                  </table>
                </body>
                </html>`;

                await db.collection('mail').add({
                    to: HQ_EMAIL_ADDRESS,
                    message: {
                        subject: `💳 New Subscription: ConnectUs ${plan.name} (${plan.billing}) — ${subscriberEmail}`,
                        html:    hqNotificationHtml
                    }
                });
            }
        }

        // ════════════════════════════════════════════════════════════════════
        // EXPIRED
        // PayPal fires this when a subscription reaches its end without renewal.
        // Sets isVerified: false to lock the school out.
        // ════════════════════════════════════════════════════════════════════
        else if (eventType === 'BILLING.SUBSCRIPTION.EXPIRED') {
            const school = await findSchoolBySubscription(subscriptionId);
            if (school) {
                await db.collection('schools').doc(school.id).update({
                    isVerified:          false,
                    subscriptionStatus:  'Expired',
                    statusReason:        'Subscription expired',
                    subscriptionEndedAt: new Date().toISOString()
                });
                console.log(`[onPayPalWebhook] EXPIRED — suspended school ${school.id}`);
            } else {
                console.warn(`[onPayPalWebhook] EXPIRED — no school found for subscription ${subscriptionId}`);
            }
        }

        // ════════════════════════════════════════════════════════════════════
        // SUSPENDED
        // PayPal suspends after repeated payment failures.
        // Locks access and sends a warning email.
        // ════════════════════════════════════════════════════════════════════
        else if (eventType === 'BILLING.SUBSCRIPTION.SUSPENDED') {
            const school = await findSchoolBySubscription(subscriptionId);
            if (school) {
                await db.collection('schools').doc(school.id).update({
                    isVerified:         false,
                    subscriptionStatus: 'Suspended',
                    statusReason:       'Subscription suspended by PayPal'
                });

                if (school.contactEmail) {
                    const suspendedHtml = `
                    <!DOCTYPE html><html><head><meta charset="utf-8"></head>
                    <body style="margin:0;padding:0;background:#f8faff;font-family:'Helvetica Neue',Arial,sans-serif;">
                    <table width="100%" cellpadding="0" cellspacing="0" style="padding:40px 20px;">
                      <tr><td align="center">
                        <table width="100%" cellpadding="0" cellspacing="0" style="max-width:520px;background:#fff;border-radius:16px;border:1px solid #e2e8f0;overflow:hidden;box-shadow:0 4px 20px rgba(0,0,0,0.06);">
                          <tr><td height="6" style="background:linear-gradient(to right,#ef4444,#f97316);"></td></tr>
                          <tr><td style="padding:40px 40px 30px;text-align:center;">
                            <img src="https://connectusonline.org/assets/images/logo.png" style="height:48px;margin-bottom:24px;display:block;margin-left:auto;margin-right:auto;">
                            <h2 style="color:#0f172a;font-size:22px;font-weight:800;margin:0 0 16px;">Action Required: Subscription Suspended</h2>
                            <p style="color:#475569;font-size:15px;line-height:1.6;margin:0 0 20px;">
                              Your ConnectUs subscription for <strong>${school.schoolName || 'your school'}</strong> has been suspended due to a payment issue.
                              Your school portal access has been temporarily disabled.
                            </p>
                            <p style="color:#475569;font-size:15px;line-height:1.6;margin:0 0 28px;">
                              To restore access, please update your payment method in PayPal and reactivate your subscription.
                            </p>
                            <a href="https://www.paypal.com/myaccount/autopay/" style="display:inline-block;background:#2563eb;color:#fff;text-decoration:none;font-size:15px;font-weight:800;padding:14px 28px;border-radius:12px;">
                              Update Payment in PayPal &rarr;
                            </a>
                            <p style="color:#64748b;font-size:13px;margin:24px 0 0;line-height:1.6;">
                              Questions? Email us at <a href="mailto:info@connectusonline.org" style="color:#2563eb;font-weight:700;">info@connectusonline.org</a>
                            </p>
                          </td></tr>
                          <tr><td style="background:#f8fafc;padding:20px;text-align:center;border-top:1px solid #e2e8f0;">
                            <p style="margin:0;font-size:12px;color:#94a3b8;font-weight:700;">&copy; ${new Date().getFullYear()} ConnectUs. All rights reserved.</p>
                          </td></tr>
                        </table>
                      </td></tr>
                    </table>
                    </body></html>`;

                    await db.collection('mail').add({
                        to: school.contactEmail,
                        message: { subject: 'Action Required: Your ConnectUs Subscription Has Been Suspended', html: suspendedHtml }
                    });
                }
                console.log(`[onPayPalWebhook] SUSPENDED — suspended school ${school.id}`);
            }
        }

        // ════════════════════════════════════════════════════════════════════
        // RE-ACTIVATED
        // School fixed their payment method and reactivated through PayPal.
        // Restores access immediately.
        // ════════════════════════════════════════════════════════════════════
        else if (eventType === 'BILLING.SUBSCRIPTION.RE-ACTIVATED') {
            const school = await findSchoolBySubscription(subscriptionId);
            if (school) {
                await db.collection('schools').doc(school.id).update({
                    isVerified:         true,
                    subscriptionStatus: 'Active',
                    statusReason:       null
                });
                console.log(`[onPayPalWebhook] RE-ACTIVATED — restored school ${school.id}`);
            }
        }

        // ════════════════════════════════════════════════════════════════════
        // PAYMENT FAILED
        // Renewal charge failed. Sends warning email.
        // Access is NOT cut yet — PayPal will retry and suspend if needed.
        // ════════════════════════════════════════════════════════════════════
        else if (eventType === 'BILLING.SUBSCRIPTION.PAYMENT.FAILED') {
            const school = await findSchoolBySubscription(subscriptionId);
            if (school && school.contactEmail) {
                const failedHtml = `
                <!DOCTYPE html><html><head><meta charset="utf-8"></head>
                <body style="margin:0;padding:0;background:#f8faff;font-family:'Helvetica Neue',Arial,sans-serif;">
                <table width="100%" cellpadding="0" cellspacing="0" style="padding:40px 20px;">
                  <tr><td align="center">
                    <table width="100%" cellpadding="0" cellspacing="0" style="max-width:520px;background:#fff;border-radius:16px;border:1px solid #e2e8f0;overflow:hidden;box-shadow:0 4px 20px rgba(0,0,0,0.06);">
                      <tr><td height="6" style="background:linear-gradient(to right,#f59e0b,#ef4444);"></td></tr>
                      <tr><td style="padding:40px 40px 30px;text-align:center;">
                        <img src="https://connectusonline.org/assets/images/logo.png" style="height:48px;margin-bottom:24px;display:block;margin-left:auto;margin-right:auto;">
                        <h2 style="color:#0f172a;font-size:22px;font-weight:800;margin:0 0 16px;">Payment Failed</h2>
                        <p style="color:#475569;font-size:15px;line-height:1.6;margin:0 0 20px;">
                          We were unable to process the renewal payment for your ConnectUs subscription for
                          <strong>${school.schoolName || 'your school'}</strong>.
                        </p>
                        <p style="color:#475569;font-size:15px;line-height:1.6;margin:0 0 28px;">
                          Please update your payment method in PayPal to avoid any interruption to your school's access.
                          If payment is not updated, your subscription may be suspended.
                        </p>
                        <a href="https://www.paypal.com/myaccount/autopay/" style="display:inline-block;background:#f59e0b;color:#fff;text-decoration:none;font-size:15px;font-weight:800;padding:14px 28px;border-radius:12px;">
                          Update Payment in PayPal &rarr;
                        </a>
                        <p style="color:#64748b;font-size:13px;margin:24px 0 0;line-height:1.6;">
                          Need help? Email us at <a href="mailto:info@connectusonline.org" style="color:#2563eb;font-weight:700;">info@connectusonline.org</a>
                        </p>
                      </td></tr>
                      <tr><td style="background:#f8fafc;padding:20px;text-align:center;border-top:1px solid #e2e8f0;">
                        <p style="margin:0;font-size:12px;color:#94a3b8;font-weight:700;">&copy; ${new Date().getFullYear()} ConnectUs. All rights reserved.</p>
                      </td></tr>
                    </table>
                  </td></tr>
                </table>
                </body></html>`;

                await db.collection('mail').add({
                    to: school.contactEmail,
                    message: { subject: 'Payment Failed: Please Update Your ConnectUs Subscription', html: failedHtml }
                });
                console.log(`[onPayPalWebhook] PAYMENT_FAILED — warning sent to ${school.contactEmail}`);
            }
        }

        // ════════════════════════════════════════════════════════════════════
        // CANCELLED
        // School (or HQ) cancelled the subscription via PayPal.
        // Access continues to end of paid period (isVerified stays true).
        // Sends a clear email telling them when access ends and how to resubscribe.
        // ════════════════════════════════════════════════════════════════════
        else if (eventType === 'BILLING.SUBSCRIPTION.CANCELLED') {
            const school = await findSchoolBySubscription(subscriptionId);
            if (school) {
                // isVerified stays true — access continues to end of paid period per Terms
                await db.collection('schools').doc(school.id).update({
                    subscriptionStatus: 'Cancelled',
                    statusReason:       'Cancelled by subscriber via PayPal'
                });

                // Send access-end notification so they aren't surprised when locked out
                if (school.contactEmail) {
                    const renewalDate = school.nextRenewalDate
                        ? new Date(school.nextRenewalDate).toLocaleDateString('en-US', { year: 'numeric', month: 'long', day: 'numeric' })
                        : 'the end of your current billing period';

                    const cancelledHtml = `
                    <!DOCTYPE html><html><head><meta charset="utf-8"></head>
                    <body style="margin:0;padding:0;background:#f8faff;font-family:'Helvetica Neue',Arial,sans-serif;">
                    <table width="100%" cellpadding="0" cellspacing="0" style="padding:40px 20px;">
                      <tr><td align="center">
                        <table width="100%" cellpadding="0" cellspacing="0" style="max-width:520px;background:#fff;border-radius:16px;border:1px solid #e2e8f0;overflow:hidden;box-shadow:0 4px 20px rgba(0,0,0,0.06);">
                          <tr><td height="6" style="background:linear-gradient(to right,#64748b,#94a3b8);"></td></tr>
                          <tr><td style="padding:40px 40px 30px;text-align:center;">
                            <img src="https://connectusonline.org/assets/images/logo.png" style="height:48px;margin-bottom:24px;display:block;margin-left:auto;margin-right:auto;">
                            <h2 style="color:#0f172a;font-size:22px;font-weight:800;margin:0 0 16px;">Subscription Cancelled</h2>
                            <p style="color:#475569;font-size:15px;line-height:1.6;margin:0 0 20px;">
                              Your ConnectUs subscription for <strong>${school.schoolName || 'your school'}</strong> has been cancelled.
                            </p>

                            <div style="background:#f8fafc;border:1px solid #e2e8f0;border-radius:12px;padding:20px;margin:0 0 24px;text-align:left;">
                              <p style="margin:0 0 10px;font-size:13px;font-weight:800;color:#0f172a;text-transform:uppercase;letter-spacing:0.08em;">What happens next</p>
                              <p style="margin:0 0 10px;font-size:14px;color:#475569;line-height:1.6;">
                                ✓ <strong>Your access continues</strong> until <strong>${renewalDate}</strong>. You and your team can continue using ConnectUs normally until then.
                              </p>
                              <p style="margin:0 0 10px;font-size:14px;color:#475569;line-height:1.6;">
                                ✓ <strong>Your data is safe.</strong> All your school records — teachers, students, grades — are preserved.
                              </p>
                              <p style="margin:0;font-size:14px;color:#475569;line-height:1.6;">
                                ✓ <strong>No further charges.</strong> Your subscription will not renew.
                              </p>
                            </div>

                            <p style="color:#475569;font-size:15px;line-height:1.6;margin:0 0 24px;">
                              Changed your mind? You can resubscribe at any time — your school ID and all data will be right where you left it.
                            </p>
                            <a href="https://connectusonline.org/pricing.html" style="display:inline-block;background:#2563eb;color:#fff;text-decoration:none;font-size:15px;font-weight:800;padding:14px 28px;border-radius:12px;">
                              Resubscribe Anytime &rarr;
                            </a>
                            <p style="color:#64748b;font-size:13px;margin:24px 0 0;line-height:1.6;">
                              Questions? Email us at <a href="mailto:info@connectusonline.org" style="color:#2563eb;font-weight:700;">info@connectusonline.org</a>
                            </p>
                          </td></tr>
                          <tr><td style="background:#f8fafc;padding:20px;text-align:center;border-top:1px solid #e2e8f0;">
                            <p style="margin:0;font-size:12px;color:#94a3b8;font-weight:700;">&copy; ${new Date().getFullYear()} ConnectUs. All rights reserved.</p>
                          </td></tr>
                        </table>
                      </td></tr>
                    </table>
                    </body></html>`;

                    await db.collection('mail').add({
                        to: school.contactEmail,
                        message: {
                            subject: `Your ConnectUs Subscription Has Been Cancelled — ${school.schoolName || 'Access Continues Until ' + renewalDate}`,
                            html:    cancelledHtml
                        }
                    });
                }
                console.log(`[onPayPalWebhook] CANCELLED — logged on school ${school.id}`);
            }
        }

        // ── All other events ──────────────────────────────────────────────────
        else {
            console.log(`[onPayPalWebhook] Unhandled event: ${eventType}`);
        }

    } catch (err) {
        console.error(`[onPayPalWebhook] Error handling ${eventType}:`, err);
        res.status(500).send('Internal error');
        return;
    }

    // Always return 200 to PayPal — prevents retries
    res.status(200).send('OK');
});
// --- END: onPayPalWebhook ---


// ═══════════════════════════════════════════════════════════════════════════════
// FUNCTION: autoSuspendExpiredSchools
// Runs nightly at midnight Belize time (UTC-6 = 06:00 UTC).
// Safety net: if PayPal ever fails to fire a webhook for an expired or lapsed
// subscription, this function catches it and suspends the school automatically.
// Only touches schools that are currently active (isVerified: true), have a
// nextRenewalDate that has passed, and are not in Cancelled status.
// ═══════════════════════════════════════════════════════════════════════════════
exports.autoSuspendExpiredSchools = onSchedule(
    { schedule: '0 6 * * *', timeZone: 'America/Belize', region: 'us-central1' },
    async () => {
        const now     = new Date().toISOString();
        const results = { suspended: 0, checked: 0, errors: 0 };

        try {
            // Fetch all currently active schools — filter Cancelled in code
            // to avoid Firestore != query which requires a composite index
            const snap = await db.collection('schools')
                .where('isVerified', '==', true)
                .get();

            results.checked = snap.size;

            const batch     = db.batch();
            const suspended = [];

            snap.forEach(schoolDoc => {
                const data        = schoolDoc.data();
                const renewalDate = data.nextRenewalDate || data.calculatedRenewalDate || null;

                if (!renewalDate) return; // No renewal date — skip (manual/custom arrangement)

                // Skip schools that cancelled — they already received a cancellation
                // email and know their access ends on the renewal date
                if (data.subscriptionStatus === 'Cancelled') return;

                const isExpired = new Date(renewalDate) < new Date();
                if (!isExpired) return;

                // School's renewal date has passed — suspend it
                batch.update(schoolDoc.ref, {
                    isVerified:          false,
                    subscriptionStatus:  'Expired',
                    statusReason:        'Subscription expired — auto-suspended by system',
                    subscriptionEndedAt: now
                });

                suspended.push({
                    id:           schoolDoc.id,
                    schoolName:   data.schoolName   || 'Unknown',
                    contactEmail: data.contactEmail || null,
                    renewalDate
                });
            });

            if (suspended.length === 0) {
                console.log(`[autoSuspendExpiredSchools] Checked ${results.checked} schools — none expired.`);
                return;
            }

            await batch.commit();
            results.suspended = suspended.length;

            console.log(`[autoSuspendExpiredSchools] Suspended ${results.suspended} schools:`,
                suspended.map(s => `${s.id} (${s.schoolName})`).join(', '));

            // ── Send warning email to each suspended school ───────────────────
            const emailBatch = db.batch();

            for (const school of suspended) {
                if (!school.contactEmail) continue;

                const suspendedHtml = `
                <!DOCTYPE html>
                <html>
                <head><meta charset="utf-8"></head>
                <body style="margin:0;padding:0;background:#f8faff;font-family:'Helvetica Neue',Arial,sans-serif;">
                <table width="100%" cellpadding="0" cellspacing="0" style="padding:40px 20px;">
                  <tr><td align="center">
                    <table width="100%" cellpadding="0" cellspacing="0" style="max-width:520px;background:#fff;border-radius:16px;border:1px solid #e2e8f0;overflow:hidden;box-shadow:0 4px 20px rgba(0,0,0,0.06);">
                      <tr><td height="6" style="background:linear-gradient(to right,#f59e0b,#ef4444);"></td></tr>
                      <tr><td style="padding:40px 40px 30px;text-align:center;">
                        <img src="https://connectusonline.org/assets/images/logo.png" style="height:48px;margin-bottom:24px;display:block;margin-left:auto;margin-right:auto;">
                        <h2 style="color:#0f172a;font-size:22px;font-weight:800;margin:0 0 16px;">Subscription Expired</h2>
                        <p style="color:#475569;font-size:15px;line-height:1.6;margin:0 0 16px;">
                          Your ConnectUs subscription for <strong>${school.schoolName}</strong> has expired and your school portal access has been suspended.
                        </p>
                        <p style="color:#475569;font-size:15px;line-height:1.6;margin:0 0 28px;">
                          To restore access, please resubscribe through our pricing page. Your School ID, Admin Code, and all data are preserved — no re-setup required.
                        </p>
                        <a href="https://connectusonline.org/pricing.html" style="display:inline-block;background:#2563eb;color:#fff;text-decoration:none;font-size:15px;font-weight:800;padding:14px 28px;border-radius:12px;">
                          Resubscribe &rarr;
                        </a>
                        <p style="color:#94a3b8;font-size:12px;margin:24px 0 0;line-height:1.6;">
                          Questions? Email us at <a href="mailto:info@connectusonline.org" style="color:#2563eb;">info@connectusonline.org</a>
                        </p>
                      </td></tr>
                      <tr><td style="background:#f8fafc;padding:20px;text-align:center;border-top:1px solid #e2e8f0;">
                        <p style="margin:0;font-size:12px;color:#94a3b8;font-weight:700;">&copy; ${new Date().getFullYear()} ConnectUs. All rights reserved.</p>
                      </td></tr>
                    </table>
                  </td></tr>
                </table>
                </body></html>`;

                const mailRef = db.collection('mail').doc();
                emailBatch.set(mailRef, {
                    to:      school.contactEmail,
                    message: {
                        subject: `Your ConnectUs Subscription Has Expired — ${school.schoolName}`,
                        html:    suspendedHtml
                    }
                });
            }

            await emailBatch.commit();
            console.log(`[autoSuspendExpiredSchools] Suspension emails sent to ${suspended.filter(s => s.contactEmail).length} schools.`);

            // ── Send HQ summary email ─────────────────────────────────────────
            const hqSummaryHtml = `
            <!DOCTYPE html>
            <html>
            <head><meta charset="utf-8"></head>
            <body style="margin:0;padding:0;background:#f1f5f9;font-family:'Helvetica Neue',Arial,sans-serif;color:#1e293b;">
            <table width="100%" cellpadding="0" cellspacing="0" style="padding:40px 20px;">
              <tr><td align="center">
                <table width="100%" cellpadding="0" cellspacing="0" style="max-width:580px;background:#fff;border-radius:16px;overflow:hidden;box-shadow:0 4px 24px rgba(0,0,0,0.08);">
                  <tr><td height="6" style="background:linear-gradient(to right,#f59e0b,#ef4444,#dc2626);"></td></tr>
                  <tr><td style="text-align:center;padding:32px 40px 16px;">
                    <img src="https://connectusonline.org/assets/images/logo.png" style="height:44px;display:block;margin:0 auto;">
                  </td></tr>
                  <tr><td style="padding:0 40px 40px;">
                    <h2 style="margin:0 0 6px;font-size:20px;font-weight:900;color:#0f172a;">⚠ Auto-Suspend Report</h2>
                    <p style="margin:0 0 24px;font-size:14px;color:#64748b;font-weight:600;">
                      ${results.suspended} school${results.suspended !== 1 ? 's were' : ' was'} automatically suspended for expired subscriptions.
                    </p>
                    <table width="100%" cellpadding="0" cellspacing="0" style="background:#f8fafc;border:1px solid #e2e8f0;border-radius:12px;overflow:hidden;margin-bottom:20px;">
                      <tr>
                        <td colspan="3" style="padding:12px 16px;background:#0f172a;">
                          <p style="margin:0;font-size:10px;font-weight:800;color:#94a3b8;text-transform:uppercase;letter-spacing:0.15em;">Suspended Schools</p>
                        </td>
                      </tr>
                      ${suspended.map(s => `
                      <tr>
                        <td style="padding:10px 16px;font-size:12px;font-weight:700;color:#0f172a;border-bottom:1px solid #f1f5f9;">${s.schoolName}</td>
                        <td style="padding:10px 16px;font-size:11px;font-family:monospace;color:#64748b;border-bottom:1px solid #f1f5f9;">${s.id}</td>
                        <td style="padding:10px 16px;font-size:11px;color:#ef4444;font-weight:700;border-bottom:1px solid #f1f5f9;">Expired ${new Date(s.renewalDate).toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' })}</td>
                      </tr>`).join('')}
                    </table>
                    <p style="margin:0;font-size:13px;color:#64748b;line-height:1.6;">
                      Suspension emails have been sent to each school's contact address.
                      You can review and manage these schools in the
                      <a href="https://connectusonline.org/platform_dashboard/schools/schools.html" style="color:#2563eb;font-weight:800;">HQ School Directory</a>.
                    </p>
                  </td></tr>
                  <tr><td style="background:#f8fafc;padding:20px 40px;text-align:center;border-top:1px solid #e2e8f0;">
                    <p style="margin:0;font-size:12px;font-weight:700;color:#94a3b8;">&copy; ${new Date().getFullYear()} ConnectUs. All rights reserved.</p>
                  </td></tr>
                </table>
              </td></tr>
            </table>
            </body></html>`;

            await db.collection('mail').add({
                to:      HQ_EMAIL_ADDRESS,
                message: {
                    subject: `⚠ ConnectUs Auto-Suspend: ${results.suspended} School${results.suspended !== 1 ? 's' : ''} Expired`,
                    html:    hqSummaryHtml
                }
            });

            console.log(`[autoSuspendExpiredSchools] HQ summary email sent. Total suspended: ${results.suspended}/${results.checked}`);

        } catch (err) {
            console.error('[autoSuspendExpiredSchools] Fatal error:', err);
            results.errors++;
        }
    }
);
// --- END: autoSuspendExpiredSchools ---
