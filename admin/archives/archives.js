import { db } from '../../assets/js/firebase-init.js';
import { collection, doc, getDoc, getDocs, updateDoc, query, where, arrayRemove } from "https://www.gstatic.com/firebasejs/10.7.1/firebase-firestore.js";
import { requireAuth } from '../../assets/js/auth.js';
import { injectAdminLayout } from '../../assets/js/layout-admin.js';

// ── 1. INIT & AUTH ────────────────────────────────────────────────────────
const session = requireAuth('admin', '../login.html');
injectAdminLayout('archives', 'Archives', 'Archived teachers and students', false, false);

// ── 2. TAB SWITCHING ──────────────────────────────────────────────────────
window.switchArchiveTab = function(tab) {
    document.getElementById('archiveTeachersList').classList.toggle('hidden', tab !== 'teachers');
    document.getElementById('archiveStudentsList').classList.toggle('hidden',  tab !== 'students');
    document.getElementById('archiveTabTeachers').classList.toggle('active', tab === 'teachers');
    document.getElementById('archiveTabStudents').classList.toggle('active',  tab === 'students');
};

// ── 3. RENDER HELPERS ─────────────────────────────────────────────────────
function renderTeacher(d) {
    const t = d.data();
    const dateStr = t.archivedAt ? new Date(t.archivedAt).toLocaleDateString('en-US', { month:'short', day:'numeric', year:'numeric' }) : 'Unknown date';

    return `
    <div class="archive-row" style="display:flex;align-items:center;justify-content:space-between;background:#fff;border:1px solid #e2e8f0;border-radius:8px;padding:16px 20px;transition:border-color 0.15s;" onmouseover="this.style.borderColor='#94a3b8'" onmouseout="this.style.borderColor='#e2e8f0'">
        <div style="display:flex;align-items:center;gap:14px;">
            <div style="width:38px;height:38px;border-radius:9px;background:#f0f4f8;border:1px solid #e2e8f0;display:flex;align-items:center;justify-content:center;font-size:14px;font-weight:700;color:#64748b;flex-shrink:0">
                ${(t.name || 'T').split(' ').map(w=>w[0]).join('').toUpperCase().slice(0,2)}
            </div>
            <div>
                <p style="font-size:14px;font-weight:600;color:#0f172a;margin:0 0 3px">${t.name || 'Unnamed Teacher'}</p>
                <p style="font-size:12px;color:#64748b;margin:0">
                    Archived ${dateStr}
                </p>
            </div>
        </div>
        <div style="display:flex;gap:8px;flex-shrink:0">
            <button onclick="window.printTeacherRecord('${d.id}')" style="display:flex;align-items:center;gap:6px;padding:7px 12px;background:#fff;border:1px solid #e2e8f0;border-radius:6px;font-size:12.5px;font-weight:600;color:#475569;cursor:pointer;transition:border-color 0.15s" onmouseover="this.style.borderColor='#94a3b8'" onmouseout="this.style.borderColor='#e2e8f0'">
                <i class="fa-solid fa-print" style="font-size:11px"></i> Print
            </button>
            <button onclick="window.restoreTeacher('${d.id}')" style="display:flex;align-items:center;gap:6px;padding:7px 14px;background:#f0fdf4;border:1px solid #bbf7d0;border-radius:6px;font-size:12.5px;font-weight:600;color:#15803d;cursor:pointer;transition:background 0.15s" onmouseover="this.style.background='#dcfce7'" onmouseout="this.style.background='#f0fdf4'">
                <i class="fa-solid fa-rotate-left" style="font-size:11px"></i> Restore
            </button>
        </div>
    </div>`;
}

