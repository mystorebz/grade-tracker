import { db } from '../../assets/js/firebase-init.js';
import { collection, query, where, getDocs, getDoc, doc } from "https://www.gstatic.com/firebasejs/10.7.1/firebase-firestore.js";
import { requireAuth } from '../../assets/js/auth.js';
import { injectTeacherLayout } from '../../assets/js/layout-teachers.js';
import { gradeColorClass } from '../../assets/js/utils.js';

// ── 1. AUTH & LAYOUT ─────────────────────────────────────────────────────────
const session = requireAuth('teacher', '../login.html');
if (session) {
    injectTeacherLayout('overview', 'Overview', 'Classroom dashboard', false);
}

// ── 2. STATE ─────────────────────────────────────────────────────────────────
let allStudents = [];
let studentMap  = {};
let allGrades   = [];

// ── 3. INIT ───────────────────────────────────────────────────────────────────
async function init() {
    if (!session) return;

    // Personalise the greeting with the teacher's actual name
    const greeting = document.querySelector('.page-header-greeting');
    if (greeting) {
        const hour = new Date().getHours();
        const salutation = hour < 12 ? 'Good morning' : hour < 17 ? 'Good afternoon' : 'Good evening';
        const firstName  = session.teacherData.name.split(' ')[0];
        greeting.textContent = `${salutation}, ${firstName}.`;
    }

    // Populate sidebar teacher info
    document.getElementById('displayTeacherName').textContent = session.teacherData.name;
    document.getElementById('teacherAvatar').textContent      = session.teacherData.name.charAt(0).toUpperCase();
    document.getElementById('sidebarSchoolId').textContent    = session.schoolId;

    const classes = session.teacherData.classes || [session.teacherData.className || ''];
    document.getElementById('displayTeacherClasses').innerHTML =
        classes.filter(Boolean).map(c => `<span class="class-pill">${c}</span>`).join('');

    await loadSemesters();
    await fetchMetrics();
}

// ── 4. SEMESTERS (cached in localStorage to avoid repeat Firestore reads) ──────
async function loadSemesters() {
    try {
        let rawSemesters = [];
        const cacheKey   = `connectus_semesters_${session.schoolId}`;
        const cached     = localStorage.getItem(cacheKey);

        if (cached) {
            rawSemesters = JSON.parse(cached);
        } else {
            const semSnap = await getDocs(collection(db, 'schools', session.schoolId, 'semesters'));
            rawSemesters  = semSnap.docs
                .map(d => ({ id: d.id, ...d.data() }))
                .sort((a, b) => (a.order || 0) - (b.order || 0));
            localStorage.setItem(cacheKey, JSON.stringify(rawSemesters));
        }

        const schoolSnap = await getDoc(doc(db, 'schools', session.schoolId));
        const activeId   = schoolSnap.data()?.activeSemesterId || '';

        const semSel = document.getElementById('activeSemester');
        if (semSel) {
            semSel.innerHTML = '';
            rawSemesters.forEach(s => {
                const opt      = document.createElement('option');
                opt.value      = s.id;
                opt.textContent = s.name;
                if (s.id === activeId) opt.selected = true;
                semSel.appendChild(opt);
            });
            semSel.addEventListener('change', fetchMetrics);
        }
    } catch (e) {
        console.error('[Overview] loadSemesters:', e);
    }
}

