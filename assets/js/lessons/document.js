// assets/js/lessons/document.js — Document-format lesson editor (Tiptap 2)
//
// One vertical-flow Tiptap editor on the US Letter page (#docEditor.doc-page),
// replacing Quill 1.3.7. Blocks: paragraphs, headings (H1–H3), lists, links,
// colour / highlight, alignment, indent, images (Storage), videos, dividers,
// the Linked Assignment card and student activities (poll / quiz / open
// response) as uneditable block cards with a setup modal.
// Formatting runs through the shared Format toolbar (canvas/toolbar.js) and
// the menu bar in builder.js — this module has no toolbar of its own.
// createDocumentViewer() mounts the SAME schema read-only for students
// (viewer.js), so a document renders identically on both sides.
//
// Saved HTML keeps Quill 1.3.7's shapes (older lessons were written by Quill
// and every reader parses them back to the same document):
//   alignment   class="ql-align-center|right|justify"   (not style="text-align")
//   indent      class="ql-indent-N"                     (not nested lists)
//   lists       <ul|ol><li>text</li>                     (no <p> inside <li>)
//   highlight   <span style="background-color:…">       (not <mark>)
//   empty line  <p><br></p>
//   image       <p><img src alt width></p>               (inline, like Quill's embed)
//   video       <iframe class="ql-video" frameborder="0" allowfullscreen="true" src>
//   assignment  <span class="assignment-embed" data-assignment-id data-assignment-title>…</span>
//   divider     <hr>
//   activity    <div class="lesson-widget" data-widget-id data-widget-type data-config>
//   font / size <span style="font-family|font-size">          line spacing  style="line-height"
// Quill-era class spans (ql-font-*, ql-size-*) are kept as-is.
//
//   const ed = await createDocumentEditor({ element, html, ...hooks });
//   ed.getHTML(); ed.setHTML(html); ed.insertVideo(url); ed.insertWidget('quiz'); ed.destroy();

import { createWidget, newOption, widgetMarkup, WIDGET_META, WIDGET_CSS } from './canvas/tools/interactive.js';
import { sharedTextExtensions } from './canvas/tools/text-formats.js';

const TIPTAP_URL = new URL('../../vendor/tiptap-2.27.3.esm.min.js', import.meta.url).href;
let libPromise = null;
function loadTiptap() {
    if (!libPromise) libPromise = import(TIPTAP_URL).catch((e) => { libPromise = null; throw e; });
    return libPromise;
}

const esc = (v) => String(v ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#039;' }[c]));
const ALIGNS = ['center', 'right', 'justify'];

// ── HTML in / out (Quill shapes) ─────────────────────────────────────────
function fromQuillHtml(html) {
    const t = document.createElement('template');
    t.innerHTML = html || '';
    // Quill's empty line is <p><br></p>; Tiptap's is <p></p>
    t.content.querySelectorAll('p, h1, h2, h3, li').forEach((el) => {
        if (el.childNodes.length === 1 && el.firstChild.nodeName === 'BR') el.innerHTML = '';
    });
    return t.innerHTML;
}

export function toQuillHtml(html) {
    const t = document.createElement('template');
    t.innerHTML = html || '';
    const root = t.content;
    // text-align style → ql-align class
    root.querySelectorAll('[style*="text-align"]').forEach((el) => {
        const a = (el.style.textAlign || '').toLowerCase();
        el.style.removeProperty('text-align');
        if (!el.getAttribute('style')) el.removeAttribute('style');
        if (ALIGNS.includes(a)) el.classList.add(`ql-align-${a}`);
    });
    // <li><p>…</p></li> → <li>…</li> (paragraph classes move to the li)
    root.querySelectorAll('li').forEach((li) => {
        const ps = [...li.children].filter((c) => c.tagName === 'P');
        if (!ps.length) return;
        ps.forEach((p) => {
            p.classList.forEach((c) => li.classList.add(c));
            for (const prop of p.style) li.style.setProperty(prop, p.style.getPropertyValue(prop)); // e.g. line-height
        });
        const parts = ps.map((p) => p.innerHTML);
        ps.forEach((p, i) => { if (i) p.remove(); });
        ps[0].outerHTML = parts.join('<br>');
    });
    // nested lists (pasted) → flat items with ql-indent
    root.querySelectorAll('li > ul, li > ol').forEach((inner) => {
        const li = inner.parentElement;
        const depth = (Number((/ql-indent-(\d)/.exec(li.className) || [])[1]) || 0) + 1;
        [...inner.children].reverse().forEach((child) => {
            child.classList.add(`ql-indent-${Math.min(8, depth)}`);
            li.after(child);
        });
        inner.remove();
    });
    // <mark> → background-color span
    root.querySelectorAll('mark').forEach((m) => {
        const span = document.createElement('span');
        span.style.backgroundColor = m.style.backgroundColor || m.getAttribute('data-color') || '#fff59d';
        span.innerHTML = m.innerHTML;
        m.replaceWith(span);
    });
    // bare <span> (an empty text style) → its contents
    root.querySelectorAll('span:not([class]):not([style])').forEach((sp) => {
        if (!sp.attributes.length && !sp.closest('.assignment-embed')) sp.replaceWith(...sp.childNodes);
    });
    // block embeds can't live inside a Quill list item: move them after the list
    root.querySelectorAll('li hr, li iframe, li > div').forEach((blk) => {
        const list = blk.closest('ul, ol');
        if (list) list.after(blk);
    });
    // <pre><code>…</code></pre> → <pre>…</pre>
    root.querySelectorAll('pre > code:only-child').forEach((code) => { code.parentElement.textContent = code.textContent; });
    // <blockquote><p>a</p><p>b</p></blockquote> → one Quill blockquote line per paragraph
    root.querySelectorAll('blockquote').forEach((bq) => {
        const ps = [...bq.children];
        if (!ps.length || ps.some((c) => c.tagName !== 'P')) return;
        const lines = ps.map((p) => {
            const q = document.createElement('blockquote');
            p.classList.forEach((c) => q.classList.add(c));
            if (p.getAttribute('style')) q.setAttribute('style', p.getAttribute('style'));
            q.innerHTML = p.innerHTML;
            return q;
        });
        bq.replaceWith(...lines);
    });
    // block-level image (from a paste) → inside a paragraph, like Quill's inline embed
    [...root.children].filter((el) => el.tagName === 'IMG').forEach((img) => {
        const p = document.createElement('p');
        img.replaceWith(p);
        p.appendChild(img);
    });
    // Tiptap's empty line → Quill's
    root.querySelectorAll('p, h1, h2, h3, li, blockquote').forEach((el) => {
        if (!el.innerHTML.trim()) el.innerHTML = '<br>';
    });
    return t.innerHTML;
}

// ── extensions ───────────────────────────────────────────────────────────
// viewer: null (teacher editor) | { renderAssignment, assignViews, lazy } (createDocumentViewer)
function buildExtensions(T, { viewer = null } = {}) {
    // Quill alignment classes ⇄ textAlign (indent, font size, line spacing: text-formats.js)
    const QuillBlockAttrs = T.Extension.create({
        name: 'quillBlockAttrs',
        addGlobalAttributes() {
            return [{
                types: ['heading', 'paragraph', 'listItem'],
                attributes: {
                    textAlign: {
                        default: null,
                        parseHTML: (el) => el.style.textAlign || (/\bql-align-(center|right|justify)\b/.exec(el.className || '') || [])[1] || null,
                        renderHTML: (a) => (a.textAlign && a.textAlign !== 'left' ? { style: `text-align: ${a.textAlign}` } : {}),
                    },
                },
            }];
        },
        addCommands() {
            return {
                setTextAlign: (alignment) => ({ commands }) => ['paragraph', 'heading', 'listItem'].map((t) => commands.updateAttributes(t, { textAlign: alignment === 'left' ? null : alignment })).some(Boolean),
            };
        },
        priority: 1000,
    });

    // Quill-style highlight: <span style="background-color">, parsed from <mark> too
    const Highlight = T.Highlight.extend({
        parseHTML() {
            return [
                { tag: 'mark' },
                // before TextStyle's span rule (which would otherwise swallow the colour)
                { tag: 'span', priority: 100, consuming: false, getAttrs: (el) => (el.style && el.style.backgroundColor ? { color: el.style.backgroundColor } : false) },
            ];
        },
    }).configure({ multicolor: true });

    const Image = T.Node.create({
        name: 'image',
        inline: true,
        group: 'inline',
        atom: true,
        draggable: true,
        selectable: true,
        addAttributes() {
            return {
                src: { default: null },
                alt: { default: '' },
                // photographer credit for library photos ("Photo: Jane Doe / Unsplash")
                title: { default: null, parseHTML: (el) => el.getAttribute('title') || null, renderHTML: (a) => (a.title ? { title: a.title } : {}) },
                width: { default: null, parseHTML: (el) => el.getAttribute('width') || null, renderHTML: (a) => (a.width ? { width: a.width } : {}) },
            };
        },
        parseHTML() { return [{ tag: 'img[src]' }]; },
        renderHTML({ HTMLAttributes }) { return ['img', T.mergeAttributes(HTMLAttributes)]; },
    });

    const Video = T.Node.create({
        name: 'video',
        group: 'block',
        atom: true,
        draggable: true,
        selectable: true,
        addAttributes() { return { src: { default: null } }; },
        parseHTML() { return [{ tag: 'iframe[src]', getAttrs: (el) => ({ src: el.getAttribute('src') }) }]; },
        renderHTML({ HTMLAttributes }) {
            return ['iframe', { class: 'ql-video', frameborder: '0', allowfullscreen: 'true', src: HTMLAttributes.src }];
        },
        addNodeView() {
            return ({ node }) => {
                const dom = document.createElement('div');
                dom.className = 'doc-video';
                dom.contentEditable = 'false';
                if (viewer) {
                    // student: a real, playable player — inserted when scrolled near
                    const src = node.attrs.src;
                    viewer.lazy(dom, () => { dom.innerHTML = `<iframe class="ql-video" frameborder="0" allowfullscreen="true" loading="lazy" src="${esc(src)}"></iframe>`; });
                    return { dom, ignoreMutation: () => true };
                }
                dom.innerHTML = `<iframe class="ql-video" frameborder="0" allowfullscreen="true" src="${esc(node.attrs.src)}" tabindex="-1"></iframe><span class="doc-video-cover" title="Drag to move · Delete to remove"></span>`;
                return { dom };
            };
        },
    });

    const AssignmentEmbed = T.Node.create({
        name: 'assignmentEmbed',
        inline: true,
        group: 'inline',
        atom: true,
        selectable: true,
        draggable: true,
        priority: 1000,
        addAttributes() {
            return {
                id: { default: '', parseHTML: (el) => el.getAttribute('data-assignment-id') || '', renderHTML: () => ({}) },
                title: { default: '', parseHTML: (el) => el.getAttribute('data-assignment-title') || '', renderHTML: () => ({}) },
            };
        },
        parseHTML() { return [{ tag: 'span.assignment-embed[data-assignment-id]' }]; },
        renderHTML({ node }) {
            return ['span', { class: 'assignment-embed', contenteditable: 'false', 'data-assignment-id': node.attrs.id, 'data-assignment-title': node.attrs.title },
                ['i', { class: 'fa-solid fa-clipboard-check' }], ['span', {}, node.attrs.title || 'Assignment']];
        },
        ...(viewer && viewer.renderAssignment ? {
            addNodeView() {
                return ({ node }) => {
                    const dom = document.createElement('span');
                    dom.className = 'assignment-embed';
                    dom.contentEditable = 'false';
                    dom.setAttribute('data-assignment-id', node.attrs.id);
                    dom.setAttribute('data-assignment-title', node.attrs.title);
                    dom.setAttribute('role', 'button');
                    dom.tabIndex = 0;
                    dom.addEventListener('keydown', (e) => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); dom.click(); } });
                    const view = { repaint: () => { dom.innerHTML = viewer.renderAssignment(node.attrs.id, node.attrs.title || 'Assignment'); } };
                    view.repaint();
                    viewer.assignViews.add(view);
                    return { dom, ignoreMutation: () => true, destroy: () => viewer.assignViews.delete(view) };
                };
            },
        } : {}),
    });

    return [
        // <pre> / <blockquote> are kept (Quill-era and seeded lessons use them; no toolbar button)
        T.StarterKit.configure({ heading: { levels: [1, 2, 3] }, code: false }),
        T.Underline,
        T.TextStyle,
        T.Color,
        Highlight,
        ...sharedTextExtensions(T), // font family / size, line spacing, indent, Quill classes (same as Slides)
        QuillBlockAttrs,
        T.Link.configure({ openOnClick: false, autolink: !viewer, HTMLAttributes: { rel: 'noopener noreferrer', target: '_blank' } }),
        Image,
        Video,
        AssignmentEmbed,
        ...(viewer ? [] : [T.Placeholder.configure({ placeholder: 'Start writing your lesson…' })]),
    ];
}
// ── student activity blocks: Poll · Quiz question · Open response · Sticky notes ──
// A block-level atom rendered as an uneditable card (node view). Clicking the
// card (or Enter while it is selected) opens the setup modal. Saved as
//   <div class="lesson-widget" data-widget-id data-widget-type data-config='{…}'>
// The quiz answer key is never in the HTML: it lives in
// work_answer_keys/{lessonId}_{widgetId} (hooks.loadQuizKey / saveQuizKey).
// In a document they work like a worksheet: students answer whenever they open
// it (lessons/{id}/responses — viewer.js), no live session needed.
export const DOC_WIDGET_TYPES = Object.freeze(['poll', 'quiz', 'open_response', 'board']);
export const BOARD_COLORS = Object.freeze(['#fef3c7', '#dcfce7', '#dbeafe', '#fce7f3', '#ede9fe']);
const MAX_OPTIONS = 8;

