import { db } from '../../assets/js/firebase-init.js';
import {
    collection, query, where,
    getDocs, getDoc, doc,
    setDoc, updateDoc, writeBatch,
    arrayUnion, addDoc
} from "https://www.gstatic.com/firebasejs/10.7.1/firebase-firestore.js";
import { requireAuth } from '../../assets/js/auth.js';
import { injectAdminLayout } from '../../assets/js/layout-admin.js';
import { openOverlay, closeOverlay, showMsg, letterGrade } from '../../assets/js/utils.js';

// ── 1. AUTH & INIT ─────────────────────────────────────────────────────────
const session = requireAuth('admin', '../login.html');
injectAdminLayout('students', 'National Student Registry', 'Lifelong student identities and academic records', true, false);

// ── 2. STATE ───────────────────────────────────────────────────────────────
let allStudentsCache  = [];
let allTeachersCache  = [];
let currentStudentId  = null;         // Global doc ID (= studentIdNum)
let claimedStudentDoc = null;         // Temp hold during claim lookup

const CLASSES = {
    'Primary':       ['Infant 1','Infant 2','Standard 1','Standard 2','Standard 3','Standard 4','Standard 5','Standard 6'],
    'High School':   ['First Form','Second Form','Third Form','Fourth Form'],
    'Junior College':['Year 1','Year 2']
};

const tbody               = document.getElementById('studentsTableBody');
const filterClassSelect   = document.getElementById('filterStudentClass');
const filterTeacherSelect = document.getElementById('filterStudentTeacher');
const filterStatusSelect  = document.getElementById('filterStudentStatus');

// ── 3. HELPERS ─────────────────────────────────────────────────────────────
function generateStudentId() {
    const year  = new Date().getFullYear().toString().slice(-2);
    const chars = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789'; // No ambiguous chars
    let rand = '';
    for (let i = 0; i < 5; i++) rand += chars.charAt(Math.floor(Math.random() * chars.length));
    return `S${year}-${rand}`;
}

function generatePin() {
    return Math.floor(1000 + Math.random() * 9000).toString(); // 4-digit
}

function escHtml(str) {
    if (!str) return '';
    return String(str).replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/"/g,'&quot;');
}

function statusBadge(status) {
    const map = {
        'Active':      'status-active',
        'Transferred': 'status-transferred',
        'Graduated':   'status-graduated',
        'Archived':    'status-archived',
    };
    const cls = map[status] || 'status-archived';
    return `<span class="text-[10px] font-black px-2 py-0.5 rounded-md uppercase tracking-wider ${cls}">${status || 'Unknown'}</span>`;
}

function getClassList() {
    return CLASSES[session.schoolType || 'Primary'] || CLASSES['Primary'];
}

// ── 4. DATA LOADING — GLOBAL QUERY ────────────────────────────────────────
async function loadStudents() {
    tbody.innerHTML = `<tr><td colspan="6" class="px-6 py-16 text-center text-slate-400 font-semibold">
        <i class="fa-solid fa-spinner fa-spin text-emerald-400 text-2xl mb-3 block"></i>Loading students...
    </td></tr>`;

    try {
        // Pull from global /students where currentSchoolId matches this school
        const [sSnap, tSnap] = await Promise.all([
            getDocs(query(collection(db, 'students'), where('currentSchoolId', '==', session.schoolId))),
            getDocs(query(collection(db, 'teachers'), where('currentSchoolId', '==', session.schoolId)))
        ]);

        // Build teacher name map
        const teacherMap = {};
        allTeachersCache = [];
        tSnap.forEach(d => {
            teacherMap[d.id] = d.data().name;
            allTeachersCache.push({ id: d.id, ...d.data() });
        });

        allStudentsCache = sSnap.docs.map(d => ({
            id: d.id,
            ...d.data(),
            teacherName: teacherMap[d.data().teacherId] || '—'
        }));

        // Populate teacher filter
        if (filterTeacherSelect.options.length <= 1) {
            filterTeacherSelect.innerHTML = '<option value="">All Teachers</option>' +
                allTeachersCache.map(t => `<option value="${t.id}">${escHtml(t.name)}</option>`).join('');
        }

        // Populate class filter
        if (filterClassSelect.options.length <= 2) {
            filterClassSelect.innerHTML =
                '<option value="">All Classes</option><option value="unassigned">Unassigned Only</option>' +
                getClassList().map(c => `<option value="${c}">${c}</option>`).join('');
        }

        renderTable();
    } catch (e) {
        console.error('[Students] loadStudents:', e);
        tbody.innerHTML = `<tr><td colspan="6" class="px-6 py-16 text-center text-red-500 font-bold">
            Failed to load student data. Check console for details.
        </td></tr>`;
    }
}

