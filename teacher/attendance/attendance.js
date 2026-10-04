// ── MODULE 4: DAILY ROLL CALL (teacher) ──────────────────────────────────
// One document per class per day (unchanged data model, see
// assets/js/attendance.js):
//   schools/{schoolId}/classes/{classId}/attendance/{YYYY-MM-DD}
//   { date, classId, records: { [studentId]: { status, markedAt, markedBy } }, updatedAt, updatedBy }
//
// AUTOSAVE: every status tap writes immediately — a merge write of just that
// student's entry (records.<studentId>), so there is no Save button and no
// risk of one tap overwriting another. The first write of a day records the
// whole roster (everyone defaults to Present) so a taken day is complete.
//
// LOCK (mirrors firestore.rules attendance block): teachers may edit today
// only; past dates open read-only with a "Locked" badge. Admin tokens
// (role super_admin / sub_admin) keep edit access to past dates. Future
// dates can't be picked. The rules remain the real enforcement — a write
// they reject is reverted on screen.
//
// Stored status values stay 'present' | 'absent' | 'tardy' | 'excused'
// (reports, fan-out and the student/parent views read these). 'tardy' is
// labelled "Late" in this UI.
import { db, auth } from '../../assets/js/firebase-init.js';
import { collection, doc, getDocs, setDoc, query, where } from "https://www.gstatic.com/firebasejs/10.7.1/firebase-firestore.js";
import { requireAuth } from '../../assets/js/auth.js';
import { injectTeacherLayout } from '../../assets/js/layout-teachers.js';
import { loadSchoolClasses, resolveClassNamesToIds } from '../../assets/js/utils.js';
import { ATTENDANCE_STATUSES, loadAttendanceForDate } from '../../assets/js/attendance.js';

// ── 1. AUTH & LAYOUT ──────────────────────────────────────────────────────
const session = requireAuth('teacher', '../login.html');
if (session) {
    injectTeacherLayout('attendance', 'Attendance', 'Mark daily attendance for your class', false);
}

// ── 2. STATE ──────────────────────────────────────────────────────────────
let resolvedClasses = [];   // [{ id, name }]
let selectedClassId = '';
let rosterForClass  = [];   // active students in the selected class
let statusMap       = {};   // { studentId: status } as shown on screen
let dayExists       = false; // a doc for this class+date has been written
let isAdmin         = false; // token role is super_admin / sub_admin
let locked          = false; // current view is read-only
let viewToken       = 0;     // bumps on every class/date change; stale async results are ignored
let pendingWrites   = 0;

const SAVE_TIMEOUT_MS = 2500;

const STATUS_META = {
    present: { label: 'Present', icon: 'fa-check',          dot: '#059669', on: 'bg-emerald-600 text-white border-emerald-600', chip: 'bg-emerald-50 text-emerald-700 border-emerald-200' },
    absent:  { label: 'Absent',  icon: 'fa-xmark',          dot: '#dc2626', on: 'bg-red-600 text-white border-red-600',         chip: 'bg-red-50 text-red-700 border-red-200' },
    tardy:   { label: 'Late',    icon: 'fa-clock',          dot: '#f59e0b', on: 'bg-amber-500 text-white border-amber-500',     chip: 'bg-amber-50 text-amber-700 border-amber-200' },
    excused: { label: 'Excused', icon: 'fa-file-signature', dot: '#64748b', on: 'bg-slate-500 text-white border-slate-500',     chip: 'bg-slate-50 text-slate-600 border-slate-200' },
};

const els = {};

function escHtml(str) {
    if (!str) return '';
    return String(str).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;').replace(/'/g, '&#039;');
}

function ymd(d) {
    return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
}
function todayStr() { return ymd(new Date()); }
function shiftDate(dateStr, days) {
    const [y, m, d] = dateStr.split('-').map(Number);
    return ymd(new Date(y, m - 1, d + days));
}
function prettyDate(dateStr) {
    const [y, m, d] = dateStr.split('-').map(Number);
    return new Date(y, m - 1, d).toLocaleDateString(undefined, { weekday: 'long', month: 'short', day: 'numeric', year: 'numeric' });
}

function dayRef(classId, date) {
    return doc(db, 'schools', session.schoolId, 'classes', classId, 'attendance', date);
}

