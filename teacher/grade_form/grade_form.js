import { db } from '../../assets/js/firebase-init.js';
import { collection, query, where, getDocs, getDoc, doc, addDoc } from "https://www.gstatic.com/firebasejs/10.7.1/firebase-firestore.js";
import { requireAuth } from '../../assets/js/auth.js';
import { injectTeacherLayout } from '../../assets/js/layout-teachers.js';
import { gradeFill, letterGrade } from '../../assets/js/utils.js';

// ── 1. AUTHENTICATION & LAYOUT ──────────────────────────────────────────────
const session = requireAuth('teacher', '../login.html');
if (session) {
    injectTeacherLayout('enter-grade', 'Enter Grade', 'Log a new assignment or assessment', false);
}

// ── 2. STATE VARIABLES ──────────────────────────────────────────────────────
const DEFAULT_GRADE_TYPES = ['Test', 'Quiz', 'Assignment', 'Homework', 'Project', 'Midterm Exam', 'Final Exam'];
let isSemesterLocked = false;

// ── 3. INITIALIZATION ───────────────────────────────────────────────────────
async function init() {
    if (!session) return;

    // Load static UI elements based on Teacher Data
    populateSubjectDropdown();
    populateGradeTypeDropdown();
    document.getElementById('eg-date').valueAsDate = new Date();

    // Attach Event Listeners
    document.getElementById('eg-score').addEventListener('input', updateLivePreview);
    document.getElementById('eg-max').addEventListener('input', updateLivePreview);
    document.getElementById('saveGradeBtn').addEventListener('click', saveGrade);
    document.getElementById('closeBannerBtn').addEventListener('click', () => {
        document.getElementById('gradeSavedBanner').classList.add('hidden');
    });

    await loadSemestersAndLockStatus();
    await populateStudentDropdown();

    // Handle "Quick Grade" handoff from Roster/Subjects page
    const quickGradeStudentId = sessionStorage.getItem('connectus_quick_grade_student');
    if (quickGradeStudentId) {
        const studentSelect = document.getElementById('eg-student');
        // Wait a tiny bit to ensure the DOM is painted and options are loaded
        setTimeout(() => {
            studentSelect.value = quickGradeStudentId;
            sessionStorage.removeItem('connectus_quick_grade_student'); // Clear it so it doesn't trigger again
        }, 100);
    }
}

// ── 4. POPULATE DROPDOWNS ───────────────────────────────────────────────────
function populateSubjectDropdown() {
    const activeSubjects = (session.teacherData.subjects || []).filter(s => !s.archived);
    const egSub = document.getElementById('eg-subject');
    egSub.innerHTML = '<option value="">— Select Subject —</option>' + activeSubjects.map(s => `<option value="${s.name}">${s.name}</option>`).join('');
}

function populateGradeTypeDropdown() {
    const types = session.teacherData.customGradeTypes || DEFAULT_GRADE_TYPES;
    const egType = document.getElementById('eg-type');
    egType.innerHTML = types.map(t => `<option value="${t}">${t}</option>`).join('');
}

async function populateStudentDropdown() {
    const egStudent = document.getElementById('eg-student');
    egStudent.innerHTML = '<option value="">Loading students...</option>';

    try {
        const stuQuery = query(
            collection(db, 'schools', session.schoolId, 'students'),
            where('archived', '==', false),
            where('teacherId', '==', session.teacherId)
        );
        const stuSnap = await getDocs(stuQuery);
        
        if (stuSnap.empty) {
            egStudent.innerHTML = '<option value="">— No active students —</option>';
            return;
        }

        const students = stuSnap.docs.map(d => ({ id: d.id, name: d.data().name }));
        
        // Sort alphabetically by name
        students.sort((a, b) => a.name.localeCompare(b.name));

        egStudent.innerHTML = '<option value="">— Select Student —</option>' + students.map(s => `<option value="${s.id}">${s.name}</option>`).join('');
    } catch (e) {
        console.error("Error loading students:", e);
        egStudent.innerHTML = '<option value="">— Error loading —</option>';
    }
}

// ── 5. SEMESTERS & LOCK STATUS ──────────────────────────────────────────────
async function loadSemestersAndLockStatus() {
    try {
        const semSnap = await getDocs(collection(db, 'schools', session.schoolId, 'semesters'));
        const schoolSnap = await getDoc(doc(db, 'schools', session.schoolId));
        const activeId = schoolSnap.data()?.activeSemesterId || '';

        const rawSemesters = semSnap.docs.map(d => ({ id: d.id, ...d.data() })).sort((a, b) => (a.order || 0) - (b.order || 0));

        const semSel = document.getElementById('activeSemester');
        semSel.innerHTML = '';
        rawSemesters.forEach(s => {
            semSel.innerHTML += `<option value="${s.id}"${s.id === activeId ? ' selected' : ''}>${s.name}</option>`;
        });

        checkLockStatus(rawSemesters);

        // If they change the period in the topbar, update lock status dynamically
        semSel.addEventListener('change', () => { checkLockStatus(rawSemesters); });

    } catch (e) {
        console.error("Error loading semesters:", e);
    }
}

