import { db, storage } from '../../assets/js/firebase-init.js';
import { collection, query, where, getDocs, doc, getDoc, updateDoc, setDoc, orderBy } from "https://www.gstatic.com/firebasejs/10.7.1/firebase-firestore.js";
import { ref, uploadBytes, getDownloadURL } from "https://www.gstatic.com/firebasejs/10.7.1/firebase-storage.js";

// ── Boot Sequence ─────────────────────────────────────────────────────────────
const rawSession = localStorage.getItem('connectus_hq_session');
if (!rawSession) window.location.replace('../hq-login.html');
const session = JSON.parse(rawSession);

document.getElementById('hqAdminName').textContent  = session.name;
document.getElementById('hqAdminId').textContent    = session.id;
document.getElementById('hqAdminBadge').textContent = `Role: ${session.role}`;
if (session.role !== 'Owner') document.getElementById('navTeamBtn').classList.add('hidden');

document.getElementById('logoutBtn').addEventListener('click', () => {
    localStorage.removeItem('connectus_hq_session');
    window.location.replace('../hq-login.html');
});

// ── State ─────────────────────────────────────────────────────────────────────
let allPayPalSubs   = [];
let allManualQuotes = [];
let currentQuote    = null;
let availablePlans  = [];
let activeTab       = 'paypal';
let contactEditMode = false;

// ── Helpers ───────────────────────────────────────────────────────────────────
function escHtml(str) {
    if (!str) return '';
    return String(str).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}

function formatDate(iso) {
    if (!iso) return '—';
    return new Date(iso).toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' });
}

function formatRenewal(iso) {
    if (!iso) return '—';
    return new Date(iso).toLocaleDateString('en-US', { month: 'long', day: 'numeric', year: 'numeric' });
}

// ── Tab switching ─────────────────────────────────────────────────────────────
window.switchTab = function(tab) {
    activeTab = tab;
    document.getElementById('tabPayPal').classList.toggle('tab-active',   tab === 'paypal');
    document.getElementById('tabManual').classList.toggle('tab-active',   tab === 'manual');
    document.getElementById('tabPayPal').classList.toggle('tab-inactive', tab !== 'paypal');
    document.getElementById('tabManual').classList.toggle('tab-inactive', tab !== 'manual');
    document.getElementById('paypalPanel').classList.toggle('hidden', tab !== 'paypal');
    document.getElementById('manualPanel').classList.toggle('hidden', tab !== 'manual');
};

// ── Global email scanner ──────────────────────────────────────────────────────
async function checkEmailGlobalUse(email, currentReqId) {
    if (!email) return null;
    const targetEmail = email.toLowerCase().trim();
    const conflicts   = [];
    try {
        const [tSnap, sSnap, schSnap, qSnap] = await Promise.all([
            getDocs(query(collection(db, 'teachers'),       where('email',        '==', targetEmail))),
            getDocs(query(collection(db, 'students'),       where('email',        '==', targetEmail))),
            getDocs(query(collection(db, 'schools'),        where('contactEmail', '==', targetEmail))),
            getDocs(query(collection(db, 'quote_requests'), where('workEmail',    '==', targetEmail)))
        ]);
        tSnap.forEach(d   => conflicts.push(`Teacher Account (ID: ${d.id})`));
        sSnap.forEach(d   => conflicts.push(`Student Account (ID: ${d.id})`));
        schSnap.forEach(d => conflicts.push(`School Admin (School ID: ${d.id})`));
        qSnap.forEach(d   => { if (d.id !== currentReqId) conflicts.push(`Other Quote (ID: ${d.id})`); });
        return conflicts.length ? conflicts : null;
    } catch (e) {
        console.error('Email check failed:', e);
        return ['Error checking database for conflicts.'];
    }
}

// ── Load subscription plans ───────────────────────────────────────────────────
async function loadSubscriptionPlans() {
    const planSelect = document.getElementById('payPlan');
    try {
        const snap = await getDocs(collection(db, 'subscriptionPlans'));
        availablePlans = [];
        let options = '<option value="">— Select a subscription tier —</option>';
        snap.forEach(d => {
            const data = { id: d.id, ...d.data() };
            availablePlans.push(data);
            options += `<option value="${data.id}">${escHtml(data.name)} — ${data.studentLimit} stu · ${data.teacherLimit} tch · ${data.adminLimit} adm</option>`;
        });
        options += `<option value="__custom__">Custom Plan (enter limits manually)</option>`;
        planSelect.innerHTML = options;
    } catch (e) {
        console.error('Failed to load plans:', e);
        planSelect.innerHTML = '<option value="">Error loading plans</option>';
    }
}

