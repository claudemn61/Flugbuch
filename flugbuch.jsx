const { useState, useEffect, useRef, useCallback, useMemo } = React;

// ── IGC Parser ─────────────────────────────────────────────────────────────
// Set by FlightProfile while its zoom level is above 1×, checked by the
// swipe-between-flights handler further down so a horizontal drag inside a
// zoomed profile chart can never also trigger navigating to the next/
// previous flight. A plain module-level flag rather than React state/
// context since this is a short-lived interaction lock between two
// components that don't otherwise need to know about each other.
let profileZoomActive = false;

function parseIGC(text) {
  const lines = text.split("\n");
  const track = [];
  let date = "", pilot = "", glider = "", passagier = "", tzOffsetHours = null;
  for (const line of lines) {
    if (line.startsWith("HFDTE")) {
      const m = line.match(/HFDTE(?:DATE:)?(\d{2})(\d{2})(\d{2})/);
      if (m) date = `${m[1]}.${m[2]}.20${m[3]}`;
    }
    // Header records carry more than just the date — pilot name and glider
    // type are standard IGC fields (every logger writes them), and CM2
    // ("Crew 2") is the co-pilot/passenger seat on a tandem/biplace flight.
    // Reading these means a fresh IGC import can fill in Pilot/Schirm/
    // Passagier immediately instead of leaving them blank for manual entry.
    if (line.startsWith("HFPLT")) {
      const m = line.match(/HFPLT(?:PILOTINCHARGE:|PILOT:)?(.+)/);
      if (m) pilot = m[1].trim();
    }
    if (line.startsWith("HFGTY")) {
      const m = line.match(/HFGTY(?:GLIDERTYPE:)?(.+)/);
      if (m) glider = m[1].trim();
    }
    if (line.startsWith("HFCM2")) {
      const m = line.match(/HFCM2(?:CREW2:)?(.+)/);
      if (m && m[1].trim() && !/^nil$/i.test(m[1].trim())) passagier = m[1].trim();
    }
    // B-record times are always UTC per the IGC spec — HFTZN is the
    // timezone the pilot's own device was set to for that flight, used to
    // convert Startzeit/Landezeit to local time. Always trusted as given,
    // including 0 (UTC), since that can be the pilot's genuinely correct
    // setting rather than a misconfiguration.
    if (line.startsWith("HFTZN")) {
      const m = line.match(/HFTZN(?:TIMEZONE:)?(-?\d+(?:\.\d+)?)/);
      if (m) tzOffsetHours = parseFloat(m[1]);
    }
    if (line.startsWith("B") && line.length >= 35) {
      const hh = +line.slice(1,3), mm = +line.slice(3,5), ss = +line.slice(5,7);
      const latD = +line.slice(7,9), latM = +line.slice(9,14)/1000;
      const lonD = +line.slice(15,18), lonM = +line.slice(18,23)/1000;
      const latS = line[14], lonS = line[23];
      const lat = (latD + latM/60) * (latS==="S"?-1:1);
      const lon = (lonD + lonM/60) * (lonS==="W"?-1:1);
      // IGC B-record layout: time(6) + lat(7)+N/S(1) + lon(8)+E/W(1) +
      // validity(1) + pressure-altitude PPPPP(5) + GPS-altitude GGGGG(5).
      // This was reading columns 25-29 (pressure altitude) while calling
      // the result "gpsAlt" — the actual GPS altitude field is 30-34.
      // Mixing them up doesn't just mislabel a value: pressure altitude
      // can drift from true GPS altitude by hundreds of meters depending
      // on the day's air pressure, and a single dropout in either field
      // reading exactly 0 (a common "no fix" sentinel) can silently
      // become the "minimum altitude" for an entire flight, throwing off
      // every altitude-based feature (height-coded track colour, max
      // altitude stat, thermal detection). Real altitude readings are
      // never exactly 0m for a flight anywhere the app is actually used,
      // so a 0 reading is always treated as a glitch and skipped rather
      // than kept as a real data point.
      const gpsAlt = +line.slice(30,35);
      if (!isNaN(lat)&&!isNaN(lon)&&!isNaN(gpsAlt)&&gpsAlt>0)
        track.push({ lat, lon, gpsAlt, timeSec: hh*3600+mm*60+ss });
    }
  }
  return { track, date, pilot, glider, passagier, tzOffsetHours };
}

// No HFTZN in the file: look up the real IANA timezone for the takeoff
// point (via the tz-lookup library, loaded in index.html/flugbuch.html)
// and ask the browser's own Intl API for the correct UTC offset on that
// exact date — this gets the right DST rule for whatever country the
// flight was actually in, not just a rough guess. Falls back to a plain
// longitude estimate (~15° per hour) only if the library isn't loaded or
// the lookup fails for some reason.
function estimateTzOffset(firstPt, dateStr) {
  if (!firstPt) return 0;
  try {
    if (typeof window !== "undefined" && window.tzlookup) {
      const zoneName = window.tzlookup(firstPt.lat, firstPt.lon);
      const m = String(dateStr).match(/(\d{1,2})\.(\d{1,2})\.(\d{4})/);
      const d = m ? new Date(Date.UTC(+m[3], +m[2]-1, +m[1], 12)) : new Date();
      const parts = new Intl.DateTimeFormat("en-US", { timeZone: zoneName, timeZoneName: "shortOffset" }).formatToParts(d);
      const tzPart = parts.find(p => p.type === "timeZoneName")?.value || "";
      const om = tzPart.match(/GMT([+-]\d+)(?::(\d+))?/);
      if (om) {
        const h = parseInt(om[1], 10);
        const extraMin = om[2] ? parseInt(om[2],10)/60 : 0;
        return h >= 0 ? h + extraMin : h - extraMin;
      }
      if (tzPart === "GMT") return 0;
    }
  } catch {}
  return Math.round((firstPt.lon || 0) / 15);
}

function analyzeIGC(track, tzOffsetHours, dateStr) {
  const tz = tzOffsetHours != null ? tzOffsetHours : estimateTzOffset(track[0], dateStr);
  if (!track.length) return {};
  const alts = track.map(p=>p.gpsAlt);
  const maxAlt = Math.max(...alts), minAlt = Math.min(...alts);
  const startAlt = track[0].gpsAlt, endAlt = track[track.length-1].gpsAlt;
  const startPt = track[0], endPt = track[track.length-1];
  // Max.Steigen / Max.Sinken: for every point, look at the altitude change
  // over the next ~30 seconds (nearest available sample), take the best/
  // worst rate found anywhere in the flight. Replaces both the old thermal-
  // segment-average approach (Steigen) and the raw single-step rate
  // (Sinken) — this 30s sliding window was derived empirically by comparing
  // 83 flights against their known XContest-entered values (best match of
  // any window tested: ~50% exact matches, lowest average error).
  const CLIMB_WINDOW_SEC = 30;
  let maxClimb = -Infinity, maxSinkRate = Infinity;
  {
    let j = 0;
    for (let i=0; i<track.length; i++) {
      const t0 = track[i].timeSec;
      const target = t0 + CLIMB_WINDOW_SEC;
      while (j < track.length && track[j].timeSec < target) j++;
      if (j >= track.length) break;
      if (j === i) continue;
      const dt = track[j].timeSec - t0;
      if (dt <= 0) continue;
      const rate = (track[j].gpsAlt - track[i].gpsAlt) / dt;
      if (rate > maxClimb) maxClimb = rate;
      if (rate < maxSinkRate) maxSinkRate = rate;
    }
  }
  maxClimb = isFinite(maxClimb) ? +maxClimb.toFixed(1) : 0;
  maxSinkRate = isFinite(maxSinkRate) ? +maxSinkRate.toFixed(1) : 0;
  // Thermal count (separate from the climb/sink rate calc above) — counts
  // sustained climb segments using a simple threshold-crossing detector.
  const thermals=[]; let inT=false, tStart=null;
  for(let i=1;i<track.length;i++){
    const rate=(track[i].gpsAlt-track[i-1].gpsAlt)/(track[i].timeSec-track[i-1].timeSec||1);
    if(rate>0.5&&!inT){inT=true;tStart=i;}
    else if(rate<=0.5&&inT){inT=false;if(tStart)thermals.push({start:tStart,end:i});}
  }
  // Total height gain ("Höhengewinn"): sum of every positive altitude step
  // across the whole track, not just within detected thermals — this is
  // the standard "total climb" metric (matches what tools like XCSoar/
  // SeeYou report), so a flight with several separate climbs adds them
  // all up rather than only counting the single best one.
  let totalGain = 0;
  for (let i=1;i<track.length;i++) {
    const diff = track[i].gpsAlt - track[i-1].gpsAlt;
    if (diff > 0) totalGain += diff;
  }
  // Startzeit/Landezeit include seconds (HH:MM:SS), and Dauer is derived
  // from those two strings via the same formula used for manually-entered
  // flights — rather than independently from the raw track timestamps —
  // so it stays consistent if either time is edited by hand afterwards.
  const fmtClock = (sec) => {
    // Applying the offset here (not to the underlying timeSec/durationSec)
    // keeps duration math simple and correct regardless of timezone, since
    // a constant offset cancels out in any time difference — only the
    // displayed clock time needs to shift to local time.
    const local = ((sec + tz*3600) % 86400 + 86400) % 86400;
    const h = Math.floor(local/3600), m = Math.floor((local%3600)/60), s = Math.floor(local%60);
    return `${String(h).padStart(2,"0")}:${String(m).padStart(2,"0")}:${String(s).padStart(2,"0")}`;
  };
  const startTime = fmtClock(track[0].timeSec);
  const endTime = fmtClock(track[track.length-1].timeSec);
  let durationSec = track[track.length-1].timeSec - track[0].timeSec;
  if (durationSec < 0) durationSec += 24*3600; // landing past midnight
  const durH = Math.floor(durationSec/3600), durM = Math.floor((durationSec%3600)/60), durS = durationSec%60;
  const durationStr = `${durH}h ${String(durM).padStart(2,"0")}m`;
  // H.Diff. is computed from Start-/Landeplatz-Höhe (same as the manual-
  // entry formula). Distanz is deliberately NOT computed here — IGC-
  // derived distance wasn't accurate enough to trust, so it's always left
  // for manual entry, and Ø Speed only gets filled in once that manual
  // distance exists (via saveComputedField, same as for any other flight).
  const hDiff = Math.abs(startAlt - endAlt);
  return { maxAlt, minAlt, startAlt, endAlt, startPt, endPt, durationSec, durationStr, startTime, endTime,
    thermalCount: thermals.length, maxClimb, maxSinkRate, totalGain: Math.round(totalGain), hDiff };
}

// ── FlightMap ──────────────────────────────────────────────────────────────
// Builds a minimal valid GPX 1.1 track file from a flight's IGC track
// points, so it can be opened in an external map viewer (gpx.studio) that
// renders real map tiles reliably instead of our own hand-drawn canvas tiles.
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

// ── WorldMapView ───────────────────────────────────────────────────────────
// Shows Startplatz/Landeplatz markers across all (or just the currently
// multi-selected) flights, rendered with the MapTiler SDK (loaded via CDN
// in flugbuch.html) — same approach as meintauchbuch's MiniMap component,
// using the OUTDOOR (terrain/relief) style with German-language labels.
// Separate from FlightMap's own custom canvas renderer used in the flight
// detail view, which stays exactly as it was (it needs the height-profile
// zoom sync, which this map has no equivalent of).
const MAPTILER_API_KEY = "HFElbKEufz9KOHI4w2jB";

