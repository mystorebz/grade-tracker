import { db } from '../../assets/js/firebase-init.js';
import { collection, getDocs, doc, getDoc, query, where } from "https://www.gstatic.com/firebasejs/10.7.1/firebase-firestore.js";
import { requireAuth } from '../../assets/js/auth.js';
import { injectStudentLayout } from '../../assets/js/layout-student.js';
import { calculateWeightedAverage, letterGrade, gradeColorClass } from '../../assets/js/utils.js'; // Ensure these are in utils.js

// ── 1. INIT & AUTH ────────────────────────────────────────────────────────
const session = requireAuth('student', '../login.html');

injectStudentLayout('analytics', 'Performance Analytics', 'Longitudinal academic and behavioral trends');

document.getElementById('displayStudentName').innerText  = session.studentData.name || 'Student';
document.getElementById('studentAvatar').innerText       = (session.studentData.name || 'S').charAt(0).toUpperCase();
document.getElementById('displayStudentClass').innerText = session.studentData.className ? `Class: ${session.studentData.className}` : 'Unassigned Class';

const loader = document.getElementById('analyticsLoader');
const content = document.getElementById('analyticsContent');
const periodSelect = document.getElementById('analyticsPeriodSelect');

// State Caches
let allSemesters = [];
let allGrades = [];
let allEvals = [];
let teacherRubricsCache = {}; 

// ── 2. ESCAPE HTML HELPER ─────────────────────────────────────────────────
function escHtml(str) {
    if (!str) return '';
    return String(str).replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/"/g,'&quot;');
}

// UI Helpers
function generateSkillBar(label, value) {
    const pct = (value / 5) * 100;
    const colorClass = value >= 4 ? 'bg-emerald-500' : value >= 3 ? 'bg-blue-500' : value >= 2 ? 'bg-amber-500' : 'bg-red-500';
    return `
    <div class="mb-3 last:mb-0">
        <div class="flex justify-between items-center mb-1">
            <span class="text-[10px] font-black text-slate-500 uppercase tracking-wider">${label}</span>
            <span class="text-[11px] font-black text-slate-800">${value}/5</span>
        </div>
        <div class="h-1.5 w-full bg-slate-100 rounded-full overflow-hidden">
            <div class="h-full ${colorClass} rounded-full" style="width: ${pct}%"></div>
        </div>
    </div>`;
}

// ── 3. FETCH DATA ─────────────────────────────────────────────────────────
async function loadAnalyticsData() {
    try {
        const schoolId = session.schoolId;
        const studentId = session.studentId;

        // Fetch School & Semesters
        const schoolSnap = await getDoc(doc(db, 'schools', schoolId));
        let activeSemId = null;
        if (schoolSnap.exists()) {
            document.getElementById('displaySchoolName').innerText = schoolSnap.data().schoolName;
            activeSemId = schoolSnap.data().activeSemesterId;
        }

        const semSnap = await getDocs(collection(db, 'schools', schoolId, 'semesters'));
        allSemesters = semSnap.docs.map(d => ({ id: d.id, ...d.data() })).sort((a, b) => (a.order || 0) - (b.order || 0));

        // Populate Dropdown
        if (allSemesters.length === 0) {
            periodSelect.innerHTML = '<option value="">No periods available</option>';
            loader.classList.add('hidden');
            return;
        }

        periodSelect.innerHTML = allSemesters.map(s => 
            `<option value="${s.id}">${s.name}${s.id === activeSemId ? ' (Current)' : ''}</option>`
        ).join('');
        
        // Default to active semester if available, else latest
        periodSelect.value = activeSemId || allSemesters[allSemesters.length - 1].id;

        // Fetch All Grades for this school
        const gSnap = await getDocs(query(collection(db, 'students', studentId, 'grades'), where('schoolId', '==', schoolId)));
        allGrades = gSnap.docs.map(d => ({ id: d.id, ...d.data() }));

        // Fetch All Evaluations for this school
        const eSnap = await getDocs(query(collection(db, 'students', studentId, 'evaluations'), where('schoolId', '==', schoolId)));
        allEvals = eSnap.docs.map(d => ({ id: d.id, ...d.data() }));

        // Cache Teacher Rubrics
        const uniqueTeacherIds = [...new Set(allGrades.map(g => g.teacherId).filter(Boolean))];
        for (const tId of uniqueTeacherIds) {
            if (!teacherRubricsCache[tId]) {
                try {
                    const tSnap = await getDoc(doc(db, 'teachers', tId));
                    teacherRubricsCache[tId] = tSnap.exists() ? (tSnap.data().gradeTypes || tSnap.data().customGradeTypes || []) : [];
                } catch (e) {
                    teacherRubricsCache[tId] = [];
                }
            }
        }

        // Setup Listener & Initial Render
        periodSelect.addEventListener('change', () => renderDashboardForPeriod(periodSelect.value));
        renderDashboardForPeriod(periodSelect.value);

        loader.classList.add('hidden');
        content.classList.remove('hidden');

    } catch (e) {
        console.error("Error loading analytics data:", e);
        loader.innerHTML = '<p class="text-red-500 font-bold text-sm">Failed to load analytics data.</p>';
    }
}

