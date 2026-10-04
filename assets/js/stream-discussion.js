// ── CLASS STREAM: FULL DISCUSSION PAGE (shared by teacher + student) ─────
// Opened by clicking a compact stream card (or its title / comment pill). Listens to ONE post
// document (a single live read, not the whole stream) and renders the post
// with its complete comment thread and a composer pinned to the bottom.
// URL: discussion.html?classId=…&subjectId=…&postId=…
import { db } from './firebase-init.js';
import { doc, onSnapshot } from "https://www.gstatic.com/firebasejs/10.7.1/firebase-firestore.js";
import { injectCommentCss, commentsSectionHtml, renderPreservingDrafts, handleCommentEvent } from './stream-comments.js';
import { displayPostText } from './posts.js';
import { injectPollCss, pollHtml, handlePollEvent } from './stream-polls.js';
import { watchAnswers, answersView, isAnswerHiddenForStudent, studentHasAnswered, stopAllAnswerWatches } from './stream-answers.js';

function esc(str) {
    if (str === null || str === undefined) return '';
    return String(str).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;').replace(/'/g, '&#039;');
}

function formatDate(iso) {
    if (!iso) return '';
    const d = /^\d{4}-\d{2}-\d{2}$/.test(iso) ? new Date(iso + 'T00:00:00') : new Date(iso);
    return isNaN(d.getTime()) ? String(iso) : d.toLocaleDateString(undefined, { month: 'short', day: 'numeric', year: 'numeric' });
}

export function discussionParams() {
    const p = new URLSearchParams(location.search);
    return { classId: p.get('classId'), subjectId: p.get('subjectId'), postId: p.get('postId') };
}

// Link builder used by both stream pages for "View all N comments".
export function discussionUrl(post) {
    return `discussion.html?${new URLSearchParams({ classId: post.classId, subjectId: post.subjectId, postId: post.id }).toString()}`;
}

/**
 * @param {{ schoolId: string, author: { authorId, authorName, role },
 *           canComment: boolean, canDelete: (comment) => boolean,
 *           backHref: (params) => string, ctaHtml?: (post) => string,
 *           loadRoster?: (post) => Promise<Array<{id,name}>> }} cfg
 * @returns {() => void} unsubscribe
 */
