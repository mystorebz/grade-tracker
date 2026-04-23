import { db } from '../../assets/js/firebase-init.js';
import { collection, query, where, getDocs, doc, getDoc } from "https://www.gstatic.com/firebasejs/10.7.1/firebase-firestore.js";
import { requireAuth } from '../../assets/js/auth.js';
import { injectStudentLayout } from '../../assets/js/layout-student.js';

// ── 1. INIT & AUTH ────────────────────────────────────────────────────────
const session = requireAuth('student', '../login.html');

// Inject layout
injectStudentLayout('gradebook', 'Current Grades', 'Detailed grades for the active period');

// Update UI with session data
document.getElementById('displayStudentName').innerText = session.studentData.name || 'Student';
document.getElementById('studentAvatar').innerText = (session.studentData.name || 'S').charAt(0).toUpperCase();
document.getElementById('displayStudentClass').innerText = session.studentData.className ? `Class: ${session.studentData.className}` : 'Unassigned Class';

// Elements
const gradesLoader = document.getElementById('gradesLoader');
const currentSubjectsContainer = document.getElementById('currentSubjectsContainer');
const noCurrentGradesMsg = document.getElementById('noCurrentGradesMsg');

// State
let currentGrades = [];
let schoolActiveSemesterId = null;

// ── 2. UI HELPERS ─────────────────────────────────────────────────────────
function getGradeStyle(p) {
    if (p >= 90) return { cls: 'text-emerald-700 bg-emerald-50 border-emerald-200', ltr: 'A' };
    if (p >= 80) return { cls: 'text-blue-700 bg-blue-50 border-blue-200', ltr: 'B' };
    if (p >= 70) return { cls: 'text-teal-700 bg-teal-50 border-teal-200', ltr: 'C' };
    if (p >= 65) return { cls: 'text-amber-700 bg-amber-50 border-amber-200', ltr: 'D' };
    return { cls: 'text-red-700 bg-red-50 border-red-200', ltr: 'F' };
}

function gradeColorText(p) {
    if (p >= 90) return 'text-emerald-600'; if (p >= 80) return 'text-blue-600';
    if (p >= 70) return 'text-teal-600'; if (p >= 65) return 'text-amber-600'; return 'text-red-600';
}

function isNew(dateStr, createdStr) {
    const d = createdStr ? new Date(createdStr) : new Date(dateStr);
    if (isNaN(d)) return false;
    return Math.ceil(Math.abs(new Date() - d) / (1000 * 60 * 60 * 24)) <= 5;
}

window.toggleAccordion = function(h) {
    const b = h.nextElementSibling;
    b.classList.toggle('open');
    h.querySelector('.fa-chevron-down').style.transform = b.classList.contains('open') ? 'rotate(180deg)' : 'rotate(0deg)';
};

// ── 3. FETCH & RENDER GRADES ──────────────────────────────────────────────
async function loadCurrentGrades() {
    try {
        // Fetch School Data to get activeSemesterId & Name
        const schoolSnap = await getDoc(doc(db, 'schools', session.schoolId));
        if (schoolSnap.exists()) {
            document.getElementById('displaySchoolName').innerText = schoolSnap.data().schoolName;
            schoolActiveSemesterId = schoolSnap.data().activeSemesterId;
        }

        if (!schoolActiveSemesterId) {
            gradesLoader.classList.add('hidden');
            noCurrentGradesMsg.classList.remove('hidden');
            document.getElementById('activeSemesterDisplay').textContent = "Not Set";
            return;
        }

        // Fetch semester name for topbar
        const semSnap = await getDoc(doc(db, 'schools', session.schoolId, 'semesters', schoolActiveSemesterId));
        if (semSnap.exists()) {
            document.getElementById('activeSemesterDisplay').textContent = semSnap.data().name;
        }

        // Fetch Grades for active semester
        const q = query(
            collection(db, 'schools', session.schoolId, 'students', session.studentId, 'grades'),
            where('semesterId', '==', schoolActiveSemesterId)
        );
        const gSnap = await getDocs(q);
        
        currentGrades = gSnap.docs.map(d => ({ id: d.id, ...d.data() }));

        gradesLoader.classList.add('hidden');
        renderSubjectAccordions(currentGrades);

    } catch (e) {
        console.error("Error fetching grades:", e);
        gradesLoader.innerHTML = '<p class="text-red-500 font-bold">Failed to load grades. Please refresh.</p>';
    }
}

