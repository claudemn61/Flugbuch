const { useState, useEffect } = React;

// ── Home Screen ──────────────────────────────────────────────────────────
// Landing page shown before the Flugbuch app. Three of the four tiles link
// to pages that don't exist yet (Statistik, Service, Reisen) — they're
// visually present but marked "Bald" until those pages are built.

function useIsWide() {
  const [isWide, setIsWide] = useState(typeof window !== "undefined" ? window.innerWidth >= 768 : false);
  useEffect(() => {
    const onResize = () => setIsWide(window.innerWidth >= 768);
    window.addEventListener("resize", onResize);
    return () => window.removeEventListener("resize", onResize);
  }, []);
  return isWide;
}

// Reads flight keys from the same IndexedDB database the Flugbuch app's
// storage shim uses (flugbuch-db / store "kv", keys prefixed "flugbuch:").
// Falls back to localStorage if IndexedDB has nothing (e.g. very first load
// before any migration has happened).
async function readFlightStatsFromStorage() {
  const PREFIX = "flugbuch:";
  let total = 0, biplace = 0, found = false;
  const startSites = new Set(), endSites = new Set(), gliders = new Set();

  function tally(f) {
    total++;
    if (f?.customFields?.passagier && String(f.customFields.passagier).trim()) biplace++;
    if (f?.site) startSites.add(f.site);
    if (f?.customFields?.landung) endSites.add(f.customFields.landung);
    if (f?.glider) gliders.add(f.glider);
  }

  try {
    if (window.indexedDB) {
      const db = await new Promise((resolve, reject) => {
        const req = indexedDB.open("flugbuch-db", 1);
        req.onupgradeneeded = () => { req.result.createObjectStore("kv"); };
        req.onsuccess = () => resolve(req.result);
        req.onerror = () => reject(req.error);
      });
      const entries = await new Promise((resolve, reject) => {
        const tx = db.transaction("kv", "readonly");
        const store = tx.objectStore("kv");
        const keysReq = store.getAllKeys();
        const valsReq = store.getAll();
        let keys, vals;
        keysReq.onsuccess = () => { keys = keysReq.result; if (vals) resolve({keys, vals}); };
        valsReq.onsuccess = () => { vals = valsReq.result; if (keys) resolve({keys, vals}); };
        tx.onerror = () => reject(tx.error);
      });
      entries.keys.forEach((k, i) => {
        if (typeof k === "string" && k.startsWith(PREFIX + "flight:")) {
          found = true;
          try { tally(JSON.parse(entries.vals[i])); } catch {}
        }
      });
    }
  } catch (e) {
    console.error("IndexedDB read error:", e);
  }

  // Fallback: check localStorage too, in case IndexedDB is empty/unavailable
  // (e.g. right after an update, before flugbuch.html has run its migration).
  if (!found) {
    try {
      for (let i = 0; i < localStorage.length; i++) {
        const key = localStorage.key(i);
        if (!key || !key.startsWith(PREFIX + "flight:")) continue;
        try { tally(JSON.parse(localStorage.getItem(key))); } catch {}
      }
    } catch {}
  }

  return { total, biplace, startSites: startSites.size, endSites: endSites.size, gliders: gliders.size };
}

