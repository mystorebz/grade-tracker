import { db } from '../../assets/js/firebase-init.js';
import { collection, query, where, getDocs, getDoc, doc, updateDoc } from "https://www.gstatic.com/firebasejs/10.7.1/firebase-firestore.js";
import { requireAuth } from '../../assets/js/auth.js';
import { injectTeacherLayout } from '../../assets/js/layout-teachers.js';
import { openOverlay, closeOverlay, showMsg, gradeColorClass, letterGrade, standingBadge, gradeFill } from '../../assets/js/utils.js';

// ── 1. AUTHENTICATION & LAYOUT ──────────────────────────────────────────────
const session = requireAuth('teacher', '../login.html');
if (session) {
    injectTeacherLayout('subjects', 'Subjects Overview', 'Performance by subject for the active period', false);
}

// ── 2. STATE VARIABLES ──────────────────────────────────────────────────────
let allStudentsCache = [];
let studentMap = {};
let allGradesCache = null;
let cachedSubjectGrades = [];
let rawSemesters = [];
let isSemesterLocked = false;
let currentSubjectName = null;
let gradeDetailCache = {};

const DEFAULT_GRADE_TYPES = ['Test', 'Quiz', 'Assignment', 'Homework', 'Project', 'Midterm Exam', 'Final Exam'];

function getActiveSubjects() { return (session.teacherData.subjects || []).filter(s => !s.archived); }
function getGradeTypes() { return session.teacherData.customGradeTypes || DEFAULT_GRADE_TYPES; }
function genId() { return 'sub_' + Date.now().toString(36) + '_' + Math.random().toString(36).slice(2, 5); }

// ── 3. INITIALIZATION ───────────────────────────────────────────────────────
async function init() {
    if (!session) return;

    document.getElementById('displayTeacherName').textContent = session.teacherData.name;
    document.getElementById('teacherAvatar').textContent = session.teacherData.name.charAt(0).toUpperCase();
    document.getElementById('sidebarSchoolId').textContent = session.schoolId;

    const classes = session.teacherData.classes || [session.teacherData.className || ''];
    document.getElementById('displayTeacherClasses').innerHTML = classes.map(c => `<span class="class-pill">${c}</span>`).join('');

    document.getElementById('saveSubjectFormBtn').addEventListener('click', saveSubject);

    await loadSemestersAndLockStatus();
    await loadStudents();
    await loadSubjectsTab();
}

async function loadSemestersAndLockStatus() {
    try {
        const semSnap = await getDocs(collection(db, 'schools', session.schoolId, 'semesters'));
        const schoolSnap = await getDoc(doc(db, 'schools', session.schoolId));
        const activeId = schoolSnap.data()?.activeSemesterId || '';

        rawSemesters = semSnap.docs.map(d => ({ id: d.id, ...d.data() })).sort((a, b) => (a.order || 0) - (b.order || 0));

        const semSel = document.getElementById('activeSemester');
        semSel.innerHTML = '';
        rawSemesters.forEach(s => {
            semSel.innerHTML += `<option value="${s.id}"${s.id === activeId ? ' selected' : ''}>${s.name}</option>`;
        });

        checkLockStatus();

        semSel.addEventListener('change', () => {
            checkLockStatus();
            allGradesCache = null; // Clear cache on semester change
            loadSubjectsTab();
        });
    } catch (e) {
        console.error("Error loading semesters:", e);
    }
}

function checkLockStatus() {
    const semId = document.getElementById('activeSemester').value;
    const activeSem = rawSemesters.find(s => s.id === semId);
    isSemesterLocked = activeSem ? !!activeSem.isLocked : false;
    
    const badge = document.getElementById('topbarLockedBadge');
    if (badge) {
        isSemesterLocked ? badge.classList.remove('hidden') : badge.classList.add('hidden');
        isSemesterLocked ? badge.classList.add('flex') : badge.classList.remove('flex');
    }
}

async function loadStudents() {
    try {
        const stuQuery = query(collection(db, 'schools', session.schoolId, 'students'), where('archived', '==', false), where('teacherId', '==', session.teacherId));
        const stuSnap = await getDocs(stuQuery);
        allStudentsCache = stuSnap.docs.map(d => ({ id: d.id, ...d.data() }));
        studentMap = {};
        allStudentsCache.forEach(s => { studentMap[s.id] = s.name; });
        
        // Update Sidebar Stat
        const sbStudents = document.getElementById('sb-students');
        if (sbStudents) sbStudents.textContent = allStudentsCache.length;
    } catch (e) { console.error("Error loading students:", e); }
}

