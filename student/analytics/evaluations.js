import { db } from '../../assets/js/firebase-init.js';
import { collection, getDocs, doc, getDoc } from "https://www.gstatic.com/firebasejs/10.7.1/firebase-firestore.js";
import { requireAuth } from '../../assets/js/auth.js';
import { injectStudentLayout } from '../../assets/js/layout-student.js';

// ── 1. AUTH & LAYOUT ──────────────────────────────────────────────────────
const session = requireAuth('student', '../login.html');
injectStudentLayout('analytics', 'Performance Evaluations', 'Official evaluations filed by your teacher');

// ── 2. STATE ─────────────────────────────────────────────────────────────
let allSemesters = [];
let allEvals     = [];
let schoolData   = {};

// ── 3. HELPERS ────────────────────────────────────────────────────────────
function esc(s) {
    return String(s || '').replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/"/g,'&quot;');
}

// Average all numeric ratings in an eval
function evalAvgRating(e) {
    if (!e.ratings) return null;
    const vals = Object.values(e.ratings).map(Number).filter(v => !isNaN(v) && v > 0);
    if (!vals.length) return null;
    return (vals.reduce((a,b) => a+b, 0) / vals.length);
}

// Color from 1-5 rating
function ratingColor(v) {
    if (v >= 4.5) return { color:'#059669', bg:'#d1fae5', border:'#6ee7b7' };
    if (v >= 3.5) return { color:'#2563eb', bg:'#dbeafe', border:'#93c5fd' };
    if (v >= 2.5) return { color:'#d97706', bg:'#fef3c7', border:'#fcd34d' };
    return             { color:'#dc2626', bg:'#fee2e2', border:'#fca5a5' };
}

// Rating bar fill color
function barColor(v) {
    if (v >= 4) return '#10b981';
    if (v >= 3) return '#3b82f6';
    if (v >= 2) return '#f59e0b';
    return '#ef4444';
}

// Type config: label, icon, badge colors
function typeConfig(type) {
    const map = {
        academic:             { label:'Academic Progress',     icon:'fa-book-open',           bg:'#eef2ff', color:'#4338ca', border:'#c7d2fe', ringBg:'#eef2ff', ringColor:'#4338ca' },
        behavioral:           { label:'Conduct & Behaviour',   icon:'fa-triangle-exclamation', bg:'#fff0f3', color:'#be123c', border:'#fda4af', ringBg:'#fff0f3', ringColor:'#be123c' },
        end_of_year:          { label:'End-of-Year Summary',   icon:'fa-award',               bg:'#fffbeb', color:'#b45309', border:'#fde68a', ringBg:'#fffbeb', ringColor:'#b45309' },
        academic_report_card: { label:'Report Card Evaluation',icon:'fa-file-contract',       bg:'#f0fdf4', color:'#15803d', border:'#bbf7d0', ringBg:'#f0fdf4', ringColor:'#15803d' }
    };
    return map[type] || { label:'Evaluation', icon:'fa-clipboard', bg:'#f8fafc', color:'#475569', border:'#e2e8f0', ringBg:'#f8fafc', ringColor:'#475569' };
}

// Build a rating row for the ratings panel
function ratingRow(label, val) {
    const v   = Number(val) || 0;
    const pct = (v / 5) * 100;
    const col = barColor(v);
    return `
    <div class="ev-rating-row">
        <div class="ev-rating-top">
            <span class="ev-rating-label">${esc(label)}</span>
            <span class="ev-rating-val">${v}/5</span>
        </div>
        <div class="ev-rating-bar">
            <div class="ev-rating-fill" style="width:${pct}%;background:${col};"></div>
        </div>
    </div>`;
}

