import { db } from '../../assets/js/firebase-init.js';
import {
    doc, getDoc, getDocs, setDoc, updateDoc,
    collection, query, where, writeBatch
} from "https://www.gstatic.com/firebasejs/10.7.1/firebase-firestore.js";
import { requireAuth, setSessionData } from '../../assets/js/auth.js';
import { injectAdminLayout } from '../../assets/js/layout-admin.js';
import { showMsg, letterGrade } from '../../assets/js/utils.js';

// ── 1. AUTH & LAYOUT ──────────────────────────────────────────────────────
const session = requireAuth('admin', '../login.html');
injectAdminLayout('settings', 'Settings', 'Security, profile, and system configuration', false, false);

// ── 2. STATE ──────────────────────────────────────────────────────────────
let fullSchoolData = null;

// ── SHA-256 ───────────────────────────────────────────────────────────────
async function sha256(text) {
    const normalized  = text.toLowerCase().trim();
    const encoded     = new TextEncoder().encode(normalized);
    const hashBuffer  = await crypto.subtle.digest('SHA-256', encoded);
    return Array.from(new Uint8Array(hashBuffer))
        .map(b => b.toString(16).padStart(2, '0'))
        .join('');
}

// ── Generate Sub-Admin ID ─────────────────────────────────────────────────
function generateAdminId() {
    const year  = new Date().getFullYear().toString().slice(-2);
    const chars = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
    let rand = '';
    for (let i = 0; i < 5; i++) rand += chars.charAt(Math.floor(Math.random() * chars.length));
    return `A${year}-${rand}`;
}

// ── Generate temporary PIN (8 chars) ──────────────────────────────────────
function generateTempPin() {
    const chars = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
    let pin = '';
    for (let i = 0; i < 8; i++) pin += chars.charAt(Math.floor(Math.random() * chars.length));
    return pin;
}

function escHtml(str) {
    if (!str) return '';
    return String(str).replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/"/g,'&quot;');
}

// ── 3. LOAD ALL SETTINGS DATA ─────────────────────────────────────────────
async function loadSettingsData() {
    try {
        const snap = await getDoc(doc(db, 'schools', session.schoolId));
        if (!snap.exists()) return;

        fullSchoolData = snap.data();

        // ── Populate profile fields ────────────────────────────────────────
        document.getElementById('profileSchoolName').value    = fullSchoolData.schoolName    || '';
        document.getElementById('profileContactEmail').value  = fullSchoolData.contactEmail  || '';
        document.getElementById('profileDistrict').value      = fullSchoolData.district      || '';
        document.getElementById('profileSchoolType').value    = fullSchoolData.schoolType    || '';
        document.getElementById('profilePhone').value         = fullSchoolData.phone         || '';
        document.getElementById('profileContactName').value   = fullSchoolData.contactName   || '';
        document.getElementById('profileAddress').value       = fullSchoolData.schoolAddress || '';

        // ── Subscription usage ─────────────────────────────────────────────
        await loadSubscriptionUsage();

        // ── Archive management ─────────────────────────────────────────────
        loadArchivedRecords();

        // ── Sub-admin management (super admin only) ────────────────────────
        if (session.isSuperAdmin) {
            document.getElementById('adminManagementSection').classList.remove('hidden');
            loadSubAdmins();
        }

        // ── Danger zone — hide for sub-admins ─────────────────────────────
        if (!session.isSuperAdmin) {
            const danger = document.querySelector('.danger-zone');
            if (danger) danger.classList.add('hidden');
        }

        // ── Scroll to #admins anchor if navigated from sidebar ────────────
        if (window.location.hash === '#admins' && session.isSuperAdmin) {
            setTimeout(() => {
                document.getElementById('adminManagementSection')?.scrollIntoView({ behavior: 'smooth' });
            }, 400);
        }

    } catch (e) {
        console.error('[Settings] loadSettingsData:', e);
    }
}

