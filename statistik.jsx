const { useState, useEffect } = React;

// ── Statistik Page ───────────────────────────────────────────────────────
// Four aggregated views built from the same flight data the Flugbuch app
// stores: Schirm (glider), Passagiere, Landeplätze, Startplätze. Shown as
// four collapsible badges (same pattern as the Service page). On narrow
// screens each row renders as a stacked card instead of a wide table, since
// the source tables have too many columns to fit comfortably.

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
  return `${d.getDate()}.${d.getMonth()+1}.${String(d.getFullYear()).slice(2)}`;
}

function fmtHours(sec) {
  const h = Math.floor(sec/3600), m = Math.round((sec%3600)/60);
  return `${h}h ${String(m).padStart(2,"0")}m`;
}

function fmtHM(sec) {
  const h = Math.floor(sec/3600), m = Math.round((sec%3600)/60);
  return `${h}h${String(m).padStart(2,"0")}m`;
}

// Builds the aggregation for a "grouping" stat: groups flights by a key
// function, computing count / total duration / max duration / total
// distance / first+last flight date, sorted by flight count descending.
function aggregate(flights, keyFn) {
  const groups = new Map();
  flights.forEach(f => {
    const key = keyFn(f);
    if (!key) return;
    if (!groups.has(key)) groups.set(key, { key, flights: [] });
    groups.get(key).flights.push(f);
  });
  const rows = [...groups.values()].map(g => {
    const fl = g.flights;
    const totalSec = fl.reduce((s,f) => s + (f.durationSec||0), 0);
    const maxSec = fl.reduce((m,f) => Math.max(m, f.durationSec||0), 0);
    const totalDist = fl.reduce((s,f) => s + (f.totalDist||0), 0);
    const dates = fl.map(f => parseDateToTs(f.date)).filter(Boolean);
    const first = dates.length ? Math.min(...dates) : 0;
    const last = dates.length ? Math.max(...dates) : 0;
    return { name: g.key, count: fl.length, totalSec, maxSec, totalDist, first, last };
  });
  rows.sort((a,b) => b.count - a.count);
  return rows;
}

function StatistikApp() {
  const [flights, setFlights] = useState([]);
  const [loaded, setLoaded] = useState(false);
  const [openTable, setOpenTable] = useState(null); // "schirm" | "passagiere" | "landeplaetze" | "startplaetze"

  useEffect(() => {
    (async () => {
      try {
        const keys = await window.storage.list("flight:");
        const raw = await Promise.all((keys?.keys||[]).map(async k => {
          try { const r = await window.storage.get(k); return r ? JSON.parse(r.value) : null; } catch { return null; }
        }));
        setFlights(raw.filter(Boolean));
      } catch (e) { console.error("Load error:", e); }
      setLoaded(true);
    })();
  }, []);

  if (!loaded) return null;

  const schirmRows = aggregate(flights, f => f.glider || null);
  const passagierRows = aggregate(flights, f => (f.customFields?.passagier || "").trim() || null);
  const landRows = aggregate(flights, f => f.customFields?.landung || null).map(r => {
    const withCoord = flights.find(f => f.customFields?.landung === r.name && f.endPt);
    return { ...r, alt: withCoord?.endAlt || withCoord?.endPt?.gpsAlt || null, lat: withCoord?.endPt?.lat, lon: withCoord?.endPt?.lon };
  });
  const startRows = aggregate(flights, f => f.site || null).map(r => {
    const withCoord = flights.find(f => f.site === r.name && f.startPt);
    return { ...r, alt: withCoord?.startAlt || withCoord?.startPt?.gpsAlt || null, lat: withCoord?.startPt?.lat, lon: withCoord?.startPt?.lon };
  });

  const TABLES = [
    { id: "schirm", icon: "🪂", label: "Schirm", rows: schirmRows, color: "#e0304a" },
    { id: "passagiere", icon: "👤", label: "Passagiere", rows: passagierRows, color: "#e0304a" },
    { id: "landeplaetze", icon: "🛬", label: "Landeplätze", rows: landRows, color: "#e0304a" },
    { id: "startplaetze", icon: "🛫", label: "Startplätze", rows: startRows, color: "#e0304a" },
  ];

  return (
    <div style={{minHeight:"100vh",background:"#210710",color:"#e8f4fd",fontFamily:"-apple-system,BlinkMacSystemFont,sans-serif",paddingBottom:40}}>
      {/* Header */}
      <div style={{background:"rgba(255,255,255,0.03)",borderBottom:"1px solid rgba(255,255,255,0.06)",padding:"calc(28px + env(safe-area-inset-top, 0px)) 16px 12px",display:"flex",alignItems:"center",position:"sticky",top:0,zIndex:10,backdropFilter:"blur(10px)"}}>
        <button onClick={()=>{window.location.href="index.html";}} title="Zur Startseite"
          style={{background:"rgba(255,255,255,0.06)",border:"1px solid rgba(255,255,255,0.1)",borderRadius:10,width:32,height:32,display:"flex",alignItems:"center",justifyContent:"center",fontSize:15,color:"rgba(232,244,253,0.8)",cursor:"pointer",flexShrink:0}}>
          🏠
        </button>
        <span style={{fontWeight:900,fontSize:18,letterSpacing:-0.5,flex:1,textAlign:"center",marginLeft:-32}}>
          📊 Statistik
        </span>
      </div>

      {/* 4 badges, 2x2 grid on narrow screens */}
      <div style={{padding:"14px 16px 0",display:"grid",gridTemplateColumns:"1fr 1fr",gap:10}}>
        {TABLES.map(t => (
          <button key={t.id} onClick={()=>setOpenTable(openTable===t.id?null:t.id)}
            style={{background:openTable===t.id?"rgba(224,48,74,0.18)":"rgba(255,255,255,0.05)",border:`1px solid ${openTable===t.id?"rgba(224,48,74,0.4)":"rgba(255,255,255,0.1)"}`,borderRadius:12,padding:"12px 8px",color:openTable===t.id?"#f87171":"rgba(232,244,253,0.8)",fontSize:13,fontWeight:700,cursor:"pointer",textAlign:"center"}}>
            {t.icon} {t.label} {openTable===t.id?"▾":"▸"}
          </button>
        ))}
      </div>

      {TABLES.map(t => openTable===t.id && (
        <StatTable key={t.id} table={t} />
      ))}
    </div>
  );
}

