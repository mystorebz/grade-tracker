import { db } from '../../assets/js/firebase-init.js';
import {
    collection, query, where,
    getDocs, getDoc, doc,
    setDoc, updateDoc, addDoc, writeBatch,
    arrayUnion
} from "https://www.gstatic.com/firebasejs/10.7.1/firebase-firestore.js";
import { requireAuth } from '../../assets/js/auth.js';
import { injectAdminLayout } from '../../assets/js/layout-admin.js';
import { openOverlay, closeOverlay } from '../../assets/js/utils.js';

// ── 1. INIT & AUTH ─────────────────────────────────────────────────────────
const session = requireAuth('admin', '../login.html');
injectAdminLayout('teachers', 'Teaching Staff', 'Manage active educators, transfers, and national profiles.', true, false);

// ── 2. STATE ───────────────────────────────────────────────────────────────
let allTeachersCache  = [];
let currentTeacherId  = null;
let currentTeacherData = null;
let claimedTeacherDoc = null;
let slipData          = { name: '', id: '', pin: '' };

const tbody = document.getElementById('teachersTableBody');

// ── 3. HELPERS ─────────────────────────────────────────────────────────────
function generateTeacherId() {
    const year  = new Date().getFullYear().toString().slice(-2);
    const chars = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
    let rand = '';
    for (let i = 0; i < 5; i++) rand += chars.charAt(Math.floor(Math.random() * chars.length));
    return `T${year}-${rand}`;
}

function generatePin() {
    return Math.floor(100000 + Math.random() * 900000).toString();
}

function escHtml(str) {
    if (!str) return '';
    return String(str).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}

function getTeacherClasses(t) {
    return t.classes?.length ? t.classes : (t.className ? [t.className] : []);
}

function getSubjectNames(subjects) {
    if (!subjects || !subjects.length) return [];
    if (typeof subjects[0] === 'string') return subjects;
    return subjects.filter(s => !s.archived).map(s => s.name);
}

function isProfileComplete(t) {
    return !!(
        t.teacherLicenseNumber &&
        t.licenseType &&
        t.highestEducationLevel &&
        t.employmentType &&
        t.address?.city
    );
}

function getClassOptions() {
    const type = (session.schoolType || '').toLowerCase();
    if (type === 'highschool' || type === 'secondary') {
        return ['First Form', 'Second Form', 'Third Form', 'Fourth Form', 'Fifth Form', 'Sixth Form'];
    } else if (type === 'juniorcollege' || type === 'tertiary') {
        return ['Year 1 — Semester 1', 'Year 1 — Semester 2', 'Year 2 — Semester 1', 'Year 2 — Semester 2'];
    }
    // Default: primary
    return ['Infant 1', 'Infant 2', 'Standard 1', 'Standard 2', 'Standard 3', 'Standard 4', 'Standard 5', 'Standard 6'];
}

function blankTeacherDoc(overrides = {}) {
    const now = Date.now();
    return {
        // ── System ──────────────────────────────────────────────
        pin:                    generatePin(),
        requiresPinReset:       true,
        profileComplete:        false,
        securityQuestionsSet:   false,
        currentSchoolId:        session.schoolId,
        archivedSchoolIds:      [],
        createdAt:              new Date().toISOString(),

        // ── Basic (admin fills) ──────────────────────────────────
        firstName:              '',
        lastName:               '',
        name:                   '',
        email:                  '',
        phone:                  '',
        phoneSecondary:         '',

        // ── Address ──────────────────────────────────────────────
        address: {
            line1:    '',
            line2:    '',
            city:     '',
            district: '',
            country:  'Belize'
        },

        // ── Professional Credentials ─────────────────────────────
        teacherLicenseNumber:   '',
        licenseType:            '',     // Trained | Untrained | Provisional
        licenseExpiryDate:      '',
        yearsOfExperience:      null,

        // ── Academic Qualifications ──────────────────────────────
        highestEducationLevel:  '',     // Associate's | Bachelor's | Master's | Doctorate
        fieldOfStudy:           '',
        institution:            '',
        yearGraduated:          null,

        // ── Teaching Profile ─────────────────────────────────────
        employmentType:         '',     // Full-time | Part-time | Contract | Substitute
        gradeLevelSpec:         '',     // Primary | Secondary | Junior College
        subjects: [
            { id: `sub_${now}_1`, name: 'Mathematics',           archived: false, description: '' },
            { id: `sub_${now}_2`, name: 'English Language Arts', archived: false, description: '' },
            { id: `sub_${now}_3`, name: 'Science',               archived: false, description: '' }
        ],
        classes:                [],
        className:              '',

        // ── Grade Config ─────────────────────────────────────────
        customGradeTypes:   ['Test', 'Quiz', 'Assignment', 'Homework', 'Project', 'Midterm Exam', 'Final Exam'],
        archivedGradeTypes: [],

        ...overrides
    };
}

async function isTeacherLimitReached() {
    const teacherLimit = session.teacherLimit || 10;
    const snap = await getDocs(
        query(collection(db, 'teachers'), where('currentSchoolId', '==', session.schoolId))
    );
    return { reached: snap.size >= teacherLimit, current: snap.size, limit: teacherLimit };
}

function infoCell(label, value) {
    return `
        <div class="bg-[#f8fafb] border border-[#f0f4f8] rounded-lg p-3">
            <p class="text-[9px] font-bold text-[#9ab0c6] uppercase tracking-widest mb-1">${label}</p>
            <p class="font-bold text-[#0d1f35] text-[12px] leading-snug">${value}</p>
        </div>`;
}

// ── 4. LOAD TEACHERS ────────────────────────────────────────────────────────
async function loadTeachers() {
    tbody.innerHTML = `<tr><td colspan="6" class="px-6 py-16 text-center text-[#9ab0c6] italic font-semibold">
        <i class="fa-solid fa-spinner fa-spin mr-2 text-[#2563eb]"></i>Syncing with National Registry...
    </td></tr>`;

    try {
        const [tSnap, sSnap] = await Promise.all([
            getDocs(query(collection(db, 'teachers'), where('currentSchoolId', '==', session.schoolId))),
            getDocs(query(collection(db, 'students'), where('currentSchoolId', '==', session.schoolId)))
        ]);

        const studentCount = {};
        sSnap.forEach(d => {
            const data = d.data();
            if (data.enrollmentStatus !== 'Archived' && data.teacherId) {
                studentCount[data.teacherId] = (studentCount[data.teacherId] || 0) + 1;
            }
        });

        allTeachersCache = tSnap.docs.map(d => ({
            id: d.id,
            ...d.data(),
            studentCount: studentCount[d.id] || 0
        }));

        renderTable();
    } catch (e) {
        console.error('[Teachers] loadTeachers:', e);
        tbody.innerHTML = `<tr><td colspan="6" class="px-6 py-16 text-center text-[#e31b4a] font-semibold">
            Database connection error. Please refresh.
        </td></tr>`;
    }
}

