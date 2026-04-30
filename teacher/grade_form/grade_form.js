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

// Helper: Waits for top-bar injection
async function waitForElement(id, maxTries = 30) {
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

    // UI Defaults
    const dateInput = document.getElementById('eg-date');
    if (dateInput) dateInput.valueAsDate = new Date();

    // Event Listeners
    document.getElementById('eg-score')?.addEventListener('input', updateLivePreview);
    document.getElementById('eg-max')?.addEventListener('input', updateLivePreview);
    document.getElementById('saveGradeBtn')?.addEventListener('click', saveGrade);
    document.getElementById('closeBannerBtn')?.addEventListener('click', () => {
        document.getElementById('gradeSavedBanner').classList.add('hidden');
    });

    // Run fetches
    loadSemestersAndLockStatus(); 
    populateSubjectDropdown();
    populateGradeTypeDropdown();
    populateStudentDropdown(); // Let this run
}

// ── 4. THE STUDENT QUERY (DEBUG VERSION) ────────────────────────────────────
async function populateStudentDropdown() {
    const inputEl = document.getElementById('eg-student-search');
    if (!inputEl) return;

    inputEl.placeholder = "Loading roster...";
    inputEl.disabled = true;

    try {
        const sId = session.schoolId;
        const tId = session.teacherId;

        /**
         * DEBUG ACTION: 
         * I have removed the 'archived' filter. 
         * If students show up now, then your 'archived' field in Firestore is 
         * likely a String ("false") instead of a Boolean (false).
         */
        const stuQuery = query(
            collection(db, 'schools', sId, 'students'),
            where('teacherId', '==', tId)
        );
        
        const stuSnap = await getDocs(stuQuery);
        
        if (stuSnap.empty) {
            console.error("DATABASE EMPTY: No docs found at:", `schools/${sId}/students`, "matching teacherId:", tId);
            inputEl.placeholder = "No students found in database";
            return;
        }

        const students = stuSnap.docs.map(d => ({ 
            value: d.id, 
            label: d.data().name || 'Unnamed Student'
        }));

        students.sort((a, b) => a.label.localeCompare(b.label));

        inputEl.placeholder = "Type student name...";
        inputEl.disabled = false;
        
        setupSearchableDropdown('eg-student-search', 'eg-student', 'eg-student-list', students, 'eg-subject-search');
        handleQuickGrade(students);

    } catch (e) {
        console.error("FIRESTORE ERROR:", e);
        inputEl.placeholder = "Connection Error";
    }
}

// ── 5. SEMESTERS & LAYOUT SYNC ───────────────────────────────────────────────
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

        const schoolSnap = await getDoc(doc(db, 'schools', session.schoolId));
        const activeId = schoolSnap.data()?.activeSemesterId || '';

        const topSemSel = await waitForElement('activeSemester');
        if (topSemSel) {
            topSemSel.innerHTML = '';
            rawSemesters.forEach(s => {
                const opt = document.createElement('option');
                opt.value = s.id;
                opt.textContent = s.name;
                if (s.id === activeId) opt.selected = true;
                topSemSel.appendChild(opt);
            });
            syncSidebarAndLock(topSemSel.value);
            topSemSel.addEventListener('change', (e) => syncSidebarAndLock(e.target.value));
        }
    } catch (e) { console.error("Semester Load Error:", e); }
}

function syncSidebarAndLock(semId) {
    const sbPeriod = document.getElementById('sb-period');
    const semSel = document.getElementById('activeSemester');
    if (sbPeriod && semSel) sbPeriod.textContent = semSel.options[semSel.selectedIndex]?.text;
    
    const activeSem = rawSemesters.find(s => s.id === semId);
    isSemesterLocked = !!activeSem?.isLocked;
    
    const badge = document.getElementById('topbarLockedBadge');
    const btn = document.getElementById('saveGradeBtn');
    const wrap = document.getElementById('enterGradeFormWrap');
    const notice = document.getElementById('lockedGradeNotice');

    if (isSemesterLocked) {
        badge?.classList.remove('hidden');
        if(btn) btn.disabled = true;
        wrap?.classList.add('opacity-50', 'pointer-events-none');
        notice?.classList.remove('hidden');
    } else {
        badge?.classList.add('hidden');
        if(btn) btn.disabled = false;
        wrap?.classList.remove('opacity-50', 'pointer-events-none');
        notice?.classList.add('hidden');
    }
}