async function getAllGrades(semId) {
    if (allGradesCache && allGradesCache.semId === semId) return allGradesCache.grades;
    const all = [];
    await Promise.all(allStudentsCache.map(async s => {
        try {
            const q = query(collection(db, 'schools', session.schoolId, 'students', s.id, 'grades'), where('semesterId', '==', semId));
            const snap = await getDocs(q);
            snap.forEach(d => all.push({ id: d.id, studentId: s.id, studentName: s.name, ...d.data() }));
        } catch (e) { }
    }));
    allGradesCache = { semId, grades: all };
    return all;
}

// ── 4. RENDER MAIN SUBJECTS TABLE ───────────────────────────────────────────
async function loadSubjectsTab() {
    const tbody = document.getElementById('subjectsTableBody');
    tbody.innerHTML = `<tr><td colspan="9" class="px-6 py-16 text-center text-slate-400 font-semibold"><i class="fa-solid fa-spinner fa-spin text-teal-400 text-2xl mb-3 block"></i>Loading subjects...</td></tr>`;
    
    const semId = document.getElementById('activeSemester').value;
    const semName = document.getElementById('activeSemester').options[document.getElementById('activeSemester').selectedIndex]?.text || '—';
    
    const sbPeriod = document.getElementById('sb-period');
    if (sbPeriod) sbPeriod.textContent = semName;

    const allGrades = await getAllGrades(semId);
    const active = getActiveSubjects();
    
    if (!active.length) {
        tbody.innerHTML = `<tr><td colspan="9" class="px-6 py-16 text-center text-slate-400 italic font-semibold">No active subjects. Add subjects using the button above.</td></tr>`;
        return;
    }

    tbody.innerHTML = active.map(sub => {
        const sg = allGrades.filter(g => g.subject === sub.name);
        const stuIds = [...new Set(sg.map(g => g.studentId))];
        const stuAvgs = stuIds.map(sid => {
            const sg2 = sg.filter(g => g.studentId === sid);
            return sg2.reduce((a, g) => a + (g.max ? g.score / g.max * 100 : 0), 0) / sg2.length;
        });
        
        const classAvg = stuAvgs.length ? Math.round(stuAvgs.reduce((a, b) => a + b, 0) / stuAvgs.length) : null;
        const allPcts = sg.map(g => g.max ? Math.round(g.score / g.max * 100) : 0);
        const highest = allPcts.length ? Math.max(...allPcts) : null;
        const lowest = allPcts.length ? Math.min(...allPcts) : null;
        const atRisk = stuAvgs.filter(a => a < 65).length;
        const lastGraded = sg.length ? sg.sort((a, b) => (b.date || '').localeCompare(a.date || ''))[0].date : null;
        
        return `<tr class="gb-row">
            <td class="px-6 py-4">
                <div class="flex items-center gap-3">
                    <div class="w-9 h-9 bg-gradient-to-br from-teal-500 to-emerald-600 text-white rounded-xl flex items-center justify-center font-black text-sm shadow-sm">${sub.name.charAt(0)}</div>
                    <div>
                        <p class="font-black text-slate-700">${sub.name}</p>
                        ${sub.description ? `<p class="text-xs text-slate-400 font-semibold">${sub.description}</p>` : ''}
                    </div>
                </div>
            </td>
            <td class="px-6 py-4 text-center"><span class="bg-teal-50 text-teal-700 font-black text-sm px-3 py-1 rounded-lg border border-teal-200">${stuIds.length}</span></td>
            <td class="px-6 py-4 text-center"><span class="bg-slate-100 text-slate-600 font-bold text-xs px-3 py-1 rounded-lg border border-slate-200">${sg.length}</span></td>
            <td class="px-6 py-4 text-center">${classAvg !== null ? `<span class="${gradeColorClass(classAvg)} font-black">${classAvg}% · ${letterGrade(classAvg)}</span>` : '<span class="text-slate-400">—</span>'}</td>
            <td class="px-6 py-4 text-center">${highest !== null ? `<span class="g-a font-black">${highest}%</span>` : '<span class="text-slate-400">—</span>'}</td>
            <td class="px-6 py-4 text-center">${lowest !== null ? `<span class="${gradeColorClass(lowest)} font-black">${lowest}%</span>` : '<span class="text-slate-400">—</span>'}</td>
            <td class="px-6 py-4 text-center">${atRisk ? `<span class="font-black text-red-600 bg-red-50 border border-red-200 px-2 py-0.5 rounded-lg text-xs">${atRisk}</span>` : '<span class="text-slate-400 font-semibold">0</span>'}</td>
            <td class="px-6 py-4 text-slate-500 font-semibold text-xs">${lastGraded || '—'}</td>
            <td class="px-6 py-4 text-right">
                <button onclick="openSubjectPanel('${sub.name.replace(/'/g, '\\\'')}')" class="bg-teal-50 hover:bg-teal-600 hover:text-white text-teal-700 font-black px-4 py-2 rounded-lg text-xs transition border border-teal-200 hover:border-teal-600">View</button>
            </td>
        </tr>`;
    }).join('');
}