function cleanConfig(type, raw) {
    const c = raw && typeof raw === 'object' ? raw : {};
    if (type === 'board') {
        return { prompt: String(c.prompt || ''), noteColor: BOARD_COLORS.includes(c.noteColor) ? c.noteColor : BOARD_COLORS[0] };
    }
    if (type === 'open_response') {
        const max = Number(c.maxLength);
        return { prompt: String(c.prompt || ''), mode: c.mode === 'long' ? 'long' : 'short', maxLength: Number.isFinite(max) && max > 0 ? Math.max(20, Math.min(4000, Math.round(max))) : 500 };
    }
    const options = (Array.isArray(c.options) ? c.options : []).filter((o) => o && o.id).slice(0, MAX_OPTIONS).map((o) => ({ id: String(o.id), text: String(o.text || '') }));
    const base = { question: String(c.question || ''), options };
    if (type === 'quiz') {
        const pts = Number(c.points);
        return { ...base, points: Number.isFinite(pts) ? Math.max(0, Math.min(100, Math.round(pts))) : 1 };
    }
    return { ...base, multiple: !!c.multiple };
}

function newWidget(type) {
    const w = createWidget(type);
    return { wid: w.id, wtype: type, config: cleanConfig(type, w.props) };
}

// viewer: read-only placeholder card (student answering arrives in step 3e)
function buildWidgetNode(T, wctx, { viewer = null } = {}) {
    return T.Node.create({
        name: 'lessonWidget',
        group: 'block',
        atom: true,
        draggable: true,
        selectable: true,
        priority: 1000,
        addAttributes() {
            return {
                wid: { default: '', parseHTML: (el) => el.getAttribute('data-widget-id') || '', renderHTML: () => ({}) },
                wtype: {
                    default: 'poll',
                    parseHTML: (el) => (DOC_WIDGET_TYPES.includes(el.getAttribute('data-widget-type')) ? el.getAttribute('data-widget-type') : 'poll'),
                    renderHTML: () => ({}),
                },
                config: {
                    default: null,
                    parseHTML: (el) => { try { return JSON.parse(el.getAttribute('data-config') || 'null'); } catch (e) { return null; } },
                    renderHTML: () => ({}),
                },
            };
        },
        parseHTML() { return [{ tag: 'div.lesson-widget[data-widget-id]' }]; },
        renderHTML({ node }) {
            return ['div', { class: 'lesson-widget', 'data-widget-id': node.attrs.wid, 'data-widget-type': node.attrs.wtype, 'data-config': JSON.stringify(cleanConfig(node.attrs.wtype, node.attrs.config)) }];
        },
        addKeyboardShortcuts() {
            return {
                Enter: () => {
                    const sel = this.editor.state.selection;
                    if (!sel.node || sel.node.type.name !== 'lessonWidget') return false;
                    wctx.open(sel.node.attrs.wid);
                    return true;
                },
            };
        },
        addNodeView() {
            return ({ node: initial }) => {
                const dom = document.createElement('div');
                dom.className = 'doc-widget';
                dom.contentEditable = 'false';
                dom.tabIndex = -1;
                let node = initial, printed = null;
                const paint = (force = false) => {
                    const type = node.attrs.wtype, cfg = cleanConfig(type, node.attrs.config);
                    const key = wctx.keyOf(node.attrs.wid);
                    const print = JSON.stringify([type, cfg, type === 'quiz' ? key : null]);
                    if (!force && print === printed) return;
                    printed = print;
                    const meta = WIDGET_META[type];
                    dom.dataset.widgetType = type;
                    dom.setAttribute('role', 'button');
                    dom.setAttribute('aria-label', `${meta.label} — click or press Enter to set it up`);
                    dom.innerHTML = `${widgetMarkup({ id: node.attrs.wid, type, props: cfg }, 'editor')}<span class="doc-widget-edit"><i class="fa-solid fa-pen"></i>Click to set up</span>`;
                    dom.querySelectorAll('.cv-w-q.cv-w-muted').forEach((p) => { p.textContent = type === 'open_response' || type === 'board' ? 'Click to write the prompt' : 'Click to write the question'; });
                    dom.querySelectorAll('.cv-w-note').forEach((n) => { n.innerHTML = `<i class="fa-solid fa-file-pen"></i> ${type === 'board' ? 'Students post notes right in the document — everyone in the class sees them.' : 'Students answer right in the document, whenever they open it.'}`; });
                    dom.querySelectorAll('.cv-w-opts > p.cv-w-muted').forEach((p) => { p.textContent = 'Click to add answer choices'; });
                    if (type === 'quiz') {
                        const correct = new Set(Array.isArray(key) ? key : []);
                        dom.querySelectorAll('.cv-w-opt-static').forEach((el, i) => {
                            if (!correct.has(cfg.options[i]?.id)) return;
                            el.classList.add('doc-w-correct');
                            el.querySelector('.cv-w-mark').innerHTML = '<i class="fa-solid fa-circle-check"></i>';
                        });
                        if (Array.isArray(key) && !key.length && cfg.options.length) {
                            dom.querySelector('.cv-w-head')?.insertAdjacentHTML('beforeend', '<span class="doc-w-warn"><i class="fa-solid fa-triangle-exclamation"></i>No correct answer yet</span>');
                        }
                    }
                };
                if (viewer && viewer.renderWidget) {
                    // students: the host paints an answerable form (viewer.js)
                    const type = node.attrs.wtype, cfg = cleanConfig(type, node.attrs.config), meta = WIDGET_META[type];
                    dom.classList.add('doc-widget-view', 'doc-widget-live');
                    dom.dataset.widgetType = type;
                    dom.setAttribute('role', 'group');
                    dom.setAttribute('aria-label', `${meta.label}: ${(type === 'open_response' || type === 'board' ? cfg.prompt : cfg.question) || 'activity'}`);
                    viewer.renderWidget(dom, { id: node.attrs.wid, type, props: cfg });
                    return { dom, ignoreMutation: () => true, stopEvent: () => true };
                }
                if (viewer) {
                    const type = node.attrs.wtype, cfg = cleanConfig(type, node.attrs.config), meta = WIDGET_META[type];
                    dom.classList.add('doc-widget-view');
                    dom.dataset.widgetType = type;
                    dom.setAttribute('role', 'group');
                    dom.setAttribute('aria-label', `${meta.label}: ${(type === 'open_response' ? cfg.prompt : cfg.question) || 'no question yet'} (not open for answers yet)`);
                    dom.innerHTML = widgetMarkup({ id: node.attrs.wid, type, props: cfg }, 'editor');
                    dom.querySelectorAll('.cv-w-q.cv-w-muted').forEach((p) => { p.textContent = 'No question yet'; });
                    dom.querySelectorAll('.cv-w-opts > p.cv-w-muted').forEach((p) => { p.textContent = 'No answer choices yet'; });
                    dom.querySelectorAll('.cv-w-note').forEach((n) => { n.innerHTML = '<i class="fa-solid fa-lock"></i> Not open for answers yet'; });
                    return { dom, ignoreMutation: () => true };
                }
                const view = { repaint: () => paint(true), wid: () => node.attrs.wid };
                wctx.views.add(view);
                paint();
                if (initial.attrs.wtype === 'quiz') wctx.ensureKey(initial.attrs.wid);
                return {
                    dom,
                    update(next) {
                        if (next.type.name !== 'lessonWidget') return false;
                        const idChanged = next.attrs.wid !== node.attrs.wid;
                        node = next;
                        if (idChanged && node.attrs.wtype === 'quiz') wctx.ensureKey(node.attrs.wid);
                        paint(idChanged);
                        return true;
                    },
                    ignoreMutation: () => true,
                    destroy() { wctx.views.delete(view); },
                };
            };
        },
    });
}

