import { db } from '../../assets/js/firebase-init.js';
import { collection, getDocs, doc, getDoc, query, where } from "https://www.gstatic.com/firebasejs/10.7.1/firebase-firestore.js";
import { requireAuth } from '../../assets/js/auth.js';
import { injectStudentLayout } from '../../assets/js/layout-student.js';
import { calculateWeightedAverage } from '../../assets/js/utils.js';

// ── 1. AUTH & LAYOUT ──────────────────────────────────────────────────────
const session = requireAuth('student', '../login.html');
injectStudentLayout('overview', 'Dashboard', 'Recent activity and overview');

// ── 2. ELEMENTS ───────────────────────────────────────────────────────────
const dashAvgEl      = document.getElementById('dashAvg');
const dashTotalEl    = document.getElementById('dashTotalGrades');
const dashRecentEl   = document.getElementById('dashRecentCount');
const activityListEl = document.getElementById('recentActivityList');

let teachersMap        = {};
let teacherRubricsCache = {};

// ── 3. HELPERS ────────────────────────────────────────────────────────────
function gradeColor(p) {
    if (p >= 90) return { text: 'text-emerald-600', bar: '#10b981', bg: 'bg-emerald-500' };
    if (p >= 80) return { text: 'text-blue-600',    bar: '#3b82f6', bg: 'bg-blue-500'    };
    if (p >= 70) return { text: 'text-teal-600',    bar: '#14b8a6', bg: 'bg-teal-500'    };
    if (p >= 65) return { text: 'text-amber-600',   bar: '#f59e0b', bg: 'bg-amber-500'   };
    return             { text: 'text-red-600',      bar: '#ef4444', bg: 'bg-red-500'     };
}

function standingLabel(avg) {
    if (avg >= 90) return { label: 'Excelling',        icon: 'fa-circle-check',        bg: 'bg-emerald-50', border: 'border-emerald-200', text: 'text-emerald-700', sub: 'text-emerald-500' };
    if (avg >= 80) return { label: 'Good Standing',    icon: 'fa-thumbs-up',           bg: 'bg-blue-50',    border: 'border-blue-200',    text: 'text-blue-700',    sub: 'text-blue-500'    };
    if (avg >= 70) return { label: 'On Track',         icon: 'fa-arrow-right',         bg: 'bg-teal-50',    border: 'border-teal-200',    text: 'text-teal-700',    sub: 'text-teal-500'    };
    if (avg >= 65) return { label: 'Needs Attention',  icon: 'fa-eye',                 bg: 'bg-amber-50',   border: 'border-amber-200',   text: 'text-amber-700',   sub: 'text-amber-500'   };
    return               { label: 'At Risk',           icon: 'fa-triangle-exclamation', bg: 'bg-red-50',     border: 'border-red-200',     text: 'text-red-700',     sub: 'text-red-500'     };
}

function timeAgo(ds) {
    const d = new Date(ds);
    if (isNaN(d)) return ds;
    const sec = Math.floor((new Date() - d) / 1000);
    let i = sec / 86400;
    if (i > 7)  return d.toLocaleDateString();
    if (i >= 1) return Math.floor(i) + ' days ago';
    i = sec / 3600;
    if (i >= 1) return Math.floor(i) + ' hrs ago';
    i = sec / 60;
    if (i >= 1) return Math.floor(i) + ' mins ago';
    return 'Just now';
}

function escHtml(s) {
    return String(s || '').replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;');
}

