import { db, storage } from '../../assets/js/firebase-init.js';
import { collection, getDocs, doc, updateDoc, setDoc } from "https://www.gstatic.com/firebasejs/10.7.1/firebase-firestore.js";
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

        // Renewal Date Logic
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
                <td class="p-4 text-xs">${renewalDisplay}</td>
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

// ── Manage Node Modal ─────────────────────────────────────────────────────
window.openSchoolModal = (schoolId) => {
    currentSchool = allSchools.find(s => s.id === schoolId);
    if (!currentSchool) return;

    document.getElementById('manageSchoolName').textContent = currentSchool.schoolName;
    document.getElementById('manageSchoolId').textContent = currentSchool.id;
    document.getElementById('manageAdminId').textContent = currentSchool.superAdminId || 'N/A';
    document.getElementById('manageEmail').textContent = currentSchool.contactEmail || 'N/A';
    
    // Billing Info
    document.getElementById('manageBillingCycle').textContent = currentSchool.billingCycle || 'Not Specified';
    document.getElementById('manageExpiration').textContent = currentSchool.nextRenewalDate 
        ? new Date(currentSchool.nextRenewalDate).toLocaleDateString() 
        : 'Not Set';

    // Danger Zone
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

// ── Renewal Payment Modal Logic ───────────────────────────────────────────
document.getElementById('renCycle').addEventListener('change', (e) => {
    const customWrap = document.getElementById('renCustomCycleWrap');
    if (e.target.value === 'Other') customWrap.classList.remove('hidden');
    else customWrap.classList.add('hidden');
});

document.getElementById('openRenewalBtn').addEventListener('click', () => {
    document.getElementById('renSchoolName').textContent = currentSchool.schoolName;
    document.getElementById('renAmount').value = '';
    document.getElementById('renCycle').value = 'Annual'; // Default to annual renewal
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

// Helper to advance the date based on existing expiration (or now if none exists)
function calculateNewRenewalDate(cycleType, currentExpirationString) {
    // If they are way past due, start the clock from today. If active, extend current clock.
    const now = new Date();
    let baseDate = currentExpirationString ? new Date(currentExpirationString) : now;
    if (baseDate < now) baseDate = now; 

    if (cycleType === 'Monthly') {
        baseDate.setMonth(baseDate.getMonth() + 1);
    } else if (cycleType === 'Annual') {
        baseDate.setFullYear(baseDate.getFullYear() + 1);
    } else if (cycleType === 'Multi-Year') {
        baseDate.setFullYear(baseDate.getFullYear() + 2); // Default to 2 for generic multi
    } else {
        baseDate.setFullYear(baseDate.getFullYear() + 1); // Default fallback
    }
    return baseDate.toISOString();
}

document.getElementById('confirmRenewalBtn').addEventListener('click', async () => {
    const amount = document.getElementById('renAmount').value;
    const cycleSelect = document.getElementById('renCycle').value;
    const customCycle = document.getElementById('renCustomCycle').value;
    const internalNote = document.getElementById('renNotes').value.trim();
    const receiptFile = document.getElementById('renReceipt').files[0]; 
    const errorMsg = document.getElementById('renewalErrorMsg');

    if (!amount || amount <= 0) {
        errorMsg.textContent = "Please enter a valid payment amount.";
        errorMsg.classList.remove('hidden'); return;
    }

    const actualCycle = cycleSelect === 'Other' ? (customCycle || 'Custom') : cycleSelect;
    const btn = document.getElementById('confirmRenewalBtn');
    btn.disabled = true;

    try {
        const paymentId = `PAY-${Date.now()}`;
        const timestamp = new Date().toISOString();
        let receiptUrl = null;

        // 1. Upload File to Firebase Storage
        if (receiptFile) {
            btn.innerHTML = '<i class="fa-solid fa-cloud-arrow-up fa-spin mr-2"></i> Uploading Receipt...';
            const storageRef = ref(storage, `receipts/${paymentId}_${receiptFile.name}`);
            await uploadBytes(storageRef, receiptFile);
            receiptUrl = await getDownloadURL(storageRef);
        }

        btn.innerHTML = '<i class="fa-solid fa-circle-notch fa-spin mr-2"></i> Logging Ledger...';

        // 2. Prepare Timestamped Note
        const notesArray = internalNote ? [{
            note: internalNote,
            timestamp: timestamp,
            loggedBy: session.id,
            loggedByName: session.name
        }] : [];

        // 3. Calculate New Expiration Clock
        const newRenewalDate = calculateNewRenewalDate(cycleSelect, currentSchool.nextRenewalDate);

        // 4. Create Master Ledger Payment Record (Type: Renewal)
        await setDoc(doc(db, 'payments', paymentId), {
            schoolId: currentSchool.id,
            schoolName: currentSchool.schoolName,
            paymentType: 'Renewal',
            amount: parseFloat(amount),
            billingCycle: actualCycle,
            receiptUrl: receiptUrl, 
            internalNotes: notesArray,
            loggedBy: session.id,
            timestamp: timestamp
        });

        // 5. Update School Document
        btn.innerHTML = '<i class="fa-solid fa-circle-notch fa-spin mr-2"></i> Updating Node...';
        await updateDoc(doc(db, 'schools', currentSchool.id), {
            billingCycle: actualCycle,
            nextRenewalDate: newRenewalDate,
            isActive: true // Ensure they are un-suspended if they were locked out
        });

        // 6. Cleanup
        closeRenewalModal();
        document.getElementById('closeSchoolBtn').click(); // Close manage modal too
        loadSchools(); 

    } catch (e) {
        console.error("Renewal Failed:", e);
        errorMsg.textContent = "An error occurred during renewal update. Check console for details.";
        errorMsg.classList.remove('hidden');
    }

    btn.disabled = false;
    btn.innerHTML = 'Update Subscription & Log Ledger <i class="fa-solid fa-arrow-rotate-right ml-1"></i>';
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

loadSchools(); // Init table on load
