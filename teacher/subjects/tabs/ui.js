// teacher/subjects/tabs/ui.js — shared render helpers for the subject tab modules

export const esc = (v) => String(v ?? '').replace(/[&<>"']/g, (ch) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#039;' }[ch]));

export const loading = (label = 'Loading…') =>
    `<div class="py-16 text-center text-[#9ab0c6] text-[13px] font-bold"><i class="fa-solid fa-spinner fa-spin text-[#2563eb] text-2xl block mb-3"></i>${esc(label)}</div>`;

export const card = (title, body, right = '') =>
    `<div class="bg-white rounded-xl border border-[#dce3ed] shadow-sm overflow-hidden">
        <div class="px-4 py-3 border-b border-[#f0f4f8] flex items-center justify-between gap-3">
            <span class="text-[11px] font-bold uppercase tracking-widest text-[#6b84a0]">${esc(title)}</span>${right}
        </div>${body}</div>`;

export const emptyBox = (title, sub = '') =>
    `<div class="bg-white rounded-xl border-2 border-dashed border-[#dce3ed] py-14 px-6 text-center">
        <p class="font-bold text-[#374f6b] text-[13px] m-0">${esc(title)}</p>${sub ? `<p class="text-[12px] text-[#9ab0c6] m-0 mt-1">${esc(sub)}</p>` : ''}</div>`;

export const stat = (label, value, tone = 'text-[#0d1f35]') =>
    `<div class="bg-white rounded-xl border border-[#dce3ed] shadow-sm px-4 py-3">
        <p class="text-[10.5px] font-bold uppercase tracking-widest text-[#9ab0c6] m-0">${esc(label)}</p>
        <p class="text-xl font-bold ${tone} m-0 mt-1">${esc(value)}</p></div>`;

export function formatDate(v) {
    if (!v) return '';
    const d = /^\d{4}-\d{2}-\d{2}$/.test(v) ? new Date(+v.slice(0, 4), +v.slice(5, 7) - 1, +v.slice(8, 10)) : new Date(v);
    return isNaN(d) ? String(v) : d.toLocaleDateString(undefined, { month: 'short', day: 'numeric', year: 'numeric' });
}

// Simple points-based percentage (sum score / sum max). Weighted averages
// (calculateWeightedAverage in utils.js) arrive with the full Performance tab.
export function pct(grades) {
    const max = grades.reduce((a, g) => a + (Number(g.max) || 0), 0);
    return max ? Math.round((grades.reduce((a, g) => a + (Number(g.score) || 0), 0) / max) * 100) : null;
}
