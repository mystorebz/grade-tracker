import { db, storage } from '../../assets/js/firebase-init.js'; 
import { collection, query, where, getDocs, doc, updateDoc, setDoc, orderBy } from "https://www.gstatic.com/firebasejs/10.7.1/firebase-firestore.js";
import { ref, uploadBytes, getDownloadURL } from "https://www.gstatic.com/firebasejs/10.7.1/firebase-storage.js";

// ── Boot Sequence & Setup ────────────────────────────────────────────────
const rawSession = localStorage.getItem('connectus_hq_session');
if (!rawSession) window.location.replace('../core/hq-login.html');
const session = JSON.parse(rawSession);

document.getElementById('hqAdminName').textContent = session.name;
document.getElementById('hqAdminId').textContent = session.id;
document.getElementById('hqAdminBadge').textContent = `Role: ${session.role}`;
if (session.role !== 'Owner') document.getElementById('navTeamBtn').classList.add('hidden');

document.getElementById('logoutBtn').addEventListener('click', () => {
    localStorage.removeItem('connectus_hq_session');
    window.location.replace('../core/hq-login.html');
});

const tbody = document.getElementById('quotesTableBody');
let allQuotes = []; 
let currentQuote = null;
let availablePlans = []; // Store fetched subscription plans

// ── GLOBAL EMAIL SCANNER ──────────────────────────────────────────────────
async function checkEmailGlobalUse(email, currentReqId) {
    if (!email) return null;
    const targetEmail = email.toLowerCase().trim();
    let conflicts = [];

    try {
        // 1. Check Teachers
        const tSnap = await getDocs(query(collection(db, 'teachers'), where('email', '==', targetEmail)));
        tSnap.forEach(doc => conflicts.push(`Teacher Account (ID: ${doc.id})`));

        // 2. Check Students
        const sSnap = await getDocs(query(collection(db, 'students'), where('email', '==', targetEmail)));
        sSnap.forEach(doc => conflicts.push(`Student Account (ID: ${doc.id})`));

        // 3. Check Active Schools (Admins)
        const schSnap = await getDocs(query(collection(db, 'schools'), where('contactEmail', '==', targetEmail)));
        schSnap.forEach(doc => conflicts.push(`School Admin (School ID: ${doc.id})`));

        // 4. Check Pending Quote Requests
        const qSnap = await getDocs(query(collection(db, 'quote_requests'), where('workEmail', '==', targetEmail)));
        qSnap.forEach(doc => {
            if (doc.id !== currentReqId) {
                conflicts.push(`Other Pending Quote (Quote ID: ${doc.id})`);
            }
        });

        return conflicts.length > 0 ? conflicts : null;
    } catch(e) {
        console.error("Email check failed:", e);
        return ["Error checking database for conflicts."];
    }
}

// ── Load Subscription Plans ──────────────────────────────────────────────
async function loadSubscriptionPlans() {
    const planSelect = document.getElementById('payPlan');
    try {
        const snap = await getDocs(collection(db, 'subscriptionPlans'));
        availablePlans = [];
        let options = '<option value="">Select a subscription tier...</option>';
        
        snap.forEach(doc => {
            const data = doc.data();
            data.id = doc.id;
            availablePlans.push(data);
            options += `<option value="${data.id}">${data.name}</option>`;
        });
        planSelect.innerHTML = options;
    } catch (e) {
        console.error("Failed to load subscription plans:", e);
        planSelect.innerHTML = '<option value="">Error loading plans. Check Firebase rules.</option>';
    }
}

// Display Limits when a plan is selected
document.getElementById('payPlan').addEventListener('change', (e) => {
    const display = document.getElementById('planLimitsDisplay');
    const selected = availablePlans.find(p => p.id === e.target.value);
    
    if (selected) {
        display.innerHTML = `<i class="fa-solid fa-circle-check mr-1"></i> Limits: ${selected.studentLimit} Students | ${selected.teacherLimit} Teachers | ${selected.adminLimit} Admins`;
        display.classList.remove('hidden');
    } else {
        display.classList.add('hidden');
    }
});

