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
document.getElementById('displayStudentClass').innerText = session.studentData.className ? `Class: ${session.studentData.className}` : 'Unassigned';

// ── 2. STATE ─────────────────────────────────────────────────────────────
let allGrades         = [];
let teacherRubric     = [];
let teachersMap       = {};
let activeTypeKey     = null; // tracks currently open type section: 'SubjName::TypeName'

// ── 3. HELPERS ────────────────────────────────────────────────────────────
function escHtml(s) {
    return String(s || '').replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;');
}

function gradeStyle(p) {
    if (p >= 90) return { color: '#059669', bg: '#d1fae5', border: '#6ee7b7', letter: 'A', barColor: '#10b981' };
    if (p >= 80) return { color: '#2563eb', bg: '#dbeafe', border: '#93c5fd', letter: 'B', barColor: '#3b82f6' };
    if (p >= 70) return { color: '#0d9488', bg: '#ccfbf1', border: '#5eead4', letter: 'C', barColor: '#14b8a6' };
    if (p >= 65) return { color: '#d97706', bg: '#fef3c7', border: '#fcd34d', letter: 'D', barColor: '#f59e0b' };
    return             { color: '#dc2626', bg: '#fee2e2', border: '#fca5a5', letter: 'F', barColor: '#ef4444' };
}

function standingText(avg) {
    if (avg >= 90) return '⭐ Excelling';
    if (avg >= 80) return '👍 Good Standing';
    if (avg >= 70) return '➡ On Track';
    if (avg >= 65) return '👁 Needs Attention';
    return '⚠ At Risk';
}

function isNew(dateStr, createdStr) {
    const d = createdStr ? new Date(createdStr) : new Date(dateStr);
    return !isNaN(d) && Math.ceil(Math.abs(new Date() - d) / 86400000) <= 5;
}

function getWeight(type) {
    if (!type) return null;
    const t = teacherRubric.find(r => r.name?.toLowerCase() === type.toLowerCase());
    return t ? t.weight : null;
}

// ── 4. LOAD ───────────────────────────────────────────────────────────────
async function loadGrades() {
    const loader    = document.getElementById('gradesLoader');
    const emptyMsg  = document.getElementById('noCurrentGradesMsg');
    const container = document.getElementById('currentSubjectsContainer');

    try {
        // School + active semester
        const schoolSnap = await getDoc(doc(db, 'schools', session.schoolId));
        const schoolData = schoolSnap.data() || {};
        const activeSemId   = schoolData.activeSemesterId;
        const schoolName    = schoolData.schoolName || 'ConnectUs School';

        document.getElementById('displaySchoolName').innerText = schoolName;

        if (!activeSemId) {
            loader.innerHTML = '<i class="fa-solid fa-calendar-xmark" style="font-size:28px;color:#fbbf24;"></i><p>No active grading period set by the school.</p>';
            return;
        }

        // Semester name
        const semSnap  = await getDoc(doc(db, 'schools', session.schoolId, 'semesters', activeSemId));
        const semName  = semSnap.data()?.name || 'Current Period';
        document.getElementById('activeSemesterDisplay').textContent = semName;
        document.getElementById('gbTermLabel').textContent = semName;

        // Teacher rubric — from the student's assigned teacher
        const tId = session.studentData?.teacherId;
        if (tId) {
            const tSnap = await getDoc(doc(db, 'teachers', tId));
            if (tSnap.exists()) {
                teacherRubric = tSnap.data().gradeTypes || tSnap.data().customGradeTypes || [];
                teachersMap[tId] = tSnap.data().name || 'Teacher';
            }
        }

        // All teachers map (for admin-entered grades)
        const tAllSnap = await getDocs(query(collection(db, 'teachers'), where('currentSchoolId', '==', session.schoolId)));
        tAllSnap.forEach(d => { teachersMap[d.id] = d.data().name; });

        // Grades — global student path
        const gSnap = await getDocs(query(
            collection(db, 'students', session.studentId, 'grades'),
            where('schoolId',    '==', session.schoolId),
            where('semesterId',  '==', activeSemId)
        ));
        allGrades = gSnap.docs.map(d => ({ id: d.id, ...d.data() }));

        loader.style.display = 'none';

        if (!allGrades.length) {
            emptyMsg.classList.remove('hidden');
            return;
        }

        // Overall weighted average (per-subject weighted, then averaged across subjects)
        const bySub = {};
        allGrades.forEach(g => {
            const sub = g.subject || 'Uncategorized';
            if (!bySub[sub]) bySub[sub] = [];
            bySub[sub].push(g);
        });

        let totalSubjAvg = 0, subjCount = 0;
        for (const sub in bySub) {
            // fetch per-subject teacher rubric if different teacher entered grades
            const subTeacherId = bySub[sub][0]?.teacherId;
            let rubric = teacherRubric;
            if (subTeacherId && subTeacherId !== tId && !teacherRubric.length) {
                try {
                    const stDoc = await getDoc(doc(db, 'teachers', subTeacherId));
                    rubric = stDoc.data()?.gradeTypes || stDoc.data()?.customGradeTypes || [];
                } catch(e) {}
            }
            const avg = calculateWeightedAverage(bySub[sub], rubric);
            if (avg !== null) { totalSubjAvg += avg; subjCount++; }
        }

        const overallAvg = subjCount > 0 ? Math.round(totalSubjAvg / subjCount) : null;

        // Populate header
        const header = document.getElementById('gbHeader');
        header.style.display = 'flex';
        if (overallAvg !== null) {
            const st = gradeStyle(overallAvg);
            document.getElementById('gbAvgNum').textContent      = overallAvg;
            document.getElementById('gbStandingLabel').textContent = standingText(overallAvg);
            document.getElementById('gbStandingLabel').style.color = 'rgba(255,255,255,0.75)';
        } else {
            document.getElementById('gbAvgNum').textContent = '--';
        }

        renderSubjects(bySub);

    } catch(e) {
        console.error('[Grades] load error:', e);
        loader.innerHTML = '<i class="fa-solid fa-triangle-exclamation" style="color:#ef4444;"></i><p style="color:#ef4444;">Failed to load grades. Please refresh.</p>';
    }
}