// ── 5. RENDER TABLE ────────────────────────────────────────────────────────
function renderTable() {
    const term     = (document.getElementById('searchInput')?.value || '').toLowerCase();
    const filtered = allTeachersCache.filter(t => (t.name || '').toLowerCase().includes(term));

    if (!filtered.length) {
        tbody.innerHTML = `<tr><td colspan="6" class="px-6 py-16 text-center text-[#9ab0c6] italic font-semibold">
            No active staff mapped to this facility.
        </td></tr>`;
        return;
    }

    tbody.innerHTML = filtered.map(t => {
        const classes  = getTeacherClasses(t);
        const subNames = getSubjectNames(t.subjects);
        const complete = isProfileComplete(t);

        const profileBadge = complete
            ? `<span class="inline-flex items-center gap-1 text-[10px] font-bold text-green-700 bg-green-50 border border-green-200 px-2 py-1 rounded-md">
                   <i class="fa-solid fa-circle-check text-[9px]"></i> Complete
               </span>`
            : `<span class="inline-flex items-center gap-1 text-[10px] font-bold text-red-600 bg-red-50 border border-red-200 px-2 py-1 rounded-md">
                   <i class="fa-solid fa-circle-exclamation text-[9px]"></i> Incomplete
               </span>`;

        return `
        <tr class="border-b border-[#f0f4f8] hover:bg-[#f8fafb] transition">
            <td class="px-6 py-4">
                <div class="flex items-center gap-3">
                    <div class="h-10 w-10 bg-[#0d1f35] text-white rounded-lg flex items-center justify-center font-black text-sm flex-shrink-0">
                        ${escHtml(t.name || '?').charAt(0).toUpperCase()}
                    </div>
                    <div>
                        <p class="font-bold text-[#0d1f35] text-[13px] leading-tight">${escHtml(t.name)}</p>
                        <p class="text-[10.5px] font-mono text-[#6b84a0] uppercase tracking-widest mt-0.5">${t.id}</p>
                    </div>
                </div>
            </td>
            <td class="px-6 py-4">
                <div class="flex flex-wrap gap-1">
                    ${classes.length
                        ? classes.map(c => `<span class="text-[10px] font-bold bg-[#eef4ff] text-[#2563eb] border border-[#c7d9fd] px-2 py-0.5 rounded">${escHtml(c)}</span>`).join('')
                        : '<span class="text-[10px] text-[#9ab0c6] italic font-semibold">Unassigned</span>'}
                </div>
            </td>
            <td class="px-6 py-4 text-center">
                <span class="font-bold text-[13px] text-[#374f6b]">${t.studentCount}</span>
            </td>
            <td class="px-6 py-4 text-center">
                <span class="font-bold text-[13px] text-[#374f6b]">${subNames.length}</span>
            </td>
            <td class="px-6 py-4 text-center">${profileBadge}</td>
            <td class="px-6 py-4 text-right">
                <button onclick="window.openTeacherPanel('${t.id}')"
                    class="bg-white hover:bg-[#eef4ff] text-[#2563eb] font-bold px-4 py-2 rounded text-[12px] transition border border-[#c7d9fd]">
                    Manage
                </button>
            </td>
        </tr>`;
    }).join('');
}

document.getElementById('searchInput')?.addEventListener('input', renderTable);


// ── 6. ADD / CLAIM MODAL ───────────────────────────────────────────────────

function populateClassCheckboxes(containerId = 'classCheckboxGroup', checked = []) {
    const group = document.getElementById(containerId);
    if (!group) return;
    group.innerHTML = getClassOptions().map(c => `
        <label class="flex items-center gap-2 cursor-pointer select-none">
            <input type="checkbox" class="class-checkbox accent-[#2563eb]" value="${escHtml(c)}" ${checked.includes(c) ? 'checked' : ''}>
            <span class="text-[12px] font-semibold text-[#374f6b]">${escHtml(c)}</span>
        </label>
    `).join('');
}

window.openAddTeacherModal = () => {
    ['tFirstName', 'tLastName', 'tEmail', 'tPhone', 'teacherSearchInput'].forEach(id => {
        const el = document.getElementById(id); if (el) el.value = '';
    });
    ['teacherSearchResults', 'claimTeacherPreview', 'claimSearchEmpty', 'addTeacherMsg'].forEach(id =>
        document.getElementById(id)?.classList.add('hidden')
    );
    claimedTeacherDoc = null;
    populateClassCheckboxes();
    openOverlay('addTeacherModal', 'addTeacherModalInner');
};

window.closeAddTeacherModal = () => {
    closeOverlay('addTeacherModal', 'addTeacherModalInner');
    claimedTeacherDoc = null;
};

// ── Search Unassigned Teachers ────────────────────────────────────────────
document.getElementById('searchTeacherBtn').addEventListener('click', async () => {
    const input    = document.getElementById('teacherSearchInput').value.trim();
    const resultsEl = document.getElementById('teacherSearchResults');
    const emptyEl   = document.getElementById('claimSearchEmpty');
    const previewEl = document.getElementById('claimTeacherPreview');

    resultsEl.classList.add('hidden');
    emptyEl.classList.add('hidden');
    previewEl.classList.add('hidden');
    claimedTeacherDoc = null;

    if (!input) { alert('Enter a name or Teacher ID to search.'); return; }

    const btn = document.getElementById('searchTeacherBtn');
    btn.innerHTML = '<i class="fa-solid fa-spinner fa-spin"></i>';
    btn.disabled  = true;

    try {
        let results    = [];
        const lower    = input.toLowerCase();
        const looksLikeId = input.includes('-');

        if (looksLikeId) {
            // Normalize and try direct ID lookup
            const normalizedId = input.toUpperCase().replace(/\s/g, '');
            const snap = await getDoc(doc(db, 'teachers', normalizedId));
            if (snap.exists()) {
                const d = { id: snap.id, ...snap.data() };
                if (!d.currentSchoolId || d.currentSchoolId === '') {
                    results = [d];
                } else if (d.currentSchoolId === session.schoolId) {
                    emptyEl.querySelector('p').textContent = 'That teacher is already active at your school.';
                    emptyEl.classList.remove('hidden');
                    btn.innerHTML = '<i class="fa-solid fa-magnifying-glass mr-1"></i> Search';
                    btn.disabled  = false;
                    return;
                }
            }
        }

        if (!results.length) {
            // Query all unassigned and filter by name client-side
            const snap = await getDocs(
                query(collection(db, 'teachers'), where('currentSchoolId', '==', ''))
            );
            results = snap.docs
                .map(d => ({ id: d.id, ...d.data() }))
                .filter(t => (t.name || '').toLowerCase().includes(lower));
        }

        if (!results.length) {
            emptyEl.classList.remove('hidden');
        } else {
            resultsEl.innerHTML = results.map(t => `
                <div onclick="window.selectTeacherResult('${t.id}')"
                    class="px-4 py-3 hover:bg-[#eef4ff] cursor-pointer border-b border-[#f0f4f8] last:border-0 flex items-center justify-between transition">
                    <div>
                        <p class="font-bold text-[#0d1f35] text-[13px]">${escHtml(t.name || 'Unknown')}</p>
                        <p class="font-mono text-[10px] text-[#9ab0c6] uppercase mt-0.5">${t.id}</p>
                    </div>
                    <i class="fa-solid fa-chevron-right text-[#c5d0db] text-[11px]"></i>
                </div>
            `).join('');
            resultsEl.classList.remove('hidden');
        }
    } catch (e) {
        console.error('[Teachers] search:', e);
        alert('Search failed. Please try again.');
    }

    btn.innerHTML = '<i class="fa-solid fa-magnifying-glass mr-1"></i> Search';
    btn.disabled  = false;
});

