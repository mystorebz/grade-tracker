// ── STUDENT THIN WRAPPER: ASSIGNMENTS ────────────────────────────────────
// ARCHITECTURAL MANDATE: Dashboard Analytics & Parent Portal "Mirror" Sync
// (Shared Modules decision). All rendering logic now lives in
// assets/js/render-assignments.js, the single source of truth this page
// shares with parent/assignments/assignments.js (readOnly: true there).
// This file's only job is auth + layout + resolving this student's own
// studentId/schoolId, then handing off with readOnly explicitly false.
import { requireAuth } from '../../assets/js/auth.js';
import { injectStudentLayout } from '../../assets/js/layout-student.js';
import { initAssignmentsPage } from '../../assets/js/render-assignments.js';

const session = requireAuth('student', '../login.html');
if (session) {
    injectStudentLayout('assignments', 'Assignments', 'Everything your teacher has assigned');
    initAssignmentsPage({ studentId: session.studentId, schoolId: session.schoolId, readOnly: false });
}
