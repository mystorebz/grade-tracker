import { db } from '../../assets/js/firebase-init.js';
import { collection, doc, getDoc, getDocs, updateDoc, deleteDoc } from "https://www.gstatic.com/firebasejs/10.7.1/firebase-firestore.js";
import { requireAuth } from '../../assets/js/auth.js';
import { injectAdminLayout } from '../../assets/js/layout-admin.js';

// ── 1. INIT & AUTH ────────────────────────────────────────────────────────
const session = requireAuth('admin', '../login.html');

// Inject layout (Assuming you added 'archives' to the sidebar or it acts as a standalone subpage)
injectAdminLayout('archives', 'Archives', 'Manage historical data and deleted records', false, false);

// ── 2. TAB SWITCHING LOGIC ────────────────────────────────────────────────
window.switchArchiveTab = function(tab) {
    document.getElementById('archiveTeachersList').classList.toggle('hidden', tab !== 'teachers');
    document.getElementById('archiveStudentsList').classList.toggle('hidden', tab !== 'students');
    document.getElementById('archiveTabTeachers').classList.toggle('active', tab === 'teachers');
    document.getElementById('archiveTabStudents').classList.toggle('active', tab === 'students');
};

// ── 3. LOAD ARCHIVED RECORDS ──────────────────────────────────────────────
async function loadArchivedRecords() {
    try {
        // Fetch Teachers
        const tSnap = await getDocs(collection(db, 'schools', session.schoolId, 'teachers'));
        const archivedTeachers = tSnap.docs.filter(d => d.data().archived);
        
        document.getElementById('archiveTeachersList').innerHTML = archivedTeachers.length ? archivedTeachers.map(d => {
            const t = d.data();
            return `
            <div class="flex items-center justify-between bg-red-50/50 hover:bg-red-50 border border-red-100 rounded-xl p-5 transition">
                <div>
                    <p class="font-black text-slate-800 text-base">${t.name}</p>
                    <p class="text-xs text-slate-500 font-semibold mt-1">Archived: ${t.archivedAt ? new Date(t.archivedAt).toLocaleDateString() : 'Unknown'}</p>
                </div>
                <div class="flex gap-2">
                    <button onclick="window.printTeacherRecord('${d.id}')" class="text-xs font-black text-slate-600 hover:bg-slate-200 border border-slate-300 bg-white px-4 py-2 rounded-lg transition shadow-sm" title="Print Record"><i class="fa-solid fa-print"></i></button>
                    <button onclick="window.restoreTeacher('${d.id}')" class="text-xs font-black text-emerald-700 hover:bg-emerald-600 hover:text-white border border-emerald-300 bg-emerald-50 px-4 py-2 rounded-lg transition shadow-sm">Restore</button>
                    <button onclick="window.permanentDeleteTeacher('${d.id}')" class="text-xs font-black text-rose-600 hover:bg-rose-600 hover:text-white border border-rose-300 bg-rose-50 px-4 py-2 rounded-lg transition shadow-sm">Delete Forever</button>
                </div>
            </div>`;
        }).join('') : '<div class="text-center py-12 bg-slate-50 rounded-xl border border-slate-100"><i class="fa-solid fa-folder-open text-3xl text-slate-300 mb-3 block"></i><p class="text-sm text-slate-500 font-semibold">No archived teachers.</p></div>';
        
        // Fetch Students
        const sSnap = await getDocs(collection(db, 'schools', session.schoolId, 'students'));
        const archivedStudents = sSnap.docs.filter(d => d.data().archived);
        
        document.getElementById('archiveStudentsList').innerHTML = archivedStudents.length ? archivedStudents.map(d => {
            const s = d.data();
            return `
            <div class="flex items-center justify-between bg-red-50/50 hover:bg-red-50 border border-red-100 rounded-xl p-5 transition">
                <div>
                    <p class="font-black text-slate-800 text-base">${s.name || 'Unnamed'}</p>
                    <p class="text-xs text-slate-500 font-semibold mt-1">
                        Last Class: ${s.className || 'Unassigned'} <span class="mx-2 text-slate-300">|</span> 
                        Archived: ${s.archivedAt ? new Date(s.archivedAt).toLocaleDateString() : 'Unknown'}
                    </p>
                    ${s.archiveReason ? `<p class="text-[11px] font-bold text-rose-600 mt-1.5"><i class="fa-solid fa-circle-info mr-1"></i>Reason: ${s.archiveReason}</p>` : ''}
                </div>
                <div class="flex gap-2">
                    <button onclick="window.printStudentRecord('${d.id}')" class="text-xs font-black text-slate-600 hover:bg-slate-200 border border-slate-300 bg-white px-4 py-2 rounded-lg transition shadow-sm" title="Print Record"><i class="fa-solid fa-print"></i></button>
                    <button onclick="window.restoreStudent('${d.id}')" class="text-xs font-black text-emerald-700 hover:bg-emerald-600 hover:text-white border border-emerald-300 bg-emerald-50 px-4 py-2 rounded-lg transition shadow-sm">Restore</button>
                    <button onclick="window.permanentDeleteStudent('${d.id}')" class="text-xs font-black text-rose-600 hover:bg-rose-600 hover:text-white border border-rose-300 bg-rose-50 px-4 py-2 rounded-lg transition shadow-sm">Delete Forever</button>
                </div>
            </div>`;
        }).join('') : '<div class="text-center py-12 bg-slate-50 rounded-xl border border-slate-100"><i class="fa-solid fa-folder-open text-3xl text-slate-300 mb-3 block"></i><p class="text-sm text-slate-500 font-semibold">No archived students.</p></div>';

    } catch (e) {
        console.error("Error loading archives:", e);
        document.getElementById('archiveTeachersList').innerHTML = '<p class="text-red-500 font-bold py-4">Error loading data.</p>';
        document.getElementById('archiveStudentsList').innerHTML = '<p class="text-red-500 font-bold py-4">Error loading data.</p>';
    }
}

