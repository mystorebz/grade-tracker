// ── PHASE 1 MILESTONE 4: STUDENT ASSIGNMENT SUBMISSIONS ──────────────────
// Submissions live at the same class-scoped depth assignments themselves do:
//   schools/{schoolId}/classes/{classId}/subjects/{subjectId}/assignments/{assignmentId}/submissions/{studentId}
// — one document per student per assignment (doc id = studentId), so saving
// is a plain idempotent setDoc and "has this student submitted" is a single
// getDoc. Exactly like posts.js's bridging of legacy subjects, a legacy
// assignment (no real assignment document of its own — it's just an object
// embedded in the teacher's own doc) still gets a real, working submissions
// subcollection here, because Firestore never requires a parent document to
// exist for a subcollection nested under it to work. classId is resolved
// with the same resolvePostContext() helper posts.js already uses, imported
// from there rather than duplicated.
import { db, storage } from './firebase-init.js';
import { collection, doc, getDoc, getDocs, setDoc, query, where }
    from "https://www.gstatic.com/firebasejs/10.7.1/firebase-firestore.js";
import { ref as storageRef, uploadBytes, getDownloadURL }
    from "https://www.gstatic.com/firebasejs/10.7.1/firebase-storage.js";
import { resolvePostContext } from './posts.js';

// ── MERGED ASSIGNMENT LIST (legacy + new-model, unified) ─────────────────
// subjectsCache/resolvedClasses are exactly what loadTeacherSubjectsCache()
// in utils.js already returns. That helper has ALREADY fetched every
// _source:'new' subject's real assignments subcollection AND merged in
// every _source:'legacy' subject's embedded assignments array, attaching
// both as subject.assignments in the same shape either way. So unifying
// them here needs no extra Firestore reads at all — this is a pure
// in-memory flatten, not a fetch. Raw assignment objects (from either
// source) don't carry classId/subjectId themselves, so each one is
// annotated with its resolved context here — callers (and this module's
// own save/load below) never have to re-derive it.
export function loadAssignmentsForSubjects(subjectsCache, resolvedClasses) {
    const assignments = [];
    for (const subject of subjectsCache) {
        if (subject.archived) continue;
        const context = resolvePostContext(subject, resolvedClasses);
        if (!context) continue; // no class could be resolved — skip, same as posts.js
        for (const a of (subject.assignments || [])) {
            assignments.push({ ...a, ...context });
        }
    }
    return assignments;
}

function assignmentSubmissionRef(schoolId, assignment, studentId) {
    const { classId, subjectId, id: assignmentId } = assignment;
    return doc(db, 'schools', schoolId, 'classes', classId, 'subjects', subjectId, 'assignments', assignmentId, 'submissions', studentId);
}

// ── READ: one student's submission for one assignment ────────────────────
export async function loadSubmission(schoolId, assignment, studentId) {
    const snap = await getDoc(assignmentSubmissionRef(schoolId, assignment, studentId));
    return snap.exists() ? snap.data() : null;
}

// ── READ: every submission for a list of assignments, in parallel ────────
// Used to paint "Not submitted / Submitted" status on the assignment list
// itself, without opening each one — same one-query-per-item shape
// loadPostsForSubjects() already uses for the Class Stream, just keyed by
// assignmentId instead of merged into one flat feed.
export async function loadSubmissionsForAssignments(schoolId, assignments, studentId) {
    const map = new Map();
    await Promise.all(assignments.map(async a => {
        try {
            map.set(a.id, await loadSubmission(schoolId, a, studentId));
        } catch (e) {
            console.error(`[Submissions] loadSubmissionsForAssignments failed for assignment ${a.id}:`, e);
            map.set(a.id, null);
        }
    }));
    return map;
}

// ── WRITE: create or update (doc id = studentId, so this is idempotent) ──
// Callers are responsible for checking isSubmissionFrozen() first — this
// function itself does not re-check locked/graded state, so it stays a
// plain, honest read-modify-write with no hidden business rules.
//
// PHASE 3 STEP 2: extended (not forked) to also accept a `responses` array
// for Add Work assessment submissions, alongside the original responseText/
// linkUrl shape for standard work and legacy assignments. Both shapes keep
// every existing denormalized field (assignmentTitle, subjectId/Name,
// classId/className) — the plan this replaced would have written a
// differently-shaped doc for assessments (dropping those fields entirely),
// which would have silently broken any teacher-side code that already
// reads them off a submission record. `status`/`workType` are additive on
// both shapes. submittedAt/updatedAt stay ISO strings, matching this
// function's existing convention, rather than mixing in serverTimestamp()
// for only one of the two submission shapes.
export async function saveSubmission(schoolId, assignment, studentId, studentName, { responseText, linkUrl, responses } = {}) {
    const ref = assignmentSubmissionRef(schoolId, assignment, studentId);
    const existing = await getDoc(ref);
    const now = new Date().toISOString();

    const record = {
        studentId, studentName,
        assignmentId: assignment.id,
        assignmentTitle: assignment.title,
        workType: assignment.workType || assignment.type || null,
        subjectId: assignment.subjectId,
        subjectName: assignment.subjectName,
        classId: assignment.classId,
        className: assignment.className,
        status: 'submitted',
        submittedAt: existing.exists() ? existing.data().submittedAt : now,
        updatedAt: now
    };

    if (Array.isArray(responses)) {
        record.responses = responses;
        record.responseText = null;
        record.linkUrl = null;
    } else {
        record.responseText = (responseText || '').trim();
        record.linkUrl = (linkUrl || '').trim() || null;
    }

    await setDoc(ref, record, { merge: true });
    return record;
}

