import { db } from '../../assets/js/firebase-init.js';
import { doc, getDoc, getDocs, updateDoc, deleteDoc, collection, query, where, writeBatch } from "https://www.gstatic.com/firebasejs/10.7.1/firebase-firestore.js";
import { requireAuth, setSessionData } from '../../assets/js/auth.js';
import { injectAdminLayout } from '../../assets/js/layout-admin.js';
import { showMsg, letterGrade } from '../../assets/js/utils.js';

// ── 1. INIT & AUTH ────────────────────────────────────────────────────────
const session = requireAuth('admin', '../login.html');

// Inject layout
injectAdminLayout('settings', 'Settings', 'Security, profile, and system configuration', false, false);

// Local state for full school document
let fullSchoolData = null;

// ── 2. LOAD DATA ──────────────────────────────────────────────────────────
async function loadSettingsData() {
    try {
        const snap = await getDoc(doc(db, 'schools', session.schoolId));
        if (snap.exists()) {
            fullSchoolData = snap.data();
            
            // Populate Profile Fields
            document.getElementById('profileSchoolName').value = fullSchoolData.schoolName || '';
            document.getElementById('profileDistrict').value = fullSchoolData.district || '';
            document.getElementById('profileSchoolType').value = fullSchoolData.schoolType || '';
            document.getElementById('profilePhone').value = fullSchoolData.phone || '';
            document.getElementById('profileAddress').value = fullSchoolData.schoolAddress || '';
        }
        
        loadArchivedRecords();
    } catch (e) {
        console.error("Error loading settings data:", e);
    }
}

// ── 3. UPDATE SECURITY CODE ───────────────────────────────────────────────
document.getElementById('updateCodeBtn').addEventListener('click', async () => {
    const cur = document.getElementById('currentAdminCode').value.trim();
    const nw = document.getElementById('newAdminCodeSettings').value.trim();
    const cf = document.getElementById('confirmAdminCodeSettings').value.trim();
    const mid = 'settingsSecurityMsg';
    const btn = document.getElementById('updateCodeBtn');
    
    if (!cur || !nw || !cf) { showMsg(mid, 'All three fields are required.', true); return; }
    if (cur !== fullSchoolData.adminCode) { showMsg(mid, 'Current admin code is incorrect.', true); return; }
    if (nw !== cf) { showMsg(mid, 'New codes do not match.', true); return; }
    if (nw.length < 5) { showMsg(mid, 'Min. 5 characters required.', true); return; }
    
    btn.innerHTML = `<i class="fa-solid fa-spinner fa-spin"></i> Updating...`;
    btn.disabled = true;

    try {
        await updateDoc(doc(db, 'schools', session.schoolId), { adminCode: nw });
        fullSchoolData.adminCode = nw; // Update local state
        
        ['currentAdminCode', 'newAdminCodeSettings', 'confirmAdminCodeSettings'].forEach(id => document.getElementById(id).value = '');
        showMsg(mid, 'Admin code updated successfully!', false);
    } catch (e) {
        console.error("Error updating admin code:", e);
        showMsg(mid, 'Failed to update admin code.', true);
    }
    
    btn.innerHTML = `Update Security Code`;
    btn.disabled = false;
});

// ── 4. UPDATE SCHOOL PROFILE ──────────────────────────────────────────────
document.getElementById('saveProfileBtn').addEventListener('click', async () => {
    const btn = document.getElementById('saveProfileBtn');
    const u = {
        schoolName: document.getElementById('profileSchoolName').value.trim(),
        district: document.getElementById('profileDistrict').value,
        schoolType: document.getElementById('profileSchoolType').value,
        phone: document.getElementById('profilePhone').value.trim(),
        schoolAddress: document.getElementById('profileAddress').value.trim()
    };
    
    btn.innerHTML = `<i class="fa-solid fa-spinner fa-spin"></i> Saving...`;
    btn.disabled = true;

    try {
        await updateDoc(doc(db, 'schools', session.schoolId), u);
        Object.assign(fullSchoolData, u);
        
        // Update Session if critical UI elements changed
        session.schoolName = u.schoolName;
        session.schoolType = u.schoolType;
        setSessionData('admin', session);
        
        // Update sidebar name dynamically
        document.getElementById('displaySchoolName').textContent = u.schoolName;
        
        showMsg('settingsProfileMsg', 'Profile saved!', false);
    } catch (e) {
        console.error("Error updating profile:", e);
        showMsg('settingsProfileMsg', 'Failed to save profile.', true);
    }

    btn.innerHTML = `Save Profile`;
    btn.disabled = false;
});

