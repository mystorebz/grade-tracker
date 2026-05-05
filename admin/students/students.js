import { db } from '../../assets/js/firebase-init.js';
import { collection, doc, getDoc, getDocs, setDoc, updateDoc, query, where } from "https://www.gstatic.com/firebasejs/10.7.1/firebase-firestore.js";
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
let currentStudentId       = null;
let currentStudentGradesCache = [];
let currentTeacherWeights  = ['Test', 'Quiz', 'Assignment', 'Midterm Exam', 'Final Exam'];

const CLASSES = {
    'Primary':        ['Infant 1', 'Infant 2', 'Standard 1', 'Standard 2', 'Standard 3', 'Standard 4', 'Standard 5', 'Standard 6'],
    'High School':    ['First Form', 'Second Form', 'Third Form', 'Fourth Form'],
    'Junior College': ['Year 1', 'Year 2']
};

const tbody             = document.getElementById('studentsTableBody');
const filterClassSelect = document.getElementById('filterStudentClass');
const filterTeacherSelect = document.getElementById('filterStudentTeacher');
const searchInput       = document.getElementById('searchInput');

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

// ── 4. LOAD DATA ──────────────────────────────────────────────────────────
async function loadData() {
    try {
        const semSnap = await getDocs(collection(db, 'schools', session.schoolId, 'semesters'));
        rawSemesters  = semSnap.docs.map(d => ({ id: d.id, ...d.data() })).sort((a, b) => (a.order || 0) - (b.order || 0));
    } catch (e) { console.error("Error loading semesters:", e); }

    if (!tbody) return;
    tbody.innerHTML = `<tr><td colspan="5" class="px-6 py-16 text-center text-slate-400 font-semibold"><i class="fa-solid fa-spinner fa-spin text-blue-500 text-2xl mb-3 block"></i>Loading directory...</td></tr>`;

    try {
        const [sSnap, tSnap] = await Promise.all([
            getDocs(query(collection(db, 'students'), where('currentSchoolId', '==', session.schoolId))),
            getDocs(query(collection(db, 'teachers'), where('currentSchoolId', '==', session.schoolId)))
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

        if (filterTeacherSelect && filterTeacherSelect.options.length <= 1) {
            filterTeacherSelect.innerHTML = '<option value="">All Teachers</option>' +
                allTeachersCache.map(t => `<option value="${t.id}">${t.name}</option>`).join('');
        }

        if (filterClassSelect && filterClassSelect.options.length <= 2) {
            const classList = CLASSES[session.schoolType || 'Primary'] || CLASSES['Primary'];
            filterClassSelect.innerHTML = '<option value="">All Classes</option><option value="unassigned">Unassigned Only</option>' +
                classList.map(c => `<option value="${c}">${c}</option>`).join('');
        }

        renderTable();
    } catch (e) {
        console.error("Error loading students:", e);
        if (tbody) tbody.innerHTML = `<tr><td colspan="5" class="px-6 py-16 text-center text-red-500 font-semibold">Failed to load directory data.</td></tr>`;
    }
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
        const classBadge   = s.className ? s.className : '<span class="bg-amber-100 text-amber-700 text-[10px] font-black px-2 py-0.5 rounded-md uppercase">Unassigned</span>';
        const displayStyle = (s.name || '').toLowerCase().includes(term) || s.id.toLowerCase().includes(term) ? '' : 'display:none;';

        return `
        <tr class="trow border-b border-slate-100 hover:bg-slate-50 transition" style="${displayStyle}">
            <td class="px-6 py-4">
                <div class="flex items-center gap-3">
                    <div class="h-10 w-10 bg-gradient-to-br from-blue-500 to-indigo-600 text-white rounded-xl flex items-center justify-center font-black text-sm shadow-sm flex-shrink-0">${(s.name || '?').charAt(0).toUpperCase()}</div>
                    <div>
                        <span class="font-black text-slate-700 block">${escHtml(s.name || 'Unnamed')}</span>
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

// ── 6. ADD STUDENT (Identity Only — no class/teacher) ─────────────────────
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
        let studentId;
        let attempts = 0;
        do {
            studentId = generateStudentId();
            const existing = await getDoc(doc(db, 'students', studentId));
            if (!existing.exists()) break;
            attempts++;
        } while (attempts < 5);

        await setDoc(doc(db, 'students', studentId), {
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
            requiresPinReset:     true,
            securityQuestionsSet: false,
            profileComplete:      false,
            academicHistory:      [],
            createdAt:            new Date().toISOString()
        });

        window.closeAddStudentModal();
        await loadData();

    } catch (e) {
        console.error('[Add Student]', e);
        msgEl.textContent = 'Failed to create student. Please try again.';
        msgEl.classList.remove('hidden');
    }

    btn.disabled  = false;
    btn.innerHTML = `<i class="fa-solid fa-user-plus mr-2"></i> Create Student`;
});

// ── 7. SEARCH REGISTRY ────────────────────────────────────────────────────
window.openSearchRegistryModal = function () {
    document.getElementById('regSearchQuery').value = '';
    document.getElementById('regSearchResults').innerHTML  = '';
    document.getElementById('regSearchResults').classList.add('hidden');
    document.getElementById('regFullProfile').classList.add('hidden');
    openOverlay('searchRegistryModal', 'searchRegistryModalInner');
};

window.closeSearchRegistryModal = function () {
    closeOverlay('searchRegistryModal', 'searchRegistryModalInner');
};

// Allow Enter key in search input
document.getElementById('regSearchQuery')?.addEventListener('keydown', e => {
    if (e.key === 'Enter') window.searchRegistry();
});

window.searchRegistry = async function () {
    const rawId     = (document.getElementById('regSearchQuery').value || '').trim().toUpperCase();
    const resultsEl = document.getElementById('regSearchResults');
    const profileEl = document.getElementById('regFullProfile');

    profileEl.classList.add('hidden');
    resultsEl.classList.remove('hidden');

    if (!rawId) {
        resultsEl.innerHTML = `<p class="text-xs font-bold text-red-500 text-center py-4">Please enter a Student ID.</p>`;
        return;
    }

    if (!/^S\d{2}-[A-Z0-9]{5}$/.test(rawId)) {
        resultsEl.innerHTML = `<p class="text-xs font-bold text-red-500 text-center py-4">Invalid format. Student ID should look like S26-XXXXX.</p>`;
        return;
    }

    resultsEl.innerHTML = `<p class="text-xs font-semibold text-slate-400 text-center py-4"><i class="fa-solid fa-spinner fa-spin mr-2"></i>Searching national registry...</p>`;

    const searchBtn     = document.getElementById('regSearchBtn');
    searchBtn.disabled  = true;

    try {
        const snap = await getDoc(doc(db, 'students', rawId));

        if (!snap.exists()) {
            resultsEl.innerHTML = `<p class="text-xs font-bold text-slate-400 text-center py-4">No student found with that ID in the ConnectUs platform.</p>`;
            searchBtn.disabled  = false;
            return;
        }

        const s = { id: snap.id, ...snap.data() };

        // Already at this school
        if (s.currentSchoolId === session.schoolId) {
            resultsEl.innerHTML = `<p class="text-xs font-bold text-blue-600 text-center py-4"><i class="fa-solid fa-circle-check mr-2"></i>This student is already enrolled at your school.</p>`;
            searchBtn.disabled  = false;
            return;
        }

        // At another school — blocked
        if (s.currentSchoolId && s.currentSchoolId !== '') {
            resultsEl.innerHTML = `<p class="text-xs font-bold text-red-500 text-center py-4"><i class="fa-solid fa-lock mr-2"></i>This student is currently enrolled at another school. Their current school must close enrollment first.</p>`;
            searchBtn.disabled  = false;
            return;
        }

        // Unassigned — show full global passport
        resultsEl.classList.add('hidden');
        await renderRegistryProfile(s);

    } catch (e) {
        console.error('[Search Registry]', e);
        resultsEl.innerHTML = `<p class="text-xs font-bold text-red-500 text-center py-4">Search failed. Please try again.</p>`;
    }

    searchBtn.disabled = false;
};

async function renderRegistryProfile(s) {
    const profileEl = document.getElementById('regFullProfile');
    profileEl.classList.remove('hidden');

    document.getElementById('regProfileName').textContent = s.name || 'Unknown';
    document.getElementById('regProfileId').textContent   = s.id;

    // Identity
    document.getElementById('regIdentityGrid').innerHTML = [
        ['Date of Birth',     s.dob         || '—'],
        ['Email',             s.email        || '—'],
        ['Parent / Guardian', s.parentName   || '—'],
        ['Parent Phone',      s.parentPhone  || '—'],
    ].map(([label, value]) => `
        <div class="flex justify-between items-center py-2 border-b border-slate-100 last:border-0">
            <span class="text-[10px] font-bold text-slate-400 uppercase tracking-wider">${label}</span>
            <span class="text-sm font-semibold text-slate-700">${escHtml(value)}</span>
        </div>
    `).join('');

    // Academic History
    const history = s.academicHistory || [];
    const histEl  = document.getElementById('regAcademicHistory');
    histEl.innerHTML = !history.length
        ? `<p class="text-xs text-slate-400 font-semibold italic text-center py-3">No prior school history on record.</p>`
        : history.map(h => `
            <div class="flex justify-between items-start py-2 border-b border-slate-100 last:border-0">
                <div>
                    <p class="text-sm font-bold text-slate-700">${escHtml(h.schoolName || h.schoolId || '—')}</p>
                    <p class="text-[10px] font-semibold text-slate-400 uppercase tracking-wider">${escHtml(h.className || '—')} · Left: ${h.leftAt ? new Date(h.leftAt).toLocaleDateString() : '—'}</p>
                </div>
                <span class="text-[10px] font-bold text-slate-500 bg-slate-100 px-2 py-1 rounded flex-shrink-0 ml-3">${escHtml(h.reason || '—')}</span>
            </div>`).join('');

    // All grades — no school filter (full global passport view)
    const gradesEl = document.getElementById('regGradesList');
    gradesEl.innerHTML = `<p class="text-xs text-slate-400 text-center py-4"><i class="fa-solid fa-spinner fa-spin mr-2"></i>Loading academic records...</p>`;

    try {
        const gradesSnap = await getDocs(collection(db, 'students', s.id, 'grades'));
        const allGrades  = [];
        gradesSnap.forEach(d => allGrades.push({ id: d.id, ...d.data() }));

        if (!allGrades.length) {
            gradesEl.innerHTML = `<p class="text-xs text-slate-400 font-semibold italic text-center py-4">No academic grades on record.</p>`;
        } else {
            const bySubj = {};
            allGrades.forEach(g => {
                const subj = g.subject || 'Uncategorized';
                if (!bySubj[subj]) bySubj[subj] = [];
                bySubj[subj].push(g);
            });

            gradesEl.innerHTML = Object.entries(bySubj).map(([subject, grades]) => {
                const avg = Math.round(grades.reduce((a, g) => a + (g.max ? (g.score / g.max) * 100 : 0), 0) / grades.length);
                const ac  = avg >= 75 ? 'text-green-700 bg-green-50 border-green-200' : avg >= 60 ? 'text-amber-700 bg-amber-50 border-amber-200' : 'text-red-700 bg-red-50 border-red-200';
                return `
                <div class="flex items-center justify-between py-2 border-b border-slate-100 last:border-0">
                    <div class="flex items-center gap-2">
                        <div class="w-7 h-7 bg-slate-800 text-white rounded flex items-center justify-center font-black text-[10px]">${subject.charAt(0)}</div>
                        <div>
                            <p class="text-sm font-bold text-slate-700">${escHtml(subject)}</p>
                            <p class="text-[10px] text-slate-400 font-semibold">${grades.length} assessments</p>
                        </div>
                    </div>
                    <span class="${ac} border font-black text-xs px-2 py-1 rounded">${avg}% · ${letterGrade(avg)}</span>
                </div>`;
            }).join('');
        }
    } catch (e) {
        gradesEl.innerHTML = `<p class="text-xs text-red-500 font-bold text-center py-4">Could not load grades.</p>`;
    }

    document.getElementById('regClaimBtn').dataset.studentId = s.id;
}

window.claimRegistryStudent = async function () {
    const btn       = document.getElementById('regClaimBtn');
    const studentId = btn.dataset.studentId;
    if (!studentId) return;

    btn.disabled  = true;
    btn.innerHTML = `<i class="fa-solid fa-spinner fa-spin mr-2"></i>Enrolling...`;

    try {
        await updateDoc(doc(db, 'students', studentId), {
            currentSchoolId:  session.schoolId,
            enrollmentStatus: 'Active',
            teacherId:        '',
            className:        ''
        });
        window.closeSearchRegistryModal();
        await loadData();
    } catch (e) {
        console.error('[Claim Registry Student]', e);
        alert('Failed to enroll student. Please try again.');
        btn.disabled  = false;
        btn.innerHTML = `<i class="fa-solid fa-user-check mr-2"></i> Claim & Enrol into School`;
    }
};

// ── 8. STUDENT PANEL & TABS ───────────────────────────────────────────────
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

        const gradesSnap = await getDocs(query(
            collection(db, 'students', studentId, 'grades'),
            where('schoolId', '==', session.schoolId)
        ));
        currentStudentGradesCache = [];
        gradesSnap.forEach(d => currentStudentGradesCache.push({ id: d.id, ...d.data() }));

        const semSelect = document.getElementById('sPanelSemester');
        let activeId    = '';
        const schoolDoc = await getDoc(doc(db, 'schools', session.schoolId));
        if (schoolDoc.exists()) activeId = schoolDoc.data().activeSemesterId || '';

        semSelect.innerHTML = rawSemesters.map(s => `<option value="${s.id}" ${s.id === activeId ? 'selected' : ''}>${s.name}</option>`).join('');
        if (!rawSemesters.length) semSelect.innerHTML = '<option value="">No Terms Found</option>';

        window.renderAdminGrades();
    } catch (e) {
        console.error(e);
    } finally {
        document.getElementById('sPanelLoader')?.classList.add('hidden');
    }
};

window.closeStudentPanel = function () { closeOverlay('studentPanel', 'studentPanelInner', true); };

// ── 9. RENDER ADMIN GRADES ────────────────────────────────────────────────
window.renderAdminGrades = function () {
    const container  = document.getElementById('subjectAccordions');
    if (!container) return;

    const termId     = document.getElementById('sPanelSemester').value;
    const filterSubj = document.getElementById('sPanelFilterSubject').value;
    const filterType = document.getElementById('sPanelFilterType').value;

    let filteredGrades = currentStudentGradesCache.filter(g => g.semesterId === termId);

    const subjSet = [...new Set(filteredGrades.map(g => g.subject || 'Uncategorized'))].sort();
    const typeSet = [...new Set(filteredGrades.map(g => g.type    || 'Uncategorized'))].sort();

    document.getElementById('sPanelFilterSubject').innerHTML = '<option value="">All Subjects</option>' + subjSet.map(s => `<option value="${s}" ${s === filterSubj ? 'selected' : ''}>${s}</option>`).join('');
    document.getElementById('sPanelFilterType').innerHTML    = '<option value="">All Types</option>'    + typeSet.map(t => `<option value="${t}" ${t === filterType ? 'selected' : ''}>${t}</option>`).join('');

    if (filterSubj) filteredGrades = filteredGrades.filter(g => g.subject === filterSubj);
    if (filterType) filteredGrades = filteredGrades.filter(g => g.type    === filterType);

    if (!filteredGrades.length) {
        container.innerHTML = `<div class="text-center py-16 bg-white rounded-xl border border-slate-200"><i class="fa-solid fa-folder-open text-4xl text-slate-300 mb-3"></i><p class="text-slate-400 font-semibold">No grades recorded for these filters.</p></div>`;
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
            <div class="subject-body open p-3 bg-slate-100 space-y-2 border-t border-slate-200">${rows}</div>
        </div>`;
    }).join('');
};

