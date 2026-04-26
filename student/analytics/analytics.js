import { db } from '../../assets/js/firebase-init.js';
import { collection, getDocs, doc, getDoc } from "https://www.gstatic.com/firebasejs/10.7.1/firebase-firestore.js";
import { requireAuth } from '../../assets/js/auth.js';
import { injectStudentLayout } from '../../assets/js/layout-student.js';

// ── 1. INIT & AUTH ────────────────────────────────────────────────────────
const session = requireAuth('student', '../login.html');

injectStudentLayout('analytics', 'My Evaluations', 'Behavioral and academic performance reviews');

document.getElementById('displayStudentName').innerText  = session.studentData.name || 'Student';
document.getElementById('studentAvatar').innerText       = (session.studentData.name || 'S').charAt(0).toUpperCase();
document.getElementById('displayStudentClass').innerText = session.studentData.className ? `Class: ${session.studentData.className}` : 'Unassigned Class';

const loader = document.getElementById('evalsLoader');
const container = document.getElementById('evaluationsContainer');
const emptyMsg = document.getElementById('noEvalsMsg');

// ── 2. ESCAPE HTML HELPER ─────────────────────────────────────────────────
function escHtml(str) {
    if (!str) return '';
    return String(str).replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/"/g,'&quot;');
}

