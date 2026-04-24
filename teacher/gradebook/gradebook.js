import { db } from '../../assets/js/firebase-init.js';
import { collection, query, where, getDocs, getDoc, doc, updateDoc, deleteDoc } from "https://www.gstatic.com/firebasejs/10.7.1/firebase-firestore.js";
import { requireAuth } from '../../assets/js/auth.js';
import { injectTeacherLayout } from '../../assets/js/layout-teachers.js';
import { openOverlay, closeOverlay, showMsg, gradeColorClass, gradeFill, letterGrade, downloadCSV } from '../../assets/js/utils.js';

// ── 1. AUTH & LAYOUT ─────────────────────────────────────────────────────────
const session = requireAuth('teacher', '../login.html');
if (session) {
    injectTeacherLayout('gradebook', 'Gradebook', 'Complete grade record for the selected period', false);
}

// ── 2. STATE ─────────────────────────────────────────────────────────────────
let allStudentsCache = [];
let allGradesCache   = null;
let studentMap       = {};
let gradeDetailCache = {};
let rawSemesters     = [];
let isSemesterLocked = false;
let currentEditData  = null;
let originalScore    = null;
let originalMax      = null;

const DEFAULT_GRADE_TYPES = ['Test', 'Quiz', 'Assignment', 'Homework', 'Project', 'Midterm Exam', 'Final Exam'];
function getGradeTypes() { return session.teacherData.customGradeTypes || DEFAULT_GRADE_TYPES; }

// ── 3. INIT ───────────────────────────────────────────────────────────────────
async function init() {
    if (!session) return;

    // ── Sidebar teacher identity ──────────────────────────────────────────────
    document.getElementById('displayTeacherName').textContent = session.teacherData.name;
    document.getElementById('teacherAvatar').textContent      = session.teacherData.name.charAt(0).toUpperCase();
    document.getElementById('sidebarSchoolId').textContent    = session.schoolId;

    const classes = session.teacherData.classes || [session.teacherData.className || ''];
    document.getElementById('displayTeacherClasses').innerHTML =
        classes.filter(Boolean).map(c => `<span class="class-pill">${c}</span>`).join('');

    // ── Grade type filter ─────────────────────────────────────────────────────
    const typeSel = document.getElementById('gbFilterType');
    typeSel.innerHTML = '<option value="">All Types</option>' +
        getGradeTypes().map(t => `<option value="${t}">${t}</option>`).join('');

    document.getElementById('updateGradeBtn').addEventListener('click', saveEditedGrade);

    // Run semester load and student load in parallel
    await Promise.all([loadSemestersAndLockStatus(), loadStudents()]);
    await loadGradebook();
}

// ── 4. SEMESTERS (localStorage cached) ───────────────────────────────────────
async function loadSemestersAndLockStatus() {
    try {
        const cacheKey = `connectus_semesters_${session.schoolId}`;
        let rawSems    = [];

        const cached = localStorage.getItem(cacheKey);
        if (cached) {
            rawSems = JSON.parse(cached);
        } else {
            const semSnap = await getDocs(collection(db, 'schools', session.schoolId, 'semesters'));
            rawSems       = semSnap.docs
                .map(d => ({ id: d.id, ...d.data() }))
                .sort((a, b) => (a.order || 0) - (b.order || 0));
            localStorage.setItem(cacheKey, JSON.stringify(rawSems));
        }

        rawSemesters = rawSems;

        const schoolSnap = await getDoc(doc(db, 'schools', session.schoolId));
        const activeId   = schoolSnap.data()?.activeSemesterId || '';

        const semSel = document.getElementById('activeSemester');
        semSel.innerHTML = '';
        rawSemesters.forEach(s => {
            semSel.innerHTML += `<option value="${s.id}"${s.id === activeId ? ' selected' : ''}>${s.name}</option>`;
        });

        checkLockStatus();

        // ── Update sidebar period immediately ─────────────────────────────────
        const sbPeriod = document.getElementById('sb-period');
        if (sbPeriod) {
            sbPeriod.textContent = semSel.options[semSel.selectedIndex]?.text || '—';
        }

        semSel.addEventListener('change', () => {
            checkLockStatus();
            allGradesCache = null;
            loadGradebook();
            // Keep sidebar period in sync
            const sbP = document.getElementById('sb-period');
            if (sbP) sbP.textContent = semSel.options[semSel.selectedIndex]?.text || '—';
        });

    } catch (e) {
        console.error('[Gradebook] loadSemesters:', e);
    }
}

