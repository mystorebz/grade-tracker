/* ==========================================================================
   CONNECTUS - TEACHER PORTAL CSS (PREMIUM 2026 EDITION)
   ========================================================================== */

/* Apply premium font without breaking FontAwesome icons */
html, body { 
    margin: 0; padding: 0; width: 100%; height: 100%; overflow: hidden; 
    font-family: 'Plus Jakarta Sans', sans-serif;
    background-color: #f4f7f6; /* Soft, premium light-gray/green background */
    color: #0f172a;
}

::-webkit-scrollbar { width: 6px; height: 6px; }
::-webkit-scrollbar-track { background: transparent; }
::-webkit-scrollbar-thumb { background: #cbd5e1; border-radius: 10px; }
::-webkit-scrollbar-thumb:hover { background: #94a3b8; }

/* ── PREMIUM SIDEBAR (Matches Login Page Vibe) ── */
#sidebar { 
    background: linear-gradient(160deg, #022c22 0%, #064e3b 50%, #047857 100%) !important; 
    border-right: 1px solid rgba(255, 255, 255, 0.05) !important; 
    box-shadow: 4px 0 25px rgba(0,0,0,0.1);
}

.nav-section-label { 
    font-size: 10px; font-weight: 800; color: rgba(255, 255, 255, 0.4) !important; 
    text-transform: uppercase; letter-spacing: 0.15em; 
    padding: 0 24px; margin-top: 24px; margin-bottom: 8px; 
}

.nav-item { 
    color: rgba(255, 255, 255, 0.7) !important; font-weight: 600; 
    transition: all 0.2s ease; position: relative; 
    border-radius: 12px; margin: 4px 12px; padding: 12px 16px;
    font-size: 0.9rem; display: flex; align-items: center; gap: 12px;
}
.nav-item:hover { 
    background: rgba(255, 255, 255, 0.08) !important; 
    color: #ffffff !important; 
}
.nav-item.active { 
    background: linear-gradient(90deg, rgba(16, 185, 129, 0.2), transparent) !important; 
    color: #34d399 !important; font-weight: 700;
    border: 1px solid rgba(52, 211, 153, 0.2) !important; 
}
.nav-item.active::before { 
    content: ''; position: absolute; left: -12px; top: 15%; 
    width: 4px; height: 70%; background: #34d399; 
    border-radius: 0 4px 4px 0;
}

/* ── DASHBOARD CARDS ── */
.stat-card { 
    transition: all 0.2s ease; 
    border: 1px solid #e2e8f0 !important; 
    background: #ffffff !important;
    border-radius: 16px !important;
    box-shadow: 0 4px 20px rgba(0, 0, 0, 0.03);
}
.stat-card:hover { 
    transform: translateY(-3px); 
    border-color: #10b981 !important; 
    box-shadow: 0 12px 25px rgba(16, 185, 129, 0.08); 
}

/* ── QUICK ACTION BUTTONS ── */
.qa-btn { 
    display: flex; align-items: center; gap: 12px; padding: 14px 18px; 
    font-weight: 800; font-size: 0.85rem; transition: all 0.2s; 
    border: 1px solid #e2e8f0 !important; background: #ffffff !important; 
    border-radius: 14px !important;
    text-decoration: none; text-transform: uppercase; letter-spacing: 0.5px; color: #1e293b !important; 
    box-shadow: 0 2px 10px rgba(0,0,0,0.02);
}
.qa-btn:hover { 
    background: linear-gradient(135deg, #10b981, #059669) !important; 
    color: #fff !important; border-color: transparent !important; 
    transform: translateY(-2px); 
    box-shadow: 0 8px 20px rgba(16, 185, 129, 0.25); 
}
.qa-icon { 
    width: 38px; height: 38px; display: flex; align-items: center; justify-content: center; 
    font-size: 1.1rem; flex-shrink: 0; background: #f0fdf4; border: 1px solid #bbf7d0; 
    border-radius: 10px; color: #10b981; transition: all 0.2s; 
}
.qa-btn:hover .qa-icon { color: #10b981; border-color: transparent; background: #ffffff; }

/* ── LIST ROWS (Recent Activity, Gradebook) ── */
.gb-row, .trow { 
    border-bottom: 1px solid #f1f5f9; transition: all 0.15s; background: #ffffff; 
}
.gb-row:hover, .trow:hover { 
    background: #f8fafc !important; 
}

/* ── TOPBAR ── */
.topbar { 
    background: rgba(255, 255, 255, 0.9) !important; 
    backdrop-filter: blur(10px);
    border-bottom: 1px solid #e2e8f0 !important; 
    box-shadow: 0 2px 10px rgba(0,0,0,0.02); 
}