// ── 4. LOAD ───────────────────────────────────────────────────────────────
async function init() {
    const loader  = document.getElementById('analyticsLoader');
    const content = document.getElementById('analyticsContent');

    try {
        document.getElementById('displayStudentName').innerText  = session.studentData.name || 'Student';
        document.getElementById('studentAvatar').innerText       = (session.studentData.name || 'S').charAt(0).toUpperCase();
        document.getElementById('displayStudentClass').innerText = session.studentData.className
            ? `Class: ${session.studentData.className}` : 'Unassigned';

        // School
        const schoolSnap = await getDoc(doc(db, 'schools', session.schoolId));
        schoolData = schoolSnap.data() || {};
        const elSchool = document.getElementById('displaySchoolName');
        if (elSchool) elSchool.innerText = schoolData.schoolName || 'ConnectUs';

        const activeSemId = schoolData.activeSemesterId || '';

        // Semesters
        const semSnap = await getDocs(collection(db, 'schools', session.schoolId, 'semesters'));
        allSemesters  = semSnap.docs.map(d => ({ id: d.id, ...d.data() })).sort((a,b) => (a.order||0)-(b.order||0));

        // Topbar period display (student layout uses a static span)
        const activeSemName = allSemesters.find(s => s.id === activeSemId)?.name || '';
        const topDisplay = document.getElementById('activeSemesterDisplay');
        if (topDisplay && activeSemName) topDisplay.textContent = activeSemName;
        const sbPeriod = document.getElementById('sb-period');
        if (sbPeriod && activeSemName) sbPeriod.textContent = activeSemName;

        // Period selector
        const sel = document.getElementById('analyticsPeriodSelect');
        sel.innerHTML = allSemesters.map(s =>
            `<option value="${s.id}">${esc(s.name)}${s.id === activeSemId ? ' (Current)' : ''}</option>`
        ).join('');
        sel.value = activeSemId || (allSemesters[0]?.id || '');

        // Evaluations — global student path
        const eSnap = await getDocs(collection(db, 'students', session.studentId, 'evaluations'));
        allEvals    = eSnap.docs.map(d => ({ id: d.id, ...d.data() })).filter(e => e.schoolId === session.schoolId);

        sel.addEventListener('change', () => renderPeriod(sel.value));
        renderPeriod(sel.value);

        loader.style.display = 'none';
        content.classList.remove('hidden');

    } catch(e) {
        console.error('[Evaluations] init error:', e);
        loader.innerHTML = `
            <i class="fa-solid fa-triangle-exclamation" style="color:#ef4444;font-size:28px;display:block;margin-bottom:10px;"></i>
            <p style="color:#ef4444;font-weight:600;">Failed to load evaluations. Please refresh.</p>`;
    }
}

// ── 5. RENDER PERIOD ─────────────────────────────────────────────────────
function renderPeriod(semId) {
    const evals = allEvals
        .filter(e => e.semesterId === semId)
        .sort((a,b) => new Date(b.date || b.createdAt) - new Date(a.date || a.createdAt));

    renderKPIs(evals);
    renderCards(evals);
}

// ── 6. KPIs ───────────────────────────────────────────────────────────────
function renderKPIs(evals) {
    // Total
    document.getElementById('kpiTotal').textContent    = evals.length;
    document.getElementById('kpiTotalSub').textContent = `evaluation${evals.length !== 1 ? 's' : ''} on record`;

    // Average rating across all evals in this period
    const ratings = evals.map(e => evalAvgRating(e)).filter(v => v !== null);
    if (ratings.length) {
        const avg = (ratings.reduce((a,b) => a+b, 0) / ratings.length).toFixed(1);
        const rc  = ratingColor(parseFloat(avg));
        document.getElementById('kpiAvgRating').textContent = avg;
        document.getElementById('kpiAvgRating').style.color = rc.color;
    } else {
        document.getElementById('kpiAvgRating').textContent = '—';
        document.getElementById('kpiAvgRating').style.color = '#94a3b8';
    }

    // Most recent eval
    if (evals.length) {
        const latest   = evals[0];
        const tc       = typeConfig(latest.type);
        const dateStr  = latest.date
            ? new Date(latest.date).toLocaleDateString('en-US', { month:'short', day:'numeric', year:'numeric' })
            : '—';
        document.getElementById('kpiLatestDate').textContent = dateStr;
        document.getElementById('kpiLatestType').textContent = tc.label;
    } else {
        document.getElementById('kpiLatestDate').textContent = '—';
        document.getElementById('kpiLatestType').textContent = 'No evaluations yet';
    }

    // Latest status / promotion
    const latest = evals[0];
    if (latest?.status) {
        document.getElementById('kpiStatus').textContent    = latest.status;
        document.getElementById('kpiStatusSub').textContent = typeConfig(latest.type).label;
        document.getElementById('kpiStatus').style.color    = latest.type === 'behavioral' ? '#be123c' : latest.type === 'end_of_year' ? '#b45309' : '#7c3aed';
    } else {
        document.getElementById('kpiStatus').textContent    = '—';
        document.getElementById('kpiStatusSub').textContent = 'No status on record';
        document.getElementById('kpiStatus').style.color    = '#94a3b8';
    }
}

