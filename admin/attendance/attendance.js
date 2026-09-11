// ── PHASE 1 MILESTONE 6: ATTENDANCE (admin read-only flow) ───────────────
// School-wide, read-only mirror of the teacher write flow: pick any class
// in the school + a date, see that day's roster and statuses. No editing —
// admins observe what teachers have recorded, they don't record it
// themselves (that stays a teacher-only action, matching the requireAuth
// scoping every other admin page already uses).
import { db } from '../../assets/js/firebase-init.js';
import { collection, getDocs, query, where } from "https://www.gstatic.com/firebasejs/10.7.1/firebase-firestore.js";
import { requireAuth } from '../../assets/js/auth.js';
import { injectAdminLayout } from '../../assets/js/layout-admin.js';
import { loadSchoolClasses } from '../../assets/js/utils.js';
import { ATTENDANCE_STATUSES, loadAttendanceForDate } from '../../assets/js/attendance.js';

// ── 1. AUTH & LAYOUT ──────────────────────────────────────────────────────
const session = requireAuth('admin', '../login.html');
injectAdminLayout('attendance', 'Attendance', 'View daily attendance across every class', false, false);

// ── 2. STATE ──────────────────────────────────────────────────────────────
let schoolClasses = []; // [{ id, name, ... }]
let selectedClassId = '';
let rosterForClass = [];

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

function todayStr() {
    const d = new Date();
    return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
}

// ── 3. INIT ───────────────────────────────────────────────────────────────
async function init() {
    if (!session) return;
    cacheEls();
    wireEvents();
    els.attDate.value = todayStr();

    try {
        schoolClasses = await loadSchoolClasses(session.schoolId);
    } catch (e) {
        console.error('[Admin Attendance] Failed to load classes:', e);
    }

    if (!schoolClasses.length) {
        showEmptyState('No classes have been created for this school yet.');
        return;
    }

    els.classPicker.innerHTML = schoolClasses
        .slice().sort((a, b) => (a.order ?? 0) - (b.order ?? 0))
        .map(c => `<option value="${escHtml(c.id)}">${escHtml(c.name)}</option>`).join('');
    selectedClassId = schoolClasses[0].id;
    els.classPicker.value = selectedClassId;

    await loadAndRender();
}

function cacheEls() {
    ['classPicker', 'attDate', 'attLoader', 'attBody', 'attEmpty', 'attSummary', 'attDayMeta']
        .forEach(id => { els[id] = document.getElementById(id); });
}

function wireEvents() {
    els.classPicker.addEventListener('change', () => {
        selectedClassId = els.classPicker.value;
        loadAndRender();
    });
    els.attDate.addEventListener('change', () => loadAndRender());
}

function showEmptyState(message) {
    els.attLoader?.classList.add('hidden');
    els.attBody?.classList.add('hidden');
    els.attEmpty.textContent = message;
    els.attEmpty.classList.remove('hidden');
}

// ── 4. LOAD ROSTER + THAT DAY'S ATTENDANCE ───────────────────────────────
async function loadAndRender() {
    if (!selectedClassId || !els.attDate.value) return;

    els.attEmpty.classList.add('hidden');
    els.attBody.classList.add('hidden');
    els.attLoader.classList.remove('hidden');

    const cls = schoolClasses.find(c => c.id === selectedClassId);
    const date = els.attDate.value;

    try {
        const q = query(
            collection(db, 'students'),
            where('currentSchoolId', '==', session.schoolId),
            where('enrollmentStatus', '==', 'Active')
        );
        const snap = await getDocs(q);
        rosterForClass = snap.docs
            .map(d => ({ id: d.id, ...d.data() }))
            .filter(s => s.className === cls?.name)
            .sort((a, b) => (a.name || '').localeCompare(b.name || ''));

        const dayDoc = await loadAttendanceForDate(session.schoolId, selectedClassId, date);

        els.attDayMeta.textContent = dayDoc.updatedAt
            ? `Recorded ${new Date(dayDoc.updatedAt).toLocaleString()}`
            : 'Not yet taken for this date';

        if (!rosterForClass.length) {
            showEmptyState(`No active students on the roster for ${cls?.name || 'this class'}.`);
            return;
        }

        els.attLoader.classList.add('hidden');
        els.attBody.classList.remove('hidden');
        renderRoster(dayDoc.records || {});
    } catch (e) {
        console.error('[Admin Attendance] loadAndRender:', e);
        showEmptyState('Something went wrong loading attendance for this class/date. Please try again.');
    }
}

function renderRoster(records) {
    const counts = { present: 0, absent: 0, tardy: 0, excused: 0, unmarked: 0 };
    rosterForClass.forEach(s => {
        const st = records[s.id]?.status;
        if (st && counts[st] !== undefined) counts[st]++;
        else counts.unmarked++;
    });

    els.attSummary.innerHTML = ATTENDANCE_STATUSES.map(st => `
        <span class="text-xs font-black text-slate-500 flex items-center gap-1.5">
            <span class="w-2 h-2 rounded-full" style="background:${STATUS_META[st].color}"></span>${counts[st] || 0} ${STATUS_META[st].label}
        </span>`).join('') + (counts.unmarked
            ? `<span class="text-xs font-black text-slate-400 flex items-center gap-1.5"><span class="w-2 h-2 rounded-full bg-slate-300"></span>${counts.unmarked} Not marked</span>`
            : '');

    els.attBody.innerHTML = rosterForClass.map(s => {
        const entry = records[s.id];
        const meta = entry ? STATUS_META[entry.status] : null;
        return `
        <div class="flex items-center justify-between gap-3 px-5 py-3 border-b border-slate-100 last:border-b-0">
            <div class="min-w-0">
                <p class="font-black text-slate-700 text-sm truncate">${escHtml(s.name)}</p>
                <p class="text-[11px] text-slate-400 font-bold font-mono">${escHtml(s.id)}</p>
            </div>
            ${meta
                ? `<span class="text-[11px] font-black uppercase tracking-wider px-2.5 py-1 rounded-lg flex-shrink-0" style="color:${meta.color};background:${meta.bg};border:1px solid ${meta.border}">${meta.label}</span>`
                : `<span class="text-[11px] font-black uppercase tracking-wider px-2.5 py-1 rounded-lg bg-slate-50 text-slate-400 border border-slate-200 flex-shrink-0">Not marked</span>`}
        </div>`;
    }).join('');
}

init();
