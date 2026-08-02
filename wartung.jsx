const { useState, useEffect, useCallback } = React;

function useIsWide() {
  const [isWide, setIsWide] = useState(typeof window !== "undefined" ? window.innerWidth >= 768 : false);
  useEffect(() => {
    const onResize = () => setIsWide(window.innerWidth >= 768);
    window.addEventListener("resize", onResize);
    return () => window.removeEventListener("resize", onResize);
  }, []);
  return isWide;
}

// ── Wartung Page (ehem. "Service") ───────────────────────────────────────
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

// Schirm has 4 tab positions and Reserve has 3 — each tab's title is now
// directly editable text (tap the tab, type a new name), not driven by a
// separate category dropdown.
const SCHIRM_SLOT_IDS = ["schirm_1", "schirm_2", "schirm_3", "schirm_4"];
const GURTZEUG_SLOT_IDS = ["gurtzeug_1", "gurtzeug_2", "gurtzeug_3", "gurtzeug_4", "gurtzeug_5"];

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

// Free-text check dates had drifted into several different formats over
// time (DD.MM.YY, DD.MM.YYYY, and German long-form "D. MMM YYYY" like
// "4. Nov. 2025") since the field was always a plain text input with no
// enforced format. Reuses the existing parseDateStr/fmtDate pair (already
// used for due-date calculations) rather than a second parser, so both
// stay consistent with each other by construction.
function normalizeCheckDate(str) {
  const d = parseDateStr(str);
  return d ? fmtDate(d) : str; // unrecognised — left as-is rather than guessing
}

function daysUntil(d) {
  if (!d) return null;
  const now = new Date(); now.setHours(0,0,0,0);
  const target = new Date(d); target.setHours(0,0,0,0);
  return Math.round((target - now) / 86400000);
}

function emptyReserve() {
  return { title: "", category: "–", name: "", serialNr: "", purchaseDate: "", checks: [], intervalMonths: 12 };
}

function emptySchirmSlot() {
  return { title: "", category: "–", name: "", serialNr: "", zulassung: "", purchaseDate: "", checks: [], intervalMonths: 12 };
}

