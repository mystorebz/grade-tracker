// assets/js/assessment/pdf-worksheet.js — PDF "e-sign" worksheets (pdf.js)
//
// Teacher: mountPdfFieldEditor() renders the uploaded PDF; clicking a page
// drops a Text or Checkbox field there (page-relative x/y/w/h, engine-core
// placeField). Student: mountPdfAnswerSheet() renders the same PDF and
// overlays absolute-positioned inputs at the saved coordinates. Inputs carry
// data-question-id="pdf_{fieldId}" so drafts (assignment-drafts.js), the
// review screen and submit all treat them like any other answer.

import { placeField, fieldToCss, pdfFieldKey } from './engine-core.js';

const PDFJS_VERSION = '3.11.174';
const PDFJS_SRC = `https://cdnjs.cloudflare.com/ajax/libs/pdf.js/${PDFJS_VERSION}/pdf.min.js`;
const PDFJS_WORKER = `https://cdnjs.cloudflare.com/ajax/libs/pdf.js/${PDFJS_VERSION}/pdf.worker.min.js`;

let pdfjsPromise = null;
export function loadPdfJs() {
    if (window.pdfjsLib) return Promise.resolve(window.pdfjsLib);
    if (!pdfjsPromise) {
        pdfjsPromise = new Promise((resolve, reject) => {
            const s = document.createElement('script');
            s.src = PDFJS_SRC;
            s.onload = () => {
                window.pdfjsLib.GlobalWorkerOptions.workerSrc = PDFJS_WORKER;
                resolve(window.pdfjsLib);
            };
            s.onerror = () => { pdfjsPromise = null; reject(new Error('The PDF viewer could not load. Check your connection.')); };
            document.head.appendChild(s);
        });
    }
    return pdfjsPromise;
}

const CSS = `
.pdfw { display: flex; flex-direction: column; gap: 14px; }
.pdfw-page { position: relative; width: 100%; background: #fff; border: 1px solid #e2e8f0; border-radius: 10px; overflow: hidden; box-shadow: 0 1px 3px rgba(15,23,42,.06); }
.pdfw-page canvas { display: block; width: 100%; height: auto; }
.pdfw-layer { position: absolute; inset: 0; }
.pdfw-edit .pdfw-layer { cursor: crosshair; }
.pdfw-field { position: absolute; box-sizing: border-box; }
.pdfw-field input[type=text] { width: 100%; height: 100%; border: 1.5px solid #6366f1; background: rgba(238,242,255,.85); border-radius: 4px; padding: 0 6px; font: 600 clamp(10px, 1.6vw, 14px)/1 'DM Sans', sans-serif; color: #0f172a; outline: none; }
.pdfw-field input[type=text]:focus { border-color: #4338ca; background: #fff; box-shadow: 0 0 0 3px rgba(99,102,241,.25); }
.pdfw-field input[type=checkbox] { width: 100%; height: 100%; margin: 0; accent-color: #4f46e5; cursor: pointer; }
.pdfw-field input:disabled { border-color: #cbd5e1; background: rgba(241,245,249,.9); }
.pdfw-ghost { border: 1.5px dashed #0d9488; background: rgba(204,251,241,.55); border-radius: 4px; display: flex; align-items: center; justify-content: space-between; font: 800 10px/1 'DM Sans', sans-serif; color: #0f766e; padding: 0 4px; }
.pdfw-ghost button { border: 0; background: #0f766e; color: #fff; width: 16px; height: 16px; border-radius: 99px; font-size: 10px; line-height: 16px; cursor: pointer; padding: 0; flex: none; }
.pdfw-tools { display: flex; align-items: center; gap: 8px; flex-wrap: wrap; }
.pdfw-tool { font: 800 11.5px 'DM Sans', sans-serif; padding: 6px 12px; border-radius: 8px; border: 1px solid #e2e8f0; background: #fff; color: #334155; cursor: pointer; }
.pdfw-tool[aria-pressed=true] { background: #0f766e; color: #fff; border-color: #0f766e; }
.pdfw-note { font: 600 11.5px 'DM Sans', sans-serif; color: #64748b; }
.pdfw-loading { padding: 28px; text-align: center; font: 700 12.5px 'DM Sans', sans-serif; color: #94a3b8; }
`;
function injectCss() {
    if (document.getElementById('pdfw-css')) return;
    const s = document.createElement('style'); s.id = 'pdfw-css'; s.textContent = CSS; document.head.appendChild(s);
}