// ── 4. SUBSCRIPTION USAGE ─────────────────────────────────────────────────
async function loadSubscriptionUsage() {
    try {
        const planName      = session.planName      || 'Pro';
        const teacherLimit  = session.teacherLimit  || 50;
        const studentLimit  = session.studentLimit  || 999;
        const adminLimit    = session.adminLimit    || 1;

        document.getElementById('planBadge').textContent = planName;

        // Fetch live counts in parallel
        const [tSnap, sSnap, aSnap] = await Promise.all([
            getDocs(query(collection(db, 'teachers'), where('currentSchoolId', '==', session.schoolId))),
            getDocs(query(collection(db, 'students'),
                where('currentSchoolId', '==', session.schoolId),
                where('enrollmentStatus', '==', 'Active'))),
            getDocs(query(collection(db, 'schools', session.schoolId, 'admins'),
                where('isArchived', '==', false)))
        ]);

        const teacherCount = tSnap.size;
        const studentCount = sSnap.size;
        const adminCount   = aSnap.size;

        const usageItems = [
            { label: 'Teachers', used: teacherCount, limit: teacherLimit, icon: 'fa-chalkboard-user', color: 'blue' },
            { label: 'Students', used: studentCount, limit: studentLimit, icon: 'fa-user-graduate',   color: 'emerald' },
            { label: 'Sub-Admins', used: adminCount, limit: adminLimit,  icon: 'fa-user-shield',     color: 'indigo' }
        ];

        document.getElementById('subscriptionUsageGrid').innerHTML = usageItems.map(item => {
            const pct       = item.limit > 0 ? Math.min(Math.round((item.used / item.limit) * 100), 100) : 0;
            const isWarning = pct >= 80;
            const isFull    = pct >= 100;
            const barColor  = isFull ? 'bg-red-500' : isWarning ? 'bg-amber-500' : `bg-${item.color}-500`;
            const textColor = isFull ? 'text-red-600' : isWarning ? 'text-amber-600' : `text-${item.color}-600`;
            const bgColor   = isFull ? 'bg-red-50 border-red-200' : isWarning ? 'bg-amber-50 border-amber-200' : 'bg-white border-slate-200';

            return `
            <div class="text-center p-4 rounded-xl border ${bgColor}">
                <i class="fa-solid ${item.icon} ${textColor} text-xl mb-2"></i>
                <p class="text-xs font-black text-slate-500 uppercase tracking-wider mb-1">${item.label}</p>
                <p class="${textColor} font-black text-2xl">${item.used}</p>
                <p class="text-xs text-slate-400 font-semibold">of ${item.limit === 99999 ? '∞' : item.limit}</p>
                <div class="mt-2 h-1.5 bg-slate-100 rounded-full overflow-hidden">
                    <div class="h-full ${barColor} rounded-full transition-all" style="width:${pct}%"></div>
                </div>
            </div>`;
        }).join('');

        // Update admin usage badge
        document.getElementById('adminUsageBadge').textContent = `${adminCount} / ${adminLimit} used`;

    } catch (e) {
        console.error('[Settings] loadSubscriptionUsage:', e);
    }
}

