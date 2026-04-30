import { db } from '../../assets/js/firebase-init.js';
import { collection, query, where, getDocs, getDoc, doc } from "https://www.gstatic.com/firebasejs/10.7.1/firebase-firestore.js";
import { requireAuth } from '../../assets/js/auth.js';
import { injectTeacherLayout } from '../../assets/js/layout-teachers.js';
import { gradeColorClass, calculateWeightedAverage } from '../../assets/js/utils.js';

// ── 1. AUTH & LAYOUT ─────────────────────────────────────────────────────────
const session = requireAuth('teacher', '../login.html');
if (session) {
    injectTeacherLayout('overview', 'Overview', 'Classroom dashboard', false);
}

// ── 2. STATE ─────────────────────────────────────────────────────────────────
let allStudents = [];
let studentMap  = {};
let allGrades   = [];

const DEFAULT_GRADE_TYPES = ['Test', 'Quiz', 'Assignment', 'Homework', 'Project', 'Midterm Exam', 'Final Exam'];
function getGradeTypes() { return session.teacherData.gradeTypes || session.teacherData.customGradeTypes || DEFAULT_GRADE_TYPES; }

// ── 3. INIT ───────────────────────────────────────────────────────────────────
async function init() {
    if (!session) return;

    const greeting  = document.querySelector('.page-header-greeting');
    if (greeting) {
        const hour      = new Date().getHours();
        const salutation = hour < 12 ? 'Good morning' : hour < 17 ? 'Good afternoon' : 'Good evening';
        const firstName  = session.teacherData.name.split(' ')[0];
        greeting.textContent = `${salutation}, ${firstName}.`;
    }

    document.getElementById('displayTeacherName').textContent = session.teacherData.name;
    document.getElementById('teacherAvatar').textContent      = session.teacherData.name.charAt(0).toUpperCase();
    document.getElementById('sidebarSchoolId').textContent    = session.schoolId;

    const classes = session.teacherData.classes || [session.teacherData.className || ''];
    document.getElementById('displayTeacherClasses').innerHTML =
        classes.filter(Boolean).map(c => `<span class="class-pill">${c}</span>`).join('');

    document.getElementById('analyticsLoader').classList.remove('hidden');

    await loadSemesters();
    await fetchMetrics();
}

// ── 4. SEMESTERS ──────────────────────────────────────────────────────────────
async function loadSemesters() {
    try {
        let rawSemesters = [];
        const cacheKey   = `connectus_semesters_${session.schoolId}`;
        const cached     = localStorage.getItem(cacheKey);

        if (cached) {
            rawSemesters = JSON.parse(cached);
        } else {
            const semSnap = await getDocs(collection(db, 'schools', session.schoolId, 'semesters'));
            rawSemesters  = semSnap.docs
                .map(d => ({ id: d.id, ...d.data() }))
                .sort((a, b) => (a.order || 0) - (b.order || 0));
            localStorage.setItem(cacheKey, JSON.stringify(rawSemesters));
        }

        const schoolSnap = await getDoc(doc(db, 'schools', session.schoolId));
        const activeId   = schoolSnap.data()?.activeSemesterId || '';

        const semSel = document.getElementById('activeSemester');
        if (semSel) {
            semSel.innerHTML = '';
            rawSemesters.forEach(s => {
                const opt       = document.createElement('option');
                opt.value       = s.id;
                opt.textContent = s.name;
                if (s.id === activeId) opt.selected = true;
                semSel.appendChild(opt);
            });
            semSel.addEventListener('change', () => {
                document.getElementById('analyticsSection').classList.add('hidden');
                document.getElementById('analyticsLoader').classList.remove('hidden');
                fetchMetrics();
            });
        }
    } catch (e) {
        console.error('[Overview] loadSemesters:', e);
    }
}

