#!/usr/bin/env node
'use strict';
/**
 * functions/prod-migrate-stream-answers.js — PRODUCTION, run right after the
 * production deploy (rules + hosting with assets/js/stream-answers.js).
 *
 *   node prod-migrate-stream-answers.js                        DRY RUN (reads only)
 *   node prod-migrate-stream-answers.js --apply --confirm-production --expect=<posts>,<answers>
 *
 * Same logic as dev-final-cleanup.js PART B, pointed at school-grade-tracker:
 * answers to Stream Question posts used to live in the post's `comments`
 * array (readable by every student in the class). Each one is copied to
 * posts/{postId}/answers (student: doc id = studentId; teacher: 't_…'),
 * then the post's `comments` array is emptied. A student who answered more
 * than once gets one answer containing both texts.
 *
 * Safety: writes only with BOTH --apply and --confirm-production, and only
 * when --expect matches what the scan finds right now.
 * Auth: Application Default Credentials.
 */
const PROJECT_ID = 'school-grade-tracker';
for (const v of ['FIRESTORE_EMULATOR_HOST', 'FIREBASE_AUTH_EMULATOR_HOST', 'FIREBASE_EMULATOR_HUB']) delete process.env[v];
process.env.GOOGLE_CLOUD_PROJECT = PROJECT_ID;
process.env.GCLOUD_PROJECT = PROJECT_ID;

const { initializeApp, applicationDefault } = require('firebase-admin/app');
const { getFirestore } = require('firebase-admin/firestore');
const app = initializeApp({ projectId: PROJECT_ID, credential: applicationDefault() }, 'prod-migrate-answers');
const db = getFirestore(app);

const APPLY = process.argv.includes('--apply') && process.argv.includes('--confirm-production');
const expectArg = (process.argv.find(a => a.startsWith('--expect=')) || '').slice('--expect='.length);

function toAnswers(post) {
    const comments = (post.get('comments') || []).filter(c => c && c.text);
    const answers = new Map();
    for (const c of comments) {
        const isStudent = c.role === 'student' && c.authorId;
        const id = isStudent
            ? String(c.authorId)
            : `t_${String(c.id || Date.now().toString(36)).replace(/[^A-Za-z0-9]/g, '').slice(0, 40).padEnd(4, '0')}`;
        const prev = answers.get(id);
        if (prev) { prev.text = `${prev.text}\n\n${c.text}`.slice(0, 1000); continue; }
        answers.set(id, {
            text: String(c.text).slice(0, 1000),
            authorId: String(c.authorId || ''),
            authorName: String(c.authorName || '').slice(0, 80),
            role: isStudent ? 'student' : 'teacher',
            createdAt: c.createdAt || post.get('createdAt') || new Date().toISOString(),
        });
    }
    return { comments, answers };
}

(async () => {
    console.log(`prod-migrate-stream-answers — ${APPLY ? 'APPLY' : 'DRY RUN'} — ${PROJECT_ID}\n`);
    const work = [];
    const snap = await db.collectionGroup('posts').get();
    let questionPosts = 0;
    for (const p of snap.docs) {
        const seg = p.ref.path.split('/');
        if (!(seg.length === 8 && seg[0] === 'schools' && seg[2] === 'classes')) continue;
        if (p.get('type') !== 'question') continue;
        questionPosts++;
        const { comments, answers } = toAnswers(p);
        if (!comments.length) continue;
        work.push({ ref: p.ref, answers });
        console.log(`[INFO] ${p.ref.path}: ${comments.length} answer(s) → ${answers.size} answer doc(s)`);
    }
    const total = work.reduce((n, w) => n + w.answers.size, 0);
    console.log(`\nQuestion posts on production: ${questionPosts}. With answers to move: ${work.length}. Answer docs to write: ${total}.`);

    if (!APPLY) {
        console.log('\nDry run only — nothing written. To migrate, re-run with:');
        console.log(`  node prod-migrate-stream-answers.js --apply --confirm-production --expect=${work.length},${total}`);
        return;
    }
    const [expP, expA] = expectArg.split(',').map(x => parseInt(x, 10));
    if (!(expP === work.length && expA === total)) {
        console.error(`[FAIL] --expect=${expectArg || '(missing)'} does not match the scan (${work.length},${total}). Nothing was written.`);
        process.exitCode = 1;
        return;
    }
    for (const { ref, answers } of work) {
        const batch = db.batch();
        answers.forEach((data, id) => batch.set(ref.collection('answers').doc(id), data));
        batch.update(ref, { comments: [] });
        await batch.commit();
        console.log(`[PASS] ${ref.path}: ${answers.size} answer doc(s) written, comments emptied`);
    }
    // Verify
    let leftover = 0;
    for (const { ref } of work) if (((await ref.get()).get('comments') || []).length) leftover++;
    console.log(`\n[${leftover ? 'FAIL' : 'PASS'}] Posts moved: ${work.length}. Answer docs written: ${total}. Question posts still holding answers in the post: ${leftover}.`);
    if (leftover) process.exitCode = 1;
})().then(() => process.exit(process.exitCode || 0)).catch((e) => { console.error(`[FAIL] ${e.message}`); process.exit(1); });
