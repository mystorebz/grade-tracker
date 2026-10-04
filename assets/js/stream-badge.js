// ── CLASS STREAM: SIDEBAR "NEW" BADGE (cached quick check) ────────────────
// Shows a "New" pill with a dismiss × on the sidebar's Class Stream link when
// there is stream activity (a post, an edit, or a comment by someone else)
// newer than the last time this user looked at the stream.
//
// Cost model:
//   • Class Stream page: zero extra reads — the page's existing live feed
//     reports activity here (reportStreamActivity) and caches the user's
//     subject list (cacheStreamContexts).
//   • Every other page: at most once every 5 minutes per user, one
//     `orderBy(createdAt desc) limit(1)` read per cached subject. The result
//     is cached in localStorage, so page-to-page navigation inside that window
//     costs nothing. If the user has never opened the stream on this browser
//     there is no subject list cached and nothing is read.
//   Limitation: between visits, other pages only see activity on each
//   subject's NEWEST post (a comment on an older post shows up once the
//   stream page itself is opened, or when a newer post arrives).
//
// Storage keys are per role + user, so a teacher and a student sharing one
// browser never clear each other's badge:
//   lastViewedStream:<role>:<userId>   ms timestamp of last stream view/dismiss
//   streamLatest:<role>:<userId>       ms timestamp of newest known activity
//   streamCheckedAt:<role>:<userId>    ms timestamp of last cross-page check
//   streamContexts:<role>:<userId>     [{ classId, subjectId }]
//
// Globally accessible: window.ConnectUsStreamBadge = { check, markViewed, refresh }.
import { db } from './firebase-init.js';
import { collection, query, orderBy, limit, getDocs } from "https://www.gstatic.com/firebasejs/10.7.1/firebase-firestore.js";

const CHECK_TTL_MS = 5 * 60 * 1000;
let ctx = null; // { role, userId, schoolId, onStreamPage }

function key(name) { return `${name}:${ctx.role}:${ctx.userId}`; }
function readNum(name) {
    try { return Number(localStorage.getItem(key(name))) || 0; } catch (e) { return 0; }
}
function writeVal(name, value) {
    try { localStorage.setItem(key(name), String(value)); } catch (e) { /* storage blocked: badge just won't persist */ }
}

function ms(iso) { const t = Date.parse(iso || ''); return Number.isFinite(t) ? t : 0; }

// Newest activity on one post that was NOT made by the viewer themself.
export function postActivityTime(post, viewerId) {
    let latest = 0;
    if (post.authorId !== viewerId) latest = Math.max(ms(post.createdAt), ms(post.updatedAt));
    (Array.isArray(post.comments) ? post.comments : []).forEach(c => {
        if (c && c.authorId !== viewerId) latest = Math.max(latest, ms(c.createdAt));
    });
    return latest;
}

// ── BADGE DOM ─────────────────────────────────────────────────────────────
function injectCss() {
    if (document.getElementById('stream-badge-css')) return;
    const st = document.createElement('style');
    st.id = 'stream-badge-css';
    st.textContent = `
    .sb-badge { margin-left: auto; display: inline-flex; align-items: center; gap: 3px; background: #e11d48; color: #fff; border-radius: 999px; padding: 1px 3px 1px 7px; font-size: 9.5px; font-weight: 900; letter-spacing: 0.04em; text-transform: uppercase; line-height: 16px; flex-shrink: 0; }
    .sb-badge[hidden] { display: none; }
    .sb-dismiss { display: inline-flex; align-items: center; justify-content: center; width: 15px; height: 15px; border-radius: 50%; font-size: 12px; line-height: 1; cursor: pointer; opacity: 0.85; }
    .sb-dismiss:hover, .sb-dismiss:focus-visible { background: rgba(255,255,255,0.25); opacity: 1; outline: none; }
    `;
    document.head.appendChild(st);
}

