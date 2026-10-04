// assets/js/assignment-drafts.js — unsent answers survive refreshes and device switches
//
// Local first: every keystroke/pick is written to localStorage (debounced
// 400 ms) under gt-asg-draft:{studentId}:{assignmentId}. Cloud backup: when
// the draft changed, it is copied to
//   schools/{s}/classes/{c}/subjects/{sub}/assignments/{a}/drafts/{studentId}
// at most once every 60 s, and right away when the page loses focus or is
// hidden. Submit → discard(): local copy cleared, cloud draft deleted.
//
// Draft payload: { fields: { [key]: string } } — key = question id (text,
// short answer, math, multiple choice index) or 'responseText' / 'linkUrl'
// for instructions-only work. Files and drawings are not drafted.

import { db } from './firebase-init.js';
import { doc, getDoc, setDoc, deleteDoc, serverTimestamp }
    from "https://www.gstatic.com/firebasejs/10.7.1/firebase-firestore.js";

const LOCAL_DEBOUNCE_MS = 400;
const CLOUD_INTERVAL_MS = 60000;
const MAX_FIELD_CHARS = 20000;

const localKey = (studentId, assignmentId) => `gt-asg-draft:${studentId}:${assignmentId}`;

function readLocal(key) {
    try { const v = JSON.parse(localStorage.getItem(key) || 'null'); return v && typeof v.fields === 'object' ? v : null; }
    catch (e) { return null; }
}
function writeLocal(key, value) {
    try { localStorage.setItem(key, JSON.stringify(value)); return true; } catch (e) { return false; }
}
function removeLocal(key) {
    try { localStorage.removeItem(key); } catch (e) { /* storage off */ }
}

const timeLabel = (iso) => new Date(iso).toLocaleTimeString(undefined, { hour: 'numeric', minute: '2-digit' });
const sameFields = (a, b) => JSON.stringify(a || {}) === JSON.stringify(b || {});

// Inputs that make up the draft inside `root` (only editable ones).
function draftInputs(root) {
    return [...root.querySelectorAll('input[data-question-id], textarea[data-question-id], #adResponseText, #adLinkUrl')]
        .filter((el) => !el.disabled && el.type !== 'file');
}

function fieldKey(el) {
    if (el.id === 'adResponseText') return 'responseText';
    if (el.id === 'adLinkUrl') return 'linkUrl';
    return el.dataset.questionId || null;
}

function collect(root) {
    const fields = {};
    draftInputs(root).forEach((el) => {
        const key = fieldKey(el);
        if (!key) return;
        if (el.type === 'radio') {
            if (el.checked) fields[key] = String(el.dataset.optionIndex ?? el.value);
            return;
        }
        if (el.type === 'checkbox') { if (el.checked) fields[key] = 'true'; return; }
        const v = String(el.value || '');
        if (v.trim()) fields[key] = v.slice(0, MAX_FIELD_CHARS);
    });
    return fields;
}

function apply(root, fields, only = null) {
    draftInputs(root).filter((el) => !only || el.matches(only)).forEach((el) => {
        const key = fieldKey(el);
        if (!key || !(key in fields)) return;
        if (el.type === 'radio') el.checked = String(el.dataset.optionIndex ?? el.value) === fields[key];
        else if (el.type === 'checkbox') el.checked = fields[key] === 'true';
        else el.value = fields[key];
    });
    root.dispatchEvent(new CustomEvent('draft:applied', { detail: { fields } }));
}

/**
 * startAssignmentDraft({ root, schoolId, studentId, assignment, submittedAt, statusEl })
 *   root         element holding the answer inputs (#assignmentDetailBody)
 *   assignment   needs id, classId, subjectId
 *   submittedAt  ISO of the current submission (a draft older than it is stale)
 *   statusEl     optional element for "Saving… / Saved · 10:42 AM"
 * Returns { stop({ flush }), discard() }.
 */