// ── 5. RENDER SUBJECTS ────────────────────────────────────────────────────
function renderSubjects(bySub) {
    const container = document.getElementById('currentSubjectsContainer');

    container.innerHTML = Object.entries(bySub).sort((a,b) => a[0].localeCompare(b[0])).map(([subject, grades]) => {
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

        const typeRows = Object.entries(byType).map(([type, tGrades]) => {
            const typeAvgRaw = tGrades.reduce((s, g) => s + (g.max ? (g.score/g.max)*100 : 0), 0) / tGrades.length;
            const typeAvg    = Math.round(typeAvgRaw);
            const typeKey    = `${subject}::${type}`;
            const tSt        = gradeStyle(typeAvg);
            const w          = getWeight(type);

            const assignRows = tGrades.sort((a,b) => (b.date||'').localeCompare(a.date||'')).map(g => {
                const pct    = g.max ? Math.round((g.score/g.max)*100) : null;
                const aSt    = pct !== null ? gradeStyle(pct) : null;
                const newBdg = isNew(g.date, g.createdAt) ? `<span class="new-badge">New</span>` : '';
                const adminTag = g.enteredByAdmin
                    ? `<span style="font-size:9px;font-weight:700;background:#eff6ff;color:#2563eb;border:1px solid #bfdbfe;padding:1px 6px;border-radius:4px;margin-left:5px;">Admin</span>` : '';

                return `
                <div class="assign-row" onclick="window.viewGrade('${escHtml(g.id)}')">
                    <div style="flex:1;min-width:0;">
                        <p class="assign-title">${escHtml(g.title || '—')}${newBdg}${adminTag}</p>
                        <p class="assign-meta">${escHtml(g.date || '')}${g.notes ? ' · <i class="fa-solid fa-comment-dots" style="color:#6366f1;"></i> Has notes' : ''}</p>
                    </div>
                    <div style="flex-shrink:0;margin-left:16px;text-align:right;">
                        <p class="assign-score" style="color:${aSt?.color || '#1e293b'}">${g.score}/${g.max ?? '?'}</p>
                        <p class="assign-pct">${pct !== null ? pct + '%' : '—'}</p>
                    </div>
                    <i class="fa-solid fa-chevron-right" style="font-size:10px;color:#cbd5e1;margin-left:12px;flex-shrink:0;"></i>
                </div>`;
            }).join('');

            return `
            <div class="type-section" data-key="${escHtml(typeKey)}">
                <div class="type-row-header" onclick="window.toggleTypeRow('${escHtml(typeKey)}')">
                    <div style="display:flex;align-items:center;flex:1;min-width:0;">
                        <span class="type-pill">${tGrades.length} item${tGrades.length !== 1 ? 's' : ''}</span>
                        <span class="type-label">${escHtml(type)}</span>
                        ${w !== null ? `<span class="type-weight">${w}% of grade</span>` : ''}
                    </div>
                    <div style="display:flex;align-items:center;">
                        <span class="type-avg" style="color:${tSt.color};">${typeAvg}%</span>
                        <i class="fa-solid fa-chevron-down type-chevron"></i>
                    </div>
                </div>
                <div class="type-body" id="tbody-${escHtml(typeKey.replace(/[^a-z0-9]/gi,'-'))}">${assignRows}</div>
            </div>`;
        }).join('');

        // Rubric chips
        const rubricChips = teacherRubric.length
            ? teacherRubric.map(r => `<span class="rubric-chip">${escHtml(r.name)} ${r.weight}%</span>`).join('')
            : '<span class="rubric-chip" style="background:#f1f5f9;color:#64748b;border-color:#e2e8f0;">Standard grading</span>';

        return `
        <div class="subj-card">
            <div class="subj-header">
                <div style="display:flex;align-items:center;flex:1;min-width:0;">
                    <div class="subj-icon">${escHtml(subject.charAt(0).toUpperCase())}</div>
                    <div>
                        <p class="subj-name">${escHtml(subject)}</p>
                        <p class="subj-count">${grades.length} assignment${grades.length !== 1 ? 's' : ''}</p>
                    </div>
                </div>
                ${avgRnd !== null ? `
                <div class="subj-avg-badge">
                    <span class="subj-avg-num">${avgRnd}%</span>
                    <span class="subj-ltr" style="background:${st.bg};color:${st.color};border:1px solid ${st.border};">${st.letter}</span>
                </div>` : ''}
            </div>
            ${typeRows}
            <div class="rubric-bar">
                <span style="font-size:10px;font-weight:700;color:#94a3b8;text-transform:uppercase;letter-spacing:0.08em;margin-right:4px;">Weights:</span>
                ${rubricChips}
            </div>
        </div>`;
    }).join('');
}

