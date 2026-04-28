import { db } from '../../assets/js/firebase-init.js';
import { collection, getDocs, query, where } from "https://www.gstatic.com/firebasejs/10.7.1/firebase-firestore.js";
import { requireAuth } from '../../assets/js/auth.js';
import { injectAdminLayout } from '../../assets/js/layout-admin.js';
import { letterGrade, gradeColorClass, calculateWeightedAverage } from '../../assets/js/utils.js';

// ── 1. INIT ───────────────────────────────────────────────────────────────
const session = requireAuth('admin', '../login.html');
injectAdminLayout('reports', 'Reports & Analytics', 'School-wide performance intelligence', false, false);

// ── 2. STATE ──────────────────────────────────────────────────────────────
let allSemesters   = [];
let allTeachers    = [];
let allStudents    = [];
let CLASSES        = [];

// ── 3. HELPERS ────────────────────────────────────────────────────────────
function escHtml(s) {
    return String(s || '').replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;');
}

// ── 4. LIVE KPI DASHBOARD (loads on page open) ────────────────────────────
async function loadLiveDashboard() {
    try {
        const activeSem = allSemesters.find(s => s.id === session.activeSemesterId);
        const kpiLabel  = document.getElementById('kpiPeriodLabel');
        if (kpiLabel) kpiLabel.textContent = activeSem ? activeSem.name : 'All Periods';

        const studentAvgs = [];
        let totalAssessments = 0;
        let atRiskCount = 0;

        // TRUE ROLLUP: Student -> Subjects -> Overall
        await Promise.all(allStudents.map(async s => {
            const snap = await getDocs(collection(db, 'schools', session.schoolId, 'students', s.id, 'grades'));
            const grades = snap.docs.map(d => d.data()).filter(g =>
                !session.activeSemesterId || session.activeSemesterId === 'all' || g.semesterId === session.activeSemesterId
            );
            
            totalAssessments += grades.length;
            if (grades.length === 0) return; 

            const bySubj = {};
            grades.forEach(g => {
                const sub = g.subject || 'Uncategorized';
                if (!bySubj[sub]) bySubj[sub] = [];
                bySubj[sub].push(g);
            });

            let sumAvgs = 0, totalSubjs = 0, failingSubjects = 0;
            Object.values(bySubj).forEach(subGrades => {
                const roundedSubAvg = calculateWeightedAverage(subGrades, session.schoolId);
                if (roundedSubAvg !== null) {
                    sumAvgs += roundedSubAvg;
                    totalSubjs++;
                    if (roundedSubAvg < 60) failingSubjects++;
                }
            });

            if (totalSubjs > 0) {
                const cumulativeAvg = Math.round(sumAvgs / totalSubjs);
                studentAvgs.push(cumulativeAvg);
                if (cumulativeAvg < 60 || failingSubjects > 0) atRiskCount++;
            }
        }));

        const meanAvg  = studentAvgs.length ? Math.round(studentAvgs.reduce((a, b) => a + b, 0) / studentAvgs.length) : null;
        const passRate = studentAvgs.length ? Math.round(studentAvgs.filter(a => a >= 60).length / studentAvgs.length * 100) : null;

        const kpiCards = document.getElementById('kpiCards');
        if (!kpiCards) return;

        kpiCards.innerHTML = [
            {
                icon: 'fa-graduation-cap', iconColor: '#2563eb', bg: '#eef4ff',
                val:  meanAvg !== null ? meanAvg + '%' : '—',
                lbl:  'School Mean Average',
                sub:  meanAvg !== null ? (meanAvg >= 75 ? '▲ Good standing' : meanAvg >= 60 ? '~ Acceptable' : '▼ Needs attention') : 'No grade data',
                subColor: meanAvg !== null ? (meanAvg >= 75 ? '#0ea871' : meanAvg >= 60 ? '#b45309' : '#e31b4a') : '#9ab0c6'
            },
            {
                icon: 'fa-check-circle', iconColor: '#0ea871', bg: '#edfaf4',
                val:  passRate !== null ? passRate + '%' : '—',
                lbl:  'Pass Rate (≥60%)',
                sub:  studentAvgs.length ? `${studentAvgs.filter(a => a >= 60).length} of ${studentAvgs.length} graded students` : 'No data',
                subColor: '#6b84a0'
            },
            {
                icon: 'fa-triangle-exclamation', iconColor: '#e31b4a', bg: '#fff0f3',
                val:  atRiskCount,
                lbl:  'At-Risk Students',
                sub:  atRiskCount > 0 ? 'Failing overall or failing core subjects' : 'No at-risk students',
                subColor: atRiskCount > 0 ? '#e31b4a' : '#0ea871'
            },
            {
                icon: 'fa-users', iconColor: '#f59e0b', bg: '#fffbeb',
                val:  allStudents.length,
                lbl:  'Active Students',
                sub:  totalAssessments.toLocaleString() + ' assessments logged',
                subColor: '#6b84a0'
            }
        ].map(k => `
            <div class="kpi-card">
                <div class="kpi-icon" style="background:${k.bg}">
                    <i class="fa-solid ${k.icon}" style="color:${k.iconColor};font-size:16px"></i>
                </div>
                <div style="flex:1;min-width:0">
                    <div class="kpi-val">${k.val}</div>
                    <div class="kpi-lbl">${k.lbl}</div>
                    <div style="font-size:10.5px;font-weight:600;color:${k.subColor};margin-top:3px">${k.sub}</div>
                </div>
            </div>`).join('');

    } catch (e) {
        console.error('[Reports] loadLiveDashboard:', e);
    }
}