// ── Plan selection → auto-fill limits ────────────────────────────────────────
document.getElementById('payPlan').addEventListener('change', (e) => {
    const val      = e.target.value;
    const display  = document.getElementById('planLimitsDisplay');
    const stuInput = document.getElementById('payStudentLimit');
    const tchInput = document.getElementById('payTeacherLimit');
    const admInput = document.getElementById('payAdminLimit');

    if (val === '__custom__') {
        stuInput.value = '';
        tchInput.value = '';
        admInput.value = '';
        display.innerHTML = `<i class="fa-solid fa-pen mr-1"></i> Enter custom limits in the fields below`;
        display.classList.remove('hidden');
        display.className = 'text-[10px] font-bold text-amber-400 mt-2';
    } else {
        const selected = availablePlans.find(p => p.id === val);
        if (selected) {
            stuInput.value = selected.studentLimit || '';
            tchInput.value = selected.teacherLimit || '';
            admInput.value = selected.adminLimit   || '';
            display.innerHTML = `<i class="fa-solid fa-circle-check mr-1"></i> Limits auto-filled — adjust below if needed`;
            display.classList.remove('hidden');
            display.className = 'text-[10px] font-bold text-emerald-400 mt-2';
        } else {
            stuInput.value = '';
            tchInput.value = '';
            admInput.value = '';
            display.classList.add('hidden');
        }
    }
});

// ── Load all data ─────────────────────────────────────────────────────────────
async function loadAll() {
    document.getElementById('paypalTableBody').innerHTML = `
        <tr><td colspan="6" class="p-8 text-center text-emerald-400 font-semibold">
            <i class="fa-solid fa-spinner fa-spin mr-2"></i>Loading subscriptions...
        </td></tr>`;
    document.getElementById('manualTableBody').innerHTML = `
        <tr><td colspan="5" class="p-8 text-center text-emerald-400 font-semibold">
            <i class="fa-solid fa-spinner fa-spin mr-2"></i>Loading quotes...
        </td></tr>`;

    try {
        const snap = await getDocs(query(collection(db, 'quote_requests'), orderBy('createdAt', 'desc')));
        allPayPalSubs   = [];
        allManualQuotes = [];
        snap.forEach(d => {
            const data = { id: d.id, ...d.data() };
            if (data.source === 'paypal') {
                allPayPalSubs.push(data);
            } else {
                if (!data.fulfilled) allManualQuotes.push(data);
            }
        });
        renderPayPalTable();
        renderManualTable();
        updateBadges();
    } catch (e) {
        console.error('Failed to load data:', e);
        document.getElementById('paypalTableBody').innerHTML = `<tr><td colspan="6" class="p-8 text-center text-red-400 font-bold">Failed to load. Check Firestore rules.</td></tr>`;
        document.getElementById('manualTableBody').innerHTML = `<tr><td colspan="5" class="p-8 text-center text-red-400 font-bold">Failed to load. Check Firestore rules.</td></tr>`;
    }
}

function updateBadges() {
    const pendingPayPal = allPayPalSubs.filter(s => !s.fulfilled).length;
    const pendingManual = allManualQuotes.filter(q => !q.paymentCleared).length;
    document.getElementById('paypalBadge').textContent = pendingPayPal || '';
    document.getElementById('manualBadge').textContent = pendingManual || '';
    document.getElementById('paypalBadge').classList.toggle('hidden', !pendingPayPal);
    document.getElementById('manualBadge').classList.toggle('hidden', !pendingManual);
}

// ── Render PayPal table ───────────────────────────────────────────────────────
function renderPayPalTable() {
    const tbody = document.getElementById('paypalTableBody');
    if (!allPayPalSubs.length) {
        tbody.innerHTML = `<tr><td colspan="6" class="p-12 text-center text-slate-500 italic font-semibold">No self-service subscriptions yet.</td></tr>`;
        return;
    }
    tbody.innerHTML = allPayPalSubs.map(s => {
        const planName = s.approvedPlanName     || '—';
        const billing  = s.approvedBillingCycle || '—';
        const limits   = s.approvedLimits       || {};
        const renewal  = formatDate(s.calculatedRenewalDate);
        const date     = formatDate(s.createdAt);
        const statusBadge = s.fulfilled
            ? `<span class="inline-flex items-center gap-1 bg-emerald-900/40 text-emerald-400 border border-emerald-800 px-2 py-1 rounded text-[10px] font-black uppercase tracking-wider"><i class="fa-solid fa-circle-check text-[8px]"></i> Fulfilled</span>`
            : `<span class="inline-flex items-center gap-1 bg-blue-900/40 text-blue-400 border border-blue-800 px-2 py-1 rounded text-[10px] font-black uppercase tracking-wider"><i class="fa-solid fa-clock text-[8px]"></i> Awaiting Setup</span>`;
        return `
        <tr class="border-b border-slate-800 hover:bg-slate-800/40 transition cursor-pointer" onclick="window.openPayPalModal('${s.id}')">
            <td class="p-4 text-slate-400 text-xs">${date}</td>
            <td class="p-4">
                <p class="font-bold text-white text-sm">${escHtml(s.firstName)} ${escHtml(s.lastName)}</p>
                <p class="text-xs text-slate-500 mt-0.5">${escHtml(s.workEmail)}</p>
            </td>
            <td class="p-4">
                <p class="font-bold text-slate-200 text-sm">${escHtml(planName)}</p>
                <p class="text-xs text-slate-500 mt-0.5">${escHtml(billing)}</p>
            </td>
            <td class="p-4 text-xs text-slate-400">
                <span class="font-bold text-slate-300">${limits.studentLimit || '—'}</span> stu ·
                <span class="font-bold text-slate-300">${limits.teacherLimit || '—'}</span> tch ·
                <span class="font-bold text-slate-300">${limits.adminLimit   || '—'}</span> adm
            </td>
            <td class="p-4 text-xs text-slate-400">${renewal}</td>
            <td class="p-4 text-right">${statusBadge}</td>
        </tr>`;
    }).join('');
}

