// ── Boot Sequence: Security Check ──────────────────────────────────────────
const rawSession = localStorage.getItem('connectus_hq_session');
if (!rawSession) {
    window.location.replace('hq-login.html');
}
const session = JSON.parse(rawSession);

// ── DOM Elements ─────────────────────────────────────────────────────────
document.addEventListener('DOMContentLoaded', () => {
    // Populate Sidebar User Data
    document.getElementById('hqAdminName').textContent = session.name;
    document.getElementById('hqAdminId').textContent = session.id;
    document.getElementById('hqAdminBadge').textContent = `Role: ${session.role}`;

    // Security: Hide Team management if not Owner
    if (session.role !== 'Owner') {
        document.getElementById('navTeamBtn').classList.add('hidden');
    }

    // ── Tab Navigation Logic ─────────────────────────────────────────────
    const navButtons = document.querySelectorAll('#hqNav button');
    const views = document.querySelectorAll('.view-section');
    const pageTitle = document.getElementById('pageTitle');
    const pageSubtitle = document.getElementById('pageSubtitle');

    const titles = {
        'overview': { t: 'Overview', s: 'Platform metrics and system health.' },
        'approvals': { t: 'Approvals & Quotes', s: 'Process payments and initialize school environments.' },
        'schools': { t: 'School Directory', s: 'Manage and monitor all active school nodes.' },
        'organizations': { t: 'Organizations', s: 'Manage Ministry and District level access.' },
        'team': { t: 'HQ Team', s: 'Manage platform support staff and permissions.' }
    };

    navButtons.forEach(btn => {
        btn.addEventListener('click', (e) => {
            const targetTab = e.currentTarget.getAttribute('data-tab');

            // Reset all buttons styling
            navButtons.forEach(b => {
                b.className = 'w-full flex items-center gap-3 px-4 py-3 rounded-xl text-sm font-bold text-slate-400 hover:text-white hover:bg-slate-800 transition';
            });

            // Set active button styling
            e.currentTarget.className = 'w-full flex items-center gap-3 px-4 py-3 rounded-xl text-sm font-bold transition text-emerald-400 bg-emerald-900/20 border border-emerald-800/30';

            // Update Header
            pageTitle.textContent = titles[targetTab].t;
            pageSubtitle.textContent = titles[targetTab].s;

            // Hide all views, show target
            views.forEach(v => v.classList.add('hidden'));
            document.getElementById(`view-${targetTab}`).classList.remove('hidden');
        });
    });

    // ── Logout ────────────────────────────────────────────────────────────
    document.getElementById('logoutBtn').addEventListener('click', () => {
        localStorage.removeItem('connectus_hq_session');
        window.location.replace('hq-login.html');
    });
});
