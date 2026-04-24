import { db } from '../../assets/js/firebase-init.js';
import { doc, getDoc, getDocs, updateDoc, collection, query, where } from "https://www.gstatic.com/firebasejs/10.7.1/firebase-firestore.js";
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
const activePeriodSelect = document.getElementById('activePeriodSelect');
const activePeriodSaved = document.getElementById('activePeriodSaved');

// ── 2. LOAD DASHBOARD STATS ───────────────────────────────────────────────
async function loadOverviewStats() {
    try {
        // CHANGED: query global collections
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

// ── 3. LOAD & MANAGE ACTIVE GRADING PERIOD ────────────────────────────────
async function loadSemesters() {
    try {
        const snap = await getDocs(collection(db, 'schools', session.schoolId, 'semesters'));
        let allSemesters = snap.docs.map(d => ({ id: d.id, ...d.data() })).sort((a, b) => a.order - b.order);
        
        // Filter out archived periods for the dropdown, unless it's currently the active one
        const dropdownSems = allSemesters.filter(s => !s.archived || s.id === session.activeSemesterId);
        
        if (dropdownSems.length === 0) {
            activePeriodSelect.innerHTML = '<option disabled>No periods found</option>';
            return;
        }

        // Populate dropdown
        activePeriodSelect.innerHTML = dropdownSems.map(s => 
            `<option class="text-slate-800" value="${s.id}" ${s.id === session.activeSemesterId ? 'selected' : ''}>${s.name}</option>`
        ).join('');
        
    } catch (error) {
        console.error("Error loading semesters:", error);
        activePeriodSelect.innerHTML = '<option disabled>Error loading</option>';
    }
}

// Handle change event for Active Grading Period
activePeriodSelect.addEventListener('change', async (e) => {
    const newActiveId = e.target.value;
    activePeriodSelect.disabled = true; // Prevent rapid clicking
    
    try {
        // Update Firestore
        await updateDoc(doc(db, 'schools', session.schoolId), { 
            activeSemesterId: newActiveId 
        });
        
        // Update local session
        session.activeSemesterId = newActiveId;
        setSessionData('admin', session);
        
        // Show success message
        activePeriodSaved.classList.remove('hidden');
        setTimeout(() => activePeriodSaved.classList.add('hidden'), 3000);
        
    } catch (error) {
        console.error("Error updating active period:", error);
        alert("Failed to update the active grading period. Please try again.");
    } finally {
        activePeriodSelect.disabled = false;
    }
});

// ── INITIALIZE ────────────────────────────────────────────────────────────
document.addEventListener('DOMContentLoaded', () => {
    loadOverviewStats();
    loadSemesters();
});