function checkLockStatus() {
    const semId     = document.getElementById('activeSemester').value;
    const activeSem = rawSemesters.find(s => s.id === semId);
    isSemesterLocked = activeSem ? !!activeSem.isLocked : false;

    const badge = document.getElementById('topbarLockedBadge');
    if (badge) {
        if (isSemesterLocked) {
            badge.classList.remove('hidden');
            badge.classList.add('flex');
        } else {
            badge.classList.add('hidden');
            badge.classList.remove('flex');
        }
    }
}

// ── 5. LOAD STUDENTS ──────────────────────────────────────────────────────────
async function loadStudents() {
    try {
        const stuQuery = query(
            collection(db, 'schools', session.schoolId, 'students'),
            where('archived',  '==', false),
            where('teacherId', '==', session.teacherId)
        );
        const stuSnap   = await getDocs(stuQuery);
        allStudentsCache = stuSnap.docs.map(d => ({ id: d.id, ...d.data() }));

        studentMap = {};
        allStudentsCache.forEach(s => { studentMap[s.id] = s.name; });

        // ── Sidebar student count ─────────────────────────────────────────────
        const sbStudents = document.getElementById('sb-students');
        if (sbStudents) sbStudents.textContent = allStudentsCache.length;

        // Student filter dropdown
        const gbSel = document.getElementById('gbFilterStudent');
        gbSel.innerHTML = '<option value="">All Students</option>';
        [...allStudentsCache]
            .sort((a, b) => a.name.localeCompare(b.name))
            .forEach(s => {
                gbSel.innerHTML += `<option value="${s.id}">${s.name}</option>`;
            });

    } catch (e) {
        console.error('[Gradebook] loadStudents:', e);
    }
}

// ── 6. GRADE CACHE ────────────────────────────────────────────────────────────
async function getAllGrades(semId) {
    if (allGradesCache && allGradesCache.semId === semId) return allGradesCache.grades;

    const all = [];
    await Promise.all(allStudentsCache.map(async s => {
        try {
            const q    = query(
                collection(db, 'schools', session.schoolId, 'students', s.id, 'grades'),
                where('semesterId', '==', semId)
            );
            const snap = await getDocs(q);
            snap.forEach(d => all.push({ id: d.id, studentId: s.id, studentName: s.name, ...d.data() }));
        } catch (e) { /* silent per-student failure */ }
    }));

    allGradesCache = { semId, grades: all };
    return all;
}

