const { useState } = React;

// ── Content data ─────────────────────────────────────────────────────────
// Kept as data (not hardcoded JSX per section) so the table of contents can
// be generated from the same list that renders the sections, guaranteeing
// they can never drift out of sync with each other.
const SECTIONS = [
  {
    id: "ueberblick", title: "1. Überblick",
    body: () => (<>
      <p>meinflugbuch ist ein digitales Flugbuch für Gleitschirmflieger, das direkt im Browser läuft. Kein Account nötig, alle Daten werden lokal auf dem Gerät gespeichert.</p>
      <h3>1.1 Aufbau der App (die 4 Kapitel)</h3>
      <table><tbody>
        <tr><td>✈️</td><td><b>Flugbuch</b></td><td>Liste aller Flüge, Suche, IGC-/CSV-Import, Backup, Detailansicht mit Karte und Höhenprofil</td></tr>
        <tr><td>📊</td><td><b>Statistik</b></td><td>Automatische Auswertungen nach Schirm, Start-/Landeplätzen, Passagieren und Saison</td></tr>
        <tr><td>🧭</td><td><b>Reisen</b></td><td>Flüge zu Reisen zusammengefasst, mit Kennzahlen je Reise</td></tr>
        <tr><td>🛠️</td><td><b>Wartung</b></td><td>Ausrüstungsverwaltung inkl. Packen-Intervall und fälligem Packdatum</td></tr>
      </tbody></table>
      <h3>1.2 Offline-Nutzung — wichtige Einschränkung</h3>
      <p>Die App benötigt <b>beim Starten/Neuladen immer eine Internetverbindung</b>, da die Programmlogik jedes Mal frisch geladen wird. Ist die App bereits offen, funktionieren bereits gespeicherte Flüge (ansehen/bearbeiten) auch ohne Verbindung. Folgendes braucht in jedem Fall eine Verbindung, auch bei bereits offener App:</p>
      <ul>
        <li>Kartenkacheln (Flug-Track-Karte, Weltkarte)</li>
        <li>Höhenprofil-Bodendaten</li>
        <li>Zeitzonen-Bestimmung beim IGC-Import</li>
        <li>GPS Visualizer und andere externe Links</li>
      </ul>
      <h3>1.3 Wo werden die Daten gespeichert?</h3>
      <p>Alle Einträge werden in einem app-eigenen Speicher auf dem jeweiligen Gerät abgelegt. Es gibt keine Cloud-Synchronisation zwischen mehreren Geräten. Für den Umzug auf ein neues Gerät oder als Sicherheitskopie dient die Backup-Funktion (siehe 2.9). <b>Wichtig:</b> Wird der Browser-Cache geleert, gehen gespeicherte Flüge ohne vorheriges Backup verloren.</p>
    </>),
  },
  {
    id: "home", title: "2. Startseite",
    body: () => (<>
      <p>Zeigt ein editierbares Titelbild mit dem App-Namen, darunter die vier Kapitel-Kacheln.</p>
      <h3>2.1 Titelbild ändern</h3>
      <p>Auf das Titelbild tippen öffnet die Bildauswahl des Geräts. Das Foto wird lokal gespeichert.</p>
      <h3>2.2 Einstellungen (Zahnrad)</h3>
      <p>Öffnet ein Panel mit Hilfe, Datensicherung (Backup/Wiederherstellen) und Notizen.</p>
    </>),
  },
  {
    id: "flugbuch", title: "3. Flugbuch",
    body: () => (<>
      <h3>3.1 Flugliste</h3>
      <p>Standardmässig nach Jahr gruppiert, absteigend nach Nummer sortiert. Über die Sortier-Auswahl lässt sich nach vielen anderen Feldern sortieren (Datum, Dauer, Distanz, Startplatz, Bewertung u.a.), die Richtung über den Pfeil-Button daneben.</p>
      <h3>3.2 Suche</h3>
      <p>Durchsucht alle Felder eines Flugs gleichzeitig. Erweiterte Operatoren:</p>
      <table><tbody>
        <tr><td><code>feld:wert</code></td><td>Teiltext-Suche in einem Feld, z.B. <code>startplatz:Fiesch</code></td></tr>
        <tr><td><code>feld=wert</code></td><td>exakte Übereinstimmung</td></tr>
        <tr><td><code>feld&gt;wert</code> / <code>&lt;</code> / <code>&gt;=</code> / <code>&lt;=</code></td><td>Vergleiche (Zahlen, Datum, Zeit, Text alphabetisch)</td></tr>
        <tr><td><code>feld!=wert</code></td><td>Ausschluss</td></tr>
        <tr><td><code>+wort</code> / <code>-wort</code></td><td>muss enthalten sein / darf nicht enthalten sein</td></tr>
        <tr><td><code>passagier:*</code></td><td>beliebiger Passagier (Biplace-Filter)</td></tr>
      </tbody></table>
      <p className="hint">💡 Mehrere Bedingungen kombinierbar, z.B. <code>jahr=2026 dauer&gt;2h</code>.</p>
      <h3>3.3 Icon-Reihe (6 Buttons)</h3>
      <ul>
        <li>📥 Import — IGC-Dateien, CSV oder eingefügte Tabellenzeilen (Copy/Paste aus Numbers/Excel). Kopfzeilen-Erkennung ordnet Spalten automatisch zu, sofern vorhanden.</li>
        <li>💾 Backup — Datensicherung exportieren/wiederherstellen</li>
        <li>☑ Auswahl — Mehrfachauswahl von Flügen (z.B. für die Weltkarte)</li>
        <li>🗺️ Weltkarte — siehe 3.6</li>
        <li>↕ Richtung — Sortierrichtung umkehren</li>
        <li>Jahr — nach Jahr filtern</li>
      </ul>
      <h3>3.4 IGC-Import — was automatisch ausgefüllt wird</h3>
      <ul>
        <li>Datum, Startzeit, Landezeit (inkl. Zeitzonen-Umrechnung)</li>
        <li>Startplatz-Name, Start-/Landekoordinaten</li>
        <li>Schirm-Modell und Passagier, falls im Logger hinterlegt</li>
        <li>Dauer, Höhengewinn, max./min. Höhe, max. Steigen/Sinken</li>
      </ul>
      <p><b>Distanz wird nie automatisch berechnet</b> — bewusst manuell, da XContest-Werte (Streckenoptimierung über Wendepunkte) massgeblich sind, nicht die reine Tracklänge. Ein erneuter Import befüllt nur leere Felder; Dauer und Höhendifferenz werden immer neu berechnet, da rein rechnerisch.</p>
      <h3>3.5 Flugdetail: Karte &amp; Höhenprofil</h3>
      <p>Karte zeigt den Track höhenfarbig (rot = tief, blau = hoch); Vollbild per Antippen, Link zu GPS Visualizer. Höhenprofil zeigt Höhe über Distanz mit braunem Bodenprofil (echte Geländedaten), proportional auf die eingetragene Distanz skaliert.</p>
      <ul>
        <li>🔍 Zoom-Button — Listenauswahl 1× bis 8×</li>
        <li>Bei Zoom: im Profil wischen, um den Ausschnitt zu verschieben</li>
        <li>Karte zoomt dabei synchron mit, roter Referenzpunkt an der Fenster-Mitte</li>
        <li>Gestrichelte Linie im Profil markiert diese Mitte</li>
      </ul>
      <h3>3.6 Weltkarte</h3>
      <p>Start-/Landeplätze (grün/rot) auf einer Karte, einzeln ein-/ausblendbar. Bei aktiver Auswahl (☑-Modus) zeigt sie nur diese Flüge. Suche: mehrere Wörter automatisch UND-verknüpft, das Wort „oder&quot; trennt Alternativen, z.B. <code>2026 Brasilien oder Wallis</code>.</p>
    </>),
  },
  {
    id: "statistik", title: "4. Statistik",
    body: () => (<>
      <p>Fünf farbige Badges, volle Bildschirmbreite:</p>
      <ul>
        <li>🪂 Schirm (blau) — Flüge, Flugzeit, Distanz, Bewertungen je Fluggerät</li>
        <li>🛫 Startplätze (grün)</li>
        <li>🛬 Landeplätze (orange)</li>
        <li>👤 Passagiere (violett) — erster/letzter Flug je Person, Bewertungen</li>
        <li>📅 Saison (rot) — Jahresauswahl mit Kennzahlen und persönlichen Rekorden</li>
      </ul>
    </>),
  },
  {
    id: "reisen", title: "5. Reisen",
    body: () => (<p>Fasst Flüge zu Reisen zusammen. Reisen erstellen/verwalten über „Reisen verwalten&quot;. Jede Reisekarte zeigt Titel, Zeitraum, Schirm, alle zugehörigen Flüge mit Distanz/Dauer sowie Gesamtkennzahlen (Flüge, Flugzeit, Ø Zeit/Flug, Nummernbereich).</p>),
  },
  {
    id: "wartung", title: "6. Wartung",
    body: () => (<p>Verwaltet Ausrüstung: Name, Serien-Nummer, Kaufdatum, Packen-Intervall (Monate) und eine Liste vergangener Packvorgänge mit Datum und Notiz. Das nächste fällige Packdatum wird automatisch angezeigt.</p>),
  },
  {
    id: "backup", title: "7. Datensicherung",
    body: () => (<p>Über den 💾-Button im Flugbuch oder die Einstellungen kann der komplette Datenbestand (Flüge, Wartung, Reisen, Notizen) als Datei exportiert und auf einem anderen Gerät oder nach einem Neustart wieder eingespielt werden. Regelmässige Backups werden empfohlen.</p>),
  },
];

