import { db } from '../../assets/js/firebase-init.js';
import { collection, getDocs, doc, getDoc } from "https://www.gstatic.com/firebasejs/10.7.1/firebase-firestore.js";
import { requireAuth } from '../../assets/js/auth.js';
import { injectStudentLayout } from '../../assets/js/layout-student.js';
import { calculateWeightedAverage, letterGrade } from '../../assets/js/utils.js';

// ── 1. AUTH & LAYOUT (Safe Top-Level Execution) ───────────────────────────
const session = requireAuth('student', '../login.html');

// Inject layout immediately (Matches working home.js structure)
injectStudentLayout('analytics', 'Performance Evaluations', 'Review official teacher evaluations and matrices');

// State Caches
let allSemesters = [];
let allGrades = [];
let allEvals = [];
let teacherRubricsCache = {}; 
let schoolData = {};

// ── 2. ESCAPE HTML HELPER ─────────────────────────────────────────────────
function escHtml(str) {
    if (!str) return '';
    return String(str).replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/"/g,'&quot;');
}

// UI Helpers
function generateSkillBar(label, value) {
    const val = Number(value) || 0;
    const pct = (val / 5) * 100;
    const colorClass = val >= 4 ? 'bg-emerald-500' : val >= 3 ? 'bg-blue-500' : val >= 2 ? 'bg-amber-500' : 'bg-red-500';
    return `
    <div class="mb-4 last:mb-0">
        <div class="flex justify-between items-center mb-1.5">
            <span class="text-xs font-black text-slate-500 uppercase tracking-wider">${label}</span>
            <span class="text-xs font-black text-slate-800">${val}/5</span>
        </div>
        <div class="h-2 w-full bg-slate-100 rounded-full overflow-hidden">
            <div class="h-full ${colorClass} rounded-full" style="width: ${pct}%"></div>
        </div>
    </div>`;
}

// ── 3. FETCH DATA (Waits for DOM to prevent crashes) ──────────────────────
async function loadAnalyticsData() {
    const loader = document.getElementById('analyticsLoader');
    const content = document.getElementById('analyticsContent');
    const periodSelect = document.getElementById('analyticsPeriodSelect');

    try {
        const schoolId = session.schoolId;
        const studentId = session.studentId;

        // 1. Update UI Elements safely now that DOM is ready
        document.getElementById('displayStudentName').innerText  = session.studentData.name || 'Student';
        document.getElementById('studentAvatar').innerText       = (session.studentData.name || 'S').charAt(0).toUpperCase();
        document.getElementById('displayStudentClass').innerText = session.studentData.className ? `Class: ${session.studentData.className}` : 'Unassigned Class';

        // 2. Fetch School Data
        const schoolSnap = await getDoc(doc(db, 'schools', schoolId));
        let activeSemId = null;
        if (schoolSnap.exists()) {
            schoolData = schoolSnap.data();
            const elSchool = document.getElementById('displaySchoolName');
            if (elSchool) elSchool.innerText = schoolData.schoolName || 'ConnectUs School';
            activeSemId = schoolData.activeSemesterId;
        }

        const semSnap = await getDocs(collection(db, 'schools', schoolId, 'semesters'));
        allSemesters = semSnap.docs.map(d => ({ id: d.id, ...d.data() })).sort((a, b) => (a.order || 0) - (b.order || 0));

        if (allSemesters.length === 0) {
            if (periodSelect) periodSelect.innerHTML = '<option value="">No periods available</option>';
            if (loader) loader.classList.add('hidden');
            return;
        }

        if (periodSelect) {
            periodSelect.innerHTML = allSemesters.map(s => 
                `<option value="${s.id}">${s.name}${s.id === activeSemId ? ' (Current)' : ''}</option>`
            ).join('');
            periodSelect.value = activeSemId || allSemesters[allSemesters.length - 1].id;
        }

        // 3. Fetch Grades (Filtered in JS to prevent Firebase Index errors)
        const gSnap = await getDocs(collection(db, 'students', studentId, 'grades'));
        allGrades = gSnap.docs.map(d => ({ id: d.id, ...d.data() })).filter(g => g.schoolId === schoolId);

        // 4. Fetch Official Evaluations (Filtered in JS to prevent Firebase Index errors)
        const eSnap = await getDocs(collection(db, 'students', studentId, 'evaluations'));
        allEvals = eSnap.docs.map(d => ({ id: d.id, ...d.data() })).filter(e => e.schoolId === schoolId);

        // 5. Cache Teacher Rubrics
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

        // 6. Setup Listener & Initial Render
        if (periodSelect) {
            periodSelect.addEventListener('change', () => renderDashboardForPeriod(periodSelect.value));
            renderDashboardForPeriod(periodSelect.value);
        }

        if (loader) loader.classList.add('hidden');
        if (content) content.classList.remove('hidden');

    } catch (e) {
        console.error("[Evaluations] Critical error loading data:", e);
        if (loader) loader.innerHTML = `<div class="text-center"><i class="fa-solid fa-triangle-exclamation text-red-500 text-3xl mb-3"></i><p class="text-red-500 font-bold text-base">Failed to load evaluation data.</p><p class="text-xs text-slate-400 mt-2">Check browser console for details.</p></div>`;
    }
}