// Stylised paraglider wing icon (top-down view, transparent background,
// user-provided photo/render) used as the profile-sync reference marker in
// the flight-detail map — replaces the plain red dot, and rotates to face
// the actual flight direction at that point in the track.
// Selectable glider marker variants — colour/pattern options the person
// photographed and cropped themselves (see Settings > Schirme). Chosen
// variant is persisted ("gliderVariant" storage key) and used everywhere
// the glider marker/reference-point icon appears.
const GLIDER_VARIANTS = [
  { id: "v1", label: "Dunkelblau", dataUrl: "data:image/png;base64,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" },
  { id: "v2", label: "Türkis/Schwarz", dataUrl: "data:image/png;base64,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" },
  { id: "v3", label: "Gelb", dataUrl: "data:image/png;base64,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" },
  { id: "v4", label: "Weiss/Blau", dataUrl: "data:image/png;base64,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" },
  { id: "v5", label: "Orange/Türkis", dataUrl: "data:image/png;base64,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" },
  { id: "v6", label: "Navy/Weiss", dataUrl: "data:image/png;base64,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" },
  { id: "v7", label: "Blau/Orange", dataUrl: "data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAKAAAABeCAYAAACkVx9EAAABWGlDQ1BJQ0MgUHJvZmlsZQAAeJx9kLFLw1AQxr9WpaB1EB0cHDKJQ5SSCro4tBVEcQhVweqUvqapkMZHkiIFN/+Bgv+BCs5uFoc6OjgIopPo5uSk4KLleS+JpCJ6j+N+fO+74zggOW5wbvcDqDu+W1zKK5ulLSX1jAS9IAzm8Zyur0r+rj/j/T703k7LWb///43Biukxqp+UGcZdH0ioxPqezyXvE4+5tBRxS7IV8onkcsjngWe9WCC+JlZYzagQvxCr5R7d6uG63WDRDnL7tOlsrMk5lBNYxA48cNgw0IQCHdk//LOBv4BdcjfhUp+FGnzqyZEiJ5jEy3DAMAOVWEOGUpN3ju53F91PjbWDJ2ChI4S4iLWVDnA2Rydrx9rUPDAyBFy1ueEagdRHmaxWgddTYLgEjN5Qz7ZXzWrh9uk8MPAoxNskkDoEui0hPo6E6B5T8wNw6XwBA6diE8HYWhMAADXTSURBVHja7b15sCTHeR/4+zKzqrr7db9r5s2BOTAcDM6hAC4PUeCSxkAUTUm0V5S0M96QtLKX8oaXlDa8duyGIvZ68xyO2Aht7Hot7cp2SGtxqYP0e7ZDole0xKU4AxriIYEXiBkMwAEwwNzXu18fVZnft39kVlV2z0AEQBCiyK6IFzPdXV2VlfnL3/f7jswGxserPTQRYd++ff8wy7KtNE17+/fv/x+11gCgx90zPr6j4AOAgwcP/owxRgAwADbGyP79+38hPmd8jI/X+yAA9L73vW9HlmXLAXyu/MuybPNd73rXHeE8Ne6u8fF6HwYA5ubm/jERCYACgIS/AoBMT0//b/G542N8vJ7sh5/7uZ+byLLscml6IwAyAM6y7ObP/MzPzMTfGR/j43Vjv/379x9VSgkAG4Gv/LNKKdmzZ8/Pj1lwfHxHPN+pqal/FdiuuA0ACwDcbrc/qZQaOyPj4/U1vx/5yEfaaZpeiUzuKAAZgGRZtnL06NHZsRkeH68b+wHAoUOHHtFaS/B65WX+nNZadu/e/dfj746Plz/G4YJXyIDLy8vvZmYEpnu5g51z6Ha7f23MgGMAvl4HK6WQ5/nDIvKtQEUA4Jx7OOhAHnff+Pi22e+3fuu3Gs1m86XSzP4FJrjUgVc+8pGPtMcsOD5eFwvx4IMP3pMkif0LHJAhEBpj+J577nlwbGXGJvh1YcCVlZV7nXM6sN+3YjRmZtrc3Lx/3MdjAL4uAOz3+/cHB0RewXeEmTEYDO4fd98YgN8+AonQ7/fvfrWgtdbeS0SvFLRjAI6P25tTIoKIHHy1DoW19sDYEx4D8NsGoHNOM/O+VwFAAoCiKHZ//OMfTwMDjj3h8fHa9N/Ro0dn0zRdfoUecHVOkiSbjzzyyK5Xy5xjBhwfQwA8e/bsrIhMvdovi8jE1atXt48B+Bcf33clQyLiwXD8OOHw4RoYp05V/z+Jk3jySxf1g7097r+5fHmnApRR9EpNKQFgTVCJc7tOPPLImSebF/WD79zjjuBIfdbhw7VzcvSoVM4KEej7yHGh72GQEZaWCHOn6ORJ4PrpBTm2VJnQV35MbHsvtm5+Bj4G+EqLCywAg+b0T6C3+slX3X5AnZyfV0cAnDwCXL9+WI4ePcrfi+Ck7xWgnTx1igLI3Mt+IUkh+SAFYNauXbujd/7s/vzqRa0HeSb9jbuL1RvbeGsTYnSLi0FH97v81LmL93zu6eeOQBxDRFHVbQKIVL1I4T0BAUQspNQP3bXvsbfdc+AZR4nSzU7XFcWWSTPWczs2THP6DFTSzXbsAO3afWn20AMvAcgB5ERKXg5n84A6Mv+IAo7gyOHDglOnBMePS1gmMAbgdxJsS0tLau7UKQJO4tGFx9xt2SzNIIN+Z/O55+7cuvjNu+zGxh63ub4LG2s/4DZX9iu2s8Wgm0h3a1cbTlPRBxhIZADtLJQIrBMQO2hyAAlECCQCpUoDS2AIlI/z+UYIgUgAIkiFTQGBYMmrHUWAKILoBIXKAEWASbEFA07TK6rRylWSdtGaPK87285Ie+JC0mrdSGbuOL3tbe98BsDqy4FTjh7V+MgDhOuHBUeP8l8VQNJfBcBdP31aji0tDTObSSHFYG7r3LN7ls98Y6dcu/ZosXb1PrKD/dwf7FZba7va0od2DpznQN4F2RzWWljnJReRsBDBWRYyJFprgABXCJQikCEIgWwhGiJQxnhAOvbQMtrjkRlggJQPXItjsAiMIlYaLE7ATqA1hfMFzjlSirxRZSgogiGC1howGpS0QWkKGI0tlSHP2jd0o3VDNbLLaM+cMbO7Pjd56OCF5K63XGo0GueIiG9rxg9/dwOSvstAp04eP66OnD4tNAI4EWmvn336B4pzz93du3n5HfbmpXdg+eY9MujNJHkXrcEmyPYxyAfIBxYggTHknGOxLEjShMhoYge4wkFnhpRWBGYUuYVJDMgYkAhsXkBpDUoNSADOLUQYKvE+mzgHKSxIK6gAOFEK0ApKabBz4fzUs5x14KKAShJAKYiz4MJBGQXSCnAOtnBCSokxGmAnRV4IATAGsE40iSKjDdIsgUoyDLJJuKyJwqS5TG17Lp274wmzbeczenr757e/85HTRHQ17r/Fo9BzD8zT9cNeT363AJL+slkOS0vq5KlT9OjCwpBJFZHk2pe/+E730tkfzFdvPiQ3L/+w2bixNxn0IL0u0F+FWIdeXkCEOM0068RQnjtiEUqyBFprsv0czgmShgElCVzu4IoCSTMDpQnEMuxWDybVoCwBWGDXNwBF0K0JD8itTUiSQs/uArQCb65B0gno3ftBSQK+dhG8dgO62QElGm71JrC1Dmq0oNMUbtCDDAbQrTYoTQBbgPs50GhApSlgLWy/B5CGafjXblCAAaTNBOIYNnciIpJmSsQ6yXMmMFOaKqVVAmpOQjUnUJgUvYmpVTV3xxeSzszjZu/+b+x694/9KREtx31/Yn7efDewI/1lMt2jCwu2elMn2Lz0wls2n/jTd/SvXX24uPzCu7PNG3dn+QDFVg/cX4GIk7wQVkpJ2jBEyqhBLydSQJIlIJMg3+qCQEhaDVDWQL65BViHtJVBWhPg9Q0U62swnQ5Mu4Oiu4ViYxNmbif0tjlI4VDkDsmdd0Hv3AuCQpH3oXcdgNm+G6Q1bN4Hshb05IxntK112I11mCzzJnp1GcWF56DBUEkGWb2BwbkzUIMuTGsCvLUOe+UCSGmkUzOQwRbs2hoobSCZmYUUOVx3EyIaZrLlAdnrgQtG0m4CzLB5Dlc4pK1UiFmKvGDnGKnRikSUarShWx0ga2Crte2a3rnv88253V9o3/Pmx1oPPPQEEbnvBjDSG812dOyYi4FYPPfUwzdPPfXurUsv/BhdfuGRTm8Dg+4muLsOsJVBIU4pQtpIlFJa9bYGMAmQNDJAafTWu9CpRjIxAcqayG9cB7GD6bShJqbQu3wJ4gZId+2FntmJwfIKuN1B4+ADMLM7UAwGcJ0ppPsOQTU7EBY4Iqj2JEgbCCRoPAYRQBA4AcRaaCp9EoIQQYFApMGhV5VSIFIgALa3ATXoQ+sEUvRhr70Ed+UikmYD0t1C/sIZuKvn0ZyZBfc3UVw6D+n30NizH2xzyNoyHAPp9h0AW7jNTRT9HGlnAooErjdAkTtkrRQgSNEv2DmRRsLEMFo1JtGYaKKbdWD3HDyVbr/jjycO3PvYzDv+488S0WY1JouLGqdOCS0s8PcEAGV+Xi2dPk2lE0Fphs2zp39w49RXH9589smfb9y89FZ0t+BWb0DyDVhWlpmRNVJFWqveZh9JopC0GhAQehs9pA0D0+4AZNC7cglGAXp2G3Srg83zF6BnZpAdvA9qahv6W32YOw8h3XcXqNmGdQKZnIZutrxeE4a1DgqAgkAgKIoCCoBW3mmw1gEEGJMCYDjHEBFoY0BEYHYQFihSIKXAbMGWQcZAEyAicCJQ2kAp5cuqSUMRoLVPRnGRg9eWYSAgW8Bdu4D+N59CZgxQdFGcO4P84kto7tztAXftMopBgXTXLhhjYNfXMejnyFoNaEMouj0UOSObSEHC0u87JkBSxQamAT21DXqijf7svheTfYd+d+r+N3+2/cBbP0dEhR83KBwXjDo3f2UAKIuLGseOCYVqEBGZW/nSZ39048k/+0V38aV3pt1N8M3zyPNcCguXpSDTyFRvqyCCQ2OiCRGgt76FrJnCTHbgLNC/cgVJQyHZcQccpehvbCE7dC+SA/cCE5PIKUV64G7oqe0grTDgcuAJCkCe52BbwGgNoxWsdXDWwiQJlFYQEdjCQmmNsOMVrPVKQWsNIoJzzgNw5LVSCkopMDPYMZT2r0UE1loo5b1cYf+aAJjEQARwzBAiJGkGEPmIuXUwYRJwdx35+RdguqvQ1iK/cBaDZ74BQ0DaTFFcehHFxhayuZ0wrQxuYw39rQJZO4MxCoOtPqwDWu0ENnfcz5lTxcqYROnZO+BaHdDOvWeyQ2/59cn3/yf/rkl0LnjThMVF9Z0yz/QdAh6XEfv169fvW/n3n/iHxZXzH0xWb87pq89jozcQsLhmU6tClCp6BSZa3knYXO8iMQqNyTasBfpr60iVg942i0K1YLMOmg+8Fcm+/XDJBHhyG/TOXdAmg4CQ5zlIGIZ8Wivv96GIYIyB0hp5nkMAGGOgtYa1Fs45/3kAS1EU0AGAJXioDJEAFeBMYMBRADrnwMzQWleAdM5BKXXLNY0xniGdAzuHNE0D6B2ss8hSAygDdl4apGkKRRpOCvDqCmT5GhLOYa+cR//0V4Dlq2goB3vtIopCYCankGUG+fo6Bjmj1WmA2KHbLaATgywF97qWBUq1M6Nk+370prZ3m7v3fbL9nr/xv87ce/9XwLYa21hCfVcBUObn1fGFBSwADJPg+uOf/uDq00/95/b82R+fvPZcY3W9C1X0XdpIqDuAMmTRnEjR27KQokBzsglRCbor62hkGsnsLPKBRe/SZTTe+W60Hv7rKNrbwDM7kHQmQVrDWYui34MGwRhvyvLBANoYmMRAkcJgMAApBaM1tNLIi7wCj9YaRVFUANRag5lhrb0FgAigfTkAxoArX5eAK6+plKoAVxQFiAhJklT3EJEIgH5iJEkCRRqFzWGLAkmSQmuFwjo4FugsRZJkYBG4fg+yehWNfhf51x/H5mf+AGlnGs2ZDuzNa+h3C2TTk1DKob/eBcig2U4x6OXIHaHVUFwMcilUQ8+2m9jcfqdTew8+3rn7/v9nx5Ef/20isuVYv14a0bwezsXx4yc1LTxqoVNcf+rLf3P983/yi71/97vvN8vXgdUrGBjldC6qnTpNIpB8gGZKMAJwMYAGI6METgTODZAgQ0MDbPuY/MDfQvs//QVApUjyHmyew/AgsIBDagBtNEhpb8ZYwWjltZl4B0IBEKX8IDFDBFAiIJHRZ3nZPyqzHtF3yv/H/36r94Zf1++VbWWWihZEODgzgtQoaDLQhpAYgzQhsLUQctBSQFwBpx1oxx3QWRPJvQ9C7TwA+6mPIdEEqxS0OKTivC6FhViHFhMS9NHPLRppQzU1YzPvSrHVZ7N6Q9O1Fx+RF0898tyZp/7elSc+/6s73/bwIhHZ+fl5A4AXvk0gflsMuLi4qI8FSpanTrzl2mMnfyW/cf195vwZdDfXeUV1pJEa1RNFF20bSWca4Bwv9prgzgw6DcK11QKr6TSmp9pIXA8vrQyg2jPYO9tA3stxdf+DaEw0cWhbE4WzuLzSx+REE3ftaEFpwbW1HiYaCe6YaWKqabDR6yM1CSbbBhOZgStyKK2RGA2tCLYoQBBAawAKee4ZUGsNUgqOGUVhYbSBMRoCgXsFDHg7E+xf+4lhrYUOTAx4k0skyNLUZ0/Ee9rKpBARDKyFtQJjNAYWWN7MsdUr0GkmsA546UYXy5s5ZjopOlmGZ69s4Mb6ALOtBNunMpy51MXqgLH90mlsnzB4fqVAvraK/ZMKlLVwba2Pdn8Ze6ZSrFkA68u4M92CMhrFxib26nVMKCt5bnnOraCVNTUdeABm+86vJO9434en3/GuPxvFwBsGQBGhY8eW1NLSMXdxeXn/pz5/9R9cPvP0f/nwS5+ZeHYrceuNGQyQ6KexE6ozjX5vgOvoIJuaAvcHWOlbNCen0EmB6zc3IVkD26cbQJ7j0moPnXYLB2ebuLaygUs3NrFtsoEHdrdx4foazi3n2DnVwoN727i+3sWT59exY3oCD+5tI0uALzy7jMl2hgf3trF7OsPTF1dhTIJ7djVxYK6Jzb6DZYc7ZlvYMZUh1QSGRTNNkCYaCgx2FkQKIA/IvLAV4KQCIGCCE8LMcOyglYbSKnjFDKM1kgBasNeAQgqFZXQHFswEy8Bq1+Lich/dgcXURIKVjQJnLvdwda2Pe3dNQJPC117awEs3enjz3gnsnmniay9u4cUbXeydSfDQnVP4+oUuXlruYVsGPHRwFs9c6eHSch+TbYNDe7bh3I0+rm90saudojXRwqXVLoreALtmJ7DlCBvrG5hMgaQxga2NDczKJhqtBmR9HXfTVaRwPNu7xgcahXli75HBgXsO/PZP/ND+/2XXrunnjx5d1IuLr81JMa8BfCq45u7ff+HsT/3a0ul/dmlFdjy/3MFjjb/hthKt0Wr7QCoUWlkLg8E6AKAFoBBBAouW9JE5jYT7SFnQcUDucky4PiZYocFA5gaYbCh0Mo0sUcgSg3aTMZEZJImCMRqtRoJGmkBrjdw69J0gtcB6T+BcgSde6CJJEmz1BRdXLP78uRVs9BkP7J7Agbkmbmz2cWl1gLt3TuCunRPoNDUGtsB0O8Hu6QamWgmyREErQqoNlAJ8WNDni33xgQIxQFpDQLCWYMHo5oKt9Rw3NgpcWe1CRCG3jOvrFqcvboIguHO2hc2Bw6nLW1jvFvjBg1NItMYzV/u4stpF0ySY6zRgWcOSQu4ApTQamcFEyyBJPMgnMoVOwyBLgFRrtFKNiYZCQ3I0uI+m9DHBPWSOMcGENvfQ4xwNp0ECWMmhWCMlix4Bq9xC00xiK8twmeeg2h2FdF01tLBdVtnFM+t/9+zlp37q9z/3zC/+5F+79xNEr40NXxUA5+dPGCKyIpu7/sW/feaf/tvHLx47d3MAl/etyiZ0kTutADS5j17eA7IUicu98E8SX6/Onj2YCA4AC8DkmcGxz8uLEBwUnBCcwP85QW4dHPuQhXO+aoXZ/zkWCIsPFhOB4KtXmqlCkiikRiHVGs00gQ2hmZwJV9YdXlp20GQxKLpY2crx9KUtzE1muHtnE1kCrPULJErh0K42ptsG7YzQSLWfCEZhq59js8/Y6FkMcuDcjS6urefItJ80NzYKPHOli+2dBG/a3sDACl5acUg1sHMSgNZoJCls5vVdogiNRCFLffhISAASEAQigHUcPGuBc+xjmwwIA4UTOAcIe11pmXy/EsDQKFgg4f/MYQxAYCiw83KOCBBnYZyFIQYVPTSdQk8cUDilGw25dGPNXVpLZle71z/+f3z8C3/rP/ubBz+8s73zyvz8CbOw8Kh93QF4dHFRLxx71D555vyD//Nvfn3p3DV3z3M3u66pncpFGQXA5Q6SJRAHWGZoBOEv4kuRQiVIydMcHIJSjHMl8H2HcqhaEQhYeEi8s/hrla8dC8T50ikRD0jrBE4IigHrBIV1sI6Ds+NFf6IJqSEYTTBaIU0TNDKD1CgICKtdxjNXcjAzun0/OpdWexjkjH3bGug0Dc7f7GGt77C9nWCuk+LSWoHrGzn2TDdwx7Q31c2GQTP1gGVhpBpIlG8rOz+pCvHtI1D1PJadD3xzAF8AVtkXvn8ZHEpVRbjuq7KfJJSIQcAM+DJKgcBf19eZhaqeUOzlxFf0EBEKEWQsAPmoQQKinMlkbOXM5S3uDpofvPI7Zx748tNnf/Zt9x964tWAUL0SmTg/f8IsHTvmPv5HX/nwRz/9/Be/9PzmPZdurlqjlWbLVMDbJcsMEIXGkxfXXHaWf2iW2MurlWgFRF9p50FW9kZgudDlYLBnQRGUEGVhOC5dS8CJ+PYIAyKBOf2AC/ykcCywwZwyCwr21/XM4b8DEmQJoZUaJEYjSwlpYqASA1IKBAWlNbLEoJEYpMagmRAaqYJSUnve7OCcg3UC6zwwnLC/T+gIEoJzgOPSi/btsuzbrOCZzbm676Rkf2EIuWrylb0ljDCxa9ChqiiMPXIGSxl5Lie5/573jxhCgHPWF2yQgisckVb62vKa/epL+T2/85mLX1j89Nf/7sLCo/YR7yV/+wA8evRf6YWFR+3H/t+v/oPHn9789a+cW2vawnLBYhiEIqSpEEIIFDpFuNajHMIJEmZoqNX03Bb+RcWO5czlwH0CCKHEUkmfJWjKCzuHMJD+mv5zn7uVAHwn3kSXnWvZo57gv1tqu7LY2VbvIYBV4KxUk6o0/SwlUBgFM2yJey4ZiyBCYPHm0ElVswfHIbcctcNx2S9UtYmlBq0PJfmiWAYCoP09UAJHEE1Of73qs8hycLgX6NaQEYuLLI4nF295/Jhb53cqKViMLQr+2oub+uRTK7/xu3/0jQ8/trBgjy4u6m8LgPPzJ8y/Xjrm/vnS5//xZ7+x9r8/e2HVWSgBiyocAPIzGMET5NBpIp7HqniY1CXsviMCtDisYgyzVCCgwIIs4XOhirFK8iwHEtEs5sAk/v4AM4VrUkmidWdLGFAOnRtMWfk5hSlRDjzCQDsJYAnP6ALTipT3jO+B6h5cspmUmrW+MQd2qdpQtg3ldxBA7lcfiHjzXPZvDVgO5wfzLRT6mQKzVYhEtclItKoAgtDf4SNBiJOWfYHK5HMgkbKwt3AEiCiG4NnLG+6xU6u//tHff+IfLR075uZPnDCvCYClHf+N33/iv/vKOfs/PHdl3QpEOSFiZ+FAIPYiuKLwkuZL0ygCYa5YTeJArtR9ggAQDzZvN2oCDYOAeJaWA18a5ZrByr4tGa/UhCwMG2vMEgxl20Rgg3Zi1M4Nc83SLDVQS6Z14Xw/lWp9Vj4rl9YgPK8LACubUgKuNAuuMqnhHjz8uQSnzAMElZmuu9UzdQlQCsAqg9oSTYhy3MrlA6XeBkKQnimyXBFqmQFQqBJy3pFxjII1GWH19PlV+6Xnev/Tx/7wq7+08Oijdn7+5UF42w/mT5wwC48+an/vU1/+0Ge+fvNXzl3tWtJGW1uQKIFj53VaZDI909VgxGiW4RbwSbWWAlFGwIOQwDzcKbWWBAghYxB6hlGyGXu+K5mK/ToNb+pQm0tQxV5+34JwjXJwEcxb0LKeedhPJlVqr6BvOWL08H0OrFMxGgAhGmLVErCuZO7Y9LFvAyJmDS2snqXuSyplbjWZS4dOUDslkOHJKUPVv1yvqC91X9mmMqkv7OuFSnOiUVuTMrqhNHInpLXS37xw04rYX/vDP3lq+QPvffPvLS6KPnaM3LcE4OKi6GOPkj3x+Wd+5N984dL//fzlLisFzU5InPiOZJ/aQtRxNcVL5YHVE7fk+3om+yfj4HRwpAWl9M/i8uiga1Tk+YVBQl3uRCWYS0YMI0Nc60Iv5X35lCtnf5gAMfN4R0ZVICp1I4UFSV4m1GxUMWTFRrVu89/nSo+xUASGGDw0dH45MWwl26hm7oqWKIA+1twUebrDnm/JohUgq/fjBVYSwjZhlR94yNp49o0XX/nJTYrAzsFSQoZIn7mwwQ0jHzv1zctfP3w3nYpiyLc3wfPz8+rYseMiItv/6MsXf/Pp82tCGrDOR45sKV45zm2O5kVrU4DRnGrUASy1pxYDWaIZXJrkkrFqs0FDZqdySoZYJJhxokoH+WZz1W6OwVNpt5LxMOLBh4EuNWDw9str1Xnd2tGq9ajUbFYyULgXR+0oJ5oHddRu5spieCdGIrZDpY+rCEDUF+U9hsBVWhURMJUmnqv3ZDQ/HkkmRH3mz+fQTn+eZQpOIZNSLKcv9vUnTpz5mIh0jh1bompjgNsB8PThw6TVP+Jf+a0Tv/30ZXtn4ZgFUDaI5pLKWVxtZm9JwEdAq7J9FLn+wMiLembFy209eryGqRiv5kaWoQUktUahKE4YAFyFacSv36XK/FE1x72XWjOLSK3PJB6w0hCWjkX0nDGoKSiSEqRUSpUQCip/bKnUYBLaXjFg1C8uNq+B0TiefEHr1pq5ih9Uy0QrrQsKDBmb12GpVI1rTBDViFIdvYjJJ9b9IrD+Xro/6Nszl/mtv/p7/+GfLC0dc0tLS+q2AFxcXNRLx465T3z6az926qL90eX1dUsEza6erfGsk+EmRzMGQ8CJ59OQBkStH+PZRUFHcvRB5TFTbS7jgHZtcmmImSUKy8jIDOYQ7wsScFiXxu0VDLF0zAZD2isOqAMQKp8wTAIqmR1DE3NoopTMJ5ETUoaCIs9NhgAxEqSPFA8w2vaIKeOTpQ53ya251xEtf/s188ylhy1VIkFYoJUyV26s2afO5//FF5++9LZjx465xSg8o8riglOnTomITH/+a5f/zxevdyXRpEo3m6OBjNUsx6ot9pKGZtKIAzJE7VQ9VMyXnklU/VkcLoi+A8Qxq+F+YUFkPlGFSiRuX8l+qDVcnGEIYdta7IuqgOGTfXXsTUZLtEp+rMI20bNGwI1NMlUYo9oclEGgqP/qOCFqMw0Z8pRHQVwZCIoBWjLaCAvKMLWIjIQtCLX5DYNDIV0o4kNpJfMzC4xWdO5GT33ys6d/TUTSU6eOyhAAjx8/qRcWFvj/+t3P/dL5NX3QFrmDQJWebf2AMhw7ih6GaJgQh/ASmbX6S6HD6XYDV4Je1RH8IHwRmUsaCWgTbpnYZfcGbzQC3AiDVewTZYBKNoqDuqWnzkGbxmzE5YCyjHj/8TWHSaUe3KA9g3MjUZ9VbC5lDAD1tpdCVaqtTOQOMTsAV/VCLBuommDVzg6VNZChMBFhOHoxyoyC4fZyNCYhCaF7vb47v4KHf+8Pv/wTCwvEZWhGiQgtLBxxItI8/dL6L9xYXRetleLq4QnDBjduAFWZhiHBGj3I7Qy1xLot8prj68tQXCq6bwUoGj5T6tlXdlxkF2vwIA5H0JC2kiFHpzbhiDRgTTQybNpGJAikDqPE/QOMyJJb7huuWe43U3mbvsiWaPiaGCKGmpnL3DDJSIYD8XOFEYydmqEADQ0HLaq+oKj9VE2MKqyGiGEDGxqtcGW5J08+f+3DIqKAkwwA6vjxkxog+WeLn//Q1a45UPhSC8XRbKkfkCPBHbnzgip/G1cPl89BFAkTqoEpikZgRcOasKKrEHMj1OwT91Pw9CS6BEI8DqT8LB/aF0sq5qydIBoCg2cHb3bjzq6GMQaCxB4php5JRixG6aTEGtczVsjREkWThYYmTpxFKpd+1ibVX09VFdYcqmiGH5tCtZEIh7BVSe9cdTdHNpjixkfAckOsXJoTDDugwVL5NrPu9vt8aVU/+olPf+1HFhYWeH7+hFELC0dcoglPnr35926u90UTiIboVoY9nRDKwG1K02/3f4pneumVoc5XVomvSATdopMhUSghKpOPZ2J8Pan1CVUOwa1tq5+vHAgKizOjRH0kOzhyZIbjaBgCdGymKocIkW6TKDIwZD5jrRqzvdzax6XjQIhkAFXPDxmWQMMOVq3lqkeH3Opb0DDIJOTSA6OECUARu/oMighC7HXY2dEEubFWyBPfOP+zAHDy5EkYgOSLf/bNQ//0D07d64oeiDTFVFrnFEu6Ll378AQloykV8CO3OlCBLVCCJgKLIinTwf6ziC3LRd2lmaNIaEqIdVRxw2AaqGJuVIUGnjWDQiOq8qEVEKpMCAeWoKGNBIViV6VOT/HQxMKt4Lul8DwKV4wWpMf58sisDTNvSIFJbRoriR0DYogAhj1botEoRnQtRSPOolQePDDivAjV1xYJfVTba0JpscLuYr79elAMqFeY94lIk4h6CgD+/NnLHzp8aHcqTlxVVz3kCslI/G44el6yF92OZW4ToinZgmIVybXTUXlWkcfDVdZMhsM9I2aO4gwDqI4zlUwjNKJL6dbQJA1rtoqZYxFOGM7k3xKQoiqcJCOTUqKtpqvcc9QuxrA8qGOHNBJ1qD1+V7aX6pQahT5yMVNXnv2IBSplBTDs0HGkoziyGFw/M0ktSUKitHK4ygqcoF1Jgd3b7t+3+18u/cmPAoA6evSo3ru98f437e5gYC2peEAlcgFEhQAuh4bWpD80awS3mGOKPV/Cy0QQfVdQXQJYnVwxYMQ+I1GZ4fdk2KuNsxU1uG4XGopBKSNMETe0zOQOAwGCIS16u6iAjMzpOERzi1MxYtpjB+lWB214DIYtcKQladjLjZ0rim5PRLcZnchuD4XBbie5yn6okwMgQl4M5AcO7ZS9c50fFRFSnbe/v3X/oR27DDGYoci7Ez5kQRKWMGJErqM2FSFRHzdS/EZ51VwrdYJUMyVKFVGdovIhNapCDWU4TAILUORklLlgkjpsQxE7V1KYRsEuUZpMhlkh9qzLrAFhqERJEEkJ3J5Vq/ReJOpJalMqMtoirnVq3D6SOlYYf8Z1rLAmJqrik5WjU2o2SCUtqkldJjlJhrSsDMXZfKExVbY7nEG+yklFUKMIgCIEENdjJnXMlUXIKKH779q1j4hE/dIHfmjfTKcxk+d5WC9aD/otIp+G019x6mvY8YhjdBGVR9SOitXioB0NrYetdkQWilJ1FIRuMPsRwDhqT52FiVNHEp1flywNFVFgxJWOtGZdWazq646qOYk9zqg/h9oqw8wy5NGrirEqNgkuPAVJwSEITJG0kNsEw+sJHrezdlKIVLgfKqIY/n6cjqsxUOOChrCBoPtqEy63KBUlUP1eH400efNXv/rVaTXdan+g2Ww2IdYREYnUnkyZBSFicNB45KtyQCF5TVQ7KX43x1qUVyaYqHbnFVVpqRJB1WNGAe1SeqjgxXJpgkmqurshrVUyImpPs8R0VIweac7QPVQrc6741zseZfZPRawxnF25XeiHK+alqjStNFxSxfQEsabzz0XRgnSROk/qS7+o8lVEYk+UqgoV77ihdriAIUeycmIid2p0MtSaniJdV3ZRFDCvCKm0GqoK/DOigHkEYgbDGEW26HOaZvsmJ2d+RClNPz0YFEg0UWlyQYgqgyX2M0Knq6GMSOwRi8Qptdp7lWomj5irkd0DKK6GiRUFj7DGkPYYvm8M4OF43K0ZCkJdJcwj8Z+6sHRY1MU+sUQRAkQxe7pl2fUoiFENytCzlwxHUSFH5MEiKuEqLUBcWVRPPhl2XEZ9p1GtLiNsFT3jsHgpx9nvSexDL1yZ6FLv00j/+q2IfTBdBVzrRH1AAXjbVncLiVGqnul19zHIh0Oq9RRxhLg2k7XZ5Sre9/Iqfpgdh2wWhrz5uoo3ksBlqVRsDKoFNRWb+ZRWPGgsI0AIa1iIqNaEVMsdjsKThLqEv2Srqtw9wlpZelWpu7ICmWodxWVVDpVGYzRGWuvMstCienqhIXkRRxsoWKF64pcOKw8lKGKvt45kDzt9VCflq2cFS+WKxE5U7MWV46kqZV2H1gQMRQStoLa6WyDB+xVEjLUOjYRAKhKSpTli75TU8S0XhGswaFSncogikUh1kt5nPGRIg9UPSlU2gDFSYhQJqnIhDwWx7SSKOIViBFeaBUL9OmYzjvZ4CYuB4lhaXWdHVdlT+SgU5ZMRadcyfKIqRvMivQzYcpwWrEq2fPFstUCKo5hlKDaovG0S2JFwlovWqmC0QhrRwiqMWAgZzmKVe+eV9YG1BZPbeMF1uKX+f2h3FYgOuywHjFD1GFyJoEQDiVE06A8AYLeyYR+TLNFIFOqyehCElPd5lYIF+QXkYYBUeBB/I4YSX2tMwv4nDaiebwojC2BuzdJHaTsaLo2ichlCCMRUGz76UvOK4UZq5MpyeYo0oovuwSj35Iucg6ALw971viS/RKCiKqbnc7IlS3JkKH2QOGaCMo6mqjpErpylUieVi6eqrAZHZr9a6FQykV9KKkMMGdoZnKOSqas2lQAn3GKOR2szq9KusLifRKAV+fyQOKiyjKGq2A65ZzKw0ChIo0AC0QYFGVjSKGDAZAAmZEYhMRT24CnEsPMl8akhQKcoCoJhh4QZKfm1Fy2tULgCRhG0UxDjdy1gIQhl6MMClKJQDpYFRBksclhn0XAAKYWwi0Wg4ODJDkmrUA5F0cKmEHusMw+1PeSSwYiqjnPswz8U2NSxj9CXOsmxRI6Kv5+KQsYuhGEqZgp6pgo3iArfoaF4oqIoAxMuQJGZjt0jllorqaiULMj4atVZ+BmJIYerAj1HpVXkl6R6u+61o41MsFBpCbz3zlSnQWP5pEhBhd1aS+BaC/RzBimCVRl6sNCKIWJQgGAAGDeA4R5arkAzH6Cl/frnKSFsFkBqCAU7kGRYkQxIG9Dk9z/UhmAAvztAu9PEm+g67l97CntpBVTkMFrBDDaBJAUXFi7JUBQMlWVYzwXYmsAWZVi3GmynsWITrHECllnczCaxOtECwaFrHTb7FrkaIDUJejmDiaHZp9sU1ayjKkBJFUGvSu4phA6qZZZUqdwSYKV3WK6KQyifj7VUWTHi2P92RymWWMqFTWExU8Si1QoLUQABOg5BgEK7qWIeJRTlcWuHATKiNau8dm2ynZQ5IlUt0CrlRv1cweNlit2DaLlDXW+IwFZKEcoEWjk5civo5g79gQWrwgeLc0anyZhsCGaaDUy7dczd+CKS3homuYftvQK0uYpJZdFGH26Qo5MSOPf78JDtAaYJ2BySpnBMYJPiRTeFCzsewUTnrZCiD9KGTOEIF292sbVR4Kc3H8f23nMgnUKcA5yCLgZwyGDyLiAJJM/RYINeYdHKHaAN8kGBVpEidwr9woL6bZhf+O+xecdBDPoOy5sWV5e3sJ4TVrqM81cJm31BTwTrfYveoEAhCkkqKAqGMQpJyB8qTdAVqFSlaVkENjZl4hfvQOrgtg2OigpD5BjDDFeBXHlzEocjy+wBVMVmVcI9TJgSuOU+NLGnqChelE+1Ca7iaT716GTYXMaLwAkSdoBAFUgs1wlLVLPIwSzWzlT4ESatwjYfQGEFec4QKry0sBbNRGFHm9CayTCZNbB3bgJzUxmmUsG2yRSznQyJBlr5Bopf/x3Y689DNzJkfWCz539bRUOw6Qgt0uhZAVECsRZOCcAWCNuKAAO8pbiGu24qnPzSvWhONHHfvs6K+finnnryT88VDz568z/we7sXVd+0vTIhDQWBJQNAoaAEGhoOKQCFASkfFCSDHAoCA9YKxeYW2u/6EbQeOIxscwONuQbu3pnBHWj47c1Io9ffgUEh6BaE6+sDXF3t4/oG49pGgQvXt7C8maPnHHq5YKvnoA2QMiFL/SCoUoOxRBWJYaeDYB39AhkZirdZDgOtajC4KmBcD27FgNXrwMxhhwalvMMWO1KqzOKW7KW4rguslELsNdNQjhvhmZyToXOs1Ft3lA4HR1q2jKmWk6JggSsc+rnfk7AjCs2GwvSkwrbdLezfMYHd0xnm2hqznQTbJzM0jcBoQZYkgDCKIoeQBkDo93qQmR2gIx/E1r/8J0hUBitAjxRSZQBxyIlgQMgBJPAbS/nQlvYTWSlACHnSQfPK83jq3/yB+/od79Y/fn/yz82VDfviHHcffMi9KEL1QiAQV0FlFXa0UmE2kljvhLBAK4YiL0qVMCRrIfmhH0ZhPSD6edjGwVpoJdCawc4hM0CnaXDHdAuyvwmtNATA1oCx0c+xsuW3MXvx2qZcXClwfd1itetws1egmwNEWnyH+b11SrCgyj4xrFMi0XYczrHXor5OTRx74BCV23+IWFcXn0rY1Kh0OMOyTa1FSNjBCntHlYKRJhYRclUhveNar6HUoMF5kmoRefkFQICCUToyVOo74XoZgGWGExLHAmuFNp1F7vw1U8WYaWrMdhLaNdnAntlZ7NvWxM6ZFDNNv2VbI9UAHDnnvOYVr8f6OaOw5fJU9o6H8o6oG/SQvPntwK47oFaug7LUiwPx7FbuWeNjfSEMV8bFxJNZGe4irfCwuoRrpoc+TVwynbmZwb7LT2POrqOvUs8oXEa2XXjtd8MpPTrHw9W13mQpuEEf5p63sDpwCC7viVKq7DjRpAJrSFU2PrA+COB/N01BkVd8M01NOzoJHd7TBB6YImZBrxBs9IErqwNcWB7gwkpOl1cKXFkdYK1rUThC7ghOTLX1BStFEFVvlgQFTRqkHJTRIFIQTdBIvK5TGsooZGEtgyIgMQZEgiQszFYAEqUqj1iA4CUCToRE/FprIkArIA87dKXhPBf260gYYa9BgRIHX4gZsg+Uw5OIYOAIttwZQgE5vAyZaBp0MsKebQ3smcmwZ9Zgz0yGXVMNdDJBZlCF1az1m2yyMLoDV25TLEQQRdXyBiEKaYbSEWTxF3EFMDWL5kPvouL/+9dKZVmZrKCypK2UGsJhRwViMGkoZrDSIYsjyCnDjuI63ck3MOjcc8NMo7j6JtyEMwZgFRYlk7euUqVuxF+bfRU/+/JkYQdxgFgmdo5cMVCT736vSic6wKAPCpt0l7vLA6g2/i63tI3XDXOYPXmewzK8OXF5AYATbWj7BHo7Ow379oNtsJNur2Asb1p7Ybkvz1ztuheu9vVGjydIa5Uao8CyoTSLoQRagYl0j4hyrYzkeb6qNThJDJROYTRJUdjlxChJjYYmSGYUOeZNa6VHRGTSRP7oE//ip25cvbBXkRIRIf9zDUogTNPbd1354M///cXBIAcrwJDCercHv8OvwqAoUFiBE4s0Ma1WZiaMMR2Izro9v8UFWMikjSnnRBcFJ2mi2rlzYlmQFwW1Uj3Yv625cWBXu3fXXDqxva2omWgokgnrOLWukMJyyxaUuEAgABoAEv97OpRkaapEhIwxVI6BCVsUlzu+lu8z+x0hYFKkP/xjuP6FT8NtrQKiwUQiECbSIipUxSsCoElEExSRt38qOJAa0BoCR2+yl2WrPXHD3NXsX9yeFHAm8YlpawUOLOwEtoByrDSgSISM8i55mqRQOgElBjpJ/M+PArCzO6Dv+YGLg153HbbYIFJbSql1EdkI/woRLRNRzszLSZKAmdeIKCeiwlq7ZowBRNazLCtERJh507nENWaa2Oj1ur1rucW0w+o59I8cOSAHAff2uoxOAWhGFQNbcZq/lRnnnN8dorjNPp6vZH/ZlNDOBR+CJ6VyZwkHwKSEk49/8jf//qvddXakcgtpmK9KK/QGbnT3CpcaklvbL3RC/A9q3wdkDawmq6sAVldBRM0kSZJ+vw8AjVar1ej1elpEWtbalJmNtXYaQIOIOnmea631LDNnRDQlIm1Gr22mt29L3vne+/jc09vgxKQQQj7QylrA+t9fcbaAtQzn/P8dkRDYUdIEtCYxiVIqoTk9yOcm9AWzJ8tfUE3l7FbT8SBXiQhlxmjdSEFqGpwYDJzbUu3Oqm5NLOv25LJO0vOq1bqhG+mLjentW3pqelk3Gtcbd9y1MnPffc8ppbqjtXZv0MEANl7ZeM+PhPpP09GjR3HtgVMj7x/BEQAfPflRc+DI37HP/MbPPn/t6tXR5bIgAFNzc89/5L/6uDl58qPmyJG/YwHg5F/UkpMn8diOwyJLp4aulruFSuuUP41w6zPME7Ag1YpBInmUUJ47+p3V16uDRWQSwPaNc89mxfL16fUr16bd8o3p/srNXRj0dmlrD8rmxk63tbkzZbtXDfKWtrkR61CIYKAMJEnd1ESycefhvWv09OMn3r71xcf/HMvXYEFwpC6lWfPJxkznVDa963Rz7+7nm3cc/Oa2e+5ZNhPtnusPUP5wybdoKAGgpaUlmpubqwb1yJEjKNcDHDlyBCdPnizfl5cjo+PHj+P48eOvlKRuAUbtVH5bv/RjANg9e/YcvXz58iIz24gBLRGZnTt3/u0rV658rDz3dRrwoQlBRC/XD/QtJj1F/QgAWFpaoqNHj5bjQeX4lGNTjlM5PsePH5dX9LMM2kBsoQHsXv7a1+5cf/HZe/vXrx7eunnzPyry/C2dRjqz3mife/i//m/vJhFpfO5Xf+WnJ9vtdM/b33Z27sF3fo2U3oDc/j7zgDryyCMKRzw7VMDyv7boI1Yv30l/lQ8NwN13331vPXv27JettXG5Dhtj1MGDB9/z7LPPPl6ei+/BQ0QIx48TjgNLS4fpKICTp0qrcRLXFx6TU4AsALcCSGmIszue/+NPvefG1aub7/zbH/rjlwXZiflHzIn5eSOLi3p+fl6NzsTvw4MA4H3ve9+ONE03okQDA5A0Tfvvec979sUL/r+fDxGQzM+rxcVFfWJ+3pyYnzfzL9cv5QmLi4t6DLRvyQCq0WicCQB04U+azeaLTz31VDriV4yP2zCoLC7qxVewfe/4uPVQSim02+0/DgC04U9ardbnfNxzzH6vqkPHXfDq+ktEkCTJN4eKhgGkaXo2OAHjPh0D8DtqQkBEZ+KCzfBTrs/8JYWexgD8fsIfALRarbPB3FIJwDRNnx13zxiAbwgAp6enzymlysyLDrrwhXAOj7tpDMDvKAAfeuihS0R0MzAgKaXW77rrrovxOeNjfHynDhIRmpiY+GrphDSbzaf9nnfj8MuYAd+APlNKiVLqufINY8w5rTWPATgG4BvFgHEoBsaYZ5l53J+v4TDjLnhtR5Ikz5ahmDRNvznukTEA31BHpNVqnS0B2Gw2vzl2QMYm+A0F4Ozs7ItKqVwpxZOTky+MATgG4BsKwF/+5V++QkTLSqmNn/zJn7wwBuBrFNTjLnhtE1drzWmaflVEWkVR3OucozEAxxrwDQMgM7NS6kURmQgesMbrVAU9BuD4+NZ2WARpmj7PzM1utzvukDEA3/ij0+mccc411tbWxp0xBuAb74h0Op1TAJKLFy+OHZDXePz/fVrJ6d5Ii0sAAAAASUVORK5CYII=" },
  { id: "v8", label: "Türkis/Orange", dataUrl: "data:image/png;base64,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" },
  { id: "v9", label: "Rot/Weiss/Blau", dataUrl: "data:image/png;base64,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" },
];
const DEFAULT_GLIDER_VARIANT = "v1";