const CSS = `
.doc-pop { position: fixed; z-index: 150; background: #fff; border: 1px solid #dce3ed; border-radius: 10px; box-shadow: 0 10px 28px rgba(13,31,53,.18); padding: 10px; width: 300px; font-family: 'DM Sans', sans-serif; }
.doc-pop p.doc-pop-title { font-size: 10px; font-weight: 800; color: #6b84a0; text-transform: uppercase; letter-spacing: .08em; margin: 0 0 6px; }
.doc-pop input { width: 100%; box-sizing: border-box; height: 32px; border: 1px solid #dce3ed; border-radius: 6px; padding: 0 9px; font-size: 12.5px; color: #0d1f35; outline: none; }
.doc-pop input:focus { border-color: #2563eb; box-shadow: 0 0 0 3px rgba(37,99,235,.15); }
.doc-pop .doc-pop-err { margin: 5px 1px 0; font-size: 11px; font-weight: 700; color: #e31b4a; }
.doc-pop .doc-pop-row { display: flex; gap: 6px; margin-top: 8px; }
.doc-pop button { height: 28px; padding: 0 10px; border-radius: 6px; border: 1px solid #dce3ed; background: #fff; font-size: 12px; font-weight: 700; color: #374f6b; cursor: pointer; display: inline-flex; align-items: center; gap: 6px; }
.doc-pop button.doc-primary { background: #2563eb; border-color: #2563eb; color: #fff; }
/* shared by the teacher editor (#docEditor) and the student viewer (createDocumentViewer) */
.doc-page { max-width: 816px; min-height: 1056px; margin: 2rem auto; padding: 1in; box-sizing: border-box; background: #fff;
  box-shadow: 0 1px 3px rgba(0,0,0,.12); border: 0; border-radius: 0; }
.doc-page .doc-pm { padding: 0; height: auto; overflow: visible; }
.doc-pm { outline: none; font-family: 'DM Sans', sans-serif; font-size: 14.5px; color: #0d1f35; line-height: 1.6; }
/* text inherits the document's (or the chosen) font — not a page-wide "* { font-family }" rule */
.doc-pm :is(p, h1, h2, h3, ul, ol, li, strong, b, em, u, s, a, mark, span, blockquote) { font-family: inherit; }
.doc-pm pre, .doc-pm pre * { font-family: 'DM Mono', ui-monospace, SFMono-Regular, Menlo, monospace; }
.doc-pm pre { white-space: pre-wrap; background: #f4f7fb; border: 1px solid #e5eaf1; border-radius: 6px; padding: 10px 12px; margin: 8px 0; font-size: 13px; line-height: 1.5; }
.doc-pm blockquote { border-left: 4px solid #dce3ed; margin: 6px 0; padding-left: 14px; color: #374f6b; }
.doc-pm blockquote + blockquote { margin-top: -6px; }
.doc-pm h1 { font-size: 24px; font-weight: 700; }
.doc-pm h2 { font-size: 19px; font-weight: 700; }
.doc-pm h3 { font-size: 16px; font-weight: 700; }
.doc-pm a { color: #2563eb; text-decoration: underline; }
.doc-view { cursor: text; }
.doc-pm.doc-view .doc-video iframe { pointer-events: auto; }
.doc-view .assignment-embed:focus:not(:focus-visible) { outline: none; }
.doc-view .assignment-embed:focus-visible { outline: 2px solid #4f46e5; outline-offset: 2px; }
.doc-view .doc-widget { cursor: default; user-select: text; }
.doc-view .doc-widget-live { margin: 14px 0; }
.doc-view .doc-widget-live .cv-obj { position: static; }
.doc-view .doc-widget-live .cv-w { height: auto; min-height: 0; overflow: visible; padding: 14px 16px; gap: 8px; font-size: 14px; }
.doc-view .doc-widget-live .cv-w-q { font-size: 15px; }
.doc-view .doc-widget-live .cv-w-opts, .doc-view .doc-widget-live .cv-w-wall { overflow: visible; }
.doc-view .doc-widget-live .cv-w-opt { font-size: 13.5px; padding: 8px 11px; }
.doc-colors, .dw-colors { display: flex; gap: 8px; }
.dw-swatch { width: 30px; height: 30px; border-radius: 8px; border: 2px solid #dce3ed; cursor: pointer; }
.dw-swatch.dw-on { border-color: #2563eb; box-shadow: 0 0 0 2px rgba(37,99,235,.25); }
.doc-pop-list { display: flex; flex-direction: column; gap: 2px; margin-bottom: 4px; }
.doc-pop-item { display: flex; align-items: center; gap: 9px; width: 100%; text-align: left; border: 0; background: none; padding: 8px 9px; border-radius: 7px; font: inherit; font-size: 12.5px; font-weight: 700; color: #0d1f35; cursor: pointer; }
.doc-pop-item:hover, .doc-pop-item:focus-visible { background: #eef2ff; outline: none; }
.doc-pop-item i { color: #2563eb; width: 16px; text-align: center; }
.doc-view .doc-widget .cv-w { box-shadow: none; }
@media (max-width: 1100px) { .doc-page { padding: 0.6in; } }
@media (max-width: 767px) { .doc-page.doc-page-view { padding: 24px 20px; min-height: 0; margin: 0; } }
.doc-pm li > p { display: inline; margin: 0; }
.doc-pm img { max-width: 100%; height: auto; border-radius: 4px; vertical-align: bottom; }
.doc-pm img.ProseMirror-selectednode { outline: 3px solid #2563eb; outline-offset: 2px; }
.doc-pm hr { border: 0; border-top: 2px solid #dce3ed; margin: 18px 0; }
.doc-pm hr.ProseMirror-selectednode { border-top-color: #2563eb; }
.doc-pm .doc-video { position: relative; width: 100%; aspect-ratio: 16 / 9; margin: 12px 0; border-radius: 8px; overflow: hidden; background: #000; }
.doc-pm .doc-video iframe { width: 100%; height: 100%; border: 0; pointer-events: none; display: block; }
.doc-pm .doc-video .doc-video-cover { position: absolute; inset: 0; cursor: grab; }
.doc-pm .doc-video.ProseMirror-selectednode { outline: 3px solid #2563eb; outline-offset: 2px; }
.doc-pm .assignment-embed.ProseMirror-selectednode { outline: 2px solid #2563eb; outline-offset: 1px; }
.doc-pm p.is-editor-empty:first-child::before { content: attr(data-placeholder); color: #9ab0c6; float: left; height: 0; pointer-events: none; }
.doc-pm .doc-widget { position: relative; margin: 14px 0; cursor: pointer; border-radius: 12px; user-select: none; white-space: normal; }
.doc-pm .doc-widget .cv-w { height: auto; min-height: 0; overflow: visible; padding: 14px 16px; gap: 8px; transition: border-color .12s, box-shadow .12s; }
.doc-pm .doc-widget .cv-w-q { font-size: 15px; }
.doc-pm .doc-widget .cv-w-opts { overflow: visible; }
.doc-pm .doc-widget .cv-w-note { margin-top: 2px; }
.doc-pm .doc-widget:hover .cv-w { border-color: #a5b4fc; box-shadow: 0 2px 10px rgba(79,70,229,.12); }
.doc-pm .doc-widget.ProseMirror-selectednode .cv-w { border-color: #2563eb; box-shadow: 0 0 0 2px #2563eb; }
.doc-pm .doc-widget-edit { position: absolute; top: 10px; right: 12px; display: inline-flex; align-items: center; gap: 5px; font-size: 10.5px; font-weight: 800; color: #4f46e5;
  background: #eef2ff; border: 1px solid #c7d2fe; border-radius: 999px; padding: 3px 9px; opacity: 0; transition: opacity .12s; pointer-events: none; font-family: 'DM Sans', sans-serif; }
.doc-pm .doc-widget:hover .doc-widget-edit, .doc-pm .doc-widget.ProseMirror-selectednode .doc-widget-edit { opacity: 1; }
.doc-pm .doc-w-correct { border-color: #059669 !important; background: #ecfdf5 !important; color: #065f46; }
.doc-pm .doc-w-correct .cv-w-mark { color: #059669; }
.doc-pm .doc-w-warn { font-size: 10px; font-weight: 800; color: #b45309; display: inline-flex; align-items: center; gap: 4px; }
.dw-overlay { position: fixed; inset: 0; z-index: 10020; background: rgba(13,31,53,.42); display: flex; align-items: center; justify-content: center; padding: 16px; font-family: 'DM Sans', sans-serif; }
.dw-modal { background: #fff; border-radius: 14px; box-shadow: 0 24px 60px rgba(13,31,53,.3); width: 100%; max-width: 520px; max-height: calc(100vh - 32px); display: flex; flex-direction: column; }
.dw-head { display: flex; align-items: center; gap: 10px; padding: 14px 16px; border-bottom: 1px solid #eef1f5; }
.dw-head h3 { margin: 0; font-size: 14px; font-weight: 800; color: #0d1f35; flex: 1; }
.dw-x { height: 32px; width: 32px; border-radius: 8px; border: 0; background: transparent; color: #6b84a0; cursor: pointer; font-size: 14px; }
.dw-x:hover { background: #f4f7fb; color: #0d1f35; }
.dw-body { padding: 14px 16px; overflow-y: auto; display: flex; flex-direction: column; gap: 14px; }
.dw-field > label, .dw-field > .dw-label { display: block; font-size: 10px; font-weight: 800; color: #6b84a0; text-transform: uppercase; letter-spacing: .08em; margin-bottom: 6px; }
.dw-label .dw-need { color: #e31b4a; text-transform: none; letter-spacing: 0; font-weight: 700; }
.dw-input, .dw-textarea { width: 100%; box-sizing: border-box; border: 1px solid #dce3ed; border-radius: 8px; padding: 8px 10px; font: inherit; font-size: 13px; color: #0d1f35; outline: none; background: #fff; }
.dw-textarea { resize: vertical; min-height: 60px; line-height: 1.4; }
.dw-input:focus, .dw-textarea:focus { border-color: #2563eb; box-shadow: 0 0 0 3px rgba(37,99,235,.15); }
.dw-opts { display: flex; flex-direction: column; gap: 6px; }
.dw-opt { display: flex; align-items: center; gap: 6px; }
.dw-opt .dw-input { flex: 1; min-width: 0; height: 34px; padding: 0 10px; }
.dw-ib { height: 34px; width: 34px; flex-shrink: 0; border-radius: 8px; border: 1px solid #dce3ed; background: #fff; color: #6b84a0; cursor: pointer; display: inline-flex; align-items: center; justify-content: center; font-size: 12px; }
.dw-ib:hover:not(:disabled) { background: #f4f7fb; color: #0d1f35; }
.dw-ib:disabled { opacity: .4; cursor: default; }
.dw-ib.dw-correct { background: #ecfdf5; border-color: #059669; color: #047857; }
.dw-ib.dw-del:hover:not(:disabled) { color: #e31b4a; border-color: #fecdd3; background: #fff1f2; }
.dw-add { align-self: flex-start; height: 30px; padding: 0 10px; border-radius: 8px; border: 1px dashed #b9c8da; background: #fff; color: #2563eb; font: inherit; font-size: 12px; font-weight: 700; cursor: pointer; display: inline-flex; align-items: center; gap: 6px; }
.dw-add:disabled { opacity: .45; cursor: default; }
.dw-seg { display: inline-flex; background: #eef1f5; border-radius: 8px; padding: 3px; gap: 2px; }
.dw-seg button { border: 0; background: transparent; border-radius: 6px; padding: 5px 12px; font: inherit; font-size: 12px; font-weight: 700; color: #6b84a0; cursor: pointer; }
.dw-seg button.dw-on { background: #fff; color: #0d1f35; box-shadow: 0 1px 2px rgba(13,31,53,.12); }
.dw-num { width: 90px; height: 34px; }
.dw-hint { margin: 0; font-size: 11.5px; font-weight: 600; color: #9ab0c6; line-height: 1.4; }
.dw-foot { display: flex; align-items: center; gap: 8px; padding: 12px 16px; border-top: 1px solid #eef1f5; }
.dw-foot .dw-spacer { flex: 1; }
.dw-btn { height: 34px; padding: 0 14px; border-radius: 8px; border: 1px solid #dce3ed; background: #fff; color: #374f6b; font: inherit; font-size: 12.5px; font-weight: 700; cursor: pointer; display: inline-flex; align-items: center; gap: 6px; }
.dw-btn:hover { background: #f4f7fb; }
.dw-btn.dw-primary { background: #0d1f35; border-color: #0d1f35; color: #fff; }
.dw-btn.dw-primary:hover { background: #2563eb; border-color: #2563eb; }
.dw-btn.dw-danger { color: #be123c; border-color: transparent; }
.dw-btn.dw-danger:hover { background: #fff1f2; }
.dw-btn:focus-visible, .dw-ib:focus-visible, .dw-seg button:focus-visible, .dw-add:focus-visible, .dw-x:focus-visible { outline: 2px solid #2563eb; outline-offset: 1px; }
`;
function ensureStyles() {
    if (!document.getElementById('doc-editor-styles')) {
        const st = document.createElement('style');
        st.id = 'doc-editor-styles';
        st.textContent = CSS;
        document.head.appendChild(st);
    }
    // the shared activity-card styles (renderer.js injects them for slides)
    if (!document.getElementById('doc-widget-styles') && !document.getElementById('cv-renderer-styles')) {
        const st = document.createElement('style');
        st.id = 'doc-widget-styles';
        st.textContent = WIDGET_CSS;
        document.head.appendChild(st);
    }
}

