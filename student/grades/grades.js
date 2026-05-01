import { db } from '../../assets/js/firebase-init.js';
import { collection, query, where, getDocs, doc, getDoc } from "https://www.gstatic.com/firebasejs/10.7.1/firebase-firestore.js";
import { requireAuth } from '../../assets/js/auth.js';
import { injectStudentLayout } from '../../assets/js/layout-student.js';
import { calculateWeightedAverage } from '../../assets/js/utils.js';

// ── 1. AUTH & LAYOUT ──────────────────────────────────────────────────────
const session = requireAuth('student', '../login.html');
injectStudentLayout('gradebook', 'My Gradebook', 'Full grade breakdown by subject');

document.getElementById('displayStudentName').innerText  = session.studentData.name || 'Student';
document.getElementById('studentAvatar').innerText       = (session.studentData.name || 'S').charAt(0).toUpperCase();
document.getElementById('displayStudentClass').innerText = session.studentData.className
    ? `Class: ${session.studentData.className}` : 'Unassigned';

// ── 2. STATE ─────────────────────────────────────────────────────────────
let allGrades     = [];
let teacherRubric = [];
let teachersMap   = {};

// ── 3. HELPERS ────────────────────────────────────────────────────────────
function esc(s) {
    return String(s || '').replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;');
}

function gradeStyle(p) {
    if (p >= 90) return { color:'#059669', bg:'#d1fae5', border:'#6ee7b7', letter:'A', bar:'#10b981' };
    if (p >= 80) return { color:'#2563eb', bg:'#dbeafe', border:'#93c5fd', letter:'B', bar:'#3b82f6' };
    if (p >= 70) return { color:'#0d9488', bg:'#ccfbf1', border:'#5eead4', letter:'C', bar:'#14b8a6' };
    if (p >= 65) return { color:'#d97706', bg:'#fef3c7', border:'#fcd34d', letter:'D', bar:'#f59e0b' };
    return             { color:'#dc2626', bg:'#fee2e2', border:'#fca5a5', letter:'F', bar:'#ef4444' };
}

function standing(avg) {
    if (avg >= 90) return '⭐ Excelling';
    if (avg >= 80) return '👍 Good Standing';
    if (avg >= 70) return '➡ On Track';
    if (avg >= 65) return '⚠ Needs Attention';
    return '🔴 At Risk';
}

function isNew(date, created) {
    const d = created ? new Date(created) : new Date(date);
    return !isNaN(d) && Math.ceil(Math.abs(new Date() - d) / 86400000) <= 5;
}

function getWeight(type) {
    if (!type || !teacherRubric.length) return null;
    const r = teacherRubric.find(x => x.name?.toLowerCase() === type.toLowerCase());
    return r ? r.weight : null;
}

function dotColor(p) {
    if (p >= 80) return '#10b981';
    if (p >= 65) return '#f59e0b';
    return '#ef4444';
}

