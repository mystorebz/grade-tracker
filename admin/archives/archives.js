import { db } from '../../assets/js/firebase-init.js';
import {
    collection, doc, getDoc, getDocs, updateDoc, query, where, arrayRemove, writeBatch
} from "https://www.gstatic.com/firebasejs/10.7.1/firebase-firestore.js";
import { requireAuth } from '../../assets/js/auth.js';
import { injectAdminLayout } from '../../assets/js/layout-admin.js';

// ── 1. INIT & AUTH ────────────────────────────────────────────────────────
const session = requireAuth('admin', '../login.html');
injectAdminLayout('archives', 'Archives', 'Archived teachers and students', false, false);

// ── 2. POLICY CONSTANTS ───────────────────────────────────────────────────
// Records archived more than PURGE_DAYS ago are hidden from all views.
// The data remains in Firestore — it is never deleted from this portal.
const PURGE_DAYS = 30;
const PURGE_MS   = PURGE_DAYS * 24 * 60 * 60 * 1000;

function isExpired(archivedAt) {
    if (!archivedAt) return false;
    return (Date.now() - new Date(archivedAt).getTime()) > PURGE_MS;
}

function daysRemaining(archivedAt) {
    if (!archivedAt) return PURGE_DAYS;
    const elapsed = Date.now() - new Date(archivedAt).getTime();
    return Math.max(0, PURGE_DAYS - Math.floor(elapsed / (24 * 60 * 60 * 1000)));
}

// ── 3. TAB SWITCHING ──────────────────────────────────────────────────────
window.switchArchiveTab = function(tab) {
    document.getElementById('archiveTeachersList').classList.toggle('hidden', tab !== 'teachers');
    document.getElementById('archiveStudentsList').classList.toggle('hidden',  tab !== 'students');
    document.getElementById('archiveTabTeachers').classList.toggle('active', tab === 'teachers');
    document.getElementById('archiveTabStudents').classList.toggle('active',  tab === 'students');
};

// ── 4. RENDER HELPERS ─────────────────────────────────────────────────────
function urgencyClass(days) {
    if (days <= 3)  return 'color:#e31b4a';
    if (days <= 7)  return 'color:#f59e0b';
    return 'color:#6b84a0';
}

function renderTeacher(d) {
    const t    = d.data();
    const days = daysRemaining(t.archivedAt);
    const dateStr = t.archivedAt
        ? new Date(t.archivedAt).toLocaleDateString('en-US', { month:'short', day:'numeric', year:'numeric' })
        : 'Unknown date';

    return `
    <div class="archive-row" style="display:flex;align-items:center;justify-content:space-between;background:#fff;border:1px solid var(--border);border-radius:var(--r-lg);padding:16px 20px;transition:border-color 0.15s;" onmouseover="this.style.borderColor='var(--border-strong)'" onmouseout="this.style.borderColor='var(--border)'">
        <div style="display:flex;align-items:center;gap:14px;">
            <div style="width:38px;height:38px;border-radius:9px;background:#f0f4f8;border:1px solid var(--border);display:flex;align-items:center;justify-content:center;font-size:14px;font-weight:700;color:var(--text-muted);flex-shrink:0">
                ${(t.name || 'T').split(' ').map(w=>w[0]).join('').toUpperCase().slice(0,2)}
            </div>
            <div>
                <p style="font-size:14px;font-weight:600;color:var(--text-primary);margin:0 0 3px">${t.name || 'Unnamed Teacher'}</p>
                <p style="font-size:12px;color:var(--text-muted);margin:0">
                    Archived ${dateStr}
                    <span style="margin:0 6px;color:var(--border-strong)">·</span>
                    <span style="${urgencyClass(days)}">
                        <i class="fa-regular fa-clock" style="font-size:10px;margin-right:3px"></i>
                        ${days} day${days !== 1 ? 's' : ''} until removed from view
                    </span>
                </p>
            </div>
        </div>
        <div style="display:flex;gap:8px;flex-shrink:0">
            <button onclick="window.printTeacherRecord('${d.id}')" style="display:flex;align-items:center;gap:6px;padding:7px 12px;background:#fff;border:1px solid var(--border);border-radius:var(--r-md);font-size:12.5px;font-weight:600;color:var(--text-secondary);cursor:pointer;font-family:inherit;transition:border-color 0.15s" onmouseover="this.style.borderColor='var(--border-strong)'" onmouseout="this.style.borderColor='var(--border)'">
                <i class="fa-solid fa-print" style="font-size:11px"></i> Print
            </button>
            <button onclick="window.restoreTeacher('${d.id}')" style="display:flex;align-items:center;gap:6px;padding:7px 14px;background:var(--green-50);border:1px solid var(--green-100);border-radius:var(--r-md);font-size:12.5px;font-weight:600;color:var(--green-700);cursor:pointer;font-family:inherit;transition:background 0.15s,border-color 0.15s" onmouseover="this.style.background='var(--green-100)'" onmouseout="this.style.background='var(--green-50)'">
                <i class="fa-solid fa-rotate-left" style="font-size:11px"></i> Restore
            </button>
        </div>
    </div>`;
}