// ── 7. EVAL CARDS ─────────────────────────────────────────────────────────
function renderCards(evals) {
    const container = document.getElementById('evaluationsContainer');
    const noMsg     = document.getElementById('noEvalsMsg');
    const badge     = document.getElementById('evCountBadge');

    badge.textContent = `${evals.length} evaluation${evals.length !== 1 ? 's' : ''}`;

    if (!evals.length) {
        container.innerHTML = '';
        noMsg.classList.remove('hidden');
        return;
    }
    noMsg.classList.add('hidden');

    container.innerHTML = evals.map(e => {
        const tc      = typeConfig(e.type);
        const avgR    = evalAvgRating(e);
        const avgDisp = avgR !== null ? avgR.toFixed(1) : '—';
        const rc      = avgR !== null ? ratingColor(avgR) : { color:'#94a3b8', bg:'#f8fafc', border:'#e2e8f0' };
        const dateStr = e.date
            ? new Date(e.date).toLocaleDateString('en-US', { month:'long', day:'numeric', year:'numeric' })
            : '—';

        // Build ratings rows
        let ratingsHtml = '';
        let writtenHtml = '';
        let extraHtml   = '';

        if (e.type === 'academic') {
            ratingsHtml =
                ratingRow('Subject Mastery',    e.ratings?.mastery)    +
                ratingRow('Task Execution',     e.ratings?.execution)  +
                ratingRow('Class Engagement',   e.ratings?.engagement);
            writtenHtml = `
                ${e.written?.strengths ? `<div><p class="ev-field-label">Key Strengths</p><p class="ev-field-text">${esc(e.written.strengths)}</p></div>` : ''}
                ${e.written?.growth    ? `<div><p class="ev-field-label">Areas for Growth</p><p class="ev-field-text">${esc(e.written.growth)}</p></div>` : ''}
                ${e.written?.steps     ? `<div><p class="ev-field-label">Actionable Steps</p><p class="ev-field-text">${esc(e.written.steps)}</p></div>` : ''}`;

        } else if (e.type === 'behavioral') {
            ratingsHtml =
                ratingRow('Rule Adherence',      e.ratings?.adherence)  +
                ratingRow('Conflict Resolution', e.ratings?.resolution) +
                ratingRow('Respect for Authority', e.ratings?.respect);
            writtenHtml = `
                ${e.written?.description ? `<div><p class="ev-field-label">Conduct Description</p><p class="ev-field-text">${esc(e.written.description)}</p></div>` : ''}
                ${e.written?.prior       ? `<div><p class="ev-field-label">Prior Interventions</p><p class="ev-field-text">${esc(e.written.prior)}</p></div>` : ''}
                ${e.written?.actionPlan  ? `<div><p class="ev-field-label">Action Plan</p><p class="ev-field-text">${esc(e.written.actionPlan)}</p></div>` : ''}`;
            if (e.status) extraHtml = `
                <div style="margin-top:16px;padding:12px 16px;background:#fff0f3;border:1px solid #fda4af;border-radius:8px;display:flex;align-items:center;gap:10px;">
                    <i class="fa-solid fa-triangle-exclamation" style="color:#be123c;font-size:14px;flex-shrink:0;"></i>
                    <div><p class="ev-field-label" style="color:#be123c;margin:0 0 2px;">Action Taken</p><p style="font-size:13.5px;font-weight:700;color:#be123c;margin:0;">${esc(e.status)}</p></div>
                </div>`;

        } else if (e.type === 'end_of_year') {
            ratingsHtml =
                ratingRow('Academic Growth',  e.ratings?.growth)     +
                ratingRow('Social Dynamics',  e.ratings?.social)     +
                ratingRow('Resilience',       e.ratings?.resilience);
            writtenHtml = `
                ${e.written?.narrative     ? `<div><p class="ev-field-label">Year-in-Review</p><p class="ev-field-text">${esc(e.written.narrative)}</p></div>` : ''}
                ${e.written?.interventions ? `<div><p class="ev-field-label">Recommended Interventions</p><p class="ev-field-text">${esc(e.written.interventions)}</p></div>` : ''}`;
            if (e.status) extraHtml = `
                <div style="margin-top:16px;padding:12px 16px;background:#fffbeb;border:1px solid #fde68a;border-radius:8px;display:flex;align-items:center;gap:10px;">
                    <i class="fa-solid fa-award" style="color:#b45309;font-size:14px;flex-shrink:0;"></i>
                    <div><p class="ev-field-label" style="color:#b45309;margin:0 0 2px;">Promotion Status</p><p style="font-size:13.5px;font-weight:700;color:#b45309;margin:0;">${esc(e.status)}</p></div>
                </div>`;

        } else if (e.type === 'academic_report_card') {
            const rcRatings = [
                ['Academic Comprehension', e.ratings?.academicComprehension],
                ['Attitude Towards Work',  e.ratings?.attitudeWork],
                ['Effort & Resilience',    e.ratings?.effortResilience],
                ['Participation',          e.ratings?.participation],
                ['Organization',           e.ratings?.organization],
                ['Classroom Behaviour',    e.ratings?.behavior],
                ['Peer Relations',         e.ratings?.peerRelations],
                ['Punctuality',            e.ratings?.punctualityRating],
            ];
            ratingsHtml = rcRatings.map(([l,v]) => ratingRow(l,v)).join('');

            if (e.attendance) {
                const att = e.attendance;
                extraHtml += `
                <div style="margin-bottom:16px;">
                    <p class="ev-field-label">Attendance</p>
                    <div class="ev-attendance-grid">
                        <div class="ev-att-cell"><div class="ev-att-num">${att.totalSessions || 0}</div><div class="ev-att-lbl">Sessions</div></div>
                        <div class="ev-att-cell"><div class="ev-att-num">${att.daysAbsent || 0}</div><div class="ev-att-lbl">Absent</div></div>
                        <div class="ev-att-cell"><div class="ev-att-num">${att.daysLate || 0}</div><div class="ev-att-lbl">Late</div></div>
                    </div>
                </div>`;
            }
            if (e.comment) writtenHtml = `<div><p class="ev-field-label">Teacher's Comments</p><p class="ev-field-text">${esc(e.comment)}</p></div>`;
        }

        return `
        <div class="ev-card">

            <!-- Collapsed header -->
            <div class="ev-card-head" onclick="window.toggleEval('${e.id}')">
                <div class="ev-card-left">
                    <div class="ev-type-icon" style="background:${tc.bg};color:${tc.color};">
                        <i class="fa-solid ${tc.icon}"></i>
                    </div>
                    <div class="ev-card-meta">
                        <div class="ev-card-title">
                            ${esc(tc.label)}
                            <span class="ev-type-badge" style="background:${tc.bg};color:${tc.color};border-color:${tc.border};">
                                ${esc(e.semesterName || '—')}
                            </span>
                        </div>
                        <div class="ev-card-sub">
                            ${dateStr}
                            ${e.teacherName ? ` · Filed by <strong style="color:#374f6b;">${esc(e.teacherName)}</strong>` : ''}
                        </div>
                    </div>
                </div>
                <div class="ev-card-right">
                    <!-- Avg rating ring -->
                    <div class="ev-score-ring" style="border-color:${rc.border};background:${rc.bg};">
                        <span class="ev-score-num" style="color:${rc.color};">${avgDisp}</span>
                        <span class="ev-score-denom" style="color:${rc.color};">/5</span>
                    </div>
                    <button class="ev-print-btn no-print" onclick="event.stopPropagation();window.printEval('${e.id}')">
                        <i class="fa-solid fa-print"></i> Print
                    </button>
                    <i id="ev-chev-${e.id}" class="fa-solid fa-chevron-down ev-chevron"></i>
                </div>
            </div>

            <!-- Expanded body -->
            <div id="ev-body-${e.id}" class="ev-card-body">
                <div class="ev-body-grid">
                    <!-- Ratings panel -->
                    <div class="ev-ratings-panel">
                        <p class="ev-ratings-title"><i class="fa-solid fa-chart-simple" style="margin-right:6px;"></i>Performance Matrix</p>
                        ${ratingsHtml || '<p style="font-size:12px;color:#94a3b8;font-weight:600;">No ratings recorded.</p>'}
                    </div>
                    <!-- Written feedback -->
                    <div class="ev-written-panel">
                        ${writtenHtml || '<p style="font-size:13px;color:#94a3b8;font-weight:600;">No written feedback provided.</p>'}
                        ${extraHtml}
                    </div>
                </div>
            </div>

        </div>`;
    }).join('');
}

