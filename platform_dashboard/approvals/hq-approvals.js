import { db } from '../assets/js/firebase-init.js';
import { collection, query, getDocs, doc, updateDoc, setDoc, orderBy } from "https://www.gstatic.com/firebasejs/10.7.1/firebase-firestore.js";

// EmailJS Setup
const EMAILJS_PUBLIC_KEY  = 'XfaGXU_eFA9dph-5G';
const EMAILJS_SERVICE_ID  = 'service_s5qvpzh'; 
const EMAILJS_TEMPLATE_ID = 'template_school_approved';
emailjs.init(EMAILJS_PUBLIC_KEY);

const tbody = document.getElementById('quotesTableBody');
let currentQuote = null;

// ── Load Quotes ────────────────────────────────────────────────────────────
export async function loadQuotes() {
    tbody.innerHTML = `<tr><td colspan="5" class="p-8 text-center text-emerald-400 font-semibold"><i class="fa-solid fa-spinner fa-spin mr-2"></i>Scanning pipeline...</td></tr>`;
    
    try {
        const q = query(collection(db, 'quote_requests'), orderBy('createdAt', 'desc'));
        const snap = await getDocs(q);
        
        let rows = '';
        let pendingCount = 0;

        snap.forEach(docSnap => {
            const data = docSnap.data();
            // Only show quotes that haven't fully onboarded yet
            if (data.fulfilled) return; 

            pendingCount++;
            const date = new Date(data.createdAt).toLocaleDateString();
            const isApproved = data.paymentCleared;
            
            const statusBadge = isApproved 
                ? `<span class="bg-emerald-900/40 text-emerald-400 border border-emerald-800 px-2 py-1 rounded text-[10px] font-black uppercase tracking-wider">Link Sent</span>`
                : `<span class="bg-amber-900/40 text-amber-400 border border-amber-800 px-2 py-1 rounded text-[10px] font-black uppercase tracking-wider">Pending Payment</span>`;

            const actionBtn = isApproved
                ? `<button class="text-slate-500 font-bold text-xs cursor-not-allowed" disabled>Waiting on School</button>`
                : `<button onclick="window.openApprovalModal('${docSnap.id}', '${data.schoolName.replace(/'/g, "\\'")}', '${data.workEmail}', '${data.firstName}')" class="bg-blue-600 hover:bg-blue-500 text-white font-bold px-3 py-1.5 rounded-lg text-xs transition border border-blue-500 shadow-lg">Approve</button>`;

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
        tbody.innerHTML = `<tr><td colspan="5" class="p-8 text-center text-red-400 font-bold">Failed to load data.</td></tr>`;
    }
}

// ── Modal Handlers (Attached to Window for HTML access) ───────────────────
window.openApprovalModal = (reqId, schoolName, email, firstName) => {
    currentQuote = { reqId, schoolName, email, firstName };
    document.getElementById('modalSchoolName').textContent = schoolName;
    document.getElementById('modalContactEmail').textContent = email;
    document.getElementById('payAmount').value = '';
    document.getElementById('paymentErrorMsg').classList.add('hidden');
    
    const modal = document.getElementById('paymentModal');
    const inner = document.getElementById('paymentModalInner');
    modal.classList.remove('hidden');
    setTimeout(() => {
        modal.classList.remove('opacity-0');
        inner.classList.remove('scale-95');
    }, 10);
};

window.closePaymentModal = () => {
    const modal = document.getElementById('paymentModal');
    const inner = document.getElementById('paymentModalInner');
    modal.classList.add('opacity-0');
    inner.classList.add('scale-95');
    setTimeout(() => modal.classList.add('hidden'), 300);
    currentQuote = null;
};

// ── Process Approval & Send Email ─────────────────────────────────────────
document.getElementById('confirmApproveBtn').addEventListener('click', async () => {
    const amount = document.getElementById('payAmount').value;
    const cycle = document.getElementById('payCycle').value;
    const errorMsg = document.getElementById('paymentErrorMsg');

    if (!amount || amount <= 0) {
        errorMsg.textContent = "Please enter a valid payment amount.";
        errorMsg.classList.remove('hidden'); return;
    }

    const btn = document.getElementById('confirmApproveBtn');
    btn.disabled = true;
    btn.innerHTML = '<i class="fa-solid fa-circle-notch fa-spin mr-2"></i> Processing & Emailing...';

    try {
        const session = JSON.parse(localStorage.getItem('connectus_hq_session'));
        const paymentId = `PAY-${Date.now()}`;
        const timestamp = new Date().toISOString();

        // 1. Create Payment Record
        await setDoc(doc(db, 'payments', paymentId), {
            reqId: currentQuote.reqId,
            schoolName: currentQuote.schoolName,
            amount: parseFloat(amount),
            cycle: cycle,
            loggedBy: session.id,
            timestamp: timestamp
        });

        // 2. Update Quote Status
        await updateDoc(doc(db, 'quote_requests', currentQuote.reqId), {
            paymentCleared: true,
            clearedAt: timestamp
        });

        // 3. Send EmailJS Link
        const onboardingLink = `https://connectusonline.org/onboarding/onboarding.html?req=${currentQuote.reqId}`;
        
        await emailjs.send(EMAILJS_SERVICE_ID, EMAILJS_TEMPLATE_ID, {
            to_email: currentQuote.email,
            contact_name: currentQuote.firstName,
            school_name: currentQuote.schoolName,
            onboarding_link: onboardingLink
        });

        // 4. Cleanup
        window.closePaymentModal();
        loadQuotes(); // Refresh the table

    } catch (e) {
        console.error("Approval Failed:", e);
        errorMsg.textContent = "An error occurred during approval.";
        errorMsg.classList.remove('hidden');
    }

    btn.disabled = false;
    btn.innerHTML = '<i class="fa-solid fa-paper-plane mr-2"></i> Log Payment & Email Link';
});

// Refresh button binding
document.getElementById('refreshQuotesBtn').addEventListener('click', loadQuotes);