// ── 4. RESTORE & DELETE LOGIC ─────────────────────────────────────────────
window.restoreTeacher = async function(id) {
    if (!confirm('Restore this teacher to active duty?')) return;
    try {
        await updateDoc(doc(db, 'schools', session.schoolId, 'teachers', id), { archived: false, archivedAt: null });
        loadArchivedRecords();
    } catch(e) {
        alert("Failed to restore teacher.");
    }
};

window.permanentDeleteTeacher = async function(id) {
    if (!confirm('Permanently delete this teacher? This action CANNOT be undone.')) return;
    try {
        await deleteDoc(doc(db, 'schools', session.schoolId, 'teachers', id));
        loadArchivedRecords();
    } catch(e) {
        alert("Failed to delete teacher.");
    }
};

window.restoreStudent = async function(id) {
    if (!confirm('Restore this student to active status? (They will be unassigned from classes and need a new teacher assignment)')) return;
    try {
        await updateDoc(doc(db, 'schools', session.schoolId, 'students', id), { archived: false, archivedAt: null, archiveReason: '' });
        loadArchivedRecords();
    } catch(e) {
        alert("Failed to restore student.");
    }
};

window.permanentDeleteStudent = async function(id) {
    if (!confirm('Permanently delete student and all associated grades? This action CANNOT be undone.')) return;
    try {
        await deleteDoc(doc(db, 'schools', session.schoolId, 'students', id));
        loadArchivedRecords();
    } catch(e) {
        alert("Failed to delete student.");
    }
};

// ── 5. PRINT ARCHIVED RECORDS ─────────────────────────────────────────────
window.printTeacherRecord = async function(teacherId) {
    const tDoc = await getDoc(doc(db, 'schools', session.schoolId, 'teachers', teacherId));
    if (!tDoc.exists()) return;
    const t = tDoc.data();
    
    let html = `<html><head><title>Archived Teacher - ${t.name}</title>
    <style>
        body { font-family: 'Helvetica Neue', sans-serif; padding: 40px; color: #1e293b; }
        .header { text-align: center; border-bottom: 2px solid #cbd5e1; padding-bottom: 20px; margin-bottom: 30px; }
        .header h1 { font-size: 24px; text-transform: uppercase; margin:0; }
        .header h2 { font-size: 16px; color: #dc2626; margin: 5px 0 0; }
        .info-row { display: flex; border-bottom: 1px solid #e2e8f0; padding: 12px 0; }
        .info-label { width: 150px; font-size: 11px; text-transform: uppercase; color: #64748b; font-weight: bold; }
        .info-val { flex: 1; font-size: 15px; font-weight: bold; }
    </style></head><body>
    <div class="header"><h1>${session.schoolName}</h1><h2>ARCHIVED TEACHER RECORD</h2></div>
    <div class="info-row"><div class="info-label">Name</div><div class="info-val">${t.name}</div></div>
    <div class="info-row"><div class="info-label">Email</div><div class="info-val">${t.email || 'N/A'}</div></div>
    <div class="info-row"><div class="info-label">Status</div><div class="info-val" style="color:#dc2626;">Archived (${t.archivedAt ? new Date(t.archivedAt).toLocaleDateString() : 'Date Unknown'})</div></div>
    </body></html>`;
    
    const w = window.open('', '_blank'); w.document.write(html); w.document.close();
    setTimeout(() => w.print(), 500);
};

window.printStudentRecord = async function(studentId) {
    const sDoc = await getDoc(doc(db, 'schools', session.schoolId, 'students', studentId));
    if (!sDoc.exists()) return;
    const s = sDoc.data();
    
    let html = `<html><head><title>Archived Student - ${s.name}</title>
    <style>
        body { font-family: 'Helvetica Neue', sans-serif; padding: 40px; color: #1e293b; }
        .header { text-align: center; border-bottom: 2px solid #cbd5e1; padding-bottom: 20px; margin-bottom: 30px; }
        .header h1 { font-size: 24px; text-transform: uppercase; margin:0; }
        .header h2 { font-size: 16px; color: #dc2626; margin: 5px 0 0; }
        .info-row { display: flex; border-bottom: 1px solid #e2e8f0; padding: 12px 0; }
        .info-label { width: 150px; font-size: 11px; text-transform: uppercase; color: #64748b; font-weight: bold; }
        .info-val { flex: 1; font-size: 15px; font-weight: bold; }
    </style></head><body>
    <div class="header"><h1>${session.schoolName}</h1><h2>ARCHIVED STUDENT RECORD</h2></div>
    <div class="info-row"><div class="info-label">Name</div><div class="info-val">${s.name || 'Unnamed'}</div></div>
    <div class="info-row"><div class="info-label">Archive Reason</div><div class="info-val">${s.archiveReason || 'N/A'}</div></div>
    <div class="info-row"><div class="info-label">Status</div><div class="info-val" style="color:#dc2626;">Archived (${s.archivedAt ? new Date(s.archivedAt).toLocaleDateString() : 'Date Unknown'})</div></div>
    </body></html>`;
    
    const w = window.open('', '_blank'); w.document.write(html); w.document.close();
    setTimeout(() => w.print(), 500);
};

// ── INITIALIZE ────────────────────────────────────────────────────────────
document.addEventListener('DOMContentLoaded', loadArchivedRecords);
