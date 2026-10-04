// teacher/subjects/tabs/performance.js — Performance tab
// Contract (all tabs): mount(el, ctx) / unmount(el)
//   ctx = { store, route, sem, semName, session, gradeTypes, semesterLocked, navigate, refresh, isStale }
//
// Feature parity with the removed slide-out panel: weighted averages
// (calculateWeightedAverage + the teacher's grade weights), filters (student,
// standing, type, title), grade distribution, Needs Attention list, student
// breakdown, grade records (click → grade detail modal), printable report.

import { letterGrade, gradeColorClass, standingBadge, standingText, calculateWeightedAverage } from '../../../assets/js/utils.js';
import { setGradeDetails } from '../workbench.js';
import { esc, loading, card, emptyBox, stat, formatDate } from './ui.js';

const DEFAULT_GRADE_TYPES = ['Test', 'Quiz', 'Assignment', 'Homework', 'Project', 'Midterm Exam', 'Final Exam'];
const STANDINGS = [['', 'All standings'], ['excelling', 'Excelling'], ['good', 'Good Standing'], ['ontrack', 'On Track'], ['needsattention', 'Needs Attention'], ['atrisk', 'At Risk']];

let filters = { student: '', standing: '', type: '', title: '' };
let filtersFor = null;
let handlers = null;

export async function mount(el, ctx) {
    const { store, route, sem, isStale } = ctx;
    el.innerHTML = loading('Loading performance…');
    if (!sem) { el.innerHTML = emptyBox('No grading period.', 'Ask your school admin to create one.'); return; }

    const [students, grades] = await Promise.all([store.getStudents(), store.getGrades(sem)]);
    if (isStale()) return;

    const key = `${route.c}|${route.s}`;
    if (filtersFor !== key) { filters = { student: '', standing: '', type: '', title: '' }; filtersFor = key; }

    const gradeTypes = ctx.gradeTypes || DEFAULT_GRADE_TYPES;
    const typeNames = [...new Set([...gradeTypes.map((t) => t.name || t), ...grades.map((g) => g.type).filter(Boolean)])];

    el.innerHTML = `
        <div class="bg-white rounded-xl border border-[#dce3ed] shadow-sm p-3 mb-4 flex flex-wrap items-center gap-2">
            <select data-filter="student" class="p-2 bg-white border border-[#dce3ed] rounded text-[12.5px]">
                <option value="">All students</option>${students.map((s) => `<option value="${esc(s.id)}">${esc(s.name)}</option>`).join('')}
            </select>
            <select data-filter="standing" class="p-2 bg-white border border-[#dce3ed] rounded text-[12.5px]">
                ${STANDINGS.map(([v, l]) => `<option value="${v}">${l}</option>`).join('')}
            </select>
            <select data-filter="type" class="p-2 bg-white border border-[#dce3ed] rounded text-[12.5px]">
                <option value="">All types</option>${typeNames.map((t) => `<option value="${esc(t)}">${esc(t)}</option>`).join('')}
            </select>
            <input data-filter="title" type="search" placeholder="Search assignment title…" class="p-2 bg-white border border-[#dce3ed] rounded text-[12.5px] flex-1 min-w-[160px]">
            <button type="button" data-action="print" class="bg-white hover:bg-[#eef4ff] text-[#2563eb] border border-[#c7d9fd] font-bold py-2 px-3 rounded text-[12px]">
                <i class="fa-solid fa-print mr-1"></i>Print report
            </button>
        </div>
        <div data-region="body"></div>`;

    el.querySelectorAll('[data-filter]').forEach((input) => { input.value = filters[input.dataset.filter] || ''; });
    const body = el.querySelector('[data-region="body"]');
    const draw = () => { body.innerHTML = renderBody(compute(students, grades, gradeTypes)); };
    draw();

    detach(el);
    handlers = {
        input: (e) => {
            const f = e.target.closest('[data-filter]');
            if (!f) return;
            filters[f.dataset.filter] = f.value;
            draw();
        },
        click: (e) => {
            if (e.target.closest('[data-action="print"]')) printReport(ctx, compute(students, grades, gradeTypes));
            const row = e.target.closest('[data-grade-id]');
            if (row && typeof window.openAssignmentModal === 'function') window.openAssignmentModal(row.dataset.gradeId);
        },
    };
    el.addEventListener('input', handlers.input);
    el.addEventListener('change', handlers.input);
    el.addEventListener('click', handlers.click);
}

export function unmount(el) {
    detach(el);
    el.innerHTML = '';
}

