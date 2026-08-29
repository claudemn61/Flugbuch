# Flugbuch — Projektkontext für Claude Code

Persönliches Paragliding-Flugbuch als PWA von claudemn61 (Pilot, XContest-Username
claudemn61, Standort Knonau ZH). Läuft live unter claudemn61.github.io/Flugbuch/.

## Sprache & Stil

- **Alle Code-Kommentare, Commit-Messages und Antworten an mich: Deutsch, Schweizer
  Rechtschreibung** (z.B. "ss" statt "ß").
- Kurze, direkte Antworten bevorzugt. Ich melde mich meist mit kurzen Korrekturen
  ("Missverständnis: ...") statt langen Erklärungen — dann bitte den vorherigen
  Schritt korrigieren, nicht neu diskutieren.

## Tech-Stack

- **Kein Build-Schritt**: React/JSX wird zur Laufzeit im Browser per Babel Standalone
  transformiert (siehe `<script type="text/babel">` in den `.html`-Dateien).
- Jede "Seite" ist ein eigenständiges HTML+JSX-Paar, kein Router, keine Bundler.
- Deployment: GitHub Pages via GitHub Actions, automatisch bei Push auf `main`.
- Persistenz: `window.storage` (IndexedDB mit localStorage-Fallback), async API
  (`get`/`set`/`list`). Keys mit Präfix `service:` werden automatisch vom Backup-
  Export/Import in `flugbuch.jsx` erfasst — neue dauerhafte Einstellungen also mit
  diesem Präfix anlegen, sonst gehen sie bei einem Reset verloren.

## Dateien

| Datei | Zweck |
|---|---|
| `index.html` / `app.jsx` | Home-Seite, Kacheln zu den Unterseiten |
| `flugbuch.jsx` / `flugbuch.html` | Flugliste, Flug-Details, Import/Export, Suche |
| `statistik.jsx` / `statistik.html` | Statistik-Kacheln (Schirm/Startplätze/Landeplätze/Passagiere/Hike/Saison) |
| `ausruestung.jsx` / `ausruestung.html` | Wartung + Ausrüstungsgewichte |
| `reisen.jsx` / `reisen.html` | Reisen-Übersicht |
| `hilfe.jsx` | In-App-Hilfe (Voll- und Kurzfassung) |

## Versionierung

- **Patch** = Bugfix, **Minor** = neues Feature, **Major** = Architekturänderung.
- **Vor jeder Code-Änderung fragen**, welche Stufe zutrifft (ausser ich sage explizit
  "nichts" / "keine Version").
- Bei **Minor**: `hilfe.jsx` (Voll- **und** Kurzfassung) im selben Zug aktualisieren.
- Versionsnummer + Changelog-Eintrag stehen in `app.jsx` (`APP_VERSION`-Konstante
  und das Array direkt darunter, neuester Eintrag zuoberst).

## Vorgehen bei Änderungen

- Nach jeder Änderung: **Klammern/Syntax wirklich prüfen**, nicht nur vermuten.
  Eine simple Brace/Paren-Zählung ist ein guter erster Check, ersetzt aber keine
  echte Kompilierung — im Zweifel mit einem echten JSX-Transformer (z.B. `sucrase`)
  verifizieren, bevor etwas ausgeliefert wird. Schon mehrfach hat eine naive Prüfung
  einen Fehler übersehen (z.B. abgeschnittene Funktions-Extraktion).
- Bei Datenverarbeitung (Statistik, Aggregationen, Timeline): wenn möglich mit
  **echten Daten** aus einem Backup-Export testen, nicht nur mit erfundenen
  Beispieldaten — reale Daten (z.B. `f.year` als String statt Zahl) haben schon
  mehrfach Bugs aufgedeckt, die mit Testdaten nicht sichtbar waren.
- **Konsistenz über Seiten hinweg** ist mir wichtig — wenn ich "identisch auch für
  die Varianten X/Y/Z" sage, meine ich das wörtlich: gleiche Struktur, gleiche
  Optik, nicht nur sinngemäss ähnlich.
- Bei mehrdeutigen Anfragen lieber kurz nachfragen (max. 1–2 gezielte Fragen) als
  eine aufwändige Änderung in die falsche Richtung zu bauen.

## Bekannte Stolperfallen (aus bisherigen Bugfixes)

- **`position: sticky` + `border-collapse: collapse`** funktioniert in Safari bei
  Tabellenzellen unzuverlässig — stattdessen `border-collapse: separate` +
  `border-spacing: 0` verwenden.
- **`box-sizing: border-box`** nicht vergessen, wenn eine feste `width` mit
  `padding` kombiniert wird und an anderer Stelle ein `left`-Offset exakt darauf
  aufbaut (sonst leichte Verschiebung zwischen fixierten Spalten).
- **`ResizeObserver`**: `entry.contentRect.height` liefert nur die Innenhöhe ohne
  Padding/Rahmen — für die volle sichtbare Höhe `element.getBoundingClientRect()`
  verwenden.
- Werte, die während des Renderns über einen gemeinsamen, mutierenden Zähler
  (`let i = 0; i++`) verteilt werden, können bei mehrfachen Re-Renders inkonsistent
  werden — stattdessen eine stabile, deterministische Zuordnung (z.B. nach Name
  sortierter Index) verwenden.
- iOS/Safari kann die PWA jederzeit unerwartet beenden (Speicherdruck) — Zustand,
  der über einen Neustart hinweg erhalten bleiben soll, gehört in `localStorage`
  bzw. `window.storage`, nicht nur in React-State.

## Nicht tun

- Keine neuen Abhängigkeiten/Build-Tools einführen — bewusst kein Build-Schritt.
- Keine automatischen "smarten" Sortierungen einbauen, wenn nicht explizit
  gewünscht — lieber eine neutrale Standardeinstellung (z.B. alphabetisch) und die
  Wahl dem Nutzer überlassen.