// ── 4. RENDER DASHBOARD ───────────────────────────────────────────────────
function renderDashboardForPeriod(semesterId) {
    const periodGrades = allGrades.filter(g => g.semesterId === semesterId);
    const periodEvals = allEvals.filter(e => e.semesterId === semesterId).sort((a, b) => new Date(b.date || b.createdAt) - new Date(a.date || a.createdAt));

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
        
        subjectStats.push({ subject: sub, count: bySub[sub].length, average: avg });
    }

    subjectStats.sort((a, b) => a.subject.localeCompare(b.subject));

    const termAvg = subjCount > 0 ? Math.round(sumSubjAvgs / subjCount) : 0;
    const overallLetter = subjCount > 0 ? letterGrade(termAvg) : 'N/A';

    document.getElementById('statTermAvg').textContent = subjCount > 0 ? `${termAvg}%` : '—';
    document.getElementById('statLetter').textContent = overallLetter;
    document.getElementById('statAssessments').textContent = totalAssessments;
    document.getElementById('statTotalEvals').textContent = periodEvals.length;

    const avgColor = termAvg >= 90 ? 'text-emerald-600' : termAvg >= 80 ? 'text-blue-600' : termAvg >= 70 ? 'text-teal-600' : termAvg >= 65 ? 'text-amber-600' : 'text-red-600';
    document.getElementById('statTermAvg').className = `text-3xl font-black ${subjCount > 0 ? avgColor : 'text-slate-800'}`;
    document.getElementById('statLetter').className = `text-3xl font-black ${subjCount > 0 ? avgColor : 'text-slate-800'}`;

    // Subject Bar Chart
    const chartContainer = document.getElementById('subjectChartContainer');
    if (subjectStats.length === 0) {
        chartContainer.innerHTML = `<div class="w-full text-center text-slate-400 font-bold text-sm pb-10">No grades recorded for this period.</div>`;
    } else {
        chartContainer.innerHTML = subjectStats.map(s => {
            const barHeight = Math.max(s.average, 5);
            const colorClass = s.average >= 90 ? 'bg-emerald-400' : s.average >= 80 ? 'bg-blue-400' : s.average >= 70 ? 'bg-teal-400' : s.average >= 65 ? 'bg-amber-400' : 'bg-red-400';
            
            return `
            <div class="flex flex-col items-center group w-full max-w-[70px]">
                <span class="text-xs font-black text-slate-500 mb-2 opacity-0 group-hover:opacity-100 transition-opacity">${s.average}%</span>
                <div class="w-full ${colorClass} rounded-t-md transition-all duration-500" style="height: ${barHeight}%;"></div>
                <span class="text-[10px] md:text-xs font-bold text-slate-400 mt-3 truncate w-full text-center block px-1" title="${s.subject}">${s.subject.substring(0,3).toUpperCase()}</span>
            </div>`;
        }).join('');
    }

    // Detailed Table
    const tbody = document.getElementById('academicTableBody');
    if (subjectStats.length === 0) {
        tbody.innerHTML = `<tr><td colspan="4" class="py-8 text-center text-sm font-bold text-slate-400">No data available.</td></tr>`;
    } else {
        tbody.innerHTML = subjectStats.map(s => {
            const ltr = letterGrade(s.average);
            const badgeColor = s.average >= 90 ? 'text-emerald-700 bg-emerald-50 border-emerald-200' : s.average >= 80 ? 'text-blue-700 bg-blue-50 border-blue-200' : s.average >= 70 ? 'text-teal-700 bg-teal-50 border-teal-200' : s.average >= 65 ? 'text-amber-700 bg-amber-50 border-amber-200' : 'text-red-700 bg-red-50 border-red-200';
            
            return `
            <tr class="hover:bg-slate-50 transition">
                <td class="py-4 px-3 text-sm font-black text-slate-800 truncate max-w-[150px]" title="${s.subject}">${s.subject}</td>
                <td class="py-4 px-3 text-sm font-bold text-slate-500 text-center">${s.count}</td>
                <td class="py-4 px-3 text-base font-black text-slate-800 text-center">${s.average}%</td>
                <td class="py-4 px-3 text-center">
                    <span class="px-3 py-1 rounded-md text-xs font-black border ${badgeColor}">${ltr}</span>
                </td>
            </tr>`;
        }).join('');
    }

    // Matrix Evaluations
    const evalsContainer = document.getElementById('evaluationsContainer');
    const noEvalsMsg = document.getElementById('noEvalsMsg');

    if (periodEvals.length === 0) {
        evalsContainer.innerHTML = '';
        noEvalsMsg.classList.remove('hidden');
    } else {
        noEvalsMsg.classList.add('hidden');
        evalsContainer.innerHTML = periodEvals.map(e => {
            const dateStr = e.date ? new Date(e.date).toLocaleDateString('en-US', { month: 'long', day: 'numeric', year: 'numeric' }) : 'Unknown Date';
            
            let evalAvg = 0;
            if (e.ratings) {
                const vals = Object.values(e.ratings);
                if (vals.length > 0) evalAvg = (vals.reduce((a, b) => Number(a) + Number(b), 0) / vals.length).toFixed(1);
            }

            let badgeHtml = '';
            let metricsHtml = '';
            let textHtml = '';

            if (e.type === 'academic') {
                badgeHtml = `<span class="px-4 py-1.5 rounded-full text-[10px] font-black uppercase tracking-widest border text-blue-700 bg-blue-50 border-blue-200"><i class="fa-solid fa-book-open mr-1"></i> Academic Matrix</span>`;
                metricsHtml = `
                    ${generateSkillBar('Subject Mastery', e.ratings.mastery)}
                    ${generateSkillBar('Task Execution', e.ratings.execution)}
                    ${generateSkillBar('Class Engagement', e.ratings.engagement)}
                `;
                textHtml = `
                    <div class="mb-4"><p class="text-xs font-black text-slate-400 uppercase tracking-widest mb-1.5">Key Strengths</p><p class="text-sm font-semibold text-slate-700">${escHtml(e.written?.strengths || 'N/A')}</p></div>
                    <div class="mb-4"><p class="text-xs font-black text-slate-400 uppercase tracking-widest mb-1.5">Areas for Growth</p><p class="text-sm font-semibold text-slate-700">${escHtml(e.written?.growth || 'N/A')}</p></div>
                    <div><p class="text-xs font-black text-slate-400 uppercase tracking-widest mb-1.5">Actionable Steps</p><p class="text-sm font-semibold text-slate-700">${escHtml(e.written?.steps || 'N/A')}</p></div>
                `;
            } else if (e.type === 'behavioral') {
                badgeHtml = `<span class="px-4 py-1.5 rounded-full text-[10px] font-black uppercase tracking-widest border text-red-700 bg-red-50 border-red-200"><i class="fa-solid fa-triangle-exclamation mr-1"></i> Conduct Matrix</span>`;
                metricsHtml = `
                    ${generateSkillBar('Rule Adherence', e.ratings.adherence)}
                    ${generateSkillBar('Conflict Resolution', e.ratings.resolution)}
                    ${generateSkillBar('Respect Authority', e.ratings.respect)}
                `;
                textHtml = `
                    <div class="mb-4"><p class="text-xs font-black text-slate-400 uppercase tracking-widest mb-1.5">Conduct Description</p><p class="text-sm font-semibold text-slate-700">${escHtml(e.written?.description || 'N/A')}</p></div>
                    <div class="mb-4"><p class="text-xs font-black text-slate-400 uppercase tracking-widest mb-1.5">Prior Interventions</p><p class="text-sm font-semibold text-slate-700">${escHtml(e.written?.prior || 'N/A')}</p></div>
                    <div class="mb-4"><p class="text-xs font-black text-slate-400 uppercase tracking-widest mb-1.5">Action Plan</p><p class="text-sm font-semibold text-slate-700">${escHtml(e.written?.actionPlan || 'N/A')}</p></div>
                    <div class="p-3 bg-red-50 border border-red-100 rounded-xl mt-3"><p class="text-[10px] font-black text-red-600 uppercase tracking-widest mb-1">Action Taken</p><p class="text-sm font-black text-red-800">${escHtml(e.status || 'N/A')}</p></div>
                `;
            } else if (e.type === 'end_of_year') {
                badgeHtml = `<span class="px-4 py-1.5 rounded-full text-[10px] font-black uppercase tracking-widest border text-amber-700 bg-amber-50 border-amber-200"><i class="fa-solid fa-award mr-1"></i> Year-End Summary</span>`;
                metricsHtml = `
                    ${generateSkillBar('Academic Growth', e.ratings.growth)}
                    ${generateSkillBar('Social Dynamics', e.ratings.social)}
                    ${generateSkillBar('Resilience', e.ratings.resilience)}
                `;
                textHtml = `
                    <div class="mb-4"><p class="text-xs font-black text-slate-400 uppercase tracking-widest mb-1.5">Year-in-Review Narrative</p><p class="text-sm font-semibold text-slate-700">${escHtml(e.written?.narrative || 'N/A')}</p></div>
                    <div class="mb-4"><p class="text-xs font-black text-slate-400 uppercase tracking-widest mb-1.5">Recommended Interventions</p><p class="text-sm font-semibold text-slate-700">${escHtml(e.written?.interventions || 'None')}</p></div>
                    <div class="p-3 bg-amber-50 border border-amber-100 rounded-xl mt-3"><p class="text-[10px] font-black text-amber-600 uppercase tracking-widest mb-1">Promotion Status</p><p class="text-sm font-black text-amber-800">${escHtml(e.status || 'N/A')}</p></div>
                `;
            } else if (e.type === 'academic_report_card') {
                badgeHtml = `<span class="px-4 py-1.5 rounded-full text-[10px] font-black uppercase tracking-widest border text-emerald-700 bg-emerald-50 border-emerald-200"><i class="fa-solid fa-file-contract mr-1"></i> Report Card Eval</span>`;
                metricsHtml = `
                    ${generateSkillBar('Comprehension', e.ratings.academicComprehension)}
                    ${generateSkillBar('Attitude & Work', e.ratings.attitudeWork)}
                    ${generateSkillBar('Effort', e.ratings.effortResilience)}
                    ${generateSkillBar('Participation', e.ratings.participation)}
                    ${generateSkillBar('Organization', e.ratings.organization)}
                    ${generateSkillBar('Behavior', e.ratings.behavior)}
                    ${generateSkillBar('Peer Relations', e.ratings.peerRelations)}
                    ${generateSkillBar('Punctuality', e.ratings.punctualityRating)}
                `;
                textHtml = `
                    <div class="mb-4"><p class="text-xs font-black text-slate-400 uppercase tracking-widest mb-1.5">Teacher Comments</p><p class="text-sm font-semibold text-slate-700 whitespace-pre-wrap">${escHtml(e.comment || 'N/A')}</p></div>
                `;
            }

            return `
            <div class="bg-white border border-slate-200 rounded-3xl p-6 md:p-8 shadow-sm relative group transition-shadow hover:shadow-md">
                <div class="absolute top-6 right-6 flex gap-2">
                    <button onclick="printEvaluation('${e.id}')" class="flex items-center gap-2 bg-slate-50 hover:bg-indigo-50 text-slate-600 hover:text-indigo-600 font-bold px-4 py-2 rounded-lg border border-slate-200 hover:border-indigo-200 transition text-xs shadow-sm">
                        <i class="fa-solid fa-print"></i> Print
                    </button>
                </div>

                <div class="flex flex-col md:flex-row md:items-center justify-between mb-6 pb-5 border-b border-slate-100 gap-4 pr-24">
                    <div>
                        <div class="flex items-center gap-4 mb-2">
                            <div class="h-10 w-10 bg-slate-100 text-slate-600 rounded-xl flex items-center justify-center font-black text-base">${evalAvg}</div>
                            <h4 class="font-black text-xl text-slate-800">${escHtml(e.semesterName || 'Evaluation')}</h4>
                        </div>
                        <p class="text-xs font-bold text-slate-400 uppercase tracking-widest mt-1">${dateStr} • Prepared By ${escHtml(e.teacherName || 'Teacher')}</p>
                    </div>
                    <div>${badgeHtml}</div>
                </div>
                
                <div class="grid grid-cols-1 md:grid-cols-12 gap-8">
                    <div class="md:col-span-4 bg-slate-50 border border-slate-100 rounded-2xl p-5">
                        <p class="text-xs font-black text-slate-800 uppercase tracking-widest mb-4 pb-2 border-b border-slate-200">Performance Matrix</p>
                        ${metricsHtml}
                    </div>
                    <div class="md:col-span-8">
                        ${textHtml}
                    </div>
                </div>
            </div>`;
        }).join('');
    }
}