// ── 6. DROPDOWN LOGIC ────────────────────────────────────────────────────────
function setupSearchableDropdown(inputId, hiddenId, listId, dataArray, nextFocusId = null) {
    const inputEl = document.getElementById(inputId);
    const hiddenEl = document.getElementById(hiddenId);
    const listEl = document.getElementById(listId);
    if (!inputEl || !listEl) return;

    inputEl.addEventListener('focus', () => {
        listEl.classList.remove('hidden');
        renderList(inputEl.value);
    });

    const renderList = (filter = '') => {
        const filtered = dataArray.filter(i => i.label.toLowerCase().includes(filter.toLowerCase()));
        listEl.innerHTML = filtered.length ? '' : '<li class="p-3 text-gray-400 italic">No matches</li>';
        filtered.forEach(item => {
            const li = document.createElement('li');
            li.className = 'p-3 hover:bg-blue-50 cursor-pointer border-b last:border-0 text-[13px] font-bold';
            li.textContent = item.label;
            li.onmousedown = () => {
                inputEl.value = item.label;
                hiddenEl.value = item.value;
                listEl.classList.add('hidden');
                if(nextFocusId) document.getElementById(nextFocusId)?.focus();
            };
            listEl.appendChild(li);
        });
    };

    inputEl.oninput = (e) => renderList(e.target.value);
    inputEl.onblur = () => setTimeout(() => listEl.classList.add('hidden'), 200);
}

function populateSubjectDropdown() {
    const subjects = (session.teacherData?.subjects || []).filter(s => !s.archived);
    setupSearchableDropdown('eg-subject-search', 'eg-subject', 'eg-subject-list', subjects.map(s => ({ value: s.name, label: s.name })), 'eg-type-search');
}

function populateGradeTypeDropdown() {
    const types = session.teacherData?.customGradeTypes || DEFAULT_GRADE_TYPES;
    setupSearchableDropdown('eg-type-search', 'eg-type', 'eg-type-list', types.map(t => ({ value: t, label: t })), 'eg-title');
}

function handleQuickGrade(students) {
    const qid = sessionStorage.getItem('connectus_quick_grade_student');
    const s = students.find(x => x.value === qid);
    if (s) {
        document.getElementById('eg-student').value = s.value;
        document.getElementById('eg-student-search').value = s.label;
        sessionStorage.removeItem('connectus_quick_grade_student');
    }
}

// ── 7. PREVIEW & SAVE ────────────────────────────────────────────────────────
function updateLivePreview() {
    const score = parseFloat(document.getElementById('eg-score').value);
    const max = parseFloat(document.getElementById('eg-max').value);
    if (!isNaN(score) && !isNaN(max) && max > 0) {
        const pct = Math.round((score / max) * 100);
        document.getElementById('prev-pct').textContent = pct + '%';
        document.getElementById('prev-bar').style.width = Math.min(pct, 100) + '%';
        document.getElementById('prev-bar').style.background = gradeFill(pct);
        document.getElementById('prev-label').textContent = letterGrade(pct);
    }
}

async function saveGrade() {
    if (isSemesterLocked) return;
    const btn = document.getElementById('saveGradeBtn');
    const studentId = document.getElementById('eg-student').value;
    if (!studentId) return alert("Please select a student");

    btn.disabled = true;
    try {
        await addDoc(collection(db, 'schools', session.schoolId, 'students', studentId, 'grades'), {
            teacherId: session.teacherId,
            semesterId: document.getElementById('activeSemester').value,
            subject: document.getElementById('eg-subject').value,
            type: document.getElementById('eg-type').value,
            date: document.getElementById('eg-date').value,
            title: document.getElementById('eg-title').value.trim(),
            score: parseFloat(document.getElementById('eg-score').value),
            max: parseFloat(document.getElementById('eg-max').value),
            createdAt: new Date().toISOString()
        });
        document.getElementById('gradeSavedBanner').classList.remove('hidden');
    } catch (e) { console.error(e); }
    btn.disabled = false;
}

init();