function WorldMapView({ flights, selectedIds, onBack }) {
  const mapDivRef = useRef(null);
  const mapRef = useRef(null);
  const [showSP, setShowSP] = useState(true);
  const [showLP, setShowLP] = useState(true);
  const [search, setSearch] = useState("");

  const relevantFlights = (selectedIds && selectedIds.size > 0)
    ? flights.filter(f => selectedIds.has(f.id))
    : flights;

  const points = useMemo(() => {
    // Same advanced syntax as the main Flugliste search (feld:wert,
    // feld=wert, feld>wert, +wort/-wort, UND/ODER) — matchFlights is the
    // exact function that search uses, reused here instead of a separate,
    // more limited implementation.
    const searched = search.trim() ? matchFlights(relevantFlights, search) : relevantFlights;
    const seen = new Map();
    for (const f of searched) {
      if (showSP && f.startPt && f.startPt.lat != null) {
        const name = f.site || "";
        const key = `SP:${f.startPt.lat.toFixed(3)},${f.startPt.lon.toFixed(3)}`;
        if (!seen.has(key)) seen.set(key, { lat: f.startPt.lat, lon: f.startPt.lon, type: "SP", name });
      }
      if (showLP && f.endPt && f.endPt.lat != null) {
        const name = f.customFields?.landung || "";
        const key = `LP:${f.endPt.lat.toFixed(3)},${f.endPt.lon.toFixed(3)}`;
        if (!seen.has(key)) seen.set(key, { lat: f.endPt.lat, lon: f.endPt.lon, type: "LP", name });
      }
    }
    return [...seen.values()];
  }, [relevantFlights, showSP, showLP, search]);

  // MapTiler SDK map, same approach as meintauchbuch's MiniMap: OUTDOOR
  // style (terrain/relief/hillshading — unlike Leaflet+OpenTopoMap, this
  // is a more reliable CDN with German-language labels built in) with a
  // German locale. Rebuilt whenever the filtered point set actually
  // changes (compared via a stable JSON key), same as Tauchbuch does.
  const pointsKey = JSON.stringify(points);
  useEffect(() => {
    if (!mapDivRef.current || !window.maptilersdk || !points.length) return;
    const sdk = window.maptilersdk;

    const initMap = () => {
      if (mapRef.current) { mapRef.current.remove(); mapRef.current = null; }
      const map = new sdk.Map({
        container: mapDivRef.current,
        apiKey: MAPTILER_API_KEY,
        style: sdk.MapStyle.OUTDOOR,
        language: "de",
        center: [points[0].lon, points[0].lat],
        zoom: 8,
      });
      mapRef.current = map;

      // Recovers automatically from "WebGL context was lost" (a platform-
      // level thing, especially on iOS Safari under memory pressure or
      // after long backgrounding) by rebuilding this same map right away.
      const canvas = map.getCanvas && map.getCanvas();
      if (canvas) {
        canvas.addEventListener("webglcontextlost", (e) => {
          e.preventDefault();
          if (mapRef.current === map) initMap();
        }, { once: true });
      }

      points.forEach(p => {
        const el = document.createElement("div");
        el.style.cssText = `width:16px;height:16px;border-radius:50%;background:${p.type==="SP"?"#4ade80":"#f87171"};border:2px solid rgba(255,255,255,0.85);box-shadow:0 1px 4px rgba(0,0,0,0.5);`;
        const marker = new sdk.Marker({ element: el }).setLngLat([p.lon, p.lat]);
        marker.setPopup(new sdk.Popup({ offset: 14 }).setText(p.name || (p.type === "SP" ? "Startplatz" : "Landeplatz")));
        marker.addTo(map);
      });

      if (points.length > 1) {
        const lons = points.map(p => p.lon), lats = points.map(p => p.lat);
        map.fitBounds([[Math.min(...lons), Math.min(...lats)], [Math.max(...lons), Math.max(...lats)]], { padding: 40 });
      }
    };
    initMap();
    return () => { if (mapRef.current) { mapRef.current.remove(); mapRef.current = null; } };
  }, [pointsKey]);

  return (
    <div style={{minHeight:"100vh",background:"#040e20",color:"#e8f4fd",fontFamily:"-apple-system,BlinkMacSystemFont,sans-serif",paddingBottom:24}}>
      <div style={{display:"flex",alignItems:"center",gap:10,padding:"calc(20px + env(safe-area-inset-top, 0px)) 16px 14px",borderBottom:"1px solid rgba(100,180,255,0.1)",marginBottom:12}}>
        <button onClick={()=>{window.location.href="index.html";}} title="Zur Startseite"
          style={{background:"rgba(255,255,255,0.06)",border:"1px solid rgba(255,255,255,0.1)",borderRadius:10,width:32,height:32,display:"flex",alignItems:"center",justifyContent:"center",fontSize:15,color:"rgba(232,244,253,0.8)",cursor:"pointer",flexShrink:0}}>
          🏠
        </button>
        <button onClick={onBack} style={{background:"none",border:"none",color:"#7dd3fc",fontSize:22,cursor:"pointer",padding:0}}>‹</button>
        <div>
          <div style={{fontSize:11,fontWeight:600,color:"#7dd3fc",letterSpacing:1.5,textTransform:"uppercase"}}>Weltkarte</div>
          <div style={{fontSize:10,color:"rgba(232,244,253,0.35)",marginTop:1}}>
            {selectedIds && selectedIds.size>0 ? `${selectedIds.size} ausgewählte Flüge` : `Alle ${flights.length} Flüge`} · {points.length} Orte
          </div>
        </div>
      </div>

      <div style={{padding:"0 16px 10px",display:"flex",gap:8,alignItems:"center",flexWrap:"nowrap",overflowX:"auto"}}>
        <button onClick={()=>setShowSP(s=>!s)}
          style={{background:showSP?"rgba(74,222,128,0.18)":"rgba(255,255,255,0.05)",border:`1px solid ${showSP?"rgba(74,222,128,0.4)":"rgba(255,255,255,0.1)"}`,borderRadius:20,padding:"7px 14px",color:showSP?"#4ade80":"rgba(232,244,253,0.5)",fontSize:13,fontWeight:700,cursor:"pointer"}}>
          🛫 Startplätze
        </button>
        <button onClick={()=>setShowLP(s=>!s)}
          style={{background:showLP?"rgba(248,113,113,0.18)":"rgba(255,255,255,0.05)",border:`1px solid ${showLP?"rgba(248,113,113,0.4)":"rgba(255,255,255,0.1)"}`,borderRadius:20,padding:"7px 14px",color:showLP?"#f87171":"rgba(232,244,253,0.5)",fontSize:13,fontWeight:700,cursor:"pointer"}}>
          🛬 Landeplätze
        </button>
      </div>
      <div style={{padding:"0 16px 12px"}}>
        <SearchBar filterText={search} setFilterText={setSearch} />
      </div>

      <div style={{margin:"0 16px",position:"relative",borderRadius:14,overflow:"hidden",border:"1px solid rgba(100,180,255,0.12)"}}>
        <div ref={mapDivRef} style={{width:"100%",height:"60vh",background:"#040e20"}} />
        {points.length === 0 && (
          <div style={{position:"absolute",inset:0,display:"flex",alignItems:"center",justifyContent:"center",background:"rgba(4,14,32,0.85)",color:"rgba(232,244,253,0.5)",fontSize:14,pointerEvents:"none"}}>
            Keine Orte gefunden.
          </div>
        )}
      </div>
    </div>
  );
}


