import { db, storage } from '../../assets/js/firebase-init.js';
import { collection, getDocs, doc, updateDoc, setDoc, query, where, writeBatch } from "https://www.gstatic.com/firebasejs/10.7.1/firebase-firestore.js";
import { ref, uploadBytes, getDownloadURL } from "https://www.gstatic.com/firebasejs/10.7.1/firebase-storage.js";

// ── Boot Sequence: Security Check & Setup ──────────────────────────────────
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

const tbody = document.getElementById('schoolsTableBody');
const searchInput = document.getElementById('searchSchools');
let allSchools = [];
let currentSchool = null;
let availablePlans = [];

// ── Hashing & ID Helpers ───────────────────────────────────────────────────
async function sha256(text) {
    const normalized  = text.toLowerCase().trim();
    const encoded     = new TextEncoder().encode(normalized);
    const hashBuffer  = await crypto.subtle.digest('SHA-256', encoded);
    return Array.from(new Uint8Array(hashBuffer))
        .map(b => b.toString(16).padStart(2, '0'))
        .join('');
}

function generateSchoolId() {
    const chars = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
    let rand = '';
    for (let i = 0; i < 5; i++) rand += chars.charAt(Math.floor(Math.random() * chars.length));
    return `SCH-${rand}`;
}

function generateAdminId() {
    const year  = new Date().getFullYear().toString().slice(-2);
    const chars = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
    let rand = '';
    for (let i = 0; i < 5; i++) rand += chars.charAt(Math.floor(Math.random() * chars.length));
    return `A${year}-${rand}`;
}

function calculateNewRenewalDate(cycleType, currentExpirationString) {
    if (cycleType === 'No Extension') return currentExpirationString; 

    const now = new Date();
    let baseDate = currentExpirationString ? new Date(currentExpirationString) : now;
    if (baseDate < now) baseDate = now; 

    if (cycleType === 'Monthly') {
        baseDate.setMonth(baseDate.getMonth() + 1);
    } else if (cycleType === 'Annual') {
        baseDate.setFullYear(baseDate.getFullYear() + 1);
    } else if (cycleType === 'Multi-Year') {
        baseDate.setFullYear(baseDate.getFullYear() + 2);
    } else {
        baseDate.setFullYear(baseDate.getFullYear() + 1); 
    }
    return baseDate.toISOString();
}

// ── Load Subscription Plans ──────────────────────────────────────────────
async function loadSubscriptionPlans() {
    const renSelect = document.getElementById('renPlan');
    const depSelect = document.getElementById('depPlan');
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
        
        if(renSelect) renSelect.innerHTML = options;
        if(depSelect) depSelect.innerHTML = options;
    } catch (e) {
        console.error("Failed to load subscription plans:", e);
        if(renSelect) renSelect.innerHTML = '<option value="">Error loading plans. Check Firebase rules.</option>';
        if(depSelect) depSelect.innerHTML = '<option value="">Error loading plans. Check Firebase rules.</option>';
    }
}

document.getElementById('renPlan').addEventListener('change', (e) => {
    const display = document.getElementById('renPlanLimitsDisplay');
    const selected = availablePlans.find(p => p.id === e.target.value);
    if (selected) {
        display.innerHTML = `<i class="fa-solid fa-circle-check mr-1"></i> Limits: ${selected.studentLimit} Students | ${selected.teacherLimit} Teachers | ${selected.adminLimit} Admins`;
        display.classList.remove('hidden');
    } else display.classList.add('hidden');
});

document.getElementById('depPlan').addEventListener('change', (e) => {
    const display = document.getElementById('depPlanLimitsDisplay');
    const selected = availablePlans.find(p => p.id === e.target.value);
    if (selected) {
        display.innerHTML = `<i class="fa-solid fa-circle-check mr-1"></i> Limits: ${selected.studentLimit} Students | ${selected.teacherLimit} Teachers | ${selected.adminLimit} Admins`;
        display.classList.remove('hidden');
    } else display.classList.add('hidden');
});

