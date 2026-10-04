// teacher/subjects/tabs/assignments.js — Assignments tab
// Feature parity with the removed slide-out panel: Create (Add Work builder),
// Review submissions, Edit, Mark graded / Reopen, Lock / Unlock, Delete —
// all provided by ../workbench.js (window.* handlers + modals in subject.html).
//
// Route: …&tab=assignments                      → list
//        …&tab=assignments&assignment=new       → full-page editor, new assignment
//        …&tab=assignments&assignment={id}      → full-page editor, that assignment
// Same in-page pattern as Lessons: Back / the breadcrumb / Cancel return to the list.

import { configureWorkbench, formatDueDate, mountAssignmentEditor, setAssignmentEditorRoute } from '../workbench.js';
import { esc, loading, card, emptyBox } from './ui.js';

let editorHandle = null;
let clickHandler = null;

function setCrumb(title) {
    const sep = document.getElementById('crumbLessonSep');
    const li = document.getElementById('crumbLesson');
    if (!sep || !li) return;
    const show = title !== null && title !== undefined;
    sep.hidden = !show;
    li.hidden = !show;
    li.textContent = show ? title : '';
    document.getElementById('crumbSubject')?.toggleAttribute('aria-current', !show);
    if (show) li.setAttribute('aria-current', 'page'); else li.removeAttribute('aria-current');
    const subjectName = document.getElementById('subjectTitle')?.textContent || '';
    document.title = show ? `${title} · ${subjectName} | ConnectUs` : `${subjectName} | Subjects | ConnectUs`;
}

function detach(el) {
    if (clickHandler) { el.removeEventListener('click', clickHandler); clickHandler = null; }
}

function mountEditor(el, ctx, list) {
    const { route, navigate } = ctx;
    const isNew = route.assignment === 'new';
    const existing = isNew ? null : list.find((a) => a.id === route.assignment);
    el.innerHTML = `
        <div class="flex items-center justify-between gap-3 mb-4">
            <button type="button" data-action="back" class="inline-flex items-center gap-2 text-[12.5px] font-bold text-[#374f6b] hover:text-[#2563eb]">
                <i class="fa-solid fa-arrow-left text-[11px]"></i> All assignments
            </button>
        </div>
        <div id="assignmentWorkspace"></div>`;
    detach(el);
    clickHandler = (e) => { if (e.target.closest('[data-action="back"]')) window.closeAddWorkModal(); };
    el.addEventListener('click', clickHandler);

    if (!isNew && !existing) {
        setCrumb('Not found');
        el.querySelector('#assignmentWorkspace').innerHTML = emptyBox('This assignment no longer exists.', 'It may have been deleted. Go back to the list to see current assignments.');
        clickHandler = (e) => { if (e.target.closest('[data-action="back"]')) navigate({ assignment: null }); };
        detach(el); el.addEventListener('click', clickHandler);
        return;
    }
    setCrumb(isNew ? 'New assignment' : (existing.title || 'Untitled'));
    editorHandle = mountAssignmentEditor({
        host: el.querySelector('#assignmentWorkspace'),
        assignmentId: isNew ? null : existing.id,
        onClose: () => navigate({ assignment: null }),
    });
}

const BTN = 'flex items-center gap-1 text-[11px] font-bold px-2.5 py-1.5 rounded border transition';

