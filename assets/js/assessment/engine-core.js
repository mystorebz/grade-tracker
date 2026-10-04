// assets/js/assessment/engine-core.js — pure assessment-engine logic.
// No DOM, no Firebase: imported by the browser modules AND by
// tests/assessment-mega.test.mjs (Node), so everything here must stay pure.

export const THEMES = Object.freeze(['standard', 'k5', 'strict']);
export const PDF_FIELD_TYPES = Object.freeze(['text', 'checkbox']);
export const MAX_PDF_FIELDS = 150;
export const VIOLATION_TYPES = Object.freeze(['tab_switch', 'window_blur', 'copy', 'paste', 'cut', 'context_menu', 'exit_fullscreen']);
export const K5_TEAMS = Object.freeze([
    { id: 'bumblebees', name: 'Bumblebees', emoji: '🐝', color: '#f59e0b' },
    { id: 'dolphins', name: 'Dolphins', emoji: '🐬', color: '#0ea5e9' },
    { id: 'tigers', name: 'Tigers', emoji: '🐯', color: '#f97316' },
    { id: 'owls', name: 'Owls', emoji: '🦉', color: '#8b5cf6' },
    { id: 'frogs', name: 'Frogs', emoji: '🐸', color: '#22c55e' },
    { id: 'unicorns', name: 'Unicorns', emoji: '🦄', color: '#ec4899' },
]);

export const normalizeTheme = (t) => (THEMES.includes(t) ? t : 'standard');

const clamp01 = (n) => Math.min(1, Math.max(0, n));
const round4 = (n) => Math.round(n * 10000) / 10000;

// Default field box sizes as a fraction of the page.
const FIELD_SIZE = { text: { w: 0.28, h: 0.032 }, checkbox: { w: 0.03, h: 0.022 } };

/**
 * A click on a rendered PDF page → a stored field with page-relative (0..1)
 * coordinates, so it lands on the same spot at any render size.
 * clickX/clickY are relative to the page's top-left, in CSS px.
 */
export function placeField({ id, page, type, clickX, clickY, pageWidth, pageHeight }) {
    if (!PDF_FIELD_TYPES.includes(type)) throw new Error(`Unknown field type: ${type}`);
    if (!(pageWidth > 0 && pageHeight > 0)) throw new Error('Page size must be positive.');
    if (!(Number.isInteger(page) && page >= 1)) throw new Error('Page must be a 1-based integer.');
    const { w, h } = FIELD_SIZE[type];
    // the click is the field's left edge, vertically centred
    const x = clamp01(clickX / pageWidth);
    const y = clamp01(clickY / pageHeight - h / 2);
    return { id, page, type, x: round4(Math.min(x, 1 - w)), y: round4(Math.min(y, 1 - h)), w, h };
}

/** Stored field → absolute CSS box on a page rendered at width×height. */
export function fieldToCss(field, width, height) {
    return {
        left: Math.round(field.x * width),
        top: Math.round(field.y * height),
        width: Math.round(field.w * width),
        height: Math.round(field.h * height),
    };
}

/** Sanitise a teacher-supplied field list before it is saved. */
export function validatePdfFields(fields, pageCount) {
    if (!Array.isArray(fields)) return [];
    const seen = new Set();
    return fields
        .filter((f) => f && typeof f.id === 'string' && /^[A-Za-z0-9_-]{1,40}$/.test(f.id) && !seen.has(f.id) && seen.add(f.id))
        .filter((f) => PDF_FIELD_TYPES.includes(f.type))
        .filter((f) => Number.isInteger(f.page) && f.page >= 1 && (!pageCount || f.page <= pageCount))
        .filter((f) => [f.x, f.y, f.w, f.h].every((n) => typeof n === 'number' && n >= 0 && n <= 1))
        .slice(0, MAX_PDF_FIELDS)
        .map(({ id, page, type, x, y, w, h, label }) => ({ id, page, type, x, y, w, h, ...(label ? { label: String(label).slice(0, 80) } : {}) }));
}

/** Draft/answer key for a PDF field (shared by drafts, review and submit). */
export const pdfFieldKey = (fieldId) => `pdf_${fieldId}`;

/** Target canvas size for compression: longest side ≤ maxDim, aspect kept. */
export function fitDimensions(width, height, maxDim = 1600) {
    if (!(width > 0 && height > 0)) return { width: 0, height: 0 };
    const scale = Math.min(1, maxDim / Math.max(width, height));
    return { width: Math.max(1, Math.round(width * scale)), height: Math.max(1, Math.round(height * scale)) };
}

