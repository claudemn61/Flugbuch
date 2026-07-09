const { useState, useEffect, useCallback } = React;

// ── Service Page ─────────────────────────────────────────────────────────
// Two top-level badges: Reserve (fully built) and Schirm (placeholder, comes
// later). Reserve has exactly 3 fixed slots: Solo integriert, Solo extern,
// Biplace. Each slot has: Name, Serien-Nr., Kaufdatum, a free-form list of
// check dates+notes, and an editable check-interval (months) from which the
// next-due date is computed.

const RESERVE_SLOTS = [
  { id: "solo_int", label: "Solo integriert" },
  { id: "solo_ext", label: "Solo extern" },
  { id: "biplace",  label: "Biplace" },
];

// Schirm has 4 tab positions, but each tab's category name is user-editable
// via a dropdown (unlike Reserve's fixed labels) — someone might own e.g.
// Solo + Bergschirm + Biplace + Biplace light, or any other combination of
// up to 4 of the 5 possible types. "–" means the slot isn't assigned yet.
const SCHIRM_CATEGORY_OPTIONS = ["–", "Solo", "Solo light", "Bergschirm", "Biplace", "Biplace light"];
const SCHIRM_SLOT_IDS = ["schirm_1", "schirm_2", "schirm_3", "schirm_4"];

function todayStr() {
  const d = new Date();
  return `${String(d.getDate()).padStart(2,"0")}.${String(d.getMonth()+1).padStart(2,"0")}.${d.getFullYear()}`;
}

const GERMAN_MONTHS = {
  "januar":1,"februar":2,"märz":3,"maerz":3,"april":4,"mai":5,"juni":6,
  "juli":7,"august":8,"september":9,"oktober":10,"november":11,"dezember":12,
  "jan":1,"feb":2,"mär":3,"mar":3,"apr":4,"jun":6,"jul":7,"aug":8,"sep":9,"sept":9,"okt":10,"nov":11,"dez":12,
};

function parseDateStr(s) {
  if (!s) return null;
  const str = String(s).trim();
  // Numeric "TT.MM.JJJJ" or "T.M.JJ" format (what this app writes itself)
  const m = str.match(/^(\d{1,2})\.(\d{1,2})\.(\d{2,4})$/);
  if (m) {
    let [_, dd, mm, yy] = m;
    yy = yy.length === 2 ? "20"+yy : yy;
    return new Date(+yy, +mm-1, +dd);
  }
  // German long-form "10. Mai 2026" or "10 Mai 2026" (e.g. from iOS
  // auto-formatting a date-like text field, or manual typing)
  const m2 = str.match(/^(\d{1,2})\.?\s+([a-zA-ZäöüÄÖÜ]+)\.?\s+(\d{2,4})$/);
  if (m2) {
    const [_, dd, monthName, yy] = m2;
    const monthNum = GERMAN_MONTHS[monthName.toLowerCase()];
    if (monthNum) {
      const year = yy.length === 2 ? "20"+yy : yy;
      return new Date(+year, monthNum-1, +dd);
    }
  }
  return null;
}

function addMonths(date, months) {
  const d = new Date(date);
  d.setMonth(d.getMonth() + months);
  return d;
}

function fmtDate(d) {
  if (!d) return "—";
  return `${String(d.getDate()).padStart(2,"0")}.${String(d.getMonth()+1).padStart(2,"0")}.${d.getFullYear()}`;
}

function daysUntil(d) {
  if (!d) return null;
  const now = new Date(); now.setHours(0,0,0,0);
  const target = new Date(d); target.setHours(0,0,0,0);
  return Math.round((target - now) / 86400000);
}

function emptyReserve() {
  return { name: "", serialNr: "", purchaseDate: "", checks: [], intervalMonths: 12 };
}

function emptySchirmSlot() {
  return { category: "–", name: "", serialNr: "", zulassung: "", purchaseDate: "", checks: [], intervalMonths: 12 };
}

