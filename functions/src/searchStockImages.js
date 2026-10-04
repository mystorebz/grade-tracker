// functions/src/searchStockImages.js — stock-photo proxy for the lesson canvas (Unsplash)
//
//   searchStockImages({ query, page })                        staff only
//   importStockImage({ schoolId, lessonId, objectId, id })    staff only
//
// The API key never reaches the browser: it lives in Secret Manager as
//   UNSPLASH_ACCESS_KEY
// importStockImage re-fetches the photo by id from Unsplash (the client
// never supplies a URL — no SSRF), downscales to a 2400px max edge, encodes
// WebP @85 and writes it to the school's bucket at
//   schools/{schoolId}/lessons/{lessonId}/media/{objectId}.webp
// so slides never hotlink a third-party CDN. The photographer attribution
// Unsplash requires is returned as `credit` and stored on the object.

const { onCall, HttpsError } = require('firebase-functions/v2/https');
const { defineSecret } = require('firebase-functions/params');
const admin = require('firebase-admin');
const crypto = require('crypto');

const UNSPLASH_ACCESS_KEY = defineSecret('UNSPLASH_ACCESS_KEY');

const STAFF_ROLES = new Set(['teacher', 'super_admin', 'sub_admin']);
const ID_RE = /^[A-Za-z0-9_-]{1,100}$/;
const MAX_EDGE = 2400;
const MAX_SOURCE_BYTES = 30 * 1024 * 1024;
const UTM = 'utm_source=connectus&utm_medium=referral';

function requireStaff(request, schoolId) {
    const t = request.auth && request.auth.token;
    if (!t || !STAFF_ROLES.has(t.role)) throw new HttpsError('permission-denied', 'Only teachers can use the photo library.');
    if (schoolId !== undefined && t.schoolId !== schoolId) throw new HttpsError('permission-denied', 'School mismatch.');
    return t;
}

function unsplashKey() {
    let v = '';
    try { v = String(UNSPLASH_ACCESS_KEY.value() || '').trim(); } catch (e) { v = ''; }
    if (!v) throw new HttpsError('failed-precondition', 'The photo library is not configured yet (no Unsplash key).');
    return v;
}

async function getJson(url, key) {
    const res = await fetch(url, { headers: { 'Accept-Version': 'v1', Authorization: `Client-ID ${key}` } });
    if (res.status === 401 || res.status === 403) throw new HttpsError('failed-precondition', 'The Unsplash key was rejected.');
    if (res.status === 404) throw new HttpsError('not-found', 'That photo is no longer available.');
    if (res.status === 429) throw new HttpsError('resource-exhausted', 'The photo library is busy — try again in a minute.');
    if (!res.ok) throw new HttpsError('unavailable', `Unsplash error (${res.status}).`);
    return res.json();
}

function creditOf(p) {
    const name = (p.user && (p.user.name || p.user.username)) || 'Unsplash';
    const profile = p.user && p.user.links && p.user.links.html;
    return { name, url: profile ? `${profile}?${UTM}` : `https://unsplash.com/?${UTM}`, provider: 'Unsplash', providerUrl: `https://unsplash.com/?${UTM}` };
}

function normalize(p) {
    return {
        id: p.id, provider: 'unsplash', thumb: p.urls && (p.urls.small || p.urls.thumb), w: p.width, h: p.height,
        alt: (p.alt_description || p.description || '').slice(0, 300), color: p.color || null, credit: creditOf(p),
    };
}

exports.searchStockImages = onCall({
    region: 'us-central1', secrets: [UNSPLASH_ACCESS_KEY], timeoutSeconds: 20, maxInstances: 10,
}, async (request) => {
    requireStaff(request);
    const data = request.data || {};
    const query = String(data.query || '').trim().slice(0, 100);
    if (!query) throw new HttpsError('invalid-argument', 'Type something to search for.');
    const page = Math.min(50, Math.max(1, parseInt(data.page, 10) || 1));
    const key = unsplashKey();
    const url = `https://api.unsplash.com/search/photos?query=${encodeURIComponent(query)}&page=${page}&per_page=24&content_filter=high`;
    const json = await getJson(url, key);
    return { provider: 'unsplash', page, total: json.total || 0, totalPages: json.total_pages || 0, results: (json.results || []).map(normalize) };
});

exports.importStockImage = onCall({
    region: 'us-central1', secrets: [UNSPLASH_ACCESS_KEY], timeoutSeconds: 60, memory: '1GiB', maxInstances: 10,
}, async (request) => {
    const data = request.data || {};
    const { schoolId, lessonId, objectId, id } = data;
    if (![schoolId, lessonId, objectId, id].every((v) => typeof v === 'string' && ID_RE.test(v))) {
        throw new HttpsError('invalid-argument', 'schoolId, lessonId, objectId and id are required.');
    }
    requireStaff(request, schoolId);
    const key = unsplashKey();

    // 1. resolve the photo server-side (never trust a client URL)
    const p = await getJson(`https://api.unsplash.com/photos/${encodeURIComponent(id)}`, key);
    const raw = (p.urls && p.urls.raw) || '';
    const sourceUrl = `${raw}${raw.includes('?') ? '&' : '?'}w=${MAX_EDGE}&fit=max&fm=jpg&q=90`;
    let host = '';
    try { host = new URL(sourceUrl).hostname; } catch (e) { host = ''; }
    if (host !== 'images.unsplash.com') throw new HttpsError('failed-precondition', 'Unexpected image host.');
    const credit = creditOf(p);
    const alt = (p.alt_description || p.description || '').slice(0, 300);
    // Unsplash API guideline: register the download.
    if (p.links && p.links.download_location) {
        fetch(p.links.download_location, { headers: { Authorization: `Client-ID ${key}` } }).catch(() => {});
    }

    // 2. download + normalise
    const res = await fetch(sourceUrl);
    if (!res.ok) throw new HttpsError('unavailable', `Could not download the photo (${res.status}).`);
    const length = Number(res.headers.get('content-length') || 0);
    if (length > MAX_SOURCE_BYTES) throw new HttpsError('failed-precondition', 'That photo is too large.');
    const input = Buffer.from(await res.arrayBuffer());
    if (input.length > MAX_SOURCE_BYTES) throw new HttpsError('failed-precondition', 'That photo is too large.');

    const sharp = require('sharp'); // lazy: only this function pays the load cost
    const { data: webp, info } = await sharp(input, { failOn: 'none' })
        .rotate()
        .resize({ width: MAX_EDGE, height: MAX_EDGE, fit: 'inside', withoutEnlargement: true })
        .webp({ quality: 85 })
        .toBuffer({ resolveWithObject: true });

    // 3. store in the school's bucket with a download token
    const storagePath = `schools/${schoolId}/lessons/${lessonId}/media/${objectId}.webp`;
    const bucket = admin.storage().bucket();
    const token = crypto.randomUUID();
    await bucket.file(storagePath).save(webp, {
        resumable: false,
        contentType: 'image/webp',
        metadata: {
            cacheControl: 'public, max-age=31536000',
            metadata: { firebaseStorageDownloadTokens: token, source: 'unsplash', sourceId: id, credit: credit.name },
        },
    });
    const url = `https://firebasestorage.googleapis.com/v0/b/${bucket.name}/o/${encodeURIComponent(storagePath)}?alt=media&token=${token}`;
    return { media: { storagePath, url, w: info.width, h: info.height }, credit, alt };
});
