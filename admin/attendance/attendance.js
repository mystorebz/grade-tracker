// ── ADMIN ATTENDANCE: VIEW + CORRECT ANY DAY ─────────────────────────────
// Pick any class in the school and any date up to today; see that day's
// roster and change any student's status. Each tap saves immediately (a
// merge write of just that student's entry), the same way the teacher roll
// call saves, and the onAttendanceSaved function then copies the day to
// each student's own record for the student and parent portals.
//
// Why this page exists: teachers can only change TODAY's attendance
// (firestore.rules attendance block — create/update/delete on a past date
// require isSchoolAdmin). This is the admin's place to make those past-day
// corrections. The rules check the admin's live ID token (role super_admin /
// sub_admin + schoolId), not anything this page sends.
//
// An untaken day stays untaken until an admin marks someone: unlike the
// teacher roll call, this page never fills in "Present" for students it
// wasn't told about, because a past day's correction must not invent records.
import { db } from '../../assets/js/firebase-init.js';
import { collection, doc, getDocs, query, setDoc, where } from "https://www.gstatic.com/firebasejs/10.7.1/firebase-firestore.js";
import { requireAuth } from '../../assets/js/auth.js';
import { injectAdminLayout } from '../../assets/js/layout-admin.js';
import { loadSchoolClasses } from '../../assets/js/utils.js';
import { ATTENDANCE_STATUSES, loadAttendanceForDate } from '../../assets/js/attendance.js';

// ── 1. AUTH & LAYOUT ──────────────────────────────────────────────────────
const session = requireAuth('admin', '../login.html');
injectAdminLayout('attendance', 'Attendance', 'View and correct attendance for any class and date', false, false);

// ── 2. STATE ──────────────────────────────────────────────────────────────
let schoolClasses = [];   // [{ id, name, ... }]
let selectedClassId = '';
let rosterForClass = [];
let records = {};         // { studentId: { status, markedAt, markedBy } } as shown
let viewToken = 0;        // bumps on class/date change; stale async results are ignored
let pendingWrites = 0;
const SAVE_TIMEOUT_MS = 2500;

// Stored values stay present/absent/tardy/excused; 'tardy' is shown as Late
// (same wording as the teacher roll call and the family portals).
const STATUS_META = {
    present: { label: 'Present', color: '#059669', bg: '#ecfdf5', border: '#a7f3d0', on: '#059669' },
    absent:  { label: 'Absent',  color: '#dc2626', bg: '#fef2f2', border: '#fecaca', on: '#dc2626' },
    tardy:   { label: 'Late',    color: '#d97706', bg: '#fffbeb', border: '#fde68a', on: '#f59e0b' },
    excused: { label: 'Excused', color: '#475569', bg: '#f1f5f9', border: '#cbd5e1', on: '#64748b' },
};

const els = {};

function escHtml(str) {
    if (str === null || str === undefined) return '';
    return String(str).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;').replace(/'/g, '&#039;');
}

function todayStr() {
    const d = new Date();
    return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
}

function actorId() {
    return session.adminId || session.schoolId || 'admin';
}

// ── 3. INIT ───────────────────────────────────────────────────────────────
async function init() {
    if (!session) return;
    cacheEls();
    wireEvents();
    els.attDate.value = todayStr();
    els.attDate.max = todayStr();

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
    ['classPicker', 'attDate', 'attLoader', 'attBody', 'attEmpty', 'attSummary', 'attDayMeta', 'attSaveState']
        .forEach(id => { els[id] = document.getElementById(id); });
}

function wireEvents() {
    els.classPicker.addEventListener('change', () => {
        selectedClassId = els.classPicker.value;
        loadAndRender();
    });
    els.attDate.addEventListener('change', () => {
        if (els.attDate.value > todayStr()) els.attDate.value = todayStr();
        loadAndRender();
    });
    els.attBody.addEventListener('click', (e) => {
        const btn = e.target.closest('[data-status]');
        if (btn && !btn.disabled) setStatus(btn.dataset.studentId, btn.dataset.status);
    });
    window.addEventListener('beforeunload', (e) => {
        if (pendingWrites > 0) { e.preventDefault(); e.returnValue = ''; }
    });
}

function showEmptyState(message) {
    els.attLoader?.classList.add('hidden');
    els.attBody?.classList.add('hidden');
    els.attSummary.innerHTML = '';
    els.attEmpty.textContent = message;
    els.attEmpty.classList.remove('hidden');
}

function setSaveState(kind, text) {
    const map = {
        idle:    ['text-slate-400', 'Changes save automatically'],
        saving:  ['text-slate-500', '<i class="fa-solid fa-circle-notch fa-spin mr-1"></i>Saving…'],
        saved:   ['text-emerald-600', '<i class="fa-solid fa-check mr-1"></i>All changes saved'],
        offline: ['text-amber-600', '<i class="fa-solid fa-wifi mr-1"></i>Saved offline · will sync'],
        error:   ['text-red-600', '<i class="fa-solid fa-triangle-exclamation mr-1"></i>' + escHtml(text || 'Could not save')],
    };
    const [cls, html] = map[kind] || map.idle;
    els.attSaveState.className = `text-xs font-bold mt-1.5 ${cls}`;
    els.attSaveState.innerHTML = html;
}

