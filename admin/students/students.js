import { db } from '../../assets/js/firebase-init.js';
import {
    collection, query, where,
    getDocs, getDoc, doc,
    setDoc, updateDoc, writeBatch,
    arrayUnion
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
let currentStudentId  = null;
let claimedStudentDoc = null;

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
    const chars = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
    let rand = '';
    for (let i = 0; i < 5; i++) rand += chars.charAt(Math.floor(Math.random() * chars.length));
    return `S${year}-${rand}`;
}

function generatePin() { return Math.floor(1000 + Math.random() * 9000).toString(); }

function escHtml(str) {
    if (!str) return '';
    return String(str).replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/"/g,'&quot;');
}

function statusBadge(status) {
    const map = { Active:'status-active', Transferred:'status-transferred', Graduated:'status-graduated', Archived:'status-archived' };
    return `<span class="text-[10px] font-black px-2 py-0.5 rounded-md uppercase tracking-wider ${map[status] || 'status-archived'}">${status || 'Unknown'}</span>`;
}

function getClassList() {
    return CLASSES[session.schoolType || 'Primary'] || CLASSES['Primary'];
}

// ── Check student limit ────────────────────────────────────────────────────
async function isStudentLimitReached() {
    const studentLimit = session.studentLimit || 50;
    const snap = await getDocs(
        query(collection(db, 'students'),
              where('currentSchoolId', '==', session.schoolId),
              where('enrollmentStatus', '==', 'Active'))
    );
    return { reached: snap.size >= studentLimit, current: snap.size, limit: studentLimit };
}

// ── 4. LOAD STUDENTS ────────────────────────────────────────────────────────
async function loadStudents() {
    tbody.innerHTML = `<tr><td colspan="6" class="px-6 py-16 text-center text-slate-400 font-semibold">
        <i class="fa-solid fa-spinner fa-spin text-emerald-400 text-2xl mb-3 block"></i>Loading students...
    </td></tr>`;

    try {
        const [sSnap, tSnap] = await Promise.all([
            getDocs(query(collection(db, 'students'), where('currentSchoolId', '==', session.schoolId))),
            getDocs(query(collection(db, 'teachers'), where('currentSchoolId', '==', session.schoolId)))
        ]);

        const teacherMap = {};
        allTeachersCache = [];
        tSnap.forEach(d => {
            teacherMap[d.id] = d.data().name;
            allTeachersCache.push({ id: d.id, ...d.data() });
        });

        allStudentsCache = sSnap.docs.map(d => ({
            id: d.id, ...d.data(),
            teacherName: teacherMap[d.data().teacherId] || '—'
        }));

        if (filterTeacherSelect.options.length <= 1) {
            filterTeacherSelect.innerHTML = '<option value="">All Teachers</option>' +
                allTeachersCache.map(t => `<option value="${t.id}">${escHtml(t.name)}</option>`).join('');
        }
        if (filterClassSelect.options.length <= 2) {
            filterClassSelect.innerHTML =
                '<option value="">All Classes</option><option value="unassigned">Unassigned Only</option>' +
                getClassList().map(c => `<option value="${c}">${c}</option>`).join('');
        }

        renderTable();
    } catch (e) {
        console.error('[Students] loadStudents:', e);
        tbody.innerHTML = `<tr><td colspan="6" class="px-6 py-16 text-center text-red-500 font-bold">
            Failed to load student data.
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

    if (filterT)                  filtered = filtered.filter(s => s.teacherId === filterT);
    if (filterC === 'unassigned') filtered = filtered.filter(s => !s.className || !s.teacherId);
    else if (filterC)             filtered = filtered.filter(s => s.className === filterC);
    if (filterStat)               filtered = filtered.filter(s => (s.enrollmentStatus || 'Active') === filterStat);
    if (term)                     filtered = filtered.filter(s => (s.name || '').toLowerCase().includes(term));

    if (!filtered.length) {
        tbody.innerHTML = `<tr><td colspan="6" class="px-6 py-16 text-center text-slate-400 italic font-semibold">
            No students match the selected criteria.
        </td></tr>`;
        return;
    }

    tbody.innerHTML = filtered.map(s => {
        const status      = s.enrollmentStatus || 'Active';
        const isActive    = status === 'Active';
        const classBadge  = s.className
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
                <button onclick="window.openStudentPanel('${s.id}')"
                    class="bg-emerald-50 hover:bg-emerald-600 hover:text-white text-emerald-700 font-black px-4 py-2 rounded-lg text-xs transition border border-emerald-200 shadow-sm">
                    <i class="fa-solid fa-eye mr-1"></i> View
                </button>
            </td>
        </tr>`;
    }).join('');
}

