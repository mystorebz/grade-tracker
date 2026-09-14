// ── PHASE 3 STEP 4: PARENT DASHBOARD (global analytics hub) ──────────────
// Replaces the old per-child card picker (child selection now lives in the
// persistent sidebar's Student Selector — parent/layout-parent.js) with a
// global feed across every linked child: an Alerts section (recent
// absences/tardies, amber) and a Live Feed of recently graded items,
// merged and sorted across all children rather than split per-student.
//
// SCOPE NOTE: a "missing assignment" alert is deliberately NOT included
// here. Live assignment data lives under
// schools/{schoolId}/classes/{classId}/subjects/{subjectId}/assignments,
// gated by firestore.rules' isCallerInSchool() (a schoolId token claim a
// parent's token never carries — a parent has no schoolId of their own
// since one family can span multiple schools). Reaching it needs a
// server-side callable, the same architecture Attendance and the (now
// removed) Class Stream needed — that is a separate, not-yet-built piece
// flagged back to whoever is running this mandate, not something this
// page can safely fake with a client-side read.
import { db } from '../../assets/js/firebase-init.js';
import { collection, doc, getDoc, getDocs, query, where }
    from "https://www.gstatic.com/firebasejs/10.7.1/firebase-firestore.js";
import { requireAuth } from '../../assets/js/auth.js';
import { injectParentLayout } from '../layout-parent.js';
import { loadAttendanceHistoryForStudent } from '../../assets/js/attendance.js';

const session = requireAuth('parent', '../../student/login.html');
injectParentLayout('dashboard', 'Dashboard', 'Overview across all your children');

const els = {};
const ALERT_WINDOW_DAYS = 14;
const FEED_LIMIT = 20;