// ── Load Schools ───────────────────────────────────────────────────────────
async function loadSchools() {
    tbody.innerHTML = `<tr><td colspan="5" class="p-8 text-center text-indigo-400 font-semibold"><i class="fa-solid fa-spinner fa-spin mr-2"></i>Connecting to global registry...</td></tr>`;
    
    try {
        const snap = await getDocs(collection(db, 'schools'));
        allSchools = [];
        snap.forEach(docSnap => allSchools.push({ id: docSnap.id, ...docSnap.data() }));
        renderSchools();
    } catch (e) {
        console.error("Failed to load schools:", e);
        tbody.innerHTML = `<tr><td colspan="5" class="p-8 text-center text-red-400 font-bold">Failed to load network data. Check Rules.</td></tr>`;
    }
}

function renderSchools() {
    const term = searchInput.value.toLowerCase().trim();
    const filtered = allSchools.filter(s => (s.schoolName || '').toLowerCase().includes(term) || (s.id || '').toLowerCase().includes(term));

    if (filtered.length === 0) {
        tbody.innerHTML = `<tr><td colspan="5" class="p-8 text-center text-slate-500 font-semibold italic">No matching schools found.</td></tr>`;
        return;
    }

    let rows = '';
    const now = new Date();

    filtered.forEach(data => {
        const isSuspended = data.isActive === false; 
        const statusBadge = isSuspended 
            ? `<span class="bg-red-900/40 text-red-400 border border-red-800 px-2 py-1 rounded text-[10px] font-black uppercase tracking-wider">Suspended</span>`
            : `<span class="bg-emerald-900/40 text-emerald-400 border border-emerald-800 px-2 py-1 rounded text-[10px] font-black uppercase tracking-wider">Active</span>`;

        let renewalDisplay = '<span class="text-slate-500 italic">Not Set</span>';
        if (data.nextRenewalDate) {
            const renDate = new Date(data.nextRenewalDate);
            const isPastDue = renDate < now;
            const formattedDate = renDate.toLocaleDateString();
            
            if (isPastDue && !isSuspended) {
                renewalDisplay = `<span class="text-amber-400 font-bold"><i class="fa-solid fa-triangle-exclamation mr-1"></i> Past Due (${formattedDate})</span>`;
            } else if (isPastDue && isSuspended) {
                renewalDisplay = `<span class="text-red-400 font-bold">Expired (${formattedDate})</span>`;
            } else {
                renewalDisplay = `<span class="text-emerald-400 font-bold">${formattedDate}</span>`;
            }
        }

        const tierName = data.subscriptionName || 'Unknown Tier';

        rows += `
            <tr class="border-b border-slate-800 hover:bg-slate-800/50 transition">
                <td class="p-4">
                    <p class="font-bold text-white">${data.schoolName || 'Unnamed'}</p>
                    <p class="text-[10px] font-mono text-slate-500">${data.id}</p>
                </td>
                <td class="p-4">
                    <p class="font-bold text-slate-300 text-xs">${data.contactName || 'Admin'}</p>
                    <p class="text-xs text-slate-500">${data.contactEmail || 'No Email'}</p>
                </td>
                <td class="p-4">
                    <p class="font-bold text-indigo-400 text-xs uppercase tracking-widest">${tierName}</p>
                    <p class="text-xs mt-0.5">${renewalDisplay}</p>
                </td>
                <td class="p-4">${statusBadge}</td>
                <td class="p-4 text-right">
                    <button onclick="window.openSchoolModal('${data.id}')" class="bg-slate-700 hover:bg-slate-600 text-white font-bold px-3 py-1.5 rounded-lg text-xs transition shadow-md border border-slate-600">
                        Manage
                    </button>
                </td>
            </tr>`;
    });
    tbody.innerHTML = rows;
}