// ── Render manual quotes table ────────────────────────────────────────────────
function renderManualTable() {
    const tbody = document.getElementById('manualTableBody');
    if (!allManualQuotes.length) {
        tbody.innerHTML = `<tr><td colspan="5" class="p-12 text-center text-slate-500 italic font-semibold">Pipeline is clear. No pending quotes.</td></tr>`;
        return;
    }
    tbody.innerHTML = allManualQuotes.map(q => {
        const date       = formatDate(q.createdAt);
        const isApproved = q.paymentCleared;
        const statusBadge = isApproved
            ? `<span class="bg-blue-900/40 text-blue-400 border border-blue-800 px-2 py-1 rounded text-[10px] font-black uppercase tracking-wider">Link Sent</span>`
            : `<span class="bg-amber-900/40 text-amber-400 border border-amber-800 px-2 py-1 rounded text-[10px] font-black uppercase tracking-wider">Pending Payment</span>`;
        return `
        <tr class="border-b border-slate-800 hover:bg-slate-800/40 transition">
            <td class="p-4 text-slate-400 text-xs">${date}</td>
            <td class="p-4 font-bold text-white">${escHtml(q.schoolName) || '<span class="text-slate-500 italic">Not set</span>'}</td>
            <td class="p-4">
                <p class="font-bold text-slate-300 text-sm">${escHtml(q.firstName)} ${escHtml(q.lastName)}</p>
                <p class="text-xs text-slate-500">${escHtml(q.workEmail)}</p>
            </td>
            <td class="p-4">${statusBadge}</td>
            <td class="p-4 text-right">
                <button onclick="window.openManualModal('${q.id}')" class="bg-slate-700 hover:bg-slate-600 text-white font-bold px-4 py-1.5 rounded-lg text-xs transition border border-slate-600">
                    Manage
                </button>
            </td>
        </tr>`;
    }).join('');
}

// ── PayPal modal ──────────────────────────────────────────────────────────────
window.openPayPalModal = function(subId) {
    currentQuote = allPayPalSubs.find(s => s.id === subId);
    if (!currentQuote) return;
    const s      = currentQuote;
    const limits = s.approvedLimits || {};
    document.getElementById('ppSubId').textContent     = s.id;
    document.getElementById('ppPaypalId').textContent  = s.paypalSubscriptionId || '—';
    document.getElementById('ppName').textContent      = `${s.firstName || ''} ${s.lastName || ''}`.trim() || '—';
    document.getElementById('ppEmail').textContent     = s.workEmail || '—';
    document.getElementById('ppPlan').textContent      = s.approvedPlanName || '—';
    document.getElementById('ppBilling').textContent   = s.approvedBillingCycle || '—';
    document.getElementById('ppRenewal').textContent   = formatRenewal(s.calculatedRenewalDate);
    document.getElementById('ppCreated').textContent   = formatDate(s.createdAt);
    document.getElementById('ppSchool').textContent    = s.schoolName || '(Not yet set — pending onboarding)';
    document.getElementById('ppGenSchool').textContent = s.generatedSchoolId || '—';
    document.getElementById('ppStudentLimit').value = limits.studentLimit || '';
    document.getElementById('ppTeacherLimit').value = limits.teacherLimit || '';
    document.getElementById('ppAdminLimit').value   = limits.adminLimit   || '';
    document.getElementById('ppEditEmail').value    = s.workEmail || '';
    const statusEl = document.getElementById('ppStatusBadge');
    if (s.fulfilled) {
        statusEl.className = 'inline-flex items-center gap-1.5 bg-emerald-900/40 text-emerald-400 border border-emerald-800 px-3 py-1.5 rounded-lg text-xs font-black uppercase tracking-wider';
        statusEl.innerHTML = '<i class="fa-solid fa-circle-check"></i> Fulfilled — School is Live';
    } else {
        statusEl.className = 'inline-flex items-center gap-1.5 bg-blue-900/40 text-blue-400 border border-blue-800 px-3 py-1.5 rounded-lg text-xs font-black uppercase tracking-wider';
        statusEl.innerHTML = '<i class="fa-solid fa-clock"></i> Awaiting Setup — Onboarding Link Sent';
    }
    document.getElementById('ppSaveMsg').classList.add('hidden');
    showModal('paypalModal');
};

