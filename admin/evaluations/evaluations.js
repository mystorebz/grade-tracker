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
    document.querySelectorAll(`button[data-field="${field}"]`).forEach(btn => {
        btn.style.color = parseInt(btn.dataset.val) <= val ? '#f59e0b' : '#dce3ed';
    });
};

window.hoverStars = function(field, val) {
    document.querySelectorAll(`button[data-field="${field}"]`).forEach(btn => {
        btn.style.color = parseInt(btn.dataset.val) <= val ? '#f59e0b' : '#dce3ed';
    });
};

window.setRating = function(field, val) {
    evalRatings[field] = val;
    renderStars(field);
};

// ── 4. LOAD DATA ──────────────────────────────────────────────────────────
async function loadPage() {
    try {
        const snap = await getDocs(query(collection(db, 'teachers'), where('currentSchoolId', '==', session.schoolId)));
        allTeachers = snap.docs.map(d => ({ id: d.id, ...d.data() })).sort((a, b) => (a.name || '').localeCompare(b.name || ''));

        const sel = document.getElementById('evalTeacherId');
        sel.innerHTML = '<option value="">Select teacher...</option>' +
            allTeachers.map(t => `<option value="${t.id}">${escHtml(t.name)}</option>`).join('');

        const evalPromises = allTeachers.map(async t => {
            const eSnap = await getDocs(query(collection(db, 'teachers', t.id, 'evaluations'), where('schoolId', '==', session.schoolId)));
            return { teacherId: t.id, evals: eSnap.docs.map(d => ({ id: d.id, ...d.data() })) };
        });

        const allEvals = await Promise.all(evalPromises);
        evalMapCache = {};
        dynamicEvalTypes.clear();
        allEvals.forEach(e => { 
            evalMapCache[e.teacherId] = e.evals; 
            e.evals.forEach(ev => { if (ev.type) dynamicEvalTypes.add(ev.type); });
        });

        renderTable(evalMapCache);
        renderSummaryCards(evalMapCache);
    } catch (e) { console.error(e); }
}

function renderTable(evalMap, filter = '') {
    const tbody = document.getElementById('evalTableBody');
    const teachers = filter ? allTeachers.filter(t => t.name.toLowerCase().includes(filter.toLowerCase())) : allTeachers;

    tbody.innerHTML = teachers.map(t => {
        const evals = evalMap[t.id] || [];
        const count = evals.length;
        const avg = count ? (evals.reduce((s, e) => s + (e.overallRating || 0), 0) / count).toFixed(1) : null;
        const last = count ? evals.sort((a, b) => new Date(b.date || b.timestamp) - new Date(a.date || a.timestamp))[0] : null;
        const lastStr = last ? new Date(last.date || last.timestamp).toLocaleDateString() : '—';
        const rec = last?.recommendedAction && last.recommendedAction !== 'None' ? last.recommendedAction : '—';

        return `<tr class="hover:bg-[#f8fafb] transition">
            <td class="px-6 py-4"><p class="font-bold text-[#0d1f35]">${escHtml(t.name)}</p></td>
            <td class="px-6 py-4 text-center font-bold">${count}</td>
            <td class="px-6 py-4 text-center">${avg ? avg + ' ★' : '—'}</td>
            <td class="px-6 py-4 text-center">${lastStr}</td>
            <td class="px-6 py-4 text-center"><span class="text-[11px] font-bold px-3 py-1 rounded-full border">${rec}</span></td>
            <td class="px-6 py-4 text-right"><button onclick="window.openEvalPanel('${t.id}','${escHtml(t.name)}')" class="bg-white border px-3 py-1 rounded text-[11px] font-bold">View</button></td>
        </tr>`;
    }).join('');
}

function renderSummaryCards(evalMap) {
    const allEvalsList = Object.values(evalMap).flat();
    const total = allEvalsList.length;
    const avgAll = total ? (allEvalsList.reduce((s, e) => s + (e.overallRating || 0), 0) / total).toFixed(1) : '—';
    document.getElementById('summaryCards').innerHTML = `
        <div class="bg-white border rounded-xl p-5 shadow-sm">
            <p class="text-[22px] font-bold">${total}</p><p class="text-[11px] text-[#6b84a0] uppercase font-bold">Total Evaluations</p>
        </div>
        <div class="bg-white border rounded-xl p-5 shadow-sm">
            <p class="text-[22px] font-bold">${avgAll}</p><p class="text-[11px] text-[#6b84a0] uppercase font-bold">Average Teacher Rating</p>
        </div>
        <div class="bg-white border rounded-xl p-5 shadow-sm">
            <p class="text-[22px] font-bold">${Object.values(evalMap).filter(e => e.length > 0).length} / ${allTeachers.length}</p><p class="text-[11px] text-[#6b84a0] uppercase font-bold">Teachers Evaluated</p>
        </div>`;
}

