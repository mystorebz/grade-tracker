// teacher/subjects/subject-shell.js — URL-driven router for subject.html
//
// Route:  subject.html?c={classId}&s={subjectId}&tab=performance|assignments|lessons&sem={semesterId}&lesson={lessonId}&assignment={assignmentId|new}
// - navigate(patch)            pushState (tab / lesson changes → Back works)
// - navigate(patch, {replace}) replaceState (filters such as sem)
// - popstate re-renders from the URL; refresh and deep links land on the same view.
// Panes are mounted lazily and re-rendered only when their inputs change.

import { requireAuth, awaitAuthReady } from '../../assets/js/auth.js';
import { injectTeacherLayout } from '../../assets/js/layout-teachers.js';
import { resolveGradeWeights } from '../../assets/js/utils.js';
import { createSubjectStore } from '../../assets/js/subject-store.js';
import { esc, emptyBox } from './tabs/ui.js';
import * as performanceTab from './tabs/performance.js';
import * as assignmentsTab from './tabs/assignments.js';
import * as lessonsTab from './tabs/lessons.js';

const TABS = ['performance', 'assignments', 'lessons'];
const MODULES = { performance: performanceTab, assignments: assignmentsTab, lessons: lessonsTab };
const DEFAULT_TAB = 'performance';

const session = requireAuth('teacher', '../login.html');
if (session) injectTeacherLayout('subjects', 'Subject', 'Performance, assignments and lessons', false);

let state = null;        // current route
let store = null;        // createSubjectStore() for state.c/state.s
let renderToken = 0;     // drops stale async renders
let storeFor = null;     // `${c}|${s}` the store was built for
let headerFor = null;    // `${c}|${s}` the header was rendered for
let gradeTypes = null;   // teacher's weighting for this class/subject (resolveGradeWeights)
let semInfo = { sem: null, name: '', locked: false };
const mounted = {};      // tab -> key of inputs it was last rendered with

const $ = (id) => document.getElementById(id);

// ── ROUTE <-> URL ────────────────────────────────────────────────────────
export function parseRoute(search = window.location.search) {
    const p = new URLSearchParams(search);
    const tab = p.get('tab');
    return {
        c: p.get('c') || null,
        s: p.get('s') || null,
        tab: TABS.includes(tab) ? tab : DEFAULT_TAB,
        sem: p.get('sem') || null,
        lesson: p.get('lesson') || null,
        assignment: p.get('assignment') || null,
    };
}

function toSearch(route) {
    const p = new URLSearchParams();
    if (route.c) p.set('c', route.c);
    if (route.s) p.set('s', route.s);
    if (route.tab && route.tab !== DEFAULT_TAB) p.set('tab', route.tab);
    if (route.sem) p.set('sem', route.sem);
    if (route.lesson && route.tab === 'lessons') p.set('lesson', route.lesson);
    if (route.assignment && route.tab === 'assignments') p.set('assignment', route.assignment);
    return `?${p.toString()}`;
}

export function navigate(patch, { replace = false } = {}) {
    const next = { ...state, ...patch };
    if (patch.tab && patch.tab !== 'lessons') next.lesson = null;
    if (patch.tab && patch.tab !== 'assignments') next.assignment = null;
    const url = `${window.location.pathname}${toSearch(next)}`;
    if (url === `${window.location.pathname}${window.location.search}`) return;
    window.history[replace ? 'replaceState' : 'pushState'](null, '', url);
    render(parseRoute());
}

// Rewrite the URL for the CURRENT view without remounting anything — used when
// an in-memory draft gets its first save (lesson=new-slides → lesson={id}).
export function replaceRoute(patch) {
    const next = { ...state, ...patch };
    window.history.replaceState(null, '', `${window.location.pathname}${toSearch(next)}`);
    state = parseRoute();
    if (mounted[state.tab]) mounted[state.tab].key = paneKey(semInfo.sem);
}

function paneKey(sem) {
    return `${state.c}|${state.s}|${sem}|${state.lesson || ''}|${state.assignment || ''}`;
}

// ── RENDER ───────────────────────────────────────────────────────────────
async function render(next) {
    state = next;
    const token = ++renderToken;

    if (!state.c || !state.s) { showFatal('No subject selected.'); return; }

    const subjKey = `${state.c}|${state.s}`;
    if (storeFor !== subjKey) {
        store = createSubjectStore({ schoolId: session.schoolId, classId: state.c, subjectId: state.s, viewerId: session.teacherId });
        store.prefetch(state.sem); // roster + grades start loading while the header renders
        storeFor = subjKey;
        headerFor = null;
        TABS.forEach((t) => { if (mounted[t]) MODULES[t].unmount($(`tab-${t}`)); delete mounted[t]; });
    }
    if (headerFor !== subjKey) {
        const ok = await renderHeader(subjKey);
        if (!ok || token !== renderToken) return;
    }

    // resolve the semester once per route (URL wins, else school's active period)
    const { activeSemesterId } = await store.getSemesters();
    if (token !== renderToken) return;
    const sem = state.sem || activeSemesterId;
    const semSel = $('activeSemester');
    semSel.value = sem || '';
    const { semesters } = await store.getSemesters();
    const semDoc = semesters.find((x) => x.id === sem) || null;
    semInfo = { sem, name: semDoc?.name || '', locked: !!semDoc?.isLocked };
    const sbPeriod = $('sb-period');
    if (sbPeriod) sbPeriod.textContent = semInfo.name || '—';
    const lockBadge = $('topbarLockedBadge');
    if (lockBadge) { lockBadge.classList.toggle('hidden', !semInfo.locked); lockBadge.classList.toggle('flex', semInfo.locked); }

    setActiveTab(state.tab);
    await mountPane(state.tab, sem);
}