export function startAssignmentDraft({ root, schoolId, studentId, assignment, submittedAt, statusEl }) {
    if (!root || !schoolId || !studentId || !assignment?.id || !assignment.classId || !assignment.subjectId) return null;
    if (!draftInputs(root).length && !root.querySelector('[data-draft-async]')) return null;

    const key = localKey(studentId, assignment.id);
    const ref = doc(db, 'schools', schoolId, 'classes', assignment.classId, 'subjects', assignment.subjectId,
        'assignments', assignment.id, 'drafts', studentId);
    const baseline = Date.parse(submittedAt || '') || 0;

    let stopped = false;
    let touched = false;           // student typed since this page opened
    let localTimer = null;
    let cloudTimer = null;
    let lastLocal = null;          // { fields, updatedAt }
    let cloudFields = null;        // fields last confirmed in Firestore
    let fadeTimer = null;

    function status(text, state = 'saved') {
        if (!statusEl || stopped) return;
        clearTimeout(fadeTimer);
        statusEl.textContent = text;
        statusEl.dataset.state = state;
        statusEl.classList.add('is-visible');
        if (state === 'saved') fadeTimer = setTimeout(() => statusEl.classList.add('is-quiet'), 2500);
        else statusEl.classList.remove('is-quiet');
    }

    function saveLocalNow() {
        clearTimeout(localTimer); localTimer = null;
        const fields = collect(root);
        if (lastLocal && sameFields(lastLocal.fields, fields)) return;
        lastLocal = { fields, updatedAt: new Date().toISOString() };
        if (Object.keys(fields).length) writeLocal(key, lastLocal); else removeLocal(key);
        if (!cloudTimer) cloudTimer = setTimeout(() => { cloudTimer = null; syncCloud(); }, CLOUD_INTERVAL_MS);
    }

    async function syncCloud() {
        clearTimeout(cloudTimer); cloudTimer = null;
        if (stopped || !lastLocal || sameFields(cloudFields, lastLocal.fields)) return;
        const snapshot = lastLocal;
        status('Saving…', 'saving');
        try {
            if (Object.keys(snapshot.fields).length) {
                await setDoc(ref, { studentId, assignmentId: assignment.id, fields: snapshot.fields, updatedAt: snapshot.updatedAt, savedAt: serverTimestamp() });
            } else {
                await deleteDoc(ref);
            }
            cloudFields = snapshot.fields;
            status(`Saved · ${timeLabel(snapshot.updatedAt)}`);
        } catch (e) {
            console.warn('[Drafts] cloud save:', e);
            status('Saved on this device', 'local');
            if (!stopped && !cloudTimer) cloudTimer = setTimeout(() => { cloudTimer = null; syncCloud(); }, CLOUD_INTERVAL_MS);
        }
    }

    const onInput = () => {
        touched = true;
        status('Saving…', 'saving');
        clearTimeout(localTimer);
        localTimer = setTimeout(() => {
            saveLocalNow();
            if (!stopped && lastLocal) status(`Saved · ${timeLabel(lastLocal.updatedAt)}`, cloudTimer ? 'pending' : 'saved');
        }, LOCAL_DEBOUNCE_MS);
    };
    const flushNow = () => { if (localTimer) saveLocalNow(); syncCloud(); };
    const onVisibility = () => { if (document.visibilityState === 'hidden') flushNow(); };

    root.addEventListener('input', onInput);
    root.addEventListener('change', onInput);
    const onFocusOut = (e) => { if (!root.contains(e.relatedTarget)) flushNow(); };
    root.addEventListener('focusout', onFocusOut);
    window.addEventListener('blur', flushNow);
    window.addEventListener('pagehide', flushNow);
    document.addEventListener('visibilitychange', onVisibility);

    // ── Restore: local immediately, cloud when it arrives (newer wins) ──
    const local = readLocal(key);
    if (local && (Date.parse(local.updatedAt) || 0) > baseline) {
        apply(root, local.fields);
        lastLocal = local;
        status(`Draft restored · ${timeLabel(local.updatedAt)}`);
    } else if (local) {
        removeLocal(key); // older than the submitted answers
    }
    getDoc(ref).then((snap) => {
        if (stopped || !snap.exists()) return;
        const d = snap.data();
        const cloudAt = Date.parse(d.updatedAt) || 0;
        cloudFields = d.fields || {};
        if (cloudAt <= baseline) { deleteDoc(ref).catch(() => {}); cloudFields = null; return; }
        if (touched || (lastLocal && (Date.parse(lastLocal.updatedAt) || 0) >= cloudAt)) return;
        apply(root, cloudFields);
        lastLocal = { fields: cloudFields, updatedAt: d.updatedAt };
        writeLocal(key, lastLocal);
        status(`Draft restored · ${timeLabel(d.updatedAt)}`);
    }).catch((e) => console.warn('[Drafts] load:', e));

    function detach() {
        root.removeEventListener('input', onInput);
        root.removeEventListener('change', onInput);
        root.removeEventListener('focusout', onFocusOut);
        window.removeEventListener('blur', flushNow);
        window.removeEventListener('pagehide', flushNow);
        document.removeEventListener('visibilitychange', onVisibility);
        clearTimeout(localTimer); clearTimeout(cloudTimer); clearTimeout(fadeTimer);
    }

    return {
        // inputs rendered after start (PDF worksheet overlays): fill them from the draft
        reapply(selector = '[data-pdf-field]') { if (!stopped && lastLocal) apply(root, lastLocal.fields, selector); },
        // leaving the assignment: keep the draft, push it to the cloud now
        stop({ flush = true } = {}) {
            if (stopped) return;
            if (flush) flushNow();
            stopped = true;
            detach();
            if (statusEl) { statusEl.textContent = ''; statusEl.classList.remove('is-visible', 'is-quiet'); }
        },
        // submitted: the draft is no longer needed anywhere
        async discard() {
            stopped = true;
            detach();
            removeLocal(key);
            if (statusEl) { statusEl.textContent = ''; statusEl.classList.remove('is-visible', 'is-quiet'); }
            try { await deleteDoc(ref); } catch (e) { console.warn('[Drafts] delete:', e); }
        },
    };
}
