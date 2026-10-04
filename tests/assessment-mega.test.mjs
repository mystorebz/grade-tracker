// tests/assessment-mega.test.mjs — assessment engine checks (no emulator, no network)
//   node --test tests/assessment-mega.test.mjs
// Covers: PDF field coordinate placement/saving, tab-switch & integrity logging
// rules, timer maths, pre-submit review, force-collect payloads, and the
// Realtime Database rules for assessmentLive (static rule analysis).

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, writeFileSync, mkdtempSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { tmpdir } from 'node:os';
import { fileURLToPath, pathToFileURL } from 'node:url';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
// engine-core.js is an ES module served to browsers; the repo's package.json
// has no "type", so load a temp .mjs copy for Node.
const tmp = mkdtempSync(join(tmpdir(), 'gt-engine-'));
const corePath = join(tmp, 'engine-core.mjs');
writeFileSync(corePath, readFileSync(join(root, 'assets/js/assessment/engine-core.js'), 'utf8'));
const core = await import(pathToFileURL(corePath).href);
const rules = JSON.parse(readFileSync(join(root, 'database.rules.json'), 'utf8')).rules;

// ── PDF coordinates ──────────────────────────────────────────────────────
test('placeField stores page-relative coordinates', () => {
    const f = core.placeField({ id: 'f1', page: 2, type: 'text', clickX: 400, clickY: 500, pageWidth: 800, pageHeight: 1000 });
    assert.equal(f.page, 2);
    assert.equal(f.x, 0.5);
    assert.equal(f.y, 0.484); // 0.5 - h/2 (h = 0.032)
    assert.equal(f.w, 0.28);
    assert.equal(f.type, 'text');
});

test('the same field lands on the same spot at any render size', () => {
    const f = core.placeField({ id: 'f1', page: 1, type: 'checkbox', clickX: 120, clickY: 300, pageWidth: 600, pageHeight: 800 });
    const small = core.fieldToCss(f, 300, 400);
    const big = core.fieldToCss(f, 1200, 1600);
    assert.ok(Math.abs(big.left - small.left * 4) <= 2);
    assert.ok(Math.abs(big.top - small.top * 4) <= 2);
});

test('fields are clamped inside the page', () => {
    const f = core.placeField({ id: 'f9', page: 1, type: 'text', clickX: 790, clickY: 999, pageWidth: 800, pageHeight: 1000 });
    assert.ok(f.x + f.w <= 1 && f.y + f.h <= 1 && f.x >= 0 && f.y >= 0);
});

test('placeField rejects bad input', () => {
    assert.throws(() => core.placeField({ id: 'x', page: 1, type: 'signature', clickX: 1, clickY: 1, pageWidth: 10, pageHeight: 10 }));
    assert.throws(() => core.placeField({ id: 'x', page: 0, type: 'text', clickX: 1, clickY: 1, pageWidth: 10, pageHeight: 10 }));
    assert.throws(() => core.placeField({ id: 'x', page: 1, type: 'text', clickX: 1, clickY: 1, pageWidth: 0, pageHeight: 10 }));
});

test('validatePdfFields keeps only clean, unique, in-range fields', () => {
    const good = core.placeField({ id: 'f1', page: 1, type: 'text', clickX: 10, clickY: 10, pageWidth: 100, pageHeight: 100 });
    const out = core.validatePdfFields([
        good,
        { ...good },                                   // duplicate id
        { ...good, id: 'f2', page: 9 },                // beyond page count
        { ...good, id: 'f3', x: 1.5 },                 // off page
        { ...good, id: 'bad id!' },                    // invalid id
        { ...good, id: 'f4', type: 'checkbox', extra: 'dropped' },
    ], 3);
    assert.deepEqual(out.map((f) => f.id), ['f1', 'f4']);
    assert.equal('extra' in out[1], false);
});

// ── Tab-switch / integrity logging ───────────────────────────────────────
test('violationFor maps page events to logged violations', () => {
    assert.equal(core.violationFor('visibilitychange', { visibilityState: 'hidden' }), 'tab_switch');
    assert.equal(core.violationFor('visibilitychange', { visibilityState: 'visible' }), null);
    assert.equal(core.violationFor('copy'), 'copy');
    assert.equal(core.violationFor('paste'), 'paste');
    assert.equal(core.violationFor('contextmenu'), 'context_menu');
    assert.equal(core.violationFor('scroll'), null);
});

test('every violation type the client can log is allowed by the RTDB rule', () => {
    const v = rules.assessmentLive.$schoolId.$assignmentId.violations.$studentId.$violationId;
    const pattern = /matches\(\/(.+)\/\)/.exec(v.type['.validate'])[1];
    const re = new RegExp(pattern);
    core.VIOLATION_TYPES.forEach((t) => assert.ok(re.test(t), `rule rejects ${t}`));
    assert.equal(re.test('made_up'), false);
});