// ── 5. DYNAMIC SUBJECT POPULATION ─────────────────────────────────────────
function populateSubjects() {
    const scope  = document.getElementById('reportScope').value;
    const target = document.getElementById('reportTarget').value;
    const subjectSelect = document.getElementById('reportSubject');
    
    const currentSelection = subjectSelect.value;
    
    subjectSelect.innerHTML = '<option value="all">All Subjects</option>';
    let validSubjects = new Set();

    if (scope === 'school') {
        allTeachers.forEach(t => {
            if (t.subjects) t.subjects.forEach(sub => validSubjects.add(typeof sub === 'string' ? sub : sub.name));
        });
    } else if (scope === 'teacher' && target) {
        const t = allTeachers.find(x => x.id === target);
        if (t && t.subjects) t.subjects.forEach(sub => validSubjects.add(typeof sub === 'string' ? sub : sub.name));
    } else if (scope === 'class' && target) {
        const teachers = allTeachers.filter(t => t.classes && t.classes.includes(target) || t.className === target);
        teachers.forEach(t => {
            if (t.subjects) t.subjects.forEach(sub => validSubjects.add(typeof sub === 'string' ? sub : sub.name));
        });
    } else if (scope === 'student' && target) {
        const s = allStudents.find(x => x.id === target);
        if (s && s.teacherId) {
            const t = allTeachers.find(x => x.id === s.teacherId);
            if (t && t.subjects) t.subjects.forEach(sub => validSubjects.add(typeof sub === 'string' ? sub : sub.name));
        }
    }

    Array.from(validSubjects).sort().forEach(subName => {
        if(subName) subjectSelect.innerHTML += `<option value="${escHtml(subName)}">${escHtml(subName)}</option>`;
    });
    
    let hasSelection = false;
    for (let i = 0; i < subjectSelect.options.length; i++) {
        if (subjectSelect.options[i].value === currentSelection) hasSelection = true;
    }
    if (hasSelection) subjectSelect.value = currentSelection;
}

// ── 6. INIT BUILDER DROPDOWNS ─────────────────────────────────────────────
async function initializeBuilder() {
    try {
        const [semSnap, tSnap, sSnap] = await Promise.all([
            getDocs(collection(db, 'schools', session.schoolId, 'semesters')),
            getDocs(query(collection(db, 'teachers'), where('currentSchoolId', '==', session.schoolId))),
            getDocs(query(collection(db, 'students'),
                where('currentSchoolId', '==', session.schoolId),
                where('enrollmentStatus', '==', 'Active')))
        ]);

        allSemesters = semSnap.docs.map(d => ({ id: d.id, ...d.data() }))
                                   .filter(s => !s.archived)
                                   .sort((a, b) => a.order - b.order);
        allTeachers  = tSnap.docs.map(d => ({ id: d.id, ...d.data() }));
        allStudents  = sSnap.docs.map(d => ({ id: d.id, ...d.data() }));

        const reportPeriod = document.getElementById('reportPeriod');
        allSemesters.forEach(s => {
            const o = document.createElement('option');
            o.value = s.id;
            o.textContent = s.name;
            if (s.id === session.activeSemesterId) o.selected = true;
            reportPeriod.appendChild(o);
        });

        const schoolType = session.schoolType || 'Primary';
        CLASSES = schoolType === 'Primary'
            ? ['Infant 1','Infant 2','Standard 1','Standard 2','Standard 3','Standard 4','Standard 5','Standard 6']
            : schoolType === 'High School'
            ? ['First Form','Second Form','Third Form','Fourth Form']
            : ['Year 1','Year 2'];

        await loadLiveDashboard();
        
        populateSubjects();

    } catch (e) {
        console.error('[Reports] initializeBuilder:', e);
    }
}

// ── 7. SCOPE & TARGET DROPDOWNS ───────────────────────────────────────────
document.getElementById('reportScope').addEventListener('change', e => {
    const scope  = e.target.value;
    const tc     = document.getElementById('targetContainer');
    const target = document.getElementById('reportTarget');
    target.innerHTML = '<option value="">Select target...</option>';

    if (scope === 'school') { 
        tc.classList.add('hidden'); 
        populateSubjects();
        return; 
    }
    
    tc.classList.remove('hidden');

    if (scope === 'teacher') {
        document.getElementById('targetLabel').textContent = 'Select Teacher';
        allTeachers.forEach(t => target.innerHTML += `<option value="${t.id}">${escHtml(t.name)}</option>`);
    } else if (scope === 'class') {
        document.getElementById('targetLabel').textContent = 'Select Class';
        CLASSES.forEach(c => target.innerHTML += `<option value="${c}">${c}</option>`);
    } else if (scope === 'student') {
        document.getElementById('targetLabel').textContent = 'Select Student';
        allStudents.forEach(s => target.innerHTML += `<option value="${s.id}">${escHtml(s.name)} (${s.className || 'Unassigned'})</option>`);
    }
    
    populateSubjects();
});

