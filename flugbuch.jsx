const { useState, useEffect, useRef, useCallback, useMemo } = React;

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
// Converts lat/lon to OSM/OpenTopoMap slippy-map tile x/y coordinates at a
// given zoom level. Standard Web Mercator tile math.
function lonLatToTile(lon, lat, zoom) {
  const n = Math.pow(2, zoom);
  const x = (lon + 180) / 360 * n;
  const latRad = lat * Math.PI / 180;
  const y = (1 - Math.log(Math.tan(latRad) + 1/Math.cos(latRad)) / Math.PI) / 2 * n;
  return { x, y };
}

// Picks the smallest zoom level (most zoomed-out, i.e. most tiles fit) that
// still keeps the track's bounding box within a reasonable number of tiles,
// so terrain detail is as high as possible without loading excessive tiles.
// Builds a minimal valid GPX 1.1 track file from a flight's IGC track points,
// so it can be opened in an external map viewer (gpx.studio) that renders
// real map tiles reliably instead of our own hand-drawn canvas tiles.
function buildGpxFromFlight(flight) {
  const track = flight?.track || [];
  if (!track.length) return null;
  const points = track.map(p => {
    const h = Math.floor(p.timeSec/3600)%24, m = Math.floor((p.timeSec%3600)/60), s = p.timeSec%60;
    const timeStr = `${String(h).padStart(2,"0")}:${String(m).padStart(2,"0")}:${String(s).padStart(2,"0")}Z`;
    return `<trkpt lat="${p.lat}" lon="${p.lon}"><ele>${p.gpsAlt}</ele><time>1970-01-01T${timeStr}</time></trkpt>`;
  }).join("");
  return `<?xml version="1.0" encoding="UTF-8"?>
<gpx version="1.1" creator="meinflugApp" xmlns="http://www.topografix.com/GPX/1/1">
  <trk><name>${flight?.name || "Flug"}</name><trkseg>${points}</trkseg></trk>
</gpx>`;
}

function pickZoomForBounds(minLat, maxLat, minLon, maxLon, pixelW, pixelH) {
  for (let z = 15; z >= 5; z--) {
    const p1 = lonLatToTile(minLon, maxLat, z);
    const p2 = lonLatToTile(maxLon, minLat, z);
    const tilesW = Math.abs(p2.x - p1.x);
    const tilesH = Math.abs(p2.y - p1.y);
    // Each OSM/OpenTopoMap tile is 256px — stop zooming in once the bounds
    // would need more screen space than we actually have to render.
    if (tilesW * 256 <= pixelW * 2.2 && tilesH * 256 <= pixelH * 2.2) return z;
  }
  return 5;
}

const tileImageCache = new Map();
function loadTileImageOnce(url) {
  return new Promise((resolve) => {
    const img = new Image();
    img.crossOrigin = "anonymous";
    img.onload = () => resolve(img);
    img.onerror = () => resolve(null);
    img.src = url;
  });
}
function loadTileImage(url) {
  if (tileImageCache.has(url)) return tileImageCache.get(url);
  // OpenTopoMap occasionally rejects/drops individual tile requests under
  // load (the service has limited capacity and no guaranteed SLA), which
  // showed up as random missing tiles even though the surrounding tiles
  // loaded fine. A couple of short-delayed retries recovers most of these
  // without meaningfully slowing down the common case where tiles load on
  // the first try.
  const promise = (async () => {
    for (let attempt = 0; attempt < 3; attempt++) {
      if (attempt > 0) await new Promise(r => setTimeout(r, 400 * attempt));
      const img = await loadTileImageOnce(attempt === 0 ? url : url + (url.includes("?") ? "&" : "?") + "retry=" + attempt);
      if (img) return img;
    }
    return null;
  })();
  tileImageCache.set(url, promise);
  return promise;
}