// ── 8. TOGGLE CARD ────────────────────────────────────────────────────────
window.toggleEval = function(id) {
    const body   = document.getElementById(`ev-body-${id}`);
    const chevron = document.getElementById(`ev-chev-${id}`);
    if (!body) return;
    const isOpen = body.classList.contains('open');
    body.classList.toggle('open', !isOpen);
    if (chevron) chevron.style.transform = isOpen ? 'rotate(0deg)' : 'rotate(180deg)';
};

// ── 9. PRINT EVALUATION ───────────────────────────────────────────────────
window.printEval = function(evalId) {
    const e = allEvals.find(x => x.id === evalId);
    if (!e) return;

    const tc       = typeConfig(e.type);
    const avgR     = evalAvgRating(e);
    const avgDisp  = avgR !== null ? avgR.toFixed(1) : '—';
    const dateStr  = e.date
        ? new Date(e.date).toLocaleDateString('en-US', { month:'long', day:'numeric', year:'numeric' }) : '—';
    const schoolNm = schoolData.schoolName || 'ConnectUs School';
    const logoSrc  = schoolData.logo || '../../assets/images/logo.png';

    // Ratings table rows
    const ratingRows = {
        academic: [
            ['Subject Mastery', e.ratings?.mastery],
            ['Task Execution',  e.ratings?.execution],
            ['Class Engagement',e.ratings?.engagement]
        ],
        behavioral: [
            ['Rule Adherence',       e.ratings?.adherence],
            ['Conflict Resolution',  e.ratings?.resolution],
            ['Respect for Authority',e.ratings?.respect]
        ],
        end_of_year: [
            ['Academic Growth', e.ratings?.growth],
            ['Social Dynamics', e.ratings?.social],
            ['Resilience',      e.ratings?.resilience]
        ],
        academic_report_card: [
            ['Academic Comprehension', e.ratings?.academicComprehension],
            ['Attitude Towards Work',  e.ratings?.attitudeWork],
            ['Effort & Resilience',    e.ratings?.effortResilience],
            ['Participation',          e.ratings?.participation],
            ['Organization',           e.ratings?.organization],
            ['Classroom Behaviour',    e.ratings?.behavior],
            ['Peer Relations',         e.ratings?.peerRelations],
            ['Punctuality',            e.ratings?.punctualityRating],
        ]
    }[e.type] || [];

    const metricsHtml = ratingRows.map(([lbl, val]) => {
        const v = Number(val) || 0;
        return `<tr><td>${esc(lbl)}</td><td style="text-align:center;font-family:monospace;font-weight:700;">${v} / 5</td><td style="width:120px;padding:10px 14px;"><div style="height:6px;background:#f1f5f9;border-radius:99px;overflow:hidden;"><div style="height:100%;width:${(v/5)*100}%;background:${barColor(v)};border-radius:99px;"></div></div></td></tr>`;
    }).join('');

    let writtenSections = '';
    if (e.type === 'academic') {
        writtenSections = [
            ['Key Strengths',   e.written?.strengths],
            ['Areas for Growth',e.written?.growth],
            ['Actionable Steps',e.written?.steps]
        ].filter(([,v]) => v).map(([l,v]) => `<div class="fb"><h3>${l}</h3><p>${esc(v)}</p></div>`).join('');
    } else if (e.type === 'behavioral') {
        writtenSections = [
            ['Conduct Description',    e.written?.description],
            ['Prior Interventions',    e.written?.prior],
            ['Action Plan',            e.written?.actionPlan]
        ].filter(([,v]) => v).map(([l,v]) => `<div class="fb"><h3>${l}</h3><p>${esc(v)}</p></div>`).join('');
        if (e.status) writtenSections += `<div class="status-box" style="background:#fff0f3;border-color:#fda4af;color:#be123c;"><strong>Action Taken:</strong> ${esc(e.status)}</div>`;
    } else if (e.type === 'end_of_year') {
        writtenSections = [
            ['Year-in-Review Narrative',   e.written?.narrative],
            ['Recommended Interventions',  e.written?.interventions]
        ].filter(([,v]) => v).map(([l,v]) => `<div class="fb"><h3>${l}</h3><p>${esc(v)}</p></div>`).join('');
        if (e.status) writtenSections += `<div class="status-box" style="background:#fffbeb;border-color:#fde68a;color:#b45309;"><strong>Promotion Status:</strong> ${esc(e.status)}</div>`;
    } else if (e.type === 'academic_report_card') {
        if (e.comment) writtenSections = `<div class="fb"><h3>Teacher's Comments</h3><p>${esc(e.comment)}</p></div>`;
        if (e.attendance) {
            const att = e.attendance;
            writtenSections += `<div class="fb"><h3>Attendance Record</h3>
                <table style="width:100%;"><tr>
                    <td style="text-align:center;padding:10px;background:#f8fafb;border:1px solid #e2e8f0;border-radius:6px;"><strong style="display:block;font-size:18px;">${att.totalSessions||0}</strong><span style="font-size:10px;text-transform:uppercase;letter-spacing:0.08em;color:#64748b;">Sessions</span></td>
                    <td style="text-align:center;padding:10px;background:#f8fafb;border:1px solid #e2e8f0;border-radius:6px;"><strong style="display:block;font-size:18px;">${att.daysAbsent||0}</strong><span style="font-size:10px;text-transform:uppercase;letter-spacing:0.08em;color:#64748b;">Absent</span></td>
                    <td style="text-align:center;padding:10px;background:#f8fafb;border:1px solid #e2e8f0;border-radius:6px;"><strong style="display:block;font-size:18px;">${att.daysLate||0}</strong><span style="font-size:10px;text-transform:uppercase;letter-spacing:0.08em;color:#64748b;">Late</span></td>
                </tr></table></div>`;
        }
    }

    const html = `<!DOCTYPE html>
<html>
<head>
<title>Official Performance Evaluation — ${esc(session.studentData.name)}</title>
<style>
@import url('https://fonts.googleapis.com/css2?family=DM+Sans:wght@400;500;600;700;800&family=DM+Mono:wght@400;500;700&display=swap');
@media print { * { -webkit-print-color-adjust:exact!important; print-color-adjust:exact!important; } @page { margin:1.5cm; } body { padding:0; } }
body { font-family:'DM Sans',Helvetica,Arial,sans-serif; padding:40px; color:#0f172a; line-height:1.6; background:#fff; max-width:820px; margin:0 auto; }
.banner { background:#1e1b4b; color:#fff; text-align:center; font-weight:800; letter-spacing:0.2em; padding:8px; font-size:11px; border-radius:5px; margin-bottom:24px; text-transform:uppercase; }
.hd { display:flex; align-items:flex-start; justify-content:space-between; border-bottom:3px solid #1e1b4b; padding-bottom:20px; margin-bottom:24px; gap:20px; }
.logo { max-height:65px; max-width:180px; object-fit:contain; }
.hd h1 { margin:0 0 4px; font-size:20px; font-weight:800; color:#1e1b4b; text-transform:uppercase; letter-spacing:0.04em; }
.hd h2 { margin:0 0 2px; font-size:11px; font-weight:800; color:${tc.color}; text-transform:uppercase; letter-spacing:0.12em; background:${tc.bg}; padding:3px 10px; border-radius:99px; display:inline-block; border:1px solid ${tc.border}; }
.hd p  { margin:4px 0 0; font-size:11.5px; color:#94a3b8; }
.info-grid { display:grid; grid-template-columns:1fr 1fr; gap:12px; background:#f8f9ff; border:1px solid #e0e3f5; border-radius:10px; padding:16px 20px; margin-bottom:28px; }
.ig-item strong { display:block; font-size:9.5px; text-transform:uppercase; letter-spacing:0.1em; color:#7c83c8; margin-bottom:2px; font-weight:800; }
.ig-item span   { font-size:13.5px; font-weight:700; color:#1e1b4b; }
.sec { font-size:11px; font-weight:800; background:#1e1b4b; color:#fff; text-transform:uppercase; letter-spacing:0.1em; padding:9px 16px; border-radius:6px; margin:0 0 18px; }
.body-grid { display:grid; grid-template-columns:260px 1fr; gap:28px; margin-bottom:28px; }
table { width:100%; border-collapse:collapse; }
th, td { border-bottom:1px solid #f1f5f9; padding:9px 12px; text-align:left; font-size:12.5px; }
th { background:#f8fafb; color:#64748b; font-weight:800; text-transform:uppercase; font-size:9.5px; letter-spacing:0.08em; border-bottom:2px solid #e2e8f0; }
.fb { margin-bottom:18px; }
.fb h3 { margin:0 0 6px; font-size:10px; color:#64748b; text-transform:uppercase; letter-spacing:0.1em; font-weight:800; border-bottom:1px solid #e2e8f0; padding-bottom:5px; }
.fb p  { margin:0; font-size:13px; color:#334155; font-weight:500; white-space:pre-wrap; line-height:1.65; }
.status-box { padding:12px 16px; border-radius:8px; border:1px solid; font-size:13px; font-weight:600; margin-top:14px; }
.sigs { display:grid; grid-template-columns:1fr 1fr 1fr; gap:40px; margin-top:56px; }
.sig { border-top:1px solid #1e1b4b; padding-top:8px; font-size:10.5px; font-weight:700; color:#64748b; text-transform:uppercase; letter-spacing:0.08em; }
.footer { margin-top:40px; border-top:1px solid #e2e8f0; padding-top:14px; text-align:center; font-size:10px; color:#94a3b8; font-style:italic; line-height:1.7; }
</style>
</head>
<body>
<div class="banner">Official Performance Evaluation Record · ${esc(schoolNm)}</div>
<div class="hd">
    <div>
        <div style="display:flex;align-items:center;gap:14px;margin-bottom:10px;">
            <img src="${esc(logoSrc)}" class="logo" onerror="this.style.display='none'">
            <div>
                <h1>${esc(schoolNm)}</h1>
                <h2>${esc(tc.label)}</h2>
                <p>${dateStr}</p>
            </div>
        </div>
    </div>
    <div style="text-align:right;flex-shrink:0;">
        <p style="font-size:10px;font-weight:700;text-transform:uppercase;letter-spacing:0.1em;color:#94a3b8;margin:0 0 4px;">Overall Rating</p>
        <p style="font-size:32px;font-weight:800;font-family:monospace;color:${tc.color};margin:0;">${avgDisp}</p>
        <p style="font-size:11px;color:#94a3b8;margin:0;">out of 5.0</p>
    </div>
</div>
<div class="info-grid">
    <div class="ig-item"><strong>Student Name</strong><span>${esc(session.studentData.name||'Unknown')}</span></div>
    <div class="ig-item"><strong>Student ID</strong><span>${esc(session.studentId||'N/A')}</span></div>
    <div class="ig-item"><strong>Class</strong><span>${esc(session.studentData.className||'Unassigned')}</span></div>
    <div class="ig-item"><strong>Academic Period</strong><span>${esc(e.semesterName||'Unknown')}</span></div>
    <div class="ig-item"><strong>Filed By</strong><span>${esc(e.teacherName||'Teacher')}</span></div>
    <div class="ig-item"><strong>Date Filed</strong><span>${dateStr}</span></div>
</div>
<h3 class="sec">Evaluation Details</h3>
<div class="body-grid">
    <div>
        <table>
            <thead><tr><th>Criteria</th><th style="text-align:center;">Rating</th><th>Visual</th></tr></thead>
            <tbody>${metricsHtml}</tbody>
        </table>
    </div>
    <div>${writtenSections}</div>
</div>
<div class="sigs">
    <div class="sig">Class Teacher &amp; Date</div>
    <div class="sig">Principal / Head of School</div>
    <div class="sig">Parent / Guardian</div>
</div>
<div class="footer">
    This evaluation was officially filed via the ConnectUs platform for ${esc(schoolNm)}.<br>
    This document is a certified performance record. For a copy with official school seal, contact the administration office.<br>
    <strong style="font-style:normal;color:#1e1b4b;">Powered by ConnectUs · connectusonline.org</strong>
</div>
</body></html>`;

    const w = window.open('', '_blank');
    w.document.write(html);
    w.document.close();
    setTimeout(() => w.print(), 600);
};

// ── INITIALIZE ────────────────────────────────────────────────────────────
document.addEventListener('DOMContentLoaded', init);