// ── 5. FETCH & RENDER DASHBOARD DATA ─────────────────────────────────────────
async function fetchMetrics() {
    try {
        const semSel  = document.getElementById('activeSemester');
        const semId   = semSel ? semSel.value : null;
        const semName = semSel ? semSel.options[semSel.selectedIndex]?.text : '—';

        // Update sidebar period display
        const sbPeriod = document.getElementById('sb-period');
        if (sbPeriod) sbPeriod.textContent = semName;

        // ── 5a. Students ────────────────────────────────────────────────────
        const stuQuery = query(
            collection(db, 'schools', session.schoolId, 'students'),
            where('archived',   '==', false),
            where('teacherId',  '==', session.teacherId)
        );
        const stuSnap   = await getDocs(stuQuery);
        allStudents     = stuSnap.docs.map(d => ({ id: d.id, ...d.data() }));
        studentMap      = {};
        allStudents.forEach(s => { studentMap[s.id] = s.name; });

        // Update stat cards + sidebar
        document.getElementById('stat-students').textContent = allStudents.length;
        const sbStudents = document.getElementById('sb-students');
        if (sbStudents) sbStudents.textContent = allStudents.length;

        // Early exit if nothing to show
        if (!semId || !allStudents.length) {
            document.getElementById('stat-grades').textContent = '0';
            document.getElementById('stat-risk').textContent   = '0';
            const sbRisk = document.getElementById('sb-risk');
            if (sbRisk) sbRisk.textContent = '0';
            renderEmptyActivity();
            renderEmptyRisk();
            return;
        }

        // ── 5b. Grades (one query per student, run in parallel) ─────────────
        allGrades = [];
        await Promise.all(allStudents.map(async s => {
            try {
                const gQuery = query(
                    collection(db, 'schools', session.schoolId, 'students', s.id, 'grades'),
                    where('semesterId', '==', semId)
                );
                const gSnap = await getDocs(gQuery);
                gSnap.forEach(d => allGrades.push({ id: d.id, studentId: s.id, studentName: s.name, ...d.data() }));
            } catch (e) {
                console.error(`[Overview] grades for ${s.id}:`, e);
            }
        }));

        document.getElementById('stat-grades').textContent = allGrades.length;

        // ── 5c. At-Risk calculation (avg < 65%) ─────────────────────────────
        const stuG = {};
        allGrades.forEach(g => {
            if (!stuG[g.studentId]) stuG[g.studentId] = { total: 0, count: 0 };
            stuG[g.studentId].total += g.max ? (g.score / g.max) * 100 : 0;
            stuG[g.studentId].count++;
        });

        const riskStudents = [];
        Object.entries(stuG).forEach(([sid, sg]) => {
            if (sg.count > 0) {
                const avg = Math.round(sg.total / sg.count);
                if (avg < 65) riskStudents.push({ sid, name: studentMap[sid] || 'Unknown', avg });
            }
        });

        const riskCount = riskStudents.length;
        document.getElementById('stat-risk').textContent = riskCount;
        const sbRisk = document.getElementById('sb-risk');
        if (sbRisk) {
            sbRisk.textContent = riskCount;
            // Add visual indicator on the sidebar pill when there are at-risk students
            sbRisk.classList.toggle('is-risk', riskCount > 0);
        }

        // ── 5d. At-Risk banner ───────────────────────────────────────────────
        const banner = document.getElementById('atRiskBanner');
        const msg    = document.getElementById('atRiskMsg');
        if (riskCount > 0) {
            banner.classList.remove('hidden');
            msg.textContent = `${riskCount} student${riskCount !== 1 ? 's are' : ' is'} averaging below 65% this period.`;
        } else {
            banner.classList.add('hidden');
        }

        // ── 5e. Needs Attention list ─────────────────────────────────────────
        if (riskCount > 0) {
            document.getElementById('needsAttentionList').innerHTML =
                riskStudents
                    .sort((a, b) => a.avg - b.avg)
                    .map(s => renderRiskItem(s))
                    .join('');
        } else {
            renderEmptyRisk();
        }

        // ── 5f. Recent Activity (last 8, table rows) ─────────────────────────
        const recent = [...allGrades]
            .sort((a, b) => new Date(b.createdAt || b.date || 0) - new Date(a.createdAt || a.date || 0))
            .slice(0, 8);

        if (recent.length > 0) {
            document.getElementById('recentActivityList').innerHTML =
                recent.map(g => renderActivityRow(g)).join('');
        } else {
            renderEmptyActivity();
        }

    } catch (e) {
        console.error('[Overview] fetchMetrics:', e);
    }
}

// ── 6. RENDER HELPERS ─────────────────────────────────────────────────────────

/**
 * Renders a single recent-activity row as a 5-column table-style flex row.
 * Columns: Student & Assignment | Subject | Type | Score | Grade %
 */
