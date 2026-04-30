import { db } from '../../assets/js/firebase-init.js';
import { collection, doc, getDoc, getDocs, updateDoc, query, where } from "https://www.gstatic.com/firebasejs/10.7.1/firebase-firestore.js";
import { requireAuth } from '../../assets/js/auth.js';
import { injectAdminLayout } from '../../assets/js/layout-admin.js';
import { openOverlay, closeOverlay, letterGrade, calculateWeightedAverage } from '../../assets/js/utils.js';

// ── 1. INIT & AUTH ────────────────────────────────────────────────────────
const session = requireAuth('admin', '../login.html');
injectAdminLayout('students', 'School Directory', 'All enrolled students and their academic records', true, false);

// ── 2. STATE ──────────────────────────────────────────────────────────────
let allStudentsCache = [];
let allTeachersCache = [];
let rawSemesters = [];
let currentStudentId = null;
let currentStudentGradesCache = [];
let currentTeacherWeights = ['Test', 'Quiz', 'Assignment', 'Midterm Exam', 'Final Exam']; // Fallback

const CLASSES = {
    'Primary': ['Infant 1', 'Infant 2', 'Standard 1', 'Standard 2', 'Standard 3', 'Standard 4', 'Standard 5', 'Standard 6'],
    'High School': ['First Form', 'Second Form', 'Third Form', 'Fourth Form'],
    'Junior College': ['Year 1', 'Year 2']
};

const tbody = document.getElementById('studentsTableBody');
const filterClassSelect = document.getElementById('filterStudentClass');
const filterTeacherSelect = document.getElementById('filterStudentTeacher');
const searchInput = document.getElementById('searchInput');

// ── 3. LOAD DATA ──────────────────────────────────────────────────────────
async function loadData() {
    // 1. Fetch Semesters for the Academic Tab & Print filters
    try {
        const semSnap = await getDocs(collection(db, 'schools', session.schoolId, 'semesters'));
        rawSemesters = semSnap.docs.map(d => ({id: d.id, ...d.data()})).sort((a,b) => (a.order||0)-(b.order||0));
    } catch(e) {
        console.error("Error loading semesters:", e);
    }

    // 2. Fetch Directory
    if (!tbody) return;
    tbody.innerHTML = `<tr><td colspan="5" class="px-6 py-16 text-center text-slate-400 font-semibold"><i class="fa-solid fa-spinner fa-spin text-blue-500 text-2xl mb-3 block"></i>Loading directory...</td></tr>`;
    
    try {
        const [sSnap, tSnap] = await Promise.all([
            getDocs(query(collection(db, 'students'), where('currentSchoolId', '==', session.schoolId))),
            getDocs(query(collection(db, 'teachers'), where('currentSchoolId', '==', session.schoolId)))
        ]);
        
        const tm = {};
        allTeachersCache = [];
        tSnap.forEach(d => {
            tm[d.id] = d.data().name;
            if (!d.data().archived) allTeachersCache.push({ id: d.id, ...d.data() });
        });
        
        allStudentsCache = sSnap.docs
            .filter(d => !d.data().archived)
            .map(d => ({ id: d.id, ...d.data(), teacherName: tm[d.data().teacherId] || '—' }));
        
        if (filterTeacherSelect && filterTeacherSelect.options.length <= 1) {
            filterTeacherSelect.innerHTML = '<option value="">All Teachers</option>' + 
                allTeachersCache.map(t => `<option value="${t.id}">${t.name}</option>`).join('');
        }
        
        if (filterClassSelect && filterClassSelect.options.length <= 2) {
            const classList = CLASSES[session.schoolType || 'Primary'] || CLASSES['Primary'];
            filterClassSelect.innerHTML = '<option value="">All Classes</option><option value="unassigned">Unassigned Only</option>' + 
                classList.map(c => `<option value="${c}">${c}</option>`).join('');
        }

        renderTable();

        // ── CATCH URL PARAMETER FROM CLASSES PAGE ──
        const urlParams = new URLSearchParams(window.location.search);
        const viewStudentId = urlParams.get('viewStudent');
        if (viewStudentId) {
            // Small timeout ensures the DOM is fully rendered before opening the panel
            setTimeout(() => window.openStudentPanel(viewStudentId), 200);
            // Clean up the URL so it doesn't re-open if the admin refreshes the page
            window.history.replaceState({}, document.title, window.location.pathname);
        }

    } catch (e) {
        console.error("Error loading students:", e);
        if (tbody) tbody.innerHTML = `<tr><td colspan="5" class="px-6 py-16 text-center text-red-500 font-semibold">Failed to load directory data.</td></tr>`;
    }
}

