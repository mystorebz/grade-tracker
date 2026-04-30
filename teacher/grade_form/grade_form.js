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
    // Inject Date
    const dateInput = document.getElementById('eg-date');
    if (dateInput) dateInput.valueAsDate = new Date();

    // Attach Score/Preview Listeners
    const scoreInput = document.getElementById('eg-score');
    const maxInput = document.getElementById('eg-max');
    if (scoreInput) scoreInput.addEventListener('input', updatePreview);
    if (maxInput) maxInput.addEventListener('input', updatePreview);

    // Attach Commit Button Listener
    const commitBtn = document.getElementById('saveGradeBtn');
    if (commitBtn) commitBtn.addEventListener('click', saveGrade);

    // Load Core Data
    await loadSemesters();
    loadGradeTypes(); 
    await loadStudents();
});

// ── CUSTOM DROPDOWN HELPER (Searchable UI) ────────────────────────────────
function populateCustomDropdown(baseId, items) {
    const ulEl = document.getElementById(baseId + '-list');
    const hiddenEl = document.getElementById(baseId);
    const searchEl = document.getElementById(baseId + '-search');

    if (!ulEl || !hiddenEl || !searchEl) return;

    // Function to render list items dynamically
    const renderList = (list) => {
        if (list.length === 0) {
            ulEl.innerHTML = `<li class="p-2 text-[13px] text-[#6b84a0] italic">No results found</li>`;
            return;
        }
        ulEl.innerHTML = list.map(i => 
            `<li class="p-2 hover:bg-slate-100 cursor-pointer text-[13px] text-[#0d1f35] border-b border-[#f0f4f8] last:border-0" data-val="${i.value}">${i.text}</li>`
        ).join('');
        
        // Attach click listeners to the new list items
        ulEl.querySelectorAll('li[data-val]').forEach(li => {
            li.addEventListener('mousedown', (e) => {
                e.preventDefault(); // Prevents the input from losing focus before click registers
                searchEl.value = li.innerText;
                hiddenEl.value = li.getAttribute('data-val');
                ulEl.classList.add('hidden');
            });
        });
    };

    renderList(items);

    // Show list when clicked/focused
    searchEl.addEventListener('focus', () => {
        document.querySelectorAll('ul[id$="-list"]').forEach(el => el.classList.add('hidden')); // Close others
        ulEl.classList.remove('hidden');
        renderList(items); // Reset the list in case they searched previously
    });

    // Hide list when clicking away
    searchEl.addEventListener('blur', () => {
        ulEl.classList.add('hidden');
    });

    // Search-as-you-type filter logic
    searchEl.addEventListener('input', (e) => {
        const term = e.target.value.toLowerCase();
        const filtered = items.filter(i => i.text.toLowerCase().includes(term));
        renderList(filtered);
        ulEl.classList.remove('hidden');
    });
}

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

// ── 5. LOAD ROSTER (SEARCHABLE DROPDOWN) ──────────────────────────────────
async function loadStudents() {
    try {
        // Safe Query: Fetch active students for this school, then filter by teacher in JS
        const q = query(
            collection(db, 'students'),
            where('currentSchoolId', '==', session.schoolId),
            where('enrollmentStatus', '==', 'Active')
        );
        const snap = await getDocs(q);
        
        const studentItems = snap.docs
            .map(d => ({ id: d.id, ...d.data() }))
            .filter(s => s.teacherId === session.teacherId) // Filter done safely here!
            .map(s => ({ value: s.id, text: `${s.name} (${s.id})` }));
        
        populateCustomDropdown('eg-student', studentItems);
    } catch (e) {
        console.error('[Grade Form] Failed to load students:', e);
    }
}

// ── 6. LOAD GRADE TYPES & SUBJECTS ────────────────────────────────────────
function loadGradeTypes() {
    // Process Grade Types
    const defaultTypes = [{ name: 'Test' }, { name: 'Quiz' }, { name: 'Assignment' }, { name: 'Homework' }, { name: 'Project' }, { name: 'Final Exam' }];
    const types = session.teacherData.gradeTypes || session.teacherData.customGradeTypes || defaultTypes;
    
    const typeItems = types.filter(t => t).map(t => {
        const name = t.name || (typeof t === 'string' ? t : 'Uncategorized');
        return { value: name, text: name };
    });
    populateCustomDropdown('eg-type', typeItems);

    // Process Subjects
    let subjects = session.teacherData.classes || [];
    if (subjects.length === 0 && session.teacherData.className) subjects = [session.teacherData.className];
    if (subjects.length === 0) subjects = ['General'];

    const subjectItems = subjects.filter(Boolean).map(sub => ({ value: sub, text: sub }));
    populateCustomDropdown('eg-subject', subjectItems);
}

// ── 7. LIVE PREVIEW ───────────────────────────────────────────────────────
function updatePreview() {
    const scoreEl = document.getElementById('eg-score');
    const maxEl = document.getElementById('eg-max');
    if (!scoreEl || !maxEl) return;

    const score = parseFloat(scoreEl.value);
    const max   = parseFloat(maxEl.value);

    const prev = document.getElementById('eg-preview');
    if (prev && !isNaN(score) && !isNaN(max) && max > 0 && score >= 0) {
        const pct = Math.round((score / max) * 100);
        
        prev.classList.remove('hidden');
        
        const prevPct = document.getElementById('prev-pct');
        if (prevPct) prevPct.textContent = `${pct}%`;
        
        const prevLetter = document.getElementById('prev-letter');
        if (prevLetter) prevLetter.textContent = letterGrade(pct);
        
        const prevBar = document.getElementById('prev-bar');
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
    const studentId = document.getElementById('eg-student')?.value;
    if (!studentId) { alert('Please select a student from the dropdown.'); return; }

    const subject = document.getElementById('eg-subject')?.value || '';
    const type    = document.getElementById('eg-type')?.value || '';
    
    const title   = document.getElementById('eg-title')?.value.trim() || 'Untitled Assessment';
    const scoreEl = document.getElementById('eg-score');
    const maxEl   = document.getElementById('eg-max');
    const score   = scoreEl ? parseFloat(scoreEl.value) : NaN;
    const max     = maxEl ? parseFloat(maxEl.value) : NaN;
    const dateEl  = document.getElementById('eg-date');
    const date    = dateEl ? dateEl.value : new Date().toISOString().split('T')[0];
    const notesEl = document.getElementById('eg-notes');
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

        if (scoreEl) scoreEl.value = '';
        if (notesEl) notesEl.value = '';
        document.getElementById('eg-title').value = '';
        
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