// ── 7. RENDER GRADEBOOK ───────────────────────────────────────────────────────
async function loadGradebook() {
    const tbody = document.getElementById('gradebookTableBody');
    tbody.innerHTML = `<tr><td colspan="8" style="padding:60px 20px;text-align:center;color:#9ab0c6;">
        <i class="fa-solid fa-spinner fa-spin" style="font-size:22px;color:#0ea871;display:block;margin-bottom:10px;"></i>
        <span style="font-size:13px;font-weight:400;">Loading gradebook…</span>
    </td></tr>`;

    const semId = document.getElementById('activeSemester').value;
    if (!allStudentsCache.length) await loadStudents();

    const grades = await getAllGrades(semId);

    // ── Sidebar at-risk count ──────────────────────────────────────────────────
    const stuG = {};
    grades.forEach(g => {
        if (!stuG[g.studentId]) stuG[g.studentId] = { total: 0, count: 0 };
        stuG[g.studentId].total += g.max ? (g.score / g.max) * 100 : 0;
        stuG[g.studentId].count++;
    });
    const riskCount = Object.values(stuG).filter(sg =>
        sg.count > 0 && Math.round(sg.total / sg.count) < 65
    ).length;

    const sbRisk = document.getElementById('sb-risk');
    if (sbRisk) {
        sbRisk.textContent = riskCount;
        sbRisk.classList.toggle('is-risk', riskCount > 0);
    }

    // Subject filter — populate from actual grades in this semester
    const subjSet = new Set(grades.map(g => g.subject || 'Uncategorized'));
    const subjSel = document.getElementById('gbFilterSubject');
    if (subjSel) {
        const prev = subjSel.value;
        subjSel.innerHTML = '<option value="">All Subjects</option>';
        [...subjSet].sort().forEach(s => {
            subjSel.innerHTML += `<option${s === prev ? ' selected' : ''}>${s}</option>`;
        });
    }

    renderGradebook();
}