function renderStudent(d) {
    const s    = d.data();
    const days = daysRemaining(s.archivedAt);
    const dateStr = s.archivedAt
        ? new Date(s.archivedAt).toLocaleDateString('en-US', { month:'short', day:'numeric', year:'numeric' })
        : 'Unknown date';

    return `
    <div class="archive-row" style="display:flex;align-items:center;justify-content:space-between;background:#fff;border:1px solid var(--border);border-radius:var(--r-lg);padding:16px 20px;transition:border-color 0.15s;" onmouseover="this.style.borderColor='var(--border-strong)'" onmouseout="this.style.borderColor='var(--border)'">
        <div style="display:flex;align-items:center;gap:14px;">
            <div style="width:38px;height:38px;border-radius:9px;background:#f0f4f8;border:1px solid var(--border);display:flex;align-items:center;justify-content:center;font-size:14px;font-weight:700;color:var(--text-muted);flex-shrink:0">
                ${(s.name || 'S').split(' ').map(w=>w[0]).join('').toUpperCase().slice(0,2)}
            </div>
            <div>
                <p style="font-size:14px;font-weight:600;color:var(--text-primary);margin:0 0 3px">
                    ${s.name || 'Unnamed Student'}
                    ${s.archiveReason ? `<span style="display:inline-block;margin-left:8px;font-size:10.5px;font-weight:600;padding:1px 8px;border-radius:99px;background:#fff0f3;border:1px solid #ffd6de;color:#e31b4a">${s.archiveReason}</span>` : ''}
                </p>
                <p style="font-size:12px;color:var(--text-muted);margin:0">
                    ${s.className ? `Class: ${s.className}` : 'No class assigned'}
                    <span style="margin:0 6px;color:var(--border-strong)">·</span>
                    Archived ${dateStr}
                    <span style="margin:0 6px;color:var(--border-strong)">·</span>
                    <span style="${urgencyClass(days)}">
                        <i class="fa-regular fa-clock" style="font-size:10px;margin-right:3px"></i>
                        ${days} day${days !== 1 ? 's' : ''} until removed from view
                    </span>
                </p>
            </div>
        </div>
        <div style="display:flex;gap:8px;flex-shrink:0">
            <button onclick="window.printStudentRecord('${d.id}')" style="display:flex;align-items:center;gap:6px;padding:7px 12px;background:#fff;border:1px solid var(--border);border-radius:var(--r-md);font-size:12.5px;font-weight:600;color:var(--text-secondary);cursor:pointer;font-family:inherit;transition:border-color 0.15s" onmouseover="this.style.borderColor='var(--border-strong)'" onmouseout="this.style.borderColor='var(--border)'">
                <i class="fa-solid fa-print" style="font-size:11px"></i> Print
            </button>
            <button onclick="window.restoreStudent('${d.id}')" style="display:flex;align-items:center;gap:6px;padding:7px 14px;background:var(--green-50);border:1px solid var(--green-100);border-radius:var(--r-md);font-size:12.5px;font-weight:600;color:var(--green-700);cursor:pointer;font-family:inherit;transition:background 0.15s,border-color 0.15s" onmouseover="this.style.background='var(--green-100)'" onmouseout="this.style.background='var(--green-50)'">
                <i class="fa-solid fa-rotate-left" style="font-size:11px"></i> Restore
            </button>
        </div>
    </div>`;
}