// ── 5. RENDER TABLE ────────────────────────────────────────────────────────
function renderTable() {
    let filtered = [...allStudentsCache];

    const term       = (document.getElementById('searchInput')?.value || '').toLowerCase();
    const filterT    = filterTeacherSelect.value;
    const filterC    = filterClassSelect.value;
    const filterStat = filterStatusSelect.value;

    if (filterT)                filtered = filtered.filter(s => s.teacherId === filterT);
    if (filterC === 'unassigned') filtered = filtered.filter(s => !s.className || !s.teacherId);
    else if (filterC)           filtered = filtered.filter(s => s.className === filterC);
    if (filterStat)             filtered = filtered.filter(s => (s.enrollmentStatus || 'Active') === filterStat);
    if (term)                   filtered = filtered.filter(s => (s.name || '').toLowerCase().includes(term));

    if (!filtered.length) {
        tbody.innerHTML = `<tr><td colspan="6" class="px-6 py-16 text-center text-slate-400 italic font-semibold">
            No students match the selected criteria.
        </td></tr>`;
        return;
    }

    tbody.innerHTML = filtered.map(s => {
        const status     = s.enrollmentStatus || 'Active';
        const isActive   = status === 'Active';
        const classBadge = s.className
            ? s.className
            : '<span class="bg-amber-100 text-amber-700 text-[10px] font-black px-2 py-0.5 rounded-md uppercase tracking-wider">Unassigned</span>';
        const teacherBadge = s.teacherName !== '—'
            ? escHtml(s.teacherName)
            : '<span class="bg-amber-100 text-amber-700 text-[10px] font-black px-2 py-0.5 rounded-md uppercase tracking-wider">Unassigned</span>';

        return `
        <tr class="border-b border-slate-100 hover:bg-slate-50 transition">
            <td class="px-6 py-4">
                <div class="flex items-center gap-3">
                    <div class="h-10 w-10 bg-gradient-to-br from-emerald-400 to-teal-500 text-white rounded-xl flex items-center justify-center font-black text-sm shadow-sm flex-shrink-0">
                        ${(s.name || '?').charAt(0).toUpperCase()}
                    </div>
                    <div>
                        <p class="font-black text-slate-700 leading-tight">${escHtml(s.name || 'Unnamed')}</p>
                        <p class="text-[10px] font-mono font-bold text-emerald-600 uppercase tracking-tight">${s.id}</p>
                    </div>
                </div>
            </td>
            <td class="px-6 py-4">${statusBadge(status)}</td>
            <td class="px-6 py-4 text-slate-600 font-semibold text-sm">${classBadge}</td>
            <td class="px-6 py-4 text-slate-600 font-semibold text-sm">${teacherBadge}</td>
            <td class="px-6 py-4 text-slate-600 font-semibold text-sm">${escHtml(s.parentPhone) || '—'}</td>
            <td class="px-6 py-4 text-right">
                <div class="flex items-center justify-end gap-2">
                    ${isActive ? `
                    <button onclick="window.openReassignModal('${s.id}')"
                        class="bg-blue-50 hover:bg-blue-600 hover:text-white text-blue-700 font-black px-3 py-1.5 rounded-lg text-xs transition border border-blue-200">
                        Reassign
                    </button>
                    <button onclick="window.openTransferModal('${s.id}')"
                        class="bg-amber-50 hover:bg-amber-500 hover:text-white text-amber-600 font-black px-3 py-1.5 rounded-lg text-xs transition border border-amber-200">
                        Close Enrollment
                    </button>` : ''}
                    <button onclick="window.openStudentPanel('${s.id}')"
                        class="bg-emerald-50 hover:bg-emerald-600 hover:text-white text-emerald-700 font-black px-3 py-1.5 rounded-lg text-xs transition border border-emerald-200">
                        Records
                    </button>
                </div>
            </td>
        </tr>`;
    }).join('');
}

// ── 6. FILTER / SEARCH LISTENERS ──────────────────────────────────────────
filterClassSelect.addEventListener('change', renderTable);
filterTeacherSelect.addEventListener('change', renderTable);
filterStatusSelect.addEventListener('change', renderTable);
document.getElementById('searchInput')?.addEventListener('input', renderTable);

// ── 7. ADD / CLAIM STUDENT MODAL ──────────────────────────────────────────
window.openAddStudentModal = () => {
    // Reset form fields
    ['sGlobalId','sName','sDob','sParentName','sParentPhone'].forEach(id => {
        const el = document.getElementById(id);
        if (el) el.value = '';
    });
    document.getElementById('claimPreview').classList.add('hidden');
    document.getElementById('claimError').classList.add('hidden');
    document.getElementById('addStudentMsg').classList.add('hidden');
    document.getElementById('saveStudentBtn').textContent = 'Enroll into National Registry';
    claimedStudentDoc = null;

    // Populate class and teacher dropdowns
    const sClass = document.getElementById('sClass');
    sClass.innerHTML = '<option value="">-- Select Class --</option>' +
        getClassList().map(c => `<option value="${c}">${c}</option>`).join('');

    const sTeacher = document.getElementById('sTeacher');
    sTeacher.innerHTML = '<option value="">-- Assign Later --</option>' +
        allTeachersCache.map(t => `<option value="${t.id}">${escHtml(t.name)}</option>`).join('');

    openOverlay('addStudentModal', 'addStudentModalInner');
};

