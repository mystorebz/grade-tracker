import { db } from '../../assets/js/firebase-init.js';
import { doc, getDoc, getDocs, addDoc, collection } from "https://www.gstatic.com/firebasejs/10.7.1/firebase-firestore.js";
import { requireAuth } from '../../assets/js/auth.js';
import { injectTeacherLayout } from '../../assets/js/layout-teachers.js';
import { letterGrade, gradeFill } from '../../assets/js/utils.js';

// ── 1. AUTH & LAYOUT ──────────────────────────────────────────────────────
const session = requireAuth('teacher', '../login.html');
injectTeacherLayout('grade-entry', 'Enter Grade', 'Log a new grade for a student in your active roster', false);

// ── 2. STATE ──────────────────────────────────────────────────────────────
let foundStudent  = null; 
let rawSemesters  = [];

// ── 3. INIT ───────────────────────────────────────────────────────────────
document.addEventListener('DOMContentLoaded', async () => {
    // 1. Safe Date Injection
    const dateInput = document.getElementById('agDate');
    if (dateInput) {
        dateInput.valueAsDate = new Date();
    } else {
        console.warn("[Grade Form] Element 'agDate' not found in HTML. Skipping auto-date.");
    }
    
    // 2. Load Core Data
    await loadSemesters();
    loadGradeTypes(); // Teacher grade types can load immediately!

    // 3. Safe Event Listener Attachments
    const lookupBtn = document.getElementById('lookupBtn');
    if (lookupBtn) lookupBtn.addEventListener('click', lookupStudent);

    const lookupId = document.getElementById('lookupId');
    if (lookupId) lookupId.addEventListener('keydown', e => { if (e.key === 'Enter') lookupStudent(); });

    const agScore = document.getElementById('agScore');
    if (agScore) agScore.addEventListener('input', updatePreview);

    const agMax = document.getElementById('agMax');
    if (agMax) agMax.addEventListener('input', updatePreview);

    const saveGradeBtn = document.getElementById('saveGradeBtn');
    if (saveGradeBtn) saveGradeBtn.addEventListener('click', saveGrade);

    // 4. Auto-Lookup hook for the "Quick Grade" button on the Roster page
    const quickGradeId = localStorage.getItem('connectus_quick_grade_student');
    if (quickGradeId && lookupId) {
        lookupId.value = quickGradeId;
        lookupStudent();
        localStorage.removeItem('connectus_quick_grade_student'); // Clear it after use
    }
});

// ── 4. LOAD SEMESTERS ─────────────────────────────────────────────────────
async function loadSemesters() {
    try {
        const cacheKey = `connectus_semesters_${session.schoolId}`;
        const cached   = localStorage.getItem(cacheKey);

        if (cached) rawSemesters = JSON.parse(cached);
        else {
            const snap = await getDocs(collection(db, 'schools', session.schoolId, 'semesters'));
            rawSemesters = snap.docs.map(d => ({ id: d.id, ...d.data() })).sort((a, b) => (a.order || 0) - (b.order || 0));
            localStorage.setItem(cacheKey, JSON.stringify(rawSemesters));
        }

        let activeId = '';
        try {
            const schoolSnap = await getDoc(doc(db, 'schools', session.schoolId));
            activeId = schoolSnap.data()?.activeSemesterId || '';
        } catch(e) {}

        const sel = document.getElementById('agSemester');
        if (!sel) return;
        
        sel.innerHTML = '';
        rawSemesters.forEach(s => {
            const opt = document.createElement('option');
            opt.value = s.id; opt.textContent = s.name;
            if (s.id === activeId) opt.selected = true;
            sel.appendChild(opt);
        });
    } catch (e) { console.error('[TeacherGradeEntry] loadSemesters:', e); }
}

// ── 5. LOAD GRADE TYPES (TEACHER SPECIFIC) ────────────────────────────────
function loadGradeTypes() {
    const sel = document.getElementById('agType');
    if (!sel) return;
    
    // Pull exactly what they created in their Settings!
    const defaultTypes = [{ name: 'Test' }, { name: 'Quiz' }, { name: 'Assignment' }, { name: 'Homework' }, { name: 'Project' }, { name: 'Final Exam' }];
    const types = session.teacherData.gradeTypes || session.teacherData.customGradeTypes || defaultTypes;
    
    sel.innerHTML = '<option value="">Select type...</option>' + types.map(t => {
        const name = t.name || t;
        const weight = t.weight ? ` (${t.weight}%)` : '';
        return `<option value="${name}">${name}${weight}</option>`;
    }).join('');
}

