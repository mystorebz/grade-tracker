// teacher/subjects/tabs/lessons.js — Lessons tab with the in-context Lesson Builder
//
// Route: …&tab=lessons                 → #lessonList (library + New Lesson)
//        …&tab=lessons&lesson={id}     → #lessonWorkspace (mountLessonEditor)
//        …&tab=lessons&lesson=new-slides|new-document → in-memory draft; nothing is
//                                       written until the first save/publish/autosave,
//                                       then the URL is rewritten to the real id.
// The teacher never leaves the subject page: Back / the breadcrumb / the
// editor's own "All Lessons" button return to the list, edits autosave
// (2 s debounce) and are flushed before the editor unmounts.

import { buildNewLesson, deleteLesson } from '../../../assets/js/lessons.js';
import { mountLessonEditor, preloadLessonEditor } from '../../../assets/js/lessons/builder.js';
import { esc, loading, card, emptyBox, formatDate } from './ui.js';

let clickHandler = null;
let editor = null;            // handle returned by mountLessonEditor()

const WIDE = 'max-w-none';
const NARROW = 'max-w-5xl';
// Page-level breadcrumb: Subjects › Class › Subject › {lesson title}
function setLessonCrumb(title) {
    const sep = document.getElementById('crumbLessonSep');
    const li = document.getElementById('crumbLesson');
    if (!sep || !li) return;
    const show = title !== null && title !== undefined;
    sep.hidden = !show;
    li.hidden = !show;
    li.textContent = show ? (title || 'Untitled Lesson') : '';
    document.getElementById('crumbSubject')?.toggleAttribute('aria-current', !show);
    if (show) li.setAttribute('aria-current', 'page'); else li.removeAttribute('aria-current');
    if (!show) {
        const subjectName = document.getElementById('subjectTitle')?.textContent;
        if (subjectName) document.title = `${subjectName} | Subjects | ConnectUs`;
    }
}

function setWide(on) {
    const shell = document.getElementById('subjectShell');
    if (!shell) return;
    shell.classList.toggle(WIDE, on);
    shell.classList.toggle(NARROW, !on);
}

export async function mount(el, ctx) {
    const { store, route, session, navigate, isStale } = ctx;
    el.innerHTML = `<div id="lessonList"></div><div id="lessonWorkspace" hidden></div>`;
    const listEl = el.querySelector('#lessonList');
    const workEl = el.querySelector('#lessonWorkspace');
    preloadLessonEditor(); // warm template + Quill while the list renders

    if (route.lesson) {
        await mountWorkspace(el, listEl, workEl, ctx);
    } else {
        setWide(false);
        setLessonCrumb(null);
        listEl.innerHTML = loading('Loading lessons…');
        const lessons = await store.getLessons();
        if (isStale()) return;
        renderList(listEl, lessons, route);
    }

    detach(el);
    clickHandler = async (e) => {
        const t = e.target;
        if (t.closest('[data-action="back"]')) { navigate({ lesson: null }); return; }
        if (t.closest('[data-action="new"]')) { el.querySelector('#newLessonChooser')?.toggleAttribute('hidden'); return; }
        const fmt = t.closest('[data-format]');
        if (fmt) { navigate({ lesson: fmt.dataset.format === 'document' ? 'new-document' : 'new-slides' }); return; }
        const live = t.closest('[data-action="live"]');
        if (live) {
            const params = new URLSearchParams({ lessonId: live.dataset.id, classId: route.c, subjectId: route.s, subjectName: live.dataset.subject || '' });
            window.open(`../lessons/live.html?${params}`, '_blank');
            return;
        }
        const del = t.closest('[data-action="delete"]');
        if (del) {
            if (!confirm(`Delete "${del.dataset.title || 'this lesson'}"? This cannot be undone.`)) return;
            try {
                await deleteLesson(session.schoolId, { classId: route.c, subjectId: route.s }, del.dataset.id);
                ctx.refresh(['lessons']);
            } catch (err) {
                console.error('[Lessons tab] deleteLesson:', err);
                alert('Failed to delete this lesson. Please try again.');
            }
            return;
        }
        const row = t.closest('[data-lesson-id]');
        if (row) navigate({ lesson: row.dataset.lessonId });
    };
    el.addEventListener('click', clickHandler);
}