// ── 4. LOAD DASHBOARD DATA ────────────────────────────────────────────────
async function loadDashboardData() {
    try {
        const { schoolId, studentId } = session;

        const schoolSnap       = await getDoc(doc(db, 'schools', schoolId));
        const activeSemesterId = schoolSnap.data()?.activeSemesterId;
        const schoolName       = schoolSnap.data()?.schoolName || 'ConnectUs School';

        document.getElementById('displaySchoolName').textContent   = schoolName;
        document.getElementById('displayStudentName').textContent  = session.studentData.name;
        document.getElementById('displayStudentClass').textContent = session.studentData.className || 'Unassigned';

        if (!activeSemesterId) {
            activityListEl.innerHTML = `<p class="text-amber-600 font-bold text-center">No active semester set by the school.</p>`;
            document.getElementById('analyticsLoader').innerHTML =
                '<p class="text-xs font-bold text-amber-500 text-center">No active grading period set.</p>';
            return;
        }

        const semSnap = await getDoc(doc(db, 'schools', schoolId, 'semesters', activeSemesterId));
        document.getElementById('activeSemesterDisplay').textContent = semSnap.data()?.name || 'Unknown Period';

        // Load teacher names
        const tSnap = await getDocs(query(collection(db, 'teachers'), where('currentSchoolId', '==', schoolId)));
        tSnap.forEach(d => { teachersMap[d.id] = d.data().name; });

        // Load grades from global student path
        const gSnap = await getDocs(query(
            collection(db, 'students', studentId, 'grades'),
            where('schoolId', '==', schoolId),
            where('semesterId', '==', activeSemesterId)
        ));
        const currentGrades = gSnap.docs.map(d => ({ id: d.id, ...d.data() }));

        // Load teacher rubrics for weighted average calculation
        const uniqueTeacherIds = [...new Set(currentGrades.map(g => g.teacherId).filter(Boolean))];
        for (const tId of uniqueTeacherIds) {
            if (!teacherRubricsCache[tId]) {
                const tDoc = await getDoc(doc(db, 'teachers', tId));
                teacherRubricsCache[tId] = tDoc.exists()
                    ? (tDoc.data().gradeTypes || tDoc.data().customGradeTypes || []) : [];
            }
        }

        // Weighted average per subject → overall average
        const bySub = {};
        currentGrades.forEach(g => {
            const sub = g.subject || 'Uncategorized';
            if (!bySub[sub]) bySub[sub] = [];
            bySub[sub].push(g);
        });

        let sumSubjAvgs = 0, subjCount = 0;
        const subjectAverages = {}; // used by analytics

        for (const sub in bySub) {
            const tId    = bySub[sub][0]?.teacherId;
            const rubric = tId ? (teacherRubricsCache[tId] || []) : [];
            const avg    = calculateWeightedAverage(bySub[sub], rubric);
            if (avg !== null) {
                sumSubjAvgs += avg;
                subjCount++;
                subjectAverages[sub] = Math.round(avg);
            }
        }

        const overallAvg = subjCount > 0 ? Math.round(sumSubjAvgs / subjCount) : null;
        dashAvgEl.textContent   = overallAvg !== null ? overallAvg : '--';
        dashTotalEl.textContent = currentGrades.length;

        // Recent activity (last 7 days)
        const sevenAgo = new Date();
        sevenAgo.setDate(sevenAgo.getDate() - 7);
        const recent = currentGrades.filter(g => {
            const d = g.createdAt ? new Date(g.createdAt) : new Date(g.date);
            return d >= sevenAgo;
        }).sort((a, b) => {
            const da = a.createdAt ? new Date(a.createdAt) : new Date(a.date);
            const db = b.createdAt ? new Date(b.createdAt) : new Date(b.date);
            return db - da;
        });

        dashRecentEl.textContent = recent.length;
        renderActivityFeed(recent);
        renderAnalytics(currentGrades, subjectAverages, overallAvg);

    } catch (error) {
        console.error('[StudentHome] Dashboard error:', error);
        activityListEl.innerHTML = `<p class="text-red-500 font-bold text-center">Failed to load dashboard data.</p>`;
        document.getElementById('analyticsLoader').innerHTML =
            '<p class="text-xs font-bold text-red-500 text-center">Analytics failed to load.</p>';
    }
}