// ── 4. RENDER DASHBOARD ───────────────────────────────────────────────────
function renderDashboardForPeriod(semesterId) {
    // 1. Filter Data for selected period
    const periodGrades = allGrades.filter(g => g.semesterId === semesterId);
    const periodEvals = allEvals.filter(e => e.semesterId === semesterId).sort((a, b) => new Date(b.date || b.createdAt) - new Date(a.date || a.createdAt));

    // 2. Process Academic Data
    const bySub = {};
    let totalAssessments = 0;

    periodGrades.forEach(g => {
        const sub = g.subject || 'Uncategorized';
        if (!bySub[sub]) bySub[sub] = [];
        bySub[sub].push(g);
        if (g.max) totalAssessments++;
    });

    let sumSubjAvgs = 0;
    let subjCount = 0;
    const subjectStats = [];

    for (const sub in bySub) {
        const tId = bySub[sub][0]?.teacherId;
        const rubric = tId ? (teacherRubricsCache[tId] || []) : [];
        const avgRaw = calculateWeightedAverage(bySub[sub], rubric);
        const avg = avgRaw !== null ? Math.round(avgRaw) : 0;
        
        if (avgRaw !== null) {
            sumSubjAvgs += avg;
            subjCount++;
        }
        
        subjectStats.push({
            subject: sub,
            count: bySub[sub].length,
            average: avg
        });
    }

    // Sort subjects alphabetically
    subjectStats.sort((a, b) => a.subject.localeCompare(b.subject));

    const termAvg = subjCount > 0 ? Math.round(sumSubjAvgs / subjCount) : 0;
    const overallLetter = subjCount > 0 ? letterGrade(termAvg) : 'N/A';

    // 3. Update KPIs
    document.getElementById('statTermAvg').textContent = subjCount > 0 ? `${termAvg}%` : '—';
    document.getElementById('statLetter').textContent = overallLetter;
    document.getElementById('statAssessments').textContent = totalAssessments;
    document.getElementById('statTotalEvals').textContent = periodEvals.length;

    // Add color to KPIs based on performance
    const avgColor = termAvg >= 90 ? 'text-emerald-600' : termAvg >= 80 ? 'text-blue-600' : termAvg >= 70 ? 'text-teal-600' : termAvg >= 65 ? 'text-amber-600' : 'text-red-600';
    document.getElementById('statTermAvg').className = `text-2xl font-black ${subjCount > 0 ? avgColor : 'text-slate-800'}`;
    document.getElementById('statLetter').className = `text-2xl font-black ${subjCount > 0 ? avgColor : 'text-slate-800'}`;

    // 4. Render Subject Bar Chart
    const chartContainer = document.getElementById('subjectChartContainer');
    if (subjectStats.length === 0) {
        chartContainer.innerHTML = `<div class="w-full text-center text-slate-400 font-bold text-xs pb-10">No grades recorded for this period.</div>`;
    } else {
        chartContainer.innerHTML = subjectStats.map(s => {
            const barHeight = Math.max(s.average, 5); // Minimum height for visibility
            const colorClass = s.average >= 90 ? 'bg-emerald-400' : s.average >= 80 ? 'bg-blue-400' : s.average >= 70 ? 'bg-teal-400' : s.average >= 65 ? 'bg-amber-400' : 'bg-red-400';
            
            return `
            <div class="flex flex-col items-center group w-full max-w-[60px]">
                <span class="text-[10px] font-black text-slate-500 mb-2 opacity-0 group-hover:opacity-100 transition-opacity">${s.average}%</span>
                <div class="w-full ${colorClass} rounded-t-md transition-all duration-500" style="height: ${barHeight}%;"></div>
                <span class="text-[9px] font-bold text-slate-400 mt-2 truncate w-full text-center block px-1" title="${s.subject}">${s.subject.substring(0,3).toUpperCase()}</span>
            </div>`;
        }).join('');
    }

    // 5. Render Detailed Table
    const tbody = document.getElementById('academicTableBody');
    if (subjectStats.length === 0) {
        tbody.innerHTML = `<tr><td colspan="4" class="py-6 text-center text-xs font-bold text-slate-400">No data available.</td></tr>`;
    } else {
        tbody.innerHTML = subjectStats.map(s => {
            const ltr = letterGrade(s.average);
            const badgeColor = s.average >= 90 ? 'text-emerald-700 bg-emerald-50 border-emerald-200' : s.average >= 80 ? 'text-blue-700 bg-blue-50 border-blue-200' : s.average >= 70 ? 'text-teal-700 bg-teal-50 border-teal-200' : s.average >= 65 ? 'text-amber-700 bg-amber-50 border-amber-200' : 'text-red-700 bg-red-50 border-red-200';
            
            return `
            <tr class="border-b border-slate-50 last:border-0 hover:bg-slate-50 transition">
                <td class="py-3 px-2 text-xs font-black text-slate-800 truncate max-w-[120px]" title="${s.subject}">${s.subject}</td>
                <td class="py-3 px-2 text-xs font-bold text-slate-500 text-center">${s.count}</td>
                <td class="py-3 px-2 text-sm font-black text-slate-800 text-center">${s.average}%</td>
                <td class="py-3 px-2 text-center">
                    <span class="px-2 py-0.5 rounded text-[10px] font-black border ${badgeColor}">${ltr}</span>
                </td>
            </tr>`;
        }).join('');
    }

    // 6. Render Matrix Evaluations
    const evalsContainer = document.getElementById('evaluationsContainer');
    const noEvalsMsg = document.getElementById('noEvalsMsg');

    if (periodEvals.length === 0) {
        evalsContainer.innerHTML = '';
        noEvalsMsg.classList.remove('hidden');
    } else {
        noEvalsMsg.classList.add('hidden');
        evalsContainer.innerHTML = periodEvals.map(e => {
            const dateStr = e.date ? new Date(e.date).toLocaleDateString('en-US', { month: 'long', day: 'numeric', year: 'numeric' }) : 'Unknown Date';
            
            // Calculate average for this specific evaluation matrix
            let evalAvg = 0;
            if (e.ratings) {
                const vals = Object.values(e.ratings);
                if (vals.length > 0) evalAvg = (vals.reduce((a, b) => a + b, 0) / vals.length).toFixed(1);
            }

            let badgeHtml = '';
            let metricsHtml = '';
            let textHtml = '';

            if (e.type === 'academic') {
                badgeHtml = `<span class="px-3 py-1 rounded-full text-[9px] font-black uppercase tracking-widest border text-blue-700 bg-blue-50 border-blue-200"><i class="fa-solid fa-book-open mr-1"></i> Academic Matrix</span>`;
                metricsHtml = `
                    ${generateSkillBar('Subject Mastery', e.ratings.mastery)}
                    ${generateSkillBar('Task Execution', e.ratings.execution)}
                    ${generateSkillBar('Class Engagement', e.ratings.engagement)}
                `;
                textHtml = `
                    <div class="mb-3"><p class="text-[9px] font-black text-slate-400 uppercase tracking-widest mb-1">Key Strengths</p><p class="text-xs font-semibold text-slate-700">${escHtml(e.written?.strengths || 'N/A')}</p></div>
                    <div class="mb-3"><p class="text-[9px] font-black text-slate-400 uppercase tracking-widest mb-1">Areas for Growth</p><p class="text-xs font-semibold text-slate-700">${escHtml(e.written?.growth || 'N/A')}</p></div>
                    <div><p class="text-[9px] font-black text-slate-400 uppercase tracking-widest mb-1">Actionable Steps</p><p class="text-xs font-semibold text-slate-700">${escHtml(e.written?.steps || 'N/A')}</p></div>
                `;
            } else if (e.type === 'behavioral') {
                badgeHtml = `<span class="px-3 py-1 rounded-full text-[9px] font-black uppercase tracking-widest border text-red-700 bg-red-50 border-red-200"><i class="fa-solid fa-triangle-exclamation mr-1"></i> Conduct Matrix</span>`;
                metricsHtml = `
                    ${generateSkillBar('Rule Adherence', e.ratings.adherence)}
                    ${generateSkillBar('Conflict Resolution', e.ratings.resolution)}
                    ${generateSkillBar('Respect Authority', e.ratings.respect)}
                `;
                textHtml = `
                    <div class="mb-3"><p class="text-[9px] font-black text-slate-400 uppercase tracking-widest mb-1">Conduct Description</p><p class="text-xs font-semibold text-slate-700">${escHtml(e.written?.description || 'N/A')}</p></div>
                    <div class="mb-3"><p class="text-[9px] font-black text-slate-400 uppercase tracking-widest mb-1">Prior Interventions</p><p class="text-xs font-semibold text-slate-700">${escHtml(e.written?.prior || 'N/A')}</p></div>
                    <div class="mb-3"><p class="text-[9px] font-black text-slate-400 uppercase tracking-widest mb-1">Action Plan</p><p class="text-xs font-semibold text-slate-700">${escHtml(e.written?.actionPlan || 'N/A')}</p></div>
                    <div class="p-2 bg-red-50 border border-red-100 rounded-lg mt-2"><p class="text-[9px] font-black text-red-600 uppercase tracking-widest mb-0.5">Action Taken</p><p class="text-xs font-black text-red-800">${escHtml(e.status || 'N/A')}</p></div>
                `;
            } else if (e.type === 'end_of_year') {
                badgeHtml = `<span class="px-3 py-1 rounded-full text-[9px] font-black uppercase tracking-widest border text-amber-700 bg-amber-50 border-amber-200"><i class="fa-solid fa-award mr-1"></i> Year-End Summary</span>`;
                metricsHtml = `
                    ${generateSkillBar('Academic Growth', e.ratings.growth)}
                    ${generateSkillBar('Social Dynamics', e.ratings.social)}
                    ${generateSkillBar('Resilience', e.ratings.resilience)}
                `;
                textHtml = `
                    <div class="mb-3"><p class="text-[9px] font-black text-slate-400 uppercase tracking-widest mb-1">Year-in-Review Narrative</p><p class="text-xs font-semibold text-slate-700">${escHtml(e.written?.narrative || 'N/A')}</p></div>
                    <div class="mb-3"><p class="text-[9px] font-black text-slate-400 uppercase tracking-widest mb-1">Recommended Interventions</p><p class="text-xs font-semibold text-slate-700">${escHtml(e.written?.interventions || 'None')}</p></div>
                    <div class="p-2 bg-amber-50 border border-amber-100 rounded-lg mt-2"><p class="text-[9px] font-black text-amber-600 uppercase tracking-widest mb-0.5">Promotion Status</p><p class="text-xs font-black text-amber-800">${escHtml(e.status || 'N/A')}</p></div>
                `;
            }

            return `
            <div class="bg-white border border-slate-200 rounded-3xl p-5 shadow-sm">
                <div class="flex justify-between items-start mb-5 pb-4 border-b border-slate-100">
                    <div>
                        <div class="flex items-center gap-3 mb-1">
                            <div class="h-8 w-8 bg-slate-100 text-slate-600 rounded-lg flex items-center justify-center font-black text-sm">${evalAvg}</div>
                            <h4 class="font-black text-base text-slate-800">${e.semesterName || 'Evaluation'}</h4>
                        </div>
                        <p class="text-[10px] font-bold text-slate-400 uppercase tracking-widest mt-1">${dateStr} • By ${escHtml(e.teacherName || 'Teacher')}</p>
                    </div>
                    ${badgeHtml}
                </div>
                
                <div class="grid grid-cols-1 md:grid-cols-12 gap-6">
                    <div class="md:col-span-5 bg-slate-50 border border-slate-100 rounded-2xl p-4">
                        <p class="text-[10px] font-black text-slate-800 uppercase tracking-widest mb-3">Performance Matrix</p>
                        ${metricsHtml}
                    </div>
                    <div class="md:col-span-7">
                        ${textHtml}
                    </div>
                </div>
            </div>`;
        }).join('');
    }
}

// ── INITIALIZE ─────────────────────────────────────────────────────────────
document.addEventListener('DOMContentLoaded', loadAnalyticsData);
