// ── PARENT THIN WRAPPER: CURRENT GRADES ──────────────────────────────────
// ARCHITECTURAL MANDATE: Dashboard Analytics & Parent Portal "Mirror" Sync.
// Replaces the old combined Grades+Attendance page (parent/view/view.js) —
// Current Grades now has its own dedicated nav link and page, wired to the
// exact same assets/js/render-grades.js module student/grades/grades.js
// uses. This page has nothing to strip: the shared module's own read-only
// note explains why (drill-down and print are the only controls, and both
// are already safe to expose unchanged).
import { requireAuth } from '../../assets/js/auth.js';
import { injectParentLayout, getActiveChild } from '../layout-parent.js';
import { initGradesPage } from '../../assets/js/render-grades.js';

const session = requireAuth('parent', '../../student/login.html');
const activeChild = session ? getActiveChild(session) : null;

injectParentLayout('grades', 'Current Grades', "A read-only mirror of your child's gradebook");

if (activeChild) {
    initGradesPage({ studentId: activeChild.studentId, schoolId: activeChild.schoolId });
}