// ── 4. LOAD DATA ─────────────────────────────────────────────────────────
async function loadGrades() {
    try {
        const schoolSnap = await getDoc(doc(db, 'schools', session.schoolId));
        const schoolData = schoolSnap.data() || {};
        const semId      = schoolData.activeSemesterId;

        document.getElementById('displaySchoolName').innerText = schoolData.schoolName || 'ConnectUs';

        if (!semId) {
            document.getElementById('gradesLoader').innerHTML =
                '<i class="fa-solid fa-calendar-xmark" style="font-size:28px;color:#fbbf24;"></i><p>No active grading period set by the school.</p>';
            return;
        }

        const semSnap = await getDoc(doc(db, 'schools', session.schoolId, 'semesters', semId));
        const semName = semSnap.data()?.name || 'Current Period';
        document.getElementById('activeSemesterDisplay').textContent = semName;
        document.getElementById('gbTerm').textContent = semName;

        // Teacher rubric
        const tId = session.studentData?.teacherId;
        if (tId) {
            const tSnap = await getDoc(doc(db, 'teachers', tId));
            if (tSnap.exists()) {
                const td = tSnap.data();
                teacherRubric  = td.gradeTypes || td.customGradeTypes || [];
                teachersMap[tId] = td.name || 'Teacher';
            }
        }

        // All teachers (for admin-entered grades)
        const tAllSnap = await getDocs(query(collection(db, 'teachers'), where('currentSchoolId','==', session.schoolId)));
        tAllSnap.forEach(d => { teachersMap[d.id] = d.data().name; });

        // Grades — global student path
        const gSnap = await getDocs(query(
            collection(db, 'students', session.studentId, 'grades'),
            where('schoolId',   '==', session.schoolId),
            where('semesterId', '==', semId)
        ));
        allGrades = gSnap.docs.map(d => ({ id: d.id, ...d.data() }));

        document.getElementById('gradesLoader').style.display = 'none';

        if (!allGrades.length) {
            document.getElementById('noCurrentGradesMsg').classList.remove('hidden');
            return;
        }

        // Group by subject
        const bySub = {};
        allGrades.forEach(g => {
            const sub = g.subject || 'Uncategorized';
            if (!bySub[sub]) bySub[sub] = [];
            bySub[sub].push(g);
        });

        // Overall average (weighted per subject, then averaged)
        let totalAvg = 0, subCount = 0;
        for (const sub in bySub) {
            const avg = calculateWeightedAverage(bySub[sub], teacherRubric);
            if (avg !== null) { totalAvg += avg; subCount++; }
        }
        const overall = subCount > 0 ? Math.round(totalAvg / subCount) : null;

        // Populate header
        const topbar = document.getElementById('gbTopbar');
        topbar.style.display = 'flex';
        if (overall !== null) {
            const st = gradeStyle(overall);
            document.getElementById('gbAvg').textContent      = overall;
            document.getElementById('gbAvg').style.color      = '#fff';
            const standEl = document.getElementById('gbStanding');
            standEl.textContent   = standing(overall);
            standEl.style.display = 'inline-flex';
        }

        renderTable(bySub);

    } catch(e) {
        console.error('[Grades] load error:', e);
        document.getElementById('gradesLoader').innerHTML =
            '<i class="fa-solid fa-triangle-exclamation" style="color:#ef4444;font-size:28px;"></i><p style="color:#ef4444;">Failed to load grades. Please refresh.</p>';
    }
}

// ── 5. RENDER TABLE ───────────────────────────────────────────────────────
function renderTable(bySub) {
    const table   = document.getElementById('gradesTable');
    const rowsEl  = document.getElementById('subjectRows');
    table.classList.remove('hidden');

    rowsEl.innerHTML = Object.entries(bySub)
        .sort((a,b) => a[0].localeCompare(b[0]))
        .map(([subject, grades]) => {

        const avg    = calculateWeightedAverage(grades, teacherRubric);
        const avgRnd = avg !== null ? Math.round(avg) : null;
        const st     = avgRnd !== null ? gradeStyle(avgRnd) : null;

        // Group by type
        const byType = {};
        grades.forEach(g => {
            const t = g.type || 'Other';
            if (!byType[t]) byType[t] = [];
            byType[t].push(g);
        });

        // Type rows
        const typeRowsHtml = Object.entries(byType).map(([type, tGrades]) => {
            const typeAvg = Math.round(tGrades.reduce((s,g) => s + (g.max ? (g.score/g.max)*100 : 0), 0) / tGrades.length);
            const tSt     = gradeStyle(typeAvg);
            const w       = getWeight(type);
            const safeKey = esc(`${subject}||${type}`);

            return `
            <div class="type-row" onclick="window.openTypeModal('${esc(subject)}','${esc(type)}')">
                <div class="type-name-cell">
                    <div class="type-dot" style="background:${dotColor(typeAvg)};"></div>
                    <div>
                        <div class="type-name">${esc(type)}</div>
                        ${w !== null ? `<div class="type-w">${w}% of subject grade</div>` : ''}
                    </div>
                </div>
                <div class="type-cnt-cell">${tGrades.length} item${tGrades.length !== 1 ? 's' : ''}</div>
                <div class="type-avg-cell" style="color:${tSt.color};">${typeAvg}%</div>
                <div class="type-action">
                    <button class="type-view-btn">
                        <i class="fa-solid fa-table-list" style="font-size:11px;"></i> View All
                    </button>
                </div>
            </div>`;
        }).join('');

        const subjKey = `subj-${subject.replace(/[^a-z0-9]/gi,'-')}`;

        return `
        <div class="subj-row" id="${subjKey}" onclick="window.toggleSubject('${subjKey}')">
            <div class="subj-row-name">
                <div class="subj-initial">${esc(subject.charAt(0).toUpperCase())}</div>
                <div>
                    <div class="subj-label">${esc(subject)}</div>
                    <div class="subj-cnt">${grades.length} assignment${grades.length !== 1 ? 's' : ''}</div>
                </div>
            </div>
            <div class="subj-row-avg" style="color:${st?.color || '#1e293b'};">
                ${avgRnd !== null ? avgRnd + '%' : '—'}
            </div>
            <div class="subj-row-ltr">
                ${st ? `<span class="ltr-badge" style="background:${st.bg};color:${st.color};border-color:${st.border};">${st.letter}</span>` : '—'}
            </div>
            <div class="subj-row-chev"><i class="fa-solid fa-chevron-down"></i></div>
        </div>

        <div class="type-section" id="types-${subjKey}">
            <div class="type-table-head">
                <span>Grade Type</span>
                <span>Items</span>
                <span>Type Average</span>
                <span style="text-align:right;">Details</span>
            </div>
            ${typeRowsHtml}
        </div>`;
    }).join('');
}

