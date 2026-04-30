import { db } from '../../assets/js/firebase-init.js';
import { collection, query, where, getDocs, getDoc, doc, updateDoc, deleteDoc } from "https://www.gstatic.com/firebasejs/10.7.1/firebase-firestore.js";
import { requireAuth } from '../../assets/js/auth.js';
import { injectTeacherLayout } from '../../assets/js/layout-teachers.js';
import { openOverlay, closeOverlay, showMsg, gradeColorClass, gradeFill, letterGrade, downloadCSV, calculateWeightedAverage } from '../../assets/js/utils.js';

// ── 1. AUTH & LAYOUT ─────────────────────────────────────────────────────────
const session = requireAuth('teacher', '../login.html');
if (session) {
    injectTeacherLayout('gradebook', 'Gradebook', 'Complete grade record for the selected period', false);
}

// ── 2. STATE ─────────────────────────────────────────────────────────────────
let allStudentsCache = [];
let allGradesCache   = null;
let studentMap       = {};
let gradeDetailCache = {};
let rawSemesters     = [];
let isSemesterLocked = false;
let currentEditData  = null;
let originalScore    = null;
let originalMax      = null;

let sfStudentValue = '';
let sfSubjectValue = '';
let sfTypeValue    = '';

const DEFAULT_GRADE_TYPES = ['Test', 'Quiz', 'Assignment', 'Homework', 'Project', 'Midterm Exam', 'Final Exam'];
// UPDATED: Pull the gradeTypes array saved from the new Settings page
function getGradeTypes() { return session.teacherData.gradeTypes || session.teacherData.customGradeTypes || DEFAULT_GRADE_TYPES; }

// ── 3. SEARCHABLE SELECT COMPONENT ───────────────────────────────────────────
function buildSearchableFilter(key, items, onSelect) {
    const input    = document.getElementById(`sf${cap(key)}Input`);
    const dropdown = document.getElementById(`sf${cap(key)}Dropdown`);
    const clearBtn = document.getElementById(`sf${cap(key)}Clear`);
    if (!input || !dropdown) return;

    let selectedId = '';
    function cap(s) { return s.charAt(0).toUpperCase() + s.slice(1); }

    function renderDropdown(term) {
        const t = (term || '').toLowerCase();
        const filtered = t ? items.filter(i => i.label.toLowerCase().includes(t)) : items;

        let html = `<div class="sf-item sf-all${!selectedId ? ' sf-selected' : ''}" data-id="">All</div>`;
        if (filtered.length === 0) html += `<div class="sf-no-results">No results for "${term}"</div>`;
        else html += filtered.map(i => `<div class="sf-item${i.id === selectedId ? ' sf-selected' : ''}" data-id="${escHtml(i.id)}">${escHtml(i.label)}</div>`).join('');
        
        dropdown.innerHTML = html; dropdown.classList.add('sf-open');
    }

    function close() { dropdown.classList.remove('sf-open'); }

    function select(id, label) {
        selectedId = id; input.value = id ? label : '';
        clearBtn.style.display = id ? 'block' : 'none';
        close(); onSelect(id);
    }

    input.addEventListener('focus', () => renderDropdown(input.value));
    input.addEventListener('input', () => renderDropdown(input.value));

    dropdown.addEventListener('mousedown', (e) => {
        e.preventDefault(); 
        const item = e.target.closest('.sf-item');
        if (!item) return;
        const id = item.dataset.id;
        const label = id ? items.find(i => i.id === id)?.label || '' : '';
        select(id, label);
    });

    document.addEventListener('click', (e) => {
        const wrap = document.getElementById(`sf${cap(key)}Wrap`);
        if (wrap && !wrap.contains(e.target)) close();
    });

    return { clear: () => select('', ''), setItems: (newItems) => { items = newItems; if (selectedId && !items.find(i => i.id === selectedId)) select('', ''); }, getValue: () => selectedId };
}

function cap(s) { return s.charAt(0).toUpperCase() + s.slice(1); }

let sfStudent, sfSubject, sfType;
window.clearSF = function(key) {
    if (key === 'student' && sfStudent) sfStudent.clear();
    if (key === 'subject' && sfSubject) sfSubject.clear();
    if (key === 'type'    && sfType)    sfType.clear();
};

