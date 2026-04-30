import { db } from '../../assets/js/firebase-init.js';
import { collection, query, where, getDocs, getDoc, doc, addDoc } from "https://www.gstatic.com/firebasejs/10.7.1/firebase-firestore.js";
import { requireAuth } from '../../assets/js/auth.js';
import { injectTeacherLayout } from '../../assets/js/layout-teachers.js';
import { gradeFill, letterGrade } from '../../assets/js/utils.js';

// ── 1. AUTH & LAYOUT ─────────────────────────────────────────────────────────
const session = requireAuth('teacher', '../login.html');
if (session) {
    injectTeacherLayout('enter-grade', 'Enter Grade', 'Log a new assignment', false);
}

// ── 2. STATE ─────────────────────────────────────────────────────────────────
const DEFAULT_GRADE_TYPES = ['Test', 'Quiz', 'Assignment', 'Homework', 'Project', 'Midterm Exam', 'Final Exam'];
let isSemesterLocked = false;
let rawSemesters = [];

/** Waits for top-bar injection to complete so we can find the Period dropdown */
async function waitForElement(id, maxTries = 20) {
    for (let i = 0; i < maxTries; i++) {
        const el = document.getElementById(id);
        if (el) return el;
        await new Promise(r => setTimeout(r, 100));
    }
    return null;
}

// ── 3. INIT ──────────────────────────────────────────────────────────────────
async function init() {
    if (!session) return;

    // 1. Setup UI Defaults
    const dateInput = document.getElementById('eg-date');
    if (dateInput) dateInput.valueAsDate = new Date();

    // 2. Event Listeners
    document.getElementById('eg-score')?.addEventListener('input', updateLivePreview);
    document.getElementById('eg-max')?.addEventListener('input', updateLivePreview);
    document.getElementById('saveGradeBtn')?.addEventListener('click', saveGrade);
    document.getElementById('closeBannerBtn')?.addEventListener('click', () => {
        document.getElementById('gradeSavedBanner').classList.add('hidden');
    });

    // 3. Load Data Sequentially to avoid race conditions
    await loadSemestersAndLockStatus(); // Handles the Term dropdown
    populateSubjectDropdown();
    populateGradeTypeDropdown();
    
    // We await the student dropdown to ensure it finishes before the user can interact
    await populateStudentDropdown(); 
}

// ── 4. STUDENT DROPDOWN (THE FIX) ────────────────────────────────────────────
async function populateStudentDropdown() {
    const inputEl = document.getElementById('eg-student-search');
    if (!inputEl) return;

    inputEl.placeholder = "Loading students...";
    inputEl.disabled = true;

    try {
        // Use the session IDs directly
        const sId = session.schoolId;
        const tId = session.teacherId;

        // Query students belonging to this teacher in this school
        const stuQuery = query(
            collection(db, 'schools', sId, 'students'),
            where('teacherId', '==', tId),
            where('archived', '==', false)
        );
        
        const stuSnap = await getDocs(stuQuery);
        
        if (stuSnap.empty) {
            console.warn("No students found in Firestore for:", { schoolId: sId, teacherId: tId });
            inputEl.placeholder = "No students found in your roster";
            return;
        }

        const students = stuSnap.docs.map(d => ({ 
            value: d.id, 
            label: d.data().name 
        }));

        students.sort((a, b) => a.label.localeCompare(b.label));

        inputEl.placeholder = "Type to search student...";
        inputEl.disabled = false;
        
        setupSearchableDropdown('eg-student-search', 'eg-student', 'eg-student-list', students, 'eg-subject-search');
        handleQuickGrade(students);

    } catch (e) {
        console.error("[Grade Form] Error loading students:", e);
        inputEl.placeholder = "Error loading roster";
    }
}

// ── 5. SEMESTERS & LOCKS ─────────────────────────────────────────────────────
async function loadSemestersAndLockStatus() {
    try {
        const cacheKey = `connectus_semesters_${session.schoolId}`;
        const cached = localStorage.getItem(cacheKey);

        if (cached) {
            rawSemesters = JSON.parse(cached);
        } else {
            const semSnap = await getDocs(collection(db, 'schools', session.schoolId, 'semesters'));
            rawSemesters = semSnap.docs.map(d => ({ id: d.id, ...d.data() }))
                .sort((a, b) => (a.order || 0) - (b.order || 0));
            localStorage.setItem(cacheKey, JSON.stringify(rawSemesters));
        }

        let activeId = '';
        const schoolSnap = await getDoc(doc(db, 'schools', session.schoolId));
        activeId = schoolSnap.data()?.activeSemesterId || '';

        // UI SYNC: Wait for the topbar layout to exist
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
        console.error("[Grade Form] Semester load error:", e);
    }
}

