import { db } from '../../assets/js/firebase-init.js';
import { collection, query, where, getDocs, doc, getDoc } from "https://www.gstatic.com/firebasejs/10.7.1/firebase-firestore.js";
import { requireAuth } from '../../assets/js/auth.js';
import { injectStudentLayout } from '../../assets/js/layout-student.js';

// ── 1. INIT & AUTH ────────────────────────────────────────────────────────
const session = requireAuth('student', '../login.html');

injectStudentLayout('history', 'Academic History', 'Review past semesters and your full academic passport');

document.getElementById('displayStudentName').innerText  = session.studentData.name || 'Student';
document.getElementById('studentAvatar').innerText       = (session.studentData.name || 'S').charAt(0).toUpperCase();
document.getElementById('displayStudentClass').innerText = session.studentData.className
    ? `Class: ${session.studentData.className}` : 'Unassigned Class';

// Elements
const historySemesterSelect    = document.getElementById('historySemesterSelect');
const historySubjectsContainer = document.getElementById('historySubjectsContainer');
const noHistoryGradesMsg       = document.getElementById('noHistoryGradesMsg');
const historyInfoCard          = document.getElementById('historyInfoCard');
const historyTeacherName       = document.getElementById('historyTeacherName');

// State
let teachersMap            = {};
let currentViewGrades      = [];
let schoolActiveSemesterId = null;
let gradeTypeWeights       = {};

// ── 2. UI HELPERS ─────────────────────────────────────────────────────────
function getGradeStyle(p) {
    if (p >= 90) return { cls: 'text-emerald-700 bg-emerald-50 border-emerald-200', ltr: 'A' };
    if (p >= 80) return { cls: 'text-blue-700 bg-blue-50 border-blue-200',         ltr: 'B' };
    if (p >= 70) return { cls: 'text-teal-700 bg-teal-50 border-teal-200',         ltr: 'C' };
    if (p >= 65) return { cls: 'text-amber-700 bg-amber-50 border-amber-200',      ltr: 'D' };
    return             { cls: 'text-red-700 bg-red-50 border-red-200',             ltr: 'F' };
}

function gradeColorText(p) {
    if (p >= 90) return 'text-emerald-600'; if (p >= 80) return 'text-blue-600';
    if (p >= 70) return 'text-teal-600';    if (p >= 65) return 'text-amber-600';
    return 'text-red-600';
}

function isNew(dateStr, createdStr) {
    const d = createdStr ? new Date(createdStr) : new Date(dateStr);
    if (isNaN(d)) return false;
    return Math.ceil(Math.abs(new Date() - d) / (1000 * 60 * 60 * 24)) <= 5;
}

window.toggleAccordion = function(h) {
    const b = h.nextElementSibling;
    b.classList.toggle('open');
    h.querySelector('.fa-chevron-down').style.transform =
        b.classList.contains('open') ? 'rotate(180deg)' : 'rotate(0deg)';
};

