import { db } from '../../assets/js/firebase-init.js';
import {
    collection, doc, getDocs, addDoc, query, where, orderBy
} from "https://www.gstatic.com/firebasejs/10.7.1/firebase-firestore.js";
import { requireAuth } from '../../assets/js/auth.js';
import { injectAdminLayout } from '../../assets/js/layout-admin.js';
import { openOverlay, closeOverlay } from '../../assets/js/utils.js';

// ── 1. INIT ───────────────────────────────────────────────────────────────
const session = requireAuth('admin', '../login.html');
injectAdminLayout('evaluations', 'Teacher Evaluations', 'Performance reviews and professional assessments', false, false);

// ── 2. STATE ──────────────────────────────────────────────────────────────
let allTeachers  = [];
let evalMapCache = {};
let dynamicEvalTypes = new Set();
let evalRatings  = { overallRating: 0, classroomManagement: 0, curriculumDelivery: 0, studentEngagement: 0, professionalConduct: 0 };
window.currentPanelTeacherId = null;

function escHtml(str) {
    if (!str) return '';
    return String(str).replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/\"/g,'&quot;');
}

// ── 3. STAR RATING WIDGETS ────────────────────────────────────────────────
function buildStarGroups() {
    document.querySelectorAll('.rating-row').forEach(row => {
        const field = row.dataset.field;
        const group = row.querySelector('.star-group');
        group.innerHTML = [1,2,3,4,5].map(n =>
            `<button type="button" data-val="${n}" data-field="${field}"
                style="font-size:18px;color:#dce3ed;background:none;border:none;cursor:pointer;padding:1px;transition:color 0.1s"
                onmouseover="window.hoverStars('${field}',${n})"
                onmouseout="window.renderStars('${field}')"
                onclick="window.setRating('${field}',${n})">★</button>`
        ).join('');
        renderStars(field);
    });
}

window.renderStars = function(field) {
    const val = evalRatings[field] || 0;
    document.querySelectorAll(`[data-field="${field}"]`).forEach(btn => {
        btn.style.color = parseInt(btn.dataset.val) <= val ? '#f59e0b' : '#dce3ed';
    });
};

window.hoverStars = function(field, val) {
    document.querySelectorAll(`[data-field="${field}"]`).forEach(btn => {
        btn.style.color = parseInt(btn.dataset.val) <= val ? '#f59e0b' : '#dce3ed';
    });
};

window.setRating = function(field, val) {
    evalRatings[field] = val;
    renderStars(field);
};

// ── 4. LOAD TEACHERS & EVALS ──────────────────────────────────────────────
async function loadPage() {
    try {
        const snap = await getDocs(query(
            collection(db, 'teachers'),
            where('currentSchoolId', '==', session.schoolId)
        ));
        allTeachers = snap.docs.map(d => ({ id: d.id, ...d.data() }))
                               .sort((a, b) => (a.name || '').localeCompare(b.name || ''));

        // Populate teacher dropdown in modal
        const sel = document.getElementById('evalTeacherId');
        sel.innerHTML = '<option value="">Select teacher...</option>' +
            allTeachers.map(t => `<option value="${t.id}">${escHtml(t.name)}</option>`).join('');

        // Load evaluations for all teachers in parallel
        const evalPromises = allTeachers.map(async t => {
            const eSnap = await getDocs(query(
                collection(db, 'teachers', t.id, 'evaluations'),
                where('schoolId', '==', session.schoolId)
            ));
            return { teacherId: t.id, evals: eSnap.docs.map(d => ({ id: d.id, ...d.data() })) };
        });

        const allEvals = await Promise.all(evalPromises);
        evalMapCache = {};
        dynamicEvalTypes.clear();

        allEvals.forEach(e => { 
            evalMapCache[e.teacherId] = e.evals; 
            // Harvest custom evaluation types to reuse in dropdown
            e.evals.forEach(ev => {
                if (ev.type) dynamicEvalTypes.add(ev.type);
            });
        });

        renderTable(evalMapCache);
        renderSummaryCards(evalMapCache);

    } catch (e) {
        console.error('[Evaluations] loadPage:', e);
        document.getElementById('evalTableBody').innerHTML =
            '<tr><td colspan="6" class="px-6 py-10 text-center text-[#e31b4a] font-bold">Error loading data.</td></tr>';
    }
}

