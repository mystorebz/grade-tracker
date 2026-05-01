import { db } from '../../assets/js/firebase-init.js';
import {
    collection, getDocs
} from "https://www.gstatic.com/firebasejs/10.7.1/firebase-firestore.js";
import { requireAuth } from '../../assets/js/auth.js';
import { injectTeacherLayout } from '../../assets/js/layout-teachers.js';

// ── 1. INIT ───────────────────────────────────────────────────────────────
const session = requireAuth('teacher', '../login.html');
if (session) {
    injectTeacherLayout('analytics', 'My Evaluations', 'Full career record — performance reviews across all schools', false);
}

function escHtml(s) {
    return String(s || '').replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;');
}

function stars(rating, size = 15) {
    return [1,2,3,4,5].map(n =>
        `<span style="color:${n <= Math.round(rating) ? '#f59e0b' : '#dce3ed'};font-size:${size}px">★</span>`
    ).join('');
}

function recColor(action) {
    if (!action || action === 'None') return { bg: '#f4f7fb', text: '#6b84a0', border: '#dce3ed' };
    if (action === 'Commendation')            return { bg: '#edfaf4', text: '#0b8f5e', border: '#c6f0db' };
    if (action === 'Professional Development') return { bg: '#fffbeb', text: '#b45309', border: '#fef3c7' };
    return { bg: '#fff0f3', text: '#e31b4a', border: '#ffd6de' };
}

// ── 2. STATE ─────────────────────────────────────────────────────────────
let allEvals  = [];
let semesters = [];
let expanded  = new Set(); // tracks which eval IDs are expanded

// ── 3. LOAD ───────────────────────────────────────────────────────────────
document.addEventListener('DOMContentLoaded', async () => {
    if (!session) return;

    try {
        await loadSemesters();

        const snap = await getDocs(
            collection(db, 'teachers', session.teacherId, 'evaluations')
        );

        allEvals = snap.docs
            .map(d => ({ id: d.id, ...d.data() }))
            .sort((a, b) => new Date(b.date || b.createdAt) - new Date(a.date || a.createdAt));

        renderKpis(allEvals);
        renderCategories(allEvals);
        window.applyFilters();

    } catch (e) {
        console.error('[Evaluations] load error:', e);
        document.getElementById('evalList').innerHTML =
            '<p style="padding:24px;color:#e31b4a;font-weight:600;text-align:center">Error loading evaluations. Please try again.</p>';
    }
});

async function loadSemesters() {
    try {
        const cacheKey = `connectus_semesters_${session.schoolId}`;
        const cached   = localStorage.getItem(cacheKey);
        if (cached) {
            semesters = JSON.parse(cached);
        } else {
            const snap = await getDocs(collection(db, 'schools', session.schoolId, 'semesters'));
            semesters  = snap.docs.map(d => ({ id: d.id, ...d.data() })).sort((a,b) => (a.order||0)-(b.order||0));
            localStorage.setItem(cacheKey, JSON.stringify(semesters));
        }
    } catch (e) {
        console.warn('[Evaluations] Could not load semesters:', e);
    }

    const sel = document.getElementById('filterPeriod');
    if (!sel) return;
    sel.innerHTML = '<option value="">All Periods</option>';
    semesters.forEach(s => {
        const opt = document.createElement('option');
        opt.value       = s.id;
        opt.textContent = s.name;
        sel.appendChild(opt);
    });
}

// ── 4. FILTER (called by period dropdown) ────────────────────────────────
window.applyFilters = function() {
    const periodId = document.getElementById('filterPeriod')?.value || '';
    const filtered = periodId
        ? allEvals.filter(e => e.semesterId === periodId)
        : allEvals;

    renderList(filtered);
};

// ── 5. EXPAND / COLLAPSE ─────────────────────────────────────────────────
window.toggleEval = function(id) {
    if (expanded.has(id)) expanded.delete(id);
    else expanded.add(id);

    const body    = document.getElementById(`eval-body-${id}`);
    const chevron = document.getElementById(`eval-chevron-${id}`);
    if (!body) return;

    const isOpen = expanded.has(id);
    body.style.display    = isOpen ? 'block' : 'none';
    if (chevron) chevron.style.transform = isOpen ? 'rotate(180deg)' : 'rotate(0deg)';
};