// ── 5. FETCH & RENDER DASHBOARD DATA ─────────────────────────────────────────
async function fetchMetrics() {
    try {
        const semSel  = document.getElementById('activeSemester');
        const semId   = semSel ? semSel.value : null;
        const semName = semSel ? semSel.options[semSel.selectedIndex]?.text : '—';

        const sbPeriod = document.getElementById('sb-period');
        if (sbPeriod) sbPeriod.textContent = semName;

        const stuSnap = await getDocs(query(
            collection(db, 'students'),
            where('currentSchoolId', '==', session.schoolId),
            where('enrollmentStatus', '==', 'Active')
        ));
        allStudents = stuSnap.docs
            .map(d => ({ id: d.id, ...d.data() }))
            .filter(s => s.teacherId === session.teacherId);

        studentMap = {};
        allStudents.forEach(s => { studentMap[s.id] = s.name; });

        document.getElementById('stat-students').textContent = allStudents.length;
        const sbStudents = document.getElementById('sb-students');
        if (sbStudents) sbStudents.textContent = allStudents.length;

        if (!semId || !allStudents.length) {
            document.getElementById('stat-grades').textContent = '0';
            document.getElementById('stat-risk').textContent   = '0';
            const sbRisk = document.getElementById('sb-risk');
            if (sbRisk) sbRisk.textContent = '0';
            localStorage.setItem('connectus_sidebar_stats', JSON.stringify({ students: allStudents.length || 0, risk: 0 }));
            renderEmptyActivity();
            renderEmptyRisk();
            document.getElementById('analyticsLoader').classList.add('hidden');
            return;
        }

        allGrades = [];
        await Promise.all(allStudents.map(async s => {
            try {
                // FIXED: Point to the global students collection
                const gQuery = query(
                    collection(db, 'students', s.id, 'grades'),
                    where('schoolId', '==', session.schoolId),
                    where('semesterId', '==', semId)
                );
                const gSnap = await getDocs(gQuery);
                gSnap.forEach(d => allGrades.push({ id: d.id, studentId: s.id, studentName: s.name, ...d.data() }));
            } catch (e) {
                console.error(`[Overview] grades for ${s.id}:`, e);
            }
        }));

        document.getElementById('stat-grades').textContent = allGrades.length;

        const stuG = {};
        allGrades.forEach(g => {
            if (!stuG[g.studentId]) stuG[g.studentId] = [];
            stuG[g.studentId].push(g);
        });

        const riskStudents = [];
        const distribution = { excelling: 0, good: 0, track: 0, attention: 0, risk: 0 };

        Object.entries(stuG).forEach(([sid, gradesArray]) => {
            if (gradesArray.length > 0) {
                const avg = calculateWeightedAverage(gradesArray, getGradeTypes());
                if (avg !== null) {
                    if (avg >= 90) distribution.excelling++;
                    else if (avg >= 80) distribution.good++;
                    else if (avg >= 70) distribution.track++;
                    else if (avg >= 65) distribution.attention++;
                    else {
                        distribution.risk++;
                        riskStudents.push({ sid, name: studentMap[sid] || 'Unknown', avg });
                    }
                }
            }
        });

        const riskCount = riskStudents.length;
        document.getElementById('stat-risk').textContent = riskCount;
        const sbRisk = document.getElementById('sb-risk');
        if (sbRisk) {
            sbRisk.textContent = riskCount;
            sbRisk.classList.toggle('is-risk', riskCount > 0);
        }

        localStorage.setItem('connectus_sidebar_stats', JSON.stringify({ students: allStudents.length, risk: riskCount }));

        const banner = document.getElementById('atRiskBanner');
        const msg    = document.getElementById('atRiskMsg');
        if (riskCount > 0) {
            banner.classList.remove('hidden');
            msg.textContent = `${riskCount} student${riskCount !== 1 ? 's are' : ' is'} averaging below 65% this period.`;
        } else {
            banner.classList.add('hidden');
        }

        if (riskCount > 0) {
            document.getElementById('needsAttentionList').innerHTML =
                riskStudents.sort((a, b) => a.avg - b.avg).map(s => renderRiskItem(s)).join('');
        } else {
            renderEmptyRisk();
        }

        const recent = [...allGrades]
            .sort((a, b) => new Date(b.createdAt || b.date || 0) - new Date(a.createdAt || a.date || 0))
            .slice(0, 8);

        if (recent.length > 0) {
            document.getElementById('recentActivityList').innerHTML = recent.map(g => renderActivityRow(g)).join('');
        } else {
            renderEmptyActivity();
        }

        // Fetch Evaluations for Analytics Matrix
        const allEvals = [];
        await Promise.all(allStudents.map(async s => {
            try {
                const eSnap = await getDocs(query(
                    collection(db, 'students', s.id, 'evaluations'),
                    where('semesterId', '==', semId),
                    where('schoolId', '==', session.schoolId)
                ));
                eSnap.forEach(d => allEvals.push(d.data()));
            } catch(e) {}
        }));

        renderClassroomAnalytics(distribution, allGrades, allEvals);

    } catch (e) {
        console.error('[Overview] fetchMetrics:', e);
        document.getElementById('analyticsLoader').innerHTML = '<p class="text-xs font-bold text-red-500 uppercase tracking-widest">Analytics computation failed.</p>';
    }
}