// ── 6. SUBJECT ACCORDION ─────────────────────────────────────────────────
window.toggleSubject = function(id) {
    const row   = document.getElementById(id);
    const types = document.getElementById(`types-${id}`);
    if (!row || !types) return;

    const isOpen = types.classList.contains('open');

    // Close all subjects first
    document.querySelectorAll('.subj-row').forEach(r => r.classList.remove('open'));
    document.querySelectorAll('.type-section').forEach(t => t.classList.remove('open'));

    if (!isOpen) {
        row.classList.add('open');
        types.classList.add('open');
    }
};

// ── 7. TYPE MODAL ─────────────────────────────────────────────────────────
window.openTypeModal = function(subject, type) {
    const grades = allGrades.filter(g =>
        (g.subject || 'Uncategorized') === subject && (g.type || 'Other') === type
    );
    if (!grades.length) return;

    const typeAvg = Math.round(grades.reduce((s,g) => s + (g.max ? (g.score/g.max)*100 : 0), 0) / grades.length);
    const w       = getWeight(type);
    const tSt     = gradeStyle(typeAvg);

    document.getElementById('tmTitle').textContent  = type;
    document.getElementById('tmMeta').textContent   = `${subject}${w !== null ? ' · ' + w + '% of grade' : ''}`;
    document.getElementById('tmAvg').textContent    = typeAvg + '%';
    document.getElementById('tmAvg').style.color    = tSt.color;
    document.getElementById('tmCount').textContent  = grades.length;
    document.getElementById('tmWeight').textContent = w !== null ? w + '%' : '—';

    const sorted = grades.sort((a,b) => (b.date||'').localeCompare(a.date||''));

    document.getElementById('tmList').innerHTML = sorted.map(g => {
        const pct    = g.max ? Math.round((g.score/g.max)*100) : null;
        const gSt    = pct !== null ? gradeStyle(pct) : null;
        const newBdg = isNew(g.date, g.createdAt)
            ? `<span class="new-badge">New</span>` : '';
        const adminBdg = g.enteredByAdmin
            ? `<span class="admin-badge">Admin</span>` : '';
        const tName  = g.enteredByAdmin
            ? (g.adminName || 'Administrator')
            : (teachersMap[g.teacherId] || 'Teacher');

        return `
        <div class="assign-item">
            <div class="assign-top">
                <div style="flex:1;min-width:0;">
                    <div class="assign-title">${esc(g.title || '—')}${newBdg}${adminBdg}</div>
                    <div class="assign-meta">${esc(g.date || '—')} · ${esc(tName)}</div>
                </div>
                <div class="assign-right">
                    <div class="assign-score" style="color:${gSt?.color || '#1e293b'};">${g.score} / ${g.max ?? '?'}</div>
                    <div class="assign-pct">${pct !== null ? pct + '%' : '—'}</div>
                </div>
            </div>
            <div class="assign-bar">
                <div class="assign-bar-fill" style="width:${Math.min(pct||0,100)}%;background:${gSt?.bar || '#94a3b8'};"></div>
            </div>
            ${g.notes ? `<div class="assign-notes">${esc(g.notes)}</div>` : ''}
            ${g.historyLogs?.length ? `
            <div style="margin-top:8px;padding:8px 12px;background:#fffbeb;border:1px solid #fde68a;border-radius:6px;font-size:11px;color:#92400e;font-weight:600;">
                <i class="fa-solid fa-clock-rotate-left" style="margin-right:5px;"></i>
                Grade was modified after initial entry.
            </div>` : ''}
        </div>`;
    }).join('');

    document.getElementById('typeModal').classList.remove('hidden');
};

window.closeTypeModal = function() {
    document.getElementById('typeModal').classList.add('hidden');
};

// Close on backdrop click
document.getElementById('typeModal').addEventListener('click', function(e) {
    if (e.target === this) window.closeTypeModal();
});

// ── INITIALIZE ────────────────────────────────────────────────────────────
document.addEventListener('DOMContentLoaded', loadGrades);
