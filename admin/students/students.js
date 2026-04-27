// ── Print: Full Term Transcript ───────────────────────────────────────────
window.printTermTranscript = (termId, termName) => {
    const grades = termId
        ? _academicGradesCache.filter(g => (g.termId || g.semesterId || '') === termId)
        : _academicGradesCache;
    const s         = currentStudentData;
    const school    = session.schoolName || session.schoolId || 'School';
    const calcLg    = (avg) => avg >= 90 ? 'A' : avg >= 80 ? 'B' : avg >= 70 ? 'C' : avg >= 60 ? 'D' : 'F';

    const bySubject = {};
    grades.forEach(g => {
        const subj = g.subject || 'Uncategorized';
        if (!bySubject[subj]) bySubject[subj] = [];
        bySubject[subj].push(g);
    });

    const tableRows = Object.entries(bySubject).map(([sub, sg]) => {
        const avg  = Math.round(sg.reduce((a, g) => a + (g.max ? (g.score / g.max) * 100 : 0), 0) / sg.length);
        const col  = avg >= 75 ? '#16a34a' : avg >= 60 ? '#d97706' : '#dc2626';
        return `<tr>
            <td style="border:1px solid #e2e8f0;padding:10px 15px;">${sub}</td>
            <td style="border:1px solid #e2e8f0;padding:10px 15px;text-align:center;">${sg.length}</td>
            <td style="border:1px solid #e2e8f0;padding:10px 15px;text-align:center;font-weight:700;color:${col}">${avg}%</td>
            <td style="border:1px solid #e2e8f0;padding:10px 15px;text-align:center;font-weight:700;">${calcLg(avg)}</td>
        </tr>`;
    }).join('');

    const allAvg  = grades.length ? Math.round(grades.reduce((a, g) => a + (g.max ? (g.score / g.max) * 100 : 0), 0) / grades.length) : 0;

    const w = window.open('', '_blank');
    w.document.write(`<!DOCTYPE html><html><head><title>${termName} Transcript — ${s?.name}</title>
    <style>
        *{box-sizing:border-box;margin:0;padding:0}
        body{font-family:'Helvetica Neue',Arial,sans-serif;padding:48px 40px;color:#1e293b;line-height:1.5;font-size:13px}
        .header{display:flex;justify-content:space-between;align-items:flex-end;border-bottom:3px solid #0d1f35;padding-bottom:18px;margin-bottom:24px}
        .school-name{font-size:20px;font-weight:900;text-transform:uppercase;color:#0d1f35}
        .doc-type{font-size:11px;font-weight:700;color:#6b84a0;letter-spacing:0.12em;text-transform:uppercase;margin-top:3px}
        .info-grid{display:grid;grid-template-columns:1fr 1fr 1fr;gap:10px;margin-bottom:24px;background:#f8fafc;padding:16px;border-radius:8px;border:1px solid #e2e8f0}
        .info-item label{display:block;font-size:9px;text-transform:uppercase;letter-spacing:0.1em;color:#64748b;font-weight:700;margin-bottom:2px}
        .info-item span{font-size:13px;font-weight:700;color:#0f172a}
        .term-header{background:#0d1f35;color:white;padding:10px 16px;border-radius:6px;font-size:13px;font-weight:900;letter-spacing:0.05em;text-transform:uppercase;margin-bottom:14px}
        table{width:100%;border-collapse:collapse;margin-bottom:20px}
        thead tr{background:#f1f5f9}
        th{border:1px solid #e2e8f0;padding:10px 15px;text-align:left;font-size:11px;font-weight:700;text-transform:uppercase;letter-spacing:0.06em;color:#64748b}
        .total-row{background:#f8fafc;font-weight:700}
        .footer{margin-top:40px;text-align:center;font-size:10px;color:#94a3b8;border-top:1px solid #e2e8f0;padding-top:14px;line-height:1.6}
    </style></head><body>
    
    <div style="text-align: center; margin-bottom: 30px;">
        <img src="../../assets/images/logo.png" onerror="this.style.display='none'" style="height: 65px; object-fit: contain; margin-bottom: 10px;">
        <div style="font-size: 11px; font-weight: 900; letter-spacing: 0.15em; color: #e31b4a; text-transform: uppercase;">Unofficial Transcript — Internal Record Only</div>
    </div>

    <div class="header">
        <div>
            <div class="school-name">${escHtml(school)}</div>
            <div class="doc-type">Internal Academic Record</div>
        </div>
        <div style="text-align:right;font-size:11px;color:#64748b">
            <div style="font-weight:700">${termName}</div>
            <div>Printed ${new Date().toLocaleDateString('en-US',{month:'long',day:'numeric',year:'numeric'})}</div>
        </div>
    </div>
    
    <div class="info-grid">
        <div class="info-item"><label>Student Name</label><span>${escHtml(s?.name || '—')}</span></div>
        <div class="info-item"><label>Global Student ID</label><span style="font-family:monospace">${escHtml(s?.id || '—')}</span></div>
        <div class="info-item"><label>Class</label><span>${escHtml(s?.className || 'Unassigned')}</span></div>
        <div class="info-item"><label>Date of Birth</label><span>${escHtml(s?.dob || '—')}</span></div>
        <div class="info-item"><label>Enrollment Status</label><span>${escHtml(s?.enrollmentStatus || 'Active')}</span></div>
        <div class="info-item"><label>Parent / Guardian</label><span>${escHtml(s?.parentName || '—')}</span></div>
    </div>
    <div class="term-header">${escHtml(termName)}</div>
    <table>
        <thead><tr>
            <th>Subject</th><th style="text-align:center">Assessments</th>
            <th style="text-align:center">Average</th><th style="text-align:center">Grade</th>
        </tr></thead>
        <tbody>
            ${tableRows}
            <tr class="total-row">
                <td colspan="2" style="border:1px solid #e2e8f0;padding:10px 15px;text-align:right;font-size:12px">OVERALL AVERAGE</td>
                <td style="border:1px solid #e2e8f0;padding:10px 15px;text-align:center;font-weight:900;color:${allAvg>=75?'#16a34a':allAvg>=60?'#d97706':'#dc2626'}">${allAvg}%</td>
                <td style="border:1px solid #e2e8f0;padding:10px 15px;text-align:center;font-weight:900">${calcLg(allAvg)}</td>
            </tr>
        </tbody>
    </table>
    
    <div class="footer">
        Issued by ${escHtml(school)} · ConnectUs Student Registry · ${new Date().toLocaleDateString()}<br>
        <span style="font-weight: 700; color: #cbd5e1; font-size: 9px; text-transform: uppercase; letter-spacing: 0.1em; display: inline-block; margin-top: 8px;">Education Connected · Powered by Kismet Coder</span>
    </div>
    </body></html>`);
    w.document.close();
    setTimeout(() => w.print(), 400);
};

