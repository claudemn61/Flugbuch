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
          <div key={slotId} style={{flex:"1 1 0",minWidth:0,background:"rgba(255,255,255,0.04)",border:"1px solid rgba(255,255,255,0.08)",borderRadius:14,padding:14,display:"flex",flexDirection:"column",gap:12}}>
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
    <div>
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

// ── Ausrüstung, Gewichte ─────────────────────────────────────────────────
// Material-Erfassung in 8 festen Kategorien (Bezeichnungen und Gewicht der
// einzelnen Positionen trägt der Pilot selbst ein). Mehrere frei anlegbare
// "Setups" (z.B. Tandem / Solo / H&F leicht) — jedes Setup wählt per
// Checkbox aus, welche Positionen mitgezählt werden, und zeigt sein eigenes
// Gesamtgewicht + optionale Gewichtslimite/-reserve. Nur ein Setup ist
// jeweils sichtbar (Umschalter oben), analog dem Schirm/Reserve/Sitz-
// Umschalter in Wartung.
const GEWICHTE_CATEGORIES = [
  { id: "schirm",         label: "Schirm",         icon: "🪂", color: "#7dd3fc" },
  { id: "sitz",           label: "Sitz",           icon: "💺", color: "#f59e0b" },
  { id: "reserve",        label: "Reserve",        icon: "🛟", color: "#4ade80" },
  { id: "packhilfen",     label: "Packhilfen",     icon: "🎒", color: "#a78bfa" },
  { id: "geraete",        label: "Geräte",         icon: "📟", color: "#2dd4bf" },
  { id: "kleidung",       label: "Kleidung",       icon: "🧥", color: "#f472b6" },
  { id: "zubehoer",       label: "Zubehör",        icon: "🧰", color: "#fde047" },
  { id: "koerpergewicht", label: "Körpergewicht",  icon: "⚖️", color: "#cbd5e1" },
];

function emptyGewichteData() {
  const items = {};
  GEWICHTE_CATEGORIES.forEach(c => { items[c.id] = []; });
  return { items, setups: [] };
}

function parseKg(v) {
  const n = parseFloat(String(v ?? "").replace(",", "."));
  return Number.isFinite(n) ? n : 0;
}