// ── 4. RENDER TABLE ───────────────────────────────────────────────────────
function renderTable() {
    if (!tbody) return;

    let filtered = allStudentsCache;
    const filterT = filterTeacherSelect?.value || '';
    const filterC = filterClassSelect?.value || '';
    const term = searchInput?.value.toLowerCase() || '';

    if (filterT) filtered = filtered.filter(s => s.teacherId === filterT);
    if (filterC === 'unassigned') filtered = filtered.filter(s => !s.className || !s.teacherId);
    else if (filterC) filtered = filtered.filter(s => s.className === filterC);

    if (!filtered.length) {
        tbody.innerHTML = `<tr><td colspan="5" class="px-6 py-16 text-center text-slate-400 italic font-semibold">No students match the criteria.</td></tr>`;
        return;
    }

    tbody.innerHTML = filtered.map(s => {
        const classBadge = s.className ? s.className : '<span class="bg-amber-100 text-amber-700 text-[10px] font-black px-2 py-0.5 rounded-md uppercase">Unassigned</span>';
        const displayStyle = (s.name || '').toLowerCase().includes(term) || s.id.toLowerCase().includes(term) ? '' : 'display:none;';

        return `
        <tr class="trow border-b border-slate-100 hover:bg-slate-50 transition" style="${displayStyle}">
            <td class="px-6 py-4">
                <div class="flex items-center gap-3">
                    <div class="h-10 w-10 bg-gradient-to-br from-blue-500 to-indigo-600 text-white rounded-xl flex items-center justify-center font-black text-sm shadow-sm flex-shrink-0">${(s.name||'?').charAt(0).toUpperCase()}</div>
                    <div>
                        <span class="font-black text-slate-700 block">${s.name||'Unnamed'}</span>
                        <span class="font-mono text-[10px] text-slate-400">${s.id}</span>
                    </div>
                </div>
            </td>
            <td class="px-6 py-4 text-slate-600 font-semibold">${classBadge}</td>
            <td class="px-6 py-4 text-slate-600 font-semibold">${s.teacherName}</td>
            <td class="px-6 py-4 text-slate-600 font-semibold">${s.parentPhone||'—'}</td>
            <td class="px-6 py-4 text-right">
                <button onclick="window.openStudentPanel('${s.id}')" class="bg-white hover:bg-blue-50 text-blue-600 font-bold px-4 py-2 rounded-lg text-xs transition border border-slate-200 hover:border-blue-200">
                    View Profile
                </button>
            </td>
        </tr>`;
    }).join('');
}

filterClassSelect?.addEventListener('change', renderTable);
filterTeacherSelect?.addEventListener('change', renderTable);
searchInput?.addEventListener('input', renderTable);

// ── 5. STUDENT PANEL & TABS ───────────────────────────────────────────────
window.switchStudentTab = function(tabId) {
    document.querySelectorAll('.tab-pane').forEach(p => p.classList.add('hidden'));
    document.getElementById(`tab-${tabId}`)?.classList.remove('hidden');
    
    document.querySelectorAll('.panel-tab').forEach(btn => {
        if (btn.dataset.tab === tabId) btn.classList.add('active');
        else btn.classList.remove('active');
    });
};

window.toggleSEnrollDropdown = function() {
    document.getElementById('sEnrollDropdown')?.classList.toggle('hidden');
};

