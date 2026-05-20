import { db } from '../../assets/js/firebase-init.js';
import { collection, query, where, getDocs, doc, getDoc } from "https://www.gstatic.com/firebasejs/10.7.1/firebase-firestore.js";
import { requireAuth } from '../../assets/js/auth.js';
import { injectStudentLayout } from '../../assets/js/layout-student.js';
import { calculateWeightedAverage } from '../../assets/js/utils.js';

// ── 1. AUTH & LAYOUT ──────────────────────────────────────────────────────
const session = requireAuth('student', '../login.html');
injectStudentLayout('gradebook', 'My Gradebook', 'Full grade breakdown by subject');

document.getElementById('displayStudentName').innerText  = session.studentData.name || 'Student';
document.getElementById('studentAvatar').innerText       = (session.studentData.name || 'S').charAt(0).toUpperCase();
document.getElementById('displayStudentClass').innerText = session.studentData.className
    ? `Class: ${session.studentData.className}` : 'Unassigned';

// ── 2. STATE ─────────────────────────────────────────────────────────────
let allGrades     = [];
let teacherRubric = [];
let teachersMap   = {};
let bySubCache    = {};   // cached subject groups for modal drill-down
let drillSubject  = null; // currently open subject in modal

// ── 3. HELPERS (unchanged) ────────────────────────────────────────────────
function esc(s) {
    return String(s || '').replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;');
}

function gradeStyle(p) {
    if (p >= 90) return { color:'#059669', bg:'#d1fae5', border:'#6ee7b7', letter:'A', bar:'#10b981' };
    if (p >= 80) return { color:'#2563eb', bg:'#dbeafe', border:'#93c5fd', letter:'B', bar:'#3b82f6' };
    if (p >= 70) return { color:'#0d9488', bg:'#ccfbf1', border:'#5eead4', letter:'C', bar:'#14b8a6' };
    if (p >= 65) return { color:'#d97706', bg:'#fef3c7', border:'#fcd34d', letter:'D', bar:'#f59e0b' };
    return             { color:'#dc2626', bg:'#fee2e2', border:'#fca5a5', letter:'F', bar:'#ef4444' };
}

function standing(avg) {
    if (avg >= 90) return '⭐ Excelling';
    if (avg >= 80) return '👍 Good Standing';
    if (avg >= 70) return '➡ On Track';
    if (avg >= 65) return '⚠ Needs Attention';
    return '🔴 At Risk';
}

function isNew(date, created) {
    const d = created ? new Date(created) : new Date(date);
    return !isNaN(d) && Math.ceil(Math.abs(new Date() - d) / 86400000) <= 5;
}

function getWeight(type) {
    if (!type || !teacherRubric.length) return null;
    const r = teacherRubric.find(x => x.name?.toLowerCase() === type.toLowerCase());
    return r ? r.weight : null;
}

