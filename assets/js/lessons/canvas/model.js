// assets/js/lessons/canvas/model.js — Lesson canvas scene graph (schema v3)
//
// Pure module: no DOM, no Firebase, no imports. Loaded by the browser (editor,
// presenter, student viewer via lessons.js / renderer.js) AND by Node
// (functions/migrations/03-lesson-canvas-v3.js), so keep it dependency-free.
//
// Storage (contentVersion 3):
//   lessons/{id}/content/main      { schemaVersion: 3, stage: {w,h}, theme, slideOrder: [slideId…], updatedAt }
//   lessons/{id}/slides/{slideId}  slide record (below), one doc per slide
//   lessons/{id}/doc/main          Document-format lessons: { html, blockId, updatedAt }
//
// Slide record:
//   { id, kind: 'canvas' | 'board' | 'legacy', background, notes, objects: [object…],
//     board?: {…collaborative-board fields}, legacy?: {…untouched v2 slide}, extra?: {…v2 slide fields} }
//
// Object record (stage units, origin top-left of the UNROTATED box):
//   { id, type, x, y, w, h, rotation, z, opacity, locked, hidden, name, props: {…} }
//   rotation: degrees clockwise about the box centre; z: fractional-index key
//   (render order = ascending z); props.contentScale: scale applied to the
//   object's inner DOM (legacy v2 content was authored on an 860px-wide stage).

export const SCHEMA_VERSION = 3;
export const STAGE = Object.freeze({ w: 1600, h: 900 });
export const LEGACY_REF_WIDTH = 860;                                   // v2 editor stage max width (px)
export const LEGACY_CONTENT_SCALE = Math.round((STAGE.w / LEGACY_REF_WIDTH) * 10000) / 10000;
export const MIN_SIZE = 8;
export const MAX_OBJECTS_PER_SLIDE = 200;
export const MAX_SLIDE_BYTES = 900_000;                                // stay under Firestore's 1 MiB doc limit

export const OBJECT_TYPES = Object.freeze(['text', 'image', 'video', 'embed', 'shape', 'line', 'interactive_prompt', 'interactive', 'assignment', 'group',
    // Phase 4 step 4: free-floating student widgets (tools/interactive.js)
    'poll', 'quiz', 'open_response', 'board']);
// Widgets whose student responses live in live_sessions/{id}/responses.
export const WIDGET_TYPES = Object.freeze(['poll', 'quiz', 'open_response', 'board']);
export const SLIDE_KINDS = Object.freeze(['canvas', 'board', 'legacy']);

export const THEMES = Object.freeze({
    general: { accent: '#2563eb', accentSoft: '#eef4ff' },
    science: { accent: '#0d9488', accentSoft: '#f0fdfa' },
    math: { accent: '#7c3aed', accentSoft: '#f5f3ff' },
    language_arts: { accent: '#b45309', accentSoft: '#fffbeb' },
    history: { accent: '#b91c1c', accentSoft: '#fef2f2' },
    art: { accent: '#db2777', accentSoft: '#fdf2f8' },
});
export function themeFor(name) { return THEMES[name] || THEMES.general; }

// v2 default block sizes (percent of stage) — mirrors lessons.js BLOCK_DEFAULT_SIZE
const V2_DEFAULT_SIZE = {
    text: { w: 60, h: 16 }, image: { w: 50, h: 38 }, video: { w: 55, h: 34 },
    interactive_prompt: { w: 65, h: 26 }, assignment: { w: 60, h: 18 },
};

// ── FRACTIONAL INDEXING (base-62 keys; port of the `fractional-indexing` algorithm) ──
const DIGITS = '0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz';
const SMALLEST_INTEGER = 'A' + '0'.repeat(26);

