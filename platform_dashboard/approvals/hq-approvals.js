import { db, storage } from '../../assets/js/firebase-init.js';
import { collection, query, where, getDocs, doc, getDoc, updateDoc, setDoc, orderBy } from "https://www.gstatic.com/firebasejs/10.7.1/firebase-firestore.js";
import { ref, uploadBytes, getDownloadURL } from "https://www.gstatic.com/firebasejs/10.7.1/firebase-storage.js";

// ── Boot Sequence ─────────────────────────────────────────────────────────────
const rawSession = localStorage.getItem('connectus_hq_session');
if (!rawSession) window.location.replace('../core/hq-login.html');
const session = JSON.parse(rawSession);

document.getElementById('hqAdminName').textContent  = session.name;
document.getElementById('hqAdminId').textContent    = session.id;
document.getElementById('hqAdminBadge').textContent = `Role: ${session.role}`;
if (session.role !== 'Owner') document.getElementById('navTeamBtn').classList.add('hidden');

document.getElementById('logoutBtn').addEventListener('click', () => {
    localStorage.removeItem('connectus_hq_session');
    window.location.replace('../core/hq-login.html');
});

// ── State ─────────────────────────────────────────────────────────────────────
let allPayPalSubs   = [];   // source === 'paypal'
let allManualQuotes = [];   // source !== 'paypal'
let currentQuote    = null;
let availablePlans  = [];
let activeTab       = 'paypal'; // 'paypal' | 'manual'

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

    document.getElementById('tabPayPal').classList.toggle('tab-active',  tab === 'paypal');
    document.getElementById('tabManual').classList.toggle('tab-active',  tab === 'manual');
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
            getDocs(query(collection(db, 'teachers'), where('email', '==', targetEmail))),
            getDocs(query(collection(db, 'students'), where('email', '==', targetEmail))),
            getDocs(query(collection(db, 'schools'),  where('contactEmail', '==', targetEmail))),
            getDocs(query(collection(db, 'quote_requests'), where('workEmail', '==', targetEmail)))
        ]);
        tSnap.forEach(d  => conflicts.push(`Teacher Account (ID: ${d.id})`));
        sSnap.forEach(d  => conflicts.push(`Student Account (ID: ${d.id})`));
        schSnap.forEach(d => conflicts.push(`School Admin (School ID: ${d.id})`));
        qSnap.forEach(d  => { if (d.id !== currentReqId) conflicts.push(`Other Quote (ID: ${d.id})`); });
        return conflicts.length ? conflicts : null;
    } catch (e) {
        console.error('Email check failed:', e);
        return ['Error checking database for conflicts.'];
    }
}

// ── Load subscription plans (for manual approval) ────────────────────────────
async function loadSubscriptionPlans() {
    const planSelect = document.getElementById('payPlan');
    try {
        const snap = await getDocs(collection(db, 'subscriptionPlans'));
        availablePlans = [];
        let options = '<option value="">Select a subscription tier...</option>';
        snap.forEach(d => {
            const data = { id: d.id, ...d.data() };
            availablePlans.push(data);
            options += `<option value="${data.id}">${escHtml(data.name)}</option>`;
        });
        planSelect.innerHTML = options;
    } catch (e) {
        console.error('Failed to load plans:', e);
        planSelect.innerHTML = '<option value="">Error loading plans</option>';
    }
}

document.getElementById('payPlan').addEventListener('change', (e) => {
    const display  = document.getElementById('planLimitsDisplay');
    const selected = availablePlans.find(p => p.id === e.target.value);
    if (selected) {
        display.innerHTML = `<i class="fa-solid fa-circle-check mr-1"></i> ${selected.studentLimit} Students · ${selected.teacherLimit} Teachers · ${selected.adminLimit} Admins`;
        display.classList.remove('hidden');
    } else {
        display.classList.add('hidden');
    }
});

// ── Load all data ─────────────────────────────────────────────────────────────
async function loadAll() {
    // Show loading in both panels
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
    const pendingPayPal  = allPayPalSubs.filter(s => !s.fulfilled).length;
    const pendingManual  = allManualQuotes.filter(q => !q.paymentCleared).length;
    document.getElementById('paypalBadge').textContent = pendingPayPal  || '';
    document.getElementById('manualBadge').textContent = pendingManual || '';
    document.getElementById('paypalBadge').classList.toggle('hidden', !pendingPayPal);
    document.getElementById('manualBadge').classList.toggle('hidden', !pendingManual);
}