// ── 4. LOAD DATA (unchanged) ──────────────────────────────────────────────
async function loadGrades() {
    try {
        const schoolSnap = await getDoc(doc(db, 'schools', session.schoolId));
        const schoolData = schoolSnap.data() || {};
        const semId      = schoolData.activeSemesterId;

        document.getElementById('displaySchoolName').innerText = schoolData.schoolName || 'ConnectUs';

        if (!semId) {
            document.getElementById('gradesLoader').innerHTML =
                '<i class="fa-solid fa-calendar-xmark" style="font-size:28px;color:#fbbf24;"></i><p>No active grading period set by the school.</p>';
            return;
        }

        const semSnap = await getDoc(doc(db, 'schools', session.schoolId, 'semesters', semId));
        const semName = semSnap.data()?.name || 'Current Period';
        document.getElementById('activeSemesterDisplay').textContent = semName;
        document.getElementById('gbTerm').textContent = semName;

        // Teacher rubric
        const tId = session.studentData?.teacherId;
        if (tId) {
            const tSnap = await getDoc(doc(db, 'teachers', tId));
            if (tSnap.exists()) {
                const td     = tSnap.data();
                teacherRubric  = td.gradeTypes || td.customGradeTypes || [];
                teachersMap[tId] = td.name || 'Teacher';
            }
        }

        // All teachers (for admin-entered grades)
        const tAllSnap = await getDocs(query(collection(db, 'teachers'), where('currentSchoolId','==', session.schoolId)));
        tAllSnap.forEach(d => { teachersMap[d.id] = d.data().name; });

        // Grades — global student path
        const gSnap = await getDocs(query(
            collection(db, 'students', session.studentId, 'grades'),
            where('schoolId',   '==', session.schoolId),
            where('semesterId', '==', semId)
        ));
        allGrades = gSnap.docs.map(d => ({ id: d.id, ...d.data() }));

        document.getElementById('gradesLoader').style.display = 'none';

        if (!allGrades.length) {
            document.getElementById('noCurrentGradesMsg').classList.remove('hidden');
            return;
        }

        // Group by subject & cache
        const bySub = {};
        allGrades.forEach(g => {
            const sub = g.subject || 'Uncategorized';
            if (!bySub[sub]) bySub[sub] = [];
            bySub[sub].push(g);
        });
        bySubCache = bySub;

        // Overall average
        let totalAvg = 0, subCount = 0;
        for (const sub in bySub) {
            const avg = calculateWeightedAverage(bySub[sub], teacherRubric);
            if (avg !== null) { totalAvg += avg; subCount++; }
        }
        const overall = subCount > 0 ? Math.round(totalAvg / subCount) : null;

        // Populate header
        const topbar = document.getElementById('gbTopbar');
        topbar.style.display = 'flex';
        if (overall !== null) {
            document.getElementById('gbAvg').textContent = overall;
            document.getElementById('gbAvg').style.color = '#fff';
            const standEl = document.getElementById('gbStanding');
            standEl.textContent   = standing(overall);
            standEl.style.display = 'inline-flex';
        }

        renderSubjectTiles(bySub);

    } catch(e) {
        console.error('[Grades] load error:', e);
        document.getElementById('gradesLoader').innerHTML =
            '<i class="fa-solid fa-triangle-exclamation" style="color:#ef4444;font-size:28px;"></i><p style="color:#ef4444;">Failed to load grades. Please refresh.</p>';
    }
}

// ── 5. SUBJECT TILE COLORS ────────────────────────────────────────────────
const TILE_COLORS = [
    { bg:'#1e1b4b', accent:'#6366f1' },
    { bg:'#064e3b', accent:'#10b981' },
    { bg:'#7c2d12', accent:'#f97316' },
    { bg:'#1e3a5f', accent:'#3b82f6' },
    { bg:'#4a1d96', accent:'#8b5cf6' },
    { bg:'#831843', accent:'#ec4899' },
    { bg:'#134e4a', accent:'#14b8a6' },
    { bg:'#713f12', accent:'#eab308' },
];