// ── 5. ARCHIVE MANAGEMENT ─────────────────────────────────────────────────
window.switchArchiveTab = function(tab) {
    document.getElementById('archiveTeachersList').classList.toggle('hidden', tab !== 'teachers');
    document.getElementById('archiveStudentsList').classList.toggle('hidden', tab !== 'students');
    document.getElementById('archiveTabTeachers').classList.toggle('active', tab === 'teachers');
    document.getElementById('archiveTabStudents').classList.toggle('active', tab === 'students');
};

async function loadArchivedRecords() {
    try {
        // Teachers
        const tSnap = await getDocs(collection(db, 'schools', session.schoolId, 'teachers'));
        const aT = tSnap.docs.filter(d => d.data().archived);
        
        document.getElementById('archiveTeachersList').innerHTML = aT.length ? aT.map(d => {
            const t = d.data();
            return `
            <div class="flex items-center justify-between bg-red-50 border border-red-200 rounded-xl p-4">
                <div>
                    <p class="font-black text-slate-700">${t.name}</p>
                    <p class="text-xs text-slate-400 font-semibold">Archived ${t.archivedAt ? new Date(t.archivedAt).toLocaleDateString() : 'Unknown'}</p>
                </div>
                <div class="flex gap-2">
                    <button onclick="window.printTeacherRecord('${d.id}')" class="text-xs font-black text-slate-700 hover:bg-slate-200 border border-slate-300 bg-white px-3 py-1.5 rounded-lg transition" title="Print Record"><i class="fa-solid fa-print"></i></button>
                    <button onclick="window.restoreTeacher('${d.id}')" class="text-xs font-black text-green-700 hover:bg-green-600 hover:text-white border border-green-300 px-3 py-1.5 rounded-lg transition">Restore</button>
                    <button onclick="window.permanentDeleteTeacher('${d.id}')" class="text-xs font-black text-red-600 hover:bg-red-600 hover:text-white border border-red-300 px-3 py-1.5 rounded-lg transition">Delete</button>
                </div>
            </div>`;
        }).join('') : '<p class="text-sm text-slate-400 italic font-semibold text-center py-4">No archived teachers.</p>';
        
        // Students
        const sSnap = await getDocs(collection(db, 'schools', session.schoolId, 'students'));
        const aS = sSnap.docs.filter(d => d.data().archived);
        
        document.getElementById('archiveStudentsList').innerHTML = aS.length ? aS.map(d => {
            const s = d.data();
            return `
            <div class="flex items-center justify-between bg-red-50 border border-red-200 rounded-xl p-4">
                <div>
                    <p class="font-black text-slate-700">${s.name || 'Unnamed'}</p>
                    <p class="text-xs text-slate-400 font-semibold">${s.className || 'Unassigned'} — Archived ${s.archivedAt ? new Date(s.archivedAt).toLocaleDateString() : 'Unknown'} ${s.archiveReason ? `<br><span class="text-amber-700">Reason: ${s.archiveReason}</span>` : ''}</p>
                </div>
                <div class="flex gap-2">
                    <button onclick="window.printStudentRecord('${d.id}')" class="text-xs font-black text-slate-700 hover:bg-slate-200 border border-slate-300 bg-white px-3 py-1.5 rounded-lg transition" title="Print Record"><i class="fa-solid fa-print"></i></button>
                    <button onclick="window.restoreStudent('${d.id}')" class="text-xs font-black text-green-700 hover:bg-green-600 hover:text-white border border-green-300 px-3 py-1.5 rounded-lg transition">Restore</button>
                    <button onclick="window.permanentDeleteStudent('${d.id}')" class="text-xs font-black text-red-600 hover:bg-red-600 hover:text-white border border-red-300 px-3 py-1.5 rounded-lg transition">Delete</button>
                </div>
            </div>`;
        }).join('') : '<p class="text-sm text-slate-400 italic font-semibold text-center py-4">No archived students.</p>';

    } catch (e) {
        console.error("Error loading archives:", e);
        document.getElementById('archiveTeachersList').innerHTML = '<p class="text-red-500 font-bold py-4">Error loading data.</p>';
        document.getElementById('archiveStudentsList').innerHTML = '<p class="text-red-500 font-bold py-4">Error loading data.</p>';
    }
}

