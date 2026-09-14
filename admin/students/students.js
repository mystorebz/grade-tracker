import { db, functions } from '../../assets/js/firebase-init.js';
import { collection, doc, getDoc, getDocs, setDoc, updateDoc, query, where, arrayUnion, writeBatch } from "https://www.gstatic.com/firebasejs/10.7.1/firebase-firestore.js"; // ── FIX: added writeBatch
import { httpsCallable } from "https://www.gstatic.com/firebasejs/10.7.1/firebase-functions.js";
import { requireAuth } from '../../assets/js/auth.js';
import { injectAdminLayout } from '../../assets/js/layout-admin.js';
import { openOverlay, closeOverlay, letterGrade, calculateWeightedAverage, resolveGradeWeights, loadSchoolWeightingIndex, getWeightingFromIndex } from '../../assets/js/utils.js';
import { sha256Trim } from '../../assets/js/crypto-utils.js';

// ── 1. INIT & AUTH ────────────────────────────────────────────────────────
const session = requireAuth('admin', '../login.html');
injectAdminLayout('students', 'School Directory', 'All enrolled students and their academic records', true, false);

// Parent email deduplication is handled exclusively server-side by the
// linkOrCreateParent Cloud Function (transactional find-or-create against
// the school-scoped parent_emails/{schoolId}_{normalizedEmail} index) —
// this client never writes to registered_emails for parent accounts.
const linkOrCreateParentFn  = httpsCallable(functions, 'linkOrCreateParent');
// Read-only preview in front of linkOrCreateParent — lets the "Manage
// Parent" tab below show a teacher/admin WHO they're about to link before
// committing to it, so a typo'd email gets caught rather than silently
// linking a student to the wrong family. See that function's own header
// comment in functions/index.js for why linkOrCreateParent alone can't
// serve this (it always performs the link-or-create action immediately).
const lookupParentByEmailFn = httpsCallable(functions, 'lookupParentByEmail');
// UI CORRECTION MANDATE: STUDENT PROFILE & PARENT MANAGEMENT — lets the
// Manage Parent tab show an already-linked parent's info instead of always
// starting from the search form, and lets an admin correct that parent's
// contact info in place. Both are Admin-SDK-only Cloud Functions (see their
// own header comments in functions/index.js) because parents/{parentId} has
// no client read/write access beyond a parent reading their own document.
const getLinkedParentForStudentFn = httpsCallable(functions, 'getLinkedParentForStudent');
const updateParentContactFn       = httpsCallable(functions, 'updateParentContact');

// ── 2. STATE ──────────────────────────────────────────────────────────────
let allStudentsCache       = [];
let allTeachersCache       = [];
let rawSemesters           = [];
let activeSemesterId       = '';   // resolved once at load for the end-of-term gate + missing-grade flag
let activeSemesterObj      = null; // the active semester record (for startDate/endDate)
let schoolClasses          = [];
let schoolClassDocs        = [];   // PASS B: [{id, name}] — same fetch as schoolClasses, keeps the real class-doc ID
let currentStudentId       = null;
let currentLinkedParentId  = null; // set by refreshManageParentTab(); null when no parent is linked
let currentStudentClass    = '';   // the open student's CURRENT class — Academic tab is scoped to this
let currentStudentGradesCache = [];
let currentStudentEvalsCache  = [];   // evaluations for the open student (Class History breakdown)
let currentTeacherWeights  = ['Test', 'Quiz', 'Assignment', 'Midterm Exam', 'Final Exam'];

const tbody              = document.getElementById('studentsTableBody');
const filterClassSelect  = document.getElementById('filterStudentClass');
const filterTeacherSelect = document.getElementById('filterStudentTeacher');
const searchInput        = document.getElementById('searchInput');

// ── 3. HELPERS ────────────────────────────────────────────────────────────
function generateStudentId() {
    const year   = String(new Date().getFullYear()).slice(-2);
    const chars  = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
    const suffix = Array.from({ length: 5 }, () => chars[Math.floor(Math.random() * chars.length)]).join('');
    return `S${year}-${suffix}`;
}

function generatePin() {
    // Students log in via student/login.html, whose PIN field is a hard
    // 4-digit input (maxlength="4", "4-DIGIT PIN" label) — this generator
    // must stay in sync with that. Teacher PINs are intentionally 6-digit
    // (see admin/teachers/teachers.js's own generatePin()); do not merge
    // the two without also changing the teacher login page's expectations.
    return String(Math.floor(1000 + Math.random() * 9000));
}

function escHtml(str) {
    if (!str) return '';
    return String(str).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}

function standingStyle(avg) {
    if (avg === null || avg === undefined) {
        return { accent: '#cbd5e1', badge: 'bg-slate-100 text-slate-400 border-slate-200', dot: '#cbd5e1', label: 'No grades yet' };
    }
    if (avg >= 75) return { accent: '#0ea871', badge: 'bg-green-50 text-green-700 border-green-200', dot: '#0ea871', label: 'Doing well' };
    if (avg >= 65) return { accent: '#f59e0b', badge: 'bg-amber-50 text-amber-700 border-amber-200', dot: '#f59e0b', label: 'Needs watch' };
    return { accent: '#e31b4a', badge: 'bg-red-50 text-red-700 border-red-200', dot: '#e31b4a', label: 'At risk' };
}

async function loadSchoolClasses() {
    try {
        const snap = await getDocs(collection(db, 'schools', session.schoolId, 'classes'));
        const sorted = snap.docs
            .map(d => ({ id: d.id, ...d.data() }))
            .sort((a, b) => (a.order ?? 0) - (b.order ?? 0) || (a.name || '').localeCompare(b.name || ''));
        schoolClassDocs = sorted.filter(c => c.name);
        schoolClasses   = sorted.map(c => c.name).filter(Boolean);
    } catch (e) {
        console.error('[Students] loadSchoolClasses:', e);
        schoolClasses   = [];
        schoolClassDocs = [];
    }
}

// PASS B: resolve a class NAME (what the UI works in) to its real class-doc
// ID (what teacherIds/classId live on). Returns '' if there's no matching
// class doc, rather than guessing.
function classIdForName(name) {
    if (!name) return '';
    return schoolClassDocs.find(c => c.name === name)?.id || '';
}

function getClassList(extra = []) {
    const merged = [...schoolClasses];
    extra.forEach(c => { if (c && !merged.includes(c)) merged.push(c); });
    return merged;
}

// ── 4. LOAD DATA ──────────────────────────────────────────────────────────
async function loadData() {
    try {
        const semSnap = await getDocs(collection(db, 'schools', session.schoolId, 'semesters'));
        rawSemesters  = semSnap.docs.map(d => ({ id: d.id, ...d.data() })).sort((a, b) => (a.order || 0) - (b.order || 0));
        // Resolve the active semester once (single read) for the end-of-term gate
        // and the per-student missing-grade flag — reused across the whole list.
        try {
            const schoolDoc = await getDoc(doc(db, 'schools', session.schoolId));
            if (schoolDoc.exists()) activeSemesterId = schoolDoc.data().activeSemesterId || '';
        } catch (e) {}
        activeSemesterObj = rawSemesters.find(s => s.id === activeSemesterId) || null;
    } catch (e) { console.error("Error loading semesters:", e); }

    await loadSchoolClasses();

    if (!tbody) return;
    tbody.innerHTML = `<tr><td colspan="5" class="px-6 py-16 text-center text-slate-400 font-semibold"><i class="fa-solid fa-spinner fa-spin text-blue-500 text-2xl mb-3 block"></i>Loading directory...</td></tr>`;

    try {
        const [sSnap, tSnap, weightingIndex] = await Promise.all([
            getDocs(query(collection(db, 'students'), where('currentSchoolId', '==', session.schoolId))),
            getDocs(query(collection(db, 'teachers'),  where('currentSchoolId', '==', session.schoolId))),
            loadSchoolWeightingIndex(session.schoolId)
        ]);

        const tm = {};
        allTeachersCache = [];
        tSnap.forEach(d => {
            tm[d.id] = d.data().name;
            if (!d.data().archived) allTeachersCache.push({ id: d.id, ...d.data() });
        });

        // ── FIX: dual-archive unification — a student can be archived via
        // either this portal (`archived: true`) or the teacher roster portal
        // (`enrollmentStatus` set to a non-Active value, e.g. 'Archived',
        // 'Transferred', 'Graduated', 'Expelled', 'Dropped Out'). Recognize
        // both signals so the directory stays consistent regardless of which
        // portal archived the student.
        allStudentsCache = sSnap.docs
            .filter(d => {
                const data = d.data();
                if (data.archived) return false;
                if (data.enrollmentStatus && data.enrollmentStatus !== 'Active') return false;
                return true;
            })
            .map(d => ({ id: d.id, ...d.data(), teacherName: tm[d.data().teacherId] || '—' }));

        // ── PHASE 0: resolved once per page load (passive display) from the
        // batch weighting index, never a per-teacher query — see utils.js.
        const teacherWeightsById = {};
        allTeachersCache.forEach(t => {
            teacherWeightsById[t.id] = getWeightingFromIndex(weightingIndex, t.id, t) || currentTeacherWeights;
        });
        await Promise.all(allStudentsCache.map(async s => {
            s.cumulativeAvg = null;
            s.missingFlag   = null;   // 'none' | 'thin' | null — active term only, no extra reads
            try {
                const gSnap = await getDocs(query(
                    collection(db, 'students', s.id, 'grades'),
                    where('schoolId', '==', session.schoolId)
                ));
                const grades = gSnap.docs.map(d => d.data());

                // Missing-grade flag for the ACTIVE term, from grades already fetched.
                // 'none' = no grades this term; 'thin' = a subject with only one grade this term.
                if (activeSemesterId) {
                    const termGrades = grades.filter(g => g.semesterId === activeSemesterId);
                    if (!termGrades.length) {
                        s.missingFlag = 'none';
                    } else {
                        const cnt = {};
                        termGrades.forEach(g => { const sub = g.subject || 'Uncategorized'; cnt[sub] = (cnt[sub] || 0) + 1; });
                        if (Object.values(cnt).some(n => n === 1)) s.missingFlag = 'thin';
                    }
                }

                if (!grades.length) return;

                const weights = teacherWeightsById[s.teacherId] || currentTeacherWeights;
                const bySubj = {};
                grades.forEach(g => {
                    const sub = g.subject || 'Uncategorized';
                    if (!bySubj[sub]) bySubj[sub] = [];
                    bySubj[sub].push(g);
                });

                let sumAvgs = 0, totalSubjs = 0;
                Object.values(bySubj).forEach(subGrades => {
                    const subAvg = calculateWeightedAverage(subGrades, weights);
                    if (subAvg !== null && subAvg !== undefined && !Number.isNaN(subAvg)) {
                        sumAvgs += subAvg;
                        totalSubjs++;
                    }
                });
                if (totalSubjs > 0) s.cumulativeAvg = Math.round(sumAvgs / totalSubjs);
            } catch (e) {}
        }));

        if (filterTeacherSelect && filterTeacherSelect.options.length <= 1) {
            filterTeacherSelect.innerHTML = '<option value="">All Teachers</option>' +
                allTeachersCache.map(t => `<option value="${t.id}">${t.name}</option>`).join('');
        }

        if (filterClassSelect && filterClassSelect.options.length <= 2) {
            const studentClasses = allStudentsCache.map(s => s.className).filter(Boolean);
            const classList = getClassList(studentClasses);
            filterClassSelect.innerHTML = '<option value="">All Classes</option><option value="unassigned">Unassigned Only</option>' +
                classList.map(c => `<option value="${escHtml(c)}">${escHtml(c)}</option>`).join('');
        }

        renderTable();
    } catch (e) {
        console.error("Error loading students:", e);
        if (tbody) tbody.innerHTML = `<tr><td colspan="5" class="px-6 py-16 text-center text-red-500 font-semibold">Failed to load directory data.</td></tr>`;
    }
}