// ── 3. INIT ───────────────────────────────────────────────────────────────
async function init() {
    if (!session) return;
    cacheEls();
    wireEvents();
    els.attDate.value = todayStr();
    els.attDate.max = todayStr();

    const [, adminFlag] = await Promise.all([
        (async () => {
            try {
                const classNames = session.teacherData.classes || [session.teacherData.className || ''];
                const schoolClasses = await loadSchoolClasses(session.schoolId);
                resolvedClasses = resolveClassNamesToIds(classNames, schoolClasses).resolved;
            } catch (e) {
                console.error('[Attendance] Failed to resolve classes:', e);
            }
        })(),
        resolveIsAdmin(),
    ]);
    isAdmin = adminFlag;

    if (!resolvedClasses.length) {
        showEmptyState('You have no active classes assigned. Contact your administrator to assign classes to your account.');
        return;
    }

    els.classPicker.innerHTML = resolvedClasses.map(c => `<option value="${escHtml(c.id)}">${escHtml(c.name)}</option>`).join('');
    selectedClassId = resolvedClasses[0].id;
    els.classPicker.value = selectedClassId;

    await loadAndRender();
}

// Admin privilege comes from the live ID token's role claim (the same claim
// firestore.rules' isSchoolAdmin() checks), never from localStorage.
async function resolveIsAdmin() {
    try {
        if (auth.authStateReady) await auth.authStateReady();
        if (!auth.currentUser) return false;
        const { claims } = await auth.currentUser.getIdTokenResult();
        return ['super_admin', 'sub_admin'].includes(claims.role) && claims.schoolId === session.schoolId;
    } catch (e) {
        console.error('[Attendance] token check:', e);
        return false;
    }
}

function cacheEls() {
    ['classPicker', 'attDate', 'attPrevDay', 'attNextDay', 'attTodayBtn', 'attLoader', 'attBody', 'attEmpty',
     'markAllPresentBtn', 'attSaveMsg', 'attLastSaved', 'attSummary', 'attLockBadge', 'attSaveState'
    ].forEach(id => { els[id] = document.getElementById(id); });
}

function setDate(dateStr) {
    if (!dateStr) return;
    els.attDate.value = dateStr > todayStr() ? todayStr() : dateStr;
    loadAndRender();
}

function wireEvents() {
    els.classPicker.addEventListener('change', () => {
        selectedClassId = els.classPicker.value;
        loadAndRender();
    });
    els.attDate.addEventListener('change', () => setDate(els.attDate.value));
    els.attPrevDay.addEventListener('click', () => setDate(shiftDate(els.attDate.value || todayStr(), -1)));
    els.attNextDay.addEventListener('click', () => setDate(shiftDate(els.attDate.value || todayStr(), 1)));
    els.attTodayBtn.addEventListener('click', () => setDate(todayStr()));
    els.markAllPresentBtn.addEventListener('click', markAllPresent);
    els.attBody.addEventListener('click', (e) => {
        const btn = e.target.closest('[data-status]');
        if (!btn || btn.disabled) return;
        setStatus(btn.dataset.studentId, btn.dataset.status);
    });
    window.addEventListener('beforeunload', (e) => {
        if (pendingWrites > 0) { e.preventDefault(); e.returnValue = ''; }
    });
}

function showEmptyState(message) {
    els.attLoader?.classList.add('hidden');
    els.attBody?.classList.add('hidden');
    els.attSummary.innerHTML = '';
    if (els.markAllPresentBtn) els.markAllPresentBtn.disabled = true;
    if (els.attEmpty) {
        els.attEmpty.textContent = message;
        els.attEmpty.classList.remove('hidden');
    }
}

// ── 4. LOAD ROSTER + THE DAY'S DOC ────────────────────────────────────────
async function loadAndRender() {
    if (!selectedClassId || !els.attDate.value) return;
    const token = ++viewToken;
    const cls = resolvedClasses.find(c => c.id === selectedClassId);
    const date = els.attDate.value;

    locked = date < todayStr() && !isAdmin;
    els.attNextDay.disabled = date >= todayStr();
    renderLockBadge(date);
    setSaveState('idle');
    els.attSaveMsg.classList.add('hidden');
    els.attEmpty.classList.add('hidden');
    els.attBody.classList.add('hidden');
    els.attLoader.classList.remove('hidden');

    try {
        const [snap, dayDoc] = await Promise.all([
            getDocs(query(collection(db, 'students'),
                where('currentSchoolId', '==', session.schoolId),
                where('enrollmentStatus', '==', 'Active'))),
            loadAttendanceForDate(session.schoolId, selectedClassId, date),
        ]);
        if (token !== viewToken) return;

        // Roster source of truth = the student's classId (className fallback
        // for legacy records that predate classId).
        rosterForClass = snap.docs
            .map(d => ({ id: d.id, ...d.data() }))
            .filter(s => s.classId ? s.classId === selectedClassId : (!!cls && s.className === cls.name))
            .sort((a, b) => (a.name || '').localeCompare(b.name || ''));

        dayExists = !!dayDoc.updatedAt;
        statusMap = {};
        // Untaken editable day: pre-fill Present (saved on the first tap).
        // Untaken locked day: show everyone as Unmarked — nothing was recorded.
        rosterForClass.forEach(s => { statusMap[s.id] = dayDoc.records?.[s.id]?.status || (dayExists || locked ? '' : 'present'); });
        els.attLastSaved.textContent = dayExists
            ? `Last updated ${new Date(dayDoc.updatedAt).toLocaleString()}`
            : (locked ? 'Attendance was not taken on this date' : 'Not taken yet — tap a status to start');

        if (!rosterForClass.length) {
            showEmptyState(`No active students on the roster for ${cls?.name || 'this class'}.`);
            return;
        }

        els.attLoader.classList.add('hidden');
        els.attBody.classList.remove('hidden');
        els.markAllPresentBtn.disabled = locked;
        renderRoster();
    } catch (e) {
        if (token !== viewToken) return;
        console.error('[Attendance] loadAndRender:', e);
        showEmptyState(e && e.code === 'unavailable'
            ? 'You are currently offline. Please reconnect to load attendance for this date.'
            : 'Something went wrong loading attendance for this class/date. Please try again.');
    }
}

