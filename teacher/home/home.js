import { db } from '../../assets/js/firebase-init.js';
import { collection, query, where, getDocs, getDoc, doc } from "https://www.gstatic.com/firebasejs/10.7.1/firebase-firestore.js";
import { requireAuth } from '../../assets/js/auth.js';
import { injectTeacherLayout } from '../../assets/js/layout-teachers.js';
import { gradeColorClass } from '../../assets/js/utils.js';

// ── 1. AUTHENTICATION & LAYOUT ──────────────────────────────────────────────
const session = requireAuth('teacher', '../login.html');
if (session) {
    // Inject Sidebar & Topbar (Page ID: 'overview', Title: 'Overview', Subtitle, Search: false)
    injectTeacherLayout('overview', 'Overview', 'Classroom dashboard', false);
}

// ── 2. STATE VARIABLES ──────────────────────────────────────────────────────
let allStudents = [];
let studentMap = {};
let allGrades = [];

// ── 3. INITIALIZATION ───────────────────────────────────────────────────────
async function init() {
    if (!session) return;

    // Populate Sidebar Details specific to this Teacher
    document.getElementById('displayTeacherName').textContent = session.teacherData.name;
    document.getElementById('teacherAvatar').textContent = session.teacherData.name.charAt(0).toUpperCase();
    document.getElementById('sidebarSchoolId').textContent = session.schoolId;

    const classes = session.teacherData.classes || [session.teacherData.className || ''];
    document.getElementById('displayTeacherClasses').innerHTML = classes.map(c => `<span class="class-pill">${c}</span>`).join('');

    await loadSemesters();
    await fetchMetrics();
}

// ── 4. LOAD SEMESTERS (WITH CACHING FOR SPEED) ──────────────────────────────
async function loadSemesters() {
    try {
        let rawSemesters = [];
        const cachedSemesters = sessionStorage.getItem('connectUs_semesters');

        // Check if we already have it saved in the browser memory
        if (cachedSemesters) {
            rawSemesters = JSON.parse(cachedSemesters);
        } else {
            // Otherwise, fetch from Firebase and save for next time
            const semSnap = await getDocs(collection(db, 'schools', session.schoolId, 'semesters'));
            rawSemesters = semSnap.docs.map(d => ({ id: d.id, ...d.data() })).sort((a, b) => (a.order || 0) - (b.order || 0));
            sessionStorage.setItem('connectUs_semesters', JSON.stringify(rawSemesters));
        }

        const schoolSnap = await getDoc(doc(db, 'schools', session.schoolId));
        const activeId = schoolSnap.data()?.activeSemesterId || '';

        const semSel = document.getElementById('activeSemester');
        if (semSel) {
            semSel.innerHTML = '';
            rawSemesters.forEach(s => {
                semSel.innerHTML += `<option value="${s.id}"${s.id === activeId ? ' selected' : ''}>${s.name}</option>`;
            });

            // Re-fetch metrics if the teacher switches the period from the Topbar
            semSel.addEventListener('change', () => {
                fetchMetrics();
            });
        }
    } catch (e) {
        console.error("Error loading semesters:", e);
    }
}

