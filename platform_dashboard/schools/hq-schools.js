import { db } from '../../assets/js/firebase-init.js';
import { collection, getDocs, doc, updateDoc } from "https://www.gstatic.com/firebasejs/10.7.1/firebase-firestore.js";

const tbody = document.getElementById('schoolsTableBody');
const searchInput = document.getElementById('searchSchools');
let allSchools = [];
let currentSchool = null;

// ── Load Schools ───────────────────────────────────────────────────────────
export async function loadSchools() {
    tbody.innerHTML = `<tr><td colspan="5" class="p-8 text-center text-indigo-400 font-semibold"><i class="fa-solid fa-spinner fa-spin mr-2"></i>Connecting to global registry...</td></tr>`;
    
    try {
        const snap = await getDocs(collection(db, 'schools'));
        allSchools = [];

        snap.forEach(docSnap => {
            allSchools.push({ id: docSnap.id, ...docSnap.data() });
        });

        renderSchools();
    } catch (e) {
        console.error("Failed to load schools:", e);
        tbody.innerHTML = `<tr><td colspan="5" class="p-8 text-center text-red-400 font-bold">Failed to load network data.</td></tr>`;
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
    filtered.forEach(data => {
        const isSuspended = data.isActive === false; 
        
        const statusBadge = isSuspended 
            ? `<span class="bg-red-900/40 text-red-400 border border-red-800 px-2 py-1 rounded text-[10px] font-black uppercase tracking-wider">Suspended</span>`
            : `<span class="bg-emerald-900/40 text-emerald-400 border border-emerald-800 px-2 py-1 rounded text-[10px] font-black uppercase tracking-wider">Active</span>`;

        rows += `
            <tr class="border-b border-slate-800 hover:bg-slate-800/50 transition">
                <td class="p-4">
                    <p class="font-bold text-white">${data.schoolName || 'Unnamed'}</p>
                    <p class="text-[10px] font-mono text-slate-500">${data.id}</p>
                </td>
                <td class="p-4 font-bold text-slate-400">${data.district || '—'}</td>
                <td class="p-4 font-mono text-xs text-indigo-400 font-bold">${data.superAdminId || '—'}</td>
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
const refreshBtn = document.getElementById('refreshSchoolsBtn');
if (refreshBtn) refreshBtn.addEventListener('click', loadSchools);

// ── Modal Handlers ────────────────────────────────────────────────────────
window.openSchoolModal = (schoolId) => {
    currentSchool = allSchools.find(s => s.id === schoolId);
    if (!currentSchool) return;

    document.getElementById('manageSchoolName').textContent = currentSchool.schoolName;
    document.getElementById('manageSchoolId').textContent = currentSchool.id;
    document.getElementById('manageAdminId').textContent = currentSchool.superAdminId || 'N/A';
    document.getElementById('manageEmail').textContent = currentSchool.contactEmail || 'N/A';
    
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
    setTimeout(() => {
        modal.classList.remove('opacity-0');
        inner.classList.remove('scale-95');
    }, 10);
};

window.closeSchoolModal = () => {
    const modal = document.getElementById('schoolManageModal');
    const inner = document.getElementById('schoolManageModalInner');
    modal.classList.add('opacity-0');
    inner.classList.add('scale-95');
    setTimeout(() => modal.classList.add('hidden'), 300);
    currentSchool = null;
};

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
            currentSchool.isActive = newStatus;
            window.closeSchoolModal();
            renderSchools();
        } catch (e) {
            console.error("Status Toggle Failed:", e);
            alert("Failed to update school status.");
            btn.disabled = false;
            btn.innerHTML = originalContent;
        }
    });
}