function renderSubjectAccordions(grades) {
    if (!grades.length) { 
        currentSubjectsContainer.innerHTML = ''; 
        noCurrentGradesMsg.classList.remove('hidden'); 
        return; 
    }
    
    noCurrentGradesMsg.classList.add('hidden');

    const bySub = {};
    grades.forEach(g => { 
        const s = g.subject || 'Uncategorized'; 
        if (!bySub[s]) bySub[s] = []; 
        bySub[s].push(g); 
    });

    currentSubjectsContainer.innerHTML = Object.entries(bySub).map(([subject, gList]) => {
        const avg = gList.reduce((a, g) => a + (g.max ? (g.score / g.max) * 100 : 0), 0) / gList.length;
        const style = getGradeStyle(Math.round(avg));
        
        const rows = gList.sort((a, b) => (b.date || '').localeCompare(a.date || '')).map(g => {
            const pct = g.max ? Math.round((g.score / g.max) * 100) : null;
            const pColor = pct !== null ? gradeColorText(pct) : 'text-slate-500';
            const badge = isNew(g.date, g.createdAt) ? `<span class="new-badge">New</span>` : '';
            const hasNotes = g.notes || (g.historyLogs && g.historyLogs.length > 0);
            
            return `
            <div class="bg-white border border-slate-200 rounded-xl p-3 sm:p-4 flex items-center justify-between hover:shadow-md transition cursor-pointer mb-2 last:mb-0" onclick="window.viewGradeDetails('${g.id}')">
                <div class="flex-1 min-w-0">
                    <p class="font-black text-slate-800 text-sm sm:text-base truncate">${g.title} ${badge}</p>
                    <p class="text-xs text-slate-400 font-bold mt-1 uppercase tracking-wider">${g.type} • ${g.date}</p>
                </div>
                <div class="flex items-center gap-3 sm:gap-5 flex-shrink-0 ml-2">
                    <div class="text-right">
                        <span class="block text-[10px] uppercase font-bold text-slate-400 tracking-wider">Score</span>
                        <span class="font-black text-sm sm:text-base ${pColor}">${g.score}/${g.max||'?'}</span>
                    </div>
                    <div class="hidden sm:block text-right">
                        <span class="block text-[10px] uppercase font-bold text-slate-400 tracking-wider">Pct</span>
                        <span class="font-black text-sm sm:text-base ${pColor}">${pct !== null ? pct + '%' : '—'}</span>
                    </div>
                    ${hasNotes ? '<i class="fa-solid fa-comment-dots text-indigo-400 text-lg drop-shadow-sm ml-1"></i>' : '<i class="fa-solid fa-chevron-right text-slate-300 ml-1"></i>'}
                </div>
            </div>`;
        }).join('');

        return `
        <div class="bg-white rounded-3xl shadow-sm border border-slate-200 overflow-hidden transition-shadow hover:shadow-md">
            <div class="p-5 sm:p-6 border-b border-slate-100 flex justify-between items-center cursor-pointer bg-slate-50/50 hover:bg-slate-100/50 transition" onclick="window.toggleAccordion(this)">
                <div class="flex items-center gap-4">
                    <div class="w-12 h-12 bg-gradient-to-br from-indigo-500 to-purple-600 text-white rounded-xl flex items-center justify-center font-black text-lg shadow-sm">${subject.charAt(0)}</div>
                    <div>
                        <h3 class="text-lg sm:text-xl font-extrabold text-slate-800">${subject}</h3>
                        <p class="text-xs text-slate-500 font-bold mt-1 uppercase tracking-wider">${gList.length} Assignment${gList.length !== 1 ? 's' : ''}</p>
                    </div>
                </div>
                <div class="flex items-center gap-4">
                    <div class="text-right hidden sm:block">
                        <span class="block text-[10px] uppercase font-bold text-slate-400 tracking-wider mb-1">Average</span>
                        <span class="px-3 py-1.5 rounded-xl font-black text-sm border shadow-sm ${style.cls}">${Math.round(avg)}% • ${style.ltr}</span>
                    </div>
                    <div class="sm:hidden px-3 py-1 rounded-xl font-black text-sm border shadow-sm ${style.cls}">${Math.round(avg)}%</div>
                    <i class="fa-solid fa-chevron-down text-slate-400 transition-transform duration-200 text-lg"></i>
                </div>
            </div>
            <div class="subject-body"><div class="p-4 sm:p-5 bg-slate-50 border-t border-slate-100 shadow-inner">${rows}</div></div>
        </div>`;
    }).join('');
}

