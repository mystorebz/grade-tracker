// ── CLASS STREAM: INLINE DISCUSSION UI (Module 3) ────────────────────────
// Shared by teacher/stream and student/stream. Comments live in the post
// document's own `comments` array (see posts.js addPostComment /
// deletePostComment), so opening a thread costs zero extra reads.
// EXCEPTION: answers to a Question post live in posts/{postId}/answers
// (stream-answers.js) so the database can enforce blind replies. Pages pass
// answersView(post) here, and send/delete below route to that module.
//
// Pages render commentsSectionHtml(post, opts) at the bottom of each card
// and delegate clicks to handleCommentClick(). Expanded threads and unsent
// drafts survive the live re-renders driven by onSnapshot.
import { addPostComment, deletePostComment, COMMENT_MAX_LENGTH } from './posts.js';
import { addAnswer, deleteAnswer } from './stream-answers.js';

const expanded = new Set();   // postIds with an open thread
const errors = new Map();     // postId -> last error message (survives live re-renders)

function esc(str) {
    if (str === null || str === undefined) return '';
    return String(str).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;').replace(/'/g, '&#039;');
}

function timeAgo(iso) {
    const t = Date.parse(iso || '');
    if (!t) return '';
    const s = Math.max(0, Math.round((Date.now() - t) / 1000));
    if (s < 60) return 'just now';
    if (s < 3600) return `${Math.floor(s / 60)}m ago`;
    if (s < 86400) return `${Math.floor(s / 3600)}h ago`;
    if (s < 7 * 86400) return `${Math.floor(s / 86400)}d ago`;
    return new Date(t).toLocaleDateString(undefined, { month: 'short', day: 'numeric' });
}

