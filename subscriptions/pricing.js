import { db } from '../assets/js/firebase-init.js'; // Adjust path as needed
import { collection, getDocs, doc, setDoc } from "https://www.gstatic.com/firebasejs/10.7.1/firebase-firestore.js";

const container = document.getElementById('pricingCardsContainer');
const modal = document.getElementById('subscribeModal');
const modalInner = document.getElementById('subscribeModalInner');
const closeBtn = document.getElementById('closeModalBtn');
const subscribeForm = document.getElementById('subscribeForm');

let plans = [];

// ── 1. Fetch and Render Plans ─────────────────────────────────────────────
async function loadPricing() {
    try {
        const snap = await getDocs(collection(db, 'subscriptionPlans'));
        plans = [];
        container.innerHTML = ''; // Clear loading spinner

        // Sort plans so Starter is first, Growth, Pro, Enterprise
        const order = ['starter', 'growth', 'Pro', 'enterprise']; 
        
        snap.forEach(doc => {
            const data = doc.data();
            data.id = doc.id;
            plans.push(data);
        });

        // Sort based on your preferred order array
        plans.sort((a, b) => order.indexOf(a.id) - order.indexOf(b.id));

        plans.forEach(plan => {
            const isEnterprise = plan.id === 'enterprise';
            const priceText = plan.price || 'Custom';
            
            // Build the card HTML
            const cardHTML = `
                <div class="bg-slate-800 border border-slate-700 rounded-2xl p-8 w-full max-w-sm flex flex-col shadow-xl relative ${plan.id === 'Pro' ? 'ring-2 ring-blue-500' : ''}">
                    ${plan.id === 'Pro' ? `<span class="absolute -top-3 left-1/2 transform -translate-x-1/2 bg-blue-500 text-white text-[10px] font-bold uppercase tracking-wider py-1 px-3 rounded-full">Most Popular</span>` : ''}
                    
                    <h3 class="text-2xl font-bold text-white mb-2">${plan.name}</h3>
                    <div class="text-3xl font-black text-white mb-6">${priceText} <span class="text-sm font-normal text-slate-400 ${isEnterprise ? 'hidden' : ''}">/ mo</span></div>
                    
                    <ul class="space-y-4 mb-8 flex-1 text-slate-300 text-sm">
                        <li><i class="fa-solid fa-user-graduate text-blue-400 mr-2 w-4"></i> Up to ${plan.studentLimit === 99999 ? 'Unlimited' : plan.studentLimit} Students</li>
                        <li><i class="fa-solid fa-chalkboard-user text-blue-400 mr-2 w-4"></i> Up to ${plan.teacherLimit} Teachers</li>
                        <li><i class="fa-solid fa-user-shield text-blue-400 mr-2 w-4"></i> ${plan.adminLimit} Administrator(s)</li>
                    </ul>

                    <button onclick="${isEnterprise ? `window.location.href='quote.html'` : `window.openModal('${plan.id}')`}" 
                            class="w-full py-3 rounded-lg font-bold transition border ${isEnterprise ? 'bg-transparent border-slate-500 text-white hover:bg-slate-700' : 'bg-blue-600 border-blue-600 text-white hover:bg-blue-500'}">
                        ${isEnterprise ? 'Get a Quote' : 'Subscribe Now'}
                    </button>
                </div>
            `;
            container.innerHTML += cardHTML;
        });

    } catch (error) {
        console.error("Failed to load plans:", error);
        container.innerHTML = `<p class="text-red-400">Failed to load pricing. Please try again later.</p>`;
    }
}

// ── 2. Modal Controls ─────────────────────────────────────────────────────
window.openModal = (planId) => {
    const selectedPlan = plans.find(p => p.id === planId);
    if (!selectedPlan) return;

    // Populate hidden fields and UI
    document.getElementById('modalPlanName').textContent = selectedPlan.name;
    document.getElementById('selectedPlanId').value = selectedPlan.id;
    document.getElementById('selectedStripeUrl').value = selectedPlan.stripeUrl || ''; // Must be added in DB!

    // Show modal with animation
    modal.classList.remove('hidden');
    setTimeout(() => {
        modal.classList.remove('opacity-0');
        modalInner.classList.remove('scale-95');
    }, 10);
};

closeBtn.addEventListener('click', () => {
    modal.classList.add('opacity-0');
    modalInner.classList.add('scale-95');
    setTimeout(() => modal.classList.add('hidden'), 300);
});

// ── 3. Handle Form Submission (Create Lead -> Stripe) ─────────────────────
subscribeForm.addEventListener('submit', async (e) => {
    e.preventDefault();
    
    const btn = document.getElementById('proceedToPayBtn');
    const errorMsg = document.getElementById('modalErrorMsg');
    
    const fName = document.getElementById('subFirstName').value.trim();
    const lName = document.getElementById('subLastName').value.trim();
    const schoolName = document.getElementById('subSchoolName').value.trim();
    const email = document.getElementById('subEmail').value.trim();
    const planId = document.getElementById('selectedPlanId').value;
    const stripeUrl = document.getElementById('selectedStripeUrl').value;

    if (!stripeUrl) {
        errorMsg.textContent = "Payment link not configured for this plan. Contact support.";
        errorMsg.classList.remove('hidden');
        return;
    }

    btn.disabled = true;
    btn.innerHTML = '<i class="fa-solid fa-spinner fa-spin mr-2"></i> Preparing Checkout...';
    errorMsg.classList.add('hidden');

    try {
        // Create a tracking ID so Stripe webhook knows who this is
        const tempReqId = `REQ-${Date.now()}`;

        // 1. Save them as a pending quote/lead in your database
        // This is crucial! If they abandon the Stripe checkout, you still have their email to follow up!
        await setDoc(doc(db, 'quote_requests', tempReqId), {
            firstName: fName,
            lastName: lName,
            workEmail: email.toLowerCase(),
            schoolName: schoolName,
            requestedPlanId: planId,
            paymentCleared: false, // Will be set to true by Stripe Webhook
            createdAt: new Date().toISOString(),
            source: 'Self-Serve Checkout'
        });

        // 2. Redirect to Stripe Payment Link
        // We append the email to the Stripe URL so they don't have to type it twice
        // We also pass the tempReqId as client_reference_id so the webhook knows which document to update!
        const finalStripeUrl = `${stripeUrl}?prefilled_email=${encodeURIComponent(email)}&client_reference_id=${tempReqId}`;
        
        window.location.href = finalStripeUrl;

    } catch (error) {
        console.error("Setup failed:", error);
        errorMsg.textContent = "A database error occurred. Please try again.";
        errorMsg.classList.remove('hidden');
        btn.disabled = false;
        btn.innerHTML = 'Proceed to Payment <i class="fa-solid fa-arrow-right ml-2"></i>';
    }
});

// Initialize
loadPricing();