// ── Load Quotes ────────────────────────────────────────────────────────────
async function loadQuotes() {
    tbody.innerHTML = `<tr><td colspan="5" class="p-8 text-center text-emerald-400 font-semibold"><i class="fa-solid fa-spinner fa-spin mr-2"></i>Scanning pipeline...</td></tr>`;
    
    try {
        const q = query(collection(db, 'quote_requests'), orderBy('createdAt', 'desc'));
        const snap = await getDocs(q);
        
        allQuotes = []; 
        let rows = '';
        let pendingCount = 0;

        snap.forEach(docSnap => {
            const data = docSnap.data();
            data.id = docSnap.id; 
            allQuotes.push(data); 

            if (data.fulfilled) return; 

            pendingCount++;
            const date = new Date(data.createdAt).toLocaleDateString();
            const isApproved = data.paymentCleared;
            
            const statusBadge = isApproved 
                ? `<span class="bg-blue-900/40 text-blue-400 border border-blue-800 px-2 py-1 rounded text-[10px] font-black uppercase tracking-wider">Link Sent</span>`
                : `<span class="bg-amber-900/40 text-amber-400 border border-amber-800 px-2 py-1 rounded text-[10px] font-black uppercase tracking-wider">Pending Payment</span>`;

            const actionBtn = `<button onclick="window.openApprovalModal('${data.id}')" class="bg-slate-700 hover:bg-slate-600 text-white font-bold px-4 py-1.5 rounded-lg text-xs transition border border-slate-600 shadow-md">Manage</button>`;

            rows += `
                <tr class="border-b border-slate-800 hover:bg-slate-800/50 transition">
                    <td class="p-4 text-slate-400">${date}</td>
                    <td class="p-4 font-bold text-white">${data.schoolName}</td>
                    <td class="p-4">
                        <p class="font-bold text-slate-300">${data.firstName} ${data.lastName}</p>
                        <p class="text-xs text-slate-500">${data.workEmail}</p>
                    </td>
                    <td class="p-4">${statusBadge}</td>
                    <td class="p-4 text-right">${actionBtn}</td>
                </tr>`;
        });

        tbody.innerHTML = pendingCount > 0 ? rows : `<tr><td colspan="5" class="p-8 text-center text-slate-500 font-semibold italic">Pipeline is clear. No pending quotes.</td></tr>`;

    } catch (e) {
        console.error("Failed to load quotes:", e);
        tbody.innerHTML = `<tr><td colspan="5" class="p-8 text-center text-red-400 font-bold">Failed to load data. Make sure rules are updated.</td></tr>`;
    }
}

// ── Form Interactions ────────────────────────────────────────────────────
document.getElementById('payCycle').addEventListener('change', (e) => {
    const customWrap = document.getElementById('customCycleWrap');
    if (e.target.value === 'Other') customWrap.classList.remove('hidden');
    else customWrap.classList.add('hidden');
});