// ── 5. CHANGE PIN (hash-aware) ────────────────────────────────────────────
document.getElementById('updateCodeBtn').addEventListener('click', async () => {
    const cur = document.getElementById('currentAdminCode').value.trim();
    const nw  = document.getElementById('newAdminCodeSettings').value.trim();
    const cf  = document.getElementById('confirmAdminCodeSettings').value.trim();
    const mid = 'settingsSecurityMsg';
    const btn = document.getElementById('updateCodeBtn');

    if (!cur || !nw || !cf) { showMsg(mid, 'All three fields are required.', true); return; }
    if (nw !== cf)           { showMsg(mid, 'New codes do not match.', true);       return; }
    if (nw.length < 6)       { showMsg(mid, 'Min. 6 characters required.', true);   return; }

    btn.innerHTML = `<i class="fa-solid fa-spinner fa-spin"></i> Updating...`;
    btn.disabled  = true;

    try {
        // ── Hash-aware comparison ──────────────────────────────────────────
        // Super admin code is on the school document.
        // Sub-admin code is on their own admin document.
        const hashedCurrent = await sha256(cur);
        const hashedNew     = await sha256(nw);

        if (session.isSuperAdmin) {
            if (hashedCurrent !== fullSchoolData.adminCode) {
                showMsg(mid, 'Current admin code is incorrect.', true);
                btn.innerHTML = 'Update Security Code'; btn.disabled = false; return;
            }
            await updateDoc(doc(db, 'schools', session.schoolId), { adminCode: hashedNew });
            fullSchoolData.adminCode = hashedNew;
        } else {
            // Sub-admin — fetch their own doc to compare
            const adminSnap = await getDoc(doc(db, 'schools', session.schoolId, 'admins', session.adminId));
            if (!adminSnap.exists() || hashedCurrent !== adminSnap.data().adminCode) {
                showMsg(mid, 'Current admin code is incorrect.', true);
                btn.innerHTML = 'Update Security Code'; btn.disabled = false; return;
            }
            await updateDoc(doc(db, 'schools', session.schoolId, 'admins', session.adminId), { adminCode: hashedNew });
        }

        ['currentAdminCode', 'newAdminCodeSettings', 'confirmAdminCodeSettings']
            .forEach(id => document.getElementById(id).value = '');
        showMsg(mid, 'Admin code updated successfully!', false);

    } catch (e) {
        console.error('[Settings] updateCode:', e);
        showMsg(mid, 'Failed to update admin code.', true);
    }

    btn.innerHTML = 'Update Security Code';
    btn.disabled  = false;
});

// ── 6. SAVE SCHOOL PROFILE ────────────────────────────────────────────────
document.getElementById('saveProfileBtn').addEventListener('click', async () => {
    const btn = document.getElementById('saveProfileBtn');
    const u = {
        schoolName:    document.getElementById('profileSchoolName').value.trim(),
        contactEmail:  document.getElementById('profileContactEmail').value.trim(),
        district:      document.getElementById('profileDistrict').value,
        schoolType:    document.getElementById('profileSchoolType').value,
        phone:         document.getElementById('profilePhone').value.trim(),
        contactName:   document.getElementById('profileContactName').value.trim(),
        schoolAddress: document.getElementById('profileAddress').value.trim()
    };

    btn.innerHTML = `<i class="fa-solid fa-spinner fa-spin"></i> Saving...`;
    btn.disabled  = true;

    try {
        await updateDoc(doc(db, 'schools', session.schoolId), u);
        Object.assign(fullSchoolData, u);

        session.schoolName   = u.schoolName;
        session.schoolType   = u.schoolType;
        session.contactEmail = u.contactEmail;
        setSessionData('admin', session);

        const nameEl = document.getElementById('displaySchoolName');
        if (nameEl && session.isSuperAdmin) nameEl.textContent = u.schoolName;

        showMsg('settingsProfileMsg', 'Profile saved successfully!', false);
    } catch (e) {
        console.error('[Settings] saveProfile:', e);
        showMsg('settingsProfileMsg', 'Failed to save profile.', true);
    }

    btn.innerHTML = 'Save Profile';
    btn.disabled  = false;
});

// ── 7. SUB-ADMIN MANAGEMENT ───────────────────────────────────────────────