function midpoint(a, b) {
    if (b !== null && a >= b) throw new Error(`${a} >= ${b}`);
    if (a.slice(-1) === '0' || (b && b.slice(-1) === '0')) throw new Error('trailing zero');
    if (b) {
        let n = 0;
        while ((a[n] || '0') === b[n]) n++;
        if (n > 0) return b.slice(0, n) + midpoint(a.slice(n), b.slice(n));
    }
    const digitA = a ? DIGITS.indexOf(a[0]) : 0;
    const digitB = b !== null ? DIGITS.indexOf(b[0]) : DIGITS.length;
    if (digitB - digitA > 1) return DIGITS[Math.round(0.5 * (digitA + digitB))];
    if (b && b.length > 1) return b.slice(0, 1);
    return DIGITS[digitA] + midpoint(a.slice(1), null);
}
function integerLength(head) {
    if (head >= 'a' && head <= 'z') return head.charCodeAt(0) - 97 + 2;
    if (head >= 'A' && head <= 'Z') return 90 - head.charCodeAt(0) + 2;
    throw new Error(`invalid order key head: ${head}`);
}
function integerPart(key) {
    const len = integerLength(key[0]);
    if (len > key.length) throw new Error(`invalid order key: ${key}`);
    return key.slice(0, len);
}
function validateOrderKey(key) {
    if (key === SMALLEST_INTEGER) throw new Error(`invalid order key: ${key}`);
    const i = integerPart(key);
    if (key.slice(i.length).slice(-1) === '0') throw new Error(`invalid order key: ${key}`);
}
function incrementInteger(x) {
    const [head, ...digs] = x.split('');
    let carry = true;
    for (let i = digs.length - 1; carry && i >= 0; i--) {
        const d = DIGITS.indexOf(digs[i]) + 1;
        if (d === DIGITS.length) digs[i] = '0'; else { digs[i] = DIGITS[d]; carry = false; }
    }
    if (!carry) return head + digs.join('');
    if (head === 'Z') return 'a0';
    if (head === 'z') return null;
    const h = String.fromCharCode(head.charCodeAt(0) + 1);
    if (h > 'a') digs.push('0'); else digs.pop();
    return h + digs.join('');
}
function decrementInteger(x) {
    const [head, ...digs] = x.split('');
    let borrow = true;
    for (let i = digs.length - 1; borrow && i >= 0; i--) {
        const d = DIGITS.indexOf(digs[i]) - 1;
        if (d === -1) digs[i] = 'z'; else { digs[i] = DIGITS[d]; borrow = false; }
    }
    if (!borrow) return head + digs.join('');
    if (head === 'a') return 'Zz';
    if (head === 'A') return null;
    const h = String.fromCharCode(head.charCodeAt(0) - 1);
    if (h < 'Z') digs.push('z'); else digs.pop();
    return h + digs.join('');
}

// A key strictly between a and b (either may be null = open end).
export function generateKeyBetween(a, b) {
    if (a !== null) validateOrderKey(a);
    if (b !== null) validateOrderKey(b);
    if (a !== null && b !== null && a >= b) throw new Error(`${a} >= ${b}`);
    if (a === null) {
        if (b === null) return 'a0';
        const ib = integerPart(b);
        const fb = b.slice(ib.length);
        if (ib === SMALLEST_INTEGER) return ib + midpoint('', fb);
        if (ib < b) return ib;
        const res = decrementInteger(ib);
        if (res === null) throw new Error('cannot decrement any more');
        return res;
    }
    if (b === null) {
        const ia = integerPart(a);
        const i = incrementInteger(ia);
        return i === null ? ia + midpoint(a.slice(ia.length), null) : i;
    }
    const ia = integerPart(a), fa = a.slice(ia.length);
    const ib = integerPart(b), fb = b.slice(ib.length);
    if (ia === ib) return ia + midpoint(fa, fb);
    const i = incrementInteger(ia);
    if (i === null) throw new Error('cannot increment any more');
    if (i < b) return i;
    return ia + midpoint(fa, null);
}