// ── 5. SUBJECT PANEL (SLIDE OUT) ────────────────────────────────────────────
window.openSubjectPanel = async function(subjectName) {
    currentSubjectName = subjectName;
    document.getElementById('spPanelTitle').textContent = subjectName;
    document.getElementById('subjectPanelBody').innerHTML = '<div class="flex justify-center py-16"><i class="fa-solid fa-circle-notch fa-spin text-3xl text-teal-500"></i></div>';
    document.getElementById('spFilterStudent').value = '';
    document.getElementById('spFilterType').value = '';
    
    // Populate Type Filter
    const spType = document.getElementById('spFilterType');
    spType.innerHTML = '<option value="">All Types</option>' + getGradeTypes().map(t => `<option value="${t}">${t}</option>`).join('');
    
    openOverlay('subjectPanel', 'subjectPanelInner', true);
    
    const quickGradeBtn = document.getElementById('spQuickGradeBtn');
    if (isSemesterLocked) {
        quickGradeBtn.classList.add('hidden');
    } else {
        quickGradeBtn.classList.remove('hidden');
        quickGradeBtn.onclick = () => {
            // Optional: You could pass the subject via sessionStorage here to prefill it on grade_form
            window.location.href = '../grade_form/grade_form.html';
        };
    }
    
    const semId = document.getElementById('activeSemester').value;
    const semName = document.getElementById('activeSemester').options[document.getElementById('activeSemester').selectedIndex]?.text || '';
    document.getElementById('spPanelMeta').textContent = `${semName} · Loading...`;
    
    const allGrades = await getAllGrades(semId);
    cachedSubjectGrades = allGrades.filter(g => g.subject === subjectName);
    
    const spStuFilter = document.getElementById('spFilterStudent');
    const stuIdsInSubj = [...new Set(cachedSubjectGrades.map(g => g.studentId))];
    spStuFilter.innerHTML = '<option value="">All Students</option>' + stuIdsInSubj.map(sid => `<option value="${sid}">${studentMap[sid] || 'Unknown'}</option>`).join('');
    
    renderSubjectPanelData();
};

