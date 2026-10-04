// assets/js/lessons/live-fullscreen.js — the full-screen ("expand") control
// shared by the teacher's live presenter (lessons/live.js) and the student
// live viewer (lessons/viewer.js).
//
//   setupLiveFullscreen({ target, buttonHost, stage, label })
//     target      element that goes full screen (everything the class should see)
//     buttonHost  element the Expand button is appended to
//     stage       element holding the slide canvas: in full screen it becomes
//                 a size container and the 16:9 stage is fitted to BOTH its
//                 width and height (letterboxed), so nothing is cut off
//
// Expand → the area fills the whole window at once, and real browser full
// screen (Fullscreen API) is requested on top where the browser allows it.
// Exit: the same button (now "Exit full screen" — the host sits inside the
// full-screen area so it stays visible), Esc, or F. F toggles from anywhere
// outside a text field.

const CSS = `
.lfs-btn { display: inline-flex; align-items: center; justify-content: center; gap: 6px; height: 34px; padding: 0 12px; border-radius: 9px; font-size: 12px; font-weight: 800; cursor: pointer; border: 1px solid transparent; transition: background .15s, color .15s; white-space: nowrap; }
.lfs-btn i { font-size: 13px; }
.lfs-btn.lfs-dark { background: rgba(255,255,255,.12); color: #fff; }
.lfs-btn.lfs-dark:hover { background: rgba(255,255,255,.22); }
.lfs-btn.lfs-light { background: #fff; color: #334155; border-color: #e2e8f0; }
.lfs-btn.lfs-light:hover { background: #f1f5f9; color: #0f172a; }
.lfs-btn:focus-visible { outline: 2px solid #6366f1; outline-offset: 2px; }
.lfs-on { width: 100vw !important; height: 100vh !important; max-width: none !important; margin: 0 !important; overflow: hidden !important; display: flex !important; flex-direction: column !important; background: #0f172a; box-sizing: border-box; }
.lfs-on.lfs-pad { padding: 14px 18px; gap: 12px; }
.lfs-on.lfs-pad #presentCanvas { margin: 0 !important; }
.lfs-on.lfs-fallback { position: fixed !important; inset: 0 !important; z-index: 2147482000 !important; }
.lfs-on [data-lfs-stage] { flex: 1 1 auto !important; min-height: 0 !important; height: auto !important; container-type: size; display: flex !important; flex-direction: column !important; align-items: center !important; justify-content: center !important; }
.lfs-on [data-lfs-stage] > * { width: 100% !important; flex: 0 0 auto; }
.lfs-on [data-lfs-stage] .cv-viewport { width: min(100cqw, calc(100cqh * 16 / 9)) !important; max-width: none !important; }
.lfs-on [data-lfs-grow] { flex: 1 1 auto !important; min-height: 0 !important; display: flex !important; flex-direction: column !important; }
.lfs-on [data-lfs-hide] { display: none !important; }
`;

function injectCss() {
    if (document.getElementById('lfs-css')) return;
    const s = document.createElement('style');
    s.id = 'lfs-css';
    s.textContent = CSS;
    document.head.appendChild(s);
}

function isTyping(el) {
    return !!(el && (el.isContentEditable || /^(INPUT|TEXTAREA|SELECT)$/.test(el.tagName)));
}

export function setupLiveFullscreen({ target, buttonHost, stage, tone = 'light', pad = false }) {
    if (!target || !buttonHost) return null;
    injectCss();
    if (stage) stage.setAttribute('data-lfs-stage', '');
    if (pad) target.classList.add('lfs-pad');

    const btn = document.createElement('button');
    btn.type = 'button';
    btn.className = `lfs-btn lfs-${tone}`;
    buttonHost.appendChild(btn);

    // `active` is the source of truth: the full-window layout is applied the
    // moment Expand is pressed, and real browser full screen is requested on
    // top of it. Some hosts (embedded browsers, kiosk shells) neither grant nor
    // reject requestFullscreen(), so the layout must never wait on it.
    let active = false;
    let hadNative = false;
    const nativeOn = () => document.fullscreenElement === target;
    const isOn = () => active;

    function paint() {
        const on = active;
        target.classList.toggle('lfs-on', on);
        target.classList.toggle('lfs-fallback', on && !nativeOn());
        btn.innerHTML = on
            ? '<i class="fa-solid fa-compress"></i><span>Exit full screen</span>'
            : '<i class="fa-solid fa-expand"></i><span>Full screen</span>';
        btn.title = on ? 'Exit full screen (Esc)' : 'Full screen (F)';
        btn.setAttribute('aria-pressed', String(on));
        document.body.style.overflow = on && !nativeOn() ? 'hidden' : '';
        // let the canvas re-fit to its new box
        window.dispatchEvent(new Event('resize'));
    }

    function enter() {
        if (active) return;
        active = true;
        paint();
        if (document.fullscreenEnabled && target.requestFullscreen && !document.fullscreenElement) {
            try {
                const p = target.requestFullscreen({ navigationUI: 'hide' });
                if (p && p.catch) p.catch(() => { /* full-window layout already applied */ });
            } catch (e) { /* full-window layout already applied */ }
        }
    }

    function exit() {
        if (!active) return;
        active = false;
        paint();
        if (nativeOn()) document.exitFullscreen().catch(() => {});
    }

    const toggle = () => (active ? exit() : enter());

    btn.addEventListener('click', toggle);
    const onFsChange = () => {
        if (nativeOn()) hadNative = true;
        else if (hadNative) { hadNative = false; active = false; } // browser Esc / system exit
        paint();
    };
    document.addEventListener('fullscreenchange', onFsChange);
    const onKey = (e) => {
        if (e.defaultPrevented || e.ctrlKey || e.metaKey || e.altKey) return;
        if (e.key === 'Escape' && active && !nativeOn()) { e.preventDefault(); exit(); return; }
        if ((e.key === 'f' || e.key === 'F') && !isTyping(e.target) && !document.querySelector('dialog[open], .lact-modal-back')) {
            e.preventDefault();
            toggle();
        }
    };
    document.addEventListener('keydown', onKey);

    paint();
    return {
        enter, exit, toggle, isOn,
        // hide (and leave full screen) when there's nothing live to follow
        setAvailable(on) {
            btn.hidden = !on;
            btn.style.display = on ? '' : 'none';
            if (!on && active) exit();
        },
        destroy() {
            document.removeEventListener('fullscreenchange', onFsChange);
            document.removeEventListener('keydown', onKey);
            btn.remove();
            target.classList.remove('lfs-on', 'lfs-fallback');
        },
    };
}