// ── 6. DROPDOWN UTILS ────────────────────────────────────────────────────────
function setupSearchableDropdown(inputId, hiddenId, listId, dataArray, nextFocusId = null) {
    const inputEl = document.getElementById(inputId);
    const hiddenEl = document.getElementById(hiddenId);
    const listEl = document.getElementById(listId);
    if (!inputEl || !listEl) return;

    function renderList(filterText = '') {
        const filtered = dataArray.filter(item => item.label.toLowerCase().includes(filterText.toLowerCase()));
        listEl.innerHTML = '';
        if (filtered.length === 0) {
            listEl.innerHTML = `<li class="p-3 text-[13px] text-[#9ab0c6] italic text-center">No matches</li>`;
            return;
        }
        filtered.forEach((item) => {
            const li = document.createElement('li');
            li.className = 'p-3 text-[13px] text-[#0d1f35] hover:bg-[#eef4ff] hover:text-[#2563eb] cursor-pointer transition-colors border-b border-[#f0f4f8] last:border-0 font-bold';
            li.textContent = item.label;
            li.addEventListener('mousedown', (e) => {
                e.preventDefault(); 
                inputEl.value = item.label;
                hiddenEl.value = item.value;
                listEl.classList.add('hidden');
                if(nextFocusId) document.getElementById(nextFocusId)?.focus();
            });
            listEl.appendChild(li);
        });
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
        setTimeout(() => listEl.classList.add('hidden'), 200);
    });
}

function populateSubjectDropdown() {
    const subjects = (session.teacherData?.subjects || []).filter(s => !s.archived);
    setupSearchableDropdown('eg-subject-search', 'eg-subject', 'eg-subject-list', subjects.map(s => ({ value: s.name, label: s.name })), 'eg-type-search');
}

function populateGradeTypeDropdown() {
    const types = session.teacherData?.customGradeTypes || DEFAULT_GRADE_TYPES;
    setupSearchableDropdown('eg-type-search', 'eg-type', 'eg-type-list', types.map(t => ({ value: t, label: t })), 'eg-title');
}

function handleQuickGrade(studentsData) {
    const qid = sessionStorage.getItem('connectus_quick_grade_student');
    if (qid) {
        const s = studentsData.find(x => x.value === qid);
        if(s) {
            document.getElementById('eg-student').value = s.value;
            document.getElementById('eg-student-search').value = s.label;
            sessionStorage.removeItem('connectus_quick_grade_student'); 
        }
    }
}

function checkLockStatus(semestersArray) {
    const semSel = document.getElementById('activeSemester');
    if(!semSel) return;
    const activeSem = semestersArray.find(s => s.id === semSel.value);
    isSemesterLocked = activeSem ? !!activeSem.isLocked : false;
    const badge = document.getElementById('topbarLockedBadge');
    const btn = document.getElementById('saveGradeBtn');
    const wrap = document.getElementById('enterGradeFormWrap');
    const notice = document.getElementById('lockedGradeNotice');

    if (isSemesterLocked) {
        badge?.classList.replace('hidden', 'flex');
        if(btn) { btn.disabled = true; btn.classList.add('opacity-50'); }
        wrap?.classList.add('opacity-50', 'pointer-events-none'); 
        notice?.classList.remove('hidden');
    } else {
        badge?.classList.replace('flex', 'hidden');
        if(btn) { btn.disabled = false; btn.classList.remove('opacity-50'); }
        wrap?.classList.remove('opacity-50', 'pointer-events-none'); 
        notice?.classList.add('hidden');
    }
}

function updateLivePreview() {
    const score = parseFloat(document.getElementById('eg-score').value);
    const max = parseFloat(document.getElementById('eg-max').value);
    const pctEl = document.getElementById('prev-pct');
    if (!isNaN(score) && !isNaN(max) && max > 0) {
        const pct = Math.round((score / max) * 100);
        if(pctEl) pctEl.textContent = pct + '%';
        document.getElementById('prev-bar').style.width = pct + '%';
        document.getElementById('prev-bar').style.background = gradeFill(pct);
        document.getElementById('prev-label').textContent = letterGrade(pct);
    }
}

async function saveGrade() {
    if (isSemesterLocked) return;
    const data = {
        studentId: document.getElementById('eg-student').value,
        subj: document.getElementById('eg-subject').value,
        type: document.getElementById('eg-type').value,
        title: document.getElementById('eg-title').value.trim(),
        score: parseFloat(document.getElementById('eg-score').value),
        max: parseFloat(document.getElementById('eg-max').value),
        semId: document.getElementById('activeSemester')?.value || '',
        date: document.getElementById('eg-date').value
    };
    
    if (!data.studentId || !data.title || isNaN(data.score)) return alert('Missing fields');
    
    const btn = document.getElementById('saveGradeBtn');
    btn.disabled = true;
    try {
        await addDoc(collection(db, 'schools', session.schoolId, 'students', data.studentId, 'grades'), {
            ...data, teacherId: session.teacherId, createdAt: new Date().toISOString()
        });
        document.getElementById('gradeSavedBanner').classList.remove('hidden');
    } catch (e) { console.error(e); }
    btn.disabled = false;
}

init();