window.openStudentPanel = async function(studentId) {
    currentStudentId = studentId; 
    const student = allStudentsCache.find(s => s.id === studentId);
    
    document.getElementById('sPanelName').textContent = student?.name || 'Student';
    document.getElementById('sPanelId').textContent = student?.id || '—';
    document.getElementById('sEnrollDropdown')?.classList.add('hidden'); // Reset dropdown

    // Populate Overview Grid
    const infoGrid = document.getElementById('sInfoGrid');
    if (infoGrid) {
        infoGrid.innerHTML = [
            ['Name', student?.name || '—'],
            ['Date of Birth', student?.dob || '—'],
            ['Current Class', student?.className || 'Unassigned'],
            ['Assigned Teacher', student?.teacherName || 'Unassigned'],
            ['Parent/Guardian', student?.parentName || '—'],
            ['Parent Phone', student?.parentPhone || '—'],
            ['Parent Email', student?.email || '—'],
            ['Enrolled At', student?.createdAt ? new Date(student.createdAt).toLocaleDateString() : '—']
        ].map(([label, value]) => `
            <div class="flex justify-between items-center py-2 border-b border-slate-100 last:border-0">
                <span class="text-xs font-bold text-slate-400 uppercase tracking-wider">${label}</span>
                <span class="text-sm font-semibold text-slate-700">${value}</span>
            </div>
        `).join('');
    }

    window.switchStudentTab('overview');
    document.getElementById('sPanelLoader')?.classList.remove('hidden');
    openOverlay('studentPanel', 'studentPanelInner', true);
    
    try {
        // 1. Fetch Teacher's Custom Grade Weights (CRITICAL FOR ACCURATE ADMIN MATH)
        if (student.teacherId) {
            const tDoc = await getDoc(doc(db, 'teachers', student.teacherId));
            if (tDoc.exists() && tDoc.data().gradeTypes) {
                currentTeacherWeights = tDoc.data().gradeTypes;
            }
        }

        // 2. Fetch Grades from global passport
        const gradesSnap = await getDocs(query(collection(db, 'students', studentId, 'grades'), where('schoolId', '==', session.schoolId)));
        currentStudentGradesCache = [];
        gradesSnap.forEach(d => currentStudentGradesCache.push({ id: d.id, ...d.data() }));
        
        // 3. Populate Semester Dropdown
        const semSelect = document.getElementById('sPanelSemester');
        let activeId = '';
        const schoolDoc = await getDoc(doc(db, 'schools', session.schoolId));
        if (schoolDoc.exists()) activeId = schoolDoc.data().activeSemesterId || '';

        semSelect.innerHTML = rawSemesters.map(s => `<option value="${s.id}" ${s.id === activeId ? 'selected' : ''}>${s.name}</option>`).join('');
        if (rawSemesters.length === 0) semSelect.innerHTML = '<option value="">No Terms Found</option>';

        window.renderAdminGrades(); // Initial render based on active term
    } catch(e) {
        console.error(e);
    } finally {
        document.getElementById('sPanelLoader')?.classList.add('hidden');
    }
};

window.closeStudentPanel = function() { closeOverlay('studentPanel', 'studentPanelInner', true); };

