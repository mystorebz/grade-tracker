import { db } from '../../assets/js/firebase-init.js';
import { doc, getDoc, getDocs, addDoc, collection, query, where } from "https://www.gstatic.com/firebasejs/10.7.1/firebase-firestore.js";
import { requireAuth } from '../../assets/js/auth.js';
import { injectTeacherLayout } from '../../assets/js/layout-teachers.js';
import { letterGrade, gradeFill, calculateWeightedAverage } from '../../assets/js/utils.js';

// ── 1. AUTH & LAYOUT ──────────────────────────────────────────────────────
const session = requireAuth('teacher', '../login.html');
if (session) {
    injectTeacherLayout('grade-entry', 'Enter Grade', 'Log a new grade for a student in your active roster', false);
}

// ── 2. STATE ──────────────────────────────────────────────────────────────
let allStudentsCache = [];
let foundStudent    = null; 
let rawSemesters     = [];

// ── 3. INIT ───────────────────────────────────────────────────────────────
document.addEventListener('DOMContentLoaded', async () => {
    if (!session) return;
    
    document.getElementById('agDate').valueAsDate = new Date();
    
    // Parallel load to maintain the "handshake" speed
    await Promise.all([loadSemesters(), loadStudents()]);
    loadGradeTypes();

    // Searchable Dropdown Logic
    const lookupInput = document.getElementById('lookupId');
    const dropdown    = document.getElementById('studentDropdown');
    
    lookupInput.addEventListener('click', (e) => {
        e.stopPropagation();
        toggleStudentDropdown();
    });

    lookupInput.addEventListener('input', (e) => {
        filterStudentDropdown(e.target.value);
        if (!dropdown.classList.contains('sf-open')) dropdown.classList.add('sf-open');
    });

    // Close dropdown when clicking anywhere else
    document.addEventListener('click', () => {
        dropdown.classList.remove('sf-open');
    });

    document.getElementById('agScore').addEventListener('input', updatePreview);
    document.getElementById('agMax').addEventListener('input', updatePreview);
    document.getElementById('saveGradeBtn').addEventListener('click', saveGrade);

    // Auto-Lookup hook for the "Quick Grade" button on the Roster page
    const quickGradeId = localStorage.getItem('connectus_quick_grade_student');
    if (quickGradeId) {
        selectStudent(quickGradeId);
        localStorage.removeItem('connectus_quick_grade_student');
    }
});

// ── 4. LOAD SEMESTERS (The handshake fix for the top-right term) ──────────
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

        const schoolSnap = await getDoc(doc(db, 'schools', session.schoolId));
        const activeId = schoolSnap.data()?.activeSemesterId || '';

        const sel = document.getElementById('agSemester');
        const sbPeriod = document.getElementById('sb-period'); // Sidebar sync
        
        sel.innerHTML = '';
        rawSemesters.forEach(s => {
            const opt = document.createElement('option');
            opt.value = s.id; opt.textContent = s.name;
            if (s.id === activeId) opt.selected = true;
            sel.appendChild(opt);
        });

        if (sbPeriod) sbPeriod.textContent = sel.options[sel.selectedIndex]?.text || '—';
        
        sel.addEventListener('change', () => {
            if (sbPeriod) sbPeriod.textContent = sel.options[sel.selectedIndex]?.text || '—';
        });

    } catch (e) { console.error('[GradeEntry] loadSemesters:', e); }
}

// ── 5. LOAD STUDENTS (Searchable Dropdown Source) ─────────────────────────
async function loadStudents() {
    try {
        // Query global students tagged to this teacher/school (Same as Roster/Overview)
        const q = query(
            collection(db, 'students'),
            where('currentSchoolId', '==', session.schoolId),
            where('teacherId', '==', session.teacherId),
            where('enrollmentStatus', '==', 'Active')
        );
        const snap = await getDocs(q);
        allStudentsCache = snap.docs.map(d => ({ id: d.id, ...d.data() }))
                                   .sort((a, b) => a.name.localeCompare(b.name));

        renderStudentDropdown();
    } catch (e) { console.error('[GradeEntry] loadStudents:', e); }
}

function renderStudentDropdown() {
    const dropdown = document.getElementById('studentDropdown');
    dropdown.innerHTML = allStudentsCache.map(s => `
        <div class="sf-item" onclick="selectStudent('${s.id}')">
            <span class="font-bold">${s.name}</span>
            <span class="text-[10px] opacity-60 ml-2">${s.id}</span>
        </div>
    `).join('');
}

function filterStudentDropdown(term) {
    const dropdown = document.getElementById('studentDropdown');
    const items = dropdown.querySelectorAll('.sf-item');
    const t = term.toLowerCase();
    
    items.forEach(item => {
        const text = item.textContent.toLowerCase();
        item.style.display = text.includes(t) ? 'block' : 'none';
    });
}