function checkLockStatus(semestersArray) {
    const semId = document.getElementById('activeSemester').value;
    const activeSem = semestersArray.find(s => s.id === semId);
    isSemesterLocked = activeSem ? !!activeSem.isLocked : false;
    
    const badge = document.getElementById('topbarLockedBadge');
    const gradeBtn = document.getElementById('saveGradeBtn');
    const formWrap = document.getElementById('enterGradeFormWrap');
    const lockedNotice = document.getElementById('lockedGradeNotice');

    if (isSemesterLocked) {
        badge.classList.remove('hidden'); badge.classList.add('flex');
        gradeBtn.disabled = true; gradeBtn.classList.add('opacity-50', 'cursor-not-allowed');
        formWrap.classList.add('opacity-60', 'pointer-events-none'); 
        lockedNotice.classList.remove('hidden');
    } else {
        badge.classList.add('hidden'); badge.classList.remove('flex');
        gradeBtn.disabled = false; gradeBtn.classList.remove('opacity-50', 'cursor-not-allowed');
        formWrap.classList.remove('opacity-60', 'pointer-events-none'); 
        lockedNotice.classList.add('hidden');
    }
}

// ── 6. UI PREVIEW LOGIC ─────────────────────────────────────────────────────
function updateLivePreview() {
    const score = parseFloat(document.getElementById('eg-score').value);
    const max = parseFloat(document.getElementById('eg-max').value);
    
    if (!isNaN(score) && !isNaN(max) && max > 0 && score >= 0) {
        const pct = Math.round((score / max) * 100);
        const fill = gradeFill(pct);
        
        const color = pct >= 90 ? 'text-emerald-600' : pct >= 80 ? 'text-blue-600' : pct >= 70 ? 'text-teal-600' : pct >= 65 ? 'text-amber-600' : 'text-red-600';
        const lbg = pct >= 90 ? 'bg-emerald-100 border-emerald-300 text-emerald-700' : pct >= 80 ? 'bg-blue-100 border-blue-300 text-blue-700' : pct >= 70 ? 'bg-teal-100 border-teal-300 text-teal-700' : pct >= 65 ? 'bg-amber-100 border-amber-300 text-amber-700' : 'bg-red-100 border-red-300 text-red-700';
        const lbl = pct >= 90 ? 'Excelling' : pct >= 80 ? 'Good Standing' : pct >= 70 ? 'On Track' : pct >= 65 ? 'Needs Attention' : 'At Risk';
        
        document.getElementById('prev-pct').textContent = pct + '%';
        document.getElementById('prev-pct').className = `text-4xl font-black ${color}`;
        
        document.getElementById('prev-letter').textContent = letterGrade(pct);
        document.getElementById('prev-letter').className = `text-2xl font-black px-5 py-2 rounded-xl border text-center min-w-[64px] ${lbg}`;
        
        document.getElementById('prev-bar').style.width = Math.min(pct, 100) + '%';
        document.getElementById('prev-bar').style.background = fill;
        
        document.getElementById('prev-label').textContent = lbl;
        document.getElementById('prev-label').className = `text-sm font-black mt-2 ${color}`;
    } else {
        // Reset to default empty state
        document.getElementById('prev-pct').textContent = '—';
        document.getElementById('prev-pct').className = 'text-4xl font-black text-slate-300';
        
        document.getElementById('prev-letter').textContent = '—';
        document.getElementById('prev-letter').className = 'text-2xl font-black px-5 py-2 rounded-xl border border-slate-200 bg-slate-50 text-slate-400 text-center min-w-[64px]';
        
        document.getElementById('prev-bar').style.width = '0%';
        
        document.getElementById('prev-label').textContent = 'Enter score to preview';
        document.getElementById('prev-label').className = 'text-sm font-black mt-2 text-slate-400';
    }
}

// ── 7. SAVE GRADE LOGIC ─────────────────────────────────────────────────────
async function saveGrade() {
    if (isSemesterLocked) return;

    const studentId = document.getElementById('eg-student').value;
    const title = document.getElementById('eg-title').value.trim();
    const score = parseFloat(document.getElementById('eg-score').value);
    const max = parseFloat(document.getElementById('eg-max').value);
    const semId = document.getElementById('activeSemester').value;
    const subj = document.getElementById('eg-subject').value;
    const type = document.getElementById('eg-type').value;
    const gdate = document.getElementById('eg-date').value;
    const tNotes = document.getElementById('eg-notes').value.trim();
    
    if (!studentId || !title || !subj || !type || isNaN(score) || isNaN(max)) {
        alert('Please fill all required fields (Student, Subject, Title, Score, and Max).');
        return;
    }
    
    const btn = document.getElementById('saveGradeBtn');
    btn.innerHTML = `<i class="fa-solid fa-spinner fa-spin"></i> Saving...`;
    btn.disabled = true;
    
    try {
        const noteFormatted = tNotes ? `[${new Date().toLocaleDateString()}] ${tNotes}` : '';
        
        await addDoc(collection(db, 'schools', session.schoolId, 'students', studentId, 'grades'), {
            teacherId: session.teacherId,
            semesterId: semId,
            subject: subj,
            type: type,
            date: gdate,
            title: title,
            score: score,
            max: max,
            notes: noteFormatted,
            historyLogs: [],
            createdAt: new Date().toISOString()
        });
        
        // Success: Clear fields except student/subject/date for rapid-fire grading
        document.getElementById('eg-title').value = '';
        document.getElementById('eg-score').value = '';
        document.getElementById('eg-notes').value = '';
        
        updateLivePreview();
        document.getElementById('gradeSavedBanner').classList.remove('hidden');
        
        // Focus back on title for quick entry
        document.getElementById('eg-title').focus();
        
    } catch (e) {
        console.error(e);
        alert('Error saving grade.');
    }
    
    btn.innerHTML = `<i class="fa-solid fa-check-circle"></i> Save Grade to Gradebook`;
    btn.disabled = false;
}

// Fire it up
init();