// ── editor ───────────────────────────────────────────────────────────────
// hooks: onChange(), onTransaction(editor), onAssignmentClick(id),
//        uploadImage(file) → Promise<{ url, alt }>, parseVideoUrl(url) → embedUrl | null,
//        loadQuizKey(widgetId) → Promise<string[]>, saveQuizKey(widgetId, ids) → Promise,
//        onError(message)
export async function createDocumentEditor({ element, html = '', onChange = null, onTransaction = null, onAssignmentClick = null,
    uploadImage = null, parseVideoUrl = null, loadQuizKey = null, saveQuizKey = null, onError = null } = {}) {
    ensureStyles();
    const T = await loadTiptap();
    element.innerHTML = '';
    let pop = null;
    let modal = null;
    let editor = null;

    // ── quiz answer keys (cache: widgetId → string[] | 'loading') ──
    const keyCache = new Map();
    const wctx = {
        views: new Set(),
        keyOf: (wid) => keyCache.get(wid),
        open: (wid) => openWidgetConfig(wid),
        ensureKey(wid) {
            if (!wid || keyCache.has(wid) || !loadQuizKey) return;
            keyCache.set(wid, 'loading');
            Promise.resolve(loadQuizKey(wid)).catch(() => []).then((k) => {
                if (keyCache.get(wid) !== 'loading') return; // set meanwhile (marked / copied)
                keyCache.set(wid, Array.isArray(k) ? k : []);
                repaintWidget(wid);
                if (modal && modal.wid === wid) modal.render();
            });
        },
    };
    const repaintWidget = (wid) => wctx.views.forEach((v) => { if (v.wid() === wid) v.repaint(); });
    async function setQuizKey(wid, ids) {
        const prev = keyCache.get(wid);
        keyCache.set(wid, ids);
        repaintWidget(wid);
        if (!saveQuizKey) return;
        try { await saveQuizKey(wid, ids); }
        catch (e) {
            keyCache.set(wid, prev);
            repaintWidget(wid);
            onError && onError('The correct answer could not be saved. Please try again.');
        }
    }

    editor = new T.Editor({
        element,
        extensions: [...buildExtensions(T), buildWidgetNode(T, wctx)],
        content: fromQuillHtml(html),
        editorProps: {
            attributes: { class: 'ql-editor doc-pm', spellcheck: 'true', 'aria-label': 'Lesson document', role: 'textbox', 'aria-multiline': 'true' },
            // paste / drop an image file → Storage upload
            handlePaste: (view, event) => {
                const file = [...(event.clipboardData?.files || [])].find((f) => /^image\//.test(f.type));
                if (!file || !uploadImage) return false;
                event.preventDefault();
                insertImageFile(file);
                return true;
            },
            handleDrop: (view, event, slice, moved) => {
                if (moved) return false;
                const file = [...(event.dataTransfer?.files || [])].find((f) => /^image\//.test(f.type));
                if (!file || !uploadImage) return false;
                event.preventDefault();
                const at = view.posAtCoords({ left: event.clientX, top: event.clientY });
                if (at) editor.commands.setTextSelection(at.pos);
                insertImageFile(file);
                return true;
            },
            handleClickOn: (view, pos, node, nodePos, event, direct) => {
                if (node.type.name === 'assignmentEmbed' && onAssignmentClick) { onAssignmentClick(node.attrs.id); return true; }
                if (node.type.name === 'lessonWidget' && direct) {
                    editor.commands.setNodeSelection(nodePos);
                    openWidgetConfig(node.attrs.wid);
                    return true;
                }
                return false;
            },
        },
        onUpdate: () => { dedupeWidgets(); onChange && onChange(); },
        onTransaction: () => { onTransaction && onTransaction(editor); },
    });

    // A copied / pasted card arrives with its original's id: give every
    // duplicate a fresh id (outside undo history) and copy the quiz key over.
    function dedupeWidgets() {
        const seen = new Set(), dups = [];
        editor.state.doc.descendants((node, pos) => {
            if (node.type.name !== 'lessonWidget') return;
            if (!node.attrs.wid || seen.has(node.attrs.wid)) dups.push({ pos, node });
            else seen.add(node.attrs.wid);
        });
        if (!dups.length) return;
        const tr = editor.state.tr;
        dups.forEach(({ pos, node }) => {
            const wid = newWidget(node.attrs.wtype).wid;
            tr.setNodeMarkup(pos, undefined, { ...node.attrs, wid });
            if (node.attrs.wtype === 'quiz' && node.attrs.wid) copyQuizKey(node.attrs.wid, wid);
        });
        tr.setMeta('addToHistory', false);
        editor.view.dispatch(tr);
    }
    async function copyQuizKey(from, to) {
        let key = keyCache.get(from);
        if (!Array.isArray(key) && loadQuizKey) { try { key = await loadQuizKey(from); } catch (e) { key = null; } }
        if (Array.isArray(key) && key.length) setQuizKey(to, key);
        else if (!keyCache.has(to)) keyCache.set(to, []);
        repaintWidget(to);
    }

    function findWidget(wid) {
        let found = null;
        editor.state.doc.descendants((node, pos) => {
            if (found) return false;
            if (node.type.name === 'lessonWidget' && node.attrs.wid === wid) { found = { node, pos }; return false; }
            return true;
        });
        return found;
    }

    // inline image at the caret; with a whole block selected, in a new paragraph after it
    function insertImageNode(attrs) {
        const sel = editor.state.selection;
        const img = { type: 'image', attrs };
        if (sel.node && sel.node.isBlock) return editor.chain().focus().insertContentAt(sel.to, { type: 'paragraph', content: [img] }).run();
        return editor.chain().focus().insertContent(img).run();
    }

    async function insertImageFile(file) {
        if (!uploadImage) return;
        try {
            const { url, alt } = await uploadImage(file);
            if (url) insertImageNode({ src: url, alt: alt || '' });
        } catch (e) {
            onError && onError(e?.message || 'The image could not be uploaded.');
        }
    }
    const fileInput = document.createElement('input');
    fileInput.type = 'file';
    fileInput.accept = 'image/*';
    fileInput.addEventListener('change', () => {
        const f = fileInput.files?.[0];
        fileInput.value = '';
        if (f) insertImageFile(f);
    });

    // Block embeds go after the top-level block holding the caret, so a video,
    // divider or activity never ends up inside a list item (Quill can't show that).
    function insertBlock(nodes, { focus = true } = {}) {
        const sel = editor.state.selection;
        // a selected block (an activity card, a video…) is never replaced: insert after it
        if (sel.node && sel.node.isBlock) {
            const chain0 = focus ? editor.chain().focus() : editor.chain();
            return chain0.insertContentAt(sel.to, nodes).run();
        }
        const { $from } = sel;
        const inside = $from.depth > 1 || editor.isActive('listItem');
        const chain = focus ? editor.chain().focus() : editor.chain();
        if (!inside) return chain.insertContent(nodes).run();
        return chain.insertContentAt($from.after(1), nodes).run();
    }
    function insertVideo(src) {
        if (!src) return false;
        return insertBlock([{ type: 'video', attrs: { src } }, { type: 'paragraph' }]);
    }

    function insertAssignment({ id, title }) {
        if (!id) return false;
        return editor.chain().focus().insertContent([{ type: 'assignmentEmbed', attrs: { id, title: title || '' } }, { type: 'text', text: ' ' }]).run();
    }

    function insertDivider() {
        if (editor.isActive('listItem')) return insertBlock([{ type: 'horizontalRule' }, { type: 'paragraph' }]);
        return editor.chain().focus().setHorizontalRule().run();
    }

    // "Add page": a divider at the end + a fresh line to type on
    function addPage() {
        const end = editor.state.doc.content.size;
        editor.chain().focus().insertContentAt(end, [{ type: 'horizontalRule' }, { type: 'paragraph' }]).setTextSelection(editor.state.doc.content.size).run();
        requestAnimationFrame(() => element.lastElementChild?.lastElementChild?.scrollIntoView({ block: 'nearest', behavior: 'smooth' }));
    }

    // New activity card after the caret's block, then straight into its setup.
    // Synchronous on purpose: no focus() (Tiptap refocuses on a later frame,
    // which would pull the keyboard back out of the modal) and no rAF (paused
    // in background tabs).
    function insertWidget(type) {
        if (!DOC_WIDGET_TYPES.includes(type)) return false;
        const w = newWidget(type);
        if (type === 'quiz') keyCache.set(w.wid, []);
        const ok = insertBlock([{ type: 'lessonWidget', attrs: w }, { type: 'paragraph' }], { focus: false });
        if (!ok) return false;
        const hit = findWidget(w.wid);
        if (hit) {
            editor.commands.setNodeSelection(hit.pos);
            try { editor.view.nodeDOM(hit.pos)?.scrollIntoView?.({ block: 'nearest' }); } catch (e) { /* not rendered */ }
        }
        openWidgetConfig(w.wid, { isNew: true });
        return true;
    }

    // ── activity setup modal ──
    function closeWidgetConfig({ refocus = true } = {}) {
        if (!modal) return;
        modal.cleanup();
        modal.el.remove();
        modal = null;
        if (refocus && editor && !editor.isDestroyed) editor.commands.focus();
    }
    function openWidgetConfig(wid, { isNew = false } = {}) {
        const hit = findWidget(wid);
        if (!hit) return;
        closePop();
        closeWidgetConfig({ refocus: false });
        const type = hit.node.attrs.wtype, meta = WIDGET_META[type];
        const d = JSON.parse(JSON.stringify(cleanConfig(type, hit.node.attrs.config)));
        if (type === 'poll' || type === 'quiz') while (d.options.length < 2) d.options.push(newOption(''));
        if (type === 'quiz') wctx.ensureKey(wid);
        const k0 = keyCache.get(wid);
        let correct = Array.isArray(k0) ? [...k0] : null; // null until loaded
        let correctTouched = false;

        const overlay = document.createElement('div');
        overlay.className = 'dw-overlay';
        overlay.innerHTML = `<div class="dw-modal" role="dialog" aria-modal="true" aria-labelledby="dwTitle">
            <div class="dw-head"><span class="cv-w-badge cv-w-badge-${type}"><i class="fa-solid ${meta.icon}"></i>${esc(meta.label)}</span>
                <h3 id="dwTitle">${isNew ? 'Set up' : 'Edit'} ${esc(meta.label.toLowerCase())}</h3>
                <button type="button" class="dw-x" data-dw="cancel" aria-label="Close"><i class="fa-solid fa-xmark"></i></button></div>
            <div class="dw-body" data-dw-body></div>
            <div class="dw-foot">
                <button type="button" class="dw-btn dw-danger" data-dw="remove"><i class="fa-solid fa-trash-can"></i>Remove</button>
                <span class="dw-spacer"></span>
                <button type="button" class="dw-btn" data-dw="cancel">Cancel</button>
                <button type="button" class="dw-btn dw-primary" data-dw="save">${isNew ? 'Add to document' : 'Save'}</button>
            </div></div>`;
        (element.closest('.lesson-editor') || document.body).appendChild(overlay);
        const body = overlay.querySelector('[data-dw-body]');

        function render() {
            if (correct === null && Array.isArray(keyCache.get(wid))) correct = [...keyCache.get(wid)];
            const loading = type === 'quiz' && correct === null;
            if (type === 'board') {
                body.innerHTML = `<div class="dw-field"><label for="dwQ">Prompt</label><textarea id="dwQ" class="dw-textarea" data-dw-field="prompt" rows="3" placeholder="Post one thing you noticed…">${esc(d.prompt)}</textarea></div>
                    <div class="dw-field"><span class="dw-label">Note color</span><div class="dw-colors" role="group" aria-label="Note color">${BOARD_COLORS.map((c) => `<button type="button" class="dw-swatch ${d.noteColor === c ? 'dw-on' : ''}" data-dw-color="${c}" style="background:${c}" aria-label="Note color ${c}" aria-pressed="${d.noteColor === c}"></button>`).join('')}</div></div>
                    <p class="dw-hint">Each student posts a sticky note right in the document. Everyone in the class sees the notes, with the student's name.</p>`;
                return;
            }
            if (type === 'open_response') {
                body.innerHTML = `<div class="dw-field"><label for="dwQ">Prompt</label><textarea id="dwQ" class="dw-textarea" data-dw-field="prompt" rows="3" placeholder="Explain how you solved it…">${esc(d.prompt)}</textarea></div>
                    <div class="dw-field"><span class="dw-label">Answer box</span><div class="dw-seg" role="group" aria-label="Answer box">
                        <button type="button" data-dw-mode="short" class="${d.mode !== 'long' ? 'dw-on' : ''}" aria-pressed="${d.mode !== 'long'}">Short</button>
                        <button type="button" data-dw-mode="long" class="${d.mode === 'long' ? 'dw-on' : ''}" aria-pressed="${d.mode === 'long'}">Long</button></div></div>
                    <div class="dw-field"><label for="dwMax">Max characters</label><input id="dwMax" class="dw-input dw-num" type="number" min="20" max="4000" step="10" data-dw-num="maxLength" value="${d.maxLength}"></div>
                    <p class="dw-hint">Students write their answers right in the document. Only you see them.</p>`;
                return;
            }
            const isQuiz = type === 'quiz';
            const marked = new Set(correct || []);
            const need = isQuiz && !loading && !d.options.some((o) => marked.has(o.id));
            body.innerHTML = `<div class="dw-field"><label for="dwQ">Question</label><textarea id="dwQ" class="dw-textarea" data-dw-field="question" rows="2" placeholder="${isQuiz ? 'What is 7 × 8?' : 'Which topic should we review?'}">${esc(d.question)}</textarea></div>
                <div class="dw-field"><span class="dw-label">Answer choices${isQuiz ? (loading ? ' · loading the answer key…' : need ? ' · <span class="dw-need">mark the correct one</span>' : ' · ✓ = correct') : ''}</span>
                    <div class="dw-opts">${d.options.map((o, i) => `<div class="dw-opt">
                        ${isQuiz ? `<button type="button" class="dw-ib ${marked.has(o.id) ? 'dw-correct' : ''}" data-dw-correct="${esc(o.id)}" title="${marked.has(o.id) ? 'Correct answer' : 'Mark as correct'}" aria-label="${marked.has(o.id) ? `Choice ${i + 1} is the correct answer` : `Mark choice ${i + 1} as correct`}" aria-pressed="${marked.has(o.id)}" ${loading ? 'disabled' : ''}><i class="fa-solid fa-check"></i></button>` : ''}
                        <input type="text" class="dw-input" data-dw-opt="${esc(o.id)}" value="${esc(o.text)}" placeholder="Choice ${i + 1}" aria-label="Choice ${i + 1}">
                        <button type="button" class="dw-ib dw-del" data-dw-remove="${esc(o.id)}" title="Remove choice" aria-label="Remove choice ${i + 1}" ${d.options.length <= 2 ? 'disabled' : ''}><i class="fa-solid fa-xmark"></i></button>
                    </div>`).join('')}</div>
                    <button type="button" class="dw-add" data-dw="add" style="margin-top:8px" ${d.options.length >= MAX_OPTIONS ? 'disabled' : ''}><i class="fa-solid fa-plus"></i>Add choice</button></div>
                ${isQuiz
                    ? `<div class="dw-field"><label for="dwPts">Points</label><input id="dwPts" class="dw-input dw-num" type="number" min="0" max="100" step="1" data-dw-num="points" value="${d.points}"></div>
                       <p class="dw-hint">Auto-graded. The correct answer is stored separately and never sent to students.</p>`
                    : `<div class="dw-field"><span class="dw-label">Answers</span><div class="dw-seg" role="group" aria-label="Answers">
                        <button type="button" data-dw-multi="0" class="${d.multiple ? '' : 'dw-on'}" aria-pressed="${!d.multiple}">One choice</button>
                        <button type="button" data-dw-multi="1" class="${d.multiple ? 'dw-on' : ''}" aria-pressed="${!!d.multiple}">Pick any</button></div></div>
                       <p class="dw-hint">Students vote right in the document, once each.</p>`}`;
        }

        const rerender = (focusSel) => {
            const active = document.activeElement;
            const keep = focusSel || (active && body.contains(active) && active.id ? `#${active.id}` : null);
            render();
            if (keep) body.querySelector(keep)?.focus();
        };
        body.addEventListener('input', (e) => {
            const t = e.target;
            if (t.dataset.dwField) d[t.dataset.dwField] = t.value;
            else if (t.dataset.dwOpt) { const o = d.options.find((x) => x.id === t.dataset.dwOpt); if (o) o.text = t.value; }
            else if (t.dataset.dwNum) d[t.dataset.dwNum] = t.value;
        });
        body.addEventListener('click', (e) => {
            const b = e.target.closest('button');
            if (!b || b.disabled) return;
            if (b.dataset.dw === 'add') {
                d.options.push(newOption(''));
                rerender();
                const inputs = body.querySelectorAll('[data-dw-opt]');
                inputs[inputs.length - 1]?.focus();
            } else if (b.dataset.dwRemove) {
                d.options = d.options.filter((o) => o.id !== b.dataset.dwRemove);
                if (correct) { const n = correct.filter((x) => x !== b.dataset.dwRemove); if (n.length !== correct.length) { correct = n; correctTouched = true; } }
                rerender();
            } else if (b.dataset.dwCorrect) {
                const id = b.dataset.dwCorrect;
                // one correct answer per question (single choice); click again to clear
                correct = correct && correct.includes(id) ? [] : [id];
                correctTouched = true;
                rerender(`[data-dw-correct="${id}"]`);
            } else if (b.dataset.dwMode) { d.mode = b.dataset.dwMode; rerender(`[data-dw-mode="${d.mode}"]`); }
            else if (b.dataset.dwColor) { d.noteColor = b.dataset.dwColor; rerender(`[data-dw-color="${d.noteColor}"]`); }
            else if (b.dataset.dwMulti) { d.multiple = b.dataset.dwMulti === '1'; rerender(`[data-dw-multi="${b.dataset.dwMulti}"]`); }
        });

        function save() {
            const cur = findWidget(wid);
            if (!cur) { closeWidgetConfig(); return; }
            const cfg = cleanConfig(type, d);
            editor.chain().focus().command(({ tr }) => { tr.setNodeMarkup(cur.pos, undefined, { ...cur.node.attrs, config: cfg }); return true; }).setNodeSelection(cur.pos).run();
            if (type === 'quiz' && correctTouched && correct) {
                const ids = correct.filter((id) => cfg.options.some((o) => o.id === id));
                setQuizKey(wid, ids);
            }
            closeWidgetConfig();
        }
        function remove() {
            const cur = findWidget(wid);
            closeWidgetConfig();
            if (cur) editor.chain().focus().command(({ tr }) => { tr.delete(cur.pos, cur.pos + cur.node.nodeSize); return true; }).run();
        }
        overlay.addEventListener('click', (e) => {
            if (e.target === overlay) return closeWidgetConfig();
            const b = e.target.closest('[data-dw]');
            if (!b) return undefined;
            if (b.dataset.dw === 'cancel') return closeWidgetConfig();
            if (b.dataset.dw === 'save') return save();
            if (b.dataset.dw === 'remove') return remove();
            return undefined;
        });
        const focusFirst = () => { const f = body.querySelector('textarea, input'); f?.focus(); };
        const onKey = (e) => {
            if (e.key === 'Escape') { e.preventDefault(); e.stopPropagation(); closeWidgetConfig(); return; }
            // keys never reach the document behind the modal (a selected card would be typed over)
            if (!overlay.contains(e.target)) {
                if (e.key === 'Tab' || e.key.length === 1 || ['Backspace', 'Delete', 'Enter'].includes(e.key)) { e.preventDefault(); e.stopPropagation(); focusFirst(); }
                return;
            }
            if (e.key === 'Enter' && (e.ctrlKey || e.metaKey)) { e.preventDefault(); e.stopPropagation(); save(); return; }
            if (e.key === 'Enter' && e.target.matches?.('input.dw-input')) { e.preventDefault(); save(); return; }
            if (e.key === 'Tab') { // keep focus inside the dialog
                const f = [...overlay.querySelectorAll('button:not(:disabled), input, textarea')];
                if (!f.length) return;
                const i = f.indexOf(document.activeElement);
                if (e.shiftKey && (i <= 0)) { e.preventDefault(); f[f.length - 1].focus(); }
                else if (!e.shiftKey && i === f.length - 1) { e.preventDefault(); f[0].focus(); }
            }
        };
        document.addEventListener('keydown', onKey, true);
        modal = { el: overlay, wid, render: () => rerender(), cleanup() { document.removeEventListener('keydown', onKey, true); } };
        render();
        const first = body.querySelector('textarea, input');
        first?.focus();
        if (first && first.value) first.setSelectionRange(first.value.length, first.value.length);
        // a refocus queued earlier (Tiptap's focus() runs on the next frame) must not win
        setTimeout(() => { if (modal && modal.el === overlay && !overlay.contains(document.activeElement)) focusFirst(); }, 0);
        requestAnimationFrame(() => { if (modal && modal.el === overlay && !overlay.contains(document.activeElement)) focusFirst(); });
    }

    // ── video link popover (toolbar / Insert menu) ──
    function closePop() { if (!pop) return; pop.cleanup(); pop.el.remove(); pop = null; }
    function openPop(trigger, html2, wire) {
        const same = pop && pop.trigger === trigger;
        closePop();
        if (same) return;
        const box = document.createElement('div');
        box.className = 'doc-pop';
        box.setAttribute('role', 'dialog');
        box.innerHTML = html2;
        (element.closest('.lesson-editor') || document.body).appendChild(box);
        const r = trigger.getBoundingClientRect();
        box.style.left = `${Math.round(Math.min(Math.max(8, r.left), window.innerWidth - 316))}px`;
        box.style.top = `${Math.round(r.bottom + 6)}px`;
        box.addEventListener('mousedown', (e) => { if (!e.target.closest('input')) e.preventDefault(); });
        const outside = (e) => { if (!box.contains(e.target) && !trigger.contains(e.target)) closePop(); };
        const onKey = (e) => { if (e.key === 'Escape') { e.preventDefault(); e.stopPropagation(); closePop(); editor.commands.focus(); } };
        document.addEventListener('pointerdown', outside, true);
        document.addEventListener('keydown', onKey, true);
        pop = { el: box, trigger, cleanup() { document.removeEventListener('pointerdown', outside, true); document.removeEventListener('keydown', onKey, true); } };
        wire(box);
    }
    // Image ▾: upload · free photo library (host modal) · by URL
    function insertImageUrl(src, { alt = '', title = null } = {}) {
        if (!src) return false;
        return insertImageNode({ src, alt: alt || '', title: title || null });
    }
    function openImagePrompt(trigger, { onLibrary = null } = {}) {
        if (!trigger) return;
        openPop(trigger, `<p class="doc-pop-title">Insert image</p>
            <div class="doc-pop-list">
                <button type="button" class="doc-pop-item" data-pop-upload><i class="fa-solid fa-upload"></i>Upload from computer…</button>
                ${onLibrary ? '<button type="button" class="doc-pop-item" data-pop-library><i class="fa-solid fa-images"></i>Free photo library…</button>' : ''}
            </div>
            <p class="doc-pop-title" style="margin-top:8px">By URL</p>
            <input type="text" inputmode="url" data-pop-url placeholder="https://…/picture.jpg" aria-label="Image link" autocomplete="off" spellcheck="false">
            <p class="doc-pop-err" data-pop-err hidden>Use a link that starts with https:// and points to an image.</p>
            <div class="doc-pop-row"><button type="button" class="doc-primary" data-pop-apply>Insert</button></div>`, (box) => {
            const input = box.querySelector('[data-pop-url]'), err = box.querySelector('[data-pop-err]');
            box.querySelector('[data-pop-upload]').addEventListener('click', () => { closePop(); fileInput.click(); });
            box.querySelector('[data-pop-library]')?.addEventListener('click', () => { closePop(); onLibrary(); });
            const go = () => {
                const url = input.value.trim();
                if (!/^https:\/\/\S+$/i.test(url)) { err.hidden = false; input.focus(); return; }
                const probe = new window.Image();
                probe.onload = () => { closePop(); insertImageUrl(url); };
                probe.onerror = () => { err.hidden = false; input.focus(); };
                probe.src = url;
            };
            box.querySelector('[data-pop-apply]').addEventListener('click', go);
            input.addEventListener('keydown', (e) => { if (e.key === 'Enter') { e.preventDefault(); go(); } });
            input.addEventListener('input', () => { err.hidden = true; });
            input.focus();
        });
    }

    function openVideoPrompt(trigger) {
        if (!trigger) return;
        openPop(trigger, `<p class="doc-pop-title">Insert video</p>
            <input type="text" inputmode="url" data-pop-url placeholder="YouTube, Vimeo or Google Drive link" aria-label="Video link" autocomplete="off" spellcheck="false">
            <p class="doc-pop-err" data-pop-err hidden>Couldn't recognize that as a YouTube, Vimeo or Google Drive link.</p>
            <div class="doc-pop-row"><button type="button" class="doc-primary" data-pop-apply>Insert</button></div>`, (box) => {
            const input = box.querySelector('[data-pop-url]'), err = box.querySelector('[data-pop-err]');
            const go = () => {
                const src = parseVideoUrl ? parseVideoUrl(input.value) : null;
                if (!src) { err.hidden = false; input.focus(); return; }
                closePop();
                insertVideo(src);
            };
            box.querySelector('[data-pop-apply]').addEventListener('click', go);
            input.addEventListener('keydown', (e) => { if (e.key === 'Enter') { e.preventDefault(); go(); } });
            input.addEventListener('input', () => { err.hidden = true; });
            input.focus();
        });
    }

    return {
        editor,
        getHTML: () => toQuillHtml(editor.getHTML()),
        // replace the whole document without an undo step or a change event
        setHTML(next) {
            closeWidgetConfig({ refocus: false });
            editor.chain().command(({ tr }) => { tr.setMeta('addToHistory', false); return true; }).setContent(fromQuillHtml(next || ''), false).run();
        },
        isEmpty: () => editor.isEmpty,
        focus: () => editor.commands.focus(),
        undo: () => editor.chain().focus().undo().run(),
        redo: () => editor.chain().focus().redo().run(),
        canUndo: () => editor.can().undo(),
        canRedo: () => editor.can().redo(),
        insertVideo, insertAssignment, insertDivider, addPage, insertWidget,
        insertImageFile, insertImageUrl, openImagePrompt,
        pickImage: () => fileInput.click(),
        openVideoPrompt,
        openWidgetConfig: (wid) => openWidgetConfig(wid),
        isModalOpen: () => !!modal,
        widgets() {
            const out = [];
            editor.state.doc.descendants((node) => { if (node.type.name === 'lessonWidget') out.push({ id: node.attrs.wid, type: node.attrs.wtype, config: cleanConfig(node.attrs.wtype, node.attrs.config) }); });
            return out;
        },
        // inline data: images (pre-Storage docs / Word imports) — callers move them to Storage
        dataImages() {
            const out = [];
            editor.state.doc.descendants((node, pos) => { if (node.type.name === 'image' && /^data:/.test(node.attrs.src || '')) out.push({ pos, src: node.attrs.src }); });
            return out;
        },
        replaceImageSrc(oldSrc, newSrc) {
            const { tr } = editor.state;
            let changed = false;
            editor.state.doc.descendants((node, pos) => {
                if (node.type.name === 'image' && node.attrs.src === oldSrc) { tr.setNodeMarkup(pos, undefined, { ...node.attrs, src: newSrc }); changed = true; }
            });
            if (changed) { tr.setMeta('addToHistory', false); editor.view.dispatch(tr); }
            return changed;
        },
        destroy() { closePop(); closeWidgetConfig({ refocus: false }); try { editor.destroy(); } catch (e) { /* gone */ } },
    };
}

// ── student viewer (read-only, same schema as the editor) ────────────────
// Mounts the saved HTML into `element` with the editor's own extensions, so
// every mark / block renders exactly as the teacher sees it. Differences are
// only behavioural: not editable, videos are real players (mounted lazily as
// they scroll near, inside `lazyRoot`), assignment cards carry the host's
// status markup (renderAssignment(id, title) → innerHTML) and activity cards
// are read-only placeholders.
//   const v = await createDocumentViewer({ element, html, renderAssignment, lazyRoot });
//   v.refreshAssignments(); v.headings(); v.destroy();
// renderWidget(dom, { id, type, props }) — when given, activity blocks are
// painted by the host as answerable forms (worksheet mode, viewer.js).
export async function createDocumentViewer({ element, html = '', renderAssignment = null, lazyRoot = null, renderWidget = null } = {}) {
    ensureStyles();
    const T = await loadTiptap();
    element.innerHTML = '';
    const io = typeof IntersectionObserver === 'function'
        ? new IntersectionObserver((entries) => entries.forEach((e) => {
            if (!e.isIntersecting) return;
            io.unobserve(e.target);
            const mount = lazyMounts.get(e.target);
            lazyMounts.delete(e.target);
            if (mount) mount();
        }), { root: lazyRoot, rootMargin: '200px' })
        : null;
    const lazyMounts = new Map();
    const viewer = {
        renderAssignment,
        renderWidget,
        assignViews: new Set(),
        lazy(el, mount) {
            if (!io) { mount(); return; }
            lazyMounts.set(el, mount);
            io.observe(el);
        },
    };
    const wctx = { views: new Set(), keyOf: () => null, open() {}, ensureKey() {} };
    const editor = new T.Editor({
        element,
        editable: false,
        extensions: [...buildExtensions(T, { viewer }), buildWidgetNode(T, wctx, { viewer })],
        content: fromQuillHtml(html),
        editorProps: { attributes: { class: 'ql-editor doc-pm doc-view', role: 'document', 'aria-label': 'Lesson document' } },
    });
    return {
        editor,
        refreshAssignments() { viewer.assignViews.forEach((v) => v.repaint()); },
        headings: () => [...editor.view.dom.querySelectorAll('h1, h2, h3')],
        isEmpty: () => editor.isEmpty,
        destroy() { if (io) io.disconnect(); lazyMounts.clear(); try { editor.destroy(); } catch (e) { /* gone */ } },
    };
}
