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

    document.getElementById('eg-date').valueAsDate = new Date();

    // Attach Event Listeners for UI
    document.getElementById('eg-score').addEventListener('input', updateLivePreview);
    document.getElementById('eg-max').addEventListener('input', updateLivePreview);
    document.getElementById('saveGradeBtn').addEventListener('click', saveGrade);
    document.getElementById('closeBannerBtn').addEventListener('click', () => {
        document.getElementById('gradeSavedBanner').classList.add('hidden');
    });

    // Load Data
    await loadSemestersAndLockStatus();
    populateSubjectDropdown();
    populateGradeTypeDropdown();
    await populateStudentDropdown();
}

// ── 4. INTELLIGENT SEARCHABLE DROPDOWN ENGINE ───────────────────────────────
function setupSearchableDropdown(inputId, hiddenId, listId, dataArray, nextFocusId = null) {
    const inputEl = document.getElementById(inputId);
    const hiddenEl = document.getElementById(hiddenId);
    const listEl = document.getElementById(listId);

    function renderList(filterText = '') {
        const filtered = dataArray.filter(item => item.label.toLowerCase().includes(filterText.toLowerCase()));
        listEl.innerHTML = '';
        
        if (filtered.length === 0) {
            listEl.innerHTML = `<li class="p-3 text-sm text-slate-500 italic text-center">No matches found</li>`;
            return;
        }

        filtered.forEach((item) => {
            const li = document.createElement('li');
            li.className = 'p-3 text-sm text-slate-700 hover:bg-emerald-50 hover:text-emerald-700 cursor-pointer transition-colors border-b border-slate-50 last:border-0 font-semibold';
            
            // Highlight matching text for visual feedback
            const regex = new RegExp(`(${filterText})`, "gi");
            li.innerHTML = item.label.replace(regex, `<span class="text-emerald-600 bg-emerald-100/50">$1</span>`);
            
            li.addEventListener('mousedown', (e) => {
                // mousedown fires before input blur, allowing selection
                e.preventDefault(); 
                selectItem(item);
            });
            listEl.appendChild(li);
        });
    }

    function selectItem(item) {
        inputEl.value = item.label;
        hiddenEl.value = item.value;
        listEl.classList.add('hidden');
        
        // Auto-advance focus to the next logical field for fast data entry
        if(nextFocusId) {
            document.getElementById(nextFocusId).focus();
        }
    }

    // Event Listeners for Interaction
    inputEl.addEventListener('input', (e) => {
        hiddenEl.value = ''; // Clear hidden value if they start altering the text
        listEl.classList.remove('hidden');
        renderList(e.target.value);
    });

    inputEl.addEventListener('focus', () => {
        listEl.classList.remove('hidden');
        renderList(inputEl.value);
        inputEl.select(); // Highlight text so they can easily type over it
    });

    inputEl.addEventListener('blur', () => {
        // Enforce valid selection on blur
        const match = dataArray.find(i => i.label.toLowerCase() === inputEl.value.toLowerCase().trim());
        if(match) {
             hiddenEl.value = match.value;
             inputEl.value = match.label;
        } else {
             inputEl.value = '';
             hiddenEl.value = '';
        }
        listEl.classList.add('hidden');
    });

    // Close dropdowns if clicking anywhere else on the page
    document.addEventListener('click', (e) => {
        if(!inputEl.contains(e.target) && !listEl.contains(e.target)) {
            listEl.classList.add('hidden');
        }
    });
}

// ── 5. POPULATE DROPDOWNS ───────────────────────────────────────────────────
function populateSubjectDropdown() {
    const activeSubjects = (session.teacherData.subjects || []).filter(s => !s.archived);
    const data = activeSubjects.map(s => ({ value: s.name, label: s.name }));
    // Flows into Type search
    setupSearchableDropdown('eg-subject-search', 'eg-subject', 'eg-subject-list', data, 'eg-type-search');
}

function populateGradeTypeDropdown() {
    const types = session.teacherData.customGradeTypes || DEFAULT_GRADE_TYPES;
    const data = types.map(t => ({ value: t, label: t }));
    // Flows into Title input
    setupSearchableDropdown('eg-type-search', 'eg-type', 'eg-type-list', data, 'eg-title');
}

async function populateStudentDropdown() {
    const inputEl = document.getElementById('eg-student-search');
    inputEl.placeholder = "Loading students...";
    inputEl.disabled = true;

    try {
        const stuQuery = query(
            collection(db, 'schools', session.schoolId, 'students'),
            where('archived', '==', false),
            where('teacherId', '==', session.teacherId)
        );
        const stuSnap = await getDocs(stuQuery);
        
        if (stuSnap.empty) {
            inputEl.placeholder = "No active students found";
            return;
        }

        const students = stuSnap.docs.map(d => ({ value: d.id, label: d.data().name }));
        students.sort((a, b) => a.label.localeCompare(b.label)); // Alphabetical

        inputEl.placeholder = "Type to search student...";
        inputEl.disabled = false;
        
        // Flows into Subject search
        setupSearchableDropdown('eg-student-search', 'eg-student', 'eg-student-list', students, 'eg-subject-search');

        // Handle "Quick Grade" handoff from Roster/Subjects page
        handleQuickGrade(students);

    } catch (e) {
        console.error("Error loading students:", e);
        inputEl.placeholder = "Error loading students";
    }
}