window.renderSubjectPanelData = function() {
    const fStudent = document.getElementById('spFilterStudent').value;
    const fType = document.getElementById('spFilterType').value;
    
    let sg = cachedSubjectGrades;
    if (fStudent) sg = sg.filter(g => g.studentId === fStudent);
    if (fType) sg = sg.filter(g => g.type === fType);
    
    const stuIds = [...new Set(sg.map(g => g.studentId))];
    const stuData = stuIds.map(sid => {
        const sg2 = sg.filter(g => g.studentId === sid);
        const avg = sg2.reduce((a, g) => a + (g.max ? g.score / g.max * 100 : 0), 0) / sg2.length;
        return { sid, name: studentMap[sid] || 'Unknown', avg: Math.round(avg), count: sg2.length };
    }).sort((a, b) => a.avg - b.avg);
    
    const dist = { a: 0, b: 0, c: 0, d: 0, f: 0 };
    stuData.forEach(s => {
        if (s.avg >= 90) dist.a++; else if (s.avg >= 80) dist.b++; else if (s.avg >= 70) dist.c++; else if (s.avg >= 65) dist.d++; else dist.f++;
    });
    
    const total = stuData.length || 1;
    const classAvg = stuData.length ? Math.round(stuData.reduce((a, s) => a + s.avg, 0) / stuData.length) : null;
    const atRiskStudents = stuData.filter(s => s.avg < 65);
    
    const semName = document.getElementById('activeSemester').options[document.getElementById('activeSemester').selectedIndex]?.text || '';
    document.getElementById('spPanelMeta').textContent = `${semName} · ${stuIds.length} students`;
    
    gradeDetailCache = {};
    sg.forEach(g => { gradeDetailCache[g.id] = g; });
    
    document.getElementById('subjectPanelBody').innerHTML = `
        <div class="grid grid-cols-3 gap-3">
            <div class="bg-white border border-slate-200 rounded-2xl p-4 text-center shadow-sm">
                <p class="text-xs font-black text-slate-400 uppercase tracking-wider mb-1">Avg</p>
                <p class="text-3xl font-black ${classAvg !== null ? gradeColorClass(classAvg) : 'text-slate-400'}">${classAvg !== null ? classAvg + '%' : '—'}</p>
            </div>
            <div class="bg-white border border-slate-200 rounded-2xl p-4 text-center shadow-sm">
                <p class="text-xs font-black text-slate-400 uppercase tracking-wider mb-1">Students</p>
                <p class="text-3xl font-black text-teal-600">${stuIds.length}</p>
            </div>
            <div class="bg-white border border-slate-200 rounded-2xl p-4 text-center shadow-sm">
                <p class="text-xs font-black text-slate-400 uppercase tracking-wider mb-1">At Risk</p>
                <p class="text-3xl font-black ${atRiskStudents.length ? 'text-red-600' : 'text-emerald-600'}">${atRiskStudents.length}</p>
            </div>
        </div>
        
        <div class="bg-white border border-slate-200 rounded-2xl p-5 shadow-sm">
            <h4 class="text-xs font-black text-slate-500 uppercase tracking-wider mb-3">Grade Distribution</h4>
            <div class="dist-bar">
                ${dist.a ? `<div class="dist-seg bg-emerald-500" style="width:${dist.a / total * 100}%">A:${dist.a}</div>` : ''}
                ${dist.b ? `<div class="dist-seg bg-blue-500" style="width:${dist.b / total * 100}%">B:${dist.b}</div>` : ''}
                ${dist.c ? `<div class="dist-seg bg-teal-500" style="width:${dist.c / total * 100}%">C:${dist.c}</div>` : ''}
                ${dist.d ? `<div class="dist-seg bg-amber-500" style="width:${dist.d / total * 100}%">D:${dist.d}</div>` : ''}
                ${dist.f ? `<div class="dist-seg bg-red-500" style="width:${dist.f / total * 100}%">F:${dist.f}</div>` : ''}
                ${!stuData.length ? `<div class="dist-seg bg-slate-300" style="width:100%">No Data</div>` : ''}
            </div>
            <div class="flex gap-4 mt-3 flex-wrap">
                ${[['A', dist.a, 'bg-emerald-500'], ['B', dist.b, 'bg-blue-500'], ['C', dist.c, 'bg-teal-500'], ['D', dist.d, 'bg-amber-500'], ['F', dist.f, 'bg-red-500']].map(([l, n, c]) => `
                <div class="flex items-center gap-1.5">
                    <div class="w-3 h-3 rounded-sm ${c}"></div><span class="text-xs font-black text-slate-600">${l}: ${n}</span>
                </div>`).join('')}
            </div>
        </div>
        
        ${atRiskStudents.length ? `
        <div class="bg-red-50 border border-red-200 rounded-2xl p-5">
            <h4 class="font-black text-red-700 text-sm uppercase tracking-wider mb-3 flex items-center gap-2"><i class="fa-solid fa-triangle-exclamation"></i> Needs Attention</h4>
            <div class="space-y-2">
                ${atRiskStudents.map(s => `
                <div class="flex items-center justify-between bg-white border border-red-100 rounded-xl p-3">
                    <span class="font-black text-slate-700 text-sm">${s.name}</span>
                    <span class="font-black text-red-600">${s.avg}%</span>
                </div>`).join('')}
            </div>
        </div>` : ''}
        
        <div class="bg-white border border-slate-200 rounded-2xl overflow-hidden shadow-sm">
            <div class="px-5 py-4 border-b border-slate-100 bg-slate-50"><h4 class="font-black text-slate-700 text-sm uppercase tracking-wider">Student Breakdown</h4></div>
            <div class="overflow-x-auto">
                <table class="w-full text-sm">
                    <thead class="bg-slate-50 text-slate-500 text-xs uppercase tracking-wider border-b border-slate-200">
                        <tr>
                            <th class="px-4 py-3 font-black text-left">Student</th>
                            <th class="px-4 py-3 font-black text-center">Average</th>
                            <th class="px-4 py-3 font-black text-center">Standing</th>
                            <th class="px-4 py-3 font-black text-center">Assignments</th>
                        </tr>
                    </thead>
                    <tbody>
                        ${stuData.length ? stuData.reverse().map(s => `
                        <tr class="gb-row">
                            <td class="px-4 py-3">
                                <div class="flex items-center gap-2">
                                    <div class="h-8 w-8 bg-gradient-to-br from-emerald-400 to-teal-500 text-white rounded-lg flex items-center justify-center font-black text-xs flex-shrink-0">${s.name.charAt(0)}</div>
                                    <span class="font-black text-slate-700 text-sm">${s.name}</span>
                                </div>
                            </td>
                            <td class="px-4 py-3 text-center"><span class="${gradeColorClass(s.avg)} font-black">${s.avg}% · ${letterGrade(s.avg)}</span></td>
                            <td class="px-4 py-3 text-center">${standingBadge(s.avg)}</td>
                            <td class="px-4 py-3 text-center text-slate-500 font-semibold text-sm">${s.count}</td>
                        </tr>`).join('') : '<tr><td colspan="4" class="px-4 py-8 text-center text-slate-400 italic">No students match filter.</td></tr>'}
                    </tbody>
                </table>
            </div>
        </div>
        
        <div class="bg-white border border-slate-200 rounded-2xl overflow-hidden shadow-sm">
            <div class="px-5 py-4 border-b border-slate-100 bg-slate-50 flex justify-between items-center">
                <h4 class="font-black text-slate-700 text-sm uppercase tracking-wider">All Assignments</h4>
                <span class="text-xs text-slate-400 font-bold">${sg.length} record${sg.length !== 1 ? 's' : ''}</span>
            </div>
            <div class="overflow-x-auto">
                <table class="w-full text-sm">
                    <thead class="bg-slate-50 text-slate-500 text-xs uppercase tracking-wider border-b border-slate-200">
                        <tr>
                            <th class="px-4 py-3 font-black text-left">Title</th>
                            <th class="px-4 py-3 font-black text-left">Type</th>
                            <th class="px-4 py-3 font-black text-left">Student</th>
                            <th class="px-4 py-3 font-black text-center">Score</th>
                        </tr>
                    </thead>
                    <tbody>
                        ${sg.length ? sg.sort((a, b) => (b.date || '').localeCompare(a.date || '')).map(g => {
                            const pct = g.max ? Math.round(g.score / g.max * 100) : null;
                            return `
                            <tr class="gb-row cursor-pointer" onclick="openAssignmentModal('${g.id}')">
                                <td class="px-4 py-3">
                                    <p class="font-bold text-slate-700 text-sm hover:text-teal-600">${g.title || '—'}</p>
                                    <p class="text-xs text-slate-400">${g.date || ''}</p>
                                </td>
                                <td class="px-4 py-3"><span class="text-[10px] font-black uppercase bg-slate-100 text-slate-500 border border-slate-200 px-2 py-1 rounded-md">${g.type || '—'}</span></td>
                                <td class="px-4 py-3 text-sm font-bold text-slate-700">${studentMap[g.studentId] || '—'}</td>
                                <td class="px-4 py-3 text-center"><span class="${gradeColorClass(pct || 0)} font-black text-sm">${pct !== null ? pct + '%' : '—'}</span></td>
                            </tr>`;
                        }).join('') : '<tr><td colspan="4" class="px-4 py-8 text-center text-slate-400 italic">No assignments match filter.</td></tr>'}
                    </tbody>
                </table>
            </div>
        </div>`;
};

