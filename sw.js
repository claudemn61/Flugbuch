// ── Service Worker ────────────────────────────────────────────
// Strategie: "Network-first, Cache-Fallback".
// - Online: jede Anfrage geht zuerst ins Netz (garantiert immer die
//   neueste Version, kein "veraltete Version sichtbar"-Problem), die
//   Antwort wird nebenbei im Cache abgelegt.
// - Offline: schlägt die Netzanfrage fehl, wird die zuletzt erfolgreich
//   geladene Version aus dem Cache ausgeliefert.
// Damit ist die App ab dem zweiten (erfolgreichen) Online-Start auch ohne
// Verbindung nutzbar — inkl. der von CDN geladenen React/ReactDOM/Babel/
// tz-lookup-Bibliotheken, die beim Vorab-Cache (install) mit heruntergeladen
// werden.
//
// CACHE_VERSION bei strukturellen Änderungen (neue/entfernte Dateien)
// erhöhen, damit alte, nicht mehr benötigte Cache-Einträge aufgeräumt
// werden. Für normale Inhalts-Updates ist das NICHT nötig — die sind
// dank "Network-first" ohnehin sofort aktuell, sobald wieder Netz da ist.
const CACHE_VERSION = "v1";
const CACHE_NAME = `flugbuch-cache-${CACHE_VERSION}`;

const PRECACHE_URLS = [
  "index.html", "app.jsx",
  "flugbuch.html", "flugbuch.jsx",
  "statistik.html", "statistik.jsx",
  "reisen.html", "reisen.jsx",
  "wartung.html", "wartung.jsx",
  "hilfe.html", "hilfe.jsx",
  "apple-touch-icon.png",
  "apple-touch-icon-120.png",
  "apple-touch-icon-152.png",
  "apple-touch-icon-167.png",
  "https://cdn.jsdelivr.net/npm/react@18/umd/react.production.min.js",
  "https://cdn.jsdelivr.net/npm/react-dom@18/umd/react-dom.production.min.js",
  "https://cdn.jsdelivr.net/npm/@babel/standalone@7/babel.min.js",
  "https://cdn.jsdelivr.net/npm/tz-lookup@6.1.25/tz.js",
];

self.addEventListener("install", (event) => {
  event.waitUntil(
    caches.open(CACHE_NAME)
      .then((cache) => Promise.all(
        PRECACHE_URLS.map((url) =>
          fetch(url, { mode: url.startsWith("http") ? "cors" : "same-origin" })
            .then((res) => { if (res && res.ok) return cache.put(url, res); })
            .catch(() => {}) // einzelne fehlgeschlagene Datei blockiert den Rest nicht
        )
      ))
      .then(() => self.skipWaiting())
  );
});

self.addEventListener("activate", (event) => {
  event.waitUntil(
    caches.keys()
      .then((keys) => Promise.all(keys.filter((k) => k !== CACHE_NAME).map((k) => caches.delete(k))))
      .then(() => self.clients.claim())
  );
});

self.addEventListener("fetch", (event) => {
  const req = event.request;
  if (req.method !== "GET") return;
  const url = new URL(req.url);
  if (url.protocol !== "http:" && url.protocol !== "https:") return;

  // Für eigene Dateien (HTML/JSX) den Browser- UND jeden zwischengeschalteten
  // CDN-Cache (z.B. von GitHub Pages) umgehen, damit "network-first"
  // wirklich "frisch vom Server" bedeutet. Für die von CDN geladenen
  // Bibliotheken (React/Babel/tz-lookup, ändern sich nie) ist normales
  // Caching dagegen sinnvoll und schneller.
  const isOwnFile = url.origin === self.location.origin;
  const fetchOptions = isOwnFile ? { cache: "no-store" } : undefined;

  event.respondWith(
    fetch(req, fetchOptions).then((response) => {
      if (response && response.ok) {
        const clone = response.clone();
        caches.open(CACHE_NAME).then((cache) => cache.put(req, clone));
      }
      return response;
    }).catch(() => caches.match(req).then((cached) => cached || Response.error()))
  );
});
