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
// range actually used.
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
  // Order by the date of each trip's first flight (earliest trip first),
  // matching "in der Reihenfolge des ersten Fluges".
  trips.sort((a,b) => a.firstDate - b.firstDate);
  return trips;
}

function ReisenApp() {
  const [flights, setFlights] = useState([]);
  const [names, setNames] = useState([]);
  const [loaded, setLoaded] = useState(false);
  const [newName, setNewName] = useState("");
  const [openTrip, setOpenTrip] = useState(null);

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
      setLoaded(true);
    })();
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
  };

  if (!loaded) return null;

  const trips = aggregateReisen(flights);
  const maxFlightsInAnyTrip = trips.reduce((m,t) => Math.max(m, t.count), 0);

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

      {/* Manage travel names */}
      <div style={{padding:"14px 16px 0"}}>
        <div style={{display:"flex",gap:8}}>
          <input value={newName} onChange={e=>setNewName(e.target.value)}
            onKeyDown={e=>{ if(e.key==="Enter") addName(); }}
            placeholder="Neue Reise anlegen (z.B. Dolomiten)"
            style={{flex:1,background:"rgba(255,255,255,0.06)",border:"1px solid rgba(255,255,255,0.1)",borderRadius:10,padding:"9px 12px",color:"#e8f4fd",fontSize:14,boxSizing:"border-box"}} />
          <button onClick={addName}
            style={{background:"rgba(245,166,35,0.18)",border:"1px solid rgba(245,166,35,0.4)",borderRadius:10,padding:"9px 16px",color:"#f5a623",fontSize:13,fontWeight:700,cursor:"pointer",whiteSpace:"nowrap"}}>
            + Anlegen
          </button>
        </div>
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
              {/* Header: editable name + running number */}
              <div onClick={()=>setOpenTrip(isOpen?null:trip.name)}
                style={{padding:"14px 16px",display:"flex",justifyContent:"space-between",alignItems:"center",cursor:"pointer"}}>
                <div style={{display:"flex",alignItems:"center",gap:10,flex:1,minWidth:0}}>
                  <span style={{fontSize:12,fontWeight:700,color:"#f5a623",background:"rgba(245,166,35,0.15)",borderRadius:20,width:26,height:26,display:"flex",alignItems:"center",justifyContent:"center",flexShrink:0}}>
                    {trips.length - tripIdx}
                  </span>
                  <input value={trip.name} onClick={e=>e.stopPropagation()}
                    onChange={e=>renameTrip(trip.name, e.target.value)}
                    style={{background:"transparent",border:"none",color:"#e8f4fd",fontSize:15,fontWeight:700,flex:1,minWidth:0,padding:0}} />
                </div>
                <span style={{color:"rgba(232,244,253,0.4)",fontSize:14,flexShrink:0}}>{isOpen?"▾":"▸"}</span>
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
                    <SummaryChip label="Von" value={fmtDateShort(trip.firstDate)} />
                    <SummaryChip label="Bis" value={fmtDateShort(trip.lastDate)} />
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