// ── 6. KPI CARDS ──────────────────────────────────────────────────────────
function renderKpis(evals) {
    const count        = evals.length;
    const avg          = count ? (evals.reduce((s, e) => s + (e.overallRating || 0), 0) / count).toFixed(1) : null;
    const last         = count ? evals[0] : null;
    const schoolsCount = new Set(evals.map(e => e.schoolId).filter(Boolean)).size;
    const latestRec    = last?.recommendedAction && last.recommendedAction !== 'None' ? last.recommendedAction : '—';
    const rc           = recColor(last?.recommendedAction);

    document.getElementById('evalKpiCards').innerHTML = [
        {
            icon: 'fa-star', iconBg: '#fffbeb', iconColor: '#f59e0b',
            val: avg !== null
                ? `<span style="font-size:22px;font-weight:700;color:#0d1f35">${avg}</span><span style="font-size:13px;color:#6b84a0;font-weight:500"> / 5</span>`
                : '<span style="color:#9ab0c6">—</span>',
            sub: avg !== null ? `<div style="display:flex;gap:2px;margin-top:4px">${stars(parseFloat(avg), 13)}</div>` : '',
            lbl: 'Average Rating'
        },
        {
            icon: 'fa-file-lines', iconBg: '#eef4ff', iconColor: '#2563eb',
            val: `<span style="font-size:22px;font-weight:700;color:#0d1f35">${count}</span>`,
            sub: `<span style="font-size:11px;color:#6b84a0;font-weight:500">evaluation${count !== 1 ? 's' : ''} on record</span>`,
            lbl: 'Total Evaluations'
        },
        {
            icon: 'fa-school', iconBg: '#edfaf4', iconColor: '#0b8f5e',
            val: `<span style="font-size:22px;font-weight:700;color:#0d1f35">${schoolsCount}</span>`,
            sub: `<span style="font-size:11px;color:#6b84a0;font-weight:500">school${schoolsCount !== 1 ? 's' : ''} on record</span>`,
            lbl: 'Schools Evaluated At'
        },
        {
            icon: 'fa-clipboard-check', iconBg: rc.bg, iconColor: rc.text,
            val: `<span style="font-size:13px;font-weight:700;color:${rc.text}">${escHtml(latestRec)}</span>`,
            sub: count ? '<span style="font-size:11px;color:#6b84a0;font-weight:500">Latest recommendation</span>' : '',
            lbl: 'Latest Action'
        }
    ].map(k => `
        <div style="background:#fff;border:1px solid #dce3ed;border-radius:14px;padding:18px 20px;display:flex;align-items:flex-start;gap:14px;box-shadow:0 1px 3px rgba(13,31,53,0.06)">
            <div style="width:38px;height:38px;border-radius:9px;background:${k.iconBg};display:flex;align-items:center;justify-content:center;flex-shrink:0">
                <i class="fa-solid ${k.icon}" style="color:${k.iconColor};font-size:14px"></i>
            </div>
            <div style="flex:1;min-width:0">
                <div>${k.val}</div>
                ${k.sub}
                <div style="font-size:10.5px;font-weight:700;color:#9ab0c6;text-transform:uppercase;letter-spacing:0.08em;margin-top:5px">${k.lbl}</div>
            </div>
        </div>`).join('');
}

// ── 7. CATEGORY BARS ──────────────────────────────────────────────────────
function renderCategories(evals) {
    const cats = [
        { key: 'classroomManagement', label: 'Classroom Management' },
        { key: 'curriculumDelivery',  label: 'Curriculum Delivery'  },
        { key: 'studentEngagement',   label: 'Student Engagement'   },
        { key: 'professionalConduct', label: 'Professional Conduct' }
    ];

    const catData = cats.map(cat => {
        const valid = evals.filter(e => e[cat.key] != null);
        const avg   = valid.length ? valid.reduce((s, e) => s + e[cat.key], 0) / valid.length : null;
        return { ...cat, avg };
    }).filter(c => c.avg !== null);

    if (!catData.length) return;

    document.getElementById('categorySection').classList.remove('hidden');
    document.getElementById('categoryBars').innerHTML = catData.map(c => {
        const pct = (c.avg / 5) * 100;
        const col = pct >= 70 ? '#0ea871' : pct >= 50 ? '#f59e0b' : '#e31b4a';
        return `
        <div>
            <div style="display:flex;justify-content:space-between;margin-bottom:5px">
                <span style="font-size:12.5px;font-weight:600;color:#374f6b">${c.label}</span>
                <span style="font-size:12.5px;font-weight:700;color:${col}">${c.avg.toFixed(1)} / 5</span>
            </div>
            <div style="height:6px;background:#f0f4f8;border-radius:99px;overflow:hidden">
                <div style="height:100%;width:${pct}%;background:${col};border-radius:99px;transition:width 0.4s"></div>
            </div>
        </div>`;
    }).join('');
}