function renderGradebook() {
    const tbody = document.getElementById('gradebookTableBody');

    const fs    = document.getElementById('gbFilterStudent')?.value  || '';
    const fsub  = document.getElementById('gbFilterSubject')?.value  || '';
    const ftype = document.getElementById('gbFilterType')?.value     || '';
    const fText = (document.getElementById('gbSearchInput')?.value   || '').toLowerCase();

    let rows = allGradesCache?.grades || [];
    if (fs)    rows = rows.filter(g => g.studentId === fs);
    if (fsub)  rows = rows.filter(g => g.subject   === fsub);
    if (ftype) rows = rows.filter(g => g.type      === ftype);
    if (fText) rows = rows.filter(g => (g.title    || '').toLowerCase().includes(fText));

    // ── Record count badge ────────────────────────────────────────────────────
    const countBadge = document.getElementById('gbRecordCount');
    if (countBadge) {
        countBadge.innerHTML = `<div class="gb-count-dot"></div><span>${rows.length} record${rows.length !== 1 ? 's' : ''}</span>`;
    }

    // ── Summary stats (whole dataset, not just filtered rows) ─────────────────
    const allRows  = allGradesCache?.grades || [];
    const allPcts  = allRows.map(g => g.max ? Math.round(g.score / g.max * 100) : 0);
    const classAvg = allPcts.length ? Math.round(allPcts.reduce((a, b) => a + b, 0) / allPcts.length) : null;

    const totalEl = document.getElementById('gbStatTotal');
    if (totalEl) totalEl.textContent = allRows.length || '—';

    const avgEl = document.getElementById('gbStatAvg');
    if (avgEl) avgEl.textContent = classAvg !== null ? classAvg + '%' : '—';

    // At-risk stat (students with avg < 65%)
    const stuG = {};
    allRows.forEach(g => {
        if (!stuG[g.studentId]) stuG[g.studentId] = { total: 0, count: 0 };
        stuG[g.studentId].total += g.max ? (g.score / g.max) * 100 : 0;
        stuG[g.studentId].count++;
    });
    const riskStat = Object.values(stuG).filter(sg => sg.count > 0 && Math.round(sg.total / sg.count) < 65).length;
    const riskEl   = document.getElementById('gbStatRisk');
    if (riskEl) {
        riskEl.textContent  = riskStat || '0';
        riskEl.style.color  = riskStat > 0 ? '#e31b4a' : '#0d1f35';
    }

    // ── Grade distribution bar ────────────────────────────────────────────────
    const dist   = { a: 0, b: 0, c: 0, d: 0, f: 0 };
    allPcts.forEach(p => {
        if (p >= 90) dist.a++;
        else if (p >= 80) dist.b++;
        else if (p >= 70) dist.c++;
        else if (p >= 65) dist.d++;
        else dist.f++;
    });
    const total  = allPcts.length || 1;
    const distBar = document.getElementById('gbDistBar');
    if (distBar) {
        distBar.innerHTML = [
            dist.a ? `<div class="dist-seg" style="width:${dist.a/total*100}%;background:#10b981;"></div>` : '',
            dist.b ? `<div class="dist-seg" style="width:${dist.b/total*100}%;background:#3b82f6;"></div>` : '',
            dist.c ? `<div class="dist-seg" style="width:${dist.c/total*100}%;background:#14b8a6;"></div>` : '',
            dist.d ? `<div class="dist-seg" style="width:${dist.d/total*100}%;background:#f59e0b;"></div>` : '',
            dist.f ? `<div class="dist-seg" style="width:${dist.f/total*100}%;background:#ef4444;"></div>` : '',
            !allPcts.length ? `<div style="width:100%;background:#f0f4f8;height:10px;"></div>` : ''
        ].join('');
    }
    const legendEl = document.getElementById('gbDistLegend');
    if (legendEl) {
        legendEl.innerHTML = [
            ['A', dist.a, '#10b981'], ['B', dist.b, '#3b82f6'],
            ['C', dist.c, '#14b8a6'], ['D', dist.d, '#f59e0b'], ['F', dist.f, '#ef4444']
        ].map(([l, n, c]) => `
            <div class="dist-legend-item">
                <div class="dist-dot" style="background:${c};"></div>
                ${l}: ${n}
            </div>`).join('');
    }

    // ── Period badge in table header ──────────────────────────────────────────
    const semSel      = document.getElementById('activeSemester');
    const periodBadge = document.getElementById('gbPeriodBadge');
    if (periodBadge && semSel) {
        periodBadge.textContent = semSel.options[semSel.selectedIndex]?.text || '—';
    }

    // ── Locked indicator ──────────────────────────────────────────────────────
    const lockedBar = document.getElementById('gbLockedBar');
    if (lockedBar) lockedBar.classList.toggle('hidden', !isSemesterLocked);

    // ── Empty state ───────────────────────────────────────────────────────────
    if (!rows.length) {
        tbody.innerHTML = `<tr><td colspan="8">
            <div class="gb-empty">
                <i class="fa-solid fa-folder-open"></i>
                <p>No grades found for the selected filters.</p>
            </div>
        </td></tr>`;
        return;
    }

    gradeDetailCache = {};

    // ── Build table rows ──────────────────────────────────────────────────────
    tbody.innerHTML = rows
        .sort((a, b) => (b.date || '').localeCompare(a.date || ''))
        .map((g, idx) => {
            gradeDetailCache[g.id] = g;

            const pct    = g.max ? Math.round(g.score / g.max * 100) : null;
            const letter = pct !== null ? letterGrade(pct) : '—';

            // Grade badge class
            const badgeCls = pct >= 90 ? 'gg-a' : pct >= 80 ? 'gg-b' : pct >= 70 ? 'gg-c' : pct >= 65 ? 'gg-d' : 'gg-f';
            // Bar fill colour
            const barColor = pct >= 90 ? '#10b981' : pct >= 80 ? '#3b82f6' : pct >= 70 ? '#14b8a6' : pct >= 65 ? '#f59e0b' : '#ef4444';

            const initial = (g.studentName || '?').charAt(0).toUpperCase();

            const actionBtns = isSemesterLocked
                ? `<span style="font-size:10px;color:#9ab0c6;font-weight:700;letter-spacing:0.06em;"><i class="fa-solid fa-lock"></i></span>`
                : `<button onclick="openEditGradeModal('${g.studentId}','${g.id}')" class="gb-row-btn gb-btn-edit" title="Edit Grade">
                       <i class="fa-solid fa-pen"></i>
                   </button>
                   <button onclick="deleteGrade('${g.studentId}','${g.id}')" class="gb-row-btn gb-btn-delete" title="Delete Grade">
                       <i class="fa-solid fa-trash-can"></i>
                   </button>`;

            return `<tr class="gb-row">
                <td style="color:#9ab0c6;font-size:11px;font-family:'DM Mono',monospace;width:36px;">
                    ${String(idx + 1).padStart(2, '0')}
                </td>
                <td>
                    <div class="gb-student-cell">
                        <div class="gb-student-initial">${initial}</div>
                        <span class="gb-student-name">${escHtml(g.studentName || 'Unknown')}</span>
                    </div>
                </td>
                <td>
                    <span class="gb-subject-badge">${escHtml(g.subject || '—')}</span>
                </td>
                <td>
                    <p class="gb-assignment-title">${escHtml(g.title || '—')}</p>
                    <p class="gb-assignment-date">${g.date || ''}</p>
                </td>
                <td>
                    <span class="gb-type-badge">${escHtml(g.type || '—')}</span>
                </td>
                <td class="tc">
                    <span class="gb-score">${g.score}<span style="color:#9ab0c6;"> / ${g.max || '?'}</span></span>
                </td>
                <td class="tc">
                    <div class="gb-grade-wrap">
                        <span class="gb-grade-badge ${badgeCls}">${pct !== null ? pct + '%' : '—'} · ${letter}</span>
                        <div class="gb-grade-bar-bg">
                            <div class="gb-grade-bar-fill" style="width:${Math.min(pct || 0, 100)}%;background:${barColor};"></div>
                        </div>
                    </div>
                </td>
                <td class="tr">
                    <div style="display:flex;align-items:center;justify-content:flex-end;gap:5px;">
                        <button onclick="openAssignmentModal('${g.id}')" class="gb-row-btn gb-btn-view" title="View Detail">
                            <i class="fa-solid fa-eye"></i>
                        </button>
                        ${actionBtns}
                    </div>
                </td>
            </tr>`;
        }).join('');
}

