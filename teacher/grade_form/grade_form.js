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

// ── 3. INIT ───────────────────────────────────────────────────────────────
document.addEventListener('DOMContentLoaded', async () => {
    // Resilient Date Injection: Looks for exact ID, or falls back to any date input
    const dateInput = document.getElementById('agDate') || document.querySelector('input[type="date"]');
    if (dateInput) {
        dateInput.valueAsDate = new Date();
        dateInput.id = dateInput.id || 'agDate'; // Force ID for later use
    } 

    // Attach Score/Preview Listeners safely
    const scoreInput = document.getElementById('agScore') || document.querySelector('input[placeholder="85"]') || document.querySelectorAll('input[type="number"]')[0];
    const maxInput = document.getElementById('agMax') || document.querySelector('input[placeholder="100"]') || document.querySelectorAll('input[type="number"]')[1];
    
    if (scoreInput) { scoreInput.id = 'agScore'; scoreInput.addEventListener('input', updatePreview); }
    if (maxInput) { maxInput.id = 'agMax'; maxInput.addEventListener('input', updatePreview); }

    // Attach Commit Button Listener
    const commitBtn = document.getElementById('saveGradeBtn') || document.querySelector('button.bg-slate-900') || document.querySelector('button:contains("COMMIT RECORD")');
    if (commitBtn) {
        commitBtn.id = 'saveGradeBtn';
        commitBtn.addEventListener('click', saveGrade);
    }

    // Load Core Data (Term Sync, Grade Types, Student Dropdown)
    await loadSemesters();
    loadGradeTypes(); 
    await loadStudents();
});

// ── 4. LOAD SEMESTERS (TERM SYNC) ─────────────────────────────────────────
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
        let activeName = 'Period';
        try {
            const schoolSnap = await getDoc(doc(db, 'schools', session.schoolId));
            activeId = schoolSnap.data()?.activeSemesterId || '';
            const activeSem = rawSemesters.find(s => s.id === activeId);
            if (activeSem) activeName = activeSem.name;
        } catch(e) {}

        // Fixes the "PERIOD Loading..." in the top header injected by layout-teachers.js
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

        // Also update sidebar/header text elements if they exist
        const sbPeriod = document.getElementById('sb-period');
        if (sbPeriod) sbPeriod.textContent = activeName;
        
        // Update the button text from the screenshot
        const headerPeriodBtn = document.querySelector('.page-header button span');
        if (headerPeriodBtn && headerPeriodBtn.textContent.includes('Loading')) {
            headerPeriodBtn.textContent = activeName;
        }

    } catch (e) { console.error('[TeacherGradeEntry] loadSemesters:', e); }
}

// ── 5. LOAD ROSTER (SEARCHABLE DROPDOWN) ──────────────────────────────────
async function loadStudents() {
    // Find the first select element (assuming it's the student dropdown based on UI)
    const studentSelect = document.getElementById('agStudent') || document.querySelectorAll('select')[0];
    if (!studentSelect) return;
    studentSelect.id = 'agStudent';

    try {
        // Global Root Query: Filter students by this teacher's active roster
        const q = query(
            collection(db, 'students'),
            where('currentSchoolId', '==', session.schoolId),
            where('teacherId', '==', session.teacherId),
            where('enrollmentStatus', '==', 'Active')
        );
        const snap = await getDocs(q);
        
        studentSelect.innerHTML = '<option value="">Select student...</option>';
        snap.forEach(doc => {
            const s = doc.data();
            const opt = document.createElement('option');
            opt.value = doc.id; 
            opt.textContent = `${s.name} (${doc.id})`;
            studentSelect.appendChild(opt);
        });
    } catch (e) {
        console.error('[Grade Form] Failed to load students:', e);
        studentSelect.innerHTML = '<option value="">Error loading roster</option>';
    }
}

