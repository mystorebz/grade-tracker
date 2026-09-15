// ── PARENT THIN WRAPPER: ATTENDANCE ──────────────────────────────────────
// ARCHITECTURAL MANDATE: Dashboard Analytics & Parent Portal "Mirror" Sync.
// New dedicated nav page, splitting Attendance out of the retired combined
// Grades+Attendance page (parent/view/view.js) — wired to the exact same
// assets/js/render-attendance.js module student/attendance/attendance.js
// uses, mirroring how Attendance is handled on the Student side.
import { requireAuth } from '../../assets/js/auth.js';
import { injectParentLayout, getActiveChild } from '../layout-parent.js';
import { initAttendancePage } from '../../assets/js/render-attendance.js';

const session = requireAuth('parent', '../../student/login.html');
const activeChild = session ? getActiveChild(session) : null;

injectParentLayout('attendance', 'Attendance', "A read-only mirror of your child's attendance record");

if (activeChild) {
    initAttendancePage({ studentId: activeChild.studentId, schoolId: activeChild.schoolId });
}