// n ascending keys strictly between a and b.
export function generateNKeysBetween(a, b, n) {
    if (n <= 0) return [];
    if (n === 1) return [generateKeyBetween(a, b)];
    if (b === null) {
        let c = generateKeyBetween(a, b);
        const out = [c];
        for (let i = 0; i < n - 1; i++) { c = generateKeyBetween(c, b); out.push(c); }
        return out;
    }
    if (a === null) {
        let c = generateKeyBetween(a, b);
        const out = [c];
        for (let i = 0; i < n - 1; i++) { c = generateKeyBetween(a, c); out.push(c); }
        return out.reverse();
    }
    const mid = Math.floor(n / 2);
    const c = generateKeyBetween(a, b);
    return [...generateNKeysBetween(a, c, mid), c, ...generateNKeysBetween(c, b, n - mid - 1)];
}

export function compareZ(a, b) {
    const za = a.z || '', zb = b.z || '';
    return za < zb ? -1 : za > zb ? 1 : 0;
}
export function sortByZ(objects) { return [...(objects || [])].sort(compareZ); }
export function keyAbove(objects) { const s = sortByZ(objects); return generateKeyBetween(s.length ? s[s.length - 1].z : null, null); }
export function keyBelow(objects) { const s = sortByZ(objects); return generateKeyBetween(null, s.length ? s[0].z : null); }

// ── IDS & FACTORIES ───────────────────────────────────────────────────────
const rnd = () => Math.random().toString(36).slice(2, 8);
export function newObjectId() { return `ob_${Date.now().toString(36)}_${rnd()}`; }
export function newSlideId() { return `slide_${Date.now().toString(36)}_${rnd()}`; }

const DEFAULT_OBJECT_SIZE = {
    text: { w: 960, h: 144 }, image: { w: 800, h: 450 }, video: { w: 880, h: 495 }, embed: { w: 880, h: 495 },
    shape: { w: 320, h: 320 }, line: { w: 480, h: 48 }, interactive_prompt: { w: 1040, h: 234 },
    interactive: { w: 1040, h: 400 }, assignment: { w: 960, h: 162 }, group: { w: 100, h: 100 },
    poll: { w: 760, h: 560 }, quiz: { w: 760, h: 600 }, open_response: { w: 860, h: 440 }, board: { w: 1280, h: 680 },
};
const optId = () => `opt_${Math.random().toString(36).slice(2, 8)}`;
const DEFAULT_PROPS = {
    text: () => ({ html: '', contentScale: 1 }),
    // media: { storagePath, url, w, h } (tools/image.js); imageUrl mirrors media.url for v2-era readers.
    // crop: fractions of the source image { x, y, w, h }; flipH / flipV; credit: stock-photo attribution.
    image: () => ({ imageUrl: '', imageAlt: '', caption: '', media: null, crop: null, flipH: false, flipV: false, credit: null, contentScale: 1 }),
    video: () => ({ provider: null, mediaUrl: '', embedUrl: '', caption: '', contentScale: 1 }),
    embed: () => ({ embedUrl: '', contentScale: 1 }),
    // shape kinds: rect | roundRect | ellipse | triangle | diamond | star | speech (tools/shape.js)
    shape: () => ({ kind: 'rect', fill: '#dbeafe', stroke: { color: '#2563eb', width: 3 }, radius: 0, contentScale: 1 }),
    // line endpoints are FRACTIONS (0..1) of the object box, so moving/resizing
    // the box carries the line with it; heads: none | arrow | open | circle (tools/line.js)
    line: () => ({ x1: 0, y1: 0.5, x2: 1, y2: 0.5, stroke: { color: '#0d1f35', width: 6, dash: false }, startHead: 'none', endHead: 'none', contentScale: 1 }),
    interactive_prompt: () => ({ promptText: '', promptKind: 'short_answer', choices: [], contentScale: 1 }),
    interactive: () => ({ kind: 'poll', config: {}, showResults: 'live', contentScale: 1 }),
    assignment: () => ({ prompt: '', linkedAssignmentId: null, contentScale: 1 }),
    group: () => ({ children: [] }),
    // Widgets: contentScale 2 → the HTML inside is laid out at half the stage size.
    // Quiz correct answers are NEVER here: work_answer_keys/{lessonId}_{objectId}.
    poll: () => ({ question: '', options: [{ id: optId(), text: '' }, { id: optId(), text: '' }], multiple: false, contentScale: 2 }),
    quiz: () => ({ question: '', options: [{ id: optId(), text: '' }, { id: optId(), text: '' }, { id: optId(), text: '' }], points: 1, contentScale: 2 }),
    open_response: () => ({ prompt: '', mode: 'short', maxLength: 500, contentScale: 2 }),
    board: () => ({ prompt: '', noteColor: '#fef3c7', contentScale: 2 }),
};
export { optId as newOptionId };

