import { db } from '../../assets/js/firebase-init.js';
import { doc, getDoc, getDocs, addDoc, collection, query, where } from "https://www.gstatic.com/firebasejs/10.7.1/firebase-firestore.js";
import { requireAuth } from '../../assets/js/auth.js';
import { injectTeacherLayout } from '../../assets/js/layout-teachers.js';
import { letterGrade } from '../../assets/js/utils.js';

// ── 1. AUTH & LAYOUT ──────────────────────────────────────────────────────
const session = requireAuth('teacher', '../login.html');
injectTeacherLayout('grade-entry', 'Enter Grade', 'Log a new assignment or assessment into the system', false);

// ── 2. STATE ──────────────────────────────────────────────────────────────
let rawSemesters = [];
const DEFAULT_GRADE_TYPES = ['Test', 'Quiz', 'Assignment', 'Homework', 'Project', 'Midterm Exam', 'Final Exam'];

// ── 3. INIT ───────────────────────────────────────────────────────────────
document.addEventListener('DOMContentLoaded', async () => {
    // Inject Date
    const dateInput = document.getElementById('agDate');
    if (dateInput) dateInput.valueAsDate = new Date();

    // Attach Score/Preview Listeners
    const scoreInput = document.getElementById('agScore');
    const maxInput = document.getElementById('agMax');
    if (scoreInput) scoreInput.addEventListener('input', updatePreview);
    if (maxInput) maxInput.addEventListener('input', updatePreview);

    // Attach Commit Button Listener
    const commitBtn = document.getElementById('saveGradeBtn');
    if (commitBtn) commitBtn.addEventListener('click', saveGrade);

    // Load Core Data
    await loadSemesters();
    loadGradeTypesAndSubjects(); 
    await loadStudents();
});

// ── 4. LOAD SEMESTERS (TERM SYNC) ─────────────────────────────────────────
async function loadSemesters() {
    try {
        const cacheKey = `connectus_semesters_${session.schoolId}`;
        const cached   = localStorage.getItem(cacheKey);

        if (cached) {
            rawSemesters = JSON.parse(cached);
        } else {
            const snap = await getDocs(collection(db, 'schools', session.schoolId, 'semesters'));
            rawSemesters = snap.docs.map(d => ({ id: d.id, ...d.data() })).sort((a, b) => (a.order || 0) - (b.order || 0));
            localStorage.setItem(cacheKey, JSON.stringify(rawSemesters));
        }

        let activeId = '';
        let activeName = 'Period';
        try {
            const schoolSnap = await getDoc(doc(db, 'schools', session.schoolId));
            activeId = schoolSnap.data()?.activeSemesterId || '';
            const activeSem = rawSemesters.find(s => s.id === activeId);
            if (activeSem) activeName = activeSem.name;
        } catch(e) {}

        const activeSemesterSelect = document.getElementById('activeSemester');
        if (activeSemesterSelect) {
            activeSemesterSelect.innerHTML = '';
            rawSemesters.forEach(s => {
                const opt = document.createElement('option');
                opt.value = s.id; opt.textContent = s.name;
                if (s.id === activeId) opt.selected = true;
                activeSemesterSelect.appendChild(opt);
            });
        }

        const sbPeriod = document.getElementById('sb-period');
        if (sbPeriod) sbPeriod.textContent = activeName;

    } catch (e) { console.error('[TeacherGradeEntry] loadSemesters:', e); }
}

// ── 5. LOAD ROSTER (GLOBAL DB FETCH + JS FILTER) ──────────────────────────
async function loadStudents() {
    const studentSelect = document.getElementById('agStudent');
    if (!studentSelect) return;

    try {
        // Safe Query exactly matching roster.js
        const q = query(
            collection(db, 'students'),
            where('currentSchoolId', '==', session.schoolId),
            where('enrollmentStatus', '==', 'Active')
        );
        const snap = await getDocs(q);
        
        // Filter by Teacher inside JS exactly matching roster.js
        const teacherStudents = snap.docs
            .map(d => ({ id: d.id, ...d.data() }))
            .filter(s => s.teacherId === session.teacherId);
        
        studentSelect.innerHTML = '<option value="">Select student...</option>';
        teacherStudents.forEach(s => {
            const opt = document.createElement('option');
            opt.value = s.id;
            opt.textContent = `${s.name} (${s.id})`;
            studentSelect.appendChild(opt);
        });

    } catch (e) {
        console.error('[Grade Form] Failed to load students:', e);
        studentSelect.innerHTML = '<option value="">Error loading roster</option>';
    }
}

