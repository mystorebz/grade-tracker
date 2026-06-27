/* ==========================================================================
   CONNECTUS — SHARED NOTIFICATIONS MODULE
   Powers the topbar notification bell for the Teacher and Admin portals.
   Computed once on page load (no live listeners).

   STEP 1: Plumbing only. Renders the bell with a single hardcoded test
   item to confirm the shell works on every page for both roles.
   Real notification logic is added in later steps.
   ========================================================================== */

/**
 * Initializes the notification bell for a portal.
 * @param {string} role    - 'teacher' or 'admin' (controls accent class only)
 * @param {object} session - the portal session object (used in later steps)
 */
export function initNotifications(role, session) {
    const bellBtn  = document.getElementById('notifBellBtn');
    const dropdown = document.getElementById('notifDropdown');
    const listEl   = document.getElementById('notifList');
    const badgeEl  = document.getElementById('notifBadge');

    // If the bell shell isn't on the page for some reason, fail silently.
    if (!bellBtn || !dropdown || !listEl || !badgeEl) return;

    // ── Gather notifications ───────────────────────────────────────────────
    // STEP 1: one hardcoded test item, just to prove the plumbing renders.
    // Later steps replace this with real computed notifications.
    const notifications = [
        {
            level:   'info',                        // 'info' | 'warn' | 'urgent'
            icon:    'fa-circle-check',
            title:   'Notifications are working',
            message: 'This is a test item. Real alerts arrive in the next step.',
            href:    null
        }
    ];

    renderNotifications(notifications, listEl, badgeEl);

    // ── Dropdown open/close ────────────────────────────────────────────────
    // Toggle on bell click; close when clicking anywhere outside.
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

/**
 * Renders the notification list and badge count.
 */
function renderNotifications(notifications, listEl, badgeEl) {
    // Badge count
    if (notifications.length > 0) {
        badgeEl.textContent = notifications.length;
        badgeEl.classList.remove('hidden');
    } else {
        badgeEl.classList.add('hidden');
    }

    // Empty state
    if (notifications.length === 0) {
        listEl.innerHTML = `
            <div class="notif-empty">
                <i class="fa-solid fa-circle-check"></i>
                <p>You're all caught up.</p>
            </div>`;
        return;
    }

    // Items
    listEl.innerHTML = notifications.map(n => {
        const levelClass = n.level === 'urgent' ? 'notif-item-urgent'
                         : n.level === 'warn'   ? 'notif-item-warn'
                         : 'notif-item-info';
        const inner = `
            <div class="notif-item ${levelClass}">
                <div class="notif-item-icon"><i class="fa-solid ${n.icon}"></i></div>
                <div class="notif-item-body">
                    <p class="notif-item-title">${escHtmlNotif(n.title)}</p>
                    <p class="notif-item-msg">${escHtmlNotif(n.message)}</p>
                </div>
            </div>`;
        // Wrap in a link if the notification points somewhere
        return n.href
            ? `<a href="${n.href}" class="notif-item-link">${inner}</a>`
            : inner;
    }).join('');
}

function escHtmlNotif(str) {
    if (!str) return '';
    return String(str)
        .replace(/&/g, '&amp;').replace(/</g, '&lt;')
        .replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}
