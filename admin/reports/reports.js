import { db } from '../../assets/js/firebase-init.js';
import { collection, getDocs, query, where } from "https://www.gstatic.com/firebasejs/10.7.1/firebase-firestore.js";
import { requireAuth } from '../../assets/js/auth.js';
import { injectAdminLayout } from '../../assets/js/layout-admin.js';
import { letterGrade, gradeColorClass } from '../../assets/js/utils.js';

// ── 1. INIT ───────────────────────────────────────────────────────────────
const session = requireAuth('admin', '../login.html');
injectAdminLayout('reports', 'Reports & Analytics', 'School-wide performance intelligence', false, false);

// ── 2. STATE ──────────────────────────────────────────────────────────────
let allSemesters   = [];
let allTeachers    = [];
let allStudents    = [];
let gradeTypeWeights = {};
let CLASSES        = [];

// ── 3. HELPERS ────────────────────────────────────────────────────────────
function escHtml(s) {
    return String(s || '').replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;');
}

// Weighted or simple average for a grade set
function calcAvg(grades) {
    if (!grades.length) return null;
    const hasWeights = Object.keys(gradeTypeWeights).length > 0;
    if (!hasWeights) {
        return grades.reduce((s, g) => s + (g.max ? g.score / g.max * 100 : 0), 0) / grades.length;
    }
    const byType = {};
    grades.forEach(g => {
        const t = g.type || 'Other';
        if (!byType[t]) byType[t] = [];
        byType[t].push(g.max ? (g.score / g.max) * 100 : 0);
    });
    let wSum = 0, wTotal = 0;
    Object.entries(byType).forEach(([type, scores]) => {
        const typeAvg = scores.reduce((a, b) => a + b, 0) / scores.length;
        const w = gradeTypeWeights[type] || 0;
        if (w > 0) { wSum += typeAvg * w; wTotal += w; }
    });
    return wTotal > 0 ? wSum / wTotal
        : grades.reduce((s, g) => s + (g.max ? g.score / g.max * 100 : 0), 0) / grades.length;
}

function gradeColor(pct) {
    return pct >= 75 ? 'color:#0ea871' : pct >= 60 ? 'color:#b45309' : 'color:#e31b4a';
}

function gradeBar(pct, color) {
    return `<div style="height:4px;background:#f0f4f8;border-radius:99px;overflow:hidden;margin-top:4px">
        <div style="height:100%;width:${Math.min(pct,100)}%;background:${color};border-radius:99px"></div>
    </div>`;
}

// ── 4. LOAD GRADE TYPES ───────────────────────────────────────────────────
async function loadGradeTypes() {
    try {
        const cached = localStorage.getItem(`connectus_gradeTypes_${session.schoolId}`);
        const types  = cached
            ? JSON.parse(cached)
            : (await getDocs(collection(db, 'schools', session.schoolId, 'gradeTypes'))).docs.map(d => ({ id: d.id, ...d.data() }));
        types.forEach(t => { if (t.weight) gradeTypeWeights[t.name] = t.weight; });
    } catch (_) {}
}

