import { db, storage } from '../../assets/js/firebase-init.js';
import { collection, getDocs, getDoc, doc, updateDoc, setDoc, query, where, writeBatch, arrayUnion, limit, startAfter, orderBy } from "https://www.gstatic.com/firebasejs/10.7.1/firebase-firestore.js";
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

// Panel & Lazy Loading State
let membersLoaded = false;
let ledgerLoaded = false;
let lastVisibleMemberDoc = null;
let memberSearchMode = false;

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
    }
}

// ── Load Schools (Main Table) ──────────────────────────────────────────────
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
        const isSuspended = data.isVerified === false; 
        const statusBadge = isSuspended 
            ? `<span class="bg-red-900/40 text-red-400 border border-red-800 px-2 py-1 text-[10px] font-black uppercase tracking-wider">Suspended</span>`
            : `<span class="bg-emerald-900/40 text-emerald-400 border border-emerald-800 px-2 py-1 text-[10px] font-black uppercase tracking-wider">Active</span>`;

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
            <tr class="border-b border-slate-800 hover:bg-slate-800/50 transition cursor-pointer" onclick="window.openSchoolPanel('${data.id}')">
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
                    <button class="bg-slate-700 hover:bg-slate-600 text-white font-bold px-3 py-1.5 text-[10px] uppercase tracking-widest transition border border-slate-600">
                        Manage <i class="fa-solid fa-arrow-right ml-1"></i>
                    </button>
                </td>
            </tr>`;
    });
    tbody.innerHTML = rows;
}

if (searchInput) searchInput.addEventListener('input', renderSchools);
document.getElementById('refreshSchoolsBtn').addEventListener('click', loadSchools);


// ── Slide-Out Panel & Tab Logic ───────────────────────────────────────────
window.openSchoolPanel = (schoolId) => {
    currentSchool = allSchools.find(s => s.id === schoolId);
    if (!currentSchool) return;

    // 1. Reset Lazy Loading States
    membersLoaded = false;
    ledgerLoaded = false;
    lastVisibleMemberDoc = null;

    // 2. Populate Sticky Header Context
    document.getElementById('panelHeaderName').textContent = currentSchool.schoolName;
    document.getElementById('panelHeaderId').textContent = currentSchool.id;
    const headerStatus = document.getElementById('panelHeaderStatus');
    if (currentSchool.isVerified === false) {
        headerStatus.innerHTML = `<span class="bg-red-900/40 text-red-400 border border-red-800 px-2 py-1 text-[10px] font-black uppercase tracking-wider">Suspended</span>`;
    } else {
        headerStatus.innerHTML = `<span class="bg-emerald-900/40 text-emerald-400 border border-emerald-800 px-2 py-1 text-[10px] font-black uppercase tracking-wider">Active</span>`;
    }

    // 3. Populate Profile Tab (Core Info)
    document.getElementById('manageEmail').textContent = currentSchool.contactEmail || 'N/A';
    document.getElementById('manageAdminId').textContent = currentSchool.superAdminId || 'N/A';
    document.getElementById('manageDistrict').textContent = currentSchool.district || 'N/A';
    document.getElementById('manageType').textContent = currentSchool.schoolType || 'N/A';
    
    // 4. Populate Subscription Tab Details
    document.getElementById('manageTier').textContent = currentSchool.subscriptionName || 'Not Set';
    document.getElementById('manageBillingCycle').textContent = currentSchool.billingCycle || 'Not Specified';
    
    document.getElementById('manageActivation').textContent = currentSchool.subscriptionActivatedAt 
        ? new Date(currentSchool.subscriptionActivatedAt).toLocaleDateString() : 'N/A';
    document.getElementById('manageExpiration').textContent = currentSchool.nextRenewalDate 
        ? new Date(currentSchool.nextRenewalDate).toLocaleDateString() : 'Not Set';

    const limits = currentSchool.limits || {};
    document.getElementById('manageLimitStudents').textContent = limits.studentLimit || '0';
    document.getElementById('manageLimitTeachers').textContent = limits.teacherLimit || '0';
    document.getElementById('manageLimitAdmins').textContent = limits.adminLimit || '0';

    // 5. Check Kill Switch State
    const toggleBtn = document.getElementById('toggleStatusBtn');
    if (currentSchool.isVerified === false) {
        toggleBtn.className = "w-full bg-emerald-900/20 border border-emerald-900/50 hover:bg-emerald-900/40 text-emerald-400 font-black py-4 transition text-sm tracking-wide flex justify-center items-center gap-2";
        toggleBtn.innerHTML = '<i class="fa-solid fa-power-off"></i> Restore Platform Access';
    } else {
        toggleBtn.className = "w-full bg-red-900/20 border border-red-900/50 hover:bg-red-900/40 text-red-400 font-black py-4 transition text-sm tracking-wide flex justify-center items-center gap-2";
        toggleBtn.innerHTML = '<i class="fa-solid fa-power-off"></i> Suspend Platform Access';
    }

    // 6. Render Notes
    renderAdminNotes();

    // 7. Slide In the Panel
    const overlay = document.getElementById('schoolPanelOverlay');
    const panel = document.getElementById('schoolSlidePanel');
    overlay.classList.remove('hidden');
    setTimeout(() => {
        overlay.classList.remove('opacity-0');
        panel.classList.remove('translate-x-full');
    }, 10);

    // 8. Force open the first tab
    window.switchTab('profile');
};

window.closeSchoolPanel = () => {
    const overlay = document.getElementById('schoolPanelOverlay');
    const panel = document.getElementById('schoolSlidePanel');
    overlay.classList.add('opacity-0');
    panel.classList.add('translate-x-full');
    setTimeout(() => overlay.classList.add('hidden'), 300);
};
document.getElementById('closePanelBtn').addEventListener('click', window.closeSchoolPanel);

window.switchTab = (tabName) => {
    // Hide all contents
    document.querySelectorAll('.panel-tab-content').forEach(el => el.classList.add('hidden'));
    
    // Reset all buttons (Sharp UI style)
    document.querySelectorAll('.panel-tab-btn').forEach(el => {
        el.classList.remove('text-indigo-400', 'border-indigo-400', 'bg-slate-800');
        el.classList.add('text-slate-400', 'border-transparent');
    });

    // Activate selected
    document.getElementById(`tab-${tabName}`).classList.remove('hidden');
    const activeBtn = document.getElementById(`btn-tab-${tabName}`);
    activeBtn.classList.remove('text-slate-400', 'border-transparent');
    activeBtn.classList.add('text-indigo-400', 'border-indigo-400', 'bg-slate-800');

    // LAZY LOADING
    if (tabName === 'members' && !membersLoaded) {
        window.applyMemberFilter(); // Triggers initial paginated load
        membersLoaded = true;
    }
    if (tabName === 'ledger' && !ledgerLoaded) {
        loadSchoolLedger(currentSchool);
        ledgerLoaded = true;
    }
};


// ── Tab 2: Cursor Pagination & Target Search (Members) ────────────────────
window.loadMembers = async (direction = 'init') => {
    const role = document.getElementById('memberRoleFilter').value; // 'students', 'teachers', 'admins'
    const searchTerm = document.getElementById('memberSearchInput').value.trim();
    const tbody = document.getElementById('membersTableBody');
    const loadNextBtn = document.getElementById('loadNextMembersBtn');
    
    tbody.innerHTML = '<tr><td colspan="4" class="p-8 text-center text-indigo-400 font-bold"><i class="fa-solid fa-spinner fa-spin mr-2"></i> Fetching records...</td></tr>';
    
    try {
        let snap;
        
        // PATH A: Targeted Direct Search (Bypasses Pagination)
        if (searchTerm) {
            memberSearchMode = true;
            let membersRef = role === 'admins' ? collection(db, `schools/${currentSchool.id}/admins`) : collection(db, role);
            
            // 1. Try Exact Email Match
            let qEmail = role === 'admins' 
                ? query(membersRef, where('email', '==', searchTerm.toLowerCase()))
                : query(membersRef, where('currentSchoolId', '==', currentSchool.id), where('email', '==', searchTerm.toLowerCase()));
            
            snap = await getDocs(qEmail);

            // 2. Fallback: Try Exact ID Match if Email is empty
            if (snap.empty) {
                let docRef = role === 'admins' 
                    ? doc(db, `schools/${currentSchool.id}/admins`, searchTerm.toUpperCase())
                    : doc(db, role, searchTerm.toUpperCase());
                    
                const docSnap = await getDoc(docRef);
                if (docSnap.exists() && (role === 'admins' || docSnap.data().currentSchoolId === currentSchool.id)) {
                    snap = { docs: [docSnap], empty: false };
                }
            }
        } 
        
        // PATH B: Standard Paginated Loading (Limit 20)
        else {
            memberSearchMode = false;
            let membersRef = role === 'admins' ? collection(db, `schools/${currentSchool.id}/admins`) : collection(db, role);
            
            let qBase = role === 'admins' 
                ? query(membersRef, orderBy('name'), limit(20))
                : query(membersRef, where('currentSchoolId', '==', currentSchool.id), orderBy('name'), limit(20));

            if (direction === 'next' && lastVisibleMemberDoc) {
                qBase = role === 'admins'
                    ? query(membersRef, orderBy('name'), startAfter(lastVisibleMemberDoc), limit(20))
                    : query(membersRef, where('currentSchoolId', '==', currentSchool.id), orderBy('name'), startAfter(lastVisibleMemberDoc), limit(20));
            }
            snap = await getDocs(qBase);
        }

        // Handle Empty State
        if (snap.empty) {
            tbody.innerHTML = '<tr><td colspan="4" class="p-8 text-center text-slate-500 font-bold italic border-b border-slate-800">No records found.</td></tr>';
            loadNextBtn.classList.add('hidden');
            return;
        }

        // Manage Pagination Cursors
        if (!memberSearchMode) {
            lastVisibleMemberDoc = snap.docs[snap.docs.length - 1];
            // Hide "Next" button if less than 20 returned (meaning it's the last page)
            if (snap.docs.length < 20) loadNextBtn.classList.add('hidden');
            else loadNextBtn.classList.remove('hidden');
        } else {
            loadNextBtn.classList.add('hidden'); // Hide pagination during search
        }

        // Render Table
        let html = '';
        snap.forEach(docSnap => {
            const data = docSnap.data();
            const badgeColor = role === 'admins' ? 'amber' : role === 'teachers' ? 'blue' : 'emerald';
            
            html += `
                <tr class="border-b border-slate-800 hover:bg-slate-800/30 transition">
                    <td class="p-4">
                        <span class="bg-${badgeColor}-900/30 text-${badgeColor}-400 border border-${badgeColor}-800/50 px-2 py-1 text-[9px] font-black uppercase tracking-widest">${role.slice(0,-1)}</span>
                    </td>
                    <td class="p-4 text-xs font-mono font-bold text-indigo-400">${docSnap.id}</td>
                    <td class="p-4 text-xs font-bold text-slate-200">${data.name || 'Unknown'}</td>
                    <td class="p-4 text-xs text-slate-500">${data.email || 'N/A'}</td>
                </tr>
            `;
        });
        
        // If appending (next page), add to existing rows. Otherwise, replace.
        if (direction === 'next') tbody.innerHTML += html;
        else tbody.innerHTML = html;

    } catch (e) {
        console.error("Failed to load members", e);
        tbody.innerHTML = '<tr><td colspan="4" class="p-8 text-center text-red-400 font-bold">Database Error. Check Console.</td></tr>';
    }
};

window.applyMemberFilter = () => {
    lastVisibleMemberDoc = null; // Reset cursor
    window.loadMembers('init');
};

document.getElementById('memberRoleFilter').addEventListener('change', window.applyMemberFilter);
// Allow Enter key in search to trigger
document.getElementById('memberSearchInput').addEventListener('keypress', (e) => {
    if(e.key === 'Enter') window.applyMemberFilter();
});
document.getElementById('triggerMemberSearchBtn').addEventListener('click', window.applyMemberFilter);
document.getElementById('loadNextMembersBtn').addEventListener('click', () => window.loadMembers('next'));


// ── Tab 3: Transaction Ledger Loader ───────────────────────────────────────
async function loadSchoolLedger(school) {
    const tbody = document.getElementById('ledgerTableBody');
    tbody.innerHTML = '<tr><td colspan="5" class="p-8 text-center text-indigo-400 font-bold"><i class="fa-solid fa-spinner fa-spin mr-2"></i> Querying Ledger...</td></tr>';
    
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
            tbody.innerHTML = '<tr><td colspan="5" class="p-8 text-center text-slate-500 font-bold italic">No transactions found.</td></tr>';
            return;
        }

        let rows = '';
        payments.forEach(p => {
            const date = new Date(p.timestamp).toLocaleDateString();
            const amount = p.amount ? `$${p.amount.toFixed(2)}` : '$0.00';
            const type = p.paymentType || 'Payment';
            const receipt = p.receiptUrl ? `<a href="${p.receiptUrl}" target="_blank" class="text-blue-400 hover:underline font-bold uppercase text-[10px] tracking-widest"><i class="fa-solid fa-file-invoice mr-1"></i> View</a>` : '<span class="text-slate-600">-</span>';
            const notes = (p.internalNotes && p.internalNotes.length > 0) ? p.internalNotes[0].note : '-';

            rows += `
            <tr class="border-b border-slate-800 hover:bg-slate-800/30 transition text-xs">
                <td class="p-4 text-slate-400 font-mono">${date}</td>
                <td class="p-4 font-bold text-white">${type}</td>
                <td class="p-4 text-emerald-400 font-black">${amount}</td>
                <td class="p-4 text-slate-400 truncate max-w-[200px]" title="${notes}">${notes}</td>
                <td class="p-4 text-right">${receipt}</td>
            </tr>`;
        });
        tbody.innerHTML = rows;

    } catch (e) {
        console.error("Failed to load ledger:", e);
        tbody.innerHTML = '<tr><td colspan="5" class="p-8 text-center text-red-400 font-bold">Failed to load transaction ledger.</td></tr>';
    }
}


// ── Admin Collaborative Notes ─────────────────────────────────────────────
function renderAdminNotes() {
    const container = document.getElementById('adminNotesContainer');
    const notes = currentSchool.adminNotes || [];
    
    if (notes.length === 0) {
        container.innerHTML = '<div class="p-6 text-center text-xs font-bold text-slate-500 italic border border-dashed border-slate-700 bg-slate-900/30">No internal notes logged.</div>';
        return;
    }
    
    let html = '';
    const sorted = [...notes].sort((a, b) => new Date(b.timestamp) - new Date(a.timestamp));
    
    sorted.forEach(n => {
        const dateStr = new Date(n.timestamp).toLocaleString();
        html += `
        <div class="border border-slate-700 bg-slate-900/50 p-4 mb-3 last:mb-0 relative group">
            <div class="flex justify-between items-center mb-2 border-b border-slate-800 pb-2">
                <span class="text-[10px] font-black text-indigo-400 uppercase tracking-widest"><i class="fa-solid fa-user-shield mr-1"></i> ${n.loggedByName || 'Admin'}</span>
                <span class="text-[9px] font-mono text-slate-500">${dateStr}</span>
            </div>
            <p class="text-xs text-slate-300 leading-relaxed">${n.note}</p>
        </div>`;
    });
    container.innerHTML = html;
}

document.getElementById('submitNoteBtn').addEventListener('click', async () => {
    const input = document.getElementById('newAdminNoteInput');
    const noteText = input.value.trim();
    if (!noteText || !currentSchool) return;
    
    const btn = document.getElementById('submitNoteBtn');
    btn.disabled = true;
    btn.innerHTML = '<i class="fa-solid fa-spinner fa-spin"></i> Saving...';
    
    try {
        const newNote = {
            note: noteText,
            timestamp: new Date().toISOString(),
            loggedBy: session.id,
            loggedByName: session.name
        };
        
        await updateDoc(doc(db, 'schools', currentSchool.id), {
            adminNotes: arrayUnion(newNote)
        });
        
        if (!currentSchool.adminNotes) currentSchool.adminNotes = [];
        currentSchool.adminNotes.push(newNote);
        
        input.value = '';
        renderAdminNotes();
    } catch (e) {
        console.error("Failed to add note", e);
        alert("Failed to save note. Check console.");
    }
    
    btn.disabled = false;
    btn.innerHTML = 'Save Note <i class="fa-solid fa-paper-plane ml-1"></i>';
});


// ── Toggle Suspension (Kill Switch) ───────────────────────────────────────
const toggleStatusBtn = document.getElementById('toggleStatusBtn');
if (toggleStatusBtn) {
    toggleStatusBtn.addEventListener('click', async () => {
        if (!currentSchool) return;

        const isSuspended = currentSchool.isVerified === false;
        const newStatus = isSuspended ? true : false;
        
        if (!newStatus) {
            if (!confirm(`DANGER: Are you absolutely sure you want to SUSPEND ${currentSchool.schoolName}?\n\nThis will immediately log out all associated teachers, students, and administrators.`)) return;
        }

        const originalContent = toggleStatusBtn.innerHTML;
        toggleStatusBtn.disabled = true;
        toggleStatusBtn.innerHTML = '<i class="fa-solid fa-circle-notch fa-spin mr-2"></i> Executing Override...';

        try {
            // Full Lifecycle Sync Payload
            const updatePayload = { 
                isVerified: newStatus,
                isActive: newStatus 
            };

            if (!newStatus) {
                // Kill Switch ON
                updatePayload.subscriptionStatus = 'Expired';
                updatePayload.subscriptionEndedAt = new Date().toISOString();
                updatePayload.statusReason = 'Manual Suspension';
            } else {
                // Kill Switch OFF (Restore)
                updatePayload.subscriptionStatus = 'Active';
                updatePayload.subscriptionEndedAt = null;
                updatePayload.statusReason = null;
                updatePayload.subscriptionActivatedAt = new Date().toISOString();
            }

            await updateDoc(doc(db, 'schools', currentSchool.id), updatePayload);
            
            window.closeSchoolPanel();
            loadSchools();
        } catch (e) {
            console.error("Status Toggle Failed:", e);
            alert("Failed to update school status.");
        }
        toggleStatusBtn.disabled = false;
        toggleStatusBtn.innerHTML = originalContent;
    });
}


// ── Override Limits Modal (Single Action Popup) ─────────────────────────
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
        window.closeSchoolPanel(); 
        loadSchools(); 

    } catch (e) {
        console.error("Limits Override Failed:", e);
        errorMsg.textContent = "An error occurred. Check console for details.";
        errorMsg.classList.remove('hidden');
    }
    btn.disabled = false;
    btn.innerHTML = 'Save Overrides & Log Payment <i class="fa-solid fa-check ml-1"></i>';
});


// ── Renewal & Upgrade Modal (Single Action Popup) ───────────────────────────
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
        
        // Full System Heal Payload
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
            isActive: true,
            isVerified: true,
            subscriptionStatus: 'Active',
            subscriptionEndedAt: null,
            statusReason: null,
            subscriptionActivatedAt: new Date().toISOString()
        });

        closeRenewalModal();
        window.closeSchoolPanel(); 
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
// Kept exactly as designed, appending the core tracking logic.
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

        let nextRenewalDate = new Date();
        if (cycleSelect === 'Monthly') nextRenewalDate.setMonth(nextRenewalDate.getMonth() + 1);
        else if (cycleSelect === 'Annual') nextRenewalDate.setFullYear(nextRenewalDate.getFullYear() + 1);
        else if (cycleSelect === 'Multi-Year') nextRenewalDate.setFullYear(nextRenewalDate.getFullYear() + 2);
        else nextRenewalDate.setFullYear(nextRenewalDate.getFullYear() + 1);

        const batch = writeBatch(db);

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

        const schoolRef = doc(db, 'schools', newSchoolId);
        batch.set(schoolRef, {
            schoolName,
            district,
            schoolType,
            superAdminId:         newSuperAdminId, 
            adminCode:            hashedPin,      
            securityQuestionsSet: false, 
            isSuperAdmin:         true,             
            isVerified:           true,
            isActive:             true,
            requiresPinReset:     false,
            
            subscriptionPlanId:   selectedPlan.id,
            subscriptionName:     selectedPlan.name,
            billingCycle:         actualCycle,
            nextRenewalDate:      nextRenewalDate.toISOString(),
            
            subscriptionStatus:      'Active',
            subscriptionActivatedAt: timestamp,
            subscriptionEndedAt:     null,
            statusReason:            null,
            adminNotes:              [],
            
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
        
        alert(`Deployment Successful!\n\nSchool Name: ${schoolName}\nSchool ID: ${newSchoolId}\nAdmin ID: ${newSuperAdminId}\n\nMake sure to provide these credentials to the school administrator.`);

    } catch (e) {
        console.error("Manual Deploy Failed:", e);
        errorMsg.textContent = "Failed to deploy infrastructure. Check console.";
        errorMsg.classList.remove('hidden');
    }

    btn.disabled = false;
    btn.innerHTML = '<i class="fa-solid fa-server mr-2"></i> Deploy Infrastructure';
});

// Init Data
loadSubscriptionPlans().then(() => loadSchools());