window.closePayPalModal = () => hideModal('paypalModal');

document.getElementById('ppSaveLimitsBtn').addEventListener('click', async () => {
    if (!currentQuote) return;
    const btn        = document.getElementById('ppSaveLimitsBtn');
    const msgEl      = document.getElementById('ppSaveMsg');
    const studentLim = parseInt(document.getElementById('ppStudentLimit').value);
    const teacherLim = parseInt(document.getElementById('ppTeacherLimit').value);
    const adminLim   = parseInt(document.getElementById('ppAdminLimit').value);
    if (isNaN(studentLim) || isNaN(teacherLim) || isNaN(adminLim) || studentLim < 1 || teacherLim < 1 || adminLim < 1) {
        showSaveMsg(msgEl, 'All limits must be valid numbers greater than 0.', false);
        return;
    }
    btn.innerHTML = '<i class="fa-solid fa-spinner fa-spin mr-1"></i> Saving...';
    btn.disabled  = true;
    try {
        const newLimits = { studentLimit: studentLim, teacherLimit: teacherLim, adminLimit: adminLim };
        await updateDoc(doc(db, 'quote_requests', currentQuote.id), { approvedLimits: newLimits });
        if (currentQuote.generatedSchoolId) {
            await updateDoc(doc(db, 'schools', currentQuote.generatedSchoolId), { limits: newLimits });
        }
        const idx = allPayPalSubs.findIndex(s => s.id === currentQuote.id);
        if (idx > -1) allPayPalSubs[idx].approvedLimits = newLimits;
        currentQuote.approvedLimits = newLimits;
        showSaveMsg(msgEl, '✓ Limits saved successfully.', true);
        renderPayPalTable();
    } catch (e) {
        console.error('Save limits failed:', e);
        showSaveMsg(msgEl, 'Error saving limits. Please try again.', false);
    }
    btn.innerHTML = '<i class="fa-solid fa-floppy-disk mr-1"></i> Save Limits';
    btn.disabled  = false;
});

document.getElementById('ppSaveEmailBtn').addEventListener('click', async () => {
    if (!currentQuote) return;
    const newEmail = document.getElementById('ppEditEmail').value.trim();
    const msgEl    = document.getElementById('ppSaveMsg');
    if (!newEmail) return;
    const btn = document.getElementById('ppSaveEmailBtn');
    btn.innerHTML = '<i class="fa-solid fa-spinner fa-spin"></i>';
    btn.disabled  = true;
    const conflicts = await checkEmailGlobalUse(newEmail, currentQuote.id);
    if (conflicts) {
        showSaveMsg(msgEl, 'Email already in use: ' + conflicts[0], false);
        btn.innerHTML = 'Update';
        btn.disabled  = false;
        return;
    }
    try {
        await updateDoc(doc(db, 'quote_requests', currentQuote.id), { workEmail: newEmail });
        currentQuote.workEmail = newEmail;
        document.getElementById('ppEmail').textContent = newEmail;
        const idx = allPayPalSubs.findIndex(s => s.id === currentQuote.id);
        if (idx > -1) allPayPalSubs[idx].workEmail = newEmail;
        showSaveMsg(msgEl, '✓ Email updated.', true);
        renderPayPalTable();
    } catch (e) {
        console.error(e);
        showSaveMsg(msgEl, 'Error updating email.', false);
    }
    btn.innerHTML = 'Update';
    btn.disabled  = false;
});