// ── 5. LIVE KPI DASHBOARD (loads on page open) ────────────────────────────
async function loadLiveDashboard() {
    try {
        await loadGradeTypes();

        // Find active period label
        const activeSem = allSemesters.find(s => s.id === session.activeSemesterId);
        const kpiLabel  = document.getElementById('kpiPeriodLabel');
        if (kpiLabel) kpiLabel.textContent = activeSem ? activeSem.name : 'All Periods';

        // Fetch all active students' grades for the active period
        const avgList = [];
        let   totalAssessments = 0;

        await Promise.all(allStudents.map(async s => {
            // CHANGED: Fetch from global student grades, filtered by this school
            const snap = await getDocs(query(
                collection(db, 'students', s.id, 'grades'),
                where('schoolId', '==', session.schoolId)
            ));
            const grades = snap.docs.map(d => d.data()).filter(g =>
                !session.activeSemesterId || session.activeSemesterId === 'all' || g.semesterId === session.activeSemesterId
            );
            totalAssessments += grades.length;
            const avg = calcAvg(grades);
            if (avg !== null) avgList.push(avg);
        }));

        const meanAvg  = avgList.length ? Math.round(avgList.reduce((a, b) => a + b, 0) / avgList.length) : null;
        const passRate = avgList.length ? Math.round(avgList.filter(a => a >= 60).length / avgList.length * 100) : null;
        const atRisk   = avgList.filter(a => a < 60).length;

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
                sub:  avgList.length ? `${avgList.filter(a => a >= 60).length} of ${avgList.length} students` : 'No data',
                subColor: '#6b84a0'
            },
            {
                icon: 'fa-triangle-exclamation', iconColor: '#e31b4a', bg: '#fff0f3',
                val:  atRisk,
                lbl:  'At-Risk Students',
                sub:  atRisk > 0 ? 'Averaging below 60%' : 'No at-risk students',
                subColor: atRisk > 0 ? '#e31b4a' : '#0ea871'
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

        // Semesters dropdown
        const reportPeriod = document.getElementById('reportPeriod');
        allSemesters.forEach(s => {
            const o = document.createElement('option');
            o.value = s.id;
            o.textContent = s.name;
            if (s.id === session.activeSemesterId) o.selected = true;
            reportPeriod.appendChild(o);
        });

        // Class list
        const schoolType = session.schoolType || 'Primary';
        CLASSES = schoolType === 'Primary'
            ? ['Infant 1','Infant 2','Standard 1','Standard 2','Standard 3','Standard 4','Standard 5','Standard 6']
            : schoolType === 'High School'
            ? ['First Form','Second Form','Third Form','Fourth Form']
            : ['Year 1','Year 2'];

        await loadLiveDashboard();

    } catch (e) {
        console.error('[Reports] initializeBuilder:', e);
    }
}

// ── 7. SCOPE DROPDOWNS ────────────────────────────────────────────────────
document.getElementById('reportScope').addEventListener('change', e => {
    const scope  = e.target.value;
    const tc     = document.getElementById('targetContainer');
    const target = document.getElementById('reportTarget');
    target.innerHTML = '<option value="">Select target...</option>';

    if (scope === 'school') { tc.classList.add('hidden'); return; }
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
});