filterClassSelect.addEventListener('change', renderTable);
filterTeacherSelect.addEventListener('change', renderTable);
filterStatusSelect.addEventListener('change', renderTable);
document.getElementById('searchInput')?.addEventListener('input', renderTable);

// ── 6. ADD / CLAIM STUDENT MODAL ──────────────────────────────────────────
window.openAddStudentModal = () => {
    ['sGlobalId','sName','sDob','sParentName','sParentPhone','sEmail'].forEach(id => {
        const el = document.getElementById(id); if (el) el.value = '';
    });
    document.getElementById('claimPreview').classList.add('hidden');
    document.getElementById('claimError').classList.add('hidden');
    document.getElementById('addStudentMsg').classList.add('hidden');
    document.getElementById('saveStudentBtn').textContent = 'Enroll into National Registry';
    claimedStudentDoc = null;

    const sClass = document.getElementById('sClass');
    sClass.innerHTML = '<option value="">-- Select Class First --</option>' +
        getClassList().map(c => `<option value="${c}">${c}</option>`).join('');

    const sTeacher = document.getElementById('sTeacher');
    sTeacher.innerHTML = '<option value="">-- Waiting for class selection --</option>';
    sTeacher.disabled = true;

    openOverlay('addStudentModal', 'addStudentModalInner');
};

document.getElementById('sClass').addEventListener('change', function() {
    const selectedClass = this.value;
    const teacherDropdown = document.getElementById('sTeacher');
    
    teacherDropdown.innerHTML = '';
    
    if (!selectedClass) {
        teacherDropdown.innerHTML = '<option value="">-- Waiting for class selection --</option>';
        teacherDropdown.disabled = true;
        return;
    }

    const matchingTeachers = allTeachersCache.filter(teacher => 
        teacher.classes && teacher.classes.includes(selectedClass)
    );

    if (matchingTeachers.length === 0) {
        teacherDropdown.innerHTML = '<option value="">Unassigned (No teacher teaches this class)</option>';
        teacherDropdown.disabled = false; 
    } 
    else if (matchingTeachers.length === 1) {
        const t = matchingTeachers[0];
        teacherDropdown.innerHTML = `<option value="${t.id}" selected>${t.name}</option>`;
        teacherDropdown.disabled = false;
    } 
    else {
        teacherDropdown.innerHTML = '<option value="">-- Select specific teacher --</option>';
        matchingTeachers.forEach(t => {
            teacherDropdown.innerHTML += `<option value="${t.id}">${t.name}</option>`;
        });
        teacherDropdown.disabled = false;
    }
});

window.closeAddStudentModal = () => {
    closeOverlay('addStudentModal', 'addStudentModalInner');
    claimedStudentDoc = null;
};

document.getElementById('lookupStudentBtn').addEventListener('click', async () => {
    const rawId   = document.getElementById('sGlobalId').value.trim().toUpperCase();
    const preview = document.getElementById('claimPreview');
    const error   = document.getElementById('claimError');
    preview.classList.add('hidden');
    error.classList.add('hidden');
    claimedStudentDoc = null;

    if (!rawId) { alert('Enter a Student Global ID first.'); return; }

    if (!/^S\d{2}-[A-Z0-9]{5}$/.test(rawId)) {
        error.querySelector('p').textContent = 'Invalid format. Student ID should look like S26-XXXXX.';
        error.classList.remove('hidden'); return;
    }

    const btn = document.getElementById('lookupStudentBtn');
    btn.textContent = '...';
    btn.disabled = true;

    try {
        const snap = await getDoc(doc(db, 'students', rawId));

        if (!snap.exists()) {
            error.querySelector('p').textContent = 'No student found with that ID. Check the credential slip and try again.';
            error.classList.remove('hidden');
        } else {
            const d = { id: snap.id, ...snap.data() };

            if (d.currentSchoolId && d.currentSchoolId !== '') {
                error.querySelector('p').textContent =
                    d.currentSchoolId === session.schoolId
                        ? 'This student is already enrolled at your school.'
                        : 'This student is currently enrolled at another school. Their current school must close enrollment first. Contact ConnectUs if you believe this is an error.';
                error.classList.remove('hidden');
            } else {
                claimedStudentDoc = d;
                document.getElementById('claimPreviewName').textContent  = d.name || 'Unknown';
                document.getElementById('claimPreviewDob').textContent   = d.dob ? `DOB: ${d.dob}` : 'DOB: Not on file';

                const lastSchool = d.academicHistory?.length
                    ? `Last school: ${d.academicHistory[d.academicHistory.length - 1].schoolName || d.academicHistory[d.academicHistory.length - 1].schoolId}`
                    : 'No prior enrollment history';
                const emailNote = !d.email
                    ? '<br><span style="color:#d97706;font-size:10.5px;font-weight:700;">⚠ No email on file — student must add one during first login setup.</span>'
                    : '<br><span style="color:#059669;font-size:10.5px;font-weight:600;">✓ Email on file</span>';
                document.getElementById('claimPreviewSchool').innerHTML = lastSchool + emailNote;

                preview.classList.remove('hidden');
                document.getElementById('saveStudentBtn').textContent = `Claim ${d.name} into This School`;
            }
        }
    } catch (e) {
        console.error('[Students] lookup:', e);
        alert('Lookup failed. Try again.');
    }

    btn.textContent = 'Look Up';
    btn.disabled = false;
});