// ── END-OF-TERM WINDOW ─────────────────────────────────────────────────────
// True when the active period ends within 7 days, or has already ended.
// Gates the missing-grade indicators so they only appear when relevant.
const ADMIN_PERIOD_WARN_DAYS = 7;
function isEndOfTermWindow() {
    if (!activeSemesterObj || !activeSemesterObj.endDate) return false;
    const startOfDay = d => new Date(d.getFullYear(), d.getMonth(), d.getDate());
    const today    = startOfDay(new Date());
    const end      = startOfDay(new Date(activeSemesterObj.endDate + 'T00:00:00'));
    const daysLeft = Math.round((end - today) / (1000 * 60 * 60 * 24));
    return daysLeft <= ADMIN_PERIOD_WARN_DAYS;
}

// ── 5. RENDER TABLE ───────────────────────────────────────────────────────
function renderTable() {
    if (!tbody) return;

    let filtered  = allStudentsCache;
    const filterT = filterTeacherSelect?.value || '';
    const filterC = filterClassSelect?.value   || '';
    const term    = searchInput?.value.toLowerCase() || '';

    if (filterT) filtered = filtered.filter(s => s.teacherId === filterT);
    if (filterC === 'unassigned') filtered = filtered.filter(s => !s.className || !s.teacherId);
    else if (filterC) filtered = filtered.filter(s => s.className === filterC);

    if (!filtered.length) {
        tbody.innerHTML = `<tr><td colspan="5" class="px-6 py-16 text-center text-slate-400 italic font-semibold">No students match the criteria.</td></tr>`;
        return;
    }

    tbody.innerHTML = filtered.map(s => {
        const classBadge   = s.className
            ? s.className
            : '<span class="bg-amber-100 text-amber-700 text-[10px] font-black px-2 py-0.5 rounded-md uppercase">Unassigned</span>';
        const displayStyle = (s.name || '').toLowerCase().includes(term) || s.id.toLowerCase().includes(term) ? '' : 'display:none;';

        const st = standingStyle(s.cumulativeAvg);
        const avgBadge = s.cumulativeAvg !== null && s.cumulativeAvg !== undefined
            ? `<span class="${st.badge} border font-black text-[10px] px-1.5 py-0.5 rounded">${s.cumulativeAvg}%</span>`
            : `<span class="${st.badge} border font-bold text-[9px] uppercase tracking-wide px-1.5 py-0.5 rounded">No grades</span>`;

        // Missing-grade indicator — only in the end-of-term window.
        let missingBadge = '';
        if (isEndOfTermWindow() && s.missingFlag) {
            missingBadge = s.missingFlag === 'none'
                ? `<span class="bg-red-50 text-red-700 border border-red-200 font-black text-[9px] uppercase tracking-wide px-1.5 py-0.5 rounded" title="No grades entered this period"><i class="fa-solid fa-circle-exclamation" style="margin-right:3px;"></i>No grades this term</span>`
                : `<span class="bg-amber-50 text-amber-700 border border-amber-200 font-black text-[9px] uppercase tracking-wide px-1.5 py-0.5 rounded" title="At least one subject has only a single grade this period"><i class="fa-solid fa-circle-half-stroke" style="margin-right:3px;"></i>Needs more grades</span>`;
        }

        return `
        <tr class="trow border-b border-slate-100 hover:bg-slate-50 transition" style="${displayStyle}box-shadow: inset 4px 0 0 ${st.accent};" title="${st.label}">
            <td class="px-6 py-4">
                <div class="flex items-center gap-3">
                    <span style="width:9px;height:9px;border-radius:9999px;background:${st.dot};flex-shrink:0" title="${st.label}"></span>
                    <div class="h-10 w-10 bg-gradient-to-br from-blue-500 to-indigo-600 text-white rounded-xl flex items-center justify-center font-black text-sm shadow-sm flex-shrink-0">${(s.name || '?').charAt(0).toUpperCase()}</div>
                    <div>
                        <div class="flex items-center gap-2">
                            <span class="font-black text-slate-700">${escHtml(s.name || 'Unnamed')}</span>
                            ${avgBadge}
                            ${missingBadge}
                        </div>
                        <span class="font-mono text-[10px] text-slate-400">${s.id}</span>
                    </div>
                </div>
            </td>
            <td class="px-6 py-4 text-slate-600 font-semibold">${classBadge}</td>
            <td class="px-6 py-4 text-slate-600 font-semibold">${escHtml(s.teacherName)}</td>
            <td class="px-6 py-4 text-slate-600 font-semibold">${escHtml(s.parentPhone || '—')}</td>
            <td class="px-6 py-4 text-right">
                <button onclick="window.openStudentPanel('${s.id}')" class="bg-white hover:bg-blue-50 text-blue-600 font-bold px-4 py-2 rounded-lg text-xs transition border border-slate-200 hover:border-blue-200">
                    View Profile
                </button>
            </td>
        </tr>`;
    }).join('');
}

filterClassSelect?.addEventListener('change', renderTable);
filterTeacherSelect?.addEventListener('change', renderTable);
searchInput?.addEventListener('input', renderTable);

// ── 6. ADD STUDENT MODAL ──────────────────────────────────────────────────
window.openAddStudentModal = function () {
    const limit = session.studentLimit || 50;
    if (allStudentsCache.length >= limit) {
        alert(`You have reached your student limit of ${limit}. Please contact ConnectUs to upgrade your plan.`);
        return;
    }
    document.getElementById('asForm').reset();
    document.getElementById('asMsg').classList.add('hidden');
    openOverlay('addStudentModal', 'addStudentModalInner');
};

window.closeAddStudentModal = function () {
    closeOverlay('addStudentModal', 'addStudentModalInner');
};

