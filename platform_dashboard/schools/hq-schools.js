import { db, storage } from '../../assets/js/firebase-init.js';
import { collection, getDocs, getDoc, doc, updateDoc, setDoc, query, where, writeBatch, arrayUnion, limit, startAfter, orderBy } from "https://www.gstatic.com/firebasejs/10.7.1/firebase-firestore.js";
import { ref, uploadBytes, getDownloadURL } from "https://www.gstatic.com/firebasejs/10.7.1/firebase-storage.js";
import { getFunctions, httpsCallable } from "https://www.gstatic.com/firebasejs/10.7.1/firebase-functions.js";

const functions = getFunctions();

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
    } else if (cycleType === '6 Months') {
        baseDate.setMonth(baseDate.getMonth() + 6);
    } else if (cycleType === 'Annual') {
        baseDate.setFullYear(baseDate.getFullYear() + 1);
    } else if (cycleType === 'Multi-Year') {
        baseDate.setFullYear(baseDate.getFullYear() + 2);
    } else {
        // Other / unknown — default to 1 year
        baseDate.setFullYear(baseDate.getFullYear() + 1);
    }
    return baseDate.toISOString();
}


function isoToDateInput(iso) {
    if (!iso) return '';
    return new Date(iso).toISOString().split('T')[0];
}

// ── Notification System Functions ──────────────────────────────────────────
window.showToast = (title, message, type = 'warning') => {
    const container = document.getElementById('toastContainer');
    if (!container) return;

    const colors = {
        warning: 'bg-amber-500',
        border: 'border-amber-700',
        icon: '<i class="fa-solid fa-triangle-exclamation text-amber-500 mt-0.5"></i>'
    };

    const toast = document.createElement('div');
    toast.className = `bg-slate-800 border ${colors.border} p-4 shadow-2xl shadow-black/50 w-80 transform translate-x-full opacity-0 transition-all duration-500 ease-out pointer-events-auto flex items-start gap-3 mb-3`;

    toast.innerHTML = `
        <div class="flex-shrink-0 text-lg">${colors.icon}</div>
        <div class="flex-1">
            <h4 class="text-xs font-black text-white uppercase tracking-widest">${title}</h4>
            <p class="text-xs text-slate-400 mt-1 leading-relaxed">${message}</p>
        </div>
        <button class="text-slate-500 hover:text-white transition flex-shrink-0" onclick="this.parentElement.remove()">
            <i class="fa-solid fa-xmark"></i>
        </button>
    `;

    container.appendChild(toast);

    setTimeout(() => toast.classList.remove('translate-x-full', 'opacity-0'), 10);
    setTimeout(() => {
        toast.classList.add('translate-x-full', 'opacity-0');
        setTimeout(() => toast.remove(), 500);
    }, 8000);
};

function populateNotificationBell(expiringSchools) {
    const badge = document.getElementById('notificationBadge');
    const list  = document.getElementById('notificationList');

    if (!badge || !list) return;

    if (expiringSchools.length > 0) {
        badge.textContent = expiringSchools.length;
        badge.classList.remove('hidden');

        expiringSchools.sort((a, b) => a.days - b.days);

        let html = '';
        expiringSchools.forEach(school => {
            html += `
                <div class="p-4 border-b border-slate-700 hover:bg-slate-800 transition">
                    <p class="text-xs font-bold text-white mb-1">${school.name} <span class="text-slate-500 font-mono font-normal">(${school.id})</span></p>
                    <p class="text-[10px] font-black uppercase tracking-widest text-amber-400">Expires in ${school.days} Days</p>
                </div>
            `;
        });
        list.innerHTML = html;
    } else {
        badge.classList.add('hidden');
        list.innerHTML = `
            <div class="p-6 text-center">
                <i class="fa-solid fa-circle-check text-emerald-500 text-3xl mb-2"></i>
                <p class="text-xs font-bold text-slate-400">You're all caught up!</p>
                <p class="text-[10px] text-slate-500 mt-1 uppercase tracking-widest">No impending expirations.</p>
            </div>
        `;
    }
}

// Global click listener to toggle/close the dropdown menu
document.addEventListener('click', (e) => {
    const bellBtn   = document.getElementById('notificationBellBtn');
    const dropdown  = document.getElementById('notificationDropdown');
    if (!bellBtn || !dropdown) return;

    if (bellBtn.contains(e.target)) {
        dropdown.classList.toggle('hidden');
    } else if (!dropdown.contains(e.target)) {
        dropdown.classList.add('hidden');
    }
});


// ── Load Schools (Main Table) ──────────────────────────────────────────────
async function loadSchools() {
    tbody.innerHTML = `<tr><td colspan="5" class="p-8 text-center text-indigo-400 font-semibold"><i class="fa-solid fa-spinner fa-spin mr-2"></i>Connecting to global registry...</td></tr>`;
    try {
        const snap = await getDocs(collection(db, 'schools'));
        allSchools = [];

        const expiringSchools = [];
        const now = new Date();

        snap.forEach(docSnap => {
            const data = docSnap.data();
            allSchools.push({ id: docSnap.id, ...data });

            // 14-Day Expiration Check & Notification Injection
            if (data.isVerified === true && data.nextRenewalDate) {
                const renDate      = new Date(data.nextRenewalDate);
                const msPerDay     = 1000 * 60 * 60 * 24;
                const daysRemaining = Math.ceil((renDate - now) / msPerDay);

                if (daysRemaining > 0 && daysRemaining <= 14) {
                    expiringSchools.push({
                        id:   docSnap.id,
                        name: data.schoolName || 'Unknown School',
                        days: daysRemaining
                    });

                    window.showToast(
                        'Subscription Expiring Soon',
                        `<strong class="text-white">${data.schoolName || 'Unknown'}</strong> (${docSnap.id}) will expire in ${daysRemaining} days.`,
                        'warning'
                    );
                }
            }
        });

        populateNotificationBell(expiringSchools);
        renderSchools();
    } catch (e) {
        console.error("Failed to load schools:", e);
        tbody.innerHTML = `<tr><td colspan="5" class="p-8 text-center text-red-400 font-bold">Failed to load network data. Check Rules.</td></tr>`;
    }
}

