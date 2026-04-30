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

// ── 4. INSTITUTIONAL ANALYTICS ENGINE ─────────────────────────────────────
async function loadSchoolAnalytics(teachersList, studentsList) {
    if (!session.activeSemesterId) {
        analyticsLoader.innerHTML = '<p class="text-xs font-bold text-amber-500 uppercase tracking-widest">No active grading period set. Cannot run analytics.</p>';
        return;
    }

    try {
        // 1. Build Teacher Rubric Cache (For perfectly synced weighted math)
        const teacherRubrics = {};
        teachersList.forEach(t => {
            teacherRubrics[t.id] = t.gradeTypes || t.customGradeTypes || [];
        });

        const studentAverages = [];
        const classAveragesMap = {};
        const matrixData = {
            academic: { mastery: [], execution: [], engagement: [] },
            behavioral: { adherence: [], resolution: [], respect: [] },
            end_of_year: { growth: [], social: [], resilience: [] }
        };

        // 2. Fetch Data for all active students (Grades & Evaluations)
        await Promise.all(studentsList.map(async (student) => {
            
            // Fetch Grades - UPDATED TO INCLUDE SCHOOL ID FILTER
            const gSnap = await getDocs(query(
                collection(db, 'students', student.id, 'grades'), 
                where('schoolId', '==', session.schoolId),
                where('semesterId', '==', session.activeSemesterId)
            ));
            
            const grades = gSnap.docs.map(d => d.data());
            
            if (grades.length > 0) {
                // Group by subject and calculate weighted average
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
            }

            // Fetch Evaluations for Matrix - UPDATED TO INCLUDE SCHOOL ID FILTER
            const eSnap = await getDocs(query(
                collection(db, 'students', student.id, 'evaluations'), 
                where('schoolId', '==', session.schoolId),
                where('semesterId', '==', session.activeSemesterId)
            ));
            
            eSnap.docs.forEach(doc => {
                const e = doc.data();
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
        }));

        // 3. Render Distribution Blocks
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

        // 4. Render Global Gauge
        const evaluatedCount = studentAverages.length;
        document.getElementById('evaluatedCountText').textContent = `${evaluatedCount} Students Evaluated`;
        
        if (evaluatedCount > 0) {
            const globalAvg = Math.round(globalSum / evaluatedCount);
            document.getElementById('globalTermAvgText').textContent = `${globalAvg}%`;
            
            // Animate SVG Gauge (125.6 is the total dasharray length for the half circle)
            const gaugePath = document.getElementById('globalGaugePath');
            const offset = 125.6 - ((globalAvg / 100) * 125.6);
            
            // Set color based on avg
            const color = globalAvg >= 80 ? '#10b981' : globalAvg >= 70 ? '#14b8a6' : globalAvg >= 65 ? '#f59e0b' : '#ef4444';
            gaugePath.setAttribute('stroke', color);
            
            setTimeout(() => { gaugePath.style.strokeDashoffset = offset; }, 100);
        }

        // 5. Render Class Rankings
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

        // 6. Render Global Matrix
        const matrixEl = document.getElementById('globalMatrixContainer');
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
