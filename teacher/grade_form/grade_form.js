import { db } from '../../assets/js/firebase-init.js';
import { doc, getDoc, getDocs, addDoc, collection, query, where } from "https://www.gstatic.com/firebasejs/10.7.1/firebase-firestore.js";
import { requireAuth } from '../../assets/js/auth.js';
import { injectTeacherLayout } from '../../assets/js/layout-teachers.js';
import { letterGrade, gradeFill } from '../../assets/js/utils.js';

// ── 1. AUTH & LAYOUT ──────────────────────────────────────────────────────
const session = requireAuth('teacher', '../login.html');
if (session) {
    injectTeacherLayout('grade-entry', 'Enter Grade', 'Log a new grade for a student in your active roster', false);
}

// ── 2. STATE ──────────────────────────────────────────────────────────────
let foundStudentId = null; 
let rawSemesters   = [];
let activeRoster   = []; 

// ── 3. INIT ───────────────────────────────────────────────────────────────
document.addEventListener('DOMContentLoaded', async () => {
    // Prevent crash if element is missing
    const dateInput = document.getElementById('eg-date');
    if (dateInput) dateInput.valueAsDate = new Date();
    
    // Load data
    await Promise.all([loadSemesters(), loadRoster()]);
    loadSubjects();     
    loadGradeTypes();   

    // Listeners for searchable dropdowns
    setupSearchableDropdown('eg-student-search', 'eg-student-list', 'student');
    setupSearchableDropdown('eg-subject-search', 'eg-subject-list', 'subject');
    setupSearchableDropdown('eg-type-search', 'eg-type-list', 'type');

    // Score Preview logic
    document.getElementById('eg-score').addEventListener('input', updatePreview);
    document.getElementById('eg-max').addEventListener('input', updatePreview);
    document.getElementById('saveGradeBtn').addEventListener('click', saveGrade);
    
    // Close dropdowns when clicking outside
    document.addEventListener('click', (e) => {
        if (!e.target.closest('.relative')) {
            document.querySelectorAll('ul[id$="-list"]').forEach(ul => ul.classList.add('hidden'));
        }
    });
});

async function loadSemesters() {
    try {
        const snap = await getDocs(collection(db, 'schools', session.schoolId, 'semesters'));
        rawSemesters = snap.docs.map(d => ({ id: d.id, ...d.data() })).sort((a, b) => (a.order || 0) - (b.order || 0));
        
        const schoolSnap = await getDoc(doc(db, 'schools', session.schoolId));
        const activeId = schoolSnap.data()?.activeSemesterId || '';

        const sel = document.getElementById('agSemester');
        if (sel) {
            sel.innerHTML = rawSemesters.map(s => `<option value="${s.id}" ${s.id === activeId ? 'selected' : ''}>${s.name}</option>`).join('');
        }
    } catch (e) { console.error('Semester Load Error:', e); }
}

async function loadRoster() {
    try {
        const q = query(collection(db, 'students'), where('teacherId', '==', session.teacherId), where('enrollmentStatus', '==', 'Active'));
        const snap = await getDocs(q);
        activeRoster = snap.docs.map(d => ({ id: d.id, name: d.data().name }));
    } catch (e) { console.error('Roster Load Error:', e); }
}

function loadSubjects() {
    const subjects = (session.teacherData.subjects || []).filter(s => !s.archived).map(s => s.name);
    window.activeSubjects = subjects;
}

function loadGradeTypes() {
    const types = (session.teacherData.gradeTypes || session.teacherData.customGradeTypes || []).map(t => t.name || t);
    window.activeTypes = types;
}

// ── 4. DROPDOWN LOGIC ─────────────────────────────────────────────────────
function setupSearchableDropdown(inputId, listId, type) {
    const input = document.getElementById(inputId);
    const list = document.getElementById(listId);

    const render = (filter = '') => {
        let items = [];
        if (type === 'student') items = activeRoster.map(s => ({ id: s.id, label: s.name }));
        else if (type === 'subject') items = window.activeSubjects.map(s => ({ id: s, label: s }));
        else if (type === 'type') items = window.activeTypes.map(t => ({ id: t, label: t }));

        const filtered = items.filter(i => i.label.toLowerCase().includes(filter.toLowerCase()));
        
        list.innerHTML = filtered.map(i => `
            <li class="px-3 py-2 hover:bg-[#f0fdf8] cursor-pointer text-[13px] border-b border-[#f0f4f8] last:border-0" data-id="${i.id}" data-label="${i.label}">
                ${i.label} ${type === 'student' ? `<span class="text-[10px] text-[#9ab0c6] ml-1">(${i.id})</span>` : ''}
            </li>
        `).join('');
        list.classList.toggle('hidden', filtered.length === 0);
    };

    input.addEventListener('focus', () => render(input.value));
    input.addEventListener('input', (e) => render(e.target.value));
    
    list.addEventListener('mousedown', (e) => {
        const li = e.target.closest('li');
        if (li) {
            input.value = li.dataset.label;
            if (type === 'student') foundStudentId = li.dataset.id;
            list.classList.add('hidden');
        }
    });
}

function updatePreview() {
    const score = parseFloat(document.getElementById('eg-score').value);
    const max = parseFloat(document.getElementById('eg-max').value);
    const pctEl = document.getElementById('prev-pct');
    const letEl = document.getElementById('prev-letter');
    const barEl = document.getElementById('prev-bar');

    if (!isNaN(score) && !isNaN(max) && max > 0) {
        const pct = Math.round((score / max) * 100);
        pctEl.textContent = `${pct}%`;
        pctEl.style.color = '#0d1f35';
        letEl.textContent = letterGrade(pct);
        barEl.style.width = `${Math.min(pct, 100)}%`;
        barEl.style.backgroundColor = gradeFill(pct);
        document.getElementById('prev-label').textContent = "Live Calculation";
    }
}

async function saveGrade() {
    const btn = document.getElementById('saveGradeBtn');
    if (!foundStudentId) { alert("Please select a student from the list."); return; }
    
    const payload = {
        schoolId: session.schoolId,
        teacherId: session.teacherId,
        semesterId: document.getElementById('agSemester').value,
        subject: document.getElementById('eg-subject-search').value,
        type: document.getElementById('eg-type-search').value,
        title: document.getElementById('eg-title').value,
        score: parseFloat(document.getElementById('eg-score').value),
        max: parseFloat(document.getElementById('eg-max').value),
        date: document.getElementById('eg-date').value,
        notes: document.getElementById('eg-notes').value,
        createdAt: new Date().toISOString()
    };

    btn.disabled = true;
    try {
        await addDoc(collection(db, 'students', foundStudentId, 'grades'), payload);
        document.getElementById('gradeSavedBanner').classList.remove('hidden');
        window.scrollTo({ top: 0, behavior: 'smooth' });
    } catch (e) { console.error(e); }
    btn.disabled = false;
}
