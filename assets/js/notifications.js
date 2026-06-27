/* ==========================================================================
   CONNECTUS — SHARED NOTIFICATIONS MODULE
   Powers the topbar notification bell for the Teacher and Admin portals.
   Computed once on page load (no live listeners).

   STEP 2: Grading period awareness.
     • Amber "warn"   when the active period ends within 7 days (countdown)
     • Red   "urgent" when the active period's end date has passed
   Reads the active semester the same way the teacher pages already do:
   the semester list from the connectus_semesters_{schoolId} cache (or a
   one-time fetch if absent), and the active semester id from the school doc.
   ========================================================================== */

import { db } from './firebase-init.js';
import { doc, getDoc, getDocs, collection } from "https://www.gstatic.com/firebasejs/10.7.1/firebase-firestore.js";

/**
 * Initializes the notification bell for a portal.
 * @param {string} role    - 'teacher' or 'admin' (accent only)
 * @param {object} session - the portal session object
 */
export function initNotifications(role, session) {
    const bellBtn  = document.getElementById('notifBellBtn');
    const dropdown = document.getElementById('notifDropdown');
    const listEl   = document.getElementById('notifList');
    const badgeEl  = document.getElementById('notifBadge');

    // If the bell shell isn't on the page, fail silently.
    if (!bellBtn || !dropdown || !listEl || !badgeEl) return;

    // ── Dropdown open/close (wire immediately so the bell is responsive) ────
    bellBtn.addEventListener('click', (e) => {
        e.stopPropagation();
        dropdown.classList.toggle('hidden');
    });
    document.addEventListener('click', (e) => {
        if (!dropdown.contains(e.target) && !bellBtn.contains(e.target)) {
            dropdown.classList.add('hidden');
        }
    });

    // Render an initial empty state while async checks run.
    renderNotifications([], listEl, badgeEl);

    // ── Gather notifications asynchronously, then render ────────────────────
    buildNotifications(role, session)
        .then(notifications => renderNotifications(notifications, listEl, badgeEl))
        .catch(err => {
            console.error('[Notifications] build failed:', err);
            renderNotifications([], listEl, badgeEl);
        });
}

/**
 * Builds the list of notifications for the given role/session.
 * Returns a Promise<Array>.
 */
async function buildNotifications(role, session) {
    const notifications = [];

    // ── Grading period awareness ───────────────────────────────────────────
    try {
        const periodNotif = await checkGradingPeriod(role, session);
        if (periodNotif) notifications.push(periodNotif);
    } catch (e) {
        console.error('[Notifications] grading period check failed:', e);
    }

    // (Future steps add at-risk, missing grades, seat limits here.)

    return notifications;
}

/**
 * Checks the active grading period's end date and returns a notification
 * object if it's ending soon (<= 7 days) or has already passed. Otherwise null.
 */
async function checkGradingPeriod(role, session) {
    const schoolId = session?.schoolId;
    if (!schoolId) return null;

    // 1. Resolve the active semester ID.
    //    Admin session carries it; teacher session does not — so fall back
    //    to the school doc, exactly like the teacher pages do.
    let activeId = session.activeSemesterId || '';
    if (!activeId) {
        const schoolSnap = await getDoc(doc(db, 'schools', schoolId));
        activeId = schoolSnap.exists() ? (schoolSnap.data().activeSemesterId || '') : '';
    }
    if (!activeId) return null; // no active period set — nothing to warn about

    // 2. Get the semester list — cache first, then one-time fetch if absent.
    const cacheKey = `connectus_semesters_${schoolId}`;
    let semesters  = [];
    const cached   = localStorage.getItem(cacheKey);
    if (cached) {
        try { semesters = JSON.parse(cached); } catch (_) { semesters = []; }
    }
    if (!semesters.length) {
        const snap = await getDocs(collection(db, 'schools', schoolId, 'semesters'));
        semesters  = snap.docs.map(d => ({ id: d.id, ...d.data() }));
        // Don't write the cache here — let the dashboards own that, to avoid
        // changing behavior elsewhere. We just read what we need.
    }

    // 3. Find the active semester and check its end date.
    const active = semesters.find(s => s.id === activeId);
    if (!active || !active.endDate) return null;

    const today = startOfDay(new Date());
    const end   = startOfDay(new Date(active.endDate + 'T00:00:00'));
    if (isNaN(end.getTime())) return null;

    const msPerDay = 1000 * 60 * 60 * 24;
    const daysLeft = Math.round((end - today) / msPerDay);

    const periodName = active.name || 'The current grading period';
    const href = role === 'admin'
        ? '../grading_periods/grading_periods.html'
        : '../gradebook/gradebook.html';

    // Already passed → red urgent
    if (daysLeft < 0) {
        const daysAgo = Math.abs(daysLeft);
        return {
            level:   'urgent',
            icon:    'fa-calendar-xmark',
            title:   `${periodName} has ended`,
            message: `The grading period ended ${daysAgo} day${daysAgo !== 1 ? 's' : ''} ago. Make sure all grades are in, then lock or roll over the period.`,
            href
        };
    }

    // Ends today
    if (daysLeft === 0) {
        return {
            level:   'urgent',
            icon:    'fa-calendar-day',
            title:   `${periodName} ends today`,
            message: `Today is the last day of the grading period. Confirm all grades are entered.`,
            href
        };
    }

    // Within 7 days → amber warn (countdown)
    if (daysLeft <= 7) {
        return {
            level:   'warn',
            icon:    'fa-calendar-day',
            title:   `${periodName} ends in ${daysLeft} day${daysLeft !== 1 ? 's' : ''}`,
            message: `The grading period is closing soon. Check that grades are up to date before it ends.`,
            href
        };
    }

    // More than 7 days out → no notification
    return null;
}

/** Normalizes a date to local midnight so day math isn't skewed by time-of-day. */
function startOfDay(d) {
    return new Date(d.getFullYear(), d.getMonth(), d.getDate());
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
