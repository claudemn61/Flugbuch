const { useState, useEffect, useRef, useCallback } = React;

// ── IGC Parser ─────────────────────────────────────────────────────────────
function parseIGC(text) {
  const lines = text.split("\n");
  const track = [];
  let date = "";
  for (const line of lines) {
    if (line.startsWith("HFDTE")) {
      const m = line.match(/HFDTE(?:DATE:)?(\d{2})(\d{2})(\d{2})/);
      if (m) date = `${m[1]}.${m[2]}.20${m[3]}`;
    }
    if (line.startsWith("B") && line.length >= 35) {
      const hh = +line.slice(1,3), mm = +line.slice(3,5), ss = +line.slice(5,7);
      const latD = +line.slice(7,9), latM = +line.slice(9,14)/1000;
      const lonD = +line.slice(15,18), lonM = +line.slice(18,23)/1000;
      const latS = line[14], lonS = line[23];
      const lat = (latD + latM/60) * (latS==="S"?-1:1);
      const lon = (lonD + lonM/60) * (lonS==="W"?-1:1);
      const gpsAlt = +line.slice(25,30);
      if (!isNaN(lat)&&!isNaN(lon)&&!isNaN(gpsAlt))
        track.push({ lat, lon, gpsAlt, timeSec: hh*3600+mm*60+ss });
    }
  }
  return { track, date };
}

function analyzeIGC(track) {
  if (!track.length) return {};
  const alts = track.map(p=>p.gpsAlt);
  const maxAlt = Math.max(...alts), minAlt = Math.min(...alts);
  const startAlt = track[0].gpsAlt, endAlt = track[track.length-1].gpsAlt;
  const startPt = track[0], endPt = track[track.length-1];
  const durationSec = track[track.length-1].timeSec - track[0].timeSec;
  const hav = (a,b) => {
    const R=6371000, dLat=(b.lat-a.lat)*Math.PI/180, dLon=(b.lon-a.lon)*Math.PI/180;
    const x=Math.sin(dLat/2)**2+Math.cos(a.lat*Math.PI/180)*Math.cos(b.lat*Math.PI/180)*Math.sin(dLon/2)**2;
    return R*2*Math.atan2(Math.sqrt(x),Math.sqrt(1-x));
  };
  let totalDist=0;
  for(let i=1;i<track.length;i++) totalDist+=hav(track[i-1],track[i]);
  // Thermals
  const thermals=[]; let inT=false, tStart=null;
  for(let i=1;i<track.length;i++){
    const rate=(track[i].gpsAlt-track[i-1].gpsAlt)/(track[i].timeSec-track[i-1].timeSec||1);
    if(rate>0.5&&!inT){inT=true;tStart=i;}
    else if(rate<=0.5&&inT){inT=false;if(tStart)thermals.push({start:tStart,end:i,avgRate:(track[i].gpsAlt-track[tStart].gpsAlt)/(track[i].timeSec-track[tStart].timeSec||1)});}
  }
  const maxClimb = thermals.length ? +Math.max(...thermals.map(t=>t.avgRate)).toFixed(1) : 0;
  return { maxAlt, minAlt, startAlt, endAlt, startPt, endPt, durationSec,
    totalDist: +(totalDist/1000).toFixed(2), thermalCount: thermals.length, maxClimb };
}

// ── FlightMap ──────────────────────────────────────────────────────────────
function FlightMap({ flight }) {
  const canvasRef = useRef(null);
  useEffect(() => {
    const canvas = canvasRef.current; if (!canvas) return;
    const ctx = canvas.getContext("2d");
    const W = canvas.width, H = canvas.height;
    ctx.clearRect(0,0,W,H);
    ctx.fillStyle = "#0d1b2a"; ctx.fillRect(0,0,W,H);
    const track = flight?.track||[];
    const sP = flight?.startPt, eP = flight?.endPt;
    const drawM=(x,y,col,lbl)=>{
      ctx.fillStyle=col; ctx.beginPath(); ctx.arc(x,y,5,0,2*Math.PI); ctx.fill();
      ctx.fillStyle="#fff"; ctx.font="bold 8px system-ui"; ctx.textAlign="center";
      ctx.fillText(lbl,x,y+3);
    };
    if (!track.length && (!sP||!eP)) {
      ctx.fillStyle="rgba(125,211,252,0.25)"; ctx.font="12px system-ui";
      ctx.textAlign="center"; ctx.fillText("Karte verfügbar nach IGC-Import",W/2,H/2);
      return;
    }
    if (track.length) {
      const lats=track.map(p=>p.lat), lons=track.map(p=>p.lon);
      const minLat=Math.min(...lats), maxLat=Math.max(...lats);
      const minLon=Math.min(...lons), maxLon=Math.max(...lons);
      const sc=Math.min((W-36)/(maxLon-minLon||0.001),(H-36)/(maxLat-minLat||0.001));
      const offX=(W-(maxLon-minLon)*sc)/2, offY=(H-(maxLat-minLat)*sc)/2;
      const tx=lon=>offX+(lon-minLon)*sc, ty=lat=>H-offY-(lat-minLat)*sc;
      const alts=track.map(p=>p.gpsAlt), minA=Math.min(...alts), rng=Math.max(...alts)-minA||1;
      for(let i=1;i<track.length;i++){
        const t=(track[i].gpsAlt-minA)/rng;
        ctx.strokeStyle=`hsl(${200+t*60},80%,${45+t*25}%)`;
        ctx.lineWidth=2; ctx.beginPath();
        ctx.moveTo(tx(track[i-1].lon),ty(track[i-1].lat));
        ctx.lineTo(tx(track[i].lon),ty(track[i].lat));
        ctx.stroke();
      }
      drawM(tx(track[0].lon),ty(track[0].lat),"#22c55e","S");
      drawM(tx(track[track.length-1].lon),ty(track[track.length-1].lat),"#ef4444","L");
    } else {
      // No IGC: show S and L markers only, no connecting line
      const pts=[sP,eP].filter(Boolean);
      const lats=pts.map(p=>p.lat), lons=pts.map(p=>p.lon);
      const minLat=Math.min(...lats), maxLat=Math.max(...lats);
      const minLon=Math.min(...lons), maxLon=Math.max(...lons);
      const sc=Math.min(8000,(W-60)/(maxLon-minLon||0.001),(H-60)/(maxLat-minLat||0.001));
      const offX=(W-(maxLon-minLon)*sc)/2, offY=(H-(maxLat-minLat)*sc)/2;
      const tx=lon=>offX+(lon-minLon)*sc, ty=lat=>H-offY-(lat-minLat)*sc;
      if(sP) drawM(tx(sP.lon),ty(sP.lat),"#22c55e","S");
      if(eP) drawM(tx(eP.lon),ty(eP.lat),"#ef4444","L");
    }
  }, [flight]);
  return <canvas ref={canvasRef} width={340} height={140} style={{width:"100%",height:140,background:"#0d1b2a",borderRadius:10,display:"block"}} />;
}

// ── Custom field formulas ──────────────────────────────────────────────────
const FORMULA_DEFS = [
  { id:"rank_dur",  label:"Rang Flugzeit",   icon:"⏱", desc:"#1 = längster Flug" },
  { id:"rank_dist", label:"Rang Distanz",    icon:"📏", desc:"#1 = weitester Flug" },
  { id:"rank_alt",  label:"Rang Höhe",       icon:"⬆", desc:"#1 = höchster Flug" },
  { id:"pr_dur",    label:"Persönl. Rekord Dauer",  icon:"🏆", desc:"Ja / Nein" },
  { id:"pr_dist",   label:"Persönl. Rekord Distanz",icon:"🏆", desc:"Ja / Nein" },
  { id:"pr_alt",    label:"Persönl. Rekord Höhe",   icon:"🏆", desc:"Ja / Nein" },
  { id:"season_flights", label:"Saison-Flüge",  icon:"📅", desc:"Anzahl Flüge im Jahr" },
  { id:"season_hours",   label:"Saison-Stunden",icon:"⏱", desc:"Total Stunden im Jahr" },
];

function evalFormula(id, flight, allFlights) {
  const sorted = (key) => [...allFlights].sort((a,b)=>b[key]-a[k]);
  const yf = allFlights.filter(f=>f.year===flight.year);
  switch(id) {
    case "rank_dur":  return "#"+([...allFlights].sort((a,b)=>b.durationSec-a.durationSec).findIndex(f=>f.id===flight.id)+1);
    case "rank_dist": return "#"+([...allFlights].sort((a,b)=>b.totalDist-a.totalDist).findIndex(f=>f.id===flight.id)+1);
    case "rank_alt":  return "#"+([...allFlights].sort((a,b)=>b.maxAlt-a.maxAlt).findIndex(f=>f.id===flight.id)+1);
    case "pr_dur":    return flight.durationSec>=Math.max(...allFlights.map(f=>f.durationSec))?"🏆 Ja":"Nein";
    case "pr_dist":   return flight.totalDist>=Math.max(...allFlights.map(f=>f.totalDist))?"🏆 Ja":"Nein";
    case "pr_alt":    return flight.maxAlt>=Math.max(...allFlights.map(f=>f.maxAlt))?"🏆 Ja":"Nein";
    case "season_flights": return yf.length;
    case "season_hours": { const s=yf.reduce((a,f)=>a+f.durationSec,0); return `${Math.floor(s/3600)}h${String(Math.floor((s%3600)/60)).padStart(2,"0")}m`; }
    default: return "—";
  }
}

// ── FieldEditor ────────────────────────────────────────────────────────────
function FieldEditor({ customFieldDefs, onSave, onClose }) {
  const [defs, setDefs] = useState(customFieldDefs);
  const add = (type) => setDefs(d=>[...d,{id:`cf_${Date.now()}`,name:"",type,formula:""}]);
  const update = (id,key,val) => setDefs(d=>d.map(f=>f.id===id?{...f,[key]:val}:f));
  const remove = (id) => setDefs(d=>d.filter(f=>f.id!==id));
  return (
    <div style={{position:"fixed",top:0,left:0,right:0,bottom:0,background:"rgba(0,0,0,0.7)",zIndex:100,display:"flex",alignItems:"center",justifyContent:"center",padding:16}}>
      <div style={{background:"#0f2033",borderRadius:20,padding:20,width:"100%",maxWidth:420,maxHeight:"80vh",overflowY:"auto",border:"1px solid rgba(100,180,255,0.15)"}}>
        <div style={{display:"flex",justifyContent:"space-between",alignItems:"center",marginBottom:16}}>
          <span style={{fontWeight:800,fontSize:16}}>Eigene Felder</span>
          <button onClick={onClose} style={{background:"none",border:"none",color:"#7dd3fc",fontSize:20,cursor:"pointer"}}>✕</button>
        </div>
        {defs.map(f=>(
          <div key={f.id} style={{background:"rgba(255,255,255,0.05)",borderRadius:12,padding:12,marginBottom:8}}>
            {f.formula ? (
              <div style={{display:"flex",justifyContent:"space-between",alignItems:"center"}}>
                <span style={{fontSize:13}}>{FORMULA_DEFS.find(d=>d.id===f.formula)?.icon} {f.name}</span>
                <button onClick={()=>remove(f.id)} style={{background:"none",border:"none",color:"#f87171",cursor:"pointer"}}>✕</button>
              </div>
            ) : (
              <div style={{display:"flex",gap:8,alignItems:"center"}}>
                <input value={f.name} onChange={e=>update(f.id,"name",e.target.value)} placeholder="Feldname"
                  style={{flex:1,background:"rgba(255,255,255,0.08)",border:"1px solid rgba(255,255,255,0.1)",borderRadius:8,padding:"6px 10px",color:"#e8f4fd",fontSize:13}} />
                <select value={f.type} onChange={e=>update(f.id,"type",e.target.value)}
                  style={{background:"rgba(255,255,255,0.08)",border:"1px solid rgba(255,255,255,0.1)",borderRadius:8,padding:"6px 8px",color:"#e8f4fd",fontSize:12}}>
                  <option value="text">Text</option><option value="number">Zahl</option><option value="date">Datum</option>
                </select>
                <button onClick={()=>remove(f.id)} style={{background:"none",border:"none",color:"#f87171",cursor:"pointer"}}>✕</button>
              </div>
            )}
          </div>
        ))}
        <div style={{marginTop:12,marginBottom:12}}>
          <div style={{fontSize:11,color:"rgba(232,244,253,0.4)",marginBottom:8,textTransform:"uppercase",letterSpacing:1}}>Manuell hinzufügen</div>
          <div style={{display:"flex",gap:8}}>
            {["text","number","date"].map(t=>(
              <button key={t} onClick={()=>add(t)} style={{flex:1,background:"rgba(100,180,255,0.1)",border:"1px solid rgba(100,180,255,0.2)",borderRadius:10,padding:"8px 4px",color:"#7dd3fc",fontSize:12,cursor:"pointer"}}>
                + {t==="text"?"Text":t==="number"?"Zahl":"Datum"}
              </button>
            ))}
          </div>
        </div>
        <div style={{fontSize:11,color:"rgba(232,244,253,0.4)",marginBottom:8,textTransform:"uppercase",letterSpacing:1}}>Auto-Formeln</div>
        <div style={{display:"flex",flexWrap:"wrap",gap:6,marginBottom:16}}>
          {FORMULA_DEFS.filter(fd=>!defs.find(d=>d.formula===fd.id)).map(fd=>(
            <button key={fd.id} onClick={()=>setDefs(d=>[...d,{id:`auto_${fd.id}`,name:fd.label,type:"auto",formula:fd.id}])}
              style={{background:"rgba(139,92,246,0.12)",border:"1px solid rgba(139,92,246,0.25)",borderRadius:20,padding:"5px 10px",color:"#c4b5fd",fontSize:11,cursor:"pointer"}}>
              {fd.icon} {fd.label}
            </button>
          ))}
        </div>
        <button onClick={()=>onSave(defs)} style={{width:"100%",background:"linear-gradient(135deg,#0ea5e9,#0284c7)",border:"none",borderRadius:12,padding:12,color:"#fff",fontWeight:700,cursor:"pointer",fontSize:14}}>
          Speichern
        </button>
      </div>
    </div>
  );
}

// ── Season Dashboard ────────────────────────────────────────────────────────
function SeasonDash({ flights, onBack, pdfData }) {
  const years = [...new Set(flights.map(f=>f.year).filter(Boolean))].sort().reverse();
  const [yr, setYr] = useState(years[0]||"");
  const [showMoreYears, setShowMoreYears] = useState(false);
  const yf = flights.filter(f=>f.year===yr);
  // Parse durationStr to seconds if durationSec missing
  const parseDurStr = s => {
    if (!s) return 0;
    // HH:MM:SS
    const dm = s.match(/(\d+):(\d{2}):(\d{2})/);
    if (dm) return +dm[1]*3600 + +dm[2]*60 + +dm[3];
    // HH:MM
    const dm2 = s.match(/(\d+):(\d{2})/);
    if (dm2) return +dm2[1]*60 + +dm2[2];
    // "0h 53m" or "3h 44m"
    const dm3 = s.match(/(\d+)h\s*(\d+)m/);
    if (dm3) return +dm3[1]*3600 + +dm3[2]*60;
    // "53m"
    const dm4 = s.match(/(\d+)m/);
    if (dm4) return +dm4[1]*60;
    return 0;
  };
  const parseDur = f => {
    if (f.durationSec > 0) return f.durationSec;
    if (f.durationStr) return parseDurStr(f.durationStr);
    // Fallback: look up PDF_DATA by flight number
    const p = pdfData && pdfData[(f.name||"").match(/\d+/)?.[0]];
    if (p?.dur) return parseDurStr(p.dur);
    return 0;
  };
  const getDist = f => {
    if (f.totalDist > 0) return f.totalDist;
    const p = pdfData && pdfData[(f.name||"").match(/\d+/)?.[0]];
    return parseFloat(f.customFields?.distKm || p?.dk || 0) || 0;
  };
  const getAlt = f => {
    if (f.maxAlt > 0) return f.maxAlt;
    const p = pdfData && pdfData[(f.name||"").match(/\d+/)?.[0]];
    return +(f.customFields?.hMax || p?.hm || 0);
  };
  const totalSec = yf.reduce((s,f)=>s+parseDur(f),0);
  const totalDist = yf.reduce((s,f)=>s+getDist(f),0);
  const getDur = f => parseDur(f);
  const prDur  = yf.length ? Math.max(...yf.map(getDur))  : 0;
  const prDist = yf.length ? Math.max(...yf.map(getDist)) : 0;
  const prAlt  = yf.length ? Math.max(...yf.map(getAlt))  : 0;
  const prFlightDur  = yf.find(f=>getDur(f)===prDur);
  const prFlightDist = yf.find(f=>getDist(f)===prDist);
  const prFlightAlt  = yf.find(f=>getAlt(f)===prAlt);
  const fmtDur = s => `${Math.floor(s/3600)}h ${String(Math.floor((s%3600)/60)).padStart(2,"0")}m`;

  const S = {
    wrap:{padding:"0 16px 24px",background:"#0d1b2a",minHeight:"100vh",color:"#e8f4fd",fontFamily:"-apple-system,BlinkMacSystemFont,sans-serif"},
    yearRow:{display:"flex",gap:8,marginBottom:16,flexWrap:"wrap"},
    yrBtn:(a)=>({background:a?"rgba(14,165,233,0.3)":"rgba(255,255,255,0.05)",border:a?"1px solid rgba(14,165,233,0.5)":"1px solid rgba(255,255,255,0.08)",borderRadius:20,padding:"6px 14px",color:a?"#7dd3fc":"rgba(232,244,253,0.5)",fontSize:13,cursor:"pointer",fontWeight:a?600:400}),
    grid:{display:"grid",gridTemplateColumns:"1fr 1fr",gap:10,marginBottom:16},
    box:{background:"rgba(255,255,255,0.05)",borderRadius:14,padding:"14px 12px",textAlign:"center",border:"1px solid rgba(255,255,255,0.07)"},
    bigNum:{fontSize:26,fontWeight:800,color:"#7dd3fc",letterSpacing:-1},
    lbl:{fontSize:10,color:"rgba(232,244,253,0.4)",textTransform:"uppercase",letterSpacing:0.8,marginTop:3},
    prBox:{background:"rgba(245,158,11,0.08)",border:"1px solid rgba(245,158,11,0.2)",borderRadius:14,padding:"14px 16px",marginBottom:10},
    prTitle:{fontSize:11,fontWeight:600,color:"#f59e0b",letterSpacing:1.2,textTransform:"uppercase",marginBottom:8},
    prRow:{display:"flex",justifyContent:"space-between",alignItems:"center",padding:"6px 0",borderBottom:"1px solid rgba(245,158,11,0.08)"},
    prLbl:{fontSize:13,color:"rgba(232,244,253,0.5)"},
    prVal:{fontSize:13,fontWeight:600,color:"#fcd34d"},
    prSub:{fontSize:11,color:"rgba(232,244,253,0.3)"},
  };

  if (!flights.length) return null;

  return (
    <div style={S.wrap}>
      <div style={{display:"flex",alignItems:"center",gap:10,padding:"16px 0 14px",borderBottom:"1px solid rgba(100,180,255,0.1)",marginBottom:16}}>
        <button onClick={onBack} style={{background:"none",border:"none",color:"#7dd3fc",fontSize:22,cursor:"pointer",padding:0}}>‹</button>
        <div>
          <div style={{fontSize:11,fontWeight:600,color:"#7dd3fc",letterSpacing:1.5,textTransform:"uppercase"}}>Saison-Übersicht</div>
          <div style={{fontSize:10,color:"rgba(232,244,253,0.35)",marginTop:1}}>{flights.length} Flüge total</div>
        </div>
      </div>
      <div style={S.yearRow}>
        {years.slice(0,4).map(y=><button key={y} style={S.yrBtn(y===yr)} onClick={()=>setYr(y)}>{y}</button>)}
        {years.length>4 && (
          <button onClick={()=>setShowMoreYears(true)}
            style={S.yrBtn(years.slice(4).includes(yr))}>
            {years.slice(4).includes(yr) ? yr : "Mehr ▾"}
          </button>
        )}
      </div>
      {showMoreYears && (
        <div onClick={()=>setShowMoreYears(false)}
          style={{position:"fixed",inset:0,background:"rgba(0,0,0,0.55)",zIndex:200,display:"flex",alignItems:"center",justifyContent:"center",padding:24}}>
          <div onClick={e=>e.stopPropagation()}
            style={{background:"#14253a",border:"1px solid rgba(255,255,255,0.12)",borderRadius:16,padding:14,maxHeight:"60vh",overflowY:"auto",width:"100%",maxWidth:280,boxShadow:"0 8px 30px rgba(0,0,0,0.5)"}}>
            <div style={{fontSize:13,fontWeight:700,color:"rgba(232,244,253,0.5)",marginBottom:8,padding:"0 4px"}}>Jahr wählen</div>
            {years.slice(4).map(y=>(
              <div key={y} onClick={()=>{setYr(y);setShowMoreYears(false);}}
                style={{padding:"10px 12px",borderRadius:10,fontSize:15,cursor:"pointer",color:y===yr?"#7dd3fc":"#e8f4fd",background:y===yr?"rgba(14,165,233,0.15)":"transparent",marginBottom:2}}>
                {y}
              </div>
            ))}
          </div>
        </div>
      )}
      {yf.length===0 ? (
        <div style={{color:"rgba(232,244,253,0.3)",fontSize:14}}>Keine Flüge in {yr}</div>
      ) : (<>
        <div style={S.grid}>
          <div style={S.box}><div style={S.bigNum}>{yf.length}</div><div style={S.lbl}>Flüge</div></div>
          <div style={S.box}><div style={S.bigNum}>{fmtDur(totalSec)}</div><div style={S.lbl}>Total Flugzeit</div></div>
          <div style={S.box}><div style={S.bigNum}>{totalDist.toFixed(0)} km</div><div style={S.lbl}>Total Distanz</div></div>
          <div style={S.box}><div style={S.bigNum}>{yf.length>0?(totalDist/yf.length).toFixed(1):0} km</div><div style={S.lbl}>Ø / Flug</div></div>
        </div>
        <div style={S.prBox}>
          <div style={S.prTitle}>🏆 Persönliche Rekorde {yr}</div>
          {[
            ["Längster Flug",   prFlightDur?.name,  prDur  ? fmtDur(prDur)       : "—"],
            ["Weitester Flug",  prFlightDist?.name, prDist ? prDist+" km"         : "—"],
            ["Höchster Flug",   prFlightAlt?.name,  prAlt  ? prAlt+" m ü.M."      : "—"],
          ].map(([label,name,val])=>(
            <div key={label} style={S.prRow}>
              <div>
                <div style={S.prLbl}>{label}</div>
                {name&&<div style={S.prSub}>Flug {name}</div>}
              </div>
              <span style={S.prVal}>{val}</span>
            </div>
          ))}
        </div>
      </>)}
    </div>
  );
}

const PDF_DATA = {
"1":{d:"15.4.87",sz:"",lz:"",st:"Leuggelen",la:"Schwanden",sLat:46.992731,sLon:9.048367,lLat:46.990084,lLon:9.058741,dur:"0h 3m",dk:"0.5",sl:"0.8",kmh:"12.0",hd:"425",msa:"988",ml:"563",hm:"",hg:"",ms:"",mst:"",ge:"Swing HP 927",pa:"",be:"Ziel nicht erreicht"},
"2":{d:"15.4.87",sz:"",lz:"",st:"Leuggelen",la:"Schwanden",sLat:46.992731,sLon:9.048367,lLat:46.990084,lLon:9.058741,dur:"0h 3m",dk:"0.5",sl:"0.8",kmh:"12.0",hd:"425",msa:"988",ml:"563",hm:"",hg:"",ms:"",mst:"",ge:"Swing HP 927",pa:"",be:"Ziel erreicht."},
"3":{d:"15.4.87",sz:"",lz:"",st:"Leuggelen",la:"Schwanden",sLat:46.992731,sLon:9.048367,lLat:46.990084,lLon:9.058741,dur:"0h 2m",dk:"0.5",sl:"0.8",kmh:"15.0",hd:"425",msa:"988",ml:"563",hm:"",hg:"",ms:"",mst:"",ge:"Swing HP 927",pa:"",be:"Ziellandung gut."},
"4":{d:"15.4.87",sz:"",lz:"",st:"Leuggelen",la:"Schwanden",sLat:46.992731,sLon:9.048367,lLat:46.990084,lLon:9.058741,dur:"0h 3m",dk:"0.5",sl:"0.8",kmh:"12.0",hd:"425",msa:"988",ml:"563",hm:"",hg:"",ms:"",mst:"",ge:"Swing HP 927",pa:"",be:"Ziel nicht getroffen."},
"5":{d:"15.4.87",sz:"",lz:"",st:"Leuggelen",la:"Schwanden",sLat:46.992731,sLon:9.048367,lLat:46.990084,lLon:9.058741,dur:"0h 3m",dk:"0.5",sl:"0.8",kmh:"12.0",hd:"425",msa:"988",ml:"563",hm:"",hg:"",ms:"",mst:"",ge:"Swing HP 927",pa:"",be:"Ziel erreicht."},
"6":{d:"1.5.87",sz:"",lz:"",st:"Brämabüel",la:"Davos Jakobshorn Winter",sLat:46.781316,sLon:9.848496,lLat:46.78741,lLon:9.817978,dur:"0h 8m",dk:"2",sl:"2.420",kmh:"15.0",hd:"912",msa:"2444",ml:"1532",hm:"",hg:"",ms:"",mst:"",ge:"Swing HP 927",pa:"",be:"Ziel positiv, zwei Fehlstarts, Skistart."},
"7":{d:"1.5.87",sz:"",lz:"",st:"Brämabüel",la:"Davos Jakobshorn Winter",sLat:46.781316,sLon:9.848496,lLat:46.78741,lLon:9.817978,dur:"0h 8m",dk:"2",sl:"2.4",kmh:"15.0",hd:"912",msa:"2444",ml:"1532",hm:"",hg:"",ms:"",mst:"",ge:"Swing HP 927",pa:"",be:"Ziel gut erreicht, Böen."},
"8":{d:"1.5.87",sz:"",lz:"",st:"Brämabüel",la:"Davos Jakobshorn Winter",sLat:46.781316,sLon:9.848496,lLat:46.78741,lLon:9.817978,dur:"0h 8m",dk:"2",sl:"2.4",kmh:"15.0",hd:"912",msa:"2444",ml:"1532",hm:"",hg:"",ms:"",mst:"",ge:"Swing HP 927",pa:"",be:"Ziel erreicht."},
"9":{d:"1.5.87",sz:"",lz:"",st:"Brämabüel",la:"Davos Jakobshorn Winter",sLat:46.781316,sLon:9.848496,lLat:46.78741,lLon:9.817978,dur:"0h 8m",dk:"2",sl:"2.4",kmh:"15.0",hd:"912",msa:"2444",ml:"1532",hm:"",hg:"",ms:"",mst:"",ge:"Swing HP 927",pa:"",be:"Ziel negativ, zu hoch, dann nach Korrektur zu kurz."},
"10":{d:"8.5.87",sz:"",lz:"",st:"Brunnenberg",la:"Luchsingen",sLat:46.972376,sLon:9.024163,lLat:46.962402,lLon:9.0368,dur:"0h 5m",dk:"1.5",sl:"1.5",kmh:"20.0",hd:"599",msa:"1174",ml:"575",hm:"",hg:"",ms:"",mst:"",ge:"Swing HP 927",pa:"",be:"Ziel erreicht, eine Kurve gut."},
"11":{d:"8.5.87",sz:"",lz:"",st:"Brunnenberg",la:"Luchsingen",sLat:46.972376,sLon:9.024163,lLat:46.962402,lLon:9.0368,dur:"0h 5m",dk:"1.5",sl:"1.5",kmh:"20.0",hd:"599",msa:"1174",ml:"575",hm:"",hg:"",ms:"",mst:"",ge:"Swing HP 927",pa:"",be:"Ziel erreicht."},
"12":{d:"8.5.87",sz:"",lz:"",st:"Brunnenberg",la:"Luchsingen",sLat:46.972376,sLon:9.024163,lLat:46.962402,lLon:9.0368,dur:"0h 4m",dk:"1.5",sl:"1.5",kmh:"22.5",hd:"599",msa:"1174",ml:"575",hm:"",hg:"",ms:"",mst:"",ge:"Swing HP 927",pa:"",be:"Ziel gut erreicht, Start fast abgebrochen."},
"13":{d:"8.5.87",sz:"",lz:"",st:"Brunnenberg",la:"Luchsingen",sLat:46.972376,sLon:9.024163,lLat:46.962402,lLon:9.0368,dur:"0h 4m",dk:"1.5",sl:"1.5",kmh:"22.5",hd:"599",msa:"1174",ml:"575",hm:"",hg:"",ms:"",mst:"",ge:"Swing HP 927",pa:"",be:"Ziel negativ."},
"14":{d:"8.5.87",sz:"",lz:"",st:"Brunnenberg",la:"Luchsingen",sLat:46.972376,sLon:9.024163,lLat:46.962402,lLon:9.0368,dur:"0h 4m",dk:"1.5",sl:"1.5",kmh:"22.5",hd:"599",msa:"1174",ml:"575",hm:"",hg:"",ms:"",mst:"",ge:"Swing HP 927",pa:"",be:"Ziel positiv"},
"15":{d:"8.5.87",sz:"",lz:"",st:"Brunnenberg",la:"Luchsingen",sLat:46.972376,sLon:9.024163,lLat:46.962402,lLon:9.0368,dur:"0h 5m",dk:"1.5",sl:"1.5",kmh:"18.0",hd:"599",msa:"1174",ml:"575",hm:"",hg:"",ms:"",mst:"",ge:"Swing HP 927",pa:"",be:"Ziel positiv, Start knapp, Abwind"},
"16":{d:"6.6.87",sz:"",lz:"",st:"Mattstock",la:"Kreuzboden Amden",sLat:47.164645,sLon:9.13348,lLat:47.155292,lLon:9.136244,dur:"0h 4m",dk:"1",sl:"1.1",kmh:"15.0",hd:"536",msa:"1587",ml:"1051",hm:"",hg:"",ms:"",mst:"",ge:"Swing HP 927",pa:"",be:"Starke Turbulenzen, föhnig, Sackflug, Bea auf Sessellift. Start in Ordnung."},
"17":{d:"10.6.87",sz:"",lz:"",st:"Wissenberg",la:"Matt",sLat:46.968125,sLon:9.177696,lLat:46.966355,lLon:9.167965,dur:"0h 4m",dk:"1",sl:"0.8",kmh:"15.0",hd:"541",msa:"1357",ml:"816",hm:"",hg:"",ms:"",mst:"",ge:"Swing HP 927",pa:"",be:"Ziel positiv, Seilbahn."},
"18":{d:"10.6.87",sz:"",lz:"",st:"Wissenberg",la:"Matt",sLat:46.968125,sLon:9.177696,lLat:46.966355,lLon:9.167965,dur:"0h 4m",dk:"1",sl:"0.8",kmh:"15.0",hd:"541",msa:"1357",ml:"816",hm:"",hg:"",ms:"",mst:"",ge:"Swing HP 927",pa:"",be:"Ziel gut positiv."},
"19":{d:"10.6.87",sz:"",lz:"",st:"Wissenberg",la:"Matt",sLat:46.968125,sLon:9.177696,lLat:46.966355,lLon:9.167965,dur:"0h 4m",dk:"1",sl:"0.8",kmh:"15.0",hd:"541",msa:"1357",ml:"816",hm:"",hg:"",ms:"",mst:"",ge:"Swing HP 927",pa:"",be:"Ziel negativ."},
"20":{d:"10.6.87",sz:"",lz:"",st:"Wissenberg",la:"Matt",sLat:46.968125,sLon:9.177696,lLat:46.966355,lLon:9.167965,dur:"0h 4m",dk:"1",sl:"0.8",kmh:"15.0",hd:"541",msa:"1357",ml:"816",hm:"",hg:"",ms:"",mst:"",ge:"Swing HP 927",pa:"",be:"Ziel negativ, negative 8."},
"21":{d:"24.6.87",sz:"",lz:"",st:"Fürenalp",la:"Rest Wasserfall",sLat:46.80452,sLon:8.466794,lLat:46.80413,lLon:8.446925,dur:"0h 7m",dk:"1",sl:"1.5",kmh:"8.6",hd:"834",msa:"1903",ml:"1069",hm:"",hg:"",ms:"",mst:"",ge:"Swing HP 927",pa:"",be:"Ziel gut positiv, schwieriger Start."},
"22":{d:"24.6.87",sz:"",lz:"",st:"Fürenalp",la:"Rest Wasserfall",sLat:46.80452,sLon:8.466794,lLat:46.80413,lLon:8.446925,dur:"0h 7m",dk:"1",sl:"1.5",kmh:"8.6",hd:"834",msa:"1903",ml:"1069",hm:"",hg:"",ms:"",mst:"",ge:"Swing HP 927",pa:"",be:"Positiv, negative 8."},
"23":{d:"24.6.87",sz:"",lz:"",st:"Fürenalp",la:"Rest Wasserfall",sLat:46.80452,sLon:8.466794,lLat:46.80413,lLon:8.446925,dur:"0h 7m",dk:"1",sl:"1.5",kmh:"8.6",hd:"834",msa:"1903",ml:"1069",hm:"",hg:"",ms:"",mst:"",ge:"Swing HP 927",pa:"",be:"Ziel negativ, negative 8."},
"24":{d:"24.6.87",sz:"",lz:"",st:"Fürenalp",la:"Rest Wasserfall",sLat:46.80452,sLon:8.466794,lLat:46.80413,lLon:8.446925,dur:"0h 7m",dk:"1",sl:"1.5",kmh:"8.6",hd:"834",msa:"1903",ml:"1069",hm:"",hg:"",ms:"",mst:"",ge:"Swing HP 927",pa:"",be:"Ziel gut positiv"},
"25":{d:"29.6.87",sz:"",lz:"",st:"Fürenalp",la:"Rest Wasserfall",sLat:46.80452,sLon:8.466794,lLat:46.80413,lLon:8.446925,dur:"0h 7m",dk:"1",sl:"1.5",kmh:"8.6",hd:"834",msa:"1903",ml:"1069",hm:"",hg:"",ms:"",mst:"",ge:"Swing HP 927",pa:"",be:"Probeflug für Prüfungen, Ziel positiv."},
"26":{d:"29.6.87",sz:"",lz:"",st:"Fürenalp",la:"Rest Wasserfall",sLat:46.80452,sLon:8.466794,lLat:46.80413,lLon:8.446925,dur:"0h 7m",dk:"1",sl:"1.5",kmh:"8.6",hd:"834",msa:"1903",ml:"1069",hm:"",hg:"",ms:"",mst:"",ge:"Swing HP 927",pa:"",be:"1. Prüfungsflug: Flug gut, Ziel nicht erreicht."},
"27":{d:"29.6.87",sz:"",lz:"",st:"Fürenalp",la:"Rest Wasserfall",sLat:46.80452,sLon:8.466794,lLat:46.80413,lLon:8.446925,dur:"0h 7m",dk:"1",sl:"1.5",kmh:"8.6",hd:"834",msa:"1903",ml:"1069",hm:"",hg:"",ms:"",mst:"",ge:"Swing HP 927",pa:"",be:"2. Prüfungsflug: Sacklug 20 m über dem Boden. Ziel nicht erreicht. Abbruch, Tragegurten falsch."},
"28":{d:"29.6.87",sz:"",lz:"",st:"Fürenalp",la:"Rest Wasserfall",sLat:46.80452,sLon:8.466794,lLat:46.80413,lLon:8.446925,dur:"0h 6m",dk:"1",sl:"1.5",kmh:"10.0",hd:"834",msa:"1903",ml:"1069",hm:"",hg:"",ms:"",mst:"",ge:"Raider",pa:"",be:"3. Prüfungsflug: Rolis Raider. Ziel sehr gut getroffen."},
"29":{d:"29.6.87",sz:"",lz:"",st:"Fürenalp",la:"Rest Wasserfall",sLat:46.80452,sLon:8.466794,lLat:46.80413,lLon:8.446925,dur:"0h 6m",dk:"1",sl:"1.5",kmh:"10.0",hd:"834",msa:"1903",ml:"1069",hm:"",hg:"",ms:"",mst:"",ge:"Raider",pa:"",be:"4. Prüfungsflug: Rolis Raider, Ziel positiv, Prüfung bestanden."},
"30":{d:"20.7.87",sz:"",lz:"",st:"Rothorn",la:"Valbella See",sLat:46.741949,sLon:9.599242,lLat:46.742593,lLon:9.555272,dur:"0h 16m",dk:"2",sl:"3.4",kmh:"7.5",hd:"1339",msa:"2828",ml:"1489",hm:"",hg:"",ms:"",mst:"",ge:"Swing HP 927",pa:"",be:"Schwieriger Start, stark Wind."},
"31":{d:"10.8.87",sz:"",lz:"",st:"Eggberge",la:"Flüelen Krebsried",sLat:46.904141,sLon:8.651741,lLat:46.887805,lLon:8.631125,dur:"0h 5m",dk:"0.6",sl:"2.4",kmh:"7.2",hd:"1130",msa:"1567",ml:"437",hm:"",hg:"",ms:"",mst:"",ge:"Swing HP 927",pa:"",be:"Rückenwind Landung, gut."},
"32":{d:"27.9.87",sz:"",lz:"",st:"Brunnenberg",la:"Luchsingen",sLat:46.972376,sLon:9.024163,lLat:46.962402,lLon:9.0368,dur:"0h 5m",dk:"1",sl:"1.5",kmh:"12.0",hd:"599",msa:"1174",ml:"575",hm:"",hg:"",ms:"",mst:"",ge:"Swing HP 927",pa:"",be:"Schnee Start zu Fuss."},
"33":{d:"29.10.87",sz:"",lz:"",st:"Ischalp Davos",la:"Davos Jakobshorn Winter",sLat:46.787026,sLon:9.830736,lLat:46.78741,lLon:9.817978,dur:"0h 3m",dk:"0.4",sl:"1.0",kmh:"8.0",hd:"343",msa:"1875",ml:"1532",hm:"",hg:"",ms:"",mst:"",ge:"Swing HP 927",pa:"",be:"Rückenwind Start."},
"34":{d:"27.12.87",sz:"",lz:"",st:"Motta Naluns",la:"Scuol",sLat:46.790828,sLon:10.282705,lLat:46.794543,lLon:10.283924,dur:"0h 10m",dk:"2",sl:"0.4",kmh:"12.0",hd:"765",msa:"2052",ml:"1287",hm:"",hg:"",ms:"",mst:"",ge:"Swing HP 927",pa:"",be:"oB"},
"35":{d:"27.12.87",sz:"",lz:"",st:"Motta Naluns",la:"Scuol",sLat:46.790828,sLon:10.282705,lLat:46.794543,lLon:10.283924,dur:"0h 12m",dk:"2",sl:"0.4",kmh:"10.0",hd:"765",msa:"2052",ml:"1287",hm:"",hg:"",ms:"",mst:"",ge:"Swing HP 927",pa:"",be:"oB"},
"36":{d:"27.12.87",sz:"",lz:"",st:"Motta Naluns",la:"Scuol",sLat:46.790828,sLon:10.282705,lLat:46.794543,lLon:10.283924,dur:"0h 11m",dk:"2",sl:"0.4",kmh:"10.9",hd:"765",msa:"2052",ml:"1287",hm:"",hg:"",ms:"",mst:"",ge:"Swing HP 927",pa:"",be:"oB"},
"37":{d:"28.12.87",sz:"",lz:"",st:"Pt 2327 Piz Mezdi Nord",la:"Tarasp",sLat:46.7526,sLon:10.25917,lLat:46.778758,lLon:10.264942,dur:"0h 16m",dk:"2.4",sl:"2.9",kmh:"9.0",hd:"934",msa:"2363",ml:"1429",hm:"",hg:"",ms:"",mst:"",ge:"Swing HP 927",pa:"",be:"Ein Fehlstart, flacher Startplatz."},
"38":{d:"19.1.88",sz:"",lz:"",st:"Cassons",la:"Flims",sLat:46.87646,sLon:9.262552,lLat:46.835689,lLon:9.281179,dur:"0h 19m",dk:"3",sl:"4.7",kmh:"9.5",hd:"1357",msa:"2455",ml:"1098",hm:"",hg:"",ms:"",mst:"",ge:"Swing HP 927",pa:"",be:"Starkwind Start."},
"39":{d:"19.1.88",sz:"",lz:"",st:"Cassons",la:"Flims",sLat:46.87646,sLon:9.262552,lLat:46.835689,lLon:9.281179,dur:"0h 17m",dk:"3",sl:"4.7",kmh:"10.6",hd:"1357",msa:"2455",ml:"1098",hm:"",hg:"",ms:"",mst:"",ge:"Swing HP 927",pa:"",be:"Starkwind Start."},
"40":{d:"2.2.88",sz:"",lz:"",st:"Brunnenberg",la:"Luchsingen",sLat:46.972376,sLon:9.024163,lLat:46.962402,lLon:9.0368,dur:"0h 6m",dk:"1",sl:"1.5",kmh:"10.0",hd:"599",msa:"1174",ml:"575",hm:"",hg:"",ms:"",mst:"",ge:"Swing HP 927",pa:"",be:"Nichts besonderes."},
"41":{d:"2.2.88",sz:"",lz:"",st:"Brunnenberg",la:"Luchsingen",sLat:46.972376,sLon:9.024163,lLat:46.962402,lLon:9.0368,dur:"0h 6m",dk:"1",sl:"1.5",kmh:"10.0",hd:"599",msa:"1174",ml:"575",hm:"",hg:"",ms:"",mst:"",ge:"Swing HP 927",pa:"",be:"Nichts besonderes."},
"42":{d:"2.2.88",sz:"",lz:"",st:"Brunnenberg",la:"Luchsingen",sLat:46.972376,sLon:9.024163,lLat:46.962402,lLon:9.0368,dur:"0h 5m",dk:"1",sl:"1.5",kmh:"12.0",hd:"599",msa:"1174",ml:"575",hm:"",hg:"",ms:"",mst:"",ge:"Swing HP 927",pa:"",be:"Einen Fehlstart, Leinen in den Steinen."},
"43":{d:"14.2.88",sz:"",lz:"",st:"Rothorn",la:"Valbella See",sLat:46.741949,sLon:9.599242,lLat:46.742593,lLon:9.555272,dur:"0h 17m",dk:"2",sl:"3.4",kmh:"7.1",hd:"1339",msa:"2828",ml:"1489",hm:"",hg:"",ms:"",mst:"",ge:"Swing HP 927",pa:"",be:"Starkwind, schwieriger Start."},
"44":{d:"7.3.88",sz:"",lz:"",st:"Hirzli",la:"westl Ziegelbrücke",sLat:47.134017,sLon:9.007474,lLat:47.13641,lLon:9.04657,dur:"0h 14m",dk:"2.5",sl:"3.0",kmh:"10.7",hd:"1219",msa:"1639",ml:"420",hm:"",hg:"",ms:"",mst:"",ge:"Swing HP 927",pa:"",be:"Bise, nichts besonderes."},
"45":{d:"20.4.88",sz:"",lz:"",st:"Mattstock",la:"Amden",sLat:47.164645,sLon:9.13348,lLat:47.149577,lLon:9.133966,dur:"0h 20m",dk:"1.5",sl:"1.7",kmh:"4.5",hd:"657",msa:"1587",ml:"930",hm:"",hg:"",ms:"",mst:"",ge:"Swing HP 927",pa:"",be:"Längster bisheriger Flug, Gewitter-Stimmung."},
"46":{d:"26.5.88",sz:"",lz:"",st:"Bergsee",la:"Göscheneralpsee",sLat:46.657929,sLon:8.488242,lLat:46.650031,lLon:8.509409,dur:"0h 12m",dk:"1",sl:"1.8",kmh:"5.0",hd:"773",msa:"2331",ml:"1558",hm:"",hg:"",ms:"",mst:"",ge:"Swing HP 927",pa:"",be:"Nichts Besonderes."},
"47":{d:"3.6.88",sz:"",lz:"",st:"Gandschijen Einstieg",la:"Gwüest",sLat:46.660438,sLon:8.514345,lLat:46.651562,lLon:8.518741,dur:"0h 6m",dk:"0.6",sl:"1.0",kmh:"6.0",hd:"536",msa:"2078",ml:"1542",hm:"",hg:"",ms:"",mst:"",ge:"Swing HP 927",pa:"",be:"Nichts besonderes."},
"48":{d:"4.6.88",sz:"",lz:"",st:"Bergsee",la:"Göscheneralpsee",sLat:46.657929,sLon:8.488242,lLat:46.650031,lLon:8.509409,dur:"0h 10m",dk:"1",sl:"1.8",kmh:"6.0",hd:"773",msa:"2331",ml:"1558",hm:"",hg:"",ms:"",mst:"",ge:"Swing HP 927",pa:"",be:"Nichts besonderes, zwei Fehlstarts wegen Steinen, Starthilfe."},
"49":{d:"10.6.88",sz:"",lz:"",st:"Pilatus Matthorn",la:"Alpnachstad",sLat:46.967245,sLon:8.258786,lLat:46.950303,lLon:8.27416,dur:"0h 16m",dk:"2",sl:"2.2",kmh:"7.5",hd:"1161",msa:"1604",ml:"443",hm:"",hg:"",ms:"",mst:"",ge:"Swing HP 927",pa:"",be:"Nichts besonderes."},
"50":{d:"10.6.88",sz:"",lz:"",st:"Rinderalp Stanserhorn",la:"Stans",sLat:46.932059,sLon:8.349781,lLat:46.958829,lLon:8.355504,dur:"0h 14m",dk:"2",sl:"3.0",kmh:"8.6",hd:"1207",msa:"1668",ml:"461",hm:"",hg:"",ms:"",mst:"",ge:"Swing HP 927",pa:"",be:"Landung in der Militärsperrzone."},
"51":{d:"11.6.88",sz:"",lz:"",st:"Niesen",la:"Niesen Heustrich",sLat:46.643722,sLon:7.648312,lLat:46.653213,lLon:7.684247,dur:"0h 18m",dk:"2",sl:"2.9",kmh:"6.7",hd:"1560",msa:"2236",ml:"676",hm:"",hg:"",ms:"",mst:"",ge:"Swing HP 927",pa:"",be:"Nichts besonderes."},
"52":{d:"11.6.88",sz:"",lz:"",st:"Niesen",la:"Niesen Heustrich",sLat:46.643722,sLon:7.648312,lLat:46.653213,lLon:7.684247,dur:"0h 20m",dk:"2",sl:"2.9",kmh:"6.0",hd:"1560",msa:"2236",ml:"676",hm:"",hg:"",ms:"",mst:"",ge:"Swing HP 927",pa:"",be:"Nichts besonderes."},
"53":{d:"26.7.88",sz:"",lz:"",st:"Septumania-Ausstieg Eldorado",la:"Septumania-Einstieg Eldorado",sLat:46.567921,sLon:8.275418,lLat:46.564713,lLon:8.276125,dur:"0h 5m",dk:"0.5",sl:"0.4",kmh:"6.0",hd:"410",msa:"2358",ml:"1948",hm:"",hg:"",ms:"",mst:"",ge:"Swing HP 927",pa:"",be:"Schlechte Thermik, Startplatz heikel."},
"54":{d:"30.7.88",sz:"",lz:"",st:"Ortstock Euloch",la:"Rüti GL",sLat:46.930713,sLon:8.953509,lLat:46.935111,lLon:9.011649,dur:"0h 10m",dk:"4",sl:"4.4",kmh:"25.3",hd:"1442",msa:"2074",ml:"632",hm:"",hg:"",ms:"",mst:"",ge:"Swing HP 927",pa:"",be:"Nichts besonderes, Gipfel in den Wolken. Nichts besonderes."},
"55":{d:"30.7.88",sz:"",lz:"",st:"Hirzli",la:"westl Ziegelbrücke",sLat:47.134017,sLon:9.007474,lLat:47.13641,lLon:9.04657,dur:"0h 11m",dk:"3.5",sl:"3.0",kmh:"20.0",hd:"1219",msa:"1639",ml:"420",hm:"",hg:"",ms:"",mst:"",ge:"Swing HP 927",pa:"",be:"Thermik anfänglich gut, dann Rückenwind."},
"56":{d:"13.8.88",sz:"",lz:"",st:"Fürenalp",la:"Rest Wasserfall",sLat:46.80452,sLon:8.466794,lLat:46.80413,lLon:8.446925,dur:"0h 7m",dk:"1",sl:"1.5",kmh:"8.6",hd:"834",msa:"1903",ml:"1069",hm:"",hg:"",ms:"",mst:"",ge:"Swing HP 927",pa:"",be:"Ein Fehlstart, dann gute Thermik."},
"57":{d:"13.8.88",sz:"",lz:"",st:"Fürenalp",la:"Rest Wasserfall",sLat:46.80452,sLon:8.466794,lLat:46.80413,lLon:8.446925,dur:"0h 6m",dk:"1",sl:"1.5",kmh:"10.0",hd:"834",msa:"1903",ml:"1069",hm:"",hg:"",ms:"",mst:"",ge:"Swing HP 927",pa:"",be:"Wolken, keine Thermik, Landung zweimal bestens."},
"58":{d:"8.9.88",sz:"",lz:"",st:"Niederbauen Chulm",la:"Seelisberg",sLat:46.947569,sLon:8.553211,lLat:46.961426,lLon:8.572091,dur:"0h 6m",dk:"3",sl:"2.1",kmh:"30.0",hd:"1093",msa:"1847",ml:"754",hm:"",hg:"",ms:"",mst:"",ge:"Swing HP 927",pa:"",be:"Zum Teil direkt, einmal ein Klapper."},
"59":{d:"8.9.88",sz:"",lz:"",st:"Niderbauen Hohfad",la:"Emmetten",sLat:46.946807,sLon:8.535172,lLat:46.956062,lLon:8.520278,dur:"0h 5m",dk:"1.7",sl:"1.5",kmh:"18.8",hd:"692",msa:"1458",ml:"766",hm:"",hg:"",ms:"",mst:"",ge:"Swing HP 927",pa:"",be:"Ruhig, problemlosr Start."},
"60":{d:"8.9.88",sz:"",lz:"",st:"Niderbauen Hohfad",la:"Emmetten",sLat:46.946807,sLon:8.535172,lLat:46.956062,lLon:8.520278,dur:"0h 6m",dk:"1.7",sl:"1.5",kmh:"17.7",hd:"692",msa:"1458",ml:"766",hm:"",hg:"",ms:"",mst:"",ge:"Swing HP 927",pa:"",be:"Ruhig, gute Landung, Heike."},
"61":{d:"3.10.88",sz:"",lz:"",st:"Splügen Fluegrind",la:"Splügen West",sLat:46.555699,sLon:9.311452,lLat:46.553898,lLon:9.327851,dur:"0h 4m",dk:"0.5",sl:"1.3",kmh:"6.9",hd:"416",msa:"1866",ml:"1450",hm:"",hg:"",ms:"",mst:"",ge:"Swing HP 927",pa:"",be:"Turbulent, starke Überhöhung, Rückenwind Landung."},
"62":{d:"21.10.88",sz:"",lz:"",st:"Monte Stivo",la:"Bolognano",sLat:45.92112,sLon:10.96188,lLat:45.91905,lLon:10.90602,dur:"0h 11m",dk:"3.5",sl:"4.3",kmh:"19.1",hd:"1566",msa:"1700",ml:"134",hm:"",hg:"",ms:"",mst:"",ge:"Swing HP 927",pa:"",be:"Ruhig, nach langem warten. Landung auf einem Fussballplatz."},
"63":{d:"23.10.88",sz:"",lz:"",st:"Niederbauen Chulm",la:"Emmetten",sLat:46.947569,sLon:8.553211,lLat:46.956062,lLon:8.520278,dur:"0h 9m",dk:"3",sl:"2.7",kmh:"21.2",hd:"1081",msa:"1847",ml:"766",hm:"",hg:"",ms:"",mst:"",ge:"Swing HP 927",pa:"",be:"Ruhig, etwas Abwind beim Flug."},
"64":{d:"23.10.88",sz:"",lz:"",st:"Niderbauen Hohfad",la:"Emmetten",sLat:46.946807,sLon:8.535172,lLat:46.956062,lLon:8.520278,dur:"0h 6m",dk:"1",sl:"1.5",kmh:"10.9",hd:"692",msa:"1458",ml:"766",hm:"",hg:"",ms:"",mst:"",ge:"Swing HP 927",pa:"",be:"Bremse links verhängt, nur Linkskurve möglich."},
"65":{d:"23.10.88",sz:"",lz:"",st:"Niderbauen Hohfad",la:"Emmetten",sLat:46.946807,sLon:8.535172,lLat:46.956062,lLon:8.520278,dur:"0h 6m",dk:"1",sl:"1.5",kmh:"10.0",hd:"692",msa:"1458",ml:"766",hm:"",hg:"",ms:"",mst:"",ge:"Swing HP 927",pa:"",be:"Ruhig, gemütlich."},
"66":{d:"6.11.88",sz:"",lz:"",st:"Gandschijen Einstieg",la:"Gwüest",sLat:46.660438,sLon:8.514345,lLat:46.651562,lLon:8.518741,dur:"0h 4m",dk:"0.6",sl:"1.0",kmh:"9.0",hd:"536",msa:"2078",ml:"1542",hm:"",hg:"",ms:"",mst:"",ge:"Swing HP 927",pa:"",be:"Ruhig, Landung auf Schnee."},
"67":{d:"31.12.88",sz:"",lz:"",st:"Schwarzhorn",la:"Valbella See",sLat:46.76909,sLon:9.594935,lLat:46.742593,lLon:9.555272,dur:"0h 10m",dk:"5.5",sl:"4.2",kmh:"34.7",hd:"1071",msa:"2560",ml:"1489",hm:"",hg:"",ms:"",mst:"",ge:"Swing HP 927",pa:"",be:"Sehr schlechter Skistart, kam knapp über die Kante, Rest ruhig."},
"68":{d:"2.1.89",sz:"",lz:"",st:"Scalottas",la:"Fürstenau",sLat:46.71999,sLon:9.510107,lLat:46.717448,lLon:9.44798,dur:"0h 11m",dk:"4.5",sl:"4.7",kmh:"25.7",hd:"1643",msa:"2295",ml:"652",hm:"",hg:"",ms:"",mst:"",ge:"Swing HP 927",pa:"",be:"Sehr guter Start, dann böig, Landung unauffällig."},
"69":{d:"21.1.89",sz:"",lz:"",st:"Sasauna",la:"Schiers",sLat:47.011379,sLon:9.696928,lLat:46.971908,lLon:9.675889,dur:"0h 11m",dk:"5",sl:"4.7",kmh:"27.3",hd:"1623",msa:"2256",ml:"633",hm:"",hg:"",ms:"",mst:"",ge:"Swing HP 927",pa:"",be:"Skistart, gute Verhältnisse, viel Wind."},
"70":{d:"21.1.89",sz:"",lz:"",st:"Stelli Sasauna",la:"Schiers",sLat:47.003813,sLon:9.700937,lLat:46.971908,lLon:9.675889,dur:"0h 9m",dk:"4",sl:"4.0",kmh:"26.7",hd:"1337",msa:"1970",ml:"633",hm:"",hg:"",ms:"",mst:"",ge:"Swing HP 927",pa:"",be:"Skistart gute Verhältnisse, viel Wind."},
"71":{d:"3.3.89",sz:"",lz:"",st:"Cassons",la:"Foppa Flims",sLat:46.87646,sLon:9.262552,lLat:46.847506,lLon:9.269256,dur:"0h 8m",dk:"4",sl:"3.3",kmh:"30.0",hd:"1018",msa:"2455",ml:"1437",hm:"",hg:"",ms:"",mst:"",ge:"Swing HP 927",pa:"",be:"Windstill, sehr ruhig, Start etwas flach, Landung gut."},
"72":{d:"3.3.89",sz:"",lz:"",st:"Cassons",la:"Flims",sLat:46.87646,sLon:9.262552,lLat:46.835689,lLon:9.281179,dur:"0h 11m",dk:"6",sl:"4.7",kmh:"32.7",hd:"1357",msa:"2455",ml:"1098",hm:"",hg:"",ms:"",mst:"",ge:"Swing HP 927",pa:"",be:"Windstill, guter Start, flog durch kleinste Wolken, Landung gut."},
"73":{d:"6.3.89",sz:"",lz:"",st:"Niderbauen Hohfad",la:"Emmetten",sLat:46.946807,sLon:8.535172,lLat:46.956062,lLon:8.520278,dur:"0h 5m",dk:"2",sl:"1.5",kmh:"24.0",hd:"692",msa:"1458",ml:"766",hm:"",hg:"",ms:"",mst:"",ge:"Swing HP 927",pa:"",be:"Viel Wind, sehr ruhig, Schnee-Start."},
"74":{d:"6.3.89",sz:"",lz:"",st:"Niderbauen Hohfad",la:"Emmetten",sLat:46.946807,sLon:8.535172,lLat:46.956062,lLon:8.520278,dur:"0h 5m",dk:"2",sl:"1.5",kmh:"24.0",hd:"692",msa:"1458",ml:"766",hm:"",hg:"",ms:"",mst:"",ge:"Swing HP 927",pa:"",be:"Üben von engen Kurven, negative Kurven."},
"75":{d:"6.3.89",sz:"",lz:"",st:"Niderbauen Hohfad",la:"Emmetten",sLat:46.946807,sLon:8.535172,lLat:46.956062,lLon:8.520278,dur:"0h 5m",dk:"2",sl:"1.5",kmh:"22.5",hd:"692",msa:"1458",ml:"766",hm:"",hg:"",ms:"",mst:"",ge:"Swing HP 927",pa:"",be:"Kurvenwechsel. Punktlandung mit S-förmigen Kurven, positiv, sehr warm."},
"76":{d:"6.3.89",sz:"",lz:"",st:"Niderbauen Hohfad",la:"Emmetten",sLat:46.946807,sLon:8.535172,lLat:46.956062,lLon:8.520278,dur:"0h 5m",dk:"2",sl:"1.5",kmh:"22.5",hd:"692",msa:"1458",ml:"766",hm:"",hg:"",ms:"",mst:"",ge:"Swing HP 927",pa:"",be:"Kurvenwechsel. Punktlandung mit S-förmigen Kurven, positiv, sehr warm."},
"77":{d:"6.3.89",sz:"",lz:"",st:"Niderbauen Hohfad",la:"Emmetten",sLat:46.946807,sLon:8.535172,lLat:46.956062,lLon:8.520278,dur:"0h 6m",dk:"2",sl:"1.5",kmh:"21.2",hd:"692",msa:"1458",ml:"766",hm:"",hg:"",ms:"",mst:"",ge:"Swing HP 927",pa:"",be:"Kurvenwechsel. Punktlandung mit S-förmigen Kurven, positiv, sehr warm."},
"78":{d:"6.3.89",sz:"",lz:"",st:"Niderbauen Hohfad",la:"Emmetten",sLat:46.946807,sLon:8.535172,lLat:46.956062,lLon:8.520278,dur:"0h 5m",dk:"2",sl:"1.5",kmh:"22.5",hd:"692",msa:"1458",ml:"766",hm:"",hg:"",ms:"",mst:"",ge:"Swing HP 927",pa:"",be:"Kurvenwechsel. Punktlandung mit S-förmigen Kurven, positiv, sehr warm."},
"79":{d:"6.3.89",sz:"",lz:"",st:"Niderbauen Hohfad",la:"Emmetten",sLat:46.946807,sLon:8.535172,lLat:46.956062,lLon:8.520278,dur:"0h 6m",dk:"2",sl:"1.5",kmh:"21.2",hd:"692",msa:"1458",ml:"766",hm:"",hg:"",ms:"",mst:"",ge:"Swing HP 927",pa:"",be:"Kurvenwechsel. Punktlandung mit S-förmigen Kurven, positiv, sehr warm."},
"80":{d:"6.3.89",sz:"",lz:"",st:"Niderbauen Hohfad",la:"Emmetten",sLat:46.946807,sLon:8.535172,lLat:46.956062,lLon:8.520278,dur:"0h 5m",dk:"2",sl:"1.5",kmh:"24.0",hd:"692",msa:"1458",ml:"766",hm:"",hg:"",ms:"",mst:"",ge:"Swing HP 927",pa:"",be:"Kurvenwechsel. Punktlandung mit S-förmigen Kurven, positiv, sehr warm."},
"81":{d:"20.5.89",sz:"",lz:"",st:"Vilan",la:"Malans",sLat:47.011083,sLon:9.603546,lLat:46.97029,lLon:9.569575,dur:"0h 16m",dk:"3.5",sl:"5.2",kmh:"13.5",hd:"1806",msa:"2339",ml:"533",hm:"",hg:"",ms:"",mst:"",ge:"Swing HP 927",pa:"",be:"Es steigt gut über den Grad, viel Spass, Landung böig."},
"82":{d:"20.5.89",sz:"",lz:"",st:"Vilan Westgrat",la:"Malans",sLat:47.00861,sLon:9.599631,lLat:46.97029,lLon:9.569575,dur:"0h 10m",dk:"3",sl:"4.8",kmh:"18.9",hd:"1806",msa:"2339",ml:"533",hm:"",hg:"",ms:"",mst:"",ge:"Swing HP 927",pa:"",be:"Start mit Hilfe bei wenig Wind, sehr böig."},
"83":{d:"18.6.89",sz:"",lz:"",st:"Ober Sädel Hedmannegg",la:"Unterschächen",sLat:46.881254,sLon:8.800526,lLat:46.86359,lLon:8.77396,dur:"0h 10m",dk:"5",sl:"2.8",kmh:"31.6",hd:"1216",msa:"2220",ml:"1004",hm:"",hg:"",ms:"",mst:"",ge:"Swing HP 927",pa:"",be:"Gewitter, Böen. Landung gut."},
"84":{d:"29.7.89",sz:"",lz:"",st:"Hirzli",la:"Niederurnen",sLat:47.134017,sLon:9.007474,lLat:47.130312,lLon:9.052873,dur:"0h 9m",dk:"3.5",sl:"3.5",kmh:"24.7",hd:"1220",msa:"1639",ml:"419",hm:"",hg:"",ms:"",mst:"",ge:"Swing HP 927",pa:"",be:"Starkwind-Start, ruhiger Flug ohne Thermik."},
"85":{d:"10.9.89",sz:"",lz:"",st:"Schinige Platte",la:"Wilderswil",sLat:46.651096,sLon:7.908704,lLat:46.661931,lLon:7.868843,dur:"0h 10m",dk:"3",sl:"3.3",kmh:"18.0",hd:"1384",msa:"1971",ml:"587",hm:"",hg:"",ms:"",mst:"",ge:"Swing HP 927",pa:"",be:"Einmal voller Klapper, dann Gegenwind, Ort nicht erreicht."},
"86":{d:"12.10.89",sz:"",lz:"",st:"Niderbauen Hohfad",la:"Emmetten",sLat:46.946807,sLon:8.535172,lLat:46.956062,lLon:8.520278,dur:"0h 5m",dk:"2",sl:"1.5",kmh:"22.5",hd:"692",msa:"1458",ml:"766",hm:"",hg:"",ms:"",mst:"",ge:"Swing HP 927",pa:"",be:"Start im Schnee, leichte Rückenwind, kalt, viele Flugschüler."},
"87":{d:"12.10.89",sz:"",lz:"",st:"Niderbauen Hohfad",la:"Emmetten",sLat:46.946807,sLon:8.535172,lLat:46.956062,lLon:8.520278,dur:"0h 5m",dk:"2",sl:"1.5",kmh:"22.5",hd:"692",msa:"1458",ml:"766",hm:"",hg:"",ms:"",mst:"",ge:"Swing HP 927",pa:"",be:"Enge Kurven, aber Schirm zu langsam, langweilig."},
"88":{d:"28.11.89",sz:"",lz:"",st:"Schibechopf Chalbersäntis",la:"Thurwis",sLat:47.239802,sLon:9.351436,lLat:47.22786,lLon:9.331434,dur:"0h 4m",dk:"2.3",sl:"2.0",kmh:"34.5",hd:"674",msa:"1877",ml:"1203",hm:"",hg:"",ms:"",mst:"",ge:"Swing HP 927",pa:"",be:"Ostwind, deshalb Abstieg, ein Fehlstart."},
"89":{d:"2.12.89",sz:"",lz:"",st:"Gemsstock",la:"Andermatt",sLat:46.601777,sLon:8.610564,lLat:46.630843,lLon:8.589515,dur:"0h 9m",dk:"3.7",sl:"3.6",kmh:"24.7",hd:"1466",msa:"2900",ml:"1434",hm:"",hg:"",ms:"",mst:"",ge:"Swing HP 927",pa:"",be:"Start im Schnee, flach, wenig Rückenwind, leicht."},
"90":{d:"2.12.89",sz:"",lz:"",st:"Gemsstock",la:"Andermatt",sLat:46.601777,sLon:8.610564,lLat:46.630843,lLon:8.589515,dur:"0h 10m",dk:"3.7",sl:"3.6",kmh:"22.2",hd:"1466",msa:"2900",ml:"1434",hm:"",hg:"",ms:"",mst:"",ge:"Swing HP 927",pa:"",be:"Start im Schnee, wenig Rückenwind, leicht."},
"91":{d:"2.12.89",sz:"",lz:"",st:"Gemsstock",la:"Andermatt",sLat:46.601777,sLon:8.610564,lLat:46.630843,lLon:8.589515,dur:"0h 12m",dk:"3.7",sl:"3.6",kmh:"18.5",hd:"1466",msa:"2900",ml:"1434",hm:"",hg:"",ms:"",mst:"",ge:"Swing HP 927",pa:"",be:"Skistart. Steiler Hang, gute Thermik, super."},
"92":{d:"2.12.89",sz:"",lz:"",st:"Gemsstock",la:"Andermatt",sLat:46.601777,sLon:8.610564,lLat:46.630843,lLon:8.589515,dur:"0h 10m",dk:"3.7",sl:"3.6",kmh:"22.2",hd:"1466",msa:"2900",ml:"1434",hm:"",hg:"",ms:"",mst:"",ge:"Swing HP 927",pa:"",be:"Skistart, normaler Startplatz, super."},
"93":{d:"10.12.89",sz:"",lz:"",st:"Ochsenalp A Heim",la:"Realp",sLat:46.598574,sLon:8.47811,lLat:46.601267,lLon:8.50595,dur:"0h 5m",dk:"1.6",sl:"2.1",kmh:"19.2",hd:"742",msa:"2291",ml:"1549",hm:"",hg:"",ms:"",mst:"",ge:"Swing HP 927",pa:"",be:"Skistart, Rückenwind, Flug ruhig. Landung gut."},
"94":{d:"29.12.89",sz:"",lz:"",st:"Rothorn",la:"Valbella See",sLat:46.741949,sLon:9.599242,lLat:46.742593,lLon:9.555272,dur:"0h 9m",dk:"2.5",sl:"3.4",kmh:"17.6",hd:"1339",msa:"2828",ml:"1489",hm:"",hg:"",ms:"",mst:"",ge:"Swing HP 927",pa:"",be:"Leichter Rückenwind, Geröll, Rest ist unauffällig"},
"95":{d:"29.12.89",sz:"",lz:"",st:"Scalottas",la:"Thusis",sLat:46.71999,sLon:9.510107,lLat:46.707573,lLon:9.442549,dur:"0h 12m",dk:"5.5",sl:"5.3",kmh:"28.7",hd:"1620",msa:"2295",ml:"675",hm:"",hg:"",ms:"",mst:"",ge:"Swing HP 927",pa:"",be:"Bester Südwind, Termin super."},
"96":{d:"31.12.89",sz:"",lz:"",st:"Scalottas",la:"Thusis",sLat:46.71999,sLon:9.510107,lLat:46.707573,lLon:9.442549,dur:"0h 13m",dk:"5.5",sl:"5.3",kmh:"26.4",hd:"1620",msa:"2295",ml:"675",hm:"",hg:"",ms:"",mst:"",ge:"Swing HP 927",pa:"",be:"Guter Südwind, noch bessere Termin, toll."},
"97":{d:"1.1.90",sz:"",lz:"",st:"Scalottas",la:"Thusis",sLat:46.71999,sLon:9.510107,lLat:46.707573,lLon:9.442549,dur:"0h 15m",dk:"6",sl:"5.3",kmh:"24.0",hd:"1620",msa:"2295",ml:"675",hm:"",hg:"",ms:"",mst:"",ge:"AdK Genair 312D",pa:"",be:"Erstmals mit Gennair, Start super, etwas flach, falsch eingehängt, vorsichtig."},
"98":{d:"16.2.90",sz:"",lz:"",st:"Parsenn Mitte",la:"Davos",sLat:46.820032,sLon:9.825805,lLat:46.804669,lLon:9.842136,dur:"0h 5m",dk:"2",sl:"2.1",kmh:"24.0",hd:"643",msa:"2194",ml:"1551",hm:"",hg:"",ms:"",mst:"",ge:"Swing HP 927",pa:"",be:"Sehr schlechter Start mit den Ski, dann ruhig."},
"99":{d:"16.2.90",sz:"",lz:"",st:"Jakobshorn Gipfel N",la:"Davos Jakobshorn Winter",sLat:46.772689,sLon:9.84663,lLat:46.78741,lLon:9.817978,dur:"0h 12m",dk:"5",sl:"2.7",kmh:"25.0",hd:"992",msa:"2524",ml:"1532",hm:"",hg:"",ms:"",mst:"",ge:"Swing HP 927",pa:"",be:"Guter Starkwind, Rest ruhig."},
"100":{d:"4.3.90",sz:"",lz:"",st:"Titlis",la:"Engelberg Örtli",sLat:46.777229,sLon:8.432934,lLat:46.816954,lLon:8.415308,dur:"0h 12m",dk:"6",sl:"4.6",kmh:"30.0",hd:"1904",msa:"2916",ml:"1012",hm:"",hg:"",ms:"",mst:"",ge:"Swing HP 927",pa:"",be:"Fehlstart, gefährlich. Dann Rückenwind. Ruhiger Flug."},
"101":{d:"22.4.90",sz:"",lz:"",st:"Brunnenberg",la:"Luchsingen",sLat:46.972376,sLon:9.024163,lLat:46.962402,lLon:9.0368,dur:"0h 7m",dk:"1",sl:"1.5",kmh:"8.6",hd:"599",msa:"1174",ml:"575",hm:"",hg:"",ms:"",mst:"",ge:"Firebird Twist",pa:"",be:"Neuer Schirm, Start gut, ruhiger Flug. Träge."},
"102":{d:"22.4.90",sz:"",lz:"",st:"Brunnenberg",la:"Luchsingen",sLat:46.972376,sLon:9.024163,lLat:46.962402,lLon:9.0368,dur:"0h 9m",dk:"1",sl:"1.5",kmh:"6.7",hd:"599",msa:"1174",ml:"575",hm:"",hg:"",ms:"",mst:"",ge:"AdK Genair 24",pa:"",be:"Neuer Schirm, Start gut, Flug ruhig, wendig."},
"103":{d:"2.5.90",sz:"",lz:"",st:"Niderbauen Hohfad",la:"Emmetten",sLat:46.946807,sLon:8.535172,lLat:46.956062,lLon:8.520278,dur:"0h 8m",dk:"1",sl:"1.5",kmh:"7.7",hd:"692",msa:"1458",ml:"766",hm:"",hg:"",ms:"",mst:"",ge:"Swing HP 927",pa:"",be:"Ruhig, keine Thermik."},
"104":{d:"2.5.90",sz:"",lz:"",st:"Niderbauen Hohfad",la:"Emmetten",sLat:46.946807,sLon:8.535172,lLat:46.956062,lLon:8.520278,dur:"0h 8m",dk:"1",sl:"1.5",kmh:"7.3",hd:"692",msa:"1458",ml:"766",hm:"",hg:"",ms:"",mst:"",ge:"Swing HP 927",pa:"",be:"Ruhig, keine Thermik."},
"105":{d:"2.5.90",sz:"",lz:"",st:"Niderbauen Hohfad",la:"Emmetten",sLat:46.946807,sLon:8.535172,lLat:46.956062,lLon:8.520278,dur:"0h 10m",dk:"1",sl:"1.5",kmh:"6.3",hd:"692",msa:"1458",ml:"766",hm:"",hg:"",ms:"",mst:"",ge:"Swing HP 927",pa:"",be:"Leichter Thermik zu Beginn."},
"106":{d:"2.5.90",sz:"",lz:"",st:"Niderbauen Hohfad",la:"Emmetten",sLat:46.946807,sLon:8.535172,lLat:46.956062,lLon:8.520278,dur:"0h 19m",dk:"1",sl:"1.5",kmh:"3.2",hd:"692",msa:"1458",ml:"766",hm:"",hg:"",ms:"",mst:"",ge:"Swing HP 927",pa:"",be:"Soaring an der westlichen Kante, tolle Schläuche. Schirm macht sicheren Eindruck."},
"107":{d:"3.5.90",sz:"",lz:"",st:"Fürenalp",la:"Rest Wasserfall",sLat:46.80452,sLon:8.466794,lLat:46.80413,lLon:8.446925,dur:"0h 14m",dk:"1",sl:"1.5",kmh:"4.4",hd:"834",msa:"1903",ml:"1069",hm:"",hg:"",ms:"",mst:"",ge:"Swing HP 927",pa:"",be:"ruppige Thermik, leichte Aufwinde, kein Einklappen."},
"108":{d:"3.5.90",sz:"",lz:"",st:"Fürenalp",la:"Engelberg Kloster",sLat:46.80452,sLon:8.466794,lLat:46.821035,lLon:8.411569,dur:"0h 16m",dk:"1",sl:"4.6",kmh:"3.8",hd:"871",msa:"1903",ml:"1032",hm:"",hg:"",ms:"",mst:"",ge:"Swing HP 927",pa:"",be:"ruppige Thermik, leichte Aufwinde, kein Einklappen, kein Klapper. Der Schirm ist langsam."},
"109":{d:"13.5.90",sz:"",lz:"",st:"Unterstaffel Fronalpstock",la:"Mollis",sLat:47.07228,sLon:9.091606,lLat:47.083733,lLon:9.068961,dur:"0h 7m",dk:"2",sl:"2.1",kmh:"17.1",hd:"890",msa:"1332",ml:"442",hm:"",hg:"",ms:"",mst:"",ge:"Swing HP 927",pa:"",be:"Ruhig, etwas flacher Start."},
"110":{d:"13.5.90",sz:"",lz:"",st:"Unterstaffel Fronalpstock",la:"Mollis",sLat:47.07228,sLon:9.091606,lLat:47.083733,lLon:9.068961,dur:"0h 8m",dk:"2",sl:"2.1",kmh:"15.0",hd:"890",msa:"1332",ml:"442",hm:"",hg:"",ms:"",mst:"",ge:"Swing HP 927",pa:"",be:"Leichte Thermik, flacher Start."},
"111":{d:"17.6.90",sz:"",lz:"",st:"Hirzli",la:"Niederurnen",sLat:47.134017,sLon:9.007474,lLat:47.130312,lLon:9.052873,dur:"0h 9m",dk:"3.5",sl:"3.5",kmh:"22.5",hd:"1220",msa:"1639",ml:"419",hm:"",hg:"",ms:"",mst:"",ge:"Swing HP 927",pa:"",be:"Super Thermik am Starthang, aus Zeitmangel rascher Abstieg."},
"112":{d:"30.5.90",sz:"",lz:"",st:"Hirzli",la:"Niederurnen",sLat:47.134017,sLon:9.007474,lLat:47.130312,lLon:9.052873,dur:"0h 8m",dk:"3.5",sl:"3.5",kmh:"25.4",hd:"1220",msa:"1639",ml:"419",hm:"",hg:"",ms:"",mst:"",ge:"Swing HP 927",pa:"",be:"Ruhig, keine Thermik, ein Fehlstart, etwas zu langsam."},
"113":{d:"1.6.90",sz:"",lz:"",st:"Chamm Näbelchäppler",la:"Klöntal Plätz",sLat:47.00793,sLon:8.946246,lLat:47.023479,lLon:8.942591,dur:"0h 9m",dk:"4",sl:"1.8",kmh:"27.7",hd:"1285",msa:"2135",ml:"850",hm:"",hg:"",ms:"",mst:"",ge:"Swing HP 927",pa:"",be:"Westwind, ruppige Thermik, kein ausnutzen der Thermik, Landung böig."},
"114":{d:"4.6.90",sz:"",lz:"",st:"La Berneuse",la:"Leysin",sLat:46.35989,sLon:7.001169,lLat:46.348617,lLon:7.022292,dur:"0h 6m",dk:"2",sl:"2.0",kmh:"20.0",hd:"743",msa:"2020",ml:"1277",hm:"",hg:"",ms:"",mst:"",ge:"AdK Genair 512",pa:"",be:"Schwerer Rucksack, Start gut, Flug ruhig."},
"115":{d:"31.1.91",sz:"",lz:"",st:"Wasserngrat",la:"Gstaad",sLat:46.458117,sLon:7.323973,lLat:46.461478,lLon:7.283313,dur:"0h 5m",dk:"2",sl:"3.1",kmh:"24.0",hd:"856",msa:"1905",ml:"1049",hm:"",hg:"",ms:"",mst:"",ge:"Swing HP 927",pa:"",be:"Start auf der Skipiste, ruhig, erster Flug seit sechs Monaten."},
"116":{d:"24.2.91",sz:"",lz:"",st:"Stärnen",la:"Weglosen",sLat:46.99956,sLon:8.800412,lLat:47.019846,lLon:8.810372,dur:"0h 5m",dk:"2",sl:"2.4",kmh:"24.0",hd:"818",msa:"1855",ml:"1037",hm:"",hg:"",ms:"",mst:"",ge:"Swing HP 927",pa:"",be:"Start mit Ski, langweilig."},
"117":{d:"2.3.91",sz:"",lz:"",st:"Ebenalp",la:"Wasserauen",sLat:47.285089,sLon:9.411555,lLat:47.283661,lLon:9.427079,dur:"0h 7m",dk:"2",sl:"1.2",kmh:"17.1",hd:"707",msa:"1582",ml:"875",hm:"",hg:"",ms:"",mst:"",ge:"Swing Zenith 23",pa:"",be:"Flacher Start, Flug ruhig, Sicherheitsflug, Landung gut."},
"118":{d:"2.3.91",sz:"",lz:"",st:"Ebenalp",la:"Wasserauen",sLat:47.285089,sLon:9.411555,lLat:47.283661,lLon:9.427079,dur:"0h 8m",dk:"2",sl:"1.2",kmh:"15.0",hd:"707",msa:"1582",ml:"875",hm:"",hg:"",ms:"",mst:"",ge:"Swing Zenith 23",pa:"",be:"Ein Fehlstart, gemütlich, Landung gut."},
"119":{d:"28.3.91",sz:"",lz:"",st:"Ebenalp",la:"Wasserauen",sLat:47.285089,sLon:9.411555,lLat:47.283661,lLon:9.427079,dur:"0h 8m",dk:"2",sl:"1.2",kmh:"15.0",hd:"707",msa:"1582",ml:"875",hm:"",hg:"",ms:"",mst:"",ge:"Swing Zenith 23",pa:"",be:"Deutliche Bise, schöner Start, Fluggefühl etwas unsicher."},
"120":{d:"1.4.91",sz:"",lz:"",st:"La Berneuse",la:"Aigle",sLat:46.35989,sLon:7.001169,lLat:46.327421,lLon:6.951773,dur:"0h 22m",dk:"6",sl:"5.2",kmh:"16.4",hd:"1629",msa:"2020",ml:"391",hm:"",hg:"",ms:"",mst:"",ge:"Swing Zenith 23",pa:"",be:"Ruhig, im Tal luftig, gute Landung."},
"121":{d:"2.4.91",sz:"",lz:"",st:"Niderbauen Hohfad",la:"Emmetten",sLat:46.946807,sLon:8.535172,lLat:46.956062,lLon:8.520278,dur:"0h 8m",dk:"1",sl:"1.5",kmh:"7.5",hd:"692",msa:"1458",ml:"766",hm:"",hg:"",ms:"",mst:"",ge:"Swing Zenith 23",pa:"",be:"Ein Fehlstart, zu langsam. Landung gut, Flug gut."},
"122":{d:"2.4.91",sz:"",lz:"",st:"Niderbauen Hohfad",la:"Emmetten",sLat:46.946807,sLon:8.535172,lLat:46.956062,lLon:8.520278,dur:"0h 8m",dk:"1",sl:"1.5",kmh:"7.5",hd:"692",msa:"1458",ml:"766",hm:"",hg:"",ms:"",mst:"",ge:"Swing Zenith 23",pa:"",be:"Trimmer lösen, weite Spirale, 80 % Bremse."},
"123":{d:"2.4.91",sz:"",lz:"",st:"Niderbauen Hohfad",la:"Emmetten",sLat:46.946807,sLon:8.535172,lLat:46.956062,lLon:8.520278,dur:"0h 6m",dk:"1",sl:"1.5",kmh:"10.0",hd:"692",msa:"1458",ml:"766",hm:"",hg:"",ms:"",mst:"",ge:"Swing Zenith 23",pa:"",be:"90 % Bremse, ohne Trimmer, Spirale weit."},
"124":{d:"2.4.91",sz:"",lz:"",st:"Niderbauen Hohfad",la:"Emmetten",sLat:46.946807,sLon:8.535172,lLat:46.956062,lLon:8.520278,dur:"0h 6m",dk:"1",sl:"1.5",kmh:"10.0",hd:"692",msa:"1458",ml:"766",hm:"",hg:"",ms:"",mst:"",ge:"Swing Zenith 23",pa:"",be:"Zwei Fehlstarts, wahrscheinlich zu stark angebremst und zu langsam."},
"125":{d:"2.4.91",sz:"",lz:"",st:"Eggberge",la:"Flüelen Schiessplatz",sLat:46.904141,sLon:8.651741,lLat:46.898856,lLon:8.622077,dur:"0h 20m",dk:"2",sl:"2.3",kmh:"6.0",hd:"1132",msa:"1567",ml:"435",hm:"",hg:"",ms:"",mst:"",ge:"Swing Zenith 23",pa:"",be:"ruppige Thermik, anfangs mit Startüberhöhung, Landung auf Schiessplatz."},
"126":{d:"31.5.91",sz:"",lz:"",st:"Ebenalp",la:"Wasserauen",sLat:47.285089,sLon:9.411555,lLat:47.283661,lLon:9.427079,dur:"0h 15m",dk:"2",sl:"1.2",kmh:"8.0",hd:"707",msa:"1582",ml:"875",hm:"",hg:"",ms:"",mst:"",ge:"Swing Zenith 23",pa:"",be:"Nichts los, Landung im Lee auf Auto und Zaun."},
"127":{d:"31.5.91",sz:"",lz:"",st:"Hoher Kasten",la:"Brülisau",sLat:47.286609,sLon:9.486389,lLat:47.296598,lLon:9.458786,dur:"1h 10m",dk:"3.5",sl:"2.4",kmh:"3.0",hd:"743",msa:"1671",ml:"928",hm:"",hg:"",ms:"",mst:"",ge:"Swing Zenith 23",pa:"",be:"Rekord, friedliches Soaring am Abend nach 20:00 Uhr, Start mit Rückenwind."},
"128":{d:"1.6.91",sz:"",lz:"",st:"Rinderalp Stanserhorn",la:"Stans",sLat:46.932059,sLon:8.349781,lLat:46.958829,lLon:8.355504,dur:"1h 5m",dk:"3.5",sl:"3.0",kmh:"3.2",hd:"1207",msa:"1668",ml:"461",hm:"",hg:"",ms:"",mst:"",ge:"Swing Zenith 23",pa:"",be:"Circa 50 GS, gute Thermik, über Stans. Kaum Sinken."},
"129":{d:"9.6.91",sz:"",lz:"",st:"Haldigrat",la:"Dallenwil Talstation",sLat:46.90236,sLon:8.440603,lLat:46.928525,lLon:8.395852,dur:"0h 13m",dk:"4",sl:"4.5",kmh:"18.5",hd:"1438",msa:"1938",ml:"500",hm:"",hg:"",ms:"",mst:"",ge:"Swing Zenith 23",pa:"",be:"Nieselregen, gute Startmöglichkeiten, starker Talwind, absaufen."},
"130":{d:"28.7.91",sz:"",lz:"",st:"Rinderalp Stanserhorn",la:"Stans",sLat:46.932059,sLon:8.349781,lLat:46.958829,lLon:8.355504,dur:"0h 15m",dk:"3.5",sl:"3.0",kmh:"14.0",hd:"1207",msa:"1668",ml:"461",hm:"",hg:"",ms:"",mst:"",ge:"Swing Zenith 23",pa:"",be:"Am Start Wolken, dann mässig. Klapper. Bise, Böen. Zu kurz."},
"131":{d:"16.8.91",sz:"",lz:"",st:"Hirzli",la:"Niederurnen",sLat:47.134017,sLon:9.007474,lLat:47.130312,lLon:9.052873,dur:"0h 10m",dk:"3.5",sl:"3.5",kmh:"22.1",hd:"1220",msa:"1639",ml:"419",hm:"",hg:"",ms:"",mst:"",ge:"Swing Zenith 23",pa:"",be:"Feierabend Flug, ruhig, gemütlich."},
"132":{d:"27.10.91",sz:"",lz:"",st:"Brunni Schonegg",la:"Engelberg Kloster",sLat:46.847399,sLon:8.420397,lLat:46.821035,lLon:8.411569,dur:"0h 10m",dk:"2",sl:"3.0",kmh:"12.0",hd:"889",msa:"1921",ml:"1032",hm:"",hg:"",ms:"",mst:"",ge:"Swing Zenith 23",pa:"",be:"Ruhig, provozierter Klapper, leichte Spirale, Landung etwas weit."},
"133":{d:"27.10.91",sz:"",lz:"",st:"Brunni Schonegg",la:"Engelberg Kloster",sLat:46.847399,sLon:8.420397,lLat:46.821035,lLon:8.411569,dur:"0h 9m",dk:"2",sl:"3.0",kmh:"13.3",hd:"889",msa:"1921",ml:"1032",hm:"",hg:"",ms:"",mst:"",ge:"Swing Zenith 23",pa:"",be:"Ruhig, kein Wind, Spirale, Landung gut."},
"134":{d:"30.11.91",sz:"",lz:"",st:"Brunni Schonegg",la:"Engelberg Kloster",sLat:46.847399,sLon:8.420397,lLat:46.821035,lLon:8.411569,dur:"0h 10m",dk:"2",sl:"3.0",kmh:"12.0",hd:"889",msa:"1921",ml:"1032",hm:"",hg:"",ms:"",mst:"",ge:"Swing Zenith 23",pa:"",be:"Beste Verhältnisse, ruhig, Landung zu weit."},
"135":{d:"30.11.91",sz:"",lz:"",st:"Brunni Schonegg",la:"Engelberg Kloster",sLat:46.847399,sLon:8.420397,lLat:46.821035,lLon:8.411569,dur:"0h 9m",dk:"2",sl:"3.0",kmh:"13.3",hd:"889",msa:"1921",ml:"1032",hm:"",hg:"",ms:"",mst:"",ge:"Swing Zenith 23",pa:"",be:"Viel Verkehr, Klapper, Spirale, Punktlandung."},
"136":{d:"15.12.91",sz:"",lz:"",st:"Ebenalp",la:"Wasserauen",sLat:47.285089,sLon:9.411555,lLat:47.283661,lLon:9.427079,dur:"0h 6m",dk:"1.5",sl:"1.2",kmh:"15.0",hd:"707",msa:"1582",ml:"875",hm:"",hg:"",ms:"",mst:"",ge:"Swing Zenith 23",pa:"",be:"Kein Wind, ruhig, Spirale, Landung gut."},
"137":{d:"15.12.91",sz:"",lz:"",st:"Ebenalp",la:"Weissbad",sLat:47.285089,sLon:9.411555,lLat:47.309188,lLon:9.437422,dur:"0h 7m",dk:"3.5",sl:"3.3",kmh:"30.0",hd:"761",msa:"1582",ml:"821",hm:"",hg:"",ms:"",mst:"",ge:"Swing Zenith 23",pa:"",be:"Gleitflug mit 1/2 Trimmer, ruhig, kein Wind."},
"138":{d:"22.2.92",sz:"",lz:"",st:"Titlis Gipfel",la:"Engelberg Festi",sLat:46.77258,sLon:8.42956,lLat:46.819428,lLon:8.416415,dur:"0h 18m",dk:"4",sl:"5.3",kmh:"13.3",hd:"2033",msa:"3050",ml:"1017",hm:"",hg:"",ms:"",mst:"",ge:"Swing Zenith 23",pa:"",be:"Ruhiger, alpiner Start, Erste Versuche mit B-Stall, in Ordnung."},
"139":{d:"22.2.92",sz:"",lz:"",st:"Titlis Gipfel",la:"Grafenort",sLat:46.77258,sLon:8.42956,lLat:46.868709,lLon:8.372214,dur:"0h 27m",dk:"12",sl:"11.5",kmh:"26.7",hd:"2481",msa:"3050",ml:"569",hm:"",hg:"",ms:"",mst:"",ge:"Swing Zenith 23",pa:"",be:"Ruhig, Gleitflug. Rekord bezüglich Strecke und Höhendifferenz."},
"140":{d:"25.4.92",sz:"",lz:"",st:"Planpraz Le Brévent",la:"Chamonix",sLat:45.93527,sLon:6.853072,lLat:45.927718,lLon:6.867874,dur:"0h 40m",dk:"1",sl:"1.4",kmh:"1.5",hd:"908",msa:"1955",ml:"1047",hm:"",hg:"",ms:"",mst:"",ge:"Swing Zenith 23",pa:"",be:"Beste thermische Verhältnisse, Problem, um runterzukommen."},
"141":{d:"24.5.92",sz:"",lz:"",st:"Rotenflue SW Sommer",la:"Rickenbach",sLat:47.017641,sLon:8.700727,lLat:47.012549,lLon:8.67004,dur:"0h 25m",dk:"2.5",sl:"2.4",kmh:"6.0",hd:"928",msa:"1518",ml:"590",hm:"",hg:"",ms:"",mst:"",ge:"Swing Zenith 23",pa:"",be:"Enge zerrissene Thermik , Überentwicklung, keine Überhöhung."},
"142":{d:"24.5.92",sz:"",lz:"",st:"Rotenflue SW Sommer",la:"Schwyz",sLat:47.017641,sLon:8.700727,lLat:47.023325,lLon:8.661776,dur:"0h 18m",dk:"4",sl:"3.0",kmh:"13.3",hd:"940",msa:"1518",ml:"578",hm:"",hg:"",ms:"",mst:"",ge:"Swing Zenith 23",pa:"",be:"Kurze Überhöhung, dann im Gegenwind nach Schwyz. Vier Startversuche."},
"143":{d:"28.5.92",sz:"",lz:"",st:"Vilan Messhaldenspitz",la:"Schiers",sLat:47.016904,sLon:9.594019,lLat:46.971908,lLon:9.675889,dur:"0h 36m",dk:"8.5",sl:"8.0",kmh:"14.2",hd:"1510",msa:"2143",ml:"633",hm:"",hg:"",ms:"",mst:"",ge:"Swing Zenith 23",pa:"",be:"Startüberhöhung, bis zum Hauptgipfel, Wolken, dann Rückenwind-Gleiten."},
"144":{d:"18.7.92",sz:"",lz:"",st:"Haglere",la:"Sörenberg",sLat:46.835904,sLon:8.042488,lLat:46.815688,lLon:8.044738,dur:"0h 12m",dk:"2.5",sl:"2.3",kmh:"12.5",hd:"740",msa:"1914",ml:"1174",hm:"",hg:"",ms:"",mst:"",ge:"Swing Zenith 23",pa:"",be:"Guter Wind beim Start, steil, sonst ruhig."},
"145":{d:"19.7.92",sz:"",lz:"",st:"Chalbersäntis",la:"Chüeboden",sLat:47.244842,sLon:9.349172,lLat:47.211178,lLon:9.312794,dur:"0h 20m",dk:"4.5",sl:"4.6",kmh:"13.5",hd:"1300",msa:"2343",ml:"1043",hm:"",hg:"",ms:"",mst:"",ge:"Swing Zenith 23",pa:"",be:"Guter Startwind, ging aber gar nichts, Lee"},
"146":{d:"19.7.92",sz:"",lz:"",st:"Hinderrugg",la:"Walenstadt",sLat:47.153731,sLon:9.303897,lLat:47.123602,lLon:9.307514,dur:"0h 18m",dk:"3.5",sl:"3.4",kmh:"11.7",hd:"1861",msa:"2285",ml:"424",hm:"",hg:"",ms:"",mst:"",ge:"Swing Zenith 23",pa:"",be:"Ruhig, Genussflug, etwas tief bei der Landung."},
"147":{d:"8.8.92",sz:"",lz:"",st:"Cassons",la:"Flims",sLat:46.87646,sLon:9.262552,lLat:46.835689,lLon:9.281179,dur:"0h 55m",dk:"3",sl:"4.7",kmh:"3.3",hd:"1357",msa:"2455",ml:"1098",hm:"",hg:"",ms:"",mst:"",ge:"Swing Zenith 23",pa:"",be:"Böiger Starkwind beim Start, viele Versuche, ein paar Klapper, super."},
"148":{d:"13.12.92",sz:"",lz:"",st:"Vounetse",la:"Charmey",sLat:46.625426,sLon:7.206223,lLat:46.617845,lLon:7.170263,dur:"0h 6m",dk:"3",sl:"2.9",kmh:"30.0",hd:"735",msa:"1608",ml:"873",hm:"",hg:"",ms:"",mst:"",ge:"Swing Zenith 23",pa:"",be:"Kein Wind,, leichte Wolken. Landung gut."},
"149":{d:"16.1.93",sz:"",lz:"",st:"Ruogig",la:"Flüelen Allmend",sLat:46.908962,sLon:8.692741,lLat:46.898249,lLon:8.619833,dur:"0h 14m",dk:"6",sl:"5.7",kmh:"25.7",hd:"1511",msa:"1948",ml:"437",hm:"",hg:"",ms:"",mst:"",ge:"Swing Zenith 23",pa:"",be:"Beim Start durch Gebüsch , dann super, ruhig."},
"150":{d:"13.2.93",sz:"",lz:"",st:"Gumengrat",la:"Linthal",sLat:46.959564,sLon:8.987319,lLat:46.931729,lLon:9.008976,dur:"0h 25m",dk:"4",sl:"3.5",kmh:"9.6",hd:"1412",msa:"2042",ml:"630",hm:"",hg:"",ms:"",mst:"",ge:"Swing Zenith 23",pa:"",be:"Soaring, mit vielen Schirme, absaufen."},
"151":{d:"21.3.93",sz:"",lz:"",st:"Rothorn",la:"Valbella See",sLat:46.741949,sLon:9.599242,lLat:46.742593,lLon:9.555272,dur:"0h 15m",dk:"2.5",sl:"3.4",kmh:"10.0",hd:"1339",msa:"2828",ml:"1489",hm:"",hg:"",ms:"",mst:"",ge:"Swing Zenith 23",pa:"",be:"Starker, laminarer Wind, thermischer Aufwind."},
"152":{d:"24.5.93",sz:"",lz:"",st:"Rotenflue SW Sommer",la:"Rickenbach",sLat:47.017641,sLon:8.700727,lLat:47.012549,lLon:8.67004,dur:"0h 17m",dk:"2.5",sl:"2.4",kmh:"8.8",hd:"928",msa:"1518",ml:"590",hm:"",hg:"",ms:"",mst:"",ge:"Swing Zenith 23",pa:"",be:"Seitenwind, gute Thermik, aber dann absaufen."},
"153":{d:"29.5.93",sz:"",lz:"",st:"Rotenflue SW Sommer",la:"Rickenbach",sLat:47.017641,sLon:8.700727,lLat:47.012549,lLon:8.67004,dur:"0h 16m",dk:"2.5",sl:"2.4",kmh:"9.4",hd:"928",msa:"1518",ml:"590",hm:"",hg:"",ms:"",mst:"",ge:"Swing Zenith 23",pa:"",be:"Wie immer Seitenwind und Rückenwind, es trägt leicht."},
"154":{d:"29.5.93",sz:"",lz:"",st:"Rotenflue SW Sommer",la:"Rickenbach",sLat:47.017641,sLon:8.700727,lLat:47.012549,lLon:8.67004,dur:"0h 14m",dk:"2.5",sl:"2.4",kmh:"10.7",hd:"928",msa:"1518",ml:"590",hm:"",hg:"",ms:"",mst:"",ge:"Swing Zenith 23",pa:"",be:"Zwei Fehlstarts beim Rückenwind, zu wenig angebremst."},
"155":{d:"5.6.93",sz:"",lz:"",st:"Gummen",la:"Mitteley Wolfenschiessen",sLat:46.902517,sLon:8.365359,lLat:46.893269,lLon:8.384044,dur:"0h 10m",dk:"2",sl:"1.8",kmh:"12.6",hd:"1070",msa:"1599",ml:"529",hm:"",hg:"",ms:"",mst:"",ge:"Swing Zenith 23",pa:"",be:"Nichts los, Fehler, ins Lee geflogen, deutliche Abwind. Dann aufgegeben."},
"156":{d:"6.6.93",sz:"",lz:"",st:"Horn Wirzweli",la:"Dallenwil",sLat:46.909066,sLon:8.375278,lLat:46.920148,lLon:8.398263,dur:"0h 13m",dk:"2.5",sl:"2.1",kmh:"11.5",hd:"978",msa:"1476",ml:"498",hm:"",hg:"",ms:"",mst:"",ge:"Swing Zenith 23",pa:"",be:"Morgenflug mit Bea's Tandemflug, ruhig."},
"157":{d:"6.6.93",sz:"",lz:"",st:"Horn Wirzweli",la:"Dallenwil",sLat:46.909066,sLon:8.375278,lLat:46.920148,lLon:8.398263,dur:"0h 35m",dk:"3",sl:"2.1",kmh:"5.1",hd:"978",msa:"1476",ml:"498",hm:"",hg:"",ms:"",mst:"",ge:"Swing Zenith 23",pa:"",be:"Zwei Fehlstart, zu stark angebremst, Rückenwind. Dann Soaring."},
"158":{d:"25.6.94",sz:"",lz:"",st:"Chalbersäntis",la:"Unterwasser",sLat:47.244842,sLon:9.349172,lLat:47.195081,lLon:9.30621,dur:"1h 0m",dk:"9.5",sl:"6.4",kmh:"9.5",hd:"1435",msa:"2343",ml:"908",hm:"",hg:"",ms:"",mst:"",ge:"Swing Zenith 23",pa:"",be:"Erster Flug seit fast einem Jahr. Thermik bei Silberplatten, Lütispitz. Dann keine Lust mehr, Abbruch."},
"159":{d:"25.6.94",sz:"",lz:"",st:"Hinderrugg",la:"Walenstadt",sLat:47.153731,sLon:9.303897,lLat:47.123602,lLon:9.307514,dur:"0h 45m",dk:"9.8",sl:"3.4",kmh:"13.1",hd:"1861",msa:"2285",ml:"424",hm:"",hg:"",ms:"",mst:"",ge:"Swing Zenith 23",pa:"",be:"Blauthermik über den Startplatz, Soaring, dann baden im See."},
"160":{d:"2.7.94",sz:"",lz:"",st:"Haldigrat",la:"Dallenwil Talstation",sLat:46.90236,sLon:8.440603,lLat:46.928525,lLon:8.395852,dur:"1h 45m",dk:"5",sl:"4.5",kmh:"2.9",hd:"1438",msa:"1938",ml:"500",hm:"",hg:"",ms:"",mst:"",ge:"Swing Zenith 23",pa:"",be:"Reichlich Thermik, viele Gleitschirme 300 m über Start, 100 m über Gipfel. Nur leicht ruppig."},
"161":{d:"20.8.94",sz:"",lz:"",st:"Brändlen-Nord",la:"Wolfenschiessen",sLat:46.904921,sLon:8.409661,lLat:46.905095,lLon:8.398533,dur:"0h 25m",dk:"2",sl:"0.8",kmh:"4.8",hd:"727",msa:"1237",ml:"510",hm:"",hg:"",ms:"",mst:"",ge:"Swing Zenith 23",pa:"",be:"Soaring, aber schlechte Verhältnisse, warm."},
"162":{d:"16.10.94",sz:"",lz:"",st:"Gandbütz Mettmenalp",la:"Kies",sLat:46.960744,sLon:9.110158,lLat:46.968016,lLon:9.092037,dur:"0h 25m",dk:"4",sl:"1.6",kmh:"9.6",hd:"907",msa:"1936",ml:"1029",hm:"",hg:"",ms:"",mst:"",ge:"Swing Zenith 23",pa:"",be:"Nach Klettertag mit Klein-Alena, gemütlicher Heimflug."},
"163":{d:"20.11.94",sz:"",lz:"",st:"Eggberge",la:"Flüelen Krebsried",sLat:46.904141,sLon:8.651741,lLat:46.887805,lLon:8.631125,dur:"0h 13m",dk:"2",sl:"2.4",kmh:"9.2",hd:"1130",msa:"1567",ml:"437",hm:"",hg:"",ms:"",mst:"",ge:"Swing Zenith 23",pa:"",be:"Rückenwind-Start, ruhig, Schirm im Vergleich mit Stefan etwas schlechter, schneller."},
"164":{d:"20.11.94",sz:"",lz:"",st:"Eggberge",la:"Flüelen Allmend",sLat:46.904141,sLon:8.651741,lLat:46.898249,lLon:8.619833,dur:"0h 14m",dk:"2",sl:"2.5",kmh:"8.6",hd:"1130",msa:"1567",ml:"437",hm:"",hg:"",ms:"",mst:"",ge:"Swing Zenith 23",pa:"",be:"Rückenwind-Start, ruhig, Schirm im Vergleich mit Stefan etwas schlechter, schneller."},
"165":{d:"3.12.94",sz:"",lz:"",st:"Brunni Schonegg",la:"Engelberg Kloster",sLat:46.847399,sLon:8.420397,lLat:46.821035,lLon:8.411569,dur:"0h 14m",dk:"2",sl:"3.0",kmh:"8.6",hd:"889",msa:"1921",ml:"1032",hm:"",hg:"",ms:"",mst:"",ge:"Nova Phocus 23",pa:"",be:"Test: schwergängige Steuerung, einmal leicht unruhig, schlecht fliegbare enge Kurven. Gleitet super. Schnell, guter Start."},
"166":{d:"3.12.94",sz:"",lz:"",st:"Brunni Ristis",la:"Engelberg Kloster",sLat:46.833379,sLon:8.410337,lLat:46.821035,lLon:8.411569,dur:"0h 10m",dk:"2",sl:"1.4",kmh:"12.0",hd:"598",msa:"1630",ml:"1032",hm:"",hg:"",ms:"",mst:"",ge:"Nova Phocus 23",pa:"",be:"Test: schwergängige Steuerung, einmal leicht unruhig, schlecht fliegbare enge Kurven. Gleitet super. Schnell, guter Start."},
"167":{d:"11.12.94",sz:"",lz:"",st:"Brändlen-Nord",la:"Wolfenschiessen",sLat:46.904921,sLon:8.409661,lLat:46.905095,lLon:8.398533,dur:"0h 10m",dk:"2",sl:"0.8",kmh:"12.0",hd:"727",msa:"1237",ml:"510",hm:"",hg:"",ms:"",mst:"",ge:"UP Vision S",pa:"",be:"Start unauffällig, Steilspirale so so lala. B-Stall gut. Ohren rein."},
"168":{d:"11.12.94",sz:"",lz:"",st:"Brändlen-Nord",la:"Wolfenschiessen",sLat:46.904921,sLon:8.409661,lLat:46.905095,lLon:8.398533,dur:"0h 12m",dk:"2",sl:"0.8",kmh:"10.0",hd:"727",msa:"1237",ml:"510",hm:"",hg:"",ms:"",mst:"",ge:"UP Vision S",pa:"",be:"Alles problemlos, gutes Gefühl, besser als der Phocus.."},
"169":{d:"11.12.94",sz:"",lz:"",st:"Brändlen-Nord",la:"Wolfenschiessen",sLat:46.904921,sLon:8.409661,lLat:46.905095,lLon:8.398533,dur:"0h 13m",dk:"2",sl:"0.8",kmh:"9.2",hd:"727",msa:"1237",ml:"510",hm:"",hg:"",ms:"",mst:"",ge:"UP Vision S",pa:"",be:"Enge Steilsspirale, leichter B-Stall, toll."},
"170":{d:"31.12.94",sz:"",lz:"",st:"Alp Clünaz Ftan",la:"Tarasp",sLat:46.817705,sLon:10.247098,lLat:46.778758,lLon:10.264942,dur:"0h 10m",dk:"4.5",sl:"4.5",kmh:"27.0",hd:"1150",msa:"2579",ml:"1429",hm:"",hg:"",ms:"",mst:"",ge:"Swing Zenith 23",pa:"",be:"Starker, seitlicher Westwind, kamen knapp über die Kante, super."},
"171":{d:"31.3.95",sz:"",lz:"",st:"Jakobshorn Gipfel N",la:"Davos Jakobshorn Winter",sLat:46.772689,sLon:9.84663,lLat:46.78741,lLon:9.817978,dur:"0h 10m",dk:"3",sl:"2.7",kmh:"18.0",hd:"992",msa:"2524",ml:"1532",hm:"",hg:"",ms:"",mst:"",ge:"Swing Zenith 23",pa:"",be:"Mässiger Wind, steiler Platz, Flug langweilig, Schnee."},
"172":{d:"21.5.95",sz:"",lz:"",st:"Rigi Scheidegg",la:"Kräbel",sLat:47.027928,sLon:8.519556,lLat:47.038871,lLon:8.535264,dur:"0h 30m",dk:"2",sl:"1.7",kmh:"4.0",hd:"932",msa:"1648",ml:"716",hm:"",hg:"",ms:"",mst:"",ge:"Swing Zenith 23",pa:"",be:"Bise, Rückenwind-Start, mässig. Teilweise Graupel. Kalt."},
"173":{d:"21.5.95",sz:"",lz:"",st:"Horn Wirzweli",la:"Dallenwil",sLat:46.909066,sLon:8.375278,lLat:46.920148,lLon:8.398263,dur:"0h 35m",dk:"3",sl:"2.1",kmh:"5.1",hd:"978",msa:"1476",ml:"498",hm:"",hg:"",ms:"",mst:"",ge:"Swing Zenith 23",pa:"",be:"Super Bisen-Dynamik . Viele Gleitschirme, kalte Finger, zu starker Gegenwind."},
"174":{d:"22.5.95",sz:"",lz:"",st:"Brändlen-Nord",la:"Wolfenschiessen",sLat:46.904921,sLon:8.409661,lLat:46.905095,lLon:8.398533,dur:"0h 15m",dk:"2",sl:"0.8",kmh:"8.0",hd:"727",msa:"1237",ml:"510",hm:"",hg:"",ms:"",mst:"",ge:"Swing Zenith 23",pa:"",be:"Abnehmende Bise, keine Thermik, kurzer Flug, am Landeplatz Aufziehübungen."},
"175":{d:"22.5.95",sz:"",lz:"",st:"Büelen",la:"Fallenbach",sLat:46.880943,sLon:8.365539,lLat:46.882945,lLon:8.377145,dur:"0h 30m",dk:"2",sl:"0.9",kmh:"4.0",hd:"555",msa:"1100",ml:"545",hm:"",hg:"",ms:"",mst:"",ge:"Swing Zenith 23",pa:"",be:"Bise, dynamisch, kann knapp halten. Gute Vorwärts-Start, gute Landung."},
"176":{d:"22.5.95",sz:"",lz:"",st:"Brändlen-Nord",la:"Wolfenschiessen",sLat:46.904921,sLon:8.409661,lLat:46.905095,lLon:8.398533,dur:"0h 45m",dk:"2",sl:"0.8",kmh:"2.7",hd:"727",msa:"1237",ml:"510",hm:"",hg:"",ms:"",mst:"",ge:"Swing Zenith 23",pa:"",be:"Bise nimmt ab, gute Thermik, kann aber nicht wesentlich überhöhen."},
"177":{d:"23.5.95",sz:"",lz:"",st:"Harder Höji Egg",la:"Interlaken",sLat:46.711652,sLon:7.873241,lLat:46.685364,lLon:7.8595,dur:"0h 16m",dk:"2",sl:"3.1",kmh:"7.5",hd:"1024",msa:"1592",ml:"568",hm:"",hg:"",ms:"",mst:"",ge:"Swing Zenith 23",pa:"",be:"Steile Wiese beim Start, es geht kaum vorwärts, Landung gut."},
"178":{d:"23.5.95",sz:"",lz:"",st:"First",la:"Grindelwald Bodmi",sLat:46.658433,sLon:8.05489,lLat:46.628744,lLon:8.043582,dur:"0h 16m",dk:"3.5",sl:"3.4",kmh:"13.1",hd:"1011",msa:"2141",ml:"1130",hm:"",hg:"",ms:"",mst:"",ge:"Swing Zenith 23",pa:"",be:"Rückenwind, ein Fehlstart, dann gut. Crash von Giani."},
"179":{d:"24.5.95",sz:"",lz:"",st:"Niesen",la:"Niesen Heustrich",sLat:46.643722,sLon:7.648312,lLat:46.653213,lLon:7.684247,dur:"0h 18m",dk:"3",sl:"2.9",kmh:"10.0",hd:"1560",msa:"2236",ml:"676",hm:"",hg:"",ms:"",mst:"",ge:"Swing Zenith 23",pa:"",be:"Ruhig, nichts geht, Landung etwas weit. Alleine. Schwieriger Landeplatz."},
"180":{d:"28.5.95",sz:"",lz:"",st:"Rotenflue SW Sommer",la:"Rickenbach",sLat:47.017641,sLon:8.700727,lLat:47.012549,lLon:8.67004,dur:"0h 25m",dk:"2.5",sl:"2.4",kmh:"6.0",hd:"928",msa:"1518",ml:"590",hm:"",hg:"",ms:"",mst:"",ge:"Swing Zenith 23",pa:"",be:"Ein Fehlstart bei fehlendem Wind. Dann aufdrehen zum Gipfel des Mythen, aber zu tief."},
"181":{d:"8.7.95",sz:"",lz:"",st:"Cassons",la:"Flims",sLat:46.87646,sLon:9.262552,lLat:46.835689,lLon:9.281179,dur:"1h 20m",dk:"4",sl:"4.7",kmh:"3.0",hd:"1357",msa:"2455",ml:"1098",hm:"",hg:"",ms:"",mst:"",ge:"Swing Zenith 23",pa:"",be:"Tolle Thermik, sehr ruppig, zwei heftige Klapper."},
"182":{d:"8.7.95",sz:"",lz:"",st:"Cassons",la:"Flims",sLat:46.87646,sLon:9.262552,lLat:46.835689,lLon:9.281179,dur:"0h 25m",dk:"4",sl:"4.7",kmh:"9.6",hd:"1357",msa:"2455",ml:"1098",hm:"",hg:"",ms:"",mst:"",ge:"Swing Zenith 23",pa:"",be:"Ruhig, gute Thermik, gemütlich am Flimserstein, hoch."},
"183":{d:"4.8.95",sz:"",lz:"",st:"Rigi Scheidegg",la:"Kräbel",sLat:47.027928,sLon:8.519556,lLat:47.038871,lLon:8.535264,dur:"0h 20m",dk:"2",sl:"1.7",kmh:"6.0",hd:"932",msa:"1648",ml:"716",hm:"",hg:"",ms:"",mst:"",ge:"Swing Zenith 23",pa:"",be:"Abends Soaring, gemütlich, lande um 19:30 Uhr."},
"184":{d:"24.9.95",sz:"",lz:"",st:"Pilatus Matthorn Chöpf",la:"Alpnachstad",sLat:46.968064,sLon:8.254936,lLat:46.950303,lLon:8.27416,dur:"0h 15m",dk:"3",sl:"2.5",kmh:"12.0",hd:"1417",msa:"1860",ml:"443",hm:"",hg:"",ms:"",mst:"",ge:"Swing Zenith 23",pa:"",be:"Start im fünften Versuch, ruppig, schwerer Rucksack."},
"185":{d:"14.10.95",sz:"",lz:"",st:"Brunni Schonegg",la:"Engelberg Kloster",sLat:46.847399,sLon:8.420397,lLat:46.821035,lLon:8.411569,dur:"0h 8m",dk:"3",sl:"3.0",kmh:"22.5",hd:"889",msa:"1921",ml:"1032",hm:"",hg:"",ms:"",mst:"",ge:"Swing Zenith 23",pa:"",be:"Start so lala. Mit schwerem Klettermaterial."},
"186":{d:"15.10.95",sz:"",lz:"",st:"Gumengrat",la:"Linthal",sLat:46.959564,sLon:8.987319,lLat:46.931729,lLon:9.008976,dur:"0h 30m",dk:"4",sl:"3.5",kmh:"8.0",hd:"1412",msa:"2042",ml:"630",hm:"",hg:"",ms:"",mst:"",ge:"Swing Zenith 23",pa:"",be:"Soaring, langsam fällt der Zenith deutlich ab."},
"187":{d:"14.1.96",sz:"",lz:"",st:"Brunni Schonegg",la:"Engelberg Kloster",sLat:46.847399,sLon:8.420397,lLat:46.821035,lLon:8.411569,dur:"0h 15m",dk:"2",sl:"3.0",kmh:"8.0",hd:"889",msa:"1921",ml:"1032",hm:"",hg:"",ms:"",mst:"",ge:"ProDesign Pro-Feel 33",pa:"",be:"Test 1: Ohren, A-Gurt, B-Stall, Spirale. Sicher, guter Rückenwind Start."},
"188":{d:"14.1.96",sz:"",lz:"",st:"Brunni Schonegg",la:"Engelberg Kloster",sLat:46.847399,sLon:8.420397,lLat:46.821035,lLon:8.411569,dur:"0h 15m",dk:"2",sl:"3.0",kmh:"8.0",hd:"889",msa:"1921",ml:"1032",hm:"",hg:"",ms:"",mst:"",ge:"ProDesign Pro-Feel 33",pa:"",be:"Test 2: enge Spirale, Guter Start."},
"189":{d:"14.1.96",sz:"",lz:"",st:"Brunni Schonegg",la:"Engelberg Kloster",sLat:46.847399,sLon:8.420397,lLat:46.821035,lLon:8.411569,dur:"0h 15m",dk:"2",sl:"3.0",kmh:"8.0",hd:"889",msa:"1921",ml:"1032",hm:"",hg:"",ms:"",mst:"",ge:"Advance Sigma 3/27",pa:"",be:"Test 3: Start bei Rückenwind. Lange Strecke, sicher, problemlos."},
"190":{d:"28.1.96",sz:"",lz:"",st:"Brunni Schonegg",la:"Engelberg Kloster",sLat:46.847399,sLon:8.420397,lLat:46.821035,lLon:8.411569,dur:"0h 20m",dk:"2",sl:"3.0",kmh:"6.0",hd:"889",msa:"1921",ml:"1032",hm:"",hg:"",ms:"",mst:"",ge:"Airwave Samba 27",pa:"",be:"Test 4: ruhig, stabil, wendig, vermittelt sicheres Gefühl."},
"191":{d:"28.1.96",sz:"",lz:"",st:"Brunni Schonegg",la:"Engelberg Kloster",sLat:46.847399,sLon:8.420397,lLat:46.821035,lLon:8.411569,dur:"0h 15m",dk:"2",sl:"3.0",kmh:"8.0",hd:"889",msa:"1921",ml:"1032",hm:"",hg:"",ms:"",mst:"",ge:"Airwave Samba 27",pa:"",be:"Test 5: ein toller Schirm."},
"192":{d:"28.1.96",sz:"",lz:"",st:"Brunni Schonegg",la:"Engelberg Kloster",sLat:46.847399,sLon:8.420397,lLat:46.821035,lLon:8.411569,dur:"0h 15m",dk:"2",sl:"3.0",kmh:"8.0",hd:"889",msa:"1921",ml:"1032",hm:"",hg:"",ms:"",mst:"",ge:"Advance Sigma 3/27",pa:"",be:"Test 6: Stallpunkt erflogen. Nebel. Den kaufe ich."},
"193":{d:"10.3.96",sz:"",lz:"",st:"Scalottas",la:"Valbella See",sLat:46.71999,sLon:9.510107,lLat:46.742593,lLon:9.555272,dur:"0h 20m",dk:"3",sl:"4.3",kmh:"9.0",hd:"806",msa:"2295",ml:"1489",hm:"",hg:"",ms:"",mst:"",ge:"Advance Sigma 3/27",pa:"",be:"Leichte Thermik, etwas ruppig, Gegenwind."},
"194":{d:"6.4.96",sz:"",lz:"",st:"Rotenflue SW Sommer",la:"Rickenbach",sLat:47.017641,sLon:8.700727,lLat:47.012549,lLon:8.67004,dur:"0h 20m",dk:"2",sl:"2.4",kmh:"6.0",hd:"928",msa:"1518",ml:"590",hm:"",hg:"",ms:"",mst:"",ge:"Advance Sigma 3/27",pa:"",be:"Diesig, schlechte Sicht. 0-Schieber, Rückenwind, guter Start."},
"195":{d:"15.4.96",sz:"",lz:"",st:"Rigi Scheidegg",la:"Kräbel",sLat:47.027928,sLon:8.519556,lLat:47.038871,lLon:8.535264,dur:"0h 30m",dk:"2",sl:"1.7",kmh:"4.0",hd:"932",msa:"1648",ml:"716",hm:"",hg:"",ms:"",mst:"",ge:"Advance Sigma 3/27",pa:"",be:"Bei Bise dynamisch, noch in Lernphase."},
"196":{d:"5.5.96",sz:"",lz:"",st:"Fürenalp",la:"Talstation Fürenalp",sLat:46.80452,sLon:8.466794,lLat:46.799367,lLon:8.454539,dur:"0h 47m",dk:"11",sl:"1.1",kmh:"14.0",hd:"802",msa:"1903",ml:"1101",hm:"",hg:"",ms:"",mst:"",ge:"Advance Sigma 3/27",pa:"",be:"Thermisch top. Flug von Bruni Mittelstation zur Fürenalp."},
"197":{d:"5.5.96",sz:"",lz:"",st:"Fürenalp",la:"Talstation Fürenalp",sLat:46.80452,sLon:8.466794,lLat:46.799367,lLon:8.454539,dur:"0h 10m",dk:"2",sl:"1.1",kmh:"12.0",hd:"802",msa:"1903",ml:"1101",hm:"",hg:"",ms:"",mst:"",ge:"Advance Sigma 3/27",pa:"",be:"Ruhig, super Start, schnell unten."},
"198":{d:"31.5.96",sz:"",lz:"",st:"Grat nördl Cima del Monte",la:"Bagnaia Ost",sLat:42.80072,sLon:10.3917,lLat:42.81014,lLon:10.37362,dur:"0h 7m",dk:"1.8",sl:"1.8",kmh:"15.4",hd:"415",msa:"435",ml:"20",hm:"",hg:"",ms:"",mst:"",ge:"Advance Sigma 3/27",pa:"",be:"Abendflug auf Elba, leichte Thermik, ruhig."},
"199":{d:"16.6.96",sz:"",lz:"",st:"Obermutten",la:"Zillis",sLat:46.670798,sLon:9.482453,lLat:46.637177,lLon:9.438004,dur:"0h 46m",dk:"8",sl:"5.0",kmh:"10.4",hd:"909",msa:"1844",ml:"935",hm:"",hg:"",ms:"",mst:"",ge:"Advance Sigma 3/27",pa:"",be:"Bei Bise, 50 % Einklapper, 500 m Startüberhöhung."},
"200":{d:"17.7.96",sz:"",lz:"",st:"Rigi Scheidegg",la:"Kräbel",sLat:47.027928,sLon:8.519556,lLat:47.038871,lLon:8.535264,dur:"0h 50m",dk:"2",sl:"1.7",kmh:"2.4",hd:"932",msa:"1648",ml:"716",hm:"",hg:"",ms:"",mst:"",ge:"Advance Sigma 3/27",pa:"",be:"Bisen/Abend-Flug, Turbulenzen."},
"201":{d:"17.8.96",sz:"",lz:"",st:"Fiescheralp Heimat",la:"Fiesch",sLat:46.414477,sLon:8.108295,lLat:46.40933,lLon:8.136896,dur:"1h 22m",dk:"3",sl:"2.3",kmh:"2.2",hd:"1090",msa:"2146",ml:"1056",hm:"",hg:"",ms:"",mst:"",ge:"Advance Sigma 3/27",pa:"",be:"Leicht ruppig, zuerst schlecht, dann starkes Steigen bis Eggishorn."},
"202":{d:"18.8.96",sz:"",lz:"",st:"Rigi Scheidegg",la:"Kräbel",sLat:47.027928,sLon:8.519556,lLat:47.038871,lLon:8.535264,dur:"0h 33m",dk:"3",sl:"1.7",kmh:"5.5",hd:"932",msa:"1648",ml:"716",hm:"",hg:"",ms:"",mst:"",ge:"Advance Sigma 3/27",pa:"",be:"Sanfte Bise oben, kräftiger unten, ruhig."},
"203":{d:"27.10.96",sz:"",lz:"",st:"Brunni Schonegg",la:"Engelberg Kloster",sLat:46.847399,sLon:8.420397,lLat:46.821035,lLon:8.411569,dur:"0h 12m",dk:"2",sl:"3.0",kmh:"10.0",hd:"889",msa:"1921",ml:"1032",hm:"",hg:"",ms:"",mst:"",ge:"Advance Sigma 3/27",pa:"",be:"Ein Fehlstart, ruhig, Steilspirale."},
"204":{d:"3.11.96",sz:"",lz:"",st:"Biel",la:"Bürglen-Stalden",sLat:46.894396,sLon:8.708347,lLat:46.876883,lLon:8.682652,dur:"0h 18m",dk:"3",sl:"2.8",kmh:"10.0",hd:"953",msa:"1613",ml:"660",hm:"",hg:"",ms:"",mst:"",ge:"Advance Sigma 3/27",pa:"",be:"Sehr ruhig, Steilspirale."},
"205":{d:"3.11.96",sz:"",lz:"",st:"Biel",la:"Bürglen-Stalden",sLat:46.894396,sLon:8.708347,lLat:46.876883,lLon:8.682652,dur:"0h 10m",dk:"3",sl:"2.8",kmh:"18.0",hd:"953",msa:"1613",ml:"660",hm:"",hg:"",ms:"",mst:"",ge:"Advance Sigma 3/27",pa:"",be:"Sehr ruhig, Beschleunigung, Spirale."},
"206":{d:"3.11.96",sz:"",lz:"",st:"Biel",la:"Bürglen-Stalden",sLat:46.894396,sLon:8.708347,lLat:46.876883,lLon:8.682652,dur:"0h 10m",dk:"3",sl:"2.8",kmh:"18.0",hd:"953",msa:"1613",ml:"660",hm:"",hg:"",ms:"",mst:"",ge:"Advance Sigma 3/27",pa:"",be:"Sehr später Start, Spirale, alles unauffällig."},
"207":{d:"2.2.97",sz:"",lz:"",st:"Brunni Schonegg",la:"Engelberg Kloster",sLat:46.847399,sLon:8.420397,lLat:46.821035,lLon:8.411569,dur:"0h 22m",dk:"2",sl:"3.0",kmh:"5.5",hd:"889",msa:"1921",ml:"1032",hm:"",hg:"",ms:"",mst:"",ge:"Advance Sigma 3/27",pa:"",be:"Gemütliches Soaring, leider sehr kalt."},
"208":{d:"9.2.97",sz:"",lz:"",st:"Rotenflue SW Sommer",la:"Rickenbach",sLat:47.017641,sLon:8.700727,lLat:47.012549,lLon:8.67004,dur:"0h 19m",dk:"2",sl:"2.4",kmh:"6.3",hd:"928",msa:"1518",ml:"590",hm:"",hg:"",ms:"",mst:"",ge:"Advance Sigma 3/27",pa:"",be:"Leichtes Hangsoaring, zu tief."},
"209":{d:"2.3.97",sz:"",lz:"",st:"Rigi Staffelhöhe",la:"Weggis Bahn",sLat:47.047772,sLon:8.460731,lLat:47.033102,lLon:8.442189,dur:"0h 20m",dk:"4",sl:"2.2",kmh:"12.0",hd:"1087",msa:"1563",ml:"476",hm:"",hg:"",ms:"",mst:"",ge:"Advance Sigma 3/27",pa:"",be:"Rückenwärts-Start, drehe in die falsche Richtung aus, kann im Flug korrigieren. Turbulenz."},
"210":{d:"11.3.97",sz:"",lz:"",st:"Les Ruinettes",la:"Verbier",sLat:46.09081,sLon:7.250919,lLat:46.102626,lLon:7.218859,dur:"0h 27m",dk:"2",sl:"2.8",kmh:"4.4",hd:"625",msa:"2148",ml:"1523",hm:"",hg:"",ms:"",mst:"",ge:"Advance Sigma 3/27",pa:"",be:"Start mit Ski, Turbulenz, Thermik, überhöhen."},
"211":{d:"12.3.97",sz:"",lz:"",st:"Les Ruinettes",la:"Les Essert Verbier",sLat:46.09081,sLon:7.250919,lLat:46.107651,lLon:7.236092,dur:"0h 33m",dk:"5",sl:"2.2",kmh:"9.1",hd:"457",msa:"2148",ml:"1691",hm:"",hg:"",ms:"",mst:"",ge:"Advance Sigma 3/27",pa:"",be:"Zu Fuss, toller Schlauch auf 2700 m, ruppig."},
"212":{d:"13.3.97",sz:"",lz:"",st:"Les Ruinettes",la:"Les Essert Verbier",sLat:46.09081,sLon:7.250919,lLat:46.107651,lLon:7.236092,dur:"0h 27m",dk:"5",sl:"2.2",kmh:"11.1",hd:"457",msa:"2148",ml:"1691",hm:"",hg:"",ms:"",mst:"",ge:"Advance Sigma 3/27",pa:"",be:"Mit viel Wasserballast, kein Klapper, stabiler."},
"213":{d:"5.5.97",sz:"",lz:"",st:"Rigi Scheidegg",la:"Kräbel",sLat:47.027928,sLon:8.519556,lLat:47.038871,lLon:8.535264,dur:"1h 17m",dk:"7",sl:"1.7",kmh:"5.5",hd:"932",msa:"1648",ml:"716",hm:"",hg:"",ms:"",mst:"",ge:"Advance Sigma 3/27",pa:"",be:"Bise. Abendflug zum Dossen und Gätterli, super."},
"214":{d:"19.9.97",sz:"",lz:"",st:"Scalottas",la:"Valbella See",sLat:46.71999,sLon:9.510107,lLat:46.742593,lLon:9.555272,dur:"0h 22m",dk:"2",sl:"4.3",kmh:"5.5",hd:"806",msa:"2295",ml:"1489",hm:"",hg:"",ms:"",mst:"",ge:"Advance Sigma 3/27",pa:"",be:"Soaring, Landung bei Tgantieni."},
"215":{d:"19.9.97",sz:"",lz:"",st:"Scalottas",la:"Valbella See",sLat:46.71999,sLon:9.510107,lLat:46.742593,lLon:9.555272,dur:"0h 11m",dk:"3",sl:"4.3",kmh:"16.4",hd:"806",msa:"2295",ml:"1489",hm:"",hg:"",ms:"",mst:"",ge:"Advance Sigma 3/27",pa:"",be:"Leichtes Soaring, Landung sehr turbulent."},
"216":{d:"11.1.98",sz:"",lz:"",st:"Rigi Staffelhöhe",la:"Küssnacht",sLat:47.047772,sLon:8.460731,lLat:47.06739,lLon:8.435432,dur:"0h 15m",dk:"2",sl:"2.9",kmh:"8.0",hd:"1100",msa:"1563",ml:"463",hm:"",hg:"",ms:"",mst:"",ge:"Advance Sigma 3/27",pa:"",be:"Abendflug, Gurt 180° verdreht, dann ruhig."},
"217":{d:"31.1.98",sz:"",lz:"",st:"Brunni Schonegg",la:"Engelberg Kloster",sLat:46.847399,sLon:8.420397,lLat:46.821035,lLon:8.411569,dur:"0h 40m",dk:"3",sl:"3.0",kmh:"4.5",hd:"889",msa:"1921",ml:"1032",hm:"",hg:"",ms:"",mst:"",ge:"Advance Sigma 3/27",pa:"",be:"Gute Thermik, viele Gleitschirme, problemlos."},
"218":{d:"1.2.98",sz:"",lz:"",st:"Brunni Schonegg",la:"Engelberg Kloster",sLat:46.847399,sLon:8.420397,lLat:46.821035,lLon:8.411569,dur:"0h 12m",dk:"3",sl:"3.0",kmh:"15.0",hd:"889",msa:"1921",ml:"1032",hm:"",hg:"",ms:"",mst:"",ge:"Advance Sigma 3/27",pa:"",be:"Gute Thermik, problemlos."},
"219":{d:"1.3.98",sz:"",lz:"",st:"Rigi Staffelhöhe",la:"Küssnacht",sLat:47.047772,sLon:8.460731,lLat:47.06739,lLon:8.435432,dur:"0h 30m",dk:"4",sl:"2.9",kmh:"8.0",hd:"1100",msa:"1563",ml:"463",hm:"",hg:"",ms:"",mst:"",ge:"Advance Sigma 3/27",pa:"",be:"Ruhiger Abendflug."},
"220":{d:"10.5.98",sz:"",lz:"",st:"Rotenflue SW Sommer",la:"Rickenbach",sLat:47.017641,sLon:8.700727,lLat:47.012549,lLon:8.67004,dur:"1h 10m",dk:"5",sl:"2.4",kmh:"4.3",hd:"928",msa:"1518",ml:"590",hm:"",hg:"",ms:"",mst:"",ge:"Advance Sigma 3/27",pa:"",be:"Super Thermik über dem Mythen."},
"221":{d:"31.8.98",sz:"",lz:"",st:"Bietstöckli Fronalp",la:"Rüti Morschach",sLat:46.972414,sLon:8.637183,lLat:46.989565,lLon:8.634213,dur:"0h 15m",dk:"2",sl:"1.9",kmh:"8.0",hd:"1074",msa:"1856",ml:"782",hm:"",hg:"",ms:"",mst:"",ge:"Advance Sigma 3/27",pa:"",be:"Bise, Lee, es geht nichts."},
"222":{d:"31.12.98",sz:"",lz:"",st:"Alp Clünaz Ftan",la:"Tarasp",sLat:46.817705,sLon:10.247098,lLat:46.778758,lLon:10.264942,dur:"0h 15m",dk:"4.5",sl:"4.5",kmh:"18.0",hd:"1150",msa:"2579",ml:"1429",hm:"",hg:"",ms:"",mst:"",ge:"Advance Sigma 3/27",pa:"",be:"Winterflug, alles perfekt, kann überhöhen."},
"223":{d:"3.4.99",sz:"",lz:"",st:"Timpel Brunniberg",la:"Brunnen Talstation",sLat:47.01189,sLon:8.590558,lLat:47.00087,lLon:8.59162,dur:"0h 23m",dk:"2",sl:"1.2",kmh:"5.2",hd:"657",msa:"1090",ml:"433",hm:"",hg:"",ms:"",mst:"",ge:"Advance Sigma 3/27",pa:"",be:"Erster Start 1999, alles gut, schlecht in der Thermik."},
"224":{d:"30.5.99",sz:"",lz:"",st:"Brunni Schonegg",la:"Engelberg Kloster",sLat:46.847399,sLon:8.420397,lLat:46.821035,lLon:8.411569,dur:"0h 30m",dk:"4",sl:"3.0",kmh:"8.0",hd:"889",msa:"1921",ml:"1032",hm:"",hg:"",ms:"",mst:"",ge:"Advance Sigma 3/27",pa:"",be:"Zum Teil ruppige Thermik, lange Pause, super."},
"225":{d:"3.7.99",sz:"",lz:"",st:"Rotenflue W Sommer",la:"Rickenbach",sLat:47.018594,sLon:8.701526,lLat:47.012549,lLon:8.67004,dur:"0h 20m",dk:"5",sl:"2.5",kmh:"15.0",hd:"960",msa:"1550",ml:"590",hm:"",hg:"",ms:"",mst:"",ge:"Advance Sigma 3/27",pa:"",be:"Steiler Start, alles in Ordnung, schwache Thermik."},
"226":{d:"1.8.00",sz:"",lz:"",st:"Brunni Schonegg",la:"Engelberg Kloster",sLat:46.847399,sLon:8.420397,lLat:46.821035,lLon:8.411569,dur:"1h 10m",dk:"3",sl:"3.0",kmh:"2.6",hd:"889",msa:"1921",ml:"1032",hm:"",hg:"",ms:"",mst:"",ge:"Advance Sigma 3/27",pa:"",be:"Erster Flug seit über einem Jahr, zerrissene Thermik, super."},
"227":{d:"30.7.01",sz:"",lz:"",st:"Rigi Scheidegg",la:"Kräbel",sLat:47.027928,sLon:8.519556,lLat:47.038871,lLon:8.535264,dur:"0h 14m",dk:"1",sl:"1.7",kmh:"4.3",hd:"932",msa:"1648",ml:"716",hm:"",hg:"",ms:"",mst:"",ge:"Advance Sigma 3/27",pa:"",be:"Null Wind, guter Start, ruhig."},
"228":{d:"7.6.04",sz:"",lz:"",st:"Fiescheralp Heimat",la:"Baschi",sLat:46.414477,sLon:8.108295,lLat:46.498154,lLon:8.285362,dur:"2h 50m",dk:"16.5",sl:"16.4",kmh:"5.8",hd:"799",msa:"2146",ml:"1347",hm:"",hg:"",ms:"",mst:"",ge:"Advance Sigma 3/27",pa:"",be:"Thermikkurs Hansi. Maximale Höhe 3232, Eggishorn."},
"229":{d:"8.6.04",sz:"",lz:"",st:"Fiescheralp Heimat",la:"Kapelle Ritzingen",sLat:46.414477,sLon:8.108295,lLat:46.460795,lLon:8.227707,dur:"1h 45m",dk:"10.5",sl:"10.5",kmh:"6.0",hd:"789",msa:"2146",ml:"1357",hm:"",hg:"",ms:"",mst:"",ge:"Advance Sigma 3/27",pa:"",be:"Thermikkurs Hansi. Maximale Höhe 3731, Bellwald."},
"230":{d:"9.6.04",sz:"",lz:"",st:"Fiescheralp Heimat",la:"Steinstaffel Tiefenbach",sLat:46.414477,sLon:8.108295,lLat:46.586939,lLon:8.456487,dur:"1h 53m",dk:"34",sl:"32.8",kmh:"18.1",hd:"227",msa:"2146",ml:"1919",hm:"",hg:"",ms:"",mst:"",ge:"Ozone Vibe MS",pa:"",be:"Thermikkurs Hansi. Maximale Höhe 3817 bei Bellwald. Über Sidelhorn und Furka."},
"231":{d:"10.6.04",sz:"",lz:"",st:"Fiescheralp Heimat",la:"Neugaden Zumdorf",sLat:46.414477,sLon:8.108295,lLat:46.608851,lLon:8.52965,dur:"1h 42m",dk:"41.5",sl:"38.8",kmh:"24.4",hd:"647",msa:"2146",ml:"1499",hm:"",hg:"",ms:"",mst:"",ge:"Ozone Vibe MS",pa:"",be:"Thermikkurs Hansi. Maximale Höhe 3490 in Bellwald. Über Sidelhorn und Furka."},
"232":{d:"11.6.04",sz:"",lz:"",st:"Fiescheralp Heimat",la:"Fieschertal Flyingcenter",sLat:46.414477,sLon:8.108295,lLat:46.421062,lLon:8.145385,dur:"1h 0m",dk:"5",sl:"2.9",kmh:"5.0",hd:"1055",msa:"2146",ml:"1091",hm:"",hg:"",ms:"",mst:"",ge:"Ozone Vibe MS",pa:"",be:"Thermikkurs Hansi. Maximale Höhe 2992, oberhalb Eggishorn."},
"233":{d:"15.6.04",sz:"",lz:"",st:"Motta Naluns",la:"Scuol",sLat:46.790828,sLon:10.282705,lLat:46.794543,lLon:10.283924,dur:"0h 17m",dk:"2",sl:"0.4",kmh:"7.1",hd:"765",msa:"2052",ml:"1287",hm:"",hg:"",ms:"",mst:"",ge:"Ozone Vibe MS",pa:"",be:"Keine Überhöhung, es geht nichts."},
"234":{d:"16.6.04",sz:"",lz:"",st:"Motta Naluns",la:"Scuol",sLat:46.790828,sLon:10.282705,lLat:46.794543,lLon:10.283924,dur:"0h 40m",dk:"2",sl:"0.4",kmh:"3.0",hd:"765",msa:"2052",ml:"1287",hm:"",hg:"",ms:"",mst:"",ge:"Ozone Vibe MS",pa:"",be:"Ruppige Thermik, Abschattung, es geht wenig."},
"235":{d:"23.7.04",sz:"",lz:"",st:"Fiescheralp Heimat",la:"Fiesch",sLat:46.414477,sLon:8.108295,lLat:46.40933,lLon:8.136896,dur:"0h 42m",dk:"1",sl:"2.3",kmh:"1.4",hd:"1090",msa:"2146",ml:"1056",hm:"",hg:"",ms:"",mst:"",ge:"Ozone Vibe MS",pa:"",be:"Nichts geht. Suche lange am Älpli."},
"236":{d:"23.7.04",sz:"",lz:"",st:"Fiescheralp Heimat",la:"Fiesch",sLat:46.414477,sLon:8.108295,lLat:46.40933,lLon:8.136896,dur:"0h 40m",dk:"1",sl:"2.3",kmh:"1.5",hd:"1090",msa:"2146",ml:"1056",hm:"",hg:"",ms:"",mst:"",ge:"Ozone Vibe MS",pa:"",be:"Besser, über Trichter rechts, 2300 m."},
"237":{d:"24.10.04",sz:"",lz:"",st:"Rotenflue SW Sommer",la:"Rickenbach",sLat:47.017641,sLon:8.700727,lLat:47.012549,lLon:8.67004,dur:"1h 0m",dk:"4",sl:"2.4",kmh:"4.0",hd:"928",msa:"1518",ml:"590",hm:"",hg:"",ms:"",mst:"",ge:"Ozone Vibe MS",pa:"",be:"Super. Startplatz-Überhöhung, ruhig, Föhn."},
"238":{d:"4.1.05",sz:"",lz:"",st:"Corne de Sorebois",la:"Zinal REKA",sLat:46.15038,sLon:7.588701,lLat:46.129737,lLon:7.629297,dur:"0h 20m",dk:"6",sl:"3.9",kmh:"18.0",hd:"1157",msa:"2833",ml:"1676",hm:"",hg:"",ms:"",mst:"",ge:"Ozone Vibe MS",pa:"",be:"Rückenwind-Start mit Ski, dann ruhig."},
"239":{d:"5.4.05",sz:"",lz:"",st:"Jakobshorn Jatzhütte",la:"Davos Jakobshorn Winter",sLat:46.766194,sLon:9.849876,lLat:46.78741,lLon:9.817978,dur:"1h 4m",dk:"4",sl:"3.4",kmh:"3.8",hd:"967",msa:"2499",ml:"1532",hm:"",hg:"",ms:"",mst:"",ge:"Ozone Vibe MS",pa:"",be:"Im Sertigtal, super Schlauch über Clavadeller Alp."},
"240":{d:"24.5.05",sz:"",lz:"",st:"Monte Lema",la:"Sessa",sLat:46.040157,sLon:8.831883,lLat:45.999549,lLon:8.816197,dur:"1h 13m",dk:"5",sl:"4.7",kmh:"4.1",hd:"1235",msa:"1610",ml:"375",hm:"",hg:"",ms:"",mst:"",ge:"Ozone Vibe MS",pa:"",be:"Ruppige Thermik, nicht zum Tamaro getraut."},
"241":{d:"24.5.05",sz:"",lz:"",st:"Monte Lema",la:"Sessa",sLat:46.040157,sLon:8.831883,lLat:45.999549,lLon:8.816197,dur:"1h 28m",dk:"5",sl:"4.7",kmh:"3.4",hd:"1235",msa:"1610",ml:"375",hm:"",hg:"",ms:"",mst:"",ge:"Ozone Vibe MS",pa:"",be:"Wie vormittags. Teils sehr schön."},
"242":{d:"25.5.05",sz:"",lz:"",st:"Monte Generoso",la:"Camping Generoso",sLat:45.9267,sLon:9.020876,lLat:45.922853,lLon:8.980388,dur:"1h 18m",dk:"4",sl:"3.2",kmh:"3.1",hd:"1219",msa:"1493",ml:"274",hm:"",hg:"",ms:"",mst:"",ge:"Ozone Vibe MS",pa:"",be:"Super, problemlos, Landung gut."},
"243":{d:"25.5.05",sz:"",lz:"",st:"Monte Generoso",la:"Camping Generoso",sLat:45.9267,sLon:9.020876,lLat:45.922853,lLon:8.980388,dur:"0h 57m",dk:"4",sl:"3.2",kmh:"4.2",hd:"1219",msa:"1493",ml:"274",hm:"",hg:"",ms:"",mst:"",ge:"Ozone Vibe MS",pa:"",be:"Super. Rüber nach Westen, Landung gut."},
"244":{d:"25.5.05",sz:"",lz:"",st:"Motto della Croce",la:"Odogna",sLat:46.094,sLon:8.98998,lLat:46.080561,lLon:8.97133,dur:"0h 30m",dk:"2",sl:"2.1",kmh:"4.0",hd:"825",msa:"1447",ml:"622",hm:"",hg:"",ms:"",mst:"",ge:"Ozone Vibe MS",pa:"",be:"Phänomenal.  Abendsoaring."},
"245":{d:"26.5.05",sz:"",lz:"",st:"Monte Cimetta",la:"Aeroporto Ascona",sLat:46.199961,sLon:8.788029,lLat:46.158273,lLon:8.781754,dur:"0h 45m",dk:"5",sl:"4.7",kmh:"6.7",hd:"1417",msa:"1619",ml:"202",hm:"",hg:"",ms:"",mst:"",ge:"Ozone Vibe MS",pa:"",be:"Thermik so lala, weit bis Ascona."},
"246":{d:"26.5.05",sz:"",lz:"",st:"Monte Cimetta",la:"Aeroporto Ascona",sLat:46.199961,sLon:8.788029,lLat:46.158273,lLon:8.781754,dur:"0h 50m",dk:"5",sl:"4.7",kmh:"6.0",hd:"1417",msa:"1619",ml:"202",hm:"",hg:"",ms:"",mst:"",ge:"Ozone Vibe MS",pa:"",be:"Thermik so lala, weit bis Ascona."},
"247":{d:"27.5.05",sz:"",lz:"",st:"La Cima Piano di Vigezzo",la:"Santa Maria Maggiore",sLat:46.162744,sLon:8.475201,lLat:46.133438,lLon:8.450899,dur:"1h 44m",dk:"25",sl:"3.8",kmh:"14.4",hd:"968",msa:"1784",ml:"816",hm:"",hg:"",ms:"",mst:"",ge:"Ozone Vibe MS",pa:"",be:"Dreieck Chima-Domo-P. Ragno-Cima"},
"248":{d:"28.5.05",sz:"",lz:"",st:"Bellwald Mutti",la:"Fieschertal Flyingcenter",sLat:46.43749,sLon:8.15544,lLat:46.421062,lLon:8.145385,dur:"0h 20m",dk:"1",sl:"2.0",kmh:"3.0",hd:"688",msa:"1779",ml:"1091",hm:"",hg:"",ms:"",mst:"",ge:"Ozone Vibe MS",pa:"",be:"Zu wenig Thermik, zum oben bleiben reicht es nicht."},
"249":{d:"20.6.05",sz:"",lz:"",st:"Rigi Scheidegg",la:"Kräbel",sLat:47.027928,sLon:8.519556,lLat:47.038871,lLon:8.535264,dur:"0h 40m",dk:"2",sl:"1.7",kmh:"3.0",hd:"932",msa:"1648",ml:"716",hm:"",hg:"",ms:"",mst:"",ge:"Ozone Vibe MS",pa:"",be:"Wenig Thermik im Täli. Bise."},
"250":{d:"27.6.05",sz:"",lz:"",st:"Rigi Scheidegg",la:"Kräbel",sLat:47.027928,sLon:8.519556,lLat:47.038871,lLon:8.535264,dur:"0h 29m",dk:"2",sl:"1.7",kmh:"4.1",hd:"932",msa:"1648",ml:"716",hm:"",hg:"",ms:"",mst:"",ge:"Ozone Vibe MS",pa:"",be:"Wenig thermisch, rechts am Start."},
"251":{d:"22.5.06",sz:"",lz:"",st:"Monte Nudo",la:"Laveno",sLat:45.923653,sLon:8.683557,lLat:45.896701,lLon:8.639575,dur:"0h 27m",dk:"3",sl:"4.5",kmh:"6.7",hd:"922",msa:"1149",ml:"227",hm:"",hg:"",ms:"",mst:"",ge:"Ozone Vibe MS",pa:"",be:"Leichte Thermik trotz völliger Abdeckung."},
"252":{d:"22.5.06",sz:"",lz:"",st:"Monte Nudo",la:"Laveno",sLat:45.923653,sLon:8.683557,lLat:45.896701,lLon:8.639575,dur:"0h 15m",dk:"3",sl:"4.5",kmh:"12.0",hd:"922",msa:"1149",ml:"227",hm:"",hg:"",ms:"",mst:"",ge:"Ozone Vibe MS",pa:"",be:"Fehlstart bei Null Wind, nicht genug angebremst."},
"253":{d:"24.5.06",sz:"",lz:"",st:"Monte Lema",la:"Sessa",sLat:46.040157,sLon:8.831883,lLat:45.999549,lLon:8.816197,dur:"1h 28m",dk:"5",sl:"4.7",kmh:"3.4",hd:"1235",msa:"1610",ml:"375",hm:"",hg:"",ms:"",mst:"",ge:"Ozone Vibe MS",pa:"",be:"Ein Fehlstart, ruppige Thermik, Nordföhn."},
"254":{d:"24.5.06",sz:"",lz:"",st:"Monte Lema",la:"Sessa",sLat:46.040157,sLon:8.831883,lLat:45.999549,lLon:8.816197,dur:"0h 59m",dk:"5",sl:"4.7",kmh:"5.1",hd:"1235",msa:"1610",ml:"375",hm:"",hg:"",ms:"",mst:"",ge:"Ozone Vibe MS",pa:"",be:"Super Start, ruppig, Wolkenflucht."},
"255":{d:"25.5.06",sz:"",lz:"",st:"Monte Generoso",la:"Camping Generoso",sLat:45.9267,sLon:9.020876,lLat:45.922853,lLon:8.980388,dur:"0h 36m",dk:"3",sl:"3.2",kmh:"5.0",hd:"1219",msa:"1493",ml:"274",hm:"",hg:"",ms:"",mst:"",ge:"Ozone Vibe MS",pa:"",be:"Guter Start, Wolkenflug. Starker Lande-Wind."},
"256":{d:"25.5.06",sz:"",lz:"",st:"Monte Generoso",la:"Camping Generoso",sLat:45.9267,sLon:9.020876,lLat:45.922853,lLon:8.980388,dur:"0h 34m",dk:"3",sl:"3.2",kmh:"5.3",hd:"1219",msa:"1493",ml:"274",hm:"",hg:"",ms:"",mst:"",ge:"Ozone Vibe MS",pa:"",be:"Viele Wolken, wenig Thermik über dem See."},
"257":{d:"26.5.06",sz:"",lz:"",st:"Monte Cimetta",la:"Aeroporto Ascona",sLat:46.199961,sLon:8.788029,lLat:46.158273,lLon:8.781754,dur:"0h 34m",dk:"3",sl:"4.7",kmh:"5.3",hd:"1417",msa:"1619",ml:"202",hm:"",hg:"",ms:"",mst:"",ge:"Ozone Vibe MS",pa:"",be:"Ruhige Thermik, ruhig über Ascona."},
"258":{d:"26.5.06",sz:"",lz:"",st:"Monte Cimetta",la:"Aeroporto Ascona",sLat:46.199961,sLon:8.788029,lLat:46.158273,lLon:8.781754,dur:"0h 41m",dk:"3",sl:"4.7",kmh:"4.4",hd:"1417",msa:"1619",ml:"202",hm:"",hg:"",ms:"",mst:"",ge:"Ozone Vibe MS",pa:"",be:"Kaum Thermik, westlicher Gegenwind."},
"259":{d:"5.6.06",sz:"",lz:"",st:"Fiescheralp Heimat",la:"Fieschertal Flyingcenter",sLat:46.414477,sLon:8.108295,lLat:46.421062,lLon:8.145385,dur:"0h 22m",dk:"2",sl:"2.9",kmh:"5.5",hd:"1055",msa:"2146",ml:"1091",hm:"",hg:"",ms:"",mst:"",ge:"Ozone Vibe MS",pa:"",be:"Wolken, leichter Nordwind, Kühboden-Bellwald-Kühboden."},
"260":{d:"11.6.06",sz:"",lz:"",st:"Fürenalp",la:"Talstation Fürenalp",sLat:46.80452,sLon:8.466794,lLat:46.799367,lLon:8.454539,dur:"0h 53m",dk:"2",sl:"1.1",kmh:"2.3",hd:"802",msa:"1903",ml:"1101",hm:"",hg:"",ms:"",mst:"",ge:"Ozone Vibe MS",pa:"",be:"Bise, mässige Thermik, ruppig."},
"261":{d:"28.7.06",sz:"",lz:"",st:"Motta Naluns",la:"Tarasp",sLat:46.790828,sLon:10.282705,lLat:46.778758,lLon:10.264942,dur:"0h 14m",dk:"4.5",sl:"1.9",kmh:"19.3",hd:"623",msa:"2052",ml:"1429",hm:"",hg:"",ms:"",mst:"",ge:"Ozone Vibe MS",pa:"",be:"Schwache Thermik, beschleunigt, nicht ruppig."},
"262":{d:"28.3.07",sz:"",lz:"",st:"Jakobshorn Jatzhütte",la:"Davos Jakobshorn Winter",sLat:46.766194,sLon:9.849876,lLat:46.78741,lLon:9.817978,dur:"0h 50m",dk:"4",sl:"3.4",kmh:"4.8",hd:"967",msa:"2499",ml:"1532",hm:"",hg:"",ms:"",mst:"",ge:"Ozone Vibe MS",pa:"",be:"Überentwicklung, Start gut. Kam fast nicht runter."},
"263":{d:"16.4.07",sz:"",lz:"",st:"Büelen",la:"Fallenbach",sLat:46.880943,sLon:8.365539,lLat:46.882945,lLon:8.377145,dur:"0h 19m",dk:"2",sl:"0.9",kmh:"6.3",hd:"555",msa:"1100",ml:"545",hm:"",hg:"",ms:"",mst:"",ge:"Ozone Vibe MS",pa:"",be:"Nichts geht. Viele Seile."},
"264":{d:"17.6.07",sz:"",lz:"",st:"Fiescheralp Heimat",la:"Fieschertal Flyingcenter",sLat:46.414477,sLon:8.108295,lLat:46.421062,lLon:8.145385,dur:"0h 43m",dk:"3",sl:"2.9",kmh:"4.2",hd:"1055",msa:"2146",ml:"1091",hm:"",hg:"",ms:"",mst:"",ge:"Ozone Vibe MS",pa:"",be:"Mässig."},
"265":{d:"12.8.07",sz:"",lz:"",st:"Brunni Schonegg",la:"Engelberg Örtli",sLat:46.847399,sLon:8.420397,lLat:46.816954,lLon:8.415308,dur:"0h 28m",dk:"3",sl:"3.4",kmh:"6.4",hd:"909",msa:"1921",ml:"1012",hm:"",hg:"",ms:"",mst:"",ge:"Ozone Vibe MS",pa:"",be:"Viele Wolken am Start."},
"266":{d:"25.8.07",sz:"",lz:"",st:"Fiescheralp Heimat",la:"Fieschertal Flyingcenter",sLat:46.414477,sLon:8.108295,lLat:46.421062,lLon:8.145385,dur:"1h 17m",dk:"3",sl:"2.9",kmh:"2.3",hd:"1055",msa:"2146",ml:"1091",hm:"",hg:"",ms:"",mst:"",ge:"Ozone Vibe MS",pa:"",be:"Harzige Thermik, Kampf."},
"267":{d:"25.8.07",sz:"",lz:"",st:"Fiescheralp Heimat",la:"Fieschertal Flyingcenter",sLat:46.414477,sLon:8.108295,lLat:46.421062,lLon:8.145385,dur:"1h 1m",dk:"1",sl:"2.9",kmh:"1.0",hd:"1055",msa:"2146",ml:"1091",hm:"",hg:"",ms:"",mst:"",ge:"Ozone Vibe MS",pa:"",be:"Absaufen über Bellwald."},
"268":{d:"26.8.07",sz:"",lz:"",st:"Fiescheralp Heimat",la:"Fieschertal Flyingcenter",sLat:46.414477,sLon:8.108295,lLat:46.421062,lLon:8.145385,dur:"0h 17m",dk:"1",sl:"2.9",kmh:"3.5",hd:"1055",msa:"2146",ml:"1091",hm:"",hg:"",ms:"",mst:"",ge:"Ozone Vibe MS",pa:"",be:"Morgenflug 8:00, ruhig."},
"269":{d:"26.8.07",sz:"",lz:"",st:"Fiescheralp Heimat",la:"Fieschertal Flyingcenter",sLat:46.414477,sLon:8.108295,lLat:46.421062,lLon:8.145385,dur:"0h 22m",dk:"1",sl:"2.9",kmh:"2.7",hd:"1055",msa:"2146",ml:"1091",hm:"",hg:"",ms:"",mst:"",ge:"Ozone Vibe MS",pa:"",be:"Ruhig."},
"270":{d:"26.8.07",sz:"",lz:"",st:"Fiescheralp Heimat",la:"Fieschertal Flyingcenter",sLat:46.414477,sLon:8.108295,lLat:46.421062,lLon:8.145385,dur:"0h 20m",dk:"1",sl:"2.9",kmh:"3.0",hd:"1055",msa:"2146",ml:"1091",hm:"",hg:"",ms:"",mst:"",ge:"Ozone Vibe MS",pa:"",be:"Nach Unfall. Mässig."},
"271":{d:"10.9.07",sz:"",lz:"",st:"Col Rodella",la:"Campitello di Fassa",sLat:46.49729,sLon:11.75402,lLat:46.47589,lLon:11.74946,dur:"0h 48m",dk:"3",sl:"2.4",kmh:"3.8",hd:"939",msa:"2355",ml:"1416",hm:"2356",hg:"",ms:"1.6",mst:"-3.8",ge:"Ozone Vibe MS",pa:"",be:"Maximal 2356, ruhig."},
"272":{d:"10.9.07",sz:"",lz:"",st:"Belvedere",la:"Campitello di Fassa",sLat:46.4778,sLon:11.80491,lLat:46.47589,lLon:11.74946,dur:"0h 53m",dk:"3",sl:"4.3",kmh:"3.4",hd:"848",msa:"2264",ml:"1416",hm:"2431",hg:"",ms:"2.6",mst:"-3.8",ge:"Ozone Vibe MS",pa:"",be:"Maximal 2431, circa Startplatz, Thermik."},
"273":{d:"10.9.07",sz:"",lz:"",st:"Rif. Paolina Rosengarten",la:"Campitello di Fassa",sLat:46.41604,sLon:11.61681,lLat:46.47589,lLon:11.74946,dur:"1h 4m",dk:"3",sl:"12.1",kmh:"2.8",hd:"788",msa:"2204",ml:"1416",hm:"2775",hg:"",ms:"4.8",mst:"-5.2",ge:"Ozone Vibe MS",pa:"",be:"Maximal 2775, entlang der Steilwände, dann ins Lee ."},
"274":{d:"12.9.07",sz:"",lz:"",st:"Col Rodella",la:"Campitello di Fassa",sLat:46.49729,sLon:11.75402,lLat:46.47589,lLon:11.74946,dur:"0h 44m",dk:"3",sl:"2.4",kmh:"4.1",hd:"939",msa:"2355",ml:"1416",hm:"3300",hg:"",ms:"4",mst:"-3.6",ge:"Ozone Vibe MS",pa:"",be:"Maximal 3300, hoch, tolle Fernsicht, mit Video."},
"275":{d:"13.9.07",sz:"",lz:"",st:"Col Rodella",la:"Campitello di Fassa",sLat:46.49729,sLon:11.75402,lLat:46.47589,lLon:11.74946,dur:"0h 19m",dk:"3",sl:"2.4",kmh:"9.5",hd:"939",msa:"2355",ml:"1416",hm:"",hg:"",ms:"1.6",mst:"-6.2",ge:"Ozone Vibe MS",pa:"",be:"Verhängte Bremse, konnte sie lösen. Gleitflug, Steilspirale."},
"276":{d:"13.9.07",sz:"",lz:"",st:"Col Rodella",la:"Top Marmolada",sLat:46.49729,sLon:11.75402,lLat:46.43455,lLon:11.85081,dur:"1h 52m",dk:"12",sl:"10.2",kmh:"6.4",hd:"-903",msa:"2355",ml:"3258",hm:"",hg:"",ms:"5.2",mst:"-5.2",ge:"Ozone Vibe MS",pa:"",be:"Toplandung auf Gipfel, Windstill"},
"277":{d:"13.9.07",sz:"",lz:"",st:"Top Marmolada",la:"Campitello di Fassa",sLat:46.43451,sLon:11.84993,lLat:46.47589,lLon:11.74946,dur:"1h 13m",dk:"20",sl:"9.0",kmh:"16.4",hd:"1842",msa:"3258",ml:"1416",hm:"",hg:"",ms:"5",mst:"-4.2",ge:"Ozone Vibe MS",pa:"",be:"Start gut"},
"278":{d:"14.9.07",sz:"",lz:"",st:"Belvedere",la:"Campitello di Fassa",sLat:46.4778,sLon:11.80491,lLat:46.47589,lLon:11.74946,dur:"0h 29m",dk:"4",sl:"4.3",kmh:"8.3",hd:"848",msa:"2264",ml:"1416",hm:"",hg:"",ms:"5.2",mst:"-5.2",ge:"Ozone Vibe MS",pa:"",be:"Kleiner Klapper, o.B., Abschluss"},
"279":{d:"26.10.08",sz:"",lz:"",st:"Brunni Schonegg",la:"Engelberg Örtli",sLat:46.847399,sLon:8.420397,lLat:46.816954,lLon:8.415308,dur:"0h 21m",dk:"6",sl:"3.4",kmh:"17.1",hd:"909",msa:"1921",ml:"1012",hm:"",hg:"",ms:"",mst:"",ge:"Ozone Vibe MS",pa:"",be:"Lee von linker Krete, Thermik über Felsen rechts"},
"280":{d:"29.4.09",sz:"",lz:"",st:"Monte Lema",la:"Sessa",sLat:46.040157,sLon:8.831883,lLat:45.999549,lLon:8.816197,dur:"1h 18m",dk:"9",sl:"4.7",kmh:"6.9",hd:"1235",msa:"1610",ml:"375",hm:"",hg:"",ms:"",mst:"",ge:"Ozone Vibe MS",pa:"",be:"Schnee, abgedeckt. Thermik, kalt."},
"281":{d:"30.4.09",sz:"",lz:"",st:"Cornizzolo",la:"Suello",sLat:45.832221,sLon:9.301198,lLat:45.817776,lLon:9.318183,dur:"0h 43m",dk:"6",sl:"2.1",kmh:"8.4",hd:"790",msa:"1066",ml:"276",hm:"",hg:"",ms:"",mst:"",ge:"Ozone Vibe MS",pa:"",be:"Schnee, ruppige Thermik, Nordwind, super."},
"282":{d:"1.5.09",sz:"",lz:"",st:"Monte Cimetta",la:"Aeroporto Ascona",sLat:46.199961,sLon:8.788029,lLat:46.158273,lLon:8.781754,dur:"1h 4m",dk:"6",sl:"4.7",kmh:"5.6",hd:"1417",msa:"1619",ml:"202",hm:"2627",hg:"",ms:"",mst:"",ge:"Ozone Vibe MS",pa:"",be:"Schnee. Nordwind, sehr hoch, ruppig."},
"283":{d:"1.5.09",sz:"",lz:"",st:"Monte Cimetta",la:"Aeroporto Ascona",sLat:46.199961,sLon:8.788029,lLat:46.158273,lLon:8.781754,dur:"0h 35m",dk:"6",sl:"4.7",kmh:"10.3",hd:"1417",msa:"1619",ml:"202",hm:"",hg:"",ms:"",mst:"",ge:"Ozone Vibe MS",pa:"",be:"Ruppig, böiger Start, dann Gleitflug."},
"284":{d:"22.6.09",sz:"",lz:"",st:"Sonchaux",la:"Villeneuve",sLat:46.417818,sLon:6.951509,lLat:46.387179,lLon:6.92321,dur:"0h 42m",dk:"3",sl:"4.0",kmh:"4.3",hd:"1019",msa:"1395",ml:"376",hm:"",hg:"",ms:"",mst:"",ge:"Ozone Vibe MS",pa:"",be:""},
"285":{d:"24.6.09",sz:"",lz:"",st:"Gurli",la:"Plaffeien",sLat:46.713353,sLon:7.282784,lLat:46.726502,lLon:7.294114,dur:"0h 34m",dk:"5",sl:"1.7",kmh:"8.8",hd:"533",msa:"1411",ml:"878",hm:"",hg:"",ms:"",mst:"",ge:"Ozone Vibe MS",pa:"",be:"Bise, beim Start wenig Bremse"},
"286":{d:"24.6.09",sz:"",lz:"",st:"Gurli",la:"Plaffeien",sLat:46.713353,sLon:7.282784,lLat:46.726502,lLon:7.294114,dur:"0h 59m",dk:"5",sl:"1.7",kmh:"5.1",hd:"533",msa:"1411",ml:"878",hm:"",hg:"",ms:"",mst:"",ge:"Ozone Vibe MS",pa:"",be:"Bise, ruppige Thermik, Start vorwärts/rückwärts"},
"287":{d:"25.6.09",sz:"",lz:"",st:"Grindelwald First",la:"Grindelwald Grund",sLat:46.65909,sLon:8.067897,lLat:46.620265,lLon:8.029034,dur:"0h 13m",dk:"5",sl:"5.2",kmh:"23.1",hd:"954",msa:"1904",ml:"950",hm:"",hg:"",ms:"",mst:"",ge:"Ozone Vibe MS",pa:"",be:"Schöner Startplatz, wenig Thermik"},
"288":{d:"26.6.09",sz:"",lz:"",st:"Bellwald Mutti",la:"Fieschertal Flyingcenter",sLat:46.43749,sLon:8.15544,lLat:46.421062,lLon:8.145385,dur:"0h 21m",dk:"2",sl:"2.0",kmh:"5.7",hd:"688",msa:"1779",ml:"1091",hm:"",hg:"",ms:"",mst:"",ge:"Ozone Vibe MS",pa:"",be:"Schwache Thermik über Kapelle"},
"289":{d:"13.7.09",sz:"",lz:"",st:"Brunni Schonegg",la:"Engelberg Örtli",sLat:46.847399,sLon:8.420397,lLat:46.816954,lLon:8.415308,dur:"0h 14m",dk:"3",sl:"3.4",kmh:"12.9",hd:"909",msa:"1921",ml:"1012",hm:"",hg:"",ms:"",mst:"",ge:"Ozone Vibe MS",pa:"",be:"Bedeckt, neues Gurtzeug, sehr direkt."},
"290":{d:"13.7.09",sz:"",lz:"",st:"Brunni Tümpfeli",la:"Engelberg Örtli",sLat:46.838069,sLon:8.41206,lLat:46.816954,lLon:8.415308,dur:"0h 13m",dk:"2",sl:"2.4",kmh:"9.2",hd:"790",msa:"1802",ml:"1012",hm:"",hg:"",ms:"",mst:"",ge:"Ozone Vibe MS",pa:"",be:"Schwache Thermik, Gurt sehr lebendig, super."},
"291":{d:"26.7.09",sz:"",lz:"",st:"Brunni Tümpfeli",la:"Engelberg Örtli",sLat:46.838069,sLon:8.41206,lLat:46.816954,lLon:8.415308,dur:"0h 15m",dk:"2",sl:"2.4",kmh:"8.0",hd:"790",msa:"1802",ml:"1012",hm:"",hg:"",ms:"",mst:"",ge:"Ozone Vibe MS",pa:"",be:"Im Anschluss an Klettersteig, ruhig."},
"292":{d:"13.8.09",sz:"",lz:"",st:"Alp Clünaz Ftan",la:"Tarasp",sLat:46.817705,sLon:10.247098,lLat:46.778758,lLon:10.264942,dur:"0h 13m",dk:"4",sl:"4.5",kmh:"18.5",hd:"1150",msa:"2579",ml:"1429",hm:"",hg:"",ms:"",mst:"",ge:"Ozone Vibe MS",pa:"",be:"Lee, ruppig, ungemütlich, Landung gut."},
"293":{d:"22.8.09",sz:"",lz:"",st:"Fiescheralp Heimat",la:"Fieschertal Flyingcenter",sLat:46.414477,sLon:8.108295,lLat:46.421062,lLon:8.145385,dur:"0h 22m",dk:"4",sl:"2.9",kmh:"10.9",hd:"1055",msa:"2146",ml:"1091",hm:"",hg:"",ms:"",mst:"",ge:"Ozone Vibe MS",pa:"",be:"Wolken, tiefe Basis auf Starthöhe, ruhig."},
"294":{d:"23.8.09",sz:"",lz:"",st:"Fiescheralp Heimat",la:"Fieschertal Flyingcenter",sLat:46.414477,sLon:8.108295,lLat:46.421062,lLon:8.145385,dur:"0h 32m",dk:"3",sl:"2.9",kmh:"5.6",hd:"1055",msa:"2146",ml:"1091",hm:"",hg:"",ms:"",mst:"",ge:"Ozone Vibe MS",pa:"",be:"Zu Früh, keine Thermik, langes Kratzen."},
"295":{d:"23.8.09",sz:"",lz:"",st:"Fiescheralp Heimat",la:"Fieschertal Flyingcenter",sLat:46.414477,sLon:8.108295,lLat:46.421062,lLon:8.145385,dur:"1h 11m",dk:"6",sl:"2.9",kmh:"5.1",hd:"1055",msa:"2146",ml:"1091",hm:"",hg:"",ms:"",mst:"",ge:"Ozone Vibe MS",pa:"",be:"Anfangs zäh, dann hoch zum Aletschgletscher."},
"296":{d:"6.4.10",sz:"",lz:"",st:"Fiescheralp Heimat",la:"Fieschertal Flyingcenter",sLat:46.414477,sLon:8.108295,lLat:46.421062,lLon:8.145385,dur:"0h 28m",dk:"3",sl:"2.9",kmh:"6.4",hd:"1055",msa:"2146",ml:"1091",hm:"",hg:"",ms:"",mst:"",ge:"Advance Sigma 7/26",pa:"",be:"Morgens, ruhig, kaum  Thermik, wackelig."},
"297":{d:"6.4.10",sz:"",lz:"",st:"Fiescheralp Heimat",la:"Fieschertal Flyingcenter",sLat:46.414477,sLon:8.108295,lLat:46.421062,lLon:8.145385,dur:"1h 0m",dk:"9",sl:"2.9",kmh:"9.0",hd:"1055",msa:"2146",ml:"1091",hm:"",hg:"",ms:"",mst:"",ge:"Swing Mistral 6/24",pa:"",be:"z.T. ruppige Thermik, toll über Bellwald."},
"298":{d:"28.4.10",sz:"",lz:"",st:"Fiescheralp Heimat",la:"Fiesch",sLat:46.414477,sLon:8.108295,lLat:46.40933,lLon:8.136896,dur:"0h 48m",dk:"5",sl:"2.3",kmh:"6.3",hd:"1090",msa:"2146",ml:"1056",hm:"",hg:"",ms:"",mst:"",ge:"Ozone Vibe MS",pa:"",be:"Schwach, über Bellwald."},
"299":{d:"29.4.10",sz:"",lz:"",st:"Fiescheralp Heimat",la:"Fiesch",sLat:46.414477,sLon:8.108295,lLat:46.40933,lLon:8.136896,dur:"1h 47m",dk:"35",sl:"2.3",kmh:"19.6",hd:"1090",msa:"2146",ml:"1056",hm:"",hg:"",ms:"",mst:"",ge:"Ozone Vibe MS",pa:"",be:"Ullrichen retour, meist > 2700, 35 km."},
"300":{d:"5.6.10",sz:"",lz:"",st:"Fiescheralp Heimat",la:"Fiesch",sLat:46.414477,sLon:8.108295,lLat:46.40933,lLon:8.136896,dur:"2h 32m",dk:"42",sl:"2.3",kmh:"16.6",hd:"1090",msa:"2146",ml:"1056",hm:"",hg:"",ms:"",mst:"",ge:"Swing Mistral 6/24",pa:"",be:"Ruppig, tolle Strecke Sidelhorn retour."},
"301":{d:"28.6.10",sz:"",lz:"",st:"Brunni Schonegg",la:"Engelberg Örtli",sLat:46.847399,sLon:8.420397,lLat:46.816954,lLon:8.415308,dur:"1h 57m",dk:"20",sl:"3.4",kmh:"10.3",hd:"909",msa:"1921",ml:"1012",hm:"",hg:"",ms:"",mst:"",ge:"Swing Mistral 6/24",pa:"",be:"Ruppig, Bise, 2x Vollklapper"},
"302":{d:"3.7.10",sz:"",lz:"",st:"Fiescheralp Heimat",la:"Fiesch",sLat:46.414477,sLon:8.108295,lLat:46.40933,lLon:8.136896,dur:"1h 14m",dk:"3",sl:"2.3",kmh:"2.4",hd:"1090",msa:"2146",ml:"1056",hm:"",hg:"",ms:"",mst:"",ge:"Swing Mistral 6/24",pa:"",be:"Anfangs schwach, gewittrig, ½-Klapper."},
"303":{d:"4.9.10",sz:"",lz:"",st:"Fiescheralp Heimat",la:"Fiesch",sLat:46.414477,sLon:8.108295,lLat:46.40933,lLon:8.136896,dur:"0h 47m",dk:"3",sl:"2.3",kmh:"3.8",hd:"1090",msa:"2146",ml:"1056",hm:"",hg:"",ms:"",mst:"",ge:"Swing Mistral 6/24",pa:"",be:"Bewölkt, gut über Bellwald."},
"304":{d:"5.9.10",sz:"",lz:"",st:"Col Rodella",la:"Campitello di Fassa",sLat:46.49729,sLon:11.75402,lLat:46.47589,lLon:11.74946,dur:"0h 39m",dk:"4",sl:"2.4",kmh:"6.2",hd:"939",msa:"2355",ml:"1416",hm:"",hg:"",ms:"",mst:"",ge:"Swing Mistral 6/24",pa:"",be:"Unruhig, dyn. Soaring"},
"305":{d:"6.9.10",sz:"",lz:"",st:"Col Rodella",la:"Campitello di Fassa",sLat:46.49729,sLon:11.75402,lLat:46.47589,lLon:11.74946,dur:"0h 40m",dk:"4",sl:"2.4",kmh:"6.0",hd:"939",msa:"2355",ml:"1416",hm:"",hg:"",ms:"",mst:"",ge:"Swing Mistral 6/24",pa:"",be:"Turbulent, dyn. Soaring."},
"306":{d:"6.9.10",sz:"",lz:"",st:"Col Rodella",la:"Campitello di Fassa",sLat:46.49729,sLon:11.75402,lLat:46.47589,lLon:11.74946,dur:"0h 34m",dk:"4",sl:"2.4",kmh:"7.1",hd:"939",msa:"2355",ml:"1416",hm:"",hg:"",ms:"",mst:"",ge:"Swing Mistral 6/24",pa:"",be:"Turbulent, kleine Klapper"},
"307":{d:"6.9.10",sz:"",lz:"",st:"Rif. Paolina Rosengarten",la:"Karerpass",sLat:46.41604,sLon:11.61681,lLat:46.40432,lLon:11.61006,dur:"0h 12m",dk:"3",sl:"1.4",kmh:"15.0",hd:"450",msa:"2204",ml:"1754",hm:"",hg:"",ms:"",mst:"",ge:"Swing Mistral 6/24",pa:"",be:"Wolken, erstaunliches Steigen."},
"308":{d:"9.9.10",sz:"",lz:"",st:"Col Rodella",la:"Campitello di Fassa",sLat:46.49729,sLon:11.75402,lLat:46.47589,lLon:11.74946,dur:"0h 25m",dk:"4",sl:"2.4",kmh:"9.6",hd:"939",msa:"2355",ml:"1416",hm:"",hg:"",ms:"",mst:"",ge:"Swing Mistral 6/24",pa:"",be:"Fliege mit mehr Bremse, keine Klapper."},
"309":{d:"9.9.10",sz:"",lz:"",st:"Col Rodella",la:"Campitello di Fassa",sLat:46.49729,sLon:11.75402,lLat:46.47589,lLon:11.74946,dur:"0h 50m",dk:"4",sl:"2.4",kmh:"4.8",hd:"939",msa:"2355",ml:"1416",hm:"",hg:"",ms:"",mst:"",ge:"Swing Mistral 6/24",pa:"",be:"Wolken, unruhig, seltsam, keine Klapper."},
"310":{d:"10.9.10",sz:"",lz:"",st:"Bassano Airpark da Beppi",la:"Piazza Paradiso",sLat:45.8235,sLon:11.7681,lLat:45.80836,lLon:11.77031,dur:"0h 32m",dk:"2",sl:"1.7",kmh:"3.8",hd:"655",msa:"840",ml:"185",hm:"",hg:"",ms:"",mst:"",ge:"Swing Mistral 6/24",pa:"",be:"Viel Thermik, kam aber schlecht hoch."},
"311":{d:"10.9.10",sz:"",lz:"",st:"Bassano Casete",la:"Piazza Paradiso",sLat:45.8283,sLon:11.768,lLat:45.80836,lLon:11.77031,dur:"1h 10m",dk:"2",sl:"2.2",kmh:"1.7",hd:"794",msa:"979",ml:"185",hm:"",hg:"",ms:"",mst:"",ge:"Swing Mistral 6/24",pa:"",be:"Viel Thermik, nun besser, super Sicht, Flug über Flachland."},
"312":{d:"22.10.10",sz:"",lz:"",st:"Fiescheralp Heimat",la:"Bodmen Kurve",sLat:46.414477,sLon:8.108295,lLat:46.429062,lLon:8.149327,dur:"0h 15m",dk:"3",sl:"3.5",kmh:"12.0",hd:"761",msa:"2146",ml:"1385",hm:"",hg:"",ms:"",mst:"",ge:"Swing Mistral 6/24",pa:"",be:"Landung bei Schreinerei Bodma, ruhig."},
"313":{d:"23.10.10",sz:"",lz:"",st:"Fiescheralp Heimat",la:"Fiesch",sLat:46.414477,sLon:8.108295,lLat:46.40933,lLon:8.136896,dur:"0h 14m",dk:"2",sl:"2.3",kmh:"8.6",hd:"1090",msa:"2146",ml:"1056",hm:"",hg:"",ms:"",mst:"",ge:"Swing Mistral 6/24",pa:"",be:"Westwind, ruhig."},
"314":{d:"1.1.11",sz:"",lz:"",st:"Fiescheralp Heimat",la:"Fiesch",sLat:46.414477,sLon:8.108295,lLat:46.40933,lLon:8.136896,dur:"0h 14m",dk:"2",sl:"2.3",kmh:"8.6",hd:"1090",msa:"2146",ml:"1056",hm:"",hg:"",ms:"",mst:"",ge:"Swing Mistral 6/24",pa:"",be:""},
"315":{d:"6.2.11",sz:"",lz:"",st:"Bodmen u Strasse",la:"Fiesch",sLat:46.429528,sLon:8.151025,lLat:46.40933,lLon:8.136896,dur:"0h 6m",dk:"3",sl:"2.5",kmh:"30.0",hd:"384",msa:"1440",ml:"1056",hm:"",hg:"",ms:"",mst:"",ge:"Swing Mistral 6/24",pa:"",be:"Start gut, knapp bis Fiesch."},
"316":{d:"6.2.11",sz:"",lz:"",st:"Fiescheralp Heimat",la:"Fiesch",sLat:46.414477,sLon:8.108295,lLat:46.40933,lLon:8.136896,dur:"0h 25m",dk:"4",sl:"2.3",kmh:"9.6",hd:"1090",msa:"2146",ml:"1056",hm:"",hg:"",ms:"",mst:"",ge:"Swing Mistral 6/24",pa:"",be:"Knappe Thermik."},
"317":{d:"6.2.11",sz:"",lz:"",st:"Fiescheralp Heimat",la:"Bodmen Kurve",sLat:46.414477,sLon:8.108295,lLat:46.429062,lLon:8.149327,dur:"0h 15m",dk:"6",sl:"3.5",kmh:"24.0",hd:"761",msa:"2146",ml:"1385",hm:"",hg:"",ms:"",mst:"",ge:"Swing Mistral 6/24",pa:"",be:"Thermik, kann überhöhen."},
"318":{d:"26.2.11",sz:"11:18:39",lz:"11:24:14",st:"Bodmen u Strasse",la:"Fiesch",sLat:46.429528,sLon:8.151025,lLat:46.40933,lLon:8.136896,dur:"0h 6m",dk:"3.1",sl:"2.5",kmh:"33.3",hd:"384",msa:"1440",ml:"1056",hm:"1440",hg:"",ms:"-2",mst:"",ge:"Swing Mistral 6/24",pa:"",be:"Neues Vario, Karabiner-Befestigung."},
"319":{d:"26.2.11",sz:"12:22:33",lz:"12:31:33",st:"Fiescheralp Heimat",la:"Bodmen Kurve",sLat:46.414477,sLon:8.108295,lLat:46.429062,lLon:8.149327,dur:"0h 9m",dk:"3.6",sl:"3.5",kmh:"24.0",hd:"761",msa:"2146",ml:"1385",hm:"2146",hg:"",ms:"-2",mst:"0.2",ge:"Swing Mistral 6/24",pa:"",be:"Neues Vario, Rückenwind bei Start."},
"320":{d:"10.4.11",sz:"09:34:42",lz:"10:32:22",st:"Fiescheralp Heimat",la:"Fiesch",sLat:46.414477,sLon:8.108295,lLat:46.40933,lLon:8.136896,dur:"0h 58m",dk:"10.4",sl:"2.3",kmh:"10.8",hd:"1090",msa:"2146",ml:"1056",hm:"2512",hg:"1325",ms:"-3.4",mst:"4.6",ge:"Swing Mistral 6/24",pa:"",be:"Ruppig, abgesoffen, dann hoch hinaus."},
"321":{d:"25.6.11",sz:"10:37:25",lz:"10:57:20",st:"Fiescheralp Heimat",la:"Fieschertal Flyingcenter",sLat:46.414477,sLon:8.108295,lLat:46.421062,lLon:8.145385,dur:"0h 20m",dk:"4.7",sl:"2.9",kmh:"14.2",hd:"1055",msa:"2146",ml:"1091",hm:"2190",hg:"138",ms:"-2.8",mst:"2.6",ge:"Swing Mistral 6/24",pa:"",be:"Bewölkt, trotzdem schwache Thermik."},
"322":{d:"26.6.11",sz:"10:14:57",lz:"10:40:07",st:"Fiescheralp Heimat",la:"Fieschertal Flyingcenter",sLat:46.414477,sLon:8.108295,lLat:46.421062,lLon:8.145385,dur:"0h 25m",dk:"5",sl:"2.9",kmh:"11.9",hd:"1055",msa:"2146",ml:"1091",hm:"2146",hg:"176",ms:"-2.6",mst:"2.4",ge:"Swing Mistral 6/24",pa:"",be:"Schön, schwache Thermik, ruhig."},
"323":{d:"26.6.11",sz:"11:48:20",lz:"14:25:10",st:"Fiescheralp Heimat",la:"Fieschertal Flyingcenter",sLat:46.414477,sLon:8.108295,lLat:46.421062,lLon:8.145385,dur:"2h 37m",dk:"33.2",sl:"2.9",kmh:"12.7",hd:"1055",msa:"2146",ml:"1091",hm:"3277",hg:"4619",ms:"-6.6",mst:"4.2",ge:"Swing Mistral 6/24",pa:"",be:"Gute Thermik, erst zäh, dann toll, Geschinerstock, 5km vor Sidelhorn-retour."},
"324":{d:"16.7.11",sz:"10:24:18",lz:"10:40:43",st:"Fiescheralp Heimat",la:"Fieschertal Flyingcenter",sLat:46.414477,sLon:8.108295,lLat:46.421062,lLon:8.145385,dur:"0h 16m",dk:"4.6",sl:"2.9",kmh:"16.8",hd:"1055",msa:"2146",ml:"1091",hm:"2171",hg:"85",ms:"-2.6",mst:"1.6",ge:"Swing Mistral 6/24",pa:"",be:""},
"325":{d:"17.8.11",sz:"11:16:59",lz:"13:43:19",st:"Fiescheralp Heimat",la:"Fiesch",sLat:46.414477,sLon:8.108295,lLat:46.40933,lLon:8.136896,dur:"2h 26m",dk:"42.8",sl:"2.3",kmh:"17.5",hd:"1090",msa:"2146",ml:"1056",hm:"2987",hg:"4791",ms:"-4",mst:"4.6",ge:"Swing Mistral 6/24",pa:"",be:"Sidelhorn retour."},
"326":{d:"19.8.11",sz:"09:37:39",lz:"09:41:14",st:"Bodmen o Strasse",la:"Fiesch",sLat:46.429748,sLon:8.151821,lLat:46.40933,lLon:8.136896,dur:"0h 4m",dk:"2.5",sl:"2.5",kmh:"41.9",hd:"416",msa:"1472",ml:"1056",hm:"1472",hg:"",ms:"-1.8",mst:"",ge:"Swing Mistral 6/24",pa:"",be:""},
"327":{d:"20.8.11",sz:"10:16:32",lz:"10:38:37",st:"Fiescheralp Heimat",la:"Fieschertal Flyingcenter",sLat:46.414477,sLon:8.108295,lLat:46.421062,lLon:8.145385,dur:"0h 22m",dk:"5.4",sl:"2.9",kmh:"14.7",hd:"1055",msa:"2146",ml:"1091",hm:"2148",hg:"106",ms:"-2.8",mst:"1.8",ge:"Swing Mistral 6/24",pa:"",be:""},
"328":{d:"20.8.11",sz:"12:15:08",lz:"12:39:08",st:"Fiescheralp Heimat",la:"Fieschertal Flyingcenter",sLat:46.414477,sLon:8.108295,lLat:46.421062,lLon:8.145385,dur:"0h 24m",dk:"5.8",sl:"2.9",kmh:"14.5",hd:"1055",msa:"2146",ml:"1091",hm:"2307",hg:"219",ms:"-2.8",mst:"3",ge:"Swing Mistral 6/24",pa:"",be:""},
"329":{d:"31.8.11",sz:"10:07:10",lz:"11:06:50",st:"Fiescheralp Heimat",la:"Fiesch",sLat:46.414477,sLon:8.108295,lLat:46.40933,lLon:8.136896,dur:"1h 0m",dk:"11.5",sl:"2.3",kmh:"11.6",hd:"1090",msa:"2146",ml:"1056",hm:"2647",hg:"1205",ms:"-3.6",mst:"4",ge:"Swing Mistral 6/24",pa:"",be:""},
"330":{d:"23.10.11",sz:"14:10:38",lz:"14:21:48",st:"Saint Hilaire du Touvet",la:"Lumbin",sLat:45.30726,sLon:5.89263,lLat:45.3028,lLon:5.906533,dur:"0h 11m",dk:"2.4",sl:"1.2",kmh:"12.9",hd:"665",msa:"890",ml:"225",hm:"890",hg:"",ms:"-3",mst:"",ge:"Swing Mistral 6/24",pa:"",be:"Flugreise Monaco-Südfrankreich"},
"331":{d:"23.10.11",sz:"16:07:24",lz:"16:28:24",st:"Saint Hilaire du Touvet",la:"Lumbin",sLat:45.30726,sLon:5.89263,lLat:45.3028,lLon:5.906533,dur:"0h 21m",dk:"3",sl:"1.2",kmh:"8.6",hd:"665",msa:"890",ml:"225",hm:"892",hg:"29",ms:"-3",mst:"1.4",ge:"Swing Mistral 6/24",pa:"",be:"Flugreise Monaco-Südfrankreich"},
"332":{d:"26.10.11",sz:"13:10:56",lz:"13:16:34",st:"Le Chalvet 2",la:"Saint-André-les-alpes",sLat:43.97451,sLon:6.481117,lLat:43.95843,lLon:6.509783,dur:"0h 6m",dk:"3",sl:"2.9",kmh:"32.0",hd:"634",msa:"1515",ml:"881",hm:"1515",hg:"",ms:"-4.2",mst:"",ge:"Swing Mistral 6/24",pa:"",be:"Flugreise Monaco-Südfrankreich"},
"333":{d:"26.10.11",sz:"15:18:41",lz:"16:09:11",st:"Le Chalvet 2",la:"Saint-André-les-alpes",sLat:43.97451,sLon:6.481117,lLat:43.95843,lLon:6.509783,dur:"0h 51m",dk:"12.8",sl:"2.9",kmh:"15.2",hd:"634",msa:"1515",ml:"881",hm:"1814",hg:"906",ms:"-3",mst:"3.2",ge:"Swing Mistral 6/24",pa:"",be:"Flugreise Monaco-Südfrankreich"},
"334":{d:"26.10.11",sz:"17:28:27",lz:"18:02:09",st:"Le Chalvet 2",la:"Saint-André-les-alpes",sLat:43.97451,sLon:6.481117,lLat:43.95843,lLon:6.509783,dur:"0h 34m",dk:"5.1",sl:"2.9",kmh:"9.1",hd:"634",msa:"1515",ml:"881",hm:"1498",hg:"59",ms:"-2",mst:"2.2",ge:"Swing Mistral 6/24",pa:"",be:"Flugreise Monaco-Südfrankreich"},
"335":{d:"28.10.11",sz:"10:52:50",lz:"11:06:43",st:"Col de Forclaz GS1",la:"Planfait Annecy",sLat:45.814327,sLon:6.246513,lLat:45.781599,lLon:6.222241,dur:"0h 14m",dk:"4.5",sl:"4.1",kmh:"19.4",hd:"815",msa:"1209",ml:"394",hm:"1209",hg:"",ms:"-2",mst:"",ge:"Swing Mistral 6/24",pa:"",be:"Flugreise Monaco-Südfrankreich"},
"336":{d:"28.10.11",sz:"12:35:38",lz:"12:47:44",st:"Col de Forclaz GS1",la:"Planfait Annecy",sLat:45.814327,sLon:6.246513,lLat:45.781599,lLon:6.222241,dur:"0h 12m",dk:"4.1",sl:"4.1",kmh:"20.3",hd:"815",msa:"1209",ml:"394",hm:"1208",hg:"",ms:"-2.6",mst:"",ge:"Swing Mistral 6/24",pa:"",be:"Flugreise Monaco-Südfrankreich"},
"337":{d:"28.10.11",sz:"15:04:50",lz:"15:16:56",st:"Col de Forclaz GS1",la:"Planfait Annecy",sLat:45.814327,sLon:6.246513,lLat:45.781599,lLon:6.222241,dur:"0h 12m",dk:"4.6",sl:"4.1",kmh:"22.8",hd:"815",msa:"1209",ml:"394",hm:"1209",hg:"",ms:"-2.6",mst:"",ge:"Swing Mistral 6/24",pa:"",be:"Flugreise Monaco-Südfrankreich"},
"338":{d:"28.10.11",sz:"16:35:33",lz:"17:43:18",st:"Planfait",la:"Planfait Annecy",sLat:45.85749,sLon:6.227961,lLat:45.781599,lLon:6.222241,dur:"1h 8m",dk:"10.5",sl:"8.5",kmh:"9.3",hd:"474",msa:"868",ml:"394",hm:"867",hg:"",ms:"-1.8",mst:"0.2",ge:"Swing Mistral 6/24",pa:"",be:"Flugreise Monaco-Südfrankreich"},
"339":{d:"29.10.11",sz:"12:45:28",lz:"13:00:52",st:"Sonchaux",la:"Rennaz",sLat:46.417818,sLon:6.951509,lLat:46.387098,lLon:6.923055,dur:"0h 15m",dk:"4.4",sl:"4.1",kmh:"17.1",hd:"1111",msa:"1395",ml:"284",hm:"1305",hg:"",ms:"-2",mst:"",ge:"Swing Mistral 6/24",pa:"",be:"Flugreise Monaco-Südfrankreich"},
"340":{d:"9.4.12",sz:"10:49:50",lz:"11:39:50",st:"Fiescheralp Heimat",la:"Fieschertal Flyingcenter",sLat:46.414477,sLon:8.108295,lLat:46.421062,lLon:8.145385,dur:"0h 50m",dk:"7.9",sl:"2.9",kmh:"9.5",hd:"1055",msa:"2146",ml:"1091",hm:"2379",hg:"859",ms:"-3.8",mst:"3.4",ge:"Swing Mistral 6/24",pa:"",be:""},
"341":{d:"7.7.12",sz:"14:00:10",lz:"14:21:30",st:"Fiescheralp Heimat",la:"Fieschertal Flyingcenter",sLat:46.414477,sLon:8.108295,lLat:46.421062,lLon:8.145385,dur:"0h 21m",dk:"5.7",sl:"2.9",kmh:"16.0",hd:"1055",msa:"2146",ml:"1091",hm:"2145",hg:"8",ms:"-4",mst:"2",ge:"Swing Mistral 6/24",pa:"",be:""},
"342":{d:"11.8.12",sz:"11:03:08",lz:"12:53:23",st:"Fiescheralp Heimat",la:"Fieschertal Flyingcenter",sLat:46.414477,sLon:8.108295,lLat:46.421062,lLon:8.145385,dur:"1h 50m",dk:"21.1",sl:"2.9",kmh:"11.5",hd:"1055",msa:"2146",ml:"1091",hm:"2891",hg:"2841",ms:"-3.4",mst:"4",ge:"Swing Mistral 6/24",pa:"",be:""},
"343":{d:"12.8.12",sz:"10:43:44",lz:"11:13:14",st:"Fiescheralp Heimat",la:"Fieschertal Flyingcenter",sLat:46.414477,sLon:8.108295,lLat:46.421062,lLon:8.145385,dur:"0h 30m",dk:"5.4",sl:"2.9",kmh:"11.0",hd:"1055",msa:"2146",ml:"1091",hm:"2185",hg:"309",ms:"-3.2",mst:"2.2",ge:"Swing Mistral 6/24",pa:"",be:""},
"344":{d:"18.8.12",sz:"12:07:50",lz:"13:30:10",st:"Fiescheralp Galfera",la:"Fieschertal Flyingcenter",sLat:46.404695,sLon:8.096536,lLat:46.421062,lLon:8.145385,dur:"1h 22m",dk:"11.6",sl:"4.2",kmh:"8.5",hd:"1081",msa:"2172",ml:"1091",hm:"2818",hg:"1574",ms:"-3.2",mst:"3.8",ge:"Swing Mistral 6/24",pa:"",be:""},
"345":{d:"8.9.12",sz:"09:56:07",lz:"10:33:47",st:"Fiescheralp Heimat",la:"Fieschertal Flyingcenter",sLat:46.414477,sLon:8.108295,lLat:46.421062,lLon:8.145385,dur:"0h 38m",dk:"6.9",sl:"2.9",kmh:"11.0",hd:"1055",msa:"2146",ml:"1091",hm:"2338",hg:"368",ms:"-2.6",mst:"2",ge:"Swing Mistral 6/24",pa:"",be:""},
"346":{d:"8.9.12",sz:"11:52:56",lz:"14:58:46",st:"Fiescheralp Heimat",la:"Fieschertal Flyingcenter",sLat:46.414477,sLon:8.108295,lLat:46.421062,lLon:8.145385,dur:"3h 6m",dk:"44.5",sl:"2.9",kmh:"14.4",hd:"1055",msa:"2146",ml:"1091",hm:"3176",hg:"4685",ms:"-4.4",mst:"3.8",ge:"Swing Mistral 6/24",pa:"",be:"Sidelhorn retour."},
"347":{d:"21.10.12",sz:"10:14:44",lz:"10:27:14",st:"Fiescheralp Galfera",la:"Fieschertal Flyingcenter",sLat:46.404695,sLon:8.096536,lLat:46.421062,lLon:8.145385,dur:"0h 13m",dk:"4.4",sl:"4.2",kmh:"21.1",hd:"1081",msa:"2172",ml:"1091",hm:"2171",hg:"",ms:"-3",mst:"",ge:"Swing Mistral 6/24",pa:"",be:""},
"348":{d:"21.10.12",sz:"11:29:32",lz:"11:53:37",st:"Fiescheralp Heimat",la:"Fieschertal Flyingcenter",sLat:46.414477,sLon:8.108295,lLat:46.421062,lLon:8.145385,dur:"0h 24m",dk:"3.7",sl:"2.9",kmh:"9.2",hd:"1055",msa:"2146",ml:"1091",hm:"2146",hg:"38",ms:"-2.4",mst:"1.8",ge:"Swing Mistral 6/24",pa:"",be:""},
"349":{d:"21.10.12",sz:"13:11:55",lz:"13:26:20",st:"Fiescheralp Heimat",la:"Fieschertal Flyingcenter",sLat:46.414477,sLon:8.108295,lLat:46.421062,lLon:8.145385,dur:"0h 14m",dk:"4.5",sl:"2.9",kmh:"18.7",hd:"1055",msa:"2146",ml:"1091",hm:"2145",hg:"",ms:"-2.2",mst:"0.2",ge:"Swing Mistral 6/24",pa:"",be:""},
"350":{d:"13.11.12",sz:"12:56:03",lz:"13:07:48",st:"Colimacons",la:"St. Leu",sLat:-21.1344,sLon:55.30008,lLat:-21.1522,lLon:55.27915,dur:"0h 12m",dk:"3.8",sl:"2.9",kmh:"19.4",hd:"652",msa:"662",ml:"10",hm:"662",hg:"8",ms:"-3",mst:"1.4",ge:"Swing Mistral 6/24",pa:"",be:"Ferien La Réunion, Peter, Regina, Hansi, Mariette, Konstatin, Doris"},
"351":{d:"14.11.12",sz:"09:06:12",lz:"09:27:47",st:"Colimacons",la:"St. Leu",sLat:-21.1344,sLon:55.30008,lLat:-21.1522,lLon:55.27915,dur:"0h 22m",dk:"3.7",sl:"2.9",kmh:"10.3",hd:"652",msa:"662",ml:"10",hm:"662",hg:"51",ms:"-2.2",mst:"1.4",ge:"Swing Mistral 6/24",pa:"",be:"Ferien La Réunion, Peter, Regina, Hansi, Mariette, Konstatin, Doris"},
"352":{d:"14.11.12",sz:"18:50:15",lz:"19:04:20",st:"Colimacons",la:"St. Leu",sLat:-21.1344,sLon:55.30008,lLat:-21.1522,lLon:55.27915,dur:"0h 14m",dk:"3.9",sl:"2.9",kmh:"16.6",hd:"652",msa:"662",ml:"10",hm:"662",hg:"2",ms:"-2",mst:"0.6",ge:"Swing Mistral 6/24",pa:"",be:"Ferien La Réunion, Peter, Regina, Hansi, Mariette, Konstatin, Doris"},
"353":{d:"15.11.12",sz:"09:27:03",lz:"09:49:41",st:"Colimacons",la:"St. Leu",sLat:-21.1344,sLon:55.30008,lLat:-21.1522,lLon:55.27915,dur:"0h 23m",dk:"4.3",sl:"2.9",kmh:"11.4",hd:"652",msa:"662",ml:"10",hm:"662",hg:"73",ms:"-2.2",mst:"1.6",ge:"Swing Mistral 6/24",pa:"",be:"Ferien La Réunion, Peter, Regina, Hansi, Mariette, Konstatin, Doris"},
"354":{d:"19.11.12",sz:"10:38:14",lz:"11:07:19",st:"Colimacons",la:"St. Leu",sLat:-21.1344,sLon:55.30008,lLat:-21.1522,lLon:55.27915,dur:"0h 29m",dk:"5.4",sl:"2.9",kmh:"11.1",hd:"652",msa:"662",ml:"10",hm:"662",hg:"205",ms:"-2.2",mst:"2",ge:"Advance Pi 23",pa:"",be:"Advance Pi (Hansi)"},
"355":{d:"21.11.12",sz:"18:44:45",lz:"18:59:00",st:"Colimacons",la:"St. Leu",sLat:-21.1344,sLon:55.30008,lLat:-21.1522,lLon:55.27915,dur:"0h 14m",dk:"2.9",sl:"2.9",kmh:"12.2",hd:"652",msa:"662",ml:"10",hm:"662",hg:"27",ms:"-2.2",mst:"1.2",ge:"Swing Mistral 6/24",pa:"",be:"Ferien La Réunion, Peter, Regina, Hansi, Mariette, Konstatin, Doris"},
"356":{d:"23.11.12",sz:"09:32:43",lz:"09:45:41",st:"Colimacons",la:"St. Leu",sLat:-21.1344,sLon:55.30008,lLat:-21.1522,lLon:55.27915,dur:"0h 13m",dk:"3.9",sl:"2.9",kmh:"18.0",hd:"652",msa:"662",ml:"10",hm:"662",hg:"2",ms:"-2.4",mst:"0.6",ge:"Swing Mistral 6/24",pa:"",be:"Ferien La Réunion, Peter, Regina, Hansi, Mariette, Konstatin, Doris"},
"357":{d:"9.3.13",sz:"09:52:42",lz:"10:03:12",st:"Fiescheralp Heimat",la:"Fieschertal Flyingcenter",sLat:46.414477,sLon:8.108295,lLat:46.421062,lLon:8.145385,dur:"0h 11m",dk:"4",sl:"2.9",kmh:"22.9",hd:"1055",msa:"2146",ml:"1091",hm:"2145",hg:"",ms:"-2.8",mst:"",ge:"Advance Pi 23",pa:"",be:"Advance Pi"},
"358":{d:"10.3.13",sz:"10:49:49",lz:"11:01:24",st:"Fiescheralp Heimat",la:"Fiescheralp Heimat",sLat:46.414477,sLon:8.108295,lLat:46.413394,lLon:8.108867,dur:"0h 12m",dk:"0.9",sl:"0.1",kmh:"4.7",hd:"0",msa:"2146",ml:"2146",hm:"2261",hg:"215",ms:"-2.8",mst:"3",ge:"Advance Pi 23",pa:"",be:"Advance Pi"},
"359":{d:"10.3.13",sz:"11:59:37",lz:"12:17:02",st:"Fiescheralp Heimat",la:"Fieschertal Flyingcenter",sLat:46.414477,sLon:8.108295,lLat:46.421062,lLon:8.145385,dur:"0h 17m",dk:"4.5",sl:"2.9",kmh:"15.5",hd:"1055",msa:"2146",ml:"1091",hm:"2282",hg:"197",ms:"-3.4",mst:"3.6",ge:"Advance Pi 23",pa:"",be:"Advance Pi"},
"360":{d:"3.4.13",sz:"11:29:38",lz:"11:44:48",st:"Jakobshorn Jatzhütte",la:"Davos Jakobshorn Winter",sLat:46.766194,sLon:9.849876,lLat:46.78741,lLon:9.817978,dur:"0h 15m",dk:"4.4",sl:"3.4",kmh:"17.4",hd:"967",msa:"2499",ml:"1532",hm:"2499",hg:"27",ms:"-3.4",mst:"1.8",ge:"Advance Pi 23",pa:"",be:"Advance Pi"},
"361":{d:"20.5.13",sz:"12:14:38",lz:"12:39:43",st:"Zugerberg",la:"Zug",sLat:47.14813,sLon:8.535748,lLat:47.150094,lLon:8.507689,dur:"0h 25m",dk:"4.1",sl:"2.1",kmh:"9.8",hd:"475",msa:"950",ml:"475",hm:"953",hg:"181",ms:"-2",mst:"1.6",ge:"Swing Mistral 6/24",pa:"",be:""},
"362":{d:"27.5.13",sz:"10:01:36",lz:"10:17:51",st:"Roncola",la:"Palazzago-Barzana",sLat:45.767972,sLon:9.548892,lLat:45.745852,lLon:9.556139,dur:"0h 16m",dk:"2.9",sl:"2.5",kmh:"10.7",hd:"709",msa:"1069",ml:"360",hm:"1069",hg:"20",ms:"-3.6",mst:"1.8",ge:"Swing Mistral 6/24",pa:"",be:"Toskana-Safari"},
"363":{d:"27.5.13",sz:"14:17:14",lz:"14:45:02",st:"Cornizzolo",la:"Suello",sLat:45.832221,sLon:9.301198,lLat:45.817776,lLon:9.318183,dur:"0h 28m",dk:"5.2",sl:"2.1",kmh:"11.2",hd:"790",msa:"1066",ml:"276",hm:"1348",hg:"416",ms:"-3",mst:"3.8",ge:"Swing Mistral 6/24",pa:"",be:"Toskana-Safari"},
"364":{d:"27.5.13",sz:"18:43:02",lz:"19:16:17",st:"Torre de Busi",la:"Palazzago-Barzana",sLat:45.779597,sLon:9.507364,lLat:45.745852,lLon:9.556139,dur:"0h 33m",dk:"7.2",sl:"5.3",kmh:"13.0",hd:"897",msa:"1257",ml:"360",hm:"1801",hg:"584",ms:"-3",mst:"3.8",ge:"Swing Mistral 6/24",pa:"",be:"Toskana-Safari"},
"365":{d:"28.5.13",sz:"11:56:44",lz:"12:07:29",st:"San Fermo",la:"Casazza",sLat:45.74172,sLon:9.9505,lLat:45.756191,lLon:9.914431,dur:"0h 11m",dk:"3.5",sl:"3.2",kmh:"19.5",hd:"855",msa:"1265",ml:"410",hm:"1304",hg:"",ms:"-3",mst:"1.2",ge:"Swing Mistral 6/24",pa:"",be:"Toskana-Safari"},
"366":{d:"28.5.13",sz:"19:01:47",lz:"19:14:45",st:"Pizzorna",la:"Marlia Via delle Tese",sLat:43.93393,sLon:10.58386,lLat:43.89991,lLon:10.57098,dur:"0h 13m",dk:"4.9",sl:"3.9",kmh:"22.7",hd:"836",msa:"987",ml:"151",hm:"987",hg:"",ms:"-2",mst:"",ge:"Swing Mistral 6/24",pa:"",be:"Toskana-Safari"},
"367":{d:"15.6.13",sz:"10:27:45",lz:"10:41:15",st:"Fiescheralp Heimat",la:"Fieschertal Flyingcenter",sLat:46.414477,sLon:8.108295,lLat:46.421062,lLon:8.145385,dur:"0h 14m",dk:"4.4",sl:"2.9",kmh:"19.6",hd:"1055",msa:"2146",ml:"1091",hm:"2146",hg:"",ms:"-3",mst:"",ge:"Swing Mistral 6/24",pa:"",be:""},
"368":{d:"15.6.13",sz:"12:00:00",lz:"12:10:00",st:"Bellwald Mutti",la:"Fieschertal Flyingcenter",sLat:46.43749,sLon:8.15544,lLat:46.421062,lLon:8.145385,dur:"0h 10m",dk:"4.2",sl:"2.0",kmh:"25.2",hd:"688",msa:"1779",ml:"1091",hm:"1779",hg:"",ms:"",mst:"",ge:"Swing Mistral 6/24",pa:"",be:""},
"369":{d:"16.6.13",sz:"08:32:16",lz:"08:46:46",st:"Fiescheralp Heimat",la:"Fieschertal Flyingcenter",sLat:46.414477,sLon:8.108295,lLat:46.421062,lLon:8.145385,dur:"0h 15m",dk:"4.2",sl:"2.9",kmh:"17.4",hd:"1055",msa:"2146",ml:"1091",hm:"2146",hg:"",ms:"-2.4",mst:"1.2",ge:"Swing Mistral 6/24",pa:"",be:""},
"370":{d:"16.6.13",sz:"10:35:11",lz:"10:54:26",st:"Fiescheralp Heimat",la:"Fieschertal Flyingcenter",sLat:46.414477,sLon:8.108295,lLat:46.421062,lLon:8.145385,dur:"0h 19m",dk:"6.8",sl:"2.9",kmh:"21.2",hd:"1055",msa:"2146",ml:"1091",hm:"2162",hg:"35",ms:"-3.4",mst:"2.2",ge:"Swing Mistral 6/24",pa:"",be:""},
"371":{d:"16.6.13",sz:"13:08:29",lz:"13:19:47",st:"Bellwald Mutti",la:"Fieschertal Flyingcenter",sLat:46.43749,sLon:8.15544,lLat:46.421062,lLon:8.145385,dur:"0h 11m",dk:"2.9",sl:"2.0",kmh:"15.4",hd:"688",msa:"1779",ml:"1091",hm:"1716",hg:"53",ms:"-2.8",mst:"1.8",ge:"Swing Mistral 6/24",pa:"",be:""},
"372":{d:"12.7.13",sz:"18:51:00",lz:"19:03:58",st:"Fronalpstock Bergstation",la:"Ried Talstation",sLat:46.970179,sLon:8.637632,lLat:46.989549,lLon:8.636606,dur:"0h 13m",dk:"3.5",sl:"2.2",kmh:"16.2",hd:"1098",msa:"1895",ml:"797",hm:"1895",hg:"",ms:"",mst:"",ge:"Advance Pi 23",pa:"",be:"Advance Pi"},
"373":{d:"14.7.13",sz:"10:46:08",lz:"10:57:13",st:"Gniepen Rossberg",la:"Goldau Vogelsang",sLat:47.081685,sLon:8.548137,lLat:47.051871,lLon:8.543638,dur:"0h 11m",dk:"4.3",sl:"3.3",kmh:"23.3",hd:"1075",msa:"1551",ml:"476",hm:"1550",hg:"",ms:"-3",mst:"",ge:"Advance Pi 23",pa:"",be:"Hike & Fly, Advance Pi"},
"374":{d:"20.7.13",sz:"08:30:08",lz:"08:42:33",st:"Fiescheralp Heimat",la:"Fieschertal Flyingcenter",sLat:46.414477,sLon:8.108295,lLat:46.421062,lLon:8.145385,dur:"0h 12m",dk:"2.9",sl:"2.9",kmh:"14.0",hd:"1055",msa:"2146",ml:"1091",hm:"2146",hg:"",ms:"-2.2",mst:"",ge:"Swing Mistral 6/24",pa:"",be:""},
"375":{d:"20.7.13",sz:"09:58:01",lz:"10:15:11",st:"Fiescheralp Heimat",la:"Fieschertal Flyingcenter",sLat:46.414477,sLon:8.108295,lLat:46.421062,lLon:8.145385,dur:"0h 17m",dk:"3.5",sl:"2.9",kmh:"12.2",hd:"1055",msa:"2146",ml:"1091",hm:"2146",hg:"10",ms:"-2.4",mst:"1.2",ge:"Swing Mistral 6/24",pa:"",be:""},
"376":{d:"20.7.13",sz:"11:21:31",lz:"11:54:11",st:"Fiescheralp Heimat",la:"Fieschertal Flyingcenter",sLat:46.414477,sLon:8.108295,lLat:46.421062,lLon:8.145385,dur:"0h 33m",dk:"6.9",sl:"2.9",kmh:"12.7",hd:"1055",msa:"2146",ml:"1091",hm:"2596",hg:"492",ms:"-2.6",mst:"3.2",ge:"Swing Mistral 6/24",pa:"",be:""},
"377":{d:"21.7.13",sz:"09:28:27",lz:"09:44:27",st:"Eggerhorn Süd",la:"Fieschertal Flyingcenter",sLat:46.382703,sLon:8.187432,lLat:46.421062,lLon:8.145385,dur:"0h 16m",dk:"8.6",sl:"5.3",kmh:"32.3",hd:"1349",msa:"2440",ml:"1091",hm:"2439",hg:"",ms:"-3",mst:"",ge:"Advance Pi 23",pa:"",be:"Hike & Fly, Advance Pi, mit Peter und Mariette"},
"378":{d:"1.8.13",sz:"10:24:09",lz:"10:29:09",st:"Rigi Kulm",la:"Guggli Klösterli",sLat:47.054774,sLon:8.486321,lLat:47.040288,lLon:8.492578,dur:"0h 5m",dk:"3",sl:"1.7",kmh:"36.0",hd:"473",msa:"1750",ml:"1277",hm:"1748",hg:"",ms:"-1.8",mst:"",ge:"Advance Pi 23",pa:"",be:"Hike & Fly, Advance Pi, konnte Staffelhöhe nicht überfliegen, Notlandung"},
"379":{d:"1.8.13",sz:"11:56:45",lz:"12:12:35",st:"Rigi Kulm",la:"Küssnacht",sLat:47.054774,sLon:8.486321,lLat:47.06739,lLon:8.435432,dur:"0h 16m",dk:"4.7",sl:"4.1",kmh:"17.8",hd:"1287",msa:"1750",ml:"463",hm:"1750",hg:"",ms:"-2",mst:"0.2",ge:"Advance Pi 23",pa:"",be:"Hike & Fly, Advance Pi"},
"380":{d:"11.8.13",sz:"07:00:00",lz:"07:04:00",st:"Bodmen u Strasse",la:"Fieschertal Flyingcenter",sLat:46.429528,sLon:8.151025,lLat:46.421062,lLon:8.145385,dur:"0h 4m",dk:"2",sl:"1.0",kmh:"30.0",hd:"349",msa:"1440",ml:"1091",hm:"1440",hg:"",ms:"",mst:"",ge:"Swing Mistral 6/24",pa:"",be:""},
"381":{d:"11.8.13",sz:"08:34:33",lz:"08:49:18",st:"Fiescheralp Heimat",la:"Fieschertal Flyingcenter",sLat:46.414477,sLon:8.108295,lLat:46.421062,lLon:8.145385,dur:"0h 15m",dk:"6.8",sl:"2.9",kmh:"27.7",hd:"1055",msa:"2146",ml:"1091",hm:"2145",hg:"",ms:"-2.2",mst:"1",ge:"Swing Mistral 6/24",pa:"",be:""},
"382":{d:"11.8.13",sz:"10:07:02",lz:"10:19:22",st:"Fiescheralp Heimat",la:"Bodmen Kurve",sLat:46.414477,sLon:8.108295,lLat:46.429062,lLon:8.149327,dur:"0h 12m",dk:"4.9",sl:"3.5",kmh:"23.8",hd:"761",msa:"2146",ml:"1385",hm:"2148",hg:"144",ms:"-2.8",mst:"3",ge:"Swing Mistral 6/24",pa:"",be:""},
"383":{d:"15.8.13",sz:"08:38:41",lz:"08:56:01",st:"Fiescheralp Heimat",la:"Fieschertal Flyingcenter",sLat:46.414477,sLon:8.108295,lLat:46.421062,lLon:8.145385,dur:"0h 17m",dk:"4.3",sl:"2.9",kmh:"14.9",hd:"1055",msa:"2146",ml:"1091",hm:"2145",hg:"",ms:"-2",mst:"",ge:"Swing Mistral 6/24",pa:"",be:""},
"384":{d:"15.8.13",sz:"10:02:44",lz:"10:22:39",st:"Fiescheralp Heimat",la:"Fieschertal Flyingcenter",sLat:46.414477,sLon:8.108295,lLat:46.421062,lLon:8.145385,dur:"0h 20m",dk:"4.7",sl:"2.9",kmh:"14.2",hd:"1055",msa:"2146",ml:"1091",hm:"2170",hg:"41",ms:"-2.4",mst:"1.8",ge:"Swing Mistral 6/24",pa:"",be:""},
"385":{d:"16.8.13",sz:"11:27:14",lz:"14:14:59",st:"Fiescheralp Galfera",la:"Fieschertal Flyingcenter",sLat:46.404695,sLon:8.096536,lLat:46.421062,lLon:8.145385,dur:"2h 48m",dk:"43.9",sl:"4.2",kmh:"15.7",hd:"1081",msa:"2172",ml:"1091",hm:"3295",hg:"5229",ms:"-4",mst:"5",ge:"Swing Mistral 6/24",pa:"",be:"Sidelhorn retour."},
"386":{d:"17.8.13",sz:"10:00:10",lz:"10:23:43",st:"Fiescheralp Heimat",la:"Fieschertal Flyingcenter",sLat:46.414477,sLon:8.108295,lLat:46.421062,lLon:8.145385,dur:"0h 24m",dk:"5.6",sl:"2.9",kmh:"14.3",hd:"1055",msa:"2146",ml:"1091",hm:"2172",hg:"155",ms:"-2.8",mst:"2.6",ge:"Swing Mistral 6/24",pa:"",be:""},
"387":{d:"18.8.13",sz:"08:50:00",lz:"09:02:00",st:"Steibenkreuz Sommer",la:"Bodmen Stall",sLat:46.44903,sLon:8.1627,lLat:46.425903,lLon:8.152421,dur:"0h 12m",dk:"3",sl:"2.7",kmh:"15.0",hd:"1070",msa:"2440",ml:"1370",hm:"2450",hg:"",ms:"",mst:"",ge:"Advance Pi 23",pa:"",be:"Hike & Fly Advance Pi, nach Anstieg 2:15 H"},
"388":{d:"26.8.13",sz:"11:20:00",lz:"11:32:00",st:"Bellwald Ried unten",la:"Bodmen Stall",sLat:46.432528,sLon:8.153185,lLat:46.425903,lLon:8.152421,dur:"0h 12m",dk:"1.8",sl:"0.7",kmh:"9.0",hd:"210",msa:"1580",ml:"1370",hm:"1580",hg:"",ms:"",mst:"",ge:"Advance Pi 23",pa:"",be:"Hike & Fly, nach Anstieg 0:20 H"},
"389":{d:"26.8.13",sz:"12:28:08",lz:"12:41:48",st:"Fiescheralp Heimat",la:"Bodmen Stall",sLat:46.414477,sLon:8.108295,lLat:46.425903,lLon:8.152421,dur:"0h 14m",dk:"4",sl:"3.6",kmh:"17.6",hd:"776",msa:"2146",ml:"1370",hm:"2146",hg:"34",ms:"-2.6",mst:"2",ge:"Swing Mistral 6/24",pa:"",be:""},
"390":{d:"27.8.13",sz:"10:24:39",lz:"10:33:04",st:"Bellwald Mutti",la:"Bodmen unterh Wohnung",sLat:46.43749,sLon:8.15544,lLat:46.426778,lLon:8.151977,dur:"0h 8m",dk:"2.2",sl:"1.2",kmh:"15.7",hd:"394",msa:"1779",ml:"1385",hm:"1724",hg:"23",ms:"-2.2",mst:"0.2",ge:"Swing Mistral 6/24",pa:"",be:""},
"391":{d:"29.8.13",sz:"08:28:09",lz:"08:31:44",st:"Bodmen o Strasse",la:"Fieschertal Flyingcenter",sLat:46.429748,sLon:8.151821,lLat:46.421062,lLon:8.145385,dur:"0h 4m",dk:"1.1",sl:"1.1",kmh:"18.4",hd:"381",msa:"1472",ml:"1091",hm:"1470",hg:"",ms:"-2",mst:"",ge:"Swing Mistral 6/24",pa:"",be:""},
"392":{d:"29.8.13",sz:"10:13:46",lz:"10:43:21",st:"Fiescheralp Heimat",la:"Fieschertal Flyingcenter",sLat:46.414477,sLon:8.108295,lLat:46.421062,lLon:8.145385,dur:"0h 30m",dk:"4.5",sl:"2.9",kmh:"9.1",hd:"1055",msa:"2146",ml:"1091",hm:"2146",hg:"231",ms:"-3.6",mst:"3",ge:"Swing Mistral 6/24",pa:"",be:""},
"393":{d:"29.8.13",sz:"11:29:04",lz:"11:58:24",st:"Fiescheralp Heimat",la:"Fieschertal Flyingcenter",sLat:46.414477,sLon:8.108295,lLat:46.421062,lLon:8.145385,dur:"0h 29m",dk:"8.7",sl:"2.9",kmh:"17.8",hd:"1055",msa:"2146",ml:"1091",hm:"2443",hg:"380",ms:"-2.2",mst:"2",ge:"Swing Mistral 6/24",pa:"",be:""},
"394":{d:"29.8.13",sz:"13:03:14",lz:"13:34:54",st:"Fiescheralp Heimat",la:"Fieschertal Flyingcenter",sLat:46.414477,sLon:8.108295,lLat:46.421062,lLon:8.145385,dur:"0h 32m",dk:"6.7",sl:"2.9",kmh:"12.7",hd:"1055",msa:"2146",ml:"1091",hm:"2567",hg:"598",ms:"-3.8",mst:"3.8",ge:"Swing Mistral 6/24",pa:"",be:""},
"395":{d:"30.8.13",sz:"09:59:31",lz:"10:19:36",st:"Fiescheralp Heimat",la:"Fieschertal Flyingcenter",sLat:46.414477,sLon:8.108295,lLat:46.421062,lLon:8.145385,dur:"0h 20m",dk:"4.6",sl:"2.9",kmh:"13.7",hd:"1055",msa:"2146",ml:"1091",hm:"2148",hg:"30",ms:"-2",mst:"2",ge:"Swing Mistral 6/24",pa:"",be:""},
"396":{d:"30.8.13",sz:"11:32:34",lz:"12:39:34",st:"Fiescheralp Heimat",la:"Fieschertal Flyingcenter",sLat:46.414477,sLon:8.108295,lLat:46.421062,lLon:8.145385,dur:"1h 7m",dk:"13.4",sl:"2.9",kmh:"12.0",hd:"1055",msa:"2146",ml:"1091",hm:"2690",hg:"1679",ms:"-2.8",mst:"3.2",ge:"Swing Mistral 6/24",pa:"",be:""},
"397":{d:"22.9.13",sz:"11:50:34",lz:"12:12:44",st:"Fiescheralp Galfera",la:"Fieschertal Flyingcenter",sLat:46.404695,sLon:8.096536,lLat:46.421062,lLon:8.145385,dur:"0h 22m",dk:"5.8",sl:"4.2",kmh:"15.7",hd:"1081",msa:"2172",ml:"1091",hm:"2172",hg:"6",ms:"-2.2",mst:"1",ge:"Swing Mistral 6/24",pa:"",be:""},
"398":{d:"22.9.13",sz:"13:26:02",lz:"13:38:32",st:"Fiescheralp Heimat",la:"Fiesch",sLat:46.414477,sLon:8.108295,lLat:46.40933,lLon:8.136896,dur:"0h 13m",dk:"7.6",sl:"2.3",kmh:"36.5",hd:"1090",msa:"2146",ml:"1056",hm:"2146",hg:"",ms:"-2.6",mst:"",ge:"Swing Mistral 6/24",pa:"",be:""},
"399":{d:"1.1.14",sz:"15:20:00",lz:"16:00:00",st:"Mittelallalin Station",la:"Saas Almagell",sLat:46.058017,sLon:7.904067,lLat:46.095351,lLon:7.959327,dur:"0h 40m",dk:"8",sl:"5.9",kmh:"12.0",hd:"1784",msa:"3454",ml:"1670",hm:"3454",hg:"",ms:"",mst:"",ge:"Advance Pi 23",pa:"",be:"Advance Pi, kaum Wind, Skistart Richtung NE mit langem Anlauf."},
"400":{d:"23.2.14",sz:"10:22:25",lz:"10:38:45",st:"Fiescheralp Heimat",la:"Fiescheralp Heimat",sLat:46.414477,sLon:8.108295,lLat:46.413394,lLon:8.108867,dur:"0h 16m",dk:"1.4",sl:"0.1",kmh:"5.1",hd:"0",msa:"2146",ml:"2146",hm:"2276",hg:"251",ms:"-2.8",mst:"2.2",ge:"Swing Mistral 6/24",pa:"",be:"Toplanding beim Startplatz"},
"401":{d:"23.2.14",sz:"11:32:01",lz:"11:53:21",st:"Fiescheralp Heimat",la:"Fieschertal Flyingcenter",sLat:46.414477,sLon:8.108295,lLat:46.421062,lLon:8.145385,dur:"0h 21m",dk:"7.2",sl:"2.9",kmh:"20.3",hd:"1055",msa:"2146",ml:"1091",hm:"2157",hg:"66",ms:"-2.4",mst:"1.6",ge:"Swing Mistral 6/24",pa:"",be:""},
"402":{d:"18.5.14",sz:"11:53:45",lz:"12:00:40",st:"Zugerberg",la:"Zug",sLat:47.14813,sLon:8.535748,lLat:47.150094,lLon:8.507689,dur:"0h 7m",dk:"3",sl:"2.1",kmh:"26.0",hd:"475",msa:"950",ml:"475",hm:"948",hg:"",ms:"-3",mst:"1",ge:"Swing Mistral 6/24",pa:"",be:""},
"403":{d:"29.5.14",sz:"08:41:32",lz:"08:49:22",st:"Bellwald Mutti",la:"Fieschertal Flyingcenter",sLat:46.43749,sLon:8.15544,lLat:46.421062,lLon:8.145385,dur:"0h 8m",dk:"1.9",sl:"2.0",kmh:"14.6",hd:"688",msa:"1779",ml:"1091",hm:"1697",hg:"",ms:"-4.2",mst:"0.4",ge:"Advance Sigma 9/25",pa:"",be:"Advance Sigma 9/25"},
"404":{d:"29.5.14",sz:"09:55:44",lz:"10:27:12",st:"Fiescheralp Heimat",la:"Fieschertal Flyingcenter",sLat:46.414477,sLon:8.108295,lLat:46.421062,lLon:8.145385,dur:"0h 31m",dk:"6.1",sl:"2.9",kmh:"11.6",hd:"1055",msa:"2146",ml:"1091",hm:"2408",hg:"438",ms:"-4.4",mst:"4",ge:"Advance Sigma 9/25",pa:"",be:"Advance Sigma 9/25"},
"405":{d:"29.5.14",sz:"11:50:52",lz:"12:03:42",st:"Bellwald Mutti",la:"Fieschertal Flyingcenter",sLat:46.43749,sLon:8.15544,lLat:46.421062,lLon:8.145385,dur:"0h 13m",dk:"1.9",sl:"2.0",kmh:"8.9",hd:"688",msa:"1779",ml:"1091",hm:"1698",hg:"5",ms:"-3.6",mst:"1",ge:"Advance Sigma 9/25",pa:"",be:"Advance Sigma 9/25"},
"406":{d:"31.5.14",sz:"08:28:44",lz:"08:36:34",st:"Bellwald Mutti",la:"Fieschertal Flyingcenter",sLat:46.43749,sLon:8.15544,lLat:46.421062,lLon:8.145385,dur:"0h 8m",dk:"2",sl:"2.0",kmh:"15.3",hd:"688",msa:"1779",ml:"1091",hm:"1696",hg:"",ms:"-2.4",mst:"",ge:"Advance Sigma 9/25",pa:"",be:"Advance Sigma 9/25"},
"407":{d:"31.5.14",sz:"10:00:02",lz:"10:53:47",st:"Fiescheralp Heimat",la:"Fieschertal Flyingcenter",sLat:46.414477,sLon:8.108295,lLat:46.421062,lLon:8.145385,dur:"0h 54m",dk:"12.4",sl:"2.9",kmh:"13.8",hd:"1055",msa:"2146",ml:"1091",hm:"2676",hg:"1476",ms:"-4.2",mst:"5.4",ge:"Advance Sigma 9/25",pa:"",be:"Advance Sigma 9/25"},
"408":{d:"1.6.14",sz:"11:00:04",lz:"13:03:54",st:"Fiescheralp Heimat",la:"Fieschertal Flyingcenter",sLat:46.414477,sLon:8.108295,lLat:46.421062,lLon:8.145385,dur:"2h 4m",dk:"39.2",sl:"2.9",kmh:"19.0",hd:"1055",msa:"2146",ml:"1091",hm:"3114",hg:"3898",ms:"-3.6",mst:"5.2",ge:"Nova Mentor 3 Light S",pa:"",be:"Nova Mentor 3 Light S, kurz vor Sidelhorn"},
"409":{d:"7.6.14",sz:"10:44:12",lz:"13:13:42",st:"Fiescheralp Galfera",la:"Fieschertal Flyingcenter",sLat:46.404695,sLon:8.096536,lLat:46.421062,lLon:8.145385,dur:"2h 30m",dk:"43.1",sl:"4.2",kmh:"17.3",hd:"1081",msa:"2172",ml:"1091",hm:"3224",hg:"5005",ms:"-4.6",mst:"5.2",ge:"Advance Sigma 9/25",pa:"",be:"Advance Sigma 9/25, Sidelhorn retour."},
"410":{d:"8.6.14",sz:"10:47:08",lz:"13:28:48",st:"Fiescheralp Galfera",la:"Fieschertal Flyingcenter",sLat:46.404695,sLon:8.096536,lLat:46.421062,lLon:8.145385,dur:"2h 42m",dk:"57.2",sl:"4.2",kmh:"21.2",hd:"1081",msa:"2172",ml:"1091",hm:"3579",hg:"5465",ms:"-4.2",mst:"5",ge:"Nova Mentor 3 Light S",pa:"",be:"Nova Mentor 3 Light S, Sidelhorn retour."},
"411":{d:"22.6.14",sz:"14:25:22",lz:"15:11:07",st:"Elfer",la:"Neustift Stubai",sLat:47.09708,sLon:11.32325,lLat:47.11218,lLon:11.31576,dur:"0h 46m",dk:"4.7",sl:"1.8",kmh:"6.2",hd:"890",msa:"1868",ml:"978",hm:"1868",hg:"407",ms:"-3.6",mst:"2.2",ge:"Nova Mentor 3 Light XS",pa:"",be:"Erster Flug mit Mentor 3 light XS"},
"412":{d:"23.6.14",sz:"09:24:06",lz:"09:56:29",st:"Schlick 2000 Kreuzjoch",la:"Neustift Stubai",sLat:47.14512,sLon:11.30815,lLat:47.11218,lLon:11.31576,dur:"0h 32m",dk:"5.7",sl:"3.7",kmh:"10.6",hd:"1122",msa:"2100",ml:"978",hm:"2292",hg:"302",ms:"-4.6",mst:"3.6",ge:"Nova Mentor 3 Light XS",pa:"",be:""},
"413":{d:"23.6.14",sz:"11:18:20",lz:"11:50:55",st:"Elfer",la:"Neustift Stubai",sLat:47.09708,sLon:11.32325,lLat:47.11218,lLon:11.31576,dur:"0h 33m",dk:"4.9",sl:"1.8",kmh:"9.0",hd:"890",msa:"1868",ml:"978",hm:"2028",hg:"352",ms:"-2.6",mst:"2.8",ge:"Nova Mentor 3 Light XS",pa:"",be:""},
"414":{d:"25.6.14",sz:"10:50:00",lz:"11:06:25",st:"Schlick 2000 Kreuzjoch",la:"Neustift Stubai",sLat:47.14512,sLon:11.30815,lLat:47.11218,lLon:11.31576,dur:"0h 16m",dk:"5.2",sl:"3.7",kmh:"19.0",hd:"1122",msa:"2100",ml:"978",hm:"2099",hg:"",ms:"-3.2",mst:"0.2",ge:"Nova Mentor 3 Light XS",pa:"",be:""},
"415":{d:"25.6.14",sz:"12:06:09",lz:"12:29:19",st:"Elfer",la:"Neustift Stubai",sLat:47.09708,sLon:11.32325,lLat:47.11218,lLon:11.31576,dur:"0h 23m",dk:"3.7",sl:"1.8",kmh:"9.6",hd:"890",msa:"1868",ml:"978",hm:"1868",hg:"79",ms:"-2.2",mst:"2.4",ge:"Nova Mentor 3 Light XS",pa:"",be:""},
"416":{d:"25.6.14",sz:"16:30:00",lz:"16:44:00",st:"Elfer",la:"Neustift Stubai",sLat:47.09708,sLon:11.32325,lLat:47.11218,lLon:11.31576,dur:"0h 14m",dk:"3.5",sl:"1.8",kmh:"15.0",hd:"890",msa:"1868",ml:"978",hm:"1868",hg:"",ms:"",mst:"",ge:"Advance Pi 23",pa:"",be:"Advance Pi"},
"417":{d:"26.6.14",sz:"11:01:45",lz:"12:00:08",st:"Schlick 2000 Kreuzjoch",la:"Neustift Stubai",sLat:47.14512,sLon:11.30815,lLat:47.11218,lLon:11.31576,dur:"0h 58m",dk:"10.3",sl:"3.7",kmh:"10.6",hd:"1122",msa:"2100",ml:"978",hm:"2216",hg:"756",ms:"-2.8",mst:"3.6",ge:"Nova Mentor 3 Light XS",pa:"",be:""},
"418":{d:"26.6.14",sz:"15:12:52",lz:"15:41:52",st:"Elfer",la:"Neustift Stubai",sLat:47.09708,sLon:11.32325,lLat:47.11218,lLon:11.31576,dur:"0h 29m",dk:"4.1",sl:"1.8",kmh:"8.5",hd:"890",msa:"1868",ml:"978",hm:"1868",hg:"151",ms:"-3.2",mst:"2",ge:"Nova Mentor 3 Light XS",pa:"",be:""},
"419":{d:"27.6.14",sz:"09:18:46",lz:"09:35:11",st:"Schlick 2000 Kreuzjoch",la:"Neustift Stubai",sLat:47.14512,sLon:11.30815,lLat:47.11218,lLon:11.31576,dur:"0h 16m",dk:"5.7",sl:"3.7",kmh:"20.8",hd:"1122",msa:"2100",ml:"978",hm:"2100",hg:"10",ms:"-3",mst:"0.8",ge:"Nova Mentor 3 Light XS",pa:"",be:""},
"420":{d:"27.6.14",sz:"10:35:07",lz:"10:57:02",st:"Elfer",la:"Neustift Stubai",sLat:47.09708,sLon:11.32325,lLat:47.11218,lLon:11.31576,dur:"0h 22m",dk:"3.2",sl:"1.8",kmh:"8.8",hd:"890",msa:"1868",ml:"978",hm:"1886",hg:"29",ms:"-7.8",mst:"1",ge:"Nova Mentor 3 Light XS",pa:"",be:""},
"421":{d:"27.6.14",sz:"15:16:45",lz:"15:32:25",st:"Elfer",la:"Neustift Stubai",sLat:47.09708,sLon:11.32325,lLat:47.11218,lLon:11.31576,dur:"0h 16m",dk:"2.4",sl:"1.8",kmh:"9.2",hd:"890",msa:"1868",ml:"978",hm:"1862",hg:"5",ms:"-2.8",mst:"0.8",ge:"Advance Pi 23",pa:"",be:"Advance Pi"},
"422":{d:"23.8.14",sz:"07:36:49",lz:"07:59:24",st:"Fiescheralp Heimat",la:"Fieschertal Flyingcenter",sLat:46.414477,sLon:8.108295,lLat:46.421062,lLon:8.145385,dur:"0h 23m",dk:"4.9",sl:"2.9",kmh:"13.0",hd:"1055",msa:"2146",ml:"1091",hm:"2145",hg:"9",ms:"-2",mst:"1.6",ge:"Nova Mentor 3 Light XS",pa:"",be:""},
"423":{d:"23.8.14",sz:"09:00:12",lz:"09:23:37",st:"Fiescheralp Heimat",la:"Fieschertal Flyingcenter",sLat:46.414477,sLon:8.108295,lLat:46.421062,lLon:8.145385,dur:"0h 23m",dk:"6.1",sl:"2.9",kmh:"15.6",hd:"1055",msa:"2146",ml:"1091",hm:"2146",hg:"66",ms:"-2.8",mst:"2.4",ge:"Nova Mentor 3 Light XS",pa:"",be:""},
"424":{d:"8.9.14",sz:"11:50:56",lz:"12:05:11",st:"Elfer",la:"Neustift Stubai",sLat:47.09708,sLon:11.32325,lLat:47.11218,lLon:11.31576,dur:"0h 14m",dk:"6.8",sl:"1.8",kmh:"28.6",hd:"890",msa:"1868",ml:"978",hm:"1867",hg:"",ms:"-2",mst:"0.4",ge:"Nova Mentor 3 Light XS",pa:"",be:""},
"425":{d:"13.9.14",sz:"09:16:18",lz:"09:31:38",st:"Fiescheralp Heimat",la:"Fieschertal Flyingcenter",sLat:46.414477,sLon:8.108295,lLat:46.421062,lLon:8.145385,dur:"0h 15m",dk:"5.2",sl:"2.9",kmh:"20.3",hd:"1055",msa:"2146",ml:"1091",hm:"2146",hg:"16",ms:"-2",mst:"1.6",ge:"Nova Mentor 3 Light XS",pa:"",be:""},
"426":{d:"13.9.14",sz:"10:41:42",lz:"10:58:22",st:"Fiescheralp Heimat",la:"Fieschertal Flyingcenter",sLat:46.414477,sLon:8.108295,lLat:46.421062,lLon:8.145385,dur:"0h 17m",dk:"5.8",sl:"2.9",kmh:"20.9",hd:"1055",msa:"2146",ml:"1091",hm:"2154",hg:"12",ms:"-4.4",mst:"1.4",ge:"Nova Mentor 3 Light XS",pa:"",be:""},
"427":{d:"14.9.14",sz:"08:56:33",lz:"09:24:21",st:"Fiescheralp Heimat",la:"Fieschertal Flyingcenter",sLat:46.414477,sLon:8.108295,lLat:46.421062,lLon:8.145385,dur:"0h 28m",dk:"5.8",sl:"2.9",kmh:"12.5",hd:"1055",msa:"2146",ml:"1091",hm:"2146",hg:"66",ms:"-2.6",mst:"1.6",ge:"Nova Mentor 3 Light XS",pa:"",be:""},
"428":{d:"14.9.14",sz:"10:10:56",lz:"10:24:21",st:"Fiescheralp Heimat",la:"Fieschertal Flyingcenter",sLat:46.414477,sLon:8.108295,lLat:46.421062,lLon:8.145385,dur:"0h 13m",dk:"2.9",sl:"2.9",kmh:"13.0",hd:"1055",msa:"2146",ml:"1091",hm:"2146",hg:"",ms:"-2.6",mst:"",ge:"Nova Mentor 3 Light XS",pa:"",be:""},
"429":{d:"15.9.14",sz:"11:32:59",lz:"11:43:19",st:"Bellwald Mutti",la:"Bodmen Kurve",sLat:46.43749,sLon:8.15544,lLat:46.429062,lLon:8.149327,dur:"0h 10m",dk:"2.5",sl:"1.0",kmh:"14.5",hd:"394",msa:"1779",ml:"1385",hm:"1706",hg:"21",ms:"-1.8",mst:"0.8",ge:"Advance Pi 23",pa:"",be:"Advance Pi, Hanglandung oberhalb Kurve"},
"430":{d:"16.9.14",sz:"09:03:16",lz:"09:22:41",st:"Fiescheralp Heimat",la:"Fieschertal Flyingcenter",sLat:46.414477,sLon:8.108295,lLat:46.421062,lLon:8.145385,dur:"0h 19m",dk:"5.7",sl:"2.9",kmh:"17.6",hd:"1055",msa:"2146",ml:"1091",hm:"2146",hg:"35",ms:"-2.8",mst:"1.6",ge:"Nova Mentor 3 Light XS",pa:"",be:""},
"431":{d:"16.9.14",sz:"10:56:10",lz:"11:13:25",st:"Fiescheralp Heimat",la:"Fieschertal Flyingcenter",sLat:46.414477,sLon:8.108295,lLat:46.421062,lLon:8.145385,dur:"0h 17m",dk:"5.1",sl:"2.9",kmh:"17.7",hd:"1055",msa:"2146",ml:"1091",hm:"2168",hg:"63",ms:"-2.4",mst:"1.8",ge:"Nova Mentor 3 Light XS",pa:"",be:""},
"432":{d:"18.10.14",sz:"08:44:22",lz:"09:03:52",st:"Fiescheralp Heimat",la:"Fieschertal Flyingcenter",sLat:46.414477,sLon:8.108295,lLat:46.421062,lLon:8.145385,dur:"0h 20m",dk:"4.2",sl:"2.9",kmh:"12.9",hd:"1055",msa:"2146",ml:"1091",hm:"2146",hg:"",ms:"-2.2",mst:"0.6",ge:"Nova Mentor 3 Light XS",pa:"",be:""},
"433":{d:"18.10.14",sz:"10:30:46",lz:"11:00:01",st:"Fiescheralp Galfera",la:"Fieschertal Flyingcenter",sLat:46.404695,sLon:8.096536,lLat:46.421062,lLon:8.145385,dur:"0h 29m",dk:"6.4",sl:"4.2",kmh:"13.1",hd:"1081",msa:"2172",ml:"1091",hm:"2171",hg:"21",ms:"-2.2",mst:"1.6",ge:"Nova Mentor 3 Light XS",pa:"",be:""},
"434":{d:"18.10.14",sz:"12:56:01",lz:"13:10:16",st:"Fiescheralp Salzgäb",la:"Mühlebach Chäserstatt",sLat:46.42798,sLon:8.115787,lLat:46.408116,lLon:8.172449,dur:"0h 14m",dk:"4.9",sl:"4.9",kmh:"20.6",hd:"588",msa:"2242",ml:"1654",hm:"2320",hg:"205",ms:"-2.6",mst:"3.2",ge:"Nova Mentor 3 Light XS",pa:"",be:""},
"435":{d:"18.10.14",sz:"15:26:53",lz:"15:45:58",st:"Chäserstatt Lerch",la:"Fieschertal Flyingcenter",sLat:46.404963,sLon:8.182784,lLat:46.421062,lLon:8.145385,dur:"0h 19m",dk:"4.1",sl:"3.4",kmh:"12.9",hd:"1003",msa:"2094",ml:"1091",hm:"2093",hg:"",ms:"-2",mst:"",ge:"Nova Mentor 3 Light XS",pa:"",be:""},
"436":{d:"19.10.14",sz:"08:53:45",lz:"09:15:15",st:"Fiescheralp Heimat",la:"Fieschertal Flyingcenter",sLat:46.414477,sLon:8.108295,lLat:46.421062,lLon:8.145385,dur:"0h 22m",dk:"4.3",sl:"2.9",kmh:"12.0",hd:"1055",msa:"2146",ml:"1091",hm:"2146",hg:"1",ms:"-2.8",mst:"1.2",ge:"Nova Mentor 3 Light XS",pa:"",be:""},
"437":{d:"19.10.14",sz:"11:04:43",lz:"11:14:28",st:"Fiescheralp Salzgäb",la:"Bellwald Gasse Talstation",sLat:46.42798,sLon:8.115787,lLat:46.429646,lLon:8.16228,dur:"0h 10m",dk:"4.6",sl:"3.6",kmh:"28.3",hd:"606",msa:"2242",ml:"1636",hm:"2161",hg:"18",ms:"-1.8",mst:"1.8",ge:"Nova Mentor 3 Light XS",pa:"",be:"Saisonabschluss, Hike und Zwischenlandung in Bellwald."},
"438":{d:"19.10.14",sz:"14:50:45",lz:"15:11:30",st:"Steibenkreuz Winter",la:"Fieschertal Flyingcenter",sLat:46.44797,sLon:8.16367,lLat:46.421062,lLon:8.145385,dur:"0h 21m",dk:"4.2",sl:"3.3",kmh:"12.1",hd:"1333",msa:"2424",ml:"1091",hm:"2450",hg:"",ms:"-2.2",mst:"1",ge:"Nova Mentor 3 Light XS",pa:"",be:""},
"439":{d:"22.11.14",sz:"09:35:00",lz:"10:10:00",st:"Talegga Piste",la:"Fiesch",sLat:46.416895,sLon:8.10242,lLat:46.40933,lLon:8.136896,dur:"0h 35m",dk:"4",sl:"2.8",kmh:"6.9",hd:"1323",msa:"2379",ml:"1056",hm:"2379",hg:"",ms:"",mst:"",ge:"Nova Mentor 3 Light XS",pa:"",be:"Start auf Piste bei 2. Mast der Eggishorn-Bahn"},
"440":{d:"23.11.14",sz:"09:35:15",lz:"09:45:15",st:"Bellwald Ried unten",la:"Fieschertal Flyingcenter",sLat:46.432528,sLon:8.153185,lLat:46.421062,lLon:8.145385,dur:"0h 10m",dk:"4",sl:"1.4",kmh:"24.0",hd:"489",msa:"1580",ml:"1091",hm:"1580",hg:"",ms:"",mst:"",ge:"Gradient BiGolden 3/39",pa:"Hansi Zeiter",be:"1. Biplace-Flug mit Hansi, Start gut,selber gesteuert und Prüfungsprogramm, Ldg. lang"},
"441":{d:"23.11.14",sz:"11:29:39",lz:"12:08:24",st:"Talegga Piste",la:"Fieschertal Flyingcenter",sLat:46.416895,sLon:8.10242,lLat:46.421062,lLon:8.145385,dur:"0h 39m",dk:"7.1",sl:"3.3",kmh:"11.0",hd:"1288",msa:"2379",ml:"1091",hm:"2379",hg:"221",ms:"-3.2",mst:"2.8",ge:"Nova Mentor 3 Light XS",pa:"",be:"Start auf Piste bei 2. Mast der Eggishorn-Bahn"},
"442":{d:"1.1.15",sz:"11:30:18",lz:"12:04:58",st:"Mittelallalin Station",la:"Saas Almagell",sLat:46.058017,sLon:7.904067,lLat:46.095351,lLon:7.959327,dur:"0h 35m",dk:"8.5",sl:"5.9",kmh:"14.7",hd:"1784",msa:"3454",ml:"1670",hm:"3459",hg:"21",ms:"-2.8",mst:"0.4",ge:"Nova Mentor 3 Light XS",pa:"",be:"Start nördlich der Station, Null Wind, 1 Fehlstart"},
"443":{d:"17.2.15",sz:"10:33:55",lz:"10:58:35",st:"Fiescheralp Heimat",la:"Fieschertal Flyingcenter",sLat:46.414477,sLon:8.108295,lLat:46.421062,lLon:8.145385,dur:"0h 25m",dk:"5.4",sl:"2.9",kmh:"13.1",hd:"1055",msa:"2146",ml:"1091",hm:"2213",hg:"118",ms:"-3.2",mst:"2.4",ge:"Nova Mentor 3 Light XS",pa:"",be:""},
"444":{d:"17.2.15",sz:"11:47:58",lz:"12:16:38",st:"Fiescheralp Heimat",la:"Fieschertal Flyingcenter",sLat:46.414477,sLon:8.108295,lLat:46.421062,lLon:8.145385,dur:"0h 29m",dk:"5.9",sl:"2.9",kmh:"12.3",hd:"1055",msa:"2146",ml:"1091",hm:"2280",hg:"277",ms:"-3.8",mst:"3",ge:"Nova Mentor 3 Light XS",pa:"",be:""},
"445":{d:"18.2.15",sz:"09:14:25",lz:"09:28:50",st:"Fiescheralp Heimat",la:"Fieschertal Flyingcenter",sLat:46.414477,sLon:8.108295,lLat:46.421062,lLon:8.145385,dur:"0h 14m",dk:"3.1",sl:"2.9",kmh:"12.9",hd:"1055",msa:"2146",ml:"1091",hm:"2153",hg:"6",ms:"-3",mst:"0.2",ge:"Gradient BiGolden 3/39",pa:"Peter Ruepp",be:"2. Biplace-Flug mit Peter, Start mit zu wenig Bremse, Landung lang"},
"446":{d:"18.2.15",sz:"12:11:31",lz:"12:46:56",st:"Fiescheralp Heimat",la:"Fiescheralp Mungg",sLat:46.414477,sLon:8.108295,lLat:46.41015,lLon:8.099047,dur:"0h 35m",dk:"3.5",sl:"0.9",kmh:"5.9",hd:"-66",msa:"2146",ml:"2212",hm:"2772",hg:"815",ms:"-2.8",mst:"3",ge:"Gradient BiGolden 3/39",pa:"Peter Ruepp",be:"3. Biplace-Flug mit Peter, Start mit zu wenig Bremse, Startüberhöhung, Landung Mungg gut, Tiefschnee"},
"447":{d:"18.2.15",sz:"15:18:01",lz:"15:36:11",st:"Fiescheralp Heimat",la:"Fieschertal Flyingcenter",sLat:46.414477,sLon:8.108295,lLat:46.421062,lLon:8.145385,dur:"0h 18m",dk:"5",sl:"2.9",kmh:"16.5",hd:"1055",msa:"2146",ml:"1091",hm:"2147",hg:"1",ms:"-3.4",mst:"0.8",ge:"Gradient BiGolden 3/39",pa:"Peter Ruepp",be:"4. Biplace-Flug mit Peter, Fehlstart mit zu wenig Bremse, Landung gut"},
"448":{d:"19.2.15",sz:"09:15:14",lz:"09:28:59",st:"Fiescheralp Heimat",la:"Fieschertal Flyingcenter",sLat:46.414477,sLon:8.108295,lLat:46.421062,lLon:8.145385,dur:"0h 14m",dk:"3.4",sl:"2.9",kmh:"14.8",hd:"1055",msa:"2146",ml:"1091",hm:"2157",hg:"9",ms:"-3.2",mst:"0.1",ge:"Gradient BiGolden 3/39",pa:"Peter Ruepp",be:"5. Biplace-Flug mit Peter, Start mit zu genug Bremse, Ohrenanlegen, hintere Gurten, Landung kurz"},
"449":{d:"19.2.15",sz:"10:28:33",lz:"10:39:53",st:"Fiescheralp Heimat",la:"Fieschertal Flyingcenter",sLat:46.414477,sLon:8.108295,lLat:46.421062,lLon:8.145385,dur:"0h 11m",dk:"4.4",sl:"2.9",kmh:"23.3",hd:"1055",msa:"2146",ml:"1091",hm:"2149",hg:"2",ms:"-5",mst:"0.2",ge:"Gradient BiGolden 3/39",pa:"Peter Ruepp",be:"6. Biplace-Flug mit Peter, Start mit zu guterBremse, schnelle Kurvenwechsel, Landung kurz"},
"450":{d:"19.2.15",sz:"11:53:48",lz:"12:25:48",st:"Fiescheralp Heimat",la:"Fiescheralp Mungg",sLat:46.414477,sLon:8.108295,lLat:46.41015,lLon:8.099047,dur:"0h 32m",dk:"2.2",sl:"0.9",kmh:"4.1",hd:"-66",msa:"2146",ml:"2212",hm:"2407",hg:"587",ms:"-3",mst:"2.8",ge:"Gradient BiGolden 3/39",pa:"Peter Ruepp",be:"7. Biplace-Flug mit Peter, Start mit zu guter Bremse, Toplandung Mungg, hart"},
"451":{d:"19.2.15",sz:"13:34:41",lz:"13:49:51",st:"Fiescheralp Heimat",la:"Fieschertal Flyingcenter",sLat:46.414477,sLon:8.108295,lLat:46.421062,lLon:8.145385,dur:"0h 15m",dk:"3.9",sl:"2.9",kmh:"15.4",hd:"1055",msa:"2146",ml:"1091",hm:"2159",hg:"30",ms:"-6.6",mst:"2.4",ge:"Gradient BiGolden 3/39",pa:"Peter Ruepp",be:"8. Biplace-Flug mit Peter, Start gut, Bremse kurz verloren, Landung lang, Prüfungsprogramm"},
"452":{d:"20.2.15",sz:"09:05:16",lz:"09:19:31",st:"Fiescheralp Heimat",la:"Fieschertal Flyingcenter",sLat:46.414477,sLon:8.108295,lLat:46.421062,lLon:8.145385,dur:"0h 14m",dk:"4",sl:"2.9",kmh:"16.8",hd:"1055",msa:"2146",ml:"1091",hm:"2154",hg:"6",ms:"-8.2",mst:"",ge:"Gradient BiGolden 3/39",pa:"Peter Ruepp",be:"9. Biplace-Flug mit Peter, Start gut, etwas früh angebremst, Landung lang, Prüfungsprogramm"},
"453":{d:"20.2.15",sz:"10:41:31",lz:"11:03:21",st:"Fiescheralp Heimat",la:"Fieschertal Flyingcenter",sLat:46.414477,sLon:8.108295,lLat:46.421062,lLon:8.145385,dur:"0h 22m",dk:"4.9",sl:"2.9",kmh:"13.5",hd:"1055",msa:"2146",ml:"1091",hm:"2173",hg:"83",ms:"-2.6",mst:"1.8",ge:"Gradient BiGolden 3/39",pa:"Peter Ruepp",be:"10. Biplace-Flug mit Peter, Start gut, etwas früh angebremst, Landung knapp ok."},
"454":{d:"28.3.15",sz:"09:24:42",lz:"09:36:47",st:"Fiescheralp Heimat",la:"Fieschertal Flyingcenter",sLat:46.414477,sLon:8.108295,lLat:46.421062,lLon:8.145385,dur:"0h 12m",dk:"3.2",sl:"2.9",kmh:"15.9",hd:"1055",msa:"2146",ml:"1091",hm:"2148",hg:"4",ms:"-5",mst:"0.8",ge:"Gradient BiGolden 3/39",pa:"Roli Brändli",be:"11. Biplace-Flug mit Roli, Landung gut."},
"455":{d:"28.3.15",sz:"10:44:13",lz:"11:10:48",st:"Fiescheralp Heimat",la:"Fieschertal Flyingcenter",sLat:46.414477,sLon:8.108295,lLat:46.421062,lLon:8.145385,dur:"0h 27m",dk:"2.9",sl:"2.9",kmh:"6.5",hd:"1055",msa:"2146",ml:"1091",hm:"2228",hg:"181",ms:"-4.2",mst:"2.2",ge:"Gradient BiGolden 3/39",pa:"Roli Brändli",be:"12. Biplace-Flug, mit Roli, Landung gut"},
"456":{d:"28.3.15",sz:"12:21:14",lz:"12:31:24",st:"Fiescheralp Heimat",la:"Fieschertal Flyingcenter",sLat:46.414477,sLon:8.108295,lLat:46.421062,lLon:8.145385,dur:"0h 10m",dk:"3.3",sl:"2.9",kmh:"19.5",hd:"1055",msa:"2146",ml:"1091",hm:"2108",hg:"",ms:"-5.8",mst:"0.2",ge:"Gradient BiGolden 3/39",pa:"Roli Brändli",be:"13. Biplace-Flug, mit Roli, Landung bei Gegenwind zu kurz"},
"457":{d:"13.4.15",sz:"09:53:14",lz:"10:03:04",st:"Hüsliberg Schänis",la:"Rufi Schänis",sLat:47.189736,sLon:9.073856,lLat:47.183531,lLon:9.046825,dur:"0h 10m",dk:"2.2",sl:"2.2",kmh:"13.4",hd:"575",msa:"1000",ml:"425",hm:"999",hg:"",ms:"-6",mst:"",ge:"Gradient BiGolden 3/39",pa:"Giani Tannò",be:"1. Prüfungsflug, Biplace B-Brevet: 2 Vollkreise und Landung gut."},
"458":{d:"13.4.15",sz:"11:32:08",lz:"11:39:18",st:"Hüsliberg Schänis",la:"Rufi Schänis",sLat:47.189736,sLon:9.073856,lLat:47.183531,lLon:9.046825,dur:"0h 7m",dk:"2.2",sl:"2.2",kmh:"18.4",hd:"575",msa:"1000",ml:"425",hm:"1000",hg:"",ms:"-3.2",mst:"",ge:"Gradient BiGolden 3/39",pa:"Giani Tannò",be:"2. Prüfungsflug, Biplace B-Brevet: 2 Kreise \"Acht\" und Landung gut."},
"459":{d:"4.6.15",sz:"09:09:45",lz:"09:35:05",st:"Fiescheralp Heimat",la:"Fieschertal Flyingcenter",sLat:46.414477,sLon:8.108295,lLat:46.421062,lLon:8.145385,dur:"0h 25m",dk:"5.7",sl:"2.9",kmh:"13.5",hd:"1055",msa:"2146",ml:"1091",hm:"2184",hg:"134",ms:"-4.6",mst:"1.8",ge:"Nova Mentor 3 Light XS",pa:"",be:""},
"460":{d:"4.6.15",sz:"10:44:21",lz:"11:05:16",st:"Fiescheralp Heimat",la:"Fieschertal Flyingcenter",sLat:46.414477,sLon:8.108295,lLat:46.421062,lLon:8.145385,dur:"0h 21m",dk:"11.5",sl:"2.9",kmh:"33.0",hd:"1055",msa:"2146",ml:"1091",hm:"2312",hg:"386",ms:"-2.6",mst:"4.6",ge:"Nova Mentor 3 Light XS",pa:"",be:"Vario über Bellwald kein Strom mehr ..."},
"461":{d:"5.6.15",sz:"09:14:13",lz:"09:27:53",st:"Fiescheralp Heimat",la:"Fieschertal Flyingcenter",sLat:46.414477,sLon:8.108295,lLat:46.421062,lLon:8.145385,dur:"0h 14m",dk:"3.7",sl:"2.9",kmh:"16.2",hd:"1055",msa:"2146",ml:"1091",hm:"2145",hg:"6",ms:"-6",mst:"0.8",ge:"Nova Mentor 3 Light XS",pa:"",be:"Prüfungsprogramm Doppelkreis, Acht mit Nova"},
"462":{d:"5.6.15",sz:"10:47:53",lz:"11:57:33",st:"Fiescheralp Heimat",la:"Fieschertal Flyingcenter",sLat:46.414477,sLon:8.108295,lLat:46.421062,lLon:8.145385,dur:"1h 10m",dk:"20.2",sl:"2.9",kmh:"17.4",hd:"1055",msa:"2146",ml:"1091",hm:"2816",hg:"1838",ms:"-3.6",mst:"4.2",ge:"Nova Mentor 3 Light XS",pa:"",be:"Ruppige Thermik, Wolken"},
"463":{d:"6.6.15",sz:"09:11:30",lz:"09:31:50",st:"Fiescheralp Heimat",la:"Fieschertal Flyingcenter",sLat:46.414477,sLon:8.108295,lLat:46.421062,lLon:8.145385,dur:"0h 20m",dk:"3.6",sl:"2.9",kmh:"10.6",hd:"1055",msa:"2146",ml:"1091",hm:"2145",hg:"106",ms:"-6.2",mst:"3",ge:"Advance Alpha 5/26",pa:"",be:"Prüfungsprogramm"},
"464":{d:"6.6.15",sz:"10:35:13",lz:"10:53:48",st:"Fiescheralp Heimat",la:"Fieschertal Flyingcenter",sLat:46.414477,sLon:8.108295,lLat:46.421062,lLon:8.145385,dur:"0h 19m",dk:"4",sl:"2.9",kmh:"12.9",hd:"1055",msa:"2146",ml:"1091",hm:"2182",hg:"51",ms:"-2.8",mst:"1.8",ge:"Nova Mentor 3 Light XS",pa:"",be:""},
"465":{d:"7.6.15",sz:"09:12:46",lz:"09:25:51",st:"Fiescheralp Heimat",la:"Fieschertal Flyingcenter",sLat:46.414477,sLon:8.108295,lLat:46.421062,lLon:8.145385,dur:"0h 13m",dk:"4.1",sl:"2.9",kmh:"18.8",hd:"1055",msa:"2146",ml:"1091",hm:"2145",hg:"",ms:"-7.6",mst:"0.4",ge:"Advance Alpha 5/26",pa:"",be:"erster Flug mit Alpha 5/26"},
"466":{d:"13.6.15",sz:"10:55:46",lz:"11:08:51",st:"Rotenflue SW Sommer",la:"Rickenbach",sLat:47.017641,sLon:8.700727,lLat:47.012549,lLon:8.67004,dur:"0h 13m",dk:"2.4",sl:"2.4",kmh:"11.0",hd:"928",msa:"1518",ml:"590",hm:"1481",hg:"",ms:"-4.8",mst:"0.2",ge:"Advance Alpha 5/26",pa:"",be:"Alpha 5 Doppelkreis, Acht"},
"467":{d:"13.6.15",sz:"12:06:45",lz:"12:19:55",st:"Rotenflue SW Sommer",la:"Rickenbach",sLat:47.017641,sLon:8.700727,lLat:47.012549,lLon:8.67004,dur:"0h 13m",dk:"2.4",sl:"2.4",kmh:"10.9",hd:"928",msa:"1518",ml:"590",hm:"1479",hg:"12",ms:"-6.8",mst:"2",ge:"Advance Alpha 5/26",pa:"",be:"Alpha 5, Doppelkreis, Acht"},
"468":{d:"26.7.15",sz:"09:43:14",lz:"10:01:24",st:"Fiescheralp Heimat",la:"Fieschertal Flyingcenter",sLat:46.414477,sLon:8.108295,lLat:46.421062,lLon:8.145385,dur:"0h 18m",dk:"3.8",sl:"2.9",kmh:"12.6",hd:"1055",msa:"2146",ml:"1091",hm:"2145",hg:"8",ms:"-7.2",mst:"1.6",ge:"Advance Alpha 5/26",pa:"",be:"Advance Alpha 5/26"},
"469":{d:"26.7.15",sz:"11:06:15",lz:"11:17:10",st:"Fiescheralp Heimat",la:"Fieschertal Flyingcenter",sLat:46.414477,sLon:8.108295,lLat:46.421062,lLon:8.145385,dur:"0h 11m",dk:"3.9",sl:"2.9",kmh:"21.4",hd:"1055",msa:"2146",ml:"1091",hm:"2145",hg:"",ms:"-6.6",mst:"0.2",ge:"Advance Alpha 5/26",pa:"",be:"Advance Alpha 5/26"},
"470":{d:"28.7.15",sz:"08:07:14",lz:"08:14:49",st:"Fiescheralp Heimat",la:"Fieschertal Flyingcenter",sLat:46.414477,sLon:8.108295,lLat:46.421062,lLon:8.145385,dur:"0h 8m",dk:"3.2",sl:"2.9",kmh:"25.3",hd:"1055",msa:"2146",ml:"1091",hm:"2144",hg:"",ms:"-7.6",mst:"",ge:"Advance Alpha 5/26",pa:"",be:"Advance Alpha 5/26"},
"471":{d:"28.7.15",sz:"09:23:32",lz:"09:38:27",st:"Fiescheralp Heimat",la:"Fieschertal Flyingcenter",sLat:46.414477,sLon:8.108295,lLat:46.421062,lLon:8.145385,dur:"0h 15m",dk:"5.1",sl:"2.9",kmh:"20.5",hd:"1055",msa:"2146",ml:"1091",hm:"2145",hg:"6",ms:"-3",mst:"0.6",ge:"Gradient BiGolden 3/39",pa:"Stefan Eberle",be:"Biplace 1 mit Stefan"},
"472":{d:"28.7.15",sz:"10:37:39",lz:"10:54:09",st:"Fiescheralp Biplace",la:"Fieschertal Flyingcenter",sLat:46.411504,sLon:8.102926,lLat:46.421062,lLon:8.145385,dur:"0h 17m",dk:"5.4",sl:"3.4",kmh:"19.6",hd:"1104",msa:"2195",ml:"1091",hm:"2146",hg:"57",ms:"-4.8",mst:"2.6",ge:"Gradient BiGolden 3/39",pa:"Stefan Eberle",be:"Biplace 2 mit Stefan"},
"473":{d:"31.7.15",sz:"09:11:20",lz:"09:34:55",st:"Fiescheralp Heimat",la:"Fieschertal Flyingcenter",sLat:46.414477,sLon:8.108295,lLat:46.421062,lLon:8.145385,dur:"0h 24m",dk:"4.3",sl:"2.9",kmh:"10.9",hd:"1055",msa:"2146",ml:"1091",hm:"2145",hg:"145",ms:"-5.8",mst:"2.4",ge:"Advance Alpha 5/26",pa:"",be:"Advance Alpha 5/26 Übungsflüge"},
"474":{d:"2.8.15",sz:"10:46:44",lz:"10:53:39",st:"Bellwald Mutti",la:"Fieschertal Flyingcenter",sLat:46.43749,sLon:8.15544,lLat:46.421062,lLon:8.145385,dur:"0h 7m",dk:"3",sl:"2.0",kmh:"26.0",hd:"688",msa:"1779",ml:"1091",hm:"1696",hg:"",ms:"-4",mst:"0.2",ge:"Advance Alpha 5/26",pa:"",be:"Advance Alpha 5/26 Übungsflüge"},
"475":{d:"2.8.15",sz:"12:13:14",lz:"12:26:14",st:"Fiescheralp Heimat",la:"Fieschertal Flyingcenter",sLat:46.414477,sLon:8.108295,lLat:46.421062,lLon:8.145385,dur:"0h 13m",dk:"3.7",sl:"2.9",kmh:"17.1",hd:"1055",msa:"2146",ml:"1091",hm:"2145",hg:"1",ms:"-8.4",mst:"0.4",ge:"Advance Alpha 5/26",pa:"",be:"Advance Alpha 5/26 Übungsflüge"},
"476":{d:"5.8.15",sz:"08:48:33",lz:"09:00:33",st:"Fiescheralp Heimat",la:"Fiesch",sLat:46.414477,sLon:8.108295,lLat:46.40933,lLon:8.136896,dur:"0h 12m",dk:"5.1",sl:"2.3",kmh:"25.5",hd:"1090",msa:"2146",ml:"1056",hm:"2078",hg:"4",ms:"-8.4",mst:"",ge:"Advance Alpha 5/26",pa:"",be:"Advance Alpha 5/26 Übungsflüge"},
"477":{d:"5.8.15",sz:"10:05:03",lz:"10:15:33",st:"Fiescheralp Heimat",la:"Fieschertal Flyingcenter",sLat:46.414477,sLon:8.108295,lLat:46.421062,lLon:8.145385,dur:"0h 11m",dk:"4.1",sl:"2.9",kmh:"23.4",hd:"1055",msa:"2146",ml:"1091",hm:"2146",hg:"",ms:"-10.2",mst:"0.2",ge:"Advance Alpha 5/26",pa:"",be:"Advance Alpha 5/26 Übungsflüge"},
"478":{d:"5.8.15",sz:"11:32:39",lz:"11:45:49",st:"Fiescheralp Heimat",la:"Fieschertal Flyingcenter",sLat:46.414477,sLon:8.108295,lLat:46.421062,lLon:8.145385,dur:"0h 13m",dk:"4.1",sl:"2.9",kmh:"18.7",hd:"1055",msa:"2146",ml:"1091",hm:"2154",hg:"9",ms:"-2.2",mst:"1.6",ge:"Advance Alpha 5/26",pa:"",be:"Advance Alpha 5/26 Übungsflüge, Leinen verhängt"},
"479":{d:"5.8.15",sz:"13:05:43",lz:"13:23:23",st:"Fiescheralp Heimat",la:"Fieschertal Flyingcenter",sLat:46.414477,sLon:8.108295,lLat:46.421062,lLon:8.145385,dur:"0h 18m",dk:"4.7",sl:"2.9",kmh:"16.0",hd:"1055",msa:"2146",ml:"1091",hm:"2402",hg:"276",ms:"-9.8",mst:"3",ge:"Advance Alpha 5/26",pa:"",be:"Advance Alpha 5/26 Übungsflüge, mit Thermik"},
"480":{d:"6.8.15",sz:"08:50:53",lz:"09:04:08",st:"Fiescheralp Galfera",la:"Fiesch",sLat:46.404695,sLon:8.096536,lLat:46.40933,lLon:8.136896,dur:"0h 13m",dk:"3.3",sl:"3.1",kmh:"14.9",hd:"1116",msa:"2172",ml:"1056",hm:"2169",hg:"",ms:"-10.8",mst:"",ge:"Advance Alpha 5/26",pa:"",be:"Advance Alpha 5/26 Übungsflüge"},
"481":{d:"6.8.15",sz:"10:21:47",lz:"10:32:17",st:"Fiescheralp Heimat",la:"Fieschertal Flyingcenter",sLat:46.414477,sLon:8.108295,lLat:46.421062,lLon:8.145385,dur:"0h 11m",dk:"3.6",sl:"2.9",kmh:"20.6",hd:"1055",msa:"2146",ml:"1091",hm:"2145",hg:"3",ms:"-8.6",mst:"1.2",ge:"Advance Alpha 5/26",pa:"",be:"Advance Alpha 5/26 Übungsflüge"},
"482":{d:"6.8.15",sz:"11:59:29",lz:"12:13:54",st:"Fiescheralp Heimat",la:"Fieschertal Flyingcenter",sLat:46.414477,sLon:8.108295,lLat:46.421062,lLon:8.145385,dur:"0h 14m",dk:"3.8",sl:"2.9",kmh:"15.8",hd:"1055",msa:"2146",ml:"1091",hm:"2142",hg:"12",ms:"-8.4",mst:"1.6",ge:"Advance Alpha 5/26",pa:"",be:"Advance Alpha 5/26 Übungsflüge"},
"483":{d:"8.8.15",sz:"10:11:34",lz:"11:08:34",st:"Fiescheralp Heimat",la:"Fieschertal Flyingcenter",sLat:46.414477,sLon:8.108295,lLat:46.421062,lLon:8.145385,dur:"0h 57m",dk:"11",sl:"2.9",kmh:"11.6",hd:"1055",msa:"2146",ml:"1091",hm:"2609",hg:"780",ms:"-3.2",mst:"2.8",ge:"Nova Mentor 3 Light XS",pa:"",be:"Nova Mentor 3 light, Thermik"},
"484":{d:"22.8.15",sz:"16:03:02",lz:"16:29:57",st:"Rotenflue W Sommer",la:"Rickenbach",sLat:47.018594,sLon:8.701526,lLat:47.012549,lLon:8.67004,dur:"0h 27m",dk:"2.4",sl:"2.5",kmh:"5.3",hd:"960",msa:"1550",ml:"590",hm:"1485",hg:"23",ms:"-3.4",mst:"1.2",ge:"Nova Mentor 3 Light XS",pa:"",be:"1 Fehlstart"},
"485":{d:"30.8.15",sz:"15:45:49",lz:"16:54:54",st:"Meduno",la:"Meduno LP",sLat:46.23038,sLon:12.8067,lLat:46.20556,lLon:12.8191,dur:"1h 9m",dk:"10.7",sl:"2.9",kmh:"9.3",hd:"671",msa:"894",ml:"223",hm:"1358",hg:"1238",ms:"-2.8",mst:"2.6",ge:"Nova Mentor 3 Light XS",pa:"",be:"1 Fehlstart, Rückwärts"},
"486":{d:"31.8.15",sz:"11:05:33",lz:"12:11:28",st:"Kobala",la:"Poljubinj",sLat:46.1817,sLon:13.77828,lLat:46.17945,lLon:13.7464,dur:"1h 6m",dk:"7.5",sl:"2.5",kmh:"6.8",hd:"862",msa:"1040",ml:"178",hm:"1426",hg:"618",ms:"-2.4",mst:"2",ge:"Nova Mentor 3 Light XS",pa:"",be:""},
"487":{d:"31.8.15",sz:"15:51:26",lz:"17:21:36",st:"Kobala",la:"Poljubinj",sLat:46.1817,sLon:13.77828,lLat:46.17945,lLon:13.7464,dur:"1h 30m",dk:"16.6",sl:"2.5",kmh:"11.0",hd:"862",msa:"1040",ml:"178",hm:"1323",hg:"1054",ms:"-2.2",mst:"3",ge:"Nova Mentor 3 Light XS",pa:"",be:""},
"488":{d:"1.9.15",sz:"12:28:14",lz:"13:50:59",st:"Lijak",la:"Lijak LP",sLat:45.96331,sLon:13.72216,lLat:45.9476,lLon:13.712,dur:"1h 23m",dk:"12.7",sl:"1.9",kmh:"9.2",hd:"510",msa:"596",ml:"86",hm:"1002",hg:"1335",ms:"-3",mst:"2.8",ge:"Nova Mentor 3 Light XS",pa:"",be:""},
"489":{d:"2.9.15",sz:"11:18:56",lz:"11:56:51",st:"Stol",la:"Kobarid",sLat:46.27231,sLon:13.47366,lLat:46.24138,lLon:13.58298,dur:"0h 38m",dk:"12.3",sl:"9.1",kmh:"19.5",hd:"1134",msa:"1368",ml:"234",hm:"1481",hg:"169",ms:"-3",mst:"1.8",ge:"Nova Mentor 3 Light XS",pa:"",be:""},
"490":{d:"2.9.15",sz:"17:45:41",lz:"17:56:11",st:"Kobala",la:"Poljubinj",sLat:46.1817,sLon:13.77828,lLat:46.17945,lLon:13.7464,dur:"0h 11m",dk:"2.8",sl:"2.5",kmh:"16.0",hd:"862",msa:"1040",ml:"178",hm:"1040",hg:"",ms:"-2",mst:"",ge:"Advance Pi 23",pa:"",be:"Advance Pi"},
"491":{d:"3.9.15",sz:"11:24:59",lz:"12:11:19",st:"Lijak",la:"Lijak LP",sLat:45.96331,sLon:13.72216,lLat:45.9476,lLon:13.712,dur:"0h 46m",dk:"8.5",sl:"1.9",kmh:"11.0",hd:"510",msa:"596",ml:"86",hm:"1233",hg:"1066",ms:"-3.6",mst:"3.8",ge:"Nova Mentor 3 Light XS",pa:"",be:""},
"492":{d:"3.9.15",sz:"15:23:28",lz:"16:03:43",st:"Lijak",la:"Lijak LP",sLat:45.96331,sLon:13.72216,lLat:45.9476,lLon:13.712,dur:"0h 40m",dk:"6.9",sl:"1.9",kmh:"10.3",hd:"510",msa:"596",ml:"86",hm:"1017",hg:"603",ms:"-3",mst:"2.4",ge:"Nova Mentor 3 Light XS",pa:"",be:"2 Fehlstarts, Starkwind Rückwärts"},
"493":{d:"4.9.15",sz:"17:05:25",lz:"17:20:10",st:"Kobala",la:"Poljubinj",sLat:46.1817,sLon:13.77828,lLat:46.17945,lLon:13.7464,dur:"0h 15m",dk:"3.5",sl:"2.5",kmh:"14.2",hd:"862",msa:"1040",ml:"178",hm:"1039",hg:"",ms:"-2.8",mst:"",ge:"Nova Mentor 3 Light XS",pa:"",be:"Abendlicher Gleitflug"},
"494":{d:"17.10.15",sz:"09:12:55",lz:"09:27:35",st:"Fiescheralp Heimat",la:"Fieschertal Flyingcenter",sLat:46.414477,sLon:8.108295,lLat:46.421062,lLon:8.145385,dur:"0h 15m",dk:"4.2",sl:"2.9",kmh:"17.2",hd:"1055",msa:"2146",ml:"1091",hm:"2146",hg:"",ms:"-2.4",mst:"0.2",ge:"Gradient BiGolden 3/39",pa:"Peter Ruepp",be:"Biplace 3, Peter"},
"495":{d:"17.10.15",sz:"10:42:17",lz:"10:57:17",st:"Fiescheralp Heimat",la:"Fieschertal Flyingcenter",sLat:46.414477,sLon:8.108295,lLat:46.421062,lLon:8.145385,dur:"0h 15m",dk:"4.9",sl:"2.9",kmh:"19.6",hd:"1055",msa:"2146",ml:"1091",hm:"2146",hg:"",ms:"-2.6",mst:"0.2",ge:"Nova Mentor 3 Light XS",pa:"",be:"Mentor 3 light"},
"496":{d:"17.10.15",sz:"13:06:45",lz:"13:21:15",st:"Fiescheralp Salzgäb",la:"Mühlebach",sLat:46.42798,sLon:8.115787,lLat:46.404548,lLon:8.152127,dur:"0h 15m",dk:"4.6",sl:"3.8",kmh:"19.0",hd:"1043",msa:"2242",ml:"1199",hm:"2143",hg:"",ms:"-2",mst:"0.2",ge:"Nova Mentor 3 Light XS",pa:"",be:"Hike beim Abschlussfliegen"},
"497":{d:"17.10.15",sz:"16:10:00",lz:"16:20:00",st:"Bellwald Mutti",la:"Fieschertal Flyingcenter",sLat:46.43749,sLon:8.15544,lLat:46.421062,lLon:8.145385,dur:"0h 10m",dk:"3",sl:"2.0",kmh:"18.0",hd:"688",msa:"1779",ml:"1091",hm:"1779",hg:"",ms:"",mst:"",ge:"Nova Mentor 3 Light XS",pa:"",be:"Gleitflug zum Abschluss., Mentor"},
"498":{d:"24.10.15",sz:"15:34:03",lz:"15:43:03",st:"Rigi Seebodenalp",la:"Küssnacht",sLat:47.063445,sLon:8.457515,lLat:47.06739,lLon:8.435432,dur:"0h 9m",dk:"1.7",sl:"1.7",kmh:"11.3",hd:"569",msa:"1032",ml:"463",hm:"988",hg:"8",ms:"-2.2",mst:"",ge:"Gradient BiGolden 3/39",pa:"Nicola Mair-Noack",be:"Biplace, nach Wanderung auf Rigi Kulm und zurück, bei zuviel Wind, mit N."},
"499":{d:"31.10.15",sz:"16:24:44",lz:"16:32:19",st:"Brändlen-Nord",la:"Wolfenschiessen",sLat:46.904921,sLon:8.409661,lLat:46.905095,lLon:8.398533,dur:"0h 8m",dk:"1.2",sl:"0.8",kmh:"9.5",hd:"727",msa:"1237",ml:"510",hm:"1124",hg:"",ms:"-3.8",mst:"1.4",ge:"Gradient BiGolden 3/39",pa:"Giani Tannò",be:"Biplace 4, Giani, Prüfungsprogramm, Abendflug"},
"500":{d:"7.11.15",sz:"09:59:04",lz:"10:09:34",st:"Rotenflue W Sommer",la:"Rickenbach",sLat:47.018594,sLon:8.701526,lLat:47.012549,lLon:8.67004,dur:"0h 11m",dk:"2.4",sl:"2.5",kmh:"13.7",hd:"960",msa:"1550",ml:"590",hm:"1482",hg:"1",ms:"-6",mst:"0.2",ge:"Advance Alpha 5/26",pa:"",be:"Übungsflug Alpha 5"},
"501":{d:"7.11.15",sz:"11:10:44",lz:"11:22:14",st:"Rotenflue SW Sommer",la:"Rickenbach",sLat:47.017641,sLon:8.700727,lLat:47.012549,lLon:8.67004,dur:"0h 12m",dk:"2.4",sl:"2.4",kmh:"12.5",hd:"928",msa:"1518",ml:"590",hm:"1483",hg:"8",ms:"-8",mst:"0.8",ge:"Advance Alpha 5/26",pa:"",be:"Übungsflug Alpha 5"},
"502":{d:"7.11.15",sz:"12:56:30",lz:"13:10:30",st:"Rotenflue SW Sommer",la:"Rickenbach",sLat:47.017641,sLon:8.700727,lLat:47.012549,lLon:8.67004,dur:"0h 14m",dk:"2.4",sl:"2.4",kmh:"10.3",hd:"928",msa:"1518",ml:"590",hm:"1483",hg:"3",ms:"-7.6",mst:"0.2",ge:"Advance Alpha 5/26",pa:"",be:"Übungsflug Alpha 5"},
"503":{d:"13.12.15",sz:"10:46:47",lz:"10:56:27",st:"Rotenflue SW Sommer",la:"Rickenbach",sLat:47.017641,sLon:8.700727,lLat:47.012549,lLon:8.67004,dur:"0h 10m",dk:"2.4",sl:"2.4",kmh:"14.9",hd:"928",msa:"1518",ml:"590",hm:"1485",hg:"3",ms:"-9",mst:"0.2",ge:"Advance Alpha 5/26",pa:"",be:"Übungsflug Alpha 5"},
"504":{d:"13.12.15",sz:"11:43:04",lz:"11:53:14",st:"Rotenflue SW Sommer",la:"Rickenbach",sLat:47.017641,sLon:8.700727,lLat:47.012549,lLon:8.67004,dur:"0h 10m",dk:"2.5",sl:"2.4",kmh:"14.8",hd:"928",msa:"1518",ml:"590",hm:"1485",hg:"3",ms:"-5.6",mst:"0.2",ge:"Advance Alpha 5/26",pa:"",be:"Übungsflug Alpha 5"},
"505":{d:"13.12.15",sz:"12:41:52",lz:"12:52:57",st:"Rotenflue SW Sommer",la:"Rickenbach",sLat:47.017641,sLon:8.700727,lLat:47.012549,lLon:8.67004,dur:"0h 11m",dk:"2.5",sl:"2.4",kmh:"13.5",hd:"928",msa:"1518",ml:"590",hm:"1503",hg:"18",ms:"-8.8",mst:"",ge:"Advance Alpha 5/26",pa:"",be:"Übungsflug Alpha 5"},
"506":{d:"29.12.15",sz:"12:08:16",lz:"12:22:51",st:"Pas de Maimbre",la:"Ayent Saxonne",sLat:46.312425,sLon:7.386931,lLat:46.283628,lLon:7.405681,dur:"0h 15m",dk:"3.8",sl:"3.5",kmh:"15.6",hd:"1228",msa:"2252",ml:"1024",hm:"2252",hg:"",ms:"-4.8",mst:"0.2",ge:"Gradient BiGolden 3/39",pa:"Giani Tannò",be:"Biplace 5, mit Giani"},
"507":{d:"3.1.16",sz:"12:58:09",lz:"13:07:19",st:"Zugerberg",la:"Zug",sLat:47.14813,sLon:8.535748,lLat:47.150094,lLon:8.507689,dur:"0h 9m",dk:"3.6",sl:"2.1",kmh:"23.6",hd:"475",msa:"950",ml:"475",hm:"951",hg:"1",ms:"-2.8",mst:"0.2",ge:"Advance Pi 23",pa:"",be:""},
"508":{d:"17.2.16",sz:"10:00:00",lz:"10:10:00",st:"Richinen",la:"Bellwald ob LFÜB",sLat:46.440693,sLon:8.169194,lLat:46.423735,lLon:8.162345,dur:"0h 10m",dk:"2",sl:"2.0",kmh:"12.0",hd:"526",msa:"2078",ml:"1552",hm:"2078",hg:"",ms:"",mst:"",ge:"Advance Alpha 5/26",pa:"",be:"Übungsflug Alpha 5"},
"509":{d:"17.2.16",sz:"11:33:07",lz:"11:45:52",st:"Richinen",la:"Fieschertal Flyingcenter",sLat:46.440693,sLon:8.169194,lLat:46.421062,lLon:8.145385,dur:"0h 13m",dk:"2.8",sl:"2.8",kmh:"13.2",hd:"987",msa:"2078",ml:"1091",hm:"2078",hg:"",ms:"-6.4",mst:"0.2",ge:"Advance Alpha 5/26",pa:"",be:"Übungsflug Alpha 5"},
"510":{d:"17.2.16",sz:"12:36:55",lz:"12:50:15",st:"Fiescheralp Heimat",la:"Fieschertal Flyingcenter",sLat:46.414477,sLon:8.108295,lLat:46.421062,lLon:8.145385,dur:"0h 13m",dk:"3.1",sl:"2.9",kmh:"14.0",hd:"1055",msa:"2146",ml:"1091",hm:"2150",hg:"3",ms:"-6.8",mst:"0.4",ge:"Advance Alpha 5/26",pa:"",be:"Übungsflug Alpha 5"},
"511":{d:"19.3.16",sz:"09:46:44",lz:"09:57:39",st:"Rotenflue SSW Winter",la:"Rickenbach",sLat:47.01819,sLon:8.701503,lLat:47.012549,lLon:8.67004,dur:"0h 11m",dk:"2.5",sl:"2.5",kmh:"13.7",hd:"959",msa:"1549",ml:"590",hm:"1549",hg:"",ms:"-7",mst:"0.2",ge:"Advance Alpha 5/26",pa:"",be:"Übungsflug Alpha 5"},
"512":{d:"19.3.16",sz:"11:12:40",lz:"11:24:25",st:"Rotenflue NE",la:"Rickenbach",sLat:47.022082,sLon:8.704239,lLat:47.012549,lLon:8.67004,dur:"0h 12m",dk:"3",sl:"2.8",kmh:"15.3",hd:"951",msa:"1541",ml:"590",hm:"1539",hg:"2",ms:"-5.4",mst:"0.6",ge:"Advance Alpha 5/26",pa:"",be:"Übungsflug Alpha 5"},
"513":{d:"19.3.16",sz:"12:14:16",lz:"12:22:56",st:"Rotenflue NE",la:"Rickenbach",sLat:47.022082,sLon:8.704239,lLat:47.012549,lLon:8.67004,dur:"0h 9m",dk:"3.2",sl:"2.8",kmh:"22.2",hd:"951",msa:"1541",ml:"590",hm:"1530",hg:"5",ms:"-7.4",mst:"1.2",ge:"Advance Alpha 5/26",pa:"",be:"Übungsflug Alpha 5"},
"514":{d:"19.3.16",sz:"13:34:08",lz:"13:44:38",st:"Rotenflue SSW Winter",la:"Rickenbach",sLat:47.01819,sLon:8.701503,lLat:47.012549,lLon:8.67004,dur:"0h 11m",dk:"2.8",sl:"2.5",kmh:"16.0",hd:"959",msa:"1549",ml:"590",hm:"1549",hg:"1",ms:"-5.2",mst:"1.2",ge:"Advance Alpha 5/26",pa:"",be:"Übungsflug Alpha 5"},
"515":{d:"19.3.16",sz:"14:41:33",lz:"14:50:48",st:"Rotenflue SSW Winter",la:"Rickenbach",sLat:47.01819,sLon:8.701503,lLat:47.012549,lLon:8.67004,dur:"0h 9m",dk:"2.5",sl:"2.5",kmh:"16.2",hd:"959",msa:"1549",ml:"590",hm:"1540",hg:"4",ms:"-7",mst:"",ge:"Advance Alpha 5/26",pa:"",be:"Übungsflug Alpha 5"},
"516":{d:"20.3.16",sz:"11:23:00",lz:"11:34:15",st:"Rotenflue SSW Winter",la:"Rickenbach",sLat:47.01819,sLon:8.701503,lLat:47.012549,lLon:8.67004,dur:"0h 11m",dk:"3.4",sl:"2.5",kmh:"18.1",hd:"959",msa:"1549",ml:"590",hm:"1551",hg:"6",ms:"-7",mst:"0.8",ge:"Advance Alpha 5/26",pa:"",be:"Übungsflug Alpha 5"},
"517":{d:"20.3.16",sz:"12:20:57",lz:"12:31:22",st:"Rotenflue SSW Winter",la:"Rickenbach",sLat:47.01819,sLon:8.701503,lLat:47.012549,lLon:8.67004,dur:"0h 10m",dk:"2.9",sl:"2.5",kmh:"16.7",hd:"959",msa:"1549",ml:"590",hm:"1551",hg:"2",ms:"-7",mst:"0.2",ge:"Advance Alpha 5/26",pa:"",be:"Übungsflug Alpha 5"},
"518":{d:"20.3.16",sz:"13:38:09",lz:"13:50:34",st:"Rotenflue SSW Winter",la:"Rickenbach",sLat:47.01819,sLon:8.701503,lLat:47.012549,lLon:8.67004,dur:"0h 12m",dk:"2.7",sl:"2.5",kmh:"13.0",hd:"959",msa:"1549",ml:"590",hm:"1552",hg:"2",ms:"-8.8",mst:"0.2",ge:"Advance Alpha 5/26",pa:"",be:"Übungsflug Alpha 5"},
"519":{d:"25.3.16",sz:"09:19:41",lz:"09:27:51",st:"Bellwald Ried unten",la:"Fieschertal Flyingcenter",sLat:46.432528,sLon:8.153185,lLat:46.421062,lLon:8.145385,dur:"0h 8m",dk:"1.4",sl:"1.4",kmh:"10.3",hd:"489",msa:"1580",ml:"1091",hm:"1579",hg:"",ms:"-7.2",mst:"",ge:"Advance Alpha 5/26",pa:"",be:"Übungsflug Alpha 5"},
"520":{d:"9.4.16",sz:"09:43:10",lz:"09:50:50",st:"Bellwald Ried unten",la:"Fieschertal Flyingcenter",sLat:46.432528,sLon:8.153185,lLat:46.421062,lLon:8.145385,dur:"0h 8m",dk:"1.4",sl:"1.4",kmh:"11.0",hd:"489",msa:"1580",ml:"1091",hm:"1579",hg:"1",ms:"-5.8",mst:"0.2",ge:"Advance Alpha 5/26",pa:"",be:"Übungsflug Alpha 5"},
"521":{d:"9.4.16",sz:"10:39:44",lz:"10:43:49",st:"Bellwald Ried unten",la:"Fieschertal Flyingcenter",sLat:46.432528,sLon:8.153185,lLat:46.421062,lLon:8.145385,dur:"0h 4m",dk:"1.4",sl:"1.4",kmh:"20.6",hd:"489",msa:"1580",ml:"1091",hm:"1579",hg:"",ms:"-4.8",mst:"0.2",ge:"Advance Alpha 5/26",pa:"",be:"Übungsflug Alpha 5"},
"522":{d:"9.4.16",sz:"12:22:08",lz:"12:29:03",st:"Bellwald Ried unten",la:"Fieschertal Flyingcenter",sLat:46.432528,sLon:8.153185,lLat:46.421062,lLon:8.145385,dur:"0h 7m",dk:"1.4",sl:"1.4",kmh:"12.1",hd:"489",msa:"1580",ml:"1091",hm:"1579",hg:"",ms:"-5.2",mst:"0.4",ge:"Advance Alpha 5/26",pa:"",be:"Übungsflug Alpha 5"},
"523":{d:"9.4.16",sz:"13:21:33",lz:"13:29:23",st:"Bellwald Ried unten",la:"Fieschertal Flyingcenter",sLat:46.432528,sLon:8.153185,lLat:46.421062,lLon:8.145385,dur:"0h 8m",dk:"1.4",sl:"1.4",kmh:"10.7",hd:"489",msa:"1580",ml:"1091",hm:"1580",hg:"",ms:"-6.4",mst:"",ge:"Advance Alpha 5/26",pa:"",be:"Übungsflug Alpha 5"},
"524":{d:"9.4.16",sz:"15:38:02",lz:"15:44:22",st:"Bellwald Ried unten",la:"Fieschertal Flyingcenter",sLat:46.432528,sLon:8.153185,lLat:46.421062,lLon:8.145385,dur:"0h 6m",dk:"1.4",sl:"1.4",kmh:"13.3",hd:"489",msa:"1580",ml:"1091",hm:"1579",hg:"",ms:"-3.8",mst:"0.2",ge:"Advance Alpha 5/26",pa:"",be:"Übungsflug Alpha 5"},
"525":{d:"10.4.16",sz:"10:14:33",lz:"10:26:43",st:"Fiescheralp Heimat",la:"Fieschertal Flyingcenter",sLat:46.414477,sLon:8.108295,lLat:46.421062,lLon:8.145385,dur:"0h 12m",dk:"6",sl:"2.9",kmh:"29.6",hd:"1055",msa:"2146",ml:"1091",hm:"2108",hg:"28",ms:"-8.6",mst:"1.8",ge:"Advance Alpha 5/26",pa:"",be:"Übungsflug Alpha 5"},
"526":{d:"10.4.16",sz:"11:22:36",lz:"11:31:56",st:"Bellwald Ried unten",la:"Fieschertal Flyingcenter",sLat:46.432528,sLon:8.153185,lLat:46.421062,lLon:8.145385,dur:"0h 9m",dk:"1.7",sl:"1.4",kmh:"10.9",hd:"489",msa:"1580",ml:"1091",hm:"1589",hg:"8",ms:"-5.8",mst:"",ge:"Advance Alpha 5/26",pa:"",be:"Übungsflug Alpha 5, mit Touch and Go"},
"527":{d:"11.4.16",sz:"10:16:00",lz:"10:37:25",st:"Amisbühl",la:"Unterseen Lehn",sLat:46.700227,sLon:7.8206,lLat:46.680598,lLon:7.823441,dur:"0h 21m",dk:"3",sl:"2.2",kmh:"8.4",hd:"686",msa:"1310",ml:"624",hm:"1310",hg:"",ms:"-8.4",mst:"0.4",ge:"Advance Alpha 5/26",pa:"",be:"Biplace-Solo Prüfung Aufgabe 1+6: Doppelkreis rechts, mit Rückwärtsstart, positiv."},
"528":{d:"11.4.16",sz:"12:00:30",lz:"12:15:05",st:"Amisbühl",la:"Unterseen Lehn",sLat:46.700227,sLon:7.8206,lLat:46.680598,lLon:7.823441,dur:"0h 15m",dk:"2.2",sl:"2.2",kmh:"9.1",hd:"686",msa:"1310",ml:"624",hm:"1311",hg:"37",ms:"-4.4",mst:"1.6",ge:"Advance Alpha 5/26",pa:"",be:"Biplace-Solo Prüfung Aufgabe 2: Acht, negativ."},
"529":{d:"11.4.16",sz:"14:48:40",lz:"14:56:15",st:"Luegibrüggli",la:"Unterseen Lehn",sLat:46.690834,sLon:7.81014,lLat:46.680598,lLon:7.823441,dur:"0h 8m",dk:"1.7",sl:"1.5",kmh:"13.5",hd:"477",msa:"1101",ml:"624",hm:"1101",hg:"",ms:"-3",mst:"",ge:"Advance Alpha 5/26",pa:"",be:"Freiflug anlässlich der Prüfung, zu viel Wind"},
"530":{d:"12.4.16",sz:"12:00:00",lz:"12:10:00",st:"Enetchirelallmi",la:"Enetchirel",sLat:46.604353,sLon:7.528682,lLat:46.606081,lLon:7.528319,dur:"0h 10m",dk:"0.5",sl:"0.2",kmh:"3.0",hd:"90",msa:"1220",ml:"1130",hm:"1220",hg:"",ms:"",mst:"",ge:"Advance Alpha 5/26",pa:"",be:"Biplace-Solo Prüfung Aufgabe 4: Hanglandung, positiv"},
"531":{d:"12.4.16",sz:"12:00:00",lz:"12:10:00",st:"Enetchirelallmi",la:"Enetchirel",sLat:46.604353,sLon:7.528682,lLat:46.606081,lLon:7.528319,dur:"0h 10m",dk:"0.5",sl:"0.2",kmh:"3.0",hd:"90",msa:"1220",ml:"1130",hm:"1220",hg:"",ms:"",mst:"",ge:"Advance Alpha 5/26",pa:"",be:"Biplace-Solo Prüfung Aufgabe 5: Touch and go, positiv"},
"532":{d:"12.4.16",sz:"12:00:00",lz:"12:10:00",st:"Grossmattli Entschwil",la:"Grossmattli Entschwil",sLat:46.613837,sLon:7.546321,lLat:46.613837,lLon:7.546321,dur:"0h 10m",dk:"0.3",sl:"0.0",kmh:"1.8",hd:"0",msa:"1120",ml:"1120",hm:"1120",hg:"",ms:"",mst:"",ge:"Advance Alpha 5/26",pa:"",be:"Biplace-Solo Prüfung Aufgabe 7: Slalom, positiv im 2. Versuch"},
"533":{d:"12.4.16",sz:"11:00:00",lz:"11:15:00",st:"Geeristein Nidfluh (BE)",la:"Wyler Därstetten (BE)",sLat:46.66775,sLon:7.508651,lLat:46.657434,lLon:7.504967,dur:"0h 15m",dk:"1",sl:"1.2",kmh:"4.0",hd:"546",msa:"1325",ml:"779",hm:"1325",hg:"",ms:"",mst:"",ge:"Advance Alpha 5/26",pa:"",be:"Biplace-Solo Prüfung Aufgabe 2: Acht, positiv."},
"534":{d:"12.4.16",sz:"13:21:14",lz:"13:26:44",st:"Geeristein Nidfluh (BE)",la:"Wyler Därstetten (BE)",sLat:46.66775,sLon:7.508651,lLat:46.657434,lLon:7.504967,dur:"0h 6m",dk:"1.2",sl:"1.2",kmh:"13.1",hd:"546",msa:"1325",ml:"779",hm:"1325",hg:"",ms:"-4.6",mst:"",ge:"Advance Alpha 5/26",pa:"",be:"Biplace-Solo Prüfung Aufgabe 3: Klapper rechts, Ohren anlegen, positiv."},
"535":{d:"30.4.16",sz:"09:26:18",lz:"09:40:48",st:"Rotenflue Ost",la:"Rickenbach",sLat:47.018308,sLon:8.702177,lLat:47.012549,lLon:8.67004,dur:"0h 15m",dk:"3.4",sl:"2.5",kmh:"14.1",hd:"960",msa:"1550",ml:"590",hm:"1550",hg:"3",ms:"-5",mst:"1.6",ge:"Gradient BiGolden 3/39",pa:"Peter Ruepp",be:"Tandem-Übungsflüge mit Peter, Prüfungsprogramm, visiertOstwind, viel Schnee, 1 Fehlstart"},
"536":{d:"30.4.16",sz:"10:40:19",lz:"10:50:49",st:"Rotenflue SW Sommer",la:"Rickenbach",sLat:47.017641,sLon:8.700727,lLat:47.012549,lLon:8.67004,dur:"0h 11m",dk:"2.4",sl:"2.4",kmh:"13.7",hd:"928",msa:"1518",ml:"590",hm:"1486",hg:"9",ms:"-10.4",mst:"0.4",ge:"Gradient BiGolden 3/39",pa:"Peter Ruepp",be:"Tandem-Übungsflüge mit Peter, Prüfungsprogramm, visiert"},
"537":{d:"30.4.16",sz:"12:05:17",lz:"12:17:17",st:"Rotenflue SW Sommer",la:"Rickenbach",sLat:47.017641,sLon:8.700727,lLat:47.012549,lLon:8.67004,dur:"0h 12m",dk:"2.5",sl:"2.4",kmh:"12.5",hd:"928",msa:"1518",ml:"590",hm:"1490",hg:"7",ms:"-9.4",mst:"0.2",ge:"Gradient BiGolden 3/39",pa:"Peter Ruepp",be:"Tandem-Übungsflüge mit Peter, Prüfungsprogramm, visiert, 1 Fehlstart, Rückenwind"},
"538":{d:"15.5.16",sz:"11:20:00",lz:"11:30:00",st:"Rigi Seebodenalp",la:"Küssnacht",sLat:47.063445,sLon:8.457515,lLat:47.06739,lLon:8.435432,dur:"0h 10m",dk:"3",sl:"1.7",kmh:"18.0",hd:"569",msa:"1032",ml:"463",hm:"1032",hg:"",ms:"",mst:"",ge:"Gradient BiGolden 3/39",pa:"Giani Tannò",be:"Tandem-Übungsflüge mit Giani, Prüfungsprogramm, visiert, 1 Fehlstart, Rückenwind. Doppelacht 38\""},
"539":{d:"15.5.16",sz:"12:18:55",lz:"12:27:55",st:"Rigi Seebodenalp",la:"Küssnacht",sLat:47.063445,sLon:8.457515,lLat:47.06739,lLon:8.435432,dur:"0h 9m",dk:"2.5",sl:"1.7",kmh:"16.7",hd:"569",msa:"1032",ml:"463",hm:"984",hg:"41",ms:"-4.8",mst:"2",ge:"Gradient BiGolden 3/39",pa:"Giani Tannò",be:"Tandem-Übungsflüge mit Giani, Prüfungsprogramm, visiert. Doppelacht 37\", S 34\""},
"540":{d:"15.5.16",sz:"14:12:41",lz:"14:23:11",st:"Rigi Seebodenalp",la:"Küssnacht",sLat:47.063445,sLon:8.457515,lLat:47.06739,lLon:8.435432,dur:"0h 11m",dk:"1.9",sl:"1.7",kmh:"10.9",hd:"569",msa:"1032",ml:"463",hm:"1033",hg:"5",ms:"-3.8",mst:"0.2",ge:"Gradient BiGolden 3/39",pa:"Giani Tannò",be:"Tandem-Übungsflüge mit Giani, Prüfungsprogramm, visiert, Beide Figuren gut."},
"541":{d:"15.5.16",sz:"15:25:00",lz:"15:35:00",st:"Rigi Seebodenalp",la:"Küssnacht",sLat:47.063445,sLon:8.457515,lLat:47.06739,lLon:8.435432,dur:"0h 10m",dk:"3",sl:"1.7",kmh:"18.0",hd:"569",msa:"1032",ml:"463",hm:"1032",hg:"",ms:"",mst:"",ge:"Gradient BiGolden 3/39",pa:"Giani Tannò",be:"Tandem-Übungsflüge mit Giani, Prüfungsprogramm, visiert, gut."},
"542":{d:"21.5.16",sz:"09:13:57",lz:"09:22:57",st:"Rotenflue SW Sommer",la:"Rickenbach",sLat:47.017641,sLon:8.700727,lLat:47.012549,lLon:8.67004,dur:"0h 9m",dk:"3.1",sl:"2.4",kmh:"20.7",hd:"928",msa:"1518",ml:"590",hm:"1483",hg:"2",ms:"-9.8",mst:"0.2",ge:"Gradient BiGolden 3/39",pa:"Stefan Eberle",be:"Tandem-Übungsflüge mit Stefan, Prüfungsprogramm, visiert, alle Figuren so lal la, Landung zu kurz"},
"543":{d:"21.5.16",sz:"10:15:25",lz:"10:23:55",st:"Rotenflue SW Sommer",la:"Rickenbach",sLat:47.017641,sLon:8.700727,lLat:47.012549,lLon:8.67004,dur:"0h 9m",dk:"2.4",sl:"2.4",kmh:"16.9",hd:"928",msa:"1518",ml:"590",hm:"1482",hg:"1",ms:"-5.2",mst:"0.2",ge:"Gradient BiGolden 3/39",pa:"Stefan Eberle",be:"Tandem-Übungsflüge mit Stefan, Prüfungsprogramm, visiert, alle Figuren knapp gut, Landung zu lang"},
"544":{d:"21.5.16",sz:"11:13:52",lz:"11:23:12",st:"Rotenflue SW Sommer",la:"Rickenbach",sLat:47.017641,sLon:8.700727,lLat:47.012549,lLon:8.67004,dur:"0h 9m",dk:"2.4",sl:"2.4",kmh:"15.4",hd:"928",msa:"1518",ml:"590",hm:"1481",hg:"",ms:"-5.4",mst:"0.6",ge:"Gradient BiGolden 3/39",pa:"Stefan Eberle",be:"Tandem-Übungsflüge mit Stefan, Prüfungsprogramm, visiert, alle Figuren immer besser, Landung zu lang"},
"545":{d:"21.5.16",sz:"12:16:14",lz:"12:25:09",st:"Rotenflue SW Sommer",la:"Rickenbach",sLat:47.017641,sLon:8.700727,lLat:47.012549,lLon:8.67004,dur:"0h 9m",dk:"2.4",sl:"2.4",kmh:"16.1",hd:"928",msa:"1518",ml:"590",hm:"1481",hg:"",ms:"-5",mst:"0.2",ge:"Gradient BiGolden 3/39",pa:"Stefan Eberle",be:"Tandem-Übungsflüge mit Stefan, Prüfungsprogramm, visiert, alle Figuren ok, Landung zu kurz"},
"546":{d:"21.5.16",sz:"13:17:39",lz:"13:25:52",st:"Rotenflue SW Sommer",la:"Rickenbach",sLat:47.017641,sLon:8.700727,lLat:47.012549,lLon:8.67004,dur:"0h 8m",dk:"2.4",sl:"2.4",kmh:"17.5",hd:"928",msa:"1518",ml:"590",hm:"1480",hg:"",ms:"-4.4",mst:"0.2",ge:"Gradient BiGolden 3/39",pa:"Stefan Eberle",be:"Tandem-Übungsflüge mit Stefan, Prüfungsprogramm, visiert, alle Figuren so lal la, Landung zu kurz"},
"547":{d:"21.5.16",sz:"14:54:15",lz:"15:05:00",st:"Rotenflue SW Sommer",la:"Rickenbach",sLat:47.017641,sLon:8.700727,lLat:47.012549,lLon:8.67004,dur:"0h 11m",dk:"2.4",sl:"2.4",kmh:"13.4",hd:"928",msa:"1518",ml:"590",hm:"1481",hg:"",ms:"-4.6",mst:"0.2",ge:"Gradient BiGolden 3/39",pa:"Stefan Eberle",be:"Tandem-Übungsflüge mit Stefan, Prüfungsprogramm, visiert, alle Figuren immer besser, Landung zu kurz"},
"548":{d:"21.5.16",sz:"16:00:12",lz:"16:09:37",st:"Rotenflue SW Sommer",la:"Rickenbach",sLat:47.017641,sLon:8.700727,lLat:47.012549,lLon:8.67004,dur:"0h 9m",dk:"2.4",sl:"2.4",kmh:"15.3",hd:"928",msa:"1518",ml:"590",hm:"1481",hg:"",ms:"-9",mst:"0.2",ge:"Gradient BiGolden 3/39",pa:"Stefan Eberle",be:"Tandem-Übungsflüge mit Stefan, Prüfungsprogramm, visiert, alle Figuren gut, Landung zu kurz, Wind."},
"549":{d:"28.5.16",sz:"10:47:14",lz:"10:56:09",st:"Rotenflue Ost",la:"Rickenbach",sLat:47.018308,sLon:8.702177,lLat:47.012549,lLon:8.67004,dur:"0h 9m",dk:"4",sl:"2.5",kmh:"26.9",hd:"960",msa:"1550",ml:"590",hm:"1550",hg:"",ms:"-4.4",mst:"0.2",ge:"Gradient BiGolden 3/39",pa:"Peter Ruepp",be:"Tandem-Übungsflüge mit Peter, Prüfungsprogramm, visiert, 3x180° gut, Kreis re/li/re knapp, Start gut, Landung gut."},
"550":{d:"28.5.16",sz:"12:17:00",lz:"12:30:08",st:"Rotenflue SW Sommer",la:"Rickenbach",sLat:47.017641,sLon:8.700727,lLat:47.012549,lLon:8.67004,dur:"0h 13m",dk:"3.3",sl:"2.4",kmh:"15.1",hd:"928",msa:"1518",ml:"590",hm:"1485",hg:"4",ms:"-4.6",mst:"0.2",ge:"Gradient BiGolden 3/39",pa:"Peter Ruepp",be:"Tandem-Übungsflüge mit Peter, Prüfungsprogramm, visiert, 3x180° gut, Kreis re/li/re knapp, Start gut, Landung gut."},
"551":{d:"28.5.16",sz:"13:08:48",lz:"13:19:28",st:"Rotenflue SW Sommer",la:"Rickenbach",sLat:47.017641,sLon:8.700727,lLat:47.012549,lLon:8.67004,dur:"0h 11m",dk:"3.2",sl:"2.4",kmh:"18.0",hd:"928",msa:"1518",ml:"590",hm:"1481",hg:"",ms:"-7.4",mst:"0.2",ge:"Gradient BiGolden 3/39",pa:"Peter Ruepp",be:"Tandem-Übungsflüge mit Peter, Prüfungsprogramm, visiert, 3x180° gut, Kreis re/li/re knapp, Start gut, Landung gut."},
"552":{d:"28.5.16",sz:"14:03:43",lz:"14:15:08",st:"Rotenflue SSW Winter",la:"Rickenbach",sLat:47.01819,sLon:8.701503,lLat:47.012549,lLon:8.67004,dur:"0h 11m",dk:"2.7",sl:"2.5",kmh:"14.2",hd:"959",msa:"1549",ml:"590",hm:"1547",hg:"",ms:"-4.8",mst:"0.2",ge:"Gradient BiGolden 3/39",pa:"Peter Ruepp",be:"Tandem-Übungsflüge mit Peter, Prüfungsprogramm, visiert, 3x180° gut, Kreis re/li/re knapp, Start nach NW, steil, gut, Landung gut."},
"553":{d:"28.5.16",sz:"15:56:05",lz:"16:09:58",st:"Rotenflue SSW Winter",la:"Rickenbach",sLat:47.01819,sLon:8.701503,lLat:47.012549,lLon:8.67004,dur:"0h 14m",dk:"2.7",sl:"2.5",kmh:"11.7",hd:"959",msa:"1549",ml:"590",hm:"1547",hg:"1",ms:"-4.8",mst:"0.2",ge:"Gradient BiGolden 3/39",pa:"Peter Ruepp",be:"Tandem-Übungsflüge mit Peter, Prüfungsprogramm, visiert, 3x180° gut, Kreis re/li/re knapp, Start gut, Landung gut."},
"554":{d:"22.6.16",sz:"13:22:36",lz:"13:34:06",st:"Rotenflue SW Sommer",la:"Rickenbach",sLat:47.017641,sLon:8.700727,lLat:47.012549,lLon:8.67004,dur:"0h 12m",dk:"2.5",sl:"2.4",kmh:"13.0",hd:"928",msa:"1518",ml:"590",hm:"1480",hg:"",ms:"-8.2",mst:"0.2",ge:"Gradient BiGolden 3/39",pa:"Peter Ruepp",be:"Tandem-Übungsflüge mit Peter, Prüfungsprogramm."},
"555":{d:"22.6.16",sz:"14:15:56",lz:"14:29:01",st:"Rotenflue SSW Winter",la:"Rickenbach",sLat:47.01819,sLon:8.701503,lLat:47.012549,lLon:8.67004,dur:"0h 13m",dk:"3.6",sl:"2.5",kmh:"16.5",hd:"959",msa:"1549",ml:"590",hm:"1546",hg:"",ms:"-8.4",mst:"",ge:"Gradient BiGolden 3/39",pa:"Peter Ruepp",be:"Tandem-Übungsflüge mit Peter, Prüfungsprogramm."},
"556":{d:"22.6.16",sz:"15:11:43",lz:"15:23:13",st:"Rotenflue SW Sommer",la:"Rickenbach",sLat:47.017641,sLon:8.700727,lLat:47.012549,lLon:8.67004,dur:"0h 12m",dk:"2.4",sl:"2.4",kmh:"12.5",hd:"928",msa:"1518",ml:"590",hm:"1480",hg:"",ms:"-4.6",mst:"0.2",ge:"Gradient BiGolden 3/39",pa:"Peter Ruepp",be:"Tandem-Übungsflüge mit Peter, Prüfungsprogramm."},
"557":{d:"22.6.16",sz:"16:12:54",lz:"16:23:19",st:"Rotenflue SW Sommer",la:"Rickenbach",sLat:47.017641,sLon:8.700727,lLat:47.012549,lLon:8.67004,dur:"0h 10m",dk:"2.4",sl:"2.4",kmh:"13.8",hd:"928",msa:"1518",ml:"590",hm:"1480",hg:"",ms:"-9.8",mst:"0.2",ge:"Gradient BiGolden 3/39",pa:"Peter Ruepp",be:"Tandem-Übungsflüge mit Peter, Prüfungsprogramm."},
"558":{d:"22.6.16",sz:"17:05:55",lz:"17:19:48",st:"Rotenflue SW Sommer",la:"Rickenbach",sLat:47.017641,sLon:8.700727,lLat:47.012549,lLon:8.67004,dur:"0h 14m",dk:"2.6",sl:"2.4",kmh:"11.2",hd:"928",msa:"1518",ml:"590",hm:"1482",hg:"1",ms:"-5.6",mst:"0.2",ge:"Gradient BiGolden 3/39",pa:"Peter Ruepp",be:"Tandem-Übungsflüge mit Peter, Prüfungsprogramm."},
"559":{d:"25.6.16",sz:"09:14:09",lz:"09:22:49",st:"Fiescheralp Heimat",la:"Fieschertal Flyingcenter",sLat:46.414477,sLon:8.108295,lLat:46.421062,lLon:8.145385,dur:"0h 9m",dk:"4",sl:"2.9",kmh:"27.7",hd:"1055",msa:"2146",ml:"1091",hm:"2145",hg:"",ms:"-4.6",mst:"",ge:"Gradient BiGolden 3/39",pa:"Peter Ruepp",be:"Tandem-Übungsflüge mit Peter, Prüfungsprogramm."},
"560":{d:"25.6.16",sz:"11:28:26",lz:"11:42:06",st:"Fiescheralp Heimat",la:"Fieschertal Flyingcenter",sLat:46.414477,sLon:8.108295,lLat:46.421062,lLon:8.145385,dur:"0h 14m",dk:"4.3",sl:"2.9",kmh:"18.9",hd:"1055",msa:"2146",ml:"1091",hm:"2144",hg:"",ms:"-5.8",mst:"0.2",ge:"Gradient BiGolden 3/39",pa:"Peter Ruepp",be:"Tandem-Übungsflüge mit Peter, Prüfungsprogramm."},
"561":{d:"26.6.16",sz:"13:43:35",lz:"13:55:20",st:"Fiescheralp Heimat",la:"Fieschertal Flyingcenter",sLat:46.414477,sLon:8.108295,lLat:46.421062,lLon:8.145385,dur:"0h 12m",dk:"3.8",sl:"2.9",kmh:"19.4",hd:"1055",msa:"2146",ml:"1091",hm:"2145",hg:"",ms:"-5.4",mst:"0.2",ge:"Gradient BiGolden 3/39",pa:"Stefan Eberle",be:"Tandem-Übungsflüge mit Stefan, Prüfungsprogramm."},
"562":{d:"9.7.16",sz:"09:23:16",lz:"09:31:51",st:"Rotenflue SW Sommer",la:"Rickenbach",sLat:47.017641,sLon:8.700727,lLat:47.012549,lLon:8.67004,dur:"0h 9m",dk:"2.4",sl:"2.4",kmh:"16.8",hd:"928",msa:"1518",ml:"590",hm:"1481",hg:"",ms:"-4.2",mst:"0.2",ge:"Gradient BiGolden 3/39",pa:"Giani Tannò",be:"Tandem-Übungsflüge mit Giani, Prüfungsprogramm."},
"563":{d:"9.7.16",sz:"10:18:55",lz:"10:31:35",st:"Rotenflue SW Sommer",la:"Rickenbach",sLat:47.017641,sLon:8.700727,lLat:47.012549,lLon:8.67004,dur:"0h 13m",dk:"2.6",sl:"2.4",kmh:"12.3",hd:"928",msa:"1518",ml:"590",hm:"1491",hg:"10",ms:"-4.6",mst:"0.2",ge:"Gradient BiGolden 3/39",pa:"Giani Tannò",be:"Tandem-Übungsflüge mit Giani, Prüfungsprogramm."},
"564":{d:"9.7.16",sz:"11:14:15",lz:"11:22:10",st:"Rotenflue SW Sommer",la:"Rickenbach",sLat:47.017641,sLon:8.700727,lLat:47.012549,lLon:8.67004,dur:"0h 8m",dk:"2.7",sl:"2.4",kmh:"20.5",hd:"928",msa:"1518",ml:"590",hm:"1481",hg:"",ms:"-8.2",mst:"0.2",ge:"Gradient BiGolden 3/39",pa:"Giani Tannò",be:"Tandem-Übungsflüge mit Giani, Prüfungsprogramm."},
"565":{d:"11.7.16",sz:"09:54:39",lz:"10:03:19",st:"Allmenalp",la:"Kandersteg Bütschels",sLat:46.49467,sLon:7.650757,lLat:46.48995,lLon:7.663333,dur:"0h 9m",dk:"1.1",sl:"1.1",kmh:"7.6",hd:"577",msa:"1728",ml:"1151",hm:"1728",hg:"",ms:"-10.2",mst:"0.2",ge:"Gradient BiGolden 3/39",pa:"Stefan Eberle",be:"Biplace-Tandem-Prüfung Aufgabe 1: 3 Kreise rechts, negativ (Landung)"},
"566":{d:"11.7.16",sz:"10:51:30",lz:"10:58:10",st:"Allmenalp",la:"Kandersteg Bütschels",sLat:46.49467,sLon:7.650757,lLat:46.48995,lLon:7.663333,dur:"0h 7m",dk:"1.1",sl:"1.1",kmh:"9.9",hd:"577",msa:"1728",ml:"1151",hm:"1728",hg:"",ms:"-4.8",mst:"",ge:"Gradient BiGolden 3/39",pa:"Stefan Eberle",be:"Biplace-Tandem-Prüfung Aufgabe 2: 3 Kreise li/re/li, negativ (Zeit, Landung). Theorie gut."},
"567":{d:"11.7.16",sz:"11:58:36",lz:"12:07:26",st:"Allmenalp",la:"Kandersteg Bütschels",sLat:46.49467,sLon:7.650757,lLat:46.48995,lLon:7.663333,dur:"0h 9m",dk:"1.1",sl:"1.1",kmh:"7.5",hd:"577",msa:"1728",ml:"1151",hm:"1727",hg:"",ms:"-3.8",mst:"",ge:"Gradient BiGolden 3/39",pa:"Stefan Eberle",be:"Biplace-Tandem-Prüfung Aufgabe 3: 90°-3x180°-90°, positiv"},
"568":{d:"11.7.16",sz:"12:56:05",lz:"13:05:45",st:"Allmenalp",la:"Kandersteg Bütschels",sLat:46.49467,sLon:7.650757,lLat:46.48995,lLon:7.663333,dur:"0h 10m",dk:"1.1",sl:"1.1",kmh:"6.8",hd:"577",msa:"1728",ml:"1151",hm:"1728",hg:"",ms:"-9.4",mst:"",ge:"Gradient BiGolden 3/39",pa:"Stefan Eberle",be:"Biplace-Tandem-Prüfung Aufgabe 1: 3 Kreise rechts, positiv"},
"569":{d:"11.7.16",sz:"13:42:27",lz:"13:49:22",st:"Allmenalp",la:"Kandersteg Bütschels",sLat:46.49467,sLon:7.650757,lLat:46.48995,lLon:7.663333,dur:"0h 7m",dk:"1.1",sl:"1.1",kmh:"9.5",hd:"577",msa:"1728",ml:"1151",hm:"1728",hg:"",ms:"-5",mst:"",ge:"Gradient BiGolden 3/39",pa:"Stefan Eberle",be:"Biplace-Tandem-Prüfung Aufgabe 2: 3 Kreise li/re/li, knapp positiv, Landung mit Gegenwind leicht schräg, Figur knapp. GESCHAFFT!!!!!"},
"570":{d:"15.8.16",sz:"12:17:39",lz:"12:47:24",st:"Rotenflue SW Sommer",la:"Rickenbach",sLat:47.017641,sLon:8.700727,lLat:47.012549,lLon:8.67004,dur:"0h 30m",dk:"5.1",sl:"2.4",kmh:"10.3",hd:"928",msa:"1518",ml:"590",hm:"1590",hg:"164",ms:"-4.2",mst:"1.8",ge:"Gradient BiGolden 3/39",pa:"Bea Mair-Noack",be:"Erster Flug mit Bea, Thermik, Startplatzüberhöhung, kurze Spirale (würg...). Alles ok, Start und Landung gut."},
"571":{d:"27.8.16",sz:"12:57:13",lz:"13:44:58",st:"Brunni Schonegg",la:"Engelberg Örtli",sLat:46.847399,sLon:8.420397,lLat:46.816954,lLon:8.415308,dur:"0h 48m",dk:"12.8",sl:"3.4",kmh:"16.1",hd:"909",msa:"1921",ml:"1012",hm:"2513",hg:"752",ms:"-3",mst:"3",ge:"Nova Mentor 3 Light XS",pa:"",be:"Erster Thermikflug seit langem, gute Thermik. Bis Fürenalp und retour."},
"572":{d:"28.8.16",sz:"11:31:51",lz:"11:51:31",st:"Rotenflue SW Sommer",la:"Rickenbach",sLat:47.017641,sLon:8.700727,lLat:47.012549,lLon:8.67004,dur:"0h 20m",dk:"5",sl:"2.4",kmh:"15.3",hd:"928",msa:"1518",ml:"590",hm:"1547",hg:"3",ms:"-5",mst:"0.8",ge:"Nova Mentor 3 Light XS",pa:"",be:""},
"573":{d:"30.8.16",sz:"14:10:00",lz:"14:28:00",st:"Rotenflue SW Sommer",la:"Rickenbach",sLat:47.017641,sLon:8.700727,lLat:47.012549,lLon:8.67004,dur:"0h 18m",dk:"3.6",sl:"2.4",kmh:"12.0",hd:"928",msa:"1518",ml:"590",hm:"1549",hg:"",ms:"",mst:"",ge:"Gradient BiGolden 3/39",pa:"Bea Mair-Noack",be:"Flug mit Bea, ein Fehlstart, gemütlich"},
"574":{d:"3.9.16",sz:"10:18:59",lz:"10:35:39",st:"Fiescheralp Heimat",la:"Fiesch",sLat:46.414477,sLon:8.108295,lLat:46.40933,lLon:8.136896,dur:"0h 17m",dk:"5.1",sl:"2.3",kmh:"18.4",hd:"1090",msa:"2146",ml:"1056",hm:"2146",hg:"5",ms:"-2.2",mst:"1.2",ge:"Nova Mentor 3 Light XS",pa:"",be:"Mantelrisse in den Stammleinen"},
"575":{d:"10.9.16",sz:"10:13:07",lz:"10:34:22",st:"Fiescheralp Heimat",la:"Fieschertal Flyingcenter",sLat:46.414477,sLon:8.108295,lLat:46.421062,lLon:8.145385,dur:"0h 21m",dk:"5.3",sl:"2.9",kmh:"15.0",hd:"1055",msa:"2146",ml:"1091",hm:"2145",hg:"23",ms:"-2.6",mst:"2",ge:"Gradient BiGolden 3/39",pa:"Bea Mair-Noack",be:"Flug mit Bea, ruhig"},
"576":{d:"10.9.16",sz:"11:39:20",lz:"12:37:20",st:"Fiescheralp Heimat",la:"Fieschertal Flyingcenter",sLat:46.414477,sLon:8.108295,lLat:46.421062,lLon:8.145385,dur:"0h 58m",dk:"11.3",sl:"2.9",kmh:"11.7",hd:"1055",msa:"2146",ml:"1091",hm:"2866",hg:"1585",ms:"-3.6",mst:"3.4",ge:"Advance Alpha 5/26",pa:"",be:"Thermikflug, gut, bis über Bellwald"},
"577":{d:"11.9.16",sz:"11:35:31",lz:"12:17:56",st:"Fiescheralp Biplace",la:"Fieschertal Flyingcenter",sLat:46.411504,sLon:8.102926,lLat:46.421062,lLon:8.145385,dur:"0h 42m",dk:"8.3",sl:"3.4",kmh:"11.7",hd:"1104",msa:"2195",ml:"1091",hm:"2300",hg:"805",ms:"-4.2",mst:"3.4",ge:"Gradient BiGolden 3/39",pa:"Tamara",be:"Erster kommerzieller Passagierflug für Hansi, mit Tamara.Landung etwas kurz."},
"578":{d:"25.9.16",sz:"15:33:27",lz:"15:44:07",st:"Zugerberg",la:"Zug",sLat:47.14813,sLon:8.535748,lLat:47.150094,lLon:8.507689,dur:"0h 11m",dk:"3.9",sl:"2.1",kmh:"21.9",hd:"475",msa:"950",ml:"475",hm:"950",hg:"4",ms:"-2.2",mst:"0.8",ge:"Gradient BiGolden 3/39",pa:"Bea Mair-Noack",be:"mit Bea"},
"579":{d:"9.10.16",sz:"14:30:00",lz:"14:50:00",st:"Schranni West",la:"Fieschertal Flyingcenter",sLat:46.447493,sLon:8.145222,lLat:46.421062,lLon:8.145385,dur:"0h 20m",dk:"6",sl:"2.9",kmh:"18.0",hd:"816",msa:"1907",ml:"1091",hm:"1907",hg:"",ms:"",mst:"",ge:"Advance Pi 23",pa:"",be:""},
"580":{d:"22.1.17",sz:"11:34:14",lz:"11:46:54",st:"Jakobshorn Jatzhütte",la:"Davos Jakobshorn Winter",sLat:46.766194,sLon:9.849876,lLat:46.78741,lLon:9.817978,dur:"0h 13m",dk:"4.2",sl:"3.4",kmh:"19.9",hd:"967",msa:"2499",ml:"1532",hm:"2499",hg:"1",ms:"-2.4",mst:"",ge:"Nova Mentor 3 Light XS",pa:"",be:"Verdrehte Tragegurten rechts, aber problemlos. RW-Start"},
"581":{d:"30.1.17",sz:"11:15:00",lz:"11:45:00",st:"Fiescheralp Heimat",la:"Fieschertal Flyingcenter",sLat:46.414477,sLon:8.108295,lLat:46.421062,lLon:8.145385,dur:"0h 30m",dk:"4",sl:"2.9",kmh:"8.0",hd:"1055",msa:"2146",ml:"1091",hm:"2146",hg:"",ms:"",mst:"",ge:"Nova Mentor 3 Light XS",pa:"",be:"Ein Fehlstart im tiefen Schnee, trug nicht, evtl. zu langsam, Rückenwind. Dann Toplanding zwischen Heimat und Fiescheralp."},
"582":{d:"30.1.17",sz:"12:10:00",lz:"12:30:00",st:"Fiescheralp Heimat",la:"Fiesch",sLat:46.414477,sLon:8.108295,lLat:46.40933,lLon:8.136896,dur:"0h 20m",dk:"3",sl:"2.3",kmh:"9.0",hd:"1090",msa:"2146",ml:"1056",hm:"2146",hg:"",ms:"",mst:"",ge:"Nova Mentor 3 Light XS",pa:"",be:"Ruhiger Gleitflug."},
"583":{d:"15.2.17",sz:"10:02:03",lz:"10:29:18",st:"Fiescheralp Heimat",la:"Fiesch",sLat:46.414477,sLon:8.108295,lLat:46.40933,lLon:8.136896,dur:"0h 27m",dk:"4.6",sl:"2.3",kmh:"10.1",hd:"1090",msa:"2146",ml:"1056",hm:"2146",hg:"203",ms:"-2.6",mst:"2.2",ge:"Nova Mentor 3 Light XS",pa:"",be:""},
"584":{d:"15.2.17",sz:"11:39:51",lz:"12:20:26",st:"Fiescheralp Heimat",la:"Fieschertal Flyingcenter",sLat:46.414477,sLon:8.108295,lLat:46.421062,lLon:8.145385,dur:"0h 41m",dk:"7.4",sl:"2.9",kmh:"10.9",hd:"1055",msa:"2146",ml:"1091",hm:"2414",hg:"497",ms:"-2.8",mst:"3",ge:"Nova Mentor 3 Light XS",pa:"",be:""},
"585":{d:"16.2.17",sz:"09:53:13",lz:"10:48:13",st:"Fiescheralp Heimat",la:"Fiesch",sLat:46.414477,sLon:8.108295,lLat:46.40933,lLon:8.136896,dur:"0h 55m",dk:"8.1",sl:"2.3",kmh:"8.8",hd:"1090",msa:"2146",ml:"1056",hm:"2300",hg:"575",ms:"-3.2",mst:"2.4",ge:"Nova Mentor 3 Light XS",pa:"",be:""},
"586":{d:"16.2.17",sz:"11:41:38",lz:"12:05:03",st:"Fiescheralp Heimat",la:"Fieschertal Flyingcenter",sLat:46.414477,sLon:8.108295,lLat:46.421062,lLon:8.145385,dur:"0h 23m",dk:"6.9",sl:"2.9",kmh:"17.7",hd:"1055",msa:"2146",ml:"1091",hm:"2388",hg:"283",ms:"-3.4",mst:"2.4",ge:"Nova Mentor 3 Light XS",pa:"",be:""},
"587":{d:"18.2.17",sz:"11:31:34",lz:"12:07:54",st:"Fiescheralp Heimat",la:"Fiesch",sLat:46.414477,sLon:8.108295,lLat:46.40933,lLon:8.136896,dur:"0h 36m",dk:"7.5",sl:"2.3",kmh:"12.4",hd:"1090",msa:"2146",ml:"1056",hm:"2195",hg:"338",ms:"-2.6",mst:"2.4",ge:"Nova Mentor 3 Light XS",pa:"",be:""},
"588":{d:"25.2.17",sz:"12:02:32",lz:"12:13:47",st:"Motta Naluns",la:"Scuol",sLat:46.790828,sLon:10.282705,lLat:46.794543,lLon:10.283924,dur:"0h 11m",dk:"5.3",sl:"0.4",kmh:"28.3",hd:"765",msa:"2052",ml:"1287",hm:"2052",hg:"19",ms:"-5.6",mst:"1.4",ge:"Gradient BiGolden 3/39",pa:"Lynn Plüss",be:"Flug mit Lynn, mässige Termik"},
"589":{d:"25.2.17",sz:"13:49:04",lz:"14:11:29",st:"Motta Naluns",la:"Scuol",sLat:46.790828,sLon:10.282705,lLat:46.794543,lLon:10.283924,dur:"0h 22m",dk:"5.8",sl:"0.4",kmh:"15.5",hd:"765",msa:"2052",ml:"1287",hm:"2061",hg:"169",ms:"-3.6",mst:"2.2",ge:"Gradient BiGolden 3/39",pa:"Andrin Plüss",be:"Flug mit Andrin, ein Fehlstart. Unten guten Thermik."},
"590":{d:"11.3.17",sz:"15:41:22",lz:"15:55:37",st:"Rotenflue SSW Winter",la:"Rickenbach",sLat:47.01819,sLon:8.701503,lLat:47.012549,lLon:8.67004,dur:"0h 14m",dk:"4",sl:"2.5",kmh:"16.8",hd:"959",msa:"1549",ml:"590",hm:"1551",hg:"6",ms:"-3",mst:"0.2",ge:"Gradient BiGolden 3/39",pa:"Claris Mair-Noack",be:"Erster Flug mit Claris, gefiel ihr gut. Ruhig, Start im Schnee"},
"591":{d:"1.4.17",sz:"16:40:33",lz:"16:51:43",st:"Zugerberg",la:"Zugerberg",sLat:47.14813,sLon:8.535748,lLat:47.14813,lLon:8.535748,dur:"0h 11m",dk:"0.3",sl:"0.0",kmh:"1.6",hd:"0",msa:"950",ml:"950",hm:"1026",hg:"131",ms:"-1.6",mst:"2",ge:"Nova Mentor 3 Light XS",pa:"",be:"Guter Starkwindstart, Startüberhöhung, Toplandung. Beobachte Absturz (Lukas Müller, Luzern), Hilfe am Unfallort, REGA."},
"592":{d:"16.4.17",sz:"11:07:00",lz:"11:30:35",st:"Fiescheralp Heimat",la:"Fiesch",sLat:46.414477,sLon:8.108295,lLat:46.40933,lLon:8.136896,dur:"0h 24m",dk:"6.5",sl:"2.3",kmh:"16.5",hd:"1090",msa:"2146",ml:"1056",hm:"2146",hg:"55",ms:"-2.8",mst:"1.4",ge:"Gradient BiGolden 3/39",pa:"Alena Mair-Noack",be:"Mit Alena, Rückenwindstart."},
"593":{d:"17.4.17",sz:"09:17:17",lz:"09:25:12",st:"Bellwald Ried oben",la:"Fieschertal Flyingcenter",sLat:46.434696,sLon:8.151756,lLat:46.421062,lLon:8.145385,dur:"0h 8m",dk:"2",sl:"1.6",kmh:"15.2",hd:"512",msa:"1603",ml:"1091",hm:"1582",hg:"2",ms:"-2.2",mst:"",ge:"Gradient BiGolden 3/39",pa:"Meret Steudler",be:"Mit Meret. Winterliche Verhätnisse. Ruhig."},
"594":{d:"17.4.17",sz:"10:09:34",lz:"10:16:29",st:"Bellwald Ried oben",la:"Fieschertal Flyingcenter",sLat:46.434696,sLon:8.151756,lLat:46.421062,lLon:8.145385,dur:"0h 7m",dk:"2",sl:"1.6",kmh:"17.3",hd:"512",msa:"1603",ml:"1091",hm:"1581",hg:"1",ms:"-2.2",mst:"",ge:"Gradient BiGolden 3/39",pa:"Meret Steudler",be:"2. Flug mit Meret, ebenfalls ruhig."},
"595":{d:"17.4.17",sz:"11:05:41",lz:"11:11:46",st:"Bellwald Ried oben",la:"Fieschertal Flyingcenter",sLat:46.434696,sLon:8.151756,lLat:46.421062,lLon:8.145385,dur:"0h 6m",dk:"2",sl:"1.6",kmh:"19.7",hd:"512",msa:"1603",ml:"1091",hm:"1580",hg:"",ms:"-4.4",mst:"",ge:"Nova Mentor 3 Light XS",pa:"",be:"Solo, ruhig. Landung mit Pumpen."},
"596":{d:"22.4.17",sz:"11:08:42",lz:"11:16:07",st:"Zugerberg",la:"Zug",sLat:47.14813,sLon:8.535748,lLat:47.150094,lLon:8.507689,dur:"0h 7m",dk:"3.8",sl:"2.1",kmh:"30.7",hd:"475",msa:"950",ml:"475",hm:"951",hg:"1",ms:"-2.8",mst:"0.2",ge:"Gradient BiGolden 3/39",pa:"Robin van den Wildenberg",be:"Erster Flug mit Robin, kurz, gemütlich. Voller Startplatz. Landung etwas schnell."},
"597":{d:"23.4.17",sz:"16:39:04",lz:"17:19:24",st:"Zugerberg",la:"Zugerberg",sLat:47.14813,sLon:8.535748,lLat:47.14813,lLon:8.535748,dur:"0h 40m",dk:"3.5",sl:"0.0",kmh:"5.2",hd:"0",msa:"950",ml:"950",hm:"1102",hg:"641",ms:"-3.2",mst:"2.8",ge:"Gradient BiGolden 3/39",pa:"Alena Mair-Noack",be:"Erster Rückwärtsstart im Tandem. Soaring mit Alena, böiger NW-Wind. Nach langem Kampf gute Startplatzüberhöhung, Toplandung."},
"598":{d:"3.6.17",sz:"09:45:33",lz:"10:26:03",st:"Fiescheralp Heimat",la:"Fieschertal Flyingcenter",sLat:46.414477,sLon:8.108295,lLat:46.421062,lLon:8.145385,dur:"0h 41m",dk:"1.2",sl:"2.9",kmh:"1.8",hd:"1055",msa:"2146",ml:"1091",hm:"2161",hg:"421",ms:"-3",mst:"2.4",ge:"Nova Mentor 3 Light XS",pa:"",be:"Gute Thermik. Landung hart."},
"599":{d:"15.6.17",sz:"11:11:34",lz:"11:33:14",st:"Bellwald Mutti",la:"Fiesch",sLat:46.43749,sLon:8.15544,lLat:46.40933,lLon:8.136896,dur:"0h 22m",dk:"3.4",sl:"3.4",kmh:"9.4",hd:"723",msa:"1779",ml:"1056",hm:"1703",hg:"133",ms:"-2.6",mst:"1.4",ge:"Nova Mentor 3 Light XS",pa:"",be:"Geringe Thermik über Bellwald und Kapelle"},
"600":{d:"15.6.17",sz:"12:32:52",lz:"12:53:37",st:"Fiescheralp Heimat",la:"Fiesch",sLat:46.414477,sLon:8.108295,lLat:46.40933,lLon:8.136896,dur:"0h 21m",dk:"6.6",sl:"2.3",kmh:"19.1",hd:"1090",msa:"2146",ml:"1056",hm:"2145",hg:"17",ms:"-2.4",mst:"1.4",ge:"Nova Mentor 3 Light XS",pa:"",be:"Gewittrig. Etwas turbulent."},
"601":{d:"18.6.17",sz:"10:07:15",lz:"10:35:25",st:"Fiescheralp Biplace",la:"Fieschertal Flyingcenter",sLat:46.411504,sLon:8.102926,lLat:46.421062,lLon:8.145385,dur:"0h 28m",dk:"6.3",sl:"3.4",kmh:"13.4",hd:"1104",msa:"2195",ml:"1091",hm:"2146",hg:"189",ms:"-3.2",mst:"2.2",ge:"Gradient BiGolden 3/39",pa:"Susanne Adam",be:"Tandem mit Susanne, Peter mit Beat. Mässige Thermik. Klapper."},
"602":{d:"4.7.17",sz:"11:04:22",lz:"11:24:22",st:"Rigi Kulm",la:"Küssnacht",sLat:47.054774,sLon:8.486321,lLat:47.06739,lLon:8.435432,dur:"0h 20m",dk:"6.4",sl:"4.1",kmh:"19.2",hd:"1287",msa:"1750",ml:"463",hm:"1749",hg:"11",ms:"-2.6",mst:"1.2",ge:"Advance Pi 23",pa:"",be:"Spontan im Spätdienst. Sehr knapp am Start über die Kante. Thermik."},
"603":{d:"8.7.17",sz:"12:20:51",lz:"12:33:01",st:"Brunnihütte",la:"Engelberg Örtli",sLat:46.842699,sLon:8.410243,lLat:46.816954,lLon:8.415308,dur:"0h 12m",dk:"4.6",sl:"2.9",kmh:"22.7",hd:"860",msa:"1872",ml:"1012",hm:"1756",hg:"",ms:"-3.8",mst:"0.6",ge:"Gradient BiGolden 3/39",pa:"Raphael Schmid",be:"Flug mit Raphi, viel Lee, kurz. Aber schön. Gewittrig."},
"604":{d:"4.8.17",sz:"12:39:03",lz:"12:58:03",st:"Rotenflue SW Sommer",la:"Rickenbach",sLat:47.017641,sLon:8.700727,lLat:47.012549,lLon:8.67004,dur:"0h 19m",dk:"3.7",sl:"2.4",kmh:"11.7",hd:"928",msa:"1518",ml:"590",hm:"1557",hg:"147",ms:"-3",mst:"2",ge:"Gradient BiGolden 3/39",pa:"Alena Mair-Noack",be:"Flug mit Alena, Soaring und Überhöhung am Start. Unfall beobachtet am Landeplatz, Stromleitung."},
"605":{d:"5.8.17",sz:"13:57:03",lz:"14:27:03",st:"Rotenflue SW Sommer",la:"Rickenbach",sLat:47.017641,sLon:8.700727,lLat:47.012549,lLon:8.67004,dur:"0h 30m",dk:"5.2",sl:"2.4",kmh:"10.4",hd:"928",msa:"1518",ml:"590",hm:"1532",hg:"200",ms:"-3.8",mst:"2.2",ge:"Nova Mentor 3 Light XS",pa:"",be:"Gute Thermik, über Schwyz kaum mehr Sinken. Wieder REGA, am Start."},
"606":{d:"13.8.17",sz:"10:14:11",lz:"10:33:26",st:"Fiescheralp Biplace",la:"Fieschertal Flyingcenter",sLat:46.411504,sLon:8.102926,lLat:46.421062,lLon:8.145385,dur:"0h 19m",dk:"11.3",sl:"3.4",kmh:"35.2",hd:"1104",msa:"2195",ml:"1091",hm:"2146",hg:"2",ms:"-2.9",mst:"0.6",ge:"Gradient BiGolden 3/39",pa:"Johannes Krause",be:"Ruhig, wenig Thermik über dem Älpli. Wingovers."},
"607":{d:"15.8.17",sz:"08:42:28",lz:"08:56:43",st:"Fiescheralp Heimat",la:"Fieschertal Flyingcenter",sLat:46.414477,sLon:8.108295,lLat:46.421062,lLon:8.145385,dur:"0h 14m",dk:"4.3",sl:"2.9",kmh:"18.1",hd:"1055",msa:"2146",ml:"1091",hm:"2147",hg:"3",ms:"-4.3",mst:"0.5",ge:"Nova Mentor 3 Light XS",pa:"",be:"Ruhiger Morgenflug, bereits geringe Thermik."},
"608":{d:"15.8.17",sz:"10:09:03",lz:"11:17:13",st:"Fiescheralp Heimat",la:"Fieschertal Flyingcenter",sLat:46.414477,sLon:8.108295,lLat:46.421062,lLon:8.145385,dur:"1h 8m",dk:"7.1",sl:"2.9",kmh:"6.2",hd:"1055",msa:"2146",ml:"1091",hm:"2146",hg:"883",ms:"-2.3",mst:"2.4",ge:"Nova Mentor 3 Light XS",pa:"",be:"Guter früher Thermikflug, kann über Älpli gut halten, geht aber noch nicht hoch."},
"609":{d:"26.8.17",sz:"12:09:15",lz:"13:06:54",st:"Fiescheralp Heimat",la:"Fieschertal Flyingcenter",sLat:46.414477,sLon:8.108295,lLat:46.421062,lLon:8.145385,dur:"0h 58m",dk:"9.4",sl:"2.9",kmh:"9.8",hd:"1055",msa:"2146",ml:"1091",hm:"2094",hg:"",ms:"-2.1",mst:"1.8",ge:"Nova Mentor 3 Light XS",pa:"",be:"Spätsommer-Thermik, v. a. am Salzgäb."},
"610":{d:"27.8.17",sz:"11:29:35",lz:"11:52:00",st:"Eggerhorn West",la:"Fieschertal Flyingcenter",sLat:46.383135,sLon:8.181913,lLat:46.421062,lLon:8.145385,dur:"0h 22m",dk:"10.6",sl:"5.1",kmh:"28.4",hd:"1369",msa:"2460",ml:"1091",hm:"2463",hg:"0",ms:"",mst:"",ge:"Gradient BiGolden 3/39",pa:"Bea Mair-Noack",be:"Hike & Fly Tandem von Binn aus, mit Bea, Regina, Peter und Mariette."},
"611":{d:"24.9.17",sz:"13:55:28",lz:"14:24:23",st:"Motta Naluns",la:"Scuol",sLat:46.790828,sLon:10.282705,lLat:46.794543,lLon:10.283924,dur:"0h 29m",dk:"5",sl:"0.4",kmh:"10.4",hd:"765",msa:"2052",ml:"1287",hm:"2159",hg:"205",ms:"-2.6",mst:"2.4",ge:"Nova Mentor 3 Light XS",pa:"",be:"Dolomiten 1: Trotz viel Wolken erstaunliche Thermik, unter Wolken, sogar etwas Regen."},
"612":{d:"25.9.17",sz:"11:17:16",lz:"12:21:21",st:"Watles-Prämajur",la:"Schleis",sLat:46.71275,sLon:10.49593,lLat:46.6919,lLon:10.52795,dur:"1h 4m",dk:"10.8",sl:"3.4",kmh:"10.1",hd:"1162",msa:"2234",ml:"1072",hm:"2539",hg:"843",ms:"-3",mst:"3.2",ge:"Nova Mentor 3 Light XS",pa:"",be:"Dolomiten 2: Trotz Wolken sehr gute Thermik, mehrere Täler und Kreten, Steigen über Landeplatz"},
"613":{d:"25.9.17",sz:"14:48:38",lz:"15:43:58",st:"Watles-Hotel",la:"Schleis",sLat:46.69924,sLon:10.50578,lLat:46.6919,lLon:10.52795,dur:"0h 55m",dk:"5.6",sl:"1.9",kmh:"6.1",hd:"627",msa:"1699",ml:"1072",hm:"1856",hg:"603",ms:"-3.8",mst:"1.8",ge:"Nova Mentor 3 Light XS",pa:"",be:"Dolomiten 3: Leinenknopf, Abbruch, Landung. Dann bei vielen Wolken erst mässig, dann super. Talquerung."},
"614":{d:"26.9.17",sz:"14:52:42",lz:"14:59:57",st:"Rif. Paolina Rosengarten",la:"Karerpass",sLat:46.41604,sLon:11.61681,lLat:46.40432,lLon:11.61006,dur:"0h 7m",dk:"1.4",sl:"1.4",kmh:"11.6",hd:"450",msa:"2204",ml:"1754",hm:"2202",hg:"",ms:"-3.2",mst:"",ge:"Nova Mentor 3 Light XS",pa:"",be:"Dolomiten 4: Wolken, verhangen, nach kurzer Wanderung Regen am Startplatz. Abgleiten zum Pass."},
"615":{d:"27.9.17",sz:"10:34:04",lz:"12:30:24",st:"Col Rodella",la:"Campitello di Fassa",sLat:46.49729,sLon:11.75402,lLat:46.47589,lLon:11.74946,dur:"1h 56m",dk:"29.4",sl:"2.4",kmh:"15.2",hd:"939",msa:"2355",ml:"1416",hm:"2907",hg:"3377",ms:"-3",mst:"4.4",ge:"Nova Mentor 3 Light XS",pa:"",be:"Dolomiten 5: Bis Karerpass -Rosengarten und retour. Runde über Landeplatz Karerpass."},
"616":{d:"27.9.17",sz:"14:18:14",lz:"15:44:04",st:"Col Rodella",la:"Campitello di Fassa",sLat:46.49729,sLon:11.75402,lLat:46.47589,lLon:11.74946,dur:"1h 26m",dk:"5.5",sl:"2.4",kmh:"3.8",hd:"939",msa:"2355",ml:"1416",hm:"2355",hg:"466",ms:"-3",mst:"1.6",ge:"Nova Mentor 3 Light XS",pa:"",be:"Dolomiten 6: Start auf Hosenboden. Sehr feine Thermik über Col Rodella bei sehr vielen Piloten."},
"617":{d:"28.9.17",sz:"11:15:03",lz:"14:16:03",st:"Col Rodella",la:"Campitello di Fassa",sLat:46.49729,sLon:11.75402,lLat:46.47589,lLon:11.74946,dur:"3h 1m",dk:"32.7",sl:"2.4",kmh:"10.8",hd:"939",msa:"2355",ml:"1416",hm:"3451",hg:"4928",ms:"-3.4",mst:"4.6",ge:"Nova Mentor 3 Light XS",pa:"",be:"Dolomiten 7: CR-Belvedere-Marmolata Gipfel-Rosengarten -CR. Sensationell, viele Piloten, im 3. Anlauf Gipfelüberflug. Direktflug fast Rosengarten."},
"618":{d:"28.9.17",sz:"15:57:58",lz:"16:46:43",st:"Belvedere Baita El Brodol",la:"Campitello di Fassa",sLat:46.48246,sLon:11.79502,lLat:46.47589,lLon:11.74946,dur:"0h 49m",dk:"5.5",sl:"3.6",kmh:"6.8",hd:"544",msa:"1960",ml:"1416",hm:"2083",hg:"369",ms:"-2.8",mst:"1.8",ge:"Nova Mentor 3 Light XS",pa:"",be:"Dolomiten 8: Belvedere Skipiste, flaue Thermik, geht knapp nicht mehr hoch. Im Tal Konvergenz."},
"619":{d:"29.9.17",sz:"11:05:02",lz:"13:18:22",st:"Col Rodella",la:"Campitello di Fassa",sLat:46.49729,sLon:11.75402,lLat:46.47589,lLon:11.74946,dur:"2h 13m",dk:"22.9",sl:"2.4",kmh:"10.3",hd:"939",msa:"2355",ml:"1416",hm:"3245",hg:"3545",ms:"-4.8",mst:"4.6",ge:"Nova Mentor 3 Light XS",pa:"",be:"Dolomiten 9: CR-Langkofel-Sella-Pordoi-Belvedere-CR-Campitello."},
"620":{d:"28.10.17",sz:"15:07:02",lz:"15:35:14",st:"Rotenflue SW Sommer",la:"Rickenbach",sLat:47.017641,sLon:8.700727,lLat:47.012549,lLon:8.67004,dur:"0h 28m",dk:"4.3",sl:"2.4",kmh:"9.1",hd:"928",msa:"1419",ml:"497",hm:"1429",hg:"406",ms:"-4.3",mst:"2.6",ge:"Nova Mentor 3 Light XS",pa:"",be:"Test XC Tracer & Flyskyhy, funktioniert sehr gut. Erstaunlich gute Thermik"},
"621":{d:"23.12.17",sz:"10:27:33",lz:"10:40:33",st:"Fiescheralp Heimat",la:"Fieschertal Flyingcenter",sLat:46.414477,sLon:8.108295,lLat:46.421062,lLon:8.145385,dur:"0h 13m",dk:"4.2",sl:"2.9",kmh:"19.4",hd:"1055",msa:"1991",ml:"912",hm:"1991",hg:"1",ms:"-4.5",mst:"0.3",ge:"Nova Mentor 3 Light XS",pa:"",be:"Weihnachtsfliegen, 1 Fehlstart"},
"622":{d:"23.12.17",sz:"11:50:27",lz:"12:08:27",st:"Fiescheralp Heimat",la:"Fieschertal Flyingcenter",sLat:46.414477,sLon:8.108295,lLat:46.421062,lLon:8.145385,dur:"0h 18m",dk:"4.6",sl:"2.9",kmh:"15.3",hd:"1055",msa:"1984",ml:"913",hm:"1984",hg:"47",ms:"-4.3",mst:"0.8",ge:"Nova Mentor 3 Light XS",pa:"",be:"Weihnachtsfliegen"},
"623":{d:"24.12.17",sz:"14:10:47",lz:"14:26:47",st:"Fiescheralp Heimat",la:"Fiesch",sLat:46.414477,sLon:8.108295,lLat:46.40933,lLon:8.136896,dur:"0h 16m",dk:"5.8",sl:"2.3",kmh:"21.8",hd:"1090",msa:"2016",ml:"932",hm:"2016",hg:"38",ms:"-2.5",mst:"1.0",ge:"Gradient BiGolden 3/39",pa:"Nicola Mair-Noack",be:"Mit Nici nach schönem Skitag. Fussstart mit Skischuhen. Leichte Thermik."},
"624":{d:"25.12.17",sz:"10:39:04",lz:"10:54:04",st:"Fiescheralp Heimat",la:"Fiesch",sLat:46.414477,sLon:8.108295,lLat:46.40933,lLon:8.136896,dur:"0h 15m",dk:"5.3",sl:"2.3",kmh:"21.2",hd:"1090",msa:"2151",ml:"1060",hm:"2154",hg:"23",ms:"-2.7",mst:"1.2",ge:"Advance Pi Bi 37",pa:"Claris Mair-Noack",be:"Test Pi Bi, Landung Richtung Berg, knapp über Fahrleitungen."},
"625":{d:"25.12.17",sz:"12:48:19",lz:"13:05:38",st:"Fiescheralp Heimat",la:"Fiesch",sLat:46.414477,sLon:8.108295,lLat:46.40933,lLon:8.136896,dur:"0h 17m",dk:"6.3",sl:"2.3",kmh:"22.2",hd:"1090",msa:"2154",ml:"1064",hm:"2155",hg:"79",ms:"-2.6",mst:"1.4",ge:"Advance Pi Bi 37",pa:"Alena Mair-Noack",be:"Test Pi Bi, ein Fehlstart, Bremse rechts blockiert, 2. Start im Sitzen rutschend, dann super."},
"626":{d:"13.1.18",sz:"11:55:48",lz:"12:14:53",st:"Crap Sogn Gion",la:"Laax-Larnags",sLat:46.83373,sLon:9.21523,lLat:46.82323,lLon:9.25656,dur:"0h 19m",dk:"5.7",sl:"3.4",kmh:"18.3",hd:"1026",msa:"2187",ml:"1153",hm:"2187",hg:"111",ms:"-1.6",mst:"1.5",ge:"Nova Mentor 3 Light XS",pa:"",be:"Skitag RIMED, 2 Fehlstarte"},
"627":{d:"13.1.18",sz:"13:21:00",lz:"14:00:44",st:"Crap Sogn Gion",la:"Flims-Waldhaus",sLat:46.83373,sLon:9.21523,lLat:46.82328,lLon:9.2857,dur:"0h 40m",dk:"7.9",sl:"5.5",kmh:"11.9",hd:"1109",msa:"2195",ml:"1068",hm:"2260",hg:"707",ms:"-2.6",mst:"2.3",ge:"Nova Mentor 3 Light XS",pa:"",be:"Gute Thermik, Kalt, Landung  nahe Hotel Sunstar"},
"628":{d:"28.1.18",sz:"13:33:00",lz:"13:45:05",st:"Rotenflue SSW Winter",la:"Rickenbach",sLat:47.01819,sLon:8.701503,lLat:47.012549,lLon:8.67004,dur:"0h 12m",dk:"3.5",sl:"2.5",kmh:"17.4",hd:"959",msa:"1547",ml:"591",hm:"1546",hg:"-1",ms:"-1.9",mst:"0.1",ge:"Advance Pi 23",pa:"",be:"Nach einem Skitag im Mythengebiet, zum Abschluss, mit Skischuhen, gemütlich."},
"629":{d:"24.3.18",sz:"13:57:35",lz:"14:41:14",st:"Rotenflue SW Sommer",la:"Rickenbach",sLat:47.017641,sLon:8.700727,lLat:47.012549,lLon:8.67004,dur:"0h 44m",dk:"12.6",sl:"2.4",kmh:"17.3",hd:"928",msa:"1518",ml:"590",hm:"2148",hg:"868",ms:"-1.8",mst:"2.7",ge:"Nova Mentor 3 Light XS",pa:"",be:"Bereits super Thermik, Mythen überhöht, Hochstuckli retour."},
"630":{d:"2.4.18",sz:"11:35:23",lz:"11:58:05",st:"Fiescheralp Heimat",la:"Fiesch",sLat:46.414477,sLon:8.108295,lLat:46.40933,lLon:8.136896,dur:"0h 23m",dk:"4.8",sl:"2.3",kmh:"12.7",hd:"1090",msa:"2146",ml:"1056",hm:"2146",hg:"107",ms:"-2.4",mst:"1.5",ge:"Nova Mentor 3 Light XS",pa:"",be:"Nach vielen schlechten Tagen trotz Föhn fliegbar, gute Thermik."},
"631":{d:"7.4.18",sz:"11:01:54",lz:"11:10:35",st:"Brändlen-Süd",la:"Wolfenschiessen",sLat:46.902516,sLon:8.409958,lLat:46.905095,lLon:8.398533,dur:"0h 9m",dk:"2.4",sl:"0.9",kmh:"16.6",hd:"705",msa:"1215",ml:"510",hm:"1215",hg:"0",ms:"-2.5",mst:"0",ge:"Gradient BiGolden 3/39",pa:"Mauro Tannò",be:"Erster Flug von Mauro, gemütlich, super Startgelände. Mit Karin und Giani"},
"632":{d:"7.4.18",sz:"12:12:29",lz:"12:21:35",st:"Brändlen-Süd",la:"Wolfenschiessen",sLat:46.902516,sLon:8.409958,lLat:46.905095,lLon:8.398533,dur:"0h 9m",dk:"2.3",sl:"0.9",kmh:"15.2",hd:"705",msa:"1215",ml:"510",hm:"1215",hg:"0",ms:"-2.2",mst:"0",ge:"Gradient BiGolden 3/39",pa:"Mauro Tannò",be:"Genuss mit Mauro, super Sonne, aber kaum Thermik."},
"633":{d:"28.4.18",sz:"10:56:31",lz:"11:04:07",st:"Fluebrig Schärmen",la:"Golfplatz Ochsenboden",sLat:47.053127,sLon:8.878408,lLat:47.060627,lLon:8.857019,dur:"0h 8m",dk:"2.4",sl:"1.8",kmh:"18.9",hd:"630",msa:"1578",ml:"956",hm:"1578",hg:"0",ms:"-2.3",mst:"0",ge:"Advance Pi 23",pa:"",be:"Erster Teil zum Fluebrig, oben noch Schnee, etwas föhnig, nur bis Schärmen."},
"634":{d:"12.5.18",sz:"11:17:37",lz:"11:49:31",st:"Niedere Andelsbuch",la:"Bahn Andelsbuch",sLat:47.40402,sLon:9.93925,lLat:47.41198,lLon:9.90784,dur:"0h 32m",dk:"6.4",sl:"2.5",kmh:"12.0",hd:"929",msa:"1562",ml:"650",hm:"1703",hg:"366",ms:"-2.4",mst:"1.7",ge:"Gradient BiGolden 3/39",pa:"Bea Mair-Noack",be:"Schöne Thermik an der nördlichen Rückseite, mit Geduld nach oben gearbeitet, Start überhöht."},
"635":{d:"13.5.18",sz:"12:20:37",lz:"13:04:24",st:"Niedere Andelsbuch",la:"Bahn Andelsbuch",sLat:47.40402,sLon:9.93925,lLat:47.41198,lLon:9.90784,dur:"0h 44m",dk:"8.9",sl:"2.5",kmh:"12.2",hd:"929",msa:"1564",ml:"655",hm:"1563",hg:"361",ms:"-2.5",mst:"1.5",ge:"Gradient BiGolden 3/39",pa:"Bea Mair-Noack",be:"Kritischer Start mit Seitenwind, knapp weg. Dann gemütliches Soaring im Hangaufwind."},
"636":{d:"19.5.18",sz:"09:26:03",lz:"09:38:36",st:"Bellwald Mutti",la:"Fieschertal Flyingcenter",sLat:46.43749,sLon:8.15544,lLat:46.421062,lLon:8.145385,dur:"0h 13m",dk:"4.3",sl:"2.0",kmh:"20.6",hd:"688",msa:"1757",ml:"1099",hm:"1755",hg:"1",ms:"-2.6",mst:"0.1",ge:"Nova Mentor 3 Light XS",pa:"",be:"Ruhig, keine Thermik."},
"637":{d:"19.5.18",sz:"10:35:03",lz:"10:49:22",st:"Bellwald Mutti",la:"Fieschertal Flyingcenter",sLat:46.43749,sLon:8.15544,lLat:46.421062,lLon:8.145385,dur:"0h 14m",dk:"4.1",sl:"2.0",kmh:"17.2",hd:"688",msa:"1761",ml:"1086",hm:"1763",hg:"77",ms:"-2.3",mst:"1.5",ge:"Nova Mentor 3 Light XS",pa:"",be:"Ruhiger Flug vor dem Gewitter, Thermik über der Kapelle Bellwald-Stein"},
"638":{d:"31.5.18",sz:"10:26:07",lz:"10:39:51",st:"Fluebrig Diethelm",la:"Golfplatz Ochsenboden Süd",sLat:47.061155,sLon:8.883166,lLat:47.052767,lLon:8.858206,dur:"0h 14m",dk:"4.4",sl:"2.1",kmh:"19.2",hd:"1106",msa:"2043",ml:"973",hm:"2041",hg:"2",ms:"-2.2",mst:"0.3",ge:"Advance Pi 23",pa:"",be:"Hike auf den Diethelm, 3 Std. , am Schluss kleine Kletterei mit Ketten. Tolle Startwiese. Harte Ldg. südl. des Golfplatzes auf Teerplatz"},
"639":{d:"1.6.18",sz:"10:07:26",lz:"11:11:10",st:"Fiescheralp Heimat",la:"Fiesch",sLat:46.414477,sLon:8.108295,lLat:46.40933,lLon:8.136896,dur:"1h 4m",dk:"16.7",sl:"2.3",kmh:"15.7",hd:"1090",msa:"2149",ml:"1056",hm:"2563",hg:"1643",ms:"-2.9",mst:"3.1",ge:"Nova Mentor 3 Light XS",pa:"",be:"Schöne Thermik überall, Querung bei 2500, im Geradeausflug mit Nico Richtung Obergoms, tiefe Basis. Keine Lust auf Baschi, deshalb Umkehr."},
"640":{d:"2.6.18",sz:"10:46:16",lz:"12:31:47",st:"Fiescheralp Heimat",la:"Fieschertal Flyingcenter",sLat:46.414477,sLon:8.108295,lLat:46.421062,lLon:8.145385,dur:"1h 46m",dk:"42.7",sl:"2.9",kmh:"24.3",hd:"1055",msa:"2155",ml:"1098",hm:"3061",hg:"3301",ms:"-3.8",mst:"4.8",ge:"Nova Mentor 3 Light XS",pa:"",be:"Erster guter Streckentag, ab Richinen kaum mehr eingedreht bis Sidelhorn, auf Rückweg gar nicht mehr."},
"641":{d:"25.6.18",sz:"09:08:58",lz:"09:28:18",st:"Fiescheralp Heimat",la:"Fiesch",sLat:46.414477,sLon:8.108295,lLat:46.40933,lLon:8.136896,dur:"0h 19m",dk:"4.8",sl:"2.3",kmh:"14.9",hd:"1090",msa:"2140",ml:"1066",hm:"2142",hg:"15",ms:"-1.8",mst:"0.7",ge:"Nova Mentor 3 Light XS",pa:"",be:"Ruhig, leichter Ostwind bei Bisen-Lage"},
"642":{d:"25.6.18",sz:"10:25:01",lz:"10:43:09",st:"Fiescheralp Heimat",la:"Fiesch",sLat:46.414477,sLon:8.108295,lLat:46.40933,lLon:8.136896,dur:"0h 18m",dk:"4.0",sl:"2.3",kmh:"13.2",hd:"1090",msa:"2150",ml:"1067",hm:"2341",hg:"192",ms:"-2.9",mst:"2.3",ge:"Nova Mentor 3 Light XS",pa:"",be:"Gute Thermik gleich beim Start, zügig nach oben. Etwas wild, wohl Bisen-Lee, deshalb ab ins Tal."},
"643":{d:"30.6.18",sz:"10:42:15",lz:"12:03:19",st:"Fiescheralp Biplace",la:"Fiesch",sLat:46.411504,sLon:8.102926,lLat:46.40933,lLon:8.136896,dur:"1h 21m",dk:"21.4",sl:"2.6",kmh:"15.8",hd:"1139",msa:"2198",ml:"1067",hm:"2798",hg:"2041",ms:"-2.8",mst:"3.4",ge:"Gradient BiGolden 3/39",pa:"Bea Mair-Noack",be:"Gute Thermik, Streckenflug ins Goms, Bea‘s Magen rebelliert Höhe Gluringen, retour. Etwas ruppig, mittlere Klapper (!)."},
"644":{d:"1.7.18",sz:"11:42:26",lz:"13:49:22",st:"Fiescheralp Heimat",la:"Fiesch",sLat:46.414477,sLon:8.108295,lLat:46.40933,lLon:8.136896,dur:"2h 7m",dk:"42.6",sl:"2.3",kmh:"20.1",hd:"1090",msa:"2139",ml:"1070",hm:"3090",hg:"4711",ms:"-4.3",mst:"4.2",ge:"Nova Mentor 3 Light XS",pa:"",be:"1 Fehlstart, Böen. Bisenlage, z. T. ruppige Thermik, oft unberechenbar. Abbruch nach Obergesteln, vor Sidelhorn. Zurück über Startplatz."},
"645":{d:"3.7.18",sz:"09:22:33",lz:"09:37:18",st:"Fiescheralp Heimat",la:"Fiesch",sLat:46.414477,sLon:8.108295,lLat:46.40933,lLon:8.136896,dur:"0h 15m",dk:"6.1",sl:"2.3",kmh:"24.8",hd:"1090",msa:"2147",ml:"1066",hm:"2148",hg:"0",ms:"-2",mst:"0",ge:"Nova Mentor 3 Light XS",pa:"",be:"Ruhig, kaum Thermik."},
"646":{d:"4.7.18",sz:"08:39:21",lz:"08:43:31",st:"Bellwald ob LFÜB",la:"Mühlebach",sLat:46.42357,sLon:8.16326,lLat:46.404548,lLon:8.152127,dur:"0h 4m",dk:"2.5",sl:"2.3",kmh:"36.0",hd:"345",msa:"1526",ml:"1209",hm:"1526",hg:"0",ms:"-2.2",mst:"0",ge:"Advance Pi 23",pa:"",be:"Hike Teil 1: Bellwald- Mühlebach bei Tröpfeln, deutlicher Bergwind im Goms, Start Nullwind"},
"647":{d:"4.7.18",sz:"10:52:20",lz:"10:59:43",st:"Chäserstatt",la:"Mühlebach",sLat:46.40728,sLon:8.17483,lLat:46.404548,lLon:8.152127,dur:"0h 7m",dk:"3.0",sl:"1.8",kmh:"24.4",hd:"613",msa:"1791",ml:"1209",hm:"1791",hg:"0",ms:"-2.3",mst:"0",ge:"Advance Pi 23",pa:"",be:"Hike Teil 2: Gemütlicher Flug nach Mühlebach. Könnte knapp nach Bodmen reichen, evtl. etwas aufsteigen."},
"648":{d:"7.7.18",sz:"08:40:18",lz:"09:06:55",st:"Fiescheralp Biplace",la:"Fiesch",sLat:46.411504,sLon:8.102926,lLat:46.40933,lLon:8.136896,dur:"0h 27m",dk:"6.2",sl:"2.6",kmh:"14.0",hd:"1139",msa:"2142",ml:"1082",hm:"2163",hg:"295",ms:"-4.5",mst:"1.3",ge:"Gradient BiGolden 3/39",pa:"Bea Mair-Noack",be:"Gemütlich Thermin über dem Älpli"},
"649":{d:"7.7.18",sz:"10:07:30",lz:"10:25:39",st:"Fiescheralp Biplace",la:"Fiesch",sLat:46.411504,sLon:8.102926,lLat:46.40933,lLon:8.136896,dur:"0h 18m",dk:"5.3",sl:"2.6",kmh:"17.5",hd:"1139",msa:"2178",ml:"1069",hm:"2179",hg:"84",ms:"-3.2",mst:"1",ge:"Gradient BiGolden 3/39",pa:"Nicola Mair-Noack",be:"Ruppiger Ostwind, Seitenwind beim Start."},
"650":{d:"14.7.18",sz:"09:32:38",lz:"09:43:43",st:"Rotenflue SW Sommer",la:"Rickenbach",sLat:47.017641,sLon:8.700727,lLat:47.012549,lLon:8.67004,dur:"0h 11m",dk:"3.8",sl:"2.4",kmh:"20.6",hd:"928",msa:"1494",ml:"593",hm:"1494",hg:"1",ms:"-3.2",mst:"0",ge:"Gradient BiGolden 3/39",pa:"Mauro Tannò",be:"Start mit wenig Wind, ok. Kaum Thermik"},
"651":{d:"14.7.18",sz:"10:45:47",lz:"10:57:47",st:"Rotenflue SW Sommer",la:"Rickenbach",sLat:47.017641,sLon:8.700727,lLat:47.012549,lLon:8.67004,dur:"0h 12m",dk:"3.7",sl:"2.4",kmh:"18.5",hd:"928",msa:"1500",ml:"590",hm:"1500",hg:"0",ms:"-2.5",mst:"0.1",ge:"Gradient BiGolden 3/39",pa:"Mauro Tannò",be:"Guter Start, wenig Thermik. Spirale, Wingover, Landung sauber."},
"652":{d:"14.7.18",sz:"12:13:31",lz:"12:33:56",st:"Rotenflue SSW Winter",la:"Rickenbach",sLat:47.01819,sLon:8.701503,lLat:47.012549,lLon:8.67004,dur:"0h 20m",dk:"4.6",sl:"2.5",kmh:"13.5",hd:"959",msa:"1522",ml:"587",hm:"1522",hg:"60",ms:"-2.6",mst:"0.9",ge:"Gradient BiGolden 3/39",pa:"Mauro Tannò",be:"EinStartabbruch bei Knoten in der Bremsleine, 2. Start gut. Thermik am Mythen Wandfuss West, aber zu tief."},
"653":{d:"14.7.18",sz:"13:35:28",lz:"14:25:36",st:"Rotenflue SSW Winter",la:"Rickenbach",sLat:47.01819,sLon:8.701503,lLat:47.012549,lLon:8.67004,dur:"0h 50m",dk:"11.9",sl:"2.5",kmh:"14.2",hd:"959",msa:"1542",ml:"591",hm:"1920",hg:"1239",ms:"-2.9",mst:"2.9",ge:"Gradient BiGolden 3/39",pa:"Mauro Tannò",be:"Start knapp, da zu langsam, dann gut. Gute Thermik, Mythen überhöht, kleiner Mythen super, Hochstuckli retour, über Ld.-Platz viel Thermik"},
"654":{d:"24.7.18",sz:"15:26:32",lz:"15:55:48",st:"Rigi Staffelhöhe",la:"Küssnacht am Rigi Chlösterli",sLat:47.047772,sLon:8.460731,lLat:47.06876,lLon:8.44777,dur:"0h 29m",dk:"5.9",sl:"2.5",kmh:"12.1",hd:"959",msa:"1559",ml:"599",hm:"1734",hg:"309",ms:"-2.7",mst:"2.8",ge:"Nova Mentor 3 Light XS",pa:"",be:"Hike auf die Rigi, Rückwärtsstart, zu früh eingedreht, dann gute Thermik. Einflug in CTR2 Emmen, unsicher, deshalb Landung oberhalb Küssnacht."},
"655":{d:"29.7.18",sz:"11:50:32",lz:"12:20:56",st:"Fiescheralp Biplace",la:"Fiesch",sLat:46.411504,sLon:8.102926,lLat:46.40933,lLon:8.136896,dur:"0h 30m",dk:"10.1",sl:"2.6",kmh:"19.9",hd:"1139",msa:"2186",ml:"1069",hm:"2926",hg:"781",ms:"-3",mst:"3.9",ge:"Gradient BiGolden 3/39",pa:"Bea Mair-Noack",be:"Gute, ruhige Thermik, nach wenigen Minuten auf Eggishornhöhe. Chäserstatt-Stei-Fiesch. Landung sehr kurz, werden fallengelassen. Zu enge Kurve?"},
"656":{d:"1.8.18",sz:"10:51:08",lz:"11:13:55",st:"Rotenflue SSW Winter",la:"Rickenbach",sLat:47.01819,sLon:8.701503,lLat:47.012549,lLon:8.67004,dur:"0h 23m",dk:"5.1",sl:"2.5",kmh:"13.4",hd:"959",msa:"1530",ml:"597",hm:"1527",hg:"136",ms:"-3.5",mst:"1.4",ge:"Gradient BiGolden 3/39",pa:"Katy Javaheripour",be:"Start und Landung sehr gut. Thermik über westlichem Wandfuss Mythen, gut."},
"657":{d:"1.8.18",sz:"12:22:11",lz:"12:54:59",st:"Rotenflue SSW Winter",la:"Rickenbach",sLat:47.01819,sLon:8.701503,lLat:47.012549,lLon:8.67004,dur:"0h 33m",dk:"6.2",sl:"2.5",kmh:"11.3",hd:"959",msa:"1519",ml:"593",hm:"1516",hg:"387",ms:"-3.6",mst:"1.8",ge:"Gradient BiGolden 3/39",pa:"Jan Javaheripour",be:"Start mit schlechtem Wind, knapp über Boden. Thermik über tiefem westl. Wandfuss Mythen, gut."},
"658":{d:"11.8.18",sz:"10:39:53",lz:"10:59:48",st:"Eggerhorn West",la:"Fiesch",sLat:46.383165,sLon:8.182902,lLat:46.40933,lLon:8.136896,dur:"0h 20m",dk:"7.4",sl:"4.6",kmh:"22.3",hd:"1404",msa:"2491",ml:"1071",hm:"2494",hg:"84",ms:"-2.7",mst:"1.9",ge:"Advance Pi 23",pa:"",be:"2:40 Fussmarsch ab Binn, Start vom Südgipfel nach SW im Lee. Marc auch am Gipfel."},
"659":{d:"15.8.18",sz:"12:19:34",lz:"12:36:34",st:"Rotenflue Ost",la:"Rickenbach",sLat:47.018308,sLon:8.702177,lLat:47.012549,lLon:8.67004,dur:"0h 17m",dk:"4.5",sl:"2.5",kmh:"15.9",hd:"960",msa:"1535",ml:"592",hm:"1535",hg:"153",ms:"-3",mst:"1.2",ge:"Gradient BiGolden 3/39",pa:"Nicola Mair-Noack",be:"Ostwind trotz Bise, Start nach Osten. Knapp, Schirm getaucht. Dann Wolken, Thermik."},
"660":{d:"26.8.18",sz:"11:39:30",lz:"11:50:19",st:"Fluebrig Südflanke",la:"Golfplatz Ochsenboden Süd",sLat:47.05826,sLon:8.88357,lLat:47.05215,lLon:8.85773,dur:"0h 11m",dk:"4.9",sl:"2.1",kmh:"27.2",hd:"937",msa:"1904",ml:"967",hm:"1904",hg:"0",ms:"-3.6",mst:"0.1",ge:"Gradient BiGolden 3/39",pa:"Giani Tannò",be:"Hike & Fly auf den Diethelm, oben Schnee, super. Abstieg zu Start in Südflanke."},
"661":{d:"26.8.18",sz:"15:02:17",lz:"15:13:14",st:"Rigi Seebodenalp",la:"Küssnacht",sLat:47.063445,sLon:8.457515,lLat:47.06739,lLon:8.435432,dur:"0h 11m",dk:"2.9",sl:"1.7",kmh:"15.9",hd:"569",msa:"1003",ml:"459",hm:"1004",hg:"86",ms:"-3.0",mst:"1.2",ge:"Gradient BiGolden 3/39",pa:"Leon Geertsen",be:"Bise, Seitenwind, Start und Landung gut, Leons Übungsflug fürs Allalin. Etwas böige Bise."},
"662":{d:"1.9.18",sz:"14:19:58",lz:"15:20:50",st:"Àger Sant Alis",la:"Àger Ço de Petetò",sLat:42.04605,sLon:0.74617,lLat:42.01717,lLon:0.74325,dur:"1h 1m",dk:"13.9",sl:"3.2",kmh:"13.7",hd:"827",msa:"1552",ml:"734",hm:"1835",hg:"1206",ms:"-3.0",mst:"3.5",ge:"Nova Mentor 3 Light XS",pa:"",be:"Pyrenäen 1: Erster Flug, Rückwärtsstart im 2. Versuch, dann überall Thermik. Auf andere Talseite."},
"663":{d:"2.9.18",sz:"12:33:23",lz:"13:46:38",st:"Àger Sant Alis",la:"Àger Ço de Petetò",sLat:42.04605,sLon:0.74617,lLat:42.01564,lLon:0.74574,dur:"1h 13m",dk:"18.7",sl:"3.4",kmh:"15.3",hd:"836",msa:"1553",ml:"722",hm:"1823",hg:"1757",ms:"-3.1",mst:"2.6",ge:"Nova Mentor 3 Light XS",pa:"",be:"Pyrenäen 2: Ruppig, grösserer Klapper am See am westl. Umkehrpunkt."},
"664":{d:"2.9.18",sz:"17:07:57",lz:"18:19:29",st:"Àger Sant Alis",la:"Àger Ço de Petetò",sLat:42.04605,sLon:0.74617,lLat:42.01717,lLon:0.74325,dur:"1h 12m",dk:"14.9",sl:"3.2",kmh:"12.5",hd:"827",msa:"1554",ml:"739",hm:"2089",hg:"1619",ms:"-3.5",mst:"3.0",ge:"Nova Mentor 3 Light XS",pa:"",be:"Pyrenäen 3: Ruhiger Abendflug, leider kein Versuch, um nach Tremp zu fliegen, war alleine. Zu wenig Mut?"},
"665":{d:"3.9.18",sz:"12:53:48",lz:"13:44:59",st:"Gallinero las Planadas",la:"Castejón de Sos",sLat:42.53346,sLon:0.54425,lLat:42.51864,lLon:0.48998,dur:"0h 51m",dk:"13.7",sl:"4.7",kmh:"16.1",hd:"1315",msa:"2210",ml:"911",hm:"2386",hg:"691",ms:"-2.4",mst:"2.4",ge:"Nova Mentor 3 Light XS",pa:"",be:"Pyrenäen 4: Ruppiger Hausbart, wieder Klapper. Dann nach Ost und West, knapp gegen starken Talwind."},
"666":{d:"4.9.18",sz:"11:59:41",lz:"13:27:09",st:"Gallinero las Planadas",la:"Castejón de Sos",sLat:42.53378,sLon:0.55115,lLat:42.51864,lLon:0.48998,dur:"1h 27m",dk:"15.7",sl:"5.3",kmh:"10.8",hd:"1385",msa:"2296",ml:"910",hm:"2694",hg:"1701",ms:"-2.7",mst:"2.7",ge:"Nova Mentor 3 Light XS",pa:"",be:"Pyrenäen 5: Endlich ruhig, schöner Rundflug über Osttäler, dann Westen, wieder hocharbeiten."},
"667":{d:"5.9.18",sz:"11:55:53",lz:"12:35:07",st:"Pedro Bernardo West",la:"Pedro Bernardo Tal",sLat:40.25665,sLon:-4.90543,lLat:40.22966,lLon:-4.88024,dur:"0h 39m",dk:"10.7",sl:"3.7",kmh:"16.4",hd:"825",msa:"1259",ml:"439",hm:"1504",hg:"536",ms:"-2.5",mst:"2.6",ge:"Nova Mentor 3 Light XS",pa:"",be:"Pyrenäen 6: Starker Südwestwind, nach Startüberhöhung Talwechsel nach West, Absaufen, mit R‘wind (60 km/h) zum Ziel zurück."},
"668":{d:"6.9.18",sz:"12:07:38",lz:"13:06:54",st:"Pedro Bernardo West",la:"Lanzahita 3 km Ost",sLat:40.25665,sLon:-4.90543,lLat:40.21299,lLon:-4.90972,dur:"0h 59m",dk:"12.7",sl:"4.9",kmh:"12.9",hd:"832",msa:"1246",ml:"431",hm:"1565",hg:"1054",ms:"-3.6",mst:"2.8",ge:"Nova Mentor 3 Light XS",pa:"",be:"Pyrenäen 7: Weniger Wind, Versuch Strecke nach Westen. Schwierige Bedingungen. Lee an der westl. Krete. Aussenladung."},
"669":{d:"7.9.18",sz:"16:08:47",lz:"16:48:25",st:"Sopelana 1",la:"Sopelana 1",sLat:43.38078,sLon:-3.0107,lLat:43.38078,lLon:-3.0107,dur:"0h 40m",dk:"2.0",sl:"0.0",kmh:"3.0",hd:"0",msa:"78",ml:"78",hm:"158",hg:"196",ms:"-0.9",mst:"0.9",ge:"Nova Mentor 3 Light XS",pa:"",be:"Pyrenäen 8: Küstensoaring, viel Wind, ruhig, perfektes Toplanding"},
"670":{d:"7.9.18",sz:"18:19:12",lz:"18:42:36",st:"Sopelana Golfplatz",la:"Sopelana Golfplatz",sLat:43.37797,sLon:-3.0193,lLat:43.37801,lLon:-3.01914,dur:"0h 23m",dk:"2.1",sl:"0.0",kmh:"5.4",hd:"0",msa:"59",ml:"59",hm:"161",hg:"134",ms:"-0.9",mst:"0.9",ge:"Nova Mentor 3 Light XS",pa:"",be:"Pyrenäen 9: Küstensoaring, unebenes Gelände, guter Start, perfektes Toplanding."},
"671":{d:"20.9.18",sz:"17:14:54",lz:"17:23:22",st:"Zugerberg",la:"Zug",sLat:47.14813,sLon:8.535748,lLat:47.150094,lLon:8.507689,dur:"0h 8m",dk:"3.5",sl:"2.1",kmh:"24.8",hd:"475",msa:"917",ml:"465",hm:"917",hg:"0",ms:"-1.7",mst:"0",ge:"Nova Mentor 3 Light XS",pa:"",be:"Abendflug nach der Arbeit, es ging nichts, nur wenig zu spät."},
"672":{d:"29.9.18",sz:"13:05:33",lz:"13:40:27",st:"Allalinhorn Gipfel NW",la:"Saas Fee",sLat:46.04566,sLon:7.894,lLat:46.10318,lLon:7.92028,dur:"0h 35m",dk:"10.7",sl:"6.7",kmh:"18.4",hd:"2156",msa:"3968",ml:"1819",hm:"3968",hg:"351",ms:"-4.4",mst:"3.0",ge:"Gradient BiGolden 3/39",pa:"Leon Geertsen",be:"Hike&Fly vom Allalin, mit Peter, Nici, Stefan, Leon, Dominik und Olivier. Starker böiger Südwind in Saas Grund, kuriose Landungen in Saas Fee."},
"673":{d:"11.10.18",sz:"12:18:47",lz:"12:47:13",st:"Teneriffa Taucho",la:"Strandbar las Gaviotas La Caleta",sLat:28.14489,sLon:-16.7358,lLat:28.09756,lLon:-16.7516,dur:"0h 28m",dk:"7.3",sl:"5.5",kmh:"15.4",hd:"762",msa:"753",ml:"13",hm:"887",hg:"493",ms:"-2.9",mst:"3.4",ge:"Nova Mentor 3 Light XS",pa:"",be:"Hilfe von Lorenzo Nadali, Guide. Guter Startplatz, etwas ruppige Thermik. Kein Vario. Landung am Strand."},
"674":{d:"11.10.18",sz:"14:35:49",lz:"14:49:49",st:"Teneriffa Taucho",la:"Strandbar las Gaviotas La Caleta",sLat:28.14489,sLon:-16.7358,lLat:28.09756,lLon:-16.7516,dur:"0h 14m",dk:"7.3",sl:"5.5",kmh:"31.3",hd:"762",msa:"749",ml:"13",hm:"753",hg:"64",ms:"-4.6",mst:"1.4",ge:"Nova Mentor 3 Light XS",pa:"",be:"Weniger Thermik, langer Gleitflug zum Strand, knapp. Kein Vario."},
"675":{d:"12.10.18",sz:"11:59:06",lz:"12:21:17",st:"Teneriffa Taucho",la:"Strandbar las Gaviotas La Caleta",sLat:28.14489,sLon:-16.7358,lLat:28.09756,lLon:-16.7516,dur:"0h 22m",dk:"7.1",sl:"5.5",kmh:"19.2",hd:"762",msa:"778",ml:"17",hm:"963",hg:"225",ms:"-2.4",mst:"1.9",ge:"Gradient BiGolden 3/39",pa:"Bea Mair-Noack",be:"Tolle Thermik, Startüberhöhung, am Strand im Lee und zu kurz, aber ohne Kakteen."},
"676":{d:"14.10.18",sz:"17:09:11",lz:"17:20:34",st:"Teneriffa Taucho",la:"Strandbar las Gaviotas La Caleta",sLat:28.14489,sLon:-16.7358,lLat:28.09756,lLon:-16.7516,dur:"0h 11m",dk:"6.0",sl:"5.5",kmh:"31.6",hd:"762",msa:"751",ml:"30",hm:"751",hg:"3",ms:"-2.2",mst:"0.0",ge:"Nova Mentor 3 Light XS",pa:"",be:"Null Wind, bedeckt, Gleitflug zum Strand"},
"677":{d:"19.10.18",sz:"11:21:27",lz:"11:40:52",st:"Fiescheralp Salzgäb",la:"Fiesch",sLat:46.42798,sLon:8.115787,lLat:46.40933,lLon:8.136896,dur:"0h 19m",dk:"6.5",sl:"2.6",kmh:"20.1",hd:"1186",msa:"2263",ml:"1066",hm:"2270",hg:"9",ms:"-1.9",mst:"0.5",ge:"Nova Mentor 3 Light XS",pa:"",be:"Kleiner Hike, leichter Ostwind, herrlicher Herbsttag. Wenig Thermik auf Startplatzhöhe Lawinenverbauungen."},
"678":{d:"20.10.18",sz:"10:36:13",lz:"11:05:36",st:"Talegga Mitte",la:"Fiesch",sLat:46.42703,sLon:8.10775,lLat:46.40933,lLon:8.136896,dur:"0h 29m",dk:"8.6",sl:"3.0",kmh:"17.6",hd:"1377",msa:"2426",ml:"1061",hm:"2426",hg:"143",ms:"-2.1",mst:"1.2",ge:"Nova Mentor 3 Light XS",pa:"",be:"Hike Richtung Salzgäb, dann Talegga Pkt. 2445. Gute Thermik über Salzgäb."},
"679":{d:"21.10.18",sz:"13:09:45",lz:"13:24:14",st:"Fiescheralp Biplace",la:"Fiesch",sLat:46.411504,sLon:8.102926,lLat:46.40933,lLon:8.136896,dur:"0h 14m",dk:"6.6",sl:"2.6",kmh:"27.3",hd:"1139",msa:"2187",ml:"1067",hm:"2187",hg:"0",ms:"-2.4",mst:"0",ge:"Gradient BiGolden 3/39",pa:"Bea Mair-Noack",be:"Gemütlicher Herbstflug nach Eggishorn-Wanderung."},
"680":{d:"1.1.19",sz:"13:25:16",lz:"13:47:17",st:"Fiescheralp Heimat",la:"Fiesch",sLat:46.414477,sLon:8.108295,lLat:46.40933,lLon:8.136896,dur:"0h 22m",dk:"4.3",sl:"2.3",kmh:"11.7",hd:"1090",msa:"2147",ml:"1056",hm:"2149",hg:"9",ms:"-1.9",mst:"0.6",ge:"Nova Mentor 3 Light XS",pa:"",be:"Rückenwindstart bei Nordwind, 1 Fehlstart, dann ruhig, sehr zarte Thermik."},
"681":{d:"13.2.19",sz:"11:10:48",lz:"11:25:01",st:"Fiescheralp Heimat",la:"Fiesch",sLat:46.414477,sLon:8.108295,lLat:46.40933,lLon:8.136896,dur:"0h 14m",dk:"5.5",sl:"2.3",kmh:"23.2",hd:"1090",msa:"2145",ml:"1054",hm:"2142",hg:"0",ms:"-1.8",mst:"0.2",ge:"Gradient BiGolden 3/39",pa:"Claris Mair-Noack",be:"Skistart mit Claris, alles sehr gut und bequem. Schwache Thermik."},
"682":{d:"13.2.19",sz:"12:57:10",lz:"13:13:44",st:"Fiescheralp Heimat",la:"Fiesch",sLat:46.414477,sLon:8.108295,lLat:46.40933,lLon:8.136896,dur:"0h 17m",dk:"5.6",sl:"2.3",kmh:"20.3",hd:"1090",msa:"2141",ml:"1057",hm:"2143",hg:"14",ms:"-2.2",mst:"0.8",ge:"Gradient BiGolden 3/39",pa:"Noel Winiger",be:"Fussstart mit Noel, erster Flug, alles perfekt. Schwache Thermik."},
"683":{d:"15.2.19",sz:"13:12:24",lz:"13:39:47",st:"Fiescheralp Heimat",la:"Fiescherstafel",sLat:46.414477,sLon:8.108295,lLat:46.413963,lLon:8.117628,dur:"0h 27m",dk:"2.8",sl:"0.7",kmh:"6.1",hd:"259",msa:"2140",ml:"1887",hm:"2217",hg:"307",ms:"-1.8",mst:"1.8",ge:"Gradient BiGolden 3/39",pa:"Meret Steudler",be:"Skistart, gute Thermik, „Toplandung“ oberhalb Heimat-Talstation bei Fiescherstafel."},
"684":{d:"15.2.19",sz:"15:24:14",lz:"15:38:58",st:"Fiescheralp Heimat",la:"Fiesch",sLat:46.414477,sLon:8.108295,lLat:46.40933,lLon:8.136896,dur:"0h 15m",dk:"5.9",sl:"2.3",kmh:"24.0",hd:"1090",msa:"2147",ml:"1066",hm:"2143",hg:"0",ms:"-1.9",mst:"0",ge:"Gradient BiGolden 3/39",pa:"Bea Mair-Noack",be:"Mit parallelen Ski ein Fehlstart, dann in V-Stellung alles gut."},
"685":{d:"16.2.19",sz:"12:31:01",lz:"12:57:15",st:"Fiescheralp Heimat",la:"Fiesch",sLat:46.414477,sLon:8.108295,lLat:46.40933,lLon:8.136896,dur:"0h 26m",dk:"7.4",sl:"2.3",kmh:"16.9",hd:"1090",msa:"2134",ml:"1063",hm:"2417",hg:"308",ms:"-2.6",mst:"2.5",ge:"Gradient BiGolden 3/39",pa:"Sophie Steudler",be:"Fussstart super, dann tolle Thermik, weit überhöht. Komischer Wind am Landeplatz, zu unentschlossen."},
"686":{d:"23.3.19",sz:"11:36:55",lz:"12:28:17",st:"Rotenflue SSW Winter",la:"Rickenbach",sLat:47.01819,sLon:8.701503,lLat:47.012549,lLon:8.67004,dur:"0h 51m",dk:"7.3",sl:"2.5",kmh:"8.5",hd:"959",msa:"1516",ml:"597",hm:"1776",hg:"516",ms:"-2.0",mst:"2.0",ge:"Gradient BiGolden 3/39",pa:"Mauro Tannò",be:"Glück beim Start im Schnee, trotz Sturz. Dann super Thermik, Startüberhöhung, Richtung Ibergeregg versumpft, dann retour"},
"687":{d:"23.3.19",sz:"13:36:19",lz:"14:22:52",st:"Rotenflue SSW Winter",la:"Rickenbach",sLat:47.01819,sLon:8.701503,lLat:47.012549,lLon:8.67004,dur:"0h 47m",dk:"5.0",sl:"2.5",kmh:"6.4",hd:"959",msa:"1529",ml:"598",hm:"1788",hg:"456",ms:"-2.1",mst:"1.5",ge:"Gradient BiGolden 3/39",pa:"Mauro Tannò",be:"Beim Start über Hindernisse, gut. Super Thermik, beim Mythen schwach."},
"688":{d:"24.3.19",sz:"15:42:40",lz:"16:01:39",st:"Rigi Staffelhöhe",la:"Küssnacht",sLat:47.047772,sLon:8.460731,lLat:47.06739,lLon:8.435432,dur:"0h 19m",dk:"4.1",sl:"2.9",kmh:"13.0",hd:"1100",msa:"1549",ml:"463",hm:"1666",hg:"132",ms:"-3.0",mst:"2.2",ge:"Advance Pi 23",pa:"",be:"Schöner Rückwärtsstart nach schönem Hike. Startüberhöhung."},
"689":{d:"30.3.19",sz:"14:52:12",lz:"15:22:05",st:"Rigi Staffelhöhe",la:"Küssnacht",sLat:47.047772,sLon:8.460731,lLat:47.06739,lLon:8.435432,dur:"0h 30m",dk:"6.0",sl:"2.9",kmh:"12.0",hd:"1100",msa:"1491",ml:"458",hm:"1671",hg:"260",ms:"-2.9",mst:"2.2",ge:"Advance Pi 23",pa:"",be:"Gute Thermik nach gutem Hike."},
"690":{d:"19.4.19",sz:"12:27:29",lz:"12:58:28",st:"Rigi Scheidegg",la:"Goldau Vogelsang",sLat:47.02779,sLon:8.52001,lLat:47.051871,lLon:8.543638,dur:"0h 31m",dk:"8.3",sl:"3.2",kmh:"16.1",hd:"1172",msa:"1629",ml:"481",hm:"1840",hg:"236",ms:"-2.2",mst:"2.1",ge:"Nova Mentor 3 Light XS",pa:"",be:"Abflauender Föhn und Thermik, dadurch etwas ruppig, aber gutes Steigen, Bogen über Scheidegg-Dossen-Rotenflue. Landung zwischen Kühen."},
"691":{d:"10.5.19",sz:"11:00:00",lz:"11:20:00",st:"San Fermo",la:"San Fermo",sLat:45.7431,sLon:9.948199,lLat:45.7431,lLon:9.948199,dur:"0h 20m",dk:"2",sl:"0.0",kmh:"6.0",hd:"39",msa:"1240",ml:"1240",hm:"1300",hg:"60",ms:"0",mst:"0",ge:"Nova Mentor 3 Light XS",pa:"",be:"Kurs San Fermo 10, FwA, Groundhandling, 5x Toplanding. Gutes Gefühl mit A- und C-Leinen kontrollieren, spät eindrehen, seitwärts ablegen, kiten."},
"692":{d:"10.5.19",sz:"17:05:02",lz:"17:29:39",st:"San Fermo",la:"Casazza",sLat:45.7431,sLon:9.948199,lLat:45.756191,lLon:9.914431,dur:"0h 25m",dk:"6.1",sl:"3.0",kmh:"14.9",hd:"869",msa:"1268",ml:"338",hm:"1429",hg:"39",ms:"-2.7",mst:"2.7",ge:"Nova Mentor 3 Light XS",pa:"",be:"Kurs San Fermo 10, FwA,  Flug nach Casazza, überall Thermik. Müde."},
"693":{d:"11.5.19",sz:"10:44:26",lz:"11:28:03",st:"Mt. Maddalena",la:"Villagio Marcolini",sLat:45.54872,sLon:10.28581,lLat:45.52817,lLon:10.3028,dur:"0h 44m",dk:"5.3",sl:"2.6",kmh:"7.3",hd:"701",msa:"835",ml:"137",hm:"969",hg:"222",ms:"-2.3",mst:"0.9",ge:"Nova Mentor 3 Light XS",pa:"",be:"Kurs San Fermo 10, FwA,  Soaren vor der Front."},
"694":{d:"11.5.19",sz:"14:49:08",lz:"15:03:19",st:"Mt. Maddalena",la:"San Polo Brescia Ost",sLat:45.54872,sLon:10.28581,lLat:45.52468,lLon:10.25866,dur:"0h 14m",dk:"5.1",sl:"3.4",kmh:"21.6",hd:"715",msa:"916",ml:"125",hm:"921",hg:"147",ms:"-3.1",mst:"1.6",ge:"Nova Mentor 3 Light XS",pa:"",be:"Kurs San Fermo 10, FwA,  sehr labil, vor dem Gewitter."},
"695":{d:"1.6.19",sz:"10:52:51",lz:"11:15:49",st:"Bellwald Mutti",la:"Fiesch",sLat:46.43749,sLon:8.15544,lLat:46.40933,lLon:8.136896,dur:"0h 23m",dk:"6.1",sl:"3.4",kmh:"15.9",hd:"723",msa:"1773",ml:"1071",hm:"1773",hg:"190",ms:"-2.5",mst:"1.5",ge:"Gradient BiGolden 3/39",pa:"Bea Mair-Noack",be:"Hike zum Mutti, gemütlich, gute Thermik über Bellwald, mit dem Zug zurück."},
"696":{d:"2.6.19",sz:"10:48:53",lz:"12:48:30",st:"Fiescheralp Heimat",la:"Fiesch",sLat:46.414477,sLon:8.108295,lLat:46.40933,lLon:8.136896,dur:"2h 0m",dk:"42.5",sl:"2.3",kmh:"21.3",hd:"1090",msa:"2142",ml:"1067",hm:"3136",hg:"4237",ms:"-4.0",mst:"5.3",ge:"Nova Mentor 3 Light XS",pa:"",be:"Erster langer Thermikflug, ruppige Frühlingsthermik und viel Schnee am Sidelhorn. R‘wind-Start."},
"697":{d:"8.6.19",sz:"10:23:55",lz:"10:38:19",st:"Fiescheralp Heimat",la:"Fieschertal Flyingcenter",sLat:46.414477,sLon:8.108295,lLat:46.421062,lLon:8.145385,dur:"0h 14m",dk:"5.0",sl:"2.9",kmh:"20.8",hd:"1055",msa:"2138",ml:"1102",hm:"2143",hg:"1",ms:"-2.4",mst:"0.2",ge:"Nova Mentor 3 Light XS",pa:"",be:"Test Lightness 3, sehr lebendig und kippelig, aber bequem. Leicht unruhiger W. von West"},
"698":{d:"8.6.19",sz:"11:41:50",lz:"11:54:48",st:"Fiescheralp Heimat",la:"Fieschertal Flyingcenter",sLat:46.414477,sLon:8.108295,lLat:46.421062,lLon:8.145385,dur:"0h 13m",dk:"4.8",sl:"2.9",kmh:"22.2",hd:"1055",msa:"2135",ml:"1097",hm:"2138",hg:"7",ms:"-3.5",mst:"1.2",ge:"Nova Mentor 3 Light XS",pa:"",be:"Test Lightness 3, gute Thermik. Ldg. auf Strässchen, Fuss vertreten. Sz. Tib.post., ok."},
"699":{d:"24.6.19",sz:"14:58:49",lz:"15:02:02",st:"Praia da Cordoama",la:"Praia da Cordoama",sLat:37.10569,sLon:-8.93878,lLat:37.1082,lLon:-8.93802,dur:"0h 3m",dk:"1.0",sl:"0.3",kmh:"18.7",hd:"98",msa:"108",ml:"9",hm:"110",hg:"2",ms:"-1.6",mst:"0.1",ge:"Advance Pi 23",pa:"",be:"Dünensoaring, am Start ordentlich Wind, dann für den Pi eher zuwenig, kurzes Vergnügen."},
"700":{d:"20.7.19",sz:"10:05:01",lz:"10:51:59",st:"Fiescheralp Heimat",la:"Fieschertal Flyingcenter",sLat:46.414477,sLon:8.108295,lLat:46.421062,lLon:8.145385,dur:"0h 47m",dk:"7.6",sl:"2.9",kmh:"9.7",hd:"1055",msa:"2137",ml:"1105",hm:"2781",hg:"1003",ms:"-3.3",mst:"4.1",ge:"Nova Mentor 3 Light XS",pa:"",be:"Leicht fönig, gute Thermik, Supair Delight 3. Sehr stabil, etwas Rückenschmerzen, zwischen den Beinen etwas unbequem, sonst sehr gut. Landung gut."},
"701":{d:"20.7.19",sz:"11:53:40",lz:"12:14:24",st:"Fiescheralp Heimat",la:"Fiesch",sLat:46.414477,sLon:8.108295,lLat:46.40933,lLon:8.136896,dur:"0h 21m",dk:"5.7",sl:"2.3",kmh:"16.5",hd:"1090",msa:"2129",ml:"1067",hm:"2198",hg:"102",ms:"-4.2",mst:"1.8",ge:"Gradient BiGolden 3/39",pa:"Alena Mair-Noack",be:"Mit Alena, fönig, guter Start und gute Landung, musste etwas Höhe vernichten."},
"702":{d:"21.7.19",sz:"9:37:31",lz:"09:52:46",st:"Fiescheralp Heimat",la:"Fieschertal Flyingcenter",sLat:46.414477,sLon:8.108295,lLat:46.421062,lLon:8.145385,dur:"0h 15m",dk:"6.2",sl:"2.9",kmh:"24.4",hd:"1055",msa:"2090",ml:"1100",hm:"2090",hg:"11",ms:"-2.0",mst:"0.6",ge:"Nova Mentor 3 Light XS",pa:"",be:"Nebel, beginnende Thermik. Ruhig. Delight 3. Bequem."},
"703":{d:"30.7.19",sz:"10:44:39",lz:"11:05:43",st:"Rigi Staffelhöhe",la:"Küssnacht",sLat:47.047772,sLon:8.460731,lLat:47.06739,lLon:8.435432,dur:"0h 21m",dk:"8.0",sl:"2.9",kmh:"22.8",hd:"1100",msa:"1551",ml:"465",hm:"1559",hg:"25",ms:"-2.0",mst:"0.8",ge:"Nova Mentor 3 Light XS",pa:"",be:"Schöner Hike, mit Delight ohne Protektor. Leicht, kleines Volumen."},
"704":{d:"1.8.19",sz:"14:15:40",lz:"14:28:16",st:"Rigi Alp Räb",la:"Küssnacht",sLat:47.05373,sLon:8.45412,lLat:47.06739,lLon:8.435432,dur:"0h 13m",dk:"3.4",sl:"2.1",kmh:"16.2",hd:"645",msa:"1102",ml:"467",hm:"1104",hg:"94",ms:"-2.8",mst:"1.5",ge:"Gradient BiGolden 3/39",pa:"Bea Mair-Noack",be:"Gemütlich in der Alp Räb, gleich dort Start. Gute Thermik über Küssnacht. Alena lief und fuhr runter."},
"705":{d:"3.8.19",sz:"8:48:55",lz:"09:17:41",st:"Fiescheralp Heimat",la:"Fieschertal Flyingcenter",sLat:46.414477,sLon:8.108295,lLat:46.421062,lLon:8.145385,dur:"0h 29m",dk:"8.1",sl:"2.9",kmh:"16.9",hd:"1055",msa:"2145",ml:"1103",hm:"2267",hg:"321",ms:"-8.2",mst:"2.5",ge:"Nova Mentor 3 Light XS",pa:"",be:"Lightness 3, Steigen in den Wolken frühmorgens. Gute Spirale geflogen."},
"706":{d:"3.8.19",sz:"10:10:46",lz:"11:14:43",st:"Fiescheralp Heimat",la:"Baschi",sLat:46.414477,sLon:8.108295,lLat:46.50073,lLon:8.29007,dur:"1h 4m",dk:"20.6",sl:"16.9",kmh:"19.3",hd:"802",msa:"2142",ml:"1348",hm:"2529",hg:"1580",ms:"-2.3",mst:"2.8",ge:"Nova Mentor 3 Light XS",pa:"",be:"Trotz tiefer Basis und Nordwest gutes Steigen, gestreckt mit Nico bis Baschi, dann feines zmittag, mit dem Zug heim."},
"707":{d:"4.8.19",sz:"8:39:31",lz:"08:54:46",st:"Fiescheralp Heimat",la:"Fieschertal Flyingcenter",sLat:46.414477,sLon:8.108295,lLat:46.421062,lLon:8.145385,dur:"0h 15m",dk:"6.1",sl:"2.9",kmh:"24.0",hd:"1055",msa:"2137",ml:"1100",hm:"2135",hg:"0",ms:"-2.5",mst:"0",ge:"Omega XAlps 3 - 22",pa:"",be:"Testflug, ein besonderer Schirm, Steuerung über hintere TG, Beschleunigt eine Wucht. Start einfach."},
"708":{d:"4.8.19",sz:"11:47:16",lz:"12:20:42",st:"Fiescheralp Heimat",la:"Fiesch",sLat:46.414477,sLon:8.108295,lLat:46.40933,lLon:8.136896,dur:"0h 33m",dk:"9.2",sl:"2.3",kmh:"16.5",hd:"1090",msa:"2162",ml:"1108",hm:"2598",hg:"575",ms:"-2.6",mst:"2.5",ge:"Gradient BiGolden 3/39",pa:"Bea Mair-Noack",be:"Gemütlicher Thermikflug, etwas Wind beim Start, RW versetzt, dann VW gut. Ldg. perfekt."},
"709":{d:"16.8.19",sz:"8:56:06",lz:"09:03:41",st:"Bellwald Ried unten",la:"Fiesch",sLat:46.432528,sLon:8.153185,lLat:46.40933,lLon:8.136896,dur:"0h 8m",dk:"3.7",sl:"2.9",kmh:"29.3",hd:"524",msa:"1542",ml:"1016",hm:"1532",hg:"0",ms:"-1.8",mst:"2.8",ge:"Nova Mentor 3 Light XS",pa:"",be:"Hike zum Ried, Flug nach Fiesch bei Morgenstimmung, dann Fieschertal-Bellwald"},
"710":{d:"16.8.19",sz:"10:06:19",lz:"10:19:45",st:"Fiescheralp Heimat",la:"Bellwald ob LFÜB",sLat:46.414477,sLon:8.108295,lLat:46.423735,lLon:8.162345,dur:"0h 13m",dk:"5.2",sl:"4.3",kmh:"23.2",hd:"594",msa:"2150",ml:"1560",hm:"2189",hg:"61",ms:"-2.2",mst:"1.5",ge:"Nova Mentor 3 Light XS",pa:"",be:"Gerade nach Bellwald, Landung bei komischem Wind, R‘wind."},
"711":{d:"16.8.19",sz:"12:10:06",lz:"12:34:40",st:"Fiescheralp Heimat",la:"Fiesch",sLat:46.414477,sLon:8.108295,lLat:46.40933,lLon:8.136896,dur:"0h 25m",dk:"8.0",sl:"2.3",kmh:"19.5",hd:"1090",msa:"2142",ml:"1069",hm:"2417",hg:"316",ms:"-2.7",mst:"1.9",ge:"Gradient BiGolden 3/39",pa:"Bea Mair-Noack",be:"Gute Thermik gleich beim Start, gut überhöht, dann ruhige Runde über Ried, Bellwald und Stei nach Fiesch. Punktlandung!"},
"712":{d:"17.8.19",sz:"10:08:16",lz:"10:28:16",st:"Fiescheralp Biplace",la:"Fiesch",sLat:46.411504,sLon:8.102926,lLat:46.40933,lLon:8.136896,dur:"0h 20m",dk:"6.8",sl:"2.6",kmh:"20.4",hd:"1139",msa:"2193",ml:"1065",hm:"2193",hg:"25",ms:"-2.1",mst:"1.1",ge:"Gradient BiGolden 3/39",pa:"Claris Mair-Noack",be:"Gemütlicher Flug, leichte Thermik am Start und über dem Älpli."},
"713":{d:"25.8.19",sz:"12:20:47",lz:"13:07:25",st:"Brunni Schonegg",la:"Engelberg West",sLat:46.847399,sLon:8.420397,lLat:46.81691,lLon:8.40832,dur:"0h 47m",dk:"10.1",sl:"3.5",kmh:"13.0",hd:"915",msa:"1879",ml:"1014",hm:"2538",hg:"0",ms:"-2.2",mst:"2.2",ge:"Gradient BiGolden 3/39",pa:"Bea Mair-Noack",be:"Herrliche Spätsommer-Thermik. Gipfelhöhe Rigidalstock, dann ruhig via Fürenalp zum neuen Landeplatz. Viel Talwind."},
"714":{d:"15.9.19",sz:"13:14:16",lz:"14:00:16",st:"Rotenflue NE",la:"Rickenbach",sLat:47.022082,sLon:8.704239,lLat:47.012549,lLon:8.67004,dur:"0h 46m",dk:"6.3",sl:"2.8",kmh:"8.2",hd:"951",msa:"1532",ml:"589",hm:"1531",hg:"810",ms:"-2.4",mst:"1.4",ge:"Nova Mentor 3 Light XS",pa:"",be:"Schöne herbstliche Thermik am Mythen. Handy vergessen, nur XC Tracer."},
"715":{d:"6.10.19",sz:"12:19:30",lz:"12:29:01",st:"Steibeläger N",la:"Stei u Zer Tanna",sLat:46.44548,sLon:8.16108,lLat:46.41942,lLon:8.15582,dur:"0h 10m",dk:"3.8",sl:"2.9",kmh:"24.0",hd:"808",msa:"2268",ml:"1471",hm:"2268",hg:"0",ms:"-2.1",mst:"0",ge:"Advance Pi 23",pa:"",be:"Mit Seilbahn erste Sektion, dann Hike. Start in Wolken, dann reinlanden vor ZrTanne bei null Wind."},
"716":{d:"12.10.19",sz:"11:57:05",lz:"12:18:24",st:"La Cima Piano di Vigezzo",la:"Santa Maria Maggiore",sLat:46.162744,sLon:8.475201,lLat:46.133438,lLon:8.450899,dur:"0h 21m",dk:"5.0",sl:"3.8",kmh:"14.1",hd:"968",msa:"1767",ml:"822",hm:"1767",hg:"73",ms:"-2.1",mst:"0.9",ge:"Gradient BiGolden 3/39",pa:"Bea Mair-Noack",be:"Saisonabschluss Centovalli, St. Maria. Leichte Thermik, gemütlich."},
"717":{d:"12.10.19",sz:"15:12:35",lz:"15:26:31",st:"La Cima Piano di Vigezzo",la:"Santa Maria Maggiore",sLat:46.162744,sLon:8.475201,lLat:46.133438,lLon:8.450899,dur:"0h 14m",dk:"4.7",sl:"3.8",kmh:"20.2",hd:"968",msa:"1771",ml:"822",hm:"1771",hg:"0",ms:"-2.2",mst:"0",ge:"Gradient BiGolden 3/39",pa:"Bea Mair-Noack",be:"Saisonabschluss Centovalli, St. Maria. Bedeckt, auch gemütlich."},
"718":{d:"13.10.19",sz:"11:37:49",lz:"12:03:24",st:"La Cima Piano di Vigezzo",la:"Santa Maria Maggiore",sLat:46.162744,sLon:8.475201,lLat:46.133438,lLon:8.450899,dur:"0h 26m",dk:"5.7",sl:"3.8",kmh:"13.4",hd:"968",msa:"1787",ml:"818",hm:"1788",hg:"154",ms:"-2.0",mst:"1.3",ge:"Gradient BiGolden 3/39",pa:"Bea Mair-Noack",be:"Saisonabschluss Centovalli, St. Maria. Leichte Thermik, knapp nicht gereicht zum oben bleiben."},
"719":{d:"20.10.19",sz:"15:10:56",lz:"16:21:57",st:"El Bosque",la:"El Bosque",sLat:36.75388,sLon:-5.48957,lLat:36.74097,lLon:-5.5135,dur:"1h 11m",dk:"14.9",sl:"2.6",kmh:"12.6",hd:"468",msa:"714",ml:"250",hm:"1409",hg:"1901",ms:"-3.2",mst:"3.6",ge:"Nova Mentor 3 Light XS",pa:"",be:"Andalusien 1: Unglaublich viele Leute an Start. Tolle Thermik raus ins Flachland zu den Masten unter Wolkenstrassen."},
"720":{d:"20.10.19",sz:"18:17:23",lz:"19:32:40",st:"El Bosque",la:"El Bosque",sLat:36.75388,sLon:-5.48957,lLat:36.74097,lLon:-5.5135,dur:"1h 15m",dk:"8.7",sl:"2.6",kmh:"6.9",hd:"468",msa:"724",ml:"248",hm:"1381",hg:"1350",ms:"-2.2",mst:"2.5",ge:"Nova Mentor 3 Light XS",pa:"",be:"Andalusien 2: wunderschöner Abendflug, Abendthermik, am Schluss vollbeschleunigt ins Flache."},
"721":{d:"21.10.19",sz:"13:58:30",lz:"15:16:42",st:"Sierra de Lijar SW",la:"West Algodonales A8126",sLat:36.89502,sLon:-5.41578,lLat:36.88984,lLon:-5.42936,dur:"1h 18m",dk:"23.1",sl:"1.3",kmh:"17.7",hd:"454",msa:"901",ml:"453",hm:"1911",hg:"2431",ms:"-3.2",mst:"5.8",ge:"Nova Mentor 3 Light XS",pa:"",be:"Andalusien 3: toller Streckenflug Richtung Ronda, Umkehr mit Nico, dann kurz vor LP ins Lee, Aussenlandung."},
"722":{d:"21.10.19",sz:"18:26:56",lz:"19:29:57",st:"Sierra de Lijar NW",la:"Sierra de Lijar NW",sLat:36.90417,sLon:-5.406,lLat:36.91728,lLon:-5.42081,dur:"1h 3m",dk:"10.6",sl:"2.0",kmh:"10.1",hd:"425",msa:"884",ml:"475",hm:"1525",hg:"833",ms:"-1.9",mst:"1.7",ge:"Nova Mentor 3 Light XS",pa:"",be:"Andalusien 4: toller Abendflug, Videosession"},
"723":{d:"22.10.19",sz:"12:42:42",lz:"13:16:29",st:"El Bosque",la:"El Bosque",sLat:36.75388,sLon:-5.48957,lLat:36.74097,lLon:-5.5135,dur:"0h 34m",dk:"6.6",sl:"2.6",kmh:"11.7",hd:"468",msa:"718",ml:"253",hm:"1086",hg:"607",ms:"-5.5",mst:"2.4",ge:"Nova Mentor 3 Light XS",pa:"",be:"Andalusien 5: Vor dem Regen, Thermik mit den Geiern bis unter die Wolken."},
"724":{d:"24.10.19",sz:"12:49:34",lz:"13:03:42",st:"Sierra de Lijar NW",la:"Sierra de Lijar NW",sLat:36.90417,sLon:-5.406,lLat:36.91728,lLon:-5.42081,dur:"0h 14m",dk:"4.4",sl:"2.0",kmh:"18.7",hd:"425",msa:"886",ml:"475",hm:"892",hg:"31",ms:"-2.4",mst:"0.5",ge:"Nova Mentor 3 Light XS",pa:"",be:"Andalusien 6: kaum Thermik. Konnte erst vor dem LP Thermik nutzen."},
"725":{d:"24.10.19",sz:"15:37:18",lz:"15:47:25",st:"Sierra de Lijar NW",la:"Sierra de Lijar NW",sLat:36.90417,sLon:-5.406,lLat:36.91728,lLon:-5.42081,dur:"0h 10m",dk:"4.0",sl:"2.0",kmh:"23.7",hd:"425",msa:"877",ml:"476",hm:"877",hg:"10",ms:"-2.2",mst:"0.6",ge:"Nova Mentor 3 Light XS",pa:"",be:"Andalusien 7: keine nutzbare Thermik, zu weit im N, kam kaum zurück zum LP"},
"726":{d:"24.10.19",sz:"18:05:41",lz:"18:12:47",st:"Sierra de Lijar NW",la:"Sierra de Lijar NW",sLat:36.90417,sLon:-5.406,lLat:36.91728,lLon:-5.42081,dur:"0h 7m",dk:"2.3",sl:"2.0",kmh:"19.4",hd:"425",msa:"870",ml:"476",hm:"870",hg:"0",ms:"-1.8",mst:"0.0",ge:"Nova Mentor 3 Light XS",pa:"",be:"Andalusien 8: Gemütlicher abendlicher Abgleiter im Abendrot, dann Landebier und Gruppenfoto."},
"727":{d:"25.10.19",sz:"12:46:01",lz:"13:05:09",st:"Sierra de Lijar SE",la:"Algodonales Südost",sLat:36.89874,sLon:-5.39296,lLat:36.8936,lLon:-5.36691,dur:"0h 19m",dk:"5.3",sl:"2.4",kmh:"16.6",hd:"636",msa:"1032",ml:"397",hm:"1034",hg:"46",ms:"-2.5",mst:"1.0",ge:"Nova Mentor 3 Light XS",pa:"",be:"Andalusien 9: Südwind, nichts geht."},
"728":{d:"25.10.19",sz:"15:23:22",lz:"16:38:57",st:"Sierra de Lijar SW",la:"Sierra de Lijar NW",sLat:36.89502,sLon:-5.41578,lLat:36.91728,lLon:-5.42081,dur:"1h 16m",dk:"5.3",sl:"2.5",kmh:"4.2",hd:"432",msa:"914",ml:"478",hm:"1448",hg:"1251",ms:"-3.0",mst:"2.1",ge:"Nova Mentor 3 Light XS",pa:"",be:"Andalusien 10: Tolle Thermik über dem Startplatz, Konvergenz-Thermik über dem Tal."},
"729":{d:"25.10.19",sz:"17:57:32",lz:"18:39:27",st:"Sierra de Lijar SW",la:"Sierra de Lijar NW",sLat:36.89502,sLon:-5.41578,lLat:36.91728,lLon:-5.42081,dur:"0h 42m",dk:"5.4",sl:"2.5",kmh:"7.7",hd:"432",msa:"893",ml:"476",hm:"1340",hg:"625",ms:"-2.5",mst:"2.5",ge:"Nova Mentor 3 Light XS",pa:"",be:"Andalusien 11: Ruhige Abendthermik, super Stimmung zum Abschluss inkl. Landebier. Einfach herrlich."},
"730":{d:"8.3.20",sz:"12:40:21",lz:"12:57:05",st:"Rotenflue SSW Winter",la:"Rickenbach",sLat:47.01819,sLon:8.701503,lLat:47.012549,lLon:8.67004,dur:"0h 17m",dk:"4.9",sl:"2.5",kmh:"17.6",hd:"959",msa:"1521",ml:"583",hm:"1521",hg:"4",ms:"-2.2",mst:"0.3",ge:"Nova Mentor 3 Light XS",pa:"",be:"2 Fehlstarts wegen A-Leinenüberwurf rechts. Dann Startunterbruch wegen zuviel Bremse. Sehr schwache Thermik links gen Süden."},
"731":{d:"21.3.20",sz:"11:38:16",lz:"11:50:24",st:"Fiescheralp Heimat",la:"Fiesch",sLat:46.414477,sLon:8.108295,lLat:46.40933,lLon:8.136896,dur:"0h 12m",dk:"4.8",sl:"2.3",kmh:"23.7",hd:"1090",msa:"2125",ml:"1059",hm:"2135",hg:"75",ms:"-3.7",mst:"3.0",ge:"Nova Mentor 3 Light XS",pa:"",be:"Ganz alleine wegen Corona. Skigebiet geschlossen. Leichter Rückenwind bei Bise. Leicht ruppig, alles ok."},
"732":{d:"4.4.20",sz:"11:18:25",lz:"11:26:16",st:"Chäserstatt",la:"Niederernen",sLat:46.40728,sLon:8.17483,lLat:46.391923,lLon:8.135385,dur:"0h 8m",dk:"4.0",sl:"3.5",kmh:"30.6",hd:"740",msa:"1792",ml:"1077",hm:"1792",hg:"0",ms:"-2.3",mst:"0",ge:"Advance Pi 23",pa:"",be:"Hike mit Peter von Niederernen über Mühlebach nach Chäserstatt. Oben harter Schnee, leichter Rückenwind."},
"733":{d:"10.4.20",sz:"8:17:34",lz:"08:21:58",st:"Bellwald ob LFÜB",la:"Mühlebach",sLat:46.42357,sLon:8.16326,lLat:46.404548,lLon:8.152127,dur:"0h 4m",dk:"2.7",sl:"2.3",kmh:"36.8",hd:"345",msa:"1532",ml:"1206",hm:"1532",hg:"0",ms:"-2.3",mst:"0.1",ge:"Advance Pi 23",pa:"",be:"Beginn Hike mit Peter nach Chäserstatt. Ost-/Bergwind von der Seite, Rückwärtsstart ok."},
"734":{d:"10.4.20",sz:"10:43:19",lz:"10:47:54",st:"Chäserstatt Heizunalp",la:"Bellwald ob LFÜB",sLat:46.40622,sLon:8.17807,lLat:46.423735,lLon:8.162345,dur:"0h 5m",dk:"2.4",sl:"2.3",kmh:"31.4",hd:"392",msa:"1926",ml:"1555",hm:"1926",hg:"0",ms:"-2.4",mst:"0.2",ge:"Advance Pi 23",pa:"",be:"Treffe Peter in Mühlebach. Hike nach Chäserstatt, etwas höher im Schnee zur nächsten Alp. Leichter Rückenwind."},
"735":{d:"11.4.20",sz:"10:28:21",lz:"10:38:13",st:"Bellwald Mutti",la:"Fiesch",sLat:46.43749,sLon:8.15544,lLat:46.40933,lLon:8.136896,dur:"0h 10m",dk:"4.5",sl:"3.4",kmh:"27.4",hd:"723",msa:"1776",ml:"1066",hm:"1776",hg:"3",ms:"-2.5",mst:"0.2",ge:"Gradient BiGolden 3/39",pa:"Alena Mair-Noack",be:"Tandem-Hike mit Alena. Nur leichte Thermik über Bellwald."},
"736":{d:"18.4.20",sz:"8:06:33",lz:"08:12:02",st:"Bellwald Ried unten",la:"Fieschertal Flyingcenter",sLat:46.432528,sLon:8.153185,lLat:46.421062,lLon:8.145385,dur:"0h 5m",dk:"2.2",sl:"1.4",kmh:"24.1",hd:"489",msa:"1470",ml:"1050",hm:"1470",hg:"0",ms:"-2.7",mst:"0",ge:"Advance Pi 23",pa:"",be:"Ganz leichter Abwind. Ruhig, Landung bei Hansi, dort treffe ich Peter."},
"737":{d:"18.4.20",sz:"10:40:30",lz:"10:50:24",st:"Matt",la:"Stei u Zer Tanna",sLat:46.42669,sLon:8.12323,lLat:46.41942,lLon:8.15582,dur:"0h 10m",dk:"3.3",sl:"2.6",kmh:"20.0",hd:"462",msa:"1916",ml:"1477",hm:"1972",hg:"46",ms:"-2.2",mst:"1.5",ge:"Advance Pi 23",pa:"",be:"Toller Hike mit Peter, am Anfang steil, guter Startplatz am Waldrand, kleine Büsche. Gute Thermik über Alp. Landung vor dem Haus!"},
"738":{d:"22.4.20",sz:"12:39:53",lz:"12:55:17",st:"Gniepen Rossberg",la:"Goldau Vogelsang",sLat:47.081685,sLon:8.548137,lLat:47.051871,lLon:8.543638,dur:"0h 15m",dk:"4.5",sl:"3.3",kmh:"17.5",hd:"1075",msa:"1526",ml:"480",hm:"1550",hg:"26",ms:"-2.5",mst:"1.1",ge:"Advance Pi 23",pa:"",be:"Hike auf den Gniepen, oben steil und heiss. Leichte Bise von N, lee-thermisch von S, alles schwach. Gute Thermik beim Flug,"},
"739":{d:"9.5.20",sz:"11:31:57",lz:"11:44:45",st:"Rotenflue SSW Winter",la:"Rickenbach",sLat:47.01819,sLon:8.701503,lLat:47.012549,lLon:8.67004,dur:"0h 13m",dk:"4.4",sl:"2.5",kmh:"20.6",hd:"959",msa:"1536",ml:"599",hm:"1536",hg:"11",ms:"-2.2",mst:"1.2",ge:"Advance Pi 23",pa:"",be:"Hike entlang der Bahn zum Startplatz, diesmal anstrengend. Thermisch von S, mässiger Wind von SW"},
"740":{d:"28.6.20",sz:"10:26:07",lz:"10:38:28",st:"Fiescheralp Heimat",la:"Fieschertal Flyingcenter",sLat:46.414477,sLon:8.108295,lLat:46.421062,lLon:8.145385,dur:"0h 12m",dk:"5.4",sl:"2.9",kmh:"26.2",hd:"1055",msa:"2136",ml:"1102",hm:"2136",hg:"0",ms:"-2.2",mst:"1.8",ge:"Gradient BiGolden 3/39",pa:"Alena Mair-Noack",be:"Start an Heimat, weil seitlicher Wind unter den Chalets. Ruhig, nichts los. Guter Start, gute Landung."},
"741":{d:"30.6.20",sz:"9:46:15",lz:"10:51:53",st:"Fiescheralp Heimat",la:"Fiesch",sLat:46.414477,sLon:8.108295,lLat:46.40933,lLon:8.136896,dur:"1h 6m",dk:"7.2",sl:"2.3",kmh:"6.6",hd:"1090",msa:"2136",ml:"1067",hm:"2238",hg:"898",ms:"-2.2",mst:"1",ge:"Gradient BiGolden 3/39",pa:"Alena Mair-Noack",be:"Mässige, aber ruhige Thermik, es geht überall rauf. Gemütlich lange über Bellwald. Es wird kalt, aber Alena und ich machen die Stunde!"},
"742":{d:"4.7.20",sz:"9:38:24",lz:"09:49:04",st:"Rotenflue SW Sommer",la:"Rickenbach",sLat:47.017641,sLon:8.700727,lLat:47.012549,lLon:8.67004,dur:"0h 11m",dk:"3.7",sl:"2.4",kmh:"20.8",hd:"928",msa:"1495",ml:"597",hm:"1495",hg:"0",ms:"-8.2",mst:"0.0",ge:"Advance XI 23",pa:"",be:"Erster Flug mit dem XI. Stallpunkt sehr tief und nur mit viel Kraft. Schnell im guter Spirale. Stabile Beschleunigung."},
"743":{d:"4.7.20",sz:"10:45:51",lz:"11:23:19",st:"Rotenflue SW Sommer",la:"Rickenbach",sLat:47.017641,sLon:8.700727,lLat:47.012549,lLon:8.67004,dur:"0h 37m",dk:"6.7",sl:"2.4",kmh:"10.7",hd:"928",msa:"1507",ml:"599",hm:"1507",hg:"287",ms:"-1.9",mst:"1.6",ge:"Advance XI 23",pa:"",be:"Sanfte Thermik vor dem Mythen. Hohe Leistung. Gut über C-Gurte zu steuern. Spass."},
"744":{d:"7.7.20",sz:"12:43:06",lz:"13:13:01",st:"Rotenflue W Sommer",la:"Rickenbach",sLat:47.018594,sLon:8.701526,lLat:47.012549,lLon:8.67004,dur:"0h 30m",dk:"4.2",sl:"2.5",kmh:"8.4",hd:"960",msa:"1540",ml:"592",hm:"1596",hg:"156",ms:"-2.5",mst:"1.0",ge:"Advance XI 23",pa:"",be:"Bise, Rückwärtsstart, nach dem 2. Versuch gut. Startüberhöhung. Leicht ruppig, nicht so lustig, deshalb bald mal ins Tal."},
"745":{d:"8.7.20",sz:"12:01:34",lz:"13:02:41",st:"Rotenflue W Sommer",la:"Rickenbach",sLat:47.018594,sLon:8.701526,lLat:47.012549,lLon:8.67004,dur:"1h 1m",dk:"7.5",sl:"2.5",kmh:"7.4",hd:"960",msa:"1539",ml:"594",hm:"1539",hg:"802",ms:"-2.8",mst:"2",ge:"Advance XI 23",pa:"",be:"Bise, aber leichte Thermik über dem Wald vor dem Mythen, besser über der Ebene."},
"746":{d:"8.7.20",sz:"14:04:55",lz:"14:46:31",st:"Rotenflue SSW Winter",la:"Rickenbach",sLat:47.01819,sLon:8.701503,lLat:47.012549,lLon:8.67004,dur:"0h 42m",dk:"12.3",sl:"2.5",kmh:"17.7",hd:"959",msa:"1527",ml:"598",hm:"1680",hg:"514",ms:"-2.1",mst:"2.4",ge:"Advance XI 23",pa:"",be:"Leicht ruppige Bisenthermik vor dem grossen und kleinen Mythen. Dann über den Talkessel bis über Seewen, mit Rückenwind zurück."},
"747":{d:"10.7.20",sz:"9:18:50",lz:"09:43:08",st:"Fiescheralp Heimat",la:"Fiesch",sLat:46.414477,sLon:8.108295,lLat:46.40933,lLon:8.136896,dur:"0h 24m",dk:"5.2",sl:"2.3",kmh:"12.8",hd:"1090",msa:"2145",ml:"1066",hm:"2145",hg:"34",ms:"-2.4",mst:"0.9",ge:"Advance XI 23",pa:"",be:"Morgendlich ruhig, aber über Älpli schon Nullschieber. Gemütlich."},
"748":{d:"10.7.20",sz:"10:46:37",lz:"12:02:25",st:"Fiescheralp Heimat",la:"Fiesch",sLat:46.414477,sLon:8.108295,lLat:46.40933,lLon:8.136896,dur:"1h 16m",dk:"13.6",sl:"2.3",kmh:"10.8",hd:"1090",msa:"2152",ml:"1059",hm:"2571",hg:"1674",ms:"-2.8",mst:"2.5",ge:"Advance XI 23",pa:"",be:"Westwind, zügig. Gute, zerrissene Thermik. Dynamisch am Hang zwischen Mutti und Steibenchrüz, gutes Soaring bis über Bergstation. Dann Gewitter"},
"749":{d:"12.7.20",sz:"9:44:12",lz:"12:55:12",st:"Fiescheralp Heimat",la:"Fiesch",sLat:46.414477,sLon:8.108295,lLat:46.40933,lLon:8.136896,dur:"3h 11m",dk:"28.4",sl:"2.3",kmh:"8.9",hd:"1090",msa:"2123",ml:"1086",hm:"3057",hg:"4343",ms:"-3.5",mst:"3.2",ge:"Advance XI 23",pa:"",be:"Anfangs schwache Thermik, Inversion nicht überwindbar. Bellwald, Kapelle, dann retour und nun Erfolg, Eggishorn, Riederalp retour. Rekord!"},
"750":{d:"13.7.20",sz:"10:53:37",lz:"11:10:24",st:"Eggerhorn West",la:"Fieschertal Flyingcenter",sLat:46.383165,sLon:8.182902,lLat:46.421062,lLon:8.145385,dur:"0h 17m",dk:"6.6",sl:"5.1",kmh:"23.6",hd:"1369",msa:"2474",ml:"1107",hm:"2474",hg:"0",ms:"-2.6",mst:"0.5",ge:"Advance Pi 23",pa:"",be:"Hike mit Mariette und Stefan. Neuer Weg ab Ausserbinn. Sehr schön. Start einfach nach West bei wenig Wind."},
"751":{d:"25.7.20",sz:"12:13:16",lz:"12:41:37",st:"Brunni Schonegg",la:"Engelberg West",sLat:46.839927,sLon:8.41465,lLat:46.817432,lLon:8.40887,dur:"0h 28m",dk:"7.5",sl:"2.5",kmh:"15.9",hd:"915",msa:"1920",ml:"1014",hm:"2117",hg:"387",ms:"-2.4",mst:"2.4",ge:"Gradient BiGolden 3/39",pa:"Nicola Mair-Noack",be:"Wenig West. Gute, leicht zerrissene Thermik, Startüberhöhung. Schöne Landung."},
"752":{d:"1.8.20",sz:"11:04:01",lz:"12:01:29",st:"Brunni Schonegg",la:"Engelberg West",sLat:46.842178,sLon:8.416526,lLat:46.817432,lLon:8.40887,dur:"0h 57m",dk:"6.7",sl:"2.8",kmh:"7.0",hd:"1049",msa:"2050",ml:"1015",hm:"2175",hg:"623",ms:"-2.5",mst:"1.9",ge:"Advance XI 23",pa:"",be:"Start ganz oben am Schonegg, gute lokale Thermik, aber zunehmend gewittrig."},
"753":{d:"24.8.20",sz:"11:43:20",lz:"12:07:55",st:"Chaiserstuel",la:"Wolfenschiessen",sLat:46.877156,sLon:8.467618,lLat:46.905095,lLon:8.398533,dur:"0h 25m",dk:"8.7",sl:"6.1",kmh:"21.2",hd:"1888",msa:"2385",ml:"518",hm:"2385",hg:"1",ms:"-2.3",mst:"0.5",ge:"Advance XI 23",pa:"",be:"Schöner Hike, etwas in den Wolken, am Start sehr verhangen. Guter Startplatz, in alle Richtungen zum auslegen, dann aber rasch steil."},
"754":{d:"6.9.20",sz:"13:35:31",lz:"17:38:31",st:"Vale Amoreira SE",la:"Belmonte A23/33",sLat:40.40348,sLon:-7.45443,lLat:40.37794,lLon:-7.30598,dur:"4h 3m",dk:"39.9",sl:"12.9",kmh:"9.9",hd:"361",msa:"848",ml:"493",hm:"2661",hg:"9239",ms:"-4.6",mst:"4.5",ge:"Advance XI 23",pa:"",be:"Portugal 1: Am Anfang Mühe, hochzukommen. Dann immer besser. Grosse Runde, super Schlauch am Startplatz, dann Flachland. N-Wind"},
"755":{d:"7.9.20",sz:"18:54:58",lz:"20:03:13",st:"Larouco Süd-Ost",la:"Gralhas Nord",sLat:41.88046,sLon:-7.72048,lLat:41.85749,lLon:-7.71032,dur:"1h 8m",dk:"5.2",sl:"2.7",kmh:"4.6",hd:"526",msa:"1554",ml:"1011",hm:"1647",hg:"332",ms:"-1.5",mst:"0.6",ge:"Advance XI 23",pa:"",be:"Portugal 2: Gemütliches Abendsoaring, starker Wind am Start."},
"756":{d:"8.9.20",sz:"14:58:41",lz:"15:03:14",st:"Vale Amoreira SE",la:"Vale de Armoreira",sLat:40.40348,sLon:-7.45443,lLat:40.40274,lLon:-7.4426,dur:"0h 5m",dk:"1.4",sl:"1.0",kmh:"18.5",hd:"313",msa:"854",ml:"538",hm:"854",hg:"0",ms:"-3",mst:"0.0",ge:"Advance XI 23",pa:"",be:"Portugal 3: Schwach, finde keinen Schlaucheintritt. Abbruch."},
"757":{d:"8.9.20",sz:"16:47:16",lz:"16:58:00",st:"Vale Amoreira SE",la:"Vale de Armoreira",sLat:40.40348,sLon:-7.45443,lLat:40.40274,lLon:-7.4426,dur:"0h 11m",dk:"2.6",sl:"1.0",kmh:"14.5",hd:"313",msa:"848",ml:"536",hm:"848",hg:"56",ms:"-1.9",mst:"0.9",ge:"Advance XI 23",pa:"",be:"Portugal 4: Immer noch schwach, wenig Thermik links über Krete."},
"758":{d:"8.9.20",sz:"18:05:19",lz:"18:12:34",st:"Vale Amoreira SE",la:"Vale de Armoreira",sLat:40.40348,sLon:-7.45443,lLat:40.40274,lLon:-7.4426,dur:"0h 7m",dk:"2.5",sl:"1.0",kmh:"20.7",hd:"313",msa:"843",ml:"537",hm:"843",hg:"0",ms:"-1.7",mst:"0.0",ge:"Advance XI 23",pa:"",be:"Portugal 5: Nun zu spät, wenig ist rechts los."},
"759":{d:"9.9.20",sz:"12:34:42",lz:"12:51:06",st:"Azinha",la:"Vale de Armoreira",sLat:40.43085,sLon:-7.45549,lLat:40.40274,lLon:-7.4426,dur:"0h 16m",dk:"4.4",sl:"3.3",kmh:"16.1",hd:"712",msa:"1246",ml:"539",hm:"1380",hg:"181",ms:"-3.5",mst:"1.5",ge:"Advance XI 23",pa:"",be:"Portugal 6: finde trotz grosser Starthöhe keinen Einstieg in die Thermik. Absaufen, auch vor Amoreira nichts."},
"760":{d:"9.9.20",sz:"14:07:00",lz:"15:41:23",st:"Vale Amoreira SE",la:"Vale de Estrela",sLat:40.40348,sLon:-7.45443,lLat:40.5041,lLon:-7.28897,dur:"1h 34m",dk:"24.4",sl:"17.9",kmh:"15.5",hd:"-52",msa:"842",ml:"894",hm:"1970",hg:"4152",ms:"-3.9",mst:"4.4",ge:"Advance XI 23",pa:"",be:"Portugal 7: Endlich wieder guter Flug raus in die Ebene. Oft tief, low safes, Pass rüber kurz vor Guarda schaffe ich noch, dann absaufen. Heikle Ldg."},
"761":{d:"9.9.20",sz:"17:38:13",lz:"18:55:57",st:"Linhares",la:"Linhares",sLat:40.53257,sLon:-7.44585,lLat:40.55009,lLon:-7.45644,dur:"1h 18m",dk:"7.7",sl:"2.1",kmh:"5.9",hd:"471",msa:"1160",ml:"688",hm:"2190",hg:"1545",ms:"-2.8",mst:"2.2",ge:"Advance XI 23",pa:"",be:"Portugal 8: Gemütliche Abendthermik, kann ewig oben bleiben."},
"762":{d:"10.9.20",sz:"13:47:32",lz:"16:48:53",st:"Mirandela",la:"Quinta de Terrincha",sLat:41.45062,sLon:-7.31114,lLat:41.24434,lLon:-7.08654,dur:"3h 1m",dk:"45.2",sl:"29.6",kmh:"15.0",hd:"694",msa:"830",ml:"152",hm:"2689",hg:"6442",ms:"-4.5",mst:"3.9",ge:"Advance XI 23",pa:"",be:"Portugal 9: Bogenförmiger grossartiger Streckenflug zurück ins Hotel, entlang Autobahn, Stadt, Pass. 2 low safes in extremis. Was vom Tollsten."},
"763":{d:"11.9.20",sz:"13:47:41",lz:"14:57:06",st:"Vale Amoreira SE",la:"Gonçalo",sLat:40.40348,sLon:-7.45443,lLat:40.41569,lLon:-7.34012,dur:"1h 9m",dk:"15.7",sl:"9.8",kmh:"13.6",hd:"306",msa:"858",ml:"541",hm:"1788",hg:"2497",ms:"-5.0",mst:"4.1",ge:"Advance XI 23",pa:"",be:"Portugal 10: Sehr ruppig, zunehmend abgedeckelt. Nicht schön. Landung im Flachland, keine Lust mehr auf low safe."},
"764":{d:"17.10.20",sz:"12:08:10",lz:"12:21:22",st:"Fiescheralp Heimat",la:"Fiesch",sLat:46.414477,sLon:8.108295,lLat:46.40933,lLon:8.136896,dur:"0h 13m",dk:"3.4",sl:"2.3",kmh:"15.5",hd:"1090",msa:"2149",ml:"1061",hm:"2146",hg:"46",ms:"-2.7",mst:"2.8",ge:"Advance XI 23",pa:"",be:"Grosser Knoten rechts, mit gutem Gegensteuer direkt zur Landung."},
"765":{d:"17.10.20",sz:"13:08:19",lz:"13:40:43",st:"Fiescheralp Heimat",la:"Fiesch",sLat:46.414477,sLon:8.108295,lLat:46.40933,lLon:8.136896,dur:"0h 32m",dk:"7.5",sl:"2.3",kmh:"13.9",hd:"1090",msa:"2148",ml:"1059",hm:"2380",hg:"356",ms:"-2.5",mst:"2.0",ge:"Advance XI 23",pa:"",be:"Schöne Thermik bis unter die Wolkenbasis, dann Schlauch über Bellwald. Frisch."},
"766":{d:"18.10.20",sz:"14:06:15",lz:"14:43:43",st:"Fiescheralp Heimat",la:"Fiesch",sLat:46.414477,sLon:8.108295,lLat:46.40933,lLon:8.136896,dur:"0h 37m",dk:"9.1",sl:"2.3",kmh:"14.6",hd:"1090",msa:"2143",ml:"1067",hm:"2527",hg:"663",ms:"-3.5",mst:"2.7",ge:"Advance XI 23",pa:"",be:"Gute Herbstthermik. Bis Basis. Über Richinen, dann zurück. Etwas kalt."},
"767":{d:"14.11.20",sz:"13:19:44",lz:"13:31:34",st:"Brunnihütte",la:"Engelberg West",sLat:46.842699,sLon:8.410243,lLat:46.817432,lLon:8.40887,dur:"0h 12m",dk:"5.1",sl:"2.8",kmh:"25.9",hd:"866",msa:"1899",ml:"1011",hm:"1899",hg:"1",ms:"-4.3",mst:"0.0",ge:"Gradient BiGolden 3/39",pa:"Luca Wild",be:"Spätherbst, mit Bea und Alena, Luca. Ruhig, für Einstieg in Thermik zu tief."},
"768":{d:"14.11.20",sz:"15:10:59",lz:"15:20:02",st:"Brunni Tümpfeli",la:"Engelberg West",sLat:46.838069,sLon:8.41206,lLat:46.817432,lLon:8.40887,dur:"0h 9m",dk:"3.1",sl:"2.3",kmh:"20.6",hd:"796",msa:"1779",ml:"1007",hm:"1779",hg:"0",ms:"-3.6",mst:"0.0",ge:"Gradient BiGolden 3/39",pa:"Luca Wild",be:"Spät nachmittags, ruhiges Abgleiten."},
"769":{d:"24.1.21",sz:"14:09:58",lz:"14:23:31",st:"Rigi Staffelhöhe",la:"Küssnacht",sLat:47.047772,sLon:8.460731,lLat:47.06739,lLon:8.435432,dur:"0h 14m",dk:"4.1",sl:"2.9",kmh:"18.2",hd:"1100",msa:"1531",ml:"476",hm:"1531",hg:"3",ms:"-3.2",mst:"0.5",ge:"Advance Pi 23",pa:"",be:"Winterlicher Aufstieg, oben Wind aus allen Richtungen, 1 Fehlstart. Dann ruhig. Thermik über Seeboden. Kalt."},
"770":{d:"28.2.21",sz:"11:23:05",lz:"12:10:08",st:"Fiescheralp Heimat",la:"Fiesch",sLat:46.414477,sLon:8.108295,lLat:46.40933,lLon:8.136896,dur:"0h 47m",dk:"7.0",sl:"2.3",kmh:"8.9",hd:"1090",msa:"2158",ml:"1063",hm:"2195",hg:"590",ms:"-3.6",mst:"1.7",ge:"Advance XI 23",pa:"",be:"Gute Thermik, aber Inversion auf ca. 2200. Erstes Mal mit XCTracer Maxx."},
"771":{d:"1.3.21",sz:"11:23:41",lz:"12:48:23",st:"Fiescheralp Heimat",la:"Fiesch",sLat:46.414477,sLon:8.108295,lLat:46.40933,lLon:8.136896,dur:"1h 25m",dk:"14.5",sl:"2.3",kmh:"10.3",hd:"1090",msa:"2167",ml:"1066",hm:"2646",hg:"1571",ms:"-2.8",mst:"2.3",ge:"Advance XI 23",pa:"",be:"Gute Thermik, etwas ruppig wegen Ostwind. Bis Bellwald, dann tief."},
"772":{d:"4.3.21",sz:"11:45:52",lz:"12:43:43",st:"Fiescheralp Heimat",la:"Fiesch",sLat:46.414477,sLon:8.108295,lLat:46.40933,lLon:8.136896,dur:"0h 58m",dk:"13.3",sl:"2.3",kmh:"13.8",hd:"1090",msa:"2156",ml:"1062",hm:"2582",hg:"1545",ms:"-2.4",mst:"2.9",ge:"Advance XI 23",pa:"",be:"Trotz hoher Bewölkung gute, teils ruppige Thermik. Direkt nach Bellwald, dort tief, rasch guter Anschluss. Steibenkreuz-Heimat-Uf en Egga-Kapelle-F."},
"773":{d:"6.3.21",sz:"12:24:09",lz:"12:42:13",st:"Fiescheralp Heimat",la:"Fiesch",sLat:46.414477,sLon:8.108295,lLat:46.40933,lLon:8.136896,dur:"0h 18m",dk:"4.5",sl:"2.3",kmh:"14.9",hd:"1090",msa:"2158",ml:"1061",hm:"2238",hg:"112",ms:"2.8",mst:"2.6",ge:"Advance XI 23",pa:"",be:"Unsauber, Föhntendenz, viel Wind im Tal."},
"774":{d:"28.3.21",sz:"11:55:11",lz:"12:04:54",st:"Haldi",la:"Schattdorf",sLat:46.86234,sLon:8.673187,lLat:46.867042,lLon:8.655784,dur:"0h 10m",dk:"2.4",sl:"1.4",kmh:"14.8",hd:"615",msa:"1075",ml:"485",hm:"1075",hg:"1",ms:"-2.2",mst:"0.6",ge:"Gradient BiGolden 3/39",pa:"Alena Mair-Noack",be:"Neues Gebiet, super Startwiese, kaum Thermik. Landeplatz etwas eng bei Talwind."},
"775":{d:"2.4.21",sz:"11:41:52",lz:"12:40:42",st:"Fiescheralp Heimat",la:"Fiesch",sLat:46.414477,sLon:8.108295,lLat:46.40933,lLon:8.136896,dur:"0h 59m",dk:"14.1",sl:"2.3",kmh:"14.4",hd:"1090",msa:"2133",ml:"1056",hm:"2862",hg:"1566",ms:"-2.8",mst:"3.0",ge:"Gradient BiGolden 3/39",pa:"Alena Mair-Noack",be:"Gute Frühlingsthermik bis zum Egishorn und Aletsch! Dann Rundreise rüber über Chäserstatt, Bellwald, zurück zur TS Heimat. Dann Kalt."},
"776":{d:"4.4.21",sz:"11:27:12",lz:"12:42:52",st:"Fiescheralp Heimat",la:"Fiesch",sLat:46.414477,sLon:8.108295,lLat:46.40933,lLon:8.136896,dur:"1h 16m",dk:"16.5",sl:"2.3",kmh:"13.1",hd:"1090",msa:"2140",ml:"1060",hm:"2620",hg:"2096",ms:"-2.7",mst:"3.0",ge:"Advance XI 23",pa:"",be:"Ganz alleine bei kaum Wind, schöne Frühlingsthermik, geht überall hoch.Bellwald retour, dann über den tiefsten Älpli wieder hoch bis zum Startplatz."},
"777":{d:"13.5.21",sz:"9:39:27",lz:"09:59:24",st:"Fiescheralp Heimat",la:"Fiesch",sLat:46.414477,sLon:8.108295,lLat:46.40933,lLon:8.136896,dur:"0h 20m",dk:"5.32",sl:"2.3",kmh:"16.0",hd:"1090",msa:"2163",ml:"1059",hm:"2164",hg:"77",ms:"-2.4",mst:"0.4",ge:"Advance Pi 23",pa:"",be:"garstige Verhältnisse, Wolken, aber wenig Wind. Schnee, langer Startweg. Wenig Thermik westl. der Bahn."},
"778":{d:"13.5.21",sz:"10:59:16",lz:"11:38:02",st:"Fiescheralp Heimat",la:"Fiesch",sLat:46.414477,sLon:8.108295,lLat:46.40933,lLon:8.136896,dur:"0h 39m",dk:"9.36",sl:"2.3",kmh:"14.5",hd:"1090",msa:"2160",ml:"1066",hm:"2375",hg:"908",ms:"-2.3",mst:"2.5",ge:"Advance XI 23",pa:"",be:"Lange gekämpft. Dann hoch über Talstation Heimberg. Querung Speicherbecken Ernergale-Bellwald-Fiesch."},
"779":{d:"14.5.21",sz:"10:23:27",lz:"12:34:54",st:"Bellwald Mutti",la:"Stei u Zer Tanna",sLat:46.43749,sLon:8.15544,lLat:46.41942,lLon:8.15582,dur:"2h 11m",dk:"42.28",sl:"2.0",kmh:"19.3",hd:"306",msa:"1774",ml:"1476",hm:"2986",hg:"5241",ms:"-4.1",mst:"5.1",ge:"Advance XI 23",pa:"",be:"Hike zum Mutti über Bellwald Höhe, dann unter Wolkenstrassen zum Sidelhorn. Kaum Eindrehen, immer geradeaus. Ruppig. Kalt. Einlanden Stei, uiii!"},
"780":{d:"15.5.21",sz:"9:39:27",lz:"09:55:01",st:"Fiescheralp Heimat",la:"Fiesch",sLat:46.414477,sLon:8.108295,lLat:46.40933,lLon:8.136896,dur:"0h 16m",dk:"5.95",sl:"2.3",kmh:"22.9",hd:"1090",msa:"2160",ml:"1069",hm:"2160",hg:"18",ms:"-2.5",mst:"0.3",ge:"Advance XI 23",pa:"",be:"Start bei Wolken und leichtem Schnee. Ruhig."},
"781":{d:"15.5.21",sz:"11:02:27",lz:"11:23:18",st:"Fiescheralp Heimat",la:"Fiesch",sLat:46.414477,sLon:8.108295,lLat:46.40933,lLon:8.136896,dur:"0h 21m",dk:"7.47",sl:"2.3",kmh:"21.5",hd:"1090",msa:"2154",ml:"1061",hm:"2154",hg:"42",ms:"-2.8",mst:"0.8",ge:"Advance XI 23",pa:"",be:"Start mit Wolken, Ruhig, leichtes Soaring."},
"782":{d:"19.6.21",sz:"8:47:28",lz:"09:02:39",st:"Fiescheralp Heimat",la:"Fieschertal Flyingcenter",sLat:46.414477,sLon:8.108295,lLat:46.421062,lLon:8.145385,dur:"0h 15m",dk:"5.67",sl:"2.9",kmh:"22.4",hd:"1055",msa:"2150",ml:"1093",hm:"2150",hg:"34",ms:"-4.0",mst:"0.4",ge:"Advance XI 23",pa:"",be:"Wenig los, Nullschieber über dem Älpli."},
"783":{d:"19.6.21",sz:"9:57:28",lz:"10:16:07",st:"Fiescheralp Heimat",la:"Fieschertal Flyingcenter",sLat:46.414477,sLon:8.108295,lLat:46.421062,lLon:8.145385,dur:"0h 19m",dk:"6.19",sl:"2.9",kmh:"19.9",hd:"1055",msa:"2152",ml:"1091",hm:"2152",hg:"32",ms:"-3.0",mst:"1.1",ge:"Advance XI 23",pa:"",be:"Verhänger am Start. Dann ruhiges Soaring am Älpli."},
"784":{d:"19.6.21",sz:"11:06:57",lz:"12:50:14",st:"Fiescheralp Heimat",la:"Fieschertal Flyingcenter",sLat:46.414477,sLon:8.108295,lLat:46.421062,lLon:8.145385,dur:"1h 43m",dk:"16.59",sl:"2.9",kmh:"9.6",hd:"1055",msa:"2150",ml:"1094",hm:"2697",hg:"2142",ms:"-4.2",mst:"2.9",ge:"Advance XI 23",pa:"",be:"Zuerst harzig über den Älpli, dann Querung nach Richinen und weiter ins Obergoms. Abbruch, weil die Zeit fehlt. Via Chäserstatt."},
"785":{d:"26.6.21",sz:"10:07:14",lz:"12:15:16",st:"Fiescheralp Biplace",la:"Fiesch",sLat:46.411504,sLon:8.102926,lLat:46.40933,lLon:8.136896,dur:"2h 8m",dk:"44.39",sl:"2.6",kmh:"20.8",hd:"1139",msa:"2193",ml:"1066",hm:"3139",hg:"4848",ms:"-4.2",mst:"5.0",ge:"Gradient BiGolden 3/39",pa:"Claris Mair-Noack",be:"Erster Flug mit Biplace zum Sidelhorn. Tolle Thermik, oben KALT BRRR und ruhig, in Wolke an Basis, unten oft sehr feine Thermik. Sensationell."},
"786":{d:"2.7.21",sz:"10:24:54",lz:"12:30:30",st:"Fiescheralp Heimat",la:"Fiesch",sLat:46.414477,sLon:8.108295,lLat:46.40933,lLon:8.136896,dur:"2h 6m",dk:"45.74",sl:"2.3",kmh:"21.9",hd:"1090",msa:"2150",ml:"1083",hm:"2983",hg:"3585",ms:"-3.0",mst:"3.5",ge:"Advance XI 23",pa:"",be:"Früher Flug zum Sidelhorn unter Wolkenstrassen, anfangs tiefe Basis. Ein grösserer Halbseitenklapper rechts, geht alles gut wieder auf."},
"787":{d:"3.7.21",sz:"09:58:49",lz:"10:55:44",st:"Fiescheralp Heimat",la:"Fiesch",sLat:46.414477,sLon:8.108295,lLat:46.40933,lLon:8.136896,dur:"0h 57m",dk:"9.33",sl:"2.3",kmh:"9.8",hd:"1090",msa:"2151",ml:"1078",hm:"2355",hg:"866",ms:"-4.1",mst:"2.6",ge:"Advance XI 23",pa:"",be:"Lange Thermik-Suche über den Älpli und Matt, dann Bellwald. Gemütlich."},
"788":{d:"10.7.21",sz:"10:08:31",lz:"10:24:02",st:"Fiescheralp Heimat",la:"Fiesch",sLat:46.414477,sLon:8.108295,lLat:46.40933,lLon:8.136896,dur:"0h 16m",dk:"6.48",sl:"2.3",kmh:"25.1",hd:"1090",msa:"2146",ml:"1066",hm:"2150",hg:"1",ms:"-2.0",mst:"0.2",ge:"Advance XI 23",pa:"",be:"Testen der Follow Cam. Alles funktioniert auf Anhieb. Verbindung zur GoPro Quik instabil."},
"789":{d:"10.7.21",sz:"11:39:13",lz:"12:21:19",st:"Fiescheralp Heimat",la:"Fiesch",sLat:46.414477,sLon:8.108295,lLat:46.40933,lLon:8.136896,dur:"0h 42m",dk:"10.26",sl:"2.3",kmh:"14.6",hd:"1090",msa:"2151",ml:"1081",hm:"2753",hg:"881",ms:"-3.8",mst:"4.3",ge:"Advance XI 23",pa:"",be:"Verhänger, Einlandung nach Start, Neustart. Dann gute Höhe. Ruppig. Über Richinen Abbruch."},
"790":{d:"15.8.21",sz:"10:30:36",lz:"10:46:03",st:"Brunnihütte",la:"Engelberg West",sLat:46.842699,sLon:8.410243,lLat:46.817432,lLon:8.40887,dur:"0h 15m",dk:"4.6",sl:"2.8",kmh:"17.9",hd:"866",msa:"1865",ml:"1015",hm:"1865",hg:"54",ms:"-2.0",mst:"0.8",ge:"Gradient BiGolden 3/39",pa:"Mauro Tannò",be:"Gleitflug am Morgen, mit GoPro. Bereits wenig Thermik über der Kante Rigidalstafel."},
"791":{d:"15.8.21",sz:"12:25:29",lz:"13:31:16",st:"Brunni Schonegg",la:"Engelberg West",sLat:46.840311,sLon:8.414959,lLat:46.817432,lLon:8.40887,dur:"1h 6m",dk:"10.84",sl:"2.6",kmh:"9.9",hd:"943",msa:"1947",ml:"1014",hm:"2637",hg:"1588",ms:"-2.6",mst:"3.1",ge:"Gradient BiGolden 3/39",pa:"Mauro Tannò",be:"Erst mühsam, dann gute Thermik, oft ruppig. Gipfel Rigidalstock, dann zum Laucherengrat und zurück. Zu weit Richtung Fürenalp, reicht nicht zum LP."},
"792":{d:"28.8.21",sz:"18:07:13",lz:"19:20:55",st:"Àger Sant Alis",la:"Àger Ço de Petetò",sLat:42.04605,sLon:0.74617,lLat:42.01717,lLon:0.74325,dur:"1h 14m",dk:"12.85",sl:"3.2",kmh:"10.5",hd:"827",msa:"1555",ml:"844",hm:"1870",hg:"1399",ms:"-4.0",mst:"1.1",ge:"Advance XI 23",pa:"",be:"Pyrenäen 1: Erster Flug zum Angewöhnen. Erst viel Wind, dann ruhig. Hin und her und übers Tal."},
"793":{d:"29.8.21",sz:"12:36:59",lz:"13:42:24",st:"Àger Sant Alis",la:"Àger Ço de Petetò",sLat:42.04605,sLon:0.74617,lLat:42.01717,lLon:0.74325,dur:"1h 5m",dk:"15.52",sl:"3.2",kmh:"14.2",hd:"827",msa:"1532",ml:"743",hm:"1691",hg:"391",ms:"-4.5",mst:"5.2",ge:"Advance XI 23",pa:"",be:"Pyrenäen 2: Ruppig bei SE, immer wieder Lee und Luv, die Krete nach E, dann übers Tal nach Ager. Unschön, aber ok."},
"794":{d:"29.8.21",sz:"17:40:48",lz:"18:11:59",st:"Àger Sant Alis",la:"Àger Ço de Petetò",sLat:42.04605,sLon:0.74617,lLat:42.01717,lLon:0.74325,dur:"0h 31m",dk:"11.73",sl:"3.2",kmh:"22.6",hd:"827",msa:"1565",ml:"737",hm:"1937",hg:"559",ms:"-4.0",mst:"1.3",ge:"Advance XI 23",pa:"",be:"Pyrenäen 3: Viel Wind am Start, lange warten. Dann dynamisch an der Krete hoch. Talquerung, dort geht nichts mehr. Schluss, habe genug."},
"795":{d:"30.8.21",sz:"12:36:51",lz:"14:08:08",st:"Gallinero las Planadas",la:"Gallinero las Planadas",sLat:42.5338,sLon:0.55189,lLat:42.53393,lLon:0.55306,dur:"1h 31m",dk:"11.45",sl:"0.1",kmh:"7.5",hd:"0",msa:"2296",ml:"2321",hm:"2684",hg:"2734",ms:"-4.7",mst:"4.7",ge:"Advance XI 23",pa:"",be:"Pyrenäen 4: Rasch gute Thermik am Hausschlauch. Route nach E, dann zum Skigebiet nach W, zurück, super Toplanding, mit Mühe, geht nur rauf!!"},
"796":{d:"30.8.21",sz:"15:08:39",lz:"15:34:17",st:"Gallinero las Planadas",la:"Castejón de Sos",sLat:42.5338,sLon:0.55189,lLat:42.51864,lLon:0.48998,dur:"0h 26m",dk:"6.34",sl:"5.3",kmh:"14.8",hd:"1315",msa:"2295",ml:"898",hm:"2480",hg:"34",ms:"-5.5",mst:"1.2",ge:"Advance XI 23",pa:"",be:"Pyrenäen 5: Gewitter im Anzug, nur noch runter, schwierig bei immer nur steigen…"},
"797":{d:"31.8.21",sz:"13:15:58",lz:"13:44:23",st:"Gallinero las Planadas",la:"Castejón de Sos",sLat:42.5338,sLon:0.55189,lLat:42.51864,lLon:0.48998,dur:"0h 28m",dk:"7.18",sl:"5.3",kmh:"15.2",hd:"1315",msa:"2295",ml:"907",hm:"2295",hg:"244",ms:"-4.5",mst:"1.1",ge:"Advance XI 23",pa:"",be:"Pyrenäen 6: Abgleiter, unter und durch Wolken."},
"798":{d:"2.9.21",sz:"17:37:27",lz:"17:51:08",st:"Loarre Plan d'os Lugars",la:"Loarre Ost",sLat:42.33251,sLon:-0.60915,lLat:42.31238,lLon:-0.61698,dur:"0h 14m",dk:"3.37",sl:"2.3",kmh:"14.8",hd:"457",msa:"1276",ml:"875",hm:"1355",hg:"158",ms:"-2.7",mst:"1.6",ge:"Advance XI 23",pa:"",be:"Pyrenäen 7: Langes Warten auf S-Wind, immer zu weit SE. Am Schluss nahendes Gewitter. Abgleiten."},
"799":{d:"3.9.21",sz:"14:37:41",lz:"15:51:09",st:"Orduño Cuesta Labauri",la:"Orduño S",sLat:42.96118,sLon:-3.02355,lLat:42.97778,lLon:-3.01744,dur:"1h 13m",dk:"7.39",sl:"1.9",kmh:"6.0",hd:"595",msa:"924",ml:"326",hm:"1052",hg:"1078",ms:"-11.9",mst:"3.1",ge:"Advance XI 23",pa:"",be:"Pyrenäen 8: Gemütliches Soaren an der Klippe. Tiefe Basis."},
"800":{d:"3.9.21",sz:"17:13:54",lz:"19:22:25",st:"Orduño Cuesta Labauri",la:"Orduño S",sLat:42.96118,sLon:-3.02355,lLat:42.97778,lLon:-3.01744,dur:"2h 9m",dk:"5.35",sl:"1.9",kmh:"2.5",hd:"595",msa:"932",ml:"329",hm:"1032",hg:"1149",ms:"-1.9",mst:"1.4",ge:"Advance XI 23",pa:"",be:"Pyrenäen 9: Soaring direkt an des Basis, und oft darüber. Immer wieder in Wolken, kleine Ohren, zurück etc."},
"801":{d:"4.9.21",sz:"12:52:51",lz:"13:38:23",st:"Eulate",la:"Eulate",sLat:42.78276,sLon:-2.2123,lLat:42.7772,lLon:-2.21754,dur:"0h 46m",dk:"8.35",sl:"0.8",kmh:"11.0",hd:"218",msa:"953",ml:"743",hm:"1344",hg:"1103",ms:"-4.5",mst:"2.5",ge:"Advance XI 23",pa:"",be:"Pyrenäen 10: Soaren über der Krete, manchmal ziemlich hoch, auch Thermik über dem Tal."},
"802":{d:"4.9.21",sz:"14:47:29",lz:"14:56:08",st:"Eulate",la:"Eulate",sLat:42.78276,sLon:-2.2123,lLat:42.7772,lLon:-2.21754,dur:"0h 9m",dk:"2.05",sl:"0.8",kmh:"14.2",hd:"218",msa:"965",ml:"730",hm:"966",hg:"14",ms:"-1.1",mst:"0.3",ge:"Advance XI 23",pa:"",be:"Pyrenäen 11: Absaufen bei fehlender Thermik, wenig über dem Tal. Ende der Ferien."},
"803":{d:"25.9.21",sz:"09:43:43",lz:"10:02:31",st:"Fiescheralp Heimat",la:"Fiesch",sLat:46.414477,sLon:8.108295,lLat:46.40933,lLon:8.136896,dur:"0h 19m",dk:"5.1",sl:"2.3",kmh:"16.3",hd:"1090",msa:"2149",ml:"1077",hm:"2151",hg:"2",ms:"-3.3",mst:"0",ge:"Advance XI 23",pa:"",be:"Ruhig, herbstlich ohne wesentliche Thermik."},
"804":{d:"9.10.21",sz:"12:06:26",lz:"12:38:06",st:"Fiescheralp Heimat",la:"Fiesch",sLat:46.414477,sLon:8.108295,lLat:46.40933,lLon:8.136896,dur:"0h 32m",dk:"5.92",sl:"2.3",kmh:"11.2",hd:"1090",msa:"2150",ml:"1058",hm:"2153",hg:"124",ms:"-3.7",mst:"0.5",ge:"Advance XI 23",pa:"",be:"Wenig Thermik, sanft. Dann rasch runter, mit Bea kurzer Spaziergang."},
"805":{d:"9.10.21",sz:"14:44:22",lz:"15:02:29",st:"Fiescheralp Heimat",la:"Fiesch",sLat:46.414477,sLon:8.108295,lLat:46.40933,lLon:8.136896,dur:"0h 18m",dk:"6.3",sl:"2.3",kmh:"20.9",hd:"1090",msa:"2143",ml:"1062",hm:"2143",hg:"3",ms:"-4.8",mst:"0.2",ge:"Advance XI 23",pa:"",be:"Nach Spaziergang ruhiger Gleitflug, Fiescherrunde."},
"806":{d:"10.10.21",sz:"11:47:47",lz:"12:03:42",st:"Eggerhorn West",la:"Niederernen",sLat:46.383135,sLon:8.181913,lLat:46.391923,lLon:8.135385,dur:"0h 16m",dk:"6.46",sl:"3.7",kmh:"24.4",hd:"1388",msa:"2470",ml:"1125",hm:"2471",hg:"0",ms:"-4.3",mst:"3.4",ge:"Advance Pi 23",pa:"",be:"Ab Niederernen mit Peter. Harter Hike, nicht fit. Ruhiger Flug zurück nach Niederernen"},
"807":{d:"16.10.21",sz:"10:36:01",lz:"10:50:00",st:"Brunni Schonegg",la:"Engelberg West",sLat:46.840311,sLon:8.414959,lLat:46.817432,lLon:8.40887,dur:"0h 14m",dk:"4.7",sl:"2.6",kmh:"20.2",hd:"943",msa:"1935",ml:"1024",hm:"1935",hg:"0",ms:"-1.9",mst:"0.2",ge:"Gradient BiGolden 3/39",pa:"Claris Mair-Noack",be:"Noch früh, kaum Thermik. Gemütlich."},
"808":{d:"16.10.21",sz:"12:27:02",lz:"12:56:08",st:"Brunnihütte",la:"Engelberg West",sLat:46.842699,sLon:8.410243,lLat:46.817432,lLon:8.40887,dur:"0h 29m",dk:"5.68",sl:"2.8",kmh:"11.7",hd:"866",msa:"1873",ml:"1014",hm:"1873",hg:"330",ms:"-2.4",mst:"1.1",ge:"Gradient BiGolden 3/39",pa:"Claris Mair-Noack",be:"Schöner Herbstflug, ordentliche Thermik über SE-Kante."},
"809":{d:"16.10.21",sz:"14:11:01",lz:"14:33:45",st:"Brunni Schonegg",la:"Engelberg West",sLat:46.840311,sLon:8.414959,lLat:46.817432,lLon:8.40887,dur:"0h 23m",dk:"3.98",sl:"2.6",kmh:"10.5",hd:"943",msa:"1902",ml:"1023",hm:"1902",hg:"69",ms:"-3.4",mst:"0.6",ge:"Gradient BiGolden 3/39",pa:"Claris Mair-Noack",be:"Thermik schon wieder schwächer. Gemütlich."},
"810":{d:"13.11.21",sz:"10:57:13",lz:"11:14:34",st:"Fiescheralp Heimatpiste",la:"Fiesch",sLat:46.416163,sLon:8.104648,lLat:46.40933,lLon:8.136896,dur:"0h 17m",dk:"5.95",sl:"2.6",kmh:"20.6",hd:"1208",msa:"2270",ml:"1067",hm:"2271",hg:"2",ms:"1.9",mst:"0.5",ge:"Advance XI 23",pa:"",be:"Spätherbstlich, Start bei W auf Piste Heimat-Bergstation, super.  Dann Fiescherrunde bis Eggen"},
"811":{d:"15.1.22",sz:"12:46:39",lz:"13:02:50",st:"Fiescheralp Heimat",la:"Fiesch",sLat:46.414477,sLon:8.108295,lLat:46.40933,lLon:8.136896,dur:"0h 16m",dk:"5.72",sl:"2.3",kmh:"21.2",hd:"1090",msa:"2159",ml:"1068",hm:"2159",hg:"18",ms:"-4.0",mst:"0.2",ge:"Advance Pi 23",pa:"",be:"Wieder mal mit Ski, ruhige Verhältnisse, sogar etwas Thermik am Start."},
"812":{d:"16.1.22",sz:"12:52:15",lz:"13:15:23",st:"Fiescheralp Heimat",la:"Fiesch",sLat:46.414477,sLon:8.108295,lLat:46.40933,lLon:8.136896,dur:"0h 23m",dk:"7.29",sl:"2.3",kmh:"18.9",hd:"1090",msa:"2148",ml:"1057",hm:"2197",hg:"102",ms:"-3.3",mst:"0.5",ge:"Advance XI 23",pa:"",be:"Leichter West, Thermik über dem Start."},
"813":{d:"23.1.22",sz:"14:06:39",lz:"14:27:47",st:"Rigi Kulm",la:"Küssnacht",sLat:47.056342,sLon:8.487049,lLat:47.06739,lLon:8.435432,dur:"0h 21m",dk:"7.2",sl:"4.1",kmh:"20.4",hd:"1314",msa:"1770",ml:"459",hm:"1770",hg:"5",ms:"-1.8",mst:"0.2",ge:"Advance XI 23",pa:"",be:"Hike zur Staffelhöhe, dort R'wind, über Staffel zum Kulm, dort null Wind. Flacher Startplatz SE oben an der Kante hinter dem letzten Häuschen. Kalt."},
"814":{d:"3.3.22",sz:"12:46:49",lz:"13:08:03",st:"Fiescheralp Heimat",la:"Fiesch",sLat:46.414477,sLon:8.108295,lLat:46.40933,lLon:8.136896,dur:"0h 21m",dk:"6.75",sl:"2.3",kmh:"19.1",hd:"1090",msa:"2159",ml:"1068",hm:"2447",hg:"412",ms:"-2.8",mst:"2.4",ge:"Gradient BiGolden 3/39",pa:"Alena Mair-Noack",be:"Skistart, etwas R‘wind. Gute Startüberhöhung. Über der Kapelle Bellwald deutlicher Frontklapper, völlig überraschend. Ausleitung problemlos."},
"815":{d:"6.3.22",sz:"11:22:30",lz:"11:45:02",st:"Fiescheralp Heimat",la:"Fiesch",sLat:46.414477,sLon:8.108295,lLat:46.40933,lLon:8.136896,dur:"0h 23m",dk:"5.96",sl:"2.3",kmh:"15.9",hd:"1090",msa:"2150",ml:"1061",hm:"2331",hg:"349",ms:"-4.8",mst:"1.4",ge:"Advance XI 23",pa:"",be:"Bise, gute Thermik, leicht ruppig, wechselnd am LP."},
"816":{d:"7.3.22",sz:"10:05:38",lz:"10:30:41",st:"Fiescheralp Heimat",la:"Fiesch",sLat:46.414477,sLon:8.108295,lLat:46.40933,lLon:8.136896,dur:"0h 25m",dk:"6.63",sl:"2.3",kmh:"15.9",hd:"1090",msa:"2172",ml:"1082",hm:"2173",hg:"109",ms:"-3.7",mst:"0.6",ge:"Advance XI 23",pa:"",be:"Bereits gute Thermik, etwas ruppig, muss mich wieder daran gewöhnen. Keine Probleme"},
"817":{d:"7.3.22",sz:"11:21:47",lz:"11:49:45",st:"Fiescheralp Heimat",la:"Fiesch",sLat:46.414477,sLon:8.108295,lLat:46.40933,lLon:8.136896,dur:"0h 28m",dk:"7.02",sl:"2.3",kmh:"15.1",hd:"1090",msa:"2154",ml:"1061",hm:"2225",hg:"231",ms:"-4.5",mst:"1.1",ge:"Advance XI 23",pa:"",be:"Gute Thermik, über Älpli noch besser, mit Peters Tandem über Bellwald."},
"818":{d:"9.3.22",sz:"10:32:56",lz:"10:41:12",st:"Bellwald Ried unten",la:"Fiesch",sLat:46.432528,sLon:8.153185,lLat:46.40933,lLon:8.136896,dur:"0h 8m",dk:"3.37",sl:"2.9",kmh:"24.5",hd:"524",msa:"1575",ml:"1062",hm:"1587",hg:"1",ms:"-4.5",mst:"0.5",ge:"Advance XI 23",pa:"",be:"Gemütlicher Weg zum Ried, Wiesenstart, ruhig."},
"819":{d:"9.3.22",sz:"11:40:34",lz:"12:07:54",st:"Fiescheralp Heimat",la:"Stei u Zer Tanna",sLat:46.414477,sLon:8.108295,lLat:46.41942,lLon:8.15582,dur:"0h 27m",dk:"8.41",sl:"3.7",kmh:"18.5",hd:"673",msa:"2162",ml:"1530",hm:"2309",hg:"479",ms:"-3.8",mst:"1.3",ge:"Advance XI 23",pa:"",be:"Gute Frühlingsthermik, via Salzgäb nach Chäserstatt, dann Einlanden vor dem Haus, problemlos."},
"820":{d:"10.3.22",sz:"09:20:26",lz:"09:23:13",st:"Bellwald ob LFÜB",la:"Milebacher Lee",sLat:46.42357,sLon:8.16326,lLat:46.407799,lLon:8.160181,dur:"0h 3m",dk:"1.53",sl:"1.8",kmh:"33.0",hd:"245",msa:"1544",ml:"1302",hm:"1544",hg:"0",ms:"-1.6",mst:"0.1",ge:"Advance XI 23",pa:"",be:"Teil 1 des Hike nach Chäserstatt, Hanglandung oberhalb Mühlebach."},
"821":{d:"10.3.22",sz:"11:06:37",lz:"11:11:45",st:"Chäserstatt",la:"Stei u Zer Tanna",sLat:46.40728,sLon:8.17483,lLat:46.41942,lLon:8.15582,dur:"0h 5m",dk:"2.23",sl:"2.0",kmh:"26.1",hd:"339",msa:"1819",ml:"1453",hm:"1821",hg:"3",ms:"-2.4",mst:"0.3",ge:"Advance XI 23",pa:"",be:"Teil 2: Leichter R'wind, gute Skipiste. Landung im Stei im Lee, zu tief, in die Hecke!! Und Dornen!! Nichts passiert, Nick und Alena helfen."},
"822":{d:"9.4.22",sz:"11:54:11",lz:"13:02:44",st:"Gallodoro",la:"Letojanni",sLat:37.8966,sLon:15.30798,lLat:37.87993,lLon:15.30753,dur:"1h 9m",dk:"6.74",sl:"1.9",kmh:"5.9",hd:"466",msa:"400",ml:"48",hm:"836",hg:"2084",ms:"-3.5",mst:"2.1",ge:"Advance XI 23",pa:"",be:"Sizilien 1: Gute Thermik, Rückversetzt an Krete. Tragischer Zwischenfall, Lucien erleidet im Flug Herzinfarkt, landet im Meer und stirbt!!!"},
"823":{d:"10.4.22",sz:"12:05:06",lz:"12:16:55",st:"Grotta del Gatto",la:"Zafferana",sLat:37.68289,sLon:15.08626,lLat:37.68814,lLon:15.10841,dur:"0h 12m",dk:"2.77",sl:"2.0",kmh:"14.1",hd:"390",msa:"940",ml:"540",hm:"960",hg:"142",ms:"-2.5",mst:"0.8",ge:"Advance XI 23",pa:"",be:"Sizilien 2: Im Lee des Ätna, zerrissene Thermik, mässig toll."},
"824":{d:"11.4.22",sz:"11:55:12",lz:"12:39:22",st:"Monte della Scala",la:"Niscemi",sLat:37.25147,sLon:14.42315,lLat:37.14405,lLon:14.38174,dur:"0h 44m",dk:"14.04",sl:"12.5",kmh:"19.1",hd:"473",msa:"771",ml:"294",hm:"1396",hg:"2656",ms:"-2.4",mst:"4",ge:"Advance XI 23",pa:"",be:"Sizilien 3: Streckenflug über die Ebene zum Bergstädtchen Niscemi. Ziel gut erreicht, Toplanding"},
"825":{d:"11.4.22",sz:"15:21:31",lz:"16:30:21",st:"Niscemi",la:"Niscemi",sLat:37.14405,sLon:14.38174,lLat:37.14405,lLon:14.38174,dur:"1h 9m",dk:"4.05",sl:"0.0",kmh:"3.5",hd:"0",msa:"298",ml:"297",hm:"598",hg:"2660",ms:"-4.0",mst:"2.1",ge:"Advance XI 23",pa:"",be:"Sizilien 4: Soaring im Meer- oder Südwind. Gemütlich. Toplanden."},
"826":{d:"11.4.22",sz:"17:26:37",lz:"17:46:37",st:"Niscemi",la:"Niscemi",sLat:37.14405,sLon:14.38174,lLat:37.14405,lLon:14.38174,dur:"0h 20m",dk:"1.23",sl:"0.0",kmh:"3.7",hd:"0",msa:"308",ml:"298",hm:"451",hg:"452",ms:"-1.1",mst:"1.6",ge:"Advance XI 23",pa:"",be:"Sizilien 5: Soaring im Meer- oder Südwind. Gemütlich. Toplanden."},
"827":{d:"11.4.22",sz:"17:49:46",lz:"18:40:52",st:"Niscemi",la:"Niscemi",sLat:37.14405,sLon:14.38174,lLat:37.14405,lLon:14.38174,dur:"0h 51m",dk:"2.99",sl:"0.0",kmh:"3.5",hd:"0",msa:"289",ml:"283",hm:"671",hg:"1290",ms:"-1.1",mst:"1.7",ge:"Advance XI 23",pa:"",be:"Sizilien 6: Abend-Soaring im Meer- oder Südwind. Gemütlich. Toplanden."},
"828":{d:"12.4.22",sz:"11:09:58",lz:"11:45:34",st:"Funivia dell’Etna",la:"Fondachello Lido Monsone",sLat:37.71769,sLon:14.9993,lLat:37.76203,lLon:15.21751,dur:"0h 36m",dk:"22.76",sl:"19.8",kmh:"38.4",hd:"2465",msa:"2463",ml:"1",hm:"2463",hg:"96",ms:"-3.6",mst:"0.6",ge:"Advance XI 23",pa:"",be:"Sizilien 7: Herrlicher Gleitflug vom Ätna zum Strand, bei besten Bedingungen, mehrere Inversionen."},
"829":{d:"12.4.22",sz:"15:19:06",lz:"15:38:55",st:"Monte Veneretta Pt Mole",la:"Letojanni",sLat:37.8694,sLon:15.26773,lLat:37.87993,lLon:15.30753,dur:"0h 20m",dk:"8.73",sl:"3.7",kmh:"26.4",hd:"801",msa:"810",ml:"0",hm:"810",hg:"370",ms:"-2.9",mst:"1.4",ge:"Advance XI 23",pa:"",be:"Sizilien 8: Toller Flug über Städtchen, Küstenlinie und Stränden."},
"830":{d:"13.4.22",sz:"14:01:22",lz:"14:38:05",st:"Gallodoro",la:"Letojanni",sLat:37.8966,sLon:15.30798,lLat:37.87993,lLon:15.30753,dur:"0h 37m",dk:"7.31",sl:"1.9",kmh:"11.9",hd:"466",msa:"475",ml:"18",hm:"777",hg:"1240",ms:"-2.4",mst:"1.4",ge:"Advance XI 23",pa:"",be:"Sizilien 9: Gute Thermik, leicht ruppig. Flug zum Ende des Strandes, kam kaum zurück."},
"831":{d:"13.4.22",sz:"16:11:01",lz:"16:35:02",st:"Gallodoro",la:"Letojanni",sLat:37.8966,sLon:15.30798,lLat:37.87993,lLon:15.30753,dur:"0h 24m",dk:"3.12",sl:"1.9",kmh:"7.8",hd:"466",msa:"475",ml:"8",hm:"483",hg:"242",ms:"-3.1",mst:"0.1",ge:"Advance XI 23",pa:"",be:"Sizilien 10: Wenig ruhige Thermik, nach einigen Kurven doch abgesoffen."},
"832":{d:"14.4.22",sz:"10:47:16",lz:"11:48:31",st:"Gallodoro",la:"Letojanni",sLat:37.8966,sLon:15.30798,lLat:37.87993,lLon:15.30753,dur:"1h 1m",dk:"14.12",sl:"1.9",kmh:"13.8",hd:"466",msa:"475",ml:"11",hm:"738",hg:"1120",ms:"-1.9",mst:"1.3",ge:"Advance XI 23",pa:"",be:"Sizilien 11: Tolles Soaring im Wind über der Küste, Strecke Forza d‘Agrò -  Theater Taormina und retour zum LP."},
"833":{d:"15.4.22",sz:"10:59:15",lz:"11:13:30",st:"Monte Veneretta Pt Mole",la:"Letojanni",sLat:37.8694,sLon:15.26773,lLat:37.87993,lLon:15.30753,dur:"0h 14m",dk:"6.83",sl:"3.7",kmh:"28.8",hd:"801",msa:"781",ml:"49",hm:"788",hg:"0",ms:"-4.1",mst:"0.3",ge:"Advance XI 23",pa:"",be:"Sizilien 12: ruhiger Gleitflug zum Strand, weniger Wind."},
"834":{d:"15.4.22",sz:"13:43:01",lz:"13:51:59",st:"Gallodoro",la:"Letojanni",sLat:37.8966,sLon:15.30798,lLat:37.87993,lLon:15.30753,dur:"0h 9m",dk:"2.44",sl:"1.9",kmh:"16.3",hd:"466",msa:"478",ml:"6",hm:"481",hg:"2",ms:"-2.9",mst:"0.9",ge:"Advance XI 23",pa:"",be:"Sizilien 13: ruhiger Angleiter vom Standard-Startplatz zum Meer."},
"835":{d:"14.5.22",sz:"13:35:38",lz:"13:52:13",st:"Gniepen Rossberg",la:"Goldau Vogelsang",sLat:47.081685,sLon:8.548137,lLat:47.051871,lLon:8.543638,dur:"0h 17m",dk:"5.01",sl:"3.3",kmh:"18.1",hd:"1075",msa:"1553",ml:"492",hm:"1554",hg:"34",ms:"-5.2",mst:"0.0",ge:"Advance XI 23",pa:"",be:"2:50-Hike auf den Gnipen, bin nicht in Form, Hüft- und Gluteal-Sz. Landung mit Bise sehr böig, starkes Pendeln, nicht gut."},
"836":{d:"15.5.22",sz:"11:16:10",lz:"11:31:44",st:"Rotenflue SW Sommer",la:"Rickenbach",sLat:47.017641,sLon:8.700727,lLat:47.012549,lLon:8.67004,dur:"0h 16m",dk:"3.97",sl:"2.4",kmh:"15.3",hd:"928",msa:"1453",ml:"592",hm:"1457",hg:"34",ms:"-2.0",mst:"0.1",ge:"Gradient BiGolden 3/39",pa:"Alena Mair-Noack",be:"Start gut, Thermik zu schwach, Landung etwas hart."},
"837":{d:"15.5.22",sz:"12:24:28",lz:"12:41:07",st:"Rotenflue SSW Winter",la:"Rickenbach",sLat:47.01819,sLon:8.701503,lLat:47.012549,lLon:8.67004,dur:"0h 17m",dk:"4.68",sl:"2.5",kmh:"16.9",hd:"959",msa:"1541",ml:"588",hm:"1541",hg:"68",ms:"-2.5",mst:"0.5",ge:"Gradient BiGolden 3/39",pa:"Alena Mair-Noack",be:"Start mit leichtem Rückenwind, beim Rennen auf Alenas Fersen getreten, auii!! Landung leicht hangaufwärts eher hart."},
"838":{d:"15.5.22",sz:"13:44:41",lz:"14:13:10",st:"Rotenflue SW Sommer",la:"Rickenbach",sLat:47.017641,sLon:8.700727,lLat:47.012549,lLon:8.67004,dur:"0h 28m",dk:"7.14",sl:"2.4",kmh:"15.0",hd:"928",msa:"1503",ml:"593",hm:"1503",hg:"289",ms:"-2.4",mst:"1.2",ge:"Gradient BiGolden 3/39",pa:"Alena Mair-Noack",be:"Start gut, schöne Thermik hinter dem Mythen über den Wald. Landung gut, etwas Pendeln beim Anflug."},
"839":{d:"26.5.22",sz:"11:16:59",lz:"13:21:33",st:"Fiescheralp Heimat",la:"Fiesch",sLat:46.414477,sLon:8.108295,lLat:46.40933,lLon:8.136896,dur:"2h 5m",dk:"18.95",sl:"2.3",kmh:"9.1",hd:"1090",msa:"2162",ml:"1059",hm:"2735",hg:"3098",ms:"-2.4",mst:"3.0",ge:"Advance XI 23",pa:"",be:"Erst harzig, fast abgesoffen, Klapper nach dem Start, dann ruppiger, aber herrlicher Thermik-Flug Älpli-Richinen-Chäserstatt-Frid-Eggerhorn von S."},
"840":{d:"29.5.22",sz:"10:31:38",lz:"10:50:32",st:"Fiescheralp Heimat",la:"Fiesch",sLat:46.414477,sLon:8.108295,lLat:46.40933,lLon:8.136896,dur:"0h 19m",dk:"5.62",sl:"2.3",kmh:"17.8",hd:"1090",msa:"2159",ml:"1069",hm:"2161",hg:"171",ms:"-4.8",mst:"0.6",ge:"Advance XI 23",pa:"",be:"Bise, Start an Wolkendecke, dann recht turbulent bis zur Landung, unsauber, wohl Ostwind. Treffe Fabian."},
"841":{d:"18.6.22",sz:"09:53:23",lz:"11:06:38",st:"Fiescheralp Heimat",la:"Fiesch",sLat:46.414477,sLon:8.108295,lLat:46.40933,lLon:8.136896,dur:"1h 13m",dk:"9.27",sl:"2.3",kmh:"7.6",hd:"1090",msa:"2160",ml:"1095",hm:"2411",hg:"1026",ms:"-4.7",mst:"1.3",ge:"Advance XI 23",pa:"",be:"Etwas früh, aber schon ganz ordentlich. Knapp über Richinen, gut über Bellwald."},
"842":{d:"18.6.22",sz:"11:54:06",lz:"13:15:22",st:"Fiescheralp Heimat",la:"Fiesch",sLat:46.414477,sLon:8.108295,lLat:46.40933,lLon:8.136896,dur:"1h 21m",dk:"16.79",sl:"2.3",kmh:"12.4",hd:"1090",msa:"2153",ml:"1068",hm:"3333",hg:"2634",ms:"-5.8",mst:"4.8",ge:"Advance XI 23",pa:"",be:"Weit über Eggishorn und über Aletschgletscher. Ruppig, deutlich Ostwind, in Richinen und Richtung Goms turbulent, Ldg. schwierig, da viel Ostwind."},
"843":{d:"23.6.22",sz:"09:25:49",lz:"09:52:20",st:"Fiescheralp Heimat",la:"Fiesch",sLat:46.414477,sLon:8.108295,lLat:46.40933,lLon:8.136896,dur:"0h 27m",dk:"5.86",sl:"2.3",kmh:"13.3",hd:"1090",msa:"2148",ml:"1074",hm:"2163",hg:"35",ms:"-3.0",mst:"0.4",ge:"Advance XI 23",pa:"",be:"Nur schwache Thermik, reicht nicht, Absaufen. Peter und Sepp können sich halten. Nochmals hoch"},
"844":{d:"23.6.22",sz:"10:36:59",lz:"10:56:44",st:"Fiescheralp Heimat",la:"Fiesch",sLat:46.414477,sLon:8.108295,lLat:46.40933,lLon:8.136896,dur:"0h 20m",dk:"6.00",sl:"2.3",kmh:"18.2",hd:"1090",msa:"2154",ml:"1056",hm:"2155",hg:"159",ms:"-3.9",mst:"1.9",ge:"Advance XI 23",pa:"",be:"Wieder Südwind, Thermik schwach. Aprikosenwähe bei Xandi."},
"845":{d:"24.6.22",sz:"09:19:40",lz:"09:32:07",st:"Fiescheralp Heimat",la:"Fiesch",sLat:46.414477,sLon:8.108295,lLat:46.40933,lLon:8.136896,dur:"0h 12m",dk:"5.67",sl:"2.3",kmh:"27.3",hd:"1090",msa:"2150",ml:"1063",hm:"2150",hg:"2",ms:"-3.3",mst:"0.2",ge:"Advance Pi 23",pa:"",be:"Hike mit Peter von Fiesch über Firnegarte, Matt, Heimat und Fiescherstaffel zum Startplatz. Flug ruhig, vor dem Regen. Toll."},
"846":{d:"29.6.22",sz:"09:40:16",lz:"09:53:04",st:"Bellwald Mutti",la:"Fiesch",sLat:46.43749,sLon:8.15544,lLat:46.40933,lLon:8.136896,dur:"0h 13m",dk:"4.7",sl:"3.4",kmh:"22.0",hd:"723",msa:"1773",ml:"1056",hm:"1782",hg:"6",ms:"-3.5",mst:"0.5",ge:"Advance XI 23",pa:"",be:"Hike zum Mutti, treffe dort Peter. Ruhiger Flug zum LP Fiesch. Schwache Thermik über unterstem Älpli."},
"847":{d:"29.6.22",sz:"11:05:00",lz:"12:20:08",st:"Fiescheralp Galfera",la:"Fiesch",sLat:46.404695,sLon:8.096536,lLat:46.40933,lLon:8.136896,dur:"1h 15m",dk:"10.76",sl:"3.1",kmh:"8.6",hd:"1116",msa:"2181",ml:"1078",hm:"2182",hg:"863",ms:"-3.8",mst:"1.3",ge:"Advance XI 23",pa:"",be:"Wegen Wolken Galfera, schwache Thermik. Hangnah Flug Richtung Bettmeralp, sehr tief zurück zu Älpli, mühsames Hocharbeiten zu Lawinenverb."},
"848":{d:"2.7.22",sz:"10:57:59",lz:"12:40:24",st:"Fiescheralp Galfera",la:"Baschi",sLat:46.404695,sLon:8.096536,lLat:46.50073,lLon:8.29007,dur:"1h 42m",dk:"22.09",sl:"18.3",kmh:"12.9",hd:"828",msa:"2173",ml:"1371",hm:"2992",hg:"2631",ms:"-4.5",mst:"4.6",ge:"Advance XI 23",pa:"",be:"Späte Thermik, wieder erst am Älpli Anschluss, dann auf 3000, Richtung Goms gut, Landg. beim Baschi bei Sepp."},
"849":{d:"3.7.22",sz:"10:32:02",lz:"10:45:25",st:"Fiescherstafel/Hanspill",la:"Fiesch",sLat:46.41455,sLon:8.11334,lLat:46.40933,lLon:8.136896,dur:"0h 13m",dk:"4.80",sl:"1.9",kmh:"21.5",hd:"960",msa:"2010",ml:"1059",hm:"2011",hg:"6",ms:"-4.5",mst:"0.0",ge:"Advance XI 23",pa:"",be:"Viel Westwind, Quer, deshalb Abstieg Richtung Fiescherstaffel, hier besser. Turbulent oberhalb 1800, deshalb landen, problemlos."},
"850":{d:"5.7.22",sz:"12:38:28",lz:"12:52:03",st:"Fiescheralp Biplace",la:"Fiesch",sLat:46.411504,sLon:8.102926,lLat:46.40933,lLon:8.136896,dur:"0h 14m",dk:"7.04",sl:"2.6",kmh:"31.1",hd:"1139",msa:"2184",ml:"1080",hm:"2186",hg:"0",ms:"-4.0",mst:"0.1",ge:"Gradient BiGolden 3/39",pa:"Claris Mair-Noack",be:"Ruhiger Genussflug, Wolken am Start."},
"851":{d:"6.7.22",sz:"09:36:29",lz:"09:53:30",st:"Eggerhorn Süd",la:"Fiesch",sLat:46.382954,sLon:8.184927,lLat:46.40933,lLon:8.136896,dur:"0h 17m",dk:"6.62",sl:"4.7",kmh:"23.3",hd:"1402",msa:"2499",ml:"1064",hm:"2500",hg:"10",ms:"-2.2",mst:"0.2",ge:"Advance Pi 23",pa:"",be:"Hike mit Peter und Marc. Geht gut, Puls meist 115-125. Start nach Süd. Thermik über Nordsattel und Alp Frid."},
"852":{d:"7.7.22",sz:"10:52:01",lz:"11:19:51",st:"Fiescheralp Biplace",la:"Fiesch",sLat:46.411504,sLon:8.102926,lLat:46.40933,lLon:8.136896,dur:"0h 28m",dk:"7.68",sl:"2.6",kmh:"16.6",hd:"1139",msa:"2201",ml:"1087",hm:"2202",hg:"404",ms:"-3.5",mst:"1.3",ge:"Gradient BiGolden 3/39",pa:"Claris Mair-Noack",be:"Gute Thermik unter Wolken, aufkommender Talwind bei Nordlage, aber noch gut flieg- und landebar."},
"853":{d:"9.7.22",sz:"10:42:07",lz:"10:57:31",st:"Fiescheralp Heimat",la:"Fiesch",sLat:46.414477,sLon:8.108295,lLat:46.40933,lLon:8.136896,dur:"0h 15m",dk:"5.84",sl:"2.3",kmh:"22.8",hd:"1090",msa:"2154",ml:"1095",hm:"2162",hg:"11",ms:"-3.4",mst:"0.3",ge:"Advance XI 23",pa:"",be:"Ruhe vor dem Sturm bei Nordlage, wenig Thermik am Start, dann nichts mehr los.Gemütlich."},
"854":{d:"10.7.22",sz:"08:42:05",lz:"08:50:20",st:"Richinen",la:"Stei u Zer Tanna",sLat:46.440693,sLon:8.169194,lLat:46.41942,lLon:8.15582,dur:"0h 8m",dk:"3.09",sl:"2.6",kmh:"22.5",hd:"605",msa:"2055",ml:"1462",hm:"2056",hg:"0",ms:"-3.0",mst:"0.1",ge:"Advance Pi 23",pa:"",be:"Hike zum Mutti, weiter über Richinen Station zum Startplatz. Ldg. vor Chalet, etwas tief, aber gut."},
"855":{d:"17.7.22",sz:"09:53:27",lz:"10:05:43",st:"Gniepen Rossberg",la:"Goldau Vogelsang",sLat:47.081685,sLon:8.548137,lLat:47.051871,lLon:8.543638,dur:"0h 12m",dk:"4.16",sl:"3.3",kmh:"20.3",hd:"1075",msa:"1548",ml:"512",hm:"1550",hg:"2",ms:"-4.7",mst:"0.0",ge:"Advance Pi 23",pa:"",be:"Hike, frühmorgens schön im Schatten. Start schwierig bei wechselndem Wind, schliesslich nach S. Flug/Ldg. problemlos, Bise."},
"856":{d:"31.7.22",sz:"10:19:20",lz:"12:28:13",st:"Fiescheralp Heimat",la:"Fiesch",sLat:46.414477,sLon:8.108295,lLat:46.40933,lLon:8.136896,dur:"2h 9m",dk:"40.89",sl:"2.3",kmh:"19.0",hd:"1090",msa:"2148",ml:"1062",hm:"3040",hg:"4104",ms:"-3.5",mst:"3.0",ge:"Advance XI 23",pa:"",be:"Sidelhorn retour, ziemlich ruppig, ein Klapper. Am Sidelhorn Lee und Gegenwind, deshalb Umkehr."},
"857":{d:"1.8.22",sz:"10:15:01",lz:"12:35:29",st:"Fiescheralp Galfera",la:"Fiesch",sLat:46.404695,sLon:8.096536,lLat:46.40933,lLon:8.136896,dur:"2h 20m",dk:"42.60",sl:"3.1",kmh:"18.2",hd:"1116",msa:"2175",ml:"1062",hm:"3060",hg:"4033",ms:"-5.3",mst:"5.0",ge:"Advance XI 23",pa:"",be:"Nochmals Sidelhorn retour, diesmal ganz ans Horn, zuletzt ganz hinten am Grat. Etwas ruhiger."},
"858":{d:"13.8.22",sz:"13:19:21",lz:"14:17:05",st:"Chaiserstuel",la:"Wolfenschiessen",sLat:46.877156,sLon:8.467618,lLat:46.905095,lLon:8.398533,dur:"0h 58m",dk:"13.14",sl:"6.1",kmh:"13.7",hd:"1888",msa:"2388",ml:"523",hm:"2807",hg:"811",ms:"-2.5",mst:"2.9",ge:"Advance XI 23",pa:"",be:"Hike mit Stefan, weil Titlis zuviel Wind. Heiss. Gute Thermik, über Gipfel Bristen und Haldigrad zum Gipfel Buochserhorn, via Brändlen zur Ldg."},
"859":{d:"13.9.22",sz:"10:50:36",lz:"11:03:18",st:"Rigi Staffelhöhe",la:"Küssnacht",sLat:47.047772,sLon:8.460731,lLat:47.06739,lLon:8.435432,dur:"0h 13m",dk:"4.87",sl:"2.9",kmh:"23.0",hd:"1100",msa:"1561",ml:"449",hm:"1561",hg:"0",ms:"-2.6",mst:"0.0",ge:"Advance Pi 23",pa:"",be:"Morgendlicher Hike zur Staffelhöhe, gemütlich bei bestem Wetter. Rückenwindstart, aber gut. Ruhiger Flug."},
"860":{d:"16.10.22",sz:"10:33:03",lz:"10:42:12",st:"Schimberig",la:"Stilaub",sLat:46.940461,sLon:8.116162,lLat:46.949379,lLon:8.126218,dur:"0h 9m",dk:"3.77",sl:"1.3",kmh:"24.7",hd:"768",msa:"1810",ml:"1041",hm:"1811",hg:"3",ms:"-2.5",mst:"0.1",ge:"Advance Pi 23",pa:"",be:"Neuer Hike. Guter Weg, steil zum schönen Grat. Start nach NW bei leichten Seiten-SW-Wind. Rüber zu Rossweid, Risetestock, als Rekogn."},
"861":{d:"11.2.23",sz:"12:21:58",lz:"12:51:18",st:"Fiescheralp Heimat",la:"Fiesch",sLat:46.414477,sLon:8.108295,lLat:46.40933,lLon:8.136896,dur:"0h 29m",dk:"7.33",sl:"2.3",kmh:"15.0",hd:"1090",msa:"2165",ml:"1051",hm:"2327",hg:"242",ms:"-2.0",mst:"1.7",ge:"Advance XI 23",pa:"",be:"Erster Flug seit langem, leichter R‘wind. Ein Fehlstart. Dann sogar Startüberhöhung. Alles easy."},
"862":{d:"12.2.23",sz:"11:37:56",lz:"12:13:23",st:"Fiescheralp Heimat",la:"Fiesch",sLat:46.414477,sLon:8.108295,lLat:46.40933,lLon:8.136896,dur:"0h 35m",dk:"7.26",sl:"2.3",kmh:"12.3",hd:"1090",msa:"2155",ml:"1055",hm:"2332",hg:"249",ms:"-1.7",mst:"1.5",ge:"Advance XI 23",pa:"",be:"Gute Winterthermik, gut überhöht. Dann Absaufen am Galfera, zurück mit nur Nullschiebern."},
"863":{d:"12.2.23",sz:"13:03:50",lz:"14:08:16",st:"Fiescheralp Heimat",la:"Fiesch",sLat:46.414477,sLon:8.108295,lLat:46.40933,lLon:8.136896,dur:"1h 4m",dk:"7.16",sl:"2.3",kmh:"6.7",hd:"1090",msa:"2159",ml:"1055",hm:"2346",hg:"644",ms:"-3.7",mst:"0.8",ge:"Advance XI 23",pa:"",be:"Gut überhöht. Dann zu den Lawinenverbauuengen. Erster Stünder im Jahr."},
"864":{d:"19.3.23",sz:"11:10:06",lz:"11:19:56",st:"Bellwald Mutti",la:"Fiesch",sLat:46.43749,sLon:8.15544,lLat:46.40933,lLon:8.136896,dur:"0h 10m",dk:"3.88",sl:"3.4",kmh:"23.7",hd:"723",msa:"1782",ml:"1061",hm:"1782",hg:"41",ms:"-4.3",mst:"1.7",ge:"Advance Pi 23",pa:"",be:"Kurzer Hike zum Mutti, mit Peter. SO, feucht und labil. Start und Ldg. gut, Thermik über Stei."},
"865":{d:"8.4.23",sz:"12:10:34",lz:"12:41:20",st:"Fiescheralp Heimat",la:"Fiesch",sLat:46.414477,sLon:8.108295,lLat:46.40933,lLon:8.136896,dur:"0h 31m",dk:"8.91",sl:"2.3",kmh:"17.4",hd:"1090",msa:"2156",ml:"1068",hm:"2445",hg:"535",ms:"-2.6",mst:"1.9",ge:"Advance XI 23",pa:"",be:"Frühlingsthermik bei leichter Bise, ruppig. Ein mässiger Klapper, nur kurz instabil, dann wieder rasch gut. Auffrischender Talwind."},
"866":{d:"27.5.23",sz:"09:56:17",lz:"12:03:54",st:"Fiescheralp Heimat",la:"Fiesch",sLat:46.414477,sLon:8.108295,lLat:46.40933,lLon:8.136896,dur:"2h 8m",dk:"43.83",sl:"2.3",kmh:"20.6",hd:"1090",msa:"2150",ml:"1073",hm:"2995",hg:"3732",ms:"-2.7",mst:"3.3",ge:"Advance XI 23",pa:"",be:"Sidelhorn retour. Früh los, schon gute Thermik. Wolkenstrassen. Ein grösserer Klapper."},
"867":{d:"29.5.23",sz:"10:08:46",lz:"11:13:02",st:"Fiescheralp Heimat",la:"Fiesch",sLat:46.414477,sLon:8.108295,lLat:46.40933,lLon:8.136896,dur:"1h 4m",dk:"25.06",sl:"2.3",kmh:"23.4",hd:"1090",msa:"2159",ml:"1079",hm:"2782",hg:"1783",ms:"-4.0",mst:"3.9",ge:"Advance XI 23",pa:"",be:"Riederfurka retour. Ruppig."},
"868":{d:"11.6.23",sz:"11:36:37",lz:"12:07:48",st:"Fiescheralp Biplace",la:"Fiesch",sLat:46.411504,sLon:8.102926,lLat:46.40933,lLon:8.136896,dur:"0h 31m",dk:"7.95",sl:"2.6",kmh:"15.3",hd:"1139",msa:"2203",ml:"1110",hm:"2524",hg:"547",ms:"-4.0",mst:"1.9",ge:"Gradient BiGolden 3/39",pa:"Alena Mair-Noack",be:"Gute Thermik gleich nach dem Start, bei leicht gewittriger Stimmung. Ldg. zu kurz und dadurch zu flach. Problemlos."},
"869":{d:"14.6.23",sz:"11:10:05",lz:"11:48:05",st:"Fiescheralp Heimat",la:"Fiesch",sLat:46.414477,sLon:8.108295,lLat:46.40933,lLon:8.136896,dur:"0h 38m",dk:"9.82",sl:"2.3",kmh:"15.5",hd:"1090",msa:"2161",ml:"1085",hm:"2415",hg:"798",ms:"-2.4",mst:"2.8",ge:"Gradient BiGolden 3/39",pa:"Alena Mair-Noack",be:"Start an der Heimat, gute Thermik bis unter Wolken, dann Chäserstatt retour, 3 XAlps-Piloten landen."},
"870":{d:"15.6.23",sz:"10:56:48",lz:"11:13:45",st:"Eggerhorn West",la:"Fiesch",sLat:46.383454,sLon:8.18275,lLat:46.40933,lLon:8.136896,dur:"0h 17m",dk:"6.7",sl:"4.5",kmh:"23.7",hd:"1436",msa:"2499",ml:"1077",hm:"2499",hg:"2",ms:"-1.9",mst:"0.0",ge:"Gradient BiGolden 3/39",pa:"Alena Mair-Noack",be:"Hike & Fly mit Alena auf das Eggerhorn von Binn, oben etwas Schnee. Start NNW, leichter Seitenwind aus N. Problemlos."},
"871":{d:"17.6.23",sz:"09:46:39",lz:"11:29:56",st:"Fiescheralp Heimat",la:"Fiesch",sLat:46.414477,sLon:8.108295,lLat:46.40933,lLon:8.136896,dur:"1h 43m",dk:"43.37",sl:"2.3",kmh:"25.2",hd:"1090",msa:"2151",ml:"1058",hm:"2944",hg:"3211",ms:"-2.8",mst:"3.2",ge:"Advance XI 23",pa:"",be:"Schneller Flug zum Sidelhorn, mit Stefan, ruppig."},
"872":{d:"24.6.23",sz:"10:11:24",lz:"11:32:43",st:"Fiescheralp Heimat",la:"Fiesch",sLat:46.414477,sLon:8.108295,lLat:46.40933,lLon:8.136896,dur:"1h 21m",dk:"6.67",sl:"2.3",kmh:"4.9",hd:"1090",msa:"2160",ml:"1074",hm:"2163",hg:"891",ms:"-1.8",mst:"1.5",ge:"Advance XI 23",pa:"",be:"Recht stabil, Nordlage, gute Thermik über Älpli."},
"873":{d:"12.8.23",sz:"10:50:17",lz:"11:55:04",st:"Fiescheralp Heimat",la:"Fiesch",sLat:46.414477,sLon:8.108295,lLat:46.40933,lLon:8.136896,dur:"1h 5m",dk:"15.6",sl:"2.3",kmh:"14.4",hd:"1090",msa:"2151",ml:"1060",hm:"2742",hg:"1676",ms:"-2.6",mst:"2.8",ge:"Advance XI 23",pa:"",be:"Gute Thermik, Aletschgletscher gesehen, rüber zu Richinen und ein Tal weiter, dann umgekehrt, weil wir ja noch biken wollten."},
"874":{d:"13.8.23",sz:"10:46:58",lz:"11:26:38",st:"Fiescheralp Biplace",la:"Fiesch",sLat:46.411504,sLon:8.102926,lLat:46.40933,lLon:8.136896,dur:"0h 40m",dk:"9.86",sl:"2.6",kmh:"14.9",hd:"1139",msa:"2152",ml:"1016",hm:"2600",hg:"988",ms:"-2.5",mst:"1.9",ge:"Gradient BiGolden 3/39",pa:"Johannes Krause",be:"Mit Johannes, gute Thermik bis zur Sicht auf Aletschgletscher."},
"875":{d:"13.8.23",sz:"12:31:51",lz:"12:48:32",st:"Fiescheralp Biplace",la:"Fiesch",sLat:46.411504,sLon:8.102926,lLat:46.40933,lLon:8.136896,dur:"0h 17m",dk:"6.19",sl:"2.6",kmh:"22.3",hd:"1139",msa:"2152",ml:"1018",hm:"2155",hg:"125",ms:"-2.6",mst:"1.5",ge:"Gradient BiGolden 3/39",pa:"Heike Krause-Meier",be:"Mit Heike, ein Fehlstart bei Seitenwind, dann gut. Thermisch, nicht gross genutzt."},
"876":{d:"20.8.23",sz:"11:59:53",lz:"16:55:21",st:"Fiescheralp Heimat",la:"Fiesch",sLat:46.414477,sLon:8.108295,lLat:46.40933,lLon:8.136896,dur:"4h 55m",dk:"115.96",sl:"2.3",kmh:"23.5",hd:"1090",msa:"2133",ml:"1087",hm:"3986",hg:"12333",ms:"-3.7",mst:"4.3",ge:"Advance XI 23",pa:"",be:"Dreieck Sidelhorn-Torrenthorn-Gibidum. Sensationell. Erster 100er, bei super Bedingungen, hoch über Fiescher- und Aletschgletscher, 2000m über Visp"},
"877":{d:"2.9.23",sz:"17:06:07",lz:"18:16:53",st:"Monte Avena",la:"Feltre",sLat:46.02937,sLon:11.82627,lLat:46.03013,lLon:11.8798,dur:"1h 11m",dk:"8.35",sl:"4.1",kmh:"7.1",hd:"1035",msa:"1412",ml:"359",hm:"1647",hg:"1567",ms:"-2.1",mst:"2.1",ge:"Advance XI 23",pa:"",be:"Dolomiten 1: Abendthermik, Soaring, mit Wolken."},
"878":{d:"3.9.23",sz:"13:03:05",lz:"14:01:30",st:"Monte Avena",la:"Feltre",sLat:46.02937,sLon:11.82627,lLat:46.03013,lLon:11.8798,dur:"0h 58m",dk:"6.95",sl:"4.1",kmh:"7.1",hd:"1035",msa:"1413",ml:"368",hm:"1413",hg:"946",ms:"-2.7",mst:"2.5",ge:"Advance XI 23",pa:"",be:"Dolomiten 2: Soaring bei schwachen Bedingungen."},
"879":{d:"3.9.23",sz:"15:39:25",lz:"16:06:43",st:"Monte Avena",la:"Feltre",sLat:46.02937,sLon:11.82627,lLat:46.03013,lLon:11.8798,dur:"0h 27m",dk:"6.76",sl:"4.1",kmh:"14.9",hd:"1035",msa:"1395",ml:"383",hm:"1395",hg:"133",ms:"-1.3",mst:"0.8",ge:"Advance XI 23",pa:"",be:"Dolomiten 3: Gemütliches Soaren, knapp zu halten."},
"880":{d:"3.9.23",sz:"17:59:24",lz:"18:17:23",st:"Monte Avena Ost",la:"Feltre",sLat:46.03452,sLon:11.83038,lLat:46.03013,lLon:11.8798,dur:"0h 18m",dk:"6.54",sl:"3.8",kmh:"21.8",hd:"993",msa:"1349",ml:"361",hm:"1349",hg:"7",ms:"-1.6",mst:"0.2",ge:"Advance XI 23",pa:"",be:"Dolomiten 4: Abendlicher Flug, Start knapp bei Null-Wind am Oststartplatz"},
"881":{d:"4.9.23",sz:"13:26:31",lz:"14:20:47",st:"Pieve d‘Alpago",la:"Farra d‘Alpago",sLat:46.19164,sLon:12.35272,lLat:46.11837,lLon:12.35273,dur:"0h 54m",dk:"14.71",sl:"8.1",kmh:"16.3",hd:"1102",msa:"1479",ml:"393",hm:"1547",hg:"1092",ms:"-2.0",mst:"2.1",ge:"Advance XI 23",pa:"",be:"Dolomiten 5: Zuerst gute, ruppige Thermik am Hang, dann Strecke über Ebene zum See. Starkwindldg., weggeschleift nach der Ldg!! Technik üben."},
"882":{d:"5.9.23",sz:"12:22:17",lz:"13:11:06",st:"Corvara Boé Vallon",la:"Corvara",sLat:46.5222,sLon:11.84987,lLat:46.55038,lLon:11.86997,dur:"0h 49m",dk:"8.05",sl:"3.5",kmh:"9.9",hd:"983",msa:"2534",ml:"1631",hm:"2535",hg:"1153",ms:"-2.4",mst:"2.0",ge:"Advance XI 23",pa:"",be:"Dolomiten 6: Etwas planlos, immer wieder gute Thermik. Low safe über Kante Ütia Crëp de Munt, wieder guter Anschluss auf 2400."},
"883":{d:"5.9.23",sz:"15:13:59",lz:"15:42:39",st:"Corvara Boé Vallon",la:"Corvara",sLat:46.5222,sLon:11.84987,lLat:46.55038,lLon:11.86997,dur:"0h 29m",dk:"10.33",sl:"3.5",kmh:"21.6",hd:"983",msa:"2514",ml:"1549",hm:"2712",hg:"434",ms:"-2.7",mst:"2.4",ge:"Advance XI 23",pa:"",be:"Dolomiten 7: Gute Startüberhöhung, dann über Sella-Vorbau zum Grödener Pass und zurück."},
"884":{d:"6.9.23",sz:"11:51:00",lz:"12:25:33",st:"Corvara Boé Vallon",la:"Corvara",sLat:46.5222,sLon:11.84987,lLat:46.55038,lLon:11.86997,dur:"0h 35m",dk:"8.39",sl:"3.5",kmh:"14.6",hd:"983",msa:"2524",ml:"1554",hm:"2525",hg:"521",ms:"-2.6",mst:"1.2",ge:"Advance XI 23",pa:"",be:"Dolomiten 8: Erster Flug, schon ordentlich Thermik."},
"885":{d:"6.9.23",sz:"14:33:54",lz:"14:43:39",st:"Corvara Boé Vallon",la:"Passo Pordoi Ost",sLat:46.5222,sLon:11.84987,lLat:46.48508,lLon:11.82707,dur:"0h 10m",dk:"5.11",sl:"4.5",kmh:"31.4",hd:"456",msa:"2516",ml:"2126",hm:"2516",hg:"40",ms:"-1.6",mst:"0.0",ge:"Advance XI 23",pa:"",be:"Dolomiten 9: Missglückter Flug zurück zum Pordoi, kein Steigen. Fussmarsch 20‘."},
"886":{d:"7.9.23",sz:"11:18:25",lz:"11:31:24",st:"Belvedere",la:"Campitello di Fassa",sLat:46.47577,sLon:11.80693,lLat:46.47589,lLon:11.74946,dur:"0h 13m",dk:"5.47",sl:"4.4",kmh:"25.3",hd:"931",msa:"2347",ml:"1427",hm:"2347",hg:"40",ms:"-3.0",mst:"0.0",ge:"Advance XI 23",pa:"",be:"Dolomiten 10: Hike 20‘ zum Belvedere, dann Start nach SE, Gleitflug zum Landeplatz."},
"887":{d:"7.9.23",sz:"13:04:24",lz:"16:29:11",st:"Col Rodella",la:"Campitello di Fassa",sLat:46.49729,sLon:11.75402,lLat:46.47589,lLon:11.74946,dur:"3h 25m",dk:"40.29",sl:"2.4",kmh:"11.8",hd:"939",msa:"2373",ml:"1409",hm:"3507",hg:"6219",ms:"-3.1",mst:"3.0",ge:"Advance XI 23",pa:"",be:"Dolomiten 11: Fassa-Runde: Langkofel-Sella-Marmolada-Rosengarten-Campitello. Einfach nur toll."},
"888":{d:"8.9.23",sz:"11:23:56",lz:"11:39:20",st:"Belvedere",la:"Campitello di Fassa",sLat:46.47577,sLon:11.80693,lLat:46.47589,lLon:11.74946,dur:"0h 15m",dk:"5.37",sl:"4.4",kmh:"20.9",hd:"931",msa:"2347",ml:"1420",hm:"2349",hg:"48",ms:"-1.5",mst:"0.0",ge:"Advance XI 23",pa:"",be:"Dolomiten 12: Morgentlicher Hike, Abgleiter."},
"889":{d:"8.9.23",sz:"13:49:35",lz:"16:20:44",st:"Col Rodella",la:"Passo Pordoi",sLat:46.49729,sLon:11.75402,lLat:46.48872,lLon:11.81277,dur:"2h 31m",dk:"37.96",sl:"4.6",kmh:"15.1",hd:"80",msa:"2363",ml:"2264",hm:"3451",hg:"5126",ms:"-2.5",mst:"3.1",ge:"Advance XI 23",pa:"",be:"Dolomiten 13: Fassa-Runde Teil 2, viel schneller, phänomenal, toplanding auf dem Pordoi-Pass."},
"890":{d:"9.9.23",sz:"11:01:20",lz:"11:19:22",st:"Seceda",la:"Clubhaus LP St. Ulrich",sLat:46.60008,sLon:11.72673,lLat:46.56834,lLon:11.68308,dur:"0h 18m",dk:"5.99",sl:"4.9",kmh:"19.9",hd:"1257",msa:"2498",ml:"1247",hm:"2501",hg:"20",ms:"-1.7",mst:"0.0",ge:"Advance XI 23",pa:"",be:"Dolomiten 14: Genuss-Abgleiter. Probleme beim „Einsteigen“, zudem Sack offen."},
"891":{d:"7.10.23",sz:"12:32:22",lz:"12:55:36",st:"Wängihorn",la:"Schattdorf",sLat:46.8527,sLon:8.71569,lLat:46.867042,lLon:8.655784,dur:"0h 23m",dk:"6.04",sl:"4.8",kmh:"15.6",hd:"1622",msa:"2107",ml:"486",hm:"2107",hg:"30",ms:"-2.2",mst:"0.0",ge:"Advance Pi 23",pa:"",be:"Hike & Fly Advance Pi, sehr schöner Anstieg 2:30, toller Gipfel, guter kurzer Starthang."},
"892":{d:"22.10.23",sz:"10:10:06",lz:"10:20:23",st:"Bellwald Mutti",la:"Fiesch",sLat:46.43749,sLon:8.15544,lLat:46.40933,lLon:8.136896,dur:"0h 10m",dk:"4.33",sl:"3.4",kmh:"25.3",hd:"723",msa:"1777",ml:"1057",hm:"1777",hg:"3",ms:"-1.9",mst:"0.0",ge:"Advance XI 23",pa:"",be:"Hike & Fly Advance XI, nach Mutti, dort 30‘ Warten, bis Bergwind abnimmt."},
"893":{d:"22.10.23",sz:"11:43:27",lz:"11:54:15",st:"Fiescheralp Salzgäb",la:"Bellwald ob LFÜB",sLat:46.42798,sLon:8.115787,lLat:46.423735,lLon:8.162345,dur:"0h 11m",dk:"4.64",sl:"3.6",kmh:"25.8",hd:"690",msa:"2265",ml:"1548",hm:"2265",hg:"10",ms:"-1.9",mst:"0.0",ge:"Advance XI 23",pa:"",be:"Hike & Fly Advance XI, Hike nach Salzgäb, gemütlicher Flug nach Bellwald, Hang-Ldg. beim Stall problemlos."},
"894":{d:"12.2.24",sz:"11:33:50",lz:"11:55:15",st:"Steibenkreuz Oben Skipiste",la:"Fiesch",sLat:46.45073,sLon:8.16228,lLat:46.40933,lLon:8.136896,dur:"0h 21m",dk:"7.09",sl:"5.0",kmh:"19.9",hd:"1460",msa:"2516",ml:"1062",hm:"2516",hg:"105",ms:"-3.1",mst:"1.2",ge:"Advance Pi 23",pa:"",be:"Strapless. Mit Sessellift zur Bergstation Furggulti, Start nach ca. 200m neben Piste links im steilerem Gelände. Kalt, Thermik über den Älpli."},
"895":{d:"12.2.24",sz:"13:10:20",lz:"13:20:49",st:"Fiescheralp Heimat",la:"Stei u Zer Tanna",sLat:46.414477,sLon:8.108295,lLat:46.41913,lLon:8.15547,dur:"0h 10m",dk:"4.18",sl:"3.7",kmh:"23.9",hd:"673",msa:"2162",ml:"1461",hm:"2162",hg:"66",ms:"-4.0",mst:"1.0",ge:"Advance Pi 23",pa:"",be:"Strapless. Start problemlos, leicht seitlich. Ldg. unterhalb Zer Tanne, eher tief…"},
"896":{d:"7.3.24",sz:"14:23:30",lz:"14:56:18",st:"Fiescheralp Heimat",la:"Fiesch",sLat:46.414477,sLon:8.108295,lLat:46.40933,lLon:8.136896,dur:"0h 33m",dk:"6.79",sl:"2.3",kmh:"12.4",hd:"1090",msa:"2158",ml:"1059",hm:"2158",hg:"345",ms:"-1.8",mst:"0.9",ge:"Advance XI 23",pa:"",be:"Ruhiger Flug nach dem Skifahren, ganz nette Thermik."},
"897":{d:"14.4.24",sz:"11:09:42",lz:"11:27:25",st:"Rotenflue W Sommer",la:"Rickenbach",sLat:47.018594,sLon:8.701526,lLat:47.012549,lLon:8.67004,dur:"0h 18m",dk:"4.5",sl:"2.5",kmh:"15.2",hd:"960",msa:"1557",ml:"595",hm:"1557",hg:"68",ms:"-2.8",mst:"1.9",ge:"Advance XI 23",pa:"",be:"Strapless. Hike, wunderschönes Wetter, und heiss für Mitte April!"},
"898":{d:"4.5.24",sz:"16:16:22",lz:"16:31:59",st:"Zugerberg",la:"Zug",sLat:47.14813,sLon:8.535748,lLat:47.150094,lLon:8.507689,dur:"0h 16m",dk:"3.58",sl:"2.1",kmh:"13.8",hd:"475",msa:"944",ml:"463",hm:"944",hg:"121",ms:"-1.6",mst:"0.6",ge:"Advance XI 23",pa:"",be:"Thermik schon knapp zu schwach, um oben zu bleiben. Mist. Ich hasse den Zugerberg, war wohl zu spät…"},
"899":{d:"9.5.24",sz:"10:57:24",lz:"11:34:36",st:"Haldi",la:"Schattdorf",sLat:46.86234,sLon:8.673187,lLat:46.867042,lLon:8.655784,dur:"0h 37m",dk:"4.02",sl:"1.4",kmh:"6.5",hd:"615",msa:"1054",ml:"434",hm:"1054",hg:"630",ms:"-2.0",mst:"1.4",ge:"Advance XI 23",pa:"",be:"Bisendynamik am Prallhang links, mässig, kann aber ganz gut halten."},
"900":{d:"9.5.24",sz:"14:43:35",lz:"15:49:11",st:"Humel",la:"Sportplatz Kürschenen",sLat:47.09823,sLon:8.77251,lLat:47.10704,lLon:8.77914,dur:"1h 6m",dk:"3.3",sl:"1.1",kmh:"3.0",hd:"443",msa:"1333",ml:"892",hm:"1425",hg:"1061",ms:"-1.7",mst:"1.2",ge:"Advance XI 23",pa:"",be:"Hike zum oberen Startplatz. Schöne Bisendynamik, viele Schirme."},
"901":{d:"11.5.24",sz:"10:09:17",lz:"10:53:58",st:"Riederalp",la:"Fiesch",sLat:46.37725,sLon:8.03082,lLat:46.40933,lLon:8.136896,dur:"0h 45m",dk:"15.7",sl:"8.9",kmh:"21.1",hd:"851",msa:"1895",ml:"1045",hm:"2866",hg:"1421",ms:"-2.8",mst:"3.1",ge:"Advance XI 23",pa:"",be:"Gute Thermik bereits am Start, bis in die Wolken, auch über Chäserstatt…"},
"902":{d:"11.5.24",sz:"12:52:09",lz:"13:12:16",st:"Fiescheralp Heimat",la:"Fieschertal Flyingcenter",sLat:46.414477,sLon:8.108295,lLat:46.421062,lLon:8.145385,dur:"0h 20m",dk:"5.18",sl:"2.9",kmh:"15.4",hd:"1055",msa:"2147",ml:"1079",hm:"2641",hg:"593",ms:"-3.7",mst:"3.6",ge:"Gradient BiGolden 3/39",pa:"Claris Mair-Noack",be:"Ein Fehlstart bei weichem Schnee und Rückenwind. Dann ruppig, bis 4m/s Steigen, seitl. Klapper. Bei Hansi etwas kurz."},
"903":{d:"26.5.24",sz:"10:31:33",lz:"10:55:35",st:"Rotenflue SW Sommer",la:"Rickenbach",sLat:47.017641,sLon:8.700727,lLat:47.012549,lLon:8.67004,dur:"0h 24m",dk:"8.42",sl:"2.4",kmh:"21.0",hd:"928",msa:"1514",ml:"594",hm:"1751",hg:"367",ms:"-2.1",mst:"2.0",ge:"Gradient BiGolden 3/39",pa:"Claris Mair-Noack",be:"Gute Thermik an den Südkanten, Strecke zur Ibergeregg, dann tief zurück."},
"904":{d:"26.5.24",sz:"11:51:13",lz:"12:07:01",st:"Rotenflue SSW Winter",la:"Rickenbach",sLat:47.01819,sLon:8.701503,lLat:47.012549,lLon:8.67004,dur:"0h 16m",dk:"4.78",sl:"2.5",kmh:"18.2",hd:"959",msa:"1543",ml:"595",hm:"1557",hg:"220",ms:"-2.6",mst:"1.9",ge:"Gradient BiGolden 3/39",pa:"Claris Mair-Noack",be:"Ruppige Thermik Süd."},
"905":{d:"26.5.24",sz:"13:11:40",lz:"13:38:38",st:"Rotenflue SSW Winter",la:"Rickenbach",sLat:47.01819,sLon:8.701503,lLat:47.012549,lLon:8.67004,dur:"0h 27m",dk:"6.45",sl:"2.5",kmh:"14.4",hd:"959",msa:"1545",ml:"602",hm:"1545",hg:"222",ms:"-2.2",mst:"1.2",ge:"Gradient BiGolden 3/39",pa:"Claris Mair-Noack",be:"Am Westfuss des Mythen, knapp."},
"906":{d:"19.6.24",sz:"19:19:14",lz:"19:38:28",st:"Sopelana Golfplatz",la:"Sopelana Golfplatz",sLat:43.37801,sLon:-3.01914,lLat:43.37801,lLon:-3.01914,dur:"0h 19m",dk:"3.23",sl:"0.0",kmh:"10.1",hd:"0",msa:"12",ml:"6",hm:"90",hg:"254",ms:"-0.7",mst:"0.9",ge:"Advance XI 23",pa:"",be:"Gemütliches Abendsoaring, bis rüber nach Sopelana und problemlos retour."},
"907":{d:"1.7.24",sz:"19:39:29",lz:"19:52:51",st:"Linhares",la:"Linhares",sLat:40.53257,sLon:-7.44585,lLat:40.55009,lLon:-7.45644,dur:"0h 13m",dk:"4.09",sl:"2.1",kmh:"18.4",hd:"471",msa:"1150",ml:"674",hm:"1150",hg:"28",ms:"-1.6",mst:"0.2",ge:"Advance XI 23",pa:"",be:"Schöner Hike, grosse Hitze, tolle Gegend. Start mit gutem Wind einfach, Flug wundervoll mit noch Abendthermik."},
"908":{d:"3.7.24",sz:"13:07:08",lz:"13:26:26",st:"Torimbia",la:"Torimbia",sLat:43.4404,sLon:-4.8495,lLat:43.4404,lLon:-4.8495,dur:"0h 19m",dk:"2.12",sl:"0.0",kmh:"6.6",hd:"0",msa:"68",ml:"69",hm:"106",hg:"195",ms:"-0.3",mst:"0.5",ge:"Advance XI 23",pa:"",be:"Cooles Küstensoaring, toller Start-, Landeplatz, Bea macht Videos und Fotos, mehrfach reinlanden und wieder starten."},
"909":{d:"3.7.24",sz:"18:14:23",lz:"18:48:40",st:"Sopelana Golfplatz",la:"Sopelana Golfplatz",sLat:43.37801,sLon:-3.01914,lLat:43.37801,lLon:-3.01914,dur:"0h 34m",dk:"4.49",sl:"0.0",kmh:"7.9",hd:"0",msa:"56",ml:"56",hm:"155",hg:"504",ms:"-1.0",mst:"1.4",ge:"Advance XI 23",pa:"",be:"Küstensoaring am Abend, ganze Strecke bis Parkplatz Sopelana und felsige Caps beim Golfplatz, super. Start und Landung etwas hektisch."},
"910":{d:"4.7.24",sz:"17:47:35",lz:"18:18:39",st:"Sopelana 1",la:"Sopelana 1",sLat:43.38078,sLon:-3.0107,lLat:43.38078,lLon:-3.0107,dur:"0h 31m",dk:"2.07",sl:"0.0",kmh:"4.0",hd:"0",msa:"77",ml:"77",hm:"178",hg:"347",ms:"-3.4",mst:"2.4",ge:"Advance XI 23",pa:"",be:"Tolles Küstensoaring, seitl. Wind von NE, kam fast nicht mehr runter, alles aber Genuss."},
"911":{d:"27.7.24",sz:"10:31:14",lz:"11:45:58",st:"Fiescheralp Heimat",la:"Kapelle Ritzingen",sLat:46.414477,sLon:8.108295,lLat:46.460795,lLon:8.227707,dur:"1h 15m",dk:"15.37",sl:"10.5",kmh:"12.3",hd:"789",msa:"2152",ml:"1363",hm:"2664",hg:"1805",ms:"-2.0",mst:"2.6",ge:"Advance XI 23",pa:"",be:"Mässig, ging nicht so recht hoch, bei viel W-Wind bis ca. Kretenhöhe. Landung bei Peter an der Kirche, Sepp beim Baschi."},
"912":{d:"11.8.24",sz:"11:48:40",lz:"13:54:26",st:"Fiescheralp Heimat",la:"Fiesch",sLat:46.414477,sLon:8.108295,lLat:46.40933,lLon:8.136896,dur:"2h 6m",dk:"45.82",sl:"2.3",kmh:"21.9",hd:"1090",msa:"2147",ml:"1064",hm:"3263",hg:"4435",ms:"-3.0",mst:"3.2",ge:"Advance XI 23",pa:"",be:"Sidelhorn retour, Gipfel Eggishorn und wieder mal Sidelhorn direkt überflogen. Ziemlich sportlich, ein Seitenklapper. Aber noch ok. Zügig Talwind."},
"913":{d:"12.8.24",sz:"10:40:14",lz:"12:55:42",st:"Fiescheralp Heimat",la:"Fiesch",sLat:46.414477,sLon:8.108295,lLat:46.40933,lLon:8.136896,dur:"2h 15m",dk:"45.84",sl:"2.3",kmh:"20.3",hd:"1090",msa:"2138",ml:"1056",hm:"3191",hg:"4897",ms:"-4.0",mst:"4.4",ge:"Advance XI 23",pa:"",be:"Sidelhorn retour, wieder sportlich, war immer schön hoch, nur einmal nach der Umkehr kurz tief. Mit Sepp."},
"914":{d:"13.8.24",sz:"11:01:36",lz:"12:14:43",st:"Fiescheralp Galfera",la:"Fiesch",sLat:46.404695,sLon:8.096536,lLat:46.40933,lLon:8.136896,dur:"1h 13m",dk:"21.24",sl:"3.1",kmh:"17.4",hd:"1116",msa:"2163",ml:"1055",hm:"3195",hg:"2216",ms:"-2.6",mst:"3.4",ge:"Advance XI 23",pa:"",be:"Hoch über Eggishorn und Aletsch, dann Riederfurka retour."},
"915":{d:"16.8.24",sz:"10:39:24",lz:"11:47:26",st:"Fiescheralp Heimat",la:"Baschi",sLat:46.414477,sLon:8.108295,lLat:46.50073,lLon:8.29007,dur:"1h 8m",dk:"20.73",sl:"16.9",kmh:"18.3",hd:"802",msa:"2147",ml:"1344",hm:"3055",hg:"1973",ms:"-4.2",mst:"4",ge:"Advance XI 23",pa:"",be:"Wollte eigentlich ganz nach hinten, aber relativ viel W-Wind, turbulent, ging nicht so recht hoch. Mit Sepp zmittag beim Baschi."},
"916":{d:"17.8.24",sz:"10:14:37",lz:"10:25:25",st:"Fiescheralp Heimat",la:"Fiesch",sLat:46.414477,sLon:8.108295,lLat:46.40933,lLon:8.136896,dur:"0h 11m",dk:"2.87",sl:"2.3",kmh:"15.9",hd:"1090",msa:"2148",ml:"1057",hm:"2148",hg:"3",ms:"-4.0",mst:"0.3",ge:"Advance Pi 23",pa:"",be:"Eigentlich Tandem mit Alena, aber falscher Rucksack, deshalb rasch mit dem Pi runter und wieder rauf."},
"917":{d:"17.8.24",sz:"11:04:36",lz:"11:19:01",st:"Fiescheralp Heimat",la:"Fiesch",sLat:46.414477,sLon:8.108295,lLat:46.40933,lLon:8.136896,dur:"0h 14m",dk:"6.44",sl:"2.3",kmh:"26.8",hd:"1090",msa:"2156",ml:"1063",hm:"2156",hg:"0",ms:"-1.6",mst:"0.0",ge:"Gradient BiGolden 3/39",pa:"Alena Mair-Noack",be:"Ruhig, da wolkig. Wenig ruhiger Aufwind. Schöne Landung bei Talwind."},
"918":{d:"20.8.24",sz:"12:43:22",lz:"14:40:42",st:"Fiescheralp Galfera",la:"Baschi",sLat:46.404695,sLon:8.096536,lLat:46.50073,lLon:8.29007,dur:"1h 57m",dk:"30.52",sl:"18.3",kmh:"15.6",hd:"828",msa:"2166",ml:"1344",hm:"2988",hg:"3174",ms:"-2.4",mst:"2.2",ge:"Advance XI 23",pa:"",be:"Basis tief, ziemlich ruppig, schwierig, und rel. viel SW-Wind. Aber Sidelhorn erreicht! Ldg. beim Baschi"},
"919":{d:"21.8.24",sz:"11:51:45",lz:"12:00:38",st:"Fiescheralp Salzgäb",la:"Bellwald ob LFÜB",sLat:46.42798,sLon:8.115787,lLat:46.423735,lLon:8.162345,dur:"0h 9m",dk:"4.15",sl:"3.6",kmh:"28.0",hd:"690",msa:"2264",ml:"1548",hm:"2281",hg:"64",ms:"-2.5",mst:"1.2",ge:"Advance Pi 23",pa:"",be:"Rückflug nach Bellwald nach langem Hike Bellw.-Burghütte-Märjelen-Salzgäb. Super. Viel Nebel und Wolken, musste beim Start etwas warten."},
"920":{d:"23.8.24",sz:"12:07:02",lz:"14:40:59",st:"Fiescheralp Heimat",la:"Niederwald Gallerie",sLat:46.414477,sLon:8.108295,lLat:46.436737,lLon:8.193643,dur:"2h 34m",dk:"39.24",sl:"7.0",kmh:"15.3",hd:"893",msa:"2152",ml:"1262",hm:"3204",hg:"5598",ms:"-3.7",mst:"3.6",ge:"Advance XI 23",pa:"",be:"Sidelhorn (fast) retour, viel Südwestwind, ruppig, kam auch fast wieder heim, problemlose Landung auf der Galerie. Starker Talwind."},
"921":{d:"29.8.24",sz:"11:50:30",lz:"15:48:52",st:"Fiescheralp Galfera",la:"Voder Moss Niedergesteln",sLat:46.404695,sLon:8.096536,lLat:46.312115,lLon:7.772762,dur:"3h 58m",dk:"86.67",sl:"26.9",kmh:"21.8",hd:"1541",msa:"2165",ml:"630",hm:"4082",hg:"9033",ms:"-3.8",mst:"4.3",ge:"Advance XI 23",pa:"",be:"Planung: Sidelhorn-Finsteraarhorn-Interlaken. Wolken, deshalb spontan Route über den Aletschgletscher Richtung Lötschental, danach abgesoffen."},
"922":{d:"18.9.24",sz:"12:53:36",lz:"13:05:59",st:"Azinha",la:"Vale de Armoreira",sLat:40.43085,sLon:-7.45549,lLat:40.40274,lLon:-7.4426,dur:"0h 12m",dk:"4.02",sl:"3.3",kmh:"19.5",hd:"712",msa:"1244",ml:"540",hm:"1244",hg:"524",ms:"-1.9",mst:"1.7",ge:"Advance XI 23",pa:"",be:"Portugal 1: Viel Wind. Knopf in innerer oberster Bremsleine, deshalb Vorsicht und nicht eingedreht."},
"923":{d:"18.9.24",sz:"14:11:37",lz:"14:28:34",st:"Vale Amoreira SE",la:"Vale de Armoreira",sLat:40.40348,sLon:-7.45443,lLat:40.40274,lLon:-7.4426,dur:"0h 17m",dk:"2.23",sl:"1.0",kmh:"7.9",hd:"313",msa:"846",ml:"528",hm:"1024",hg:"477",ms:"-5.1",mst:"3.2",ge:"Advance XI 23",pa:"",be:"Portugal 2: Immer noch viel Wind. Guter Schlauch über Tal. Unruhig, nicht lustig."},
"924":{d:"18.9.24",sz:"17:40:19",lz:"17:46:07",st:"Vale Amoreira SE",la:"Vale de Armoreira",sLat:40.40348,sLon:-7.45443,lLat:40.40274,lLon:-7.4426,dur:"0h 6m",dk:"1.75",sl:"1.0",kmh:"18.1",hd:"313",msa:"824",ml:"529",hm:"827",hg:"33",ms:"-3.9",mst:"1.4",ge:"Advance XI 23",pa:"",be:"Portugal 3: Lange auf gutes Windfenster gewartet, dann ruhiger „Fundowner“, kaum Thermik."},
"925":{d:"18.9.24",sz:"19:00:15",lz:"19:36:10",st:"Azinha",la:"Vale de Armoreira",sLat:40.43085,sLon:-7.45549,lLat:40.40274,lLon:-7.4426,dur:"0h 36m",dk:"5.90",sl:"3.3",kmh:"9.9",hd:"712",msa:"1243",ml:"528",hm:"1308",hg:"258",ms:"-1.9",mst:"1.6",ge:"Advance XI 23",pa:"",be:"Portugal 4: Tolles Soaring in den Sonnenuntergang, dann Abgleiter zum LP. Verdrehter Karabiner."},
"926":{d:"19.9.24",sz:"14:20:32",lz:"14:59:04",st:"Larouco West",la:"Larouco Südwest LP",sLat:41.88482,sLon:-7.72576,lLat:41.87596,lLon:-7.74133,dur:"0h 39m",dk:"4.23",sl:"1.6",kmh:"6.6",hd:"260",msa:"1488",ml:"1226",hm:"1622",hg:"692",ms:"-3.0",mst:"2.1",ge:"Advance XI 23",pa:"",be:"Portugal 5: Soaring bei Südwind, reichlich Wind, in die Ebene zu Vorbau, knapp zum LP"},
"927":{d:"19.9.24",sz:"17:59:41",lz:"18:24:52",st:"Larouco West",la:"Larouco Südwest LP",sLat:41.88482,sLon:-7.72576,lLat:41.87596,lLon:-7.74133,dur:"0h 25m",dk:"5.1",sl:"1.6",kmh:"12.2",hd:"260",msa:"1490",ml:"1227",hm:"1518",hg:"309",ms:"-1.9",mst:"1.7",ge:"Advance XI 23",pa:"",be:"Portugal 6: Sonnenuntergang-Soaring, inkl. vorgelagertem Hügel, super fein."},
"928":{d:"20.9.24",sz:"16:18:28",lz:"16:29:08",st:"Larouco Süd",la:"Gralhas Nord",sLat:41.8797,sLon:-7.72084,lLat:41.85749,lLon:-7.71032,dur:"0h 11m",dk:"3.45",sl:"2.6",kmh:"19.4",hd:"516",msa:"1519",ml:"1001",hm:"1519",hg:"53",ms:"-2.7",mst:"0.8",ge:"Advance XI 23",pa:"",be:"Portugal 7: Gleitflug zwischen Wolken, wenig Thermik"},
"929":{d:"20.9.24",sz:"17:08:07",lz:"17:15:38",st:"Larouco Süd",la:"Gralhas Nord",sLat:41.8797,sLon:-7.72084,lLat:41.85749,lLon:-7.71032,dur:"0h 8m",dk:"3.24",sl:"2.6",kmh:"25.9",hd:"516",msa:"1514",ml:"997",hm:"1514",hg:"0",ms:"-2.0",mst:"0.0",ge:"Advance XI 23",pa:"",be:"Portugal 8: Gleitflug bei zunehmenden Wolken. Aber kein Regen."},
"930":{d:"21.9.24",sz:"13:57:22",lz:"14:25:47",st:"Linhares",la:"Linhares",sLat:40.53257,sLon:-7.44585,lLat:40.55009,lLon:-7.45644,dur:"0h 28m",dk:"5.48",sl:"2.1",kmh:"11.6",hd:"471",msa:"1156",ml:"683",hm:"1224",hg:"344",ms:"-2.5",mst:"1.8",ge:"Advance XI 23",pa:"",be:"Portugal 9: Gutes Soaring am Starthang, dann raus weg von den Wolken, dann zurück."},
"931":{d:"21.9.24",sz:"15:09:04",lz:"15:43:15",st:"Linhares",la:"Linhares",sLat:40.53257,sLon:-7.44585,lLat:40.55009,lLon:-7.45644,dur:"0h 34m",dk:"5.08",sl:"2.1",kmh:"8.9",hd:"471",msa:"1158",ml:"689",hm:"1274",hg:"682",ms:"-3.0",mst:"2.7",ge:"Advance XI 23",pa:"",be:"Portugal 10: Gutes Soaring am Hang, dann über der Burg, stark versetzend."},
"932":{d:"2.11.24",sz:"10:48:38",lz:"11:03:28",st:"Achenkirch Christlumkopf",la:"Achenkirch Sommer-LP",sLat:47.50358,sLon:11.66132,lLat:47.50463,lLon:11.70149,dur:"0h 15m",dk:"4.27",sl:"3.0",kmh:"17.3",hd:"790",msa:"1739",ml:"941",hm:"1739",hg:"24",ms:"-1.6",mst:"0.1",ge:"Advance XI 23",pa:"",be:"Hike ab Kronthaler 1:42, gemütlich, Start und Flug ruhig. Sehr beliebter Hike, viiiile Schirme."},
"933":{d:"10.11.24",sz:"09:39:56",lz:"09:55:42",st:"Fiescheralp Heimat",la:"Fiesch",sLat:46.414477,sLon:8.108295,lLat:46.40933,lLon:8.136896,dur:"0h 16m",dk:"4.84",sl:"2.3",kmh:"18.4",hd:"1090",msa:"2147",ml:"1055",hm:"2148",hg:"62",ms:"-3.4",mst:"1.0",ge:"Advance Pi 3/23",pa:"",be:"Test Pi 3: kleiner Verhänger oder Klapper beim Start. Sehr leichtgängig, Spirale rasch, wendig"},
"934":{d:"10.11.24",sz:"10:48:12",lz:"11:08:26",st:"Fiescheralp Heimat",la:"Fiesch",sLat:46.414477,sLon:8.108295,lLat:46.40933,lLon:8.136896,dur:"0h 20m",dk:"5.06",sl:"2.3",kmh:"15.0",hd:"1090",msa:"2145",ml:"1052",hm:"2164",hg:"99",ms:"-1.7",mst:"1.0",ge:"Advance Pi 3/23",pa:"",be:"Test Pi 3: Einfach zu starten, ruhig, beschleunigt ruhig und stabil."},
"935":{d:"10.11.24",sz:"11:57:33",lz:"12:21:20",st:"Fiescheralp Heimat oben",la:"Fieschertal Flyingcenter",sLat:46.41531,sLon:8.10633,lLat:46.421062,lLon:8.145385,dur:"0h 24m",dk:"4.21",sl:"3.1",kmh:"10.6",hd:"1126",msa:"2217",ml:"1092",hm:"2217",hg:"206",ms:"-2.7",mst:"2.4",ge:"Advance Pi 3/23",pa:"",be:"Test Pi 3: gute Thermik-Eigenschaft, flach und fein steuerbar. Sehr viel leichterer Bremsdruck, alles feiner als Pi, längere Leinen."},
"936":{d:"2.2.25",sz:"11:21:37",lz:"11:26:31",st:"Fiescheralp Heimat",la:"Fiescheralp Heimat",sLat:46.414477,sLon:8.108295,lLat:46.414477,lLon:8.108295,dur:"0h 5m",dk:"1.46",sl:"0.0",kmh:"17.9",hd:"0",msa:"2161",ml:"2150",hm:"2164",hg:"119",ms:"-1.1",mst:"0.9",ge:"Advance Pi 3/21",pa:"",be:"Erster Flug mit dem neuen Pi, alles Bestens. Am Start Karabiner verdreht, deshalb nach 4‘ wieder oben reingelandet."},
"937":{d:"2.2.25",sz:"11:39:48",lz:"11:57:39",st:"Fiescheralp Heimat",la:"Fiesch",sLat:46.414477,sLon:8.108295,lLat:46.40933,lLon:8.136896,dur:"0h 18m",dk:"4.64",sl:"2.3",kmh:"15.6",hd:"1090",msa:"2159",ml:"1062",hm:"2159",hg:"70",ms:"-2.2",mst:"0.5",ge:"Advance Pi 3/21",pa:"",be:"Thermik schwach, kann zu Beginn knapp halten."},
"938":{d:"2.2.25",sz:"13:10:56",lz:"13:31:56",st:"Fiescheralp Heimat",la:"Fieschertal Flyingcenter",sLat:46.414477,sLon:8.108295,lLat:46.421062,lLon:8.145385,dur:"0h 21m",dk:"5.26",sl:"2.9",kmh:"15.0",hd:"1055",msa:"2150",ml:"1088",hm:"2213",hg:"288",ms:"-4.0",mst:"1.4",ge:"Advance Pi 3/21",pa:"",be:"Thermik besser, nun problemlose Startüberhöhung. Landung bei Hansi."},
"939":{d:"9.2.25",sz:"13:23:35",lz:"13:35:01",st:"Gniepen E Napf",la:"Goldau Vogelsang",sLat:47.077872,sLon:8.564717,lLat:47.051871,lLon:8.543638,dur:"0h 11m",dk:"4.23",sl:"3.3",kmh:"22.2",hd:"930",msa:"1409",ml:"480",hm:"1409",hg:"20",ms:"-2.1",mst:"0.3",ge:"Advance Pi 3/21",pa:"",be:"Hike, fühle mich gut. Oben Schnee, und Wolken, nach E (Napf), dann Abstieg bis Höhe Althütte. 2 Fehlstarts, r‘wärts ohne Wind, dann Leinensalat"},
"940":{d:"3.3.25",sz:"12:04:25",lz:"12:23:57",st:"Chaiserstuel",la:"Wolfenschiessen",sLat:46.877156,sLon:8.467618,lLat:46.905095,lLon:8.398533,dur:"0h 20m",dk:"7.78",sl:"6.1",kmh:"23.9",hd:"1888",msa:"2403",ml:"520",hm:"2403",hg:"3",ms:"-2.2",mst:"0.0",ge:"Advance Pi 3/21",pa:"",be:"Zum ersten Mal nach Skitour. Ski quer unten am RS, beim Start zwischen Risers, Rucksack kippt nach oben, über den Kopf ziehen und Ski ausfädeln. Dann gut."},
"941":{d:"10.4.25",sz:"17:23:43",lz:"18:01:10",st:"Capaccio",la:"Capo di Fiume",sLat:40.44925,sLon:15.04941,lLat:40.44441,lLon:15.0428,dur:"0h 37m",dk:"3.28",sl:"0.8",kmh:"5.3",hd:"190",msa:"216",ml:"22",hm:"395",hg:"555",ms:"-1.4",mst:"1.2",ge:"Advance XI 23",pa:"",be:"Italien 1: Schönes dynamisches Abendsoaring im Seewind, ruhig. Start seitlich, ok."},
"942":{d:"11.4.25",sz:"11:49:35",lz:"13:34:57",st:"Capaccio",la:"Capo di Fiume",sLat:40.44925,sLon:15.04941,lLat:40.44441,lLon:15.0428,dur:"1h 45m",dk:"17.92",sl:"0.8",kmh:"10.2",hd:"190",msa:"218",ml:"28",hm:"1182",hg:"3174",ms:"-2.5",mst:"3.8",ge:"Advance XI 23",pa:"",be:"Italien 2: Dynam. Soaring entlang der ganzen Ridge, Querung nach Trentinara, an der vorg. Krete SW im Lee zurück, zum Start, 3/4-Weg zum Hotel und zurück."},
"943":{d:"11.4.25",sz:"18:17:32",lz:"18:44:37",st:"Capaccio",la:"Capo di Fiume",sLat:40.44925,sLon:15.04941,lLat:40.44441,lLon:15.0428,dur:"0h 27m",dk:"4.8",sl:"0.8",kmh:"10.6",hd:"190",msa:"219",ml:"18",hm:"468",hg:"442",ms:"-2.1",mst:"1.8",ge:"Advance XI 23",pa:"",be:"Italien 3: Sehr seitlicher Startwind, knifflig. Dann ruhe Abend-Dynamik."},
"944":{d:"12.4.25",sz:"12:47:11",lz:"15:32:42",st:"Calvisi",la:"Calvisi Bacco e Bivacco",sLat:41.33259,sLon:14.45538,lLat:41.32235,lLon:14.4034,dur:"2h 46m",dk:"38.07",sl:"4.5",kmh:"13.8",hd:"839",msa:"1054",ml:"215",hm:"1366",hg:"4307",ms:"-3.9",mst:"5.9",ge:"Advance XI 23",pa:"",be:"Italien 4: Toller Streckenflug entlang der Kreten nach NW, und zurück. Teils in Wolken. Umkehrpunkt knifflig."},
"945":{d:"12.4.25",sz:"18:02:35",lz:"18:25:06",st:"Calvisi",la:"Calvisi Bacco e Bivacco",sLat:41.33259,sLon:14.45538,lLat:41.32235,lLon:14.4034,dur:"0h 23m",dk:"6.32",sl:"4.5",kmh:"16.8",hd:"839",msa:"1051",ml:"211",hm:"1051",hg:"141",ms:"-1.8",mst:"0.7",ge:"Advance XI 23",pa:"",be:"Italien 5: Ruhiger Abend-Gleitflug."},
"946":{d:"13.4.25",sz:"15:29:56",lz:"15:38:35",st:"Maratea St Caterina SE",la:"Spaggia Nera C Jannita",sLat:39.97478,sLon:15.73953,lLat:39.97138,lLon:15.72312,dur:"0h 9m",dk:"2.44",sl:"1.4",kmh:"16.9",hd:"482",msa:"488",ml:"1",hm:"488",hg:"6",ms:"-1.4",mst:"0.1",ge:"Advance XI 23",pa:"",be:"Italien 6: Gleitflug zum Strand, unerwartet R‘wind, fast zu lang."},
"947":{d:"10.5.25",sz:"12:23:35",lz:"13:37:39",st:"Brunni Schonegg",la:"Wolfenschiessen",sLat:46.839927,sLon:8.41465,lLat:46.905095,lLon:8.398533,dur:"1h 14m",dk:"19.08",sl:"7.3",kmh:"15.5",hd:"1411",msa:"1918",ml:"507",hm:"2229",hg:"1622",ms:"-2.5",mst:"2.1",ge:"Advance XI 23",pa:"",be:"Versuch Engelberger-Runde, bis Haldigrat gut, teils fein, teils ruppig, am Buochserhorn geht nichts mehr."},
"948":{d:"17.5.25",sz:"10:12:51",lz:"10:47:21",st:"Fiescheralp Heimat",la:"Fiesch",sLat:46.414477,sLon:8.108295,lLat:46.40933,lLon:8.136896,dur:"0h 35m",dk:"8.34",sl:"2.3",kmh:"14.5",hd:"1090",msa:"2148",ml:"1060",hm:"2832",hg:"998",ms:"-3.8",mst:"4.8",ge:"Advance XI 23",pa:"",be:"Nordwind, gute Thermik, rasch auf 2800, unter Wolken kleine Ohren. Über Bellwald ruppig, bereits viel Ostwind, deshalb wie Sepp zum Landen."},
"949":{d:"18.5.25",sz:"09:50:07",lz:"10:51:34",st:"Fiescheralp Heimat",la:"Kapelle Ritzingen",sLat:46.414477,sLon:8.108295,lLat:46.460795,lLon:8.227707,dur:"1h 1m",dk:"26.17",sl:"10.5",kmh:"25.6",hd:"789",msa:"2147",ml:"1358",hm:"2515",hg:"2146",ms:"-3.4",mst:"3.5",ge:"Advance XI 23",pa:"",be:"Wind mehr aus W, Wolken, etwas ruppig und unberechenbar, aber draussen am Rand der Kreten überall gut. Mit Sepp. Abbruch, tiefer Flug zurück zur Kirche."},
"950":{d:"20.6.25",sz:"10:42:35",lz:"13:13:39",st:"Fiescheralp Heimat",la:"Fiesch",sLat:46.414477,sLon:8.108295,lLat:46.40933,lLon:8.136896,dur:"2h 31m",dk:"43.34",sl:"2.3",kmh:"17.2",hd:"1090",msa:"2157",ml:"1062",hm:"3221",hg:"5547",ms:"-3.5",mst:"2.7",ge:"Gradient BiGolden 3/39",pa:"Alena Mair-Noack",be:"Leichter Seiten-W am Start. Thermik erst sanft, dann gut und sehr zuverlässig und rel. ruhig. Sidelhorn retour, problemlos. Kalt!! Ldg. zu weit, da Wind abstellt."},
"951":{d:"22.6.25",sz:"10:55:48",lz:"14:20:49",st:"Fiescheralp Heimat",la:"Sedrun",sLat:46.414477,sLon:8.108295,lLat:46.68031,lLon:8.77982,dur:"3h 25m",dk:"63.28",sl:"59.3",kmh:"18.5",hd:"758",msa:"2149",ml:"1391",hm:"3651",hg:"6824",ms:"-5.8",mst:"5.3",ge:"Advance XI 23",pa:"",be:"Endlich Furka richtig, und dazu mit Oberalp! Sensationell. Stark schlagender Fullstall, dann Frontstall am Nätschen, wsh Bremsen zu tief. Abgleiten nach Sedrun."},
"952":{d:"25.6.25",sz:"09:05:26",lz:"09:21:57",st:"Eggerhorn West",la:"Fiesch",sLat:46.384025,sLon:8.182043,lLat:46.40933,lLon:8.136896,dur:"0h 17m",dk:"7.3",sl:"4.5",kmh:"26.5",hd:"1425",msa:"2476",ml:"1059",hm:"2476",hg:"28",ms:"-2.1",mst:"0.8",ge:"Advance Pi 3/21",pa:"",be:"Hike aufs Eggerhorn, 2:30, früh noch nicht soo heiss. Geht gut. Flug ruhig."},
"953":{d:"29.6.25",sz:"11:30:08",lz:"15:05:33",st:"Fiescheralp Galfera",la:"Fiesch",sLat:46.404695,sLon:8.096536,lLat:46.40933,lLon:8.136896,dur:"3h 35m",dk:"43.23",sl:"3.1",kmh:"12.0",hd:"1116",msa:"2170",ml:"1062",hm:"3849",hg:"7621",ms:"-3.0",mst:"3.5",ge:"Advance XI 23",pa:"",be:"Sidelhorn retour via Galmihörner, Wasenhorn, kl. Wannenhorn und Querung zum Eggerhorn."},
"954":{d:"1.7.25",sz:"09:56:25",lz:"10:18:19",st:"Fiescheralp Biplace",la:"Fiesch",sLat:46.411504,sLon:8.102926,lLat:46.40933,lLon:8.136896,dur:"0h 22m",dk:"5.7",sl:"2.6",kmh:"15.6",hd:"1139",msa:"2193",ml:"1059",hm:"2193",hg:"97",ms:"-1.6",mst:"0.3",ge:"Gradient BiGolden 3/39",pa:"Bea Mair-Noack",be:"Erster Flug mit Bea seit ihrem Unfall. Start, Flug und Landung problemlos, Landung im Sitzen. Wenig schwache Thermik über Älpli. Bea ist wieder drin!"},
"955":{d:"6.7.25",sz:"10:44:57",lz:"10:55:55",st:"Bellwald Mutti",la:"Fiesch",sLat:46.43749,sLon:8.15544,lLat:46.40933,lLon:8.136896,dur:"0h 11m",dk:"4.02",sl:"3.4",kmh:"22.0",hd:"723",msa:"1732",ml:"1014",hm:"1732",hg:"19",ms:"-2.2",mst:"0.1",ge:"Gradient BiGolden 3/39",pa:"Claris Mair-Noack",be:"Kühe am Startplatz! Ein Fehlstart, Löcher in Wiese. Dann ruhiger Flug mit Claris, wenig Thermik über Stei. Mit ÖV heim."},
"956":{d:"3.8.25",sz:"11:40:49",lz:"12:15:32",st:"Fiescheralp Heimat",la:"Fiesch",sLat:46.414477,sLon:8.108295,lLat:46.40933,lLon:8.136896,dur:"0h 35m",dk:"7.12",sl:"2.3",kmh:"12.3",hd:"1090",msa:"2146",ml:"1054",hm:"2147",hg:"529",ms:"-2.0",mst:"1.5",ge:"Advance XI 23",pa:"",be:"Bewölkt, mässig Thermik, vor allem über Bellwald. Bei der Landung ein anderer GS nahe, Wind mir unklar, deshalb Rückenwind-Landung, problemlos."},
"957":{d:"9.8.25",sz:"11:30:30",lz:"12:12:42",st:"Brunni Schonegg",la:"Engelberg West",sLat:46.839927,sLon:8.41465,lLat:46.81691,lLon:8.40832,dur:"0h 42m",dk:"9.24",sl:"2.6",kmh:"13.1",hd:"915",msa:"1899",ml:"1009",hm:"2199",hg:"1125",ms:"-2.6",mst:"2.7",ge:"Advance XI 23",pa:"",be:"Mit Manuel Roth. Gute, leicht ruppige Thermik."},
"958":{d:"13.8.25",sz:"11:32:09",lz:"12:10:49",st:"Brunni Schonegg",la:"Engelberg West",sLat:46.840311,sLon:8.414959,lLat:46.81691,lLon:8.40832,dur:"0h 39m",dk:"8.99",sl:"2.7",kmh:"14.0",hd:"943",msa:"1882",ml:"975",hm:"2397",hg:"722",ms:"-2.1",mst:"2.1",ge:"Gradient BiGolden 3/39",pa:"Andrina Caratsch",be:"Erstmals mit Andrina. Start und Landung problemlos. Gute Thermik. Talquerung an die Hirtplanggen (Scheideggstock), dort nichts los. Mit R’wind zurück."},
"959":{d:"13.8.25",sz:"13:39:57",lz:"13:42:30",st:"Brunnihütte",la:"Brunni Tümpfeli",sLat:46.842699,sLon:8.410243,lLat:46.837488,lLon:8.410581,dur:"0h 3m",dk:"0.65",sl:"0.6",kmh:"15.3",hd:"119",msa:"1826",ml:"1714",hm:"1826",hg:"2",ms:"-1.7",mst:"0.1",ge:"Gradient BiGolden 3/39",pa:"Andrina Caratsch",be:"Start gut, aber Verhänger A/B Leine links, Hanglandung unterhalb Tümpfeli, problemlos."},
"960":{d:"13.8.25",sz:"13:56:14",lz:"14:05:09",st:"Brunni Tümpfeli",la:"Engelberg West",sLat:46.838069,sLon:8.41206,lLat:46.81691,lLon:8.40832,dur:"0h 9m",dk:"3.3",sl:"2.4",kmh:"22.2",hd:"796",msa:"1766",ml:"966",hm:"1766",hg:"15",ms:"-2.4",mst:"0.1",ge:"Gradient BiGolden 3/39",pa:"Andrina Caratsch",be:"Trotz Leinenkontrolle immer noch Knoten links oberste Gallerie A/B, Profil gestört, Flug in grossen Kreisen, Ldg. zu kurz auf Fussballplatz. Uff. Stimmung aber gut."},
"961":{d:"16.8.25",sz:"10:29:38",lz:"11:07:28",st:"Fiescheralp Heimat",la:"Fiesch",sLat:46.414477,sLon:8.108295,lLat:46.40933,lLon:8.136896,dur:"0h 38m",dk:"10.23",sl:"2.3",kmh:"16.2",hd:"1090",msa:"2108",ml:"1010",hm:"2681",hg:"689",ms:"-1.8",mst:"2.4",ge:"Advance XI 23",pa:"",be:"Nordlage mit Bise, am Eggishorn spürbar. Rüber zur Alp Frid, Chäserstatt und retour über Bellwald, aber nichts los."},
"962":{d:"17.8.25",sz:"10:37:10",lz:"11:12:17",st:"Steibenkreuz Winter",la:"Kapelle Ritzingen",sLat:46.44797,sLon:8.16367,lLat:46.460795,lLon:8.227707,dur:"0h 35m",dk:"13.9",sl:"5.1",kmh:"23.7",hd:"1067",msa:"2369",ml:"1351",hm:"2745",hg:"870",ms:"-2.0",mst:"2.7",ge:"Advance XI 23",pa:"",be:"Startabbruch bei Verhänger am Ohr. Hanglandung, Neustart 80m weiter unten. Bise, Wolken, gute Thermik. Mit Sepp."},
"963":{d:"18.8.25",sz:"10:45:24",lz:"13:29:44",st:"Fiescheralp Galfera",la:"Fiesch",sLat:46.404695,sLon:8.096536,lLat:46.40933,lLon:8.136896,dur:"2h 44m",dk:"46.54",sl:"3.1",kmh:"17.0",hd:"1116",msa:"2170",ml:"1067",hm:"3440",hg:"5756",ms:"-2.7",mst:"3.4",ge:"Advance XI 23",pa:"",be:"Gute Thermik, im Laufe der Tour zunehmend, Sidelhorn retour und zu Heimat und Galfera zurück. Sepp derweil nach Interlaken. Mit Burnair Go, gut."},
"964":{d:"24.8.25",sz:"11:16:04",lz:"12:24:47",st:"Fiescheralp Galfera",la:"Fiesch",sLat:46.404695,sLon:8.096536,lLat:46.40933,lLon:8.136896,dur:"1h 9m",dk:"21.66",sl:"3.1",kmh:"18.9",hd:"1116",msa:"2166",ml:"1059",hm:"2779",hg:"2045",ms:"-2.5",mst:"3.0",ge:"Advance XI 23",pa:"",be:"Ruppig, immer wieder gute Schläuche bis Riederfurka, dort speziell. Rückkehr tief, bei Galfera wieder hoch."},
"965":{d:"25.8.25",sz:"11:12:20",lz:"12:17:12",st:"Fiescheralp Heimat",la:"Fiesch",sLat:46.414477,sLon:8.108295,lLat:46.40933,lLon:8.136896,dur:"1h 5m",dk:"15.93",sl:"2.3",kmh:"14.7",hd:"1090",msa:"2148",ml:"1061",hm:"2621",hg:"1595",ms:"-2.3",mst:"2.5",ge:"Advance XI 23",pa:"",be:"Etwas hoch bedeckt. Zuerst schwache Thermik, dann immer besser, leicht ruppig, nur bis Biel."},
"966":{d:"11.10.25",sz:"12:56:36",lz:"14:31:57",st:"Fiescheralp Heimatpiste",la:"Fiesch",sLat:46.416608,sLon:8.105421,lLat:46.40933,lLon:8.136896,dur:"1h 35m",dk:"10.12",sl:"2.5",kmh:"6.4",hd:"1208",msa:"2293",ml:"1066",hm:"2676",hg:"1744",ms:"-1.8",mst:"1.5",ge:"Advance XI 23",pa:"",be:"Start oben am Heimat-Bahn. Leichter Seitenwind, tricky. Sanfte, aber konstante Thermik überall, lange gesucht in Richinen, am Hang entlang bis zur Hängebrücke."},
"967":{d:"12.10.25",sz:"11:24:31",lz:"11:32:30",st:"Chüe Risihorn",la:"Geissbode Pkt 2181",sLat:46.45718,sLon:8.155488,lLat:46.428995,lLon:8.119052,dur:"0h 8m",dk:"4.43",sl:"4.2",kmh:"33.3",hd:"566",msa:"2719",ml:"2159",hm:"2719",hg:"27",ms:"-2.1",mst:"0.3",ge:"Advance Pi 3/21",pa:"",be:"Fiescher Trilogie Teil 1: Bahn Furggulti, Hike: 1.2 km, 170 hm, Start: Chüe, Flug: Talquerung, Landung: östlich Lawinenverb. Salzgäb, R’wind, Sträucher, knifflig."},
"968":{d:"12.10.25",sz:"13:22:13",lz:"13:33:36",st:"Talegga West",la:"Chäserstatt",sLat:null,sLon:null,lLat:null,lLon:null,dur:"0h 11m",dk:"6.35",sl:"5.8",kmh:"33.5",hd:"806",msa:"2567",ml:"1763",hm:"2567",hg:"56",ms:"-2.0",mst:"0.9",ge:"Advance Pi 3/21",pa:"",be:"Fiescher Trilogie Teil 2: Hike: 2.3 km, 400 hm. Start: Talegga-Krete. Flug: Querung Chäserstatt, etwas Thermik ob Salzgäb. Landung: unterh. Parkplatz, R‘wind."},
"969":{d:"12.10.25",sz:"15:11:48",lz:"15:16:33",st:"Chäserstatt Heizunalp",la:"Bellwald ob LFÜB",sLat:46.40622,sLon:8.17807,lLat:46.423735,lLon:8.162345,dur:"0h 5m",dk:"2.34",sl:"2.3",kmh:"29.6",hd:"392",msa:"1949",ml:"1545",hm:"1949",hg:"16",ms:"-2.8",mst:"0.3",ge:"Advance Pi 3/21",pa:"",be:"Fiescher Trilogie Teil 3: 0%-Bier, Kirschkuchen. Hike: 1 km, 184 hm. Start: Schopf Heizunalp. Landung: Hang unterh. Stall Bellwald. Total: 24 min Flug, 754 hm Hike"},
"970":{d:"13.10.25",sz:"15:09:06",lz:"15:33:11",st:"Talegga West",la:"Fiesch",sLat:null,sLon:null,lLat:46.40933,lLon:8.136896,dur:"0h 24m",dk:"10.22",sl:"3.3",kmh:"25.5",hd:"1510",msa:"2564",ml:"1055",hm:"2579",hg:"41",ms:"-1.7",mst:"0.6",ge:"Advance XI 23",pa:"",be:"War nichts mehr los, zu hohe Inversion, deshalb mit der Bahn hoch zum Eggishorn und dann 20‘ runter zum Talegga, Super Stimmung, aber auch dort nichts los."},
"971":{d:"14.10.25",sz:"10:50:13",lz:"11:07:37",st:"Eggerhorn West",la:"Fiesch",sLat:46.383135,sLon:8.181913,lLat:46.40933,lLon:8.136896,dur:"0h 17m",dk:"6.51",sl:"4.5",kmh:"22.4",hd:"1404",msa:"2486",ml:"1058",hm:"2486",hg:"19",ms:"-2.0",mst:"0.2",ge:"Advance Pi 3/21",pa:"",be:"Hike aufs Eggerhorn, 2:23, ging sehr gut, richtig gemütlich. Super Stimmung. Flug und Start ruhig."},
"972":{d:"14.10.25",sz:"12:29:35",lz:"12:57:57",st:"Fiescheralp Heimat",la:"Fiesch",sLat:46.414477,sLon:8.108295,lLat:46.40933,lLon:8.136896,dur:"0h 28m",dk:"7.26",sl:"2.3",kmh:"15.4",hd:"1090",msa:"2154",ml:"1057",hm:"2231",hg:"372",ms:"-1.5",mst:"2.8",ge:"Advance XI 23",pa:"",be:"Nochmals kurz von der Heimat rel. problemlos zur Salzgäb, heute labil, es ginge hoch. Breche aber ab, ist für heute ok."},
"973":{d:"15.10.25",sz:"13:50:06",lz:"14:37:21",st:"Talegga West",la:"Fiesch",sLat:null,sLon:null,lLat:46.40933,lLon:8.136896,dur:"0h 47m",dk:"11.79",sl:"3.3",kmh:"15.0",hd:"1510",msa:"2571",ml:"1058",hm:"2952",hg:"812",ms:"-1.9",mst:"2.3",ge:"Advance XI 23",pa:"",be:"Gute Thermik bis hoch zum Eggishorn, über Bellwald mässig, dann zurück zum Landen, ich wollte ja noch nach Brig. Sepp n. Grindelwald."},
"974":{d:"17.10.25",sz:"13:49:04",lz:"15:00:41",st:"Talegga West",la:"Fiesch",sLat:null,sLon:null,lLat:46.40933,lLon:8.136896,dur:"1h 12m",dk:"11.52",sl:"3.3",kmh:"9.7",hd:"1510",msa:"2573",ml:"1059",hm:"2573",hg:"1081",ms:"-1.7",mst:"1.3",ge:"Advance XI 23",pa:"",be:"Wieder hohe Inversion, Thermik schwach, mit 2350 rüber nach Richinen, zu knapp, am Waldrand ruppig, aber guter Kapellenschlauch."},
"975":{d:"18.10.25",sz:"15:16:20",lz:"15:33:06",st:"Fiescheralp Heimat",la:"Fiesch",sLat:46.414477,sLon:8.108295,lLat:46.40933,lLon:8.136896,dur:"0h 17m",dk:"6.87",sl:"2.3",kmh:"24.6",hd:"1090",msa:"2153",ml:"1062",hm:"2153",hg:"17",ms:"-1.8",mst:"0.1",ge:"Advance XI 23",pa:"",be:"Ruhiger Gleitflug via Lax ins Tal nach Wanderung mit Bea zum Märjelensee und aussenrum retour."},
"976":{d:"13.12.25",sz:"12:42:25",lz:"13:03:32",st:"Fiescheralp Heimat",la:"Fiesch",sLat:46.414477,sLon:8.108295,lLat:46.40933,lLon:8.136896,dur:"0h 21m",dk:"6.22",sl:"2.3",kmh:"17.7",hd:"1090",msa:"2108",ml:"1022",hm:"2108",hg:"121",ms:"-1.9",mst:"1.0",ge:"Ozone Wisp 2",pa:"Bea Mair-Noack",be:"Testflug, Bea mit Ski. Erster Eindruck: Start einfach, gutes Thermikansprechen, Landung einfach, Flaren effektiv. Speeder effektiv, nur die Griffe sehr hoch."},
"977":{d:"1.3.26",sz:"12:59:31",lz:"13:16:56",st:"Pancas Clementino Izoton",la:"Pancas",sLat:-19.2291,sLon:-40.866,lLat:-19.2247,lLon:-40.8426,dur:"0h 17m",dk:"3.89",sl:"2.5",kmh:"13.4",hd:"575",msa:"716",ml:"144",hm:"716",hg:"77",ms:"-1.3",mst:"1.3",ge:"Advance XI 23",pa:"",be:"Brasilien 1: Erster Flug, erst schwach, dann nichts mehr. Imposante Granitdomes, enge Täler. Tropisch feucht. Alles gut."},
"978":{d:"2.3.26",sz:"10:59:20",lz:"12:13:50",st:"Pancas Clementino Izoton",la:"N São Pedro do Pancas",sLat:-19.2291,sLon:-40.866,lLat:-19.2426,lLon:-40.787,dur:"1h 15m",dk:"12.47",sl:"8.4",kmh:"10.0",hd:"601",msa:"714",ml:"124",hm:"1243",hg:"1763",ms:"-2.6",mst:"1.9",ge:"Advance XI 23",pa:"",be:"Brasilien 2: Schwierig raus aus dem Tal, immer wieder tief und gerettet, draussen im Flachland in engem Tälchen am Hang gelandet."},
"979":{d:"2.3.26",sz:"14:36:08",lz:"15:02:25",st:"Pancas Clementino Izoton",la:"Pancas",sLat:-19.2291,sLon:-40.866,lLat:-19.2247,lLon:-40.8426,dur:"0h 26m",dk:"7.07",sl:"2.5",kmh:"16.1",hd:"575",msa:"726",ml:"146",hm:"1105",hg:"517",ms:"-2.6",mst:"2.1",ge:"Advance XI 23",pa:"",be:"Brasilien 3: Nach Start rasch hoch, dann nach erster Querung nichts mehr los. Talquerung, aber zu spät."},
"980":{d:"3.3.26",sz:"13:15:31",lz:"13:26:09",st:"Pedro do Vidal",la:"Lajinha S",sLat:-19.1926,sLon:-40.7789,lLat:-19.1702,lLon:-40.7695,dur:"0h 11m",dk:"4.28",sl:"2.7",kmh:"24.2",hd:"439",msa:"594",ml:"139",hm:"595",hg:"50",ms:"-2.1",mst:"0.1",ge:"Advance XI 23",pa:"",be:"Brasilien 4: Klippenstart auf Granitplatte, dann Abgleiter, im Tal mit R‘wind sehr knapp zum Landeplatz."},
"981":{d:"4.3.26",sz:"10:53:49",lz:"13:06:04",st:"Pancas Clementino Izoton",la:"N Lajinhas",sLat:-19.2291,sLon:-40.866,lLat:-19.1342,lLon:-40.7774,dur:"2h 12m",dk:"28.19",sl:"14.1",kmh:"12.8",hd:"559",msa:"710",ml:"163",hm:"1364",hg:"4194",ms:"-3.6",mst:"2.6",ge:"Advance XI 23",pa:"",be:"Brasilien 5: Strecke aus dem Tal mit viel Wind, Low Safe im Flachland, dann nach Lajinha. Nördlich in den Tälern im Flachland abgesoffen."},
"982":{d:"5.3.26",sz:"11:12:23",lz:"11:56:38",st:"Baixo Guandu Monjolo",la:"S Baixu Rio Guandu",sLat:-19.6311,sLon:-40.9683,lLat:-19.5567,lLon:-41.0114,dur:"0h 44m",dk:"12.69",sl:"9.4",kmh:"17.2",hd:"714",msa:"870",ml:"113",hm:"1277",hg:"931",ms:"-2.0",mst:"2.1",ge:"Advance XI 23",pa:"",be:"Brasilien 6: Gruppen-Streckenflug, interessant und erst gut, im Flachland Anschluss verloren,zu langsam und mit Speed Sinken. Ldg. am Hang, falsche Flussseite…"},
"983":{d:"6.3.26",sz:"11:24:38",lz:"11:51:28",st:"Pico di Ibituruna",la:"Parking Parque Natural",sLat:-18.8863,sLon:-41.9155,lLat:-18.8665,lLon:-41.9329,dur:"0h 27m",dk:"6.12",sl:"2.9",kmh:"13.7",hd:"898",msa:"1091",ml:"172",hm:"1400",hg:"630",ms:"-2.7",mst:"2.5",ge:"Advance XI 23",pa:"",be:"Brasilien 7: zuerst gleich zur Basis, dann mit Dominik warten auf die andern, dabei aber abgesoffen, Landung bei Parkplatz."},
"984":{d:"6.3.26",sz:"14:11:33",lz:"14:49:03",st:"Pico di Ibituruna",la:"E Alpercata",sLat:-18.8863,sLon:-41.9155,lLat:-18.9807,lLon:-41.9789,dur:"0h 38m",dk:"14.18",sl:"12.4",kmh:"22.7",hd:"818",msa:"1080",ml:"252",hm:"1540",hg:"778",ms:"-2.2",mst:"2.4",ge:"Advance XI 23",pa:"",be:"Brasilien 8: 2. Versuch, wieder gute Startüberhöhung, zu viert ab nach Süden. Nach 10 km immer wieder zu tief, Landung auf Sandweg östlich eines Dorfes."},
"985":{d:"7.3.26",sz:"11:55:36",lz:"15:39:41",st:"Pico di Ibituruna",la:"N Dom Cavati",sLat:-18.8863,sLon:-41.9155,lLat:-19.3443,lLon:-42.08,dur:"3h 44m",dk:"56.82",sl:"53.8",kmh:"15.2",hd:"752",msa:"1091",ml:"320",hm:"1611",hg:"6132",ms:"-2.6",mst:"2.5",ge:"Advance XI 23",pa:"",be:"Brasilien 9: Flachland-Strecke in Gruppe, mit Dominic, Joelle, Daniela, Adrian. Thermik oft schwach, mehrere Low Safes, letzten Schlauch nicht mehr erwischt. Toll."},
"986":{d:"8.3.26",sz:"12:17:06",lz:"15:47:18",st:"Baixo Guandu Monjolo",la:"Baixo Guandu",sLat:-19.6311,sLon:-40.9683,lLat:-19.5111,lLon:-41.0031,dur:"3h 30m",dk:"46.69",sl:"13.8",kmh:"13.3",hd:"779",msa:"874",ml:"73",hm:"1749",hg:"6991",ms:"-5.2",mst:"4.2",ge:"Advance XI 23",pa:"",be:"Brasilien 10: Flachland-Strecke in Gruppe, über Fluss und um grossen Talkessel, im Gleitflug zurück, letztes low safe-Aufsoaren an Felswand, Ldg. in der Stadt."},
"987":{d:"9.3.26",sz:"11:25:55",lz:"14:33:08",st:"Baixo Guandu Monjolo",la:"Aeroporto Baixo Guandu",sLat:-19.6311,sLon:-40.9683,lLat:-19.4987,lLon:-41.0429,dur:"3h 7m",dk:"45.83",sl:"16.7",kmh:"14.7",hd:"769",msa:"864",ml:"83",hm:"1427",hg:"6124",ms:"-2.9",mst:"3.0",ge:"Advance XI 23",pa:"",be:"Brasilien 11: Wieder alle zusammen, diesmal rund ums Becken und zum Flughafen. Mehrere Low Saves."},
"988":{d:"10.3.26",sz:"12:35:21",lz:"14:25:52",st:"Baixo Guandu Monjolo",la:"W Sobreiro",sLat:-19.6311,sLon:-40.9683,lLat:-19.8265,lLon:-41.1228,dur:"1h 51m",dk:"30.96",sl:"27.1",kmh:"16.8",hd:"618",msa:"869",ml:"231",hm:"1478",hg:"3635",ms:"-2.9",mst:"3.4",ge:"Advance XI 23",pa:"",be:"Brasilien 12: Am Start mühsam, dann dem „Feld“ hinterher gejagt und eingeholt. Überentwicklungen, vor dem Regen gelandet."},
"989":{d:"11.3.26",sz:"15:24:41",lz:"16:32:36",st:"Falésias de Marataízes",la:"Falésias de Marataízes",sLat:-21.1469,sLon:-40.886,lLat:-21.1469,lLon:-40.886,dur:"1h 8m",dk:"4.92",sl:"0.0",kmh:"4.3",hd:"0",msa:"44",ml:"35",hm:"138",hg:"742",ms:"-0.7",mst:"1",ge:"Advance XI 23",pa:"",be:"Brasilien 13: Küstensoaring vom Feinsten, relativ starker Wind, Cobra Start mit Hilfe."},
"990":{d:"12.3.26",sz:"11:54:44",lz:"12:15:36",st:"Vargem Alta R do Mirante",la:"S Gironda",sLat:-20.7414,sLon:-41.0596,lLat:-20.742,lLon:-41.079,dur:"0h 21m",dk:"4.52",sl:"2.0",kmh:"13.0",hd:"426",msa:"563",ml:"111",hm:"731",hg:"313",ms:"-2.0",mst:"1.3",ge:"Advance XI 23",pa:"",be:"Brasilien 14: Wechselnde Thermik, dann nichts mehr."},
"991":{d:"12.3.26",sz:"13:51:09",lz:"14:22:11",st:"Vargem Alta R do Mirante",la:"N Vgd Soturno",sLat:-20.7414,sLon:-41.0596,lLat:-20.7528,lLon:-41.0674,dur:"0h 31m",dk:"5.78",sl:"1.5",kmh:"11.2",hd:"431",msa:"564",ml:"106",hm:"919",hg:"735",ms:"-4.0",mst:"1.9",ge:"Advance XI 23",pa:"",be:"Brasilien 15: Nach links der Wand entlang, dann Lee, turbulent, an der Wand wieder zum Startplatz hochsoaren. Im Tal nichts mehr."},
"992":{d:"13.3.26",sz:"11:49:35",lz:"12:21:31",st:"Alfredo Chaves Cachoeira Alta",la:"Dois Irmãos",sLat:-20.6715,sLon:-40.7804,lLat:-20.7117,lLon:-40.757,dur:"0h 32m",dk:"7.04",sl:"5.1",kmh:"13.2",hd:"404",msa:"495",ml:"81",hm:"705",hg:"523",ms:"-1.9",mst:"1.4",ge:"Advance XI 23",pa:"",be:"Brasilien 16: Flachland-Route, aber Thermik knapp, zusammen mit Michael auf Hügel versenkt. Leitungen!! Schwül-heiss…. Ende der Reise. Was für ein Erlebnis!"},
"993":{d:"9.4.26",sz:"13:54:56",lz:"14:21:59",st:"Zugerberg",la:"Zugerberg",sLat:47.14813,sLon:8.535748,lLat:47.14813,lLon:8.535748,dur:"0h 27m",dk:"2.06",sl:"0.0",kmh:"4.6",hd:"0",msa:"942",ml:"944",hm:"1159",hg:"546",ms:"-1.4",mst:"1.2",ge:"Niviuk Artik 7P 23",pa:"",be:"Erster Flug mit dem Artik, alles neu, BC viel leichter, Steuerung kurz, leicht, eigentlich problemlos. Kollision mit Milan an Aussenleinen, war knapp.  Oben reinlanden."},
"994":{d:"9.4.26",sz:"15:04:32",lz:"15:28:20",st:"Zugerberg",la:"Zugerberg",sLat:47.14813,sLon:8.535748,lLat:47.14813,lLon:8.535748,dur:"0h 24m",dk:"2.79",sl:"0.0",kmh:"7.0",hd:"0",msa:"940",ml:"943",hm:"1289",hg:"670",ms:"-1.8",mst:"2.1",ge:"Niviuk Artik 7P 23",pa:"",be:"Ohrenverhänger am Start, über Stabiloleine gelöst. Schirm bleibt ruhig. Start sehr einfach. Leistung sehr gut. Bewegt sich mässig mit. Oben reinlanden."},
"995":{d:"25.4.26",sz:"10:40:30",lz:"11:45:02",st:"Fiescheralp Heimat",la:"Fiesch",sLat:46.414477,sLon:8.108295,lLat:46.40933,lLon:8.136896,dur:"1h 5m",dk:"8.87",sl:"2.3",kmh:"8.2",hd:"1090",msa:"2155",ml:"1058",hm:"2675",hg:"1553",ms:"-2.2",mst:"2.9",ge:"Ozone Wisp 2",pa:"Claris Mair-Noack",be:"Erster Flug mit dem Wisp 2, Start gut, anfangs schwach, dann immer besser, Richinen, Kapellenschlauch. Unten bereits recht Wind. Gut für heute. Ldg. etwas hart."},
"996":{d:"17.5.26",sz:"10:41:45",lz:"11:57:08",st:"Fiescheralp Heimat",la:"Kapelle Ritzingen",sLat:46.414477,sLon:8.108295,lLat:46.460795,lLon:8.227707,dur:"1h 15m",dk:"30.89",sl:"10.5",kmh:"24.6",hd:"789",msa:"2122",ml:"1312",hm:"3041",hg:"3113",ms:"-2.9",mst:"4.7",ge:"Niviuk Artik 7P 23",pa:"",be:"Erster Flug im Goms mit dem Niviuk. Schon lebendig, Schläge werden weitergegeben, aber durchaus stabil. Gewichtsverl. bringt viel. Beschleuniger viel zu kurz."},
"997":{d:"23.5.26",sz:"12:49:31",lz:"14:40:48",st:"Brunnihütte",la:"Stöckalp",sLat:46.842699,sLon:8.410243,lLat:46.80471,lLon:8.27968,dur:"1h 51m",dk:"25.98",sl:"10.8",kmh:"14.0",hd:"819",msa:"1876",ml:"1052",hm:"2907",hg:"3608",ms:"-2.5",mst:"3.1",ge:"Ozone Wisp 2",pa:"Mauro Tannò",be:"Strecke mit Mauro, gute Bedingungen, über erste Krete ins Melchtal, bei Rückweg aber trotz grosser Höhe abgesoffen. Autostopp /  ÖV zurück nach Engelberg."},
"998":{d:"25.5.26",sz:"12:31:28",lz:"13:18:01",st:"Brunni Schonegg",la:"Engelberg West",sLat:46.839927,sLon:8.41465,lLat:46.81691,lLon:8.40832,dur:"0h 47m",dk:"13.36",sl:"2.6",kmh:"17.2",hd:"915",msa:"1920",ml:"1012",hm:"3109",hg:"1267",ms:"-2.0",mst:"4.4",ge:"Niviuk Artik 7P 23",pa:"",be:"Am Start schwach, höher immer kräftiger, Basis über 3000, Talquerung, auf Westseite Richtung Nord, > 2000 aber nichts mehr los, deshalb mit Rückenwind zurück."},
"999":{d:"18.6.26",sz:"15:01:33",lz:"16:51:42",st:"Rotenflue W Sommer",la:"Knonau Eschfeld",sLat:47.018594,sLon:8.701526,lLat:47.21855,lLon:8.46227,dur:"1h 50m",dk:"31.32",sl:"28.7",kmh:"17.1",hd:"1103",msa:"1555",ml:"448",hm:"2101",hg:"2927",ms:"-2.6",mst:"2.9",ge:"Niviuk Artik 7P 23",pa:"",be:"Erster geplanter Streckenflug mit festem Ziel: Knonau. Anfangs schwach und mühsam, dann ab Wildspitz mit toller Thermik fast im Geradeausflug. Sensationell."},
"1000":{d:"20.6.26",sz:"09:59:09",lz:"10:23:43",st:"Fiescheralp Biplace",la:"Fiesch",sLat:46.411504,sLon:8.102926,lLat:46.40933,lLon:8.136896,dur:"0h 25m",dk:"5.83",sl:"2.6",kmh:"14.2",hd:"1139",msa:"2195",ml:"1059",hm:"2195",hg:"249",ms:"-1.9",mst:"1.1",ge:"Ozone Wisp 2",pa:"Bea Mair-Noack",be:"MEIN 1000-STER!!! Gemütlicher Flug mit Bea, Start gut, Ldg. so..la..la, bei Nullwind auf dem Po. Thermik lau."},
"1001":{d:"21.6.26",sz:"10:29:43",lz:"12:02:27",st:"Fiescheralp Heimat",la:"Fiesch",sLat:46.414477,sLon:8.108295,lLat:46.40933,lLon:8.136896,dur:"1h 33m",dk:"27.88",sl:"2.3",kmh:"18.0",hd:"1090",msa:"2152",ml:"1066",hm:"3454",hg:"3276",ms:"-3.7",mst:"3.3",ge:"Niviuk Artik 7P 23",pa:"",be:"Bereits schöne Thermik, es geht überall hoch. Mit Stefan, dann auch Sepp. Stefan kehrt Mitte Obergoms um, ich deshalb auch, mit R‘Wind zurück."},
"1002":{d:"24.6.26",sz:"10:08:36",lz:"11:01:15",st:"Fiescheralp Biplace",la:"Fiesch",sLat:46.411504,sLon:8.102926,lLat:46.40933,lLon:8.136896,dur:"0h 53m",dk:"11.19",sl:"2.6",kmh:"12.8",hd:"1139",msa:"2197",ml:"1059",hm:"3104",hg:"1186",ms:"-2.7",mst:"2.2",ge:"Ozone Wisp 2",pa:"Bea Mair-Noack",be:"Schöne ruhige, zuverlässige Thermik bis hoch über Gipfel Eggishorn, Blick über Aletsch. VIA Richinen. Ldg. wieder auf Po, Flaren schwierig bei null Wind!"},
"1003":{d:"30.6.26",sz:"10:08:14",lz:"10:33:24",st:"Fiescheralp Biplace",la:"Fiesch",sLat:46.411504,sLon:8.102926,lLat:46.40933,lLon:8.136896,dur:"0h 25m",dk:"6.43",sl:"2.6",kmh:"15.3",hd:"1139",msa:"2195",ml:"1060",hm:"2196",hg:"25",ms:"-1.4",mst:"0.3",ge:"Ozone Wisp 2",pa:"Bea Mair-Noack",be:"Baschi geplant, aber viel zu wenig Thermik, nirgendwo geht’s. Landung wieder hart, flart nicht richtig."}
};

// ── Main App ───────────────────────────────────────────────────────────────
function lv03ToWgs84(e, n) {
  const y = (e - 600000) / 1000000, x = (n - 200000) / 1000000;
  let lon = 2.6779094 + 4.728982*y + 0.791484*y*x + 0.1306*y*x*x - 0.0436*y*y*y;
  let lat = 16.9023892 + 3.238272*x - 0.270978*y*y - 0.002528*x*x - 0.0447*y*y*x - 0.0140*x*x*x;
  return { lat: lat*100/36, lon: lon*100/36 };
}
function wgs84ToLv03(lat, lon) {
  const latP = (lat*3600 - 169028.66)/10000, lonP = (lon*3600 - 26782.5)/10000;
  const e = 600072.37 + 211455.93*lonP - 10938.51*lonP*latP - 0.36*lonP*latP*latP - 44.54*lonP*lonP*lonP;
  const n = 200147.07 + 308807.95*latP + 3745.25*lonP*lonP + 76.63*latP*latP - 194.56*lonP*lonP*latP + 119.79*latP*latP*latP;
  return { e: Math.round(e), n: Math.round(n) };
}
// Builds one 53-column CSV/TSV row (same layout as the original bulk-import
// CSV) from a flight object — the inverse of parseSingleRow/createFlightFromPDF.
// Used for the "copy flights" feature so pasted output matches Numbers' columns.
// Builds a row matching ONLY the 25 columns that are actually VISIBLE in the
// person's Numbers sheet (hidden columns 2,4,5,8,9,11-20,22,24-33,51,52 are
// skipped entirely — Numbers pastes into visible cells only, so including
// hidden columns here would shift every value one column too far).
// Of those 25 visible columns, 8 still contain formulas the person wants to
// keep (34,35,36,37,39,40,44,50 — S-L Entf., Dauer, Rang, %, km/h, H.Diff.,
// SÜ, Datum-Zeitwert): those get the FORMULA_PLACEHOLDER text instead of
// being left blank, since a blank paste would overwrite the formula with
// nothing and there is no way to make a plain-text/HTML clipboard paste
// skip a cell — the person replaces the placeholder with the formula again
// by hand after pasting. Nr/Flugreise (1,3) are
// deliberately left blank per the person's instructions.
const FORMULA_PLACEHOLDER = "#F#";
function flightToCsvRow(f) {
  const cf = f.customFields || {};
  const val = {
    datum:    f.rawDate || f.date || "",
    startzeit: f.startTime || "",
    start:    f.site || "",
    landezeit: f.endTime || "",
    landung:  cf.landung || "",
    distanz:  f.totalDist ? String(f.totalDist) : (cf.distKm || ""),
    muemS:    f.startAlt ? String(f.startAlt) : (cf.msa || ""),
    muemL:    f.endAlt ? String(f.endAlt) : (cf.ml || ""),
    hmax:     f.maxAlt ? String(f.maxAlt) : (cf.hMax || ""),
    hgew:     cf.hGew || "",
    sinken:   cf.maxSinken || "",
    steigen:  cf.maxSteigen || "",
    geraet:   f.glider || "",
    passagier: cf.passagier || "",
    bemerkung: f.notes || "",
  };
  // Ordered exactly as the 25 visible columns appear in the sheet:
  // 1=Nr, 3=Flugreise, 6=Datum, 7=Startzeit, 10=Start, 21=Landezeit, 23=Landung,
  // 34=S-L Entf.*, 35=Dauer*, 36=Rang*, 37=%*, 38=Distanz, 39=km/h*, 40=H.Diff.*,
  // 41=müM S, 42=müM L, 43=H.Max, 44=SÜ*, 45=H.Gew., 46=Sinken, 47=Steigen,
  // 48=Gerät, 49=Passagier, 50=Datum2*, 53=Bemerkung   (* = formula placeholder)
  const row = [
    f.name || "",             // 1  Nr
    "",                       // 3  Flugreise
    val.datum,                // 6  Datum
    val.startzeit,            // 7  Startzeit
    val.start,                // 10 Start
    val.landezeit,            // 21 Landezeit
    val.landung,               // 23 Landung
    FORMULA_PLACEHOLDER,      // 34 S-L Entf.
    FORMULA_PLACEHOLDER,      // 35 Dauer
    FORMULA_PLACEHOLDER,      // 36 Rang
    FORMULA_PLACEHOLDER,      // 37 %
    val.distanz,              // 38 Distanz
    FORMULA_PLACEHOLDER,      // 39 km/h
    FORMULA_PLACEHOLDER,      // 40 H.Diff.
    val.muemS,                // 41 müM S
    val.muemL,                // 42 müM L
    val.hmax,                 // 43 H.Max
    FORMULA_PLACEHOLDER,      // 44 SÜ
    val.hgew,                 // 45 H.Gew.
    val.sinken,                // 46 Sinken
    val.steigen,               // 47 Steigen
    val.geraet,                // 48 Gerät
    val.passagier,             // 49 Passagier
    FORMULA_PLACEHOLDER,      // 50 Datum (Zeitwert)
    val.bemerkung,              // 53 Bemerkung
  ];
  return row.join("\t");
}
function coordsToWgs84(a, b) {
  const af = parseFloat(String(a).replace(",", ".")), bf = parseFloat(String(b).replace(",", "."));
  if (isNaN(af) || isNaN(bf)) return { lat: null, lon: null };
  if (Math.abs(af) <= 90 && Math.abs(bf) <= 180) return { lat: af, lon: bf };
  const r = lv03ToWgs84(af, bf);
  return { lat: Math.round(r.lat*1e6)/1e6, lon: Math.round(r.lon*1e6)/1e6 };
}
// Parses one CSV/TSV row (same 53-column layout as the bulk import) into the
// "p" object shape expected by createFlightFromPDF.
function splitCsvLine(line) {
  const cols = []; let cur = "", inQ = false;
  for (const ch of line) {
    if (ch === '"') inQ = !inQ;
    else if (ch === "," && !inQ) { cols.push(cur); cur = ""; }
    else cur += ch;
  }
  cols.push(cur);
  return cols;
}
// Compact Numbers-copy format (25 tab-separated columns):
// 0=Nr, 1=(leer), 2=Datum, 3=Startzeit, 4="Start-Name, müM, CH1903-E, CH1903-N",
// 5=Landezeit, 6="Land-Name, müM, CH1903-E, CH1903-N", 7=S-L-Entf, 8=Dauer, 9=Rang,
// 10=%, 11=Distanz, 12=km/h, 13=H.Diff, 14=müM-S(dup), 15=müM-L(dup), 16=H.Max,
// 17=SÜ, 18=H.Gew, 19=Sinken, 20=Steigen, 21=Gerät, 22=Passagier, 23=Datum(dup), 24=Bemerkung
function parseCompactField(field) {
  // "Name, alt, chE, chN" -> {name, alt, chE, chN}
  const parts = (field||"").split(",").map(s=>s.trim());
  return { name: parts[0]||"", alt: parts[1]||"", chE: parts[2]||"", chN: parts[3]||"" };
}
function parseCompactNumbersRow(cols) {
  const get = i => (cols[i]||"").trim();
  const start = parseCompactField(get(4));
  const land = parseCompactField(get(6));
  const s = coordsToWgs84(start.chE, start.chN);
  const l = coordsToWgs84(land.chE, land.chN);
  return {
    d: get(2), sz: get(3), lz: get(5), st: start.name, la: land.name,
    sLat: s.lat, sLon: s.lon, lLat: l.lat, lLon: l.lon,
    dur: get(8), dk: get(11), sl: get(7), kmh: get(12), hd: get(13),
    msa: get(14) || start.alt, ml: get(15) || land.alt, hm: get(16), hg: get(18),
    ms: get(19), mst: get(20), ge: get(21), pa: get(22), be: get(24),
    _nr: get(0),
    _colCount: 53, // treat as valid — this is the compact 25-col format
  };
}
// Splits a multi-line paste (multiple flights, one per line, e.g. several rows
// copied together from Numbers) into individual rows, then parses each with
// parseSingleRow. Skips blank lines. Returns [{raw, p, error}] for each row,
// where p is the parsed field object (or null on error).
function parseMultipleRows(text) {
  const lines = text.replace(/\r/g, "").split("\n").map(l=>l.trim()).filter(Boolean);
  return lines.map(line => {
    try {
      const p = parseSingleRow(line);
      return { raw: line, p, error: null };
    } catch (e) {
      return { raw: line, p: null, error: e.message };
    }
  });
}

function parseSingleRow(rowText) {
  const raw = rowText.replace(/\r/g, "");
  let cols;
  let isTabSeparated = false;
  if (raw.includes("\t")) {
    // Tab-separated (typical Numbers/Excel single-row copy)
    cols = raw.split("\t");
    isTabSeparated = true;
  } else if (raw.includes("\n") && !raw.includes(",")) {
    // One value per line, no commas at all -> newline-separated single row
    cols = raw.split("\n");
  } else if (raw.includes("\n")) {
    // Multiple lines with commas present: most likely several CSV lines got pasted
    // (e.g. header + data row). Use the LAST non-empty line as the actual data row,
    // since that is what a person copying "one row" from a spreadsheet/CSV usually means.
    const lines = raw.split("\n").map(l=>l.trim()).filter(Boolean);
    const dataLine = lines[lines.length-1] || raw;
    cols = splitCsvLine(dataLine);
    if (cols.length < 20) cols = splitCsvLine(raw);
  } else {
    // Single line, comma-separated
    cols = splitCsvLine(raw);
  }
  cols = cols.map(c => (c||"").trim().replace(/^"+|"+$/g, ""));

  // Detect the compact Numbers-copy format: ~25 tab-separated columns where
  // column 4 looks like "Name, alt, chE, chN" (contains commas + numbers).
  if (isTabSeparated && cols.length >= 20 && cols.length <= 30) {
    const field4 = cols[4] || "";
    if (field4.split(",").length >= 3) {
      return parseCompactNumbersRow(cols);
    }
  }

  const get = i => cols[i] || "";
  const s = coordsToWgs84(get(12), get(13));
  const l = coordsToWgs84(get(25), get(26));
  return {
    d: get(5), sz: get(6), lz: get(20), st: get(10), la: get(23),
    sLat: s.lat, sLon: s.lon, lLat: l.lat, lLon: l.lon,
    dur: get(34), dk: get(37), sl: get(36), kmh: get(38), hd: get(39),
    msa: get(40), ml: get(41), hm: get(42), hg: get(44),
    ms: get(45), mst: get(46), ge: get(47), pa: get(48), be: get(52),
    _nr: get(0),
    _colCount: cols.length,
  };
}

function createFlightFromPDF(nr, p) {
  let dateStr="", yr="", mo="";
  if (p.d) {
    const parts = p.d.split(".");
    if (parts.length===3) {
      const dd=parts[0].padStart(2,"0"), mm=parts[1].padStart(2,"0");
      const y2=+parts[2]; yr = parts[2].length===2 ? (y2>=30?"19":"20")+parts[2] : parts[2]; mo=mm;
      dateStr = `${dd}.${mm}.${yr}`;
    }
  }
  let durationSec=0;
  const durStr = p.dur||"";
  if (durStr) {
    const dm = durStr.match(/(\d+):(\d{2}):(\d{2})/);
    if (dm) durationSec=+dm[1]*3600 + +dm[2]*60 + +dm[3];
    else { const dm2=durStr.match(/(\d+):(\d{2})/); if(dm2) durationSec=+dm2[1]*60 + +dm2[2]; }
  }
  const startPt = p.sLat&&p.sLon ? {lat:+p.sLat,lon:+p.sLon,gpsAlt:+(p.msa||0)} : null;
  const endPt   = p.lLat&&p.lLon ? {lat:+p.lLat,lon:+p.lLon,gpsAlt:+(p.ml||0)}  : null;
  const track = []; // no artificial track
  return {
    id: `pdf_${nr}_${Date.now()}`,
    pdfOnly: true, name: nr,
    date: dateStr, rawDate: p.d||"", year: yr, month: mo,
    pilot:"", site: p.st||"", glider: p.ge||"",
    startTime: p.sz || "",
    endTime:   p.lz || "",
    durationSec, durationStr: durStr,
    maxAlt: +(p.hm||0), minAlt: +(p.ml||0),
    startAlt: +(p.msa||0), endAlt: +(p.ml||0),
    totalDist: parseFloat(p.dk||0)||0,
    thermalCount: 0, maxClimb: +(p.mst||0),
    track, startPt, endPt,
    comment:"", rating:0,
    notes: p.be||"",
    customFields: {
      passagier: p.pa||"", landung: p.la||"",
      distKm: p.dk||"", kmh: p.kmh||"",
      hDiff: p.hd||"", hMax: p.hm||"", hGew: p.hg||"",
      maxSinken: p.ms||"", maxSteigen: p.mst||"",
    },
  };
}

// ── FILTER ENGINE ────────────────────────────────────────────────────────
// Supports: free text, UND/AND/&& , ODER/OR/|| , field:value, field>val, field<val,
// field>=val, field<=val, +word (muss), -word (darf nicht). Duration values like
// 1h, 1:30, 90m are parsed to seconds for dauer comparisons.
function parseDurToSec(s){
  if(s==null) return 0;
  s=String(s).trim();
  let m=s.match(/^(\d+):(\d{2}):(\d{2})$/); if(m) return +m[1]*3600+ +m[2]*60+ +m[3];
  m=s.match(/^(\d+):(\d{2})$/); if(m) return +m[1]*3600+ +m[2]*60;
  m=s.match(/^(\d+(?:[.,]\d+)?)\s*h(?:\s*(\d+)\s*m)?$/i); if(m) return Math.round((+m[1].replace(",","."))*3600)+(m[2]?+m[2]*60:0);
  m=s.match(/^(\d+)\s*m(?:in)?$/i); if(m) return +m[1]*60;
  m=s.match(/^(\d+(?:[.,]\d+)?)$/); if(m) return Math.round(+m[1].replace(",",".")*3600); // bare number => hours
  return 0;
}
function flightFieldValue(f, field){
  const cf=f.customFields||{};
  switch(field){
    case "name": case "titel": return f.name||"";
    case "site": case "start": case "startplatz": return f.site||"";
    case "landung": case "landeplatz": return cf.landung||"";
    case "schirm": case "glider": case "gerät": case "geraet": return f.glider||"";
    case "pilot": return f.pilot||"";
    case "passagier": case "pax": return cf.passagier||"";
    case "jahr": case "year": return f.year||"";
    case "datum": case "date": return f.date||"";
    case "kommentar": case "comment": return f.comment||"";
    case "bemerkung": case "notes": case "notiz": return f.notes||"";
    case "dauer": case "duration": return (f.durationSec||parseDurToSec(f.durationStr))/3600; // hours (number)
    case "distanz": case "dist": case "km": return f.totalDist||parseFloat(cf.distKm||cf.dk||0)||0;
    case "höhe": case "hoehe": case "maxhöhe": case "maxhoehe": case "alt": return f.maxAlt||+(cf.hMax||cf.hm||0)||0;
    case "speed": case "kmh": return parseFloat(cf.kmh||0)||0;
    case "rating": case "bewertung": return f.rating||0;
    default: return "";
  }
}
function evalToken(f, tok){
  // comparison field op value
  let m=tok.match(/^([\wäöü]+)\s*(>=|<=|>|<|=|:)\s*(.+)$/i);
  if(m){
    const field=m[1].toLowerCase(), op=m[2], raw=m[3].trim();
    let fv=flightFieldValue(f, field);
    // numeric fields
    const numericFields=["dauer","duration","distanz","dist","km","höhe","hoehe","maxhöhe","maxhoehe","alt","speed","kmh","rating","bewertung","jahr","year"];
    if(numericFields.includes(field)){
      let cmp = field==="dauer"||field==="duration" ? parseDurToSec(raw)/3600 : parseFloat(raw.replace(",","."));
      fv = parseFloat(fv)||0;
      if(isNaN(cmp)) return true;
      if(op===">") return fv>cmp;
      if(op==="<") return fv<cmp;
      if(op===">=") return fv>=cmp;
      if(op==="<=") return fv<=cmp;
      return Math.abs(fv-cmp)<0.0001;
    }
    // text fields: : and = mean contains
    return String(fv).toLowerCase().includes(raw.toLowerCase());
  }
  // plain word => search across all text
  const hay=[f.name,f.site,f.glider,f.pilot,f.customFields?.passagier,f.customFields?.landung,f.comment,f.notes,f.date,f.year].join(" ").toLowerCase();
  return hay.includes(tok.toLowerCase());
}
// ── SORT ENGINE ──────────────────────────────────────────────────────────
const SORT_OPTIONS = [
  { id: "date",     label: "Datum" },
  { id: "duration", label: "Dauer" },
  { id: "dist",     label: "Distanz" },
  { id: "alt",      label: "Max. Höhe" },
  { id: "startAlt", label: "Start müM" },
  { id: "endAlt",   label: "Landung müM" },
  { id: "speed",    label: "Ø Speed" },
  { id: "rating",   label: "Bewertung" },
];
function parseDateToTs(d, timeStr) {
  if (!d) return 0;
  const m = String(d).match(/(\d{1,2})\.(\d{1,2})\.(\d{2,4})/);
  if (!m) return 0;
  let [_, dd, mm, yy] = m;
  yy = yy.length === 2 ? (+yy >= 30 ? "19" + yy : "20" + yy) : yy;
  let hh = 0, min = 0, sec = 0;
  if (timeStr) {
    const tm = String(timeStr).match(/(\d{1,2}):(\d{2})(?::(\d{2}))?/);
    if (tm) { hh = +tm[1]; min = +tm[2]; sec = +(tm[3] || 0); }
  }
  return new Date(+yy, +mm - 1, +dd, hh, min, sec).getTime();
}
function sortFieldValue(f, sortId) {
  const cf = f.customFields || {};
  switch (sortId) {
    case "date": {
      // Older flights saved to storage before the seconds-precision fix may
      // have an empty/truncated startTime. Fall back to the embedded
      // PDF_DATA's original time so date sorting is still exact.
      let t = f.startTime;
      if (!t) {
        const p = PDF_DATA[(f.name||"").match(/\d+/)?.[0]];
        t = p?.sz || "";
      }
      return parseDateToTs(f.date || f.rawDate, t);
    }
    case "name":     return parseInt((f.name || "").match(/\d+/)?.[0] || "0", 10);
    case "duration": return f.durationSec || parseDurToSec(f.durationStr);
    case "dist":     return f.totalDist || parseFloat(cf.distKm || cf.dk || 0) || 0;
    case "alt":      return f.maxAlt || +(cf.hMax || cf.hm || 0) || 0;
    case "startAlt": return f.startAlt || +(cf.msa || 0) || 0;
    case "endAlt":   return f.endAlt || +(cf.ml || 0) || 0;
    case "site":     return (f.site || "").toLowerCase();
    case "landung":  return (cf.landung || "").toLowerCase();
    case "glider":   return (f.glider || "").toLowerCase();
    case "pilot":    return (f.pilot || "").toLowerCase();
    case "pax":      return (cf.passagier || "").toLowerCase();
    case "speed":    return parseFloat(cf.kmh || 0) || 0;
    case "rating":   return f.rating || 0;
    default:         return 0;
  }
}
function sortFlights(flights, sortId, dir) {
  if (!sortId) return flights;
  const sorted = [...flights].sort((a, b) => {
    const av = sortFieldValue(a, sortId), bv = sortFieldValue(b, sortId);
    if (typeof av === "string" || typeof bv === "string") {
      return String(av).localeCompare(String(bv));
    }
    return av - bv;
  });
  return dir === "desc" ? sorted.reverse() : sorted;
}

function formatSortValue(f, sortId) {
  const cf = f.customFields || {};
  switch (sortId) {
    case "name":     return f.name || "—";
    case "duration": return f.durationStr || "—";
    case "dist":     return (f.totalDist || cf.distKm || cf.dk) ? (f.totalDist || cf.distKm || cf.dk) + " km" : "—";
    case "alt":      return (f.maxAlt || cf.hMax || cf.hm) ? (f.maxAlt || cf.hMax || cf.hm) + " m" : "—";
    case "startAlt": return (f.startAlt || cf.msa) ? (f.startAlt || cf.msa) + " m" : "—";
    case "endAlt":   return (f.endAlt || cf.ml) ? (f.endAlt || cf.ml) + " m" : "—";
    case "site":     return f.site || "—";
    case "landung":  return cf.landung || "—";
    case "glider":   return f.glider || "—";
    case "pilot":    return f.pilot || "—";
    case "pax":      return cf.passagier || "—";
    case "speed":    return cf.kmh ? cf.kmh + " km/h" : "—";
    case "rating":   return f.rating ? "★".repeat(f.rating) : "—";
    default:         return f.durationStr || "—";
  }
}

function FlightRow({ f, isLongest, onClick, sortId, selectMode, isSelected, onToggleSelect }) {
  const pax = f.customFields?.passagier;
  const showSortValue = sortId && sortId !== "date";
  return (
    <div onClick={selectMode ? ()=>onToggleSelect(f.id) : onClick}
      style={{padding:"11px 16px",borderBottom:"1px solid rgba(255,255,255,0.04)",cursor:"pointer",display:"flex",justifyContent:"space-between",alignItems:"center",background:isSelected?"rgba(14,165,233,0.1)":"transparent",transition:"background 0.15s"}}
      onMouseEnter={e=>{ if(!isSelected) e.currentTarget.style.background="rgba(255,255,255,0.03)"; }}
      onMouseLeave={e=>{ if(!isSelected) e.currentTarget.style.background="transparent"; }}>
      {selectMode && (
        <div style={{marginRight:10,flexShrink:0,width:20,height:20,borderRadius:6,border:`2px solid ${isSelected?"#7dd3fc":"rgba(232,244,253,0.3)"}`,background:isSelected?"#7dd3fc":"transparent",display:"flex",alignItems:"center",justifyContent:"center"}}>
          {isSelected && <span style={{color:"#0a1628",fontSize:13,fontWeight:900}}>✓</span>}
        </div>
      )}
      <div style={{flex:1,minWidth:0}}>
        <div style={{display:"flex",alignItems:"center",gap:6,marginBottom:2}}>
          {isLongest&&<span style={{fontSize:10}}>🏆</span>}
          <span style={{fontWeight:700,fontSize:15}}>{f.name}</span>
          {(f.pdfOnly||f.customFields?.distKm)&&<span style={{background:"rgba(139,92,246,0.18)",color:"#c4b5fd",borderRadius:20,padding:"1px 7px",fontSize:9,fontWeight:700}}>PDF</span>}
          {f.track?.length>1&&<span style={{background:"rgba(245,158,11,0.18)",color:"#fcd34d",borderRadius:20,padding:"1px 7px",fontSize:9,fontWeight:700}}>IGC</span>}
          {pax&&<span style={{border:"1px solid rgba(232,244,253,0.15)",borderRadius:20,padding:"1px 7px",fontSize:9,color:"rgba(232,244,253,0.5)"}}>👤 {pax}</span>}
        </div>
        <div style={{fontSize:11,color:"rgba(232,244,253,0.4)"}}>{f.date} · {f.site||"—"}{f.glider?" · "+f.glider:""}</div>
      </div>
      <div style={{textAlign:"right",flexShrink:0,marginLeft:8}}>
        {showSortValue ? (
          <div style={{fontSize:13,fontWeight:600,color:"#7dd3fc"}}>{formatSortValue(f, sortId)}</div>
        ) : (<>
          <div style={{fontSize:13,fontWeight:600,color:"#7dd3fc"}}>{f.durationStr||"—"}</div>
          <div style={{fontSize:11,color:"rgba(232,244,253,0.3)"}}>{f.totalDist?f.totalDist+" km":""}</div>
        </>)}
      </div>
    </div>
  );
}

function matchFlights(flights, q){
  if(!q||!q.trim()) return flights;
  // Normalise operators
  let s=q.trim()
    .replace(/\s+(UND|AND)\s+/gi," && ")
    .replace(/\s+(ODER|OR)\s+/gi," || ")
    .replace(/&&/g," && ").replace(/\|\|/g," || ");
  // Split into OR groups, each OR group split into AND terms
  const orGroups=s.split(/\s*\|\|\s*/);
  return flights.filter(f=>{
    return orGroups.some(group=>{
      const andTerms=group.split(/\s*&&\s*/).flatMap(t=>{
        // also split on spaces but keep field:val / quoted together
        return t.match(/(?:[\wäöü]+(?:>=|<=|>|<|=|:)\S+|\+\S+|\-\S+|"[^"]+"|\S+)/gi)||[];
      }).map(t=>t.replace(/^"|"$/g,""));
      if(!andTerms.length) return true;
      return andTerms.every(term=>{
        if(term.startsWith("+")) return evalToken(f, term.slice(1));
        if(term.startsWith("-")) return !evalToken(f, term.slice(1));
        return evalToken(f, term);
      });
    });
  });
}

function CoordEdit({lat, lon, alt, color, onSave}) {
  const [editing, setEditing] = useState(false);
  const [la, setLa] = useState(lat!=null?String(lat):"");
  const [lo, setLo] = useState(lon!=null?String(lon):"");
  const [al, setAl] = useState(alt!=null&&alt>0?String(alt):"");
  const start = () => { setLa(lat!=null?String(lat):""); setLo(lon!=null?String(lon):""); setAl(alt!=null&&alt>0?String(alt):""); setEditing(true); };
  const commit = () => {
    setEditing(false);
    const nlat = la.trim()===""?null:parseFloat(la.replace(",","."));
    const nlon = lo.trim()===""?null:parseFloat(lo.replace(",","."));
    const nalt = al.trim()===""?0:parseInt(al,10);
    onSave(isNaN(nlat)?null:nlat, isNaN(nlon)?null:nlon, isNaN(nalt)?0:nalt);
  };
  const iStyle = {width:"100%",background:"rgba(255,255,255,0.08)",border:"1px solid rgba(125,211,252,0.4)",borderRadius:6,padding:"3px 6px",color:"#e8f4fd",fontSize:11,fontFamily:"monospace",boxSizing:"border-box",marginBottom:3};
  if (editing) {
    return (
      <div>
        <input value={la} onChange={e=>setLa(e.target.value)} placeholder="Lat (z.B. 46.91234)" autoFocus style={iStyle} />
        <input value={lo} onChange={e=>setLo(e.target.value)} placeholder="Lon (z.B. 8.37528)" style={iStyle} />
        <input value={al} onChange={e=>setAl(e.target.value)} onBlur={commit} placeholder="müM" style={iStyle}
          onKeyDown={e=>{ if(e.key==="Enter"){e.preventDefault();commit();} }} />
        <button onClick={commit} style={{width:"100%",background:"rgba(125,211,252,0.15)",border:"1px solid rgba(125,211,252,0.3)",borderRadius:6,padding:"3px",color:"#7dd3fc",fontSize:10,cursor:"pointer"}}>✓ Speichern</button>
      </div>
    );
  }
  return (
    <div onClick={start} style={{cursor:"pointer"}}>
      {(lat!=null&&lon!=null) ? (
        <div style={{fontSize:11,color:"rgba(232,244,253,0.7)",fontFamily:"monospace"}}>
          {lat.toFixed(5)}° N<br/>{lon.toFixed(5)}° E
        </div>
      ) : (
        <div style={{fontSize:11,color:"rgba(232,244,253,0.3)",fontFamily:"monospace"}}>— tippen zum Erfassen —</div>
      )}
      {alt>0 && <div style={{fontSize:10,color:color,opacity:0.6,marginTop:3}}>{alt} m ü.M.</div>}
    </div>
  );
}

function EditableTitle({ value, onSave }) {
  const [editing, setEditing] = useState(false);
  const [val, setVal] = useState(value||"");
  const commit = () => { setEditing(false); if(val.trim()!==(value||"") && val.trim()!=="") onSave(val.trim()); };
  if (editing) {
    return (
      <input value={val} onChange={e=>setVal(e.target.value)} onBlur={commit} autoFocus
        onKeyDown={e=>{ if(e.key==="Enter"){e.preventDefault();commit();} }}
        style={{fontSize:22,fontWeight:800,marginBottom:4,background:"rgba(255,255,255,0.08)",border:"1px solid rgba(125,211,252,0.4)",borderRadius:8,padding:"2px 8px",color:"#e8f4fd",width:"100%",boxSizing:"border-box"}} />
    );
  }
  return (
    <div onClick={()=>{setVal(value||"");setEditing(true);}} style={{fontSize:22,fontWeight:800,marginBottom:4,cursor:"pointer"}}>
      {value||"—"}
    </div>
  );
}

function InlineField({label, value, onSave, multiline, unit}) {
  const [editing, setEditing] = useState(false);
  const [val, setVal] = useState(value||"");
  const commit = () => { setEditing(false); if(val!==(value||"")) onSave(val); };
  return (
    <div data-inline-row style={{display:"flex",justifyContent:"space-between",alignItems:"center",padding:"6px 0",borderBottom:"1px solid rgba(255,255,255,0.04)"}}>
      <span style={{fontSize:13,color:"rgba(232,244,253,0.45)",minWidth:90}}>{label}</span>
      {editing ? (
        multiline
          ? <textarea value={val} onChange={e=>setVal(e.target.value)} onBlur={commit} autoFocus
              style={{flex:1,background:"rgba(255,255,255,0.08)",border:"1px solid rgba(125,211,252,0.4)",borderRadius:8,padding:"4px 8px",color:"#e8f4fd",fontSize:13,resize:"vertical",minHeight:48}} />
          : <input value={val} onChange={e=>setVal(e.target.value)} onBlur={commit} autoFocus
              data-inline-field
              onKeyDown={e=>{
                if(e.key==="Enter"){
                  e.preventDefault();
                  setEditing(false);
                  if(val!==(value||"")) onSave(val);
                  const all=[...document.querySelectorAll("[data-inline-field-trigger]")];
                  const cur=e.target.closest("[data-inline-row]");
                  const idx=all.indexOf(cur?.querySelector("[data-inline-field-trigger]"));
                  // After commit the input becomes a span trigger again; focus next trigger
                  setTimeout(()=>{
                    const triggers=[...document.querySelectorAll("[data-inline-field-trigger]")];
                    if(idx>=0&&idx+1<triggers.length) triggers[idx+1].click();
                  },30);
                }
              }}
              style={{flex:1,background:"rgba(255,255,255,0.08)",border:"1px solid rgba(125,211,252,0.4)",borderRadius:8,padding:"4px 8px",color:"#e8f4fd",fontSize:13,textAlign:"right"}} />
      ) : (
        <span data-inline-field-trigger onClick={()=>{setVal(value||"");setEditing(true);}}
          style={{fontSize:13,fontWeight:500,color:value?"#e8f4fd":"rgba(232,244,253,0.25)",cursor:"pointer",minWidth:60,textAlign:"right"}}>
          {value||(unit?"— "+unit:"—")}
        </span>
      )}
    </div>
  );
}


function DetailContent({ fl, flights, customFieldDefs, setFlights, setSelected, setView, setInlinePassagier, setEditData, saveFlight, showFieldEditor, setShowFieldEditor, handleSaveFields, confirmDelete, setConfirmDelete, hideBackButton, isWide }) {

    const autoFields = customFieldDefs.filter(d=>d.formula).map(d=>({...d, value:evalFormula(d.formula,fl,flights)}));
    const manualFields = customFieldDefs.filter(d=>!d.formula);
    const flIdx = flights.findIndex(f=>f.id===fl.id);

    // Inline save helper
    const saveField = async (patch) => {
      const upd = { ...fl, ...patch,
        customFields: { ...(fl.customFields||{}), ...(patch.customFields||{}) } };
      await saveFlight(upd);
      setFlights(p=>p.map(f=>f.id===upd.id?upd:f));
      setSelected(upd);
    };

    return (
      <div style={{maxWidth:isWide?720:480,margin:"0 auto",padding:"0 0 32px",background:"#0d1b2a",minHeight:"100vh",color:"#e8f4fd",fontFamily:"-apple-system,BlinkMacSystemFont,sans-serif"}}>
        <div style={{display:"flex",alignItems:"center",justifyContent:"space-between",padding:"16px 16px 10px"}}>
          {!hideBackButton && <button onClick={()=>setView("list")} style={{background:"none",border:"none",color:"#7dd3fc",fontSize:22,cursor:"pointer"}}>←</button>}
          {hideBackButton && <button onClick={()=>setView("list")} style={{background:"rgba(255,255,255,0.06)",border:"1px solid rgba(255,255,255,0.1)",borderRadius:20,padding:"6px 14px",color:"rgba(232,244,253,0.6)",fontSize:13,cursor:"pointer"}}>✕ Liste</button>}
          <div style={{display:"flex",gap:8}}>
            {fl.track?.length > 1 && (
              <button onClick={()=>{
                const t = fl.track;
                const d = fl.rawDate||fl.date||"";
                const parts = d.split(".");
                const dateStr = parts.length===3 ? parts[0].padStart(2,"0")+parts[1].padStart(2,"0")+parts[2].slice(-2) : "010101";
                const fmtTime = s => { const h=Math.floor(s/3600),m=Math.floor((s%3600)/60),sec=s%60; return String(h).padStart(2,"0")+String(m).padStart(2,"0")+String(sec).padStart(2,"0"); };
                const fmtLat = lat => { const a=Math.abs(lat),d=Math.floor(a),m=(a-d)*60000; return String(d).padStart(2,"0")+String(Math.round(m)).padStart(5,"0")+(lat>=0?"N":"S"); };
                const fmtLon = lon => { const a=Math.abs(lon),d=Math.floor(a),m=(a-d)*60000; return String(d).padStart(3,"0")+String(Math.round(m)).padStart(5,"0")+(lon>=0?"E":"W"); };
                const NL = "\r\n";
                let igc = "AXXX"+NL+"HFDTE"+dateStr+NL;
                igc += "HFPLTPILOTINCHARGE:"+(fl.pilot||"")+NL;
                igc += "HFGTYGLIDERTYPE:"+(fl.glider||"")+NL;
                igc += "HFGIDGLIDERID:"+NL;
                for (const p of t) {
                  const ts = fmtTime(p.timeSec||0);
                  const alt = Math.round(p.gpsAlt||0);
                  igc += "B"+ts+fmtLat(p.lat)+fmtLon(p.lon)+"A"+String(alt).padStart(5,"0")+String(alt).padStart(5,"0")+NL;
                }
                const encoded = "data:text/plain;charset=utf-8,"+encodeURIComponent(igc);
                const a = document.createElement("a");
                a.href=encoded; a.download=(fl.name||"flug")+".igc";
                document.body.appendChild(a); a.click(); document.body.removeChild(a);
              }}
              style={{background:"rgba(245,158,11,0.15)",border:"1px solid rgba(245,158,11,0.3)",borderRadius:20,padding:"6px 12px",color:"#fcd34d",fontSize:13,cursor:"pointer"}}>⬇ IGC</button>
            )}
            <button onClick={()=>setConfirmDelete(fl.id)}
              style={{background:"rgba(239,68,68,0.12)",border:"1px solid rgba(239,68,68,0.25)",borderRadius:20,padding:"6px 12px",color:"#f87171",fontSize:13,cursor:"pointer"}}>🗑</button>
          </div>
        </div>

        <div style={{padding:"0 16px"}}>
          {/* Title row */}
          <div style={{display:"flex",alignItems:"center",justifyContent:"space-between",marginBottom:2}}>
            <span style={{fontSize:11,color:"#7dd3fc"}}>{fl.date}</span>
            <div style={{display:"flex",gap:4}}>
              {(fl.pdfOnly||fl.customFields?.distKm)&&<span style={{background:"rgba(139,92,246,0.2)",color:"#c4b5fd",borderRadius:20,padding:"2px 10px",fontSize:10,fontWeight:700}}>PDF</span>}
              {fl.track?.length>1&&<span style={{background:"rgba(245,158,11,0.18)",color:"#fcd34d",borderRadius:20,padding:"2px 10px",fontSize:10,fontWeight:700}}>IGC</span>}
            </div>
          </div>
          <EditableTitle value={fl.name} onSave={v=>saveField({name:v})} />
          <div style={{fontSize:13,color:"rgba(232,244,253,0.5)",marginBottom:12}}>{fl.startTime}{fl.endTime?" – "+fl.endTime:""}</div>

          {/* Rating inline */}
          <div style={{display:"flex",gap:6,marginBottom:14}}>
            {[1,2,3,4,5].map(s=>(
              <span key={s} onClick={()=>saveField({rating:s})}
                style={{fontSize:24,cursor:"pointer",color:s<=(fl.rating||0)?"#f59e0b":"rgba(232,244,253,0.2)"}}>★</span>
            ))}
          </div>

          {/* Nav arrows */}
          <div style={{display:"flex",justifyContent:"space-between",marginBottom:10}}>
            <button disabled={flIdx>=flights.length-1} onClick={()=>{const f=flights[flIdx+1];setSelected(f);setInlinePassagier(f.customFields?.passagier||"");}}
              style={{background:"rgba(245,158,11,0.15)",border:"1px solid rgba(245,158,11,0.3)",borderRadius:20,padding:"8px 36px",color:flIdx>=flights.length-1?"rgba(232,244,253,0.2)":"#fcd34d",cursor:flIdx>=flights.length-1?"default":"pointer",fontSize:15}}>◀</button>
            <button disabled={flIdx<=0} onClick={()=>{const f=flights[flIdx-1];setSelected(f);setInlinePassagier(f.customFields?.passagier||"");}}
              style={{background:"rgba(245,158,11,0.15)",border:"1px solid rgba(245,158,11,0.3)",borderRadius:20,padding:"8px 36px",color:flIdx<=0?"rgba(232,244,253,0.2)":"#fcd34d",cursor:flIdx<=0?"default":"pointer",fontSize:15}}>▶</button>
          </div>

          {/* Map */}
          <div style={{borderRadius:14,overflow:"hidden",marginBottom:14,border:"1px solid rgba(100,180,255,0.12)"}}><FlightMap flight={fl} /></div>

          {/* Stats grid */}
          <div style={{display:"grid",gridTemplateColumns:"1fr 1fr 1fr",gap:8,marginBottom:14}}>
            {[
              ["⏱", fl.durationStr||"—", "Dauer"],
              ["⬆", fl.maxAlt ? fl.maxAlt+" m" : "—", "Max. Höhe"],
              ["📏", fl.totalDist ? fl.totalDist+" km" : (fl.customFields?.distKm||fl.customFields?.dk ? (fl.customFields.distKm||fl.customFields.dk)+" km" : "—"), "Distanz"],
              ["↑", fl.startAlt>0 ? fl.startAlt+" m" : (fl.customFields?.msa ? fl.customFields.msa+" m" : "—"), "Start müM"],
              ["↓", fl.endAlt>0 ? fl.endAlt+" m" : (fl.customFields?.ml ? fl.customFields.ml+" m" : "—"), "Land. müM"],
              fl.customFields?.hDiff ? ["↕", fl.customFields.hDiff+" m", "H.Diff."] : null,
              fl.customFields?.maxSinken ? ["⬇", fl.customFields.maxSinken+" m/s", "Max.Sinken"] : null,
              fl.customFields?.maxSteigen||fl.maxClimb ? ["⬆", (fl.customFields?.maxSteigen||fl.maxClimb)+" m/s", "Max.Steigen"] : null,
              fl.customFields?.kmh ? ["💨", fl.customFields.kmh+" km/h", "Ø Speed"] : null,
            ].filter(Boolean).map(([ic,v,l])=>(
              <div key={l} style={{background:"rgba(255,255,255,0.05)",borderRadius:12,padding:"12px 8px",textAlign:"center",border:"1px solid rgba(255,255,255,0.06)"}}>
                <div style={{fontSize:14,marginBottom:2}}>{ic}</div>
                <div style={{fontSize:17,fontWeight:800,color:"#7dd3fc"}}>{v}</div>
                <div style={{fontSize:9,color:"rgba(232,244,253,0.4)",marginTop:2,textTransform:"uppercase",letterSpacing:0.5}}>{l}</div>
              </div>
            ))}
          </div>

          {/* Koordinaten-Badges */}
          <div style={{display:"grid",gridTemplateColumns:"1fr 1fr",gap:8,marginBottom:14}}>
            <div style={{background:"rgba(34,197,94,0.07)",borderRadius:12,padding:"10px",border:"1px solid rgba(34,197,94,0.18)"}}>
              <div style={{fontSize:9,fontWeight:700,color:"#4ade80",letterSpacing:1.2,textTransform:"uppercase",marginBottom:5}}>📍 Start</div>
              <CoordEdit
                lat={fl.startPt?.lat} lon={fl.startPt?.lon} alt={fl.startAlt}
                color="#4ade80"
                onSave={(lat,lon,alt)=>{
                  const sp = (lat!==null&&lon!==null)?{lat,lon,gpsAlt:alt||fl.startPt?.gpsAlt||0}:fl.startPt;
                  saveField({startPt:sp, startAlt:alt!=null?alt:fl.startAlt});
                }} />
            </div>
            <div style={{background:"rgba(239,68,68,0.07)",borderRadius:12,padding:"10px",border:"1px solid rgba(239,68,68,0.18)"}}>
              <div style={{fontSize:9,fontWeight:700,color:"#f87171",letterSpacing:1.2,textTransform:"uppercase",marginBottom:5}}>🏁 Landung</div>
              <CoordEdit
                lat={fl.endPt?.lat} lon={fl.endPt?.lon} alt={fl.endAlt}
                color="#f87171"
                onSave={(lat,lon,alt)=>{
                  const ep = (lat!==null&&lon!==null)?{lat,lon,gpsAlt:alt||fl.endPt?.gpsAlt||0}:fl.endPt;
                  saveField({endPt:ep, endAlt:alt!=null?alt:fl.endAlt});
                }} />
            </div>
          </div>

          {/* Editierbare Felder */}
          <div style={{background:"rgba(255,255,255,0.04)",borderRadius:14,padding:"13px 15px",marginBottom:11,border:"1px solid rgba(255,255,255,0.06)"}}>
            <div style={{fontSize:10,fontWeight:700,color:"#7dd3fc",letterSpacing:1.5,textTransform:"uppercase",marginBottom:9}}>Ausrüstung & Ort</div>
            <InlineField label="Schirm"      value={fl.glider}                      onSave={v=>saveField({glider:v})} />
            <InlineField label="Startplatz"  value={fl.site}                        onSave={v=>saveField({site:v})} />
            <InlineField label="Landeplatz"  value={fl.customFields?.landung}       onSave={v=>saveField({customFields:{landung:v}})} />
            <InlineField label="Pilot"       value={fl.pilot}                       onSave={v=>saveField({pilot:v})} />
            <InlineField label="Passagier"   value={fl.customFields?.passagier}     onSave={v=>saveField({customFields:{passagier:v}})} />
            <InlineField label="Start müM"   value={fl.startAlt>0?String(fl.startAlt):(fl.customFields?.msa||"")}  onSave={v=>saveField({startAlt:+v,customFields:{msa:v}})} unit="m" />
            <InlineField label="Landung müM" value={fl.endAlt>0?String(fl.endAlt):(fl.customFields?.ml||"")}       onSave={v=>saveField({endAlt:+v,customFields:{ml:v}})} unit="m" />
            <InlineField label="Max. Höhe"   value={fl.maxAlt?String(fl.maxAlt):""}                                onSave={v=>saveField({maxAlt:+v,customFields:{hm:v}})} unit="m" />
            <InlineField label="Distanz"     value={fl.totalDist?String(fl.totalDist):(fl.customFields?.distKm||fl.customFields?.dk||"")} onSave={v=>saveField({totalDist:parseFloat(v)||0,customFields:{distKm:v}})} unit="km" />
            <InlineField label="Dauer"       value={fl.durationStr}                 onSave={v=>saveField({durationStr:v})} />
            <InlineField label="H.Diff."     value={fl.customFields?.hDiff}         onSave={v=>saveField({customFields:{hDiff:v}})} unit="m" />
            <InlineField label="Ø Speed"     value={fl.customFields?.kmh}           onSave={v=>saveField({customFields:{kmh:v}})} unit="km/h" />
            <InlineField label="Max.Steigen" value={fl.customFields?.maxSteigen}    onSave={v=>saveField({customFields:{maxSteigen:v}})} unit="m/s" />
            <InlineField label="Max.Sinken"  value={fl.customFields?.maxSinken}     onSave={v=>saveField({customFields:{maxSinken:v}})} unit="m/s" />
            <InlineField label="H.Gew."      value={fl.customFields?.hGew}          onSave={v=>saveField({customFields:{hGew:v}})} unit="m" />
          </div>

          {/* Kommentar & Bemerkung */}
          <div style={{background:"rgba(255,255,255,0.04)",borderRadius:14,padding:"13px 15px",marginBottom:11,border:"1px solid rgba(255,255,255,0.06)"}}>
            <div style={{fontSize:10,fontWeight:700,color:"rgba(232,244,253,0.4)",letterSpacing:1.5,textTransform:"uppercase",marginBottom:9}}>Notizen</div>
            <InlineField label="Kommentar" value={fl.comment} onSave={v=>saveField({comment:v})} multiline />
            <InlineField label="Bemerkung" value={fl.notes}   onSave={v=>saveField({notes:v})} multiline />
          </div>

          {/* Auto fields */}
          {autoFields.length>0&&(
            <div style={{background:"rgba(255,255,255,0.04)",borderRadius:14,padding:"13px 15px",marginBottom:11,border:"1px solid rgba(255,255,255,0.06)"}}>
              <div style={{fontSize:10,fontWeight:700,color:"#f59e0b",letterSpacing:1.5,textTransform:"uppercase",marginBottom:9}}>⚡ Auto-Felder</div>
              {autoFields.map(f=>(
                <div key={f.id} style={{display:"flex",justifyContent:"space-between",alignItems:"center",padding:"5px 0",borderBottom:"1px solid rgba(255,255,255,0.04)"}}>
                  <span style={{fontSize:13,color:"rgba(232,244,253,0.45)"}}>{f.icon} {f.name}</span>
                  <span style={{fontSize:13,fontWeight:600,color:"#fcd34d"}}>{f.value}</span>
                </div>
              ))}
            </div>
          )}

          {/* Manual custom fields */}
          {manualFields.filter(f=>!["passagier","landung","distKm","kmh","hDiff","msa","ml","hm","hGew","maxSinken","maxSteigen"].includes(f.id)).length>0&&(
            <div style={{background:"rgba(255,255,255,0.04)",borderRadius:14,padding:"13px 15px",marginBottom:11,border:"1px solid rgba(255,255,255,0.06)"}}>
              <div style={{fontSize:10,fontWeight:700,color:"rgba(232,244,253,0.4)",letterSpacing:1.5,textTransform:"uppercase",marginBottom:9}}>Eigene Felder</div>
              {manualFields.filter(f=>!["passagier","landung","distKm","kmh","hDiff","msa","ml","hm","hGew","maxSinken","maxSteigen"].includes(f.id)).map(f=>(
                <InlineField key={f.id} label={f.name} value={fl.customFields?.[f.id]||""} onSave={v=>saveField({customFields:{[f.id]:v}})} />
              ))}
            </div>
          )}

        </div>
        {showFieldEditor&&<FieldEditor customFieldDefs={customFieldDefs} onSave={handleSaveFields} onClose={()=>setShowFieldEditor(false)} />}
        {confirmDelete===fl.id && (
          <div onClick={()=>setConfirmDelete(null)}
            style={{position:"fixed",inset:0,background:"rgba(0,0,0,0.6)",display:"flex",alignItems:"center",justifyContent:"center",zIndex:100,padding:24}}>
            <div onClick={e=>e.stopPropagation()}
              style={{background:"#14253a",borderRadius:16,padding:"20px 22px",maxWidth:320,width:"100%",border:"1px solid rgba(255,255,255,0.1)"}}>
              <div style={{fontSize:16,fontWeight:700,marginBottom:6}}>Flug löschen?</div>
              <div style={{fontSize:13,color:"rgba(232,244,253,0.6)",marginBottom:18}}>{fl.name} wird endgültig entfernt.</div>
              <div style={{display:"flex",gap:10}}>
                <button onClick={()=>setConfirmDelete(null)}
                  style={{flex:1,background:"rgba(255,255,255,0.08)",border:"1px solid rgba(255,255,255,0.12)",borderRadius:10,padding:"10px",color:"#e8f4fd",fontSize:14,cursor:"pointer"}}>Abbrechen</button>
                <button onClick={async()=>{
                    try{await window.storage.delete(`flight:${fl.id}`);}catch{}
                    setFlights(prev=>prev.filter(f=>f.id!==fl.id));
                    setSelected(null);
                    setConfirmDelete(null);
                    setView("list");
                  }}
                  style={{flex:1,background:"rgba(239,68,68,0.2)",border:"1px solid rgba(239,68,68,0.4)",borderRadius:10,padding:"10px",color:"#f87171",fontSize:14,fontWeight:700,cursor:"pointer"}}>Löschen</button>
              </div>
            </div>
          </div>
        )}
      </div>
    );
  
}

function SidebarList({ flights, selectedId, onSelect, longestId }) {
  const [filterText, setFilterText] = useState("");
  const [sortId, setSortId] = useState("date");
  const [sortDir, setSortDir] = useState("desc");
  const [showSortMenu, setShowSortMenu] = useState(false);
  const filtered = matchFlights(flights, filterText);
  const years = [...new Set(filtered.map(f=>f.year).filter(Boolean))].sort((a,b)=>b-a);
  return (
    <div style={{width:340,minWidth:340,height:"100vh",overflowY:"auto",borderRight:"1px solid rgba(255,255,255,0.08)",background:"#0a1628",fontFamily:"-apple-system,BlinkMacSystemFont,sans-serif"}}>
      <div style={{padding:"14px 14px 8px",position:"sticky",top:0,background:"#0a1628",zIndex:5,borderBottom:"1px solid rgba(255,255,255,0.06)"}}>
        <input value={filterText} onChange={e=>setFilterText(e.target.value)} placeholder="🔍 Suchen…"
          style={{width:"100%",background:"rgba(255,255,255,0.07)",border:"1px solid rgba(255,255,255,0.1)",borderRadius:10,padding:"8px 12px",color:"#e8f4fd",fontSize:13,boxSizing:"border-box",marginBottom:6}} />
        <div style={{display:"flex",gap:6,position:"relative"}}>
          <button onClick={()=>setShowSortMenu(s=>!s)}
            style={{flex:1,display:"flex",justifyContent:"space-between",alignItems:"center",background:"rgba(255,255,255,0.06)",border:"1px solid rgba(255,255,255,0.1)",borderRadius:8,padding:"6px 10px",color:"rgba(232,244,253,0.8)",fontSize:11,cursor:"pointer"}}>
            <span>⇅ {SORT_OPTIONS.find(o=>o.id===sortId)?.label||"—"}</span>
            <span>{showSortMenu?"▾":"▸"}</span>
          </button>
          <button onClick={()=>setSortDir(d=>d==="asc"?"desc":"asc")}
            style={{background:"rgba(255,255,255,0.06)",border:"1px solid rgba(255,255,255,0.1)",borderRadius:8,padding:"6px 10px",color:"#7dd3fc",fontSize:12,cursor:"pointer"}}>
            {sortDir==="asc"?"↑":"↓"}
          </button>
          {showSortMenu && (
            <div style={{position:"absolute",top:"calc(100% + 4px)",left:0,right:0,background:"#14253a",border:"1px solid rgba(255,255,255,0.12)",borderRadius:10,padding:5,maxHeight:240,overflowY:"auto",zIndex:10,boxShadow:"0 8px 24px rgba(0,0,0,0.4)"}}>
              {SORT_OPTIONS.map(o=>(
                <div key={o.id} onClick={()=>{setSortId(o.id);setShowSortMenu(false);}}
                  style={{padding:"7px 10px",borderRadius:6,fontSize:12,cursor:"pointer",color:o.id===sortId?"#7dd3fc":"rgba(232,244,253,0.75)",background:o.id===sortId?"rgba(14,165,233,0.15)":"transparent"}}>
                  {o.label}
                </div>
              ))}
            </div>
          )}
        </div>
      </div>
      {sortId !== "date" ? (
        sortFlights(filtered, sortId, sortDir).map(f => (
          <SidebarFlightRow key={f.id} f={f} selectedId={selectedId} longestId={longestId} onSelect={onSelect} />
        ))
      ) : years.map(yr => {
        const yFlights = sortFlights(filtered.filter(f=>f.year===yr), sortId, sortDir);
        return (
          <div key={yr}>
            <div style={{padding:"8px 14px",fontSize:12,fontWeight:700,color:"#7dd3fc",background:"rgba(255,255,255,0.02)"}}>{yr} · {yFlights.length}</div>
            {yFlights.map(f => (
              <SidebarFlightRow key={f.id} f={f} selectedId={selectedId} longestId={longestId} onSelect={onSelect} />
            ))}
          </div>
        );
      })}
    </div>
  );
}

function SidebarFlightRow({ f, selectedId, longestId, onSelect }) {
  return (
    <div onClick={()=>onSelect(f)}
      style={{padding:"10px 14px",cursor:"pointer",borderBottom:"1px solid rgba(255,255,255,0.04)",background:f.id===selectedId?"rgba(14,165,233,0.12)":"transparent",borderLeft:f.id===selectedId?"3px solid #7dd3fc":"3px solid transparent"}}>
      <div style={{display:"flex",alignItems:"center",gap:6}}>
        {f.id===longestId && <span style={{fontSize:11}}>🏆</span>}
        <span style={{fontWeight:700,fontSize:13,color:"#e8f4fd"}}>{f.name}</span>
        <span style={{fontSize:11,color:"rgba(232,244,253,0.4)"}}>{f.date}</span>
      </div>
      <div style={{fontSize:11,color:"rgba(232,244,253,0.5)",marginTop:2}}>{f.site}</div>
    </div>
  );
}

function useIsWide() {
  const [isWide, setIsWide] = useState(typeof window !== "undefined" ? window.innerWidth >= 768 : false);
  useEffect(() => {
    const onResize = () => setIsWide(window.innerWidth >= 768);
    window.addEventListener("resize", onResize);
    return () => window.removeEventListener("resize", onResize);
  }, []);
  return isWide;
}

function FlugbuchApp() {
  const isWide = useIsWide();
  const [flights, setFlights] = useState([]);
  const [selected, setSelected] = useState(null);
  const [view, setView] = useState("list"); // list|detail|edit|season
  const [importing, setImporting] = useState(false);
  const [importProgress, setImportProgress] = useState(null);
  const [dragOver, setDragOver] = useState(false);
  const [pdfDragOver, setPdfDragOver] = useState(false);
  const [pdfResult, setPdfResult] = useState(null);
  const [pendingDups, setPendingDups] = useState([]);
  const [dupWarning, setDupWarning] = useState(null);
  const [editData, setEditData] = useState({});
  const [customFieldDefs, setCustomFieldDefs] = useState([{id:"passagier",name:"Passagier",type:"text",formula:""}]);
  const [showFieldEditor, setShowFieldEditor] = useState(false);
  const [inlinePassagier, setInlinePassagier] = useState("");
  const [filterText, setFilterText] = useState("");
  const [sortId, setSortId] = useState("date");
  const [sortDir, setSortDir] = useState("desc");
  const [showSortMenu, setShowSortMenu] = useState(false);
  const [collapsedYears, setCollapsedYears] = useState(new Set());
  const [showFilterHelp, setShowFilterHelp] = useState(false);
  const [confirmDelete, setConfirmDelete] = useState(null);
  const [showRowImport, setShowRowImport] = useState(false);
  const [selectMode, setSelectMode] = useState(false);
  const [selectedIds, setSelectedIds] = useState(new Set());
  const [confirmBulkDelete, setConfirmBulkDelete] = useState(false);
  const [copyMsg, setCopyMsg] = useState("");
  const [rowImportText, setRowImportText] = useState("");
  const [rowImportError, setRowImportError] = useState("");
  const [backupMsg, setBackupMsg] = useState("");
  const backupFileRef = useRef(null);
  const fileRef = useRef(null);
  const pdfFileRef = useRef(null);

  // Load flights from storage on mount (falls back to embedded PDF_DATA if storage is empty or unavailable)
  useEffect(() => {
    const seedFromPdfData = async () => {
      const seeded = Object.keys(PDF_DATA).map(nr => createFlightFromPDF(nr, PDF_DATA[nr]));
      // Persist every seeded flight so it becomes a real, editable/deletable record
      // in storage — otherwise deletes/edits are lost on the next reload because
      // there was never anything to delete/overwrite in storage in the first place.
      await Promise.all(seeded.map(f => window.storage.set(`flight:${f.id}`, JSON.stringify(f)).catch(()=>{})));
      const sorted = seeded.sort((a,b) =>
        (parseInt((b.name||"").match(/\d+/)?.[0]||"0",10)) - (parseInt((a.name||"").match(/\d+/)?.[0]||"0",10)));
      setFlights(sorted);
    };
    (async () => {
      let enriched = [];
      try {
        const keys = await window.storage.list("flight:");
        const loaded = await Promise.all((keys?.keys||[]).map(async k => {
          try { const r = await window.storage.get(k); return r ? JSON.parse(r.value) : null; } catch { return null; }
        }));
        enriched = loaded.filter(Boolean).map(f => {
          const p = PDF_DATA[(f.name||"").match(/\d+/)?.[0]];
          if (!f.durationSec && (f.durationStr||p?.dur)) {
            const s = f.durationStr || p?.dur || "";
            const dm = s.match(/(\d+):(\d{2}):(\d{2})/);
            if (dm) f = {...f, durationSec: +dm[1]*3600 + +dm[2]*60 + +dm[3], durationStr: f.durationStr||s};
          }
          if (p) {
            if (!f.startPt && p.sLat && p.sLon) f = {...f, startPt:{lat:+p.sLat,lon:+p.sLon,gpsAlt:+(p.msa||0)}};
            if (!f.endPt   && p.lLat && p.lLon) f = {...f, endPt:  {lat:+p.lLat,lon:+p.lLon,gpsAlt:+(p.ml||0)}};
            if (!f.startAlt && p.msa) f = {...f, startAlt:+(p.msa||0)};
            if (!f.endAlt   && p.ml)  f = {...f, endAlt:  +(p.ml||0)};
            if (!f.maxAlt   && p.hm)  f = {...f, maxAlt:  +(p.hm||0)};
            if (!f.totalDist && p.dk) f = {...f, totalDist:parseFloat(p.dk)||0};
            if (!f.durationStr && p.dur) f = {...f, durationStr:p.dur};
          }
          return f;
        });
      } catch(e) {
        console.error("Storage load error, falling back to PDF_DATA:", e);
        enriched = [];
      }
      if (enriched.length === 0) {
        await seedFromPdfData();
      } else {
        const sorted = enriched.sort((a,b) =>
          (parseInt((b.name||"").match(/\d+/)?.[0]||"0",10)) - (parseInt((a.name||"").match(/\d+/)?.[0]||"0",10)));
        setFlights(sorted);
      }
      try {
        const r = await window.storage.get("customFieldDefs");
        if (r) { const s = JSON.parse(r.value); if (s.length) setCustomFieldDefs(s); }
      } catch {}
    })();
  }, []);

    const saveFlight = useCallback(async (f) => {
    try { await window.storage.set(`flight:${f.id}`, JSON.stringify(f)); } catch {}
  }, []);

  const exportBackup = useCallback(async () => {
    const payload = {
      exportedAt: new Date().toISOString(),
      flights,
      customFieldDefs,
    };
    const json = JSON.stringify(payload, null, 0);
    const dateStamp = new Date().toISOString().slice(0,10);
    const filename = `flugbuch-backup-${dateStamp}.json`;

    // Prefer the native share sheet (lets the user pick "Save to Files" → iCloud Drive)
    if (navigator.share && navigator.canShare) {
      try {
        const file = new File([json], filename, { type: "application/json" });
        if (navigator.canShare({ files: [file] })) {
          await navigator.share({ files: [file], title: "Flugbuch Backup" });
          setBackupMsg("✓ Backup geteilt.");
          return;
        }
      } catch (e) {
        // User cancelled the share sheet, or share failed — fall through to download.
        if (e && e.name === "AbortError") { return; }
      }
    }

    // Fallback: plain download link (older browsers / desktop)
    const encoded = "data:application/json;charset=utf-8," + encodeURIComponent(json);
    const a = document.createElement("a");
    a.href = encoded;
    a.download = filename;
    document.body.appendChild(a);
    a.click();
    document.body.removeChild(a);
  }, [flights, customFieldDefs]);

  const importBackup = useCallback(async (file) => {
    try {
      const text = await file.text();
      const data = JSON.parse(text);
      if (!Array.isArray(data.flights)) throw new Error("Ungültiges Backup-Format (kein 'flights'-Array).");
      // Persist every flight back into storage
      for (const f of data.flights) {
        await window.storage.set(`flight:${f.id}`, JSON.stringify(f));
      }
      if (Array.isArray(data.customFieldDefs) && data.customFieldDefs.length) {
        await window.storage.set("customFieldDefs", JSON.stringify(data.customFieldDefs));
        setCustomFieldDefs(data.customFieldDefs);
      }
      const sorted = [...data.flights].sort((a,b)=>
        (parseInt((b.name||"").match(/\d+/)?.[0]||"0",10)) - (parseInt((a.name||"").match(/\d+/)?.[0]||"0",10)));
      setFlights(sorted);
      setBackupMsg(`✓ ${data.flights.length} Flüge wiederhergestellt.`);
    } catch (e) {
      setBackupMsg("Fehler beim Import: " + e.message);
    }
  }, []);

  const addNewFlight = useCallback(async () => {
    // Next sequential number = max existing numeric name + 1
    const maxNr = flights.reduce((m,f)=>{
      const n = parseInt((f.name||"").match(/\d+/)?.[0]||"0",10);
      return n>m?n:m;
    }, 0);
    const newNr = maxNr + 1;
    const now = new Date();
    const dd = String(now.getDate()).padStart(2,"0");
    const mm = String(now.getMonth()+1).padStart(2,"0");
    const yyyy = String(now.getFullYear());
    const newFlight = {
      id: `manual_${newNr}_${Date.now()}`,
      name: String(newNr),
      pdfOnly: false,
      date: `${dd}.${mm}.${yyyy}`,
      rawDate: `${dd}.${mm}.${yyyy}`,
      year: yyyy, month: mm,
      startTime: "", endTime: "",
      site: "", glider: "", pilot: "",
      comment: "", notes: "", rating: 0,
      durationStr: "", durationSec: 0,
      totalDist: 0, maxAlt: 0, startAlt: 0, endAlt: 0,
      startPt: null, endPt: null, track: [],
      customFields: { passagier:"", landung:"" },
    };
    await saveFlight(newFlight);
    setFlights(prev => [newFlight, ...prev].sort((a,b)=>
      (parseInt((b.name||"").match(/\d+/)?.[0]||"0",10)) - (parseInt((a.name||"").match(/\d+/)?.[0]||"0",10))));
    setSelected(newFlight);
    setInlinePassagier("");
    setView("detail");
  }, [flights, saveFlight]);

  const handleSaveFields = useCallback(async (defs) => {
    setCustomFieldDefs(defs); setShowFieldEditor(false);
    try { await window.storage.set("customFieldDefs", JSON.stringify(defs)); } catch {}
  }, []);

  const applyParsedData = useCallback(async (DATA) => {
    const existingNames = new Set(flights.map(f=>f.name||""));
    const newEntries = []; let updated = 0;
    const updatedFlights = flights.map(f => {
      const num = (f.name||"").match(/\d+/)?.[0];
      const p = num ? DATA[num] : null;
      if (!p) return f;
      updated++;
      const dm=(p.dur||"").match(/(\d+):(\d{2}):(\d{2})/);
      const durationSec = dm ? +dm[1]*3600 + +dm[2]*60 + +dm[3] : f.durationSec;
      return {
        ...f,
        site: p.st || f.site,
        glider: p.ge || f.glider,
        notes: p.be || f.notes,
        startTime: f.startTime || p.sz || "",
        endTime:   f.endTime   || p.lz || "",
        durationStr: f.durationStr || p.dur || "",
        durationSec: f.durationSec || durationSec,
        maxAlt: f.maxAlt || +(p.hm||0),
        totalDist: f.totalDist || parseFloat(p.dk||0)||0,
        maxClimb: f.maxClimb || +(p.mst||0),
        startAlt: f.startAlt || +(p.msa||0),
        endAlt: f.endAlt || +(p.ml||0),
        startPt: f.startPt || (p.sLat&&p.sLon ? {lat:+p.sLat,lon:+p.sLon,gpsAlt:+(p.msa||0)} : null),
        endPt:   f.endPt   || (p.lLat&&p.lLon ? {lat:+p.lLat,lon:+p.lLon,gpsAlt:+(p.ml||0)}  : null),
        customFields: {
          ...(f.customFields||{}),
          passagier: p.pa || f.customFields?.passagier || "",
          landung: p.la || f.customFields?.landung || "",
          distKm: p.dk || "", kmh: p.kmh || "",
          hDiff: p.hd || "", hMax: p.hm || "", hGew: p.hg || "",
          maxSinken: p.ms || f.customFields?.maxSinken || "",
          maxSteigen: p.mst || f.customFields?.maxSteigen || "",
          msa: p.msa||"", ml: p.ml||"", dk: p.dk||"",
        }
      };
    });
    for (const [nr, p] of Object.entries(DATA)) {
      if (!existingNames.has(nr)) {
        const entry = createFlightFromPDF(nr, p);
        await saveFlight(entry); newEntries.push(entry);
      }
    }
    for (const f of updatedFlights) {
      const num = (f.name||"").match(/\d+/)?.[0];
      if (num && DATA[num]) await saveFlight(f);
    }
    const allFlights = [...updatedFlights, ...newEntries]
      .sort((a,b)=>(parseInt((b.name||"").match(/\d+/)?.[0]||"0",10))-(parseInt((a.name||"").match(/\d+/)?.[0]||"0",10)));
    setFlights(allFlights);
    if (selected) { const u=allFlights.find(f=>f.id===selected.id); if(u){setSelected(u);setInlinePassagier(u.customFields?.passagier||"");} }
    setPdfResult({ matched: updated+newEntries.length, created: newEntries.length, total: Object.keys(DATA).length });
  }, [flights, selected, saveFlight]);

  const parseCSV = (text) => {
    const lines = text.split(/\r?\n/);
    const results = {};
    const lv03 = (E,N) => {
      const y=(E-600000)/1e6, x=(N-200000)/1e6;
      const lat=(16.9023892+3.238272*x-0.270978*y*y-0.002528*x*x-0.0447*y*y*x-0.0140*x*x*x)*100/36;
      const lon=(2.6779094+4.728982*y+0.791484*y*x+0.1306*y*x*x-0.0436*y*y*y)*100/36;
      return [+lat.toFixed(6),+lon.toFixed(6)];
    };
    const coords = (c1,c2) => {
      try { const a=+c1.trim(),b=+c2.trim(); if(!isNaN(a)&&!isNaN(b)&&a!==0){ return Math.abs(a)>90?lv03(a,b):[+a.toFixed(6),+b.toFixed(6)]; } } catch {}
      return [null,null];
    };
    const cleanLoc = s => { const m=s.match(/,\s*[-]?\d/); return m?s.slice(0,m.index).trim().replace(/,+$/,"").trim():s.trim(); };
    const parseRow = row => {
      const fields=[]; let cur="", inQ=false;
      for(let i=0;i<row.length;i++){
        const c=row[i];
        if(c==='"'){inQ=!inQ;} else if(c===","&&!inQ){fields.push(cur.trim());cur="";}
        else cur+=c;
      }
      fields.push(cur.trim()); return fields;
    };
    for(const line of lines){
      const r=parseRow(line);
      if(!r[0]||!/^\d+$/.test(r[0].trim())) continue;
      while(r.length<53) r.push("");
      const nr=r[0].trim();
      if(!r[5]) continue;
      const [sLat,sLon]=coords(r[12],r[13]);
      const [lLat,lLon]=coords(r[25],r[26]);
      const sz=r[6].trim(), lz=r[20].trim();
      results[nr]={d:r[5].trim(),sz:sz==="—"?"":sz,lz:lz==="—"?"":lz,
        st:cleanLoc(r[10]),la:cleanLoc(r[23]),
        sLat,sLon,lLat,lLon,
        dur:r[34]||"",dk:r[37],sl:r[33]||"",kmh:r[38],hd:r[39],msa:r[40],ml:r[41],hm:r[42],hg:r[44],
        ms:r[45],mst:r[46],ge:r[47],pa:r[48],be:r[52]||""};
    }
    return results;
  };

  const importPDFFile = useCallback(async (file) => {
    if (!file) return;
    setPdfDragOver(false);
    if (file.name.toLowerCase().endsWith(".csv")) {
      setPdfResult({ loading: true });
      try {
        const text = await file.text();
        const parsed = parseCSV(text);
        if (Object.keys(parsed).length===0) { setPdfResult({error:"Keine Flüge in CSV erkannt"}); return; }
        await applyParsedData(parsed);
      } catch(e) { setPdfResult({error:"CSV Fehler: "+e.message}); }
    } else {
      await applyParsedData(PDF_DATA);
    }
  }, [applyParsedData]);

  const doImport = useCallback(async (igcFiles) => {
    if (!igcFiles.length) return;
    setImporting(true); setImportProgress({done:0,total:igcFiles.length});
    const toImport = []; const dups = [];
    const existingNames = new Set(flights.map(f=>f.name||""));
    for (const file of igcFiles) {
      const baseName = file.name.replace(/\.igc$/i,"");
      if (existingNames.has(baseName)) dups.push(file);
      else toImport.push(file);
    }
    if (dups.length) { setPendingDups({confirmed:[...toImport],ask:dups}); setDupWarning(dups.map(f=>f.name).join(", ")); setImporting(false); setImportProgress(null); return; }
    await processIGCFiles(toImport);
  }, [flights]);

  const processIGCFiles = useCallback(async (igcFiles) => {
    setImporting(true); setImportProgress({done:0,total:igcFiles.length});
    const newFlights = [];
    for (let i=0; i<igcFiles.length; i++) {
      const file = igcFiles[i];
      const text = await file.text();
      const { track, date } = parseIGC(text);
      const igcData = analyzeIGC(track);
      const baseName = file.name.replace(/\.igc$/i,"");
      const existing = flights.find(f=>f.name===baseName);
      // Parse date
      const dateParts = date.split(".");
      let yr="", mo="", dateStr=date;
      if(dateParts.length===3){yr=dateParts[2];mo=dateParts[1];dateStr=date;}
      if (existing) {
        const updated = { ...existing, track, pdfOnly:false };
        await saveFlight(updated);
        setFlights(prev=>prev.map(f=>f.id===updated.id?updated:f));
        if(selected?.id===updated.id) setSelected(updated);
      } else {
        const newF = { id:`igc_${baseName}_${Date.now()}`, name:baseName, pdfOnly:false,
          date:dateStr, rawDate:date, year:yr, month:mo, pilot:"",site:"",glider:"",
          startTime:"", endTime:"", comment:"", rating:0, notes:"", customFields:{passagier:"",landung:""},
          ...igcData, startPt:igcData.startPt, endPt:igcData.endPt };
        await saveFlight(newF);
        newFlights.push(newF);
      }
      setImportProgress({done:i+1,total:igcFiles.length});
    }
    if (newFlights.length) setFlights(prev=>[...newFlights,...prev].sort((a,b)=>(parseInt((b.name||"").match(/\d+/)?.[0]||"0",10))-(parseInt((a.name||"").match(/\d+/)?.[0]||"0",10))));
    setImporting(false); setImportProgress(null);
  }, [flights, selected, saveFlight]);

  const importIGCFiles = useCallback(async (files) => {
    const igc = files.filter(f=>f.name.toLowerCase().endsWith(".igc"));
    if (!igc.length) return;
    await doImport(igc);
  }, [doImport]);


  const saveEdit = useCallback(async () => {
    if (!selected) return;
    const updated = { ...selected, ...editData,
      customFields: { ...(selected.customFields||{}), ...(editData.customFields||{}) } };
    await saveFlight(updated);
    setFlights(prev=>prev.map(f=>f.id===updated.id?updated:f));
    setSelected(updated); setView("detail");
  }, [selected, editData, saveFlight]);

  // Grouped flights
  const filteredFlights = matchFlights(flights, filterText);
  const years = [...new Set(filteredFlights.map(f=>f.year).filter(Boolean))].sort((a,b)=>b-a);
  const noYear = filteredFlights.filter(f=>!f.year);
  const parseDurForList = s => { if(!s)return 0; const a=s.match(/(\d+):(\d{2}):(\d{2})/); if(a)return+a[1]*3600+ +a[2]*60+ +a[3]; const b=s.match(/(\d+):(\d{2})/); if(b)return+b[1]*60+ +b[2]; const c=s.match(/(\d+)h\s*(\d+)m/); if(c)return+c[1]*3600+ +c[2]*60; return 0; };
  const getDurFlight = f => f.durationSec || parseDurForList(f.durationStr);
  const longestId = flights.length ? flights.reduce((a,b)=>getDurFlight(a)>getDurFlight(b)?a:b).id : null;

  if (view==="season") return <SeasonDash flights={flights} onBack={()=>setView("list")} pdfData={PDF_DATA} />;

  // ── DETAIL VIEW ─────────────────────────────────────────────────────────
  if (view==="detail" && selected && isWide) {
    return (
      <div style={{display:"flex",minHeight:"100vh",background:"#0a1628"}}>
        <SidebarList flights={flights} selectedId={selected.id} longestId={longestId}
          onSelect={f=>{setSelected(f);setInlinePassagier(f.customFields?.passagier||"");}} />
        <div style={{flex:1,minWidth:0}}>
          <DetailContent fl={selected} flights={flights} customFieldDefs={customFieldDefs}
            setFlights={setFlights} setSelected={setSelected} setView={setView}
            setInlinePassagier={setInlinePassagier} setEditData={setEditData}
            saveFlight={saveFlight} showFieldEditor={showFieldEditor} setShowFieldEditor={setShowFieldEditor}
            handleSaveFields={handleSaveFields} confirmDelete={confirmDelete} setConfirmDelete={setConfirmDelete}
            hideBackButton={true} isWide={true} />
        </div>
      </div>
    );
  }
  if (view==="detail" && selected) {
    return <DetailContent fl={selected} flights={flights} customFieldDefs={customFieldDefs}
      setFlights={setFlights} setSelected={setSelected} setView={setView}
      setInlinePassagier={setInlinePassagier} setEditData={setEditData}
      saveFlight={saveFlight} showFieldEditor={showFieldEditor} setShowFieldEditor={setShowFieldEditor}
      handleSaveFields={handleSaveFields} confirmDelete={confirmDelete} setConfirmDelete={setConfirmDelete}
      isWide={isWide} />;
  }

  // ── EDIT VIEW ────────────────────────────────────────────────────────────
  if (view==="edit" && selected) {
    const fl = selected;
    const manualFields = customFieldDefs.filter(d=>!d.formula);
    return (
      <div style={{maxWidth:480,margin:"0 auto",padding:"0 0 32px"}}>
        <div style={{display:"flex",alignItems:"center",gap:12,padding:"16px 16px 12px"}}>
          <button onClick={()=>setView("detail")} style={{background:"none",border:"none",color:"#7dd3fc",fontSize:22,cursor:"pointer"}}>←</button>
          <span style={{fontWeight:800,fontSize:17}}>{fl.name} bearbeiten</span>
        </div>
        <div style={{padding:"0 16px"}}>
          {[["Name / Titel",editData.name||"","name"],["Startplatz",editData.site||"","site"],
            ["Landeplatz",editData.customFields?.landung||"","landung"],["Schirm",editData.glider||"","glider"]].map(([l,v,k])=>(
            <div key={k} style={{marginBottom:12}}>
              <div style={{fontSize:11,color:"rgba(232,244,253,0.4)",marginBottom:4}}>{l}</div>
              <input value={v} onChange={e=>{
                if(k==="landung") setEditData(d=>({...d,customFields:{...(d.customFields||{}),landung:e.target.value}}));
                else setEditData(d=>({...d,[k]:e.target.value}));
              }}
                style={{width:"100%",background:"rgba(255,255,255,0.07)",border:"1px solid rgba(255,255,255,0.12)",borderRadius:10,padding:"10px 13px",color:"#e8f4fd",fontSize:14,boxSizing:"border-box"}} />
            </div>
          ))}
          <div style={{marginBottom:12}}>
            <div style={{fontSize:11,color:"rgba(232,244,253,0.4)",marginBottom:6}}>Bewertung</div>
            <div style={{display:"flex",gap:6}}>
              {[1,2,3,4,5].map(s=>(
                <button key={s} onClick={()=>setEditData(d=>({...d,rating:s}))}
                  style={{fontSize:22,background:"none",border:"none",cursor:"pointer",color:s<=(editData.rating||0)?"#f59e0b":"rgba(232,244,253,0.2)"}}>★</button>
              ))}
            </div>
          </div>
          <div style={{marginBottom:12}}>
            <div style={{fontSize:11,color:"rgba(232,244,253,0.4)",marginBottom:4}}>Kommentar</div>
            <textarea value={editData.comment||""} onChange={e=>setEditData(d=>({...d,comment:e.target.value}))} rows={3}
              style={{width:"100%",background:"rgba(255,255,255,0.07)",border:"1px solid rgba(255,255,255,0.12)",borderRadius:10,padding:"10px 13px",color:"#e8f4fd",fontSize:13,resize:"vertical",boxSizing:"border-box"}} />
          </div>
          <div style={{marginBottom:16}}>
            <div style={{fontSize:11,color:"rgba(232,244,253,0.4)",marginBottom:4}}>Notizen</div>
            <textarea value={editData.notes||""} onChange={e=>setEditData(d=>({...d,notes:e.target.value}))} rows={2}
              style={{width:"100%",background:"rgba(255,255,255,0.07)",border:"1px solid rgba(255,255,255,0.12)",borderRadius:10,padding:"10px 13px",color:"#e8f4fd",fontSize:13,resize:"vertical",boxSizing:"border-box"}} />
          </div>
          {manualFields.filter(f=>f.id!=="passagier").length>0&&manualFields.filter(f=>f.id!=="passagier").map(f=>(
            <div key={f.id} style={{marginBottom:12}}>
              <div style={{fontSize:11,color:"rgba(232,244,253,0.4)",marginBottom:4}}>{f.name}</div>
              <input value={editData.customFields?.[f.id]||""} onChange={e=>setEditData(d=>({...d,customFields:{...(d.customFields||{}),[f.id]:e.target.value}}))} type={f.type==="number"?"number":f.type==="date"?"date":"text"}
                style={{width:"100%",background:"rgba(255,255,255,0.07)",border:"1px solid rgba(255,255,255,0.12)",borderRadius:10,padding:"10px 13px",color:"#e8f4fd",fontSize:14,boxSizing:"border-box"}} />
            </div>
          ))}
          <button onClick={()=>setShowFieldEditor(true)} style={{width:"100%",background:"rgba(139,92,246,0.1)",color:"#c4b5fd",border:"1px solid rgba(139,92,246,0.22)",borderRadius:12,padding:12,fontSize:13,fontWeight:600,cursor:"pointer",marginBottom:14}}>
            ⚙️ Felder verwalten
          </button>
          <button onClick={saveEdit} style={{width:"100%",background:"linear-gradient(135deg,#0ea5e9,#0284c7)",color:"#fff",border:"none",borderRadius:13,padding:14,fontSize:15,fontWeight:800,cursor:"pointer"}}>Speichern</button>
        </div>
        {showFieldEditor&&<FieldEditor customFieldDefs={customFieldDefs} onSave={handleSaveFields} onClose={()=>setShowFieldEditor(false)} />}
      </div>
    );
  }

  // ── LIST VIEW ─────────────────────────────────────────────────────────────
  return (
    <div style={{maxWidth:isWide?900:480,margin:"0 auto",minHeight:"100vh",background:"#0a1628",color:"#e8f4fd",fontFamily:"-apple-system,BlinkMacSystemFont,sans-serif"}}>
      <input ref={fileRef} type="file" accept=".igc" multiple style={{display:"none"}} onChange={e=>importIGCFiles(Array.from(e.target.files))} />
      <input ref={pdfFileRef} type="file" accept=".pdf,.csv" style={{display:"none"}} onChange={e=>e.target.files[0]&&importPDFFile(e.target.files[0])} />

      {/* Header */}
      <div style={{background:"rgba(255,255,255,0.03)",borderBottom:"1px solid rgba(255,255,255,0.06)",padding:"14px 16px 12px",display:"flex",alignItems:"center",justifyContent:"space-between",position:"sticky",top:0,zIndex:10,backdropFilter:"blur(10px)"}}>
        <span style={{fontWeight:900,fontSize:18,letterSpacing:-0.5}}>✈️ Flugbuch</span>
        <div style={{display:"flex",gap:8}}>
          <button onClick={addNewFlight} style={{background:"rgba(34,197,94,0.15)",color:"#4ade80",border:"1px solid rgba(34,197,94,0.25)",borderRadius:20,padding:"7px 12px",fontSize:12,fontWeight:700,cursor:"pointer"}}>+ Flug</button>
          <button
            onClick={()=>setCollapsedYears(s=>s.size===0?new Set(years):new Set())}
            title={collapsedYears.size===0?"Alle reduzieren":"Alle erweitern"}
            style={{background:"rgba(255,255,255,0.07)",border:"1px solid rgba(255,255,255,0.1)",borderRadius:20,padding:"7px 10px",color:"rgba(232,244,253,0.6)",fontSize:11,fontWeight:700,cursor:"pointer",letterSpacing:1}}>
            {collapsedYears.size===0?"⊟⊟":"⊞⊞"}
          </button>
          <button onClick={()=>setView("season")} style={{background:"rgba(245,158,11,0.15)",color:"#fcd34d",border:"1px solid rgba(245,158,11,0.25)",borderRadius:20,padding:"7px 12px",fontSize:12,fontWeight:700,cursor:"pointer"}}>📊 Saison</button>
        </div>
      </div>

      {/* Backup + selection badges, all in one row, icon-only */}
      <input ref={backupFileRef} type="file" accept=".json" style={{display:"none"}}
        onChange={e=>{ if(e.target.files[0]) importBackup(e.target.files[0]); e.target.value=""; }} />
      <div style={{padding:"8px 16px 0",display:"flex",gap:8,alignItems:"center"}}>
        <button onClick={exportBackup} title="In iCloud sichern"
          style={{flex:1,background:"rgba(255,255,255,0.05)",border:"1px solid rgba(255,255,255,0.1)",borderRadius:10,padding:"9px 6px",color:"rgba(232,244,253,0.7)",fontSize:16,cursor:"pointer",textAlign:"center"}}>
          ☁️
        </button>
        <button onClick={()=>backupFileRef.current?.click()} title="Backup importieren"
          style={{flex:1,background:"rgba(255,255,255,0.05)",border:"1px solid rgba(255,255,255,0.1)",borderRadius:10,padding:"9px 6px",color:"rgba(232,244,253,0.7)",fontSize:16,cursor:"pointer",textAlign:"center"}}>
          ⬆
        </button>
        <button onClick={()=>{ setSelectMode(m=>!m); setSelectedIds(new Set()); setCopyMsg(""); }} title="Flüge auswählen"
          style={{flex:1,background:selectMode?"rgba(14,165,233,0.18)":"rgba(255,255,255,0.05)",border:`1px solid ${selectMode?"rgba(14,165,233,0.4)":"rgba(255,255,255,0.1)"}`,borderRadius:10,padding:"9px 6px",color:selectMode?"#7dd3fc":"rgba(232,244,253,0.7)",fontSize:16,cursor:"pointer",textAlign:"center"}}>
          {selectMode?"✕":"☑"}
        </button>
        {selectMode && (
          <button onClick={async()=>{
              if (!selectedIds.size) { setCopyMsg("Keine Flüge ausgewählt."); return; }
              const chosen = flights.filter(f=>selectedIds.has(f.id));
              const rows = chosen.map(flightToCsvRow).join("\r\n");
              try {
                // Numbers (and most spreadsheet apps) only recognise pasted text as a
                // table when it comes with an HTML <table> clipboard representation —
                // plain tab-separated text alone often gets pasted as one blob per cell.
                const escapeHtml = s => String(s).replace(/&/g,"&amp;").replace(/</g,"&lt;").replace(/>/g,"&gt;");
                const cellStyle = "font-family:Helvetica,sans-serif;font-size:10px;font-weight:normal;text-align:left;";
                const htmlTable = `<table style="${cellStyle}">` + chosen.map(f => {
                  const cols = flightToCsvRow(f).split("\t");
                  return "<tr>" + cols.map((c,i) => i===0
                    ? `<th style="${cellStyle}">${escapeHtml(c)}</th>`
                    : `<td style="${cellStyle}">${escapeHtml(c)}</td>`
                  ).join("") + "</tr>";
                }).join("") + "</table>";

                if (navigator.clipboard && window.ClipboardItem) {
                  const item = new ClipboardItem({
                    "text/plain": new Blob([rows], {type:"text/plain"}),
                    "text/html": new Blob([htmlTable], {type:"text/html"}),
                  });
                  await navigator.clipboard.write([item]);
                } else {
                  await navigator.clipboard.writeText(rows);
                }
                setCopyMsg(`✓ ${chosen.length} Flug${chosen.length!==1?"e":""} kopiert.`);
              } catch (e) {
                setCopyMsg("Fehler: " + e.message);
              }
            }}
            title="Auswahl kopieren"
            style={{flex:1,background:"rgba(34,197,94,0.15)",border:"1px solid rgba(34,197,94,0.3)",borderRadius:10,padding:"9px 6px",color:"#4ade80",fontSize:13,fontWeight:700,cursor:"pointer",textAlign:"center"}}>
            📋 {selectedIds.size}
          </button>
        )}
        {selectMode && (
          <button onClick={()=>{
              if (!selectedIds.size) { setCopyMsg("Keine Flüge ausgewählt."); return; }
              setConfirmBulkDelete(true);
            }}
            title="Auswahl löschen"
            style={{flex:1,background:"rgba(239,68,68,0.15)",border:"1px solid rgba(239,68,68,0.3)",borderRadius:10,padding:"9px 6px",color:"#f87171",fontSize:13,fontWeight:700,cursor:"pointer",textAlign:"center"}}>
            🗑 {selectedIds.size}
          </button>
        )}
      </div>
      {confirmBulkDelete && (
        <div onClick={()=>setConfirmBulkDelete(false)}
          style={{position:"fixed",inset:0,background:"rgba(0,0,0,0.6)",display:"flex",alignItems:"center",justifyContent:"center",zIndex:200,padding:24}}>
          <div onClick={e=>e.stopPropagation()}
            style={{background:"#14253a",borderRadius:16,padding:"20px 22px",maxWidth:320,width:"100%",border:"1px solid rgba(255,255,255,0.1)"}}>
            <div style={{fontSize:16,fontWeight:700,marginBottom:6}}>{selectedIds.size} Flüge löschen?</div>
            <div style={{fontSize:13,color:"rgba(232,244,253,0.6)",marginBottom:18}}>Diese Aktion kann nicht rückgängig gemacht werden.</div>
            <div style={{display:"flex",gap:10}}>
              <button onClick={()=>setConfirmBulkDelete(false)}
                style={{flex:1,background:"rgba(255,255,255,0.08)",border:"1px solid rgba(255,255,255,0.12)",borderRadius:10,padding:"10px",color:"#e8f4fd",fontSize:14,cursor:"pointer"}}>Abbrechen</button>
              <button onClick={async()=>{
                  const ids = [...selectedIds];
                  for (const id of ids) {
                    try { await window.storage.delete(`flight:${id}`); } catch {}
                  }
                  setFlights(prev=>prev.filter(f=>!selectedIds.has(f.id)));
                  setCopyMsg(`✓ ${ids.length} Flug${ids.length!==1?"e":""} gelöscht.`);
                  setSelectedIds(new Set());
                  setConfirmBulkDelete(false);
                  setSelectMode(false);
                }}
                style={{flex:1,background:"rgba(239,68,68,0.2)",border:"1px solid rgba(239,68,68,0.4)",borderRadius:10,padding:"10px",color:"#f87171",fontSize:14,fontWeight:700,cursor:"pointer"}}>Löschen</button>
            </div>
          </div>
        </div>
      )}
      {(backupMsg || copyMsg) && (
        <div style={{padding:"6px 16px 0",fontSize:11,color:(backupMsg||copyMsg).startsWith("✓")?"#4ade80":"#f87171"}}>
          {backupMsg || copyMsg}
        </div>
      )}

      {/* PDF result toast */}
      {pdfResult&&(
        <div style={{margin:"10px 16px 0",background:pdfResult.error?"rgba(239,68,68,0.08)":"rgba(139,92,246,0.12)",border:`1px solid ${pdfResult.error?"rgba(239,68,68,0.3)":"rgba(139,92,246,0.25)"}`,borderRadius:12,padding:"10px 14px",display:"flex",justifyContent:"space-between",alignItems:"center"}}>
          <span style={{fontSize:13,color:pdfResult.error?"#f87171":"#c4b5fd"}}>
            {pdfResult.loading ? "⏳ Wird geladen…" : pdfResult.error ? "❌ "+pdfResult.error :
              "✅ "+( (pdfResult.created>0?pdfResult.created+" neu  ":"") + (pdfResult.matched-(pdfResult.created||0)>0?(pdfResult.matched-(pdfResult.created||0))+" aktualisiert":"") + " ("+pdfResult.total+" erkannt)" )}
          </span>
          {!pdfResult.loading&&<button onClick={()=>setPdfResult(null)} style={{background:"none",border:"none",color:"rgba(196,181,253,0.5)",cursor:"pointer",fontSize:16}}>✕</button>}
        </div>
      )}

      {/* Dup warning */}
      {dupWarning&&(
        <div style={{margin:"10px 16px 0",background:"rgba(245,158,11,0.1)",border:"1px solid rgba(245,158,11,0.3)",borderRadius:12,padding:"12px 14px"}}>
          <div style={{fontSize:13,color:"#fcd34d",marginBottom:8}}>⚠️ Bereits vorhanden: {dupWarning}</div>
          <div style={{display:"flex",gap:8}}>
            <button onClick={async()=>{setDupWarning(null);await processIGCFiles([...pendingDups.confirmed,...pendingDups.ask]);}}
              style={{flex:1,background:"rgba(245,158,11,0.2)",border:"1px solid rgba(245,158,11,0.4)",borderRadius:10,padding:"8px",color:"#fcd34d",fontSize:12,cursor:"pointer"}}>Überschreiben</button>
            <button onClick={async()=>{setDupWarning(null);if(pendingDups.confirmed.length)await processIGCFiles(pendingDups.confirmed);}}
              style={{flex:1,background:"rgba(255,255,255,0.06)",border:"1px solid rgba(255,255,255,0.12)",borderRadius:10,padding:"8px",color:"rgba(232,244,253,0.6)",fontSize:12,cursor:"pointer"}}>Überspringen</button>
          </div>
        </div>
      )}

      {/* Search + Sort, one row */}
      <div style={{padding:"12px 16px 6px",position:"relative"}}>
        <div style={{display:"flex",gap:8}}>
          <div style={{flex:"1 1 40%",position:"relative"}}>
            <input value={filterText} onChange={e=>setFilterText(e.target.value)} placeholder="🔍 Suchen…"
              style={{width:"100%",background:"rgba(255,255,255,0.07)",border:"1px solid rgba(255,255,255,0.1)",borderRadius:10,padding:"8px 30px 8px 12px",color:"#e8f4fd",fontSize:13,boxSizing:"border-box"}} />
            {filterText&&<button onClick={()=>setFilterText("")} style={{position:"absolute",right:8,top:"50%",transform:"translateY(-50%)",background:"none",border:"none",color:"rgba(232,244,253,0.4)",cursor:"pointer",fontSize:14}}>✕</button>}
          </div>
          <button onClick={()=>setShowSortMenu(s=>!s)}
            style={{flex:"1 1 40%",display:"flex",justifyContent:"space-between",alignItems:"center",background:"rgba(255,255,255,0.06)",border:"1px solid rgba(255,255,255,0.1)",borderRadius:10,padding:"8px 12px",color:"rgba(232,244,253,0.8)",fontSize:12,cursor:"pointer",minWidth:0}}>
            <span style={{overflow:"hidden",textOverflow:"ellipsis",whiteSpace:"nowrap"}}>⇅ {SORT_OPTIONS.find(o=>o.id===sortId)?.label||"—"}</span>
            <span style={{flexShrink:0,marginLeft:4}}>{showSortMenu?"▾":"▸"}</span>
          </button>
          <button onClick={()=>setSortDir(d=>d==="asc"?"desc":"asc")}
            title={sortDir==="asc"?"Aufsteigend":"Absteigend"}
            style={{flexShrink:0,background:"rgba(255,255,255,0.06)",border:"1px solid rgba(255,255,255,0.1)",borderRadius:10,padding:"8px 14px",color:"#7dd3fc",fontSize:14,cursor:"pointer"}}>
            {sortDir==="asc"?"↑":"↓"}
          </button>
        </div>
        {showFilterHelp && (
          <div style={{marginTop:8,background:"rgba(125,211,252,0.07)",border:"1px solid rgba(125,211,252,0.2)",borderRadius:10,padding:"10px 12px",fontSize:11,lineHeight:1.6,color:"rgba(232,244,253,0.7)"}}>
            <div style={{fontWeight:700,color:"#7dd3fc",marginBottom:4}}>Filter-Syntax</div>
            <div><b>UND</b> / <b>ODER</b> — z.B. <code>Fiesch ODER Rigi</code></div>
            <div><b>+wort</b> muss / <b>-wort</b> darf nicht — z.B. <code>2026 -tandem</code></div>
            <div><b>feld:wert</b> — <code>site:Fiesch</code>, <code>schirm:Wisp</code>, <code>pilot:…</code></div>
            <div><b>feld&gt;wert</b> / <b>&lt;</b> / <b>&gt;=</b> — <code>dauer&gt;2</code> (h), <code>dist&gt;30</code> (km), <code>höhe&gt;3000</code> (m), <code>rating&gt;=4</code>, <code>jahr&gt;2020</code></div>
            <div style={{marginTop:4,opacity:0.7}}>Kombinierbar: <code>site:Fiesch UND dauer&gt;2 -tandem</code></div>
          </div>
        )}
        {showSortMenu && (
          <div style={{marginTop:6,background:"#14253a",border:"1px solid rgba(255,255,255,0.12)",borderRadius:12,padding:6,maxHeight:280,overflowY:"auto",boxShadow:"0 8px 24px rgba(0,0,0,0.4)"}}>
            {SORT_OPTIONS.map(o=>(
              <div key={o.id} onClick={()=>{setSortId(o.id);setShowSortMenu(false);}}
                style={{padding:"9px 12px",borderRadius:8,fontSize:13,cursor:"pointer",color:o.id===sortId?"#7dd3fc":"rgba(232,244,253,0.75)",background:o.id===sortId?"rgba(14,165,233,0.15)":"transparent"}}>
                {o.label}
              </div>
            ))}
          </div>
        )}
      </div>

      {/* Drop zones */}
      <div style={{margin:"8px 16px",display:"flex",gap:10}}>
        <div onDragOver={e=>{e.preventDefault();setPdfDragOver(true)}} onDragLeave={()=>setPdfDragOver(false)}
          onDrop={e=>{e.preventDefault();e.dataTransfer.files[0]&&importPDFFile(e.dataTransfer.files[0]);}}
          onClick={()=>pdfFileRef.current?.click()}
          style={{flex:1,border:`2px dashed ${pdfDragOver?"#7dd3fc":"rgba(56,189,248,0.25)"}`,borderRadius:12,padding:"10px 8px",textAlign:"center",background:pdfDragOver?"rgba(56,189,248,0.08)":"transparent",cursor:"pointer",display:"flex",flexDirection:"column",alignItems:"center",justifyContent:"center",gap:3}}>
          <div style={{fontSize:15}}>📋</div>
          <div style={{color:pdfDragOver?"#7dd3fc":"rgba(125,211,252,0.5)",fontSize:10}}>CSV/PDF</div>
        </div>
        <div onDragOver={e=>{e.preventDefault();setDragOver(true)}} onDragLeave={()=>setDragOver(false)}
          onDrop={e=>{e.preventDefault();setDragOver(false);importIGCFiles(Array.from(e.dataTransfer.files));}}
          onClick={()=>fileRef.current?.click()}
          style={{flex:1,border:`2px dashed ${dragOver?"#fcd34d":"rgba(245,158,11,0.25)"}`,borderRadius:12,padding:"10px 8px",textAlign:"center",background:dragOver?"rgba(245,158,11,0.08)":"transparent",cursor:"pointer",display:"flex",flexDirection:"column",alignItems:"center",justifyContent:"center",gap:3}}>
          <div style={{fontSize:15}}>📂</div>
          <div style={{color:dragOver?"#fcd34d":"rgba(252,211,77,0.5)",fontSize:10}}>
            {importProgress ? `⏳ ${importProgress.done}/${importProgress.total}` : importing?"⏳ Importiere…":"IGC"}
          </div>
        </div>
        <div onClick={()=>setShowRowImport(s=>!s)}
          style={{flex:1,border:`2px dashed ${showRowImport?"#4ade80":"rgba(74,222,128,0.25)"}`,borderRadius:12,padding:"10px 8px",textAlign:"center",background:showRowImport?"rgba(74,222,128,0.08)":"transparent",cursor:"pointer",display:"flex",flexDirection:"column",alignItems:"center",justifyContent:"center",gap:3}}>
          <div style={{fontSize:15}}>📝</div>
          <div style={{color:showRowImport?"#4ade80":"rgba(134,239,172,0.5)",fontSize:10}}>Zellen</div>
        </div>
      </div>


      {/* Multi row import */}
      <div style={{margin:"0 16px 10px"}}>
        {showRowImport && (
          <div style={{marginTop:6,background:"rgba(255,255,255,0.04)",border:"1px solid rgba(255,255,255,0.08)",borderRadius:10,padding:10}}>
            <textarea value={rowImportText} onChange={e=>setRowImportText(e.target.value)}
              placeholder="Eine oder mehrere Zeilen aus Numbers/Excel/CSV hier einfügen (eine Zeile pro Flug, gleiche Spalten wie Flugbuch-CSV)…"
              style={{width:"100%",minHeight:90,background:"rgba(255,255,255,0.06)",border:"1px solid rgba(255,255,255,0.1)",borderRadius:8,padding:8,color:"#e8f4fd",fontSize:11,fontFamily:"monospace",boxSizing:"border-box",resize:"vertical"}} />
            {rowImportText.trim() && (()=>{
              const rows = parseMultipleRows(rowImportText);
              if (!rows.length) return null;
              const okCount = rows.filter(r=>r.p && r.p._colCount>=40).length;
              const badCount = rows.length - okCount;
              return (
                <div style={{marginTop:6,fontSize:10,lineHeight:1.6}}>
                  <div style={{color:okCount>0?"rgba(74,222,128,0.8)":"rgba(248,113,113,0.8)"}}>
                    {rows.length} Zeile{rows.length!==1?"n":""} erkannt · {okCount} gültig{badCount>0?` · ${badCount} fehlerhaft`:""}
                  </div>
                  {rows.map((r,i)=>{
                    const ok = r.p && r.p._colCount>=40;
                    return (
                      <div key={i} style={{color:ok?"rgba(232,244,253,0.4)":"rgba(248,113,113,0.7)"}}>
                        Zeile {i+1}: {ok ? `✓ Flug ${r.p._nr||"(auto)"} — ${r.p.st||"—"}` : `✗ ${r.error || (r.p ? r.p._colCount+" Spalten (erwartet ≥40)" : "Fehler")}`}
                      </div>
                    );
                  })}
                </div>
              );
            })()}
            {rowImportError && <div style={{color:"#f87171",fontSize:11,marginTop:6}}>{rowImportError}</div>}
            <button onClick={()=>{
                if(!rowImportText.trim()){ setRowImportError("Bitte mindestens eine Zeile einfügen."); return; }
                const rows = parseMultipleRows(rowImportText);
                const valid = rows.filter(r=>r.p && r.p._colCount>=40);
                if (!valid.length) {
                  setRowImportError("Keine gültige Zeile gefunden. Bitte die komplette(n) Zeile(n) mit allen Spalten einfügen, inkl. leerer Zellen.");
                  return;
                }
                try {
                  let maxNr = flights.reduce((m,f)=>{
                    const n = parseInt((f.name||"").match(/\d+/)?.[0]||"0",10);
                    return n>m?n:m;
                  }, 0);
                  const newFlights = [];
                  for (const r of valid) {
                    const parsedNr = parseInt((r.p._nr||"").match(/\d+/)?.[0]||"",10);
                    let nr;
                    if (parsedNr) { nr = String(parsedNr); }
                    else { maxNr += 1; nr = String(maxNr); }
                    const nf = createFlightFromPDF(nr, r.p);
                    saveFlight(nf);
                    newFlights.push(nf);
                  }
                  setFlights(prev => {
                    const merged = [...newFlights, ...prev];
                    return merged.sort((a,b)=>
                      (parseInt((b.name||"").match(/\d+/)?.[0]||"0",10)) - (parseInt((a.name||"").match(/\d+/)?.[0]||"0",10)));
                  });
                  setRowImportText(""); setRowImportError(""); setShowRowImport(false);
                  if (newFlights.length === 1) {
                    setSelected(newFlights[0]); setInlinePassagier(newFlights[0].customFields?.passagier||""); setView("detail");
                  }
                } catch(e) { setRowImportError("Fehler beim Verarbeiten: "+e.message); }
              }}
              style={{marginTop:8,width:"100%",background:"rgba(34,197,94,0.15)",border:"1px solid rgba(34,197,94,0.3)",borderRadius:8,padding:"8px",color:"#4ade80",fontSize:13,fontWeight:700,cursor:"pointer"}}>
              + Flüge aus Zeile(n) erstellen
            </button>
          </div>
        )}
      </div>

      {/* Flight list */}
      <div style={{padding:"4px 0 16px"}}>
        {flights.length===0&&(
          <div style={{textAlign:"center",padding:"60px 20px",color:"rgba(232,244,253,0.25)"}}>
            <div style={{fontSize:48,marginBottom:12}}>✈️</div>
            <div style={{fontSize:16,fontWeight:600,marginBottom:6}}>Noch keine Flüge</div>
            <div style={{fontSize:13}}>CSV importieren oder IGC-Dateien ablegen</div>
          </div>
        )}
        {sortId !== "date" ? (
          // Flat, year-spanning sort
          <div>
            {(() => {
              const sorted = sortFlights([...filteredFlights, ...noYear.filter(f=>!filteredFlights.includes(f))], sortId, sortDir);
              if (!isWide) {
                return sorted.map(f=>(
                  <FlightRow key={f.id} f={f} isLongest={f.id===longestId} sortId={sortId}
                    selectMode={selectMode} isSelected={selectedIds.has(f.id)}
                    onToggleSelect={id=>setSelectedIds(prev=>{const n=new Set(prev);n.has(id)?n.delete(id):n.add(id);return n;})}
                    onClick={()=>{setSelected(f);setInlinePassagier(f.customFields?.passagier||"");setView("detail");}} />
                ));
              }
              // Wide: render explicit row pairs so left-to-right reading order
              // matches the actual sort order (grid auto-flow would fill column-
              // by-column instead, scrambling the visual order).
              const rows = [];
              for (let i=0;i<sorted.length;i+=2) rows.push([sorted[i], sorted[i+1]]);
              return rows.map((pair,idx)=>(
                <div key={idx} style={{display:"grid",gridTemplateColumns:"1fr 1fr",gap:0}}>
                  {pair.map(f=>f && (
                    <FlightRow key={f.id} f={f} isLongest={f.id===longestId} sortId={sortId}
                      selectMode={selectMode} isSelected={selectedIds.has(f.id)}
                      onToggleSelect={id=>setSelectedIds(prev=>{const n=new Set(prev);n.has(id)?n.delete(id):n.add(id);return n;})}
                      onClick={()=>{setSelected(f);setInlinePassagier(f.customFields?.passagier||"");setView("detail");}} />
                  ))}
                </div>
              ));
            })()}
          </div>
        ) : (<>
        {years.map(yr => {
          const yFlights = sortFlights(filteredFlights.filter(f=>f.year===yr), sortId, sortDir);
          const collapsed = collapsedYears.has(yr);
          const parseDStr = s => { if(!s)return 0; const a=s.match(/(\d+):(\d{2}):(\d{2})/); if(a)return+a[1]*3600+ +a[2]*60+ +a[3]; const b=s.match(/(\d+):(\d{2})/); if(b)return+b[1]*60+ +b[2]; const c=s.match(/(\d+)h\s*(\d+)m/); if(c)return+c[1]*3600+ +c[2]*60; return 0; };
          const yrSec = yFlights.reduce((s,f)=>s+(f.durationSec||parseDStr(f.durationStr)),0);
          const yrH = Math.floor(yrSec/3600), yrM = String(Math.floor((yrSec%3600)/60)).padStart(2,"0");
          const yrBiplace = yFlights.filter(f=>(f.customFields?.passagier||"").trim()).length;
          return (
            <div key={yr}>
              <div onClick={()=>setCollapsedYears(s=>{const n=new Set(s);n.has(yr)?n.delete(yr):n.add(yr);return n;})}
                style={{display:"flex",justifyContent:"space-between",alignItems:"center",padding:"8px 16px",cursor:"pointer",background:"rgba(255,255,255,0.02)",borderBottom:"1px solid rgba(255,255,255,0.04)"}}>
                <span style={{fontWeight:700,color:"#7dd3fc",fontSize:14}}>{yr} · {yFlights.length} Flüge{yrBiplace>0&&<span style={{color:"#fcd34d",fontSize:11,fontWeight:600}}> · {yrBiplace} Biplace</span>}</span>
                <span style={{fontSize:12,color:"rgba(232,244,253,0.35)"}}>{yrH}h{yrM}m {collapsed?"▸":"▾"}</span>
              </div>
              {!collapsed && (isWide ? (
                (() => {
                  const rows = [];
                  for (let i=0;i<yFlights.length;i+=2) rows.push([yFlights[i], yFlights[i+1]]);
                  return rows.map((pair,idx)=>(
                    <div key={idx} style={{display:"grid",gridTemplateColumns:"1fr 1fr",gap:0}}>
                      {pair.map(f=>f && (
                        <FlightRow key={f.id} f={f} isLongest={f.id===longestId} sortId={sortId}
                          selectMode={selectMode} isSelected={selectedIds.has(f.id)}
                          onToggleSelect={id=>setSelectedIds(prev=>{const n=new Set(prev);n.has(id)?n.delete(id):n.add(id);return n;})}
                          onClick={()=>{setSelected(f);setInlinePassagier(f.customFields?.passagier||"");setView("detail");}} />
                      ))}
                    </div>
                  ));
                })()
              ) : (
                yFlights.map(f=>(
                  <FlightRow key={f.id} f={f} isLongest={f.id===longestId} sortId={sortId}
                    selectMode={selectMode} isSelected={selectedIds.has(f.id)}
                    onToggleSelect={id=>setSelectedIds(prev=>{const n=new Set(prev);n.has(id)?n.delete(id):n.add(id);return n;})}
                    onClick={()=>{setSelected(f);setInlinePassagier(f.customFields?.passagier||"");setView("detail");}} />
                ))
              ))}
            </div>
          );
        })}
        {noYear.length>0&&sortFlights(noYear, sortId, sortDir).map(f=>(
          <div key={f.id} onClick={()=>{setSelected(f);setInlinePassagier(f.customFields?.passagier||"");setView("detail");}}
            style={{padding:"11px 16px",borderBottom:"1px solid rgba(255,255,255,0.04)",cursor:"pointer"}}>
            <span style={{fontWeight:700}}>{f.name}</span>
            <span style={{fontSize:12,color:"rgba(232,244,253,0.4)",marginLeft:8}}>{f.site}</span>
          </div>
        ))}
        </>)}
      </div>
      {showFieldEditor&&<FieldEditor customFieldDefs={customFieldDefs} onSave={handleSaveFields} onClose={()=>setShowFieldEditor(false)} />}
    </div>
  );
}
