import { db } from '../../assets/js/firebase-init.js';
import { collection, getDocs, query, where } from "https://www.gstatic.com/firebasejs/10.7.1/firebase-firestore.js";
import { requireAuth } from '../../assets/js/auth.js';
import { injectAdminLayout } from '../../assets/js/layout-admin.js';
import { openOverlay, closeOverlay, letterGrade, gradeColorClass } from '../../assets/js/utils.js';

const session = requireAuth('admin', '../login.html');
injectAdminLayout('classes', 'Classes', 'Performance overview for each class', false, true);

const tbody = document.getElementById('classesTableBody');
const loadingMsg = document.getElementById('classesLoadingMsg');
const globalPeriodSelect = document.getElementById('globalPeriodSelect');

let classDataMap = new Map();
let currentClassName = null;

// ── 1. INITIALIZE ────────────────────────────────────────────────────────────
async function loadSemestersDropdown() {
    try {
        const snap = await getDocs(collection(db, 'schools', session.schoolId, 'semesters'));
        const semesters = snap.docs.map(d => ({ id: d.id, ...d.data() })).sort((a, b) => a.order - b.order);
        
        globalPeriodSelect.innerHTML = semesters.map(s => 
            `<option value="${s.id}" ${s.id === session.activeSemesterId ? 'selected' : ''}>${s.name} ${s.archived ? '(Archived)' : ''}</option>`
        ).join('');

        globalPeriodSelect.addEventListener('change', loadClasses);
        loadClasses();
    } catch (error) { console.error("Semesters load error:", error); }
}

// ── 2. LOAD MAIN TABLE ───────────────────────────────────────────────────────
async function loadClasses() {
    loadingMsg.classList.remove('hidden');
    tbody.innerHTML = `<tr><td colspan="9" class="px-6 py-16 text-center text-slate-400 font-semibold"><i class="fa-solid fa-spinner fa-spin text-indigo-400 text-2xl mb-3 block"></i>Loading classes...</td></tr>`;
    classDataMap.clear();

    const semId = globalPeriodSelect.value || session.activeSemesterId || '';

    try {
        const [tSnap, sSnap] = await Promise.all([
            getDocs(query(collection(db, 'teachers'), where('currentSchoolId', '==', session.schoolId))),
            getDocs(query(collection(db, 'students'), where('currentSchoolId', '==', session.schoolId), where('enrollmentStatus', '==', 'Active')))
        ]);

        const teachers = tSnap.docs.map(d => ({ id: d.id, ...d.data() }));
        const students = sSnap.docs.map(d => ({ id: d.id, ...d.data() }));

        const classesByName = {};
        students.forEach(s => {
            const cls = s.className || 'Unassigned';
            if (!classesByName[cls]) classesByName[cls] = { students: [], teacher: null };
            classesByName[cls].students.push(s);
        });

        teachers.forEach(t => {
            const tClasses = t.classes || (t.className ? [t.className] : []);
            tClasses.forEach(cls => { if (classesByName[cls]) classesByName[cls].teacher = t; });
        });

        const classStats = await Promise.all(Object.entries(classesByName).sort((a, b) => a[0].localeCompare(b[0])).map(async ([className, classData]) => {
            const allGrades = [];
            await Promise.all(classData.students.map(async s => {
                const gSnap = await getDocs(query(collection(db, 'schools', session.schoolId, 'students', s.id, 'grades'), where('semesterId', '==', semId)));
                gSnap.forEach(d => allGrades.push({ ...d.data(), studentId: s.id }));
            }));
            
            const stuAvgs = classData.students.map(s => {
                const sg = allGrades.filter(g => g.studentId === s.id);
                return sg.length ? sg.reduce((a, g) => a + (g.max ? g.score / g.max * 100 : 0), 0) / sg.length : null;
            }).filter(a => a !== null);
            
            const classAvg = stuAvgs.length ? Math.round(stuAvgs.reduce((a, b) => a + b, 0) / stuAvgs.length) : null;
            const allPcts = allGrades.map(g => g.max ? Math.round(g.score / g.max * 100) : 0);

            classDataMap.set(className, { 
                className, 
                teacher: classData.teacher, 
                students: classData.students, 
                studentCount: classData.students.length, // Ensure count is cached
                grades: allGrades, 
                classAvg, 
                subjectCount: new Set(allGrades.map(g => g.subject)).size,
                highest: allPcts.length ? Math.max(...allPcts) : null,
                lowest: allPcts.length ? Math.min(...allPcts) : null,
                atRisk: stuAvgs.filter(a => a < 65).length,
                excelling: stuAvgs.filter(a => a >= 85).length
            });
            return classDataMap.get(className);
        }));

        tbody.innerHTML = classStats.map(c => `
            <tr class="gb-row">
                <td class="px-6 py-4"><div class="flex items-center gap-3"><div class="w-10 h-10 bg-indigo-600 text-white rounded-xl flex items-center justify-center font-black text-sm">${c.className.charAt(0)}</div><span class="font-black text-slate-800">${c.className}</span></div></td>
                <td class="px-6 py-4">${c.teacher ? `<span class="font-bold text-slate-700 text-sm">${c.teacher.name}</span>` : '<span class="text-slate-400 italic">Unassigned</span>'}</td>
                <td class="px-6 py-4 text-center font-black text-slate-700">${c.studentCount}</td>
                <td class="px-6 py-4 text-center font-bold text-slate-500">${c.subjectCount}</td>
                <td class="px-6 py-4 text-center font-black ${gradeColorClass(c.classAvg)}">${c.classAvg !== null ? c.classAvg + '%' : '—'}</td>
                <td class="px-6 py-4 text-center font-black text-emerald-600">${c.highest !== null ? c.highest + '%' : '—'}</td>
                <td class="px-6 py-4 text-center font-black text-rose-600">${c.lowest !== null ? c.lowest + '%' : '—'}</td>
                <td class="px-6 py-4 text-center"><span class="font-black ${c.atRisk ? 'text-red-600 bg-red-50 px-2 py-0.5 rounded' : 'text-slate-400'}">${c.atRisk}</span></td>
                <td class="px-6 py-4 text-right"><button onclick="window.openClassPanel('${c.className}')" class="bg-indigo-50 hover:bg-indigo-600 hover:text-white text-indigo-700 font-black px-4 py-2 rounded-lg text-xs transition border border-indigo-200">View Details</button></td>
            </tr>`).join('');
        loadingMsg.classList.add('hidden');
    } catch (e) { console.error(e); loadingMsg.classList.add('hidden'); }
}

