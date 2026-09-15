// ── PARENT THIN WRAPPER: ASSIGNMENTS ─────────────────────────────────────
// ARCHITECTURAL MANDATE: Dashboard Analytics & Parent Portal "Mirror" Sync
// (Shared Modules decision). Replaces the prior standalone Attention/
// Submitted/Graded bucket implementation outright — all rendering logic
// now lives in assets/js/render-assignments.js, the single source of truth
// this page shares with student/assignments/assignments.js (readOnly:
// false there). This file's only job is auth + layout + resolving the
// active child's studentId/schoolId, then handing off with readOnly
// explicitly true.
import { requireAuth } from '../../assets/js/auth.js';
import { injectParentLayout, getActiveChild } from '../layout-parent.js';
import { initAssignmentsPage } from '../../assets/js/render-assignments.js';

const session = requireAuth('parent', '../../student/login.html');
const activeChild = session ? getActiveChild(session) : null;

injectParentLayout('assignments', 'Assignments', "A read-only mirror of your child's assignment list");

if (activeChild) {
    initAssignmentsPage({ studentId: activeChild.studentId, schoolId: activeChild.schoolId, readOnly: true });
}
