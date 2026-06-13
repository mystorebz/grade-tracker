const { onCall, HttpsError } = require('firebase-functions/v2/https');
const admin                  = require('firebase-admin');
const crypto                 = require('crypto');

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
        throw new HttpsError('permission-denied', 'Account pending approval.');
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
exports.onQuoteRequestCreated = onDocumentCreated("quote_requests/{reqId}", async (event) => {
    const data = event.data.data();
    const reqId = event.params.reqId;

    if (!data || !data.workEmail) return null;

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
            <p style="font-size: 16px; line-height: 1.6; margin-bottom: 24px; color: #475569; text-align: center;">We have received your request to bring <strong>${data.schoolName || 'your institution'}</strong> onto the ConnectUs platform. Our enterprise team is reviewing your requirements and will follow up with a tailored proposal within 24–48 hours.</p>
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
            <p style="font-size: 15px; line-height: 1.6; margin-bottom: 30px; color: #475569; text-align: center;">If you have any immediate questions or need to update your requirements, simply reply to this email to connect with your account specialist.</p>
            <p style="font-size: 16px; line-height: 1.6; margin-bottom: 10px; text-align: center; color: #0f172a;">Warm regards,<br><strong style="color: #1e3a8a;">The ConnectUs Team</strong></p>
          </td>
        </tr>
        <tr>
          <td style="background-color: #f8fafc; text-align: center; padding: 24px 20px; border-top: 1px solid #e2e8f0; border-bottom-left-radius: 12px; border-bottom-right-radius: 12px;">
            <p style="font-size: 12px; color: #94a3b8; margin: 0; font-weight: 600;">&copy; ${new Date().getFullYear()} ConnectUs. All rights reserved.</p>
            <p style="font-size: 12px; color: #94a3b8; margin: 6px 0 0 0;">Powered by Kismet Code Digital</p>
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
                <tr><td style="font-weight: 700; color: #64748b;">Location</td><td style="color: #0f172a; text-align: right; font-weight: 500;">${data.city || 'N/A'}, ${data.stateProvince || 'N/A'}, ${data.country || 'N/A'}</td></tr>
                <tr><td style="font-weight: 700; color: #64748b;">Scale</td><td style="color: #0f172a; text-align: right; font-weight: 500;">${data.studentsCount || 0} Students | ${data.teachersCount || 0} Staff</td></tr>
                <tr><td style="font-weight: 700; color: #64748b;">Contract</td><td style="color: #0f172a; text-align: right; font-weight: 500;">${data.contractTerm || 'Not Specified'}</td></tr>
                <tr><td style="font-weight: 700; color: #64748b;">Source</td><td style="color: #0f172a; text-align: right; font-weight: 500;">${data.hearAboutUs || 'N/A'}</td></tr>
                <tr><td style="font-weight: 700; color: #64748b; vertical-align: top; padding-top: 8px;">Message</td><td style="color: #0f172a; text-align: right; font-weight: 500; line-height: 1.5; padding-top: 8px;">${data.message || 'None'}</td></tr>
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
        console.log(`Quote emails sent successfully for Request ID: ${reqId}`);
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
