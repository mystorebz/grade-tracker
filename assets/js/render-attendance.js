// ── SHARED ATTENDANCE RENDERER (student + parent) ──────────────────────
// ARCHITECTURAL MANDATE: Dashboard Analytics & Parent Portal "Mirror" Sync.
// Extracted from student/attendance/attendance.js. Not one of the four
// pages the mandate names explicitly (Assignments/Current Grades/Academic
// History/Reports), but splitting the Parent Portal's old combined
// Grades+Attendance page (per this mandate's own decision) means Attendance
// now needs its own dedicated parent page too — built the same
// shared-module way as the other four for consistency, and because the
// mandate's own follow-up direction was "mirroring how it is handled on
// the Student side."
//
// READ-ONLY NOTE: purely a read/paging view already — nothing to strip.
//
// This module resolves className itself via a students/{studentId} fetch
// rather than assuming a `session.studentData.className` shortcut, since a
// parent session carries no such field for the child being viewed.
import { loadSchoolClasses, resolveClassNamesToIds, loadSchoolHeaderInfo } from './utils.js';
import { loadAttendanceHistoryForStudent } from './attendance.js';
import { db } from './firebase-init.js';
import { doc, getDoc } from "https://www.gstatic.com/firebasejs/10.7.1/firebase-firestore.js";

let pageStudentId = null;
let pageSchoolId  = null;
let classId = null;
let viewYear, viewMonth; // viewMonth is 0-indexed, same as Date's own convention

const STATUS_META = {
    present: { label: 'Present', color: '#059669', bg: '#ecfdf5', border: '#a7f3d0' },
    absent:  { label: 'Absent',  color: '#dc2626', bg: '#fef2f2', border: '#fecaca' },
    tardy:   { label: 'Tardy',   color: '#d97706', bg: '#fffbeb', border: '#fde68a' },
    excused: { label: 'Excused', color: '#475569', bg: '#f1f5f9', border: '#cbd5e1' },
};

const els = {};

function escHtml(str) {
    if (!str) return '';
    return String(str).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;').replace(/'/g, '&#039;');
}

function pad2(n) { return String(n).padStart(2, '0'); }
function ymd(y, m, d) { return `${y}-${pad2(m + 1)}-${pad2(d)}`; }
function daysInMonth(y, m) { return new Date(y, m + 1, 0).getDate(); }

function cacheEls() {
    ['monthLabel', 'prevMonthBtn', 'nextMonthBtn', 'attLoader', 'attEmpty', 'monthSummary', 'attList']
        .forEach(id => { els[id] = document.getElementById(id); });
}

function wireEvents() {
    els.prevMonthBtn.addEventListener('click', () => {
        viewMonth -= 1;
        if (viewMonth < 0) { viewMonth = 11; viewYear -= 1; }
        loadAndRenderMonth();
    });
    els.nextMonthBtn.addEventListener('click', () => {
        viewMonth += 1;
        if (viewMonth > 11) { viewMonth = 0; viewYear += 1; }
        loadAndRenderMonth();
    });
}

function showEmptyState(message) {
    els.attLoader?.classList.add('hidden');
    els.attList.innerHTML = '';
    els.monthSummary.innerHTML = '';
    els.attEmpty.textContent = message;
    els.attEmpty.classList.remove('hidden');
}

// ── LOAD + RENDER ONE MONTH ───────────────────────────────────────────
async function loadAndRenderMonth() {
    els.monthLabel.textContent = new Date(viewYear, viewMonth, 1).toLocaleDateString(undefined, { month: 'long', year: 'numeric' });
    els.attEmpty.classList.add('hidden');
    els.attLoader.classList.remove('hidden');
    els.attList.innerHTML = '';
    els.monthSummary.innerHTML = '';

    const startDate = ymd(viewYear, viewMonth, 1);
    const endDate = ymd(viewYear, viewMonth, daysInMonth(viewYear, viewMonth));

    try {
        const history = await loadAttendanceHistoryForStudent(pageSchoolId, classId, pageStudentId, startDate, endDate);
        els.attLoader.classList.add('hidden');

        if (!history.length) {
            showEmptyState('No attendance has been recorded for this month yet.');
            return;
        }

        renderSummary(history);
        renderList(history);
    } catch (e) {
        console.error('[Attendance] loadAndRenderMonth:', e);
        showEmptyState('Something went wrong loading attendance for this month.');
    }
}

function renderSummary(history) {
    const counts = { present: 0, absent: 0, tardy: 0, excused: 0 };
    history.forEach(h => { if (counts[h.status] !== undefined) counts[h.status]++; });

    els.monthSummary.innerHTML = Object.keys(STATUS_META).map(st => `
        <div class="flex items-center gap-2 bg-white border border-slate-200 rounded-xl px-3.5 py-2.5">
            <span class="w-2.5 h-2.5 rounded-full flex-shrink-0" style="background:${STATUS_META[st].color}"></span>
            <span class="text-lg font-black text-slate-700">${counts[st] || 0}</span>
            <span class="text-[11px] font-bold text-slate-400 uppercase tracking-wider">${STATUS_META[st].label}</span>
        </div>`).join('');
}

function renderList(history) {
    const sorted = history.slice().sort((a, b) => a.date.localeCompare(b.date));
    els.attList.innerHTML = sorted.map(h => {
        const meta = STATUS_META[h.status] || STATUS_META.excused;
        const dateObj = new Date(Number(h.date.slice(0, 4)), Number(h.date.slice(5, 7)) - 1, Number(h.date.slice(8, 10)));
        return `
        <div class="flex items-center justify-between gap-3 bg-white border border-slate-200 rounded-xl px-4 py-3">
            <p class="font-bold text-slate-700 text-sm">${escHtml(dateObj.toLocaleDateString(undefined, { weekday: 'short', month: 'short', day: 'numeric' }))}</p>
            <span class="text-[11px] font-black uppercase tracking-wider px-2.5 py-1 rounded-lg" style="color:${meta.color};background:${meta.bg};border:1px solid ${meta.border}">${meta.label}</span>
        </div>`;
    }).join('');
}

// ── PUBLIC ENTRY POINT ────────────────────────────────────────────────
export async function initAttendancePage({ studentId, schoolId }) {
    pageStudentId = studentId;
    pageSchoolId  = schoolId;
    cacheEls();
    wireEvents();

    const today = new Date();
    viewYear = today.getFullYear();
    viewMonth = today.getMonth();

    loadSchoolHeaderInfo(schoolId).then(({ schoolName, semesterName }) => {
        const schoolEl = document.getElementById('displaySchoolName');
        const semEl = document.getElementById('activeSemesterDisplay');
        if (schoolEl) schoolEl.textContent = schoolName;
        if (semEl) semEl.textContent = semesterName;
    });

    let className = null;
    try {
        const studentSnap = await getDoc(doc(db, 'students', studentId));
        className = studentSnap.exists() ? (studentSnap.data().className || null) : null;
    } catch (e) {
        console.error('[Attendance] init:', e);
    }

    if (!className) {
        showEmptyState("Not assigned to a class yet — check back once enrolled.");
        return;
    }

    try {
        const schoolClasses = await loadSchoolClasses(schoolId);
        const resolved = resolveClassNamesToIds([className], schoolClasses).resolved;
        if (!resolved.length) {
            showEmptyState("This class couldn't be found. Check back later or contact the teacher.");
            return;
        }
        classId = resolved[0].id;
    } catch (e) {
        console.error('[Attendance] init:', e);
        showEmptyState('Something went wrong loading class information. Please try again later.');
        return;
    }

    await loadAndRenderMonth();
}
