// ── PARENT PORTFOLIO: work-photo & file gallery (Module 2) ───────────────
// Read-only gallery of the active child's submitted media:
//   • submission.workUploads[]            — "Show your work" photos ({ url, name })
//   • submission.responses[].attachmentUrl — file / photo / drawing answers
// Each card carries the assignment title, subject, submission date (with a
// Late tag from the shared due-date engine) and the teacher's score + notes
// from the grade record linked by assignmentId. Loads through the same
// helpers parent/dashboard and parent/assignments already use, so it needs
// no new Firestore or Storage permissions: submissions are readable by a
// linked parent (firestore.rules isLinkedParentOf) and the stored URLs are
// tokenized Storage download URLs.
import { db } from '../../assets/js/firebase-init.js';
import { doc, getDoc } from "https://www.gstatic.com/firebasejs/10.7.1/firebase-firestore.js";
import { requireAuth } from '../../assets/js/auth.js';
import { injectParentLayout, getActiveChild } from '../layout-parent.js';
import { loadTeacherSubjectsCache, getTeacherDocRef, letterGrade } from '../../assets/js/utils.js';
import {
    loadAssignmentsForSubjects,
    loadSubmissionsForAssignments,
    loadGradesIndexForStudent,
    resolveDueDeadline,
    isLateSubmission,
} from '../../assets/js/submissions.js';

const session = requireAuth('parent', '../../student/login.html');
const activeChild = session ? getActiveChild(session) : null;
injectParentLayout('portfolio', 'Portfolio', "Your child's submitted photos and project files");

const IMAGE_EXT = /\.(png|jpe?g|webp|gif|heic|heif|bmp)$/i;
const MAX_THUMBS = 4;

let allItems = [];
let activeSubject = '';
let lightboxList = [];
let lightboxIndex = 0;

const $ = id => document.getElementById(id);

function escHtml(str) {
    if (str === null || str === undefined) return '';
    return String(str).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;').replace(/'/g, '&#039;');
}

// Only ever render https URLs (Storage download URLs) — never data:,
// javascript: or relative values that may sit in older submission docs.
function safeUrl(url) {
    try { const u = new URL(String(url)); return u.protocol === 'https:' ? u.href : null; } catch (e) { return null; }
}

function fileNameFromUrl(url) {
    try {
        const path = decodeURIComponent(new URL(url).pathname);
        return path.split('/').pop() || 'file';
    } catch (e) { return 'file'; }
}

function mediaKind(url, name) {
    const file = fileNameFromUrl(url);
    if (IMAGE_EXT.test((name || '').trim()) || IMAGE_EXT.test(file)) return 'image';
    if (/\.pdf$/i.test((name || '').trim()) || /\.pdf$/i.test(file)) return 'pdf';
    return 'file';
}

function collectMedia(submission) {
    const media = [];
    const seen = new Set();
    const push = (url, name, label, forceKind) => {
        const safe = safeUrl(url);
        if (!safe || seen.has(safe)) return;
        seen.add(safe);
        media.push({ url: safe, name: name || fileNameFromUrl(safe), kind: forceKind || mediaKind(safe, name), label });
    };
    // Show-your-work uploads are image-only (accept="image/*", compressed client-side).
    (Array.isArray(submission.workUploads) ? submission.workUploads : []).forEach(u => push(u && u.url, u && u.name, 'Show your work', 'image'));
    (Array.isArray(submission.responses) ? submission.responses : []).forEach((r, i) => {
        if (r && r.attachmentUrl) push(r.attachmentUrl, null, `Answer ${i + 1}`);
    });
    return media;
}

function formatDate(iso) {
    if (!iso) return '';
    const d = new Date(iso);
    return isNaN(d.getTime()) ? String(iso) : d.toLocaleDateString(undefined, { month: 'short', day: 'numeric', year: 'numeric' });
}

function scoreStyle(pct) {
    if (pct === null) return 'background:#f8fafc;color:#64748b;';
    if (pct >= 90) return 'background:#ecfdf5;color:#047857;';
    if (pct >= 80) return 'background:#eff6ff;color:#1d4ed8;';
    if (pct >= 70) return 'background:#f0fdfa;color:#0f766e;';
    if (pct >= 65) return 'background:#fffbeb;color:#b45309;';
    return 'background:#fef2f2;color:#b91c1c;';
}