function renderSchools() {
    const term     = searchInput.value.toLowerCase().trim();
    const filtered = allSchools.filter(s =>
        (s.schoolName || '').toLowerCase().includes(term) ||
        (s.id || '').toLowerCase().includes(term)
    );

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
            const renDate       = new Date(data.nextRenewalDate);
            const isPastDue     = renDate < now;
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
    membersLoaded        = false;
    ledgerLoaded         = false;
    lastVisibleMemberDoc = null;

    // 2. Populate Sticky Header Context
    document.getElementById('panelHeaderName').textContent   = currentSchool.schoolName;
    document.getElementById('panelHeaderId').textContent     = currentSchool.id;
    const headerStatus = document.getElementById('panelHeaderStatus');
    if (currentSchool.isVerified === false) {
        headerStatus.innerHTML = `<span class="bg-red-900/40 text-red-400 border border-red-800 px-2 py-1 text-[10px] font-black uppercase tracking-wider">Suspended</span>`;
    } else {
        headerStatus.innerHTML = `<span class="bg-emerald-900/40 text-emerald-400 border border-emerald-800 px-2 py-1 text-[10px] font-black uppercase tracking-wider">Active</span>`;
    }

    // 3. Populate Profile Tab (Core Info)
    document.getElementById('manageEmail').textContent    = currentSchool.contactEmail || 'N/A';
    document.getElementById('manageAdminId').textContent  = currentSchool.superAdminId || 'N/A';

    // Show stateProvince + country if available, fallback to district for older records
    const location = [currentSchool.stateProvince || currentSchool.district, currentSchool.country]
        .filter(Boolean).join(', ') || 'N/A';
    document.getElementById('manageDistrict').textContent = location;
    document.getElementById('manageType').textContent     = currentSchool.schoolType || 'N/A';

    // Show/hide Cancel PayPal button based on whether school has a PayPal subscription
    const isPayPalSchool     = !!currentSchool.paypalSubscriptionId;
    const cancelPayPalWrap   = document.getElementById('cancelPayPalWrap');
    if (cancelPayPalWrap) cancelPayPalWrap.classList.toggle('hidden', !isPayPalSchool);

    // Update Renew button label
    const renewBtn = document.getElementById('openRenewalBtn');
    if (renewBtn) renewBtn.textContent = isPayPalSchool ? 'Override / Extend' : 'Renew / Update';

    // 4. Populate Subscription Tab Details
    document.getElementById('manageTier').textContent         = currentSchool.subscriptionName || 'Not Set';
    document.getElementById('manageBillingCycle').textContent = currentSchool.billingCycle     || 'Not Specified';

    document.getElementById('manageActivation').textContent = currentSchool.subscriptionActivatedAt
        ? new Date(currentSchool.subscriptionActivatedAt).toLocaleDateString() : 'N/A';
    document.getElementById('manageExpiration').textContent = currentSchool.nextRenewalDate
        ? new Date(currentSchool.nextRenewalDate).toLocaleDateString() : 'Not Set';

    const limits = currentSchool.limits || {};
    document.getElementById('manageLimitStudents').textContent = limits.studentLimit || '0';
    document.getElementById('manageLimitTeachers').textContent = limits.teacherLimit || '0';
    document.getElementById('manageLimitAdmins').textContent   = limits.adminLimit   || '0';

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

    // 7. Populate Edit School Info — start in read-only mode
    renderSchoolInfoReadOnly();

    // 8. Slide In the Panel
    const overlay = document.getElementById('schoolPanelOverlay');
    const panel   = document.getElementById('schoolSlidePanel');
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
    const panel   = document.getElementById('schoolSlidePanel');
    overlay.classList.add('opacity-0');
    panel.classList.add('translate-x-full');
    setTimeout(() => overlay.classList.add('hidden'), 300);
};
document.getElementById('closePanelBtn').addEventListener('click', window.closeSchoolPanel);

window.switchTab = (tabName) => {
    // Hide all contents
    document.querySelectorAll('.panel-tab-content').forEach(el => el.classList.add('hidden'));

    // Reset all buttons
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
        window.applyMemberFilter();
        membersLoaded = true;
    }
    if (tabName === 'ledger' && !ledgerLoaded) {
        loadSchoolLedger(currentSchool);
        ledgerLoaded = true;
    }
};


// ── Edit School Info: Read-only / Edit pattern ───────────────────────────
function renderSchoolInfoReadOnly() {
    document.getElementById('schoolInfoReadOnly').classList.remove('hidden');
    document.getElementById('schoolInfoEditForm').classList.add('hidden');
    document.getElementById('schoolInfoEditBtn').classList.remove('hidden');
    document.getElementById('schoolInfoSaveBtn').classList.add('hidden');
    document.getElementById('schoolInfoCancelBtn').classList.add('hidden');
    const editMsg = document.getElementById('editSchoolMsg');
    if (editMsg) { editMsg.classList.add('hidden'); editMsg.textContent = ''; }

    document.getElementById('roSchoolName').textContent   = currentSchool.schoolName   || '—';
    document.getElementById('roContactName').textContent  = currentSchool.contactName  || '—';
    document.getElementById('roContactEmail').textContent = currentSchool.contactEmail || '—';
    document.getElementById('roPhone').textContent        = currentSchool.phone        || '—';
}