async function loadSubAdmins() {
    try {
        const snap = await getDocs(collection(db, 'schools', session.schoolId, 'admins'));
        const all  = snap.docs.map(d => ({ id: d.id, ...d.data() }));

        const active   = all.filter(a => !a.isArchived);
        const archived = all.filter(a =>  a.isArchived);

        // Active list
        document.getElementById('activeAdminsList').innerHTML = active.length
            ? active.map(a => `
            <div class="flex items-center justify-between bg-white border border-slate-200 rounded-xl p-4 shadow-sm">
                <div class="flex items-center gap-3">
                    <div class="w-9 h-9 bg-blue-100 text-blue-600 rounded-xl flex items-center justify-center font-black text-sm">
                        ${(a.name || 'A').charAt(0).toUpperCase()}
                    </div>
                    <div>
                        <p class="font-black text-slate-700 text-sm">${escHtml(a.name)}</p>
                        <p class="text-xs text-slate-400 font-semibold">${escHtml(a.email || '—')} · ${a.id}</p>
                        <p class="text-[10px] font-bold mt-0.5 ${a.securityQuestionsSet ? 'text-green-600' : 'text-amber-500'}">
                            ${a.securityQuestionsSet ? '✓ Setup complete' : '⚠ Awaiting first login setup'}
                        </p>
                    </div>
                </div>
                <button onclick="window.archiveSubAdmin('${a.id}', '${escHtml(a.name)}')"
                    class="text-xs font-black text-amber-600 hover:bg-amber-500 hover:text-white border border-amber-200 px-3 py-1.5 rounded-lg transition">
                    Archive
                </button>
            </div>`)
            .join('')
            : '<p class="text-sm text-slate-400 italic font-semibold text-center py-4">No sub-admins created yet.</p>';

        // Archived list
        if (archived.length) {
            document.getElementById('archivedAdminsWrap').classList.remove('hidden');
            document.getElementById('archivedAdminsList').innerHTML = archived.map(a => `
            <div class="flex items-center justify-between bg-slate-50 border border-slate-200 rounded-xl p-4">
                <div>
                    <p class="font-black text-slate-500 text-sm">${escHtml(a.name)}</p>
                    <p class="text-xs text-slate-400 font-semibold">${escHtml(a.email || '—')} · Archived ${a.archivedAt ? new Date(a.archivedAt).toLocaleDateString() : ''}</p>
                </div>
                <button onclick="window.restoreSubAdmin('${a.id}', '${escHtml(a.name)}')"
                    class="text-xs font-black text-green-700 hover:bg-green-600 hover:text-white border border-green-300 px-3 py-1.5 rounded-lg transition">
                    Restore
                </button>
            </div>`).join('');
        } else {
            document.getElementById('archivedAdminsWrap').classList.add('hidden');
        }

    } catch (e) {
        console.error('[Settings] loadSubAdmins:', e);
    }
}

// ── Create Sub-Admin ──────────────────────────────────────────────────────
document.getElementById('createSubAdminBtn').addEventListener('click', async () => {
    const name  = document.getElementById('newAdminName').value.trim();
    const email = document.getElementById('newAdminEmail').value.trim();
    const btn   = document.getElementById('createSubAdminBtn');

    if (!name)  { showMsg('createAdminMsg', 'Name is required.', true); return; }
    if (!email) { showMsg('createAdminMsg', 'Email is required.', true); return; }
    if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) {
        showMsg('createAdminMsg', 'Please enter a valid email address.', true); return;
    }

    btn.disabled = true;
    btn.innerHTML = `<i class="fa-solid fa-spinner fa-spin mr-2"></i>Creating...`;

    try {
        // ── Check adminLimit ───────────────────────────────────────────────
        const adminLimit = session.adminLimit || 1;
        const existingSnap = await getDocs(
            query(collection(db, 'schools', session.schoolId, 'admins'),
                  where('isArchived', '==', false))
        );
        if (existingSnap.size >= adminLimit) {
            showMsg('createAdminMsg',
                `Sub-admin limit reached (${adminLimit} max). Contact ConnectUs to upgrade your plan.`, true);
            btn.disabled = false;
            btn.innerHTML = '<i class="fa-solid fa-user-plus mr-1.5"></i>Create Sub-Admin';
            return;
        }

        // ── Generate credentials ───────────────────────────────────────────
        const newId   = generateAdminId();
        const tempPin = generateTempPin();
        const hashedPin = await sha256(tempPin);

        await setDoc(doc(db, 'schools', session.schoolId, 'admins', newId), {
            name,
            email:                email.toLowerCase(),
            adminCode:            hashedPin,   // SHA-256 hashed
            role:                 'sub_admin',
            isArchived:           false,
            archivedAt:           null,
            requiresPinReset:     true,        // Forced to change on first login
            securityQuestionsSet: false,       // Must complete setup on first login
            createdAt:            new Date().toISOString()
        });

        // ── Show credentials slip ──────────────────────────────────────────
        document.getElementById('newAdminIdDisplay').textContent  = newId;
        document.getElementById('newAdminPinDisplay').textContent = tempPin;
        document.getElementById('newAdminCredentials').classList.remove('hidden');

        // ── Clear form ─────────────────────────────────────────────────────
        document.getElementById('newAdminName').value  = '';
        document.getElementById('newAdminEmail').value = '';

        showMsg('createAdminMsg', `${name} has been created successfully.`, false);
        loadSubAdmins();
        loadSubscriptionUsage();

    } catch (e) {
        console.error('[Settings] createSubAdmin:', e);
        showMsg('createAdminMsg', 'Failed to create sub-admin. Please try again.', true);
    }

    btn.disabled  = false;
    btn.innerHTML = '<i class="fa-solid fa-user-plus mr-1.5"></i>Create Sub-Admin';
});

