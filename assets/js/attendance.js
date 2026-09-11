// ── PHASE 1 MILESTONE 6: ATTENDANCE ───────────────────────────────────────
// Approved data model: one document per class per day —
//   schools/{schoolId}/classes/{classId}/attendance/{date}
// where {date} is the document ID itself, as a YYYY-MM-DD string (same
// format <input type="date"> already gives every other page in this app).
// The whole day's roster is written in a single setDoc — one write per
// class per day, no matter how many students are on the roster — with a
// `records` map keyed by studentId:
//   { records: { [studentId]: { status, markedAt, markedBy } }, ... }
//
// Because the document ID IS the date, a range of days is just a query
// filtered by documentId() between two date strings — YYYY-MM-DD strings
// sort correctly as plain strings, so this needs no extra field, no
// composite index, and no fan-out write to a per-student collection.
// Firestore's default per-collection __name__ index covers documentId()
// range queries automatically. loadAttendanceHistoryForStudent() below is
// exactly that range query, with one student's entry plucked out of each
// day doc — the mechanism approved for "a student can still efficiently
// query their own attendance history across the semester" without any
// additional writes.
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
// Pulls just that student's entry out of each day doc in the range —
// days where the student has no entry (day not yet taken, or the student
// wasn't marked that day) are simply absent from the result, not an error.
export async function loadAttendanceHistoryForStudent(schoolId, classId, studentId, startDate, endDate) {
    const days = await loadAttendanceRangeForClass(schoolId, classId, startDate, endDate);
    return days
        .filter(day => day.records && day.records[studentId])
        .map(day => ({ date: day.id, ...day.records[studentId] }));
}