// ── 3. PANEL TABS & RENDERING ────────────────────────────────────────────────
window.switchClassTab = function(tabName) {
    document.querySelectorAll('.panel-tab').forEach(t => t.classList.remove('active'));
    document.querySelector(`.panel-tab[data-tab="${tabName}"]`).classList.add('active');
    renderPanelContent(tabName);
};

window.openClassPanel = function(className) {
    currentClassName = className;
    const data = classDataMap.get(className);
    if (!data) return;

    // Explicitly set the title and meta logic before opening
    document.getElementById('cpPanelTitle').textContent = data.className;
    const semName = globalPeriodSelect.options[globalPeriodSelect.selectedIndex]?.text || '';
    document.getElementById('cpPanelMeta').textContent = `${semName} · ${data.studentCount} students`;

    window.switchClassTab('overview');
    openOverlay('classPanel', 'classPanelInner', true);
};

function renderPanelContent(tab) {
    const data = classDataMap.get(currentClassName);
    if (!data) return;
    const container = document.getElementById('classPanelBody');

    if (tab === 'overview') {
        const dist = { a:0, b:0, c:0, d:0, f:0 };
        const stuData = data.students.map(s => {
            const sg = data.grades.filter(g => g.studentId === s.id);
            const avg = sg.length ? Math.round(sg.reduce((a, g) => a + (g.max ? g.score / g.max * 100 : 0), 0) / sg.length) : null;
            if (avg !== null) {
                if (avg >= 90) dist.a++; else if (avg >= 80) dist.b++; else if (avg >= 70) dist.c++; else if (avg >= 65) dist.d++; else dist.f++;
            }
            return { ...s, avg };
        });

        container.innerHTML = `
            <div class="grid grid-cols-3 gap-4 mb-6">
                <div class="bg-white p-5 border border-slate-200 rounded-xl text-center"><p class="text-[10px] font-black text-slate-400 uppercase tracking-widest">Class Average</p><p class="text-3xl font-black ${gradeColorClass(data.classAvg)}">${data.classAvg !== null ? data.classAvg + '%' : '—'}</p></div>
                <div class="bg-white p-5 border border-slate-200 rounded-xl text-center"><p class="text-[10px] font-black text-slate-400 uppercase tracking-widest">Students</p><p class="text-3xl font-black text-indigo-600">${data.studentCount}</p></div>
                <div class="bg-white p-5 border border-slate-200 rounded-xl text-center"><p class="text-[10px] font-black text-slate-400 uppercase tracking-widest">At Risk</p><p class="text-3xl font-black text-red-600">${data.atRisk}</p></div>
            </div>

            <div class="bg-white p-6 border border-slate-200 rounded-xl mb-6">
                <h4 class="text-xs font-black text-slate-500 uppercase tracking-widest mb-4">Grade Distribution</h4>
                <div class="dist-bar h-4 bg-slate-100 rounded-full overflow-hidden flex">
                    <div class="bg-emerald-500 h-full" style="width:${data.studentCount ? dist.a/data.studentCount*100 : 0}%"></div>
                    <div class="bg-blue-500 h-full" style="width:${data.studentCount ? dist.b/data.studentCount*100 : 0}%"></div>
                    <div class="bg-teal-500 h-full" style="width:${data.studentCount ? dist.c/data.studentCount*100 : 0}%"></div>
                    <div class="bg-amber-500 h-full" style="width:${data.studentCount ? dist.d/data.studentCount*100 : 0}%"></div>
                    <div class="bg-rose-500 h-full" style="width:${data.studentCount ? dist.f/data.studentCount*100 : 0}%"></div>
                </div>
            </div>

            <div class="grid grid-cols-2 gap-6">
                <div class="space-y-3">
                    <h4 class="text-xs font-black text-emerald-600 uppercase tracking-widest">Excelling Students (85%+)</h4>
                    ${stuData.filter(s => s.avg !== null && s.avg >= 85).map(s => `<div class="bg-white p-3 border border-emerald-100 rounded-lg flex justify-between"><b>${escHtml(s.name)}</b><span class="text-emerald-600 font-black">${s.avg}%</span></div>`).join('') || '<p class="text-slate-400 italic text-sm">None</p>'}
                </div>
                <div class="space-y-3">
                    <h4 class="text-xs font-black text-rose-600 uppercase tracking-widest">At-Risk Students (<65%)</h4>
                    ${stuData.filter(s => s.avg !== null && s.avg < 65).map(s => `<div class="bg-white p-3 border border-rose-100 rounded-lg flex justify-between"><b>${escHtml(s.name)}</b><span class="text-rose-600 font-black">${s.avg}%</span></div>`).join('') || '<p class="text-slate-400 italic text-sm">None</p>'}
                </div>
            </div>
        `;
    } 
    
    else if (tab === 'subjects') {
        const bySubject = {};
        data.grades.forEach(g => {
            if (!bySubject[g.subject]) bySubject[g.subject] = [];
            bySubject[g.subject].push(g);
        });

        container.innerHTML = Object.entries(bySubject).map(([sub, sg]) => {
            const avg = Math.round(sg.reduce((a, g) => a + (g.max ? g.score / g.max * 100 : 0), 0) / sg.length);
            
            const assessments = [...new Set(sg.map(g => g.title))].map(title => {
                const ag = sg.filter(x => x.title === title);
                const aAvg = Math.round(ag.reduce((a, x) => a + (x.max ? x.score / x.max * 100 : 0), 0) / ag.length);
                return `<div class="flex justify-between py-2 border-b border-slate-200 last:border-0 text-sm"><span class="font-semibold text-slate-600">${escHtml(title)}</span><b class="${gradeColorClass(aAvg)}">${aAvg}%</b></div>`;
            }).join('');

            return `
                <div class="bg-white border border-slate-200 rounded-xl mb-3 overflow-hidden">
                    <div class="px-5 py-4 flex justify-between items-center cursor-pointer hover:bg-slate-50 transition" onclick="this.nextElementSibling.classList.toggle('open'); this.querySelector('.fa-chevron-down').classList.toggle('rotate-180');">
                        <span class="font-black text-slate-700">${escHtml(sub)}</span>
                        <span class="font-black ${gradeColorClass(avg)}">${avg}% · ${letterGrade(avg)} <i class="fa-solid fa-chevron-down ml-2 text-slate-300 transition-transform duration-200"></i></span>
                    </div>
                    <div class="subject-body bg-slate-50">
                        <div class="px-5 pb-4 pt-2 border-t border-slate-100 flex flex-col gap-1">
                            ${assessments}
                        </div>
                    </div>
                </div>
            `;
        }).join('') || '<p class="text-center py-10 text-slate-400 italic">No subject data found.</p>';
    }

    else if (tab === 'students') {
        const stuRows = data.students.map(s => {
            const sg = data.grades.filter(g => g.studentId === s.id);
            const avg = sg.length ? Math.round(sg.reduce((a, g) => a + (g.max ? g.score / g.max * 100 : 0), 0) / sg.length) : null;
            return `
                <tr class="hover:bg-slate-50 transition">
                    <td class="px-5 py-3 font-bold text-slate-700">${escHtml(s.name)}</td>
                    <td class="px-5 py-3 text-center font-black ${gradeColorClass(avg)}">${avg !== null ? avg + '%' : '—'}</td>
                    <td class="px-5 py-3 text-center text-slate-500 font-semibold text-xs">${sg.length}</td>
                    <td class="px-5 py-3 text-right"><a href="../students/students.html?viewStudent=${s.id}" class="text-xs font-black text-indigo-600 hover:text-indigo-800 hover:underline transition">View Profile</a></td>
                </tr>`;
        }).join('');

        container.innerHTML = `
            <div class="bg-white border border-slate-200 rounded-xl overflow-hidden">
                <table class="w-full">
                    <thead class="bg-slate-50 text-[10px] uppercase font-black text-slate-400 border-b border-slate-200">
                        <tr><th class="px-5 py-3 text-left">Student</th><th class="px-5 py-3 text-center">Avg</th><th class="px-5 py-3 text-center">Grades</th><th class="px-5 py-3"></th></tr>
                    </thead>
                    <tbody class="divide-y divide-slate-100">${stuRows}</tbody>
                </table>
            </div>`;
    }
}

window.closeClassPanel = () => closeOverlay('classPanel', 'classPanelInner', true);
document.addEventListener('DOMContentLoaded', loadSemestersDropdown);
