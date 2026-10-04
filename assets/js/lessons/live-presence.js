// assets/js/lessons/live-presence.js — who is in the live session right now.
//
// Realtime Database, not Firestore: each student's viewer holds one node at
//   livePresence/{schoolId}/{sessionId}/{studentId}
// and registers onDisconnect().remove() on it, so the RTDB server deletes the
// node the moment that student's socket drops (tab closed, network lost,
// laptop asleep). No heartbeats, no polling. Rules: database.rules.json —
// a student writes only their own node; only staff of the school read.
//
//   createStudentPresence({ schoolId, studentId, name }) → { join(sessionId), leave() }
//   mountPresenceRoster({ host, schoolId, classId, sessionId }) → { stop() }

import { db, rtdb } from '../../../assets/js/firebase-init.js';
import { ref, set, remove, onValue, onDisconnect, serverTimestamp }
    from "https://www.gstatic.com/firebasejs/10.7.1/firebase-database.js";
import { doc, getDoc, getDocs, collection, query, where }
    from "https://www.gstatic.com/firebasejs/10.7.1/firebase-firestore.js";

const ROOT = 'livePresence';
const nodePath = (schoolId, sessionId, studentId) =>
    `${ROOT}/${schoolId}/${sessionId}${studentId ? `/${studentId}` : ''}`;

export function initialsOf(name, fallback = '') {
    let s = String(name || '').trim();
    if (s.includes(',')) { const [last, first] = s.split(','); s = `${first || ''} ${last || ''}`.trim(); }
    const parts = s.split(/\s+/).filter(Boolean);
    if (!parts.length) return String(fallback || '?').slice(0, 2).toUpperCase();
    const a = parts[0][0] || '';
    const b = parts.length > 1 ? parts[parts.length - 1][0] : (parts[0][1] || '');
    return (a + b).toUpperCase();
}

// ── STUDENT ──────────────────────────────────────────────────────────────
export function createStudentPresence({ schoolId, studentId, name }) {
    let sid = null;
    let node = null;
    let unsubConn = null;

    function leave() {
        if (unsubConn) { unsubConn(); unsubConn = null; }
        if (node) {
            const n = node;
            node = null;
            onDisconnect(n).cancel().catch(() => {});
            remove(n).catch(() => {});
        }
        sid = null;
    }

    function join(sessionId) {
        if (!schoolId || !studentId || !sessionId || sessionId === sid) return;
        leave();
        sid = sessionId;
        const me = ref(rtdb, nodePath(schoolId, sessionId, studentId));
        node = me;
        const fullName = String(name || '').slice(0, 120);
        // .info/connected fires on every (re)connect: re-arm the server-side
        // removal first, then mark this student online again.
        unsubConn = onValue(ref(rtdb, '.info/connected'), (snap) => {
            if (snap.val() !== true || node !== me) return;
            onDisconnect(me).remove()
                .then(() => {
                    if (node !== me) return;
                    return set(me, {
                        online: true,
                        name: fullName,
                        initials: initialsOf(fullName, studentId),
                        studentId,
                        at: serverTimestamp(),
                    });
                })
                .catch((e) => console.warn('[Presence] join:', e));
        });
    }

    return { join, leave };
}

// ── TEACHER ──────────────────────────────────────────────────────────────
const CSS = `
.lpr { display: flex; align-items: center; flex-wrap: wrap; gap: 10px 14px; background: #fff; border: 1px solid #e2e8f0; border-radius: 16px; padding: 10px 14px; margin-top: 12px; flex: 0 0 auto; }
.lpr[hidden] { display: none !important; }
.lpr-count { display: inline-flex; align-items: center; gap: 7px; font-size: 12px; font-weight: 800; color: #334155; white-space: nowrap; }
.lpr-count i { color: #10b981; font-size: 12px; }
.lpr-count b { font-size: 14px; color: #0f172a; }
.lpr-group { display: flex; flex-wrap: wrap; gap: 6px; align-items: center; }
.lpr-sep { font-size: 10.5px; font-weight: 900; letter-spacing: .08em; text-transform: uppercase; color: #94a3b8; white-space: nowrap; padding-left: 12px; border-left: 1px solid #e2e8f0; }
.lpr-empty { font-size: 12px; font-weight: 600; color: #94a3b8; }
.lpr-b { position: relative; width: 30px; height: 30px; border-radius: 999px; display: inline-flex; align-items: center; justify-content: center; font-size: 11px; font-weight: 900; letter-spacing: .02em; color: #fff; background: var(--c, #6366f1); box-shadow: 0 0 0 2px #fff, 0 0 0 3.5px var(--c, #6366f1); cursor: default; user-select: none; animation: lpr-in .25s ease-out; }
.lpr-b.lpr-away { background: #e2e8f0; color: #94a3b8; box-shadow: 0 0 0 2px #fff, 0 0 0 3px #e2e8f0; animation: none; }
.lpr-b:focus-visible { outline: 2px solid #6366f1; outline-offset: 3px; }
.lpr-b:hover::after, .lpr-b:focus-visible::after { content: attr(data-tip); position: absolute; bottom: calc(100% + 8px); left: 50%; transform: translateX(-50%); white-space: pre; text-align: center; background: #0f172a; color: #fff; font-size: 11px; font-weight: 700; line-height: 1.35; letter-spacing: 0; padding: 5px 9px; border-radius: 7px; z-index: 30; pointer-events: none; }
@keyframes lpr-in { from { transform: scale(.6); opacity: 0; } to { transform: scale(1); opacity: 1; } }
`;
const COLORS = ['#6366f1', '#0ea5e9', '#10b981', '#f59e0b', '#ef4444', '#8b5cf6', '#ec4899', '#14b8a6', '#f97316', '#84cc16', '#06b6d4', '#a855f7'];