if (searchInput) searchInput.addEventListener('input', renderSchools);
document.getElementById('refreshSchoolsBtn').addEventListener('click', loadSchools);

// ── Transaction Ledger Loader ─────────────────────────────────────────────
async function loadSchoolLedger(school) {
    const tbody = document.getElementById('ledgerTableBody');
    tbody.innerHTML = '<tr><td colspan="5" class="p-4 text-center"><i class="fa-solid fa-spinner fa-spin text-indigo-400"></i></td></tr>';
    
    try {
        const payments = [];
        
        const q1 = query(collection(db, 'payments'), where('schoolId', '==', school.id));
        const snap1 = await getDocs(q1);
        snap1.forEach(d => payments.push({ id: d.id, ...d.data() }));

        if (school.originalQuoteId) {
            const q2 = query(collection(db, 'payments'), where('reqId', '==', school.originalQuoteId));
            const snap2 = await getDocs(q2);
            snap2.forEach(d => {
                if (!payments.some(p => p.id === d.id)) payments.push({ id: d.id, ...d.data() });
            });
        }

        payments.sort((a, b) => new Date(b.timestamp) - new Date(a.timestamp));

        if (payments.length === 0) {
            tbody.innerHTML = '<tr><td colspan="5" class="p-4 text-center text-xs text-slate-500 italic">No transactions found.</td></tr>';
            return;
        }

        let rows = '';
        payments.forEach(p => {
            const date = new Date(p.timestamp).toLocaleDateString();
            const amount = p.amount ? `$${p.amount.toFixed(2)}` : '$0.00';
            const type = p.paymentType || 'Payment';
            const receipt = p.receiptUrl ? `<a href="${p.receiptUrl}" target="_blank" class="text-blue-400 hover:underline"><i class="fa-solid fa-file-invoice"></i> View</a>` : '<span class="text-slate-600">-</span>';
            const notes = (p.internalNotes && p.internalNotes.length > 0) ? p.internalNotes[0].note : '-';

            rows += `
            <tr class="border-b border-slate-700 hover:bg-slate-800/50 text-xs transition">
                <td class="p-2 pl-4 text-slate-400">${date}</td>
                <td class="p-2 font-bold text-white">${type}</td>
                <td class="p-2 text-emerald-400 font-black">${amount}</td>
                <td class="p-2 text-slate-400 truncate max-w-[150px]" title="${notes}">${notes}</td>
                <td class="p-2 text-right pr-4">${receipt}</td>
            </tr>`;
        });
        tbody.innerHTML = rows;

    } catch (e) {
        console.error("Failed to load ledger:", e);
        tbody.innerHTML = '<tr><td colspan="5" class="p-4 text-center text-xs text-red-400">Failed to load transaction ledger.</td></tr>';
    }
}

// ── Manage Node Modal ─────────────────────────────────────────────────────
window.openSchoolModal = (schoolId) => {
    currentSchool = allSchools.find(s => s.id === schoolId);
    if (!currentSchool) return;

    document.getElementById('manageSchoolName').textContent = currentSchool.schoolName;
    document.getElementById('manageSchoolId').textContent = currentSchool.id;
    document.getElementById('manageAdminId').textContent = currentSchool.superAdminId || 'N/A';
    document.getElementById('manageEmail').textContent = currentSchool.contactEmail || 'N/A';
    
    document.getElementById('manageTier').textContent = currentSchool.subscriptionName || 'Not Set';
    document.getElementById('manageBillingCycle').textContent = currentSchool.billingCycle || 'Not Specified';
    document.getElementById('manageExpiration').textContent = currentSchool.nextRenewalDate 
        ? new Date(currentSchool.nextRenewalDate).toLocaleDateString() 
        : 'Not Set';

    const limits = currentSchool.limits || {};
    document.getElementById('manageLimitStudents').textContent = limits.studentLimit || '0';
    document.getElementById('manageLimitTeachers').textContent = limits.teacherLimit || '0';
    document.getElementById('manageLimitAdmins').textContent = limits.adminLimit || '0';

    const isSuspended = currentSchool.isActive === false;
    const toggleBtn = document.getElementById('toggleStatusBtn');
    const toggleText = document.getElementById('toggleStatusText');

    if (isSuspended) {
        toggleBtn.className = "w-full bg-emerald-900/20 border border-emerald-900/50 hover:bg-emerald-900/40 text-emerald-400 font-black py-4 rounded-xl transition text-sm tracking-wide flex justify-center items-center gap-2";
        toggleText.textContent = "Restore Platform Access";
    } else {
        toggleBtn.className = "w-full bg-red-900/20 border border-red-900/50 hover:bg-red-900/40 text-red-400 font-black py-4 rounded-xl transition text-sm tracking-wide flex justify-center items-center gap-2";
        toggleText.textContent = "Suspend Platform Access";
    }
    
    loadSchoolLedger(currentSchool);

    const modal = document.getElementById('schoolManageModal');
    const inner = document.getElementById('schoolManageModalInner');
    modal.classList.remove('hidden');
    setTimeout(() => { modal.classList.remove('opacity-0'); inner.classList.remove('scale-95'); }, 10);
};

