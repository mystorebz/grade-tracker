import { db } from './firebase-init.js';
import { collection, query, where, getDocs, doc, getDoc, writeBatch, addDoc, updateDoc }
    from "https://www.gstatic.com/firebasejs/10.7.1/firebase-firestore.js";

// ── UI OVERLAYS & MODALS ────────────────────────────────────────

export function openOverlay(oid, iid, slide = false) {
    const o = document.getElementById(oid);
    const i = document.getElementById(iid);
    if (!o || !i) return;
    
    o.classList.remove('hidden');
    requestAnimationFrame(() => {
        o.classList.remove('opacity-0');
        if (slide) i.classList.remove('translate-x-full');
        else i.classList.remove('scale-95');
    });
}

export function closeOverlay(oid, iid, slide = false) {
    const o = document.getElementById(oid);
    const i = document.getElementById(iid);
    if (!o || !i) return;
    
    o.classList.add('opacity-0');
    if (slide) i.classList.add('translate-x-full');
    else i.classList.add('scale-95');
    setTimeout(() => o.classList.add('hidden'), 300);
}

// ── NOTIFICATIONS ───────────────────────────────────────────────

export function showMsg(id, text, isError = false) {
    const el = document.getElementById(id);
    if (!el) return;
    
    el.textContent = text;
    el.className = `text-sm font-bold p-3 rounded-xl ${isError ? 'text-red-700 bg-red-100 border border-red-200' : 'text-green-700 bg-green-100 border border-green-200'}`;
    el.classList.remove('hidden');
    
    if (!isError) setTimeout(() => el.classList.add('hidden'), 4000);
}

// ── GRADING MATH & UI ───────────────────────────────────────────

export function letterGrade(p) {
    return p >= 90 ? 'A' : p >= 80 ? 'B' : p >= 70 ? 'C' : p >= 65 ? 'D' : 'F';
}

export function gradeColorClass(p) {
    return p >= 90 ? 'text-emerald-600' : p >= 80 ? 'text-blue-600' : p >= 70 ? 'text-teal-600' : p >= 65 ? 'text-amber-600' : 'text-red-600';
}

export function gradeFill(p) {
    return p >= 90 ? '#10b981' : p >= 80 ? '#3b82f6' : p >= 70 ? '#14b8a6' : p >= 65 ? '#f59e0b' : '#ef4444';
}

export function standingBadge(avg) {
    if (avg === null) return '<span class="badge s-none">No Grades</span>';
    if (avg >= 90) return '<span class="badge s-exc">Excelling</span>';
    if (avg >= 80) return '<span class="badge s-good">Good Standing</span>';
    if (avg >= 70) return '<span class="badge s-track">On Track</span>';
    if (avg >= 65) return '<span class="badge s-attn">Needs Attention</span>';
    return '<span class="badge s-risk">At Risk</span>';
}

export function standingText(avg) {
    if (avg === null) return 'none';
    if (avg >= 90) return 'excelling';
    if (avg >= 80) return 'good';
    if (avg >= 70) return 'ontrack';
    if (avg >= 65) return 'needsattention';
    return 'atrisk';
}

// ── WEIGHTED MATH ENGINE ────────────────────────────────────────