// ── RTDB rules (static) ──────────────────────────────────────────────────
test('assessmentLive rules: staff-only control, student-owned presence/starts/violations', () => {
    const a = rules.assessmentLive.$schoolId.$assignmentId;
    const staff = /auth\.token\.role === 'teacher'/;
    assert.match(a['.read'], staff);
    assert.match(a['.read'], /auth\.token\.schoolId === \$schoolId/);
    assert.match(a.control['.write'], staff);
    assert.doesNotMatch(a.control['.write'], /student/);
    assert.match(a.control['.read'], /auth\.token\.schoolId === \$schoolId/);
    for (const node of [a.presence.$studentId, a.starts.$studentId, a.violations.$studentId.$violationId]) {
        assert.match(node['.write'], /auth\.token\.studentId === \$studentId/);
        assert.match(node['.write'], /auth\.token\.role === 'student'/);
        assert.match(node['.write'], /auth\.token\.schoolId === \$schoolId/);
    }
    assert.match(a.violations.$studentId.$violationId['.write'], /!data\.exists\(\)/, 'violations must be append-only');
    assert.match(a.starts.$studentId['.write'], /!data\.exists\(\)/, 'start time must be write-once');
    assert.equal(a.control.$other['.validate'], false);
    assert.equal(a.presence.$studentId.$other['.validate'], false);
});

test('existing RTDB nodes are untouched and the default is deny', () => {
    assert.ok(rules.examPresence && rules.livePresence);
    assert.equal(rules.$other['.read'], false);
    assert.equal(rules.$other['.write'], false);
});

// ── Timer ────────────────────────────────────────────────────────────────
test('remainingMs adds teacher-injected minutes and never goes negative', () => {
    const startedAt = 1_000_000;
    assert.equal(core.remainingMs({ timeLimitMin: 10, startedAt, now: startedAt }), 600000);
    assert.equal(core.remainingMs({ timeLimitMin: 10, extraMinutes: 5, startedAt, now: startedAt + 600000 }), 300000);
    assert.equal(core.remainingMs({ timeLimitMin: 10, startedAt, now: startedAt + 9e9 }), 0);
    assert.equal(core.remainingMs({ timeLimitMin: 0, startedAt }), null);
    assert.equal(core.formatClock(65000), '1:05');
    assert.equal(core.formatClock(3_661_000), '1:01:01');
});

// ── Review screen + force collect ────────────────────────────────────────
test('reviewSummary lists answered and unanswered items', () => {
    const s = core.reviewSummary({
        questions: [{ id: 'q_1', type: 'short_answer' }, { id: 'q_2', type: 'multiple_choice' }],
        pdfFields: [{ id: 'f1', page: 1, type: 'text' }, { id: 'f2', page: 1, type: 'checkbox' }],
        answers: { q_1: 'Belize', pdf_f1: '' },
        showWork: true, workUploads: [{ url: 'https://x' }],
    });
    assert.equal(s.total, 4);
    assert.equal(s.answered, 2);
    assert.deepEqual(s.unanswered, ['Q2', 'P1·1']);
});

test('draftToSubmission turns a saved draft into a submission payload', () => {
    const p = core.draftToSubmission({
        questions: [{ id: 'q_1', type: 'short_answer' }, { id: 'q_2', type: 'attachment_response' }],
        pdfFields: [{ id: 'f1', type: 'text' }, { id: 'f2', type: 'checkbox' }],
        fields: { q_1: ' Belmopan ', pdf_f1: 'Noun', pdf_f2: 'true', work_uploads: '[{"url":"https://a","name":"p"}]' },
    });
    assert.deepEqual(p.responses, [{ questionId: 'q_1', responseText: 'Belmopan', attachmentUrl: null }, { questionId: 'q_2', responseText: '', attachmentUrl: null }]);
    assert.deepEqual(p.pdfAnswers, { f1: 'Noun', f2: true });
    assert.equal(p.workUploads.length, 1);
    const std = core.draftToSubmission({ fields: { responseText: 'Hi', linkUrl: '' } });
    assert.equal(std.responses, null);
    assert.equal(std.responseText, 'Hi');
    assert.equal(std.linkUrl, null);
});

test('normalizeControl defaults and trims', () => {
    assert.deepEqual(core.normalizeControl(null), { paused: false, extraMinutes: 0, collectAt: null, broadcast: null });
    const c = core.normalizeControl({ paused: true, extraMinutes: '10', broadcast: { id: 'b1', text: 'x'.repeat(400), at: 5 } });
    assert.equal(c.paused, true);
    assert.equal(c.extraMinutes, 10);
    assert.equal(c.broadcast.text.length, 280);
});

test('fitDimensions keeps aspect ratio under the max side', () => {
    assert.deepEqual(core.fitDimensions(4000, 3000, 1600), { width: 1600, height: 1200 });
    assert.deepEqual(core.fitDimensions(800, 600, 1600), { width: 800, height: 600 });
});

test('themes normalise to a known value', () => {
    assert.equal(core.normalizeTheme('k5'), 'k5');
    assert.equal(core.normalizeTheme('strict'), 'strict');
    assert.equal(core.normalizeTheme('neon'), 'standard');
});