// ── 6. RENDER ADMIN GRADES (ACADEMIC TAB) ─────────────────────────────────
window.renderAdminGrades = function() {
    const container = document.getElementById('subjectAccordions');
    if (!container) return;

    const termId = document.getElementById('sPanelSemester').value;
    const filterSubj = document.getElementById('sPanelFilterSubject').value;
    const filterType = document.getElementById('sPanelFilterType').value;

    // Filter grades for the selected term
    let filteredGrades = currentStudentGradesCache.filter(g => g.semesterId === termId);

    // Populate the Subject and Type dropdown filters dynamically based on this term's grades
    const subjSet = [...new Set(filteredGrades.map(g => g.subject || 'Uncategorized'))].sort();
    const typeSet = [...new Set(filteredGrades.map(g => g.type || 'Uncategorized'))].sort();

    // Preserve current selections if they exist
    document.getElementById('sPanelFilterSubject').innerHTML = '<option value="">All Subjects</option>' + subjSet.map(s => `<option value="${s}" ${s === filterSubj ? 'selected' : ''}>${s}</option>`).join('');
    document.getElementById('sPanelFilterType').innerHTML = '<option value="">All Types</option>' + typeSet.map(t => `<option value="${t}" ${t === filterType ? 'selected' : ''}>${t}</option>`).join('');

    // Apply specific Subj/Type filters
    if (filterSubj) filteredGrades = filteredGrades.filter(g => g.subject === filterSubj);
    if (filterType) filteredGrades = filteredGrades.filter(g => g.type === filterType);

    if (filteredGrades.length === 0) {
        container.innerHTML = `<div class="text-center py-16 bg-white rounded-xl border border-slate-200"><i class="fa-solid fa-folder-open text-4xl text-slate-300 mb-3"></i><p class="text-slate-400 font-semibold">No grades recorded for these filters.</p></div>`;
        return;
    }
    
    const bySubj = {};
    filteredGrades.forEach(g => {
        const subj = g.subject || 'Uncategorized';
        if (!bySubj[subj]) bySubj[subj] = [];
        bySubj[subj].push(g);
    });
    
    container.innerHTML = Object.entries(bySubj).map(([subject, grades]) => {
        // Teacher-Weighted Average
        const avg = calculateWeightedAverage(grades, currentTeacherWeights);
        const avgR = Math.round(avg);
        const ac = avgR >= 75 ? 'text-green-700 bg-green-50 border-green-200' : avgR >= 60 ? 'text-amber-700 bg-amber-50 border-amber-200' : 'text-red-700 bg-red-50 border-red-200';
        
        const rows = grades.sort((a,b) => (b.date||'').localeCompare(a.date||'')).map(g => {
            const pct = g.max ? Math.round((g.score / g.max) * 100) : null;
            const c = pct == null ? 'text-slate-600' : pct >= 75 ? 'text-green-600' : pct >= 60 ? 'text-amber-600' : 'text-red-600';
            
            return `<div class="border border-slate-200 rounded-lg bg-white p-3 flex items-center justify-between">
                <div>
                    <p class="font-bold text-slate-700 text-sm">${g.title||'Assessment'}</p>
                    <p class="text-xs text-slate-400 font-semibold mt-0.5">${g.type||''} · ${g.date||'No Date'}</p>
                </div>
                <div class="flex items-center gap-3">
                    <span class="font-mono text-sm font-bold text-slate-500">${g.score}/${g.max||'?'}</span>
                    <span class="${c} font-black text-sm bg-slate-50 px-2 py-1 rounded border border-slate-100">${pct!=null?pct+'%':'-'}</span>
                </div>
            </div>`;
        }).join('');
        
        return `<div class="rounded-xl border border-slate-200 overflow-hidden bg-white shadow-sm">
            <div class="flex items-center justify-between px-5 py-4 bg-slate-50 border-b border-slate-200 cursor-pointer" onclick="window.toggleSubjectAccordion(this)">
                <div class="flex items-center gap-3">
                    <div class="w-8 h-8 bg-slate-800 text-white rounded flex items-center justify-center font-black text-xs">${subject.charAt(0)}</div>
                    <div>
                        <p class="font-black text-slate-800 text-sm">${subject}</p>
                        <p class="text-[10px] text-slate-500 font-bold uppercase tracking-widest">${grades.length} entries</p>
                    </div>
                </div>
                <div class="flex items-center gap-3">
                    <span class="${ac} border font-black text-xs px-2 py-1 rounded">${avgR}% Avg</span>
                    <i class="fa-solid fa-chevron-down text-slate-400" style="transition:transform 0.2s"></i>
                </div>
            </div>
            <div class="subject-body open p-3 bg-slate-100 space-y-2 border-t border-slate-200">${rows}</div>
        </div>`;
    }).join('');
};

window.toggleSubjectAccordion = function(header) {
    const body = header.nextElementSibling;
    body.classList.toggle('open');
    const chevron = header.querySelector('.fa-chevron-down');
    if (chevron) chevron.style.transform = body.classList.contains('open') ? 'rotate(180deg)' : 'rotate(0deg)';
};

