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
    const dateInput = document.getElementById('agDate');
    if (dateInput) dateInput.valueAsDate = new Date();

    const scoreInput = document.getElementById('agScore');
    const maxInput = document.getElementById('agMax');
    if (scoreInput) scoreInput.addEventListener('input', updatePreview);
    if (maxInput) maxInput.addEventListener('input', updatePreview);

    const commitBtn = document.getElementById('saveGradeBtn');
    if (commitBtn) commitBtn.addEventListener('click', saveGrade);

    await loadSemesters();
    loadGradeTypesAndSubjects(); 
    await loadStudents();
});

// ── 4. SEARCHABLE DROPDOWN ENGINE (NO HTML CHANGES REQUIRED) ──────────────
function makeSearchable(selectId) {
    const select = document.getElementById(selectId);
    if (!select) return;

    const isWrapped = select.parentNode.classList.contains('searchable-wrapper');
    let wrapper, input, list;

    if (!isWrapped) {
        // Hide native select and build the searchable UI dynamically
        select.style.display = 'none';
        wrapper = document.createElement('div');
        wrapper.className = 'searchable-wrapper relative w-full';
        select.parentNode.insertBefore(wrapper, select);
        wrapper.appendChild(select);

        input = document.createElement('input');
        input.type = 'text';
        // Copy original Tailwind styles so it looks identical to your design
        input.className = select.className.replace('appearance-none', '').replace('form-select', '') + ' form-input pr-8';
        input.placeholder = select.options[0]?.text || 'Select...';
        
        const icon = document.createElement('div');
        icon.className = 'absolute right-2.5 top-2.5 text-[#9ab0c6] pointer-events-none';
        icon.innerHTML = '<i class="fa-solid fa-caret-down text-[10px]"></i>';

        list = document.createElement('ul');
        list.className = 'absolute z-50 w-full mt-1 bg-white border border-[#dce3ed] rounded-sm shadow-lg max-h-52 overflow-y-auto hidden';
        
        wrapper.appendChild(input);
        wrapper.appendChild(icon);
        wrapper.appendChild(list);

        // UI Interactions
        input.addEventListener('focus', () => {
            input.value = ''; // Clear text to show all options
            updateList('');
            list.classList.remove('hidden');
        });

        input.addEventListener('blur', () => {
            // Slight delay so the click event on the list registers before hiding
            setTimeout(() => {
                list.classList.add('hidden');
                const selectedOpt = select.options[select.selectedIndex];
                input.value = (selectedOpt && selectedOpt.value) ? selectedOpt.text : '';
            }, 150);
        });

        input.addEventListener('input', (e) => {
            updateList(e.target.value);
            list.classList.remove('hidden');
        });

        select.wrapperRef = { input, list }; // Save reference for resetting the form later
    } else {
        wrapper = select.parentNode;
        input = select.wrapperRef.input;
        list = select.wrapperRef.list;
        input.placeholder = select.options[0]?.text || 'Select...';
    }

    // Filter Logic
    function updateList(filter) {
        list.innerHTML = '';
        let hasResults = false;
        Array.from(select.options).forEach(opt => {
            if (opt.value === '') return; // Skip placeholder
            if (opt.text.toLowerCase().includes(filter.toLowerCase())) {
                hasResults = true;
                const li = document.createElement('li');
                li.className = 'p-2 hover:bg-slate-100 cursor-pointer text-[13px] text-[#0d1f35] border-b border-[#f0f4f8] last:border-0';
                li.textContent = opt.text;
                li.onmousedown = (e) => {
                    e.preventDefault(); 
                    input.value = opt.text;
                    select.value = opt.value;
                    list.classList.add('hidden');
                };
                list.appendChild(li);
            }
        });
        if (!hasResults) {
            list.innerHTML = '<li class="p-2 text-[13px] text-[#6b84a0] italic">No results found</li>';
        }
    }

    // Set initial load value
    const selectedOpt = select.options[select.selectedIndex];
    input.value = (selectedOpt && selectedOpt.value) ? selectedOpt.text : '';
}

// ── 5. LOAD SEMESTERS ─────────────────────────────────────────────────────
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

// ── 6. LOAD ROSTER ────────────────────────────────────────────────────────
async function loadStudents() {
    const studentSelect = document.getElementById('agStudent');
    if (!studentSelect) return;

    try {
        const q = query(
            collection(db, 'students'),
            where('currentSchoolId', '==', session.schoolId),
            where('enrollmentStatus', '==', 'Active')
        );
        const snap = await getDocs(q);
        
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

        // Trigger the searchable UI
        makeSearchable('agStudent');

    } catch (e) {
        console.error('[Grade Form] Failed to load students:', e);
        studentSelect.innerHTML = '<option value="">Error loading roster</option>';
    }
}

// ── 7. LOAD GRADE TYPES & SUBJECTS ────────────────────────────────────────
function loadGradeTypesAndSubjects() {
    const typeSelect = document.getElementById('agType');
    if (typeSelect) {
        const types = session.teacherData.customGradeTypes || session.teacherData.gradeTypes || DEFAULT_GRADE_TYPES;
        typeSelect.innerHTML = '<option value="">Select type...</option>' + types.filter(t => t).map(t => {
            const name = t.name || (typeof t === 'string' ? t : 'Uncategorized');
            return `<option value="${name}">${name}</option>`;
        }).join('');
        
        // Trigger the searchable UI
        makeSearchable('agType');
    }

    const subjectSelect = document.getElementById('agSubject');
    if (subjectSelect) {
        let subjects = [];
        if (session.teacherData.subjects && session.teacherData.subjects.length > 0) {
            subjects = session.teacherData.subjects.filter(s => !s.archived).map(s => s.name);
        } else {
            subjects = session.teacherData.classes || [session.teacherData.className || 'General'];
        }

        subjectSelect.innerHTML = '<option value="">Select subject...</option>' + subjects.filter(Boolean).map(sub => {
            return `<option value="${sub}">${sub}</option>`;
        }).join('');
        
        // Trigger the searchable UI
        makeSearchable('agSubject');
    }
}

// ── 8. LIVE PREVIEW ───────────────────────────────────────────────────────
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

// ── 9. SAVE GRADE ─────────────────────────────────────────────────────────
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

        // Clear regular inputs
        if (scoreEl) scoreEl.value = '';
        if (notesEl) notesEl.value = '';
        document.getElementById('agTitle').value = '';
        
        // Reset Searchable Dropdowns back to placeholder empty state
        ['agStudent', 'agSubject', 'agType'].forEach(id => {
            const el = document.getElementById(id);
            if (el) {
                el.value = '';
                if (el.wrapperRef) el.wrapperRef.input.value = '';
            }
        });
        
        const prev = document.getElementById('gradePreview');
        if (prev) prev.classList.add('hidden');

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