// ── 5. RENDER TABLE ───────────────────────────────────────────────────────
function renderTable(evalMap, filter = '') {
    const tbody   = document.getElementById('evalTableBody');
    const teachers = filter
        ? allTeachers.filter(t => (t.name || '').toLowerCase().includes(filter.toLowerCase()))
        : allTeachers;

    if (!teachers.length) {
        tbody.innerHTML = '<tr><td colspan="6" class="px-6 py-12 text-center text-[#9ab0c6] italic font-semibold">No teachers found.</td></tr>';
        return;
    }

    tbody.innerHTML = teachers.map(t => {
        const evals   = evalMap[t.id] || [];
        const count   = evals.length;
        const avg     = count ? (evals.reduce((s, e) => s + (e.overallRating || 0), 0) / count).toFixed(1) : null;
        const last    = count ? evals.sort((a, b) => new Date(b.date || b.timestamp) - new Date(a.date || a.timestamp))[0] : null;
        const lastStr = last ? new Date(last.date || last.timestamp).toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' }) : '—';
        const rec     = last?.recommendedAction && last.recommendedAction !== 'None' ? last.recommendedAction : '—';

        const stars   = avg ? Math.round(parseFloat(avg)) : 0;
        const starStr = avg
            ? [1,2,3,4,5].map(n => `<span style="color:${n <= stars ? '#f59e0b' : '#dce3ed'};font-size:13px">★</span>`).join('') + ` <span class="text-[12px] font-bold text-[#374f6b]">${avg}</span>`
            : '<span class="text-[11px] text-[#9ab0c6] italic">No ratings</span>';

        const recColor = rec === 'Commendation' ? 'color:#0ea871;background:#edfaf4;border-color:#c6f0db'
                       : rec === 'Formal Warning' || rec === 'Performance Plan' ? 'color:#e31b4a;background:#fff0f3;border-color:#ffd6de'
                       : rec === 'Professional Development' ? 'color:#b45309;background:#fffbeb;border-color:#fef3c7'
                       : 'color:#6b84a0;background:#f4f7fb;border-color:#dce3ed';

        return `<tr class="hover:bg-[#f8fafb] transition">
            <td class="px-6 py-4">
                <div class="flex items-center gap-3">
                    <div style="width:34px;height:34px;border-radius:8px;background:#f0f4f8;border:1px solid #dce3ed;display:flex;align-items:center;justify-content:center;font-size:12px;font-weight:700;color:#6b84a0;flex-shrink:0">
                        ${(t.name || 'T').split(' ').map(w => w[0]).join('').toUpperCase().slice(0, 2)}
                    </div>
                    <div>
                        <p class="font-bold text-[#0d1f35]">${escHtml(t.name)}</p>
                        <p class="text-[10px] text-[#9ab0c6] font-mono">${t.id}</p>
                    </div>
                </div>
            </td>
            <td class="px-6 py-4 text-center">
                <span class="font-bold text-[#0d1f35]">${count}</span>
            </td>
            <td class="px-6 py-4 text-center">${starStr}</td>
            <td class="px-6 py-4 text-center text-[12px] text-[#6b84a0] font-semibold">${lastStr}</td>
            <td class="px-6 py-4 text-center">
                <span style="font-size:11px;font-weight:700;padding:3px 10px;border-radius:99px;border:1px solid;${recColor}">${rec}</span>
            </td>
            <td class="px-6 py-4 text-right">
                <div class="flex items-center justify-end gap-2">
                    <button onclick="window.openEvalPanel('${t.id}','${escHtml(t.name)}')"
                        class="bg-white hover:bg-[#eef4ff] text-[#2563eb] font-bold px-3 py-1.5 rounded text-[11px] transition border border-[#c7d9fd]">
                        <i class="fa-regular fa-eye mr-1"></i> View
                    </button>
                    <button onclick="window.openNewEvalModal('${t.id}')"
                        class="bg-[#eef4ff] hover:bg-[#dbeafe] text-[#2563eb] font-bold px-3 py-1.5 rounded text-[11px] transition border border-[#c7d9fd]">
                        <i class="fa-solid fa-plus"></i>
                    </button>
                </div>
            </td>
        </tr>`;
    }).join('');
}

