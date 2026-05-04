import { db } from '../../assets/js/firebase-init.js';
import { collection, getDocs, doc, getDoc } from "https://www.gstatic.com/firebasejs/10.7.1/firebase-firestore.js";
import { requireAuth } from '../../assets/js/auth.js';
import { injectStudentLayout } from '../../assets/js/layout-student.js';
import { calculateWeightedAverage, letterGrade } from '../../assets/js/utils.js';

// ── 1. AUTH & LAYOUT ──────────────────────────────────────────────────────
const session = requireAuth('student', '../login.html');
injectStudentLayout('analytics', 'Performance Evaluations', 'Review official teacher evaluations and matrices');

// ── 2. STATE ─────────────────────────────────────────────────────────────
let allSemesters        = [];
let allGrades           = [];
let allEvals            = [];
let teacherRubricsCache = {};
let schoolData          = {};

// ── 3. HELPERS ────────────────────────────────────────────────────────────
function escHtml(str) {
    if (!str) return '';
    return String(str).replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/"/g,'&quot;');
}

function skillBar(label, value) {
    const val = Number(value) || 0;
    const pct = (val / 5) * 100;
    const col = val >= 4 ? 'bg-emerald-500' : val >= 3 ? 'bg-blue-500' : val >= 2 ? 'bg-amber-500' : 'bg-red-500';
    return `
    <div class="mb-4 last:mb-0">
        <div class="flex justify-between items-center mb-1.5">
            <span class="text-xs font-black text-slate-500 uppercase tracking-wider">${escHtml(label)}</span>
            <span class="text-xs font-black text-slate-800">${val}/5</span>
        </div>
        <div class="h-2 w-full bg-slate-100 rounded-full overflow-hidden">
            <div class="h-full ${col} rounded-full" style="width:${pct}%"></div>
        </div>
    </div>`;
}

// ── 4. TOGGLE EVAL CARD ───────────────────────────────────────────────────
window.toggleEvalCard = function(id) {
    const body   = document.getElementById(`eval-body-${id}`);
    const chevron = document.getElementById(`eval-chev-${id}`);
    if (!body) return;
    const isOpen = body.style.display !== 'none';
    body.style.display    = isOpen ? 'none' : 'block';
    if (chevron) chevron.style.transform = isOpen ? 'rotate(0deg)' : 'rotate(180deg)';
};

