import { db } from '../../assets/js/firebase-init.js';
import { collection, getDocs, query, where } from "https://www.gstatic.com/firebasejs/10.7.1/firebase-firestore.js";
import { requireAuth } from '../../assets/js/auth.js';
import { injectAdminLayout } from '../../assets/js/layout-admin.js';
import { openOverlay, closeOverlay, letterGrade, gradeColorClass, calculateWeightedAverage } from '../../assets/js/utils.js';

const session = requireAuth('admin', '../login.html');
injectAdminLayout('classes', 'Classes', 'Performance overview for each class', false, true);

const tbody = document.getElementById('classesTableBody');
const loadingMsg = document.getElementById('classesLoadingMsg');
const globalPeriodSelect = document.getElementById('globalPeriodSelect');

let classDataMap = new Map();
let currentClassName = null;

// ── UI HELPERS ────────────────────────────────────────────────────────────
function escHtml(str) {
    if (!str) return '';
    return String(str).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}

function standingBadge(avg) {
    if (avg === null) return '<span class="badge s-none" style="font-size:0.6rem">No Grades</span>';
    if (avg >= 90) return '<span class="badge s-exc" style="font-size:0.6rem">Excelling</span>';
    if (avg >= 80) return '<span class="badge s-good" style="font-size:0.6rem">Good</span>';
    if (avg >= 70) return '<span class="badge s-track" style="font-size:0.6rem">On Track</span>';
    if (avg >= 65) return '<span class="badge s-attn" style="font-size:0.6rem">Attention</span>';
    return '<span class="badge s-risk" style="font-size:0.6rem">At Risk</span>';
}

function getTeacherClasses(t) {
    return t.classes || (t.className ? [t.className] : []);
}

// ── 1. INITIALIZE SEMESTERS DROPDOWN ──────────────────────────────────────
async function loadSemestersDropdown() {
    try {
        const snap = await getDocs(collection(db, 'schools', session.schoolId, 'semesters'));
        const semesters = snap.docs.map(d => ({ id: d.id, ...d.data() })).sort((a, b) => a.order - b.order);
        
        globalPeriodSelect.innerHTML = semesters.map(s => 
            `<option value="${s.id}" ${s.id === session.activeSemesterId ? 'selected' : ''}>${escHtml(s.name)} ${s.archived ? '(Archived)' : ''}</option>`
        ).join('');

        globalPeriodSelect.addEventListener('change', loadClasses);
        loadClasses();
    } catch (error) {
        console.error("Error loading semesters:", error);
    }
}