function escHtml(str) {
    if (!str) return '';
    return String(str)
        .replace(/&/g, '&amp;')
        .replace(/</g, '&lt;')
        .replace(/>/g, '&gt;')
        .replace(/"/g, '&quot;')
        .replace(/'/g, '&#039;');
}

function pad2(n) { return String(n).padStart(2, '0'); }
function ymd(d) { return `${d.getFullYear()}-${pad2(d.getMonth() + 1)}-${pad2(d.getDate())}`; }

function cacheEls() {
    ['dashLoader', 'dashError', 'dashContent', 'alertsList', 'feedList']
        .forEach(id => { els[id] = document.getElementById(id); });
}

function showFatalError(message) {
    els.dashLoader.classList.add('hidden');
    els.dashError.textContent = message;
    els.dashError.classList.remove('hidden');
}

function formatRelativeDate(iso) {
    if (!iso) return '';
    try {
        const d = new Date(iso);
        return d.toLocaleDateString(undefined, { month: 'short', day: 'numeric' });
    } catch (e) { return iso; }
}

// ── 1. RESOLVE LINKED CHILDREN ───────────────────────────────────────────
async function loadChildren() {
    const linked = Array.isArray(session.linkedStudents) ? session.linkedStudents : [];
    if (!linked.length) return [];

    const schoolIds = [...new Set(linked.map(l => l.schoolId).filter(Boolean))];
    const [studentSnaps, schoolSnaps] = await Promise.all([
        Promise.all(linked.map(l => getDoc(doc(db, 'students', l.studentId)))),
        Promise.all(schoolIds.map(id => getDoc(doc(db, 'schools', id))))
    ]);

    const schoolNameById = {};
    schoolSnaps.forEach((snap, i) => {
        schoolNameById[schoolIds[i]] = snap.exists() ? (snap.data().schoolName || '') : '';
    });

    return studentSnaps.map((snap, i) => {
        const link = linked[i];
        if (!snap.exists()) {
            return { studentId: link.studentId, schoolId: link.schoolId, name: 'Student record unavailable', className: '', schoolName: schoolNameById[link.schoolId] || '' };
        }
        const data = snap.data();
        return {
            studentId: snap.id,
            schoolId: link.schoolId,
            name: data.name || 'Student',
            className: data.className || '',
            schoolName: schoolNameById[link.schoolId] || ''
        };
    });
}

// ── 2. ALERTS — recent absences/tardies across all children ─────────────
async function loadAlertsForChild(child) {
    const end = new Date();
    const start = new Date();
    start.setDate(start.getDate() - ALERT_WINDOW_DAYS);

    try {
        const history = await loadAttendanceHistoryForStudent(child.schoolId, '', child.studentId, ymd(start), ymd(end));
        return history
            .filter(h => h.status === 'absent' || h.status === 'tardy')
            .map(h => ({ ...h, childName: child.name }));
    } catch (e) {
        console.error('[Parent Dashboard] loadAlertsForChild:', child.studentId, e);
        return [];
    }
}

function renderAlertCard(alert) {
    const isAbsent = alert.status === 'absent';
    const icon = isAbsent ? 'fa-calendar-xmark' : 'fa-clock';
    const label = isAbsent ? 'Absent' : 'Tardy';
    return `
    <div class="pd-alert-card">
        <div class="pd-alert-icon"><i class="fa-solid ${icon}"></i></div>
        <div>
            <p class="pd-alert-text">${escHtml(alert.childName)} was marked ${label.toLowerCase()}</p>
            <p class="pd-alert-meta">${escHtml(formatRelativeDate(alert.date))}</p>
        </div>
    </div>`;
}

// ── 3. LIVE FEED — recently graded items across all children ────────────
async function loadFeedForChild(child) {
    try {
        const snap = await getDocs(query(
            collection(db, 'students', child.studentId, 'grades'),
            where('schoolId', '==', child.schoolId)
        ));
        return snap.docs
            .map(d => ({ id: d.id, ...d.data() }))
            .filter(g => g.createdAt)
            .sort((a, b) => (b.createdAt || '').localeCompare(a.createdAt || ''))
            .slice(0, 5)
            .map(g => ({ ...g, childName: child.name }));
    } catch (e) {
        console.error('[Parent Dashboard] loadFeedForChild:', child.studentId, e);
        return [];
    }
}

function scoreColor(pct) {
    if (pct === null) return '#94a3b8';
    if (pct >= 90) return '#15803d';
    if (pct >= 80) return '#1d4ed8';
    if (pct >= 70) return '#0f766e';
    if (pct >= 65) return '#92400e';
    return '#991b1b';
}

function renderFeedCard(g) {
    const pct = (typeof g.score === 'number' && typeof g.max === 'number' && g.max > 0)
        ? Math.round((g.score / g.max) * 100) : null;
    return `
    <div class="pd-feed-card">
        <div class="pd-feed-left">
            <div class="pd-feed-icon"><i class="fa-solid fa-file-circle-check"></i></div>
            <div class="min-w-0">
                <p class="pd-feed-title">${escHtml(g.title || g.subject || 'Graded item')}</p>
                <p class="pd-feed-meta">${escHtml(g.childName)} &middot; ${escHtml(g.subject || '')} &middot; ${escHtml(formatRelativeDate(g.createdAt))}</p>
            </div>
        </div>
        <span class="pd-feed-score" style="color:${scoreColor(pct)}">${pct !== null ? pct + '%' : (g.score ?? '—')}</span>
    </div>`;
}

// ── 4. INIT ───────────────────────────────────────────────────────────────
async function init() {
    if (!session) return;
    cacheEls();

    try {
        const children = await loadChildren();

        if (!children.length) {
            showFatalError("No students are linked to your account yet. Contact your child's school to have your account linked.");
            return;
        }

        const [alertLists, feedLists] = await Promise.all([
            Promise.all(children.map(loadAlertsForChild)),
            Promise.all(children.map(loadFeedForChild))
        ]);

        const alerts = alertLists.flat().sort((a, b) => (b.date || '').localeCompare(a.date || ''));
        const feed = feedLists.flat()
            .sort((a, b) => (b.createdAt || '').localeCompare(a.createdAt || ''))
            .slice(0, FEED_LIMIT);

        els.dashLoader.classList.add('hidden');
        els.dashContent.classList.remove('hidden');

        els.alertsList.innerHTML = alerts.length
            ? alerts.map(renderAlertCard).join('')
            : `<div class="pd-empty">No absences or tardies in the last ${ALERT_WINDOW_DAYS} days. Nice!</div>`;

        els.feedList.innerHTML = feed.length
            ? feed.map(renderFeedCard).join('')
            : `<div class="pd-empty">No recently graded items yet.</div>`;
    } catch (e) {
        console.error('[Parent Dashboard] init:', e);
        showFatalError('Something went wrong loading your dashboard. Please try again later.');
    }
}

init();