document.getElementById('ppResendBtn').addEventListener('click', async () => {
    if (!currentQuote) return;
    const btn   = document.getElementById('ppResendBtn');
    const msgEl = document.getElementById('ppSaveMsg');
    const orig  = btn.innerHTML;
    btn.innerHTML = '<i class="fa-solid fa-spinner fa-spin mr-2"></i> Sending...';
    btn.disabled  = true;
    try {
        await updateDoc(doc(db, 'quote_requests', currentQuote.id), { resendTrigger: Date.now() });
        btn.innerHTML = '<i class="fa-solid fa-check mr-2"></i> Sent!';
        showSaveMsg(msgEl, '✓ Onboarding email resent.', true);
        setTimeout(() => { btn.innerHTML = orig; btn.disabled = false; }, 3000);
    } catch (e) {
        console.error(e);
        btn.innerHTML = orig;
        btn.disabled  = false;
        showSaveMsg(msgEl, 'Error resending email.', false);
    }
});

// ── Manual quote modal ────────────────────────────────────────────────────────
window.openManualModal = function(reqId) {
    currentQuote    = allManualQuotes.find(q => q.id === reqId);
    contactEditMode = false;
    if (!currentQuote) return;
    const q = currentQuote;
    document.getElementById('duplicateEmailWarning')?.remove();
    renderContactReadOnly(q);
    if (q.paymentCleared) {
        document.getElementById('paymentFormContainer').classList.add('hidden');
        document.getElementById('manageLinkContainer').classList.remove('hidden');
        document.getElementById('editEmailInput').value = q.workEmail || '';
    } else {
        document.getElementById('paymentFormContainer').classList.remove('hidden');
        document.getElementById('manageLinkContainer').classList.add('hidden');
        document.getElementById('payPlan').value          = '';
        document.getElementById('planLimitsDisplay').classList.add('hidden');
        document.getElementById('payStudentLimit').value  = '';
        document.getElementById('payTeacherLimit').value  = '';
        document.getElementById('payAdminLimit').value    = '';
        document.getElementById('payAmount').value        = '';
        document.getElementById('payCycle').value         = q.contractTerm === 'Annual' ? 'Annual' : q.contractTerm === 'Multi-Year' ? 'Multi-Year' : 'Monthly';
        document.getElementById('customCycleWrap').classList.add('hidden');
        document.getElementById('payCustomCycle').value   = '';
        document.getElementById('payNotes').value         = '';
        document.getElementById('payReceipt').value       = '';
        document.getElementById('paymentErrorMsg').classList.add('hidden');
    }
    showModal('manualModal');
};

// ── Contact read-only render ──────────────────────────────────────────────────
function renderContactReadOnly(q) {
    const city     = q.city          || '';
    const state    = q.stateProvince ? `, ${q.stateProvince}` : '';
    const country  = q.country       ? ` — ${q.country}`      : '';
    const location = `${city}${state}${country}` || '—';

    document.getElementById('vReqId').textContent       = q.id;
    document.getElementById('vName').textContent        = `${q.firstName || ''} ${q.lastName || ''}`.trim() || '—';
    document.getElementById('vRole').textContent        = q.jobTitle    || '—';
    document.getElementById('vEmail').textContent       = q.workEmail   || '—';
    document.getElementById('vPhone').textContent       = q.phone       || '—';
    document.getElementById('vSchoolName').textContent  = q.schoolName  || '—';
    document.getElementById('vSchoolType').textContent  = q.schoolType  || '—';
    document.getElementById('vLocation').textContent    = location;
    document.getElementById('vStudents').textContent    = q.studentsCount || '0';
    document.getElementById('vTeachers').textContent    = q.teachersCount || '0';
    document.getElementById('vContractTerm').textContent= q.contractTerm  || 'Not Specified';

    let duration = 'Rolling';
    if (q.contractMonths) duration = `${q.contractMonths} Months`;
    if (q.contractYears)  duration = `${q.contractYears} Years`;
    document.getElementById('vContractDuration').textContent = duration;
    document.getElementById('vSource').textContent   = q.hearAboutUs || '—';
    document.getElementById('vMessage').textContent  = q.message     || 'No additional message.';

    document.getElementById('contactReadOnly').classList.remove('hidden');
    document.getElementById('contactEditForm').classList.add('hidden');
    document.getElementById('contactEditBtn').classList.remove('hidden');
    document.getElementById('contactSaveBtn').classList.add('hidden');
    document.getElementById('contactCancelBtn').classList.add('hidden');
    document.getElementById('contactSaveMsg').classList.add('hidden');
    contactEditMode = false;

    // Background email check
    document.getElementById('duplicateEmailWarning')?.remove();
    if (q.workEmail) {
        checkEmailGlobalUse(q.workEmail, q.id).then(conflicts => {
            if (!conflicts) return;
            const warnDiv = document.createElement('div');
            warnDiv.id        = 'duplicateEmailWarning';
            warnDiv.className = 'mt-3 p-3 bg-red-900/40 border border-red-500/50 rounded-lg text-red-200 text-xs leading-relaxed';
            warnDiv.innerHTML = `
                <p class="font-bold text-red-400 mb-1"><i class="fa-solid fa-triangle-exclamation mr-1"></i> EMAIL ALREADY IN USE</p>
                <ul class="list-disc list-inside pl-1 space-y-1 text-[11px] font-mono">${conflicts.map(c => `<li>${escHtml(c)}</li>`).join('')}</ul>
                <p class="mt-2 text-[10px] text-red-300/80 italic">Click Edit to fix the email before approving.</p>`;
            document.getElementById('vEmail')?.parentNode?.appendChild(warnDiv);
        });
    }
}

