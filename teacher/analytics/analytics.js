import { db } from '../../assets/js/firebase-init.js';
import {
    doc, getDoc, collection, getDocs, query, where, orderBy
} from "https://www.gstatic.com/firebasejs/10.7.1/firebase-firestore.js";
import { requireAuth } from '../../assets/js/auth.js';
import { injectTeacherLayout } from '../../assets/js/layout-teachers.js';

// ── 1. INIT ───────────────────────────────────────────────────────────────
const session = requireAuth('teacher', '../login.html');
if (session) {
    injectTeacherLayout('analytics', 'My Evaluations', 'Performance reviews filed by your school', false);
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
    if (action === 'Commendation')        return { bg: '#edfaf4', text: '#0b8f5e', border: '#c6f0db' };
    if (action === 'Professional Development') return { bg: '#fffbeb', text: '#b45309', border: '#fef3c7' };
    return { bg: '#fff0f3', text: '#e31b4a', border: '#ffd6de' };
}

// ── 2. LOAD & RENDER ──────────────────────────────────────────────────────
document.addEventListener('DOMContentLoaded', async () => {
    if (!session) return;

    try {
        // Fetch evaluations filed by this school for this teacher
        const snap = await getDocs(query(
            collection(db, 'teachers', session.teacherId, 'evaluations'),
            where('schoolId', '==', session.schoolId)
        ));

        const evals = snap.docs
            .map(d => ({ id: d.id, ...d.data() }))
            .sort((a, b) => new Date(b.date || b.createdAt) - new Date(a.date || a.createdAt));

        renderKpis(evals);
        renderCategories(evals);
        renderList(evals);

    } catch (e) {
        console.error('[Analytics] load error:', e);
        document.getElementById('evalList').innerHTML =
            '<p style="padding:24px;color:#e31b4a;font-weight:600;text-align:center">Error loading evaluations. Please try again.</p>';
    }
});