export function calculateWeightedAverage(grades, gradeTypesData) {
    // 1. Safety check
    if (!grades || grades.length === 0) return null;

    // 2. Determine grade types (Supports new Teacher-level array OR old School-level string)
    let gradeTypes = [];
    if (typeof gradeTypesData === 'string') {
        try {
            const cachedTypes = localStorage.getItem(`connectus_gradeTypes_${gradeTypesData}`);
            if (cachedTypes) gradeTypes = JSON.parse(cachedTypes);
        } catch (e) {
            console.error('[Utils] Failed to parse grade types from cache:', e);
        }
    } else if (Array.isArray(gradeTypesData)) {
        gradeTypes = gradeTypesData;
    }

    // 3. Fallback to flat average if no weights exist in the system yet
    if (!gradeTypes || gradeTypes.length === 0) {
        const totalPct = grades.reduce((sum, g) => {
            return sum + (g.percentage !== undefined ? g.percentage : (g.score / g.max) * 100);
        }, 0);
        return Math.round(totalPct / grades.length);
    }

    // Map weights for quick lookup (handles both objects and plain strings)
    const weightMap = {};
    gradeTypes.forEach(t => {
        if (t && typeof t === 'object' && t.name) {
            // Teacher has configured weights: { name: 'Test', weight: 30 }
            weightMap[t.name.toLowerCase()] = t.weight || 0;
        } else if (typeof t === 'string') {
            // Fallback to default array: 'Test' (treated as equal/no specific weight)
            weightMap[t.toLowerCase()] = 0; 
        }
    });

    // 4. Group the student's actual grades by type
    const groups = {};
    grades.forEach(g => {
        const typeName = (g.type || 'Uncategorized').toLowerCase();
        if (!groups[typeName]) groups[typeName] = { sum: 0, count: 0 };
        
        const pct = g.percentage !== undefined ? g.percentage : ((g.score / g.max) * 100);
        groups[typeName].sum += pct;
        groups[typeName].count += 1;
    });

    // 5. Calculate weighted sum based ONLY on types the student actually has
    let weightedSum = 0;
    let activeWeightTotal = 0;

    for (const [type, data] of Object.entries(groups)) {
        const typeAvg = data.sum / data.count;
        const weight = weightMap[type] !== undefined ? weightMap[type] : 0; 
        
        weightedSum += (typeAvg * weight);
        activeWeightTotal += weight;
    }

    // 6. Failsafe: if grades exist but they somehow all belong to 0% weight categories
    if (activeWeightTotal === 0) {
        const totalPct = grades.reduce((sum, g) => {
            return sum + (g.percentage !== undefined ? g.percentage : (g.score / g.max) * 100);
        }, 0);
        return Math.round(totalPct / grades.length);
    }

    // 7. Normalize the final average against the active weight total
    // (e.g., Auto-scales perfectly to 100% no matter what weights the teacher typed in)
    return Math.round(weightedSum / activeWeightTotal);
}

// ── PHASE 0: TEACHING-ASSIGNMENT GRADE WEIGHTING ─────────────────
// Resolves grade-weighting for a teacher, preferring the new
// schools/{schoolId}/teaching_assignments collection and falling back to
// the legacy teachers/{id}.gradeTypes / .customGradeTypes fields for any
// school not yet migrated. Returns the raw {name,weight}[] array, or null
// if nothing is found anywhere — callers apply their own DEFAULT_GRADE_TYPES
// as the final fallback, exactly as they did before this helper existed.
//
// Pass classId + subjectId when the caller has a specific class+subject in
// view, to get that exact teaching assignment's rubric. Omit them (as
// gradebook.js does, since its weight editor is still one flat rubric
// across every class/subject a teacher has) to match on teacherId alone —
// safe only because saveTeacherWeightingEverywhere() below keeps every one
// of a teacher's teaching_assignment documents identical to each other.
export async function resolveGradeWeights(schoolId, teacherId, { classId, subjectId, legacyTeacherData } = {}) {
    if (schoolId && teacherId) {
        try {
            const constraints = [where('teacherId', '==', teacherId)];
            if (classId)   constraints.push(where('classId', '==', classId));
            if (subjectId) constraints.push(where('subjectId', '==', subjectId));
            const snap = await getDocs(query(collection(db, 'schools', schoolId, 'teaching_assignments'), ...constraints));
            if (!snap.empty) {
                const w = snap.docs[0].data().weighting;
                if (Array.isArray(w) && w.length) return w;
            }
        } catch (e) {
            console.error('[resolveGradeWeights] teaching_assignments lookup failed:', e);
        }
    }
    if (legacyTeacherData) {
        const legacy = legacyTeacherData.gradeTypes || legacyTeacherData.customGradeTypes;
        if (Array.isArray(legacy) && legacy.length) return legacy;
    }
    return null;
}

