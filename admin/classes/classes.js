import { db } from '../../assets/js/firebase-init.js';
import { collection, getDocs, query, where } from "https://www.gstatic.com/firebasejs/10.7.1/firebase-firestore.js";
import { requireAuth } from '../../assets/js/auth.js';
import { injectAdminLayout } from '../../assets/js/layout-admin.js';
import { openOverlay, closeOverlay, letterGrade, gradeColorClass } from '../../assets/js/utils.js';

// ── 1. INIT & AUTH ────────────────────────────────────────────────────────
const session = requireAuth('admin', '../login.html');

// Inject layout: showSearch=false, showPeriod=true (so the globalPeriodSelect drops in)
injectAdminLayout('classes', 'Classes', 'Performance overview for each class', false, true);

const tbody = document.getElementById('classesTableBody');
const loadingMsg = document.getElementById('classesLoadingMsg');
const globalPeriodSelect = document.getElementById('globalPeriodSelect');

// State map to store class data cleanly (prevents huge stringify issues in HTML buttons)
let classDataMap = new Map();

// UI Helper specific to performance views
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

// ── 2. INITIALIZE SEMESTERS DROPDOWN ──────────────────────────────────────
async function loadSemestersDropdown() {
    try {
        const snap = await getDocs(collection(db, 'schools', session.schoolId, 'semesters'));
        const semesters = snap.docs.map(d => ({ id: d.id, ...d.data() })).sort((a, b) => a.order - b.order);
        
        globalPeriodSelect.innerHTML = semesters.map(s => 
            `<option value="${s.id}" ${s.id === session.activeSemesterId ? 'selected' : ''}>${s.name} ${s.archived ? '(Archived)' : ''}</option>`
        ).join('');

        // Listen for changes to reload the data
        globalPeriodSelect.addEventListener('change', loadClasses);

        // Load the table initially
        loadClasses();
    } catch (error) {
        console.error("Error loading semesters:", error);
    }
}