window.closeAddStudentModal = () => {
    closeOverlay('addStudentModal', 'addStudentModalInner');
    claimedStudentDoc = null;
};

// ── CLAIM LOOKUP ──
document.getElementById('lookupStudentBtn').addEventListener('click', async () => {
    const rawId = document.getElementById('sGlobalId').value.trim().toUpperCase();
    const preview = document.getElementById('claimPreview');
    const error   = document.getElementById('claimError');
    preview.classList.add('hidden');
    error.classList.add('hidden');
    claimedStudentDoc = null;

    if (!rawId) { alert('Enter a Student Global ID first.'); return; }

    const btn = document.getElementById('lookupStudentBtn');
    btn.textContent = '...';
    btn.disabled = true;

    try {
        const snap = await getDoc(doc(db, 'students', rawId));
        if (!snap.exists()) {
            error.classList.remove('hidden');
        } else {
            claimedStudentDoc = { id: snap.id, ...snap.data() };
            const d = claimedStudentDoc;
            document.getElementById('claimPreviewName').textContent  = d.name || 'Unknown';
            document.getElementById('claimPreviewDob').textContent   = d.dob ? `DOB: ${d.dob}` : '';
            document.getElementById('claimPreviewSchool').textContent = d.currentSchoolId
                ? `Currently enrolled at: ${d.currentSchoolId}` : 'Not currently enrolled anywhere';
            preview.classList.remove('hidden');
            document.getElementById('saveStudentBtn').textContent = `Claim ${d.name} into This School`;
        }
    } catch (e) {
        console.error('[Students] lookup:', e);
        alert('Lookup failed. Try again.');
    }

    btn.textContent = 'Look Up';
    btn.disabled = false;
});

// ── SAVE (CLAIM or CREATE) ──
document.getElementById('saveStudentBtn').addEventListener('click', async () => {
    const btn = document.getElementById('saveStudentBtn');
    btn.disabled = true;
    btn.innerHTML = `<i class="fa-solid fa-spinner fa-spin mr-2"></i>Processing...`;

    try {
        if (claimedStudentDoc) {
            // ── CLAIM WORKFLOW ────────────────────────────────────────────
            await updateDoc(doc(db, 'students', claimedStudentDoc.id), {
                currentSchoolId:  session.schoolId,
                enrollmentStatus: 'Active',
                // className and teacherId can be set via Reassign after claiming
            });
        } else {
            // ── CREATE WORKFLOW ───────────────────────────────────────────
            const name        = document.getElementById('sName').value.trim();
            const dob         = document.getElementById('sDob').value;
            const parentName  = document.getElementById('sParentName').value.trim();
            const parentPhone = document.getElementById('sParentPhone').value.trim();
            const className   = document.getElementById('sClass').value;
            const teacherId   = document.getElementById('sTeacher').value;

            if (!name || !dob) {
                alert('Student name and date of birth are required.');
                btn.disabled = false;
                btn.textContent = 'Enroll into National Registry';
                return;
            }

            const newId = generateStudentId();
            await setDoc(doc(db, 'students', newId), {
                studentIdNum:     newId,         // = document ID (redundant but useful for reads)
                name,
                dob,
                pin:              generatePin(),
                parentName,
                parentPhone,
                className:        className || '',
                teacherId:        teacherId || '',
                currentSchoolId:  session.schoolId,
                enrollmentStatus: 'Active',
                medicalNotes:     '',
                academicHistory:  [],
                createdAt:        new Date().toISOString()
            });
        }

        window.closeAddStudentModal();
        loadStudents();
    } catch (e) {
        console.error('[Students] save:', e);
        alert('Action failed. Check console.');
    }

    btn.disabled = false;
    btn.textContent = 'Enroll into National Registry';
});

// ── 8. TRANSFER / CLOSE ENROLLMENT MODAL ──────────────────────────────────
window.openTransferModal = (id) => {
    currentStudentId = id;
    const s = allStudentsCache.find(x => x.id === id);

    document.getElementById('transferStudentName').textContent = s?.name || 'this student';
    document.getElementById('tSnapSchool').textContent         = session.schoolName || session.schoolId;
    document.getElementById('tSnapClass').textContent          = s?.className || 'Unassigned';
    document.getElementById('tSnapDate').textContent           = new Date().toLocaleDateString('en-BZ', { year:'numeric', month:'long', day:'numeric' });

    document.getElementById('transferReason').value  = '';
    document.getElementById('transferGpa').value     = '';
    document.getElementById('transferNotes').value   = '';

    openOverlay('transferModal', 'transferModalInner');
};