window.filterEvalTable = (val) => renderTable(evalMapCache, val);

// ── 6. EVAL HISTORY PANEL ─────────────────────────────────────────────────
window.openEvalPanel = async function(teacherId, teacherName) {
    window.currentPanelTeacherId = teacherId;
    document.getElementById('evalPanelName').textContent = teacherName;
    document.getElementById('evalPanelBody').innerHTML = '<div class="flex justify-center py-10"><i class="fa-solid fa-spinner fa-spin text-2xl text-[#2563eb]"></i></div>';
    openOverlay('evalHistoryPanel', 'evalHistoryPanelInner', true);

    try {
        const evals = (evalMapCache[teacherId] || []).sort((a, b) => new Date(b.date || b.timestamp) - new Date(a.date || a.timestamp));
        document.getElementById('evalPanelBody').innerHTML = evals.map((e) => {
            const stars = [1,2,3,4,5].map(n => `<span style="color:${n<=(e.overallRating||0)?'#f59e0b':'#dce3ed'}">★</span>`).join('');
            return `
            <div class="bg-white border border-[#dce3ed] rounded-xl overflow-hidden mb-4 shadow-sm">
                <div class="px-5 py-4 cursor-pointer hover:bg-[#f8fafb] transition flex items-center justify-between" onclick="window.toggleEvalAccordion(this)">
                    <div><p class="font-black text-[14px] text-[#0d1f35]">${escHtml(e.type)}</p><p class="text-[11px] font-semibold text-[#6b84a0]">${e.date}</p></div>
                    <div class="flex items-center gap-5 text-[16px]">${stars} <i class="fa-solid fa-chevron-down text-[#c5d0db] transition-transform duration-200"></i></div>
                </div>
                <div class="eval-body bg-[#fafbfc] border-t border-[#f0f4f8] p-6 hidden">
                    <div class="flex justify-end mb-4 border-b pb-4">
                        <button onclick="window.printSingleEvaluation('${teacherId}', '${e.id}')" class="bg-white border px-3 py-1.5 rounded text-[11px] font-bold shadow-sm">Print Official Record</button>
                    </div>
                    <div class="grid grid-cols-2 md:grid-cols-4 gap-4 mb-6">
                        ${['classroomManagement','curriculumDelivery','studentEngagement','professionalConduct'].map(key => `
                            <div class="bg-white border rounded-lg p-3 text-center shadow-sm">
                                <p class="text-[9px] font-bold text-[#6b84a0] uppercase tracking-widest mb-1">${key.replace(/([A-Z])/g, ' $1')}</p>
                                <p class="text-[16px] font-black">${e[key] || 'N/A'}/5</p>
                            </div>`).join('')}
                    </div>
                    <div class="space-y-4">
                        ${e.strengths ? `<div class="bg-[#edfaf4] p-4 rounded-lg"><p class="text-[10px] font-bold text-[#0ea871] uppercase mb-1">Key Strengths</p><p class="text-[12px]">${escHtml(e.strengths)}</p></div>` : ''}
                        ${e.areasForImprovement ? `<div class="bg-[#fff0f3] p-4 rounded-lg"><p class="text-[10px] font-bold text-[#e31b4a] uppercase mb-1">Improvement Needed</p><p class="text-[12px]">${escHtml(e.areasForImprovement)}</p></div>` : ''}
                        ${e.comments ? `<div class="bg-white border p-4 rounded-lg"><p class="text-[10px] font-bold text-[#6b84a0] uppercase mb-1">Evaluator Comments</p><p class="text-[12px]">${escHtml(e.comments)}</p></div>` : ''}
                    </div>
                    ${e.recommendedAction && e.recommendedAction !== 'None' ? `
                        <div class="mt-5 border-t pt-4">
                            <p class="text-[10px] font-bold uppercase text-[#6b84a0]">Recommended Action: <span class="text-[#0d1f35]">${escHtml(e.recommendedAction)}</span></p>
                            ${e.actionNote ? `<p class="text-[12px] italic text-[#374f6b] mt-2 bg-white p-3 border rounded">Note: ${escHtml(e.actionNote)}</p>` : ''}
                        </div>` : ''}
                </div>
            </div>`;
        }).join('');
    } catch (err) { console.error(err); }
};

