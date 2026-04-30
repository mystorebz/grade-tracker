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

function escHtml(str) {
    if (!str) return '';
    return String(str)
        .replace(/&/g, '&amp;')
        .replace(/</g, '&lt;')
        .replace(/>/g, '&gt;')
        .replace(/"/g, '&quot;')
        .replace(/'/g, '&#039;');
}

// Helper: Waits for a dynamically injected element without blocking other code
async function waitForElement(id, maxTries = 20) {
    for (let i = 0; i < maxTries; i++) {
        const el = document.getElementById(id);
        if (el) return el;
        await new Promise(r => setTimeout(r, 100));
    }
    return null;
}

// ── 3. INITIALIZATION ───────────────────────────────────────────────────────
async function init() {
    if (!session) return;

    // Set default date immediately
    const dateInput = document.getElementById('eg-date');
    if (dateInput) dateInput.valueAsDate = new Date();

    // Attach Event Listeners
    document.getElementById('eg-score')?.addEventListener('input', updateLivePreview);
    document.getElementById('eg-max')?.addEventListener('input', updateLivePreview);
    document.getElementById('saveGradeBtn')?.addEventListener('click', saveGrade);
    document.getElementById('closeBannerBtn')?.addEventListener('click', () => {
        document.getElementById('gradeSavedBanner').classList.add('hidden');
    });

    /**
     * PARALLEL LOADING:
     * We fire off all data requests at once so they don't block each other.
     */
    loadSemestersAndLockStatus(); // Don't 'await' - let it wait for UI in background
    populateSubjectDropdown();
    populateGradeTypeDropdown();
    populateStudentDropdown();   // Priority fetch
}

// ── 4. SEARCHABLE DROPDOWN ENGINE ──────────────────────────────────────────
function setupSearchableDropdown(inputId, hiddenId, listId, dataArray, nextFocusId = null) {
    const inputEl = document.getElementById(inputId);
    const hiddenEl = document.getElementById(hiddenId);
    const listEl = document.getElementById(listId);
    if (!inputEl || !listEl) return;

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
        if(nextFocusId) document.getElementById(nextFocusId)?.focus();
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
        setTimeout(() => listEl.classList.add('hidden'), 200);
    });
}

// ── 5. POPULATE DROPDOWNS ───────────────────────────────────────────────────
function populateSubjectDropdown() {
    const activeSubjects = (session.teacherData?.subjects || []).filter(s => !s.archived);
    const data = activeSubjects.map(s => ({ value: s.name, label: s.name }));
    setupSearchableDropdown('eg-subject-search', 'eg-subject', 'eg-subject-list', data, 'eg-type-search');
}

function populateGradeTypeDropdown() {
    const types = session.teacherData?.customGradeTypes || DEFAULT_GRADE_TYPES;
    const data = types.map(t => ({ value: t, label: t }));
    setupSearchableDropdown('eg-type-search', 'eg-type', 'eg-type-list', data, 'eg-title');
}

async function populateStudentDropdown() {
    const inputEl = document.getElementById('eg-student-search');
    if (!inputEl) return;

    inputEl.placeholder = "Loading students...";
    inputEl.disabled = true;

    try {
        // Ensure we have IDs before querying
        const sId = session.schoolId;
        const tId = session.teacherId;

        if (!sId || !tId) {
            console.error("Session data missing", session);
            inputEl.placeholder = "Session Error";
            return;
        }

        const stuQuery = query(
            collection(db, 'schools', sId, 'students'),
            where('archived', '==', false),
            where('teacherId', '==', tId)
        );
        
        const stuSnap = await getDocs(stuQuery);
        
        if (stuSnap.empty) {
            console.warn("No students found for query:", { schoolId: sId, teacherId: tId });
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
            const idEl = document.getElementById('eg-student');
            const searchEl = document.getElementById('eg-student-search');
            if(idEl) idEl.value = student.value;
            if(searchEl) searchEl.value = student.label;
            sessionStorage.removeItem('connectus_quick_grade_student'); 
        }
    }
}

// ── 6. SEMESTER & LOCK STATUS (NON-BLOCKING) ────────────────────────────────
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
        } catch(e) { console.warn("Active semester fetch failed", e); }

        // Wait for element without blocking student fetch
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

function checkLockStatus(semestersArray) {
    const semSel = document.getElementById('activeSemester');
    if(!semSel) return;
    
    const semId = semSel.value;
    const activeSem = semestersArray.find(s => s.id === semId);
    isSemesterLocked = activeSem ? !!activeSem.isLocked : false;
    
    const elements = {
        badge: document.getElementById('topbarLockedBadge'),
        btn: document.getElementById('saveGradeBtn'),
        wrap: document.getElementById('enterGradeFormWrap'),
        notice: document.getElementById('lockedGradeNotice')
    };

    if (isSemesterLocked) {
        elements.badge?.classList.replace('hidden', 'flex');
        if(elements.btn) { elements.btn.disabled = true; elements.btn.classList.add('opacity-50', 'cursor-not-allowed'); }
        elements.wrap?.classList.add('opacity-50', 'pointer-events-none', 'grayscale'); 
        elements.notice?.classList.remove('hidden');
    } else {
        elements.badge?.classList.replace('flex', 'hidden');
        if(elements.btn) { elements.btn.disabled = false; elements.btn.classList.remove('opacity-50', 'cursor-not-allowed'); }
        elements.wrap?.classList.remove('opacity-50', 'pointer-events-none', 'grayscale'); 
        elements.notice?.classList.add('hidden');
    }
}