document.getElementById('saveAddStudentBtn')?.addEventListener('click', async () => {
    const btn   = document.getElementById('saveAddStudentBtn');
    const msgEl = document.getElementById('asMsg');
    msgEl.classList.add('hidden');

    const firstName   = document.getElementById('asFirstName').value.trim();
    const lastName    = document.getElementById('asLastName').value.trim();
    const dob         = document.getElementById('asDob').value.trim();
    const email       = document.getElementById('asEmail').value.trim();
    const parentName  = document.getElementById('asParentName').value.trim();
    const parentPhone = document.getElementById('asParentPhone').value.trim();

    if (!firstName || !lastName) {
        msgEl.textContent = 'First and last name are required.';
        msgEl.classList.remove('hidden');
        return;
    }

    btn.disabled  = true;
    btn.innerHTML = `<i class="fa-solid fa-spinner fa-spin"></i> Creating Student...`;

    try {
        const targetEmail = email ? email.toLowerCase() : null;

        let studentId;
        let attempts = 0;
        do {
            studentId = generateStudentId();
            try {
                const existing = await getDoc(doc(db, 'students', studentId));
                if (!existing.exists()) break;
            } catch (e) { break; }
            attempts++;
        } while (attempts < 5);

        const batch = writeBatch(db);

        // Generate the real PIN once, hash it for storage/login comparison,
        // and keep the raw value only in a short-lived `_tempPlaintextPin`
        // field — onStudentCreated (functions/index.js) reads that for the
        // welcome email and deletes it immediately after sending. The `pin`
        // field itself is never written in plain text.
        const rawPin    = generatePin();
        const hashedPin = await sha256Trim(rawPin);

        const studentRef = doc(db, 'students', studentId);
        batch.set(studentRef, {
            firstName,
            lastName,
            name:                 `${firstName} ${lastName}`.trim(),
            dob:                  dob         || '',
            email:                email       || '',
            parentName:           parentName  || '',
            parentPhone:          parentPhone || '',
            className:            '',
            classId:              '',   // PASS B: real classes/{classId} doc reference, resolved on assignment
            teacherId:            '',
            currentSchoolId:      session.schoolId,
            enrollmentStatus:     'Active',
            pin:                  hashedPin,
            _tempPlaintextPin:    rawPin,
            archived:             false,
            archivedAt:           null,
            archiveReason:        null,
            archivedSchoolIds:    [],
            requiresPinReset:     true,
            securityQuestionsSet: false,
            profileComplete:      false,
            academicHistory:      [],
            createdAt:            new Date().toISOString()
        });

        await batch.commit();

        // Parent linking is a best-effort follow-up to student creation, not
        // part of its atomic write: linkOrCreateParent needs to read the
        // student doc to validate it (schoolId match), so it can only run
        // AFTER the student exists. A failure here does not roll back the
        // student — the record is complete and useful on its own, and the
        // parent can be linked again later. Mirrors how onStudentCreated
        // already treats the welcome email as a secondary, best-effort step
        // after the core write.
        let parentLinkWarning = null;
        if (targetEmail) {
            try {
                await linkOrCreateParentFn({
                    studentId,
                    schoolId: session.schoolId,
                    parentName,
                    parentEmail: email,
                    parentPhone
                });
            } catch (linkErr) {
                console.error('[Create Student] linkOrCreateParent failed:', linkErr);
                parentLinkWarning = 'The student was created, but linking the parent account failed. Please try again later.';
            }
        }

        window.closeAddStudentModal();
        await loadData();
        if (parentLinkWarning) alert(parentLinkWarning);

    } catch (e) {
        console.error('[Create Student]', e);
        msgEl.textContent = 'Failed to create student. Please try again.';
        msgEl.classList.remove('hidden');
    }

    btn.disabled  = false;
    btn.innerHTML = `<i class="fa-solid fa-user-plus mr-2"></i> Create New Student Identity`;
});

// ── 7. STUDENT PANEL & TABS ───────────────────────────────────────────────
window.switchStudentTab = function (tabId) {
    document.querySelectorAll('.tab-pane').forEach(p => p.classList.add('hidden'));
    document.getElementById(`tab-${tabId}`)?.classList.remove('hidden');
    document.querySelectorAll('.panel-tab').forEach(btn => {
        if (btn.dataset.tab === tabId) btn.classList.add('active');
        else btn.classList.remove('active');
    });
};

window.toggleSEnrollDropdown = function () {
    document.getElementById('sEnrollDropdown')?.classList.toggle('hidden');
};

// UI CORRECTION MANDATE: extracted out of openStudentPanel() so
// saveEditStudent() can re-render this same grid after a save without
// duplicating the row list. Also fixes a pre-existing mislabel: this row
// was called "Parent Email" but has always displayed student.email (the
// STUDENT'S own email — set at creation for the credential slip, same
// field teacher/roster/roster.js's own Identity Details grid correctly
// labels "Email"). The parent's actual email lives on their own separate
// parents/{parentId} document and is shown in the Manage Parent tab, not
// here — leaving the old label in place would have made the new,
// independently-editable "Email" field in the Edit Profile modal
// ambiguous about which email it actually changes.
function renderIdentityGrid(student) {
    const infoGrid = document.getElementById('sInfoGrid');
    if (!infoGrid) return;
    infoGrid.innerHTML = [
        ['Name',             student?.name        || '—'],
        ['Date of Birth',    student?.dob         || '—'],
        ['Email',            student?.email       || '—'],
        ['Current Class',    student?.className   || 'Unassigned'],
        ['Assigned Teacher', student?.teacherName || 'Unassigned'],
        ['Parent/Guardian',  student?.parentName  || '—'],
        ['Parent Phone',     student?.parentPhone || '—'],
        ['Enrolled At',      student?.createdAt ? new Date(student.createdAt).toLocaleDateString() : '—']
    ].map(([label, value]) => `
        <div class="flex justify-between items-center py-2 border-b border-slate-100 last:border-0">
            <span class="text-xs font-bold text-slate-400 uppercase tracking-wider">${label}</span>
            <span class="text-sm font-semibold text-slate-700">${escHtml(value)}</span>
        </div>
    `).join('');
}

// ── EDIT PROFILE (Name / DOB / Email — Admin may edit all three) ─────────
window.openEditStudentModal = function () {
    const student = allStudentsCache.find(s => s.id === currentStudentId);
    document.getElementById('esName').value  = student?.name  || '';
    document.getElementById('esDob').value   = student?.dob   || '';
    document.getElementById('esEmail').value = student?.email || '';
    document.getElementById('esMsg').classList.add('hidden');
    openOverlay('editStudentModal', 'editStudentModalInner');
};

window.closeEditStudentModal = function () {
    closeOverlay('editStudentModal', 'editStudentModalInner');
};

window.saveEditStudent = async function () {
    const btn   = document.getElementById('saveEditStudentBtn');
    const name  = document.getElementById('esName').value.trim();
    const dob   = document.getElementById('esDob').value;
    const email = document.getElementById('esEmail').value.trim();

    if (!name) {
        document.getElementById('esMsg').textContent = 'Name is required.';
        document.getElementById('esMsg').className = 'text-xs font-bold text-rose-600';
        document.getElementById('esMsg').classList.remove('hidden');
        return;
    }
    if (email && !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) {
        document.getElementById('esMsg').textContent = 'Enter a valid email address, or leave it blank.';
        document.getElementById('esMsg').className = 'text-xs font-bold text-rose-600';
        document.getElementById('esMsg').classList.remove('hidden');
        return;
    }

    btn.textContent = 'Saving…'; btn.disabled = true;

    try {
        await updateDoc(doc(db, 'students', currentStudentId), { name, dob, email });

        const idx = allStudentsCache.findIndex(s => s.id === currentStudentId);
        if (idx !== -1) {
            allStudentsCache[idx].name  = name;
            allStudentsCache[idx].dob   = dob;
            allStudentsCache[idx].email = email;
        }

        document.getElementById('sPanelName').textContent = name;
        renderIdentityGrid(allStudentsCache[idx]);

        window.closeEditStudentModal();
        await loadData();
    } catch (e) {
        console.error('[Students] saveEditStudent:', e);
        document.getElementById('esMsg').textContent = 'Error saving. Please try again.';
        document.getElementById('esMsg').className = 'text-xs font-bold text-rose-600';
        document.getElementById('esMsg').classList.remove('hidden');
    }

    btn.textContent = 'Save Changes'; btn.disabled = false;
};

window.openStudentPanel = async function (studentId) {
    currentStudentId = studentId;
    const student    = allStudentsCache.find(s => s.id === studentId);
    currentStudentClass = student?.className || '';   // scope the Academic tab to this

    document.getElementById('sPanelName').textContent = student?.name || 'Student';
    document.getElementById('sPanelId').textContent   = student?.id   || '—';
    document.getElementById('sEnrollDropdown')?.classList.add('hidden');

    renderIdentityGrid(student);

    window.switchStudentTab('overview');
    document.getElementById('sPanelLoader')?.classList.remove('hidden');
    openOverlay('studentPanel', 'studentPanelInner', true);

    // Manage Parent tab now checks for an already-linked parent on every
    // panel open, before the admin even clicks the tab — see
    // refreshManageParentTab() below. Replaces the old always-reset-to-
    // empty-search-form behavior.
    refreshManageParentTab(studentId);

    try {
        if (student?.teacherId) {
            // ── PHASE 0: resolve fresh so a just-changed weighting shows up the
            // moment the panel is opened, not whatever was cached at directory load.
            let legacyData = allTeachersCache.find(t => t.id === student.teacherId);
            if (!legacyData) {
                const tDoc = await getDoc(doc(db, 'teachers', student.teacherId));
                legacyData = tDoc.exists() ? tDoc.data() : null;
            }
            const resolvedWeights = await resolveGradeWeights(session.schoolId, student.teacherId, { legacyTeacherData: legacyData });
            if (resolvedWeights) currentTeacherWeights = resolvedWeights;
        }

        const gradesSnap = await getDocs(collection(db, 'students', studentId, 'grades'));
        currentStudentGradesCache = [];
        gradesSnap.forEach(d => currentStudentGradesCache.push({ id: d.id, ...d.data() }));

        // Load this student's evaluations (for the Class History evaluations breakdown).
        currentStudentEvalsCache = [];
        try {
            const evalSnap = await getDocs(query(
                collection(db, 'students', studentId, 'evaluations'),
                where('schoolId', '==', session.schoolId)
            ));
            evalSnap.forEach(d => currentStudentEvalsCache.push({ id: d.id, ...d.data() }));
        } catch (e) { console.error('[Students] load evaluations:', e); }

        const semSelect = document.getElementById('sPanelSemester');
        let activeId    = '';
        const schoolDoc = await getDoc(doc(db, 'schools', session.schoolId));
        if (schoolDoc.exists()) activeId = schoolDoc.data().activeSemesterId || '';

        semSelect.innerHTML = rawSemesters.map(s => `<option value="${s.id}" ${s.id === activeId ? 'selected' : ''}>${s.name}</option>`).join('');
        if (!rawSemesters.length) semSelect.innerHTML = '<option value="">No Terms Found</option>';

        const classSet = new Set();
        if (student?.className) classSet.add(student.className);
        (student?.classHistory || []).forEach(h => {
            if (h.fromClass) classSet.add(h.fromClass);
            if (h.toClass)   classSet.add(h.toClass);
        });
        currentStudentGradesCache.forEach(g => {
            if (g.className) classSet.add(g.className);
        });

        const classFilter = document.getElementById('sPanelFilterClass');
        if (classFilter) {
            classFilter.innerHTML = '<option value="">All Classes</option>' +
                [...classSet].sort().map(c => `<option value="${c}">${c}</option>`).join('');
            classFilter.value = '';
        }

        window.renderAdminGrades();
        window.renderClassHistory(student);
    } catch (e) {
        console.error(e);
    } finally {
        document.getElementById('sPanelLoader')?.classList.add('hidden');
    }
};

