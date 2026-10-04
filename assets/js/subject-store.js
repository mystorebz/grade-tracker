// assets/js/subject-store.js — per-subject data layer for teacher/subjects/subject.html
//
// One store per (schoolId, classId, subjectId). Two cache layers:
//   1. memory: every fetcher is memoized (TTL), concurrent callers share one
//      in-flight promise → switching tabs never refetches.
//   2. sessionStorage (semi-static resources only: class, subject, grading
//      periods, roster): stale-while-revalidate → returning to a subject is
//      instant; a background refresh updates the cache for next time.
// invalidate(name) drops a resource from both layers (call after writes).
//
// Identity is (classId, subjectId) — never the subject name. Grades are read
// with ONE collection-group query (schoolId, subjectId, semesterId). Lessons
// are read as metadata only (split lesson model: slides live in
// lessons/{id}/content/main and are loaded by the editor/player, not lists).

import { db } from './firebase-init.js';
import { doc, getDoc, getDocs, collection, collectionGroup, query, where }
    from "https://www.gstatic.com/firebasejs/10.7.1/firebase-firestore.js";

const MEMORY_TTL_MS = 60_000;
const PERSIST_TTL_MS = 10 * 60_000;     // serve from sessionStorage up to 10 min old…
const REVALIDATE_AFTER_MS = 30_000;     // …and refresh in the background once it's 30 s old
const SS_PREFIX = 'cu:store:v1:';

function ssRead(key) {
    try {
        const raw = sessionStorage.getItem(SS_PREFIX + key);
        if (!raw) return null;
        const entry = JSON.parse(raw);
        return entry && typeof entry.at === 'number' ? entry : null;
    } catch (e) { return null; }
}
function ssWrite(key, value) {
    try { sessionStorage.setItem(SS_PREFIX + key, JSON.stringify({ at: Date.now(), v: value })); } catch (e) { /* quota / private mode */ }
}
function ssDelete(key) {
    try { sessionStorage.removeItem(SS_PREFIX + key); } catch (e) { /* ignore */ }
}