// ── 3. ACADEMIC PASSPORT — school transfer timeline ───────────────────────
function renderAcademicPassport(academicHistory) {
    let passportEl = document.getElementById('academicPassportSection');
    if (!passportEl) {
        passportEl = document.createElement('div');
        passportEl.id = 'academicPassportSection';
        const anchor = historySemesterSelect?.closest('div') || historySubjectsContainer;
        anchor?.parentElement?.insertBefore(passportEl, anchor);
    }

    if (!academicHistory || !academicHistory.length) {
        passportEl.innerHTML = '';
        return;
    }

    passportEl.innerHTML = `
        <div style="background:linear-gradient(135deg,#1e1b4b,#312e81);border-radius:16px;padding:24px 28px;margin-bottom:28px;color:#fff;box-shadow:0 10px 25px rgba(30,27,75,0.15)">
            <div style="display:flex;align-items:center;gap:12px;margin-bottom:20px;">
                <div style="width:40px;height:40px;background:rgba(255,255,255,0.15);border-radius:10px;
                            display:flex;align-items:center;justify-content:center;font-size:18px;">🎒</div>
                <div>
                    <h3 style="margin:0;font-size:15px;font-weight:800;letter-spacing:-0.2px;">Academic Passport</h3>
                    <p style="margin:2px 0 0;font-size:11px;color:rgba(255,255,255,0.6);font-weight:500;
                              text-transform:uppercase;letter-spacing:0.08em;">Lifelong School History</p>
                </div>
                <div style="margin-left:auto;background:rgba(255,255,255,0.1);border:1px solid rgba(255,255,255,0.2);
                            border-radius:8px;padding:4px 12px;font-size:11px;font-weight:700;
                            color:rgba(255,255,255,0.75);font-family:monospace;letter-spacing:0.05em;">
                    ${session.studentId}
                </div>
            </div>

            <div style="display:flex;flex-direction:column;gap:0;">
                ${academicHistory.map((h, i) => `
                <div style="display:flex;gap:14px;align-items:flex-start;
                            padding-bottom:${i < academicHistory.length - 1 ? '16px' : '0'};">
                    <div style="display:flex;flex-direction:column;align-items:center;flex-shrink:0;">
                        <div style="width:12px;height:12px;border-radius:50%;background:#a5b4fc;
                                    border:2px solid rgba(255,255,255,0.4);flex-shrink:0;"></div>
                        ${i < academicHistory.length - 1
                            ? '<div style="width:2px;flex:1;min-height:20px;background:rgba(255,255,255,0.15);margin-top:4px;"></div>'
                            : ''}
                    </div>
                    <div style="flex:1;padding-bottom:4px;">
                        <p style="margin:0 0 2px;font-size:13px;font-weight:700;color:#e0e7ff;">
                            ${h.schoolName || h.schoolId || 'Unknown School'}
                        </p>
                        <p style="margin:0;font-size:11px;color:rgba(255,255,255,0.55);font-weight:500;">
                            ${h.className ? `Class: ${h.className}` : ''}
                            ${h.className && h.leftAt ? ' · ' : ''}
                            ${h.leftAt
                                ? `Left: ${new Date(h.leftAt).toLocaleDateString('en-US', { year:'numeric', month:'short', day:'numeric' })}`
                                : ''}
                            ${h.gpa ? ` · GPA: ${h.gpa}` : ''}
                        </p>
                    </div>
                    <div style="flex-shrink:0;">
                        <span style="font-size:10px;font-weight:700;padding:2px 8px;border-radius:6px;
                            background:${h.reason === 'Graduated'
                                ? 'rgba(52,211,153,0.2)'
                                : h.reason === 'Transferred'
                                ? 'rgba(147,197,253,0.2)'
                                : 'rgba(255,255,255,0.1)'};
                            color:${h.reason === 'Graduated'
                                ? '#6ee7b7'
                                : h.reason === 'Transferred'
                                ? '#93c5fd'
                                : 'rgba(255,255,255,0.6)'};
                            border:1px solid ${h.reason === 'Graduated'
                                ? 'rgba(52,211,153,0.3)'
                                : h.reason === 'Transferred'
                                ? 'rgba(147,197,253,0.3)'
                                : 'rgba(255,255,255,0.15)'};">
                            ${h.reason || 'Enrolled'}
                        </span>
                    </div>
                </div>`).join('')}
            </div>
        </div>`;
}