window.closeStudentPanel = function () { closeOverlay('studentPanel', 'studentPanelInner', true); };

// ── 8. RENDER ADMIN GRADES ────────────────────────────────────────────────
window.renderAdminGrades = function () {
    const container   = document.getElementById('subjectAccordions');
    if (!container) return;

    const termId      = document.getElementById('sPanelSemester').value;
    const filterSubj  = document.getElementById('sPanelFilterSubject').value;
    const filterType  = document.getElementById('sPanelFilterType').value;
    const filterClass = document.getElementById('sPanelFilterClass')?.value || '';

    let filteredGrades = currentStudentGradesCache.filter(g => g.semesterId === termId);

    // Scope the Academic tab to the student's CURRENT class only. A promoted
    // student's old grades carry their previous class name, so they won't match
    // the new current class — the Academic tab correctly shows empty for them,
    // and their full record remains under Class History. If the student is
    // unassigned (no current class), the Academic tab shows nothing here.
    filteredGrades = filteredGrades.filter(g => (g.className || '') === currentStudentClass && currentStudentClass !== '');

    if (filterClass) filteredGrades = filteredGrades.filter(g => g.className === filterClass);

    const subjSet = [...new Set(filteredGrades.map(g => g.subject || 'Uncategorized'))].sort();
    const typeSet = [...new Set(filteredGrades.map(g => g.type    || 'Uncategorized'))].sort();

    document.getElementById('sPanelFilterSubject').innerHTML = '<option value="">All Subjects</option>' + subjSet.map(s => `<option value="${s}" ${s === filterSubj ? 'selected' : ''}>${s}</option>`).join('');
    document.getElementById('sPanelFilterType').innerHTML    = '<option value="">All Types</option>'    + typeSet.map(t => `<option value="${t}" ${t === filterType ? 'selected' : ''}>${t}</option>`).join('');

    if (filterSubj) filteredGrades = filteredGrades.filter(g => g.subject === filterSubj);
    if (filterType) filteredGrades = filteredGrades.filter(g => g.type    === filterType);

    if (!filteredGrades.length) {
        // Distinguish the promoted/unassigned case from a simple no-grades case so
        // the admin understands why the Academic tab is empty and where to look.
        const hasHistoryGrades = currentStudentGradesCache.some(g => g.schoolId === session.schoolId);
        let emptyMsg;
        if (!currentStudentClass) {
            emptyMsg = `This student is not currently assigned to a class, so there are no current grades. Their past record is available under <span class="font-bold text-slate-600">Class History</span>.`;
        } else if (hasHistoryGrades) {
            emptyMsg = `No grades yet for <span class="font-bold text-slate-600">${escHtml(currentStudentClass)}</span> this term. Earlier grades from previous classes are under <span class="font-bold text-slate-600">Class History</span>.`;
        } else {
            emptyMsg = `No grades recorded for these filters.`;
        }
        container.innerHTML = `<div class="text-center py-16 bg-white rounded-xl border border-slate-200"><i class="fa-solid fa-folder-open text-4xl text-slate-300 mb-3"></i><p class="text-slate-400 font-semibold max-w-md mx-auto leading-relaxed">${emptyMsg}</p></div>`;
        return;
    }

    const bySubj = {};
    filteredGrades.forEach(g => {
        const subj = g.subject || 'Uncategorized';
        if (!bySubj[subj]) bySubj[subj] = [];
        bySubj[subj].push(g);
    });

    container.innerHTML = Object.entries(bySubj).map(([subject, grades]) => {
        const avg  = calculateWeightedAverage(grades, currentTeacherWeights);
        const avgR = Math.round(avg);
        const ac   = avgR >= 75 ? 'text-green-700 bg-green-50 border-green-200' : avgR >= 60 ? 'text-amber-700 bg-amber-50 border-amber-200' : 'text-red-700 bg-red-50 border-red-200';

        const rows = grades.sort((a, b) => (b.date || '').localeCompare(a.date || '')).map(g => {
            const pct = g.max ? Math.round((g.score / g.max) * 100) : null;
            const c   = pct == null ? 'text-slate-600' : pct >= 75 ? 'text-green-600' : pct >= 60 ? 'text-amber-600' : 'text-red-600';
            return `<div class="border border-slate-200 rounded-lg bg-white p-3 flex items-center justify-between">
                <div>
                    <p class="font-bold text-slate-700 text-sm">${escHtml(g.title || 'Assessment')}</p>
                    <p class="text-xs text-slate-400 font-semibold mt-0.5">${escHtml(g.type || '')} · ${g.date || 'No Date'}</p>
                </div>
                <div class="flex items-center gap-3">
                    <span class="font-mono text-sm font-bold text-slate-500">${g.score}/${g.max || '?'}</span>
                    <span class="${c} font-black text-sm bg-slate-50 px-2 py-1 rounded border border-slate-100">${pct != null ? pct + '%' : '-'}</span>
                </div>
            </div>`;
        }).join('');

        return `<div class="rounded-xl border border-slate-200 overflow-hidden bg-white shadow-sm">
            <div class="flex items-center justify-between px-5 py-4 bg-slate-50 border-b border-slate-200 cursor-pointer" onclick="window.toggleSubjectAccordion(this)">
                <div class="flex items-center gap-3">
                    <div class="w-8 h-8 bg-slate-800 text-white rounded flex items-center justify-center font-black text-xs">${subject.charAt(0)}</div>
                    <div>
                        <p class="font-black text-slate-800 text-sm">${escHtml(subject)}</p>
                        <p class="text-[10px] text-slate-500 font-bold uppercase tracking-widest">${grades.length} entries</p>
                    </div>
                </div>
                <div class="flex items-center gap-3">
                    <span class="${ac} border font-black text-xs px-2 py-1 rounded">${avgR}% Avg</span>
                    <i class="fa-solid fa-chevron-down text-slate-400" style="transition:transform 0.2s"></i>
                </div>
            </div>
            <div class="subject-body p-3 bg-slate-100 space-y-2 border-t border-slate-200">${rows}</div>
        </div>`;
    }).join('');
};

window.toggleSubjectAccordion = function (header) {
    const body    = header.nextElementSibling;
    body.classList.toggle('open');
    const chevron = header.querySelector('.fa-chevron-down');
    if (chevron) chevron.style.transform = body.classList.contains('open') ? 'rotate(180deg)' : 'rotate(0deg)';
};

// ── 9. PRINT RECORDS ─────────────────────────────────────────────────────
window.openPrintStudentModal = function () {
    const termId     = document.getElementById('sPanelSemester')?.value;
    const termGrades = currentStudentGradesCache.filter(g => g.semesterId === termId);
    const subjSet    = [...new Set(termGrades.map(g => g.subject || 'Uncategorized'))].sort();

    document.getElementById('psSubject').innerHTML = '<option value="all">All Subjects</option>' +
        subjSet.map(s => `<option value="${escHtml(s)}">${s}</option>`).join('');

    openOverlay('printStudentModal', 'printStudentModalInner');
};

window.closePrintStudentModal = function () { closeOverlay('printStudentModal', 'printStudentModalInner'); };

