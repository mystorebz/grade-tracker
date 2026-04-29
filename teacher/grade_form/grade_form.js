import { db } from '../../assets/js/firebase-init.js';
import { doc, getDoc, getDocs, addDoc, collection, query, where } from "https://www.gstatic.com/firebasejs/10.7.1/firebase-firestore.js";
import { requireAuth } from '../../assets/js/auth.js';
import { injectTeacherLayout } from '../../assets/js/layout-teachers.js';
import { letterGrade, gradeFill } from '../../assets/js/utils.js';

// ── 1. AUTH & LAYOUT ──────────────────────────────────────────────────────
const session = requireAuth('teacher', '../login.html');
injectTeacherLayout('grade-entry', 'Enter Grade', 'Log a new grade for a student in your active roster', false);

// ── 2. STATE ──────────────────────────────────────────────────────────────
let foundStudent  = null; 
let rawSemesters  = [];
let activeRoster  = []; 

// ── 3. INIT ───────────────────────────────────────────────────────────────
document.addEventListener('DOMContentLoaded', async () => {
    // 1. SET DATE (Fixed to prevent null error)
    const dateInput = document.getElementById('agDate');
    if (dateInput) dateInput.valueAsDate = new Date();
    
    // 2. LOAD SEMESTERS (Loading this first to ensure it shows up)
    await loadSemesters();

    // 3. LOAD OTHER DATA
    await loadRoster(); 
    loadSubjects();     
    loadGradeTypes();   

    // 4. LISTENERS
    document.getElementById('lookupInput').addEventListener('change', handleStudentSelection);
    document.getElementById('agType').addEventListener('change', displayGradeWeight);
    document.getElementById('agScore').addEventListener('input', updatePreview);
    document.getElementById('agMax').addEventListener('input', updatePreview);
    document.getElementById('saveGradeBtn').addEventListener('click', saveGrade);

    // Auto-Lookup hook
    const quickGradeId = localStorage.getItem('connectus_quick_grade_student');
    if (quickGradeId) {
        const s = activeRoster.find(x => x.id === quickGradeId);
        if (s) {
            document.getElementById('lookupInput').value = `${s.id} | ${s.name}`;
            lookupStudent(s.id);
        }
        localStorage.removeItem('connectus_quick_grade_student');
    }
});

async function loadSemesters() {
    try {
        const cacheKey = `connectus_semesters_${session.schoolId}`;
        let semesters = JSON.parse(localStorage.getItem(cacheKey) || "[]");

        if (semesters.length === 0) {
            const snap = await getDocs(collection(db, 'schools', session.schoolId, 'semesters'));
            semesters = snap.docs.map(d => ({ id: d.id, ...d.data() })).sort((a, b) => (a.order || 0) - (b.order || 0));
            localStorage.setItem(cacheKey, JSON.stringify(semesters));
        }
        rawSemesters = semesters;

        const schoolSnap = await getDoc(doc(db, 'schools', session.schoolId));
        const activeId = schoolSnap.data()?.activeSemesterId || '';

        const sel = document.getElementById('agSemester');
        if (sel) {
            sel.innerHTML = rawSemesters.map(s => `<option value="${s.id}" ${s.id === activeId ? 'selected' : ''}>${s.name}</option>`).join('');
        }
    } catch (e) { console.error('[GradeForm] loadSemesters Error:', e); }
}

async function loadRoster() {
    try {
        const q = query(collection(db, 'students'), where('teacherId', '==', session.teacherId), where('enrollmentStatus', '==', 'Active'));
        const snap = await getDocs(q);
        activeRoster = snap.docs.map(d => ({ id: d.id, ...d.data() }));
        const list = document.getElementById('rosterList');
        if (list) list.innerHTML = activeRoster.map(s => `<option value="${s.id} | ${s.name}"></option>`).join('');
    } catch (e) { console.error('Error loading roster:', e); }
}

function loadSubjects() {
    const list = document.getElementById('subjectList');
    if (!list) return;
    const subjects = (session.teacherData.subjects || []).filter(s => !s.archived);
    list.innerHTML = subjects.map(s => `<option value="${s.name}"></option>`).join('');
}

function loadGradeTypes() {
    const sel = document.getElementById('agType');
    const types = session.teacherData.gradeTypes || session.teacherData.customGradeTypes || [];
    if (sel) sel.innerHTML = '<option value="">— Select Type —</option>' + types.map(t => `<option value="${t.name || t}">${t.name || t}</option>`).join('');
}

function displayGradeWeight(e) {
    const selected = e.target.value;
    const weightEl = document.getElementById('typeWeightHint');
    const types = session.teacherData.gradeTypes || session.teacherData.customGradeTypes || [];
    const typeObj = types.find(t => (t.name || t) === selected);
    if (typeObj?.weight && weightEl) {
        weightEl.innerHTML = `<i class="fa-solid fa-scale-balanced mr-1"></i> Weight: <strong>${typeObj.weight}%</strong>`;
        weightEl.classList.remove('hidden');
    } else if (weightEl) weightEl.classList.add('hidden');
}

function handleStudentSelection(e) {
    const val = e.target.value.trim();
    const match = val.match(/^(S\d{2}-[A-Z0-9]{5})/);
    if (match) lookupStudent(match[1]);
}

async function lookupStudent(studentId) {
    try {
        const snap = await getDoc(doc(db, 'students', studentId));
        if (!snap.exists()) return;
        const data = snap.data();
        foundStudent = { id: snap.id, ...data };
        document.getElementById('badgeInitial').textContent = (data.name || '?').charAt(0).toUpperCase();
        document.getElementById('badgeName').textContent    = data.name || 'Unknown';
        document.getElementById('badgeMeta').textContent    = [data.className, data.dob].filter(Boolean).join(' · ');
        document.getElementById('badgeId').textContent      = snap.id;
        document.getElementById('studentBadge').classList.remove('hidden'); 
        document.getElementById('gradeFormSection').classList.remove('hidden');
    } catch (e) { console.error('Lookup failed', e); }
}

function updatePreview() {
    const score = parseFloat(document.getElementById('agScore').value);
    const max   = parseFloat(document.getElementById('agMax').value);
    const prev  = document.getElementById('gradePreview');
    if (!isNaN(score) && !isNaN(max) && max > 0) {
        const pct = Math.round((score / max) * 100);
        prev.classList.remove('hidden');
        document.getElementById('prevPct').textContent = `${pct}%`;
        document.getElementById('prevLetter').textContent = letterGrade(pct);
    } else prev.classList.add('hidden');
}

async function saveGrade() {
    const btn = document.getElementById('saveGradeBtn');
    if (!foundStudent) return;
    const payload = {
        schoolId: session.schoolId,
        teacherId: session.teacherId,
        semesterId: document.getElementById('agSemester').value,
        subject: document.getElementById('agSubject').value,
        type: document.getElementById('agType').value,
        title: document.getElementById('agTitle').value,
        score: parseFloat(document.getElementById('agScore').value),
        max: parseFloat(document.getElementById('agMax').value),
        date: document.getElementById('agDate').value,
        notes: document.getElementById('agNotes').value,
        createdAt: new Date().toISOString()
    };
    btn.disabled = true;
    try {
        await addDoc(collection(db, 'students', foundStudent.id, 'grades'), payload);
        document.getElementById('gradeSavedBanner').classList.remove('hidden');
    } catch (e) { console.error(e); }
    btn.disabled = false;
}

window.resetLookup = () => location.reload();