function renderSummaryCards(evalMap) {
    const allEvalsList = Object.values(evalMap).flat();
    const total        = allEvalsList.length;
    const avgAll       = total
        ? (allEvalsList.reduce((s, e) => s + (e.overallRating || 0), 0) / total).toFixed(1)
        : '—';
    const evalledCount = Object.values(evalMap).filter(e => e.length > 0).length;

    document.getElementById('summaryCards').innerHTML = [
        { label: 'Total Evaluations', value: total, icon: 'fa-file-lines', color: '#2563eb', bg: '#eef4ff' },
        { label: 'Average Teacher Rating', value: avgAll, icon: 'fa-star', color: '#f59e0b', bg: '#fffbeb' },
        { label: 'Teachers Evaluated', value: `${evalledCount} / ${allTeachers.length}`, icon: 'fa-chalkboard-user', color: '#0ea871', bg: '#edfaf4' }
    ].map(c => `
        <div style="background:#fff;border:1px solid #dce3ed;border-radius:14px;padding:20px 22px;display:flex;align-items:center;gap:16px;box-shadow:0 1px 3px rgba(13,31,53,0.06)">
            <div style="width:40px;height:40px;border-radius:10px;background:${c.bg};display:flex;align-items:center;justify-content:center;flex-shrink:0">
                <i class="fa-solid ${c.icon}" style="color:${c.color};font-size:16px"></i>
            </div>
            <div>
                <p style="font-size:22px;font-weight:700;color:#0d1f35;margin:0;letter-spacing:-0.5px">${c.value}</p>
                <p style="font-size:11px;color:#6b84a0;font-weight:600;margin:2px 0 0;text-transform:uppercase;letter-spacing:0.06em">${c.label}</p>
            </div>
        </div>`).join('');
}

window.filterEvalTable = function(val) {
    renderTable(evalMapCache, val);
};

