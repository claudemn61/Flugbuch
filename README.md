# Flugbuch – Als eigene Web-App veröffentlichen

Diese 3 Dateien (`index.html`, `app.jsx`, `storage-shim.js`) sind alles was du brauchst.
Keine Installation, kein Build-Schritt – React und Babel werden direkt im Browser
über CDN geladen. Deine Flugdaten werden lokal auf deinem Gerät gespeichert
(`localStorage`), nicht auf einem Server.

## Variante A: GitHub Pages (kostenlos, empfohlen)

1. Gehe auf [github.com](https://github.com) und erstelle einen kostenlosen Account
   (falls noch keiner vorhanden).
2. Erstelle ein neues **Repository** (z.B. Name `flugbuch`), öffentlich, ohne README.
3. Lade die 3 Dateien (`index.html`, `app.jsx`, `storage-shim.js`) über
   **"Add file" → "Upload files"** direkt im Browser hoch.
4. Gehe zu **Settings → Pages** im Repository.
5. Unter "Source" wähle **Branch: main**, Ordner **/ (root)** → Save.
6. Nach ca. 1 Minute ist die App erreichbar unter:
   `https://DEINNAME.github.io/flugbuch/`

## Auf dem iPhone/iPad installieren

1. Öffne die URL in **Safari** (wichtig: nicht Chrome, "Zum Home-Bildschirm"
   funktioniert nur zuverlässig in Safari).
2. Tippe auf das **Teilen-Symbol** (Quadrat mit Pfeil nach oben).
3. Wähle **"Zum Home-Bildschirm"**.
4. Fertig – die App hat jetzt ein eigenes Icon und startet im Vollbild ohne
   Browser-Leiste.

## Wichtig zu wissen

- **Deine Daten bleiben auf dem Gerät.** Jedes Gerät (iPhone, iPad, Laptop) hat
  seinen eigenen `localStorage` – die Flüge synchronisieren sich NICHT automatisch
  zwischen Geräten. Wenn du auf mehreren Geräten arbeiten willst, exportiere/importiere
  über die eingebaute CSV/PDF-Funktion.
- **Browser-Daten löschen** (z.B. "Safari-Verlauf und Website-Daten löschen")
  löscht auch deine gespeicherten Flüge. Mach gelegentlich ein Backup indem du
  die App-Daten exportierst.
- Die App funktioniert **offline**, sobald sie einmal geladen wurde (React/Babel
  werden vom Browser zwischengespeichert).

## Variante B: Andere Hosting-Optionen

Falls du kein GitHub möchtest, funktionieren diese 3 Dateien auf jedem
statischen Webhosting genauso (Netlify Drop, eigener Webspace via FTP, etc.) –
einfach die Dateien in denselben Ordner hochladen.