// ── 6. RENDER SUBJECT TILES ───────────────────────────────────────────────
function renderSubjectTiles(bySub) {
    const table  = document.getElementById('gradesTable');
    const rowsEl = document.getElementById('subjectRows');
    table.classList.remove('hidden');

    const entries = Object.entries(bySub).sort((a,b) => a[0].localeCompare(b[0]));

    rowsEl.innerHTML = `
        <div style="display:grid;grid-template-columns:repeat(auto-fill,minmax(210px,1fr));gap:16px;padding:4px 0;">
            ${entries.map(([subject, grades], idx) => {
                const avg    = calculateWeightedAverage(grades, teacherRubric);
                const avgRnd = avg !== null ? Math.round(avg) : null;
                const st     = avgRnd !== null ? gradeStyle(avgRnd) : null;
                const color  = TILE_COLORS[idx % TILE_COLORS.length];
                const cnt    = grades.length;

                return `
                <div onclick="window.openSubjectModal('${esc(subject)}')"
                     style="background:#fff;border:1.5px solid #e2e8f0;border-radius:12px;padding:20px 18px;cursor:pointer;transition:all 0.15s;display:flex;flex-direction:column;gap:14px;position:relative;overflow:hidden;"
                     onmouseover="this.style.borderColor='${color.accent}';this.style.boxShadow='0 6px 24px rgba(0,0,0,0.10)';this.style.transform='translateY(-2px)';"
                     onmouseout="this.style.borderColor='#e2e8f0';this.style.boxShadow='none';this.style.transform='translateY(0)';">

                    <!-- Top accent bar -->
                    <div style="position:absolute;top:0;left:0;right:0;height:3px;background:${color.accent};border-radius:12px 12px 0 0;"></div>

                    <!-- Initial + Subject name -->
                    <div style="display:flex;align-items:center;gap:12px;margin-top:6px;">
                        <div style="width:42px;height:42px;border-radius:10px;background:${color.bg};color:#fff;font-size:17px;font-weight:800;display:flex;align-items:center;justify-content:center;flex-shrink:0;">
                            ${esc(subject.charAt(0).toUpperCase())}
                        </div>
                        <div style="min-width:0;">
                            <div style="font-size:13px;font-weight:700;color:#0f172a;line-height:1.3;white-space:nowrap;overflow:hidden;text-overflow:ellipsis;">${esc(subject)}</div>
                            <div style="font-size:11px;color:#94a3b8;font-weight:500;margin-top:2px;">${cnt} ${cnt !== 1 ? 'entries' : 'entry'}</div>
                        </div>
                    </div>

                    <!-- Average + letter badge -->
                    <div style="display:flex;align-items:flex-end;justify-content:space-between;">
                        <div style="font-size:30px;font-weight:900;line-height:1;color:${st?.color || '#94a3b8'};">
                            ${avgRnd !== null ? avgRnd + '%' : '—'}
                        </div>
                        ${st ? `<span style="font-size:15px;font-weight:800;padding:5px 13px;border-radius:8px;background:${st.bg};color:${st.color};border:1.5px solid ${st.border};">${st.letter}</span>` : ''}
                    </div>

                    <!-- Progress bar -->
                    <div style="height:4px;background:#f1f5f9;border-radius:99px;overflow:hidden;margin-top:-6px;">
                        <div style="height:100%;width:${Math.min(avgRnd||0,100)}%;background:${st?.bar || '#cbd5e1'};border-radius:99px;"></div>
                    </div>

                </div>`;
            }).join('')}
        </div>`;
}

