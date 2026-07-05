const { useState, useEffect, useCallback } = React;

// ── Reisen Page ──────────────────────────────────────────────────────────
// Aggregates flights tagged with a "Reise" (travel) name — set per-flight in
// the Flugbuch app via a dropdown — into one card per travel, matching the
// spreadsheet layout: editable travel name/number at top, then a per-flight
// column view (position, duration per flight), then summary rows (total
// flights, total flight time, time/flight, flight-number range, from/to
// dates). Travel names themselves are managed here as free text and stored
// under "reisen:names" so the Flugbuch dropdown can offer them.

function parseDateToTs(d) {
  if (!d) return 0;
  const m = String(d).match(/(\d{1,2})\.(\d{1,2})\.(\d{2,4})/);
  if (!m) return 0;
  let [_, dd, mm, yy] = m;
  yy = yy.length === 2 ? (+yy >= 30 ? "19" + yy : "20" + yy) : yy;
  return new Date(+yy, +mm - 1, +dd).getTime();
}

function fmtDateShort(ts) {
  if (!ts) return "—";
  const d = new Date(ts);
  return `${String(d.getDate()).padStart(2,"0")}.${String(d.getMonth()+1).padStart(2,"0")}.${String(d.getFullYear()).slice(2)}`;
}

function fmtHM(sec) {
  const h = Math.floor(sec/3600), m = Math.round((sec%3600)/60);
  return `${h}h ${String(m).padStart(2,"0")}m`;
}

// Groups flights by their assigned Reise name and computes everything the
// card needs to render: per-position flight durations (column = flight #1,
// #2, ... within the trip, sorted by date), totals, and the flight-number
// range actually used. Does NOT decide the display order between trips —
// that's a separate, user-editable order list (see reorderTrips below).
function aggregateReisen(flights) {
  const groups = new Map();
  flights.forEach(f => {
    const name = f.customFields?.reise;
    if (!name) return;
    if (!groups.has(name)) groups.set(name, []);
    groups.get(name).push(f);
  });
  const trips = [...groups.entries()].map(([name, fl]) => {
    const sorted = [...fl].sort((a,b) => parseDateToTs(a.date) - parseDateToTs(b.date));
    const totalSec = sorted.reduce((s,f) => s + (f.durationSec||0), 0);
    const nums = sorted.map(f => parseInt((f.name||"").match(/\d+/)?.[0]||"0",10)).filter(Boolean);
    const first = sorted.length ? parseDateToTs(sorted[0].date) : 0;
    const last = sorted.length ? parseDateToTs(sorted[sorted.length-1].date) : 0;
    return {
      name,
      flights: sorted,
      count: sorted.length,
      totalSec,
      timePerFlight: sorted.length ? Math.round(totalSec/sorted.length) : 0,
      numMin: nums.length ? Math.min(...nums) : null,
      numMax: nums.length ? Math.max(...nums) : null,
      firstDate: first,
      lastDate: last,
    };
  });
  return trips;
}

// Applies a saved manual order (array of trip names) to the aggregated trips,
// appending any trips not yet in the order list (e.g. brand new ones) at the
// end, so nothing is ever silently hidden if the order list is out of sync.
function applyOrder(trips, order) {
  const byName = new Map(trips.map(t => [t.name, t]));
  const ordered = [];
  order.forEach(n => { if (byName.has(n)) { ordered.push(byName.get(n)); byName.delete(n); } });
  byName.forEach(t => ordered.push(t)); // any trips missing from the order list
  return ordered;
}

