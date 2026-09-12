// ── PHASE 1 MILESTONE 6: ATTENDANCE ───────────────────────────────────────
// Approved data model: one document per class per day —
//   schools/{schoolId}/classes/{classId}/attendance/{date}
// where {date} is the document ID itself, as a YYYY-MM-DD string (same
// format <input type="date"> already gives every other page in this app).
// The whole day's roster is written in a single setDoc — one write per
// class per day, no matter how many students are on the roster — with a
// `records` map keyed by studentId:
//   { records: { [studentId]: { status, markedAt, markedBy } }, ... }
// This remains the only thing the teacher/admin UI ever reads or writes.
//
// ── Privacy fix (fan-out) ─────────────────────────────────────────────────
// A student was originally read out of this same class-day document
// (loadAttendanceHistoryForStudent used to range-query the class's
// `attendance` subcollection and pluck one entry out of each day's
// `records` map). That was a real data-scoping gap: Firestore security
// rules can only grant or deny a whole document, never a single key inside
// its map, so any rule letting an enrolled student read that document at
// all handed back every classmate's status too — confirmed by inspecting
// the raw SDK payload during Phase 1 Milestone 6 testing, not just what the
// UI happened to render.
//
// The fix: the onAttendanceSaved Cloud Function (functions/index.js) fans
// each class-day save out, server-side via the Admin SDK, into a genuinely
// per-student document at students/{studentId}/attendance/{date}. Students
// now read ONLY that fanned-out path — loadAttendanceHistoryForStudent
// below queries students/{studentId}/attendance directly, never the class
// document. The security rule on students/{studentId}/attendance/{attDate}
// denies all client writes (including the owning student's own), so this
// path can never be used to fabricate or alter a status either.
import { db } from './firebase-init.js';
import { collection, doc, getDoc, getDocs, setDoc, query, where, orderBy, documentId }
    from "https://www.gstatic.com/firebasejs/10.7.1/firebase-firestore.js";

export const ATTENDANCE_STATUSES = ['present', 'absent', 'tardy', 'excused'];

function attendanceDayRef(schoolId, classId, date) {
    return doc(db, 'schools', schoolId, 'classes', classId, 'attendance', date);
}

// ── READ: one class's attendance for one specific day ───────────────────
// Returns { date, classId, records: {} } (empty records) when that day
// hasn't been taken yet, rather than null — callers can always safely read
// .records[studentId] without an extra existence check.
export async function loadAttendanceForDate(schoolId, classId, date) {
    const snap = await getDoc(attendanceDayRef(schoolId, classId, date));
    return snap.exists() ? snap.data() : { date, classId, records: {} };
}

// ── WRITE: the whole day's roster in one shot ────────────────────────────
// `records` must be the COMPLETE map for this day (every student the
// teacher marked, keyed by studentId) — this is a full setDoc overwrite,
// not a merge. That's deliberate: if a student is later removed from the
// roster passed in (transferred out, roster correction), their stale entry
// from a previous save must not linger in the document. Re-saving the same
// date (a teacher correcting today's attendance) is simply idempotent —
// same doc ID, new content, no duplicate and no history array (unlike
// grades, attendance has no re-grade audit requirement in this milestone).
export async function saveAttendanceForDate(schoolId, classId, date, records, markedBy) {
    const payload = {
        date,
        classId,
        records,
        updatedAt: new Date().toISOString(),
        updatedBy: markedBy,
    };
    await setDoc(attendanceDayRef(schoolId, classId, date), payload);
    return payload;
}

// ── READ: every day-doc for a class within a date range, oldest first ───
// startDate/endDate are inclusive YYYY-MM-DD strings. Used directly by the
// admin/teacher "view a range" flows, and as the building block for
// loadAttendanceHistoryForStudent() below.
export async function loadAttendanceRangeForClass(schoolId, classId, startDate, endDate) {
    const q = query(
        collection(db, 'schools', schoolId, 'classes', classId, 'attendance'),
        where(documentId(), '>=', startDate),
        where(documentId(), '<=', endDate),
        orderBy(documentId())
    );
    const snap = await getDocs(q);
    return snap.docs.map(d => ({ id: d.id, ...d.data() }));
}

// ── READ: one student's own attendance history across a date range ──────
// Queries the student's own fanned-out students/{studentId}/attendance
// collection directly — never the class-day document, which any enrolled
// student's Firestore rule intentionally no longer grants read access to
// (see the long comment at the top of this file). The document ID here is
// still the YYYY-MM-DD date string, written by onAttendanceSaved to match
// the class-day doc it was fanned out from, so this is the same cheap
// documentId() range query as before — just against a collection that is
// genuinely scoped to one student instead of a whole class.
// classId/schoolId are accepted for call-site compatibility (existing
// callers pass them) but are no longer used to build the query; the
// fanned-out documents already carry their own classId/schoolId fields.
export async function loadAttendanceHistoryForStudent(schoolId, classId, studentId, startDate, endDate) {
    const q = query(
        collection(db, 'students', studentId, 'attendance'),
        where(documentId(), '>=', startDate),
        where(documentId(), '<=', endDate),
        orderBy(documentId())
    );
    const snap = await getDocs(q);
    return snap.docs.map(d => ({ date: d.id, ...d.data() }));
}