function detach(el) {
    if (!handlers) return;
    el.removeEventListener('input', handlers.input);
    el.removeEventListener('change', handlers.input);
    el.removeEventListener('click', handlers.click);
    handlers = null;
}

// ── DATA ─────────────────────────────────────────────────────────────────
function compute(students, grades, gradeTypes) {
    const byStudent = new Map(students.map((s) => [s.id, []]));
    grades.forEach((g) => { if (g.max > 0) byStudent.get(g.studentId)?.push(g); });

    // standing filter uses each student's average over ALL their grades (legacy behaviour)
    const allowed = students.filter((s) => {
        if (filters.student && s.id !== filters.student) return false;
        if (!filters.standing) return true;
        const avg = calculateWeightedAverage(byStudent.get(s.id), gradeTypes);
        return avg !== null && standingText(avg) === filters.standing;
    });
    const allowedIds = new Set(allowed.map((s) => s.id));
    const title = filters.title.trim().toLowerCase();

    const records = grades
        .filter((g) => allowedIds.has(g.studentId))
        .filter((g) => !filters.type || g.type === filters.type)
        .filter((g) => !title || (g.title || '').toLowerCase().includes(title))
        .sort((a, b) => (b.date || '').localeCompare(a.date || ''));
    setGradeDetails(records);

    const rows = allowed.map((s) => {
        const gs = records.filter((g) => g.studentId === s.id && g.max > 0);
        const avg = gs.length ? calculateWeightedAverage(gs, gradeTypes) : null;
        const last = gs.map((g) => g.date).filter(Boolean).sort().pop() || null;
        return { s, count: gs.length, avg: avg === null ? null : Math.round(avg), last };
    });
    const graded = rows.filter((r) => r.avg !== null);
    const classAvg = graded.length ? Math.round(graded.reduce((a, r) => a + r.avg, 0) / graded.length) : null;
    const dist = { A: 0, B: 0, C: 0, D: 0, F: 0 };
    graded.forEach((r) => { dist[letterGrade(r.avg)]++; });
    const atRisk = graded.filter((r) => r.avg < 65).sort((a, b) => a.avg - b.avg);
    const nameOf = new Map(students.map((s) => [s.id, s.name]));
    return { rows, records, classAvg, dist, atRisk, gradedCount: graded.length, nameOf };
}

// ── RENDER ───────────────────────────────────────────────────────────────
const DIST_COLORS = { A: 'bg-emerald-500', B: 'bg-blue-500', C: 'bg-teal-500', D: 'bg-amber-500', F: 'bg-red-500' };