// ── Contact edit mode ─────────────────────────────────────────────────────────
window.activateContactEdit = function() {
    const q = currentQuote;
    if (!q) return;
    document.getElementById('eFirstName').value     = q.firstName     || '';
    document.getElementById('eLastName').value      = q.lastName      || '';
    document.getElementById('eEmail').value         = q.workEmail     || '';
    document.getElementById('ePhone').value         = q.phone         || '';
    document.getElementById('eSchoolName').value    = q.schoolName    || '';
    document.getElementById('eSchoolType').value    = q.schoolType    || '';
    document.getElementById('eCity').value          = q.city          || '';
    document.getElementById('eStateProvince').value = q.stateProvince || '';
    document.getElementById('eCountry').value       = q.country       || '';
    document.getElementById('eStudents').value      = q.studentsCount || '';
    document.getElementById('eTeachers').value      = q.teachersCount || '';
    document.getElementById('contactSaveMsg').classList.add('hidden');
    document.getElementById('contactReadOnly').classList.add('hidden');
    document.getElementById('contactEditForm').classList.remove('hidden');
    document.getElementById('contactEditBtn').classList.add('hidden');
    document.getElementById('contactSaveBtn').classList.remove('hidden');
    document.getElementById('contactCancelBtn').classList.remove('hidden');
    contactEditMode = true;
};

window.cancelContactEdit = function() {
    renderContactReadOnly(currentQuote);
};

window.saveContactInfo = async function() {
    const btn   = document.getElementById('contactSaveBtn');
    const orig  = btn.innerHTML;
    const firstName     = document.getElementById('eFirstName').value.trim();
    const lastName      = document.getElementById('eLastName').value.trim();
    const email         = document.getElementById('eEmail').value.trim().toLowerCase();
    const phone         = document.getElementById('ePhone').value.trim();
    const schoolName    = document.getElementById('eSchoolName').value.trim();
    const schoolType    = document.getElementById('eSchoolType').value.trim();
    const city          = document.getElementById('eCity').value.trim();
    const stateProvince = document.getElementById('eStateProvince').value.trim();
    const country       = document.getElementById('eCountry').value.trim();
    const studentsCount = parseInt(document.getElementById('eStudents').value) || 0;
    const teachersCount = parseInt(document.getElementById('eTeachers').value) || 0;

    if (!firstName || !lastName || !email) {
        showContactMsg('First name, last name, and email are required.', false); return;
    }
    if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) {
        showContactMsg('Please enter a valid email address.', false); return;
    }

    btn.innerHTML = '<i class="fa-solid fa-spinner fa-spin mr-1"></i> Saving...';
    btn.disabled  = true;

    if (email !== (currentQuote.workEmail || '').toLowerCase()) {
        const conflicts = await checkEmailGlobalUse(email, currentQuote.id);
        if (conflicts) {
            showContactMsg('Email already in use: ' + conflicts[0], false);
            btn.innerHTML = orig;
            btn.disabled  = false;
            return;
        }
    }

    try {
        const updates = {
            firstName, lastName,
            fullName: `${firstName} ${lastName}`.trim(),
            workEmail: email, phone, schoolName, schoolType,
            city, stateProvince, country, studentsCount, teachersCount
        };
        await updateDoc(doc(db, 'quote_requests', currentQuote.id), updates);
        Object.assign(currentQuote, updates);
        const idx = allManualQuotes.findIndex(q => q.id === currentQuote.id);
        if (idx > -1) Object.assign(allManualQuotes[idx], updates);
        renderContactReadOnly(currentQuote);
        renderManualTable();
        showContactMsg('✓ Contact info saved.', true);
    } catch (e) {
        console.error('Save contact failed:', e);
        showContactMsg('Error saving. Please try again.', false);
        btn.innerHTML = orig;
        btn.disabled  = false;
    }
};

function showContactMsg(text, success) {
    const msgEl = document.getElementById('contactSaveMsg');
    if (!msgEl) return;
    msgEl.textContent = text;
    msgEl.className   = `text-xs font-bold mt-3 ${success ? 'text-emerald-400' : 'text-red-400'}`;
    msgEl.classList.remove('hidden');
    if (success) setTimeout(() => msgEl.classList.add('hidden'), 3000);
}

