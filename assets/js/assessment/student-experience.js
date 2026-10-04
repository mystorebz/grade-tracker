// assets/js/assessment/student-experience.js — themes, anti-cheat, review,
// "show your work" uploads and the live (RTDB) client for the student focus page.

import { rtdb } from '../firebase-init.js';
import { ref, set, update, push, remove, onValue, onDisconnect, runTransaction, serverTimestamp }
    from "https://www.gstatic.com/firebasejs/10.7.1/firebase-database.js";
import { K5_TEAMS, normalizeTheme, normalizeControl, remainingMs, formatClock, violationFor } from './engine-core.js';
import { compressImage } from './image-compress.js';

const esc = (v) => String(v ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#039;' }[c]));

const CSS = `
/* ── K-5 theme ── */
body.theme-k5 { background: linear-gradient(160deg,#fef3c7 0%,#fce7f3 45%,#dbeafe 100%) fixed !important; }
body.theme-k5 .asg-focus-bar { background: rgba(255,255,255,.85); border-bottom: 3px solid #fbbf24; }
body.theme-k5 .asg-focus-head h1 { font-size: 34px; background: linear-gradient(90deg,#ec4899,#8b5cf6,#0ea5e9); -webkit-background-clip: text; background-clip: text; color: transparent; }
body.theme-k5 #assignmentDetailBody > div, body.theme-k5 #assignmentDetailBody .bg-white { border-radius: 22px !important; border-width: 3px !important; border-color: #fde68a !important; }
body.theme-k5 #assignmentDetailBody button.bg-gradient-to-r, body.theme-k5 #adSubmitBtn { border-radius: 999px !important; background: linear-gradient(90deg,#f59e0b,#ec4899,#8b5cf6) !important; font-size: 16px !important; padding: 14px !important; box-shadow: 0 8px 20px -6px rgba(236,72,153,.6); }
body.theme-k5 input[type=radio] { width: 22px !important; height: 22px !important; }
body.theme-k5 #assignmentDetailBody { font-size: 17px; }
.k5-team { display: inline-flex; align-items: center; gap: 6px; padding: 4px 12px 4px 6px; border-radius: 999px; font: 800 12.5px 'DM Sans',sans-serif; color: #fff; border: 0; cursor: pointer; }
.k5-team span { font-size: 18px; }
.xp-back { position: fixed; inset: 0; z-index: 2147482500; background: rgba(15,23,42,.55); backdrop-filter: blur(3px); display: flex; align-items: center; justify-content: center; padding: 16px; }
.xp-card { background: #fff; border-radius: 20px; max-width: 560px; width: 100%; padding: 26px; box-shadow: 0 25px 50px -12px rgba(0,0,0,.35); font-family: 'DM Sans',sans-serif; max-height: calc(100vh - 32px); overflow: auto; }
.xp-card h2 { margin: 0 0 6px; font-size: 22px; font-weight: 800; color: #0f172a; }
.xp-card p { margin: 0 0 16px; color: #64748b; font-size: 13.5px; font-weight: 600; }
.k5-grid { display: grid; grid-template-columns: repeat(3,1fr); gap: 10px; }
.k5-pick { border: 3px solid transparent; border-radius: 18px; padding: 14px 6px; font: 800 13px 'DM Sans',sans-serif; color: #fff; cursor: pointer; display: flex; flex-direction: column; align-items: center; gap: 4px; transition: transform .15s; }
.k5-pick:hover, .k5-pick:focus-visible { transform: scale(1.06); border-color: #0f172a; outline: none; }
.k5-pick span { font-size: 34px; }
/* ── strict theme ── */
body.theme-strict { background: #f8fafc !important; }
body.theme-strict #assignmentFocus { user-select: none; -webkit-user-select: none; }
body.theme-strict #assignmentFocus input, body.theme-strict #assignmentFocus textarea { user-select: text; -webkit-user-select: text; }
body.theme-strict .asg-focus-bar { border-bottom: 2px solid #0f172a; }
.xp-strict-badge { display: inline-flex; align-items: center; gap: 6px; font: 800 10.5px 'DM Sans',sans-serif; letter-spacing: .08em; text-transform: uppercase; color: #b91c1c; background: #fef2f2; border: 1px solid #fecaca; padding: 4px 9px; border-radius: 6px; }
.xp-warn .xp-card { border: 3px solid #dc2626; }
.xp-warn h2 { color: #b91c1c; }
/* ── timer / pause / toast ── */
.xp-timer { font: 800 13px 'DM Mono',monospace; padding: 5px 10px; border-radius: 8px; background: #eef2ff; color: #3730a3; }
.xp-timer.is-low { background: #fef3c7; color: #92400e; }
.xp-timer.is-critical { background: #fee2e2; color: #b91c1c; animation: asg-pulse 1s ease-in-out infinite; }
.xp-pause { position: fixed; inset: 0; z-index: 2147482600; background: rgba(15,23,42,.92); display: flex; flex-direction: column; align-items: center; justify-content: center; gap: 10px; color: #fff; font-family: 'DM Sans',sans-serif; text-align: center; padding: 20px; }
.xp-pause i { font-size: 44px; }
.xp-pause h2 { margin: 0; font-size: 26px; font-weight: 800; }
.xp-toast { position: fixed; left: 50%; top: 70px; transform: translateX(-50%); z-index: 2147482700; background: #0f172a; color: #fff; font: 700 14px 'DM Sans',sans-serif; padding: 12px 18px; border-radius: 12px; box-shadow: 0 12px 30px -8px rgba(0,0,0,.45); display: flex; gap: 10px; align-items: center; max-width: min(92vw,560px); animation: xp-drop .3s ease-out; }
.xp-toast i { color: #fbbf24; }
@keyframes xp-drop { from { transform: translate(-50%,-14px); opacity: 0; } }
/* ── review ── */
.xp-review-grid { display: grid; grid-template-columns: repeat(auto-fill,minmax(64px,1fr)); gap: 8px; margin-bottom: 16px; }
.xp-review-item { border-radius: 10px; padding: 10px 4px; font: 800 12px 'DM Sans',sans-serif; border: 2px solid; cursor: pointer; background: #fff; }
.xp-review-item.is-done { border-color: #10b981; color: #047857; background: #ecfdf5; }
.xp-review-item.is-todo { border-color: #f59e0b; color: #92400e; background: #fffbeb; }
.xp-actions { display: flex; justify-content: flex-end; gap: 10px; flex-wrap: wrap; }
.xp-btn { font: 800 13px 'DM Sans',sans-serif; padding: 11px 18px; border-radius: 11px; border: 1px solid #e2e8f0; background: #fff; color: #334155; cursor: pointer; }
.xp-btn-primary { background: #4f46e5; border-color: #4f46e5; color: #fff; }
.xp-btn-primary:hover { background: #4338ca; }
.xp-jump-flash { animation: xp-flash 1.4s ease-out; }
@keyframes xp-flash { 0%,30% { box-shadow: 0 0 0 4px rgba(245,158,11,.6); } 100% { box-shadow: 0 0 0 0 rgba(245,158,11,0); } }
/* ── show your work ── */
.sw-zone { border: 2px dashed #c7d2fe; border-radius: 14px; padding: 16px; background: #fff; text-align: center; }
.sw-zone.is-over { border-color: #4f46e5; background: #eef2ff; }
.sw-thumbs { display: flex; flex-wrap: wrap; gap: 8px; margin-top: 12px; justify-content: center; }
.sw-thumb { position: relative; width: 84px; height: 84px; border-radius: 10px; overflow: hidden; border: 1px solid #e2e8f0; }
.sw-thumb img { width: 100%; height: 100%; object-fit: cover; }
.sw-thumb button { position: absolute; top: 3px; right: 3px; width: 20px; height: 20px; border-radius: 99px; border: 0; background: rgba(15,23,42,.75); color: #fff; font-size: 11px; cursor: pointer; }
.sw-status { font: 700 11.5px 'DM Sans',sans-serif; color: #64748b; margin-top: 8px; min-height: 16px; }
canvas.xp-confetti { position: fixed; inset: 0; pointer-events: none; z-index: 2147482800; }
`;

function injectCss() {
    if (document.getElementById('xp-css')) return;
    const s = document.createElement('style'); s.id = 'xp-css'; s.textContent = CSS; document.head.appendChild(s);
}

function modal(html, { className = '' } = {}) {
    injectCss();
    const back = document.createElement('div');
    back.className = `xp-back ${className}`;
    back.setAttribute('role', 'dialog');
    back.setAttribute('aria-modal', 'true');
    back.innerHTML = `<div class="xp-card">${html}</div>`;
    document.body.appendChild(back);
    return back;
}

// ── THEMES ───────────────────────────────────────────────────────────────
export function applyTheme(theme) {
    injectCss();
    const t = normalizeTheme(theme);
    document.body.classList.remove('theme-k5', 'theme-strict', 'theme-standard');
    document.body.classList.add(`theme-${t}`);
    return t;
}
export function clearTheme() { document.body.classList.remove('theme-k5', 'theme-strict', 'theme-standard'); }

const teamKey = (studentId) => `gt-k5-team:${studentId}`;
export function getTeam(studentId) {
    try { return K5_TEAMS.find((t) => t.id === localStorage.getItem(teamKey(studentId))) || null; } catch (e) { return null; }
}

/** K-5: team badge in `host`; first visit asks the student to pick a team. */
export function mountK5Team({ host, studentId }) {
    if (!host) return;
    const paint = (team) => {
        host.innerHTML = team
            ? `<button type="button" class="k5-team" style="background:${team.color}" title="Change team" data-k5-change><span>${team.emoji}</span>${esc(team.name)}</button>`
            : '';
    };
    const pick = () => {
        const m = modal(`<h2>Pick your team! 🎉</h2><p>Your team cheers you on while you work.</p>
            <div class="k5-grid">${K5_TEAMS.map((t) => `<button type="button" class="k5-pick" style="background:${t.color}" data-k5-team="${t.id}"><span>${t.emoji}</span>${esc(t.name)}</button>`).join('')}</div>`);
        m.addEventListener('click', (e) => {
            const b = e.target.closest('[data-k5-team]');
            if (!b) return;
            try { localStorage.setItem(teamKey(studentId), b.dataset.k5Team); } catch (err) { /* storage off */ }
            paint(getTeam(studentId) || K5_TEAMS.find((t) => t.id === b.dataset.k5Team));
            m.remove();
        });
        m.querySelector('[data-k5-team]')?.focus();
    };
    host.onclick = (e) => { if (e.target.closest('[data-k5-change]')) pick(); };
    const team = getTeam(studentId);
    paint(team);
    if (!team) pick();
}

export function celebrate({ emoji } = {}) {
    injectCss();
    const canvas = document.createElement('canvas');
    canvas.className = 'xp-confetti';
    canvas.width = innerWidth; canvas.height = innerHeight;
    document.body.appendChild(canvas);
    const ctx = canvas.getContext('2d');
    const colors = ['#f59e0b', '#ec4899', '#8b5cf6', '#0ea5e9', '#22c55e', '#ef4444'];
    const parts = Array.from({ length: 160 }, () => ({
        x: innerWidth / 2 + (Math.random() - 0.5) * 200, y: innerHeight / 3,
        vx: (Math.random() - 0.5) * 14, vy: -Math.random() * 14 - 4,
        s: 6 + Math.random() * 6, r: Math.random() * Math.PI, c: colors[(Math.random() * colors.length) | 0],
    }));
    const start = performance.now();
    (function frame(t) {
        ctx.clearRect(0, 0, canvas.width, canvas.height);
        parts.forEach((p) => {
            p.vy += 0.35; p.x += p.vx; p.y += p.vy; p.r += 0.1;
            ctx.save(); ctx.translate(p.x, p.y); ctx.rotate(p.r); ctx.fillStyle = p.c; ctx.fillRect(-p.s / 2, -p.s / 4, p.s, p.s / 2); ctx.restore();
        });
        if (emoji) { ctx.font = '64px serif'; ctx.textAlign = 'center'; ctx.fillText(emoji, innerWidth / 2, innerHeight / 2.4); }
        if (t - start < 2600) requestAnimationFrame(frame); else canvas.remove();
    })(start);
}

// ── STRICT MODE ──────────────────────────────────────────────────────────
/** Blocks copy/paste/right-click; reports tab switches. Returns stop(). */
export function startStrictGuard({ onViolation }) {
    injectCss();
    let warning = null;
    let lastAt = 0;
    const report = (type, severe) => {
        const now = Date.now();
        if (now - lastAt < 1500 && !severe) return; // blur + visibilitychange fire together
        lastAt = now;
        onViolation && onViolation(type);
        if (severe && !warning) {
            warning = modal(`<h2><i class="fa-solid fa-triangle-exclamation"></i> You left the assessment</h2>
                <p>Switching tabs or windows during this assessment is not allowed. This has been recorded and your teacher can see it.</p>
                <div class="xp-actions"><button type="button" class="xp-btn xp-btn-primary" data-xp-ack>I understand — return to my work</button></div>`, { className: 'xp-warn' });
            warning.querySelector('[data-xp-ack]').addEventListener('click', () => { warning.remove(); warning = null; });
        }
    };
    const block = (e) => {
        const type = violationFor(e.type);
        e.preventDefault();
        if (type) report(type, false);
    };
    const onVisibility = () => { const t = violationFor('visibilitychange', { visibilityState: document.visibilityState }); if (t) report(t, true); };
    const onBlur = () => { if (document.visibilityState === 'visible') report('window_blur', true); };
    ['copy', 'paste', 'cut', 'contextmenu'].forEach((t) => document.addEventListener(t, block, true));
    document.addEventListener('visibilitychange', onVisibility);
    window.addEventListener('blur', onBlur);
    return function stop() {
        ['copy', 'paste', 'cut', 'contextmenu'].forEach((t) => document.removeEventListener(t, block, true));
        document.removeEventListener('visibilitychange', onVisibility);
        window.removeEventListener('blur', onBlur);
        if (warning) { warning.remove(); warning = null; }
    };
}

// ── PRE-SUBMIT REVIEW ────────────────────────────────────────────────────
export function openReviewScreen({ summary, theme, onJump, onConfirm }) {
    const all = summary.unanswered.length === 0;
    const m = modal(`
        <h2>${theme === 'k5' ? 'Almost done! 🌟' : 'Review before you submit'}</h2>
        <p>${summary.answered} of ${summary.total} answered.${all ? ' Everything is answered.' : ` Not answered yet: ${summary.unanswered.join(', ')}.`} Click any box to go back to it.</p>
        <div class="xp-review-grid">${summary.items.map((i) => `<button type="button" class="xp-review-item ${i.answered ? 'is-done' : 'is-todo'}" data-xp-jump="${esc(i.key)}" title="${i.answered ? 'Answered' : 'Not answered'}">${esc(i.label)}<br>${i.answered ? '✓' : '—'}</button>`).join('')}</div>
        <div class="xp-actions">
            <button type="button" class="xp-btn" data-xp-back>Keep working</button>
            <button type="button" class="xp-btn xp-btn-primary" data-xp-confirm>Confirm submit</button>
        </div>`);
    m.addEventListener('click', (e) => {
        const j = e.target.closest('[data-xp-jump]');
        if (j) { m.remove(); onJump && onJump(j.dataset.xpJump); return; }
        if (e.target.closest('[data-xp-back]') || e.target === m) { m.remove(); return; }
        if (e.target.closest('[data-xp-confirm]')) { m.remove(); onConfirm && onConfirm(); }
    });
    m.querySelector('[data-xp-confirm]')?.focus();
    return m;
}

/** Scroll to and focus the answer for `key` inside root. */
export function jumpTo(root, key) {
    const target = key === 'work'
        ? root.querySelector('[data-sw-zone]')
        : root.querySelector(`[data-question-id="${window.CSS?.escape ? window.CSS.escape(key) : key}"]`);
    if (!target) return;
    const card = target.closest('.bg-white, .pdfw-page, .sw-zone') || target;
    card.scrollIntoView({ behavior: 'smooth', block: 'center' });
    card.classList.remove('xp-jump-flash'); void card.offsetWidth; card.classList.add('xp-jump-flash');
    setTimeout(() => target.focus?.({ preventScroll: true }), 350);
}

// ── SHOW YOUR WORK (compressed photo uploads) ────────────────────────────
export function showWorkHtml({ uploads = [], disabled = false, title = 'Show your work' }) {
    injectCss();
    return `
    <div>
        <p class="text-[11px] font-black text-slate-400 uppercase tracking-wider mb-1.5">${esc(title)}</p>
        <div class="sw-zone" data-sw-zone>
            <input type="hidden" data-question-id="work_uploads" value="${esc(JSON.stringify(uploads))}">
            ${disabled ? '' : `
            <label class="xp-btn" style="display:inline-flex;gap:8px;align-items:center;cursor:pointer">
                <i class="fa-solid fa-camera"></i> Add photos
                <input type="file" accept="image/*" multiple data-sw-input style="display:none">
            </label>
            <p class="sw-status" data-sw-status>Photos are shrunk to under 200 KB before upload.</p>`}
            <div class="sw-thumbs" data-sw-thumbs></div>
        </div>
    </div>`;
}

/** Wires the zone: compress → upload(blob) → URL list kept in the hidden input. */
export function wireShowWork({ root, upload, disabled = false }) {
    const zone = root.querySelector('[data-sw-zone]');
    if (!zone) return;
    const hidden = zone.querySelector('[data-question-id="work_uploads"]');
    const thumbs = zone.querySelector('[data-sw-thumbs]');
    const status = zone.querySelector('[data-sw-status]');
    const read = () => { try { const v = JSON.parse(hidden.value || '[]'); return Array.isArray(v) ? v : []; } catch (e) { return []; } };
    const write = (list) => { hidden.value = JSON.stringify(list.slice(0, 10)); hidden.dispatchEvent(new Event('input', { bubbles: true })); paint(); };
    function paint() {
        thumbs.innerHTML = read().map((u, i) => `<div class="sw-thumb"><a href="${esc(u.url)}" target="_blank" rel="noopener"><img src="${esc(u.url)}" alt="Uploaded work ${i + 1}"></a>${disabled ? '' : `<button type="button" data-sw-remove="${i}" aria-label="Remove photo ${i + 1}">×</button>`}</div>`).join('');
    }
    async function handle(files) {
        const list = read();
        for (const file of [...files].slice(0, 10 - list.length)) {
            try {
                if (status) status.textContent = `Shrinking ${file.name}…`;
                const blob = await compressImage(file);
                if (status) status.textContent = `Uploading ${file.name} (${Math.round(blob.size / 1024)} KB)…`;
                const url = await upload(blob);
                list.push({ url, name: String(file.name || 'photo').slice(0, 80), size: blob.size });
                write(list);
                if (status) status.textContent = 'Uploaded.';
            } catch (e) {
                if (status) status.textContent = e.message || 'Upload failed. Try again.';
            }
        }
    }
    zone.addEventListener('change', (e) => { if (e.target.matches('[data-sw-input]')) { handle(e.target.files); e.target.value = ''; } });
    zone.addEventListener('click', (e) => {
        const rm = e.target.closest('[data-sw-remove]');
        if (rm) { const l = read(); l.splice(Number(rm.dataset.swRemove), 1); write(l); }
    });
    if (!disabled) {
        zone.addEventListener('dragover', (e) => { e.preventDefault(); zone.classList.add('is-over'); });
        zone.addEventListener('dragleave', () => zone.classList.remove('is-over'));
        zone.addEventListener('drop', (e) => { e.preventDefault(); zone.classList.remove('is-over'); handle(e.dataTransfer.files); });
    }
    root.addEventListener('draft:applied', paint);
    paint();
}

export function readShowWork(root) {
    const hidden = root.querySelector('[data-question-id="work_uploads"]');
    try { const v = JSON.parse(hidden?.value || '[]'); return Array.isArray(v) ? v : []; } catch (e) { return []; }
}

// ── LIVE CLIENT (RTDB command center) ────────────────────────────────────
// assessmentLive/{schoolId}/{assignmentId}/
//   control                   teacher: paused, extraMinutes, collectAt, broadcast
//   presence/{studentId}      student: online while the page is open (onDisconnect)
//   starts/{studentId}        student: first open time (timed assessments)
//   violations/{studentId}/…  student: append-only integrity log
export function startLiveClient({ schoolId, assignment, studentId, studentName, timerHost, onCollect }) {
    injectCss();
    const base = `assessmentLive/${schoolId}/${assignment.id}`;
    const presenceRef = ref(rtdb, `${base}/presence/${studentId}`);
    const unsubs = [];
    let control = normalizeControl(null);
    let startedAt = null;
    let pauseEl = null;
    let lastBroadcast = null;
    let collected = false;
    let tick = null;
    const openedAt = Date.now();

    const collect = (reason) => { if (collected) return; collected = true; onCollect && onCollect(reason); };

    unsubs.push(onValue(ref(rtdb, '.info/connected'), (snap) => {
        if (snap.val() !== true) return;
        onDisconnect(presenceRef).remove()
            .then(() => set(presenceRef, { name: String(studentName || '').slice(0, 120), state: 'active', at: serverTimestamp() }))
            .catch((e) => console.warn('[Live] presence:', e));
    }));

    const timed = Number(assignment.timeLimitMin) > 0;
    if (timed) {
        runTransaction(ref(rtdb, `${base}/starts/${studentId}`), (cur) => (cur == null ? Date.now() : undefined))
            .then((r) => { startedAt = Number(r.snapshot.val()) || Date.now(); })
            .catch(() => { startedAt = Date.now(); });
    }

    function paintTimer() {
        if (!timerHost || !timed) return;
        const ms = startedAt ? remainingMs({ timeLimitMin: Number(assignment.timeLimitMin), extraMinutes: control.extraMinutes, startedAt }) : null;
        if (ms == null) { timerHost.innerHTML = ''; return; }
        timerHost.innerHTML = `<span class="xp-timer ${ms < 60000 ? 'is-critical' : ms < 300000 ? 'is-low' : ''}" role="timer" aria-live="off"><i class="fa-regular fa-clock"></i> ${formatClock(ms)}</span>`;
        if (ms === 0 && !control.paused) collect('time');
    }
    if (timed) { tick = setInterval(paintTimer, 1000); paintTimer(); }

    unsubs.push(onValue(ref(rtdb, `${base}/control`), (snap) => {
        control = normalizeControl(snap.val());
        if (control.paused && !pauseEl) {
            pauseEl = document.createElement('div');
            pauseEl.className = 'xp-pause';
            pauseEl.innerHTML = '<i class="fa-solid fa-circle-pause"></i><h2>Paused by your teacher</h2><p>Hands off for now — your answers are saved.</p>';
            document.body.appendChild(pauseEl);
            document.activeElement?.blur?.();
        } else if (!control.paused && pauseEl) { pauseEl.remove(); pauseEl = null; }
        if (control.broadcast && control.broadcast.id !== lastBroadcast) {
            const fresh = lastBroadcast !== null || control.broadcast.at > openedAt - 120000;
            lastBroadcast = control.broadcast.id;
            if (fresh) toast(control.broadcast.text);
        } else if (lastBroadcast === null) lastBroadcast = control.broadcast?.id || '';
        if (control.collectAt) collect('teacher');
        paintTimer();
    }, (e) => console.warn('[Live] control:', e)));

    return {
        logViolation(type) {
            push(ref(rtdb, `${base}/violations/${studentId}`), { type, at: serverTimestamp() }).catch((e) => console.warn('[Live] violation:', e));
            update(presenceRef, { state: type === 'tab_switch' ? 'away' : 'active', lastViolation: type }).catch(() => {});
        },
        setState(state) { update(presenceRef, { state }).catch(() => {}); },
        stop() {
            unsubs.forEach((u) => u());
            clearInterval(tick);
            if (pauseEl) { pauseEl.remove(); pauseEl = null; }
            if (timerHost) timerHost.innerHTML = '';
            onDisconnect(presenceRef).cancel().catch(() => {});
            remove(presenceRef).catch(() => {});
        },
    };
}

export function toast(text) {
    injectCss();
    const t = document.createElement('div');
    t.className = 'xp-toast';
    t.setAttribute('role', 'status');
    t.innerHTML = `<i class="fa-solid fa-bullhorn"></i><span>${esc(text)}</span>`;
    document.body.appendChild(t);
    setTimeout(() => t.remove(), 8000);
}