// ── 6. STUDENT LOOKUP ─────────────────────────────────────────────────────
async function lookupStudent() {
    const lookupEl = document.getElementById('lookupId');
    if (!lookupEl) return;
    
    const rawId = lookupEl.value.trim().toUpperCase();
    const msgEl = document.getElementById('lookupMsg');
    const badge = document.getElementById('studentBadge');
    const form  = document.getElementById('gradeFormSection');
    if (msgEl) msgEl.classList.add('hidden');

    if (!rawId) { showLookupMsg('Please enter a Student Global ID.'); return; }
    if (!/^S\d{2}-[A-Z0-9]{5}$/.test(rawId)) { showLookupMsg('Invalid format. Student ID should look like S26-XXXXX.'); return; }

    const btn = document.getElementById('lookupBtn');
    if (btn) {
        btn.disabled = true; 
        btn.innerHTML = '<i class="fa-solid fa-spinner fa-spin"></i>';
    }

    try {
        const snap = await getDoc(doc(db, 'students', rawId));
        if (!snap.exists()) { 
            showLookupMsg('No student found with that ID.'); 
            if (btn) { btn.disabled = false; btn.innerHTML = 'Look Up'; }
            return; 
        }

        const data = snap.data();
        
        // Ensure student actually belongs to THIS teacher
        if (data.teacherId !== session.teacherId) {
            showLookupMsg('This student is not assigned to your active roster.');
            if (btn) { btn.disabled = false; btn.innerHTML = 'Look Up'; }
            return;
        }

        if (data.enrollmentStatus !== 'Active') {
            showLookupMsg(`This student's enrollment status is "${data.enrollmentStatus}". Only Active students can receive grades.`);
            if (btn) { btn.disabled = false; btn.innerHTML = 'Look Up'; }
            return;
        }

        foundStudent = { id: snap.id, ...data };
        
        const badgeInitial = document.getElementById('badgeInitial');
        const badgeName = document.getElementById('badgeName');
        const badgeMeta = document.getElementById('badgeMeta');
        const badgeId = document.getElementById('badgeId');
        
        if (badgeInitial) badgeInitial.textContent = (data.name || '?').charAt(0).toUpperCase();
        if (badgeName) badgeName.textContent    = data.name || 'Unknown';
        if (badgeMeta) badgeMeta.textContent    = [data.className || 'Unassigned class', data.dob ? `DOB: ${data.dob}` : ''].filter(Boolean).join(' · ');
        if (badgeId) badgeId.textContent      = snap.id;
        
        if (badge) badge.classList.remove('hidden'); 
        if (form) {
            form.classList.remove('hidden');
            form.scrollIntoView({ behavior: 'smooth', block: 'start' });
        }

    } catch (e) { 
        showLookupMsg('Connection error. Please try again.'); 
    }

    if (btn) {
        btn.disabled = false; 
        btn.innerHTML = 'Look Up';
    }
}

function showLookupMsg(msg) { 
    const el = document.getElementById('lookupMsg'); 
    if (el) {
        el.textContent = msg; 
        el.classList.remove('hidden'); 
    }
}

window.resetLookup = function() {
    foundStudent = null; 
    const lookupId = document.getElementById('lookupId');
    if (lookupId) lookupId.value = '';
    
    const elementsToHide = ['studentBadge', 'gradeFormSection', 'lookupMsg', 'gradeSavedBanner'];
    elementsToHide.forEach(id => {
        const el = document.getElementById(id);
        if (el) el.classList.add('hidden');
    });
};

