import { db } from '../../assets/js/firebase-init.js';
import { doc, getDoc, getDocs, collection, query, where } from "https://www.gstatic.com/firebasejs/10.7.1/firebase-firestore.js";
import { requireAuth, setSessionData } from '../../assets/js/auth.js';
import { injectAdminLayout } from '../../assets/js/layout-admin.js';

// ── 1. AUTHENTICATION & LAYOUT INJECTION ──────────────────────────────────
// Protect page and get session data. Redirects to login if invalid.
const session = requireAuth('admin', '../login.html');

// Inject the sidebar and topbar
injectAdminLayout('overview', 'Overview', 'School management dashboard', false, false);

// Elements
const statTeachersEl = document.getElementById('stat-teachers');
const statStudentsEl = document.getElementById('stat-students');
const statLimitEl = document.getElementById('stat-limit');
const planNameDisplay = document.getElementById('planNameDisplay');
const capacityBar = document.getElementById('capacityBar');
const capacityWarningBanner = document.getElementById('capacityWarningBanner');
const activePeriodDisplay = document.getElementById('activePeriodDisplay');

// ── 2. LOAD DASHBOARD STATS ───────────────────────────────────────────────
async function loadOverviewStats() {
    try {
        // Query global collections
        const [tSnap, sSnap] = await Promise.all([
            getDocs(query(collection(db, 'teachers'), where('currentSchoolId', '==', session.schoolId))),
            getDocs(query(collection(db, 'students'),
                where('currentSchoolId', '==', session.schoolId),
                where('enrollmentStatus', '==', 'Active')))
        ]);

        const activeTeachers = tSnap.docs.length;
        const activeStudents = sSnap.docs.length;
        
        // Grab limits from the current session data
        const limit = session.planLimit || 50;
        
        // Update UI
        statTeachersEl.textContent = activeTeachers;
        statStudentsEl.textContent = activeStudents;
        statLimitEl.textContent = limit;
        planNameDisplay.textContent = session.planName || 'Plan';
        
        // Capacity Progress Bar Logic
        const pct = Math.min(100, Math.round((activeStudents / limit) * 100));
        capacityBar.style.width = pct + '%';
        
        if (pct >= 90) {
            capacityBar.classList.replace('bg-white', 'bg-red-400');
        } else {
            capacityBar.classList.replace('bg-red-400', 'bg-white');
        }
        
        // Trigger Warning Banner if at capacity
        if (activeStudents >= limit) {
            capacityWarningBanner.classList.remove('hidden');
        } else {
            capacityWarningBanner.classList.add('hidden');
        }
        
    } catch (error) {
        console.error("Error loading overview stats:", error);
    }
}

// ── 3. LOAD & DISPLAY ACTIVE GRADING PERIOD (READ-ONLY) ───────────────────
async function loadSemesters() {
    try {
        if (!session.activeSemesterId) {
            activePeriodDisplay.textContent = 'None Set';
            return;
        }

        const docRef = doc(db, 'schools', session.schoolId, 'semesters', session.activeSemesterId);
        const docSnap = await getDoc(docRef);
        
        if (docSnap.exists()) {
            activePeriodDisplay.textContent = docSnap.data().name;
        } else {
            activePeriodDisplay.textContent = 'Unknown Period';
        }
        
    } catch (error) {
        console.error("Error loading active semester:", error);
        activePeriodDisplay.textContent = 'Error loading';
    }
}

// ── INITIALIZE ────────────────────────────────────────────────────────────
document.addEventListener('DOMContentLoaded', () => {
    loadOverviewStats();
    loadSemesters();
});
