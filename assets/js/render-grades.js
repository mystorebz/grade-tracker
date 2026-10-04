// ── SHARED CURRENT GRADES RENDERER (student + parent) ────────────────────
// ARCHITECTURAL MANDATE: Dashboard Analytics & Parent Portal "Mirror" Sync,
// Phase 1. Extracted verbatim from student/grades/grades.js (the sole
// pre-existing implementation) so the Parent Portal's Current Grades page
// renders from the EXACT same code the student sees, rather than a second,
// separately-maintained implementation. student/grades/grades.js and
// parent/grades/grades.js are now both thin wrappers: auth + layout +
// session/child resolution, then a single call to initGradesPage() below.
//
// This module never assumes a `session.studentData` shape (a parent's
// session carries no such thing) — the student's name/className/teacherId
// are re-fetched fresh here from students/{studentId} instead, which also
// makes this correct for a parent viewing a linked child.
//
// SUBJECT PAGES (2026-10-03): clicking a subject tile now navigates to its
// own page (student/grades/subject.html, parent/grades/subject.html, body
// rendered by assets/js/render-subject-grades.js). The old nested pop-ups
// (openSubjectModal / type drill-down / #typeModal) were removed. Both pages
// load data through fetchStudentGrades() below and use the same helpers, so
// the subject page's averages always match this list.
//
// READ-ONLY NOTE: this page has zero write actions in its student form —
// it only links to subject pages and prints. There is
// nothing to strip for the parent's read-only mandate; every control here
// (drill-down, print) is already safe to expose to a parent unchanged.
//
// DOM ids referenced below (gbTopbar, gbAvg, gbTerm, gbStanding,
// gradesLoader, noCurrentGradesMsg, gradesTable, subjectRows)
// are page-body markup and exist identically in both student/grades/
// grades.html and parent/grades/grades.html by construction (the parent
// page is a literal copy of the student page's body). displaySchoolName
// and activeSemesterDisplay are SIDEBAR/TOPBAR ids owned by each portal's
// own layout injector (layout-student.js vs layout-parent.js) — the parent
// layout doesn't render those elements at all, so every write to them
// below is guarded rather than a bare getElementById(...).prop assignment.
import { db } from './firebase-init.js';
import { collection, query, where, getDocs, doc, getDoc } from "https://www.gstatic.com/firebasejs/10.7.1/firebase-firestore.js";
import { calculateWeightedAverage, resolveGradeWeights } from './utils.js';

// ── STATE (module-scoped; one grades page is ever live per document) ─────
let allGrades     = [];
let teacherRubric = [];
let teachersMap   = {};
let bySubCache    = {};
let pageStudentId = null;
let subjectHrefFor = null; // (subject) => URL of that subject's page
let pageStudentName = 'Student';
let pageStudentClass = '—';

// ── HELPERS ────────────────────────────────────────────────────────────
export function esc(s) {
    return String(s ?? '').replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/"/g,'&quot;').replace(/'/g,'&#039;');
}

function setText(id, text) {
    const el = document.getElementById(id);
    if (el) el.textContent = text;
}

export function gradeStyle(p) {
    if (p >= 90) return { color:'#059669', bg:'#d1fae5', border:'#6ee7b7', letter:'A', bar:'#10b981' };
    if (p >= 80) return { color:'#2563eb', bg:'#dbeafe', border:'#93c5fd', letter:'B', bar:'#3b82f6' };
    if (p >= 70) return { color:'#0d9488', bg:'#ccfbf1', border:'#5eead4', letter:'C', bar:'#14b8a6' };
    if (p >= 65) return { color:'#d97706', bg:'#fef3c7', border:'#fcd34d', letter:'D', bar:'#f59e0b' };
    return             { color:'#dc2626', bg:'#fee2e2', border:'#fca5a5', letter:'F', bar:'#ef4444' };
}

export function standing(avg) {
    if (avg >= 90) return '⭐ Excelling';
    if (avg >= 80) return '👍 Good Standing';
    if (avg >= 70) return '➡ On Track';
    if (avg >= 65) return '⚠ Needs Attention';
    return '🔴 At Risk';
}

export function isNew(date, created) {
    const d = created ? new Date(created) : new Date(date);
    return !isNaN(d) && Math.ceil(Math.abs(new Date() - d) / 86400000) <= 5;
}