const GERMAN_MONTHS = {
  "januar":1,"februar":2,"märz":3,"maerz":3,"april":4,"mai":5,"juni":6,
  "juli":7,"august":8,"september":9,"oktober":10,"november":11,"dezember":12,
  "jan":1,"feb":2,"mär":3,"mar":3,"apr":4,"jun":6,"jul":7,"aug":8,"sep":9,"sept":9,"okt":10,"nov":11,"dez":12,
};
function parseDateStr(s) {
  if (!s) return null;
  const str = String(s).trim();
  const m = str.match(/^(\d{1,2})\.(\d{1,2})\.(\d{2,4})$/);
  if (m) {
    let [_, dd, mm, yy] = m;
    yy = yy.length === 2 ? "20"+yy : yy;
    return new Date(+yy, +mm-1, +dd);
  }
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
function addMonthsToDate(date, months) {
  const d = new Date(date);
  d.setMonth(d.getMonth() + months);
  return d;
}
function daysUntilDate(d) {
  if (!d) return null;
  const now = new Date(); now.setHours(0,0,0,0);
  const target = new Date(d); target.setHours(0,0,0,0);
  return Math.round((target - now) / 86400000);
}

const RESERVE_LABELS = { solo_int: "Solo integriert", solo_ext: "Solo extern", biplace: "Biplace" };

// Reads Reserve + Schirm data from the same IndexedDB the Service page uses,
// and returns the single most urgent entry (soonest due date, overdue takes
// priority) so the Home tile can show a live "Nächstes Packen: <name>"
// preview instead of a generic placeholder.
async function readServiceUrgency() {
  const PREFIX = "flugbuch:";
  let reserves = null, schirme = null;

  async function readKV(key) {
    try {
      if (window.indexedDB) {
        const db = await new Promise((resolve, reject) => {
          const req = indexedDB.open("flugbuch-db", 1);
          req.onupgradeneeded = () => { req.result.createObjectStore("kv"); };
          req.onsuccess = () => resolve(req.result);
          req.onerror = () => reject(req.error);
        });
        const val = await new Promise((resolve, reject) => {
          const tx = db.transaction("kv", "readonly");
          const req = tx.objectStore("kv").get(PREFIX + key);
          req.onsuccess = () => resolve(req.result);
          req.onerror = () => reject(req.error);
        });
        if (val !== undefined) return JSON.parse(val);
      }
    } catch {}
    try {
      const raw = localStorage.getItem(PREFIX + key);
      if (raw) return JSON.parse(raw);
    } catch {}
    return null;
  }

  reserves = await readKV("service:reserves");
  schirme = await readKV("service:schirme");

  const candidates = [];
  if (reserves) {
    Object.keys(reserves).forEach(id => {
      const slot = reserves[id];
      const lastCheck = (slot.checks && slot.checks.length ? parseDateStr(slot.checks[0].date) : null) || parseDateStr(slot.purchaseDate);
      const nextDue = lastCheck ? addMonthsToDate(lastCheck, slot.intervalMonths||12) : null;
      if (nextDue) candidates.push({ name: slot.name || RESERVE_LABELS[id] || id, nextDue, days: daysUntilDate(nextDue), kind: "packen" });
    });
  }
  if (schirme) {
    Object.keys(schirme).forEach(id => {
      const slot = schirme[id];
      if (!slot.category || slot.category === "–") return;
      const lastCheck = (slot.checks && slot.checks.length ? parseDateStr(slot.checks[0].date) : null) || parseDateStr(slot.purchaseDate);
      const nextDue = lastCheck ? addMonthsToDate(lastCheck, slot.intervalMonths||12) : null;
      if (nextDue) candidates.push({ name: slot.name || slot.category, nextDue, days: daysUntilDate(nextDue), kind: "check" });
    });
  }

  if (!candidates.length) return { packen: null, check: null };

  // Most urgent (soonest / most overdue) per kind
  const mostUrgent = (kind) => {
    const list = candidates.filter(c => c.kind === kind);
    if (!list.length) return null;
    return list.sort((a,b) => a.days - b.days)[0];
  };

  return { packen: mostUrgent("packen"), check: mostUrgent("check") };
}

const GERMAN_MONTH_NAMES = ["Januar","Februar","März","April","Mai","Juni","Juli","August","September","Oktober","November","Dezember"];
function fmtMonthYear(date) {
  if (!date) return "";
  const d = new Date(date);
  return `${GERMAN_MONTH_NAMES[d.getMonth()]} ${d.getFullYear()}`;
}

function formatServiceStat(entry, fallbackLabel) {
  if (!entry) return { label: fallbackLabel };
  const overdue = entry.days < 0;
  const soonDue = entry.days >= 0 && entry.days <= 30;
  const label = `${fallbackLabel}: ${entry.name} · ${fmtMonthYear(entry.nextDue)}`;
  if (overdue) return { label, color: "#f87171" };
  if (soonDue) return { label, color: "#fcd34d" };
  return { label };
}

function HomeApp() {
  const isWide = useIsWide();
  const [photoUrl, setPhotoUrl] = useState(null);
  const fileRef = React.useRef(null);
  const [flightCount, setFlightCount] = useState(null);
  const [biplaceCount, setBiplaceCount] = useState(null);
  const [serviceUrgency, setServiceUrgency] = useState({ packen: null, check: null });
  const [statistikCounts, setStatistikCounts] = useState({ startSites: null, endSites: null, gliders: null, biplace: null });

  useEffect(() => {
    readServiceUrgency().then(setServiceUrgency);
  }, []);

  useEffect(() => {
    // Load previously saved photo (stored as a base64 data URL, since blob:
    // URLs from createObjectURL don't survive a reload).
    try {
      const saved = localStorage.getItem("flugbuch:homePhoto");
      if (saved) setPhotoUrl(saved);
    } catch {}
  }, []);

  useEffect(() => {
    readFlightStatsFromStorage().then(({ total, biplace, startSites, endSites, gliders }) => {
      setFlightCount(total);
      setBiplaceCount(biplace);
      setStatistikCounts({ startSites, endSites, gliders, biplace });
    });
  }, []);

  const onPickPhoto = (e) => {
    const file = e.target.files && e.target.files[0];
    if (!file) return;
    const img = new Image();
    const reader = new FileReader();
    reader.onload = () => {
      img.onload = () => {
        // Downscale to a sane max width and re-encode as JPEG — a raw phone
        // photo can be several MB as base64, which alone can exceed the
        // localStorage quota shared with all saved flights. A resized,
        // compressed copy looks identical as a background image but is
        // typically well under 200KB.
        const MAX_W = 1200;
        const scale = Math.min(1, MAX_W / img.width);
        const canvas = document.createElement("canvas");
        canvas.width = Math.round(img.width * scale);
        canvas.height = Math.round(img.height * scale);
        const ctx = canvas.getContext("2d");
        ctx.drawImage(img, 0, 0, canvas.width, canvas.height);
        const dataUrl = canvas.toDataURL("image/jpeg", 0.8);
        setPhotoUrl(dataUrl);
        try {
          localStorage.setItem("flugbuch:homePhoto", dataUrl);
        } catch (err) {
          console.error("Photo save error:", err);
          alert("Foto konnte nicht gespeichert werden (Speicherplatz voll?). Es bleibt nur bis zum nächsten Laden sichtbar.");
        }
      };
      img.src = reader.result;
    };
    reader.readAsDataURL(file);
  };

  const TILES = [
    {
      id: "flugbuch",
      label: "Flugbuch",
      icon: "✈️",
      color: "#1e5fd6",
      glow: "rgba(30,95,214,0.55)",
      stats: [
        { label: `${flightCount ?? "—"} Flüge`, color: "#7dd3fc" },
        { label: `${biplaceCount ?? "—"} Biplace`, color: "#fcd34d" },
      ],
      href: "flugbuch.html",
      ready: true,
    },
    {
      id: "statistik",
      label: "Statistik",
      icon: "📊",
      color: "#e0304a",
      glow: "rgba(224,48,74,0.55)",
      stats: [
        { label: `${statistikCounts.startSites ?? "—"} Startplätze` },
        { label: `${statistikCounts.endSites ?? "—"} Landeplätze` },
        { label: `${statistikCounts.biplace ?? "—"} Passagierflüge` },
        { label: `${statistikCounts.gliders ?? "—"} Schirme` },
      ],
      href: "statistik.html",
      ready: true,
    },
    {
      id: "service",
      label: "Service",
      icon: "🛠️",
      color: "#22c55e",
      glow: "rgba(34,197,94,0.5)",
      stats: [
        formatServiceStat(serviceUrgency.check, "Nächster Check"),
        formatServiceStat(serviceUrgency.packen, "Nächstes Packen"),
      ],
      href: "service.html",
      ready: true,
    },
    {
      id: "reisen",
      label: "Reisen",
      icon: "🧭",
      color: "#f5a623",
      glow: "rgba(245,166,35,0.55)",
      stats: [{ label: "Anzahl" }],
      href: null,
      ready: false,
    },
  ];

  return (
    <div style={{
      height: "100vh",
      overflow: "hidden",
      display: "flex",
      flexDirection: "column",
      background: "#5c6470",
      color: "#e8f4fd",
      fontFamily: "-apple-system,BlinkMacSystemFont,sans-serif",
    }}>
      {/* Title */}
      <div style={{ padding: "calc(10px + env(safe-area-inset-top, 0px)) 20px 10px", textAlign: "center", flexShrink: 0, position: "relative" }}>
        <div style={{ fontSize: 24, fontWeight: 800, letterSpacing: -0.5, color: "#ffffff" }}>
          mein<span style={{ color: "#f59e0b" }}>flug</span>App
        </div>
        <span style={{ position: "absolute", right: 20, bottom: 8, fontSize: 10, color: "rgba(255,255,255,0.35)", fontWeight: 600 }}>
          v0.19
        </span>
      </div>

      <div style={{ height: 1, background: "rgba(255,255,255,0.08)", margin: "0 20px", flexShrink: 0 }} />

      {/* Editable photo / "cockpit window" — narrower aspect ratio so it takes less vertical space */}
      <div style={{ padding: "12px 20px", flexShrink: 0 }}>
        <input ref={fileRef} type="file" accept="image/*" style={{ display: "none" }} onChange={onPickPhoto} />
        <div
          onClick={() => fileRef.current && fileRef.current.click()}
          style={{
            position: "relative",
            borderRadius: 18,
            overflow: "hidden",
            aspectRatio: isWide ? "21/6" : "21/9",
            background: photoUrl
              ? `#000 url(${photoUrl}) center/cover no-repeat`
              : "linear-gradient(180deg, #4a5260 0%, #3d4552 60%, #333a45 100%)",
            border: "1px solid rgba(255,255,255,0.14)",
            cursor: "pointer",
            display: "flex",
            alignItems: "flex-end",
            justifyContent: "space-between",
          }}
        >
          {!photoUrl && (
            <svg
              style={{ position: "absolute", inset: 0, width: "100%", height: "100%", opacity: 0.5 }}
              viewBox="0 0 400 171" preserveAspectRatio="none"
            >
              <path d="M0,110 Q100,80 200,100 T400,90" stroke="#7dd3fc" strokeWidth="1.5" fill="none" opacity="0.35" />
              <circle cx="320" cy="35" r="16" fill="#fcd34d" opacity="0.5" />
              <path d="M40,135 L90,112 L120,122 L200,90" stroke="#e8f4fd" strokeWidth="1" fill="none" opacity="0.15" />
            </svg>
          )}
          <div style={{ position: "relative", padding: "8px 12px", fontSize: 11, color: "rgba(232,244,253,0.55)", display: "flex", alignItems: "center", gap: 5 }}>
            <span style={{ fontSize: 13 }}>📷</span>
            {photoUrl ? "Bild ändern" : "Bild hinzufügen"}
          </div>
        </div>
      </div>

      <div style={{ height: 1, background: "rgba(255,255,255,0.08)", margin: "0 20px", flexShrink: 0 }} />

      {/* Tiles — fill remaining space, each tile sized proportionally */}
      <div style={{ padding: "10px 20px", display: "flex", flexDirection: "column", gap: 9, flex: 1, minHeight: 0 }}>
        {TILES.map((t) => (
          <div
            key={t.id}
            onClick={() => {
              if (t.ready && t.href) window.location.href = t.href;
            }}
            style={{
              position: "relative",
              display: "flex",
              alignItems: "stretch",
              flex: 1,
              minHeight: 0,
              borderRadius: 14,
              background: "rgba(255,255,255,0.035)",
              border: `1px solid ${t.ready ? "rgba(255,255,255,0.09)" : "rgba(255,255,255,0.05)"}`,
              overflow: "hidden",
              cursor: t.ready ? "pointer" : "default",
              opacity: t.ready ? 1 : 0.75,
              transition: "transform 0.15s, background 0.15s",
            }}
          >
            {/* Accent rail */}
            <div style={{ width: 5, background: t.color, opacity: t.ready ? 1 : 0.5, flexShrink: 0, boxShadow: t.ready ? `0 0 12px ${t.color}` : "none" }} />

            {/* Icon block */}
            <div
              style={{
                width: 92,
                flexShrink: 0,
                display: "flex",
                alignItems: "center",
                justifyContent: "center",
                fontSize: 26,
                background: `radial-gradient(circle, ${t.glow} 0%, ${t.glow} 40%, transparent 85%)`,
              }}
            >
              {t.icon}
            </div>

            {/* Label + stats */}
            <div style={{ flex: 1, padding: "8px 14px 8px 4px", minWidth: 0, display: "flex", flexDirection: "column", justifyContent: "center" }}>
              <div style={{ display: "flex", alignItems: "center", gap: 8, marginBottom: 5 }}>
                <div style={{ fontSize: 16, fontWeight: 700, color: t.ready ? "#e8f4fd" : "rgba(232,244,253,0.6)" }}>
                  {t.label}
                </div>
                {!t.ready && (
                  <span style={{
                    fontSize: 9, fontWeight: 700, letterSpacing: 0.5,
                    color: "rgba(232,244,253,0.4)",
                    border: "1px solid rgba(232,244,253,0.15)",
                    borderRadius: 20, padding: "1px 7px",
                  }}>
                    BALD
                  </span>
                )}
              </div>
              <div style={{ display: "flex", flexWrap: "wrap", gap: 6 }}>
                {t.stats.map((s) => (
                  <span
                    key={s.label}
                    style={{
                      fontSize: 10,
                      fontWeight: s.color ? 700 : 400,
                      color: s.color || "rgba(232,244,253,0.75)",
                      background: "rgba(255,255,255,0.04)",
                      border: "1px solid rgba(255,255,255,0.06)",
                      borderRadius: 20,
                      padding: "2px 8px",
                    }}
                  >
                    {s.label}
                  </span>
                ))}
              </div>
            </div>

            {/* Chevron */}
            <div style={{ display: "flex", alignItems: "center", paddingRight: 16, color: t.ready ? t.color : "rgba(232,244,253,0.25)", fontSize: 16 }}>
              {t.ready ? "›" : "·"}
            </div>
          </div>
        ))}
      </div>
    </div>
  );
}