// ── 5. LOAD DATA ──────────────────────────────────────────────────────────
async function loadAnalyticsData() {
    const loader       = document.getElementById('analyticsLoader');
    const content      = document.getElementById('analyticsContent');
    const periodSelect = document.getElementById('analyticsPeriodSelect');

    try {
        const { schoolId, studentId } = session;

        document.getElementById('displayStudentName').innerText  = session.studentData.name || 'Student';
        document.getElementById('studentAvatar').innerText       = (session.studentData.name || 'S').charAt(0).toUpperCase();
        document.getElementById('displayStudentClass').innerText = session.studentData.className
            ? `Class: ${session.studentData.className}` : 'Unassigned Class';

        // School data
        const schoolSnap = await getDoc(doc(db, 'schools', schoolId));
        let activeSemId  = null;
        if (schoolSnap.exists()) {
            schoolData = schoolSnap.data();
            const elSchool = document.getElementById('displaySchoolName');
            if (elSchool) elSchool.innerText = schoolData.schoolName || 'ConnectUs School';
            activeSemId = schoolData.activeSemesterId;
        }

        // Semesters
        const semSnap = await getDocs(collection(db, 'schools', schoolId, 'semesters'));
        allSemesters  = semSnap.docs.map(d => ({ id: d.id, ...d.data() })).sort((a,b) => (a.order||0)-(b.order||0));

        if (!allSemesters.length) {
            if (periodSelect) periodSelect.innerHTML = '<option value="">No periods available</option>';
            if (loader) loader.classList.add('hidden');
            return;
        }

        // ── Populate page period select ──────────────────────────────────
        if (periodSelect) {
            periodSelect.innerHTML = allSemesters.map(s =>
                `<option value="${s.id}">${escHtml(s.name)}${s.id === activeSemId ? ' (Current)' : ''}</option>`
            ).join('');
            periodSelect.value = activeSemId || allSemesters[allSemesters.length - 1].id;
        }

        // ── Populate TOPBAR period display (student layout uses a static span) ──
        const activeSemName = allSemesters.find(s => s.id === activeSemId)?.name || '';
        const topDisplay = document.getElementById('activeSemesterDisplay');
        if (topDisplay && activeSemName) topDisplay.textContent = activeSemName;
        const sbPeriod = document.getElementById('sb-period');
        if (sbPeriod && activeSemName) sbPeriod.textContent = activeSemName;

        // Teacher rubrics
        const tId = session.studentData?.teacherId;
        if (tId && !teacherRubricsCache[tId]) {
            const tSnap = await getDoc(doc(db, 'teachers', tId));
            teacherRubricsCache[tId] = tSnap.exists()
                ? (tSnap.data().gradeTypes || tSnap.data().customGradeTypes || []) : [];
        }

        // All teachers at school (for coverage)
        const tAllSnap = await getDocs(collection(db, 'teachers'));
        // (we'll cache per grade below)

        // Grades — global student path
        const gSnap = await getDocs(collection(db, 'students', studentId, 'grades'));
        allGrades   = gSnap.docs.map(d => ({ id: d.id, ...d.data() })).filter(g => g.schoolId === schoolId);

        // Evaluations — global student path
        const eSnap = await getDocs(collection(db, 'students', studentId, 'evaluations'));
        allEvals    = eSnap.docs.map(d => ({ id: d.id, ...d.data() })).filter(e => e.schoolId === schoolId);

        // Cache additional teacher rubrics from grade data
        const uniqueTeacherIds = [...new Set(allGrades.map(g => g.teacherId).filter(Boolean))];
        for (const tid of uniqueTeacherIds) {
            if (!teacherRubricsCache[tid]) {
                try {
                    const ts = await getDoc(doc(db, 'teachers', tid));
                    teacherRubricsCache[tid] = ts.exists()
                        ? (ts.data().gradeTypes || ts.data().customGradeTypes || []) : [];
                } catch(e) { teacherRubricsCache[tid] = []; }
            }
        }

        // Setup listener and initial render
        if (periodSelect) {
            periodSelect.addEventListener('change', () => renderDashboardForPeriod(periodSelect.value));
            renderDashboardForPeriod(periodSelect.value);
        }

        if (loader)   loader.classList.add('hidden');
        if (content)  content.classList.remove('hidden');

    } catch(e) {
        console.error('[Evaluations] Critical error:', e);
        if (loader) loader.innerHTML = `
            <div class="text-center">
                <i class="fa-solid fa-triangle-exclamation text-red-500 text-3xl mb-3"></i>
                <p class="text-red-500 font-bold">Failed to load evaluation data.</p>
            </div>`;
    }
}