// ── 4. LOAD INITIAL DATA ──────────────────────────────────────────────────
async function initializeHistory() {
    try {
        const schoolSnap = await getDoc(doc(db, 'schools', session.schoolId));
        if (schoolSnap.exists()) {
            document.getElementById('displaySchoolName').innerText = schoolSnap.data().schoolName;
            schoolActiveSemesterId = schoolSnap.data().activeSemesterId;
        }

        const tSnap = await getDocs(query(collection(db, 'teachers'), where('currentSchoolId', '==', session.schoolId)));
        tSnap.forEach(d => { teachersMap[d.id] = d.data().name; });

        const semSnap = await getDocs(collection(db, 'schools', session.schoolId, 'semesters'));
        const allSemesters = semSnap.docs.map(d => ({ id: d.id, ...d.data() })).sort((a, b) => (a.order || 0) - (b.order || 0));

        const activeSemObj = allSemesters.find(s => s.id === schoolActiveSemesterId);
        document.getElementById('activeSemesterDisplay').textContent = activeSemObj ? activeSemObj.name : 'Unknown';

        if (!allSemesters.length) {
            historySemesterSelect.innerHTML = '<option value="">No periods available</option>';
            historySubjectsContainer.innerHTML = '';
            noHistoryGradesMsg.classList.remove('hidden');
            return;
        }

        historySemesterSelect.innerHTML = allSemesters.map(s =>
            `<option value="${s.id}">${s.name}${s.id === schoolActiveSemesterId ? ' (Current)' : ''}</option>`
        ).join('');

        const pastSemesters = allSemesters.filter(s => s.id !== schoolActiveSemesterId);
        historySemesterSelect.value = pastSemesters.length ? pastSemesters[pastSemesters.length - 1].id : schoolActiveSemesterId;

        // Fetch Global Grade Weights for calculations
        try {
            const cached = localStorage.getItem(`connectus_gradeTypes_${session.schoolId}`);
            const types = cached ? JSON.parse(cached) : (await getDocs(collection(db, 'schools', session.schoolId, 'gradeTypes'))).docs.map(d => ({ id: d.id, ...d.data() }));
            types.forEach(t => { if (t.weight) gradeTypeWeights[t.name] = t.weight; });
        } catch(_) {}

        try {
            const globalStudentSnap = await getDoc(doc(db, 'students', session.studentId));
            if (globalStudentSnap.exists()) {
                renderAcademicPassport(globalStudentSnap.data().academicHistory || []);
            }
        } catch (e) {}

        historySemesterSelect.addEventListener('change', loadHistoricalGrades);
        loadHistoricalGrades();

    } catch (e) {
        console.error('Error initializing history:', e);
        historySubjectsContainer.innerHTML = '<p class="text-red-500 text-center font-bold">Failed to load data. Please refresh.</p>';
    }
}

// ── 5. LOAD GRADES FOR SELECTED SEMESTER ──────────────────────────────────
async function loadHistoricalGrades() {
    const semId = historySemesterSelect.value;
    if (!semId) return;

    historySubjectsContainer.innerHTML = '<div class="text-center py-12 text-slate-400"><i class="fa-solid fa-spinner fa-spin text-3xl text-indigo-400"></i></div>';
    noHistoryGradesMsg.classList.add('hidden');
    historyInfoCard.classList.add('hidden');

    try {
        // CHANGED TO GLOBAL PASSPORT PATH: filtered by current school
        const q = query(
            collection(db, 'students', session.studentId, 'grades'),
            where('schoolId', '==', session.schoolId),
            where('semesterId', '==', semId)
        );
        const gSnap = await getDocs(q);
        currentViewGrades = gSnap.docs.map(d => ({ id: d.id, ...d.data() }));

        const tCount = {};
        let topId = null, topN = 0;
        currentViewGrades.forEach(g => {
            if (g.teacherId) {
                tCount[g.teacherId] = (tCount[g.teacherId] || 0) + 1;
                if (tCount[g.teacherId] > topN) { topN = tCount[g.teacherId]; topId = g.teacherId; }
            }
        });

        if (topId && teachersMap[topId]) {
            historyTeacherName.textContent = teachersMap[topId];
            historyInfoCard.classList.remove('hidden');
        }

        renderSubjectAccordions(currentViewGrades);

    } catch (e) {
        console.error('Error fetching historical grades:', e);
        historySubjectsContainer.innerHTML = '<p class="text-red-500 text-center font-bold">Error loading grades.</p>';
    }
}

// Helper: weighted average for a set of grades
function calcWeightedAvg(grades) {
    const hasWeights = Object.keys(gradeTypeWeights).length > 0;
    if (!hasWeights) {
        return grades.reduce((a, g) => a + (g.max ? g.score / g.max * 100 : 0), 0) / grades.length;
    }
    const byType = {};
    grades.forEach(g => {
        const t = g.type || 'Other';
        if (!byType[t]) byType[t] = [];
        byType[t].push(g.max ? (g.score / g.max) * 100 : 0);
    });
    let wSum = 0, wTotal = 0;
    Object.entries(byType).forEach(([type, scores]) => {
        const typeAvg = scores.reduce((a, b) => a + b, 0) / scores.length;
        const w = gradeTypeWeights[type] || 0;
        if (w > 0) { wSum += typeAvg * w; wTotal += w; }
    });
    return wTotal > 0 ? wSum / wTotal : grades.reduce((a, g) => a + (g.max ? g.score / g.max * 100 : 0), 0) / grades.length;
}