document.getElementById('closeSchoolBtn').addEventListener('click', () => {
    const modal = document.getElementById('schoolManageModal');
    const inner = document.getElementById('schoolManageModalInner');
    modal.classList.add('opacity-0'); inner.classList.add('scale-95');
    setTimeout(() => modal.classList.add('hidden'), 300);
});

// ── Override Limits Modal (Add-Ons) ──────────────────────────────────────────
document.getElementById('openLimitsModalBtn').addEventListener('click', () => {
    document.getElementById('limSchoolName').textContent = currentSchool.schoolName;
    
    const limits = currentSchool.limits || {};
    document.getElementById('ovStudents').value = limits.studentLimit || 0;
    document.getElementById('ovTeachers').value = limits.teacherLimit || 0;
    document.getElementById('ovAdmins').value = limits.adminLimit || 0;
    
    document.getElementById('ovAmount').value = '';
    document.getElementById('ovNotes').value = '';
    document.getElementById('ovReceipt').value = '';
    document.getElementById('limitsErrorMsg').classList.add('hidden');

    const modal = document.getElementById('limitsModal');
    const inner = document.getElementById('limitsModalInner');
    modal.classList.remove('hidden');
    setTimeout(() => { modal.classList.remove('opacity-0'); inner.classList.remove('scale-95'); }, 10);
});

document.getElementById('closeLimitsBtn').addEventListener('click', () => {
    const modal = document.getElementById('limitsModal');
    const inner = document.getElementById('limitsModalInner');
    modal.classList.add('opacity-0'); inner.classList.add('scale-95');
    setTimeout(() => modal.classList.add('hidden'), 300);
});

