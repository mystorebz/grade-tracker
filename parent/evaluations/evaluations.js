// ── PHASE 3 STEP 3: PARENT EVALUATIONS (read-only) ───────────────────────
// A read-only view of students/{studentId}/evaluations, newly readable by a
// linked parent as of Phase 3 Step 2's firestore.rules change (previously
// this collection had no parent grant at all). Mirrors the type→label/badge
// mapping teacher/roster/roster.js's own window.loadStudentEvaluations
// already uses, for visual consistency with the teacher-facing summary
// list — but unlike that summary-only list, this page also renders the
// full ratings + written notes inline, since "a read-only view of teacher
// rubrics/notes" (Phase 3 Step 3's own wording) is the entire point of this
// page existing, not just a card a parent has to guess the contents of.
// Active child comes from the sidebar's Student Selector (parent/layout-
// parent.js's getActiveChild), same convention as parent/view/view.js.
import { db } from '../../assets/js/firebase-init.js';
import { collection, getDocs, query, where }
    from "https://www.gstatic.com/firebasejs/10.7.1/firebase-firestore.js";
import { requireAuth } from '../../assets/js/auth.js';
import { injectParentLayout, getActiveChild } from '../layout-parent.js';

const session = requireAuth('parent', '../../student/login.html');
const activeChild = session ? getActiveChild(session) : null;
const studentId = activeChild?.studentId || null;
const schoolId = activeChild?.schoolId || null;

injectParentLayout('evaluations', 'Evaluations', 'Read-only teacher rubrics and notes');

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

function prettyLabel(key) {
    return String(key || '')
        .replace(/([a-z0-9])([A-Z])/g, '$1 $2')
        .replace(/^./, c => c.toUpperCase());
}

function starString(val) {
    const n = Math.max(0, Math.min(5, parseInt(val) || 0));
    return '★'.repeat(n) + '☆'.repeat(5 - n);
}

function cacheEls() {
    ['viewLoader', 'viewError', 'evalEmpty', 'evalList'].forEach(id => { els[id] = document.getElementById(id); });
}

function showFatalError(message) {
    els.viewLoader.classList.add('hidden');
    els.viewError.textContent = message;
    els.viewError.classList.remove('hidden');
}

// Same type→(badgeStyle,typeLabel,highlightText) mapping as
// teacher/roster/roster.js's window.loadStudentEvaluations, kept in sync
// deliberately so a parent sees the same category names/colors a teacher
// or admin does for the same evaluation.
function classifyEval(ev) {
    let badgeStyle = '', typeLabel = '', highlightText = '';
    if (ev.type === 'academic') {
        badgeStyle = 'background:#eff6ff;color:#1d4ed8;border:1px solid #bfdbfe;'; typeLabel = 'Academic Progress';
    } else if (ev.type === 'academic_report_card') {
        const isM = ev.reportCardType === 'midterm';
        badgeStyle = isM ? 'background:#f5f3ff;color:#6d28d9;border:1px solid #ddd6fe;' : 'background:#edf7f1;color:#065f46;border:1px solid #a7f3d0;';
        typeLabel = isM ? 'Midterm Report Card' : 'Report Card';
    } else if (ev.type === 'end_of_year') {
        badgeStyle = 'background:#fef3c7;color:#b45309;border:1px solid #fde68a;'; typeLabel = 'Comprehensive End-of-Year';
        highlightText = ev.status ? `<div class="ev-highlight"><i class="fa-solid fa-award" style="color:#f59e0b;margin-right:5px;"></i> Status: ${escHtml(ev.status)}</div>` : '';
    } else if (ev.type === 'behavioral') {
        badgeStyle = 'background:#fef2f2;color:#b91c1c;border:1px solid #fecaca;'; typeLabel = 'Behavioral & Conduct Intervention';
        highlightText = ev.status && ev.status !== 'No Action' ? `<div class="ev-highlight" style="color:#be1240;background:#fff0f3;"><i class="fa-solid fa-triangle-exclamation" style="margin-right:5px;"></i> Action: ${escHtml(ev.status)}</div>` : '';
    } else if (ev.type === 'midterm_review') {
        badgeStyle = 'background:#f0f9ff;color:#0369a1;border:1px solid #bae6fd;'; typeLabel = 'Mid-Term Review';
    } else if (ev.type === 'parent_conference') {
        badgeStyle = 'background:#f5f3ff;color:#6d28d9;border:1px solid #ddd6fe;'; typeLabel = 'Parent Conference';
        highlightText = ev.parentPresent ? `<div class="ev-highlight">Parent present: ${escHtml(ev.parentPresent)}</div>` : '';
    } else if (ev.type === 'learning_support') {
        badgeStyle = 'background:#fdf4ff;color:#9333ea;border:1px solid #e9d5ff;'; typeLabel = 'Learning Support Plan';
        highlightText = ev.supportLevel ? `<div class="ev-highlight">Support level: ${escHtml(ev.supportLevel)}</div>` : '';
    } else if (ev.type === 'custom') {
        badgeStyle = 'background:#f8fafc;color:#475569;border:1px solid #cbd5e1;'; typeLabel = ev.customTypeName || 'Custom Evaluation';
    } else {
        badgeStyle = 'background:#f8fafc;color:#475569;border:1px solid #cbd5e1;'; typeLabel = ev.type || 'Evaluation';
    }
    return { badgeStyle, typeLabel, highlightText };
}

