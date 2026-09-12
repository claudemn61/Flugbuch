const { useState, useEffect, useCallback, useRef } = React;

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
// Anzeige-Formatierung für Gewichtsangaben: max. 2 Dezimalstellen, keine
// erzwungenen Nachkomma-Nullen (4.5 bleibt "4.5", 4.55 bleibt "4.55").
// Gibt null zurück wenn kein (gültiger) Wert vorhanden ist.
function fmtNum(v) {
  if (v === "" || v == null) return null;
  const n = parseFloat(String(v).replace(",", "."));
  if (!Number.isFinite(n)) return null;
  return String(Math.round(n * 100) / 100);
}

function GewichteApp({ toolbarOpen, setToolbarOpen }) {
  const isWide = useIsWide();
  const [data, setData] = useState(emptyGewichteData());
  const [loaded, setLoaded] = useState(false);
  const [activeSetupId, setActiveSetupId] = useState(null); // nur für iPhone-Tab-Umschalter relevant
  const [editingSetupId, setEditingSetupId] = useState(null);
  // Verschieben/Löschen sind globale Modi (ein einziger Werkzeugleisten-
  // Block oben, nicht pro Spalte wiederholt). Auf iPad/Mac zeigt jede
  // Spalten-Titelzeile im aktiven Modus zusätzlich ◀▶ bzw. 🗑 für genau
  // diese Spalte; auf dem iPhone wirken sie auf das gerade aktive
  // (Tab-)Setup.
  const [setupsMoveMode, setSetupsMoveMode] = useState(false);
  const [setupsDeleteMode, setSetupsDeleteMode] = useState(false);
  // toolbarOpen/setToolbarOpen kommen als Props von AusruestungApp — ein
  // weiterer Klick auf den bereits aktiven "Ausrüstung, Gewichte"-Tab oben
  // schaltet die Werkzeugleiste auf/zu, nicht hier in der Seite selbst.
  const [confirmDeleteSetup, setConfirmDeleteSetup] = useState(null);
  const [confirmDeleteItem, setConfirmDeleteItem] = useState(null); // { catId, itemId, name }
  // Proj. Fläche / Gewichtslimite (nur bei Schirm-Positionen) sind leer oft
  // uninteressant — bleiben ausgeblendet ("+ Fläche"/"+ Limite"-Link) bis
  // entweder ein Wert existiert oder der Link antippt wurde.
  const [revealedFields, setRevealedFields] = useState(new Set());
  const revealField = (itemId, field) => setRevealedFields(prev => new Set(prev).add(itemId+":"+field));
  // Im Normalzustand zeigt jede Kategorie nur die für das jeweilige Setup
  // angehakten Positionen (Übersicht) — im Bearbeiten-Modus alle
  // verfügbaren Positionen zum An-/Abhaken. Gilt global für alle Spalten.
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
  // Für Biplace-Setups: bei allen Kategorien ausser Schirm und Reserve
  // gibt's typischerweise zwei Personen (Pilot + Passagier), die oft
  // eigene, ähnliche Positionen brauchen (z.B. je eigene Handschuhe). Statt
  // Name+Gewicht komplett neu einzutippen, dupliziert dieser Button die
  // Position direkt (Name mit " 2" markiert, im Setup gleich mit
  // angehakt, das gerade bearbeitet wird) — schneller als jedes Mal
  // "+ Position" von Grund auf.
  const duplicateItem = (catId, item, setupId) => {
    const id = "item_" + Date.now() + "_" + Math.random().toString(36).slice(2,7);
    const baseName = (item.name||"").replace(/\s+2$/, "");
    const copy = { ...item, id, name: baseName ? baseName + " 2" : "" };
    const list = data.items[catId];
    const origIdx = list.findIndex(it => it.id === item.id);
    const newList = [...list];
    newList.splice(origIdx + 1, 0, copy); // direkt unter dem Original einfügen, nicht ans Ende
    const next = { ...data, items: { ...data.items, [catId]: newList } };
    next.setups = next.setups.map(s => s.id===setupId ? { ...s, selected: { ...s.selected, [id]: true } } : s);
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

  if (!loaded) return null;

  const computeSetupStats = (setup) => {
    const totalWeight = GEWICHTE_CATEGORIES.reduce((sum, cat) =>
      sum + data.items[cat.id].reduce((s,it) => s + (setup.selected[it.id] ? parseKg(it.weight) : 0), 0), 0);
    const bodyAndClothingWeight = ["koerpergewicht","kleidung"].reduce((sum, catId) =>
      sum + data.items[catId].reduce((s,it) => s + (setup.selected[it.id] ? parseKg(it.weight) : 0), 0), 0);
    const rucksackgewicht = totalWeight - bodyAndClothingWeight;
    const checkedSchirme = data.items.schirm.filter(it => setup.selected[it.id]);
    // Gewichtslimite ist jetzt ein Range (min/max) statt eines einzelnen
    // Werts. Reserve bleibt weiterhin "Abstand zum Maximum" (wie bisher);
    // zusätzlich zeigt rangePercent, wo das Gesamtgewicht prozentual
    // innerhalb dieses Ranges liegt (0% = Min, 100% = Max, kann auch
    // ausserhalb liegen).
    const schirmLimitMin = checkedSchirme.length === 1 ? parseKg(checkedSchirme[0].weightLimitMin) : 0;
    const schirmLimitMax = checkedSchirme.length === 1 ? parseKg(checkedSchirme[0].weightLimitMax) : 0;
    const reserve = schirmLimitMax > 0 ? schirmLimitMax - totalWeight : null;
    const rangePercent = (schirmLimitMax > schirmLimitMin && schirmLimitMin > 0)
      ? ((totalWeight - schirmLimitMin) / (schirmLimitMax - schirmLimitMin)) * 100
      : null;
    const schirmArea = checkedSchirme.length === 1 ? parseKg(checkedSchirme[0].area) : 0;
    const flaechenbelastung = (schirmArea > 0 && totalWeight > 0) ? totalWeight / schirmArea : null;
    return { totalWeight, rucksackgewicht, reserve, rangePercent, flaechenbelastung };
  };

  // Der eigentliche Karten-Inhalt (Gewichts-Übersicht + Kategorien) ist auf
  // iPad/Mac und iPhone identisch — nur die Titel-/Umschalt-Mechanik
  // darüber unterscheidet sich (Titelzeile pro Spalte vs. Tab-Leiste).
  const renderCardBody = (setup) => {
    const { totalWeight, rucksackgewicht, reserve, rangePercent, flaechenbelastung } = computeSetupStats(setup);
    return (
      <>
        <div style={{background:"rgba(255,255,255,0.04)",border:"1px solid rgba(255,255,255,0.08)",borderRadius:14,padding:"14px 16px",display:"flex",alignItems:"flex-start",gap:14,flexWrap:"wrap"}}>
          <div style={{flex:1,minWidth:0}}>
            <div style={{fontSize:11,color:"rgba(232,244,253,0.4)",textTransform:"uppercase",letterSpacing:0.5}}>Gesamtgewicht</div>
            <div style={{fontSize:24,fontWeight:900,color:"#7dd3fc"}}>{totalWeight.toFixed(1)} kg</div>
            <div style={{fontSize:11,color:"rgba(232,244,253,0.35)",marginTop:1}}>Rucksack {rucksackgewicht.toFixed(1)} kg</div>
          </div>
          {reserve != null && (
            <div>
              <div style={{fontSize:11,color:"rgba(232,244,253,0.4)",textTransform:"uppercase",letterSpacing:0.5,marginBottom:2}}>Reserve</div>
              <div style={{fontSize:16,fontWeight:800,color:reserve>=0?"#4ade80":"#f87171",whiteSpace:"nowrap"}}>{reserve>=0?"+":""}{reserve.toFixed(1)} kg</div>
              {rangePercent != null && (
                <div style={{fontSize:10,color:"rgba(232,244,253,0.35)",marginTop:1}}>{rangePercent>=0?"":""}{rangePercent.toFixed(0)}% der Range</div>
              )}
            </div>
          )}
          {flaechenbelastung != null && (
            <div>
              <div style={{fontSize:11,color:"rgba(232,244,253,0.4)",textTransform:"uppercase",letterSpacing:0.5,marginBottom:2}}>Fläch.-Bel.</div>
              <div style={{fontSize:16,fontWeight:800,color:"#7dd3fc",whiteSpace:"nowrap"}}>{flaechenbelastung.toFixed(2)} kg/m²</div>
            </div>
          )}
        </div>

        {GEWICHTE_CATEGORIES.map(cat => {
          const allItems = data.items[cat.id];
          const visibleItems = editMode ? allItems : allItems.filter(it => setup.selected[it.id]);
          return (
          <div key={cat.id} style={{marginTop:16}}>
            <div style={{display:"flex",alignItems:"center",gap:8,marginBottom:6}}>
              <span style={{fontSize:14}}>{cat.icon}</span>
              <span style={{fontSize:13,fontWeight:800,color:cat.color,flex:1}}>{cat.label}</span>
              {(() => {
                const catWeight = allItems.reduce((s,it) => s + (setup.selected[it.id] ? parseKg(it.weight) : 0), 0);
                return catWeight > 0 ? (
                  <span style={{flexShrink:0,fontSize:12,color:"rgba(232,244,253,0.45)"}}>{fmtNum(catWeight)} kg</span>
                ) : null;
              })()}
              <button onClick={()=>setEditMode(m=>!m)} title={editMode ? "Fertig" : "Positionen bearbeiten"}
                style={{flexShrink:0,width:26,height:26,borderRadius:8,fontSize:12,cursor:"pointer",background:editMode?"rgba(74,222,128,0.15)":"rgba(125,211,252,0.1)",border:`1px solid ${editMode?"rgba(74,222,128,0.4)":"rgba(125,211,252,0.3)"}`,color:editMode?"#4ade80":"#7dd3fc"}}>
                {editMode ? "✓" : "✏️"}
              </button>
            </div>
            <div style={{display:"flex",flexDirection:"column",gap:6}}>
              {!editMode && visibleItems.length===0 && (
                <div style={{fontSize:12,color:"rgba(232,244,253,0.25)",fontStyle:"italic",paddingLeft:2}}>— nichts ausgewählt —</div>
              )}
              {visibleItems.map(it => {
                const checked = !!setup.selected[it.id];
                const isSchirm = cat.id === "schirm";
                const isDuplicable = cat.id !== "schirm" && cat.id !== "reserve";
                const rowStyle = editMode
                  ? {background:checked?cat.color+"14":"rgba(255,255,255,0.03)",border:`1px solid ${checked?cat.color+"55":"rgba(255,255,255,0.06)"}`,borderRadius:10,padding:"8px 10px"}
                  : {background:"transparent",border:"none",borderRadius:10,padding:"4px 0"};
                const Checkbox = (
                  <div onClick={()=>toggleItemInSetup(setup.id, it.id)}
                    style={{flexShrink:0,width:20,height:20,borderRadius:6,border:`2px solid ${checked?cat.color:"rgba(232,244,253,0.3)"}`,background:checked?cat.color:"transparent",display:"flex",alignItems:"center",justifyContent:"center",cursor:"pointer"}}>
                    {checked && <span style={{color:"#0a1628",fontSize:12,fontWeight:900}}>✓</span>}
                  </div>
                );
                const NameInput = (
                  <input value={it.name} onChange={e=>updateItem(cat.id, it.id, {name:e.target.value})}
                    placeholder="Bezeichnung…"
                    style={{flex:1,minWidth:0,background:"transparent",border:"none",color:"#e8f4fd",fontSize:13.5,padding:"4px 0",outline:"none"}} />
                );
                const DuplicateBtn = editMode && isDuplicable && (
                  <button onClick={()=>duplicateItem(cat.id, it, setup.id)} title="Position duplizieren (z.B. für Passagier)"
                    style={{flexShrink:0,background:"rgba(125,211,252,0.1)",border:"1px solid rgba(125,211,252,0.25)",borderRadius:6,width:24,height:24,color:"#7dd3fc",fontSize:12,cursor:"pointer"}}>⎘</button>
                );
                const DeleteBtn = (
                  <button onClick={()=>setConfirmDeleteItem({catId:cat.id, itemId:it.id, name: it.name||"diese Position"})}
                    style={{flexShrink:0,background:"rgba(239,68,68,0.1)",border:"1px solid rgba(239,68,68,0.2)",borderRadius:6,width:24,height:24,color:"#f87171",fontSize:11,cursor:"pointer"}}>✕</button>
                );
                if (!isSchirm) {
                  return (
                    <div key={it.id} style={{display:"flex",alignItems:"center",gap:8,...rowStyle}}>
                      {editMode && Checkbox}
                      {editMode ? NameInput : (
                        <span style={{flex:1,minWidth:0,color:"#e8f4fd",fontSize:13.5,padding:"4px 0"}}>{it.name}</span>
                      )}
                      {editMode ? (
                        <input value={it.weight} onChange={e=>updateItem(cat.id, it.id, {weight:e.target.value})}
                          placeholder="kg" inputMode="decimal"
                          style={{width:56,flexShrink:0,background:"rgba(255,255,255,0.06)",border:"1px solid rgba(255,255,255,0.1)",borderRadius:8,padding:"5px 6px",color:"#e8f4fd",fontSize:13,textAlign:"right",boxSizing:"border-box"}} />
                      ) : (
                        fmtNum(it.weight) != null && (
                          <span style={{flexShrink:0,color:"rgba(232,244,253,0.7)",fontSize:13}}>{fmtNum(it.weight)} kg</span>
                        )
                      )}
                      {editMode && DuplicateBtn}
                      {editMode && DeleteBtn}
                    </div>
                  );
                }
                const fieldDefs = [
                  { key: "area", unit: "m²", placeholder: "+ Fläche" },
                ];
                const limitVal = (it.weightLimitMin||"") + (it.weightLimitMax||"");
                const limitShow = limitVal !== "" || revealedFields.has(it.id+":weightLimit");
                return (
                  <div key={it.id} style={{display:"flex",flexDirection:"column",gap:6,...rowStyle}}>
                    <div style={{display:"flex",alignItems:"center",gap:8}}>
                      {editMode && Checkbox}
                      {editMode ? NameInput : (
                        <span style={{flex:1,minWidth:0,color:"#e8f4fd",fontSize:13.5,padding:"4px 0"}}>{it.name}</span>
                      )}
                    </div>
                    {editMode ? (
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
                        {/* Gewichtslimite als Range (min/max) statt einem
                            einzelnen Wert — beide Felder werden gemeinsam
                            über einen "+ Limite"-Link eingeblendet. */}
                        {!limitShow ? (
                          <button onClick={()=>revealField(it.id, "weightLimit")}
                            style={{flexShrink:0,background:"transparent",border:"1px dashed rgba(255,255,255,0.15)",borderRadius:8,padding:"5px 8px",color:"rgba(232,244,253,0.4)",fontSize:11,cursor:"pointer"}}>
                            + Limite
                          </button>
                        ) : (
                          <div style={{display:"flex",alignItems:"center",gap:4}}>
                            <input value={it.weightLimitMin||""} onChange={e=>updateItem(cat.id, it.id, {weightLimitMin:e.target.value})}
                              placeholder="min" inputMode="decimal"
                              style={{width:52,flexShrink:0,background:"rgba(255,255,255,0.06)",border:"1px solid rgba(255,255,255,0.1)",borderRadius:8,padding:"5px 6px",color:"#e8f4fd",fontSize:13,textAlign:"right",boxSizing:"border-box"}} />
                            <span style={{color:"rgba(232,244,253,0.35)",fontSize:12}}>–</span>
                            <input value={it.weightLimitMax||""} onChange={e=>updateItem(cat.id, it.id, {weightLimitMax:e.target.value})}
                              placeholder="max" inputMode="decimal"
                              style={{width:52,flexShrink:0,background:"rgba(255,255,255,0.06)",border:"1px solid rgba(255,255,255,0.1)",borderRadius:8,padding:"5px 6px",color:"#e8f4fd",fontSize:13,textAlign:"right",boxSizing:"border-box"}} />
                            <span style={{color:"rgba(232,244,253,0.35)",fontSize:11}}>kg-Lim.</span>
                          </div>
                        )}
                        <div style={{flex:1}} />
                        {DeleteBtn}
                      </div>
                    ) : (
                      <div style={{display:"flex",flexWrap:"wrap",gap:14,alignItems:"center"}}>
                        {fmtNum(it.weight) != null && (
                          <span style={{color:"rgba(232,244,253,0.7)",fontSize:13}}>{fmtNum(it.weight)} kg</span>
                        )}
                        {fmtNum(it.area) != null && (
                          <span style={{color:"rgba(232,244,253,0.7)",fontSize:13}}>{fmtNum(it.area)} m²</span>
                        )}
                        {(fmtNum(it.weightLimitMin) != null || fmtNum(it.weightLimitMax) != null) && (
                          <span style={{color:"rgba(232,244,253,0.7)",fontSize:13}}>Lim. {fmtNum(it.weightLimitMin) ?? "?"}–{fmtNum(it.weightLimitMax) ?? "?"} kg</span>
                        )}
                      </div>
                    )}
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
    );
  };

  // ── iPad/Mac: alle Setups nebeneinander, flexibel wie SlotColumnsView
  // (Reserve/Schirm/Sitz) — kein fixes 4er-Limit, jede Spalte teilt sich
  // den verfügbaren Platz, bei Bedarf seitliches Scrollen. ──────────────
  const renderWide = () => (
    <div style={{display:"flex",gap:12,overflowX:"auto",padding:"12px 0 20px"}}>
      {data.setups.map((setup, idx) => {
        const isEditingTitle = editingSetupId === setup.id;
        return (
          <div key={setup.id} style={{flex:"1 1 0",minWidth:280,display:"flex",flexDirection:"column",gap:0}}>
            <div style={{display:"flex",alignItems:"center",gap:6,marginBottom:10}}>
              {isEditingTitle ? (
                <input autoFocus value={setup.name}
                  onChange={e=>renameSetup(setup.id, e.target.value)}
                  onBlur={()=>setEditingSetupId(null)}
                  onKeyDown={e=>{ if(e.key==="Enter") setEditingSetupId(null); }}
                  style={{flex:1,minWidth:0,background:"rgba(255,255,255,0.08)",border:"1px solid rgba(125,211,252,0.4)",borderRadius:8,padding:"6px 10px",color:"#e8f4fd",fontSize:15,fontWeight:800,boxSizing:"border-box"}} />
              ) : (
                <div onClick={()=>setEditingSetupId(setup.id)}
                  style={{flex:1,minWidth:0,fontSize:15,fontWeight:800,color:"#7dd3fc",overflow:"hidden",textOverflow:"ellipsis",whiteSpace:"nowrap",cursor:"pointer"}}>
                  {setup.name || "Setup"}
                </div>
              )}
              {setupsMoveMode && (
                <>
                  <button disabled={idx===0} onClick={()=>moveSetup(idx,-1)}
                    style={{opacity:idx===0?0.3:1,flexShrink:0,background:"rgba(255,255,255,0.08)",border:"1px solid rgba(255,255,255,0.12)",borderRadius:8,width:30,height:30,color:"#e8f4fd",cursor:idx===0?"default":"pointer"}}>◀</button>
                  <button disabled={idx===data.setups.length-1} onClick={()=>moveSetup(idx,1)}
                    style={{opacity:idx===data.setups.length-1?0.3:1,flexShrink:0,background:"rgba(255,255,255,0.08)",border:"1px solid rgba(255,255,255,0.12)",borderRadius:8,width:30,height:30,color:"#e8f4fd",cursor:idx===data.setups.length-1?"default":"pointer"}}>▶</button>
                </>
              )}
              {setupsDeleteMode && (
                <button onClick={()=>setConfirmDeleteSetup(setup.id)} title="Setup löschen"
                  style={{flexShrink:0,background:"rgba(239,68,68,0.1)",border:"1px solid rgba(239,68,68,0.25)",borderRadius:8,width:30,height:30,color:"#f87171",fontSize:13,cursor:"pointer"}}>🗑</button>
              )}
            </div>
            {renderCardBody(setup)}
          </div>
        );
      })}
    </div>
  );

  // ── iPhone: Tab-Umschalter (wie Reserve/Schirm/Sitz), nur das aktive
  // Setup sichtbar. Die Setup-Tabs sind hier die dominante Reihe — die
  // Werkzeugleiste (+Setup/🔀/🗑) steht kleiner darunter, nicht darüber. ──
  const activeSetup = data.setups.find(s => s.id===activeSetupId) || data.setups[0] || null;
  const activeIdx = activeSetup ? data.setups.findIndex(s => s.id===activeSetup.id) : -1;

  const renderNarrowTabs = () => (
    <div style={{display:"flex",gap:6,marginBottom:10,background:"rgba(255,255,255,0.03)",borderRadius:14,padding:5,overflowX:"auto"}}>
      {data.setups.map(s => {
        const isActive = activeSetup && s.id===activeSetup.id;
        const isEditing = editingSetupId===s.id;
        const tabStyle = {
          flex:"1 1 0",minWidth:78,padding:"13px 8px",borderRadius:11,border:"none",
          fontSize:14,fontWeight:800,whiteSpace:"nowrap",overflow:"hidden",textOverflow:"ellipsis",textAlign:"center",
          background: isActive ? "rgba(125,211,252,0.22)" : "transparent",
          color: isActive ? "#7dd3fc" : "rgba(232,244,253,0.5)",
        };
        if (isEditing) {
          return (
            <input key={s.id} autoFocus value={s.name}
              onChange={e=>renameSetup(s.id, e.target.value)}
              onBlur={()=>setEditingSetupId(null)}
              onKeyDown={e=>{ if (e.key==="Enter") e.currentTarget.blur(); }}
              style={{...tabStyle, cursor:"text", outline:"none"}} />
          );
        }
        return (
          <button key={s.id}
            onClick={()=> isActive ? setEditingSetupId(s.id) : setActiveSetupId(s.id)}
            style={{...tabStyle, cursor:"pointer"}}>
            {s.name || "Setup"}
          </button>
        );
      })}
    </div>
  );

  const renderNarrowBody = () => (
    <div>
      {(setupsMoveMode || setupsDeleteMode) && activeSetup && (
        <div style={{display:"flex",gap:8,marginBottom:14}}>
          {setupsMoveMode && (
            <>
              <button disabled={activeIdx===0} onClick={()=>moveSetup(activeIdx,-1)}
                style={{opacity:activeIdx===0?0.3:1,flex:1,background:"rgba(255,255,255,0.08)",border:"1px solid rgba(255,255,255,0.12)",borderRadius:8,padding:"8px",color:"#e8f4fd",cursor:activeIdx===0?"default":"pointer"}}>◀ Nach links</button>
              <button disabled={activeIdx===data.setups.length-1} onClick={()=>moveSetup(activeIdx,1)}
                style={{opacity:activeIdx===data.setups.length-1?0.3:1,flex:1,background:"rgba(255,255,255,0.08)",border:"1px solid rgba(255,255,255,0.12)",borderRadius:8,padding:"8px",color:"#e8f4fd",cursor:activeIdx===data.setups.length-1?"default":"pointer"}}>Nach rechts ▶</button>
            </>
          )}
          {setupsDeleteMode && (
            <button onClick={()=>setConfirmDeleteSetup(activeSetup.id)}
              style={{flex:1,background:"rgba(239,68,68,0.12)",border:"1px solid rgba(239,68,68,0.3)",borderRadius:8,padding:"8px",color:"#f87171",fontWeight:700,cursor:"pointer"}}>🗑 "{activeSetup.name}" löschen</button>
          )}
        </div>
      )}

      {activeSetup ? renderCardBody(activeSetup) : (
        <div style={{textAlign:"center",padding:"50px 20px",color:"rgba(232,244,253,0.35)"}}>
          <div style={{fontSize:40,marginBottom:10}}>⚖️</div>
          <div style={{fontSize:14}}>Noch kein Setup — "+ Setup" oben zum Anlegen.</div>
        </div>
      )}
    </div>
  );

  // Werkzeugleiste + Setup/🔀/🗑 — auf iPad/Mac und im Leerzustand wie
  // bisher die dominante erste Reihe; auf dem iPhone (dominant=false)
  // kleiner und zurückhaltender, weil dort die Setup-Tabs oben Vorrang
  // haben.
  const renderSetupsToolbar = (dominant) => (
    <div style={{display:"flex",gap:dominant?8:6,marginBottom:14}}>
      <button onClick={addSetup} title="Neues Setup"
        style={{flex:isWide?"0 0 70px":1,height:dominant?(isWide?38:48):32,background:"rgba(74,222,128,0.12)",border:"1px solid rgba(74,222,128,0.3)",borderRadius:8,color:"#4ade80",fontSize:dominant?13:12,fontWeight:dominant?700:600,cursor:"pointer"}}>
        + Setup
      </button>
      {data.setups.length>1 && (
        <button onClick={()=>{ setSetupsMoveMode(m=>!m); setSetupsDeleteMode(false); }} title="Setups verschieben"
          style={{flex:isWide?"0 0 70px":1,height:dominant?(isWide?38:48):32,background:setupsMoveMode?"rgba(14,165,233,0.18)":"rgba(14,165,233,0.1)",border:`1px solid ${setupsMoveMode?"rgba(14,165,233,0.5)":"rgba(14,165,233,0.3)"}`,borderRadius:8,color:"#7dd3fc",fontSize:dominant?15:13,cursor:"pointer"}}>
          🔀
        </button>
      )}
      {data.setups.length>0 && (
        <button onClick={()=>{ setSetupsDeleteMode(m=>!m); setSetupsMoveMode(false); }} title="Setups löschen"
          style={{flex:isWide?"0 0 70px":1,height:dominant?(isWide?38:48):32,background:setupsDeleteMode?"rgba(239,68,68,0.18)":"rgba(239,68,68,0.1)",border:`1px solid ${setupsDeleteMode?"rgba(239,68,68,0.5)":"rgba(239,68,68,0.25)"}`,borderRadius:8,color:"#f87171",fontSize:dominant?14:12,cursor:"pointer"}}>
          🗑
        </button>
      )}
    </div>
  );

  // Solange bereits Setups bestehen, ist die Werkzeugleiste nur sichtbar,
  // wenn toolbarOpen eingeschaltet ist (Klick auf den bereits aktiven
  // "Ausrüstung, Gewichte"-Tab oben in AusruestungApp) — im Leerzustand
  // (noch kein Setup) bleibt sie immer offen, da "+ Setup" dort der einzige Weg ist,
  // überhaupt eines anzulegen.
  const renderToolbarSection = (dominant) => (
    (data.setups.length === 0 || toolbarOpen) ? renderSetupsToolbar(dominant) : null
  );

  return (
    <div style={{padding:"14px 16px 40px"}}>
      {data.setups.length === 0 ? (
        <>
          {renderToolbarSection(true)}
          <div style={{textAlign:"center",padding:"50px 20px",color:"rgba(232,244,253,0.35)"}}>
            <div style={{fontSize:40,marginBottom:10}}>⚖️</div>
            <div style={{fontSize:14}}>Noch kein Setup — "+ Setup" oben zum Anlegen.</div>
          </div>
        </>
      ) : isWide ? (
        <>
          {renderToolbarSection(true)}
          {renderWide()}
        </>
      ) : (
        <>
          {/* Setup-Tabs sind hier die dominante Reihe, die Werkzeugleiste
              (+Setup/🔀/🗑) folgt kleiner darunter, auf-/zuklappbar. */}
          {renderNarrowTabs()}
          {renderToolbarSection(false)}
          {renderNarrowBody()}
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

// ── Brevet ───────────────────────────────────────────────────────────────
// Analog zur Tauchbuch-App (gleiche Struktur/Optik übernommen): Fotos von
// Lizenz-/Brevet-Ausweisen erfassen, inkl. perspektivischer Entzerrung
// beim Fotografieren in einem Winkel.

// Verkleinert/komprimiert ein bereits fertiges Canvas (z.B. nach dem
// Zuschnitt) auf dieselbe Weise wie resizeImage() für Dateien.
function canvasToCompressed(canvas, maxDim, quality) {
  maxDim = maxDim || 1600;
  quality = quality || 0.85;
  let w = canvas.width, h = canvas.height;
  if (w > maxDim || h > maxDim) {
    if (w > h) { h = Math.round(h * maxDim / w); w = maxDim; }
    else { w = Math.round(w * maxDim / h); h = maxDim; }
    const small = document.createElement("canvas");
    small.width = w; small.height = h;
    small.getContext("2d").drawImage(canvas, 0, 0, w, h);
    return small.toDataURL("image/jpeg", quality);
  }
  return canvas.toDataURL("image/jpeg", quality);
}

// ── Perspektivische Entzerrung ──────────────────────────────────────────
// Canvas 2D kennt keine echte 4-Punkt- (projektive) Transformation, nur
// affine (Dreiecks-)Transformationen. Deshalb wird die Zielfläche in ein
// feines Gitter unterteilt und jede Gitterzelle einzeln affin entzerrt
// ("Dreiecks-Mesh-Warp") — Standardtechnik für Dokumenten-Scanner-Apps.
function invert3x3(m) {
  const a=m[0][0],b=m[0][1],c=m[0][2], d=m[1][0],e=m[1][1],f=m[1][2], g=m[2][0],h=m[2][1],i=m[2][2];
  const det = a*(e*i-f*h) - b*(d*i-f*g) + c*(d*h-e*g);
  if (Math.abs(det) < 1e-10) return null;
  const id = 1/det;
  return [
    [ (e*i-f*h)*id, (c*h-b*i)*id, (b*f-c*e)*id ],
    [ (f*g-d*i)*id, (a*i-c*g)*id, (c*d-a*f)*id ],
    [ (d*h-e*g)*id, (b*g-a*h)*id, (a*e-b*d)*id ],
  ];
}
function affineFromTriangles(s0,s1,s2,d0,d1,d2) {
  const S = [[s0.x,s1.x,s2.x],[s0.y,s1.y,s2.y],[1,1,1]];
  const inv = invert3x3(S);
  if (!inv) return null;
  const mulRow = (row) => [0,1,2].map(j => row[0]*inv[0][j]+row[1]*inv[1][j]+row[2]*inv[2][j]);
  const [a,c,e] = mulRow([d0.x,d1.x,d2.x]);
  const [b,d,f] = mulRow([d0.y,d1.y,d2.y]);
  return {a,b,c,d,e,f};
}
function drawWarpedTriangle(ctx, img, s0,s1,s2, d0,d1,d2) {
  const t = affineFromTriangles(s0,s1,s2,d0,d1,d2);
  if (!t) return;
  ctx.save();
  ctx.beginPath();
  ctx.moveTo(d0.x,d0.y); ctx.lineTo(d1.x,d1.y); ctx.lineTo(d2.x,d2.y); ctx.closePath();
  ctx.clip();
  ctx.setTransform(t.a,t.b,t.c,t.d,t.e,t.f);
  ctx.drawImage(img, 0, 0);
  ctx.restore();
}
// quad = {tl,tr,br,bl} in Quellbild-Pixelkoordinaten. Liefert ein neues
// Canvas der Grösse outW×outH mit dem entzerrten Bildausschnitt.
function warpQuadToCanvas(img, quad, outW, outH, gridN) {
  gridN = gridN || 20;
  const canvas = document.createElement("canvas");
  canvas.width = Math.round(outW); canvas.height = Math.round(outH);
  const ctx = canvas.getContext("2d");
  const lerp = (a,b,t) => ({ x:a.x+(b.x-a.x)*t, y:a.y+(b.y-a.y)*t });
  const srcAt = (u,v) => lerp(lerp(quad.tl,quad.tr,u), lerp(quad.bl,quad.br,u), v);
  for (let j=0;j<gridN;j++) {
    for (let i=0;i<gridN;i++) {
      const u0=i/gridN, u1=(i+1)/gridN, v0=j/gridN, v1=(j+1)/gridN;
      const dx0=u0*outW, dx1=u1*outW, dy0=v0*outH, dy1=v1*outH;
      const s00=srcAt(u0,v0), s10=srcAt(u1,v0), s01=srcAt(u0,v1), s11=srcAt(u1,v1);
      drawWarpedTriangle(ctx, img, s00,s10,s01, {x:dx0,y:dy0},{x:dx1,y:dy0},{x:dx0,y:dy1});
      drawWarpedTriangle(ctx, img, s10,s11,s01, {x:dx1,y:dy0},{x:dx1,y:dy1},{x:dx0,y:dy1});
    }
  }
  return canvas;
}

// ── Automatische Kantenerkennung ─────────────────────────────────────────
// Die reine Zeilen-/Spalten-Summierung war zu ungenau (Hintergrundtextur
// und Inhalte im Dokument selbst verzerren die Summen). Stattdessen wird
// jetzt der tatsächlich von Kanten umschlossene Bereich gesucht:
// 1. Graustufen + leichte Weichzeichnung (Rauschen reduzieren)
// 2. Sobel-Kantengradient, automatische Schwelle per Otsu-Methode
// 3. Kanten-Maske leicht "aufdicken" (Dilatation), damit kleine Lücken
//    in der Umriss-Linie nicht durchlässig bleiben
// 4. Flutfüllung ausgehend von allen Bildrändern über die Nicht-Kanten-
//    Pixel — alles, was dabei NICHT erreicht wird, liegt innerhalb einer
//    geschlossenen Kontur (= vermutlich das Dokument)
// 5. Grösste zusammenhängende "nicht erreichte" Fläche = Dokument;
//    daraus die 4 Eckpunkte bestimmen
// Schlägt ein Schritt fehl oder liefert ein unplausibles Ergebnis, greift
// automatisch die nächste, einfachere Fallback-Stufe.
function otsuThreshold(values, bins) {
  bins = bins || 256;
  let max = 0;
  for (let i=0;i<values.length;i++) if (values[i]>max) max = values[i];
  if (max <= 0) return 0;
  const hist = new Float64Array(bins);
  for (let i=0;i<values.length;i++) hist[Math.min(bins-1, Math.floor(values[i]/max*(bins-1)))]++;
  const total = values.length;
  let sum = 0; for (let i=0;i<bins;i++) sum += i*hist[i];
  let sumB=0, wB=0, varMax=0, thBin=0;
  for (let i=0;i<bins;i++) {
    wB += hist[i];
    if (wB===0) continue;
    const wF = total - wB;
    if (wF===0) break;
    sumB += i*hist[i];
    const mB = sumB/wB, mF = (sum-sumB)/wF;
    const between = wB*wF*(mB-mF)*(mB-mF);
    if (between > varMax) { varMax = between; thBin = i; }
  }
  return thBin/(bins-1)*max;
}

function detectContentBoundsViaFlood(img) {
  const maxW = 380;
  const scale = Math.min(1, maxW / img.naturalWidth);
  const w = Math.max(2, Math.round(img.naturalWidth * scale));
  const h = Math.max(2, Math.round(img.naturalHeight * scale));
  const canvas = document.createElement("canvas");
  canvas.width = w; canvas.height = h;
  const ctx = canvas.getContext("2d");
  ctx.drawImage(img, 0, 0, w, h);
  const { data } = ctx.getImageData(0, 0, w, h);

  // Graustufen + 3x3 Box-Blur in einem Durchgang (auf Graustufen-Array)
  const gray0 = new Float32Array(w*h);
  for (let i=0;i<w*h;i++) gray0[i] = 0.299*data[i*4] + 0.587*data[i*4+1] + 0.114*data[i*4+2];
  const gray = new Float32Array(w*h);
  for (let y=0;y<h;y++) {
    for (let x=0;x<w;x++) {
      let s=0, n=0;
      for (let dy=-1;dy<=1;dy++) for (let dx=-1;dx<=1;dx++) {
        const xx=x+dx, yy=y+dy;
        if (xx>=0&&xx<w&&yy>=0&&yy<h) { s+=gray0[yy*w+xx]; n++; }
      }
      gray[y*w+x] = s/n;
    }
  }

  const grad = new Float32Array(w*h);
  for (let y=1;y<h-1;y++) {
    for (let x=1;x<w-1;x++) {
      const gx = gray[(y-1)*w+(x+1)] + 2*gray[y*w+(x+1)] + gray[(y+1)*w+(x+1)]
               - gray[(y-1)*w+(x-1)] - 2*gray[y*w+(x-1)] - gray[(y+1)*w+(x-1)];
      const gy = gray[(y+1)*w+(x-1)] + 2*gray[(y+1)*w+x] + gray[(y+1)*w+(x+1)]
               - gray[(y-1)*w+(x-1)] - 2*gray[(y-1)*w+x] - gray[(y-1)*w+(x+1)];
      grad[y*w+x] = Math.sqrt(gx*gx + gy*gy);
    }
  }

  const otsu = otsuThreshold(grad);

  const tryWithThreshold = (thMul) => {
    const th = otsu * thMul;
    const edge = new Uint8Array(w*h);
    for (let i=0;i<w*h;i++) edge[i] = grad[i] >= th ? 1 : 0;
    // Dilatation (1 Iteration, 4-Nachbarschaft) — schliesst kleine Lücken
    const edgeD = new Uint8Array(w*h);
    for (let y=0;y<h;y++) for (let x=0;x<w;x++) {
      let v = edge[y*w+x];
      if (!v) {
        if (x>0 && edge[y*w+x-1]) v=1;
        else if (x<w-1 && edge[y*w+x+1]) v=1;
        else if (y>0 && edge[(y-1)*w+x]) v=1;
        else if (y<h-1 && edge[(y+1)*w+x]) v=1;
      }
      edgeD[y*w+x] = v;
    }

    // Flutfüllung von allen Rändern aus über Nicht-Kanten-Pixel
    const visited = new Uint8Array(w*h);
    const stack = [];
    for (let x=0;x<w;x++) { stack.push(x); stack.push(x+(h-1)*w); }
    for (let y=0;y<h;y++) { stack.push(y*w); stack.push(y*w+(w-1)); }
    while (stack.length) {
      const idx = stack.pop();
      if (idx<0 || idx>=w*h || visited[idx] || edgeD[idx]) continue;
      visited[idx] = 1;
      const x = idx % w, y = (idx / w) | 0;
      if (x>0) stack.push(idx-1);
      if (x<w-1) stack.push(idx+1);
      if (y>0) stack.push(idx-w);
      if (y<h-1) stack.push(idx+w);
    }

    // Grösste zusammenhängende "nicht erreichte" Fläche per einfachem
    // Component-Labeling (BFS) suchen
    const compId = new Int32Array(w*h).fill(-1);
    let bestId = -1, bestSize = 0, bestBox = null;
    let nextId = 0;
    for (let start=0; start<w*h; start++) {
      if (visited[start] || edgeD[start] || compId[start] !== -1) continue;
      const id = nextId++;
      let minX=w, maxX=0, minY=h, maxY=0, size=0;
      const q = [start]; compId[start] = id;
      while (q.length) {
        const idx = q.pop();
        size++;
        const x = idx % w, y = (idx / w) | 0;
        if (x<minX) minX=x; if (x>maxX) maxX=x;
        if (y<minY) minY=y; if (y>maxY) maxY=y;
        const neigh = [idx-1,idx+1,idx-w,idx+w];
        for (const nIdx of neigh) {
          if (nIdx<0 || nIdx>=w*h) continue;
          if (compId[nIdx] !== -1 || visited[nIdx] || edgeD[nIdx]) continue;
          // Zeilenüberlauf bei idx-1/idx+1 an Bildrand vermeiden
          if ((nIdx===idx-1 || nIdx===idx+1) && ((idx%w===0 && nIdx===idx-1) || (idx%w===w-1 && nIdx===idx+1))) continue;
          compId[nIdx] = id;
          q.push(nIdx);
        }
      }
      if (size > bestSize) { bestSize = size; bestId = id; bestBox = {minX,maxX,minY,maxY}; }
    }

    if (bestId === -1) return null;
    const areaFrac = bestSize / (w*h);
    const boxFrac = ((bestBox.maxX-bestBox.minX)*(bestBox.maxY-bestBox.minY)) / (w*h);
    // Plausibilitäts-Check: Fläche darf weder winzig noch (fast) das
    // ganze Bild sein, und die gefundene Fläche soll die Bounding-Box
    // einigermassen ausfüllen (sonst eher Rauschen als ein Dokument).
    if (areaFrac < 0.08 || areaFrac > 0.92 || boxFrac < 0.15 || (bestSize/((bestBox.maxX-bestBox.minX+1)*(bestBox.maxY-bestBox.minY+1))) < 0.35) {
      return null;
    }
    const padX = (bestBox.maxX-bestBox.minX)*0.015, padY = (bestBox.maxY-bestBox.minY)*0.015;
    return {
      x0: Math.max(0, bestBox.minX-padX)/w, y0: Math.max(0, bestBox.minY-padY)/h,
      x1: Math.min(w, bestBox.maxX+padX)/w, y1: Math.min(h, bestBox.maxY+padY)/h,
    };
  };

  return tryWithThreshold(1.0) || tryWithThreshold(0.55);
}

// Einfachere Zeilen-/Spalten-Projektion als zweite Fallback-Stufe, falls
// die Flutfüllung (z.B. bei sehr unruhigem Hintergrund) kein plausibles
// Ergebnis liefert.
function detectContentBoundsViaProjection(img) {
  const maxW = 400;
  const scale = Math.min(1, maxW / img.naturalWidth);
  const w = Math.max(2, Math.round(img.naturalWidth * scale));
  const h = Math.max(2, Math.round(img.naturalHeight * scale));
  const canvas = document.createElement("canvas");
  canvas.width = w; canvas.height = h;
  const ctx = canvas.getContext("2d");
  ctx.drawImage(img, 0, 0, w, h);
  const { data } = ctx.getImageData(0, 0, w, h);
  const gray = new Float32Array(w*h);
  for (let i=0;i<w*h;i++) gray[i] = 0.299*data[i*4] + 0.587*data[i*4+1] + 0.114*data[i*4+2];
  const grad = new Float32Array(w*h);
  for (let y=1;y<h-1;y++) for (let x=1;x<w-1;x++) {
    const gx = gray[(y-1)*w+(x+1)] + 2*gray[y*w+(x+1)] + gray[(y+1)*w+(x+1)]
             - gray[(y-1)*w+(x-1)] - 2*gray[y*w+(x-1)] - gray[(y+1)*w+(x-1)];
    const gy = gray[(y+1)*w+(x-1)] + 2*gray[(y+1)*w+x] + gray[(y+1)*w+(x+1)]
             - gray[(y-1)*w+(x-1)] - 2*gray[(y-1)*w+x] - gray[(y-1)*w+(x+1)];
    grad[y*w+x] = Math.sqrt(gx*gx + gy*gy);
  }
  const rowSum = new Float32Array(h), colSum = new Float32Array(w);
  for (let y=0;y<h;y++) for (let x=0;x<w;x++) { const g=grad[y*w+x]; rowSum[y]+=g; colSum[x]+=g; }
  const findEdge = (arr, fromStart) => {
    const total = arr.reduce((a,b)=>a+b,0);
    if (total <= 0) return null;
    const thresh = total * 0.02;
    let acc = 0;
    if (fromStart) { for (let i=0;i<arr.length;i++){ acc+=arr[i]; if (acc>=thresh) return i; } }
    else { for (let i=arr.length-1;i>=0;i--){ acc+=arr[i]; if (acc>=thresh) return i; } }
    return null;
  };
  const top = findEdge(rowSum, true), bottom = findEdge(rowSum, false);
  const left = findEdge(colSum, true), right = findEdge(colSum, false);
  if (top==null || bottom==null || left==null || right==null || bottom<=top || right<=left ||
      (bottom-top) < h*0.25 || (right-left) < w*0.25) return null;
  const padX = (right-left)*0.02, padY = (bottom-top)*0.02;
  return {
    x0: Math.max(0, left-padX)/w, y0: Math.max(0, top-padY)/h,
    x1: Math.min(w, right+padX)/w, y1: Math.min(h, bottom+padY)/h,
  };
}

function detectContentBounds(img) {
  try {
    return detectContentBoundsViaFlood(img) || detectContentBoundsViaProjection(img) || { x0:0.06, y0:0.06, x1:0.94, y1:0.94 };
  } catch {
    try { return detectContentBoundsViaProjection(img) || { x0:0.06, y0:0.06, x1:0.94, y1:0.94 }; }
    catch { return { x0:0.06, y0:0.06, x1:0.94, y1:0.94 }; }
  }
}

// Startposition der Ecken wird automatisch per Kantenerkennung bestimmt
// (siehe detectContentBounds) — passt sich dem tatsächlichen Foto an,
// unabhängig davon, wie/wo genau fotografiert wurde. Reicht die
// Erkennung nicht, lassen sich alle 4 Ecken frei nachjustieren.
function PerspectiveCropModal({ src, onDone, onCancel }) {
  const imgRef = useRef(null);
  const boxRef = useRef(null);
  const [ready, setReady] = useState(false);
  const [natural, setNatural] = useState({ w: 1, h: 1 });
  const [corners, setCorners] = useState({
    tl: { x: 0.06, y: 0.06 }, tr: { x: 0.94, y: 0.06 },
    br: { x: 0.94, y: 0.94 }, bl: { x: 0.06, y: 0.94 },
  });
  const dragKey = useRef(null);
  const [busy, setBusy] = useState(false);

  const onImgLoad = () => {
    setNatural({ w: imgRef.current.naturalWidth, h: imgRef.current.naturalHeight });
    const b = detectContentBounds(imgRef.current);
    setCorners({
      tl: { x: b.x0, y: b.y0 }, tr: { x: b.x1, y: b.y0 },
      br: { x: b.x1, y: b.y1 }, bl: { x: b.x0, y: b.y1 },
    });
    setReady(true);
  };

  const clamp01 = (v) => Math.max(0, Math.min(1, v));
  const posFromEvent = (e) => {
    const rect = boxRef.current.getBoundingClientRect();
    const pt = e.touches ? e.touches[0] : e;
    return { x: clamp01((pt.clientX - rect.left) / rect.width), y: clamp01((pt.clientY - rect.top) / rect.height) };
  };
  const startDrag = (key) => (e) => { e.preventDefault(); dragKey.current = key; };
  useEffect(() => {
    const move = (e) => {
      if (!dragKey.current) return;
      const p = posFromEvent(e);
      setCorners(c => ({ ...c, [dragKey.current]: p }));
    };
    const up = () => { dragKey.current = null; };
    window.addEventListener("mousemove", move);
    window.addEventListener("touchmove", move, { passive: false });
    window.addEventListener("mouseup", up);
    window.addEventListener("touchend", up);
    return () => {
      window.removeEventListener("mousemove", move);
      window.removeEventListener("touchmove", move);
      window.removeEventListener("mouseup", up);
      window.removeEventListener("touchend", up);
    };
  }, []);

  const applyCrop = () => {
    setBusy(true);
    setTimeout(() => {
      const q = {
        tl: { x: corners.tl.x*natural.w, y: corners.tl.y*natural.h },
        tr: { x: corners.tr.x*natural.w, y: corners.tr.y*natural.h },
        br: { x: corners.br.x*natural.w, y: corners.br.y*natural.h },
        bl: { x: corners.bl.x*natural.w, y: corners.bl.y*natural.h },
      };
      const edgeLen = (a,b) => Math.hypot(b.x-a.x, b.y-a.y);
      const outW = Math.round((edgeLen(q.tl,q.tr) + edgeLen(q.bl,q.br)) / 2);
      const outH = Math.round((edgeLen(q.tl,q.bl) + edgeLen(q.tr,q.br)) / 2);
      const canvas = warpQuadToCanvas(imgRef.current, q, Math.max(outW,50), Math.max(outH,50));
      const dataUrl = canvasToCompressed(canvas, 1600, 0.88);
      setBusy(false);
      onDone(dataUrl);
    }, 30);
  };

  const useWholeImage = () => {
    const canvas = document.createElement("canvas");
    canvas.width = natural.w; canvas.height = natural.h;
    canvas.getContext("2d").drawImage(imgRef.current, 0, 0);
    onDone(canvasToCompressed(canvas, 1600, 0.88));
  };

  const handles = [
    ["tl","Oben links"], ["tr","Oben rechts"], ["br","Unten rechts"], ["bl","Unten links"],
  ];
  const poly = `${corners.tl.x*100},${corners.tl.y*100} ${corners.tr.x*100},${corners.tr.y*100} ${corners.br.x*100},${corners.br.y*100} ${corners.bl.x*100},${corners.bl.y*100}`;

  return (
    <div style={{position:"fixed",inset:0,background:"#000",zIndex:500,display:"flex",flexDirection:"column"}}>
      <div style={{padding:"calc(14px + env(safe-area-inset-top, 0px)) 16px 10px",color:"#fff",fontSize:13,textAlign:"center",background:"rgba(0,0,0,0.6)"}}>
        Automatisch erkannter Ausschnitt — bei Bedarf Ecken nachjustieren
      </div>
      <div style={{flex:1,display:"flex",alignItems:"center",justifyContent:"center",padding:16,overflow:"hidden"}}>
        <div ref={boxRef} style={{position:"relative",maxWidth:"100%",maxHeight:"100%",touchAction:"none"}}>
          <img ref={imgRef} src={src} onLoad={onImgLoad} alt="Zuschnitt-Vorschau"
            style={{display:"block",maxWidth:"100%",maxHeight:"70vh",width:"auto",height:"auto"}} />
          {ready && (
            <svg viewBox="0 0 100 100" preserveAspectRatio="none"
              style={{position:"absolute",inset:0,width:"100%",height:"100%"}}>
              <polygon points={poly} fill="rgba(56,189,248,0.2)" stroke="#38bdf8" strokeWidth="0.6" vectorEffect="non-scaling-stroke" />
            </svg>
          )}
          {ready && handles.map(([key]) => (
            <div key={key}
              onMouseDown={startDrag(key)} onTouchStart={startDrag(key)}
              style={{position:"absolute",left:`${corners[key].x*100}%`,top:`${corners[key].y*100}%`,
                width:28,height:28,marginLeft:-14,marginTop:-14,borderRadius:"50%",
                background:"rgba(56,189,248,0.9)",border:"3px solid #fff",boxShadow:"0 2px 6px rgba(0,0,0,0.4)",
                cursor:"grab",touchAction:"none"}} />
          ))}
        </div>
      </div>
      <div style={{padding:"12px 16px calc(16px + env(safe-area-inset-bottom, 0px))",background:"rgba(0,0,0,0.6)",display:"flex",flexDirection:"column",gap:8}}>
        <div style={{display:"flex",gap:8}}>
          <button onClick={onCancel}
            style={{flex:1,background:"rgba(255,255,255,0.1)",border:"1px solid rgba(255,255,255,0.2)",borderRadius:10,padding:"11px",color:"#fff",fontSize:14,cursor:"pointer"}}>
            Abbrechen
          </button>
          <button onClick={applyCrop} disabled={busy || !ready}
            style={{flex:2,background:"linear-gradient(135deg,#0ea5e9,#0284c7)",color:"#fff",border:"none",borderRadius:10,padding:11,fontSize:14,fontWeight:800,cursor:busy?"default":"pointer",opacity:busy?0.6:1}}>
            {busy ? "⏳ Wird zugeschnitten…" : "✓ Zuschneiden & übernehmen"}
          </button>
        </div>
        <button onClick={useWholeImage}
          style={{background:"none",border:"none",color:"rgba(255,255,255,0.5)",fontSize:12,cursor:"pointer",padding:4}}>
          Ohne Zuschnitt: ganzes Bild übernehmen
        </button>
      </div>
    </div>
  );
}

function BrevetCard({ entry, onUpdate, onDelete, onOpenFullscreen }) {
  const cameraRef = useRef(null);
  const libraryRef = useRef(null);
  const cameraBackRef = useRef(null);
  const libraryBackRef = useRef(null);
  const [nameEditing, setNameEditing] = useState(false);
  const [nameVal, setNameVal] = useState(entry.name || "");
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState("");
  const [cropSrc, setCropSrc] = useState(null); // rohes Bild, wartet auf Zuschnitt
  const [cropSide, setCropSide] = useState("front"); // "front" | "back" — welche Seite gerade zugeschnitten wird

  const commitName = () => { setNameEditing(false); if (nameVal !== (entry.name||"")) onUpdate({...entry, name: nameVal}); };

  // Datei wird zuerst nur eingelesen (nicht sofort verkleinert) und dem
  // Zuschnitt-Dialog übergeben — die eigentliche Verkleinerung/Kompression
  // passiert danach auf dem bereits zugeschnittenen Ausschnitt.
  const onPickFile = (file, side) => {
    if (!file) return;
    setErr("");
    setCropSide(side);
    const reader = new FileReader();
    reader.onload = () => setCropSrc(reader.result);
    reader.onerror = () => setErr("Datei konnte nicht gelesen werden.");
    reader.readAsDataURL(file);
  };

  const onCropDone = (dataUrl) => {
    setCropSrc(null);
    onUpdate({ ...entry, [cropSide === "back" ? "photoBack" : "photo"]: dataUrl });
  };

  return (
    <div style={{background:"rgba(255,255,255,0.04)",border:"1px solid rgba(255,255,255,0.08)",borderRadius:16,overflow:"hidden",marginBottom:16}}>
      <input ref={cameraRef} type="file" accept="image/*" capture="environment" style={{display:"none"}}
        onChange={e=>{ onPickFile(e.target.files[0], "front"); e.target.value=""; }} />
      <input ref={libraryRef} type="file" accept="image/*" style={{display:"none"}}
        onChange={e=>{ onPickFile(e.target.files[0], "front"); e.target.value=""; }} />
      <input ref={cameraBackRef} type="file" accept="image/*" capture="environment" style={{display:"none"}}
        onChange={e=>{ onPickFile(e.target.files[0], "back"); e.target.value=""; }} />
      <input ref={libraryBackRef} type="file" accept="image/*" style={{display:"none"}}
        onChange={e=>{ onPickFile(e.target.files[0], "back"); e.target.value=""; }} />

      {cropSrc && <PerspectiveCropModal src={cropSrc} onDone={onCropDone} onCancel={()=>setCropSrc(null)} />}

      <div style={{padding:"12px 14px",display:"flex",justifyContent:"space-between",alignItems:"center",gap:10}}>
        {nameEditing ? (
          <input value={nameVal} onChange={e=>setNameVal(e.target.value)} onBlur={commitName} autoFocus
            onKeyDown={e=>{if(e.key==="Enter"){e.preventDefault();commitName();}}}
            placeholder="z.B. Passagierflugausweis"
            style={{flex:1,background:"rgba(255,255,255,0.08)",border:"1px solid rgba(167,139,250,0.4)",borderRadius:8,padding:"6px 10px",color:"#e8f4fd",fontSize:15,fontWeight:700,minWidth:0}} />
        ) : (
          <span onClick={()=>{setNameVal(entry.name||"");setNameEditing(true);}}
            style={{flex:1,fontSize:15,fontWeight:700,color:entry.name?"#e8f4fd":"rgba(232,244,253,0.3)",cursor:"pointer",overflow:"hidden",textOverflow:"ellipsis",whiteSpace:"nowrap"}}>
            {entry.name || "Brevet-Name eintragen…"}
          </span>
        )}
        <button onClick={()=>onDelete(entry.id)} style={{background:"none",border:"none",color:"rgba(248,113,113,0.6)",fontSize:16,cursor:"pointer",flexShrink:0}}>🗑</button>
      </div>

      <div onClick={()=>{ if (busy || entry.photo) return; }}
        style={{position:"relative",width:"100%",aspectRatio:"3/2",background:"#0a0714",display:"flex",alignItems:"center",justifyContent:"center"}}>
        {busy ? (
          <div style={{color:"rgba(232,244,253,0.5)",fontSize:12}}>⏳ Foto wird verarbeitet…</div>
        ) : entry.photo ? (
          <>
            <img onClick={()=>onOpenFullscreen(entry.photo)} src={entry.photo} alt="Ausweis" style={{width:"100%",height:"100%",objectFit:"cover",display:"block",cursor:"pointer"}} />
            {entry.photoBack && (
              <div style={{position:"absolute",top:8,left:8,background:"rgba(0,0,0,0.55)",borderRadius:8,padding:"3px 8px",color:"rgba(255,255,255,0.8)",fontSize:11,fontWeight:700}}>Vorderseite</div>
            )}
          </>
        ) : (
          <div style={{textAlign:"center",color:"rgba(232,244,253,0.35)"}}>
            <div style={{fontSize:28,marginBottom:10}}>📷</div>
            <div style={{fontSize:12,marginBottom:12}}>Foto des Ausweises hinzufügen</div>
            <div style={{display:"flex",gap:8,justifyContent:"center"}}>
              <button onClick={()=>cameraRef.current?.click()}
                style={{background:"rgba(167,139,250,0.18)",border:"1px solid rgba(167,139,250,0.4)",borderRadius:10,padding:"8px 12px",color:"#c4b5fd",fontSize:12,fontWeight:700,cursor:"pointer"}}>
                📷 Aufnehmen
              </button>
              <button onClick={()=>libraryRef.current?.click()}
                style={{background:"rgba(255,255,255,0.06)",border:"1px solid rgba(255,255,255,0.15)",borderRadius:10,padding:"8px 12px",color:"rgba(232,244,253,0.7)",fontSize:12,fontWeight:700,cursor:"pointer"}}>
                🖼 Auswählen
              </button>
            </div>
          </div>
        )}
        {entry.photo && !busy && (
          <div style={{position:"absolute",bottom:8,right:8,display:"flex",gap:6}}>
            <button onClick={e=>{e.stopPropagation(); setCropSide("front"); setCropSrc(entry.photo);}} title="Automatisch zuschneiden"
              style={{background:"rgba(0,0,0,0.55)",border:"none",borderRadius:16,padding:"5px 9px",color:"#fff",fontSize:12,cursor:"pointer"}}>
              ✂️
            </button>
            <button onClick={e=>{e.stopPropagation(); cameraRef.current?.click();}} title="Neu aufnehmen"
              style={{background:"rgba(0,0,0,0.55)",border:"none",borderRadius:16,padding:"5px 9px",color:"#fff",fontSize:12,cursor:"pointer"}}>
              📷
            </button>
            <button onClick={e=>{e.stopPropagation(); libraryRef.current?.click();}} title="Aus Fotos wählen"
              style={{background:"rgba(0,0,0,0.55)",border:"none",borderRadius:16,padding:"5px 9px",color:"#fff",fontSize:12,cursor:"pointer"}}>
              🖼
            </button>
          </div>
        )}
      </div>

      {/* Rückseite — optional, unter demselben Titel wie die Vorderseite */}
      <div style={{borderTop:"1px solid rgba(255,255,255,0.06)",position:"relative",width:"100%",aspectRatio:entry.photoBack?"3/2":undefined,background:entry.photoBack?"#0a0714":undefined,display:entry.photoBack?"flex":undefined,alignItems:entry.photoBack?"center":undefined,justifyContent:entry.photoBack?"center":undefined}}>
        {entry.photoBack ? (
          <>
            <img onClick={()=>onOpenFullscreen(entry.photoBack)} src={entry.photoBack} alt="Rückseite" style={{width:"100%",height:"100%",objectFit:"cover",display:"block",cursor:"pointer"}} />
            <div style={{position:"absolute",top:8,left:8,background:"rgba(0,0,0,0.55)",borderRadius:8,padding:"3px 8px",color:"rgba(255,255,255,0.8)",fontSize:11,fontWeight:700}}>Rückseite</div>
            <div style={{position:"absolute",bottom:8,right:8,display:"flex",gap:6}}>
              <button onClick={e=>{e.stopPropagation(); setCropSide("back"); setCropSrc(entry.photoBack);}} title="Automatisch zuschneiden"
                style={{background:"rgba(0,0,0,0.55)",border:"none",borderRadius:16,padding:"5px 9px",color:"#fff",fontSize:12,cursor:"pointer"}}>
                ✂️
              </button>
              <button onClick={e=>{e.stopPropagation(); cameraBackRef.current?.click();}} title="Neu aufnehmen"
                style={{background:"rgba(0,0,0,0.55)",border:"none",borderRadius:16,padding:"5px 9px",color:"#fff",fontSize:12,cursor:"pointer"}}>
                📷
              </button>
              <button onClick={e=>{e.stopPropagation(); libraryBackRef.current?.click();}} title="Aus Fotos wählen"
                style={{background:"rgba(0,0,0,0.55)",border:"none",borderRadius:16,padding:"5px 9px",color:"#fff",fontSize:12,cursor:"pointer"}}>
                🖼
              </button>
              <button onClick={e=>{e.stopPropagation(); onUpdate({...entry, photoBack:null});}} title="Rückseite entfernen"
                style={{background:"rgba(0,0,0,0.55)",border:"none",borderRadius:16,padding:"5px 9px",color:"#fff",fontSize:12,cursor:"pointer"}}>
                🗑
              </button>
            </div>
          </>
        ) : (
          <div style={{padding:"12px 14px",display:"flex",justifyContent:"center",gap:8}}>
            <button onClick={()=>cameraBackRef.current?.click()}
              style={{background:"rgba(167,139,250,0.1)",border:"1px solid rgba(167,139,250,0.3)",borderRadius:10,padding:"7px 12px",color:"#c4b5fd",fontSize:12,fontWeight:700,cursor:"pointer"}}>
              📷 + Rückseite
            </button>
            <button onClick={()=>libraryBackRef.current?.click()}
              style={{background:"rgba(255,255,255,0.04)",border:"1px solid rgba(255,255,255,0.12)",borderRadius:10,padding:"7px 12px",color:"rgba(232,244,253,0.6)",fontSize:12,fontWeight:700,cursor:"pointer"}}>
              🖼 + Rückseite
            </button>
          </div>
        )}
      </div>
      {err && <div style={{padding:"6px 14px 10px",fontSize:11,color:"#f87171"}}>{err}</div>}
    </div>
  );
}

// Kein eigener Seiten-Header (Zurück/Hilfe) — läuft als Tab-Inhalt innerhalb
// von AusruestungApp, die den Header schon stellt. "service:"-Präfix beim
// Storage-Key, damit die Einträge (Name + Foto) vom Backup-Export/Import
// in flugbuch.jsx erfasst werden.
function BrevetApp() {
  const isWide = useIsWide();
  const [entries, setEntries] = useState([]);
  const [loaded, setLoaded] = useState(false);
  const [fullscreenPhoto, setFullscreenPhoto] = useState(null);

  useEffect(() => {
    (async () => {
      try {
        const r = await window.storage.get("service:brevet");
        if (r) setEntries(JSON.parse(r.value) || []);
      } catch (e) { console.error("Load error (brevet):", e); }
      setLoaded(true);
    })();
  }, []);

  const persist = async (next) => {
    setEntries(next);
    try { await window.storage.set("service:brevet", JSON.stringify(next)); } catch (e) { console.error("Save error (brevet):", e); }
  };

  const addEntry = () => {
    const entry = { id: `brevet_${Date.now()}`, name: "", photo: null };
    persist([...entries, entry]);
  };
  const updateEntry = (updated) => persist(entries.map(e => e.id === updated.id ? updated : e));
  const deleteEntry = (id) => persist(entries.filter(e => e.id !== id));

  if (!loaded) return null;

  return (
    <div style={{padding:16,maxWidth:isWide?1000:undefined,margin:isWide?"0 auto":undefined}}>
      {entries.length === 0 && (
        <div style={{textAlign:"center",padding:"30px 16px",color:"rgba(232,244,253,0.4)",fontSize:13}}>
          Noch kein Brevet erfasst. Tippe unten, um eines hinzuzufügen.
        </div>
      )}
      <div style={isWide ? {display:"grid",gridTemplateColumns:"repeat(auto-fill, minmax(260px, 1fr))",gap:16} : undefined}>
        {entries.map(entry => (
          <BrevetCard key={entry.id} entry={entry} onUpdate={updateEntry} onDelete={deleteEntry} onOpenFullscreen={setFullscreenPhoto} />
        ))}
      </div>

      <button onClick={addEntry}
        style={{width:"100%",background:"rgba(167,139,250,0.12)",border:"1px dashed rgba(167,139,250,0.4)",borderRadius:14,padding:"14px",color:"#c4b5fd",fontSize:14,fontWeight:700,cursor:"pointer",marginTop:isWide?16:0}}>
        + Weiteres Brevet hinzufügen
      </button>

      {fullscreenPhoto && (
        <div onClick={()=>setFullscreenPhoto(null)}
          style={{position:"fixed",inset:0,background:"#000",zIndex:400,display:"flex",alignItems:"center",justifyContent:"center"}}>
          <img src={fullscreenPhoto} alt="Ausweis Vollbild" style={{maxWidth:"100%",maxHeight:"100%",objectFit:"contain"}} />
          <button onClick={()=>setFullscreenPhoto(null)}
            style={{position:"absolute",top:"calc(16px + env(safe-area-inset-top, 0px))",right:16,background:"rgba(255,255,255,0.15)",border:"none",borderRadius:20,width:36,height:36,color:"#fff",fontSize:18,cursor:"pointer"}}>
            ✕
          </button>
        </div>
      )}
    </div>
  );
}

// ── Top-level shell: Ausrüstung, Gewichte | Wartung | Brevet ────────────
function AusruestungApp() {
  const [tab, setTab] = useState("gewichte"); // "gewichte" | "wartung" | "brevet"
  // Werkzeugleiste +Setup/🔀/🗑 in Ausrüstung, Gewichte — zugeklappt als
  // Startzustand. Kein eigenes Icon dafür: erster Klick auf den Tab
  // wechselt (wie bei Wartung/Brevet), ein weiterer Klick auf den bereits
  // aktiven Tab schaltet die Werkzeugleiste auf/zu.
  const [gewichteToolbarOpen, setGewichteToolbarOpen] = useState(false);
  return (
    <div style={{minHeight:"100vh",background:"#051d0e",color:"#e8f4fd",fontFamily:"-apple-system,BlinkMacSystemFont,sans-serif",paddingBottom:40}}>
      {/* Header */}
      <div style={{background:"rgba(255,255,255,0.03)",borderBottom:"1px solid rgba(255,255,255,0.06)",padding:"calc(28px + env(safe-area-inset-top, 0px)) 16px 12px",display:"flex",alignItems:"center",position:"sticky",top:0,zIndex:10,backdropFilter:"blur(10px)"}}>
        <button onClick={()=>{try{localStorage.setItem("fb_explicitHome","1");}catch(e){} window.location.href="index.html";}} title="Zur Startseite"
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
        <button onClick={()=> tab==="gewichte" ? setGewichteToolbarOpen(o=>!o) : setTab("gewichte")}
          style={{flex:1,background:tab==="gewichte"?"rgba(125,211,252,0.18)":"rgba(255,255,255,0.05)",border:`1px solid ${tab==="gewichte"?"rgba(125,211,252,0.4)":"rgba(255,255,255,0.1)"}`,borderRadius:12,padding:"12px 10px",color:tab==="gewichte"?"#7dd3fc":"rgba(232,244,253,0.8)",fontSize:14,fontWeight:700,cursor:"pointer",textAlign:"center"}}>
          Ausrüstung, Gewichte
        </button>
        <button onClick={()=>setTab("wartung")}
          style={{flex:1,background:tab==="wartung"?"rgba(34,197,94,0.18)":"rgba(255,255,255,0.05)",border:`1px solid ${tab==="wartung"?"rgba(34,197,94,0.4)":"rgba(255,255,255,0.1)"}`,borderRadius:12,padding:"12px 10px",color:tab==="wartung"?"#4ade80":"rgba(232,244,253,0.8)",fontSize:14,fontWeight:700,cursor:"pointer",textAlign:"center"}}>
          Wartung
        </button>
        <button onClick={()=>setTab("brevet")}
          style={{flex:1,background:tab==="brevet"?"rgba(167,139,250,0.18)":"rgba(255,255,255,0.05)",border:`1px solid ${tab==="brevet"?"rgba(167,139,250,0.4)":"rgba(255,255,255,0.1)"}`,borderRadius:12,padding:"12px 10px",color:tab==="brevet"?"#a78bfa":"rgba(232,244,253,0.8)",fontSize:14,fontWeight:700,cursor:"pointer",textAlign:"center"}}>
          Brevet
        </button>
      </div>

      {tab==="gewichte" ? <GewichteApp toolbarOpen={gewichteToolbarOpen} setToolbarOpen={setGewichteToolbarOpen}/> : tab==="wartung" ? <WartungApp/> : <BrevetApp/>}
    </div>
  );
}