// ── 6. CLASSROOM ANALYTICS ENGINE ─────────────────────────────────────────────
function renderClassroomAnalytics(dist, grades, evals) {
    // 1. Render Distribution
    document.getElementById('dist-excelling').textContent = dist.excelling;
    document.getElementById('dist-good').textContent = dist.good;
    document.getElementById('dist-track').textContent = dist.track;
    document.getElementById('dist-attention').textContent = dist.attention;
    document.getElementById('dist-risk').textContent = dist.risk;

    // 2. Render Subject Performance
    const bySub = {};
    grades.forEach(g => {
        const sub = g.subject || 'Uncategorized';
        if (!bySub[sub]) bySub[sub] = [];
        bySub[sub].push(g);
    });

    const subjectStats = Object.entries(bySub).map(([sub, gList]) => {
        const avg = calculateWeightedAverage(gList, getGradeTypes());
        return { name: sub, avg: Math.round(avg !== null ? avg : 0), count: gList.length };
    }).sort((a, b) => b.avg - a.avg);

    const subjectEl = document.getElementById('classSubjectPerformanceList');
    if (subjectStats.length === 0) {
        subjectEl.innerHTML = '<p class="text-xs font-bold text-slate-400">No subject data recorded.</p>';
    } else {
        subjectEl.innerHTML = subjectStats.map(s => {
            const colorClass = s.avg >= 90 ? 'bg-emerald-500' : s.avg >= 80 ? 'bg-blue-500' : s.avg >= 70 ? 'bg-teal-500' : s.avg >= 65 ? 'bg-amber-500' : 'bg-red-500';
            return `
            <div class="mb-3">
                <div class="flex justify-between items-center mb-1">
                    <span class="text-xs font-black text-slate-700">${escHtml(s.name)}</span>
                    <span class="text-xs font-black text-slate-800">${s.avg}%</span>
                </div>
                <div class="h-2 w-full bg-slate-100 rounded-none overflow-hidden">
                    <div class="h-full ${colorClass} rounded-none" style="width: ${s.avg}%"></div>
                </div>
            </div>`;
        }).join('');
    }

    // 3. Render Assessment Type Analysis
    const byType = {};
    grades.forEach(g => {
        const t = g.type || 'Uncategorized';
        if (!byType[t]) byType[t] = [];
        if (g.max) byType[t].push((g.score / g.max) * 100);
    });

    const typeStats = Object.entries(byType).map(([type, pcts]) => {
        const avg = pcts.length ? (pcts.reduce((a,b)=>a+b,0) / pcts.length) : 0;
        return { name: type, avg: Math.round(avg), count: pcts.length };
    }).sort((a, b) => b.avg - a.avg);

    const typeEl = document.getElementById('classAssessmentAnalysisList');
    if (typeStats.length === 0) {
        typeEl.innerHTML = '<p class="text-xs font-bold text-slate-400">No assessment data recorded.</p>';
    } else {
        typeEl.innerHTML = typeStats.map(s => {
            return `
            <div class="mb-3 flex items-center justify-between p-3 bg-slate-50 border border-slate-100 rounded-none">
                <div>
                    <p class="text-xs font-black text-slate-700 uppercase tracking-widest">${escHtml(s.name)}</p>
                    <p class="text-[9px] font-bold text-slate-400 mt-0.5">${s.count} assignments logged</p>
                </div>
                <span class="text-sm font-black text-indigo-600">${s.avg}% Avg</span>
            </div>`;
        }).join('');
    }

    // 4. Render Classroom Matrix
    const matrixData = {
        academic: { mastery: [], execution: [], engagement: [] },
        behavioral: { adherence: [], resolution: [], respect: [] },
        end_of_year: { growth: [], social: [], resilience: [] }
    };

    evals.forEach(e => {
        if (e.ratings) {
            if (e.type === 'academic') {
                if (e.ratings.mastery) matrixData.academic.mastery.push(e.ratings.mastery);
                if (e.ratings.execution) matrixData.academic.execution.push(e.ratings.execution);
                if (e.ratings.engagement) matrixData.academic.engagement.push(e.ratings.engagement);
            } else if (e.type === 'behavioral') {
                if (e.ratings.adherence) matrixData.behavioral.adherence.push(e.ratings.adherence);
                if (e.ratings.resolution) matrixData.behavioral.resolution.push(e.ratings.resolution);
                if (e.ratings.respect) matrixData.behavioral.respect.push(e.ratings.respect);
            } else if (e.type === 'end_of_year') {
                if (e.ratings.growth) matrixData.end_of_year.growth.push(e.ratings.growth);
                if (e.ratings.social) matrixData.end_of_year.social.push(e.ratings.social);
                if (e.ratings.resilience) matrixData.end_of_year.resilience.push(e.ratings.resilience);
            }
        }
    });

    const matrixEl = document.getElementById('classMatrixContainer');
    const calcAvg = (arr) => arr.length ? (arr.reduce((a,b)=>a+b,0)/arr.length).toFixed(1) : 0;
    
    const buildMatrixCol = (title, dataObj, colorBase) => {
        const keys = Object.keys(dataObj);
        let barsHtml = keys.map(k => {
            const val = calcAvg(dataObj[k]);
            const pct = (val / 5) * 100;
            return `
            <div class="mb-2">
                <div class="flex justify-between items-center mb-1">
                    <span class="text-[9px] font-black text-slate-500 uppercase tracking-widest">${k}</span>
                    <span class="text-[10px] font-black text-slate-800">${val}/5</span>
                </div>
                <div class="h-1.5 w-full bg-slate-100 rounded-none overflow-hidden">
                    <div class="h-full ${colorBase} rounded-none" style="width: ${pct}%"></div>
                </div>
            </div>`;
        }).join('');
        return `<div><h5 class="text-xs font-black text-slate-800 mb-3 border-b border-slate-100 pb-2">${title}</h5>${barsHtml}</div>`;
    };

    matrixEl.innerHTML = `
        ${buildMatrixCol('Academic Progress', matrixData.academic, 'bg-blue-500')}
        ${buildMatrixCol('Conduct Interventions', matrixData.behavioral, 'bg-red-500')}
        ${buildMatrixCol('End of Year Growth', matrixData.end_of_year, 'bg-amber-500')}
    `;

    document.getElementById('analyticsLoader').classList.add('hidden');
    document.getElementById('analyticsSection').classList.remove('hidden');
}

