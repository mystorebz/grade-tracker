import { db } from '../../assets/js/firebase-init.js';
import { collection, getDocs, doc, getDoc, updateDoc, query, where } from "https://www.gstatic.com/firebasejs/10.7.1/firebase-firestore.js";
import { requireAuth, setSessionData } from '../../assets/js/auth.js';
import { injectStudentLayout } from '../../assets/js/layout-student.js';

// ── 1. AUTHENTICATION & LAYOUT ────────────────────────────────────────────
const session = requireAuth('student', '../login.html');
injectStudentLayout('overview', 'Dashboard', 'Recent activity and overview');

// ── 2. UI ELEMENTS ────────────────────────────────────────────────────────
const dashAvgEl      = document.getElementById('dashAvg');
const dashTotalEl    = document.getElementById('dashTotalGrades');
const dashRecentEl   = document.getElementById('dashRecentCount');
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
    const d   = new Date(ds);
    if (isNaN(d)) return ds;
    const sec = Math.floor((new Date() - d) / 1000);
    let i     = sec / 86400;
    if (i > 7)  return d.toLocaleDateString();
    if (i >= 1) return Math.floor(i) + ' days ago';
    i = sec / 3600;
    if (i >= 1) return Math.floor(i) + ' hrs ago';
    i = sec / 60;
    if (i >= 1) return Math.floor(i) + ' mins ago';
    return 'Just now';
}

// Mask email for display: j***@example.com
function maskEmail(email) {
    if (!email) return 'Not set';
    const [user, domain] = email.split('@');
    if (!domain) return email;
    const masked = user.length <= 2 ? user : user.charAt(0) + '***';
    return `${masked}@${domain}`;
}

// ── 4. LOAD DASHBOARD DATA ────────────────────────────────────────────────
async function loadDashboardData() {
    try {
        const { schoolId, studentId } = session;

        const schoolSnap = await getDoc(doc(db, 'schools', schoolId));
        const activeSemesterId = schoolSnap.data()?.activeSemesterId;
        const schoolName       = schoolSnap.data()?.schoolName || 'ConnectUs School';

        document.getElementById('displaySchoolName').textContent  = schoolName;
        document.getElementById('displayStudentName').textContent = session.studentData.name;
        document.getElementById('displayStudentClass').textContent = session.studentData.className || 'Unassigned';

        if (activeSemesterId) {
            const semSnap = await getDoc(doc(db, 'schools', schoolId, 'semesters', activeSemesterId));
            document.getElementById('activeSemesterDisplay').textContent = semSnap.data()?.name || 'Unknown Period';
        }

        const tSnap = await getDocs(query(collection(db, 'teachers'), where('currentSchoolId', '==', schoolId)));
        tSnap.forEach(d => { teachersMap[d.id] = d.data().name; });

        const gSnap    = await getDocs(collection(db, 'schools', schoolId, 'students', studentId, 'grades'));
        const allGrades = gSnap.docs.map(d => ({ id: d.id, ...d.data() }));

        const currentGrades = allGrades.filter(g => g.semesterId === activeSemesterId);
        const avg = currentGrades.length
            ? Math.round(currentGrades.reduce((a, g) => a + (g.max ? (g.score / g.max) * 100 : 0), 0) / currentGrades.length)
            : '--';

        dashAvgEl.textContent   = avg;
        dashTotalEl.textContent = currentGrades.length;

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
        renderActivityFeed(recent);

        // ── Load recovery email display ────────────────────────────────────
        loadEmailDisplay();

    } catch (error) {
        console.error('[StudentHome] Dashboard error:', error);
        activityListEl.innerHTML = `<p class="text-red-500 font-bold text-center">Failed to load dashboard data.</p>`;
    }
}