// ── 4. INIT ───────────────────────────────────────────────────────────────────
async function init() {
    if (!session) return;

    document.getElementById('displayTeacherName').textContent = session.teacherData.name;
    document.getElementById('teacherAvatar').textContent      = session.teacherData.name.charAt(0).toUpperCase();
    document.getElementById('sidebarSchoolId').textContent    = session.schoolId;
    const classes = session.teacherData.classes || [session.teacherData.className || ''];
    document.getElementById('displayTeacherClasses').innerHTML = classes.filter(Boolean).map(c => `<span class="class-pill">${c}</span>`).join('');

    sfType = buildSearchableFilter('type', getGradeTypes().map(t => { const name = t.name || t; return { id: name, label: name }; }), (val) => { sfTypeValue = val; applyGradebookFilters(); });
    sfStudent = buildSearchableFilter('student', [], (val) => { sfStudentValue = val; applyGradebookFilters(); });
    sfSubject = buildSearchableFilter('subject', [], (val) => { sfSubjectValue = val; applyGradebookFilters(); });

    document.getElementById('updateGradeBtn').addEventListener('click', saveEditedGrade);

    await Promise.all([loadSemestersAndLockStatus(), loadStudents()]);
    await loadGradebook();
}

// ── 5. SEMESTERS ─────────────────────────────────────────────────────────────
async function loadSemestersAndLockStatus() {
    try {
        const cacheKey = `connectus_semesters_${session.schoolId}`;
        let rawSems    = [];
        const cached = localStorage.getItem(cacheKey);
        
        if (cached) { try { rawSems = JSON.parse(cached); } catch (_) { rawSems = []; } }
        if (!rawSems.length) {
            const semSnap = await getDocs(collection(db, 'schools', session.schoolId, 'semesters'));
            rawSems = semSnap.docs.map(d => ({ id: d.id, ...d.data() })).sort((a, b) => (a.order || 0) - (b.order || 0));
            localStorage.setItem(cacheKey, JSON.stringify(rawSems));
        }

        rawSemesters = rawSems;
        const schoolSnap = await getDoc(doc(db, 'schools', session.schoolId));
        const activeId   = schoolSnap.data()?.activeSemesterId || '';

        const semSel = document.getElementById('activeSemester');
        if (semSel) {
            semSel.innerHTML = '';
            rawSemesters.forEach(s => {
                const opt = document.createElement('option'); opt.value = s.id; opt.textContent = s.name;
                if (s.id === activeId) opt.selected = true;
                semSel.appendChild(opt);
            });

            checkLockStatus();
            const sbPeriod = document.getElementById('sb-period');
            if (sbPeriod) sbPeriod.textContent = semSel.options[semSel.selectedIndex]?.text || '—';

            semSel.addEventListener('change', () => {
                checkLockStatus(); allGradesCache = null;
                const sbP = document.getElementById('sb-period');
                if (sbP) sbP.textContent = semSel.options[semSel.selectedIndex]?.text || '—';
                loadGradebook();
            });
        }
    } catch (e) { console.error('[Gradebook] loadSemesters:', e); }
}

function checkLockStatus() {
    const semId = document.getElementById('activeSemester')?.value;
    const activeSem = rawSemesters.find(s => s.id === semId);
    isSemesterLocked = activeSem ? !!activeSem.isLocked : false;
    const badge = document.getElementById('topbarLockedBadge');
    if (badge) {
        isSemesterLocked ? badge.classList.remove('hidden') : badge.classList.add('hidden');
        isSemesterLocked ? badge.classList.add('flex') : badge.classList.remove('flex');
    }
}

