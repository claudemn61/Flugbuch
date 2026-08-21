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
      <h3>1.1 Aufbau der App (die 5 Kapitel)</h3>
      <table><tbody>
        <tr><td>✈️</td><td><b>Flugbuch</b></td><td>Liste aller Flüge, Suche, IGC-/CSV-Import, Backup, Detailansicht mit Karte und Höhenprofil</td></tr>
        <tr><td>📊</td><td><b>Statistik</b></td><td>Automatische Auswertungen nach Schirm, Start-/Landeplätzen, Passagieren und Saison</td></tr>
        <tr><td>🧭</td><td><b>Reisen</b></td><td>Flüge zu Reisen zusammengefasst, mit Kennzahlen je Reise</td></tr>
        <tr><td>🎒</td><td><b>Ausrüstung</b></td><td>Zwei Tabs: <b>⚖️ Gewichte</b> (Material in 8 Kategorien, Setups mit Gesamtgewicht/Limite) und <b>🛠️ Wartung</b> (Reserve/Schirm/Sitz, Check-Intervall und fälliges Check-Datum)</td></tr>
      </tbody></table>
      <h3>1.2 Offline-Nutzung</h3>
      <p>Die App merkt sich beim ersten erfolgreichen Online-Aufruf automatisch ihre eigenen Dateien (Service Worker). Ab dem <b>zweiten</b> Online-Start funktioniert sie danach auch komplett ohne Internetverbindung, inkl. Öffnen der App über das Home-Bildschirm-Icon. Fehlt die Verbindung, erscheint unten ein gelbes Banner "Offline — zuletzt gespeicherter Stand" — die Nutzung ist davon nicht eingeschränkt.</p>
      <p>Nach jedem App-Update wird beim nächsten Online-Aufruf automatisch die neueste Version geladen (kein veralteter Stand sichtbar).</p>
      <p>Folgendes funktioniert offline nur eingeschränkt bzw. gar nicht, da es auf externe Dienste angewiesen ist, die nicht vorab gespeichert werden:</p>
      <ul>
        <li>Neue Kartenkacheln, die noch nie zuvor geladen wurden (bereits angesehene Ausschnitte bleiben gespeichert)</li>
        <li>Höhenprofil-Bodendaten für neue Flüge</li>
        <li>Zeitzonen-Bestimmung beim IGC-Import</li>
        <li>GPS Visualizer und andere externe Links</li>
      </ul>
      <h3>1.3 Wo werden die Daten gespeichert?</h3>
      <p>Alle Einträge werden in einem app-eigenen Speicher auf dem jeweiligen Gerät abgelegt. Es gibt keine Cloud-Synchronisation zwischen mehreren Geräten. Für den Umzug auf ein neues Gerät oder als Sicherheitskopie dient die Backup-Funktion (siehe 2.9). <b>Wichtig:</b> Wird der Browser-Cache geleert, gehen gespeicherte Flüge ohne vorheriges Backup verloren.</p>
      <h3>1.4 iPad/Desktop</h3>
      <p>Ab ca. 768px Bildschirmbreite (iPad, Mac-Browserfenster) wechseln mehrere Seiten automatisch auf ein breiteres Layout: Home zeigt Foto und Kacheln nebeneinander, Flugbuch eine Liste-plus-Detail-Ansicht (wie in Mail-Apps) mit kompakter einzeiliger Flugliste, Statistik alle Badges nebeneinander, Wartung alle Unterkacheln gleichzeitig als feste Spalten statt per Tab. Auf dem iPhone bleibt alles wie gewohnt.</p>
    </>),
  },
  {
    id: "home", title: "2. Startseite",
    body: () => (<>
      <p>Zeigt ein editierbares Titelfoto mit dem App-Namen, darunter die vier Kapitel-Kacheln (jede mit Live-Kennzahlen, z.B. Anzahl Flüge). Die Reisen-Kachel blendet sich automatisch aus, solange keine Reisen erfasst sind.</p>
      <h3>2.1 Titelfoto und Titeltext ändern</h3>
      <p>Auf das Foto tippen (ausserhalb des Titeltexts) öffnet die Bildauswahl des Geräts — das Foto wird lokal gespeichert. Auf den Titeltext selbst tippen öffnet stattdessen den Titel-Editor: beliebig viele Textteile, je mit eigener Farbe, sechs Schriftarten zur Auswahl, Schriftgrösse per Regler, mit Live-Vorschau. "Zurücksetzen" stellt "meinflugbuch" in der Standard-Optik wieder her.</p>
      <h3>2.2 Einstellungen (Zahnrad)</h3>
      <p>Öffnet ein Panel mit: der App-URL (antippen/halten zum Kopieren), ❓ Hilfe (diese Seite), 🪂 Schirme (Auswahl des Kartenmarkers, siehe unten), 📁 Log Files (technisches Fehlerprotokoll) und 📝 Notizen (freies App-weites Notizfeld). Die Datensicherung (Backup) liegt nicht hier, sondern im Flugbuch selbst (siehe 3.3).</p>
      <p>🪂 Schirme: 9 Symbol-Varianten für den Referenzpunkt auf der Karte und die Cine-Wiedergabe — "Eigenes Symbol" (frei eintippbarer Buchstabe oder Emoji), ein fixes 🪂-Emoji, sowie 7 selbst fotografierte Schirm-Fotos. Die Auswahl gilt app-weit und wirkt sofort auch auf bereits geöffnete Flugdetails.</p>
    </>),
  },
  {
    id: "flugbuch", title: "3. Flugbuch",
    body: () => (<>
      <h3>3.1 Flugliste</h3>
      <p>Standardmässig nach Jahr gruppiert, absteigend nach Nummer sortiert. Über die Sortier-Auswahl lässt sich nach vielen anderen Feldern sortieren (Datum, Dauer, Distanz, Startplatz, Bewertung u.a.), die Richtung über den Pfeil-Button daneben.</p>
      <p>Zwei frei wählbare, unabhängige Gruppierungs-Ebenen stehen zur Verfügung ("📁 Gr. 1°" und "📁 Gr. 2°" unter Suchen/Sortieren, Gr. 2° verschachtelt innerhalb von Gr. 1°): Jahr, Schirm, Typ, Startplatz, Landeplatz, Reise, Hike-Ort oder Bewertung — beide standardmässig mit "Keine" wählbar. Werksseitig ist Gr. 1° auf Jahr voreingestellt, Gr. 2° auf Keine.</p>
      <p>Die Reihenfolge der Gruppen selbst lässt sich frei nach jedem beliebigen Datenfeld bestimmen — nicht nur alphabetisch nach dem Gruppierfeld: der ⇅-Button neben Gr. 1°/Gr. 2° öffnet dieselbe Feldliste wie "Sortieren", ergänzt um "Name" (zurück zum Standard) und "Anzahl" (nach Flügeanzahl pro Gruppe). Zahlenfelder (Dauer, Distanz, H.Diff., H.Gew., Entf. S-L, Bewertung, Hike-Höhenmeter) werden dabei über alle Flüge der Gruppe summiert (z.B. "Schirme nach Gesamt-Flugzeit sortieren"), Punkt-/Ortswerte (Datum, Zeiten, Höhen-Spitzenwerte, Start-/Landehöhe, Speed u.a.) nehmen den kleinsten/frühesten Wert der Gruppe, Textfelder den alphabetisch ersten. Ein bereits gewähltes Feld nochmals antippen kehrt die Richtung um (erst absteigend, dann aufsteigend). Jede Ebene hat zusätzlich ein eigenes Alle-ein-/ausklappen (+).</p>
      <p>💡-Kachel zwischen Suchen und Sortieren: gespeicherte Darstellungen der Flugliste. Sichert den kompletten aktuellen Zustand (Suche, Sortieren inkl. Richtung, Gr. 1°/Gr. 2° inkl. deren eigener Sortierrichtung) unter einem frei wählbaren Namen — "💾 Speichern als…" oben in der Liste. Auf eine gespeicherte Darstellung tippen wendet sie sofort komplett an. "🔀 Verschieben" und "🗑 Löschen" schalten je einen Modus um, in dem die Liste statt zum Anwenden zum Umsortieren bzw. Entfernen einzelner Darstellungen dient.</p>
      <p>Die Sortierrichtung der Flugliste selbst (↑↓, für die Flüge innerhalb der Gruppen) liegt ebenfalls im Suchen/Sortieren-Panel, direkt neben der Feldauswahl.</p>
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
      <h3>3.3 Icon-Reihe (5 Buttons)</h3>
      <ul>
        <li>📥 Import — IGC-Dateien, CSV oder Hike-GPX-Routen. Erkennt Kopfzeilen und ordnet Spalten flexibel zu (auch bei abweichender Reihenfolge/Bezeichnung, deutsch oder englisch) — ohne erkennbare Kopfzeile gilt das feste Spaltenformat dieser App.</li>
        <li>☁️ Backup — Datensicherung exportieren/wiederherstellen (gzip-komprimiert, siehe 7.), roter Punkt am Button bei ungesicherten Änderungen</li>
        <li>☑ Auswahl — Mehrfachauswahl von Flügen (z.B. für die Weltkarte, oder Sammel-Bearbeitung/Löschen)</li>
        <li>🗺️ Weltkarte — siehe 3.7</li>
        <li>🔍 Suchen/Sortieren — blendet das Such-/Sortier-/Gruppieren-Panel ein/aus (siehe 3.1/3.2), um Platz zu sparen. Darin: Suchen, Sortieren (⇅) mit eigener Richtung (↑↓), sowie die beiden Gruppierungs-Ebenen Gr. 1°/Gr. 2° mit je eigener Richtung und Alle-ein-/ausklappen (+) — diese lagen früher als eigene Kacheln direkt in dieser Icon-Reihe, sind aber ins Panel gewandert.</li>
      </ul>
      <h3>3.4 IGC-Import — was automatisch ausgefüllt wird</h3>
      <ul>
        <li>Datum, Startzeit, Landezeit (inkl. Zeitzonen-Umrechnung)</li>
        <li>Startplatz-Name, Start-/Landekoordinaten</li>
        <li>Schirm-Modell und Passagier, falls im Logger hinterlegt</li>
        <li>Dauer, Höhengewinn, max./min. Höhe, max. Steigen/Sinken</li>
      </ul>
      <p><b>Distanz wird nie automatisch berechnet</b> — bewusst manuell, da XContest-Werte (Streckenoptimierung über Wendepunkte) massgeblich sind, nicht die reine Tracklänge. Ein erneuter Import befüllt nur leere Felder; Dauer und Höhendifferenz werden immer neu berechnet, da rein rechnerisch. Ein königsblauer "XContest"-Button neben dem IGC-Badge im Flugdetail öffnet direkt die eigene XContest-Flugliste.</p>
      <p>Max. Steigen/Sinken wird über ein 30-Sekunden-Zeitfenster ermittelt (grösste Höhenänderung innerhalb eines beliebigen 30-Sekunden-Abschnitts) — dieses Zeitfenster wurde anhand eigener Flüge mit bekannten XContest-Werten empirisch bestimmt und kommt den XContest-Werten deutlich näher als eine reine Momentanwert-Berechnung.</p>
      <h3>3.5 Hike-GPX-Import</h3>
      <p>Für Hike & Fly: eine separate, eigenständige Wanderroute (z.B. aus Komoot, AllTrails o.ä. exportiert) lässt sich zusätzlich zum eigentlichen Flug-Track speichern. Über die 🥾-Kachel im Import-Menü, per Zeitstempel im GPX automatisch dem passenden Flug (gleiches Datum) zugeordnet. Gibt es mehrere Flüge an diesem Datum, fragt die App nach, welchem die Route zugeordnet werden soll. Fehlt der Zeitstempel ganz, fragt die App stattdessen nach der Flugnummer. Ist in der Flugliste genau 1 Flug markiert (Auswahl-Modus), importiert die 🥾-Kachel direkt zu diesem Flug, ganz ohne Datums-Abgleich.</p>
      <p>Auf der Karte erscheint die Hike-Route grün gestrichelt, neben dem blauen Flug-Track. Zusätzlich zeigt ein eigenes grünes Hike-Höhenprofil (kompakt, ohne Zoom) die Höhenwerte über der Distanz, direkt über dem normalen Höhenprofil. Die Cine-Wiedergabe kombiniert beide: die Hike-Phase (🥾-Symbol, fixe Ausrichtung) spielt zuerst, pausiert automatisch am Übergang zum Flug, danach läuft die Flug-Phase (🪂) wie gewohnt weiter — beide Profile zeigen dabei live die passende Position.</p>
      <p>In der Flugliste zeigt ein rotes "GPX"-Badge direkt neben dem IGC-Badge, wenn ein Flug eine Hike-Route hat.</p>
      <p>Export als eigene GPX-Datei im Flugdetail ("⬇ Hike", neben "⬇ IGC" und "⬇ GPX"). Löschen über die konsolidierte 🗑-Kachel im Flugdetail, die zwischen IGC-Track, GPX Hike und dem ganzen Flug wählen lässt.</p>
      <p>Nach erfolgreichem Import erscheint zusätzlich eine "🥾 Hike-Daten"-Kachel direkt über den Flugdaten: Startpunkt (akzeptiert auch Koordinaten, z.B. "46.5, 8.1"), Ort (beim Import aus dem Routennamen der GPX-Datei vorbefüllt, falls vorhanden — sonst frei editierbar; automatisches Reverse-Geocoding aus den Koordinaten wurde getestet, aber wegen unzuverlässiger Treffer wieder entfernt), Starthöhe (automatisch aus den Koordinaten des Startpunkts berechnet), Höhenmeter (live berechnet aus Startplatzhöhe minus Starthöhe, kein eigenes Eingabefeld), Dauer, sowie ein frei benennbares "Zusatz"-Feld — dessen Titel selbst antippbar und umbenennbar ist.</p>
      <p>Passt eine IGC-Datei zu keiner Flug-Nr. im Dateinamen, wird zusätzlich nach Datum gegen Flüge ohne GPS-Track abgeglichen. Bei genau einem Treffer wird automatisch zugeordnet; bei mehreren Flügen am selben Tag fragt die App aktiv nach, welchem Flug zugeordnet werden soll.</p>
      <p>Direkt nach dem Feld Gerät/Schirm steht ein optionales Feld "Typ" — erscheint nur bei Inhalt, sonst nur ein dezenter "+ Typ"-Link zum erstmaligen Eintragen. Wird auch beim CSV-Import erkannt (Spalten "Typ", "Type", "Schirmtyp", "Kategorie").</p>
      <p>Im Mehrfachauswahl-Modus lässt sich die Spaltenauswahl/-reihenfolge für "📋 Kopieren" über das ⚙️-Zahnrad daneben frei konfigurieren (an-/abwählen, per ↑/↓ neu anordnen) — praktisch, um die kopierte Tabelle an eine externe Tabellenkalkulation anzupassen.</p>
      <h3>3.6 Flugdetail: Karte &amp; Höhenprofil</h3>
      <p>Karte (MapTiler, Geländestil mit deutscher Beschriftung) zeigt den Track in kräftigem Dunkelblau (nicht höhen-/steigenkodiert); Vollbild per Antippen mit echtem Pinch-/Doppeltipp-Zoom, Link zu GPS Visualizer. Der Referenzpunkt (bei aktivem Profil-Zoom) ist ein stilisierter Gleitschirm, der sich in die tatsächliche Flugrichtung dreht. Cine-Wiedergabe (▶-Button, auch schon in der kleinen Vorschau, nicht nur im Vollbild) spielt den Flug mit wählbarer Geschwindigkeit (1×–100×) ab — der Gleitschirm-Marker folgt der Strecke und dreht sich live mit; im Vollbild steht zusätzlich die aktuelle Höhe (rot) direkt neben dem Marker. Bei aktivem Profil-Zoom springen Karte und Höhenprofil während der Wiedergabe automatisch mit, sobald der Marker den sichtbaren Bereich verlässt. ↺ springt zurück zum Start. Höhenprofil zeigt Höhe über Distanz höhenfarbig (rot=tief, blau=hoch) mit braunem Bodenprofil (echte Geländedaten, 80 Stützpunkte), proportional auf die eingetragene Distanz skaliert.</p>
      <ul>
        <li>🔍 Zoom-Button — Listenauswahl 1× bis 8×</li>
        <li>Bei Zoom: im Profil wischen, um den Ausschnitt zu verschieben</li>
        <li>Karte zoomt dabei synchron mit, roter Referenzpunkt an der Fenster-Mitte</li>
        <li>Gestrichelte Linie im Profil markiert diese Mitte — zeigt zusätzlich Höhe (Y-Achse) und Flugdauer/Distanz (unter der X-Achse) an genau diesem Punkt, in Rot. Beim Wählen eines Zoom-Levels springt die Markierung auf Flugstart (0:00)</li>
      </ul>
      <h3>3.7 Weltkarte</h3>
      <p>Start-/Landeplätze (grün/rot) auf einer MapTiler-Geländekarte (deutsche Beschriftung), einzeln ein-/ausblendbar, mit echtem Pinch-/Doppeltipp-Zoom. Bei aktiver Auswahl (☑-Modus) zeigt sie nur diese Flüge. Suche nutzt denselben erweiterbaren Zeilen-Baukasten wie die Flugliste (siehe 3.2) — mehrere Bedingungen, UND/ODER.</p>
    </>),
  },
  {
    id: "statistik", title: "4. Statistik",
    body: () => (<>
      <p>Sechs farbige Badges (ab 768px Breite nebeneinander statt untereinander):</p>
      <ul>
        <li>🪂 Schirm (blau) — Flüge, Flugzeit, Distanz, Bewertungen je Fluggerät</li>
        <li>🛫 Startplätze (grün)</li>
        <li>🛬 Landeplätze (orange)</li>
        <li>👤 Passagiere (violett) — erster/letzter Flug je Person, Bewertungen. Blendet sich aus, wenn kein Flug im ganzen Flugbuch einen Passagier hat.</li>
        <li>🥾 Hike (hellgelb) — gruppiert nach Ort (aus dem Hike-Startpunkt bestimmt), mit Höhenmeter, Hike-Dauer, erster/letzter Flug. Blendet sich aus, wenn kein Flug eine Hike-GPX-Route hat.</li>
        <li>📅 Saison (rot) — Jahresauswahl (Alle/aktuell/-1/-2/Mehr) mit Kennzahlen (Flüge, Flugzeit, Flugtage, Ø/Flug) und persönlichen Rekorden</li>
      </ul>
    </>),
  },
  {
    id: "reisen", title: "5. Reisen",
    body: () => (<p>Fasst Flüge zu Reisen zusammen. Reisen erstellen/verwalten über „Reisen verwalten&quot;. Jede Reisekarte zeigt Titel, Zeitraum, Schirm, alle zugehörigen Flüge mit Distanz/Dauer sowie Gesamtkennzahlen (Flüge, Flugzeit, Ø Zeit/Flug, Nummernbereich).</p>),
  },
  {
    id: "ausruestung", title: "6. Ausrüstung",
    body: () => (<>
      <p>Zwei Tabs oben, im Design analog Wartungs eigenem Reserve/Schirm/Sitz-Umschalter: <b>⚖️ Ausrüstung, Gewichte</b> und <b>🛠️ Wartung</b> — jeweils nur einer aktiv.</p>
      <h4>⚖️ Ausrüstung, Gewichte</h4>
      <p>Erfasst das Material in 8 festen, farblich unterschiedenen Kategorien: 🪂 Schirm, 💺 Sitz, 🛟 Reserve, 🎒 Packhilfen, 📟 Geräte, 🧥 Kleidung, 🧰 Zubehör, ⚖️ Körpergewicht. Innerhalb jeder Kategorie werden Positionen frei hinzugefügt ("+ Position") — Bezeichnung und Gewicht (kg) beide direkt editierbar, Gewicht wird manuell erfasst (kein automatischer Online-Abgleich).</p>
      <p>Mehrere <b>Setups</b> (z.B. "Tandem", "Solo", "H&F leicht") sind frei anlegbar ("+ Setup") und umbenennbar (auf ein bereits aktives Setup nochmals tippen). Jedes Setup wählt per Checkbox unabhängig aus, welche Positionen mitzählen — nur ein Setup ist jeweils sichtbar, per Umschalter oben wechselbar. Pro Setup werden Gesamtgewicht (Summe der ausgewählten Positionen), eine optionale Gewichtslimite und die daraus berechnete Reserve (grün wenn im Limit, rot wenn überschritten) angezeigt.</p>
      <h4>🛠️ Wartung</h4>
      <p>Verwaltet Ausrüstung in drei Kapiteln: 🪂 Reserve (3 Positionen), ⛰️ Schirm (4 Positionen), 💺 Sitz (5 Positionen). Für jede Position: Name, Serien-Nummer, Zulassung (bei Schirm/Sitz), Kaufdatum, Check-Intervall (Monate) und eine Liste vergangener Checks mit Datum und Notiz. Das nächste fällige Check-Datum wird automatisch angezeigt (grün/gelb/rot je nach Dringlichkeit).</p>
      <p>Die Titel der einzelnen Positionen sind direkt editierbar: auf einen bereits ausgewählten (hervorgehobenen) Titel nochmals tippen öffnet ein Eingabefeld zum Umbenennen. Ohne eigene Eingabe erscheinen generische Platzhalter ("Reserve 1", "Schirm 1" usw.). Ab 768px Breite sind alle Positionen einer Kategorie gleichzeitig als feste Spalten sichtbar, statt einzeln per Tab.</p>
    </>),
  },
  {
    id: "backup", title: "7. Datensicherung",
    body: () => (<>
      <p>Über den 💾-Button im Flugbuch oder die Einstellungen kann der komplette Datenbestand (Flüge, Wartung, Ausrüstungsgewichte, Reisen, Notizen) als Datei exportiert und auf einem anderen Gerät oder nach einem Neustart wieder eingespielt werden. Regelmässige Backups werden empfohlen.</p>
      <p>Der Export wird automatisch gzip-komprimiert (Dateiendung <code>.json.gz</code>) — deutlich kleiner als reines JSON. Der Import erkennt sowohl komprimierte als auch ältere, unkomprimierte <code>.json</code>-Backups automatisch, unabhängig vom Dateinamen.</p>
      <p>Ein roter Punkt am 💾-Button zeigt an, dass es seit dem letzten Backup ungesicherte Änderungen an Flügen oder Feld-Definitionen gibt. Er verschwindet nach einem erfolgreichen Export oder Import. Änderungen, die ausschliesslich in Wartung, Ausrüstungsgewichten, Reisen oder Notizen gemacht werden, lösen den Hinweis nicht aus.</p>
    </>),
  },
];