// The same global-vs-school-scoped teacher-ID duality that subjects.js,
// grade_form.js, and archives.js each already carry their own identical
// copy of (as getTeacherRef()) — added here so gradebook.js's weighting
// save, which was missing this check entirely, can use it too.
export function getTeacherDocRef(schoolId, teacherId) {
    return /^T\d{2}-[A-Z0-9]{5}$/i.test(teacherId)
        ? doc(db, 'teachers', teacherId)
        : doc(db, 'schools', schoolId, 'teachers', teacherId);
}

// Writes the same weighting array to the legacy teacher document AND to
// every schools/{schoolId}/teaching_assignments document belonging to this
// teacher, in one atomic batch — so a save keeps behaving identically for
// every screen not yet repointed to the new source (still reading the
// legacy fields directly), while also becoming the correct long-term write
// target. Safe to call even when the teacher has zero teaching_assignments
// yet (not migrated, or none resolved) — the legacy write alone still
// covers that case exactly as it did before this existed.
export async function saveTeacherWeightingEverywhere(schoolId, teacherId, weighting) {
    const batch = writeBatch(db);
    batch.update(getTeacherDocRef(schoolId, teacherId), { gradeTypes: weighting, customGradeTypes: weighting });

    let teachingAssignmentCount = 0;
    try {
        const snap = await getDocs(query(collection(db, 'schools', schoolId, 'teaching_assignments'), where('teacherId', '==', teacherId)));
        snap.forEach(d => { batch.update(d.ref, { weighting }); teachingAssignmentCount++; });
    } catch (e) {
        console.error('[saveTeacherWeightingEverywhere] teaching_assignments lookup failed:', e);
    }

    await batch.commit();
    return { teachingAssignmentCount };
}

// ── PHASE 0: CLASS-NAME RESOLUTION ───────────────────────────────
// A teacher or student's link to a class is currently a plain name string
// (classes[] array, or a single className) rather than a reference to the
// real schools/{schoolId}/classes/{classId} document. Anything that needs a
// real classId — creating a class-scoped subject, for instance — has to
// resolve that name against the real class documents first, the same way
// migrate-phase0.js already does. loadSchoolClasses() fetches every class
// document for a school once; resolveClassNamesToIds() is a pure function
// so callers can match several teacher/student name lists against that one
// fetch without re-querying.
export async function loadSchoolClasses(schoolId) {
    const snap = await getDocs(collection(db, 'schools', schoolId, 'classes'));
    return snap.docs.map(d => ({ id: d.id, ...d.data() }));
}

export function resolveClassNamesToIds(classNames, schoolClasses) {
    const byName = new Map(schoolClasses.map(c => [c.name, c.id]));
    const resolved = [];
    const orphaned = [];
    (classNames || []).filter(Boolean).forEach(name => {
        const id = byName.get(name);
        if (id) resolved.push({ name, id });
        else orphaned.push(name);
    });
    return { resolved, orphaned };
}