// ── Select a Teacher from Results ─────────────────────────────────────────
window.selectTeacherResult = async (teacherId) => {
    document.getElementById('teacherSearchResults').classList.add('hidden');

    try {
        const snap = await getDoc(doc(db, 'teachers', teacherId));
        if (!snap.exists()) return;

        claimedTeacherDoc = { id: snap.id, ...snap.data() };
        const t = claimedTeacherDoc;

        document.getElementById('claimPreviewName').textContent = t.name || 'Unknown';
        document.getElementById('claimPreviewId').textContent   = t.id;

        const details = [
            ['Email',         t.email             || null],
            ['Phone',         t.phone             || null],
            ['License No.',   t.teacherLicenseNumber || null],
            ['License Type',  t.licenseType       || null],
            ['Education',     t.highestEducationLevel || null],
            ['Employment',    t.employmentType    || null],
        ];

        document.getElementById('claimPreviewDetails').innerHTML = details.map(([label, val]) => `
            <div class="bg-white rounded-lg p-2.5 border border-[#dce3ed]">
                <p class="text-[9px] font-bold text-[#9ab0c6] uppercase tracking-widest mb-0.5">${label}</p>
                <p class="text-[12px] font-bold text-[#0d1f35]">
                    ${val ? escHtml(val) : '<span class="text-[#c5d0db] italic text-[11px] font-semibold">Not on file</span>'}
                </p>
            </div>
        `).join('');

        const warningEl   = document.getElementById('claimPreviewWarning');
        const warningText = document.getElementById('claimPreviewWarningText');
        if (!t.email) {
            warningText.textContent = 'No email on file — the teacher should add one during their first login setup.';
            warningEl.classList.remove('hidden');
        } else {
            warningEl.classList.add('hidden');
        }

        document.getElementById('claimTeacherPreview').classList.remove('hidden');
    } catch (e) {
        console.error('[Teachers] selectTeacherResult:', e);
        alert('Could not load teacher details. Please try again.');
    }
};

window.clearTeacherSelection = () => {
    document.getElementById('claimTeacherPreview').classList.add('hidden');
    document.getElementById('teacherSearchInput').value = '';
    claimedTeacherDoc = null;
};

// ── Claim Teacher ─────────────────────────────────────────────────────────
document.getElementById('claimTeacherBtn').addEventListener('click', async () => {
    if (!claimedTeacherDoc) return;
    const btn = document.getElementById('claimTeacherBtn');
    btn.innerHTML = '<i class="fa-solid fa-spinner fa-spin mr-2"></i>Claiming...';
    btn.disabled  = true;

    try {
        const limitCheck = await isTeacherLimitReached();
        if (limitCheck.reached) {
            alert(`Teacher limit reached (${limitCheck.current}/${limitCheck.limit}). Contact ConnectUs to upgrade your plan.`);
            btn.disabled  = false;
            btn.innerHTML = '<i class="fa-solid fa-handshake mr-2"></i> Claim This Teacher';
            return;
        }

        const tempPin = generatePin();
        const tRef    = doc(db, 'teachers', claimedTeacherDoc.id);
        const updates = {
            currentSchoolId:  session.schoolId,
            pin:              tempPin,
            requiresPinReset: true
        };
        if (claimedTeacherDoc.currentSchoolId && claimedTeacherDoc.currentSchoolId !== '') {
            updates.archivedSchoolIds = arrayUnion(claimedTeacherDoc.currentSchoolId);
        }
        await updateDoc(tRef, updates);

        slipData = { name: claimedTeacherDoc.name, id: claimedTeacherDoc.id, pin: tempPin };
        window.closeAddTeacherModal();
        window.showCredentialSlip();
        loadTeachers();

    } catch (e) {
        console.error('[Teachers] claim:', e);
        alert('Error claiming teacher. Please try again.');
    }

    btn.disabled  = false;
    btn.innerHTML = '<i class="fa-solid fa-handshake mr-2"></i> Claim This Teacher';
});

// ── Create New Teacher ────────────────────────────────────────────────────
document.getElementById('saveTeacherBtn').addEventListener('click', async () => {
    const btn   = document.getElementById('saveTeacherBtn');
    const msgEl = document.getElementById('addTeacherMsg');
    msgEl.classList.add('hidden');

    const firstName = document.getElementById('tFirstName').value.trim();
    const lastName  = document.getElementById('tLastName').value.trim();
    const email     = document.getElementById('tEmail').value.trim();
    const phone     = document.getElementById('tPhone').value.trim();
    const selectedClasses = [...document.querySelectorAll('.class-checkbox:checked')].map(cb => cb.value);

    const showMsg = (text, isError = true) => {
        msgEl.textContent = text;
        msgEl.className   = `text-[11px] font-bold mb-2 ${isError ? 'text-red-600' : 'text-green-600'}`;
        msgEl.classList.remove('hidden');
    };

    if (!firstName || !lastName) { showMsg('First and last name are required.'); return; }
    if (!email)                  { showMsg('Email address is required for PIN recovery.'); return; }
    if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) { showMsg('Please enter a valid email address.'); return; }
    
    // NEW MANDATORY CLASS ASSIGNMENT CHECK
    if (selectedClasses.length === 0) { showMsg('You must assign the teacher to at least one class.'); return; }

    btn.innerHTML = '<i class="fa-solid fa-spinner fa-spin mr-2"></i>Processing...';
    btn.disabled  = true;

    try {
        const limitCheck = await isTeacherLimitReached();
        if (limitCheck.reached) {
            alert(`Teacher limit reached (${limitCheck.current}/${limitCheck.limit}). Contact ConnectUs to upgrade.`);
            btn.disabled  = false;
            btn.innerHTML = '<i class="fa-solid fa-user-plus mr-2"></i> Register';
            return;
        }

        const newId   = generateTeacherId();
        const fullName = `${firstName} ${lastName}`;
        const docData = blankTeacherDoc({
            firstName, lastName,
            name:      fullName,
            email, phone,
            classes:   selectedClasses,
            className: selectedClasses[0] || ''
        });

        await setDoc(doc(db, 'teachers', newId), docData);

        slipData = { name: fullName, id: newId, pin: docData.pin };
        window.closeAddTeacherModal();
        window.showCredentialSlip();
        loadTeachers();

    } catch (e) {
        console.error('[Teachers] create:', e);
        showMsg('System error. Please try again.');
    }

    btn.disabled  = false;
    btn.innerHTML = '<i class="fa-solid fa-user-plus mr-2"></i> Register';
});


// ── 7. CREDENTIAL SLIP ────────────────────────────────────────────────────
window.showCredentialSlip = () => {
    document.getElementById('slipTeacherName').textContent = slipData.name;
    document.getElementById('slipTeacherId').textContent   = slipData.id;
    document.getElementById('slipTeacherPin').textContent  = slipData.pin;
    openOverlay('credentialSlipModal', 'credentialSlipModalInner');
};

