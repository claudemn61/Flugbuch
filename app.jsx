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

function HomeApp() {
  const isWide = useIsWide();
  const [photoUrl, setPhotoUrl] = useState(null);
  const fileRef = React.useRef(null);
  const [flightCount, setFlightCount] = useState(null);
  const [biplaceCount, setBiplaceCount] = useState(null);

  useEffect(() => {
    // Read the same flight:* keys the Flugbuch app stores, directly from
    // localStorage (same shim/prefix), so the tile can show real totals
    // without needing to load the whole Flugbuch app.
    try {
      let total = 0, biplace = 0;
      for (let i = 0; i < localStorage.length; i++) {
        const key = localStorage.key(i);
        if (!key || !key.startsWith("flugbuch:flight:")) continue;
        try {
          const f = JSON.parse(localStorage.getItem(key));
          total++;
          if (f?.customFields?.passagier && String(f.customFields.passagier).trim()) biplace++;
        } catch {}
      }
      setFlightCount(total);
      setBiplaceCount(biplace);
    } catch {
      setFlightCount(null);
      setBiplaceCount(null);
    }
  }, []);

  const onPickPhoto = (e) => {
    const file = e.target.files && e.target.files[0];
    if (!file) return;
    const url = URL.createObjectURL(file);
    setPhotoUrl(url);
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
      stats: [{ label: "Startplätze" }, { label: "Landeplätze" }, { label: "Schirme" }],
      href: null,
      ready: false,
    },
    {
      id: "service",
      label: "Service",
      icon: "🛠️",
      color: "#22c55e",
      glow: "rgba(34,197,94,0.5)",
      stats: [{ label: "Nächster Check" }, { label: "Nächstes Packen" }],
      href: null,
      ready: false,
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
      minHeight: "100vh",
      background: "#5c6470",
      color: "#e8f4fd",
      fontFamily: "-apple-system,BlinkMacSystemFont,sans-serif",
      paddingBottom: 40,
    }}>
      {/* Title */}
      <div style={{ padding: "28px 20px 18px", textAlign: "center" }}>
        <div style={{ fontSize: 28, fontWeight: 800, letterSpacing: -0.5, color: "#ffffff" }}>
          {isWide ? (
            <>mein<span style={{ color: "#f59e0b" }}>Flug</span>App</>
          ) : (
            <>m<span style={{ color: "#f59e0b" }}>Flug</span>App</>
          )}
        </div>
      </div>

      <div style={{ height: 1, background: "rgba(255,255,255,0.08)", margin: "0 20px" }} />

      {/* Editable photo / "cockpit window" */}
      <div style={{ padding: "22px 20px" }}>
        <input ref={fileRef} type="file" accept="image/*" style={{ display: "none" }} onChange={onPickPhoto} />
        <div
          onClick={() => fileRef.current && fileRef.current.click()}
          style={{
            position: "relative",
            borderRadius: 20,
            overflow: "hidden",
            aspectRatio: "16/9",
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
              viewBox="0 0 400 225" preserveAspectRatio="none"
            >
              <path d="M0,150 Q100,110 200,140 T400,120" stroke="#7dd3fc" strokeWidth="1.5" fill="none" opacity="0.35" />
              <circle cx="320" cy="45" r="22" fill="#fcd34d" opacity="0.5" />
              <path d="M40,180 L90,150 L120,165 L200,120" stroke="#e8f4fd" strokeWidth="1" fill="none" opacity="0.15" />
            </svg>
          )}
          <div style={{ position: "relative", padding: "12px 14px", fontSize: 12, color: "rgba(232,244,253,0.55)", display: "flex", alignItems: "center", gap: 6 }}>
            <span style={{ fontSize: 14 }}>📷</span>
            {photoUrl ? "Bild ändern" : "Bild hinzufügen"}
          </div>
        </div>
      </div>

      <div style={{ height: 1, background: "rgba(255,255,255,0.08)", margin: "0 20px 6px" }} />

      {/* Tiles */}
      <div style={{ padding: "16px 20px 0", display: "flex", flexDirection: "column", gap: 12 }}>
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
              borderRadius: 16,
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
                width: 84,
                flexShrink: 0,
                display: "flex",
                alignItems: "center",
                justifyContent: "center",
                fontSize: 30,
                background: `radial-gradient(circle, ${t.glow} 0%, transparent 75%)`,
              }}
            >
              {t.icon}
            </div>

            {/* Label + stats */}
            <div style={{ flex: 1, padding: "14px 14px 14px 4px", minWidth: 0 }}>
              <div style={{ display: "flex", alignItems: "center", gap: 8, marginBottom: 6 }}>
                <div style={{ fontSize: 17, fontWeight: 700, color: t.ready ? "#e8f4fd" : "rgba(232,244,253,0.6)" }}>
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
                      fontSize: 10.5,
                      fontWeight: s.color ? 700 : 400,
                      color: s.color || "rgba(232,244,253,0.45)",
                      background: "rgba(255,255,255,0.04)",
                      border: "1px solid rgba(255,255,255,0.06)",
                      borderRadius: 20,
                      padding: "3px 9px",
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