const esc = (v) => String(v ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#039;' }[c]));

// Renders every page into `host`; returns [{ page, el, layer }] and the page count.
async function renderPages(host, url, { maxPages = 20 } = {}) {
    const pdfjsLib = await loadPdfJs();
    const pdf = await pdfjsLib.getDocument({ url, withCredentials: false }).promise;
    const count = Math.min(pdf.numPages, maxPages);
    const pages = [];
    host.innerHTML = '';
    for (let n = 1; n <= count; n++) {
        const page = await pdf.getPage(n);
        const viewport = page.getViewport({ scale: 2 }); // crisp on hi-dpi; CSS scales it down
        const wrap = document.createElement('div');
        wrap.className = 'pdfw-page';
        wrap.dataset.page = String(n);
        const canvas = document.createElement('canvas');
        canvas.width = viewport.width; canvas.height = viewport.height;
        const layer = document.createElement('div');
        layer.className = 'pdfw-layer';
        wrap.append(canvas, layer);
        host.appendChild(wrap);
        await page.render({ canvasContext: canvas.getContext('2d'), viewport }).promise;
        pages.push({ page: n, el: wrap, layer });
    }
    return { pages, pageCount: pdf.numPages };
}

function positionField(node, field, layer) {
    const r = layer.getBoundingClientRect();
    const css = fieldToCss(field, r.width, r.height);
    Object.assign(node.style, { left: `${css.left}px`, top: `${css.top}px`, width: `${css.width}px`, height: `${css.height}px` });
}

function relayout(pages, nodes) {
    nodes.forEach(({ node, field }) => {
        const p = pages.find((x) => x.page === field.page);
        if (p) positionField(node, field, p.layer);
    });
}

// ── TEACHER ──────────────────────────────────────────────────────────────
export async function mountPdfFieldEditor({ host, url, fields = [], onChange }) {
    injectCss();
    host.innerHTML = `
        <div class="pdfw pdfw-edit">
            <div class="pdfw-tools">
                <span class="pdfw-note">Click on the page to place:</span>
                <button type="button" class="pdfw-tool" data-pdfw-tool="text" aria-pressed="true">Text box</button>
                <button type="button" class="pdfw-tool" data-pdfw-tool="checkbox" aria-pressed="false">Checkbox</button>
                <span class="pdfw-note" data-pdfw-count></span>
            </div>
            <div data-pdfw-pages><div class="pdfw-loading">Loading PDF…</div></div>
        </div>`;
    let tool = 'text';
    let list = fields.map((f) => ({ ...f }));
    let seq = list.reduce((m, f) => Math.max(m, parseInt(String(f.id).replace(/\D/g, ''), 10) || 0), 0);
    const pagesHost = host.querySelector('[data-pdfw-pages]');
    const countEl = host.querySelector('[data-pdfw-count]');
    let pages = [];
    let nodes = [];

    const emit = () => { countEl.textContent = `${list.length} field${list.length === 1 ? '' : 's'}`; onChange && onChange(list.map((f) => ({ ...f }))); };

    function draw() {
        nodes.forEach(({ node }) => node.remove());
        nodes = list.map((field) => {
            const p = pages.find((x) => x.page === field.page);
            if (!p) return null;
            const node = document.createElement('div');
            node.className = 'pdfw-field pdfw-ghost';
            node.innerHTML = `<span>${field.type === 'checkbox' ? '☑' : 'Aa'}</span><button type="button" title="Remove field" data-pdfw-remove="${esc(field.id)}">×</button>`;
            p.layer.appendChild(node);
            positionField(node, field, p.layer);
            return { node, field };
        }).filter(Boolean);
    }

    host.addEventListener('click', (e) => {
        const t = e.target.closest('[data-pdfw-tool]');
        if (t) {
            tool = t.dataset.pdfwTool;
            host.querySelectorAll('[data-pdfw-tool]').forEach((b) => b.setAttribute('aria-pressed', String(b === t)));
            return;
        }
        const rm = e.target.closest('[data-pdfw-remove]');
        if (rm) { list = list.filter((f) => f.id !== rm.dataset.pdfwRemove); draw(); emit(); return; }
        const layer = e.target.closest('.pdfw-layer');
        if (!layer || e.target.closest('.pdfw-field')) return;
        const r = layer.getBoundingClientRect();
        const page = Number(layer.parentElement.dataset.page);
        list.push(placeField({ id: `f${++seq}`, page, type: tool, clickX: e.clientX - r.left, clickY: e.clientY - r.top, pageWidth: r.width, pageHeight: r.height }));
        draw(); emit();
    });

    const onResize = () => relayout(pages, nodes);
    window.addEventListener('resize', onResize);
    try {
        const out = await renderPages(pagesHost, url);
        pages = out.pages;
        draw(); emit();
        return { pageCount: out.pageCount, destroy() { window.removeEventListener('resize', onResize); host.innerHTML = ''; } };
    } catch (e) {
        pagesHost.innerHTML = `<div class="pdfw-loading">${esc(e.message || 'Could not open this PDF.')}</div>`;
        return { pageCount: 0, destroy() { window.removeEventListener('resize', onResize); host.innerHTML = ''; } };
    }
}

// ── STUDENT / VIEWER ─────────────────────────────────────────────────────
export async function mountPdfAnswerSheet({ host, url, fields = [], answers = {}, disabled = false }) {
    injectCss();
    host.innerHTML = '<div class="pdfw"><div class="pdfw-loading">Loading worksheet…</div></div>';
    const wrap = host.firstElementChild;
    let nodes = [];
    let pages = [];
    const onResize = () => relayout(pages, nodes);
    try {
        const out = await renderPages(wrap, url);
        pages = out.pages;
        nodes = fields.map((field, i) => {
            const p = pages.find((x) => x.page === field.page);
            if (!p) return null;
            const node = document.createElement('div');
            node.className = 'pdfw-field';
            const key = pdfFieldKey(field.id);
            const saved = answers[field.id];
            node.innerHTML = field.type === 'checkbox'
                ? `<input type="checkbox" data-question-id="${esc(key)}" data-pdf-field="${esc(field.id)}" aria-label="Checkbox ${i + 1} on page ${field.page}" ${saved === true ? 'checked' : ''} ${disabled ? 'disabled' : ''}>`
                : `<input type="text" data-question-id="${esc(key)}" data-pdf-field="${esc(field.id)}" aria-label="${esc(field.label || `Answer ${i + 1} on page ${field.page}`)}" value="${esc(typeof saved === 'string' ? saved : '')}" maxlength="500" autocomplete="off" ${disabled ? 'disabled' : ''}>`;
            p.layer.appendChild(node);
            positionField(node, field, p.layer);
            return { node, field };
        }).filter(Boolean);
        window.addEventListener('resize', onResize);
    } catch (e) {
        wrap.innerHTML = `<div class="pdfw-loading">${esc(e.message || 'Could not open this worksheet.')}</div>`;
    }
    return { destroy() { window.removeEventListener('resize', onResize); } };
}

/** Current answers from a mounted sheet: { fieldId: string | boolean }. */
export function collectPdfAnswers(root) {
    const out = {};
    root.querySelectorAll('input[data-pdf-field]').forEach((el) => {
        if (el.type === 'checkbox') out[el.dataset.pdfField] = el.checked;
        else if (el.value.trim()) out[el.dataset.pdfField] = el.value.trim().slice(0, 500);
    });
    return out;
}