// ── 7. OPEN SUBJECT MODAL — TYPE TILES VIEW ───────────────────────────────
window.openSubjectModal = function(subject) {
    drillSubject   = subject;
    const grades   = bySubCache[subject] || [];
    const modal    = document.getElementById('typeModal');

    const avg      = calculateWeightedAverage(grades, teacherRubric);
    const avgRnd   = avg !== null ? Math.round(avg) : null;
    const st       = avgRnd !== null ? gradeStyle(avgRnd) : null;
    const cnt      = grades.length;

    // Group by type
    const byType = {};
    grades.forEach(g => {
        const t = g.type || 'Other';
        if (!byType[t]) byType[t] = [];
        byType[t].push(g);
    });

    const typeTilesHtml = Object.entries(byType)
        .sort((a,b) => a[0].localeCompare(b[0]))
        .map(([type, tGrades]) => {
            const typeAvg = Math.round(tGrades.reduce((s,g) => s + (g.max ? (g.score/g.max)*100 : 0), 0) / tGrades.length);
            const tSt     = gradeStyle(typeAvg);
            const w       = getWeight(type);
            const tCnt    = tGrades.length;

            return `
            <div onclick="window.openEntriesView('${esc(subject)}','${esc(type)}')"
                 style="background:#f8fafc;border:1.5px solid #e2e8f0;border-radius:10px;padding:18px 16px;cursor:pointer;transition:all 0.15s;display:flex;flex-direction:column;gap:10px;"
                 onmouseover="this.style.background='#f1f5f9';this.style.borderColor='${tSt.color}';this.style.boxShadow='0 2px 12px rgba(0,0,0,0.07)';"
                 onmouseout="this.style.background='#f8fafc';this.style.borderColor='#e2e8f0';this.style.boxShadow='none';">

                <!-- Type name + entry count -->
                <div style="display:flex;align-items:flex-start;justify-content:space-between;gap:8px;">
                    <div>
                        <div style="font-size:13px;font-weight:700;color:#0f172a;">${esc(type)}</div>
                        ${w !== null ? `<div style="font-size:10px;color:#94a3b8;font-weight:600;margin-top:2px;">${w}% of subject grade</div>` : ''}
                    </div>
                    <span style="font-size:10px;font-weight:700;padding:2px 8px;background:${tSt.bg};color:${tSt.color};border:1px solid ${tSt.border};border-radius:4px;white-space:nowrap;">${tCnt} ${tCnt !== 1 ? 'entries' : 'entry'}</span>
                </div>

                <!-- Average + letter -->
                <div style="display:flex;align-items:center;justify-content:space-between;">
                    <div style="font-size:28px;font-weight:900;color:${tSt.color};line-height:1;">${typeAvg}%</div>
                    <span style="font-size:13px;font-weight:800;padding:4px 12px;background:${tSt.bg};color:${tSt.color};border:1.5px solid ${tSt.border};border-radius:6px;">${tSt.letter}</span>
                </div>

                <!-- Progress bar -->
                <div style="height:5px;background:#e2e8f0;border-radius:99px;overflow:hidden;">
                    <div style="height:100%;width:${Math.min(typeAvg,100)}%;background:${tSt.bar};border-radius:99px;"></div>
                </div>

                <div style="font-size:10px;color:#94a3b8;font-weight:600;text-align:right;">Tap to view entries →</div>
            </div>`;
        }).join('');

    modal.innerHTML = `
    <div style="width:100%;max-width:700px;max-height:88vh;background:#fff;border-radius:14px;overflow:hidden;display:flex;flex-direction:column;box-shadow:0 24px 64px rgba(0,0,0,0.22);" onclick="event.stopPropagation()">

        <!-- Top stripe -->
        <div style="height:4px;background:linear-gradient(90deg,#0ea871,#0d1f35);flex-shrink:0;"></div>

        <!-- Header -->
        <div style="padding:18px 24px;border-bottom:1px solid #e8edf2;background:#fafbfc;display:flex;align-items:center;justify-content:space-between;gap:12px;flex-shrink:0;">
            <div style="display:flex;align-items:center;gap:12px;">
                <!-- Back button (hidden on type tiles view) -->
                <div id="modalBackBtn" style="display:none;">
                    <button onclick="window.goBackToTypes()"
                            style="display:flex;align-items:center;gap:6px;padding:6px 12px;background:#f1f5f9;border:1px solid #cbd5e1;border-radius:6px;font-size:12px;font-weight:700;color:#374f6b;font-family:inherit;cursor:pointer;"
                            onmouseover="this.style.background='#e2e8f0';" onmouseout="this.style.background='#f1f5f9';">
                        <i class="fa-solid fa-arrow-left" style="font-size:10px;"></i> Back
                    </button>
                </div>
                <div>
                    <h2 id="modalTitle" style="margin:0;font-size:17px;font-weight:800;color:#0d1f35;">${esc(subject)}</h2>
                    <p id="modalSubtitle" style="margin:2px 0 0;font-size:11.5px;color:#6b84a0;font-weight:500;">
                        ${avgRnd !== null ? avgRnd + '% overall · ' : ''}${cnt} ${cnt !== 1 ? 'entries' : 'entry'}
                    </p>
                </div>
            </div>
            <button onclick="window.closeTypeModal()"
                    style="width:32px;height:32px;flex-shrink:0;display:flex;align-items:center;justify-content:center;background:transparent;border:1px solid transparent;border-radius:6px;color:#94a3b8;cursor:pointer;font-size:16px;transition:all 0.12s;"
                    onmouseover="this.style.background='#fee2e2';this.style.borderColor='#fecaca';this.style.color='#dc2626';"
                    onmouseout="this.style.background='transparent';this.style.borderColor='transparent';this.style.color='#94a3b8';">
                <i class="fa-solid fa-xmark"></i>
            </button>
        </div>

        <!-- Body -->
        <div id="modalBody" style="flex:1;overflow-y:auto;padding:20px 24px;">
            <div style="display:grid;grid-template-columns:repeat(auto-fill,minmax(190px,1fr));gap:14px;">
                ${typeTilesHtml}
            </div>
        </div>

    </div>`;

    // Position overlay
    modal.style.cssText = 'position:fixed;inset:0;background:rgba(13,31,53,0.65);z-index:50;display:flex;align-items:center;justify-content:center;padding:16px;';
    modal.classList.remove('hidden');
};