window.closeSubjectPanel = function() { closeOverlay('subjectPanel', 'subjectPanelInner', true); };

// ── 6. ASSIGNMENT DETAIL MODAL ──────────────────────────────────────────────
window.openAssignmentModal = function(gradeId) {
    const g = gradeDetailCache[gradeId];
    if (!g) return;
    
    const pct = g.max ? Math.round(g.score / g.max * 100) : null;
    const fill = gradeFill(pct || 0);
    const color = pct >= 90 ? 'text-emerald-600' : pct >= 80 ? 'text-blue-600' : pct >= 70 ? 'text-teal-600' : pct >= 65 ? 'text-amber-600' : 'text-red-600';
    
    document.getElementById('aModalTitle').textContent = g.title || 'Assessment';
    
    let histHTML = '';
    if (g.historyLogs?.length) {
        histHTML = `<div class="bg-amber-50 border border-amber-200 rounded-xl p-4"><p class="text-xs font-black text-amber-600 uppercase tracking-wider mb-2"><i class="fa-solid fa-clock-rotate-left mr-1"></i>Edit History (${g.historyLogs.length})</p><div class="space-y-2 max-h-32 overflow-y-auto">${g.historyLogs.map(l => `<div class="text-xs text-amber-800 font-semibold bg-white rounded-lg p-2 border border-amber-100"><i class="fa-solid fa-circle-dot mr-1 text-amber-400"></i>${typeof l === 'object' ? `[${l.changedAt}] ${l.oldScore}/${l.oldMax} → ${l.newScore}/${l.newMax}. Reason: ${l.reason}` : l}</div>`).join('')}</div></div>`;
    }
    
    document.getElementById('aModalBody').innerHTML = `
        <div class="text-center mb-5">
            <div class="${color} text-5xl font-black">${g.score}<span class="text-2xl text-slate-400">/${g.max || '?'}</span></div>
            ${pct !== null ? `<div class="flex items-center justify-center gap-3 mt-2"><span class="${color} text-xl font-black">${pct}%</span><span class="${color} font-black px-3 py-1 rounded-xl text-lg border ${pct >= 90 ? 'bg-emerald-50 border-emerald-200' : pct >= 80 ? 'bg-blue-50 border-blue-200' : pct >= 70 ? 'bg-teal-50 border-teal-200' : pct >= 65 ? 'bg-amber-50 border-amber-200' : 'bg-red-50 border-red-200'}">${letterGrade(pct)}</span></div>` : ''}
            <div class="mt-3 h-3 bg-slate-100 rounded-full overflow-hidden mx-4"><div class="h-full rounded-full" style="width:${pct || 0}%;background:${fill};transition:width 0.5s ease"></div></div>
        </div>
        <div class="space-y-2 text-sm mb-4">
            ${[['Subject', g.subject || '—'], ['Type', g.type || '—'], ['Date', g.date || '—']].map(([l, v]) => `<div class="flex justify-between py-2 border-b border-slate-100"><span class="text-slate-400 font-black uppercase text-xs tracking-wider">${l}</span><span class="font-black text-slate-700">${v}</span></div>`).join('')}
        </div>
        ${g.notes ? `<div class="bg-blue-50 border border-blue-100 rounded-xl p-4 mb-3"><p class="text-xs font-black text-blue-500 uppercase tracking-wider mb-1">Teacher Notes</p><p class="text-sm text-slate-700 font-semibold whitespace-pre-wrap">${g.notes}</p></div>` : ''}
        ${histHTML}
    `;
    
    openOverlay('assignmentModal', 'assignmentModalInner');
};
window.closeAssignmentModal = function() { closeOverlay('assignmentModal', 'assignmentModalInner'); };