window.closeCredentialSlip = () => closeOverlay('credentialSlipModal', 'credentialSlipModalInner');

window.printCredentialSlip = () => {
    const { name, id, pin } = slipData;
    const html = `<!DOCTYPE html><html><head><title>Teacher Credential Slip</title>
    <style>
        body { font-family:'Helvetica Neue',Arial,sans-serif; display:flex; justify-content:center; align-items:center; height:100vh; margin:0; background:#f4f7fb; }
        .slip { background:white; border:2px solid #dce3ed; border-top:4px solid #2563eb; border-radius:12px; padding:32px 40px; max-width:340px; text-align:center; }
        .logo { font-size:11px; font-weight:900; letter-spacing:0.3em; color:#6b84a0; text-transform:uppercase; margin-bottom:20px; }
        h2   { font-size:17px; color:#0d1f35; font-weight:900; margin:0 0 20px 0; }
        .lbl { font-size:9px; font-weight:700; letter-spacing:0.15em; text-transform:uppercase; color:#6b84a0; margin-top:12px; margin-bottom:3px; }
        .id  { font-family:monospace; font-size:22px; font-weight:900; letter-spacing:0.2em; color:#0d1f35; }
        .pin { font-family:monospace; font-size:32px; font-weight:900; letter-spacing:0.4em; color:#2563eb; }
        .note{ font-size:10px; color:#b45309; font-weight:700; background:#fffbeb; border:1px solid #fde68a; border-radius:6px; padding:10px 12px; margin-top:16px; line-height:1.5; }
        .ft  { font-size:9px; color:#9ab0c6; margin-top:16px; border-top:1px solid #f0f4f8; padding-top:12px; }
    </style></head><body>
    <div class="slip">
        <div class="logo">ConnectUs National Registry</div>
        <h2>${escHtml(name)}</h2>
        <p class="lbl">Global Teacher ID</p><p class="id">${escHtml(id)}</p>
        <p class="lbl">Temporary Login PIN</p><p class="pin">${escHtml(pin)}</p>
        <div class="note">⚠ Temporary PIN — the teacher must reset it and set security questions upon first login.</div>
        <p class="ft">Keep this slip confidential.<br>Present at the ConnectUs Teacher Portal.</p>
    </div></body></html>`;

    const w = window.open('', '_blank');
    w.document.write(html);
    w.document.close();
    setTimeout(() => w.print(), 400);
};


// ── 8. TEACHER PANEL ──────────────────────────────────────────────────────
window.openTeacherPanel = async (teacherId) => {
    currentTeacherId   = teacherId;
    currentTeacherData = null;

    document.getElementById('tPanelLoader').classList.remove('hidden');
    document.getElementById('tPanelLoader').innerHTML = '<i class="fa-solid fa-spinner fa-spin text-3xl text-[#2563eb]"></i>';
    document.getElementById('tPanelTabs').classList.add('hidden');
    document.querySelectorAll('.tab-pane').forEach(p => p.classList.add('hidden'));

    openOverlay('teacherPanel', 'teacherPanelInner', true);

    try {
        const snap = await getDoc(doc(db, 'teachers', teacherId));
        if (!snap.exists()) {
            document.getElementById('tPanelLoader').innerHTML =
                `<p class="text-[#e31b4a] font-bold px-8 text-center">Teacher not found in registry.</p>`;
            return;
        }

        currentTeacherData = { id: snap.id, ...snap.data() };
        const t = currentTeacherData;

        document.getElementById('tPanelName').textContent = t.name || 'Unknown Teacher';
        document.getElementById('tPanelMeta').textContent =
            [t.id, t.employmentType, t.gradeLevelSpec].filter(Boolean).join(' · ');

        document.getElementById('tPanelLoader').classList.add('hidden');
        document.getElementById('tPanelTabs').classList.remove('hidden');

        // Activate Overview by default
        switchPanelTab('overview');

    } catch (e) {
        console.error('[Teachers] openTeacherPanel:', e);
        document.getElementById('tPanelLoader').innerHTML =
            `<p class="text-[#e31b4a] font-bold px-8 text-center">Error loading teacher. Please try again.</p>`;
    }
};

window.closeTeacherPanel = () => closeOverlay('teacherPanel', 'teacherPanelInner', true);

// ── Tab Switching ─────────────────────────────────────────────────────────
document.querySelectorAll('.panel-tab').forEach(btn => {
    btn.addEventListener('click', () => switchPanelTab(btn.dataset.tab));
});

function switchPanelTab(tabName) {
    document.querySelectorAll('.panel-tab').forEach(b => b.classList.remove('active'));
    document.querySelectorAll('.tab-pane').forEach(p => p.classList.add('hidden'));

    document.querySelector(`.panel-tab[data-tab="${tabName}"]`)?.classList.add('active');
    document.getElementById(`tab-${tabName}`)?.classList.remove('hidden');

    if (tabName === 'overview')    renderOverviewTab();
    if (tabName === 'students')    renderStudentsTab();
    if (tabName === 'subjects')    renderSubjectsTab();
    if (tabName === 'evaluations') renderEvaluationsTab();
    if (tabName === 'archive')     renderArchiveTab();
}