document.getElementById('confirmLimitsBtn').addEventListener('click', async () => {
    const newStudents = parseInt(document.getElementById('ovStudents').value);
    const newTeachers = parseInt(document.getElementById('ovTeachers').value);
    const newAdmins = parseInt(document.getElementById('ovAdmins').value);
    const amountPaid = document.getElementById('ovAmount').value;
    const internalNote = document.getElementById('ovNotes').value.trim();
    const receiptFile = document.getElementById('ovReceipt').files[0]; 
    const errorMsg = document.getElementById('limitsErrorMsg');

    if (isNaN(newStudents) || isNaN(newTeachers) || isNaN(newAdmins)) {
        errorMsg.textContent = "Please enter valid numbers for all seat limits.";
        errorMsg.classList.remove('hidden'); return;
    }

    const btn = document.getElementById('confirmLimitsBtn');
    btn.disabled = true;

    try {
        const timestamp = new Date().toISOString();
        
        if (amountPaid && amountPaid > 0) {
            btn.innerHTML = '<i class="fa-solid fa-circle-notch fa-spin mr-2"></i> Logging Payment...';
            const paymentId = `PAY-${Date.now()}`;
            let receiptUrl = null;

            if (receiptFile) {
                const storageRef = ref(storage, `receipts/${paymentId}_${receiptFile.name}`);
                await uploadBytes(storageRef, receiptFile);
                receiptUrl = await getDownloadURL(storageRef);
            }

            const notesArray = internalNote ? [{
                note: internalNote,
                timestamp: timestamp,
                loggedBy: session.id,
                loggedByName: session.name
            }] : [];

            await setDoc(doc(db, 'payments', paymentId), {
                schoolId: currentSchool.id,
                schoolName: currentSchool.schoolName,
                paymentType: 'Seat Add-On / Limit Override',
                amount: parseFloat(amountPaid),
                billingCycle: 'One-Time Charge',
                receiptUrl: receiptUrl, 
                internalNotes: notesArray,
                loggedBy: session.id,
                timestamp: timestamp
            });
        }

        btn.innerHTML = '<i class="fa-solid fa-circle-notch fa-spin mr-2"></i> Saving Overrides...';

        await updateDoc(doc(db, 'schools', currentSchool.id), {
            limits: {
                studentLimit: newStudents,
                teacherLimit: newTeachers,
                adminLimit: newAdmins
            }
        });

        document.getElementById('closeLimitsBtn').click();
        document.getElementById('closeSchoolBtn').click(); 
        loadSchools(); 

    } catch (e) {
        console.error("Limits Override Failed:", e);
        errorMsg.textContent = "An error occurred. Check console for details.";
        errorMsg.classList.remove('hidden');
    }
    btn.disabled = false;
    btn.innerHTML = 'Save Overrides & Log Payment <i class="fa-solid fa-check ml-1"></i>';
});


// ── Renewal & Upgrade Modal Logic ───────────────────────────────────────────
document.getElementById('renCycle').addEventListener('change', (e) => {
    const customWrap = document.getElementById('renCustomCycleWrap');
    if (e.target.value === 'Other') customWrap.classList.remove('hidden');
    else customWrap.classList.add('hidden');
});

document.getElementById('openRenewalBtn').addEventListener('click', () => {
    document.getElementById('renSchoolName').textContent = currentSchool.schoolName;
    document.getElementById('renPlan').value = currentSchool.subscriptionPlanId || '';
    if(currentSchool.subscriptionPlanId) document.getElementById('renPlan').dispatchEvent(new Event('change')); 
    
    document.getElementById('renAmount').value = '';
    document.getElementById('renCycle').value = 'No Extension'; 
    document.getElementById('renCustomCycleWrap').classList.add('hidden');
    document.getElementById('renCustomCycle').value = '';
    document.getElementById('renNotes').value = '';
    document.getElementById('renReceipt').value = '';
    document.getElementById('renewalErrorMsg').classList.add('hidden');

    const modal = document.getElementById('renewalModal');
    const inner = document.getElementById('renewalModalInner');
    modal.classList.remove('hidden');
    setTimeout(() => { modal.classList.remove('opacity-0'); inner.classList.remove('scale-95'); }, 10);
});

const closeRenewalModal = () => {
    const modal = document.getElementById('renewalModal');
    const inner = document.getElementById('renewalModalInner');
    modal.classList.add('opacity-0'); inner.classList.add('scale-95');
    setTimeout(() => modal.classList.add('hidden'), 300);
};
document.getElementById('closeRenewalBtn').addEventListener('click', closeRenewalModal);

