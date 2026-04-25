import { db } from '../../assets/js/firebase-init.js';
import { collection, getDocs, doc, setDoc, updateDoc } from "https://www.gstatic.com/firebasejs/10.7.1/firebase-firestore.js";

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

const tbody = document.getElementById('orgsTableBody');
const searchInput = document.getElementById('searchOrgs');
let allOrgs = [];

// ── Hashing & ID Helpers ───────────────────────────────────────────────────
async function sha256(text) {
    const normalized  = text.toLowerCase().trim();
    const encoded     = new TextEncoder().encode(normalized);
    const hashBuffer  = await crypto.subtle.digest('SHA-256', encoded);
    return Array.from(new Uint8Array(hashBuffer))
        .map(b => b.toString(16).padStart(2, '0'))
        .join('');
}

function generateOrgId() {
    const chars = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
    let rand = '';
    for (let i = 0; i < 5; i++) rand += chars.charAt(Math.floor(Math.random() * chars.length));
    return `ORG-${rand}`;
}

function generateAdminId() {
    const year  = new Date().getFullYear().toString().slice(-2);
    const chars = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
    let rand = '';
    for (let i = 0; i < 5; i++) rand += chars.charAt(Math.floor(Math.random() * chars.length));
    return `A${year}-${rand}`;
}

// ── Load Organizations ─────────────────────────────────────────────────────
async function loadOrganizations() {
    tbody.innerHTML = `<tr><td colspan="5" class="p-8 text-center text-indigo-400 font-semibold"><i class="fa-solid fa-spinner fa-spin mr-2"></i>Loading organizations...</td></tr>`;
    
    try {
        const snap = await getDocs(collection(db, 'organizations'));
        allOrgs = [];
        snap.forEach(docSnap => allOrgs.push({ id: docSnap.id, ...docSnap.data() }));
        renderOrganizations();
    } catch (e) {
        console.error("Failed to load organizations:", e);
        tbody.innerHTML = `<tr><td colspan="5" class="p-8 text-center text-red-400 font-bold">Failed to load data.</td></tr>`;
    }
}

function renderOrganizations() {
    const term = searchInput.value.toLowerCase().trim();
    const filtered = allOrgs.filter(o => (o.orgName || '').toLowerCase().includes(term) || (o.id || '').toLowerCase().includes(term));

    if (filtered.length === 0) {
        tbody.innerHTML = `<tr><td colspan="5" class="p-8 text-center text-slate-500 font-semibold italic">No organizations found.</td></tr>`;
        return;
    }

    let rows = '';
    filtered.forEach(data => {
        const isSuspended = data.isActive === false; 
        const statusBadge = isSuspended 
            ? `<span class="bg-red-900/40 text-red-400 border border-red-800 px-2 py-1 rounded text-[10px] font-black uppercase tracking-wider">Suspended</span>`
            : `<span class="bg-emerald-900/40 text-emerald-400 border border-emerald-800 px-2 py-1 rounded text-[10px] font-black uppercase tracking-wider">Active</span>`;

        const actionBtnText = isSuspended ? 'Restore' : 'Suspend';
        const actionBtnClass = isSuspended ? 'bg-emerald-700 hover:bg-emerald-600' : 'bg-slate-700 hover:bg-slate-600';

        rows += `
            <tr class="border-b border-slate-800 hover:bg-slate-800/50 transition">
                <td class="p-4">
                    <p class="font-bold text-white">${data.orgName}</p>
                    <p class="text-[10px] font-mono text-slate-500">${data.id}</p>
                </td>
                <td class="p-4">
                    <span class="text-xs font-bold text-indigo-400 bg-indigo-900/20 border border-indigo-800 px-2 py-1 rounded-lg">${data.orgType || 'N/A'}</span>
                </td>
                <td class="p-4">
                    <p class="font-bold text-slate-300 text-xs">${data.contactName || 'N/A'}</p>
                    <p class="text-xs text-slate-500">${data.contactEmail || 'No Email'}</p>
                </td>
                <td class="p-4">${statusBadge}</td>
                <td class="p-4 text-right">
                    <button onclick="window.toggleOrgStatus('${data.id}', ${!isSuspended})" class="${actionBtnClass} text-white font-bold px-3 py-1.5 rounded-lg text-xs transition shadow-md border border-slate-600">
                        ${actionBtnText}
                    </button>
                </td>
            </tr>`;
    });
    tbody.innerHTML = rows;
}

if (searchInput) searchInput.addEventListener('input', renderOrganizations);
document.getElementById('refreshOrgsBtn').addEventListener('click', loadOrganizations);

