// ── PHASE 3 STEP 4: PARENT DASHBOARD (global analytics hub) ──────────────
// PHASE 2 (Dashboard Analytics & Parent Portal "Mirror" Sync mandate): the
// empty space above the Alerts/Live Feed is now three KPI widgets scoped
// to the sidebar's active child (parent/layout-parent.js's Student
// Selector / getActiveChild()) — Current Overall Average, a Subject
// Breakdown, and a Missing Work alert badge. These are computed the exact
// same way the Parent's own mirrored Grades and Assignments pages compute
// them for that child (assets/js/render-grades.js's overall-average logic;
// assets/js/submissions.js's shared resolveAssignmentStatus() for
// "missing"), not a third, separately-invented calculation.
//
// The pre-existing "Recently Graded" live feed and Alerts section — merged
// across ALL linked children, unrelated to the single active child above —
// are UNCHANGED in logic, only repositioned beneath the KPIs as a
// secondary Activity Log per this mandate's own framing.
//
// MISSING WORK NOTE: an earlier version of this file carried a scope note
// saying assignment data wasn't reachable client-side for a parent. That
// was true when this file was first written, before firestore.rules
// granted a linked parent GET/LIST on schools/{schoolId}/classes and its
// subjects/assignments subcollections (isParentLinkedToSchool) — the same
// grant parent/assignments/assignments.js already relies on. That
// blocker no longer applies, so Missing Work is now computed for real.
import { db } from '../../assets/js/firebase-init.js';
import { collection, doc, getDoc, getDocs, query, where }
    from "https://www.gstatic.com/firebasejs/10.7.1/firebase-firestore.js";
import { requireAuth } from '../../assets/js/auth.js';
import { injectParentLayout, getActiveChild } from '../layout-parent.js';
import { loadAttendanceHistoryForStudent } from '../../assets/js/attendance.js';
import { calculateWeightedAverage, resolveGradeWeights, loadTeacherSubjectsCache, getTeacherDocRef } from '../../assets/js/utils.js';
import {
    loadAssignmentsForSubjects,
    loadSubmissionsForAssignments,
    loadGradesIndexForStudent,
    resolveAssignmentStatus
} from '../../assets/js/submissions.js';

const session = requireAuth('parent', '../../student/login.html');
const activeChild = session ? getActiveChild(session) : null;
injectParentLayout('dashboard', 'Dashboard', "Your active child's overview, plus activity across every linked student");

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
    ['dashLoader', 'dashError', 'dashContent', 'alertsList', 'feedList',
     'kpiLoader', 'kpiError', 'kpiSection', 'kpiSectionLabel',
     'kpiOverallAvg', 'kpiOverallSub', 'kpiMissingBadge', 'kpiMissingText', 'subjectBreakdownList'
    ].forEach(id => { els[id] = document.getElementById(id); });
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

// ── PHASE 2: KPI WIDGETS (active child only) ─────────────────────────────
function gradeStyleColor(pct) {
    if (pct === null) return '#94a3b8';
    if (pct >= 90) return '#059669';
    if (pct >= 80) return '#2563eb';
    if (pct >= 70) return '#0d9488';
    if (pct >= 65) return '#d97706';
    return '#dc2626';
}

function showKpiError(message) {
    els.kpiLoader.classList.add('hidden');
    els.kpiSection.classList.add('hidden');
    els.kpiError.textContent = message;
    els.kpiError.classList.remove('hidden');
}

