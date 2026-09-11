// ── Shared client-side PIN hashing helper ─────────────────────────────────
// SHA-256, trim-whitespace-only, case preserved. This MUST stay byte-for-byte
// identical to sha256Trim() in functions/index.js (the server-side copy used
// by mintTeacherToken / mintStudentToken / mintHQToken) — if the two ever
// diverge, a PIN hashed on one side will never match a comparison made on
// the other, and logins will silently start failing.
//
// Previously this exact function body was copy-pasted independently in
// half a dozen files (teacher/settings, teacher/onboarding, student/settings,
// admin/settings, etc.). Centralizing it here means any future fix or
// review only has to happen once.
export async function sha256Trim(text) {
    const encoded = new TextEncoder().encode(String(text).trim());
    const buffer  = await crypto.subtle.digest('SHA-256', encoded);
    return Array.from(new Uint8Array(buffer)).map(b => b.toString(16).padStart(2, '0')).join('');
}