// Condensed quick-reference content — same information as the PDF short
// version used to contain, now rendered in-app instead so Settings' short
// manual doesn't need its own file in the repo either.
function KurzContent() {
  return (
    <div className="hilfe-body">
      <h3>Einstellungen</h3>
      <p>🪂 Schirme: 9 Kartenmarker-Varianten — "Eigenes Symbol" (Buchstabe/Emoji eintippbar), fixes 🪂-Emoji, 7 Schirm-Fotos; app-weit, sofort wirksam.</p>
      <h3>Flugbuch</h3>
      <ul>
        <li>Suche: <code>feld:wert</code>, <code>feld=wert</code>, <code>feld&gt;wert</code>, <code>+wort</code> (muss), <code>-wort</code> (darf nicht)</li>
        <li>📥 Import (IGC/CSV) · ☁️ Backup (gzip, roter Punkt = ungesichert) · ☑ Auswahl · 🗺️ Weltkarte · 🔍 Suchen/Sortieren ein-/ausblenden</li>
        <li>CSV-Import erkennt Kopfzeilen und ordnet Spalten flexibel zu, unabhängig von Reihenfolge/Sprache</li>
        <li>IGC-Import füllt Zeiten, Ort, Schirm, Höhen automatisch (Steigen/Sinken über 30s-Fenster) — Distanz bleibt manuell (XContest-Wert), XContest-Button neben IGC-Badge; bei fehlendem Dateiname-Treffer zusätzlich Datumsabgleich, bei mehreren Kandidaten Nachfrage</li>
        <li>Feld "Typ" nach Schirm (nur bei Inhalt sichtbar), 📋 Kopieren mit konfigurierbarer Spaltenauswahl (⚙️)</li>
        <li>Suchen/Sortieren-Panel: Suchen · Sortieren (⇅, alle Datenfelder) · Reihenfolge (↑↓)</li>
        <li>Zwei unabhängige Gruppierungs-Ebenen Gr. 1°/Gr. 2° (Jahr/Schirm/Typ/Startplatz/Landeplatz/Reise/Hike-Ort/Bewertung, je "Keine" wählbar) — Gr. 1° standardmässig Jahr, Gr. 2° standardmässig aus. Gruppen-Reihenfolge frei nach jedem Datenfeld wählbar (⇅, plus "Name"/"Anzahl"; additive Felder summiert, Punkt-/Ortswerte kleinster/frühester Wert, Text alphabetisch), gleiches Feld nochmals antippen kehrt Richtung um; je eigenes Alle-ein-/ausklappen</li>
        <li>💡 Gespeicherte Darstellungen (zwischen Suchen und Sortieren): kompletter Suchen/Sortieren/Gruppieren-Zustand unter einem Namen sicherbar und per Tippen sofort wieder anwendbar; Speichern als… / Verschieben / Löschen</li>
        <li>Hike-GPX-Import (🥾, per Datum/Flugnummer/Auswahl zugeordnet), grün auf Karte + eigenes grünes Hike-Höhenprofil, kombinierte Wiedergabe (Hike→Pause→Flug), rotes GPX-Badge in Flugliste, Export "⬇ Hike" im Flugdetail, Löschen über konsolidierte 🗑-Kachel (IGC/GPX Hike/Alles); "🥾 Hike-Daten"-Kachel (Startpunkt/Ort aus GPX-Routenname vorbefüllt & frei editierbar/Starthöhe automatisch aus Koordinaten/Höhenmeter berechnet/Dauer/Zusatz mit editierbarem Titel) über den Flugdaten; Statistik: hellgelbe "🥾 Hike"-Kachel, gruppiert nach Ort</li>
        <li>Kacheln im Flugdetail: antippen zum Umkonfigurieren</li>
        <li>Cine-Wiedergabe (▶, Vorschau + Vollbild): 1×-100×, Gleitschirm dreht sich mit; Vollbild zeigt zusätzlich rote Höhenangabe daneben; Karte/Profil springen bei Zoom automatisch mit</li>
        <li>Höhenprofil: 🔍-Button für Zoom 1-8×, springt auf Flugstart; bei Zoom im Profil wischen zum Verschieben, Karte zoomt synchron mit; Flugdauer/Distanz + Höhe an der Mittellinie</li>
      </ul>
      <h3>Statistik</h3>
      <p>6 Badges (blendet sich einzeln aus, wenn nicht zutreffend): Schirm · Startplätze · Landeplätze · Passagiere · Hike (gruppiert nach Ort) · Saison (Jahresübersicht + Rekorde)</p>
      <h3>Reisen</h3>
      <p>Flüge zu Reisen zusammenfassen, automatische Zuordnung nach Datum möglich</p>
      <h3>Ausrüstung</h3>
      <p>Zwei Tabs: <b>⚖️ Gewichte</b> — 8 farblich unterschiedene Kategorien (Schirm/Sitz/Reserve/Packhilfen/Geräte/Kleidung/Zubehör/Körpergewicht), Positionen frei hinzufügbar (Name+kg, manuell erfasst), mehrere Setups (z.B. Tandem/Solo) je mit eigener Positions-Auswahl, nur eins gleichzeitig sichtbar, Gesamtgewicht/Limite/Reserve. <b>🛠️ Wartung</b> — 3 Kapitel: Reserve (3) · Schirm (4) · Sitz (5) — Titel direkt editierbar (nochmal auf aktiven Titel tippen), Check-Intervall, nächstes fälliges Datum automatisch angezeigt</p>
      <h3>Weltkarte</h3>
      <p>MapTiler-Geländekarte, deutsche Beschriftung, echtes Pinch-Zoom. Suche wie Flugliste (Zeilen-Baukasten, UND/ODER)</p>
      <h3>Offline</h3>
      <p>Ab dem zweiten Online-Start funktioniert die App komplett offline (Service Worker). Gelbes Banner zeigt an, wenn offline. Nur neue Kartenkacheln/Höhenprofil-Bodendaten/Zeitzonen-Bestimmung brauchen weiterhin Verbindung.</p>
      <h3>iPad/Desktop</h3>
      <p>Ab ca. 768px Breite: Home mit Foto+Kacheln nebeneinander, Flugbuch mit Liste+Detail nebeneinander, Statistik-Badges nebeneinander, Wartung-Unterkacheln alle gleichzeitig als feste Spalten. iPhone bleibt unverändert.</p>
    </div>
  );
}

