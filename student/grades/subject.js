// ── STUDENT: ONE SUBJECT'S GRADES ────────────────────────────────────────
// URL: subject.html?subject=<subject>[&type=<assignment type>][&item=<gradeId>]
// Opened from a Current Grades tile. Page body: assets/js/render-subject-grades.js
// (shared with parent/grades/subject.js). A student only ever loads their own
// grades: studentId comes from the session, never from the URL.
import { requireAuth } from '../../assets/js/auth.js';
import { injectStudentLayout } from '../../assets/js/layout-student.js';
import { initSubjectGradesPage } from '../../assets/js/render-subject-grades.js';

const session = requireAuth('student', '../login.html');
if (session) {
    injectStudentLayout('gradebook', 'My Gradebook', 'Full grade breakdown by subject');
    const params = new URLSearchParams(location.search);
    initSubjectGradesPage({
        studentId: session.studentId,
        schoolId: session.schoolId,
        subject: params.get('subject') || '',
        initialType: params.get('type') || '',
        initialItem: params.get('item') || '',
        backHref: 'grades.html',
    });
}
