const { useState, useEffect, useRef, useCallback } = React;

function useIsWide() {
  const [isWide, setIsWide] = useState(typeof window !== "undefined" ? window.innerWidth >= 768 : false);
  useEffect(() => {
    const onResize = () => setIsWide(window.innerWidth >= 768);
    window.addEventListener("resize", onResize);
    return () => window.removeEventListener("resize", onResize);
  }, []);
  return isWide;
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
    case "typ": case "type": return cf.typ||"";
    case "pilot": return f.pilot||"";
    case "passagier": case "pax": return cf.passagier||"";
    case "reise": return cf.reise||"";
    case "jahr": case "year": return f.year||"";
    case "monat": return f.month ? +f.month : 0;
    case "std": { const h = parseInt((f.startTime||"").slice(0,2), 10); return Number.isFinite(h) ? String(h) : ""; }
    case "datum": case "date": return f.date||"";
    case "startzeit": case "starttime": return f.startTime||"";
    case "landezeit": case "endtime": return f.endTime||"";
    case "kommentar": case "comment": return f.comment||"";
    case "bemerkung": case "notes": case "notiz": return f.notes||"";
    case "dauer": case "duration": return (f.durationSec||parseDurToSec(f.durationStr))/3600; // hours (number)
    case "distanz": case "dist": case "km": return f.totalDist||parseFloat(cf.distKm||cf.dk||0)||0;
    case "routenart": case "routentyp": return cf.routenTyp||"";
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
    case "hikeort": return cf.hikeOrt||"";
    case "hikestartpunkt": return cf.hikeStartpunkt||"";
    case "hikestarthoehe": return +(cf.hikeStarthoehe||0)||0;
    case "hikedauer": return cf.hikeDauer||"";
    case "hikehoehenmeter": {
      const startAlt = f.startAlt>0 ? f.startAlt : parseFloat(cf.msa);
      const hikeStart = parseFloat(cf.hikeStarthoehe);
      return (Number.isFinite(startAlt) && Number.isFinite(hikeStart)) ? Math.round(startAlt-hikeStart) : 0;
    }
    default: return "";
  }
}

function evalToken(f, tok){
  // comparison field op value — now also accepts != (not equal)
  let m=tok.match(/^([\wäöü]+)\s*(>=|<=|!=|≠|>|<|=|:)\s*(.+)$/i);
  if(m){
    const field=m[1].toLowerCase(), op=(m[2]==="≠"?"!=":m[2]), raw=m[3].trim().replace(/^"(.*)"$/, "$1");
    // "passagier:*" (or pax:*) means "any passenger at all" — for finding
    // biplace flights regardless of who the passenger was, rather than
    // matching a specific name.
    if((field==="passagier"||field==="pax") && raw==="*"){
      const has = !!(f.customFields?.passagier||"").trim();
      return op==="!=" ? !has : has;
    }
    // igc:ja / igc:nein and gpx:ja / gpx:nein — presence of an imported
    // IGC flight track resp. a Hike-GPX route, not a value comparison.
    if(field==="igc" || field==="gpx"){
      const has = field==="igc" ? (f.track?.length>1) : (f.hikeTrack?.length>1);
      const want = ["ja","vorhanden","true","1"].includes(raw.toLowerCase());
      return op==="!=" ? has!==want : has===want;
    }
    let fv=flightFieldValue(f, field);

    const numericFields=["name","titel","dauer","duration","distanz","dist","km","höhe","hoehe","maxhöhe","maxhoehe","alt",
      "startalt","endalt","hdiff","maxsteigen","maxsinken","hgew","entfernungsl","rangdauer","pctdauer","rangstrecke","pctstrecke",
      "speed","kmh","rating","bewertung","jahr","year","monat","startlat","startlon","endlat","endlon","hikestarthoehe","hikehoehenmeter"];
    const dateFields=["datum","date"];
    const timeFields=["startzeit","starttime","landezeit","endtime"];

    if(numericFields.includes(field)){
      // "monat" akzeptiert sowohl eine Zahl (1-12) als auch einen
      // (Teil-)Monatsnamen wie beim IGC-Import/der Anzeige.
      let cmp;
      if (field==="dauer"||field==="duration") cmp = parseDurToSec(raw)/3600;
      else if (field==="monat") {
        const byName = MONTH_NAMES_DE.findIndex(n => n.toLowerCase().startsWith(raw.toLowerCase()));
        cmp = byName>=0 ? byName+1 : parseFloat(raw.replace(",","."));
      }
      else cmp = parseFloat(raw.replace(",","."));
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
  const hay=[f.name,f.site,f.glider,f.pilot,f.customFields?.passagier,f.customFields?.landung,f.customFields?.reise,f.customFields?.routenTyp,f.comment,f.notes,f.date,f.year].join(" ").toLowerCase();
  return hay.includes(tok.toLowerCase());
}

const MONTH_NAMES_DE = ["Januar","Februar","März","April","Mai","Juni","Juli","August","September","Oktober","November","Dezember"];

function tokenizeQuery(q) {
  const s = q.trim()
    .replace(/\s+(UND|AND)\s+/gi, " && ")
    .replace(/\s+(ODER|OR)\s+/gi, " || ")
    .replace(/&&/g, " && ").replace(/\|\|/g, " || ");
  // Unquotierte Terme dürfen nicht bis an ein "(" / ")" heranreichen, sonst
  // verschluckt z.B. "(a b)" die schliessende Klammer als Teil von "b)" statt
  // sie als eigenes Token zu erkennen.
  const re = /\(|\)|&&|\|\||[\wäöü]+(?:>=|<=|!=|≠|>|<|=|:)"[^"]*"|[\wäöü]+(?:>=|<=|!=|≠|>|<|=|:)[^\s()]+|\+[^\s()]+|\-[^\s()]+|"[^"]*"|[^\s()]+/gi;
  const tokens = [];
  let m;
  while ((m = re.exec(s))) {
    let t = m[0];
    if (t !== "(" && t !== ")" && t !== "&&" && t !== "||") t = t.replace(/^"(.*)"$/, "$1");
    tokens.push(t);
  }
  return tokens;
}

function parseQueryTokens(tokens) {
  let pos = 0;
  const peek = () => tokens[pos];
  const next = () => tokens[pos++];
  function parseExpr() {
    let node = parseAndTerm();
    while (peek() === "||") { next(); node = { type: "or", left: node, right: parseAndTerm() }; }
    return node;
  }
  function parseAndTerm() {
    let node = parseAtom();
    // Zwei Terme direkt hintereinander (ohne explizites "UND"/"&&") galten
    // bisher nur als UND, wenn ein "&&"-Token dazwischenstand — bei reinem
    // Leerzeichen wurde der zweite Term stillschweigend verschluckt. Jetzt
    // zählt auch die reine Aneinanderreihung als UND, solange kein "||"
    // oder ")" folgt.
    while (peek() !== undefined && peek() !== "||" && peek() !== ")") {
      if (peek() === "&&") next();
      node = { type: "and", left: node, right: parseAtom() };
    }
    return node;
  }
  function parseAtom() {
    if (peek() === "(") {
      next();
      const node = parseExpr();
      if (peek() === ")") next(); // tolerate a missing closing paren rather than erroring out
      return node;
    }
    const tok = next();
    if (tok === undefined) return { type: "true" };
    if (tok.startsWith("+")) return { type: "leaf", term: tok.slice(1), negate: false };
    if (tok.startsWith("-")) return { type: "leaf", term: tok.slice(1), negate: true };
    return { type: "leaf", term: tok, negate: false };
  }
  return parseExpr();
}

function evalAst(f, node) {
  switch (node.type) {
    case "or":  return evalAst(f, node.left) || evalAst(f, node.right);
    case "and": return evalAst(f, node.left) && evalAst(f, node.right);
    case "leaf": { const r = evalToken(f, node.term); return node.negate ? !r : r; }
    default: return true;
  }
}

function matchFlights(flights, q){
  if(!q||!q.trim()) return flights;
  const tokens = tokenizeQuery(q);
  if (!tokens.length) return flights;
  const ast = parseQueryTokens(tokens);
  return flights.filter(f => evalAst(f, ast));
}

// ── GRUPPIERUNGS-ENGINE (aus flugbuch.jsx übernommen) ───────────────────
// Dieselben Felder/Funktionen, die die Flugliste für Gr. 1°/2° verwendet —
// hier dupliziert (wie parseDateToTs oben schon), damit das Graph-Badge
// exakt dieselben Gruppen bildet wie die Flugliste gerade anzeigt.
const GROUP_FIELDS = [
  { id: "nummer",  label: "Nummer" },
  { id: "jahr",    label: "Jahr" },
  { id: "monat",   label: "Monat" },
  { id: "std",     label: "Std." },
  { id: "glider",  label: "Schirm" },
  { id: "typ",     label: "Typ" },
  { id: "site",    label: "Startplatz" },
  { id: "landung", label: "Landeplatz" },
  { id: "reise",   label: "Reise" },
  { id: "hikeOrt", label: "Hike-Ort" },
  { id: "rating",  label: "Bewertung" },
  { id: "routenTyp", label: "Routenart" },
];
function sortFieldValue(f, sortId) {
  const cf = f.customFields || {};
  switch (sortId) {
    case "site":     return (f.site || "").toLowerCase();
    case "landung":  return (cf.landung || "").toLowerCase();
    case "glider":   return (f.glider || "").toLowerCase();
    case "typ":      return (cf.typ || "").toLowerCase();
    case "reise":    return (cf.reise || "").toLowerCase();
    case "rating":   return +f.rating || 0;
    case "hikeOrt":  return (cf.hikeOrt || "").toLowerCase();
    case "routenTyp": return (cf.routenTyp || "").toLowerCase();
    case "jahr":     return f.year || 0;
    case "monat":    return f.month ? +f.month : 0; // numeric 1-12, so groups sort chronologically not alphabetically
    case "std":      { const h = parseInt((f.startTime||"").slice(0,2), 10); return Number.isFinite(h) ? h : -1; }
    case "nummer":   { const m = (f.name||"").match(/\d+/); return m ? +m[0] : 0; }
    // Numerische Flugdatenfelder (Dauer, Distanz, Höhe, Max.Steigen/Sinken
    // usw.) — dieselben wie im Modus "Frei", hier für X in "Gruppiert".
    default:         { const v = flightFieldValue(f, sortId); return Number.isFinite(v) ? v : 0; }
  }
}
function formatSortValue(f, sortId) {
  const cf = f.customFields || {};
  switch (sortId) {
    case "site":     return f.site || "—";
    case "landung":  return cf.landung || "—";
    case "glider":   return f.glider || "—";
    case "typ":      return cf.typ || "—";
    case "reise":    return cf.reise || "—";
    case "rating":   return f.rating ? "★".repeat(f.rating) : "—";
    case "hikeOrt":  return cf.hikeOrt || "—";
    case "routenTyp": return cf.routenTyp || "—";
    case "jahr":     return f.year ? String(f.year) : "—";
    case "monat":    return f.month ? MONTH_NAMES_DE[+f.month-1] || "—" : "—";
    case "std":      { const h = parseInt((f.startTime||"").slice(0,2), 10); return Number.isFinite(h) ? String(h).padStart(2,"0")+"–"+String((h+1)%24).padStart(2,"0")+" Uhr" : "—"; }
    case "nummer":   return f.name ? String(f.name) : "—";
    default: {
      const bf = GRAPH_Y_BASE_FIELDS.find(x => x.field === sortId);
      if (!bf) return "—";
      const v = flightFieldValue(f, sortId);
      return v ? formatFreeFieldValue(v, bf) : "—";
    }
  }
}

const SEARCH_FIELDS = [
  { id: "name",      label: "Name/Titel",     type: "text" },
  { id: "site",      label: "Startplatz",     type: "text" },
  { id: "landung",   label: "Landeplatz",     type: "text" },
  { id: "glider",    label: "Schirm",         type: "text" },
  { id: "typ",       label: "Typ",            type: "text" },
  { id: "pilot",     label: "Pilot",          type: "text" },
  { id: "passagier", label: "Passagier",      type: "text", anyOption: true },
  { id: "reise",     label: "Reise",          type: "text" },
  { id: "datum",     label: "Datum",          type: "date" },
  { id: "startzeit", label: "Startzeit",      type: "time" },
  { id: "landezeit", label: "Landezeit",      type: "time" },
  { id: "jahr",      label: "Jahr",           type: "number" },
  { id: "monat",     label: "Monat",          type: "number" },
  { id: "bemerkung", label: "Bemerkung",      type: "text" },
  { id: "dauer",     label: "Dauer (h)",      type: "number" },
  { id: "distanz",   label: "Distanz (km)",   type: "number" },
  { id: "routenart", label: "Routenart",      type: "text" },
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
  { id: "igc",       label: "IGC-Track",      type: "bool" },
  { id: "gpx",       label: "Hike-GPX",       type: "bool" },
  { id: "hikeort",        label: "Hike-Ort",         type: "text" },
  { id: "hikestartpunkt", label: "Hike-Startpunkt",  type: "text" },
  { id: "hikestarthoehe", label: "Hike-Starthöhe (m)", type: "number" },
  { id: "hikehoehenmeter", label: "Hike-Höhenmeter (m)", type: "number" },
  { id: "hikedauer",      label: "Hike-Dauer",       type: "text" },
];
const BOOL_OPTIONS = [
  { value: "ja",   label: "Vorhanden" },
  { value: "nein", label: "Nicht vorhanden" },
];
const ADV_OPS_NUM = [">=", "<=", "!=", ">", "<", "=", "between"];
const ADV_OPS_TEXT = [":", "=", "!=", ">", "<", ">=", "<="];
function computeGroupRuns(rows) {
  const startSet = new Set(), endSet = new Set(), inSet = new Set();
  let runStart = null;
  const closeRun = (end) => {
    if (runStart !== null && end - runStart >= 1) {
      startSet.add(runStart); endSet.add(end);
      for (let k = runStart; k <= end; k++) inSet.add(k);
    }
    runStart = null;
  };
  rows.forEach((r, i) => {
    if (r.grouped) { if (runStart === null) runStart = i; }
    else { closeRun(i-1); }
  });
  closeRun(rows.length - 1);
  return { startSet, endSet, inSet };
}

function buildAdvancedQuery(rows) {
  // Values containing whitespace must be quoted — the query tokenizer
  // (matchFlights/evalToken) splits on spaces outside quotes, so an
  // unquoted "field:Advance Pi 23" silently became three unrelated terms
  // ("field:Advance", "Pi", "23") that essentially never all matched.
  const quoteIfNeeded = v => /\s/.test(v) ? `"${v}"` : v;
  const rowToStr = (r) => {
    const fieldDef = SEARCH_FIELDS.find(f => f.id === r.field);
    const isNumeric = fieldDef?.type === "number" || fieldDef?.type === "date" || fieldDef?.type === "time";
    const op = r.op || (isNumeric ? "=" : ":");
    if (op === "between") {
      if (r.value2 === "" || r.value2 == null) return `${r.field}>=${String(r.value).trim()}`;
      return `${r.field}>=${String(r.value).trim()} && ${r.field}<=${String(r.value2).trim()}`;
    }
    return `${r.field}${op}${quoteIfNeeded(String(r.value).trim())}`;
  };
  const validRows = rows.filter(r => r.value !== "" && r.value != null);
  if (!validRows.length) return "";
  // Each row (after the first) carries its OWN combinator relative to the
  // previous row, and rows checked "gruppiert" (2+ in a row) get wrapped
  // in real parentheses — the query engine now has a proper parser
  // (tokenizeQuery/parseQueryTokens) that understands "(", ")", so
  // "A UND (B ODER C)" can be built and evaluated exactly as written,
  // rather than relying only on UND-binds-tighter-als-ODER precedence.
  const { startSet, endSet } = computeGroupRuns(validRows);
  let out = "";
  validRows.forEach((r, i) => {
    if (i > 0) out += r.combinator === "OR" ? " || " : " && ";
    if (startSet.has(i)) out += "( ";
    out += rowToStr(r);
    if (endSet.has(i)) out += " )";
  });
  return out;
}

function newSearchRow() { return { field: "site", op: ":", value: "", combinator: "AND", grouped: false }; }

function parseTermToken(tok) {
  const m = tok.match(/^([\wäöü]+)\s*(>=|<=|!=|≠|>|<|=|:)\s*(.+)$/i);
  if (!m) return null;
  const field = m[1].toLowerCase();
  if (!SEARCH_FIELDS.find(f => f.id === field)) return null;
  const op = m[2] === "≠" ? "!=" : m[2];
  const value = m[3].trim().replace(/^"(.*)"$/, "$1");
  return { field, op, value };
}

function parseQueryToRows(query) {
  if (!query || !query.trim()) return [newSearchRow()];
  const tokens = tokenizeQuery(query);
  if (!tokens.length) return [newSearchRow()];
  const rows = [];
  let pendingCombinator = "AND";
  let depth = 0;
  let i = 0;
  while (i < tokens.length) {
    const tok = tokens[i];
    if (tok === "&&") { pendingCombinator = "AND"; i++; continue; }
    if (tok === "||") { pendingCombinator = "OR"; i++; continue; }
    if (tok === "(") { depth++; i++; continue; }
    if (tok === ")") { depth = Math.max(0, depth-1); i++; continue; }
    const parsed = parseTermToken(tok);
    if (!parsed) return [newSearchRow()];
    const combinator = rows.length ? pendingCombinator : "AND";
    const grouped = depth > 0;
    // Merge a "between" pair back into one row — buildAdvancedQuery always
    // emits these as two consecutive same-field >=/<= entries joined by &&.
    if (parsed.op === ">=" && tokens[i+1] === "&&") {
      const next2 = parseTermToken(tokens[i+2]);
      if (next2 && next2.field === parsed.field && next2.op === "<=") {
        rows.push({ field: parsed.field, op: "between", value: parsed.value, value2: next2.value, combinator, grouped });
        i += 3;
        continue;
      }
    }
    rows.push({ ...parsed, combinator, grouped });
    i++;
  }
  return rows.length ? rows : [newSearchRow()];
}

function SearchBar({ filterText, setFilterText, knownGliders }) {
  // Opens on focus/tap into the search field itself (no separate button
  // needed) and stays independent state from then on — it does NOT close
  // again just because the field's text changes, since that caused the
  // panel to flicker open/closed on every keystroke. Closing only happens
  // via the explicit ✓ button below.
  const [advOpen, setAdvOpen] = useState(false);
  const [rows, setRows] = useState(() => parseQueryToRows(filterText));

  const applyRows = (nextRows) => {
    setRows(nextRows);
    setFilterText(buildAdvancedQuery(nextRows));
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
            {(() => {
              const { startSet, endSet, inSet } = computeGroupRuns(rows);
              return rows.map((row, idx) => {
              const fieldDef = SEARCH_FIELDS.find(f=>f.id===row.field);
              const grouped = inSet.has(idx);
              return (
                <div key={idx} style={{
                  display:"flex",gap:6,alignItems:"center",
                  borderLeft: grouped ? "2px solid rgba(167,139,250,0.6)" : "2px solid transparent",
                  borderTopLeftRadius: startSet.has(idx) ? 6 : 0,
                  borderBottomLeftRadius: endSet.has(idx) ? 6 : 0,
                  paddingLeft: 4, marginLeft: -2,
                }}>
                  {idx===0 ? (
                    <span style={{minWidth:34,flexShrink:0}} />
                  ) : (
                    <button onClick={()=>updateRow(idx,{combinator: row.combinator==="OR"?"AND":"OR"})}
                      title="Verknüpfung zur vorherigen Zeile umschalten"
                      style={{fontSize:10,fontWeight:700,minWidth:34,textAlign:"center",flexShrink:0,background:row.combinator==="OR"?"rgba(251,191,36,0.18)":"rgba(125,211,252,0.15)",border:`1px solid ${row.combinator==="OR"?"rgba(251,191,36,0.4)":"rgba(125,211,252,0.35)"}`,borderRadius:6,padding:"3px 2px",color:row.combinator==="OR"?"#fbbf24":"#7dd3fc",cursor:"pointer"}}>
                      {row.combinator==="OR"?"ODER":"UND"}
                    </button>
                  )}
                  <button onClick={()=>updateRow(idx,{grouped: !row.grouped})}
                    title="Mit Nachbar-Zeile(n) klammern — ab 2 benachbart markierten Zeilen entsteht eine Klammer-Gruppe"
                    style={{fontSize:12,fontWeight:900,width:20,flexShrink:0,background:row.grouped?"rgba(167,139,250,0.22)":"rgba(255,255,255,0.05)",border:`1px solid ${row.grouped?"rgba(167,139,250,0.5)":"rgba(255,255,255,0.12)"}`,borderRadius:6,padding:"3px 0",color:row.grouped?"#a78bfa":"rgba(232,244,253,0.35)",cursor:"pointer"}}>
                    ( )
                  </button>
                  <select value={row.field}
                    onChange={e=>{
                      const nf = SEARCH_FIELDS.find(f=>f.id===e.target.value);
                      const isNum = nf?.type==="number"||nf?.type==="date"||nf?.type==="time";
                      const isBool = nf?.type==="bool";
                      updateRow(idx, { field: e.target.value, op: isNum ? "=" : ":", value2: undefined, value: isBool ? "ja" : "" });
                    }}
                    style={{background:"rgba(255,255,255,0.08)",border:"1px solid rgba(255,255,255,0.12)",borderRadius:8,padding:"5px 2px",color:"#e8f4fd",fontSize:12,width:84,flexShrink:0}}>
                    {SEARCH_FIELDS.map(f=><option key={f.id} value={f.id} style={{background:"#0a1628"}}>{f.label}</option>)}
                  </select>
                  {(() => {
                    if (fieldDef?.type === "bool") return null;
                    const isNumeric = fieldDef?.type === "number" || fieldDef?.type === "date" || fieldDef?.type === "time";
                    const ops = isNumeric ? ADV_OPS_NUM : ADV_OPS_TEXT;
                    return (
                      <select value={row.op || (isNumeric ? "=" : ":")} onChange={e=>updateRow(idx,{op:e.target.value})}
                        style={{background:"rgba(255,255,255,0.08)",border:"1px solid rgba(255,255,255,0.12)",borderRadius:8,padding:"5px 2px",color:"#e8f4fd",fontSize:12,width:isNumeric?68:44,flexShrink:0}}>
                        {ops.map(o=><option key={o} value={o} style={{background:"#0a1628"}}>{o==="between"?"zw.":o}</option>)}
                      </select>
                    );
                  })()}
                  {fieldDef?.type === "bool" ? (
                    <select value={row.value||"ja"} onChange={e=>updateRow(idx,{value:e.target.value})}
                      style={{flex:1,minWidth:0,background:"rgba(255,255,255,0.08)",border:"1px solid rgba(255,255,255,0.12)",borderRadius:8,padding:"5px 8px",color:"#e8f4fd",fontSize:12}}>
                      {BOOL_OPTIONS.map(o=><option key={o.value} value={o.value} style={{background:"#0a1628"}}>{o.label}</option>)}
                    </select>
                  ) : (
                  <input value={row.value==="*"?"":row.value} onChange={e=>updateRow(idx,{value:e.target.value})}
                    placeholder={fieldDef?.anyOption ? "Name, oder \"beliebig\" →" : (row.op==="between" ? "von…" : "Wert…")}
                    disabled={row.value==="*"}
                    list={row.field==="glider" && knownGliders?.length ? "glider-datalist" : undefined}
                    style={{flex:1,minWidth:0,background:row.value==="*"?"rgba(255,255,255,0.03)":"rgba(255,255,255,0.08)",border:"1px solid rgba(255,255,255,0.12)",borderRadius:8,padding:"5px 8px",color:"#e8f4fd",fontSize:12}} />
                  )}
                  {row.op==="between" && (
                    <input value={row.value2||""} onChange={e=>updateRow(idx,{value2:e.target.value})} placeholder="bis…"
                      style={{flex:1,minWidth:0,background:"rgba(255,255,255,0.08)",border:"1px solid rgba(255,255,255,0.12)",borderRadius:8,padding:"5px 8px",color:"#e8f4fd",fontSize:12}} />
                  )}
                  {fieldDef?.anyOption && (
                    <button onClick={()=>updateRow(idx,{value: row.value==="*" ? "" : "*"})}
                      title="Beliebiger Passagier (Biplace-Flüge)"
                      style={{background:row.value==="*"?"rgba(125,211,252,0.25)":"rgba(255,255,255,0.06)",border:"1px solid rgba(255,255,255,0.12)",borderRadius:8,padding:"5px 5px",color:row.value==="*"?"#7dd3fc":"rgba(232,244,253,0.6)",fontSize:10,fontWeight:700,cursor:"pointer",flexShrink:0,whiteSpace:"nowrap"}}>
                      beliebig
                    </button>
                  )}
                  <button onClick={()=>removeRow(idx)} style={{background:"none",border:"none",color:"rgba(232,244,253,0.35)",cursor:"pointer",fontSize:14,padding:"0 2px",flexShrink:0}}>✕</button>
                </div>
              );
              });
            })()}
          </div>
          <div style={{display:"flex",justifyContent:"space-between",alignItems:"center",marginTop:8}}>
            <button onClick={addRow} style={{background:"rgba(125,211,252,0.12)",border:"1px solid rgba(125,211,252,0.3)",borderRadius:8,padding:"5px 10px",color:"#7dd3fc",fontSize:11,fontWeight:700,cursor:"pointer"}}>+ Zeile</button>
            <button onClick={()=>setAdvOpen(false)} title="Schliessen"
              style={{background:"rgba(34,197,94,0.18)",border:"1px solid rgba(34,197,94,0.4)",borderRadius:8,width:30,height:30,color:"#4ade80",fontSize:14,fontWeight:900,cursor:"pointer",flexShrink:0}}>✓</button>
          </div>
        </div>
      )}
      {knownGliders?.length > 0 && (
        <datalist id="glider-datalist">
          {knownGliders.map(g => <option key={g} value={g} />)}
        </datalist>
      )}
    </div>
  );
}