function FlightMap({ flight }) {
  const canvasRef = useRef(null);
  const fullCanvasRef = useRef(null);
  const [isFullscreen, setIsFullscreen] = useState(false);

  const draw = (canvas, isFullscreenCanvas) => {
    if (!canvas) return () => {};
    let cancelled = false;
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
      // No IGC track at all — leave the canvas as an empty field in the
      // Flugbuch app's own base blue, rather than showing a placeholder
      // message or terrain tiles that don't apply here.
      ctx.fillStyle = "#040e20"; ctx.fillRect(0,0,W,H);
      return () => { cancelled = true; };
    }

    const pts = track.length ? track : [sP,eP].filter(Boolean);
    // A single noisy/erroneous GPS fix in the IGC file (common near the edges
    // of a recording) can sit far outside the real flight area and blow up
    // the whole bounding box, forcing a huge zoomed-out area full of empty/
    // missing tiles. Filter out points whose lat/lon differ from the median
    // by more than a generous threshold before computing the map bounds.
    function median(arr) {
      const s = [...arr].sort((a,b)=>a-b);
      const mid = Math.floor(s.length/2);
      return s.length % 2 ? s[mid] : (s[mid-1]+s[mid])/2;
    }
    const rawLats = pts.map(p=>p.lat), rawLons = pts.map(p=>p.lon);
    const medLat = median(rawLats), medLon = median(rawLons);
    // ~0.5 degrees is roughly 35-55km depending on latitude — generous enough
    // for any real single flight, but tight enough to reject GPS glitches
    // that jump to another region entirely.
    const MAX_DEV = 0.5;
    const filtered = pts.filter(p => Math.abs(p.lat-medLat) <= MAX_DEV && Math.abs(p.lon-medLon) <= MAX_DEV);
    const cleanPts = filtered.length ? filtered : pts;
    const lats=cleanPts.map(p=>p.lat), lons=cleanPts.map(p=>p.lon);
    const latPad = Math.max((Math.max(...lats)-Math.min(...lats))*0.15, 0.003);
    const lonPad = Math.max((Math.max(...lons)-Math.min(...lons))*0.15, 0.003);
    const minLat=Math.min(...lats)-latPad, maxLat=Math.max(...lats)+latPad;
    const minLon=Math.min(...lons)-lonPad, maxLon=Math.max(...lons)+lonPad;

    const drawTrackAndMarkers = (tx, ty) => {
      if (track.length) {
        const alts=track.map(p=>p.gpsAlt), minA=Math.min(...alts), rng=Math.max(...alts)-minA||1;
        for(let i=1;i<track.length;i++){
          // Fullscreen view: solid red, noticeably thicker, for maximum
          // legibility while zoomed/panned. Small preview: keep the
          // existing altitude-color-coded line as before.
          if (isFullscreenCanvas) {
            ctx.strokeStyle="rgba(255,255,255,0.55)"; ctx.lineWidth=9.5;
            ctx.beginPath(); ctx.moveTo(tx(track[i-1].lon),ty(track[i-1].lat)); ctx.lineTo(tx(track[i].lon),ty(track[i].lat)); ctx.stroke();
            ctx.strokeStyle="#ef4444";
            ctx.lineWidth=5.5; ctx.beginPath();
            ctx.moveTo(tx(track[i-1].lon),ty(track[i-1].lat));
            ctx.lineTo(tx(track[i].lon),ty(track[i].lat));
            ctx.stroke();
          } else {
            const t=(track[i].gpsAlt-minA)/rng;
            ctx.strokeStyle="rgba(255,255,255,0.55)"; ctx.lineWidth=6.5;
            ctx.beginPath(); ctx.moveTo(tx(track[i-1].lon),ty(track[i-1].lat)); ctx.lineTo(tx(track[i].lon),ty(track[i].lat)); ctx.stroke();
            ctx.strokeStyle=`hsl(${200+t*60},85%,${45+t*20}%)`;
            ctx.lineWidth=3.75; ctx.beginPath();
            ctx.moveTo(tx(track[i-1].lon),ty(track[i-1].lat));
            ctx.lineTo(tx(track[i].lon),ty(track[i].lat));
            ctx.stroke();
          }
        }
        drawM(tx(track[0].lon),ty(track[0].lat),"#22c55e","S");
        drawM(tx(track[track.length-1].lon),ty(track[track.length-1].lat),"#ef4444","L");
      } else {
        if(sP) drawM(tx(sP.lon),ty(sP.lat),"#22c55e","S");
        if(eP) drawM(tx(eP.lon),ty(eP.lat),"#ef4444","L");
      }
    };

    (async () => {
      const zoom = pickZoomForBounds(minLat, maxLat, minLon, maxLon, W, H);
      const TILE_PX = 256;
      const p1 = lonLatToTile(minLon, maxLat, zoom);
      const p2 = lonLatToTile(maxLon, minLat, zoom);
      const xMinF = Math.min(p1.x, p2.x), xMaxF = Math.max(p1.x, p2.x);
      const yMinF = Math.min(p1.y, p2.y), yMaxF = Math.max(p1.y, p2.y);
      const xMin = Math.floor(xMinF), xMax = Math.floor(xMaxF);
      const yMin = Math.floor(yMinF), yMax = Math.floor(yMaxF);

      const tilePromises = [];
      for (let xi = xMin; xi <= xMax; xi++) {
        for (let yi = yMin; yi <= yMax; yi++) {
          const url = `https://tile.opentopomap.org/${zoom}/${xi}/${yi}.png`;
          tilePromises.push(loadTileImage(url).then(img => ({ xi, yi, img })));
        }
      }
      const tiles = await Promise.all(tilePromises);
      if (cancelled) return;

      // Standard slippy-map technique: render every tile at its native,
      // whole-pixel position on an offscreen canvas laid out in pure
      // tile-grid space (tile (xMin,yMin) at pixel (0,0), each tile exactly
      // TILE_PX apart) — since every position here is a whole-number
      // multiple of TILE_PX, adjacent tiles are always pixel-perfect
      // adjacent with zero possibility of a rounding-induced gap. Only
      // afterwards do we scale/crop that single flat image onto the visible
      // canvas, which is one clean transform instead of one per tile.
      const gridW = (xMax - xMin + 1) * TILE_PX;
      const gridH = (yMax - yMin + 1) * TILE_PX;
      const offscreen = document.createElement("canvas");
      offscreen.width = gridW;
      offscreen.height = gridH;
      const octx = offscreen.getContext("2d");
      octx.fillStyle = "#3d4552";
      octx.fillRect(0, 0, gridW, gridH);
      let anyLoaded = false;
      tiles.forEach(({ xi, yi, img }) => {
        if (!img) return;
        anyLoaded = true;
        octx.drawImage(img, (xi - xMin) * TILE_PX, (yi - yMin) * TILE_PX, TILE_PX, TILE_PX);
      });

      ctx.clearRect(0,0,W,H);
      let mapDX = 0, mapDY = 0, mapDW = W, mapDH = H;
      if (!anyLoaded) {
        ctx.fillStyle = "#0d1b2a"; ctx.fillRect(0,0,W,H);
      } else {
        // Crop/scale the flat tile grid onto the visible canvas: the visible
        // area corresponds to tile-space [xMinF,xMaxF] x [yMinF,yMaxF],
        // which is some sub-rectangle of the offscreen grid measured in
        // TILE_PX units.
        const srcX = (xMinF - xMin) * TILE_PX, srcY = (yMinF - yMin) * TILE_PX;
        const srcW = (xMaxF - xMinF) * TILE_PX, srcH = (yMaxF - yMinF) * TILE_PX;
        const destAspect = W / H, srcAspect = srcW / srcH;
        // Fit the source rect into the destination canvas preserving aspect
        // ratio (letterboxing handled by drawing full W/H since we already
        // padded lat/lon bounds — this just avoids stretching).
        let dW = W, dH = H;
        if (srcAspect > destAspect) { dH = W / srcAspect; } else { dW = H * srcAspect; }
        const dX = (W - dW) / 2, dY = (H - dH) / 2;
        ctx.drawImage(offscreen, srcX, srcY, srcW, srcH, dX, dY, dW, dH);
        ctx.fillStyle = "rgba(10,22,40,0.12)"; ctx.fillRect(0,0,W,H);
        mapDX = dX; mapDY = dY; mapDW = dW; mapDH = dH;
      }
      // The track/markers must be positioned within the exact same
      // letterboxed rectangle the tile map was just drawn into (mapDX/DY/
      // DW/DH) — using the full W×H canvas here instead (as before) caused
      // the track to drift off-center from the map whenever the tile crop's
      // aspect ratio didn't exactly match the canvas's aspect ratio.
      const sc=Math.min(mapDW/(maxLon-minLon||0.001),mapDH/(maxLat-minLat||0.001));
      const offX=mapDX+(mapDW-(maxLon-minLon)*sc)/2, offY=mapDY+(mapDH-(maxLat-minLat)*sc)/2;
      const tx=lon=>offX+(lon-minLon)*sc;
      const ty=lat=>(offY+(maxLat-minLat)*sc)-(lat-minLat)*sc;
      drawTrackAndMarkers(tx, ty);
    })();

    return () => { cancelled = true; };
  };

  useEffect(() => {
    const cleanup = draw(canvasRef.current);
    return cleanup;
  }, [flight]);

  // Pinch-to-zoom / pan state for the fullscreen map. Implemented as a CSS
  // transform on the canvas element itself (scale + translate) rather than
  // re-drawing at a different resolution on every gesture frame — this is
  // the standard, performant approach for interactive zoom/pan on an image/
  // canvas, and matches how native map viewers feel (immediate, no redraw
  // lag while pinching).
  const [mapTransform, setMapTransform] = useState({ scale: 1, x: 0, y: 0 });
  const gestureRef = useRef(null); // tracks in-progress pinch/pan state between touch events

  const resetMapTransform = () => setMapTransform({ scale: 1, x: 0, y: 0 });

  const dist = (t0, t1) => Math.hypot(t1.clientX-t0.clientX, t1.clientY-t0.clientY);
  const midpoint = (t0, t1) => ({ x:(t0.clientX+t1.clientX)/2, y:(t0.clientY+t1.clientY)/2 });

  const onMapTouchStart = (e) => {
    if (e.touches.length === 2) {
      gestureRef.current = {
        mode: "pinch",
        startDist: dist(e.touches[0], e.touches[1]),
        startScale: mapTransform.scale,
        startMid: midpoint(e.touches[0], e.touches[1]),
        startX: mapTransform.x, startY: mapTransform.y,
      };
    } else if (e.touches.length === 1 && mapTransform.scale > 1) {
      // Only pan with one finger once zoomed in — at scale 1 a single-finger
      // drag should do nothing so it doesn't fight with the swipe-to-close
      // or scroll gestures used elsewhere in the app.
      gestureRef.current = {
        mode: "pan",
        startX: mapTransform.x, startY: mapTransform.y,
        startTouchX: e.touches[0].clientX, startTouchY: e.touches[0].clientY,
      };
    }
  };
  const onMapTouchMove = (e) => {
    const g = gestureRef.current;
    if (!g) return;
    if (g.mode === "pinch" && e.touches.length === 2) {
      e.preventDefault();
      const newDist = dist(e.touches[0], e.touches[1]);
      const newScale = Math.min(6, Math.max(1, g.startScale * (newDist / g.startDist)));
      const mid = midpoint(e.touches[0], e.touches[1]);
      setMapTransform({
        scale: newScale,
        x: g.startX + (mid.x - g.startMid.x),
        y: g.startY + (mid.y - g.startMid.y),
      });
    } else if (g.mode === "pan" && e.touches.length === 1) {
      e.preventDefault();
      setMapTransform(t => ({
        ...t,
        x: g.startX + (e.touches[0].clientX - g.startTouchX),
        y: g.startY + (e.touches[0].clientY - g.startTouchY),
      }));
    }
  };
  const onMapTouchEnd = (e) => {
    if (e.touches.length === 0) gestureRef.current = null;
  };

  useEffect(() => {
    if (!isFullscreen) return;
    // Fullscreen canvas needs its own draw pass at the larger pixel size,
    // and needs to re-run whenever the overlay actually mounts. Wait a
    // frame after resizing so the browser has finished laying out the
    // canvas's CSS size (width:100%, height:70vh) before we read/draw at
    // its actual pixel dimensions — otherwise the bounding box used to
    // pick tiles can be computed against a stale (too-small) size, leaving
    // gaps at the edges once the canvas settles to its real size.
    resetMapTransform();
    let raf1, raf2, cleanup;
    raf1 = requestAnimationFrame(() => {
      raf2 = requestAnimationFrame(() => {
        const canvas = fullCanvasRef.current;
        if (canvas) {
          const dpr = window.devicePixelRatio || 1;
          canvas.width = canvas.clientWidth * dpr;
          canvas.height = canvas.clientHeight * dpr;
        }
        cleanup = draw(canvas, true);
      });
    });
    return () => {
      cancelAnimationFrame(raf1);
      if (raf2) cancelAnimationFrame(raf2);
      if (cleanup) cleanup();
    };
  }, [isFullscreen, flight]);

  const hasMap = (flight?.track?.length) || (flight?.startPt && flight?.endPt);

  return (
    <>
      <div style={{position:"relative"}} onClick={()=>{ if (hasMap) setIsFullscreen(true); }}>
        <canvas ref={canvasRef} width={340} height={140} style={{width:"100%",height:140,background:"#040e20",borderRadius:10,display:"block",cursor:hasMap?"pointer":"default"}} />
        {hasMap && (
          <div style={{position:"absolute",bottom:2,right:6,fontSize:8,color:"rgba(255,255,255,0.4)",textShadow:"0 1px 2px rgba(0,0,0,0.8)"}}>
            © OpenTopoMap (CC-BY-SA)
          </div>
        )}
      </div>
      {isFullscreen && (
        <div
          style={{position:"fixed",inset:0,background:"#000",zIndex:200,display:"flex",flexDirection:"column",alignItems:"center",justifyContent:"center",overflow:"hidden"}}
        >
          <canvas ref={fullCanvasRef}
            onTouchStart={onMapTouchStart} onTouchMove={onMapTouchMove} onTouchEnd={onMapTouchEnd}
            onDoubleClick={resetMapTransform}
            style={{width:"100%",height:"70vh",display:"block",transform:`translate(${mapTransform.x}px, ${mapTransform.y}px) scale(${mapTransform.scale})`,transformOrigin:"center center",touchAction:"none"}} />
          <div style={{position:"absolute",bottom:"calc(15vh + 10px)",right:14,fontSize:10,color:"rgba(255,255,255,0.5)",textShadow:"0 1px 2px rgba(0,0,0,0.8)"}}>
            © OpenTopoMap (CC-BY-SA)
          </div>
          {mapTransform.scale > 1 && (
            <button onClick={resetMapTransform}
              style={{position:"absolute",bottom:"calc(15vh + 10px)",left:14,background:"rgba(255,255,255,0.12)",border:"1px solid rgba(255,255,255,0.2)",borderRadius:20,padding:"6px 14px",color:"#fff",fontSize:12,fontWeight:700,cursor:"pointer"}}>
              ↺ {Math.round(mapTransform.scale*100)}%
            </button>
          )}
          <button onClick={()=>setIsFullscreen(false)}
            style={{position:"absolute",top:"calc(env(safe-area-inset-top, 0px) + 10px)",right:14,background:"rgba(255,255,255,0.12)",border:"1px solid rgba(255,255,255,0.2)",borderRadius:20,width:32,height:32,color:"#fff",fontSize:16,cursor:"pointer"}}>
            ✕
          </button>
        </div>
      )}
    </>
  );
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
    // Optional fallback if a pdfData prop is ever passed in (currently unused)
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
    wrap:{padding:"0 16px 24px",background:"#040e20",minHeight:"100vh",color:"#e8f4fd",fontFamily:"-apple-system,BlinkMacSystemFont,sans-serif"},
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
      <div style={{display:"flex",alignItems:"center",gap:10,padding:"calc(20px + env(safe-area-inset-top, 0px)) 0 14px",borderBottom:"1px solid rgba(100,180,255,0.1)",marginBottom:16}}>
        <button onClick={()=>{window.location.href="index.html";}} title="Zur Startseite"
          style={{background:"rgba(255,255,255,0.06)",border:"1px solid rgba(255,255,255,0.1)",borderRadius:10,width:32,height:32,display:"flex",alignItems:"center",justifyContent:"center",fontSize:15,color:"rgba(232,244,253,0.8)",cursor:"pointer",flexShrink:0}}>
          🏠
        </button>
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