function renderActivityRow(g) {
    const pct        = g.max ? Math.round((g.score / g.max) * 100) : 0;
    const colorClass = gradeColorClass(pct);

    // Grade badge colours
    const badgeStyle = pct >= 90 ? 'background:#dcfce7;color:#166534;border:1px solid #bbf7d0;'
                     : pct >= 80 ? 'background:#dbeafe;color:#1e40af;border:1px solid #bfdbfe;'
                     : pct >= 70 ? 'background:#ccfbf1;color:#115e59;border:1px solid #99f6e4;'
                     : pct >= 65 ? 'background:#fef3c7;color:#92400e;border:1px solid #fde68a;'
                     :             'background:#fee2e2;color:#991b1b;border:1px solid #fecaca;';

    // Friendly date
    let dateStr = '—';
    if (g.createdAt || g.date) {
        try {
            dateStr = new Date(g.createdAt || g.date).toLocaleDateString('en-US', { month: 'short', day: 'numeric' });
        } catch (_) { /* ignore */ }
    }

    const initial = (g.studentName || '?').charAt(0).toUpperCase();

    return `
    <a href="../gradebook/gradebook.html"
       style="display:grid;grid-template-columns:1fr 100px 80px 64px 80px;
              align-items:center;padding:11px 20px;border-bottom:1px solid #f0f4f9;
              text-decoration:none;transition:background 0.12s;cursor:pointer;"
       onmouseover="this.style.background='#f8fafc'"
       onmouseout="this.style.background=''">

      <!-- Student & Assignment -->
      <div style="display:flex;align-items:center;gap:10px;min-width:0;">
        <div style="width:28px;height:28px;border-radius:8px;background:linear-gradient(135deg,#0ea871,#053d29);
                    color:#fff;font-size:11px;font-weight:700;display:flex;align-items:center;
                    justify-content:center;flex-shrink:0;">${initial}</div>
        <div style="min-width:0;">
          <p style="font-size:12.5px;font-weight:600;color:#0d1f35;margin:0;
                    white-space:nowrap;overflow:hidden;text-overflow:ellipsis;">
            ${escHtml(g.studentName || 'Unknown')}
          </p>
          <p style="font-size:11px;color:#9ab0c6;font-weight:400;margin:0;
                    white-space:nowrap;overflow:hidden;text-overflow:ellipsis;">
            ${escHtml(g.title || 'Assessment')} · ${dateStr}
          </p>
        </div>
      </div>

      <!-- Subject -->
      <div style="font-size:12px;font-weight:500;color:#374f6b;
                  white-space:nowrap;overflow:hidden;text-overflow:ellipsis;">
        ${escHtml(g.subject || '—')}
      </div>

      <!-- Type -->
      <div style="font-size:11px;color:#9ab0c6;font-weight:400;">
        ${escHtml(g.type || '—')}
      </div>

      <!-- Score -->
      <div style="font-size:12px;font-weight:600;color:#374f6b;text-align:right;
                  font-family:'DM Mono',monospace;">
        ${g.score}/${g.max || '?'}
      </div>

      <!-- Grade % badge -->
      <div style="text-align:right;">
        <span style="${badgeStyle}padding:2px 8px;border-radius:99px;
                     font-size:11px;font-weight:700;font-family:'DM Mono',monospace;">
          ${pct}%
        </span>
      </div>

    </a>`;
}

/**
 * Renders a single at-risk student card in the Needs Attention panel.
 */
function renderRiskItem(s) {
    const initial = (s.name || '?').charAt(0).toUpperCase();
    return `
    <a href="../roster/roster.html#${escHtml(s.sid)}"
       style="display:flex;align-items:center;justify-content:space-between;
              background:#fff;border:1px solid #ffd6de;border-radius:10px;
              padding:10px 12px;text-decoration:none;
              transition:box-shadow 0.15s;cursor:pointer;"
       onmouseover="this.style.boxShadow='0 2px 8px rgba(220,38,38,0.1)'"
       onmouseout="this.style.boxShadow=''">
      <div style="display:flex;align-items:center;gap:9px;">
        <div style="width:30px;height:30px;border-radius:8px;background:#fee2e2;
                    color:#dc2626;font-size:12px;font-weight:700;
                    display:flex;align-items:center;justify-content:center;flex-shrink:0;">
          ${initial}
        </div>
        <span style="font-size:13px;font-weight:600;color:#0d1f35;">
          ${escHtml(s.name)}
        </span>
      </div>
      <span style="font-size:12px;font-weight:700;color:#be123c;
                   background:#fee2e2;padding:2px 9px;border-radius:99px;
                   border:1px solid #fecaca;font-family:'DM Mono',monospace;">
        ${s.avg}%
      </span>
    </a>`;
}

function renderEmptyActivity() {
    document.getElementById('recentActivityList').innerHTML = `
        <div style="display:flex;flex-direction:column;align-items:center;justify-content:center;
                    padding:48px 20px;gap:8px;color:#9ab0c6;">
            <i class="fa-solid fa-inbox" style="font-size:22px;"></i>
            <p style="font-size:12.5px;margin:0;font-weight:400;">No grades logged yet this period.</p>
            <a href="../grade_form/grade_form.html"
               style="font-size:12px;font-weight:600;color:#0b8f5e;text-decoration:none;margin-top:4px;">
               + Enter your first grade →
            </a>
        </div>`;
}

function renderEmptyRisk() {
    document.getElementById('needsAttentionList').innerHTML = `
        <div style="display:flex;flex-direction:column;align-items:center;justify-content:center;
                    padding:40px 20px;gap:8px;color:#9ab0c6;">
            <i class="fa-solid fa-circle-check" style="font-size:22px;color:#0ea871;"></i>
            <p style="font-size:12.5px;margin:0;font-weight:400;text-align:center;">
                All students on track!
            </p>
        </div>`;
}

/** Escapes HTML special characters to prevent XSS in rendered student data. */
function escHtml(str) {
    if (!str) return '';
    return String(str)
        .replace(/&/g, '&amp;')
        .replace(/</g, '&lt;')
        .replace(/>/g, '&gt;')
        .replace(/"/g, '&quot;');
}

// ── 7. FIRE ───────────────────────────────────────────────────────────────────
init();