// ── 6. RENDER ACCORDIONS ──────────────────────────────────────────────────
function renderSubjectAccordions(grades) {
    if (!grades.length) {
        historySubjectsContainer.innerHTML = '';
        noHistoryGradesMsg.classList.remove('hidden');
        return;
    }

    const bySub = {};
    grades.forEach(g => {
        const s = g.subject || 'Uncategorized';
        if (!bySub[s]) bySub[s] = [];
        bySub[s].push(g);
    });

    historySubjectsContainer.innerHTML = Object.entries(bySub).map(([subject, gList]) => {
        const avg   = calcWeightedAvg(gList);
        const style = getGradeStyle(Math.round(avg));

        const rows = gList
            .sort((a, b) => (b.date || '').localeCompare(a.date || ''))
            .map(g => {
                const pct      = g.max ? Math.round((g.score / g.max) * 100) : null;
                const pColor   = pct !== null ? gradeColorText(pct) : 'text-slate-500';
                const badge    = isNew(g.date, g.createdAt) ? `<span class="new-badge">New</span>` : '';
                const hasNotes = g.notes || (g.historyLogs && g.historyLogs.length > 0);

                return `
                <div class="bg-white border border-slate-200 rounded-xl p-3 sm:p-4 flex items-center justify-between hover:shadow-md transition cursor-pointer mb-2 last:mb-0"
                     onclick="window.viewGradeDetails('${g.id}')">
                    <div class="flex-1 min-w-0">
                        <p class="font-black text-slate-800 text-sm sm:text-base truncate">${g.title} ${badge}</p>
                        <p class="text-xs text-slate-400 font-bold mt-1 uppercase tracking-wider">${g.type} • ${g.date}</p>
                    </div>
                    <div class="flex items-center gap-3 sm:gap-5 flex-shrink-0 ml-2">
                        <div class="text-right">
                            <span class="block text-[10px] uppercase font-bold text-slate-400 tracking-wider">Score</span>
                            <span class="font-black text-sm sm:text-base ${pColor}">${g.score}/${g.max || '?'}</span>
                        </div>
                        <div class="hidden sm:block text-right">
                            <span class="block text-[10px] uppercase font-bold text-slate-400 tracking-wider">Pct</span>
                            <span class="font-black text-sm sm:text-base ${pColor}">${pct !== null ? pct + '%' : '—'}</span>
                        </div>
                        ${hasNotes
                            ? '<i class="fa-solid fa-comment-dots text-indigo-400 text-lg drop-shadow-sm ml-1"></i>'
                            : '<i class="fa-solid fa-chevron-right text-slate-300 ml-1"></i>'}
                    </div>
                </div>`;
            }).join('');

        return `
        <div class="bg-white rounded-3xl shadow-sm border border-slate-200 overflow-hidden transition-shadow hover:shadow-md">
            <div class="p-5 sm:p-6 border-b border-slate-100 flex justify-between items-center cursor-pointer bg-slate-50/50 hover:bg-slate-100/50 transition"
                 onclick="window.toggleAccordion(this)">
                <div class="flex items-center gap-4">
                    <div class="w-12 h-12 bg-gradient-to-br from-indigo-500 to-purple-600 text-white rounded-xl flex items-center justify-center font-black text-lg shadow-sm">
                        ${subject.charAt(0)}
                    </div>
                    <div>
                        <h3 class="text-lg sm:text-xl font-extrabold text-slate-800">${subject}</h3>
                        <p class="text-xs text-slate-500 font-bold mt-1 uppercase tracking-wider">
                            ${gList.length} Assignment${gList.length !== 1 ? 's' : ''}
                        </p>
                    </div>
                </div>
                <div class="flex items-center gap-4">
                    <div class="text-right hidden sm:block">
                        <span class="block text-[10px] uppercase font-bold text-slate-400 tracking-wider mb-1">Average</span>
                        <span class="px-3 py-1.5 rounded-xl font-black text-sm border shadow-sm ${style.cls}">
                            ${Math.round(avg)}% • ${style.ltr}
                        </span>
                    </div>
                    <div class="sm:hidden px-3 py-1 rounded-xl font-black text-sm border shadow-sm ${style.cls}">
                        ${Math.round(avg)}%
                    </div>
                    <i class="fa-solid fa-chevron-down text-slate-400 transition-transform duration-200 text-lg"></i>
                </div>
            </div>
            <div class="subject-body">
                <div class="p-4 sm:p-5 bg-slate-50 border-t border-slate-100 shadow-inner">${rows}</div>
            </div>
        </div>`;
    }).join('');
}