// ── 7. PROFESSIONAL PRINT RECORDS ─────────────────────────────────────────
window.openPrintStudentModal = function() {
    const termId = document.getElementById('sPanelSemester')?.value;
    const termGrades = currentStudentGradesCache.filter(g => g.semesterId === termId);
    const subjSet = [...new Set(termGrades.map(g => g.subject || 'Uncategorized'))].sort();
    
    const psSubj = document.getElementById('psSubject');
    psSubj.innerHTML = '<option value="all">All Subjects</option>' + 
        subjSet.map(s => `<option value="${s.replace(/"/g, '&quot;')}">${s}</option>`).join('');

    openOverlay('printStudentModal', 'printStudentModalInner');
};

window.closePrintStudentModal = function() { closeOverlay('printStudentModal', 'printStudentModalInner'); };

window.executeStudentPrint = function() {
    const mode = document.getElementById('psMode').value;
    const subjFilter = document.getElementById('psSubject').value;
    const termId = document.getElementById('sPanelSemester')?.value;
    const semSelect = document.getElementById('sPanelSemester');
    const semName = semSelect?.options[semSelect.selectedIndex]?.text || 'Active Term';
    
    const student = allStudentsCache.find(s => s.id === currentStudentId);
    if (!student) return;

    let gradesToPrint = currentStudentGradesCache.filter(g => g.semesterId === termId);
    if (subjFilter !== 'all') {
        gradesToPrint = gradesToPrint.filter(g => g.subject === subjFilter);
    }

    const bySub = {};
    let totalAssessments = 0;
    
    gradesToPrint.forEach(g => {
        const sub = g.subject || 'Uncategorized';
        if (!bySub[sub]) bySub[sub] = [];
        bySub[sub].push(g);
        if (g.max) totalAssessments++;
    });

    const cumulativeAvg = gradesToPrint.length ? calculateWeightedAverage(gradesToPrint, currentTeacherWeights) : 0;
    const gpaLetter = totalAssessments > 0 ? letterGrade(cumulativeAvg) : 'N/A';
    const schoolName = session.schoolName || 'ConnectUs School';

    const escapeHtml = (str) => {
        if (!str) return '';
        return String(str).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
    };

    let gradesHtml = Object.keys(bySub).length === 0
        ? `<tr><td colspan="4" style="text-align:center;color:#64748b;font-style:italic;padding:40px;">No grades recorded for this filter.</td></tr>`
        : Object.entries(bySub).sort((a,b) => a[0].localeCompare(b[0])).map(([sub, gList]) => {
            const subAvg = calculateWeightedAverage(gList, currentTeacherWeights);
            let html = `
                <tr style="background:#f8fafc; font-weight:800;">
                    <td style="border-bottom:1px solid #cbd5e1;padding:12px 15px;color:#1e293b;">${escapeHtml(sub)}</td>
                    <td style="border-bottom:1px solid #cbd5e1;padding:12px 15px;text-align:center;color:#64748b;">${gList.length}</td>
                    <td style="border-bottom:1px solid #cbd5e1;padding:12px 15px;text-align:center;color:#0f172a;">${subAvg}%</td>
                    <td style="border-bottom:1px solid #cbd5e1;padding:12px 15px;text-align:center;color:#0f172a;">${letterGrade(subAvg)}</td>
                </tr>
            `;

            if (mode === 'detailed') {
                gList.sort((a,b) => (b.date||'').localeCompare(a.date||'')).forEach(g => {
                    const pct = g.max ? Math.round((g.score/g.max)*100) : null;
                    html += `
                    <tr style="font-size:11px; background:#fff;">
                        <td style="border-bottom:1px solid #f1f5f9;padding:8px 15px 8px 30px;color:#475569;">
                            ${escapeHtml(g.title)} <span style="color:#94a3b8;margin-left:6px;">${escapeHtml(g.type)} · ${g.date}</span>
                        </td>
                        <td style="border-bottom:1px solid #f1f5f9;padding:8px 15px;text-align:center;color:#64748b;font-family:monospace;">${g.score}/${g.max||'?'}</td>
                        <td style="border-bottom:1px solid #f1f5f9;padding:8px 15px;text-align:center;color:#475569;font-family:monospace;">${pct!==null?pct+'%':'-'}</td>
                        <td style="border-bottom:1px solid #f1f5f9;padding:8px 15px;text-align:center;color:#475569;">${pct!==null?letterGrade(pct):'-'}</td>
                    </tr>`;
                });
            }
            return html;
        }).join('');

    const html = `
    <!DOCTYPE html>
    <html>
    <head>
        <title>Official Term Report — ${escapeHtml(student.name)}</title>
        <style>
            @import url('https://fonts.googleapis.com/css2?family=Nunito:wght@400;600;700;800;900&display=swap');
            body { font-family: 'Nunito', sans-serif; padding: 40px; color: #0f172a; line-height: 1.5; margin: 0 auto; max-width: 8.5in; }
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
            
            .analytics-grid { display: flex; gap: 15px; margin-bottom: 30px; }
            .analytic-card { flex: 1; background: #fff; border: 2px solid #e2e8f0; border-radius: 8px; padding: 15px; text-align: center; }
            .analytic-val { font-size: 28px; font-weight: 900; color: #1e1b4b; line-height: 1; margin-bottom: 5px; }
            .analytic-lbl { font-size: 11px; font-weight: 800; color: #64748b; text-transform: uppercase; letter-spacing: 1px; }

            table { width: 100%; border-collapse: collapse; font-size: 13px; border: 1px solid #e2e8f0; }
            th { background: #1e1b4b; color: #fff; padding: 10px 15px; text-align: left; font-size: 11px; text-transform: uppercase; letter-spacing: 1px; }
            th.center { text-align: center; }

            .footer { margin-top: 50px; text-align: center; font-size: 11px; color: #94a3b8; border-top: 1px solid #e2e8f0; padding-top: 20px; font-weight: 600; }
        </style>
    </head>
    <body>
        <div class="header-flex">
            <img src="${session.logo || ''}" alt="${escapeHtml(schoolName)}" class="logo" onerror="this.style.display='none'">
            <div class="header-text">
                <h1>${escapeHtml(schoolName)}</h1>
                <h2>OFFICIAL TERM REPORT</h2>
            </div>
        </div>

        <div class="student-info-box">
            <div class="info-col">
                <div class="info-item"><span class="info-label">Student Name</span><span class="info-value">${escapeHtml(student.name)}</span></div>
                <div class="info-item"><span class="info-label">Global ID Number</span><span class="info-value" style="font-family:monospace;letter-spacing:1px;">${student.id}</span></div>
            </div>
            <div class="info-col">
                <div class="info-item"><span class="info-label">Academic Term</span><span class="info-value">${escapeHtml(semName)}</span></div>
                <div class="info-item"><span class="info-label">Current Enrollment</span><span class="info-value">${escapeHtml(student.className || 'Unassigned')}</span></div>
            </div>
        </div>

        <div class="analytics-grid">
            <div class="analytic-card">
                <div class="analytic-val">${cumulativeAvg}%</div>
                <div class="analytic-lbl">Term Average</div>
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

        <table>
            <thead>
                <tr>
                    <th>Subject / Assignment</th>
                    <th class="center">Assessments / Score</th>
                    <th class="center">Average / Pct</th>
                    <th class="center">Grade</th>
                </tr>
            </thead>
            <tbody>${gradesHtml}</tbody>
        </table>

        <div class="footer" style="display:flex; flex-direction:column; justify-content:center; align-items:center; gap:8px;">
            <span><strong>NOTICE:</strong> This document is an official academic report generated for <strong>${escapeHtml(schoolName)}</strong>.</span>
            <span>Date Issued: ${new Date().toLocaleDateString('en-US', { year: 'numeric', month: 'long', day: 'numeric' })}</span>
            <div style="display:flex; justify-content:center; align-items:center; gap:8px; margin-top:10px;">
                <span>Record generated by Admin</span>
            </div>
        </div>
    </body>
    </html>`;

    const w = window.open('', '_blank');
    w.document.write(html);
    w.document.close();
    
    window.closePrintStudentModal();
    setTimeout(() => w.print(), 800);
};