// ── 9. OVERVIEW TAB ───────────────────────────────────────────────────────
async function renderOverviewTab() {
    const t = currentTeacherData;
    if (!t) return;
    const pane     = document.getElementById('tab-overview');
    const classes  = getTeacherClasses(t);
    const complete = isProfileComplete(t);

    // ── Check for active term and active students per class ───────────────
    let hasActiveTerm = false;
    let activeTermName = '';
    let studentsByClass = {};   // { 'Standard 1': 3, 'Infant 2': 0, ... }

    try {
        const [termSnap, studSnap] = await Promise.all([
            getDocs(query(collection(db, 'terms'),
                where('schoolId', '==', session.schoolId),
                where('isActive', '==', true))),
            getDocs(query(collection(db, 'students'),
                where('teacherId', '==', currentTeacherId),
                where('currentSchoolId', '==', session.schoolId),
                where('enrollmentStatus', '==', 'Active')))
        ]);

        if (!termSnap.empty) {
            hasActiveTerm  = true;
            activeTermName = termSnap.docs[0].data().name || 'the current term';
        }

        studSnap.forEach(d => {
            const cls = d.data().className || '';
            if (cls) studentsByClass[cls] = (studentsByClass[cls] || 0) + 1;
        });
    } catch (_) {}

    // ── Build checkboxes — locked if class has active students in active term
    const classCheckboxes = getClassOptions().map(c => {
        const isAssigned   = classes.includes(c);
        const studentCount = studentsByClass[c] || 0;
        const isLocked     = isAssigned && hasActiveTerm && studentCount > 0;

        if (isLocked) {
            return `
                <label class="flex items-center gap-2 select-none cursor-not-allowed" title="Cannot remove — ${studentCount} active student${studentCount !== 1 ? 's' : ''} in ${activeTermName}">
                    <input type="checkbox" class="manage-class-checkbox accent-[#2563eb]"
                        value="${escHtml(c)}" checked disabled>
                    <span class="text-[12px] font-semibold text-[#374f6b]">${escHtml(c)}</span>
                    <span class="flex items-center gap-1 text-[10px] font-bold text-amber-700 bg-amber-50 border border-amber-200 px-1.5 py-0.5 rounded ml-auto">
                        <i class="fa-solid fa-lock text-[8px]"></i> ${studentCount} student${studentCount !== 1 ? 's' : ''}
                    </span>
                </label>`;
        }

        return `
            <label class="flex items-center gap-2 cursor-pointer select-none">
                <input type="checkbox" class="manage-class-checkbox accent-[#2563eb]"
                    value="${escHtml(c)}" ${isAssigned ? 'checked' : ''}>
                <span class="text-[12px] font-semibold text-[#374f6b]">${escHtml(c)}</span>
            </label>`;
    }).join('');

    pane.innerHTML = `

        <div class="${complete
            ? 'bg-green-50 border-green-200 text-green-700'
            : 'bg-red-50 border-red-200 text-red-700'} border rounded-xl p-4 flex items-start gap-3">
            <i class="fa-solid ${complete ? 'fa-circle-check text-green-500' : 'fa-circle-exclamation text-red-500'} text-xl mt-0.5 flex-shrink-0"></i>
            <div>
                <p class="font-black text-[13px] mb-0.5">${complete ? 'Profile Complete' : 'Profile Incomplete'}</p>
                <p class="text-[11px] font-semibold opacity-80">
                    ${complete
                        ? 'All required professional information is on file.'
                        : 'This teacher has not completed their professional profile. They will be prompted to complete it on their next login.'}
                </p>
            </div>
        </div>

        <div class="bg-white border border-[#dce3ed] rounded-xl p-5 shadow-sm">
            <h4 class="text-[10px] font-bold text-[#6b84a0] uppercase tracking-widest mb-3">Identity & Contact</h4>
            <div class="grid grid-cols-2 gap-2">
                ${infoCell('Global ID', `<span class="font-mono tracking-widest text-[11px]">${t.id}</span>`)}
                ${infoCell('Full Name', escHtml(t.name) || '—')}
                ${infoCell('Email', t.email
                    ? `<a href="mailto:${escHtml(t.email)}" class="text-[#2563eb] hover:underline break-all">${escHtml(t.email)}</a>`
                    : '<span class="text-amber-500 font-black text-[11px]">⚠ Not set</span>')}
                ${infoCell('Phone', escHtml(t.phone) || '—')}
                ${infoCell('Secondary Phone', escHtml(t.phoneSecondary) || '—')}
                ${infoCell('District', escHtml(t.address?.district) || '—')}
                ${infoCell('City / Town', escHtml(t.address?.city) || '—')}
            </div>
        </div>

        <div class="bg-white border border-[#dce3ed] rounded-xl p-5 shadow-sm">
            <h4 class="text-[10px] font-bold text-[#6b84a0] uppercase tracking-widest mb-3">Professional Credentials</h4>
            <div class="grid grid-cols-2 gap-2">
                ${infoCell('License Number', escHtml(t.teacherLicenseNumber) || '—')}
                ${infoCell('License Type', escHtml(t.licenseType) || '—')}
                ${infoCell('License Expiry', escHtml(t.licenseExpiryDate) || '—')}
                ${infoCell('Years of Experience', t.yearsOfExperience != null ? String(t.yearsOfExperience) : '—')}
                ${infoCell('Employment Type', escHtml(t.employmentType) || '—')}
                ${infoCell('Grade Level', escHtml(t.gradeLevelSpec) || '—')}
            </div>
        </div>

        <div class="bg-white border border-[#dce3ed] rounded-xl p-5 shadow-sm">
            <h4 class="text-[10px] font-bold text-[#6b84a0] uppercase tracking-widest mb-3">Academic Qualifications</h4>
            <div class="grid grid-cols-2 gap-2">
                ${infoCell('Highest Education', escHtml(t.highestEducationLevel) || '—')}
                ${infoCell('Field of Study', escHtml(t.fieldOfStudy) || '—')}
                ${infoCell('Institution', escHtml(t.institution) || '—')}
                ${infoCell('Year Graduated', t.yearGraduated ? String(t.yearGraduated) : '—')}
            </div>
        </div>

        <div class="bg-white border border-[#dce3ed] rounded-xl p-5 shadow-sm">
            <div class="flex items-center justify-between mb-3">
                <h4 class="text-[10px] font-bold text-[#6b84a0] uppercase tracking-widest">Assigned Classes</h4>
                <button onclick="window.saveClassAssignment()"
                    class="text-[11px] font-bold text-[#2563eb] bg-[#eef4ff] border border-[#c7d9fd] px-3 py-1.5 rounded hover:bg-[#dbeafe] transition">
                    <i class="fa-solid fa-floppy-disk mr-1"></i> Save
                </button>
            </div>
            <div class="grid grid-cols-2 gap-2" id="manageClassCheckboxes">
                ${classCheckboxes}
            </div>
            <p id="classAssignMsg" class="text-[11px] hidden mt-2 font-bold"></p>
        </div>`;
}

window.saveClassAssignment = async () => {
    const currentClasses = getTeacherClasses(currentTeacherData);
    const selected       = [...document.querySelectorAll('.manage-class-checkbox:checked')].map(cb => cb.value);
    const msgEl          = document.getElementById('classAssignMsg');
    msgEl.classList.add('hidden');

    // ── Guard: check if any currently-assigned class is being removed ─────
    const removed = currentClasses.filter(c => !selected.includes(c));

    if (removed.length > 0) {
        try {
            const [termSnap, studSnap] = await Promise.all([
                getDocs(query(collection(db, 'terms'),
                    where('schoolId', '==', session.schoolId),
                    where('isActive', '==', true))),
                getDocs(query(collection(db, 'students'),
                    where('teacherId', '==', currentTeacherId),
                    where('currentSchoolId', '==', session.schoolId),
                    where('enrollmentStatus', '==', 'Active')))
            ]);

            if (!termSnap.empty) {
                const termName      = termSnap.docs[0].data().name || 'the current term';
                const activeStudents = studSnap.docs.map(d => d.data());

                for (const cls of removed) {
                    const count = activeStudents.filter(s => s.className === cls).length;
                    if (count > 0) {
                        msgEl.innerHTML =
                            `<i class="fa-solid fa-lock mr-1"></i>
                             Cannot remove <strong>${escHtml(cls)}</strong> —
                             ${count} active student${count !== 1 ? 's' : ''} ${count !== 1 ? 'are' : 'is'} assigned to this teacher
                             in <strong>${escHtml(termName)}</strong>.
                             Reassign or archive the student${count !== 1 ? 's' : ''} first.`;
                        msgEl.className = 'text-[11px] mt-3 font-bold text-red-600 bg-red-50 border border-red-200 rounded-lg p-3 leading-relaxed';
                        msgEl.classList.remove('hidden');
                        return;
                    }
                }
            }
        } catch (e) {
            console.error('[Teachers] saveClasses guard:', e);
        }
    }

    // ── Safe to save ──────────────────────────────────────────────────────
    try {
        await updateDoc(doc(db, 'teachers', currentTeacherId), {
            classes:   selected,
            className: selected[0] || ''
        });
        if (currentTeacherData) { currentTeacherData.classes = selected; currentTeacherData.className = selected[0] || ''; }
        const idx = allTeachersCache.findIndex(t => t.id === currentTeacherId);
        if (idx > -1) { allTeachersCache[idx].classes = selected; allTeachersCache[idx].className = selected[0] || ''; }
        renderTable();
        msgEl.textContent = 'Classes saved.';
        msgEl.className   = 'text-[11px] mt-2 font-bold text-green-600';
        msgEl.classList.remove('hidden');
        setTimeout(() => msgEl.classList.add('hidden'), 2500);
    } catch (e) {
        console.error('[Teachers] saveClasses:', e);
        msgEl.textContent = 'Error saving. Try again.';
        msgEl.className   = 'text-[11px] mt-2 font-bold text-red-600';
        msgEl.classList.remove('hidden');
    }
};


