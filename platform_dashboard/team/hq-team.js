import { db } from '../../assets/js/firebase-init.js';
import { collection, getDocs, doc, setDoc, updateDoc } from "https://www.gstatic.com/firebasejs/10.7.1/firebase-firestore.js";

const tbody = document.getElementById('teamTableBody');
let allTeam = [];

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
export async function loadTeam() {
    tbody.innerHTML = `<tr><td colspan="5" class="p-8 text-center text-teal-400 font-semibold"><i class="fa-solid fa-spinner fa-spin mr-2"></i>Loading HQ Roster...</td></tr>`;
    
    try {
        const snap = await getDocs(collection(db, 'platform_admins'));
        allTeam = [];
        snap.forEach(docSnap => allTeam.push({ id: docSnap.id, ...docSnap.data() }));
        renderTeam();
    } catch (e) {
        console.error("Failed to load team:", e);
        tbody.innerHTML = `<tr><td colspan="5" class="p-8 text-center text-red-400 font-bold">Failed to load data.</td></tr>`;
    }
}

function renderTeam() {
    tbody.innerHTML = allTeam.map(member => {
        const statusBadge = member.isActive === false 
            ? `<span class="bg-red-900/40 text-red-400 border border-red-800 px-2 py-1 rounded text-[10px] font-black uppercase tracking-wider">Suspended</span>`
            : `<span class="bg-emerald-900/40 text-emerald-400 border border-emerald-800 px-2 py-1 rounded text-[10px] font-black uppercase tracking-wider">Active</span>`;

        // Prevent owner from suspending themselves
        const session = JSON.parse(localStorage.getItem('connectus_hq_session'));
        const isMe = member.id === session.id;
        
        let actionBtn = '';
        if (!isMe) {
            actionBtn = `<button onclick="window.toggleTeamStatus('${member.id}', ${member.isActive !== false})" class="bg-slate-700 hover:bg-slate-600 text-white font-bold px-3 py-1.5 rounded-lg text-xs transition border border-slate-600">
                ${member.isActive !== false ? 'Suspend' : 'Restore'}
            </button>`;
        } else {
            actionBtn = `<span class="text-xs text-slate-500 font-bold italic">You</span>`;
        }

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

// ── Add Team Member ───────────────────────────────────────────────────────
window.openAddTeamModal = () => {
    document.getElementById('teamName').value = '';
    document.getElementById('teamEmail').value = '';
    document.getElementById('teamPin').value = '';
    document.getElementById('teamRole').value = 'Support';
    document.getElementById('teamErrorMsg').classList.add('hidden');
    
    const modal = document.getElementById('addTeamModal');
    const inner = document.getElementById('addTeamModalInner');
    modal.classList.remove('hidden');
    setTimeout(() => { modal.classList.remove('opacity-0'); inner.classList.remove('scale-95'); }, 10);
};

window.closeAddTeamModal = () => {
    const modal = document.getElementById('addTeamModal');
    const inner = document.getElementById('addTeamModalInner');
    modal.classList.add('opacity-0'); inner.classList.add('scale-95');
    setTimeout(() => modal.classList.add('hidden'), 300);
};

document.getElementById('saveTeamBtn')?.addEventListener('click', async () => {
    const name = document.getElementById('teamName').value.trim();
    const email = document.getElementById('teamEmail').value.trim();
    const pin = document.getElementById('teamPin').value;
    const role = document.getElementById('teamRole').value;
    const errorMsg = document.getElementById('teamErrorMsg');

    if (!name || !email || !pin) {
        errorMsg.textContent = "All fields are required.";
        errorMsg.classList.remove('hidden'); return;
    }
    if (pin.length < 6) {
        errorMsg.textContent = "PIN must be at least 6 characters.";
        errorMsg.classList.remove('hidden'); return;
    }

    const btn = document.getElementById('saveTeamBtn');
    btn.disabled = true; btn.innerHTML = '<i class="fa-solid fa-circle-notch fa-spin mr-2"></i> Saving...';

    try {
        const newId = generateHqId();
        const hashedPin = await sha256(pin);

        await setDoc(doc(db, 'platform_admins', newId), {
            name, email, pin: hashedPin, role, isActive: true, createdAt: new Date().toISOString()
        });
        
        window.closeAddTeamModal();
        loadTeam();
        alert(`Team member created! Their ID is: ${newId}\nPlease securely share this with them.`);
    } catch (e) {
        console.error("Save Team Error:", e);
        errorMsg.textContent = "Failed to create team member.";
        errorMsg.classList.remove('hidden');
    }
    btn.disabled = false; btn.innerHTML = 'Add Team Member';
});

// ── Toggle Status ─────────────────────────────────────────────────────────
window.toggleTeamStatus = async (id, currentStatus) => {
    if (currentStatus && !confirm("Suspend this team member's access?")) return;
    try {
        await updateDoc(doc(db, 'platform_admins', id), { isActive: !currentStatus });
        loadTeam();
    } catch (e) {
        console.error("Toggle Team Error:", e);
        alert("Failed to update status.");
    }
};
