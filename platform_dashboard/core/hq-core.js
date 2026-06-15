import { db } from '../../assets/js/firebase-init.js';
import { collection, getDocs, query, where, onSnapshot } from "https://www.gstatic.com/firebasejs/10.7.1/firebase-firestore.js";

// ── Boot Sequence: Security Check ─────────────────────────────────────────
const rawSession = localStorage.getItem('connectus_hq_session');
if (!rawSession) {
    window.location.replace('hq-login.html');
}
const session = JSON.parse(rawSession);

// ── Module-Level State ────────────────────────────────────────────────────
let knownQuoteIds        = null; // null = first snapshot not yet processed
let cachedExpiringSchools = [];
let newQuoteNotifications = [];

// ── Dashboard Metrics Loader ──────────────────────────────────────────────
async function loadDashboardMetrics() {
    try {
        // 1. Active Schools (Expiration Checks & Notifications)
        const sSnap = await getDocs(collection(db, 'schools'));
        let activeCount = 0;

        const now = new Date();
        const expiringSchools = [];

        sSnap.forEach(doc => {
            const data = doc.data();
            if (data.isVerified === true) {
                activeCount++;

                if (data.nextRenewalDate) {
                    const renDate = new Date(data.nextRenewalDate);
                    const msPerDay = 1000 * 60 * 60 * 24;
                    const daysRemaining = Math.ceil((renDate - now) / msPerDay);

                    if (daysRemaining > 0 && daysRemaining <= 14) {
                        expiringSchools.push({
                            id:   doc.id,
                            name: data.schoolName || 'Unknown School',
                            days: daysRemaining
                        });

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

        // Cache for bell updates triggered by the quote listener
        cachedExpiringSchools = expiringSchools;
        populateNotificationBell(cachedExpiringSchools, newQuoteNotifications);

        // 2. Teachers
        try {
            const tSnap = await getDocs(collection(db, 'teachers'));
            document.getElementById('metricTeachers').textContent = tSnap.size;
        } catch(e) {
            document.getElementById('metricTeachers').textContent = "0";
        }

        // 3. Students
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

// ── Real-Time Quote Listener ──────────────────────────────────────────────
function setupQuoteListener() {
    const q = query(collection(db, 'quote_requests'), where('fulfilled', '==', false));

    onSnapshot(q, (snapshot) => {
        // Update the metric counter
        document.getElementById('metricQuotes').textContent = snapshot.size;

        if (knownQuoteIds === null) {
            // First snapshot — just record what exists, no notifications
            knownQuoteIds = new Set(snapshot.docs.map(d => d.id));
            return;
        }

        // Subsequent snapshots — detect genuinely new documents
        snapshot.docs.forEach(doc => {
            if (!knownQuoteIds.has(doc.id)) {
                knownQuoteIds.add(doc.id);

                const data = doc.data();
                const schoolName = data.schoolName || 'Unknown School';
                const reqId      = doc.id;

                // Add to new quotes list for the bell dropdown
                newQuoteNotifications.unshift({ id: reqId, name: schoolName });

                // Toast in-app
                window.showToast(
                    'New Quote Request',
                    `<strong class="text-white">${schoolName}</strong> just submitted a quote request (${reqId}).`,
                    'quote'
                );

                // Browser push notification (OS-level)
                if (Notification.permission === 'granted') {
                    new Notification('New Quote Request — ConnectUs HQ', {
                        body: `${schoolName} just submitted a quote request.`,
                        icon: '../assets/images/favicon-32x32.png'
                    });
                }

                // Refresh the bell
                populateNotificationBell(cachedExpiringSchools, newQuoteNotifications);
            }
        });
    }, (error) => {
        console.error("Quote listener error:", error);
    });
}

// ── Toast Notification Engine ─────────────────────────────────────────────
window.showToast = (title, message, type = 'warning') => {
    const container = document.getElementById('toastContainer');
    if (!container) return;

    const styles = {
        warning: { border: 'border-amber-700',  icon: '<i class="fa-solid fa-triangle-exclamation text-amber-500 mt-0.5"></i>' },
        quote:   { border: 'border-emerald-700', icon: '<i class="fa-solid fa-file-invoice-dollar text-emerald-400 mt-0.5"></i>' }
    };
    const s = styles[type] || styles.warning;

    const toast = document.createElement('div');
    toast.className = `bg-slate-800 border ${s.border} p-4 shadow-2xl shadow-black/50 w-80 transform translate-x-full opacity-0 transition-all duration-500 ease-out pointer-events-auto flex items-start gap-3 mb-3`;

    toast.innerHTML = `
        <div class="flex-shrink-0 text-lg">${s.icon}</div>
        <div class="flex-1">
            <h4 class="text-xs font-black text-white uppercase tracking-widest">${title}</h4>
            <p class="text-xs text-slate-400 mt-1 leading-relaxed">${message}</p>
        </div>
        <button class="text-slate-500 hover:text-white transition flex-shrink-0" onclick="this.parentElement.remove()">
            <i class="fa-solid fa-xmark"></i>
        </button>
    `;

    container.appendChild(toast);
    setTimeout(() => toast.classList.remove('translate-x-full', 'opacity-0'), 10);
    setTimeout(() => {
        toast.classList.add('translate-x-full', 'opacity-0');
        setTimeout(() => toast.remove(), 500);
    }, 8000);
};

// ── Notification Bell UI Builder ──────────────────────────────────────────
function populateNotificationBell(expiringSchools, newQuotes) {
    const badge = document.getElementById('notificationBadge');
    const list  = document.getElementById('notificationList');

    if (!badge || !list) return;

    const totalCount = expiringSchools.length + newQuotes.length;

    if (totalCount > 0) {
        badge.textContent = totalCount;
        badge.classList.remove('hidden');

        let html = '';

        // New quote requests section
        if (newQuotes.length > 0) {
            html += `<div class="px-4 py-2 bg-emerald-950/40 border-b border-slate-700">
                        <p class="text-[9px] font-black uppercase tracking-widest text-emerald-500">New Quote Requests</p>
                     </div>`;
            newQuotes.forEach(q => {
                html += `
                    <div class="p-4 border-b border-slate-700 hover:bg-slate-800 transition">
                        <p class="text-xs font-bold text-white mb-1">${q.name} <span class="text-slate-500 font-mono font-normal">(${q.id})</span></p>
                        <p class="text-[10px] font-black uppercase tracking-widest text-emerald-400">New Request</p>
                    </div>
                `;
            });
        }

        // Expiring schools section
        if (expiringSchools.length > 0) {
            const sorted = [...expiringSchools].sort((a, b) => a.days - b.days);
            html += `<div class="px-4 py-2 bg-amber-950/40 border-b border-slate-700">
                        <p class="text-[9px] font-black uppercase tracking-widest text-amber-500">Expiring Soon</p>
                     </div>`;
            sorted.forEach(school => {
                html += `
                    <div class="p-4 border-b border-slate-700 hover:bg-slate-800 transition">
                        <p class="text-xs font-bold text-white mb-1">${school.name} <span class="text-slate-500 font-mono font-normal">(${school.id})</span></p>
                        <p class="text-[10px] font-black uppercase tracking-widest text-amber-400">Expires in ${school.days} Days</p>
                    </div>
                `;
            });
        }

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
        window.location.replace('hq-login.html');
    });

    // Dropdown Toggle
    const bellBtn   = document.getElementById('notificationBellBtn');
    const dropdown  = document.getElementById('notificationDropdown');

    if (bellBtn && dropdown) {
        bellBtn.addEventListener('click', (e) => {
            e.stopPropagation();
            dropdown.classList.toggle('hidden');
        });
        document.addEventListener('click', (e) => {
            if (!dropdown.contains(e.target) && !bellBtn.contains(e.target)) {
                dropdown.classList.add('hidden');
            }
        });
    }

    // Request browser notification permission once
    if ('Notification' in window && Notification.permission === 'default') {
        Notification.requestPermission();
    }

    loadDashboardMetrics();
    setupQuoteListener();
});