function ServiceApp() {
  const [showReserve, setShowReserve] = useState(false);
  const [showSchirm, setShowSchirm] = useState(false);
  const [activeReserveSlot, setActiveReserveSlot] = useState(RESERVE_SLOTS[0].id);
  const [activeSchirmSlot, setActiveSchirmSlot] = useState(SCHIRM_SLOT_IDS[0]);
  const [reserves, setReserves] = useState(() => {
    const obj = {};
    RESERVE_SLOTS.forEach(s => obj[s.id] = emptyReserve());
    return obj;
  });
  const [schirme, setSchirme] = useState(() => {
    const obj = {};
    SCHIRM_SLOT_IDS.forEach(id => obj[id] = emptySchirmSlot());
    return obj;
  });
  const [loaded, setLoaded] = useState(false);

  // Load from the same IndexedDB-backed storage the Flugbuch app uses.
  useEffect(() => {
    (async () => {
      try {
        const r = await window.storage.get("service:reserves");
        if (r) setReserves(prev => ({ ...prev, ...JSON.parse(r.value) }));
      } catch (e) { console.error("Load error (reserves):", e); }
      try {
        const r2 = await window.storage.get("service:schirme");
        if (r2) setSchirme(prev => ({ ...prev, ...JSON.parse(r2.value) }));
      } catch (e) { console.error("Load error (schirme):", e); }
      setLoaded(true);
    })();
  }, []);

  const saveReserves = useCallback(async (next) => {
    setReserves(next);
    try { await window.storage.set("service:reserves", JSON.stringify(next)); } catch (e) { console.error("Save error:", e); }
  }, []);

  const saveSchirme = useCallback(async (next) => {
    setSchirme(next);
    try { await window.storage.set("service:schirme", JSON.stringify(next)); } catch (e) { console.error("Save error:", e); }
  }, []);

  const updateSlot = (slotId, patch) => {
    const next = { ...reserves, [slotId]: { ...reserves[slotId], ...patch } };
    saveReserves(next);
  };

  const addCheck = (slotId, dateStr) => {
    const slot = reserves[slotId];
    const checks = [...(slot.checks||[]), { date: dateStr, note: "" }]
      .sort((a,b) => (parseDateStr(b.date)||0) - (parseDateStr(a.date)||0));
    updateSlot(slotId, { checks });
  };

  const updateCheck = (slotId, idx, patch, resort) => {
    const slot = reserves[slotId];
    let checks = slot.checks.map((c,i) => i===idx ? {...c, ...patch} : c);
    if (resort) checks = checks.sort((a,b) => (parseDateStr(b.date)||0) - (parseDateStr(a.date)||0));
    updateSlot(slotId, { checks });
  };

  const updateSchirmSlot = (slotId, patch) => {
    const next = { ...schirme, [slotId]: { ...schirme[slotId], ...patch } };
    saveSchirme(next);
  };

  const addSchirmCheck = (slotId, dateStr) => {
    const slot = schirme[slotId];
    const checks = [...(slot.checks||[]), { date: dateStr, note: "" }]
      .sort((a,b) => (parseDateStr(b.date)||0) - (parseDateStr(a.date)||0));
    updateSchirmSlot(slotId, { checks });
  };

  const updateSchirmCheck = (slotId, idx, patch, resort) => {
    const slot = schirme[slotId];
    let checks = slot.checks.map((c,i) => i===idx ? {...c, ...patch} : c);
    if (resort) checks = checks.sort((a,b) => (parseDateStr(b.date)||0) - (parseDateStr(a.date)||0));
    updateSchirmSlot(slotId, { checks });
  };

  const deleteCheck = (slotId, idx) => {
    const slot = reserves[slotId];
    const checks = slot.checks.filter((_,i) => i!==idx);
    updateSlot(slotId, { checks });
  };

  const deleteSchirmCheck = (slotId, idx) => {
    const slot = schirme[slotId];
    const checks = slot.checks.filter((_,i) => i!==idx);
    updateSchirmSlot(slotId, { checks });
  };

  if (!loaded) return null;

  const data = reserves[activeReserveSlot] || emptyReserve();
  // Base the next-due calculation on the newest (topmost) check entry; if
  // there's no check yet, fall back to the purchase date instead.
  const lastCheck = (data.checks && data.checks.length ? parseDateStr(data.checks[0].date) : null) || parseDateStr(data.purchaseDate);
  const nextDue = lastCheck ? addMonths(lastCheck, data.intervalMonths||12) : null;
  const dueDays = daysUntil(nextDue);
  const overdue = dueDays !== null && dueDays < 0;
  const soonDue = dueDays !== null && dueDays >= 0 && dueDays <= 30;

  const schirmData = schirme[activeSchirmSlot] || emptySchirmSlot();
  const schirmLastCheck = (schirmData.checks && schirmData.checks.length ? parseDateStr(schirmData.checks[0].date) : null) || parseDateStr(schirmData.purchaseDate);
  const schirmNextDue = schirmLastCheck ? addMonths(schirmLastCheck, schirmData.intervalMonths||12) : null;
  const schirmDueDays = daysUntil(schirmNextDue);
  const schirmOverdue = schirmDueDays !== null && schirmDueDays < 0;
  const schirmSoonDue = schirmDueDays !== null && schirmDueDays >= 0 && schirmDueDays <= 30;

  return (
    <div style={{minHeight:"100vh",background:"#051d0e",color:"#e8f4fd",fontFamily:"-apple-system,BlinkMacSystemFont,sans-serif",paddingBottom:40}}>
      {/* Header */}
      <div style={{background:"rgba(255,255,255,0.03)",borderBottom:"1px solid rgba(255,255,255,0.06)",padding:"calc(28px + env(safe-area-inset-top, 0px)) 16px 12px",display:"flex",alignItems:"center",position:"sticky",top:0,zIndex:10,backdropFilter:"blur(10px)"}}>
        <a href="index.html" title="Zur Startseite"
          style={{background:"rgba(255,255,255,0.06)",border:"1px solid rgba(255,255,255,0.1)",borderRadius:10,width:32,height:32,display:"flex",alignItems:"center",justifyContent:"center",fontSize:15,color:"rgba(232,244,253,0.8)",cursor:"pointer",flexShrink:0,textDecoration:"none",boxSizing:"border-box"}}>
          🏠
        </a>
        <span style={{fontWeight:900,fontSize:18,letterSpacing:-0.5,flex:1,textAlign:"center",marginLeft:-32}}>
          🛠️ Service
        </span>
      </div>

      {/* Top badges: Reserve / Schirm */}
      <div style={{padding:"14px 16px 0",display:"flex",gap:10}}>
        <button onClick={()=>{setShowReserve(s=>!s); setShowSchirm(false);}}
          style={{flex:1,background:showReserve?"rgba(34,197,94,0.18)":"rgba(255,255,255,0.05)",border:`1px solid ${showReserve?"rgba(34,197,94,0.4)":"rgba(255,255,255,0.1)"}`,borderRadius:12,padding:"12px 10px",color:showReserve?"#4ade80":"rgba(232,244,253,0.8)",fontSize:14,fontWeight:700,cursor:"pointer",textAlign:"center"}}>
          🪂 Reserve {showReserve?"▾":"▸"}
        </button>
        <button onClick={()=>{setShowSchirm(s=>!s); setShowReserve(false);}}
          style={{flex:1,background:showSchirm?"rgba(56,189,248,0.18)":"rgba(255,255,255,0.05)",border:`1px solid ${showSchirm?"rgba(56,189,248,0.4)":"rgba(255,255,255,0.1)"}`,borderRadius:12,padding:"12px 10px",color:showSchirm?"#7dd3fc":"rgba(232,244,253,0.8)",fontSize:14,fontWeight:700,cursor:"pointer",textAlign:"center"}}>
          ⛰️ Schirm {showSchirm?"▾":"▸"}
        </button>
      </div>

      {/* Schirm section: 4 tab positions, each with an editable category dropdown */}
      {showSchirm && (
        <div style={{padding:"12px 16px 0"}}>
          {/* Tabs: each shows its assigned category name (or "–") */}
          <div style={{display:"flex",gap:6,marginBottom:14,background:"rgba(255,255,255,0.03)",borderRadius:12,padding:4}}>
            {SCHIRM_SLOT_IDS.map(slotId => {
              const slot = schirme[slotId] || emptySchirmSlot();
              return (
                <button key={slotId} onClick={()=>setActiveSchirmSlot(slotId)}
                  style={{
                    flex:1,padding:"9px 4px",borderRadius:9,border:"none",cursor:"pointer",
                    fontSize:11.5,fontWeight:700,whiteSpace:"nowrap",overflow:"hidden",textOverflow:"ellipsis",
                    background: activeSchirmSlot===slotId ? "rgba(56,189,248,0.22)" : "transparent",
                    color: activeSchirmSlot===slotId ? "#7dd3fc" : "rgba(232,244,253,0.5)",
                  }}>
                  {slot.category === "–" ? "" : slot.category}
                </button>
              );
            })}
          </div>

          {/* Fields for the currently selected tab */}
          <div style={{background:"rgba(255,255,255,0.04)",border:"1px solid rgba(255,255,255,0.08)",borderRadius:14,padding:16,display:"flex",flexDirection:"column",gap:14}}>
            {/* Category dropdown */}
            <div>
              <div style={{fontSize:11,color:"rgba(232,244,253,0.4)",marginBottom:4,textTransform:"uppercase",letterSpacing:0.5}}>Kategorie</div>
              <select value={schirmData.category} onChange={e=>updateSchirmSlot(activeSchirmSlot,{category:e.target.value})}
                style={{width:"100%",background:"rgba(255,255,255,0.06)",border:"1px solid rgba(255,255,255,0.1)",borderRadius:8,padding:"9px 10px",color:"#e8f4fd",fontSize:14,boxSizing:"border-box"}}>
                {SCHIRM_CATEGORY_OPTIONS.map(opt => (
                  <option key={opt} value={opt} style={{background:"#0d1b2a",color:"#e8f4fd"}}>{opt}</option>
                ))}
              </select>
            </div>

            {/* Name */}
            <div>
              <div style={{fontSize:11,color:"rgba(232,244,253,0.4)",marginBottom:4,textTransform:"uppercase",letterSpacing:0.5}}>Name</div>
              <input value={schirmData.name} onChange={e=>updateSchirmSlot(activeSchirmSlot,{name:e.target.value})}
                placeholder="z.B. Ozone Wisp 2"
                style={{width:"100%",background:"rgba(255,255,255,0.06)",border:"1px solid rgba(255,255,255,0.1)",borderRadius:8,padding:"9px 10px",color:"#e8f4fd",fontSize:14,boxSizing:"border-box"}} />
            </div>

            {/* Serien-Nr. */}
            <div>
              <div style={{fontSize:11,color:"rgba(232,244,253,0.4)",marginBottom:4,textTransform:"uppercase",letterSpacing:0.5}}>Serien-Nr.</div>
              <input value={schirmData.serialNr} onChange={e=>updateSchirmSlot(activeSchirmSlot,{serialNr:e.target.value})}
                placeholder="z.B. SN-123456"
                style={{width:"100%",background:"rgba(255,255,255,0.06)",border:"1px solid rgba(255,255,255,0.1)",borderRadius:8,padding:"9px 10px",color:"#e8f4fd",fontSize:14,boxSizing:"border-box"}} />
            </div>

            {/* Zulassung */}
            <div>
              <div style={{fontSize:11,color:"rgba(232,244,253,0.4)",marginBottom:4,textTransform:"uppercase",letterSpacing:0.5}}>Zulassung</div>
              <input value={schirmData.zulassung||""} onChange={e=>updateSchirmSlot(activeSchirmSlot,{zulassung:e.target.value})}
                placeholder="z.B. EN B"
                style={{width:"100%",background:"rgba(255,255,255,0.06)",border:"1px solid rgba(255,255,255,0.1)",borderRadius:8,padding:"9px 10px",color:"#e8f4fd",fontSize:14,boxSizing:"border-box"}} />
            </div>

            {/* Kauf */}
            <div>
              <div style={{fontSize:11,color:"rgba(232,244,253,0.4)",marginBottom:4,textTransform:"uppercase",letterSpacing:0.5}}>Kauf</div>
              <input value={schirmData.purchaseDate} onChange={e=>updateSchirmSlot(activeSchirmSlot,{purchaseDate:e.target.value})}
                placeholder="TT.MM.JJJJ"
                style={{width:"100%",background:"rgba(255,255,255,0.06)",border:"1px solid rgba(255,255,255,0.1)",borderRadius:8,padding:"9px 10px",color:"#e8f4fd",fontSize:14,boxSizing:"border-box"}} />
            </div>

            {/* Check-Intervall */}
            <div>
              <div style={{fontSize:11,color:"rgba(232,244,253,0.4)",marginBottom:4,textTransform:"uppercase",letterSpacing:0.5}}>Check-Intervall</div>
              <div style={{display:"flex",alignItems:"center",gap:8}}>
                <input type="number" min="1" value={schirmData.intervalMonths}
                  onChange={e=>updateSchirmSlot(activeSchirmSlot,{intervalMonths: e.target.value})}
                  onBlur={e=>updateSchirmSlot(activeSchirmSlot,{intervalMonths: Math.max(1, parseInt(e.target.value)||1)})}
                  style={{width:70,background:"rgba(255,255,255,0.06)",border:"1px solid rgba(255,255,255,0.1)",borderRadius:8,padding:"9px 10px",color:"#e8f4fd",fontSize:14,boxSizing:"border-box"}} />
                <span style={{fontSize:13,color:"rgba(232,244,253,0.6)"}}>Monate</span>
              </div>
            </div>

            {/* Checks list */}
            <div>
              <div style={{display:"flex",justifyContent:"space-between",alignItems:"center",marginBottom:6}}>
                <div style={{fontSize:11,color:"rgba(232,244,253,0.4)",textTransform:"uppercase",letterSpacing:0.5}}>Checks</div>
                <span style={{fontSize:12,fontWeight:700,padding:"3px 9px",borderRadius:20,
                  background: schirmOverdue ? "rgba(239,68,68,0.18)" : schirmSoonDue ? "rgba(245,158,11,0.18)" : "rgba(34,197,94,0.12)",
                  color: schirmOverdue ? "#f87171" : schirmSoonDue ? "#fcd34d" : "#4ade80"}}>
                  {schirmOverdue ? "Überfällig" : `Nächster Check ${fmtDate(schirmNextDue)}`}
                </span>
                <button onClick={()=>addSchirmCheck(activeSchirmSlot, todayStr())}
                  style={{background:"rgba(34,197,94,0.15)",border:"1px solid rgba(34,197,94,0.3)",borderRadius:20,padding:"4px 10px",color:"#4ade80",fontSize:11,fontWeight:700,cursor:"pointer"}}>
                  + Check
                </button>
              </div>
              {(!schirmData.checks || schirmData.checks.length===0) && (
                <div style={{fontSize:12,color:"rgba(232,244,253,0.3)",padding:"8px 0"}}>Noch keine Checks erfasst.</div>
              )}
              <div style={{display:"flex",flexDirection:"column",gap:8}}>
                {(schirmData.checks||[]).map((c, idx) => (
                  <div key={idx} style={{display:"flex",gap:8,alignItems:"center"}}>
                    <input value={c.note} onChange={e=>updateSchirmCheck(activeSchirmSlot, idx, {note:e.target.value})}
                      placeholder="Text (z.B. Leinencheck)"
                      style={{flex:1,background:"rgba(255,255,255,0.06)",border:"1px solid rgba(255,255,255,0.1)",borderRadius:8,padding:"8px 10px",color:"#e8f4fd",fontSize:13,boxSizing:"border-box"}} />
                    <input value={c.date} onChange={e=>updateSchirmCheck(activeSchirmSlot, idx, {date:e.target.value})}
                      placeholder="TT.MM.JJJJ"
                      style={{width:110,background:"rgba(255,255,255,0.06)",border:"1px solid rgba(255,255,255,0.1)",borderRadius:8,padding:"8px 10px",color:"#e8f4fd",fontSize:13,boxSizing:"border-box"}} />
                    <button onClick={()=>deleteSchirmCheck(activeSchirmSlot, idx)}
                      style={{background:"rgba(239,68,68,0.12)",border:"1px solid rgba(239,68,68,0.25)",borderRadius:8,width:30,height:30,color:"#f87171",fontSize:13,cursor:"pointer",flexShrink:0}}>
                      ✕
                    </button>
                  </div>
                ))}
              </div>
            </div>
          </div>
        </div>
      )}

      {/* Reserve section: category selector (Auswahl) + fields for the active one */}
      {showReserve && (
        <div style={{padding:"12px 16px 0"}}>
          {/* Auswahl: tab-style selector between the 3 categories */}
          <div style={{display:"flex",gap:6,marginBottom:14,background:"rgba(255,255,255,0.03)",borderRadius:12,padding:4}}>
            {RESERVE_SLOTS.map(slot => (
              <button key={slot.id} onClick={()=>setActiveReserveSlot(slot.id)}
                style={{
                  flex:1,padding:"9px 6px",borderRadius:9,border:"none",cursor:"pointer",
                  fontSize:12.5,fontWeight:700,whiteSpace:"nowrap",
                  background: activeReserveSlot===slot.id ? "rgba(34,197,94,0.22)" : "transparent",
                  color: activeReserveSlot===slot.id ? "#4ade80" : "rgba(232,244,253,0.5)",
                }}>
                {slot.label}
              </button>
            ))}
          </div>

          {/* Fields for the currently selected category */}
          <div style={{background:"rgba(255,255,255,0.04)",border:"1px solid rgba(255,255,255,0.08)",borderRadius:14,padding:16,display:"flex",flexDirection:"column",gap:14}}>
            {/* Name */}
            <div>
              <div style={{fontSize:11,color:"rgba(232,244,253,0.4)",marginBottom:4,textTransform:"uppercase",letterSpacing:0.5}}>Name</div>
              <input value={data.name} onChange={e=>updateSlot(activeReserveSlot,{name:e.target.value})}
                placeholder="z.B. Companion Light 3"
                style={{width:"100%",background:"rgba(255,255,255,0.06)",border:"1px solid rgba(255,255,255,0.1)",borderRadius:8,padding:"9px 10px",color:"#e8f4fd",fontSize:14,boxSizing:"border-box"}} />
            </div>

            {/* Serien-Nr. */}
            <div>
              <div style={{fontSize:11,color:"rgba(232,244,253,0.4)",marginBottom:4,textTransform:"uppercase",letterSpacing:0.5}}>Serien-Nr.</div>
              <input value={data.serialNr} onChange={e=>updateSlot(activeReserveSlot,{serialNr:e.target.value})}
                placeholder="z.B. SN-123456"
                style={{width:"100%",background:"rgba(255,255,255,0.06)",border:"1px solid rgba(255,255,255,0.1)",borderRadius:8,padding:"9px 10px",color:"#e8f4fd",fontSize:14,boxSizing:"border-box"}} />
            </div>

            {/* Kauf */}
            <div>
              <div style={{fontSize:11,color:"rgba(232,244,253,0.4)",marginBottom:4,textTransform:"uppercase",letterSpacing:0.5}}>Kauf</div>
              <input value={data.purchaseDate} onChange={e=>updateSlot(activeReserveSlot,{purchaseDate:e.target.value})}
                placeholder="TT.MM.JJJJ"
                style={{width:"100%",background:"rgba(255,255,255,0.06)",border:"1px solid rgba(255,255,255,0.1)",borderRadius:8,padding:"9px 10px",color:"#e8f4fd",fontSize:14,boxSizing:"border-box"}} />
            </div>

            {/* Packen-Intervall */}
            <div>
              <div style={{fontSize:11,color:"rgba(232,244,253,0.4)",marginBottom:4,textTransform:"uppercase",letterSpacing:0.5}}>Packen-Intervall</div>
              <div style={{display:"flex",alignItems:"center",gap:8}}>
                <input type="number" min="1" value={data.intervalMonths}
                  onChange={e=>{
                    const v = e.target.value;
                    // Store the raw typed value as-is (even empty) so the person
                    // can clear the field and type a new number — coercing to a
                    // minimum of 1 on every keystroke made it impossible to ever
                    // get past the leading "1".
                    updateSlot(activeReserveSlot,{intervalMonths: v});
                  }}
                  onBlur={e=>{
                    const n = Math.max(1, parseInt(e.target.value)||1);
                    updateSlot(activeReserveSlot,{intervalMonths: n});
                  }}
                  style={{width:70,background:"rgba(255,255,255,0.06)",border:"1px solid rgba(255,255,255,0.1)",borderRadius:8,padding:"9px 10px",color:"#e8f4fd",fontSize:14,boxSizing:"border-box"}} />
                <span style={{fontSize:13,color:"rgba(232,244,253,0.6)"}}>Monate</span>
              </div>
            </div>

            {/* Packen list */}
            <div>
              <div style={{display:"flex",justifyContent:"space-between",alignItems:"center",marginBottom:6}}>
                <div style={{fontSize:11,color:"rgba(232,244,253,0.4)",textTransform:"uppercase",letterSpacing:0.5}}>Packen</div>
                <span style={{fontSize:12,fontWeight:700,padding:"3px 9px",borderRadius:20,
                  background: overdue ? "rgba(239,68,68,0.18)" : soonDue ? "rgba(245,158,11,0.18)" : "rgba(34,197,94,0.12)",
                  color: overdue ? "#f87171" : soonDue ? "#fcd34d" : "#4ade80"}}>
                  {overdue ? "Überfällig" : `Nächstes Packen ${fmtDate(nextDue)}`}
                </span>
                <button onClick={()=>addCheck(activeReserveSlot, todayStr())}
                  style={{background:"rgba(34,197,94,0.15)",border:"1px solid rgba(34,197,94,0.3)",borderRadius:20,padding:"4px 10px",color:"#4ade80",fontSize:11,fontWeight:700,cursor:"pointer"}}>
                  + Packen
                </button>
              </div>
              {(!data.checks || data.checks.length===0) && (
                <div style={{fontSize:12,color:"rgba(232,244,253,0.3)",padding:"8px 0"}}>Noch nichts erfasst.</div>
              )}
              <div style={{display:"flex",flexDirection:"column",gap:8}}>
                {(data.checks||[]).map((c, idx) => (
                  <div key={idx} style={{display:"flex",gap:8,alignItems:"center"}}>
                    <input value={c.note} onChange={e=>updateCheck(activeReserveSlot, idx, {note:e.target.value})}
                      placeholder="Text (z.B. Leinencheck)"
                      style={{flex:1,background:"rgba(255,255,255,0.06)",border:"1px solid rgba(255,255,255,0.1)",borderRadius:8,padding:"8px 10px",color:"#e8f4fd",fontSize:13,boxSizing:"border-box"}} />
                    <input value={c.date} onChange={e=>updateCheck(activeReserveSlot, idx, {date:e.target.value})}
                      placeholder="TT.MM.JJJJ"
                      style={{width:110,background:"rgba(255,255,255,0.06)",border:"1px solid rgba(255,255,255,0.1)",borderRadius:8,padding:"8px 10px",color:"#e8f4fd",fontSize:13,boxSizing:"border-box"}} />
                    <button onClick={()=>deleteCheck(activeReserveSlot, idx)}
                      style={{background:"rgba(239,68,68,0.12)",border:"1px solid rgba(239,68,68,0.25)",borderRadius:8,width:30,height:30,color:"#f87171",fontSize:13,cursor:"pointer",flexShrink:0}}>
                      ✕
                    </button>
                  </div>
                ))}
              </div>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