window.applyGradebookFilters = function () { renderGradebook(); };

// ── 8. VIEW ASSIGNMENT MODAL ──────────────────────────────────────────────────
window.openAssignmentModal = function (gradeId) {
    const g = gradeDetailCache[gradeId];
    if (!g) return;

    const pct   = g.max ? Math.round(g.score / g.max * 100) : null;
    const fill  = gradeFill(pct || 0);
    const color = pct >= 90 ? 'text-emerald-600' : pct >= 80 ? 'text-blue-600' : pct >= 70 ? 'text-teal-600' : pct >= 65 ? 'text-amber-600' : 'text-red-600';

    document.getElementById('aModalTitle').textContent = g.title || 'Assessment';

    let histHTML = '';
    if (g.historyLogs?.length) {
        histHTML = `<div class="bg-amber-50 border border-amber-200 rounded-xl p-4">
            <p class="text-xs font-black text-amber-600 uppercase tracking-wider mb-2">
                <i class="fa-solid fa-clock-rotate-left mr-1"></i>Edit History (${g.historyLogs.length})
            </p>
            <div class="space-y-2 max-h-32 overflow-y-auto">
                ${g.historyLogs.map(l => `
                <div class="text-xs text-amber-800 font-semibold bg-white rounded-lg p-2 border border-amber-100">
                    <i class="fa-solid fa-circle-dot mr-1 text-amber-400"></i>
                    ${typeof l === 'object'
                        ? `[${l.changedAt}] ${l.oldScore}/${l.oldMax} → ${l.newScore}/${l.newMax}. Reason: ${l.reason}`
                        : l}
                </div>`).join('')}
            </div>
        </div>`;
    }

    document.getElementById('aModalBody').innerHTML = `
        <div class="text-center mb-5">
            <div class="${color} text-5xl font-black">${g.score}<span class="text-2xl text-slate-400">/${g.max || '?'}</span></div>
            ${pct !== null ? `
            <div class="flex items-center justify-center gap-3 mt-2">
                <span class="${color} text-xl font-black">${pct}%</span>
                <span class="${color} font-black px-3 py-1 rounded-xl text-lg border ${pct >= 90 ? 'bg-emerald-50 border-emerald-200' : pct >= 80 ? 'bg-blue-50 border-blue-200' : pct >= 70 ? 'bg-teal-50 border-teal-200' : pct >= 65 ? 'bg-amber-50 border-amber-200' : 'bg-red-50 border-red-200'}">
                    ${letterGrade(pct)}
                </span>
            </div>` : ''}
            <div class="mt-3 h-3 bg-slate-100 rounded-full overflow-hidden mx-4">
                <div class="h-full rounded-full" style="width:${pct || 0}%;background:${fill};transition:width 0.5s ease"></div>
            </div>
        </div>
        <div class="space-y-2 text-sm mb-4">
            ${[['Subject', g.subject || '—'], ['Type', g.type || '—'], ['Date', g.date || '—']].map(([l, v]) =>
                `<div class="flex justify-between py-2 border-b border-slate-100">
                    <span class="text-slate-400 font-black uppercase text-xs tracking-wider">${l}</span>
                    <span class="font-black text-slate-700">${v}</span>
                </div>`).join('')}
        </div>
        ${g.notes ? `<div class="bg-blue-50 border border-blue-100 rounded-xl p-4 mb-3">
            <p class="text-xs font-black text-blue-500 uppercase tracking-wider mb-1">Teacher Notes</p>
            <p class="text-sm text-slate-700 font-semibold whitespace-pre-wrap">${g.notes}</p>
        </div>` : ''}
        ${histHTML}`;

    openOverlay('assignmentModal', 'assignmentModalInner');
};
window.closeAssignmentModal = function () { closeOverlay('assignmentModal', 'assignmentModalInner'); };