window.activateSchoolEdit = function() {
    document.getElementById('editSchoolName').value    = currentSchool.schoolName   || '';
    document.getElementById('editContactName').value   = currentSchool.contactName  || '';
    document.getElementById('editContactEmail').value  = currentSchool.contactEmail || '';
    document.getElementById('editPhone').value         = currentSchool.phone        || '';
    const editMsg = document.getElementById('editSchoolMsg');
    if (editMsg) { editMsg.classList.add('hidden'); editMsg.textContent = ''; }
    document.getElementById('schoolInfoReadOnly').classList.add('hidden');
    document.getElementById('schoolInfoEditForm').classList.remove('hidden');
    document.getElementById('schoolInfoEditBtn').classList.add('hidden');
    document.getElementById('schoolInfoSaveBtn').classList.remove('hidden');
    document.getElementById('schoolInfoCancelBtn').classList.remove('hidden');
};

window.cancelSchoolEdit = function() {
    renderSchoolInfoReadOnly();
};

// ── Tab 2: Cursor Pagination & Target Search (Members) ────────────────────
window.loadMembers = async (direction = 'init') => {
    const role        = document.getElementById('memberRoleFilter').value;
    const searchTerm  = document.getElementById('memberSearchInput').value.trim();
    const membTbody   = document.getElementById('membersTableBody');
    const loadNextBtn = document.getElementById('loadNextMembersBtn');

    membTbody.innerHTML = '<tr><td colspan="4" class="p-8 text-center text-indigo-400 font-bold"><i class="fa-solid fa-spinner fa-spin mr-2"></i> Fetching records...</td></tr>';

    try {
        let snap;

        // PATH A: Targeted Direct Search (Bypasses Pagination)
        if (searchTerm) {
            memberSearchMode = true;
            const membersRef = role === 'admins'
                ? collection(db, `schools/${currentSchool.id}/admins`)
                : collection(db, role);

            // 1. Try Exact Email Match
            const qEmail = role === 'admins'
                ? query(membersRef, where('email', '==', searchTerm.toLowerCase()))
                : query(membersRef, where('currentSchoolId', '==', currentSchool.id), where('email', '==', searchTerm.toLowerCase()));

            snap = await getDocs(qEmail);

            // 2. Fallback: Try Exact ID Match
            if (snap.empty) {
                const docRef = role === 'admins'
                    ? doc(db, `schools/${currentSchool.id}/admins`, searchTerm.toUpperCase())
                    : doc(db, role, searchTerm.toUpperCase());

                const docSnap = await getDoc(docRef);
                if (docSnap.exists() && (role === 'admins' || docSnap.data().currentSchoolId === currentSchool.id)) {
                    snap = { docs: [docSnap], empty: false };
                }
            }
        }

        // PATH B: Standard Paginated Loading (Limit 20, sorted client-side — no composite index required)
        else {
            memberSearchMode = false;
            const membersRef = role === 'admins'
                ? collection(db, `schools/${currentSchool.id}/admins`)
                : collection(db, role);

            let qBase = role === 'admins'
                ? query(membersRef, limit(20))
                : query(membersRef, where('currentSchoolId', '==', currentSchool.id), limit(20));

            if (direction === 'next' && lastVisibleMemberDoc) {
                qBase = role === 'admins'
                    ? query(membersRef, startAfter(lastVisibleMemberDoc), limit(20))
                    : query(membersRef, where('currentSchoolId', '==', currentSchool.id), startAfter(lastVisibleMemberDoc), limit(20));
            }

            snap = await getDocs(qBase);

            // Sort client-side by name (avoids composite index requirement)
            if (!snap.empty) {
                const sortedDocs = [...snap.docs].sort((a, b) =>
                    (a.data().name || '').localeCompare(b.data().name || '')
                );
                snap = { docs: sortedDocs, empty: false };
            }
        }

        // Handle Empty State
        if (!snap || snap.empty) {
            membTbody.innerHTML = '<tr><td colspan="4" class="p-8 text-center text-slate-500 font-bold italic border-b border-slate-800">No records found.</td></tr>';
            loadNextBtn.classList.add('hidden');
            return;
        }

        // Manage Pagination Cursors
        if (!memberSearchMode) {
            lastVisibleMemberDoc = snap.docs[snap.docs.length - 1];
            if (snap.docs.length < 20) loadNextBtn.classList.add('hidden');
            else loadNextBtn.classList.remove('hidden');
        } else {
            loadNextBtn.classList.add('hidden');
        }

        // Render Table
        let html = '';
        snap.docs.forEach(docSnap => {
            const data        = docSnap.data();
            const badgeColor  = role === 'admins' ? 'amber' : role === 'teachers' ? 'blue' : 'emerald';

            html += `
                <tr class="border-b border-slate-800 hover:bg-slate-800/30 transition">
                    <td class="p-4">
                        <span class="bg-${badgeColor}-900/30 text-${badgeColor}-400 border border-${badgeColor}-800/50 px-2 py-1 text-[9px] font-black uppercase tracking-widest">${role.slice(0, -1)}</span>
                    </td>
                    <td class="p-4 text-xs font-mono font-bold text-indigo-400">${docSnap.id}</td>
                    <td class="p-4 text-xs font-bold text-slate-200">${data.name || 'Unknown'}</td>
                    <td class="p-4 text-xs text-slate-500">${data.email || 'N/A'}</td>
                </tr>
            `;
        });

        // If appending (next page), add to existing rows. Otherwise, replace.
        if (direction === 'next') membTbody.innerHTML += html;
        else membTbody.innerHTML = html;

    } catch (e) {
        console.error("Failed to load members", e);
        membTbody.innerHTML = '<tr><td colspan="4" class="p-8 text-center text-red-400 font-bold">Database Error. Check Console.</td></tr>';
    }
};

