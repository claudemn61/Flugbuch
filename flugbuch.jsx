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
// photographed and cropped themselves (see Settings > Schirme). Background
// removed via flood-fill from the image edges, with the white mask eroded
// first to break thin bridges between the true background and enclosed
// white design elements (chevron patterns etc. near notches in the
// silhouette) before labelling connected components — otherwise those
// bridges let the fill leak into the design and erase it too. Chosen
// variant is persisted ("gliderVariant" storage key) and used everywhere
// the glider marker/reference-point icon appears.
const GLIDER_VARIANTS = [
  { id: "v1", label: "Dunkelblau", dataUrl: "data:image/png;base64,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" },
  { id: "v2", label: "Türkis", dataUrl: "data:image/png;base64,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" },
  { id: "v3", label: "Gelb", dataUrl: "data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAKAAAABdCAYAAAAiw23qAAAqdklEQVR42u2daaxl2XXXf2vvc+59941Vr15VdVV3VY9V3bZjJ+7YGWyGCBBRCwlIJBB8BT5BJISChEUQEuRbZCEMioSSSIF8iASKnVgIERNEnLg72G3H6bjTk7vbQw+uoWt84733nL0XH/Zw9rnvvRp6irHukaq7Xt3h3bvP/6z1X//1X/ug8+OujrZtVVX1U5/6lFpr1RijP/dzP9d7bH7c+cF8Ce4efL/6q7+qgBpj1FqrgH7605+eg/BtHKKqyvy47eG9R0S4dOkS58+fZ3t7GxFBVRERqqrihRde4MEHH0RVMcbMF+0Ojvkq3SUAP/OZz7C1tYW1Fu99Btt0OuWXfumXMijnx50d8wh4B0eKctvb25w7d45Lly4hInjvwyKKALC6usorr7zCxsZGfs38mEfAd3w45wD4whe+wMWLFzHGZPAlgBpjuHnzJp///Od7r5kfcwC+8zQRI9lnP/tZROTQyCYifO5znwsLO+eA8xT8bqbfnZ0dzp07x4ULF/ZFwAQ+VWVtbY1XX32VY8eOzdPwPAK+O8UHwDPPPHMo+GbT8NNPP9177fyYA/AdRUCAp5566rapNT32pS99qffa+TEH4Dvmf1/+8pdvC6r02Fe+8pU5D5wD8N2JftZa2rbl2WefvS0AU8p9/vnn2dnZwRgzj4JzAL7z9PvGG2/w2muv3XEEvHTpEt/61rfmaXgOwHcHgC+//DLT6fSOIpq1FlXlpZdemhcicwC+OwB88cUX75jTJc74wgsvzBdwDsB35/jmN7/5vrxmDsD5cWA0uxs+l57z7W9/e14JzwH4zg5rbS5C7haA3/ve92iaZl4JzwH4zvjf9vY2ly9fvmsAXr16levXr88X8jZH9f85TA5CwC2fr0BIrHIbIHkEw/Xr19jcvIE1Evu9t83boLC7u821a1c4cXwD9R45IBUriiDxe8jh77f/H+cAfM9BdaszLRJPgtzhCXsbp04CYC5f2WJ3d3w44A/7/F65cOkmjz1mwJp39lkOv0oO/0y9dfj+Bez77IaZBZcWyyeImLt6J9UG9Q78BO8mqJ+An+LdNPybn4CbgB/HxxvET/G+Qf0UfItqg+gU8Q5VD9pE/ChGDFevXuHJp/4Ig8TP6uNvN/s+kYgJkVME9cqP/cSPc8+p+1AVjBmgpgZTg1jEVIgdIDIEU2PMAKoFxAwRMwAzRMwQYwdgBpj4M6ZCpAIxdwyrsNyav8HBQJUfNABqP4qJ3PJLKqB+inc7+HYXbbZx7TZ+ehOaTVyzhW+30HYbbXfQdg91O+AmqG9R34CfIOpQfPj1fhJALRXgUT9GqBGzAGJQtw1SY8wCYmqc24l+vxFiKtRPsFZYWT2GYFF1qLaIqREM4PHqEbHx+7qQVqUG9ezs3KBppojUgRtqE/7IMABZW1QdGIuoRXGoKIJBxSJiAqilDsAzwwBku4DYEaZaRKpFxC5h6hWkXkWqZUy9gqmXMXYJqUbhuWZ4e4jNRtTbnLPvIwB2YAsnwB74LO8bfLOJm1zDTS7hJ1do9y7ix5fx0+uom+CbLXBj0CnqJuGEiyAIXhuMWMSM4u+cgFnA2FXQBu93ELOIqTZQ3ca7LcQsY6sN1O/i2qsYu4qpjgKOdnIJUy1h7BFEDO30IiJDTBV+du0NvHdgVhCxqNvB+wZjVxGjqJ+g3iFmMQDF74KC2AUEi8gYmCL2CIKgfhf1O5jqKEoNfhvvt7BmFcwIdZuo20LMCGOXwwXnt0BqMIuo20b8HooBGaB+D2GKqgUMShuog1iQAdgasSOwy5jBClV9BAbrmME6driOHR7HDI5iBmsYu3gg1AI8fOSq7z4o3wEAE+hkH+9yvsVPr9LsfBe38zrN7ndptl9HJ1fQ6XW8nxIgpVCtYAdHMYMV3ParGD8GO0SlQrQJqc4sgHpUx4gMQIaoThE/QU2NyCLq90CnYIYgC4gfozoJqSw+X/0YMQsxIjnweyAVIoNABvw4nrwqptFpKA+kDqWCOtAWZBDpQkzbYhFsvPwaUBvTpIuf2yDGxjTo8FSARfCIOFSr+HoPhPdHbPhd2iJmiFKBThFtwQwCKP0EcOFnBNUJoj6AUAHGoIqq7+iFCt4MUT8NMJIKqVaQ4Tp24STV6BR28TR28SzVwskA0IMCivp3BZB3CUBFffiCpdO3bbdotr9Ls/kyzdYrtFuv0I4vARZjB5h6lXrpAczwGFKvhS833EBNhdgVzGiDyeUvsvPSpwOzivxG1cUvZ8L/NPKvvMCa+Vi4FHy3GCLdIiEgimqxVCIFRRByMZpSUKxmy58FCScycVZjwnqg8Tq08UR7wGCMRTGBb4rElFrj/RRUESOBAyJ4t4tIFTngENfeCBepWcBUa7TNVaBFzBK2WsdN3wIajFlB6jXc9BKox1RrgU5MryGmxthFVBu8n4T07R3DMz/DYP3HcDuv4caX0HYTP72G230dP70ZMo/fARlghhtUi6eoVh+jWnmEevEsZnisz4DfARirOwaexhNvbDhXe6+xdfUbTK4/Q7v5MowvozrB+Akyuo+1x36eavkcUi0hZoTYqmMXMXiKOkQsbus77L78y9iQvwLwpEJMHYoMHMIgPtbEkzdAtQV1gGJkGKNPGgYagIQIEhalRsR3j6sB0QxqwUaQaoIXSKH97VNKNGK2e1xFi+pco8wS/ktMZeFtY7qMT9f8xj7+MTG5pILHxuvAgTqMDHAigfvisXYZx+WwNjLAVkdpm8ugglRHET/Gta8j9gh2MGJ88fcZHPsk9fFPUmuZbh3iA/Vx4wu48QV0eo126xV2v/0bGECHx7AL91KtPsrgyAepl89hB2tFRPMHZsW3CUDFewVjMCLQXqG98n+58MZXuXTlRU7ZK9RGMabGVENEKpwus/zYP2dw7OP4to0pwKFNw+yZVEBsxc53fh2a68jwJN6PizRXoewEONilUMXqJKRnswJ+O0ZJEx53WwgOxSBmEfXbCUo5bYOLF6uN0JkUoDERACXEiogpgM7qdt3PoXjQHo/vvQdyyP915u8+fyLRcAEigqgg+Hih+QjIFnwTn+1QHYfXqwFCpW9MjagPaXd4D7L9Z2y/+iusffBf4l2bZ1fCmtRQDahWj1CtfiBgycD4whcZf+tXsG4Hv/VnTG8+w/SNGh1uMDryIVZO/Cis/jDYtbCC3oclu42ycTgA1aNiMEZg/CpvvvoF/uSVr/ONCzd58sIif+cR4dGHl9ltU7SwuHaLwZm/z2D947jJbiG+StbVyve31YjJladorj1NVa8GMq8eZQ9jlgIX8rvhSrbLKLuBlGOQagWdToBdkBqxy+D3UB2jWKwd4XQvyypihqhvM28VqXO13KWPyLvQIuXKHep/JFbbA1TI5HobqeNWYnSoriVeGCGQtvEhKar7+Ft8i7pxCh+o38NTx9eO8W4HUy3TXHua6bWvMTj2E7hmLxYvhAwRf0coihUVWDj5U/jdCzQXfge78CDqt1G3S607fOXFJ3npq3/CT9x3hPNnf5iVU38JRufCJ1aNwVDuDICaSnExSHOZF5/7LL/zta/xxxenvDY5wp4/xmNHdnnigW0mrkLEIbIQqtXF+1k8/TP4tongSyeh2y0g/10MqhOml57EYqI2thwKCxUwC0EPa0MsMGYRr01kfAZjRjipYtVtYmUcyLIRg8goRrTwCjGD8N65CVkF7S/HSJNf34HCZt0vLKKJESiRSYnan8sZR/ZFPVMALP4sfgbTJqfr7l2krzdqB3GNEVIl6Q6ueFUsNkQRJRYeKXCHwiv9rvGF/0V99PFQ8KAz4r7ki0cE1LUsnH6C5vrTiJ8g9gjOTZFqnYfWN/n1107z229OeegbT/Oxk0/zVx79AI+cewKWHo1U2sf3lFv1guP1K4bpxd/lS//7U/zTzz3Nf/3OEd70p1gcLbA2bPmHj+6wXCnerGGoMNUaqGXh5E9jhkdD5RYj3sFjiYHDNTdfwu++gVTDUBWaYbcApgqVXloUUyPxehEMIoOQNlSC5GHqosUmQegV2/0sVb+DIqZ7XEoQpmioUeujSM+S30MwMx0ZyVGTWONL8ZjEFC4iCTlxbQymfA9MF41yQWZ7gnH5O6AUpAWVEPlEKaiOC+skmnmz2AFu+xWaG89i7KDX595fl0oIMMMjDE/8Jdz0Rrg0BBq13Lvg+UePTbCDI3yrvY/f/O5J/snvvsov/rf/wMWX/zO0N2Lh6A83I4RqLmht157/97z1/Gf4tect1809rC9aVgfgtOJHjys/eY9j1y1QVUuBj8kIs3CK4cYngi52Rx0NT3v1a3H5TACVqUNkhFgx2oJ/VeHf8gkyiMaTLhEQCSBieidMRYJ2lk5dUa0lfUtFM2eRskObK/5uxjeBqaOH+yMHkuKZyY9L/jl8Fk0tP2MLsBqgiheZhGgqNgvfkr67zFwYOYKF55bVvmj5GSVHTKue5sqTIYLfpnoVMeAcg41PwGANdbthTfweu67i8bUbfGh1wsDAiaUBLGzwPy5u8Mtf/EO2v/GvGd94DjE2SkI6C8CQxtpmk7f+9BcZXP7vfPXGCV7aOsLRBcWIMKpHLFrDT5911GID7zKDoBEp2NXHMAunAj8Rbhv92t3XaG8+h6lG/asvh2nZR9dllrzP8nuhAFUBuAOek4CJHFQUlJEGDiqDJf0sMz8Xz9GZnqymNC8pWtKl/iJCilTxHVP0rzLYPDaoAWXPWqri95rMtwMQbXExxO5K+q7VEu3mi7jd18PvKGjSQTxVfYsZnqBa+yC43ciZpzhVFpjwV09t0jiHIlQ4TiwZnrxxH1+/eJ32hX/L1qXfjxdfAcC4RyBeJ1x74d+hV59CF9Z56tIS1lYMq4qBtZhqyAOrDR9Zd4ydxUoVKWRYgMH6x+IX11trQQpiDJM3P48210JkQ2dAprkQOBhlOsNZumgmpdZzUJo80MDAAY8d9HMHKJ15jspM+2pfWi8+k5YemAgSTSA2sRrVSOBNpB4auadEamJyZBJs5oRBOShWVKpy4QMINX42M0SaTSaXfy8K5XdSaQn12kfRzI/BiGfXeR4/usvphTFjJ3hNsdbwe5ePY4yw++J/ZPt7/zPzZlXFpLB+89XfwL/1JQaL69ycGN7YGzGqLZWpqKwFKj6y3rBWKS5GqdB+mmIW76Ve+yHUNfur3dnoZ2vane8wvfokxi6EKq4HKiJ51hmNOJF/PQCAGp8umb+VV5lmPW1Wx5PcA+04kzKTUQ90leiBNgvdx3D6PJLY26WXMvPHIFAF6VEFEyOYFIYNW/wuW0S8mCpFOk1SwpCUJq0zFjyJO4pdYPrW7+N2XwNb3briF0G9ozryYczoNPhpDCAGr8KRuuXDR3aZ+PBpncLAKi9tDrg8XWBUD9h99dfZu/Ll3D83IpbdK19l8sZvY4dHGeC5MhlysxkwsIKJX0hQHlmdhmsr8jQkkNPq6IdjKr3djlDhtdO3/gjazRgUNHIdh0+vF2JHoVgM7/a3ATMX8giuVC9BfZfEVBD1gTMWIqmWCC8jVA9Qegsflcz8ky1hPSM/aFGomB4gSxAmfoskt6Apol1Z3KS3sIWvqKjkVWN1a7Ku2FF+n2kAYpDpDaaXnwrKxe0aY77FDNaojn0M75sMJI2Kw4fWplRJElLFotyc1rw1tthKsOLZeeXXaCaXETEY1+6y893fxJpwlVgj/On1ETvOUpkONAPrOLvkcOow2FDReAf1KtXaB6IrRA5pZqfFrdDpJu3150JbSNvi8dSlCJWckDS7VCO6CCATAEbbaW/alfkz/hpK6r0/ZsmMflek0LJvJyUvkllmmR9TyohVFAHSl2VMWThIGbVn0naSwyT0jcNa2Qjiov0lMaqpzBhBBIxB0hobGz+Lz8UOeMQOaW88h063Y8q+XRRU6qMfhWq5yBoG5w33Lk0ZGYcPFRxGYOyFl7YGVCjYITK9xO53fit8pN23nsJvfTPYeoCJtzx3fYQVwYpgDDi1bAz2ODVqaF3SoDzqJtilB7ELJ4Md6paVlGKkpt18CZ2+BabC0xa8SIuFCZE1uTAUDdFROmEhOJa7SOXTVV04mhHBZyG4LBq0E4elW+5Oi9O+dDdzSmaF5f3qnRYRp88jU3Oui1imL0pECabjsqY4yWVFXPLFeAEKaEy55L54AmeMlipRXI6/Wx1IjU6v0tx8Pqbh21h6fUM1uhez/BDet5kaNCrcu6CcHDW4yHPT53rm6iJTNYg6TLVEc+VLjG88ixlf/D/YSEArgc3WcnES3CB7znB9Ijjn+eTGNkOjuBilBI/HUa08FuST23vVURzNjT8lMxZ1IXWmq1JdTptdS0yK6Fic9F7E87FfXHYVZiJioUHJATVuvyNxuJeWXjkzQxalKEZm6uWOo6XUp0URQSHVRHlJJQNUehE7XSIdB5SiaAuvTwVLknfSTq5VjJzBMidi8Li8Gs31Z2InRA7UA7tI78FYqtUP52whYnFeWakafnhtj902xmiBoYXX9yxXp5bKKF4M4ieML3yBSndewdgar4K1nht7hrf2DOuDCefWHPeOGj54VPnIkV12XYWRJvAWdSgOu/jg7ere+IUrdHqdduulYPZ0qc/pi0LCdRHJO7A+Lngye0oHVlxOsoLGRS/43UxKDoVIEenUR85GD7i6r4MhMxDqOr85i/aq4hmZVaRrk6X0ql0hFbiTS+6M+Jk0ft7OJa6FHpe6IbnFqekirDrBV4np2EQ+bLIEEnAV/h5a14LYBdzWy+j0GqY+lilOSaUylYj/t8sP0phhtLVZjDjGvuKvn9rim5vKN7cX2WuFiRem7YArE8vxgdJ4j9ia5sazVDZfAeDUsFwpP/9D1zi3OmV9oAxkjNeKvWaKmhHejxFZwHlHvXaOeuV8kX71EN+YYuyQvc1n0L03McPjuXnu1aPYyFPaIr60uQ8ZMogrWmUanDRlCvQ+J1DRLuVqLKuzhKGdEK4YRPuyolJqidJdACIz5YQeUJcIM14EUlgMTuf0RB/FYbPPFtbpZJpFdy1tY6kC1k7UTgqBjeK1zwbSWMzki9EGFw6+kHqi0cFU+MlF2q2XGW4cR53nsKFJQcB77Og+MIv48bcxgxpxY1pTsVGP+YUPN7y1t8nruzUvblb8ydWacdvnw0YnVI03DGyovpwqR6sdPnF0k6m3TN0qk+o4ZnQvdm2VenQarUbYhdNgF7CjexEzCpap2KVI5b8kD58JRFT9lPGF38VEG5IgXaUqZdM9ukrobFKKRiu8zaQtREstCHzb7wiov+VgUgfe/d3bvtyi+3wrus+/olmD1ANSt5fCY0iUYaTsfBS8MUc0cgpWXOz/mmyETcQfTDCpxhZq4nWSfZMa3TRREsrrEgrJcGHX8blTJm99keHxT3QFSlIctOTOAjrF1OssPPh3mV7+IqKC23sd/JRJcxPxe5yq9zhz1PAX1w3bZ4c4FabO5HOuaqg2dzwnjhimk22wS7D4CNPl8wxWzmOW7qcabiDVajDoSgzcyQLniNYpA75BfRM+Yrsbm+CetrmBxTC59sf4rW9iq5Vc7SZ/W7+HmYoQH0BYgLMfp9oOAqr5uZJjkeu137qRgbKjUipiB/Q7pEhRqcWm2nE2lQI8Jlfo3c9SyDuznFDyZ/Hqe90bTRE7izpJUhJUDF4TIEO/W30bo378ndrGXm2SSHxoR4pBYtEQ+CGdF1I9xlS0N55l+tZXGWw8jnoNtjgjmWqUBb0qDNd/hMH6j0R32B6+3cFPr6GTK7S7rzPefRO39wZmchHrt3GeqP+GyF5NJ1M8S9Sn/jYL9/w16uWHuijftvjpTdz4W/jmeuj/Ta+jvsVPr4B3uHYTcWNUwU8vY+wibnoTdA9jVmmnlzBCmLOwQ7y20XhqwlQbDkOIvngHxkQZxseFN9mFksTicIJ8YRBIul/wqkhxAjtI+VmLbS/Y6SFlkx5WpqigRvqVcjRHKLOtSJlpvRdRNfEySZK1yXpqsrkFXTPRgACWkGhMcFwXHscuMpgc5UTbKBhLTMEaW6iRe9oYDdVhpGL8+m8xvvA5MEtUw5Oo7iLVOqZeC+dlsA6mikNRy6EtWy9jzAgzOIodbSBynmGWDh3t3hu4m8/T3Pg67uZzWN1lbzKkGi0fY/ED/4LqyAdxO5cYX/4D3PYr+L3vBdA1W+GKclsYFvF+E2OW4nzFAKhQ3YPqCLTXoVpBvEd0L0xr2QqDBqeLkxghXGzlNEXLDYQGdJAr5C7qBRnGppSrKSLanomzP+zpYns1QcZFYVZuKTCLmkJjS3LgbMvvYFOppC6NT3RTcoItzQZJQpo1oWYhWpuilWhiqtQsRHeCv4lRuu2c0wWvC9/XZ9E+yVeKhKk7XNEhCRlHTI3RFr/9XVSWcHsX0MmbaH0izOi4TRjch04vIPXRyCunmPoYygRTb4CxmOEGUh/FLJzADE9iR6cY3PsEC/c9Qbv9OpPv/Bf0e1+huvfxf4baJW5+49/gt14Ctx3CuZhoiaqKWYUK41cD8HQYT/IQ7x1GLGqGgdiLCUser8Qwe9tgkhUdhxHBa1fdplRkxHXSQSbPXVGSIoyqx0RiHyhKGyNlJNrqQE2ukplV7LSfTzqBQW9hHZX9I4uxCRsKGtPzCh5cqpRR2XQyhppOlNbEB6Xjs9GPqNnWpNm547M0FkdFKWzx6nKPOEXH5CpSncQAYOMipirch9RbLYc55noJqVcQtxuE7WqI+kGYN3FbIQK318NU3/Qa2u7iRUJxaoJxhWoVs3APduU8g41PsvzBf4Uf/Ccq78Zsv/ALmPYqplqEKubnQqH1gNHghiAWFIgNVnA7yHJKuJqaOLGlGYA9MMUWWyDtgcuJpOvfZaIedL3AXbpqOoUWifqh5oGjJDV0IrD2Ogyqs1Wd5s+RBGhRve1ITVkpa9+B2FuzbMs6ANCdkhcA7JPkkSUkV1wc0fCaAVq0JcUUBVeMeEpct2RymMYUb+OMSRvHOk12VouUTvAqSlyx6NEG1XT+x+Fx36Jeo8g/BTNCvMfIQni8im1DTWZZj7hr+K3L+JvPMHnzdxjc8zdYuu9vUU0u/QGmvYnUa3EM0BcpIwIRH76Aujh0HZrQqVJVugEj8T5woxhPRIouR1mV0RUb4Uubzn2MRWkKbpPaST5LHYGz0BOj+8Kw9qrbXB+rdIaGffMb2pcaemK1HNj/VT3MnpDsKaXEIj0l0RgpxltNoT36wngreCmr3iRJdY7tNBeTUm73czAPoGCo8oimoYorU2aNJndSRNtYdFm8TjJ1URpEFmLhGYerfChevG73geyTeSRmNKkRW4MxWFqaNz+LWItRMTHKuH191CSYSi7dfXFiC+uThLQnJSHO1VuKOomDRSVdJFdoudFeTI4lvtJLjlp2MNy+qX4trACqfQdMN2owuxPAwd2Ow5Kv3qJFIrMuG6T4ldEUm/hcoRFKL5bGCBfTuuaioqiSKX7WvrkgjY1KrHLDbguB85V8UPJ5TVpkqI5NAlHyLGpTFEIeTB1msqUKg0f527iOKuVz7LsuDWkCsQ3dm2qBdvMlTL10Js8bHDA1XFSPuu+PZlkiFg2pKZ5mdX1bcCFfSCIup04pHDSaFPzStTET0bSsDtI8bn5/7SVIZiKi9CbydH9sk77jsJxO0+I9ZF8kjCf/EHhqERG7vmwaeCLytFTEFBdoEqq9ZgOtpImzrAnSXcTlDAs2A54YzTRP2Nl8zkRsDiCa+szqir+3YaQ1B6Eq2rDq8JooeaVhLy32/elll54pJRhZzPAopl57LO484A7wyzEz79nNzeahcW1y+4hi/jVfcWnuNVV+2etn8pdNUTRVYomIh/SsufkuKY3nK12L3qnv+qtFtC5Nrv1hyhJM3Lb/Ozuw0zcvsG+ksnvjfsVbRj8pvIsBECZPuuVYnwqsNOKYJuGirtdV/IXXL6f0xMHiyEOutOusRgR5hqwqhKDSINRd1JIamBYXWhNok057sx5lEJj1R846pTyeauUcpl55BFk4UUQrDrQ0JY7VLbiLV5zL/cauKvSFiaDrepSyQqrqOmm4dDPLTASUXOTsT4bmkC6gzswg+yI630HOvaMxzFv8i/ZKkzxzss8sm4fR06CUjxyszEKuZ9NSyqpXc0ESKKcvLuh0nkzu3yeuKDHbqFSxMIz8Hg0GBamCazmaGFQb1MQ9wjTSKZ0CVTQ0lIP1ZYfrIDeNQ8wy9dqHMLZaplo9FyramVfk6jCfOi34iO+2vyi3zUjFhJgZK7gvWlAuElQzcwK0SxkxmuYYptr52vYlt+iPU+l1R/rFxf7UqQdqcXILeB7U/9X+VHBvzrj8HNHpnLcXicNYPa5q+t7G1JbT1Le23XoltSAbd5P81WbnSyoGiENZGjskUojQXU84RbroDpeq6zalHSmoAnhSNzxuHBWwU7b5OjqR0rIWDvfkoq+WzoZLarD+8bhhzmGZqOSCvhOK8+R+mvdNE3Gx+MjbS5ieJ09LYVa1iJia00tu2icAS1m87C8JgnvEz9j0fU82FnyfI2q/KLk1gzvM8yMzjsAD2V/Rcdb9hl3d31kuX9WdPClIvRQzOKmdZnrgzTQjV7E+D+BrCgiZNyYZJ9rapM5t1nDhtGETJ40yTk7bxf+TnFR8n/0jnor3DdXRj2DNAKPA4MgHMYOTofd3yHS+oBjRDhRoaIkVKVdSeyxxApGszyV9qptnKA2k2rvas5lTy6KDXMhkfqF+xn7lO22snDHpj6n1iqy+jFKm7QO6JbrfhrCvxyv+UBAepB7m56eiI1rNOo1P4y5aEs0GWkgyqfrs1jUZcVPlGq6xPs8j2+niBJ628aKvijSdCpCqs8pRF7yvLbhm5NuqPUPkLPhUNRRUZpHhscdTzPdU9RHM6nn8dDuOAB5sw9HsiIiLlnaGyjzQzVSdUb9LBkzthr7Th+/FCGHfsBFFk13KjYMOijra/7C9AkH9TJWq75gDHl64yEyClkwPdKYn3e3AJVlI74oQQ7kjq6QqU4uJv3TS43yMlN2jrBQUNjaSLT/pc8GUGn6biWC0UeNrEVNFIKZTN43RtunSML6gFhwS+aJc5xtkdJp6+WFQxaRKbPnBv4dZ+yH8ZAt823nVZmqX/snz/dDeA6DLj2nmdP0U2ZFo7V3xHbBcN25IUelmEPuebKyzKbM319HJNlpUbHLL8lcO4YQ68w/S7+eWry1PTK9AS7qd66iJaI8zdltmzBZmpfOlS7laZpMsC6VoGPvAGYw+OqRjy1Tq+Jo2/LvGQS+Jul86lxoFa21inGp7hkqRQ4oPMYhvaJsxg+N/AWOGwfyQXjxYPMP6j/wiCw//A/zgKK7ZRt20WAjZd4IkVWMpuuQtLaSYedBoPki+Ngq7VdyOVjtLufZmgjthN1uUtBCey/3/YqriwGFymbHU653oLresdw9/vh5y0UY3ne4vnrQ37uSKaKkZcJqm5XrDS7awoZmCr8fdETS9d5XXJhUnqhoq4CixSVENJ9AlAHsdxx50W3yfduai02IL8K4yl/g6P93CVassnv/HrJz92bg/kE2Vh0TX8gIrZ36W0cmfYnz5SSaX/xC//Qpog7F12K+vDO29Ra5yitCYLjVun2FSF0A0tsJM50jOFnMKPuGzUpdIsfYqvvQerp+6e9GzWxztaYNw0K4HvR7ygdNzs/xQ7hCnWnj/tG/Pl5Kwp06Jiz+azkwQReauig7beeS1kqpoc8aiI82FmCpeyy4PMSVgBtkl7UtdZUubig37BIoNsNYm8r82fmQfLxzTtTSLSJeyk7a7OFXM8ASD03+ZxdM/TTU80bP3V7PVnHpPNVhn+b6/yeLpJ5jceJbJlT+iufksuncBo23YKCju45K2MMs2eHGd4j+7u4EWu4jG13YcyORmet4zpZQo4gJLHmQ3+6QYTZKQdK25Pmcsq3DtWa7uPBrOWvK1T5J7hW7JcE1xEUh/wKe3yVDif1Vvl1gxVYygrjeqGaBURTyHtTFiC4OGzalcjIk9/NgEMFUsXuqwW202LQTOblLbL89ut3msszcZmM25LbR7eO9Qu4Rd+zCjjU+wsPGTVIOjRQOjqzGqfW5/Y3M0MaZmtP44o/XHcc02083nmF79Os3mS7jxm0izHbdGs5GSpA11quj1I5sZym11tWRtUnZOu1aVHCKL5PZVuvpVDuBgHUfU3I+cEa+jRJQHdHJQk6Kb6/uaXjEY1M/ppic7SN4RQXsFBGmGGRMmOFSi6CtdoRA5nSbJRV1UEZK7pI1eygh4n6bfinWN5o4czYgXPfH2EHEXfrBxt7h43rzrLgSNQ06+6Shr3DMyXE6xtedb1LXhPNfLyOp5hkeCS7peeihsbJrHM2XfBvbVoZyntAYBtl5mdOzHGR37cbyf0ux+l3bzFdrNF2i3v4OfXIF2N7pv67ATUtj7IW8xodJFg/7cQxHJcjqV3onueOWsNV8OiFp6cFaMQ079+vQ20sttJJV+61wPLMzzblo9Sxk9J3dIBq7v4M7WtYJLl9NpecRyZneuXKAUO4wh8XSngGDzfU3K4BAKkJi/JDrRo49TfRNkGI29D7uEGd1LtfQgdu0xBquPUS3eVxhCNN835bAtW267R7QUJXzKVcYMGC6fY7h8Dk4/gXNT3OQi7c5rtDuv4XZew+9dRKc3we3GXfFD5PAicfPKujNZquSrtbfhddL+VLpzJl11G3im7hfNlUOrWyk3Hi+4bJhH6XwrPcNqdBGL9Dmh7uPBvihzfNwORItheN8NMGXblC8uwqKr0bsxjszoiDObNJUKgtgInGKjUdKFV4x4Sp3HWMNcdxf11e+FTcq94jRENzEDZHAUWbgHu3SWevlhqsWz2NE9WDs6YBJSZi4M3h4AD4qK/fuCgLUD7OJZBotn4XjSk8e46Q3c+DJufJF27xK6dxE3uRJ3Yt8Dtwd+2nVGkvFAbOQ0WkgocZ89tblLomWVmzWxmSLk7u4BcJd7vN/mzcXl8clZvsoBfeHcFZJDAAY9XVS13F8mWXlsrj41bSifCY9EM2uodoOm2HZbqYugZgD1KrY+gx1uwOgUdnQKOzqJXdjAVmv7c87sLvl3ccerd/FOSb6vix20T0xM6drs4Job+OY6bnIVP7mOm15Fx1fRZgt1W/hmF9w4zCFr2v3e9xY0VYt5EyCVWB3GUiMtRDmKiL8LAVr2aYLONTHCSOdcyTMtBmM6Thh2D4uOHjGoVplCJK6WSL6KjV48nw0AUrp+JBQMmkVhky1vJmWSNL46Y8XKN64xYatiqiVMtYzUy8hgFTM4ghmsYYfHMHW4Z4uxS4fsE8jM7S/e2U1r3ttbdRXNeM2pyB76mVPKUTfBuz203Q76UXsTbTbR6U18u41rtqC5Ge5c5CYxmk7ATyJPaeNYqHZ2pWgDE9GeZVQ5eEPG8jl512BjWVwcFSON5Gm18Fdhe3urcECbYm9sE2dUuhFMlc60G5zIwd6WCodgBfRdVIuaqdhBKDSiEmHMAmIXwC6Ekcd6BWNXkEG4bZdUK+H2XfnWXiOMHd16J9uDboT4Hty6632+WeHB4Hy7XzCk+nDjwfBngm9D5AygHOP9BHW7qNtD23G8vdYUddMQLXSCtONsJVe6ibbAGaOEK8J4b4+v/fHXmLWtJsDV9YCPf/xjmHRXpAjAzIVU8qbqxFu/ivqo1YWbGaqpwq26zCCCqg73eauWg2ySwGMXEDsMWp5dCM83Vf/iuJMVPPAc8K4D7fsMgHfBrfRWtyOV9+3TCHDl2iZnzpxhvLt54PMefPhRXnn5xZgS/xzXTg/hp9+Ht3D9Pr1htRyyaO8AsLcu9W93laLAsaPLnHv4LM/92XMYa/AucCFbWVzr+NBjj2BEcc5hrX2b191d8FM5aN1m973+/j4MPxBH//YLd/0HufUfMXgfUucDDzwY5pkJ9xT2qlEPVh5+5JFCbJa7/yN38/nvYO/rOQB/cI7EVB555JFDU9j58+fnCzUH4Ht7HAQy730PnCIyX6g5AN/lJB9Bde7cuR7oRATvPdZaHnjggTkA5wB8bwF4//33U1UV3vc3Zd/Y2OD06dNzAM4B+N4C8PTp0xw/frxbwHhH0DNnzrC8vDxjFpgfcwC+iwBUVRYXFzlz5kwGXwLbQw891EvN82MOwHf9cM71wFZGusQNvy91/TkAf/Ar4UcffXS+MHMAvv8ATFHx4YcfnhcgcwC+P4VIApv34fZZCwsLmRfOATgH4HsOwDNnzjAajXLBcc8993Dy5Mk5AOcAfH8AeOLECU6dOpX//ezZswwGg33a4PyYA/BdB6D3nrquuf/++/O/pxbcXIKZA/A9P2b7vvMKeA7AP/dKOGmA82MOwPeNBybQiQgPPvhgWEwzX845AN8nAKZuyOrq6lyCmQPw/QfgmTNnGA6HnDx5kvX19TkA5wB8fwF45MgRTpw4wenTpxGR3BGZH3MAvudHAtuZM2eyCXVuQpgD8H07EtjOnTuXueD8eHtHNV+Ct3985CMf4b777pvzvzkA3+e0EeWWj370oxw9enQOwHdw/D/ifPej3hsBkQAAAABJRU5ErkJggg==" },
  { id: "v4", label: "Weiss/Blau", dataUrl: "data:image/png;base64,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" },
  { id: "v5", label: "Orange/Türkis", dataUrl: "data:image/png;base64,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" },
  { id: "v6", label: "Navy/Gelbgrün", dataUrl: "data:image/png;base64,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" },
  { id: "v7", label: "Blau/Rot", dataUrl: "data:image/png;base64,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" },
  { id: "v8", label: "Orange/Blau", dataUrl: "data:image/png;base64,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" },
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