// ── Archive Sub-Admin ─────────────────────────────────────────────────────
window.archiveSubAdmin = async function(adminId, name) {
    if (!confirm(`Archive ${name}? They will no longer be able to log in. You can restore them later.`)) return;

    try {
        await updateDoc(doc(db, 'schools', session.schoolId, 'admins', adminId), {
            isArchived: true,
            archivedAt: new Date().toISOString()
        });
        loadSubAdmins();
        loadSubscriptionUsage();
    } catch (e) {
        console.error('[Settings] archiveSubAdmin:', e);
        alert('Error archiving sub-admin. Please try again.');
    }
};

// ── Restore Sub-Admin ─────────────────────────────────────────────────────
window.restoreSubAdmin = async function(adminId, name) {
    // Check limit before restoring
    const adminLimit = session.adminLimit || 1;
    const existingSnap = await getDocs(
        query(collection(db, 'schools', session.schoolId, 'admins'),
              where('isArchived', '==', false))
    );
    if (existingSnap.size >= adminLimit) {
        alert(`Cannot restore — sub-admin limit (${adminLimit}) already reached.`);
        return;
    }

    try {
        await updateDoc(doc(db, 'schools', session.schoolId, 'admins', adminId), {
            isArchived: false,
            archivedAt: null
        });
        loadSubAdmins();
        loadSubscriptionUsage();
    } catch (e) {
        console.error('[Settings] restoreSubAdmin:', e);
        alert('Error restoring sub-admin. Please try again.');
    }
};

// ── 8. ARCHIVE MANAGEMENT (global collections, no deleteDoc) ──────────────
window.switchArchiveTab = function(tab) {
    document.getElementById('archiveTeachersList').classList.toggle('hidden', tab !== 'teachers');
    document.getElementById('archiveStudentsList').classList.toggle('hidden', tab !== 'students');
    document.getElementById('archiveTabTeachers').classList.toggle('active', tab === 'teachers');
    document.getElementById('archiveTabStudents').classList.toggle('active', tab === 'students');
};