// ── 2. LOAD MAIN TABLE ───────────────────────────────────────────────────────
async function loadClasses() {
    loadingMsg.classList.remove('hidden');
    tbody.innerHTML = `<tr><td colspan="9" class="px-6 py-16 text-center text-slate-400 font-semibold"><i class="fa-solid fa-spinner fa-spin text-indigo-400 text-2xl mb-3 block"></i>Loading classes...</td></tr>`;
    classDataMap.clear();

    const semId = globalPeriodSelect.value || session.activeSemesterId || '';

    try {
        // Query global collections for teachers and active students
        const [tSnap, sSnap] = await Promise.all([
            getDocs(query(collection(db, 'teachers'), where('currentSchoolId', '==', session.schoolId))),
            getDocs(query(collection(db, 'students'),
                where('currentSchoolId', '==', session.schoolId),
                where('enrollmentStatus', '==', 'Active'))) // Strict Active Filter
        ]);

        const teachers = tSnap.docs.map(d => ({ id: d.id, ...d.data() }));
        const students = sSnap.docs.map(d => ({ id: d.id, ...d.data() }));

        const classesByName = {};
        
        // 1. Build classes from Student roster
        students.forEach(s => {
            const cls = s.className || 'Unassigned';
            if (!classesByName[cls]) classesByName[cls] = { students: [], teacher: null };
            classesByName[cls].students.push(s);
        });

        // 2. Build classes from Teacher assignments (Ensures empty classes are captured)
        teachers.forEach(t => {
            const tClasses = getTeacherClasses(t);
            tClasses.forEach(cls => {
                if (!classesByName[cls]) classesByName[cls] = { students: [], teacher: null }; // Create the class if it has 0 students
                classesByName[cls].teacher = t;
            });
        });

        if (!Object.keys(classesByName).length) {
            tbody.innerHTML = `<tr><td colspan="9" class="px-6 py-16 text-center text-slate-400 italic font-semibold">No active classes found.</td></tr>`;
            loadingMsg.classList.add('hidden');
            return;
        }

        // Fetch grades and calculate stats for each class
        const classStats = await Promise.all(Object.entries(classesByName).sort((a, b) => a[0].localeCompare(b[0])).map(async ([className, classData]) => {
            const allGrades = [];
            
            await Promise.all(classData.students.map(async s => {
                try {
                    const gradesRef = collection(db, 'schools', session.schoolId, 'students', s.id, 'grades');
                    const q = semId ? query(gradesRef, where('semesterId', '==', semId)) : gradesRef;
                    const snap = await getDocs(q);
                    snap.forEach(d => allGrades.push({ ...d.data(), studentId: s.id }));
                } catch (e) {
                    console.error(`Error fetching grades for student ${s.id}`, e);
                }
            }));
            
            const stuAvgs = classData.students.map(s => {
                const sg = allGrades.filter(g => g.studentId === s.id);
                return sg.length ? calculateWeightedAverage(sg, session.schoolId) : null;
            }).filter(a => a !== null);
            
            const classAvg = stuAvgs.length ? Math.round(stuAvgs.reduce((a, b) => a + b, 0) / stuAvgs.length) : null;
            const allPcts = allGrades.map(g => g.max ? Math.round(g.score / g.max * 100) : 0);
            const highest = allPcts.length ? Math.max(...allPcts) : null;
            const lowest = allPcts.length ? Math.min(...allPcts) : null;
            const atRisk = stuAvgs.filter(a => a < 65).length;
            const subjectCount = new Set(allGrades.map(g => g.subject)).size;
            
            const processedData = { 
                className, 
                teacher: classData.teacher, 
                students: classData.students, 
                studentCount: classData.students.length, 
                subjectCount, 
                classAvg, 
                highest, 
                lowest, 
                atRisk, 
                grades: allGrades 
            };
            classDataMap.set(className, processedData);
            
            return processedData;
        }));

        // Render Table Rows
        tbody.innerHTML = classStats.map(c => `
            <tr class="gb-row">
                <td class="px-6 py-4">
                    <div class="flex items-center gap-3">
                        <div class="w-10 h-10 bg-gradient-to-br from-indigo-500 to-blue-600 text-white rounded-xl flex items-center justify-center font-black text-sm shadow-sm">${escHtml(c.className.charAt(0))}</div>
                        <span class="font-black text-slate-800">${escHtml(c.className)}</span>
                    </div>
                </td>
                <td class="px-6 py-4">${c.teacher ? `<div class="flex items-center gap-2"><div class="h-8 w-8 bg-blue-100 text-blue-700 rounded-lg flex items-center justify-center font-black text-xs">${escHtml(c.teacher.name).charAt(0)}</div><span class="font-bold text-slate-700 text-sm">${escHtml(c.teacher.name)}</span></div>` : '<span class="text-slate-400 font-semibold text-sm italic">Unassigned</span>'}</td>
                <td class="px-6 py-4 text-center"><span class="bg-indigo-50 text-indigo-700 font-black text-sm px-3 py-1 rounded-lg border border-indigo-200">${c.studentCount}</span></td>
                <td class="px-6 py-4 text-center"><span class="bg-slate-100 text-slate-600 font-bold text-xs px-3 py-1 rounded-lg border border-slate-200">${c.subjectCount}</span></td>
                <td class="px-6 py-4 text-center">${c.classAvg !== null ? `<span class="${gradeColorClass(c.classAvg)} font-black">${c.classAvg}% · ${letterGrade(c.classAvg)}</span>` : '<span class="text-slate-400">—</span>'}</td>
                <td class="px-6 py-4 text-center">${c.highest !== null ? `<span class="g-a font-black">${c.highest}%</span>` : '<span class="text-slate-400">—</span>'}</td>
                <td class="px-6 py-4 text-center">${c.lowest !== null ? `<span class="${gradeColorClass(c.lowest)} font-black">${c.lowest}%</span>` : '<span class="text-slate-400">—</span>'}</td>
                <td class="px-6 py-4 text-center">${c.atRisk ? `<span class="font-black text-red-600 bg-red-50 border border-red-200 px-2 py-0.5 rounded-lg text-xs">${c.atRisk}</span>` : '<span class="text-slate-400 font-semibold">0</span>'}</td>
                <td class="px-6 py-4 text-right"><button onclick="window.openClassPanel('${escHtml(c.className)}')" class="bg-indigo-50 hover:bg-indigo-600 hover:text-white text-indigo-700 font-black px-4 py-2 rounded-xl text-xs transition border border-indigo-200 hover:border-indigo-600">View Details</button></td>
            </tr>`).join('');

        loadingMsg.classList.add('hidden');
    } catch (e) {
        console.error("Error building classes table:", e);
        loadingMsg.classList.add('hidden');
        tbody.innerHTML = `<tr><td colspan="9" class="px-6 py-16 text-center text-red-500 font-semibold">Failed to load classes.</td></tr>`;
    }
}

