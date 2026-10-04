// assets/js/assessment/image-compress.js — shrink a photo to < 200 KB in the browser
// (HTML5 canvas, no server cost) before it is uploaded to Firebase Storage.
import { fitDimensions } from './engine-core.js';

export const TARGET_BYTES = 200 * 1024;

function loadImage(file) {
    return new Promise((resolve, reject) => {
        const url = URL.createObjectURL(file);
        const img = new Image();
        img.onload = () => { URL.revokeObjectURL(url); resolve(img); };
        img.onerror = () => { URL.revokeObjectURL(url); reject(new Error('That file is not an image this browser can read.')); };
        img.src = url;
    });
}

const toBlob = (canvas, type, quality) => new Promise((r) => canvas.toBlob(r, type, quality));

/**
 * compressImage(file) → Blob (image/webp, or image/jpeg where webp isn't
 * supported) under maxBytes. Lowers quality first, then dimensions.
 */
export async function compressImage(file, { maxBytes = TARGET_BYTES, maxDim = 1600 } = {}) {
    if (!file || !/^image\//.test(file.type)) throw new Error('Choose a photo or image file.');
    if (file.size <= maxBytes && /^image\/(jpeg|webp)$/.test(file.type)) return file;
    const img = await loadImage(file);
    let dim = maxDim;
    for (let pass = 0; pass < 6; pass++) {
        const { width, height } = fitDimensions(img.naturalWidth, img.naturalHeight, dim);
        const canvas = document.createElement('canvas');
        canvas.width = width; canvas.height = height;
        const ctx = canvas.getContext('2d');
        ctx.fillStyle = '#fff'; ctx.fillRect(0, 0, width, height); // transparent PNGs → white, not black
        ctx.drawImage(img, 0, 0, width, height);
        for (const q of [0.82, 0.7, 0.58, 0.46, 0.36]) {
            let blob = await toBlob(canvas, 'image/webp', q);
            if (!blob || blob.type !== 'image/webp') blob = await toBlob(canvas, 'image/jpeg', q);
            if (blob && blob.size <= maxBytes) return blob;
        }
        dim = Math.round(dim * 0.75);
    }
    throw new Error('This image could not be made small enough. Try a smaller photo.');
}
