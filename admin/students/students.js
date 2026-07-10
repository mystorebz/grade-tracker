import { db } from '../../assets/js/firebase-init.js';
import { collection, doc, getDoc, getDocs, setDoc, updateDoc, query, where, arrayUnion, writeBatch } from "https://www.gstatic.com/firebasejs/10.7.1/firebase-firestore.js"; // ── FIX: added writeBatch
import { requireAuth } from '../../assets/js/auth.js';
import { injectAdminLayout } from '../../assets/js/layout-admin.js';
import { openOverlay, closeOverlay, letterGrade, calculateWeightedAverage } from '../../assets/js/utils.js';

// ── 1. INIT & AUTH ────────────────────────────────────────────────────────
const session = requireAuth('admin', '../login.html');
injectAdminLayout('students', 'School Directory', 'All enrolled students and their academic records', true, false);

// ── 2. STATE ──────────────────────────────────────────────────────────────
let allStudentsCache       = [];
let allTeachersCache       = [];
let rawSemesters           = [];
let activeSemesterId       = '';   // resolved once at load for the end-of-term gate + missing-grade flag
let activeSemesterObj      = null; // the active semester record (for startDate/endDate)
let schoolClasses          = [];
let currentStudentId       = null;
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
    return String(Math.floor(100000 + Math.random() * 900000));
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
        schoolClasses = snap.docs
            .map(d => ({ id: d.id, ...d.data() }))
            .sort((a, b) => (a.order ?? 0) - (b.order ?? 0) || (a.name || '').localeCompare(b.name || ''))
            .map(c => c.name)
            .filter(Boolean);
    } catch (e) {
        console.error('[Students] loadSchoolClasses:', e);
        schoolClasses = [];
    }
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
        const [sSnap, tSnap] = await Promise.all([
            getDocs(query(collection(db, 'students'), where('currentSchoolId', '==', session.schoolId))),
            getDocs(query(collection(db, 'teachers'),  where('currentSchoolId', '==', session.schoolId)))
        ]);

        const tm = {};
        allTeachersCache = [];
        tSnap.forEach(d => {
            tm[d.id] = d.data().name;
            if (!d.data().archived) allTeachersCache.push({ id: d.id, ...d.data() });
        });

        allStudentsCache = sSnap.docs
            .filter(d => !d.data().archived)
            .map(d => ({ id: d.id, ...d.data(), teacherName: tm[d.data().teacherId] || '—' }));

        const teacherWeightsById = {};
        allTeachersCache.forEach(t => {
            teacherWeightsById[t.id] = t.gradeTypes || t.customGradeTypes || currentTeacherWeights;
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
        if (targetEmail) {
            const regSnap = await getDoc(doc(db, 'registered_emails', targetEmail));
            if (regSnap.exists()) {
                msgEl.textContent = 'This email is already registered to another account in our system.';
                msgEl.classList.remove('hidden');
                btn.disabled = false;
                btn.innerHTML = `<i class="fa-solid fa-user-plus mr-2"></i> Create New Student Identity`;
                return;
            }
        }

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
            teacherId:            '',
            currentSchoolId:      session.schoolId,
            enrollmentStatus:     'Active',
            pin:                  generatePin(),
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

        if (targetEmail) {
            const emailRef = doc(db, 'registered_emails', targetEmail);
            batch.set(emailRef, {
                email: targetEmail,
                name: `${firstName} ${lastName}`.trim(),
                role: 'student',
                referenceId: studentId,
                createdAt: new Date().toISOString()
            });
        }

        await batch.commit();
        window.closeAddStudentModal();
        await loadData();

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

window.openStudentPanel = async function (studentId) {
    currentStudentId = studentId;
    const student    = allStudentsCache.find(s => s.id === studentId);
    currentStudentClass = student?.className || '';   // scope the Academic tab to this

    document.getElementById('sPanelName').textContent = student?.name || 'Student';
    document.getElementById('sPanelId').textContent   = student?.id   || '—';
    document.getElementById('sEnrollDropdown')?.classList.add('hidden');

    const infoGrid = document.getElementById('sInfoGrid');
    if (infoGrid) {
        infoGrid.innerHTML = [
            ['Name',             student?.name        || '—'],
            ['Date of Birth',    student?.dob         || '—'],
            ['Current Class',    student?.className   || 'Unassigned'],
            ['Assigned Teacher', student?.teacherName || 'Unassigned'],
            ['Parent/Guardian',  student?.parentName  || '—'],
            ['Parent Phone',     student?.parentPhone || '—'],
            ['Parent Email',     student?.email       || '—'],
            ['Enrolled At',      student?.createdAt ? new Date(student.createdAt).toLocaleDateString() : '—']
        ].map(([label, value]) => `
            <div class="flex justify-between items-center py-2 border-b border-slate-100 last:border-0">
                <span class="text-xs font-bold text-slate-400 uppercase tracking-wider">${label}</span>
                <span class="text-sm font-semibold text-slate-700">${escHtml(value)}</span>
            </div>
        `).join('');
    }

    window.switchStudentTab('overview');
    document.getElementById('sPanelLoader')?.classList.remove('hidden');
    openOverlay('studentPanel', 'studentPanelInner', true);

    try {
        if (student?.teacherId) {
            const tDoc = await getDoc(doc(db, 'teachers', student.teacherId));
            if (tDoc.exists() && tDoc.data().gradeTypes) currentTeacherWeights = tDoc.data().gradeTypes;
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
        await updateDoc(doc(db, 'students', currentStudentId), { className, teacherId });
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

    btn.innerHTML = '<i class="fa-solid fa-spinner fa-spin mr-2"></i>Archiving...';
    btn.disabled  = true;

    try {
        const studentToArchive = allStudentsCache.find(s => s.id === currentStudentId);

        let academicSnapshot = {};
        try {
            let gradeTypes = ['Test', 'Quiz', 'Assignment', 'Homework', 'Project', 'Midterm Exam', 'Final Exam'];
            if (studentToArchive?.teacherId) {
                const tDoc = await getDoc(doc(db, 'teachers', studentToArchive.teacherId));
                if (tDoc.exists()) {
                    gradeTypes = tDoc.data().gradeTypes || tDoc.data().customGradeTypes || gradeTypes;
                }
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
            evalSnap.sort((a, b) => new Date(b.date || b.createdAt || 0) - new Date(a.date || a.createdAt || 0));

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

        batch.update(doc(db, 'students', currentStudentId), {
            archived:          true,
            archivedAt:        new Date().toISOString(),
            archiveReason:     reason || 'Not specified',
            teacherId:         '',
            className:         '',
            lastClassName:     studentToArchive?.className || '',
            archivedSchoolIds: arrayUnion(session.schoolId),
            academicSnapshot
        });

        // ── FIX: free the email so this student can be re-enrolled elsewhere ──
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

// ── INITIALIZE ────────────────────────────────────────────────────────────
document.addEventListener('DOMContentLoaded', loadData);
