// ── PARENT: ONE SUBJECT'S GRADES FOR A LINKED CHILD ──────────────────────
// URL: subject.html?student=<childStudentId>&subject=<subject>[&type=<type>][&item=<gradeId>]
// Page body: assets/js/render-subject-grades.js (shared with the student page).
//
// SECURITY: the student= value must be one of the parent's linkedStudents.
// Anything else is refused before any grade is read. (firestore.rules also
// only lets a parent read a linked child's grades; this check makes the page
// say so clearly instead of failing on a permission error.)
//
// CHILD SELECTION: opening this page makes the URL's child the active child,
// so "Back to Current Grades" returns to that same child. If the parent then
// switches child in the sidebar selector (which reloads the page), the URL
// still names the old child — that case is detected with a per-tab marker
// and sent back to Current Grades for the newly selected child.
import { requireAuth } from '../../assets/js/auth.js';
import { injectParentLayout, getActiveChild, setActiveChild } from '../layout-parent.js';
import { initSubjectGradesPage } from '../../assets/js/render-subject-grades.js';

const PAGE_CHILD_KEY = 'connectus_parent_subjectPageStudent';
const session = requireAuth('parent', '../../student/login.html');
const params = new URLSearchParams(location.search);
const wanted = params.get('student') || '';
const linked = Array.isArray(session?.linkedStudents) ? session.linkedStudents : [];
const child = linked.find(l => l.studentId === wanted) || null;

let switchedAway = false;
if (session && child) {
    const active = getActiveChild(session);
    let marker = null;
    try { marker = sessionStorage.getItem(PAGE_CHILD_KEY); } catch (e) { /* storage blocked */ }
    if (active && active.studentId !== wanted && marker === wanted) {
        switchedAway = true; // parent picked another child in the selector on this page
    } else {
        setActiveChild(child);
        try { sessionStorage.setItem(PAGE_CHILD_KEY, wanted); } catch (e) { /* storage blocked */ }
    }
}

if (switchedAway) {
    location.replace('grades.html');
} else {
    injectParentLayout('grades', 'Current Grades', "Your child's grades for the current period");
    if (session) {
        if (!child) {
            document.getElementById('subjectPageHost').innerHTML = `
                <div style="padding:24px 40px;max-width:1100px;">
                    <a href="grades.html" style="display:inline-flex;align-items:center;gap:8px;font-size:13px;font-weight:700;color:#4f46e5;text-decoration:none;margin-bottom:16px;">
                        <i class="fa-solid fa-arrow-left"></i> Back to Current Grades</a>
                    <div style="text-align:center;padding:70px 20px;color:#94a3b8;font-size:13.5px;font-weight:600;background:#fff;border:1.5px dashed #e2e8f0;border-radius:14px;">
                        <i class="fa-solid fa-lock" style="display:block;font-size:30px;margin-bottom:12px;color:#fca5a5;"></i>
                        You don't have access to this student's grades.
                    </div>
                </div>`;
        } else {
            initSubjectGradesPage({
                studentId: child.studentId,
                schoolId: child.schoolId,
                subject: params.get('subject') || '',
                initialType: params.get('type') || '',
                initialItem: params.get('item') || '',
                backHref: 'grades.html',
                showChildName: true,
            });
        }
    }
}