// ── 10. STUDENTS TAB ──────────────────────────────────────────────────────
async function renderStudentsTab() {
    const pane = document.getElementById('tab-students');
    pane.innerHTML = `<div class="flex items-center justify-center py-16">
        <i class="fa-solid fa-spinner fa-spin text-2xl text-[#2563eb]"></i></div>`;

    try {
        const snap = await getDocs(
            query(collection(db, 'students'),
                where('teacherId', '==', currentTeacherId),
                where('currentSchoolId', '==', session.schoolId))
        );
        const students = snap.docs
            .map(d => ({ id: d.id, ...d.data() }))
            .filter(s => s.enrollmentStatus !== 'Archived');

        if (!students.length) {
            pane.innerHTML = `<div class="text-center py-16 text-[#9ab0c6] italic font-semibold text-[13px]">
                No students currently assigned to this teacher.</div>`;
            return;
        }

        pane.innerHTML = `
            <div class="flex items-center justify-between mb-4">
                <p class="text-[12px] font-bold text-[#374f6b]">
                    ${students.length} student${students.length !== 1 ? 's' : ''} assigned
                </p>
            </div>
            <div class="space-y-2">
                ${students.map(s => `
                    <div class="bg-white border border-[#dce3ed] rounded-xl p-4 flex items-center justify-between">
                        <div class="flex items-center gap-3">
                            <div class="h-9 w-9 bg-[#eef4ff] text-[#2563eb] rounded-lg flex items-center justify-center font-black text-sm flex-shrink-0">
                                ${escHtml(s.name || '?').charAt(0).toUpperCase()}
                            </div>
                            <div>
                                <p class="font-bold text-[#0d1f35] text-[13px]">${escHtml(s.name)}</p>
                                <p class="text-[10px] font-mono text-[#9ab0c6] uppercase mt-0.5">${s.id}</p>
                            </div>
                        </div>
                        <div class="flex items-center gap-2">
                            <span class="text-[10px] font-bold bg-[#f8fafb] border border-[#dce3ed] px-2 py-0.5 rounded text-[#374f6b]">
                                ${escHtml(s.class || s.className || '—')}
                            </span>
                            <button onclick="window.reassignStudent('${s.id}', '${escHtml(s.name)}')"
                                class="text-[11px] font-bold text-[#6b84a0] hover:text-[#2563eb] bg-[#f8fafb] border border-[#dce3ed] px-3 py-1.5 rounded transition">
                                Reassign
                            </button>
                        </div>
                    </div>
                `).join('')}
            </div>`;
    } catch (e) {
        console.error('[Teachers] studentsTab:', e);
        pane.innerHTML = `<div class="text-center py-16 text-[#e31b4a] font-semibold">Error loading students.</div>`;
    }
}

window.reassignStudent = (studentId, studentName) => {
    const newTeacherId = prompt(`Reassign "${studentName}" to which Teacher ID?`);
    if (!newTeacherId?.trim()) return;
    if (!confirm(`Confirm: reassign ${studentName} to teacher ${newTeacherId.trim()}?`)) return;

    updateDoc(doc(db, 'students', studentId), { teacherId: newTeacherId.trim() })
        .then(() => { renderStudentsTab(); loadTeachers(); })
        .catch(e => { console.error('[Teachers] reassign:', e); alert('Reassignment failed.'); });
};


// ── 11. SUBJECTS TAB ──────────────────────────────────────────────────────
function renderSubjectsTab() {
    const t = currentTeacherData;
    if (!t) return;
    const pane     = document.getElementById('tab-subjects');
    const subjects  = t.subjects || [];
    const active    = subjects.filter(s => !s.archived);
    const archived  = subjects.filter(s => s.archived);

    pane.innerHTML = `
        <div class="flex items-center justify-between mb-4">
            <p class="text-[12px] font-bold text-[#374f6b]">
                ${active.length} active subject${active.length !== 1 ? 's' : ''}
            </p>
            <button onclick="window.promptAddSubject()"
                class="flex items-center gap-1.5 bg-[#2563eb] hover:bg-[#1d4ed8] text-white font-bold px-4 py-2 rounded text-[12px] transition">
                <i class="fa-solid fa-plus"></i> Add Subject
            </button>
        </div>

        <div class="space-y-2 mb-5">
            ${active.length
                ? active.map(s => subjectRow(s, false)).join('')
                : `<div class="text-center py-8 text-[#9ab0c6] italic font-semibold text-[12px]">No active subjects.</div>`}
        </div>

        ${archived.length ? `
            <details class="bg-white border border-[#dce3ed] rounded-xl overflow-hidden">
                <summary class="px-5 py-3 text-[11px] font-bold text-[#9ab0c6] uppercase tracking-widest cursor-pointer hover:bg-[#f8fafb] transition select-none">
                    <i class="fa-solid fa-box-archive mr-1.5"></i>
                    ${archived.length} Archived Subject${archived.length !== 1 ? 's' : ''}
                </summary>
                <div class="p-4 space-y-2 border-t border-[#f0f4f8]">
                    ${archived.map(s => subjectRow(s, true)).join('')}
                </div>
            </details>
        ` : ''}`;
}

function subjectRow(s, isArchived) {
    return `
        <div class="bg-white border border-[#dce3ed] rounded-xl p-4 flex items-center justify-between">
            <div class="min-w-0 mr-3">
                <p class="font-bold text-[13px] ${isArchived ? 'text-[#9ab0c6] line-through' : 'text-[#0d1f35]'}">
                    ${escHtml(s.name)}
                </p>
                ${s.description ? `<p class="text-[11px] text-[#6b84a0] font-semibold mt-0.5">${escHtml(s.description)}</p>` : ''}
            </div>
            <button onclick="window.toggleSubjectArchive('${s.id}', ${isArchived})"
                class="flex-shrink-0 text-[11px] font-bold px-3 py-1.5 rounded border transition
                    ${isArchived
                        ? 'text-[#2563eb] border-[#c7d9fd] hover:bg-[#eef4ff]'
                        : 'text-[#9ab0c6] border-[#f0f4f8] hover:text-[#e31b4a] hover:border-red-100 hover:bg-red-50'}">
                ${isArchived ? 'Restore' : 'Archive'}
            </button>
        </div>`;
}

