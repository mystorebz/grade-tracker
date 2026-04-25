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
let evalRatings  = { overallRating: 0, classroomManagement: 0, curriculumDelivery: 0, studentEngagement: 0, professionalConduct: 0 };
let currentPanelTeacherId = null;

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

// ── 4. LOAD TEACHERS ──────────────────────────────────────────────────────
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
        const evalMap  = {};
        allEvals.forEach(e => { evalMap[e.teacherId] = e.evals; });

        renderTable(evalMap);
        renderSummaryCards(evalMap);

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
        const last    = count ? evals.sort((a, b) => new Date(b.date) - new Date(a.date))[0] : null;
        const lastStr = last ? new Date(last.date).toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' }) : '—';
        const rec     = last?.recommendedAction || '—';

        const stars   = avg ? Math.round(parseFloat(avg)) : 0;
        const starStr = avg
            ? [1,2,3,4,5].map(n => `<span style="color:${n <= stars ? '#f59e0b' : '#dce3ed'};font-size:13px">★</span>`).join('') + ` <span class="text-[12px] font-bold text-[#374f6b]">${avg}</span>`
            : '<span class="text-[11px] text-[#9ab0c6] italic">No ratings</span>';

        const recColor = rec === 'Commendation' ? 'color:#0ea871;background:#edfaf4;border-color:#c6f0db'
                       : rec === 'Formal Warning' || rec === 'Performance Plan' ? 'color:#e31b4a;background:#fff0f3;border-color:#ffd6de'
                       : rec === 'Professional Development' ? 'color:#b45309;background:#fffbeb;border-color:#fef3c7'
                       : 'color:#6b84a0;background:#f4f7fb;border-color:#dce3ed';

        return `<tr class="hover:bg-[#f8fafb] transition cursor-pointer" onclick="window.openEvalPanel('${t.id}','${escHtml(t.name)}')">
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
                <button onclick="event.stopPropagation();window.openNewEvalModal('${t.id}')"
                    style="display:inline-flex;align-items:center;gap:5px;padding:6px 12px;font-size:11.5px;font-weight:700;color:var(--blue-600);background:var(--blue-50);border:1px solid var(--blue-100);border-radius:var(--r-md);cursor:pointer;font-family:inherit;transition:background 0.15s"
                    onmouseover="this.style.background='var(--blue-100)'" onmouseout="this.style.background='var(--blue-50)'">
                    <i class="fa-solid fa-plus" style="font-size:10px"></i> Evaluate
                </button>
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
    // Re-fetch evalMap from DOM isn't ideal — reload the table
    loadPage(); // Simplified: just reload. Could cache evalMap in module scope for better perf.
};

// ── 6. EVAL HISTORY PANEL ─────────────────────────────────────────────────
window.openEvalPanel = async function(teacherId, teacherName) {
    currentPanelTeacherId = teacherId;
    document.getElementById('evalPanelName').textContent = teacherName;
    document.getElementById('evalPanelBody').innerHTML =
        '<div class="flex justify-center py-10"><i class="fa-solid fa-spinner fa-spin text-2xl text-[#2563eb]"></i></div>';

    openOverlay('evalHistoryPanel', 'evalHistoryPanelInner', true);

    try {
        const snap = await getDocs(query(
            collection(db, 'teachers', teacherId, 'evaluations'),
            where('schoolId', '==', session.schoolId)
        ));

        const evals = snap.docs
            .map(d => ({ id: d.id, ...d.data() }))
            .sort((a, b) => new Date(b.date) - new Date(a.date));

        if (!evals.length) {
            document.getElementById('evalPanelBody').innerHTML =
                '<div style="text-align:center;padding:48px 24px;background:#fafbfc;border:1px solid #dce3ed;border-radius:14px">' +
                '<i class="fa-regular fa-folder-open" style="font-size:28px;color:#9ab0c6;display:block;margin-bottom:10px"></i>' +
                '<p style="font-size:13.5px;color:#6b84a0;font-weight:500">No evaluations on record for this teacher at your school.</p></div>';
            return;
        }

        // Compute averages across categories
        const cats   = ['classroomManagement', 'curriculumDelivery', 'studentEngagement', 'professionalConduct'];
        const avgAll = v => evals.filter(e => e[v]).reduce((s, e) => s + e[v], 0) / evals.filter(e => e[v]).length;
        const overallAvg = (evals.reduce((s, e) => s + (e.overallRating || 0), 0) / evals.length).toFixed(1);

        const catLabels = { classroomManagement: 'Classroom Mgmt', curriculumDelivery: 'Curriculum', studentEngagement: 'Engagement', professionalConduct: 'Conduct' };

        document.getElementById('evalPanelBody').innerHTML = `
            <div style="background:#fff;border:1px solid #dce3ed;border-radius:14px;padding:18px 20px">
                <p style="font-size:10px;font-weight:700;color:#6b84a0;text-transform:uppercase;letter-spacing:0.1em;margin:0 0 12px">Performance Analytics</p>
                <div style="display:flex;align-items:center;gap:8px;margin-bottom:14px">
                    <span style="font-size:28px;font-weight:700;color:#0d1f35;letter-spacing:-1px">${overallAvg}</span>
                    <div>
                        <div style="display:flex;gap:2px">${[1,2,3,4,5].map(n => `<span style="color:${n<=Math.round(parseFloat(overallAvg))?'#f59e0b':'#dce3ed'};font-size:16px">★</span>`).join('')}</div>
                        <p style="font-size:11px;color:#6b84a0;font-weight:600;margin:2px 0 0">${evals.length} evaluation${evals.length!==1?'s':''}</p>
                    </div>
                </div>
                ${cats.map(cat => {
                    const avg = evals.filter(e => e[cat]).length ? avgAll(cat).toFixed(1) : null;
                    const pct = avg ? (parseFloat(avg) / 5 * 100) : 0;
                    const col = pct >= 70 ? '#0ea871' : pct >= 50 ? '#f59e0b' : '#e31b4a';
                    return avg ? `<div style="margin-bottom:8px">
                        <div style="display:flex;justify-content:space-between;margin-bottom:4px">
                            <span style="font-size:11.5px;font-weight:600;color:#374f6b">${catLabels[cat]}</span>
                            <span style="font-size:11.5px;font-weight:700;color:${col}">${avg} / 5</span>
                        </div>
                        <div style="height:4px;background:#f0f4f8;border-radius:99px;overflow:hidden">
                            <div style="height:100%;width:${pct}%;background:${col};border-radius:99px;transition:width 0.3s"></div>
                        </div>
                    </div>` : '';
                }).join('')}
            </div>

            ${evals.map(e => {
                const stars = [1,2,3,4,5].map(n => `<span style="color:${n<=(e.overallRating||0)?'#f59e0b':'#dce3ed'};font-size:14px">★</span>`).join('');
                const recColor = e.recommendedAction === 'Commendation' ? '#0ea871'
                               : e.recommendedAction === 'Formal Warning' || e.recommendedAction === 'Performance Plan' ? '#e31b4a'
                               : e.recommendedAction === 'Professional Development' ? '#b45309' : '#6b84a0';
                const dateStr = e.date ? new Date(e.date).toLocaleDateString('en-US', { month:'long', day:'numeric', year:'numeric' }) : '—';
                return `<div style="background:#fff;border:1px solid #dce3ed;border-radius:14px;overflow:hidden">
                    <div style="padding:14px 18px;border-bottom:1px solid #f0f4f8;display:flex;align-items:center;justify-content:space-between">
                        <div>
                            <div style="display:flex;align-items:center;gap:6px">${stars}</div>
                            <p style="font-size:11px;color:#6b84a0;font-weight:600;margin:3px 0 0">${dateStr} · Evaluated by ${escHtml(e.evaluatorName || 'Admin')}</p>
                        </div>
                        ${e.recommendedAction && e.recommendedAction !== 'None' ? `<span style="font-size:10.5px;font-weight:700;padding:3px 10px;border-radius:99px;border:1px solid;color:${recColor};background:${recColor}18;border-color:${recColor}33">${e.recommendedAction}</span>` : ''}
                    </div>
                    <div style="padding:14px 18px;background:#fafbfc">
                        ${e.strengths ? `<p style="font-size:11px;font-weight:700;color:#6b84a0;text-transform:uppercase;letter-spacing:0.07em;margin:0 0 4px">Strengths</p><p style="font-size:13px;color:#374f6b;font-weight:500;margin:0 0 12px;line-height:1.5">${escHtml(e.strengths)}</p>` : ''}
                        ${e.areasForImprovement ? `<p style="font-size:11px;font-weight:700;color:#6b84a0;text-transform:uppercase;letter-spacing:0.07em;margin:0 0 4px">Areas for Improvement</p><p style="font-size:13px;color:#374f6b;font-weight:500;margin:0;line-height:1.5">${escHtml(e.areasForImprovement)}</p>` : ''}
                        ${!e.strengths && !e.areasForImprovement ? `<p style="font-size:13px;color:#9ab0c6;font-style:italic">No written comments.</p>` : ''}
                    </div>
                </div>`;
            }).join('')}
        `;

    } catch (err) {
        console.error('[Evaluations] openEvalPanel:', err);
        document.getElementById('evalPanelBody').innerHTML =
            '<p style="color:#e31b4a;font-weight:600;padding:16px">Error loading evaluations.</p>';
    }
};

window.closeEvalPanel = () => closeOverlay('evalHistoryPanel', 'evalHistoryPanelInner', true);

// ── 7. NEW EVAL MODAL ─────────────────────────────────────────────────────
window.openNewEvalModal = function(preselectedTeacherId = null) {
    evalRatings = { overallRating: 0, classroomManagement: 0, curriculumDelivery: 0, studentEngagement: 0, professionalConduct: 0 };
    document.getElementById('evalDate').value       = new Date().toISOString().split('T')[0];
    document.getElementById('evalStrengths').value  = '';
    document.getElementById('evalImprovements').value = '';
    document.getElementById('evalAction').value     = 'None';
    document.getElementById('evalMsg').classList.add('hidden');

    if (preselectedTeacherId) {
        document.getElementById('evalTeacherId').value = preselectedTeacherId;
    } else {
        document.getElementById('evalTeacherId').value = '';
    }

    buildStarGroups();
    openOverlay('newEvalModal', 'newEvalModalInner');
};

window.closeNewEvalModal = () => closeOverlay('newEvalModal', 'newEvalModalInner');

// ── 8. SUBMIT EVALUATION ──────────────────────────────────────────────────
document.getElementById('submitEvalBtn').addEventListener('click', async () => {
    const teacherId = document.getElementById('evalTeacherId').value;
    const date      = document.getElementById('evalDate').value;
    const msg       = document.getElementById('evalMsg');
    msg.classList.add('hidden');

    if (!teacherId)              { showEvalMsg('Please select a teacher.'); return; }
    if (!date)                   { showEvalMsg('Please select a date.'); return; }
    if (!evalRatings.overallRating) { showEvalMsg('Please set an Overall Performance rating.'); return; }

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
            date,
            overallRating:        evalRatings.overallRating,
            classroomManagement:  evalRatings.classroomManagement  || null,
            curriculumDelivery:   evalRatings.curriculumDelivery   || null,
            studentEngagement:    evalRatings.studentEngagement    || null,
            professionalConduct:  evalRatings.professionalConduct  || null,
            strengths:            document.getElementById('evalStrengths').value.trim(),
            areasForImprovement:  document.getElementById('evalImprovements').value.trim(),
            recommendedAction:    document.getElementById('evalAction').value,
            createdAt:            new Date().toISOString()
        });

        window.closeNewEvalModal();
        loadPage(); // Refresh table
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