// ── 3. KPI CARDS ──────────────────────────────────────────────────────────
function renderKpis(evals) {
    const count   = evals.length;
    const avg     = count ? (evals.reduce((s, e) => s + (e.overallRating || 0), 0) / count).toFixed(1) : null;
    const last    = count ? evals[0] : null;
    const lastStr = last?.date
        ? new Date(last.date).toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' })
        : null;

    // Latest recommendation
    const latestRec = last?.recommendedAction && last.recommendedAction !== 'None' ? last.recommendedAction : '—';
    const rc = recColor(last?.recommendedAction);

    document.getElementById('evalKpiCards').innerHTML = [
        {
            icon: 'fa-star', iconBg: '#fffbeb', iconColor: '#f59e0b',
            val: avg !== null ? `<span style="font-size:22px;font-weight:700;color:#0d1f35">${avg}</span><span style="font-size:13px;color:#6b84a0;font-weight:500"> / 5</span>` : '<span style="color:#9ab0c6">—</span>',
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
            icon: 'fa-calendar-check', iconBg: '#edfaf4', iconColor: '#0b8f5e',
            val: lastStr
                ? `<span style="font-size:14px;font-weight:700;color:#0d1f35">${lastStr}</span>`
                : '<span style="color:#9ab0c6;font-size:14px">—</span>',
            sub: '',
            lbl: 'Last Evaluated'
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

// ── 4. CATEGORY BARS ──────────────────────────────────────────────────────
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

// ── 5. EVALUATION LIST ────────────────────────────────────────────────────
function renderList(evals) {
    document.getElementById('evalCountBadge').textContent = `${evals.length} evaluation${evals.length !== 1 ? 's' : ''}`;

    if (!evals.length) {
        document.getElementById('evalList').innerHTML = `
            <div style="text-align:center;padding:48px 24px">
                <i class="fa-regular fa-folder-open" style="font-size:28px;color:#9ab0c6;display:block;margin-bottom:10px"></i>
                <p style="font-size:13.5px;color:#6b84a0;font-weight:500">No evaluations on record at your current school.</p>
                <p style="font-size:12px;color:#9ab0c6;margin-top:6px">Evaluations are filed by your school's administration.</p>
            </div>`;
        return;
    }

    const cats = [
        { key: 'classroomManagement', label: 'Classroom Mgmt'  },
        { key: 'curriculumDelivery',  label: 'Curriculum'       },
        { key: 'studentEngagement',   label: 'Engagement'       },
        { key: 'professionalConduct', label: 'Conduct'          }
    ];

    document.getElementById('evalList').innerHTML = evals.map((e, idx) => {
        const dateStr = e.date
            ? new Date(e.date).toLocaleDateString('en-US', { weekday: 'short', year: 'numeric', month: 'long', day: 'numeric' })
            : '—';
        const rc  = recColor(e.recommendedAction);
        const catRows = cats.filter(c => e[c.key] != null).map(c => {
            const pct = (e[c.key] / 5) * 100;
            const col = pct >= 70 ? '#0ea871' : pct >= 50 ? '#f59e0b' : '#e31b4a';
            return `<div style="flex:1;min-width:120px">
                <div style="display:flex;justify-content:space-between;margin-bottom:3px">
                    <span style="font-size:10.5px;font-weight:600;color:#6b84a0">${c.label}</span>
                    <span style="font-size:10.5px;font-weight:700;color:${col}">${e[c.key]}/5</span>
                </div>
                <div style="height:4px;background:#f0f4f8;border-radius:99px;overflow:hidden">
                    <div style="height:100%;width:${pct}%;background:${col};border-radius:99px"></div>
                </div>
            </div>`;
        }).join('');

        return `
        <div style="padding:20px 24px${idx === 0 ? '' : ''}">
            <div style="display:flex;align-items:flex-start;justify-content:space-between;gap:12px;margin-bottom:14px">
                <div>
                    <div style="display:flex;align-items:center;gap:8px;margin-bottom:5px">
                        ${stars(e.overallRating || 0)}
                        <span style="font-size:16px;font-weight:700;color:#0d1f35">${(e.overallRating || 0).toFixed(1)}</span>
                    </div>
                    <p style="font-size:12px;font-weight:500;color:#6b84a0;margin:0">
                        ${dateStr}
                        <span style="margin:0 6px;color:#dce3ed">·</span>
                        Evaluated by <strong style="color:#374f6b">${escHtml(e.evaluatorName || 'Administrator')}</strong>
                    </p>
                </div>
                ${e.recommendedAction && e.recommendedAction !== 'None'
                    ? `<span style="font-size:11px;font-weight:700;padding:4px 12px;border-radius:99px;background:${rc.bg};border:1px solid ${rc.border};color:${rc.text};white-space:nowrap">${escHtml(e.recommendedAction)}</span>`
                    : ''}
            </div>

            ${catRows ? `<div style="display:flex;flex-wrap:wrap;gap:12px;margin-bottom:14px">${catRows}</div>` : ''}

            ${e.strengths || e.areasForImprovement ? `
            <div style="background:#f8fafb;border:1px solid #f0f4f8;border-radius:10px;padding:14px 16px;display:grid;grid-template-columns:1fr 1fr;gap:16px">
                ${e.strengths ? `<div>
                    <p style="font-size:10px;font-weight:700;color:#0b8f5e;text-transform:uppercase;letter-spacing:0.08em;margin:0 0 5px">Strengths</p>
                    <p style="font-size:13px;color:#374f6b;font-weight:400;margin:0;line-height:1.55">${escHtml(e.strengths)}</p>
                </div>` : '<div></div>'}
                ${e.areasForImprovement ? `<div>
                    <p style="font-size:10px;font-weight:700;color:#b45309;text-transform:uppercase;letter-spacing:0.08em;margin:0 0 5px">Areas for Improvement</p>
                    <p style="font-size:13px;color:#374f6b;font-weight:400;margin:0;line-height:1.55">${escHtml(e.areasForImprovement)}</p>
                </div>` : ''}
            </div>` : ''}
        </div>`;
    }).join('');
}