// ── 7. GRADE DETAIL MODAL ─────────────────────────────────────────────────
window.viewGradeDetails = function(gradeId) {
    const g = currentViewGrades.find(x => x.id === gradeId);
    if (!g) return;

    const p = g.max ? Math.round((g.score / g.max) * 100) : 0;
    document.getElementById('modalTitle').innerText = g.title;
    document.getElementById('modalMeta').innerText  = `${g.date} • ${g.subject} • ${g.type}`;
    document.getElementById('modalScore').innerText = `${g.score} / ${g.max}`;

    const pEl = document.getElementById('modalPercentage');
    pEl.innerText = `${p}%`;
    pEl.className = `font-black text-3xl ${gradeColorText(p)}`;

    const notesEl = document.getElementById('modalNotes');
    if (g.notes) {
        notesEl.innerText = g.notes;
        notesEl.className = 'bg-indigo-50 border-l-4 border-indigo-500 p-5 rounded-r-2xl text-sm text-indigo-900 whitespace-pre-wrap leading-relaxed shadow-sm font-bold';
    } else {
        notesEl.innerText = 'No specific notes provided by teacher.';
        notesEl.className = 'bg-slate-50 border-l-4 border-slate-300 p-5 rounded-r-2xl text-sm text-slate-500 italic whitespace-pre-wrap leading-relaxed';
    }

    const histSec = document.getElementById('historySection');
    const histEl  = document.getElementById('modalHistory');
    if (g.historyLogs && g.historyLogs.length > 0) {
        histSec.classList.remove('hidden');
        histEl.innerHTML = g.historyLogs.map(log =>
            `<div class="bg-amber-50/50 border border-amber-200 p-3 text-[11px] text-amber-800 rounded-xl shadow-sm font-bold leading-relaxed">
                <i class="fa-solid fa-clock-rotate-left mr-1"></i>
                ${typeof log === 'object'
                    ? `[${log.changedAt}] Changed from ${log.oldScore} to ${log.newScore}. Reason: ${log.reason}`
                    : log}
            </div>`
        ).join('');
    } else {
        histSec.classList.add('hidden');
    }

    const modal = document.getElementById('assignmentModal');
    const inner = document.getElementById('assignmentModalInner');
    modal.classList.remove('hidden');
    setTimeout(() => { modal.classList.remove('opacity-0'); inner.classList.remove('scale-95'); }, 10);
};

window.closeAssignmentModal = function() {
    const modal = document.getElementById('assignmentModal');
    const inner = document.getElementById('assignmentModalInner');
    modal.classList.add('opacity-0');
    inner.classList.add('scale-95');
    setTimeout(() => modal.classList.add('hidden'), 300);
};

