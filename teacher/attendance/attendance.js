// ── PHASE 1 MILESTONE 6: ATTENDANCE (teacher write flow) ─────────────────
// Roster-checklist UX, deliberately modeled on grade_form.js's roster list:
// familiar to any teacher who has already used this app to enter grades.
// The key difference from grading is the write shape — every student's
// status for the day is held in memory (statusMap) and committed in ONE
// setDoc when "Save Attendance" is clicked, via the shared
// saveAttendanceForDate() helper in assets/js/attendance.js. That one write
// per class per day is the whole point of the approved data model.
import { db } from '../../assets/js/firebase-init.js';
import { collection, getDocs, query, where } from "https://www.gstatic.com/firebasejs/10.7.1/firebase-firestore.js";
import { requireAuth } from '../../assets/js/auth.js';
import { injectTeacherLayout } from '../../assets/js/layout-teachers.js';
import { loadSchoolClasses, resolveClassNamesToIds } from '../../assets/js/utils.js';
import { ATTENDANCE_STATUSES, loadAttendanceForDate, saveAttendanceForDate } from '../../assets/js/attendance.js';

// ── 1. AUTH & LAYOUT ──────────────────────────────────────────────────────
const session = requireAuth('teacher', '../login.html');
if (session) {
    injectTeacherLayout('attendance', 'Attendance', 'Mark daily attendance for your class', false);
}

// ── 2. STATE ──────────────────────────────────────────────────────────────
let resolvedClasses = [];      // [{ id, name }] — this teacher's classes resolved against real class docs
let selectedClassId = '';
let rosterForClass   = [];     // students on the roster for the selected class
let statusMap        = {};     // { studentId: 'present' | 'absent' | 'tardy' | 'excused' }
let existingDayDoc    = null;  // whatever loadAttendanceForDate() returned for the current class+date
let dirty             = false; // true once the teacher has changed anything since the last save

const STATUS_META = {
    present: { label: 'Present', short: 'P', activeClass: 'bg-emerald-600 text-white border-emerald-600' },
    absent:  { label: 'Absent',  short: 'A', activeClass: 'bg-red-600 text-white border-red-600' },
    tardy:   { label: 'Tardy',   short: 'T', activeClass: 'bg-amber-500 text-white border-amber-500' },
    excused: { label: 'Excused', short: 'E', activeClass: 'bg-slate-500 text-white border-slate-500' },
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
        const classNames = session.teacherData.classes || [session.teacherData.className || ''];
        const schoolClasses = await loadSchoolClasses(session.schoolId);
        resolvedClasses = resolveClassNamesToIds(classNames, schoolClasses).resolved;
    } catch (e) {
        console.error('[Attendance] Failed to resolve classes:', e);
    }

    if (!resolvedClasses.length) {
        showEmptyState('You have no active classes assigned. Contact your administrator to assign classes to your account.');
        return;
    }

    els.classPicker.innerHTML = resolvedClasses.map(c => `<option value="${escHtml(c.id)}">${escHtml(c.name)}</option>`).join('');
    selectedClassId = resolvedClasses[0].id;
    els.classPicker.value = selectedClassId;

    await loadAndRender();
}

function cacheEls() {
    ['classPicker', 'attDate', 'attLoader', 'attBody', 'attEmpty',
     'markAllPresentBtn', 'saveAttendanceBtn', 'attSaveMsg', 'attLastSaved', 'attSummary'
    ].forEach(id => { els[id] = document.getElementById(id); });
}

function wireEvents() {
    els.classPicker.addEventListener('change', () => {
        selectedClassId = els.classPicker.value;
        loadAndRender();
    });
    els.attDate.addEventListener('change', () => loadAndRender());
    els.markAllPresentBtn.addEventListener('click', () => {
        rosterForClass.forEach(s => { statusMap[s.id] = 'present'; });
        dirty = true;
        renderRoster();
    });
    els.saveAttendanceBtn.addEventListener('click', saveAttendance);
}

function showEmptyState(message) {
    els.attLoader?.classList.add('hidden');
    els.attBody?.classList.add('hidden');
    if (els.attEmpty) {
        els.attEmpty.textContent = message;
        els.attEmpty.classList.remove('hidden');
    }
}

