// ── PARENT THIN WRAPPER: ACADEMIC HISTORY ────────────────────────────────
// ARCHITECTURAL MANDATE: Dashboard Analytics & Parent Portal "Mirror" Sync.
// New dedicated nav page (the old combined Parent portal had no Academic
// History view at all) wired to the exact same assets/js/render-history.js
// module student/history/history.js uses.
import { requireAuth } from '../../assets/js/auth.js';
import { injectParentLayout, getActiveChild } from '../layout-parent.js';
import { initHistoryPage } from '../../assets/js/render-history.js';

const session = requireAuth('parent', '../../student/login.html');
const activeChild = session ? getActiveChild(session) : null;

injectParentLayout('history', 'Academic History', "A read-only mirror of your child's past semesters");

if (activeChild) {
    initHistoryPage({ studentId: activeChild.studentId, schoolId: activeChild.schoolId });
}
