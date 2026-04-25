import { db } from '../../assets/js/firebase-init.js';
import {
    doc, getDoc, getDocs, addDoc, collection
} from "https://www.gstatic.com/firebasejs/10.7.1/firebase-firestore.js";
import { requireAuth } from '../../assets/js/auth.js';
import { injectAdminLayout } from '../../assets/js/layout-admin.js';
import { letterGrade, gradeFill } from '../../assets/js/utils.js';

// ── 1. AUTH & LAYOUT ──────────────────────────────────────────────────────
const session = requireAuth('admin', '../login.html');
injectAdminLayout('grade-entry', 'Enter Grade', 'Admin and sub-admin grade entry for any student at this school', false, false);

// ── 2. STATE ──────────────────────────────────────────────────────────────
let foundStudent  = null;   // { id, name, className, teacherId, ... }
let rawSemesters  = [];

// ── 3. INIT ───────────────────────────────────────────────────────────────
document.addEventListener('DOMContentLoaded', async () => {
    document.getElementById('agDate').valueAsDate = new Date();

    await loadSemesters();

    document.getElementById('lookupBtn').addEventListener('click', lookupStudent);
    document.getElementById('lookupId').addEventListener('keydown', e => {
        if (e.key === 'Enter') lookupStudent();
    });

    document.getElementById('agScore').addEventListener('input', updatePreview);
    document.getElementById('agMax').addEventListener('input', updatePreview);

    document.getElementById('saveGradeBtn').addEventListener('click', saveGrade);
});

// ── 4. LOAD SEMESTERS ─────────────────────────────────────────────────────
async function loadSemesters() {
    try {
        const cacheKey = `connectus_semesters_${session.schoolId}`;
        const cached   = localStorage.getItem(cacheKey);

        if (cached) {
            rawSemesters = JSON.parse(cached);
        } else {
            const snap = await getDocs(collection(db, 'schools', session.schoolId, 'semesters'));
            rawSemesters = snap.docs
                .map(d => ({ id: d.id, ...d.data() }))
                .sort((a, b) => (a.order || 0) - (b.order || 0));
            localStorage.setItem(cacheKey, JSON.stringify(rawSemesters));
        }

        let activeId = '';
        try {
            const schoolSnap = await getDoc(doc(db, 'schools', session.schoolId));
            activeId = schoolSnap.data()?.activeSemesterId || '';
        } catch(e) {}

        const sel = document.getElementById('agSemester');
        sel.innerHTML = '';
        rawSemesters.forEach(s => {
            const opt       = document.createElement('option');
            opt.value       = s.id;
            opt.textContent = s.name;
            if (s.id === activeId) opt.selected = true;
            sel.appendChild(opt);
        });

    } catch (e) {
        console.error('[AdminGradeEntry] loadSemesters:', e);
    }
}

