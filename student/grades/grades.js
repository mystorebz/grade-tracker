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
let bySubCache    = {};
let drillSubject  = null;

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

// ── 4. LOAD DATA ──────────────────────────────────────────────────────────
async function loadGrades() {
    try {

        // Phase 1: school doc
        const schoolSnap = await getDoc(doc(db, 'schools', session.schoolId));
        const schoolData = schoolSnap.data() || {};
        const semId      = schoolData.activeSemesterId;

        document.getElementById('displaySchoolName').innerText = schoolData.schoolName || 'ConnectUs';

        if (!semId) {
            document.getElementById('gradesLoader').innerHTML =
                '<i class="fa-solid fa-calendar-xmark" style="font-size:28px;color:#fbbf24;"></i><p>No active grading period set by the school.</p>';
            return;
        }

        // Phase 2: semester + teacher rubric + grades — all in parallel
        const tId = session.studentData?.teacherId;

        const [semSnap, tSnap, gSnap] = await Promise.all([
            getDoc(doc(db, 'schools', session.schoolId, 'semesters', semId)),
            tId ? getDoc(doc(db, 'teachers', tId)) : Promise.resolve(null),
            getDocs(query(
                collection(db, 'students', session.studentId, 'grades'),
                where('schoolId',   '==', session.schoolId),
                where('semesterId', '==', semId)
            ))
        ]);

        const semName = semSnap.data()?.name || 'Current Period';
        document.getElementById('activeSemesterDisplay').textContent = semName;
        document.getElementById('gbTerm').textContent = semName;

        if (tSnap && tSnap.exists()) {
            const td         = tSnap.data();
            teacherRubric    = td.gradeTypes || td.customGradeTypes || [];
            teachersMap[tId] = td.name || 'Teacher';
        }

        allGrades = gSnap.docs.map(d => ({ id: d.id, ...d.data() }));

        document.getElementById('gradesLoader').style.display = 'none';

        if (!allGrades.length) {
            document.getElementById('noCurrentGradesMsg').classList.remove('hidden');
            return;
        }

        // Phase 3: fetch only teachers referenced in grades, in parallel
        const extraTeacherIds = [
            ...new Set(
                allGrades
                    .filter(g => !g.enteredByAdmin && g.teacherId && !teachersMap[g.teacherId])
                    .map(g => g.teacherId)
            )
        ];

        if (extraTeacherIds.length > 0) {
            const extraSnaps = await Promise.all(
                extraTeacherIds.map(id => getDoc(doc(db, 'teachers', id)))
            );
            extraSnaps.forEach((snap, i) => {
                if (snap.exists()) teachersMap[extraTeacherIds[i]] = snap.data().name || 'Teacher';
            });
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
                    <div style="position:absolute;top:0;left:0;right:0;height:3px;background:${color.accent};border-radius:12px 12px 0 0;"></div>
                    <div style="display:flex;align-items:center;gap:12px;margin-top:6px;">
                        <div style="width:42px;height:42px;border-radius:10px;background:${color.bg};color:#fff;font-size:17px;font-weight:800;display:flex;align-items:center;justify-content:center;flex-shrink:0;">
                            ${esc(subject.charAt(0).toUpperCase())}
                        </div>
                        <div style="min-width:0;">
                            <div style="font-size:13px;font-weight:700;color:#0f172a;line-height:1.3;white-space:nowrap;overflow:hidden;text-overflow:ellipsis;">${esc(subject)}</div>
                            <div style="font-size:11px;color:#94a3b8;font-weight:500;margin-top:2px;">${cnt} ${cnt !== 1 ? 'entries' : 'entry'}</div>
                        </div>
                    </div>
                    <div style="display:flex;align-items:flex-end;justify-content:space-between;">
                        <div style="font-size:30px;font-weight:900;line-height:1;color:${st?.color || '#94a3b8'};">
                            ${avgRnd !== null ? avgRnd + '%' : '—'}
                        </div>
                        ${st ? `<span style="font-size:15px;font-weight:800;padding:5px 13px;border-radius:8px;background:${st.bg};color:${st.color};border:1.5px solid ${st.border};">${st.letter}</span>` : ''}
                    </div>
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
                <div style="display:flex;align-items:flex-start;justify-content:space-between;gap:8px;">
                    <div>
                        <div style="font-size:13px;font-weight:700;color:#0f172a;">${esc(type)}</div>
                        ${w !== null ? `<div style="font-size:10px;color:#94a3b8;font-weight:600;margin-top:2px;">${w}% of subject grade</div>` : ''}
                    </div>
                    <span style="font-size:10px;font-weight:700;padding:2px 8px;background:${tSt.bg};color:${tSt.color};border:1px solid ${tSt.border};border-radius:4px;white-space:nowrap;">${tCnt} ${tCnt !== 1 ? 'entries' : 'entry'}</span>
                </div>
                <div style="display:flex;align-items:center;justify-content:space-between;">
                    <div style="font-size:28px;font-weight:900;color:${tSt.color};line-height:1;">${typeAvg}%</div>
                    <span style="font-size:13px;font-weight:800;padding:4px 12px;background:${tSt.bg};color:${tSt.color};border:1.5px solid ${tSt.border};border-radius:6px;">${tSt.letter}</span>
                </div>
                <div style="height:5px;background:#e2e8f0;border-radius:99px;overflow:hidden;">
                    <div style="height:100%;width:${Math.min(typeAvg,100)}%;background:${tSt.bar};border-radius:99px;"></div>
                </div>
                <div style="font-size:10px;color:#94a3b8;font-weight:600;text-align:right;">Tap to view entries →</div>
            </div>`;
        }).join('');

    modal.innerHTML = `
    <div style="width:100%;max-width:700px;max-height:88vh;background:#fff;border-radius:14px;overflow:hidden;display:flex;flex-direction:column;box-shadow:0 24px 64px rgba(0,0,0,0.22);" onclick="event.stopPropagation()">
        <div style="height:4px;background:linear-gradient(90deg,#0ea871,#0d1f35);flex-shrink:0;"></div>
        <div style="padding:18px 24px;border-bottom:1px solid #e8edf2;background:#fafbfc;display:flex;align-items:center;justify-content:space-between;gap:12px;flex-shrink:0;">
            <div style="display:flex;align-items:center;gap:12px;">
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
        <div id="modalBody" style="flex:1;overflow-y:auto;padding:20px 24px;">
            <div style="display:grid;grid-template-columns:repeat(auto-fill,minmax(190px,1fr));gap:14px;">
                ${typeTilesHtml}
            </div>
        </div>
    </div>`;

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

document.getElementById('typeModal').addEventListener('click', function(e) {
    if (e.target === this) window.closeTypeModal();
});

// ── 11. PRINT GRADEBOOK ───────────────────────────────────────────────────
// Opens a new window with a fully formatted, print-ready grade report,
// then triggers the print dialog automatically.
// Uses only data already loaded in memory — no extra Firestore calls.
window.printGradebook = function() {
    if (!allGrades.length || !Object.keys(bySubCache).length) {
        alert('Grade data is still loading. Please wait a moment and try again.');
        return;
    }

    // ── Gather page meta ─────────────────────────────────────────────────
    const logoUrl    = new URL('../../assets/images/logo.png', window.location.href).href;
    const printDate  = new Date().toLocaleDateString('en-US', { year:'numeric', month:'long', day:'numeric' });
    const semName    = document.getElementById('activeSemesterDisplay')?.textContent || 'Current Period';
    const schoolName = document.getElementById('displaySchoolName')?.textContent    || 'School';
    const studentName  = session.studentData?.name      || 'Student';
    const studentClass = session.studentData?.className || '—';
    const studentId    = session.studentId              || '—';

    // ── Calculate all subject averages ───────────────────────────────────
    const subjects = Object.entries(bySubCache).sort((a, b) => a[0].localeCompare(b[0]));
    let totalAvg = 0, subCount = 0;
    const subjectAverages = {};

    for (const [sub, grades] of subjects) {
        const avg = calculateWeightedAverage(grades, teacherRubric);
        if (avg !== null) {
            const rounded = Math.round(avg);
            subjectAverages[sub] = rounded;
            totalAvg += rounded;
            subCount++;
        }
    }

    const overall    = subCount > 0 ? Math.round(totalAvg / subCount) : null;
    const overallSt  = overall !== null ? gradeStyle(overall) : null;
    const standingTx = overall !== null ? standing(overall).replace(/[⭐👍➡⚠🔴]\s?/u, '') : '—';

    // ── Build subject sections ───────────────────────────────────────────
    const subjectSectionsHtml = subjects.map(([subject, grades], idx) => {
        const avg   = subjectAverages[subject] ?? null;
        const st    = avg !== null ? gradeStyle(avg) : null;
        const color = TILE_COLORS[idx % TILE_COLORS.length];

        const sorted = [...grades].sort((a, b) => (a.date || '').localeCompare(b.date || ''));

        const rows = sorted.map(g => {
            const pct   = g.max ? Math.round((g.score / g.max) * 100) : null;
            const gSt   = pct !== null ? gradeStyle(pct) : null;
            const w     = getWeight(g.type);
            const tName = g.enteredByAdmin
                ? (g.adminName || 'Administrator')
                : (teachersMap[g.teacherId] || 'Teacher');

            return `
            <tr>
                <td class="col-title">${esc(g.title || '—')}${g.enteredByAdmin ? ' <span class="admin-tag">Admin</span>' : ''}</td>
                <td class="col-date">${esc(g.date || '—')}</td>
                <td class="col-type">${esc(g.type || '—')}${w !== null ? `<span class="weight"> (${w}%)</span>` : ''}</td>
                <td class="col-score center">${g.score} / ${g.max ?? '?'}</td>
                <td class="col-pct center" style="color:${gSt?.color || '#374f6b'};font-weight:800;">${pct !== null ? pct + '%' : '—'}</td>
                <td class="col-letter center">
                    <span class="letter-badge" style="color:${gSt?.color || '#374f6b'};background:${gSt?.bg || '#f1f5f9'};border-color:${gSt?.border || '#e2e8f0'};">${gSt?.letter || '—'}</span>
                </td>
            </tr>`;
        }).join('');

        return `
        <div class="subject-section">
            <div class="subject-header" style="background:${color.accent};">
                <div class="subject-initial">${esc(subject.charAt(0).toUpperCase())}</div>
                <div class="subject-name">${esc(subject)}</div>
                ${avg !== null ? `<div class="subject-avg-pill">${avg}%&nbsp;&nbsp;${st?.letter || ''}</div>` : ''}
            </div>
            <table>
                <thead>
                    <tr>
                        <th class="col-title">Assignment</th>
                        <th class="col-date">Date</th>
                        <th class="col-type">Type</th>
                        <th class="col-score center">Score</th>
                        <th class="col-pct center">Percentage</th>
                        <th class="col-letter center">Grade</th>
                    </tr>
                </thead>
                <tbody>${rows}</tbody>
                <tfoot>
                    <tr>
                        <td colspan="4" class="avg-label">Subject Average</td>
                        <td class="center avg-val" style="color:${st?.color || '#374f6b'};">${avg !== null ? avg + '%' : '—'}</td>
                        <td class="center">
                            <span class="letter-badge avg-letter" style="color:${st?.color || '#374f6b'};background:${st?.bg || '#f1f5f9'};border-color:${st?.border || '#e2e8f0'};">${st?.letter || '—'}</span>
                        </td>
                    </tr>
                </tfoot>
            </table>
        </div>`;
    }).join('');

    // ── Assemble full HTML document ──────────────────────────────────────
    const html = `<!DOCTYPE html>
<html lang="en">
<head>
    <meta charset="UTF-8">
    <meta name="viewport" content="width=device-width, initial-scale=1.0">
    <title>Grade Report — ${esc(studentName)} — ${esc(semName)}</title>
    <style>
        /* ── Reset & Base ── */
        *, *::before, *::after { box-sizing: border-box; margin: 0; padding: 0; }
        body {
            font-family: 'Segoe UI', Arial, sans-serif;
            background: #fff;
            color: #0d1f35;
            font-size: 11.5px;
            line-height: 1.5;
            -webkit-print-color-adjust: exact;
            print-color-adjust: exact;
        }

        /* ── Report Header ── */
        .report-header {
            display: flex;
            align-items: center;
            justify-content: space-between;
            padding: 24px 36px 20px;
            border-bottom: 3px solid #1e1b4b;
            background: #fff;
        }
        .header-left { display: flex; align-items: center; gap: 16px; }
        .logo { width: 52px; height: 52px; object-fit: contain; }
        .brand { display: flex; flex-direction: column; }
        .brand-name { font-size: 22px; font-weight: 900; color: #1e1b4b; letter-spacing: -0.5px; }
        .brand-tagline { font-size: 10px; color: #818cf8; font-weight: 700; letter-spacing: 1.5px; text-transform: uppercase; margin-top: 2px; }
        .header-right { text-align: right; }
        .report-title { font-size: 15px; font-weight: 800; color: #1e1b4b; text-transform: uppercase; letter-spacing: 1px; }
        .report-date { font-size: 10px; color: #6b84a0; margin-top: 3px; font-weight: 500; }

        /* ── Student Info Bar ── */
        .student-bar {
            background: #f4f7fb;
            border-bottom: 1px solid #dce3ed;
            padding: 14px 36px;
            display: grid;
            grid-template-columns: repeat(4, 1fr);
            gap: 0;
        }
        .student-field { padding: 0 16px; }
        .student-field:first-child { padding-left: 0; }
        .student-field:not(:last-child) { border-right: 1px solid #dce3ed; }
        .field-label {
            font-size: 9px; text-transform: uppercase; letter-spacing: 1.2px;
            font-weight: 700; color: #94a3b8; display: block; margin-bottom: 3px;
        }
        .field-value { font-size: 13px; font-weight: 800; color: #0d1f35; }

        /* ── Section Label ── */
        .section-label {
            padding: 20px 36px 10px;
            font-size: 9px; font-weight: 700; color: #94a3b8;
            text-transform: uppercase; letter-spacing: 1.5px;
        }

        /* ── Subject Sections ── */
        .subjects { padding: 0 36px; }
        .subject-section {
            margin-bottom: 28px;
            border: 1px solid #e2e8f0;
            border-radius: 10px;
            overflow: hidden;
            page-break-inside: avoid;
        }

        /* Subject Header Bar */
        .subject-header {
            display: flex;
            align-items: center;
            gap: 12px;
            padding: 11px 16px;
            color: #fff;
        }
        .subject-initial {
            width: 30px; height: 30px;
            border-radius: 7px;
            background: rgba(255,255,255,0.22);
            display: flex; align-items: center; justify-content: center;
            font-size: 15px; font-weight: 900;
            flex-shrink: 0;
        }
        .subject-name { font-size: 13px; font-weight: 800; flex: 1; }
        .subject-avg-pill {
            background: rgba(255,255,255,0.22);
            padding: 3px 12px;
            border-radius: 99px;
            font-size: 12px; font-weight: 900;
            letter-spacing: 0.5px;
            border: 1px solid rgba(255,255,255,0.3);
        }

        /* Grade Table */
        table { width: 100%; border-collapse: collapse; }
        thead th {
            background: #f8fafc;
            font-size: 9px; font-weight: 700;
            text-transform: uppercase; letter-spacing: 0.8px;
            color: #6b84a0;
            padding: 8px 14px;
            text-align: left;
            border-bottom: 1px solid #e8edf4;
        }
        thead th.center { text-align: center; }

        tbody tr:nth-child(even) { background: #fafbfc; }
        tbody tr:last-child td { border-bottom: none; }
        tbody td {
            padding: 9px 14px;
            border-bottom: 1px solid #f0f4f9;
            font-size: 11px;
            color: #0d1f35;
            vertical-align: middle;
        }
        tbody td.center { text-align: center; }

        /* Subject Average Footer Row */
        tfoot td {
            padding: 10px 14px;
            background: #f0f4f9;
            border-top: 2px solid #dce3ed;
            font-weight: 700;
            font-size: 11px;
        }
        .avg-label { text-align: right; color: #374f6b; font-style: italic; }
        .avg-val { font-size: 14px; font-weight: 900; }

        /* Column widths */
        .col-title  { width: 28%; }
        .col-date   { width: 12%; white-space: nowrap; }
        .col-type   { width: 22%; }
        .col-score  { width: 12%; }
        .col-pct    { width: 12%; }
        .col-letter { width: 10%; }

        /* Letter badge */
        .letter-badge {
            display: inline-block;
            padding: 3px 10px;
            border-radius: 5px;
            border: 1.5px solid;
            font-size: 12px;
            font-weight: 900;
        }
        .avg-letter { font-size: 13px; padding: 4px 12px; }

        /* Weight label */
        .weight { color: #94a3b8; font-size: 9.5px; font-weight: 600; }

        /* Admin tag */
        .admin-tag {
            display: inline-block;
            font-size: 8px; font-weight: 700;
            padding: 1px 5px;
            background: #eff6ff; color: #2563eb;
            border: 1px solid #bfdbfe;
            border-radius: 3px;
            vertical-align: middle;
            margin-left: 5px;
        }

        /* ── Overall Average Block ── */
        .overall-block {
            margin: 24px 36px 28px;
            border: 2px solid #1e1b4b;
            border-radius: 10px;
            overflow: hidden;
            page-break-inside: avoid;
        }
        .overall-header {
            background: #1e1b4b;
            color: #fff;
            padding: 10px 20px;
            font-size: 10px; font-weight: 700;
            text-transform: uppercase; letter-spacing: 1.5px;
        }
        .overall-body {
            display: flex;
            align-items: center;
            justify-content: space-between;
            padding: 18px 24px;
            background: #f4f7fb;
        }
        .overall-left { display: flex; align-items: center; gap: 20px; }
        .overall-avg-num { font-size: 52px; font-weight: 900; line-height: 1; }
        .overall-pct-label { font-size: 20px; font-weight: 700; color: #6b84a0; align-self: flex-end; margin-bottom: 6px; }
        .overall-standing { font-size: 14px; font-weight: 700; color: #374f6b; margin-top: 4px; }
        .overall-sub-count { font-size: 10px; color: #94a3b8; font-weight: 500; margin-top: 2px; }
        .overall-right { text-align: right; }
        .overall-letter-badge {
            display: inline-block;
            width: 64px; height: 64px;
            border-radius: 12px;
            border: 3px solid;
            display: flex; align-items: center; justify-content: center;
            font-size: 30px; font-weight: 900;
        }

        /* ── Footer ── */
        .report-footer {
            padding: 14px 36px;
            border-top: 1px solid #dce3ed;
            display: flex;
            justify-content: space-between;
            align-items: center;
            color: #94a3b8;
            font-size: 9px;
        }
        .footer-brand { font-weight: 700; color: #818cf8; }

        /* ── Print ── */
        @media print {
            body { -webkit-print-color-adjust: exact; print-color-adjust: exact; }
            .subject-section { page-break-inside: avoid; }
            .overall-block   { page-break-inside: avoid; }
        }
    </style>
</head>
<body>

    <!-- ── Report Header ── -->
    <div class="report-header">
        <div class="header-left">
            <img src="${logoUrl}" alt="ConnectUs" class="logo" onerror="this.style.display='none'">
            <div class="brand">
                <div class="brand-name">ConnectUs</div>
                <div class="brand-tagline">Academic Platform · Belize</div>
            </div>
        </div>
        <div class="header-right">
            <div class="report-title">Academic Grade Report</div>
            <div class="report-date">Printed: ${printDate}</div>
        </div>
    </div>

    <!-- ── Student Info Bar ── -->
    <div class="student-bar">
        <div class="student-field">
            <span class="field-label">Student</span>
            <span class="field-value">${esc(studentName)}</span>
        </div>
        <div class="student-field">
            <span class="field-label">Class</span>
            <span class="field-value">${esc(studentClass)}</span>
        </div>
        <div class="student-field">
            <span class="field-label">School</span>
            <span class="field-value">${esc(schoolName)}</span>
        </div>
        <div class="student-field">
            <span class="field-label">Term / Period</span>
            <span class="field-value">${esc(semName)}</span>
        </div>
    </div>

    <!-- ── Section Label ── -->
    <div class="section-label">Grades by Subject</div>

    <!-- ── Subject Sections ── -->
    <div class="subjects">
        ${subjectSectionsHtml}
    </div>

    <!-- ── Overall Average ── -->
    ${overall !== null ? `
    <div class="overall-block">
        <div class="overall-header">Term Overall Average</div>
        <div class="overall-body">
            <div class="overall-left">
                <div>
                    <div style="display:flex;align-items:flex-end;gap:4px;">
                        <div class="overall-avg-num" style="color:${overallSt?.color || '#0d1f35'};">${overall}</div>
                        <div class="overall-pct-label">%</div>
                    </div>
                    <div class="overall-standing">${standingTx}</div>
                    <div class="overall-sub-count">${subCount} subject${subCount !== 1 ? 's' : ''} · ${allGrades.length} total assignment${allGrades.length !== 1 ? 's' : ''}</div>
                </div>
            </div>
            <div class="overall-right">
                <div class="overall-letter-badge" style="color:${overallSt?.color || '#374f6b'};background:${overallSt?.bg || '#f1f5f9'};border-color:${overallSt?.border || '#e2e8f0'};">
                    ${overallSt?.letter || '—'}
                </div>
            </div>
        </div>
    </div>` : ''}

    <!-- ── Footer ── -->
    <div class="report-footer">
        <div>Generated by <span class="footer-brand">ConnectUs</span> · Academic Management Platform</div>
        <div>${esc(studentName)} · ${esc(semName)} · ${printDate}</div>
    </div>

</body>
</html>`;

    // ── Open print window ────────────────────────────────────────────────
    const win = window.open('', '_blank');
    if (!win) {
        alert('Pop-ups are blocked. Please allow pop-ups for this site to print the grade report.');
        return;
    }
    win.document.write(html);
    win.document.close();
    win.focus();
    // Brief delay lets the browser fully render before opening print dialog
    setTimeout(() => { win.print(); }, 650);
};

// ── INITIALIZE ────────────────────────────────────────────────────────────
document.addEventListener('DOMContentLoaded', loadGrades);