// ── 8. GENERATE REPORT ────────────────────────────────────────────────────
document.getElementById('generateBtn').addEventListener('click', async () => {
    const period  = document.getElementById('reportPeriod').value;
    const scope   = document.getElementById('reportScope').value;
    const target  = document.getElementById('reportTarget').value;
    const subject = document.getElementById('reportSubject').value;

    if (scope !== 'school' && !target) { alert('Please select a target.'); return; }

    const results = document.getElementById('reportResults');
    const loader  = document.getElementById('reportLoader');
    results.classList.add('hidden', 'opacity-0');
    loader.classList.remove('hidden');
    loader.classList.add('flex');

    try {
        // ── Determine scope students ───────────────────────────────────────
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

        // ── Fetch grades ───────────────────────────────────────────────────
        const allGrades     = [];
        const studentAvgMap = {};

        await Promise.all(targetStudents.map(async s => {
            // CHANGED: Fetch from global student grades, filtered by this school
            const snap = await getDocs(query(
                collection(db, 'students', s.id, 'grades'),
                where('schoolId', '==', session.schoolId)
            ));
            const grades = snap.docs.map(d => d.data()).filter(g => {
                if (period !== 'all' && g.semesterId !== period) return false;
                if (subject !== 'all' && g.subject !== subject) return false;
                return true;
            });
            grades.forEach(g => { g.studentId = s.id; g.studentName = s.name; g.className = s.className; });
            allGrades.push(...grades);

            const avg = calcAvg(grades);
            if (avg !== null) studentAvgMap[s.id] = { avg: Math.round(avg), name: s.name, className: s.className, teacherId: s.teacherId };
        }));

        const studentAvgs = Object.values(studentAvgMap);

        // ── KPI row ────────────────────────────────────────────────────────
        const meanAvg  = studentAvgs.length ? Math.round(studentAvgs.reduce((s, x) => s + x.avg, 0) / studentAvgs.length) : null;
        const passRate = studentAvgs.length ? Math.round(studentAvgs.filter(x => x.avg >= 60).length / studentAvgs.length * 100) : null;
        const atRisk   = studentAvgs.filter(x => x.avg < 60);

        document.getElementById('rMeanAvg').textContent = meanAvg !== null ? meanAvg + '%' : 'N/A';
        document.getElementById('rMeanAvg').style.color = meanAvg !== null ? (meanAvg >= 75 ? '#0ea871' : meanAvg >= 60 ? '#b45309' : '#e31b4a') : '#9ab0c6';
        document.getElementById('rPassRate').textContent = passRate !== null ? passRate + '%' : 'N/A';
        document.getElementById('rPassRate').style.color = passRate !== null ? (passRate >= 75 ? '#0ea871' : passRate >= 50 ? '#b45309' : '#e31b4a') : '#9ab0c6';
        document.getElementById('rAtRisk').textContent = atRisk.length;
        document.getElementById('rAtRisk').style.color = atRisk.length > 0 ? '#e31b4a' : '#0ea871';
        document.getElementById('rVolume').textContent = allGrades.length.toLocaleString();

        // ── Distribution bar ───────────────────────────────────────────────
        const dist = { a:0, b:0, c:0, d:0, f:0 };
        studentAvgs.forEach(x => {
            if (x.avg >= 90) dist.a++;
            else if (x.avg >= 80) dist.b++;
            else if (x.avg >= 70) dist.c++;
            else if (x.avg >= 60) dist.d++;
            else dist.f++;
        });
        const total = studentAvgs.length || 1;
        const seg = (pct, color, label, count) => count
            ? `<div class="dist-seg" style="width:${pct}%;background:${color}" title="${label}: ${count}">${count}</div>` : '';
        document.getElementById('distBar').innerHTML =
            studentAvgs.length ? [
                seg(dist.a/total*100, '#0ea871', 'A (90–100%)', dist.a),
                seg(dist.b/total*100, '#2563eb', 'B (80–89%)', dist.b),
                seg(dist.c/total*100, '#0891b2', 'C (70–79%)', dist.c),
                seg(dist.d/total*100, '#f59e0b', 'D (60–69%)', dist.d),
                seg(dist.f/total*100, '#e31b4a', 'F (<60%)', dist.f)
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

        // ── Pass / Fail breakdown ──────────────────────────────────────────
        const passCount = studentAvgs.filter(x => x.avg >= 60).length;
        const failCount = studentAvgs.filter(x => x.avg < 60).length;
        const passPct   = total > 1 ? Math.round(passCount / total * 100) : 0;
        document.getElementById('passFailBody').innerHTML = `
            <div style="display:grid;grid-template-columns:1fr 1fr;gap:16px">
                <div style="background:#edfaf4;border:1px solid #c6f0db;border-radius:var(--r-md);padding:20px;text-align:center">
                    <div style="font-size:36px;font-weight:700;color:#0ea871">${passCount}</div>
                    <div style="font-size:11px;font-weight:700;color:#0b8f5e;text-transform:uppercase;letter-spacing:0.08em;margin-top:4px">Passing (≥60%)</div>
                    <div style="font-size:13px;font-weight:600;color:#6b84a0;margin-top:6px">${passPct}% of students</div>
                </div>
                <div style="background:#fff0f3;border:1px solid #ffd6de;border-radius:var(--r-md);padding:20px;text-align:center">
                    <div style="font-size:36px;font-weight:700;color:#e31b4a">${failCount}</div>
                    <div style="font-size:11px;font-weight:700;color:#be1240;text-transform:uppercase;letter-spacing:0.08em;margin-top:4px">Failing (&lt;60%)</div>
                    <div style="font-size:13px;font-weight:600;color:#6b84a0;margin-top:6px">${100 - passPct}% of students</div>
                </div>
            </div>`;

        // ── Subject performance ────────────────────────────────────────────
        const bySubj = {};
        allGrades.forEach(g => {
            const sub = g.subject || 'Uncategorized';
            if (!bySubj[sub]) bySubj[sub] = [];
            bySubj[sub].push(g);
        });

        const subjRows = Object.entries(bySubj)
            .map(([sub, grades]) => {
                const avg    = Math.round(calcAvg(grades) || 0);
                const pass   = grades.filter(g => g.max && (g.score / g.max * 100) >= 60).length;
                const pct    = grades.length ? Math.round(pass / grades.length * 100) : 0;
                const col    = avg >= 75 ? '#0ea871' : avg >= 60 ? '#b45309' : '#e31b4a';
                return `<tr style="border-bottom:1px solid #f0f4f8">
                    <td style="padding:12px 20px;font-size:13px;font-weight:600;color:#0d1f35">${escHtml(sub)}</td>
                    <td style="padding:12px 20px;text-align:center;font-size:13px;color:#6b84a0">${grades.length}</td>
                    <td style="padding:12px 20px;text-align:center;font-size:14px;font-weight:700;color:${col}">${avg}%</td>
                    <td style="padding:12px 20px;text-align:center;font-size:13px;color:#6b84a0">${pct}% passing</td>
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
        renderTable(scope, studentAvgMap, allGrades, targetStudents);

        // ── At-Risk roster ─────────────────────────────────────────────────
        document.getElementById('atRiskCount').textContent = `${atRisk.length} student${atRisk.length !== 1 ? 's' : ''}`;
        document.getElementById('atRiskBody').innerHTML = atRisk.length
            ? atRisk.sort((a, b) => a.avg - b.avg).map(s => `
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
                        <span style="font-size:18px;font-weight:700;color:#e31b4a">${s.avg}%</span>
                        <p style="font-size:10.5px;font-weight:600;color:#e31b4a;margin:2px 0 0">${letterGrade(s.avg)} · At Risk</p>
                    </div>
                </div>`).join('')
            : '<div style="padding:24px;text-align:center;color:#0ea871;font-weight:600;font-size:13px"><i class="fa-solid fa-circle-check" style="margin-right:6px"></i>No at-risk students for this filter.</div>';

        // ── Teacher performance (school-wide only) ─────────────────────────
        const tpSection = document.getElementById('teacherPerfSection');
        if (scope === 'school') {
            tpSection.classList.remove('hidden');
            const byTeacher = {};
            allTeachers.forEach(t => { byTeacher[t.id] = { name: t.name, students: [], avgs: [] }; });
            studentAvgs.forEach(s => {
                if (s.teacherId && byTeacher[s.teacherId]) {
                    byTeacher[s.teacherId].avgs.push(s.avg);
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
        } else {
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
function renderTable(scope, studentAvgMap, allGrades, targetStudents) {
    const head = document.getElementById('reportTableHead');
    const body = document.getElementById('reportTableBody');
    const studentAvgs = Object.values(studentAvgMap);

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
        studentAvgs.forEach(s => {
            const c = s.className || 'Unassigned';
            if (!byClass[c]) byClass[c] = [];
            byClass[c].push(s.avg);
        });

        body.innerHTML = Object.entries(byClass)
            .sort((a, b) => (b[1].reduce((x,y)=>x+y,0)/b[1].length) - (a[1].reduce((x,y)=>x+y,0)/a[1].length))
            .map(([cls, avgs]) => {
                const mean    = Math.round(avgs.reduce((s, a) => s + a, 0) / avgs.length);
                const pass    = avgs.filter(a => a >= 60).length;
                const passPct = Math.round(pass / avgs.length * 100);
                const risk    = avgs.filter(a => a < 60).length;
                const col     = mean >= 75 ? '#0ea871' : mean >= 60 ? '#b45309' : '#e31b4a';
                return `<tr class="gb-row">
                    <td style="padding:12px 20px;font-size:13px;font-weight:600;color:#0d1f35">${escHtml(cls)}</td>
                    <td style="padding:12px 20px;text-align:center;font-size:13px;color:#6b84a0">${avgs.length}</td>
                    <td style="padding:12px 20px;text-align:center;font-size:14px;font-weight:700;color:${col}">${mean}%</td>
                    <td style="padding:12px 20px;text-align:center;font-size:13px;font-weight:600;color:${passPct>=60?'#0ea871':'#e31b4a'}">${passPct}%</td>
                    <td style="padding:12px 20px;text-align:center;font-size:13px;font-weight:700;color:${risk>0?'#e31b4a':'#9ab0c6'}">${risk}</td>
                </tr>`;
            }).join('');

    } else if (scope === 'teacher' || scope === 'class') {
        document.getElementById('tableTitle').textContent = 'Student Rankings';
        head.innerHTML = `<tr>
            <th style="padding:10px 20px;text-align:left;font-size:10px;font-weight:700;text-transform:uppercase;letter-spacing:0.1em">Student</th>
            <th style="padding:10px 20px;text-align:center;font-size:10px;font-weight:700;text-transform:uppercase;letter-spacing:0.1em">Mean Avg</th>
            <th style="padding:10px 20px;text-align:center;font-size:10px;font-weight:700;text-transform:uppercase;letter-spacing:0.1em">Grade</th>
            <th style="padding:10px 20px;text-align:center;font-size:10px;font-weight:700;text-transform:uppercase;letter-spacing:0.1em">Assessments</th>
            <th style="padding:10px 20px;text-align:center;font-size:10px;font-weight:700;text-transform:uppercase;letter-spacing:0.1em">Status</th>
        </tr>`;

        body.innerHTML = studentAvgs.sort((a, b) => b.avg - a.avg).map((s, i) => {
            const count = allGrades.filter(g => g.studentId === Object.keys(studentAvgMap).find(k => studentAvgMap[k] === s)).length;
            const col   = s.avg >= 75 ? '#0ea871' : s.avg >= 60 ? '#b45309' : '#e31b4a';
            const status = s.avg >= 75 ? 'Good Standing' : s.avg >= 60 ? 'Needs Attention' : 'At Risk';
            const sBg    = s.avg >= 75 ? 'background:#edfaf4;color:#0b8f5e;border:1px solid #c6f0db'
                         : s.avg >= 60 ? 'background:#fffbeb;color:#b45309;border:1px solid #fef3c7'
                         : 'background:#fff0f3;color:#be1240;border:1px solid #ffd6de';
            return `<tr class="gb-row">
                <td style="padding:12px 20px;font-size:13px;font-weight:600;color:#0d1f35">
                    <span style="font-size:10px;color:#9ab0c6;font-weight:700;margin-right:6px">#${i+1}</span>${escHtml(s.name)}
                </td>
                <td style="padding:12px 20px;text-align:center;font-size:14px;font-weight:700;color:${col}">${s.avg}%</td>
                <td style="padding:12px 20px;text-align:center;font-size:14px;font-weight:700;color:${col}">${letterGrade(s.avg)}</td>
                <td style="padding:12px 20px;text-align:center;font-size:13px;color:#6b84a0">${allGrades.filter(g => g.studentId === Object.entries(studentAvgMap).find(([,v]) => v === s)?.[0]).length}</td>
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

        const bySubj = {};
        allGrades.forEach(g => {
            const sub = g.subject || 'Uncategorized';
            if (!bySubj[sub]) bySubj[sub] = [];
            bySubj[sub].push(g);
        });

        body.innerHTML = Object.entries(bySubj).map(([sub, grades]) => {
            const avg = Math.round(calcAvg(grades) || 0);
            const col = avg >= 75 ? '#0ea871' : avg >= 60 ? '#b45309' : '#e31b4a';
            return `<tr class="gb-row">
                <td style="padding:12px 20px;font-size:13px;font-weight:600;color:#0d1f35">${escHtml(sub)}</td>
                <td style="padding:12px 20px;text-align:center;font-size:14px;font-weight:700;color:${col}">${avg}%</td>
                <td style="padding:12px 20px;text-align:center;font-size:14px;font-weight:700;color:${col}">${letterGrade(avg)}</td>
                <td style="padding:12px 20px;text-align:center;font-size:13px;color:#6b84a0">${grades.length}</td>
            </tr>`;
        }).join('');
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