window.closeManualModal = () => hideModal('manualModal');

document.getElementById('payCycle').addEventListener('change', (e) => {
    document.getElementById('customCycleWrap').classList.toggle('hidden', e.target.value !== 'Other');
});

// ── Manual approval ───────────────────────────────────────────────────────────
document.getElementById('confirmApproveBtn').addEventListener('click', async () => {
    const planId      = document.getElementById('payPlan').value;
    const amount      = document.getElementById('payAmount').value;
    const cycleSelect = document.getElementById('payCycle').value;
    const customCycle = document.getElementById('payCustomCycle').value.trim();
    const notes       = document.getElementById('payNotes').value.trim();
    const receiptFile = document.getElementById('payReceipt').files[0];
    const errorMsg    = document.getElementById('paymentErrorMsg');
    const studentLim  = parseInt(document.getElementById('payStudentLimit').value);
    const teacherLim  = parseInt(document.getElementById('payTeacherLimit').value);
    const adminLim    = parseInt(document.getElementById('payAdminLimit').value);

    if (!planId) {
        errorMsg.textContent = 'Please select a subscription tier.';
        errorMsg.classList.remove('hidden'); return;
    }
    if (!amount || parseFloat(amount) <= 0) {
        errorMsg.textContent = 'Please enter a valid payment amount.';
        errorMsg.classList.remove('hidden'); return;
    }
    if (isNaN(studentLim) || isNaN(teacherLim) || isNaN(adminLim) || studentLim < 1 || teacherLim < 1 || adminLim < 1) {
        errorMsg.textContent = 'Student, Teacher, and Admin limits must all be set and greater than 0.';
        errorMsg.classList.remove('hidden'); return;
    }

    errorMsg.classList.add('hidden');

    const isCustomPlan = planId === '__custom__';
    const selectedPlan = isCustomPlan ? null : availablePlans.find(p => p.id === planId);
    const planName     = isCustomPlan ? 'Custom Plan' : (selectedPlan?.name || planId);
    const actualCycle  = cycleSelect === 'Other' ? (customCycle || 'Custom') : cycleSelect;
    const btn          = document.getElementById('confirmApproveBtn');
    btn.disabled       = true;

    try {
        const paymentId   = `PAY-${Date.now()}`;
        const timestamp   = new Date().toISOString();
        let   receiptUrl  = null;

        if (receiptFile) {
            btn.innerHTML = '<i class="fa-solid fa-cloud-arrow-up fa-spin mr-2"></i> Uploading Receipt...';
            try {
                const storageRef = ref(storage, `receipts/${paymentId}_${receiptFile.name}`);
                await uploadBytes(storageRef, receiptFile);
                receiptUrl = await getDownloadURL(storageRef);
            } catch (uploadErr) {
                console.error('[Approvals] Receipt upload failed:', uploadErr);
                errorMsg.textContent = 'Receipt upload failed. Check your Storage rules, then try again. You can approve without a receipt by clearing the file selection.';
                errorMsg.classList.remove('hidden');
                btn.disabled  = false;
                btn.innerHTML = 'Mark as Paid & Activate <i class="fa-solid fa-arrow-right ml-1"></i>';
                return;
            }
        }

        btn.innerHTML = '<i class="fa-solid fa-circle-notch fa-spin mr-2"></i> Processing...';

        const notesArray      = notes ? [{ note: notes, timestamp, loggedBy: session.id, loggedByName: session.name }] : [];
        const nextRenewalDate = calculateRenewalDate(cycleSelect);
        const approvedLimits  = { studentLimit: studentLim, teacherLimit: teacherLim, adminLimit: adminLim };

        await setDoc(doc(db, 'payments', paymentId), {
            reqId:              currentQuote.id,
            schoolName:         currentQuote.schoolName || '',
            paymentType:        'Initial Setup',
            amount:             parseFloat(amount),
            billingCycle:       actualCycle,
            subscriptionPlanId: isCustomPlan ? 'custom' : (selectedPlan?.id || ''),
            receiptUrl,
            internalNotes:      notesArray,
            loggedBy:           session.id,
            timestamp
        });

        await updateDoc(doc(db, 'quote_requests', currentQuote.id), {
            paymentCleared:        true,
            clearedAt:             timestamp,
            approvedBillingCycle:  actualCycle,
            calculatedRenewalDate: nextRenewalDate,
            approvedPlanId:        isCustomPlan ? 'custom' : (selectedPlan?.id || ''),
            approvedPlanName:      planName,
            approvedLimits
        });

        hideModal('manualModal');
        await loadAll();
    } catch (e) {
        console.error('Approval failed:', e);
        errorMsg.textContent = 'An error occurred. Check console for details.';
        errorMsg.classList.remove('hidden');
    }

    btn.disabled  = false;
    btn.innerHTML = 'Mark as Paid & Approve <i class="fa-solid fa-arrow-right ml-1"></i>';
});