function badgeEl() {
    const nav = document.getElementById('nav-stream');
    if (!nav) return null;
    let badge = nav.querySelector('.sb-badge');
    if (badge) return badge;
    injectCss();
    badge = document.createElement('span');
    badge.className = 'sb-badge';
    badge.hidden = true;
    badge.innerHTML = 'New<span class="sb-dismiss" role="button" tabindex="0" title="Dismiss" aria-label="Dismiss new stream activity">×</span>';
    const dismiss = badge.querySelector('.sb-dismiss');
    const onDismiss = (e) => {
        // The badge sits inside the sidebar <a>: stop both the bubble and the
        // link's default navigation.
        e.preventDefault();
        e.stopPropagation();
        markStreamViewed();
    };
    dismiss.addEventListener('click', onDismiss);
    dismiss.addEventListener('keydown', (e) => { if (e.key === 'Enter' || e.key === ' ') onDismiss(e); });
    nav.appendChild(badge);
    return badge;
}

export function refreshStreamBadge() {
    if (!ctx) return;
    const badge = badgeEl();
    if (!badge) return;
    badge.hidden = !(readNum('streamLatest') > readNum('lastViewedStream'));
}

// ── PUBLIC API ────────────────────────────────────────────────────────────
export function markStreamViewed() {
    if (!ctx) return;
    writeVal('lastViewedStream', Date.now());
    refreshStreamBadge();
}

// Called by the stream pages' live feeds with the posts they hold.
export function reportStreamActivity(posts) {
    if (!ctx || !Array.isArray(posts)) return;
    const latest = posts.reduce((m, p) => Math.max(m, postActivityTime(p, ctx.userId)), 0);
    if (latest > readNum('streamLatest')) writeVal('streamLatest', latest);
    // Looking at the stream right now → it's seen. In a background tab the
    // badge lights up instead.
    if (ctx.onStreamPage && document.visibilityState === 'visible') markStreamViewed();
    else refreshStreamBadge();
}

// Called by the stream pages so other pages know which subjects to check.
export function cacheStreamContexts(contexts) {
    if (!ctx || !Array.isArray(contexts)) return;
    const slim = contexts.filter(c => c && c.classId && c.subjectId).map(c => ({ classId: c.classId, subjectId: c.subjectId }));
    try { localStorage.setItem(key('streamContexts'), JSON.stringify(slim)); } catch (e) { /* ignore */ }
}

// Cross-page check: cached for CHECK_TTL_MS; otherwise one limit(1) read per subject.
export async function checkStreamActivity({ force = false } = {}) {
    if (!ctx) return;
    refreshStreamBadge(); // paint from cache immediately
    if (!force && Date.now() - readNum('streamCheckedAt') < CHECK_TTL_MS) return;
    let contexts = [];
    try { contexts = JSON.parse(localStorage.getItem(key('streamContexts')) || '[]'); } catch (e) { contexts = []; }
    if (!contexts.length) return;
    writeVal('streamCheckedAt', Date.now()); // claim the window before reading, so parallel tabs don't double-read
    const results = await Promise.all(contexts.map(c =>
        getDocs(query(
            collection(db, 'schools', ctx.schoolId, 'classes', c.classId, 'subjects', c.subjectId, 'posts'),
            orderBy('createdAt', 'desc'),
            limit(1),
        )).then(snap => snap.docs.map(d => ({ id: d.id, ...d.data() })))
          .catch(e => { console.warn('[StreamBadge] check', c.subjectId, e.code || e.message); return []; })
    ));
    const latest = results.flat().reduce((m, p) => Math.max(m, postActivityTime(p, ctx.userId)), 0);
    if (latest > readNum('streamLatest')) writeVal('streamLatest', latest);
    refreshStreamBadge();
}

// Called once by each layout after the sidebar is injected.
export function initStreamBadge({ role, userId, schoolId, onStreamPage }) {
    if (!role || !userId || !schoolId) return;
    ctx = { role, userId, schoolId, onStreamPage: !!onStreamPage };
    window.ConnectUsStreamBadge = {
        check: (opts) => checkStreamActivity(opts),
        markViewed: markStreamViewed,
        refresh: refreshStreamBadge,
    };
    if (ctx.onStreamPage) {
        markStreamViewed();
        document.addEventListener('visibilitychange', () => {
            if (document.visibilityState === 'visible') markStreamViewed();
        });
    } else {
        checkStreamActivity();
    }
    // Another tab viewed/dismissed the stream → update this tab's badge too.
    window.addEventListener('storage', (e) => {
        if (e.key && e.key.endsWith(`:${ctx.role}:${ctx.userId}`)) refreshStreamBadge();
    });
}
