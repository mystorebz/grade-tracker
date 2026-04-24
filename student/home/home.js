import { db } from '../../assets/js/firebase-init.js';
import { collection, getDocs, doc, getDoc, query, where } from "https://www.gstatic.com/firebasejs/10.7.1/firebase-firestore.js";
import { requireAuth } from '../../assets/js/auth.js';
import { injectStudentLayout } from '../../assets/js/layout-student.js';

// ── 1. AUTHENTICATION & LAYOUT ──────────────────────────────────────────
const session = requireAuth('student', '../login.html');

// Inject layout containers
injectStudentLayout('overview', 'Dashboard', 'Recent activity and overview');

// ── 2. UI ELEMENTS ───────────────────────────────────────────────────────
const dashAvgEl = document.getElementById('dashAvg');
const dashTotalEl = document.getElementById('dashTotalGrades');
const dashRecentEl = document.getElementById('dashRecentCount');
const activityListEl = document.getElementById('recentActivityList');

let teachersMap = {};

// ── 3. HELPERS ────────────────────────────────────────────────────────────
function gradeColorText(p) {
    if (p >= 90) return 'text-emerald-600';
    if (p >= 80) return 'text-blue-600';
    if (p >= 70) return 'text-teal-600';
    if (p >= 65) return 'text-amber-600';
    return 'text-red-600';
}

function timeAgo(ds) {
    const d = new Date(ds);
    if (isNaN(d)) return ds;
    const sec = Math.floor((new Date() - d) / 1000);
    let i = sec / 86400;
    if (i > 7) return d.toLocaleDateString();
    if (i >= 1) return Math.floor(i) + ' days ago';
    i = sec / 3600;
    if (i >= 1) return Math.floor(i) + ' hrs ago';
    i = sec / 60;
    if (i >= 1) return Math.floor(i) + ' mins ago';
    return 'Just now';
}

// ── 4. DATA FETCHING ──────────────────────────────────────────────────────
async function loadDashboardData() {
    try {
        const { schoolId, studentId } = session;

        // Fetch School document for active semester
        const schoolSnap = await getDoc(doc(db, 'schools', schoolId));
        const activeSemesterId = schoolSnap.data()?.activeSemesterId;
        const schoolName = schoolSnap.data()?.schoolName || 'ConnectUs School';
        
        // Update Global Layout Info
        document.getElementById('displaySchoolName').textContent = schoolName;
        document.getElementById('displayStudentName').textContent = session.studentData.name;
        document.getElementById('displayStudentClass').textContent = session.studentData.className || 'Unassigned';

        // Fetch Semester Name for topbar
        if (activeSemesterId) {
            const semSnap = await getDoc(doc(db, 'schools', schoolId, 'semesters', activeSemesterId));
            document.getElementById('activeSemesterDisplay').textContent = semSnap.data()?.name || 'Unknown Period';
        }

        // CHANGED: teachers are global — query by currentSchoolId
        const tSnap = await getDocs(query(collection(db, 'teachers'), where('currentSchoolId', '==', schoolId)));
        tSnap.forEach(d => { teachersMap[d.id] = d.data().name; });

        // Fetch Grades
        const gSnap = await getDocs(collection(db, 'schools', schoolId, 'students', studentId, 'grades'));
        const allGrades = gSnap.docs.map(d => ({ id: d.id, ...d.data() }));

        // ── CALCULATIONS ──
        const currentGrades = allGrades.filter(g => g.semesterId === activeSemesterId);
        
        // Avg Calculation
        const avg = currentGrades.length 
            ? Math.round(currentGrades.reduce((a, g) => a + (g.max ? (g.score / g.max) * 100 : 0), 0) / currentGrades.length) 
            : '--';
        
        dashAvgEl.textContent = avg;
        dashTotalEl.textContent = currentGrades.length;

        // Recent Activity (7 days)
        const sevenAgo = new Date(); 
        sevenAgo.setDate(sevenAgo.getDate() - 7);
        
        const recent = allGrades.filter(g => {
            const d = g.createdAt ? new Date(g.createdAt) : new Date(g.date);
            return d >= sevenAgo;
        }).sort((a, b) => {
            const da = a.createdAt ? new Date(a.createdAt) : new Date(a.date);
            const db = b.createdAt ? new Date(b.createdAt) : new Date(b.date);
            return db - da;
        });

        dashRecentEl.textContent = recent.length;

        // Render Activity Feed
        renderActivityFeed(recent);

    } catch (error) {
        console.error("Dashboard error:", error);
        activityListEl.innerHTML = `<p class="text-red-500 font-bold text-center">Failed to load dashboard data.</p>`;
    }
}

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
        const tName = teachersMap[g.teacherId] || 'Teacher';
        const pct = g.max ? Math.round((g.score / g.max) * 100) : 0;
        const timeStr = g.createdAt ? timeAgo(g.createdAt) : g.date;
        
        return `
            <div class="flex items-center justify-between p-4 bg-white border border-slate-100 rounded-2xl shadow-sm hover:shadow-md transition cursor-pointer" onclick="window.location.href='../grades/grades.html'">
                <div class="flex items-center gap-4">
                    <div class="h-10 w-10 bg-indigo-50 text-indigo-600 rounded-xl flex items-center justify-center text-lg shadow-sm font-black">
                        ${g.subject ? g.subject.charAt(0) : '*'}
                    </div>
                    <div>
                        <p class="font-black text-slate-800">${g.title}</p>
                        <p class="text-xs text-slate-500 font-bold mt-0.5">${tName} • ${g.subject} • ${timeStr}</p>
                    </div>
                </div>
                <div class="text-right">
                    <span class="font-black text-lg ${gradeColorText(pct)}">${g.score}/${g.max}</span>
                </div>
            </div>`;
    }).join('');
}

// ── INITIALIZE ────────────────────────────────────────────────────────────
document.addEventListener('DOMContentLoaded', loadDashboardData);