// ── Manage sent link ──────────────────────────────────────────────────────────
document.getElementById('saveEmailBtn').addEventListener('click', async () => {
    const newEmail = document.getElementById('editEmailInput').value.trim();
    if (!newEmail) return;
    const btn = document.getElementById('saveEmailBtn');
    btn.innerHTML = '<i class="fa-solid fa-spinner fa-spin"></i>';
    const conflicts = await checkEmailGlobalUse(newEmail, currentQuote.id);
    if (conflicts) {
        alert('Cannot update to this email. Already in use:\n\n' + conflicts.join('\n'));
        btn.innerHTML = 'Save'; return;
    }
    try {
        await updateDoc(doc(db, 'quote_requests', currentQuote.id), { workEmail: newEmail });
        currentQuote.workEmail = newEmail;
        document.getElementById('duplicateEmailWarning')?.remove();
        btn.innerHTML = '<i class="fa-solid fa-check"></i> Saved';
        setTimeout(() => btn.innerHTML = 'Save', 2000);
    } catch (e) {
        console.error(e);
        btn.innerHTML = 'Error';
        setTimeout(() => btn.innerHTML = 'Save', 2000);
    }
});

document.getElementById('resendLinkBtn').addEventListener('click', async () => {
    const btn  = document.getElementById('resendLinkBtn');
    const orig = btn.innerHTML;
    btn.innerHTML = '<i class="fa-solid fa-circle-notch fa-spin mr-2"></i> Sending...';
    try {
        await updateDoc(doc(db, 'quote_requests', currentQuote.id), { resendTrigger: Date.now() });
        btn.innerHTML = '<i class="fa-solid fa-check mr-2"></i> Sent!';
        setTimeout(() => { btn.innerHTML = orig; }, 3000);
    } catch (e) {
        console.error(e);
        alert('Failed to resend. Check console.');
        btn.innerHTML = orig;
    }
});

document.getElementById('revokeLinkBtn').addEventListener('click', async () => {
    if (!confirm('Revoke this approval? The onboarding link will stop working.')) return;
    const btn = document.getElementById('revokeLinkBtn');
    btn.innerHTML = '<i class="fa-solid fa-circle-notch fa-spin mr-2"></i> Revoking...';
    try {
        await updateDoc(doc(db, 'quote_requests', currentQuote.id), { paymentCleared: false });
        hideModal('manualModal');
        await loadAll();
    } catch (e) {
        console.error(e);
        alert('Failed to revoke.');
        btn.innerHTML = '<i class="fa-solid fa-ban mr-2"></i> Revoke Approval';
    }
});

// ── Modal utilities ───────────────────────────────────────────────────────────
function showModal(id) {
    const modal = document.getElementById(id);
    const inner = document.getElementById(id + 'Inner');
    modal.classList.remove('hidden');
    setTimeout(() => { modal.classList.remove('opacity-0'); inner?.classList.remove('scale-95'); }, 10);
}

function hideModal(id) {
    const modal = document.getElementById(id);
    const inner = document.getElementById(id + 'Inner');
    modal.classList.add('opacity-0');
    inner?.classList.add('scale-95');
    setTimeout(() => modal.classList.add('hidden'), 300);
    currentQuote    = null;
    contactEditMode = false;
}

function showSaveMsg(el, text, success) {
    el.textContent = text;
    el.className   = `text-xs font-bold mt-3 ${success ? 'text-emerald-400' : 'text-red-400'}`;
    el.classList.remove('hidden');
    if (success) setTimeout(() => el.classList.add('hidden'), 3000);
}

function calculateRenewalDate(cycleType) {
    const date = new Date();
    if      (cycleType === 'Monthly')    date.setMonth(date.getMonth() + 1);
    else if (cycleType === 'Annual')     date.setFullYear(date.getFullYear() + 1);
    else if (cycleType === 'Multi-Year') {
        const years = currentQuote?.contractYears ? parseInt(currentQuote.contractYears) : 2;
        date.setFullYear(date.getFullYear() + years);
    } else date.setFullYear(date.getFullYear() + 1);
    return date.toISOString();
}

// ── Refresh buttons ───────────────────────────────────────────────────────────
document.getElementById('refreshPaypalBtn').addEventListener('click', loadAll);
document.getElementById('refreshManualBtn').addEventListener('click', loadAll);

// ── Boot ──────────────────────────────────────────────────────────────────────
loadSubscriptionPlans().then(() => loadAll());