// Weight (%) of an assignment type in the teacher's rubric, or null.
export function weightFor(rubric, type) {
    if (!type || !rubric || !rubric.length) return null;
    const r = rubric.find(x => x.name?.toLowerCase() === type.toLowerCase());
    return r ? r.weight : null;
}
function getWeight(type) { return weightFor(teacherRubric, type); }

// Plain mean of item percentages — how a single assignment type's average
// has always been shown (the old type tiles). Subject averages use the
// weighted calculateWeightedAverage() instead.
export function typeAverage(grades) {
    if (!grades.length) return null;
    return Math.round(grades.reduce((s, g) => s + (g.max ? (g.score / g.max) * 100 : 0), 0) / grades.length);
}

export function groupBySubject(grades) {
    const bySub = {};
    grades.forEach(g => {
        const sub = g.subject || 'Uncategorized';
        if (!bySub[sub]) bySub[sub] = [];
        bySub[sub].push(g);
    });
    return bySub;
}

// ── SHARED DATA LOAD (Current Grades list + subject pages) ───────────────
// One student's grades for the school's active semester, plus the teacher
// rubric (weights) and teacher names. Returns { noSemester: true } when the
// school has no active grading period.
export async function fetchStudentGrades(studentId, schoolId) {
    const [studentSnap, schoolSnap] = await Promise.all([
        getDoc(doc(db, 'students', studentId)),
        getDoc(doc(db, 'schools', schoolId)),
    ]);
    const studentData = studentSnap.exists() ? studentSnap.data() : {};
    const schoolData  = schoolSnap.data() || {};
    const semId       = schoolData.activeSemesterId;
    if (!semId) return { studentData, schoolData, noSemester: true };

    const tId = studentData.teacherId;
    const [semSnap, tSnap, gSnap] = await Promise.all([
        getDoc(doc(db, 'schools', schoolId, 'semesters', semId)),
        tId ? getDoc(doc(db, 'teachers', tId)) : Promise.resolve(null),
        getDocs(query(
            collection(db, 'students', studentId, 'grades'),
            where('schoolId',   '==', schoolId),
            where('semesterId', '==', semId)
        ))
    ]);

    const teachers = {};
    let rubric = [];
    if (tSnap && tSnap.exists()) {
        const td = tSnap.data();
        // PHASE 0: prefer schools/{schoolId}/teaching_assignments weighting
        // over the legacy gradeTypes/customGradeTypes fields.
        rubric = await resolveGradeWeights(schoolId, tId, { legacyTeacherData: td }) || [];
        teachers[tId] = td.name || 'Teacher';
    }

    const grades = gSnap.docs.map(d => ({ id: d.id, ...d.data() }));

    // Fetch only teachers referenced in grades, in parallel
    const extraTeacherIds = [...new Set(grades
        .filter(g => !g.enteredByAdmin && g.teacherId && !teachers[g.teacherId])
        .map(g => g.teacherId))];
    if (extraTeacherIds.length) {
        const extraSnaps = await Promise.all(extraTeacherIds.map(id => getDoc(doc(db, 'teachers', id))));
        extraSnaps.forEach((snap, i) => { if (snap.exists()) teachers[extraTeacherIds[i]] = snap.data().name || 'Teacher'; });
    }

    return { studentData, schoolData, semId, semName: semSnap.data()?.name || 'Current Period', rubric, teachers, grades };
}

