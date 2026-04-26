import { db } from '../../assets/js/firebase-init.js';
import {
    collection, query, where,
    getDocs, getDoc, doc,
    setDoc, updateDoc, writeBatch,
    arrayUnion
} from "https://www.gstatic.com/firebasejs/10.7.1/firebase-firestore.js";
import { requireAuth } from '../../assets/js/auth.js';
import { injectAdminLayout } from '../../assets/js/layout-admin.js';
import { openOverlay, closeOverlay } from '../../assets/js/utils.js';

// ── 1. INIT & AUTH ────────────────────────────────────────────────────────
const session = requireAuth('admin', '../login.html');
injectAdminLayout('teachers', 'Teaching Staff', 'Manage active educators, transfers, and national profiles.', true, false);

// ── 2. STATE ──────────────────────────────────────────────────────────────
let allTeachersCache  = [];
let currentTeacherId  = null;
let isEditMode        = false;
let claimedTeacherDoc = null;

const tbody = document.getElementById('teachersTableBody');

// ── 3. HELPERS ────────────────────────────────────────────────────────────
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
    return String(str).replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/"/g,'&quot;');
}

function getTeacherClasses(t) {
    return t.classes || (t.className ? [t.className] : []);
}

function getSubjectNames(subjects) {
    if (!subjects || !subjects.length) return [];
    if (typeof subjects[0] === 'string') return subjects;
    return subjects.filter(s => !s.archived).map(s => s.name);
}

// ── Check teacher limit ───────────────────────────────────────────────────
async function isTeacherLimitReached() {
    const teacherLimit = session.teacherLimit || 10;
    const snap = await getDocs(
        query(collection(db, 'teachers'), where('currentSchoolId', '==', session.schoolId))
    );
    return { reached: snap.size >= teacherLimit, current: snap.size, limit: teacherLimit };
}