function emptyState(message) {
    return `<div style="text-align:center;padding:48px 24px;background:#fafbfc;border:1px solid var(--border);border-radius:var(--r-lg)">
        <i class="fa-solid fa-folder-open" style="font-size:28px;color:var(--text-faint);display:block;margin-bottom:10px"></i>
        <p style="font-size:13.5px;color:var(--text-muted);margin:0;font-weight:500">${message}</p>
    </div>`;
}

// ── 5. LOAD RECORDS ───────────────────────────────────────────────────────
async function loadArchivedRecords() {
    const teacherEl = document.getElementById('archiveTeachersList');
    const studentEl = document.getElementById('archiveStudentsList');

    teacherEl.innerHTML = `<div style="display:flex;justify-content:center;padding:40px"><i class="fa-solid fa-spinner fa-spin" style="font-size:20px;color:var(--blue-500)"></i></div>`;
    studentEl.innerHTML = `<div style="display:flex;justify-content:center;padding:40px"><i class="fa-solid fa-spinner fa-spin" style="font-size:20px;color:var(--blue-500)"></i></div>`;

    try {
        // ── Teachers: archived at this school ────────────────────────────────
        const tSnap = await getDocs(query(
            collection(db, 'teachers'),
            where('archivedSchoolIds', 'array-contains', session.schoolId)
        ));

        // Filter: only show records archived within the last PURGE_DAYS days
        const visibleTeachers = tSnap.docs.filter(d => !isExpired(d.data().archivedAt));

        teacherEl.innerHTML = visibleTeachers.length
            ? `<div style="display:flex;flex-direction:column;gap:8px">${visibleTeachers.map(renderTeacher).join('')}</div>`
            : emptyState('No archived teachers.');

        // ── Students: non-active enrollment at this school ───────────────────
        const sSnap = await getDocs(query(
            collection(db, 'students'),
            where('currentSchoolId', '==', session.schoolId),
            where('enrollmentStatus', 'in', ['Archived', 'Graduated', 'Expelled', 'Dropped Out'])
        ));

        const visibleStudents = sSnap.docs.filter(d => !isExpired(d.data().archivedAt));

        studentEl.innerHTML = visibleStudents.length
            ? `<div style="display:flex;flex-direction:column;gap:8px">${visibleStudents.map(renderStudent).join('')}</div>`
            : emptyState('No archived students.');

    } catch (e) {
        console.error('Error loading archives:', e);
        teacherEl.innerHTML = `<p style="color:#e31b4a;font-weight:600;padding:16px">Error loading data. Please refresh.</p>`;
        studentEl.innerHTML = `<p style="color:#e31b4a;font-weight:600;padding:16px">Error loading data. Please refresh.</p>`;
    }
}

// ── 6. RESTORE LOGIC ─────────────────────────────────────────────────────
window.restoreTeacher = async function(id) {
    if (!confirm('Restore this teacher to active duty at your school?')) return;
    try {
        const isGlobal = /^T\d{2}-[A-Z0-9]{5}$/i.test(id);
        if (isGlobal) {
            await updateDoc(doc(db, 'teachers', id), {
                currentSchoolId:   session.schoolId,
                archivedSchoolIds: arrayRemove(session.schoolId)
            });
        } else {
            await updateDoc(doc(db, 'schools', session.schoolId, 'teachers', id), { archived: false, archivedAt: null });
        }
        loadArchivedRecords();
    } catch (e) {
        alert('Failed to restore teacher.');
    }
};