// ── Render PayPal subscriptions table ────────────────────────────────────────
function renderPayPalTable() {
    const tbody = document.getElementById('paypalTableBody');

    if (!allPayPalSubs.length) {
        tbody.innerHTML = `<tr><td colspan="6" class="p-12 text-center text-slate-500 italic font-semibold">No self-service subscriptions yet.</td></tr>`;
        return;
    }

    tbody.innerHTML = allPayPalSubs.map(s => {
        const planName  = s.approvedPlanName  || '—';
        const billing   = s.approvedBillingCycle || '—';
        const limits    = s.approvedLimits    || {};
        const renewal   = formatDate(s.calculatedRenewalDate);
        const date      = formatDate(s.createdAt);

        let statusBadge;
        if (s.fulfilled) {
            statusBadge = `<span class="inline-flex items-center gap-1 bg-emerald-900/40 text-emerald-400 border border-emerald-800 px-2 py-1 rounded text-[10px] font-black uppercase tracking-wider"><i class="fa-solid fa-circle-check text-[8px]"></i> Fulfilled</span>`;
        } else {
            statusBadge = `<span class="inline-flex items-center gap-1 bg-blue-900/40 text-blue-400 border border-blue-800 px-2 py-1 rounded text-[10px] font-black uppercase tracking-wider"><i class="fa-solid fa-clock text-[8px]"></i> Awaiting Setup</span>`;
        }

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
                <span class="font-bold text-slate-300">${limits.adminLimit || '—'}</span> adm
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
        const date        = formatDate(q.createdAt);
        const isApproved  = q.paymentCleared;

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

    const s       = currentQuote;
    const limits  = s.approvedLimits || {};

    document.getElementById('ppSubId').textContent      = s.id;
    document.getElementById('ppPaypalId').textContent   = s.paypalSubscriptionId || '—';
    document.getElementById('ppName').textContent       = `${s.firstName || ''} ${s.lastName || ''}`.trim() || '—';
    document.getElementById('ppEmail').textContent      = s.workEmail || '—';
    document.getElementById('ppPlan').textContent       = s.approvedPlanName || '—';
    document.getElementById('ppBilling').textContent    = s.approvedBillingCycle || '—';
    document.getElementById('ppRenewal').textContent    = formatRenewal(s.calculatedRenewalDate);
    document.getElementById('ppCreated').textContent    = formatDate(s.createdAt);
    document.getElementById('ppSchool').textContent     = s.schoolName || '(Not yet set — pending onboarding)';
    document.getElementById('ppGenSchool').textContent  = s.generatedSchoolId || '—';

    document.getElementById('ppStudentLimit').value  = limits.studentLimit  || '';
    document.getElementById('ppTeacherLimit').value  = limits.teacherLimit  || '';
    document.getElementById('ppAdminLimit').value    = limits.adminLimit    || '';

    document.getElementById('ppEditEmail').value     = s.workEmail || '';

    // Status badge in modal
    const statusEl = document.getElementById('ppStatusBadge');
    if (s.fulfilled) {
        statusEl.className   = 'inline-flex items-center gap-1.5 bg-emerald-900/40 text-emerald-400 border border-emerald-800 px-3 py-1.5 rounded-lg text-xs font-black uppercase tracking-wider';
        statusEl.innerHTML   = '<i class="fa-solid fa-circle-check"></i> Fulfilled — School is Live';
    } else {
        statusEl.className   = 'inline-flex items-center gap-1.5 bg-blue-900/40 text-blue-400 border border-blue-800 px-3 py-1.5 rounded-lg text-xs font-black uppercase tracking-wider';
        statusEl.innerHTML   = '<i class="fa-solid fa-clock"></i> Awaiting Setup — Onboarding Link Sent';
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

        // Update on the quote_requests doc
        await updateDoc(doc(db, 'quote_requests', currentQuote.id), { approvedLimits: newLimits });

        // If school is already live, update the school doc limits too
        if (currentQuote.generatedSchoolId) {
            await updateDoc(doc(db, 'schools', currentQuote.generatedSchoolId), { limits: newLimits });
        }

        // Update local cache
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
    const btn    = document.getElementById('ppResendBtn');
    const msgEl  = document.getElementById('ppSaveMsg');
    const orig   = btn.innerHTML;
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
    currentQuote = allManualQuotes.find(q => q.id === reqId);
    if (!currentQuote) return;

    const q = currentQuote;

    // Remove any old warning
    document.getElementById('duplicateEmailWarning')?.remove();

    document.getElementById('vReqId').textContent    = q.id;
    document.getElementById('vName').textContent     = `${q.firstName || ''} ${q.lastName || ''}`.trim();
    document.getElementById('vRole').textContent     = q.jobTitle    || 'N/A';
    document.getElementById('vEmail').innerHTML      = `${escHtml(q.workEmail) || 'N/A'} <i class="fa-solid fa-circle-notch fa-spin text-slate-500 ml-2 text-[10px]" id="emailCheckSpin"></i>`;
    document.getElementById('vPhone').textContent    = q.phone       || 'N/A';
    document.getElementById('vSchoolName').textContent = q.schoolName || 'N/A';
    document.getElementById('vSchoolType').textContent = q.schoolType || 'N/A';

    const city    = q.city          || '';
    const state   = q.stateProvince ? `, ${q.stateProvince}` : '';
    const country = q.country       ? ` — ${q.country}`      : '';
    document.getElementById('vLocation').textContent     = `${city}${state}${country}` || 'N/A';
    document.getElementById('vStudents').textContent     = q.studentsCount || '0';
    document.getElementById('vTeachers').textContent     = q.teachersCount || '0';
    document.getElementById('vContractTerm').textContent = q.contractTerm  || 'Not Specified';

    let duration = 'Rolling';
    if (q.contractMonths) duration = `${q.contractMonths} Months`;
    if (q.contractYears)  duration = `${q.contractYears} Years`;
    document.getElementById('vContractDuration').textContent = duration;
    document.getElementById('vSource').textContent  = q.hearAboutUs || 'N/A';
    document.getElementById('vMessage').textContent = q.message     || 'No additional message.';

    // Background email check
    if (q.workEmail) {
        checkEmailGlobalUse(q.workEmail, reqId).then(conflicts => {
            document.getElementById('emailCheckSpin')?.remove();
            if (conflicts) {
                document.getElementById('vEmail').innerHTML = `<span class="text-red-400 font-bold">${escHtml(q.workEmail)}</span>`;
                const warnDiv = document.createElement('div');
                warnDiv.id        = 'duplicateEmailWarning';
                warnDiv.className = 'mt-3 p-3 bg-red-900/40 border border-red-500/50 rounded-lg text-red-200 text-xs leading-relaxed';
                warnDiv.innerHTML = `
                    <p class="font-bold text-red-400 mb-1"><i class="fa-solid fa-triangle-exclamation mr-1"></i> EMAIL ALREADY IN USE</p>
                    <ul class="list-disc list-inside pl-1 space-y-1 text-[11px] font-mono">${conflicts.map(c => `<li>${escHtml(c)}</li>`).join('')}</ul>
                    <p class="mt-2 text-[10px] text-red-300/80 italic">Contact the applicant to provide an alternative email.</p>`;
                document.getElementById('vEmail').parentNode.appendChild(warnDiv);
            }
        });
    }

    // Right panel
    if (q.paymentCleared) {
        document.getElementById('paymentFormContainer').classList.add('hidden');
        document.getElementById('manageLinkContainer').classList.remove('hidden');
        document.getElementById('editEmailInput').value = q.workEmail || '';
    } else {
        document.getElementById('paymentFormContainer').classList.remove('hidden');
        document.getElementById('manageLinkContainer').classList.add('hidden');
        document.getElementById('payPlan').value           = '';
        document.getElementById('planLimitsDisplay').classList.add('hidden');
        document.getElementById('payAmount').value         = '';
        document.getElementById('payCycle').value          = q.contractTerm === 'Annual' ? 'Annual' : q.contractTerm === 'Multi-Year' ? 'Multi-Year' : 'Monthly';
        document.getElementById('customCycleWrap').classList.add('hidden');
        document.getElementById('payCustomCycle').value    = '';
        document.getElementById('payNotes').value          = '';
        document.getElementById('payReceipt').value        = '';
        document.getElementById('paymentErrorMsg').classList.add('hidden');
    }

    showModal('manualModal');
};

window.closeManualModal = () => hideModal('manualModal');

document.getElementById('payCycle').addEventListener('change', (e) => {
    document.getElementById('customCycleWrap').classList.toggle('hidden', e.target.value !== 'Other');
});

// Manual approval
document.getElementById('confirmApproveBtn').addEventListener('click', async () => {
    const planId      = document.getElementById('payPlan').value;
    const amount      = document.getElementById('payAmount').value;
    const cycleSelect = document.getElementById('payCycle').value;
    const customCycle = document.getElementById('payCustomCycle').value;
    const notes       = document.getElementById('payNotes').value.trim();
    const receiptFile = document.getElementById('payReceipt').files[0];
    const errorMsg    = document.getElementById('paymentErrorMsg');

    if (!planId)             { errorMsg.textContent = 'Please select a Subscription Tier.'; errorMsg.classList.remove('hidden'); return; }
    if (!amount || amount <= 0) { errorMsg.textContent = 'Please enter a valid payment amount.'; errorMsg.classList.remove('hidden'); return; }

    const selectedPlan = availablePlans.find(p => p.id === planId);
    const actualCycle  = cycleSelect === 'Other' ? (customCycle || 'Custom') : cycleSelect;
    const btn          = document.getElementById('confirmApproveBtn');
    btn.disabled       = true;

    try {
        const paymentId = `PAY-${Date.now()}`;
        const timestamp = new Date().toISOString();
        let receiptUrl  = null;

        if (receiptFile) {
            btn.innerHTML = '<i class="fa-solid fa-cloud-arrow-up fa-spin mr-2"></i> Uploading Receipt...';
            const storageRef = ref(storage, `receipts/${paymentId}_${receiptFile.name}`);
            await uploadBytes(storageRef, receiptFile);
            receiptUrl = await getDownloadURL(storageRef);
        }

        btn.innerHTML = '<i class="fa-solid fa-circle-notch fa-spin mr-2"></i> Processing...';

        const notesArray     = notes ? [{ note: notes, timestamp, loggedBy: session.id, loggedByName: session.name }] : [];
        const nextRenewalDate = calculateRenewalDate(cycleSelect);

        await setDoc(doc(db, 'payments', paymentId), {
            reqId:             currentQuote.id,
            schoolName:        currentQuote.schoolName,
            paymentType:       'Initial Setup',
            amount:            parseFloat(amount),
            billingCycle:      actualCycle,
            subscriptionPlanId: selectedPlan.id,
            receiptUrl,
            internalNotes:     notesArray,
            loggedBy:          session.id,
            timestamp
        });

        await updateDoc(doc(db, 'quote_requests', currentQuote.id), {
            paymentCleared:        true,
            clearedAt:             timestamp,
            approvedBillingCycle:  actualCycle,
            calculatedRenewalDate: nextRenewalDate,
            approvedPlanId:        selectedPlan.id,
            approvedPlanName:      selectedPlan.name,
            approvedLimits: {
                adminLimit:   selectedPlan.adminLimit,
                studentLimit: selectedPlan.studentLimit,
                teacherLimit: selectedPlan.teacherLimit
            }
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

// Edit email on manual quote
document.getElementById('saveEmailBtn').addEventListener('click', async () => {
    const newEmail = document.getElementById('editEmailInput').value.trim();
    if (!newEmail) return;
    const btn = document.getElementById('saveEmailBtn');
    btn.innerHTML = '<i class="fa-solid fa-spinner fa-spin"></i>';

    const conflicts = await checkEmailGlobalUse(newEmail, currentQuote.id);
    if (conflicts) {
        alert('Cannot update to this email. Already in use:\n\n' + conflicts.join('\n'));
        btn.innerHTML = 'Save';
        return;
    }
    try {
        await updateDoc(doc(db, 'quote_requests', currentQuote.id), { workEmail: newEmail });
        currentQuote.workEmail = newEmail;
        document.getElementById('vEmail').textContent = newEmail;
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
    currentQuote = null;
}

function showSaveMsg(el, text, success) {
    el.textContent  = text;
    el.className    = `text-xs font-bold mt-3 ${success ? 'text-emerald-400' : 'text-red-400'}`;
    el.classList.remove('hidden');
    if (success) setTimeout(() => el.classList.add('hidden'), 3000);
}

function calculateRenewalDate(cycleType) {
    const date = new Date();
    if (cycleType === 'Monthly')    date.setMonth(date.getMonth() + 1);
    else if (cycleType === 'Annual') date.setFullYear(date.getFullYear() + 1);
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