window.toggleSubjectAccordion = function (header) {
    const body    = header.nextElementSibling;
    body.classList.toggle('open');
    const chevron = header.querySelector('.fa-chevron-down');
    if (chevron) chevron.style.transform = body.classList.contains('open') ? 'rotate(180deg)' : 'rotate(0deg)';
};

// ── 10. PRINT RECORDS ─────────────────────────────────────────────────────
window.openPrintStudentModal = function () {
    const termId     = document.getElementById('sPanelSemester')?.value;
    const termGrades = currentStudentGradesCache.filter(g => g.semesterId === termId);
    const subjSet    = [...new Set(termGrades.map(g => g.subject || 'Uncategorized'))].sort();

    document.getElementById('psSubject').innerHTML = '<option value="all">All Subjects</option>' +
        subjSet.map(s => `<option value="${escHtml(s)}">${s}</option>`).join('');

    openOverlay('printStudentModal', 'printStudentModalInner');
};

window.closePrintStudentModal = function () { closeOverlay('printStudentModal', 'printStudentModalInner'); };

window.executeStudentPrint = function () {
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
    const schoolName    = session.schoolName || 'ConnectUs School';

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
        <img src="${session.logo || ''}" alt="${escHtml(schoolName)}" class="logo" onerror="this.style.display='none'">
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
        <div class="ac"><div class="av">${totalAssessments}</div><div class="al">Total Assessments</div></div>
    </div>
    <table><thead><tr><th>Subject / Assignment</th><th class="c">Count / Score</th><th class="c">Average</th><th class="c">Grade</th></tr></thead>
    <tbody>${gradesHtml}</tbody></table>
    <div class="ft">Official report for <strong>${escHtml(schoolName)}</strong> · Issued ${new Date().toLocaleDateString('en-US',{year:'numeric',month:'long',day:'numeric'})}</div>
    </body></html>`;

    const w = window.open('', '_blank');
    w.document.write(html);
    w.document.close();
    window.closePrintStudentModal();
    setTimeout(() => w.print(), 800);
};

// ── 11. ARCHIVE & REASSIGN ────────────────────────────────────────────────
window.openReassignModal = function () {
    document.getElementById('sEnrollDropdown')?.classList.add('hidden');
    const s = allStudentsCache.find(x => x.id === currentStudentId);
    if (!s) return;

    const cSelect = document.getElementById('rsClass');
    if (cSelect) {
        const classList = CLASSES[session.schoolType || 'Primary'] || CLASSES['Primary'];
        cSelect.innerHTML = '<option value="">-- Unassigned --</option>' +
            classList.map(c => `<option value="${c}" ${s.className === c ? 'selected' : ''}>${c}</option>`).join('');
    }

    const tSelect = document.getElementById('rsTeacher');
    if (tSelect) {
        tSelect.innerHTML = '<option value="">-- Unassigned --</option>' +
            allTeachersCache.map(t => `<option value="${t.id}" ${s.teacherId === t.id ? 'selected' : ''}>${t.name}</option>`).join('');
    }

    openOverlay('reassignStudentModal', 'reassignStudentModalInner');
};

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
        await updateDoc(doc(db, 'students', currentStudentId), {
            archived:      true,
            archivedAt:    new Date().toISOString(),
            archiveReason: reason || 'Not specified',
            teacherId:     '',
            className:     ''
        });
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

// ── 12. CSV EXPORT ────────────────────────────────────────────────────────
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

// ── INITIALIZE ────────────────────────────────────────────────────────────
document.addEventListener('DOMContentLoaded', loadData);