export function injectCommentCss() {
    if (document.getElementById('stream-comments-css')) return;
    const st = document.createElement('style');
    st.id = 'stream-comments-css';
    st.textContent = `
    .sc-wrap { margin-top: 12px; border-top: 1px solid #eef2f6; padding-top: 8px; }
    .sc-toggle { display: inline-flex; align-items: center; gap: 6px; background: none; border: none; padding: 4px 6px; margin-left: -6px; border-radius: 6px; font: inherit; font-size: 12px; font-weight: 700; color: #64748b; cursor: pointer; }
    .sc-toggle:hover { background: #f1f5f9; color: #334155; }
    .sc-toggle .sc-count { font-family: 'DM Mono', monospace; font-size: 11px; }
    .sc-list { list-style: none; margin: 8px 0 0; padding: 0; display: flex; flex-direction: column; gap: 8px; }
    .sc-item { display: flex; gap: 9px; align-items: flex-start; }
    .sc-avatar { width: 26px; height: 26px; border-radius: 50%; flex-shrink: 0; display: flex; align-items: center; justify-content: center; font-size: 11px; font-weight: 800; color: #fff; background: #94a3b8; }
    .sc-avatar.sc-teacher { background: #0d1f35; }
    .sc-avatar.sc-student { background: #6366f1; }
    .sc-bubble { flex: 1; min-width: 0; background: #f8fafc; border: 1px solid #eef2f6; border-radius: 10px; padding: 7px 10px; }
    .sc-meta { display: flex; align-items: center; gap: 6px; flex-wrap: wrap; font-size: 11px; color: #94a3b8; font-weight: 600; }
    .sc-name { font-weight: 800; color: #1e293b; font-size: 12px; }
    .sc-role { font-size: 9.5px; font-weight: 800; text-transform: uppercase; letter-spacing: 0.06em; background: #0d1f35; color: #fff; border-radius: 4px; padding: 1px 5px; }
    .sc-text { font-size: 12.5px; color: #334155; margin: 3px 0 0; white-space: pre-wrap; word-break: break-word; }
    .sc-del { margin-left: auto; background: none; border: none; color: #94a3b8; cursor: pointer; font-size: 11px; padding: 2px 4px; border-radius: 4px; }
    .sc-del:hover { color: #e11d48; background: #fff1f2; }
    .sc-empty { font-size: 12px; color: #94a3b8; font-weight: 600; margin: 8px 0 0; }
    .sc-form { display: flex; gap: 8px; align-items: flex-end; margin-top: 10px; }
    .sc-input { flex: 1; min-height: 36px; max-height: 120px; resize: vertical; border: 1px solid #cbd5e1; border-radius: 10px; padding: 8px 10px; font: inherit; font-size: 12.5px; color: #0f172a; outline: none; }
    .sc-input:focus { border-color: #6366f1; box-shadow: 0 0 0 3px rgba(99,102,241,0.12); }
    .sc-send { flex-shrink: 0; height: 36px; padding: 0 14px; border: none; border-radius: 10px; background: #4f46e5; color: #fff; font: inherit; font-size: 12px; font-weight: 800; cursor: pointer; }
    .sc-send:disabled { opacity: 0.55; cursor: not-allowed; }
    .sc-err { font-size: 11.5px; font-weight: 700; color: #b91c1c; margin: 6px 0 0; }
    .sc-viewall { display: inline-flex; align-items: center; gap: 6px; margin-top: 8px; font-size: 12px; font-weight: 800; color: #4f46e5; text-decoration: none; }
    .sc-viewall:hover { text-decoration: underline; }
    .sc-older { font-size: 11.5px; font-weight: 700; color: #94a3b8; margin: 8px 0 0; }
    .sc-full .sc-list { gap: 10px; }
    .sc-full .sc-form { position: sticky; bottom: 0; background: #fff; padding: 12px 0 4px; margin-top: 12px; border-top: 1px solid #eef2f6; }
    /* Compact stream cards: the card opens its post page on click. */
    [data-open-href] { cursor: pointer; transition: border-color 0.15s, box-shadow 0.15s; }
    [data-open-href]:hover { border-color: #a5b4fc; box-shadow: 0 4px 14px rgba(15,23,42,0.07); }
    [data-open-href] .pl-wrap, [data-open-href] .sc-wrap { cursor: auto; }
    .cs-title-link { color: inherit; text-decoration: none; }
    .cs-title-link:hover { text-decoration: underline; }
    .cs-clamp { display: -webkit-box; -webkit-line-clamp: 2; line-clamp: 2; -webkit-box-orient: vertical; overflow: hidden; white-space: pre-line; word-break: break-word; }
    .sc-pill { display: inline-flex; align-items: center; gap: 6px; margin-top: 10px; padding: 3px 10px; border-radius: 999px; background: #f1f5f9; border: 1px solid #e2e8f0; font-size: 11.5px; font-weight: 800; color: #475569; text-decoration: none; }
    .sc-pill:hover { background: #eef2ff; border-color: #c7d2fe; color: #4338ca; }
    `;
    document.head.appendChild(st);
}

export const COMMENT_PREVIEW_COUNT = 3;

/**
 * @param {object} post
 * @param {{ canComment: boolean, canDelete: (comment) => boolean,
 *           discussionUrl?: (post) => string, full?: boolean }} opts
 *   full: the discussion page — always open, every comment, no toggle.
 *   Otherwise an open thread shows the latest COMMENT_PREVIEW_COUNT
 *   comments plus a "View all N comments" link to discussionUrl(post).
 */