window.applyMemberFilter = () => {
    lastVisibleMemberDoc = null;
    window.loadMembers('init');
};

document.getElementById('memberRoleFilter').addEventListener('change', window.applyMemberFilter);
document.getElementById('memberSearchInput').addEventListener('keypress', (e) => {
    if (e.key === 'Enter') window.applyMemberFilter();
});
document.getElementById('triggerMemberSearchBtn').addEventListener('click', window.applyMemberFilter);
document.getElementById('loadNextMembersBtn').addEventListener('click', () => window.loadMembers('next'));


// ── Tab 3: Transaction Ledger Loader ───────────────────────────────────────
async function loadSchoolLedger(school) {
    const ledTbody = document.getElementById('ledgerTableBody');
    ledTbody.innerHTML = '<tr><td colspan="5" class="p-8 text-center text-indigo-400 font-bold"><i class="fa-solid fa-spinner fa-spin mr-2"></i> Querying Ledger...</td></tr>';

    try {
        const payments = [];

        const q1    = query(collection(db, 'payments'), where('schoolId', '==', school.id));
        const snap1 = await getDocs(q1);
        snap1.forEach(d => payments.push({ id: d.id, ...d.data() }));

        if (school.originalQuoteId) {
            const q2    = query(collection(db, 'payments'), where('reqId', '==', school.originalQuoteId));
            const snap2 = await getDocs(q2);
            snap2.forEach(d => {
                if (!payments.some(p => p.id === d.id)) payments.push({ id: d.id, ...d.data() });
            });
        }

        payments.sort((a, b) => new Date(b.timestamp) - new Date(a.timestamp));

        if (payments.length === 0) {
            ledTbody.innerHTML = '<tr><td colspan="5" class="p-8 text-center text-slate-500 font-bold italic">No transactions found.</td></tr>';
            return;
        }

        let rows = '';
        payments.forEach(p => {
            const date    = new Date(p.timestamp).toLocaleDateString();
            const amount  = p.amount ? `$${p.amount.toFixed(2)}` : '$0.00';
            const type    = p.paymentType || 'Payment';
            const notes   = (p.internalNotes && p.internalNotes.length > 0) ? p.internalNotes[0].note : '-';

            // Receipt cell — View + Update if exists, Upload if not
            let receiptCell;
            if (p.receiptUrl) {
                receiptCell = `
                    <div class="flex items-center justify-end gap-2">
                        <a href="${p.receiptUrl}" target="_blank"
                            class="text-blue-400 hover:underline font-bold uppercase text-[10px] tracking-widest">
                            <i class="fa-solid fa-file-invoice mr-1"></i> View
                        </a>
                        <button onclick="window.triggerLedgerReceiptUpload('${p.id}')"
                            class="text-slate-400 hover:text-white text-[10px] font-bold uppercase tracking-widest border border-slate-700 hover:border-slate-500 px-2 py-1 transition">
                            Update
                        </button>
                    </div>`;
            } else {
                receiptCell = `
                    <button onclick="window.triggerLedgerReceiptUpload('${p.id}')"
                        class="text-emerald-400 hover:text-white text-[10px] font-bold uppercase tracking-widest border border-emerald-900 hover:border-emerald-600 bg-emerald-900/20 px-2 py-1 transition">
                        <i class="fa-solid fa-upload mr-1"></i> Upload
                    </button>`;
            }

            rows += `
            <tr id="ledger-row-${p.id}" class="border-b border-slate-800 hover:bg-slate-800/30 transition text-xs">
                <td class="p-4 text-slate-400 font-mono">${date}</td>
                <td class="p-4 font-bold text-white">${type}</td>
                <td class="p-4 text-emerald-400 font-black">${amount}</td>
                <td class="p-4 text-slate-400 truncate max-w-[200px]" title="${notes}">${notes}</td>
                <td class="p-4 text-right">${receiptCell}</td>
            </tr>`;
        });
        ledTbody.innerHTML = rows;

    } catch (e) {
        console.error("Failed to load ledger:", e);
        ledTbody.innerHTML = '<tr><td colspan="5" class="p-8 text-center text-red-400 font-bold">Failed to load transaction ledger.</td></tr>';
    }
}

// ── Ledger receipt upload ─────────────────────────────────────────────────
window.triggerLedgerReceiptUpload = function(paymentId) {
    const input = document.getElementById('ledgerReceiptInput');
    if (!input) return;
    input.setAttribute('data-payment-id', paymentId);
    input.value = '';
    input.click();
};

document.addEventListener('DOMContentLoaded', () => {
    const ledgerInput = document.getElementById('ledgerReceiptInput');
    if (ledgerInput) {
        ledgerInput.addEventListener('change', async (e) => {
            const file      = e.target.files[0];
            const paymentId = ledgerInput.getAttribute('data-payment-id');
            if (!file || !paymentId) return;

            const row = document.getElementById(`ledger-row-${paymentId}`);
            const cell = row ? row.querySelector('td:last-child') : null;
            if (cell) cell.innerHTML = '<i class="fa-solid fa-spinner fa-spin text-slate-400"></i>';

            try {
                const storageRef = ref(storage, `receipts/${paymentId}_${file.name}`);
                await uploadBytes(storageRef, file);
                const receiptUrl = await getDownloadURL(storageRef);

                await updateDoc(doc(db, 'payments', paymentId), { receiptUrl });

                // Update row in place
                if (cell) {
                    cell.innerHTML = `
                        <div class="flex items-center justify-end gap-2">
                            <a href="${receiptUrl}" target="_blank"
                                class="text-blue-400 hover:underline font-bold uppercase text-[10px] tracking-widest">
                                <i class="fa-solid fa-file-invoice mr-1"></i> View
                            </a>
                            <button onclick="window.triggerLedgerReceiptUpload('${paymentId}')"
                                class="text-slate-400 hover:text-white text-[10px] font-bold uppercase tracking-widest border border-slate-700 hover:border-slate-500 px-2 py-1 transition">
                                Update
                            </button>
                        </div>`;
                }
            } catch (err) {
                console.error('[Ledger] Receipt upload failed:', err);
                if (cell) cell.innerHTML = '<span class="text-red-400 text-[10px] font-bold">Upload failed</span>';
            }
        });
    }
});