function GewichteApp() {
  const [data, setData] = useState(emptyGewichteData());
  const [loaded, setLoaded] = useState(false);
  const [activeSetupId, setActiveSetupId] = useState(null);
  const [editingSetupId, setEditingSetupId] = useState(null);
  const [confirmDeleteSetup, setConfirmDeleteSetup] = useState(null);
  const [confirmDeleteItem, setConfirmDeleteItem] = useState(null); // { catId, itemId, name }
  // Proj. Fläche / Gewichtslimite (nur bei Schirm-Positionen) sind leer oft
  // uninteressant — bleiben ausgeblendet ("+ Fläche"/"+ Limite"-Link) bis
  // entweder ein Wert existiert oder der Link antippt wurde.
  const [revealedFields, setRevealedFields] = useState(new Set());
  const revealField = (itemId, field) => setRevealedFields(prev => new Set(prev).add(itemId+":"+field));
  const [setupsMoveMode, setSetupsMoveMode] = useState(false);
  // Im Normalzustand zeigt jede Kategorie nur die für das aktive Setup
  // angehakten Positionen (Übersicht) — im Bearbeiten-Modus alle
  // verfügbaren Positionen zum An-/Abhaken und Verwalten.
  const [editMode, setEditMode] = useState(false);

  useEffect(() => {
    (async () => {
      try {
        const r = await window.storage.get("service:gewichte");
        if (r && r.value) {
          const parsed = JSON.parse(r.value);
          const merged = emptyGewichteData();
          GEWICHTE_CATEGORIES.forEach(c => { merged.items[c.id] = Array.isArray(parsed.items?.[c.id]) ? parsed.items[c.id] : []; });
          merged.setups = Array.isArray(parsed.setups) ? parsed.setups : [];
          setData(merged);
          if (merged.setups.length) setActiveSetupId(merged.setups[0].id);
        }
      } catch (e) { console.error("Load error (gewichte):", e); }
      setLoaded(true);
    })();
  }, []);

  const save = useCallback(async (next) => {
    setData(next);
    try { await window.storage.set("service:gewichte", JSON.stringify(next)); } catch (e) { console.error("Save error (gewichte):", e); }
  }, []);

  const addItem = (catId) => {
    const id = "item_" + Date.now() + "_" + Math.random().toString(36).slice(2,7);
    const next = { ...data, items: { ...data.items, [catId]: [...data.items[catId], { id, name: "", weight: "" }] } };
    save(next);
  };
  const updateItem = (catId, itemId, patch) => {
    const next = { ...data, items: { ...data.items, [catId]: data.items[catId].map(it => it.id===itemId ? {...it, ...patch} : it) } };
    save(next);
  };
  const deleteItem = (catId, itemId) => {
    const next = { ...data, items: { ...data.items, [catId]: data.items[catId].filter(it => it.id!==itemId) } };
    // Also drop the item from every setup's selection, so a deleted
    // position can't linger as an invisible weight contributor.
    next.setups = next.setups.map(s => { const sel = {...s.selected}; delete sel[itemId]; return {...s, selected: sel}; });
    save(next);
    setConfirmDeleteItem(null);
  };

  const addSetup = () => {
    const s = { id: "setup_"+Date.now(), name: "Neues Setup", limit: "", selected: {} };
    const next = { ...data, setups: [...data.setups, s] };
    save(next);
    setActiveSetupId(s.id);
    setEditingSetupId(s.id);
  };
  const renameSetup = (id, name) => {
    setData(prev => {
      const next = { ...prev, setups: prev.setups.map(s => s.id===id ? {...s, name} : s) };
      try { window.storage.set("service:gewichte", JSON.stringify(next)); } catch (e) {}
      return next;
    });
  };
  const setSetupLimit = (id, limit) => {
    setData(prev => {
      const next = { ...prev, setups: prev.setups.map(s => s.id===id ? {...s, limit} : s) };
      try { window.storage.set("service:gewichte", JSON.stringify(next)); } catch (e) {}
      return next;
    });
  };
  const toggleItemInSetup = (id, itemId) => {
    const next = { ...data, setups: data.setups.map(s => {
      if (s.id!==id) return s;
      const sel = { ...s.selected };
      if (sel[itemId]) delete sel[itemId]; else sel[itemId] = true;
      return { ...s, selected: sel };
    }) };
    save(next);
  };
  const deleteSetup = (id) => {
    const next = { ...data, setups: data.setups.filter(s => s.id!==id) };
    save(next);
    if (activeSetupId===id) setActiveSetupId(next.setups[0]?.id || null);
    setConfirmDeleteSetup(null);
  };
  const moveSetup = (idx, dir) => {
    const newIdx = idx + dir;
    if (newIdx < 0 || newIdx >= data.setups.length) return;
    const arr = [...data.setups];
    [arr[idx], arr[newIdx]] = [arr[newIdx], arr[idx]];
    save({ ...data, setups: arr });
  };

  const activeSetup = data.setups.find(s => s.id===activeSetupId) || null;

  const totalWeight = activeSetup ? GEWICHTE_CATEGORIES.reduce((sum, cat) =>
    sum + data.items[cat.id].reduce((s,it) => s + (activeSetup.selected[it.id] ? parseKg(it.weight) : 0), 0), 0) : 0;
  const limit = activeSetup && activeSetup.limit !== "" && activeSetup.limit != null ? parseKg(activeSetup.limit) : null;
  const reserve = limit != null ? limit - totalWeight : null;
  // Flächenbelastung = Gesamtgewicht / Proj. Fläche des im Setup
  // ausgewählten Schirms — nur wenn genau ein Schirm angehakt ist und
  // dessen Fläche erfasst wurde, sonst ausgeblendet.
  const checkedSchirme = activeSetup ? data.items.schirm.filter(it => activeSetup.selected[it.id]) : [];
  const schirmArea = checkedSchirme.length === 1 ? parseKg(checkedSchirme[0].area) : 0;
  const flaechenbelastung = (schirmArea > 0 && totalWeight > 0) ? totalWeight / schirmArea : null;

  if (!loaded) return null;

  return (
    <div style={{padding:"14px 16px 40px"}}>
      {/* Setup-Umschalter: tippen auf inaktives Setup wechselt, tippen auf
          bereits aktives öffnet Umbenennen — analog dem Tab-Verhalten in
          Wartung (Schirm/Reserve/Sitz-Slots). */}
      <div style={{display:"flex",gap:8,overflowX:"auto",paddingBottom:4,WebkitOverflowScrolling:"touch"}}>
        {data.setups.map((s, idx) => {
          const isActive = s.id===activeSetupId;
          const isEditing = editingSetupId===s.id;
          if (setupsMoveMode) {
            return (
              <div key={s.id} style={{flexShrink:0,display:"flex",alignItems:"center",gap:2,background:"rgba(255,255,255,0.05)",border:"1px solid rgba(255,255,255,0.1)",borderRadius:20,padding:"4px 4px 4px 12px"}}>
                <span style={{fontSize:13,fontWeight:700,color:"rgba(232,244,253,0.8)",whiteSpace:"nowrap",marginRight:4}}>{s.name || "Setup"}</span>
                <button disabled={idx===0} onClick={()=>moveSetup(idx,-1)}
                  style={{opacity:idx===0?0.3:1,background:"rgba(255,255,255,0.08)",border:"none",borderRadius:14,width:26,height:26,color:"#e8f4fd",cursor:idx===0?"default":"pointer"}}>◀</button>
                <button disabled={idx===data.setups.length-1} onClick={()=>moveSetup(idx,1)}
                  style={{opacity:idx===data.setups.length-1?0.3:1,background:"rgba(255,255,255,0.08)",border:"none",borderRadius:14,width:26,height:26,color:"#e8f4fd",cursor:idx===data.setups.length-1?"default":"pointer"}}>▶</button>
              </div>
            );
          }
          if (isEditing) {
            return (
              <input key={s.id} autoFocus value={s.name}
                onChange={e=>renameSetup(s.id, e.target.value)}
                onBlur={()=>setEditingSetupId(null)}
                onKeyDown={e=>{ if(e.key==="Enter") setEditingSetupId(null); }}
                style={{flexShrink:0,minWidth:110,background:"rgba(255,255,255,0.08)",border:"1px solid rgba(125,211,252,0.4)",borderRadius:20,padding:"9px 14px",color:"#e8f4fd",fontSize:13,fontWeight:700,boxSizing:"border-box"}} />
            );
          }
          return (
            <button key={s.id}
              onClick={()=>{ if (isActive) setEditingSetupId(s.id); else setActiveSetupId(s.id); }}
              style={{flexShrink:0,background:isActive?"rgba(125,211,252,0.18)":"rgba(255,255,255,0.05)",border:`1px solid ${isActive?"rgba(125,211,252,0.4)":"rgba(255,255,255,0.1)"}`,borderRadius:20,padding:"9px 14px",color:isActive?"#7dd3fc":"rgba(232,244,253,0.7)",fontSize:13,fontWeight:700,cursor:"pointer",whiteSpace:"nowrap"}}>
              {s.name || "Setup"}
            </button>
          );
        })}
        <button onClick={addSetup}
          style={{flexShrink:0,background:"rgba(74,222,128,0.15)",border:"1px solid rgba(74,222,128,0.3)",borderRadius:20,padding:"9px 14px",color:"#4ade80",fontSize:13,fontWeight:700,cursor:"pointer",whiteSpace:"nowrap"}}>
          + Setup
        </button>
        {data.setups.length>1 && (
          <button onClick={()=>setSetupsMoveMode(m=>!m)} title="Setups verschieben"
            style={{flexShrink:0,background:setupsMoveMode?"rgba(14,165,233,0.18)":"rgba(255,255,255,0.05)",border:`1px solid ${setupsMoveMode?"rgba(14,165,233,0.4)":"rgba(255,255,255,0.1)"}`,borderRadius:20,padding:"9px 14px",color:setupsMoveMode?"#7dd3fc":"rgba(232,244,253,0.7)",fontSize:13,fontWeight:700,cursor:"pointer",whiteSpace:"nowrap"}}>
            🔀
          </button>
        )}
        {activeSetup && (
          <button onClick={()=>setConfirmDeleteSetup(activeSetup.id)} title="Aktuelles Setup löschen"
            style={{flexShrink:0,background:"rgba(239,68,68,0.12)",border:"1px solid rgba(239,68,68,0.25)",borderRadius:20,width:38,height:38,color:"#f87171",fontSize:14,cursor:"pointer",marginLeft:"auto"}}>
            🗑
          </button>
        )}
      </div>

      {!activeSetup && (
        <div style={{textAlign:"center",padding:"50px 20px",color:"rgba(232,244,253,0.35)"}}>
          <div style={{fontSize:40,marginBottom:10}}>⚖️</div>
          <div style={{fontSize:14}}>Noch kein Setup — "+ Setup" zum Anlegen.</div>
        </div>
      )}

      {activeSetup && (
        <>
          {/* Gewichts-Übersicht für das aktive Setup */}
          <div style={{marginTop:14,background:"rgba(255,255,255,0.04)",border:"1px solid rgba(255,255,255,0.08)",borderRadius:14,padding:"14px 16px",display:"flex",gap:16,alignItems:"center",flexWrap:"wrap"}}>
            <div style={{flex:1,minWidth:120}}>
              <div style={{fontSize:11,color:"rgba(232,244,253,0.4)",textTransform:"uppercase",letterSpacing:0.5}}>Gesamtgewicht</div>
              <div style={{fontSize:24,fontWeight:900,color:"#7dd3fc"}}>{totalWeight.toFixed(1)} kg</div>
            </div>
            <div>
              <div style={{fontSize:11,color:"rgba(232,244,253,0.4)",textTransform:"uppercase",letterSpacing:0.5,marginBottom:2}}>Limite</div>
              <input value={activeSetup.limit ?? ""} onChange={e=>setSetupLimit(activeSetup.id, e.target.value)}
                placeholder="—" inputMode="decimal"
                style={{width:64,background:"rgba(255,255,255,0.06)",border:"1px solid rgba(255,255,255,0.1)",borderRadius:8,padding:"6px 8px",color:"#e8f4fd",fontSize:14,textAlign:"right",boxSizing:"border-box"}} />
            </div>
            {reserve != null && (
              <div>
                <div style={{fontSize:11,color:"rgba(232,244,253,0.4)",textTransform:"uppercase",letterSpacing:0.5,marginBottom:2}}>Reserve</div>
                <div style={{fontSize:16,fontWeight:800,color:reserve>=0?"#4ade80":"#f87171"}}>{reserve>=0?"+":""}{reserve.toFixed(1)} kg</div>
              </div>
            )}
            {flaechenbelastung != null && (
              <div>
                <div style={{fontSize:11,color:"rgba(232,244,253,0.4)",textTransform:"uppercase",letterSpacing:0.5,marginBottom:2}}>Flächenbelastung</div>
                <div style={{fontSize:16,fontWeight:800,color:"#7dd3fc"}}>{flaechenbelastung.toFixed(2)} kg/m²</div>
              </div>
            )}
            <button onClick={()=>setEditMode(m=>!m)} title={editMode ? "Fertig" : "Positionen bearbeiten"}
              style={{flexShrink:0,width:36,height:36,borderRadius:10,fontWeight:700,fontSize:15,cursor:"pointer",background:editMode?"rgba(74,222,128,0.15)":"rgba(125,211,252,0.1)",border:`1px solid ${editMode?"rgba(74,222,128,0.4)":"rgba(125,211,252,0.3)"}`,color:editMode?"#4ade80":"#7dd3fc"}}>
              {editMode ? "✓" : "✏️"}
            </button>
          </div>

          {!editMode && GEWICHTE_CATEGORIES.every(cat => !data.items[cat.id].some(it => activeSetup.selected[it.id])) && (
            <div style={{marginTop:20,textAlign:"center",padding:"20px 10px",color:"rgba(232,244,253,0.35)",fontSize:13}}>
              Noch keine Positionen für "{activeSetup.name}" ausgewählt — ✏️ antippen.
            </div>
          )}

          {/* Kategorien, farblich unterschiedlich hervorgehoben. Im
              Normalzustand nur die für dieses Setup angehakten Positionen
              (Übersicht) — im Bearbeiten-Modus alle verfügbaren zum
              An-/Abhaken. Kategorien ohne angehakte Position bleiben im
              Normalzustand ganz ausgeblendet. */}
          {GEWICHTE_CATEGORIES.map(cat => {
            const allItems = data.items[cat.id];
            const visibleItems = editMode ? allItems : allItems.filter(it => activeSetup.selected[it.id]);
            if (!editMode && visibleItems.length === 0) return null;
            return (
            <div key={cat.id} style={{marginTop:16}}>
              <div style={{display:"flex",alignItems:"center",gap:8,borderLeft:`4px solid ${cat.color}`,paddingLeft:10,marginBottom:6}}>
                <span style={{fontSize:14}}>{cat.icon}</span>
                <span style={{fontSize:13,fontWeight:800,color:cat.color}}>{cat.label}</span>
              </div>
              <div style={{display:"flex",flexDirection:"column",gap:6}}>
                {visibleItems.map(it => {
                  const checked = !!activeSetup.selected[it.id];
                  const isSchirm = cat.id === "schirm";
                  const rowStyle = {background:checked?cat.color+"14":"rgba(255,255,255,0.03)",border:`1px solid ${checked?cat.color+"55":"rgba(255,255,255,0.06)"}`,borderRadius:10,padding:"8px 10px"};
                  const Checkbox = (
                    <div onClick={()=>toggleItemInSetup(activeSetup.id, it.id)}
                      style={{flexShrink:0,width:20,height:20,borderRadius:6,border:`2px solid ${checked?cat.color:"rgba(232,244,253,0.3)"}`,background:checked?cat.color:"transparent",display:"flex",alignItems:"center",justifyContent:"center",cursor:"pointer"}}>
                      {checked && <span style={{color:"#0a1628",fontSize:12,fontWeight:900}}>✓</span>}
                    </div>
                  );
                  const NameInput = (
                    <input value={it.name} onChange={e=>updateItem(cat.id, it.id, {name:e.target.value})}
                      placeholder="Bezeichnung…"
                      style={{flex:1,minWidth:0,background:"transparent",border:"none",color:"#e8f4fd",fontSize:13.5,padding:"4px 0",outline:"none"}} />
                  );
                  const DeleteBtn = (
                    <button onClick={()=>setConfirmDeleteItem({catId:cat.id, itemId:it.id, name: it.name||"diese Position"})}
                      style={{flexShrink:0,background:"rgba(239,68,68,0.1)",border:"1px solid rgba(239,68,68,0.2)",borderRadius:6,width:24,height:24,color:"#f87171",fontSize:11,cursor:"pointer"}}>✕</button>
                  );
                  if (!isSchirm) {
                    return (
                      <div key={it.id} style={{display:"flex",alignItems:"center",gap:8,...rowStyle}}>
                        {Checkbox}
                        {NameInput}
                        <input value={it.weight} onChange={e=>updateItem(cat.id, it.id, {weight:e.target.value})}
                          placeholder="kg" inputMode="decimal"
                          style={{width:56,flexShrink:0,background:"rgba(255,255,255,0.06)",border:"1px solid rgba(255,255,255,0.1)",borderRadius:8,padding:"5px 6px",color:"#e8f4fd",fontSize:13,textAlign:"right",boxSizing:"border-box"}} />
                        {DeleteBtn}
                      </div>
                    );
                  }
                  // Schirm: Gewicht (1.), Proj. Fläche (2.), Gewichtslimite
                  // (3.) — alle drei in einer Zeile, wenn kein Platz
                  // untereinander (flexWrap). Fläche/Limite bleiben leer
                  // ausgeblendet ("+ Fläche"/"+ Limite") bis ein Wert
                  // existiert oder der Link antippt wurde.
                  const fieldDefs = [
                    { key: "area", unit: "m²", placeholder: "+ Fläche" },
                    { key: "weightLimit", unit: "kg-Lim.", placeholder: "+ Limite" },
                  ];
                  return (
                    <div key={it.id} style={{display:"flex",flexDirection:"column",gap:6,...rowStyle}}>
                      <div style={{display:"flex",alignItems:"center",gap:8}}>
                        {Checkbox}
                        {NameInput}
                      </div>
                      <div style={{display:"flex",flexWrap:"wrap",gap:8,paddingLeft:28,alignItems:"center"}}>
                        <input value={it.weight} onChange={e=>updateItem(cat.id, it.id, {weight:e.target.value})}
                          placeholder="kg" inputMode="decimal"
                          style={{width:60,flexShrink:0,background:"rgba(255,255,255,0.06)",border:"1px solid rgba(255,255,255,0.1)",borderRadius:8,padding:"5px 6px",color:"#e8f4fd",fontSize:13,textAlign:"right",boxSizing:"border-box"}} />
                        {fieldDefs.map(fd => {
                          const val = it[fd.key] || "";
                          const show = val !== "" || revealedFields.has(it.id+":"+fd.key);
                          if (!show) {
                            return (
                              <button key={fd.key} onClick={()=>revealField(it.id, fd.key)}
                                style={{flexShrink:0,background:"transparent",border:"1px dashed rgba(255,255,255,0.15)",borderRadius:8,padding:"5px 8px",color:"rgba(232,244,253,0.4)",fontSize:11,cursor:"pointer"}}>
                                {fd.placeholder}
                              </button>
                            );
                          }
                          return (
                            <input key={fd.key} value={val} onChange={e=>updateItem(cat.id, it.id, {[fd.key]:e.target.value})}
                              placeholder={fd.unit} inputMode="decimal"
                              style={{width:68,flexShrink:0,background:"rgba(255,255,255,0.06)",border:"1px solid rgba(255,255,255,0.1)",borderRadius:8,padding:"5px 6px",color:"#e8f4fd",fontSize:13,textAlign:"right",boxSizing:"border-box"}} />
                          );
                        })}
                        <div style={{flex:1}} />
                        {DeleteBtn}
                      </div>
                    </div>
                  );
                })}
                {editMode && (
                  <button onClick={()=>addItem(cat.id)}
                    style={{alignSelf:"flex-start",background:"transparent",border:"1px dashed rgba(255,255,255,0.15)",borderRadius:10,padding:"7px 12px",color:"rgba(232,244,253,0.5)",fontSize:12,cursor:"pointer"}}>
                    + Position
                  </button>
                )}
              </div>
            </div>
            );
          })}
        </>
      )}

      {confirmDeleteSetup && (
        <div onClick={()=>setConfirmDeleteSetup(null)}
          style={{position:"fixed",inset:0,background:"rgba(0,0,0,0.6)",display:"flex",alignItems:"center",justifyContent:"center",zIndex:100,padding:24}}>
          <div onClick={e=>e.stopPropagation()}
            style={{background:"#0d2a17",borderRadius:16,padding:"20px 22px",maxWidth:320,width:"100%",border:"1px solid rgba(255,255,255,0.1)"}}>
            <div style={{fontSize:16,fontWeight:700,marginBottom:6}}>Setup löschen?</div>
            <div style={{fontSize:13,color:"rgba(232,244,253,0.6)",marginBottom:18}}>
              „{data.setups.find(s=>s.id===confirmDeleteSetup)?.name}" wird entfernt. Die Positionen selbst (Schirm, Sitz, …) bleiben erhalten und stehen für andere Setups weiter zur Verfügung.
            </div>
            <div style={{display:"flex",gap:10}}>
              <button onClick={()=>setConfirmDeleteSetup(null)}
                style={{flex:1,background:"rgba(255,255,255,0.08)",border:"1px solid rgba(255,255,255,0.12)",borderRadius:10,padding:"10px",color:"#e8f4fd",fontSize:14,cursor:"pointer"}}>Abbrechen</button>
              <button onClick={()=>deleteSetup(confirmDeleteSetup)}
                style={{flex:1,background:"rgba(239,68,68,0.2)",border:"1px solid rgba(239,68,68,0.4)",borderRadius:10,padding:"10px",color:"#f87171",fontSize:14,fontWeight:700,cursor:"pointer"}}>Löschen</button>
            </div>
          </div>
        </div>
      )}

      {confirmDeleteItem && (
        <div onClick={()=>setConfirmDeleteItem(null)}
          style={{position:"fixed",inset:0,background:"rgba(0,0,0,0.6)",display:"flex",alignItems:"center",justifyContent:"center",zIndex:100,padding:24}}>
          <div onClick={e=>e.stopPropagation()}
            style={{background:"#0d2a17",borderRadius:16,padding:"20px 22px",maxWidth:320,width:"100%",border:"1px solid rgba(255,255,255,0.1)"}}>
            <div style={{fontSize:16,fontWeight:700,marginBottom:6}}>Position löschen?</div>
            <div style={{fontSize:13,color:"rgba(232,244,253,0.6)",marginBottom:18}}>
              „{confirmDeleteItem.name}" wird aus allen Setups entfernt.
            </div>
            <div style={{display:"flex",gap:10}}>
              <button onClick={()=>setConfirmDeleteItem(null)}
                style={{flex:1,background:"rgba(255,255,255,0.08)",border:"1px solid rgba(255,255,255,0.12)",borderRadius:10,padding:"10px",color:"#e8f4fd",fontSize:14,cursor:"pointer"}}>Abbrechen</button>
              <button onClick={()=>deleteItem(confirmDeleteItem.catId, confirmDeleteItem.itemId)}
                style={{flex:1,background:"rgba(239,68,68,0.2)",border:"1px solid rgba(239,68,68,0.4)",borderRadius:10,padding:"10px",color:"#f87171",fontSize:14,fontWeight:700,cursor:"pointer"}}>Löschen</button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}

// ── Top-level shell: Ausrüstung, Gewichte | Wartung ─────────────────────
function AusruestungApp() {
  const [tab, setTab] = useState("gewichte"); // "gewichte" | "wartung"
  return (
    <div style={{minHeight:"100vh",background:"#051d0e",color:"#e8f4fd",fontFamily:"-apple-system,BlinkMacSystemFont,sans-serif",paddingBottom:40}}>
      {/* Header */}
      <div style={{background:"rgba(255,255,255,0.03)",borderBottom:"1px solid rgba(255,255,255,0.06)",padding:"calc(28px + env(safe-area-inset-top, 0px)) 16px 12px",display:"flex",alignItems:"center",position:"sticky",top:0,zIndex:10,backdropFilter:"blur(10px)"}}>
        <button onClick={()=>{window.location.href="index.html";}} title="Zur Startseite"
          style={{background:"rgba(255,255,255,0.06)",border:"1px solid rgba(255,255,255,0.1)",borderRadius:10,width:32,height:32,display:"flex",alignItems:"center",justifyContent:"center",fontSize:15,color:"rgba(232,244,253,0.8)",cursor:"pointer",flexShrink:0}}>
          🏠
        </button>
        <span style={{fontWeight:900,fontSize:18,letterSpacing:-0.5,flex:1,textAlign:"center"}}>
          🎒 Ausrüstung
        </span>
        <button onClick={()=>window.location.href="hilfe.html"} title="Hilfe"
          style={{width:32,height:32,borderRadius:"50%",background:"rgba(255,255,255,0.06)",border:"1px solid rgba(255,255,255,0.12)",color:"#ef4444",fontSize:15,fontWeight:900,display:"flex",alignItems:"center",justifyContent:"center",cursor:"pointer",flexShrink:0}}>
          ?
        </button>
      </div>

      {/* Ausrüstung, Gewichte / Wartung — Design analog Wartungs eigenem
          Reserve/Schirm/Sitz-Umschalter (gleiche Optik, eine Ebene höher). */}
      <div style={{padding:"14px 16px 0",display:"flex",gap:10}}>
        <button onClick={()=>setTab("gewichte")}
          style={{flex:1,background:tab==="gewichte"?"rgba(125,211,252,0.18)":"rgba(255,255,255,0.05)",border:`1px solid ${tab==="gewichte"?"rgba(125,211,252,0.4)":"rgba(255,255,255,0.1)"}`,borderRadius:12,padding:"12px 10px",color:tab==="gewichte"?"#7dd3fc":"rgba(232,244,253,0.8)",fontSize:14,fontWeight:700,cursor:"pointer",textAlign:"center"}}>
          ⚖️ Ausrüstung, Gewichte
        </button>
        <button onClick={()=>setTab("wartung")}
          style={{flex:1,background:tab==="wartung"?"rgba(34,197,94,0.18)":"rgba(255,255,255,0.05)",border:`1px solid ${tab==="wartung"?"rgba(34,197,94,0.4)":"rgba(255,255,255,0.1)"}`,borderRadius:12,padding:"12px 10px",color:tab==="wartung"?"#4ade80":"rgba(232,244,253,0.8)",fontSize:14,fontWeight:700,cursor:"pointer",textAlign:"center"}}>
          🛠️ Wartung
        </button>
      </div>

      {tab==="gewichte" ? <GewichteApp/> : <WartungApp/>}
    </div>
  );
}