export function commentsSectionHtml(post, { canComment, canDelete, discussionUrl, full = false, hideList = false, hiddenNote = '' }) {
    const all = Array.isArray(post.comments) ? post.comments.filter(c => c && c.id) : [];
    const open = full || expanded.has(post.id);
    const hidden = full ? 0 : Math.max(0, all.length - COMMENT_PREVIEW_COUNT);
    const comments = hidden ? all.slice(-COMMENT_PREVIEW_COUNT) : all;
    const isQuestion = post.type === 'question';
    const noun = isQuestion ? 'answer' : 'comment';
    const label = all.length ? `${all.length} ${noun}${all.length === 1 ? '' : 's'}` : (canComment ? (isQuestion ? 'Answer this question' : 'Add a comment') : `No ${noun}s`);

    const list = comments.map(c => {
        const role = c.role === 'teacher' ? 'teacher' : (c.role === 'student' ? 'student' : 'other');
        return `
        <li class="sc-item">
            <div class="sc-avatar sc-${role}">${esc((c.authorName || '?').charAt(0).toUpperCase())}</div>
            <div class="sc-bubble">
                <div class="sc-meta">
                    <span class="sc-name">${esc(c.authorName || 'Unknown')}</span>
                    ${role === 'teacher' ? '<span class="sc-role">Teacher</span>' : ''}
                    <span>${esc(timeAgo(c.createdAt))}</span>
                    ${canDelete(c) ? `<button type="button" class="sc-del" data-action="delete-comment" data-comment-id="${esc(c.id)}" title="Delete comment" aria-label="Delete comment"><i class="fa-solid fa-trash"></i></button>` : ''}
                </div>
                <p class="sc-text">${esc(c.text)}</p>
            </div>
        </li>`;
    }).join('');

    const viewAll = hidden && discussionUrl
        ? `<a class="sc-viewall" href="${esc(discussionUrl(post))}"><i class="fa-regular fa-comments"></i> View all ${all.length} comments</a>`
        : (hidden ? `<p class="sc-older">${hidden} earlier comment${hidden === 1 ? '' : 's'} not shown</p>` : '');

    const listHtml = hideList
        ? `<p class="sc-empty"><i class="fa-solid fa-eye-slash" style="margin-right:6px;"></i>${esc(hiddenNote || 'Answer this question to see what your classmates said.')}</p>`
        : `${hidden ? viewAll : ''}${comments.length ? `<ul class="sc-list">${list}</ul>` : (canComment ? '' : `<p class="sc-empty">No ${noun}s yet.</p>`)}`;

    return `
    <div class="sc-wrap${full ? ' sc-full' : ''}" data-comments-for="${esc(post.id)}">
        ${full
            ? `<p class="sc-toggle" style="cursor:default;"><i class="fa-regular fa-comments"></i> <span class="sc-count">${esc(label)}</span></p>`
            : `<button type="button" class="sc-toggle" data-action="toggle-comments" aria-expanded="${open}">
            <i class="fa-regular fa-comment"></i> <span class="sc-count">${esc(label)}</span>
            <i class="fa-solid fa-chevron-${open ? 'up' : 'down'}" style="font-size:9px;"></i>
        </button>`}
        ${open ? `
            ${listHtml}
            ${canComment ? `
            <div class="sc-form">
                <textarea class="sc-input" data-comment-input rows="1" maxlength="${COMMENT_MAX_LENGTH}" placeholder="${isQuestion ? 'Write your answer…' : 'Write a comment…'}" aria-label="${isQuestion ? 'Write your answer' : 'Write a comment'}"></textarea>
                <button type="button" class="sc-send" data-action="send-comment">Post</button>
            </div>` : ''}
            <p class="sc-err" data-comment-error ${errors.has(post.id) ? '' : 'hidden'}>${esc(errors.get(post.id) || '')}</p>` : ''}
    </div>`;
}

// Compact stream card footer: "💬 N comments" pill linking to the post page.
export function commentPillHtml(post, href) {
    const n = Array.isArray(post.comments) ? post.comments.filter(c => c && c.id).length : 0;
    const label = n ? `${n} comment${n === 1 ? '' : 's'}` : 'Comment';
    return `<a class="sc-pill" href="${esc(href)}"><i class="fa-regular fa-comment"></i> ${esc(label)}</a>`;
}

// Re-render wrapper: keeps typed-but-unsent drafts and focus through a
// live onSnapshot re-render of the whole list.
export function renderPreservingDrafts(container, render) {
    const drafts = new Map();
    let focusedId = null;
    container.querySelectorAll('[data-comments-for]').forEach(w => {
        const input = w.querySelector('[data-comment-input]');
        if (input && input.value) drafts.set(w.dataset.commentsFor, input.value);
        if (input && document.activeElement === input) focusedId = w.dataset.commentsFor;
    });
    render();
    drafts.forEach((value, id) => {
        const input = container.querySelector(`[data-comments-for="${CSS.escape(id)}"] [data-comment-input]`);
        if (input) input.value = value;
    });
    if (focusedId) container.querySelector(`[data-comments-for="${CSS.escape(focusedId)}"] [data-comment-input]`)?.focus();
}