// ── 7. UI PREVIEW ──────────────────────────────────────────────────────────
function updateLivePreview() {
    const score = parseFloat(document.getElementById('eg-score').value);
    const max = parseFloat(document.getElementById('eg-max').value);
    const els = {
        pct: document.getElementById('prev-pct'),
        letter: document.getElementById('prev-letter'),
        bar: document.getElementById('prev-bar'),
        lbl: document.getElementById('prev-label')
    };
    
    if (!isNaN(score) && !isNaN(max) && max > 0 && score >= 0) {
        const pct = Math.round((score / max) * 100);
        const fill = gradeFill(pct);
        const color = pct >= 90 ? 'text-[#0ea871]' : pct >= 80 ? 'text-[#2563eb]' : pct >= 70 ? 'text-[#0891b2]' : pct >= 65 ? 'text-[#b45309]' : 'text-[#e31b4a]';
        const lbg = pct >= 90 ? 'bg-[#edfaf4] border-[#c6f0db] text-[#0ea871]' : pct >= 80 ? 'bg-[#eef4ff] border-[#c7d9fd] text-[#2563eb]' : pct >= 70 ? 'bg-[#ecfeff] border-[#a5f3fc] text-[#0891b2]' : pct >= 65 ? 'bg-[#fffbeb] border-[#fde68a] text-[#b45309]' : 'bg-[#fff0f3] border-[#fecaca] text-[#e31b4a]';
        const lbl = pct >= 90 ? 'Excelling' : pct >= 80 ? 'Good Standing' : pct >= 70 ? 'On Track' : pct >= 65 ? 'Needs Attention' : 'At Risk';
        
        if(els.pct) { els.pct.textContent = pct + '%'; els.pct.className = `text-3xl font-mono font-bold tracking-tight ${color}`; }
        if(els.letter) { els.letter.textContent = letterGrade(pct); els.letter.className = `text-xl font-black px-4 py-1.5 rounded-sm border text-center min-w-[56px] ${lbg}`; }
        if(els.bar) { els.bar.style.width = Math.min(pct, 100) + '%'; els.bar.style.background = fill; }
        if(els.lbl) { els.lbl.textContent = lbl; els.lbl.className = `text-[10px] uppercase tracking-widest font-bold mt-2 ${color}`; }
    } else {
        if(els.pct) { els.pct.textContent = '—'; els.pct.className = 'text-3xl font-mono font-bold text-[#c5d0db]'; }
        if(els.letter) { els.letter.textContent = '—'; els.letter.className = 'text-xl font-black px-4 py-1.5 rounded-sm border border-[#dce3ed] bg-[#f8fafb] text-[#9ab0c6] text-center min-w-[56px]'; }
        if(els.bar) els.bar.style.width = '0%';
        if(els.lbl) { els.lbl.textContent = 'Awaiting Input'; els.lbl.className = 'text-[10px] font-bold uppercase tracking-widest mt-2 text-[#9ab0c6]'; }
    }
}

// ── 8. SAVE GRADE ───────────────────────────────────────────────────────────
async function saveGrade() {
    if (isSemesterLocked) return;

    const studentId = document.getElementById('eg-student').value;
    const subj = document.getElementById('eg-subject').value;
    const type = document.getElementById('eg-type').value;
    const title = document.getElementById('eg-title').value.trim();
    const score = parseFloat(document.getElementById('eg-score').value);
    const max = parseFloat(document.getElementById('eg-max').value);
    const semId = document.getElementById('activeSemester')?.value || '';
    const gdate = document.getElementById('eg-date').value;
    const tNotes = document.getElementById('eg-notes').value.trim();
    
    if (!studentId || !title || !subj || !type || isNaN(score) || isNaN(max)) {
        alert('Please fill all required fields.');
        return;
    }
    
    const btn = document.getElementById('saveGradeBtn');
    if(btn) { btn.innerHTML = `<i class="fa-solid fa-spinner fa-spin mr-2"></i> Committing...`; btn.disabled = true; }
    
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
        
        document.getElementById('eg-student-search')?.focus();
        document.getElementById('eg-student-search')?.select();
    } catch (e) {
        console.error(e);
        alert('Error saving grade.');
    }
    
    if(btn) { btn.innerHTML = `<i class="fa-solid fa-database text-[11px]"></i> Commit Record`; btn.disabled = false; }
}

init();