// ── 4. LOAD TEACHERS ──────────────────────────────────────────────────────
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
            Database Connection Error.
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

        return `
        <tr class="border-b border-[#f0f4f8] transition hover:bg-[#f8fafb]">
            <td class="px-6 py-4">
                <div class="flex items-center gap-3">
                    <div class="h-10 w-10 bg-[#0d1f35] text-white rounded flex items-center justify-center font-black text-sm flex-shrink-0">
                        ${escHtml(t.name).charAt(0).toUpperCase()}
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
                <span class="font-bold text-[13px] text-[#374f6b]">${subNames.length || 0}</span>
            </td>
            <td class="px-6 py-4 text-center">
                <span class="font-mono font-black text-[13px] bg-[#f8fafb] border border-[#dce3ed] px-3 py-1.5 rounded tracking-widest text-[#0d1f35]">
                    ${escHtml(t.pin)}
                </span>
            </td>
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

// ── 6. ADD / CLAIM TEACHER MODAL ──────────────────────────────────────────
window.openAddTeacherModal = () => {
    ['tGlobalId','tName','tEmail','tPhone'].forEach(id => {
        const el = document.getElementById(id);
        if (el) el.value = '';
    });
    document.getElementById('claimTeacherPreview').classList.add('hidden');
    document.getElementById('claimTeacherError').classList.add('hidden');
    document.getElementById('saveTeacherBtn').textContent = 'Register to National Registry';
    claimedTeacherDoc = null;
    openOverlay('addTeacherModal', 'addTeacherModalInner');
};

window.closeAddTeacherModal = () => {
    closeOverlay('addTeacherModal', 'addTeacherModalInner');
    claimedTeacherDoc = null;
};

// ── Look Up Existing Teacher ──────────────────────────────────────────────
document.getElementById('lookupTeacherBtn').addEventListener('click', async () => {
    const rawId   = document.getElementById('tGlobalId').value.trim().toUpperCase();
    const preview = document.getElementById('claimTeacherPreview');
    const error   = document.getElementById('claimTeacherError');
    preview.classList.add('hidden');
    error.classList.add('hidden');
    claimedTeacherDoc = null;

    if (!rawId) { alert('Enter a Global Teacher ID first.'); return; }

    const btn = document.getElementById('lookupTeacherBtn');
    btn.textContent = '...';
    btn.disabled = true;

    try {
        const snap = await getDoc(doc(db, 'teachers', rawId));
        if (!snap.exists()) {
            error.classList.remove('hidden');
        } else {
            claimedTeacherDoc = { id: snap.id, ...snap.data() };
            const d = claimedTeacherDoc;

            if (d.currentSchoolId === session.schoolId) {
                error.querySelector('p').textContent = 'This teacher is already active at your facility.';
                error.classList.remove('hidden');
                claimedTeacherDoc = null;
            } else {
                document.getElementById('claimTeacherName').textContent   = d.name || 'Unknown';
                document.getElementById('claimTeacherSchool').innerHTML   =
                    (d.currentSchoolId ? `Currently at: ${d.currentSchoolId}` : 'Not currently assigned to a school') +
                    (!d.email
                        ? `<br><span style="color:#d97706;font-size:10.5px;font-weight:700;">⚠ No email on file — teacher must add one during first login setup.</span>`
                        : `<br><span style="color:#059669;font-size:10.5px;font-weight:600;">✓ Email on file: ${escHtml(d.email)}</span>`);
                preview.classList.remove('hidden');
                document.getElementById('saveTeacherBtn').textContent = `Claim ${d.name} to This School`;
            }
        }
    } catch (e) {
        console.error('[Teachers] lookup:', e);
        alert('Lookup failed. Try again.');
    }

    btn.textContent = 'Look Up';
    btn.disabled = false;
});

// ── Save (Claim or Create) ────────────────────────────────────────────────
document.getElementById('saveTeacherBtn').addEventListener('click', async () => {
    const btn = document.getElementById('saveTeacherBtn');
    btn.disabled = true;
    btn.innerHTML = `<i class="fa-solid fa-spinner fa-spin mr-2"></i>Processing...`;

    try {
        // ── Check teacher limit before any add action ──────────────────────
        const limitCheck = await isTeacherLimitReached();
        if (limitCheck.reached) {
            alert(`Teacher limit reached (${limitCheck.current} of ${limitCheck.limit}). Contact ConnectUs to upgrade your plan.`);
            btn.disabled = false;
            btn.textContent = claimedTeacherDoc ? `Claim ${claimedTeacherDoc.name} to This School` : 'Register to National Registry';
            return;
        }

        if (claimedTeacherDoc) {
            // ── CLAIM WORKFLOW ────────────────────────────────────────────
            const tRef    = doc(db, 'teachers', claimedTeacherDoc.id);
            const updates = { currentSchoolId: session.schoolId };
            if (claimedTeacherDoc.currentSchoolId && claimedTeacherDoc.currentSchoolId !== '') {
                updates.archivedSchoolIds = arrayUnion(claimedTeacherDoc.currentSchoolId);
            }
            await updateDoc(tRef, updates);

        } else {
            // ── CREATE WORKFLOW ───────────────────────────────────────────
            const name  = document.getElementById('tName').value.trim();
            const email = document.getElementById('tEmail').value.trim();
            const phone = document.getElementById('tPhone').value.trim();

            if (!name) {
                alert('Teacher name is required.');
                btn.disabled = false; btn.textContent = 'Register to National Registry'; return;
            }
            if (!email) {
                alert('Email address is required. The teacher needs it to recover their PIN if forgotten.');
                btn.disabled = false; btn.textContent = 'Register to National Registry'; return;
            }
            if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) {
                alert('Please enter a valid email address.');
                btn.disabled = false; btn.textContent = 'Register to National Registry'; return;
            }

            const newId = generateTeacherId();
            await setDoc(doc(db, 'teachers', newId), {
                name,
                email,
                phone,
                pin:               generatePin(),
                currentSchoolId:   session.schoolId,
                archivedSchoolIds: [],
                profileComplete:   false,
                securityQuestionsSet: false,
                requiresPinReset:  true, // <--- CHANGED TO TRUE: Forces PIN reset on first login
                subjects: [
                    { id: `sub_${Date.now()}_1`, name: 'Mathematics',           archived: false, description: '' },
                    { id: `sub_${Date.now()}_2`, name: 'English Language Arts', archived: false, description: '' },
                    { id: `sub_${Date.now()}_3`, name: 'Science',               archived: false, description: '' }
                ],
                classes:            [],
                className:          '',
                customGradeTypes:   ['Test','Quiz','Assignment','Homework','Project','Midterm Exam','Final Exam'],
                archivedGradeTypes: [],
                createdAt:          new Date().toISOString()
            });
        }

        window.closeAddTeacherModal();
        loadTeachers();
    } catch (e) {
        console.error('[Teachers] save:', e);
        alert('System Error. Check console.');
    }

    btn.disabled = false;
    btn.textContent = 'Register to National Registry';
});

// ── 7. TEACHER PANEL ──────────────────────────────────────────────────────
window.openTeacherPanel = async (teacherId) => {
    currentTeacherId = teacherId;
    isEditMode       = false;

    document.getElementById('tPanelLoader').classList.remove('hidden');
    document.getElementById('tViewMode').classList.add('hidden');
    document.getElementById('tEditMode').classList.add('hidden');

    openOverlay('teacherPanel', 'teacherPanelInner', true);

    try {
        const snap = await getDoc(doc(db, 'teachers', teacherId));
        if (!snap.exists()) return;

        const t        = { id: snap.id, ...snap.data() };
        const classes  = getTeacherClasses(t);
        const subNames = getSubjectNames(t.subjects);

        document.getElementById('tPanelName').textContent  = t.name;
        document.getElementById('tPanelClass').textContent = classes.length ? classes.join(' · ') : 'No class assigned';

        document.getElementById('tInfoGrid').innerHTML = [
            ['National ID', `<span class="font-mono tracking-widest">${t.id}</span>`],
            ['Email',       escHtml(t.email) || '<span class="text-amber-500 font-black text-[11px]">⚠ Not set — required for PIN recovery</span>'],
            ['Phone',       escHtml(t.phone) || '—'],
            ['Profile',     t.profileComplete
                ? '<span class="text-green-600 font-black">Complete</span>'
                : '<span class="text-amber-500 font-black">Pending Setup</span>'],
            ['Security Q\'s', t.securityQuestionsSet
                ? '<span class="text-green-600 font-black">Set</span>'
                : '<span class="text-amber-500 font-black">Not set yet</span>']
        ].map(([l, v]) => `
            <div class="bg-white border border-[#dce3ed] rounded-lg p-3">
                <p class="text-[9px] font-bold text-[#6b84a0] uppercase tracking-widest mb-1">${l}</p>
                <p class="font-bold text-[#0d1f35] text-[13px]">${v}</p>
            </div>`).join('');

        document.getElementById('tClassTags').innerHTML = classes.length
            ? classes.map(c => `<span class="bg-[#eef4ff] text-[#2563eb] border border-[#c7d9fd] font-bold text-[11px] px-3 py-1 rounded">${escHtml(c)}</span>`).join('')
            : '<span class="text-[11px] text-[#9ab0c6] font-semibold italic">No classes assigned yet.</span>';

        document.getElementById('tSubjectTags').innerHTML = subNames.length
            ? subNames.map(s => `<span class="bg-[#f8fafb] text-[#374f6b] border border-[#dce3ed] font-bold text-[11px] px-3 py-1 rounded">${escHtml(s)}</span>`).join('')
            : '<span class="text-[11px] text-[#9ab0c6] font-semibold italic">No subjects recorded yet.</span>';

        document.getElementById('tSlipId').textContent  = t.id;
        document.getElementById('tSlipPin').textContent = t.pin;

        document.getElementById('editTName').value  = t.name  || '';
        document.getElementById('editTEmail').value = t.email || '';
        document.getElementById('editTPhone').value = t.phone || '';


        // -- Load evaluations summary
        try {
            const evalSnap = await getDocs(query(
                collection(db, 'teachers', teacherId, 'evaluations'),
                where('schoolId', '==', session.schoolId)
            ));
            const evals   = evalSnap.docs.map(d => ({ id: d.id, ...d.data() }));
            const count   = evals.length;
            const avgNum  = count ? evals.reduce((s, e) => s + (e.overallRating || 0), 0) / count : null;
            const avg     = avgNum !== null ? avgNum.toFixed(1) : null;
            const last    = count ? evals.sort((a, b) => new Date(b.date) - new Date(a.date))[0] : null;
            const lastStr = last?.date
                ? new Date(last.date).toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' })
                : null;

            const stars = avg
                ? [1,2,3,4,5].map(n => '<span style="color:' + (n <= Math.round(parseFloat(avg)) ? '#f59e0b' : '#dce3ed') + ';font-size:15px">&#9733;</span>').join('')
                : null;

            const evalSummaryEl = document.getElementById('tEvalSummary');
            if (evalSummaryEl) {
                if (!count) {
                    evalSummaryEl.innerHTML = '<p style="font-size:12px;color:#9ab0c6;font-style:italic;text-align:center;padding:8px 0">No evaluations on record.</p>';
                } else {
                    evalSummaryEl.innerHTML =
                        '<div style="display:flex;align-items:center;justify-content:space-between;margin-bottom:8px">' +
                            '<div style="display:flex;align-items:baseline;gap:6px">' +
                                '<span style="font-size:22px;font-weight:700;color:#0d1f35">' + avg + '</span>' +
                                '<span style="font-size:11px;color:#6b84a0;font-weight:600">/ 5</span>' +
                            '</div>' +
                            '<div>' + stars + '</div>' +
                        '</div>' +
                        '<div style="display:flex;justify-content:space-between">' +
                            '<span style="font-size:11px;color:#6b84a0;font-weight:600">' + count + ' evaluation' + (count !== 1 ? 's' : '') + '</span>' +
                            (lastStr ? '<span style="font-size:11px;color:#6b84a0;font-weight:600">Last: ' + lastStr + '</span>' : '') +
                        '</div>';
                }
            }
        } catch (_) {}

        document.getElementById('tPanelLoader').classList.add('hidden');
        document.getElementById('tViewMode').classList.remove('hidden');

    } catch (e) {
        console.error('[Teachers] openTeacherPanel:', e);
        document.getElementById('tPanelLoader').innerHTML =
            `<p class="text-[#e31b4a] font-bold text-center py-10">Error loading teacher details.</p>`;
    }
};

window.closeTeacherPanel = () => closeOverlay('teacherPanel', 'teacherPanelInner', true);

window.editTeacherToggle = (show) => {
    isEditMode = show !== undefined ? show : !isEditMode;
    document.getElementById('tViewMode').classList.toggle('hidden', isEditMode);
    document.getElementById('tEditMode').classList.toggle('hidden', !isEditMode);
    document.getElementById('editTeacherMsg').classList.add('hidden');
};

document.getElementById('saveTeacherEditBtn').addEventListener('click', async () => {
    const btn   = document.getElementById('saveTeacherEditBtn');
    const email = document.getElementById('editTEmail').value.trim();

    if (!email) {
        const msg = document.getElementById('editTeacherMsg');
        msg.textContent = 'Email address is required for PIN recovery.';
        msg.className   = 'text-[11px] font-bold p-3 rounded mt-3 text-center text-red-600 bg-red-50 border border-red-100';
        msg.classList.remove('hidden'); return;
    }
    if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) {
        const msg = document.getElementById('editTeacherMsg');
        msg.textContent = 'Please enter a valid email address.';
        msg.className   = 'text-[11px] font-bold p-3 rounded mt-3 text-center text-red-600 bg-red-50 border border-red-100';
        msg.classList.remove('hidden'); return;
    }

    btn.innerHTML = `<i class="fa-solid fa-spinner fa-spin mr-2"></i>Saving...`;
    btn.disabled  = true;

    try {
        await updateDoc(doc(db, 'teachers', currentTeacherId), {
            name:  document.getElementById('editTName').value.trim(),
            email,
            phone: document.getElementById('editTPhone').value.trim()
        });
        window.editTeacherToggle(false);
        window.openTeacherPanel(currentTeacherId);
        loadTeachers();
    } catch (e) {
        console.error('[Teachers] saveEdit:', e);
        const msg = document.getElementById('editTeacherMsg');
        msg.textContent = 'Error saving changes.';
        msg.className   = 'text-[11px] font-bold p-3 rounded mt-3 text-center text-red-600 bg-red-50 border border-red-100';
        msg.classList.remove('hidden');
    }

    btn.innerHTML = 'Save Changes';
    btn.disabled  = false;
});

// ── 8. CREDENTIAL SLIP PRINT ──────────────────────────────────────────────
window.printTeacherSlip = () => {
    const id   = document.getElementById('tSlipId').textContent;
    const pin  = document.getElementById('tSlipPin').textContent;
    const name = document.getElementById('tPanelName').textContent;

    const html = `<html><head><title>Teacher Credential Slip</title>
    <style>
        body { font-family:'Helvetica Neue',Arial,sans-serif; display:flex; justify-content:center; align-items:center; height:100vh; margin:0; background:#f4f7fb; }
        .slip { background:white; border:2px solid #dce3ed; border-top:4px solid #2563eb; border-radius:12px; padding:32px 40px; max-width:340px; text-align:center; }
        .logo { font-size:11px; font-weight:900; letter-spacing:0.3em; color:#6b84a0; text-transform:uppercase; margin-bottom:20px; }
        h2 { font-size:16px; color:#0d1f35; font-weight:900; margin:0 0 4px 0; }
        .label { font-size:9px; font-weight:700; letter-spacing:0.15em; text-transform:uppercase; color:#6b84a0; margin-top:16px; margin-bottom:4px; }
        .id  { font-family:monospace; font-size:22px; font-weight:900; letter-spacing:0.2em; color:#0d1f35; }
        .pin { font-family:monospace; font-size:32px; font-weight:900; letter-spacing:0.4em; color:#2563eb; }
        .footer { font-size:9px; color:#9ab0c6; margin-top:20px; border-top:1px solid #f0f4f8; padding-top:12px; }
    </style></head><body>
    <div class="slip">
        <div class="logo">ConnectUs National Registry</div>
        <h2>${name}</h2>
        <p class="label">Global Teacher ID</p><p class="id">${id}</p>
        <p class="label">Login PIN</p><p class="pin">${pin}</p>
        <p class="footer">Keep this slip confidential.<br>Use these credentials to log into the ConnectUs Teacher Portal.</p>
    </div></body></html>`;

    const w = window.open('', '_blank');
    w.document.write(html);
    w.document.close();
    setTimeout(() => w.print(), 400);
};

// ── 9. EXIT EVALUATION ────────────────────────────────────────────────────
window.openExitModal = () => {
    document.getElementById('exitTeacherName').textContent = document.getElementById('tPanelName').textContent;
    ['exitReason','exitScore','exitComments'].forEach(id => document.getElementById(id).value = '');
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
    btn.innerHTML = `<i class="fa-solid fa-spinner fa-spin mr-2"></i>Securing Record...`;
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

    btn.innerHTML = `<i class="fa-solid fa-file-signature mr-2"></i>Submit Review & Archive Teacher`;
    btn.disabled  = false;
});

// ── 10. CSV EXPORT ────────────────────────────────────────────────────────
document.getElementById('exportCsvBtn').addEventListener('click', () => {
    const rows = [
        ['Global ID','Name','Email','Phone','Classes','Subjects','Students','PIN'],
        ...allTeachersCache.map(t => [
            t.id, t.name || '', t.email || '', t.phone || '',
            getTeacherClasses(t).join(' | '),
            getSubjectNames(t.subjects).join(' | '),
            t.studentCount || 0, t.pin || ''
        ])
    ];
    const csv = rows.map(r => r.map(v => `"${String(v ?? '').replace(/"/g,'""')}"`).join(',')).join('\n');
    const a = Object.assign(document.createElement('a'), {
        href:     URL.createObjectURL(new Blob([csv], { type: 'text/csv' })),
        download: `${session.schoolId}_teachers_${new Date().toISOString().slice(0,10)}.csv`
    });
    document.body.appendChild(a); a.click(); a.remove();
});

// ── BOOT ──────────────────────────────────────────────────────────────────
loadTeachers();