export function unmount(el) {
    detach(el);
    setWide(false);
    setLessonCrumb(null);
    if (editor) {
        const h = editor;
        editor = null;
        h.unmount({ force: true }); // flushes pending edits (async), then tears down
    }
    el.innerHTML = '';
}

function detach(el) {
    if (clickHandler) el.removeEventListener('click', clickHandler);
    clickHandler = null;
}

// ── LIST ─────────────────────────────────────────────────────────────────
function renderList(listEl, lessons, route) {
    const newBtn = `<button type="button" data-action="new" class="text-[11.5px] font-bold text-white bg-[#0d1f35] hover:bg-[#2563eb] px-3 py-1.5 rounded transition"><i class="fa-solid fa-plus text-[10px] mr-1"></i>New Lesson</button>`;
    const chooser = `
        <div id="newLessonChooser" hidden class="grid grid-cols-1 sm:grid-cols-2 gap-3 mb-4">
            <button type="button" data-format="slides" class="text-left bg-white border border-[#dce3ed] hover:border-[#2563eb] hover:bg-[#eef4ff] rounded-xl p-4 transition">
                <i class="fa-solid fa-images text-[#2563eb] text-lg"></i>
                <p class="font-bold text-[#0d1f35] text-[13.5px] m-0 mt-2">Slide Deck</p>
                <p class="text-[11.5px] text-[#6b84a0] m-0">A paginated, click-through presentation — like Google Slides.</p>
            </button>
            <button type="button" data-format="document" class="text-left bg-white border border-[#dce3ed] hover:border-[#2563eb] hover:bg-[#eef4ff] rounded-xl p-4 transition">
                <i class="fa-solid fa-file-lines text-[#2563eb] text-lg"></i>
                <p class="font-bold text-[#0d1f35] text-[13.5px] m-0 mt-2">Document</p>
                <p class="text-[11.5px] text-[#6b84a0] m-0">A single scrolling page with rich text — like Word or Google Docs.</p>
            </button>
        </div>`;

    if (!lessons.length) {
        listEl.innerHTML = chooser + card('Lessons', emptyBox('No lessons yet for this subject.', 'Create one with New Lesson — it opens right here.'), newBtn);
        return;
    }

    listEl.innerHTML = chooser + card(`${lessons.length} lesson${lessons.length === 1 ? '' : 's'}`, `
        <div class="divide-y divide-[#f0f4f8]">${lessons.map((l) => {
            const published = l.status === 'published';
            return `
            <div class="px-4 py-3 flex items-center justify-between gap-3 hover:bg-[#f8fafc] transition">
                <button type="button" data-lesson-id="${esc(l.id)}" class="min-w-0 flex-1 text-left">
                    <span class="flex items-center gap-2 flex-wrap">
                        <span class="font-bold text-[#0d1f35] text-[13px] truncate">${esc(l.title || 'Untitled Lesson')}</span>
                        <span class="text-[10px] font-bold uppercase px-2 py-0.5 rounded border ${published ? 'bg-emerald-50 text-emerald-700 border-emerald-200' : 'bg-slate-100 text-slate-500 border-slate-200'}">${published ? 'Published' : 'Draft'}</span>
                        <span class="text-[10px] font-bold text-[#6b84a0] bg-[#f4f7fb] border border-[#dce3ed] px-2 py-0.5 rounded">${l.format === 'document' ? 'Document' : `Slides · ${l.slideCount || 0}`}</span>
                    </span>
                    <span class="block text-[11px] text-[#9ab0c6] font-semibold mt-0.5">Updated ${esc(formatDate(l.updatedAt))}</span>
                </button>
                <div class="flex items-center gap-1 flex-shrink-0">
                    ${published ? `<button type="button" data-action="live" data-id="${esc(l.id)}" data-subject="${esc(l.subjectName || '')}" class="h-8 w-8 rounded flex items-center justify-center text-[#6b84a0] hover:text-[#0d9488] hover:bg-[#f0fdfa]" title="Present live"><i class="fa-solid fa-tower-broadcast text-xs"></i></button>` : ''}
                    <button type="button" data-action="delete" data-id="${esc(l.id)}" data-title="${esc(l.title || '')}" class="h-8 w-8 rounded flex items-center justify-center text-[#6b84a0] hover:text-[#e31b4a] hover:bg-[#fff0f3]" title="Delete"><i class="fa-solid fa-trash text-xs"></i></button>
                </div>
            </div>`;
        }).join('')}</div>`, newBtn);
}