window.restoreTeacher = async function(id) {
    if (!confirm('Restore this teacher to active duty?')) return;
    await updateDoc(doc(db, 'schools', session.schoolId, 'teachers', id), { archived: false, archivedAt: null });
    loadArchivedRecords();
};

window.permanentDeleteTeacher = async function(id) {
    if (!confirm('Permanently delete this teacher? This action CANNOT be undone.')) return;
    await deleteDoc(doc(db, 'schools', session.schoolId, 'teachers', id));
    loadArchivedRecords();
};

window.restoreStudent = async function(id) {
    if (!confirm('Restore this student to active status? (They will be unassigned from classes)')) return;
    await updateDoc(doc(db, 'schools', session.schoolId, 'students', id), { archived: false, archivedAt: null, archiveReason: '' });
    loadArchivedRecords();
};

window.permanentDeleteStudent = async function(id) {
    if (!confirm('Permanently delete student and all associated grades? This action CANNOT be undone.')) return;
    // Note: To be perfectly clean in Firestore, subcollections (grades) should be deleted via cloud function or batch, 
    // but standard SDK allows doc deletion. Leaving subcollections orphaned is acceptable for this level.
    await deleteDoc(doc(db, 'schools', session.schoolId, 'students', id));
    loadArchivedRecords();
};


// ── 6. DANGER ZONE: END OF YEAR RESET ─────────────────────────────────────
window.endOfYearReset = async function() {
    const confirm1 = confirm("WARNING: This will unassign ALL active students from their current teachers and classes. This should only be run at the very end of the school year. Are you sure you want to proceed?");
    if (!confirm1) return;
    
    const confirm2 = prompt('Type "RESET" to confirm this action:');
    if (confirm2 !== "RESET") {
        alert("Reset canceled.");
        return;
    }

    try {
        const q = query(collection(db, 'schools', session.schoolId, 'students'), where('archived', '==', false));
        const snap = await getDocs(q);
        
        if (snap.empty) { 
            alert("No active students found."); 
            return; 
        }

        const batch = writeBatch(db);
        let batchCount = 0;
        
        snap.forEach(d => {
            batch.update(d.ref, { teacherId: '', className: '' });
            batchCount++;
        });
        
        if (batchCount > 0) {
            await batch.commit();
        }

        alert(`Successfully reset ${batchCount} students to the Unassigned pool for the new academic year.`);
        
    } catch (e) {
        console.error("Error during reset:", e);
        alert("Error during reset. Please try again or contact support.");
    }
};