window.executeStudentPrint = async function () {
    const mode       = document.getElementById('psMode').value;
    const subjFilter = document.getElementById('psSubject').value;
    const termId     = document.getElementById('sPanelSemester')?.value;
    const semSelect  = document.getElementById('sPanelSemester');
    const semName    = semSelect?.options[semSelect.selectedIndex]?.text || 'Active Term';
    const student    = allStudentsCache.find(s => s.id === currentStudentId);
    if (!student) return;

    let gradesToPrint = currentStudentGradesCache.filter(g => g.semesterId === termId);
    if (subjFilter !== 'all') gradesToPrint = gradesToPrint.filter(g => g.subject === subjFilter);

    const bySub = {};
    let totalAssessments = 0;
    gradesToPrint.forEach(g => {
        const sub = g.subject || 'Uncategorized';
        if (!bySub[sub]) bySub[sub] = [];
        bySub[sub].push(g);
        if (g.max) totalAssessments++;
    });

    const cumulativeAvg = gradesToPrint.length ? calculateWeightedAverage(gradesToPrint, currentTeacherWeights) : 0;
    const gpaLetter     = totalAssessments > 0 ? letterGrade(cumulativeAvg) : 'N/A';

    let schoolName = session.schoolName || '';
    try {
        const schoolSnap = await getDoc(doc(db, 'schools', session.schoolId));
        if (schoolSnap.exists()) schoolName = schoolSnap.data().schoolName || schoolName;
    } catch (e) { console.error("Error fetching school name:", e); }

    let gradesHtml = Object.keys(bySub).length === 0
        ? `<tr><td colspan="4" style="text-align:center;color:#64748b;font-style:italic;padding:40px;">No grades recorded.</td></tr>`
        : Object.entries(bySub).sort((a, b) => a[0].localeCompare(b[0])).map(([sub, gList]) => {
            const subAvg = calculateWeightedAverage(gList, currentTeacherWeights);
            let html = `<tr style="background:#f8fafc;font-weight:800;">
                <td style="border-bottom:1px solid #cbd5e1;padding:12px 15px;">${escHtml(sub)}</td>
                <td style="border-bottom:1px solid #cbd5e1;padding:12px 15px;text-align:center;">${gList.length}</td>
                <td style="border-bottom:1px solid #cbd5e1;padding:12px 15px;text-align:center;">${subAvg}%</td>
                <td style="border-bottom:1px solid #cbd5e1;padding:12px 15px;text-align:center;">${letterGrade(subAvg)}</td>
            </tr>`;
            if (mode === 'detailed') {
                gList.sort((a, b) => (b.date || '').localeCompare(a.date || '')).forEach(g => {
                    const pct = g.max ? Math.round((g.score / g.max) * 100) : null;
                    html += `<tr style="font-size:11px;background:#fff;">
                        <td style="border-bottom:1px solid #f1f5f9;padding:8px 15px 8px 30px;">${escHtml(g.title)} <span style="color:#94a3b8;">${escHtml(g.type)} · ${g.date}</span></td>
                        <td style="border-bottom:1px solid #f1f5f9;padding:8px 15px;text-align:center;font-family:monospace;">${g.score}/${g.max || '?'}</td>
                        <td style="border-bottom:1px solid #f1f5f9;padding:8px 15px;text-align:center;font-family:monospace;">${pct !== null ? pct + '%' : '-'}</td>
                        <td style="border-bottom:1px solid #f1f5f9;padding:8px 15px;text-align:center;">${pct !== null ? letterGrade(pct) : '-'}</td>
                    </tr>`;
                });
            }
            return html;
        }).join('');

    const html = `<!DOCTYPE html><html><head><title>Report — ${escHtml(student.name)}</title>
    <style>@import url('https://fonts.googleapis.com/css2?family=Nunito:wght@400;700;800;900&display=swap');
    body{font-family:'Nunito',sans-serif;padding:40px;color:#0f172a;margin:0 auto;max-width:8.5in;}
    .hf{display:flex;justify-content:space-between;align-items:flex-end;border-bottom:3px solid #1e1b4b;padding-bottom:20px;margin-bottom:30px;}
    .logo{max-height:60px;max-width:200px;object-fit:contain;}.ht{text-align:right;}
    .ht h1{margin:0 0 5px;font-size:24px;font-weight:900;text-transform:uppercase;color:#1e1b4b;}
    .ht h2{margin:0;font-size:14px;color:#64748b;font-weight:700;letter-spacing:2px;}
    .sib{display:flex;border:1px solid #cbd5e1;border-radius:8px;overflow:hidden;margin-bottom:30px;}
    .ic{flex:1;padding:15px 20px;border-right:1px solid #cbd5e1;}.ic:last-child{border-right:none;background:#f8fafc;}
    .il{font-size:10px;text-transform:uppercase;color:#64748b;font-weight:800;display:block;margin-bottom:2px;}
    .iv{font-size:15px;font-weight:800;color:#0f172a;}
    .ag{display:flex;gap:15px;margin-bottom:30px;}
    .ac{flex:1;background:#fff;border:2px solid #e2e8f0;border-radius:8px;padding:15px;text-align:center;}
    .av{font-size:28px;font-weight:900;color:#1e1b4b;line-height:1;margin-bottom:5px;}
    .al{font-size:11px;font-weight:800;color:#64748b;text-transform:uppercase;letter-spacing:1px;}
    table{width:100%;border-collapse:collapse;font-size:13px;border:1px solid #e2e8f0;}
    th{background:#1e1b4b;color:#fff;padding:10px 15px;text-align:left;font-size:11px;text-transform:uppercase;letter-spacing:1px;}
    th.c{text-align:center;}
    .ft{margin-top:50px;text-align:center;font-size:11px;color:#94a3b8;border-top:1px solid #e2e8f0;padding-top:20px;font-weight:600;}</style>
    </head><body>
    <div class="hf">
        <div class="ht"><h1>${escHtml(schoolName)}</h1><h2>OFFICIAL TERM REPORT</h2></div>
    </div>
    <div class="sib">
        <div class="ic"><div style="margin-bottom:10px;"><span class="il">Student Name</span><span class="iv">${escHtml(student.name)}</span></div>
        <div><span class="il">Global ID</span><span class="iv" style="font-family:monospace;letter-spacing:1px;">${student.id}</span></div></div>
        <div class="ic"><div style="margin-bottom:10px;"><span class="il">Academic Term</span><span class="iv">${escHtml(semName)}</span></div>
        <div><span class="il">Class</span><span class="iv">${escHtml(student.className || 'Unassigned')}</span></div></div>
    </div>
    <div class="ag">
        <div class="ac"><div class="av">${cumulativeAvg}%</div><div class="al">Term Average</div></div>
        <div class="ac"><div class="av">${gpaLetter}</div><div class="al">Overall Grade</div></div>
        <div class="ac"><div class="av">${totalAssessments}</div><div class="al">Assessments</div></div>
    </div>
    <table><thead><tr><th>Subject / Assignment</th><th class="c">Count</th><th class="c">Average</th><th class="c">Grade</th></tr></thead>
    <tbody>${gradesHtml}</tbody></table>
    <div class="ft">Official report for <strong>${escHtml(schoolName)}</strong> · Issued ${new Date().toLocaleDateString('en-US',{year:'numeric',month:'long',day:'numeric'})}</div>
    </body></html>`;

    const w = window.open('', '_blank');
    w.document.write(html);
    w.document.close();
    window.closePrintStudentModal();
    setTimeout(() => w.print(), 800);
};

// ── 10. ARCHIVE & REASSIGN ────────────────────────────────────────────────
function updateReassignTeacherDropdown(selectedClass, currentTeacherId = '') {
    const tSelect = document.getElementById('rsTeacher');
    if (!tSelect) return;

    const teachersForClass = selectedClass
        ? allTeachersCache.filter(t => (t.classes || []).includes(selectedClass))
        : [];

    if (!teachersForClass.length) {
        tSelect.innerHTML = `<option value="">— No teacher assigned to ${escHtml(selectedClass) || 'this class'} —</option>`;
    } else {
        tSelect.innerHTML = '<option value="">-- Unassigned --</option>' +
            teachersForClass.map(t => `<option value="${t.id}" ${t.id === currentTeacherId ? 'selected' : ''}>${escHtml(t.name)}</option>`).join('');
    }
}

window.openReassignModal = function () {
    document.getElementById('sEnrollDropdown')?.classList.add('hidden');
    const s = allStudentsCache.find(x => x.id === currentStudentId);
    if (!s) return;

    const cSelect = document.getElementById('rsClass');
    if (cSelect) {
        const classList = getClassList(s.className ? [s.className] : []);
        cSelect.innerHTML = '<option value="">-- Unassigned --</option>' +
            classList.map(c => `<option value="${escHtml(c)}" ${s.className === c ? 'selected' : ''}>${escHtml(c)}</option>`).join('');
    }

    updateReassignTeacherDropdown(s.className || '', s.teacherId || '');
    openOverlay('reassignStudentModal', 'reassignStudentModalInner');
};

document.getElementById('rsClass')?.addEventListener('change', function () {
    updateReassignTeacherDropdown(this.value);
});

window.closeReassignModal = function () { closeOverlay('reassignStudentModal', 'reassignStudentModalInner'); };

document.getElementById('saveReassignBtn')?.addEventListener('click', async () => {
    const btn = document.getElementById('saveReassignBtn');
    btn.innerHTML = `<i class="fa-solid fa-spinner fa-spin mr-2"></i>Saving...`;
    btn.disabled  = true;

    try {
        const className = document.getElementById('rsClass')?.value   || '';
        const teacherId = document.getElementById('rsTeacher')?.value || '';
        // PASS B: classId is the real reference Firestore rules will trust;
        // className stays for display. '' when unassigned or the name has
        // no matching class doc.
        const classId = classIdForName(className);
        await updateDoc(doc(db, 'students', currentStudentId), { className, classId, teacherId });
        closeReassignModal();
        await loadData();
    } catch (e) {
        console.error(e);
        alert("Error reassigning student.");
    }

    btn.innerHTML = `Save Assignment`;
    btn.disabled  = false;
});