// ── Modal Handlers (View & Populate Details) ─────────────────────────────
window.openApprovalModal = (reqId) => {
    currentQuote = allQuotes.find(q => q.id === reqId);
    if (!currentQuote) return;

    // Remove any old warning banners
    const oldWarning = document.getElementById('duplicateEmailWarning');
    if (oldWarning) oldWarning.remove();

    // 1. Populate UI - Left Side
    document.getElementById('vReqId').textContent = currentQuote.id;
    document.getElementById('vName').textContent = `${currentQuote.firstName} ${currentQuote.lastName}`;
    document.getElementById('vRole').textContent = currentQuote.jobTitle || 'N/A';
    
    // Set email with a loading spinner while we run the global check
    document.getElementById('vEmail').innerHTML = `${currentQuote.workEmail || 'N/A'} <i class="fa-solid fa-circle-notch fa-spin text-slate-500 ml-2 text-[10px]" id="emailCheckSpin"></i>`;
    
    document.getElementById('vPhone').textContent = currentQuote.phone || 'N/A';
    
    document.getElementById('vSchoolName').textContent = currentQuote.schoolName;
    document.getElementById('vSchoolType').textContent = currentQuote.schoolType || 'N/A';
    const city = currentQuote.city || '';
    const state = currentQuote.stateProvince ? `, ${currentQuote.stateProvince}` : '';
    const country = currentQuote.country ? ` - ${currentQuote.country}` : '';
    document.getElementById('vLocation').textContent = `${city}${state}${country}`;
    
    document.getElementById('vStudents').textContent = currentQuote.studentsCount || '0';
    document.getElementById('vTeachers').textContent = currentQuote.teachersCount || '0';
    
    document.getElementById('vContractTerm').textContent = currentQuote.contractTerm || 'Not Specified';
    let duration = "Rolling";
    if (currentQuote.contractMonths) duration = `${currentQuote.contractMonths} Months`;
    if (currentQuote.contractYears) duration = `${currentQuote.contractYears} Years`;
    document.getElementById('vContractDuration').textContent = duration;
    
    document.getElementById('vSource').textContent = currentQuote.hearAboutUs || 'N/A';
    document.getElementById('vMessage').textContent = currentQuote.message || 'No additional message provided.';

    // Run Background Check for duplicate email
    if (currentQuote.workEmail) {
        checkEmailGlobalUse(currentQuote.workEmail, reqId).then(conflicts => {
            const spinner = document.getElementById('emailCheckSpin');
            if (spinner) spinner.remove();

            if (conflicts) {
                // Highlight the email in red
                document.getElementById('vEmail').innerHTML = `<span class="text-red-400 font-bold">${currentQuote.workEmail}</span>`;
                
                // Build the warning banner
                const warnDiv = document.createElement('div');
                warnDiv.id = 'duplicateEmailWarning';
                warnDiv.className = 'mt-3 p-3 bg-red-900/40 border border-red-500/50 rounded-lg text-red-200 text-xs leading-relaxed';
                warnDiv.innerHTML = `
                    <p class="font-bold text-red-400 mb-1"><i class="fa-solid fa-triangle-exclamation mr-1"></i> EMAIL ALREADY IN USE</p>
                    <ul class="list-disc list-inside pl-1 space-y-1 text-[11px] font-mono">
                        ${conflicts.map(c => `<li>${c}</li>`).join('')}
                    </ul>
                    <p class="mt-2 text-[10px] text-red-300/80 italic">Contact the applicant to provide an alternative email, or edit it using the panel on the right.</p>`;
                
                // Inject right under the email element's parent container
                const emailContainer = document.getElementById('vEmail').parentNode;
                emailContainer.appendChild(warnDiv);
            }
        });
    }

    // 2. Logic Switch: Which right-side panel do we show?
    if (currentQuote.paymentCleared) {
        document.getElementById('paymentFormContainer').classList.add('hidden');
        document.getElementById('manageLinkContainer').classList.remove('hidden');
        document.getElementById('editEmailInput').value = currentQuote.workEmail;
    } else {
        document.getElementById('paymentFormContainer').classList.remove('hidden');
        document.getElementById('manageLinkContainer').classList.add('hidden');
        
        // Reset Inputs
        document.getElementById('payPlan').value = '';
        document.getElementById('planLimitsDisplay').classList.add('hidden');
        document.getElementById('payAmount').value = '';
        const cycleSelect = document.getElementById('payCycle');
        if (currentQuote.contractTerm === 'Annual') cycleSelect.value = 'Annual';
        else if (currentQuote.contractTerm === 'Multi-Year') cycleSelect.value = 'Multi-Year';
        else cycleSelect.value = 'Monthly';
        
        document.getElementById('customCycleWrap').classList.add('hidden');
        document.getElementById('payCustomCycle').value = ''; 
        document.getElementById('payNotes').value = ''; 
        document.getElementById('payReceipt').value = ''; 
        document.getElementById('paymentErrorMsg').classList.add('hidden');
    }
    
    // 3. Show Modal
    const modal = document.getElementById('paymentModal');
    const inner = document.getElementById('paymentModalInner');
    modal.classList.remove('hidden');
    setTimeout(() => { modal.classList.remove('opacity-0'); inner.classList.remove('scale-95'); }, 10);
};

