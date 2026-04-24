import { db } from '../../assets/js/firebase-init.js';
import { doc, getDoc, collection, getDocs, query, orderBy } from "https://www.gstatic.com/firebasejs/10.8.0/firebase-firestore.js";
import { getTeacherRef } from '../../assets/js/utils.js'; // Assuming you put the helper in utils

document.addEventListener('DOMContentLoaded', async () => {
    // 1. Session Check & Subscription Gate
    const sessionStr = localStorage.getItem('connectus_teacher_session');
    if (!sessionStr) {
        window.location.href = '../login.html';
        return;
    }
    const session = JSON.parse(sessionStr);

    // Future-proofing Priority 3: Subscription Gate
    // if (!session.teacherData.subscriptionTier || session.teacherData.subscriptionTier !== 'Pro') {
    //     showUpsellModal(); return;
    // }

    // 2. Load Global Teacher Data
    await loadTeacherProfile(session);
    // 3. Load Evaluations Subcollection
    await loadEvaluations(session);
});

async function loadTeacherProfile(session) {
    const teacherRef = doc(db, 'teachers', session.teacherId);
    const teacherSnap = await getDoc(teacherRef);

    if (teacherSnap.exists()) {
        const data = teacherSnap.data();
        
        // Populate Header & Profile Sidebar
        document.getElementById('teacher-name-display').textContent = `${data.name}'s Career Ledger`;
        document.getElementById('teacher-global-id').textContent = session.teacherId;
        
        if (data.address) {
            document.getElementById('profile-district').textContent = data.address.district || '--';
        }
        
        // Map subjects array to string
        if (data.subjects && data.subjects.length > 0) {
            document.getElementById('profile-subjects').textContent = data.subjects.map(s => s.name).join(', ');
        }

        if (data.createdAt) {
            const date = new Date(data.createdAt);
            document.getElementById('profile-joined').textContent = date.toLocaleDateString('en-BZ', { year: 'numeric', month: 'long' });
        }

        // Build Career Timeline (Current + Archived)
        const timelineContainer = document.getElementById('career-timeline');
        timelineContainer.innerHTML = ''; 

        // Current School (Top of timeline)
        let timelineHTML = `
            <div class="relative pl-6">
                <span class="absolute -left-[5px] top-1.5 h-2.5 w-2.5 rounded-full bg-indigo-500 ring-4 ring-slate-900"></span>
                <p class="text-xs font-semibold text-indigo-400 uppercase tracking-wide">Present Placement</p>
                <p class="text-sm font-medium text-white">${data.currentSchoolId}</p>
            </div>
        `;

        // Archived Schools (Historical)
        if (data.archivedSchoolIds && data.archivedSchoolIds.length > 0) {
            document.getElementById('stat-schools-count').textContent = data.archivedSchoolIds.length + 1;
            
            data.archivedSchoolIds.forEach(school => {
                timelineHTML += `
                    <div class="relative pl-6">
                        <span class="absolute -left-[5px] top-1.5 h-2.5 w-2.5 rounded-full bg-slate-600 ring-4 ring-slate-900"></span>
                        <p class="text-xs font-semibold text-slate-400 uppercase tracking-wide">Past Assignment</p>
                        <p class="text-sm font-medium text-slate-300">${school}</p>
                    </div>
                `;
            });
        } else {
            document.getElementById('stat-schools-count').textContent = '1';
        }

        timelineContainer.innerHTML = timelineHTML;
    }
}

async function loadEvaluations(session) {
    const listContainer = document.getElementById('evaluations-list');
    
    // Query global evaluations subcollection
    const evalRef = collection(db, 'teachers', session.teacherId, 'evaluations');
    const q = query(evalRef, orderBy('timestamp', 'desc'));
    
    try {
        const querySnapshot = await getDocs(q);
        
        if (querySnapshot.empty) {
            listContainer.innerHTML = `<div class="p-8 text-center text-gray-500 italic">No formal evaluations on record yet.</div>`;
            document.getElementById('stat-eval-count').textContent = '0';
            return;
        }

        document.getElementById('stat-eval-count').textContent = querySnapshot.size;
        let html = '';
        let totalScore = 0;
        let scoreCount = 0;

        querySnapshot.forEach((doc) => {
            const ev = doc.data();
            const dateStr = new Date(ev.timestamp).toLocaleDateString('en-BZ', { year: 'numeric', month: 'short', day: 'numeric' });
            
            if (ev.performanceScore) {
                totalScore += ev.performanceScore;
                scoreCount++;
            }

            // Star rating visual generator
            let starsHTML = '';
            for(let i = 1; i <= 5; i++) {
                starsHTML += `<i class="fa-solid fa-star text-sm ${i <= ev.performanceScore ? 'text-yellow-400' : 'text-gray-200'}"></i>`;
            }

            html += `
                <div class="p-6 hover:bg-gray-50 transition-colors">
                    <div class="flex justify-between items-start">
                        <div>
                            <span class="inline-flex items-center px-2.5 py-0.5 rounded-md text-xs font-medium bg-blue-50 text-blue-700 mb-2">
                                ${ev.type || 'Review'}
                            </span>
                            <h4 class="text-md font-semibold text-gray-900">School ID: ${ev.schoolId}</h4>
                            <p class="text-sm text-gray-500 mt-1">Evaluator ID: ${ev.evaluatorId} • ${dateStr}</p>
                        </div>
                        <div class="text-right">
                            <div class="flex space-x-1 mb-1">${starsHTML}</div>
                            <span class="text-xs font-bold text-gray-400 uppercase tracking-wide">Score: ${ev.performanceScore}/5</span>
                        </div>
                    </div>
                    <div class="mt-4 bg-white border border-gray-100 rounded-lg p-4 text-sm text-gray-700 shadow-inner">
                        <i class="fa-solid fa-quote-left text-gray-300 mr-2"></i>
                        ${ev.comments || 'No official comments provided.'}
                    </div>
                </div>
            `;
        });

        listContainer.innerHTML = html;

        // Calculate and display average score
        if (scoreCount > 0) {
            const avg = (totalScore / scoreCount).toFixed(1);
            document.getElementById('stat-avg-score').textContent = `${avg}/5`;
        }

    } catch (error) {
        console.error("Error loading evaluations:", error);
        listContainer.innerHTML = `<div class="p-8 text-center text-red-500">Error loading records. Please check database permissions.</div>`;
    }
}