// ── WORKSPACE (embedded editor) ──────────────────────────────────────────
async function mountWorkspace(el, listEl, workEl, ctx) {
    const { store, route, session, navigate, replaceRoute, isStale } = ctx;
    const newFormat = /^new-(slides|document)$/.exec(route.lesson || '')?.[1] || null;
    listEl.hidden = true;
    workEl.hidden = false;
    setWide(true);
    workEl.innerHTML = `
        <div class="flex items-center gap-2 mb-3 text-[12px] font-bold text-[#6b84a0]">
            <button type="button" data-action="back" class="hover:text-[#2563eb]"><i class="fa-solid fa-arrow-left mr-1"></i>Lessons</button>
            <span aria-hidden="true">›</span><span id="lessonCrumbTitle" class="text-[#0d1f35] truncate">Loading…</span>
        </div>
        <div id="lessonEditorHost" class="flex flex-col bg-white border border-[#dce3ed] rounded-xl overflow-hidden" style="height: calc(100vh - 250px); min-height: 560px;">
            ${loading('Opening lesson…')}
        </div>`;
    const host = workEl.querySelector('#lessonEditorHost');
    const crumb = workEl.querySelector('#lessonCrumbTitle');
    const setTitle = (t) => {
        crumb.textContent = t || 'Untitled Lesson';
        setLessonCrumb(t || '');
        const subjectName = document.getElementById('subjectTitle')?.textContent || 'Subjects';
        document.title = `${t || 'Untitled Lesson'} · ${subjectName} | ConnectUs`;
    };

    try {
        const [subject, cls, assignments] = await Promise.all([
            store.getSubject(), store.getClass().catch(() => null), store.getAssignments().catch(() => []),
        ]);
        if (isStale()) return;
        const author = { authorId: session.teacherId, authorName: session.teacherData?.name || '' };
        const postContext = {
            classId: route.c, className: cls?.name || subject?.className || '',
            subjectId: route.s, subjectName: subject?.name || '',
        };
        // New lesson: local draft only (isNew) — see buildNewLesson()
        const draft = newFormat ? buildNewLesson(session.schoolId, postContext, author, { title: 'Untitled Lesson', format: newFormat }) : null;
        const handle = await mountLessonEditor(host, {
            schoolId: session.schoolId,
            classId: route.c,
            subjectId: route.s,
            lessonId: draft ? draft.id : route.lesson,
            draft,
            subjectName: subject?.name || '',
            className: cls?.name || subject?.className || '',
            assignments,
            author,
            onExit: () => navigate({ lesson: null }),
            onSaved: () => store.invalidate('lessons'),
            // first save of a draft: the lesson now exists → give the URL its real id
            onCreated: (id) => { store.invalidate('lessons'); replaceRoute({ lesson: id }); },
            onTitleChange: setTitle,
        });
        if (isStale()) { handle.unmount({ force: true }); return; }
        editor = handle;
        setTitle(handle.lesson.title);
    } catch (e) {
        console.error('[Lessons tab] mountLessonEditor:', e);
        if (isStale()) return;
        crumb.textContent = 'Lesson not found';
        host.innerHTML = emptyBox('This lesson could not be opened.', 'It may have been deleted, or it belongs to another subject.');
    }
}