window.closeTransferModal = () => closeOverlay('transferModal', 'transferModalInner');

document.getElementById('confirmTransferBtn').addEventListener('click', async () => {
    const reason = document.getElementById('transferReason').value;
    const gpa    = document.getElementById('transferGpa').value;
    const notes  = document.getElementById('transferNotes').value.trim();

    if (!reason) { alert('Please select a departure reason.'); return; }

    const btn = document.getElementById('confirmTransferBtn');
    btn.disabled = true;
    btn.innerHTML = `<i class="fa-solid fa-spinner fa-spin mr-2"></i>Sealing Record...`;

    try {
        const s      = allStudentsCache.find(x => x.id === currentStudentId);
        const sRef   = doc(db, 'students', currentStudentId);
        const batch  = writeBatch(db);

        // ── Snapshot entry for academicHistory ───────────────────────────
        const snapshot = {
            schoolId:   session.schoolId,
            schoolName: session.schoolName || session.schoolId,
            teacherId:  s?.teacherId || '',
            className:  s?.className || '',
            leftAt:     new Date().toISOString(),
            reason,
            ...(gpa  ? { gpa: parseFloat(gpa) }  : {}),
            ...(notes ? { notes }                 : {})
        };

        // Command 1: Update student global doc
        // - Transferred: clear currentSchoolId so another school can claim them
        // - Graduated / Archived / Expelled / Dropped Out: keep school ref, update status
        const isTransfer  = reason === 'Transferred';
        const newStatus   = reason === 'Graduated' ? 'Graduated' : isTransfer ? 'Transferred' : 'Archived';

        batch.update(sRef, {
            enrollmentStatus: newStatus,
            currentSchoolId:  isTransfer ? '' : session.schoolId,
            teacherId:        '',
            className:        '',
            academicHistory:  arrayUnion(snapshot)
        });

        // Command 2: Write notification so old-school logic can be tracked
        // (Future: notify new school dashboard in real time)
        const notifRef = doc(collection(db, 'schools', session.schoolId, 'notifications'));
        batch.set(notifRef, {
            type:       'student_enrollment_closed',
            studentId:  currentStudentId,
            studentName: s?.name || '',
            reason,
            closedBy:   session.adminId || 'System',
            closedAt:   new Date().toISOString()
        });

        await batch.commit();

        window.closeTransferModal();
        loadStudents();
    } catch (e) {
        console.error('[Students] transfer:', e);
        alert('Critical failure. Record preserved.');
    }

    btn.disabled = false;
    btn.innerHTML = `<i class="fa-solid fa-lock mr-2"></i>Seal Snapshot & Close Enrollment`;
});

// ── 9. REASSIGN MODAL ─────────────────────────────────────────────────────
window.openReassignModal = (id) => {
    currentStudentId = id;
    const s = allStudentsCache.find(x => x.id === id);

    document.getElementById('rsName').value = s?.name || '';
    document.getElementById('reassignMsg').classList.add('hidden');

    const cSelect = document.getElementById('rsClass');
    cSelect.innerHTML = '<option value="">-- Unassigned --</option>' +
        getClassList().map(c => `<option value="${c}" ${s?.className === c ? 'selected' : ''}>${c}</option>`).join('');

    const tSelect = document.getElementById('rsTeacher');
    tSelect.innerHTML = '<option value="">-- Unassigned --</option>' +
        allTeachersCache.map(t => `<option value="${t.id}" ${s?.teacherId === t.id ? 'selected' : ''}>${escHtml(t.name)}</option>`).join('');

    openOverlay('reassignStudentModal', 'reassignStudentModalInner');
};

window.closeReassignModal = () => closeOverlay('reassignStudentModal', 'reassignStudentModalInner');

document.getElementById('saveReassignBtn').addEventListener('click', async () => {
    const btn = document.getElementById('saveReassignBtn');
    btn.innerHTML = `<i class="fa-solid fa-spinner fa-spin"></i> Saving...`;
    btn.disabled = true;

    try {
        await updateDoc(doc(db, 'students', currentStudentId), {
            name:      document.getElementById('rsName').value.trim(),
            className: document.getElementById('rsClass').value,
            teacherId: document.getElementById('rsTeacher').value
        });
        window.closeReassignModal();
        loadStudents();
    } catch (e) {
        showMsg('reassignMsg', 'Error updating student record.', true);
        console.error('[Students] reassign:', e);
    }

    btn.innerHTML = 'Save Changes';
    btn.disabled  = false;
});