// ── 6. EVAL HISTORY PANEL (ACCORDION) ─────────────────────────────────────
window.openEvalPanel = async function(teacherId, teacherName) {
    window.currentPanelTeacherId = teacherId;
    document.getElementById('evalPanelName').textContent = teacherName;
    document.getElementById('evalPanelBody').innerHTML =
        '<div class="flex justify-center py-10"><i class="fa-solid fa-spinner fa-spin text-2xl text-[#2563eb]"></i></div>';

    openOverlay('evalHistoryPanel', 'evalHistoryPanelInner', true);

    try {
        const evals = (evalMapCache[teacherId] || [])
            .sort((a, b) => new Date(b.date || b.timestamp) - new Date(a.date || a.timestamp));

        if (!evals.length) {
            document.getElementById('evalPanelBody').innerHTML =
                '<div style="text-align:center;padding:48px 24px;background:#fafbfc;border:1px solid #dce3ed;border-radius:14px">' +
                '<i class="fa-regular fa-folder-open" style="font-size:28px;color:#9ab0c6;display:block;margin-bottom:10px"></i>' +
                '<p style="font-size:13.5px;color:#6b84a0;font-weight:500">No evaluations on record for this teacher.</p></div>';
            return;
        }

        document.getElementById('evalPanelBody').innerHTML = evals.map((e) => {
            const stars = [1,2,3,4,5].map(n => `<span style="color:${n<=(e.overallRating||0)?'#f59e0b':'#dce3ed'};font-size:14px">★</span>`).join('');
            const dateStr = e.date ? new Date(e.date).toLocaleDateString('en-US', { month:'long', day:'numeric', year:'numeric' }) : '—';
            
            const recColor = e.recommendedAction === 'Commendation' ? 'color:#0ea871;background:#edfaf4;border-color:#c6f0db'
                           : e.recommendedAction === 'Formal Warning' || e.recommendedAction === 'Performance Plan' ? 'color:#e31b4a;background:#fff0f3;border-color:#ffd6de'
                           : e.recommendedAction === 'Professional Development' ? 'color:#b45309;background:#fffbeb;border-color:#fef3c7'
                           : 'color:#6b84a0;background:#f4f7fb;border-color:#dce3ed';

            return `
            <div class="bg-white border border-[#dce3ed] rounded-xl overflow-hidden mb-4 shadow-sm">
                <div class="px-5 py-4 cursor-pointer hover:bg-[#f8fafb] transition flex items-center justify-between" onclick="window.toggleEvalAccordion(this)">
                    <div>
                        <p class="font-black text-[14px] text-[#0d1f35]">${escHtml(e.type)}</p>
                        <p class="text-[11px] font-semibold text-[#6b84a0] mt-0.5">${dateStr} · Evaluated by ${escHtml(e.evaluatorName || 'Admin')}</p>
                    </div>
                    <div class="flex items-center gap-5 text-right">
                        <div class="text-[16px] leading-none flex gap-0.5">${stars}</div>
                        <i class="fa-solid fa-chevron-down text-[#c5d0db] transition-transform duration-200"></i>
                    </div>
                </div>
                
                <div class="eval-body bg-[#fafbfc] border-t border-[#f0f4f8] p-6 hidden">
                    
                    <div class="flex justify-end mb-4 border-b border-[#f0f4f8] pb-4">
                        <button onclick="window.printSingleEvaluation('${teacherId}', '${e.id}')" class="flex items-center gap-2 bg-white hover:bg-[#f4f7fb] text-[#374f6b] font-bold px-3 py-1.5 rounded-[var(--r-md)] text-[11px] transition shadow-sm border border-[#dce3ed]">
                            <i class="fa-solid fa-print"></i> Print Official Record
                        </button>
                    </div>

                    ${e.subjectObserved || e.studentFocus ? `
                        <div class="flex flex-wrap gap-2 mb-5">
                            ${e.subjectObserved ? `<span class="text-[10px] font-bold text-[#2563eb] bg-[#eef4ff] px-2.5 py-1 rounded border border-[#c7d9fd]">Subject: ${escHtml(e.subjectObserved)}</span>` : ''}
                            ${e.studentFocus ? `<span class="text-[10px] font-bold text-[#6b84a0] bg-[#f0f4f8] px-2.5 py-1 rounded border border-[#dce3ed]">Focus: ${escHtml(e.studentFocus)}</span>` : ''}
                        </div>
                    ` : ''}

                    <div class="grid grid-cols-2 md:grid-cols-4 gap-4 mb-6">
                        <div class="bg-white border border-[#dce3ed] rounded-lg p-3 text-center shadow-sm">
                            <p class="text-[9px] font-bold text-[#6b84a0] uppercase tracking-widest mb-1">Classroom Mgmt</p>
                            <p class="text-[16px] font-black text-[#0d1f35]">${e.classroomManagement ? e.classroomManagement + '/5' : 'N/A'}</p>
                        </div>
                        <div class="bg-white border border-[#dce3ed] rounded-lg p-3 text-center shadow-sm">
                            <p class="text-[9px] font-bold text-[#6b84a0] uppercase tracking-widest mb-1">Curriculum Delivery</p>
                            <p class="text-[16px] font-black text-[#0d1f35]">${e.curriculumDelivery ? e.curriculumDelivery + '/5' : 'N/A'}</p>
                        </div>
                        <div class="bg-white border border-[#dce3ed] rounded-lg p-3 text-center shadow-sm">
                            <p class="text-[9px] font-bold text-[#6b84a0] uppercase tracking-widest mb-1">Student Engagement</p>
                            <p class="text-[16px] font-black text-[#0d1f35]">${e.studentEngagement ? e.studentEngagement + '/5' : 'N/A'}</p>
                        </div>
                        <div class="bg-white border border-[#dce3ed] rounded-lg p-3 text-center shadow-sm">
                            <p class="text-[9px] font-bold text-[#6b84a0] uppercase tracking-widest mb-1">Professional Conduct</p>
                            <p class="text-[16px] font-black text-[#0d1f35]">${e.professionalConduct ? e.professionalConduct + '/5' : 'N/A'}</p>
                        </div>
                    </div>

                    <div class="space-y-4">
                        ${e.strengths ? `
                            <div class="bg-[#edfaf4] border border-[#c6f0db] rounded-lg p-4">
                                <p class="text-[10px] font-bold text-[#0ea871] uppercase tracking-widest mb-1.5"><i class="fa-solid fa-arrow-trend-up mr-1"></i> Key Strengths</p>
                                <p class="text-[12px] text-[#065f46] font-medium leading-relaxed">${escHtml(e.strengths)}</p>
                            </div>
                        ` : ''}
                        ${e.areasForImprovement ? `
                            <div class="bg-[#fff0f3] border border-[#ffd6de] rounded-lg p-4">
                                <p class="text-[10px] font-bold text-[#e31b4a] uppercase tracking-widest mb-1.5"><i class="fa-solid fa-triangle-exclamation mr-1"></i> Areas for Improvement</p>
                                <p class="text-[12px] text-[#9f1239] font-medium leading-relaxed">${escHtml(e.areasForImprovement)}</p>
                            </div>
                        ` : ''}
                        ${e.comments ? `
                            <div class="bg-white border border-[#dce3ed] rounded-lg p-4 shadow-sm">
                                <p class="text-[10px] font-bold text-[#6b84a0] uppercase tracking-widest mb-1.5"><i class="fa-regular fa-comment-dots mr-1"></i> Evaluator Comments</p>
                                <p class="text-[12px] text-[#374f6b] font-medium leading-relaxed">${escHtml(e.comments)}</p>
                            </div>
                        ` : ''}
                    </div>
                    
                    ${e.recommendedAction && e.recommendedAction !== 'None' ? `
                        <div class="mt-5 flex items-center justify-between border-t border-[#dce3ed] pt-4">
                            <span class="text-[10px] font-bold uppercase tracking-widest text-[#6b84a0]">Recommended Action</span>
                            <span style="font-size:11px;font-weight:700;padding:4px 12px;border-radius:99px;border:1px solid;${recColor}">${e.recommendedAction}</span>
                        </div>
                    ` : ''}
                </div>
            </div>`;
        }).join('');

    } catch (err) {
        console.error('[Evaluations] openEvalPanel:', err);
        document.getElementById('evalPanelBody').innerHTML =
            '<p style="color:#e31b4a;font-weight:600;padding:16px">Error loading evaluations.</p>';
    }
};