// ── DATA ──────────────────────────────────────────────────────────────────
async function loadPortfolio(child) {
    const studentSnap = await getDoc(doc(db, 'students', child.studentId));
    if (!studentSnap.exists()) return { childName: 'Student', items: [], reason: 'missing-student' };
    const sd = studentSnap.data();
    const childName = sd.name || 'Student';
    const teacherId = sd.teacherId || null;
    if (!teacherId) return { childName, items: [], reason: 'no-teacher' };

    let legacyTeacherData = null;
    try {
        const tSnap = await getDoc(getTeacherDocRef(child.schoolId, teacherId));
        if (tSnap.exists()) legacyTeacherData = tSnap.data();
    } catch (e) {
        console.error('[Portfolio] teacher doc:', e);
    }

    const { subjectsCache, resolvedClasses } = await loadTeacherSubjectsCache(child.schoolId, teacherId, legacyTeacherData);
    const assignments = loadAssignmentsForSubjects(subjectsCache, resolvedClasses).filter(a => a.status !== 'draft');
    if (!assignments.length) return { childName, items: [] };

    const [subMap, gradeMap] = await Promise.all([
        loadSubmissionsForAssignments(child.schoolId, assignments, child.studentId),
        loadGradesIndexForStudent(child.schoolId, child.studentId),
    ]);

    const items = [];
    assignments.forEach(a => {
        const submission = subMap.get(a.id);
        if (!submission) return;
        const media = collectMedia(submission);
        if (!media.length) return;

        const grade = gradeMap.get(a.id) || null;
        const pct = grade && Number(grade.max) > 0 ? Math.round(grade.score / Number(grade.max) * 100) : null;
        const submittedAt = submission.submittedAt || submission.updatedAt || '';
        items.push({
            id: a.id,
            title: a.title || submission.assignmentTitle || 'Untitled assignment',
            subject: a.subjectName || submission.subjectName || 'General',
            submittedAt,
            late: isLateSubmission(submittedAt, resolveDueDeadline(a.dueDate || a.date || '')),
            grade, pct,
            feedback: grade && grade.notes ? String(grade.notes) : '',
            status: submission.status || '',
            media,
        });
    });
    items.sort((x, y) => String(y.submittedAt).localeCompare(String(x.submittedAt)));
    return { childName, items };
}

// ── RENDER ────────────────────────────────────────────────────────────────
function renderTabs() {
    const el = $('pfTabs');
    const counts = {};
    allItems.forEach(it => { counts[it.subject] = (counts[it.subject] || 0) + 1; });
    const subjects = Object.keys(counts).sort((a, b) => a.localeCompare(b));
    if (subjects.length < 2) { el.classList.add('hidden'); return; }

    const tab = (value, label, n) => `<button type="button" role="tab" aria-selected="${activeSubject === value}" class="pf-tab${activeSubject === value ? ' is-active' : ''}" data-subject="${escHtml(value)}">${escHtml(label)}<span class="pf-tab-count">${n}</span></button>`;
    el.innerHTML = tab('', 'All Subjects', allItems.length) + subjects.map(s => tab(s, s, counts[s])).join('');
    el.classList.remove('hidden');
}

function renderMedia(item) {
    const shown = item.media.slice(0, MAX_THUMBS);
    const extra = item.media.length - shown.length;
    return `<div class="pf-media n${shown.length}">${shown.map((m, i) => {
        const overlay = (i === shown.length - 1 && extra > 0) ? `<span class="pf-thumb-more">+${extra}</span>` : '';
        if (m.kind === 'image') {
            return `<button type="button" class="pf-thumb" data-open="${escHtml(item.id)}" data-index="${i}" aria-label="View ${escHtml(m.name)}"><img src="${escHtml(m.url)}" alt="${escHtml(item.title)} — ${escHtml(m.label)}" loading="lazy" referrerpolicy="no-referrer">${overlay}</button>`;
        }
        return `<div class="pf-thumb"><a class="pf-file" href="${escHtml(m.url)}" target="_blank" rel="noopener noreferrer"><i class="fa-solid ${m.kind === 'pdf' ? 'fa-file-pdf' : 'fa-file-arrow-down'}"></i><span>${escHtml(m.name)}</span></a>${overlay}</div>`;
    }).join('')}</div>`;
}

function renderCard(item) {
    const scoreHtml = item.grade
        ? `<div class="pf-score" style="${scoreStyle(item.pct)}"><span>Score</span><span class="pf-score-val">${escHtml(item.grade.score)}/${escHtml(item.grade.max)}${item.pct !== null ? ` · ${item.pct}% ${letterGrade(item.pct)}` : ''}</span></div>`
        : `<div class="pf-score pf-pending"><span><i class="fa-regular fa-hourglass-half" style="margin-right:6px;"></i>Awaiting teacher review</span></div>`;
    const feedbackHtml = item.feedback
        ? `<div class="pf-feedback"><p class="pf-feedback-label">Teacher feedback</p><p class="pf-feedback-text">${escHtml(item.feedback)}</p></div>`
        : '';
    const photos = item.media.filter(m => m.kind === 'image').length;
    const files = item.media.length - photos;
    return `
    <article class="pf-card">
        ${renderMedia(item)}
        <div class="pf-body">
            <h3 class="pf-card-title">${escHtml(item.title)}</h3>
            <div class="pf-meta">
                <span class="pf-chip">${escHtml(item.subject)}</span>
                ${item.submittedAt ? `<span><i class="fa-regular fa-calendar" style="margin-right:4px;"></i>${escHtml(formatDate(item.submittedAt))}</span>` : ''}
                ${item.late ? '<span class="pf-late">Late</span>' : ''}
                <span>· ${photos ? `${photos} photo${photos === 1 ? '' : 's'}` : ''}${photos && files ? ', ' : ''}${files ? `${files} file${files === 1 ? '' : 's'}` : ''}</span>
            </div>
            ${scoreHtml}
            ${feedbackHtml}
        </div>
    </article>`;
}