// ── 9. EDIT GRADE MODAL ───────────────────────────────────────────────────────
window.openEditGradeModal = async function (studentId, gradeId) {
    if (isSemesterLocked) return;

    try {
        const snap = await getDoc(doc(db, 'schools', session.schoolId, 'students', studentId, 'grades', gradeId));
        if (!snap.exists()) return;

        currentEditData = { studentId, gradeId, ...snap.data() };
        originalScore   = currentEditData.score;
        originalMax     = currentEditData.max;

        document.getElementById('editGradeContext').textContent =
            `${studentMap[studentId] || 'Student'} · ${currentEditData.subject || ''} · ${currentEditData.title || ''}`;

        const oldNotesEl = document.getElementById('ed-old-notes');
        if (currentEditData.notes) {
            oldNotesEl.textContent = currentEditData.notes;
            oldNotesEl.parentElement.classList.remove('hidden');
        } else {
            oldNotesEl.parentElement.classList.add('hidden');
        }

        document.getElementById('ed-new-notes').value = '';
        document.getElementById('ed-score').value     = currentEditData.score;
        document.getElementById('ed-max').value       = currentEditData.max;
        document.getElementById('ed-reason').value    = '';
        document.getElementById('reasonSection').classList.remove('visible');
        document.getElementById('editGradeMsg').classList.add('hidden');

        openOverlay('editGradeModal', 'editGradeModalInner');
    } catch (e) {
        console.error('[Gradebook] openEditGradeModal:', e);
        alert('Error loading grade details.');
    }
};

window.closeEditGradeModal = function () { closeOverlay('editGradeModal', 'editGradeModalInner'); };

window.checkScoreChange = function () {
    const s = parseFloat(document.getElementById('ed-score')?.value);
    const m = parseFloat(document.getElementById('ed-max')?.value);
    document.getElementById('reasonSection').classList.toggle('visible', s !== originalScore || m !== originalMax);
};