// ── 6. LOAD STUDENTS ──────────────────────────────────────────────────────────
async function loadStudents() {
    try {
        const stuSnap = await getDocs(query(collection(db, 'students'), where('currentSchoolId', '==', session.schoolId), where('enrollmentStatus', '==', 'Active')));
        allStudentsCache = stuSnap.docs.map(d => ({ id: d.id, ...d.data() })).filter(d => d.teacherId === session.teacherId);
        studentMap = {};
        allStudentsCache.forEach(s => { studentMap[s.id] = s.name; });

        const sbStudents = document.getElementById('sb-students');
        if (sbStudents) sbStudents.textContent = allStudentsCache.length;

        if (sfStudent) sfStudent.setItems([...allStudentsCache].sort((a, b) => a.name.localeCompare(b.name)).map(s => ({ id: s.id, label: s.name })));
    } catch (e) { console.error('[Gradebook] loadStudents:', e); }
}

// ── 7. GRADE CACHE ────────────────────────────────────────────────────────────
async function getAllGrades(semId) {
    if (allGradesCache && allGradesCache.semId === semId) return allGradesCache.grades;
    const all = [];
    await Promise.all(allStudentsCache.map(async s => {
        try {
            // FIXED: Look in global passport path, filtering for THIS school
            const q = query(
                collection(db, 'students', s.id, 'grades'), 
                where('schoolId', '==', session.schoolId),
                where('semesterId', '==', semId)
            );
            const snap = await getDocs(q);
            snap.forEach(d => all.push({ id: d.id, studentId: s.id, studentName: s.name, ...d.data() }));
        } catch (e) {}
    }));
    allGradesCache = { semId, grades: all };
    return all;
}

// ── 8. LOAD GRADEBOOK ─────────────────────────────────────────────────────────
async function loadGradebook() {
    const tbody = document.getElementById('gradebookTableBody');
    tbody.innerHTML = `<tr><td colspan="8"><div class="gb-empty"><i class="fa-solid fa-spinner fa-spin" style="color:#0ea871;"></i><p>Loading gradebook…</p></div></td></tr>`;

    const semId = document.getElementById('activeSemester')?.value;
    if (!semId) { renderGradebook(); return; }
    if (!allStudentsCache.length) await loadStudents();

    const grades = await getAllGrades(semId);

    const stuGMap = {};
    grades.forEach(g => { if (!stuGMap[g.studentId]) stuGMap[g.studentId] = []; stuGMap[g.studentId].push(g); });
    
    // UPDATED: Using Teacher-Specific Grade Types
    const riskCount = Object.values(stuGMap).filter(sg => {
        const avg = calculateWeightedAverage(sg, getGradeTypes());
        return avg !== null && avg < 65;
    }).length;
    
    const sbRisk = document.getElementById('sb-risk');
    if (sbRisk) { sbRisk.textContent = riskCount; sbRisk.classList.toggle('is-risk', riskCount > 0); }

    if (sfSubject) {
        const subjSet = [...new Set(grades.map(g => g.subject || 'Uncategorized'))].sort();
        sfSubject.setItems(subjSet.map(s => ({ id: s, label: s })));
    }

    renderGradebook();
}

