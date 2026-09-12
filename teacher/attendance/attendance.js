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

function showEmptyState(message, opts) {
    els.attLoader?.classList.add('hidden');
    els.attBody?.classList.add('hidden');
    if (els.attEmpty) {
        els.attEmpty.textContent = message;
        els.attEmpty.classList.remove('hidden');
    }
    // Roster/save controls otherwise stay live even with no roster loaded
    // (they're outside attBody in the markup) — an uncached-while-offline
    // date has no known-good statusMap to save, so make that explicit rather
    // than leaving a clickable button that would silently no-op.
    const disableControls = !!(opts && opts.disableControls);
    if (els.saveAttendanceBtn) els.saveAttendanceBtn.disabled = disableControls;
    if (els.markAllPresentBtn) els.markAllPresentBtn.disabled = disableControls;
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
        if (els.saveAttendanceBtn) els.saveAttendanceBtn.disabled = false;
        if (els.markAllPresentBtn) els.markAllPresentBtn.disabled = false;
        renderRoster();
    } catch (e) {
        console.error('[Attendance] loadAndRender:', e);
        // A Firestore read (roster query or the attendance-day doc) can fail
        // with code 'unavailable' for two different reasons: a genuine
        // network/server problem, or — while offline — simply because this
        // particular document was never cached locally (setDoc queues while
        // offline, but getDoc/getDocs reject immediately for anything not
        // already in the local cache). We only want to show the friendlier
        // "you're offline" message for that second case, and we check the
        // error's stable `.code` field rather than matching on message text,
        // since Firestore doesn't guarantee that string stays put across SDK
        // versions and a looser match could mask a real bug as "offline".
        if (e && e.code === 'unavailable') {
            showEmptyState('You are currently offline. Please reconnect to load attendance for this date.', { disableControls: true });
        } else {
            showEmptyState('Something went wrong loading attendance for this class/date. Please try again.', { disableControls: true });
        }
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
// setDoc() does not resolve optimistically against the local cache — even
// with persistentLocalCache enabled, the promise only settles once the
// server acknowledges the write. While offline that means it never settles
// on its own. So the save is raced against a short timeout: if the server
// hasn't ack'd within SAVE_TIMEOUT_MS we assume the write is queued locally
// (Firestore will flush it once connectivity returns) and tell the teacher
// that, rather than leaving the button spinning forever. The real promise
// is never abandoned — it keeps running in the background, and if it
// resolves (or rejects) later while the teacher is still on this same
// class+date, the UI is reconciled to the true end state at that point.
const SAVE_TIMEOUT_MS = 2500;

function showToast(message, kind) {
    let toast = document.getElementById('attOfflineToast');
    if (!toast) {
        toast = document.createElement('div');
        toast.id = 'attOfflineToast';
        toast.className = 'fixed bottom-6 right-6 z-50 max-w-xs px-4 py-3 rounded-xl shadow-lg text-sm font-bold transition-opacity duration-300';
        document.body.appendChild(toast);
    }
    const palette = {
        offline: 'bg-amber-500 text-white',
        success: 'bg-emerald-600 text-white',
        error:   'bg-red-600 text-white',
    };
    toast.className = `fixed bottom-6 right-6 z-50 max-w-xs px-4 py-3 rounded-xl shadow-lg text-sm font-bold transition-opacity duration-300 ${palette[kind] || palette.offline}`;
    toast.textContent = message;
    toast.style.opacity = '1';
    clearTimeout(window.__attToastTimer);
    window.__attToastTimer = setTimeout(() => { toast.style.opacity = '0'; }, 4500);
}

function applySavedResult(saved) {
    existingDayDoc = saved;
    dirty = false;
    els.attLastSaved.textContent = `Last saved ${new Date(saved.updatedAt).toLocaleString()}`;
}

async function saveAttendance() {
    if (!selectedClassId || !els.attDate.value || !rosterForClass.length) return;
    const date = els.attDate.value;
    const classIdAtSaveTime = selectedClassId;
    const dateAtSaveTime = date;

    els.saveAttendanceBtn.disabled = true;
    els.saveAttendanceBtn.innerHTML = '<i class="fa-solid fa-spinner fa-spin mr-2"></i> Saving...';

    const now = new Date().toISOString();
    const records = {};
    rosterForClass.forEach(s => {
        records[s.id] = { status: statusMap[s.id], markedAt: now, markedBy: session.teacherId };
    });

    const savePromise = saveAttendanceForDate(session.schoolId, selectedClassId, date, records, session.teacherId);
    let settledWithinTimeout = false;

    // Whenever the real save eventually settles — whether that's within the
    // timeout window or long after, once connectivity returns — reconcile
    // state. If it settles AFTER the timeout branch already told the teacher
    // "Saved Offline (Will Sync)", surface the now-confirmed outcome (only
    // when they're still looking at this same class+date); if it settles
    // within the window, the try/await below already reports it, so this
    // handler just applies the result without re-announcing it.
    savePromise.then(saved => {
        applySavedResult(saved);
        if (!settledWithinTimeout && selectedClassId === classIdAtSaveTime && els.attDate.value === dateAtSaveTime) {
            els.attSaveMsg.textContent = 'Attendance saved.';
            els.attSaveMsg.className = 'text-sm font-bold p-2.5 mt-2 rounded-xl text-center text-green-700 bg-green-100 border border-green-200';
            els.attSaveMsg.classList.remove('hidden');
            clearTimeout(window.__attSaveMsgTimer);
            window.__attSaveMsgTimer = setTimeout(() => els.attSaveMsg.classList.add('hidden'), 3500);
            showToast('Attendance synced.', 'success');
        }
    }).catch(e => {
        console.error('[Attendance] saveAttendance (background):', e);
        if (!settledWithinTimeout && selectedClassId === classIdAtSaveTime && els.attDate.value === dateAtSaveTime) {
            els.attSaveMsg.textContent = 'Could not save attendance. Please try again.';
            els.attSaveMsg.className = 'text-sm font-bold p-2.5 mt-2 rounded-xl text-center text-red-700 bg-red-100 border border-red-200';
            els.attSaveMsg.classList.remove('hidden');
        }
    });

    const timeout = new Promise((_, reject) => setTimeout(() => reject(new Error('SAVE_TIMEOUT')), SAVE_TIMEOUT_MS));

    try {
        const saved = await Promise.race([savePromise, timeout]);
        settledWithinTimeout = true;
        applySavedResult(saved);

        els.attSaveMsg.textContent = 'Attendance saved.';
        els.attSaveMsg.className = 'text-sm font-bold p-2.5 mt-2 rounded-xl text-center text-green-700 bg-green-100 border border-green-200';
        els.attSaveMsg.classList.remove('hidden');
        clearTimeout(window.__attSaveMsgTimer);
        window.__attSaveMsgTimer = setTimeout(() => els.attSaveMsg.classList.add('hidden'), 3500);

        els.saveAttendanceBtn.disabled = false;
        els.saveAttendanceBtn.innerHTML = '<i class="fa-solid fa-floppy-disk mr-2"></i> Save Attendance';
    } catch (e) {
        if (e && e.message === 'SAVE_TIMEOUT') {
            // Likely offline: the write is queued locally and will flush on
            // reconnect (handled by the .then()/.catch() above). Don't leave
            // the teacher staring at a spinner — tell them it's safe to move on.
            dirty = false;
            els.attSaveMsg.textContent = 'Saved Offline (Will Sync)';
            els.attSaveMsg.className = 'text-sm font-bold p-2.5 mt-2 rounded-xl text-center text-amber-700 bg-amber-100 border border-amber-200';
            els.attSaveMsg.classList.remove('hidden');
            showToast('You appear to be offline. Attendance is saved on this device and will sync automatically once you’re back online. It’s safe to close this page.', 'offline');

            els.saveAttendanceBtn.disabled = false;
            els.saveAttendanceBtn.innerHTML = '<i class="fa-solid fa-floppy-disk mr-2"></i> Save Attendance';
        } else {
            console.error('[Attendance] saveAttendance:', e);
            els.attSaveMsg.textContent = 'Could not save attendance. Please try again.';
            els.attSaveMsg.className = 'text-sm font-bold p-2.5 mt-2 rounded-xl text-center text-red-700 bg-red-100 border border-red-200';
            els.attSaveMsg.classList.remove('hidden');

            els.saveAttendanceBtn.disabled = false;
            els.saveAttendanceBtn.innerHTML = '<i class="fa-solid fa-floppy-disk mr-2"></i> Save Attendance';
        }
    }
}

init();
