import { db } from '../../assets/js/firebase-init.js';
import { collection, query, where, getDocs, getDoc, doc, addDoc } from "https://www.gstatic.com/firebasejs/10.7.1/firebase-firestore.js";
import { requireAuth } from '../../assets/js/auth.js';
import { injectTeacherLayout } from '../../assets/js/layout-teachers.js';
import { gradeFill, letterGrade } from '../../assets/js/utils.js';

// ── 1. AUTHENTICATION & LAYOUT ──────────────────────────────────────────────
const session = requireAuth('teacher', '../login.html');
if (session) {
    injectTeacherLayout('enter-grade', 'Enter Grade', 'Log a new assignment or assessment into the system', false);
}

// ── 2. STATE VARIABLES ──────────────────────────────────────────────────────
const DEFAULT_GRADE_TYPES = ['Test', 'Quiz', 'Assignment', 'Homework', 'Project', 'Midterm Exam', 'Final Exam'];
let isSemesterLocked = false;
let rawSemesters = [];

// Escapes HTML to prevent XSS
function escHtml(str) {
    if (!str) return '';
    return String(str)
        .replace(/&/g, '&amp;')
        .replace(/</g, '&lt;')
        .replace(/>/g, '&gt;')
        .replace(/"/g, '&quot;')
        .replace(/'/g, '&#039;');
}

// ── 3. INITIALIZATION ───────────────────────────────────────────────────────
async function init() {
    if (!session) return;

    document.getElementById('eg-date').valueAsDate = new Date();

    // Attach Event Listeners for UI
    const scoreInput = document.getElementById('eg-score');
    const maxInput = document.getElementById('eg-max');

    // Run validation on input to prevent bad keystrokes
    scoreInput.addEventListener('input', validateAndPreview);
    maxInput.addEventListener('input', validateAndPreview);

    // Prevent non-numeric characters (like 'e', '+', '-') from being typed
    scoreInput.addEventListener('keydown', restrictNumeric);
    maxInput.addEventListener('keydown', restrictNumeric);
    
    // Allow pressing "Enter" on the score box to trigger save
    scoreInput.addEventListener('keypress', function (e) {
        if (e.key === 'Enter') {
            e.preventDefault();
            saveGrade();
        }
    });

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

// ── 4. INTELLIGENT COMBOBOX ENGINE ──────────────────────────────────────────
function setupSearchableDropdown(inputId, hiddenId, listId, dataArray, nextFocusId = null) {
    const inputEl = document.getElementById(inputId);
    const hiddenEl = document.getElementById(hiddenId);
    const listEl = document.getElementById(listId);

    function renderList(filterText = '') {
        const filtered = dataArray.filter(item => item.label.toLowerCase().includes(filterText.toLowerCase()));
        listEl.innerHTML = '';
        
        if (filtered.length === 0) {
            listEl.innerHTML = `<li class="p-2.5 text-[12px] text-[#9ab0c6] italic text-center">No matches found</li>`;
            return;
        }

        filtered.forEach((item) => {
            const li = document.createElement('li');
            li.className = 'p-2.5 text-[13px] text-[#0d1f35] hover:bg-[#eef4ff] hover:text-[#2563eb] cursor-pointer transition-colors border-b border-[#f0f4f8] last:border-0 font-bold';
            
            // Highlight matching text
            if (filterText) {
                const regex = new RegExp(`(${filterText})`, "gi");
                li.innerHTML = item.label.replace(regex, `<span class="text-[#2563eb] bg-[#eef4ff]">$1</span>`);
            } else {
                li.innerHTML = item.label;
            }
            
            li.addEventListener('mousedown', (e) => {
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
        
        if(nextFocusId) {
            document.getElementById(nextFocusId).focus();
        }
    }

    // Combobox Behavior: Click or Focus opens the full list
    inputEl.addEventListener('click', () => {
        listEl.classList.remove('hidden');
        renderList(''); // Show all
        inputEl.select();
    });

    inputEl.addEventListener('focus', () => {
        listEl.classList.remove('hidden');
        renderList(''); // Show all
        inputEl.select();
    });

    inputEl.addEventListener('input', (e) => {
        hiddenEl.value = ''; 
        listEl.classList.remove('hidden');
        renderList(e.target.value);
    });

    inputEl.addEventListener('blur', () => {
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
    setupSearchableDropdown('eg-subject-search', 'eg-subject', 'eg-subject-list', data, 'eg-type-search');
}

function populateGradeTypeDropdown() {
    let types = session.teacherData.customGradeTypes || DEFAULT_GRADE_TYPES;
    const data = types.map(t => ({ value: t, label: t }));
    setupSearchableDropdown('eg-type-search', 'eg-type', 'eg-type-list', data, 'eg-title');
}

async function populateStudentDropdown() {
    const inputEl = document.getElementById('eg-student-search');
    inputEl.placeholder = "Loading database...";
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
        students.sort((a, b) => a.label.localeCompare(b.label));

        inputEl.placeholder = "Select student...";
        inputEl.disabled = false;
        
        setupSearchableDropdown('eg-student-search', 'eg-student', 'eg-student-list', students, 'eg-score');
        handleQuickGrade(students);

    } catch (e) {
        console.error("[Grade Form] Error loading students:", e);
        inputEl.placeholder = "System error loading students";
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

// ── 6. STANDARDIZED SEMESTER & LOCK STATUS ──────────────────────────────────
async function loadSemestersAndLockStatus() {
    try {
        const cacheKey = `connectus_semesters_${session.schoolId}`;
        const cached = localStorage.getItem(cacheKey);

        if (cached) {
            rawSemesters = JSON.parse(cached);
        } else {
            const semSnap = await getDocs(collection(db, 'schools', session.schoolId, 'semesters'));
            rawSemesters = semSnap.docs.map(d => ({ id: d.id, ...d.data() })).sort((a, b) => (a.order || 0) - (b.order || 0));
            localStorage.setItem(cacheKey, JSON.stringify(rawSemesters));
        }

        let activeId = '';
        try {
            const schoolSnap = await getDoc(doc(db, 'schools', session.schoolId));
            activeId = schoolSnap.data()?.activeSemesterId || '';
        } catch(e) {}

        const topSemSel = document.getElementById('activeSemester');
        const sbPeriod = document.getElementById('sb-period');
        
        if (topSemSel) {
            topSemSel.innerHTML = '';
            rawSemesters.forEach(s => {
                const opt = document.createElement('option');
                opt.value = s.id;
                opt.textContent = s.name;
                if (s.id === activeId) opt.selected = true;
                topSemSel.appendChild(opt);
            });
            
            if (sbPeriod) sbPeriod.textContent = topSemSel.options[topSemSel.selectedIndex]?.text || '—';
            
            checkLockStatus(rawSemesters);

            topSemSel.addEventListener('change', () => {
                if (sbPeriod) sbPeriod.textContent = topSemSel.options[topSemSel.selectedIndex]?.text || '—';
                checkLockStatus(rawSemesters);
            });
        }
    } catch (e) {
        console.error("[Grade Form] Error loading semesters:", e);
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
        gradeBtn.disabled = true; 
        gradeBtn.classList.add('opacity-50', 'cursor-not-allowed');
        formWrap.classList.add('opacity-50', 'pointer-events-none', 'grayscale'); 
        lockedNotice.classList.remove('hidden');
    } else {
        if(badge) { badge.classList.add('hidden'); badge.classList.remove('flex'); }
        gradeBtn.disabled = false; 
        gradeBtn.classList.remove('opacity-50', 'cursor-not-allowed');
        formWrap.classList.remove('opacity-50', 'pointer-events-none', 'grayscale'); 
        lockedNotice.classList.add('hidden');
    }
}

// ── 7. UI PREVIEW & MATH VALIDATION ─────────────────────────────────────────

// Helper to block keyboard inputs like 'e' and '-' in the number field
function restrictNumeric(e) {
    if (['e', 'E', '+', '-'].includes(e.key)) {
        e.preventDefault();
    }
}

function validateAndPreview() {
    const scoreInput = document.getElementById('eg-score');
    const maxInput = document.getElementById('eg-max');

    // Parse current values
    let score = parseFloat(scoreInput.value);
    let max = parseFloat(maxInput.value);

    // Default max to 1 if it's wiped out so we don't divide by zero
    if (isNaN(max) || max <= 0) {
        max = 1;
    }

    // 1. Enforce Minimums (No negatives)
    if (score < 0) {
        score = 0;
        scoreInput.value = score;
    }

    // 2. Enforce Maximums (Cannot exceed Max possible points)
    if (score > max) {
        score = max;
        scoreInput.value = score;
    }

    // Pass the clean, validated numbers to the visual preview engine
    updateLivePreviewUI(score, max);
}


function updateLivePreviewUI(score, max) {
    if (!isNaN(score) && !isNaN(max) && max > 0 && score >= 0) {
        const pct = Math.round((score / max) * 100);
        const fill = gradeFill(pct);
        
        const color = pct >= 90 ? 'text-[#0ea871]' : pct >= 80 ? 'text-[#2563eb]' : pct >= 70 ? 'text-[#0891b2]' : pct >= 65 ? 'text-[#b45309]' : 'text-[#e31b4a]';
        const lbg = pct >= 90 ? 'bg-[#edfaf4] border-[#c6f0db] text-[#0ea871]' : pct >= 80 ? 'bg-[#eef4ff] border-[#c7d9fd] text-[#2563eb]' : pct >= 70 ? 'bg-[#ecfeff] border-[#a5f3fc] text-[#0891b2]' : pct >= 65 ? 'bg-[#fffbeb] border-[#fde68a] text-[#b45309]' : 'bg-[#fff0f3] border-[#fecaca] text-[#e31b4a]';
        const lbl = pct >= 90 ? 'Excelling' : pct >= 80 ? 'Good Standing' : pct >= 70 ? 'On Track' : pct >= 65 ? 'Needs Attention' : 'At Risk';
        
        document.getElementById('prev-pct').textContent = pct + '%';
        document.getElementById('prev-pct').className = `text-3xl font-mono font-bold tracking-tight ${color}`;
        
        document.getElementById('prev-letter').textContent = letterGrade(pct);
        document.getElementById('prev-letter').className = `text-xl font-black px-4 py-1.5 rounded-sm border text-center min-w-[56px] ${lbg}`;
        
        document.getElementById('prev-bar').style.width = Math.min(pct, 100) + '%';
        document.getElementById('prev-bar').style.background = fill;
        
        document.getElementById('prev-label').textContent = lbl;
        document.getElementById('prev-label').className = `text-[10px] font-bold uppercase tracking-widest mt-2 ${color}`;
    } else {
        document.getElementById('prev-pct').textContent = '—';
        document.getElementById('prev-pct').className = 'text-3xl font-mono font-bold text-[#c5d0db]';
        document.getElementById('prev-letter').textContent = '—';
        document.getElementById('prev-letter').className = 'text-xl font-black px-4 py-1.5 rounded-sm border border-[#dce3ed] bg-[#f8fafb] text-[#9ab0c6] text-center min-w-[56px]';
        document.getElementById('prev-bar').style.width = '0%';
        document.getElementById('prev-label').textContent = 'Awaiting Input';
        document.getElementById('prev-label').className = 'text-[10px] font-bold uppercase tracking-widest mt-2 text-[#9ab0c6] m-0';
    }
}

// ── 8. SAVE GRADE LOGIC (STACK OF PAPERS WORKFLOW) ──────────────────────────
async function saveGrade() {
    if (isSemesterLocked) return;

    // Call the validation one final time just in case
    validateAndPreview();

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
    btn.innerHTML = `<i class="fa-solid fa-spinner fa-spin mr-2"></i> Committing Record...`;
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
        
        // ── STACK OF PAPERS RESET ──
        // Clear ONLY Student, Score, and Notes. Keep the rest for the next paper in the stack.
        document.getElementById('eg-student-search').value = '';
        document.getElementById('eg-student').value = '';
        document.getElementById('eg-score').value = '';
        document.getElementById('eg-notes').value = '';
        
        validateAndPreview();
        
        const banner = document.getElementById('gradeSavedBanner');
        if (banner) {
            banner.classList.remove('hidden');
            setTimeout(() => banner.classList.add('hidden'), 5000); 
        }
        
        // Auto-focus back to student search for keyboard-only speed entry
        const stuSearch = document.getElementById('eg-student-search');
        stuSearch.focus();
        
    } catch (e) {
        console.error(e);
        alert('System Error: Could not commit record.');
    }
    
    btn.innerHTML = `<i class="fa-solid fa-database text-[11px]"></i> Commit Record`;
    btn.disabled = false;
}

// Fire it up
init();
