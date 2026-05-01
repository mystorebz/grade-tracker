import { db } from '../../assets/js/firebase-init.js';
import { doc, getDoc, getDocs, collection, query, where } from "https://www.gstatic.com/firebasejs/10.7.1/firebase-firestore.js";
import { requireAuth } from '../../assets/js/auth.js';
import { injectAdminLayout } from '../../assets/js/layout-admin.js';
import { calculateWeightedAverage } from '../../assets/js/utils.js'; // Ensure Math Engine is imported

// ── 1. AUTHENTICATION & LAYOUT INJECTION ──────────────────────────────────
const session = requireAuth('admin', '../login.html');
injectAdminLayout('overview', 'Overview', 'School management dashboard', false, false);

// Elements
const statTeachersEl = document.getElementById('stat-teachers');
const statStudentsEl = document.getElementById('stat-students');
const statLimitEl = document.getElementById('stat-limit');
const planNameDisplay = document.getElementById('planNameDisplay');
const capacityBar = document.getElementById('capacityBar');
const capacityWarningBanner = document.getElementById('capacityWarningBanner');
const activePeriodDisplay = document.getElementById('activePeriodDisplay');

const analyticsLoader = document.getElementById('analyticsLoader');
const analyticsSection = document.getElementById('analyticsSection');

// ── 2. LOAD DASHBOARD STATS ───────────────────────────────────────────────
async function loadOverviewStats() {
    try {
        const [tSnap, sSnap] = await Promise.all([
            getDocs(query(collection(db, 'teachers'), where('currentSchoolId', '==', session.schoolId))),
            getDocs(query(collection(db, 'students'), where('currentSchoolId', '==', session.schoolId), where('enrollmentStatus', '==', 'Active')))
        ]);

        const activeTeachers = tSnap.docs.length;
        const activeStudents = sSnap.docs.length;
        const limit = session.planLimit || 50;
        
        statTeachersEl.textContent = activeTeachers;
        statStudentsEl.textContent = activeStudents;
        statLimitEl.textContent = limit;
        planNameDisplay.textContent = session.planName || 'Plan';
        
        const pct = Math.min(100, Math.round((activeStudents / limit) * 100));
        capacityBar.style.width = pct + '%';
        
        if (pct >= 90) capacityBar.classList.replace('bg-green-500', 'bg-red-500');
        if (activeStudents >= limit) capacityWarningBanner.classList.remove('hidden');
        
        // Pass the students and teachers directly to the analytics loader to save DB reads
        const teachersList = tSnap.docs.map(d => ({ id: d.id, ...d.data() }));
        const studentsList = sSnap.docs.map(d => ({ id: d.id, ...d.data() }));
        
        loadSchoolAnalytics(teachersList, studentsList);

    } catch (error) {
        console.error("Error loading overview stats:", error);
    }
}

// ── 3. LOAD ACTIVE GRADING PERIOD ─────────────────────────────────────────
async function loadSemesters() {
    try {
        if (!session.activeSemesterId) {
            activePeriodDisplay.textContent = 'None Set';
            return;
        }
        const docRef = doc(db, 'schools', session.schoolId, 'semesters', session.activeSemesterId);
        const docSnap = await getDoc(docRef);
        activePeriodDisplay.textContent = docSnap.exists() ? docSnap.data().name : 'Unknown Period';
    } catch (error) {
        console.error("Error loading active semester:", error);
        activePeriodDisplay.textContent = 'Error loading';
    }
}