async function saveEditedGrade() {
    const nScore       = parseFloat(document.getElementById('ed-score').value);
    const nMax         = parseFloat(document.getElementById('ed-max').value);
    const appendedNote = document.getElementById('ed-new-notes').value.trim();
    const scoreChanged = (nScore !== originalScore || nMax !== originalMax);

    if (scoreChanged) {
        const reason = document.getElementById('ed-reason').value.trim();
        if (!reason) {
            alert('A reason is required when changing the score to preserve auditing trails.');
            document.getElementById('ed-reason').focus();
            return;
        }
    }

    const btn = document.getElementById('updateGradeBtn');
    btn.innerHTML = `<i class="fa-solid fa-spinner fa-spin"></i> Saving…`;
    btn.disabled  = true;

    try {
        let finalNotes = currentEditData.notes || '';
        if (appendedNote) {
            const ts = `[${new Date().toLocaleDateString()}] ${appendedNote}`;
            finalNotes = finalNotes ? `${ts}\n\n${finalNotes}` : ts;
        }

        const updates = { notes: finalNotes, score: nScore, max: nMax };

        if (scoreChanged) {
            const reason = document.getElementById('ed-reason').value.trim();
            updates.historyLogs = [
                ...(currentEditData.historyLogs || []),
                { changedAt: new Date().toLocaleString(), oldScore: originalScore, oldMax: originalMax, newScore: nScore, newMax: nMax, reason }
            ];
        }

        await updateDoc(
            doc(db, 'schools', session.schoolId, 'students', currentEditData.studentId, 'grades', currentEditData.gradeId),
            updates
        );

        closeEditGradeModal();
        allGradesCache = null;
        loadGradebook();
    } catch (e) {
        console.error('[Gradebook] saveEditedGrade:', e);
        showMsg('editGradeMsg', 'Error saving changes.', true);
    }

    btn.innerHTML = `<i class="fa-solid fa-floppy-disk"></i> Save Changes`;
    btn.disabled  = false;
}

// ── 10. DELETE GRADE ──────────────────────────────────────────────────────────
window.deleteGrade = async function (studentId, gradeId) {
    if (isSemesterLocked) return;
    if (!confirm('Are you sure you want to permanently delete this grade?')) return;

    try {
        await deleteDoc(doc(db, 'schools', session.schoolId, 'students', studentId, 'grades', gradeId));
        allGradesCache = null;
        loadGradebook();
    } catch (e) {
        console.error('[Gradebook] deleteGrade:', e);
        alert('Failed to delete grade.');
    }
};

// ── 11. EXPORT & PRINT ────────────────────────────────────────────────────────
function getFilteredRows() {
    const fs    = document.getElementById('gbFilterStudent')?.value  || '';
    const fsub  = document.getElementById('gbFilterSubject')?.value  || '';
    const ftype = document.getElementById('gbFilterType')?.value     || '';
    const fText = (document.getElementById('gbSearchInput')?.value   || '').toLowerCase();

    let rows = allGradesCache?.grades || [];
    if (fs)    rows = rows.filter(g => g.studentId === fs);
    if (fsub)  rows = rows.filter(g => g.subject   === fsub);
    if (ftype) rows = rows.filter(g => g.type      === ftype);
    if (fText) rows = rows.filter(g => (g.title    || '').toLowerCase().includes(fText));
    return rows;
}

window.exportGradebookCSV = function () {
    const rows = getFilteredRows();
    downloadCSV([
        ['Student', 'Subject', 'Assignment', 'Type', 'Date', 'Score', 'Max', '%', 'Letter', 'Notes'],
        ...rows.map(g => {
            const p = g.max ? Math.round(g.score / g.max * 100) : null;
            return [g.studentName, g.subject || '', g.title || '', g.type || '', g.date || '',
                    g.score, g.max || '', p !== null ? p + '%' : '', p !== null ? letterGrade(p) : '', g.notes || ''];
        })
    ], `${session.schoolId}_gradebook.csv`);
};