export function createSubjectStore({ schoolId, classId, subjectId, viewerId = '' }, { ttlMs = MEMORY_TTL_MS } = {}) {
    if (!schoolId || !classId || !subjectId) throw new Error('createSubjectStore: schoolId, classId and subjectId are required');

    const entries = new Map(); // memory: key -> { at, promise }
    // persisted keys are scoped to the viewer + school (+ class/subject where relevant)
    const scope = `${viewerId}|${schoolId}`;
    const persistKey = {
        semesters: `${scope}|semesters`,
        class: `${scope}|${classId}|class`,
        students: `${scope}|${classId}|students`,
        subject: `${scope}|${classId}|${subjectId}|subject`,
    };

    function memo(key, loader, { force = false } = {}) {
        const hit = entries.get(key);
        if (!force && hit && Date.now() - hit.at < ttlMs) return hit.promise;
        const promise = loader().catch((e) => { entries.delete(key); throw e; });
        entries.set(key, { at: Date.now(), promise });
        return promise;
    }

    // memory memo + sessionStorage stale-while-revalidate
    function persisted(name, loader, opts = {}) {
        const pkey = persistKey[name];
        if (opts.force) {
            return memo(name, () => loader().then((v) => { ssWrite(pkey, v); return v; }), { force: true });
        }
        const hit = entries.get(name);
        if (hit && Date.now() - hit.at < ttlMs) return hit.promise;
        const cached = ssRead(pkey);
        if (cached && Date.now() - cached.at < PERSIST_TTL_MS) {
            const promise = Promise.resolve(cached.v);
            entries.set(name, { at: Date.now(), promise });
            if (Date.now() - cached.at > REVALIDATE_AFTER_MS) {
                loader().then((v) => {
                    ssWrite(pkey, v);
                    entries.set(name, { at: Date.now(), promise: Promise.resolve(v) });
                }).catch((e) => console.warn(`[subject-store] background refresh of ${name} failed:`, e));
            }
            return promise;
        }
        return memo(name, () => loader().then((v) => { ssWrite(pkey, v); return v; }));
    }

    const schoolRef = doc(db, 'schools', schoolId);
    const classRef = doc(db, 'schools', schoolId, 'classes', classId);
    const subjectRef = doc(db, 'schools', schoolId, 'classes', classId, 'subjects', subjectId);

    // ── SCHOOL / CLASS / SUBJECT ─────────────────────────────────────────
    function getClass(opts) {
        return persisted('class', async () => {
            const snap = await getDoc(classRef);
            return snap.exists() ? { id: snap.id, ...snap.data() } : null;
        }, opts);
    }

    function getSubject(opts) {
        return persisted('subject', async () => {
            const snap = await getDoc(subjectRef);
            return snap.exists() ? { id: snap.id, classId, ...snap.data() } : null;
        }, opts);
    }

    // { activeSemesterId, semesters: [{id, name, order, isLocked}] }
    function getSemesters(opts) {
        return persisted('semesters', async () => {
            const [schoolSnap, semSnap] = await Promise.all([
                getDoc(schoolRef),
                getDocs(collection(db, 'schools', schoolId, 'semesters')),
            ]);
            const semesters = semSnap.docs
                .map((d) => ({ id: d.id, ...d.data() }))
                .sort((a, b) => (a.order || 0) - (b.order || 0));
            return { activeSemesterId: schoolSnap.data()?.activeSemesterId || semesters[0]?.id || null, semesters };
        }, opts);
    }

    // ── STUDENTS (active, in this class) ─────────────────────────────────
    function getStudents(opts) {
        return persisted('students', async () => {
            const [cls, snap] = await Promise.all([
                getClass(),
                getDocs(query(
                    collection(db, 'students'),
                    where('currentSchoolId', '==', schoolId),
                    where('enrollmentStatus', '==', 'Active'),
                )),
            ]);
            return snap.docs
                .map((d) => {
                    const s = d.data();
                    // only what the subject page renders — never cache PINs/hashes/contact data
                    return { id: d.id, name: s.name || '', classId: s.classId || '', className: s.className || '', teacherId: s.teacherId || '' };
                })
                .filter((s) => s.classId === classId || (!!cls?.name && s.className === cls.name))
                .sort((a, b) => (a.name || '').localeCompare(b.name || ''));
        }, opts);
    }

    // ── ASSIGNMENTS ──────────────────────────────────────────────────────
    function getAssignments(opts) {
        return memo('assignments', async () => {
            const snap = await getDocs(collection(subjectRef, 'assignments'));
            return snap.docs
                .map((d) => ({ id: d.id, classId, subjectId, ...d.data() }))
                .sort((a, b) => String(b.date || b.createdAt || '').localeCompare(String(a.date || a.createdAt || '')));
        }, opts);
    }

    // ── GRADES (one collection-group query per semester) ─────────────────
    // SECURITY: classId is filtered SERVER-side. firestore.rules only lets a
    // teacher list grades of a class they are assigned to, and can only prove
    // that when the query pins classId (subjectId alone is also not globally
    // unique — legacy ids like ds1 exist in every class).
    function getGrades(semesterId, opts) {
        if (!semesterId) return Promise.resolve([]);
        return memo(`grades:${semesterId}`, async () => {
            const snap = await getDocs(query(
                collectionGroup(db, 'grades'),
                where('schoolId', '==', schoolId),
                where('classId', '==', classId),
                where('subjectId', '==', subjectId),
                where('semesterId', '==', semesterId),
            ));
            return snap.docs
                .map((d) => ({ id: d.id, studentId: d.ref.parent.parent?.id || null, ...d.data() }))
                .filter((g) => g.classId === classId);
        }, opts);
    }

    // ── LESSONS (metadata documents only) ────────────────────────────────
    function getLessons(opts) {
        return memo('lessons', async () => {
            const snap = await getDocs(collection(subjectRef, 'lessons'));
            return snap.docs
                .map((d) => {
                    const { slides, theme, ...meta } = d.data(); // pre-split docs may still carry slides
                    return {
                        id: d.id, ...meta,
                        slideCount: Number.isInteger(meta.slideCount) ? meta.slideCount : (Array.isArray(slides) ? slides.length : 0),
                    };
                })
                .sort((a, b) => String(b.updatedAt || '').localeCompare(String(a.updatedAt || '')));
        }, opts);
    }

    function invalidate(name) {
        if (!name) {
            entries.clear();
            Object.values(persistKey).forEach(ssDelete);
            return;
        }
        for (const key of [...entries.keys()]) {
            if (key === name || key.startsWith(`${name}:`)) entries.delete(key);
        }
        if (persistKey[name]) ssDelete(persistKey[name]);
    }

    // Start the reads every tab needs, without waiting (call right after creating the store).
    function prefetch(semesterId) {
        getStudents().catch(() => {});
        if (semesterId) getGrades(semesterId).catch(() => {});
        else getSemesters().then(({ activeSemesterId }) => activeSemesterId && getGrades(activeSemesterId)).catch(() => {});
    }

    return {
        ctx: Object.freeze({ schoolId, classId, subjectId }),
        getClass, getSubject, getSemesters, getStudents, getAssignments, getGrades, getLessons, invalidate, prefetch,
    };
}