async function loadArchivedRecords() {
    try {
        // ── Archived Teachers (global collection) ──────────────────────────
        // Teachers are archived by setting currentSchoolId to '' and
        // archivedSchoolIds to include this school. We look for teachers
        // where this school appears in archivedSchoolIds.
        // Simpler: teachers panel handles exit — here we just show a note.
        // For a true archived teacher view, use the teachers page exit flow.
        document.getElementById('archiveTeachersList').innerHTML =
            `<div class="bg-blue-50 border border-blue-100 rounded-xl p-4 text-center">
                <p class="text-sm text-slate-600 font-semibold">
                    Teacher archiving is managed through the
                    <a href="../teachers/teachers.html" class="text-blue-600 font-black hover:underline">Teachers panel</a>
                    using the Exit Evaluation workflow.
                </p>
            </div>`;

        // ── Archived Students (global collection) ──────────────────────────
        // Students archived from this school have enrollmentStatus != 'Active'
        // and currentSchoolId == this school (or empty for transferred).
        const sSnap = await getDocs(
            query(collection(db, 'students'),
                  where('currentSchoolId', '==', session.schoolId))
        );
        const archivedStudents = sSnap.docs
            .map(d => ({ id: d.id, ...d.data() }))
            .filter(s => s.enrollmentStatus && s.enrollmentStatus !== 'Active');

        document.getElementById('archiveStudentsList').innerHTML = archivedStudents.length
            ? archivedStudents.map(s => `
            <div class="flex items-center justify-between bg-slate-50 border border-slate-200 rounded-xl p-4">
                <div>
                    <p class="font-black text-slate-600">${escHtml(s.name || 'Unnamed')}</p>
                    <p class="text-xs text-slate-400 font-semibold">
                        ${escHtml(s.className || 'Unassigned')} ·
                        <span class="font-bold ${s.enrollmentStatus === 'Graduated' ? 'text-green-600' : s.enrollmentStatus === 'Transferred' ? 'text-blue-600' : 'text-amber-600'}">
                            ${s.enrollmentStatus}
                        </span>
                    </p>
                    <p class="text-[10px] text-slate-400 font-mono mt-0.5">${s.id}</p>
                </div>
                <div class="flex gap-2">
                    <button onclick="window.restoreStudent('${s.id}')"
                        class="text-xs font-black text-green-700 hover:bg-green-600 hover:text-white border border-green-300 px-3 py-1.5 rounded-lg transition">
                        Restore
                    </button>
                </div>
            </div>`)
            .join('')
            : '<p class="text-sm text-slate-400 italic font-semibold text-center py-4">No archived students at this school.</p>';

    } catch (e) {
        console.error('[Settings] loadArchivedRecords:', e);
    }
}

// ── Restore Student ───────────────────────────────────────────────────────
// Restores to Active but leaves class/teacher unassigned — admin can reassign.
// NOTE: No deleteDoc anywhere in this file. ConnectUs platform handles deletions.
window.restoreStudent = async function(studentId) {
    if (!confirm('Restore this student to Active status? They will be unassigned and can be placed in a class.')) return;
    try {
        await updateDoc(doc(db, 'students', studentId), {
            enrollmentStatus: 'Active',
            currentSchoolId:  session.schoolId,
            teacherId:        '',
            className:        ''
        });
        loadArchivedRecords();
    } catch (e) {
        console.error('[Settings] restoreStudent:', e);
        alert('Error restoring student. Please try again.');
    }
};

// ── 9. END OF YEAR RESET (super admin only) ───────────────────────────────
window.endOfYearReset = async function() {
    if (!session.isSuperAdmin) {
        alert('Only the Super Admin can perform this action.');
        return;
    }

    const c1 = confirm(
        "WARNING: This will unassign ALL active students from their current teachers and classes.\n\n" +
        "Run this ONLY at the end of the school year. Grades are preserved.\n\n" +
        "Are you sure you want to proceed?"
    );
    if (!c1) return;

    const c2 = prompt('Type "RESET" to confirm:');
    if (c2 !== 'RESET') { alert('Reset cancelled.'); return; }

    try {
        // ── Use global students collection ─────────────────────────────────
        const snap = await getDocs(
            query(collection(db, 'students'),
                  where('currentSchoolId', '==', session.schoolId),
                  where('enrollmentStatus', '==', 'Active'))
        );

        if (snap.empty) { alert('No active students found.'); return; }

        // Firestore batch limit is 500 writes. Split if needed.
        const docs    = snap.docs;
        let committed = 0;

        for (let i = 0; i < docs.length; i += 499) {
            const chunk = docs.slice(i, i + 499);
            const batch = writeBatch(db);
            chunk.forEach(d => batch.update(d.ref, { teacherId: '', className: '' }));
            await batch.commit();
            committed += chunk.length;
        }

        alert(`Successfully reset ${committed} students to the unassigned pool for the new academic year.`);

    } catch (e) {
        console.error('[Settings] endOfYearReset:', e);
        alert('Error during reset. Please try again or contact support.');
    }
};

// ── INIT ──────────────────────────────────────────────────────────────────
document.addEventListener('DOMContentLoaded', loadSettingsData);