// ── 7. COMPONENT HELPERS ───────────────────────────────────────────────────────
function renderActivityRow(g) {
    const pct        = g.max ? Math.round((g.score / g.max) * 100) : 0;
    const badgeStyle = pct >= 90 ? 'background:#dcfce7;color:#166534;border:1px solid #bbf7d0;'
                     : pct >= 80 ? 'background:#dbeafe;color:#1e40af;border:1px solid #bfdbfe;'
                     : pct >= 70 ? 'background:#ccfbf1;color:#115e59;border:1px solid #99f6e4;'
                     : pct >= 65 ? 'background:#fef3c7;color:#92400e;border:1px solid #fde68a;'
                     :             'background:#fee2e2;color:#991b1b;border:1px solid #fecaca;';
    let dateStr = '—';
    if (g.createdAt || g.date) {
        try { dateStr = new Date(g.createdAt || g.date).toLocaleDateString('en-US', { month: 'short', day: 'numeric' }); } catch (_) {}
    }
    const initial = (g.studentName || '?').charAt(0).toUpperCase();
    return `
    <a href="../gradebook/gradebook.html"
       style="display:grid;grid-template-columns:1fr 100px 80px 64px 80px;
              align-items:center;padding:11px 20px;border-bottom:1px solid #f0f4f9;
              text-decoration:none;transition:background 0.12s;cursor:pointer;"
       onmouseover="this.style.background='#f8fafc'"
       onmouseout="this.style.background=''">
      <div style="display:flex;align-items:center;gap:10px;min-width:0;">
        <div style="width:28px;height:28px;border-radius:0px;background:linear-gradient(135deg,#0ea871,#053d29);
                    color:#fff;font-size:11px;font-weight:700;display:flex;align-items:center;
                    justify-content:center;flex-shrink:0;">${initial}</div>
        <div style="min-width:0;">
          <p style="font-size:12.5px;font-weight:600;color:#0d1f35;margin:0;
                    white-space:nowrap;overflow:hidden;text-overflow:ellipsis;">${escHtml(g.studentName || 'Unknown')}</p>
          <p style="font-size:11px;color:#9ab0c6;font-weight:400;margin:0;
                    white-space:nowrap;overflow:hidden;text-overflow:ellipsis;">${escHtml(g.title || 'Assessment')} · ${dateStr}</p>
        </div>
      </div>
      <div style="font-size:12px;font-weight:500;color:#374f6b;white-space:nowrap;overflow:hidden;text-overflow:ellipsis;">${escHtml(g.subject || '—')}</div>
      <div style="font-size:11px;color:#9ab0c6;font-weight:400;">${escHtml(g.type || '—')}</div>
      <div style="font-size:12px;font-weight:600;color:#374f6b;text-align:right;font-family:'DM Mono',monospace;">${g.score}/${g.max || '?'}</div>
      <div style="text-align:right;">
        <span style="${badgeStyle}padding:2px 8px;border-radius:0px;font-size:11px;font-weight:700;font-family:'DM Mono',monospace;">${pct}%</span>
      </div>
    </a>`;
}