// ── 7. PRINT RECORD HELPERS (Ported from original) ────────────────────────
window.printTeacherRecord = async function(teacherId) {
    const tDoc = await getDoc(doc(db, 'schools', session.schoolId, 'teachers', teacherId));
    if (!tDoc.exists()) return;
    const t = tDoc.data();
    const classes = t.classes ? t.classes.join(', ') : (t.className || 'None assigned');
    const subjects = t.subjects ? t.subjects.map(s => typeof s === 'string' ? s : s.name).join(', ') : 'None assigned';
    
    let html = `<html><head><title>Teacher Record - ${t.name}</title>
    <style>
        body { font-family: 'Helvetica Neue', Helvetica, Arial, sans-serif; padding: 40px; color: #1e293b; line-height: 1.6; }
        .header { text-align: center; border-bottom: 2px solid #cbd5e1; padding-bottom: 20px; margin-bottom: 30px; }
        .header h1 { margin: 0 0 5px 0; font-size: 24px; color: #0f172a; text-transform: uppercase; letter-spacing: 1px; }
        .header h2 { margin: 0; font-size: 16px; color: #64748b; font-weight: normal; letter-spacing: 2px; }
        .info-box { background: #f8fafc; border: 1px solid #e2e8f0; padding: 30px; border-radius: 8px; margin-bottom: 20px; }
        .info-row { display: flex; border-bottom: 1px solid #e2e8f0; padding: 12px 0; }
        .info-row:last-child { border-bottom: none; }
        .info-label { width: 150px; font-size: 11px; text-transform: uppercase; color: #64748b; font-weight: bold; letter-spacing: 1px; }
        .info-val { flex: 1; font-size: 15px; font-weight: bold; color: #0f172a; }
        .footer { margin-top: 50px; text-align: center; font-size: 10px; color: #94a3b8; border-top: 1px solid #e2e8f0; padding-top: 15px; }
    </style></head><body>
    <div class="header">
        <h1>${session.schoolName}</h1>
        <h2>TEACHER EMPLOYMENT RECORD</h2>
    </div>
    <div class="info-box">
        <div class="info-row"><div class="info-label">Full Name</div><div class="info-val">${t.name}</div></div>
        <div class="info-row"><div class="info-label">Email Address</div><div class="info-val">${t.email || 'N/A'}</div></div>
        <div class="info-row"><div class="info-label">Phone Number</div><div class="info-val">${t.phone || 'N/A'}</div></div>
        <div class="info-row"><div class="info-label">Status</div><div class="info-val">${t.archived ? 'Archived (Inactive)' : 'Active'}</div></div>
        <div class="info-row"><div class="info-label">Record Created</div><div class="info-val">${t.createdAt ? new Date(t.createdAt).toLocaleDateString() : 'N/A'}</div></div>
        <div class="info-row"><div class="info-label">Last Known Classes</div><div class="info-val">${classes}</div></div>
        <div class="info-row"><div class="info-label">Teaching Subjects</div><div class="info-val">${subjects}</div></div>
    </div>
    <div class="footer">Printed on ${new Date().toLocaleDateString()} via ConnectUs Platform</div></body></html>`;
    
    const w = window.open('', '_blank'); w.document.write(html); w.document.close();
    setTimeout(() => w.print(), 500);
};