// ── 5. FETCH & RENDER DASHBOARD DATA ────────────────────────────────────────
async function fetchMetrics() {
    try {
        const semSel = document.getElementById('activeSemester');
        const semId = semSel ? semSel.value : null;
        const semName = semSel ? semSel.options[semSel.selectedIndex]?.text : '—';

        // Update sidebar period readout
        const sbPeriod = document.getElementById('sb-period');
        if (sbPeriod) sbPeriod.textContent = semName;

        // 5a. Get Active Students assigned to this Teacher
        const stuQuery = query(
            collection(db, 'schools', session.schoolId, 'students'),
            where('archived', '==', false),
            where('teacherId', '==', session.teacherId)
        );
        const stuSnap = await getDocs(stuQuery);
        allStudents = stuSnap.docs.map(d => ({ id: d.id, ...d.data() }));

        studentMap = {};
        allStudents.forEach(s => { studentMap[s.id] = s.name; });

        // Render Student Counts
        document.getElementById('stat-students').textContent = allStudents.length;
        const sbStudents = document.getElementById('sb-students');
        if (sbStudents) sbStudents.textContent = allStudents.length;

        // Bail out early if no students or no active semester
        if (!semId || !allStudents.length) {
            document.getElementById('stat-grades').textContent = '0';
            document.getElementById('stat-risk').textContent = '0';
            const sbRisk = document.getElementById('sb-risk');
            if (sbRisk) sbRisk.textContent = '0';
            
            document.getElementById('recentActivityList').innerHTML = '<div class="flex items-center justify-center h-full text-slate-400 italic text-sm">No recent grades logged.</div>';
            document.getElementById('needsAttentionList').innerHTML = '<div class="flex items-center justify-center h-full text-slate-400 italic text-sm">No at-risk students found.</div>';
            return;
        }

        // 5b. Fetch Grades for the Active Semester
        allGrades = [];
        await Promise.all(allStudents.map(async s => {
            try {
                const gQuery = query(collection(db, 'schools', session.schoolId, 'students', s.id, 'grades'), where('semesterId', '==', semId));
                const gSnap = await getDocs(gQuery);
                gSnap.forEach(d => allGrades.push({ id: d.id, studentId: s.id, studentName: s.name, ...d.data() }));
            } catch (e) {
                console.error(`Failed to fetch grades for ${s.id}:`, e);
            }
        }));

        document.getElementById('stat-grades').textContent = allGrades.length;

        // 5c. Calculate Needs Attention / At Risk Data (< 65%)
        const stuG = {};
        allGrades.forEach(g => {
            if (!stuG[g.studentId]) stuG[g.studentId] = { total: 0, count: 0 };
            stuG[g.studentId].total += (g.max ? (g.score / g.max) * 100 : 0);
            stuG[g.studentId].count++;
        });

        let riskStudents = [];
        Object.keys(stuG).forEach(sid => {
            const sg = stuG[sid];
            if (sg.count > 0) {
                const avg = Math.round(sg.total / sg.count);
                if (avg < 65) riskStudents.push({ sid, name: studentMap[sid] || 'Unknown', avg });
            }
        });

        const riskCount = riskStudents.length;
        document.getElementById('stat-risk').textContent = riskCount;
        const sbRisk = document.getElementById('sb-risk');
        if (sbRisk) sbRisk.textContent = riskCount;

        if (riskCount > 0) {
            document.getElementById('atRiskBanner').classList.remove('hidden');
            document.getElementById('atRiskMsg').textContent = `${riskCount} student${riskCount > 1 ? 's are' : ' is'} at risk (below 65%) this period.`;
            document.getElementById('needsAttentionList').innerHTML = riskStudents.sort((a, b) => a.avg - b.avg).map(s => `
                <a href="../roster/roster.html#${s.sid}" class="flex items-center justify-between bg-white border border-rose-100 rounded-xl p-3 shadow-sm hover:shadow transition cursor-pointer block">
                    <div class="flex items-center gap-2"><div class="w-8 h-8 rounded-lg bg-rose-100 text-rose-600 flex items-center justify-center font-black text-xs">${s.name.charAt(0)}</div><span class="font-bold text-slate-700 text-sm">${s.name}</span></div>
                    <span class="font-black text-rose-600">${s.avg}%</span>
                </a>`).join('');
        } else {
            document.getElementById('atRiskBanner').classList.add('hidden');
            document.getElementById('needsAttentionList').innerHTML = '<div class="flex items-center justify-center h-full text-slate-400 italic text-sm">No at-risk students found!</div>';
        }

        // 5d. Recent Activity (last 5 grades)
        const recentGrades = [...allGrades].sort((a, b) => new Date(b.createdAt || b.date).getTime() - new Date(a.createdAt || a.date).getTime()).slice(0, 5);

        if (recentGrades.length > 0) {
            document.getElementById('recentActivityList').innerHTML = recentGrades.map(g => {
                const pct = g.max ? Math.round(g.score / g.max * 100) : 0;
                const colorClass = gradeColorClass(pct);
                return `
                    <a href="../gradebook/gradebook.html" class="flex items-start gap-3 p-3 hover:bg-slate-50 rounded-xl transition cursor-pointer border-b border-slate-50 last:border-0 block">
                        <div class="w-8 h-8 rounded-full bg-slate-100 text-slate-500 flex items-center justify-center text-xs flex-shrink-0 mt-0.5"><i class="fa-solid fa-plus"></i></div>
                        <div class="flex-1 min-w-0">
                            <p class="text-sm font-bold text-slate-700 truncate">Logged <span class="text-emerald-600">${g.score}/${g.max}</span> for ${g.studentName}</p>
                            <p class="text-xs text-slate-400 font-semibold truncate">${g.subject} · ${g.title}</p>
                        </div>
                        <span class="${colorClass} font-black text-xs flex-shrink-0">${pct}%</span>
                    </a>`;
            }).join('');
        } else {
            document.getElementById('recentActivityList').innerHTML = '<div class="flex items-center justify-center h-full text-slate-400 italic text-sm">No recent grades logged.</div>';
        }

    } catch (e) {
        console.error("Error fetching dashboard metrics:", e);
    }
}

// Fire it up
init();