// ── 4. LOAD ROSTER + THAT DAY'S ATTENDANCE ───────────────────────────────
async function loadAndRender() {
    if (!selectedClassId || !els.attDate.value) return;
    const token = ++viewToken;

    els.attEmpty.classList.add('hidden');
    els.attBody.classList.add('hidden');
    els.attLoader.classList.remove('hidden');
    setSaveState('idle');

    const cls = schoolClasses.find(c => c.id === selectedClassId);
    const date = els.attDate.value;

    try {
        const [snap, dayDoc] = await Promise.all([
            getDocs(query(
                collection(db, 'students'),
                where('currentSchoolId', '==', session.schoolId),
                where('enrollmentStatus', '==', 'Active')
            )),
            loadAttendanceForDate(session.schoolId, selectedClassId, date),
        ]);
        if (token !== viewToken) return;

        // Roster source of truth = the student's classId (className fallback
        // for legacy records that predate classId).
        rosterForClass = snap.docs
            .map(d => ({ id: d.id, ...d.data() }))
            .filter(s => s.classId ? s.classId === selectedClassId : (!!cls && s.className === cls.name))
            .sort((a, b) => (a.name || '').localeCompare(b.name || ''));

        records = { ...(dayDoc.records || {}) };
        els.attDayMeta.textContent = dayDoc.updatedAt
            ? `Last updated ${new Date(dayDoc.updatedAt).toLocaleString()}`
            : 'Not taken for this date';

        if (!rosterForClass.length) {
            showEmptyState(`No active students on the roster for ${cls?.name || 'this class'}.`);
            return;
        }

        els.attLoader.classList.add('hidden');
        els.attBody.classList.remove('hidden');
        renderRoster();
    } catch (e) {
        if (token !== viewToken) return;
        console.error('[Admin Attendance] loadAndRender:', e);
        showEmptyState('Something went wrong loading attendance for this class/date. Please try again.');
    }
}

// ── 5. RENDER ─────────────────────────────────────────────────────────────
function renderRoster() {
    const counts = { present: 0, absent: 0, tardy: 0, excused: 0, unmarked: 0 };
    rosterForClass.forEach(s => {
        const st = records[s.id]?.status;
        if (st && counts[st] !== undefined) counts[st]++;
        else counts.unmarked++;
    });

    els.attSummary.innerHTML = ATTENDANCE_STATUSES.map(st => `
        <span class="text-xs font-black text-slate-500 flex items-center gap-1.5">
            <span class="w-2 h-2 rounded-full" style="background:${STATUS_META[st].color}"></span>${STATUS_META[st].label}: ${counts[st] || 0}
        </span>`).join('') + (counts.unmarked
            ? `<span class="text-xs font-black text-slate-400 flex items-center gap-1.5"><span class="w-2 h-2 rounded-full bg-slate-300"></span>Not marked: ${counts.unmarked}</span>`
            : '');

    els.attBody.innerHTML = rosterForClass.map(s => {
        const current = records[s.id]?.status || '';
        const buttons = ATTENDANCE_STATUSES.map(st => {
            const m = STATUS_META[st];
            const on = current === st;
            return `<button type="button" data-student-id="${escHtml(s.id)}" data-status="${st}" aria-pressed="${on}"
                class="px-2.5 py-1.5 rounded-lg border text-[11px] font-black transition"
                style="${on ? `background:${m.on};color:#fff;border-color:${m.on};` : 'background:#fff;color:#94a3b8;border-color:#e2e8f0;'}">${m.label}</button>`;
        }).join('');
        return `
        <div class="flex items-center justify-between gap-3 px-5 py-3 border-b border-slate-100 last:border-b-0 flex-wrap">
            <div class="min-w-0">
                <p class="font-black text-slate-700 text-sm truncate">${escHtml(s.name)}</p>
                <p class="text-[11px] text-slate-400 font-bold font-mono">${escHtml(s.id)}${current ? '' : ' · <span class="text-slate-400">not marked</span>'}</p>
            </div>
            <div class="flex items-center gap-1.5 flex-wrap" role="radiogroup" aria-label="Attendance for ${escHtml(s.name)}">${buttons}</div>
        </div>`;
    }).join('');
}

// ── 6. SAVE (one student per tap) ─────────────────────────────────────────
async function setStatus(studentId, status) {
    if (!ATTENDANCE_STATUSES.includes(status) || records[studentId]?.status === status) return;
    const classId = selectedClassId;
    const date = els.attDate.value;
    const token = viewToken;
    const before = records[studentId];
    const now = new Date().toISOString();
    const entry = { status, markedAt: now, markedBy: actorId(), byAdmin: true };

    records[studentId] = entry;
    renderRoster();
    pendingWrites++;
    setSaveState('saving');

    const write = setDoc(doc(db, 'schools', session.schoolId, 'classes', classId, 'attendance', date), {
        date, classId,
        records: { [studentId]: entry },
        updatedAt: now,
        updatedBy: actorId(),
    }, { merge: true });

    const timeout = new Promise(res => setTimeout(() => res('timeout'), SAVE_TIMEOUT_MS));
    write.then(() => {
        pendingWrites--;
        if (token !== viewToken) return;
        els.attDayMeta.textContent = `Last updated ${new Date(now).toLocaleString()}`;
        if (!pendingWrites) setSaveState('saved');
    }).catch(err => {
        pendingWrites--;
        console.error('[Admin Attendance] save:', err);
        if (token !== viewToken) return;
        if (before) records[studentId] = before; else delete records[studentId];
        renderRoster();
        setSaveState('error', err && err.code === 'permission-denied'
            ? 'Not saved — your account is not allowed to change this record'
            : 'Not saved — please try again');
    });
    if (await Promise.race([write.then(() => 'ok', () => 'err'), timeout]) === 'timeout' && token === viewToken && pendingWrites) {
        setSaveState('offline');
    }
}

init();
