// ── PARENT THIN WRAPPER: REPORTS ─────────────────────────────────────────
// ARCHITECTURAL MANDATE: Dashboard Analytics & Parent Portal "Mirror" Sync
// (Shared Modules decision). Replaces the prior single auto-generated
// combined print sheet outright — all rendering logic now lives in
// assets/js/render-reports.js, the single source of truth this page shares
// with student/reports/reports.js. This is the same filterable Report
// Builder the student uses (select periods/subjects/types, Build, Print);
// nothing to strip beyond what the shared module's own note explains.
import { requireAuth } from '../../assets/js/auth.js';
import { injectParentLayout, getActiveChild } from '../layout-parent.js';
import { initReportsPage } from '../../assets/js/render-reports.js';

const session = requireAuth('parent', '../../student/login.html');
const activeChild = session ? getActiveChild(session) : null;

injectParentLayout('reports', 'Reports', "Build and print a custom academic report for your child");

if (activeChild) {
    initReportsPage({ studentId: activeChild.studentId, schoolId: activeChild.schoolId });
}