function FlightMap({ flight, highlightRange, onPlaybackPositionChange, onPlaybackActiveChange }) {
  const previewDivRef = useRef(null);
  const previewMapRef = useRef(null);
  const previewRefMarkerRef = useRef(null);
  const previewReadyRef = useRef(false);
  const fullDivRef = useRef(null);
  const fullMapRef = useRef(null);
  const fullRefMarkerRef = useRef(null);
  const fullReadyRef = useRef(false);
  const [isFullscreen, setIsFullscreen] = useState(false);
  // Which glider marker image to use — chosen in Settings > Schirme,
  // shared across the whole app via storage. Re-read on focus so a change
  // made in Settings (a different page) takes effect without needing a
  // full reload of this one.
  const [gliderIconUrl, setGliderIconUrl] = useState(() => GLIDER_VARIANTS[0].dataUrl);
  useEffect(() => {
    let cancelled = false;
    const load = async () => {
      try {
        const r = await window.storage.get("gliderVariant");
        const id = r ? r.value : DEFAULT_GLIDER_VARIANT;
        const found = GLIDER_VARIANTS.find(v => v.id === id) || GLIDER_VARIANTS[0];
        if (!cancelled) setGliderIconUrl(found.dataUrl);
      } catch (e) { console.error("Load error (gliderVariant):", e); }
    };
    load();
    window.addEventListener("focus", load);
    return () => { cancelled = true; window.removeEventListener("focus", load); };
  }, []);
  const [isPlaying, setIsPlaying] = useState(false);
  useEffect(() => { if (onPlaybackActiveChange) onPlaybackActiveChange(isPlaying); }, [isPlaying]);
  const [playSpeed, setPlaySpeed] = useState(10);
  const [playPickerOpen, setPlayPickerOpen] = useState(false);
  const [playElapsedSec, setPlayElapsedSec] = useState(0); // seconds into the flight (IGC time)
  const playMarkerRef = useRef(null);
  const previewPlayMarkerRef = useRef(null);
  const playRafRef = useRef(null);
  const playLastTsRef = useRef(null);
  const [gpsvColorBy, setGpsvColorBy] = useState("altitude"); // "altitude" | "climb"

  const track = flight?.track || [];
  const sP = flight?.startPt, eP = flight?.endPt;
  const hasMap = track.length > 0 || (sP && eP);

  // Same GPS-glitch rejection as before: a single wild fix shouldn't blow
  // out the bounding box used for fitBounds.
  const cleanTrack = useMemo(() => {
    if (track.length < 3) return track;
    const median = arr => { const s=[...arr].sort((a,b)=>a-b); const m=Math.floor(s.length/2); return s.length%2?s[m]:(s[m-1]+s[m])/2; };
    const medLat = median(track.map(p=>p.lat)), medLon = median(track.map(p=>p.lon));
    const filtered = track.filter(p => Math.abs(p.lat-medLat)<=0.5 && Math.abs(p.lon-medLon)<=0.5);
    return filtered.length ? filtered : track;
  }, [track]);

  // Cumulative flown distance up to each track point (same basis
  // FlightProfile's own "distances" array uses) — lets playback report its
  // current position in a form the profile's cine-sync marker can use
  // directly, without either component needing to know how the other one
  // is internally structured.
  const cumDist = useMemo(() => {
    const arr = new Array(track.length).fill(0);
    for (let i=1;i<track.length;i++) arr[i] = arr[i-1] + (haversineDistKm(track[i-1], track[i]) || 0);
    return arr;
  }, [track]);

  // The segment highlightRange refers to (by cumulative flown distance
  // along the *raw* track, same basis FlightProfile itself uses), plus the
  // single nearest point to use for the red reference marker.
  const { segment, refPoint, heading } = useMemo(() => {
    if (!highlightRange || track.length < 2) return { segment: null, refPoint: null, heading: 0 };
    let acc = 0;
    const seg = [];
    if (acc >= highlightRange.start-0.05 && acc <= highlightRange.end+0.05) seg.push(track[0]);
    let bestIdx = 0, bestDiff = Math.abs(0 - highlightRange.center);
    for (let i=1;i<track.length;i++) {
      acc += haversineDistKm(track[i-1], track[i]) || 0;
      if (acc >= highlightRange.start-0.05 && acc <= highlightRange.end+0.05) seg.push(track[i]);
      const diff = Math.abs(acc - highlightRange.center);
      if (diff < bestDiff) { bestDiff = diff; bestIdx = i; }
    }
    // Heading at this point: averaged over a short span around it (rather
    // than just the single adjacent step) so brief GPS jitter doesn't make
    // the marker's rotation flicker/jump as the person drags the profile.
    const spanBack = track[Math.max(0, bestIdx-3)];
    const spanFwd = track[Math.min(track.length-1, bestIdx+3)];
    const heading = bearingDeg(spanBack, spanFwd);
    return { segment: seg.length > 1 ? seg : null, refPoint: track[bestIdx], heading };
  }, [track, highlightRange]);

  // Creates ONE MapTiler map instance (and its one WebGL context) per
  // flight: track line (white casing + blue line) and S/L markers, added
  // once the style finishes loading. Deliberately does NOT depend on
  // highlightRange — recreating the whole map (and its GL context) on
  // every profile pan/zoom tick was exactly what caused the "WebGL context
  // was lost" errors, since browsers cap how many live contexts can exist
  // at once. Camera position and the reference marker are instead updated
  // in place by the separate effect below.
  const buildMap = (container, mapRefObj, readyRef) => {
    if (!container || !window.maptilersdk || !hasMap) return;
    const sdk = window.maptilersdk;
    if (mapRefObj.current) { mapRefObj.current.remove(); mapRefObj.current = null; }
    readyRef.current = false;
    const initialCenter = track.length ? [track[0].lon, track[0].lat] : [sP.lon, sP.lat];
    const map = new sdk.Map({
      container, apiKey: MAPTILER_API_KEY, style: sdk.MapStyle.OUTDOOR,
      language: "de", center: initialCenter, zoom: 11,
    });
    mapRefObj.current = map;

    // "The WebGL context was lost" is a platform-level thing (iOS Safari in
    // particular reclaims GPU contexts aggressively under memory pressure or
    // after the tab's been backgrounded a while) — not something that can be
    // fully prevented, only recovered from. The underlying canvas fires a
    // real browser event for it, so rebuilding this same map right away
    // (rather than leaving it visibly broken) is straightforward.
    const canvas = map.getCanvas && map.getCanvas();
    if (canvas) {
      canvas.addEventListener("webglcontextlost", (e) => {
        e.preventDefault();
        if (mapRefObj.current === map) buildMap(container, mapRefObj, readyRef);
      }, { once: true });
    }

    const addMarker = (pt, color, label) => {
      const el = document.createElement("div");
      el.style.cssText = `width:22px;height:22px;border-radius:50%;background:${color};border:2px solid #fff;box-shadow:0 1px 5px rgba(0,0,0,0.6);display:flex;align-items:center;justify-content:center;color:#fff;font:800 10px system-ui;`;
      el.textContent = label;
      new sdk.Marker({ element: el }).setLngLat([pt.lon, pt.lat]).addTo(map);
    };

    map.on("load", () => {
      const fullTrace = cleanTrack.length ? cleanTrack : track;
      if (fullTrace.length > 1) {
        map.addSource("track", {
          type: "geojson",
          data: { type: "Feature", geometry: { type: "LineString", coordinates: fullTrace.map(p=>[p.lon,p.lat]) } },
        });
        map.addLayer({ id: "track-casing", type: "line", source: "track",
          layout: { "line-join": "round", "line-cap": "round" },
          paint: { "line-color": "rgba(255,255,255,0.55)", "line-width": 6.5 } });
        map.addLayer({ id: "track-line", type: "line", source: "track",
          layout: { "line-join": "round", "line-cap": "round" },
          paint: { "line-color": "#1e40af", "line-width": 3.5 } });
      }
      if (track.length) {
        addMarker(track[0], "#22c55e", "S");
        addMarker(track[track.length-1], "#ef4444", "L");
      } else if (sP && eP) {
        addMarker(sP, "#22c55e", "S");
        addMarker(eP, "#ef4444", "L");
      }
      readyRef.current = true;
      applyHighlight(map, mapRefObj===previewMapRef ? previewRefMarkerRef : fullRefMarkerRef);
    });
  };

  // Lightweight in-place update for a profile pan/zoom change: moves the
  // camera (fitBounds, no new context) and the single reference marker,
  // and swaps the track source's data between the full track and just the
  // zoomed-in segment. Safe to call repeatedly — does nothing until the
  // map's initial "load" has actually finished.
  const applyHighlight = (map, refMarkerRefObj) => {
    if (!map) return;
    const sdk = window.maptilersdk;
    // Line always shows the whole track — only the camera zooms into the
    // profile's segment (via fitBounds below), so nothing here needs to
    // touch the "track" source at all once it's been set on load.
    if (refMarkerRefObj.current) { refMarkerRefObj.current.remove(); refMarkerRefObj.current = null; }
    // Skip the static reference marker entirely while cine playback is
    // running — the moving playback marker already shows the glider, and
    // showing both at once looked like two overlapping icons.
    if (refPoint && !isPlaying) {
      const el = document.createElement("div");
      el.style.cssText = `width:34px;height:34px;display:flex;align-items:center;justify-content:center;filter:drop-shadow(0 1px 4px rgba(0,0,0,0.7));`;
      const img = document.createElement("img");
      img.src = gliderIconUrl;
      img.style.cssText = `width:100%;height:100%;object-fit:contain;transform:rotate(${heading}deg);transition:transform 0.15s ease-out;`;
      el.appendChild(img);
      // MapTiler markers rotate/pitch with the map by default, which would
      // fight with our own heading rotation on the inner <img> — pin this
      // one to the screen instead so only the flight-direction rotation
      // ever applies to it.
      refMarkerRefObj.current = new sdk.Marker({ element: el, rotationAlignment: "viewport", pitchAlignment: "viewport" })
        .setLngLat([refPoint.lon, refPoint.lat]).addTo(map);
    }
    const fitToPoints = (pts) => {
      if (!pts.length) return;
      const lons = pts.map(p=>p.lon), lats = pts.map(p=>p.lat);
      if (pts.length === 1) { map.jumpTo({ center: [lons[0], lats[0]], zoom: 12 }); return; }
      map.fitBounds([[Math.min(...lons), Math.min(...lats)], [Math.max(...lons), Math.max(...lats)]], { padding: 36, animate: false });
    };
    if (segment && segment.length > 1) fitToPoints(segment);
    else if (track.length) fitToPoints(cleanTrack.length ? cleanTrack : track);
    else if (sP && eP) fitToPoints([sP, eP]);
  };

  useEffect(() => {
    buildMap(previewDivRef.current, previewMapRef, previewReadyRef);
    return () => { if (previewMapRef.current) { previewMapRef.current.remove(); previewMapRef.current = null; } };
  }, [flight?.id, gliderIconUrl]);

  useEffect(() => {
    if (!isFullscreen) return;
    // A frame's delay so the fullscreen overlay's container has its real
    // layout size before MapTiler reads it.
    const raf = requestAnimationFrame(() => buildMap(fullDivRef.current, fullMapRef, fullReadyRef));
    return () => {
      cancelAnimationFrame(raf);
      if (fullMapRef.current) { fullMapRef.current.remove(); fullMapRef.current = null; }
    };
  }, [isFullscreen, flight?.id, gliderIconUrl]);

  // Profile pan/zoom changes land here — updates the already-live map(s) in
  // place (camera + reference marker + track segment) instead of rebuilding
  // them, which is what previously exhausted the browser's WebGL context
  // budget during a drag gesture.
  useEffect(() => {
    if (previewReadyRef.current) applyHighlight(previewMapRef.current, previewRefMarkerRef);
    if (isFullscreen && fullReadyRef.current) applyHighlight(fullMapRef.current, fullRefMarkerRef);
  }, [highlightRange?.start, highlightRange?.end, isFullscreen, isPlaying]);

  // Cine playback: moves a dedicated glider marker along the track over
  // time, at playSpeed× real flight time. Works on the preview map too now
  // (not just fullscreen) — showing the map and the height profile at the
  // same time was the whole point, and fullscreen hides the profile.
  // Driven by requestAnimationFrame rather than setInterval so the speed
  // stays smooth and accurate regardless of frame rate hiccups.
  useEffect(() => {
    if (!isPlaying || track.length < 2) return;
    playLastTsRef.current = null;
    const totalSec = track[track.length-1].timeSec - track[0].timeSec;
    const step = (ts) => {
      if (playLastTsRef.current == null) playLastTsRef.current = ts;
      const dtReal = (ts - playLastTsRef.current) / 1000;
      playLastTsRef.current = ts;
      setPlayElapsedSec(prev => {
        const next = prev + dtReal * playSpeed;
        if (next >= totalSec) { setIsPlaying(false); return totalSec; }
        return next;
      });
      playRafRef.current = requestAnimationFrame(step);
    };
    playRafRef.current = requestAnimationFrame(step);
    return () => { if (playRafRef.current) cancelAnimationFrame(playRafRef.current); };
  }, [isPlaying, playSpeed, track.length]);

  // Moves the playback marker to match playElapsedSec whenever it changes
  // (during playback, or when scrubbing manually) — interpolates between
  // the two surrounding track points for smooth sub-sample positioning.
  // Updates the preview map and, if open, the fullscreen map — the person
  // specifically wants to watch the map and the height profile together,
  // which only the (non-fullscreen) preview allows.
  useEffect(() => {
    if (track.length < 2 || !window.maptilersdk) return;
    const sdk = window.maptilersdk;
    const targetTime = track[0].timeSec + playElapsedSec;
    let i = 0;
    while (i < track.length-2 && track[i+1].timeSec < targetTime) i++;
    const a = track[i], b = track[i+1] || a;
    const span = (b.timeSec - a.timeSec) || 1;
    const frac = Math.max(0, Math.min(1, (targetTime - a.timeSec) / span));
    const lat = a.lat + (b.lat-a.lat)*frac, lon = a.lon + (b.lon-a.lon)*frac;
    const alt = a.gpsAlt + ((b.gpsAlt||a.gpsAlt) - a.gpsAlt)*frac;
    const spanBack = track[Math.max(0,i-3)], spanFwd = track[Math.min(track.length-1,i+3)];
    const hdg = bearingDeg(spanBack, spanFwd);

    const placeOn = (map, ref, showAlt) => {
      if (!map) return;
      if (!ref.current) {
        const el = document.createElement("div");
        el.style.cssText = `position:relative;width:34px;height:34px;filter:drop-shadow(0 1px 4px rgba(0,0,0,0.7));`;
        const img = document.createElement("img");
        img.src = gliderIconUrl;
        img.style.cssText = `width:100%;height:100%;object-fit:contain;`;
        el.appendChild(img);
        if (showAlt) {
          const altEl = document.createElement("span");
          altEl.style.cssText = `position:absolute;left:calc(100% + 4px);top:50%;transform:translateY(-50%);color:#dc2626;font:800 13px -apple-system,sans-serif;white-space:nowrap;`;
          el.appendChild(altEl);
          ref._altEl = altEl;
        }
        const marker = new sdk.Marker({ element: el, rotationAlignment: "viewport", pitchAlignment: "viewport" }).setLngLat([lon, lat]).addTo(map);
        ref.current = marker;
        ref.current._imgEl = img;
        ref.current._altEl = ref._altEl;
      } else {
        ref.current.setLngLat([lon, lat]);
      }
      if (ref.current._imgEl) ref.current._imgEl.style.transform = `rotate(${hdg}deg)`;
      if (ref.current._altEl) ref.current._altEl.textContent = Math.round(alt)+"m";
      // Follow while zoomed to a segment: once the glider leaves the
      // currently visible area, jump (same zoom level, so same-size view —
      // not a smooth pan) to a fresh view recentred on it.
      if (highlightRange && isPlaying && map.getBounds && !map.getBounds().contains([lon, lat])) {
        map.jumpTo({ center: [lon, lat], zoom: map.getZoom() });
      }
    };
    if (previewReadyRef.current) placeOn(previewMapRef.current, previewPlayMarkerRef, false);
    if (isFullscreen && fullReadyRef.current) placeOn(fullMapRef.current, playMarkerRef, true);

    if (onPlaybackPositionChange && cumDist.length) {
      const distKm = (cumDist[i]||0) + ((cumDist[i+1]||cumDist[i]||0) - (cumDist[i]||0)) * frac;
      onPlaybackPositionChange(distKm);
    }
  }, [playElapsedSec, isFullscreen]);

  // Cleans up the fullscreen-specific playback marker whenever fullscreen
  // closes (playback itself keeps going — it's shared with the preview
  // now, not fullscreen-only), and resets everything when the flight
  // changes so a stale marker never lingers into the next map instance.
  useEffect(() => {
    if (!isFullscreen && playMarkerRef.current) { playMarkerRef.current.remove(); playMarkerRef.current = null; }
  }, [isFullscreen]);
  useEffect(() => {
    setIsPlaying(false);
    setPlayElapsedSec(0);
    if (playMarkerRef.current) { playMarkerRef.current.remove(); playMarkerRef.current = null; }
    if (previewPlayMarkerRef.current) { previewPlayMarkerRef.current.remove(); previewPlayMarkerRef.current = null; }
    if (onPlaybackPositionChange) onPlaybackPositionChange(null);
  }, [flight?.id]);

  // Opens the track in GPS Visualizer as an alternative map view — POSTs the
  // data directly (no file hosting needed, per gpsvisualizer.com/misc/
  // post_example.html), so it works straight from whatever's already in
  // IndexedDB. CSV rather than GPX since GPS Visualizer's own docs recommend
  // it for on-the-fly data ("easiest to deal with"), and the track is
  // thinned to a sane point count first — thousands of raw 1-second fixes
  // don't add visible detail a few hundred evenly-spaced points wouldn't,
  // and GPS Visualizer's own docs warn that very long tracklogs (especially
  // with colorization on) can make the browser struggle.
  const openInGpsVisualizer = (e) => {
    e.stopPropagation();
    if (!track.length) return;
    const maxPoints = 1500;
    const step = Math.max(1, Math.ceil(track.length / maxPoints));
    const rows = ["type,latitude,longitude,altitude,time"];
    for (let i = 0; i < track.length; i += step) {
      const p = track[i];
      const iso = new Date(p.timeSec*1000).toISOString();
      rows.push(`T,${p.lat},${p.lon},${p.gpsAlt},${iso}`);
    }
    const csv = rows.join("\n");
    const form = document.createElement("form");
    form.action = "https://www.gpsvisualizer.com/map";
    form.method = "POST";
    form.target = "_blank";
    const fields = {
      format: "leaflet",
      trk_colorize: gpsvColorBy,
      units: "metric",
      filename: `${flight?.name || "flug"}.csv`,
      data: csv,
    };
    for (const [name, value] of Object.entries(fields)) {
      const input = document.createElement("input");
      input.type = "hidden";
      input.name = name;
      input.value = value;
      form.appendChild(input);
    }
    document.body.appendChild(form);
    form.submit();
    document.body.removeChild(form);
  };

  return (
    <>
      <div style={{position:"relative"}} onClick={()=>{ if (hasMap) setIsFullscreen(true); }}>
        <div ref={previewDivRef} style={{width:"100%",aspectRatio:"3/2",background:"#040e20",borderRadius:10,overflow:"hidden",cursor:hasMap?"pointer":"default"}} />
      </div>
      {hasMap && flight?.track?.length > 1 && (
        <div style={{marginTop:8,display:"flex",gap:8,alignItems:"center"}} onClick={e=>e.stopPropagation()}>
          <button onClick={()=>setIsPlaying(p=>!p)}
            title={isPlaying?"Pause":"Abspielen"}
            style={{background:isPlaying?"#dc2626":"#16a34a",border:"none",borderRadius:20,width:38,height:38,color:"#fff",fontSize:16,cursor:"pointer",display:"flex",alignItems:"center",justifyContent:"center",boxShadow:"0 2px 8px rgba(0,0,0,0.4)",flexShrink:0}}>
            {isPlaying ? "⏸" : "▶"}
          </button>
          <div style={{position:"relative"}}>
            <button onClick={()=>setPlayPickerOpen(o=>!o)}
              style={{background:"#1e40af",border:"none",borderRadius:20,padding:"9px 14px",color:"#fff",fontSize:13,fontWeight:800,cursor:"pointer",boxShadow:"0 2px 8px rgba(0,0,0,0.4)"}}>
              {playSpeed}× ▾
            </button>
            {playPickerOpen && (
              <div onClick={e=>{e.stopPropagation();setPlayPickerOpen(false);}}
                style={{position:"absolute",top:"calc(100% + 4px)",left:0,background:"#14253a",border:"1px solid rgba(255,255,255,0.15)",borderRadius:10,padding:4,boxShadow:"0 8px 24px rgba(0,0,0,0.5)",display:"flex",flexDirection:"column",gap:2,minWidth:64,zIndex:10}}>
                {[1,2,5,10,20,50,100].map(sp=>(
                  <button key={sp} onClick={()=>{setPlaySpeed(sp);setPlayPickerOpen(false);}}
                    style={{background:sp===playSpeed?"rgba(125,211,252,0.2)":"transparent",border:"none",borderRadius:6,padding:"6px 10px",color:sp===playSpeed?"#7dd3fc":"#e8f4fd",fontSize:13,fontWeight:sp===playSpeed?700:400,cursor:"pointer",textAlign:"left"}}>
                    {sp}×
                  </button>
                ))}
              </div>
            )}
          </div>
          {playElapsedSec > 0 && (
            <button onClick={()=>{setIsPlaying(false);setPlayElapsedSec(0);}}
              title="Zurück zum Start"
              style={{background:"rgba(255,255,255,0.15)",border:"1px solid rgba(255,255,255,0.3)",borderRadius:20,width:38,height:38,color:"#fff",fontSize:15,cursor:"pointer",boxShadow:"0 2px 8px rgba(0,0,0,0.4)"}}>
              ↺
            </button>
          )}
        </div>
      )}
      {hasMap && flight?.track?.length > 0 && (
        <div style={{marginTop:6,display:"flex",gap:6,alignItems:"center"}}>
          <button onClick={openInGpsVisualizer}
            style={{background:"rgba(255,255,255,0.05)",border:"1px solid rgba(255,255,255,0.1)",borderRadius:8,padding:"6px 10px",color:"rgba(232,244,253,0.6)",fontSize:11,cursor:"pointer"}}>
            🗺️ In GPS Visualizer öffnen
          </button>
          <div style={{display:"flex",background:"rgba(255,255,255,0.05)",borderRadius:8,padding:2}}>
            <button onClick={()=>setGpsvColorBy("altitude")}
              style={{background:gpsvColorBy==="altitude"?"rgba(125,211,252,0.25)":"transparent",border:"none",borderRadius:6,padding:"5px 8px",color:gpsvColorBy==="altitude"?"#7dd3fc":"rgba(232,244,253,0.5)",fontSize:10,fontWeight:700,cursor:"pointer"}}>
              Höhe
            </button>
            <button onClick={()=>setGpsvColorBy("climb")}
              style={{background:gpsvColorBy==="climb"?"rgba(125,211,252,0.25)":"transparent",border:"none",borderRadius:6,padding:"5px 8px",color:gpsvColorBy==="climb"?"#7dd3fc":"rgba(232,244,253,0.5)",fontSize:10,fontWeight:700,cursor:"pointer"}}>
              Steigen/Sinken
            </button>
          </div>
        </div>
      )}
      {isFullscreen && (
        <div
          style={{position:"fixed",inset:0,background:"#000",zIndex:200,display:"flex",flexDirection:"column",alignItems:"center",justifyContent:"center",overflow:"hidden"}}
        >
          <div ref={fullDivRef} style={{width:"100%",height:"70vh"}} />
          {flight?.track?.length > 1 && (
            <div style={{position:"absolute",bottom:"calc(15vh + 10px)",right:14,display:"flex",gap:6,alignItems:"center"}}>
              <button onClick={()=>setIsPlaying(p=>!p)}
                title={isPlaying?"Pause":"Abspielen"}
                style={{background:isPlaying?"#dc2626":"#16a34a",border:"none",borderRadius:20,width:40,height:40,color:"#fff",fontSize:17,cursor:"pointer",display:"flex",alignItems:"center",justifyContent:"center",boxShadow:"0 2px 10px rgba(0,0,0,0.5)"}}>
                {isPlaying ? "⏸" : "▶"}
              </button>
              <div style={{position:"relative"}}>
                <button onClick={()=>setPlayPickerOpen(o=>!o)}
                  style={{background:"#1e40af",border:"none",borderRadius:20,padding:"9px 14px",color:"#fff",fontSize:13,fontWeight:800,cursor:"pointer",boxShadow:"0 2px 10px rgba(0,0,0,0.5)"}}>
                  {playSpeed}× ▾
                </button>
                {playPickerOpen && (
                  <div onClick={()=>setPlayPickerOpen(false)}
                    style={{position:"absolute",bottom:"calc(100% + 4px)",right:0,background:"#14253a",border:"1px solid rgba(255,255,255,0.15)",borderRadius:10,padding:4,boxShadow:"0 8px 24px rgba(0,0,0,0.5)",display:"flex",flexDirection:"column",gap:2,minWidth:64}}>
                    {[1,2,5,10,20,50,100].map(sp=>(
                      <button key={sp} onClick={()=>{setPlaySpeed(sp);setPlayPickerOpen(false);}}
                        style={{background:sp===playSpeed?"rgba(125,211,252,0.2)":"transparent",border:"none",borderRadius:6,padding:"6px 10px",color:sp===playSpeed?"#7dd3fc":"#e8f4fd",fontSize:13,fontWeight:sp===playSpeed?700:400,cursor:"pointer",textAlign:"left"}}>
                        {sp}×
                      </button>
                    ))}
                  </div>
                )}
              </div>
              {playElapsedSec > 0 && (
                <button onClick={()=>{setIsPlaying(false);setPlayElapsedSec(0);}}
                  title="Zurück zum Start"
                  style={{background:"rgba(255,255,255,0.15)",border:"1px solid rgba(255,255,255,0.3)",borderRadius:20,width:40,height:40,color:"#fff",fontSize:15,cursor:"pointer",boxShadow:"0 2px 10px rgba(0,0,0,0.5)"}}>
                  ↺
                </button>
              )}
            </div>
          )}
          {flight?.track?.length > 0 && (
            <button onClick={openInGpsVisualizer}
              style={{position:"absolute",bottom:"calc(15vh + 10px)",left:14,background:"rgba(255,255,255,0.12)",border:"1px solid rgba(255,255,255,0.2)",borderRadius:20,padding:"6px 14px",color:"#fff",fontSize:12,fontWeight:700,cursor:"pointer"}}>
              🗺️ GPS Visualizer
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

// ── FlightProfile ────────────────────────────────────────────────────────
// Altitude-over-distance chart: the flight trace itself (colour-coded by
// altitude, same red→blue scale as the map) plus a brown ground/terrain
// profile drawn underneath it, sourced from Open-Meteo's free Elevation API
// (open-meteo.com/en/docs/elevation-api — no key needed, CORS-enabled,
// worldwide 90m-resolution DEM, explicitly suited to exactly this: getting
// height-above-ground for a track). Only ~80 evenly distance-spaced points
// are sent (one batched request) rather than the whole track, since terrain
// doesn't need 1-second resolution to look right and Open-Meteo caps
// batches at 100 coordinates anyway.
function FlightProfile({ flight, onPositionChange, playbackDistanceKm, isPlaybackActive }) {
  const canvasRef = useRef(null);
  const [groundProfile, setGroundProfile] = useState(null);
  const [groundError, setGroundError] = useState(false);
  // Stepped zoom (1-8) replaces the earlier pinch-gesture zoom, which kept
  // conflicting with the page's own swipe-between-flights gesture no matter
  // how it was tuned. panPos (0-1) is a separate slider for where the
  // zoomed window sits along the flight — 0.5 (default) centres it, 0 pins
  // it to the start, 1 to the end.
  const [zoomLevel, setZoomLevel] = useState(1);
  const [panPos, setPanPos] = useState(0.5);
  const [zoomPickerOpen, setZoomPickerOpen] = useState(false);
  const viewScale = zoomLevel;
  // panPos (0-1) is the window's CENTRE position across the whole flight —
  // 0 puts the centre exactly at the start, 1 exactly at landing. This is
  // deliberately NOT clamped to keep the whole window inside [0,1]: doing
  // that meant the centre (and the map's reference marker, which tracks
  // this same point) could never get closer than half a window-width from
  // either end. Left unclamped, the window can extend past the actual
  // flown distance at one edge when centred near start/landing — nothing
  // draws there since the track has no points beyond [0, totalDist]
  // anyway, so it just reads as empty space rather than an error.
  const viewStart = panPos - (1/viewScale)/2;
  const track = flight?.track || [];

  const rawDistances = useMemo(() => {
    if (!track.length) return [];
    const d = [0];
    for (let i = 1; i < track.length; i++) {
      d.push(d[i-1] + (haversineDistKm(track[i-1], track[i]) || 0));
    }
    return d;
  }, [track]);
  const rawTotalDist = rawDistances[rawDistances.length-1] || 0;
  // The manually-entered Distanz field is the number the person actually
  // trusts (their real XContest score, typed in by hand) — rather than
  // trying to approximate that algorithm in-browser, the whole distance
  // axis is proportionally rescaled so it lands exactly on that value,
  // while keeping the flown path's shape (relative proportions between
  // points) intact. Falls back to the raw flown distance, unscaled, if no
  // manual value has been entered for this flight.
  const manualDist = parseFloat(getDisplayDistance(flight)) || 0;
  const scale = (manualDist > 0 && rawTotalDist > 0) ? manualDist/rawTotalDist : 1;
  const distances = useMemo(() => rawDistances.map(d => d*scale), [rawDistances, scale]);
  const totalDist = distances[distances.length-1] || 0;

  // Cine-playback follow: while zoomed in, once the glider's position
  // (reported by FlightMap, same "raw km" basis distances[] uses) leaves
  // the currently visible window, jump (not smooth-scroll) to a same-size
  // window that starts right at the glider — "gleichgrosser Kartenausschnitt
  // weiterspringend", matching the map's own jump-to-follow behaviour.
  useEffect(() => {
    if (!isPlaybackActive || playbackDistanceKm == null || zoomLevel <= 1 || !totalDist) return;
    const scaledDist = playbackDistanceKm * scale;
    const windowFrac = 1/zoomLevel;
    const curStart = viewStart;
    const curEnd = viewStart + windowFrac;
    const posFrac = scaledDist / totalDist;
    if (posFrac < curStart || posFrac > curEnd) {
      setPanPos(Math.max(0, Math.min(1, posFrac + windowFrac/2)));
    }
  }, [playbackDistanceKm, isPlaybackActive, zoomLevel, totalDist, scale]);

  useEffect(() => { setZoomLevel(1); setPanPos(0.5); }, [flight?.id]);
  useEffect(() => {
    profileZoomActive = zoomLevel > 1;
    return () => { profileZoomActive = false; };
  }, [zoomLevel]);

  // Tells the map above what part of the flight (in the flight's own,
  // unscaled distance units — the manual-Distanz proportional rescale only
  // affects the axis display here, not the underlying track) the current
  // zoomed excerpt covers, so it can zoom to match and drop a marker at its
  // centre. Only while actually zoomed in; at 1× there's no excerpt to
  // match, so the map goes back to showing the whole flight.
  useEffect(() => {
    if (!onPositionChange) return;
    if (zoomLevel <= 1 || !totalDist) { onPositionChange(null); return; }
    const visStart = viewStart * totalDist;
    const visEnd = visStart + totalDist/viewScale;
    const toRaw = d => scale > 0 ? d / scale : d;
    onPositionChange({ start: toRaw(Math.max(0,visStart)), end: toRaw(Math.min(totalDist,visEnd)), center: toRaw((visStart+visEnd)/2) });
  }, [zoomLevel, viewStart, viewScale, totalDist, scale]);

  // Swipe-to-pan directly on the chart, active only while zoomed (>1×) —
  // the page-level swipe-between-flights gesture is already fully disabled
  // during this time via profileZoomActive, so this can freely claim any
  // horizontal drag without the two competing. zoomLevelRef/panPosRef avoid
  // reading stale values from the closure captured when the effect last
  // bound its listeners.
  const zoomLevelRef = useRef(zoomLevel);
  const panPosRef = useRef(panPos);
  useEffect(() => { zoomLevelRef.current = zoomLevel; }, [zoomLevel]);
  useEffect(() => { panPosRef.current = panPos; }, [panPos]);
  const panGestureRef = useRef(null);
  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    const onTouchStart = (e) => {
      if (zoomLevelRef.current <= 1 || e.touches.length !== 1) return;
      e.preventDefault(); e.stopPropagation();
      panGestureRef.current = { startX: e.touches[0].clientX, startPan: panPosRef.current };
    };
    const onTouchMove = (e) => {
      const g = panGestureRef.current;
      if (!g || zoomLevelRef.current <= 1) return;
      e.preventDefault(); e.stopPropagation();
      const dx = e.touches[0].clientX - g.startX;
      // How far a full-width drag should shift panPos (0-1) depends on how
      // zoomed in we are — at higher zoom the same pixel drag should cover
      // proportionally less of the flight, matching what's on screen.
      const fracDelta = -dx / canvas.clientWidth / zoomLevelRef.current * 2;
      setPanPos(Math.min(1, Math.max(0, g.startPan + fracDelta)));
    };
    const onTouchEnd = () => { panGestureRef.current = null; };
    canvas.addEventListener("touchstart", onTouchStart, { passive: false });
    canvas.addEventListener("touchmove", onTouchMove, { passive: false });
    canvas.addEventListener("touchend", onTouchEnd);

    // Mouse equivalent (Mac/desktop: no touch events at all). mousemove/up
    // are attached to window rather than the canvas so a fast drag that
    // briefly leaves the canvas bounds doesn't get stuck.
    const onMouseDown = (e) => {
      if (zoomLevelRef.current <= 1) return;
      e.preventDefault();
      panGestureRef.current = { startX: e.clientX, startPan: panPosRef.current };
    };
    const onMouseMove = (e) => {
      const g = panGestureRef.current;
      if (!g || zoomLevelRef.current <= 1) return;
      e.preventDefault();
      const dx = e.clientX - g.startX;
      const fracDelta = -dx / canvas.clientWidth / zoomLevelRef.current * 2;
      setPanPos(Math.min(1, Math.max(0, g.startPan + fracDelta)));
    };
    const onMouseUp = () => { panGestureRef.current = null; };
    canvas.addEventListener("mousedown", onMouseDown);
    window.addEventListener("mousemove", onMouseMove);
    window.addEventListener("mouseup", onMouseUp);
    canvas.style.cursor = "grab";

    return () => {
      canvas.removeEventListener("touchstart", onTouchStart);
      canvas.removeEventListener("touchmove", onTouchMove);
      canvas.removeEventListener("touchend", onTouchEnd);
      canvas.removeEventListener("mousedown", onMouseDown);
      window.removeEventListener("mousemove", onMouseMove);
      window.removeEventListener("mouseup", onMouseUp);
    };
  }, []);


  useEffect(() => {
    setGroundProfile(null);
    setGroundError(false);
    if (!track.length || totalDist <= 0) return;
    let cancelled = false;
    (async () => {
      try {
        const N = 80;
        const samplePts = [];
        let idx = 0;
        for (let i = 0; i <= N; i++) {
          const targetDist = (totalDist / N) * i;
          while (idx < distances.length-1 && distances[idx] < targetDist) idx++;
          samplePts.push({ pt: track[idx], distKm: distances[idx] });
        }
        const lats = samplePts.map(s=>s.pt.lat.toFixed(5)).join(",");
        const lons = samplePts.map(s=>s.pt.lon.toFixed(5)).join(",");
        const res = await fetch(`https://api.open-meteo.com/v1/elevation?latitude=${lats}&longitude=${lons}`);
        const data = await res.json();
        if (cancelled) return;
        if (Array.isArray(data.elevation)) {
          // Never let the ground appear above the flight trace: a 90m-
          // resolution terrain model can occasionally overshoot near a
          // ridge or narrow valley the aircraft actually cleared, which
          // would otherwise draw as physically flying through the ground.
          setGroundProfile(samplePts.map((s,i) => ({
            distKm: s.distKm,
            elev: data.elevation[i] != null ? Math.min(data.elevation[i], s.pt.gpsAlt - 5) : null,
          })));
        } else {
          setGroundError(true);
        }
      } catch { if (!cancelled) setGroundError(true); }
    })();
    return () => { cancelled = true; };
  }, [flight?.id, totalDist]);

  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas || !track.length) return;
    const dpr = window.devicePixelRatio || 1;
    canvas.width = canvas.clientWidth * dpr;
    canvas.height = canvas.clientHeight * dpr;
    const ctx = canvas.getContext("2d");
    const W = canvas.width, H = canvas.height;
    ctx.clearRect(0,0,W,H);

    const padL = 42*dpr, padR = 8*dpr, padT = 10*dpr, padB = 34*dpr;
    const plotW = Math.max(1, W-padL-padR), plotH = Math.max(1, H-padT-padB);

    const visStart = viewStart * totalDist;
    const visEnd = visStart + totalDist/viewScale;
    // Clamped versions purely for the axis label text — the underlying
    // visStart/visEnd stay unclamped so the window's centre (and scale)
    // stay accurate even when it extends past the real start/landing.
    const visStartLabel = Math.max(0, visStart);
    const visEndLabel = Math.min(totalDist, visEnd);

    // Altitude range comes only from the points actually inside the visible
    // window — zooming into a segment re-scales the legend to that
    // segment's own min/max instead of staying pinned to the whole flight.
    const visibleAlts = [];
    for (let i=0;i<track.length;i++) if (distances[i]>=visStart && distances[i]<=visEnd) visibleAlts.push(track[i].gpsAlt);
    if (!visibleAlts.length) visibleAlts.push(track[0].gpsAlt, track[track.length-1].gpsAlt);
    let minA = Math.min(...visibleAlts), maxA = Math.max(...visibleAlts);
    if (groundProfile) {
      const gv = groundProfile.filter(g=>g.distKm>=visStart && g.distKm<=visEnd).map(g=>g.elev).filter(v=>v!=null);
      if (gv.length) minA = Math.min(minA, ...gv);
    }
    maxA = Math.max(maxA, minA+1);
    const altRange = maxA-minA || 1;
    const span = (visEnd-visStart) || 1;
    const xPos = d => padL + ((d-visStart)/span)*plotW;
    const yPos = alt => padT + plotH - ((alt-minA)/altRange)*plotH;

    ctx.strokeStyle = "rgba(255,255,255,0.15)"; ctx.lineWidth = 1*dpr;
    ctx.beginPath(); ctx.moveTo(padL,padT); ctx.lineTo(padL,padT+plotH); ctx.lineTo(padL+plotW,padT+plotH); ctx.stroke();

    ctx.fillStyle = "rgba(232,244,253,0.5)"; ctx.font = `${10*dpr}px -apple-system,sans-serif`;
    ctx.textAlign = "right";
    ctx.fillText(Math.round(maxA)+"m", padL-4*dpr, padT+9*dpr);
    ctx.fillText(Math.round(minA)+"m", padL-4*dpr, padT+plotH);
    ctx.textAlign = "left"; ctx.fillText(visStartLabel.toFixed(1)+" km", padL, padT+plotH+15*dpr);
    ctx.textAlign = "right"; ctx.fillText(visEndLabel.toFixed(1)+" km", padL+plotW, padT+plotH+15*dpr);
    if (viewScale > 1.02) {
      ctx.textAlign = "center"; ctx.fillText(`${viewScale.toFixed(1)}×`, padL+plotW/2, padT+9*dpr);
      ctx.save();
      ctx.setLineDash([4*dpr, 4*dpr]);
      ctx.strokeStyle = "rgba(220,38,38,0.7)"; ctx.lineWidth = 1*dpr;
      ctx.beginPath();
      ctx.moveTo(padL+plotW/2, padT);
      ctx.lineTo(padL+plotW/2, padT+plotH);
      ctx.stroke();
      ctx.restore();

      // Altitude where the track crosses the dashed centre line — same
      // point the map's red reference marker sits at — shown on the
      // Y-axis alongside the min/max labels, positioned at its own height.
      // While cine playback is actively running, this follows the moving
      // glider's position instead (same distance basis FlightMap reports),
      // so the red label always matches whichever marker is actually
      // visible on the map right now.
      const centerDist = (isPlaybackActive && playbackDistanceKm != null) ? playbackDistanceKm*scale : (visStart+visEnd)/2;
      let closestIdx = 0, closestDiff = Infinity;
      for (let i=0;i<distances.length;i++) {
        const diff = Math.abs(distances[i]-centerDist);
        if (diff < closestDiff) { closestDiff = diff; closestIdx = i; }
      }
      const centerAlt = track[closestIdx]?.gpsAlt;
      if (centerAlt != null) {
        const cy = Math.max(padT+9*dpr, Math.min(padT+plotH, yPos(centerAlt)));
        ctx.fillStyle = "#dc2626"; ctx.font = `bold ${10*dpr}px -apple-system,sans-serif`;
        ctx.textAlign = "right";
        ctx.fillText(Math.round(centerAlt)+"m", padL-4*dpr, cy);
      }

      // Elapsed flight duration + distance at that same point, shown under
      // the X-axis at the dashed line's horizontal position (not absolute
      // clock time — duration since takeoff is what's actually useful when
      // scrubbing through a flight's profile).
      const utcStartSec = track[0]?.timeSec;
      const rawTime = track[closestIdx]?.timeSec;
      if (rawTime != null && utcStartSec != null) {
        const elapsedSec = Math.max(0, rawTime - utcStartSec);
        const hh = String(Math.floor(elapsedSec/3600)).padStart(2,"0");
        const mm = String(Math.floor((elapsedSec%3600)/60)).padStart(2,"0");
        ctx.fillStyle = "#dc2626"; ctx.font = `bold ${10*dpr}px -apple-system,sans-serif`;
        ctx.textAlign = "center";
        ctx.fillText(`${hh}:${mm}/${centerDist.toFixed(1)}km`, padL+plotW/2, padT+plotH+29*dpr);
      }
    }

    if (playbackDistanceKm != null) {
      const scaledDist = playbackDistanceKm * scale;
      if (scaledDist >= visStart && scaledDist <= visEnd) {
        const px = xPos(scaledDist);
        ctx.save();
        ctx.strokeStyle = "#4ade80"; ctx.lineWidth = 2*dpr;
        ctx.beginPath();
        ctx.moveTo(px, padT);
        ctx.lineTo(px, padT+plotH);
        ctx.stroke();
        ctx.fillStyle = "#4ade80";
        ctx.beginPath();
        ctx.arc(px, padT+plotH, 4*dpr, 0, Math.PI*2);
        ctx.fill();
        ctx.restore();
      }
    }

    if (groundProfile && groundProfile.length) {
      // Only the points inside (plus one just outside on each side, so the
      // fill/line doesn't visibly stop short at the window edge) the
      // current zoom window — including every sample across the whole
      // flight here, even ones far outside what's visible, was mapping
      // those to wildly off-canvas x-coordinates and back, which is what
      // produced the zigzag distortion when zoomed in.
      const visibleGround = [];
      for (let i=0;i<groundProfile.length;i++) {
        const g = groundProfile[i];
        const inRange = g.distKm >= visStart && g.distKm <= visEnd;
        const prevOut = i>0 && groundProfile[i-1].distKm < visStart;
        const nextOut = i<groundProfile.length-1 && groundProfile[i+1].distKm > visEnd;
        if (inRange || (prevOut && g.distKm < visStart) || (nextOut && g.distKm > visEnd)) visibleGround.push(g);
      }
      // Margin points (the one just outside the window on each side) exist
      // purely so the line's slope into the edge is right — their actual
      // x position can fall outside the plot area, which used to let the
      // ground line/fill visibly overshoot past the axis on that side
      // (the track never had this problem since it has no such margin
      // points). Clamping to the plot bounds here keeps the edge slope
      // correct while never drawing past the axis.
      const clampX = x => Math.max(padL, Math.min(padL+plotW, x));
      const firstElev = visibleGround.find(g=>g.elev!=null)?.elev;
      const lastElev = [...visibleGround].reverse().find(g=>g.elev!=null)?.elev;
      ctx.beginPath();
      ctx.moveTo(xPos(visStart), firstElev!=null ? yPos(firstElev) : padT+plotH);
      visibleGround.forEach(g => { if (g.elev!=null) ctx.lineTo(clampX(xPos(g.distKm)), yPos(g.elev)); });
      if (lastElev!=null) ctx.lineTo(xPos(visEnd), yPos(lastElev));
      ctx.lineTo(xPos(visEnd), padT+plotH);
      ctx.lineTo(xPos(visStart), padT+plotH);
      ctx.closePath();
      ctx.fillStyle = "rgba(120,72,32,0.55)"; ctx.fill();
      ctx.strokeStyle = "rgba(150,95,45,0.9)"; ctx.lineWidth = 1.5*dpr;
      ctx.beginPath();
      let started = false;
      visibleGround.forEach((g) => { if (g.elev!=null) { const px=clampX(xPos(g.distKm)), py=yPos(g.elev); if(!started){ctx.moveTo(px,py);started=true;} else ctx.lineTo(px,py); } });
      ctx.stroke();
    }

    for (let i=1;i<track.length;i++) {
      if (distances[i] < visStart && distances[i-1] < visStart) continue;
      if (distances[i-1] > visEnd && distances[i] > visEnd) continue;
      const t = (track[i].gpsAlt-minA)/altRange;
      ctx.strokeStyle = `hsl(${t*240},100%,50%)`; ctx.lineWidth = 2.5*dpr;
      ctx.beginPath();
      ctx.moveTo(xPos(distances[i-1]), yPos(track[i-1].gpsAlt));
      ctx.lineTo(xPos(distances[i]), yPos(track[i].gpsAlt));
      ctx.stroke();
    }
  }, [track, distances, totalDist, groundProfile, viewStart, viewScale, playbackDistanceKm, isPlaybackActive]);

  if (!track.length) return null;

  return (
    <div style={{marginBottom:14}}>
      <div style={{display:"flex",justifyContent:"space-between",alignItems:"center",marginBottom:6,gap:8}}>
        <div style={{fontSize:10,fontWeight:700,color:"#7dd3fc",letterSpacing:1.5,textTransform:"uppercase",flexShrink:0}}>Höhenprofil</div>
        <div style={{display:"flex",alignItems:"center",gap:8,flex:1,justifyContent:"flex-end",position:"relative"}}>
          <button onClick={()=>setZoomPickerOpen(o=>!o)}
            style={{background:"rgba(255,255,255,0.08)",border:"1px solid rgba(255,255,255,0.15)",borderRadius:8,padding:"4px 10px",color:"rgba(232,244,253,0.8)",fontSize:11,fontWeight:700,cursor:"pointer",flexShrink:0}}>
            🔍 Zoom {zoomLevel}× ▾
          </button>
          {zoomPickerOpen && (
            <div onClick={()=>setZoomPickerOpen(false)}
              style={{position:"fixed",inset:0,zIndex:250}}>
              <div onClick={e=>e.stopPropagation()}
                style={{position:"absolute",top:0,right:16,marginTop:4,background:"#14253a",border:"1px solid rgba(255,255,255,0.15)",borderRadius:10,padding:4,boxShadow:"0 8px 24px rgba(0,0,0,0.5)",display:"flex",flexDirection:"column",gap:2,minWidth:70}}>
                {[1,2,3,4,5,6,7,8].map(z=>(
                  <button key={z} onClick={()=>{setZoomLevel(z);setPanPos(0);setZoomPickerOpen(false);}}
                    style={{background:z===zoomLevel?"rgba(125,211,252,0.2)":"transparent",border:"none",borderRadius:6,padding:"6px 10px",color:z===zoomLevel?"#7dd3fc":"#e8f4fd",fontSize:13,fontWeight:z===zoomLevel?700:400,cursor:"pointer",textAlign:"left"}}>
                    {z}×
                  </button>
                ))}
              </div>
            </div>
          )}
          {zoomLevel > 1 && (
            <button onClick={()=>setZoomLevel(1)}
              style={{background:"rgba(255,255,255,0.08)",border:"1px solid rgba(255,255,255,0.15)",borderRadius:8,padding:"3px 9px",color:"rgba(232,244,253,0.7)",fontSize:10,fontWeight:700,cursor:"pointer",flexShrink:0}}>
              ↺ Zoom zurücksetzen
            </button>
          )}
        </div>
      </div>
      <div style={{borderRadius:14,overflow:"hidden",border:"1px solid rgba(100,180,255,0.12)",background:"#040e20"}}>
        <canvas ref={canvasRef} style={{width:"100%",height:160,display:"block",touchAction:zoomLevel>1?"none":"auto"}} />
      </div>
      {groundError && <div style={{fontSize:10,color:"rgba(232,244,253,0.35)",marginTop:4}}>Bodenprofil momentan nicht verfügbar (Höhendaten-Dienst nicht erreichbar) — Flugtrace wird trotzdem angezeigt.</div>}
      {manualDist>0 && <div style={{fontSize:9,color:"rgba(232,244,253,0.3)",marginTop:4}}>Streckenachse proportional auf die eingetragene Distanz ({manualDist} km) skaliert.</div>}
      {zoomLevel>1 && <div style={{fontSize:9,color:"rgba(232,244,253,0.3)",marginTop:2}}>Im Profil wischen, um den sichtbaren Ausschnitt zu verschieben.</div>}
    </div>
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
// All 25 columns from the original fixed layout, now available as
// individually selectable/reorderable entries for the configurable copy
// feature. "getter" is a key into flightToCsvValues()'s output; columns
// without real source data (Numbers-formula placeholders in the original
// sheet) use getter:null and always emit FORMULA_PLACEHOLDER.
const CSV_COLUMN_DEFS = [
  { key: "nr", label: "Nr.", getter: "nr" },
  { key: "flugreise", label: "Flugreise", getter: "flugreise" },
  { key: "datum", label: "Datum", getter: "datum" },
  { key: "startzeit", label: "Startzeit", getter: "startzeit" },
  { key: "start", label: "Start", getter: "start" },
  { key: "landezeit", label: "Landezeit", getter: "landezeit" },
  { key: "landung", label: "Landung", getter: "landung" },
  { key: "sl_entf", label: "S-L Entf.", getter: null },
  { key: "dauer", label: "Dauer", getter: null },
  { key: "rang", label: "Rang", getter: null },
  { key: "prozent", label: "%", getter: null },
  { key: "distanz", label: "Distanz", getter: "distanz" },
  { key: "kmh", label: "km/h", getter: null },
  { key: "hdiff", label: "H.Diff.", getter: null },
  { key: "muemS", label: "müM S", getter: "muemS" },
  { key: "muemL", label: "müM L", getter: "muemL" },
  { key: "hmax", label: "H.Max", getter: "hmax" },
  { key: "sue", label: "SÜ", getter: null },
  { key: "hgew", label: "H.Gew.", getter: "hgew" },
  { key: "sinken", label: "Sinken", getter: "sinken" },
  { key: "steigen", label: "Steigen", getter: "steigen" },
  { key: "geraet", label: "Gerät", getter: "geraet" },
  { key: "passagier", label: "Passagier", getter: "passagier" },
  { key: "datum2", label: "Datum2", getter: null },
  { key: "bemerkung", label: "Bemerkung", getter: "bemerkung" },
];
const CSV_COLUMN_DEFAULT_ORDER = CSV_COLUMN_DEFS.map(c => c.key);

function flightToCsvValues(f) {
  const cf = f.customFields || {};
  // Combines a place name with its altitude and lat/lon (5 decimals) into
  // one comma+space-separated string for the Start/Landung columns, e.g.
  // "Tannay, 1450, 46.20123, 6.85432" — pieces that aren't available are
  // simply omitted rather than leaving stray empty commas.
  const combineLocation = (name, altStr, pt) => {
    const parts = [];
    if (name) parts.push(name);
    if (altStr) parts.push(String(altStr));
    if (pt && pt.lat != null && pt.lon != null) {
      parts.push(pt.lat.toFixed(5));
      parts.push(pt.lon.toFixed(5));
    }
    return parts.join(", ");
  };
  return {
    nr:       f.name || "",
    flugreise: "",
    datum:    f.rawDate || f.date || "",
    startzeit: f.startTime || "",
    start:    combineLocation(f.site || "", f.startAlt ? String(f.startAlt) : (cf.msa || ""), f.startPt),
    landezeit: f.endTime || "",
    landung:  combineLocation(cf.landung || "", f.endAlt ? String(f.endAlt) : (cf.ml || ""), f.endPt),
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
}

// Builds one tab-separated row using an arbitrary, user-chosen subset/order
// of CSV_COLUMN_DEFS (by key) — this is what makes the copy feature
// adaptable to whatever column layout an external spreadsheet expects.
function buildCsvRow(f, columnKeys) {
  const values = flightToCsvValues(f);
  return columnKeys.map(key => {
    const def = CSV_COLUMN_DEFS.find(c => c.key === key);
    if (!def) return "";
    return def.getter ? (values[def.getter] || "") : FORMULA_PLACEHOLDER;
  }).join("\t");
}

function flightToCsvRow(f) {
  return buildCsvRow(f, CSV_COLUMN_DEFAULT_ORDER);
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
    dur: get(8), dk: get(11), kmh: get(12), hd: get(13),
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
    dur: get(34), dk: get(37), kmh: get(38), hd: get(39),
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
      typ: p.ty||"",
    },
  };
}

// ── FILTER ENGINE ────────────────────────────────────────────────────────
// Supports: free text, UND/AND/&& , ODER/OR/|| , field:value, field>val, field<val,
// field>=val, field<=val, +word (muss), -word (darf nicht). Duration values like
// 1h, 1:30, 90m are parsed to seconds for dauer comparisons.
// Straight-line distance between two points (km) — used for "Entfernung
// Start-Landung", which is deliberately the direct line between takeoff and
// landing coordinates, not the flown path length (that's the existing,
// manually-entered "Distanz" field).
// The one place that decides what "the flight's distance" is, given the
// several places it can come from (current entry field vs. older imported
// data) — used both by the Distanz field itself and by FlightProfile's
// axis scaling, so the two can never read a different value from each
// other by construction.
function getDisplayDistance(fl) {
  if (fl?.totalDist) return String(fl.totalDist);
  return fl?.customFields?.distKm || fl?.customFields?.dk || "";
}
function haversineDistKm(a, b) {
  if (!a || !b || a.lat == null || b.lat == null) return null;
  const R = 6371, dLat = (b.lat-a.lat)*Math.PI/180, dLon = (b.lon-a.lon)*Math.PI/180;
  const x = Math.sin(dLat/2)**2 + Math.cos(a.lat*Math.PI/180)*Math.cos(b.lat*Math.PI/180)*Math.sin(dLon/2)**2;
  return R * 2 * Math.atan2(Math.sqrt(x), Math.sqrt(1-x));
}
// Compass bearing (0°=North, 90°=East, ...) from point a to point b —
// used to rotate the glider reference marker to face the actual flight
// direction at that point in the track.
function bearingDeg(a, b) {
  if (!a || !b || a.lat == null || b.lat == null) return 0;
  const lat1 = a.lat*Math.PI/180, lat2 = b.lat*Math.PI/180;
  const dLon = (b.lon-a.lon)*Math.PI/180;
  const y = Math.sin(dLon) * Math.cos(lat2);
  const x = Math.cos(lat1)*Math.sin(lat2) - Math.sin(lat1)*Math.cos(lat2)*Math.cos(dLon);
  return (Math.atan2(y, x) * 180/Math.PI + 360) % 360;
}
// Attaches four derived fields to every flight, computed once across the
// whole list: rangDauer/pctDauer (this flight's duration rank and % of the
// longest flight) and rangStrecke/pctStrecke (same for Distanz), plus
// entfernungSL (straight-line Start-Landung distance). Precomputing these
// once here — rather than inside the generic per-flight sort/search
// functions — keeps those functions simple (they just read a normal field)
// instead of needing the whole flight list threaded through every call.
function attachComputedRanks(flights) {
  const byDur = [...flights].filter(f => (f.durationSec||0) > 0).sort((a,b) => b.durationSec - a.durationSec);
  const maxDur = byDur[0]?.durationSec || 0;
  const durRank = new Map(byDur.map((f,i) => [f.id, i+1]));

  const distOf = f => f.totalDist || parseFloat(f.customFields?.distKm || f.customFields?.dk || 0) || 0;
  const byDist = [...flights].filter(f => distOf(f) > 0).sort((a,b) => distOf(b) - distOf(a));
  const maxDist = byDist.length ? distOf(byDist[0]) : 0;
  const distRank = new Map(byDist.map((f,i) => [f.id, i+1]));

  return flights.map(f => {
    const dur = f.durationSec || 0;
    const dist = distOf(f);
    const sl = haversineDistKm(f.startPt, f.endPt);
    return {
      ...f,
      rangDauer: durRank.get(f.id) || null,
      pctDauer: maxDur ? Math.round((dur/maxDur)*100) : null,
      rangStrecke: distRank.get(f.id) || null,
      pctStrecke: maxDist ? Math.round((dist/maxDist)*100) : null,
      entfernungSL: sl != null ? +sl.toFixed(1) : null,
    };
  });
}
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
    case "reise": return cf.reise||"";
    case "jahr": case "year": return f.year||"";
    case "datum": case "date": return f.date||"";
    case "startzeit": case "starttime": return f.startTime||"";
    case "landezeit": case "endtime": return f.endTime||"";
    case "kommentar": case "comment": return f.comment||"";
    case "bemerkung": case "notes": case "notiz": return f.notes||"";
    case "dauer": case "duration": return (f.durationSec||parseDurToSec(f.durationStr))/3600; // hours (number)
    case "distanz": case "dist": case "km": return f.totalDist||parseFloat(cf.distKm||cf.dk||0)||0;
    case "höhe": case "hoehe": case "maxhöhe": case "maxhoehe": case "alt": return f.maxAlt||+(cf.hMax||cf.hm||0)||0;
    case "startalt": return f.startAlt||+(cf.msa||0)||0;
    case "endalt": return f.endAlt||+(cf.ml||0)||0;
    case "hdiff": return +(cf.hDiff||0)||0;
    case "maxsteigen": return +(cf.maxSteigen||0)||0;
    case "maxsinken": return +(cf.maxSinken||0)||0;
    case "hgew": return +(cf.hGew||0)||0;
    case "entfernungsl": return f.entfernungSL||0;
    case "rangdauer": return f.rangDauer||0;
    case "pctdauer": return f.pctDauer||0;
    case "rangstrecke": return f.rangStrecke||0;
    case "pctstrecke": return f.pctStrecke||0;
    case "startlat": return f.startPt?.lat||0;
    case "startlon": return f.startPt?.lon||0;
    case "endlat": return f.endPt?.lat||0;
    case "endlon": return f.endPt?.lon||0;
    case "speed": case "kmh": return parseFloat(cf.kmh||0)||0;
    case "rating": case "bewertung": return f.rating||0;
    default: return "";
  }
}
function evalToken(f, tok){
  // comparison field op value — now also accepts != (not equal)
  let m=tok.match(/^([\wäöü]+)\s*(>=|<=|!=|≠|>|<|=|:)\s*(.+)$/i);
  if(m){
    const field=m[1].toLowerCase(), op=(m[2]==="≠"?"!=":m[2]), raw=m[3].trim();
    // "passagier:*" (or pax:*) means "any passenger at all" — for finding
    // biplace flights regardless of who the passenger was, rather than
    // matching a specific name.
    if((field==="passagier"||field==="pax") && raw==="*"){
      const has = !!(f.customFields?.passagier||"").trim();
      return op==="!=" ? !has : has;
    }
    let fv=flightFieldValue(f, field);

    const numericFields=["dauer","duration","distanz","dist","km","höhe","hoehe","maxhöhe","maxhoehe","alt",
      "startalt","endalt","hdiff","maxsteigen","maxsinken","hgew","entfernungsl","rangdauer","pctdauer","rangstrecke","pctstrecke",
      "speed","kmh","rating","bewertung","jahr","year","startlat","startlon","endlat","endlon"];
    const dateFields=["datum","date"];
    const timeFields=["startzeit","starttime","landezeit","endtime"];

    if(numericFields.includes(field)){
      let cmp = field==="dauer"||field==="duration" ? parseDurToSec(raw)/3600 : parseFloat(raw.replace(",","."));
      fv = parseFloat(fv)||0;
      if(isNaN(cmp)) return true;
      if(op===">") return fv>cmp;
      if(op==="<") return fv<cmp;
      if(op===">=") return fv>=cmp;
      if(op==="<=") return fv<=cmp;
      if(op==="!=") return Math.abs(fv-cmp)>=0.0001;
      return Math.abs(fv-cmp)<0.0001;
    }
    if(dateFields.includes(field)){
      // Chronological comparison (not string comparison — "05.01.2026" must
      // sort after "12.01.2025" despite being alphabetically earlier).
      const cmp = parseDateToTs(raw);
      const fvTs = parseDateToTs(fv);
      if(!cmp) return true;
      if(op===">") return fvTs>cmp;
      if(op==="<") return fvTs<cmp;
      if(op===">=") return fvTs>=cmp;
      if(op==="<=") return fvTs<=cmp;
      if(op==="!=") return fvTs!==cmp;
      return fvTs===cmp;
    }
    if(timeFields.includes(field)){
      const toSec = t => { const m2=String(t).match(/(\d{1,2}):(\d{2})(?::(\d{2}))?/); return m2?(+m2[1]*3600+ +m2[2]*60+ +(m2[3]||0)):null; };
      const cmp = toSec(raw), fvSec = toSec(fv);
      if(cmp==null) return true;
      if(fvSec==null) return false;
      if(op===">") return fvSec>cmp;
      if(op==="<") return fvSec<cmp;
      if(op===">=") return fvSec>=cmp;
      if(op==="<=") return fvSec<=cmp;
      if(op==="!=") return fvSec!==cmp;
      return fvSec===cmp;
    }
    // text fields: ":" (default) means contains; "=" means exact match;
    // "!=" means does NOT contain; >/</>=/<= compare alphabetically
    // (locale-aware, so names/places sort the way a person would expect).
    const fvStr = String(fv), rawStr = raw;
    if(op===":") return fvStr.toLowerCase().includes(rawStr.toLowerCase());
    if(op==="=") return fvStr.toLowerCase() === rawStr.toLowerCase();
    if(op==="!=") return !fvStr.toLowerCase().includes(rawStr.toLowerCase());
    const cmpAlpha = fvStr.localeCompare(rawStr, "de", {sensitivity:"base"});
    if(op===">") return cmpAlpha>0;
    if(op==="<") return cmpAlpha<0;
    if(op===">=") return cmpAlpha>=0;
    if(op==="<=") return cmpAlpha<=0;
    return fvStr.toLowerCase().includes(rawStr.toLowerCase());
  }
  // plain word => search across all text
  const hay=[f.name,f.site,f.glider,f.pilot,f.customFields?.passagier,f.customFields?.landung,f.customFields?.reise,f.comment,f.notes,f.date,f.year].join(" ").toLowerCase();
  return hay.includes(tok.toLowerCase());
}
// ── SORT ENGINE ──────────────────────────────────────────────────────────
const SORT_OPTIONS = [
  { id: "number",   label: "Nummer" },
  { id: "date",     label: "Datum" },
  { id: "startTime", label: "Startzeit" },
  { id: "endTime",  label: "Landezeit" },
  { id: "site",     label: "Startplatz" },
  { id: "landung",  label: "Landeplatz" },
  { id: "glider",   label: "Schirm" },
  { id: "pax",      label: "Passagier" },
  { id: "reise",    label: "Reise" },
  { id: "duration", label: "Dauer" },
  { id: "dist",     label: "Distanz" },
  { id: "alt",      label: "Max. Höhe" },
  { id: "startAlt", label: "Start müM" },
  { id: "endAlt",   label: "Landung müM" },
  { id: "hDiff",    label: "H.Diff." },
  { id: "speed",    label: "Ø Speed" },
  { id: "maxSteigen", label: "Max.Steigen" },
  { id: "maxSinken", label: "Max.Sinken" },
  { id: "hGew",     label: "H.Gew." },
  { id: "entfernungSL", label: "Entf. S-L" },
  { id: "rangDauer", label: "Rang Dauer" },
  { id: "pctDauer", label: "% Dauer" },
  { id: "rangStrecke", label: "Rang Strecke" },
  { id: "pctStrecke", label: "% Strecke" },
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
    case "startTime": return f.startTime || "";
    case "endTime":  return f.endTime || "";
    case "duration": return f.durationSec || parseDurToSec(f.durationStr);
    case "dist":     return f.totalDist || parseFloat(cf.distKm || cf.dk || 0) || 0;
    case "alt":      return f.maxAlt || +(cf.hMax || cf.hm || 0) || 0;
    case "startAlt": return f.startAlt || +(cf.msa || 0) || 0;
    case "endAlt":   return f.endAlt || +(cf.ml || 0) || 0;
    case "hDiff":    return +(cf.hDiff||0) || 0;
    case "maxSteigen": return +(cf.maxSteigen||0) || 0;
    case "maxSinken": return +(cf.maxSinken||0) || 0;
    case "hGew":     return +(cf.hGew||0) || 0;
    case "entfernungSL": return f.entfernungSL || 0;
    case "rangDauer": return f.rangDauer || 999999;
    case "pctDauer": return f.pctDauer || 0;
    case "rangStrecke": return f.rangStrecke || 999999;
    case "pctStrecke": return f.pctStrecke || 0;
    case "site":     return (f.site || "").toLowerCase();
    case "landung":  return (cf.landung || "").toLowerCase();
    case "glider":   return (f.glider || "").toLowerCase();
    case "pilot":    return (f.pilot || "").toLowerCase();
    case "pax":      return (cf.passagier || "").toLowerCase();
    case "reise":    return (cf.reise || "").toLowerCase();
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
    case "startTime": return f.startTime || "—";
    case "endTime":  return f.endTime || "—";
    case "duration": return f.durationStr || "—";
    case "dist":     return (f.totalDist || cf.distKm || cf.dk) ? (f.totalDist || cf.distKm || cf.dk) + " km" : "—";
    case "alt":      return (f.maxAlt || cf.hMax || cf.hm) ? (f.maxAlt || cf.hMax || cf.hm) + " m" : "—";
    case "startAlt": return (f.startAlt || cf.msa) ? (f.startAlt || cf.msa) + " m" : "—";
    case "endAlt":   return (f.endAlt || cf.ml) ? (f.endAlt || cf.ml) + " m" : "—";
    case "hDiff":    return cf.hDiff ? cf.hDiff + " m" : "—";
    case "maxSteigen": return cf.maxSteigen ? cf.maxSteigen + " m/s" : "—";
    case "maxSinken": return cf.maxSinken ? cf.maxSinken + " m/s" : "—";
    case "hGew":     return cf.hGew ? cf.hGew + " m" : "—";
    case "entfernungSL": return f.entfernungSL!=null ? f.entfernungSL + " km" : "—";
    case "rangDauer": return f.rangDauer!=null ? "#"+f.rangDauer : "—";
    case "pctDauer": return f.pctDauer!=null ? f.pctDauer+"%" : "—";
    case "rangStrecke": return f.rangStrecke!=null ? "#"+f.rangStrecke : "—";
    case "pctStrecke": return f.pctStrecke!=null ? f.pctStrecke+"%" : "—";
    case "site":     return f.site || "—";
    case "landung":  return cf.landung || "—";
    case "glider":   return f.glider || "—";
    case "pilot":    return f.pilot || "—";
    case "pax":      return cf.passagier || "—";
    case "reise":    return cf.reise || "—";
    case "speed":    return cf.kmh ? cf.kmh + " km/h" : "—";
    case "rating":   return f.rating ? "★".repeat(f.rating) : "—";
    default:         return f.durationStr || "—";
  }
}