export function initDiscussionPage(cfg) {
    injectCommentCss();
    injectPollCss();
    const role = cfg.author.role;               // 'teacher' | 'student'
    const viewerId = cfg.author.authorId;
    const params = discussionParams();
    const host = document.getElementById('discussionHost');
    const back = document.getElementById('discussionBack');
    if (back) back.href = cfg.backHref(params);

    const showMessage = (icon, msg) => {
        host.innerHTML = `<div class="text-center py-16 text-slate-400 text-[13px] font-bold bg-white rounded-xl border border-slate-200"><i class="fa-solid ${icon} text-2xl mb-3 block"></i>${esc(msg)}</div>`;
    };

    if (!params.classId || !params.subjectId || !params.postId) {
        showMessage('fa-link-slash', 'This discussion link is incomplete.');
        return () => {};
    }

    let post = null;
    // Teacher poll view: class roster for the "Not voted yet" list, loaded once.
    let roster = null;
    let rosterRequested = false;
    const ensureRoster = () => {
        if (rosterRequested || !cfg.loadRoster || !post || post.type !== 'poll') return;
        rosterRequested = true;
        Promise.resolve(cfg.loadRoster(post))
            .then(list => { roster = Array.isArray(list) ? list : null; render(); })
            .catch(err => console.error('[Discussion] roster:', err));
    };
    const render = () => {
        if (!post) return;
        const isQuestion = post.type === 'question';
        // Question answers come from posts/{postId}/answers (live listener).
        if (isQuestion) watchAnswers(cfg.schoolId, post, { role, id: viewerId }, render);
        const shown = isQuestion ? answersView(post) : post;
        const text = displayPostText(post);
        document.title = `${text.title || 'Discussion'} | Class Stream | ConnectUs`;
        renderPreservingDrafts(host, () => {
            host.innerHTML = `
            <article class="bg-white rounded-xl shadow-sm border border-slate-200 p-5">
                <div class="flex items-center gap-2 flex-wrap">
                    ${post.pinned ? '<i class="fa-solid fa-thumbtack text-[11px] text-rose-500" title="Pinned"></i>' : ''}
                    <h2 class="font-black text-slate-800 text-[17px] m-0">${esc(text.title) || (post.type === 'lesson_plan' ? 'Untitled Lesson' : 'Announcement')}</h2>
                    ${post.type === 'lesson_plan' && post.lessonDate ? `<span class="text-[10.5px] font-black bg-amber-50 text-amber-700 px-2 py-0.5 rounded border border-amber-200">${esc(formatDate(post.lessonDate))}</span>` : ''}
                    ${post.subjectName ? `<span class="text-[10.5px] font-bold bg-slate-100 text-slate-500 px-2 py-0.5 rounded">${esc(post.subjectName)}</span>` : ''}
                </div>
                ${text.body ? `<p class="text-[13px] text-slate-600 mt-2 mb-0 whitespace-pre-wrap">${esc(text.body)}</p>` : ''}
                ${post.type === 'lesson_plan' && post.objectives ? `<p class="text-[12px] text-slate-500 mt-2 mb-0 whitespace-pre-wrap"><span class="font-bold">Objectives:</span> ${esc(post.objectives)}</p>` : ''}
                ${role === 'teacher' && post.type === 'question' && post.question && post.question.blindReplies ? '<p class="mt-2 mb-0"><span class="inline-flex items-center gap-1.5 text-[10.5px] font-black uppercase tracking-wider text-slate-500 bg-slate-100 px-2 py-1 rounded border border-slate-200"><i class="fa-solid fa-eye-slash text-[9px]"></i>Blind replies · students see answers after posting their own</span></p>' : ''}
                ${pollHtml(post, { role, viewerId, roster })}
                ${cfg.ctaHtml ? cfg.ctaHtml(post) : ''}
                <p class="text-[11px] text-slate-400 font-semibold mt-3 mb-0">${esc(post.authorName || '')} · ${esc(formatDate(post.createdAt))}</p>
                ${commentsSectionHtml(shown, { full: true, canDelete: cfg.canDelete,
                    // one answer per student; teachers can always reply
                    canComment: cfg.canComment && !(isQuestion && role === 'student' && studentHasAnswered(post)),
                    hideList: isQuestion && role === 'student' && isAnswerHiddenForStudent(post) })}
            </article>`;
        });
    };

    const commentCfg = {
        schoolId: cfg.schoolId,
        findPost: () => post,
        author: cfg.author,
        rerender: render,
    };
    host.addEventListener('click', async (e) => {
        if (await handlePollEvent(e, {
            schoolId: cfg.schoolId,
            findPost: () => post,
            voter: role === 'student' ? { studentId: viewerId, name: cfg.author.authorName } : null,
        })) return;
        handleCommentEvent(e, commentCfg);
    });
    host.addEventListener('keydown', (e) => handleCommentEvent(e, commentCfg));

    const ref = doc(db, 'schools', cfg.schoolId, 'classes', params.classId, 'subjects', params.subjectId, 'posts', params.postId);
    let firstPaint = true;
    const unsub = onSnapshot(ref, (snap) => {
        if (!snap.exists()) {
            post = null;
            showMessage('fa-comment-slash', 'This post was removed.');
            return;
        }
        post = { id: snap.id, ...snap.data() };
        render();
        ensureRoster();
        if (firstPaint) {
            firstPaint = false;
            // Land on the newest comment, like a chat.
            host.querySelector('.sc-list li:last-child')?.scrollIntoView({ block: 'nearest' });
        }
    }, (err) => {
        console.error('[Discussion] listener:', err);
        showMessage('fa-lock', err && err.code === 'permission-denied'
            ? "You don't have access to this discussion."
            : 'Could not load this discussion. Please try again.');
    });

    const stop = () => { unsub(); stopAllAnswerWatches(); };
    window.addEventListener('pagehide', stop);
    return stop;
}

// Compact card click → open the post page. The stream lists use one delegated
// click listener, so per-element stopPropagation can't shield children;
// instead any click that lands on (or inside) an interactive element —
// CTA links, buttons (edit/delete), poll blocks, comment/answer blocks,
// form fields — is ignored here and handled by its own control.
const NO_OPEN = 'a, button, input, textarea, select, label, [data-poll-for], [data-comments-for], [data-no-open]';
export function openPostFromCardClick(e) {
    if (e.defaultPrevented || e.button !== 0) return false;
    if (e.target.closest(NO_OPEN)) return false;
    const card = e.target.closest('[data-open-href]');
    if (!card) return false;
    if (String(window.getSelection ? window.getSelection() : '').length) return false; // selecting text, not clicking
    if (e.metaKey || e.ctrlKey) window.open(card.dataset.openHref, '_blank', 'noopener');
    else location.href = card.dataset.openHref;
    return true;
}

// Back link target on the stream page: scroll to + highlight the post once.
export function focusPostFromUrl(container) {
    const id = new URLSearchParams(location.search).get('focus');
    if (!id) return false;
    const card = container.querySelector(`[data-post-id="${CSS.escape(id)}"]`);
    if (!card) return false;
    card.scrollIntoView({ block: 'center' });
    card.style.transition = 'box-shadow 0.4s';
    card.style.boxShadow = '0 0 0 3px rgba(99,102,241,0.45)';
    setTimeout(() => { card.style.boxShadow = ''; }, 1800);
    const url = new URL(location.href);
    url.searchParams.delete('focus');
    history.replaceState(null, '', url.pathname + url.search);
    return true;
}