// Centred on the stage; steps down-right (like Slides' paste offset) while an
// object already sits at that exact spot, so repeated inserts don't hide each other.
function cascadePosition(size, siblings) {
    const step = 40;
    let x = Math.round((STAGE.w - size.w) / 2), y = Math.round((STAGE.h - size.h) / 2);
    const taken = (px, py) => (siblings || []).some((o) => o && Math.abs(o.x - px) < 4 && Math.abs(o.y - py) < 4);
    for (let i = 0; i < 8 && taken(x, y); i++) {
        if (x + step + size.w > STAGE.w || y + step + size.h > STAGE.h) break;
        x += step; y += step;
    }
    return { x, y };
}

// New object centred on the stage, above everything already on the slide.
export function createObject(type, overrides = {}, siblings = []) {
    if (!OBJECT_TYPES.includes(type)) throw new Error(`Unknown object type: ${type}`);
    const size = DEFAULT_OBJECT_SIZE[type];
    const base = {
        id: newObjectId(), type,
        ...cascadePosition(size, siblings), w: size.w, h: size.h,
        rotation: 0, z: keyAbove(siblings), opacity: 1, locked: false, hidden: false, name: '',
        props: DEFAULT_PROPS[type](),
    };
    return normalizeObject({ ...base, ...overrides, props: { ...base.props, ...(overrides.props || {}) } });
}

export function createSlide(overrides = {}) {
    return { id: newSlideId(), kind: 'canvas', background: null, notes: '', objects: [], ...overrides };
}

// ── VALIDATION ────────────────────────────────────────────────────────────
const isNum = (v) => typeof v === 'number' && Number.isFinite(v);
const round3 = (v) => Math.round(v * 1000) / 1000;

export function normalizeRotation(deg) {
    if (!isNum(deg)) return 0;
    const r = deg % 360;
    return round3(r < 0 ? r + 360 : r);
}

// Clamp/repair an object in place-safe fashion (returns a new object).
export function normalizeObject(obj) {
    const o = { ...obj };
    o.w = Math.max(MIN_SIZE, isNum(o.w) ? round3(o.w) : MIN_SIZE);
    o.h = Math.max(MIN_SIZE, isNum(o.h) ? round3(o.h) : MIN_SIZE);
    o.x = isNum(o.x) ? round3(o.x) : 0;
    o.y = isNum(o.y) ? round3(o.y) : 0;
    o.rotation = normalizeRotation(o.rotation);
    o.opacity = isNum(o.opacity) ? Math.min(1, Math.max(0, o.opacity)) : 1;
    o.locked = !!o.locked;
    o.hidden = !!o.hidden;
    if (typeof o.z !== 'string' || !o.z) o.z = 'a0';
    o.props = o.props && typeof o.props === 'object' ? o.props : {};
    return o;
}

export function validateObject(o) {
    const errors = [];
    if (!o || typeof o !== 'object') return { ok: false, errors: ['not an object'] };
    if (typeof o.id !== 'string' || !o.id) errors.push('id missing');
    if (!OBJECT_TYPES.includes(o.type)) errors.push(`unknown type "${o.type}"`);
    ['x', 'y', 'w', 'h', 'rotation'].forEach((k) => { if (!isNum(o[k])) errors.push(`${k} not a number`); });
    if (isNum(o.w) && o.w < MIN_SIZE) errors.push(`w < ${MIN_SIZE}`);
    if (isNum(o.h) && o.h < MIN_SIZE) errors.push(`h < ${MIN_SIZE}`);
    if (isNum(o.rotation) && (o.rotation < 0 || o.rotation >= 360)) errors.push('rotation out of [0,360)');
    if (typeof o.z !== 'string' || !o.z) errors.push('z missing');
    else { try { validateOrderKey(o.z); } catch (e) { errors.push(`z invalid (${o.z})`); } }
    if (!o.props || typeof o.props !== 'object') errors.push('props missing');
    return { ok: errors.length === 0, errors };
}

