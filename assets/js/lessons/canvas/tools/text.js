// assets/js/lessons/canvas/tools/text.js — inline rich-text editing (Tiptap 2)
//
// A text object is static HTML (props.html) until it is double-clicked. Then
// ONE Tiptap/ProseMirror editor is mounted inside that object. There is no
// floating toolbar: formatting lives in the editor's fixed Format toolbar
// (canvas/toolbar.js), which drives this tool through:
//   tool.getEditor()                 live editor (chain().focus()… while editing)
//   tool.formatObjects(ids, fn)      format SELECTED (not editing) boxes: whole text, one undo step
//   tool.state(id)                   current marks/attrs (live editor or the box's HTML)
//   tool.computedStyle(id)           rendered font size / family / colour fallbacks
// On blur (click elsewhere / Esc / slide switch) the editor is destroyed and the
// object goes back to its static render. Presses inside `isUiTarget(el)` (the
// toolbar, menus, colour popovers) do not count as blur.
//
// History: the whole edit session is ONE undoable store command
// ({ html, h }), dispatched on blur. flush() (autosave / unmount) writes the
// current state early under the same coalesce key, so it still undoes as
// one step. While editing, Ctrl+Z / Ctrl+Y are Tiptap's own history.
//
// Auto-grow: while typing, the box grows (never below its starting height)
// to fit its content; the new height is part of the same command.
//
// Stored HTML stays plain, portable markup (<p>, <h1-3>, <ul>/<ol>, <strong>,
// <em>, <u>, <s>, <a>, <span style="color|font-family|font-size">,
// <mark style="background-color">, style="text-align|line-height", class="ql-indent-N",
// <pre>, <blockquote>, <hr>) — the viewer
// and live presenter render it unchanged. Quill-era HTML (ql-align-* classes,
// background-color spans) is parsed on the way in.
//
//   const tool = createTextTool({ handle, store, engine, onDirty, onChange, onEditorChange, isUiTarget });
//   await tool.begin(id, { x, y });   tool.end();   tool.flush();   tool.destroy();

import { applyObjectGeometry } from '../renderer.js';
import { sharedTextExtensions } from './text-formats.js';

const TIPTAP_URL = new URL('../../../../vendor/tiptap-2.27.3.esm.min.js', import.meta.url).href;

let libPromise = null;
let libLoaded = null;
export function loadTextLibs() {
    if (!libPromise) {
        libPromise = import(TIPTAP_URL)
            .then((tiptap) => { libLoaded = { tiptap }; return libLoaded; })
            .catch((e) => { libPromise = null; throw e; });
    }
    return libPromise;
}

export const FONT_FAMILIES = Object.freeze([
    ['', 'Default'], ['DM Sans', 'DM Sans'], ['Arial', 'Arial'], ['Georgia', 'Georgia'],
    ['Times New Roman', 'Times New Roman'], ['Trebuchet MS', 'Trebuchet MS'], ['Verdana', 'Verdana'],
    ['Courier New', 'Courier New'], ['Comic Sans MS', 'Comic Sans MS'],
]);
export const FONT_SIZES = Object.freeze(['10px', '12px', '14px', '16px', '18px', '20px', '24px', '28px', '32px', '40px', '48px', '64px', '80px']);
export const LINE_HEIGHTS = Object.freeze([['1', 'Single'], ['1.15', '1.15'], ['1.5', '1.5'], ['2', 'Double']]);