function HilfeApp() {
  const [openId, setOpenId] = useState(null);

  const goBack = () => {
    if (document.referrer && document.referrer.includes(location.host)) {
      window.location.href = document.referrer;
    } else if (window.history.length > 1) {
      window.history.back();
    } else {
      window.location.href = "index.html";
    }
  };

  return (
    <div style={{minHeight:"100vh",background:"#040e20",color:"#e8f4fd",fontFamily:"-apple-system,BlinkMacSystemFont,sans-serif",paddingBottom:40}}>
      <style>{`
        .hilfe-body h3 { font-size:14px; color:#7dd3fc; margin:16px 0 6px; }
        .hilfe-body p { font-size:13.5px; line-height:1.55; color:rgba(232,244,253,0.85); margin:0 0 10px; }
        .hilfe-body p.hint { font-size:12px; color:rgba(232,244,253,0.5); border-left:2px solid #7dd3fc; padding-left:8px; }
        .hilfe-body ul { margin:0 0 10px; padding-left:20px; }
        .hilfe-body li { font-size:13.5px; line-height:1.55; color:rgba(232,244,253,0.85); margin-bottom:4px; }
        .hilfe-body table { width:100%; border-collapse:collapse; margin-bottom:10px; }
        .hilfe-body td { font-size:12.5px; color:rgba(232,244,253,0.8); padding:5px 8px; border-bottom:1px solid rgba(255,255,255,0.06); vertical-align:top; }
        .hilfe-body code { background:rgba(255,255,255,0.08); padding:1px 5px; border-radius:4px; font-size:12px; }
      `}</style>

      {/* Header */}
      <div style={{background:"rgba(255,255,255,0.03)",borderBottom:"1px solid rgba(255,255,255,0.06)",padding:"calc(28px + env(safe-area-inset-top, 0px)) 16px 12px",display:"flex",alignItems:"center",position:"sticky",top:0,zIndex:10,backdropFilter:"blur(10px)"}}>
        <button onClick={goBack} title="Zurück"
          style={{background:"rgba(255,255,255,0.06)",border:"1px solid rgba(255,255,255,0.1)",borderRadius:10,width:32,height:32,display:"flex",alignItems:"center",justifyContent:"center",fontSize:18,color:"rgba(232,244,253,0.8)",cursor:"pointer",flexShrink:0}}>
          ‹
        </button>
        <span style={{fontWeight:900,fontSize:18,letterSpacing:-0.5,flex:1,textAlign:"center",marginLeft:-32}}>
          ❓ Hilfe
        </span>
      </div>

      {/* Table of contents */}
      <div style={{padding:"16px 16px 4px"}}>
        <div style={{fontSize:11,fontWeight:700,color:"#7dd3fc",letterSpacing:1.5,textTransform:"uppercase",marginBottom:8}}>Inhalt</div>
        <div style={{display:"flex",flexDirection:"column",gap:2}}>
          {SECTIONS.map(s => (
            <a key={s.id} href={"#"+s.id}
              style={{color:"#e8f4fd",fontSize:14,textDecoration:"none",padding:"6px 2px"}}>
              {s.title}
            </a>
          ))}
        </div>
      </div>

      {/* Sections */}
      <div style={{padding:"8px 16px 0"}}>
        {SECTIONS.map(s => (
          <div key={s.id} id={s.id} style={{marginTop:22,paddingTop:6}}>
            <div style={{fontSize:17,fontWeight:800,color:"#e0304a",marginBottom:8}}>{s.title}</div>
            <div className="hilfe-body">{s.body()}</div>
          </div>
        ))}
      </div>

      <div style={{textAlign:"center",padding:"24px 16px 8px",fontSize:10,color:"rgba(232,244,253,0.25)"}}>
        meinflugbuch — Hilfe
      </div>
    </div>
  );
}