// ── LOAD DATA ─────────────────────────────────────────────────────────────
async function loadGrades(studentId, schoolId) {
    try {
        const data = await fetchStudentGrades(studentId, schoolId);
        pageStudentName  = data.studentData.name || 'Student';
        pageStudentClass = data.studentData.className || '—';
        setText('displaySchoolName', data.schoolData.schoolName || 'ConnectUs');

        if (data.noSemester) {
            document.getElementById('gradesLoader').innerHTML =
                '<i class="fa-solid fa-calendar-xmark" style="font-size:28px;color:#fbbf24;"></i><p>No active grading period set by the school.</p>';
            return;
        }

        setText('activeSemesterDisplay', data.semName);
        setText('gbTerm', data.semName);
        teacherRubric = data.rubric;
        teachersMap   = data.teachers;
        allGrades     = data.grades;

        document.getElementById('gradesLoader').style.display = 'none';

        if (!allGrades.length) {
            document.getElementById('noCurrentGradesMsg').classList.remove('hidden');
            return;
        }

        const bySub = groupBySubject(allGrades);
        bySubCache = bySub;

        // Overall average
        let totalAvg = 0, subCount = 0;
        for (const sub in bySub) {
            const avg = calculateWeightedAverage(bySub[sub], teacherRubric);
            if (avg !== null) { totalAvg += avg; subCount++; }
        }
        const overall = subCount > 0 ? Math.round(totalAvg / subCount) : null;

        // Populate header
        const topbar = document.getElementById('gbTopbar');
        topbar.style.display = 'flex';
        if (overall !== null) {
            document.getElementById('gbAvg').textContent = overall;
            document.getElementById('gbAvg').style.color = '#fff';
            const standEl = document.getElementById('gbStanding');
            standEl.textContent   = standing(overall);
            standEl.style.display = 'inline-flex';
        }

        renderSubjectTiles(bySub);

    } catch(e) {
        console.error('[Grades] load error:', e);
        document.getElementById('gradesLoader').innerHTML =
            '<i class="fa-solid fa-triangle-exclamation" style="color:#ef4444;font-size:28px;"></i><p style="color:#ef4444;">Failed to load grades. Please refresh.</p>';
    }
}

// ── SUBJECT TILE COLORS ────────────────────────────────────────────────
export const TILE_COLORS = [
    { bg:'#1e1b4b', accent:'#6366f1' },
    { bg:'#064e3b', accent:'#10b981' },
    { bg:'#7c2d12', accent:'#f97316' },
    { bg:'#1e3a5f', accent:'#3b82f6' },
    { bg:'#4a1d96', accent:'#8b5cf6' },
    { bg:'#831843', accent:'#ec4899' },
    { bg:'#134e4a', accent:'#14b8a6' },
    { bg:'#713f12', accent:'#eab308' },
];

// ── RENDER SUBJECT TILES ───────────────────────────────────────────────
function renderSubjectTiles(bySub) {
    const table  = document.getElementById('gradesTable');
    const rowsEl = document.getElementById('subjectRows');
    table.classList.remove('hidden');

    const entries = Object.entries(bySub).sort((a,b) => a[0].localeCompare(b[0]));

    rowsEl.innerHTML = `
        <div style="display:grid;grid-template-columns:repeat(auto-fill,minmax(210px,1fr));gap:16px;padding:4px 0;">
            ${entries.map(([subject, grades], idx) => {
                const avg    = calculateWeightedAverage(grades, teacherRubric);
                const avgRnd = avg !== null ? Math.round(avg) : null;
                const st     = avgRnd !== null ? gradeStyle(avgRnd) : null;
                const color  = TILE_COLORS[idx % TILE_COLORS.length];
                const cnt    = grades.length;

                const href   = subjectHrefFor ? subjectHrefFor(subject) : '#';
                return `
                <a href="${esc(href)}" aria-label="${esc(subject)}: ${avgRnd !== null ? avgRnd + '%' : 'no average yet'}"
                     style="text-decoration:none;background:#fff;border:1.5px solid #e2e8f0;border-radius:12px;padding:20px 18px;cursor:pointer;transition:all 0.15s;display:flex;flex-direction:column;gap:14px;position:relative;overflow:hidden;"
                     onmouseover="this.style.borderColor='${color.accent}';this.style.boxShadow='0 6px 24px rgba(0,0,0,0.10)';this.style.transform='translateY(-2px)';"
                     onmouseout="this.style.borderColor='#e2e8f0';this.style.boxShadow='none';this.style.transform='translateY(0)';">
                    <div style="position:absolute;top:0;left:0;right:0;height:3px;background:${color.accent};border-radius:12px 12px 0 0;"></div>
                    <div style="display:flex;align-items:center;gap:12px;margin-top:6px;">
                        <div style="width:42px;height:42px;border-radius:10px;background:${color.bg};color:#fff;font-size:17px;font-weight:800;display:flex;align-items:center;justify-content:center;flex-shrink:0;">
                            ${esc(subject.charAt(0).toUpperCase())}
                        </div>
                        <div style="min-width:0;">
                            <div style="font-size:13px;font-weight:700;color:#0f172a;line-height:1.3;white-space:nowrap;overflow:hidden;text-overflow:ellipsis;">${esc(subject)}</div>
                            <div style="font-size:11px;color:#94a3b8;font-weight:500;margin-top:2px;">${cnt} ${cnt !== 1 ? 'entries' : 'entry'}</div>
                        </div>
                    </div>
                    <div style="display:flex;align-items:flex-end;justify-content:space-between;">
                        <div style="font-size:30px;font-weight:900;line-height:1;color:${st?.color || '#94a3b8'};">
                            ${avgRnd !== null ? avgRnd + '%' : '—'}
                        </div>
                        ${st ? `<span style="font-size:15px;font-weight:800;padding:5px 13px;border-radius:8px;background:${st.bg};color:${st.color};border:1.5px solid ${st.border};">${st.letter}</span>` : ''}
                    </div>
                    <div style="height:4px;background:#f1f5f9;border-radius:99px;overflow:hidden;margin-top:-6px;">
                        <div style="height:100%;width:${Math.min(avgRnd||0,100)}%;background:${st?.bar || '#cbd5e1'};border-radius:99px;"></div>
                    </div>
                </a>`;
            }).join('')}
        </div>`;
}

