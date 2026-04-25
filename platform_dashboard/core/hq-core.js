import { loadQuotes } from './hq-approvals.js';

// ── Boot Sequence: Security Check ──────────────────────────────────────────
const rawSession = localStorage.getItem('connectus_hq_session');
if (!rawSession) {
    window.location.replace('hq-login.html');
}
const session = JSON.parse(rawSession);

// ── DOM Elements ─────────────────────────────────────────────────────────
document.addEventListener('DOMContentLoaded', () => {
    document.getElementById('hqAdminName').textContent = session.name;
    document.getElementById('hqAdminId').textContent = session.id;
    document.getElementById('hqAdminBadge').textContent = `Role: ${session.role}`;

    if (session.role !== 'Owner') {
        document.getElementById('navTeamBtn').classList.add('hidden');
    }

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

            navButtons.forEach(b => {
                b.className = 'w-full flex items-center gap-3 px-4 py-3 rounded-xl text-sm font-bold text-slate-400 hover:text-white hover:bg-slate-800 transition';
            });

            e.currentTarget.className = 'w-full flex items-center gap-3 px-4 py-3 rounded-xl text-sm font-bold transition text-emerald-400 bg-emerald-900/20 border border-emerald-800/30';

            pageTitle.textContent = titles[targetTab].t;
            pageSubtitle.textContent = titles[targetTab].s;

            views.forEach(v => v.classList.add('hidden'));
            document.getElementById(`view-${targetTab}`).classList.remove('hidden');

            // Trigger specific scripts based on tab
            if (targetTab === 'approvals') {
                loadQuotes();
            }
        });
    });

    document.getElementById('logoutBtn').addEventListener('click', () => {
        localStorage.removeItem('connectus_hq_session');
        window.location.replace('hq-login.html');
    });
});
