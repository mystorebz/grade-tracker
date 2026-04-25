import { db, storage } from '../../assets/js/firebase-init.js'; 
import { collection, query, getDocs, doc, updateDoc, setDoc, orderBy } from "https://www.gstatic.com/firebasejs/10.7.1/firebase-firestore.js";
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

// ── EmailJS Setup ────────────────────────────────────────────────────────
const EMAILJS_PUBLIC_KEY  = 'XfaGXU_eFA9dph-5G';
const EMAILJS_SERVICE_ID  = 'service_s5qvpzh'; 
const EMAILJS_TEMPLATE_ID = 'template_school_approved';
emailjs.init(EMAILJS_PUBLIC_KEY);

const tbody = document.getElementById('quotesTableBody');
let allQuotes = []; // Array to store fetched quotes for the View Modal
let currentQuote = null;

// ── Load Quotes ────────────────────────────────────────────────────────────
async function loadQuotes() {
    tbody.innerHTML = `<tr><td colspan="5" class="p-8 text-center text-emerald-400 font-semibold"><i class="fa-solid fa-spinner fa-spin mr-2"></i>Scanning pipeline...</td></tr>`;
    
    try {
        const q = query(collection(db, 'quote_requests'), orderBy('createdAt', 'desc'));
        const snap = await getDocs(q);
        
        allQuotes = []; // Reset Array
        let rows = '';
        let pendingCount = 0;

        snap.forEach(docSnap => {
            const data = docSnap.data();
            data.id = docSnap.id; // Store ID inside object
            allQuotes.push(data); // Push to array

            if (data.fulfilled) return; 

            pendingCount++;
            const date = new Date(data.createdAt).toLocaleDateString();
            const isApproved = data.paymentCleared;
            
            const statusBadge = isApproved 
                ? `<span class="bg-emerald-900/40 text-emerald-400 border border-emerald-800 px-2 py-1 rounded text-[10px] font-black uppercase tracking-wider">Link Sent</span>`
                : `<span class="bg-amber-900/40 text-amber-400 border border-amber-800 px-2 py-1 rounded text-[10px] font-black uppercase tracking-wider">Pending Payment</span>`;

            // Changed action button to "View"
            const actionBtn = isApproved
                ? `<button class="text-slate-500 font-bold text-xs cursor-not-allowed" disabled>Waiting on School</button>`
                : `<button onclick="window.openApprovalModal('${data.id}')" class="bg-slate-700 hover:bg-slate-600 text-white font-bold px-4 py-1.5 rounded-lg text-xs transition border border-slate-600 shadow-md">View</button>`;

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

// ── Modal Handlers (View & Populate Details) ─────────────────────────────
window.openApprovalModal = (reqId) => {
    // Find the quote from our array
    currentQuote = allQuotes.find(q => q.id === reqId);
    if (!currentQuote) return;

    // Populate UI - Left Side
    document.getElementById('vReqId').textContent = currentQuote.id;
    document.getElementById('vName').textContent = `${currentQuote.firstName} ${currentQuote.lastName}`;
    document.getElementById('vRole').textContent = currentQuote.jobTitle || 'N/A';
    document.getElementById('vEmail').textContent = currentQuote.workEmail || 'N/A';
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

    // Reset Inputs - Right Side
    document.getElementById('payAmount').value = '';
    document.getElementById('payCycle').value = currentQuote.contractTerm === 'Annual' ? 'Yearly' : 'Monthly'; // Smart default
    document.getElementById('payReceipt').value = ''; 
    document.getElementById('paymentErrorMsg').classList.add('hidden');
    
    // Show Modal
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

// ── Process Approval, Upload Receipt & Send Email ────────────────────────
document.getElementById('confirmApproveBtn').addEventListener('click', async () => {
    const amount = document.getElementById('payAmount').value;
    const cycle = document.getElementById('payCycle').value;
    const receiptFile = document.getElementById('payReceipt').files[0]; 
    const errorMsg = document.getElementById('paymentErrorMsg');

    if (!amount || amount <= 0) {
        errorMsg.textContent = "Please enter a valid payment amount.";
        errorMsg.classList.remove('hidden'); return;
    }

    const btn = document.getElementById('confirmApproveBtn');
    btn.disabled = true;

    try {
        const paymentId = `PAY-${Date.now()}`;
        const timestamp = new Date().toISOString();
        let receiptUrl = null;

        // 1. Upload File to Firebase Storage (If attached)
        if (receiptFile) {
            btn.innerHTML = '<i class="fa-solid fa-cloud-arrow-up fa-spin mr-2"></i> Uploading Receipt...';
            const storageRef = ref(storage, `receipts/${paymentId}_${receiptFile.name}`);
            await uploadBytes(storageRef, receiptFile);
            receiptUrl = await getDownloadURL(storageRef);
        }

        btn.innerHTML = '<i class="fa-solid fa-circle-notch fa-spin mr-2"></i> Logging Invoice...';

        // 2. Create Payment/Invoice Record
        await setDoc(doc(db, 'payments', paymentId), {
            reqId: currentQuote.id,
            schoolName: currentQuote.schoolName,
            amount: parseFloat(amount),
            cycle: cycle,
            receiptUrl: receiptUrl, // Store download link
            loggedBy: session.id,
            timestamp: timestamp
        });

        // 3. Update Quote Status
        await updateDoc(doc(db, 'quote_requests', currentQuote.id), {
            paymentCleared: true,
            clearedAt: timestamp
        });

        // 4. Send EmailJS Link
        btn.innerHTML = '<i class="fa-solid fa-envelope fa-spin mr-2"></i> Emailing School...';
        const onboardingLink = `https://connectusonline.org/onboarding/onboarding.html?req=${currentQuote.id}`;
        
        await emailjs.send(EMAILJS_SERVICE_ID, EMAILJS_TEMPLATE_ID, {
            to_email: currentQuote.workEmail,
            contact_name: currentQuote.firstName,
            school_name: currentQuote.schoolName,
            onboarding_link: onboardingLink
        });

        // 5. Cleanup
        closePaymentModal();
        loadQuotes(); 

    } catch (e) {
        console.error("Approval Failed:", e);
        errorMsg.textContent = "An error occurred during approval. Ensure Firebase Storage is initialized and rules allow writes.";
        errorMsg.classList.remove('hidden');
    }

    btn.disabled = false;
    btn.innerHTML = 'Mark as Paid & Approve <i class="fa-solid fa-arrow-right ml-1"></i>';
});

document.getElementById('refreshQuotesBtn').addEventListener('click', loadQuotes);
loadQuotes(); // Init table on load