function renderRatings(ratings) {
    if (!ratings || !Object.keys(ratings).length) return '';
    return `<div class="ev-ratings">${Object.entries(ratings).map(([k, v]) => `
        <div class="ev-rating-row">
            <span class="ev-rating-label">${escHtml(prettyLabel(k))}</span>
            <span class="ev-rating-stars">${starString(v)}</span>
        </div>`).join('')}</div>`;
}

function renderWritten(written) {
    if (!written || !Object.keys(written).length) return '';
    const parts = Object.entries(written)
        .filter(([, v]) => v)
        .map(([k, v]) => `<p class="ev-written"><strong>${escHtml(prettyLabel(k))}:</strong> ${escHtml(v)}</p>`);
    return parts.join('');
}

function renderEvalCard(ev) {
    const { badgeStyle, typeLabel, highlightText } = classifyEval(ev);
    const attendanceLine = ev.attendance
        ? `<p class="ev-meta">Days absent: ${escHtml(ev.attendance.daysAbsent ?? 0)} &middot; Days late: ${escHtml(ev.attendance.daysLate ?? 0)}</p>`
        : '';
    return `
    <div class="ev-card">
        <div>
            <span class="ev-badge" style="${badgeStyle}">${escHtml(typeLabel)}</span>
            <h4 class="ev-title">${escHtml(ev.semesterName || '')}</h4>
            <p class="ev-meta">Filed by ${escHtml(ev.teacherName || 'a teacher')} on ${escHtml(ev.date || '')}</p>
            ${attendanceLine}
        </div>
        ${highlightText}
        ${renderRatings(ev.ratings)}
        ${renderWritten(ev.written)}
    </div>`;
}

async function init() {
    if (!session) return;
    cacheEls();

    if (!studentId || !schoolId) {
        showFatalError('No student is linked to your account yet — contact your school to get linked.');
        return;
    }

    try {
        const snap = await getDocs(query(
            collection(db, 'students', studentId, 'evaluations'),
            where('schoolId', '==', schoolId)
        ));
        const evaluations = snap.docs.map(d => ({ id: d.id, ...d.data() }));
        evaluations.sort((a, b) => new Date(b.date || 0) - new Date(a.date || 0));

        els.viewLoader.classList.add('hidden');

        if (!evaluations.length) {
            els.evalEmpty.classList.remove('hidden');
            return;
        }

        els.evalList.innerHTML = evaluations.map(renderEvalCard).join('');
    } catch (e) {
        console.error('[Parent Evaluations] init:', e);
        showFatalError('Something went wrong loading evaluations. Please try again later.');
    }
}

init();