// ── 9. RENDER ─────────────────────────────────────────────────────────────────
function renderGradebook() {
    const tbody = document.getElementById('gradebookTableBody');
    const fText = (document.getElementById('gbSearchInput')?.value || '').toLowerCase();
    
    let rows = allGradesCache?.grades || [];
    if (sfStudentValue) rows = rows.filter(g => g.studentId === sfStudentValue);
    if (sfSubjectValue) rows = rows.filter(g => g.subject   === sfSubjectValue);
    if (sfTypeValue)    rows = rows.filter(g => g.type      === sfTypeValue);
    if (fText)          rows = rows.filter(g => (g.title || '').toLowerCase().includes(fText));

    const countEl = document.getElementById('gbRecordCount');
    if (countEl) countEl.innerHTML = `<div class="gb-count-dot"></div><span>${rows.length} record${rows.length !== 1 ? 's' : ''}</span>`;

    const allRows = allGradesCache?.grades || [];
    const stuGrps = {};
    allRows.forEach(g => { if (!stuGrps[g.studentId]) stuGrps[g.studentId] = []; stuGrps[g.studentId].push(g); });
    
    // UPDATED: Using Teacher-Specific Grade Types
    const stuAvgs = Object.values(stuGrps).map(sg => calculateWeightedAverage(sg, getGradeTypes())).filter(a => a !== null);
    const avgAll  = stuAvgs.length ? Math.round(stuAvgs.reduce((a, b) => a + b, 0) / stuAvgs.length) : null;
    const allPcts = allRows.map(g => g.max ? Math.round(g.score / g.max * 100) : 0);

    const totalEl = document.getElementById('gbStatTotal');
    if (totalEl) totalEl.textContent = allRows.length || '—';

    const avgEl = document.getElementById('gbStatAvg');
    if (avgEl) { avgEl.textContent = avgAll !== null ? avgAll + '%' : '—'; avgEl.style.color = avgAll !== null ? gradeColor(avgAll) : '#0d1f35'; }

    // UPDATED: Using Teacher-Specific Grade Types
    const riskStat = Object.values(stuGrps).filter(sg => {
        const avg = calculateWeightedAverage(sg, getGradeTypes());
        return avg !== null && avg < 65;
    }).length;
    
    const riskEl = document.getElementById('gbStatRisk');
    if (riskEl) { riskEl.textContent = riskStat || '0'; riskEl.style.color = riskStat > 0 ? '#e31b4a' : '#0d1f35'; }

    const dist  = { a: 0, b: 0, c: 0, d: 0, f: 0 };
    allPcts.forEach(p => { if (p >= 90) dist.a++; else if (p >= 80) dist.b++; else if (p >= 70) dist.c++; else if (p >= 65) dist.d++; else dist.f++; });
    const tot = allPcts.length || 1;
    const distBar = document.getElementById('gbDistBar');
    if (distBar) {
        distBar.innerHTML = [
            dist.a ? `<div class="dist-seg" style="width:${dist.a/tot*100}%;background:#10b981;"></div>` : '',
            dist.b ? `<div class="dist-seg" style="width:${dist.b/tot*100}%;background:#3b82f6;"></div>` : '',
            dist.c ? `<div class="dist-seg" style="width:${dist.c/tot*100}%;background:#14b8a6;"></div>` : '',
            dist.d ? `<div class="dist-seg" style="width:${dist.d/tot*100}%;background:#f59e0b;"></div>` : '',
            dist.f ? `<div class="dist-seg" style="width:${dist.f/tot*100}%;background:#ef4444;"></div>` : '',
            !allPcts.length ? `<div style="width:100%;background:#f0f4f8;height:10px;"></div>` : ''
        ].join('');
    }

    const legendEl = document.getElementById('gbDistLegend');
    if (legendEl) {
        legendEl.innerHTML = [['A',dist.a,'#10b981'],['B',dist.b,'#3b82f6'],['C',dist.c,'#14b8a6'],['D',dist.d,'#f59e0b'],['F',dist.f,'#ef4444']]
            .map(([l,n,c]) => `<div class="dist-legend-item"><div class="dist-dot" style="background:${c};"></div>${l}: ${n}</div>`).join('');
    }

    const semSel = document.getElementById('activeSemester');
    const pbadge = document.getElementById('gbPeriodBadge');
    if (pbadge && semSel) pbadge.textContent = semSel.options[semSel.selectedIndex]?.text || '—';

    const lockedBar = document.getElementById('gbLockedBar');
    if (lockedBar) lockedBar.classList.toggle('hidden', !isSemesterLocked);

    if (!rows.length) {
        tbody.innerHTML = `<tr><td colspan="8"><div class="gb-empty"><i class="fa-solid fa-folder-open"></i><p>${allRows.length ? 'No grades match the selected filters.' : 'No grades logged yet for this period.'}</p></div></td></tr>`;
        return;
    }

    gradeDetailCache = {};

    tbody.innerHTML = rows.sort((a, b) => (b.date || '').localeCompare(a.date || '')).map((g, idx) => {
        gradeDetailCache[g.id] = g;
        const pct = g.max ? Math.round(g.score / g.max * 100) : null;
        const letter = pct !== null ? letterGrade(pct) : '—';
        const badgeCls = pct >= 90 ? 'gg-a' : pct >= 80 ? 'gg-b' : pct >= 70 ? 'gg-c' : pct >= 65 ? 'gg-d' : 'gg-f';
        const barColor = pct >= 90 ? '#10b981' : pct >= 80 ? '#3b82f6' : pct >= 70 ? '#14b8a6' : pct >= 65 ? '#f59e0b' : '#ef4444';
        const initial = (g.studentName || '?').charAt(0).toUpperCase();

        const actionBtns = isSemesterLocked
            ? `<span style="font-size:10px;color:#9ab0c6;font-weight:700;"><i class="fa-solid fa-lock"></i></span>`
            : `<button onclick="openEditGradeModal('${g.studentId}','${g.id}')" class="gb-row-btn gb-btn-edit" title="Edit"><i class="fa-solid fa-pen"></i></button>
               <button onclick="deleteGrade('${g.studentId}','${g.id}')" class="gb-row-btn gb-btn-delete" title="Delete"><i class="fa-solid fa-trash-can"></i></button>`;

        return `<tr class="gb-row">
            <td style="color:#9ab0c6;font-size:11px;font-family:'DM Mono',monospace;">${String(idx+1).padStart(2,'0')}</td>
            <td><div class="gb-student-cell"><div class="gb-student-init">${initial}</div><span class="gb-student-name">${escHtml(g.studentName||'Unknown')}</span></div></td>
            <td><span class="gb-subject-badge">${escHtml(g.subject||'—')}</span></td>
            <td><p class="gb-title">${escHtml(g.title||'—')}</p><p class="gb-date">${g.date||''}</p></td>
            <td><span class="gb-type-badge">${escHtml(g.type||'—')}</span></td>
            <td class="tc"><span class="gb-score">${g.score}<span style="color:#9ab0c6;"> / ${g.max||'?'}</span></span></td>
            <td class="tc"><div class="gb-grade-wrap"><span class="gb-grade-badge ${badgeCls}">${pct!==null?pct+'%':'—'} · ${letter}</span><div class="gb-bar-bg"><div class="gb-bar-fill" style="width:${Math.min(pct||0,100)}%;background:${barColor};"></div></div></div></td>
            <td class="tr"><div style="display:flex;align-items:center;justify-content:flex-end;gap:5px;"><button onclick="openAssignmentModal('${g.id}')" class="gb-row-btn gb-btn-view" title="View"><i class="fa-solid fa-eye"></i></button>${actionBtns}</div></td>
        </tr>`;
    }).join('');
}