function renderBody({ rows, records, classAvg, dist, atRisk, gradedCount, nameOf }) {
    const total = gradedCount || 1;
    return `
        <div class="grid grid-cols-2 md:grid-cols-4 gap-3 mb-4">
            ${stat('Class average', classAvg === null ? '—' : `${classAvg}% · ${letterGrade(classAvg)}`, classAvg === null ? undefined : gradeColorClass(classAvg))}
            ${stat('Students', rows.length)}
            ${stat('Grade records', records.length)}
            ${stat('At risk', atRisk.length, atRisk.length ? 'text-red-600' : undefined)}
        </div>

        <div class="mb-4">${card('Grade distribution', `
            <div class="p-4">
                <div class="flex h-6 rounded overflow-hidden bg-[#f0f4f8] text-[10.5px] font-bold text-white">
                    ${gradedCount ? Object.entries(dist).filter(([, n]) => n).map(([l, n]) => `<div class="${DIST_COLORS[l]} flex items-center justify-center" style="width:${(n / total) * 100}%">${l}:${n}</div>`).join('') : '<div class="w-full flex items-center justify-center text-[#9ab0c6]">No data</div>'}
                </div>
                <div class="flex gap-4 mt-3 flex-wrap">${Object.entries(dist).map(([l, n]) => `<span class="flex items-center gap-1.5 text-[11.5px] font-bold text-[#374f6b]"><span class="w-3 h-3 rounded-sm ${DIST_COLORS[l]}"></span>${l}: ${n}</span>`).join('')}</div>
            </div>`)}</div>

        ${atRisk.length ? `
        <div class="bg-red-50 border border-red-200 rounded-xl p-4 mb-4">
            <p class="font-bold text-red-700 text-[12px] uppercase tracking-widest m-0 mb-2"><i class="fa-solid fa-triangle-exclamation mr-1"></i>Needs attention</p>
            <div class="space-y-1.5">${atRisk.map((r) => `
                <div class="flex items-center justify-between bg-white border border-red-100 rounded-lg px-3 py-2 text-[13px]">
                    <span class="font-bold text-[#0d1f35]">${esc(r.s.name)}</span><span class="font-bold text-red-600">${r.avg}%</span>
                </div>`).join('')}</div>
        </div>` : ''}

        <div class="mb-4">${card('Student breakdown', `
            <div class="overflow-x-auto"><table class="w-full text-[13px]">
                <thead><tr class="text-left text-[10.5px] uppercase tracking-widest text-[#9ab0c6]">
                    <th class="py-2 px-4">Student</th><th class="py-2 px-4">Average</th><th class="py-2 px-4">Standing</th>
                    <th class="py-2 px-4">Grades</th><th class="py-2 px-4">Last graded</th>
                </tr></thead>
                <tbody>${rows.length ? rows.map(({ s, count, avg, last }) => `
                    <tr class="border-t border-[#f0f4f8]">
                        <td class="py-2.5 px-4 font-bold text-[#0d1f35]">${esc(s.name)}</td>
                        <td class="py-2.5 px-4 font-bold ${avg === null ? 'text-[#9ab0c6]' : gradeColorClass(avg)}">${avg === null ? '—' : `${avg}% · ${letterGrade(avg)}`}</td>
                        <td class="py-2.5 px-4">${standingBadge(avg)}</td>
                        <td class="py-2.5 px-4 text-[#6b84a0]">${count}</td>
                        <td class="py-2.5 px-4 text-[#6b84a0]">${esc(formatDate(last)) || '—'}</td>
                    </tr>`).join('') : '<tr><td colspan="5" class="py-8 text-center text-[#9ab0c6] italic">No students match the filters.</td></tr>'}
                </tbody>
            </table></div>`)}</div>

        ${card(`Grade records · ${records.length}`, `
            <div class="overflow-x-auto"><table class="w-full text-[13px]">
                <thead><tr class="text-left text-[10.5px] uppercase tracking-widest text-[#9ab0c6]">
                    <th class="py-2 px-4">Assignment</th><th class="py-2 px-4">Type</th><th class="py-2 px-4">Student</th><th class="py-2 px-4">Score</th>
                </tr></thead>
                <tbody>${records.length ? records.map((g) => {
                    const pct = g.max ? Math.round((g.score / g.max) * 100) : null;
                    return `
                    <tr data-grade-id="${esc(g.id)}" class="border-t border-[#f0f4f8] cursor-pointer hover:bg-[#f8fafc]">
                        <td class="py-2.5 px-4"><span class="font-bold text-[#0d1f35]">${esc(g.title || '—')}</span><span class="block text-[11px] text-[#9ab0c6]">${esc(formatDate(g.date))}</span></td>
                        <td class="py-2.5 px-4"><span class="text-[10px] font-bold uppercase bg-[#f4f7fb] text-[#6b84a0] border border-[#dce3ed] px-2 py-0.5 rounded">${esc(g.type || '—')}</span></td>
                        <td class="py-2.5 px-4 font-bold text-[#374f6b]">${esc(nameOf.get(g.studentId) || '—')}</td>
                        <td class="py-2.5 px-4 font-bold ${gradeColorClass(pct || 0)}">${g.score}/${g.max}${pct === null ? '' : ` · ${pct}%`}</td>
                    </tr>`;
                }).join('') : '<tr><td colspan="4" class="py-8 text-center text-[#9ab0c6] italic">No grade records match the filters.</td></tr>'}
                </tbody>
            </table></div>`)}`;
}