function StatTable({ table }) {
  const { rows, id } = table;
  if (!rows.length) {
    return (
      <div style={{margin:"12px 16px 0",background:"rgba(255,255,255,0.04)",border:"1px solid rgba(255,255,255,0.08)",borderRadius:12,padding:"20px 16px",textAlign:"center",color:"rgba(232,244,253,0.4)",fontSize:13}}>
        Keine Daten vorhanden.
      </div>
    );
  }
  const totalFlights = rows.reduce((s,r) => s+r.count, 0);
  const showAlt = id === "landeplaetze" || id === "startplaetze";
  const showDist = !showAlt; // distance is more meaningful for schirm/passagiere groupings

  return (
    <div style={{margin:"12px 16px 0",display:"flex",flexDirection:"column",gap:8}}>
      <div style={{fontSize:11,color:"rgba(232,244,253,0.4)",textTransform:"uppercase",letterSpacing:0.5,padding:"0 2px"}}>
        {rows.length} Einträge · {totalFlights} Flüge total
      </div>
      {rows.map((r,idx) => (
        <div key={idx} style={{background:"rgba(255,255,255,0.04)",border:"1px solid rgba(255,255,255,0.08)",borderRadius:12,padding:"12px 14px"}}>
          <div style={{display:"flex",justifyContent:"space-between",alignItems:"center",marginBottom:8}}>
            <div style={{fontSize:14,fontWeight:700}}>{r.name}</div>
            <div style={{fontSize:13,fontWeight:700,color:"#f87171"}}>{r.count} Flüge</div>
          </div>
          <div style={{display:"flex",flexWrap:"wrap",gap:6}}>
            <StatChip label="Std." value={fmtHM(r.totalSec)} />
            <StatChip label="Max Zeit" value={fmtHours(r.maxSec)} />
            {showDist && r.totalDist > 0 && <StatChip label="Distanz" value={`${r.totalDist.toFixed(1)} km`} />}
            {showAlt && r.alt ? <StatChip label="m.ü.M." value={`${r.alt}`} /> : null}
            <StatChip label="Erster" value={fmtDateShort(r.first)} />
            <StatChip label="Letzter" value={fmtDateShort(r.last)} />
          </div>
          {showAlt && r.lat && r.lon && (
            <div style={{fontSize:10,color:"rgba(232,244,253,0.35)",marginTop:6,fontFamily:"monospace"}}>
              {r.lat.toFixed(5)}, {r.lon.toFixed(5)}
            </div>
          )}
        </div>
      ))}
    </div>
  );
}

function StatChip({ label, value }) {
  return (
    <span style={{fontSize:11,background:"rgba(255,255,255,0.04)",border:"1px solid rgba(255,255,255,0.06)",borderRadius:20,padding:"3px 9px",color:"rgba(232,244,253,0.7)"}}>
      <span style={{color:"rgba(232,244,253,0.4)"}}>{label}: </span>{value}
    </span>
  );
}