window.applyGradebookFilters = function() { renderGradebook(); };

function gradeColor(pct) {
    if (pct >= 90) return '#065f46'; if (pct >= 80) return '#1e3a8a';
    if (pct >= 70) return '#134e4a'; if (pct >= 65) return '#78350f'; return '#7f1d1d';
}

// ── 11. VIEW ASSIGNMENT MODAL ─────────────────────────────────────────────────
window.openAssignmentModal = function(gradeId) {
    const g = gradeDetailCache[gradeId];
    if (!g) return;
    const pct = g.max ? Math.round(g.score / g.max * 100) : null;
    const fill = gradeFill(pct || 0);
    const color = pct >= 90 ? 'text-emerald-600' : pct >= 80 ? 'text-blue-600' : pct >= 70 ? 'text-teal-600' : pct >= 65 ? 'text-amber-600' : 'text-red-600';
    document.getElementById('aModalTitle').textContent = g.title || 'Assessment';
    let histHTML = '';
    if (g.historyLogs?.length) {
        histHTML = `<div style="background:#fffbeb;border:1px solid #fde68a;border-radius:4px;padding:14px;margin-top:14px;">
            <p style="font-size:9.5px;font-weight:700;text-transform:uppercase;letter-spacing:0.1em;color:#78350f;margin:0 0 10px;"><i class="fa-solid fa-clock-rotate-left" style="margin-right:4px;"></i>Edit History (${g.historyLogs.length})</p>
            <div style="display:flex;flex-direction:column;gap:6px;max-height:120px;overflow-y:auto;">
                ${g.historyLogs.map(l => `<div style="font-size:11px;color:#78350f;background:#fff;border:1px solid #fde68a;border-radius:3px;padding:7px 10px;">${typeof l==='object' ? `[${escHtml(l.changedAt)}] ${l.oldScore}/${l.oldMax} → ${l.newScore}/${l.newMax}. ${escHtml(l.reason||'')}` : escHtml(l)}</div>`).join('')}
            </div>
        </div>`;
    }
    document.getElementById('aModalBody').innerHTML = `
        <div style="text-align:center;margin-bottom:18px;">
            <div class="${color}" style="font-size:40px;font-weight:700;font-family:'DM Mono',monospace;line-height:1;">${g.score}<span style="font-size:18px;color:#9ab0c6;"> / ${g.max||'?'}</span></div>
            ${pct!==null ? `<div style="display:flex;align-items:center;justify-content:center;gap:10px;margin-top:8px;"><span class="${color}" style="font-size:16px;font-weight:700;font-family:'DM Mono',monospace;">${pct}%</span><span class="${color}" style="font-size:13px;font-weight:700;padding:4px 12px;border-radius:3px;border:1px solid;${pct>=90?'background:#dcfce7;border-color:#bbf7d0;':pct>=80?'background:#dbeafe;border-color:#bfdbfe;':pct>=70?'background:#ccfbf1;border-color:#99f6e4;':pct>=65?'background:#fef3c7;border-color:#fde68a;':'background:#fee2e2;border-color:#fecaca;'}">${letterGrade(pct)}</span></div><div style="margin:10px 16px 0;height:6px;background:#f0f4f8;border-radius:2px;overflow:hidden;"><div style="height:100%;width:${pct||0}%;background:${fill};"></div></div>` : ''}
        </div>
        <div style="display:flex;flex-direction:column;gap:0;margin-bottom:14px;border:1px solid #e8edf2;border-radius:4px;overflow:hidden;">
            ${[['Subject',g.subject||'—'],['Type',g.type||'—'],['Date',g.date||'—']].map(([l,v],i) => `<div style="display:flex;align-items:center;justify-content:space-between;padding:9px 14px;${i<2?'border-bottom:1px solid #f0f4f8;':''}background:#fff;"><span style="font-size:9.5px;font-weight:700;text-transform:uppercase;letter-spacing:0.1em;color:#9ab0c6;">${l}</span><span style="font-size:13px;font-weight:600;color:#0d1f35;">${escHtml(v)}</span></div>`).join('')}
        </div>
        ${g.notes ? `<div style="background:#eff6ff;border:1px solid #bfdbfe;border-radius:4px;padding:14px;margin-bottom:14px;"><p style="font-size:9.5px;font-weight:700;text-transform:uppercase;letter-spacing:0.1em;color:#1e3a8a;margin:0 0 6px;">Teacher Notes</p><p style="font-size:12.5px;color:#374f6b;font-weight:400;margin:0;line-height:1.6;white-space:pre-wrap;">${escHtml(g.notes)}</p></div>` : ''}
        ${histHTML}`;
    openOverlay('assignmentModal', 'assignmentModalInner');
};
window.closeAssignmentModal = function() { closeOverlay('assignmentModal', 'assignmentModalInner'); };