// ── 4. LOAD ROSTER + EXISTING ATTENDANCE FOR THE SELECTED CLASS+DATE ─────
async function loadAndRender() {
    if (!selectedClassId || !els.attDate.value) return;

    els.attEmpty?.classList.add('hidden');
    els.attBody?.classList.add('hidden');
    els.attLoader?.classList.remove('hidden');
    els.attSaveMsg?.classList.add('hidden');
    dirty = false;

    const cls = resolvedClasses.find(c => c.id === selectedClassId);
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
            .filter(s => s.teacherId === session.teacherId && s.className === cls?.name)
            .sort((a, b) => (a.name || '').localeCompare(b.name || ''));

        existingDayDoc = await loadAttendanceForDate(session.schoolId, selectedClassId, date);

        statusMap = {};
        rosterForClass.forEach(s => {
            statusMap[s.id] = existingDayDoc.records?.[s.id]?.status || 'present';
        });

        els.attLastSaved.textContent = existingDayDoc.updatedAt
            ? `Last saved ${new Date(existingDayDoc.updatedAt).toLocaleString()}`
            : 'Not yet taken for this date';

        if (!rosterForClass.length) {
            showEmptyState(`No active students on the roster for ${cls?.name || 'this class'}.`);
            return;
        }

        els.attLoader.classList.add('hidden');
        els.attBody.classList.remove('hidden');
        renderRoster();
    } catch (e) {
        console.error('[Attendance] loadAndRender:', e);
        showEmptyState('Something went wrong loading attendance for this class/date. Please try again.');
    }
}

// ── 5. RENDER ─────────────────────────────────────────────────────────────
function renderRoster() {
    const counts = { present: 0, absent: 0, tardy: 0, excused: 0 };
    rosterForClass.forEach(s => { counts[statusMap[s.id]] = (counts[statusMap[s.id]] || 0) + 1; });

    els.attSummary.innerHTML = ATTENDANCE_STATUSES.map(st => `
        <span class="text-xs font-black text-slate-500">
            <span class="inline-block w-2 h-2 rounded-full mr-1" style="background:${st === 'present' ? '#059669' : st === 'absent' ? '#dc2626' : st === 'tardy' ? '#f59e0b' : '#64748b'}"></span>
            ${counts[st] || 0} ${STATUS_META[st].label}
        </span>`).join('<span class="text-slate-300">·</span>');

    els.attBody.innerHTML = rosterForClass.map(s => `
        <div class="flex items-center justify-between gap-3 px-4 py-3 border-b border-slate-100 last:border-b-0">
            <div class="min-w-0">
                <p class="font-black text-slate-700 text-sm truncate">${escHtml(s.name)}</p>
                <p class="text-[11px] text-slate-400 font-bold font-mono">${escHtml(s.id)}</p>
            </div>
            <div class="flex items-center gap-1.5 flex-shrink-0">
                ${ATTENDANCE_STATUSES.map(st => `
                    <button type="button" onclick="setAttendanceStatus('${s.id}','${st}')"
                        title="${STATUS_META[st].label}"
                        class="w-9 h-9 rounded-lg border text-xs font-black transition ${statusMap[s.id] === st ? STATUS_META[st].activeClass : 'bg-white border-slate-200 text-slate-400 hover:border-slate-300'}">
                        ${STATUS_META[st].short}
                    </button>`).join('')}
            </div>
        </div>`).join('');
}

window.setAttendanceStatus = function(studentId, status) {
    statusMap[studentId] = status;
    dirty = true;
    renderRoster();
};

// ── 6. SAVE (one write for the whole class+day) ──────────────────────────
async function saveAttendance() {
    if (!selectedClassId || !els.attDate.value || !rosterForClass.length) return;
    const date = els.attDate.value;

    els.saveAttendanceBtn.disabled = true;
    els.saveAttendanceBtn.innerHTML = '<i class="fa-solid fa-spinner fa-spin mr-2"></i> Saving...';

    try {
        const now = new Date().toISOString();
        const records = {};
        rosterForClass.forEach(s => {
            records[s.id] = { status: statusMap[s.id], markedAt: now, markedBy: session.teacherId };
        });

        const saved = await saveAttendanceForDate(session.schoolId, selectedClassId, date, records, session.teacherId);
        existingDayDoc = saved;
        dirty = false;

        els.attLastSaved.textContent = `Last saved ${new Date(saved.updatedAt).toLocaleString()}`;
        els.attSaveMsg.textContent = 'Attendance saved.';
        els.attSaveMsg.className = 'text-sm font-bold p-2.5 mt-2 rounded-xl text-center text-green-700 bg-green-100 border border-green-200';
        els.attSaveMsg.classList.remove('hidden');
        clearTimeout(window.__attSaveMsgTimer);
        window.__attSaveMsgTimer = setTimeout(() => els.attSaveMsg.classList.add('hidden'), 3500);
    } catch (e) {
        console.error('[Attendance] saveAttendance:', e);
        els.attSaveMsg.textContent = 'Could not save attendance. Please try again.';
        els.attSaveMsg.className = 'text-sm font-bold p-2.5 mt-2 rounded-xl text-center text-red-700 bg-red-100 border border-red-200';
        els.attSaveMsg.classList.remove('hidden');
    }

    els.saveAttendanceBtn.disabled = false;
    els.saveAttendanceBtn.innerHTML = '<i class="fa-solid fa-floppy-disk mr-2"></i> Save Attendance';
}

init();