const closePaymentModal = () => {
    const modal = document.getElementById('paymentModal');
    const inner = document.getElementById('paymentModalInner');
    modal.classList.add('opacity-0'); inner.classList.add('scale-95');
    setTimeout(() => modal.classList.add('hidden'), 300);
    currentQuote = null;
};
document.getElementById('closeModalBtnDesktop').addEventListener('click', closePaymentModal);
document.getElementById('closeModalBtnMobile').addEventListener('click', closePaymentModal);

// ── Calculate Renewal Date Helper ─────────────────────────────────────────
function calculateRenewalDate(cycleType) {
    const date = new Date();
    if (cycleType === 'Monthly') {
        date.setMonth(date.getMonth() + 1);
    } else if (cycleType === 'Annual') {
        date.setFullYear(date.getFullYear() + 1);
    } else if (cycleType === 'Multi-Year') {
        const years = currentQuote.contractYears ? parseInt(currentQuote.contractYears) : 2;
        date.setFullYear(date.getFullYear() + years);
    } else {
        date.setFullYear(date.getFullYear() + 1);
    }
    return date.toISOString();
}

// ── LOGIC A: Process Initial Approval ─────────────────────────────────────
document.getElementById('confirmApproveBtn').addEventListener('click', async () => {
    const planId = document.getElementById('payPlan').value;
    const amount = document.getElementById('payAmount').value;
    const cycleSelect = document.getElementById('payCycle').value;
    const customCycle = document.getElementById('payCustomCycle').value;
    const internalNote = document.getElementById('payNotes').value.trim();
    const receiptFile = document.getElementById('payReceipt').files[0]; 
    const errorMsg = document.getElementById('paymentErrorMsg');

    if (!planId) {
        errorMsg.textContent = "Please select a Subscription Tier.";
        errorMsg.classList.remove('hidden'); return;
    }
    if (!amount || amount <= 0) {
        errorMsg.textContent = "Please enter a valid payment amount.";
        errorMsg.classList.remove('hidden'); return;
    }

    const selectedPlan = availablePlans.find(p => p.id === planId);
    const actualCycle = cycleSelect === 'Other' ? (customCycle || 'Custom') : cycleSelect;
    const btn = document.getElementById('confirmApproveBtn');
    btn.disabled = true;

    try {
        const paymentId = `PAY-${Date.now()}`;
        const timestamp = new Date().toISOString();
        let receiptUrl = null;

        if (receiptFile) {
            btn.innerHTML = '<i class="fa-solid fa-cloud-arrow-up fa-spin mr-2"></i> Uploading Receipt...';
            const storageRef = ref(storage, `receipts/${paymentId}_${receiptFile.name}`);
            await uploadBytes(storageRef, receiptFile);
            receiptUrl = await getDownloadURL(storageRef);
        }

        btn.innerHTML = '<i class="fa-solid fa-circle-notch fa-spin mr-2"></i> Logging Invoice...';

        const notesArray = internalNote ? [{
            note: internalNote,
            timestamp: timestamp,
            loggedBy: session.id,
            loggedByName: session.name
        }] : [];

        const nextRenewalDate = calculateRenewalDate(cycleSelect);

        // 1. Log Payment
        await setDoc(doc(db, 'payments', paymentId), {
            reqId: currentQuote.id,
            schoolName: currentQuote.schoolName,
            paymentType: 'Initial Setup',
            amount: parseFloat(amount),
            billingCycle: actualCycle,
            subscriptionPlanId: selectedPlan.id,
            receiptUrl: receiptUrl, 
            internalNotes: notesArray,
            loggedBy: session.id,
            timestamp: timestamp
        });

        // 2. Update Quote with Plan Limits (This triggers the Cloud Function email)
        await updateDoc(doc(db, 'quote_requests', currentQuote.id), {
            paymentCleared: true,
            clearedAt: timestamp,
            approvedBillingCycle: actualCycle,
            calculatedRenewalDate: nextRenewalDate,
            approvedPlanId: selectedPlan.id,
            approvedPlanName: selectedPlan.name,
            approvedLimits: {
                adminLimit: selectedPlan.adminLimit,
                studentLimit: selectedPlan.studentLimit,
                teacherLimit: selectedPlan.teacherLimit
            }
        });

        closePaymentModal();
        loadQuotes(); 

    } catch (e) {
        console.error("Approval Failed:", e);
        errorMsg.textContent = "An error occurred during approval. Check console for details.";
        errorMsg.classList.remove('hidden');
    }

    btn.disabled = false;
    btn.innerHTML = 'Mark as Paid & Approve <i class="fa-solid fa-arrow-right ml-1"></i>';
});