// ── 4. INSTITUTIONAL ANALYTICS ENGINE (ACCOUNTABILITY & GRADES) ───────────
async function loadSchoolAnalytics(teachersList, studentsList) {
    if (!session.activeSemesterId) {
        analyticsLoader.innerHTML = '<p class="text-xs font-bold text-amber-500 uppercase tracking-widest">No active grading period set. Cannot run analytics.</p>';
        return;
    }

    try {
        // 1. Build Teacher Rubric Cache & Maps
        const teacherRubrics = {};
        const teacherMap = {};
        teachersList.forEach(t => {
            teacherRubrics[t.id] = t.gradeTypes || t.customGradeTypes || [];
            teacherMap[t.id] = t.name;
        });

        const studentAverages = [];
        const classAveragesMap = {};
        
        // Data Structures for the new Matrix
        const subjectStats = {};
        const teacherStats = {};

        // 2. Fetch Data for all active students (Grades ONLY)
        await Promise.all(studentsList.map(async (student) => {
            const gSnap = await getDocs(query(
                collection(db, 'students', student.id, 'grades'), 
                where('schoolId', '==', session.schoolId),
                where('semesterId', '==', session.activeSemesterId)
            ));
            
            const grades = gSnap.docs.map(d => d.data());
            
            if (grades.length > 0) {
                // A) Overall Student Averages (For the top row gauges)
                const bySub = {};
                grades.forEach(g => {
                    const sub = g.subject || 'Uncategorized';
                    if (!bySub[sub]) bySub[sub] = [];
                    bySub[sub].push(g);
                });

                let sumSubjAvgs = 0;
                let subjCount = 0;

                for (const sub in bySub) {
                    const tId = bySub[sub][0]?.teacherId;
                    const rubric = tId ? (teacherRubrics[tId] || []) : [];
                    const subAvgRaw = calculateWeightedAverage(bySub[sub], rubric);
                    if (subAvgRaw !== null) {
                        sumSubjAvgs += subAvgRaw;
                        subjCount++;
                    }
                }

                if (subjCount > 0) {
                    const termAvg = Math.round(sumSubjAvgs / subjCount);
                    studentAverages.push(termAvg);
                    
                    const cls = student.className || 'Unassigned';
                    if (!classAveragesMap[cls]) classAveragesMap[cls] = [];
                    classAveragesMap[cls].push(termAvg);
                }

                // B) Populate Subject & Teacher Stats for Matrix
                const sortedGrades = [...grades].filter(g => g.max > 0).sort((a,b) => (a.date || '').localeCompare(b.date || ''));
                
                sortedGrades.forEach(g => {
                    const pct = (g.score / g.max) * 100;
                    const sub = g.subject || 'Uncategorized';
                    const tId = g.teacherId || student.teacherId; // Fallback to homeroom teacher if blank

                    // Subject Math
                    if (!subjectStats[sub]) subjectStats[sub] = { sum: 0, count: 0 };
                    subjectStats[sub].sum += pct;
                    subjectStats[sub].count++;

                    // Teacher Math
                    if (tId && teacherMap[tId]) {
                        if (!teacherStats[tId]) {
                            teacherStats[tId] = { name: teacherMap[tId], sum: 0, count: 0, failing: 0, chronological: [] };
                        }
                        teacherStats[tId].sum += pct;
                        teacherStats[tId].count++;
                        teacherStats[tId].chronological.push(pct);
                        if (pct < 70) teacherStats[tId].failing++;
                    }
                });
            }
        }));

        // 3. Render Distribution Blocks & Top Gauge
        let dist = { excelling: 0, good: 0, track: 0, attention: 0, risk: 0 };
        let globalSum = 0;

        studentAverages.forEach(avg => {
            globalSum += avg;
            if (avg >= 90) dist.excelling++;
            else if (avg >= 80) dist.good++;
            else if (avg >= 70) dist.track++;
            else if (avg >= 65) dist.attention++;
            else dist.risk++;
        });

        document.getElementById('dist-excelling').textContent = dist.excelling;
        document.getElementById('dist-good').textContent = dist.good;
        document.getElementById('dist-track').textContent = dist.track;
        document.getElementById('dist-attention').textContent = dist.attention;
        document.getElementById('dist-risk').textContent = dist.risk;

        const evaluatedCount = studentAverages.length;
        document.getElementById('evaluatedCountText').textContent = `${evaluatedCount} Students Evaluated`;
        
        if (evaluatedCount > 0) {
            const globalAvg = Math.round(globalSum / evaluatedCount);
            document.getElementById('globalTermAvgText').textContent = `${globalAvg}%`;
            
            const gaugePath = document.getElementById('globalGaugePath');
            const offset = 125.6 - ((globalAvg / 100) * 125.6);
            const color = globalAvg >= 80 ? '#10b981' : globalAvg >= 70 ? '#14b8a6' : globalAvg >= 65 ? '#f59e0b' : '#ef4444';
            gaugePath.setAttribute('stroke', color);
            setTimeout(() => { gaugePath.style.strokeDashoffset = offset; }, 100);
        }

        // 4. Render Class Rankings
        const classListEl = document.getElementById('classPerformanceList');
        const classStats = Object.entries(classAveragesMap).map(([cls, avgs]) => {
            return { name: cls, avg: Math.round(avgs.reduce((a,b)=>a+b,0)/avgs.length), count: avgs.length };
        }).sort((a,b) => b.avg - a.avg);

        if (classStats.length === 0) {
            classListEl.innerHTML = '<p class="text-xs font-bold text-slate-400">No class data.</p>';
        } else {
            classListEl.innerHTML = classStats.map(c => `
                <div class="mb-3">
                    <div class="flex justify-between items-center mb-1">
                        <span class="text-xs font-black text-slate-700">${escHtml(c.name)} <span class="text-[9px] text-slate-400 font-bold ml-1">(${c.count} students)</span></span>
                        <span class="text-xs font-black text-slate-800">${c.avg}%</span>
                    </div>
                    <div class="h-2 w-full bg-slate-100 rounded-none overflow-hidden">
                        <div class="h-full bg-indigo-500 rounded-none" style="width: ${c.avg}%"></div>
                    </div>
                </div>
            `).join('');
        }

        // 5. RENDER THE NEW SOPHISTICATED MATRIX
        const matrixEl = document.getElementById('globalMatrixContainer');
        
        // Prepare Teacher Data Array
        const teacherDataArr = Object.values(teacherStats).map(t => {
            const avg = Math.round(t.sum / t.count);
            const failPct = Math.round((t.failing / t.count) * 100);
            
            let trend = 0;
            if (t.chronological.length >= 4) {
                const mid = Math.floor(t.chronological.length / 2);
                const firstHalf = t.chronological.slice(0, mid);
                const secondHalf = t.chronological.slice(mid);
                const avg1 = firstHalf.reduce((a,b)=>a+b,0) / firstHalf.length;
                const avg2 = secondHalf.reduce((a,b)=>a+b,0) / secondHalf.length;
                trend = (avg2 - avg1).toFixed(1);
            }
            return { name: t.name, avg, failPct, trend: parseFloat(trend) };
        });

        // COL 1: Teacher Performance & Risk (Dual-Tone Bar)
        const buildTeacherRiskCol = () => {
            const sorted = [...teacherDataArr].sort((a,b) => b.avg - a.avg).slice(0, 5); // Top 5
            const html = sorted.map(t => `
                <div class="mb-3">
                    <div class="flex justify-between items-end mb-1">
                        <span class="text-[10px] font-black text-slate-700 uppercase tracking-wide truncate max-w-[60%]">${escHtml(t.name)}</span>
                        <div class="text-right">
                            <span class="text-xs font-black text-slate-800 block leading-none">${t.avg}%</span>
                            <span class="text-[9px] font-bold text-red-500 leading-none">${t.failPct}% At Risk</span>
                        </div>
                    </div>
                    <div class="h-1.5 w-full bg-slate-100 flex overflow-hidden">
                        <div class="h-full bg-blue-500" style="width: ${t.avg}%"></div>
                        <div class="h-full bg-red-500" style="width: ${t.failPct}%"></div>
                    </div>
                </div>
            `).join('');
            return `<div><h5 class="text-xs font-black text-slate-800 mb-3 border-b border-slate-200 pb-2 flex justify-between"><span>Teacher Impact</span><i class="fa-solid fa-chalkboard-user text-slate-400"></i></h5>${html || '<p class="text-xs text-slate-400 font-bold">No data.</p>'}</div>`;
        };

        // COL 2: Subject Mastery (Clean colored bars)
        const buildSubjectCol = () => {
            const sorted = Object.entries(subjectStats)
                .map(([name, data]) => ({ name, avg: Math.round(data.sum / data.count) }))
                .sort((a,b) => b.avg - a.avg).slice(0, 5); // Top 5 Subjects
                
            const html = sorted.map(s => {
                const color = s.avg >= 80 ? 'bg-emerald-500' : s.avg >= 70 ? 'bg-amber-500' : 'bg-red-500';
                return `
                <div class="mb-3">
                    <div class="flex justify-between items-center mb-1">
                        <span class="text-[10px] font-black text-slate-600 uppercase tracking-widest truncate max-w-[70%]">${escHtml(s.name)}</span>
                        <span class="text-[11px] font-black text-slate-800">${s.avg}%</span>
                    </div>
                    <div class="h-1.5 w-full bg-slate-100 overflow-hidden">
                        <div class="h-full ${color}" style="width: ${s.avg}%"></div>
                    </div>
                </div>`;
            }).join('');
            return `<div><h5 class="text-xs font-black text-slate-800 mb-3 border-b border-slate-200 pb-2 flex justify-between"><span>Subject Mastery</span><i class="fa-solid fa-book text-slate-400"></i></h5>${html || '<p class="text-xs text-slate-400 font-bold">No data.</p>'}</div>`;
        };

        // COL 3: Teacher Growth Trends (Sophisticated Trend Pills)
        const buildTrendCol = () => {
            const sorted = [...teacherDataArr].sort((a,b) => b.trend - a.trend).slice(0, 5);
            const html = sorted.map(t => {
                let badgeClass, icon, prefix;
                if (t.trend >= 2.0) { badgeClass = 'bg-emerald-100 text-emerald-700 border-emerald-200'; icon = 'fa-arrow-trend-up'; prefix = '+'; }
                else if (t.trend <= -2.0) { badgeClass = 'bg-red-100 text-red-700 border-red-200'; icon = 'fa-arrow-trend-down'; prefix = ''; }
                else { badgeClass = 'bg-slate-100 text-slate-600 border-slate-200'; icon = 'fa-minus'; prefix = (t.trend > 0 ? '+' : ''); }

                return `
                <div class="flex justify-between items-center p-2 mb-2 bg-white border border-slate-100 rounded shadow-sm">
                    <span class="text-[10px] font-black text-slate-700 uppercase tracking-wide truncate max-w-[60%]">${escHtml(t.name)}</span>
                    <span class="text-[10px] font-black px-2 py-0.5 rounded border ${badgeClass} flex items-center gap-1">
                        <i class="fa-solid ${icon} text-[8px]"></i> ${prefix}${t.trend}%
                    </span>
                </div>`;
            }).join('');
            return `<div><h5 class="text-xs font-black text-slate-800 mb-3 border-b border-slate-200 pb-2 flex justify-between"><span>Growth Momentum</span><i class="fa-solid fa-chart-line text-slate-400"></i></h5>${html || '<p class="text-xs text-slate-400 font-bold">No data.</p>'}</div>`;
        };

        // Inject the 3 columns into the Matrix grid
        matrixEl.innerHTML = `
            ${buildTeacherRiskCol()}
            ${buildSubjectCol()}
            ${buildTrendCol()}
        `;

        // Reveal
        analyticsLoader.classList.add('hidden');
        analyticsSection.classList.remove('hidden');

    } catch (e) {
        console.error("Analytics Engine Error:", e);
        analyticsLoader.innerHTML = '<p class="text-xs font-bold text-red-500 uppercase tracking-widest">Analytics computation failed.</p>';
    }
}

function escHtml(str) {
    if (!str) return '';
    return String(str).replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/"/g,'&quot;');
}

// ── INITIALIZE ────────────────────────────────────────────────────────────
document.addEventListener('DOMContentLoaded', () => {
    loadOverviewStats();
    loadSemesters();
});