document.getElementById('reportTarget').addEventListener('change', populateSubjects);


// ── 8. GENERATE REPORT ────────────────────────────────────────────────────
document.getElementById('generateBtn').addEventListener('click', async () => {
    const period  = document.getElementById('reportPeriod').value;
    const periodName = document.getElementById('reportPeriod').options[document.getElementById('reportPeriod').selectedIndex].text;
    const scope   = document.getElementById('reportScope').value;
    const target  = document.getElementById('reportTarget').value;
    const subjectFilter = document.getElementById('reportSubject').value;

    if (scope !== 'school' && !target) { alert('Please select a target.'); return; }

    const results = document.getElementById('reportResults');
    const loader  = document.getElementById('reportLoader');
    results.classList.add('hidden', 'opacity-0');
    loader.classList.remove('hidden');
    loader.classList.add('flex');

    try {
        // Determine scope students
        let targetStudents = allStudents;
        let titleText = 'School-Wide Performance';
        let subtitleText = '';

        if (scope === 'teacher') {
            targetStudents = allStudents.filter(s => s.teacherId === target);
            const t = allTeachers.find(t => t.id === target);
            titleText    = `Teacher Report — ${t?.name || target}`;
            subtitleText = `${targetStudents.length} students under this teacher`;
        } else if (scope === 'class') {
            targetStudents = allStudents.filter(s => s.className === target);
            titleText    = `Class Report — ${target}`;
            subtitleText = `${targetStudents.length} students in this class`;
        } else if (scope === 'student') {
            targetStudents = allStudents.filter(s => s.id === target);
            titleText    = `Student Report — ${targetStudents[0]?.name || target}`;
            subtitleText = targetStudents[0]?.className || '';
        } else {
            subtitleText = `${targetStudents.length} active students`;
        }

        document.getElementById('reportTitle').textContent    = titleText;
        document.getElementById('reportSubtitle').textContent = subtitleText;

        // Populate Formal Print Header
        document.getElementById('phSchoolName').textContent = session.schoolName || 'ConnectUs School';
        document.getElementById('phReportType').textContent = titleText;
        document.getElementById('phMeta').innerHTML = `
            Term: ${periodName} <br>
            ${scope === 'student' ? 'Student Class: ' + subtitleText : subtitleText} <br>
            Generated: ${new Date().toLocaleDateString()}
        `;

        // ── Fetch and Process Grades (TRUE ROLLUP) ───────────────────────
        const allFilteredGrades = [];
        const processedStudents = [];
        let totalScopeAssessments = 0;

        await Promise.all(targetStudents.map(async s => {
            const snap = await getDocs(collection(db, 'schools', session.schoolId, 'students', s.id, 'grades'));
            const grades = snap.docs.map(d => d.data()).filter(g => {
                if (period !== 'all' && g.semesterId !== period) return false;
                if (subjectFilter !== 'all' && g.subject !== subjectFilter) return false;
                return true;
            });
            
            totalScopeAssessments += grades.length;
            grades.forEach(g => { g.studentId = s.id; g.studentName = s.name; g.className = s.className; });
            allFilteredGrades.push(...grades);

            if (grades.length === 0) {
                processedStudents.push({ id: s.id, name: s.name, className: s.className, teacherId: s.teacherId, hasData: false });
                return;
            }

            // Group by Subject
            const bySubj = {};
            grades.forEach(g => {
                const sub = g.subject || 'Uncategorized';
                if (!bySubj[sub]) bySubj[sub] = [];
                bySubj[sub].push(g);
            });

            let sumAvgs = 0, totalSubjs = 0;
            const failingSubjects = [];
            const strongSubjects = [];
            const subjectAverages = [];

            Object.entries(bySubj).forEach(([sub, subGrades]) => {
                const roundedSubAvg = calculateWeightedAverage(subGrades, session.schoolId);
                if (roundedSubAvg !== null) {
                    sumAvgs += roundedSubAvg;
                    totalSubjs++;
                    
                    subjectAverages.push({ name: sub, avg: roundedSubAvg });

                    if (roundedSubAvg < 60) failingSubjects.push({ name: sub, avg: roundedSubAvg });
                    if (roundedSubAvg >= 80) strongSubjects.push({ name: sub, avg: roundedSubAvg });
                }
            });

            const cumulativeAvg = totalSubjs > 0 ? Math.round(sumAvgs / totalSubjs) : null;
            const isAtRisk = cumulativeAvg !== null && (cumulativeAvg < 60 || failingSubjects.length > 0);

            processedStudents.push({
                id: s.id, name: s.name, className: s.className, teacherId: s.teacherId,
                hasData: true,
                cumulativeAvg: cumulativeAvg,
                totalSubjects: totalSubjs,
                subjectAverages: subjectAverages.sort((a,b) => b.avg - a.avg), 
                failingSubjects: failingSubjects.sort((a,b) => a.avg - b.avg),
                strongSubjects: strongSubjects.sort((a,b) => b.avg - a.avg),
                isAtRisk: isAtRisk
            });
        }));

        const gradedStudents = processedStudents.filter(s => s.hasData);

        // ── UPDATE KPI DASHBOARD DYNAMICALLY ────────────────────────────────
        if (scope === 'student') {
            const single = processedStudents[0];
            const hasGrades = single && single.hasData;

            document.getElementById('rMeanAvgLbl').textContent = "Cumulative Avg";
            document.getElementById('rMeanAvg').textContent = hasGrades ? `${single.cumulativeAvg}%` : 'N/A';
            document.getElementById('rMeanAvg').style.color = hasGrades ? (single.cumulativeAvg >= 75 ? '#0ea871' : single.cumulativeAvg >= 60 ? '#b45309' : '#e31b4a') : '#9ab0c6';

            document.getElementById('rPassRateLbl').textContent = "Subjects Passed";
            const passedCount = hasGrades ? (single.totalSubjects - single.failingSubjects.length) : 0;
            document.getElementById('rPassRate').textContent = hasGrades ? `${passedCount} / ${single.totalSubjects}` : 'N/A';
            document.getElementById('rPassRate').style.color = hasGrades ? (passedCount === single.totalSubjects ? '#0ea871' : '#b45309') : '#9ab0c6';

            document.getElementById('rAtRiskLbl').textContent = "Failing Subjects";
            document.getElementById('rAtRisk').textContent = hasGrades ? single.failingSubjects.length : 0;
            document.getElementById('rAtRisk').style.color = hasGrades && single.failingSubjects.length > 0 ? '#e31b4a' : '#0ea871';

        } else {
            const meanAvg  = gradedStudents.length ? Math.round(gradedStudents.reduce((s, x) => s + x.cumulativeAvg, 0) / gradedStudents.length) : null;
            const passRate = gradedStudents.length ? Math.round(gradedStudents.filter(x => x.cumulativeAvg >= 60 && x.failingSubjects.length === 0).length / gradedStudents.length * 100) : null;
            const atRiskCount = gradedStudents.filter(x => x.isAtRisk).length;

            document.getElementById('rMeanAvgLbl').textContent = "Mean Average";
            document.getElementById('rMeanAvg').textContent = meanAvg !== null ? meanAvg + '%' : 'N/A';
            document.getElementById('rMeanAvg').style.color = meanAvg !== null ? (meanAvg >= 75 ? '#0ea871' : meanAvg >= 60 ? '#b45309' : '#e31b4a') : '#9ab0c6';

            document.getElementById('rPassRateLbl').textContent = "Pass Rate";
            document.getElementById('rPassRate').textContent = passRate !== null ? passRate + '%' : 'N/A';
            document.getElementById('rPassRate').style.color = passRate !== null ? (passRate >= 75 ? '#0ea871' : passRate >= 50 ? '#b45309' : '#e31b4a') : '#9ab0c6';

            document.getElementById('rAtRiskLbl').textContent = "At Risk Students";
            document.getElementById('rAtRisk').textContent = atRiskCount;
            document.getElementById('rAtRisk').style.color = atRiskCount > 0 ? '#e31b4a' : '#0ea871';
        }

        document.getElementById('rVolume').textContent = totalScopeAssessments.toLocaleString();

        // ── GRADE DISTRIBUTION, STRENGTHS/WEAKNESSES, OR PASS/FAIL ────────
        if (scope === 'student') {
            document.getElementById('distributionSection').classList.add('hidden');
            document.getElementById('atRiskSection').classList.add('hidden');
            document.getElementById('teacherPerfSection').classList.add('hidden');
            
            const single = processedStudents[0];
            
            document.getElementById('passFailTitle').textContent = "Strengths & Areas for Growth";
            
            if (single && single.hasData) {
                const strongHtml = single.strongSubjects.length > 0 
                    ? single.strongSubjects.map(s => `<div class="flex justify-between items-center py-2 border-b border-[#e2e8f0] last:border-0"><span class="text-[13px] font-bold text-[#0d1f35]">${escHtml(s.name)}</span><span class="text-[14px] font-black text-[#0ea871]">${s.avg}%</span></div>`).join('')
                    : '<p class="text-[12px] text-[#6b84a0] italic">No subjects currently over 80%.</p>';
                    
                const weakHtml = single.failingSubjects.length > 0
                    ? single.failingSubjects.map(s => `<div class="flex justify-between items-center py-2 border-b border-[#e2e8f0] last:border-0"><span class="text-[13px] font-bold text-[#0d1f35]">${escHtml(s.name)}</span><span class="text-[14px] font-black text-[#e31b4a]">${s.avg}%</span></div>`).join('')
                    : '<p class="text-[12px] text-[#0ea871] font-bold"><i class="fa-solid fa-check-circle mr-1"></i> Passing all enrolled subjects.</p>';

                document.getElementById('passFailBody').innerHTML = `
                    <div style="display:grid;grid-template-columns:1fr 1fr;gap:16px">
                        <div style="background:#edfaf4;border:1px solid #c6f0db;border-radius:var(--r-md);padding:20px;">
                            <div style="font-size:11px;font-weight:800;color:#0b8f5e;text-transform:uppercase;letter-spacing:0.08em;margin-bottom:12px;border-bottom:1px solid #a7f3d0;padding-bottom:8px;"><i class="fa-solid fa-arrow-trend-up mr-1"></i> Core Strengths (≥80%)</div>
                            ${strongHtml}
                        </div>
                        <div style="background:#fff0f3;border:1px solid #ffd6de;border-radius:var(--r-md);padding:20px;">
                            <div style="font-size:11px;font-weight:800;color:#be1240;text-transform:uppercase;letter-spacing:0.08em;margin-bottom:12px;border-bottom:1px solid #fecaca;padding-bottom:8px;"><i class="fa-solid fa-triangle-exclamation mr-1"></i> Critical Weaknesses (&lt;60%)</div>
                            ${weakHtml}
                        </div>
                    </div>`;
            } else {
                document.getElementById('passFailBody').innerHTML = `<p class="text-center text-[#9ab0c6] italic text-[13px]">No grade data available for analysis.</p>`;
            }

        } else {
            document.getElementById('distributionSection').classList.remove('hidden');
            document.getElementById('atRiskSection').classList.remove('hidden');

            const dist = { a:0, b:0, c:0, d:0, f:0 };
            gradedStudents.forEach(x => {
                if (x.cumulativeAvg >= 90) dist.a++;
                else if (x.cumulativeAvg >= 80) dist.b++;
                else if (x.cumulativeAvg >= 70) dist.c++;
                else if (x.cumulativeAvg >= 60) dist.d++;
                else dist.f++;
            });
            const totalG = gradedStudents.length || 1;
            const seg = (pct, color, label, count) => count
                ? `<div class="dist-seg" style="width:${pct}%;background:${color}" title="${label}: ${count}">${count}</div>` : '';
            document.getElementById('distBar').innerHTML = gradedStudents.length 
                ? [
                    seg(dist.a/totalG*100, '#0ea871', 'A (90–100%)', dist.a),
                    seg(dist.b/totalG*100, '#2563eb', 'B (80–89%)', dist.b),
                    seg(dist.c/totalG*100, '#0891b2', 'C (70–79%)', dist.c),
                    seg(dist.d/totalG*100, '#f59e0b', 'D (60–69%)', dist.d),
                    seg(dist.f/totalG*100, '#e31b4a', 'F (<60%)', dist.f)
                ].join('')
                : '<div class="dist-seg" style="width:100%;background:#e2e8f0;color:#9ab0c6;font-size:12px">No grade data</div>';

            document.getElementById('distLabels').innerHTML = [
                ['A', dist.a, '#0ea871', '90–100%'], ['B', dist.b, '#2563eb', '80–89%'],
                ['C', dist.c, '#0891b2', '70–79%'], ['D', dist.d, '#f59e0b', '60–69%'],
                ['F', dist.f, '#e31b4a', '<60%']
            ].map(([l, n, c, r]) => `
                <div style="display:flex;align-items:center;gap:6px">
                    <div style="width:12px;height:12px;border-radius:3px;background:${c}"></div>
                    <span style="font-size:12px;font-weight:700;color:#374f6b">${l} ${r}</span>
                    <span style="font-size:12px;font-weight:600;color:#9ab0c6">${n} students</span>
                </div>`).join('');

            const passCount = gradedStudents.filter(x => x.cumulativeAvg >= 60 && x.failingSubjects.length === 0).length;
            const failCount = gradedStudents.length - passCount;
            const passPct   = totalG >= 1 ? Math.round(passCount / totalG * 100) : 0;
            
            document.getElementById('passFailTitle').textContent = "Pass / Fail Breakdown";
            document.getElementById('passFailBody').innerHTML = `
                <div style="display:grid;grid-template-columns:1fr 1fr;gap:16px">
                    <div style="background:#edfaf4;border:1px solid #c6f0db;border-radius:var(--r-md);padding:20px;text-align:center">
                        <div style="font-size:36px;font-weight:700;color:#0ea871">${passCount}</div>
                        <div style="font-size:11px;font-weight:700;color:#0b8f5e;text-transform:uppercase;letter-spacing:0.08em;margin-top:4px">Passing (All Subjects)</div>
                        <div style="font-size:13px;font-weight:600;color:#6b84a0;margin-top:6px">${passPct}% of graded students</div>
                    </div>
                    <div style="background:#fff0f3;border:1px solid #ffd6de;border-radius:var(--r-md);padding:20px;text-align:center">
                        <div style="font-size:36px;font-weight:700;color:#e31b4a">${failCount}</div>
                        <div style="font-size:11px;font-weight:700;color:#be1240;text-transform:uppercase;letter-spacing:0.08em;margin-top:4px">Failing (≥1 Subject)</div>
                        <div style="font-size:13px;font-weight:600;color:#6b84a0;margin-top:6px">${totalG >= 1 ? 100 - passPct : 0}% of graded students</div>
                    </div>
                </div>`;
            
            // ── At-Risk roster ─────────────────────────────────────────────────
            const atRiskStudents = gradedStudents.filter(x => x.isAtRisk);
            document.getElementById('atRiskCount').textContent = `${atRiskStudents.length} student${atRiskStudents.length !== 1 ? 's' : ''}`;
            document.getElementById('atRiskBody').innerHTML = atRiskStudents.length
                ? atRiskStudents.sort((a, b) => a.cumulativeAvg - b.cumulativeAvg).map(s => {
                    let riskReason = '';
                    if (s.cumulativeAvg < 60) {
                        riskReason = `Failing Overall Average (${s.cumulativeAvg}%)`;
                    } else {
                        riskReason = `Failing Core Subject(s): ${s.failingSubjects.map(sub => sub.name).join(', ')}`;
                    }

                    return `
                    <div class="at-risk-row">
                        <div style="display:flex;align-items:center;gap:12px">
                            <div style="width:32px;height:32px;border-radius:8px;background:#fff0f3;border:1px solid #ffd6de;display:flex;align-items:center;justify-content:center;font-size:12px;font-weight:700;color:#e31b4a;flex-shrink:0">
                                ${(s.name || 'S').split(' ').map(w => w[0]).join('').toUpperCase().slice(0, 2)}
                            </div>
                            <div>
                                <p style="font-size:13px;font-weight:600;color:#0d1f35;margin:0">${escHtml(s.name)}</p>
                                <p style="font-size:11px;color:#6b84a0;font-weight:500;margin:2px 0 0">${s.className || 'Unassigned'}</p>
                            </div>
                        </div>
                        <div style="text-align:right">
                            <span style="font-size:18px;font-weight:700;color:#e31b4a">${s.cumulativeAvg}%</span>
                            <p style="font-size:10.5px;font-weight:600;color:#e31b4a;margin:2px 0 0">${riskReason}</p>
                        </div>
                    </div>`
                }).join('')
                : '<div style="padding:24px;text-align:center;color:#0ea871;font-weight:600;font-size:13px"><i class="fa-solid fa-circle-check" style="margin-right:6px"></i>No at-risk students for this filter.</div>';
        }

        // ── Subject Performance Table ──────────────────────────────────────
        const bySubjGlobal = {};
        allFilteredGrades.forEach(g => {
            const sub = g.subject || 'Uncategorized';
            if (!bySubjGlobal[sub]) bySubjGlobal[sub] = [];
            bySubjGlobal[sub].push(g);
        });

        const subjRows = Object.entries(bySubjGlobal)
            .map(([sub, grades]) => {
                const avg    = calculateWeightedAverage(grades, session.schoolId) || 0;
                const pass   = grades.filter(g => g.max && (g.score / g.max * 100) >= 60).length;
                const pct    = grades.length ? Math.round(pass / grades.length * 100) : 0;
                const col    = avg >= 75 ? '#0ea871' : avg >= 60 ? '#b45309' : '#e31b4a';
                return `<tr style="border-bottom:1px solid #f0f4f8">
                    <td style="padding:12px 20px;font-size:13px;font-weight:600;color:#0d1f35">${escHtml(sub)}</td>
                    <td style="padding:12px 20px;text-align:center;font-size:13px;color:#6b84a0">${grades.length}</td>
                    <td style="padding:12px 20px;text-align:center;font-size:14px;font-weight:700;color:${col}">${avg}%</td>
                    <td style="padding:12px 20px;text-align:center;font-size:13px;color:#6b84a0">${pct}% assignments passed</td>
                </tr>`;
            })
            .sort((a, b) => a.localeCompare(b))
            .join('');

        document.getElementById('subjectBody').innerHTML = `
            <table style="width:100%">
                <thead style="background:#f8fafb;border-bottom:2px solid #dce3ed">
                    <tr>
                        <th style="padding:10px 20px;text-align:left;font-size:10px;font-weight:700;color:#6b84a0;text-transform:uppercase;letter-spacing:0.1em">Subject</th>
                        <th style="padding:10px 20px;text-align:center;font-size:10px;font-weight:700;color:#6b84a0;text-transform:uppercase;letter-spacing:0.1em">Assessments</th>
                        <th style="padding:10px 20px;text-align:center;font-size:10px;font-weight:700;color:#6b84a0;text-transform:uppercase;letter-spacing:0.1em">Mean Avg</th>
                        <th style="padding:10px 20px;text-align:center;font-size:10px;font-weight:700;color:#6b84a0;text-transform:uppercase;letter-spacing:0.1em">Pass Rate</th>
                    </tr>
                </thead>
                <tbody>${subjRows || '<tr><td colspan="4" style="padding:24px;text-align:center;color:#9ab0c6;font-style:italic">No subject data for this filter.</td></tr>'}</tbody>
            </table>`;

        // ── Comparison table ───────────────────────────────────────────────
        renderTable(scope, gradedStudents, allFilteredGrades, processedStudents);

        // ── Teacher performance (school-wide only) ─────────────────────────
        const tpSection = document.getElementById('teacherPerfSection');
        if (scope === 'school') {
            tpSection.classList.remove('hidden');
            const byTeacher = {};
            allTeachers.forEach(t => { byTeacher[t.id] = { name: t.name, students: [], avgs: [] }; });
            gradedStudents.forEach(s => {
                if (s.teacherId && byTeacher[s.teacherId]) {
                    byTeacher[s.teacherId].avgs.push(s.cumulativeAvg);
                }
            });

            document.getElementById('teacherPerfBody').innerHTML = allTeachers
                .filter(t => byTeacher[t.id]?.avgs.length > 0)
                .map(t => {
                    const avgs      = byTeacher[t.id].avgs;
                    const mean      = Math.round(avgs.reduce((s, a) => s + a, 0) / avgs.length);
                    const pass      = avgs.filter(a => a >= 60).length;
                    const passPct   = Math.round(pass / avgs.length * 100);
                    const risk      = avgs.filter(a => a < 60).length; 
                    const col       = mean >= 75 ? '#0ea871' : mean >= 60 ? '#b45309' : '#e31b4a';
                    return `<tr style="border-bottom:1px solid #f0f4f8">
                        <td style="padding:12px 20px;font-size:13px;font-weight:600;color:#0d1f35">${escHtml(t.name)}</td>
                        <td style="padding:12px 20px;text-align:center;font-size:13px;color:#6b84a0">${avgs.length}</td>
                        <td style="padding:12px 20px;text-align:center;font-size:14px;font-weight:700;color:${col}">${mean}%</td>
                        <td style="padding:12px 20px;text-align:center;font-size:13px;font-weight:600;color:${passPct >= 60 ? '#0ea871' : '#e31b4a'}">${passPct}%</td>
                        <td style="padding:12px 20px;text-align:center;font-size:13px;font-weight:700;color:${risk > 0 ? '#e31b4a' : '#9ab0c6'}">${risk}</td>
                    </tr>`;
                }).join('') || '<tr><td colspan="5" style="padding:24px;text-align:center;color:#9ab0c6;font-style:italic">No teacher data available.</td></tr>';
        } else if (tpSection) {
            tpSection.classList.add('hidden');
        }

        // ── Show results ───────────────────────────────────────────────────
        loader.classList.remove('flex');
        loader.classList.add('hidden');
        results.classList.remove('hidden');
        setTimeout(() => results.classList.remove('opacity-0'), 50);
        results.scrollIntoView({ behavior: 'smooth', block: 'start' });

    } catch (e) {
        console.error('[Reports] generate:', e);
        alert('An error occurred while building the report. Please try again.');
        document.getElementById('reportLoader').classList.remove('flex');
        document.getElementById('reportLoader').classList.add('hidden');
    }
});

