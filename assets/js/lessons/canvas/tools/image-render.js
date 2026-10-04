// assets/js/lessons/canvas/tools/image-render.js — pure image-object markup
// (no Firebase imports, so the shared renderer stays dependency-free).
// See tools/image.js for the data shape and the upload pipeline.

const esc = (v) => String(v ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#039;' }[c]));
const num = (v, d) => (typeof v === 'number' && Number.isFinite(v) ? v : d);

// ── rendering ────────────────────────────────────────────────────────────
export function normalizeCrop(c) {
    if (!c || typeof c !== 'object') return null;
    const x = Math.min(0.99, Math.max(0, num(c.x, 0))), y = Math.min(0.99, Math.max(0, num(c.y, 0)));
    const w = Math.min(1 - x, Math.max(0.01, num(c.w, 1))), h = Math.min(1 - y, Math.max(0.01, num(c.h, 1)));
    if (x === 0 && y === 0 && w >= 0.999 && h >= 0.999) return null;
    return { x, y, w, h };
}

// Inner markup for one image object at its current box size. The visible
// region (crop, or the whole picture) is fitted inside the box like
// object-fit: contain; flips mirror that region in place.
export function imageMarkup(obj, { emptyHtml = '' } = {}) {
    const p = (obj && obj.props) || {};
    const url = (p.media && p.media.url) || p.imageUrl || '';
    if (!url) return emptyHtml;
    const cs = num(p.contentScale, 1) || 1;
    const boxW = Math.max(1, (obj.w || 1) / cs), boxH = Math.max(1, (obj.h || 1) / cs);
    const caption = p.caption ? `<p class="cv-img-caption">${esc(p.caption)}</p>` : '';
    const credit = p.credit && p.credit.name
        ? `<a class="cv-img-credit" href="${esc(p.credit.url || p.credit.providerUrl || '#')}" target="_blank" rel="noopener noreferrer">Photo: ${esc(p.credit.name)}${p.credit.provider ? ` / ${esc(p.credit.provider)}` : ''}</a>`
        : '';
    const flip = `${p.flipH ? 'scaleX(-1) ' : ''}${p.flipV ? 'scaleY(-1)' : ''}`.trim();
    const nw = p.media && num(p.media.w, 0), nh = p.media && num(p.media.h, 0);
    const crop = normalizeCrop(p.crop);
    const alt = esc(p.imageAlt || '');
    if (!nw || !nh) {
        // size unknown (legacy link): plain contain, crop unavailable
        return `<div class="cv-img-wrap"><img class="cv-img" src="${esc(url)}" alt="${alt}" draggable="false" style="${flip ? `transform:${flip};` : ''}">${credit}</div>${caption}`;
    }
    const c = crop || { x: 0, y: 0, w: 1, h: 1 };
    const ra = (c.w * nw) / (c.h * nh);
    const capH = p.caption ? 22 : 0;
    const availH = Math.max(1, boxH - capH);
    let fw = boxW, fh = boxW / ra;
    if (fh > availH) { fh = availH; fw = availH * ra; }
    const iw = fw / c.w, ih = fh / c.h;
    return `<div class="cv-img-wrap" style="height:${availH}px">`
        + `<div class="cv-img-frame" style="width:${fw.toFixed(2)}px;height:${fh.toFixed(2)}px;${flip ? `transform:${flip};` : ''}">`
        + `<img class="cv-img-cropped" src="${esc(url)}" alt="${alt}" draggable="false" loading="lazy" style="width:${iw.toFixed(2)}px;height:${ih.toFixed(2)}px;left:${(-c.x * iw).toFixed(2)}px;top:${(-c.y * ih).toFixed(2)}px">`
        + `</div>${credit}</div>${caption}`;
}

export const IMAGE_CSS = `
.cv-img-wrap { position: relative; width: 100%; height: 100%; display: flex; align-items: center; justify-content: center; overflow: hidden; }
.cv-img-wrap > img.cv-img { width: 100%; height: 100%; object-fit: contain; display: block; }
.cv-img-frame { position: relative; overflow: hidden; flex-shrink: 0; }
.cv-img-frame > img.cv-img-cropped { position: absolute; max-width: none; display: block; }
.cv-img-caption { margin: 4px 0 0; height: 18px; line-height: 18px; font-size: 12px; font-weight: 600; color: #64748b; text-align: center; overflow: hidden; white-space: nowrap; text-overflow: ellipsis; }
.cv-img-credit { position: absolute; right: 4px; bottom: 4px; font-size: 9px; line-height: 1.2; font-weight: 600; color: #fff; background: rgba(13,31,53,.55); padding: 2px 6px; border-radius: 4px; text-decoration: none; max-width: 90%; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
`;