// ── 8. ARCHIVE & REASSIGN ─────────────────────────────────────────────────
window.openReassignModal = function() {
    document.getElementById('sEnrollDropdown')?.classList.add('hidden');
    const s = allStudentsCache.find(x => x.id === currentStudentId);
    if (!s) return;

    const cSelect = document.getElementById('rsClass');
    if (cSelect) {
        const classList = CLASSES[session.schoolType || 'Primary'] || CLASSES['Primary'];
        cSelect.innerHTML = '<option value="">-- Unassigned --</option>' + 
            classList.map(c => `<option value="${c}" ${s.className===c?'selected':''}>${c}</option>`).join('');
    }

    const tSelect = document.getElementById('rsTeacher');
    if (tSelect) {
        tSelect.innerHTML = '<option value="">-- Unassigned --</option>' + 
            allTeachersCache.map(t => `<option value="${t.id}" ${s.teacherId===t.id?'selected':''}>${t.name}</option>`).join('');
    }

    openOverlay('reassignStudentModal', 'reassignStudentModalInner');
};

window.closeReassignModal = function() { closeOverlay('reassignStudentModal', 'reassignStudentModalInner'); };

document.getElementById('saveReassignBtn')?.addEventListener('click', async () => {
    const btn = document.getElementById('saveReassignBtn');
    btn.innerHTML = `<i class="fa-solid fa-spinner fa-spin mr-2"></i>Saving...`; 
    btn.disabled = true;

    try {
        const className = document.getElementById('rsClass')?.value || '';
        const teacherId = document.getElementById('rsTeacher')?.value || '';
        
        await updateDoc(doc(db, 'students', currentStudentId), { className, teacherId });
        
        closeReassignModal();
        await loadData(); 
        
        if (document.getElementById('sInfoGrid')) {
            const tm = allTeachersCache.find(t => t.id === teacherId);
            document.getElementById('sInfoGrid').innerHTML = document.getElementById('sInfoGrid').innerHTML
                .replace(/Current Class<\/span>\s*<span[^>]*>[^<]*<\/span>/, `Current Class</span> <span class="text-sm font-semibold text-slate-700">${className || 'Unassigned'}</span>`)
                .replace(/Assigned Teacher<\/span>\s*<span[^>]*>[^<]*<\/span>/, `Assigned Teacher</span> <span class="text-sm font-semibold text-slate-700">${tm ? tm.name : 'Unassigned'}</span>`);
        }
    } catch(e) {
        console.error(e);
        alert("Error reassigning student.");
    }
    
    btn.innerHTML = `Save Assignment`; 
    btn.disabled = false;
});