window.promptAddSubject = () => {
    const name = prompt('Subject name:');
    if (!name?.trim()) return;
    const desc = prompt('Description (optional):') || '';
    addSubject(name.trim(), desc.trim());
};

async function addSubject(name, description = '') {
    const newSubject = { id: `sub_${Date.now()}`, name, archived: false, description };
    const updated    = [...(currentTeacherData.subjects || []), newSubject];
    try {
        await updateDoc(doc(db, 'teachers', currentTeacherId), { subjects: updated });
        currentTeacherData.subjects = updated;
        const idx = allTeachersCache.findIndex(t => t.id === currentTeacherId);
        if (idx > -1) allTeachersCache[idx].subjects = updated;
        renderSubjectsTab();
        renderTable();
    } catch (e) {
        console.error('[Teachers] addSubject:', e);
        alert('Error adding subject.');
    }
}

window.toggleSubjectArchive = async (subjectId, currentlyArchived) => {
    const updated = (currentTeacherData.subjects || []).map(s =>
        s.id === subjectId ? { ...s, archived: !currentlyArchived } : s
    );
    try {
        await updateDoc(doc(db, 'teachers', currentTeacherId), { subjects: updated });
        currentTeacherData.subjects = updated;
        const idx = allTeachersCache.findIndex(t => t.id === currentTeacherId);
        if (idx > -1) allTeachersCache[idx].subjects = updated;
        renderSubjectsTab();
        renderTable();
    } catch (e) {
        console.error('[Teachers] toggleSubject:', e);
        alert('Error updating subject.');
    }
};


// ── 12. EVALUATIONS TAB ───────────────────────────────────────────────────
async function renderEvaluationsTab() {
    const pane = document.getElementById('tab-evaluations');
    pane.innerHTML = `<div class="flex items-center justify-center py-16">
        <i class="fa-solid fa-spinner fa-spin text-2xl text-[#2563eb]"></i></div>`;

    try {
        const snap  = await getDocs(
            query(collection(db, 'teachers', currentTeacherId, 'evaluations'),
                where('schoolId', '==', session.schoolId))
        );
        const evals = snap.docs
            .map(d => ({ id: d.id, ...d.data() }))
            .sort((a, b) => new Date(b.timestamp || b.date || 0) - new Date(a.timestamp || a.date || 0));

        const count  = evals.length;
        const avgNum = count ? evals.reduce((s, e) => s + (e.overallRating || e.performanceScore || 0), 0) / count : null;
        const avg    = avgNum !== null ? avgNum.toFixed(1) : null;
        const stars  = avg
            ? [1,2,3,4,5].map(n =>
                `<span style="color:${n <= Math.round(parseFloat(avg)) ? '#f59e0b' : '#dce3ed'};font-size:16px">★</span>`
              ).join('')
            : null;

        pane.innerHTML = `
            <div class="flex items-center justify-between mb-5">
                <div>
                    ${avg
                        ? `<div class="flex items-baseline gap-2">
                               <span class="text-[26px] font-black text-[#0d1f35]">${avg}</span>
                               <span class="text-[13px] font-bold text-[#6b84a0]">/ 5 avg</span>
                           </div>
                           <div class="flex items-center gap-2 mt-0.5">
                               <span>${stars}</span>
                               <span class="text-[11px] font-semibold text-[#9ab0c6]">${count} evaluation${count !== 1 ? 's' : ''}</span>
                           </div>`
                        : `<p class="text-[13px] text-[#9ab0c6] italic font-semibold">No evaluations on record yet.</p>`
                    }
                </div>
                <button onclick="window.openAddEvalModal()"
                    class="flex items-center gap-1.5 bg-[#2563eb] hover:bg-[#1d4ed8] text-white font-bold px-4 py-2 rounded text-[12px] transition">
                    <i class="fa-solid fa-plus"></i> Add Evaluation
                </button>
            </div>

            <div class="space-y-3">
                ${evals.map(e => {
                    const rating  = e.overallRating || e.performanceScore || 0;
                    const eStars  = [1,2,3,4,5].map(n =>
                        `<span style="color:${n <= rating ? '#f59e0b' : '#dce3ed'}">★</span>`
                    ).join('');
                    const dateStr = (e.timestamp || e.date)
                        ? new Date(e.timestamp || e.date).toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' })
                        : '—';
                    return `
                        <div class="bg-white border border-[#dce3ed] rounded-xl p-5">
                            <div class="flex items-start justify-between mb-2">
                                <div>
                                    <p class="font-black text-[13px] text-[#0d1f35]">${escHtml(e.type || 'Evaluation')}</p>
                                    <p class="text-[10px] font-semibold text-[#9ab0c6] mt-0.5">${dateStr}</p>
                                </div>
                                <div class="text-right flex-shrink-0 ml-3">
                                    <div class="text-[15px] leading-none">${eStars}</div>
                                    <p class="text-[11px] font-black text-[#374f6b] mt-1">${rating}/5</p>
                                </div>
                            </div>
                            ${e.reason ? `<p class="text-[11px] font-bold text-[#6b84a0] mb-1.5">Reason: ${escHtml(e.reason)}</p>` : ''}
                            ${e.comments ? `<p class="text-[12px] text-[#374f6b] font-semibold leading-relaxed border-t border-[#f0f4f8] pt-3 mt-2">${escHtml(e.comments)}</p>` : ''}
                        </div>`;
                }).join('')}
            </div>`;

    } catch (e) {
        console.error('[Teachers] evalTab:', e);
        pane.innerHTML = `<div class="text-center py-16 text-[#e31b4a] font-semibold">Error loading evaluations.</div>`;
    }
}

window.openAddEvalModal = () => {
    ['evalType', 'evalRating', 'evalComments'].forEach(id => {
        const el = document.getElementById(id); if (el) el.value = '';
    });
    document.getElementById('evalDate').value = new Date().toISOString().split('T')[0];
    openOverlay('addEvalModal', 'addEvalModalInner');
};
window.closeAddEvalModal = () => closeOverlay('addEvalModal', 'addEvalModalInner');

document.getElementById('saveEvalBtn').addEventListener('click', async () => {
    const type     = document.getElementById('evalType').value;
    const rating   = document.getElementById('evalRating').value;
    const date     = document.getElementById('evalDate').value;
    const comments = document.getElementById('evalComments').value.trim();

    if (!type || !rating || !date || !comments) { alert('All fields are required.'); return; }

    const btn = document.getElementById('saveEvalBtn');
    btn.innerHTML = '<i class="fa-solid fa-spinner fa-spin mr-2"></i>Saving...';
    btn.disabled  = true;

    try {
        await addDoc(collection(db, 'teachers', currentTeacherId, 'evaluations'), {
            type,
            overallRating: parseInt(rating),
            date,
            comments,
            schoolId:    session.schoolId,
            evaluatorId: session.adminId || 'Admin',
            timestamp:   new Date().toISOString()
        });
        window.closeAddEvalModal();
        renderEvaluationsTab();
    } catch (e) {
        console.error('[Teachers] saveEval:', e);
        alert('Error saving evaluation.');
    }

    btn.innerHTML = 'Save Evaluation';
    btn.disabled  = false;
});