// ── 8. ENTRIES DRILL-DOWN VIEW ────────────────────────────────────────────
window.openEntriesView = function(subject, type) {
    const grades = allGrades.filter(g =>
        (g.subject || 'Uncategorized') === subject && (g.type || 'Other') === type
    );
    if (!grades.length) return;

    const typeAvg = Math.round(grades.reduce((s,g) => s + (g.max ? (g.score/g.max)*100 : 0), 0) / grades.length);
    const w       = getWeight(type);
    const tSt     = gradeStyle(typeAvg);
    const sorted  = [...grades].sort((a,b) => (b.date||'').localeCompare(a.date||''));
    const cnt     = grades.length;

    // Update header
    document.getElementById('modalTitle').textContent    = type;
    document.getElementById('modalSubtitle').textContent =
        `${subject}${w !== null ? ' · ' + w + '% of grade' : ''} · ${cnt} ${cnt !== 1 ? 'entries' : 'entry'}`;
    document.getElementById('modalBackBtn').style.display = 'block';

    const entriesHtml = sorted.map(g => {
        const pct      = g.max ? Math.round((g.score / g.max) * 100) : null;
        const gSt      = pct !== null ? gradeStyle(pct) : null;
        const newBdg   = isNew(g.date, g.createdAt)
            ? `<span style="font-size:9px;font-weight:700;padding:2px 6px;background:#dbeafe;color:#1d4ed8;border-radius:3px;margin-left:6px;vertical-align:middle;">New</span>` : '';
        const adminBdg = g.enteredByAdmin
            ? `<span style="font-size:9px;font-weight:700;padding:2px 6px;background:#eff6ff;color:#2563eb;border:1px solid #bfdbfe;border-radius:3px;margin-left:4px;vertical-align:middle;">Admin</span>` : '';
        const tName    = g.enteredByAdmin
            ? (g.adminName || 'Administrator')
            : (teachersMap[g.teacherId] || 'Teacher');

        return `
        <div style="background:#fff;border:1px solid #e2e8f0;border-radius:10px;padding:16px;display:flex;flex-direction:column;gap:10px;">
            <div style="display:flex;align-items:flex-start;justify-content:space-between;gap:12px;">
                <div style="flex:1;min-width:0;">
                    <div style="font-size:13.5px;font-weight:700;color:#0f172a;line-height:1.3;">${esc(g.title || '—')}${newBdg}${adminBdg}</div>
                    <div style="font-size:11px;color:#94a3b8;margin-top:4px;">${esc(g.date || '—')} · ${esc(tName)}</div>
                </div>
                <div style="text-align:right;flex-shrink:0;">
                    <div style="font-size:17px;font-weight:800;color:${gSt?.color || '#1e293b'};">${g.score} / ${g.max ?? '?'}</div>
                    <div style="display:inline-block;font-size:11.5px;font-weight:700;padding:2px 9px;background:${gSt?.bg || '#f1f5f9'};color:${gSt?.color || '#475569'};border:1px solid ${gSt?.border || '#cbd5e1'};border-radius:4px;margin-top:3px;">${pct !== null ? pct + '%' : '—'}</div>
                </div>
            </div>
            <div style="height:6px;background:#f1f5f9;border-radius:99px;overflow:hidden;">
                <div style="height:100%;width:${Math.min(pct||0,100)}%;background:${gSt?.bar || '#94a3b8'};border-radius:99px;"></div>
            </div>
            ${g.notes ? `<div style="font-size:11.5px;color:#475569;background:#f8fafc;padding:8px 12px;border-radius:6px;border-left:3px solid #0ea871;line-height:1.5;">${esc(g.notes)}</div>` : ''}
            ${g.historyLogs?.length ? `<div style="padding:8px 12px;background:#fffbeb;border:1px solid #fde68a;border-radius:6px;font-size:11px;color:#92400e;font-weight:600;"><i class="fa-solid fa-clock-rotate-left" style="margin-right:5px;"></i>Grade was modified after initial entry.</div>` : ''}
        </div>`;
    }).join('');

    document.getElementById('modalBody').innerHTML = `
        <div style="display:flex;flex-direction:column;gap:10px;">

            <!-- Summary strip -->
            <div style="display:grid;grid-template-columns:repeat(3,1fr);gap:10px;margin-bottom:4px;">
                <div style="background:#f8fafc;border:1px solid #e2e8f0;border-radius:8px;padding:12px;text-align:center;">
                    <div style="font-size:9px;text-transform:uppercase;font-weight:800;color:#94a3b8;letter-spacing:1px;margin-bottom:4px;">Average</div>
                    <div style="font-size:22px;font-weight:900;color:${tSt.color};">${typeAvg}%</div>
                </div>
                <div style="background:#f8fafc;border:1px solid #e2e8f0;border-radius:8px;padding:12px;text-align:center;">
                    <div style="font-size:9px;text-transform:uppercase;font-weight:800;color:#94a3b8;letter-spacing:1px;margin-bottom:4px;">Entries</div>
                    <div style="font-size:22px;font-weight:900;color:#0d1f35;">${cnt}</div>
                </div>
                <div style="background:#f8fafc;border:1px solid #e2e8f0;border-radius:8px;padding:12px;text-align:center;">
                    <div style="font-size:9px;text-transform:uppercase;font-weight:800;color:#94a3b8;letter-spacing:1px;margin-bottom:4px;">Weight</div>
                    <div style="font-size:22px;font-weight:900;color:#0d1f35;">${w !== null ? w + '%' : '—'}</div>
                </div>
            </div>

            <!-- Individual entries -->
            ${entriesHtml}
        </div>`;
};

// ── 9. BACK TO TYPE TILES ─────────────────────────────────────────────────
window.goBackToTypes = function() {
    if (drillSubject) window.openSubjectModal(drillSubject);
};

// ── 10. CLOSE MODAL ───────────────────────────────────────────────────────
window.closeTypeModal = function() {
    const modal     = document.getElementById('typeModal');
    modal.classList.add('hidden');
    modal.innerHTML = '';
    drillSubject    = null;
};

// Close on backdrop click
document.getElementById('typeModal').addEventListener('click', function(e) {
    if (e.target === this) window.closeTypeModal();
});

// ── INITIALIZE ────────────────────────────────────────────────────────────
document.addEventListener('DOMContentLoaded', loadGrades);