// ── 3. DEEP DIVE CLASS PANEL TABBING ──────────────────────────────────────
window.switchClassTab = function(tabName) {
    document.querySelectorAll('.panel-tab').forEach(t => t.classList.remove('active'));
    document.querySelector(`.panel-tab[data-tab="${tabName}"]`).classList.add('active');
    renderPanelContent(tabName);
};

window.openClassPanel = function(className) {
    currentClassName = className;
    const classData = classDataMap.get(className);
    if (!classData) return;

    document.getElementById('cpPanelTitle').textContent = classData.className;
    const semName = globalPeriodSelect.options[globalPeriodSelect.selectedIndex]?.text || '';
    document.getElementById('cpPanelMeta').textContent = `${semName} · ${classData.studentCount} students`;

    window.switchClassTab('overview');
    openOverlay('classPanel', 'classPanelInner', true);
};

window.closeClassPanel = function() {
    closeOverlay('classPanel', 'classPanelInner', true);
};

// ── 4. RENDER TAB CONTENT ─────────────────────────────────────────────────
function renderPanelContent(tab) {
    const data = classDataMap.get(currentClassName);
    if (!data) return;
    const container = document.getElementById('classPanelBody');

    if (tab === 'overview') {
        const { teacher, students, grades, classAvg, studentCount, atRisk } = data;
        
        const dist = { a: 0, b: 0, c: 0, d: 0, f: 0 };
        const stuAvgData = students.map(s => {
            const sg = grades.filter(g => g.studentId === s.id);
            const avg = sg.length ? calculateWeightedAverage(sg, session.schoolId) : null;
            if (avg !== null) {
                if (avg >= 90) dist.a++; else if (avg >= 80) dist.b++; else if (avg >= 70) dist.c++; else if (avg >= 65) dist.d++; else dist.f++;
            }
            return { ...s, avg };
        });
        const totalGrades = stuAvgData.filter(s => s.avg !== null).length || 1;

        container.innerHTML = `
            ${teacher ? `<div class="bg-white border border-slate-200 rounded-2xl p-5 shadow-sm flex items-center gap-4 mb-6">
                <div class="h-12 w-12 bg-gradient-to-br from-blue-500 to-blue-600 text-white rounded-xl flex items-center justify-center font-black text-lg shadow-sm flex-shrink-0">${escHtml(teacher.name).charAt(0)}</div>
                <div>
                    <p class="font-black text-slate-800">${escHtml(teacher.name)}</p>
                    <p class="text-xs text-slate-400 font-semibold">${escHtml(teacher.email || '')} ${teacher.phone ? '· ' + escHtml(teacher.phone) : ''}</p>
                    <p class="text-xs text-slate-500 font-semibold mt-1">PIN: <span class="font-mono font-black text-blue-600">${escHtml(teacher.pin || teacher.loginCode || '—')}</span></p>
                </div>
            </div>` : '<div class="bg-amber-50 border border-amber-200 rounded-2xl p-4 text-sm font-bold text-amber-700 mb-6"><i class="fa-solid fa-triangle-exclamation mr-2"></i>No teacher assigned to this class yet.</div>'}

            <div class="grid grid-cols-3 gap-3 mb-6">
                <div class="bg-white border border-slate-200 rounded-2xl p-4 text-center shadow-sm">
                    <p class="text-xs font-black text-slate-400 uppercase tracking-wider mb-1">Class Avg</p>
                    <p class="text-3xl font-black ${classAvg !== null ? gradeColorClass(classAvg) : 'text-slate-400'}">${classAvg !== null ? classAvg + '%' : '—'}</p>
                </div>
                <div class="bg-white border border-slate-200 rounded-2xl p-4 text-center shadow-sm">
                    <p class="text-xs font-black text-slate-400 uppercase tracking-wider mb-1">Students</p>
                    <p class="text-3xl font-black text-indigo-600">${studentCount}</p>
                </div>
                <div class="bg-white border border-slate-200 rounded-2xl p-4 text-center shadow-sm">
                    <p class="text-xs font-black text-slate-400 uppercase tracking-wider mb-1">At Risk</p>
                    <p class="text-3xl font-black ${atRisk ? 'text-red-600' : 'text-emerald-600'}">${atRisk}</p>
                </div>
            </div>

            <div class="bg-white border border-slate-200 rounded-2xl p-5 shadow-sm mb-6">
                <h4 class="text-xs font-black text-slate-500 uppercase tracking-wider mb-3">Grade Distribution</h4>
                <div class="dist-bar h-4 bg-slate-100 rounded-full overflow-hidden flex">
                    ${dist.a ? `<div class="bg-emerald-500 h-full transition-all" style="width:${dist.a / totalGrades * 100}%"></div>` : ''}
                    ${dist.b ? `<div class="bg-blue-500 h-full transition-all" style="width:${dist.b / totalGrades * 100}%"></div>` : ''}
                    ${dist.c ? `<div class="bg-teal-500 h-full transition-all" style="width:${dist.c / totalGrades * 100}%"></div>` : ''}
                    ${dist.d ? `<div class="bg-amber-500 h-full transition-all" style="width:${dist.d / totalGrades * 100}%"></div>` : ''}
                    ${dist.f ? `<div class="bg-red-500 h-full transition-all" style="width:${dist.f / totalGrades * 100}%"></div>` : ''}
                    ${!totalGrades || (dist.a===0 && dist.b===0 && dist.c===0 && dist.d===0 && dist.f===0) ? `<div class="bg-slate-300 h-full w-full"></div>` : ''}
                </div>
                <div class="flex gap-4 mt-4 flex-wrap">
                    ${[['A (90+)', dist.a, 'bg-emerald-500'], ['B (80+)', dist.b, 'bg-blue-500'], ['C (70+)', dist.c, 'bg-teal-500'], ['D (65+)', dist.d, 'bg-amber-500'], ['F (<65)', dist.f, 'bg-red-500']].map(([l, n, c]) => `<div class="flex items-center gap-1.5"><div class="w-3 h-3 rounded-sm ${c}"></div><span class="text-xs font-black text-slate-600">${l}: ${n}</span></div>`).join('')}
                </div>
            </div>
            
            <div class="grid grid-cols-1 md:grid-cols-2 gap-6">
                <div class="bg-white border border-slate-200 rounded-2xl p-5 shadow-sm">
                    <h4 class="text-xs font-black text-emerald-600 uppercase tracking-wider mb-4 border-b border-emerald-100 pb-2 flex items-center gap-2"><i class="fa-solid fa-arrow-trend-up"></i> Top Performers (85%+)</h4>
                    <div class="space-y-2">
                        ${stuAvgData.filter(s => s.avg !== null && s.avg >= 85).sort((a,b) => b.avg - a.avg).map(s => `<div class="flex justify-between items-center text-sm"><span class="font-bold text-slate-700">${escHtml(s.name)}</span><span class="font-black text-emerald-600">${s.avg}%</span></div>`).join('') || '<p class="text-sm text-slate-400 italic">No students above 85% yet.</p>'}
                    </div>
                </div>
                <div class="bg-white border border-slate-200 rounded-2xl p-5 shadow-sm">
                    <h4 class="text-xs font-black text-red-600 uppercase tracking-wider mb-4 border-b border-red-100 pb-2 flex items-center gap-2"><i class="fa-solid fa-triangle-exclamation"></i> At-Risk Students (<65%)</h4>
                    <div class="space-y-2">
                        ${stuAvgData.filter(s => s.avg !== null && s.avg < 65).sort((a,b) => a.avg - b.avg).map(s => `<div class="flex justify-between items-center text-sm"><span class="font-bold text-slate-700">${escHtml(s.name)}</span><span class="font-black text-red-600">${s.avg}%</span></div>`).join('') || '<p class="text-sm text-slate-400 italic">No students at risk.</p>'}
                    </div>
                </div>
            </div>
        `;
    } 
    
    else if (tab === 'subjects') {
        const { grades } = data;
        const bySubject = {};
        grades.forEach(g => {
            const sub = g.subject || 'Uncategorized';
            if (!bySubject[sub]) bySubject[sub] = [];
            bySubject[sub].push(g);
        });

        const subjectHtml = Object.entries(bySubject).sort((a, b) => a[0].localeCompare(b[0])).map(([sub, sg]) => {
            const avg = calculateWeightedAverage(sg, session.schoolId);
            
            const assessments = [...new Set(sg.map(g => g.title))].map(title => {
                const ag = sg.filter(x => x.title === title);
                const aAvg = Math.round(ag.reduce((a, x) => a + (x.max ? x.score / x.max * 100 : 0), 0) / ag.length);
                return `<div class="flex justify-between py-2 border-b border-slate-200 last:border-0 text-sm"><span class="font-semibold text-slate-600">${escHtml(title)}</span><b class="${gradeColorClass(aAvg)}">${aAvg}%</b></div>`;
            }).join('');

            return `
                <div class="bg-white border border-slate-200 rounded-xl mb-3 overflow-hidden shadow-sm">
                    <div class="px-5 py-4 flex justify-between items-center cursor-pointer hover:bg-slate-50 transition" onclick="this.nextElementSibling.classList.toggle('open'); this.querySelector('.fa-chevron-down').classList.toggle('rotate-180');">
                        <span class="font-black text-slate-700 text-sm">${escHtml(sub)}</span>
                        <span class="font-black ${gradeColorClass(avg)} text-sm">${avg}% · ${letterGrade(avg)} <i class="fa-solid fa-chevron-down ml-3 text-slate-300 transition-transform duration-200"></i></span>
                    </div>
                    <div class="subject-body bg-slate-50">
                        <div class="px-5 pb-4 pt-2 border-t border-slate-100 flex flex-col gap-1">
                            ${assessments}
                        </div>
                    </div>
                </div>
            `;
        }).join('');
        
        container.innerHTML = subjectHtml || '<p class="text-center py-10 text-slate-400 italic">No subject data found.</p>';
    }

    else if (tab === 'students') {
        const { students, grades } = data;
        
        const stuRows = students.map(s => {
            const sg = grades.filter(g => g.studentId === s.id);
            const avg = sg.length ? calculateWeightedAverage(sg, session.schoolId) : null;
            return { ...s, avg, gradeCount: sg.length };
        }).sort((a, b) => (a.avg ?? -1) - (b.avg ?? -1)).map(s => `
            <tr class="hover:bg-slate-50 transition gb-row">
                <td class="px-5 py-3">
                    <div class="flex items-center gap-3">
                        <div class="h-8 w-8 bg-gradient-to-br from-slate-200 to-slate-300 text-slate-600 rounded-lg flex items-center justify-center font-black text-xs flex-shrink-0">${(s.name || '?').charAt(0).toUpperCase()}</div>
                        <span class="font-bold text-slate-700 text-sm">${escHtml(s.name || 'Unnamed')}</span>
                    </div>
                </td>
                <td class="px-5 py-3 text-center ${s.avg !== null ? gradeColorClass(s.avg) : 'text-slate-400'} font-black text-sm">${s.avg !== null ? s.avg + '%' : '—'}</td>
                <td class="px-5 py-3 text-center">${standingBadge(s.avg)}</td>
                <td class="px-5 py-3 text-center text-slate-500 font-semibold text-xs">${s.gradeCount}</td>
                <td class="px-5 py-3 text-right"><a href="../students/students.html?viewStudent=${escHtml(s.id)}" class="text-[11px] font-black text-indigo-600 bg-indigo-50 border border-indigo-200 px-3 py-1.5 rounded hover:bg-indigo-600 hover:text-white transition inline-block">View Profile</a></td>
            </tr>`).join('');

        container.innerHTML = `
            <div class="bg-white border border-slate-200 rounded-xl overflow-hidden shadow-sm">
                <table class="w-full text-left">
                    <thead class="bg-slate-50 text-[10px] uppercase font-black text-slate-400 border-b border-slate-200 tracking-wider">
                        <tr><th class="px-5 py-4">Student</th><th class="px-5 py-4 text-center">Avg</th><th class="px-5 py-4 text-center">Standing</th><th class="px-5 py-4 text-center">Grades</th><th class="px-5 py-4"></th></tr>
                    </thead>
                    <tbody class="divide-y divide-slate-100">${stuRows || '<tr><td colspan="5" class="px-5 py-10 text-center text-slate-400 italic">No students found.</td></tr>'}</tbody>
                </table>
            </div>`;
    }
}

document.addEventListener('DOMContentLoaded', loadSemestersDropdown);