window.toggleEvalAccordion = (header) => {
    const body    = header.nextElementSibling;
    const chevron = header.querySelector('.fa-chevron-down');
    body.classList.toggle('hidden');
    if (chevron) chevron.style.transform = body.classList.contains('hidden') ? 'rotate(0deg)' : 'rotate(180deg)';
};

window.closeEvalPanel = () => closeOverlay('evalHistoryPanel', 'evalHistoryPanelInner', true);

// ── 7. NEW EVAL MODAL ─────────────────────────────────────────────────────
window.openNewEvalModal = function(preselectedTeacherId = null) {
    evalRatings = { overallRating: 0, classroomManagement: 0, curriculumDelivery: 0, studentEngagement: 0, professionalConduct: 0 };
    document.getElementById('evalDate').value         = new Date().toISOString().split('T')[0];
    document.getElementById('evalStrengths').value    = '';
    document.getElementById('evalImprovements').value = '';
    document.getElementById('evalComments').value     = '';
    document.getElementById('evalAction').value       = 'None';
    document.getElementById('evalSubject').value      = '';
    document.getElementById('evalStudentFocus').value = '';
    document.getElementById('evalMsg').classList.add('hidden');
    
    // Build Dynamic Dropdown
    const standardTypes = ["Classroom Observation", "Term Review", "Peer Review"];
    const allTypes = new Set([...standardTypes, ...Array.from(dynamicEvalTypes)]);
    
    let optionsHtml = `<option value="">— Select Type —</option>`;
    allTypes.forEach(t => {
        optionsHtml += `<option value="${escHtml(t)}">${escHtml(t)}</option>`;
    });
    optionsHtml += `<option value="Custom">Custom (Type below)...</option>`;
    
    const typeSelect = document.getElementById('evalType');
    typeSelect.innerHTML = optionsHtml;
    typeSelect.value = '';
    window.toggleEvalTypeFields();

    if (preselectedTeacherId) {
        document.getElementById('evalTeacherId').value = preselectedTeacherId;
    } else {
        document.getElementById('evalTeacherId').value = '';
    }

    buildStarGroups();
    openOverlay('newEvalModal', 'newEvalModalInner');
};