// ── 5. ACTIVITY FEED (subject name on top, title below) ───────────────────
function renderActivityFeed(recent) {
    if (!recent.length) {
        activityListEl.innerHTML = `
            <div class="text-center py-6 text-slate-400 font-semibold">
                <i class="fa-solid fa-mug-hot text-2xl mb-2 block text-slate-300"></i>
                No new grades posted in the last 7 days.
            </div>`;
        return;
    }

    activityListEl.innerHTML = recent.slice(0, 5).map(g => {
        const tName    = teachersMap[g.teacherId] || (g.enteredByAdmin ? (g.adminName || 'Admin') : 'Teacher');
        const pct      = g.max ? Math.round((g.score / g.max) * 100) : 0;
        const timeStr  = g.createdAt ? timeAgo(g.createdAt) : g.date;
        const col      = gradeColor(pct);
        const adminTag = g.enteredByAdmin
            ? `<span class="text-[9px] font-black text-blue-500 bg-blue-50 border border-blue-200 px-1.5 py-0.5 rounded ml-1">Admin entry</span>`
            : '';
        const rubric  = g.teacherId ? (teacherRubricsCache[g.teacherId] || []) : [];
        const typeDef = rubric.find(t => t.name && g.type && t.name.toLowerCase() === g.type.toLowerCase());
        const weightTag = typeDef ? ` (${typeDef.weight}%)` : '';

        return `
        <div class="flex items-center justify-between p-4 bg-slate-50 border border-slate-100 rounded-2xl shadow-sm hover:shadow-md hover:bg-white transition cursor-pointer"
             onclick="window.location.href='../grades/grades.html'">
            <div class="flex items-center gap-4">
                <div class="h-11 w-11 bg-indigo-600 text-white rounded-xl flex items-center justify-center text-lg font-black shadow-sm flex-shrink-0">
                    ${g.subject ? escHtml(g.subject.charAt(0).toUpperCase()) : '?'}
                </div>
                <div>
                    <p class="text-[10px] font-black text-indigo-600 uppercase tracking-wider mb-0.5">${escHtml(g.subject || 'Uncategorized')}</p>
                    <p class="font-black text-slate-800 text-sm">${escHtml(g.title || '—')}${adminTag}</p>
                    <p class="text-xs text-slate-400 font-semibold mt-0.5">${escHtml(tName)} · ${escHtml(g.type || '')}${weightTag} · ${timeStr}</p>
                </div>
            </div>
            <div class="text-right flex-shrink-0 ml-4">
                <span class="font-black text-lg ${col.text}">${g.score}/${g.max}</span>
                <p class="text-xs font-bold text-slate-400">${pct}%</p>
            </div>
        </div>`;
    }).join('');
}