window.restoreStudent = async function(id) {
    if (!confirm('Restore this student to Active status? They will need to be reassigned to a teacher.')) return;
    try {
        await updateDoc(doc(db, 'students', id), {
            enrollmentStatus: 'Active',
            currentSchoolId:  session.schoolId,
            archivedAt:       null
        });
        loadArchivedRecords();
    } catch (e) {
        alert('Failed to restore student.');
    }
};

// ── 7. PRINT RECORDS ──────────────────────────────────────────────────────
window.printTeacherRecord = async function(teacherId) {
    const isGlobal = /^T\d{2}-[A-Z0-9]{5}$/i.test(teacherId);
    const tDoc = await getDoc(isGlobal
        ? doc(db, 'teachers', teacherId)
        : doc(db, 'schools', session.schoolId, 'teachers', teacherId));
    if (!tDoc.exists()) return;
    const t = tDoc.data();

    const html = `<html><head><title>Archived Teacher — ${t.name}</title>
    <style>
        body { font-family:'Helvetica Neue',sans-serif; padding:40px; color:#0d1f35; }
        h1   { font-size:22px; margin:0 0 4px; }
        h2   { font-size:13px; color:#e31b4a; margin:0 0 28px; font-weight:600; text-transform:uppercase; letter-spacing:0.06em; }
        .row { display:flex; border-bottom:1px solid #e2e8f0; padding:12px 0; }
        .lbl { width:150px; font-size:11px; text-transform:uppercase; color:#6b84a0; font-weight:600; letter-spacing:0.06em; }
        .val { flex:1; font-size:14px; font-weight:600; }
    </style></head><body>
    <h1>${session.schoolName || 'School'}</h1>
    <h2>Archived Teacher Record</h2>
    <div class="row"><div class="lbl">Name</div><div class="val">${t.name || 'N/A'}</div></div>
    <div class="row"><div class="lbl">Email</div><div class="val">${t.email || 'N/A'}</div></div>
    <div class="row"><div class="lbl">Archived</div><div class="val">${t.archivedAt ? new Date(t.archivedAt).toLocaleDateString() : 'Unknown'}</div></div>
    </body></html>`;

    const w = window.open('', '_blank');
    w.document.write(html);
    w.document.close();
    setTimeout(() => w.print(), 500);
};

window.printStudentRecord = async function(studentId) {
    const sDoc = await getDoc(doc(db, 'students', studentId));
    if (!sDoc.exists()) return;
    const s = sDoc.data();

    const html = `<html><head><title>Archived Student — ${s.name}</title>
    <style>
        body { font-family:'Helvetica Neue',sans-serif; padding:40px; color:#0d1f35; }
        h1   { font-size:22px; margin:0 0 4px; }
        h2   { font-size:13px; color:#e31b4a; margin:0 0 28px; font-weight:600; text-transform:uppercase; letter-spacing:0.06em; }
        .row { display:flex; border-bottom:1px solid #e2e8f0; padding:12px 0; }
        .lbl { width:150px; font-size:11px; text-transform:uppercase; color:#6b84a0; font-weight:600; letter-spacing:0.06em; }
        .val { flex:1; font-size:14px; font-weight:600; }
    </style></head><body>
    <h1>${session.schoolName || 'School'}</h1>
    <h2>Archived Student Record</h2>
    <div class="row"><div class="lbl">Name</div><div class="val">${s.name || 'N/A'}</div></div>
    <div class="row"><div class="lbl">Class</div><div class="val">${s.className || 'N/A'}</div></div>
    <div class="row"><div class="lbl">Reason</div><div class="val">${s.archiveReason || 'N/A'}</div></div>
    <div class="row"><div class="lbl">Archived</div><div class="val">${s.archivedAt ? new Date(s.archivedAt).toLocaleDateString() : 'Unknown'}</div></div>
    </body></html>`;

    const w = window.open('', '_blank');
    w.document.write(html);
    w.document.close();
    setTimeout(() => w.print(), 500);
};

// ── INITIALIZE ────────────────────────────────────────────────────────────
document.addEventListener('DOMContentLoaded', loadArchivedRecords);
