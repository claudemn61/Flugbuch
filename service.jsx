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

function todayStr() {
  const d = new Date();
  return `${String(d.getDate()).padStart(2,"0")}.${String(d.getMonth()+1).padStart(2,"0")}.${d.getFullYear()}`;
}

function parseDateStr(s) {
  if (!s) return null;
  const m = String(s).match(/(\d{1,2})\.(\d{1,2})\.(\d{2,4})/);
  if (!m) return null;
  let [_, dd, mm, yy] = m;
  yy = yy.length === 2 ? "20"+yy : yy;
  return new Date(+yy, +mm-1, +dd);
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

function ServiceApp() {
  const [showReserve, setShowReserve] = useState(false);
  const [showSchirm, setShowSchirm] = useState(false);
  const [activeSlot, setActiveSlot] = useState(RESERVE_SLOTS[0].id); // which reserve category is selected
  const [reserves, setReserves] = useState(() => {
    const obj = {};
    RESERVE_SLOTS.forEach(s => obj[s.id] = emptyReserve());
    return obj;
  });
  const [loaded, setLoaded] = useState(false);

  // Load from the same IndexedDB-backed storage the Flugbuch app uses.
  useEffect(() => {
    (async () => {
      try {
        const r = await window.storage.get("service:reserves");
        if (r) {
          const parsed = JSON.parse(r.value);
          setReserves(prev => ({ ...prev, ...parsed }));
        }
      } catch (e) { console.error("Load error:", e); }
      setLoaded(true);
    })();
  }, []);

  const save = useCallback(async (next) => {
    setReserves(next);
    try { await window.storage.set("service:reserves", JSON.stringify(next)); } catch (e) { console.error("Save error:", e); }
  }, []);

  const updateSlot = (slotId, patch) => {
    const next = { ...reserves, [slotId]: { ...reserves[slotId], ...patch } };
    save(next);
  };

  const addCheck = (slotId, dateStr) => {
    const slot = reserves[slotId];
    const checks = [...(slot.checks||[]), { date: dateStr, note: "" }]
      .sort((a,b) => (parseDateStr(b.date)||0) - (parseDateStr(a.date)||0));
    updateSlot(slotId, { checks });
  };

  const updateCheck = (slotId, idx, patch) => {
    const slot = reserves[slotId];
    const checks = slot.checks.map((c,i) => i===idx ? {...c, ...patch} : c);
    updateSlot(slotId, { checks });
  };

  const deleteCheck = (slotId, idx) => {
    const slot = reserves[slotId];
    const checks = slot.checks.filter((_,i) => i!==idx);
    updateSlot(slotId, { checks });
  };

  if (!loaded) return null;

  const data = reserves[activeSlot] || emptyReserve();
  const lastCheck = data.checks && data.checks.length ? parseDateStr(data.checks[0].date) : null;
  const nextDue = lastCheck ? addMonths(lastCheck, data.intervalMonths||12) : null;
  const dueDays = daysUntil(nextDue);
  const overdue = dueDays !== null && dueDays < 0;
  const soonDue = dueDays !== null && dueDays >= 0 && dueDays <= 30;

  return (
    <div style={{minHeight:"100vh",background:"#0d1b2a",color:"#e8f4fd",fontFamily:"-apple-system,BlinkMacSystemFont,sans-serif",paddingBottom:40}}>
      {/* Header */}
      <div style={{background:"rgba(255,255,255,0.03)",borderBottom:"1px solid rgba(255,255,255,0.06)",padding:"calc(28px + env(safe-area-inset-top, 0px)) 16px 12px",display:"flex",alignItems:"center",position:"sticky",top:0,zIndex:10,backdropFilter:"blur(10px)"}}>
        <button onClick={()=>{window.location.href="index.html";}} title="Zur Startseite"
          style={{background:"rgba(255,255,255,0.06)",border:"1px solid rgba(255,255,255,0.1)",borderRadius:10,width:32,height:32,display:"flex",alignItems:"center",justifyContent:"center",fontSize:15,color:"rgba(232,244,253,0.8)",cursor:"pointer",flexShrink:0}}>
          🏠
        </button>
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

      {/* Schirm placeholder */}
      {showSchirm && (
        <div style={{margin:"12px 16px 0",background:"rgba(255,255,255,0.04)",border:"1px solid rgba(255,255,255,0.08)",borderRadius:12,padding:"20px 16px",textAlign:"center",color:"rgba(232,244,253,0.4)",fontSize:13}}>
          Kommt später.
        </div>
      )}

      {/* Reserve section: category selector (Auswahl) + fields for the active one */}
      {showReserve && (
        <div style={{padding:"12px 16px 0"}}>
          {/* Auswahl: tab-style selector between the 3 categories */}
          <div style={{display:"flex",gap:6,marginBottom:14,background:"rgba(255,255,255,0.03)",borderRadius:12,padding:4}}>
            {RESERVE_SLOTS.map(slot => (
              <button key={slot.id} onClick={()=>setActiveSlot(slot.id)}
                style={{
                  flex:1,padding:"9px 6px",borderRadius:9,border:"none",cursor:"pointer",
                  fontSize:12.5,fontWeight:700,whiteSpace:"nowrap",
                  background: activeSlot===slot.id ? "rgba(34,197,94,0.22)" : "transparent",
                  color: activeSlot===slot.id ? "#4ade80" : "rgba(232,244,253,0.5)",
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
              <input value={data.name} onChange={e=>updateSlot(activeSlot,{name:e.target.value})}
                placeholder="z.B. Companion Light 3"
                style={{width:"100%",background:"rgba(255,255,255,0.06)",border:"1px solid rgba(255,255,255,0.1)",borderRadius:8,padding:"9px 10px",color:"#e8f4fd",fontSize:14,boxSizing:"border-box"}} />
            </div>

            {/* Serien-Nr. */}
            <div>
              <div style={{fontSize:11,color:"rgba(232,244,253,0.4)",marginBottom:4,textTransform:"uppercase",letterSpacing:0.5}}>Serien-Nr.</div>
              <input value={data.serialNr} onChange={e=>updateSlot(activeSlot,{serialNr:e.target.value})}
                placeholder="z.B. SN-123456"
                style={{width:"100%",background:"rgba(255,255,255,0.06)",border:"1px solid rgba(255,255,255,0.1)",borderRadius:8,padding:"9px 10px",color:"#e8f4fd",fontSize:14,boxSizing:"border-box"}} />
            </div>

            {/* Kauf */}
            <div>
              <div style={{fontSize:11,color:"rgba(232,244,253,0.4)",marginBottom:4,textTransform:"uppercase",letterSpacing:0.5}}>Kauf</div>
              <div style={{display:"flex",gap:8}}>
                <input value={data.purchaseDate} onChange={e=>updateSlot(activeSlot,{purchaseDate:e.target.value})}
                  placeholder="TT.MM.JJJJ"
                  style={{flex:1,background:"rgba(255,255,255,0.06)",border:"1px solid rgba(255,255,255,0.1)",borderRadius:8,padding:"9px 10px",color:"#e8f4fd",fontSize:14,boxSizing:"border-box"}} />
                <button onClick={()=>updateSlot(activeSlot,{purchaseDate:todayStr()})}
                  style={{background:"rgba(125,211,252,0.12)",border:"1px solid rgba(125,211,252,0.25)",borderRadius:8,padding:"0 12px",color:"#7dd3fc",fontSize:12,fontWeight:600,cursor:"pointer",whiteSpace:"nowrap"}}>
                  heute
                </button>
              </div>
            </div>

            {/* Check-Intervall */}
            <div>
              <div style={{fontSize:11,color:"rgba(232,244,253,0.4)",marginBottom:4,textTransform:"uppercase",letterSpacing:0.5}}>Check-Intervall</div>
              <div style={{display:"flex",alignItems:"center",gap:8}}>
                <input type="number" min="1" value={data.intervalMonths}
                  onChange={e=>updateSlot(activeSlot,{intervalMonths: Math.max(1, parseInt(e.target.value)||1)})}
                  style={{width:70,background:"rgba(255,255,255,0.06)",border:"1px solid rgba(255,255,255,0.1)",borderRadius:8,padding:"9px 10px",color:"#e8f4fd",fontSize:14,boxSizing:"border-box"}} />
                <span style={{fontSize:13,color:"rgba(232,244,253,0.6)"}}>Monate</span>
                {nextDue && (
                  <span style={{fontSize:12,marginLeft:"auto",fontWeight:700,padding:"3px 9px",borderRadius:20,
                    background: overdue ? "rgba(239,68,68,0.18)" : soonDue ? "rgba(245,158,11,0.18)" : "rgba(34,197,94,0.12)",
                    color: overdue ? "#f87171" : soonDue ? "#fcd34d" : "#4ade80"}}>
                    {overdue ? "Überfällig" : `Nächster Check: ${fmtDate(nextDue)}`}
                  </span>
                )}
              </div>
            </div>

            {/* Checks list */}
            <div>
              <div style={{display:"flex",justifyContent:"space-between",alignItems:"center",marginBottom:6}}>
                <div style={{fontSize:11,color:"rgba(232,244,253,0.4)",textTransform:"uppercase",letterSpacing:0.5}}>Checks</div>
                <button onClick={()=>addCheck(activeSlot, todayStr())}
                  style={{background:"rgba(34,197,94,0.15)",border:"1px solid rgba(34,197,94,0.3)",borderRadius:20,padding:"4px 10px",color:"#4ade80",fontSize:11,fontWeight:700,cursor:"pointer"}}>
                  + heute
                </button>
              </div>
              {(!data.checks || data.checks.length===0) && (
                <div style={{fontSize:12,color:"rgba(232,244,253,0.3)",padding:"8px 0"}}>Noch keine Checks erfasst.</div>
              )}
              <div style={{display:"flex",flexDirection:"column",gap:8}}>
                {(data.checks||[]).map((c, idx) => (
                  <div key={idx} style={{display:"flex",gap:8,alignItems:"center"}}>
                    <input value={c.note} onChange={e=>updateCheck(activeSlot, idx, {note:e.target.value})}
                      placeholder="Text (z.B. Leinencheck)"
                      style={{flex:1,background:"rgba(255,255,255,0.06)",border:"1px solid rgba(255,255,255,0.1)",borderRadius:8,padding:"8px 10px",color:"#e8f4fd",fontSize:13,boxSizing:"border-box"}} />
                    <input value={c.date} onChange={e=>updateCheck(activeSlot, idx, {date:e.target.value})}
                      placeholder="TT.MM.JJJJ"
                      style={{width:110,background:"rgba(255,255,255,0.06)",border:"1px solid rgba(255,255,255,0.1)",borderRadius:8,padding:"8px 10px",color:"#e8f4fd",fontSize:13,boxSizing:"border-box"}} />
                    <button onClick={()=>deleteCheck(activeSlot, idx)}
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