document.getElementById('confirmRenewalBtn').addEventListener('click', async () => {
    const planId = document.getElementById('renPlan').value;
    const amount = document.getElementById('renAmount').value;
    const cycleSelect = document.getElementById('renCycle').value;
    const customCycle = document.getElementById('renCustomCycle').value;
    const internalNote = document.getElementById('renNotes').value.trim();
    const receiptFile = document.getElementById('renReceipt').files[0]; 
    const errorMsg = document.getElementById('renewalErrorMsg');

    if (!planId) {
        errorMsg.textContent = "Please select a Subscription Tier.";
        errorMsg.classList.remove('hidden'); return;
    }
    if (!amount || amount < 0) {
        errorMsg.textContent = "Please enter a payment amount (can be 0 for free upgrades).";
        errorMsg.classList.remove('hidden'); return;
    }

    const selectedPlan = availablePlans.find(p => p.id === planId);
    const actualCycle = cycleSelect === 'Other' ? (customCycle || 'Custom') : cycleSelect;
    const btn = document.getElementById('confirmRenewalBtn');
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

        btn.innerHTML = '<i class="fa-solid fa-circle-notch fa-spin mr-2"></i> Logging Ledger...';

        const notesArray = internalNote ? [{
            note: internalNote,
            timestamp: timestamp,
            loggedBy: session.id,
            loggedByName: session.name
        }] : [];

        const newRenewalDate = calculateNewRenewalDate(cycleSelect, currentSchool.nextRenewalDate);
        const paymentType = cycleSelect === 'No Extension' ? 'Plan Upgrade/Change' : 'Renewal';

        await setDoc(doc(db, 'payments', paymentId), {
            schoolId: currentSchool.id,
            schoolName: currentSchool.schoolName,
            paymentType: paymentType,
            amount: parseFloat(amount),
            billingCycle: actualCycle,
            subscriptionPlanId: selectedPlan.id,
            receiptUrl: receiptUrl, 
            internalNotes: notesArray,
            loggedBy: session.id,
            timestamp: timestamp
        });

        btn.innerHTML = '<i class="fa-solid fa-circle-notch fa-spin mr-2"></i> Updating Node Limits...';
        await updateDoc(doc(db, 'schools', currentSchool.id), {
            billingCycle: cycleSelect === 'No Extension' ? currentSchool.billingCycle : actualCycle,
            nextRenewalDate: newRenewalDate,
            subscriptionPlanId: selectedPlan.id,
            subscriptionName: selectedPlan.name,
            limits: {
                adminLimit: selectedPlan.adminLimit,
                studentLimit: selectedPlan.studentLimit,
                teacherLimit: selectedPlan.teacherLimit
            },
            isActive: true 
        });

        closeRenewalModal();
        document.getElementById('closeSchoolBtn').click(); 
        loadSchools(); 

    } catch (e) {
        console.error("Update Failed:", e);
        errorMsg.textContent = "An error occurred during update. Check console for details.";
        errorMsg.classList.remove('hidden');
    }
    btn.disabled = false;
    btn.innerHTML = 'Update Subscription & Log Ledger <i class="fa-solid fa-arrow-rotate-right ml-1"></i>';
});

// ── Manual Deploy Logic ───────────────────────────────────────────────────
document.getElementById('openDeployModalBtn').addEventListener('click', () => {
    document.getElementById('depSchoolName').value = '';
    document.getElementById('depDistrict').value = 'Belize';
    document.getElementById('depSchoolType').value = 'Primary';
    document.getElementById('depEmail').value = '';
    document.getElementById('depPin').value = '';
    
    document.getElementById('depPlan').value = '';
    document.getElementById('depPlanLimitsDisplay').classList.add('hidden');
    document.getElementById('depAmount').value = '';
    document.getElementById('depCycle').value = 'Monthly';
    document.getElementById('depCustomCycleWrap').classList.add('hidden');
    document.getElementById('depCustomCycle').value = '';
    document.getElementById('depNotes').value = '';
    document.getElementById('depReceipt').value = '';
    document.getElementById('deployErrorMsg').classList.add('hidden');

    const modal = document.getElementById('deployModal');
    const inner = document.getElementById('deployModalInner');
    modal.classList.remove('hidden');
    setTimeout(() => { modal.classList.remove('opacity-0'); inner.classList.remove('scale-95'); }, 10);
});