window.toggleEvalTypeFields = function() {
    const type = document.getElementById('evalType').value;
    
    // Toggle Custom Input
    const customContainer = document.getElementById('customEvalTypeContainer');
    if (type === 'Custom') {
        customContainer.classList.remove('hidden');
    } else {
        customContainer.classList.add('hidden');
        document.getElementById('customEvalType').value = '';
    }

    // Toggle Optional Observation Fields
    const obsContainer = document.getElementById('observationFieldsContainer');
    if (type === 'Classroom Observation') {
        obsContainer.classList.remove('hidden');
    } else {
        obsContainer.classList.add('hidden');
        document.getElementById('evalSubject').value = '';
        document.getElementById('evalStudentFocus').value = '';
    }
};

window.closeNewEvalModal = () => closeOverlay('newEvalModal', 'newEvalModalInner');

// ── 8. SUBMIT EVALUATION ──────────────────────────────────────────────────
document.getElementById('submitEvalBtn').addEventListener('click', async () => {
    const teacherId = document.getElementById('evalTeacherId').value;
    const date      = document.getElementById('evalDate').value;
    let type        = document.getElementById('evalType').value;
    
    if (type === 'Custom') {
        type = document.getElementById('customEvalType').value.trim();
    }

    const msg = document.getElementById('evalMsg');
    msg.classList.add('hidden');

    if (!teacherId)                  { showEvalMsg('Please select a teacher.'); return; }
    if (!type)                       { showEvalMsg('Please select or enter an evaluation type.'); return; }
    if (!date)                       { showEvalMsg('Please select a date.'); return; }
    if (!evalRatings.overallRating)  { showEvalMsg('Please set an Overall Performance rating.'); return; }

    const teacher = allTeachers.find(t => t.id === teacherId);
    const evaluatorName = session.isSuperAdmin
        ? (session.schoolName || 'Super Admin')
        : (session.adminName  || 'Sub-Admin');

    const btn = document.getElementById('submitEvalBtn');
    btn.disabled  = true;
    btn.innerHTML = '<i class="fa-solid fa-spinner fa-spin mr-2"></i>Submitting...';

    try {
        await addDoc(collection(db, 'teachers', teacherId, 'evaluations'), {
            schoolId:             session.schoolId,
            teacherId,
            teacherName:          teacher?.name || '',
            evaluatorId:          session.adminId || session.schoolId,
            evaluatorName,
            type,
            date,
            overallRating:        evalRatings.overallRating,
            classroomManagement:  evalRatings.classroomManagement  || null,
            curriculumDelivery:   evalRatings.curriculumDelivery   || null,
            studentEngagement:    evalRatings.studentEngagement    || null,
            professionalConduct:  evalRatings.professionalConduct  || null,
            subjectObserved:      document.getElementById('evalSubject').value.trim(),
            studentFocus:         document.getElementById('evalStudentFocus').value.trim(),
            strengths:            document.getElementById('evalStrengths').value.trim(),
            areasForImprovement:  document.getElementById('evalImprovements').value.trim(),
            comments:             document.getElementById('evalComments').value.trim(),
            recommendedAction:    document.getElementById('evalAction').value,
            timestamp:            new Date().toISOString()
        });

        window.closeNewEvalModal();
        
        // Check if we need to refresh the open panel
        if (window.currentPanelTeacherId === teacherId && !document.getElementById('evalHistoryPanel').classList.contains('hidden')) {
            window.openEvalPanel(teacherId, teacher.name);
        }

        loadPage(); // Refresh table and caches
    } catch (e) {
        console.error('[Evaluations] submit:', e);
        showEvalMsg('System error. Please try again.');
    }

    btn.disabled  = false;
    btn.innerHTML = '<i class="fa-solid fa-file-circle-check mr-2"></i>Submit Evaluation';
});