// ── STORAGE: one attachment_response answer -> a real, downloadable URL ──
// Called only at submit time (never on file/photo pick, never mid-drawing),
// so nothing uploads until the student actually hits Submit. `source` is
// either a data: URL (a drawing canvas's toDataURL() output) or a real File
// (from a file/photo <input>) — collectStudentResponses() in assignments.js
// only ever captures a LOCAL reference (a data: URL or a bare file name);
// resolving that into an uploaded, publicly-fetchable URL happens here,
// against the schools/{schoolId}/submissions/{assignmentId}/{studentId}/
// {questionId}_{timestamp} path storage.rules scopes to this student alone.
function dataUrlToBlob(dataUrl) {
    const [header, base64] = dataUrl.split(',');
    const mime = header.match(/data:(.*?);base64/)?.[1] || 'image/png';
    const binary = atob(base64);
    const bytes = new Uint8Array(binary.length);
    for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
    return new Blob([bytes], { type: mime });
}

const EXT_BY_MIME = { 'image/png': 'png', 'image/jpeg': 'jpg', 'image/jpg': 'jpg', 'application/pdf': 'pdf' };

export async function uploadSubmissionAttachment(schoolId, assignment, studentId, questionId, source) {
    const blob = typeof source === 'string' ? dataUrlToBlob(source) : source;
    const ext = EXT_BY_MIME[blob.type] || (blob.name?.split('.').pop()) || 'bin';
    const path = `schools/${schoolId}/submissions/${assignment.id}/${studentId}/${questionId}_${Date.now()}.${ext}`;
    const fileRef = storageRef(storage, path);
    await uploadBytes(fileRef, blob);
    return getDownloadURL(fileRef);
}

// ── READ: every submission for ONE assignment, across the whole class ────
// PHASE 1 MILESTONE 5: used by the teacher-side Review Submissions panel
// (subjects.js) to see, in a single query, which students on the roster
// have turned something in — the mirror image of
// loadSubmissionsForAssignments() above, which reads across many
// assignments for one student instead of many students for one assignment.
export async function loadSubmissionsForAssignment(schoolId, assignment) {
    const map = new Map();
    try {
        const { classId, subjectId, id: assignmentId } = assignment;
        const snap = await getDocs(collection(db, 'schools', schoolId, 'classes', classId, 'subjects', subjectId, 'assignments', assignmentId, 'submissions'));
        snap.docs.forEach(d => map.set(d.id, { id: d.id, ...d.data() }));
    } catch (e) {
        console.error('[Submissions] loadSubmissionsForAssignment:', e);
    }
    return map;
}

// ── GRADE LOOKUP: one assignmentId -> grade-record map per student ───────
// A single query over the student's whole grades subcollection instead of
// one query per assignment — the same "build once, look up many" shape
// isStudentGraded() already uses on the teacher side, just inverted to the
// student's own grades. Grades recorded manually (not from a prepared
// assignment) carry no assignmentId and are simply absent from this map —
// that assignment correctly renders as ungraded, since it was never tied
// back to this specific assignment record.
export async function loadGradesIndexForStudent(schoolId, studentId) {
    const map = new Map();
    try {
        const q = query(
            collection(db, 'students', studentId, 'grades'),
            where('schoolId', '==', schoolId)
        );
        const snap = await getDocs(q);
        snap.docs.forEach(d => {
            const data = d.data();
            if (data.assignmentId) map.set(data.assignmentId, { id: d.id, ...data });
        });
    } catch (e) {
        console.error('[Submissions] loadGradesIndexForStudent:', e);
    }
    return map;
}

// ── FREEZE RULE: locked OR graded blocks further submission writes ───────
// Approved decision: once a grade exists for an assignment, the submission
// underneath it freezes regardless of the locked flag — a teacher would
// need to reopen it (unlock, or remove the grade) rather than have a
// student silently edit graded work. Kept as one small shared predicate so
// the list view's status pill and the detail panel's form-vs-readonly
// decision can never disagree with each other.
export function isSubmissionFrozen(assignment, gradesIndex) {
    return !!assignment.locked || gradesIndex.has(assignment.id);
}