const closeDeployModal = () => {
    const modal = document.getElementById('deployModal');
    const inner = document.getElementById('deployModalInner');
    modal.classList.add('opacity-0'); inner.classList.add('scale-95');
    setTimeout(() => modal.classList.add('hidden'), 300);
};
document.getElementById('closeDeployBtnDesktop').addEventListener('click', closeDeployModal);
document.getElementById('closeDeployBtnMobile').addEventListener('click', closeDeployModal);

document.getElementById('depCycle').addEventListener('change', (e) => {
    const customWrap = document.getElementById('depCustomCycleWrap');
    if (e.target.value === 'Other') customWrap.classList.remove('hidden');
    else customWrap.classList.add('hidden');
});

document.getElementById('executeDeployBtn').addEventListener('click', async () => {
    const schoolName = document.getElementById('depSchoolName').value.trim();
    const district   = document.getElementById('depDistrict').value;
    const schoolType = document.getElementById('depSchoolType').value;
    const email      = document.getElementById('depEmail').value.trim();
    const pin        = document.getElementById('depPin').value;
    
    const planId       = document.getElementById('depPlan').value;
    const amount       = document.getElementById('depAmount').value;
    const cycleSelect  = document.getElementById('depCycle').value;
    const customCycle  = document.getElementById('depCustomCycle').value;
    const internalNote = document.getElementById('depNotes').value.trim();
    const receiptFile  = document.getElementById('depReceipt').files[0]; 
    const errorMsg     = document.getElementById('deployErrorMsg');

    if (!schoolName || !email || !pin || !planId || !amount) {
        errorMsg.textContent = "Please fill in all required fields (*).";
        errorMsg.classList.remove('hidden'); return;
    }
    if (pin.length < 6) {
        errorMsg.textContent = "Admin PIN must be at least 6 characters.";
        errorMsg.classList.remove('hidden'); return;
    }

    const selectedPlan = availablePlans.find(p => p.id === planId);
    const actualCycle = cycleSelect === 'Other' ? (customCycle || 'Custom') : cycleSelect;
    const btn = document.getElementById('executeDeployBtn');
    btn.disabled = true;

    try {
        const timestamp = new Date().toISOString();
        const hashedPin = await sha256(pin);
        const newSchoolId = generateSchoolId();
        const newSuperAdminId = generateAdminId();
        const paymentId = `PAY-${Date.now()}`;
        
        let receiptUrl = null;

        if (receiptFile) {
            btn.innerHTML = '<i class="fa-solid fa-cloud-arrow-up fa-spin mr-2"></i> Uploading Receipt...';
            const storageRef = ref(storage, `receipts/${paymentId}_${receiptFile.name}`);
            await uploadBytes(storageRef, receiptFile);
            receiptUrl = await getDownloadURL(storageRef);
        }

        btn.innerHTML = '<i class="fa-solid fa-circle-notch fa-spin mr-2"></i> Deploying Infrastructure...';

        const notesArray = internalNote ? [{
            note: internalNote,
            timestamp: timestamp,
            loggedBy: session.id,
            loggedByName: session.name
        }] : [];

        // Manual deploy starts clock from today
        let nextRenewalDate = new Date();
        if (cycleSelect === 'Monthly') nextRenewalDate.setMonth(nextRenewalDate.getMonth() + 1);
        else if (cycleSelect === 'Annual') nextRenewalDate.setFullYear(nextRenewalDate.getFullYear() + 1);
        else if (cycleSelect === 'Multi-Year') nextRenewalDate.setFullYear(nextRenewalDate.getFullYear() + 2);
        else nextRenewalDate.setFullYear(nextRenewalDate.getFullYear() + 1);

        const batch = writeBatch(db);

        // A. Log Payment (Directly attached to the new schoolId)
        const paymentRef = doc(db, 'payments', paymentId);
        batch.set(paymentRef, {
            schoolId: newSchoolId,
            schoolName: schoolName,
            paymentType: 'Manual Deployment Setup',
            amount: parseFloat(amount),
            billingCycle: actualCycle,
            subscriptionPlanId: selectedPlan.id,
            receiptUrl: receiptUrl, 
            internalNotes: notesArray,
            loggedBy: session.id,
            timestamp: timestamp
        });

        // B. Create School Document
        const schoolRef = doc(db, 'schools', newSchoolId);
        batch.set(schoolRef, {
            schoolName,
            district,
            schoolType,
            superAdminId:         newSuperAdminId, 
            adminCode:            hashedPin,      
            securityQuestionsSet: false, // Force them to set security questions on first login           
            isSuperAdmin:         true,            
            isVerified:           true,
            requiresPinReset:     false,
            
            subscriptionPlanId:   selectedPlan.id,
            subscriptionName:     selectedPlan.name,
            billingCycle:         actualCycle,
            nextRenewalDate:      nextRenewalDate.toISOString(),
            subscriptionStatus:   'Active',
            limits: {
                adminLimit: selectedPlan.adminLimit,
                studentLimit: selectedPlan.studentLimit,
                teacherLimit: selectedPlan.teacherLimit
            },

            activeSemesterId:     'sem_1',
            contactEmail:         email,
            contactName:          'System Admin',
            phone:                '',
            createdAt:            timestamp
        });

        // C. Create Default Semesters
        const sems = [
            { id: 'sem_1', name: 'Term 1', order: 1 },
            { id: 'sem_2', name: 'Term 2', order: 2 },
            { id: 'sem_3', name: 'Term 3', order: 3 }
        ];

        sems.forEach(sem => {
            const semRef = doc(collection(db, 'schools', newSchoolId, 'semesters'), sem.id);
            batch.set(semRef, {
                name:      sem.name,
                order:     sem.order,
                startDate: '',
                endDate:   '',
                archived:  false,
                isLocked:  false
            });
        });

        await batch.commit();

        closeDeployModal();
        loadSchools();
        
        // Notify HQ of successful manual deploy
        alert(`Deployment Successful!\n\nSchool Name: ${schoolName}\nSchool ID: ${newSchoolId}\nAdmin ID: ${newSuperAdminId}\n\nMake sure to provide these credentials to the school administrator.`);

    } catch (e) {
        console.error("Manual Deploy Failed:", e);
        errorMsg.textContent = "Failed to deploy infrastructure. Check console.";
        errorMsg.classList.remove('hidden');
    }

    btn.disabled = false;
    btn.innerHTML = '<i class="fa-solid fa-server mr-2"></i> Deploy Infrastructure';
});

// ── Toggle Suspension (Kill Switch) ───────────────────────────────────────
const toggleStatusBtn = document.getElementById('toggleStatusBtn');
if (toggleStatusBtn) {
    toggleStatusBtn.addEventListener('click', async () => {
        if (!currentSchool) return;

        const isSuspended = currentSchool.isActive === false;
        const newStatus = isSuspended ? true : false;
        
        if (!newStatus) {
            if (!confirm(`Are you absolutely sure you want to SUSPEND ${currentSchool.schoolName}? Everyone will be locked out.`)) return;
        }

        const btn = document.getElementById('toggleStatusBtn');
        const originalContent = btn.innerHTML;
        btn.disabled = true;
        btn.innerHTML = '<i class="fa-solid fa-circle-notch fa-spin mr-2"></i> Executing...';

        try {
            await updateDoc(doc(db, 'schools', currentSchool.id), { isActive: newStatus });
            document.getElementById('closeSchoolBtn').click();
            loadSchools();
        } catch (e) {
            console.error("Status Toggle Failed:", e);
            alert("Failed to update school status.");
        }
        btn.disabled = false;
        btn.innerHTML = originalContent;
    });
}

// Init Data
loadSubscriptionPlans().then(() => loadSchools());
