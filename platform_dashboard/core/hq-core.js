// ── Boot Sequence: Security Check ──────────────────────────────────────────
const rawSession = localStorage.getItem('connectus_hq_session');
if (!rawSession) {
    // Assuming index.html is at the root of platform_dashboard, 
    // it points to the core folder for login
    window.location.replace('core/hq-login.html');
}
const session = JSON.parse(rawSession);

// ── DOM Elements ─────────────────────────────────────────────────────────
document.addEventListener('DOMContentLoaded', () => {
    // 1. Populate Admin Info in Sidebar
    document.getElementById('hqAdminName').textContent = session.name;
    document.getElementById('hqAdminId').textContent = session.id;
    document.getElementById('hqAdminBadge').textContent = `Role: ${session.role}`;

    // 2. Enforce Role Permissions
    if (session.role !== 'Owner') {
        const teamBtn = document.getElementById('navTeamBtn');
        if (teamBtn) teamBtn.classList.add('hidden');
    }

    // 3. Handle Logout
    document.getElementById('logoutBtn').addEventListener('click', () => {
        localStorage.removeItem('connectus_hq_session');
        window.location.replace('core/hq-login.html');
    });

    // NOTE: All previous tab-switching logic was removed because 
    // navigation is now handled by the <a> links in your HTML sidebars.
});