export function validateSlide(s) {
    const errors = [];
    if (!s || typeof s !== 'object') return { ok: false, errors: ['not a slide'] };
    if (typeof s.id !== 'string' || !s.id) errors.push('id missing');
    if (!SLIDE_KINDS.includes(s.kind)) errors.push(`unknown kind "${s.kind}"`);
    if (!Array.isArray(s.objects)) errors.push('objects not an array');
    else {
        if (s.objects.length > MAX_OBJECTS_PER_SLIDE) errors.push(`more than ${MAX_OBJECTS_PER_SLIDE} objects`);
        const ids = new Set(), zs = new Set();
        s.objects.forEach((o, i) => {
            const v = validateObject(o);
            v.errors.forEach((e) => errors.push(`objects[${i}] ${e}`));
            if (ids.has(o.id)) errors.push(`duplicate object id ${o.id}`);
            if (zs.has(o.z)) errors.push(`duplicate z ${o.z}`);
            ids.add(o.id); zs.add(o.z);
        });
    }
    const bytes = approxBytes(s);
    if (bytes > MAX_SLIDE_BYTES) errors.push(`slide too large (~${Math.round(bytes / 1024)} KB)`);
    return { ok: errors.length === 0, errors };
}

export function approxBytes(v) {
    const json = JSON.stringify(v ?? null);
    let n = 0;
    for (let i = 0; i < json.length; i++) { const c = json.charCodeAt(i); n += c < 0x80 ? 1 : c < 0x800 ? 2 : 3; }
    return n;
}

// Stable fingerprint for change detection (ignores updatedAt / migration tags).
export function slideFingerprint(slide) {
    const { updatedAt, _mig03, ...rest } = slide || {};
    return stableStringify(rest);
}

// JSON with object keys sorted at every level (Firestore returns map keys in
// its own order, so plain JSON.stringify would see false differences).
export function stableStringify(v) {
    if (v === null || typeof v !== 'object') return JSON.stringify(v === undefined ? null : v);
    if (Array.isArray(v)) return `[${v.map(stableStringify).join(',')}]`;
    return `{${Object.keys(v).filter((k) => v[k] !== undefined).sort().map((k) => `${JSON.stringify(k)}:${stableStringify(v[k])}`).join(',')}}`;
}

// ── v2 ⇄ v3 CONVERSION (lossless round trip) ──────────────────────────────
const pctToX = (p) => round3((p / 100) * STAGE.w);
const pctToY = (p) => round3((p / 100) * STAGE.h);
const xToPct = (u) => round3((u / STAGE.w) * 100);
const yToPct = (u) => round3((u / STAGE.h) * 100);
const V3_BLOCK_KEYS = ['rotation', 'z', 'opacity', 'locked', 'hidden', 'name'];

// Backfill x/y/w/h (percent) like lessons.js ensureBlockLayout() for blocks saved without layout.
function withV2Layout(blocks) {
    let cursorY = 6;
    return blocks.map((b) => {
        if (isNum(b.x) && isNum(b.y) && isNum(b.w) && isNum(b.h)) return b;
        const size = V2_DEFAULT_SIZE[b.type] || V2_DEFAULT_SIZE.text;
        const y = Math.min(cursorY, Math.max(0, 100 - size.h - 2));
        cursorY = y + size.h + 3;
        return { ...b, x: 8, y, w: size.w, h: size.h };
    });
}