function toggleStudentDropdown() {
    const dropdown = document.getElementById('studentDropdown');
    dropdown.classList.toggle('sf-open');
}

window.selectStudent = function(id) {
    const s = allStudentsCache.find(x => x.id === id);
    if (!s) return;

    foundStudent = s;
    document.getElementById('lookupId').value = s.name;
    document.getElementById('studentDropdown').classList.remove('sf-open');
    
    // UI Feedback (Badge)
    const badge = document.getElementById('studentBadge');
    const form  = document.getElementById('gradeFormSection');
    
    document.getElementById('badgeInitial').textContent = s.name.charAt(0).toUpperCase();
    document.getElementById('badgeName').textContent    = s.name;
    document.getElementById('badgeMeta').textContent    = `${s.className || 'No Class'} · DOB: ${s.dob || '—'}`;
    document.getElementById('badgeId').textContent      = s.id;

    badge.classList.remove('hidden'); 
    form.classList.remove('hidden');
    form.scrollIntoView({ behavior: 'smooth', block: 'start' });
};

// ── 6. LOAD GRADE TYPES ───────────────────────────────────────────────────
function loadGradeTypes() {
    const sel = document.getElementById('agType');
    const types = session.teacherData.gradeTypes || session.teacherData.customGradeTypes || [{name:'Test'},{name:'Quiz'}];
    
    sel.innerHTML = '<option value="">Select type...</option>' + types.map(t => {
        const name = t.name || t;
        return `<option value="${name}">${name}</option>`;
    }).join('');
}

// ── 7. LIVE PREVIEW ───────────────────────────────────────────────────────
function updatePreview() {
    const score = parseFloat(document.getElementById('agScore').value);
    const max   = parseFloat(document.getElementById('agMax').value);
    const prev  = document.getElementById('gradePreview');

    if (!isNaN(score) && !isNaN(max) && max > 0) {
        const pct = Math.round((score / max) * 100);
        const color = pct >= 90 ? 'text-emerald-600' : pct >= 80 ? 'text-blue-600' : pct >= 70 ? 'text-teal-600' : pct >= 65 ? 'text-amber-600' : 'text-red-600';
        
        prev.classList.remove('hidden');
        document.getElementById('prevPct').textContent = `${pct}%`;
        document.getElementById('prevPct').className = `text-3xl font-black font-mono ${color}`;
        document.getElementById('prevLetter').textContent = letterGrade(pct);
        document.getElementById('prevLabel').textContent = pct >= 65 ? (pct >= 80 ? 'Excelling' : 'On Track') : 'At Risk';
    } else { prev.classList.add('hidden'); }
}

// ── 8. SAVE GRADE (Handshake with Global Student Collection) ─────────────
async function saveGrade() {
    if (!foundStudent) return;

    const subject = document.getElementById('agSubject').value.trim();
    const type    = document.getElementById('agType').value;
    const title   = document.getElementById('agTitle').value.trim();
    const score   = parseFloat(document.getElementById('agScore').value);
    const max     = parseFloat(document.getElementById('agMax').value);
    const semId   = document.getElementById('agSemester').value;
    const date    = document.getElementById('agDate').value;
    const notes   = document.getElementById('agNotes').value.trim();

    if (!subject || !type || !title || isNaN(score)) {
        showLookupMsg('Please fill in all required fields.');
        return;
    }

    const btn = document.getElementById('saveGradeBtn');
    btn.disabled = true; btn.innerHTML = '<i class="fa-solid fa-spinner fa-spin"></i> Committing...';

    try {
        // Write to Global Passport Path: students/{studentId}/grades
        await addDoc(collection(db, 'students', foundStudent.id, 'grades'), {
            schoolId:   session.schoolId,
            teacherId:  session.teacherId,  
            semesterId: semId,
            subject,
            type,
            date,
            title,
            score,
            max,
            notes,
            historyLogs: [],
            createdAt:   new Date().toISOString()
        });

        // Reset for next entry
        document.getElementById('agScore').value = '';
        document.getElementById('agNotes').value = '';
        updatePreview();
        document.getElementById('gradeSavedBanner').classList.remove('hidden');

    } catch (e) { console.error(e); }

    btn.disabled = false; 
    btn.innerHTML = '<i class="fa-solid fa-database mr-2 text-xs"></i>Commit Grade Record';
}

function showLookupMsg(msg) { 
    const el = document.getElementById('lookupMsg'); 
    el.textContent = msg; 
    el.classList.remove('hidden'); 
}

function escHtml(str) {
    if (!str) return '';
    return String(str).replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/"/g,'&quot;');
}
