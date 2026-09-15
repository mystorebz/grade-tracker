// ── STUDENT THIN WRAPPER: ATTENDANCE ─────────────────────────────────────
// ARCHITECTURAL MANDATE: Dashboard Analytics & Parent Portal "Mirror" Sync
// (Shared Modules decision). All rendering logic now lives in
// assets/js/render-attendance.js, the single source of truth this page
// shares with parent/attendance/attendance.js. This file's only job is
// auth + layout + resolving this student's own studentId/schoolId, then
// handing off.
import { requireAuth } from '../../assets/js/auth.js';
import { injectStudentLayout } from '../../assets/js/layout-student.js';
import { initAttendancePage } from '../../assets/js/render-attendance.js';

const session = requireAuth('student', '../login.html');
if (session) {
    injectStudentLayout('attendance', 'Attendance', 'Your attendance history, month by month');
    initAttendancePage({ studentId: session.studentId, schoolId: session.schoolId });
}