window.printStudentRecord = async function(studentId) {
    const sDoc = await getDoc(doc(db, 'schools', session.schoolId, 'students', studentId));
    if (!sDoc.exists()) return;
    const s = sDoc.data();
    
    const gradesSnap = await getDocs(collection(db, 'schools', session.schoolId, 'students', studentId, 'grades'));
    const grades = [];
    gradesSnap.forEach(d => grades.push(d.data()));

    const bySem = {};
    grades.forEach(g => {
        const sem = g.semesterId || 'Unknown Period';
        const sub = g.subject || 'Uncategorized';
        if (!bySem[sem]) bySem[sem] = {};
        if (!bySem[sem][sub]) bySem[sem][sub] = [];
        bySem[sem][sub].push(g);
    });

    let html = `<html><head><title>Student Record - ${s.name}</title>
    <style>
        body { font-family: 'Helvetica Neue', Helvetica, Arial, sans-serif; padding: 40px; color: #1e293b; line-height: 1.5; }
        .header { text-align: center; border-bottom: 2px solid #cbd5e1; padding-bottom: 20px; margin-bottom: 30px; }
        .header h1 { margin: 0 0 5px 0; font-size: 24px; color: #0f172a; text-transform: uppercase; letter-spacing: 1px; }
        .header h2 { margin: 0; font-size: 16px; color: #64748b; font-weight: normal; letter-spacing: 2px; }
        .info-grid { display: grid; grid-template-columns: 1fr 1fr; gap: 15px; margin-bottom: 40px; background: #f8fafc; padding: 20px; border-radius: 8px; border: 1px solid #e2e8f0; }
        .info-item label { display: block; font-size: 10px; text-transform: uppercase; color: #64748b; font-weight: bold; letter-spacing: 1px; }
        .info-item span { font-size: 14px; font-weight: bold; color: #0f172a; }
        .sem-block { margin-bottom: 40px; page-break-inside: avoid; }
        .sem-title { font-size: 16px; font-weight: bold; background: #334155; color: white; padding: 8px 15px; margin: 0 0 15px 0; border-radius: 4px; }
        table { width: 100%; border-collapse: collapse; margin-bottom: 10px; font-size: 13px; }
        th, td { border: 1px solid #e2e8f0; padding: 10px 15px; text-align: left; }
        th { background: #f1f5f9; color: #475569; font-weight: bold; text-transform: uppercase; font-size: 11px; letter-spacing: 0.5px; }
        .text-center { text-align: center; }
        .text-right { text-align: right; }
        .avg-row { background: #f8fafc; font-weight: bold; }
        .footer { margin-top: 50px; text-align: center; font-size: 10px; color: #94a3b8; border-top: 1px solid #e2e8f0; padding-top: 15px; }
    </style></head><body>

    <div class="header">
        <h1>${session.schoolName}</h1>
        <h2>OFFICIAL STUDENT RECORD</h2>
    </div>

    <div class="info-grid">
        <div class="info-item"><label>Student Name</label><span>${s.name}</span></div>
        <div class="info-item"><label>Current Status</label><span>${s.archived ? 'Archived / Transferred' : 'Active'}</span></div>
        <div class="info-item"><label>Last Known Class</label><span>${s.className || 'Unassigned'}</span></div>
        <div class="info-item"><label>Archive Reason</label><span>${s.archiveReason || 'N/A'}</span></div>
    </div>`;

    if (Object.keys(bySem).length === 0) {
        html += `<p style="text-align:center; color:#64748b; font-style:italic; padding: 40px;">No academic grades recorded for this student.</p>`;
    } else {
        for (let sem in bySem) {
            html += `<div class="sem-block"><h3 class="sem-title">Period ID: ${sem}</h3><table>
                <thead><tr><th>Subject</th><th class="text-center">Assignments</th><th class="text-center">Average (%)</th><th class="text-center">Letter Grade</th></tr></thead><tbody>`;
            
            let semTotalPct = 0; let semSubjCount = 0;
            for (let sub in bySem[sem]) {
                const sGrades = bySem[sem][sub];
                const avg = Math.round(sGrades.reduce((acc, g) => acc + (g.max ? (g.score / g.max) * 100 : 0), 0) / sGrades.length);
                semTotalPct += avg; semSubjCount++;
                html += `<tr><td>${sub}</td><td class="text-center">${sGrades.length}</td><td class="text-center">${avg}%</td><td class="text-center">${letterGrade(avg)}</td></tr>`;
            }
            const semAvg = Math.round(semTotalPct / semSubjCount);
            html += `<tr class="avg-row"><td colspan="2" class="text-right">PERIOD AVERAGE:</td><td class="text-center">${semAvg}%</td><td class="text-center">${letterGrade(semAvg)}</td></tr>`;
            html += `</tbody></table></div>`;
        }
    }

    html += `<div class="footer">Printed on ${new Date().toLocaleDateString()} via ConnectUs Platform<br>Record generated by Admin: ${session.schoolId}</div></body></html>`;
    
    const w = window.open('', '_blank'); w.document.write(html); w.document.close();
    setTimeout(() => w.print(), 500);
};

// ── INITIALIZE ────────────────────────────────────────────────────────────
document.addEventListener('DOMContentLoaded', loadSettingsData);