// ── 12. EDIT GRADE MODAL ──────────────────────────────────────────────────────
window.openEditGradeModal = async function(studentId, gradeId) {
    if (isSemesterLocked) return;
    try {
        // ADDED: Re-target edit grab to global path
        const snap = await getDoc(doc(db, 'students', studentId, 'grades', gradeId));
        if (!snap.exists()) return;
        currentEditData = { studentId, gradeId, ...snap.data() };
        originalScore   = currentEditData.score;
        originalMax     = currentEditData.max;
        document.getElementById('editGradeContext').textContent = `${studentMap[studentId]||'Student'} · ${currentEditData.subject||''} · ${currentEditData.title||''}`;
        document.getElementById('ed-old-notes').textContent = currentEditData.notes || '—';
        document.getElementById('ed-new-notes').value = '';
        document.getElementById('ed-score').value = currentEditData.score;
        document.getElementById('ed-max').value = currentEditData.max;
        document.getElementById('ed-reason').value = '';
        document.getElementById('reasonSection').classList.remove('visible');
        document.getElementById('editGradeMsg').classList.add('hidden');
        openOverlay('editGradeModal', 'editGradeModalInner');
    } catch (e) {
        console.error('[Gradebook] openEditGradeModal:', e);
        alert('Error loading grade details.');
    }
};
window.closeEditGradeModal = function() { closeOverlay('editGradeModal', 'editGradeModalInner'); };

