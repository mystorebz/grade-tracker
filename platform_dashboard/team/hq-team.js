import { db } from '../../assets/js/firebase-init.js';
import { collection, getDocs, doc, setDoc, updateDoc, deleteDoc } from "https://www.gstatic.com/firebasejs/10.7.1/firebase-firestore.js";

// ── Boot Sequence ──────────────────────────────────────────────────────────
const rawSession = localStorage.getItem('connectus_hq_session');
const session = JSON.parse(rawSession);

document.getElementById('hqAdminName').textContent = session.name;
document.getElementById('hqAdminId').textContent = session.id;
document.getElementById('hqAdminBadge').textContent = `Role: ${session.role}`;

const tbody = document.getElementById('teamTableBody');
let allTeam = [];
let editingMember = null;

// ── SHA-256 Hash ──────────────────────────────────────────────────────────────
async function sha256(text) {
    const encoded = new TextEncoder().encode(text.trim());
    const hashBuffer = await crypto.subtle.digest('SHA-256', encoded);
    return Array.from(new Uint8Array(hashBuffer)).map(b => b.toString(16).padStart(2, '0')).join('');
}

function generateHqId() {
    const chars = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
    let rand = '';
    for (let i = 0; i < 5; i++) rand += chars.charAt(Math.floor(Math.random() * chars.length));
    return `HQ-${rand}`;
}

// ── Load Team ─────────────────────────────────────────────────────────────
async function loadTeam() {
    tbody.innerHTML = `<tr><td colspan="5" class="p-8 text-center text-emerald-400 font-semibold"><i class="fa-solid fa-spinner fa-spin mr-2"></i>Accessing HQ Vault...</td></tr>`;
    
    try {
        const snap = await getDocs(collection(db, 'platform_admins'));
        allTeam = [];
        snap.forEach(docSnap => allTeam.push({ id: docSnap.id, ...docSnap.data() }));
        renderTeam();
    } catch (e) {
        console.error(e);
        tbody.innerHTML = `<tr><td colspan="5" class="p-8 text-center text-red-400 font-bold">Failed to load staff roster.</td></tr>`;
    }
}

function renderTeam() {
    tbody.innerHTML = allTeam.map(member => {
        const statusBadge = member.isActive === false 
            ? `<span class="bg-red-900/40 text-red-400 border border-red-800 px-2 py-1 rounded text-[10px] font-black uppercase tracking-wider">Suspended</span>`
            : `<span class="bg-emerald-900/40 text-emerald-400 border border-emerald-800 px-2 py-1 rounded text-[10px] font-black uppercase tracking-wider">Active</span>`;

        const isMe = member.id === session.id;
        const actionBtn = isMe 
            ? `<span class="text-xs text-slate-500 font-bold italic">You</span>`
            : `<button onclick="window.openEditModal('${member.id}')" class="bg-slate-700 hover:bg-slate-600 text-white font-bold px-4 py-1.5 rounded-lg text-xs transition border border-slate-600 shadow-sm">Manage</button>`;

        return `
            <tr class="border-b border-slate-800 hover:bg-slate-800/50 transition">
                <td class="p-4">
                    <p class="font-bold text-white">${member.name}</p>
                    <p class="text-[10px] font-mono text-slate-500">${member.id}</p>
                </td>
                <td class="p-4 font-bold text-slate-400">${member.email}</td>
                <td class="p-4 font-bold text-teal-400">${member.role}</td>
                <td class="p-4">${statusBadge}</td>
                <td class="p-4 text-right">${actionBtn}</td>
            </tr>`;
    }).join('');
}

// ── Add Member ───────────────────────────────────────────────────────────
window.openAddTeamModal = () => {
    const modal = document.getElementById('addTeamModal');
    modal.classList.remove('hidden');
    setTimeout(() => modal.classList.remove('opacity-0'), 10);
};

window.closeAddTeamModal = () => {
    const modal = document.getElementById('addTeamModal');
    modal.classList.add('opacity-0');
    setTimeout(() => modal.classList.add('hidden'), 300);
};

document.getElementById('saveTeamBtn').addEventListener('click', async () => {
    const name = document.getElementById('teamName').value.trim();
    const email = document.getElementById('teamEmail').value.trim();
    const pin = document.getElementById('teamPin').value;
    const role = document.getElementById('teamRole').value;

    if (!name || !email || !pin) return alert("Fill all fields");
    
    const hashedPin = await sha256(pin);
    const newId = generateHqId();

    try {
        await setDoc(doc(db, 'platform_admins', newId), {
            name, email, pin: hashedPin, role, isActive: true, createdAt: new Date().toISOString()
        });
        window.closeAddTeamModal();
        loadTeam();
    } catch (e) { console.error(e); }
});

// ── Edit/Manage Member Logic ──────────────────────────────────────────────
window.openEditModal = (id) => {
    editingMember = allTeam.find(m => m.id === id);
    if (!editingMember) return;

    document.getElementById('editStaffId').textContent = editingMember.id;
    document.getElementById('editName').value = editingMember.name;
    document.getElementById('editEmail').value = editingMember.email;
    document.getElementById('editPin').value = '';
    
    const activeBtn = document.getElementById('toggleActiveBtn');
    activeBtn.textContent = editingMember.isActive === false ? 'Restore Access' : 'Suspend Access';
    activeBtn.className = editingMember.isActive === false 
        ? "flex-1 bg-emerald-700 hover:bg-emerald-600 text-white font-bold py-2 rounded-lg text-xs transition"
        : "flex-1 bg-slate-700 hover:bg-slate-600 text-white font-bold py-2 rounded-lg text-xs transition";

    const modal = document.getElementById('editTeamModal');
    modal.classList.remove('hidden');
    setTimeout(() => modal.classList.remove('opacity-0'), 10);
};

window.closeEditModal = () => {
    const modal = document.getElementById('editTeamModal');
    modal.classList.add('opacity-0');
    setTimeout(() => modal.classList.add('hidden'), 300);
    editingMember = null;
};

// Update Info / Reset PIN
document.getElementById('updateStaffBtn').addEventListener('click', async () => {
    const name = document.getElementById('editName').value.trim();
    const email = document.getElementById('editEmail').value.trim();
    const newPin = document.getElementById('editPin').value;

    const updates = { name, email };
    if (newPin.length >= 6) {
        updates.pin = await sha256(newPin);
    }

    try {
        await updateDoc(doc(db, 'platform_admins', editingMember.id), updates);
        window.closeEditModal();
        loadTeam();
    } catch (e) { console.error(e); }
});

// Toggle Active/Inactive
document.getElementById('toggleActiveBtn').addEventListener('click', async () => {
    const newStatus = editingMember.isActive === false;
    try {
        await updateDoc(doc(db, 'platform_admins', editingMember.id), { isActive: newStatus });
        window.closeEditModal();
        loadTeam();
    } catch (e) { console.error(e); }
});

// Delete Staff Member
document.getElementById('deleteStaffBtn').addEventListener('click', async () => {
    if (!confirm(`Permanently remove ${editingMember.name} from HQ? This cannot be undone.`)) return;
    try {
        await deleteDoc(doc(db, 'platform_admins', editingMember.id));
        window.closeEditModal();
        loadTeam();
    } catch (e) { console.error(e); }
});

loadTeam();