// ── 7. ADD SUBJECT (From Subjects Page) ─────────────────────────────────────
window.openSubjectFormModal = function() {
    document.getElementById('subjectFormName').value = '';
    document.getElementById('subjectFormDesc').value = '';
    document.getElementById('subjectFormMsg').classList.add('hidden');
    openOverlay('subjectFormModal', 'subjectFormModalInner');
};
window.closeSubjectFormModal = function() { closeOverlay('subjectFormModal', 'subjectFormModalInner'); };

async function saveSubject() {
    const name = document.getElementById('subjectFormName').value.trim();
    const desc = document.getElementById('subjectFormDesc').value.trim();
    
    if (!name) { showMsg('subjectFormMsg', 'Subject name is required.', true); return; }
    
    const btn = document.getElementById('saveSubjectFormBtn');
    btn.innerHTML = `<i class="fa-solid fa-spinner fa-spin"></i> Saving...`;
    btn.disabled = true;
    
    try {
        let newSubs = [...(session.teacherData.subjects || [])];
        if (newSubs.some(s => s.name === name && !s.archived)) {
            showMsg('subjectFormMsg', 'Subject already exists.', true);
            btn.innerHTML = 'Save Subject'; btn.disabled = false;
            return;
        }
        
        newSubs.push({ id: genId(), name, description: desc, archived: false, archivedAt: null });
        
        await updateDoc(doc(db, 'schools', session.schoolId, 'teachers', session.teacherId), { subjects: newSubs });
        session.teacherData.subjects = newSubs;
        sessionStorage.setItem('connectus_teacher_session', JSON.stringify(session));
        
        closeSubjectFormModal();
        loadSubjectsTab(); // Reload table
    } catch (e) {
        console.error(e);
        showMsg('subjectFormMsg', 'Error saving subject.', true);
    }
    btn.innerHTML = 'Save Subject';
    btn.disabled = false;
}