// ── 5. RENDER ─────────────────────────────────────────────────────────────
function renderLockBadge(date) {
    const b = els.attLockBadge;
    const past = date < todayStr();
    if (!past) { b.classList.add('hidden'); return; }
    if (isAdmin) {
        b.className = 'inline-flex items-center gap-1.5 text-[11px] font-black uppercase tracking-wider px-2.5 py-1 rounded-lg border bg-indigo-50 text-indigo-700 border-indigo-200';
        b.innerHTML = '<i class="fa-solid fa-user-shield"></i> Past date · Admin edit';
        b.title = '';
    } else {
        b.className = 'inline-flex items-center gap-1.5 text-[11px] font-black uppercase tracking-wider px-2.5 py-1 rounded-lg border bg-slate-100 text-slate-600 border-slate-300';
        b.innerHTML = '<i class="fa-solid fa-lock"></i> Locked';
        b.title = 'Past attendance is read-only. Ask an administrator to make corrections.';
    }
}

function renderSummary() {
    const counts = { present: 0, absent: 0, tardy: 0, excused: 0 };
    let unmarked = 0;
    rosterForClass.forEach(s => {
        const st = statusMap[s.id];
        if (counts[st] !== undefined) counts[st]++; else unmarked++;
    });
    const chips = ATTENDANCE_STATUSES.map(st => `
        <span class="inline-flex items-center gap-1.5 px-3 py-1.5 rounded-xl border text-[13px] font-black ${STATUS_META[st].chip}">
            <span class="w-2 h-2 rounded-full" style="background:${STATUS_META[st].dot}"></span>
            ${STATUS_META[st].label}: <span class="font-mono" data-count="${st}">${counts[st]}</span>
        </span>`).join('');
    els.attSummary.innerHTML = `
        <div class="flex flex-wrap items-center gap-2 bg-slate-50 border border-slate-200 rounded-xl px-3 py-2.5">
            <span class="text-[11px] font-black uppercase tracking-wider text-slate-500 mr-1">${escHtml(prettyDate(els.attDate.value))}</span>
            ${chips}
            ${unmarked ? `<span class="inline-flex items-center gap-1.5 px-3 py-1.5 rounded-xl border text-[13px] font-black bg-white text-slate-400 border-dashed border-slate-300">Unmarked: <span class="font-mono">${unmarked}</span></span>` : ''}
            <span class="ml-auto text-[12px] font-bold text-slate-400">${rosterForClass.length} student${rosterForClass.length === 1 ? '' : 's'}</span>
        </div>`;
}

function renderRoster() {
    renderSummary();
    els.attBody.innerHTML = rosterForClass.map(s => {
        const current = statusMap[s.id];
        return `
        <div class="bg-white border border-slate-200 rounded-2xl shadow-sm p-3.5" data-row="${escHtml(s.id)}">
            <div class="flex items-center gap-2.5 mb-2.5">
                <div class="w-8 h-8 rounded-full flex items-center justify-center text-white text-xs font-black flex-shrink-0" style="background:${current ? STATUS_META[current].dot : '#cbd5e1'}">${escHtml((s.name || '?').charAt(0).toUpperCase())}</div>
                <div class="min-w-0">
                    <p class="font-black text-slate-700 text-sm truncate m-0">${escHtml(s.name)}</p>
                    <p class="text-[10.5px] text-slate-400 font-bold font-mono m-0">${escHtml(s.id)}</p>
                </div>
            </div>
            <div class="grid grid-cols-4 gap-1.5" role="radiogroup" aria-label="Attendance for ${escHtml(s.name)}">
                ${ATTENDANCE_STATUSES.map(st => `
                    <button type="button" data-student-id="${escHtml(s.id)}" data-status="${st}" role="radio" aria-checked="${current === st}"
                        ${locked ? 'disabled' : ''}
                        class="flex flex-col items-center justify-center gap-0.5 py-1.5 rounded-lg border text-[10.5px] font-black transition ${current === st ? STATUS_META[st].on : 'bg-white border-slate-200 text-slate-400'} ${locked ? 'cursor-not-allowed opacity-70' : (current === st ? '' : 'hover:border-slate-300 hover:text-slate-600')}">
                        <i class="fa-solid ${STATUS_META[st].icon} text-[11px]"></i>${STATUS_META[st].label}
                    </button>`).join('')}
            </div>
        </div>`;
    }).join('');
}