window.toggleEvalAccordion = (header) => {
    const body = header.nextElementSibling;
    const chevron = header.querySelector('.fa-chevron-down');
    body.classList.toggle('hidden');
    if (chevron) chevron.classList.toggle('rotate-180');
};

window.closeEvalPanel = () => closeOverlay('evalHistoryPanel', 'evalHistoryPanelInner', true);

// ── 7. NEW EVAL MODAL ─────────────────────────────────────────────────────
window.openNewEvalModal = function(preselectedId = null) {
    evalRatings = { overallRating: 0, classroomManagement: 0, curriculumDelivery: 0, studentEngagement: 0, professionalConduct: 0 };
    ['evalStrengths','evalImprovements','evalComments','evalSubject','evalStudentFocus','evalActionNote'].forEach(id => document.getElementById(id).value = '');
    document.getElementById('evalDate').value = new Date().toISOString().split('T')[0];
    document.getElementById('evalAction').value = 'None';
    
    const standardTypes = ["Classroom Observation", "Term Review", "Peer Review"];
    const allTypes = new Set([...standardTypes, ...Array.from(dynamicEvalTypes)]);
    let opts = `<option value="">— Select Type —</option>`;
    allTypes.forEach(t => opts += `<option value="${escHtml(t)}">${escHtml(t)}</option>`);
    opts += `<option value="Custom">Custom (Type below)...</option>`;
    
    document.getElementById('evalType').innerHTML = opts;
    if (preselectedId) document.getElementById('evalTeacherId').value = preselectedId;
    
    window.toggleEvalTypeFields();
    buildStarGroups();
    openOverlay('newEvalModal', 'newEvalModalInner');
};

window.toggleEvalTypeFields = () => {
    const type = document.getElementById('evalType').value;
    document.getElementById('customEvalTypeContainer').classList.toggle('hidden', type !== 'Custom');
    document.getElementById('observationFieldsContainer').classList.toggle('hidden', type !== 'Classroom Observation');
};

window.closeNewEvalModal = () => closeOverlay('newEvalModal', 'newEvalModalInner');

// ── 8. SUBMIT EVALUATION ──────────────────────────────────────────────────
document.getElementById('submitEvalBtn').addEventListener('click', async () => {
    const teacherId = document.getElementById('evalTeacherId').value;
    const date = document.getElementById('evalDate').value;
    let type = document.getElementById('evalType').value;
    if (type === 'Custom') type = document.getElementById('customEvalType').value.trim();

    // STRICT VALIDATION: Check all 5 mandatory ratings
    const missingRating = Object.values(evalRatings).some(v => v === 0);
    if (!teacherId || !type || !date || missingRating) {
        showEvalMsg('Please select a teacher, type, date, AND complete all 5 performance ratings.');
        return;
    }

    const btn = document.getElementById('submitEvalBtn');
    btn.disabled = true; btn.innerHTML = '<i class="fa-solid fa-spinner fa-spin mr-2"></i>Submitting...';

    try {
        await addDoc(collection(db, 'teachers', teacherId, 'evaluations'), {
            schoolId: session.schoolId,
            teacherId,
            evaluatorName: session.adminName || session.schoolName || 'Admin',
            type, date,
            ...evalRatings,
            subjectObserved: document.getElementById('evalSubject').value.trim(),
            studentFocus: document.getElementById('evalStudentFocus').value.trim(),
            strengths: document.getElementById('evalStrengths').value.trim(),
            areasForImprovement: document.getElementById('evalImprovements').value.trim(),
            comments: document.getElementById('evalComments').value.trim(),
            recommendedAction: document.getElementById('evalAction').value,
            actionNote: document.getElementById('evalActionNote').value.trim(),
            timestamp: new Date().toISOString()
        });
        window.closeNewEvalModal();
        loadPage();
    } catch (e) { console.error(e); showEvalMsg('System error. Try again.'); }
    btn.disabled = false; btn.innerHTML = 'Submit Evaluation';
});

function showEvalMsg(msg) {
    const el = document.getElementById('evalMsg');
    el.textContent = msg; el.classList.remove('hidden');
}

