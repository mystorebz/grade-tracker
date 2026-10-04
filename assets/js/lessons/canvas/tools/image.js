// assets/js/lessons/canvas/tools/image.js — image objects: upload pipeline,
// stock-photo import, crop / flip rendering (schema v3)
//
// Storage layout (storage.rules):
//   schools/{schoolId}/lessons/{lessonId}/media/{objectId}.webp
// The object record only ever holds a reference, never pixels:
//   props.media = { storagePath, url, w, h }      (w/h = stored pixel size)
//   props.imageUrl = media.url                    (kept for v2-era readers)
//   props.crop = { x, y, w, h } | null            (fractions of the source image)
//   props.flipH / props.flipV                     (mirror)
//   props.credit = { name, url, provider, providerUrl } | null   (stock attribution)
//
// Client pipeline: decode → downscale so the longest edge ≤ 2400px → WebP @0.85
// (JPEG fallback where the browser cannot encode WebP) → Storage → download URL.
// Stock pipeline: callable Cloud Functions (functions/src/searchStockImages.js)
// search Unsplash with a server-side key and copy the chosen photo into
// the school's bucket, so slides never hotlink a third-party CDN.

import { storage, functions } from '../../../firebase-init.js';
import { ref as storageRef, uploadBytes, getDownloadURL, deleteObject } from 'https://www.gstatic.com/firebasejs/10.7.1/firebase-storage.js';
import { httpsCallable } from 'https://www.gstatic.com/firebasejs/10.7.1/firebase-functions.js';

export { imageMarkup, normalizeCrop, IMAGE_CSS } from './image-render.js';

export const MAX_EDGE = 2400;
export const WEBP_QUALITY = 0.85;
export const MAX_UPLOAD_BYTES = 15 * 1024 * 1024; // storage.rules cap


export function mediaPath(schoolId, lessonId, objectId, ext = 'webp') {
    return `schools/${schoolId}/lessons/${lessonId}/media/${objectId}.${ext}`;
}

// ── decode + downscale + encode ──────────────────────────────────────────
async function decode(source) {
    if (typeof createImageBitmap === 'function' && source instanceof Blob) {
        try { return await createImageBitmap(source); } catch (e) { /* fall through (e.g. SVG) */ }
    }
    const url = source instanceof Blob ? URL.createObjectURL(source) : source;
    try {
        const img = new Image();
        img.decoding = 'async';
        img.crossOrigin = 'anonymous';
        await new Promise((res, rej) => { img.onload = res; img.onerror = () => rej(new Error('This image could not be read.')); img.src = url; });
        return img;
    } finally {
        if (source instanceof Blob) setTimeout(() => URL.revokeObjectURL(url), 0);
    }
}

function canvasToBlob(canvas, type, quality) {
    return new Promise((res) => canvas.toBlob(res, type, quality));
}

// Returns { blob, w, h, ext, type }.
export async function processImage(source, { maxEdge = MAX_EDGE, quality = WEBP_QUALITY } = {}) {
    const bmp = await decode(source);
    const sw = bmp.width || bmp.naturalWidth, sh = bmp.height || bmp.naturalHeight;
    if (!sw || !sh) throw new Error('This image has no size.');
    const k = Math.min(1, maxEdge / Math.max(sw, sh));
    const w = Math.max(1, Math.round(sw * k)), h = Math.max(1, Math.round(sh * k));
    const canvas = document.createElement('canvas');
    canvas.width = w; canvas.height = h;
    const ctx = canvas.getContext('2d');
    ctx.imageSmoothingEnabled = true;
    ctx.imageSmoothingQuality = 'high';
    ctx.drawImage(bmp, 0, 0, w, h);
    if (typeof bmp.close === 'function') bmp.close();
    let blob = await canvasToBlob(canvas, 'image/webp', quality);
    let ext = 'webp';
    if (!blob || blob.type !== 'image/webp') { // Safari < 17 etc.
        blob = await canvasToBlob(canvas, 'image/jpeg', quality);
        ext = 'jpg';
    }
    if (!blob) throw new Error('This image could not be converted.');
    return { blob, w, h, ext, type: blob.type };
}

export async function dataUrlToBlob(dataUrl) {
    const res = await fetch(dataUrl);
    return res.blob();
}

// Upload a File/Blob for one image object. Resolves to media { storagePath, url, w, h }.
export async function uploadLessonImage({ schoolId, lessonId, objectId, file }) {
    if (!schoolId || !lessonId || !objectId) throw new Error('uploadLessonImage: schoolId, lessonId and objectId are required.');
    const { blob, w, h, ext, type } = await processImage(file);
    if (blob.size > MAX_UPLOAD_BYTES) throw new Error('This image is too large even after compression (15 MB max).');
    const storagePath = mediaPath(schoolId, lessonId, objectId, ext);
    const r = storageRef(storage, storagePath);
    await uploadBytes(r, blob, { contentType: type, cacheControl: 'public, max-age=31536000' });
    const url = await getDownloadURL(r);
    return { storagePath, url, w, h };
}

export async function deleteLessonImage(storagePath) {
    if (!storagePath) return;
    try { await deleteObject(storageRef(storage, storagePath)); } catch (e) { /* already gone / not ours */ }
}

// Natural pixel size of an image URL (for external links, so crop can work).
export function measureImage(url) {
    return new Promise((resolve) => {
        if (!url) return resolve(null);
        const img = new Image();
        img.onload = () => resolve({ w: img.naturalWidth, h: img.naturalHeight });
        img.onerror = () => resolve(null);
        img.src = url;
    });
}

// ── stock photos (callable Cloud Functions) ──────────────────────────────
const searchFn = httpsCallable(functions, 'searchStockImages');
const importFn = httpsCallable(functions, 'importStockImage');

// → { provider, page, total, results: [{ id, provider, thumb, w, h, alt, credit }] }
export async function searchStock({ query, page = 1 }) {
    const res = await searchFn({ query, page });
    return res.data;
}

// Server downloads the photo into the school bucket → { media, credit, alt }.
export async function importStock({ schoolId, lessonId, objectId, id }) {
    const res = await importFn({ schoolId, lessonId, objectId, id });
    return res.data;
}

