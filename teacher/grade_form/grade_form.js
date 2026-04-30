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
let rawSemesters = [];

// Helper: Escapes HTML to prevent XSS
function escHtml(str) {
    if (!str) return '';
    return String(str)
        .replace(/&/g, '&amp;')
        .replace(/</g, '&lt;')
        .replace(/>/g, '&gt;')
        .replace(/"/g, '&quot;')
        .replace(/'/g, '&#039;');
}

// Helper: Waits for a dynamically injected element (like the dropdown) to appear
async function waitForElement(id, maxTries = 20) {
    for (let i = 0; i < maxTries; i++) {
        const el = document.getElementById(id);
        if (el) return el;
        await new Promise(r => setTimeout(r, 100)); // Check every 100ms
    }
    return null;
}

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

    // Load Data - We await this specifically
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
            listEl.innerHTML = `<li class="p-3 text-[13px] text-[#9ab0c6] italic text-center">No matches found</li>`;
            return;
        }

        filtered.forEach((item) => {
            const li = document.createElement('li');
            li.className = 'p-3 text-[13px] text-[#0d1f35] hover:bg-[#eef4ff] hover:text-[#2563eb] cursor-pointer transition-colors border-b border-[#f0f4f8] last:border-0 font-bold';
            const regex = new RegExp(`(${filterText})`, "gi");
            li.innerHTML = item.label.replace(regex, `<span class="text-[#2563eb] bg-[#c7d9fd]/50">$1</span>`);
            
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
        if(nextFocusId) document.getElementById(nextFocusId).focus();
    }

    inputEl.addEventListener('input', (e) => {
        hiddenEl.value = ''; 
        listEl.classList.remove('hidden');
        renderList(e.target.value);
    });

    inputEl.addEventListener('focus', () => {
        listEl.classList.remove('hidden');
        renderList(inputEl.value);
        inputEl.select(); 
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
    const types = session.teacherData.customGradeTypes || DEFAULT_GRADE_TYPES;
    const data = types.map(t => ({ value: t, label: t }));
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
        students.sort((a, b) => a.label.localeCompare(b.label));

        inputEl.placeholder = "Type to search student...";
        inputEl.disabled = false;
        setupSearchableDropdown('eg-student-search', 'eg-student', 'eg-student-list', students, 'eg-subject-search');
        handleQuickGrade(students);
    } catch (e) {
        console.error("[Grade Form] Error loading students:", e);
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
        } catch(e) { console.warn("Error getting active semester", e); }

        // FIX: WAIT for the layout to inject before looking for the dropdown
        const topSemSel = await waitForElement('activeSemester');
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
        if(gradeBtn) { gradeBtn.disabled = true; gradeBtn.classList.add('opacity-50', 'cursor-not-allowed'); }
        if(formWrap) formWrap.classList.add('opacity-50', 'pointer-events-none', 'grayscale'); 
        if(lockedNotice) lockedNotice.classList.remove('hidden');
    } else {
        if(badge) { badge.classList.add('hidden'); badge.classList.remove('flex'); }
        if(gradeBtn) { gradeBtn.disabled = false; gradeBtn.classList.remove('opacity-50', 'cursor-not-allowed'); }
        if(formWrap) formWrap.classList.remove('opacity-50', 'pointer-events-none', 'grayscale'); 
        if(lockedNotice) lockedNotice.classList.add('hidden');
    }
}

// ── 7. UI PREVIEW LOGIC (PREMIUM STYLING) ───────────────────────────────────
function updateLivePreview() {
    const score = parseFloat(document.getElementById('eg-score').value);
    const max = parseFloat(document.getElementById('eg-max').value);
    
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
        document.getElementById('prev-label').className = `text-[10px] uppercase tracking-widest font-bold mt-2 ${color}`;
    } else {
        document.getElementById('prev-pct').textContent = '—';
        document.getElementById('prev-pct').className = 'text-3xl font-mono font-bold text-[#c5d0db]';
        document.getElementById('prev-letter').textContent = '—';
        document.getElementById('prev-letter').className = 'text-xl font-black px-4 py-1.5 rounded-sm border border-[#dce3ed] bg-[#f8fafb] text-[#9ab0c6] text-center min-w-[56px]';
        document.getElementById('prev-bar').style.width = '0%';
        document.getElementById('prev-label').textContent = 'Awaiting Input';
        document.getElementById('prev-label').className = 'text-[10px] font-bold uppercase tracking-widest mt-2 text-[#9ab0c6]';
    }
}

// ── 8. SAVE GRADE LOGIC ─────────────────────────────────────────────────────
async function saveGrade() {
    if (isSemesterLocked) return;

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
        alert('Please fill all required fields.');
        return;
    }
    
    const btn = document.getElementById('saveGradeBtn');
    btn.innerHTML = `<i class="fa-solid fa-spinner fa-spin mr-2"></i> Committing...`;
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
        
        document.getElementById('eg-title').value = '';
        document.getElementById('eg-score').value = '';
        document.getElementById('eg-notes').value = '';
        updateLivePreview();
        
        const banner = document.getElementById('gradeSavedBanner');
        if (banner) {
            banner.classList.remove('hidden');
            setTimeout(() => banner.classList.add('hidden'), 5000);
        }
        
        const stuSearch = document.getElementById('eg-student-search');
        stuSearch.focus();
        stuSearch.select();
    } catch (e) {
        console.error(e);
        alert('Error saving grade.');
    }
    
    btn.innerHTML = `<i class="fa-solid fa-database text-[11px]"></i> Commit Record`;
    btn.disabled = false;
}

init();