// ── 6. TYPE ACCORDION (one open at a time) ────────────────────────────────
window.toggleTypeRow = function(key) {
    const safeKey    = key.replace(/[^a-z0-9]/gi, '-');
    const body       = document.getElementById(`tbody-${safeKey}`);
    const allBodies  = document.querySelectorAll('.type-body');
    const allChevs   = document.querySelectorAll('.type-chevron');

    if (!body) return;

    const isOpen = body.classList.contains('open');

    // Close all
    allBodies.forEach(b => b.classList.remove('open'));
    allChevs.forEach(c => c.style.transform = 'rotate(0deg)');

    // Open this one if it was closed
    if (!isOpen) {
        body.classList.add('open');
        const header = body.previousElementSibling;
        if (header) {
            const chev = header.querySelector('.type-chevron');
            if (chev) chev.style.transform = 'rotate(180deg)';
        }
    }
};

// ── 7. ASSIGNMENT MODAL ───────────────────────────────────────────────────
window.viewGrade = function(gradeId) {
    const g = allGrades.find(x => x.id === gradeId);
    if (!g) return;

    const pct  = g.max ? Math.round((g.score / g.max) * 100) : 0;
    const st   = gradeStyle(pct);
    const w    = getWeight(g.type);
    const tName = g.enteredByAdmin
        ? (g.adminName || 'Administrator')
        : (teachersMap[g.teacherId] || 'Teacher');

    document.getElementById('mdSubject').textContent  = g.subject || 'Uncategorized';
    document.getElementById('mdTitle').textContent    = g.title || 'Assessment';
    document.getElementById('mdScore').textContent    = `${g.score} / ${g.max ?? '?'}`;
    document.getElementById('mdPct').textContent      = `${pct}%`;
    document.getElementById('mdPct').style.color      = st.color;
    document.getElementById('mdBar').style.width      = `${Math.min(pct,100)}%`;
    document.getElementById('mdBar').style.background = st.barColor;
    document.getElementById('mdType').textContent     = g.type || '—';
    document.getElementById('mdWeight').textContent   = w !== null ? `${w}% of final grade` : 'Not weighted';
    document.getElementById('mdDate').textContent     = g.date || '—';
    document.getElementById('mdTeacher').textContent  = tName;

    const notesEl = document.getElementById('mdNotes');
    if (g.notes) {
        notesEl.textContent = g.notes;
        notesEl.style.cssText = 'background:#eef2ff;border-left:3px solid #6366f1;padding:14px 16px;border-radius:0 8px 8px 0;font-size:13px;color:#1e293b;line-height:1.6;white-space:pre-wrap;font-weight:500;';
    } else {
        notesEl.textContent = 'No notes provided by the teacher.';
        notesEl.style.cssText = 'background:#f8fafc;border-left:3px solid #e2e8f0;padding:14px 16px;border-radius:0 8px 8px 0;font-size:13px;color:#94a3b8;font-style:italic;';
    }

    const histWrap = document.getElementById('mdHistoryWrap');
    const histEl   = document.getElementById('mdHistory');
    if (g.historyLogs?.length) {
        histWrap.classList.remove('hidden');
        histEl.innerHTML = g.historyLogs.map(log => `
            <div style="background:#fffbeb;border:1px solid #fde68a;padding:10px 14px;border-radius:8px;font-size:11.5px;color:#92400e;font-weight:600;line-height:1.5;">
                <i class="fa-solid fa-clock-rotate-left" style="margin-right:5px;"></i>
                ${typeof log === 'object'
                    ? `${log.changedAt} · Changed from ${log.oldScore} → ${log.newScore}${log.reason ? '. Reason: ' + escHtml(log.reason) : ''}`
                    : escHtml(String(log))}
            </div>`).join('');
    } else {
        histWrap.classList.add('hidden');
    }

    document.getElementById('assignmentModal').classList.remove('hidden');
};

window.closeAssignmentModal = function() {
    document.getElementById('assignmentModal').classList.add('hidden');
};

// Close modal on backdrop click
document.getElementById('assignmentModal').addEventListener('click', function(e) {
    if (e.target === this) window.closeAssignmentModal();
});

// ── INITIALIZE ────────────────────────────────────────────────────────────
document.addEventListener('DOMContentLoaded', loadGrades);