// Wide-screen (iPad/desktop) view: every slot shown as its own permanently
// open column instead of switching between them via tabs — "spaltenartig
// fix offen". Used for all three chapters (Reserve/Schirm/Sitz); Reserve
// has no Zulassung field, the others do.
function SlotColumnsView({ slotIds, dataMap, updateSlot, addCheck, updateCheck, deleteCheck, editingTab, setEditingTab, accentColor, accentBg, defaultTitle, hasZulassung }) {
  return (
    <div style={{display:"flex",gap:12,overflowX:"auto",padding:"12px 16px 20px"}}>
      {slotIds.map((slotId, i) => {
        const data = dataMap[slotId] || emptySchirmSlot();
        const isEditing = editingTab===slotId;
        const displayTitle = data.title || (data.category && data.category!=="–" ? data.category : "");
        const lastCheck = (data.checks && data.checks.length ? parseDateStr(data.checks[0].date) : null) || parseDateStr(data.purchaseDate);
        const nextDue = lastCheck ? addMonths(lastCheck, data.intervalMonths||12) : null;
        const dueDays = daysUntil(nextDue);
        const overdue = dueDays !== null && dueDays < 0;
        const soonDue = dueDays !== null && dueDays >= 0 && dueDays <= 30;
        return (
          <div key={slotId} style={{flex:"0 0 260px",background:"rgba(255,255,255,0.04)",border:"1px solid rgba(255,255,255,0.08)",borderRadius:14,padding:14,display:"flex",flexDirection:"column",gap:12}}>
            {isEditing ? (
              <input autoFocus value={displayTitle}
                onChange={e=>updateSlot(slotId,{title:e.target.value})}
                onBlur={()=>setEditingTab(null)}
                onKeyDown={e=>{ if (e.key==="Enter") e.currentTarget.blur(); }}
                placeholder={defaultTitle(i)}
                style={{background:accentBg,border:`1px solid ${accentColor}66`,borderRadius:8,padding:"7px 10px",color:accentColor,fontSize:14,fontWeight:700,outline:"none"}} />
            ) : (
              <div onClick={()=>setEditingTab(slotId)} style={{cursor:"text",background:accentBg,border:`1px solid ${accentColor}40`,borderRadius:8,padding:"7px 10px",color:accentColor,fontSize:14,fontWeight:700}}>
                {displayTitle || defaultTitle(i)}
              </div>
            )}
            <div>
              <div style={{fontSize:10,color:"rgba(232,244,253,0.4)",marginBottom:3,textTransform:"uppercase",letterSpacing:0.5}}>Name</div>
              <input value={data.name} onChange={e=>updateSlot(slotId,{name:e.target.value})}
                style={{width:"100%",background:"rgba(255,255,255,0.06)",border:"1px solid rgba(255,255,255,0.1)",borderRadius:8,padding:"7px 9px",color:"#e8f4fd",fontSize:13,boxSizing:"border-box"}} />
            </div>
            <div>
              <div style={{fontSize:10,color:"rgba(232,244,253,0.4)",marginBottom:3,textTransform:"uppercase",letterSpacing:0.5}}>Serien-Nr.</div>
              <input value={data.serialNr} onChange={e=>updateSlot(slotId,{serialNr:e.target.value})}
                style={{width:"100%",background:"rgba(255,255,255,0.06)",border:"1px solid rgba(255,255,255,0.1)",borderRadius:8,padding:"7px 9px",color:"#e8f4fd",fontSize:13,boxSizing:"border-box"}} />
            </div>
            {hasZulassung && (
              <div>
                <div style={{fontSize:10,color:"rgba(232,244,253,0.4)",marginBottom:3,textTransform:"uppercase",letterSpacing:0.5}}>Zulassung</div>
                <input value={data.zulassung||""} onChange={e=>updateSlot(slotId,{zulassung:e.target.value})}
                  style={{width:"100%",background:"rgba(255,255,255,0.06)",border:"1px solid rgba(255,255,255,0.1)",borderRadius:8,padding:"7px 9px",color:"#e8f4fd",fontSize:13,boxSizing:"border-box"}} />
              </div>
            )}
            <div>
              <div style={{fontSize:10,color:"rgba(232,244,253,0.4)",marginBottom:3,textTransform:"uppercase",letterSpacing:0.5}}>Kauf</div>
              <input value={data.purchaseDate} onChange={e=>updateSlot(slotId,{purchaseDate:e.target.value})}
                placeholder="TT.MM.JJJJ"
                style={{width:"100%",background:"rgba(255,255,255,0.06)",border:"1px solid rgba(255,255,255,0.1)",borderRadius:8,padding:"7px 9px",color:"#e8f4fd",fontSize:13,boxSizing:"border-box"}} />
            </div>
            <div>
              <div style={{fontSize:10,color:"rgba(232,244,253,0.4)",marginBottom:3,textTransform:"uppercase",letterSpacing:0.5}}>Intervall (Monate)</div>
              <input type="number" min="1" value={data.intervalMonths}
                onChange={e=>updateSlot(slotId,{intervalMonths:e.target.value})}
                onBlur={e=>updateSlot(slotId,{intervalMonths:Math.max(1,parseInt(e.target.value)||1)})}
                style={{width:"100%",background:"rgba(255,255,255,0.06)",border:"1px solid rgba(255,255,255,0.1)",borderRadius:8,padding:"7px 9px",color:"#e8f4fd",fontSize:13,boxSizing:"border-box"}} />
            </div>
            <div>
              <div style={{display:"flex",justifyContent:"space-between",alignItems:"center",marginBottom:6}}>
                <div style={{fontSize:10,color:"rgba(232,244,253,0.4)",textTransform:"uppercase",letterSpacing:0.5}}>Checks</div>
                <button onClick={()=>addCheck(slotId, todayStr())}
                  style={{background:"rgba(34,197,94,0.15)",border:"1px solid rgba(34,197,94,0.3)",borderRadius:20,padding:"3px 8px",color:"#4ade80",fontSize:10,fontWeight:700,cursor:"pointer"}}>
                  + Check
                </button>
              </div>
              <div style={{fontSize:10,fontWeight:700,padding:"3px 8px",borderRadius:20,display:"inline-block",marginBottom:8,
                background: overdue ? "rgba(239,68,68,0.18)" : soonDue ? "rgba(245,158,11,0.18)" : "rgba(34,197,94,0.12)",
                color: overdue ? "#f87171" : soonDue ? "#fcd34d" : "#4ade80"}}>
                {overdue ? "Überfällig" : `Nächster Check ${fmtDate(nextDue)}`}
              </div>
              <div style={{display:"flex",flexDirection:"column",gap:6}}>
                {(data.checks||[]).map((c, idx) => (
                  <div key={idx} style={{display:"flex",gap:5,alignItems:"center"}}>
                    <input value={c.note} onChange={e=>updateCheck(slotId, idx, {note:e.target.value})}
                      placeholder="Notiz"
                      style={{flex:1,minWidth:0,background:"rgba(255,255,255,0.06)",border:"1px solid rgba(255,255,255,0.1)",borderRadius:6,padding:"6px 7px",color:"#e8f4fd",fontSize:11,boxSizing:"border-box"}} />
                    <input value={normalizeCheckDate(c.date)} onChange={e=>updateCheck(slotId, idx, {date:e.target.value})}
                      onBlur={e=>updateCheck(slotId, idx, {date:normalizeCheckDate(e.target.value)})}
                      style={{width:78,flexShrink:0,background:"rgba(255,255,255,0.06)",border:"1px solid rgba(255,255,255,0.1)",borderRadius:6,padding:"6px 7px",color:"#e8f4fd",fontSize:11,boxSizing:"border-box"}} />
                    <button onClick={()=>deleteCheck(slotId, idx)}
                      style={{background:"rgba(239,68,68,0.12)",border:"1px solid rgba(239,68,68,0.25)",borderRadius:6,width:24,height:24,color:"#f87171",fontSize:11,cursor:"pointer",flexShrink:0}}>
                      ✕
                    </button>
                  </div>
                ))}
              </div>
            </div>
          </div>
        );
      })}
    </div>
  );
}