window.openArchiveReasonModal = function () {
    document.getElementById('sEnrollDropdown')?.classList.add('hidden');
    document.getElementById('archiveReasonSelect').value = 'Transferred to another school';
    document.getElementById('archiveReasonOther').classList.add('hidden');
    document.getElementById('archiveReasonOther').value = '';
    openOverlay('archiveReasonModal', 'archiveReasonModalInner');
};

window.closeArchiveReasonModal = function () { closeOverlay('archiveReasonModal', 'archiveReasonModalInner'); };

document.getElementById('archiveReasonSelect')?.addEventListener('change', function () {
    document.getElementById('archiveReasonOther')?.classList.toggle('hidden', this.value !== 'Other');
});

document.getElementById('confirmArchiveBtn')?.addEventListener('click', async () => {
    const sel    = document.getElementById('archiveReasonSelect')?.value;
    const reason = sel === 'Other' ? document.getElementById('archiveReasonOther')?.value.trim() : sel;
    const btn    = document.getElementById('confirmArchiveBtn');

    if (sel === 'Other' && !reason) { alert("Please specify the reason."); return; }

    // ── FIX: dual-archive unification — map this portal's reason picker to
    // the same enrollmentStatus values teacher/roster.js's release flow uses,
    // so teacher/archives.js's status query recognizes admin-originated
    // archives too.
    const enrollmentStatusMap = {
        'Transferred to another school': 'Transferred',
        'Graduated': 'Graduated',
        'Expelled': 'Expelled',
        'Dropped Out': 'Dropped Out'
    };
    const finalStatus = enrollmentStatusMap[sel] || 'Archived';

    btn.innerHTML = '<i class="fa-solid fa-spinner fa-spin mr-2"></i>Archiving...';
    btn.disabled  = true;

    try {
        const studentToArchive = allStudentsCache.find(s => s.id === currentStudentId);

        let academicSnapshot = {};
        try {
            let gradeTypes = ['Test', 'Quiz', 'Assignment', 'Homework', 'Project', 'Midterm Exam', 'Final Exam'];
            // ── PHASE 0: this is a permanent-record snapshot, so resolve fresh
            // at the moment of archiving — never from a page-load cache.
            if (studentToArchive?.teacherId) {
                let legacyData = allTeachersCache.find(t => t.id === studentToArchive.teacherId);
                if (!legacyData) {
                    const tDoc = await getDoc(doc(db, 'teachers', studentToArchive.teacherId));
                    legacyData = tDoc.exists() ? tDoc.data() : null;
                }
                const resolvedWeights = await resolveGradeWeights(session.schoolId, studentToArchive.teacherId, { legacyTeacherData: legacyData });
                gradeTypes = resolvedWeights || gradeTypes;
            }

            const gradesSnap = await getDocs(collection(db, 'students', currentStudentId, 'grades'));
            const classGrades = [];
            gradesSnap.forEach(d => {
                const g = { id: d.id, ...d.data() };
                if (g.className === studentToArchive?.className) classGrades.push(g);
            });

            const evalSnap = await getDocs(query(
                collection(db, 'students', currentStudentId, 'evaluations'),
                where('schoolId', '==', session.schoolId)
            ));
            const evaluations = [];
            evalSnap.forEach(d => evaluations.push({ id: d.id, ...d.data() }));
            // ── FIX: evalSnap is a Firestore QuerySnapshot (no .sort()) — this
            // was crashing on every archive before it ever reached the
            // semesters/weighting calculation below, silently leaving
            // academicSnapshot as {} regardless of grade data. Sort the
            // plain evaluations array instead.
            evaluations.sort((a, b) => new Date(b.date || b.createdAt || 0) - new Date(a.date || a.createdAt || 0));

            const bySemester = {};
            classGrades.forEach(g => {
                if (!g.semesterId) return;
                const sem     = rawSemesters.find(s => s.id === g.semesterId);
                const semName = sem?.name || g.semesterId;
                if (!bySemester[semName]) bySemester[semName] = {};
                const subj = g.subject || 'Uncategorized';
                if (!bySemester[semName][subj]) bySemester[semName][subj] = [];
                bySemester[semName][subj].push(g);
            });

            const semesters = {};
            Object.entries(bySemester).forEach(([semName, subjects]) => {
                semesters[semName] = {};
                const allSemGrades = [];
                Object.entries(subjects).forEach(([subj, grades]) => {
                    semesters[semName][subj] = Math.round(calculateWeightedAverage(grades, gradeTypes));
                    allSemGrades.push(...grades);
                });
                if (allSemGrades.length) {
                    semesters[semName]._overall = Math.round(calculateWeightedAverage(allSemGrades, gradeTypes));
                }
            });

            academicSnapshot = {
                className:    studentToArchive?.className || '',
                semesters,
                evaluations,
                snapshotDate: new Date().toISOString()
            };
        } catch (snapErr) {
            console.warn('[Archive] academic snapshot warning:', snapErr.message);
        }

        // ── FIX: use writeBatch so email cleanup is atomic with the archive write ──
        const batch = writeBatch(db);

        // ── FIX: dual-archive unification — this portal never used to set
        // enrollmentStatus or clear currentSchoolId, so an admin-originated
        // archive was invisible to teacher/archives.js's status query (whose
        // "still Active at this school" exclusion check actively hid it from
        // that list). Every reason this portal offers implies the student is
        // leaving the school, so mirror roster.js's "release" archive
        // semantics here.
        batch.update(doc(db, 'students', currentStudentId), {
            archived:          true,
            enrollmentStatus:  finalStatus,
            currentSchoolId:   '',
            archivedAt:        new Date().toISOString(),
            archiveReason:     reason || 'Not specified',
            teacherId:         '',
            className:         '',
            classId:           '',   // PASS B: clear alongside className — clean slate, same as restore
            lastClassName:     studentToArchive?.className || '',
            archivedSchoolIds: arrayUnion(session.schoolId),
            academicSnapshot
        });

        // ── FIX: free the email so this student can be re-enrolled elsewhere ──
        // New students no longer write to registered_emails (parent email
        // dedup now lives exclusively in linkOrCreateParent's parent_emails
        // index), so this delete is a no-op for them. It's left in place as
        // harmless cleanup for any pre-existing registered_emails entries
        // from before this fix.
        if (studentToArchive?.email) {
            batch.delete(doc(db, 'registered_emails', studentToArchive.email.toLowerCase().trim()));
        }

        await batch.commit();
        closeArchiveReasonModal();
        closeStudentPanel();
        loadData();
    } catch (e) {
        console.error(e);
        alert("Error archiving student.");
    }

    btn.innerHTML = 'Confirm & Archive';
    btn.disabled  = false;
});

// ── 11. CSV EXPORT ────────────────────────────────────────────────────────
document.getElementById('exportCsvBtn')?.addEventListener('click', () => {
    const rows = [['Name', 'Class', 'Teacher', 'Parent Phone'],
        ...allStudentsCache.map(s => [s.name || '', s.className || '', s.teacherName || '', s.parentPhone || ''])];
    const csv = rows.map(r => r.map(v => `"${String(v ?? '').replace(/"/g, '""')}"`).join(',')).join('\n');
    const a   = Object.assign(document.createElement('a'), {
        href: URL.createObjectURL(new Blob([csv], { type: 'text/csv' })),
        download: `${session.schoolId}_students.csv`
    });
    document.body.appendChild(a); a.click(); a.remove();
});

// ── 12. CLASS HISTORY ─────────────────────────────────────────────────────

// Condensed evaluation summary for Class History. New evaluations carry a
// className, so they group under their class. Older evaluations (filed before
// className stamping) have none — those are shown once, together, in a
// separate "Earlier Evaluations" block via renderUnclassifiedEvaluations.
// Condensed = type, term, date, and status/outcome — NOT the written narratives.
function evalTypeLabel(ev) {
    switch (ev.type) {
        case 'academic':             return 'Academic Progress';
        case 'academic_report_card': return ev.reportCardType === 'midterm' ? 'Midterm Report Card' : 'Report Card';
        case 'end_of_year':          return 'Comprehensive End-of-Year';
        case 'behavioral':           return 'Behavioral & Conduct';
        case 'midterm_review':       return 'Mid-Term Review';
        case 'parent_conference':    return 'Parent Conference';
        case 'learning_support':     return 'Learning Support Plan';
        case 'custom':               return ev.customTypeName || 'Custom Evaluation';
        default:                     return ev.type || 'Evaluation';
    }
}

function evalRowHtml(ev, semNameFn) {
    const statusLine = ev.status ? `<span class="text-[10px] font-bold text-slate-500">${escHtml(ev.status)}</span>` : '';
    return `<div class="flex items-center justify-between py-1.5 border-b border-slate-100 last:border-0">
        <div class="flex items-center gap-2 min-w-0">
            <span class="text-xs font-semibold text-slate-600 truncate">${escHtml(evalTypeLabel(ev))}</span>
            ${statusLine}
        </div>
        <span class="text-[10px] font-bold text-slate-400 flex-shrink-0">${escHtml(ev.date || '')}</span>
    </div>`;
}