function render() {
    const items = activeSubject ? allItems.filter(it => it.subject === activeSubject) : allItems;
    const photos = items.reduce((n, it) => n + it.media.filter(m => m.kind === 'image').length, 0);
    const summary = $('pfSummary');
    summary.textContent = `${items.length} submission${items.length === 1 ? '' : 's'} · ${photos} photo${photos === 1 ? '' : 's'}`;
    summary.classList.remove('hidden');
    renderTabs();
    $('pfGrid').innerHTML = items.map(renderCard).join('');
    $('pfGrid').classList.toggle('hidden', !items.length);
}

function showEmpty(html) {
    $('pfLoader').classList.add('hidden');
    $('pfGrid').classList.add('hidden');
    $('pfEmpty').innerHTML = html;
    $('pfEmpty').classList.remove('hidden');
}

// ── LIGHTBOX ──────────────────────────────────────────────────────────────
function openLightbox(itemId, index) {
    const item = allItems.find(it => it.id === itemId);
    if (!item) return;
    lightboxList = item.media.filter(m => m.kind === 'image').map(m => ({ ...m, title: item.title }));
    const target = item.media[index];
    lightboxIndex = Math.max(0, lightboxList.findIndex(m => m.url === target?.url));
    showLightboxImage();
    $('pfLightbox').classList.remove('hidden');
    $('pfLightbox').querySelector('[data-lb="close"]').focus();
}

function showLightboxImage() {
    const m = lightboxList[lightboxIndex];
    if (!m) return;
    $('pfLbImg').src = m.url;
    $('pfLbImg').alt = `${m.title} — ${m.label}`;
    $('pfLbCaption').innerHTML = `${escHtml(m.title)} · ${escHtml(m.label)}${lightboxList.length > 1 ? ` · ${lightboxIndex + 1} of ${lightboxList.length}` : ''}<a href="${escHtml(m.url)}" target="_blank" rel="noopener noreferrer"><i class="fa-solid fa-up-right-from-square"></i> Open full size</a>`;
    const multi = lightboxList.length > 1;
    $('pfLightbox').querySelector('[data-lb="prev"]').style.display = multi ? '' : 'none';
    $('pfLightbox').querySelector('[data-lb="next"]').style.display = multi ? '' : 'none';
}

function stepLightbox(delta) {
    if (!lightboxList.length) return;
    lightboxIndex = (lightboxIndex + delta + lightboxList.length) % lightboxList.length;
    showLightboxImage();
}

function closeLightbox() {
    $('pfLightbox').classList.add('hidden');
    $('pfLbImg').removeAttribute('src');
}

function wireEvents() {
    $('pfTabs').addEventListener('click', (e) => {
        const btn = e.target.closest('[data-subject]');
        if (!btn) return;
        activeSubject = btn.dataset.subject;
        render();
    });
    $('pfGrid').addEventListener('click', (e) => {
        const btn = e.target.closest('[data-open]');
        if (btn) openLightbox(btn.dataset.open, Number(btn.dataset.index));
    });
    $('pfLightbox').addEventListener('click', (e) => {
        const action = e.target.closest('[data-lb]')?.dataset.lb;
        if (action === 'close' || e.target.id === 'pfLightbox') closeLightbox();
        else if (action === 'prev') stepLightbox(-1);
        else if (action === 'next') stepLightbox(1);
    });
    document.addEventListener('keydown', (e) => {
        if ($('pfLightbox').classList.contains('hidden')) return;
        if (e.key === 'Escape') closeLightbox();
        else if (e.key === 'ArrowLeft') stepLightbox(-1);
        else if (e.key === 'ArrowRight') stepLightbox(1);
    });
}

// ── INIT ──────────────────────────────────────────────────────────────────
async function init() {
    if (!session) return;
    wireEvents();
    if (!activeChild) {
        showEmpty('<i class="fa-solid fa-user-slash"></i>No student is linked to your account yet — contact your school to get linked.');
        return;
    }
    try {
        const { childName, items, reason } = await loadPortfolio(activeChild);
        $('pfTitle').textContent = `${childName}'s Portfolio`;
        allItems = items;
        $('pfLoader').classList.add('hidden');
        if (!items.length) {
            showEmpty(reason === 'missing-student'
                ? '<i class="fa-solid fa-user-slash"></i>Student record not found.'
                : `<i class="fa-regular fa-images"></i>No photos or files submitted yet. When ${escHtml(childName)} uploads work for an assignment, it will show up here.`);
            return;
        }
        render();
    } catch (e) {
        console.error('[Portfolio] init:', e);
        showEmpty('<i class="fa-solid fa-triangle-exclamation"></i>Something went wrong loading the portfolio. Please try again later.');
    }
}

init();
