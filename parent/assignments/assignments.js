// ── DUE DATE & LATE TRACKING ENGINE: PARENT ASSIGNMENTS ──────────────────
// getParentAssignments (functions/index.js) now runs the full Google-
// Classroom-style state machine server-side (resolveAssignmentState there,
// the exact mirror of resolveDueDeadline()/statusPill() in
// student/assignments/assignments.js) and returns the already-resolved
// `status` label, `category` ('graded' | 'done' | 'todo' | 'missing'), and
// `late` flag, plus the raw `dueDate`/`submittedAt` this mandate asked for.
// This page's only job is to bucket those into sections and pick a badge
// color — it never re-derives Missing/Late from raw timestamps itself, so
// a parent and their child can never see contradictory statuses.
//
// Theming: per this mandate, amber is reserved specifically for "Missing"
// and "Locked · Not submitted" (both genuinely need a parent's attention);
// a plain "Assigned" item — not yet due — stays neutral so the page
// doesn't cry wolf before there's anything to worry about.
//
// Assignments live under schools/{schoolId}/classes/.../subjects/.../
// assignments — gated by isCallerInSchool(schoolId) in firestore.rules, a
// claim a parent's token never carries (a family can span more than one
// school). No rules-only grant can reach this data for a parent, so — same
// as the removed Class Stream callable, and mintParentToken/
// linkOrCreateParent/lookupParentByEmail before it — a dedicated read-only
// Cloud Function (getParentAssignments) does the fetch AND the status
// resolution server-side, returning only already-resolved display fields,
// never raw class/subject documents a parent's token isn't scoped to read.
import { functions } from '../../assets/js/firebase-init.js';
import { httpsCallable } from "https://www.gstatic.com/firebasejs/10.7.1/firebase-functions.js";
import { requireAuth } from '../../assets/js/auth.js';
import { injectParentLayout, getActiveChild } from '../layout-parent.js';

const session = requireAuth('parent', '../../student/login.html');
const activeChild = session ? getActiveChild(session) : null;
const studentId = activeChild?.studentId || null;

injectParentLayout('assignments', 'Assignments', "A read-only mirror of your child's assignment list");

const getParentAssignmentsFn = httpsCallable(functions, 'getParentAssignments');

const els = {};