// Mirrors assets/js/render-grades.js's own loadGrades()/overall-average
// computation for one child — same weighted-average helper, same
// per-subject grouping — so a parent never sees a different number here
// than on the mirrored Current Grades page for the same child.
async function loadOverviewKpis(child) {
    const [studentSnap, schoolSnap] = await Promise.all([
        getDoc(doc(db, 'students', child.studentId)),
        getDoc(doc(db, 'schools', child.schoolId)),
    ]);
    if (!studentSnap.exists()) return null;

    const studentData = studentSnap.data();
    const schoolData = schoolSnap.exists() ? schoolSnap.data() : {};
    const semId = schoolData.activeSemesterId;
    const childName = studentData.name || 'Student';

    if (!semId) {
        return { childName, semesterName: null, overall: null, subjectBreakdown: [], missingCount: null };
    }

    const teacherId = studentData.teacherId || null;

    const [semSnap, tSnap, gSnap] = await Promise.all([
        getDoc(doc(db, 'schools', child.schoolId, 'semesters', semId)),
        teacherId ? getDoc(getTeacherDocRef(child.schoolId, teacherId)) : Promise.resolve(null),
        getDocs(query(
            collection(db, 'students', child.studentId, 'grades'),
            where('schoolId', '==', child.schoolId),
            where('semesterId', '==', semId)
        ))
    ]);

    const semesterName = semSnap.exists() ? (semSnap.data().name || 'Current Period') : 'Current Period';

    let legacyTeacherData = null;
    let teacherRubric = [];
    if (tSnap && tSnap.exists()) {
        legacyTeacherData = tSnap.data();
        try {
            teacherRubric = await resolveGradeWeights(child.schoolId, teacherId, { legacyTeacherData }) || [];
        } catch (e) {
            console.error('[Parent Dashboard] resolveGradeWeights:', e);
        }
    }

    const grades = gSnap.docs.map(d => ({ id: d.id, ...d.data() }));
    const bySub = {};
    grades.forEach(g => {
        const sub = g.subject || 'Uncategorized';
        if (!bySub[sub]) bySub[sub] = [];
        bySub[sub].push(g);
    });

    const subjectBreakdown = Object.entries(bySub).map(([subject, gs]) => {
        const avg = calculateWeightedAverage(gs, teacherRubric);
        return { subject, avg: avg !== null ? Math.round(avg) : null, count: gs.length };
    }).sort((a, b) => (b.avg ?? -1) - (a.avg ?? -1));

    let totalAvg = 0, subCount = 0;
    subjectBreakdown.forEach(s => { if (s.avg !== null) { totalAvg += s.avg; subCount++; } });
    const overall = subCount > 0 ? Math.round(totalAvg / subCount) : null;

    // Missing Work — same shared resolveAssignmentStatus() the mirrored
    // Assignments page uses, over the same assignment/submission/grade
    // load path (assets/js/submissions.js + loadTeacherSubjectsCache()).
    let missingCount = null;
    try {
        if (teacherId) {
            const { subjectsCache, resolvedClasses } = await loadTeacherSubjectsCache(child.schoolId, teacherId, legacyTeacherData);
            const assignments = loadAssignmentsForSubjects(subjectsCache, resolvedClasses)
                .filter(a => a.status !== 'draft')
                .map(a => ({ ...a, date: a.dueDate || a.date || '' }));

            if (assignments.length) {
                const [subMap, gradeMap] = await Promise.all([
                    loadSubmissionsForAssignments(child.schoolId, assignments, child.studentId),
                    loadGradesIndexForStudent(child.schoolId, child.studentId)
                ]);
                missingCount = assignments.reduce((count, a) => {
                    const submission = subMap.get(a.id) || null;
                    const grade = gradeMap.get(a.id) || null;
                    const { category } = resolveAssignmentStatus({
                        grade, locked: !!a.locked, hasSubmission: !!submission,
                        submittedAt: submission?.submittedAt, dueDate: a.date,
                    });
                    return category === 'missing' ? count + 1 : count;
                }, 0);
            } else {
                missingCount = 0;
            }
        }
    } catch (e) {
        console.error('[Parent Dashboard] missing-work computation:', e);
    }

    return { childName, semesterName, overall, subjectBreakdown, missingCount };
}

