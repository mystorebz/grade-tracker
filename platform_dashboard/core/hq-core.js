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

        // 2. Active Schools (Updated with Expiration Checks & Notifications)
        const sSnap = await getDocs(collection(db, 'schools'));
        let activeCount = 0;
        
        // --- NEW: Setup for Expiration Checks ---
        const now = new Date();
        const expiringSchools = []; // Array to hold data for the Notification Bell

        sSnap.forEach(doc => {
            const data = doc.data();
            // A school is only counted as active if the kill switch (isVerified) is explicitly true
            if (data.isVerified === true) {
                activeCount++;

                // --- NEW: Expiration Warning Logic (14 Days) ---
                if (data.nextRenewalDate) {
                    const renDate = new Date(data.nextRenewalDate);
                    const msPerDay = 1000 * 60 * 60 * 24;
                    const daysRemaining = Math.ceil((renDate - now) / msPerDay);
                    
                    if (daysRemaining > 0 && daysRemaining <= 14) {
                        expiringSchools.push({
                            id: doc.id,
                            name: data.schoolName || 'Unknown School',
                            days: daysRemaining
                        });
                        
                        // Trigger the pop-up toast notification
                        window.showToast(
                            'Subscription Expiring Soon', 
                            `<strong class="text-white">${data.schoolName || 'Unknown School'}</strong> (${doc.id}) will expire in ${daysRemaining} days.`, 
                            'warning'
                        );
                    }
                }
            }
        });
        document.getElementById('metricSchools').textContent = activeCount;

        // --- NEW: Send the expiring schools to the Dropdown Menu ---
        populateNotificationBell(expiringSchools);

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

// ── Toast Notification Engine ─────────────────────────────────────────────
window.showToast = (title, message, type = 'warning') => {
    const container = document.getElementById('toastContainer');
    if (!container) return;

    const colors = {
        warning: 'bg-amber-500',
        border: 'border-amber-700',
        icon: '<i class="fa-solid fa-triangle-exclamation text-amber-500 mt-0.5"></i>'
    };

    const toast = document.createElement('div');
    toast.className = `bg-slate-800 border ${colors.border} p-4 shadow-2xl shadow-black/50 w-80 transform translate-x-full opacity-0 transition-all duration-500 ease-out pointer-events-auto flex items-start gap-3 mb-3`;
    
    toast.innerHTML = `
        <div class="flex-shrink-0 text-lg">${colors.icon}</div>
        <div class="flex-1">
            <h4 class="text-xs font-black text-white uppercase tracking-widest">${title}</h4>
            <p class="text-xs text-slate-400 mt-1 leading-relaxed">${message}</p>
        </div>
        <button class="text-slate-500 hover:text-white transition flex-shrink-0" onclick="this.parentElement.remove()">
            <i class="fa-solid fa-xmark"></i>
        </button>
    `;

    container.appendChild(toast);

    // Slide in
    setTimeout(() => toast.classList.remove('translate-x-full', 'opacity-0'), 10);

    // Auto-remove after 8 seconds
    setTimeout(() => {
        toast.classList.add('translate-x-full', 'opacity-0');
        setTimeout(() => toast.remove(), 500); 
    }, 8000);
};

// ── Notification Bell UI Builder ──────────────────────────────────────────
function populateNotificationBell(expiringSchools) {
    const badge = document.getElementById('notificationBadge');
    const list = document.getElementById('notificationList');
    
    if (!badge || !list) return;

    if (expiringSchools.length > 0) {
        badge.textContent = expiringSchools.length;
        badge.classList.remove('hidden');
        
        // Sort the list so the ones expiring soonest are at the top
        expiringSchools.sort((a, b) => a.days - b.days);
        
        let html = '';
        expiringSchools.forEach(school => {
            html += `
                <div class="p-4 border-b border-slate-700 hover:bg-slate-800 transition">
                    <p class="text-xs font-bold text-white mb-1">${school.name} <span class="text-slate-500 font-mono font-normal">(${school.id})</span></p>
                    <p class="text-[10px] font-black uppercase tracking-widest text-amber-400">Expires in ${school.days} Days</p>
                </div>
            `;
        });
        list.innerHTML = html;
    } else {
        badge.classList.add('hidden');
        list.innerHTML = `
            <div class="p-6 text-center">
                <i class="fa-solid fa-circle-check text-emerald-500 text-3xl mb-2"></i>
                <p class="text-xs font-bold text-slate-400">You're all caught up!</p>
                <p class="text-[10px] text-slate-500 mt-1 uppercase tracking-widest">No impending expirations.</p>
            </div>
        `;
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

    // --- NEW: Dropdown Toggle Logic ---
    const bellBtn = document.getElementById('notificationBellBtn');
    const dropdown = document.getElementById('notificationDropdown');
    
    if (bellBtn && dropdown) {
        bellBtn.addEventListener('click', (e) => {
            e.stopPropagation(); // Prevents click from instantly closing it
            dropdown.classList.toggle('hidden');
        });
        
        // Close dropdown when clicking anywhere else on the screen
        document.addEventListener('click', (e) => {
            if (!dropdown.contains(e.target) && !bellBtn.contains(e.target)) {
                dropdown.classList.add('hidden');
            }
        });
    }

    loadDashboardMetrics();
});