window.checkScoreChange = function() {
    const s = parseFloat(document.getElementById('ed-score')?.value);
    const m = parseFloat(document.getElementById('ed-max')?.value);
    document.getElementById('reasonSection').classList.toggle('visible', s !== originalScore || m !== originalMax);
};

async function saveEditedGrade() {
    const nScore = parseFloat(document.getElementById('ed-score').value);
    const nMax   = parseFloat(document.getElementById('ed-max').value);
    const note   = document.getElementById('ed-new-notes').value.trim();
    const changed = (nScore !== originalScore || nMax !== originalMax);
    if (changed) {
        const reason = document.getElementById('ed-reason').value.trim();
        if (!reason) { alert('A reason is required when changing the score.'); document.getElementById('ed-reason').focus(); return; }
    }
    const btn = document.getElementById('updateGradeBtn');
    btn.innerHTML = `<i class="fa-solid fa-spinner fa-spin"></i> Saving…`; btn.disabled = true;
    try {
        let finalNotes = currentEditData.notes || '';
        if (note) { const ts = `[${new Date().toLocaleDateString()}] ${note}`; finalNotes = finalNotes ? `${ts}\n\n${finalNotes}` : ts; }
        const updates = { notes: finalNotes, score: nScore, max: nMax };
        if (changed) {
            const reason = document.getElementById('ed-reason').value.trim();
            updates.historyLogs = [...(currentEditData.historyLogs||[]), { changedAt: new Date().toLocaleString(), oldScore: originalScore, oldMax: originalMax, newScore: nScore, newMax: nMax, reason }];
        }
        
        // ADDED: Re-target edit write to global path
        await updateDoc(doc(db, 'students', currentEditData.studentId, 'grades', currentEditData.gradeId), updates);
        
        closeEditGradeModal();
        allGradesCache = null;
        loadGradebook();
    } catch (e) {
        console.error('[Gradebook] saveEditedGrade:', e);
        showMsg('editGradeMsg', 'Error saving changes.', true);
    }
    btn.innerHTML = `<i class="fa-solid fa-floppy-disk"></i> Save Changes`; btn.disabled = false;
}

// ── 13. DELETE ────────────────────────────────────────────────────────────────
window.deleteGrade = async function(studentId, gradeId) {
    if (isSemesterLocked) return;
    if (!confirm('Are you sure you want to permanently delete this grade?')) return;
    try {
        // ADDED: Re-target delete to global path
        await deleteDoc(doc(db, 'students', studentId, 'grades', gradeId));
        allGradesCache = null;
        loadGradebook();
    } catch (e) { console.error('[Gradebook] deleteGrade:', e); alert('Failed to delete grade.'); }
};

// ── 14. EXPORT & PRINT ────────────────────────────────────────────────────────
function getFilteredRows() {
    const fText = (document.getElementById('gbSearchInput')?.value || '').toLowerCase();
    let rows = allGradesCache?.grades || [];
    if (sfStudentValue) rows = rows.filter(g => g.studentId === sfStudentValue);
    if (sfSubjectValue) rows = rows.filter(g => g.subject   === sfSubjectValue);
    if (sfTypeValue)    rows = rows.filter(g => g.type      === sfTypeValue);
    if (fText)          rows = rows.filter(g => (g.title||'').toLowerCase().includes(fText));
    return rows;
}

window.exportGradebookCSV = function() {
    downloadCSV([
        ['Student','Subject','Assignment','Type','Date','Score','Max','%','Letter','Notes'],
        ...getFilteredRows().map(g => {
            const p = g.max ? Math.round(g.score/g.max*100) : null;
            return [g.studentName, g.subject||'', g.title||'', g.type||'', g.date||'',
                    g.score, g.max||'', p!==null?p+'%':'', p!==null?letterGrade(p):'', g.notes||''];
        })
    ], `${session.schoolId}_gradebook.csv`);
};