function ReisenApp() {
  const [flights, setFlights] = useState([]);
  const [names, setNames] = useState([]);
  const [loaded, setLoaded] = useState(false);
  const [order, setOrder] = useState([]);
  const [newName, setNewName] = useState("");
  const [openTrip, setOpenTrip] = useState(null);
  const [showNewInput, setShowNewInput] = useState(false);

  useEffect(() => {
    (async () => {
      try {
        const keys = await window.storage.list("flight:");
        const raw = await Promise.all((keys?.keys||[]).map(async k => {
          try { const r = await window.storage.get(k); return r ? JSON.parse(r.value) : null; } catch { return null; }
        }));
        setFlights(raw.filter(Boolean));
      } catch (e) { console.error("Load error (flights):", e); }
      try {
        const r = await window.storage.get("reisen:names");
        if (r) setNames(JSON.parse(r.value) || []);
      } catch (e) { console.error("Load error (names):", e); }
      try {
        const r2 = await window.storage.get("reisen:order");
        if (r2) setOrder(JSON.parse(r2.value) || []);
      } catch (e) { console.error("Load error (order):", e); }
      setLoaded(true);
    })();
  }, []);

  const saveOrder = useCallback(async (next) => {
    setOrder(next);
    try { await window.storage.set("reisen:order", JSON.stringify(next)); } catch (e) { console.error("Save error:", e); }
  }, []);

  const saveNames = useCallback(async (next) => {
    setNames(next);
    try { await window.storage.set("reisen:names", JSON.stringify(next)); } catch (e) { console.error("Save error:", e); }
  }, []);

  const addName = () => {
    const n = newName.trim();
    if (!n || names.includes(n)) return;
    saveNames([...names, n]);
    setNewName("");
    setShowNewInput(false);
    setOpenTrip(n);
  };

  const renameTrip = async (oldName, newName) => {
    if (!newName.trim() || newName === oldName) return;
    // Rename in the names list...
    saveNames(names.map(n => n === oldName ? newName : n));
    // ...and update every flight tagged with the old name.
    for (const f of flights) {
      if (f.customFields?.reise === oldName) {
        const updated = { ...f, customFields: { ...f.customFields, reise: newName } };
        try { await window.storage.set(`flight:${f.id}`, JSON.stringify(updated)); } catch {}
      }
    }
    setFlights(prev => prev.map(f => f.customFields?.reise === oldName
      ? { ...f, customFields: { ...f.customFields, reise: newName } } : f));
    // Keep the manual order list consistent with the rename too.
    if (order.includes(oldName)) saveOrder(order.map(n => n === oldName ? newName : n));
  };

  if (!loaded) return null;

  const trips = applyOrder(aggregateReisen(flights), order);
  const maxFlightsInAnyTrip = trips.reduce((m,t) => Math.max(m, t.count), 0);

  const moveTrip = (name, direction) => {
    const currentOrder = trips.map(t => t.name);
    const idx = currentOrder.indexOf(name);
    if (idx < 0) return;
    const swapWith = idx + direction;
    if (swapWith < 0 || swapWith >= currentOrder.length) return;
    const next = [...currentOrder];
    [next[idx], next[swapWith]] = [next[swapWith], next[idx]];
    saveOrder(next);
  };

  return (
    <div style={{minHeight:"100vh",background:"#241805",color:"#e8f4fd",fontFamily:"-apple-system,BlinkMacSystemFont,sans-serif",paddingBottom:40}}>
      {/* Header */}
      <div style={{background:"rgba(255,255,255,0.03)",borderBottom:"1px solid rgba(255,255,255,0.06)",padding:"calc(28px + env(safe-area-inset-top, 0px)) 16px 12px",display:"flex",alignItems:"center",position:"sticky",top:0,zIndex:10,backdropFilter:"blur(10px)"}}>
        <button onClick={()=>{window.location.href="index.html";}} title="Zur Startseite"
          style={{background:"rgba(255,255,255,0.06)",border:"1px solid rgba(255,255,255,0.1)",borderRadius:10,width:32,height:32,display:"flex",alignItems:"center",justifyContent:"center",fontSize:15,color:"rgba(232,244,253,0.8)",cursor:"pointer",flexShrink:0}}>
          🏠
        </button>
        <span style={{fontWeight:900,fontSize:18,letterSpacing:-0.5,flex:1,textAlign:"center",marginLeft:-32}}>
          🧭 Reisen
        </span>
      </div>

      {/* Select an existing Reise (opens its card) or create a new one */}
      <div style={{padding:"14px 16px 0"}}>
        <select value="" onChange={e=>{
            const v = e.target.value;
            if (v === "__new__") { setShowNewInput(true); return; }
            if (v) { setOpenTrip(v); setShowNewInput(false); }
          }}
          style={{width:"100%",background:"rgba(255,255,255,0.06)",border:"1px solid rgba(255,255,255,0.1)",borderRadius:10,padding:"9px 12px",color:"#e8f4fd",fontSize:14,boxSizing:"border-box"}}>
          <option value="" style={{background:"#241805"}}>Reise auswählen…</option>
          {names.map(n => <option key={n} value={n} style={{background:"#241805"}}>{n}</option>)}
          <option value="__new__" style={{background:"#241805",color:"#f5a623"}}>+ Neue Reise anlegen…</option>
        </select>
        {showNewInput && (
          <div style={{display:"flex",gap:8,marginTop:8}}>
            <input value={newName} onChange={e=>setNewName(e.target.value)}
              onKeyDown={e=>{ if(e.key==="Enter") addName(); }}
              placeholder="Name der neuen Reise (z.B. Dolomiten)"
              autoFocus
              style={{flex:1,background:"rgba(255,255,255,0.06)",border:"1px solid rgba(245,166,35,0.4)",borderRadius:10,padding:"9px 12px",color:"#e8f4fd",fontSize:14,boxSizing:"border-box"}} />
            <button onClick={addName}
              style={{background:"rgba(245,166,35,0.18)",border:"1px solid rgba(245,166,35,0.4)",borderRadius:10,padding:"9px 16px",color:"#f5a623",fontSize:13,fontWeight:700,cursor:"pointer",whiteSpace:"nowrap"}}>
              + Anlegen
            </button>
          </div>
        )}
      </div>

      {/* Trip cards */}
      <div style={{padding:"14px 16px 0",display:"flex",flexDirection:"column",gap:10}}>
        {trips.length === 0 && (
          <div style={{background:"rgba(255,255,255,0.04)",border:"1px solid rgba(255,255,255,0.08)",borderRadius:12,padding:"20px 16px",textAlign:"center",color:"rgba(232,244,253,0.4)",fontSize:13}}>
            Noch keine Flüge einer Reise zugeordnet. Reise oben anlegen, dann im Flugbuch bei einzelnen Flügen zuweisen.
          </div>
        )}
        {trips.map((trip, tripIdx) => {
          const isOpen = openTrip === trip.name;
          return (
            <div key={trip.name} style={{background:"rgba(255,255,255,0.04)",border:"1px solid rgba(255,255,255,0.08)",borderRadius:14,overflow:"hidden"}}>
              {/* Header: editable name + running number + date range */}
              <div onClick={()=>setOpenTrip(isOpen?null:trip.name)}
                style={{padding:"14px 16px",display:"flex",justifyContent:"space-between",alignItems:"center",cursor:"pointer"}}>
                <div style={{display:"flex",alignItems:"center",gap:10,flex:1,minWidth:0}}>
                  <span style={{fontSize:12,fontWeight:700,color:"#f5a623",background:"rgba(245,166,35,0.15)",borderRadius:20,width:26,height:26,display:"flex",alignItems:"center",justifyContent:"center",flexShrink:0}}>
                    {trips.length - tripIdx}
                  </span>
                  <div style={{flex:1,minWidth:0}}>
                    <input value={trip.name} onClick={e=>e.stopPropagation()}
                      onChange={e=>renameTrip(trip.name, e.target.value)}
                      style={{background:"transparent",border:"none",color:"#e8f4fd",fontSize:15,fontWeight:700,width:"100%",padding:0}} />
                    <div style={{fontSize:11,color:"rgba(232,244,253,0.4)",marginTop:1}}>
                      Von {fmtDateShort(trip.firstDate)} bis {fmtDateShort(trip.lastDate)}
                    </div>
                  </div>
                </div>
                <div style={{display:"flex",alignItems:"center",gap:4,flexShrink:0}}>
                  <button onClick={e=>{e.stopPropagation(); moveTrip(trip.name, -1);}} disabled={tripIdx===0}
                    style={{background:"rgba(255,255,255,0.06)",border:"1px solid rgba(255,255,255,0.1)",borderRadius:8,width:26,height:26,color:tripIdx===0?"rgba(232,244,253,0.2)":"#e8f4fd",fontSize:12,cursor:tripIdx===0?"default":"pointer"}}>
                    ▲
                  </button>
                  <button onClick={e=>{e.stopPropagation(); moveTrip(trip.name, 1);}} disabled={tripIdx===trips.length-1}
                    style={{background:"rgba(255,255,255,0.06)",border:"1px solid rgba(255,255,255,0.1)",borderRadius:8,width:26,height:26,color:tripIdx===trips.length-1?"rgba(232,244,253,0.2)":"#e8f4fd",fontSize:12,cursor:tripIdx===trips.length-1?"default":"pointer"}}>
                    ▼
                  </button>
                  <span style={{color:"rgba(232,244,253,0.4)",fontSize:14,marginLeft:4}}>{isOpen?"▾":"▸"}</span>
                </div>
              </div>

              {isOpen && (
                <div style={{padding:"0 16px 16px"}}>
                  {/* Column view: one row per flight position within the trip */}
                  <div style={{background:"rgba(255,255,255,0.03)",borderRadius:10,padding:"10px 12px",marginBottom:12}}>
                    <div style={{fontSize:10,color:"rgba(232,244,253,0.4)",textTransform:"uppercase",letterSpacing:0.5,marginBottom:8}}>Flüge</div>
                    <div style={{display:"flex",flexDirection:"column",gap:6}}>
                      {trip.flights.map((f, idx) => (
                        <div key={f.id} style={{display:"flex",justifyContent:"space-between",alignItems:"center",fontSize:13}}>
                          <span style={{color:"rgba(232,244,253,0.5)",width:24,flexShrink:0}}>{idx+1}</span>
                          <span style={{color:"rgba(232,244,253,0.6)",flex:1}}>{f.name} · {f.date}</span>
                          <span style={{color:"#f5a623",fontWeight:700}}>{fmtHM(f.durationSec||0)}</span>
                        </div>
                      ))}
                    </div>
                  </div>

                  {/* Summary rows, matching the spreadsheet's bottom section */}
                  <div style={{display:"flex",flexWrap:"wrap",gap:6}}>
                    <SummaryChip label="Flüge" value={trip.count} />
                    <SummaryChip label="Flugzeit" value={fmtHM(trip.totalSec)} />
                    <SummaryChip label="Zeit/Flug" value={fmtHM(trip.timePerFlight)} />
                    <SummaryChip label="Nr." value={trip.numMin && trip.numMax ? `${trip.numMin} – ${trip.numMax}` : "—"} />
                  </div>
                </div>
              )}
            </div>
          );
        })}
      </div>
    </div>
  );
}

function SummaryChip({ label, value }) {
  return (
    <span style={{display:"flex",flexDirection:"column",alignItems:"center",gap:1,background:"rgba(255,255,255,0.04)",border:"1px solid rgba(255,255,255,0.06)",borderRadius:10,padding:"5px 10px",whiteSpace:"nowrap",flexShrink:0}}>
      <span style={{fontSize:9,color:"rgba(232,244,253,0.4)",textTransform:"uppercase",letterSpacing:0.3}}>{label}</span>
      <span style={{fontSize:13,fontWeight:700,color:"rgba(232,244,253,0.9)"}}>{value}</span>
    </span>
  );
}