document.getElementById('saveStudentBtn').addEventListener('click', async () => {
    const btn = document.getElementById('saveStudentBtn');
    btn.disabled = true;
    btn.innerHTML = `<i class="fa-solid fa-spinner fa-spin mr-2"></i>Processing...`;

    try {
        const limitCheck = await isStudentLimitReached();
        if (limitCheck.reached) {
            showMsg('addStudentMsg', `Student limit reached (${limitCheck.current} of ${limitCheck.limit}). Contact ConnectUs to upgrade your plan.`, true);
            btn.disabled = false;
            btn.textContent = claimedStudentDoc ? `Claim ${claimedStudentDoc.name} into This School` : 'Enroll into National Registry';
            return;
        }

        if (claimedStudentDoc) {
            await updateDoc(doc(db, 'students', claimedStudentDoc.id), {
                currentSchoolId:  session.schoolId,
                enrollmentStatus: 'Active'
            });
        } else {
            const name        = document.getElementById('sName').value.trim();
            const dob         = document.getElementById('sDob').value;
            const email       = document.getElementById('sEmail')?.value.trim() || '';
            const parentName  = document.getElementById('sParentName').value.trim();
            const parentPhone = document.getElementById('sParentPhone').value.trim();
            const className   = document.getElementById('sClass').value;
            const teacherId   = document.getElementById('sTeacher').value;

            if (!name || !dob) {
                showMsg('addStudentMsg', 'Student name and date of birth are required.', true);
                btn.disabled = false; btn.textContent = 'Enroll into National Registry'; return;
            }
            if (!email) {
                showMsg('addStudentMsg', 'Email address is required so the student can recover their PIN.', true);
                btn.disabled = false; btn.textContent = 'Enroll into National Registry'; return;
            }
            if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) {
                showMsg('addStudentMsg', 'Please enter a valid email address.', true);
                btn.disabled = false; btn.textContent = 'Enroll into National Registry'; return;
            }

            const newId = generateStudentId();
            await setDoc(doc(db, 'students', newId), {
                studentIdNum:        newId,
                name,
                dob,
                email,
                pin:                 generatePin(),
                parentName,
                parentPhone,
                className:           className || '',
                teacherId:           teacherId || '',
                currentSchoolId:     session.schoolId,
                enrollmentStatus:    'Active',
                securityQuestionsSet: false,
                medicalNotes:        '',
                academicHistory:     [],
                createdAt:           new Date().toISOString()
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

// ── 7. TRANSFER MODAL ─────────────────────────────────────────────────────
window.openTransferModal = (id) => {
    currentStudentId = id;
    const s = allStudentsCache.find(x => x.id === id);
    document.getElementById('transferStudentName').textContent = s?.name || 'this student';
    document.getElementById('tSnapSchool').textContent = session.schoolName || session.schoolId;
    document.getElementById('tSnapClass').textContent  = s?.className || 'Unassigned';
    document.getElementById('tSnapDate').textContent   = new Date().toLocaleDateString('en-BZ', { year:'numeric', month:'long', day:'numeric' });
    document.getElementById('transferReason').value = '';
    document.getElementById('transferGpa').value    = '';
    document.getElementById('transferNotes').value  = '';
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
        const s     = allStudentsCache.find(x => x.id === currentStudentId);
        const batch = writeBatch(db);
        const snapshot = {
            schoolId: session.schoolId, schoolName: session.schoolName || session.schoolId,
            teacherId: s?.teacherId || '', className: s?.className || '',
            leftAt: new Date().toISOString(), reason,
            ...(gpa   ? { gpa: parseFloat(gpa) } : {}),
            ...(notes ? { notes }               : {})
        };
        const isTransfer = reason === 'Transferred';
        const newStatus  = reason === 'Graduated' ? 'Graduated' : isTransfer ? 'Transferred' : 'Archived';

        batch.update(doc(db, 'students', currentStudentId), {
            enrollmentStatus: newStatus,
            currentSchoolId:  isTransfer ? '' : session.schoolId,
            teacherId: '', className: '',
            academicHistory: arrayUnion(snapshot)
        });
        batch.set(doc(collection(db, 'schools', session.schoolId, 'notifications')), {
            type: 'student_enrollment_closed', studentId: currentStudentId,
            studentName: s?.name || '', reason,
            closedBy: session.adminId || 'Admin', closedAt: new Date().toISOString()
        });
        await batch.commit();
        
        window.closeTransferModal();
        window.closeStudentPanel(); // Close the side panel if it was open
        loadStudents();
    } catch (e) {
        console.error('[Students] transfer:', e);
        alert('Critical failure. Record preserved.');
    }

    btn.disabled = false;
    btn.innerHTML = `<i class="fa-solid fa-lock mr-2"></i>Seal Snapshot & Close Enrollment`;
});

// ── 8. REASSIGN MODAL ─────────────────────────────────────────────────────
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

    cSelect.addEventListener('change', function() {
        const selectedClass = this.value;
        tSelect.innerHTML = '<option value="">-- Unassigned --</option>';
        if(!selectedClass) return;
        
        const matchingTeachers = allTeachersCache.filter(t => t.classes && t.classes.includes(selectedClass));
        matchingTeachers.forEach(t => {
            tSelect.innerHTML += `<option value="${t.id}">${escHtml(t.name)}</option>`;
        });
        
        if(matchingTeachers.length === 1) {
            tSelect.value = matchingTeachers[0].id;
        }
    });

    openOverlay('reassignStudentModal', 'reassignStudentModalInner');
};

window.closeReassignModal = () => closeOverlay('reassignStudentModal', 'reassignStudentModalInner');

document.getElementById('saveReassignBtn').addEventListener('click', async () => {
    const btn = document.getElementById('saveReassignBtn');
    btn.innerHTML = `<i class="fa-solid fa-spinner fa-spin"></i> Saving...`;
    btn.disabled  = true;
    try {
        await updateDoc(doc(db, 'students', currentStudentId), {
            name:      document.getElementById('rsName').value.trim(),
            className: document.getElementById('rsClass').value,
            teacherId: document.getElementById('rsTeacher').value
        });
        window.closeReassignModal();
        await loadStudents(); // Wait for data to update
        window.openStudentPanel(currentStudentId); // Refresh the side panel to show new class
    } catch (e) {
        showMsg('reassignMsg', 'Error updating student record.', true);
        console.error('[Students] reassign:', e);
    }
    btn.innerHTML = 'Save Changes';
    btn.disabled  = false;
});

// ── 9. STUDENT RECORDS PANEL ──────────────────────────────────────────────
window.openStudentPanel = async (studentId) => {
    currentStudentId = studentId;
    const student = allStudentsCache.find(s => s.id === studentId);
    
    document.getElementById('sPanelName').textContent  = student?.name     || 'Student';
    document.getElementById('sPanelId').textContent    = studentId;
    document.getElementById('sPanelClass').textContent = student?.className || '—';

    // Set up Administrative Actions based on enrollment status
    const isActive = (student?.enrollmentStatus || 'Active') === 'Active';
    const enrollActions = document.getElementById('panelEnrollmentActions');
    if (isActive) {
        enrollActions.style.display = 'flex';
        document.getElementById('panelActionReassign').onclick = () => window.openReassignModal(studentId);
        document.getElementById('panelActionTransfer').onclick = () => window.openTransferModal(studentId);
    } else {
        enrollActions.style.display = 'none';
    }

    // Populate Edit Form
    document.getElementById('editSName').value = student?.name || '';
    document.getElementById('editSDob').value = student?.dob || '';
    document.getElementById('editSParentName').value = student?.parentName || '';
    document.getElementById('editSPhone').value = student?.parentPhone || '';
    document.getElementById('editSEmail').value = student?.email || '';
    
    document.getElementById('spinReadonly').textContent = student?.pin || '—';
    window.toggleStudentEdit(false);
    window.togglePinResetUI(false);

    const printBtn = document.getElementById('sPanelPrintBtn');
    if (printBtn) printBtn.onclick = () => window.printStudentRecord(studentId);

    const history  = student?.academicHistory || [];
    const histBar  = document.getElementById('academicHistoryBar');
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

    const loader     = document.getElementById('sPanelLoader');
    const accordions = document.getElementById('subjectAccordions');
    loader.innerHTML = `<i class="fa-solid fa-circle-notch fa-spin text-4xl mb-3 text-emerald-500"></i><p class="font-semibold text-sm">Loading academic records...</p>`;
    loader.classList.remove('hidden');
    accordions.classList.add('hidden');
    accordions.innerHTML = '';
    
    openOverlay('studentPanel', 'studentPanelInner', true);

    try {
        let gradesSnap = await getDocs(collection(db, 'students', studentId, 'grades'));
        if (gradesSnap.empty) {
            gradesSnap = await getDocs(collection(db, 'schools', session.schoolId, 'students', studentId, 'grades'));
        }
        if (gradesSnap.empty) {
            loader.innerHTML = `<div class="text-center py-16"><div class="text-5xl mb-3">📂</div><p class="text-slate-400 font-semibold">No grades recorded yet.</p></div>`;
            return;
        }

        let gradeTypeWeights = {};
        try {
            const cacheKey = 'connectus_gradeTypes_' + session.schoolId;
            const cached = localStorage.getItem(cacheKey);
            const types = cached ? JSON.parse(cached)
                : (await getDocs(collection(db, 'schools', session.schoolId, 'gradeTypes'))).docs.map(d => ({ id: d.id, ...d.data() }));
            types.forEach(t => { if (t.weight) gradeTypeWeights[t.name] = t.weight; });
        } catch(_) {}

        const hasWeights = Object.keys(gradeTypeWeights).length > 0;

        function calcWeightedAvg(grades) {
            if (!hasWeights) {
                return grades.reduce((a, g) => a + (g.max ? g.score / g.max * 100 : 0), 0) / grades.length;
            }
            const byType = {};
            grades.forEach(g => {
                const t = g.type || 'Other';
                if (!byType[t]) byType[t] = [];
                byType[t].push(g.max ? (g.score / g.max) * 100 : 0);
            });
            let wSum = 0, wTotal = 0;
            Object.entries(byType).forEach(([type, scores]) => {
                const typeAvg = scores.reduce((a, b) => a + b, 0) / scores.length;
                const w = gradeTypeWeights[type] || 0;
                if (w > 0) { wSum += typeAvg * w; wTotal += w; }
            });
            return wTotal > 0 ? wSum / wTotal
                : grades.reduce((a, g) => a + (g.max ? g.score / g.max * 100 : 0), 0) / grades.length;
        }

        function buildWeightBreakdown(grades) {
            if (!hasWeights) return '';
            const byType = {};
            grades.forEach(g => {
                const t = g.type || 'Other';
                if (!byType[t]) byType[t] = [];
                byType[t].push(g.max ? Math.round((g.score / g.max) * 100) : 0);
            });
            const rows = Object.entries(gradeTypeWeights)
                .filter(([type]) => byType[type])
                .map(([type, w]) => {
                    const avg = Math.round(byType[type].reduce((a, b) => a + b, 0) / byType[type].length);
                    const cnt = byType[type].length;
                    const col = avg >= 75 ? 'var(--green-600)' : avg >= 60 ? '#b45309' : '#e31b4a';
                    return '<div style="display:flex;align-items:center;justify-content:space-between;padding:6px 0;border-bottom:1px solid #e2e8f0">'
                        + '<span style="font-size:12px;color:#475569;font-weight:500">' + type + ' <span style="color:#94a3b8;font-size:11px">(' + cnt + ' entry' + (cnt !== 1 ? 'ies' : 'y') + ')</span></span>'
                        + '<div style="display:flex;align-items:center;gap:8px">'
                        + '<span style="font-size:11px;color:#64748b;font-weight:600">' + w + '% weight</span>'
                        + '<span style="font-size:13px;font-weight:700;color:' + col + '">' + avg + '%</span>'
                        + '</div></div>';
                }).join('');
            if (!rows) return '';
            return '<div style="background:#eff6ff;border:1px solid #bfdbfe;border-radius:8px;padding:14px 16px;margin-bottom:14px">'
                + '<p style="font-size:10.5px;font-weight:700;color:#2563eb;text-transform:uppercase;letter-spacing:0.08em;margin:0 0 8px">Grade Weight Breakdown</p>'
                + rows
                + '<p style="font-size:10.5px;color:#64748b;margin:8px 0 0;font-weight:500">Weighted by types that have recorded grades — missing types do not reduce your average.</p>'
                + '</div>';
        }

        const bySubject = {};
        gradesSnap.forEach(d => {
            const g = { id: d.id, ...d.data() };
            const subj = g.subject || 'Uncategorized';
            if (!bySubject[subj]) bySubject[subj] = [];
            bySubject[subj].push(g);
        });

        accordions.innerHTML = Object.entries(bySubject).map(([subject, grades]) => {
            const avg = calcWeightedAvg(grades);
            const ac  = avg >= 75 ? 'text-green-600' : avg >= 60 ? 'text-amber-600' : 'text-red-600';
            const ab  = avg >= 75 ? 'bg-green-50 border-green-200' : avg >= 60 ? 'bg-amber-50 border-amber-200' : 'bg-red-50 border-red-200';
            const rows = grades.map(g => {
                const pct = g.max ? Math.round(g.score / g.max * 100) : null;
                const c   = pct == null ? 'text-slate-600' : pct >= 75 ? 'text-green-600' : pct >= 60 ? 'text-amber-600' : 'text-red-600';
                const adminTag = g.enteredByAdmin
                    ? `<span class="text-[9px] font-black text-blue-500 bg-blue-50 border border-blue-200 px-1.5 py-0.5 rounded ml-1">Admin entry</span>`
                    : '';
                return `<div class="border border-slate-200 rounded-xl bg-white hover:shadow-sm transition">
                    <div class="px-4 py-3 flex items-center justify-between">
                        <div class="flex-1 min-w-0">
                            <p class="font-bold text-slate-700 text-sm truncate">${escHtml(g.title || 'Assessment')}${adminTag}</p>
                            <p class="text-xs text-slate-400 font-semibold mt-0.5">${escHtml(g.type || '')} ${g.date ? '· ' + g.date : ''}</p>
                        </div>
                        <span class="${c} font-black text-sm ml-3">${g.score}/${g.max || '?'}</span>
                    </div>
                </div>`;
            }).join('');

            return `<div class="rounded-2xl border border-slate-200 overflow-hidden shadow-sm">
                <div class="flex items-center justify-between px-5 py-4 bg-white cursor-pointer hover:bg-slate-50 transition"
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
                        <span class="px-3 py-1 rounded-lg ${ab} ${ac} font-black text-xs">${avg.toFixed(0)}% avg</span>
                        <i class="fa-solid fa-chevron-down text-slate-400" style="transition:transform 0.2s"></i>
                    </div>
                </div>
                <div class="subject-body"><div class="px-4 pb-4 pt-2 bg-slate-50/70 space-y-2">${buildWeightBreakdown(grades)}${rows}</div></div>
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

// ── Edit Profile inside Panel ──
window.toggleStudentEdit = function(show) {
    const form = document.getElementById('sEditForm');
    const isVisible = show !== undefined ? show : form.classList.contains('hidden');
    form.classList.toggle('hidden', !isVisible);
    document.getElementById('editStudentMsg').classList.add('hidden');
};

document.getElementById('saveStudentEditBtn').addEventListener('click', async () => {
    const btn = document.getElementById('saveStudentEditBtn');
    btn.innerHTML = `<i class="fa-solid fa-spinner fa-spin"></i> Saving...`;
    btn.disabled = true;

    try {
        const u = {
            name:        document.getElementById('editSName').value.trim(),
            dob:         document.getElementById('editSDob').value,
            parentName:  document.getElementById('editSParentName').value.trim(),
            parentPhone: document.getElementById('editSPhone').value.trim(),
            email:       document.getElementById('editSEmail').value.trim(),
        };
        await updateDoc(doc(db, 'students', currentStudentId), u);
        showMsg('editStudentMsg', 'Changes saved successfully.', false);
        window.toggleStudentEdit(false);
        await loadStudents(); // reload background data
        window.openStudentPanel(currentStudentId); // refresh the panel seamlessly
    } catch (e) {
        console.error('[Admin] saveStudentEdit:', e);
        showMsg('editStudentMsg', 'Error saving changes.', true);
    }
    btn.textContent = 'Save Changes'; btn.disabled = false;
});

// ── Reset PIN inside Panel ──
window.togglePinResetUI = function(show) {
    document.getElementById('pinDisplayArea').classList.toggle('hidden',  show);
    document.getElementById('pinEditArea').classList.toggle('hidden',    !show);
    if (show) document.getElementById('inlineNewPin').value = '';
};

window.saveInlinePin = async function() {
    const npin = document.getElementById('inlineNewPin').value.trim();
    if (!npin || npin.length < 4) { alert('PIN must be 4–6 digits.'); return; }
    const btn = document.getElementById('inlinePinSaveBtn');
    btn.textContent = '…'; btn.disabled = true;
    try {
        await updateDoc(doc(db, 'students', currentStudentId), { pin: npin });
        window.togglePinResetUI(false);
        await loadStudents();
        window.openStudentPanel(currentStudentId); // refresh panel data
    } catch (e) { console.error('[Admin] saveInlinePin:', e); alert('Error saving PIN.'); }
    btn.textContent = 'Save'; btn.disabled = false;
};

// ── 10. PRINT STUDENT RECORD ──────────────────────────────────────────────
window.printStudentRecord = async (studentId) => {
    const sDoc = await getDoc(doc(db, 'students', studentId));
    if (!sDoc.exists()) { alert('Student not found.'); return; }
    const s = sDoc.data();

    let gradesSnap = await getDocs(collection(db, 'students', studentId, 'grades'));
    if (gradesSnap.empty) {
        gradesSnap = await getDocs(collection(db, 'schools', session.schoolId, 'students', studentId, 'grades'));
    }
    const bySem = {};
    gradesSnap.forEach(d => {
        const g = d.data();
        const sem = g.semesterId || 'General';
        const sub = g.subject    || 'Uncategorized';
        if (!bySem[sem]) bySem[sem] = {};
        if (!bySem[sem][sub]) bySem[sem][sub] = [];
        bySem[sem][sub].push(g);
    });

    let gradesHtml = Object.keys(bySem).length === 0
        ? `<p style="text-align:center;color:#64748b;font-style:italic;padding:40px;">No academic grades recorded.</p>`
        : Object.entries(bySem).map(([sem, subjects]) => {
            let rows = '', total = 0, count = 0;
            for (const sub in subjects) {
                const avg = Math.round(subjects[sub].reduce((a, g) => a + (g.max ? g.score/g.max*100 : 0), 0) / subjects[sub].length);
                total += avg; count++;
                rows += `<tr><td style="border:1px solid #e2e8f0;padding:10px 15px;">${sub}</td><td style="border:1px solid #e2e8f0;padding:10px 15px;text-align:center;">${subjects[sub].length}</td><td style="border:1px solid #e2e8f0;padding:10px 15px;text-align:center;">${avg}%</td><td style="border:1px solid #e2e8f0;padding:10px 15px;text-align:center;">${letterGrade(avg)}</td></tr>`;
            }
            const avg = Math.round(total/count);
            rows += `<tr style="background:#f8fafc;font-weight:bold;"><td colspan="2" style="border:1px solid #e2e8f0;padding:10px 15px;text-align:right;">PERIOD AVERAGE:</td><td style="border:1px solid #e2e8f0;padding:10px 15px;text-align:center;">${avg}%</td><td style="border:1px solid #e2e8f0;padding:10px 15px;text-align:center;">${letterGrade(avg)}</td></tr>`;
            return `<div style="margin-bottom:40px;page-break-inside:avoid;"><h3 style="font-size:13px;font-weight:bold;background:#334155;color:white;padding:8px 15px;border-radius:4px;margin-bottom:10px;">Period: ${sem}</h3><table style="width:100%;border-collapse:collapse;font-size:13px;"><thead><tr style="background:#f1f5f9;"><th style="border:1px solid #e2e8f0;padding:10px 15px;text-align:left;">Subject</th><th style="border:1px solid #e2e8f0;padding:10px 15px;text-align:center;">Assessments</th><th style="border:1px solid #e2e8f0;padding:10px 15px;text-align:center;">Average</th><th style="border:1px solid #e2e8f0;padding:10px 15px;text-align:center;">Grade</th></tr></thead><tbody>${rows}</tbody></table></div>`;
        }).join('');

    const w = window.open('', '_blank');
    w.document.write(`<html><head><title>Student Record — ${s.name}</title><style>body{font-family:'Helvetica Neue',sans-serif;padding:40px;color:#1e293b;line-height:1.5}.header{text-align:center;border-bottom:2px solid #cbd5e1;padding-bottom:20px;margin-bottom:30px}.info-grid{display:grid;grid-template-columns:1fr 1fr;gap:12px;margin-bottom:30px;background:#f8fafc;padding:18px;border-radius:8px;border:1px solid #e2e8f0}.info-item label{display:block;font-size:10px;text-transform:uppercase;color:#64748b;font-weight:bold}.info-item span{font-size:13px;font-weight:bold;color:#0f172a}.footer{margin-top:50px;text-align:center;font-size:10px;color:#94a3b8;border-top:1px solid #e2e8f0;padding-top:15px}</style></head><body><div class="header"><h1 style="margin:0 0 4px;font-size:22px;text-transform:uppercase;">${session.schoolName || 'ConnectUs School'}</h1><h2 style="margin:0;font-size:13px;color:#64748b;font-weight:normal;letter-spacing:2px;">OFFICIAL ACADEMIC PASSPORT — NATIONAL STUDENT RECORD</h2></div><div class="info-grid"><div class="info-item"><label>Student Name</label><span>${s.name}</span></div><div class="info-item"><label>Global ID</label><span>${s.studentIdNum || studentId}</span></div><div class="info-item"><label>Date of Birth</label><span>${s.dob || 'N/A'}</span></div><div class="info-item"><label>Enrollment Status</label><span>${s.enrollmentStatus || 'Active'}</span></div><div class="info-item"><label>Current Class</label><span>${s.className || 'Unassigned'}</span></div><div class="info-item"><label>Parent / Guardian</label><span>${s.parentName || 'N/A'}</span></div></div>${gradesHtml}<div class="footer">Printed ${new Date().toLocaleDateString()} via ConnectUs National Registry<br>Issued by: ${session.schoolName || session.schoolId}</div></body></html>`);
    w.document.close();
    setTimeout(() => w.print(), 500);
};

// ── 11. CSV & PRINT ────────────────────────────────────────────────────────
document.getElementById('exportCsvBtn').addEventListener('click', () => {
    const rows = [
        ['Global ID','Name','Status','Class','Teacher','Parent Phone','DOB'],
        ...allStudentsCache.map(s => [s.id, s.name||'', s.enrollmentStatus||'Active', s.className||'', s.teacherName||'', s.parentPhone||'', s.dob||''])
    ];
    const csv = rows.map(r => r.map(v => `"${String(v ?? '').replace(/"/g,'""')}"`).join(',')).join('\n');
    const a = Object.assign(document.createElement('a'), {
        href: URL.createObjectURL(new Blob([csv],{type:'text/csv'})),
        download: `${session.schoolId}_students_${new Date().toISOString().slice(0,10)}.csv`
    });
    document.body.appendChild(a); a.click(); a.remove();
});

document.getElementById('printListBtn').addEventListener('click', () => {
    const w = window.open('', '_blank');
    w.document.write(`<html><head><title>Student Directory</title><style>body{font-family:sans-serif;padding:20px}table{border-collapse:collapse;width:100%}th,td{border:1px solid #e2e8f0;padding:8px 12px;font-size:12px;text-align:left}th{background:#f8fafc;font-weight:700}</style></head><body><h2>${session.schoolName||'School'} — Student Directory</h2><p style="color:#64748b;font-size:11px;margin-bottom:14px">Printed ${new Date().toLocaleDateString()}</p><table><thead><tr><th>Global ID</th><th>Name</th><th>Status</th><th>Class</th><th>Teacher</th><th>Parent Phone</th></tr></thead><tbody>${allStudentsCache.map(s=>`<tr><td style="font-family:monospace">${s.id}</td><td>${s.name||''}</td><td>${s.enrollmentStatus||'Active'}</td><td>${s.className||''}</td><td>${s.teacherName||''}</td><td>${s.parentPhone||'—'}</td></tr>`).join('')}</tbody></table></body></html>`);
    w.document.close(); w.print();
});

// ── BOOT ──────────────────────────────────────────────────────────────────
loadStudents();
