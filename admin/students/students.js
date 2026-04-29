import { db } from '../../assets/js/firebase-init.js';
import {
    collection, query, where,
    getDocs, getDoc, doc,
    setDoc, updateDoc, addDoc, writeBatch,
    arrayUnion, orderBy
} from "https://www.gstatic.com/firebasejs/10.7.1/firebase-firestore.js";
import { requireAuth } from '../../assets/js/auth.js';
import { injectAdminLayout } from '../../assets/js/layout-admin.js';
import { openOverlay, closeOverlay, letterGrade, calculateWeightedAverage } from '../../assets/js/utils.js';

// ── 1. INIT & AUTH ─────────────────────────────────────────────────────────
const session = requireAuth('admin', '../login.html');
injectAdminLayout('students', 'Student Registry', 'Enroll, claim, and manage lifelong student identities.', true, false);

// ── 2. STATE ───────────────────────────────────────────────────────────────
let allStudentsCache  = [];
let allTeachersCache  = [];
let currentStudentId  = null;
let currentStudentData = null;
let claimedStudentDoc = null;
let sSlipData         = { name: '', id: '', pin: '' };

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

function generatePin() {
    return Math.floor(100000 + Math.random() * 900000).toString();
}

function escHtml(str) {
    if (!str) return '';
    return String(str).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}

function statusBadge(status) {
    const map = {
        Active:      'status-active',
        Transferred: 'status-transferred',
        Graduated:   'status-graduated',
        Archived:    'status-archived'
    };
    return `<span class="text-[10px] font-black px-2 py-0.5 rounded-md uppercase tracking-wider ${map[status] || 'status-archived'}">${status || 'Unknown'}</span>`;
}

function getClassOptions() {
    const type = (session.schoolType || '').toLowerCase();
    if (type === 'highschool' || type === 'secondary') {
        return ['First Form', 'Second Form', 'Third Form', 'Fourth Form', 'Fifth Form', 'Sixth Form'];
    } else if (type === 'juniorcollege' || type === 'tertiary') {
        return ['Year 1 — Semester 1', 'Year 1 — Semester 2', 'Year 2 — Semester 1', 'Year 2 — Semester 2'];
    }
    return ['Infant 1', 'Infant 2', 'Standard 1', 'Standard 2', 'Standard 3', 'Standard 4', 'Standard 5', 'Standard 6'];
}

function isStudentProfileComplete(s) {
    return !!(s.dob && s.parentName && s.parentPhone && s.address?.city);
}

// Helper to fetch the exact grade weights of a student's assigned teacher
function getTeacherGradeTypes(teacherId) {
    if (!teacherId) return []; // Return empty so utils.js falls back to standard flat math
    
    const t = allTeachersCache.find(x => x.id === teacherId);
    const rawTypes = t?.gradeTypes || t?.customGradeTypes || [];
    
    // Safety map: Converts legacy strings into objects so the math engine doesn't crash
    return rawTypes.map(type => {
        if (typeof type === 'string') {
            return { name: type, weight: 0 };
        }
        return type;
    });
}

function blankStudentDoc(overrides = {}) {
    return {
        // ── System ──────────────────────────────────────────
        pin:                  generatePin(),
        requiresPinReset:     true,
        profileComplete:      false,
        securityQuestionsSet: false,
        currentSchoolId:      session.schoolId,
        enrollmentStatus:     'Active',
        academicHistory:      [],
        createdAt:            new Date().toISOString(),

        // ── Basic (admin fills, locked after first login) ────
        firstName:            '',
        lastName:             '',
        name:                 '',
        dob:                  '',
        email:                '',
        gender:               '',
        nationality:          'Belizean',

        // ── Parent / Guardian ────────────────────────────────
        parentName:           '',
        parentPhone:          '',
        parentEmail:          '',
        parentRelationship:   '',

        // ── Address (student fills during onboarding) ────────
        address: {
            line1:    '',
            line2:    '',
            city:     '',
            district: '',
            country:  'Belize'
        },

        // ── School Assignment ────────────────────────────────
        className:  '',
        teacherId:  '',

        ...overrides
    };
}