function injectCss() {
    if (document.getElementById('lpr-css')) return;
    const s = document.createElement('style');
    s.id = 'lpr-css';
    s.textContent = CSS;
    document.head.appendChild(s);
}

function colorFor(id) {
    let h = 0;
    for (const ch of String(id)) h = (h * 31 + ch.charCodeAt(0)) >>> 0;
    return COLORS[h % COLORS.length];
}

function esc(str) {
    return String(str ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#039;' }[c]));
}

// Active students enrolled in this class (same match as the subject page).
export async function loadClassRoster(schoolId, classId) {
    const [cls, snap] = await Promise.all([
        getDoc(doc(db, 'schools', schoolId, 'classes', classId)).catch(() => null),
        getDocs(query(collection(db, 'students'), where('currentSchoolId', '==', schoolId), where('enrollmentStatus', '==', 'Active'))),
    ]);
    const className = cls && cls.exists() ? (cls.data().name || '') : '';
    return snap.docs
        .map((d) => ({ id: d.id, ...d.data() }))
        .filter((s) => s.classId === classId || (!s.classId && !!className && s.className === className))
        .map((s) => ({ id: s.id, name: s.name || s.fullName || s.id }));
}

export function mountPresenceRoster({ host, schoolId, classId, sessionId }) {
    if (!host || !schoolId || !sessionId) return null;
    injectCss();
    host.classList.add('lpr');
    host.hidden = false;
    host.setAttribute('aria-label', 'Students in this live session');
    host.innerHTML = '<span class="lpr-empty">Loading class…</span>';

    let roster = [];
    let online = new Map(); // studentId → { name }
    let stopped = false;
    let loaded = false;

    const bubble = (s, away) => {
        const tip = `${s.name}\nID: ${s.id}${away ? '\nNot here' : ''}`;
        return `<span class="lpr-b${away ? ' lpr-away' : ''}" tabindex="0" style="--c:${colorFor(s.id)}" data-tip="${esc(tip)}" aria-label="${esc(`${s.name}, ${s.id}${away ? ', not here' : ', here'}`)}">${esc(initialsOf(s.name, s.id))}</span>`;
    };

    function paint() {
        if (stopped || !loaded) return;
        const byName = (a, b) => a.name.localeCompare(b.name);
        const enrolled = new Set(roster.map((s) => s.id));
        const here = roster.filter((s) => online.has(s.id));
        // online but not on the roster (e.g. moved class mid-term) — still in the room
        online.forEach((v, id) => { if (!enrolled.has(id)) here.push({ id, name: v.name || id }); });
        const away = roster.filter((s) => !online.has(s.id));
        const total = roster.length + (here.length - roster.filter((s) => online.has(s.id)).length);
        host.innerHTML = `
            <span class="lpr-count" aria-live="polite"><i class="fa-solid fa-circle"></i><span><b>${here.length}</b> / ${total} here</span></span>
            <div class="lpr-group">${here.length ? here.sort(byName).map((s) => bubble(s, false)).join('') : '<span class="lpr-empty">Waiting for students to join…</span>'}</div>
            ${away.length ? `<span class="lpr-sep">Not here</span><div class="lpr-group">${away.sort(byName).map((s) => bubble(s, true)).join('')}</div>` : ''}`;
    }

    loadClassRoster(schoolId, classId)
        .then((r) => { roster = r; loaded = true; paint(); })
        .catch((e) => { console.warn('[Presence] roster:', e); loaded = true; paint(); });

    const unsub = onValue(ref(rtdb, nodePath(schoolId, sessionId)), (snap) => {
        const next = new Map();
        snap.forEach((child) => {
            const v = child.val();
            if (v && v.online === true) next.set(child.key, { name: v.name || '' });
        });
        online = next;
        paint();
    }, (e) => console.warn('[Presence] listen:', e));

    return {
        // hidden once the session has ended (listener kept: a cached "ended"
        // snapshot can arrive before the server confirms a restart)
        setVisible(on) { if (!stopped) host.hidden = !on; },
        stop() {
            if (stopped) return;
            stopped = true;
            unsub();
            host.hidden = true;
            host.innerHTML = '';
        },
    };
}
