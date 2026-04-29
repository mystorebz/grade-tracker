import { db } from '../../assets/js/firebase-init.js';
import { collection, getDocs, query, where } from "https://www.gstatic.com/firebasejs/10.7.1/firebase-firestore.js";

// ── Boot Sequence: Security Check ─────────────────────────────────────────
const rawSession = localStorage.getItem('connectus_hq_session');
if (!rawSession) {
    window.location.replace('core/hq-login.html');
}
const session = JSON.parse(rawSession);

// ── Dashboard Metrics Loader ──────────────────────────────────────────────
async function loadDashboardMetrics() {
    try {
        // 1. Pending Quotes
        const qSnap = await getDocs(query(collection(db, 'quote_requests'), where('fulfilled', '==', false)));
        document.getElementById('metricQuotes').textContent = qSnap.size;

        // 2. Active Schools (Updated to use our isVerified kill switch)
        const sSnap = await getDocs(collection(db, 'schools'));
        let activeCount = 0;
        sSnap.forEach(doc => {
            const data = doc.data();
            // A school is only counted as active if the kill switch (isVerified) is explicitly true
            if (data.isVerified === true) {
                activeCount++;
            }
        });
        document.getElementById('metricSchools').textContent = activeCount;

        // 3. Teachers
        try {
            const tSnap = await getDocs(collection(db, 'teachers'));
            document.getElementById('metricTeachers').textContent = tSnap.size;
        } catch(e) {
            document.getElementById('metricTeachers').textContent = "0";
        }

        // 4. Students
        try {
            const stSnap = await getDocs(collection(db, 'students'));
            document.getElementById('metricStudents').textContent = stSnap.size;
        } catch(e) {
            document.getElementById('metricStudents').textContent = "0";
        }

    } catch (error) {
        console.error("Failed to load metrics:", error);
    }
}

// ── DOM Initialization ────────────────────────────────────────────────────
document.addEventListener('DOMContentLoaded', () => {

    document.getElementById('hqAdminName').textContent  = session.name;
    document.getElementById('hqAdminId').textContent    = session.id;
    document.getElementById('hqAdminBadge').textContent = `Role: ${session.role}`;

    if (session.role !== 'Owner') {
        const teamBtn = document.getElementById('navTeamBtn');
        if (teamBtn) teamBtn.classList.add('hidden');
    }

    document.getElementById('logoutBtn').addEventListener('click', () => {
        localStorage.removeItem('connectus_hq_session');
        window.location.replace('core/hq-login.html');
    });

    loadDashboardMetrics();
});