// ── 8. EVALUATION LIST (collapsible cards) ────────────────────────────────
function renderList(evals) {
    const badge = document.getElementById('evalCountBadge');
    if (badge) badge.textContent = `${evals.length} evaluation${evals.length !== 1 ? 's' : ''}`;

    if (!evals.length) {
        document.getElementById('evalList').innerHTML = `
            <div style="text-align:center;padding:48px 24px">
                <i class="fa-regular fa-folder-open" style="font-size:28px;color:#9ab0c6;display:block;margin-bottom:10px"></i>
                <p style="font-size:13.5px;color:#6b84a0;font-weight:500">No evaluations found for this period.</p>
                <p style="font-size:12px;color:#9ab0c6;margin-top:6px">Try selecting a different period or view all.</p>
            </div>`;
        return;
    }

    const cats = [
        { key: 'classroomManagement', label: 'Classroom Mgmt'  },
        { key: 'curriculumDelivery',  label: 'Curriculum'       },
        { key: 'studentEngagement',   label: 'Engagement'       },
        { key: 'professionalConduct', label: 'Conduct'          }
    ];

    document.getElementById('evalList').innerHTML = evals.map(e => {
        const dateStr = e.date
            ? new Date(e.date).toLocaleDateString('en-US', { weekday: 'short', year: 'numeric', month: 'long', day: 'numeric' })
            : '—';
        const rc         = recColor(e.recommendedAction);
        const isOpen     = expanded.has(e.id);
        const semName    = semesters.find(s => s.id === e.semesterId)?.name || e.semesterName || '';

        // Category rows (shown in expanded body)
        const catRows = cats.filter(c => e[c.key] != null).map(c => {
            const pct = (e[c.key] / 5) * 100;
            const col = pct >= 70 ? '#0ea871' : pct >= 50 ? '#f59e0b' : '#e31b4a';
            return `
            <div style="flex:1;min-width:140px">
                <div style="display:flex;justify-content:space-between;margin-bottom:4px">
                    <span style="font-size:10.5px;font-weight:600;color:#6b84a0">${c.label}</span>
                    <span style="font-size:10.5px;font-weight:700;color:${col}">${e[c.key]}/5</span>
                </div>
                <div style="height:5px;background:#f0f4f8;border-radius:99px;overflow:hidden">
                    <div style="height:100%;width:${pct}%;background:${col};border-radius:99px"></div>
                </div>
            </div>`;
        }).join('');

        const writtenBlock = (e.strengths || e.areasForImprovement) ? `
        <div style="background:#f8fafb;border:1px solid #f0f4f8;border-radius:8px;padding:14px 16px;display:grid;grid-template-columns:1fr 1fr;gap:16px;margin-top:14px">
            ${e.strengths ? `<div>
                <p style="font-size:10px;font-weight:700;color:#0b8f5e;text-transform:uppercase;letter-spacing:0.08em;margin:0 0 5px">Strengths</p>
                <p style="font-size:13px;color:#374f6b;font-weight:400;margin:0;line-height:1.55">${escHtml(e.strengths)}</p>
            </div>` : '<div></div>'}
            ${e.areasForImprovement ? `<div>
                <p style="font-size:10px;font-weight:700;color:#b45309;text-transform:uppercase;letter-spacing:0.08em;margin:0 0 5px">Areas for Improvement</p>
                <p style="font-size:13px;color:#374f6b;font-weight:400;margin:0;line-height:1.55">${escHtml(e.areasForImprovement)}</p>
            </div>` : ''}
        </div>` : '';

        const notesBlock = e.additionalNotes ? `
        <div style="margin-top:12px;padding:12px 14px;background:#eef4ff;border:1px solid #c7d9fd;border-radius:8px;">
            <p style="font-size:10px;font-weight:700;color:#2563eb;text-transform:uppercase;letter-spacing:0.08em;margin:0 0 5px">Additional Notes</p>
            <p style="font-size:13px;color:#374f6b;margin:0;line-height:1.55">${escHtml(e.additionalNotes)}</p>
        </div>` : '';

        return `
        <div style="border-bottom:1px solid #f0f4f8;">

            <!-- ── COLLAPSED HEADER (always visible, clickable) ── -->
            <div onclick="window.toggleEval('${e.id}')"
                 style="display:flex;align-items:center;justify-content:space-between;padding:16px 24px;cursor:pointer;user-select:none;"
                 onmouseover="this.style.background='#f8fafb'" onmouseout="this.style.background='transparent'">

                <div style="display:flex;align-items:center;gap:14px;min-width:0;flex:1;">
                    <!-- Rating circle -->
                    <div style="width:44px;height:44px;border-radius:10px;background:#f4f7fb;border:1px solid #dce3ed;display:flex;flex-direction:column;align-items:center;justify-content:center;flex-shrink:0;">
                        <span style="font-size:14px;font-weight:700;color:#0d1f35;line-height:1">${(e.overallRating || 0).toFixed(1)}</span>
                        <span style="font-size:9px;color:#9ab0c6;font-weight:600">/ 5</span>
                    </div>

                    <div style="min-width:0;flex:1;">
                        <div style="display:flex;align-items:center;gap:8px;flex-wrap:wrap;">
                            <div style="display:flex;gap:1px">${stars(e.overallRating || 0, 13)}</div>
                            ${semName ? `<span style="font-size:10.5px;font-weight:700;padding:2px 8px;border-radius:99px;background:#eef4ff;color:#2563eb;border:1px solid #c7d9fd;">${escHtml(semName)}</span>` : ''}
                            <span style="font-size:10.5px;font-weight:700;padding:2px 8px;border-radius:99px;${e.schoolId === session.schoolId ? 'background:#edfaf4;color:#0b8f5e;border:1px solid #c6f0db' : 'background:#f4f7fb;color:#6b84a0;border:1px solid #dce3ed'}">
                                ${e.schoolId === session.schoolId ? 'Current school' : escHtml(e.schoolId || 'Previous school')}
                            </span>
                        </div>
                        <p style="font-size:11.5px;font-weight:500;color:#6b84a0;margin:4px 0 0;white-space:nowrap;overflow:hidden;text-overflow:ellipsis;">
                            ${dateStr}
                            ${e.evaluatorName ? `<span style="margin:0 5px;color:#dce3ed">·</span>Evaluated by <strong style="color:#374f6b">${escHtml(e.evaluatorName)}</strong>` : ''}
                        </p>
                    </div>
                </div>

                <div style="display:flex;align-items:center;gap:10px;flex-shrink:0;margin-left:12px;">
                    ${e.recommendedAction && e.recommendedAction !== 'None'
                        ? `<span style="font-size:11px;font-weight:700;padding:3px 10px;border-radius:99px;background:${rc.bg};border:1px solid ${rc.border};color:${rc.text};white-space:nowrap">${escHtml(e.recommendedAction)}</span>`
                        : ''}
                    <i id="eval-chevron-${e.id}" class="fa-solid fa-chevron-down"
                       style="font-size:11px;color:#9ab0c6;transition:transform 0.2s;${isOpen ? 'transform:rotate(180deg)' : ''}"></i>
                </div>
            </div>

            <!-- ── EXPANDED BODY ── -->
            <div id="eval-body-${e.id}" style="display:${isOpen ? 'block' : 'none'};">
                <div style="padding:0 24px 20px;">

                    ${catRows ? `
                    <div style="display:flex;flex-wrap:wrap;gap:12px;margin-bottom:4px;">
                        ${catRows}
                    </div>` : ''}

                    ${writtenBlock}
                    ${notesBlock}

                </div>
            </div>

        </div>`;
    }).join('');
}