// ── PHASE 0: SHARED SUBJECTS CACHE (single source of truth) ──────
// Every teacher-facing page that reads or writes subjects/assignments
// (subjects.js, grade_form.js, archives.js) needs the exact same merged
// view: real per-class subjects from schools/{schoolId}/classes/{classId}
// /subjects[/subjectId/assignments] (_source:'new'), plus any legacy
// subject still embedded in teachers/{id}.subjects whose name isn't
// already represented in that new-model list (_source:'legacy'). A
// teacher/school not yet migrated sees no change at all, and nothing is
// ever silently dropped. This one function is now the only place that
// merge logic lives — previously subjects.js had its own private copy;
// it now calls this too, so a fix here reaches every caller at once.
//
// Every _source:'new' subject's assignments subcollection is fetched
// up front so callers get a fully-populated sub.assignments array for
// every subject, not just whichever one a panel happens to have open —
// the same shape a _source:'legacy' subject already carries embedded.
//
// Returns { subjectsCache, resolvedClasses } — resolvedClasses is only
// needed by callers that let the teacher pick a class (subjects.js's
// "Add Subject" modal); other callers can ignore it.
export async function loadTeacherSubjectsCache(schoolId, teacherId, legacyTeacherData) {
    let resolvedClasses = [];
    let subjectsCache = [];

    const classNames = (legacyTeacherData && legacyTeacherData.classes) || [(legacyTeacherData && legacyTeacherData.className) || ''];
    try {
        const schoolClasses = await loadSchoolClasses(schoolId);
        resolvedClasses = resolveClassNamesToIds(classNames, schoolClasses).resolved;
    } catch (e) {
        console.error('[loadTeacherSubjectsCache] Failed to resolve classes:', e);
    }

    for (const cls of resolvedClasses) {
        try {
            const snap = await getDocs(collection(db, 'schools', schoolId, 'classes', cls.id, 'subjects'));
            for (const d of snap.docs) {
                const subject = { id: d.id, classId: cls.id, className: cls.name, _source: 'new', assignments: [], ...d.data() };
                try {
                    const asgSnap = await getDocs(collection(db, 'schools', schoolId, 'classes', cls.id, 'subjects', subject.id, 'assignments'));
                    subject.assignments = asgSnap.docs.map(ad => ({ id: ad.id, ...ad.data() }));
                } catch (e) {
                    console.error(`[loadTeacherSubjectsCache] Failed to load assignments for subject "${subject.name}":`, e);
                }
                subjectsCache.push(subject);
            }
        } catch (e) {
            console.error(`[loadTeacherSubjectsCache] Failed to load subjects for class "${cls.name}":`, e);
        }
    }

    const newNames = new Set(subjectsCache.map(s => s.name));
    ((legacyTeacherData && legacyTeacherData.subjects) || []).forEach(s => {
        if (!newNames.has(s.name)) subjectsCache.push({ ...s, _source: 'legacy' });
    });

    return { subjectsCache, resolvedClasses };
}

// ── PHASE 0: SCHOOL-WIDE SUBJECTS INDEX (batch, N+1-safe) ────────
// The admin Teachers page renders every teacher in the school at once (the
// staff table, the CSV export), so calling loadTeacherSubjectsCache() once
// per teacher would mean one-or-more Firestore queries per row — an N+1
// query pattern that gets slower the more teachers a school has. This pair
// of functions splits that same merge logic into a single batched fetch
// (loadSchoolSubjectsIndex, called ONCE per page load) plus a pure
// in-memory merge (mergeTeacherSubjectsFromIndex, called once per teacher
// with no additional queries) so every row reflects real dual-mode data —
// including subjects already migrated to the new per-class model — without
// re-querying Firestore for each one.
//
// Only name/archived-level fields are collected here (no assignments
// subcollection fetch) since every current caller (staff table counts, CSV
// export, portfolio print, exit-snapshot subject lists) only ever needs
// subject names — callers that need a specific teacher's full assignment
// detail (the Subjects tab inside a teacher's own panel) should keep using
// loadTeacherSubjectsCache() for that one teacher instead.
export async function loadSchoolSubjectsIndex(schoolId) {
    const schoolClasses = await loadSchoolClasses(schoolId);
    const subjectsByClassId = new Map();
    await Promise.all(schoolClasses.map(async cls => {
        try {
            const snap = await getDocs(collection(db, 'schools', schoolId, 'classes', cls.id, 'subjects'));
            subjectsByClassId.set(cls.id, snap.docs.map(d => ({ id: d.id, classId: cls.id, className: cls.name, _source: 'new', ...d.data() })));
        } catch (e) {
            console.error(`[loadSchoolSubjectsIndex] Failed to load subjects for class "${cls.name}":`, e);
            subjectsByClassId.set(cls.id, []);
        }
    }));
    return { schoolClasses, subjectsByClassId };
}