// Header row matching flightToCsvRow's 25 columns exactly, so a re-exported
// file opens in Numbers with the same column layout the person is used to
// from the original import sheet.
const CSV_HEADER = [
  "Nr", "Flugreise", "Datum", "Startzeit", "Start", "Landezeit", "Landung",
  "S-L Entf.", "Dauer", "Rang", "%", "Distanz", "km/h", "H.Diff.",
  "müM S", "müM L", "H.Max", "SÜ", "H.Gew.", "Sinken", "Steigen",
  "Gerät", "Passagier", "Datum2", "Bemerkung",
].join("\t");

// Builds a downloadable CSV/TSV file from one or more flights, using the
// exact same column structure as flightToCsvRow (and therefore as the
// original import format), so it can be re-opened in Numbers/Excel with
// matching columns. Tab-separated rather than comma-separated since the
// data itself may contain commas (e.g. place names) and this already
// matches what the app uses elsewhere for spreadsheet compatibility.
function exportFlightsAsCsv(flightList, filenameBase) {
  const rows = [CSV_HEADER, ...flightList.map(flightToCsvRow)].join("\r\n");
  const blob = new Blob([rows], { type: "text/tab-separated-values;charset=utf-8" });
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = `${filenameBase}.csv`;
  document.body.appendChild(a);
  a.click();
  document.body.removeChild(a);
  setTimeout(() => URL.revokeObjectURL(url), 1000);
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
    else {
      const dm2=durStr.match(/(\d+):(\d{2})/);
      const dm3=durStr.match(/(\d+)\s*h\s*(\d+)\s*m/i);
      if(dm2) durationSec=+dm2[1]*3600 + +dm2[2]*60;
      else if(dm3) durationSec=+dm3[1]*3600 + +dm3[2]*60;
    }
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
  { id: "number",   label: "Nummer" },
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

// Computes "Reise-Nr./Reise-Flug-Nr." (e.g. "21/4") for every flight tagged
// with a Reise. Trip numbering matches the Reisen page: trips are numbered
// by the manually-saved order (reisen:names, which doubles as the display
// order) — highest number = first in
// that order, same as trips.length - index there — and within a trip,
// flights are numbered by date ascending (oldest flight = position 1).
function computeReiseLabels(flights, reiseOrder) {
  const byTrip = new Map();
  flights.forEach(f => {
    const name = f.customFields?.reise;
    if (!name) return;
    if (!byTrip.has(name)) byTrip.set(name, []);
    byTrip.get(name).push(f);
  });
  // Trip display order: saved manual order first, then any trips missing
  // from it (e.g. brand new ones) appended — mirrors applyOrder on the
  // Reisen page so numbers always agree between the two views.
  const tripNames = [...byTrip.keys()];
  const ordered = [];
  (reiseOrder||[]).forEach(n => { if (byTrip.has(n)) { ordered.push(n); } });
  tripNames.forEach(n => { if (!ordered.includes(n)) ordered.push(n); });

  const labels = new Map(); // flight id -> "tripNr/positionNr"
  ordered.forEach((name, idx) => {
    const tripNr = ordered.length - idx;
    const sorted = [...byTrip.get(name)].sort((a,b) =>
      (parseInt((a.name||"").match(/\d+/)?.[0]||"0",10)) - (parseInt((b.name||"").match(/\d+/)?.[0]||"0",10)));
    sorted.forEach((f, posIdx) => labels.set(f.id, `${tripNr}/${posIdx+1}`));
  });
  return labels;
}

function sortFieldValue(f, sortId) {
  const cf = f.customFields || {};
  switch (sortId) {
    case "date":     return parseDateToTs(f.date || f.rawDate, f.startTime);
    case "number":
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

function FlightRow({ f, isLongest, onClick, sortId, selectMode, isSelected, onToggleSelect, reiseLabel }) {
  const pax = f.customFields?.passagier;
  const showSortValue = sortId && sortId !== "date" && sortId !== "number";
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
          <span style={{fontSize:10,fontWeight:700,color:"#fcd34d",minWidth:26,flexShrink:0}}>{reiseLabel||""}</span>
          <span style={{display:"flex",alignItems:"center",gap:6,flexShrink:0}}>
            {f.pdfOnly&&<span style={{background:"rgba(139,92,246,0.18)",color:"#c4b5fd",borderRadius:20,padding:"1px 7px",fontSize:9,fontWeight:700}}>CSV</span>}
            {f.track?.length>1&&<span style={{background:"rgba(34,197,94,0.22)",color:"#4ade80",borderRadius:20,padding:"1px 7px",fontSize:9,fontWeight:700,boxShadow:"0 0 6px rgba(74,222,128,0.5)"}}>IGC</span>}
            {pax&&<span style={{border:"1px solid rgba(232,244,253,0.15)",borderRadius:20,padding:"1px 7px",fontSize:9,color:"rgba(232,244,253,0.5)"}}>👤 {pax}</span>}
          </span>
        </div>
        <div style={{fontSize:11,color:"rgba(232,244,253,0.4)"}}>{f.date} · {f.site||"—"}{f.glider?" · "+f.glider:""}</div>
      </div>
      <div style={{textAlign:"right",flexShrink:0,marginLeft:8}}>
        {showSortValue ? (
          <div style={{fontSize:13,fontWeight:600,color:"#7dd3fc"}}>{formatSortValue(f, sortId)}</div>
        ) : (<>
          <div style={{fontSize:13,fontWeight:600,color:"#7dd3fc",display:"flex",alignItems:"center",justifyContent:"flex-end",gap:4}}>
            {f.rating>=4 && <span><span style={{color:"#fde047"}}>{f.rating}</span><span style={{fontSize:"0.85em"}}>⭐️</span></span>}
            <span>{f.durationStr||"—"}</span>
          </div>
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
  const committedByEnter = useRef(false);
  const commit = () => {
    if (committedByEnter.current) { committedByEnter.current = false; return; }
    setEditing(false);
    if(val!==(value||"")) onSave(val);
  };
  const commitAndAdvance = (e) => {
    committedByEnter.current = true; // tell the upcoming blur event to no-op
    setEditing(false);
    if(val!==(value||"")) onSave(val);
    const row = e.target.closest("[data-inline-row]");
    const allRows = [...document.querySelectorAll("[data-inline-row]")];
    const idx = allRows.indexOf(row);
    // Wait for React to finish re-rendering this row back into its
    // "trigger" (span) state before looking for the next row's input,
    // otherwise we're searching a stale DOM snapshot. requestAnimationFrame
    // runs after the browser's next paint, which is reliably after the
    // state update has been committed to the DOM.
    requestAnimationFrame(() => {
      requestAnimationFrame(() => {
        for (let i = idx + 1; i < allRows.length; i++) {
          const nextRow = allRows[i];
          const trigger = nextRow?.querySelector("[data-inline-field-trigger]");
          const select = nextRow?.querySelector("select");
          if (trigger) { trigger.click(); return; }
          if (select) { select.focus(); return; } // e.g. ReiseSelect has no trigger span
        }
      });
    });
  };
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
                  commitAndAdvance(e);
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

// Text field with spreadsheet-style inline autocomplete (like Numbers/Excel
// suggesting a matching earlier entry as you type, with the suggested
// remainder shown selected so continuing to type overwrites it, and
// Enter/Tab accepts it) — used for Startplatz/Landeplatz so a long list of
// previously-used places never has to be scrolled through; only the single
// best-matching suggestion appears, inline, as part of the text itself.
function PlaceInlineField({label, value, onSave, suggestions, flights, kind}) {
  const [editing, setEditing] = useState(false);
  const [val, setVal] = useState(value||"");
  const inputRef = useRef(null);
  const committedByEnter = useRef(false);

  const applySuggestion = (typed) => {
    if (!typed) return typed;
    const match = suggestions.find(s => s.toLowerCase().startsWith(typed.toLowerCase()) && s.length > typed.length);
    return match || typed;
  };

  const prevLen = useRef((value||"").length);
  const onChange = (e) => {
    const typed = e.target.value;
    const isDeleting = typed.length < prevLen.current;
    prevLen.current = typed.length;
    if (isDeleting) {
      // Backspace/Delete: respect exactly what's left, no re-suggesting —
      // otherwise the suggested tail would be immediately re-appended and
      // the field could never be shortened or cleared.
      setVal(typed);
      return;
    }
    const suggested = applySuggestion(typed);
    setVal(suggested);
    prevLen.current = suggested.length;
    // Select the auto-completed remainder so the next keystroke naturally
    // overwrites it (matching how Numbers/Excel/Sheets handle this), rather
    // than the person having to manually delete the suggested tail.
    if (suggested !== typed) {
      requestAnimationFrame(() => {
        inputRef.current?.setSelectionRange(typed.length, suggested.length);
      });
    }
  };

  // When the accepted place name matches one already used elsewhere, pull
  // that place's coordinates and altitude from whichever flight used it
  // most recently (by date), so the person doesn't have to re-enter data
  // that's already known for that place — always overwriting any existing
  // coordinates/altitude on this flight, per how this was asked for.
  const findPlaceExtras = (name) => {
    if (!name || !flights) return null;
    const matches = flights
      .filter(f => (kind === "start" ? f.site : f.customFields?.landung) === name)
      .filter(f => kind === "start" ? f.startPt : f.endPt)
      .sort((a,b) => parseDateToTs(b.date||b.rawDate) - parseDateToTs(a.date||a.rawDate));
    if (!matches.length) return null;
    const f = matches[0];
    return kind === "start"
      ? { pt: f.startPt, alt: f.startAlt }
      : { pt: f.endPt, alt: f.endAlt };
  };

  const commit = () => {
    if (committedByEnter.current) { committedByEnter.current = false; return; }
    setEditing(false);
    if(val!==(value||"")) onSave(val, findPlaceExtras(val));
  };
  const commitAndAdvance = (e) => {
    committedByEnter.current = true;
    setEditing(false);
    if(val!==(value||"")) onSave(val, findPlaceExtras(val));
    const row = e.target.closest("[data-inline-row]");
    const allRows = [...document.querySelectorAll("[data-inline-row]")];
    const idx = allRows.indexOf(row);
    requestAnimationFrame(() => {
      requestAnimationFrame(() => {
        for (let i = idx + 1; i < allRows.length; i++) {
          const nextRow = allRows[i];
          const trigger = nextRow?.querySelector("[data-inline-field-trigger]");
          const select = nextRow?.querySelector("select");
          if (trigger) { trigger.click(); return; }
          if (select) { select.focus(); return; }
        }
      });
    });
  };

  return (
    <div data-inline-row style={{display:"flex",justifyContent:"space-between",alignItems:"center",padding:"6px 0",borderBottom:"1px solid rgba(255,255,255,0.04)"}}>
      <span style={{fontSize:13,color:"rgba(232,244,253,0.45)",minWidth:90}}>{label}</span>
      {editing ? (
        <input ref={inputRef} value={val} onChange={onChange} onBlur={commit} autoFocus
          data-inline-field
          onKeyDown={e=>{
            if(e.key==="Enter"||e.key==="Tab"){
              e.preventDefault();
              commitAndAdvance(e);
            }
          }}
          style={{flex:1,background:"rgba(255,255,255,0.08)",border:"1px solid rgba(125,211,252,0.4)",borderRadius:8,padding:"4px 8px",color:"#e8f4fd",fontSize:13,textAlign:"right"}} />
      ) : (
        <span data-inline-field-trigger onClick={()=>{setVal(value||"");setEditing(true);}}
          style={{fontSize:13,fontWeight:500,color:value?"#e8f4fd":"rgba(232,244,253,0.25)",cursor:"pointer",minWidth:60,textAlign:"right"}}>
          {value||"—"}
        </span>
      )}
    </div>
  );
}

// Dropdown for assigning a flight to a Reise (travel). The list of available
// travel names is user-managed on the Reisen page (freitext there), stored
// under "reisen:names" — this component only reads and offers that list,
// it never creates new names itself.
function ReiseSelect({ value, onSave }) {
  const [names, setNames] = useState([]);
  useEffect(() => {
    (async () => {
      try {
        const r = await window.storage.get("reisen:names");
        if (r) setNames(JSON.parse(r.value) || []);
      } catch {}
    })();
  }, []);
  return (
    <div data-inline-row style={{display:"flex",justifyContent:"space-between",alignItems:"center",padding:"6px 0",borderBottom:"1px solid rgba(255,255,255,0.04)"}}>
      <span style={{fontSize:13,color:"rgba(232,244,253,0.45)",minWidth:90}}>Reise</span>
      <select value={value||""} onChange={e=>onSave(e.target.value)}
        style={{background:"rgba(255,255,255,0.08)",border:"1px solid rgba(255,255,255,0.12)",borderRadius:8,padding:"4px 8px",color:value?"#e8f4fd":"rgba(232,244,253,0.4)",fontSize:13,textAlign:"right",maxWidth:180}}>
        <option value="" style={{background:"#0a1628"}}>—</option>
        {names.map(n => <option key={n} value={n} style={{background:"#0a1628"}}>{n}</option>)}
      </select>
    </div>
  );
}

// Dropdown for selecting the glider used on a flight, sourced from the
// actual names entered on the Service/Schirm page's 4 category tabs — not
// the category labels (Solo, Solo light, etc.) themselves, just whatever
// name the person gave each of their up-to-4 gliders there.
function SchirmSelect({ value, onSave }) {
  const [names, setNames] = useState([]);
  useEffect(() => {
    (async () => {
      try {
        const r = await window.storage.get("service:schirme");
        if (r) {
          const schirme = JSON.parse(r.value) || {};
          const list = Object.values(schirme)
            .map(s => s?.name)
            .filter(n => n && String(n).trim());
          setNames(list);
        }
      } catch {}
    })();
  }, []);
  return (
    <div data-inline-row style={{display:"flex",justifyContent:"space-between",alignItems:"center",padding:"6px 0",borderBottom:"1px solid rgba(255,255,255,0.04)"}}>
      <span style={{fontSize:13,color:"rgba(232,244,253,0.45)",minWidth:90}}>Schirm</span>
      <select value={value||""} onChange={e=>onSave(e.target.value)}
        style={{background:"rgba(255,255,255,0.08)",border:"1px solid rgba(255,255,255,0.12)",borderRadius:8,padding:"4px 8px",color:value?"#e8f4fd":"rgba(232,244,253,0.4)",fontSize:13,textAlign:"right",maxWidth:180}}>
        <option value="" style={{background:"#0a1628"}}>—</option>
        {names.map(n => <option key={n} value={n} style={{background:"#0a1628"}}>{n}</option>)}
      </select>
    </div>
  );
}



function DetailContent({ fl, flights, customFieldDefs, setFlights, setSelected, setView, setInlinePassagier, setEditData, saveFlight, showFieldEditor, setShowFieldEditor, handleSaveFields, confirmDelete, setConfirmDelete, hideBackButton, isWide }) {

    const autoFields = customFieldDefs.filter(d=>d.formula).map(d=>({...d, value:evalFormula(d.formula,fl,flights)}));
    const manualFields = customFieldDefs.filter(d=>!d.formula);
    const flIdx = flights.findIndex(f=>f.id===fl.id);

    // Swipe-to-navigate: replaces the small prev/next arrow buttons. Swipe
    // left moves to the next flight in the list (same direction as the old
    // "◀" button, which incremented flIdx), swipe right moves to the
    // previous one (same as "▶", which decremented flIdx). Requires the
    // horizontal movement to clearly dominate over vertical movement so a
    // normal vertical scroll of the page is never mistaken for a swipe.
    const touchStart = useRef(null);
    const goToFlight = (delta) => {
      const next = flights[flIdx + delta];
      if (!next) return;
      setSelected(next);
      setInlinePassagier(next.customFields?.passagier || "");
    };
    const onTouchStart = (e) => {
      const t = e.touches[0];
      touchStart.current = { x: t.clientX, y: t.clientY };
    };
    const onTouchEnd = (e) => {
      if (!touchStart.current) return;
      const t = e.changedTouches[0];
      const dx = t.clientX - touchStart.current.x;
      const dy = t.clientY - touchStart.current.y;
      touchStart.current = null;
      const SWIPE_THRESHOLD = 60; // px
      if (Math.abs(dx) < SWIPE_THRESHOLD || Math.abs(dx) < Math.abs(dy) * 1.5) return;
      if (dx < 0) goToFlight(-1); // swipe left -> previous flight
      else goToFlight(1);         // swipe right -> next flight
    };

    // Inline save helper
    const saveField = async (patch) => {
      const upd = { ...fl, ...patch,
        customFields: { ...(fl.customFields||{}), ...(patch.customFields||{}) } };
      await saveFlight(upd);
      setFlights(p=>p.map(f=>f.id===upd.id?upd:f));
      setSelected(upd);
    };
    // Same as saveField, but for fields that feed into Dauer/H.Diff./Ø Speed
    // (start/end time, start/end altitude, distance). For manually-entered
    // flights with no IGC track — where these values aren't already derived
    // from precise GPS data — recompute the three derived fields from
    // whatever raw inputs are now available, the same way a spreadsheet
    // would live-update a formula cell. Flights with a real IGC track keep
    // their track-derived values untouched, since those are more accurate
    // than anything time/altitude fields alone could give us.
    const saveComputedField = async (currentFl, patch) => {
      const upd = { ...currentFl, ...patch,
        customFields: { ...(currentFl.customFields||{}), ...(patch.customFields||{}) } };
      if (!(upd.track && upd.track.length > 1)) {
        const startTs = parseDateToTs(upd.date || upd.rawDate, upd.startTime);
        const endTs = parseDateToTs(upd.date || upd.rawDate, upd.endTime);
        if (upd.startTime && upd.endTime) {
          let diffSec = Math.round((endTs - startTs) / 1000);
          if (diffSec < 0) diffSec += 24*3600; // landing past midnight
          if (diffSec > 0) {
            upd.durationSec = diffSec;
            const h = Math.floor(diffSec/3600), m = Math.round((diffSec%3600)/60);
            upd.durationStr = `${h}h ${String(m).padStart(2,"0")}m`;
          }
        }
        const startAltNum = +upd.startAlt || +(upd.customFields?.msa||0) || 0;
        const endAltNum = +upd.endAlt || +(upd.customFields?.ml||0) || 0;
        if (startAltNum && endAltNum) {
          upd.customFields = { ...upd.customFields, hDiff: String(Math.abs(startAltNum - endAltNum)) };
        }
        const distNum = parseFloat(upd.totalDist || upd.customFields?.distKm || upd.customFields?.dk || 0);
        if (distNum > 0 && upd.durationSec > 0) {
          const kmh = distNum / (upd.durationSec / 3600);
          upd.customFields = { ...upd.customFields, kmh: kmh.toFixed(1) };
        }
      }
      await saveFlight(upd);
      setFlights(p=>p.map(f=>f.id===upd.id?upd:f));
      setSelected(upd);
    };
    const [confirmDeleteTrack, setConfirmDeleteTrack] = useState(false);
    const deleteTrack = async () => {
      const upd = { ...fl, track: [] };
      await saveFlight(upd);
      setFlights(p=>p.map(f=>f.id===upd.id?upd:f));
      setSelected(upd);
      setConfirmDeleteTrack(false);
    };

    return (
      <div onTouchStart={onTouchStart} onTouchEnd={onTouchEnd}
        style={{maxWidth:isWide?720:480,margin:"0 auto",padding:"0 0 32px",background:"#040e20",minHeight:"100vh",color:"#e8f4fd",fontFamily:"-apple-system,BlinkMacSystemFont,sans-serif"}}>
        <div style={{display:"flex",alignItems:"center",justifyContent:"space-between",padding:"calc(16px + env(safe-area-inset-top, 0px)) 16px 10px"}}>
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
            {fl.track?.length>1 && (
              <button onClick={()=>{
                  const gpx = buildGpxFromFlight(fl);
                  if (gpx) {
                    const blob = new Blob([gpx], { type: "application/gpx+xml" });
                    const url = URL.createObjectURL(blob);
                    const a = document.createElement("a");
                    a.href = url;
                    a.download = `${fl?.name || "flug"}.gpx`;
                    document.body.appendChild(a);
                    a.click();
                    document.body.removeChild(a);
                    setTimeout(() => URL.revokeObjectURL(url), 1000);
                  }
                }}
                style={{background:"rgba(34,197,94,0.15)",border:"1px solid rgba(34,197,94,0.3)",borderRadius:20,padding:"6px 12px",color:"#4ade80",fontSize:13,cursor:"pointer"}}>⬇ GPX</button>
            )}
            {fl.track?.length>1 && (
              <button onClick={()=>setConfirmDeleteTrack(true)}
                title="IGC-Track löschen (Start/Landung bleiben erhalten)"
                style={{background:"rgba(239,68,68,0.08)",border:"1px solid rgba(239,68,68,0.2)",borderRadius:20,padding:"6px 12px",color:"rgba(248,113,113,0.85)",fontSize:13,cursor:"pointer"}}>🗑 IGC</button>
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
              {fl.pdfOnly&&<span style={{background:"rgba(139,92,246,0.2)",color:"#c4b5fd",borderRadius:20,padding:"2px 10px",fontSize:10,fontWeight:700}}>CSV</span>}
              {fl.track?.length>1&&<span style={{background:"rgba(245,158,11,0.18)",color:"#fcd34d",borderRadius:20,padding:"2px 10px",fontSize:10,fontWeight:700}}>IGC</span>}
            </div>
          </div>
          <EditableTitle value={fl.name} onSave={v=>saveField({name:v})} />
          <div style={{fontSize:13,color:"rgba(232,244,253,0.5)",marginBottom:12}}>{fl.startTime}{fl.endTime?" – "+fl.endTime:""}</div>

          {/* Rating inline */}
          <div style={{display:"flex",gap:6,marginBottom:14}}>
            {[1,2,3,4,5].map(s=>(
              <span key={s} onClick={()=>saveField({rating: (fl.rating||0)===s ? 0 : s})}
                style={{fontSize:24,cursor:"pointer",color:s<=(fl.rating||0)?"#f59e0b":"rgba(232,244,253,0.2)"}}>★</span>
            ))}
          </div>

          {/* Swipe hint (replaces the old prev/next arrow buttons — navigation is now via touch swipe on this view) */}
          <div style={{textAlign:"center",fontSize:11,color:"rgba(232,244,253,0.3)",marginBottom:10}}>
            ‹ wischen ›
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
            <SchirmSelect value={fl.glider} onSave={v=>saveField({glider:v})} />
            <InlineField label="Startzeit"   value={fl.startTime}                   onSave={v=>saveComputedField(fl,{startTime:v})} />
            <InlineField label="Landezeit"   value={fl.endTime}                     onSave={v=>saveComputedField(fl,{endTime:v})} />
            <PlaceInlineField label="Startplatz" value={fl.site} flights={flights} kind="start"
              onSave={(v,extras)=>saveField({
                site:v,
                ...(extras ? { startPt: extras.pt, startAlt: extras.alt } : {}),
              })}
              suggestions={[...new Set(flights.map(f=>f.site).filter(Boolean))]} />
            <PlaceInlineField label="Landeplatz" value={fl.customFields?.landung} flights={flights} kind="end"
              onSave={(v,extras)=>saveField({
                customFields:{landung:v},
                ...(extras ? { endPt: extras.pt, endAlt: extras.alt } : {}),
              })}
              suggestions={[...new Set(flights.map(f=>f.customFields?.landung).filter(Boolean))]} />
            <InlineField label="Passagier"   value={fl.customFields?.passagier}     onSave={v=>saveField({customFields:{passagier:v}})} />
            <ReiseSelect value={fl.customFields?.reise} onSave={v=>saveField({customFields:{reise:v}})} />
            <InlineField label="Start müM"   value={fl.startAlt>0?String(fl.startAlt):(fl.customFields?.msa||"")}  onSave={v=>saveComputedField(fl,{startAlt:+v,customFields:{msa:v}})} unit="m" />
            <InlineField label="Landung müM" value={fl.endAlt>0?String(fl.endAlt):(fl.customFields?.ml||"")}       onSave={v=>saveComputedField(fl,{endAlt:+v,customFields:{ml:v}})} unit="m" />
            <InlineField label="Max. Höhe"   value={fl.maxAlt?String(fl.maxAlt):""}                                onSave={v=>saveField({maxAlt:+v,customFields:{hm:v}})} unit="m" />
            <InlineField label="Distanz"     value={fl.totalDist?String(fl.totalDist):(fl.customFields?.distKm||fl.customFields?.dk||"")} onSave={v=>saveComputedField(fl,{totalDist:parseFloat(v)||0,customFields:{distKm:v}})} unit="km" />
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

        {confirmDeleteTrack && (
          <div onClick={()=>setConfirmDeleteTrack(false)}
            style={{position:"fixed",inset:0,background:"rgba(0,0,0,0.6)",display:"flex",alignItems:"center",justifyContent:"center",zIndex:100,padding:24}}>
            <div onClick={e=>e.stopPropagation()}
              style={{background:"#14253a",borderRadius:16,padding:"20px 22px",maxWidth:320,width:"100%",border:"1px solid rgba(255,255,255,0.1)"}}>
              <div style={{fontSize:16,fontWeight:700,marginBottom:6}}>IGC-Track löschen?</div>
              <div style={{fontSize:13,color:"rgba(232,244,253,0.6)",marginBottom:18}}>Der GPS-Track von {fl.name} wird entfernt. Start- und Landepunkt bleiben erhalten. Diese Aktion kann nicht rückgängig gemacht werden.</div>
              <div style={{display:"flex",gap:10}}>
                <button onClick={()=>setConfirmDeleteTrack(false)}
                  style={{flex:1,background:"rgba(255,255,255,0.08)",border:"1px solid rgba(255,255,255,0.12)",borderRadius:10,padding:"10px",color:"#e8f4fd",fontSize:14,cursor:"pointer"}}>Abbrechen</button>
                <button onClick={deleteTrack}
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
  const [sortId, setSortId] = useState("number");
  const [sortDir, setSortDir] = useState("desc");
  const [showSortMenu, setShowSortMenu] = useState(false);
  const filtered = matchFlights(flights, filterText);
  const years = [...new Set(filtered.map(f=>f.year).filter(Boolean))].sort((a,b)=>b-a);
  return (
    <div style={{width:340,minWidth:340,height:"100vh",overflowY:"auto",borderRight:"1px solid rgba(255,255,255,0.08)",background:"#040e20",fontFamily:"-apple-system,BlinkMacSystemFont,sans-serif"}}>
      <div style={{padding:"calc(14px + env(safe-area-inset-top, 0px)) 14px 8px",position:"sticky",top:0,background:"#040e20",zIndex:5,borderBottom:"1px solid rgba(255,255,255,0.06)"}}>
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
        {f.rating>=4 && <span style={{fontSize:11}}><span style={{color:"#fde047"}}>{f.rating}</span><span style={{fontSize:"0.85em"}}>⭐️</span></span>}
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
  const [sortId, setSortId] = useState("number");
  const [sortDir, setSortDir] = useState("desc");
  const [showSortMenu, setShowSortMenu] = useState(false);
  const [collapsedYears, setCollapsedYears] = useState(new Set());
  const [showFilterHelp, setShowFilterHelp] = useState(false);
  const [confirmDelete, setConfirmDelete] = useState(null);
  const [showRowImport, setShowRowImport] = useState(false);
  const [selectMode, setSelectMode] = useState(false);
  const [showImportMenu, setShowImportMenu] = useState(false);
  const [showBackupMenu, setShowBackupMenu] = useState(false);
  const [selectedIds, setSelectedIds] = useState(new Set());
  const [confirmBulkDelete, setConfirmBulkDelete] = useState(false);
  const [reisenNames, setReisenNames] = useState([]);
  useEffect(() => {
    (async () => {
      try {
        const r = await window.storage.get("reisen:names");
        if (r) setReisenNames(JSON.parse(r.value) || []);
      } catch {}
    })();
  }, []);
  const [copyMsg, setCopyMsg] = useState("");
  const [rowImportText, setRowImportText] = useState("");
  const [rowImportError, setRowImportError] = useState("");
  const [backupMsg, setBackupMsg] = useState("");
  const backupFileRef = useRef(null);
  const fileRef = useRef(null);
  const pdfFileRef = useRef(null);

  // Warn if the person tries to leave/reload while flights are still being
  // written to storage — otherwise anything not yet saved would be lost.
  useEffect(() => {
    const handler = (e) => {
      if (importProgress) {
        e.preventDefault();
        e.returnValue = "";
      }
    };
    window.addEventListener("beforeunload", handler);
    return () => window.removeEventListener("beforeunload", handler);
  }, [importProgress]);

  // Load flights from storage on mount. All flight data comes from localStorage
  // now (seeded via CSV/PDF import) — no embedded fallback dataset.
  useEffect(() => {
    (async () => {
      let loaded = [];
      try {
        const keys = await window.storage.list("flight:");
        const raw = await Promise.all((keys?.keys||[]).map(async k => {
          try { const r = await window.storage.get(k); return r ? JSON.parse(r.value) : null; } catch { return null; }
        }));
        loaded = raw.filter(Boolean);
      } catch(e) {
        console.error("Storage load error:", e);
        loaded = [];
      }
      const sorted = loaded.sort((a,b) =>
        (parseInt((b.name||"").match(/\d+/)?.[0]||"0",10)) - (parseInt((a.name||"").match(/\d+/)?.[0]||"0",10)));
      setFlights(sorted);
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
    // Include everything stored under "service:*" (Reserve, Schirm) and any
    // future "reisen:*" data automatically, so a single backup restores the
    // whole app, not just the flight list.
    let serviceData = {}, reisenData = {};
    try {
      const keys = await window.storage.list("");
      for (const k of (keys?.keys || [])) {
        if (k.startsWith("service:")) {
          const r = await window.storage.get(k);
          if (r) { try { serviceData[k] = JSON.parse(r.value); } catch {} }
        } else if (k.startsWith("reisen:")) {
          const r = await window.storage.get(k);
          if (r) { try { reisenData[k] = JSON.parse(r.value); } catch {} }
        }
      }
    } catch (e) { console.error("Backup: error collecting service/reisen data:", e); }

    const payload = {
      exportedAt: new Date().toISOString(),
      flights,
      customFieldDefs,
      service: serviceData,
      reisen: reisenData,
    };
    const json = JSON.stringify(payload, null, 0);
    const dateStamp = new Date().toISOString().slice(0,10);
    const filename = `flugbuch-backup-${dateStamp}.json`;

    // Prefer the native share sheet (lets the user pick "Save to Files" → iCloud Drive)
    if (navigator.share && navigator.canShare) {
      try {
        const file = new File([json], filename, { type: "application/json" });
        if (navigator.canShare({ files: [file] })) {
          await navigator.share({ files: [file] });
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
      // Restore Service (Reserve/Schirm) data, if present in this backup.
      let restoredExtras = 0;
      if (data.service && typeof data.service === "object") {
        for (const [key, value] of Object.entries(data.service)) {
          await window.storage.set(key, JSON.stringify(value));
          restoredExtras++;
        }
      }
      if (data.reisen && typeof data.reisen === "object") {
        for (const [key, value] of Object.entries(data.reisen)) {
          await window.storage.set(key, JSON.stringify(value));
          restoredExtras++;
        }
      }
      const sorted = [...data.flights].sort((a,b)=>
        (parseInt((b.name||"").match(/\d+/)?.[0]||"0",10)) - (parseInt((a.name||"").match(/\d+/)?.[0]||"0",10)));
      setFlights(sorted);
      setBackupMsg(`✓ ${data.flights.length} Flüge${restoredExtras?` + Service/Reisen-Daten`:""} wiederhergestellt.`);
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
      let durationSec;
      if (dm) durationSec = +dm[1]*3600 + +dm[2]*60 + +dm[3];
      else {
        const dm2=(p.dur||"").match(/(\d+):(\d{2})/);
        const dm3=(p.dur||"").match(/(\d+)\s*h\s*(\d+)\s*m/i);
        if (dm2) durationSec = +dm2[1]*3600 + +dm2[2]*60;
        else if (dm3) durationSec = +dm3[1]*3600 + +dm3[2]*60;
        else durationSec = f.durationSec;
      }
      return {
        ...f,
        pdfOnly: true,
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
        newEntries.push(entry);
      }
    }
    const toSave = [...newEntries, ...updatedFlights.filter(f => {
      const num = (f.name||"").match(/\d+/)?.[0];
      return num && DATA[num];
    })];
    setImportProgress({done:0, total:toSave.length});
    // Save all flights in parallel batches instead of one-at-a-time — with 1000+
    // flights, sequential awaits made the import take long enough that leaving
    // the page too early would lose whatever hadn't been written yet.
    const BATCH = 50;
    for (let i = 0; i < toSave.length; i += BATCH) {
      const batch = toSave.slice(i, i + BATCH);
      await Promise.all(batch.map(f => saveFlight(f)));
      setImportProgress({done: Math.min(i + BATCH, toSave.length), total: toSave.length});
    }
    setImportProgress(null);
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
      setPdfResult({error:"PDF-Import wird aktuell nicht unterstützt. Bitte CSV-Datei verwenden."});
    }
  }, [applyParsedData]);

  const doImport = useCallback(async (igcFiles) => {
    if (!igcFiles.length) return;
    setImporting(true); setImportProgress({done:0,total:igcFiles.length});
    const toImport = []; const dups = [];
    // Only treat a file as a duplicate if the matching flight already has a
    // REAL GPS track (track.length > 1) — a flight that merely exists (e.g.
    // imported from CSV with no track yet) should not block a fresh IGC import.
    const flightsWithTrack = new Map(
      flights.filter(f => f.track && f.track.length > 1).map(f => [f.name||"", f])
    );
    for (const file of igcFiles) {
      const baseName = file.name.replace(/\.igc$/i,"");
      if (flightsWithTrack.has(baseName)) dups.push(file);
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
        const updated = { ...existing, track };
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

  const reiseLabels = useMemo(() => computeReiseLabels(flights, reisenNames), [flights, reisenNames]);

  if (view==="season") return <SeasonDash flights={flights} onBack={()=>setView("list")} />;

  // ── DETAIL VIEW ─────────────────────────────────────────────────────────
  if (view==="detail" && selected && isWide) {
    return (
      <div style={{display:"flex",minHeight:"100vh",background:"#040e20"}}>
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
        <div style={{display:"flex",alignItems:"center",gap:12,padding:"calc(16px + env(safe-area-inset-top, 0px)) 16px 12px"}}>
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
                <button key={s} onClick={()=>setEditData(d=>({...d,rating:(d.rating||0)===s?0:s}))}
                  style={{fontSize:22,background:"none",border:"none",cursor:"pointer",color:s<=(editData.rating||0)?"#f59e0b":"rgba(232,244,253,0.2)"}}>★</button>
              ))}
            </div>
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
    <div style={{maxWidth:isWide?900:480,margin:"0 auto",minHeight:"100vh",background:"#040e20",color:"#e8f4fd",fontFamily:"-apple-system,BlinkMacSystemFont,sans-serif"}}>
      <input ref={fileRef} type="file" accept=".igc" multiple style={{display:"none"}} onChange={e=>importIGCFiles(Array.from(e.target.files))} />
      <input ref={pdfFileRef} type="file" accept=".pdf,.csv" style={{display:"none"}} onChange={e=>e.target.files[0]&&importPDFFile(e.target.files[0])} />

      {/* Header */}
      <div style={{position:"sticky",top:0,zIndex:10,background:"#040e20"}}>
      <div style={{background:"rgba(255,255,255,0.03)",borderBottom:"1px solid rgba(255,255,255,0.06)",padding:"calc(28px + env(safe-area-inset-top, 0px)) 16px 12px",display:"flex",alignItems:"center",justifyContent:"space-between",backdropFilter:"blur(10px)"}}>
        <button onClick={()=>{window.location.href="index.html";}} title="Zur Startseite"
          style={{background:"rgba(255,255,255,0.06)",border:"1px solid rgba(255,255,255,0.1)",borderRadius:10,width:32,height:32,display:"flex",alignItems:"center",justifyContent:"center",fontSize:15,color:"rgba(232,244,253,0.8)",cursor:"pointer",flexShrink:0}}>
          🏠
        </button>
        <span style={{fontWeight:900,fontSize:18,letterSpacing:-0.5,flex:1,textAlign:"center",marginLeft:-8}}>
          ✈️ Flugbuch
        </span>
        <div style={{display:"flex",gap:8,flexShrink:0}}>
          <button onClick={addNewFlight} style={{background:"rgba(34,197,94,0.15)",color:"#4ade80",border:"1px solid rgba(34,197,94,0.25)",borderRadius:20,padding:"7px 12px",fontSize:12,fontWeight:700,cursor:"pointer",whiteSpace:"nowrap"}}>+ Flug</button>
          <button onClick={()=>setView("season")} style={{background:"rgba(245,158,11,0.15)",color:"#fcd34d",border:"1px solid rgba(245,158,11,0.25)",borderRadius:20,padding:"7px 12px",fontSize:12,fontWeight:700,cursor:"pointer",whiteSpace:"nowrap"}}>📊 Saison</button>
        </div>
      </div>

      {/* Import / Backup / Auswahl — symmetric thirds */}
      <div style={{padding:"10px 16px 0",display:"flex",gap:8}}>
        <button onClick={()=>{ setShowImportMenu(m=>!m); setShowBackupMenu(false); }}
          style={{flex:1,background:showImportMenu?"rgba(56,189,248,0.15)":"rgba(255,255,255,0.05)",border:`1px solid ${showImportMenu?"rgba(56,189,248,0.35)":"rgba(255,255,255,0.1)"}`,borderRadius:10,padding:"9px 6px",color:showImportMenu?"#7dd3fc":"rgba(232,244,253,0.75)",fontSize:12,fontWeight:600,cursor:"pointer",textAlign:"center"}}>
          📥 Import {showImportMenu?"▾":"▸"}
        </button>
        <button onClick={()=>{ setShowBackupMenu(m=>!m); setShowImportMenu(false); }}
          style={{flex:1,background:showBackupMenu?"rgba(56,189,248,0.15)":"rgba(255,255,255,0.05)",border:`1px solid ${showBackupMenu?"rgba(56,189,248,0.35)":"rgba(255,255,255,0.1)"}`,borderRadius:10,padding:"9px 6px",color:showBackupMenu?"#7dd3fc":"rgba(232,244,253,0.75)",fontSize:12,fontWeight:600,cursor:"pointer",textAlign:"center"}}>
          💾 Backup {showBackupMenu?"▾":"▸"}
        </button>
        <button onClick={()=>{ setSelectMode(m=>!m); setSelectedIds(new Set()); setCopyMsg(""); }}
          style={{flex:1,background:selectMode?"rgba(14,165,233,0.18)":"rgba(255,255,255,0.05)",border:`1px solid ${selectMode?"rgba(14,165,233,0.4)":"rgba(255,255,255,0.1)"}`,borderRadius:10,padding:"9px 6px",color:selectMode?"#7dd3fc":"rgba(232,244,253,0.75)",fontSize:12,fontWeight:600,cursor:"pointer",textAlign:"center"}}>
          {selectMode?"✕ Auswahl":"☑ Auswahl"}
        </button>
      </div>

      {/* Import menu: CSV/PDF, IGC, Zellen */}
      {showImportMenu && (
        <div style={{margin:"8px 16px 0",background:"rgba(255,255,255,0.04)",border:"1px solid rgba(255,255,255,0.08)",borderRadius:10,padding:10,display:"flex",gap:8}}>
          <div onDragOver={e=>{e.preventDefault();setPdfDragOver(true)}} onDragLeave={()=>setPdfDragOver(false)}
            onDrop={e=>{e.preventDefault();e.dataTransfer.files[0]&&importPDFFile(e.dataTransfer.files[0]);}}
            onClick={()=>pdfFileRef.current?.click()}
            style={{flex:1,border:`2px dashed ${pdfDragOver?"#7dd3fc":"rgba(56,189,248,0.25)"}`,borderRadius:10,padding:"10px 8px",textAlign:"center",background:pdfDragOver?"rgba(56,189,248,0.08)":"transparent",cursor:"pointer",display:"flex",flexDirection:"column",alignItems:"center",justifyContent:"center",gap:3}}>
            <div style={{fontSize:15}}>📋</div>
            <div style={{color:pdfDragOver?"#7dd3fc":"rgba(125,211,252,0.5)",fontSize:10}}>CSV</div>
          </div>
          <div onDragOver={e=>{e.preventDefault();setDragOver(true)}} onDragLeave={()=>setDragOver(false)}
            onDrop={e=>{e.preventDefault();setDragOver(false);importIGCFiles(Array.from(e.dataTransfer.files));}}
            onClick={()=>fileRef.current?.click()}
            style={{flex:1,border:`2px dashed ${dragOver?"#fcd34d":"rgba(245,158,11,0.25)"}`,borderRadius:10,padding:"10px 8px",textAlign:"center",background:dragOver?"rgba(245,158,11,0.08)":"transparent",cursor:"pointer",display:"flex",flexDirection:"column",alignItems:"center",justifyContent:"center",gap:3}}>
            <div style={{fontSize:15}}>📂</div>
            <div style={{color:dragOver?"#fcd34d":"rgba(252,211,77,0.5)",fontSize:10}}>
              {importProgress ? `⏳ ${importProgress.done}/${importProgress.total}` : importing?"⏳ Importiere…":"IGC"}
            </div>
          </div>
          <div onClick={()=>setShowRowImport(s=>!s)}
            style={{flex:1,border:`2px dashed ${showRowImport?"#4ade80":"rgba(74,222,128,0.25)"}`,borderRadius:10,padding:"10px 8px",textAlign:"center",background:showRowImport?"rgba(74,222,128,0.08)":"transparent",cursor:"pointer",display:"flex",flexDirection:"column",alignItems:"center",justifyContent:"center",gap:3}}>
            <div style={{fontSize:15}}>📝</div>
            <div style={{color:showRowImport?"#4ade80":"rgba(134,239,172,0.5)",fontSize:10}}>Zellen</div>
          </div>
        </div>
      )}

      {/* Backup + selection: badges collapse into menus, shown together with Import badge below */}
      <input ref={backupFileRef} type="file" accept=".json" style={{display:"none"}}
        onChange={e=>{ if(e.target.files[0]) importBackup(e.target.files[0]); e.target.value=""; }} />

      {showBackupMenu && (
        <div style={{margin:"8px 16px 0",background:"rgba(255,255,255,0.04)",border:"1px solid rgba(255,255,255,0.08)",borderRadius:10,padding:10,display:"flex",gap:8}}>
          <button onClick={exportBackup}
            style={{flex:1,background:"rgba(255,255,255,0.05)",border:"1px solid rgba(255,255,255,0.1)",borderRadius:8,padding:"8px 6px",color:"rgba(232,244,253,0.8)",fontSize:12,cursor:"pointer",textAlign:"center"}}>
            ☁️ In iCloud sichern
          </button>
          <button onClick={()=>backupFileRef.current?.click()}
            style={{flex:1,background:"rgba(255,255,255,0.05)",border:"1px solid rgba(255,255,255,0.1)",borderRadius:8,padding:"8px 6px",color:"rgba(232,244,253,0.8)",fontSize:12,cursor:"pointer",textAlign:"center"}}>
            ⬆ Backup importieren
          </button>
        </div>
      )}

      {selectMode && (
        <div style={{padding:"8px 16px 0",display:"flex",gap:8}}>
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
          <button onClick={()=>{
              if (!selectedIds.size) { setCopyMsg("Keine Flüge ausgewählt."); return; }
              setConfirmBulkDelete(true);
            }}
            title="Auswahl löschen"
            style={{flex:1,background:"rgba(239,68,68,0.15)",border:"1px solid rgba(239,68,68,0.3)",borderRadius:10,padding:"9px 6px",color:"#f87171",fontSize:13,fontWeight:700,cursor:"pointer",textAlign:"center"}}>
            🗑 {selectedIds.size}
          </button>
          <select
            value=""
            onChange={async e=>{
              const reiseName = e.target.value;
              if (!reiseName) return;
              if (!selectedIds.size) { setCopyMsg("Keine Flüge ausgewählt."); return; }
              const chosen = flights.filter(f=>selectedIds.has(f.id));
              for (const f of chosen) {
                const updated = { ...f, customFields: { ...(f.customFields||{}), reise: reiseName } };
                await saveFlight(updated);
              }
              setFlights(prev => prev.map(f => selectedIds.has(f.id)
                ? { ...f, customFields: { ...(f.customFields||{}), reise: reiseName } } : f));
              setCopyMsg(`✓ ${chosen.length} Flug${chosen.length!==1?"e":""} → "${reiseName}" zugeordnet.`);
              e.target.value = "";
            }}
            title="Auswahl einer Reise zuordnen"
            style={{flex:1,background:"rgba(245,166,35,0.15)",border:"1px solid rgba(245,166,35,0.3)",borderRadius:10,padding:"9px 6px",color:"#f5a623",fontSize:13,fontWeight:700,cursor:"pointer",textAlign:"center"}}>
            <option value="" style={{background:"#040e20"}}>🧭 {selectedIds.size}</option>
            {reisenNames.map(n => <option key={n} value={n} style={{background:"#040e20"}}>{n}</option>)}
          </select>
        </div>
      )}
      {confirmBulkDelete && (
        <div onClick={()=>setConfirmBulkDelete(false)}
          style={{position:"fixed",inset:0,background:"rgba(0,0,0,0.6)",display:"flex",alignItems:"center",justifyContent:"center",zIndex:200,padding:24}}>
          <div onClick={e=>e.stopPropagation()}
            style={{background:"#14253a",borderRadius:16,padding:"20px 22px",maxWidth:320,width:"100%",border:"1px solid rgba(255,255,255,0.1)"}}>
            <div style={{fontSize:16,fontWeight:700,marginBottom:6}}>{selectedIds.size} Flüge — was löschen?</div>
            <div style={{fontSize:13,color:"rgba(232,244,253,0.6)",marginBottom:18}}>Diese Aktion kann nicht rückgängig gemacht werden.</div>
            <div style={{display:"flex",flexDirection:"column",gap:8}}>
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
                style={{background:"rgba(239,68,68,0.2)",border:"1px solid rgba(239,68,68,0.4)",borderRadius:10,padding:"10px",color:"#f87171",fontSize:14,fontWeight:700,cursor:"pointer"}}>🗑 Ganze Flüge löschen</button>
              <button onClick={async()=>{
                  const ids = [...selectedIds];
                  let cleared = 0;
                  for (const id of ids) {
                    const f = flights.find(fl=>fl.id===id);
                    if (f && f.track?.length>1) {
                      const upd = { ...f, track: [] };
                      try { await saveFlight(upd); cleared++; } catch {}
                      setFlights(prev=>prev.map(fl=>fl.id===id?upd:fl));
                    }
                  }
                  setCopyMsg(`✓ ${cleared} IGC-Track${cleared!==1?"s":""} gelöscht (Start/Landung bleiben).`);
                  setSelectedIds(new Set());
                  setConfirmBulkDelete(false);
                  setSelectMode(false);
                }}
                style={{background:"rgba(245,158,11,0.15)",border:"1px solid rgba(245,158,11,0.3)",borderRadius:10,padding:"10px",color:"#fcd34d",fontSize:14,fontWeight:700,cursor:"pointer"}}>🛰 Nur IGC-Tracks löschen</button>
              <button onClick={()=>setConfirmBulkDelete(false)}
                style={{background:"rgba(255,255,255,0.08)",border:"1px solid rgba(255,255,255,0.12)",borderRadius:10,padding:"10px",color:"#e8f4fd",fontSize:14,cursor:"pointer"}}>Abbrechen</button>
            </div>
          </div>
        </div>
      )}
      {(backupMsg || copyMsg) && (
        <div style={{padding:"6px 16px 0",fontSize:11,color:(backupMsg||copyMsg).startsWith("✓")?"#4ade80":"#f87171"}}>
          {backupMsg || copyMsg}
        </div>
      )}

      {/* Blocking import-progress overlay — stays visible until all flights are
          written to storage, so the person can't accidentally navigate away
          (and lose unsaved data) while a large CSV import is still running. */}
      {importProgress && (
        <div style={{position:"fixed",inset:0,background:"rgba(10,22,40,0.92)",zIndex:300,display:"flex",flexDirection:"column",alignItems:"center",justifyContent:"center",gap:14}}>
          <div style={{fontSize:36}}>⏳</div>
          <div style={{fontSize:15,fontWeight:700,color:"#e8f4fd"}}>Speichere Flüge…</div>
          <div style={{fontSize:13,color:"rgba(232,244,253,0.6)"}}>{importProgress.done} / {importProgress.total}</div>
          <div style={{width:200,height:6,background:"rgba(255,255,255,0.1)",borderRadius:10,overflow:"hidden"}}>
            <div style={{width:`${importProgress.total?Math.round(importProgress.done/importProgress.total*100):0}%`,height:"100%",background:"#7dd3fc",transition:"width 0.2s"}} />
          </div>
          <div style={{fontSize:11,color:"rgba(232,244,253,0.4)",marginTop:6}}>Bitte Seite nicht schliessen oder neu laden</div>
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
          <button
            onClick={()=>setCollapsedYears(s=>s.size===0?new Set(years):new Set())}
            title={collapsedYears.size===0?"Alle reduzieren":"Alle erweitern"}
            style={{flexShrink:0,background:"rgba(255,255,255,0.06)",border:"1px solid rgba(255,255,255,0.1)",borderRadius:10,padding:"8px 12px",color:"rgba(232,244,253,0.6)",fontSize:11,fontWeight:700,cursor:"pointer",letterSpacing:1}}>
            {collapsedYears.size===0?"⊟⊟":"⊞⊞"}
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
        {(sortId !== "date" && sortId !== "number") ? (
          // Flat, year-spanning sort
          <div>
            {(() => {
              const sorted = sortFlights([...filteredFlights, ...noYear.filter(f=>!filteredFlights.includes(f))], sortId, sortDir);
              if (!isWide) {
                return sorted.map(f=>(
                  <FlightRow key={f.id} f={f} isLongest={f.id===longestId} sortId={sortId} reiseLabel={reiseLabels.get(f.id)}
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
                    <FlightRow key={f.id} f={f} isLongest={f.id===longestId} sortId={sortId} reiseLabel={reiseLabels.get(f.id)}
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
              <div onClick={()=>{
                  if (selectMode) {
                    // In selection mode, tapping the year header toggles
                    // selection of every flight in that year instead of
                    // collapsing it — collapsing and bulk-selecting both
                    // wanting the same tap target would be confusing.
                    const yearIds = yFlights.map(f=>f.id);
                    const allSelected = yearIds.every(id=>selectedIds.has(id));
                    setSelectedIds(prev=>{
                      const n = new Set(prev);
                      yearIds.forEach(id => allSelected ? n.delete(id) : n.add(id));
                      return n;
                    });
                  } else {
                    setCollapsedYears(s=>{const n=new Set(s);n.has(yr)?n.delete(yr):n.add(yr);return n;});
                  }
                }}
                style={{display:"flex",justifyContent:"space-between",alignItems:"center",padding:"8px 16px",cursor:"pointer",background:"rgba(255,255,255,0.02)",borderBottom:"1px solid rgba(255,255,255,0.04)"}}>
                <div style={{display:"flex",alignItems:"center",gap:8}}>
                  {selectMode && (() => {
                    const yearIds = yFlights.map(f=>f.id);
                    const allSelected = yearIds.length>0 && yearIds.every(id=>selectedIds.has(id));
                    return (
                      <div style={{flexShrink:0,width:18,height:18,borderRadius:5,border:`2px solid ${allSelected?"#7dd3fc":"rgba(232,244,253,0.3)"}`,background:allSelected?"#7dd3fc":"transparent",display:"flex",alignItems:"center",justifyContent:"center"}}>
                        {allSelected && <span style={{color:"#0a1628",fontSize:11,fontWeight:900}}>✓</span>}
                      </div>
                    );
                  })()}
                  <span style={{fontWeight:700,color:"#7dd3fc",fontSize:14}}>{yr} · {yFlights.length} Flüge{yrBiplace>0&&<span style={{color:"#fcd34d",fontSize:11,fontWeight:600}}> · {yrBiplace} Biplace</span>}</span>
                </div>
                <span style={{fontSize:12,color:"rgba(232,244,253,0.35)"}}>{yrH}h{yrM}m {collapsed?"▸":"▾"}</span>
              </div>
              {!collapsed && (isWide ? (
                (() => {
                  const rows = [];
                  for (let i=0;i<yFlights.length;i+=2) rows.push([yFlights[i], yFlights[i+1]]);
                  return rows.map((pair,idx)=>(
                    <div key={idx} style={{display:"grid",gridTemplateColumns:"1fr 1fr",gap:0}}>
                      {pair.map(f=>f && (
                        <FlightRow key={f.id} f={f} isLongest={f.id===longestId} sortId={sortId} reiseLabel={reiseLabels.get(f.id)}
                          selectMode={selectMode} isSelected={selectedIds.has(f.id)}
                          onToggleSelect={id=>setSelectedIds(prev=>{const n=new Set(prev);n.has(id)?n.delete(id):n.add(id);return n;})}
                          onClick={()=>{setSelected(f);setInlinePassagier(f.customFields?.passagier||"");setView("detail");}} />
                      ))}
                    </div>
                  ));
                })()
              ) : (
                yFlights.map(f=>(
                  <FlightRow key={f.id} f={f} isLongest={f.id===longestId} sortId={sortId} reiseLabel={reiseLabels.get(f.id)}
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