// ── 6. RENDER DASHBOARD ───────────────────────────────────────────────────
function renderDashboardForPeriod(semesterId) {
    const periodGrades = allGrades.filter(g => g.semesterId === semesterId);
    const periodEvals  = allEvals.filter(e => e.semesterId === semesterId)
                                 .sort((a,b) => new Date(b.date || b.createdAt) - new Date(a.date || a.createdAt));

    // Subject averages
    const bySub = {};
    let totalAssessments = 0;
    periodGrades.forEach(g => {
        const sub = g.subject || 'Uncategorized';
        if (!bySub[sub]) bySub[sub] = [];
        bySub[sub].push(g);
        if (g.max) totalAssessments++;
    });

    let sumSubjAvgs = 0, subjCount = 0;
    const subjectStats = [];

    for (const sub in bySub) {
        const tid    = bySub[sub][0]?.teacherId;
        const rubric = tid ? (teacherRubricsCache[tid] || []) : [];
        const avgRaw = calculateWeightedAverage(bySub[sub], rubric);
        const avg    = avgRaw !== null ? Math.round(avgRaw) : 0;
        if (avgRaw !== null) { sumSubjAvgs += avg; subjCount++; }
        subjectStats.push({ subject: sub, count: bySub[sub].length, average: avg });
    }
    subjectStats.sort((a,b) => a.subject.localeCompare(b.subject));

    const termAvg     = subjCount > 0 ? Math.round(sumSubjAvgs / subjCount) : 0;
    const overallLtr  = subjCount > 0 ? letterGrade(termAvg) : 'N/A';
    const avgColorCls = termAvg >= 90 ? 'text-emerald-600' : termAvg >= 80 ? 'text-blue-600' :
                        termAvg >= 70 ? 'text-teal-600'    : termAvg >= 65 ? 'text-amber-600' : 'text-red-600';

    document.getElementById('statTermAvg').textContent  = subjCount > 0 ? `${termAvg}%` : '—';
    document.getElementById('statLetter').textContent   = overallLtr;
    document.getElementById('statAssessments').textContent = totalAssessments;
    document.getElementById('statTotalEvals').textContent  = periodEvals.length;
    document.getElementById('statTermAvg').className = `text-3xl font-black ${subjCount > 0 ? avgColorCls : 'text-slate-800'}`;
    document.getElementById('statLetter').className  = `text-3xl font-black ${subjCount > 0 ? avgColorCls : 'text-slate-800'}`;

    // Subject bar chart
    const chartEl = document.getElementById('subjectChartContainer');
    if (!subjectStats.length) {
        chartEl.innerHTML = `<div class="w-full text-center text-slate-400 font-bold text-sm pb-10">No grades recorded for this period.</div>`;
    } else {
        chartEl.innerHTML = subjectStats.map(s => {
            const h   = Math.max(s.average, 5);
            const col = s.average >= 90 ? 'bg-emerald-400' : s.average >= 80 ? 'bg-blue-400' :
                        s.average >= 70 ? 'bg-teal-400'    : s.average >= 65 ? 'bg-amber-400' : 'bg-red-400';
            return `
            <div class="flex flex-col items-center group w-full max-w-[70px]">
                <span class="text-xs font-black text-slate-500 mb-2 opacity-0 group-hover:opacity-100 transition-opacity">${s.average}%</span>
                <div class="w-full ${col} rounded-t-md transition-all duration-500" style="height:${h}%;"></div>
                <span class="text-[10px] font-bold text-slate-400 mt-3 truncate w-full text-center block px-1" title="${escHtml(s.subject)}">${s.subject.substring(0,3).toUpperCase()}</span>
            </div>`;
        }).join('');
    }

    // Academic details table
    const tbody = document.getElementById('academicTableBody');
    if (!subjectStats.length) {
        tbody.innerHTML = `<tr><td colspan="4" class="py-8 text-center text-sm font-bold text-slate-400">No data available.</td></tr>`;
    } else {
        tbody.innerHTML = subjectStats.map(s => {
            const ltr = letterGrade(s.average);
            const bc  = s.average >= 90 ? 'text-emerald-700 bg-emerald-50 border-emerald-200' :
                        s.average >= 80 ? 'text-blue-700 bg-blue-50 border-blue-200' :
                        s.average >= 70 ? 'text-teal-700 bg-teal-50 border-teal-200' :
                        s.average >= 65 ? 'text-amber-700 bg-amber-50 border-amber-200' :
                                          'text-red-700 bg-red-50 border-red-200';
            return `
            <tr class="hover:bg-slate-50 transition">
                <td class="py-4 px-3 text-sm font-black text-slate-800 truncate max-w-[150px]" title="${escHtml(s.subject)}">${escHtml(s.subject)}</td>
                <td class="py-4 px-3 text-sm font-bold text-slate-500 text-center">${s.count}</td>
                <td class="py-4 px-3 text-base font-black text-slate-800 text-center">${s.average}%</td>
                <td class="py-4 px-3 text-center"><span class="px-3 py-1 rounded-md text-xs font-black border ${bc}">${ltr}</span></td>
            </tr>`;
        }).join('');
    }

    // Evaluations
    const evalsContainer = document.getElementById('evaluationsContainer');
    const noEvalsMsg     = document.getElementById('noEvalsMsg');

    if (!periodEvals.length) {
        evalsContainer.innerHTML = '';
        noEvalsMsg.classList.remove('hidden');
        return;
    }

    noEvalsMsg.classList.add('hidden');

    evalsContainer.innerHTML = periodEvals.map(e => {
        const dateStr = e.date
            ? new Date(e.date).toLocaleDateString('en-US', { month:'long', day:'numeric', year:'numeric' })
            : 'Unknown Date';

        let evalAvg = 0;
        if (e.ratings) {
            const vals = Object.values(e.ratings).map(Number).filter(v => !isNaN(v));
            if (vals.length) evalAvg = (vals.reduce((a,b) => a+b, 0) / vals.length).toFixed(1);
        }

        // Type config
        const typeConfig = {
            academic:             { label: 'Academic Matrix',     icon: 'fa-book-open',        badge: 'text-blue-700 bg-blue-50 border-blue-200'    },
            behavioral:           { label: 'Conduct Matrix',      icon: 'fa-triangle-exclamation', badge: 'text-red-700 bg-red-50 border-red-200'   },
            end_of_year:          { label: 'Year-End Summary',    icon: 'fa-award',            badge: 'text-amber-700 bg-amber-50 border-amber-200'  },
            academic_report_card: { label: 'Report Card Eval',   icon: 'fa-file-contract',    badge: 'text-emerald-700 bg-emerald-50 border-emerald-200' }
        };
        const tc = typeConfig[e.type] || { label: 'Evaluation', icon: 'fa-clipboard', badge: 'text-slate-700 bg-slate-50 border-slate-200' };

        // Metrics & written content (for expanded body)
        let metricsHtml = '';
        let writtenHtml = '';

        if (e.type === 'academic') {
            metricsHtml = skillBar('Subject Mastery', e.ratings?.mastery) + skillBar('Task Execution', e.ratings?.execution) + skillBar('Class Engagement', e.ratings?.engagement);
            writtenHtml = `
                <div class="mb-4"><p class="text-xs font-black text-slate-400 uppercase tracking-widest mb-1.5">Key Strengths</p><p class="text-sm font-semibold text-slate-700">${escHtml(e.written?.strengths || 'N/A')}</p></div>
                <div class="mb-4"><p class="text-xs font-black text-slate-400 uppercase tracking-widest mb-1.5">Areas for Growth</p><p class="text-sm font-semibold text-slate-700">${escHtml(e.written?.growth || 'N/A')}</p></div>
                <div><p class="text-xs font-black text-slate-400 uppercase tracking-widest mb-1.5">Actionable Steps</p><p class="text-sm font-semibold text-slate-700">${escHtml(e.written?.steps || 'N/A')}</p></div>`;
        } else if (e.type === 'behavioral') {
            metricsHtml = skillBar('Rule Adherence', e.ratings?.adherence) + skillBar('Conflict Resolution', e.ratings?.resolution) + skillBar('Respect Authority', e.ratings?.respect);
            writtenHtml = `
                <div class="mb-4"><p class="text-xs font-black text-slate-400 uppercase tracking-widest mb-1.5">Conduct Description</p><p class="text-sm font-semibold text-slate-700">${escHtml(e.written?.description || 'N/A')}</p></div>
                <div class="mb-4"><p class="text-xs font-black text-slate-400 uppercase tracking-widest mb-1.5">Prior Interventions</p><p class="text-sm font-semibold text-slate-700">${escHtml(e.written?.prior || 'N/A')}</p></div>
                <div class="mb-4"><p class="text-xs font-black text-slate-400 uppercase tracking-widest mb-1.5">Action Plan</p><p class="text-sm font-semibold text-slate-700">${escHtml(e.written?.actionPlan || 'N/A')}</p></div>
                <div class="p-3 bg-red-50 border border-red-100 rounded-xl"><p class="text-[10px] font-black text-red-600 uppercase tracking-widest mb-1">Action Taken</p><p class="text-sm font-black text-red-800">${escHtml(e.status || 'N/A')}</p></div>`;
        } else if (e.type === 'end_of_year') {
            metricsHtml = skillBar('Academic Growth', e.ratings?.growth) + skillBar('Social Dynamics', e.ratings?.social) + skillBar('Resilience', e.ratings?.resilience);
            writtenHtml = `
                <div class="mb-4"><p class="text-xs font-black text-slate-400 uppercase tracking-widest mb-1.5">Year-in-Review Narrative</p><p class="text-sm font-semibold text-slate-700">${escHtml(e.written?.narrative || 'N/A')}</p></div>
                <div class="mb-4"><p class="text-xs font-black text-slate-400 uppercase tracking-widest mb-1.5">Recommended Interventions</p><p class="text-sm font-semibold text-slate-700">${escHtml(e.written?.interventions || 'None')}</p></div>
                <div class="p-3 bg-amber-50 border border-amber-100 rounded-xl"><p class="text-[10px] font-black text-amber-600 uppercase tracking-widest mb-1">Promotion Status</p><p class="text-sm font-black text-amber-800">${escHtml(e.status || 'N/A')}</p></div>`;
        } else if (e.type === 'academic_report_card') {
            metricsHtml = ['Comprehension','Attitude & Work','Effort','Participation','Organization','Behavior','Peer Relations','Punctuality']
                .map((lbl, i) => skillBar(lbl, Object.values(e.ratings || {})[i] || 0)).join('');
            writtenHtml = `<div><p class="text-xs font-black text-slate-400 uppercase tracking-widest mb-1.5">Teacher Comments</p><p class="text-sm font-semibold text-slate-700 whitespace-pre-wrap">${escHtml(e.comment || 'No comments recorded.')}</p></div>`;
        }

        return `
        <div class="bg-white border border-slate-200 rounded-3xl shadow-sm overflow-hidden">

            <!-- ── Collapsed header (always visible) ── -->
            <div onclick="window.toggleEvalCard('${e.id}')"
                 class="flex items-center justify-between p-6 cursor-pointer hover:bg-slate-50 transition select-none">
                <div class="flex items-center gap-4 min-w-0 flex-1">
                    <div class="h-12 w-12 bg-slate-100 text-slate-600 rounded-xl flex items-center justify-center font-black text-base flex-shrink-0">${evalAvg}</div>
                    <div class="min-w-0">
                        <div class="flex items-center gap-3 flex-wrap">
                            <span class="font-black text-lg text-slate-800">${escHtml(e.semesterName || 'Evaluation')}</span>
                            <span class="px-3 py-1 rounded-full text-[10px] font-black uppercase tracking-widest border ${tc.badge}">
                                <i class="fa-solid ${tc.icon} mr-1"></i>${tc.label}
                            </span>
                        </div>
                        <p class="text-xs font-bold text-slate-400 uppercase tracking-widest mt-1">${dateStr} · ${escHtml(e.teacherName || 'Teacher')}</p>
                    </div>
                </div>
                <div class="flex items-center gap-3 flex-shrink-0 ml-4">
                    <button onclick="event.stopPropagation(); window.printEvaluation('${e.id}')"
                            class="flex items-center gap-2 bg-slate-50 hover:bg-indigo-50 text-slate-600 hover:text-indigo-600 font-bold px-4 py-2 rounded-lg border border-slate-200 hover:border-indigo-200 transition text-xs shadow-sm no-print">
                        <i class="fa-solid fa-print"></i> Print
                    </button>
                    <i id="eval-chev-${e.id}" class="fa-solid fa-chevron-down text-slate-400 text-sm transition-transform duration-200"></i>
                </div>
            </div>

            <!-- ── Expanded body (hidden by default) ── -->
            <div id="eval-body-${e.id}" style="display:none;">
                <div class="border-t border-slate-100 p-6 md:p-8">
                    <div class="grid grid-cols-1 md:grid-cols-12 gap-8">
                        <div class="md:col-span-4 bg-slate-50 border border-slate-100 rounded-2xl p-5">
                            <p class="text-xs font-black text-slate-800 uppercase tracking-widest mb-4 pb-2 border-b border-slate-200">Performance Matrix</p>
                            ${metricsHtml}
                        </div>
                        <div class="md:col-span-8">${writtenHtml}</div>
                    </div>
                </div>
            </div>

        </div>`;
    }).join('');
}

