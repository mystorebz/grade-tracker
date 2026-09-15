// ── STUDENT THIN WRAPPER: REPORTS ────────────────────────────────────────
// ARCHITECTURAL MANDATE: Dashboard Analytics & Parent Portal "Mirror" Sync
// (Shared Modules decision). All rendering logic now lives in
// assets/js/render-reports.js, the single source of truth this page shares
// with parent/reports/reports.js. This file's only job is auth + layout +
// resolving this student's own studentId/schoolId, then handing off.
import { requireAuth } from '../../assets/js/auth.js';
import { injectStudentLayout } from '../../assets/js/layout-student.js';
import { initReportsPage } from '../../assets/js/render-reports.js';

const session = requireAuth('student', '../login.html');
if (session) {
    injectStudentLayout('reports', 'Official Reports', 'Download and print academic records');
    initReportsPage({ studentId: session.studentId, schoolId: session.schoolId });
}