function renderStudent(d) {
    const s = d.data();
    const dateStr = s.archivedAt ? new Date(s.archivedAt).toLocaleDateString('en-US', { month:'short', day:'numeric', year:'numeric' }) : 'Unknown date';

    return `
    <div class="archive-row" style="display:flex;align-items:center;justify-content:space-between;background:#fff;border:1px solid #e2e8f0;border-radius:8px;padding:16px 20px;transition:border-color 0.15s;" onmouseover="this.style.borderColor='#94a3b8'" onmouseout="this.style.borderColor='#e2e8f0'">
        <div style="display:flex;align-items:center;gap:14px;">
            <div style="width:38px;height:38px;border-radius:9px;background:#f0f4f8;border:1px solid #e2e8f0;display:flex;align-items:center;justify-content:center;font-size:14px;font-weight:700;color:#64748b;flex-shrink:0">
                ${(s.name || 'S').split(' ').map(w=>w[0]).join('').toUpperCase().slice(0,2)}
            </div>
            <div>
                <p style="font-size:14px;font-weight:600;color:#0f172a;margin:0 0 3px">
                    ${s.name || 'Unnamed Student'}
                    ${s.archiveReason ? `<span style="display:inline-block;margin-left:8px;font-size:10px;font-weight:700;padding:2px 8px;border-radius:99px;background:#fff1f2;border:1px solid #fecdd3;color:#e11d48">${s.archiveReason}</span>` : ''}
                </p>
                <p style="font-size:12px;color:#64748b;margin:0">
                    ${s.lastClassName ? `Last Class: ${s.lastClassName}` : (s.className ? `Class: ${s.className}` : 'No class assigned')}
                    <span style="margin:0 6px;color:#cbd5e1">·</span>
                    Archived ${dateStr}
                </p>
            </div>
        </div>
        <div style="display:flex;gap:8px;flex-shrink:0">
            <button onclick="window.printStudentRecord('${d.id}')" style="display:flex;align-items:center;gap:6px;padding:7px 12px;background:#fff;border:1px solid #e2e8f0;border-radius:6px;font-size:12.5px;font-weight:600;color:#475569;cursor:pointer;transition:border-color 0.15s" onmouseover="this.style.borderColor='#94a3b8'" onmouseout="this.style.borderColor='#e2e8f0'">
                <i class="fa-solid fa-print" style="font-size:11px"></i> Print
            </button>
            <button onclick="window.restoreStudent('${d.id}')" style="display:flex;align-items:center;gap:6px;padding:7px 14px;background:#f0fdf4;border:1px solid #bbf7d0;border-radius:6px;font-size:12.5px;font-weight:600;color:#15803d;cursor:pointer;transition:background 0.15s" onmouseover="this.style.background='#dcfce7'" onmouseout="this.style.background='#f0fdf4'">
                <i class="fa-solid fa-rotate-left" style="font-size:11px"></i> Restore
            </button>
        </div>
    </div>`;
}

function emptyState(message) {
    return `<div style="text-align:center;padding:48px 24px;background:#f8fafc;border:1px solid #e2e8f0;border-radius:8px">
        <i class="fa-solid fa-folder-open" style="font-size:28px;color:#cbd5e1;display:block;margin-bottom:10px"></i>
        <p style="font-size:13.5px;color:#64748b;margin:0;font-weight:500">${message}</p>
    </div>`;
}

// ── 4. LOAD RECORDS ───────────────────────────────────────────────────────
async function loadArchivedRecords() {
    const teacherEl = document.getElementById('archiveTeachersList');
    const studentEl = document.getElementById('archiveStudentsList');

    teacherEl.innerHTML = `<div style="display:flex;justify-content:center;padding:40px"><i class="fa-solid fa-spinner fa-spin" style="font-size:24px;color:#3b82f6"></i></div>`;
    studentEl.innerHTML = `<div style="display:flex;justify-content:center;padding:40px"><i class="fa-solid fa-spinner fa-spin" style="font-size:24px;color:#3b82f6"></i></div>`;

    try {
        // ── Teachers ────────────────────────────────
        const tSnap = await getDocs(query(collection(db, 'teachers'), where('archivedSchoolIds', 'array-contains', session.schoolId)));
        const visibleTeachers = tSnap.docs;

        teacherEl.innerHTML = visibleTeachers.length
            ? `<div style="display:flex;flex-direction:column;gap:8px">${visibleTeachers.map(renderTeacher).join('')}</div>`
            : emptyState('No archived teachers found.');

        // ── Students ───────────────────────────────────
        const sSnap = await getDocs(query(collection(db, 'students'), where('archivedSchoolIds', 'array-contains', session.schoolId)));
        
        // Ensure we don't show students who were archived previously but have since been restored to Active status at THIS school.
        const visibleStudents = sSnap.docs.filter(d => d.data().currentSchoolId !== session.schoolId || d.data().archived === true);

        studentEl.innerHTML = visibleStudents.length
            ? `<div style="display:flex;flex-direction:column;gap:8px">${visibleStudents.map(renderStudent).join('')}</div>`
            : emptyState('No archived students found.');

    } catch (e) {
        console.error('Error loading archives:', e);
        teacherEl.innerHTML = `<p style="color:#e11d48;font-weight:600;padding:16px;text-align:center;">Error loading data. Please refresh.</p>`;
        studentEl.innerHTML = `<p style="color:#e11d48;font-weight:600;padding:16px;text-align:center;">Error loading data. Please refresh.</p>`;
    }
}