// ── 6. LOAD GRADE TYPES & SUBJECTS (FROM TEACHER PROFILE) ─────────────────
function loadGradeTypesAndSubjects() {
    // 1. Grade Types
    const typeSelect = document.getElementById('agType');
    if (typeSelect) {
        // Matching roster.js: session.teacherData.customGradeTypes || DEFAULT_GRADE_TYPES
        const types = session.teacherData.customGradeTypes || session.teacherData.gradeTypes || DEFAULT_GRADE_TYPES;
        
        typeSelect.innerHTML = '<option value="">Select type...</option>' + types.filter(t => t).map(t => {
            const name = t.name || (typeof t === 'string' ? t : 'Uncategorized');
            return `<option value="${name}">${name}</option>`;
        }).join('');
    }

    // 2. Subjects
    const subjectSelect = document.getElementById('agSubject');
    if (subjectSelect) {
        // Matching roster.js: getActiveSubjects() or getClasses()
        let subjects = [];
        if (session.teacherData.subjects && session.teacherData.subjects.length > 0) {
            subjects = session.teacherData.subjects.filter(s => !s.archived).map(s => s.name);
        } else {
            subjects = session.teacherData.classes || [session.teacherData.className || 'General'];
        }

        subjectSelect.innerHTML = '<option value="">Select subject...</option>' + subjects.filter(Boolean).map(sub => {
            return `<option value="${sub}">${sub}</option>`;
        }).join('');
    }
}

// ── 7. LIVE PREVIEW ───────────────────────────────────────────────────────
function updatePreview() {
    const scoreEl = document.getElementById('agScore');
    const maxEl = document.getElementById('agMax');
    if (!scoreEl || !maxEl) return;

    const score = parseFloat(scoreEl.value);
    const max   = parseFloat(maxEl.value);

    const prev = document.getElementById('gradePreview');
    if (prev && !isNaN(score) && !isNaN(max) && max > 0 && score >= 0) {
        const pct = Math.round((score / max) * 100);
        
        prev.classList.remove('hidden');
        
        const prevPct = document.getElementById('prevPct');
        if (prevPct) prevPct.textContent = `${pct}%`;
        
        const prevLetter = document.getElementById('prevLetter');
        if (prevLetter) prevLetter.textContent = letterGrade(pct);
        
        const prevBar = document.getElementById('prevBar');
        if (prevBar) {
            prevBar.style.width = `${pct}%`;
            prevBar.className = `h-full rounded-none transition-all duration-300 ${pct >= 90 ? 'bg-emerald-500' : pct >= 80 ? 'bg-blue-500' : pct >= 70 ? 'bg-teal-500' : pct >= 65 ? 'bg-amber-500' : 'bg-red-500'}`;
        }
    } else if (prev) {
        prev.classList.add('hidden');
    }
}

// ── 8. SAVE GRADE (THE GLOBAL WRITE) ──────────────────────────────────────
async function saveGrade() {
    const studentId = document.getElementById('agStudent')?.value;
    if (!studentId) { alert('Please select a student from the dropdown.'); return; }

    const subject = document.getElementById('agSubject')?.value || '';
    const type    = document.getElementById('agType')?.value || '';
    const title   = document.getElementById('agTitle')?.value.trim() || 'Untitled Assessment';
    
    const scoreEl = document.getElementById('agScore');
    const maxEl   = document.getElementById('agMax');
    const score   = scoreEl ? parseFloat(scoreEl.value) : NaN;
    const max     = maxEl ? parseFloat(maxEl.value) : NaN;
    
    const dateEl  = document.getElementById('agDate');
    const date    = dateEl ? dateEl.value : new Date().toISOString().split('T')[0];
    
    const notesEl = document.getElementById('agNotes');
    const notes   = notesEl ? notesEl.value.trim() : '';

    const semIdEl = document.getElementById('activeSemester');
    const semId   = semIdEl ? semIdEl.value : (rawSemesters[0]?.id || '');

    if (!subject || !type || !title) { alert('Subject, grade type, and title are required.'); return; }
    if (isNaN(score) || isNaN(max) || max <= 0 || score < 0 || score > max) { alert('Please enter valid score and max values.'); return; }

    const btn = document.getElementById('saveGradeBtn');
    if (btn) {
        btn.disabled = true; 
        btn.innerHTML = '<i class="fa-solid fa-spinner fa-spin mr-2"></i> Committing...';
    }

    try {
        await addDoc(collection(db, 'students', studentId, 'grades'), {
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

        // Clear only the fields necessary for the next grade entry
        if (scoreEl) scoreEl.value = '';
        if (notesEl) notesEl.value = '';
        document.getElementById('agTitle').value = '';
        
        // Hide preview
        const prev = document.getElementById('gradePreview');
        if (prev) prev.classList.add('hidden');

        // Show success banner
        const banner = document.getElementById('gradeSavedBanner');
        if (banner) banner.classList.remove('hidden');

    } catch (e) {
        console.error("Save Error:", e);
        alert('System error. Could not commit record.');
    }

    if (btn) {
        btn.disabled = false; 
        btn.innerHTML = '<i class="fa-solid fa-database mr-2 text-xs"></i> COMMIT RECORD';
    }
}