function evalTermSections(evs, semNameFn) {
    const byTerm = {};
    evs.forEach(ev => {
        const t = ev.semesterName || semNameFn(ev.semesterId) || 'Unknown Period';
        if (!byTerm[t]) byTerm[t] = [];
        byTerm[t].push(ev);
    });
    return Object.entries(byTerm).map(([term, list]) => {
        const rows = list.sort((a, b) => new Date(b.date || 0) - new Date(a.date || 0)).map(ev => evalRowHtml(ev, semNameFn)).join('');
        return `<div class="mb-3 last:mb-0">
            <div class="flex items-center justify-between mb-1.5">
                <span class="text-[10px] font-black text-slate-400 uppercase tracking-widest">${escHtml(term)}</span>
                <span class="text-[10px] font-bold text-indigo-500">${list.length} evaluation${list.length !== 1 ? 's' : ''}</span>
            </div>
            <div class="bg-indigo-50/40 rounded-lg px-3 py-1">${rows}</div>
        </div>`;
    }).join('');
}

// Evaluations stamped with THIS class name, grouped by term. Returns '' if none.
function renderClassEvaluations(className, semNameFn) {
    const forClass = (currentStudentEvalsCache || []).filter(ev => (ev.className || '') === className);
    if (!forClass.length) return '';
    return `<div class="mt-4 pt-4 border-t border-slate-200">
        <p class="text-[10px] font-black text-indigo-600 uppercase tracking-widest mb-2"><i class="fa-solid fa-clipboard-user mr-1.5"></i>Evaluations</p>
        ${evalTermSections(forClass, semNameFn)}
    </div>`;
}

// Older evaluations with NO className — shown once, as their own card, so
// historical evaluations remain visible even though they predate class stamping.
function renderUnclassifiedEvaluations(semNameFn) {
    const orphans = (currentStudentEvalsCache || []).filter(ev => ev.schoolId === session.schoolId && !ev.className);
    if (!orphans.length) return '';
    return `<div class="rounded-xl border border-slate-200 overflow-hidden bg-white shadow-sm">
        <div class="flex items-center justify-between px-5 py-4 bg-slate-50 border-b border-slate-200 cursor-pointer" onclick="window.toggleSubjectAccordion(this)">
            <div class="flex items-center gap-3">
                <div class="w-8 h-8 bg-indigo-500 text-white rounded flex items-center justify-center font-black text-xs"><i class="fa-solid fa-clipboard-list"></i></div>
                <div>
                    <p class="font-black text-slate-800 text-sm">Earlier Evaluations</p>
                    <p class="text-[10px] text-slate-500 font-bold uppercase tracking-widest">${orphans.length} record${orphans.length !== 1 ? 's' : ''} · filed before class tracking</p>
                </div>
            </div>
            <i class="fa-solid fa-chevron-down text-slate-400" style="transition:transform 0.2s"></i>
        </div>
        <div class="subject-body border-t border-slate-200">
            <div class="p-4">${evalTermSections(orphans, semNameFn)}</div>
        </div>
    </div>`;
}

window.renderClassHistory = function (student) {
    const container = document.getElementById('classHistoryContainer');
    if (!container) return;

    const schoolGrades = currentStudentGradesCache.filter(g => g.schoolId === session.schoolId);
    const schoolEvals  = (currentStudentEvalsCache || []).filter(e => e.schoolId === session.schoolId);

    if (!schoolGrades.length && !schoolEvals.length) {
        container.innerHTML = `<div class="text-center py-16 bg-white rounded-xl border border-slate-200"><i class="fa-solid fa-clock-rotate-left text-4xl text-slate-300 mb-3"></i><p class="text-slate-400 font-semibold">No class history recorded yet.</p></div>`;
        return;
    }

    const byClass = {};
    schoolGrades.forEach(g => {
        const cls   = g.className || 'Unclassified';
        const semId = g.semesterId || 'unknown';
        if (!byClass[cls]) byClass[cls] = {};
        if (!byClass[cls][semId]) byClass[cls][semId] = {};
        const subj = g.subject || 'Uncategorized';
        if (!byClass[cls][semId][subj]) byClass[cls][semId][subj] = [];
        byClass[cls][semId][subj].push(g);
    });

    // Ensure classes that have evaluations but no grades still get a block.
    schoolEvals.forEach(ev => {
        if (ev.className && !byClass[ev.className]) byClass[ev.className] = {};
    });

    const semName = (semId) => {
        const s = rawSemesters.find(r => r.id === semId);
        return s ? s.name : semId;
    };

    container.innerHTML = Object.entries(byClass).map(([className, semesters]) => {
        const allClassGrades = Object.values(semesters).flatMap(s => Object.values(s).flat());
        const hasGrades = allClassGrades.length > 0;
        const classAvg = hasGrades ? Math.round(calculateWeightedAverage(allClassGrades, currentTeacherWeights)) : null;
        const ca = classAvg === null ? '' : classAvg >= 75 ? 'text-green-700 bg-green-50 border-green-200' : classAvg >= 60 ? 'text-amber-700 bg-amber-50 border-amber-200' : 'text-red-700 bg-red-50 border-red-200';

        const termBlocks = Object.entries(semesters).map(([semId, subjects]) => {
            const allTermGrades = Object.values(subjects).flat();
            const termAvg = Math.round(calculateWeightedAverage(allTermGrades, currentTeacherWeights));
            const ta = termAvg >= 75 ? 'text-green-700 bg-green-50 border-green-200' : termAvg >= 60 ? 'text-amber-700 bg-amber-50 border-amber-200' : 'text-red-700 bg-red-50 border-red-200';

            const subjectRows = Object.entries(subjects).map(([subject, grades]) => {
                const subAvg = Math.round(calculateWeightedAverage(grades, currentTeacherWeights));
                const sa = subAvg >= 75 ? 'text-green-600' : subAvg >= 60 ? 'text-amber-600' : 'text-red-600';
                return `<div class="flex items-center justify-between py-1.5 border-b border-slate-100 last:border-0">
                    <span class="text-xs font-semibold text-slate-600">${escHtml(subject)}</span>
                    <div class="flex items-center gap-2">
                        <span class="text-xs font-bold text-slate-400">${grades.length} entr${grades.length !== 1 ? 'ies' : 'y'}</span>
                        <span class="font-black text-xs ${sa}">${subAvg}%</span>
                    </div>
                </div>`;
            }).join('');

            return `<div class="mb-3 last:mb-0">
                <div class="flex items-center justify-between mb-1.5">
                    <span class="text-[10px] font-black text-slate-400 uppercase tracking-widest">${escHtml(semName(semId))}</span>
                    <span class="${ta} border font-black text-[10px] px-1.5 py-0.5 rounded">${termAvg}% Avg</span>
                </div>
                <div class="bg-slate-50 rounded-lg px-3 py-1">${subjectRows}</div>
            </div>`;
        }).join('');

        return `<div class="rounded-xl border border-slate-200 overflow-hidden bg-white shadow-sm">
            <div class="flex items-center justify-between px-5 py-4 bg-slate-50 border-b border-slate-200 cursor-pointer" onclick="window.toggleSubjectAccordion(this)">
                <div class="flex items-center gap-3">
                    <div class="w-8 h-8 bg-slate-800 text-white rounded flex items-center justify-center font-black text-xs">${escHtml(className.charAt(0))}</div>
                    <div>
                        <p class="font-black text-slate-800 text-sm">${escHtml(className)}</p>
                        <p class="text-[10px] text-slate-500 font-bold uppercase tracking-widest">${hasGrades ? `${Object.keys(semesters).length} term${Object.keys(semesters).length !== 1 ? 's' : ''} · ${allClassGrades.length} entries` : 'Evaluations only'}</p>
                    </div>
                </div>
                <div class="flex items-center gap-3">
                    ${classAvg === null ? '' : `<span class="${ca} border font-black text-xs px-2 py-1 rounded">${classAvg}% Overall</span>`}
                    <i class="fa-solid fa-chevron-down text-slate-400" style="transition:transform 0.2s"></i>
                </div>
            </div>
            <div class="subject-body border-t border-slate-200">
                <div class="p-4">${termBlocks}${renderClassEvaluations(className, semName)}</div>
            </div>
        </div>`;
    }).join('') + renderUnclassifiedEvaluations(semName);
};

// ── MANAGE PARENT — dual-role email lookup UI (Phase 3) ──────────────────
// UI CORRECTION MANDATE: checks whether a parent is already linked to the
// student whose panel just opened, BEFORE the admin ever sees a form.
// mpLoading shows while the check is in flight; exactly one of
// mpLinkedView (editable contact card, wired to updateParentContact) or
// mpSearchView (the pre-existing search-then-link/create flow, unchanged)
// is shown once it resolves. Failures fall back to the search view rather
// than leaving the tab stuck on a spinner — worst case the admin just
// re-links a parent who was already linked, which linkOrCreateParent
// handles idempotently (Case B: append to existing parent) anyway.
async function refreshManageParentTab(studentId) {
    currentLinkedParentId = null;

    document.getElementById('mpLoading').classList.remove('hidden');
    document.getElementById('mpLinkedView').classList.add('hidden');
    document.getElementById('mpSearchView').classList.add('hidden');
    document.getElementById('mpEmailInput').value = '';
    document.getElementById('mpResult').innerHTML = '';
    document.getElementById('mpEditMsg').classList.add('hidden');

    try {
        const res = await getLinkedParentForStudentFn({ studentId, schoolId: session.schoolId });
        if (res.data.linked) {
            currentLinkedParentId = res.data.parentId;
            const [first, ...rest] = String(res.data.name || '').trim().split(/\s+/);
            document.getElementById('mpEditFirstName').value = first || '';
            document.getElementById('mpEditLastName').value  = rest.join(' ');
            document.getElementById('mpEditEmail').value     = res.data.email || '';
            document.getElementById('mpEditPhone').value     = res.data.phone || '';
            document.getElementById('mpLoading').classList.add('hidden');
            document.getElementById('mpLinkedView').classList.remove('hidden');
        } else {
            document.getElementById('mpLoading').classList.add('hidden');
            document.getElementById('mpSearchView').classList.remove('hidden');
        }
    } catch (e) {
        console.error('[Manage Parent] refreshManageParentTab:', e);
        document.getElementById('mpLoading').classList.add('hidden');
        document.getElementById('mpSearchView').classList.remove('hidden');
    }
}