// ── 9. PRINT FORMAL EVALUATION ────────────────────────────────────────────
window.printSingleEvaluation = function(teacherId, evalId) {
    const e = (evalMapCache[teacherId] || []).find(x => x.id === evalId);
    const t = allTeachers.find(x => x.id === teacherId);
    const schoolName = session.schoolName || session.schoolId || 'ConnectUs School';
    
    const html = `<!DOCTYPE html><html><head><title>Evaluation - ${escHtml(t.name)}</title>
        <style>
            body { font-family: 'Helvetica Neue', Arial, sans-serif; padding: 48px 40px; line-height: 1.6; font-size: 13px; }
            .header { text-align: center; margin-bottom: 30px; border-bottom: 3px solid #0d1f35; padding-bottom: 20px; }
            .header img { max-height: 70px; margin-bottom: 15px; }
            .meta-grid { display: grid; grid-template-columns: 1fr 1fr; gap: 15px; margin-bottom: 30px; background: #f8fafc; padding: 20px; border-radius: 8px; border: 1px solid #e2e8f0; }
            .section-title { font-size: 12px; font-weight: 900; border-bottom: 2px solid #e2e8f0; padding-bottom: 8px; margin: 24px 0 16px; text-transform: uppercase; }
            .rubric-table { width: 100%; border-collapse: collapse; margin-bottom: 30px; }
            .rubric-table th { background: #f1f5f9; padding: 12px; font-size: 10px; border: 1px solid #e2e8f0; text-align:left; }
            .rubric-table td { padding: 12px; border: 1px solid #e2e8f0; font-weight: bold; }
            .feedback-block { margin-bottom: 20px; }
            .feedback-block h4 { font-size: 10px; text-transform: uppercase; color: #64748b; margin-bottom: 5px; }
            .feedback-block p { border: 1px solid #e2e8f0; padding: 15px; border-radius: 6px; white-space: pre-wrap; }
            .signatures { display: grid; grid-template-columns: 1fr 1fr; gap: 40px; margin-top: 60px; }
            .sig-line { border-top: 1px solid #94a3b8; padding-top: 8px; font-size: 10px; font-weight: bold; }
        </style></head>
    <body>
        <div class="header">
            <img src="../../assets/images/logo.png" onerror="this.style.display='none'">
            <h1>Official Educator Evaluation</h1>
            <h2>${escHtml(schoolName)}</h2>
        </div>
        <div class="meta-grid">
            <div><label>Educator:</label> <b>${escHtml(t.name)}</b></div>
            <div><label>Date:</label> <b>${e.date}</b></div>
            <div><label>Type:</label> <b>${escHtml(e.type)}</b></div>
            <div><label>Evaluator:</label> <b>${escHtml(e.evaluatorName)}</b></div>
        </div>
        <div class="section-title">Performance Ratings</div>
        <table class="rubric-table">
            <thead><tr><th>Category</th><th>Score</th></tr></thead>
            <tbody>
                <tr><td>Overall Performance</td><td>${e.overallRating}/5</td></tr>
                <tr><td>Classroom Management</td><td>${e.classroomManagement}/5</td></tr>
                <tr><td>Curriculum Delivery</td><td>${e.curriculumDelivery}/5</td></tr>
                <tr><td>Student Engagement</td><td>${e.studentEngagement}/5</td></tr>
                <tr><td>Professional Conduct</td><td>${e.professionalConduct}/5</td></tr>
            </tbody>
        </table>
        <div class="section-title">Feedback & Notes</div>
        ${e.strengths ? `<div class="feedback-block"><h4>Strengths</h4><p>${escHtml(e.strengths)}</p></div>` : ''}
        ${e.areasForImprovement ? `<div class="feedback-block"><h4>Improvements</h4><p>${escHtml(e.areasForImprovement)}</p></div>` : ''}
        ${e.comments ? `<div class="feedback-block"><h4>General Comments</h4><p>${escHtml(e.comments)}</p></div>` : ''}
        <div class="section-title">Administrative Action</div>
        <p><b>Recommended Action:</b> ${escHtml(e.recommendedAction)}</p>
        ${e.actionNote ? `<p style="margin-top:10px; font-style:italic;">Note: ${escHtml(e.actionNote)}</p>` : ''}
        <div class="signatures">
            <div class="sig-line">Evaluator Signature</div>
            <div class="sig-line">Educator Signature</div>
        </div>
    </body></html>`;

    const w = window.open('', '_blank');
    w.document.write(html);
    w.document.close();
    setTimeout(() => w.print(), 500);
};

document.addEventListener('DOMContentLoaded', loadPage);