// ── 4. GRADE DETAIL MODAL ─────────────────────────────────────────────────
window.viewGradeDetails = function(gradeId) {
    const g = currentGrades.find(x => x.id === gradeId); 
    if (!g) return;
    
    const p = g.max ? Math.round((g.score / g.max) * 100) : 0;
    
    document.getElementById('modalTitle').innerText = g.title;
    document.getElementById('modalMeta').innerText = `${g.date} • ${g.subject} • ${g.type}`;
    document.getElementById('modalScore').innerText = `${g.score} / ${g.max}`;
    
    const pEl = document.getElementById('modalPercentage');
    pEl.innerText = `${p}%`; 
    pEl.className = `font-black text-3xl ${gradeColorText(p)}`;
    
    const notesEl = document.getElementById('modalNotes');
    if (g.notes) {
        notesEl.innerText = g.notes;
        notesEl.className = "bg-indigo-50 border-l-4 border-indigo-500 p-5 rounded-r-2xl text-sm text-indigo-900 whitespace-pre-wrap leading-relaxed shadow-sm font-bold";
    } else {
        notesEl.innerText = "No specific notes provided by teacher.";
        notesEl.className = "bg-slate-50 border-l-4 border-slate-300 p-5 rounded-r-2xl text-sm text-slate-500 italic whitespace-pre-wrap leading-relaxed";
    }
    
    const histSec = document.getElementById('historySection');
    const histEl = document.getElementById('modalHistory');
    
    if (g.historyLogs && g.historyLogs.length > 0) {
        histSec.classList.remove('hidden');
        histEl.innerHTML = g.historyLogs.map(log => 
            `<div class="bg-amber-50/50 border border-amber-200 p-3 text-[11px] text-amber-800 rounded-xl shadow-sm font-bold leading-relaxed"><i class="fa-solid fa-clock-rotate-left mr-1"></i>${typeof log === 'object' ? `[${log.changedAt}] Changed from ${log.oldScore} to ${log.newScore}. Reason: ${log.reason}` : log}</div>`
        ).join('');
    } else {
        histSec.classList.add('hidden');
    }
    
    const modal = document.getElementById('assignmentModal');
    const inner = document.getElementById('assignmentModalInner');
    modal.classList.remove('hidden');
    
    setTimeout(() => { 
        modal.classList.remove('opacity-0'); 
        inner.classList.remove('scale-95'); 
    }, 10);
};

window.closeAssignmentModal = function() {
    const modal = document.getElementById('assignmentModal');
    const inner = document.getElementById('assignmentModalInner');
    modal.classList.add('opacity-0'); 
    inner.classList.add('scale-95');
    setTimeout(() => modal.classList.add('hidden'), 300);
};

// ── INITIALIZE ────────────────────────────────────────────────────────────
document.addEventListener('DOMContentLoaded', loadCurrentGrades);