// ── 6. ACADEMIC ANALYTICS ─────────────────────────────────────────────────
function renderAnalytics(grades, subjectAverages, overallAvg) {
    const loader    = document.getElementById('analyticsLoader');
    const analytics = document.getElementById('academicAnalytics');

    if (!grades.length || overallAvg === null) {
        loader.innerHTML = `
            <i class="fa-solid fa-chart-pie text-2xl text-slate-300 mb-3 block"></i>
            <p class="text-sm font-bold text-slate-400">No grade data yet for this period.</p>`;
        return;
    }

    // ── Standing banner ───────────────────────────────────────────────────
    const st = standingLabel(overallAvg);
    document.getElementById('standingBanner').className =
        `rounded-3xl p-5 border flex items-center gap-4 ${st.bg} ${st.border}`;
    document.getElementById('standingBanner').innerHTML = `
        <div class="w-12 h-12 rounded-2xl ${st.bg} border ${st.border} flex items-center justify-center flex-shrink-0">
            <i class="fa-solid ${st.icon} ${st.text} text-xl"></i>
        </div>
        <div>
            <p class="font-black ${st.text} text-lg">${st.label}</p>
            <p class="${st.sub} text-sm font-semibold">Your overall term average is <strong>${overallAvg}%</strong> across ${Object.keys(subjectAverages).length} subject${Object.keys(subjectAverages).length !== 1 ? 's' : ''}.</p>
        </div>`;

    // ── Subject performance bars ──────────────────────────────────────────
    const subjectsSorted = Object.entries(subjectAverages).sort((a, b) => b[1] - a[1]);
    document.getElementById('subjectBars').innerHTML = subjectsSorted.length
        ? subjectsSorted.map(([sub, avg]) => {
            const col = gradeColor(avg);
            return `
            <div>
                <div class="flex justify-between items-center mb-1">
                    <span class="text-xs font-black text-slate-700">${escHtml(sub)}</span>
                    <span class="text-xs font-black ${col.text}">${avg}%</span>
                </div>
                <div class="h-2 w-full bg-slate-100 rounded-full overflow-hidden">
                    <div class="h-full ${col.bg} rounded-full transition-all duration-500" style="width:${Math.min(avg,100)}%"></div>
                </div>
            </div>`;
        }).join('')
        : '<p class="text-xs font-bold text-slate-400">No subject data.</p>';

    // ── Grade type breakdown ──────────────────────────────────────────────
    const byType = {};
    grades.forEach(g => {
        if (!g.type || !g.max) return;
        const type = g.type;
        if (!byType[type]) byType[type] = { sum: 0, count: 0 };
        byType[type].sum += (g.score / g.max) * 100;
        byType[type].count++;
    });
    const typesSorted = Object.entries(byType)
        .map(([type, d]) => ({ type, avg: Math.round(d.sum / d.count), count: d.count }))
        .sort((a, b) => b.avg - a.avg);

    document.getElementById('typeBars').innerHTML = typesSorted.length
        ? typesSorted.map(t => {
            const col = gradeColor(t.avg);
            return `
            <div>
                <div class="flex justify-between items-center mb-1">
                    <span class="text-xs font-black text-slate-700">${escHtml(t.type)}</span>
                    <div class="text-right">
                        <span class="text-xs font-black ${col.text}">${t.avg}%</span>
                        <span class="text-[10px] text-slate-400 font-semibold ml-1">(${t.count})</span>
                    </div>
                </div>
                <div class="h-2 w-full bg-slate-100 rounded-full overflow-hidden">
                    <div class="h-full ${col.bg} rounded-full transition-all duration-500" style="width:${Math.min(t.avg,100)}%"></div>
                </div>
            </div>`;
        }).join('')
        : '<p class="text-xs font-bold text-slate-400">No assignment type data.</p>';

    // ── Strengths & needs improvement ────────────────────────────────────
    const strengths    = subjectsSorted.filter(([, avg]) => avg >= 75).slice(0, 3);
    const improvements = [...subjectsSorted].reverse().filter(([, avg]) => avg < 75).slice(0, 3);

    document.getElementById('strengthsList').innerHTML = strengths.length
        ? strengths.map(([sub, avg]) => `
            <div class="flex items-center justify-between bg-white rounded-xl px-4 py-2.5 border border-emerald-100">
                <span class="text-sm font-black text-slate-700">${escHtml(sub)}</span>
                <span class="text-sm font-black text-emerald-600">${avg}%</span>
            </div>`).join('')
        : '<p class="text-xs font-semibold text-emerald-700 opacity-60">Keep working — strengths will appear here.</p>';

    document.getElementById('improvementList').innerHTML = improvements.length
        ? improvements.map(([sub, avg]) => `
            <div class="flex items-center justify-between bg-white rounded-xl px-4 py-2.5 border border-red-100">
                <span class="text-sm font-black text-slate-700">${escHtml(sub)}</span>
                <span class="text-sm font-black text-red-500">${avg}%</span>
            </div>`).join('')
        : '<p class="text-xs font-semibold text-red-700 opacity-60">All subjects are above 75% — great work!</p>';

    // Reveal analytics
    loader.classList.add('hidden');
    analytics.classList.remove('hidden');
}

// ── INITIALIZE ────────────────────────────────────────────────────────────
document.addEventListener('DOMContentLoaded', loadDashboardData);