function infoCell(label, value) {
    return `
        <div class="bg-[#f8fafb] border border-[#f0f4f8] rounded-lg p-3">
            <p class="text-[9px] font-bold text-[#9ab0c6] uppercase tracking-widest mb-1">${label}</p>
            <p class="font-bold text-[#0d1f35] text-[12px] leading-snug">${value}</p>
        </div>`;
}

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
    tbody.innerHTML = `<tr><td colspan="6" class="px-6 py-16 text-center text-[#9ab0c6] italic font-semibold">
        <i class="fa-solid fa-spinner fa-spin mr-2 text-[#2563eb]"></i>Loading student records...
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
            id: d.id,
            ...d.data(),
            teacherName: teacherMap[d.data().teacherId] || '—'
        }));

        // Populate filter dropdowns (once)
        if (filterTeacherSelect.options.length <= 1) {
            filterTeacherSelect.innerHTML = '<option value="">All Teachers</option>' +
                allTeachersCache.map(t => `<option value="${t.id}">${escHtml(t.name)}</option>`).join('');
        }
        if (filterClassSelect.options.length <= 2) {
            filterClassSelect.innerHTML =
                '<option value="">All Classes</option><option value="unassigned">Unassigned Only</option>' +
                getClassOptions().map(c => `<option value="${c}">${c}</option>`).join('');
        }

        renderTable();
    } catch (e) {
        console.error('[Students] loadStudents:', e);
        tbody.innerHTML = `<tr><td colspan="6" class="px-6 py-16 text-center text-[#e31b4a] font-semibold">
            Database connection error. Please refresh.
        </td></tr>`;
    }
}

// ── 5. RENDER TABLE ────────────────────────────────────────────────────────
function renderTable() {
    let filtered = [...allStudentsCache];
    const term      = (document.getElementById('searchInput')?.value || '').toLowerCase();
    const filterT   = filterTeacherSelect.value;
    const filterC   = filterClassSelect.value;
    const filterSt  = filterStatusSelect.value;

    if (filterT)                   filtered = filtered.filter(s => s.teacherId === filterT);
    if (filterC === 'unassigned')  filtered = filtered.filter(s => !s.className || !s.teacherId);
    else if (filterC)              filtered = filtered.filter(s => s.className === filterC);
    if (filterSt)                  filtered = filtered.filter(s => (s.enrollmentStatus || 'Active') === filterSt);
    if (term)                      filtered = filtered.filter(s => (s.name || '').toLowerCase().includes(term));

    if (!filtered.length) {
        tbody.innerHTML = `<tr><td colspan="6" class="px-6 py-16 text-center text-[#9ab0c6] italic font-semibold">
            No students match the selected filters.
        </td></tr>`;
        return;
    }

    tbody.innerHTML = filtered.map(s => {
        const status   = s.enrollmentStatus || 'Active';
        const complete = isStudentProfileComplete(s);

        const classBadge = s.className
            ? `<span class="text-[11px] font-semibold text-[#374f6b]">${escHtml(s.className)}</span>`
            : `<span class="text-[10px] font-bold text-amber-700 bg-amber-50 border border-amber-200 px-2 py-0.5 rounded-md">Unassigned</span>`;

        const teacherBadge = s.teacherName && s.teacherName !== '—'
            ? `<span class="text-[11px] font-semibold text-[#374f6b]">${escHtml(s.teacherName)}</span>`
            : `<span class="text-[10px] font-bold text-amber-700 bg-amber-50 border border-amber-200 px-2 py-0.5 rounded-md">Unassigned</span>`;

        const profileBadge = complete
            ? `<span class="inline-flex items-center gap-1 text-[10px] font-bold text-green-700 bg-green-50 border border-green-200 px-2 py-1 rounded-md"><i class="fa-solid fa-circle-check text-[9px]"></i> Complete</span>`
            : `<span class="inline-flex items-center gap-1 text-[10px] font-bold text-red-600 bg-red-50 border border-red-200 px-2 py-1 rounded-md"><i class="fa-solid fa-circle-exclamation text-[9px]"></i> Incomplete</span>`;

        return `
        <tr class="border-b border-[#f0f4f8] hover:bg-[#f8fafb] transition">
            <td class="px-6 py-4">
                <div class="flex items-center gap-3">
                    <div class="h-10 w-10 bg-[#0d1f35] text-white rounded-lg flex items-center justify-center font-black text-sm flex-shrink-0">
                        ${escHtml(s.name || '?').charAt(0).toUpperCase()}
                    </div>
                    <div>
                        <p class="font-bold text-[#0d1f35] text-[13px] leading-tight">${escHtml(s.name || 'Unknown')}</p>
                        <p class="text-[10.5px] font-mono text-[#6b84a0] uppercase tracking-widest mt-0.5">${s.id}</p>
                    </div>
                </div>
            </td>
            <td class="px-6 py-4">${statusBadge(status)}</td>
            <td class="px-6 py-4">${classBadge}</td>
            <td class="px-6 py-4">${teacherBadge}</td>
            <td class="px-6 py-4 text-center">${profileBadge}</td>
            <td class="px-6 py-4 text-right">
                <button onclick="window.openStudentPanel('${s.id}')"
                    class="bg-white hover:bg-[#eef4ff] text-[#2563eb] font-bold px-4 py-2 rounded text-[12px] transition border border-[#c7d9fd]">
                    Manage
                </button>
            </td>
        </tr>`;
    }).join('');
}

filterClassSelect.addEventListener('change', renderTable);
filterTeacherSelect.addEventListener('change', renderTable);
filterStatusSelect.addEventListener('change', renderTable);
document.getElementById('searchInput')?.addEventListener('input', renderTable);


// ── 6. ADD / CLAIM MODAL ───────────────────────────────────────────────────

function populateCreateClassDropdown() {
    const sel = document.getElementById('sClass');
    if (!sel) return;
    sel.innerHTML = '<option value="">— Optional —</option>' +
        getClassOptions().map(c => `<option value="${c}">${c}</option>`).join('');
}

function onModalClassChange() {
    const cls     = document.getElementById('sClass')?.value || '';
    const tSelect = document.getElementById('sTeacher');
    if (!tSelect) return;
    tSelect.innerHTML = '';

    if (!cls) {
        tSelect.innerHTML = '<option value="">— Select a class first —</option>';
        tSelect.disabled  = true;
        return;
    }

    const matches = allTeachersCache.filter(t => t.classes?.includes(cls));
    if (!matches.length) {
        tSelect.innerHTML = '<option value="">No teacher assigned to this class yet</option>';
    } else {
        tSelect.innerHTML = '<option value="">— Select teacher —</option>' +
            matches.map(t => `<option value="${t.id}">${escHtml(t.name)}</option>`).join('');
        if (matches.length === 1) tSelect.value = matches[0].id;
    }
    tSelect.disabled = false;
}

window.openAddStudentModal = () => {
    ['sFirstName', 'sLastName', 'sDob', 'sEmail', 'sParentName', 'sParentPhone', 'studentSearchInput'].forEach(id => {
        const el = document.getElementById(id); if (el) el.value = '';
    });
    document.getElementById('sGender').value = '';
    ['studentSearchResults', 'claimStudentPreview', 'claimStudentEmpty', 'addStudentMsg'].forEach(id =>
        document.getElementById(id)?.classList.add('hidden')
    );
    const tSelect = document.getElementById('sTeacher');
    if (tSelect) { tSelect.innerHTML = '<option value="">— Select a class first —</option>'; tSelect.disabled = true; }
    claimedStudentDoc = null;
    populateCreateClassDropdown();

    // Wire class → teacher filter fresh each open (avoids duplicate listeners)
    const sClassEl = document.getElementById('sClass');
    if (sClassEl) {
        const fresh = sClassEl.cloneNode(true);
        sClassEl.parentNode.replaceChild(fresh, sClassEl);
        fresh.addEventListener('change', onModalClassChange);
        populateCreateClassDropdown(); // re-populate after clone
    }

    openOverlay('addStudentModal', 'addStudentModalInner');
};

window.closeAddStudentModal = () => {
    closeOverlay('addStudentModal', 'addStudentModalInner');
    claimedStudentDoc = null;
};

// ── Search "Enter" Key Listener ───────────────────────────────────────────
document.getElementById('studentSearchInput').addEventListener('keydown', (e) => {
    if (e.key === 'Enter') {
        e.preventDefault();
        document.getElementById('searchStudentBtn').click();
    }
});

// ── Search Unassigned Students ─────────────────────────────────────────────
document.getElementById('searchStudentBtn').addEventListener('click', async () => {
    const input     = document.getElementById('studentSearchInput').value.trim();
    const resultsEl = document.getElementById('studentSearchResults');
    const emptyEl   = document.getElementById('claimStudentEmpty');
    const previewEl = document.getElementById('claimStudentPreview');

    resultsEl.classList.add('hidden');
    emptyEl.classList.add('hidden');
    previewEl.classList.add('hidden');
    claimedStudentDoc = null;

    if (!input) { alert('Enter a name, email, or Student ID to search.'); return; }

    const btn = document.getElementById('searchStudentBtn');
    btn.innerHTML = '<i class="fa-solid fa-spinner fa-spin"></i>';
    btn.disabled  = true;

    try {
        let results    = [];
        const lower    = input.toLowerCase();
        const looksLikeId = input.includes('-');

        if (looksLikeId) {
            const normalizedId = input.toUpperCase().replace(/\s/g, '');
            const snap = await getDoc(doc(db, 'students', normalizedId));
            if (snap.exists()) {
                const d = { id: snap.id, ...snap.data() };
                if (!d.currentSchoolId || d.currentSchoolId === '') {
                    results = [d];
                } else if (d.currentSchoolId === session.schoolId) {
                    document.getElementById('claimStudentEmpty').querySelector('p').textContent =
                        'That student is already enrolled at your school.';
                    emptyEl.classList.remove('hidden');
                    btn.innerHTML = '<i class="fa-solid fa-magnifying-glass mr-1"></i> Search';
                    btn.disabled  = false;
                    return;
                } else {
                    document.getElementById('claimStudentEmpty').querySelector('p').textContent =
                        'That student is currently enrolled at another school. Their school must release them first.';
                    emptyEl.classList.remove('hidden');
                    btn.innerHTML = '<i class="fa-solid fa-magnifying-glass mr-1"></i> Search';
                    btn.disabled  = false;
                    return;
                }
            }
        }

        if (!results.length) {
            const snap = await getDocs(
                query(collection(db, 'students'), where('currentSchoolId', '==', ''))
            );
            results = snap.docs
                .map(d => ({ id: d.id, ...d.data() }))
                .filter(s => 
                    (s.name || '').toLowerCase().includes(lower) ||
                    (s.email || '').toLowerCase().includes(lower) ||
                    s.id.toLowerCase().includes(lower)
                );
        }

        if (!results.length) {
            emptyEl.classList.remove('hidden');
        } else {
            resultsEl.innerHTML = results.map(s => `
                <div onclick="window.selectStudentResult('${s.id}')"
                    class="px-4 py-3 hover:bg-[#eef4ff] cursor-pointer border-b border-[#f0f4f8] last:border-0 flex items-center justify-between transition">
                    <div>
                        <p class="font-bold text-[#0d1f35] text-[13px]">${escHtml(s.name || 'Unknown')}</p>
                        <p class="font-mono text-[10px] text-[#9ab0c6] uppercase mt-0.5">${s.id} ${s.email ? `• ${s.email}` : ''}</p>
                    </div>
                    <i class="fa-solid fa-chevron-right text-[#c5d0db] text-[11px]"></i>
                </div>
            `).join('');
            resultsEl.classList.remove('hidden');
        }
    } catch (e) {
        console.error('[Students] search:', e);
        alert('Search failed. Please try again.');
    }

    btn.innerHTML = '<i class="fa-solid fa-magnifying-glass mr-1"></i> Search';
    btn.disabled  = false;
});

window.selectStudentResult = async (studentId) => {
    document.getElementById('studentSearchResults').classList.add('hidden');

    try {
        const snap = await getDoc(doc(db, 'students', studentId));
        if (!snap.exists()) return;

        claimedStudentDoc = { id: snap.id, ...snap.data() };
        const s = claimedStudentDoc;

        document.getElementById('claimSPreviewName').textContent = s.name || 'Unknown';
        document.getElementById('claimSPreviewId').textContent   = s.id;

        const lastSchool = s.academicHistory?.length
            ? s.academicHistory[s.academicHistory.length - 1].schoolName || s.academicHistory[s.academicHistory.length - 1].schoolId
            : null;

        const details = [
            ['Date of Birth', s.dob || null],
            ['Gender',        s.gender || null],
            ['Email',         s.email || null],
            ['Parent Name',   s.parentName || null],
            ['Parent Phone',  s.parentPhone || null],
            ['Last School',   lastSchool],
        ];

        document.getElementById('claimSPreviewDetails').innerHTML = details.map(([label, val]) => `
            <div class="bg-white rounded-lg p-2.5 border border-[#dce3ed]">
                <p class="text-[9px] font-bold text-[#9ab0c6] uppercase tracking-widest mb-0.5">${label}</p>
                <p class="text-[12px] font-bold text-[#0d1f35]">
                    ${val ? escHtml(val) : '<span class="text-[#c5d0db] italic text-[11px] font-semibold">Not on file</span>'}
                </p>
            </div>
        `).join('');

        const warningEl   = document.getElementById('claimSPreviewWarning');
        const warningText = document.getElementById('claimSPreviewWarningText');
        if (!s.email) {
            warningText.textContent = 'No email on file — the student should add one during their first login setup.';
            warningEl.classList.remove('hidden');
        } else {
            warningEl.classList.add('hidden');
        }

        document.getElementById('claimStudentPreview').classList.remove('hidden');
    } catch (e) {
        console.error('[Students] selectStudentResult:', e);
        alert('Could not load student details. Please try again.');
    }
};

window.clearStudentSelection = () => {
    document.getElementById('claimStudentPreview').classList.add('hidden');
    document.getElementById('studentSearchInput').value = '';
    claimedStudentDoc = null;
};

// ── Claim Student ──────────────────────────────────────────────────────────
document.getElementById('claimStudentBtn').addEventListener('click', async () => {
    if (!claimedStudentDoc) return;
    const btn = document.getElementById('claimStudentBtn');
    btn.innerHTML = '<i class="fa-solid fa-spinner fa-spin mr-2"></i>Claiming...';
    btn.disabled  = true;

    try {
        const limitCheck = await isStudentLimitReached();
        if (limitCheck.reached) {
            alert(`Student limit reached (${limitCheck.current}/${limitCheck.limit}). Contact ConnectUs to upgrade.`);
            btn.disabled  = false;
            btn.innerHTML = '<i class="fa-solid fa-handshake mr-2"></i> Claim This Student';
            return;
        }

        const tempPin = generatePin();
        await updateDoc(doc(db, 'students', claimedStudentDoc.id), {
            currentSchoolId:  session.schoolId,
            enrollmentStatus: 'Active',
            pin:              tempPin,
            requiresPinReset: true
        });

        sSlipData = { name: claimedStudentDoc.name, id: claimedStudentDoc.id, pin: tempPin };
        window.closeAddStudentModal();
        window.showStudentCredentialSlip();
        loadStudents();

    } catch (e) {
        console.error('[Students] claim:', e);
        alert('Error claiming student. Please try again.');
    }

    btn.disabled  = false;
    btn.innerHTML = '<i class="fa-solid fa-handshake mr-2"></i> Claim This Student';
});

// ── Create New Student ─────────────────────────────────────────────────────
document.getElementById('saveStudentBtn').addEventListener('click', async () => {
    const btn   = document.getElementById('saveStudentBtn');
    const msgEl = document.getElementById('addStudentMsg');
    msgEl.classList.add('hidden');

    const firstName   = document.getElementById('sFirstName').value.trim();
    const lastName    = document.getElementById('sLastName').value.trim();
    const dob         = document.getElementById('sDob').value;
    const email       = document.getElementById('sEmail').value.trim();
    const gender      = document.getElementById('sGender').value;
    const parentName  = document.getElementById('sParentName').value.trim();
    const parentPhone = document.getElementById('sParentPhone').value.trim();
    const className   = document.getElementById('sClass').value;
    const teacherId   = document.getElementById('sTeacher').value;

    const showMsg = (text, isError = true) => {
        msgEl.textContent = text;
        msgEl.className   = `text-[11px] font-bold mb-2 ${isError ? 'text-red-600' : 'text-green-600'}`;
        msgEl.classList.remove('hidden');
    };

    if (!firstName || !lastName) { showMsg('First and last name are required.'); return; }
    if (!dob)                    { showMsg('Date of birth is required.'); return; }
    if (!gender)                 { showMsg('Gender is required.'); return; }
    if (!email)                  { showMsg('Email address is required for first-time login and PIN recovery.'); return; }
    if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) { showMsg('Please enter a valid email address.'); return; }
    if (!parentName)             { showMsg('Parent / Guardian Name is required.'); return; }
    if (!parentPhone)            { showMsg('Parent Phone is required.'); return; }

    // Strict Class/Teacher Logic
    if (className && !teacherId) { showMsg('If a class is selected, a teacher must also be assigned.'); return; }
    if (!className && teacherId) { showMsg('If a teacher is assigned, a class must also be selected.'); return; }

    btn.innerHTML = '<i class="fa-solid fa-spinner fa-spin mr-2"></i>Processing...';
    btn.disabled  = true;

    try {
        // Strict Email Validation Check
        const emailCheckQuery = query(collection(db, 'students'), where('email', '==', email));
        const emailCheckSnap = await getDocs(emailCheckQuery);
        if (!emailCheckSnap.empty) {
            showMsg('This email is already registered to a student.');
            btn.innerHTML = '<i class="fa-solid fa-user-plus mr-2"></i> Register';
            btn.disabled = false;
            return;
        }

        const limitCheck = await isStudentLimitReached();
        if (limitCheck.reached) {
            alert(`Student limit reached (${limitCheck.current}/${limitCheck.limit}). Contact ConnectUs to upgrade.`);
            btn.disabled  = false; btn.innerHTML = '<i class="fa-solid fa-user-plus mr-2"></i> Register'; return;
        }

        const newId    = generateStudentId();
        const fullName = `${firstName} ${lastName}`;
        const docData  = blankStudentDoc({
            firstName, lastName, name: fullName,
            dob, email, gender,
            parentName, parentPhone,
            className: className || '',
            teacherId: teacherId || ''
        });

        await setDoc(doc(db, 'students', newId), docData);

        sSlipData = { name: fullName, id: newId, pin: docData.pin };
        window.closeAddStudentModal();
        window.showStudentCredentialSlip();
        loadStudents();

    } catch (e) {
        console.error('[Students] create:', e);
        showMsg('System error. Please try again.');
    }

    btn.disabled  = false;
    btn.innerHTML = '<i class="fa-solid fa-user-plus mr-2"></i> Register';
});


// ── 7. CREDENTIAL SLIP ────────────────────────────────────────────────────
window.showStudentCredentialSlip = () => {
    document.getElementById('sSlipName').textContent = sSlipData.name;
    document.getElementById('sSlipId').textContent   = sSlipData.id;
    document.getElementById('sSlipPin').textContent  = sSlipData.pin;
    openOverlay('studentCredentialSlipModal', 'studentCredentialSlipModalInner');
};

window.closeStudentCredentialSlip = () =>
    closeOverlay('studentCredentialSlipModal', 'studentCredentialSlipModalInner');

window.printStudentCredentialSlip = () => {
    const { name, id, pin } = sSlipData;
    const html = `<!DOCTYPE html><html><head><title>Student Credential Slip</title>
    <style>
        body{font-family:'Helvetica Neue',Arial,sans-serif;display:flex;justify-content:center;align-items:center;height:100vh;margin:0;background:#f4f7fb}
        .slip{background:white;border:2px solid #dce3ed;border-top:4px solid #059669;border-radius:12px;padding:32px 40px;max-width:340px;text-align:center}
        .logo{font-size:11px;font-weight:900;letter-spacing:0.3em;color:#6b84a0;text-transform:uppercase;margin-bottom:20px}
        h2{font-size:17px;color:#0d1f35;font-weight:900;margin:0 0 20px 0}
        .lbl{font-size:9px;font-weight:700;letter-spacing:0.15em;text-transform:uppercase;color:#6b84a0;margin-top:12px;margin-bottom:3px}
        .id{font-family:monospace;font-size:22px;font-weight:900;letter-spacing:0.2em;color:#0d1f35}
        .pin{font-family:monospace;font-size:32px;font-weight:900;letter-spacing:0.4em;color:#059669}
        .note{font-size:10px;color:#b45309;font-weight:700;background:#fffbeb;border:1px solid #fde68a;border-radius:6px;padding:10px 12px;margin-top:16px;line-height:1.5}
        .ft{font-size:9px;color:#9ab0c6;margin-top:16px;border-top:1px solid #f0f4f8;padding-top:12px}
    </style></head><body>
    <div class="slip">
        <div class="logo">ConnectUs Student Registry</div>
        <h2>${escHtml(name)}</h2>
        <p class="lbl">Global Student ID</p><p class="id">${escHtml(id)}</p>
        <p class="lbl">Temporary Login PIN</p><p class="pin">${escHtml(pin)}</p>
        <div class="note">⚠ Temporary PIN — reset required on first login.<br>Security questions must also be set.</div>
        <p class="ft">Keep this slip confidential.<br>Present at the ConnectUs Student Portal.</p>
    </div></body></html>`;

    const w = window.open('', '_blank');
    w.document.write(html);
    w.document.close();
    setTimeout(() => w.print(), 400);
};


// ── 8. STUDENT PANEL ──────────────────────────────────────────────────────
window.openStudentPanel = async (studentId) => {
    currentStudentId   = studentId;
    currentStudentData = null;

    document.getElementById('sPanelLoader').classList.remove('hidden');
    document.getElementById('sPanelLoader').innerHTML = '<i class="fa-solid fa-spinner fa-spin text-3xl text-[#2563eb]"></i>';
    document.getElementById('sPanelTabs').classList.add('hidden');
    document.querySelectorAll('#studentPanelInner .tab-pane').forEach(p => p.classList.add('hidden'));

    // Close dropdown if open
    document.getElementById('sEnrollDropdown').classList.add('hidden');

    openOverlay('studentPanel', 'studentPanelInner', true);

    try {
        const snap = await getDoc(doc(db, 'students', studentId));
        if (!snap.exists()) {
            document.getElementById('sPanelLoader').innerHTML =
                `<p class="text-[#e31b4a] font-bold px-8 text-center">Student not found in registry.</p>`;
            return;
        }

        currentStudentData = { id: snap.id, ...snap.data() };
        const s = currentStudentData;
        const teacherName = allTeachersCache.find(t => t.id === s.teacherId)?.name || '—';

        // ── Billboard Header Update ──
        document.getElementById('sPanelName').textContent  = s.name || 'Unknown Student';
        document.getElementById('sPanelId').textContent    = s.id;
        
        // Show Class/Teacher Badge if Assigned
        const badgeEl = document.getElementById('sPanelClassBadge');
        if (s.className && s.teacherId) {
            document.getElementById('sPanelClassText').textContent = `${s.className} with ${teacherName}`;
            badgeEl.classList.remove('hidden');
        } else {
            badgeEl.classList.add('hidden');
        }

        // Hide actions if not Active
        const isActive = (s.enrollmentStatus || 'Active') === 'Active';
        document.getElementById('sEnrollActionsWrapper').style.display = isActive ? 'block' : 'none';

        document.getElementById('sPanelLoader').classList.add('hidden');
        document.getElementById('sPanelTabs').classList.remove('hidden');

        switchStudentTab('overview');

    } catch (e) {
        console.error('[Students] openStudentPanel:', e);
        document.getElementById('sPanelLoader').innerHTML =
            `<p class="text-[#e31b4a] font-bold px-8 text-center">Error loading student. Please try again.</p>`;
    }
};

window.closeStudentPanel = () => closeOverlay('studentPanel', 'studentPanelInner', true);

// ── Enrollment Actions Dropdown ───────────────────────────────────────────
window.toggleSEnrollDropdown = () => {
    document.getElementById('sEnrollDropdown').classList.toggle('hidden');
};

// Close dropdown when clicking outside
document.addEventListener('click', (e) => {
    const wrapper = document.getElementById('sEnrollActionsWrapper');
    if (wrapper && !wrapper.contains(e.target)) {
        document.getElementById('sEnrollDropdown')?.classList.add('hidden');
    }
});

// ── Tab Switching ─────────────────────────────────────────────────────────
document.querySelectorAll('#studentPanelInner .panel-tab').forEach(btn => {
    btn.addEventListener('click', () => switchStudentTab(btn.dataset.tab));
});

function switchStudentTab(tabName) {
    document.querySelectorAll('#studentPanelInner .panel-tab').forEach(b => b.classList.remove('active'));
    document.querySelectorAll('#studentPanelInner .tab-pane').forEach(p => p.classList.add('hidden'));

    document.querySelector(`#studentPanelInner .panel-tab[data-tab="${tabName}"]`)?.classList.add('active');
    document.getElementById(`tab-${tabName}`)?.classList.remove('hidden');

    if (tabName === 'overview')    renderStudentOverviewTab();
    if (tabName === 'academic')    renderStudentAcademicTab();
    if (tabName === 'history')     renderStudentHistoryTab();
    if (tabName === 'enrollment')  renderStudentEnrollmentTab();
}


// ── 9. OVERVIEW TAB ───────────────────────────────────────────────────────
function renderStudentOverviewTab() {
    const s    = currentStudentData;
    if (!s) return;
    const pane = document.getElementById('tab-overview');
    const complete = isStudentProfileComplete(s);

    pane.innerHTML = `

        <div class="${complete
            ? 'bg-green-50 border-green-200 text-green-700'
            : 'bg-red-50 border-red-200 text-red-700'} border rounded-xl p-4 flex items-start gap-3">
            <i class="fa-solid ${complete ? 'fa-circle-check text-green-500' : 'fa-circle-exclamation text-red-500'} text-xl mt-0.5 flex-shrink-0"></i>
            <div>
                <p class="font-black text-[13px] mb-0.5">${complete ? 'Profile Complete' : 'Profile Incomplete'}</p>
                <p class="text-[11px] font-semibold opacity-80">
                    ${complete
                        ? 'All required profile information is on file.'
                        : 'The student has not completed their profile. They will be prompted during their next login.'}
                </p>
            </div>
        </div>

        <div class="bg-white border border-[#dce3ed] rounded-xl p-5 shadow-sm">
            <div class="flex items-center justify-between mb-3">
                <h4 class="text-[10px] font-bold text-[#6b84a0] uppercase tracking-widest">Personal Information</h4>
                <span class="text-[10px] font-bold text-[#9ab0c6] bg-[#f8fafb] border border-[#dce3ed] px-2 py-0.5 rounded">
                    <i class="fa-solid fa-lock text-[9px] mr-1"></i>Read Only
                </span>
            </div>
            <div class="grid grid-cols-2 gap-2">
                ${infoCell('Global ID', `<span class="font-mono tracking-widest text-[11px]">${s.id}</span>`)}
                ${infoCell('Full Name', escHtml(s.name) || '—')}
                ${infoCell('Date of Birth', escHtml(s.dob) || '—')}
                ${infoCell('Gender', escHtml(s.gender) || '—')}
                ${infoCell('Nationality', escHtml(s.nationality) || '—')}
                ${infoCell('Email', s.email
                    ? `<a href="mailto:${escHtml(s.email)}" class="text-[#2563eb] hover:underline break-all">${escHtml(s.email)}</a>`
                    : '<span class="text-amber-500 font-black text-[11px]">⚠ Not set</span>')}
                ${infoCell('Enrollment Status', statusBadge(s.enrollmentStatus || 'Active'))}
            </div>
        </div>

        <div class="bg-white border border-[#dce3ed] rounded-xl p-5 shadow-sm">
            <div class="flex items-center justify-between mb-3">
                <h4 class="text-[10px] font-bold text-[#6b84a0] uppercase tracking-widest">Parent / Guardian</h4>
                <span class="text-[10px] font-bold text-[#9ab0c6] bg-[#f8fafb] border border-[#dce3ed] px-2 py-0.5 rounded">
                    <i class="fa-solid fa-lock text-[9px] mr-1"></i>Read Only
                </span>
            </div>
            <div class="grid grid-cols-2 gap-2">
                ${infoCell('Parent / Guardian', escHtml(s.parentName) || '—')}
                ${infoCell('Relationship', escHtml(s.parentRelationship) || '—')}
                ${infoCell('Parent Phone', escHtml(s.parentPhone) || '—')}
                ${infoCell('Parent Email', escHtml(s.parentEmail) || '—')}
            </div>
        </div>

        <div class="bg-white border border-[#dce3ed] rounded-xl p-5 shadow-sm">
            <div class="flex items-center justify-between mb-3">
                <h4 class="text-[10px] font-bold text-[#6b84a0] uppercase tracking-widest">Address</h4>
                <span class="text-[10px] font-bold text-[#9ab0c6] bg-[#f8fafb] border border-[#dce3ed] px-2 py-0.5 rounded">
                    <i class="fa-solid fa-lock text-[9px] mr-1"></i>Student-managed
                </span>
            </div>
            <div class="grid grid-cols-2 gap-2">
                ${infoCell('Street Address', escHtml(s.address?.line1) || '—')}
                ${infoCell('Apt / Unit', escHtml(s.address?.line2) || '—')}
                ${infoCell('City / Town', escHtml(s.address?.city) || '—')}
                ${infoCell('District', escHtml(s.address?.district) || '—')}
                ${infoCell('Country', escHtml(s.address?.country) || 'Belize')}
            </div>
        </div>`;
}


// ── 10. ACADEMIC TAB ──────────────────────────────────────────────────────

let _academicGradesCache = [];
let _activeTermForPrint  = { id: null, name: 'Current Term' };

async function renderStudentAcademicTab() {
    const pane = document.getElementById('tab-academic');
    pane.innerHTML = `<div class="flex items-center justify-center py-16">
        <i class="fa-solid fa-spinner fa-spin text-2xl text-[#2563eb]"></i></div>`;

    try {
        // ── Fetch all terms ───────────────────────────────────────────────
        let allTerms   = [];
        let activeTerm = null;
        try {
            const [schoolSnap, termSnap] = await Promise.all([
                getDoc(doc(db, 'schools', session.schoolId)),
                getDocs(collection(db, 'schools', session.schoolId, 'semesters'))
            ]);
            
            const activeSemId = schoolSnap.exists() ? schoolSnap.data().activeSemesterId : null;
            
            allTerms = termSnap.docs.map(d => ({ 
                id: d.id, 
                ...d.data(),
                isActive: d.id === activeSemId 
            }));
            
            allTerms.sort((a, b) => {
                if (a.isActive && !b.isActive) return -1;
                if (!a.isActive && b.isActive) return 1;
                return (a.order || 0) - (b.order || 0);
            });
            
            activeTerm = allTerms.find(t => t.isActive) || null;
        } catch (error) {
            // Log the error so it is never hidden again
            console.error('[Students] Error loading and sorting terms:', error);
        }

        _activeTermForPrint = { id: activeTerm?.id || null, name: activeTerm?.name || 'Current Term' };

        // ── Fetch all grades once ─────────────────────────────────────────
        _academicGradesCache = [];
        let gradesSnap = await getDocs(collection(db, 'students', currentStudentId, 'grades'));
        if (gradesSnap.empty) {
            gradesSnap = await getDocs(
                collection(db, 'schools', session.schoolId, 'students', currentStudentId, 'grades')
            );
        }
        gradesSnap.forEach(d => _academicGradesCache.push({ id: d.id, ...d.data() }));

        // ── Past terms dropdown (excludes active) ─────────────────────────
        const pastTerms = allTerms.filter(t => !t.isActive);
        const pastOptions = pastTerms.map(t =>
            `<option value="${t.id}">${escHtml(t.name)}</option>`
        ).join('');

        pane.innerHTML = `
            <div class="bg-[#0d1f35] rounded-xl p-5 mb-4 flex items-center justify-between">
                <div>
                    <p class="text-[10px] font-bold text-[#6b84a0] uppercase tracking-widest mb-0.5">Current Term</p>
                    <p class="font-black text-white text-[19px]">${escHtml(activeTerm?.name || 'No Active Term')}</p>
                </div>
                <div class="flex items-center gap-2">
                    <button onclick="window.openAdminAddGradeModal()"
                        class="flex items-center gap-1.5 bg-[#2563eb] hover:bg-[#1d4ed8] text-white font-bold px-4 py-2.5 rounded-lg text-[11px] transition border border-[#1e40af] flex-shrink-0">
                        <i class="fa-solid fa-plus mr-1"></i> Add Grade
                    </button>
                    <button onclick="window.printTermTranscript('${activeTerm?.id || ''}', '${escHtml(activeTerm?.name || 'Current Term')}')"
                        class="flex items-center gap-1.5 bg-white/10 hover:bg-white/20 text-white font-bold px-4 py-2.5 rounded-lg text-[11px] transition border border-white/20 flex-shrink-0">
                        <i class="fa-solid fa-print mr-1"></i> Print Transcript
                    </button>
                </div>
            </div>

            ${pastTerms.length ? `
            <div class="flex items-center gap-3 mb-5 bg-white border border-[#dce3ed] rounded-xl p-3">
                <p class="text-[11px] font-bold text-[#6b84a0] whitespace-nowrap flex-shrink-0">
                    <i class="fa-solid fa-clock-rotate-left mr-1"></i> View past term:
                </p>
                <select id="academicTermSelect"
                    class="form-input flex-1 p-2 bg-[#f4f7fb] border border-[#dce3ed] rounded text-[12px] font-bold text-[#0d1f35] outline-none focus:border-[#2563eb]">
                    <option value="${activeTerm?.id || ''}">— Select a past term —</option>
                    <option value="all">All Terms</option>
                    ${pastOptions}
                </select>
            </div>` : ''}

            <div id="academicGradesArea" class="space-y-3"></div>`;

        // Wire past term selector
        if (pastTerms.length) {
            document.getElementById('academicTermSelect').addEventListener('change', function () {
                const val  = this.value;
                const term = val === 'all' ? null : allTerms.find(t => t.id === val) || activeTerm;
                _activeTermForPrint = {
                    id:   val === 'all' ? null : val,
                    name: val === 'all' ? 'All Terms' : (term?.name || 'Term')
                };
                renderGradesForTerm(val === 'all' ? null : val, val === 'all', term?.name || 'Term');
            });
        }

        // Render current term grades (collapsed by default)
        renderGradesForTerm(activeTerm?.id || null, false, activeTerm?.name || 'Current Term', false);

    } catch (e) {
        console.error('[Students] academicTab:', e);
        pane.innerHTML = `<div class="text-center py-16 text-[#e31b4a] font-semibold">Error loading academic records.</div>`;
    }
}

// autoExpand=true for current term, false for past terms
function renderGradesForTerm(termId, allTerms = false, termName = 'Term', autoExpand = false) {
    const area = document.getElementById('academicGradesArea');
    if (!area) return;

    const grades = allTerms
        ? _academicGradesCache
        : termId
            ? _academicGradesCache.filter(g => (g.termId || '') === termId || (g.semesterId || '') === termId)
            : _academicGradesCache.filter(g => !g.termId || g.termId === ''); // fallback

    if (!grades.length) {
        area.innerHTML = `
            <div class="text-center py-16 text-[#9ab0c6]">
                <i class="fa-solid fa-folder-open text-4xl mb-3 block"></i>
                <p class="italic font-semibold text-[13px]">No grades recorded for ${escHtml(termName)}.</p>
            </div>`;
        return;
    }

    const calcLg = (avg) => avg >= 90 ? 'A' : avg >= 80 ? 'B' : avg >= 70 ? 'C' : avg >= 60 ? 'D' : 'F';

    // Group by subject
    const bySubject = {};
    grades.forEach(g => {
        const subj = g.subject || 'Uncategorized';
        if (!bySubject[subj]) bySubject[subj] = [];
        bySubject[subj].push(g);
    });

    const gradeTypes = getTeacherGradeTypes(currentStudentData?.teacherId);

    area.innerHTML = Object.entries(bySubject).map(([subject, sGrades]) => {
        const avg      = calculateWeightedAverage(sGrades, gradeTypes);
        const avgRound = avg;
        const lg       = typeof letterGrade === 'function' ? letterGrade(avgRound) : calcLg(avgRound);
        const avgClass = avg >= 75 ? 'text-green-600 bg-green-50 border-green-200'
                       : avg >= 60 ? 'text-amber-600 bg-amber-50 border-amber-200'
                       : 'text-red-600 bg-red-50 border-red-200';

        // Group by grade type
        const byType = {};
        sGrades.forEach(g => {
            const t = g.type || 'Assessment';
            if (!byType[t]) byType[t] = [];
            byType[t].push(g);
        });

        const typeRows = Object.entries(byType).map(([type, tGrades]) => {
            const typeAvg = Math.round(tGrades.reduce((a, g) => a + (g.max ? (g.score / g.max) * 100 : 0), 0) / tGrades.length);
            const tColor  = typeAvg >= 75 ? '#16a34a' : typeAvg >= 60 ? '#d97706' : '#dc2626';

            const gradeRows = tGrades.map(g => {
                const pct    = g.max ? Math.round((g.score / g.max) * 100) : null;
                const pColor = pct == null ? '#374f6b' : pct >= 75 ? '#16a34a' : pct >= 60 ? '#d97706' : '#dc2626';
                
                const adminBadge = g.enteredByAdmin ? `<span class="inline-block ml-2 text-[9px] font-bold text-[#2563eb] bg-[#eff6ff] border border-[#bfdbfe] px-1.5 py-0.5 rounded">Admin: ${escHtml(g.adminName)}</span>` : '';
                const reasonText = g.changeReason ? `<p class="text-[10px] text-amber-700 font-semibold mt-1 bg-amber-50 p-1.5 rounded border border-amber-100">Reason: ${escHtml(g.changeReason)}</p>` : '';
                
                // Strict Ownership Edit Pencil
                const editBtn = (g.adminId && g.adminId === session.uid)
                    ? `<button onclick="window.openAdminEditGradeModal('${g.id}')" class="text-[10px] text-[#9ab0c6] hover:text-[#2563eb] transition ml-3" title="Edit your entry"><i class="fa-solid fa-pen"></i></button>`
                    : '';

                return `
                    <div class="flex items-start justify-between py-2.5 border-b border-[#f0f4f8] last:border-0">
                        <div class="flex-1 min-w-0 mr-3">
                            <div class="flex items-center">
                                <p class="font-semibold text-[12px] text-[#0d1f35] truncate">${escHtml(g.title || 'Assessment')}</p>
                                ${adminBadge}
                                ${editBtn}
                            </div>
                            <p class="text-[10px] text-[#9ab0c6] font-semibold mt-0.5">${g.date || '—'}</p>
                            ${g.comments ? `<p class="text-[11px] text-[#6b84a0] italic mt-1 leading-snug">"${escHtml(g.comments)}"</p>` : ''}
                            ${reasonText}
                        </div>
                        <div class="text-right flex-shrink-0">
                            <p class="font-black text-[13px]" style="color:${pColor}">${g.score}/${g.max || '?'}</p>
                            ${pct != null ? `<p class="text-[10px] font-bold" style="color:${pColor}">${pct}%</p>` : ''}
                        </div>
                    </div>`;
            }).join('');

            return `
                <div class="mb-3 last:mb-0">
                    <div class="flex items-center justify-between mb-2 px-1">
                        <p class="text-[10px] font-black text-[#6b84a0] uppercase tracking-widest">
                            ${escHtml(type)} <span class="text-[#9ab0c6]">(${tGrades.length})</span>
                        </p>
                        <p class="text-[11px] font-black" style="color:${tColor}">${typeAvg}% avg</p>
                    </div>
                    <div class="bg-white border border-[#dce3ed] rounded-lg px-4">${gradeRows}</div>
                </div>`;
        }).join('');

        // Encode subject for onclick (safe)
        const safeSubject = encodeURIComponent(subject);
        const safeTerm    = encodeURIComponent(termName);

        return `
            <div class="bg-white border border-[#dce3ed] rounded-xl overflow-hidden shadow-sm">
                <div class="flex items-center justify-between px-5 py-4 cursor-pointer hover:bg-[#f8fafb] transition"
                    onclick="window.toggleSubjectAccordion(this)">
                    <div class="flex items-center gap-3">
                        <div class="w-9 h-9 bg-[#0d1f35] text-white rounded-lg flex items-center justify-center font-black text-xs flex-shrink-0">
                            ${subject.charAt(0).toUpperCase()}
                        </div>
                        <div>
                            <p class="font-black text-[#0d1f35] text-[13px]">${escHtml(subject)}</p>
                            <p class="text-[10px] text-[#9ab0c6] font-semibold">${sGrades.length} assessment${sGrades.length !== 1 ? 's' : ''}</p>
                        </div>
                    </div>
                    <div class="flex items-center gap-2">
                        <span class="px-2.5 py-1 rounded-lg border font-black text-[11px] ${avgClass}">${avgRound}% · ${lg}</span>
                        <i class="fa-solid fa-chevron-down text-[#c5d0db] transition-transform ${autoExpand ? 'rotate-180' : ''}"></i>
                    </div>
                </div>
                <div class="subject-body ${autoExpand ? 'open' : ''}">
                    <div class="px-5 pb-4 pt-3 bg-[#f8fafb] border-t border-[#f0f4f8]">
                        <div class="flex justify-end mb-3">
                            <button onclick="event.stopPropagation(); window.printSubjectReport('${safeSubject}', '${safeTerm}')"
                                class="flex items-center gap-1.5 bg-white hover:bg-[#f4f7fb] text-[#374f6b] font-bold px-3 py-1.5 rounded text-[11px] border border-[#dce3ed] transition">
                                <i class="fa-solid fa-print text-[10px]"></i> Print Subject Report
                            </button>
                        </div>
                        ${typeRows}
                    </div>
                </div>
            </div>`;
    }).join('');
}


// ── NEW: Admin Add Grade Modal Functions ───────────────────────────────────────────
window.openAdminAddGradeModal = () => {
    const s = currentStudentData;
    if (!s || !s.teacherId) {
        alert("Student must be assigned to a teacher to add a grade. The teacher's grading rubric is required.");
        return;
    }
    if (!s.className) {
        alert("Student must be assigned to a class to add a grade.");
        return;
    }

    const msgEl = document.getElementById('agAddMsg');
    if (msgEl) msgEl.classList.add('hidden');

    // Populate types dynamically based on the assigned teacher
    const types = getTeacherGradeTypes(s.teacherId);
    const typeSel = document.getElementById('agAddType');
    if (typeSel) {
        typeSel.innerHTML = '<option value="">Select type...</option>' + types.map(t => {
            const name = t.name || t;
            const weight = t.weight ? ` (${t.weight}%)` : '';
            return `<option value="${name}">${name}${weight}</option>`;
        }).join('');
    }
    
    // Populate subjects dynamically based on the assigned teacher
    const t = allTeachersCache.find(x => x.id === s.teacherId);
    const subjects = t?.subjects || [];
    const subjSel = document.getElementById('agAddSubject');
    if (subjSel) {
        subjSel.innerHTML = '<option value="">Select subject...</option>' + subjects.filter(sub => !sub.archived).map(sub => {
            return `<option value="${escHtml(sub.name)}">${escHtml(sub.name)}</option>`;
        }).join('');
    }

    // Reset fields
    const dEl = document.getElementById('agAddDate');
    if(dEl) dEl.valueAsDate = new Date();
    
    ['agAddTitle', 'agAddScore'].forEach(id => {
        const el = document.getElementById(id);
        if(el) el.value = '';
    });
    
    const mEl = document.getElementById('agAddMax');
    if(mEl) mEl.value = '100';
    
    const nEl = document.getElementById('agAddNotes');
    if(nEl) nEl.value = '';

    openOverlay('adminAddGradeModal', 'adminAddGradeModalInner');
};

window.closeAdminAddGradeModal = () => closeOverlay('adminAddGradeModal', 'adminAddGradeModalInner');

window.saveAdminAddGrade = async () => {
    const subject = document.getElementById('agAddSubject')?.value;
    const type = document.getElementById('agAddType')?.value;
    const title = document.getElementById('agAddTitle')?.value.trim();
    const score = parseFloat(document.getElementById('agAddScore')?.value);
    const max = parseFloat(document.getElementById('agAddMax')?.value);
    const date = document.getElementById('agAddDate')?.value;
    const notes = document.getElementById('agAddNotes')?.value.trim();

    const msgEl = document.getElementById('agAddMsg');
    const showErr = (msg) => { if(msgEl){ msgEl.textContent = msg; msgEl.classList.remove('hidden'); } else alert(msg); };

    if (!subject || !type || !title || isNaN(score) || isNaN(max) || !date) {
        showErr('Please fill in all required fields correctly.');
        return;
    }

    const btn = document.getElementById('saveAdminAddGradeBtn');
    if (btn) { btn.innerHTML = '<i class="fa-solid fa-spinner fa-spin mr-1"></i> Saving...'; btn.disabled = true; }

    try {
        const termSel = document.getElementById('academicTermSelect');
        let semId = termSel ? termSel.value : null;
        if (!semId || semId === 'all') {
            // Fallback to active term if filtering by 'all' or undefined
            try {
                const schoolSnap = await getDoc(doc(db, 'schools', session.schoolId));
                if (schoolSnap.exists() && schoolSnap.data().activeSemesterId) {
                    semId = schoolSnap.data().activeSemesterId;
                }
            } catch(e) {}
        }

        const adminDisplayName = session.isSuperAdmin ? (session.schoolName || 'Super Admin') : (session.adminName || 'Sub-Admin');

        await addDoc(collection(db, 'students', currentStudentId, 'grades'), {
            schoolId:        session.schoolId,
            teacherId:       currentStudentData.teacherId,  
            semesterId:      semId || '',
            subject,
            type,
            date,
            title,
            score,
            max,
            notes:           notes ? `[Admin] ${notes}` : '',
            historyLogs:     [],
            createdAt:       new Date().toISOString(),
            enteredByAdmin:  true,
            adminId:         session.adminId || session.schoolId,
            adminName:       adminDisplayName,
            adminRole:       session.isSuperAdmin ? 'super_admin' : 'sub_admin'
        });

        window.closeAdminAddGradeModal();
        renderStudentAcademicTab(); // Refresh the tab to show the new grade
    } catch (e) {
        console.error('[Admin] saveAddGrade:', e);
        showErr('Error saving grade. Please try again.');
    }

    if (btn) { btn.innerHTML = '<i class="fa-solid fa-floppy-disk mr-1"></i> Save Grade'; btn.disabled = false; }
};


// ── Admin Grade Edit Modal Functions ───────────────────────────────────────────
window.openAdminEditGradeModal = (gradeId) => {
    const msgEl = document.getElementById('agEditMsg');
    msgEl.classList.add('hidden');

    const g = _academicGradesCache.find(x => x.id === gradeId);
    if (!g || g.adminId !== session.uid) return; // Strict ownership check

    document.getElementById('agEditGradeId').value = g.id;
    document.getElementById('agEditSubject').value = g.subject || '';
    document.getElementById('agEditType').value = g.type || 'Assessment';
    document.getElementById('agEditTitle').value = g.title || '';
    document.getElementById('agEditScore').value = g.score || '';
    document.getElementById('agEditMax').value = g.max || '100';
    document.getElementById('agEditDate').value = g.date || '';
    document.getElementById('agEditNotes').value = g.comments || g.notes || '';
    document.getElementById('agEditReason').value = ''; // Force new reason

    openOverlay('adminEditGradeModal', 'adminEditGradeModalInner');
};

window.closeAdminEditGradeModal = () => closeOverlay('adminEditGradeModal', 'adminEditGradeModalInner');

window.saveAdminEditGrade = async () => {
    const gradeId = document.getElementById('agEditGradeId').value;
    const score = parseFloat(document.getElementById('agEditScore').value);
    const max = parseFloat(document.getElementById('agEditMax').value);
    const date = document.getElementById('agEditDate').value;
    const notes = document.getElementById('agEditNotes').value.trim();
    const reason = document.getElementById('agEditReason').value.trim();

    const msgEl = document.getElementById('agEditMsg');

    if (isNaN(score) || isNaN(max) || !date) {
        msgEl.textContent = 'Score, Max, and Date are required.';
        msgEl.classList.remove('hidden');
        return;
    }
    if (!reason) {
        msgEl.textContent = 'You must provide a reason for editing this grade.';
        msgEl.classList.remove('hidden');
        return;
    }

    const btn = document.getElementById('saveAdminEditGradeBtn');
    btn.innerHTML = '<i class="fa-solid fa-spinner fa-spin mr-1"></i> Saving...';
    btn.disabled = true;

    try {
        const g = _academicGradesCache.find(x => x.id === gradeId);
        const historyEntry = {
            dateChanged: new Date().toISOString(),
            adminId: session.uid,
            adminName: session.name,
            oldScore: g.score,
            oldMax: g.max,
            oldDate: g.date,
            newScore: score,
            newMax: max,
            note: reason // The mandatory reason
        };

        await updateDoc(doc(db, 'students', currentStudentId, 'grades', gradeId), {
            score, max, date, comments: notes, changeReason: reason,
            historyLogs: arrayUnion(historyEntry)
        });

        window.closeAdminEditGradeModal();
        renderStudentAcademicTab(); // Refresh tab
    } catch (e) {
        console.error('[Admin] saveEditGrade:', e);
        msgEl.textContent = 'Error saving grade. Please try again.';
        msgEl.classList.remove('hidden');
    }

    btn.innerHTML = '<i class="fa-solid fa-floppy-disk mr-1"></i> Save Changes';
    btn.disabled = false;
};


// ── Print Functions ───────────────────────────────────────────────────────
window.printTermTranscript = (termId, termName) => {
    const grades = termId
        ? _academicGradesCache.filter(g => (g.termId || '') === termId || (g.semesterId || '') === termId)
        : _academicGradesCache;
    const s         = currentStudentData;
    const school    = session.schoolName || session.schoolId || 'School';
    const calcLg    = (avg) => avg >= 90 ? 'A' : avg >= 80 ? 'B' : avg >= 70 ? 'C' : avg >= 60 ? 'D' : 'F';

    const bySubject = {};
    grades.forEach(g => {
        const subj = g.subject || 'Uncategorized';
        if (!bySubject[subj]) bySubject[subj] = [];
        bySubject[subj].push(g);
    });

    const gradeTypes = getTeacherGradeTypes(s?.teacherId);

    const tableRows = Object.entries(bySubject).map(([sub, sg]) => {
        const avg  = calculateWeightedAverage(sg, gradeTypes);
        const col  = avg >= 75 ? '#16a34a' : avg >= 60 ? '#d97706' : '#dc2626';
        return `<tr>
            <td style="border:1px solid #e2e8f0;padding:10px 15px;">${sub}</td>
            <td style="border:1px solid #e2e8f0;padding:10px 15px;text-align:center;">${sg.length}</td>
            <td style="border:1px solid #e2e8f0;padding:10px 15px;text-align:center;font-weight:700;color:${col}">${avg}%</td>
            <td style="border:1px solid #e2e8f0;padding:10px 15px;text-align:center;font-weight:700;">${calcLg(avg)}</td>
        </tr>`;
    }).join('');

    const subjectAvgs = Object.values(bySubject).map(sg => calculateWeightedAverage(sg, gradeTypes));
    const allAvg = subjectAvgs.length ? Math.round(subjectAvgs.reduce((a, b) => a + b, 0) / subjectAvgs.length) : 0;

    const w = window.open('', '_blank');
    w.document.write(`<!DOCTYPE html><html><head><title>${termName} Transcript — ${s?.name}</title>
    <style>
        *{box-sizing:border-box;margin:0;padding:0}
        body{font-family:'Helvetica Neue',Arial,sans-serif;padding:48px 40px;color:#1e293b;line-height:1.5;font-size:13px}
        .header{display:flex;justify-content:space-between;align-items:flex-start;border-bottom:3px solid #0d1f35;padding-bottom:18px;margin-bottom:24px}
        .school-name{font-size:20px;font-weight:900;text-transform:uppercase;color:#0d1f35}
        .doc-type{font-size:11px;font-weight:700;color:#6b84a0;letter-spacing:0.12em;text-transform:uppercase;margin-top:3px}
        .info-grid{display:grid;grid-template-columns:1fr 1fr 1fr;gap:10px;margin-bottom:24px;background:#f8fafc;padding:16px;border-radius:8px;border:1px solid #e2e8f0}
        .info-item label{display:block;font-size:9px;text-transform:uppercase;letter-spacing:0.1em;color:#64748b;font-weight:700;margin-bottom:2px}
        .info-item span{font-size:13px;font-weight:700;color:#0f172a}
        .term-header{background:#0d1f35;color:white;padding:10px 16px;border-radius:6px;font-size:13px;font-weight:900;letter-spacing:0.05em;text-transform:uppercase;margin-bottom:14px}
        table{width:100%;border-collapse:collapse;margin-bottom:20px}
        thead tr{background:#f1f5f9}
        th{border:1px solid #e2e8f0;padding:10px 15px;text-align:left;font-size:11px;font-weight:700;text-transform:uppercase;letter-spacing:0.06em;color:#64748b}
        .total-row{background:#f8fafc;font-weight:700}
        .footer{margin-top:40px;text-align:center;font-size:10px;color:#94a3b8;border-top:1px solid #e2e8f0;padding-top:14px}
        .watermark{text-align:center;font-size:12px;font-weight:900;letter-spacing:0.15em;color:#dc2626;border:2px dashed #fca5a5;background:#fef2f2;padding:10px;margin-bottom:20px;text-transform:uppercase;}
        .header-block { text-align: center; margin-bottom: 24px; border-bottom: 3px solid #0d1f35; padding-bottom: 18px; }
        .print-meta { font-size: 11px; color: #64748b; margin-top: 5px; font-weight: 700; }
    </style></head><body>
    <div style="text-align: center; margin-bottom: 15px;">
        <img src="${session.logo || ''}" alt="${escHtml(school)}" onerror="this.style.display='none'" style="max-height:80px; object-fit:contain;">
    </div>
    <div class="watermark">Unofficial Transcript — Internal Record Only</div>
    <div class="header-block">
        <div class="school-name">${escHtml(school)}</div>
        <div class="print-meta">${escHtml(termName)} · Printed ${new Date().toLocaleDateString('en-US',{month:'long',day:'numeric',year:'numeric'})}</div>
    </div>
    <div class="info-grid">
        <div class="info-item"><label>Student Name</label><span>${escHtml(s?.name || '—')}</span></div>
        <div class="info-item"><label>Global Student ID</label><span style="font-family:monospace">${escHtml(s?.id || '—')}</span></div>
        <div class="info-item"><label>Class</label><span>${escHtml(s?.className || 'Unassigned')}</span></div>
        <div class="info-item"><label>Date of Birth</label><span>${escHtml(s?.dob || '—')}</span></div>
        <div class="info-item"><label>Enrollment Status</label><span>${escHtml(s?.enrollmentStatus || 'Active')}</span></div>
        <div class="info-item"><label>Parent / Guardian</label><span>${escHtml(s?.parentName || '—')}</span></div>
    </div>
    <div class="term-header">${escHtml(termName)}</div>
    <table>
        <thead><tr>
            <th>Subject</th><th style="text-align:center">Assessments</th>
            <th style="text-align:center">Average</th><th style="text-align:center">Grade</th>
        </tr></thead>
        <tbody>
            ${tableRows}
            <tr class="total-row">
                <td colspan="2" style="border:1px solid #e2e8f0;padding:10px 15px;text-align:right;font-size:12px">OVERALL AVERAGE</td>
                <td style="border:1px solid #e2e8f0;padding:10px 15px;text-align:center;font-weight:900;color:${allAvg>=75?'#16a34a':allAvg>=60?'#d97706':'#dc2626'}">${allAvg}%</td>
                <td style="border:1px solid #e2e8f0;padding:10px 15px;text-align:center;font-weight:900">${calcLg(allAvg)}</td>
            </tr>
        </tbody>
    </table>
    <div class="footer" style="display:flex; flex-direction:column; align-items:center; gap:8px;">
        <span>Issued by ${escHtml(school)} · ${new Date().toLocaleDateString()}</span>
        <div style="display:flex; justify-content:center; align-items:center; gap:8px; margin-top:5px;">
            <img src="../../assets/images/logo.png" style="max-height:16px; opacity:0.8;">
            <span style="font-weight:bold; color:#0d1f35;">Powered by ConnectUs</span>
        </div>
    </div>
    </body></html>`);
    w.document.close();
    setTimeout(() => w.print(), 400);
};

window.printSubjectReport = (safeSubject, safeTerm) => {
    const subject  = decodeURIComponent(safeSubject);
    const termName = decodeURIComponent(safeTerm);
    const s        = currentStudentData;
    const school   = session.schoolName || session.schoolId || 'School';
    const calcLg   = (avg) => avg >= 90 ? 'A' : avg >= 80 ? 'B' : avg >= 70 ? 'C' : avg >= 60 ? 'D' : 'F';

    const termGrades = _activeTermForPrint.id
        ? _academicGradesCache.filter(g => (g.termId || '') === _activeTermForPrint.id || (g.semesterId || '') === _activeTermForPrint.id)
        : _academicGradesCache;
    const grades = termGrades.filter(g => (g.subject || 'Uncategorized') === subject);

    if (!grades.length) { alert('No grades found for this subject.'); return; }

    const byType = {};
    grades.forEach(g => {
        const t = g.type || 'Assessment';
        if (!byType[t]) byType[t] = [];
        byType[t].push(g);
    });

    const typeBlocks = Object.entries(byType).map(([type, tg]) => {
        const typeAvg = Math.round(tg.reduce((a, g) => a + (g.max ? (g.score/g.max)*100 : 0), 0) / tg.length);
        const rows = tg.map(g => {
            const pct = g.max ? Math.round((g.score/g.max)*100) : null;
            const col = pct == null ? '#374f6b' : pct >= 75 ? '#16a34a' : pct >= 60 ? '#d97706' : '#dc2626';
            return `<tr>
                <td style="border:1px solid #e2e8f0;padding:9px 14px">${escHtml(g.title||'Assessment')}</td>
                <td style="border:1px solid #e2e8f0;padding:9px 14px;text-align:center">${g.date||'—'}</td>
                <td style="border:1px solid #e2e8f0;padding:9px 14px;text-align:center;font-weight:700;color:${col}">${g.score}/${g.max||'?'}</td>
                <td style="border:1px solid #e2e8f0;padding:9px 14px;text-align:center;font-weight:700;color:${col}">${pct!=null?pct+'%':'—'}</td>
                <td style="border:1px solid #e2e8f0;padding:9px 14px;font-size:11px;color:#64748b;font-style:italic">${escHtml(g.comments||'')}</td>
            </tr>`;
        }).join('');
        return `<h4 style="font-size:12px;font-weight:700;color:#64748b;text-transform:uppercase;letter-spacing:0.08em;margin:16px 0 8px">${type} <span style="font-weight:500;color:#94a3b8">(avg: ${typeAvg}%)</span></h4>
        <table style="width:100%;border-collapse:collapse;font-size:12px;margin-bottom:8px">
            <thead><tr style="background:#f8fafc"><th style="border:1px solid #e2e8f0;padding:8px 14px;text-align:left">Title</th><th style="border:1px solid #e2e8f0;padding:8px 14px;text-align:center">Date</th><th style="border:1px solid #e2e8f0;padding:8px 14px;text-align:center">Score</th><th style="border:1px solid #e2e8f0;padding:8px 14px;text-align:center">%</th><th style="border:1px solid #e2e8f0;padding:8px 14px;text-align:left">Teacher Comments</th></tr></thead>
            <tbody>${rows}</tbody>
        </table>`;
    }).join('');

    const gradeTypes = getTeacherGradeTypes(s?.teacherId);
    const overall = calculateWeightedAverage(grades, gradeTypes);

    const w = window.open('', '_blank');
    w.document.write(`<!DOCTYPE html><html><head><title>${subject} Report — ${s?.name}</title>
    <style>*{box-sizing:border-box;margin:0;padding:0}body{font-family:'Helvetica Neue',Arial,sans-serif;padding:48px 40px;color:#1e293b;line-height:1.5}
    .header{display:flex;justify-content:space-between;align-items:flex-start;border-bottom:3px solid #0d1f35;padding-bottom:18px;margin-bottom:24px}
    .school-name{font-size:20px;font-weight:900;text-transform:uppercase;color:#0d1f35}.doc-type{font-size:11px;font-weight:700;color:#6b84a0;letter-spacing:0.12em;text-transform:uppercase;margin-top:3px}
    .summary{background:#f8fafc;border:1px solid #e2e8f0;border-radius:8px;padding:14px 18px;margin-bottom:24px;display:flex;justify-content:space-between;align-items:center}
    .footer{margin-top:40px;text-align:center;font-size:10px;color:#94a3b8;border-top:1px solid #e2e8f0;padding-top:14px}
    .watermark{text-align:center;font-size:12px;font-weight:900;letter-spacing:0.15em;color:#dc2626;border:2px dashed #fca5a5;background:#fef2f2;padding:10px;margin-bottom:20px;text-transform:uppercase;}
    .header-block { text-align: center; margin-bottom: 24px; border-bottom: 3px solid #0d1f35; padding-bottom: 18px; }
    .print-meta { font-size: 11px; color: #64748b; margin-top: 5px; font-weight: 700; }
    </style></head><body>
    <div style="text-align: center; margin-bottom: 15px;">
        <img src="${session.logo || ''}" alt="${escHtml(school)}" onerror="this.style.display='none'" style="max-height:80px; object-fit:contain;">
    </div>
    <div class="watermark">Unofficial Transcript — Internal Record Only</div>
    <div class="header-block">
        <div class="school-name">${escHtml(school)}</div>
        <div class="print-meta">${escHtml(termName)} · Printed ${new Date().toLocaleDateString('en-US',{month:'long',day:'numeric',year:'numeric'})}</div>
    </div>
    <div class="summary">
        <div><div style="font-size:11px;font-weight:700;color:#64748b;text-transform:uppercase;letter-spacing:0.08em;margin-bottom:2px">Student</div><div style="font-size:15px;font-weight:900;color:#0d1f35">${escHtml(s?.name||'—')}</div><div style="font-size:11px;color:#64748b;font-family:monospace">${escHtml(s?.id||'')}</div></div>
        <div style="text-align:center"><div style="font-size:11px;font-weight:700;color:#64748b;text-transform:uppercase;letter-spacing:0.08em;margin-bottom:2px">Subject</div><div style="font-size:17px;font-weight:900;color:#0d1f35">${escHtml(subject)}</div></div>
        <div style="text-align:right"><div style="font-size:11px;font-weight:700;color:#64748b;text-transform:uppercase;letter-spacing:0.08em;margin-bottom:2px">Overall</div><div style="font-size:26px;font-weight:900;color:${overall>=75?'#16a34a':overall>=60?'#d97706':'#dc2626'}">${overall}% · ${calcLg(overall)}</div></div>
    </div>
    ${typeBlocks}
    <div class="footer" style="display:flex; flex-direction:column; align-items:center; gap:8px;">
        <span>Issued by ${escHtml(school)} · ${new Date().toLocaleDateString()}</span>
        <div style="display:flex; justify-content:center; align-items:center; gap:8px; margin-top:5px;">
            <img src="../../assets/images/logo.png" style="max-height:16px; opacity:0.8;">
            <span style="font-weight:bold; color:#0d1f35;">Powered by ConnectUs</span>
        </div>
    </div>
    </body></html>`);
    w.document.close();
    setTimeout(() => w.print(), 400);
};

window.toggleSubjectAccordion = (header) => {
    const body    = header.nextElementSibling;
    const chevron = header.querySelector('.fa-chevron-down');
    body.classList.toggle('open');
    if (chevron) chevron.style.transform = body.classList.contains('open') ? 'rotate(180deg)' : 'rotate(0deg)';
};


// ── 11. HISTORY TAB ───────────────────────────────────────────────────────
function renderStudentHistoryTab() {
    const s    = currentStudentData;
    if (!s) return;
    const pane = document.getElementById('tab-history');
    const history = s.academicHistory || [];

    if (!history.length) {
        pane.innerHTML = `<div class="text-center py-16 text-[#9ab0c6] italic font-semibold text-[13px]">
            No academic history recorded. This may be the student's first school.
        </div>`;
        return;
    }

    pane.innerHTML = `
        <div class="mb-4">
            <p class="text-[10px] font-bold text-[#6b84a0] uppercase tracking-widest mb-1">Academic History</p>
            <p class="text-[11px] text-[#9ab0c6] font-semibold">Showing all previous schools and enrollment records.</p>
        </div>
        <div class="space-y-3">
            ${history.map((h, i) => {
                const dateStr = h.leftAt
                    ? new Date(h.leftAt).toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' })
                    : '—';
                const isCurrentSchool = h.schoolId === session.schoolId;
                return `
                    <div class="bg-white border border-[#dce3ed] rounded-xl p-5 ${isCurrentSchool ? 'border-[#c7d9fd]' : ''}">
                        <div class="flex items-start justify-between mb-3">
                            <div>
                                <p class="font-black text-[#0d1f35] text-[13px]">${escHtml(h.schoolName || h.schoolId)}</p>
                                <p class="text-[10px] font-mono text-[#9ab0c6] uppercase mt-0.5">${h.schoolId || '—'}</p>
                            </div>
                            <div class="flex items-center gap-2 flex-shrink-0 ml-3">
                                ${isCurrentSchool
                                    ? `<span class="text-[10px] font-bold text-[#2563eb] bg-[#eef4ff] border border-[#c7d9fd] px-2 py-0.5 rounded">Your School</span>`
                                    : `<span class="text-[10px] font-bold text-[#9ab0c6] bg-[#f8fafb] border border-[#dce3ed] px-2 py-0.5 rounded flex items-center gap-1"><i class="fa-solid fa-lock text-[8px]"></i> Sealed</span>`}
                            </div>
                        </div>
                        <div class="grid grid-cols-3 gap-2">
                            <div class="bg-[#f8fafb] rounded-lg p-2.5 border border-[#f0f4f8]">
                                <p class="text-[9px] font-bold text-[#9ab0c6] uppercase tracking-widest mb-0.5">Class</p>
                                <p class="font-bold text-[#0d1f35] text-[12px]">${escHtml(h.className) || '—'}</p>
                            </div>
                            <div class="bg-[#f8fafb] rounded-lg p-2.5 border border-[#f0f4f8]">
                                <p class="text-[9px] font-bold text-[#9ab0c6] uppercase tracking-widest mb-0.5">Left</p>
                                <p class="font-bold text-[#0d1f35] text-[12px]">${dateStr}</p>
                            </div>
                            <div class="bg-[#f8fafb] rounded-lg p-2.5 border border-[#f0f4f8]">
                                <p class="text-[9px] font-bold text-[#9ab0c6] uppercase tracking-widest mb-0.5">Reason</p>
                                <p class="font-bold text-[#0d1f35] text-[12px]">${escHtml(h.reason) || '—'}</p>
                            </div>
                        </div>
                        ${!isCurrentSchool ? `
                            <div class="mt-3 flex items-center gap-2 bg-[#f8fafb] rounded-lg p-3 border border-[#f0f4f8]">
                                <i class="fa-solid fa-lock text-[#c5d0db] text-sm"></i>
                                <p class="text-[11px] text-[#9ab0c6] font-semibold italic">Detailed records from this school are sealed. Upgrade to ConnectUs Pro to view full academic history.</p>
                            </div>` : ''}
                    </div>`;
            }).join('')}
        </div>`;
}


// ── 12. ENROLLMENT TAB ────────────────────────────────────────────────────
async function renderStudentEnrollmentTab() {
    const s    = currentStudentData;
    if (!s) return;
    const pane     = document.getElementById('tab-enrollment');
    const isActive = (s.enrollmentStatus || 'Active') === 'Active';

    // ── Check active term to determine if assignment is locked ────────────
    let hasActiveTerm = false;
    let activeTermName = '';
    try {
        const schoolSnap = await getDoc(doc(db, 'schools', session.schoolId));
        const activeSemId = schoolSnap.exists() ? schoolSnap.data().activeSemesterId : null;
        
        if (activeSemId) {
            const semSnap = await getDoc(doc(db, 'schools', session.schoolId, 'semesters', activeSemId));
            if (semSnap.exists()) {
                hasActiveTerm  = true;
                activeTermName = semSnap.data().name || 'the current term';
            }
        }
    } catch (_) {}

    // State Variables
    const isAssigned = !!(s.className && s.teacherId);
    const isLocked   = isActive && hasActiveTerm && isAssigned;

    // Incomplete warning (no class or teacher, active term)
    const noClassOrTeacher = !s.className || !s.teacherId;
    const warning = noClassOrTeacher && isActive ? `
        <div class="bg-amber-50 border border-amber-200 rounded-xl p-4 flex items-start gap-3">
            <i class="fa-solid fa-triangle-exclamation text-amber-500 text-lg mt-0.5 flex-shrink-0"></i>
            <div>
                <p class="font-black text-[13px] text-amber-800">Assignment Incomplete</p>
                <p class="text-[11px] font-semibold text-amber-600 mt-0.5">
                    ${!s.className && !s.teacherId
                        ? 'No class or teacher assigned.'
                        : !s.className ? 'No class assigned.' : 'No teacher assigned.'}
                    <strong>Grades cannot be recorded until both class and teacher are assigned.</strong>
                </p>
            </div>
        </div>` : '';

    pane.innerHTML = `
        ${warning}

        <div class="bg-white border border-[#dce3ed] rounded-xl p-5 shadow-sm">
            <h4 class="text-[10px] font-bold text-[#6b84a0] uppercase tracking-widest mb-3">Enrollment Status</h4>
            <div class="flex items-center gap-3">
                ${statusBadge(s.enrollmentStatus || 'Active')}
                <span class="text-[11px] font-semibold text-[#6b84a0]">
                    Enrolled ${s.createdAt ? 'since ' + new Date(s.createdAt).toLocaleDateString('en-US', { month: 'long', year: 'numeric' }) : ''}
                </span>
            </div>
        </div>

        ${isActive ? `
        <div class="bg-white border border-[#dce3ed] rounded-xl p-5 shadow-sm">
            <div class="flex items-center justify-between mb-4">
                <h4 class="text-[10px] font-bold text-[#6b84a0] uppercase tracking-widest">Class & Teacher Assignment</h4>
                <button onclick="window.attemptEditEnrollment(${isLocked})"
                    class="text-[11px] font-bold text-[#2563eb] bg-[#eef4ff] border border-[#c7d9fd] px-3 py-1.5 rounded hover:bg-[#dbeafe] transition">
                    <i class="fa-solid fa-pen-to-square mr-1"></i> Edit Enrollment
                </button>
            </div>

            <div id="enrollmentStatusDisplay" class="grid grid-cols-2 gap-2">
                ${infoCell('Current Class', escHtml(s.className) || 'Unassigned')}
                ${infoCell('Assigned Teacher', escHtml(allTeachersCache.find(t => t.id === s.teacherId)?.name) || 'Unassigned')}
            </div>

            <div id="enrollmentErrorArea" class="hidden mt-4 bg-red-50 border border-red-200 rounded-lg p-4">
                <div class="flex items-start gap-3">
                    <i class="fa-solid fa-triangle-exclamation text-red-500 mt-0.5"></i>
                    <div>
                        <p class="font-bold text-[12px] text-red-800 mb-1">Action Denied</p>
                        <p class="text-[11px] font-semibold text-red-700 leading-relaxed">
                            This student is actively enrolled in <strong>${escHtml(s.className)}</strong> for <strong>${escHtml(activeTermName)}</strong>. 
                            You cannot arbitrarily change an active class assignment. To prevent gradebook discrepancies, you must formally Transfer or Archive the student to remove them from the roster.
                        </p>
                    </div>
                </div>
            </div>

            <div id="enrollmentEditArea" class="hidden mt-4 pt-4 border-t border-[#f0f4f8]">
                <div class="space-y-3">
                    <div>
                        <label class="block text-[10px] font-bold text-[#6b84a0] uppercase tracking-widest mb-1.5">
                            Assign Class <span class="text-[#e31b4a]">*</span>
                        </label>
                        <select id="enrollClassSelect"
                            class="form-input w-full p-2.5 bg-white border border-[#dce3ed] rounded text-[13px] font-bold text-[#0d1f35] outline-none focus:border-[#2563eb]">
                            <option value="">— Unassigned —</option>
                            ${getClassOptions().map(c => `<option value="${c}" ${s.className === c ? 'selected' : ''}>${c}</option>`).join('')}
                        </select>
                    </div>
                    <div>
                        <label class="block text-[10px] font-bold text-[#6b84a0] uppercase tracking-widest mb-1.5">
                            Assign Teacher <span class="text-[#e31b4a]">*</span>
                        </label>
                        <select id="enrollTeacherSelect"
                            class="form-input w-full p-2.5 bg-white border border-[#dce3ed] rounded text-[13px] font-bold text-[#0d1f35] outline-none focus:border-[#2563eb]">
                            <option value="">— Unassigned —</option>
                            ${allTeachersCache.map(t => `<option value="${t.id}" ${s.teacherId === t.id ? 'selected' : ''}>${escHtml(t.name)}</option>`).join('')}
                        </select>
                        <p class="text-[10px] text-[#9ab0c6] mt-1.5 font-semibold">
                            Class and teacher must always be assigned together.
                        </p>
                    </div>
                    <button onclick="window.saveStudentAssignment()"
                        class="w-full bg-[#2563eb] hover:bg-[#1d4ed8] text-white font-bold py-3 mt-2 rounded transition shadow-md text-[12px] uppercase tracking-widest">
                        <i class="fa-solid fa-floppy-disk mr-1"></i> Save Assignment
                    </button>
                    <p id="assignMsg" class="text-[11px] hidden mt-3 font-bold"></p>
                </div>
            </div>
        </div>` : `
        <div class="bg-[#f8fafb] border border-[#dce3ed] rounded-xl p-5 text-center">
            <i class="fa-solid fa-box-archive text-[#9ab0c6] text-3xl mb-3"></i>
            <p class="font-bold text-[#374f6b] text-[13px]">This student is no longer active.</p>
            <p class="text-[11px] text-[#9ab0c6] font-semibold mt-1">Enrollment actions are unavailable for archived or transferred students.</p>
        </div>`}
    `;

    if (isActive) {
        document.getElementById('enrollClassSelect')?.addEventListener('change', function () {
            window.filterEnrollTeachers(this.value);
        });
    }
}

// Global function to handle Edit click
window.attemptEditEnrollment = (isLocked) => {
    const errorArea   = document.getElementById('enrollmentErrorArea');
    const editArea    = document.getElementById('enrollmentEditArea');
    const displayArea = document.getElementById('enrollmentStatusDisplay');

    if (isLocked) {
        // Enforce the business logic block
        errorArea.classList.remove('hidden');
        editArea.classList.add('hidden');
    } else {
        // Allow the edit
        errorArea.classList.add('hidden');
        displayArea.classList.add('hidden');
        editArea.classList.remove('hidden');
    }
};

window.filterEnrollTeachers = (selectedClass) => {
    const tSelect = document.getElementById('enrollTeacherSelect');
    if (!tSelect) return;
    const current = tSelect.value;
    tSelect.innerHTML = '<option value="">— Unassigned —</option>';
    if (!selectedClass) {
        allTeachersCache.forEach(t => {
            tSelect.innerHTML += `<option value="${t.id}">${escHtml(t.name)}</option>`;
        });
    } else {
        const matches = allTeachersCache.filter(t => t.classes?.includes(selectedClass));
        if (matches.length) {
            matches.forEach(t => { tSelect.innerHTML += `<option value="${t.id}">${escHtml(t.name)}</option>`; });
            if (matches.length === 1) tSelect.value = matches[0].id;
        } else {
            tSelect.innerHTML += '<option value="" disabled>No teacher assigned to this class yet</option>';
        }
    }
    if (current) tSelect.value = current;
};

window.saveStudentAssignment = async () => {
    const className = document.getElementById('enrollClassSelect')?.value || '';
    const teacherId = document.getElementById('enrollTeacherSelect')?.value || '';
    const msgEl     = document.getElementById('assignMsg');
    msgEl.classList.add('hidden');

    const showErr = (html) => {
        msgEl.innerHTML = html;
        msgEl.className = 'text-[11px] mt-3 font-bold text-red-600 bg-red-50 border border-red-200 rounded-lg p-3 leading-relaxed';
        msgEl.classList.remove('hidden');
    };

    if (className && !teacherId) {
        showErr('<i class="fa-solid fa-triangle-exclamation mr-1"></i> A teacher must be assigned with the class.'); return;
    }
    if (!className && teacherId) {
        showErr('<i class="fa-solid fa-triangle-exclamation mr-1"></i> A class must be assigned with the teacher.'); return;
    }

    try {
        await updateDoc(doc(db, 'students', currentStudentId), { className, teacherId });
        if (currentStudentData) { currentStudentData.className = className; currentStudentData.teacherId = teacherId; }
        const idx = allStudentsCache.findIndex(s => s.id === currentStudentId);
        if (idx > -1) {
            allStudentsCache[idx].className   = className;
            allStudentsCache[idx].teacherId   = teacherId;
            allStudentsCache[idx].teacherName = allTeachersCache.find(t => t.id === teacherId)?.name || '—';
        }
        
        // Update billboard header
        const teacherName = allTeachersCache.find(t => t.id === teacherId)?.name || '—';
        const badgeEl = document.getElementById('sPanelClassBadge');
        if (className && teacherId) {
            document.getElementById('sPanelClassText').textContent = `${className} with ${teacherName}`;
            badgeEl.classList.remove('hidden');
        } else {
            badgeEl.classList.add('hidden');
        }

        renderTable();
        msgEl.textContent = 'Assignment saved successfully.';
        msgEl.className   = 'text-[11px] mt-3 font-bold text-green-600';
        msgEl.classList.remove('hidden');
        setTimeout(() => renderStudentEnrollmentTab(), 1500); // Re-render to restore read-only view
        
    } catch (e) {
        console.error('[Students] saveAssignment:', e);
        showErr('Error saving. Please try again.');
    }
};


// ── 13. ARCHIVE / TRANSFER MODAL ─────────────────────────────────────────
window.openArchiveStudentModal = () => {
    document.getElementById('sEnrollDropdown').classList.add('hidden');
    document.getElementById('archiveSName').textContent = currentStudentData?.name || 'this student';
    document.getElementById('sOptArchive').checked     = true;
    document.getElementById('sReleaseReason').value    = '';
    document.getElementById('sArchiveNotes').value     = '';
    window.toggleSArchiveType();
    openOverlay('archiveStudentModal', 'archiveStudentModalInner');
};

window.closeArchiveStudentModal = () => closeOverlay('archiveStudentModal', 'archiveStudentModalInner');

window.toggleSArchiveType = () => {
    const isTransfer = document.getElementById('sOptTransfer').checked;
    document.getElementById('sReleaseFields').classList.toggle('hidden', !isTransfer);
};

document.getElementById('confirmArchiveStudentBtn').addEventListener('click', async () => {
    const isTransfer = document.getElementById('sOptTransfer').checked;
    const reason     = document.getElementById('sReleaseReason').value;
    const notes      = document.getElementById('sArchiveNotes').value.trim();

    if (isTransfer && !reason) {
        alert('Please select a departure reason to release this student.');
        return;
    }

    const btn = document.getElementById('confirmArchiveStudentBtn');
    btn.innerHTML = '<i class="fa-solid fa-spinner fa-spin mr-2"></i>Processing...';
    btn.disabled  = true;

    try {
        const s       = currentStudentData;
        const batch   = writeBatch(db);
        const sRef    = doc(db, 'students', currentStudentId);

        const snapshot = {
            schoolId:   session.schoolId,
            schoolName: session.schoolName || session.schoolId,
            teacherId:  s?.teacherId  || '',
            className:  s?.className  || '',
            leftAt:     new Date().toISOString(),
            reason:     isTransfer ? reason : 'Archived',
            ...(notes ? { notes } : {})
        };

        const updates = {
            enrollmentStatus: isTransfer ? (reason === 'Graduated' ? 'Graduated' : reason === 'Transferred' ? 'Transferred' : 'Archived') : 'Archived',
            currentSchoolId:  isTransfer ? '' : session.schoolId,
            teacherId:        '',
            className:        '',
            academicHistory:  arrayUnion(snapshot)
        };

        batch.update(sRef, updates);
        await batch.commit();

        window.closeArchiveStudentModal();
        window.closeStudentPanel();
        loadStudents();

    } catch (e) {
        console.error('[Students] archive:', e);
        alert('Error processing action. Please try again.');
    }

    btn.innerHTML = '<i class="fa-solid fa-box-archive mr-2"></i> Confirm Action';
    btn.disabled  = false;
});


// ── 14. PRINT STUDENT RECORD ─────────────────────────────────────────────
window.printStudentRecord = async (studentId) => {
    const sDoc = await getDoc(doc(db, 'students', studentId));
    if (!sDoc.exists()) { alert('Student not found.'); return; }
    const s = sDoc.data();

    let gradesSnap = await getDocs(collection(db, 'students', studentId, 'grades'));
    if (gradesSnap.empty) {
        gradesSnap = await getDocs(collection(db, 'schools', session.schoolId, 'students', studentId, 'grades'));
    }

    const grades = [];
    gradesSnap.forEach(d => grades.push(d.data()));

    const bySub = {};
    grades.forEach(g => {
        const sub  = g.subject || 'Uncategorized';
        if (!bySub[sub]) bySub[sub] = [];
        bySub[sub].push(g);
    });

    const lg = (avg) => avg >= 90 ? 'A' : avg >= 80 ? 'B' : avg >= 70 ? 'C' : avg >= 60 ? 'D' : 'F';
    const gradeTypes = getTeacherGradeTypes(s.teacherId);

    const gradesHtml = Object.keys(bySub).length === 0
        ? `<p style="text-align:center;color:#64748b;font-style:italic;padding:40px 0;">No grades recorded.</p>`
        : `<table style="width:100%;border-collapse:collapse;font-size:13px;margin-top:20px;">
            <thead>
                <tr style="background:#f8fafc;">
                    <th style="border:1px solid #e2e8f0;padding:10px 15px;text-align:left;">Subject</th>
                    <th style="border:1px solid #e2e8f0;padding:10px 15px;text-align:center;">Assessments</th>
                    <th style="border:1px solid #e2e8f0;padding:10px 15px;text-align:center;">Average</th>
                    <th style="border:1px solid #e2e8f0;padding:10px 15px;text-align:center;">Grade</th>
                </tr>
            </thead>
            <tbody>
                ${Object.entries(bySub).map(([sub, sg]) => {
                    const avg = calculateWeightedAverage(sg, gradeTypes);
                    return `<tr><td style="border:1px solid #e2e8f0;padding:10px 15px;">${sub}</td>
                        <td style="border:1px solid #e2e8f0;padding:10px 15px;text-align:center;">${sg.length}</td>
                        <td style="border:1px solid #e2e8f0;padding:10px 15px;text-align:center;">${avg}%</td>
                        <td style="border:1px solid #e2e8f0;padding:10px 15px;text-align:center;font-weight:bold;">${lg(avg)}</td></tr>`;
                }).join('')}
            </tbody>
           </table>`;

    const w = window.open('', '_blank');
    w.document.write(`<!DOCTYPE html><html><head><title>Student Record — ${s.name}</title>
    <style>
        body{font-family:'Helvetica Neue',sans-serif;padding:40px;color:#1e293b;line-height:1.5}
        .header{display:flex;justify-content:space-between;align-items:flex-start;border-bottom:3px solid #0d1f35;padding-bottom:18px;margin-bottom:24px}
        .info-grid{display:grid;grid-template-columns:1fr 1fr;gap:12px;margin-bottom:30px;background:#f8fafc;padding:18px;border-radius:8px;border:1px solid #e2e8f0}
        .info-item label{display:block;font-size:10px;text-transform:uppercase;color:#64748b;font-weight:bold;letter-spacing:0.08em}
        .info-item span{font-size:13px;font-weight:bold;color:#0f172a}
        .footer{margin-top:50px;text-align:center;font-size:10px;color:#94a3b8;border-top:1px solid #e2e8f0;padding-top:15px}
        .watermark{text-align:center;font-size:12px;font-weight:900;letter-spacing:0.15em;color:#dc2626;border:2px dashed #fca5a5;background:#fef2f2;padding:10px;margin-bottom:20px;text-transform:uppercase;}
        .header-block { text-align: center; margin-bottom: 24px; border-bottom: 3px solid #0d1f35; padding-bottom: 18px; }
        .school-name{font-size:20px;font-weight:900;text-transform:uppercase;color:#0d1f35}
    </style></head><body>
    <div style="text-align: center; margin-bottom: 15px;">
        <img src="${session.logo || ''}" alt="${escHtml(session.schoolName || session.schoolId)}" onerror="this.style.display='none'" style="max-height:80px; object-fit:contain;">
    </div>
    <div class="watermark">UNOFFICIAL TRANSCRIPT — INTERNAL RECORD ONLY</div>
    <div class="header-block">
        <div class="school-name">${session.schoolName || 'ConnectUs School'}</div>
    </div>
    <div class="info-grid">
        <div class="info-item"><label>Student Name</label><span>${s.name || '—'}</span></div>
        <div class="info-item"><label>Global Student ID</label><span style="font-family:monospace">${s.id || studentId}</span></div>
        <div class="info-item"><label>Date of Birth</label><span>${s.dob || 'N/A'}</span></div>
        <div class="info-item"><label>Gender</label><span>${s.gender || 'N/A'}</span></div>
        <div class="info-item"><label>Current Class</label><span>${s.className || 'Unassigned'}</span></div>
        <div class="info-item"><label>Enrollment Status</label><span>${s.enrollmentStatus || 'Active'}</span></div>
        <div class="info-item"><label>Parent / Guardian</label><span>${s.parentName || 'N/A'}</span></div>
        <div class="info-item"><label>Parent Phone</label><span>${s.parentPhone || 'N/A'}</span></div>
    </div>
    <h3 style="font-size:13px;font-weight:bold;background:#0d1f35;color:white;padding:8px 15px;border-radius:4px;">Academic Summary</h3>
    ${gradesHtml}
    <div class="footer" style="display:flex; flex-direction:column; align-items:center; gap:8px;">
        <span>Printed ${new Date().toLocaleDateString('en-US', { month: 'long', day: 'numeric', year: 'numeric' })} via ConnectUs Student Registry<br>
        Issued by: ${session.schoolName || session.schoolId}</span>
        <div style="display:flex; justify-content:center; align-items:center; gap:8px; margin-top:5px;">
            <img src="../../assets/images/logo.png" style="max-height:16px; opacity:0.8;">
            <span style="font-weight:bold; color:#0d1f35;">Powered by ConnectUs</span>
        </div>
    </div>
    </body></html>`);
    w.document.close();
    setTimeout(() => w.print(), 500);
};


// ── 15. CSV EXPORT ────────────────────────────────────────────────────────
document.getElementById('exportCsvBtn').addEventListener('click', () => {
    const rows = [
        ['Global ID', 'Name', 'Status', 'Class', 'Teacher', 'DOB', 'Email', 'Parent Name', 'Parent Phone', 'Profile Complete'],
        ...allStudentsCache.map(s => [
            s.id, s.name || '', s.enrollmentStatus || 'Active',
            s.className || '', s.teacherName || '',
            s.dob || '', s.email || '',
            s.parentName || '', s.parentPhone || '',
            isStudentProfileComplete(s) ? 'Yes' : 'No'
        ])
    ];
    const csv = rows.map(r => r.map(v => `"${String(v ?? '').replace(/"/g, '""')}"`).join(',')).join('\n');
    const a = Object.assign(document.createElement('a'), {
        href:     URL.createObjectURL(new Blob([csv], { type: 'text/csv' })),
        download: `${session.schoolId}_students_${new Date().toISOString().slice(0, 10)}.csv`
    });
    document.body.appendChild(a); a.click(); a.remove();
});


// ── BOOT ──────────────────────────────────────────────────────────────────
loadStudents().then(() => {
    // ── Deep Link / URL Redirect Listener ─────────────────────────────────
    const urlParams = new URLSearchParams(window.location.search);
    const viewStudentId = urlParams.get('viewStudent');
    
    if (viewStudentId) {
        // Open the specific student's panel
        window.openStudentPanel(viewStudentId);
        
        // Clean up the URL so it looks neat and doesn't trigger again on a normal page refresh
        window.history.replaceState(null, '', window.location.pathname);
    }
});
