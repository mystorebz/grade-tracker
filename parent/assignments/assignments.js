// ── PHASE 3 COMPLETION: PARENT ASSIGNMENTS (read-only mirror, current-reality statuses) ──
// The student audit (this mandate's own Step 1) confirmed there is no
// Missing/Overdue/Late concept anywhere in this codebase — only
// Not submitted / Submitted / Locked(teacher-manual) / Graded, decided by
// student/assignments/assignments.js's own statusPill() in this exact
// priority order: graded overrides everything, then locked, then plain
// submitted/not. This page shows the SAME four labels for the SAME
// reasons, just read-only and grouped for a parent's eye (Needs Attention /
// Submitted / Graded) instead of one flat list with a subject filter.
//
// Assignments live under schools/{schoolId}/classes/.../subjects/.../
// assignments — gated by isCallerInSchool(schoolId) in firestore.rules, a
// claim a parent's token never carries (a family can span more than one
// school). No rules-only grant can reach this data for a parent, so — same
// as the removed Class Stream callable, and mintParentToken/
// linkOrCreateParent/lookupParentByEmail before it — a dedicated read-only
// Cloud Function (getParentAssignments) does the fetch server-side and
// returns only already-resolved display fields, never raw class/subject
// documents a parent's token isn't scoped to read directly.
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
        // Date-only strings (YYYY-MM-DD) must be parsed as local calendar
        // components — new Date('YYYY-MM-DD') parses as UTC midnight, which
        // renders a day early in any timezone behind UTC. Same fix the
        // student portal's own formatDate() already applies.
        const d = /^\d{4}-\d{2}-\d{2}$/.test(iso)
            ? new Date(Number(iso.slice(0, 4)), Number(iso.slice(5, 7)) - 1, Number(iso.slice(8, 10)))
            : new Date(iso);
        return d.toLocaleDateString(undefined, { month: 'short', day: 'numeric', year: 'numeric' });
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

// Same three-question order statusPill() uses on the student side — graded
// first (it overrides locked/submitted entirely), then locked, then plain
// submitted/not — so a badge here never contradicts the student's own view
// of the same assignment. `category` decides which of the three sections a
// card lands in; `statusClass` is purely visual, and intentionally amber
// for anything Locked OR Not submitted — per this mandate, amber flags
// "needs a parent's attention or is out of the child's hands," so a card
// that lands in the Submitted section because it's Locked · Submitted
// still shows amber, not indigo.
function classify(a) {
    if (a.grade) {
        return { category: 'graded', statusClass: 'asg-status-graded' };
    }
    if (a.locked) {
        return { category: a.hasSubmission ? 'submitted' : 'attention', statusClass: 'asg-status-attention' };
    }
    return a.hasSubmission
        ? { category: 'submitted', statusClass: 'asg-status-submitted' }
        : { category: 'attention', statusClass: 'asg-status-attention' };
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
        ${a.date ? `<p class="a-due"><i class="fa-regular fa-calendar mr-1"></i>Due ${escHtml(formatDate(a.date))}</p>` : '<p class="a-due">No due date set</p>'}
        <span class="a-status ${cls.statusClass}">${escHtml(a.status)}</span>
    </div>`;
}

function renderEmpty(container, message) {
    container.innerHTML = `<div class="asg-empty-section">${escHtml(message)}</div>`;
}

function render(assignments) {
    // Soonest due date first; undated assignments sink to the bottom.
    const sorted = assignments.slice().sort((a, b) => {
        if (a.date && b.date) return a.date.localeCompare(b.date);
        if (a.date) return -1;
        if (b.date) return 1;
        return 0;
    });

    const buckets = { attention: [], submitted: [], graded: [] };
    sorted.forEach(a => {
        const cls = classify(a);
        buckets[cls.category].push(renderCard(a, cls));
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