function renderSubjectBreakdownRow(s) {
    const color = gradeStyleColor(s.avg);
    const pctLabel = s.avg !== null ? `${s.avg}%` : '—';
    const width = s.avg !== null ? Math.min(s.avg, 100) : 0;
    return `
    <div class="sb-row">
        <span class="sb-name">${escHtml(s.subject)}<span class="sb-count">${s.count} ${s.count !== 1 ? 'entries' : 'entry'}</span></span>
        <div class="sb-bar-track"><div class="sb-bar-fill" style="width:${width}%;background:${color};"></div></div>
        <span class="sb-pct" style="color:${color};">${pctLabel}</span>
    </div>`;
}

function renderKpis(kpi) {
    els.kpiSectionLabel.textContent = `${kpi.childName}'s Overview${kpi.semesterName ? ' · ' + kpi.semesterName : ''}`;

    if (kpi.overall !== null) {
        els.kpiOverallAvg.textContent = `${kpi.overall}%`;
        els.kpiOverallAvg.style.color = gradeStyleColor(kpi.overall);
        els.kpiOverallSub.textContent = `Across ${kpi.subjectBreakdown.length} subject${kpi.subjectBreakdown.length !== 1 ? 's' : ''} this period.`;
    } else {
        els.kpiOverallAvg.textContent = '—';
        els.kpiOverallAvg.style.color = '#94a3b8';
        els.kpiOverallSub.textContent = 'No grades recorded yet this period.';
    }

    if (kpi.missingCount === null) {
        els.kpiMissingBadge.style.background = '#f1f5f9';
        els.kpiMissingBadge.style.color = '#64748b';
        els.kpiMissingText.textContent = 'Unavailable';
    } else if (kpi.missingCount === 0) {
        els.kpiMissingBadge.style.background = '#ecfdf5';
        els.kpiMissingBadge.style.color = '#047857';
        els.kpiMissingBadge.querySelector('i').className = 'fa-solid fa-circle-check';
        els.kpiMissingText.textContent = 'Nothing missing';
    } else {
        els.kpiMissingBadge.style.background = '#fef2f2';
        els.kpiMissingBadge.style.color = '#b91c1c';
        els.kpiMissingBadge.querySelector('i').className = 'fa-solid fa-triangle-exclamation';
        els.kpiMissingText.textContent = `${kpi.missingCount} assignment${kpi.missingCount !== 1 ? 's' : ''} missing`;
    }

    els.subjectBreakdownList.innerHTML = kpi.subjectBreakdown.length
        ? kpi.subjectBreakdown.map(renderSubjectBreakdownRow).join('')
        : `<p class="text-[12.5px] text-slate-400 font-semibold text-center py-4 m-0">No subjects graded yet this period.</p>`;

    els.kpiLoader.classList.add('hidden');
    els.kpiSection.classList.remove('hidden');
}

async function initKpis() {
    if (!activeChild) {
        showKpiError("No student is linked to your account yet — contact your school to get linked.");
        return;
    }
    try {
        const kpi = await loadOverviewKpis(activeChild);
        if (!kpi) {
            showKpiError('Student record not found.');
            return;
        }
        renderKpis(kpi);
    } catch (e) {
        console.error('[Parent Dashboard] initKpis:', e);
        showKpiError("Something went wrong loading your child's overview. Please try again later.");
    }
}

// ── 1. RESOLVE LINKED CHILDREN (Activity Log — unchanged) ────────────────
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

// ── 2. ALERTS — recent absences/tardies across all children (unchanged) ──
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

// ── 3. LIVE FEED — recently graded items across all children (unchanged,
//    per this mandate now labeled "Recently Graded" and repositioned as a
//    secondary Activity Log beneath the KPI widgets above) ───────────────
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
        <span class="pd-feed-score" style="color:${gradeStyleColor(pct)}">${pct !== null ? pct + '%' : (g.score ?? '—')}</span>
    </div>`;
}

// ── 4. INIT ───────────────────────────────────────────────────────────────
async function initActivityLog() {
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
        console.error('[Parent Dashboard] initActivityLog:', e);
        showFatalError('Something went wrong loading your dashboard. Please try again later.');
    }
}

async function init() {
    if (!session) return;
    cacheEls();
    await Promise.all([initKpis(), initActivityLog()]);
}

init();