// ── 3. LOAD CLASSES DATA ──────────────────────────────────────────────────
async function loadClasses() {
    loadingMsg.classList.remove('hidden');
    tbody.innerHTML = `<tr><td colspan="9" class="px-6 py-16 text-center text-slate-400 font-semibold"><i class="fa-solid fa-spinner fa-spin text-indigo-400 text-2xl mb-3 block"></i>Loading classes...</td></tr>`;
    classDataMap.clear();

    const semId = globalPeriodSelect.value || session.activeSemesterId || '';

    try {
        const [tSnap, sSnap] = await Promise.all([
            getDocs(collection(db, 'schools', session.schoolId, 'teachers')),
            getDocs(collection(db, 'schools', session.schoolId, 'students'))
        ]);
        
        const teachers = tSnap.docs.filter(d => !d.data().archived).map(d => ({ id: d.id, ...d.data() }));
        const students = sSnap.docs.filter(d => !d.data().archived).map(d => ({ id: d.id, ...d.data() }));

        const classesByName = {};
        students.forEach(s => {
            const cls = s.className || 'Unassigned';
            if (!classesByName[cls]) classesByName[cls] = { students: [], teacher: null };
            classesByName[cls].students.push(s);
        });

        // Map teachers to their classes
        teachers.forEach(t => {
            const tClasses = getTeacherClasses(t);
            tClasses.forEach(cls => {
                if (classesByName[cls]) classesByName[cls].teacher = t;
            });
        });

        if (!Object.keys(classesByName).length) {
            tbody.innerHTML = `<tr><td colspan="9" class="px-6 py-16 text-center text-slate-400 italic font-semibold">No classes found. Students need to be assigned to classes.</td></tr>`;
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
                return sg.length ? sg.reduce((a, g) => a + (g.max ? g.score / g.max * 100 : 0), 0) / sg.length : null;
            }).filter(a => a !== null);
            
            const classAvg = stuAvgs.length ? Math.round(stuAvgs.reduce((a, b) => a + b, 0) / stuAvgs.length) : null;
            const allPcts = allGrades.map(g => g.max ? Math.round(g.score / g.max * 100) : 0);
            const highest = allPcts.length ? Math.max(...allPcts) : null;
            const lowest = allPcts.length ? Math.min(...allPcts) : null;
            const atRisk = stuAvgs.filter(a => a < 65).length;
            const subjectCount = new Set(allGrades.map(g => g.subject)).size;
            
            const processedData = { className, teacher: classData.teacher, students: classData.students, studentCount: classData.students.length, subjectCount, classAvg, highest, lowest, atRisk, grades: allGrades };
            classDataMap.set(className, processedData);
            
            return processedData;
        }));

        // Render Table Rows
        tbody.innerHTML = classStats.map(c => `
            <tr class="gb-row">
                <td class="px-6 py-4">
                    <div class="flex items-center gap-3">
                        <div class="w-10 h-10 bg-gradient-to-br from-indigo-500 to-blue-600 text-white rounded-xl flex items-center justify-center font-black text-sm shadow-sm">${c.className.charAt(0)}</div>
                        <span class="font-black text-slate-800">${c.className}</span>
                    </div>
                </td>
                <td class="px-6 py-4">${c.teacher ? `<div class="flex items-center gap-2"><div class="h-8 w-8 bg-blue-100 text-blue-700 rounded-lg flex items-center justify-center font-black text-xs">${c.teacher.name.charAt(0)}</div><span class="font-bold text-slate-700 text-sm">${c.teacher.name}</span></div>` : '<span class="text-slate-400 font-semibold text-sm italic">Unassigned</span>'}</td>
                <td class="px-6 py-4 text-center"><span class="bg-indigo-50 text-indigo-700 font-black text-sm px-3 py-1 rounded-lg border border-indigo-200">${c.studentCount}</span></td>
                <td class="px-6 py-4 text-center"><span class="bg-slate-100 text-slate-600 font-bold text-xs px-3 py-1 rounded-lg border border-slate-200">${c.subjectCount}</span></td>
                <td class="px-6 py-4 text-center">${c.classAvg !== null ? `<span class="${gradeColorClass(c.classAvg)} font-black">${c.classAvg}% · ${letterGrade(c.classAvg)}</span>` : '<span class="text-slate-400">—</span>'}</td>
                <td class="px-6 py-4 text-center">${c.highest !== null ? `<span class="g-a font-black">${c.highest}%</span>` : '<span class="text-slate-400">—</span>'}</td>
                <td class="px-6 py-4 text-center">${c.lowest !== null ? `<span class="${gradeColorClass(c.lowest)} font-black">${c.lowest}%</span>` : '<span class="text-slate-400">—</span>'}</td>
                <td class="px-6 py-4 text-center">${c.atRisk ? `<span class="font-black text-red-600 bg-red-50 border border-red-200 px-2 py-0.5 rounded-lg text-xs">${c.atRisk}</span>` : '<span class="text-slate-400 font-semibold">0</span>'}</td>
                <td class="px-6 py-4 text-right"><button onclick="window.openClassPanel('${c.className}')" class="bg-indigo-50 hover:bg-indigo-600 hover:text-white text-indigo-700 font-black px-4 py-2 rounded-xl text-xs transition border border-indigo-200 hover:border-indigo-600">View</button></td>
            </tr>`).join('');

        loadingMsg.classList.add('hidden');
    } catch (e) {
        console.error("Error building classes table:", e);
        loadingMsg.classList.add('hidden');
        tbody.innerHTML = `<tr><td colspan="9" class="px-6 py-16 text-center text-red-500 font-semibold">Failed to load classes.</td></tr>`;
    }
}