function FlightRow({ f, isLongest, onClick, sortId, selectMode, isSelected, onToggleSelect, reiseLabel, isWide }) {
  const pax = f.customFields?.passagier;
  const showSortValue = sortId && sortId !== "date" && sortId !== "number";

  // Wide (iPad/desktop): compact single line — Nr, Datum, Start, Schirm,
  // gap, IGC-badge, then far right Distanz/Dauer. iPhone below is
  // untouched from the original 2-line design.
  if (isWide) {
    return (
      <div onClick={selectMode ? ()=>onToggleSelect(f.id) : onClick}
        style={{padding:"9px 16px",borderBottom:"1px solid rgba(255,255,255,0.04)",cursor:"pointer",display:"flex",alignItems:"center",gap:8,background:isSelected?"rgba(14,165,233,0.1)":"transparent",transition:"background 0.15s",whiteSpace:"nowrap",overflow:"hidden"}}
        onMouseEnter={e=>{ if(!isSelected) e.currentTarget.style.background="rgba(255,255,255,0.03)"; }}
        onMouseLeave={e=>{ if(!isSelected) e.currentTarget.style.background="transparent"; }}>
        {selectMode && (
          <div style={{flexShrink:0,width:20,height:20,borderRadius:6,border:`2px solid ${isSelected?"#7dd3fc":"rgba(232,244,253,0.3)"}`,background:isSelected?"#7dd3fc":"transparent",display:"flex",alignItems:"center",justifyContent:"center"}}>
            {isSelected && <span style={{color:"#0a1628",fontSize:13,fontWeight:900}}>✓</span>}
          </div>
        )}
        {isLongest&&<span style={{fontSize:10,flexShrink:0}}>🏆</span>}
        <span style={{fontWeight:700,fontSize:15,flexShrink:0}}>{f.name}</span>
        <span style={{fontSize:11,color:"rgba(232,244,253,0.4)",flexShrink:0}}>{f.date}</span>
        <span style={{fontSize:11,color:"rgba(232,244,253,0.4)",overflow:"hidden",textOverflow:"ellipsis",minWidth:0}}>{f.site||"—"}</span>
        {f.glider && <span style={{fontSize:11,color:"rgba(232,244,253,0.4)",overflow:"hidden",textOverflow:"ellipsis",minWidth:0,flexShrink:2}}>· {f.glider}</span>}
        <span style={{flexShrink:0,marginLeft:6}}>
          {f.track?.length>1&&<span style={{background:"rgba(34,197,94,0.22)",color:"#4ade80",borderRadius:20,padding:"1px 7px",fontSize:9,fontWeight:700,boxShadow:"0 0 6px rgba(74,222,128,0.5)"}}>IGC</span>}
        </span>
        <span style={{flex:1}} />
        <div style={{textAlign:"right",flexShrink:0,display:"flex",alignItems:"center",gap:10}}>
          {!showSortValue && f.totalDist ? <span style={{fontSize:11,color:"rgba(232,244,253,0.3)"}}>{f.totalDist} km</span> : null}
          <span style={{fontSize:13,fontWeight:600,color:"#7dd3fc"}}>{showSortValue ? formatSortValue(f, sortId) : (f.durationStr||"—")}</span>
        </div>
      </div>
    );
  }

  // iPhone (original, unchanged 2-line design)
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
        <div style={{fontSize:13,fontWeight:600,color:"#7dd3fc",display:"flex",alignItems:"center",justifyContent:"flex-end",gap:4}}>
          {f.rating>0 && <span><span style={{color:"#fde047"}}>{f.rating}</span><span style={{fontSize:"0.85em"}}>⭐️</span></span>}
          <span>{showSortValue ? formatSortValue(f, sortId) : (f.durationStr||"—")}</span>
        </div>
        {!showSortValue && (
          <div style={{fontSize:11,color:"rgba(232,244,253,0.3)"}}>{f.totalDist?f.totalDist+" km":""}</div>
        )}
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
        return t.match(/(?:[\wäöü]+(?:>=|<=|!=|≠|>|<|=|:)\S+|\+\S+|\-\S+|"[^"]+"|\S+)/gi)||[];
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

// ── ADVANCED SEARCH (macOS-Finder-style, multiple combinable criteria) ────
// Builds on top of the existing matchFlights/evalToken text-query engine
// instead of replacing it: each visual row just gets rendered into the same
// "field:value" / "field>value" token syntax already understood above, so
// both the simple one-line search and the row-based builder share one
// matching engine and never disagree with each other.
const SEARCH_FIELDS = [
  { id: "name",      label: "Name/Titel",     type: "text" },
  { id: "site",      label: "Startplatz",     type: "text" },
  { id: "landung",   label: "Landeplatz",     type: "text" },
  { id: "glider",    label: "Schirm",         type: "text" },
  { id: "pilot",     label: "Pilot",          type: "text" },
  { id: "passagier", label: "Passagier",      type: "text", anyOption: true },
  { id: "reise",     label: "Reise",          type: "text" },
  { id: "datum",     label: "Datum",          type: "date" },
  { id: "startzeit", label: "Startzeit",      type: "time" },
  { id: "landezeit", label: "Landezeit",      type: "time" },
  { id: "jahr",      label: "Jahr",           type: "number" },
  { id: "bemerkung", label: "Bemerkung",      type: "text" },
  { id: "dauer",     label: "Dauer (h)",      type: "number" },
  { id: "distanz",   label: "Distanz (km)",   type: "number" },
  { id: "hoehe",     label: "Max. Höhe (m)",  type: "number" },
  { id: "startalt",  label: "Start müM",      type: "number" },
  { id: "endalt",    label: "Landung müM",    type: "number" },
  { id: "hdiff",     label: "H.Diff. (m)",    type: "number" },
  { id: "speed",     label: "Ø Speed (km/h)", type: "number" },
  { id: "maxsteigen", label: "Max.Steigen (m/s)", type: "number" },
  { id: "maxsinken", label: "Max.Sinken (m/s)", type: "number" },
  { id: "hgew",      label: "H.Gew. (m)",     type: "number" },
  { id: "entfernungsl", label: "Entf. S-L (km)", type: "number" },
  { id: "startlat",  label: "Start Lat",      type: "number" },
  { id: "startlon",  label: "Start Lon",      type: "number" },
  { id: "endlat",    label: "Landung Lat",    type: "number" },
  { id: "endlon",    label: "Landung Lon",    type: "number" },
  { id: "rangdauer", label: "Rang Dauer",     type: "number" },
  { id: "pctdauer",  label: "% Dauer",        type: "number" },
  { id: "rangstrecke", label: "Rang Strecke", type: "number" },
  { id: "pctstrecke", label: "% Strecke",     type: "number" },
  { id: "rating",    label: "Bewertung",      type: "number" },
];
const ADV_OPS_NUM = [">=", "<=", "!=", ">", "<", "=", "between"];
const ADV_OPS_TEXT = [":", "=", "!=", ">", "<", ">=", "<="];

// All fields a data tile in the flight detail view can be set to show,
// plus the default 9-tile layout (matches what used to be hardcoded).
const TILE_FIELD_OPTIONS = [
  { key: "duration",  label: "Dauer",         icon: "⏱",  get: fl => fl.durationStr || "—" },
  { key: "maxAlt",    label: "Max. Höhe",     icon: "⬆",  get: fl => fl.maxAlt ? fl.maxAlt+" m" : "—" },
  { key: "distanz",   label: "Distanz",       icon: "📏", get: fl => fl.totalDist ? fl.totalDist+" km" : (fl.customFields?.distKm||fl.customFields?.dk ? (fl.customFields.distKm||fl.customFields.dk)+" km" : "—") },
  { key: "startAlt",  label: "Start müM",     icon: "↑",  get: fl => fl.startAlt>0 ? fl.startAlt+" m" : (fl.customFields?.msa ? fl.customFields.msa+" m" : "—") },
  { key: "endAlt",    label: "Land. müM",     icon: "↓",  get: fl => fl.endAlt>0 ? fl.endAlt+" m" : (fl.customFields?.ml ? fl.customFields.ml+" m" : "—") },
  { key: "hDiff",     label: "H.Diff.",       icon: "↕",  get: fl => fl.customFields?.hDiff ? fl.customFields.hDiff+" m" : "—" },
  { key: "maxSinken", label: "Max.Sinken",    icon: "⬇",  get: fl => fl.customFields?.maxSinken ? fl.customFields.maxSinken+" m/s" : "—" },
  { key: "maxSteigen", label: "Max.Steigen",  icon: "⬆",  get: fl => (fl.customFields?.maxSteigen||fl.maxClimb) ? (fl.customFields?.maxSteigen||fl.maxClimb)+" m/s" : "—" },
  { key: "speed",     label: "Ø Speed",       icon: "💨", get: fl => fl.customFields?.kmh ? fl.customFields.kmh+" km/h" : "—" },
  { key: "hGew",      label: "Höhengewinn",   icon: "📈", get: fl => fl.customFields?.hGew ? fl.customFields.hGew+" m" : "—" },
  { key: "entfernungSL", label: "Entf. S-L",  icon: "📐", get: fl => fl.entfernungSL!=null ? fl.entfernungSL+" km" : "—" },
  { key: "rangDauer", label: "Rang Dauer",    icon: "🏅", get: fl => fl.rangDauer!=null ? "#"+fl.rangDauer : "—" },
  { key: "pctDauer",  label: "% Dauer",       icon: "📊", get: fl => fl.pctDauer!=null ? fl.pctDauer+"%" : "—" },
  { key: "rangStrecke", label: "Rang Strecke", icon: "🏅", get: fl => fl.rangStrecke!=null ? "#"+fl.rangStrecke : "—" },
  { key: "pctStrecke", label: "% Strecke",    icon: "📊", get: fl => fl.pctStrecke!=null ? fl.pctStrecke+"%" : "—" },
  { key: "rating",    label: "Bewertung",     icon: "⭐️", get: fl => fl.rating ? "★".repeat(fl.rating) : "—" },
];
const DEFAULT_TILE_KEYS = ["duration","maxAlt","distanz","startAlt","endAlt","hDiff","maxSinken","maxSteigen","speed"];

function buildAdvancedQuery(rows, combine) {
  const parts = rows
    .filter(r => r.value !== "" && r.value != null)
    .map(r => {
      const fieldDef = SEARCH_FIELDS.find(f => f.id === r.field);
      const isNumeric = fieldDef?.type === "number" || fieldDef?.type === "date" || fieldDef?.type === "time";
      const op = r.op || (isNumeric ? "=" : ":");
      if (op === "between") {
        if (r.value2 === "" || r.value2 == null) return `${r.field}>=${String(r.value).trim()}`;
        // Joined with && so this pair always stays a unit even when the
        // outer rows are combined with OR — the query engine splits on ||
        // first, so an && inside one row's own part never gets separated
        // from its partner by an OR elsewhere in the query.
        return `${r.field}>=${String(r.value).trim()} && ${r.field}<=${String(r.value2).trim()}`;
      }
      return `${r.field}${op}${String(r.value).trim()}`;
    });
  if (!parts.length) return "";
  return parts.join(combine === "OR" ? " || " : " && ");
}

function newSearchRow() { return { field: "site", op: ":", value: "" }; }

// Collapsed: a single search line (existing behaviour). Expanding it reveals
// a macOS-Finder-like row builder — add any number of Feld/Operator/Wert
// rows, combined either all-UND or all-ODER — which is translated live into
// the same query string the plain text box uses, so results stay identical
// either way.
function SearchBar({ filterText, setFilterText }) {
  // Opens on focus/tap into the search field itself (no separate button
  // needed) and stays independent state from then on — it does NOT close
  // again just because the field's text changes, since that caused the
  // panel to flicker open/closed on every keystroke. Closing only happens
  // via the explicit ✓ button below.
  const [advOpen, setAdvOpen] = useState(false);
  const [rows, setRows] = useState([newSearchRow()]);
  const [combine, setCombine] = useState("AND");

  const applyRows = (nextRows, nextCombine) => {
    setRows(nextRows);
    const useCombine = nextCombine || combine;
    if (nextCombine) setCombine(nextCombine);
    setFilterText(buildAdvancedQuery(nextRows, useCombine));
  };
  const updateRow = (idx, patch) => applyRows(rows.map((r,i)=> i===idx ? {...r, ...patch} : r));
  const addRow = () => applyRows([...rows, newSearchRow()]);
  const removeRow = (idx) => {
    const next = rows.filter((_,i)=>i!==idx);
    applyRows(next.length ? next : [newSearchRow()]);
  };

  return (
    <div style={{position:"relative"}}>
      <div style={{position:"relative"}}>
        <input value={filterText} onChange={e=>setFilterText(e.target.value)} onFocus={()=>setAdvOpen(true)} placeholder="🔍 Suchen…"
          style={{width:"100%",background:"rgba(255,255,255,0.07)",border:"1px solid rgba(255,255,255,0.1)",borderRadius:10,padding:"8px 34px 8px 12px",color:"#e8f4fd",fontSize:13,boxSizing:"border-box"}} />
        {filterText && (
          <button onClick={()=>setFilterText("")}
            style={{position:"absolute",right:8,top:"50%",transform:"translateY(-50%)",background:"none",border:"none",color:"rgba(232,244,253,0.4)",cursor:"pointer",fontSize:14}}>✕</button>
        )}
      </div>

      {advOpen && (
        <div style={{position:"absolute",top:"calc(100% + 8px)",left:0,width:"min(92vw, 420px)",zIndex:2000,background:"#0f1f36",boxShadow:"0 12px 32px rgba(0,0,0,0.5)",border:"1px solid rgba(255,255,255,0.1)",borderRadius:12,padding:10}}>
          <div style={{display:"flex",flexDirection:"column",gap:6}}>
            {rows.map((row, idx) => {
              const fieldDef = SEARCH_FIELDS.find(f=>f.id===row.field);
              return (
                <div key={idx} style={{display:"flex",gap:6,alignItems:"center"}}>
                  <span style={{fontSize:10,fontWeight:700,color:"#7dd3fc",minWidth:34,textAlign:"center",flexShrink:0}}>
                    {idx===0 ? "" : (combine==="OR"?"ODER":"UND")}
                  </span>
                  <select value={row.field}
                    onChange={e=>{
                      const nf = SEARCH_FIELDS.find(f=>f.id===e.target.value);
                      const isNum = nf?.type==="number"||nf?.type==="date"||nf?.type==="time";
                      updateRow(idx, { field: e.target.value, op: isNum ? "=" : ":", value2: undefined });
                    }}
                    style={{background:"rgba(255,255,255,0.08)",border:"1px solid rgba(255,255,255,0.12)",borderRadius:8,padding:"5px 4px",color:"#e8f4fd",fontSize:12,minWidth:0}}>
                    {SEARCH_FIELDS.map(f=><option key={f.id} value={f.id} style={{background:"#0a1628"}}>{f.label}</option>)}
                  </select>
                  {(() => {
                    const isNumeric = fieldDef?.type === "number" || fieldDef?.type === "date" || fieldDef?.type === "time";
                    const ops = isNumeric ? ADV_OPS_NUM : ADV_OPS_TEXT;
                    return (
                      <select value={row.op || (isNumeric ? "=" : ":")} onChange={e=>updateRow(idx,{op:e.target.value})}
                        style={{background:"rgba(255,255,255,0.08)",border:"1px solid rgba(255,255,255,0.12)",borderRadius:8,padding:"5px 2px",color:"#e8f4fd",fontSize:12,width:isNumeric?68:44,flexShrink:0}}>
                        {ops.map(o=><option key={o} value={o} style={{background:"#0a1628"}}>{o==="between"?"zw.":o}</option>)}
                      </select>
                    );
                  })()}
                  <input value={row.value==="*"?"":row.value} onChange={e=>updateRow(idx,{value:e.target.value})}
                    placeholder={fieldDef?.anyOption ? "Name, oder \"beliebig\" →" : (row.op==="between" ? "von…" : "Wert…")}
                    disabled={row.value==="*"}
                    style={{flex:1,minWidth:0,background:row.value==="*"?"rgba(255,255,255,0.03)":"rgba(255,255,255,0.08)",border:"1px solid rgba(255,255,255,0.12)",borderRadius:8,padding:"5px 8px",color:"#e8f4fd",fontSize:12}} />
                  {row.op==="between" && (
                    <input value={row.value2||""} onChange={e=>updateRow(idx,{value2:e.target.value})} placeholder="bis…"
                      style={{flex:1,minWidth:0,background:"rgba(255,255,255,0.08)",border:"1px solid rgba(255,255,255,0.12)",borderRadius:8,padding:"5px 8px",color:"#e8f4fd",fontSize:12}} />
                  )}
                  {fieldDef?.anyOption && (
                    <button onClick={()=>updateRow(idx,{value: row.value==="*" ? "" : "*"})}
                      title="Beliebiger Passagier (Biplace-Flüge)"
                      style={{background:row.value==="*"?"rgba(125,211,252,0.25)":"rgba(255,255,255,0.06)",border:"1px solid rgba(255,255,255,0.12)",borderRadius:8,padding:"5px 8px",color:row.value==="*"?"#7dd3fc":"rgba(232,244,253,0.6)",fontSize:11,fontWeight:700,cursor:"pointer",flexShrink:0,whiteSpace:"nowrap"}}>
                      beliebig
                    </button>
                  )}
                  <button onClick={()=>removeRow(idx)} style={{background:"none",border:"none",color:"rgba(232,244,253,0.35)",cursor:"pointer",fontSize:14,padding:"0 2px",flexShrink:0}}>✕</button>
                </div>
              );
            })}
          </div>
          <div style={{display:"flex",justifyContent:"space-between",alignItems:"center",marginTop:8}}>
            <button onClick={addRow} style={{background:"rgba(125,211,252,0.12)",border:"1px solid rgba(125,211,252,0.3)",borderRadius:8,padding:"5px 10px",color:"#7dd3fc",fontSize:11,fontWeight:700,cursor:"pointer"}}>+ Zeile</button>
            <div style={{display:"flex",gap:8,alignItems:"center"}}>
              {rows.length>1 && (
                <div style={{display:"flex",background:"rgba(255,255,255,0.06)",borderRadius:8,padding:2}}>
                  <button onClick={()=>applyRows(rows,"AND")} style={{background:combine==="AND"?"rgba(125,211,252,0.25)":"transparent",border:"none",borderRadius:6,padding:"4px 10px",color:combine==="AND"?"#7dd3fc":"rgba(232,244,253,0.5)",fontSize:11,fontWeight:700,cursor:"pointer"}}>UND</button>
                  <button onClick={()=>applyRows(rows,"OR")} style={{background:combine==="OR"?"rgba(125,211,252,0.25)":"transparent",border:"none",borderRadius:6,padding:"4px 10px",color:combine==="OR"?"#7dd3fc":"rgba(232,244,253,0.5)",fontSize:11,fontWeight:700,cursor:"pointer"}}>ODER</button>
                </div>
              )}
              <button onClick={()=>setAdvOpen(false)} title="Schliessen"
                style={{background:"rgba(34,197,94,0.18)",border:"1px solid rgba(34,197,94,0.4)",borderRadius:8,width:30,height:30,color:"#4ade80",fontSize:14,fontWeight:900,cursor:"pointer",flexShrink:0}}>✓</button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}

// ── FLIGHT RENUMBERING (chronological, gapless) ────────────────────────────
// Preserves whatever prefix/suffix text surrounds the embedded number in a
// flight's name (e.g. "Flug 42" -> "Flug 57"), so only the number itself
// changes when a date edit shifts a flight's position in the timeline.
function renumberFlightName(name, newNumber) {
  if (!name) return String(newNumber);
  const m = name.match(/\d+/);
  if (!m) return `${name} ${newNumber}`;
  return name.slice(0, m.index) + String(newNumber) + name.slice(m.index + m[0].length);
}
// Re-sorts ALL flights chronologically (date + start time) and reassigns a
// gapless 1..N numbering to every one of them, keeping each flight's own
// name style intact. Used whenever any flight's date changes, since that
// can shift its position relative to every other flight, not just itself.
function renumberAllFlights(flights) {
  const sorted = [...flights].sort((a,b) =>
    parseDateToTs(a.date||a.rawDate, a.startTime) - parseDateToTs(b.date||b.rawDate, b.startTime));
  const numberById = new Map(sorted.map((f,i)=>[f.id, i+1]));
  return flights.map(f => ({ ...f, name: renumberFlightName(f.name, numberById.get(f.id)) }));
}

function CoordEdit({lat, lon, alt, color, onSave}) {
  const [editing, setEditing] = useState(false);
  const [combined, setCombined] = useState(lat!=null&&lon!=null ? `${lat}, ${lon}` : "");
  const [al, setAl] = useState(alt!=null&&alt>0?String(alt):"");
  // Parses either "47.219903, 8.453543" or "41.86336° 21.52994°" (and
  // anything in between, e.g. no comma, no degree signs, extra spaces) —
  // strip degree symbols, then split on any run of commas/whitespace and
  // take the first two numbers as lat/lon.
  const parseLatLon = (str) => {
    if (!str) return null;
    const tokens = str.replace(/°/g, " ").split(/[,\s]+/).map(t=>t.trim()).filter(Boolean);
    if (tokens.length < 2) return null;
    const plat = parseFloat(tokens[0]);
    const plon = parseFloat(tokens[1]);
    if (isNaN(plat) || isNaN(plon)) return null;
    return { lat: plat, lon: plon };
  };
  const start = () => {
    setCombined(lat!=null&&lon!=null ? `${lat}, ${lon}` : "");
    setAl(alt!=null&&alt>0?String(alt):"");
    setEditing(true);
  };
  const commit = () => {
    setEditing(false);
    const parsed = parseLatLon(combined);
    const nalt = al.trim()===""?0:parseInt(al,10);
    onSave(parsed ? parsed.lat : null, parsed ? parsed.lon : null, isNaN(nalt)?0:nalt);
  };
  const iStyle = {width:"100%",background:"rgba(255,255,255,0.08)",border:"1px solid rgba(125,211,252,0.4)",borderRadius:6,padding:"3px 6px",color:"#e8f4fd",fontSize:11,fontFamily:"monospace",boxSizing:"border-box",marginBottom:3};
  if (editing) {
    return (
      <div>
        <input value={combined} onChange={e=>setCombined(e.target.value)} placeholder="Lat, Lon (z.B. 47.21990, 8.45354) — leer = löschen" autoFocus style={iStyle}
          onKeyDown={e=>{ if(e.key==="Enter"){e.preventDefault();commit();} }} />
        <input value={al} onChange={e=>setAl(e.target.value)} placeholder="müM" style={iStyle}
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

function StaticField({label, value, unit}) {
  return (
    <div style={{display:"flex",justifyContent:"space-between",alignItems:"center",padding:"6px 0",borderBottom:"1px solid rgba(255,255,255,0.04)"}}>
      <span style={{fontSize:13,color:"rgba(232,244,253,0.45)",minWidth:90}}>{label}</span>
      <span style={{fontSize:13,fontWeight:500,color:value?"#e8f4fd":"rgba(232,244,253,0.25)",textAlign:"right"}}>
        {value ? value+(unit?" "+unit:"") : "—"}
      </span>
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
  // that place's coordinates and altitude so the person doesn't have to
  // re-enter data that's already known for that place. If different
  // flights recorded DIFFERENT coordinates for the same name (typo'd
  // duplicate entry, GPS drift, etc.), that's ambiguous — don't silently
  // guess, ask which one to use instead.
  const [coordChoice, setCoordChoice] = useState(null); // { name, candidates } | null
  const findPlaceCandidates = (name) => {
    if (!name || !flights) return [];
    const matches = flights
      .filter(f => (kind === "start" ? f.site : f.customFields?.landung) === name)
      .filter(f => kind === "start" ? f.startPt : f.endPt)
      .sort((a,b) => parseDateToTs(b.date||b.rawDate) - parseDateToTs(a.date||a.rawDate));
    const seen = new Map(); // "lat,lon,alt" -> candidate
    for (const f of matches) {
      const pt = kind === "start" ? f.startPt : f.endPt;
      const alt = kind === "start" ? f.startAlt : f.endAlt;
      const key = `${pt.lat.toFixed(5)},${pt.lon.toFixed(5)},${alt||0}`;
      if (!seen.has(key)) seen.set(key, { pt, alt, date: f.date, flightName: f.name });
    }
    return [...seen.values()];
  };
  const findPlaceExtras = (name) => {
    const candidates = findPlaceCandidates(name);
    if (!candidates.length) return null;
    return candidates[0]; // single distinct match (or the most recent — see coordChoice for the ambiguous case)
  };

  const commitValue = (name) => {
    const candidates = findPlaceCandidates(name);
    if (candidates.length > 1) {
      onSave(name, null); // save the name now; coordinates follow once chosen
      setCoordChoice({ name, candidates });
    } else {
      onSave(name, candidates[0] || null);
    }
  };
  const commit = () => {
    if (committedByEnter.current) { committedByEnter.current = false; return; }
    setEditing(false);
    if(val!==(value||"")) commitValue(val);
  };
  const commitAndAdvance = (e) => {
    committedByEnter.current = true;
    setEditing(false);
    if(val!==(value||"")) commitValue(val);
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
    <div data-inline-row style={{display:"flex",justifyContent:"space-between",alignItems:"center",padding:"6px 0",borderBottom:"1px solid rgba(255,255,255,0.04)",position:"relative"}}>
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
      {coordChoice && (
        <div onClick={()=>setCoordChoice(null)}
          style={{position:"fixed",inset:0,background:"rgba(0,0,0,0.55)",zIndex:250,display:"flex",alignItems:"center",justifyContent:"center",padding:24}}>
          <div onClick={e=>e.stopPropagation()}
            style={{background:"#14253a",borderRadius:16,padding:"18px 20px",maxWidth:340,width:"100%",border:"1px solid rgba(255,255,255,0.1)"}}>
            <div style={{fontSize:14,fontWeight:700,marginBottom:4}}>Mehrere Koordinaten für "{coordChoice.name}"</div>
            <div style={{fontSize:12,color:"rgba(232,244,253,0.5)",marginBottom:14}}>Welche soll für diesen Flug gelten?</div>
            <div style={{display:"flex",flexDirection:"column",gap:8}}>
              {coordChoice.candidates.map((c,i)=>(
                <button key={i} onClick={()=>{ onSave(coordChoice.name, c); setCoordChoice(null); }}
                  style={{textAlign:"left",background:"rgba(255,255,255,0.06)",border:"1px solid rgba(255,255,255,0.12)",borderRadius:10,padding:"10px 12px",color:"#e8f4fd",cursor:"pointer"}}>
                  <div style={{fontSize:13,fontWeight:700,fontFamily:"monospace"}}>{c.pt.lat.toFixed(5)}, {c.pt.lon.toFixed(5)}</div>
                  <div style={{fontSize:11,color:"rgba(232,244,253,0.5)",marginTop:2}}>{c.alt||0} m müM · zuletzt bei {c.flightName} ({c.date})</div>
                </button>
              ))}
              <button onClick={()=>setCoordChoice(null)}
                style={{textAlign:"center",background:"none",border:"none",color:"rgba(232,244,253,0.4)",fontSize:12,cursor:"pointer",marginTop:2}}>
                Keine übernehmen
              </button>
            </div>
          </div>
        </div>
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
function SchirmSelect({ value, onSave, extra }) {
  const [names, setNames] = useState([]);
  const [editing, setEditing] = useState(false);
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

  // The current value must always be selectable, even if it isn't among the
  // registered Schirme on the Service page (e.g. older/imported flights, or
  // a glider that was since renamed/removed there) — otherwise the browser
  // silently falls back to the first <option> ("—"), making the field look
  // empty even though the imported name is still there.
  const options = value && !names.includes(value) ? [value, ...names] : names;

  if (!editing) {
    return (
      <div data-inline-row onClick={()=>setEditing(true)}
        style={{display:"flex",justifyContent:"space-between",alignItems:"center",padding:"6px 0",borderBottom:"1px solid rgba(255,255,255,0.04)",cursor:"pointer"}}>
        <span style={{display:"flex",alignItems:"center",gap:8}}>
          <span style={{fontSize:13,color:"rgba(232,244,253,0.45)",minWidth:90}}>Schirm</span>
          {extra}
        </span>
        <span style={{fontSize:13,color:value?"#e8f4fd":"rgba(232,244,253,0.4)"}}>{value || "—"}</span>
      </div>
    );
  }

  return (
    <div data-inline-row style={{display:"flex",justifyContent:"space-between",alignItems:"center",padding:"6px 0",borderBottom:"1px solid rgba(255,255,255,0.04)"}}>
      <span style={{fontSize:13,color:"rgba(232,244,253,0.45)",minWidth:90}}>Schirm</span>
      <select value={value||""} autoFocus onBlur={()=>setEditing(false)}
        onChange={e=>{ onSave(e.target.value); setEditing(false); }}
        style={{background:"rgba(255,255,255,0.08)",border:"1px solid rgba(255,255,255,0.12)",borderRadius:8,padding:"4px 8px",color:value?"#e8f4fd":"rgba(232,244,253,0.4)",fontSize:13,textAlign:"right",maxWidth:180}}>
        <option value="" style={{background:"#0a1628"}}>—</option>
        {options.map(n => <option key={n} value={n} style={{background:"#0a1628"}}>{n}</option>)}
      </select>
    </div>
  );
}



function DetailContent({ fl, flights, customFieldDefs, setFlights, setSelected, setView, setInlinePassagier, setEditData, saveFlight, showFieldEditor, setShowFieldEditor, handleSaveFields, confirmDelete, setConfirmDelete, hideBackButton, isWide, returnTo }) {

    const autoFields = customFieldDefs.filter(d=>d.formula).map(d=>({...d, value:evalFormula(d.formula,fl,flights)}));
    const manualFields = customFieldDefs.filter(d=>!d.formula);
    const flIdx = flights.findIndex(f=>f.id===fl.id);

    // "Typ" is only shown when it has content; this tracks a manual reveal
    // via the discreet "+ Typ" link for entering it the first time, reset
    // whenever the person moves to a different flight.
    const [typRevealed, setTypRevealed] = useState(false);
    useEffect(() => { setTypRevealed(false); }, [fl.id]);

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
      if (profileZoomActive) { touchStart.current = null; return; }
      const t = e.touches[0];
      touchStart.current = { x: t.clientX, y: t.clientY };
    };
    const onTouchEnd = (e) => {
      if (!touchStart.current || profileZoomActive) return;
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
      // Dauer and H.Diff. are always derived live from Startzeit/Landezeit
      // and Start-/Landeplatz-Höhe respectively — including for flights
      // with a real IGC track, so editing those fields by hand afterwards
      // keeps Dauer/H.Diff. in sync instead of leaving them frozen at
      // whatever the original import happened to compute. Distanz is the
      // one exception and stays purely manual: IGC-derived distance wasn't
      // reliable enough to trust, so it's never auto-filled or recomputed
      // here regardless of what else changes.
      const startTs = parseDateToTs(upd.date || upd.rawDate, upd.startTime);
      const endTs = parseDateToTs(upd.date || upd.rawDate, upd.endTime);
      if (upd.startTime && upd.endTime) {
        let diffSec = Math.round((endTs - startTs) / 1000);
        if (diffSec < 0) diffSec += 24*3600; // landing past midnight
        if (diffSec > 0) {
          upd.durationSec = diffSec;
          const h = Math.floor(diffSec/3600), m = Math.floor((diffSec%3600)/60);
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
      await saveFlight(upd);
      setFlights(p=>p.map(f=>f.id===upd.id?upd:f));
      setSelected(upd);
    };
    const [notesEditing, setNotesEditing] = useState(false);
    const [profileRange, setProfileRange] = useState(null);
    const [playbackDistance, setPlaybackDistance] = useState(null);
    const [isPlaybackActive, setIsPlaybackActive] = useState(false);
    const [tileConfig, setTileConfig] = useState(DEFAULT_TILE_KEYS);
    const [tilePickerIdx, setTilePickerIdx] = useState(null);
    useEffect(() => {
      (async () => {
        try {
          const r = await window.storage.get("settings:tileConfig");
          if (r) {
            const arr = JSON.parse(r.value);
            if (Array.isArray(arr) && arr.length === 9) setTileConfig(arr);
          }
        } catch {}
      })();
    }, []);
    const saveTileConfig = async (next) => {
      setTileConfig(next);
      try { await window.storage.set("settings:tileConfig", JSON.stringify(next)); } catch {}
    };
    const [notesVal, setNotesVal] = useState(fl.notes||"");
    const commitNotes = () => {
      setNotesEditing(false);
      if (notesVal !== (fl.notes||"")) saveField({notes: notesVal});
    };
    // Editing the date can move this flight to a different point in the
    // overall chronological order, so — unlike the other inline fields —
    // this doesn't just save the one flight: it re-sorts ALL flights by
    // date/time and reassigns gapless sequential numbers to every one of
    // them (keeping each flight's own name style, just swapping the
    // number), then persists only the flights whose number actually
    // changed as a result.
    const saveDateField = async (newDateStr) => {
      const withUpdated = flights.map(f => f.id===fl.id ? { ...f, date: newDateStr } : f);
      const renumbered = renumberAllFlights(withUpdated);
      await Promise.all(renumbered.map((f, i) => {
        if (f.name !== withUpdated[i].name || f.id === fl.id) {
          return saveFlight(f).catch(()=>{});
        }
        return null;
      }));
      setFlights(renumbered);
      const newSelected = renumbered.find(f => f.id === fl.id);
      if (newSelected) setSelected(newSelected);
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
        style={{maxWidth:isWide?1100:480,margin:"0 auto",padding:"0 0 32px",background:"#040e20",minHeight:"100vh",color:"#e8f4fd",fontFamily:"-apple-system,BlinkMacSystemFont,sans-serif"}}>
        <div style={{display:"flex",alignItems:"center",justifyContent:"space-between",padding:"calc(16px + env(safe-area-inset-top, 0px)) 16px 10px"}}>
          {!hideBackButton && <button onClick={()=>{ if (returnTo) { window.location.href = returnTo; } else { setView("list"); } }} style={{background:"none",border:"none",color:"#7dd3fc",fontSize:22,cursor:"pointer"}}>←</button>}
          {hideBackButton && <button onClick={()=>{ if (returnTo) { window.location.href = returnTo; } else { setView("list"); } }} style={{background:"rgba(255,255,255,0.06)",border:"1px solid rgba(255,255,255,0.1)",borderRadius:20,padding:"6px 14px",color:"rgba(232,244,253,0.6)",fontSize:13,cursor:"pointer"}}>✕ Liste</button>}
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
                const blob = new Blob([igc], { type: "text/plain" });
                const url = URL.createObjectURL(blob);
                const a = document.createElement("a");
                a.href = url; a.download=(fl.name||"flug")+".igc";
                document.body.appendChild(a); a.click(); document.body.removeChild(a);
                setTimeout(() => URL.revokeObjectURL(url), 1000);
              }}
              style={{background:"rgba(245,158,11,0.15)",border:"1px solid rgba(245,158,11,0.3)",borderRadius:20,padding:"5px 10px",color:"#fcd34d",fontSize:12,cursor:"pointer"}}>⬇ IGC</button>
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
                style={{background:"rgba(34,197,94,0.15)",border:"1px solid rgba(34,197,94,0.3)",borderRadius:20,padding:"5px 10px",color:"#4ade80",fontSize:12,cursor:"pointer"}}>⬇ GPX</button>
            )}
            {fl.track?.length>1 && (
              <button onClick={()=>setConfirmDeleteTrack(true)}
                title="IGC-Track löschen (Start/Landung bleiben erhalten)"
                style={{background:"rgba(239,68,68,0.08)",border:"1px solid rgba(239,68,68,0.2)",borderRadius:20,padding:"5px 10px",color:"rgba(248,113,113,0.85)",fontSize:12,cursor:"pointer"}}>🗑 IGC</button>
            )}
            <button onClick={()=>setConfirmDelete(fl.id)}
              style={{background:"rgba(239,68,68,0.12)",border:"1px solid rgba(239,68,68,0.25)",borderRadius:20,padding:"5px 10px",color:"#f87171",fontSize:12,cursor:"pointer"}}>🗑</button>
            <button onClick={()=>window.location.href="hilfe.html"} title="Hilfe"
              style={{width:28,height:28,borderRadius:"50%",background:"rgba(255,255,255,0.06)",border:"1px solid rgba(255,255,255,0.12)",color:"#ef4444",fontSize:13,fontWeight:900,display:"flex",alignItems:"center",justifyContent:"center",cursor:"pointer",flexShrink:0}}>
              ?
            </button>
          </div>
        </div>

        <div style={{padding:"0 16px"}}>
          {/* Title row */}
          <div style={{display:"flex",alignItems:"center",justifyContent:"space-between",marginBottom:2}}>
            <span style={{fontSize:11,color:"#7dd3fc"}}>{fl.date}</span>
            <div style={{display:"flex",gap:4}}>
              {fl.pdfOnly&&<span style={{background:"rgba(139,92,246,0.2)",color:"#c4b5fd",borderRadius:20,padding:"2px 10px",fontSize:10,fontWeight:700}}>CSV</span>}
            </div>
          </div>
          <EditableTitle value={fl.name} onSave={v=>saveField({name:v})} />
          <div style={{fontSize:13,color:"rgba(232,244,253,0.5)",marginBottom:12}}>{fl.startTime}{fl.endTime?" – "+fl.endTime:""}</div>

          {/* Rating inline */}
          <div style={{display:"flex",gap:6,marginBottom:14,alignItems:"center",justifyContent:"space-between"}}>
            <div style={{display:"flex",gap:6}}>
              {[1,2,3,4,5].map(s=>(
                <span key={s} onClick={()=>saveField({rating: (fl.rating||0)===s ? 0 : s})}
                  style={{fontSize:24,cursor:"pointer",color:s<=(fl.rating||0)?"#f59e0b":"rgba(232,244,253,0.2)"}}>★</span>
              ))}
            </div>
            {fl.track?.length>1&&<span style={{background:"rgba(245,158,11,0.18)",color:"#fcd34d",borderRadius:20,padding:"2px 10px",fontSize:10,fontWeight:700,flexShrink:0}}>IGC</span>}
            <button onClick={()=>window.open("https://www.xcontest.org/world/en/my-flights/","_blank")}
              title="XContest — Meine Flüge"
              style={{background:"rgba(65,105,225,0.18)",border:"1px solid rgba(65,105,225,0.4)",color:"#4169e1",borderRadius:20,padding:"2px 10px",fontSize:10,fontWeight:700,flexShrink:0,cursor:"pointer"}}>
              XContest
            </button>
          </div>

          {/* Notizen — kein Feld-Label mehr, Text über die volle Breite und linksbündig (statt des generischen label:value-Rechts-Layouts von InlineField). */}
          <div style={{background:"rgba(255,255,255,0.04)",borderRadius:14,padding:"13px 15px",marginBottom:14,border:"1px solid rgba(255,255,255,0.06)"}}>
            <div style={{fontSize:10,fontWeight:700,color:"rgba(232,244,253,0.4)",letterSpacing:1.5,textTransform:"uppercase",marginBottom:9}}>Notizen</div>
            {notesEditing ? (
              <textarea value={notesVal} onChange={e=>setNotesVal(e.target.value)} onBlur={commitNotes} autoFocus
                style={{width:"100%",background:"rgba(255,255,255,0.08)",border:"1px solid rgba(125,211,252,0.4)",borderRadius:8,padding:"8px 10px",color:"#e8f4fd",fontSize:13,resize:"vertical",minHeight:60,textAlign:"left",boxSizing:"border-box"}} />
            ) : (
              <div onClick={()=>{setNotesVal(fl.notes||"");setNotesEditing(true);}}
                style={{width:"100%",fontSize:13,fontWeight:500,color:fl.notes?"#e8f4fd":"rgba(232,244,253,0.25)",cursor:"pointer",textAlign:"left",whiteSpace:"pre-wrap",minHeight:20,lineHeight:1.5}}>
                {fl.notes || "Notiz hinzufügen…"}
              </div>
            )}
          </div>

          {/* Swipe hint (replaces the old prev/next arrow buttons — navigation is now via touch swipe on this view) */}
          <div style={{textAlign:"center",fontSize:11,color:"rgba(232,244,253,0.3)",marginBottom:10}}>
            ‹ wischen ›
          </div>

          {/* Map */}
          <div style={{borderRadius:14,marginBottom:14,border:"1px solid rgba(100,180,255,0.12)"}}><FlightMap flight={fl} highlightRange={profileRange} onPlaybackPositionChange={setPlaybackDistance} onPlaybackActiveChange={setIsPlaybackActive} /></div>
          <FlightProfile flight={fl} onPositionChange={setProfileRange} playbackDistanceKm={playbackDistance} isPlaybackActive={isPlaybackActive} />

          {/* Stats grid — each of the 9 tiles shows a user-chosen field
              (persisted globally, not per-flight). Tapping a tile opens a
              picker to reassign that slot to any Flugdaten field. */}
          <div style={{display:"grid",gridTemplateColumns:"1fr 1fr 1fr",gap:8,marginBottom:14}}>
            {tileConfig.map((key, i) => {
              const opt = TILE_FIELD_OPTIONS.find(o=>o.key===key) || TILE_FIELD_OPTIONS[0];
              return (
                <div key={i} onClick={()=>setTilePickerIdx(i)}
                  style={{background:"rgba(255,255,255,0.05)",borderRadius:10,padding:"7px 6px",textAlign:"center",border:"1px solid rgba(255,255,255,0.06)",cursor:"pointer"}}>
                  <div style={{fontSize:12,marginBottom:1}}>{opt.icon}</div>
                  <div style={{fontSize:14,fontWeight:800,color:"#7dd3fc"}}>{opt.get(fl)}</div>
                  <div style={{fontSize:8,color:"rgba(232,244,253,0.4)",marginTop:1,textTransform:"uppercase",letterSpacing:0.4}}>{opt.label}</div>
                </div>
              );
            })}
          </div>

          {tilePickerIdx !== null && (
            <div onClick={()=>setTilePickerIdx(null)}
              style={{position:"fixed",inset:0,background:"rgba(0,0,0,0.6)",zIndex:250,display:"flex",alignItems:"flex-end",justifyContent:"center"}}>
              <div onClick={e=>e.stopPropagation()}
                style={{background:"#14253a",borderTopLeftRadius:18,borderTopRightRadius:18,padding:"16px 18px calc(20px + env(safe-area-inset-bottom, 0px))",maxWidth:480,width:"100%",maxHeight:"75vh",overflowY:"auto",border:"1px solid rgba(255,255,255,0.1)"}}>
                <div style={{fontSize:14,fontWeight:700,marginBottom:10}}>Kachel {tilePickerIdx+1}: Feld wählen</div>
                <div style={{display:"flex",flexDirection:"column",gap:4}}>
                  {TILE_FIELD_OPTIONS.map(opt => (
                    <button key={opt.key}
                      onClick={()=>{
                        const next = [...tileConfig]; next[tilePickerIdx] = opt.key;
                        saveTileConfig(next); setTilePickerIdx(null);
                      }}
                      style={{display:"flex",alignItems:"center",gap:10,textAlign:"left",background:tileConfig[tilePickerIdx]===opt.key?"rgba(125,211,252,0.15)":"transparent",border:"1px solid "+(tileConfig[tilePickerIdx]===opt.key?"rgba(125,211,252,0.35)":"rgba(255,255,255,0.06)"),borderRadius:10,padding:"9px 12px",color:"#e8f4fd",fontSize:13,cursor:"pointer"}}>
                      <span style={{fontSize:15}}>{opt.icon}</span>
                      <span style={{flex:1}}>{opt.label}</span>
                      <span style={{color:"rgba(232,244,253,0.4)",fontSize:12}}>{opt.get(fl)}</span>
                    </button>
                  ))}
                </div>
              </div>
            </div>
          )}

          {/* Koordinaten-Badges */}
          <div style={{display:"grid",gridTemplateColumns:"1fr 1fr",gap:8,marginBottom:14}}>
            <div style={{background:"rgba(34,197,94,0.07)",borderRadius:12,padding:"10px",border:"1px solid rgba(34,197,94,0.18)"}}>
              <div style={{fontSize:9,fontWeight:700,color:"#4ade80",letterSpacing:1.2,textTransform:"uppercase",marginBottom:5}}>📍 Start</div>
              <CoordEdit
                lat={fl.startPt?.lat} lon={fl.startPt?.lon} alt={fl.startAlt}
                color="#4ade80"
                onSave={(lat,lon,alt)=>{
                  // lat/lon coming back as null means the person explicitly
                  // cleared the field — that must actually remove the point,
                  // not silently fall back to the previous value.
                  const sp = (lat!=null && lon!=null) ? {lat,lon,gpsAlt:alt||0} : null;
                  saveComputedField(fl, {startPt:sp, startAlt:alt||0});
                }} />
            </div>
            <div style={{background:"rgba(239,68,68,0.07)",borderRadius:12,padding:"10px",border:"1px solid rgba(239,68,68,0.18)"}}>
              <div style={{fontSize:9,fontWeight:700,color:"#f87171",letterSpacing:1.2,textTransform:"uppercase",marginBottom:5}}>🏁 Landung</div>
              <CoordEdit
                lat={fl.endPt?.lat} lon={fl.endPt?.lon} alt={fl.endAlt}
                color="#f87171"
                onSave={(lat,lon,alt)=>{
                  const ep = (lat!=null && lon!=null) ? {lat,lon,gpsAlt:alt||0} : null;
                  saveComputedField(fl, {endPt:ep, endAlt:alt||0});
                }} />
            </div>
          </div>

          {/* Editierbare Felder */}
          <div id="flugdaten-section" style={{background:"rgba(255,255,255,0.04)",borderRadius:14,padding:"13px 15px",marginBottom:11,border:"1px solid rgba(255,255,255,0.06)"}}>
            <div style={{fontSize:10,fontWeight:700,color:"#7dd3fc",letterSpacing:1.5,textTransform:"uppercase",marginBottom:9}}>Flugdaten</div>
            <InlineField label="Datum" value={fl.date} onSave={saveDateField} />
            <SchirmSelect value={fl.glider} onSave={v=>saveField({glider:v})}
              extra={(!fl.customFields?.typ && !typRevealed) ? (
                <span onClick={(e)=>{ e.stopPropagation(); setTypRevealed(true); }}
                  style={{fontSize:11,color:"rgba(232,244,253,0.25)",cursor:"pointer"}}>
                  + Typ
                </span>
              ) : null} />
            {(fl.customFields?.typ || typRevealed) && (
              <div style={{display:"flex",alignItems:"center",gap:6}}>
                <div style={{flex:1,minWidth:0}}>
                  <InlineField label="Typ" value={fl.customFields?.typ||""} onSave={v=>saveField({customFields:{typ:v}})} />
                </div>
                {!fl.customFields?.typ && (
                  <span onClick={()=>setTypRevealed(false)}
                    style={{fontSize:13,color:"rgba(232,244,253,0.25)",cursor:"pointer",padding:"0 2px"}}>
                    ✕
                  </span>
                )}
              </div>
            )}
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
            <InlineField label="Distanz"     value={getDisplayDistance(fl)} onSave={v=>saveComputedField(fl,{totalDist:parseFloat(v)||0,customFields:{distKm:v}})} unit="km" />
            <StaticField label="Dauer"       value={fl.durationStr} />
            <StaticField label="H.Diff."     value={fl.customFields?.hDiff} unit="m" />
            <InlineField label="Ø Speed"     value={fl.customFields?.kmh}           onSave={v=>saveField({customFields:{kmh:v}})} unit="km/h" />
            <InlineField label="Max.Steigen" value={fl.customFields?.maxSteigen}    onSave={v=>saveField({customFields:{maxSteigen:v}})} unit="m/s" />
            <InlineField label="Max.Sinken"  value={fl.customFields?.maxSinken}     onSave={v=>saveField({customFields:{maxSinken:v}})} unit="m/s" />
            <InlineField label="H.Gew."      value={fl.customFields?.hGew}          onSave={v=>saveField({customFields:{hGew:v}})} unit="m" />
            <StaticField label="Entf. S-L"   value={fl.entfernungSL!=null?String(fl.entfernungSL):""} unit="km" />
            <StaticField label="Rang Dauer"  value={fl.rangDauer!=null?`${fl.rangDauer} / ${flights.length}`:""} />
            <StaticField label="% Dauer"     value={fl.pctDauer!=null?String(fl.pctDauer):""} unit="%" />
            <StaticField label="Rang Strecke" value={fl.rangStrecke!=null?`${fl.rangStrecke} / ${flights.length}`:""} />
            <StaticField label="% Strecke"   value={fl.pctStrecke!=null?String(fl.pctStrecke):""} unit="%" />
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
    <div style={{width:"clamp(340px, 22vw, 440px)",minWidth:340,height:"100vh",overflowY:"auto",borderRight:"1px solid rgba(255,255,255,0.08)",background:"#040e20",fontFamily:"-apple-system,BlinkMacSystemFont,sans-serif"}}>
      <div style={{padding:"calc(14px + env(safe-area-inset-top, 0px)) 14px 8px",position:"sticky",top:0,background:"#040e20",zIndex:5,borderBottom:"1px solid rgba(255,255,255,0.06)"}}>
        <div style={{marginBottom:6}}>
          <SearchBar filterText={filterText} setFilterText={setFilterText} />
        </div>
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
        {f.rating>0 && <span style={{fontSize:11}}><span style={{color:"#fde047"}}>{f.rating}</span><span style={{fontSize:"0.85em"}}>⭐️</span></span>}
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

// Lets the person choose exactly which of the 25 possible columns get
// included when copying flights to the clipboard, and in what order —
// so the copied table's columns can be made to match whatever external
// spreadsheet template they're pasting into. Saved via window.storage
// (see FlugbuchApp), so it's picked up automatically by the app's generic
// backup export/import too, without needing any special-casing there.
function CsvColumnConfigModal({ columns, onSave, onClose }) {
  const [local, setLocal] = useState(columns);
  const toggle = (key) => setLocal(cols => cols.map(c => c.key===key ? {...c, enabled: !c.enabled} : c));
  const move = (idx, dir) => setLocal(cols => {
    const next = [...cols];
    const j = idx + dir;
    if (j < 0 || j >= next.length) return cols;
    [next[idx], next[j]] = [next[j], next[idx]];
    return next;
  });
  const labelFor = key => CSV_COLUMN_DEFS.find(c=>c.key===key)?.label || key;
  return (
    <div onClick={onClose} style={{position:"fixed",inset:0,background:"rgba(0,0,0,0.6)",zIndex:300,display:"flex",alignItems:"center",justifyContent:"center",padding:16}}>
      <div onClick={e=>e.stopPropagation()}
        style={{background:"#0a1628",borderRadius:16,padding:"18px 16px",maxWidth:400,width:"100%",border:"1px solid rgba(255,255,255,0.1)",maxHeight:"85vh",display:"flex",flexDirection:"column"}}>
        <div style={{fontSize:15,fontWeight:800,marginBottom:4}}>Spalten für "Kopieren"</div>
        <div style={{fontSize:12,color:"rgba(232,244,253,0.5)",marginBottom:14}}>Auswählen und mit ↑/↓ in die gewünschte Reihenfolge bringen, passend zur Ziel-Tabelle.</div>
        <div style={{overflowY:"auto",display:"flex",flexDirection:"column",gap:4}}>
          {local.map((c, idx) => (
            <div key={c.key} style={{display:"flex",alignItems:"center",gap:8,padding:"7px 8px",borderRadius:8,background:c.enabled?"rgba(34,197,94,0.08)":"rgba(255,255,255,0.03)"}}>
              <div onClick={()=>toggle(c.key)}
                style={{width:20,height:20,borderRadius:6,border:`2px solid ${c.enabled?"#4ade80":"rgba(232,244,253,0.3)"}`,background:c.enabled?"#4ade80":"transparent",display:"flex",alignItems:"center",justifyContent:"center",cursor:"pointer",flexShrink:0}}>
                {c.enabled && <span style={{color:"#0a1628",fontSize:13,fontWeight:900}}>✓</span>}
              </div>
              <span style={{flex:1,fontSize:13,color:c.enabled?"#e8f4fd":"rgba(232,244,253,0.4)"}}>{labelFor(c.key)}</span>
              <button onClick={()=>move(idx,-1)} disabled={idx===0}
                style={{background:"rgba(255,255,255,0.06)",border:"none",borderRadius:6,width:26,height:26,color:idx===0?"rgba(232,244,253,0.2)":"#e8f4fd",fontSize:13,cursor:idx===0?"default":"pointer"}}>▲</button>
              <button onClick={()=>move(idx,1)} disabled={idx===local.length-1}
                style={{background:"rgba(255,255,255,0.06)",border:"none",borderRadius:6,width:26,height:26,color:idx===local.length-1?"rgba(232,244,253,0.2)":"#e8f4fd",fontSize:13,cursor:idx===local.length-1?"default":"pointer"}}>▼</button>
            </div>
          ))}
        </div>
        <div style={{display:"flex",gap:8,marginTop:16}}>
          <button onClick={()=>setLocal(CSV_COLUMN_DEFS.map(c => ({ key: c.key, enabled: true })))}
            style={{flex:1,background:"rgba(255,255,255,0.08)",border:"1px solid rgba(255,255,255,0.12)",borderRadius:10,padding:"9px",color:"rgba(232,244,253,0.7)",fontSize:13,cursor:"pointer"}}>
            Zurücksetzen
          </button>
          <button onClick={()=>{ onSave(local); onClose(); }}
            style={{flex:1,background:"linear-gradient(135deg,#22c55e,#16a34a)",color:"#fff",border:"none",borderRadius:10,padding:9,fontSize:13,fontWeight:800,cursor:"pointer"}}>
            Speichern
          </button>
        </div>
      </div>
    </div>
  );
}

function DateAmbiguousResolver({ item, onAssign, onCreateNew, onClose }) {
  return (
    <div onClick={onClose} style={{position:"fixed",inset:0,background:"rgba(0,0,0,0.6)",zIndex:300,display:"flex",alignItems:"center",justifyContent:"center",padding:16}}>
      <div onClick={e=>e.stopPropagation()}
        style={{background:"#0a1628",borderRadius:16,padding:"18px 16px",maxWidth:380,width:"100%",border:"1px solid rgba(255,255,255,0.1)"}}>
        <div style={{fontSize:15,fontWeight:800,marginBottom:6}}>Welchem Flug zuordnen?</div>
        <div style={{fontSize:12,color:"rgba(232,244,253,0.5)",marginBottom:14}}>
          "{item.file.name}" ({item.date}) passt zu keiner Flug-Nr., aber es gibt mehrere Flüge an diesem Datum ohne GPS-Track.
        </div>
        <div style={{display:"flex",flexDirection:"column",gap:6,marginBottom:12,maxHeight:"40vh",overflowY:"auto"}}>
          {item.candidates.map(c => (
            <button key={c.id} onClick={()=>onAssign(c)}
              style={{textAlign:"left",background:"rgba(255,255,255,0.06)",border:"1px solid rgba(255,255,255,0.12)",borderRadius:10,padding:"10px 12px",color:"#e8f4fd",fontSize:13,cursor:"pointer"}}>
              <b>{c.name}</b>{c.site ? " · "+c.site : ""}{c.startTime ? " · "+c.startTime : ""}
            </button>
          ))}
        </div>
        <button onClick={onCreateNew}
          style={{width:"100%",background:"rgba(34,197,94,0.15)",border:"1px solid rgba(34,197,94,0.3)",borderRadius:10,padding:"9px",color:"#4ade80",fontSize:13,fontWeight:700,cursor:"pointer"}}>
          + Stattdessen neuen Flug anlegen
        </button>
      </div>
    </div>
  );
}

function FlugbuchApp() {
  const isWide = useIsWide();
  const [flights, setFlights] = useState([]);
  // Derived once whenever the flight list changes — rangDauer/pctDauer,
  // rangStrecke/pctStrecke, and entfernungSL need every flight to compute
  // (rank relative to the others), so they're precomputed here rather than
  // in the per-flight sort/search helpers, then used everywhere in place of
  // the raw `flights` for display/search/sort/detail. Kept as a separate
  // array (not stored back into `flights`/persisted) since these are purely
  // derived, not real saved data.
  const flightsWithRanks = useMemo(() => attachComputedRanks(flights), [flights]);
  const [selected, setSelected] = useState(null);
  const [view, setView] = useState("list"); // list|detail|edit|season
  const [importing, setImporting] = useState(false);
  const [importProgress, setImportProgress] = useState(null);
  const [igcResult, setIgcResult] = useState(null);
  const [dragOver, setDragOver] = useState(false);
  const [pdfDragOver, setPdfDragOver] = useState(false);
  const [pdfResult, setPdfResult] = useState(null);
  const [pendingDups, setPendingDups] = useState([]);
  const [dupWarning, setDupWarning] = useState(null);
  // Queue of IGC files that matched no flight by filename, but matched
  // MULTIPLE existing (track-less) flights by date — resolved one at a
  // time via a picker rather than guessing which flight each belongs to.
  const [pendingDateAmbiguous, setPendingDateAmbiguous] = useState([]); // [{file, date, candidates}]
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
  const [csvColumns, setCsvColumns] = useState(
    CSV_COLUMN_DEFS.map(c => ({ key: c.key, enabled: true }))
  );
  const [showCsvColumnConfig, setShowCsvColumnConfig] = useState(false);
  useEffect(() => {
    (async () => {
      try {
        const r = await window.storage.get("csvColumnConfig");
        if (r) {
          const saved = JSON.parse(r.value);
          // Merge with the full column list so a newly-added column (from
          // an app update) still shows up even in an old saved config,
          // appended at the end rather than silently missing.
          const savedKeys = new Set(saved.map(c => c.key));
          const merged = [...saved, ...CSV_COLUMN_DEFS.filter(c => !savedKeys.has(c.key)).map(c => ({ key: c.key, enabled: true }))];
          setCsvColumns(merged);
        }
      } catch (e) { console.error("Load error (csvColumnConfig):", e); }
    })();
  }, []);
  const saveCsvColumns = async (next) => {
    setCsvColumns(next);
    try { await window.storage.set("csvColumnConfig", JSON.stringify(next)); } catch (e) { console.error("Save error (csvColumnConfig):", e); }
  };
  const [selectedIds, setSelectedIds] = useState(new Set());
  const [confirmBulkDelete, setConfirmBulkDelete] = useState(false);
  const [bulkEditOpen, setBulkEditOpen] = useState(false);
  const [bulkEditData, setBulkEditData] = useState({});
  const [reisenNames, setReisenNames] = useState([]);
  // When arriving here via a flight opened from Statistik or Reisen
  // (?openFlightId=...&returnTo=...), the back button in the detail view
  // should return to that exact page instead of this app's own list.
  const [returnTo, setReturnTo] = useState(null);
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
        const params = new URLSearchParams(window.location.search);
        const openId = params.get("openFlightId");
        const ret = params.get("returnTo");
        if (openId) {
          const target = sorted.find(f => String(f.id) === openId);
          if (target) {
            setSelected(target);
            setView("detail");
            if (ret) setReturnTo(ret);
          }
        }
      } catch {}
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
    let serviceData = {}, reisenData = {}, notesData = "";
    try {
      const keys = await window.storage.list("");
      for (const k of (keys?.keys || [])) {
        if (k.startsWith("service:")) {
          const r = await window.storage.get(k);
          if (r) { try { serviceData[k] = JSON.parse(r.value); } catch {} }
        } else if (k.startsWith("reisen:")) {
          const r = await window.storage.get(k);
          if (r) { try { reisenData[k] = JSON.parse(r.value); } catch {} }
        } else if (k === "settings:notes") {
          const r = await window.storage.get(k);
          if (r) notesData = r.value || "";
        }
      }
    } catch (e) { console.error("Backup: error collecting service/reisen data:", e); }

    const payload = {
      exportedAt: new Date().toISOString(),
      flights,
      customFieldDefs,
      service: serviceData,
      reisen: reisenData,
      notes: notesData,
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
      if (typeof data.notes === "string" && data.notes) {
        await window.storage.set("settings:notes", data.notes);
        restoredExtras++;
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
          typ: p.ty || f.customFields?.typ || "",
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

  // Was previously its own separate implementation (inline LV03 conversion,
  // its own column-index mapping, etc.) that had quietly drifted from the
  // Zellen (row-paste) import's parseSingleRow — e.g. the "sl" field read a
  // different column in each. Both now go through the exact same per-row
  // parser, so a CSV file and pasting the same rows by hand always produce
  // identical results, and any future fix only has to happen once.
  // Recognised header-name variants per field — matched case-insensitively
  // after trimming, so a CSV exported from a different app/spreadsheet with
  // its own column order and slightly different labels can still be read,
  // rather than requiring the exact 53-column layout this app's own
  // spreadsheet template uses.
  const FIELD_ALIASES = {
    nr: ["nr", "nr.", "nummer", "flug", "flug nr", "flugnummer", "#", "flight", "flight nr"],
    datum: ["datum", "date"],
    startzeit: ["startzeit", "start", "abflug", "start time", "zeit start", "starttime"],
    startplatz: ["startplatz", "startort", "start ort", "ort start", "site", "launch", "takeoff"],
    startlat: ["start lat", "startlat", "start latitude", "s-lat", "slat"],
    startlon: ["start lon", "startlon", "start longitude", "s-lon", "slon"],
    landezeit: ["landezeit", "landung zeit", "ankunft", "land time", "zeit landung", "landtime", "endtime", "end time"],
    landeplatz: ["landeplatz", "landung", "landort", "land ort", "ort landung", "landing"],
    landlat: ["land lat", "landlat", "l-lat", "llat"],
    landlon: ["land lon", "landlon", "l-lon", "llon"],
    dauer: ["dauer", "duration", "flugzeit", "flight time"],
    distanz: ["distanz", "distance", "km", "strecke"],
    kmh: ["km/h", "kmh", "geschwindigkeit", "speed", "ø speed", "avg speed"],
    hdiff: ["h.diff", "hdiff", "höhendifferenz", "h diff", "altitude diff"],
    maxsteigen: ["max.steigen", "maxsteigen", "steigen", "climb", "max climb"],
    maxsinken: ["max.sinken", "maxsinken", "sinken", "sink", "max sink"],
    hmax: ["h.max", "hmax", "max höhe", "maxhöhe", "höhe max", "max altitude", "max alt"],
    hgew: ["h.gew", "hgew", "höhengewinn", "gewinn", "altitude gain"],
    geraet: ["gerät", "geraet", "schirm", "glider", "wing"],
    passagier: ["passagier", "passenger", "biplace", "passagiere"],
    bemerkung: ["bemerkung", "notiz", "notizen", "comment", "comments", "remarks", "notes"],
    typ: ["typ", "type", "schirmtyp", "kategorie", "category"],
  };
  // Given a header row's cells, returns { fieldKey: columnIndex } for every
  // recognised column, or null if too few fields were recognised to be
  // confident this is actually a header row (vs. a data row that happens
  // to start with text).
  const detectHeaderMapping = (headerCols) => {
    const mapping = {};
    headerCols.forEach((cell, idx) => {
      const norm = String(cell||"").trim().toLowerCase();
      if (!norm) return;
      for (const [field, aliases] of Object.entries(FIELD_ALIASES)) {
        if (mapping[field] !== undefined) continue; // first match wins
        if (aliases.includes(norm)) { mapping[field] = idx; break; }
      }
    });
    // Require at least a date and one location field to trust this as a
    // real header — otherwise a data row with an unlucky text-only first
    // cell could be misread as a header and silently drop a flight.
    if (mapping.datum === undefined) return null;
    if (mapping.startplatz === undefined && mapping.landeplatz === undefined) return null;
    return mapping;
  };
  // Extracts one row's data using a previously detected header mapping,
  // in the same { d, sz, lz, st, la, ... } shape parseSingleRow produces,
  // so both feed into the exact same downstream flight-creation code.
  const parseRowWithMapping = (cols, mapping) => {
    const get = key => mapping[key] !== undefined ? (cols[mapping[key]]||"").trim() : "";
    const s = coordsToWgs84(get("startlat"), get("startlon"));
    const l = coordsToWgs84(get("landlat"), get("landlon"));
    return {
      d: get("datum"), sz: get("startzeit"), lz: get("landezeit"),
      st: get("startplatz"), la: get("landeplatz"),
      sLat: s.lat, sLon: s.lon, lLat: l.lat, lLon: l.lon,
      dur: get("dauer"), dk: get("distanz"), kmh: get("kmh"), hd: get("hdiff"),
      msa: get("maxsteigen"), ml: get("maxsinken"), hm: get("hmax"), hg: get("hgew"),
      ge: get("geraet"), pa: get("passagier"), be: get("bemerkung"), ty: get("typ"),
      _nr: get("nr"),
    };
  };

  const parseCSV = (text) => {
    const lines = text.split(/\r?\n/).filter(l => l.trim());
    const results = {};
    // Defensive cleanup for a cell that accidentally contains trailing
    // coordinates along with the place name (e.g. "Fiesch, 46.234, 8.123") —
    // kept from the old implementation since real-world pasted data has hit
    // this before; parseSingleRow itself doesn't need this for its normal
    // (clean) inputs, so it's applied only here as a light post-process.
    const cleanLoc = s => { const m=String(s||"").match(/,\s*[-]?\d/); return m?s.slice(0,m.index).trim().replace(/,+$/,"").trim():String(s||"").trim(); };

    // Try header-based mapping first, using whichever separator the first
    // line actually uses (comma is the common case for a real CSV file).
    let headerMapping = null, dataLines = lines, autoNr = 1;
    if (lines.length > 1) {
      const firstCols = splitCsvLine(lines[0]);
      headerMapping = detectHeaderMapping(firstCols);
      if (headerMapping) dataLines = lines.slice(1);
    }

    if (headerMapping) {
      for (const line of dataLines) {
        const cols = splitCsvLine(line).map(c => (c||"").trim().replace(/^"+|"+$/g, ""));
        const p = parseRowWithMapping(cols, headerMapping);
        if (!p.d) continue;
        const nr = p._nr && /^\d+$/.test(p._nr) ? p._nr : String(autoNr);
        autoNr = Math.max(autoNr, +nr + 1);
        results[nr] = { ...p, st: cleanLoc(p.st), la: cleanLoc(p.la) };
      }
      if (Object.keys(results).length) return results;
      // Fell through to no usable rows despite a detected header — try the
      // fixed-position fallback below rather than returning nothing.
    }

    // Fixed-position fallback (this app's own 25-/53-column spreadsheet
    // layout), used whenever no confident header mapping was found above.
    for (const line of lines) {
      let p;
      try { p = parseSingleRow(line); } catch { continue; }
      const nr = (p._nr||"").trim();
      if (!nr || !/^\d+$/.test(nr)) continue;
      if (!p.d) continue;
      results[nr] = { ...p, st: cleanLoc(p.st), la: cleanLoc(p.la) };
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

  // Applies parsed IGC data onto an existing flight (shared by both the
  // filename-match and the date-match paths, so they stay in sync).
  const attachIgcToFlight = useCallback(async (existing, track, date, pilot, glider, passagier, igcData) => {
    const cf = { ...(existing.customFields||{}) };
    if (!(cf.hGew||"").trim() && !isNaN(igcData.totalGain)) cf.hGew = String(igcData.totalGain);
    if (!(cf.passagier||"").trim() && passagier) cf.passagier = passagier;
    if (igcData.hDiff) cf.hDiff = String(igcData.hDiff);
    if (!(cf.maxSteigen||"").trim() && igcData.maxClimb) cf.maxSteigen = String(igcData.maxClimb);
    if (!(cf.maxSinken||"").trim() && igcData.maxSinkRate) cf.maxSinken = String(igcData.maxSinkRate);
    const updated = {
      ...existing, track, customFields: cf,
      pilot: (existing.pilot||"").trim() ? existing.pilot : (pilot||existing.pilot),
      glider: (existing.glider||"").trim() ? existing.glider : (glider||existing.glider),
      maxAlt: existing.maxAlt || igcData.maxAlt,
      minAlt: existing.minAlt || igcData.minAlt,
      startPt: existing.startPt || igcData.startPt,
      endPt: existing.endPt || igcData.endPt,
      startAlt: existing.startAlt || igcData.startAlt,
      endAlt: existing.endAlt || igcData.endAlt,
      durationSec: igcData.durationSec || existing.durationSec,
      durationStr: igcData.durationStr || existing.durationStr,
      startTime: (existing.startTime||"").trim() ? existing.startTime : igcData.startTime,
      endTime: (existing.endTime||"").trim() ? existing.endTime : igcData.endTime,
    };
    await saveFlight(updated);
    setFlights(prev=>prev.map(f=>f.id===updated.id?updated:f));
    if (selected?.id===updated.id) setSelected(updated);
  }, [selected, saveFlight]);

  const processIGCFiles = useCallback(async (igcFiles) => {
    setImporting(true); setImportProgress({done:0,total:igcFiles.length});
    const newFlights = [];
    let updatedCount = 0;
    const dateAmbiguous = [];
    for (let i=0; i<igcFiles.length; i++) {
      const file = igcFiles[i];
      const text = await file.text();
      const { track, date, pilot, glider, passagier, tzOffsetHours } = parseIGC(text);
      const igcData = analyzeIGC(track, tzOffsetHours, date);
      const baseName = file.name.replace(/\.igc$/i,"");
      const existing = flights.find(f=>f.name===baseName);
      // Parse date
      const dateParts = date.split(".");
      let yr="", mo="", dateStr=date;
      if(dateParts.length===3){yr=dateParts[2];mo=dateParts[1];dateStr=date;}
      if (existing) {
        // Re-importing only ever updated the raw track before, so any
        // igcData-derived field that was empty (like H.Gew. after being
        // cleared) never got a chance to be recalculated. Now it fills in
        // anything currently blank, without touching values that are
        // already set (manually or from a previous import).
        await attachIgcToFlight(existing, track, date, pilot, glider, passagier, igcData);
        updatedCount++;
      } else {
        // No filename match — try matching by date instead, but only
        // against flights that don't already have a real track (a flight
        // that's already got GPS data from a previous import shouldn't be
        // silently overwritten just because the date happens to match).
        const dateCandidates = flights.filter(f => f.date===dateStr && (!f.track || f.track.length<=1));
        if (dateCandidates.length === 1) {
          await attachIgcToFlight(dateCandidates[0], track, date, pilot, glider, passagier, igcData);
          updatedCount++;
        } else if (dateCandidates.length > 1) {
          // Ambiguous — don't guess. Resolved via a picker after this loop.
          dateAmbiguous.push({ file, date: dateStr, track, pilot, glider, passagier, igcData, candidates: dateCandidates });
        } else {
          const newF = { id:`igc_${baseName}_${Date.now()}`, name:baseName, pdfOnly:false,
            date:dateStr, rawDate:date, year:yr, month:mo, pilot:pilot||"",site:"",glider:glider||"",
            startTime:"", endTime:"", comment:"", rating:0, notes:"",
            customFields:{passagier:passagier||"",landung:"",
              hGew: igcData.totalGain ? String(igcData.totalGain) : "",
              hDiff: igcData.hDiff ? String(igcData.hDiff) : "",
              maxSteigen: igcData.maxClimb ? String(igcData.maxClimb) : "",
              maxSinken: igcData.maxSinkRate ? String(igcData.maxSinkRate) : ""},
            ...igcData, startPt:igcData.startPt, endPt:igcData.endPt };
          await saveFlight(newF);
          newFlights.push(newF);
        }
      }
      setImportProgress({done:i+1,total:igcFiles.length});
    }
    if (newFlights.length) setFlights(prev=>[...newFlights,...prev].sort((a,b)=>(parseInt((b.name||"").match(/\d+/)?.[0]||"0",10))-(parseInt((a.name||"").match(/\d+/)?.[0]||"0",10))));
    if (dateAmbiguous.length) setPendingDateAmbiguous(dateAmbiguous);
    setIgcResult({ created: newFlights.length, updated: updatedCount, total: igcFiles.length, deferred: dateAmbiguous.length });
    setTimeout(() => setIgcResult(null), 6000);
    setImporting(false); setImportProgress(null);
  }, [flights, selected, saveFlight, attachIgcToFlight]);

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
  const filteredFlights = matchFlights(flightsWithRanks, filterText);
  const years = [...new Set(filteredFlights.map(f=>f.year).filter(Boolean))].sort((a,b)=>b-a);
  const noYear = filteredFlights.filter(f=>!f.year);
  const parseDurForList = s => { if(!s)return 0; const a=s.match(/(\d+):(\d{2}):(\d{2})/); if(a)return+a[1]*3600+ +a[2]*60+ +a[3]; const b=s.match(/(\d+):(\d{2})/); if(b)return+b[1]*60+ +b[2]; const c=s.match(/(\d+)h\s*(\d+)m/); if(c)return+c[1]*3600+ +c[2]*60; return 0; };
  const getDurFlight = f => f.durationSec || parseDurForList(f.durationStr);
  const longestId = flights.length ? flights.reduce((a,b)=>getDurFlight(a)>getDurFlight(b)?a:b).id : null;

  const reiseLabels = useMemo(() => computeReiseLabels(flights, reisenNames), [flights, reisenNames]);
  const enrichedSelected = selected ? (flightsWithRanks.find(f=>f.id===selected.id) || selected) : null;

  if (view==="worldmap") return <WorldMapView flights={flights} selectedIds={selectedIds} onBack={()=>setView("list")} />;

  // ── DETAIL VIEW ─────────────────────────────────────────────────────────
  if (view==="detail" && selected && isWide) {
    return (
      <div style={{display:"flex",height:"100vh",overflow:"hidden",background:"#040e20"}}>
        <SidebarList flights={flights} selectedId={selected.id} longestId={longestId}
          onSelect={f=>{setSelected(f);setInlinePassagier(f.customFields?.passagier||"");}} />
        <div style={{flex:1,minWidth:0,height:"100vh",overflowY:"auto"}}>
          <DetailContent fl={enrichedSelected} flights={flightsWithRanks} customFieldDefs={customFieldDefs}
            setFlights={setFlights} setSelected={setSelected} setView={setView}
            setInlinePassagier={setInlinePassagier} setEditData={setEditData}
            saveFlight={saveFlight} showFieldEditor={showFieldEditor} setShowFieldEditor={setShowFieldEditor}
            handleSaveFields={handleSaveFields} confirmDelete={confirmDelete} setConfirmDelete={setConfirmDelete}
            returnTo={returnTo}
            hideBackButton={true} isWide={true} />
        </div>
      </div>
    );
  }
  if (view==="detail" && selected) {
    return <DetailContent fl={enrichedSelected} flights={flightsWithRanks} customFieldDefs={customFieldDefs}
      setFlights={setFlights} setSelected={setSelected} setView={setView}
      setInlinePassagier={setInlinePassagier} setEditData={setEditData}
      saveFlight={saveFlight} showFieldEditor={showFieldEditor} setShowFieldEditor={setShowFieldEditor}
      handleSaveFields={handleSaveFields} confirmDelete={confirmDelete} setConfirmDelete={setConfirmDelete}
      returnTo={returnTo}
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
    <div style={{maxWidth:isWide?1400:480,margin:"0 auto",minHeight:"100vh",background:"#040e20",color:"#e8f4fd",fontFamily:"-apple-system,BlinkMacSystemFont,sans-serif"}}>
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
        <div style={{display:"flex",gap:6,alignItems:"center",flexShrink:0}}>
          <button onClick={addNewFlight} style={{background:"rgba(34,197,94,0.15)",color:"#4ade80",border:"1px solid rgba(34,197,94,0.25)",borderRadius:20,padding:"7px 10px",fontSize:12,fontWeight:700,cursor:"pointer",whiteSpace:"nowrap"}}>+ Flug</button>
          <button onClick={()=>window.location.href="hilfe.html"} title="Hilfe"
            style={{width:32,height:32,borderRadius:"50%",background:"rgba(255,255,255,0.06)",border:"1px solid rgba(255,255,255,0.12)",color:"#ef4444",fontSize:15,fontWeight:900,display:"flex",alignItems:"center",justifyContent:"center",cursor:"pointer",flexShrink:0}}>
            ?
          </button>
        </div>
      </div>

      {/* Row 2: Import / Backup / Auswahl / Weltkarte / Richtung / Jahr — 6 quadratische Icon-Buttons */}
      <div style={{padding:"10px 16px 0",display:"flex",gap:8}}>
        <button onClick={()=>{ setShowImportMenu(m=>!m); setShowBackupMenu(false); }} title="Import"
          style={{flex:"1 1 0",minWidth:0,aspectRatio:"2/1",boxSizing:"border-box",display:"flex",alignItems:"center",justifyContent:"center",background:showImportMenu?"rgba(56,189,248,0.15)":"rgba(255,255,255,0.05)",border:`1px solid ${showImportMenu?"rgba(56,189,248,0.35)":"rgba(255,255,255,0.1)"}`,borderRadius:10,color:"#fff",fontSize:30,cursor:"pointer"}}>
          📥
        </button>
        <button onClick={()=>{ setShowBackupMenu(m=>!m); setShowImportMenu(false); }} title="Backup"
          style={{flex:"1 1 0",minWidth:0,aspectRatio:"2/1",boxSizing:"border-box",display:"flex",alignItems:"center",justifyContent:"center",background:showBackupMenu?"rgba(56,189,248,0.15)":"rgba(255,255,255,0.05)",border:`1px solid ${showBackupMenu?"rgba(56,189,248,0.35)":"rgba(255,255,255,0.1)"}`,borderRadius:10,color:"#fff",fontSize:30,cursor:"pointer"}}>
          💾
        </button>
        <button onClick={()=>{ setSelectMode(m=>!m); setSelectedIds(new Set()); setCopyMsg(""); }} title="Auswahl"
          style={{flex:"1 1 0",minWidth:0,aspectRatio:"2/1",boxSizing:"border-box",display:"flex",alignItems:"center",justifyContent:"center",background:selectMode?"rgba(14,165,233,0.18)":"rgba(255,255,255,0.05)",border:`1px solid ${selectMode?"rgba(14,165,233,0.4)":"rgba(255,255,255,0.1)"}`,borderRadius:10,color:"#fff",fontSize:34,cursor:"pointer"}}>
          {selectMode?"✕":"☑"}
        </button>
        <button onClick={()=>setView("worldmap")} title="Weltkarte"
          style={{flex:"1 1 0",minWidth:0,aspectRatio:"2/1",boxSizing:"border-box",display:"flex",alignItems:"center",justifyContent:"center",background:"rgba(245,158,11,0.15)",border:"1px solid rgba(245,158,11,0.25)",borderRadius:10,color:"#fff",fontSize:30,cursor:"pointer"}}>
          🗺️
        </button>
        <button onClick={()=>setSortDir(d=>d==="asc"?"desc":"asc")} title={sortDir==="asc"?"Aufsteigend":"Absteigend"}
          style={{flex:"1 1 0",minWidth:0,aspectRatio:"2/1",boxSizing:"border-box",display:"flex",alignItems:"center",justifyContent:"center",background:"rgba(255,255,255,0.05)",border:"1px solid rgba(255,255,255,0.1)",borderRadius:10,color:"#fff",fontSize:30,cursor:"pointer"}}>
          {sortDir==="asc"?"↑":"↓"}
        </button>
        <button onClick={()=>setCollapsedYears(s=>s.size===0?new Set(years):new Set())} title={collapsedYears.size===0?"Alle reduzieren":"Alle erweitern"}
          style={{flex:"1 1 0",minWidth:0,aspectRatio:"2/1",boxSizing:"border-box",display:"flex",alignItems:"center",justifyContent:"center",background:"rgba(255,255,255,0.05)",border:"1px solid rgba(255,255,255,0.1)",borderRadius:10,color:"#fff",fontSize:23,fontWeight:700,letterSpacing:1,cursor:"pointer"}}>
          {collapsedYears.size===0?"⊟⊟":"⊞⊞"}
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

      {showCsvColumnConfig && (
        <CsvColumnConfigModal columns={csvColumns} onSave={saveCsvColumns} onClose={()=>setShowCsvColumnConfig(false)} />
      )}

      {pendingDateAmbiguous.length > 0 && (
        <DateAmbiguousResolver
          item={pendingDateAmbiguous[0]}
          onClose={()=>setPendingDateAmbiguous(q=>q.slice(1))}
          onAssign={async (chosen) => {
            const item = pendingDateAmbiguous[0];
            await attachIgcToFlight(chosen, item.track, item.date, item.pilot, item.glider, item.passagier, item.igcData);
            setPendingDateAmbiguous(q=>q.slice(1));
          }}
          onCreateNew={async () => {
            const item = pendingDateAmbiguous[0];
            const baseName = item.file.name.replace(/\.igc$/i,"");
            const dateParts = item.date.split(".");
            let yr="", mo="";
            if (dateParts.length===3) { yr=dateParts[2]; mo=dateParts[1]; }
            const newF = { id:`igc_${baseName}_${Date.now()}`, name:baseName, pdfOnly:false,
              date:item.date, rawDate:item.date, year:yr, month:mo, pilot:item.pilot||"",site:"",glider:item.glider||"",
              startTime:"", endTime:"", comment:"", rating:0, notes:"",
              customFields:{passagier:item.passagier||"",landung:"",
                hGew: item.igcData.totalGain ? String(item.igcData.totalGain) : "",
                hDiff: item.igcData.hDiff ? String(item.igcData.hDiff) : "",
                maxSteigen: item.igcData.maxClimb ? String(item.igcData.maxClimb) : "",
                maxSinken: item.igcData.maxSinkRate ? String(item.igcData.maxSinkRate) : ""},
              ...item.igcData, startPt:item.igcData.startPt, endPt:item.igcData.endPt };
            await saveFlight(newF);
            setFlights(prev=>[newF,...prev]);
            setPendingDateAmbiguous(q=>q.slice(1));
          }}
        />
      )}

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
              const activeKeys = csvColumns.filter(c=>c.enabled).map(c=>c.key);
              const rowFor = f => buildCsvRow(f, activeKeys);
              const rows = chosen.map(rowFor).join("\r\n");
              try {
                // Numbers (and most spreadsheet apps) only recognise pasted text as a
                // table when it comes with an HTML <table> clipboard representation —
                // plain tab-separated text alone often gets pasted as one blob per cell.
                const escapeHtml = s => String(s).replace(/&/g,"&amp;").replace(/</g,"&lt;").replace(/>/g,"&gt;");
                const cellStyle = "font-family:Helvetica,sans-serif;font-size:10px;font-weight:normal;text-align:left;";
                const htmlTable = `<table style="${cellStyle}">` + chosen.map(f => {
                  const cols = rowFor(f).split("\t");
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
            style={{flex:"1 1 0",minWidth:0,boxSizing:"border-box",background:"rgba(34,197,94,0.15)",border:"1px solid rgba(34,197,94,0.3)",borderRadius:10,padding:"9px 4px",color:"#4ade80",fontSize:13,fontWeight:700,cursor:"pointer",textAlign:"center"}}>
            📋 {selectedIds.size}
          </button>
          <button onClick={()=>setShowCsvColumnConfig(true)} title="Spalten für Kopieren einrichten"
            style={{flexShrink:0,width:40,boxSizing:"border-box",background:"rgba(255,255,255,0.06)",border:"1px solid rgba(255,255,255,0.12)",borderRadius:10,padding:"9px 4px",color:"rgba(232,244,253,0.7)",fontSize:15,cursor:"pointer",textAlign:"center"}}>
            ⚙️
          </button>
          <button onClick={()=>{
              if (!selectedIds.size) { setCopyMsg("Keine Flüge ausgewählt."); return; }
              setBulkEditOpen(true);
            }}
            title="Auswahl bearbeiten"
            style={{flex:"1 1 0",minWidth:0,boxSizing:"border-box",background:"rgba(14,165,233,0.15)",border:"1px solid rgba(14,165,233,0.3)",borderRadius:10,padding:"9px 4px",color:"#7dd3fc",fontSize:13,fontWeight:700,cursor:"pointer",textAlign:"center"}}>
            ✏️ {selectedIds.size}
          </button>
          <button onClick={()=>{
              if (!selectedIds.size) { setCopyMsg("Keine Flüge ausgewählt."); return; }
              setConfirmBulkDelete(true);
            }}
            title="Auswahl löschen"
            style={{flex:"1 1 0",minWidth:0,boxSizing:"border-box",background:"rgba(239,68,68,0.15)",border:"1px solid rgba(239,68,68,0.3)",borderRadius:10,padding:"9px 4px",color:"#f87171",fontSize:13,fontWeight:700,cursor:"pointer",textAlign:"center"}}>
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
            style={{flex:"1 1 0",minWidth:0,boxSizing:"border-box",background:"rgba(245,166,35,0.15)",border:"1px solid rgba(245,166,35,0.3)",borderRadius:10,padding:"9px 4px",color:"#f5a623",fontSize:13,fontWeight:700,cursor:"pointer",textAlign:"center",appearance:"none",WebkitAppearance:"none"}}>
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
      {bulkEditOpen && (() => {
        const chosenCount = selectedIds.size;
        const applyBulkEdit = async () => {
          const d = bulkEditData;
          let updated = flights.map(f => {
            if (!selectedIds.has(f.id)) return f;
            const patch = {};
            if (d.date) patch.date = d.date;
            if (d.site) patch.site = d.site;
            if (d.glider) patch.glider = d.glider;
            if (d.rating) patch.rating = d.rating;
            if (d.notes) patch.notes = d.notes;
            const cfPatch = {};
            if (d.landung) cfPatch.landung = d.landung;
            if (d.passagier) cfPatch.passagier = d.passagier;
            if (d.reise) cfPatch.reise = d.reise;
            return { ...f, ...patch, customFields: { ...(f.customFields||{}), ...cfPatch } };
          });
          // A date change can shift where these flights (and everyone
          // else) fall chronologically, so renumber the whole list rather
          // than just the edited flights.
          if (d.date) updated = renumberAllFlights(updated);
          await Promise.all(updated.map((f, i) => {
            const before = flights[i];
            if (selectedIds.has(f.id) || f.name !== before.name) return saveFlight(f).catch(()=>{});
            return null;
          }));
          setFlights(updated);
          setCopyMsg(`✓ ${chosenCount} Flug${chosenCount!==1?"e":""} aktualisiert.`);
          setBulkEditOpen(false);
          setBulkEditData({});
        };
        const field = (label, key, opts) => (
          <div style={{marginBottom:12}}>
            <div style={{fontSize:11,color:"rgba(232,244,253,0.4)",marginBottom:4}}>{label}</div>
            <input value={bulkEditData[key]||""} onChange={e=>setBulkEditData(d=>({...d,[key]:e.target.value}))}
              placeholder={opts?.placeholder||"unverändert lassen"}
              style={{width:"100%",background:"rgba(255,255,255,0.07)",border:"1px solid rgba(255,255,255,0.12)",borderRadius:10,padding:"10px 13px",color:"#e8f4fd",fontSize:14,boxSizing:"border-box"}} />
          </div>
        );
        return (
          <div onClick={()=>setBulkEditOpen(false)}
            style={{position:"fixed",inset:0,background:"rgba(0,0,0,0.6)",display:"flex",alignItems:"center",justifyContent:"center",zIndex:200,padding:24}}>
            <div onClick={e=>e.stopPropagation()}
              style={{background:"#14253a",borderRadius:16,padding:"20px 22px",maxWidth:380,width:"100%",border:"1px solid rgba(255,255,255,0.1)",maxHeight:"85vh",overflowY:"auto"}}>
              <div style={{fontSize:16,fontWeight:700,marginBottom:4}}>{chosenCount} Flüge bearbeiten</div>
              <div style={{fontSize:12,color:"rgba(232,244,253,0.5)",marginBottom:16}}>Leer gelassene Felder bleiben unverändert. Ausgefüllte Felder werden auf alle {chosenCount} ausgewählten Flüge übertragen.</div>
              {field("Datum (z.B. 24.06.2026)", "date")}
              {field("Startplatz", "site")}
              {field("Landeplatz", "landung")}
              {field("Schirm", "glider")}
              {field("Passagier", "passagier")}
              {field("Reise", "reise", { placeholder: reisenNames.length ? reisenNames.join(", ") : "unverändert lassen" })}
              <div style={{marginBottom:12}}>
                <div style={{fontSize:11,color:"rgba(232,244,253,0.4)",marginBottom:6}}>Bewertung</div>
                <div style={{display:"flex",gap:6}}>
                  {[1,2,3,4,5].map(s=>(
                    <button key={s} onClick={()=>setBulkEditData(d=>({...d,rating:(d.rating||0)===s?0:s}))}
                      style={{fontSize:22,background:"none",border:"none",cursor:"pointer",color:s<=(bulkEditData.rating||0)?"#f59e0b":"rgba(232,244,253,0.2)"}}>★</button>
                  ))}
                  {bulkEditData.rating>0 && <span style={{fontSize:11,color:"rgba(232,244,253,0.4)",alignSelf:"center",marginLeft:6}}>wird auf alle übertragen</span>}
                </div>
              </div>
              <div style={{marginBottom:18}}>
                <div style={{fontSize:11,color:"rgba(232,244,253,0.4)",marginBottom:4}}>Notizen</div>
                <textarea value={bulkEditData.notes||""} onChange={e=>setBulkEditData(d=>({...d,notes:e.target.value}))} rows={2}
                  placeholder="unverändert lassen"
                  style={{width:"100%",background:"rgba(255,255,255,0.07)",border:"1px solid rgba(255,255,255,0.12)",borderRadius:10,padding:"10px 13px",color:"#e8f4fd",fontSize:13,resize:"vertical",boxSizing:"border-box"}} />
              </div>
              <div style={{display:"flex",gap:8}}>
                <button onClick={()=>{setBulkEditOpen(false);setBulkEditData({});}}
                  style={{flex:1,background:"rgba(255,255,255,0.08)",border:"1px solid rgba(255,255,255,0.12)",borderRadius:10,padding:"10px",color:"#e8f4fd",fontSize:14,cursor:"pointer"}}>Abbrechen</button>
                <button onClick={applyBulkEdit}
                  style={{flex:1,background:"linear-gradient(135deg,#0ea5e9,#0284c7)",color:"#fff",border:"none",borderRadius:10,padding:10,fontSize:14,fontWeight:800,cursor:"pointer"}}>Speichern</button>
              </div>
            </div>
          </div>
        );
      })()}
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
      {igcResult && (
        <div style={{margin:"10px 16px 0",background:"rgba(74,222,128,0.1)",border:"1px solid rgba(74,222,128,0.3)",borderRadius:12,padding:"10px 14px",display:"flex",justifyContent:"space-between",alignItems:"center"}}>
          <span style={{fontSize:13,color:"#4ade80"}}>
            ✅ {(igcResult.created>0?igcResult.created+" neu  ":"")}{(igcResult.updated>0?igcResult.updated+" aktualisiert":"")}{(igcResult.deferred>0?"  "+igcResult.deferred+" zur Zuordnung":"")} ({igcResult.total} erkannt)
          </span>
          <button onClick={()=>setIgcResult(null)} style={{background:"none",border:"none",color:"rgba(74,222,128,0.5)",cursor:"pointer",fontSize:16}}>✕</button>
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

      {/* Row 3: Suchen / Sortierung — je exakt halbe Zeilenbreite */}
      <div style={{padding:"12px 16px 6px",position:"relative"}}>
        <div style={{display:"flex",gap:8,alignItems:"flex-start"}}>
          <div style={{flex:"1 1 0",minWidth:0,position:"relative"}}>
            <SearchBar filterText={filterText} setFilterText={setFilterText} />
          </div>
          <button onClick={()=>setShowSortMenu(s=>!s)}
            style={{flex:"1 1 0",minWidth:0,boxSizing:"border-box",display:"flex",justifyContent:"space-between",alignItems:"center",background:"rgba(255,255,255,0.06)",border:"1px solid rgba(255,255,255,0.1)",borderRadius:10,padding:"8px 8px",color:"#fff",fontSize:12,cursor:"pointer"}}>
            <span style={{overflow:"hidden",textOverflow:"ellipsis",whiteSpace:"nowrap"}}>⇅ {SORT_OPTIONS.find(o=>o.id===sortId)?.label||"—"}</span>
            <span style={{flexShrink:0,marginLeft:4}}>{showSortMenu?"▾":"▸"}</span>
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

      {filterText.trim() && (
        <div style={{padding:"0 16px 8px",fontSize:12,color:"rgba(232,244,253,0.45)"}}>
          {filteredFlights.length} Treffer
        </div>
      )}

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
              return sorted.map(f=>(
                <FlightRow key={f.id} f={f} isLongest={f.id===longestId} sortId={sortId} reiseLabel={reiseLabels.get(f.id)} isWide={isWide}
                  selectMode={selectMode} isSelected={selectedIds.has(f.id)}
                  onToggleSelect={id=>setSelectedIds(prev=>{const n=new Set(prev);n.has(id)?n.delete(id):n.add(id);return n;})}
                  onClick={()=>{setSelected(f);setInlinePassagier(f.customFields?.passagier||"");setView("detail");}} />
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
              {!collapsed && (
                yFlights.map(f=>(
                  <FlightRow key={f.id} f={f} isLongest={f.id===longestId} sortId={sortId} reiseLabel={reiseLabels.get(f.id)} isWide={isWide}
                    selectMode={selectMode} isSelected={selectedIds.has(f.id)}
                    onToggleSelect={id=>setSelectedIds(prev=>{const n=new Set(prev);n.has(id)?n.delete(id):n.add(id);return n;})}
                    onClick={()=>{setSelected(f);setInlinePassagier(f.customFields?.passagier||"");setView("detail");}} />
                ))
              )}
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