/**
 * Delegated click/keydown handler. Returns true if it handled the event.
 * @param {Event} e
 * @param {{ schoolId: string, findPost: (id) => object|null, author: { authorId, authorName, role },
 *           rerender: () => void, onPatched?: (postId, comments) => void }} cfg
 */
export async function handleCommentEvent(e, cfg) {
    const wrap = e.target.closest('[data-comments-for]');
    if (!wrap) return false;
    const postId = wrap.dataset.commentsFor;

    if (e.type === 'keydown') {
        if (e.key !== 'Enter' || e.shiftKey || !e.target.matches('[data-comment-input]')) return false;
        e.preventDefault();
        return handleCommentEvent({ target: wrap.querySelector('[data-action="send-comment"]'), type: 'click' }, cfg);
    }

    const btn = e.target.closest('[data-action]');
    if (!btn) return false;
    const post = cfg.findPost(postId);
    if (!post) return true;
    const ctx = { classId: post.classId, subjectId: post.subjectId };
    const isQuestion = post.type === 'question'; // answers sub-collection; live listener repaints
    const errEl = wrap.querySelector('[data-comment-error]');
    const showErr = (msg) => {
        errors.set(postId, msg);
        const el = document.querySelector(`[data-comments-for="${CSS.escape(postId)}"] [data-comment-error]`) || errEl;
        if (el) { el.textContent = msg; el.hidden = false; }
    };
    errors.delete(postId);

    if (btn.dataset.action === 'toggle-comments') {
        expanded.has(postId) ? expanded.delete(postId) : expanded.add(postId);
        cfg.rerender();
        if (expanded.has(postId)) document.querySelector(`[data-comments-for="${CSS.escape(postId)}"] [data-comment-input]`)?.focus();
        return true;
    }

    if (btn.dataset.action === 'send-comment') {
        const input = wrap.querySelector('[data-comment-input]');
        const text = (input?.value || '').trim();
        if (!text) return true;
        btn.disabled = true;
        try {
            input.value = ''; // clear before the live re-render can carry it over as a draft
            let comment;
            try {
                comment = isQuestion
                    ? await addAnswer(cfg.schoolId, post, { text, ...cfg.author })
                    : await addPostComment(cfg.schoolId, ctx, postId, { text, ...cfg.author });
            } catch (sendErr) {
                const live = document.querySelector(`[data-comments-for="${CSS.escape(postId)}"] [data-comment-input]`);
                if (live && !live.value) live.value = text; // put the unsent text back
                throw sendErr;
            }
            const live = document.querySelector(`[data-comments-for="${CSS.escape(postId)}"] [data-comment-input]`);
            if (live && live.value === text) live.value = '';
            if (!isQuestion) cfg.onPatched && cfg.onPatched(postId, [...(post.comments || []), comment]);
        } catch (err) {
            console.error('[Stream] addPostComment:', err);
            showErr(isQuestion && err && err.code === 'permission-denied' && cfg.author.role === 'student'
                ? 'You have already answered this question.'
                : `Could not post your ${isQuestion ? 'answer' : 'comment'}. Please try again.`);
        }
        const liveBtn = document.querySelector(`[data-comments-for="${CSS.escape(postId)}"] [data-action="send-comment"]`);
        if (liveBtn) liveBtn.disabled = false;
        btn.disabled = false;
        return true;
    }

    if (btn.dataset.action === 'delete-comment') {
        if (!confirm('Delete this comment?')) return true;
        btn.disabled = true;
        try {
            if (isQuestion) {
                await deleteAnswer(cfg.schoolId, post, btn.dataset.commentId);
            } else {
                const next = await deletePostComment(cfg.schoolId, ctx, postId, btn.dataset.commentId);
                cfg.onPatched && cfg.onPatched(postId, next);
            }
        } catch (err) {
            console.error('[Stream] deletePostComment:', err);
            btn.disabled = false;
            showErr('Could not delete that comment. Please try again.');
        }
        return true;
    }
    return false;
}