export async function mount(el, ctx) {
    const { store, route, sem, session, gradeTypes, semesterLocked, refresh, isStale } = ctx;
    el.innerHTML = loading('Loading assignments…');

    // Graded counts are lazy: the list renders first, counts fill in when grades land.
    const gradesPromise = sem ? store.getGrades(sem) : Promise.resolve([]);
    const [subject, cls, list, students] = await Promise.all([
        store.getSubject(),
        store.getClass().catch(() => null),
        store.getAssignments(),
        store.getStudents(),
    ]);
    if (isStale()) return;

    configureWorkbench({
        session,
        subject,
        className: cls?.name || subject?.className || '',
        assignments: list,
        students,
        gradeTypes,
        semesterLocked,
        onChange: () => refresh(['assignments', `grades:${sem}`]),
    });
    setAssignmentEditorRoute((id) => ctx.navigate({ assignment: id }));

    if (route.assignment) { mountEditor(el, ctx, list); return; }
    setCrumb(null);
    detach(el);
    clickHandler = (e) => {
        if (e.target.closest('[data-action="new-assignment"]')) { ctx.navigate({ assignment: 'new' }); return; }
        const open = e.target.closest('[data-open-assignment]');
        if (open) ctx.navigate({ assignment: open.dataset.openAssignment });
    };
    el.addEventListener('click', clickHandler);

    const gradeUrl = (a) => `../grade_form/grade_form.html?${new URLSearchParams({ subjectId: route.s, assignmentId: a.id })}`;

    const sorted = list.slice().sort((a, b) => String(b.createdAt || '').localeCompare(String(a.createdAt || '')));
    const active = sorted.filter((a) => !a.completed);
    const done = sorted.filter((a) => a.completed);

    const row = (a, graded) => {
        const id = esc(a.id);
        return `
        <div class="px-4 py-3 flex items-center justify-between gap-3 ${graded ? 'opacity-75' : ''}">
            <div class="min-w-0">
                <div class="flex items-center gap-2 flex-wrap">
                    ${graded ? '<i class="fa-solid fa-circle-check text-emerald-500 text-sm"></i>' : ''}
                    <button type="button" data-open-assignment="${id}" class="font-bold text-[#0d1f35] hover:text-[#2563eb] hover:underline text-[13px] m-0 truncate text-left" title="Open assignment">${esc(a.title || 'Untitled')}</button>
                    <span class="text-[10px] font-bold uppercase bg-[#eef4ff] text-[#2563eb] border border-[#c7d9fd] px-2 py-0.5 rounded">${esc(a.type || '')}</span>
                    ${a.maxScore ? `<span class="text-[10px] font-bold text-[#6b84a0] bg-[#f4f7fb] border border-[#dce3ed] px-2 py-0.5 rounded">/ ${esc(a.maxScore)}</span>` : ''}
                    ${a.locked ? '<span class="text-[10px] font-bold uppercase bg-amber-50 text-amber-700 border border-amber-200 px-2 py-0.5 rounded"><i class="fa-solid fa-lock text-[9px] mr-1"></i>Locked</span>' : ''}
                    ${Array.isArray(a.questions) && a.questions.length ? `<span class="text-[10px] font-bold text-[#6b84a0] bg-[#f4f7fb] border border-[#dce3ed] px-2 py-0.5 rounded">${a.questions.length} question${a.questions.length === 1 ? '' : 's'}</span>` : ''}
                </div>
                ${a.instructions ? `<p class="text-[11.5px] text-[#6b84a0] m-0 mt-0.5 truncate">${esc(a.instructions)}</p>` : ''}
                <p class="text-[11px] text-[#9ab0c6] font-semibold m-0 mt-0.5">${a.date || a.dueDate ? `Due ${esc(formatDueDate(a.date || a.dueDate))} · ` : ''}<span data-graded-for="${id}">…</span>/${students.length} graded</p>
            </div>
            <div class="flex items-center gap-1.5 flex-shrink-0">
                <a href="../assessments/live.html?${new URLSearchParams({ c: route.c, s: route.s, a: a.id })}" target="_blank" rel="noopener" class="${BTN} text-rose-700 bg-rose-50 border-rose-200 hover:bg-rose-600 hover:text-white" title="Live command center"><i class="fa-solid fa-tower-broadcast text-[10px]"></i>Live</a>
                <button type="button" onclick="openReviewSubmissions('${id}')" class="${BTN} text-teal-700 bg-teal-50 border-teal-200 hover:bg-teal-600 hover:text-white" title="Review submissions"><i class="fa-solid fa-inbox text-[10px]"></i>Review</button>
                <a href="${gradeUrl(a)}" class="${BTN} text-[#2563eb] bg-white border-[#c7d9fd] hover:bg-[#eef4ff]" title="Open in Enter Grade"><i class="fa-solid fa-pen-to-square text-[10px]"></i>Grade</a>
                <button type="button" onclick="editAssignment('${id}')" class="${BTN} text-[#374f6b] bg-[#f4f7fb] border-[#dce3ed] hover:bg-white" title="Edit"><i class="fa-solid fa-pen text-[10px]"></i>Edit</button>
                <button type="button" onclick="toggleAssignmentComplete('${id}')" class="${BTN} ${graded ? 'text-[#374f6b] bg-[#f4f7fb] border-[#dce3ed]' : 'text-emerald-700 bg-emerald-50 border-emerald-200 hover:bg-emerald-600 hover:text-white'}" title="${graded ? 'Reopen for grading' : 'Mark as graded — hides it from Enter Grade'}">
                    <i class="fa-solid ${graded ? 'fa-rotate-left' : 'fa-check'} text-[10px]"></i>${graded ? 'Reopen' : 'Mark graded'}
                </button>
                <button type="button" onclick="toggleAssignmentLocked('${id}')" class="h-8 w-8 rounded flex items-center justify-center hover:bg-amber-50 ${a.locked ? 'text-amber-500' : 'text-[#9ab0c6] hover:text-amber-500'}" title="${a.locked ? 'Unlock' : 'Lock'}"><i class="fa-solid ${a.locked ? 'fa-lock' : 'fa-lock-open'} text-sm"></i></button>
                <button type="button" onclick="deleteAssignment('${id}')" class="h-8 w-8 rounded flex items-center justify-center text-[#9ab0c6] hover:text-red-500 hover:bg-red-50" title="Delete"><i class="fa-solid fa-trash-can text-sm"></i></button>
            </div>
        </div>`;
    };

    const create = `<button type="button" data-action="new-assignment" class="text-[11.5px] font-bold text-white bg-[#0d1f35] hover:bg-[#2563eb] px-3 py-1.5 rounded transition"><i class="fa-solid fa-plus text-[10px] mr-1"></i>Add Work</button>`;
    const locked = semesterLocked
        ? '<div class="bg-amber-50 border border-amber-200 rounded-xl p-3 mb-4 text-[12.5px] font-bold text-amber-700"><i class="fa-solid fa-lock mr-1.5"></i>This period is locked. You can still prepare assignments, but grading is read-only until an admin unlocks it.</div>'
        : '';

    if (!list.length) {
        el.innerHTML = locked + card('Assignments', emptyBox('No assignments yet for this subject.', 'Add a quiz, test or assessment. It appears in Enter Grade and in students\' Assignments.'), create);
        return;
    }

    el.innerHTML = locked
        + card(`Active · ${active.length}`, active.length
            ? `<div class="divide-y divide-[#f0f4f8]">${active.map((a) => row(a, false)).join('')}</div>`
            : '<p class="px-4 py-6 text-center text-[12.5px] text-[#9ab0c6] m-0">All assignments are graded.</p>', create)
        + (done.length ? `<div class="mt-4">${card(`Graded · ${done.length}`, `<div class="divide-y divide-[#f0f4f8]">${done.map((a) => row(a, true)).join('')}</div>`)}</div>` : '');

    let grades = [];
    try { grades = await gradesPromise; } catch (e) { console.error('[Assignments tab] grades:', e); }
    if (isStale()) return;
    const gradedBy = new Map();
    grades.forEach((g) => { if (g.assignmentId) gradedBy.set(g.assignmentId, (gradedBy.get(g.assignmentId) || 0) + 1); });
    el.querySelectorAll('[data-graded-for]').forEach((span) => { span.textContent = String(gradedBy.get(span.dataset.gradedFor) || 0); });
}

export function unmount(el) {
    detach(el);
    if (editorHandle) { editorHandle.destroy(); editorHandle = null; }
    setAssignmentEditorRoute(null);
    setCrumb(null);
    el.innerHTML = '';
}