// ── 7. LIVE PREVIEW ───────────────────────────────────────────────────────
function updatePreview() {
    const scoreEl = document.getElementById('agScore');
    const maxEl = document.getElementById('agMax');
    const prev = document.getElementById('gradePreview');
    
    if (!scoreEl || !maxEl || !prev) return;

    const score = parseFloat(scoreEl.value);
    const max   = parseFloat(maxEl.value);

    if (!isNaN(score) && !isNaN(max) && max > 0 && score >= 0) {
        const pct = Math.round((score / max) * 100);
        const color = pct >= 90 ? 'text-emerald-600' : pct >= 80 ? 'text-blue-600' : pct >= 70 ? 'text-teal-600' : pct >= 65 ? 'text-amber-600' : 'text-red-600';
        const lbg = pct >= 90 ? 'bg-emerald-50 border-emerald-200 text-emerald-600' : pct >= 80 ? 'bg-blue-50 border-blue-200 text-blue-600' : pct >= 70 ? 'bg-teal-50 border-teal-200 text-teal-600' : pct >= 65 ? 'bg-amber-50 border-amber-200 text-amber-600' : 'bg-red-50 border-red-200 text-red-600';
        const lbl = pct >= 90 ? 'Excelling' : pct >= 80 ? 'Good Standing' : pct >= 70 ? 'On Track' : pct >= 65 ? 'Needs Attention' : 'At Risk';

        prev.classList.remove('hidden');
        
        const prevPct = document.getElementById('prevPct');
        if (prevPct) { prevPct.textContent = `${pct}%`; prevPct.className = `text-3xl font-black font-mono ${color}`; }
        
        const prevLetter = document.getElementById('prevLetter');
        if (prevLetter) { prevLetter.textContent = letterGrade(pct); prevLetter.className = `text-xl font-black px-4 py-1.5 rounded-lg border ${lbg}`; }
        
        const prevLabel = document.getElementById('prevLabel');
        if (prevLabel) { prevLabel.textContent = lbl; prevLabel.className = `text-xs font-bold uppercase tracking-widest mt-2 ${color}`; }
    } else { prev.classList.add('hidden'); }
}

// ── 8. SAVE GRADE ─────────────────────────────────────────────────────────
async function saveGrade() {
    if (!foundStudent) { alert('Please look up a student first.'); return; }

    const subjectEl = document.getElementById('agSubject');
    const typeEl = document.getElementById('agType');
    const titleEl = document.getElementById('agTitle');
    const scoreEl = document.getElementById('agScore');
    const maxEl = document.getElementById('agMax');
    const semIdEl = document.getElementById('agSemester');
    const dateEl = document.getElementById('agDate');
    const notesEl = document.getElementById('agNotes');
    const gradeMsg = document.getElementById('gradeMsg');

    if (!subjectEl || !typeEl || !titleEl || !scoreEl || !maxEl || !semIdEl || !dateEl) return;

    const subject = subjectEl.value.trim();
    const type    = typeEl.value;
    const title   = titleEl.value.trim();
    const score   = parseFloat(scoreEl.value);
    const max     = parseFloat(maxEl.value);
    const semId   = semIdEl.value;
    const date    = dateEl.value;
    const notes   = notesEl ? notesEl.value.trim() : '';

    if (!subject || !type || !title) {
        if (gradeMsg) {
            gradeMsg.textContent = 'Subject, grade type, and title are required.';
            gradeMsg.className = 'text-sm font-bold p-3 rounded-xl text-red-600 bg-red-50 border border-red-100';
            gradeMsg.classList.remove('hidden'); 
        }
        return;
    }
    if (isNaN(score) || isNaN(max) || max <= 0 || score < 0 || score > max) {
        if (gradeMsg) {
            gradeMsg.textContent = 'Please enter valid score and max values.';
            gradeMsg.className = 'text-sm font-bold p-3 rounded-xl text-red-600 bg-red-50 border border-red-100';
            gradeMsg.classList.remove('hidden'); 
        }
        return;
    }

    if (gradeMsg) gradeMsg.classList.add('hidden');

    const btn = document.getElementById('saveGradeBtn');
    if (btn) {
        btn.disabled = true; 
        btn.innerHTML = '<i class="fa-solid fa-spinner fa-spin mr-2"></i> Committing...';
    }

    try {
        // Teacher write to global student passport path
        await addDoc(collection(db, 'students', foundStudent.id, 'grades'), {
            schoolId:        session.schoolId,
            teacherId:       session.teacherId,  
            semesterId:      semId,
            subject,
            type,
            date,
            title,
            score,
            max,
            notes,
            historyLogs:     [],
            createdAt:       new Date().toISOString()
        });

        scoreEl.value = '';
        if (notesEl) notesEl.value = '';
        updatePreview();

        const banner = document.getElementById('gradeSavedBanner');
        if (banner) banner.classList.remove('hidden');
        
        subjectEl.focus();

    } catch (e) {
        if (gradeMsg) {
            gradeMsg.textContent = 'System error. Could not commit record.';
            gradeMsg.className = 'text-sm font-bold p-3 rounded-xl text-red-600 bg-red-50 border border-red-100';
            gradeMsg.classList.remove('hidden');
        }
    }

    if (btn) {
        btn.disabled = false; 
        btn.innerHTML = '<i class="fa-solid fa-database mr-2 text-xs"></i>Commit Grade Record';
    }
}