// Pure function: merges one teacher's legacy subjects with the pre-fetched
// school-wide index above. No Firestore access, so it's safe to call once
// per teacher in a loop. Mirrors loadTeacherSubjectsCache()'s merge rule
// exactly (new-model subjects for the teacher's resolved classes, plus any
// legacy-embedded subject whose name isn't already represented) — except
// for the pre-Phase-0 "legacy string-array subjects" shape (teachers whose
// .subjects is a plain string[] rather than object[]), which migrate-phase0.js
// already treats as unsupported/skipped; that shape is passed through as-is
// here too rather than merged, so a not-yet-normalized teacher's staff-table
// row keeps showing exactly what it always has instead of corrupting into
// spread-string objects.
export function mergeTeacherSubjectsFromIndex(legacyTeacherData, schoolSubjectsIndex) {
    const legacySubjects = (legacyTeacherData && legacyTeacherData.subjects) || [];
    if (legacySubjects.length && typeof legacySubjects[0] === 'string') {
        return { subjectsCache: legacySubjects, resolvedClasses: [] };
    }

    const { schoolClasses, subjectsByClassId } = schoolSubjectsIndex;
    const classNames = (legacyTeacherData && legacyTeacherData.classes) || [(legacyTeacherData && legacyTeacherData.className) || ''];
    const resolvedClasses = resolveClassNamesToIds(classNames, schoolClasses).resolved;

    const subjectsCache = [];
    const seenIds = new Set();
    resolvedClasses.forEach(cls => {
        (subjectsByClassId.get(cls.id) || []).forEach(s => {
            if (!seenIds.has(s.id)) { seenIds.add(s.id); subjectsCache.push(s); }
        });
    });

    const newNames = new Set(subjectsCache.map(s => s.name));
    legacySubjects.forEach(s => {
        if (!newNames.has(s.name)) subjectsCache.push({ ...s, _source: 'legacy' });
    });

    return { subjectsCache, resolvedClasses };
}

// ── PHASE 0: SCHOOL-WIDE WEIGHTING INDEX (batch, N+1-safe) ────────
// The multi-teacher admin dashboards (admin/reports.js, admin/home.js,
// admin/classes.js) each render every teacher in the school at once, so
// calling resolveGradeWeights() once per teacher would mean one Firestore
// query per row — the same N+1 pattern loadSchoolSubjectsIndex() above
// was built to avoid, just for weighting instead of subjects. This is a
// single batched fetch of every schools/{schoolId}/teaching_assignments
// document (no filter), reduced to one weighting array per teacherId —
// first document wins, exactly mirroring resolveGradeWeights()'s own
// "first matching doc" behavior so the batch path and the single-teacher
// path can never disagree about which weighting is authoritative for a
// given teacher.
export async function loadSchoolWeightingIndex(schoolId) {
    const weightingByTeacherId = new Map();
    try {
        const snap = await getDocs(collection(db, 'schools', schoolId, 'teaching_assignments'));
        snap.docs.forEach(d => {
            const data = d.data();
            if (data.teacherId && !weightingByTeacherId.has(data.teacherId) && Array.isArray(data.weighting) && data.weighting.length) {
                weightingByTeacherId.set(data.teacherId, data.weighting);
            }
        });
    } catch (e) {
        console.error('[loadSchoolWeightingIndex] teaching_assignments lookup failed:', e);
    }
    return weightingByTeacherId;
}

// Pure function: resolves one teacher's weighting from the pre-fetched
// index above, falling back to their legacy gradeTypes/customGradeTypes
// fields, exactly mirroring resolveGradeWeights()'s own fallback chain —
// so a batch-rendered row and a single-teacher resolveGradeWeights() call
// can never disagree. Returns null (not a default) when nothing is found
// anywhere, same as resolveGradeWeights() — callers apply their own
// DEFAULT_GRADE_TYPES as the final fallback.
export function getWeightingFromIndex(weightingByTeacherId, teacherId, legacyTeacherData) {
    const fromIndex = teacherId && weightingByTeacherId.get(teacherId);
    if (fromIndex) return fromIndex;
    const legacy = legacyTeacherData && (legacyTeacherData.gradeTypes || legacyTeacherData.customGradeTypes);
    if (Array.isArray(legacy) && legacy.length) return legacy;
    return null;
}

