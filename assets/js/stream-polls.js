// ── CLASS STREAM: POLLS + QUESTION HELPERS (Module 3.5) ──────────────────
// Open voting, stored on the post document itself (zero extra reads; the
// stream's existing live listener carries every vote):
//
//   poll:  { options: [{ id, text }], optionIds: [id…], allowChange: bool,
//            closesAt: Timestamp|null, closed: bool }
//   votes: { [studentId]: { name, choice, at } }
//
// votes is a MAP keyed by studentId (not an array) so firestore.rules can
// guarantee one vote per student and that a student only ever writes their
// own entry — rules cannot search an array for "an element with my id".
//
// Question posts: question: { blindReplies: bool }. With blind replies on,
// the student UI hides classmates' comments until the student has posted
// their own (UI-level: the comments still live on the post document).
import { db } from './firebase-init.js';
import { doc, updateDoc, FieldPath, deleteField }
    from "https://www.gstatic.com/firebasejs/10.7.1/firebase-firestore.js";

function esc(str) {
    if (str === null || str === undefined) return '';
    return String(str).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;').replace(/'/g, '&#039;');
}

function postRef(schoolId, post) {
    return doc(db, 'schools', schoolId, 'classes', post.classId, 'subjects', post.subjectId, 'posts', post.id);
}

function closesAtDate(poll) {
    const c = poll && poll.closesAt;
    if (!c) return null;
    if (typeof c.toDate === 'function') return c.toDate();
    const d = new Date(c);
    return isNaN(d.getTime()) ? null : d;
}

export function isPollOpen(post) {
    const poll = post.poll || {};
    if (poll.closed) return false;
    const until = closesAtDate(poll);
    return !until || Date.now() < until.getTime();
}

export function voteList(post) {
    const votes = post.votes && typeof post.votes === 'object' ? post.votes : {};
    return Object.entries(votes).map(([studentId, v]) => ({ studentId, ...(v || {}) }));
}

// Blind replies moved to stream-answers.js (isAnswerHiddenForStudent):
// answers now live in their own sub-collection and the rules enforce it.

export function injectPollCss() {
    if (document.getElementById('stream-polls-css')) return;
    const st = document.createElement('style');
    st.id = 'stream-polls-css';
    st.textContent = `
    .pl-wrap { margin-top: 12px; display: flex; flex-direction: column; gap: 8px; }
    .pl-meta { display: flex; align-items: center; gap: 8px; flex-wrap: wrap; font-size: 11px; font-weight: 700; color: #64748b; }
    .pl-badge { font-size: 9.5px; font-weight: 800; text-transform: uppercase; letter-spacing: 0.06em; padding: 2px 7px; border-radius: 4px; }
    .pl-open { background: #ecfdf5; color: #047857; border: 1px solid #a7f3d0; }
    .pl-closed { background: #f1f5f9; color: #64748b; border: 1px solid #e2e8f0; }
    .pl-opt { position: relative; display: block; width: 100%; text-align: left; border: 1px solid #e2e8f0; border-radius: 10px; background: #fff; padding: 10px 12px; font: inherit; overflow: hidden; }
    button.pl-opt { cursor: pointer; }
    button.pl-opt:hover { border-color: #6366f1; }
    button.pl-opt:disabled { cursor: default; }
    .pl-opt.pl-mine { border-color: #6366f1; box-shadow: 0 0 0 2px rgba(99,102,241,0.18); }
    .pl-bar { position: absolute; inset: 0 auto 0 0; background: #eef2ff; transition: width 0.35s ease; z-index: 0; }
    .pl-opt.pl-mine .pl-bar { background: #e0e7ff; }
    .pl-row { position: relative; z-index: 1; display: flex; align-items: center; justify-content: space-between; gap: 10px; }
    .pl-text { font-size: 13px; font-weight: 700; color: #1e293b; display: flex; align-items: center; gap: 7px; }
    .pl-count { font-size: 12px; font-weight: 800; color: #4338ca; font-family: 'DM Mono', monospace; white-space: nowrap; }
    .pl-names { position: relative; z-index: 1; display: flex; flex-wrap: wrap; gap: 4px; margin-top: 7px; }
    .pl-name { display: inline-flex; align-items: center; gap: 4px; font-size: 11px; font-weight: 700; color: #334155; background: #fff; border: 1px solid #e2e8f0; border-radius: 999px; padding: 1px 4px 1px 8px; }
    .pl-name button { background: none; border: none; color: #94a3b8; cursor: pointer; font-size: 10px; padding: 1px 4px; border-radius: 999px; }
    .pl-name button:hover { color: #e11d48; background: #fff1f2; }
    .pl-controls { display: flex; gap: 6px; flex-wrap: wrap; }
    .pl-ctl { border: 1px solid #cbd5e1; background: #fff; color: #334155; font: inherit; font-size: 11.5px; font-weight: 800; border-radius: 8px; padding: 5px 10px; cursor: pointer; display: inline-flex; align-items: center; gap: 6px; }
    .pl-ctl:hover { border-color: #0d1f35; color: #0d1f35; }
    .pl-ctl.pl-danger:hover { border-color: #e11d48; color: #e11d48; }
    .pl-pending { background: #fffbeb; border: 1px solid #fde68a; border-radius: 10px; padding: 8px 10px; font-size: 11.5px; color: #78350f; font-weight: 600; }
    .pl-pending b { font-weight: 800; }
    .pl-hint { font-size: 11.5px; color: #64748b; font-weight: 600; }
    .pl-err { font-size: 11.5px; font-weight: 700; color: #b91c1c; }
    `;
    document.head.appendChild(st);
}