// ── 5. PROFESSIONAL PRINT GENERATOR ───────────────────────────────────────
window.printEvaluation = function(evalId) {
    const e = allEvals.find(x => x.id === evalId);
    if (!e) return;

    const docTitle = "OFFICIAL PERFORMANCE EVALUATION";
    let typeLabel = "Evaluation";
    let metricsHtml = "";
    let textHtml = "";

    if (e.type === 'academic') {
        typeLabel = "Academic Matrix Evaluation";
        metricsHtml = `
            <tr><td>Subject Mastery</td><td class="tc font-mono">${e.ratings?.mastery || 0} / 5</td></tr>
            <tr><td>Task Execution</td><td class="tc font-mono">${e.ratings?.execution || 0} / 5</td></tr>
            <tr><td>Class Engagement</td><td class="tc font-mono">${e.ratings?.engagement || 0} / 5</td></tr>
        `;
        textHtml = `
            <div class="feedback-section">
                <h3>Key Strengths</h3>
                <p>${escHtml(e.written?.strengths || 'N/A')}</p>
            </div>
            <div class="feedback-section">
                <h3>Areas for Growth</h3>
                <p>${escHtml(e.written?.growth || 'N/A')}</p>
            </div>
            <div class="feedback-section">
                <h3>Actionable Steps</h3>
                <p>${escHtml(e.written?.steps || 'N/A')}</p>
            </div>
        `;
    } else if (e.type === 'behavioral') {
        typeLabel = "Conduct Matrix Evaluation";
        metricsHtml = `
            <tr><td>Rule Adherence</td><td class="tc font-mono">${e.ratings?.adherence || 0} / 5</td></tr>
            <tr><td>Conflict Resolution</td><td class="tc font-mono">${e.ratings?.resolution || 0} / 5</td></tr>
            <tr><td>Respect Authority</td><td class="tc font-mono">${e.ratings?.respect || 0} / 5</td></tr>
        `;
        textHtml = `
            <div class="feedback-section">
                <h3>Conduct Description</h3>
                <p>${escHtml(e.written?.description || 'N/A')}</p>
            </div>
            <div class="feedback-section">
                <h3>Prior Interventions</h3>
                <p>${escHtml(e.written?.prior || 'N/A')}</p>
            </div>
            <div class="feedback-section">
                <h3>Action Plan</h3>
                <p>${escHtml(e.written?.actionPlan || 'N/A')}</p>
            </div>
            <div class="status-box">
                <strong>Action Taken:</strong> ${escHtml(e.status || 'N/A')}
            </div>
        `;
    } else if (e.type === 'end_of_year') {
        typeLabel = "End of Year Summary Evaluation";
        metricsHtml = `
            <tr><td>Academic Growth</td><td class="tc font-mono">${e.ratings?.growth || 0} / 5</td></tr>
            <tr><td>Social Dynamics</td><td class="tc font-mono">${e.ratings?.social || 0} / 5</td></tr>
            <tr><td>Resilience</td><td class="tc font-mono">${e.ratings?.resilience || 0} / 5</td></tr>
        `;
        textHtml = `
            <div class="feedback-section">
                <h3>Year-in-Review Narrative</h3>
                <p>${escHtml(e.written?.narrative || 'N/A')}</p>
            </div>
            <div class="feedback-section">
                <h3>Recommended Interventions</h3>
                <p>${escHtml(e.written?.interventions || 'None')}</p>
            </div>
            <div class="status-box">
                <strong>Promotion Status:</strong> ${escHtml(e.status || 'N/A')}
            </div>
        `;
    } else if (e.type === 'academic_report_card') {
        typeLabel = "Report Card Evaluation";
        metricsHtml = `
            <tr><td>Comprehension</td><td class="tc font-mono">${e.ratings?.academicComprehension || 0} / 5</td></tr>
            <tr><td>Attitude & Work</td><td class="tc font-mono">${e.ratings?.attitudeWork || 0} / 5</td></tr>
            <tr><td>Effort</td><td class="tc font-mono">${e.ratings?.effortResilience || 0} / 5</td></tr>
            <tr><td>Participation</td><td class="tc font-mono">${e.ratings?.participation || 0} / 5</td></tr>
            <tr><td>Organization</td><td class="tc font-mono">${e.ratings?.organization || 0} / 5</td></tr>
            <tr><td>Behavior</td><td class="tc font-mono">${e.ratings?.behavior || 0} / 5</td></tr>
            <tr><td>Peer Relations</td><td class="tc font-mono">${e.ratings?.peerRelations || 0} / 5</td></tr>
            <tr><td>Punctuality</td><td class="tc font-mono">${e.ratings?.punctualityRating || 0} / 5</td></tr>
        `;
        textHtml = `
            <div class="feedback-section">
                <h3>Teacher Comments</h3>
                <p>${escHtml(e.comment || 'No comments recorded.')}</p>
            </div>
        `;
    }

    const dateStr = e.date ? new Date(e.date).toLocaleDateString('en-US', { month: 'long', day: 'numeric', year: 'numeric' }) : 'Unknown Date';
    const logoSrc = schoolData.logo || '../../assets/images/logo.png';

    let html = `<html><head><title>${docTitle} - ${escHtml(session.studentData.name)}</title>
    <style>
        @import url('https://fonts.googleapis.com/css2?family=DM+Sans:wght@400;500;600;700;800;900&family=DM+Mono:wght@400;500;700&display=swap');
        @media print {
            * { -webkit-print-color-adjust: exact !important; print-color-adjust: exact !important; }
            body { padding: 0; margin: 0; }
            @page { margin: 1.5cm; }
        }
        
        body { font-family: 'DM Sans', sans-serif; padding: 40px; color: #0f172a; line-height: 1.6; background: white; }
        .header { display: flex; flex-direction: column; align-items: center; border-bottom: 3px solid #0f172a; padding-bottom: 25px; margin-bottom: 30px; text-align: center; }
        .logo { max-height: 70px; max-width: 250px; object-fit: contain; margin-bottom: 15px; }
        .header h1 { margin: 0 0 6px 0; font-size: 26px; color: #0f172a; text-transform: uppercase; letter-spacing: 0.05em; font-weight: 900; }
        .header h2 { margin: 0 0 4px 0; font-size: 16px; color: #4f46e5; font-weight: 800; letter-spacing: 0.15em; text-transform: uppercase; }
        
        .info-grid { background: #f8fafc; padding: 20px; border-radius: 8px; border: 1px solid #e2e8f0; margin-bottom: 40px; display: grid; grid-template-columns: 1fr 1fr; gap: 16px; }
        .info-grid div { font-size: 14px; color: #0f172a; font-weight: 700; }
        .info-grid strong { font-size: 11px; color: #64748b; text-transform: uppercase; letter-spacing: 0.15em; display: block; margin-bottom: 4px; font-weight: 800; }
        
        .section-title { font-size: 14px; font-weight: 800; background: #0f172a; color: white; text-transform: uppercase; letter-spacing: 0.15em; padding: 12px 16px; margin: 0 0 20px 0; border-radius: 6px; }
        
        .content-grid { display: grid; grid-template-columns: 1fr 2fr; gap: 40px; margin-bottom: 40px; }
        
        table { width: 100%; border-collapse: collapse; margin-bottom: 20px; }
        th, td { border-bottom: 1px solid #f1f5f9; padding: 12px 16px; text-align: left; font-size: 13px; font-weight: 600; }
        th { background: #f8fafc; color: #64748b; font-weight: 800; text-transform: uppercase; font-size: 10px; letter-spacing: 0.1em; border-bottom: 2px solid #cbd5e1; }
        .tc { text-align: center; }
        .font-mono { font-family: 'DM Mono', monospace; font-weight: 700; }
        
        .feedback-section { margin-bottom: 25px; }
        .feedback-section h3 { margin: 0 0 8px 0; font-size: 11px; color: #64748b; text-transform: uppercase; letter-spacing: 0.1em; font-weight: 800; border-bottom: 1px solid #e2e8f0; padding-bottom: 6px; }
        .feedback-section p { margin: 0; font-size: 13px; font-weight: 500; color: #334155; white-space: pre-wrap; }
        
        .status-box { background: #f1f5f9; border: 1px solid #cbd5e1; padding: 16px; border-radius: 6px; margin-top: 20px; font-size: 14px; color: #0f172a; }

        .footer { font-size: 11px; color: #94a3b8; margin-top: 50px; text-align: center; border-top: 1px solid #e2e8f0; padding-top: 20px; font-weight: 600; font-style: italic; }
    </style></head><body>

    <div class="header">
        <img src="${logoSrc}" class="logo" onerror="this.style.display='none'">
        <h1>${escHtml(schoolData.schoolName || 'ConnectUs School')}</h1>
        <h2>${docTitle}</h2>
    </div>

    <div class="info-grid">
        <div><strong>Student Name</strong> ${escHtml(session.studentData.name || 'Unknown')}</div>
        <div><strong>Student ID</strong> ${escHtml(session.studentData.studentId || 'N/A')}</div>
        <div><strong>Academic Period</strong> ${escHtml(e.semesterName || 'Unknown')}</div>
        <div><strong>Evaluator</strong> ${escHtml(e.teacherName || 'Teacher')}</div>
        <div><strong>Evaluation Type</strong> ${typeLabel}</div>
        <div><strong>Date Filed</strong> ${dateStr}</div>
    </div>

    <h3 class="section-title">Evaluation Details</h3>
    
    <div class="content-grid">
        <div>
            <table>
                <thead><tr><th>Matrix Criteria</th><th class="tc">Rating</th></tr></thead>
                <tbody>${metricsHtml}</tbody>
            </table>
        </div>
        <div>
            ${textHtml}
        </div>
    </div>

    <div class="footer">This document is a certified evaluation record generated securely by the ConnectUs Family Portal.</div>
    </body></html>`;
    
    const w = window.open('', '_blank'); 
    w.document.write(html); 
    w.document.close();
    setTimeout(() => w.print(), 600);
};

// ── INITIALIZE (Waits for DOM) ────────────────────────────────────────────
document.addEventListener('DOMContentLoaded', loadAnalyticsData);