// ── SHARED HEADER INFO (school name + active period label) ──────
// Every student page's sidebar/topbar ships with static "Loading..."
// placeholders for #displaySchoolName and #activeSemesterDisplay (the
// session only caches schoolId, not the school's display name), so each
// page has always been responsible for fetching the school doc — and, for
// the active semester's name, its doc — and setting those two elements
// itself once the fetch resolves. That per-page fetch already exists on
// home.js/grades.js/history.js/reports.js/evaluations.js/settings.js; this
// is the same lookup, pulled out so Stream and Assignments (both newer,
// both missing it) can call one shared, tested helper instead of a third
// and fourth copy-pasted fetch block. Callers still own setting the DOM
// themselves, matching how every existing page already does it.
export async function loadSchoolHeaderInfo(schoolId) {
    let schoolName = 'ConnectUs School';
    let semesterName = 'Unknown Period';
    try {
        const schoolSnap = await getDoc(doc(db, 'schools', schoolId));
        const schoolData = schoolSnap.exists() ? schoolSnap.data() : null;
        if (schoolData?.schoolName) schoolName = schoolData.schoolName;
        if (schoolData?.activeSemesterId) {
            const semSnap = await getDoc(doc(db, 'schools', schoolId, 'semesters', schoolData.activeSemesterId));
            if (semSnap.exists() && semSnap.data().name) semesterName = semSnap.data().name;
        }
    } catch (e) {
        console.error('[loadSchoolHeaderInfo] Failed to load school/semester info:', e);
    }
    return { schoolName, semesterName };
}

// ── PHASE 1 MILESTONE 5: SHARED GRADE WRITE (create-or-update) ──────────
// Single write path for every grade a teacher records, whether from
// grade_form.js's roster-by-roster flow or the inline Review Submissions
// panel on the Subjects page (subjects.js). Approved design decision: a
// grade tied to a prepared assignment (assignmentId set) must NEVER be
// duplicated — two grade docs for the same student+assignment would
// silently corrupt calculateWeightedAverage() upstream. So when a grade
// doc already exists for this studentId+assignmentId, this UPDATES it in
// place and appends a {timestamp, oldScore, newScore} entry to its
// existing historyLogs array, instead of ever creating a second document.
// A manual, one-off grade with no assignmentId has nothing to key a
// duplicate check on, so it's always a plain create — exactly the
// grade_form.js manual-entry behavior this replaces.
//
// @param {string} studentId
// @param {string|null} assignmentId - omit/null for a one-off manual grade
// @param {object} fields - { schoolId, teacherId, semesterId, className, subject, type, date, title, score, max, notes }
// @returns {Promise<{id: string, created: boolean}>}
export async function saveGrade(studentId, assignmentId, fields) {
    const gradesRef = collection(db, 'students', studentId, 'grades');

    if (assignmentId) {
        const existingSnap = await getDocs(query(gradesRef, where('assignmentId', '==', assignmentId)));
        if (!existingSnap.empty) {
            const existingDoc = existingSnap.docs[0];
            const existing = existingDoc.data();
            const historyEntry = {
                timestamp: new Date().toISOString(),
                oldScore: existing.score,
                newScore: fields.score,
            };
            const historyLogs = Array.isArray(existing.historyLogs) ? [...existing.historyLogs, historyEntry] : [historyEntry];

            await updateDoc(existingDoc.ref, { ...fields, assignmentId, historyLogs });
            return { id: existingDoc.id, created: false };
        }
    }

    const record = { ...fields, historyLogs: [], createdAt: new Date().toISOString() };
    if (assignmentId) record.assignmentId = assignmentId;
    const ref = await addDoc(gradesRef, record);
    return { id: ref.id, created: true };
}

// ── DATA EXPORT ─────────────────────────────────────────────────

export function downloadCSV(rows, fn) {
    const csv = rows.map(r => r.map(v => `"${String(v ?? '').replace(/"/g, '""')}"`).join(',')).join('\n');
    const a = Object.assign(document.createElement('a'), {
        href: URL.createObjectURL(new Blob([csv], { type: 'text/csv' })),
        download: fn
    });
    document.body.appendChild(a);
    a.click();
    a.remove();
}