function renderRiskItem(s) {
    const initial = (s.name || '?').charAt(0).toUpperCase();
    return `
    <a href="../roster/roster.html#${escHtml(s.sid)}"
       style="display:flex;align-items:center;justify-content:space-between;
              background:#fff;border:1px solid #ffd6de;border-radius:0px;
              padding:10px 12px;text-decoration:none;transition:box-shadow 0.15s;cursor:pointer;"
       onmouseover="this.style.boxShadow='0 2px 8px rgba(220,38,38,0.1)'"
       onmouseout="this.style.boxShadow=''">
      <div style="display:flex;align-items:center;gap:9px;">
        <div style="width:30px;height:30px;border-radius:0px;background:#fee2e2;
                    color:#dc2626;font-size:12px;font-weight:700;
                    display:flex;align-items:center;justify-content:center;flex-shrink:0;">${initial}</div>
        <span style="font-size:13px;font-weight:600;color:#0d1f35;">${escHtml(s.name)}</span>
      </div>
      <span style="font-size:12px;font-weight:700;color:#be123c;
                   background:#fee2e2;padding:2px 9px;border-radius:0px;
                   border:1px solid #fecaca;font-family:'DM Mono',monospace;">${s.avg}%</span>
    </a>`;
}

function renderEmptyActivity() {
    document.getElementById('recentActivityList').innerHTML = `
        <div style="display:flex;flex-direction:column;align-items:center;justify-content:center;
                    padding:48px 20px;gap:8px;color:#9ab0c6;">
            <i class="fa-solid fa-inbox" style="font-size:22px;"></i>
            <p style="font-size:12.5px;margin:0;font-weight:400;">No grades logged yet this period.</p>
            <a href="../grade_form/grade_form.html"
               style="font-size:12px;font-weight:600;color:#0b8f5e;text-decoration:none;margin-top:4px;">
                + Enter your first grade →
            </a>
        </div>`;
}

function renderEmptyRisk() {
    document.getElementById('needsAttentionList').innerHTML = `
        <div style="display:flex;flex-direction:column;align-items:center;justify-content:center;
                    padding:40px 20px;gap:8px;color:#9ab0c6;">
            <i class="fa-solid fa-circle-check" style="font-size:22px;color:#0ea871;"></i>
            <p style="font-size:12.5px;margin:0;font-weight:400;text-align:center;">All students on track!</p>
        </div>`;
}

function escHtml(str) {
    if (!str) return '';
    return String(str).replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/"/g,'&quot;');
}

// ── 8. FIRE ───────────────────────────────────────────────────────────────────
init();