async function renderHeader(subjKey) {
    let subject, cls, sems;
    try {
        let weights;
        [subject, cls, sems, weights] = await Promise.all([
            store.getSubject(), store.getClass().catch(() => null), store.getSemesters(),
            resolveGradeWeights(session.schoolId, session.teacherId, { classId: state.c, subjectId: state.s, legacyTeacherData: session.teacherData }).catch(() => null),
        ]);
        gradeTypes = weights;
    } catch (e) {
        console.error('[SubjectShell] header load failed:', e);
        showFatal('Could not load this subject. Check your connection and try again.');
        return false;
    }
    if (storeFor !== subjKey) return false; // subject changed while loading
    if (!subject) { showFatal('This subject does not exist or you do not have access to it.'); return false; }

    const className = cls?.name || subject.className || '';
    document.title = `${subject.name} | Subjects | ConnectUs`;
    $('crumbClass').textContent = className || state.c;
    $('crumbSubject').textContent = subject.name;
    $('subjectTitle').textContent = subject.name;
    $('subjectMeta').textContent = [className, subject.archived ? 'Archived' : null].filter(Boolean).join(' · ');
    $('quickGradeLink').href = `../grade_form/grade_form.html?subjectId=${encodeURIComponent(state.s)}`;

    // Single period control: the layout topbar's #activeSemester (same one
    // subjects.html / grade_form use), enabled and owned by this router.
    const sel = $('activeSemester');
    sel.disabled = !sems.semesters.length;
    sel.innerHTML = sems.semesters.length
        ? sems.semesters.map((s) => `<option value="${esc(s.id)}">${esc(s.name || s.id)}${s.isLocked ? ' (locked)' : ''}</option>`).join('')
        : '<option value="">No grading periods</option>';

    $('subjectShellLoading').hidden = true;
    $('subjectShellBody').hidden = false;
    headerFor = subjKey;
    return true;
}

function setActiveTab(tab) {
    TABS.forEach((t) => {
        const btn = $(`tabbtn-${t}`);
        const panel = $(`tab-${t}`);
        const active = t === tab;
        btn.setAttribute('aria-selected', String(active));
        btn.tabIndex = active ? 0 : -1;
        btn.classList.toggle('subject-tab-active', active);
        panel.hidden = !active;
    });
}

// A mount is stale only when a newer mount of the SAME tab (or a subject
// change) replaced its entry — so A→B→A quickly still finishes A's render.
async function mountPane(tab, sem) {
    const key = paneKey(sem);
    if (mounted[tab] && mounted[tab].key === key) return;
    const el = $(`tab-${tab}`);
    if (mounted[tab]) MODULES[tab].unmount(el);
    const entry = { key };
    mounted[tab] = entry;
    const isStale = () => mounted[tab] !== entry;
    try {
        await MODULES[tab].mount(el, {
            store, route: { ...state }, sem, semName: semInfo.name, semesterLocked: semInfo.locked,
            session, gradeTypes, navigate, replaceRoute, refresh, isStale,
        });
    } catch (e) {
        console.error(`[SubjectShell] ${tab} failed:`, e);
        if (isStale()) return;
        delete mounted[tab];
        el.innerHTML = emptyBox('Could not load this tab.', 'Please try again.');
    }
}

// Called by tabs after a write (e.g. Add Work saved): drop cached resources,
// force every pane to remount, re-render the current route.
function refresh(resources = []) {
    resources.forEach((r) => store && store.invalidate(r));
    TABS.forEach((t) => { if (mounted[t]) MODULES[t].unmount($(`tab-${t}`)); delete mounted[t]; });
    render(parseRoute());
}

function showFatal(message) {
    $('subjectShellLoading').hidden = true;
    $('subjectShellBody').hidden = true;
    $('subjectShellError').hidden = false;
    $('subjectShellErrorMsg').textContent = message;
}

// ── EVENTS ───────────────────────────────────────────────────────────────
function wireEvents() {
    const tablist = $('subjectTabs');
    tablist.addEventListener('click', (e) => {
        const btn = e.target.closest('[data-tab]');
        if (btn) navigate({ tab: btn.dataset.tab });
    });
    tablist.addEventListener('keydown', (e) => {
        if (e.key !== 'ArrowRight' && e.key !== 'ArrowLeft') return;
        const i = TABS.indexOf(state.tab);
        const nextTab = TABS[(i + (e.key === 'ArrowRight' ? 1 : TABS.length - 1)) % TABS.length];
        navigate({ tab: nextTab });
        $(`tabbtn-${nextTab}`).focus();
    });
    $('activeSemester').addEventListener('change', (e) => navigate({ sem: e.target.value || null }, { replace: true }));
    window.addEventListener('popstate', () => render(parseRoute()));
}

async function init() {
    if (!session) return;
    const authOk = await awaitAuthReady('teacher', '../login.html');
    if (!authOk) return;
    wireEvents();
    render(parseRoute());
}

init();