// ── 6. AUTOSAVE ───────────────────────────────────────────────────────────
function setSaveState(kind, text) {
    const map = {
        idle:    ['text-slate-400', locked ? 'Read-only' : 'Changes save automatically'],
        saving:  ['text-slate-500', '<i class="fa-solid fa-circle-notch fa-spin mr-1"></i>Saving…'],
        saved:   ['text-emerald-600', '<i class="fa-solid fa-check mr-1"></i>All changes saved'],
        offline: ['text-amber-600', '<i class="fa-solid fa-wifi mr-1"></i>Saved offline · will sync'],
        error:   ['text-red-600', '<i class="fa-solid fa-triangle-exclamation mr-1"></i>' + escHtml(text || 'Could not save')],
    };
    const [cls, html] = map[kind] || map.idle;
    els.attSaveState.className = `text-xs font-bold mt-1.5 ${cls}`;
    els.attSaveState.innerHTML = html;
}

// Writes `changes` ({ studentId: status }) for the current class+date with
// merge, so only those students' entries change. Past SAVE_TIMEOUT_MS
// without a server ack the write is treated as queued offline (Firestore
// flushes it on reconnect).
async function writeRecords(changes, { onFail }) {
    const classId = selectedClassId;
    const date = els.attDate.value;
    const token = viewToken;
    const now = new Date().toISOString();
    const records = {};
    Object.entries(changes).forEach(([sid, status]) => {
        records[sid] = { status, markedAt: now, markedBy: session.teacherId };
    });

    const payload = { date, classId, records, updatedAt: now, updatedBy: session.teacherId };
    dayExists = true;
    pendingWrites++;
    setSaveState('saving');

    const write = setDoc(dayRef(classId, date), payload, { merge: true });
    const timeout = new Promise(res => setTimeout(() => res('timeout'), SAVE_TIMEOUT_MS));
    write.then(() => {
        pendingWrites--;
        if (token !== viewToken) return;
        els.attLastSaved.textContent = `Last updated ${new Date(now).toLocaleString()}`;
        if (!pendingWrites) setSaveState('saved');
    }).catch(err => {
        pendingWrites--;
        console.error('[Attendance] autosave:', err);
        if (token !== viewToken) return;
        onFail();
        setSaveState('error', err && err.code === 'permission-denied'
            ? 'Not saved — this date is locked'
            : 'Not saved — please try again');
    });
    if (await Promise.race([write.then(() => 'ok', () => 'err'), timeout]) === 'timeout' && token === viewToken && pendingWrites) {
        setSaveState('offline');
    }
}

function setStatus(studentId, status) {
    if (locked || !ATTENDANCE_STATUSES.includes(status) || statusMap[studentId] === status) return;
    const firstWrite = !dayExists;
    const before = { ...statusMap };
    statusMap[studentId] = status;
    renderRoster();

    // First write of the day records the whole roster (defaults = Present)
    // so the day is complete; afterwards only the tapped student is sent.
    const changes = firstWrite ? { ...statusMap } : { [studentId]: status };
    writeRecords(changes, {
        onFail: () => {
            statusMap[studentId] = before[studentId];
            if (firstWrite) dayExists = false;
            renderRoster();
        },
    });
}

function markAllPresent() {
    if (locked || !rosterForClass.length) return;
    const firstWrite = !dayExists;
    const before = { ...statusMap };
    const changes = {};
    rosterForClass.forEach(s => {
        if (firstWrite || statusMap[s.id] !== 'present') changes[s.id] = 'present';
        statusMap[s.id] = 'present';
    });
    renderRoster();
    if (!Object.keys(changes).length) { setSaveState('saved'); return; }
    writeRecords(changes, {
        onFail: () => {
            Object.keys(changes).forEach(sid => { statusMap[sid] = before[sid]; });
            if (firstWrite) dayExists = false;
            renderRoster();
        },
    });
}

init();