function WartungApp() {
  const isWide = useIsWide();
  const [activeTab, setActiveTab] = useState("schirm"); // "schirm" | "reserve" — always exactly one, never both/neither
  const [activeReserveSlot, setActiveReserveSlot] = useState(RESERVE_SLOTS[0].id);
  const [editingReserveTab, setEditingReserveTab] = useState(null); // slot.id currently being renamed, or null
  const [activeSchirmSlot, setActiveSchirmSlot] = useState(SCHIRM_SLOT_IDS[0]);
  const [editingSchirmTab, setEditingSchirmTab] = useState(null); // slotId currently being renamed, or null
  const [activeGurtzeugSlot, setActiveGurtzeugSlot] = useState(GURTZEUG_SLOT_IDS[0]);
  const [editingGurtzeugTab, setEditingGurtzeugTab] = useState(null);
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
  const [gurtzeuge, setGurtzeuge] = useState(() => {
    const obj = {};
    GURTZEUG_SLOT_IDS.forEach(id => obj[id] = emptySchirmSlot());
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
      try {
        const r3 = await window.storage.get("service:gurtzeuge");
        if (r3) setGurtzeuge(prev => ({ ...prev, ...JSON.parse(r3.value) }));
      } catch (e) { console.error("Load error (gurtzeuge):", e); }
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

  const saveGurtzeuge = useCallback(async (next) => {
    setGurtzeuge(next);
    try { await window.storage.set("service:gurtzeuge", JSON.stringify(next)); } catch (e) { console.error("Save error:", e); }
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

  const updateGurtzeugSlot = (slotId, patch) => {
    const next = { ...gurtzeuge, [slotId]: { ...gurtzeuge[slotId], ...patch } };
    saveGurtzeuge(next);
  };

  const addGurtzeugCheck = (slotId, dateStr) => {
    const slot = gurtzeuge[slotId];
    const checks = [...(slot.checks||[]), { date: dateStr, note: "" }]
      .sort((a,b) => (parseDateStr(b.date)||0) - (parseDateStr(a.date)||0));
    updateGurtzeugSlot(slotId, { checks });
  };

  const updateGurtzeugCheck = (slotId, idx, patch, resort) => {
    const slot = gurtzeuge[slotId];
    let checks = slot.checks.map((c,i) => i===idx ? {...c, ...patch} : c);
    if (resort) checks = checks.sort((a,b) => (parseDateStr(b.date)||0) - (parseDateStr(a.date)||0));
    updateGurtzeugSlot(slotId, { checks });
  };

  const deleteGurtzeugCheck = (slotId, idx) => {
    const slot = gurtzeuge[slotId];
    const checks = slot.checks.filter((_,i) => i!==idx);
    updateGurtzeugSlot(slotId, { checks });
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

  const gurtzeugData = gurtzeuge[activeGurtzeugSlot] || emptySchirmSlot();
  const gurtzeugLastCheck = (gurtzeugData.checks && gurtzeugData.checks.length ? parseDateStr(gurtzeugData.checks[0].date) : null) || parseDateStr(gurtzeugData.purchaseDate);
  const gurtzeugNextDue = gurtzeugLastCheck ? addMonths(gurtzeugLastCheck, gurtzeugData.intervalMonths||12) : null;
  const gurtzeugDueDays = daysUntil(gurtzeugNextDue);
  const gurtzeugOverdue = gurtzeugDueDays !== null && gurtzeugDueDays < 0;
  const gurtzeugSoonDue = gurtzeugDueDays !== null && gurtzeugDueDays >= 0 && gurtzeugDueDays <= 30;

  return (
    <div style={{minHeight:"100vh",background:"#051d0e",color:"#e8f4fd",fontFamily:"-apple-system,BlinkMacSystemFont,sans-serif",paddingBottom:40}}>
      {/* Header */}
      <div style={{background:"rgba(255,255,255,0.03)",borderBottom:"1px solid rgba(255,255,255,0.06)",padding:"calc(28px + env(safe-area-inset-top, 0px)) 16px 12px",display:"flex",alignItems:"center",position:"sticky",top:0,zIndex:10,backdropFilter:"blur(10px)"}}>
        <button onClick={()=>{window.location.href="index.html";}} title="Zur Startseite"
          style={{background:"rgba(255,255,255,0.06)",border:"1px solid rgba(255,255,255,0.1)",borderRadius:10,width:32,height:32,display:"flex",alignItems:"center",justifyContent:"center",fontSize:15,color:"rgba(232,244,253,0.8)",cursor:"pointer",flexShrink:0}}>
          🏠
        </button>
        <span style={{fontWeight:900,fontSize:18,letterSpacing:-0.5,flex:1,textAlign:"center"}}>
          🛠️ Wartung
        </span>
        <button onClick={()=>window.location.href="hilfe.html"} title="Hilfe"
          style={{width:32,height:32,borderRadius:"50%",background:"rgba(255,255,255,0.06)",border:"1px solid rgba(255,255,255,0.12)",color:"#ef4444",fontSize:15,fontWeight:900,display:"flex",alignItems:"center",justifyContent:"center",cursor:"pointer",flexShrink:0}}>
          ?
        </button>
      </div>

      {/* Top badges: Reserve / Schirm */}
      <div style={{padding:"14px 16px 0",display:"flex",gap:10}}>
        <button onClick={()=>setActiveTab("reserve")}
          style={{flex:1,background:activeTab==="reserve"?"rgba(34,197,94,0.18)":"rgba(255,255,255,0.05)",border:`1px solid ${activeTab==="reserve"?"rgba(34,197,94,0.4)":"rgba(255,255,255,0.1)"}`,borderRadius:12,padding:"12px 10px",color:activeTab==="reserve"?"#4ade80":"rgba(232,244,253,0.8)",fontSize:14,fontWeight:700,cursor:"pointer",textAlign:"center"}}>
          🪂 Reserve
        </button>
        <button onClick={()=>setActiveTab("schirm")}
          style={{flex:1,background:activeTab==="schirm"?"rgba(56,189,248,0.18)":"rgba(255,255,255,0.05)",border:`1px solid ${activeTab==="schirm"?"rgba(56,189,248,0.4)":"rgba(255,255,255,0.1)"}`,borderRadius:12,padding:"12px 10px",color:activeTab==="schirm"?"#7dd3fc":"rgba(232,244,253,0.8)",fontSize:14,fontWeight:700,cursor:"pointer",textAlign:"center"}}>
          ⛰️ Schirm
        </button>
        <button onClick={()=>setActiveTab("gurtzeug")}
          style={{flex:1,background:activeTab==="gurtzeug"?"rgba(245,158,11,0.18)":"rgba(255,255,255,0.05)",border:`1px solid ${activeTab==="gurtzeug"?"rgba(245,158,11,0.4)":"rgba(255,255,255,0.1)"}`,borderRadius:12,padding:"12px 10px",color:activeTab==="gurtzeug"?"#f59e0b":"rgba(232,244,253,0.8)",fontSize:14,fontWeight:700,cursor:"pointer",textAlign:"center"}}>
          💺 Sitz
        </button>
      </div>

      {/* Schirm section: 4 tab positions, each with an editable category dropdown */}
      {activeTab==="schirm" && (isWide ? (
        <SlotColumnsView slotIds={SCHIRM_SLOT_IDS} dataMap={schirme} updateSlot={updateSchirmSlot}
          addCheck={addSchirmCheck} updateCheck={updateSchirmCheck} deleteCheck={deleteSchirmCheck}
          editingTab={editingSchirmTab} setEditingTab={setEditingSchirmTab}
          accentColor="#7dd3fc" accentBg="rgba(56,189,248,0.15)" hasZulassung={true}
          defaultTitle={i=>`Schirm ${i+1}`} />
      ) : (
        <div style={{padding:"12px 16px 0"}}>
          {/* Tabs: tap an inactive tab to switch to it; tap the already-
              active tab again to rename it (the only tap that couldn't
              mean "switch", since it's already selected). */}
          <div style={{display:"flex",gap:6,marginBottom:14,background:"rgba(255,255,255,0.03)",borderRadius:12,padding:4}}>
            {SCHIRM_SLOT_IDS.map(slotId => {
              const slot = schirme[slotId] || emptySchirmSlot();
              const displayTitle = slot.title || (slot.category && slot.category!=="–" ? slot.category : "");
              const isActive = activeSchirmSlot===slotId;
              const isEditing = editingSchirmTab===slotId;
              const tabStyle = {
                flex:1,minWidth:0,padding:"9px 4px",borderRadius:9,border:"none",
                fontSize:11.5,fontWeight:700,whiteSpace:"nowrap",overflow:"hidden",textOverflow:"ellipsis",textAlign:"center",
                background: isActive ? "rgba(56,189,248,0.22)" : "transparent",
                color: isActive ? "#7dd3fc" : "rgba(232,244,253,0.5)",
              };
              if (isEditing) {
                return (
                  <input key={slotId} autoFocus value={displayTitle}
                    onChange={e=>updateSchirmSlot(slotId,{title:e.target.value})}
                    onBlur={()=>setEditingSchirmTab(null)}
                    onKeyDown={e=>{ if (e.key==="Enter") e.currentTarget.blur(); }}
                    placeholder={`Schirm ${SCHIRM_SLOT_IDS.indexOf(slotId)+1}`}
                    style={{...tabStyle, cursor:"text", outline:"none"}} />
                );
              }
              return (
                <button key={slotId}
                  onClick={()=> isActive ? setEditingSchirmTab(slotId) : setActiveSchirmSlot(slotId)}
                  style={{...tabStyle, cursor:"pointer"}}>
                  {displayTitle || `Schirm ${SCHIRM_SLOT_IDS.indexOf(slotId)+1}`}
                </button>
              );
            })}
          </div>

          {/* Fields for the currently selected tab */}
          <div style={{background:"rgba(255,255,255,0.04)",border:"1px solid rgba(255,255,255,0.08)",borderRadius:14,padding:16,display:"flex",flexDirection:"column",gap:14}}>
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
                    <input value={normalizeCheckDate(c.date)} onChange={e=>updateSchirmCheck(activeSchirmSlot, idx, {date:e.target.value})}
                      onBlur={e=>updateSchirmCheck(activeSchirmSlot, idx, {date:normalizeCheckDate(e.target.value)})}
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
      ))}

      {/* Gurtzeug/Sitz section: 5 tab positions, identical structure to Schirm */}
      {activeTab==="gurtzeug" && (isWide ? (
        <SlotColumnsView slotIds={GURTZEUG_SLOT_IDS} dataMap={gurtzeuge} updateSlot={updateGurtzeugSlot}
          addCheck={addGurtzeugCheck} updateCheck={updateGurtzeugCheck} deleteCheck={deleteGurtzeugCheck}
          editingTab={editingGurtzeugTab} setEditingTab={setEditingGurtzeugTab}
          accentColor="#f59e0b" accentBg="rgba(245,158,11,0.15)" hasZulassung={true}
          defaultTitle={i=>`Sitz ${i+1}`} />
      ) : (
        <div style={{padding:"12px 16px 0"}}>
          {/* Tabs: tap an inactive tab to switch to it; tap the already-
              active tab again to rename it. */}
          <div style={{display:"flex",gap:6,marginBottom:14,background:"rgba(255,255,255,0.03)",borderRadius:12,padding:4}}>
            {GURTZEUG_SLOT_IDS.map(slotId => {
              const slot = gurtzeuge[slotId] || emptySchirmSlot();
              const displayTitle = slot.title || (slot.category && slot.category!=="–" ? slot.category : "");
              const isActive = activeGurtzeugSlot===slotId;
              const isEditing = editingGurtzeugTab===slotId;
              const tabStyle = {
                flex:1,minWidth:0,padding:"9px 4px",borderRadius:9,border:"none",
                fontSize:11.5,fontWeight:700,whiteSpace:"nowrap",overflow:"hidden",textOverflow:"ellipsis",textAlign:"center",
                background: isActive ? "rgba(245,158,11,0.22)" : "transparent",
                color: isActive ? "#f59e0b" : "rgba(232,244,253,0.5)",
              };
              if (isEditing) {
                return (
                  <input key={slotId} autoFocus value={displayTitle}
                    onChange={e=>updateGurtzeugSlot(slotId,{title:e.target.value})}
                    onBlur={()=>setEditingGurtzeugTab(null)}
                    onKeyDown={e=>{ if (e.key==="Enter") e.currentTarget.blur(); }}
                    placeholder={`Sitz ${GURTZEUG_SLOT_IDS.indexOf(slotId)+1}`}
                    style={{...tabStyle, cursor:"text", outline:"none"}} />
                );
              }
              return (
                <button key={slotId}
                  onClick={()=> isActive ? setEditingGurtzeugTab(slotId) : setActiveGurtzeugSlot(slotId)}
                  style={{...tabStyle, cursor:"pointer"}}>
                  {displayTitle || `Sitz ${GURTZEUG_SLOT_IDS.indexOf(slotId)+1}`}
                </button>
              );
            })}
          </div>

          {/* Fields for the currently selected tab */}
          <div style={{background:"rgba(255,255,255,0.04)",border:"1px solid rgba(255,255,255,0.08)",borderRadius:14,padding:16,display:"flex",flexDirection:"column",gap:14}}>
            {/* Name */}
            <div>
              <div style={{fontSize:11,color:"rgba(232,244,253,0.4)",marginBottom:4,textTransform:"uppercase",letterSpacing:0.5}}>Name</div>
              <input value={gurtzeugData.name} onChange={e=>updateGurtzeugSlot(activeGurtzeugSlot,{name:e.target.value})}
                placeholder="z.B. Woody Valley Wani Light"
                style={{width:"100%",background:"rgba(255,255,255,0.06)",border:"1px solid rgba(255,255,255,0.1)",borderRadius:8,padding:"9px 10px",color:"#e8f4fd",fontSize:14,boxSizing:"border-box"}} />
            </div>

            {/* Serien-Nr. */}
            <div>
              <div style={{fontSize:11,color:"rgba(232,244,253,0.4)",marginBottom:4,textTransform:"uppercase",letterSpacing:0.5}}>Serien-Nr.</div>
              <input value={gurtzeugData.serialNr} onChange={e=>updateGurtzeugSlot(activeGurtzeugSlot,{serialNr:e.target.value})}
                placeholder="z.B. SN-123456"
                style={{width:"100%",background:"rgba(255,255,255,0.06)",border:"1px solid rgba(255,255,255,0.1)",borderRadius:8,padding:"9px 10px",color:"#e8f4fd",fontSize:14,boxSizing:"border-box"}} />
            </div>

            {/* Zulassung */}
            <div>
              <div style={{fontSize:11,color:"rgba(232,244,253,0.4)",marginBottom:4,textTransform:"uppercase",letterSpacing:0.5}}>Zulassung</div>
              <input value={gurtzeugData.zulassung||""} onChange={e=>updateGurtzeugSlot(activeGurtzeugSlot,{zulassung:e.target.value})}
                placeholder="z.B. EN B"
                style={{width:"100%",background:"rgba(255,255,255,0.06)",border:"1px solid rgba(255,255,255,0.1)",borderRadius:8,padding:"9px 10px",color:"#e8f4fd",fontSize:14,boxSizing:"border-box"}} />
            </div>

            {/* Kauf */}
            <div>
              <div style={{fontSize:11,color:"rgba(232,244,253,0.4)",marginBottom:4,textTransform:"uppercase",letterSpacing:0.5}}>Kauf</div>
              <input value={gurtzeugData.purchaseDate} onChange={e=>updateGurtzeugSlot(activeGurtzeugSlot,{purchaseDate:e.target.value})}
                placeholder="TT.MM.JJJJ"
                style={{width:"100%",background:"rgba(255,255,255,0.06)",border:"1px solid rgba(255,255,255,0.1)",borderRadius:8,padding:"9px 10px",color:"#e8f4fd",fontSize:14,boxSizing:"border-box"}} />
            </div>

            {/* Check-Intervall */}
            <div>
              <div style={{fontSize:11,color:"rgba(232,244,253,0.4)",marginBottom:4,textTransform:"uppercase",letterSpacing:0.5}}>Check-Intervall</div>
              <div style={{display:"flex",alignItems:"center",gap:8}}>
                <input type="number" min="1" value={gurtzeugData.intervalMonths}
                  onChange={e=>updateGurtzeugSlot(activeGurtzeugSlot,{intervalMonths: e.target.value})}
                  onBlur={e=>updateGurtzeugSlot(activeGurtzeugSlot,{intervalMonths: Math.max(1, parseInt(e.target.value)||1)})}
                  style={{width:70,background:"rgba(255,255,255,0.06)",border:"1px solid rgba(255,255,255,0.1)",borderRadius:8,padding:"9px 10px",color:"#e8f4fd",fontSize:14,boxSizing:"border-box"}} />
                <span style={{fontSize:13,color:"rgba(232,244,253,0.6)"}}>Monate</span>
              </div>
            </div>

            {/* Checks list */}
            <div>
              <div style={{display:"flex",justifyContent:"space-between",alignItems:"center",marginBottom:6}}>
                <div style={{fontSize:11,color:"rgba(232,244,253,0.4)",textTransform:"uppercase",letterSpacing:0.5}}>Checks</div>
                <span style={{fontSize:12,fontWeight:700,padding:"3px 9px",borderRadius:20,
                  background: gurtzeugOverdue ? "rgba(239,68,68,0.18)" : gurtzeugSoonDue ? "rgba(245,158,11,0.18)" : "rgba(34,197,94,0.12)",
                  color: gurtzeugOverdue ? "#f87171" : gurtzeugSoonDue ? "#fcd34d" : "#4ade80"}}>
                  {gurtzeugOverdue ? "Überfällig" : `Nächster Check ${fmtDate(gurtzeugNextDue)}`}
                </span>
                <button onClick={()=>addGurtzeugCheck(activeGurtzeugSlot, todayStr())}
                  style={{background:"rgba(34,197,94,0.15)",border:"1px solid rgba(34,197,94,0.3)",borderRadius:20,padding:"4px 10px",color:"#4ade80",fontSize:11,fontWeight:700,cursor:"pointer"}}>
                  + Check
                </button>
              </div>
              {(!gurtzeugData.checks || gurtzeugData.checks.length===0) && (
                <div style={{fontSize:12,color:"rgba(232,244,253,0.3)",padding:"8px 0"}}>Noch keine Checks erfasst.</div>
              )}
              <div style={{display:"flex",flexDirection:"column",gap:8}}>
                {(gurtzeugData.checks||[]).map((c, idx) => (
                  <div key={idx} style={{display:"flex",gap:8,alignItems:"center"}}>
                    <input value={c.note} onChange={e=>updateGurtzeugCheck(activeGurtzeugSlot, idx, {note:e.target.value})}
                      placeholder="Text (z.B. Leinencheck)"
                      style={{flex:1,background:"rgba(255,255,255,0.06)",border:"1px solid rgba(255,255,255,0.1)",borderRadius:8,padding:"8px 10px",color:"#e8f4fd",fontSize:13,boxSizing:"border-box"}} />
                    <input value={normalizeCheckDate(c.date)} onChange={e=>updateGurtzeugCheck(activeGurtzeugSlot, idx, {date:e.target.value})}
                      onBlur={e=>updateGurtzeugCheck(activeGurtzeugSlot, idx, {date:normalizeCheckDate(e.target.value)})}
                      placeholder="TT.MM.JJJJ"
                      style={{width:110,background:"rgba(255,255,255,0.06)",border:"1px solid rgba(255,255,255,0.1)",borderRadius:8,padding:"8px 10px",color:"#e8f4fd",fontSize:13,boxSizing:"border-box"}} />
                    <button onClick={()=>deleteGurtzeugCheck(activeGurtzeugSlot, idx)}
                      style={{background:"rgba(239,68,68,0.12)",border:"1px solid rgba(239,68,68,0.25)",borderRadius:8,width:30,height:30,color:"#f87171",fontSize:13,cursor:"pointer",flexShrink:0}}>
                      ✕
                    </button>
                  </div>
                ))}
              </div>
            </div>
          </div>
        </div>
      ))}

      {/* Reserve section: category selector (Auswahl) + fields for the active one */}
      {activeTab==="reserve" && (isWide ? (
        <SlotColumnsView slotIds={RESERVE_SLOTS.map(s=>s.id)} dataMap={reserves} updateSlot={updateSlot}
          addCheck={addCheck} updateCheck={updateCheck} deleteCheck={deleteCheck}
          editingTab={editingReserveTab} setEditingTab={setEditingReserveTab}
          accentColor="#4ade80" accentBg="rgba(34,197,94,0.15)" hasZulassung={false}
          defaultTitle={i=>`Reserve ${i+1}`} />
      ) : (
        <div style={{padding:"12px 16px 0"}}>
          {/* Tabs: tap an inactive tab to switch to it; tap the already-
              active tab again to rename it. */}
          <div style={{display:"flex",gap:6,marginBottom:14,background:"rgba(255,255,255,0.03)",borderRadius:12,padding:4}}>
            {RESERVE_SLOTS.map(slot => {
              const slotData = reserves[slot.id] || emptyReserve();
              const displayTitle = slotData.title || (slotData.category && slotData.category!=="–" ? slotData.category : "");
              const isActive = activeReserveSlot===slot.id;
              const isEditing = editingReserveTab===slot.id;
              const tabStyle = {
                flex:1,minWidth:0,padding:"9px 6px",borderRadius:9,border:"none",
                fontSize:12.5,fontWeight:700,whiteSpace:"nowrap",overflow:"hidden",textOverflow:"ellipsis",textAlign:"center",
                background: isActive ? "rgba(34,197,94,0.22)" : "transparent",
                color: isActive ? "#4ade80" : "rgba(232,244,253,0.5)",
              };
              if (isEditing) {
                return (
                  <input key={slot.id} autoFocus value={displayTitle}
                    onChange={e=>updateSlot(slot.id,{title:e.target.value})}
                    onBlur={()=>setEditingReserveTab(null)}
                    onKeyDown={e=>{ if (e.key==="Enter") e.currentTarget.blur(); }}
                    placeholder={`Reserve ${RESERVE_SLOTS.indexOf(slot)+1}`}
                    style={{...tabStyle, cursor:"text", outline:"none"}} />
                );
              }
              return (
                <button key={slot.id}
                  onClick={()=> isActive ? setEditingReserveTab(slot.id) : setActiveReserveSlot(slot.id)}
                  style={{...tabStyle, cursor:"pointer"}}>
                  {displayTitle || `Reserve ${RESERVE_SLOTS.indexOf(slot)+1}`}
                </button>
              );
            })}
          </div>

          {/* Fields for the currently selected slot */}
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
                    <input value={normalizeCheckDate(c.date)} onChange={e=>updateCheck(activeReserveSlot, idx, {date:e.target.value})}
                      onBlur={e=>updateCheck(activeReserveSlot, idx, {date:normalizeCheckDate(e.target.value)})}
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
      ))}
    </div>
  );
}