// ── PRINT GRADEBOOK ───────────────────────────────────────────────────
// Opens a new window with a fully formatted, print-ready grade report,
// then triggers the print dialog automatically.
// Uses only data already loaded in memory — no extra Firestore calls.
window.printGradebook = function() {
    if (!allGrades.length || !Object.keys(bySubCache).length) {
        alert('Grade data is still loading. Please wait a moment and try again.');
        return;
    }

    // ── Gather page meta ─────────────────────────────────────────────────
    const logoUrl    = new URL('../../assets/images/logo.png', window.location.href).href;
    const printDate  = new Date().toLocaleDateString('en-US', { year:'numeric', month:'long', day:'numeric' });
    const semName    = document.getElementById('activeSemesterDisplay')?.textContent || 'Current Period';
    const schoolName = document.getElementById('displaySchoolName')?.textContent    || 'School';
    const studentName  = pageStudentName;
    const studentClass = pageStudentClass;

    // ── Calculate all subject averages ───────────────────────────────────
    const subjects = Object.entries(bySubCache).sort((a, b) => a[0].localeCompare(b[0]));
    let totalAvg = 0, subCount = 0;
    const subjectAverages = {};

    for (const [sub, grades] of subjects) {
        const avg = calculateWeightedAverage(grades, teacherRubric);
        if (avg !== null) {
            const rounded = Math.round(avg);
            subjectAverages[sub] = rounded;
            totalAvg += rounded;
            subCount++;
        }
    }

    const overall    = subCount > 0 ? Math.round(totalAvg / subCount) : null;
    const overallSt  = overall !== null ? gradeStyle(overall) : null;
    const standingTx = overall !== null ? standing(overall).replace(/[⭐👍➡⚠🔴]\s?/u, '') : '—';

    // ── Build subject sections ───────────────────────────────────────────
    const subjectSectionsHtml = subjects.map(([subject, grades], idx) => {
        const avg   = subjectAverages[subject] ?? null;
        const st    = avg !== null ? gradeStyle(avg) : null;
        const color = TILE_COLORS[idx % TILE_COLORS.length];

        const sorted = [...grades].sort((a, b) => (a.date || '').localeCompare(b.date || ''));

        const rows = sorted.map(g => {
            const pct   = g.max ? Math.round((g.score / g.max) * 100) : null;
            const gSt   = pct !== null ? gradeStyle(pct) : null;
            const w     = getWeight(g.type);
            const tName = g.enteredByAdmin
                ? (g.adminName || 'Administrator')
                : (teachersMap[g.teacherId] || 'Teacher');

            return `
            <tr>
                <td class="col-title">${esc(g.title || '—')}${g.enteredByAdmin ? ' <span class="admin-tag">Admin</span>' : ''}</td>
                <td class="col-date">${esc(g.date || '—')}</td>
                <td class="col-type">${esc(g.type || '—')}${w !== null ? `<span class="weight"> (${w}%)</span>` : ''}</td>
                <td class="col-score center">${g.score} / ${g.max ?? '?'}</td>
                <td class="col-pct center" style="color:${gSt?.color || '#374f6b'};font-weight:800;">${pct !== null ? pct + '%' : '—'}</td>
                <td class="col-letter center">
                    <span class="letter-badge" style="color:${gSt?.color || '#374f6b'};background:${gSt?.bg || '#f1f5f9'};border-color:${gSt?.border || '#e2e8f0'};">${gSt?.letter || '—'}</span>
                </td>
            </tr>`;
        }).join('');

        return `
        <div class="subject-section">
            <div class="subject-header" style="background:${color.accent};">
                <div class="subject-initial">${esc(subject.charAt(0).toUpperCase())}</div>
                <div class="subject-name">${esc(subject)}</div>
                ${avg !== null ? `<div class="subject-avg-pill">${avg}%&nbsp;&nbsp;${st?.letter || ''}</div>` : ''}
            </div>
            <table>
                <thead>
                    <tr>
                        <th class="col-title">Assignment</th>
                        <th class="col-date">Date</th>
                        <th class="col-type">Type</th>
                        <th class="col-score center">Score</th>
                        <th class="col-pct center">Percentage</th>
                        <th class="col-letter center">Grade</th>
                    </tr>
                </thead>
                <tbody>${rows}</tbody>
                <tfoot>
                    <tr>
                        <td colspan="4" class="avg-label">Subject Average</td>
                        <td class="center avg-val" style="color:${st?.color || '#374f6b'};">${avg !== null ? avg + '%' : '—'}</td>
                        <td class="center">
                            <span class="letter-badge avg-letter" style="color:${st?.color || '#374f6b'};background:${st?.bg || '#f1f5f9'};border-color:${st?.border || '#e2e8f0'};">${st?.letter || '—'}</span>
                        </td>
                    </tr>
                </tfoot>
            </table>
        </div>`;
    }).join('');

    // ── Assemble full HTML document ──────────────────────────────────────
    const html = `<!DOCTYPE html>
<html lang="en">
<head>
    <meta charset="UTF-8">
    <meta name="viewport" content="width=device-width, initial-scale=1.0">
    <title>Grade Report — ${esc(studentName)} — ${esc(semName)}</title>
    <style>
        /* ── Reset & Base ── */
        *, *::before, *::after { box-sizing: border-box; margin: 0; padding: 0; }
        body {
            font-family: 'Segoe UI', Arial, sans-serif;
            background: #fff;
            color: #0d1f35;
            font-size: 11.5px;
            line-height: 1.5;
            -webkit-print-color-adjust: exact;
            print-color-adjust: exact;
        }

        /* ── Report Header ── */
        .report-header {
            display: flex;
            align-items: center;
            justify-content: space-between;
            padding: 24px 36px 20px;
            border-bottom: 3px solid #1e1b4b;
            background: #fff;
        }
        .header-left { display: flex; align-items: center; gap: 16px; }
        .logo { width: 52px; height: 52px; object-fit: contain; }
        .brand { display: flex; flex-direction: column; }
        .brand-name { font-size: 22px; font-weight: 900; color: #1e1b4b; letter-spacing: -0.5px; }
        .brand-tagline { font-size: 10px; color: #818cf8; font-weight: 700; letter-spacing: 1.5px; text-transform: uppercase; margin-top: 2px; }
        .header-right { text-align: right; }
        .report-title { font-size: 15px; font-weight: 800; color: #1e1b4b; text-transform: uppercase; letter-spacing: 1px; }
        .report-date { font-size: 10px; color: #6b84a0; margin-top: 3px; font-weight: 500; }

        /* ── Student Info Bar ── */
        .student-bar {
            background: #f4f7fb;
            border-bottom: 1px solid #dce3ed;
            padding: 14px 36px;
            display: grid;
            grid-template-columns: repeat(4, 1fr);
            gap: 0;
        }
        .student-field { padding: 0 16px; }
        .student-field:first-child { padding-left: 0; }
        .student-field:not(:last-child) { border-right: 1px solid #dce3ed; }
        .field-label {
            font-size: 9px; text-transform: uppercase; letter-spacing: 1.2px;
            font-weight: 700; color: #94a3b8; display: block; margin-bottom: 3px;
        }
        .field-value { font-size: 13px; font-weight: 800; color: #0d1f35; }

        /* ── Section Label ── */
        .section-label {
            padding: 20px 36px 10px;
            font-size: 9px; font-weight: 700; color: #94a3b8;
            text-transform: uppercase; letter-spacing: 1.5px;
        }

        /* ── Subject Sections ── */
        .subjects { padding: 0 36px; }
        .subject-section {
            margin-bottom: 28px;
            border: 1px solid #e2e8f0;
            border-radius: 10px;
            overflow: hidden;
            page-break-inside: avoid;
        }

        /* Subject Header Bar */
        .subject-header {
            display: flex;
            align-items: center;
            gap: 12px;
            padding: 11px 16px;
            color: #fff;
        }
        .subject-initial {
            width: 30px; height: 30px;
            border-radius: 7px;
            background: rgba(255,255,255,0.22);
            display: flex; align-items: center; justify-content: center;
            font-size: 15px; font-weight: 900;
            flex-shrink: 0;
        }
        .subject-name { font-size: 13px; font-weight: 800; flex: 1; }
        .subject-avg-pill {
            background: rgba(255,255,255,0.22);
            padding: 3px 12px;
            border-radius: 99px;
            font-size: 12px; font-weight: 900;
            letter-spacing: 0.5px;
            border: 1px solid rgba(255,255,255,0.3);
        }

        /* Grade Table */
        table { width: 100%; border-collapse: collapse; }
        thead th {
            background: #f8fafc;
            font-size: 9px; font-weight: 700;
            text-transform: uppercase; letter-spacing: 0.8px;
            color: #6b84a0;
            padding: 8px 14px;
            text-align: left;
            border-bottom: 1px solid #e8edf4;
        }
        thead th.center { text-align: center; }

        tbody tr:nth-child(even) { background: #fafbfc; }
        tbody tr:last-child td { border-bottom: none; }
        tbody td {
            padding: 9px 14px;
            border-bottom: 1px solid #f0f4f9;
            font-size: 11px;
            color: #0d1f35;
            vertical-align: middle;
        }
        tbody td.center { text-align: center; }

        /* Subject Average Footer Row */
        tfoot td {
            padding: 10px 14px;
            background: #f0f4f9;
            border-top: 2px solid #dce3ed;
            font-weight: 700;
            font-size: 11px;
        }
        .avg-label { text-align: right; color: #374f6b; font-style: italic; }
        .avg-val { font-size: 14px; font-weight: 900; }

        /* Column widths */
        .col-title  { width: 28%; }
        .col-date   { width: 12%; white-space: nowrap; }
        .col-type   { width: 22%; }
        .col-score  { width: 12%; }
        .col-pct    { width: 12%; }
        .col-letter { width: 10%; }

        /* Letter badge */
        .letter-badge {
            display: inline-block;
            padding: 3px 10px;
            border-radius: 5px;
            border: 1.5px solid;
            font-size: 12px;
            font-weight: 900;
        }
        .avg-letter { font-size: 13px; padding: 4px 12px; }

        /* Weight label */
        .weight { color: #94a3b8; font-size: 9.5px; font-weight: 600; }

        /* Admin tag */
        .admin-tag {
            display: inline-block;
            font-size: 8px; font-weight: 700;
            padding: 1px 5px;
            background: #eff6ff; color: #2563eb;
            border: 1px solid #bfdbfe;
            border-radius: 3px;
            vertical-align: middle;
            margin-left: 5px;
        }

        /* ── Overall Average Block ── */
        .overall-block {
            margin: 24px 36px 28px;
            border: 2px solid #1e1b4b;
            border-radius: 10px;
            overflow: hidden;
            page-break-inside: avoid;
        }
        .overall-header {
            background: #1e1b4b;
            color: #fff;
            padding: 10px 20px;
            font-size: 10px; font-weight: 700;
            text-transform: uppercase; letter-spacing: 1.5px;
        }
        .overall-body {
            display: flex;
            align-items: center;
            justify-content: space-between;
            padding: 18px 24px;
            background: #f4f7fb;
        }
        .overall-left { display: flex; align-items: center; gap: 20px; }
        .overall-avg-num { font-size: 52px; font-weight: 900; line-height: 1; }
        .overall-pct-label { font-size: 20px; font-weight: 700; color: #6b84a0; align-self: flex-end; margin-bottom: 6px; }
        .overall-standing { font-size: 14px; font-weight: 700; color: #374f6b; margin-top: 4px; }
        .overall-sub-count { font-size: 10px; color: #94a3b8; font-weight: 500; margin-top: 2px; }
        .overall-right { text-align: right; }
        .overall-letter-badge {
            display: inline-block;
            width: 64px; height: 64px;
            border-radius: 12px;
            border: 3px solid;
            display: flex; align-items: center; justify-content: center;
            font-size: 30px; font-weight: 900;
        }

        /* ── Footer ── */
        .report-footer {
            padding: 14px 36px;
            border-top: 1px solid #dce3ed;
            display: flex;
            justify-content: space-between;
            align-items: center;
            color: #94a3b8;
            font-size: 9px;
        }
        .footer-brand { font-weight: 700; color: #818cf8; }

        /* ── Print ── */
        @media print {
            body { -webkit-print-color-adjust: exact; print-color-adjust: exact; }
            .subject-section { page-break-inside: avoid; }
            .overall-block   { page-break-inside: avoid; }
        }
    </style>
</head>
<body>

    <!-- ── Report Header ── -->
    <div class="report-header">
        <div class="header-left">
            <img src="${logoUrl}" alt="ConnectUs" class="logo" onerror="this.style.display='none'">
            <div class="brand">
                <div class="brand-name">ConnectUs</div>
                <div class="brand-tagline">Academic Platform · Belize</div>
            </div>
        </div>
        <div class="header-right">
            <div class="report-title">Academic Grade Report</div>
            <div class="report-date">Printed: ${printDate}</div>
        </div>
    </div>

    <!-- ── Student Info Bar ── -->
    <div class="student-bar">
        <div class="student-field">
            <span class="field-label">Student</span>
            <span class="field-value">${esc(studentName)}</span>
        </div>
        <div class="student-field">
            <span class="field-label">Class</span>
            <span class="field-value">${esc(studentClass)}</span>
        </div>
        <div class="student-field">
            <span class="field-label">School</span>
            <span class="field-value">${esc(schoolName)}</span>
        </div>
        <div class="student-field">
            <span class="field-label">Term / Period</span>
            <span class="field-value">${esc(semName)}</span>
        </div>
    </div>

    <!-- ── Section Label ── -->
    <div class="section-label">Grades by Subject</div>

    <!-- ── Subject Sections ── -->
    <div class="subjects">
        ${subjectSectionsHtml}
    </div>

    <!-- ── Overall Average ── -->
    ${overall !== null ? `
    <div class="overall-block">
        <div class="overall-header">Term Overall Average</div>
        <div class="overall-body">
            <div class="overall-left">
                <div>
                    <div style="display:flex;align-items:flex-end;gap:4px;">
                        <div class="overall-avg-num" style="color:${overallSt?.color || '#0d1f35'};">${overall}</div>
                        <div class="overall-pct-label">%</div>
                    </div>
                    <div class="overall-standing">${standingTx}</div>
                    <div class="overall-sub-count">${subCount} subject${subCount !== 1 ? 's' : ''} · ${allGrades.length} total assignment${allGrades.length !== 1 ? 's' : ''}</div>
                </div>
            </div>
            <div class="overall-right">
                <div class="overall-letter-badge" style="color:${overallSt?.color || '#374f6b'};background:${overallSt?.bg || '#f1f5f9'};border-color:${overallSt?.border || '#e2e8f0'};">
                    ${overallSt?.letter || '—'}
                </div>
            </div>
        </div>
    </div>` : ''}

    <!-- ── Footer ── -->
    <div class="report-footer">
        <div>Generated by <span class="footer-brand">ConnectUs</span> · Academic Management Platform</div>
        <div>${esc(studentName)} · ${esc(semName)} · ${printDate}</div>
    </div>

</body>
</html>`;

    // ── Open print window ────────────────────────────────────────────────
    const win = window.open('', '_blank');
    if (!win) {
        alert('Pop-ups are blocked. Please allow pop-ups for this site to print the grade report.');
        return;
    }
    win.document.write(html);
    win.document.close();
    win.focus();
    // Brief delay lets the browser fully render before opening print dialog
    setTimeout(() => { win.print(); }, 650);
};

// ── PUBLIC ENTRY POINT ────────────────────────────────────────────────
// Called by both student/grades/grades.js and parent/grades/grades.js
// once their own auth+layout setup is done.
// subjectHref(subject) → URL of that subject's page (each portal builds its own).
export async function initGradesPage({ studentId, schoolId, subjectHref }) {
    pageStudentId = studentId;
    subjectHrefFor = subjectHref || null;
    await loadGrades(studentId, schoolId);
}