// ── 10. STUDENT RECORDS PANEL ─────────────────────────────────────────────
window.openStudentPanel = async (studentId) => {
    currentStudentId = studentId;
    const student = allStudentsCache.find(s => s.id === studentId);

    document.getElementById('sPanelName').textContent  = student?.name    || 'Student';
    document.getElementById('sPanelId').textContent    = studentId;
    document.getElementById('sPanelClass').textContent = student?.className || '—';

    const printBtn = document.getElementById('sPanelPrintBtn');
    if (printBtn) printBtn.onclick = () => window.printStudentRecord(studentId);

    // Academic history timeline
    const history = student?.academicHistory || [];
    const histBar = document.getElementById('academicHistoryBar');
    const histList = document.getElementById('academicHistoryList');
    if (history.length) {
        histList.innerHTML = history.map(h => `
            <div class="flex items-center gap-3 text-xs">
                <span class="w-2 h-2 rounded-full bg-blue-400 flex-shrink-0"></span>
                <span class="font-bold text-blue-800">${escHtml(h.schoolName || h.schoolId)}</span>
                <span class="text-blue-400">·</span>
                <span class="text-blue-600">${escHtml(h.className || '—')}</span>
                <span class="text-blue-400">·</span>
                <span class="text-blue-500">${h.leftAt ? new Date(h.leftAt).toLocaleDateString() : '—'}</span>
                <span class="ml-auto font-black text-blue-700">${escHtml(h.reason || '')}</span>
            </div>`).join('');
        histBar.classList.remove('hidden');
    } else {
        histBar.classList.add('hidden');
    }

    // Reset panel state
    const loader = document.getElementById('sPanelLoader');
    const accordions = document.getElementById('subjectAccordions');
    loader.innerHTML = `<i class="fa-solid fa-circle-notch fa-spin text-4xl mb-3 text-emerald-500"></i><p class="font-semibold text-sm">Loading academic records...</p>`;
    loader.classList.remove('hidden');
    accordions.classList.add('hidden');
    accordions.innerHTML = '';

    openOverlay('studentPanel', 'studentPanelInner', true);

    try {
        // Grades live at /students/{studentId}/grades (global path)
        const gradesSnap = await getDocs(collection(db, 'students', studentId, 'grades'));

        if (gradesSnap.empty) {
            loader.innerHTML = `<div class="text-center py-16"><div class="text-5xl mb-3">📂</div><p class="text-slate-400 font-semibold">No grades recorded yet.</p></div>`;
            return;
        }

        // Group by subject
        const bySubject = {};
        gradesSnap.forEach(d => {
            const g    = { id: d.id, ...d.data() };
            const subj = g.subject || 'Uncategorized';
            if (!bySubject[subj]) bySubject[subj] = [];
            bySubject[subj].push(g);
        });

        accordions.innerHTML = Object.entries(bySubject).map(([subject, grades]) => {
            const avg  = grades.reduce((a, g) => a + (g.max ? g.score / g.max * 100 : 0), 0) / grades.length;
            const ac   = avg >= 75 ? 'text-green-600' : avg >= 60 ? 'text-amber-600' : 'text-red-600';
            const ab   = avg >= 75 ? 'bg-green-50 border-green-200' : avg >= 60 ? 'bg-amber-50 border-amber-200' : 'bg-red-50 border-red-200';

            const rows = grades.map(g => {
                const pct = g.max ? Math.round(g.score / g.max * 100) : null;
                const c   = pct == null ? 'text-slate-600' : pct >= 75 ? 'text-green-600' : pct >= 60 ? 'text-amber-600' : 'text-red-600';
                return `<div class="border border-slate-200 rounded-xl bg-white hover:shadow-sm transition">
                    <div class="px-4 py-3 flex items-center justify-between">
                        <div class="flex-1 min-w-0">
                            <p class="font-bold text-slate-700 text-sm truncate">${escHtml(g.title || 'Assessment')}</p>
                            <p class="text-xs text-slate-400 font-semibold mt-0.5">${escHtml(g.type || '')} ${g.date ? '· ' + g.date : ''}</p>
                        </div>
                        <div class="flex items-center gap-3 flex-shrink-0 ml-3">
                            <span class="${c} font-black text-sm">${g.score}/${g.max || '?'}</span>
                            <button onclick="window.openAssignmentModal(${JSON.stringify(g).replace(/"/g,'&quot;')})"
                                class="text-xs font-black text-blue-600 hover:bg-blue-600 hover:text-white border border-blue-200 px-3 py-1 rounded-lg transition">
                                Detail
                            </button>
                        </div>
                    </div>
                </div>`;
            }).join('');

            return `<div class="rounded-2xl border border-slate-200 overflow-hidden shadow-sm">
                <div class="subject-header flex items-center justify-between px-5 py-4 bg-white cursor-pointer hover:bg-slate-50 transition"
                    onclick="window.toggleSubjectAccordion(this)">
                    <div class="flex items-center gap-3">
                        <div class="w-9 h-9 bg-gradient-to-br from-blue-500 to-blue-600 text-white rounded-xl flex items-center justify-center font-black text-xs shadow-sm">
                            ${subject.charAt(0).toUpperCase()}
                        </div>
                        <div>
                            <p class="font-black text-slate-800">${escHtml(subject)}</p>
                            <p class="text-xs text-slate-400 font-semibold">${grades.length} assessment${grades.length !== 1 ? 's' : ''}</p>
                        </div>
                    </div>
                    <div class="flex items-center gap-3">
                        <span class="badge ${ab} ${ac} border font-black">${avg.toFixed(0)}% avg</span>
                        <i class="fa-solid fa-chevron-down text-slate-400" style="transition:transform 0.2s"></i>
                    </div>
                </div>
                <div class="subject-body">
                    <div class="px-4 pb-4 pt-2 bg-slate-50/70 space-y-2">${rows}</div>
                </div>
            </div>`;
        }).join('');

        loader.classList.add('hidden');
        accordions.classList.remove('hidden');

    } catch (e) {
        console.error('[Students] openStudentPanel:', e);
        loader.innerHTML = `<p class="text-red-500 font-bold text-center py-10">Error loading records.</p>`;
    }
};