// ── Print: Single Subject Report ──────────────────────────────────────────
window.printSubjectReport = (safeSubject, safeTerm) => {
    const subject  = decodeURIComponent(safeSubject);
    const termName = decodeURIComponent(safeTerm);
    const s        = currentStudentData;
    const school   = session.schoolName || session.schoolId || 'School';
    const calcLg   = (avg) => avg >= 90 ? 'A' : avg >= 80 ? 'B' : avg >= 70 ? 'C' : avg >= 60 ? 'D' : 'F';

    const termGrades = _activeTermForPrint.id
        ? _academicGradesCache.filter(g => (g.termId || g.semesterId || '') === _activeTermForPrint.id)
        : _academicGradesCache;
    const grades = termGrades.filter(g => (g.subject || 'Uncategorized') === subject);

    if (!grades.length) { alert('No grades found for this subject.'); return; }

    const byType = {};
    grades.forEach(g => {
        const t = g.type || 'Assessment';
        if (!byType[t]) byType[t] = [];
        byType[t].push(g);
    });

    const typeBlocks = Object.entries(byType).map(([type, tg]) => {
        const typeAvg = Math.round(tg.reduce((a, g) => a + (g.max ? (g.score/g.max)*100 : 0), 0) / tg.length);
        const rows = tg.map(g => {
            const pct = g.max ? Math.round((g.score/g.max)*100) : null;
            const col = pct == null ? '#374f6b' : pct >= 75 ? '#16a34a' : pct >= 60 ? '#d97706' : '#dc2626';
            return `<tr>
                <td style="border:1px solid #e2e8f0;padding:9px 14px">${escHtml(g.title||'Assessment')}</td>
                <td style="border:1px solid #e2e8f0;padding:9px 14px;text-align:center">${g.date||'—'}</td>
                <td style="border:1px solid #e2e8f0;padding:9px 14px;text-align:center;font-weight:700;color:${col}">${g.score}/${g.max||'?'}</td>
                <td style="border:1px solid #e2e8f0;padding:9px 14px;text-align:center;font-weight:700;color:${col}">${pct!=null?pct+'%':'—'}</td>
                <td style="border:1px solid #e2e8f0;padding:9px 14px;font-size:11px;color:#64748b;font-style:italic">${escHtml(g.comments||'')}</td>
            </tr>`;
        }).join('');
        return `<h4 style="font-size:12px;font-weight:700;color:#64748b;text-transform:uppercase;letter-spacing:0.08em;margin:16px 0 8px">${type} <span style="font-weight:500;color:#94a3b8">(avg: ${typeAvg}%)</span></h4>
        <table style="width:100%;border-collapse:collapse;font-size:12px;margin-bottom:8px">
            <thead><tr style="background:#f8fafc"><th style="border:1px solid #e2e8f0;padding:8px 14px;text-align:left">Title</th><th style="border:1px solid #e2e8f0;padding:8px 14px;text-align:center">Date</th><th style="border:1px solid #e2e8f0;padding:8px 14px;text-align:center">Score</th><th style="border:1px solid #e2e8f0;padding:8px 14px;text-align:center">%</th><th style="border:1px solid #e2e8f0;padding:8px 14px;text-align:left">Teacher Comments</th></tr></thead>
            <tbody>${rows}</tbody>
        </table>`;
    }).join('');

    const overall = Math.round(grades.reduce((a,g) => a+(g.max?(g.score/g.max)*100:0),0)/grades.length);

    const w = window.open('', '_blank');
    w.document.write(`<!DOCTYPE html><html><head><title>${subject} Report — ${s?.name}</title>
    <style>
        *{box-sizing:border-box;margin:0;padding:0}
        body{font-family:'Helvetica Neue',Arial,sans-serif;padding:48px 40px;color:#1e293b;line-height:1.5}
        .header{display:flex;justify-content:space-between;align-items:flex-end;border-bottom:3px solid #0d1f35;padding-bottom:18px;margin-bottom:24px}
        .school-name{font-size:20px;font-weight:900;text-transform:uppercase;color:#0d1f35}
        .doc-type{font-size:11px;font-weight:700;color:#6b84a0;letter-spacing:0.12em;text-transform:uppercase;margin-top:3px}
        .summary{background:#f8fafc;border:1px solid #e2e8f0;border-radius:8px;padding:14px 18px;margin-bottom:24px;display:flex;justify-content:space-between;align-items:center}
        .footer{margin-top:40px;text-align:center;font-size:10px;color:#94a3b8;border-top:1px solid #e2e8f0;padding-top:14px;line-height:1.6}
    </style></head><body>
    
    <div style="text-align: center; margin-bottom: 30px;">
        <img src="../../assets/images/logo.png" onerror="this.style.display='none'" style="height: 65px; object-fit: contain; margin-bottom: 10px;">
        <div style="font-size: 11px; font-weight: 900; letter-spacing: 0.15em; color: #e31b4a; text-transform: uppercase;">Unofficial Transcript — Internal Record Only</div>
    </div>

    <div class="header">
        <div>
            <div class="school-name">${escHtml(school)}</div>
            <div class="doc-type">Internal Subject Grade Report</div>
        </div>
        <div style="text-align:right;font-size:11px;color:#64748b">
            <div style="font-weight:700">${escHtml(termName)}</div>
            <div>Printed ${new Date().toLocaleDateString('en-US',{month:'long',day:'numeric',year:'numeric'})}</div>
        </div>
    </div>

    <div class="summary">
        <div><div style="font-size:11px;font-weight:700;color:#64748b;text-transform:uppercase;letter-spacing:0.08em;margin-bottom:2px">Student</div><div style="font-size:15px;font-weight:900;color:#0d1f35">${escHtml(s?.name||'—')}</div><div style="font-size:11px;color:#64748b;font-family:monospace">${escHtml(s?.id||'')}</div></div>
        <div style="text-align:center"><div style="font-size:11px;font-weight:700;color:#64748b;text-transform:uppercase;letter-spacing:0.08em;margin-bottom:2px">Subject</div><div style="font-size:17px;font-weight:900;color:#0d1f35">${escHtml(subject)}</div></div>
        <div style="text-align:right"><div style="font-size:11px;font-weight:700;color:#64748b;text-transform:uppercase;letter-spacing:0.08em;margin-bottom:2px">Overall</div><div style="font-size:26px;font-weight:900;color:${overall>=75?'#16a34a':overall>=60?'#d97706':'#dc2626'}">${overall}% · ${calcLg(overall)}</div></div>
    </div>
    ${typeBlocks}
    
    <div class="footer">
        Issued by ${escHtml(school)} · ConnectUs Student Registry · ${new Date().toLocaleDateString()}<br>
        <span style="font-weight: 700; color: #cbd5e1; font-size: 9px; text-transform: uppercase; letter-spacing: 0.1em; display: inline-block; margin-top: 8px;">Education Connected · Powered by Kismet Coder</span>
    </div>
    </body></html>`);
    w.document.close();
    setTimeout(() => w.print(), 400);
};