// ── Statistik Page ───────────────────────────────────────────────────────
// Four aggregated views built from the same flight data the Flugbuch app
// stores: Schirm (glider), Passagiere, Landeplätze, Startplätze. Shown as
// four collapsible badges (same pattern as the Service page). On narrow
// screens each row renders as a stacked card instead of a wide table, since
// the source tables have too many columns to fit comfortably.

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
function getFlightDist(f) {
  if (f.totalDist > 0) return f.totalDist;
  return parseFloat(f.customFields?.distKm || f.customFields?.dk || 0) || 0;
}
function getFlightAlt(f) {
  if (f.maxAlt > 0) return f.maxAlt;
  return +(f.customFields?.hMax || 0);
}

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
    const totalDist = fl.reduce((s,f) => s + getFlightDist(f), 0);
    const maxDist = fl.reduce((m,f) => Math.max(m, getFlightDist(f)), 0);
    const maxAlt = fl.reduce((m,f) => Math.max(m, getFlightAlt(f)), 0);
    const dates = fl.map(f => parseDateToTs(f.date)).filter(Boolean);
    const first = dates.length ? Math.min(...dates) : 0;
    const last = dates.length ? Math.max(...dates) : 0;
    const startSites = new Set(fl.map(f => f.site).filter(Boolean)).size;
    const endSites = new Set(fl.map(f => f.customFields?.landung).filter(Boolean)).size;
    const r5 = fl.filter(f => f.rating === 5).length;
    const r4 = fl.filter(f => f.rating === 4).length;
    return { name: g.key, count: fl.length, totalSec, maxSec, totalDist, maxDist, maxAlt, first, last, startSites, endSites, r5, r4, flights: fl };
  });
  return rows;
}

// Generic sort helper: sorts a copy of rows by field, direction "asc"/"desc".
// Non-numeric fields (name) sort alphabetically; everything else numerically.
function sortRows(rows, field, dir) {
  const sorted = [...rows].sort((a,b) => {
    let av = a[field], bv = b[field];
    if (typeof av === "string") {
      const cmp = av.localeCompare(bv, "de");
      return dir === "asc" ? cmp : -cmp;
    }
    return dir === "asc" ? av - bv : bv - av;
  });
  return sorted;
}