function HilfeApp() {
  const [openId, setOpenId] = useState(null);
  const [mode, setMode] = useState(() => new URLSearchParams(location.search).get("kurz") ? "kurz" : "lang");

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

      {/* Ausführlich / Kurz toggle */}
      <div style={{display:"flex",gap:8,padding:"14px 16px 0"}}>
        <button onClick={()=>setMode("lang")}
          style={{flex:1,background:mode==="lang"?"rgba(224,48,74,0.2)":"rgba(255,255,255,0.05)",border:`1px solid ${mode==="lang"?"rgba(224,48,74,0.5)":"rgba(255,255,255,0.1)"}`,borderRadius:10,padding:"9px",color:mode==="lang"?"#f87171":"rgba(232,244,253,0.6)",fontSize:13,fontWeight:700,cursor:"pointer"}}>
          Ausführlich
        </button>
        <button onClick={()=>setMode("kurz")}
          style={{flex:1,background:mode==="kurz"?"rgba(224,48,74,0.2)":"rgba(255,255,255,0.05)",border:`1px solid ${mode==="kurz"?"rgba(224,48,74,0.5)":"rgba(255,255,255,0.1)"}`,borderRadius:10,padding:"9px",color:mode==="kurz"?"#f87171":"rgba(232,244,253,0.6)",fontSize:13,fontWeight:700,cursor:"pointer"}}>
          Kurzfassung
        </button>
      </div>

      {mode === "kurz" ? (
        <div style={{padding:"16px 16px 0"}}><KurzContent /></div>
      ) : (<>
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
      </>)}

      <div style={{textAlign:"center",padding:"24px 16px 8px",fontSize:10,color:"rgba(232,244,253,0.25)"}}>
        meinflugbuch — Hilfe
      </div>
    </div>
  );
}