// ── 9. COMPARISON TABLE ────────────────────────────────────────────────────
function renderTable(scope, gradedStudents, allGrades, processedStudents) {
    const head = document.getElementById('reportTableHead');
    const body = document.getElementById('reportTableBody');

    if (scope === 'school') {
        document.getElementById('tableTitle').textContent = 'Class Performance';
        head.innerHTML = `<tr>
            <th style="padding:10px 20px;text-align:left;font-size:10px;font-weight:700;text-transform:uppercase;letter-spacing:0.1em">Class</th>
            <th style="padding:10px 20px;text-align:center;font-size:10px;font-weight:700;text-transform:uppercase;letter-spacing:0.1em">Students</th>
            <th style="padding:10px 20px;text-align:center;font-size:10px;font-weight:700;text-transform:uppercase;letter-spacing:0.1em">Mean Avg</th>
            <th style="padding:10px 20px;text-align:center;font-size:10px;font-weight:700;text-transform:uppercase;letter-spacing:0.1em">Pass Rate</th>
            <th style="padding:10px 20px;text-align:center;font-size:10px;font-weight:700;text-transform:uppercase;letter-spacing:0.1em">At Risk</th>
        </tr>`;

        const byClass = {};
        gradedStudents.forEach(s => {
            const c = s.className || 'Unassigned';
            if (!byClass[c]) byClass[c] = { avgs: [], atRisk: 0 };
            byClass[c].avgs.push(s.cumulativeAvg);
            if (s.isAtRisk) byClass[c].atRisk++;
        });

        body.innerHTML = Object.entries(byClass)
            .sort((a, b) => (b[1].avgs.reduce((x,y)=>x+y,0)/b[1].avgs.length) - (a[1].avgs.reduce((x,y)=>x+y,0)/a[1].avgs.length))
            .map(([cls, data]) => {
                const mean    = Math.round(data.avgs.reduce((s, a) => s + a, 0) / data.avgs.length);
                const pass    = data.avgs.filter(a => a >= 60).length;
                const passPct = Math.round(pass / data.avgs.length * 100);
                const risk    = data.atRisk;
                const col     = mean >= 75 ? '#0ea871' : mean >= 60 ? '#b45309' : '#e31b4a';
                return `<tr class="gb-row">
                    <td style="padding:12px 20px;font-size:13px;font-weight:600;color:#0d1f35">${escHtml(cls)}</td>
                    <td style="padding:12px 20px;text-align:center;font-size:13px;color:#6b84a0">${data.avgs.length}</td>
                    <td style="padding:12px 20px;text-align:center;font-size:14px;font-weight:700;color:${col}">${mean}%</td>
                    <td style="padding:12px 20px;text-align:center;font-size:13px;font-weight:600;color:${passPct>=60?'#0ea871':'#e31b4a'}">${passPct}%</td>
                    <td style="padding:12px 20px;text-align:center;font-size:13px;font-weight:700;color:${risk>0?'#e31b4a':'#9ab0c6'}">${risk}</td>
                </tr>`;
            }).join('');

    } else if (scope === 'teacher' || scope === 'class') {
        document.getElementById('tableTitle').textContent = 'Student Rankings';
        head.innerHTML = `<tr>
            <th style="padding:10px 20px;text-align:left;font-size:10px;font-weight:700;text-transform:uppercase;letter-spacing:0.1em">Student</th>
            <th style="padding:10px 20px;text-align:center;font-size:10px;font-weight:700;text-transform:uppercase;letter-spacing:0.1em">Cumulative Avg</th>
            <th style="padding:10px 20px;text-align:center;font-size:10px;font-weight:700;text-transform:uppercase;letter-spacing:0.1em">Grade</th>
            <th style="padding:10px 20px;text-align:center;font-size:10px;font-weight:700;text-transform:uppercase;letter-spacing:0.1em">Assessments</th>
            <th style="padding:10px 20px;text-align:center;font-size:10px;font-weight:700;text-transform:uppercase;letter-spacing:0.1em">Status</th>
        </tr>`;

        body.innerHTML = gradedStudents.sort((a, b) => b.cumulativeAvg - a.cumulativeAvg).map((s, i) => {
            const col   = s.cumulativeAvg >= 75 ? '#0ea871' : s.cumulativeAvg >= 60 ? '#b45309' : '#e31b4a';
            const status = !s.isAtRisk ? (s.cumulativeAvg >= 75 ? 'Good Standing' : 'Acceptable') : 'At Risk';
            const sBg    = !s.isAtRisk ? (s.cumulativeAvg >= 75 ? 'background:#edfaf4;color:#0b8f5e;border:1px solid #c6f0db' : 'background:#f8fafb;color:#374f6b;border:1px solid #dce3ed')
                         : 'background:#fff0f3;color:#be1240;border:1px solid #ffd6de';
            
            const studentAssessments = allGrades.filter(g => g.studentId === s.id).length;

            return `<tr class="gb-row">
                <td style="padding:12px 20px;font-size:13px;font-weight:600;color:#0d1f35">
                    <span style="font-size:10px;color:#9ab0c6;font-weight:700;margin-right:6px">#${i+1}</span>${escHtml(s.name)}
                </td>
                <td style="padding:12px 20px;text-align:center;font-size:14px;font-weight:700;color:${col}">${s.cumulativeAvg}%</td>
                <td style="padding:12px 20px;text-align:center;font-size:14px;font-weight:700;color:${col}">${letterGrade(s.cumulativeAvg)}</td>
                <td style="padding:12px 20px;text-align:center;font-size:13px;color:#6b84a0">${studentAssessments}</td>
                <td style="padding:12px 20px;text-align:center"><span style="font-size:11px;font-weight:700;padding:3px 10px;border-radius:99px;${sBg}">${status}</span></td>
            </tr>`;
        }).join('');

    } else if (scope === 'student') {
        document.getElementById('tableTitle').textContent = 'Subject Breakdown';
        head.innerHTML = `<tr>
            <th style="padding:10px 20px;text-align:left;font-size:10px;font-weight:700;text-transform:uppercase;letter-spacing:0.1em">Subject</th>
            <th style="padding:10px 20px;text-align:center;font-size:10px;font-weight:700;text-transform:uppercase;letter-spacing:0.1em">Avg</th>
            <th style="padding:10px 20px;text-align:center;font-size:10px;font-weight:700;text-transform:uppercase;letter-spacing:0.1em">Grade</th>
            <th style="padding:10px 20px;text-align:center;font-size:10px;font-weight:700;text-transform:uppercase;letter-spacing:0.1em">Assessments</th>
        </tr>`;

        const single = processedStudents[0];
        if(single && single.hasData) {
            body.innerHTML = single.subjectAverages.map(subObj => {
                const avg = subObj.avg;
                const col = avg >= 75 ? '#0ea871' : avg >= 60 ? '#b45309' : '#e31b4a';
                const count = allGrades.filter(g => g.subject === subObj.name).length;
                return `<tr class="gb-row">
                    <td style="padding:12px 20px;font-size:13px;font-weight:600;color:#0d1f35">${escHtml(subObj.name)}</td>
                    <td style="padding:12px 20px;text-align:center;font-size:14px;font-weight:700;color:${col}">${avg}%</td>
                    <td style="padding:12px 20px;text-align:center;font-size:14px;font-weight:700;color:${col}">${letterGrade(avg)}</td>
                    <td style="padding:12px 20px;text-align:center;font-size:13px;color:#6b84a0">${count}</td>
                </tr>`;
            }).join('');
        } else {
            body.innerHTML = '<tr><td colspan="4" style="padding:24px;text-align:center;color:#9ab0c6;font-style:italic">No grade data for this student.</td></tr>';
        }
    }
}

// ── 10. EXPORT & PRINT ────────────────────────────────────────────────────
document.getElementById('printReportBtn').addEventListener('click', () => window.print());

document.getElementById('exportCsvBtn').addEventListener('click', () => {
    const rows = [];
    const headers = [];
    document.querySelectorAll('#reportTableHead th').forEach(th => headers.push(th.innerText.trim()));
    rows.push(headers);
    document.querySelectorAll('#reportTableBody tr').forEach(tr => {
        const row = [];
        tr.querySelectorAll('td').forEach(td => row.push(td.innerText.trim()));
        rows.push(row);
    });
    const csv = rows.map(r => r.map(v => `"${String(v ?? '').replace(/"/g, '""')}"`).join(',')).join('\n');
    const a   = Object.assign(document.createElement('a'), {
        href: URL.createObjectURL(new Blob([csv], { type: 'text/csv' })),
        download: `ConnectUs_Report_${new Date().toISOString().slice(0,10)}.csv`
    });
    document.body.appendChild(a); a.click(); a.remove();
});

// ── INITIALIZE ────────────────────────────────────────────────────────────
document.addEventListener('DOMContentLoaded', initializeBuilder);