// ── Deploy Modal Interactions ──────────────────────────────────────────────
document.getElementById('openAddOrgBtn').addEventListener('click', () => {
    // Reset Form
    document.getElementById('orgName').value = '';
    document.getElementById('orgType').value = 'Government Ministry';
    document.getElementById('orgCustomTypeWrap').classList.add('hidden');
    document.getElementById('orgCustomType').value = '';
    document.getElementById('orgLicense').value = '';
    document.getElementById('orgAddress').value = '';
    
    document.getElementById('orgContactName').value = '';
    document.getElementById('orgContactEmail').value = '';
    document.getElementById('orgContactPhone').value = '';
    document.getElementById('orgAdminPin').value = '';
    document.getElementById('orgErrorMsg').classList.add('hidden');

    const modal = document.getElementById('addOrgModal');
    const inner = document.getElementById('addOrgModalInner');
    modal.classList.remove('hidden');
    setTimeout(() => { modal.classList.remove('opacity-0'); inner.classList.remove('scale-95'); }, 10);
});

const closeDeployModal = () => {
    const modal = document.getElementById('addOrgModal');
    const inner = document.getElementById('addOrgModalInner');
    modal.classList.add('opacity-0'); inner.classList.add('scale-95');
    setTimeout(() => modal.classList.add('hidden'), 300);
};
document.getElementById('closeOrgBtnDesktop').addEventListener('click', closeDeployModal);
document.getElementById('closeOrgBtnMobile').addEventListener('click', closeDeployModal);

document.getElementById('orgType').addEventListener('change', (e) => {
    const customWrap = document.getElementById('orgCustomTypeWrap');
    if (e.target.value === 'Other') customWrap.classList.remove('hidden');
    else customWrap.classList.add('hidden');
});

// ── Execute Organization Deployment ────────────────────────────────────────
document.getElementById('executeOrgDeployBtn').addEventListener('click', async () => {
    const orgName = document.getElementById('orgName').value.trim();
    const typeSelect = document.getElementById('orgType').value;
    const customType = document.getElementById('orgCustomType').value.trim();
    const license = document.getElementById('orgLicense').value.trim();
    const address = document.getElementById('orgAddress').value.trim();
    
    const contactName = document.getElementById('orgContactName').value.trim();
    const contactEmail = document.getElementById('orgContactEmail').value.trim();
    const contactPhone = document.getElementById('orgContactPhone').value.trim();
    const pin = document.getElementById('orgAdminPin').value;

    const errorMsg = document.getElementById('orgErrorMsg');

    if (!orgName || !contactName || !contactEmail || !pin) {
        errorMsg.textContent = "Please fill in all required fields (*).";
        errorMsg.classList.remove('hidden'); return;
    }
    if (pin.length < 6) {
        errorMsg.textContent = "Admin PIN must be at least 6 characters.";
        errorMsg.classList.remove('hidden'); return;
    }

    const actualType = typeSelect === 'Other' ? (customType || 'Custom Organization') : typeSelect;
    const btn = document.getElementById('executeOrgDeployBtn');
    btn.disabled = true;

    try {
        btn.innerHTML = '<i class="fa-solid fa-circle-notch fa-spin mr-2"></i> Deploying...';
        
        const timestamp = new Date().toISOString();
        const hashedPin = await sha256(pin);
        const newOrgId = generateOrgId();
        const newSuperAdminId = generateAdminId();

        const orgRef = doc(db, 'organizations', newOrgId);
        
        await setDoc(orgRef, {
            orgName: orgName,
            orgType: actualType,
            licenseNumber: license,
            address: address,
            
            contactName: contactName,
            contactEmail: contactEmail,
            contactPhone: contactPhone,
            
            superAdminId: newSuperAdminId,
            adminCode: hashedPin,
            securityQuestionsSet: false, // Forces them to set security Q's on login
            
            isActive: true,
            createdAt: timestamp
        });

        closeDeployModal();
        loadOrganizations();
        
        alert(`Organization Deployed Successfully!\n\nOrg ID: ${newOrgId}\nAdmin ID: ${newSuperAdminId}\n\nProvide these credentials to ${contactName}.`);

    } catch (e) {
        console.error("Org Deploy Failed:", e);
        errorMsg.textContent = "Failed to deploy organization. Check console.";
        errorMsg.classList.remove('hidden');
    }

    btn.disabled = false;
    btn.innerHTML = '<i class="fa-solid fa-server mr-2"></i> Deploy Organization';
});

// ── Toggle Suspension (Kill Switch) ───────────────────────────────────────
window.toggleOrgStatus = async (orgId, currentlyActive) => {
    const action = currentlyActive ? "SUSPEND" : "RESTORE";
    if (!confirm(`Are you sure you want to ${action} this organization?`)) return;

    try {
        await updateDoc(doc(db, 'organizations', orgId), { isActive: !currentlyActive });
        loadOrganizations();
    } catch (e) {
        console.error("Status Toggle Failed:", e);
        alert("Failed to update organization status.");
    }
};

// Init Data
loadOrganizations();