window.toggleSubjectAccordion = (h) => {
    const b = h.nextElementSibling;
    b.classList.toggle('open');
    h.querySelector('.fa-chevron-down').style.transform = b.classList.contains('open') ? 'rotate(180deg)' : 'rotate(0deg)';
};

window.closeStudentPanel = () => {
    closeOverlay('studentPanel', 'studentPanelInner', true);
    document.getElementById('sPanelLoader').innerHTML =
        `<i class="fa-solid fa-circle-notch fa-spin text-4xl mb-3 text-emerald-500"></i><p class="font-semibold text-sm">Loading academic records...</p>`;
};

// ── 11. ASSIGNMENT DETAIL MODAL ───────────────────────────────────────────
window.openAssignmentModal = (g) => {
    const pct  = g.max ? Math.round(g.score / g.max * 100) : null;
    const c    = pct == null ? 'text-slate-600' : pct >= 75 ? 'text-green-600' : pct >= 60 ? 'text-amber-600' : 'text-red-600';
    const fill = pct == null ? '#94a3b8'        : pct >= 75 ? '#22c55e'        : pct >= 60 ? '#f59e0b'        : '#ef4444';
    const logs = (g.historyLogs || []).map(l =>
        typeof l === 'object'
            ? `[${l.changedAt}] ${l.oldScore}/${l.oldMax} → ${l.newScore}/${l.newMax}. Reason: ${l.reason}`
            : l
    );

    document.getElementById('aModalTitle').textContent = g.title || 'Assessment';
    document.getElementById('aModalBody').innerHTML = `
        <div class="text-center mb-6">
            <div class="${c} text-5xl font-black">${g.score}<span class="text-2xl text-slate-400">/${g.max || '?'}</span></div>
            ${pct !== null ? `<div class="${c} text-lg font-black mt-1">${pct}% · ${letterGrade(pct)}</div>` : ''}
            <div class="mt-3 h-3 bg-slate-100 rounded-full overflow-hidden">
                <div class="h-full rounded-full" style="width:${pct || 0}%;background:${fill};transition:width 0.6s ease"></div>
            </div>
        </div>
        <div class="space-y-2 text-sm mb-4">
            ${[['Subject', g.subject || '—'],['Type', g.type || '—'],['Date', g.date || '—']].map(([l, v]) =>
                `<div class="flex justify-between py-2 border-b border-slate-100">
                    <span class="text-slate-400 font-bold uppercase text-xs tracking-wider">${l}</span>
                    <span class="font-black text-slate-700">${escHtml(v)}</span>
                </div>`
            ).join('')}
        </div>
        ${g.notes ? `<div class="mt-4 bg-blue-50 border border-blue-100 rounded-xl p-4">
            <p class="text-xs font-black text-blue-500 uppercase tracking-wider mb-1">Teacher Notes</p>
            <p class="text-sm text-slate-700 font-semibold italic">${escHtml(g.notes)}</p>
        </div>` : ''}
        ${logs.length ? `<div class="mt-4 bg-amber-50 border border-amber-200 rounded-xl p-4">
            <p class="text-xs font-black text-amber-600 uppercase tracking-wider mb-2">
                <i class="fa-solid fa-clock-rotate-left mr-1"></i>Edit History (${logs.length})
            </p>
            <div class="space-y-1 max-h-32 overflow-y-auto">
                ${logs.map(l => `<p class="text-xs text-amber-800 font-semibold bg-white rounded-lg p-2 border border-amber-100">• ${escHtml(l)}</p>`).join('')}
            </div>
        </div>` : ''}`;

    openOverlay('assignmentModal', 'assignmentModalInner');
};

window.closeAssignmentModal = () => closeOverlay('assignmentModal', 'assignmentModalInner');