export function v2BlockToV3Object(block, z) {
    const { id, type, x, y, w, h, rotation, z: oldZ, opacity, locked, hidden, name, ...props } = block;
    return normalizeObject({
        id: id || newObjectId(), type: OBJECT_TYPES.includes(type) ? type : 'text',
        x: pctToX(x), y: pctToY(y), w: pctToX(w), h: pctToY(h),
        rotation: rotation || 0, z: (typeof oldZ === 'string' && oldZ) ? oldZ : z,
        opacity: isNum(opacity) ? opacity : 1, locked: !!locked, hidden: !!hidden, name: name || '',
        props: { ...props, contentScale: isNum(props.contentScale) ? props.contentScale : LEGACY_CONTENT_SCALE, ...(OBJECT_TYPES.includes(type) ? {} : { _v2Type: type }) },
    });
}

export function v3ObjectToV2Block(obj) {
    const { contentScale, _v2Type, ...props } = obj.props || {};
    const block = {
        ...props, id: obj.id, type: _v2Type || obj.type,
        x: xToPct(obj.x), y: yToPct(obj.y), w: xToPct(obj.w), h: yToPct(obj.h),
        contentScale: isNum(contentScale) ? contentScale : LEGACY_CONTENT_SCALE,
    };
    V3_BLOCK_KEYS.forEach((k) => { if (obj[k] !== undefined) block[k] = obj[k]; });
    return block;
}

export function v2SlideToV3(slide) {
    if (slide && slide.type === 'blank') {
        const { id, type, blocks, ...extra } = slide;
        const laid = withV2Layout(Array.isArray(blocks) ? blocks : []);
        const keys = generateNKeysBetween(null, null, laid.length);
        const used = new Set();
        const objects = laid.map((b, i) => {
            let o = v2BlockToV3Object(b, keys[i]);
            if (used.has(o.z)) o = { ...o, z: keys[i] };        // repair duplicate stored z
            used.add(o.z);
            return o;
        });
        return { id: id || newSlideId(), kind: 'canvas', background: null, notes: '', objects, ...(Object.keys(extra).length ? { extra } : {}) };
    }
    if (slide && slide.type === 'collaborative_board') {
        const { id, type, ...board } = slide;
        return { id: id || newSlideId(), kind: 'board', background: null, notes: '', objects: [], board };
    }
    // any other (pre-redesign) slide type: carried verbatim; readers migrate it on load as before
    return { id: (slide && slide.id) || newSlideId(), kind: 'legacy', background: null, notes: '', objects: [], legacy: slide || {} };
}

export function v3SlideToV2(s) {
    if (s.kind === 'canvas') return { ...(s.extra || {}), id: s.id, type: 'blank', blocks: sortByZ(s.objects).map(v3ObjectToV2Block) };
    if (s.kind === 'board') return { ...(s.board || {}), id: s.id, type: 'collaborative_board' };
    return { ...(s.legacy || {}), id: s.id };
}

// v2 lesson payload → v3 docs. format: 'slides' | 'document'.
export function v2ToV3Content(v2Slides, { theme = 'general', format = 'slides' } = {}) {
    const slides = Array.isArray(v2Slides) ? v2Slides : [];
    if (format === 'document') {
        const block = slides.find((s) => s && s.type === 'richtext') || slides[0] || null;
        return {
            content: { schemaVersion: SCHEMA_VERSION, stage: { ...STAGE }, theme: theme || 'general', slideOrder: [] },
            slides: [],
            doc: { html: (block && block.contentHtml) || '', blockId: (block && block.id) || 'slide_doc' },
        };
    }
    const v3 = slides.map(v2SlideToV3);
    return {
        content: { schemaVersion: SCHEMA_VERSION, stage: { ...STAGE }, theme: theme || 'general', slideOrder: v3.map((s) => s.id) },
        slides: v3,
        doc: null,
    };
}

// v3 docs → v2 slides array (for the current editor and v2-era code paths).
export function v3ToV2Slides({ content, slidesById, doc, format = 'slides' }) {
    if (format === 'document') {
        return [{ id: (doc && doc.blockId) || 'slide_doc', type: 'richtext', contentHtml: (doc && doc.html) || '' }];
    }
    const order = (content && Array.isArray(content.slideOrder)) ? content.slideOrder : [];
    const get = (id) => (slidesById instanceof Map ? slidesById.get(id) : slidesById && slidesById[id]);
    return order.map(get).filter(Boolean).map(v3SlideToV2);
}
