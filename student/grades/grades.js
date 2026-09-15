// ── STUDENT THIN WRAPPER: CURRENT GRADES ─────────────────────────────────
// ARCHITECTURAL MANDATE: Dashboard Analytics & Parent Portal "Mirror" Sync
// (Shared Modules decision). All rendering logic now lives in
// assets/js/render-grades.js, the single source of truth this page shares
// with parent/grades/grades.js. This file's only job is auth + layout +
// resolving this student's own studentId/schoolId, then handing off.
import { requireAuth } from '../../assets/js/auth.js';
import { injectStudentLayout } from '../../assets/js/layout-student.js';
import { initGradesPage } from '../../assets/js/render-grades.js';

const session = requireAuth('student', '../login.html');
if (session) {
    injectStudentLayout('gradebook', 'My Gradebook', 'Full grade breakdown by subject');
    initGradesPage({ studentId: session.studentId, schoolId: session.schoolId });
}