const errors = new Map(); // postId -> message (survives live re-renders)

/**
 * @param {object} post
 * @param {{ role: 'teacher'|'student'|'parent', viewerId?: string, roster?: Array<{id,name}>|null }} opts
 */
export function pollHtml(post, { role, viewerId = '', roster = null }) {
    if (post.type !== 'poll' || !post.poll) return '';
    const poll = post.poll;
    const options = Array.isArray(poll.options) ? poll.options : [];
    const votes = voteList(post);
    const total = votes.length;
    const open = isPollOpen(post);
    const mine = role === 'student' ? votes.find(v => v.studentId === viewerId) : null;
    const canVote = role === 'student' && open && (!mine || poll.allowChange);
    const showResults = role !== 'student' || !!mine || !open;
    const until = closesAtDate(poll);

    const rows = options.map(opt => {
        const voters = votes.filter(v => v.choice === opt.id);
        const pct = total ? Math.round(voters.length / total * 100) : 0;
        const isMine = mine && mine.choice === opt.id;
        const tag = canVote ? 'button' : 'div';
        const attrs = canVote ? `type="button" data-poll-action="vote" data-option-id="${esc(opt.id)}"` : '';
        const names = role === 'teacher' && voters.length
            ? `<div class="pl-names">${voters.map(v => `<span class="pl-name">${esc(v.name || v.studentId)}<button type="button" data-poll-action="remove-vote" data-student-id="${esc(v.studentId)}" title="Remove this vote" aria-label="Remove ${esc(v.name || 'this')} vote"><i class="fa-solid fa-xmark"></i></button></span>`).join('')}</div>`
            : '';
        return `
        <${tag} class="pl-opt${isMine ? ' pl-mine' : ''}" ${attrs}>
            ${showResults ? `<span class="pl-bar" style="width:${pct}%"></span>` : ''}
            <span class="pl-row">
                <span class="pl-text">${isMine ? '<i class="fa-solid fa-circle-check" style="color:#4f46e5"></i>' : (canVote ? '<i class="fa-regular fa-circle" style="color:#94a3b8"></i>' : '')}${esc(opt.text)}</span>
                ${showResults ? `<span class="pl-count">${voters.length} · ${pct}%</span>` : ''}
            </span>
            ${names}
        </${tag}>`;
    }).join('');

    let notVoted = '';
    if (role === 'teacher' && Array.isArray(roster)) {
        const voted = new Set(votes.map(v => v.studentId));
        const missing = roster.filter(s => !voted.has(s.id));
        notVoted = missing.length
            ? `<div class="pl-pending"><b>Not voted yet (${missing.length}):</b> ${missing.map(s => esc(s.name || s.id)).join(', ')}</div>`
            : (roster.length ? `<div class="pl-pending" style="background:#ecfdf5;border-color:#a7f3d0;color:#047857;"><b>Everyone has voted.</b></div>` : '');
    }

    const controls = role === 'teacher' ? `
        <div class="pl-controls">
            <button type="button" class="pl-ctl" data-poll-action="${poll.closed ? 'reopen' : 'close'}"><i class="fa-solid ${poll.closed ? 'fa-lock-open' : 'fa-lock'}"></i>${poll.closed ? 'Reopen Poll' : 'Close Poll'}</button>
            <button type="button" class="pl-ctl pl-danger" data-poll-action="reset" ${total ? '' : 'disabled'}><i class="fa-solid fa-rotate-left"></i>Reset Votes</button>
        </div>` : '';

    const hint = role === 'student'
        ? (canVote ? (mine ? 'Tap another option to change your vote.' : 'Tap an option to vote.')
                   : (!open ? 'Voting is closed.' : 'Your vote is in.'))
        : '';

    return `
    <div class="pl-wrap" data-poll-for="${esc(post.id)}">
        <div class="pl-meta">
            <span class="pl-badge ${open ? 'pl-open' : 'pl-closed'}">${open ? 'Poll open' : 'Poll closed'}</span>
            <span>${total} vote${total === 1 ? '' : 's'}</span>
            ${until ? `<span>· ${open ? 'Closes' : 'Closed'} ${esc(until.toLocaleString(undefined, { month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' }))}</span>` : ''}
            ${poll.allowChange ? '<span>· Votes can be changed</span>' : ''}
        </div>
        ${rows}
        ${hint ? `<p class="pl-hint">${esc(hint)}</p>` : ''}
        ${notVoted}
        ${controls}
        <p class="pl-err" data-poll-error ${errors.has(post.id) ? '' : 'hidden'}>${esc(errors.get(post.id) || '')}</p>
    </div>`;
}

/**
 * Delegated click handler. Returns true if it handled the event.
 * @param {Event} e
 * @param {{ schoolId, findPost: (id) => object|null, voter?: { studentId, name } }} cfg
 */
export async function handlePollEvent(e, cfg) {
    const btn = e.target.closest('[data-poll-action]');
    if (!btn) return false;
    const wrap = btn.closest('[data-poll-for]');
    const post = wrap && cfg.findPost(wrap.dataset.pollFor);
    if (!post) return true;
    const ref = postRef(cfg.schoolId, post);
    const action = btn.dataset.pollAction;
    const showErr = (msg) => {
        errors.set(post.id, msg);
        const el = document.querySelector(`[data-poll-for="${CSS.escape(post.id)}"] [data-poll-error]`);
        if (el) { el.textContent = msg; el.hidden = false; }
    };
    errors.delete(post.id);
    btn.disabled = true;

    try {
        if (action === 'vote' && cfg.voter) {
            await updateDoc(ref, new FieldPath('votes', cfg.voter.studentId), {
                name: String(cfg.voter.name || '').slice(0, 80),
                choice: btn.dataset.optionId,
                at: new Date().toISOString(),
            });
        } else if (action === 'close') {
            await updateDoc(ref, { 'poll.closed': true });
        } else if (action === 'reopen') {
            // Reopening also clears a passed close date, so the poll is actually open.
            const until = closesAtDate(post.poll);
            await updateDoc(ref, until && until.getTime() <= Date.now()
                ? { 'poll.closed': false, 'poll.closesAt': null }
                : { 'poll.closed': false });
        } else if (action === 'reset') {
            if (!confirm('Reset all votes on this poll? This cannot be undone.')) { btn.disabled = false; return true; }
            await updateDoc(ref, { votes: {} });
        } else if (action === 'remove-vote') {
            if (!confirm('Remove this student\'s vote?')) { btn.disabled = false; return true; }
            await updateDoc(ref, new FieldPath('votes', btn.dataset.studentId), deleteField());
        }
    } catch (err) {
        console.error(`[Polls] ${action}:`, err);
        showErr(action === 'vote' ? 'Could not save your vote. Voting may have closed.' : 'That change could not be saved. Please try again.');
    }
    btn.disabled = false;
    return true;
}