// ── 13. ARCHIVE TAB ───────────────────────────────────────────────────────
function renderArchiveTab() {
    const pane = document.getElementById('tab-archive');
    pane.innerHTML = `
        <div class="max-w-md mx-auto pt-4">
            <div class="bg-red-50 border-2 border-red-200 rounded-xl p-6 text-center mb-5">
                <i class="fa-solid fa-box-archive text-[#e31b4a] text-3xl mb-3"></i>
                <h4 class="font-black text-[#be123c] text-[15px] mb-2">Archive This Teacher</h4>
                <p class="text-[12px] text-[#374f6b] font-semibold leading-relaxed">
                    Archiving removes <strong>${escHtml(currentTeacherData?.name)}</strong> from your active staff
                    and files a mandatory exit evaluation in the National Registry.
                </p>
            </div>

            <div class="bg-white border border-[#dce3ed] rounded-xl p-5 mb-5 space-y-2">
                <p class="text-[10px] font-bold text-[#6b84a0] uppercase tracking-widest mb-2">Before You Can Archive</p>
                <div class="flex items-center gap-2 text-[12px] font-semibold text-[#374f6b]">
                    <i class="fa-solid fa-circle-check text-green-500 w-4"></i>
                    Exit evaluation must be completed
                </div>
                <div class="flex items-center gap-2 text-[12px] font-semibold text-[#374f6b]">
                    <i class="fa-solid fa-circle-check text-green-500 w-4"></i>
                    Teacher must have no active students in the current term
                </div>
            </div>

            <button onclick="window.initiateArchive()"
                class="w-full bg-[#e31b4a] hover:bg-[#be123c] text-white font-bold py-4 rounded-xl transition shadow-md text-[13px] uppercase tracking-widest flex items-center justify-center gap-2">
                <i class="fa-solid fa-box-archive"></i> Initiate Archive Process
            </button>
        </div>`;
}

window.initiateArchive = async () => {
    try {
        const studentsSnap = await getDocs(
            query(collection(db, 'students'),
                where('teacherId', '==', currentTeacherId),
                where('currentSchoolId', '==', session.schoolId))
        );
        const activeStudents = studentsSnap.docs
            .map(d => d.data())
            .filter(s => s.enrollmentStatus !== 'Archived');

        if (activeStudents.length > 0) {
            // Try to get active term name
            let termName = 'the current term';
            try {
                const termSnap = await getDocs(
                    query(collection(db, 'terms'),
                        where('schoolId', '==', session.schoolId),
                        where('isActive', '==', true))
                );
                if (!termSnap.empty) termName = termSnap.docs[0].data().name || termName;
            } catch (_) {}

            document.getElementById('archiveBlockedMsg').innerHTML =
                `<strong>${escHtml(currentTeacherData?.name)}</strong> currently has
                 <strong>${activeStudents.length} active student${activeStudents.length !== 1 ? 's' : ''}</strong>
                 in <strong>${escHtml(termName)}</strong>.<br><br>
                 Please reassign all students before archiving this teacher.`;
            openOverlay('archiveBlockedModal', 'archiveBlockedModalInner');
            return;
        }

        // Safe to proceed
        window.openExitModal();

    } catch (e) {
        console.error('[Teachers] initiateArchive:', e);
        alert('Error checking student data. Please try again.');
    }
};

window.closeArchiveBlockedModal = () => closeOverlay('archiveBlockedModal', 'archiveBlockedModalInner');


// ── 14. EXIT EVALUATION MODAL ─────────────────────────────────────────────
window.openExitModal = () => {
    document.getElementById('exitTeacherName').textContent = currentTeacherData?.name || 'this teacher';
    ['exitReason', 'exitScore', 'exitComments'].forEach(id => document.getElementById(id).value = '');
    openOverlay('exitModal', 'exitModalInner');
};

window.closeExitModal = () => closeOverlay('exitModal', 'exitModalInner');

document.getElementById('confirmExitBtn').addEventListener('click', async () => {
    const reason   = document.getElementById('exitReason').value;
    const score    = document.getElementById('exitScore').value;
    const comments = document.getElementById('exitComments').value.trim();

    if (!reason || !score || !comments) {
        alert('All three fields are mandatory to file an exit evaluation.');
        return;
    }

    const btn = document.getElementById('confirmExitBtn');
    btn.innerHTML = '<i class="fa-solid fa-spinner fa-spin mr-2"></i>Securing Record...';
    btn.disabled  = true;

    try {
        const batch   = writeBatch(db);
        const tRef    = doc(db, 'teachers', currentTeacherId);
        const evalRef = doc(collection(db, 'teachers', currentTeacherId, 'evaluations'));

        batch.update(tRef, {
            currentSchoolId:   '',
            archivedSchoolIds: arrayUnion(session.schoolId)
        });

        batch.set(evalRef, {
            evaluatorId:      session.adminId || 'Admin',
            schoolId:         session.schoolId,
            type:             'Exit Review',
            reason,
            overallRating:    parseInt(score),
            performanceScore: parseInt(score),
            comments,
            timestamp:        new Date().toISOString()
        });

        await batch.commit();
        window.closeExitModal();
        window.closeTeacherPanel();
        loadTeachers();

    } catch (e) {
        console.error('[Teachers] exit batch:', e);
        alert('System Error. Action aborted to protect record integrity.');
    }

    btn.innerHTML = '<i class="fa-solid fa-file-signature mr-2"></i>Submit Review & Archive Teacher';
    btn.disabled  = false;
});


// ── 15. CSV EXPORT ────────────────────────────────────────────────────────
document.getElementById('exportCsvBtn').addEventListener('click', () => {
    const rows = [
        ['Global ID', 'Name', 'Email', 'Phone', 'Classes', 'Active Subjects', 'Students', 'License #', 'License Type', 'Employment Type', 'Education Level', 'Profile Complete'],
        ...allTeachersCache.map(t => [
            t.id,
            t.name               || '',
            t.email              || '',
            t.phone              || '',
            getTeacherClasses(t).join(' | '),
            getSubjectNames(t.subjects).join(' | '),
            t.studentCount       || 0,
            t.teacherLicenseNumber || '',
            t.licenseType        || '',
            t.employmentType     || '',
            t.highestEducationLevel || '',
            isProfileComplete(t) ? 'Yes' : 'No'
        ])
    ];
    const csv = rows.map(r =>
        r.map(v => `"${String(v ?? '').replace(/"/g, '""')}"`).join(',')
    ).join('\n');

    const a = Object.assign(document.createElement('a'), {
        href:     URL.createObjectURL(new Blob([csv], { type: 'text/csv' })),
        download: `${session.schoolId}_teachers_${new Date().toISOString().slice(0, 10)}.csv`
    });
    document.body.appendChild(a); a.click(); a.remove();
});


// ── BOOT ──────────────────────────────────────────────────────────────────
loadTeachers();