function escHtml(str) {
    if (!str) return '';
    return String(str)
        .replace(/&/g, '&amp;')
        .replace(/</g, '&lt;')
        .replace(/>/g, '&gt;')
        .replace(/"/g, '&quot;')
        .replace(/'/g, '&#039;');
}

function formatDate(iso) {
    if (!iso) return '';
    try {
        const isDateOnly = /^\d{4}-\d{2}-\d{2}$/.test(iso);
        // Date-only strings (YYYY-MM-DD — every due date saved before the
        // due-date-&-time engine) must be parsed as local calendar
        // components — new Date('YYYY-MM-DD') parses as UTC midnight, which
        // renders a day early in any timezone behind UTC. A full ISO
        // datetime string (a due date saved with a time) now also shows
        // its time-of-day.
        const d = isDateOnly
            ? new Date(Number(iso.slice(0, 4)), Number(iso.slice(5, 7)) - 1, Number(iso.slice(8, 10)))
            : new Date(iso);
        return isDateOnly
            ? d.toLocaleDateString(undefined, { month: 'short', day: 'numeric', year: 'numeric' })
            : d.toLocaleString(undefined, { month: 'short', day: 'numeric', year: 'numeric', hour: 'numeric', minute: '2-digit' });
    } catch (e) { return iso; }
}

function cacheEls() {
    ['asgLoader', 'asgError', 'asgContent', 'asgSummary',
     'cntAttention', 'cntSubmitted', 'cntGraded',
     'listAttention', 'listSubmitted', 'listGraded'
    ].forEach(id => { els[id] = document.getElementById(id); });
}

function showFatalError(message) {
    els.asgLoader.classList.add('hidden');
    els.asgError.innerHTML = `<i class="fa-solid fa-clipboard-list"></i>${escHtml(message)}`;
    els.asgError.classList.remove('hidden');
}

// Sections mirror the server's `category` field: 'graded' -> Graded,
// 'done' -> Submitted (covers Done, Done Late, and Locked · Submitted),
// and 'todo'/'missing' both land in Needs Attention (Assigned isn't urgent
// yet, but it also isn't Submitted or Graded, so it has nowhere else
// honest to go) — the badge color is what actually signals urgency within
// that section: amber for Missing and Locked · Not submitted, neutral for
// a plain Assigned that isn't due yet.
function classify(a) {
    if (a.category === 'graded') {
        return { section: 'graded', statusClass: 'asg-status-graded' };
    }
    if (a.category === 'done') {
        return { section: 'submitted', statusClass: a.late ? 'asg-status-attention' : 'asg-status-submitted' };
    }
    const needsAttention = a.category === 'missing' || a.status === 'Locked · Not submitted';
    return { section: 'attention', statusClass: needsAttention ? 'asg-status-attention' : 'asg-status-neutral' };
}

function renderCard(a, cls) {
    return `
    <div class="asg-card">
        <p class="a-title">${escHtml(a.title)}</p>
        <div class="a-tags">
            ${a.subjectName ? `<span class="a-tag">${escHtml(a.subjectName)}</span>` : ''}
            <span class="a-tag">${escHtml(a.type)}</span>
            <span class="a-tag">/ ${a.maxScore}</span>
        </div>
        ${a.dueDate ? `<p class="a-due"><i class="fa-regular fa-calendar mr-1"></i>Due ${escHtml(formatDate(a.dueDate))}</p>` : '<p class="a-due">No due date set</p>'}
        <span class="a-status ${cls.statusClass}">${escHtml(a.status)}</span>
    </div>`;
}

function renderEmpty(container, message) {
    container.innerHTML = `<div class="asg-empty-section">${escHtml(message)}</div>`;
}

function render(assignments) {
    // Soonest due date first; undated assignments sink to the bottom.
    const sorted = assignments.slice().sort((a, b) => {
        if (a.dueDate && b.dueDate) return a.dueDate.localeCompare(b.dueDate);
        if (a.dueDate) return -1;
        if (b.dueDate) return 1;
        return 0;
    });

    const buckets = { attention: [], submitted: [], graded: [] };
    sorted.forEach(a => {
        const cls = classify(a);
        buckets[cls.section].push(renderCard(a, cls));
    });

    els.cntAttention.textContent = buckets.attention.length;
    els.cntSubmitted.textContent = buckets.submitted.length;
    els.cntGraded.textContent = buckets.graded.length;

    if (buckets.attention.length) els.listAttention.innerHTML = buckets.attention.join('');
    else renderEmpty(els.listAttention, 'Nothing needs attention right now.');

    if (buckets.submitted.length) els.listSubmitted.innerHTML = buckets.submitted.join('');
    else renderEmpty(els.listSubmitted, 'Nothing submitted yet.');

    if (buckets.graded.length) els.listGraded.innerHTML = buckets.graded.join('');
    else renderEmpty(els.listGraded, 'Nothing graded yet.');

    els.asgSummary.textContent = `${sorted.length} assignment${sorted.length === 1 ? '' : 's'} on record.`;
}

function renderAllEmpty(message) {
    renderEmpty(els.listAttention, 'Nothing needs attention right now.');
    renderEmpty(els.listSubmitted, 'Nothing submitted yet.');
    renderEmpty(els.listGraded, 'Nothing graded yet.');
    els.cntAttention.textContent = '0';
    els.cntSubmitted.textContent = '0';
    els.cntGraded.textContent = '0';
    els.asgSummary.textContent = message;
}

async function init() {
    if (!session) return;
    cacheEls();

    if (!studentId) {
        showFatalError('No student is linked to your account yet — contact your school to get linked.');
        return;
    }

    try {
        const result = await getParentAssignmentsFn({ studentId });
        const assignments = result?.data?.assignments || [];

        els.asgLoader.classList.add('hidden');
        els.asgContent.classList.remove('hidden');

        if (!assignments.length) {
            renderAllEmpty("No assignments have been prepared for this student's class yet.");
            return;
        }

        render(assignments);
    } catch (e) {
        console.error('[Parent Assignments] init:', e);
        showFatalError('Something went wrong loading assignments. Please try again later.');
    }
}

init();
