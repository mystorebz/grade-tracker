// ── STUDENT THIN WRAPPER: ACADEMIC HISTORY ───────────────────────────────
// ARCHITECTURAL MANDATE: Dashboard Analytics & Parent Portal "Mirror" Sync
// (Shared Modules decision). All rendering logic now lives in
// assets/js/render-history.js, the single source of truth this page shares
// with parent/history/history.js. This file's only job is auth + layout +
// resolving this student's own studentId/schoolId, then handing off.
import { requireAuth } from '../../assets/js/auth.js';
import { injectStudentLayout } from '../../assets/js/layout-student.js';
import { initHistoryPage } from '../../assets/js/render-history.js';

const session = requireAuth('student', '../login.html');
if (session) {
    injectStudentLayout('history', 'Academic History', 'Review past semesters and your full academic passport');
    initHistoryPage({ studentId: session.studentId, schoolId: session.schoolId });
}