// ── 12. PRINT STUDENT RECORD ──────────────────────────────────────────────
window.printStudentRecord = async (studentId) => {
    const sDoc = await getDoc(doc(db, 'students', studentId));
    if (!sDoc.exists()) { alert('Student not found.'); return; }
    const s = sDoc.data();

    const gradesSnap = await getDocs(collection(db, 'students', studentId, 'grades'));
    const bySem = {};
    gradesSnap.forEach(d => {
        const g   = d.data();
        const sem = g.semesterId || 'General';
        const sub = g.subject    || 'Uncategorized';
        if (!bySem[sem]) bySem[sem] = {};
        if (!bySem[sem][sub]) bySem[sem][sub] = [];
        bySem[sem][sub].push(g);
    });

    const history = (s.academicHistory || []);
    const historyHtml = history.length ? `
        <div style="margin-bottom:30px;">
            <h3 style="font-size:13px;font-weight:bold;background:#334155;color:white;padding:8px 15px;border-radius:4px;margin-bottom:10px;">ACADEMIC HISTORY</h3>
            <table style="width:100%;border-collapse:collapse;font-size:12px;">
                <thead><tr style="background:#f1f5f9;">
                    <th style="border:1px solid #e2e8f0;padding:8px 12px;text-align:left;">School</th>
                    <th style="border:1px solid #e2e8f0;padding:8px 12px;text-align:left;">Class</th>
                    <th style="border:1px solid #e2e8f0;padding:8px 12px;text-align:left;">Left On</th>
                    <th style="border:1px solid #e2e8f0;padding:8px 12px;text-align:left;">Reason</th>
                    <th style="border:1px solid #e2e8f0;padding:8px 12px;text-align:center;">GPA</th>
                </tr></thead>
                <tbody>${history.map(h => `<tr>
                    <td style="border:1px solid #e2e8f0;padding:8px 12px;">${h.schoolName || h.schoolId}</td>
                    <td style="border:1px solid #e2e8f0;padding:8px 12px;">${h.className || '—'}</td>
                    <td style="border:1px solid #e2e8f0;padding:8px 12px;">${h.leftAt ? new Date(h.leftAt).toLocaleDateString() : '—'}</td>
                    <td style="border:1px solid #e2e8f0;padding:8px 12px;">${h.reason || '—'}</td>
                    <td style="border:1px solid #e2e8f0;padding:8px 12px;text-align:center;">${h.gpa || '—'}</td>
                </tr>`).join('')}</tbody>
            </table>
        </div>` : '';

    let gradesHtml = '';
    if (Object.keys(bySem).length === 0) {
        gradesHtml = `<p style="text-align:center;color:#64748b;font-style:italic;padding:40px;">No academic grades recorded.</p>`;
    } else {
        for (const sem in bySem) {
            gradesHtml += `<div style="margin-bottom:40px;page-break-inside:avoid;">
                <h3 style="font-size:13px;font-weight:bold;background:#334155;color:white;padding:8px 15px;border-radius:4px;margin-bottom:10px;">Period: ${sem}</h3>
                <table style="width:100%;border-collapse:collapse;font-size:13px;">
                    <thead><tr style="background:#f1f5f9;">
                        <th style="border:1px solid #e2e8f0;padding:10px 15px;text-align:left;">Subject</th>
                        <th style="border:1px solid #e2e8f0;padding:10px 15px;text-align:center;">Assessments</th>
                        <th style="border:1px solid #e2e8f0;padding:10px 15px;text-align:center;">Average</th>
                        <th style="border:1px solid #e2e8f0;padding:10px 15px;text-align:center;">Grade</th>
                    </tr></thead>
                    <tbody>`;
            let semTotal = 0, semCount = 0;
            for (const sub in bySem[sem]) {
                const sGrades = bySem[sem][sub];
                const avg = Math.round(sGrades.reduce((a, g) => a + (g.max ? g.score / g.max * 100 : 0), 0) / sGrades.length);
                semTotal += avg; semCount++;
                gradesHtml += `<tr>
                    <td style="border:1px solid #e2e8f0;padding:10px 15px;">${sub}</td>
                    <td style="border:1px solid #e2e8f0;padding:10px 15px;text-align:center;">${sGrades.length}</td>
                    <td style="border:1px solid #e2e8f0;padding:10px 15px;text-align:center;">${avg}%</td>
                    <td style="border:1px solid #e2e8f0;padding:10px 15px;text-align:center;">${letterGrade(avg)}</td>
                </tr>`;
            }
            const semAvg = Math.round(semTotal / semCount);
            gradesHtml += `<tr style="background:#f8fafc;font-weight:bold;">
                <td colspan="2" style="border:1px solid #e2e8f0;padding:10px 15px;text-align:right;">PERIOD AVERAGE:</td>
                <td style="border:1px solid #e2e8f0;padding:10px 15px;text-align:center;">${semAvg}%</td>
                <td style="border:1px solid #e2e8f0;padding:10px 15px;text-align:center;">${letterGrade(semAvg)}</td>
            </tr></tbody></table></div>`;
        }
    }

    const html = `<html><head><title>Academic Record — ${s.name}</title>
    <style>
        body { font-family:'Helvetica Neue',Helvetica,Arial,sans-serif; padding:40px; color:#1e293b; line-height:1.5; }
        .header { text-align:center; border-bottom:2px solid #cbd5e1; padding-bottom:20px; margin-bottom:30px; }
        .header h1 { margin:0 0 4px 0; font-size:22px; color:#0f172a; text-transform:uppercase; letter-spacing:1px; }
        .header h2 { margin:0; font-size:13px; color:#64748b; font-weight:normal; letter-spacing:2px; }
        .info-grid { display:grid; grid-template-columns:1fr 1fr; gap:12px; margin-bottom:30px; background:#f8fafc; padding:18px; border-radius:8px; border:1px solid #e2e8f0; }
        .info-item label { display:block; font-size:10px; text-transform:uppercase; color:#64748b; font-weight:bold; letter-spacing:1px; }
        .info-item span { font-size:13px; font-weight:bold; color:#0f172a; }
        .footer { margin-top:50px; text-align:center; font-size:10px; color:#94a3b8; border-top:1px solid #e2e8f0; padding-top:15px; }
    </style></head><body>
    <div class="header">
        <h1>${session.schoolName || 'ConnectUs School'}</h1>
        <h2>OFFICIAL ACADEMIC PASSPORT — NATIONAL STUDENT RECORD</h2>
    </div>
    <div class="info-grid">
        <div class="info-item"><label>Student Name</label><span>${s.name}</span></div>
        <div class="info-item"><label>Global ID</label><span>${s.studentIdNum || studentId}</span></div>
        <div class="info-item"><label>Date of Birth</label><span>${s.dob || 'N/A'}</span></div>
        <div class="info-item"><label>Enrollment Status</label><span>${s.enrollmentStatus || 'Active'}</span></div>
        <div class="info-item"><label>Current Class</label><span>${s.className || 'Unassigned'}</span></div>
        <div class="info-item"><label>Parent / Guardian</label><span>${s.parentName || 'N/A'}</span></div>
    </div>
    ${historyHtml}
    ${gradesHtml}
    <div class="footer">Printed ${new Date().toLocaleDateString()} via ConnectUs National Registry<br>Issued by: ${session.schoolName || session.schoolId}</div>
    </body></html>`;

    const w = window.open('', '_blank');
    w.document.write(html);
    w.document.close();
    setTimeout(() => w.print(), 500);
};