window.saveParentContact = async function () {
    const first = document.getElementById('mpEditFirstName').value.trim();
    const last  = document.getElementById('mpEditLastName').value.trim();
    const email = document.getElementById('mpEditEmail').value.trim();
    const phone = document.getElementById('mpEditPhone').value.trim();
    const msgEl = document.getElementById('mpEditMsg');

    if (!first || !email || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) {
        msgEl.textContent = 'First name and a valid email are required.';
        msgEl.className = 'text-xs font-bold mt-2 text-rose-600';
        msgEl.classList.remove('hidden');
        return;
    }

    const btn = document.getElementById('mpSaveContactBtn');
    btn.disabled = true; btn.innerHTML = '<i class="fa-solid fa-spinner fa-spin mr-1"></i>Saving…';

    try {
        await updateParentContactFn({
            parentId: currentLinkedParentId, schoolId: session.schoolId,
            name: `${first} ${last}`.trim(), email, phone
        });
        msgEl.textContent = 'Contact info updated.';
        msgEl.className = 'text-xs font-bold mt-2 text-emerald-600';
        msgEl.classList.remove('hidden');
    } catch (e) {
        console.error('[Manage Parent] saveParentContact:', e);
        msgEl.textContent = e?.message || 'Failed to save. Please try again.';
        msgEl.className = 'text-xs font-bold mt-2 text-rose-600';
        msgEl.classList.remove('hidden');
    }

    btn.disabled = false; btn.innerHTML = '<i class="fa-solid fa-floppy-disk mr-1"></i>Save Changes';
};

// Search -> Found (show name, "Link to Student" button) OR Not Found (show
// a First/Last/Email/Phone creation form). Both branches ultimately call
// the SAME linkOrCreateParentFn Cloud Function this file already imports
// for student-creation-time auto-linking — this tab is just a second,
// explicit entry point into it, scoped to whichever student's panel is
// currently open (currentStudentId). Only reached when
// refreshManageParentTab() found no existing link.
window.searchParentByEmail = async function () {
    const emailInput = document.getElementById('mpEmailInput');
    const resultEl    = document.getElementById('mpResult');
    const email       = emailInput.value.trim();

    if (!email || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) {
        resultEl.innerHTML = '<p class="text-xs font-bold text-rose-600 mt-3">Enter a valid email address to search.</p>';
        return;
    }

    const btn = document.getElementById('mpSearchBtn');
    btn.disabled = true; btn.textContent = 'Searching…';
    resultEl.innerHTML = '<p class="text-xs text-slate-400 font-bold mt-3"><i class="fa-solid fa-circle-notch fa-spin mr-1"></i>Searching…</p>';

    try {
        const res = await lookupParentByEmailFn({ schoolId: session.schoolId, parentEmail: email });
        if (res.data.found) {
            renderParentFound(res.data, email);
        } else {
            renderParentNotFound(email);
        }
    } catch (e) {
        console.error('[Manage Parent] search failed:', e);
        resultEl.innerHTML = '<p class="text-xs font-bold text-rose-600 mt-3">Search failed. Please try again.</p>';
    }

    btn.disabled = false; btn.textContent = 'Search';
};

function renderParentFound(data, email) {
    const resultEl = document.getElementById('mpResult');
    resultEl.innerHTML = `
        <div class="mt-4 p-4 bg-emerald-50 border border-emerald-200 rounded-lg">
            <p class="text-xs font-black text-emerald-700 uppercase tracking-wide mb-1"><i class="fa-solid fa-circle-check mr-1"></i>Parent Found</p>
            <p class="text-sm font-bold text-slate-800">${escHtml(data.name || 'Parent/Guardian')}</p>
            <p class="text-xs text-slate-500 mb-3">${escHtml(email)}</p>
            ${data.alreadyLinkedHere ? '<p class="text-xs font-bold text-amber-600 mb-3"><i class="fa-solid fa-triangle-exclamation mr-1"></i>This parent already has at least one child linked at this school.</p>' : ''}
            <button onclick="window.linkFoundParent('${escHtml(email)}')" id="mpLinkBtn" class="w-full bg-emerald-600 hover:bg-emerald-700 text-white font-bold px-4 py-2.5 rounded-lg text-xs transition"><i class="fa-solid fa-link mr-1"></i>Link to This Student</button>
        </div>`;
}

function renderParentNotFound(email) {
    const resultEl = document.getElementById('mpResult');
    resultEl.innerHTML = `
        <div class="mt-4 p-4 bg-slate-50 border border-slate-200 rounded-lg">
            <p class="text-xs font-black text-slate-500 uppercase tracking-wide mb-3"><i class="fa-solid fa-user-plus mr-1"></i>No Parent Found — Create New</p>
            <div class="space-y-2.5">
                <input type="text" id="mpFirstName" placeholder="First Name" class="w-full p-2.5 bg-white border border-slate-200 rounded-lg text-sm outline-none focus:border-blue-400">
                <input type="text" id="mpLastName" placeholder="Last Name" class="w-full p-2.5 bg-white border border-slate-200 rounded-lg text-sm outline-none focus:border-blue-400">
                <input type="email" id="mpNewEmail" value="${escHtml(email)}" placeholder="Email" class="w-full p-2.5 bg-white border border-slate-200 rounded-lg text-sm outline-none focus:border-blue-400">
                <input type="tel" id="mpNewPhone" placeholder="Phone (optional)" class="w-full p-2.5 bg-white border border-slate-200 rounded-lg text-sm outline-none focus:border-blue-400">
            </div>
            <button onclick="window.createAndLinkParent()" id="mpCreateBtn" class="w-full mt-3 bg-blue-600 hover:bg-blue-700 text-white font-bold px-4 py-2.5 rounded-lg text-xs transition"><i class="fa-solid fa-plus mr-1"></i>Create &amp; Link Parent</button>
            <p id="mpCreateMsg" class="hidden text-xs font-bold mt-2"></p>
        </div>`;
}

window.linkFoundParent = async function (email) {
    const btn = document.getElementById('mpLinkBtn');
    btn.disabled = true; btn.innerHTML = '<i class="fa-solid fa-spinner fa-spin mr-1"></i>Linking…';

    try {
        await linkOrCreateParentFn({ studentId: currentStudentId, schoolId: session.schoolId, parentEmail: email });
        document.getElementById('mpResult').innerHTML = '<p class="text-xs font-bold text-emerald-600 mt-3"><i class="fa-solid fa-circle-check mr-1"></i>Linked successfully.</p>';
    } catch (e) {
        console.error('[Manage Parent] link failed:', e);
        btn.disabled = false; btn.innerHTML = '<i class="fa-solid fa-link mr-1"></i>Link to This Student';
        alert('Failed to link parent. Please try again.');
    }
};

window.createAndLinkParent = async function () {
    const first  = document.getElementById('mpFirstName').value.trim();
    const last   = document.getElementById('mpLastName').value.trim();
    const email  = document.getElementById('mpNewEmail').value.trim();
    const phone  = document.getElementById('mpNewPhone').value.trim();
    const msgEl  = document.getElementById('mpCreateMsg');

    if (!first || !last || !email || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) {
        msgEl.textContent = 'First name, last name, and a valid email are all required.';
        msgEl.className = 'text-xs font-bold mt-2 text-rose-600';
        msgEl.classList.remove('hidden');
        return;
    }

    const btn = document.getElementById('mpCreateBtn');
    btn.disabled = true; btn.innerHTML = '<i class="fa-solid fa-spinner fa-spin mr-1"></i>Creating…';

    try {
        await linkOrCreateParentFn({ studentId: currentStudentId, schoolId: session.schoolId, parentName: `${first} ${last}`, parentEmail: email, parentPhone: phone });
        document.getElementById('mpResult').innerHTML = '<p class="text-xs font-bold text-emerald-600 mt-3"><i class="fa-solid fa-circle-check mr-1"></i>Parent account created and linked. A welcome email with login credentials has been sent.</p>';
    } catch (e) {
        console.error('[Manage Parent] create failed:', e);
        btn.disabled = false; btn.innerHTML = '<i class="fa-solid fa-plus mr-1"></i>Create &amp; Link Parent';
        msgEl.textContent = 'Failed to create parent account. Please try again.';
        msgEl.className = 'text-xs font-bold mt-2 text-rose-600';
        msgEl.classList.remove('hidden');
    }
};

// ── INITIALIZE ────────────────────────────────────────────────────────────
document.addEventListener('DOMContentLoaded', loadData);
