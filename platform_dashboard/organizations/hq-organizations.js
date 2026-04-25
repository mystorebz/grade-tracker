import { db } from '../../assets/js/firebase-init.js';
import { collection, getDocs, doc, setDoc, updateDoc } from "https://www.gstatic.com/firebasejs/10.7.1/firebase-firestore.js";

const tbody = document.getElementById('orgsTableBody');
let allOrgs = [];

// ── ID Generator ──────────────────────────────────────────────────────────
function generateOrgId() {
    const chars = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
    let rand = '';
    for (let i = 0; i < 5; i++) rand += chars.charAt(Math.floor(Math.random() * chars.length));
    return `ORG-${rand}`;
}

// ── Load Organizations ────────────────────────────────────────────────────
export async function loadOrganizations() {
    tbody.innerHTML = `<tr><td colspan="5" class="p-8 text-center text-indigo-400 font-semibold"><i class="fa-solid fa-spinner fa-spin mr-2"></i>Loading organizations...</td></tr>`;
    
    try {
        const snap = await getDocs(collection(db, 'organizations'));
        allOrgs = [];
        snap.forEach(docSnap => allOrgs.push({ id: docSnap.id, ...docSnap.data() }));
        renderOrgs();
    } catch (e) {
        console.error("Failed to load orgs:", e);
        tbody.innerHTML = `<tr><td colspan="5" class="p-8 text-center text-red-400 font-bold">Failed to load data.</td></tr>`;
    }
}

function renderOrgs() {
    if (allOrgs.length === 0) {
        tbody.innerHTML = `<tr><td colspan="5" class="p-8 text-center text-slate-500 font-semibold italic">No organizations created yet.</td></tr>`;
        return;
    }

    tbody.innerHTML = allOrgs.map(org => {
        const statusBadge = org.isActive === false 
            ? `<span class="bg-red-900/40 text-red-400 border border-red-800 px-2 py-1 rounded text-[10px] font-black uppercase tracking-wider">Suspended</span>`
            : `<span class="bg-emerald-900/40 text-emerald-400 border border-emerald-800 px-2 py-1 rounded text-[10px] font-black uppercase tracking-wider">Active</span>`;

        return `
            <tr class="border-b border-slate-800 hover:bg-slate-800/50 transition">
                <td class="p-4">
                    <p class="font-bold text-white">${org.name}</p>
                    <p class="text-[10px] font-mono text-slate-500">${org.id}</p>
                </td>
                <td class="p-4 font-bold text-slate-400">${org.type}</td>
                <td class="p-4 font-bold text-slate-400">${org.contactEmail}</td>
                <td class="p-4">${statusBadge}</td>
                <td class="p-4 text-right">
                    <button onclick="window.toggleOrgStatus('${org.id}', ${org.isActive !== false})" class="bg-slate-700 hover:bg-slate-600 text-white font-bold px-3 py-1.5 rounded-lg text-xs transition border border-slate-600">
                        ${org.isActive !== false ? 'Suspend' : 'Restore'}
                    </button>
                </td>
            </tr>`;
    }).join('');
}

// ── Create Organization ───────────────────────────────────────────────────
window.openAddOrgModal = () => {
    document.getElementById('orgName').value = '';
    document.getElementById('orgEmail').value = '';
    document.getElementById('orgType').value = 'Ministry';
    document.getElementById('orgErrorMsg').classList.add('hidden');
    
    const modal = document.getElementById('addOrgModal');
    const inner = document.getElementById('addOrgModalInner');
    modal.classList.remove('hidden');
    setTimeout(() => { modal.classList.remove('opacity-0'); inner.classList.remove('scale-95'); }, 10);
};

window.closeAddOrgModal = () => {
    const modal = document.getElementById('addOrgModal');
    const inner = document.getElementById('addOrgModalInner');
    modal.classList.add('opacity-0'); inner.classList.add('scale-95');
    setTimeout(() => modal.classList.add('hidden'), 300);
};

document.getElementById('saveOrgBtn')?.addEventListener('click', async () => {
    const name = document.getElementById('orgName').value.trim();
    const email = document.getElementById('orgEmail').value.trim();
    const type = document.getElementById('orgType').value;
    const errorMsg = document.getElementById('orgErrorMsg');

    if (!name || !email) {
        errorMsg.textContent = "Name and Email are required.";
        errorMsg.classList.remove('hidden'); return;
    }

    const btn = document.getElementById('saveOrgBtn');
    btn.disabled = true; btn.innerHTML = '<i class="fa-solid fa-circle-notch fa-spin mr-2"></i> Saving...';

    try {
        const newId = generateOrgId();
        await setDoc(doc(db, 'organizations', newId), {
            name, contactEmail: email, type, isActive: true, createdAt: new Date().toISOString()
        });
        window.closeAddOrgModal();
        loadOrganizations();
    } catch (e) {
        console.error("Save Org Error:", e);
        errorMsg.textContent = "Failed to create organization.";
        errorMsg.classList.remove('hidden');
    }
    btn.disabled = false; btn.innerHTML = 'Create Organization';
});

// ── Toggle Status ─────────────────────────────────────────────────────────
window.toggleOrgStatus = async (id, currentStatus) => {
    if (currentStatus && !confirm("Suspend this organization's access?")) return;
    try {
        await updateDoc(doc(db, 'organizations', id), { isActive: !currentStatus });
        loadOrganizations();
    } catch (e) {
        console.error("Toggle Org Error:", e);
        alert("Failed to update status.");
    }
};
