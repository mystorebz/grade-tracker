// ── WEIGHTED MATH ENGINE ────────────────────────────────────────

export function calculateWeightedAverage(grades, schoolId) {
    // 1. Safety check
    if (!grades || grades.length === 0) return null;

    // 2. Fetch active weights from Settings cache
    const cachedTypes = localStorage.getItem(`connectus_gradeTypes_${schoolId}`);
    let gradeTypes = [];
    try {
        if (cachedTypes) gradeTypes = JSON.parse(cachedTypes);
    } catch (e) {
        console.error('[Utils] Failed to parse grade types from cache:', e);
    }

    // 3. Fallback to flat average if no weights exist in the system yet
    if (!gradeTypes || gradeTypes.length === 0) {
        const totalPct = grades.reduce((sum, g) => {
            return sum + (g.percentage !== undefined ? g.percentage : (g.score / g.max) * 100);
        }, 0);
        return Math.round(totalPct / grades.length);
    }

    // Map weights for quick lookup (e.g., { 'test': 30, 'quiz': 15 })
    const weightMap = {};
    gradeTypes.forEach(t => {
        weightMap[t.name.toLowerCase()] = t.weight || 0;
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
    // (e.g., If they only have Tests (30%) and Quizzes (15%), we calculate out of 45%)
    return Math.round(weightedSum / activeWeightTotal);
}