// ── 5. STUDENT LOOKUP ─────────────────────────────────────────────────────
// ID-only — no name search. Student must belong to THIS school (currentSchoolId).
async function lookupStudent() {
    const rawId  = document.getElementById('lookupId').value.trim().toUpperCase();
    const msgEl  = document.getElementById('lookupMsg');
    const badge  = document.getElementById('studentBadge');
    const form   = document.getElementById('gradeFormSection');
    msgEl.classList.add('hidden');

    if (!rawId) { showLookupMsg('Please enter a Student Global ID.'); return; }
    if (!/^S\d{2}-[A-Z0-9]{5}$/.test(rawId)) {
        showLookupMsg('Invalid format. Student ID should look like S26-XXXXX.'); return;
    }

    const btn = document.getElementById('lookupBtn');
    btn.disabled  = true;
    btn.innerHTML = '<i class="fa-solid fa-spinner fa-spin"></i>';

    try {
        const snap = await getDoc(doc(db, 'students', rawId));

        if (!snap.exists()) {
            showLookupMsg('No student found with that ID.');
            btn.disabled  = false; btn.innerHTML = 'Look Up'; return;
        }

        const data = snap.data();

        // ── Must belong to this school ─────────────────────────────────────
        if (data.currentSchoolId !== session.schoolId) {
            showLookupMsg(
                data.currentSchoolId && data.currentSchoolId !== ''
                    ? 'This student is enrolled at a different school and cannot be graded here.'
                    : 'This student is not currently enrolled at your school.'
            );
            btn.disabled  = false; btn.innerHTML = 'Look Up'; return;
        }

        // ── Must be Active ─────────────────────────────────────────────────
        if (data.enrollmentStatus !== 'Active') {
            showLookupMsg(`This student's enrollment status is "${data.enrollmentStatus}". Only Active students can receive grades.`);
            btn.disabled  = false; btn.innerHTML = 'Look Up'; return;
        }

        // ── Found ──────────────────────────────────────────────────────────
        foundStudent = { id: snap.id, ...data };

        document.getElementById('badgeInitial').textContent = (data.name || '?').charAt(0).toUpperCase();
        document.getElementById('badgeName').textContent    = data.name || 'Unknown';
        document.getElementById('badgeMeta').textContent    =
            [data.className || 'Unassigned class', data.dob ? `DOB: ${data.dob}` : ''].filter(Boolean).join(' · ');
        document.getElementById('badgeId').textContent      = snap.id;

        badge.classList.remove('hidden');
        form.classList.remove('hidden');

        // Scroll to form
        form.scrollIntoView({ behavior: 'smooth', block: 'start' });

    } catch (e) {
        console.error('[AdminGradeEntry] lookup:', e);
        showLookupMsg('Connection error. Please try again.');
    }

    btn.disabled  = false;
    btn.innerHTML = 'Look Up';
}

function showLookupMsg(msg) {
    const el = document.getElementById('lookupMsg');
    el.textContent = msg;
    el.classList.remove('hidden');
}

window.resetLookup = function() {
    foundStudent = null;
    document.getElementById('lookupId').value = '';
    document.getElementById('studentBadge').classList.add('hidden');
    document.getElementById('gradeFormSection').classList.add('hidden');
    document.getElementById('lookupMsg').classList.add('hidden');
    document.getElementById('gradeSavedBanner').classList.add('hidden');
};

// ── 6. LIVE PREVIEW ───────────────────────────────────────────────────────
function updatePreview() {
    const score = parseFloat(document.getElementById('agScore').value);
    const max   = parseFloat(document.getElementById('agMax').value);
    const prev  = document.getElementById('gradePreview');

    if (!isNaN(score) && !isNaN(max) && max > 0 && score >= 0) {
        const pct    = Math.round((score / max) * 100);
        const color  = pct >= 90 ? 'text-emerald-600' : pct >= 80 ? 'text-blue-600' : pct >= 70 ? 'text-teal-600' : pct >= 65 ? 'text-amber-600' : 'text-red-600';
        const lbg    = pct >= 90 ? 'bg-emerald-50 border-emerald-200 text-emerald-600' : pct >= 80 ? 'bg-blue-50 border-blue-200 text-blue-600' : pct >= 70 ? 'bg-teal-50 border-teal-200 text-teal-600' : pct >= 65 ? 'bg-amber-50 border-amber-200 text-amber-600' : 'bg-red-50 border-red-200 text-red-600';
        const lbl    = pct >= 90 ? 'Excelling' : pct >= 80 ? 'Good Standing' : pct >= 70 ? 'On Track' : pct >= 65 ? 'Needs Attention' : 'At Risk';

        prev.classList.remove('hidden');
        document.getElementById('prevPct').textContent    = `${pct}%`;
        document.getElementById('prevPct').className      = `text-3xl font-black font-mono ${color}`;
        document.getElementById('prevLetter').textContent = letterGrade(pct);
        document.getElementById('prevLetter').className   = `text-xl font-black px-4 py-1.5 rounded-lg border ${lbg}`;
        document.getElementById('prevLabel').textContent  = lbl;
        document.getElementById('prevLabel').className    = `text-xs font-bold uppercase tracking-widest mt-2 ${color}`;
    } else {
        prev.classList.add('hidden');
    }
}

