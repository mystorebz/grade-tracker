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
