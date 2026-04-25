import { db } from '../../assets/js/firebase-init.js';
import { collection, getDocs, query, where } from "https://www.gstatic.com/firebasejs/10.7.1/firebase-firestore.js";

// ── Boot Sequence: Security Check ──────────────────────────────────────────
const rawSession = localStorage.getItem('connectus_hq_session');
if (!rawSession) {
    window.location.replace('core/hq-login.html');
}
const session = JSON.parse(rawSession);

// ── Dashboard Metrics Loader ───────────────────────────────────────────────
async function loadDashboardMetrics() {
    try {
        // 1. Pending Quotes
        const qSnap = await getDocs(query(collection(db, 'quote_requests'), where('fulfilled', '==', false)));
        document.getElementById('metricQuotes').textContent = qSnap.size;

        // 2. Active Schools
        const sSnap = await getDocs(query(collection(db, 'schools'), where('isActive', '==', true)));
        document.getElementById('metricSchools').textContent = sSnap.size;

        // 3. Teachers & Students (Wrap in try/catch just in case rules ever block global list access)
        try {
            const tSnap = await getDocs(collection(db, 'teachers'));
            document.getElementById('metricTeachers').textContent = tSnap.size;
        } catch(e) { document.getElementById('metricTeachers').textContent = "-"; }

        try {
            const stSnap = await getDocs(collection(db, 'students'));
            document.getElementById('metricStudents').textContent = stSnap.size;
        } catch(e) { document.getElementById('metricStudents').textContent = "-"; }

    } catch (error) {
        console.error("Failed to load metrics:", error);
    }
}

// ── DOM Initialization ───────────────────────────────────────────────────
document.addEventListener('DOMContentLoaded', () => {
    // Populate Admin Info
    document.getElementById('hqAdminName').textContent = session.name;
    document.getElementById('hqAdminId').textContent = session.id;
    document.getElementById('hqAdminBadge').textContent = `Role: ${session.role}`;

    // Enforce Role Permissions
    if (session.role !== 'Owner') {
        const teamBtn = document.getElementById('navTeamBtn');
        if (teamBtn) teamBtn.classList.add('hidden');
    }

    // Handle Logout
    document.getElementById('logoutBtn').addEventListener('click', () => {
        localStorage.removeItem('connectus_hq_session');
        window.location.replace('core/hq-login.html');
    });

    // Load Data
    loadDashboardMetrics();
});