// ── 7. PRINT EVALUATION ───────────────────────────────────────────────────
window.printEvaluation = function(evalId) {
    const e = allEvals.find(x => x.id === evalId);
    if (!e) return;

    let typeLabel    = 'Evaluation';
    let metricsHtml  = '';
    let writtenHtml  = '';

    if (e.type === 'academic') {
        typeLabel = 'Academic Matrix Evaluation';
        metricsHtml = `
            <tr><td>Subject Mastery</td><td class="tc">${e.ratings?.mastery || 0} / 5</td></tr>
            <tr><td>Task Execution</td><td class="tc">${e.ratings?.execution || 0} / 5</td></tr>
            <tr><td>Class Engagement</td><td class="tc">${e.ratings?.engagement || 0} / 5</td></tr>`;
        writtenHtml = `
            <div class="fb"><h3>Key Strengths</h3><p>${escHtml(e.written?.strengths || 'N/A')}</p></div>
            <div class="fb"><h3>Areas for Growth</h3><p>${escHtml(e.written?.growth || 'N/A')}</p></div>
            <div class="fb"><h3>Actionable Steps</h3><p>${escHtml(e.written?.steps || 'N/A')}</p></div>`;
    } else if (e.type === 'behavioral') {
        typeLabel = 'Conduct Matrix Evaluation';
        metricsHtml = `
            <tr><td>Rule Adherence</td><td class="tc">${e.ratings?.adherence || 0} / 5</td></tr>
            <tr><td>Conflict Resolution</td><td class="tc">${e.ratings?.resolution || 0} / 5</td></tr>
            <tr><td>Respect Authority</td><td class="tc">${e.ratings?.respect || 0} / 5</td></tr>`;
        writtenHtml = `
            <div class="fb"><h3>Conduct Description</h3><p>${escHtml(e.written?.description || 'N/A')}</p></div>
            <div class="fb"><h3>Prior Interventions</h3><p>${escHtml(e.written?.prior || 'N/A')}</p></div>
            <div class="fb"><h3>Action Plan</h3><p>${escHtml(e.written?.actionPlan || 'N/A')}</p></div>
            <div class="st"><strong>Action Taken:</strong> ${escHtml(e.status || 'N/A')}</div>`;
    } else if (e.type === 'end_of_year') {
        typeLabel = 'End-of-Year Summary Evaluation';
        metricsHtml = `
            <tr><td>Academic Growth</td><td class="tc">${e.ratings?.growth || 0} / 5</td></tr>
            <tr><td>Social Dynamics</td><td class="tc">${e.ratings?.social || 0} / 5</td></tr>
            <tr><td>Resilience</td><td class="tc">${e.ratings?.resilience || 0} / 5</td></tr>`;
        writtenHtml = `
            <div class="fb"><h3>Year-in-Review Narrative</h3><p>${escHtml(e.written?.narrative || 'N/A')}</p></div>
            <div class="fb"><h3>Recommended Interventions</h3><p>${escHtml(e.written?.interventions || 'None')}</p></div>
            <div class="st"><strong>Promotion Status:</strong> ${escHtml(e.status || 'N/A')}</div>`;
    } else if (e.type === 'academic_report_card') {
        typeLabel = 'Report Card Evaluation';
        const rcLabels = ['Comprehension','Attitude & Work','Effort & Resilience','Participation','Organization','Classroom Behaviour','Peer Relations','Punctuality'];
        const rcKeys   = ['academicComprehension','attitudeWork','effortResilience','participation','organization','behavior','peerRelations','punctualityRating'];
        metricsHtml = rcKeys.map((k,i) => `<tr><td>${rcLabels[i]}</td><td class="tc">${e.ratings?.[k] || 0} / 5</td></tr>`).join('');
        writtenHtml = `<div class="fb"><h3>Teacher Comments</h3><p>${escHtml(e.comment || 'No comments recorded.')}</p></div>`;
    }

    const dateStr  = e.date
        ? new Date(e.date).toLocaleDateString('en-US', { month:'long', day:'numeric', year:'numeric' })
        : 'Unknown Date';
    const logoSrc  = schoolData.logo || '../../assets/images/logo.png';
    const schoolNm = schoolData.schoolName || 'ConnectUs School';

    const html = `<!DOCTYPE html>
<html>
<head>
<title>Official Performance Evaluation — ${escHtml(session.studentData.name)}</title>
<style>
@import url('https://fonts.googleapis.com/css2?family=DM+Sans:wght@400;500;600;700;800&family=DM+Mono:wght@400;500;700&display=swap');
@media print {
    * { -webkit-print-color-adjust:exact!important; print-color-adjust:exact!important; }
    @page { margin:1.5cm; }
    body { padding:0; }
}
body { font-family:'DM Sans',Helvetica,Arial,sans-serif; padding:40px; color:#0f172a; line-height:1.6; background:#fff; max-width:800px; margin:0 auto; }

.banner { background:#dc2626; color:#fff; text-align:center; font-weight:900; letter-spacing:0.3em; padding:7px; font-size:11px; margin-bottom:24px; border-radius:4px; }

.hd { display:flex; align-items:flex-start; justify-content:space-between; border-bottom:3px solid #1e1b4b; padding-bottom:20px; margin-bottom:24px; }
.logo { max-height:65px; max-width:180px; object-fit:contain; }
.hd-text h1 { margin:0 0 4px; font-size:20px; font-weight:800; color:#1e1b4b; text-transform:uppercase; letter-spacing:0.04em; }
.hd-text h2 { margin:0 0 2px; font-size:11px; font-weight:700; color:#6366f1; text-transform:uppercase; letter-spacing:0.12em; }
.hd-text p  { margin:0; font-size:11px; color:#94a3b8; }

.info-grid { display:grid; grid-template-columns:1fr 1fr; gap:14px; background:#f8f9ff; border:1px solid #e0e3f5; border-radius:10px; padding:18px 20px; margin-bottom:28px; }
.info-grid div strong { display:block; font-size:9.5px; text-transform:uppercase; letter-spacing:0.1em; color:#7c83c8; margin-bottom:3px; font-weight:800; }
.info-grid div span   { font-size:13.5px; font-weight:700; color:#1e1b4b; }

.sec-title { font-size:11px; font-weight:800; background:#1e1b4b; color:#fff; text-transform:uppercase; letter-spacing:0.12em; padding:10px 16px; border-radius:6px; margin:0 0 20px; }

.grid2 { display:grid; grid-template-columns:1fr 2fr; gap:32px; margin-bottom:32px; }

table { width:100%; border-collapse:collapse; }
th, td { border-bottom:1px solid #f1f5f9; padding:10px 14px; text-align:left; font-size:12.5px; }
th { background:#f8fafb; color:#64748b; font-weight:800; text-transform:uppercase; font-size:10px; letter-spacing:0.08em; border-bottom:2px solid #e2e8f0; }
.tc { text-align:center; font-family:'DM Mono',monospace; font-weight:700; }

.fb { margin-bottom:20px; }
.fb h3 { margin:0 0 7px; font-size:10px; color:#64748b; text-transform:uppercase; letter-spacing:0.1em; font-weight:800; border-bottom:1px solid #e2e8f0; padding-bottom:5px; }
.fb p  { margin:0; font-size:13px; color:#334155; font-weight:500; white-space:pre-wrap; line-height:1.6; }

.st { background:#f1f5f9; border:1px solid #e2e8f0; padding:14px; border-radius:6px; font-size:13px; color:#1e293b; font-weight:600; margin-top:16px; }

.sigs { display:grid; grid-template-columns:1fr 1fr 1fr; gap:40px; margin-top:56px; }
.sig-line { border-top:1px solid #1e1b4b; padding-top:8px; }
.sig-line p { margin:0; font-size:10.5px; font-weight:700; color:#64748b; text-transform:uppercase; letter-spacing:0.08em; }

.footer { margin-top:40px; border-top:1px solid #e2e8f0; padding-top:14px; text-align:center; font-size:10px; color:#94a3b8; font-style:italic; }
</style>
</head>
<body>

<div class="banner">★ OFFICIAL EVALUATION RECORD — ${escHtml(schoolNm)} ★</div>

<div class="hd">
    <div style="display:flex;align-items:center;gap:16px;">
        <img src="${escHtml(logoSrc)}" class="logo" onerror="this.style.display='none'">
        <div class="hd-text">
            <h1>${escHtml(schoolNm)}</h1>
            <h2>Official Performance Evaluation</h2>
            <p>${escHtml(typeLabel)}</p>
        </div>
    </div>
    <div style="text-align:right;">
        <p style="font-size:10px;font-weight:700;text-transform:uppercase;letter-spacing:0.1em;color:#94a3b8;margin:0;">Date Filed</p>
        <p style="font-size:13px;font-weight:700;color:#1e293b;margin:2px 0 0;">${dateStr}</p>
    </div>
</div>

<div class="info-grid">
    <div><strong>Student Name</strong><span>${escHtml(session.studentData.name || 'Unknown')}</span></div>
    <div><strong>Student ID</strong><span>${escHtml(session.studentId || 'N/A')}</span></div>
    <div><strong>Class</strong><span>${escHtml(session.studentData.className || 'Unassigned')}</span></div>
    <div><strong>Academic Period</strong><span>${escHtml(e.semesterName || 'Unknown')}</span></div>
    <div><strong>Evaluation Type</strong><span>${escHtml(typeLabel)}</span></div>
    <div><strong>Prepared By</strong><span>${escHtml(e.teacherName || 'Teacher')}</span></div>
</div>

<h3 class="sec-title">Evaluation Details</h3>

<div class="grid2">
    <div>
        <table>
            <thead><tr><th>Criteria</th><th class="tc">Rating</th></tr></thead>
            <tbody>${metricsHtml}</tbody>
        </table>
    </div>
    <div>${writtenHtml}</div>
</div>

<div class="sigs">
    <div class="sig-line"><p>Class Teacher &amp; Date</p></div>
    <div class="sig-line"><p>Principal / Head of School</p></div>
    <div class="sig-line"><p>Parent / Guardian</p></div>
</div>

<div class="footer">
    This evaluation was filed and generated via the ConnectUs Family Portal for ${escHtml(schoolNm)}.<br>
    This document is an official record. For a certified copy with school seal, contact the administration office.
</div>

</body>
</html>`;

    const w = window.open('', '_blank');
    w.document.write(html);
    w.document.close();
    setTimeout(() => w.print(), 600);
};

// ── INITIALIZE ────────────────────────────────────────────────────────────
document.addEventListener('DOMContentLoaded', loadAnalyticsData);