function showEvalMsg(msg) {
    const el       = document.getElementById('evalMsg');
    el.textContent = msg;
    el.classList.remove('hidden');
}


// ── 9. PRINT FORMAL EVALUATION ────────────────────────────────────────────
window.printSingleEvaluation = function(teacherId, evalId) {
    const evals = evalMapCache[teacherId] || [];
    const e = evals.find(x => x.id === evalId);
    const t = allTeachers.find(x => x.id === teacherId);
    
    if (!e || !t) {
        alert("Could not load the evaluation data for printing.");
        return;
    }

    const schoolName = session.schoolName || session.schoolId || 'ConnectUs School';
    const dateStr = e.date ? new Date(e.date).toLocaleDateString('en-US', { month:'long', day:'numeric', year:'numeric' }) : '—';
    
    const html = `<!DOCTYPE html>
    <html>
    <head>
        <title>Official Evaluation - ${escHtml(t.name)}</title>
        <style>
            * { box-sizing: border-box; margin: 0; padding: 0; }
            body { font-family: 'Helvetica Neue', Arial, sans-serif; padding: 48px 40px; color: #1e293b; line-height: 1.6; font-size: 13px; }
            .header { text-align: center; margin-bottom: 30px; border-bottom: 3px solid #0d1f35; padding-bottom: 20px; }
            .header img { max-height: 70px; margin-bottom: 15px; }
            .header h1 { font-size: 22px; font-weight: 900; color: #0d1f35; text-transform: uppercase; letter-spacing: 0.1em; margin-bottom: 5px; }
            .header h2 { font-size: 14px; font-weight: 700; color: #64748b; text-transform: uppercase; letter-spacing: 0.05em; margin: 0; }
            
            .meta-grid { display: grid; grid-template-columns: 1fr 1fr; gap: 15px; margin-bottom: 30px; background: #f8fafc; padding: 20px; border-radius: 8px; border: 1px solid #e2e8f0; }
            .meta-item label { display: block; font-size: 9px; text-transform: uppercase; letter-spacing: 0.1em; color: #64748b; font-weight: bold; margin-bottom: 3px; }
            .meta-item span { font-size: 13px; font-weight: bold; color: #0f172a; }

            .section-title { font-size: 12px; font-weight: 900; color: #0d1f35; border-bottom: 2px solid #e2e8f0; padding-bottom: 8px; margin: 24px 0 16px; text-transform: uppercase; letter-spacing: 0.05em; }
            
            .rubric-table { width: 100%; border-collapse: collapse; margin-bottom: 30px; }
            .rubric-table th { background: #f1f5f9; padding: 12px; text-align: left; font-size: 10px; text-transform: uppercase; letter-spacing: 0.1em; color: #64748b; border: 1px solid #e2e8f0; }
            .rubric-table td { padding: 12px; border: 1px solid #e2e8f0; font-size: 13px; font-weight: bold; color: #0f172a; }
            .rubric-table .score { text-align: center; width: 80px; font-size: 14px; }
            
            .feedback-block { margin-bottom: 20px; }
            .feedback-block h4 { font-size: 11px; text-transform: uppercase; letter-spacing: 0.08em; font-weight: bold; color: #64748b; margin-bottom: 6px; }
            .feedback-block p { background: #fff; border: 1px solid #e2e8f0; padding: 16px; border-radius: 6px; color: #334155; white-space: pre-wrap; }

            .action-box { display: inline-block; padding: 8px 16px; background: #f1f5f9; border: 1px solid #cbd5e1; border-radius: 6px; font-weight: bold; font-size: 12px; color: #0f172a; margin-bottom: 40px; }

            .signatures { display: grid; grid-template-columns: 1fr 1fr; gap: 40px; margin-top: 60px; }
            .sig-line { border-top: 1px solid #94a3b8; padding-top: 8px; }
            .sig-line p { font-size: 10px; font-weight: bold; text-transform: uppercase; letter-spacing: 0.05em; color: #64748b; margin-bottom: 2px; }
            .sig-line span { font-size: 12px; color: #0f172a; }
        </style>
    </head>
    <body>
        <div class="header">
            <img src="../../assets/images/logo.png" onerror="this.style.display='none'">
            <h1>Official Educator Evaluation</h1>
            <h2>${escHtml(schoolName)}</h2>
        </div>

        <div class="meta-grid">
            <div class="meta-item"><label>Educator Name</label><span>${escHtml(t.name)}</span></div>
            <div class="meta-item"><label>Global Teacher ID</label><span style="font-family: monospace;">${escHtml(t.id)}</span></div>
            <div class="meta-item"><label>Evaluation Date</label><span>${dateStr}</span></div>
            <div class="meta-item"><label>Evaluation Type</label><span>${escHtml(e.type)}</span></div>
            <div class="meta-item"><label>Evaluator Name</label><span>${escHtml(e.evaluatorName || 'Administrator')}</span></div>
            <div class="meta-item"><label>Subject Focus</label><span>${e.subjectObserved ? escHtml(e.subjectObserved) : 'N/A'}</span></div>
        </div>

        <div class="section-title">Performance Rubric</div>
        <table class="rubric-table">
            <thead>
                <tr>
                    <th>Performance Category</th>
                    <th class="score">Rating (1-5)</th>
                </tr>
            </thead>
            <tbody>
                <tr>
                    <td>Overall Performance</td>
                    <td class="score" style="color: #2563eb;">${e.overallRating || e.performanceScore || 'N/A'}</td>
                </tr>
                <tr>
                    <td>Classroom Management</td>
                    <td class="score">${e.classroomManagement || 'N/A'}</td>
                </tr>
                <tr>
                    <td>Curriculum Delivery</td>
                    <td class="score">${e.curriculumDelivery || 'N/A'}</td>
                </tr>
                <tr>
                    <td>Student Engagement</td>
                    <td class="score">${e.studentEngagement || 'N/A'}</td>
                </tr>
                <tr>
                    <td>Professional Conduct</td>
                    <td class="score">${e.professionalConduct || 'N/A'}</td>
                </tr>
            </tbody>
        </table>

        <div class="section-title">Qualitative Feedback</div>
        ${e.strengths ? `
        <div class="feedback-block">
            <h4>Key Strengths</h4>
            <p>${escHtml(e.strengths)}</p>
        </div>` : ''}
        ${e.areasForImprovement ? `
        <div class="feedback-block">
            <h4>Areas for Improvement</h4>
            <p>${escHtml(e.areasForImprovement)}</p>
        </div>` : ''}
        ${e.comments ? `
        <div class="feedback-block">
            <h4>Evaluator Comments</h4>
            <p>${escHtml(e.comments)}</p>
        </div>` : ''}

        <div class="section-title">Administrative Action</div>
        <div class="action-box">
            Recommended Action: ${e.recommendedAction && e.recommendedAction !== 'None' ? escHtml(e.recommendedAction) : 'None / Continue as standard'}
        </div>

        <div class="signatures">
            <div class="sig-line">
                <p>Evaluator Signature</p>
                <span>${escHtml(e.evaluatorName || 'Administrator')}</span>
            </div>
            <div class="sig-line">
                <p>Educator Signature</p>
                <span>${escHtml(t.name)}</span>
            </div>
        </div>
        
        <div style="margin-top: 40px; text-align: center; font-size: 10px; color: #94a3b8; border-top: 1px solid #e2e8f0; padding-top: 14px;">
            This document serves as an official performance record within the ConnectUs National Registry.
        </div>
    </body>
    </html>`;

    const w = window.open('', '_blank');
    w.document.open();
    w.document.write(html);
    w.document.close();
    setTimeout(() => w.print(), 500);
};

// ── INIT ──────────────────────────────────────────────────────────────────
document.addEventListener('DOMContentLoaded', loadPage);