// ── Print: Global Student Record ──────────────────────────────────────────
window.printStudentRecord = async (studentId) => {
    const sDoc = await getDoc(doc(db, 'students', studentId));
    if (!sDoc.exists()) { alert('Student not found.'); return; }
    const s = sDoc.data();

    let gradesSnap = await getDocs(collection(db, 'students', studentId, 'grades'));
    if (gradesSnap.empty) {
        gradesSnap = await getDocs(collection(db, 'schools', session.schoolId, 'students', studentId, 'grades'));
    }

    const bySub = {};
    gradesSnap.forEach(d => {
        const g    = d.data();
        const sub  = g.subject || 'Uncategorized';
        if (!bySub[sub]) bySub[sub] = [];
        bySub[sub].push(g);
    });

    const lg = (avg) => avg >= 90 ? 'A' : avg >= 80 ? 'B' : avg >= 70 ? 'C' : avg >= 60 ? 'D' : 'F';

    const gradesHtml = Object.keys(bySub).length === 0
        ? `<p style="text-align:center;color:#64748b;font-style:italic;padding:40px 0;">No grades recorded.</p>`
        : `<table style="width:100%;border-collapse:collapse;font-size:13px;margin-top:20px;">
            <thead>
                <tr style="background:#f8fafc;">
                    <th style="border:1px solid #e2e8f0;padding:10px 15px;text-align:left;">Subject</th>
                    <th style="border:1px solid #e2e8f0;padding:10px 15px;text-align:center;">Assessments</th>
                    <th style="border:1px solid #e2e8f0;padding:10px 15px;text-align:center;">Average</th>
                    <th style="border:1px solid #e2e8f0;padding:10px 15px;text-align:center;">Grade</th>
                </tr>
            </thead>
            <tbody>
                ${Object.entries(bySub).map(([sub, grades]) => {
                    const avg = Math.round(grades.reduce((a, g) => a + (g.max ? (g.score / g.max) * 100 : 0), 0) / grades.length);
                    return `<tr><td style="border:1px solid #e2e8f0;padding:10px 15px;">${sub}</td>
                        <td style="border:1px solid #e2e8f0;padding:10px 15px;text-align:center;">${grades.length}</td>
                        <td style="border:1px solid #e2e8f0;padding:10px 15px;text-align:center;">${avg}%</td>
                        <td style="border:1px solid #e2e8f0;padding:10px 15px;text-align:center;font-weight:bold;">${lg(avg)}</td></tr>`;
                }).join('')}
            </tbody>
           </table>`;

    const w = window.open('', '_blank');
    w.document.write(`<!DOCTYPE html><html><head><title>Student Record — ${s.name}</title>
    <style>
        body{font-family:'Helvetica Neue',sans-serif;padding:40px;color:#1e293b;line-height:1.5}
        .header{border-bottom:2px solid #cbd5e1;padding-bottom:20px;margin-bottom:30px;display:flex;align-items:flex-end;justify-content:space-between;}
        .info-grid{display:grid;grid-template-columns:1fr 1fr;gap:12px;margin-bottom:30px;background:#f8fafc;padding:18px;border-radius:8px;border:1px solid #e2e8f0}
        .info-item label{display:block;font-size:10px;text-transform:uppercase;color:#64748b;font-weight:bold;letter-spacing:0.08em}
        .info-item span{font-size:13px;font-weight:bold;color:#0f172a}
        .footer{margin-top:50px;text-align:center;font-size:10px;color:#94a3b8;border-top:1px solid #e2e8f0;padding-top:15px;line-height:1.6;}
    </style></head><body>
    
    <div style="text-align: center; margin-bottom: 30px;">
        <img src="../../assets/images/logo.png" onerror="this.style.display='none'" style="height: 65px; object-fit: contain; margin-bottom: 10px;">
        <div style="font-size: 11px; font-weight: 900; letter-spacing: 0.15em; color: #e31b4a; text-transform: uppercase;">Unofficial Transcript — Internal Record Only</div>
    </div>

    <div class="header">
        <div>
            <h1 style="margin:0 0 4px;font-size:22px;text-transform:uppercase;">${session.schoolName || 'ConnectUs School'}</h1>
            <h2 style="margin:0;font-size:12px;color:#64748b;font-weight:normal;letter-spacing:2px;text-transform:uppercase;">Official Academic Record — Student Registry</h2>
        </div>
    </div>
    
    <div class="info-grid">
        <div class="info-item"><label>Student Name</label><span>${s.name || '—'}</span></div>
        <div class="info-item"><label>Global Student ID</label><span style="font-family:monospace">${s.id || studentId}</span></div>
        <div class="info-item"><label>Date of Birth</label><span>${s.dob || 'N/A'}</span></div>
        <div class="info-item"><label>Gender</label><span>${s.gender || 'N/A'}</span></div>
        <div class="info-item"><label>Current Class</label><span>${s.className || 'Unassigned'}</span></div>
        <div class="info-item"><label>Enrollment Status</label><span>${s.enrollmentStatus || 'Active'}</span></div>
        <div class="info-item"><label>Parent / Guardian</label><span>${s.parentName || 'N/A'}</span></div>
        <div class="info-item"><label>Parent Phone</label><span>${s.parentPhone || 'N/A'}</span></div>
    </div>
    <h3 style="font-size:13px;font-weight:bold;background:#0d1f35;color:white;padding:8px 15px;border-radius:4px;">Academic Summary</h3>
    ${gradesHtml}
    
    <div class="footer">
        Printed ${new Date().toLocaleDateString('en-US', { month: 'long', day: 'numeric', year: 'numeric' })} via ConnectUs Student Registry<br>
        Issued by: ${session.schoolName || session.schoolId}<br>
        <span style="font-weight: 700; color: #cbd5e1; font-size: 9px; text-transform: uppercase; letter-spacing: 0.1em; display: inline-block; margin-top: 8px;">Education Connected · Powered by Kismet Coder</span>
    </div>
    </body></html>`);
    w.document.close();
    setTimeout(() => w.print(), 500);
};