// ── 3. FETCH AND RENDER ───────────────────────────────────────────────────
async function loadEvaluations() {
    try {
        // Fetch active school name for topbar
        const schoolSnap = await getDoc(doc(db, 'schools', session.schoolId));
        if (schoolSnap.exists()) {
            document.getElementById('displaySchoolName').innerText = schoolSnap.data().schoolName;
            const semSnap = await getDoc(doc(db, 'schools', session.schoolId, 'semesters', schoolSnap.data().activeSemesterId));
            if (semSnap.exists()) {
                document.getElementById('activeSemesterDisplay').textContent = semSnap.data().name;
            }
        }

        // Fetch ALL evaluations from the student's global passport
        const snap = await getDocs(collection(db, 'students', session.studentId, 'evaluations'));
        
        if (snap.empty) {
            loader.classList.add('hidden');
            emptyMsg.classList.remove('hidden');
            return;
        }

        const evals = snap.docs.map(d => ({ id: d.id, ...d.data() })).sort((a, b) => new Date(b.date || b.createdAt) - new Date(a.date || a.createdAt));

        let unlockedCount = 0;
        let totalScore = 0;

        const html = evals.map(e => {
            const isLocked = e.schoolId !== session.schoolId;
            if (!isLocked) {
                unlockedCount++;
                totalScore += (e.overallRating || 0);
            }

            const dateStr = e.date ? new Date(e.date).toLocaleDateString('en-US', { month: 'long', day: 'numeric', year: 'numeric' }) : 'Unknown Date';
            const stars = [1,2,3,4,5].map(n => `<i class="fa-solid fa-star ${n <= Math.round(e.overallRating || 0) ? 'text-amber-500' : 'text-slate-200'} text-sm"></i>`).join('');
            const rc = e.recommendedAction === 'Commendation' ? 'text-emerald-700 bg-emerald-50 border-emerald-200' : 
                       e.recommendedAction === 'Formal Warning' ? 'text-red-700 bg-red-50 border-red-200' : 'text-indigo-700 bg-indigo-50 border-indigo-200';

            // ── UNLOCKED UI (Current School) ──
            if (!isLocked) {
                return `
                <div class="bg-white border border-slate-200 rounded-3xl p-6 shadow-sm">
                    <div class="flex justify-between items-start mb-4 pb-4 border-b border-slate-100">
                        <div>
                            <div class="flex items-center gap-2 mb-1">${stars} <span class="font-black text-slate-800 ml-2">${e.overallRating}/5</span></div>
                            <p class="text-xs font-bold text-slate-400 uppercase tracking-widest">${dateStr} • Evaluated by ${escHtml(e.evaluatorName || 'Teacher')}</p>
                        </div>
                        ${e.recommendedAction && e.recommendedAction !== 'None' ? `<span class="px-3 py-1 rounded-full text-[10px] font-black uppercase tracking-wider border ${rc}">${escHtml(e.recommendedAction)}</span>` : ''}
                    </div>
                    
                    <div class="grid grid-cols-1 md:grid-cols-2 gap-6">
                        ${e.strengths ? `
                        <div class="bg-emerald-50/50 border border-emerald-100 rounded-2xl p-4">
                            <p class="text-[10px] font-black text-emerald-600 uppercase tracking-widest mb-2"><i class="fa-solid fa-arrow-trend-up mr-1"></i> Strengths</p>
                            <p class="text-sm font-semibold text-slate-700 leading-relaxed">${escHtml(e.strengths)}</p>
                        </div>` : ''}
                        
                        ${e.areasForImprovement ? `
                        <div class="bg-amber-50/50 border border-amber-100 rounded-2xl p-4">
                            <p class="text-[10px] font-black text-amber-600 uppercase tracking-widest mb-2"><i class="fa-solid fa-bullseye mr-1"></i> Areas for Improvement</p>
                            <p class="text-sm font-semibold text-slate-700 leading-relaxed">${escHtml(e.areasForImprovement)}</p>
                        </div>` : ''}
                    </div>
                </div>`;
            }

            // ── LOCKED UI (Historical Vault) ──
            return `
            <div class="relative bg-white border border-slate-200 rounded-3xl overflow-hidden shadow-sm">
                <div class="p-6 filter blur-md opacity-40 select-none pointer-events-none grayscale">
                    <div class="flex justify-between items-start mb-4 pb-4 border-b border-slate-100">
                        <div>
                            <div class="flex items-center gap-2 mb-1"><i class="fa-solid fa-star text-slate-300"></i><i class="fa-solid fa-star text-slate-300"></i><i class="fa-solid fa-star text-slate-300"></i></div>
                            <p class="text-xs font-bold text-slate-400 uppercase tracking-widest">October 15, 2024 • Evaluated by Previous Teacher</p>
                        </div>
                    </div>
                    <div class="h-20 bg-slate-100 rounded-2xl w-full"></div>
                </div>
                
                <div class="absolute inset-0 z-10 flex flex-col items-center justify-center bg-slate-900/5 backdrop-blur-[2px]">
                    <div class="bg-white p-5 rounded-2xl shadow-xl border border-slate-200 text-center max-w-sm mx-4 transform transition hover:scale-105">
                        <div class="h-12 w-12 bg-indigo-50 text-indigo-500 rounded-full flex items-center justify-center text-xl mx-auto mb-3">
                            <i class="fa-solid fa-lock"></i>
                        </div>
                        <h4 class="font-black text-slate-800 text-base mb-1">Historical Record Locked</h4>
                        <p class="text-xs font-semibold text-slate-500 mb-4">This evaluation belongs to a previous academic period at a different school.</p>
                        <button onclick="window.requestUnlock('${e.id}')" class="w-full bg-slate-900 text-white font-bold py-2.5 rounded-xl hover:bg-indigo-600 transition shadow-md text-xs uppercase tracking-widest">
                            Request Official Unlock
                        </button>
                    </div>
                </div>
            </div>`;
        }).join('');

        // Update top KPIs
        document.getElementById('statTotalEvals').textContent = evals.length;
        document.getElementById('statUnlocked').textContent = unlockedCount;
        document.getElementById('statAvgRating').textContent = unlockedCount > 0 ? (totalScore / unlockedCount).toFixed(1) : '—';

        loader.classList.add('hidden');
        container.innerHTML = html;

    } catch (e) {
        console.error("Error fetching evaluations:", e);
        loader.innerHTML = '<p class="text-red-500 font-bold">Failed to load evaluations.</p>';
    }
}

window.requestUnlock = function(evalId) {
    alert("Unlock feature initiated! This will route to the ConnectUs payment/request gateway in future updates.");
    // Logic for integrating Stripe or email request to ConnectUs goes here.
};

document.addEventListener('DOMContentLoaded', loadEvaluations);