function handleQuickGrade(studentsData) {
    const quickGradeStudentId = sessionStorage.getItem('connectus_quick_grade_student');
    if (quickGradeStudentId) {
        const student = studentsData.find(s => s.value === quickGradeStudentId);
        if(student) {
            document.getElementById('eg-student').value = student.value;
            document.getElementById('eg-student-search').value = student.label;
            sessionStorage.removeItem('connectus_quick_grade_student'); 
        }
    }
}

// ── 6. SEMESTERS & LOCK STATUS ──────────────────────────────────────────────
async function loadSemestersAndLockStatus() {
    try {
        const semSnap = await getDocs(collection(db, 'schools', session.schoolId, 'semesters'));
        const schoolSnap = await getDoc(doc(db, 'schools', session.schoolId));
        const activeId = schoolSnap.data()?.activeSemesterId || '';

        const rawSemesters = semSnap.docs.map(d => ({ id: d.id, ...d.data() })).sort((a, b) => (a.order || 0) - (b.order || 0));

        const semSel = document.getElementById('activeSemester');
        if(semSel) {
            semSel.innerHTML = '';
            rawSemesters.forEach(s => {
                semSel.innerHTML += `<option value="${s.id}"${s.id === activeId ? ' selected' : ''}>${s.name}</option>`;
            });
            checkLockStatus(rawSemesters);
            semSel.addEventListener('change', () => { checkLockStatus(rawSemesters); });
        }

    } catch (e) {
        console.error("Error loading semesters:", e);
    }
}

function checkLockStatus(semestersArray) {
    const semSel = document.getElementById('activeSemester');
    if(!semSel) return;
    
    const semId = semSel.value;
    const activeSem = semestersArray.find(s => s.id === semId);
    isSemesterLocked = activeSem ? !!activeSem.isLocked : false;
    
    const badge = document.getElementById('topbarLockedBadge');
    const gradeBtn = document.getElementById('saveGradeBtn');
    const formWrap = document.getElementById('enterGradeFormWrap');
    const lockedNotice = document.getElementById('lockedGradeNotice');

    if (isSemesterLocked) {
        if(badge) { badge.classList.remove('hidden'); badge.classList.add('flex'); }
        gradeBtn.disabled = true; gradeBtn.classList.add('opacity-50', 'cursor-not-allowed');
        formWrap.classList.add('opacity-60', 'pointer-events-none'); 
        lockedNotice.classList.remove('hidden');
    } else {
        if(badge) { badge.classList.add('hidden'); badge.classList.remove('flex'); }
        gradeBtn.disabled = false; gradeBtn.classList.remove('opacity-50', 'cursor-not-allowed');
        formWrap.classList.remove('opacity-60', 'pointer-events-none'); 
        lockedNotice.classList.add('hidden');
    }
}

// ── 7. UI PREVIEW LOGIC ─────────────────────────────────────────────────────
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
        document.getElementById('prev-pct').textContent = '—';
        document.getElementById('prev-pct').className = 'text-4xl font-black text-slate-300';
        document.getElementById('prev-letter').textContent = '—';
        document.getElementById('prev-letter').className = 'text-2xl font-black px-5 py-2 rounded-xl border border-slate-200 bg-slate-50 text-slate-400 text-center min-w-[64px]';
        document.getElementById('prev-bar').style.width = '0%';
        document.getElementById('prev-label').textContent = 'Enter score to preview';
        document.getElementById('prev-label').className = 'text-sm font-black mt-2 text-slate-400';
    }
}

// ── 8. SAVE GRADE LOGIC ─────────────────────────────────────────────────────
async function saveGrade() {
    if (isSemesterLocked) return;

    // Read from the hidden inputs that contain the exact validated selections
    const studentId = document.getElementById('eg-student').value;
    const subj = document.getElementById('eg-subject').value;
    const type = document.getElementById('eg-type').value;
    
    const title = document.getElementById('eg-title').value.trim();
    const score = parseFloat(document.getElementById('eg-score').value);
    const max = parseFloat(document.getElementById('eg-max').value);
    const semId = document.getElementById('activeSemester') ? document.getElementById('activeSemester').value : '';
    const gdate = document.getElementById('eg-date').value;
    const tNotes = document.getElementById('eg-notes').value.trim();
    
    if (!studentId || !title || !subj || !type || isNaN(score) || isNaN(max)) {
        alert('Please fill all required fields (Student, Subject, Type, Title, Score, and Max).');
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
        
        // Success: Clear specific fields for rapid-fire grading but keep selections
        document.getElementById('eg-title').value = '';
        document.getElementById('eg-score').value = '';
        document.getElementById('eg-notes').value = '';
        
        updateLivePreview();
        document.getElementById('gradeSavedBanner').classList.remove('hidden');
        
        // Focus back on student search so they can immediately type the next kid's name
        document.getElementById('eg-student-search').focus();
        document.getElementById('eg-student-search').select();
        
    } catch (e) {
        console.error(e);
        alert('Error saving grade.');
    }
    
    btn.innerHTML = `<i class="fa-solid fa-check-circle"></i> Save Grade to Gradebook`;
    btn.disabled = false;
}

// Fire it up
init();