// ── 8. PRINT REPORT ─────────────────────────────────────────────────────────
window.printSubjectReport = function() {
    const semName = document.getElementById('activeSemester').options[document.getElementById('activeSemester').selectedIndex]?.text || '';
    const fStudent = document.getElementById('spFilterStudent').options[document.getElementById('spFilterStudent').selectedIndex]?.text || 'All Students';
    const fType = document.getElementById('spFilterType').options[document.getElementById('spFilterType').selectedIndex]?.text || 'All Types';
    
    const sg = cachedSubjectGrades.filter(g => {
        if (document.getElementById('spFilterStudent').value && g.studentId !== document.getElementById('spFilterStudent').value) return false;
        if (document.getElementById('spFilterType').value && g.type !== document.getElementById('spFilterType').value) return false;
        return true;
    }).sort((a, b) => (b.date || '').localeCompare(a.date || ''));
    
    const classAvgNum = sg.length ? Math.round(sg.reduce((acc, g) => acc + (g.max ? (g.score / g.max) * 100 : 0), 0) / sg.length) : 0;
    
    let html = `<html><head><title>${currentSubjectName} Report</title>
    <style>body{font-family:'Helvetica Neue',Helvetica,Arial,sans-serif;padding:40px;color:#1e293b;line-height:1.5;font-size:13px;}
    .header{text-align:center;border-bottom:2px solid #cbd5e1;padding-bottom:20px;margin-bottom:30px;}
    .header h1{margin:0 0 5px 0;font-size:22px;color:#0f172a;text-transform:uppercase;letter-spacing:1px;}
    .header h2{margin:0;font-size:15px;color:#059669;font-weight:bold;}
    .info-grid{background:#f8fafc;padding:15px;border-radius:6px;border:1px solid #e2e8f0;margin-bottom:30px;display:flex;justify-content:space-between;flex-wrap:wrap;gap:10px;}
    table{width:100%;border-collapse:collapse;margin-bottom:20px;}
    th,td{border:1px solid #e2e8f0;padding:8px 12px;text-align:left;}
    th{background:#f1f5f9;color:#475569;font-weight:bold;text-transform:uppercase;font-size:10px;letter-spacing:0.5px;}
    .tc{text-align:center;}</style></head><body>
    <div class="header"><h1>${session.teacherData.name} — ConnectUs</h1><h2>Subject Report: ${currentSubjectName}</h2></div>
    <div class="info-grid"><div><strong>Period:</strong> ${semName}</div><div><strong>Student:</strong> ${fStudent}</div><div><strong>Type:</strong> ${fType}</div><div><strong>Overall Avg:</strong> ${classAvgNum}%</div></div>
    <table><thead><tr><th>Date</th><th>Assignment</th><th>Type</th><th>Student</th><th class="tc">Score</th><th class="tc">%</th></tr></thead><tbody>`;
    
    if (!sg.length) html += `<tr><td colspan="6" class="tc" style="padding:20px;font-style:italic;">No records match the current filters.</td></tr>`;
    else sg.forEach(g => {
        const pct = g.max ? Math.round(g.score / g.max * 100) : null;
        html += `<tr><td>${g.date || '—'}</td><td>${g.title}</td><td>${g.type}</td><td>${studentMap[g.studentId] || 'Unknown'}</td><td class="tc">${g.score}/${g.max}</td><td class="tc">${pct !== null ? pct + '%' : '—'}</td></tr>`;
    });
    
    html += `</tbody></table>
    <p style='font-size:10px;color:#64748b;margin-top:40px;text-align:center;border-top:1px solid #e2e8f0;padding-top:10px;font-style:italic;'>This document does not constitute an official report card.</p>
    </body></html>`;
    
    const w = window.open('', '_blank');
    w.document.write(html);
    w.document.close();
    setTimeout(() => w.print(), 500);
};

// Fire it up
init();