// ── 13. CSV & PRINT LIST EXPORTS ──────────────────────────────────────────
document.getElementById('exportCsvBtn').addEventListener('click', () => {
    const rows = [
        ['Global ID', 'Name', 'Status', 'Class', 'Teacher', 'Parent Phone', 'DOB'],
        ...allStudentsCache.map(s => [
            s.id, s.name || '', s.enrollmentStatus || 'Active',
            s.className || '', s.teacherName || '',
            s.parentPhone || '', s.dob || ''
        ])
    ];
    const csv = rows.map(r => r.map(v => `"${String(v ?? '').replace(/"/g, '""')}"`).join(',')).join('\n');
    const a = Object.assign(document.createElement('a'), {
        href:     URL.createObjectURL(new Blob([csv], { type: 'text/csv' })),
        download: `${session.schoolId}_students_${new Date().toISOString().slice(0,10)}.csv`
    });
    document.body.appendChild(a);
    a.click();
    a.remove();
});

document.getElementById('printListBtn').addEventListener('click', () => {
    const w = window.open('', '_blank');
    w.document.write(`<html><head><title>Student Directory</title>
    <style>body{font-family:sans-serif;padding:20px}table{border-collapse:collapse;width:100%}th,td{border:1px solid #e2e8f0;padding:8px 12px;font-size:12px;text-align:left}th{background:#f8fafc;font-weight:700}</style>
    </head><body>
    <h2>${session.schoolName || 'School'} — Student Directory</h2>
    <p style="color:#64748b;font-size:11px;margin-bottom:14px">Printed ${new Date().toLocaleDateString()}</p>
    <table><thead><tr><th>Global ID</th><th>Name</th><th>Status</th><th>Class</th><th>Teacher</th><th>Parent Phone</th></tr></thead>
    <tbody>${allStudentsCache.map(s => `<tr>
        <td style="font-family:monospace">${s.id}</td>
        <td>${s.name || ''}</td>
        <td>${s.enrollmentStatus || 'Active'}</td>
        <td>${s.className || ''}</td>
        <td>${s.teacherName || ''}</td>
        <td>${s.parentPhone || '—'}</td>
    </tr>`).join('')}</tbody></table>
    </body></html>`);
    w.document.close();
    w.print();
});

// ── BOOT ──────────────────────────────────────────────────────────────────
loadStudents();