// ── 6. LOAD GRADE TYPES & SUBJECTS ────────────────────────────────────────
function loadGradeTypes() {
    const typeSelect = document.getElementById('agType') || document.querySelectorAll('select')[2]; // 3rd select in UI
    const subjectSelect = document.getElementById('agSubject') || document.querySelectorAll('select')[1]; // 2nd select in UI
    
    if (typeSelect) {
        typeSelect.id = 'agType';
        const defaultTypes = [{ name: 'Test' }, { name: 'Quiz' }, { name: 'Assignment' }, { name: 'Homework' }, { name: 'Project' }, { name: 'Final Exam' }];
        const types = session.teacherData.gradeTypes || session.teacherData.customGradeTypes || defaultTypes;
        
        typeSelect.innerHTML = '<option value="">Select type...</option>' + types.filter(t => t).map(t => {
            const name = t.name || (typeof t === 'string' ? t : 'Uncategorized');
            const weight = t.weight ? ` (${t.weight}%)` : '';
            return `<option value="${name}">${name}${weight}</option>`;
        }).join('');
    }

    if (subjectSelect) {
        subjectSelect.id = 'agSubject';
        const subjects = session.teacherData.classes || [session.teacherData.className || 'General'];
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

    // If there's a preview UI element, update it here.
    // (Note: Your screenshot doesn't show the live preview card, but we keep the logic intact if it's hidden)
    const prev = document.getElementById('gradePreview');
    if (prev && !isNaN(score) && !isNaN(max) && max > 0 && score >= 0) {
        const pct = Math.round((score / max) * 100);
        prev.classList.remove('hidden');
        const prevPct = document.getElementById('prevPct');
        if (prevPct) prevPct.textContent = `${pct}%`;
    }
}

// ── 8. SAVE GRADE (THE GLOBAL WRITE) ──────────────────────────────────────
async function saveGrade() {
    const studentId = document.getElementById('agStudent')?.value;
    if (!studentId) { alert('Please select a student from the dropdown.'); return; }

    const subject = document.getElementById('agSubject')?.value || '';
    const type    = document.getElementById('agType')?.value || '';
    const titleEl = document.getElementById('agTitle') || document.querySelector('input[type="text"]');
    const title   = titleEl ? titleEl.value.trim() : 'Untitled Assessment';
    
    const scoreEl = document.getElementById('agScore');
    const maxEl   = document.getElementById('agMax');
    const score   = scoreEl ? parseFloat(scoreEl.value) : NaN;
    const max     = maxEl ? parseFloat(maxEl.value) : NaN;
    
    const dateEl  = document.getElementById('agDate');
    const date    = dateEl ? dateEl.value : new Date().toISOString().split('T')[0];
    
    const notesEl = document.getElementById('agNotes') || document.querySelector('textarea');
    const notes   = notesEl ? notesEl.value.trim() : '';

    // Fallback to active semester if specific dropdown isn't in form
    const semIdEl = document.getElementById('agSemester') || document.getElementById('activeSemester');
    const semId   = semIdEl ? semIdEl.value : (rawSemesters[0]?.id || '');

    if (!subject || !type || !title) {
        alert('Subject, grade type, and title are required.'); return;
    }
    if (isNaN(score) || isNaN(max) || max <= 0 || score < 0 || score > max) {
        alert('Please enter valid score and max values.'); return;
    }

    const btn = document.getElementById('saveGradeBtn');
    if (btn) {
        btn.disabled = true; 
        btn.innerHTML = '<i class="fa-solid fa-spinner fa-spin mr-2"></i> Committing...';
    }

    try {
        // GLOBAL WRITE: Saving to /students/{studentId}/grades
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

        // Reset Form
        if (scoreEl) scoreEl.value = '';
        if (notesEl) notesEl.value = '';
        if (titleEl) titleEl.value = '';
        
        alert('Grade successfully committed to Global Registry!');

    } catch (e) {
        console.error("Save Error:", e);
        alert('System error. Could not commit record.');
    }

    if (btn) {
        btn.disabled = false; 
        btn.innerHTML = '<i class="fa-solid fa-database mr-2 text-xs"></i> COMMIT RECORD';
    }
}