// ── 7. SAVE GRADE ─────────────────────────────────────────────────────────
// Grades are saved to the SAME path as teacher grades:
//   schools/{schoolId}/students/{studentId}/grades
// This ensures all existing grade-reading code works without changes.
// Admin entry is tagged with extra audit fields.
async function saveGrade() {
    if (!foundStudent) { alert('Please look up a student first.'); return; }

    const subject = document.getElementById('agSubject').value.trim();
    const type    = document.getElementById('agType').value;
    const title   = document.getElementById('agTitle').value.trim();
    const score   = parseFloat(document.getElementById('agScore').value);
    const max     = parseFloat(document.getElementById('agMax').value);
    const semId   = document.getElementById('agSemester').value;
    const date    = document.getElementById('agDate').value;
    const notes   = document.getElementById('agNotes').value.trim();

    if (!subject || !type || !title) {
        document.getElementById('gradeMsg').textContent = 'Subject, grade type, and title are required.';
        document.getElementById('gradeMsg').className   = 'text-sm font-bold p-3 rounded-xl text-red-600 bg-red-50 border border-red-100';
        document.getElementById('gradeMsg').classList.remove('hidden'); return;
    }
    if (isNaN(score) || isNaN(max) || max <= 0) {
        document.getElementById('gradeMsg').textContent = 'Please enter valid score and max values.';
        document.getElementById('gradeMsg').className   = 'text-sm font-bold p-3 rounded-xl text-red-600 bg-red-50 border border-red-100';
        document.getElementById('gradeMsg').classList.remove('hidden'); return;
    }
    if (score < 0 || score > max) {
        document.getElementById('gradeMsg').textContent = 'Score cannot be negative or exceed the maximum.';
        document.getElementById('gradeMsg').className   = 'text-sm font-bold p-3 rounded-xl text-red-600 bg-red-50 border border-red-100';
        document.getElementById('gradeMsg').classList.remove('hidden'); return;
    }

    document.getElementById('gradeMsg').classList.add('hidden');

    const btn = document.getElementById('saveGradeBtn');
    btn.disabled  = true;
    btn.innerHTML = '<i class="fa-solid fa-spinner fa-spin mr-2"></i> Committing...';

    try {
        const adminDisplayName = session.isSuperAdmin
            ? (session.schoolName || 'Super Admin')
            : (session.adminName  || 'Sub-Admin');

        await addDoc(
            collection(db, 'schools', session.schoolId, 'students', foundStudent.id, 'grades'),
            {
                teacherId:       foundStudent.teacherId || '',  // Original teacher for reporting
                semesterId:      semId,
                subject,
                type,
                date,
                title,
                score,
                max,
                notes:           notes ? `[Admin] ${notes}` : '',
                historyLogs:     [],
                createdAt:       new Date().toISOString(),

                // ── Audit fields ───────────────────────────────────────────
                // These fields flag this as an admin-entered grade so it's
                // visible as such in the student panel and audit log.
                enteredByAdmin:   true,
                adminId:          session.adminId || session.schoolId,
                adminName:        adminDisplayName,
                adminRole:        session.isSuperAdmin ? 'super_admin' : 'sub_admin'
            }
        );

        // ── Success: reset score/notes, keep other fields for batch entry ──
        document.getElementById('agScore').value = '';
        document.getElementById('agNotes').value = '';
        updatePreview();

        document.getElementById('gradeSavedBanner').classList.remove('hidden');
        document.getElementById('agSubject').focus();

    } catch (e) {
        console.error('[AdminGradeEntry] saveGrade:', e);
        document.getElementById('gradeMsg').textContent = 'System error. Could not commit record.';
        document.getElementById('gradeMsg').className   = 'text-sm font-bold p-3 rounded-xl text-red-600 bg-red-50 border border-red-100';
        document.getElementById('gradeMsg').classList.remove('hidden');
    }

    btn.disabled  = false;
    btn.innerHTML = '<i class="fa-solid fa-database mr-2 text-xs"></i>Commit Grade Record';
}