// ── 5. RESTORE LOGIC ─────────────────────────────────────────────────────
window.restoreTeacher = async function(id) {
    if (!confirm('Restore this teacher to active duty at your school?')) return;
    try {
        await updateDoc(doc(db, 'teachers', id), {
            currentSchoolId: session.schoolId,
            archivedSchoolIds: arrayRemove(session.schoolId),
            archived: false,
            archivedAt: null
        });
        loadArchivedRecords();
    } catch (e) {
        alert('Failed to restore teacher.');
    }
};

window.restoreStudent = async function(id) {
    if (!confirm('Restore this student to Active status? They will need to be reassigned to a class.')) return;
    try {
        await updateDoc(doc(db, 'students', id), {
            enrollmentStatus: 'Active',
            currentSchoolId: session.schoolId,
            archived: false,
            archivedAt: null,
            archivedSchoolIds: arrayRemove(session.schoolId),
            archiveReason: ''
        });
        loadArchivedRecords();
    } catch (e) {
        alert('Failed to restore student. They may be enrolled at another school.');
    }
};

// ── 6. PRINT RECORDS ──────────────────────────────────────────────────────
window.printTeacherRecord = async function(teacherId) {
    const tDoc = await getDoc(doc(db, 'teachers', teacherId));
    if (!tDoc.exists()) return;
    const t = tDoc.data();
    const dateStr = t.archivedAt ? new Date(t.archivedAt).toLocaleDateString() : 'Unknown Date';

    const html = `<!DOCTYPE html>
    <html><head><title>Archived Teacher — ${escHtml(t.name)}</title>
    <style>
        @import url('https://fonts.googleapis.com/css2?family=Nunito:wght@400;600;700;800;900&display=swap');
        body { font-family: 'Nunito', sans-serif; padding: 40px; color: #0f172a; line-height: 1.5; margin: 0 auto; max-width: 8.5in; }
        .header-flex { display: flex; justify-content: space-between; align-items: flex-end; border-bottom: 3px solid #e2e8f0; padding-bottom: 20px; margin-bottom: 30px; }
        .logo { max-height: 60px; max-width: 200px; object-fit: contain; }
        .header-text { text-align: right; }
        .header-text h1 { margin: 0 0 5px; font-size: 24px; font-weight: 900; text-transform: uppercase; color: #0f172a; }
        .header-text h2 { margin: 0; font-size: 14px; color: #64748b; font-weight: 700; letter-spacing: 2px; }
        table { width: 100%; border-collapse: collapse; margin-top:20px; }
        td { padding: 12px 15px; border-bottom: 1px solid #e2e8f0; }
        .lbl { font-size: 11px; text-transform: uppercase; color: #64748b; font-weight: 800; letter-spacing: 1px; width: 30%; background:#f8fafc; }
        .val { font-size: 15px; font-weight: 700; color: #0f172a; }
    </style></head><body>
    <div class="header-flex">
        <img src="${session.logo || ''}" class="logo" onerror="this.style.display='none'">
        <div class="header-text">
            <h1>${escHtml(session.schoolName || 'School')}</h1>
            <h2>ARCHIVED TEACHER RECORD</h2>
        </div>
    </div>
    <table>
        <tr><td class="lbl">Teacher Name</td><td class="val">${escHtml(t.name)}</td></tr>
        <tr><td class="lbl">Global ID</td><td class="val" style="font-family:monospace;">${teacherId}</td></tr>
        <tr><td class="lbl">Email Address</td><td class="val">${escHtml(t.email || 'N/A')}</td></tr>
        <tr><td class="lbl">Phone Number</td><td class="val">${escHtml(t.phone || 'N/A')}</td></tr>
        <tr><td class="lbl">Archive Date</td><td class="val">${dateStr}</td></tr>
    </table>
    <div style="margin-top:50px;text-align:center;font-size:11px;color:#94a3b8;font-weight:600;">Printed on ${new Date().toLocaleDateString()} · Powered by ConnectUs</div>
    </body></html>`;

    const w = window.open('', '_blank'); w.document.write(html); w.document.close();
    setTimeout(() => w.print(), 500);
};