// ── PRINT (same template as the removed panel's printSubjectReport) ──────
function printReport(ctx, { records, nameOf }) {
    const { session } = ctx;
    const schoolName = session.schoolName || session.schoolId;
    const subjectName = document.getElementById('subjectTitle')?.textContent || '';
    const className = document.getElementById('crumbClass')?.textContent || '';
    const semName = ctx.semName || '';
    const studentName = filters.student ? (nameOf.get(filters.student) || '') : 'All Students';
    const standing = (STANDINGS.find(([v]) => v === filters.standing) || STANDINGS[0])[1];
    const banner = `<div style="background:#e31b4a;color:white;text-align:center;font-weight:900;letter-spacing:0.3em;padding:6px;font-size:12px;margin-bottom:20px;width:100%;">*** UNOFFICIAL RECORD ***</div>`;

    const rowsHtml = records.length ? records.map((g) => {
        const pct = g.max ? Math.round((g.score / g.max) * 100) : null;
        return `<tr><td class="font-mono" style="color:#6b84a0">${esc(g.date || '—')}</td><td>${esc(g.title)}</td>
            <td class="tc" style="color:#6b84a0;font-size:10px;text-transform:uppercase;">${esc(g.type)}</td>
            <td><strong>${esc(nameOf.get(g.studentId) || 'Unknown')}</strong></td>
            <td class="tc font-mono">${g.score}/${g.max}</td><td class="tc font-mono">${pct === null ? '—' : pct + '%'}</td></tr>`;
    }).join('') : `<tr><td colspan="6" class="tc" style="padding:40px;font-style:italic;color:#6b84a0;">No records match the current filters.</td></tr>`;

    const html = `<html><head><title>Subject Report — ${esc(subjectName)}</title><style>
        @import url('https://fonts.googleapis.com/css2?family=DM+Sans:wght@400;500;600;700&family=DM+Mono:wght@400;500&display=swap');
        @media print { * { -webkit-print-color-adjust: exact !important; print-color-adjust: exact !important; } body { padding: 0; margin: 0; } @page { margin: 1.5cm; } }
        body { font-family: 'DM Sans', sans-serif; padding: 40px; color: #0d1f35; line-height: 1.5; background: white; }
        .header { display: flex; flex-direction: column; align-items: center; border-bottom: 2px solid #0d1f35; padding-bottom: 20px; margin-bottom: 24px; }
        .logo { max-height: 60px; max-width: 220px; object-fit: contain; margin-bottom: 12px; }
        .school-name { margin: 0 0 10px 0; font-size: 26px; font-weight: 900; text-align: center; }
        h1 { margin: 0 0 4px 0; font-size: 18px; text-transform: uppercase; letter-spacing: 0.05em; font-weight: 800; }
        h2 { margin: 0; font-size: 11px; color: #6b84a0; font-weight: 700; letter-spacing: 0.15em; text-transform: uppercase; }
        .info-grid { background: #f8fafb; padding: 18px; border-radius: 4px; border: 1px solid #dce3ed; margin-bottom: 30px; display: grid; grid-template-columns: 1fr 1fr 1fr; gap: 12px; }
        .info-grid div { font-size: 13px; font-weight: 600; } .info-grid strong { font-size: 10px; color: #6b84a0; text-transform: uppercase; letter-spacing: 0.1em; display: block; margin-bottom: 2px; }
        table { width: 100%; border-collapse: collapse; } th, td { border-bottom: 1px solid #f0f4f8; padding: 10px 14px; text-align: left; font-size: 12px; }
        th { background: #f8fafb; color: #6b84a0; font-weight: 700; text-transform: uppercase; font-size: 10px; letter-spacing: 0.05em; border-bottom: 2px solid #dce3ed; }
        .tc { text-align: center; } .font-mono { font-family: 'DM Mono', monospace; font-weight: 700; }
    </style></head><body>${banner}
        <div class="header"><img src="${esc(session.logo || '')}" alt="" class="logo" onerror="this.style.display='none'">
            <p class="school-name">${esc(schoolName)}</p><h1>Subject Report: ${esc(subjectName)}</h1>
            <h2>${esc(session.teacherData?.name || '')} • ACADEMIC RECORD</h2></div>
        <div class="info-grid">
            <div><strong>Academic Period</strong> ${esc(semName)}</div><div><strong>Class</strong> ${esc(className)}</div>
            <div><strong>Student Filter</strong> ${esc(studentName)}</div><div><strong>Standing Filter</strong> ${esc(standing)}</div>
            <div><strong>Assignment Type</strong> ${esc(filters.type || 'All Types')}</div><div><strong>Assignment Search</strong> ${esc(filters.title || 'None')}</div>
        </div>
        <table><thead><tr><th style="width:90px;">Date</th><th>Assignment</th><th class="tc">Type</th><th>Student</th><th class="tc">Score</th><th class="tc">%</th></tr></thead>
        <tbody>${rowsHtml}</tbody></table>
        <div style="font-size:10px;color:#9ab0c6;margin-top:40px;text-align:center;border-top:1px solid #dce3ed;padding-top:14px;font-style:italic;">
            Generated by the ConnectUs Analytical Engine for ${esc(schoolName)}. This document does not constitute a certified administrative transcript unless signed and stamped by school administration.</div>
        <br><br>${banner}</body></html>`;

    const w = window.open('', '_blank');
    if (!w) { alert('Allow pop-ups for this site to print the report.'); return; }
    w.document.write(html);
    w.document.close();
    setTimeout(() => w.print(), 600);
}