window.openArchiveReasonModal = function() {
    document.getElementById('sEnrollDropdown')?.classList.add('hidden');
    document.getElementById('archiveReasonSelect').value = 'Transferred to another school';
    document.getElementById('archiveReasonOther').classList.add('hidden');
    document.getElementById('archiveReasonOther').value = '';
    openOverlay('archiveReasonModal', 'archiveReasonModalInner');
};

window.closeArchiveReasonModal = function() { closeOverlay('archiveReasonModal', 'archiveReasonModalInner'); };

document.getElementById('archiveReasonSelect')?.addEventListener('change', function() {
    document.getElementById('archiveReasonOther')?.classList.toggle('hidden', this.value !== 'Other');
});

document.getElementById('confirmArchiveBtn')?.addEventListener('click', async () => {
    const sel = document.getElementById('archiveReasonSelect')?.value;
    const reason = sel === 'Other' ? document.getElementById('archiveReasonOther')?.value.trim() : sel;
    const btn = document.getElementById('confirmArchiveBtn');
    
    if (sel === 'Other' && !reason) {
        alert("Please specify the reason.");
        return;
    }
    
    btn.innerHTML = '<i class="fa-solid fa-spinner fa-spin mr-2"></i>Archiving...';
    btn.disabled = true;
    
    try {
        await updateDoc(doc(db, 'students', currentStudentId), {
            archived: true,
            archivedAt: new Date().toISOString(),
            archiveReason: reason || 'Not specified',
            teacherId: '', 
            className: ''
        });
        
        closeArchiveReasonModal();
        closeStudentPanel(); 
        loadData(); 
    } catch(e) { 
        console.error(e);
        alert("Error archiving student."); 
    }
    
    btn.innerHTML = 'Confirm & Archive';
    btn.disabled = false;
});

// Initialize
document.addEventListener('DOMContentLoaded', loadData);