// ── 8. PRINT PROFESSIONAL TRANSCRIPT ──────────────────────────────────────
window.printStudentRecord = async (studentId) => {
    const s = session.studentData;
    
    // Fetch grades specifically for this school (unlocked records)
    let gradesSnap = await getDocs(query(
        collection(db, 'students', studentId, 'grades'),
        where('schoolId', '==', session.schoolId)
    ));
    
    const bySem = {};
    let totalAssessments = 0;
    let sumScore = 0;
    let sumMax = 0;

    gradesSnap.forEach(d => {
        const g = d.data();
        const sem = g.semesterId || 'General';
        const sub = g.subject    || 'Uncategorized';
        if (!bySem[sem]) bySem[sem] = {};
        if (!bySem[sem][sub]) bySem[sem][sub] = [];
        bySem[sem][sub].push(g);
        
        if (g.max) {
            totalAssessments++;
            sumScore += (g.score / g.max) * 100;
        }
    });

    const cumulativeAvg = totalAssessments > 0 ? Math.round(sumScore / totalAssessments) : 0;
    const gpaLetter = totalAssessments > 0 ? getGradeStyle(cumulativeAvg).ltr : 'N/A';

    let gradesHtml = Object.keys(bySem).length === 0
        ? `<p style="text-align:center;color:#64748b;font-style:italic;padding:40px;border:1px dashed #cbd5e1;border-radius:8px;">No academic grades recorded for this institution.</p>`
        : Object.entries(bySem).map(([sem, subjects]) => {
            let rows = '', total = 0, count = 0;
            for (const sub in subjects) {
                const avg = Math.round(calcWeightedAvg(subjects[sub]));
                total += avg; count++;
                rows += `<tr>
                            <td style="border-bottom:1px solid #e2e8f0;padding:12px 15px;color:#1e293b;font-weight:600;">${sub}</td>
                            <td style="border-bottom:1px solid #e2e8f0;padding:12px 15px;text-align:center;color:#64748b;">${subjects[sub].length}</td>
                            <td style="border-bottom:1px solid #e2e8f0;padding:12px 15px;text-align:center;font-weight:bold;color:#0f172a;">${avg}%</td>
                            <td style="border-bottom:1px solid #e2e8f0;padding:12px 15px;text-align:center;font-weight:bold;color:#0f172a;">${getGradeStyle(avg).ltr}</td>
                        </tr>`;
            }
            const termAvg = Math.round(total/count);
            rows += `<tr style="background:#f8fafc;">
                        <td colspan="2" style="border-bottom:2px solid #cbd5e1;padding:12px 15px;text-align:right;font-weight:800;color:#334155;text-transform:uppercase;letter-spacing:1px;">Term Average:</td>
                        <td style="border-bottom:2px solid #cbd5e1;padding:12px 15px;text-align:center;font-weight:900;color:#0f172a;font-size:16px;">${termAvg}%</td>
                        <td style="border-bottom:2px solid #cbd5e1;padding:12px 15px;text-align:center;font-weight:900;color:#0f172a;font-size:16px;">${getGradeStyle(termAvg).ltr}</td>
                    </tr>`;
            return `
            <div style="margin-bottom:40px;page-break-inside:avoid;">
                <h3 style="font-size:14px;font-weight:800;background:#1e1b4b;color:white;padding:10px 15px;border-radius:6px 6px 0 0;margin:0;text-transform:uppercase;letter-spacing:1px;">Term: ${sem}</h3>
                <table style="width:100%;border-collapse:collapse;font-size:13px;border-left:1px solid #e2e8f0;border-right:1px solid #e2e8f0;">
                    <thead>
                        <tr style="background:#f1f5f9;">
                            <th style="border-bottom:2px solid #cbd5e1;padding:10px 15px;text-align:left;color:#475569;font-size:11px;">Subject</th>
                            <th style="border-bottom:2px solid #cbd5e1;padding:10px 15px;text-align:center;color:#475569;font-size:11px;">Assessments</th>
                            <th style="border-bottom:2px solid #cbd5e1;padding:10px 15px;text-align:center;color:#475569;font-size:11px;">Average</th>
                            <th style="border-bottom:2px solid #cbd5e1;padding:10px 15px;text-align:center;color:#475569;font-size:11px;">Grade</th>
                        </tr>
                    </thead>
                    <tbody>${rows}</tbody>
                </table>
            </div>`;
        }).join('');

    const schoolName = document.getElementById('displaySchoolName').innerText || 'ConnectUs School';
    
    const html = `
    <!DOCTYPE html>
    <html>
    <head>
        <title>Academic Transcript — ${s.name}</title>
        <style>
            @import url('https://fonts.googleapis.com/css2?family=Nunito:wght@400;600;700;800;900&display=swap');
            body { font-family: 'Nunito', sans-serif; padding: 40px; color: #0f172a; line-height: 1.5; margin: 0 auto; max-width: 8.5in; }
            .watermark { position: fixed; top: 50%; left: 50%; transform: translate(-50%, -50%) rotate(-45deg); font-size: 100px; color: rgba(203, 213, 225, 0.2); font-weight: 900; white-space: nowrap; pointer-events: none; z-index: -1; }
            .header-flex { display: flex; justify-content: space-between; align-items: flex-end; border-bottom: 3px solid #1e1b4b; padding-bottom: 20px; margin-bottom: 30px; }
            .logo { max-height: 60px; max-width: 200px; object-fit: contain; }
            .header-text { text-align: right; }
            .header-text h1 { margin: 0 0 5px; font-size: 24px; font-weight: 900; text-transform: uppercase; color: #1e1b4b; }
            .header-text h2 { margin: 0; font-size: 14px; color: #64748b; font-weight: 700; letter-spacing: 2px; }
            
            .student-info-box { display: flex; border: 1px solid #cbd5e1; border-radius: 8px; overflow: hidden; margin-bottom: 30px; }
            .info-col { flex: 1; padding: 15px 20px; border-right: 1px solid #cbd5e1; }
            .info-col:last-child { border-right: none; background: #f8fafc; }
            .info-item { margin-bottom: 10px; }
            .info-item:last-child { margin-bottom: 0; }
            .info-label { font-size: 10px; text-transform: uppercase; color: #64748b; font-weight: 800; display: block; margin-bottom: 2px; }
            .info-value { font-size: 15px; font-weight: 800; color: #0f172a; }
            
            .analytics-grid { display: flex; gap: 15px; margin-bottom: 40px; }
            .analytic-card { flex: 1; background: #fff; border: 2px solid #e2e8f0; border-radius: 8px; padding: 15px; text-align: center; }
            .analytic-val { font-size: 28px; font-weight: 900; color: #4338ca; line-height: 1; margin-bottom: 5px; }
            .analytic-lbl { font-size: 11px; font-weight: 800; color: #64748b; text-transform: uppercase; letter-spacing: 1px; }

            .footer { margin-top: 50px; text-align: center; font-size: 11px; color: #94a3b8; border-top: 1px solid #e2e8f0; padding-top: 20px; font-weight: 600; }
        </style>
    </head>
    <body>
        <div class="watermark">UNOFFICIAL TRANSCRIPT</div>
        
        <div class="header-flex">
            <img src="../../assets/images/logo.png" alt="ConnectUs" class="logo" onerror="this.style.display='none'">
            <div class="header-text">
                <h1>${schoolName}</h1>
                <h2>UNOFFICIAL ACADEMIC TRANSCRIPT</h2>
            </div>
        </div>

        <div class="student-info-box">
            <div class="info-col">
                <div class="info-item"><span class="info-label">Student Name</span><span class="info-value">${s.name}</span></div>
                <div class="info-item"><span class="info-label">Global ID Number</span><span class="info-value" style="font-family:monospace;letter-spacing:1px;">${s.studentIdNum || studentId}</span></div>
            </div>
            <div class="info-col">
                <div class="info-item"><span class="info-label">Date of Birth</span><span class="info-value">${s.dob || 'Not on file'}</span></div>
                <div class="info-item"><span class="info-label">Current Enrollment</span><span class="info-value">${s.className || 'Unassigned'}</span></div>
            </div>
        </div>

        <div class="analytics-grid">
            <div class="analytic-card">
                <div class="analytic-val">${cumulativeAvg}%</div>
                <div class="analytic-lbl">Cumulative Average</div>
            </div>
            <div class="analytic-card">
                <div class="analytic-val">${gpaLetter}</div>
                <div class="analytic-lbl">Overall Grade</div>
            </div>
            <div class="analytic-card">
                <div class="analytic-val">${totalAssessments}</div>
                <div class="analytic-lbl">Total Assessments</div>
            </div>
        </div>

        ${gradesHtml}

        <div class="footer">
            <strong>NOTICE:</strong> This document is an unofficial academic report generated via the ConnectUs National Registry for <strong>${schoolName}</strong>.<br>
            To access locked historical records from previous institutions, a formal transcript request must be submitted.<br><br>
            Date Issued: ${new Date().toLocaleDateString('en-US', { year: 'numeric', month: 'long', day: 'numeric' })}
        </div>
    </body>
    </html>`;

    const w = window.open('', '_blank');
    w.document.write(html);
    w.document.close();
    setTimeout(() => w.print(), 800);
};

// ── INITIALIZE ────────────────────────────────────────────────────────────
document.addEventListener('DOMContentLoaded', initializeHistory);