// ── LOGIC B: Manage Sent Links ────────────────────────────────────────────

document.getElementById('saveEmailBtn').addEventListener('click', async () => {
    const newEmail = document.getElementById('editEmailInput').value.trim();
    if(!newEmail) return;
    const btn = document.getElementById('saveEmailBtn');
    btn.innerHTML = '<i class="fa-solid fa-spinner fa-spin"></i>';
    
    // Check before allowing edit
    const conflicts = await checkEmailGlobalUse(newEmail, currentQuote.id);
    if (conflicts) {
        alert("Cannot update to this email. It is already in use by:\n\n" + conflicts.join("\n"));
        btn.innerHTML = 'Save';
        return;
    }

    try {
        await updateDoc(doc(db, 'quote_requests', currentQuote.id), { workEmail: newEmail });
        currentQuote.workEmail = newEmail; 
        document.getElementById('vEmail').textContent = newEmail;
        
        const oldWarning = document.getElementById('duplicateEmailWarning');
        if (oldWarning) oldWarning.remove();

        btn.innerHTML = '<i class="fa-solid fa-check"></i> Saved';
        setTimeout(() => btn.innerHTML = 'Save', 2000);
    } catch(e) {
        console.error(e);
        btn.innerHTML = 'Error';
        setTimeout(() => btn.innerHTML = 'Save', 2000);
    }
});

document.getElementById('resendLinkBtn').addEventListener('click', async () => {
    const btn = document.getElementById('resendLinkBtn');
    const originalText = btn.innerHTML;
    btn.innerHTML = '<i class="fa-solid fa-circle-notch fa-spin mr-2"></i> Sending...';
    try {
        // Trigger the Cloud Function to resend the email
        await updateDoc(doc(db, 'quote_requests', currentQuote.id), { resendTrigger: Date.now() });
        btn.innerHTML = '<i class="fa-solid fa-check mr-2"></i> Email Sent!';
        setTimeout(() => btn.innerHTML = originalText, 3000);
    } catch(e) {
        console.error(e);
        alert("Failed to resend the email. Please check console.");
        btn.innerHTML = originalText;
    }
});

document.getElementById('revokeLinkBtn').addEventListener('click', async () => {
    if(!confirm("Are you sure you want to revoke this approval? The onboarding link in their email will no longer work.")) return;
    const btn = document.getElementById('revokeLinkBtn');
    btn.innerHTML = '<i class="fa-solid fa-circle-notch fa-spin mr-2"></i> Revoking...';
    try {
        await updateDoc(doc(db, 'quote_requests', currentQuote.id), { paymentCleared: false });
        closePaymentModal();
        loadQuotes();
    } catch(e) {
        console.error(e);
        alert("Failed to revoke approval.");
        btn.innerHTML = '<i class="fa-solid fa-ban mr-2"></i> Revoke Approval (Cancel Link)';
    }
});

document.getElementById('refreshQuotesBtn').addEventListener('click', loadQuotes);

// Initialize Data
loadSubscriptionPlans().then(() => loadQuotes());