const esc = (v) => String(v ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#039;' }[c]));

export function isBlankHtml(html) {
    if (!html) return true;
    if (/<(img|iframe|video)/i.test(html)) return false;
    return !html.replace(/<[^>]*>/g, '').replace(/&nbsp;|​/g, ' ').trim();
}

// ── Tiptap extensions (built once per library load) ──────────────────────
let extCache = null;
function buildExtensions(T) {
    if (extCache) return extCache;
    // Quill-era alignment classes → textAlign (registered after TextAlign, so it wins the parse).
    const QuillAlign = T.Extension.create({
        name: 'quillAlign',
        addGlobalAttributes() {
            return [{
                types: ['heading', 'paragraph'],
                attributes: {
                    textAlign: {
                        default: null,
                        parseHTML: (el) => el.style.textAlign || (/\bql-align-(center|right|justify)\b/.exec(el.className || '') || [])[1] || null,
                        renderHTML: (a) => (a.textAlign && a.textAlign !== 'left' ? { style: `text-align: ${a.textAlign}` } : {}),
                    },
                },
            }];
        },
    });
    // Quill wrote highlights as <span style="background-color">; Tiptap uses <mark>.
    const Highlight = T.Highlight.extend({
        parseHTML() {
            return [
                { tag: 'mark' },
                { tag: 'span', consuming: false, getAttrs: (el) => (el.style && el.style.backgroundColor ? {} : false) },
            ];
        },
    }).configure({ multicolor: true });
    extCache = [
        // same block set as Documents (document.js): <pre>, <blockquote>, <hr> are kept
        T.StarterKit.configure({ heading: { levels: [1, 2, 3] }, code: false }),
        T.Underline,
        T.TextStyle,
        T.Color,
        Highlight,
        ...sharedTextExtensions(T), // font family / size, line spacing, indent, Quill classes (same as Documents)
        T.TextAlign.configure({ types: ['heading', 'paragraph'], alignments: ['left', 'center', 'right', 'justify'] }),
        QuillAlign,
        T.Link.configure({ openOnClick: false, autolink: true, HTMLAttributes: { rel: 'noopener noreferrer', target: '_blank' } }),
    ];
    return extCache;
}

// ── formatting state (read by the Format toolbar) ────────────────────────
const ALIGNS = ['left', 'center', 'right', 'justify'];
export function readEditorState(editor) {
    const ts = editor.getAttributes('textStyle') || {};
    const block = editor.isActive('heading', { level: 1 }) ? '1' : editor.isActive('heading', { level: 2 }) ? '2' : editor.isActive('heading', { level: 3 }) ? '3' : 'p';
    const para = editor.getAttributes(block === 'p' ? 'paragraph' : 'heading') || {};
    return {
        bold: editor.isActive('bold'),
        italic: editor.isActive('italic'),
        underline: editor.isActive('underline'),
        strike: editor.isActive('strike'),
        bullet: editor.isActive('bulletList'),
        ordered: editor.isActive('orderedList'),
        link: editor.isActive('link'),
        align: ALIGNS.find((a) => a !== 'left' && editor.isActive({ textAlign: a })) || 'left',
        lineHeight: para.lineHeight || '',
        block,
        fontFamily: ts.fontFamily || '',
        fontSize: ts.fontSize || '',
        color: ts.color || '',
        highlight: (editor.getAttributes('highlight') || {}).color || '',
    };
}

// Detached editor over some HTML with everything selected (state / whole-box formatting).
function headlessEditor(lib, html) {
    const T = lib.tiptap;
    const el = document.createElement('div');
    const editor = new T.Editor({ element: el, extensions: buildExtensions(T), content: html || '' });
    editor.commands.selectAll();
    return editor;
}

const stateCache = new Map(); // html → state (whole-box selection)
function htmlState(html) {
    if (!libLoaded) return null;
    const key = html || '';
    if (stateCache.has(key)) return stateCache.get(key);
    const ed = headlessEditor(libLoaded, key);
    const st = readEditorState(ed);
    ed.destroy();
    if (stateCache.size > 200) stateCache.clear();
    stateCache.set(key, st);
    return st;
}

const TB_CSS = `
.cv-pm { outline: none; }
.cv-pm p.is-editor-empty:first-child::before, .cv-pm h1.is-editor-empty:first-child::before, .cv-pm h2.is-editor-empty:first-child::before, .cv-pm h3.is-editor-empty:first-child::before {
  content: attr(data-placeholder); color: #94a3b8; float: left; height: 0; pointer-events: none; font-style: normal; }
.cv-obj.cv-editing .cv-obj-content { overflow: visible !important; }
.cv-ed-wrap.cv-ed-editing { height: auto !important; overflow: visible !important; }
.cv-ed-wrap.cv-ed-editing .ql-editor { height: auto; overflow: visible; }
`;
function ensureStyles() {
    if (document.getElementById('cv-tt-styles')) return;
    const st = document.createElement('style');
    st.id = 'cv-tt-styles';
    st.textContent = TB_CSS;
    document.head.appendChild(st);
}

// ── tool ─────────────────────────────────────────────────────────────────
export function createTextTool({ handle, store, engine, onDirty = null, onChange = null, onEditorChange = null, isUiTarget = null }) {
    ensureStyles();
    let session = null;      // { id, slideId, editor, node, startH, liveH, key }
    let pending = 0;         // begin() token: a newer begin/end cancels an in-flight library load
    let seq = 0;
    let raf = 0;

    const notify = () => { try { onChange && onChange(session ? session.id : null); } catch (e) { console.error(e); } };
    // editor selection / marks changed → toolbar re-sync (once per frame)
    const editorChanged = () => {
        if (!onEditorChange || raf) return;
        raf = requestAnimationFrame(() => { raf = 0; try { onEditorChange(); } catch (e) { console.error(e); } });
    };

    function currentHtml(s) {
        const html = s.editor.getHTML();
        return isBlankHtml(html) ? '' : html;
    }

    function grow(s) {
        const wrap = s.node.content.querySelector('.cv-ed-wrap');
        const obj = store.getObject(s.id, s.slideId);
        if (!wrap || !obj) return;
        const cs = obj.props && obj.props.contentScale > 0 ? obj.props.contentScale : 1;
        const needed = Math.ceil(wrap.offsetHeight * cs);
        const h = Math.max(s.startH, needed);
        if (Math.abs(h - s.liveH) < 0.5) return;
        s.liveH = h;
        applyObjectGeometry(s.node, obj, { x: obj.x, y: obj.y, w: obj.w, h, rotation: obj.rotation || 0 });
        engine && engine.updateRect && engine.updateRect();
    }

    // Write html + height to the store (one undo step per edit session).
    function commit(s, label = 'Edit text') {
        const obj = store.getObject(s.id, s.slideId);
        if (!obj) return false;
        const html = currentHtml(s);
        const h = Math.round(s.liveH * 100) / 100;
        if (html === (obj.props.html || '') && h === obj.h) return false;
        return store.dispatch({
            label, slideId: s.slideId,
            before: { [s.id]: obj },
            after: { [s.id]: { ...obj, h, props: { ...obj.props, html } } },
            coalesceKey: s.key, coalesceMs: Infinity,
        });
    }

    async function begin(id, { x, y } = {}) {
        const obj = store.getObject(id);
        if (!obj || obj.type !== 'text' || obj.locked) return false;
        if (session && session.id === id) return true;
        end();
        const token = ++pending;
        let lib;
        try { lib = await loadTextLibs(); } catch (e) { console.error('[text tool] editor failed to load:', e); return false; }
        if (token !== pending) return false; // superseded while loading
        const node = handle.nodes.get(id);
        const fresh = store.getObject(id);
        if (!node || !fresh) return false;

        const p = fresh.props || {};
        store.setSelection([id], { exact: true }); // edit this box even when it is grouped
        engine && engine.setEditing(id);
        node.el.classList.add('cv-editing');
        const cs = p.contentScale > 0 ? p.contentScale : 1;
        // min-height = the box's starting height, so the box can grow and shrink back
        node.content.innerHTML = `<div class="cv-ed-wrap ql-snow cv-ed-editing" data-role="${esc(p.role || '')}" style="min-height:${fresh.h / cs}px"><div class="cv-tt-host"></div></div>`;

        const startHtml = isBlankHtml(p.html) ? '' : p.html;
        const primed = !startHtml && (p.role === 'title' || p.role === 'heading') ? `<h${p.role === 'title' ? 1 : 2}></h${p.role === 'title' ? 1 : 2}>` : startHtml;
        const T = lib.tiptap;
        const s = { id, slideId: store.getState().activeSlideId, node, startH: fresh.h, liveH: fresh.h, key: `text-edit:${id}:${++seq}`, editor: null };
        s.editor = new T.Editor({
            element: node.content.querySelector('.cv-tt-host'),
            extensions: [...buildExtensions(T), T.Placeholder.configure({ placeholder: p.placeholder || 'Type something…' })],
            content: primed,
            editorProps: { attributes: { class: 'ql-editor cv-pm', spellcheck: 'true' } },
            onUpdate: () => { grow(s); onDirty && onDirty(); },
            onTransaction: editorChanged, // selection, stored marks, content
        });
        session = s;

        // caret where the teacher double-clicked
        let pos = null;
        if (typeof x === 'number' && typeof y === 'number') {
            const hit = s.editor.view.posAtCoords({ left: x, top: y });
            if (hit) pos = hit.pos;
        }
        s.editor.commands.focus(pos == null ? 'end' : pos);
        requestAnimationFrame(() => session === s && grow(s));
        document.addEventListener('pointerdown', onOutside, true);
        notify();
        editorChanged();
        return true;
    }

    // "Blur": any press outside the box and the editor UI ends the edit.
    function onOutside(e) {
        if (!session) return;
        const t = e.target;
        if (session.node.el.contains(t)) return;
        if (isUiTarget && t instanceof Element && isUiTarget(t)) return;
        end();
    }

    function end({ commit: doCommit = true } = {}) {
        pending++; // cancel any begin() still loading
        const s = session;
        if (!s) return false;
        session = null;
        document.removeEventListener('pointerdown', onOutside, true);
        let changed = false;
        if (doCommit) changed = commit(s);
        try { s.editor.destroy(); } catch (e) { /* gone */ }
        s.node.el.classList.remove('cv-editing');
        s.node.print = null; // static render rebuilds from props on the next paint
        engine && engine.setEditing(null);
        notify();
        editorChanged();
        return changed;
    }

    // Push the in-progress edit to the store without leaving edit mode.
    function flush() {
        if (!session) return false;
        return commit(session);
    }

    // Whole-box formatting for SELECTED (not editing) text objects: fn(chain)
    // runs on a detached editor (everything selected) per box, and every changed
    // box is written in ONE store command (one undo step for the selection).
    // A box being edited gets the live chain instead.
    async function formatObjects(ids, fn, { label = 'Format text', coalesceKey = null } = {}) {
        const list = [...new Set(ids || [])];
        if (session && list.length === 1 && session.id === list[0]) {
            fn(session.editor.chain().focus()).run();
            return true;
        }
        const slideId = store.getState().activeSlideId;
        let lib;
        try { lib = await loadTextLibs(); } catch (e) { console.error('[text tool] editor failed to load:', e); return false; }
        const updates = [];
        list.forEach((id) => {
            const o = store.getObject(id, slideId);
            if (!o || o.type !== 'text' || o.locked) return;
            const ed = headlessEditor(lib, isBlankHtml(o.props.html) ? '' : o.props.html);
            fn(ed.chain()).run();
            const out = ed.getHTML();
            ed.destroy();
            const html = isBlankHtml(out) ? '' : out;
            if (html !== (o.props.html || '')) updates.push({ id, props: { html } });
        });
        if (!updates.length) return false;
        const key = coalesceKey || `fmt:${list.join(',')}:${Date.now()}`;
        const ok = store.commands.updateObjects(slideId, updates, { label, coalesceKey: key });
        // bigger type can overflow a box: grow it inside the same undo step
        requestAnimationFrame(() => updates.forEach((u) => fitHeight(u.id, slideId, key)));
        return ok;
    }
    const formatObject = (id, fn, opts) => formatObjects([id], fn, opts);

    function fitHeight(id, slideId, key) {
        const node = handle.nodes.get(id);
        const obj = store.getObject(id, slideId);
        if (!node || !obj || (session && session.id === id)) return;
        const ed = node.content.querySelector('.ql-editor');
        if (!ed) return;
        const cs = obj.props && obj.props.contentScale > 0 ? obj.props.contentScale : 1;
        const wrap = node.content.firstElementChild;
        const pad = wrap ? wrap.offsetHeight - wrap.clientHeight + (parseFloat(getComputedStyle(wrap).paddingTop) || 0) + (parseFloat(getComputedStyle(wrap).paddingBottom) || 0) : 0;
        const needed = Math.ceil((ed.scrollHeight + pad) * cs);
        if (needed > obj.h + 2) {
            store.dispatch({ label: 'Format text', slideId, before: { [id]: obj }, after: { [id]: { ...obj, h: needed } }, coalesceKey: key });
        }
    }

    // Formatting state for the toolbar: the live editor's selection while
    // editing `id`, otherwise the whole box (null until the editor bundle loads).
    function state(id) {
        if (session && session.id === id) return readEditorState(session.editor);
        const obj = store.getObject(id);
        if (!obj || obj.type !== 'text') return null;
        if (!libLoaded) { loadTextLibs().then(() => editorChanged()).catch(() => {}); return null; }
        return htmlState(isBlankHtml(obj.props && obj.props.html) ? '' : obj.props.html);
    }

    // Rendered (inherited) text style where no explicit mark is set.
    function computedStyle(id) {
        let el = null;
        if (session && session.id === id) {
            try {
                const at = session.editor.view.domAtPos(session.editor.state.selection.from);
                el = at.node.nodeType === 1 ? at.node : at.node.parentElement;
            } catch (e) { el = null; }
        }
        if (!el) {
            const node = handle.nodes.get(id);
            const ed = node && node.content.querySelector('.ql-editor');
            el = ed && (ed.querySelector('h1,h2,h3,p,li,span,strong,em') || ed);
        }
        if (!el) return null;
        const cs = getComputedStyle(el);
        return { fontSize: parseFloat(cs.fontSize) || null, fontFamily: cs.fontFamily || '', color: cs.color || '' };
    }

    return {
        begin, end, flush, formatObject, formatObjects, state, computedStyle,
        getEditor: () => (session ? session.editor : null),
        editingId: () => (session ? session.id : null),
        isEditing: () => !!session,
        destroy() { end(); if (raf) cancelAnimationFrame(raf); raf = 0; },
    };
}