// ── 5. ACTIVITY FEED ──────────────────────────────────────────────────────
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
        const tName   = teachersMap[g.teacherId] || (g.enteredByAdmin ? (g.adminName || 'Admin') : 'Teacher');
        const pct     = g.max ? Math.round((g.score / g.max) * 100) : 0;
        const timeStr = g.createdAt ? timeAgo(g.createdAt) : g.date;
        const adminTag = g.enteredByAdmin
            ? `<span class="text-[9px] font-black text-blue-500 bg-blue-50 border border-blue-200 px-1.5 py-0.5 rounded ml-1">Admin entry</span>`
            : '';

        return `
        <div class="flex items-center justify-between p-4 bg-white border border-slate-100 rounded-2xl shadow-sm hover:shadow-md transition cursor-pointer"
             onclick="window.location.href='../grades/grades.html'">
            <div class="flex items-center gap-4">
                <div class="h-10 w-10 bg-indigo-50 text-indigo-600 rounded-xl flex items-center justify-center text-lg shadow-sm font-black">
                    ${g.subject ? g.subject.charAt(0) : '*'}
                </div>
                <div>
                    <p class="font-black text-slate-800">${g.title}${adminTag}</p>
                    <p class="text-xs text-slate-500 font-bold mt-0.5">${tName} • ${g.subject} • ${timeStr}</p>
                </div>
            </div>
            <div class="text-right">
                <span class="font-black text-lg ${gradeColorText(pct)}">${g.score}/${g.max}</span>
            </div>
        </div>`;
    }).join('');
}

// ── 6. RECOVERY EMAIL ─────────────────────────────────────────────────────

function loadEmailDisplay() {
    const email = session.studentData?.email || '';
    const displayEl = document.getElementById('emailDisplayValue');
    if (displayEl) {
        displayEl.textContent = email ? maskEmail(email) : '⚠ Not set — add one for PIN recovery';
        displayEl.className   = email
            ? 'font-black text-slate-700 text-sm'
            : 'font-black text-amber-600 text-sm';
    }
}

window.showEmailEdit = function() {
    document.getElementById('emailDisplayState').classList.add('hidden');
    document.getElementById('emailEditState').classList.remove('hidden');
    document.getElementById('emailChangePinInput').value = '';
    document.getElementById('emailChangeNewInput').value = '';
    document.getElementById('emailChangeMsg').classList.add('hidden');
    document.getElementById('emailChangePinInput').focus();
};

window.cancelEmailEdit = function() {
    document.getElementById('emailEditState').classList.add('hidden');
    document.getElementById('emailDisplayState').classList.remove('hidden');
};

window.saveEmailChange = async function() {
    const pin      = document.getElementById('emailChangePinInput').value.trim();
    const newEmail = document.getElementById('emailChangeNewInput').value.trim().toLowerCase();
    const msgEl    = document.getElementById('emailChangeMsg');
    const btn      = document.getElementById('saveEmailBtn');
    msgEl.classList.add('hidden');

    if (!pin) {
        showEmailMsg('Please enter your current PIN.', true); return;
    }
    if (!newEmail) {
        showEmailMsg('Please enter a new email address.', true); return;
    }
    if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(newEmail)) {
        showEmailMsg('Please enter a valid email address.', true); return;
    }

    btn.disabled  = true;
    btn.innerHTML = '<i class="fa-solid fa-spinner fa-spin mr-2"></i>Saving...';

    try {
        // ── Fetch fresh student doc to verify PIN ──────────────────────────
        // PIN verification prevents an unlocked session from silently
        // changing the recovery email and then using Forgot PIN to take over.
        const snap = await getDoc(doc(db, 'students', session.studentId));
        if (!snap.exists() || String(snap.data().pin) !== String(pin)) {
            showEmailMsg('Incorrect PIN. Email not changed.', true);
            btn.disabled  = false; btn.innerHTML = 'Save New Email'; return;
        }

        await updateDoc(doc(db, 'students', session.studentId), { email: newEmail });

        // Update session in-place
        session.studentData.email = newEmail;
        setSessionData('student', session);

        showEmailMsg('Recovery email updated successfully!', false);

        // Switch back to display state after short delay
        setTimeout(() => {
            window.cancelEmailEdit();
            loadEmailDisplay();
        }, 1800);

    } catch (e) {
        console.error('[StudentHome] saveEmailChange:', e);
        showEmailMsg('Failed to update email. Please try again.', true);
    }

    btn.disabled  = false;
    btn.innerHTML = 'Save New Email';
};

function showEmailMsg(msg, isError) {
    const el = document.getElementById('emailChangeMsg');
    el.textContent = msg;
    el.className   = isError
        ? 'text-xs font-bold p-3 rounded-xl text-red-600 bg-red-50 border border-red-100'
        : 'text-xs font-bold p-3 rounded-xl text-green-600 bg-green-50 border border-green-100';
    el.classList.remove('hidden');
}

// ── INITIALIZE ─────────────────────────────────────────────────────────────
document.addEventListener('DOMContentLoaded', loadDashboardData);