window.printGradebook = function () {
    const rows    = getFilteredRows().sort((a, b) => (b.date || '').localeCompare(a.date || ''));
    const semName = document.getElementById('activeSemester')?.options[
        document.getElementById('activeSemester')?.selectedIndex
    ]?.text || '';

    const w = window.open('', '_blank');
    w.document.write(`<!DOCTYPE html><html><head>
    <meta charset="UTF-8">
    <title>Gradebook — ${session.teacherData.name}</title>
    <style>
        @import url('https://fonts.googleapis.com/css2?family=DM+Sans:wght@400;600;700&family=DM+Mono:wght@400&display=swap');
        * { box-sizing: border-box; margin: 0; padding: 0; }
        body { font-family: 'DM Sans', sans-serif; padding: 40px 48px; color: #0d1f35; }
        .header { display: flex; flex-direction: column; align-items: center; margin-bottom: 28px; padding-bottom: 20px; border-bottom: 2px solid #0d1f35; }
        .logo { max-height: 44px; max-width: 160px; object-fit: contain; margin-bottom: 10px; }
        .doc-title { font-size: 16px; font-weight: 700; margin-bottom: 4px; }
        .doc-meta { font-size: 11px; color: #6b84a0; }
        table { width: 100%; border-collapse: collapse; font-size: 12px; }
        th { padding: 9px 12px; background: #0d1f35; color: #fff; font-size: 9px; font-weight: 700; text-transform: uppercase; letter-spacing: 0.1em; text-align: left; }
        td { padding: 9px 12px; border-bottom: 1px solid #e8edf2; }
        tr:nth-child(even) td { background: #f8fafb; }
        .hi { color: #065f46; font-weight: 700; } .mid { color: #78350f; font-weight: 700; } .lo { color: #7f1d1d; font-weight: 700; }
        .mono { font-family: 'DM Mono', monospace; }
        .footer { margin-top: 32px; padding-top: 10px; border-top: 1px solid #e8edf2; font-size: 10px; color: #9ab0c6; font-style: italic; text-align: center; }
    </style>
    </head><body>
    <div class="header">
        <img src="../../assets/images/logo.png" alt="ConnectUs" class="logo" onerror="this.style.display='none'">
        <p class="doc-title">Class Gradebook</p>
        <p class="doc-meta">
            ${session.teacherData.name} &nbsp;·&nbsp; ${semName} &nbsp;·&nbsp;
            ${rows.length} records &nbsp;·&nbsp;
            Printed ${new Date().toLocaleDateString('en-US', { year: 'numeric', month: 'long', day: 'numeric' })}
        </p>
    </div>
    <table>
        <thead>
            <tr>
                <th>Student</th><th>Subject</th><th>Assignment</th>
                <th>Type</th><th>Date</th><th>Score</th><th>%</th><th>Grade</th>
            </tr>
        </thead>
        <tbody>
            ${rows.map(g => {
                const p   = g.max ? Math.round(g.score / g.max * 100) : null;
                const cls = p >= 75 ? 'hi' : p >= 65 ? 'mid' : 'lo';
                return `<tr>
                    <td><strong>${g.studentName}</strong></td>
                    <td>${g.subject || '—'}</td>
                    <td>${g.title || '—'}</td>
                    <td>${g.type || '—'}</td>
                    <td>${g.date || '—'}</td>
                    <td class="mono">${g.score}/${g.max || '?'}</td>
                    <td class="mono ${cls}">${p !== null ? p + '%' : '—'}</td>
                    <td class="${cls}">${p !== null ? letterGrade(p) : '—'}</td>
                </tr>`;
            }).join('')}
        </tbody>
    </table>
    <div class="footer">This document is automatically generated by ConnectUs · School ID: ${session.schoolId}</div>
    </body></html>`);

    w.document.close();
    setTimeout(() => w.print(), 600);
};

// ── XSS PROTECTION ───────────────────────────────────────────────────────────
function escHtml(str) {
    if (!str) return '';
    return String(str)
        .replace(/&/g, '&amp;').replace(/</g, '&lt;')
        .replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}

// ── FIRE ──────────────────────────────────────────────────────────────────────
init();