// Ported from flugbuch.jsx's SeasonDash — same content (year selector, stats
// grid, personal records), but without its own page header/back-button
// since this now lives as a section inside Statistik's own page instead of
// being a separate full-screen view.
function SeasonSection({ flights }) {
  const years = [...new Set(flights.map(f=>f.year).filter(Boolean))].sort().reverse();
  const currentYear = new Date().getFullYear();
  // Fixed order: current year, then the 3 before it, regardless of whether
  // each actually has flights (selecting an empty one just shows the
  // existing "Keine Flüge in {yr}" state) — anything older goes under Mehr.
  const explicitYears = [currentYear, currentYear-1, currentYear-2].map(String);
  const olderYears = years.filter(y => !explicitYears.includes(y));
  const [yr, setYr] = useState(years[0]||"");
  const [showMoreYears, setShowMoreYears] = useState(false);
  // Restores the previously chosen year filter on mount — statistik.html
  // is its own separate page (a full navigation, not a client-side route),
  // so plain React state always resets to the default on return; this is
  // the same window.storage pattern used elsewhere in the app for
  // anything that needs to survive that.
  useEffect(() => {
    (async () => {
      try {
        const r = await window.storage.get("statistikYearFilter");
        if (r && r.value) setYr(r.value);
      } catch (e) { /* nothing stored yet, or storage unavailable — keep default */ }
    })();
  }, []);
  const chooseYr = (y) => {
    setYr(y);
    try { window.storage.set("statistikYearFilter", y); } catch (e) {}
  };
  const yf = yr==="alle" ? flights : flights.filter(f=>f.year===yr);
  const parseDurStr = s => {
    if (!s) return 0;
    const dm = s.match(/(\d+):(\d{2}):(\d{2})/);
    if (dm) return +dm[1]*3600 + +dm[2]*60 + +dm[3];
    const dm2 = s.match(/(\d+):(\d{2})/);
    if (dm2) return +dm2[1]*60 + +dm2[2];
    const dm3 = s.match(/(\d+)h\s*(\d+)m/);
    if (dm3) return +dm3[1]*3600 + +dm3[2]*60;
    const dm4 = s.match(/(\d+)m/);
    if (dm4) return +dm4[1]*60;
    return 0;
  };
  const parseDur = f => f.durationSec > 0 ? f.durationSec : (f.durationStr ? parseDurStr(f.durationStr) : 0);
  const getDist = getFlightDist;
  const getAlt = getFlightAlt;
  const totalSec = yf.reduce((s,f)=>s+parseDur(f),0);
  const totalDist = yf.reduce((s,f)=>s+getDist(f),0);
  const flugtage = new Set(yf.map(f=>f.date).filter(Boolean)).size;
  const getDur = f => parseDur(f);
  const prDur  = yf.length ? Math.max(...yf.map(getDur))  : 0;
  const prDist = yf.length ? Math.max(...yf.map(getDist)) : 0;
  const prAlt  = yf.length ? Math.max(...yf.map(getAlt))  : 0;
  const prFlightDur  = yf.find(f=>getDur(f)===prDur);
  const prFlightDist = yf.find(f=>getDist(f)===prDist);
  const prFlightAlt  = yf.find(f=>getAlt(f)===prAlt);
  const fmtDur = s => `${Math.floor(s/3600)}h ${String(Math.floor((s%3600)/60)).padStart(2,"0")}m`;

  const S = {
    yearRow:{display:"flex",gap:8,marginBottom:16,flexWrap:"wrap"},
    yrBtn:(a)=>({background:a?"rgba(224,48,74,0.3)":"rgba(255,255,255,0.05)",border:a?"1px solid rgba(224,48,74,0.5)":"1px solid rgba(255,255,255,0.08)",borderRadius:20,padding:"6px 14px",color:a?"#e8f4fd":"rgba(232,244,253,0.5)",fontSize:13,cursor:"pointer",fontWeight:a?600:400}),
    grid:{display:"grid",gridTemplateColumns:"1fr 1fr",gap:10,marginBottom:16},
    box:{background:"rgba(255,255,255,0.05)",borderRadius:12,padding:"14px 12px",textAlign:"center",border:"1px solid rgba(255,255,255,0.07)"},
    bigNum:{fontSize:26,fontWeight:800,color:"#e8f4fd",letterSpacing:-1},
    lbl:{fontSize:10,color:"rgba(232,244,253,0.4)",textTransform:"uppercase",letterSpacing:0.8,marginTop:3},
    prBox:{background:"rgba(224,48,74,0.08)",border:"1px solid rgba(224,48,74,0.2)",borderRadius:12,padding:"14px 16px",marginBottom:10},
    prTitle:{fontSize:11,fontWeight:600,color:"#e8f4fd",letterSpacing:1.2,textTransform:"uppercase",marginBottom:8},
    prRow:{display:"flex",justifyContent:"space-between",alignItems:"center",padding:"6px 0",borderBottom:"1px solid rgba(224,48,74,0.08)"},
    prLbl:{fontSize:13,color:"rgba(232,244,253,0.5)"},
    prVal:{fontSize:13,fontWeight:600,color:"#fcd34d"},
    prSub:{fontSize:11,color:"rgba(232,244,253,0.3)"},
  };

  if (!flights.length) return null;

  return (
    <div style={{margin:"12px 16px 0",display:"flex",flexDirection:"column",gap:8}}>
      <div style={S.yearRow}>
        <button style={S.yrBtn(yr==="alle")} onClick={()=>chooseYr("alle")}>Alle</button>
        {explicitYears.map(y=><button key={y} style={S.yrBtn(y===yr)} onClick={()=>chooseYr(y)}>{y}</button>)}
        {olderYears.length>0 && (
          <button onClick={()=>setShowMoreYears(true)}
            style={S.yrBtn(olderYears.includes(yr))}>
            {olderYears.includes(yr) ? yr : "Mehr ▾"}
          </button>
        )}
      </div>
      {showMoreYears && (
        <div onClick={()=>setShowMoreYears(false)}
          style={{position:"fixed",inset:0,background:"rgba(0,0,0,0.55)",zIndex:200,display:"flex",alignItems:"center",justifyContent:"center",padding:24}}>
          <div onClick={e=>e.stopPropagation()}
            style={{background:"#2a0d16",border:"1px solid rgba(255,255,255,0.12)",borderRadius:16,padding:14,maxHeight:"60vh",overflowY:"auto",width:"100%",maxWidth:280,boxShadow:"0 8px 30px rgba(0,0,0,0.5)"}}>
            <div style={{fontSize:13,fontWeight:700,color:"rgba(232,244,253,0.5)",marginBottom:8,padding:"0 4px"}}>Jahr wählen</div>
            {olderYears.map(y=>(
              <div key={y} onClick={()=>{chooseYr(y);setShowMoreYears(false);}}
                style={{padding:"10px 12px",borderRadius:10,fontSize:15,cursor:"pointer",color:"#e8f4fd",background:y===yr?"rgba(224,48,74,0.15)":"transparent",marginBottom:2}}>
                {y}
              </div>
            ))}
          </div>
        </div>
      )}
      {yf.length===0 ? (
        <div style={{color:"rgba(232,244,253,0.3)",fontSize:14}}>Keine Flüge {yr==="alle"?"vorhanden":`in ${yr}`}</div>
      ) : (<>
        <div style={S.grid}>
          <div style={S.box}><div style={S.bigNum}>{yf.length}</div><div style={S.lbl}>Flüge</div></div>
          <div style={S.box}><div style={S.bigNum}>{fmtDur(totalSec)}</div><div style={S.lbl}>Total Flugzeit</div></div>
          <div style={S.box}><div style={S.bigNum}>{flugtage}</div><div style={S.lbl}>Flugtage</div></div>
          <div style={S.box}><div style={S.bigNum}>{yf.length>0?(totalDist/yf.length).toFixed(1):0} km</div><div style={S.lbl}>Ø / Flug</div></div>
        </div>
        <div style={S.prBox}>
          <div style={S.prTitle}>🏆 Persönliche Rekorde {yr==="alle"?"(alle Jahre)":yr}</div>
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

// ── GRAPH-BADGE ──────────────────────────────────────────────────────────
// Zwei Modi, umschaltbar per Chip — Startwert richtet sich danach, ob in
// der Flugliste gerade eine Gr. 1° aktiv ist:
//  - "Gruppiert": wie bisher — Balkendiagramm zur Gr. 1°/Filterung der
//    Flugliste, X-/Y-Achse danach im Badge selbst frei wählbar, bei
//    gesetzter Gr. 2° zusätzlich ein "Aufschlüsseln nach…"-Dropdown
//    (Drilldown statt gestapelter Balken — bei vielen Gr.-2°-Werten auf
//    schmalem Bildschirm sonst unlesbar).
//  - "Frei": kein Gruppieren — jeder (gefilterte) Flug ist ein Punkt,
//    X-/Y-Achse teilen sich dieselbe Feldliste (Datum/Jahr/Monat/Std.
//    oder jedes numerische Flugdatenfeld).
// X/Y bieten in "Gruppiert" dieselben Datenfelder wie in "Frei" (dort
// zusätzlich noch Schirm/Startplatz/Landeplatz/Reise/Hike-Ort/Typ/
// Routenart, da "Gruppiert" zusätzlich kategorische Gruppierung braucht).
// Beide Achsen (X in beiden Modi, Y nur "Gruppiert"/"Frei" gleichermassen)
// per ⇅ umkehrbar. Beide Modi teilen sich Filter/Drilldown sowie Pinch-
// Zoom/Pan. Zoom ist ein echter Bereichs-Zoom (nicht nur eine optische
// Lupe): zwei Finger verengen den sichtbaren Werte-/Zeitbereich, wodurch
// Balken/Punkte/Beschriftungen tatsächlich mehr Platz bekommen statt nur
// vergrössert zu werden; ein Finger verschiebt den sichtbaren Bereich,
// Doppeltipp/-klick oder das ⤾-Symbol setzt auf die volle Spanne zurück.
// Achsen-Legenden (Gitterlinien-Beschriftungen) zeigen dabei immer nur
// den gerade sichtbaren Ausschnitt, in regelmässigen, möglichst "runden"
// Abständen (ganzzahlig bzw. glatte 1/2/5×10^n-Schritte; bei Datum je
// nach sichtbarer Spanne auf Jahres-, Monats- oder Tages-Raster
// ausgerichtet).
const GRAPH_Y_BASE_FIELDS = [
  { field: "dauer",         label: "Dauer",           unit: "h",    aggs: ["sum","avg"] },
  { field: "distanz",       label: "Distanz",         unit: "km",   aggs: ["sum","avg"] },
  { field: "höhe",          label: "Höhe",            unit: "m",    aggs: ["avg","max"] },
  { field: "startalt",      label: "Start müM",       unit: "m",    aggs: ["avg","max"] },
  { field: "endalt",        label: "Landung müM",     unit: "m",    aggs: ["avg","max"] },
  { field: "hdiff",         label: "H.Diff.",         unit: "m",    aggs: ["sum","avg"] },
  { field: "maxsteigen",    label: "Steigen",         unit: "m/s",  aggs: ["avg","max"] },
  { field: "maxsinken",     label: "Sinken",          unit: "m/s",  aggs: ["avg","max"] },
  { field: "hgew",          label: "H.Gew.",          unit: "m",    aggs: ["sum","avg"] },
  { field: "entfernungsl",  label: "Entf. S-L",       unit: "km",   aggs: ["sum","avg"] },
  { field: "speed",         label: "Speed",           unit: "km/h", aggs: ["avg","max"] },
  { field: "rating",        label: "Bewertung",       unit: "",     aggs: ["avg"] },
  { field: "hikestarthoehe", label: "Hike-Starthöhe", unit: "m",    aggs: ["avg","max"] },
  { field: "hikehoehenmeter", label: "Hike-Höhenmeter", unit: "m",  aggs: ["sum","avg"] },
];
const GRAPH_AGG_PREFIX = { sum: "Gesamt", avg: "Ø", max: "Max." };
function graphYLabel(bf, agg) {
  if (bf.field === "dauer") return agg==="sum" ? "Gesamtdauer" : "Ø Dauer";
  if (bf.field === "distanz") return agg==="sum" ? "Gesamtdistanz" : "Ø Distanz";
  return `${GRAPH_AGG_PREFIX[agg]} ${bf.label}`;
}
// Felder, deren Werte von Natur aus ganzzahlig/diskret sind — sowohl für
// die Gruppierung im Modus "Gruppiert" als auch für "schöne" (ganzzahlige)
// Achsen-Ticks im Modus "Frei".
const GRAPH_NUMERIC_X_FIELDS = new Set(["nummer", "jahr", "monat", "std", "rating"]);
// Felder, die (wie in "Frei") nicht über flightFieldValue, sondern über
// dieselbe sortFieldValue-Logik wie die Gruppierungs-Engine laufen.
const GRAPH_FREE_VIA_SORTFIELD = new Set(["nummer", "jahr", "monat", "std"]);
// Nummer/Jahr/Monat/Std. zusätzlich als Y-Feld wählbar (Ø/Max.), für
// Feld-Parität mit "Frei" — Summe ergibt bei diesen Feldern keinen Sinn.
const GRAPH_Y_EXTRA_FIELDS = [
  { field: "nummer", label: "Nummer", unit: "", aggs: ["avg","max"] },
  { field: "jahr",  label: "Jahr",  unit: "", aggs: ["avg","max"] },
  { field: "monat", label: "Monat", unit: "", aggs: ["avg","max"] },
  { field: "std",   label: "Std.",  unit: "", aggs: ["avg","max"] },
];
const GRAPH_Y_METRICS = [
  { id: "count", label: "Anzahl Flüge", zeroBased: true },
  ...[...GRAPH_Y_EXTRA_FIELDS, ...GRAPH_Y_BASE_FIELDS].flatMap(bf => bf.aggs.map(agg => ({
    id: `${bf.field}:${agg}`, label: graphYLabel(bf, agg), field: bf.field, agg, unit: bf.unit,
    zeroBased: bf.aggs.includes("sum"),
  }))),
];
function graphYMetricValue(groupFlights, metricId) {
  if (!groupFlights.length) return 0;
  if (metricId === "count") return groupFlights.length;
  const m = GRAPH_Y_METRICS.find(x => x.id === metricId);
  if (!m) return 0;
  // +(...) erzwingt eine Zahl — sortFieldValue liefert bei "jahr" je nach
  // Datenherkunft eine Zahl oder einen String (f.year), und ein String
  // würde bei sum/avg per "+" verkettet statt addiert (siehe f.year als
  // String statt Zahl in echten Daten, CLAUDE.md bekannte Stolperfalle).
  const vals = groupFlights.map(f =>
    +(GRAPH_FREE_VIA_SORTFIELD.has(m.field) ? sortFieldValue(f, m.field) : flightFieldValue(f, m.field)) || 0);
  if (m.agg === "sum") return vals.reduce((a,b)=>a+b, 0);
  if (m.agg === "avg") return vals.reduce((a,b)=>a+b, 0) / groupFlights.length;
  // "Max.Sinken" ist wie überall sonst in der App (siehe Flugliste-
  // Statistikfeld, SchirmTimeline persönliche Rekorde) negativ
  // gespeichert — der "stärkste" Sinkwert ist der am weitesten von 0
  // entfernte NEGATIVE Wert, also das Minimum statt des Maximums.
  // Math.max hätte hier immer den schwächsten Sinkwert geliefert.
  if (m.agg === "max") return m.field === "maxsinken" ? Math.min(...vals) : Math.max(...vals);
  return 0;
}
function formatGraphYMetric(v, metricId) {
  if (metricId === "count") return String(Math.round(v));
  const m = GRAPH_Y_METRICS.find(x => x.id === metricId);
  if (!m) return String(Math.round(v));
  if (GRAPH_FREE_VIA_SORTFIELD.has(m.field)) return graphFormatAxisValue(m.field, v);
  return formatFreeFieldValue(v, m);
}
// Rundet einen Diagramm-Höchstwert auf eine "schöne" Zahl (1/2/5 × 10^n)
// auf, damit die volle (ungezoomte) Y-Spanne bei additiven Grössen nicht
// krumm endet.
function graphNiceMax(v) {
  if (v <= 0) return 1;
  const exp = Math.floor(Math.log10(v));
  const base = Math.pow(10, exp);
  const norm = v / base;
  const nice = norm <= 1 ? 1 : norm <= 2 ? 2 : norm <= 5 ? 5 : 10;
  return nice * base;
}
// Schrittweite für "schöne" Achsen-Ticks (1/2/5 × 10^n), Ziel ~targetCount
// Ticks über die angegebene Spanne — Standardverfahren jeder Chart-
// Bibliothek, damit z.B. 0/25/50/75/100 statt 0/23.7/47.4/… angezeigt wird.
function graphNiceStep(range, targetCount) {
  if (range <= 0) return 1;
  const rough = range / Math.max(1, targetCount-1);
  const exp = Math.floor(Math.log10(rough));
  const base = Math.pow(10, exp);
  const norm = rough / base;
  const nice = norm <= 1 ? 1 : norm <= 2 ? 2 : norm <= 5 ? 5 : 10;
  return nice * base;
}
// Erzeugt "schöne", regelmässig verteilte Tick-Werte innerhalb [min,max]
// (immer nur der gerade sichtbare Ausschnitt, nicht die volle Spanne) —
// forceInteger rundet zusätzlich auf ganze Zahlen (Jahr/Monat/Std./
// Bewertung/Anzahl Flüge).
function computeNiceTicks(min, max, targetCount, forceInteger) {
  if (!(max > min)) return [min];
  let step = graphNiceStep(max-min, targetCount);
  if (forceInteger) step = Math.max(1, Math.round(step));
  const start = Math.ceil(min/step)*step;
  const ticks = [];
  for (let v = start; v <= max + step*1e-9; v += step) ticks.push(forceInteger ? Math.round(v) : Math.round(v*1e6)/1e6);
  if (!ticks.length) ticks.push((min+max)/2);
  return ticks;
}
const GRAPH_DAY_MS = 86400000;
// "Schöne" Datums-Ticks für den sichtbaren Zeitausschnitt: je nach Spanne
// auf Jahres-, Monats- oder Tages-Raster ausgerichtet (z.B. exakt am 1.
// Januar bei mehrjähriger Spanne), statt nur gleichmässig in Millisekunden
// verteilt zu sein.
function graphNiceDateTicks(minTs, maxTs, targetCount) {
  if (!(maxTs > minTs)) return [minTs];
  const spanDays = (maxTs-minTs) / GRAPH_DAY_MS;
  const d0 = new Date(minTs), d1 = new Date(maxTs);
  if (spanDays > 550) {
    const y0 = d0.getFullYear(), y1 = d1.getFullYear();
    const step = Math.max(1, Math.round(graphNiceStep(Math.max(1,y1-y0), targetCount)));
    const ticks = [];
    for (let y = Math.ceil(y0/step)*step; y <= y1; y += step) {
      const t = new Date(y,0,1).getTime();
      if (t >= minTs && t <= maxTs) ticks.push(t);
    }
    return ticks.length ? ticks : [minTs];
  }
  if (spanDays > 40) {
    const totalMonths = Math.max(1, (d1.getFullYear()-d0.getFullYear())*12 + (d1.getMonth()-d0.getMonth()));
    const ratio = totalMonths/targetCount;
    const stepM = ratio<=1 ? 1 : ratio<=2 ? 2 : ratio<=3 ? 3 : 6;
    const ticks = [];
    let y = d0.getFullYear(), m = Math.ceil(d0.getMonth()/stepM)*stepM;
    while (y < d1.getFullYear() || (y===d1.getFullYear() && m<=d1.getMonth())) {
      const t = new Date(y, m, 1).getTime();
      if (t >= minTs && t <= maxTs) ticks.push(t);
      m += stepM;
      if (m >= 12) { m -= 12; y++; }
    }
    return ticks.length ? ticks : [minTs];
  }
  const stepD = Math.max(1, Math.round(graphNiceStep(Math.max(1,spanDays), targetCount)));
  const stepMs = stepD*GRAPH_DAY_MS;
  const ticks = [];
  for (let t = Math.ceil(minTs/stepMs)*stepMs; t <= maxTs; t += stepMs) ticks.push(t);
  return ticks.length ? ticks : [minTs];
}
// Gemeinsame Feldliste für X UND Y im Modus "Frei" (Datum/Jahr/Monat/Std.
// oder jedes numerische Flugdatenfeld) — beide Achsen bieten bewusst
// exakt dieselbe Auswahl. zeroBased steuert, ob eine Achse bei 0 beginnt
// (additive Grössen) oder am tatsächlichen Wertebereich (Höhen-/Peak-
// Werte sowie Datum/Jahr/Monat/Std., sonst läge z.B. "Start müM" fast
// nur oberhalb der Mitte der Fläche, und "Datum" bei Jahr 1970).
const GRAPH_FREE_FIELDS = [
  { field:"nummer", label:"Nummer", unit:"", zeroBased:false },
  { field:"datum", label:"Datum", unit:"", zeroBased:false },
  { field:"jahr",  label:"Jahr",  unit:"", zeroBased:false },
  { field:"monat", label:"Monat", unit:"", zeroBased:false },
  { field:"std",   label:"Std.",  unit:"", zeroBased:false },
  ...GRAPH_Y_BASE_FIELDS.map(({field,label,unit,aggs}) => ({field,label,unit,zeroBased:aggs.includes("sum")})),
];
// X-Feldliste im Modus "Gruppiert": dieselben kategorischen Felder wie
// bisher (GROUP_FIELDS, identisch mit der Flugliste-Gruppierung) plus
// dieselben numerischen Felder wie in "Frei" (Dauer, Distanz, Höhe,
// Max.Steigen/Sinken usw. — "Bewertung" gibt es schon in GROUP_FIELDS,
// daher hier ausgeschlossen). "Datum"/"Jahr"/"Monat"/"Std." bleiben nur
// über GROUP_FIELDS wählbar (dort schon sinnvoll gruppiert, exaktes Datum
// als Balken-Kriterium wäre praktisch ein Balken pro Flug).
const GRAPH_X_NUMERIC_FIELDS = GRAPH_Y_BASE_FIELDS.filter(bf => bf.field !== "rating");
const GRAPH_X_FIELDS = [...GROUP_FIELDS, ...GRAPH_X_NUMERIC_FIELDS.map(({field,label})=>({id:field,label}))];
// Für die Balken-Sortierung: welche X-Felder numerisch statt alphabetisch/
// nach Häufigkeit sortiert werden (GRAPH_NUMERIC_X_FIELDS bleibt unverändert,
// da es auch für die "schönen" Tick-Rundung im Modus "Frei" verwendet wird).
const GRAPH_X_SORT_NUMERIC_FIELDS = new Set([...GRAPH_NUMERIC_X_FIELDS, ...GRAPH_X_NUMERIC_FIELDS.map(bf=>bf.field)]);
function formatFreeFieldValue(v, fieldDef) {
  if (!fieldDef) return String(Math.round(v));
  if (fieldDef.field === "datum") return fmtDateShort(v);
  if (fieldDef.field === "dauer") return v.toFixed(1).replace(".", ",") + "h";
  const decimals = ["speed","rating","maxsteigen","maxsinken"].includes(fieldDef.field) ? 1 : 0;
  const num = decimals ? v.toFixed(1).replace(".", ",") : String(Math.round(v));
  return fieldDef.unit ? num + " " + fieldDef.unit : num;
}
function graphFreeFieldValue(f, field) {
  if (field === "datum") return parseDateToTs(f.date);
  if (GRAPH_FREE_VIA_SORTFIELD.has(field)) return sortFieldValue(f, field);
  return flightFieldValue(f, field) || 0;
}
// Formatiert einen reinen Achsenwert (nicht an einen bestimmten Flug
// gebunden — für Ticks, die aus der Spanne berechnet statt von einem
// echten Flug abgelesen werden) je nach Feld.
function graphFormatAxisValue(fieldId, v) {
  if (fieldId === "datum") return fmtDateShort(v);
  if (fieldId === "monat") return MONTH_NAMES_DE[Math.round(v)-1] || String(Math.round(v));
  if (fieldId === "std") return String(Math.round(v)).padStart(2,"0")+" Uhr";
  if (fieldId === "jahr") return String(Math.round(v));
  return formatFreeFieldValue(v, GRAPH_FREE_FIELDS.find(x=>x.field===fieldId));
}
// Ticks für eine "Frei"-Achse (X oder Y, dieselbe Logik für beide): Datum
// bekommt Kalender-Ticks, diskrete Felder (Jahr/Monat/Std./Bewertung)
// ganzzahlige, alle anderen "schöne" Dezimal-Ticks — immer nur innerhalb
// der aktuell sichtbaren Spanne [lo,hi].
function graphAxisTicks(fieldId, lo, hi) {
  if (fieldId === "datum") return graphNiceDateTicks(lo, hi, 5);
  return computeNiceTicks(lo, hi, 7, GRAPH_NUMERIC_X_FIELDS.has(fieldId));
}
// Einfache lineare Regression (kleinste Quadrate) für die Trendlinie in
// beiden Graph-Modi. Liefert null, wenn sie statistisch nicht sinnvoll
// ist: zu wenige Punkte (<3), oder X ohne jede Streuung (Steigung nicht
// bestimmbar, z.B. wenn alle Punkte im selben Jahr liegen).
function linearRegression(points) {
  const pts = points.filter(p => Number.isFinite(p.x) && Number.isFinite(p.y));
  if (pts.length < 3) return null;
  const n = pts.length;
  const meanX = pts.reduce((a,p)=>a+p.x, 0) / n;
  const meanY = pts.reduce((a,p)=>a+p.y, 0) / n;
  let num = 0, den = 0;
  for (const p of pts) { num += (p.x-meanX)*(p.y-meanY); den += (p.x-meanX)**2; }
  if (den === 0) return null;
  const slope = num/den;
  return { slope, intercept: meanY - slope*meanX };
}
// Baut die URL für den Sprung von Graph zur Flugliste (mit Rücksprung-
// Mechanismus, wie ihn die Schirm/Startplatz/…-Zeilen der Statistik schon
// verwenden): "graph" als tableId im sessionStorage hinterlegen, damit
// die Statistik-Seite beim Zurückkommen automatisch wieder das Graph-
// Badge öffnet, statt auf der Badge-Übersicht zu landen.
function graphFluglisteUrl(filterText) {
  try { sessionStorage.setItem("statistik:returnState", JSON.stringify({ tableId: "graph", rowName: null })); } catch {}
  const params = new URLSearchParams();
  if (filterText) params.set("filter", filterText);
  params.set("returnTo", "statistik.html");
  return `flugbuch.html?${params.toString()}`;
}

function GraphSection({ flights }) {
  const [listSettings, setListSettings] = useState(null);
  const [mode, setMode] = useState("grouped"); // "grouped" | "free"
  const [xField, setXField] = useState("jahr");
  const [g2Field, setG2Field] = useState("");
  const [drillValue, setDrillValue] = useState("Alle");
  const [yMetric, setYMetric] = useState("count");
  const [hideEmpty, setHideEmpty] = useState(false);
  const [showTrend, setShowTrend] = useState(true);
  const [xReversed, setXReversed] = useState(false);
  const [xSortByValue, setXSortByValue] = useState(false); // nur bei kategorischem X: A-Z vs. nach Y-Wert
  const [yReversed, setYReversed] = useState(false);
  const [freeX, setFreeX] = useState("datum");
  const [freeY, setFreeY] = useState("distanz");
  const [view, setView] = useState(null); // {x0,x1,y0,y1} im Domain der aktiven Achsen, null = volle Spanne
  // Tatsächlich verfügbare Breite UND Höhe der Zeichenfläche (CSS-Pixel) —
  // ersetzt vorher feste Werte (300 / 122), damit der Graph im Vollbild auf
  // Desktop/iPad (und beim Drehen ins Querformat) wirklich die ganze
  // verfügbare Bildschirmfläche nutzt statt nur in der Mitte klein zu
  // bleiben (siehe attachChartTouch/ResizeObserver unten).
  const [chartW, setChartW] = useState(300);
  const [chartH, setChartH] = useState(170);
  const chartGeomRef = useRef(null); // {padLeft,padTop,plotW,plotH,fullX0,fullX1,fullY0,fullY1} — pro Render aktualisiert
  const viewRef = useRef(null);
  const pinchRef = useRef(null);
  const panRef = useRef(null);

  const loadSync = () => {
    (async () => {
      let s = {};
      try {
        const r = await window.storage.get("flugbuchListSettings");
        if (r && r.value) s = JSON.parse(r.value);
      } catch (e) { /* noch keine Flugliste-Einstellungen gespeichert */ }
      setListSettings(s);
      setMode(s.group1Id ? "grouped" : "free");
      setXField(s.group1Id || "jahr");
      setG2Field(s.group2Id || "");
      setDrillValue("Alle");
    })();
  };
  useEffect(loadSync, []);
  const resetZoom = () => setView(null);
  useEffect(resetZoom, [mode, xField, yMetric, drillValue, xReversed, xSortByValue, yReversed, hideEmpty, freeX, freeY]);

  // ── Pinch-Zoom/Pan ──────────────────────────────────────────────────
  // Echter Bereichs-Zoom: "view" hält den aktuell sichtbaren Ausschnitt
  // im Datenraum der jeweils aktiven Achse (Index-Bereich bei Balken,
  // Werte-/Zeitbereich bei "Frei"). Pinch verengt/erweitert ihn um die
  // Mitte des jeweiligen Gesten-Starts, Verschieben (ein Finger)
  // verschiebt ihn — dadurch werden Balken/Punkte beim Hineinzoomen
  // tatsächlich grösser statt nur optisch vergrössert zu werden.
  //
  // Echte Touch-Events statt Pointer Events: Safari/iOS unterstützt die
  // Pointer-Events-API bei Mehrfingergesten unzuverlässig (führte auf dem
  // echten Gerät zu einem Absturz beim Pinchen). Touchmove muss zudem
  // preventDefault() aufrufen können, damit Safari während der Geste
  // nicht selbst die ganze Seite scrollt/zoomt — React hängt seine
  // synthetischen Touch-Handler passiv ein (preventDefault dort wirkungs-
  // los), deshalb hier direkt am DOM-Element registriert, per Callback-
  // Ref (nicht useEffect) — die Zeichenfläche wird bedingt gerendert, ein
  // useEffect mit leerem Dependency-Array würde die Listener nie
  // anhängen, wenn das Element beim allerersten Render noch nicht
  // existiert. Start-/Zwischenwerte werden aus den Gesten-Refs immer
  // SOFORT synchron gelesen und als fertige Zahl in die setView-Updater-
  // Funktion eingeschlossen statt darin nochmal auf die Ref zuzugreifen —
  // React kann diese Updater verzögert ausführen, und bis dahin könnte
  // z.B. touchend die Ref längst zurückgesetzt haben.
  const chartTouchCleanupRef = useRef(null);
  const attachChartTouch = useCallback((el) => {
    if (chartTouchCleanupRef.current) { chartTouchCleanupRef.current(); chartTouchCleanupRef.current = null; }
    if (!el) return;
    const dist2 = (a, b) => Math.hypot(a.clientX-b.clientX, a.clientY-b.clientY);
    const onStart = (e) => {
      if (e.touches.length === 2) {
        pinchRef.current = { dist: dist2(e.touches[0], e.touches[1]), view: { ...viewRef.current } };
        panRef.current = null;
      } else if (e.touches.length === 1) {
        panRef.current = { x: e.touches[0].clientX, y: e.touches[0].clientY, view: { ...viewRef.current } };
        pinchRef.current = null;
      }
    };
    const onMove = (e) => {
      const g = chartGeomRef.current;
      if (!g) return;
      if (e.touches.length === 2 && pinchRef.current) {
        e.preventDefault();
        const { dist: startDist, view: sv } = pinchRef.current;
        const factor = dist2(e.touches[0], e.touches[1]) / (startDist || 1);
        const fullWX = g.fullX1 - g.fullX0, fullWY = g.fullY1 - g.fullY0;
        const minFrac = 1/8;
        let widthX = Math.max(fullWX*minFrac, Math.min(fullWX, (sv.x1-sv.x0)/factor));
        let widthY = Math.max(fullWY*minFrac, Math.min(fullWY, (sv.y1-sv.y0)/factor));
        const cx = (sv.x0+sv.x1)/2, cy = (sv.y0+sv.y1)/2;
        let x0 = cx-widthX/2, x1 = cx+widthX/2, y0 = cy-widthY/2, y1 = cy+widthY/2;
        if (x0 < g.fullX0) { x1 += g.fullX0-x0; x0 = g.fullX0; }
        if (x1 > g.fullX1) { x0 -= x1-g.fullX1; x1 = g.fullX1; }
        if (y0 < g.fullY0) { y1 += g.fullY0-y0; y0 = g.fullY0; }
        if (y1 > g.fullY1) { y0 -= y1-g.fullY1; y1 = g.fullY1; }
        setView({ x0, x1, y0, y1 });
      } else if (e.touches.length === 1 && panRef.current) {
        e.preventDefault();
        const { x: startX, y: startY, view: sv } = panRef.current;
        const dxPx = e.touches[0].clientX - startX, dyPx = e.touches[0].clientY - startY;
        const widthX = sv.x1-sv.x0, widthY = sv.y1-sv.y0;
        const dxData = (dxPx/g.plotW) * widthX;
        const dyData = -(dyPx/g.plotH) * widthY; // Bildschirm-Y wächst nach unten, Werte-Y nach oben
        // Scrollrichtung Y: Ansicht bewegt sich MIT dem Finger (klassische
        // Scrollbar-Logik). Scrollrichtung X (auf expliziten Wunsch nochmals
        // umgekehrt): dort bewegt sich stattdessen der INHALT mit dem
        // Finger — bewusst unterschiedliche Konvention pro Achse.
        let x0 = sv.x0-dxData, x1 = sv.x1-dxData;
        let y0 = sv.y0+dyData, y1 = sv.y1+dyData;
        const fullWX = g.fullX1-g.fullX0, fullWY = g.fullY1-g.fullY0;
        if (x0 < g.fullX0) { x1 = g.fullX0+fullWX*((x1-x0)/fullWX); x0 = g.fullX0; }
        if (x1 > g.fullX1) { x0 = g.fullX1-(x1-x0); x1 = g.fullX1; }
        if (y0 < g.fullY0) { y1 = g.fullY0+(y1-y0); y0 = g.fullY0; }
        if (y1 > g.fullY1) { y0 = g.fullY1-(y1-y0); y1 = g.fullY1; }
        setView({ x0, x1, y0, y1 });
      }
    };
    const onEnd = (e) => {
      if (e.touches.length < 2) pinchRef.current = null;
      if (e.touches.length === 1) {
        panRef.current = { x: e.touches[0].clientX, y: e.touches[0].clientY, view: { ...viewRef.current } };
      } else {
        panRef.current = null;
      }
    };
    el.addEventListener("touchstart", onStart, { passive: true });
    el.addEventListener("touchmove", onMove, { passive: false });
    el.addEventListener("touchend", onEnd, { passive: true });
    el.addEventListener("touchcancel", onEnd, { passive: true });
    // Breite UND Höhe der Zeichenfläche laufend messen (Vollbild-Umstellung,
    // Dreh ins Querformat, Fenstergrösse) statt fester Konstanten —
    // Grundlage für W/W2/plotH/plotH2 unten. getBoundingClientRect() statt
    // entry.contentRect: liefert die volle sichtbare Fläche inkl.
    // Rahmen/Padding (hier zwar keins gesetzt, aber so bleibt es korrekt,
    // falls sich das mal ändert).
    const ro = new ResizeObserver(() => {
      const r = el.getBoundingClientRect();
      setChartW(prev => (Math.abs(prev - r.width) > 1 ? r.width : prev));
      setChartH(prev => (Math.abs(prev - r.height) > 1 ? r.height : prev));
    });
    ro.observe(el);
    chartTouchCleanupRef.current = () => {
      el.removeEventListener("touchstart", onStart);
      el.removeEventListener("touchmove", onMove);
      el.removeEventListener("touchend", onEnd);
      el.removeEventListener("touchcancel", onEnd);
      ro.disconnect();
    };
  }, []);

  if (!listSettings) return null;

  const filterText = listSettings.filterText || "";
  const baseFiltered = matchFlights(flights, filterText);
  const filtered = (g2Field && drillValue !== "Alle")
    ? baseFiltered.filter(f => formatSortValue(f, g2Field) === drillValue)
    : baseFiltered;

  const drillOptions = g2Field
    ? ["Alle", ...[...new Set(baseFiltered.map(f => formatSortValue(f, g2Field)).filter(v => v && v !== "—"))]
        .sort((a,b) => String(a).localeCompare(String(b), "de", {numeric:true, sensitivity:"base"}))]
    : null;
  const g2Label = g2Field ? (GROUP_FIELDS.find(g => g.id === g2Field)?.label || g2Field) : null;

  // ── Modus "Gruppiert": wie bisher, Balken je Gr.-1°-Wert ──
  const xLabel = GRAPH_X_FIELDS.find(g => g.id === xField)?.label || xField;
  const buckets = new Map();
  filtered.forEach(f => {
    const key = sortFieldValue(f, xField);
    if (key === "" || key == null) return;
    if (!buckets.has(key)) buckets.set(key, { key, label: formatSortValue(f, xField), flights: [] });
    buckets.get(key).flights.push(f);
  });
  let rows = [...buckets.values()].map(b => ({ ...b, value: graphYMetricValue(b.flights, yMetric) }));
  // Numerische Felder (Jahr, Distanz, …) immer nach Wert. Kategorische
  // (Reise, Schirm, …) standardmässig alphabetisch — neutral und
  // vorhersehbar statt automatisch nach Flugzahl —, wahlweise aber auch
  // nach dem angezeigten Y-Wert (xSortByValue, per eigenem Umschalter
  // wählbar, nur wenn X kategorisch ist). ⇅ kehrt die jeweils aktive
  // Sortierung um.
  const xIsCategorical = !GRAPH_X_SORT_NUMERIC_FIELDS.has(xField);
  if (!xIsCategorical) rows.sort((a,b) => a.key - b.key);
  else if (xSortByValue) rows.sort((a,b) => a.value - b.value);
  else rows.sort((a,b) => String(a.label).localeCompare(String(b.label), "de", {numeric:true, sensitivity:"base"}));
  if (xReversed) rows.reverse();
  const emptyCount = rows.filter(r => !r.value).length;
  if (hideEmpty) rows = rows.filter(r => r.value);

  const W = Math.max(240, Math.round(chartW)), padLeft = 34, padRight = 10, plotW = W-padLeft-padRight;
  // Y-Spanne wie im Frei-Modus: additive Grössen (Anzahl/Gesamt/Ø) bei 0
  // beginnend, Peak-Werte (Max., aber auch Ø von Höhen-/Rate-Feldern) am
  // tatsächlichen Wertebereich — sonst würden z.B. negativ gespeicherte
  // "Ø/Max. Sinken"-Werte (siehe graphYMetricValue) in einer festen
  // 0-bis-Maximum-Achse gar nicht sichtbar sein.
  const yMetricDef = GRAPH_Y_METRICS.find(m => m.id === yMetric);
  const barValues = rows.map(r => r.value);
  const barValMax = barValues.length ? Math.max(...barValues) : 0;
  const barValMin = barValues.length ? Math.min(...barValues) : 0;
  let barY0, barY1;
  if (yMetricDef?.zeroBased !== false) {
    barY0 = 0;
    barY1 = graphNiceMax(Math.max(1, barValMax));
  } else {
    const range = Math.max(1, barValMax - barValMin);
    const step = Math.pow(10, Math.floor(Math.log10(range/4)));
    barY0 = Math.floor(barValMin/step)*step;
    barY1 = Math.ceil(barValMax/step)*step;
    if (barY1 === barY0) barY1 = barY0 + step;
  }
  const barFullView = { x0: 0, x1: Math.max(1, rows.length), y0: barY0, y1: barY1 };
  const barView = (mode==="grouped" && view) ? view : barFullView;
  const visW = Math.max(0.0001, barView.x1-barView.x0);
  const slot = plotW / visW;
  const barW = slot * 0.6;
  const visibleRows = rows
    .map((r,i) => ({ ...r, idx: i }))
    .filter(r => r.idx+1 > barView.x0 && r.idx < barView.x1);
  // Balken-Beschriftungen vorbereiten: X-Achsen-Label (unten) einheitlich
  // für ALLE Balken (anyRotate — entweder alle waagrecht oder alle
  // senkrecht), Werte-Text (über/im Balken) dagegen individuell pro Balken
  // — er wird nur senkrecht, wenn er breiter als der Balken ist, und landet
  // dann innerhalb des Balkens sofern der Platz reicht, sonst darüber.
  const CHAR_W = 4.6; // grobe Zeichenbreite bei 8px Schrift (X-Achse)
  const VALUE_CHAR_W = 5.0; // grobe Zeichenbreite bei 8px fett (Werte-Text)
  const MAX_LABEL_CHARS = 18;
  const dispRows = visibleRows.map(r => {
    const label = r.label.length > MAX_LABEL_CHARS ? r.label.slice(0, MAX_LABEL_CHARS-1)+"…" : r.label;
    const valueText = formatGraphYMetric(r.value, yMetric);
    return { ...r, dispLabel: label, rotateLabel: label.length*CHAR_W > barW,
      valueText, valueVertical: valueText.length*VALUE_CHAR_W > barW };
  });
  const anyRotate = dispRows.some(r => r.rotateLabel);
  const maxLabelLen = anyRotate ? Math.max(...dispRows.filter(r=>r.rotateLabel).map(r=>r.dispLabel.length)) : 0;
  const padBottom = anyRotate ? Math.min(96, Math.max(22, maxLabelLen*CHAR_W + 12)) : 22;
  const anyValueVertical = dispRows.some(r => r.valueVertical);
  const maxValueLen = anyValueVertical ? Math.max(...dispRows.filter(r=>r.valueVertical).map(r=>r.valueText.length)) : 0;
  // Nur Platz reservieren, falls ein Werte-Text überhaupt senkrecht werden
  // könnte — ob er dann tatsächlich oberhalb statt im Balken landet,
  // entscheidet sich erst weiter unten pro Balken anhand des dort
  // tatsächlich verfügbaren Platzes über dem jeweiligen Balken-Anfang
  // (bei einem Deckel von 70 kann das bei besonders langen Werten und
  // hohen Balken knapp werden — dafür ist "innerhalb" die Rückfalloption).
  const padTop = anyValueVertical ? Math.min(70, Math.max(14, maxValueLen*VALUE_CHAR_W + 8)) : 14;
  // Höhe der Zeichenfläche wie schon die Breite: tatsächlich gemessen
  // (chartH, ResizeObserver in attachChartTouch) statt fest — füllt so
  // auf Desktop/iPad wirklich die verfügbare Bildschirmhöhe im Vollbild,
  // nicht nur die Breite.
  const plotH = Math.max(80, Math.round(chartH) - padTop - padBottom);
  const scaleY = v => {
    let t = (v-barView.y0)/((barView.y1-barView.y0)||1);
    if (yReversed) t = 1-t;
    return padTop + plotH - t*plotH;
  };
  const ticks = computeNiceTicks(barView.y0, barView.y1, 7, yMetric==="count");
  const H = padTop + plotH + padBottom;
  const labelY = padTop + plotH + 10;
  // Trendlinie nur bei numerisch/geordnetem X (Jahr, Distanz, Höhe, …) —
  // bei kategorischen Feldern (Schirm, Startplatz, …) gibt es keine
  // sinnvolle Reihenfolge, gegen die man regressieren könnte.
  // +r.key erzwingt eine Zahl: sortFieldValue liefert bei "jahr" je nach
  // Datenherkunft eine Zahl oder einen String (f.year), siehe derselbe
  // Stolperstein bereits in graphYMetricValue.
  const trendGrouped = GRAPH_X_SORT_NUMERIC_FIELDS.has(xField)
    ? linearRegression(rows.map(r => ({ x: +r.key, y: r.value }))) : null;

  // ── Modus "Frei": ein Punkt pro Flug, X/Y teilen sich dieselbe Feldliste ──
  const freeXDef = GRAPH_FREE_FIELDS.find(f => f.field === freeX);
  const freeYDef = GRAPH_FREE_FIELDS.find(f => f.field === freeY);
  const freePointsRaw = filtered
    .map(f => {
      const xv = graphFreeFieldValue(f, freeX);
      const yv = graphFreeFieldValue(f, freeY);
      return { key: f.id, x: xv, y: yv, xLabel: graphFormatAxisValue(freeX, xv) };
    })
    .filter(p => (freeX !== "datum" || p.x > 0) && (freeY !== "datum" || p.y > 0))
    .sort((a,b) => a.x - b.x);
  const freeEmptyCount = freePointsRaw.filter(p => !p.y).length;
  const freePoints = hideEmpty ? freePointsRaw.filter(p => p.y) : freePointsRaw;

  const padLeft2 = 40, padRight2 = 14, padTop2 = 14, padBottom2 = 26, W2 = Math.max(240, Math.round(chartW));
  const plotH2 = Math.max(80, Math.round(chartH) - padTop2 - padBottom2);
  const plotW2 = W2 - padLeft2 - padRight2;
  const H2 = padTop2 + plotH2 + padBottom2;
  const freeXs = freePoints.map(p => p.x), freeYs = freePoints.map(p => p.y);
  const fXMinFull = freeXs.length ? Math.min(...freeXs) : 0, fXMaxFullRaw = freeXs.length ? Math.max(...freeXs) : 1;
  const fXMaxFull = fXMaxFullRaw > fXMinFull ? fXMaxFullRaw : fXMinFull+1;
  const freeYMaxRaw = freeYs.length ? Math.max(...freeYs) : 0, freeYMinRaw = freeYs.length ? Math.min(...freeYs) : 0;
  let fYMinFull, fYMaxFull;
  if (freeYDef?.zeroBased !== false) {
    fYMinFull = 0;
    fYMaxFull = graphNiceMax(Math.max(1, freeYMaxRaw));
  } else {
    const range = Math.max(1, freeYMaxRaw - freeYMinRaw);
    const step = Math.pow(10, Math.floor(Math.log10(range/4)));
    fYMinFull = Math.floor(freeYMinRaw/step)*step;
    fYMaxFull = Math.ceil(freeYMaxRaw/step)*step;
    if (fYMaxFull === fYMinFull) fYMaxFull = fYMinFull + step;
  }
  const freeFullView = { x0: fXMinFull, x1: fXMaxFull, y0: fYMinFull, y1: fYMaxFull };
  const freeView = (mode==="free" && view) ? view : freeFullView;
  const zoomFactorFree = (fXMaxFull-fXMinFull) / Math.max(0.0001, freeView.x1-freeView.x0);
  const markScale = Math.min(2.2, 1 + Math.max(0, zoomFactorFree-1)*0.3);
  const scaleX2 = x => {
    let t = freeView.x1 > freeView.x0 ? (x-freeView.x0)/(freeView.x1-freeView.x0) : 0.5;
    if (xReversed) t = 1-t;
    return padLeft2 + t*plotW2;
  };
  const scaleY2 = y => {
    let t = (y-freeView.y0)/((freeView.y1-freeView.y0)||1);
    if (yReversed) t = 1-t;
    return padTop2 + plotH2 - t*plotH2;
  };
  const freeTicksY = graphAxisTicks(freeY, freeView.y0, freeView.y1);
  const freeTicksX = graphAxisTicks(freeX, freeView.x0, freeView.x1);
  const trendFree = linearRegression(freePoints.map(p => ({ x: p.x, y: p.y })));

  // Aktuelle Geometrie/volle Spanne für die Touch-Handler bereitstellen —
  // direkt bei jedem Render aktualisiert (kein useEffect nötig), damit
  // die stabile Callback-Ref-Funktion immer die frischesten Werte sieht.
  chartGeomRef.current = mode === "grouped"
    ? { padLeft, padTop, plotW, plotH, fullX0: barFullView.x0, fullX1: barFullView.x1, fullY0: barFullView.y0, fullY1: barFullView.y1 }
    : { padLeft: padLeft2, padTop: padTop2, plotW: plotW2, plotH: plotH2, fullX0: freeFullView.x0, fullX1: freeFullView.x1, fullY0: freeFullView.y0, fullY1: freeFullView.y1 };
  viewRef.current = mode === "grouped" ? barView : freeView;

  const curEmptyCount = mode === "grouped" ? emptyCount : freeEmptyCount;
  const curYLabel = mode === "grouped" ? (GRAPH_Y_METRICS.find(m=>m.id===yMetric)?.label||"") : (freeYDef?.label||"");
  const isEmptyChart = mode === "grouped" ? rows.length === 0 : freePoints.length === 0;
  const zoomed = !!view;

  return (
    <div style={{background:"rgba(255,255,255,0.04)",border:"1px solid rgba(255,255,255,0.08)",borderRadius:10,padding:12,boxSizing:"border-box",height:"100%",display:"flex",flexDirection:"column"}}>
      <a href={graphFluglisteUrl(filterText)} title="Zur Flugliste"
        style={{display:"flex",alignItems:"center",gap:8,background:"rgba(255,255,255,0.05)",border:"1px solid rgba(255,255,255,0.06)",borderRadius:9,padding:"8px 10px",marginBottom:10,textDecoration:"none",color:"inherit"}}>
        <span style={{fontSize:13,flexShrink:0}}>🔗</span>
        <span style={{flex:1,fontSize:12,color:"rgba(232,244,253,0.6)",lineHeight:1.35}}>
          Bezug: <b style={{color:"#e8f4fd"}}>{mode==="grouped" ? (listSettings.group1Id ? "Gr. 1° "+xLabel : "kein Gr. 1° — Standard "+xLabel) : `Frei: ${freeXDef?.label} → ${freeYDef?.label}`}</b>
          {filterText && <> · Filter «<b style={{color:"#e8f4fd"}}>{filterText}</b>»</>}
          {g2Field && drillValue !== "Alle" && <> · <b style={{color:"#e8f4fd"}}>{g2Label}: {drillValue}</b></>} · {filtered.length} Flüge
        </span>
        <button onClick={e=>{ e.preventDefault(); e.stopPropagation(); loadSync(); }} title="Mit Flugliste neu abgleichen"
          style={{width:24,height:24,borderRadius:7,background:"rgba(255,255,255,0.08)",border:"1px solid rgba(255,255,255,0.12)",display:"flex",alignItems:"center",justifyContent:"center",fontSize:12,color:"rgba(232,244,253,0.7)",cursor:"pointer",flexShrink:0}}>
          ↻
        </button>
        <span style={{fontSize:12,color:"rgba(232,244,253,0.3)",flexShrink:0}}>›</span>
      </a>

      <div style={{display:"flex",gap:6,marginBottom:10}}>
        <button onClick={()=>setMode("grouped")}
          style={{flex:1,padding:"7px 0",borderRadius:8,fontSize:12,fontWeight:700,cursor:"pointer",background:mode==="grouped"?"rgba(34,211,238,0.15)":"rgba(255,255,255,0.05)",border:`1px solid ${mode==="grouped"?"rgba(34,211,238,0.4)":"rgba(255,255,255,0.1)"}`,color:mode==="grouped"?"#22d3ee":"rgba(232,244,253,0.5)"}}>
          Gruppiert
        </button>
        <button onClick={()=>setMode("free")}
          style={{flex:1,padding:"7px 0",borderRadius:8,fontSize:12,fontWeight:700,cursor:"pointer",background:mode==="free"?"rgba(34,211,238,0.15)":"rgba(255,255,255,0.05)",border:`1px solid ${mode==="free"?"rgba(34,211,238,0.4)":"rgba(255,255,255,0.1)"}`,color:mode==="free"?"#22d3ee":"rgba(232,244,253,0.5)"}}>
          Frei
        </button>
      </div>

      {mode==="grouped" ? (
        <div style={{display:"flex",gap:8,marginBottom:10}}>
          <div style={{flex:1,minWidth:0}}>
            <p style={{fontSize:9.5,fontWeight:800,letterSpacing:"0.06em",textTransform:"uppercase",color:"rgba(232,244,253,0.32)",margin:"0 0 4px 2px"}}>X-Achse</p>
            <div style={{display:"flex",gap:6}}>
              <select value={xField} onChange={e=>setXField(e.target.value)}
                style={{flex:1,minWidth:0,background:"rgba(255,255,255,0.08)",border:"1px solid rgba(255,255,255,0.12)",borderRadius:8,padding:"7px 6px",color:"#e8f4fd",fontSize:12,fontWeight:700}}>
                {GRAPH_X_FIELDS.map(g=><option key={g.id} value={g.id} style={{background:"#0a1628"}}>{g.label}</option>)}
              </select>
              <button onClick={()=>setXReversed(r=>!r)} title="Reihenfolge umkehren"
                style={{flexShrink:0,width:32,boxSizing:"border-box",display:"flex",alignItems:"center",justifyContent:"center",padding:0,background:xReversed?"rgba(34,211,238,0.15)":"rgba(255,255,255,0.06)",border:`1px solid ${xReversed?"rgba(34,211,238,0.4)":"rgba(255,255,255,0.1)"}`,borderRadius:8,color:xReversed?"#22d3ee":"#fff",fontSize:14,fontWeight:700,cursor:"pointer"}}>
                ⇅
              </button>
            </div>
          </div>
          <div style={{flex:1,minWidth:0}}>
            <p style={{fontSize:9.5,fontWeight:800,letterSpacing:"0.06em",textTransform:"uppercase",color:"rgba(232,244,253,0.32)",margin:"0 0 4px 2px"}}>Y-Achse</p>
            <div style={{display:"flex",gap:6}}>
              <select value={yMetric} onChange={e=>setYMetric(e.target.value)}
                style={{flex:1,minWidth:0,background:"rgba(255,255,255,0.08)",border:"1px solid rgba(255,255,255,0.12)",borderRadius:8,padding:"7px 6px",color:"#e8f4fd",fontSize:12,fontWeight:700}}>
                {GRAPH_Y_METRICS.map(m=><option key={m.id} value={m.id} style={{background:"#0a1628"}}>{m.label}</option>)}
              </select>
              <button onClick={()=>setYReversed(r=>!r)} title="Y-Achse umkehren"
                style={{flexShrink:0,width:32,boxSizing:"border-box",display:"flex",alignItems:"center",justifyContent:"center",padding:0,background:yReversed?"rgba(34,211,238,0.15)":"rgba(255,255,255,0.06)",border:`1px solid ${yReversed?"rgba(34,211,238,0.4)":"rgba(255,255,255,0.1)"}`,borderRadius:8,color:yReversed?"#22d3ee":"#fff",fontSize:14,fontWeight:700,cursor:"pointer"}}>
                ⇅
              </button>
            </div>
          </div>
        </div>
      ) : null}
      {mode==="grouped" && xIsCategorical && (
        <div onClick={()=>setXSortByValue(v=>!v)} style={{display:"flex",alignItems:"center",gap:8,marginBottom:10,cursor:"pointer"}}>
          <div style={{flexShrink:0,width:18,height:18,borderRadius:5,border:`2px solid ${xSortByValue?"#22d3ee":"rgba(232,244,253,0.3)"}`,background:xSortByValue?"#22d3ee":"transparent",display:"flex",alignItems:"center",justifyContent:"center"}}>
            {xSortByValue && <span style={{color:"#0a1628",fontSize:12,fontWeight:900}}>✓</span>}
          </div>
          <span style={{fontSize:12,color:"rgba(232,244,253,0.6)"}}>X-Achse nach Y-Wert sortieren (statt A–Z)</span>
        </div>
      )}
      {mode==="free" && (<>
        <div style={{display:"flex",gap:8,marginBottom:10}}>
          <div style={{flex:1,minWidth:0}}>
            <p style={{fontSize:9.5,fontWeight:800,letterSpacing:"0.06em",textTransform:"uppercase",color:"rgba(232,244,253,0.32)",margin:"0 0 4px 2px"}}>X-Achse</p>
            <div style={{display:"flex",gap:6}}>
              <select value={freeX} onChange={e=>setFreeX(e.target.value)}
                style={{flex:1,minWidth:0,background:"rgba(255,255,255,0.08)",border:"1px solid rgba(255,255,255,0.12)",borderRadius:8,padding:"7px 6px",color:"#e8f4fd",fontSize:12,fontWeight:700}}>
                {GRAPH_FREE_FIELDS.map(f=><option key={f.field} value={f.field} style={{background:"#0a1628"}}>{f.label}</option>)}
              </select>
              <button onClick={()=>setXReversed(r=>!r)} title="X-Achse umkehren"
                style={{flexShrink:0,width:32,boxSizing:"border-box",display:"flex",alignItems:"center",justifyContent:"center",padding:0,background:xReversed?"rgba(34,211,238,0.15)":"rgba(255,255,255,0.06)",border:`1px solid ${xReversed?"rgba(34,211,238,0.4)":"rgba(255,255,255,0.1)"}`,borderRadius:8,color:xReversed?"#22d3ee":"#fff",fontSize:14,fontWeight:700,cursor:"pointer"}}>
                ⇅
              </button>
            </div>
          </div>
          <div style={{flex:1,minWidth:0}}>
            <p style={{fontSize:9.5,fontWeight:800,letterSpacing:"0.06em",textTransform:"uppercase",color:"rgba(232,244,253,0.32)",margin:"0 0 4px 2px"}}>Y-Achse</p>
            <div style={{display:"flex",gap:6}}>
              <select value={freeY} onChange={e=>setFreeY(e.target.value)}
                style={{flex:1,minWidth:0,background:"rgba(255,255,255,0.08)",border:"1px solid rgba(255,255,255,0.12)",borderRadius:8,padding:"7px 6px",color:"#e8f4fd",fontSize:12,fontWeight:700}}>
                {GRAPH_FREE_FIELDS.map(f=><option key={f.field} value={f.field} style={{background:"#0a1628"}}>{f.label}</option>)}
              </select>
              <button onClick={()=>setYReversed(r=>!r)} title="Y-Achse umkehren"
                style={{flexShrink:0,width:32,boxSizing:"border-box",display:"flex",alignItems:"center",justifyContent:"center",padding:0,background:yReversed?"rgba(34,211,238,0.15)":"rgba(255,255,255,0.06)",border:`1px solid ${yReversed?"rgba(34,211,238,0.4)":"rgba(255,255,255,0.1)"}`,borderRadius:8,color:yReversed?"#22d3ee":"#fff",fontSize:14,fontWeight:700,cursor:"pointer"}}>
                ⇅
              </button>
            </div>
          </div>
        </div>
      </>)}

      {drillOptions && (
        <div style={{marginBottom:10}}>
          <p style={{fontSize:9.5,fontWeight:800,letterSpacing:"0.06em",textTransform:"uppercase",color:"rgba(232,244,253,0.32)",margin:"0 0 4px 2px"}}>Aufschlüsseln nach {g2Label}</p>
          <select value={drillValue} onChange={e=>setDrillValue(e.target.value)}
            style={{width:"100%",background:"rgba(255,255,255,0.08)",border:"1px solid rgba(255,255,255,0.12)",borderRadius:8,padding:"7px 6px",color:"#e8f4fd",fontSize:12,fontWeight:700}}>
            {drillOptions.map(v=><option key={v} value={v} style={{background:"#0a1628"}}>{v}</option>)}
          </select>
        </div>
      )}

      {curEmptyCount > 0 && (
        <div onClick={()=>setHideEmpty(h=>!h)} style={{display:"flex",alignItems:"center",gap:8,marginBottom:10,cursor:"pointer"}}>
          <div style={{flexShrink:0,width:18,height:18,borderRadius:5,border:`2px solid ${hideEmpty?"#22d3ee":"rgba(232,244,253,0.3)"}`,background:hideEmpty?"#22d3ee":"transparent",display:"flex",alignItems:"center",justifyContent:"center"}}>
            {hideEmpty && <span style={{color:"#0a1628",fontSize:12,fontWeight:900}}>✓</span>}
          </div>
          <span style={{fontSize:12,color:"rgba(232,244,253,0.6)"}}>Leere ({curEmptyCount}) ausblenden — ohne Wert bei "{curYLabel}"</span>
        </div>
      )}

      {(mode==="grouped" ? trendGrouped : trendFree) && (
        <div onClick={()=>setShowTrend(s=>!s)} style={{display:"flex",alignItems:"center",gap:8,marginBottom:10,cursor:"pointer"}}>
          <div style={{flexShrink:0,width:18,height:18,borderRadius:5,border:`2px solid ${showTrend?"#fbbf24":"rgba(232,244,253,0.3)"}`,background:showTrend?"#fbbf24":"transparent",display:"flex",alignItems:"center",justifyContent:"center"}}>
            {showTrend && <span style={{color:"#0a1628",fontSize:12,fontWeight:900}}>✓</span>}
          </div>
          <span style={{fontSize:12,color:"rgba(232,244,253,0.6)"}}>Trendlinie anzeigen</span>
        </div>
      )}

      {isEmptyChart ? (
        <div style={{padding:"24px 0",textAlign:"center",fontSize:13,color:"rgba(232,244,253,0.35)"}}>Keine Flüge für diese Auswahl.</div>
      ) : (
        <div style={{position:"relative",flex:1,minHeight:0,display:"flex",flexDirection:"column"}}>
          <div
            ref={attachChartTouch}
            onDoubleClick={resetZoom}
            style={{overflow:"hidden",touchAction:"none",borderRadius:8,flex:1,minHeight:0}}>
            {mode==="grouped" ? (
              <svg viewBox={`0 0 ${W} ${H}`} width={W} height={H} style={{display:"block"}}>
                {ticks.map((t,i)=>{
                  const y = scaleY(t);
                  return (
                    <g key={i}>
                      <line x1={padLeft} y1={y} x2={W-padRight} y2={y} stroke="rgba(232,244,253,0.09)" strokeWidth="1"/>
                      <text x={padLeft-4} y={y+3} textAnchor="end" fontSize="8" fill="rgba(232,244,253,0.32)" style={{fontVariantNumeric:"tabular-nums"}}>{formatGraphYMetric(t, yMetric)}</text>
                    </g>
                  );
                })}
                {dispRows.map(r=>{
                  const cx = padLeft + (r.idx+0.5-barView.x0)*slot;
                  const y = scaleY(r.value);
                  const h = (padTop+plotH) - y;
                  // Werte-Text, mit Priorität: 1) waagrecht über dem Balken, falls
                  // er dort Platz hat. 2) sonst senkrecht oberhalb des Balkens,
                  // falls zwischen Balken-Anfang und oberem Diagrammrand genug
                  // Platz dafür ist. 3) sonst (Balken zu nahe am oberen Rand)
                  // senkrecht innerhalb des Balkens, randständig am oberen Ende,
                  // horizontal zentriert (dunkel für Kontrast). Pro Balken
                  // unabhängig entschieden.
                  const aboveFits = r.valueVertical && (y-4) >= r.valueText.length*VALUE_CHAR_W;
                  return (
                    <g key={r.key}>
                      <rect x={cx-barW/2} y={y} width={barW} height={Math.max(0,h)} rx="2.5" fill="#22d3ee" opacity="0.85"/>
                      {!r.valueVertical ? (
                        <text x={cx} y={y-4} textAnchor="middle" fontSize="8" fontWeight="700" fill="rgba(232,244,253,0.75)" style={{fontVariantNumeric:"tabular-nums"}}>{r.valueText}</text>
                      ) : aboveFits ? (
                        <text x={cx} y={y-4} transform={`rotate(-90 ${cx} ${y-4})`} textAnchor="start" dominantBaseline="middle" fontSize="8" fontWeight="700" fill="rgba(232,244,253,0.75)" style={{fontVariantNumeric:"tabular-nums"}}>{r.valueText}</text>
                      ) : (
                        <text x={cx} y={y+4} transform={`rotate(-90 ${cx} ${y+4})`} textAnchor="end" dominantBaseline="middle" fontSize="8" fontWeight="700" fill="#0a1628" style={{fontVariantNumeric:"tabular-nums"}}>{r.valueText}</text>
                      )}
                      {anyRotate ? (
                        <text x={cx} y={labelY} transform={`rotate(-90 ${cx} ${labelY})`} textAnchor="end" dominantBaseline="middle" fontSize="8" fill="rgba(232,244,253,0.4)">{r.dispLabel}</text>
                      ) : (
                        <text x={cx} y={H-6} textAnchor="middle" fontSize="8" fill="rgba(232,244,253,0.4)">{r.dispLabel}</text>
                      )}
                    </g>
                  );
                })}
                {showTrend && trendGrouped && (
                  <polyline points={dispRows.map(r => {
                    const cx = padLeft + (r.idx+0.5-barView.x0)*slot;
                    const ty = scaleY(trendGrouped.slope*r.key + trendGrouped.intercept);
                    return `${cx},${ty}`;
                  }).join(" ")} fill="none" stroke="#fbbf24" strokeWidth="1.5" strokeDasharray="4 3" opacity="0.8"/>
                )}
              </svg>
            ) : (
              <svg viewBox={`0 0 ${W2} ${H2}`} width={W2} height={H2} style={{display:"block"}}>
                {freeTicksY.map((t,i)=>{
                  const y = scaleY2(t);
                  return (
                    <g key={i}>
                      <line x1={padLeft2} y1={y} x2={W2-padRight2} y2={y} stroke="rgba(232,244,253,0.09)" strokeWidth="1"/>
                      <text x={padLeft2-4} y={y+3} textAnchor="end" fontSize="8" fill="rgba(232,244,253,0.32)" style={{fontVariantNumeric:"tabular-nums"}}>{graphFormatAxisValue(freeY, t)}</text>
                    </g>
                  );
                })}
                {showTrend && trendFree && (
                  <line x1={scaleX2(freeView.x0)} y1={scaleY2(trendFree.slope*freeView.x0 + trendFree.intercept)}
                    x2={scaleX2(freeView.x1)} y2={scaleY2(trendFree.slope*freeView.x1 + trendFree.intercept)}
                    stroke="#fbbf24" strokeWidth="1.5" strokeDasharray="4 3" opacity="0.8"/>
                )}
                {freePoints.map((p,i)=>(
                  <circle key={p.key||i} cx={scaleX2(p.x)} cy={scaleY2(p.y)} r={2.6*markScale} fill="#22d3ee"/>
                ))}
                {freeTicksX.map((t,i)=>(
                  <text key={i} x={scaleX2(t)} y={H2-8} textAnchor="middle" fontSize="8" fill="rgba(232,244,253,0.4)">{graphFormatAxisValue(freeX, t)}</text>
                ))}
              </svg>
            )}
          </div>
          {zoomed && (
            <button onClick={resetZoom} title="Zoom zurücksetzen"
              style={{position:"absolute",top:6,right:6,width:26,height:26,borderRadius:7,background:"rgba(10,15,25,0.75)",border:"1px solid rgba(255,255,255,0.2)",color:"#e8f4fd",fontSize:12,display:"flex",alignItems:"center",justifyContent:"center",cursor:"pointer"}}>
              ⤾
            </button>
          )}
          {!zoomed && (
            <div style={{textAlign:"center",fontSize:10,color:"rgba(232,244,253,0.28)",marginTop:4}}>🤏 Pinch zum Zoomen · ziehen zum Verschieben · Doppeltipp zurücksetzen</div>
          )}
        </div>
      )}
    </div>
  );
}

function StatistikApp() {
  const isWide = useIsWide();
  const [flights, setFlights] = useState([]);
  const [loaded, setLoaded] = useState(false);
  const [openTable, setOpenTable] = useState(null); // "schirm" | "passagiere" | "landeplaetze" | "startplaetze"
  // If this page was left via a Statistik-entry click (which stashes its
  // tableId here before navigating to Flugbuch), reopen the same tile once,
  // then forget it so a fresh visit doesn't get stuck.
  useEffect(() => {
    try {
      const raw = sessionStorage.getItem("statistik:returnState");
      if (raw) {
        const saved = JSON.parse(raw);
        if (saved?.tableId) setOpenTable(saved.tableId);
        sessionStorage.removeItem("statistik:returnState");
      }
    } catch {}
  }, []);

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
  const hikeFlights = flights.filter(f => f.hikeTrack?.length > 1);
  const hikeRows = aggregate(hikeFlights, f => f.customFields?.hikeOrt || "Unbekannt").map(r => {
    const withData = hikeFlights.find(f => (f.customFields?.hikeOrt||"Unbekannt") === r.name);
    const cf = withData?.customFields || {};
    const startAlt = withData?.startAlt>0 ? withData.startAlt : parseFloat(cf.msa);
    const hikeStart = parseFloat(cf.hikeStarthoehe);
    return { ...r,
      ort: r.name,
      hoehenmeter: (Number.isFinite(startAlt) && Number.isFinite(hikeStart)) ? Math.round(startAlt-hikeStart) : null,
      hikeDauer: cf.hikeDauer || null,
      lat: withData?.hikeTrack?.[0]?.lat, lon: withData?.hikeTrack?.[0]?.lon };
  });

  const SORT_OPTIONS = {
    schirm: [
      { id: "count", label: "Anzahl Flüge" },
      { id: "totalSec", label: "Gesamte Flugzeit" },
      { id: "maxSec", label: "Längster Flug" },
      { id: "totalDist", label: "Gesamte Distanz" },
      { id: "maxDist", label: "Weitester Flug" },
      { id: "maxAlt", label: "Grösste Höhe" },
      { id: "startSites", label: "Startplätze" },
      { id: "endSites", label: "Landeplätze" },
      { id: "name", label: "Name" },
      { id: "first", label: "Erster Flug" },
      { id: "last", label: "Letzter Flug" },
    ],
    passagiere: [
      { id: "count", label: "Anzahl" },
      { id: "first", label: "Erster Flug" },
      { id: "last", label: "Letzter Flug" },
      { id: "name", label: "Name" },
    ],
    landeplaetze: [
      { id: "count", label: "Anzahl Flüge" },
      { id: "alt", label: "Höhe m.ü.M." },
      { id: "first", label: "Erster Flug" },
      { id: "last", label: "Letzter Flug" },
      { id: "name", label: "Name" },
    ],
    startplaetze: [
      { id: "count", label: "Anzahl Flüge" },
      { id: "alt", label: "Höhe m.ü.M." },
      { id: "first", label: "Erster Flug" },
      { id: "last", label: "Letzter Flug" },
      { id: "name", label: "Name" },
    ],
    hike: [
      { id: "count", label: "Anzahl Flüge" },
      { id: "hoehenmeter", label: "Höhenmeter" },
      { id: "first", label: "Erster Flug" },
      { id: "last", label: "Letzter Flug" },
      { id: "name", label: "Name" },
    ],
  };

  const TABLES = [
    { id: "schirm", icon: "🪂", label: "Schirm", rows: schirmRows, color: "#3b82f6", glow: "rgba(59,130,246,0.5)" },
    { id: "startplaetze", icon: "🛫", label: "Startplätze", rows: startRows, color: "#4ade80", glow: "rgba(74,222,128,0.5)" },
    { id: "landeplaetze", icon: "🛬", label: "Landeplätze", rows: landRows, color: "#f5a623", glow: "rgba(245,166,35,0.5)" },
    { id: "passagiere", icon: "👤", label: "Passagiere", rows: passagierRows, color: "#a78bfa", glow: "rgba(167,139,250,0.5)" },
    { id: "hike", icon: "🥾", label: "Hike", rows: hikeRows, color: "#fef08a", glow: "rgba(254,240,138,0.5)" },
    { id: "saison", icon: "📅", label: "Saison", rows: [], color: "#e0304a", glow: "rgba(224,48,74,0.5)" },
    { id: "graph", icon: "📈", label: "Graph", rows: [], color: "#22d3ee", glow: "rgba(34,211,238,0.5)" },
  ].filter(t => (t.id !== "passagiere" || passagierRows.length > 0) && (t.id !== "hike" || hikeRows.length > 0));
  return (
    <div style={{minHeight:"100vh",background:"#210710",color:"#e8f4fd",fontFamily:"-apple-system,BlinkMacSystemFont,sans-serif",paddingBottom:40}}>
      {/* Header */}
      <div style={{background:"rgba(255,255,255,0.03)",borderBottom:"1px solid rgba(255,255,255,0.06)",padding:"calc(28px + env(safe-area-inset-top, 0px)) 16px 12px",display:"flex",alignItems:"center",position:"sticky",top:0,zIndex:10,backdropFilter:"blur(10px)"}}>
        <button onClick={()=>{try{localStorage.setItem("fb_explicitHome","1");}catch(e){} window.location.href="index.html";}} title="Zur Startseite"
          style={{background:"rgba(255,255,255,0.06)",border:"1px solid rgba(255,255,255,0.1)",borderRadius:10,width:32,height:32,display:"flex",alignItems:"center",justifyContent:"center",fontSize:15,color:"rgba(232,244,253,0.8)",cursor:"pointer",flexShrink:0}}>
          🏠
        </button>
        <span style={{fontWeight:900,fontSize:18,letterSpacing:-0.5,flex:1,textAlign:"center"}}>
          📊 Statistik
        </span>
        <button onClick={()=>window.location.href="hilfe.html"} title="Hilfe"
          style={{width:32,height:32,borderRadius:"50%",background:"rgba(255,255,255,0.06)",border:"1px solid rgba(255,255,255,0.12)",color:"#ef4444",fontSize:15,fontWeight:900,display:"flex",alignItems:"center",justifyContent:"center",cursor:"pointer",flexShrink:0}}>
          ?
        </button>
      </div>

      {/* 5 badges as full-width horizontal bars, stacked — each with its own
          colour accent rail plus a radial-gradient glow blob behind the
          icon, exactly matching Home's tile design (rail + icon glow)
          rather than a uniform 2x2 grid of same-coloured boxes. */}
      <div style={isWide
        ? { padding: "14px 16px 0", display: "flex", flexDirection: "row", gap: 10 }
        : { padding: "14px 16px 0", display: "flex", flexDirection: "column", gap: 10 }}>
        {TABLES.map(t => (
          <button key={t.id} onClick={()=>setOpenTable(openTable===t.id?null:t.id)}
            style={{width:isWide?undefined:"100%",flex:isWide?"1 1 0":undefined,minWidth:0,boxSizing:"border-box",display:"flex",flexDirection:isWide?"column":"row",alignItems:"stretch",padding:0,overflow:"hidden",
              background:openTable===t.id?`${t.color}26`:"rgba(255,255,255,0.05)",
              border:`1px solid ${openTable===t.id?t.color+"66":"rgba(255,255,255,0.1)"}`,
              borderRadius:12,color:openTable===t.id?t.color:"rgba(232,244,253,0.85)",fontSize:15,fontWeight:700,cursor:"pointer",textAlign:"left"}}>
            {/* Accent rail */}
            <div style={isWide ? {height:5,width:"100%",background:t.color,flexShrink:0,boxShadow:`0 0 12px ${t.color}`} : {width:5,background:t.color,flexShrink:0,boxShadow:`0 0 12px ${t.color}`}} />
            {/* Icon block with glow blob */}
            <div style={{width:isWide?"100%":56,height:isWide?56:undefined,flexShrink:0,display:"flex",alignItems:"center",justifyContent:"center",fontSize:20,
              background:`radial-gradient(circle, ${t.glow} 0%, ${t.glow} 40%, transparent 85%)`}}>
              {t.icon}
            </div>
            <span style={{flex:1,display:"flex",alignItems:"center",justifyContent:isWide?"center":"flex-start",padding:isWide?"10px 6px":"14px 8px",textAlign:isWide?"center":"left",fontSize:isWide?13:15}}>{t.label}</span>
            {!isWide && <span style={{opacity:0.6,fontSize:13,display:"flex",alignItems:"center",paddingRight:16}}>{openTable===t.id?"▾":"▸"}</span>}
          </button>
        ))}
      </div>

      {TABLES.map(t => openTable===t.id && (
        t.id === "saison"
          ? <SeasonSection key={t.id} flights={flights} />
          : t.id === "graph"
          ? null
          : (
            <React.Fragment key={t.id}>
              {t.id === "schirm" && <SchirmTimeline flights={flights} />}
              <StatTable table={t} sortOptions={SORT_OPTIONS[t.id]} />
            </React.Fragment>
          )
      ))}

      {/* Graph öffnet bewusst nicht mehr wie die anderen Badges inline
          innerhalb der Seite, sondern formatfüllend (eigene fixierte
          Ebene über der ganzen Seite) — die Zeichenfläche selbst misst
          ihre Breite laufend (siehe GraphSection/attachChartTouch), so
          dass Vollbild und v.a. Querformat wirklich genutzt werden statt
          nur die bisherige schmale Karten-Breite hochzuskalieren. */}
      {openTable === "graph" && (
        <div style={{position:"fixed",inset:0,zIndex:300,background:"#210710",display:"flex",flexDirection:"column"}}>
          <div style={{display:"flex",alignItems:"center",gap:10,padding:"calc(10px + env(safe-area-inset-top, 0px)) 16px 10px",borderBottom:"1px solid rgba(255,255,255,0.08)",flexShrink:0}}>
            <button onClick={()=>setOpenTable(null)} title="Schliessen"
              style={{background:"rgba(255,255,255,0.06)",border:"1px solid rgba(255,255,255,0.1)",borderRadius:10,width:32,height:32,display:"flex",alignItems:"center",justifyContent:"center",fontSize:15,color:"rgba(232,244,253,0.8)",cursor:"pointer",flexShrink:0}}>
              ✕
            </button>
            <span style={{fontWeight:900,fontSize:16,flex:1}}>📈 Graph</span>
          </div>
          <div style={{flex:1,minHeight:0,overflowY:"auto",padding:"10px 16px calc(16px + env(safe-area-inset-bottom, 0px))"}}>
            <GraphSection flights={flights} />
          </div>
        </div>
      )}
    </div>
  );
}

// Grafische Zeitleiste über alle geflogenen Schirme: eine Zeile pro Schirm,
// eine Spalte pro Jahr, Zelle = Anzahl Flüge dieses Jahr mit diesem Schirm.
// Kategorien (Standard/Tandem/Leicht) gibt's als eigenes Datenfeld nicht —
// werden hier aus dem automatisch geführten "Typ" (Solo/Biplace/Hike)
// abgeleitet: pro Schirm zählt, welcher Typ unter dessen Flügen am
// häufigsten vorkommt (ein Schirm wird ja i.d.R. konsistent für eine
// Einsatzart geflogen).
// Kategorie-Titel entsprechen jetzt exakt den Typ-Werten aus dem Flugbuch
// (Solo/Biplace/Hike) statt eigener Bezeichnungen — pro Flug zählt bei
// "Hike, Biplace" (beides zugleich) ausdrücklich Biplace, nicht Hike.
function deriveGliderCategory(typs) {
  let biplace = 0, hike = 0, solo = 0;
  typs.forEach(t => {
    const s = (t||"").toLowerCase();
    if (s.includes("biplace")) biplace++;
    else if (s.includes("hike")) hike++;
    else solo++;
  });
  if (biplace >= hike && biplace >= solo && biplace > 0) return "Biplace";
  if (hike >= solo && hike > 0) return "Hike";
  return "Solo";
}
const GLIDER_TIMELINE_COLORS = ["#7dd3fc","#4ade80","#fbbf24","#f87171","#a78bfa","#38bdf8","#fb923c","#facc15","#34d399","#f472b6"];
const TYP_COLOR = { Solo: "#93c5fd", Biplace: "#86efac", Hike: "#fde047" };
// Gr. 1° — dieselbe Idee wie in der Flugliste (Feld wählen, dazu
// eine Sortierrichtung), statt fest einprogrammierter Typ-Kategorien mit
// Aufklappen. Keine automatische "smarte" Sortierung mehr — die Reihen-
// folge ergibt sich ausschliesslich aus dem gewählten Sortierfeld.
const SCHIRM_GROUP_FIELDS = [
  { id: "none", label: "Keine" },
  { id: "typ",  label: "Typ" },
  { id: "seit", label: "Seit" },
];
const SCHIRM_SORT_FIELDS = [
  { id: "name", label: "Name" },
  { id: "seit", label: "Seit" },
  { id: "flights", label: "Anzahl Flüge" },
  { id: "duration", label: "Längster Flug" },
  { id: "dist", label: "Weitester Flug" },
];
function schirmGroupKey(g, fieldId) {
  if (fieldId === "typ") return deriveGliderCategory(g.typs);
  if (fieldId === "seit") return String(g.since);
  return null;
}
function schirmGroupColor(key, fieldId) {
  return fieldId === "typ" ? (TYP_COLOR[key] || "#7dd3fc") : "#7dd3fc";
}
// Die Namensspalte ist schmal — statt das Ende (Modell/Grösse, meist der
// wichtigere Teil) wegzuschneiden, wird nur das erste Wort (i.d.R. die
// Marke, z.B. "Advance") auf den Anfangsbuchstaben verkürzt, der Rest
// bleibt vollständig sichtbar.
function abbreviateGliderName(name, maxChars) {
  if (name.length <= maxChars) return name;
  const idx = name.indexOf(" ");
  if (idx < 0) return name;
  return name[0] + "." + name.slice(idx);
}
// Titel + Wert der zweiten Spalte richten sich nach dem gewählten
// Sortierfeld — bei "Name" bleibt es beim gewohnten "Seit" (Startjahr),
// bei den anderen Feldern zeigt die Spalte direkt den sortierten Wert.
function secondColLabel(sortField) {
  if (sortField === "flights") return "Flüge";
  if (sortField === "duration") return "Dauer";
  if (sortField === "dist") return "km";
  return "Seit";
}
function secondColValue(g, sortField) {
  if (sortField === "flights") return String(g.totalFlights);
  if (sortField === "duration") {
    const h = Math.floor(g.maxDurationSec/3600), m = Math.floor((g.maxDurationSec%3600)/60);
    return `${h}:${String(m).padStart(2,"0")}`;
  }
  if (sortField === "dist") return g.maxDist ? g.maxDist.toFixed(0) : "0";
  return String(g.since);
}
// Fasst eine bereits sortierte Liste zu Gruppen zusammen — Reihenfolge der
// Gruppen ergibt sich aus dem ersten Vorkommen in der sortierten Liste
// (kein zusätzliches, "smartes" Gruppen-Sortieren).
function bucketize(list, fieldId) {
  if (fieldId === "none") return [{ key: null, items: list }];
  const map = new Map();
  list.forEach(g => {
    const k = schirmGroupKey(g, fieldId);
    if (!map.has(k)) map.set(k, []);
    map.get(k).push(g);
  });
  return [...map.entries()].map(([key, items]) => ({ key, items }));
}

function SchirmTimeline({ flights }) {
  const [editMode, setEditMode] = useState(false);
  const [config, setConfig] = useState({ colors: {}, order: {}, hidden: {}, group1: "none", sortField: "name", sortDir: "asc" });
  const [loaded, setLoaded] = useState(false);
  const [pickerFor, setPickerFor] = useState(null); // name of glider whose color popover is open
  const [collapsed, setCollapsed] = useState(false);
  const [collapsedBuckets, setCollapsedBuckets] = useState(new Set());
  const toggleBucket = (path) => setCollapsedBuckets(prev => { const n=new Set(prev); n.has(path)?n.delete(path):n.add(path); return n; });

  useEffect(() => {
    (async () => {
      try {
        const r = await window.storage.get("service:schirmTimeline");
        if (r && r.value) setConfig(prev => ({ ...prev, ...JSON.parse(r.value) }));
      } catch (e) {}
      setLoaded(true);
    })();
  }, []);
  const saveConfig = (next) => {
    setConfig(next);
    try { window.storage.set("service:schirmTimeline", JSON.stringify(next)); } catch (e) {}
  };
  const setGliderColor = (name, patch) => {
    const next = { ...config, colors: { ...config.colors, [name]: { ...(config.colors[name]||{}), ...patch } } };
    saveConfig(next);
  };
  const toggleGliderHidden = (name) => {
    const hidden = { ...(config.hidden||{}) };
    if (hidden[name]) delete hidden[name]; else hidden[name] = true;
    saveConfig({ ...config, hidden });
  };
  const resetOrder = () => saveConfig({ ...config, order: {} });

  const byGlider = new Map();
  flights.forEach(f => {
    const name = f.glider;
    if (!name) return;
    const year = Number(f.year || (f.date||"").split(".")[2]);
    if (!year) return;
    if (!byGlider.has(name)) byGlider.set(name, { name, years: new Map(), typs: [], totalFlights: 0, maxDurationSec: 0, maxDist: 0 });
    const g = byGlider.get(name);
    g.years.set(year, (g.years.get(year)||0) + 1);
    g.typs.push(f.customFields?.typ);
    g.totalFlights++;
    if ((f.durationSec||0) > g.maxDurationSec) g.maxDurationSec = f.durationSec||0;
    if ((f.totalDist||0) > g.maxDist) g.maxDist = f.totalDist||0;
  });
  const gliders = [...byGlider.values()].map(g => {
    const years = [...g.years.keys()].map(Number).sort((a,b)=>a-b);
    return { ...g, since: years[0], until: years[years.length-1], years: g.years };
  });
  const allYears = gliders.flatMap(g => [...g.years.keys()].map(Number));
  const maxYear = allYears.length ? Math.max(...allYears) : new Date().getFullYear();
  const minYear = allYears.length ? Math.min(...allYears) : maxYear;
  const yearCols = [];
  for (let y = maxYear; y >= minYear; y--) yearCols.push(y);

  // Ausgeblendete Schirme verschwinden im Normalzustand komplett; im
  // Bearbeiten-Modus bleiben sie sichtbar (gedimmt), damit man sie wieder
  // einblenden kann.
  const visibleGliders = editMode ? gliders : gliders.filter(g => !config.hidden?.[g.name]);
  // Basis-Sortierung ausschliesslich nach dem gewählten Feld — keine
  // automatische/"smarte" Sortierung mehr.
  const sortDirMul = config.sortDir === "desc" ? -1 : 1;
  const baseSorted = [...visibleGliders].sort((a,b) => {
    if (config.sortField === "seit") return (a.since - b.since) * sortDirMul;
    if (config.sortField === "flights") return (a.totalFlights - b.totalFlights) * sortDirMul;
    if (config.sortField === "duration") return (a.maxDurationSec - b.maxDurationSec) * sortDirMul;
    if (config.sortField === "dist") return (a.maxDist - b.maxDist) * sortDirMul;
    return a.name.localeCompare(b.name) * sortDirMul;
  });
  const level1Buckets = bucketize(baseSorted, config.group1);
  // Manuelles Verschieben (▲▼) bleibt erhalten, wirkt aber innerhalb der
  // jeweils aktuellen (Gr.1°/Gr.2°-)Gruppe statt fest pro Typ-Kategorie.
  const applyManualOrder = (items, bucketPath) => {
    const saved = config.order[bucketPath] || [];
    const byName = new Map(items.map(g=>[g.name,g]));
    const ordered = saved.map(n=>byName.get(n)).filter(Boolean);
    const remaining = items.filter(g=>!saved.includes(g.name));
    return [...ordered, ...remaining];
  };
  const moveGliderIn = (bucketPath, items, idx, dir) => {
    const names = items.map(g=>g.name);
    const newIdx = idx + dir;
    if (newIdx < 0 || newIdx >= names.length) return;
    [names[idx], names[newIdx]] = [names[newIdx], names[idx]];
    saveConfig({ ...config, order: { ...config.order, [bucketPath]: names } });
  };

  // Stabile Farbzuweisung pro Schirm (alphabetisch, unabhängig von
  // Gruppierung/Sortierung/Ein-Ausblenden) — vorher wurde ein gemeinsamer
  // Zähler beim Rendern hochgezählt, der sich je nach Render-Reihenfolge
  // verschob und dieselbe automatische Farbe zwischen Schirmen "springen"
  // liess (inkonsistentes Bearbeiten-UI).
  const colorIndexByName = new Map(
    [...gliders].sort((a,b)=>a.name.localeCompare(b.name)).map((g,i)=>[g.name,i])
  );
  if (!loaded) return null;
  const NAME_COL_W = editMode ? 172 : 130, SEIT_COL_W = 46, YEAR_COL_W = 44;

  // Einzelne Schirm-Zeile.
  const renderGliderRow = (g, bucketPath, idx, items) => {
    const listLen = items.length;
    const colorIdx = colorIndexByName.get(g.name) || 0;
    const auto = GLIDER_TIMELINE_COLORS[colorIdx % GLIDER_TIMELINE_COLORS.length];
    const custom = config.colors[g.name] || {};
    const c1 = custom.c1 || auto;
    const c2 = custom.c2 || null;
    const cellBg = c2 ? `linear-gradient(90deg, ${c1} 0%, ${c1} 50%, ${c2} 83%, ${c2} 100%)` : c1;
    const isHidden = !!config.hidden?.[g.name];
    // Nur abkürzen, wenn die volle Bezeichnung rechnerisch nicht passt —
    // verfügbare Breite = Spaltenbreite minus Padding minus (im
    // Bearbeiten-Modus) Platz für die vier Icons, geteilt durch eine
    // grobe durchschnittliche Zeichenbreite dieser fetten 11px-Schrift.
    const iconsW = editMode ? 4*16 + 3*5 + 5 : 0;
    const availablePx = NAME_COL_W - 20 - iconsW;
    const maxChars = Math.floor(availablePx / 6.3);
    return (
      <React.Fragment key={g.name}>
      <tr style={{opacity:editMode&&isHidden?0.4:1}}>
        <td style={{position:"sticky",left:0,width:NAME_COL_W,minWidth:NAME_COL_W,maxWidth:NAME_COL_W,boxSizing:"border-box",overflow:"hidden",background:"#2a0d17",padding:"4px 10px",fontWeight:600,color:"#e8f4fd",zIndex:1}}>
          <div style={{display:"flex",alignItems:"center",gap:5,minWidth:0}}>
            {editMode && (
              <>
                <button onClick={()=>toggleGliderHidden(g.name)} title={isHidden?"Einblenden":"Ausblenden"}
                  style={{background:"rgba(255,255,255,0.08)",border:"none",borderRadius:5,width:16,height:16,fontSize:9,color:"#e8f4fd",cursor:"pointer",flexShrink:0,padding:0}}>{isHidden?"🚫":"👁"}</button>
                <button onClick={()=>moveGliderIn(bucketPath, items, idx, -1)} disabled={idx===0}
                  style={{opacity:idx===0?0.25:1,background:"rgba(255,255,255,0.08)",border:"none",borderRadius:5,width:16,height:16,fontSize:9,color:"#e8f4fd",cursor:idx===0?"default":"pointer",flexShrink:0}}>▲</button>
                <button onClick={()=>moveGliderIn(bucketPath, items, idx, 1)} disabled={idx===listLen-1}
                  style={{opacity:idx===listLen-1?0.25:1,background:"rgba(255,255,255,0.08)",border:"none",borderRadius:5,width:16,height:16,fontSize:9,color:"#e8f4fd",cursor:idx===listLen-1?"default":"pointer",flexShrink:0}}>▼</button>
                <button onClick={()=>setPickerFor(pickerFor===g.name?null:g.name)}
                  style={{width:14,height:14,borderRadius:4,background:cellBg,border:"1px solid rgba(255,255,255,0.3)",flexShrink:0,cursor:"pointer",padding:0}} />
              </>
            )}
            <span style={{overflow:"hidden",textOverflow:"ellipsis",whiteSpace:"nowrap",minWidth:0}}>{abbreviateGliderName(g.name, maxChars)}</span>
          </div>
        </td>
        <td style={{position:"sticky",left:NAME_COL_W,width:SEIT_COL_W,minWidth:SEIT_COL_W,boxSizing:"border-box",background:"#2a0d17",padding:"4px 8px",textAlign:"center",color:"rgba(232,244,253,0.5)",zIndex:1}}>{secondColValue(g, config.sortField)}</td>
        {yearCols.map((y, yi) => {
          const count = g.years.get(y);
          const active = y >= g.since && y <= g.until;
          const barGradient = c2 ? `linear-gradient(90deg, ${c1} 0%, ${c1} 50%, ${c2} 83%, ${c2} 100%)` : c1;
          const isFirstActive = active && (yearCols[yi-1]===undefined || !(yearCols[yi-1] >= g.since && yearCols[yi-1] <= g.until));
          const isLastActive = active && (yearCols[yi+1]===undefined || !(yearCols[yi+1] >= g.since && yearCols[yi+1] <= g.until));
          return (
            <td key={y} style={{textAlign:"center",padding:"4px 6px",position:"relative",height:22,fontWeight:700}}>
              {active && (
                <div style={{position:"absolute",top:"50%",left:isFirstActive?2:0,right:isLastActive?2:0,height:16,transform:"translateY(-50%)",
                  borderRadius:0,
                  borderTopLeftRadius:isFirstActive?8:0,borderBottomLeftRadius:isFirstActive?8:0,
                  borderTopRightRadius:isLastActive?8:0,borderBottomRightRadius:isLastActive?8:0,
                  background:`linear-gradient(to bottom, rgba(255,255,255,0.75) 0%, rgba(255,255,255,0.25) 22%, rgba(255,255,255,0) 45%, rgba(0,0,0,0.2) 70%, rgba(0,0,0,0.45) 100%), ${barGradient}`,
                  opacity:count?1:0.35,
                  boxShadow:"inset 0 1.5px 0 rgba(255,255,255,0.6), inset 0 -1.5px 2px rgba(0,0,0,0.5), 0 2px 3px rgba(0,0,0,0.4), 0 0 0 0.5px rgba(0,0,0,0.3)"}} />
              )}
              <span style={{position:"relative",color:active?"#fff":"transparent",textShadow:active?"0 1px 2px rgba(0,0,0,0.75)":"none"}}>{count||(active?"·":"")}</span>
            </td>
          );
        })}
      </tr>
      {editMode && pickerFor===g.name && (
        <tr>
          <td colSpan={2+yearCols.length} style={{background:"#1a0910",padding:0}}>
            <div style={{position:"sticky",left:0,width:"calc(100vw - 32px)",maxWidth:"90vw",boxSizing:"border-box",display:"flex",alignItems:"center",gap:10,flexWrap:"wrap",padding:"8px 10px"}}>
              <label style={{fontSize:11,color:"rgba(232,244,253,0.5)",display:"flex",alignItems:"center",gap:5}}>
                Farbe 1
                <input type="color" value={c1} onChange={e=>setGliderColor(g.name,{c1:e.target.value})}
                  style={{width:30,height:22,border:"1px solid rgba(255,255,255,0.25)",borderRadius:5,padding:0}} />
              </label>
              {c2 ? (
                <label style={{fontSize:11,color:"rgba(232,244,253,0.5)",display:"flex",alignItems:"center",gap:5}}>
                  Farbe 2
                  <input type="color" value={c2} onChange={e=>setGliderColor(g.name,{c2:e.target.value})}
                    style={{width:30,height:22,border:"1px solid rgba(255,255,255,0.25)",borderRadius:5,padding:0}} />
                  <button onClick={()=>setGliderColor(g.name,{c2:null})} style={{background:"none",border:"none",color:"rgba(232,244,253,0.4)",fontSize:14,cursor:"pointer"}}>✕</button>
                </label>
              ) : (
                <button onClick={()=>setGliderColor(g.name,{c2:GLIDER_TIMELINE_COLORS[(colorIdx+3)%GLIDER_TIMELINE_COLORS.length]})}
                  style={{background:"transparent",border:"1px dashed rgba(255,255,255,0.2)",borderRadius:7,padding:"4px 8px",color:"rgba(232,244,253,0.4)",fontSize:11,cursor:"pointer"}}>
                  + 2. Farbe
                </button>
              )}
              {(custom.c1||custom.c2) && (
                <button onClick={()=>{ const nc={...config.colors}; delete nc[g.name]; saveConfig({...config,colors:nc}); }}
                  style={{background:"transparent",border:"none",color:"rgba(248,113,113,0.7)",fontSize:11,cursor:"pointer"}}>
                  Zurücksetzen
                </button>
              )}
            </div>
          </td>
        </tr>
      )}
      </React.Fragment>
    );
  };

  // Kleines wiederverwendbares Dropdown fürs Gr.1°/Gr.2°/Sortieren-Menü.
  const MiniSelect = ({ value, onChange, options }) => (
    <select value={value} onChange={e=>onChange(e.target.value)}
      style={{background:"rgba(255,255,255,0.08)",border:"1px solid rgba(255,255,255,0.15)",borderRadius:7,padding:"3px 4px",color:"#e8f4fd",fontSize:11}}>
      {options.map(o=><option key={o.id} value={o.id} style={{background:"#0a1628"}}>{o.label}</option>)}
    </select>
  );

  return (
    <div style={{margin:"14px 16px 14px"}}>
      <div style={{background:"rgba(59,130,246,0.07)",border:"1px solid rgba(59,130,246,0.18)",borderRadius:14,overflow:"hidden"}}>
        <div style={{display:"flex",justifyContent:"space-between",alignItems:"center",padding:"6px 10px"}}>
          <button onClick={()=>setCollapsed(c=>!c)} style={{background:"none",border:"none",color:"rgba(232,244,253,0.6)",fontSize:12,fontWeight:700,cursor:"pointer",display:"flex",alignItems:"center",gap:5,padding:0}}>
            <span style={{fontSize:10}}>{collapsed?"▸":"▾"}</span> Schirm-Zeitleiste
          </button>
          {!collapsed && (
            <div style={{display:"flex",gap:6}}>
              {editMode && (
                <button onClick={resetOrder} title="Manuelle Reihenfolge zurücksetzen"
                  style={{background:"rgba(248,113,113,0.1)",border:"1px solid rgba(248,113,113,0.3)",borderRadius:8,width:28,height:28,fontSize:12,color:"#f87171",cursor:"pointer"}}>
                  🔄
                </button>
              )}
              <button onClick={()=>{ setEditMode(m=>!m); setPickerFor(null); }} title={editMode?"Fertig":"Farben/Reihenfolge bearbeiten"}
                style={{background:editMode?"rgba(74,222,128,0.15)":"rgba(125,211,252,0.1)",border:`1px solid ${editMode?"rgba(74,222,128,0.4)":"rgba(125,211,252,0.3)"}`,borderRadius:8,width:28,height:28,fontSize:12,color:editMode?"#4ade80":"#7dd3fc",cursor:"pointer"}}>
                {editMode?"✓":"✏️"}
              </button>
            </div>
          )}
        </div>
        {!collapsed && (
        <>
        <div style={{display:"flex",gap:10,alignItems:"center",flexWrap:"wrap",padding:"0 10px 10px"}}>
          <label style={{display:"flex",alignItems:"center",gap:4,fontSize:11,color:"rgba(232,244,253,0.5)"}}>
            Gr. 1°
            <MiniSelect value={config.group1} onChange={v=>saveConfig({...config,group1:v})} options={SCHIRM_GROUP_FIELDS} />
          </label>
          <label style={{display:"flex",alignItems:"center",gap:4,fontSize:11,color:"rgba(232,244,253,0.5)"}}>
            Sortieren
            <MiniSelect value={config.sortField} onChange={v=>saveConfig({...config,sortField:v})} options={SCHIRM_SORT_FIELDS} />
            <button onClick={()=>saveConfig({...config,sortDir:config.sortDir==="desc"?"asc":"desc"})}
              style={{background:"rgba(255,255,255,0.08)",border:"1px solid rgba(255,255,255,0.15)",borderRadius:7,width:22,height:22,color:"#e8f4fd",fontSize:11,cursor:"pointer"}}>
              {config.sortDir==="desc"?"↓":"↑"}
            </button>
          </label>
        </div>
        {gliders.length === 0 ? (
          <div style={{padding:"16px 14px",color:"rgba(232,244,253,0.35)",fontSize:13,fontStyle:"italic"}}>Keine Schirm-Daten vorhanden.</div>
        ) : (
        <div style={{overflowX:"auto",WebkitOverflowScrolling:"touch"}}>
          <table style={{borderCollapse:"separate",borderSpacing:0,fontSize:11,whiteSpace:"nowrap",tableLayout:"fixed"}}>
            <thead>
              <tr>
                <th style={{position:"sticky",left:0,width:NAME_COL_W,minWidth:NAME_COL_W,boxSizing:"border-box",background:"#210710",zIndex:3,textAlign:"left",padding:"5px 10px",color:"rgba(232,244,253,0.4)",fontWeight:600}}>Schirm</th>
                <th style={{position:"sticky",left:NAME_COL_W,width:SEIT_COL_W,minWidth:SEIT_COL_W,boxSizing:"border-box",background:"#210710",zIndex:3,padding:"5px 8px",color:"rgba(232,244,253,0.4)",fontWeight:600}}>{secondColLabel(config.sortField)}</th>
                {yearCols.map(y => <th key={y} style={{width:YEAR_COL_W,boxSizing:"border-box",padding:"5px 6px",color:"rgba(232,244,253,0.35)",fontWeight:600}}>{y}</th>)}
              </tr>
            </thead>
            <tbody>
              {level1Buckets.map(l1 => {
                const l1Path = `g1:${l1.key ?? "_"}`;
                const l1Collapsed = collapsedBuckets.has(l1Path);
                const finalItems = applyManualOrder(l1.items, l1Path);
                const l1Color = schirmGroupColor(l1.key, config.group1);
                return (
                  <React.Fragment key={l1Path}>
                    {config.group1 !== "none" && (
                      <tr onClick={()=>toggleBucket(l1Path)} style={{cursor:"pointer"}}>
                        <td colSpan={2} style={{position:"sticky",left:0,width:NAME_COL_W+SEIT_COL_W,minWidth:NAME_COL_W+SEIT_COL_W,boxSizing:"border-box",background:"#210710",color:l1Color,fontWeight:700,padding:"4px 10px",zIndex:3,border:`1px solid ${l1Color}`,borderRight:"none"}}>
                          <span style={{fontSize:9,marginRight:5}}>{l1Collapsed?"▸":"▾"}</span>{l1.key}
                        </td>
                        <td colSpan={yearCols.length} style={{background:"#210710",border:`1px solid ${l1Color}`,borderLeft:"none"}} />
                      </tr>
                    )}
                    {!l1Collapsed && finalItems.map((g, idx) => renderGliderRow(g, l1Path, idx, finalItems))}
                  </React.Fragment>
                );
              })}
            </tbody>
          </table>
        </div>
        )}
        </>
        )}
      </div>
    </div>
  );
}

// Welches Suchfeld der Flugliste einem Statistik-Eintrag entspricht — für
// den Direktsprung mit passendem Filter beim Antippen eines Eintrags.
const STAT_TABLE_FILTER_FIELD = {
  schirm: "schirm",
  startplaetze: "site",
  landeplaetze: "landung",
  passagiere: "passagier",
  hike: "hikeOrt",
};
// Einmal definiert, sowohl für die gemeinsame Kopfzeile als auch für jede
// Schirm-Werte-Zeile genutzt — feste Breiten sorgen dafür, dass Titel oben
// und Werte darunter sauber übereinander stehen.
const SCHIRM_STAT_COLUMNS = [
  { label: "Gesamte Flugzeit", w: 72, value: r => fmtHM(r.totalSec) },
  { label: "Längster Flug",    w: 62, value: r => fmtHours(r.maxSec) },
  { label: "Gesamte Distanz",  w: 72, value: r => `${r.totalDist.toFixed(1)} km` },
  { label: "Weitester Flug",   w: 64, value: r => `${r.maxDist.toFixed(1)} km` },
  { label: "Zeit/Flug",        w: 54, value: r => fmtHM(Math.round(r.totalSec/r.count)) },
  { label: "km/Flug",          w: 54, value: r => `${(r.totalDist/r.count).toFixed(1)} km` },
  { label: "Grösste Höhe",     w: 60, value: r => `${r.maxAlt} m` },
  { label: "Startplätze",      w: 56, value: r => String(r.startSites) },
  { label: "Landeplätze",      w: 58, value: r => String(r.endSites) },
  { label: "Erster Flug",      w: 54, value: r => fmtDateShort(r.first) },
  { label: "Letzter Flug",     w: 54, value: r => fmtDateShort(r.last) },
];
const PASSAGIER_STAT_COLUMNS = [
  { label: "Erster Flug",  w: 54, value: r => fmtDateShort(r.first) },
  { label: "Letzter Flug", w: 54, value: r => fmtDateShort(r.last) },
];
const PLATZ_STAT_COLUMNS = [
  { label: "m.ü.M.",       w: 54, value: r => r.alt ? String(r.alt) : "—" },
  { label: "Erster Flug",  w: 54, value: r => fmtDateShort(r.first) },
  { label: "Letzter Flug", w: 54, value: r => fmtDateShort(r.last) },
];
const HIKE_STAT_COLUMNS = [
  { label: "Höhenmeter",   w: 58, value: r => r.hoehenmeter!=null ? `${r.hoehenmeter} m` : "—" },
  { label: "Hike-Dauer",   w: 58, value: r => r.hikeDauer || "—" },
  { label: "Erster Flug",  w: 54, value: r => fmtDateShort(r.first) },
  { label: "Letzter Flug", w: 54, value: r => fmtDateShort(r.last) },
];
const STAT_COLUMNS_BY_ID = {
  schirm: SCHIRM_STAT_COLUMNS,
  passagiere: PASSAGIER_STAT_COLUMNS,
  startplaetze: PLATZ_STAT_COLUMNS,
  landeplaetze: PLATZ_STAT_COLUMNS,
  hike: HIKE_STAT_COLUMNS,
};
// Kleines Badge neben Koordinaten — kopiert sie per Tippen in die
// Zwischenablage, mit kurzer visueller Bestätigung (✓).
function CopyBadge({ text }) {
  const [copied, setCopied] = useState(false);
  return (
    <button onClick={async (e) => {
        e.stopPropagation();
        try { await navigator.clipboard.writeText(text); } catch (err) {}
        setCopied(true);
        setTimeout(() => setCopied(false), 1200);
      }}
      title="Koordinaten kopieren"
      style={{background:copied?"rgba(74,222,128,0.18)":"rgba(255,255,255,0.06)",border:`1px solid ${copied?"rgba(74,222,128,0.4)":"rgba(255,255,255,0.12)"}`,borderRadius:20,padding:"1px 6px",fontSize:9,color:copied?"#4ade80":"rgba(232,244,253,0.5)",cursor:"pointer",flexShrink:0,lineHeight:"14px"}}>
      {copied ? "✓" : "📋"}
    </button>
  );
}
function StatTable({ table, sortOptions }) {
  const { rows, id } = table;
  const [sortField, setSortFieldRaw] = useState(sortOptions[0].id);
  const [sortDir, setSortDirRaw] = useState("desc");
  // Restores the previously chosen sort for this specific table — each of
  // the 4 tables (Schirm/Startplätze/Landeplätze/Passagiere) keeps its own
  // independent choice. statistik.html is a separate full page, not a
  // client-side route, so plain React state resets on navigation; saving
  // directly in the click handlers (not via a reactive effect) avoids
  // losing the write to a navigation that follows right after.
  useEffect(() => {
    (async () => {
      try {
        const r = await window.storage.get("statistikSort_"+id);
        if (r && r.value) {
          const saved = JSON.parse(r.value);
          if (saved.field && sortOptions.some(o=>o.id===saved.field)) setSortFieldRaw(saved.field);
          if (saved.dir) setSortDirRaw(saved.dir);
        }
      } catch (e) { /* nothing stored yet, or storage unavailable — keep default */ }
    })();
  }, [id]);
  const persistSort = (field, dir) => {
    try { window.storage.set("statistikSort_"+id, JSON.stringify({ field, dir })); } catch (e) {}
  };
  const setSortField = (f) => { setSortFieldRaw(f); persistSort(f, sortDir); };
  const setSortDir = (updater) => { setSortDirRaw(prev => { const next = typeof updater==="function" ? updater(prev) : updater; persistSort(sortField, next); return next; }); };
  const [showSortMenu, setShowSortMenu] = useState(false);
  // Keeps every card's chip row scrolled to the same horizontal position:
  // scrolling any one card's chips (e.g. one Schirm's stats) mirrors that
  // scrollLeft onto every other card's chip row, while each card's name/
  // title stays in normal (non-scrolling) flow above it.
  const chipRowRefs = useRef([]);
  const syncingScroll = useRef(false);
  const handleChipScroll = (e) => {
    if (syncingScroll.current) return;
    syncingScroll.current = true;
    const left = e.target.scrollLeft;
    chipRowRefs.current.forEach(el => { if (el && el !== e.target) el.scrollLeft = left; });
    syncingScroll.current = false;
  };

  if (!rows.length) {
    return (
      <div style={{margin:"12px 16px 0",background:"rgba(255,255,255,0.04)",border:"1px solid rgba(255,255,255,0.08)",borderRadius:12,padding:"20px 16px",textAlign:"center",color:"rgba(232,244,253,0.4)",fontSize:13}}>
        Keine Daten vorhanden.
      </div>
    );
  }
  const sorted = sortRows(rows, sortField, sortDir);
  const totalFlights = rows.reduce((s,r) => s+r.count, 0);

  return (
    <div style={{margin:"12px 16px 0",display:"flex",flexDirection:"column",gap:8}}>
      {/* Sort selector */}
      <div style={{position:"relative"}}>
        <div style={{display:"flex",gap:8}}>
          <button onClick={()=>setShowSortMenu(s=>!s)}
            style={{flex:1,display:"flex",justifyContent:"space-between",alignItems:"center",background:"rgba(255,255,255,0.06)",border:"1px solid rgba(255,255,255,0.1)",borderRadius:10,padding:"8px 12px",color:"rgba(232,244,253,0.8)",fontSize:12,cursor:"pointer"}}>
            <span>⇅ {sortOptions.find(o=>o.id===sortField)?.label}</span>
            <span>{showSortMenu?"▾":"▸"}</span>
          </button>
          <button onClick={()=>setSortDir(d=>d==="asc"?"desc":"asc")}
            style={{background:"rgba(255,255,255,0.06)",border:"1px solid rgba(255,255,255,0.1)",borderRadius:10,padding:"8px 14px",color:"#f87171",fontSize:14,cursor:"pointer"}}>
            {sortDir==="asc"?"↑":"↓"}
          </button>
        </div>
        {showSortMenu && (
          <div style={{marginTop:6,background:"#2a0d16",border:"1px solid rgba(255,255,255,0.12)",borderRadius:12,padding:6,boxShadow:"0 8px 24px rgba(0,0,0,0.4)",position:"absolute",top:"100%",left:0,right:0,zIndex:20}}>
            {sortOptions.map(o=>(
              <div key={o.id} onClick={()=>{setSortField(o.id);setShowSortMenu(false);}}
                style={{padding:"9px 12px",borderRadius:8,fontSize:13,cursor:"pointer",color:o.id===sortField?"#f87171":"rgba(232,244,253,0.75)",background:o.id===sortField?"rgba(224,48,74,0.15)":"transparent"}}>
                {o.label}
              </div>
            ))}
          </div>
        )}
      </div>

      <div style={{fontSize:11,color:"rgba(232,244,253,0.4)",textTransform:"uppercase",letterSpacing:0.5,padding:"0 2px"}}>
        {rows.length} Einträge · {totalFlights} Flüge total
      </div>

      {sorted.map((r,idx) => (
        <div key={idx} style={{background:"rgba(255,255,255,0.04)",border:"1px solid rgba(255,255,255,0.08)",borderRadius:12,padding:"12px 14px"}}>
          <div style={{display:"flex",justifyContent:"space-between",alignItems:"flex-end",marginBottom:8,gap:8}}>
            <div style={{flex:1,minWidth:0}}>
              <div onClick={() => {
                  // Nicht mehr die eigene Flugliste-Übersicht öffnen,
                  // sondern direkt zur echten Flugliste springen, vor-
                  // gefiltert auf diesen Eintrag. Derselbe Rückkehr-
                  // Mechanismus wie beim Antippen eines einzelnen Flugs
                  // (sessionStorage) sorgt dafür, dass "Zurück" wieder auf
                  // dieselbe Statistik-Kachel landet statt auf Home.
                  const field = STAT_TABLE_FILTER_FIELD[id];
                  try { sessionStorage.setItem("statistik:returnState", JSON.stringify({ tableId: id, rowName: null })); } catch {}
                  // "=" (exakt), nicht ":" (enthält) — sonst zieht z.B.
                  // "Fiesch" auch "Fiescheralp" mit in den Drilldown.
                  window.location.href = `flugbuch.html?filter=${encodeURIComponent(field+'="'+r.name+'"')}&returnTo=${encodeURIComponent("statistik.html")}`;
                }}
                style={{fontSize:14,fontWeight:700,cursor:"pointer",textDecoration:"underline",textDecorationColor:"rgba(232,244,253,0.25)",textUnderlineOffset:3}}>
                {r.name}
              </div>
              {(id === "landeplaetze" || id === "startplaetze") && r.lat && r.lon && (
                <div style={{fontSize:10,color:"rgba(232,244,253,0.35)",marginTop:2,fontFamily:"monospace",display:"flex",alignItems:"center",gap:5}}>
                  <span>{r.lat.toFixed(5)}, {r.lon.toFixed(5)}</span>
                  <CopyBadge text={`${r.lat.toFixed(5)}, ${r.lon.toFixed(5)}`} />
                </div>
              )}
            </div>
            {(id === "schirm" || id === "startplaetze" || id === "passagiere" || id === "landeplaetze") && (r.r5>0 || r.r4>0) && (
              <div style={{fontSize:10,fontWeight:700,color:"#fde047",whiteSpace:"nowrap",flexShrink:0,display:"flex",gap:5}}>
                {r.r5>0 && <span>{r.r5}×5⭐️</span>}
                {r.r4>0 && <span>{r.r4}×4⭐️</span>}
              </div>
            )}
            <div style={{fontSize:13,fontWeight:700,color:"#f87171",flexShrink:0}}>{r.count} Flüge</div>
          </div>
          <div ref={el => { chipRowRefs.current[idx] = el; }} onScroll={handleChipScroll}
            style={{display:"flex",gap:10,overflowX:"auto",paddingBottom:2,WebkitOverflowScrolling:"touch"}}>
            {(STAT_COLUMNS_BY_ID[id]||[]).map(col => (
              <span key={col.label} style={{display:"flex",flexDirection:"column",alignItems:"flex-start",gap:1,flexShrink:0}}>
                <span style={{fontSize:8,color:"rgba(232,244,253,0.4)",textTransform:"uppercase",letterSpacing:0.3,whiteSpace:"nowrap"}}>{col.label}</span>
                <span style={{fontSize:13,fontWeight:700,color:"rgba(232,244,253,0.9)",whiteSpace:"nowrap"}}>{col.value(r)}</span>
              </span>
            ))}
          </div>
        </div>
      ))}
    </div>
  );
}

// Fullscreen overlay listing every flight behind a tapped Schirm/Passagier/
// Start-/Landeplatz value, with the same core fields shown in the Flugbuch
// list and its own independent sort control (mirrors the Flugbuch pattern:
// a field dropdown + direction toggle).
const FLIGHT_LIST_SORT_OPTIONS = [
  { id: "date", label: "Datum" },
  { id: "number", label: "Nummer" },
  { id: "duration", label: "Dauer" },
  { id: "dist", label: "Distanz" },
  { id: "routenTyp", label: "Routenart" },
];

function flightListSortValue(f, sortId) {
  switch (sortId) {
    case "date": return parseDateToTs(f.date);
    case "number": return parseInt((f.name||"").match(/\d+/)?.[0]||"0",10);
    case "duration": return f.durationSec||0;
    case "dist": return f.totalDist||0;
    case "routenTyp": return (f.customFields?.routenTyp||"").toLowerCase();
    default: return 0;
  }
}