// ── 4. DEEP DIVE CLASS PANEL ──────────────────────────────────────────────
window.openClassPanel = function(className) {
    const classData = classDataMap.get(className);
    if (!classData) return;

    document.getElementById('cpPanelTitle').textContent = classData.className;
    
    // Grab semantic name from dropdown
    const semName = globalPeriodSelect.options[globalPeriodSelect.selectedIndex]?.text || '';
    document.getElementById('cpPanelMeta').textContent = `${semName} · ${classData.studentCount} students`;
    
    document.getElementById('classPanelBody').innerHTML = '<div class="flex justify-center py-16"><i class="fa-solid fa-circle-notch fa-spin text-3xl text-indigo-500"></i></div>';
    
    openOverlay('classPanel', 'classPanelInner', true);

    const { teacher, students, grades, classAvg, subjectCount } = classData;
    
    // Process At Risk
    const atRiskStudents = students.filter(s => {
        const sg = grades.filter(g => g.studentId === s.id);
        const avg = sg.length ? sg.reduce((a, g) => a + (g.max ? g.score / g.max * 100 : 0), 0) / sg.length : null;
        return avg !== null && avg < 65;
    });

    // Process Distributions
    const stuAvgData = students.map(s => {
        const sg = grades.filter(g => g.studentId === s.id);
        const avg = sg.length ? Math.round(sg.reduce((a, g) => a + (g.max ? g.score / g.max * 100 : 0), 0) / sg.length) : null;
        return { ...s, avg, gradeCount: sg.length };
    });
    
    const dist = { a: 0, b: 0, c: 0, d: 0, f: 0 };
    stuAvgData.filter(s => s.avg !== null).forEach(s => {
        if (s.avg >= 90) dist.a++;
        else if (s.avg >= 80) dist.b++;
        else if (s.avg >= 70) dist.c++;
        else if (s.avg >= 65) dist.d++;
        else dist.f++;
    });
    const total = stuAvgData.filter(s => s.avg !== null).length || 1;

    // Process Subject Breakdown
    const bySubject = {};
    grades.forEach(g => {
        const sub = g.subject || 'Uncategorized';
        if (!bySubject[sub]) bySubject[sub] = [];
        bySubject[sub].push(g);
    });
    
    const subjectRows = Object.entries(bySubject).sort((a, b) => a[0].localeCompare(b[0])).map(([sub, sg]) => {
        const avg = Math.round(sg.reduce((a, g) => a + (g.max ? g.score / g.max * 100 : 0), 0) / sg.length);
        const stuIds = new Set(sg.map(g => g.studentId)).size;
        return `<tr class="gb-row">
            <td class="px-4 py-3"><span class="font-black text-slate-700 text-sm">${sub}</span></td>
            <td class="px-4 py-3 text-center text-slate-500 font-semibold text-sm">${stuIds}</td>
            <td class="px-4 py-3 text-center text-slate-500 font-semibold text-sm">${sg.length}</td>
            <td class="px-4 py-3 text-center"><span class="${gradeColorClass(avg)} font-black">${avg}% · ${letterGrade(avg)}</span></td>
        </tr>`;
    }).join('');

    // Roster Array
    const stuRows = stuAvgData.sort((a, b) => (a.avg ?? -1) - (b.avg ?? -1)).map(s => `
        <tr class="gb-row">
            <td class="px-4 py-3">
                <div class="flex items-center gap-2">
                    <div class="h-8 w-8 bg-gradient-to-br from-emerald-400 to-teal-500 text-white rounded-lg flex items-center justify-center font-black text-xs flex-shrink-0">${(s.name || '?').charAt(0).toUpperCase()}</div>
                    <span class="font-black text-slate-700 text-sm">${s.name || 'Unnamed'}</span>
                </div>
            </td>
            <td class="px-4 py-3 text-center">${s.avg !== null ? `<span class="${gradeColorClass(s.avg)} font-black">${s.avg}% · ${letterGrade(s.avg)}</span>` : '<span class="text-slate-400">—</span>'}</td>
            <td class="px-4 py-3 text-center">${standingBadge(s.avg)}</td>
            <td class="px-4 py-3 text-center text-slate-500 font-semibold text-sm">${s.gradeCount}</td>
            <td class="px-4 py-3 text-right">
                <a href="../students/students.html" class="text-xs font-black text-emerald-700 hover:bg-emerald-600 hover:text-white border border-emerald-200 px-3 py-1 rounded-lg transition">View Student</a>
            </td>
        </tr>`).join('');

    // Inject Panel HTML
    document.getElementById('classPanelBody').innerHTML = `
        ${teacher ? `<div class="bg-white border border-slate-200 rounded-2xl p-5 shadow-sm flex items-center gap-4">
            <div class="h-12 w-12 bg-gradient-to-br from-blue-500 to-blue-600 text-white rounded-xl flex items-center justify-center font-black text-lg shadow-sm flex-shrink-0">${teacher.name.charAt(0)}</div>
            <div>
                <p class="font-black text-slate-800">${teacher.name}</p>
                <p class="text-xs text-slate-400 font-semibold">${teacher.email || ''} ${teacher.phone ? '· ' + teacher.phone : ''}</p>
                <p class="text-xs text-slate-500 font-semibold mt-1">Code: <span class="font-mono font-black text-blue-600">${teacher.loginCode}</span></p>
            </div>
        </div>` : '<div class="bg-amber-50 border border-amber-200 rounded-2xl p-4 text-sm font-bold text-amber-700"><i class="fa-solid fa-triangle-exclamation mr-2"></i>No teacher assigned to this class yet.</div>'}
        
        <div class="grid grid-cols-3 gap-3">
            <div class="bg-white border border-slate-200 rounded-2xl p-4 text-center shadow-sm">
                <p class="text-xs font-black text-slate-400 uppercase tracking-wider mb-1">Class Avg</p>
                <p class="text-3xl font-black ${classAvg !== null ? gradeColorClass(classAvg) : 'text-slate-400'}">${classAvg !== null ? classAvg + '%' : '—'}</p>
            </div>
            <div class="bg-white border border-slate-200 rounded-2xl p-4 text-center shadow-sm">
                <p class="text-xs font-black text-slate-400 uppercase tracking-wider mb-1">Students</p>
                <p class="text-3xl font-black text-indigo-600">${students.length}</p>
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
                ${!total || (dist.a===0 && dist.b===0 && dist.c===0 && dist.d===0 && dist.f===0) ? `<div class="dist-seg bg-slate-300" style="width:100%">No Data</div>` : ''}
            </div>
            <div class="flex gap-4 mt-3 flex-wrap">
                ${[['A', dist.a, 'bg-emerald-500'], ['B', dist.b, 'bg-blue-500'], ['C', dist.c, 'bg-teal-500'], ['D', dist.d, 'bg-amber-500'], ['F', dist.f, 'bg-red-500']].map(([l, n, c]) => `<div class="flex items-center gap-1.5"><div class="w-3 h-3 rounded-sm ${c}"></div><span class="text-xs font-black text-slate-600">${l}: ${n}</span></div>`).join('')}
            </div>
        </div>

        ${atRiskStudents.length ? `<div class="bg-red-50 border border-red-200 rounded-2xl p-5">
            <h4 class="font-black text-red-700 text-sm uppercase tracking-wider mb-3 flex items-center gap-2"><i class="fa-solid fa-triangle-exclamation"></i>At Risk (${atRiskStudents.length})</h4>
            <div class="space-y-2">
                ${atRiskStudents.map(s => {
                    const sg = grades.filter(g => g.studentId === s.id);
                    const avg = sg.length ? Math.round(sg.reduce((a, g) => a + (g.max ? g.score / g.max * 100 : 0), 0) / sg.length) : null;
                    return `<div class="flex items-center justify-between bg-white border border-red-100 rounded-xl p-3"><span class="font-black text-slate-700 text-sm">${s.name}</span><span class="font-black text-red-600">${avg !== null ? avg + '%' : '—'}</span></div>`;
                }).join('')}
            </div>
        </div>` : ''}

        ${subjectRows ? `<div class="bg-white border border-slate-200 rounded-2xl overflow-hidden shadow-sm">
            <div class="px-5 py-4 border-b border-slate-100 bg-slate-50"><h4 class="font-black text-slate-700 text-sm uppercase tracking-wider">Subject Breakdown</h4></div>
            <div class="overflow-x-auto"><table class="w-full text-sm"><thead class="bg-slate-50 text-slate-500 text-xs uppercase tracking-wider border-b border-slate-200"><tr><th class="px-4 py-3 font-black text-left">Subject</th><th class="px-4 py-3 font-black text-center">Students</th><th class="px-4 py-3 font-black text-center">Grades</th><th class="px-4 py-3 font-black text-center">Average</th></tr></thead><tbody>${subjectRows}</tbody></table></div>
        </div>` : ''}

        <div class="bg-white border border-slate-200 rounded-2xl overflow-hidden shadow-sm">
            <div class="px-5 py-4 border-b border-slate-100 bg-slate-50"><h4 class="font-black text-slate-700 text-sm uppercase tracking-wider">Student Roster</h4></div>
            <div class="overflow-x-auto">
                <table class="w-full text-sm">
                    <thead class="bg-slate-50 text-slate-500 text-xs uppercase tracking-wider border-b border-slate-200">
                        <tr>
                            <th class="px-4 py-3 font-black text-left">Student</th>
                            <th class="px-4 py-3 font-black text-center">Average</th>
                            <th class="px-4 py-3 font-black text-center">Standing</th>
                            <th class="px-4 py-3 font-black text-center">Grades</th>
                            <th class="px-4 py-3 font-black text-right"></th>
                        </tr>
                    </thead>
                    <tbody>${stuRows || '<tr><td colspan="5" class="px-4 py-8 text-center text-slate-400 italic">No students.</td></tr>'}</tbody>
                </table>
            </div>
        </div>
    `;
};

window.closeClassPanel = function() {
    closeOverlay('classPanel', 'classPanelInner', true);
};

// ── INITIALIZE ────────────────────────────────────────────────────────────
document.addEventListener('DOMContentLoaded', loadSemestersDropdown);