/**
 * Time left for one student (ms, ≥ 0), or null when untimed.
 * startedAt: ms epoch the student opened the assessment.
 */
export function remainingMs({ timeLimitMin, extraMinutes = 0, startedAt, now = Date.now() }) {
    if (!(timeLimitMin > 0) || !(startedAt > 0)) return null;
    const end = startedAt + (timeLimitMin + Math.max(0, Number(extraMinutes) || 0)) * 60000;
    return Math.max(0, end - now);
}

export function formatClock(ms) {
    if (ms == null) return '';
    const s = Math.ceil(ms / 1000);
    const h = Math.floor(s / 3600), m = Math.floor((s % 3600) / 60), sec = s % 60;
    const pad = (n) => String(n).padStart(2, '0');
    return h ? `${h}:${pad(m)}:${pad(sec)}` : `${m}:${pad(sec)}`;
}

/** Which page events count as an integrity violation on a strict assessment. */
export function violationFor(eventType, { visibilityState } = {}) {
    if (eventType === 'visibilitychange') return visibilityState === 'hidden' ? 'tab_switch' : null;
    if (eventType === 'blur') return 'window_blur';
    if (eventType === 'contextmenu') return 'context_menu';
    if (['copy', 'paste', 'cut'].includes(eventType)) return eventType;
    if (eventType === 'fullscreenexit') return 'exit_fullscreen';
    return null;
}

/**
 * Pre-submit review rows: one per question + one per PDF field + show-work.
 * answers: { [key]: string } (draft-style field map).
 */
export function reviewSummary({ questions = [], pdfFields = [], answers = {}, showWork = false, workUploads = [] }) {
    const has = (v) => v != null && String(v).trim() !== '' && String(v) !== 'false';
    const items = [
        ...questions.map((q, i) => ({ key: q.id, label: `Q${i + 1}`, kind: 'question', answered: q.type === 'attachment_response' ? has(answers[q.id]) : has(answers[q.id]) })),
        ...pdfFields.filter((f) => f.type === 'text').map((f, i) => ({ key: pdfFieldKey(f.id), label: `P${f.page}·${i + 1}`, kind: 'pdf', answered: has(answers[pdfFieldKey(f.id)]) })),
    ];
    if (showWork) items.push({ key: 'work', label: 'Work', kind: 'work', answered: workUploads.length > 0 });
    const answered = items.filter((i) => i.answered).length;
    return { items, answered, total: items.length, unanswered: items.filter((i) => !i.answered).map((i) => i.label) };
}

/** Teacher force-collect: a saved draft → the submission payload saveSubmission writes. */
export function draftToSubmission({ questions = [], pdfFields = [], fields = {} }) {
    const responses = questions.map((q) => ({
        questionId: q.id,
        responseText: q.type === 'attachment_response' ? '' : String(fields[q.id] ?? '').trim(),
        attachmentUrl: null,
    }));
    const pdfAnswers = {};
    pdfFields.forEach((f) => {
        const v = fields[pdfFieldKey(f.id)];
        if (v != null && v !== '') pdfAnswers[f.id] = f.type === 'checkbox' ? v === 'true' : String(v);
    });
    let workUploads = [];
    try { workUploads = JSON.parse(fields.work_uploads || '[]'); } catch (e) { workUploads = []; }
    return {
        responses: questions.length ? responses : null,
        responseText: questions.length ? null : String(fields.responseText ?? '').trim(),
        linkUrl: questions.length ? null : (String(fields.linkUrl ?? '').trim() || null),
        pdfAnswers,
        workUploads: Array.isArray(workUploads) ? workUploads.filter((u) => u && typeof u.url === 'string').slice(0, 10) : [],
    };
}

/** Live control document defaults + merge (teacher writes, students read). */
export function normalizeControl(c) {
    const ctl = c || {};
    return {
        paused: ctl.paused === true,
        extraMinutes: Math.max(0, Number(ctl.extraMinutes) || 0),
        collectAt: Number(ctl.collectAt) > 0 ? Number(ctl.collectAt) : null,
        broadcast: ctl.broadcast && typeof ctl.broadcast.text === 'string'
            ? { id: String(ctl.broadcast.id || ''), text: ctl.broadcast.text.slice(0, 280), at: Number(ctl.broadcast.at) || 0 }
            : null,
    };
}