// ── Admin Collaborative Notes ─────────────────────────────────────────────
function renderAdminNotes() {
    const container = document.getElementById('adminNotesContainer');
    const notes     = currentSchool.adminNotes || [];

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
    const input    = document.getElementById('newAdminNoteInput');
    const noteText = input.value.trim();
    if (!noteText || !currentSchool) return;

    const btn = document.getElementById('submitNoteBtn');
    btn.disabled = true;
    btn.innerHTML = '<i class="fa-solid fa-spinner fa-spin"></i> Saving...';

    try {
        const newNote = {
            note:          noteText,
            timestamp:     new Date().toISOString(),
            loggedBy:      session.id,
            loggedByName:  session.name
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

    btn.disabled  = false;
    btn.innerHTML = 'Save Note <i class="fa-solid fa-paper-plane ml-1"></i>';
});


// ── Toggle Suspension (Kill Switch) ───────────────────────────────────────
const toggleStatusBtn = document.getElementById('toggleStatusBtn');
if (toggleStatusBtn) {
    toggleStatusBtn.addEventListener('click', async () => {
        if (!currentSchool) return;

        const isSuspended = currentSchool.isVerified === false;
        const newStatus   = isSuspended ? true : false;

        if (!newStatus) {
            if (!confirm(`DANGER: Are you absolutely sure you want to SUSPEND ${currentSchool.schoolName}?\n\nThis will immediately log out all associated teachers, students, and administrators.`)) return;
        }

        const originalContent  = toggleStatusBtn.innerHTML;
        toggleStatusBtn.disabled = true;
        toggleStatusBtn.innerHTML = '<i class="fa-solid fa-circle-notch fa-spin mr-2"></i> Executing Override...';

        try {
            const updatePayload = {
                isVerified: newStatus,
                isActive:   newStatus
            };

            if (!newStatus) {
                updatePayload.subscriptionStatus  = 'Expired';
                updatePayload.subscriptionEndedAt = new Date().toISOString();
                updatePayload.statusReason        = 'Manual Suspension';
            } else {
                updatePayload.subscriptionStatus     = 'Active';
                updatePayload.subscriptionEndedAt    = null;
                updatePayload.statusReason           = null;
                updatePayload.subscriptionActivatedAt = new Date().toISOString();
            }

            await updateDoc(doc(db, 'schools', currentSchool.id), updatePayload);

            window.closeSchoolPanel();
            loadSchools();
        } catch (e) {
            console.error("Status Toggle Failed:", e);
            alert("Failed to update school status.");
        }
        toggleStatusBtn.disabled  = false;
        toggleStatusBtn.innerHTML = originalContent;
    });
}


// ── Override Limits Modal ──────────────────────────────────────────────────
document.getElementById('openLimitsModalBtn').addEventListener('click', () => {
    document.getElementById('limSchoolName').textContent = currentSchool.schoolName;

    const limits = currentSchool.limits || {};
    document.getElementById('ovStudents').value = limits.studentLimit || 0;
    document.getElementById('ovTeachers').value = limits.teacherLimit || 0;
    document.getElementById('ovAdmins').value   = limits.adminLimit   || 0;

    document.getElementById('ovAmount').value  = '';
    document.getElementById('ovNotes').value   = '';
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
    const newStudents  = parseInt(document.getElementById('ovStudents').value);
    const newTeachers  = parseInt(document.getElementById('ovTeachers').value);
    const newAdmins    = parseInt(document.getElementById('ovAdmins').value);
    const amountPaid   = document.getElementById('ovAmount').value;
    const internalNote = document.getElementById('ovNotes').value.trim();
    const receiptFile  = document.getElementById('ovReceipt').files[0];
    const errorMsg     = document.getElementById('limitsErrorMsg');

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
            let receiptUrl  = null;

            if (receiptFile) {
                try {
                    const storageRef = ref(storage, `receipts/${paymentId}_${receiptFile.name}`);
                    await uploadBytes(storageRef, receiptFile);
                    receiptUrl = await getDownloadURL(storageRef);
                } catch (uploadErr) {
                    console.error('[Limits] Receipt upload failed:', uploadErr);
                    errorMsg.textContent = 'Receipt upload failed. Check Storage rules. You can save without a receipt by clearing the file.';
                    errorMsg.classList.remove('hidden');
                    btn.disabled  = false;
                    btn.innerHTML = 'Save Overrides & Log Payment <i class="fa-solid fa-check ml-1"></i>';
                    return;
                }
            }

            const notesArray = internalNote ? [{
                note:          internalNote,
                timestamp:     timestamp,
                loggedBy:      session.id,
                loggedByName:  session.name
            }] : [];

            await setDoc(doc(db, 'payments', paymentId), {
                schoolId:     currentSchool.id,
                schoolName:   currentSchool.schoolName,
                paymentType:  'Seat Add-On / Limit Override',
                amount:       parseFloat(amountPaid),
                billingCycle: 'One-Time Charge',
                receiptUrl:   receiptUrl,
                internalNotes: notesArray,
                loggedBy:     session.id,
                timestamp:    timestamp
            });
        }

        btn.innerHTML = '<i class="fa-solid fa-circle-notch fa-spin mr-2"></i> Saving Overrides...';

        await updateDoc(doc(db, 'schools', currentSchool.id), {
            limits: {
                studentLimit: newStudents,
                teacherLimit: newTeachers,
                adminLimit:   newAdmins
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
    btn.disabled  = false;
    btn.innerHTML = 'Save Overrides & Log Payment <i class="fa-solid fa-check ml-1"></i>';
});


// ── Renewal & Upgrade Modal ────────────────────────────────────────────────
document.getElementById('renCycle').addEventListener('change', (e) => {
    const customWrap = document.getElementById('renCustomCycleWrap');
    const val        = e.target.value;

    // Toggle custom term input
    if (val === 'Other') customWrap.classList.remove('hidden');
    else customWrap.classList.add('hidden');

    // Auto-populate the new renewal date picker
    const baseDateStr = currentSchool ? currentSchool.nextRenewalDate : null;
    if (val && val !== 'Other') {
        const calculated = calculateNewRenewalDate(val, baseDateStr);
        document.getElementById('renNewDate').value = isoToDateInput(calculated);
    }
});

document.getElementById('openRenewalBtn').addEventListener('click', () => {
    const isPayPalSchool = !!currentSchool.paypalSubscriptionId;

    // School name in header
    document.getElementById('renSchoolName').textContent = currentSchool.schoolName;

    // Subscription tier — read-only from school doc (always custom for manual)
    document.getElementById('renSubscriptionName').textContent =
        currentSchool.subscriptionName || 'Custom Plan';

    // Reference dates — read-only
    document.getElementById('renActivatedDate').textContent = currentSchool.subscriptionActivatedAt
        ? new Date(currentSchool.subscriptionActivatedAt).toLocaleDateString('en-US', { year: 'numeric', month: 'long', day: 'numeric' })
        : 'Not set';
    document.getElementById('renCurrentRenewal').textContent = currentSchool.nextRenewalDate
        ? new Date(currentSchool.nextRenewalDate).toLocaleDateString('en-US', { year: 'numeric', month: 'long', day: 'numeric' })
        : 'Not set';

    // Reset form fields
    document.getElementById('renAmount').value             = '';
    document.getElementById('renCycle').value              = 'Annual';
    document.getElementById('renCustomCycleWrap').classList.add('hidden');
    document.getElementById('renCustomCycle').value        = '';
    document.getElementById('renNotes').value              = '';
    document.getElementById('renReceipt').value            = '';
    document.getElementById('renewalErrorMsg').classList.add('hidden');

    // Auto-populate new renewal date based on default cycle (Annual)
    const calculated = calculateNewRenewalDate('Annual', currentSchool.nextRenewalDate);
    document.getElementById('renNewDate').value = isoToDateInput(calculated);

    // PayPal vs manual
    if (isPayPalSchool) {
        document.getElementById('renPayPalNote').classList.remove('hidden');
    } else {
        document.getElementById('renPayPalNote').classList.add('hidden');
    }

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
    const isPayPalSchool = !!currentSchool.paypalSubscriptionId;
    const amount         = document.getElementById('renAmount').value;
    const cycleSelect    = document.getElementById('renCycle').value;
    const customCycle    = document.getElementById('renCustomCycle').value.trim();
    const newDateValue   = document.getElementById('renNewDate').value;
    const internalNote   = document.getElementById('renNotes').value.trim();
    const receiptFile    = document.getElementById('renReceipt').files[0];
    const errorMsg       = document.getElementById('renewalErrorMsg');

    // Validation
    if (!amount || parseFloat(amount) < 0) {
        errorMsg.textContent = 'Please enter a payment amount (can be 0 for free renewals).';
        errorMsg.classList.remove('hidden'); return;
    }
    if (!newDateValue) {
        errorMsg.textContent = 'Please select a new renewal date.';
        errorMsg.classList.remove('hidden'); return;
    }

    const actualCycle    = cycleSelect === 'Other' ? (customCycle || 'Custom') : cycleSelect;
    // Use the date picker value — convert YYYY-MM-DD to ISO
    const newRenewalDate = new Date(newDateValue + 'T00:00:00').toISOString();
    const btn            = document.getElementById('confirmRenewalBtn');
    btn.disabled         = true;
    errorMsg.classList.add('hidden');

    try {
        const paymentId  = `PAY-${Date.now()}`;
        const timestamp  = new Date().toISOString();
        let   receiptUrl = null;

        if (receiptFile) {
            btn.innerHTML = '<i class="fa-solid fa-cloud-arrow-up fa-spin mr-2"></i> Uploading Receipt...';
            try {
                const storageRef = ref(storage, `receipts/${paymentId}_${receiptFile.name}`);
                await uploadBytes(storageRef, receiptFile);
                receiptUrl = await getDownloadURL(storageRef);
            } catch (uploadErr) {
                console.error('[Renewal] Receipt upload failed:', uploadErr);
                errorMsg.textContent = 'Receipt upload failed. Check Storage rules. You can save without a receipt by clearing the file.';
                errorMsg.classList.remove('hidden');
                btn.disabled  = false;
                btn.innerHTML = 'Confirm Renewal <i class="fa-solid fa-check ml-1"></i>';
                return;
            }
        }

        btn.innerHTML = '<i class="fa-solid fa-circle-notch fa-spin mr-2"></i> Logging Payment...';

        const notesArray = internalNote ? [{
            note:         internalNote,
            timestamp:    timestamp,
            loggedBy:     session.id,
            loggedByName: session.name
        }] : [];

        await setDoc(doc(db, 'payments', paymentId), {
            schoolId:      currentSchool.id,
            schoolName:    currentSchool.schoolName,
            paymentType:   'Renewal',
            amount:        parseFloat(amount),
            billingCycle:  actualCycle,
            receiptUrl:    receiptUrl,
            internalNotes: notesArray,
            loggedBy:      session.id,
            timestamp:     timestamp
        });

        btn.innerHTML = '<i class="fa-solid fa-circle-notch fa-spin mr-2"></i> Updating School...';

        const schoolUpdate = {
            nextRenewalDate:      newRenewalDate,
            isActive:             true,
            isVerified:           true,
            subscriptionStatus:   'Active',
            subscriptionEndedAt:  null,
            statusReason:         null
        };

        // Update billing cycle for both manual and PayPal if not Other
        if (cycleSelect !== 'No Extension' && cycleSelect !== 'Other') {
            schoolUpdate.billingCycle = actualCycle;
        } else if (cycleSelect === 'Other' && customCycle) {
            schoolUpdate.billingCycle = customCycle;
        }
        // Never touch subscriptionName, subscriptionPlanId, or limits —
        // those were set at approval and should only change via Override Limits

        await updateDoc(doc(db, 'schools', currentSchool.id), schoolUpdate);

        closeRenewalModal();
        window.closeSchoolPanel();
        loadSchools();

    } catch (e) {
        console.error('Renewal Failed:', e);
        errorMsg.textContent = 'An error occurred. Check console for details.';
        errorMsg.classList.remove('hidden');
    }
    btn.disabled  = false;
    btn.innerHTML = 'Confirm Renewal <i class="fa-solid fa-check ml-1"></i>';
});


// ── Manual Deploy Logic ────────────────────────────────────────────────────
document.getElementById('openDeployModalBtn').addEventListener('click', () => {
    document.getElementById('depFirstName').value    = '';
    document.getElementById('depLastName').value     = '';
    document.getElementById('depPhone').value        = '';
    document.getElementById('depSchoolName').value   = '';
    document.getElementById('depStateProvince').value = '';
    document.getElementById('depCountry').value       = '';
    document.getElementById('depSchoolType').value   = 'Primary';
    document.getElementById('depEmail').value        = '';
    document.getElementById('depContractTerm').value = 'Annual';
    document.getElementById('depCity').value         = '';
    document.getElementById('depNotes').value        = '';
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

document.getElementById('executeDeployBtn').addEventListener('click', async () => {
    const firstName    = document.getElementById('depFirstName').value.trim();
    const lastName     = document.getElementById('depLastName').value.trim();
    const phone        = document.getElementById('depPhone').value.trim();
    const schoolName   = document.getElementById('depSchoolName').value.trim();
    const stateProvince = document.getElementById('depStateProvince').value.trim();
    const country       = document.getElementById('depCountry').value.trim();
    const schoolType   = document.getElementById('depSchoolType').value;
    const email        = document.getElementById('depEmail').value.trim().toLowerCase();
    const contractTerm = document.getElementById('depContractTerm').value;
    const city         = document.getElementById('depCity').value.trim();
    const notes        = document.getElementById('depNotes').value.trim();
    const errorMsg     = document.getElementById('deployErrorMsg');

    if (!firstName || !lastName || !schoolName || !email || !contractTerm) {
        errorMsg.textContent = "Please fill in all required fields (*).";
        errorMsg.classList.remove('hidden'); return;
    }

    const btn = document.getElementById('executeDeployBtn');
    btn.disabled = true;
    btn.innerHTML = '<i class="fa-solid fa-circle-notch fa-spin mr-2"></i> Checking email...';

    try {
        // Duplicate email checks
        const regSnap = await getDoc(doc(db, 'registered_emails', email));
        if (regSnap.exists()) {
            errorMsg.textContent = "This email is already registered to an existing account.";
            errorMsg.classList.remove('hidden');
            btn.disabled = false;
            btn.innerHTML = '<i class="fa-solid fa-paper-plane mr-2"></i> Submit to Approvals →';
            return;
        }

        const qSnap = await getDocs(query(collection(db, 'quote_requests'), where('workEmail', '==', email)));
        if (!qSnap.empty) {
            errorMsg.textContent = "A quote for this email is already in the pipeline.";
            errorMsg.classList.remove('hidden');
            btn.disabled = false;
            btn.innerHTML = '<i class="fa-solid fa-paper-plane mr-2"></i> Submit to Approvals →';
            return;
        }

        btn.innerHTML = '<i class="fa-solid fa-circle-notch fa-spin mr-2"></i> Creating quote...';

        // Generate REQ ID
        const chars = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
        let rand = '';
        for (let i = 0; i < 5; i++) rand += chars.charAt(Math.floor(Math.random() * chars.length));
        const reqId = `REQ-${rand}`;

        await setDoc(doc(db, 'quote_requests', reqId), {
            requestId:     reqId,
            firstName,
            lastName,
            fullName:      `${firstName} ${lastName}`,
            jobTitle:      'Manual HQ Entry',
            workEmail:     email,
            phone,
            schoolName,
            schoolType,
            stateProvince,
            country,
            city,
            studentsCount: 0,
            teachersCount: 0,
            contractTerm,
            contractYears: null,
            hearAboutUs:   'Manual HQ Entry',
            message:       notes || '',
            status:        'Pending',
            fulfilled:     false,
            manualEntry:   true,
            createdBy:     session.id,
            createdAt:     new Date().toISOString()
        });

        closeDeployModal();
        window.showToast(
            'Quote Created',
            `<strong class="text-white">${schoolName}</strong> is now in the Approvals pipeline as <strong class="text-white">${reqId}</strong>.`,
            'warning'
        );

    } catch (e) {
        console.error("Manual Quote Failed:", e);
        errorMsg.textContent = "Failed to create quote entry. Check console.";
        errorMsg.classList.remove('hidden');
    }

    btn.disabled  = false;
    btn.innerHTML = '<i class="fa-solid fa-paper-plane mr-2"></i> Submit to Approvals →';
});

// ── Cancel PayPal Subscription ────────────────────────────────────────────
document.getElementById('cancelPayPalBtn').addEventListener('click', async () => {
    if (!currentSchool) return;
    if (!confirm(`This will:

• Cancel the PayPal subscription — stops future billing
• Immediately suspend their ConnectUs access
• Send them a cancellation email

Are you sure you want to cancel ${currentSchool.schoolName}?`)) return;

    const btn  = document.getElementById('cancelPayPalBtn');
    const orig = btn.innerHTML;
    btn.disabled  = true;
    btn.innerHTML = '<i class="fa-solid fa-circle-notch fa-spin mr-2"></i> Cancelling...';

    try {
        const cancelFn = httpsCallable(functions, 'cancelPayPalSubscription');
        await cancelFn({ schoolId: currentSchool.id });
        window.closeSchoolPanel();
        loadSchools();
        window.showToast('Subscription Cancelled', `${currentSchool.schoolName} has been cancelled and suspended.`);
    } catch (e) {
        console.error('Cancel PayPal failed:', e);
        alert(`Cancellation failed: ${e.message || 'Unknown error. Check console.'}`);
        btn.disabled  = false;
        btn.innerHTML = orig;
    }
});

// ── Edit School Info ──────────────────────────────────────────────────────
document.getElementById('schoolInfoSaveBtn').addEventListener('click', async () => {
    if (!currentSchool) return;

    const btn          = document.getElementById('schoolInfoSaveBtn');
    const msgEl        = document.getElementById('editSchoolMsg');
    const newName      = document.getElementById('editSchoolName').value.trim();
    const newContact   = document.getElementById('editContactName').value.trim();
    const newEmail     = document.getElementById('editContactEmail').value.trim().toLowerCase();
    const newPhone     = document.getElementById('editPhone').value.trim();

    // Basic validation
    if (!newName)  { showEditMsg('School name is required.', true); return; }
    if (!newEmail) { showEditMsg('Contact email is required.', true); return; }
    if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(newEmail)) {
        showEditMsg('Please enter a valid email address.', true); return;
    }

    btn.disabled  = true;
    btn.innerHTML = '<i class="fa-solid fa-circle-notch fa-spin mr-1"></i> Saving...';

    try {
        const currentEmail = (currentSchool.contactEmail || '').toLowerCase().trim();
        const emailChanged = newEmail !== currentEmail;
        const batch        = writeBatch(db);

        // ── Handle email change ───────────────────────────────────────────
        if (emailChanged) {
            // Check if new email is already taken
            const regSnap = await getDoc(doc(db, 'registered_emails', newEmail));
            if (regSnap.exists()) {
                showEditMsg('This email is already registered to another account.', true);
                btn.disabled  = false;
                btn.innerHTML = '<i class="fa-solid fa-floppy-disk"></i> Save Changes';
                return;
            }

            // Reserve the new email
            batch.set(doc(db, 'registered_emails', newEmail), {
                email:       newEmail,
                name:        newName || newContact,
                role:        'admin',
                referenceId: currentSchool.id,
                updatedAt:   new Date().toISOString()
            });

            // Release the old email
            if (currentEmail) {
                batch.delete(doc(db, 'registered_emails', currentEmail));
            }
        }

        // ── Update school doc ─────────────────────────────────────────────
        batch.update(doc(db, 'schools', currentSchool.id), {
            schoolName:   newName,
            contactName:  newContact,
            contactEmail: newEmail,
            phone:        newPhone
        });

        // ── Auto-log a note ───────────────────────────────────────────────
        const changeNote = {
            note:         `School info updated by HQ. Name: "${newName}", Email: "${newEmail}", Contact: "${newContact}", Phone: "${newPhone}".`,
            timestamp:    new Date().toISOString(),
            loggedBy:     session.id,
            loggedByName: session.name
        };
        batch.update(doc(db, 'schools', currentSchool.id), {
            adminNotes: arrayUnion(changeNote)
        });

        await batch.commit();

        // Update local state so panel reflects changes without reload
        currentSchool.schoolName   = newName;
        currentSchool.contactName  = newContact;
        currentSchool.contactEmail = newEmail;
        currentSchool.phone        = newPhone;

        // Refresh display values in panel header and identifiers
        document.getElementById('panelHeaderName').textContent = newName;
        document.getElementById('manageEmail').textContent     = newEmail;
        document.getElementById('managePhone').textContent     = newPhone || 'N/A';

        // Return to read-only view
        renderSchoolInfoReadOnly();

        // Update allSchools cache so table reflects change on close
        const idx = allSchools.findIndex(s => s.id === currentSchool.id);
        if (idx !== -1) Object.assign(allSchools[idx], { schoolName: newName, contactName: newContact, contactEmail: newEmail, phone: newPhone });

        // Re-render notes to include the auto-log
        if (!currentSchool.adminNotes) currentSchool.adminNotes = [];
        currentSchool.adminNotes.push(changeNote);
        renderAdminNotes();

        showEditMsg('Changes saved successfully.', false);

    } catch (e) {
        console.error('[EditSchoolInfo] Failed:', e);
        showEditMsg('Failed to save changes. Check console.', true);
    }

    btn.disabled  = false;
    btn.innerHTML = '<i class="fa-solid fa-floppy-disk mr-1"></i> Save Changes';
});

function showEditMsg(text, isError) {
    const el = document.getElementById('editSchoolMsg');
    if (!el) return;
    el.textContent  = text;
    el.className    = `text-xs font-bold ${isError ? 'text-red-400' : 'text-emerald-400'}`;
    el.classList.remove('hidden');
    setTimeout(() => el.classList.add('hidden'), 5000);
}

// Init Data
loadSchools();