window.printStudentRecord = async function(studentId) {
    const sDoc = await getDoc(doc(db, 'students', studentId));
    if (!sDoc.exists()) return;
    const s = sDoc.data();
    const dateStr = s.archivedAt ? new Date(s.archivedAt).toLocaleDateString() : 'Unknown Date';

    const html = `<!DOCTYPE html>
    <html><head><title>Archived Student — ${escHtml(s.name)}</title>
    <style>
        @import url('https://fonts.googleapis.com/css2?family=Nunito:wght@400;600;700;800;900&display=swap');
        body { font-family: 'Nunito', sans-serif; padding: 40px; color: #0f172a; line-height: 1.5; margin: 0 auto; max-width: 8.5in; }
        .header-flex { display: flex; justify-content: space-between; align-items: flex-end; border-bottom: 3px solid #e2e8f0; padding-bottom: 20px; margin-bottom: 30px; }
        .logo { max-height: 60px; max-width: 200px; object-fit: contain; }
        .header-text { text-align: right; }
        .header-text h1 { margin: 0 0 5px; font-size: 24px; font-weight: 900; text-transform: uppercase; color: #0f172a; }
        .header-text h2 { margin: 0; font-size: 14px; color: #64748b; font-weight: 700; letter-spacing: 2px; }
        table { width: 100%; border-collapse: collapse; margin-top:20px; }
        td { padding: 12px 15px; border-bottom: 1px solid #e2e8f0; }
        .lbl { font-size: 11px; text-transform: uppercase; color: #64748b; font-weight: 800; letter-spacing: 1px; width: 30%; background:#f8fafc; }
        .val { font-size: 15px; font-weight: 700; color: #0f172a; }
    </style></head><body>
    <div class="header-flex">
        <img src="${session.logo || ''}" class="logo" onerror="this.style.display='none'">
        <div class="header-text">
            <h1>${escHtml(session.schoolName || 'School')}</h1>
            <h2>ARCHIVED STUDENT RECORD</h2>
        </div>
    </div>
    <table>
        <tr><td class="lbl">Student Name</td><td class="val">${escHtml(s.name)}</td></tr>
        <tr><td class="lbl">Global ID</td><td class="val" style="font-family:monospace;">${studentId}</td></tr>
        <tr><td class="lbl">Last Known Class</td><td class="val">${escHtml(s.lastClassName || s.className || 'Unassigned')}</td></tr>
        <tr><td class="lbl">Reason for Leaving</td><td class="val" style="color:#e11d48;">${escHtml(s.archiveReason || 'N/A')}</td></tr>
        <tr><td class="lbl">Archive Date</td><td class="val">${dateStr}</td></tr>
    </table>
    <div style="margin-top:50px;text-align:center;font-size:11px;color:#94a3b8;font-weight:600;">Printed on ${new Date().toLocaleDateString()} · Powered by ConnectUs</div>
    </body></html>`;

    const w = window.open('', '_blank'); w.document.write(html); w.document.close();
    setTimeout(() => w.print(), 500);
};

function escHtml(str) {
    if (!str) return '';
    return String(str).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}

// ── INITIALIZE ────────────────────────────────────────────────────────────
document.addEventListener('DOMContentLoaded', loadArchivedRecords);
