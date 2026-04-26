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
        { label: 'School Avg Rating', value: avgAll, icon: 'fa-star', color: '#f59e0b', bg: '#fffbeb' },
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

        document.getElementById('evalPanelBody').innerHTML = evals.map((e, index) => {
            const stars = [1,2,3,4,5].map(n => `<span style="color:${n<=(e.overallRating||0)?'#f59e0b':'#dce3ed'};font-size:14px">★</span>`).join('');
            const dateStr = e.date ? new Date(e.date).toLocaleDateString('en-US', { month:'long', day:'numeric', year:'numeric' }) : '—';
            
            const recColor = e.recommendedAction === 'Commendation' ? 'color:#0ea871;background:#edfaf4;border-color:#c6f0db'
                           : e.recommendedAction === 'Formal Warning' || e.recommendedAction === 'Performance Plan' ? 'color:#e31b4a;background:#fff0f3;border-color:#ffd6de'
                           : e.recommendedAction === 'Professional Development' ? 'color:#b45309;background:#fffbeb;border-color:#fef3c7'
                           : 'color:#6b84a0;background:#f4f7fb;border-color:#dce3ed';

            return `
            <div class="bg-white border border-[#dce3ed] rounded-xl overflow-hidden mb-3">
                <div class="px-5 py-4 cursor-pointer hover:bg-[#f8fafb] transition flex items-center justify-between" onclick="window.toggleEvalAccordion(this)">
                    <div>
                        <p class="font-black text-[13px] text-[#0d1f35]">${escHtml(e.type)}</p>
                        <p class="text-[10px] font-semibold text-[#9ab0c6] mt-0.5">${dateStr} · Evaluated by ${escHtml(e.evaluatorName || 'Admin')}</p>
                    </div>
                    <div class="flex items-center gap-4 text-right">
                        <div>
                            <div class="text-[15px] leading-none flex gap-0.5">${stars}</div>
                        </div>
                        <i class="fa-solid fa-chevron-down text-[#c5d0db] transition-transform ${index === 0 ? 'rotate-180' : ''}"></i>
                    </div>
                </div>
                <div class="eval-body ${index === 0 ? 'open' : ''} bg-[#fafbfc] border-t border-[#f0f4f8] p-5">
                    
                    ${e.subjectObserved || e.studentFocus ? `
                        <div class="flex flex-wrap gap-2 mb-4 bg-white border border-[#dce3ed] p-2.5 rounded-lg">
                            ${e.subjectObserved ? `<span class="text-[10px] font-bold text-[#2563eb] bg-[#eef4ff] px-2 py-1 rounded border border-[#c7d9fd]">Subject: ${escHtml(e.subjectObserved)}</span>` : ''}
                            ${e.studentFocus ? `<span class="text-[10px] font-bold text-[#6b84a0] bg-[#f0f4f8] px-2 py-1 rounded border border-[#dce3ed]">Student Focus: ${escHtml(e.studentFocus)}</span>` : ''}
                        </div>
                    ` : ''}

                    <div class="grid grid-cols-2 gap-4 mb-4">
                        ${e.strengths ? `<div>
                            <p class="text-[10px] font-bold text-[#0ea871] uppercase tracking-widest mb-1.5"><i class="fa-solid fa-arrow-trend-up mr-1"></i> Strengths</p>
                            <p class="text-[12px] text-[#374f6b] font-medium leading-relaxed">${escHtml(e.strengths)}</p>
                        </div>` : ''}
                        ${e.areasForImprovement ? `<div>
                            <p class="text-[10px] font-bold text-[#e31b4a] uppercase tracking-widest mb-1.5"><i class="fa-solid fa-triangle-exclamation mr-1"></i> Improvements</p>
                            <p class="text-[12px] text-[#374f6b] font-medium leading-relaxed">${escHtml(e.areasForImprovement)}</p>
                        </div>` : ''}
                    </div>

                    ${e.comments ? `
                        <div class="mb-4 border-t border-[#dce3ed] pt-4">
                            <p class="text-[10px] font-bold text-[#6b84a0] uppercase tracking-widest mb-1.5"><i class="fa-regular fa-comment-dots mr-1"></i> Overall Comments</p>
                            <p class="text-[12px] text-[#374f6b] font-medium leading-relaxed">${escHtml(e.comments)}</p>
                        </div>
                    ` : ''}
                    
                    ${e.recommendedAction && e.recommendedAction !== 'None' ? `
                        <div class="mt-4 flex items-center gap-2">
                            <span class="text-[10px] font-bold uppercase tracking-widest text-[#6b84a0]">Action:</span>
                            <span style="font-size:10.5px;font-weight:700;padding:3px 10px;border-radius:99px;border:1px solid;${recColor}">${e.recommendedAction}</span>
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
    body.classList.toggle('open');
    if (chevron) chevron.style.transform = body.classList.contains('open') ? 'rotate(180deg)' : 'rotate(0deg)';
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

// ── INIT ──────────────────────────────────────────────────────────────────
document.addEventListener('DOMContentLoaded', loadPage);