window.printGradebook = function() {
    const rows = getFilteredRows().sort((a,b)=>(b.date||'').localeCompare(a.date||''));
    const semName = document.getElementById('activeSemester')?.options[document.getElementById('activeSemester')?.selectedIndex]?.text || '';
    const schoolName = session.schoolName || session.schoolId;
    
    const w = window.open('', '_blank');
    w.document.write(`
    <!DOCTYPE html>
    <html>
    <head>
        <meta charset="UTF-8">
        <title>Gradebook — ${escHtml(session.teacherData.name)}</title>
        <style>
            @import url('https://fonts.googleapis.com/css2?family=DM+Sans:wght@400;600;700&family=DM+Mono:wght@400&display=swap');
            *{box-sizing:border-box;margin:0;padding:0;}
            body{font-family:'DM Sans',sans-serif;padding:40px 48px;color:#0d1f35;}
            .header{display:flex;flex-direction:column;align-items:center;margin-bottom:28px;padding-bottom:20px;border-bottom:2px solid #0d1f35;}
            .logo{max-height:44px;max-width:160px;object-fit:contain;margin-bottom:10px;}
            .doc-title{font-size:16px;font-weight:700;margin-bottom:4px;}
            .meta{font-size:11px;color:#6b84a0;}
            table{width:100%;border-collapse:collapse;font-size:12px;}
            th{padding:9px 12px;background:#0d1f35;color:#fff;font-size:9px;font-weight:700;text-transform:uppercase;letter-spacing:0.1em;text-align:left;}
            td{padding:9px 12px;border-bottom:1px solid #e8edf2;}
            tr:nth-child(even) td{background:#f8fafb;}
            .hi{color:#065f46;font-weight:700;}
            .mid{color:#78350f;font-weight:700;}
            .lo{color:#7f1d1d;font-weight:700;}
            .mono{font-family:'DM Mono',monospace;}
            .footer{margin-top:32px;padding-top:10px;border-top:1px solid #e8edf2;font-size:10px;color:#9ab0c6;text-align:center;}
        </style>
    </head>
    <body>
        <div class="header">
            <img src="${session.logo || ''}" alt="${escHtml(schoolName)}" class="logo" onerror="this.style.display='none'">
            <p class="doc-title">Class Gradebook</p>
            <p class="meta">${escHtml(session.teacherData.name)} &nbsp;·&nbsp; ${escHtml(semName)} &nbsp;·&nbsp; ${rows.length} records &nbsp;·&nbsp; ${new Date().toLocaleDateString('en-US',{year:'numeric',month:'long',day:'numeric'})}</p>
        </div>
        <table>
            <thead>
                <tr><th>Student</th><th>Subject</th><th>Assignment</th><th>Type</th><th>Date</th><th>Score</th><th>%</th><th>Grade</th></tr>
            </thead>
            <tbody>
                ${rows.map(g=>{
                    const p=g.max?Math.round(g.score/g.max*100):null;
                    const cls=p>=75?'hi':p>=65?'mid':'lo';
                    return \`<tr><td><strong>${escHtml(g.studentName)}</strong></td><td>${escHtml(g.subject||'—')}</td><td>${escHtml(g.title||'—')}</td><td>${escHtml(g.type||'—')}</td><td>${escHtml(g.date||'—')}</td><td class="mono">${g.score}/${g.max||'?'}</td><td class="mono ${cls}">${p!==null?p+'%':'—'}</td><td class="${cls}">${p!==null?letterGrade(p):'—'}</td></tr>\`;
                }).join('')}
            </tbody>
        </table>
        <div class="footer" style="display:flex; flex-direction:column; align-items:center; gap:8px;">
            <span>Generated for ${escHtml(schoolName)}</span>
            <div style="display:flex; justify-content:center; align-items:center; gap:8px; margin-top:5px;">
                <img src="../../assets/images/logo.png" style="max-height:16px; opacity:0.8;">
                <span style="font-weight:bold; color:#0d1f35;">Powered by ConnectUs</span>
            </div>
        </div>
    </body>
    </html>`);
    w.document.close(); setTimeout(()=>w.print(), 600);
};

function escHtml(str) {
    if (!str) return '';
    return String(str).replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/"/g,'&quot;');
}

init();
