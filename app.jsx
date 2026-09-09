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
  let total = 0, biplace = 0, hikeFlights = 0, found = false;
  const startSites = new Set(), endSites = new Set(), gliders = new Set(), reisen = new Set();

  function tally(f) {
    total++;
    if (f?.customFields?.passagier && String(f.customFields.passagier).trim()) biplace++;
    if (f?.hikeTrack?.length > 1) hikeFlights++;
    if (f?.site) startSites.add(f.site);
    if (f?.customFields?.landung) endSites.add(f.customFields.landung);
    if (f?.glider) gliders.add(f.glider);
    if (f?.customFields?.reise) reisen.add(f.customFields.reise);
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

  return { total, biplace, hikeFlights, startSites: startSites.size, endSites: endSites.size, gliders: gliders.size, reisen: reisen.size };
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
  const gurtzeuge = await readKV("service:gurtzeuge");

  const candidates = [];
  if (reserves) {
    Object.keys(reserves).forEach(id => {
      const slot = reserves[id];
      const lastCheck = (slot.checks && slot.checks.length ? parseDateStr(slot.checks[0].date) : null) || parseDateStr(slot.purchaseDate);
      const nextDue = lastCheck ? addMonthsToDate(lastCheck, slot.intervalMonths||12) : null;
      if (nextDue) candidates.push({ name: slot.title || RESERVE_LABELS[id] || slot.name || id, nextDue, days: daysUntilDate(nextDue), kind: "reserve" });
    });
  }
  if (schirme) {
    Object.keys(schirme).forEach(id => {
      const slot = schirme[id];
      if (!slot.title && (!slot.category || slot.category === "–")) return;
      const lastCheck = (slot.checks && slot.checks.length ? parseDateStr(slot.checks[0].date) : null) || parseDateStr(slot.purchaseDate);
      const nextDue = lastCheck ? addMonthsToDate(lastCheck, slot.intervalMonths||12) : null;
      if (nextDue) candidates.push({ name: slot.title || slot.name || slot.category, nextDue, days: daysUntilDate(nextDue), kind: "schirm" });
    });
  }
  if (gurtzeuge) {
    Object.keys(gurtzeuge).forEach(id => {
      const slot = gurtzeuge[id];
      const lastCheck = (slot.checks && slot.checks.length ? parseDateStr(slot.checks[0].date) : null) || parseDateStr(slot.purchaseDate);
      const nextDue = lastCheck ? addMonthsToDate(lastCheck, slot.intervalMonths||12) : null;
      if (nextDue) candidates.push({ name: slot.title || slot.name || id, nextDue, days: daysUntilDate(nextDue), kind: "gurtzeug" });
    });
  }

  const KIND_LABELS = { reserve: "Reserve", schirm: "Schirm", gurtzeug: "Gurtzeug" };
  const overdue = candidates
    .filter(c => c.days < 0)
    .map(c => ({ ...c, categoryLabel: KIND_LABELS[c.kind] }))
    .sort((a,b) => a.days - b.days); // most overdue first

  // Next upcoming (not yet overdue) Reserve packing date — separate from
  // the overdue list, always shown so a Reserve check due soon doesn't
  // stay invisible until the day it's already overdue.
  const upcomingReserve = candidates
    .filter(c => c.kind === "reserve" && c.days >= 0)
    .sort((a,b) => a.days - b.days)[0] || null;
  let nextReserve = null;
  if (upcomingReserve) {
    const now = new Date();
    const dueInSameMonth = upcomingReserve.nextDue.getFullYear()===now.getFullYear() && upcomingReserve.nextDue.getMonth()===now.getMonth();
    nextReserve = { ...upcomingReserve, categoryLabel: "Reserve", color: dueInSameMonth ? "#fcd34d" : "#4ade80" };
  }

  return { overdue, nextReserve };
}

const GERMAN_MONTH_NAMES = ["Januar","Februar","März","April","Mai","Juni","Juli","August","September","Oktober","November","Dezember"];
function fmtMonthYear(date) {
  if (!date) return "";
  const d = new Date(date);
  return `${GERMAN_MONTH_NAMES[d.getMonth()]} ${d.getFullYear()}`;
}

// Single source of truth for the version number shown next to the title.
// Selectable glider marker variants — colour/pattern options the person
// photographed and cropped themselves (see Settings > Schirme). Background
// removal: erode the white mask slightly first (border_value=1, treating
// "beyond the image edge" as background too) to break thin bridges between
// the true background and enclosed white design elements near notches in
// the silhouette, then dilate the border-touching regions back out — this
// keeps chevron patterns etc. opaque while still clearing the real
// background. Chosen variant is persisted ("gliderVariant" storage key)
// and used everywhere the glider marker/reference-point icon appears.
const GLIDER_VARIANTS = [
    { id: "custom", label: "Eigenes Symbol", type: "text", char: "" },
    { id: "parachute", label: "Schirm-Emoji", type: "text", char: "🪂" },
{ id: "v3", label: "Gelb", type: "image", dataUrl: "data:image/png;base64,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" },
{ id: "v10", label: "Weiss/Grün/Blau", type: "image", dataUrl: "data:image/png;base64,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" }
];
// Früher aktive Schirm-Icons, aktuell nicht auswaehlbar (aus der Einstellungen-
// Auswahl entfernt, aber fuer eine spätere Wiederverwendung aufbewahrt statt
// geloescht).
const GLIDER_VARIANTS_RESERVE = [
{ id: "v1", label: "Dunkelblau", type: "image", dataUrl: "data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAKAAAABdCAYAAAAiw23qAAABWGlDQ1BJQ0MgUHJvZmlsZQAAeJx9kLFLw1AQxr9WpaB1EB0cHDKJQ5SSCro4tBVEcQhVweqUviapkMSQpEjBzX+g4H+ggrObxaGODg6C6CS6OTkpuGh53ksiqYje47gf3/vuOA5Ij1vM9vsB2E7glZeK0mZlS8o8I0UvDI35bkFVVwV/15/xfh95b6fFrN///8ZgTfcZ1U/KHHO9AEjJxOpe4AreJx7zaCnilmAz4hPB1YjPQ896uUR8TSyxulYjfiGWqz262cO21WDxDmL7rO5srIk5lBNYxA58uLCgoQkJKvJ/+GdDfwm75G7Coz4TdQTUUyBFTNCJl+GAYQYysYIcpSLuHN/vLr6fnGgHT8BCh3N+kWgrHeBsjk7WTrSpeWBkCLhqu5qnhVIfZdowgNdTYLgCjN5Qz7Zv5JVo+2wRGHjk/G0SyBwC3RbnH0ecd4+p+QG4dL4AC1tiFx89eYkAACeGSURBVHja7X15lB1Xeefv++6tt/XrVreWtiXLQrYsEJJlzBLbkEDbECADieNJaBMCh8SEJTGTSYYJCZkhaWtiCCcZQgiMM0zOEEKYSSIRkpglDCSxFEzYjA0EKbZs2ZZla7PUknp5S1Xd75s/7q336r1+vWmDzLx7Tp/T9Wq7det3f996vwL6bTmNAPCGDRtGjDHfACBEJKVS6S4iAgDTH6J+u5CNiQhRFH0SgAJIAaREpJVK5c3hmD4I++2CNAMAg4ODP0pECiAJIHQAxBhz6qqrrloTWJL6w9Vv5539VJWiKPoKAAnsp+EvAaCVSuU3wrG2P1z9dt7Zb+XKldcxc8Z6mvvLWPCxsbGxUp8F++18NwsApVLpg3nG6wYhEenQ0NAr+rpgv51vy5fe+ta3RsaYh3OM1w3ABIAUCoU/7Ivhfjuvuh8ArF69+nnMLEH/014MCECNMQ9NTEzYvhjut/Mqfsvl8n9YQPxmf8LMbmRk5Oo8ePttkdndbws2JSIkSfLiJRzrVJWbzeYN/fHtA/B86X/uNa95TUFVr13KmKkq0jS9oT90/XY+9b/NzLyQ6M3+UgAaRdF9ITTX1wH7DHjODIhGo7FVVW0wNBYdTxHZdNlll60MoOyDsA/AcwNgmqbbVBUBUIsdr6o6PD09fUX+Gv3WB+BZNxF59nIOD3rg5v4Y9wF4rs0REZxzVy6DzVRV4Zzb3B++PgDPVfzqK1/5yiKA9csVpyKyqT+EfQCes/63d+/eVaq6ehkApECDG4IlLP2h7APwrNvU1NSoqlaWYdFSYMC1IkIBgH1DpA/AsxobUtVLMt1uOcwJYNXmzZsH+8O4cPvXmLFBADAxMdFilX379hEAHD++dRGm2d36b8/oqGLX1gCqHfOBS+M4Hg0uGFnOhBWRoZMnZ4cBTIfzFJjwO8f30djx47m+3jjvdUZHtymwCwCwdavv7x133KFBvC9nYnz/vszveR9UMXHHHeSBNI7jx/dSHjQeLLvkQg92dlMiwMkEA3dgxYoVvzo7W/ttBVIorDdNOk8ISh8AAjFBxYGIsHb10NVPHju1Vy/GGI6Pswf1jR7PuzMA79MMuDt2tCaa/v8EQJqYmKB9+/ZRnqH2jO5bNqgMMz79mc8Uv/a1h4tTSTo43awVGtIcmp6pDRRtoZLAjNQbtSKUCpZpVTOWIkNLylSG0oBIWk4FBKiJjF1BjLJLUutA1rMUGVUwQQwxWxAVarMzo2mzMQxiVShlvSXy/6oqCAQOkTciQJwHYGVw6CFiPkNQYWNTZkqJKBWRaSjNEEjBKtaaGVKdEedqhlWsLU47hzORjeJCierN1J0sRpQUCgMzxvJMtVSNV6+hqfEbR+PnXPPa2Mly8TTB4+Pt95Gx7NatWzWAVP81ArALaLuxZ88eWcgKJACf/dznil964IGhydNueCpOVrs4vaQWp6uT2K0FdERVVqcqI+KwSomGRGQQoiUQDTpRS0QRCCAmgAxEvc7fIioFNEdZHjCAhuP88QCBoSAIEkDZ986jCUwKj1FAJfWDxiZs++gcGQKD4JyAiMFMCD5Ef3XDYGK4wI7MBgSCC/1hYzrAy8wgKER87qtlAxFB6tI4MjZloilR12TmKeZo2pCehuqkMeaUMTgBNieKLCesLR+PCubUYKUyue05pVNvH3/7bFhUteC7HB8f5wygN94I2XHHHYrFz7uoAKSJiQnavXs3BxHZM056zz33lD6/+2ujT882L5uZSZ7h0uYzUqXLm6lcHqfxulR0DUSH0zStOrBRMKwxICaICLz+pRBRCCSE/RUqAhCgfvarEil5uAXIcQa5lk1B1AaeRxcACdvM/mdJQWBSJhAIKo4Cgvz5Lg2XMyDisK0AWxgCRBxUvSgmIpGMnojAxkCdg6iCDSuxgUv9+cQMDttKnu0ZTC5NoABZawlElKYpmBlRFEFV4URgTQRjLVwAbxRZqCpEUlhmkCicSxtRITpVsPY0VI5ZEx0pFe1TBD1oLJ4arJSfXFMtHn7PLa98mq6+Op7vnY+NTZgWKM8DWy4XgDQ+Ps67du0CugLzqkq3v/vO9ccnZ58dJ+nWRtzcSmKfFTvZONOojaqgpMpIReBE4ASwpDCWkSQpBooRVlTLytbKmelZTRIHDSRESqSqII8JqCKfbEIAQTxcgMBoSsYfFBhKyQPQb7MHHPy2AiA2IGhgNA/IAEA/xmRAzFCXhJHIttv7jSGIc5DQcWMY4hwgChgGGwNJU8/CzDAmAK57GwAzwzAjzbaNgWFGkiQKAMZaEEHTOAGzURNZOOfUOQdrDZgN0jghJlAURexEUKvVYQoRAIY4RaEQwRgDIkHEBEOoRcYcLxSip9jQY+XI7o+YHyyX6KHrNq87+La3ve1ML81obGyMbrzxRtmxY4dcEABOTEzwjh07GD7dKAOcef3rX7/94MHHfjAtrb6+unrD82PBRhhTSVXByqg1G4jjJp65YS1WDFU1TWJ59lVX6KqRITQaDXrmxssxumYVTc/O0soVK/CsKy+nL371W9jx+x+FOA3oo+yGbd0r/3/Yp8TBGJDwQg2UPMNRNwCVEZS2HGAZTORFngLE3BLBeQCKSxEQAhO2NRzPhiGpg6hXCYzxABXxz2KshTjn2ZvZb6cpVMQD0FoPQBGQMX5/kkACQK21cGHbGOMnb5xAQbDWqwhJksAYgyiKkCaJn63MWDk8oL/4hh9HuVjUBw8c0mMnJ3WwWsGhIyfw6BOHqVwq8kytTsdOnkaxVEbiHEgJq1YModGsIbLmWGTMw8ba+8tU+2b98CPfvPvuu/cTUZJ3XY2Pj9OuZej2tATgtbz59913X+XOO+/8oWPHjt0yOzt7U702syVauQGD67dAYSCSwo8eSaMZY9OG1fQrb/ppeu62Z1G5VCJRaQ1Ur7b3sUP4+Xf9DmZqDRgTgMamJXY9gsiDRhVg9k8p4tmOuSWeMwCpSOslKJEXuWG7ez+IAqN5QFHYVnhAI2O8cHzGgBmDdTNcS+SG/pko8gwZRGXHdgbI/HYUQdLUbxvTBqAI2FoYY5AmcdAALJgZSbMJYkZUKECcQ5qmiIoFpEmCW15+A37j9p/tcjQ5zMzWYS1jampWDx09rjayevjpU/qpz/0jvrnvAFWqVeNcglKpBKeKUmQwc+RxTU8efCQy9JWRNWu+8MxNm3Z/4AMfeCrPjBMTE7oYK9ICvzNCMP4tb3nL9v3797/x1KlTP1mr165wqWB25gyq667C8BXPTS0T4rjJkbWkqtRMEqwfXYmPvPedWH/pJWg2m/6lEMGJdLoxFDCGcHq2jje+83049NTTGBwoI0mSoGoZaDeonAuGQA8AirQAMAdgeQAZkznsWsdTFwNSOF9Vlg9AInCO8bJtFVkQgOoEzqUgJtjIg8ilKRD0PpcDZBRFSOMYIgITeXEaN5sgItgoAlSRxDFMFKFQKOCpo0fx73/mFrzjZ2/F7GwNYIbNmFy9ocPWBO3Kj88ffPxT+NhffQFFa9QaIw6qTkHFYsnUjh/CzMFvwzChVCpPDQwM7Fm5cuWuW2655dO33XbbaQAYHx83CzHinLWr4+PjZt++fQJAX/e6111XrVY/+PDDD//eyZMnXzwzMzMSN2NJ4tjZygqMbrmeiMCiwlCQsZZSEUBS/M6v/Ty2bt6EmZlZGMOZ0gYmAgfx5H9TlEplvOeuP8O9X/s2RoaHkGagIfLAUW9bMOf8wNm+IIIpiGvNbzODcuKaKCiQAbzBKmkxXvc25bfD+ZkVjWCpahDxWX809DXfd+2x3TJKsv1hsgHqLW0isLGtyed1StPB8MaYlqHW2g46ozEGIGqD2xiUigV8/VsPYvuWTdi8cT3SNIUBBTeFQlSQpimSRJCmCVQVL3re1Thw6Cnse/gJKhQKzMZymqRsmJVKVTWRdU8/8YiqojwzM/2sWq32b++///43btu2be3NN9984KMf/ehkDle6IAADWt0HP/jBNfV6/Q8OHDjw4cnJyW31et2ISOqcg40ibtZqPPKMq6kwPOoV7AAuawymZmbx6pdch9tu/THU63VEUW+R69lG/aB89xG8/4/+AgOVUstnQ0HEdoAm3IdyICJVkCqU2QO0B8BaYMwA1Y4itMDQAdAA5hbggtHc3qY5gMtAmwcoZQydMaLJXDfSAmDLEg9WMEDB1UNgEwUPgDex2FpAwzYxrI08Q+cA6YIKwcaAMzdQDrxJkuLgk0fwI2M3IDIcDDDqmGR+uDwrMhG2bt6I//OP30C9EaNQiDxwjSFxQsXqMNdPH+e0Pq0KSBzHWq/XV9Tr9RcdPnz457Zv3776TW960wMf+tCHZsbGxuzBgwelZyx4bGzM7tq1y73hDW94+Sc+8YlvHjp06OempqbIOefUa/1WRFjFAaUKqmvWQdIEzARVATMB5JXyV41dvyQLKDMWdn1+N+IkbtkFlDM+erFQiwEzUOb/79Yvun7TjCXz1+qcGT3+pzkgnXNO/i/LXMj61SV/8s/X3WHf5zB5oG03EvXqJqGdcEOdz6QABcOMQCBiiCjK5RK+e+Ag/vEb30ahWGz5QTv6lnP8N+IY6y9Zgxdfdw2mZ2bRFjoKJoXCYnDNZWg0ZoiYTJqmRlW1Vqulk5OT1SeffPIdn/70p79+6623/uSePXvSLMbeAcCxsTG7Z8+e9DWvec2bv/Od73zhyJEjlzebzZSISFWNiFA2IEIGa7b8AKKBQahLPfBUYY3BmalZ3PzSF+GFP/AcNBqNTpHZ1ZwTVCpl3PvAPuz+6rcwMFCGE+2tlNISvUV6/h3484I0B7QlWXrzHT/n+jrnoM6oLy18p44x6IR/xuDGRPirL34JzaQJY3jR5xcR/PhLb8BAOULqBEyAiIKZkCYJhtZdheLwpZDUG0gASESsqmq9Xk9PnDix8eGHH/7kq171qvcaY1qOWAAw4+Pj5nOf+5wbHx9/64MPPvg/JicnJRTgMZn15jttkcRNrNiwBSvWbgaceIoOinWaOlx2yQh+9z/9AqqVgZZTNP8CM51PFLCRxdOnp/HL7/kwpmdqMMRt4yEDU2YIqAZRkdvXMdu1rRNqK1bmdbTcdrcLp7tv2fEadFUi8i6Qec5n5iAeEUQot3W67Hp5EZzbn/VvjkgOIpZbIlrhXKcOKOK8G8dYqLgggUynH9EYMBNc6vVJYy1UBc45VCplPHroMFQEL3reNUiSJCd+22pGNj7OCTasuxQminDv/d9FIYqgKrDGIE1TFEplROUhxGeOIG3G3lp3DsxM8FXFpNFouGazObZ9+/YNTzzxxN+IiAEA3rVrl3vjG9/4kv3799916tQpZ7xeMmdaqAjUFlAdfQZUNIiyAGRixHGMt4y/CqOrVqERLLGFZmlkLT70ib/CY088hYFysePFLsYsLfd7TsTlmUa7jp3DMjnxrj2ujS4RqfPdv23IL8ja2oNRO1ixqx95yd+zvwuSIHV0TIMgz0sIEUF1oIr/ufPzuH/vfpSKxYy5euelMSGJY7zhx1+Ga7dsQqOewJAPFYIASWMUhlZhcO1VSNOkQ8UKRhITkZ2amoqPHj36ple84hXvB+DGxsYM33fffZVHHnnkI6dOnTLGW2XcmqWtASMoHIwtwBaqUHUtDmUiNJMUG9eP4mU/9HzvCF1A9IoISsUiHnjwEXz27+7FimoVzum8IFlokFuA69apuvW+HuKUuo6nJdxvPj2RluhYnW9y0ZKjAks8krqekeZOBMOEZurwh//rr5GKLKguAYATQSkq4LWvfimcpGGiZ+FOgoqitGIUZKht6Xfp+8xcmJ6eTo4ePfqO1772tT+xZ8+elN/73vf+yqlTp7Zkzp9O+g0qbFC8o+oI2HrLrOVWYUKSOGy6fB2GBoeQBspfONWT8cnPfwn1RuIjFqAFgaLz7DsbHa4Fgnn0xYWuT/MAVbvB32sC9AAxZeHD1ghwK3qtRPDJN9QyaLJR0A6Ucc56ae9rX7lLE8yJ1YFKCV//5/342rf2olAozGHB/BgRMVya4gVXb8boyhEkLm1JQAVDFTCmCFA0Z4Jk1/GqnDFnzpzRQ4cO/e5dd901wkePHr29VqspEXHHC1AFNIVKAhc3oLaEVVdcDUPSyn1rM7vgBdu3LC46FbDWYHJ6Gvf987+gXGw/9Nm8+IticJxD1sZS+qxdxKbdd1vEsFpoIrXLc1FP9icQUqf4h6/e31Md6Sb91DmMDFYwunoQSeKQM7ih4hBVV6C6ai2ca7YIrPPdEVSERUSmp6ev/MxnPvM2npycvISyo0W8JeMchAy4PITC8KUYWLsJa7Zcj3J1GFAHDulGhhn1ZoprNm/ELa98yeLiVx2iqIBPfeFeHDl6AoWC7ZpltCBrnU9wLeWa3W6f8wG4OQzfcplQK3+Meqhz804IXXyKtDllrlgsl8v4yrcfwtGnT6IQWR+3nqe/IgprLH7i1S/1vdTsfXkjSUBYecXVMOVhOCdwaYw0ieHSOCR1CNQbX1yv1/X06dNvt2maqoiQiCAqD6IysgbFoTUolodhCyWQNZAwleJ6A2Is4jSFgBGnKZqNBn765ltRrVRQbzTA87wEVUWxUMAjTx3DH+/6LErlUpZKteDLOxfwLRVkejbum2X0a9F+UD5nMeQ6dItr6o1AbblYcr7VnAWvPVSazLWiqigVIhw6chIf+fO7MfGLtyFNm/P2nQ0jSRL86Euux91f/DL2PvQ4yuUimAjWeKFfrI7gsmtfhsbsKaTNGuLaNOLZM3D1KbhmDZAEHEXkcwdkvVUVKq64BENrr4KpDiMlA5c41F0CajRC2IxQLhZRLZVQKZegcBioVBA3Y2y5Yj1e8eIfQBw3YbrcEPkX65VQg49+8rM4cXIKa1atRDOO/RAuAIDufYsxWf6+iwHrbMCtZ8uwpJm63qWZeT2PWpCjnIJPGcnkxKiiu+5RW1+fI3Pm+AO7dWARweBABX/9d1/GLa94Ma555iY0mk0Ypp7+SOcEpVIRP/Xqm/CO+z+MJE3BBCSp87Fql8LaArg0jKiyGuU1BgwFXIy0NoXaycOYnXwSLp5FnCZqB9ZtAY+sgxqDoWoZ60dX4fJ1o1g3uhqXrhrByPAghgYqGKhUUC4WUChGMAxEkQURoViMoA5IU/HrIcKDcc6fJKIoRBaPPHkE/3DvfahWynAhvNQzOrIEQ2EprEVdvrtzYrwLkEqe17u87UIL2TI5lZDa+9tuzi51MRdGzIw8bd+n5eUI76rWSPBnf/P3uOadm0J4ce7Eo5CnGMdN3HT9Nfhvd7wdk2emkTpFrVZHnKQ4MzWNmVodp6dncWamhqnpGqZm66glQFqoorj+2RhYtxmzRx6CNk+TrVyyAT947bPx6huvxzVbn4VVI8PnXblXcSA22PP17+DM1AwGq9XgjF06cM7qvj3OV70wyx20y/Uwh7lbFiN1AGI+p8xS+qmt5QYE7XIG9YoY9mRtIjhxGChX8E/f2ocjT5/AutHVqDeaLXXKgzRYsUwQZURMeNmLrlvg6oI4TTBba+D0mRkcPTGJRx4/hL0PH8R3HzmEVLegkpyGfd9/fAvGbngeAMWTxyZx/75HMHlmGtOzdTSaCRpxDBVBkiSwkUWSJCgWS0iSGIPVKhrNBoYGq3AuRaVYQrlURJKmWDk81MpTLpVKeOBf9mPnZ/4elcqATyNnuyz3x3mxZC+gJd3N2tRTaaN8oAZEvUR61/mq86ucPcRzPk6c8VZ3BKe7nyIKYxjT9Qb+4vNfws//1I+hXCzBifgkW+cQJw7GRqjHDRAIAkUS18GGkCQpjLFIXQprDBSKyPqE2sHBIYwMrcAVl1+GFz53OwCg3mjgk1/4Ev7yc/fAXnLppbjjQ3+C7zx4AJOnp1BvJN7IcD5VPQvHZZkRWdhIRMGG4VKHqFBAHMcoFiM4EWgIejebTRSs9XHi6RlUq4OwxiDJ1kHM5xheriW5yLlz/IqL6JXLPX9pzN0Rk+hgsXzMpH1ut9M6M0S05ZejvNGBrvtSHmRzNdhOVce/50qpgo9/6ovY/ZUHcMWGy3BmasrrdaI4fWYaAwNVTM/M+BxOy6jV6qiUy6jVaigUIjSTBKViEc45FCMDNhbFYhHlYoTqQBmrR4axds0Itl61EW+4+eV4wdWbYW9/93/FydMzKBUtjGHYyCCKTMv57OOz5NdwGL/qi5nhnIMxBkmS+ps3LWxk4ARQJ37RjACR9YMzWK3CWNMz5NOLNXrpbr329QLPUgHVy1haLiCX5uLJ2Eh6Gw0dx2tuk8MKPdfTJTh3W3s8X1sfVO01cX2WTDZ5CpHFY08dw5PHTqIZxyBiFAsR4jhGoVBoXSeyFkmaoBhNewPEWiSSwLKBE4UJKwAVBFKfa6jBf2ytwYa1a3D7629Ry9ZgeMiH1yQATuBz7lqdVu8DSkFIU4fIkjc6iJE6gRGBEwWLQMFwIjDh4UMIxu/vMjB6sVgvX9VS9p21EXCOOuHSr0E5ICry6/XmmjX5580ZEtS2ZInm+k5V0e3R7mDOvKHTOa6S8/UJysUiisWiJyRrYZjARCgVSz5tLviAiYBCyPcsFCyQApExQUoaFBABpGDi0P22X/XQkadx15/+JfHw4BCSkP3abUW11sbOm+CTWWI+NUdFW44GtFwh7UHIxPm5gGAhC/n8Oqwp9/KWH4mY12VIi1vSbebquoYuoUQroQOg/hVyBwPOJ3G63TPiBKqAC8sOsuQCgJA6CcEFCZEQ37lsCYRC/J8onApEBM75zB4R0XKlhHK5eISt5VY4aL662ln60DxpHyEyF/TEvNneMSvngm4+xb07HagX682372K2swoR6lInAc2ZDAvppUTo0B9V53isu87TDqadTy3hXJa4du0nYvhMMe68Rg4rik5XURbOZjDWrFx1jOuNpnKHThIqB3REJbuU28ytkO8MyC/IzumO+c5zl9IyH1jOldkW18+WymI658V3X0tVFwF9/ngGiDsiHp3IWMi1oz0RrC29Kq9ndk3ksEtyYjbTxbJs9k5JxC1AZZPAn8stpSELGxIDCukgFPFrVANYO9GjQZ8jAqkqJk+dvoRVpV3FQnsMDnVZTggl79iDtHXzrgVDGQNKbtZID/ZaLAS3VIfz4iyo3wP3DC2QeZD9Ri0vYU83zLyPQfMc220tZ6v55zPgutdbawcAvWRDG1wtQCtMIBgOki4jMsqRl1cJtAMXqqLGGExNn3mCi5aPRYUCQf0SzA4XfE7qctD1KJTDyKPes13Xy9f53Sy9wnQX2k/Xygu5KKWq2o7n+cVmp3tmPsu25QombZUVmevu6Z6s1FpJmMk9hc45r0PU5rLHsxImRKGunMIbEq136i16CmlYGSBbVcK0S4q2EmO9z0mJFMTCpCf58tHVrxseKE3bqGCUkILmI0DN6XWZTzAvgtsj13oY6tQh8yJrOfHfpTLiQlbxRdcPl3CEdvn50NMfuPS8iPzyA22R69xxy/+fd4vlVwhCehgvoh2s2cIIkItZ55+uczr68k8qAKNaKvCKcvGz/IGJX7rnyksHf3jVYHn/QLlqyUPOMZEycUdyaptgqaWUEuWTIMPMAQJdU9tZ2oMZ9SzcMssVz3OAeE4su7RzFXNLgvUsF63zh9iI8hzSFtK6qB7dHvMWOKA9x7o7/S2TZIRMZ+z0doiKz38NBgggudJPnQmvmgvjEQFMUBClbCIeHiibEet+449//7fu4vHxneYDO9719R+97srr1wzYPxwsF7VYLBkQkZKmgEp+wUoejKLtfLbMis7rg3mv13yrwi5E7t/Zxonnd58oFitIujxjh+Zxz2gPS7UTmT1zBTOwzvHtta3Y+ca2WxxT7lrM7YX43uDwolha7hxp65ukLR9ly3wj8sADUoCpXK7YFaXo8NpqYfxjH37PnfqbE8y7dt3qJiYm+Lbbbjv9vz/8W7dv2zh6w0i1uKtSKsalctWyiVgVotAUmZHTchGGrIwsC6brITr0jEVYbylZMOfm11v+dVWXx3zL61fXYqWu++RBSDmJ0xFJCWoOYS74W0ZEzprOO5u7V8DlrWPkSKPTtdPObuLQn1YxgNx6axCUiJwSnLKhQqliK6VCc6RMd1171fDzP/L+3/zk+PhOgx07xAKALyCjND5+K79/4p3fAHDrL7/7fdsOnay9oYb0NUlkr0qVOE4SqHP+48yqxEQhuMGteikiCpvz/3HXMr9zjV4sJRqxHOf2+UrPWqoTcPF76fySX7XrWosz+lK8DK3loartolDh3bWCB9rlgjHsF6ex8aE8ZhFVMUQEssYWIhMZAwN3uFrEn1++ZvCPfm/Hf34QAMbHd5pdu251QEeRctJdu+AmJiZ4x7599Pt3vmsvgF9/7J57dtx59+4bT842b6kZ98OJ400Ca9M0AamDqHNEpCJChg2ncJQFy7OSEZKmHQ/NufW++f97OZu7E1yXA+ALAfbzrAf0ZL98ulaWstVyafXwVbbdLrpgQkQvT4Rffp1LJGbuzKoWQVgtGUQqZelZ6hRCIBWoscZygS1HhkCanC4XsHvFAO964eb1f3v77bef8sAbNzt37hQiatWWnFO4JSunNTExwbt3g6+46aYGgM8D+Pw99/xx6WOffeL5U2eaP1KP3csapM9RjioOBknS9Mp36ssTEUCiShSmVy8Q9UoCWOyYuQN4YUT3csXufNb9/A536ljUs9B9qUdcrjPxhTtCqR643lAgYl9tKweoFkGor7qbl0wdrNe+v4qKEpOICBQwYEvGWFOIIsDFiBgHS5HsqRQKf3vF2oE97333u48AwJ8Gxtu6da/u2LHDdT/LvMX6AhAFoSoqANx0020NAF8G8GUm/Ma/+9X3bTg2O339bKP5gw2iFyYO26JyaUA5YuLUL3BSQEFOVJRApGGFSSj7MQeYZxMDvhhiVZWWGIajjjBXuy89oiqU1/G4g+3yYOk0ErJFl9RKRvVl6EJRIqa58fyWnUqtxAN/P2nrl97ZF+wXUWJWUQ2xB181qRBFbA2hIE1YlsMR8zcHiumXBouVe2952fpv33zz22qtW09M8Pi+bbRr57jsyjHeuU3zXPHqPXt2uPzkZQJ+6dfvvOzw5NQ1tRg3NNL4umYi26F0mcAXh3ShXl3QC50Tp9YaqCiJCAeqpzztS1g03S74jY6yZL32aauCVLt8Rl7XyV5sXvfJtlvlzshXqxJJ29uGQxHOkI+Xuy+H0hxpUDeYDYgMnIvDtvW1VELlAGOsT3NL4lB2IwIAJEkMZl/5ygfwEzD74pRpmgaRaGGNRRzXAWJEUQEivhiltRbGWMRxE8QG1lg4l0DEZ6yIcz4h2BZUJVURURtFmvq6h2yjAosqrI1gTSjSDokJOFAq8AOVIn11oFT4xou3rdj75jf/2nQeHOPj4wYYx86d40JLLGh+TgrSxMQE79u3jY4f3zsHkADw8Y9/fGDPfQc2Tdaa2xtp/ILUyfZGkj5LRNexLXAqfmb6wYuzgpAiqpIBS1zmBSLKCt90AjBbUSodTvD59Mj8djcgO+rthUr2vuh4BkiGqAtlfUPtlRwAuwFJZHMANEEcZgCMAAYkB0CfeeLrtLQB6IuSG2uQJikUCsM21OppgNjAGAuRtKWvMRskcRNsIrXGaJLECma1xiD1JYbZ2og1FEfPilkyBAwXk+KgsfbBUqTfqtrovpHh4nfv+u07Hici6QIAj+0Gj47u011n+R2X86qhe0D6zzTs2QMB5pZnvfvuuyt//aWvXz49U7+qXtdnN5N0uxO6KnayUSBriE0kwWdOaKXvIKuTp54qpVU3j/xXOlQc+driJhPttBgg8+Gn/HY7WM+tgH8bkB4EBG4l5mYiMr/tAZjpXwCFoukuVNk3xms/4pJQqMhXnMj0NQ8qgYjrBqAatmAiTZMEZIyysSouhagHIIE4dSmbXPV8G0r6QpxfKiGaEMtxw/RYFPF+JrO3XOC9lwyXH77rt298guimtPvdjY+Pm+PHt5IH3E45H4HNC20ihk85+GSY+UBJAP7k4x8fuGffgUtq040NtVp9UzOlK1NxG0Ww3jlclkJHIVoFW8rKUWj4fIOvuKXtSlVtfbIVlFDosoIgvSxoApGqmLxellfYmVhdUMYoFEXP+9yAsECLGCADQNqqAhmfGq8BgOG7IH4pBBMzkRMhIiIKbCrqYI0Fs/UukVB9llSy2o3TlnESoMPW0BPW2kcj4NFKwR5YOVJ64t9cse7ozW/L6W2daDNjx7fS6Og2DQbEBfmAzffCR9HrgzZuoYdTvcf+wq/sXllvxitrTVxSi+vrU9F1Im5UlS51zl3qgJWqGBaRFQIeUEIJCC82K7BE5+JcVvSqhdUJ1EzJ53bhpKDo58uYUKgo5svxamf1VbSd/D4B1dfjg2SSQFJjeBaiU8bQlFGcYGOPq3FPF4w5FLE5YgwdqZaiwysH8PRbn/vcU9tvvTVeADk0NjZmgBtbn/W6mF9L+n5yks35pFfQLXqFVuc0JsB94yPRr3/yseqJ2eJATRojtcZsmbS4ppmmQ0p2RSOJq1kmb4/ILLjnbwynKRtiOfHUoy88dfzIT1D+w4Xt7HpiE01ecfULfoeYnQ/P50WUQMCte3A7G6D9zZKwJ1yYCsVCag2dZIPpEuwJw5gdqJjTIyuKU9s3YubNP/dfGkv8TFf4llx7XL8Xn+X6fgfgIqkj7Q8adn4Vczf27LlRwhcvL/Rg3gTgH5AvI+9btv1lAD90cYdmgv3XN9tj0gKY/7wW8H38Rc3/1z6kTIBiYuIOApbzGdeF29NP7+M1a7bKgw/+9y1PnzjxbRXtrsCUArCFQvSJG971rtse/9huu3Hjjen5eqj8xwQB4F8DsPrtAkzUK6+8cgUzn8gZNxnrJgC0VCq9ezEHf7/NVXv6bWkWCB5//PEzzPwkekTQvOvE7O8PVR+AF6pl1WMf7WHDmADAR3uBs9/6ADwvYjg4q/f38s8Q0cyqVasOzWNg91u/nXOzAFCpVN6U1/uCBazGmId27txp+sPUbxdMBANAtVp9SQi0Z87zFIBaa78QHNJ9qdIXwRfOEBkYGHiCiGK01+EoADDzwyH81x/TPgAvHAC3bNlylIiO5X/rW8D9dtEMkQC2e3PiNyUiHRwcfFVeVPdbnwEviB4YPrZyIMeAhog0iqLH8qzYb30AXrhBY34o/Ju5W06uXLnyqT4A++1iWcLjwRJuwrtgHqD5atv1W58Bz7chYox5NO9yYeZH++PZB+BFA2CIeExnjJhzwfQZsN8uAgpV2RjzIAAlIq1UKreFXf0smD4DXgwbhIWZH8/9cKBvgPQBeNHGLGTFPAwARFSrVqsH+wDsA/DimsNeBIOIjl177bVH+wDst4uGPQAYGhp6eXBA7+m7YPoMeNEt4WKx+FhYSvl4sID7Ibg+AC8eADds2HCYiJKcD7Df+u2iNfL1W+wjpVLpZ8JvfRdMnwEvriVsrd1rjOmn4Z9D68/acxk8a/8JwOG+BXyOFl2/LV8EA9C1a9e6YrH4xNTUVL1vBZ9d+7/MCKKxuKc1YQAAAABJRU5ErkJggg==" },
{ id: "v2", label: "Türkis", type: "image", dataUrl: "data:image/png;base64,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" },
{ id: "v8", label: "Orange/Blau", type: "image", dataUrl: "data:image/png;base64,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" }
];
const DEFAULT_GLIDER_VARIANT = "v3";

const APP_VERSION = "6.0";

// Chronological changelog, newest first, matching what's actually been
// built and shipped in this app over the course of development. Kept here
// so the in-app "Log Files" folder can show it without needing any backend.
const VERSION_LOG = [
  { v: "6.0", note: "Graph-Badge (Statistik) fertig ausgebaut: öffnet jetzt formatfüllend über der ganzen Seite statt als Kachel, die Zeichenfläche misst ihre Breite laufend und nutzt beim Drehen ins Querformat den ganzen Bildschirm. Zwei Modi — \"Gruppiert\" (Balken je X-Wert; X/Y frei wählbar aus allen Flugdatenfeldern inkl. Flugnummer; bei Namensfeldern wie Reise/Schirm wahlweise alphabetisch oder nach dem angezeigten Y-Wert sortierbar) und \"Frei\" (ein Punkt pro Flug, X/Y teilen sich dieselbe Feldliste) — beide mit echtem Bereichs-Zoom per Pinch, Verschieben per Finger (X und Y mit je eigener Scrollrichtung), Achsen-Umkehr, und einer optionalen gestrichelten Trendlinie (lineare Regression, nur wo statistisch sinnvoll, ausblendbar). Bezug-Zeile führt direkt zur entsprechend gefilterten Flugliste und wieder zurück." },
  { v: "5.9", note: "Statistik: neues Badge \"📈 Graph\" — zeigt die gerade in der Flugliste aktive Gruppierung (Gr. 1°) und Filterung als Balkendiagramm; X-/Y-Achse danach im Badge selbst frei wählbar, bei gesetzter Gr. 2° zusätzlich ein \"Aufschlüsseln nach…\"-Dropdown zum Einschränken auf einen einzelnen Gr.-2°-Wert. Erste Ausbaustufe — weitere Darstellungen und Pinch-Zoom folgen. Ausserdem (statistik.jsx): derselbe Fix wie in 5.8.3 für mehrere Suchbegriffe ohne UND/&& sowie Klammern ohne Leerzeichen, und \"Monat\" auch hier als reguläres Suchfeld." },
  { v: "5.8.3", note: "Suche: \"Monat\" ist jetzt regulär als Feld wählbar (auch mit \"zwischen\"-Option, z.B. für Flüge in der ersten Jahreshälfte über alle Jahre). Fix: mehrere Suchbegriffe ohne UND/&& dazwischen (z.B. \"monat>=1 monat<=6\") wurden bisher stillschweigend auf den ersten Begriff reduziert statt kombiniert; ebenso wurden Klammern ohne Leerzeichen (z.B. \"(a)\") beim Zerlegen der Suchanfrage falsch behandelt." },
  { v: "5.8.2", note: "Flugdetail: der \"XContest\"-Button führt jetzt direkt zum passenden Flug (statt nur zur eigenen \"Meine Flüge\"-Übersicht) — Datum und Startzeit werden dafür automatisch in das von XContest erwartete Format bzw. in UTC umgerechnet (Zeitzone anhand Startkoordinate + Datum bestimmt, wie beim IGC-Import). Ohne Startkoordinate oder Startzeit bleibt der Link wie bisher auf der allgemeinen Übersicht." },
  { v: "5.8.1", note: "Flugliste, Suchen/Sortieren/Gruppieren-Panel: Gr. 1°/2° ~15% schmaler, Suchfeld dafür verbreitert — beide jetzt exakt gleich breit, ebenso die kleinen \"Gruppen sortieren nach…\"-Felder von Gr. 1° und Gr. 2° untereinander (vorher je nach gewähltem Feld unterschiedlich breit). Flugdetail: die \"☰ Sortieren\"-Kachel über den Flugdaten zeigt jetzt nur noch das Symbol, ohne Text." },
  { v: "5.8", note: "Flugliste: die Statistik-Kachel unter der Flug-Anzahl (Zeitraum/Gesamtzeit/Ges.Distanz/Ø Dauer/Ø Distanz/max. Dauer/max. km/max. Höhe/Startplätze/Schirme) ist jetzt über ⚙️ konfigurierbar — einzelne Werte aus-/einblendbar und per ↑/↓ neu anordenbar, wie bei den Kopieren-Spalten." },
  { v: "5.7.20", note: "Fix Gruppierung nach Bewertung: bei manchen Flügen war die Bewertung als Text statt als Zahl gespeichert (vermutlich Altlast einer sehr frühen App-Version) — dadurch behandelte die Gruppierung z.B. 4 Sterne als Zahl und 4 Sterne als Text als zwei verschiedene, gleich beschriftete Gruppen, was in der Flugliste wie eine mittendrin unterbrochene Gruppe aussah. Bewertung wird jetzt überall konsequent als Zahl behandelt, einmalige Nachkorrektur beim nächsten App-Start bereinigt bestehende Flüge." },
  { v: "5.7.19", note: "Fix: Datum eines Flugs bearbeiten (einzeln oder in der Massenbearbeitung) liess Jahr/Monat für die Jahr-/Monat-Gruppierung unverändert — ein auf ein anderes Jahr umdatierter Flug blieb dadurch dauerhaft in der alten Jahresgruppe hängen, obwohl das Datum selbst korrekt angezeigt wurde. Jahr/Monat werden jetzt bei jeder Datum-Änderung neu abgeleitet. Einmalige Nachkorrektur beim nächsten App-Start gleicht bereits betroffene Flüge rückwirkend an." },
  { v: "5.7.18", note: "Fix: der Zeilen-Baukasten der Suche übernahm eine über Suchen/Sortieren-Panel geladene gespeicherte Darstellung, einen freien Text-Edit im Suchfeld oder ✕ Löschen nicht — bearbeitete man danach eine Baukasten-Zeile, wurde der gerade erst gesetzte Filter durch den alten, im Baukasten noch hinterlegten Stand überschrieben. Baukasten gleicht sich jetzt bei jeder externen Änderung des Suchtexts korrekt ab." },
  { v: "5.7.17", note: "Flugliste: vor der Distanz-Anzeige (egal ob als Haupt- oder Nebenwert, je nach Sortierung) erscheint jetzt bei bekannter Routenart ein kleines Symbol — ▲ für ein Dreieck (grün bei FAI, sonst wie die Distanz-Anzeige eingefärbt), ▬ für eine Freie Strecke." },
  { v: "5.7.16", note: "Fix Dreieck-Route auf der Karte: zeichnete bisher einen künstlichen 4. Punkt ein (nächster späterer Trackpunkt zu Turnpoint 1), der bei manchen Flügen eine viel zu weit offen wirkende, irreführende Form ergab, obwohl die berechnete FAI-/Flach-Einstufung selbst stimmte. Zeigt jetzt das echte, geschlossene 3-Punkte-Dreieck (Turnpoint 1-2-3, Schliessung direkt zurück zu Turnpoint 1) — wie auf XContest selbst. Einmalige Nachkorrektur beim nächsten App-Start aktualisiert bestehende Flüge entsprechend." },
  { v: "5.7.15", note: "Beim Setzen der Routenart zieht jetzt auch die auf der Karte gezeichnete Route (nicht nur Distanz) automatisch mit — bleibt weiterhin über die Kartenansicht editierbar. Einmalige Nachkorrektur beim nächsten App-Start gleicht das bei allen bestehenden Flügen mit einer der drei automatisch vergebenen Routenarten entsprechend an." },
  { v: "5.7.14", note: "Distanz passt sich beim Setzen der Routenart (Freie Strecke/Flaches Dreieck/FAI-Dreieck) automatisch an die dazu berechnete Streckenlänge an, bleibt danach aber ganz normal frei überschreibbar. Einmalige Nachkorrektur beim nächsten App-Start gleicht Distanz bei allen bestehenden Flügen mit einer der drei Routenarten entsprechend an." },
  { v: "5.7.13", note: "Fix: die Nachkorrektur-Migration (5.7.11/12) blockierte bei vielen Flügen mit GPS-Track den Hauptthread so lange, dass die App beim Start einfror. Läuft jetzt erst nach dem ersten Render, Flug für Flug mit kurzer Pause dazwischen — die Liste erscheint sofort und aktualisiert sich währenddessen laufend." },
  { v: "5.7.12", note: "Kritischer Fix: die Nachkorrektur-Migration (5.7.11) konnte bei Flügen mit >400 Track-Punkten abstürzen (Index-Fehler durch Fliesskomma-Rundung) und liess dadurch die ganze Flugliste leer erscheinen — Skalierung korrigiert und Migration pro Flug abgesichert, damit ein einzelner Track nie mehr das Laden aller Flüge verhindern kann." },
  { v: "5.7.11", note: "Einmalige Nachkorrektur beim nächsten App-Start: Routenart und eingezeichnete Route bestehender Flüge mit GPS-Track werden mit dem korrigierten Dreieck-Algorithmus neu bestimmt — nur bei Flügen, deren Routenart noch automatisch vergeben ist (nicht von Hand geändert)." },
  { v: "5.7.10", note: "Fix Flaches/FAI-Dreieck-Berechnung (Nachbesserung): Die Schliessungs-Prüfung lässt laut XContest auch Turnpoint 1 selbst leicht verschieben (nächstes Punktpaar zwischen dem ganzen bisherigen Track und dem Track ab Turnpoint 3, nicht nur die Distanz zu Turnpoint 1 selbst). Am realen 8.77-km-FAI-Flug jetzt praktisch exakt: 8.77 km / 12.27 statt 12.28 Punkte." },
  { v: "5.7.9", note: "Fix Flaches/FAI-Dreieck-Berechnung: Grundlegend falsches Modell korrigiert (XContest-Dreiecke haben 3 Turnpoints, nicht 4 — die Schliessungs-Lücke ist der Abstand, den der geflogene Track später zum ersten Turnpoint wieder erreicht, kein separat gewählter 4. Punkt). An einem realen 8.77-km-FAI-Flug verifiziert: statt vorher 1.16 km jetzt 8.33 km (~5% Näherung)." },
  { v: "5.7.8", note: "Flugdetail: unter Distanz werden jetzt (bei vorhandenem GPS-Track) zusätzlich das grösstmögliche Flache Dreieck und das grösstmögliche FAI-Dreieck gemäss XContest-Vorgaben berechnet und mit ihren XContest-Punkten angezeigt." },
  { v: "5.7.7", note: "Flugdetail: GPS-Visualizer-Link und die ASL/m/s-Filter zu einer gemeinsamen Kachel zusammengefasst und ans rechte Ende der Reihe verschoben, die Zoom-Kachel rückt dadurch nach links vor." },
  { v: "5.7.6", note: "Flugdetail: Startzeit, Startplatz und Start müM sind jetzt grün eingefärbt, Landezeit, Landeplatz und Landung müM rot — wie schon bei den Start-/Landung-Koordinaten-Kacheln, zur besseren Übersicht in der Flugdaten-Liste." },
  { v: "5.7.5", note: "Fix: Antippen eines Eintrags in Statistik (Schirm/Start-/Landeplatz/Passagier/Hike-Ort) filterte die Flugliste auf \"enthält\" statt \"exakt\" — z.B. zog \"Fiesch\" auch alle \"Fiescheralp\"-Flüge mit rein." },
  { v: "5.7.4", note: "Fix (eigentliche Ursache des Marker/Linie-Versatzes): die Routen-Punkte hatten ein inline position:relative statt position:absolute im Marker-Element — das überschrieb MapLibres eigene Positionierungs-Regel, wodurch der Marker statt exakt auf der Kartenkoordinate an seiner Position im Dokumentfluss landete (Versatz wuchs mit jedem weiteren Punkt). Gleicher Fix auch beim Flug-Positionsmarker (Gleitschirm-/Wanderschuh-Symbol) während der Wiedergabe angewendet." },
  { v: "5.7.3", note: "Fix: Routen-Linie auf der Karte konnte an den Wendepunkten sichtbar von der gelben Nummern-Markierung abweichen (schlimmer bei kleinem Zoom, besser aber nie ganz deckungsgleich bei starkem Zoom) — Ursache war eine interne Vereinfachung/Rundung der Linie durch die Kartenbibliothek, die bei nur 2-5 exakten Punkten unnötig ist und jetzt abgeschaltet ist." },
  { v: "5.7.2", note: "IGC-Import schlägt jetzt auch Startplatz und Landung vor: liegt der Start-/Landepunkt innerhalb 5km eines bereits bekannten, benannten Platzes aus einem anderen Flug, wird dessen Name übernommen (nur wenn das Feld leer ist) — bei einem komplett neuen Ort bleibt es leer statt zu raten." },
  { v: "5.7.1", note: "Kartenbearbeitung der Route (5.7): Punkte lassen sich jetzt auch hinzufügen (\"+ Punkt\"-Knopf im Vollbild, dann Karte antippen) und löschen (×-Symbol am Punkt) — nötig, um eine offene freie Strecke in ein tatsächlich geschlossenes Dreieck umzuwandeln oder umgekehrt. Ausserdem: Linie folgt beim Ziehen jetzt zuverlässig auch bei mehreren Änderungen hintereinander (vorher konnte eine zweite Korrektur die erste überschreiben)." },
  { v: "5.7", note: "Kartenansicht im Flugdetail zeigt jetzt die automatisch erkannte Route (freie Strecke/Dreieck) als gestrichelte gelbe Linie über dem Flug-Track, nummerierte Punkte für die einzelnen Wendepunkte. Im Vollbild sind diese Punkte per Drag verschiebbar — Distanz und Routenart werden dabei live neu berechnet, so lässt sich eine falsch erkannte Route direkt auf der Karte korrigieren." },
  { v: "5.6", note: "IGC-Import erkennt jetzt auch geschlossene Dreiecke (Flach/FAI, nach XContest-Bonuspunkten bewertet) und schlägt die bestbewertete Route als Distanz vor, nicht mehr nur die freie Strecke. Neues Feld \"Routenart\" im Flugdetail (Freie Strecke/Flaches Dreieck/FAI-Dreieck) — wie Distanz ein überschreibbarer Vorschlag, kein automatischer Endwert." },
  { v: "5.5.1", note: "IGC-Import: Distanz-Feld wird jetzt als editierbarer Vorschlag vorausgefüllt (freie Streckenberechnung über bis zu 3 Wendepunkte, ~78% exakte Treffer gegen bekannte XContest-Werte) statt komplett leer zu bleiben — bestehende oder manuell eingetragene Werte werden nie überschrieben. Ausserdem: Max.Steigen/Max.Sinken-Berechnung nutzt jetzt Druckhöhe statt GPS-Höhe (deutlich genauer) und das Weltkarte-Icon in der Flugliste ist neu ein Globus." },
  { v: "5.5", note: "Schirm-Zeitleiste: Einstellungen (Farben, Reihenfolge, Ausblenden, Gruppierung/Sortierung) sind jetzt Teil des normalen Backups. Antippen eines Schirm-Eintrags in Statistik öffnet neu direkt die (vorgefilterte) Flugliste statt einer eigenen Übersicht — Flug-Details/Zurück verhalten sich wie gewohnt, \"Zurück\" aus der Liste führt wieder zu Statistik/Schirm zurück." },
  { v: "5.4", note: "Statistik ▸ Schirm: neue Zeitleisten-Grafik über der Schirm-Liste — eine Zeile pro Schirm, eine Spalte pro Jahr, Zelle = Anzahl Flüge; farblich nach Kategorie gruppiert (Standard/Tandem/Leicht), automatisch aus dem Typ (Solo/Biplace/Hike) der jeweiligen Flüge abgeleitet. Schirm-Name und Startjahr bleiben beim horizontalen Scrollen durch die Jahre fixiert. Eigenes Suchfeld darüber (identisches Filter-/Zeilen-Baukasten-System wie in der Flugliste, inkl. UND/ODER/Klammern) filtert, welche Flüge in die Jahres-Zellen einfliessen. ✏️ Bearbeiten-Modus: Balkenfarbe pro Schirm frei wählbar (auch zweifarbig, als Verlauf), Reihenfolge der Schirme innerhalb ihrer Kategorie per ▲▼ verschiebbar. Alles wird gespeichert." },
  { v: "5.3", note: "Suche unterstützt jetzt echte Klammerung: \"dauer>2h UND (schirm:XI ODER schirm:Artik)\" funktioniert direkt (Freitext oder Baukasten) statt nur über die alte UND-bindet-stärker-als-ODER-Regel. Die Such-Engine wertet dafür nicht mehr flach aus, sondern baut einen echten UND/ODER-Baum (rekursiver Parser). Im Zeilen-Baukasten neu ein \"( )\"-Kästchen pro Zeile — ab 2 benachbart markierten Zeilen entsteht eine Klammer-Gruppe, sichtbar als violette Linie am linken Rand." },
  { v: "5.2.1", note: "Suchen-Baukasten: jede Zeile hat jetzt ihre eigene UND/ODER-Verknüpfung zur vorherigen Zeile (antippbar), statt einem einzigen Schalter für alle Zeilen — gemischte Verknüpfungen wie \"A UND B ODER C\" lassen sich damit erstmals per Baukasten statt nur per Freitext bauen. Ausserdem: bei aktiver Suche neben \"X Treffer\" ein aufklappbares Statistik-Feld (Gesamtdauer/-distanz, Ø Dauer/Distanz, längster/weitester Flug, Max. Höhe, Anzahl Startplätze/Schirme, Ø Bewertung, Zeitraum) über genau die gefundene Auswahl." },
  { v: "5.2", note: "Flugbuch: Zustand (offener Flug/Ansicht, Scroll-Position) wird laufend gesichert. Beendet iOS die App unerwartet (z.B. wegen Speicherdruck) und man öffnet sie danach neu, springt Home jetzt automatisch zurück zur zuletzt offenen Flug-Detailansicht statt stur auf der Startseite zu landen — bewusstes Antippen von 🏠 bleibt davon unberührt und führt weiterhin ganz normal nach Home." },
  { v: "5.1.4", note: "Ausrüstung ▸ Gewichte ▸ Schirm: \"Gewichtslimite\" ist jetzt ein Range (min/max) statt eines einzelnen Werts. Neu in der Gesamtgewicht-Kachel unter Reserve: klein und grau der prozentuale Anteil innerhalb dieser Range (0% = Min, 100% = Max, kann auch ausserhalb liegen)." },
  { v: "5.1.3", note: "Massenbearbeitung (markierte Flüge, ✎ Bearbeiten) um alle bisher fehlenden Datenfelder erweitert: Startzeit, Landezeit, Start müM, Landung müM, Max. Höhe, Distanz, Ø Speed, Max.Steigen, Max.Sinken, H.Gew. sowie alle frei definierten eigenen Felder. Dauer, H.Diff. und Ø Speed werden dabei wie bei der Einzel-Bearbeitung automatisch neu berechnet, wenn die zugrundeliegenden Werte (Zeiten/Höhen/Distanz) geändert werden." },
  { v: "5.1.2", note: "Import-Panel: IGC-Icon 📂 → 🪂. Flug-Detail: separater \"🥾 Import\"-Button zum direkten Zuordnen einer Hike-GPX-Route entfernt (Doppelspurigkeit zum Import-Panel in der Liste) — dort steht nur noch das GPX-Badge, wenn eine Route bereits zugeordnet ist." },
  { v: "5.1.1", note: "Flugliste: Farben der Badges/Angaben getauscht — Startplatz jetzt rot (zuvor GPX-Farbe), GPX-Badge und Hike-Dauer jetzt grün (zuvor IGC-Farbe), IGC-Badge jetzt königsblau." },
  { v: "5.1", note: "Einstellungen ▸ Schirme: Modelle \"Orange/Türkis\" und \"Navy/Gelbgrün\" entfernt. Dafür zwei neue Symbol-Optionen ganz vorne: \"Eigenes Symbol\" (frei eintippbarer Buchstabe/Emoji) und ein fixes 🪂-Emoji. Beide werden wie die Foto-Varianten als Kartenmarker (Referenzpunkt, Cine-Wiedergabe) verwendet." },
  { v: "5.0", note: "Neue Seite \"🎒 Ausrüstung\" ersetzt die bisherige \"Wartung\"-Kachel auf Home. Zwei Tabs: \"⚖️ Ausrüstung, Gewichte\" (neu) und \"🛠️ Wartung\" (unverändert, nur umgezogen von wartung.html). Gewichte: 8 Kategorien (Schirm/Sitz/Reserve/Packhilfen/Geräte/Kleidung/Zubehör/Körpergewicht, farblich unterschieden), frei benennbare/erweiterbare Setups (z.B. Tandem/Solo/H&F) mit je eigener Positions-Auswahl, Gesamtgewicht, Gewichtslimite und Reserve — immer nur ein Setup gleichzeitig sichtbar. Positionsnamen und -gewichte werden manuell erfasst. Alte wartung.html leitet automatisch auf ausruestung.html weiter." },
  { v: "4.13", note: "Flugliste: neue 💡-Kachel zwischen Suchen und Sortieren — gespeicherte Darstellungen der Flugliste (kompletter Suchen/Sortieren/Gr.1°/Gr.2°-Zustand unter einem Namen sicherbar, per Tippen sofort wieder anwendbar). Liste mit \"Speichern als…\" oben, sowie Verschieben- und Löschen-Modus zum Verwalten." },
  { v: "4.12", note: "Gr. 1°/Gr. 2° in der Flugliste: die Gruppen lassen sich jetzt nach jedem beliebigen Datenfeld sortieren (nicht mehr nur alphabetisch nach dem Gruppierfeld selbst) — neue Auswahlliste (⇅) neben Gr. 1°/Gr. 2° zeigt alle Sortieren-Felder. Zahlenfelder (Dauer, Distanz, Höhe, Bewertung, …) werden dabei über die Gruppe summiert, Textfelder nehmen den alphabetisch ersten Wert. Gleiches Feld nochmals antippen kehrt die Richtung um (erst absteigend, dann aufsteigend)." },
  { v: "4.11", note: "Flugliste komplett neu strukturiert: statt fester Jahres-Gruppierung + einer Zusatz-Gruppierung jetzt zwei gleichwertige, frei wählbare Gruppierungs-Ebenen (Gr. 1° / Gr. 2°, jeweils inkl. \"Keine\"), beide um Jahr und Bewertung erweitert, jede mit eigener Sortierrichtung und eigenem Alle-ein-/ausklappen. Reihenfolge-Kachel aus der oberen Icon-Zeile entfernt und ins Suchen-Panel verschoben (neben Sortieren); \"alle Jahre\"-Kachel entfällt dadurch (Funktion jetzt in Gr. 1°/Gr. 2°)." },
  { v: "4.10.7", note: "Flugliste: Untergruppen (Gruppieren-Funktion) jetzt sortierbar — neuer ↑↓-Button neben \"Gruppieren\" ordnet die Untergruppen alphabetisch/numerisch auf- oder absteigend. Sortieren- und Gruppieren-Felder um Hike-Ort, Hike-Starthöhe, Hike-Höhenmeter und Hike-Dauer erweitert." },
  { v: "4.10.6", note: "Flugliste: die 7 Icon-Kacheln oben (Import, Backup, Auswahl, Weltkarte, Reihenfolge, alle Jahre, Suchen) einheitlich gestaltet — grauer Rand im Ruhezustand, offene Kachel jetzt mit rotem Rand und flächig leicht rot eingefärbtem Hintergrund statt der bisherigen uneinheitlichen Farben." },
  { v: "4.10.5", note: "Backup: Export wird jetzt gzip-komprimiert (deutlich kleinere Datei), Import erkennt sowohl komprimierte als auch alte unkomprimierte Backups automatisch. Neu: roter Punkt am 💾-Button, sobald es seit dem letzten Backup ungesicherte Änderungen an Flügen/Feldern gibt — verschwindet nach erfolgreichem Backup oder Import." },
  { v: "4.10.4", note: "Home/Statistik-Kachel: neue Info-Kachel \"X Hike-Flüge\" (nur sichtbar wenn >0). Kleine Info-Kacheln überall leicht verkleinert, damit auch 5 davon eher auf einer Zeile Platz haben." },
  { v: "4.10.3", note: "Höhenprofil: Hike-Bodenprofil kommt jetzt direkt aus den eigenen GPX-Höhenwerten statt der externen Terrain-API — braucht keine Anfrage mehr und der grüne Hike-Track liegt garantiert exakt am Boden. Flug-Teil behält 80 Abtastpunkte, plus ein automatischer Wiederholungsversuch bei Fehlschlag, da der kostenlose Höhendaten-Dienst keine Verfügbarkeits-Garantie bietet." },
  { v: "4.10.2", note: "Automatisches Reverse-Geocoding für Hike-Ort entfernt (MapTiler-Zuordnung erwies sich als unzuverlässig). \"Ort\" ist jetzt manuell editierbar wie Startpunkt — beim Import mit dem GPX-eigenen Routennamen vorbefüllt, falls die Wander-App einen gespeichert hat, sonst leer." },
  { v: "4.10.1", note: "Flugliste: Suchfilter, Sortierfeld/-richtung, Jahres-Gruppierung ein/aus und Untergruppierung bleiben jetzt beim erneuten Öffnen erhalten (gleiches Prinzip wie schon bei der Statistik)." },
  { v: "4.10", note: "Hike-Daten-Kachel: neues \"Ort\"-Feld (Reverse-Geocoding via MapTiler, Dorf/Ort-Bezeichnung aus Startpunkt-Koordinaten). Statistik: neue helle gelbe \"🥾 Hike\"-Hauptkachel nach Passagiere — gruppiert nach Ort, mit Höhenmeter, Hike-Dauer, erster/letzter Flug." },
  { v: "4.9.4", note: "\"Empf. Zeit\"-Berechnung aus v4.9.3 wieder entfernt — die Näherungsformel traf die eigenen tatsächlichen Werte nicht ausreichend. Hike-Daten-Kachel wieder wie in v4.9.2 (Dauer nur manuell)." },
  { v: "4.9.3", note: "Hike-Daten-Kachel: neues \"Empf. Zeit\"-Feld, berechnet nach der Swisstopo-Faustregel-Näherung (15 Min./km Ebene, 15 Min./100 Hm Aufstieg, 15 Min./200 Hm Abstieg) aus dem importierten Track. Füllt das Dauer-Feld automatisch, solange dieses noch leer ist." },
  { v: "4.9.2", note: "Flugdetail: bei Hike-Flügen mit importierter GPX-Route erscheint die Hike-Dauer rot und kleiner direkt neben der Flugzeit (zwischen Flugzeit und Bewertung) — bleibt garantiert auf einer Zeile, notfalls mit Auslassungspunkten." },
  { v: "4.9.1", note: "Hike-GPX-Import füllt Startpunkt (Koordinaten des ersten Track-Punkts) und damit auch Starthöhe automatisch aus, wenn noch nicht manuell gesetzt — bei allen drei Import-Wegen (Datums-Abgleich, Flugnummer, Direkt-Import)." },
  { v: "4.9", note: "Neue \"🥾 Hike-Daten\"-Kachel im Flugdetail, nur sichtbar wenn eine Hike-GPX-Route importiert wurde — direkt über den Flugdaten. Felder: Startpunkt, Starthöhe, Höhenmeter (live berechnet aus Startplatzhöhe minus Starthöhe), Dauer, und \"Zusatz\" mit frei umbenennbarem Titel." },
  { v: "4.8.3", note: "Flugdetail-Kopfzeile umgebaut: IGC-Badge jetzt blau (Track-Farbe), neues GPX-Badge grün (Hike-Farbe, wenn vorhanden), neuer 🥾 Import-Button (grün, ordnet GPX direkt diesem Flug zu, ohne Datums-Abgleich), XContest-Button jetzt gelb. Reihenfolge: Bewertung, IGC, GPX, Import, XContest." },
  { v: "4.8.2", note: "Wisch-Geste zum nächsten/vorherigen Flug wirkt nicht mehr innerhalb der Karte oder des Höhenprofils (vorher nur bei aktivem Zoom deaktiviert, jetzt generell). Erweiterte Suche: mehrzeilige Suchen bleiben beim Ein-/Ausblenden der Suchzeile erhalten und erscheinen wieder als bearbeitbare Zeilen statt nur als Kurz-Code." },
  { v: "4.8.1", note: "Hike/Flug-Profil-Fixes: Wanderschuh-Marker auf Karte erscheint jetzt auch beim manuellen Verschieben im Hike-Bereich; Karte und Profil zeigen immer denselben einen Referenzpunkt statt möglicherweise zwei Marker gleichzeitig; grüner Hike-Track liegt jetzt am braunen Bodenprofil an (kein künstlicher Abstand mehr); Cine-Übergang Hike→Flug bleibt beim Pausieren am echten Hike-Ende stehen statt sofort zum Flug-Start zu springen." },
  { v: "4.8", note: "Hike-GPX wird jetzt auch auf der Karte angezeigt (grün, gestrichelt). Cine-Wiedergabe kombiniert Hike + Flug bei vorhandenem Hike-Track: Hike-Phase (🥾, fixes Icon, keine Drehung) spielt zuerst, pausiert automatisch am Übergang, dann Flug-Phase (🪂) wie bisher. Export-/Löschen-Kacheln im Flugdetail verkleinert (mehr Platz auf iOS)." },
  { v: "4.7", note: "Neu: Import von Hike-GPX-Routen (🥾-Kachel, 3. Import-Option neben CSV/IGC), per Datum dem passenden Flug zugeordnet, bei mehreren Kandidaten Nachfrage. Flugdetail: Export als \"⬇ GPX Hike\" analog zu IGC/GPX. Löschen-Kacheln konsolidiert zu einer einzigen (🗑 ▾) mit Auswahl: IGC-Track, GPX Hike, oder ganzer Flug." },
  { v: "4.6", note: "Flugbuch/Liste: optionale Untergruppierung innerhalb jedes Jahres — \"📁 Gruppieren\" (unter Suchen/Sortieren) wählt aus Schirm, Typ, Startplatz, Landeplatz oder Reise, standardmässig \"Keine\" (unverändertes Verhalten). Jahr bleibt weiterhin die fixe Hauptgruppierung." },
  { v: "4.5.4", note: "Echter Suchfehler behoben: mehrwortige Werte wie \"Advance Pi 23\" wurden nie korrekt gefunden, weil sie beim Aufbau der Suchanfrage nicht in Anführungszeichen gesetzt und der Such-Tokenizer solche Anführungszeichen direkt nach einem Feldnamen ohnehin falsch gelesen hätte — beides jetzt behoben. Erweiterte Suche zeigt bei \"Schirm\" zusätzlich eine Liste der vorhandenen Schirme zur Auswahl." },
  { v: "4.5.3", note: "Höhenprofil: die rote Höhenangabe (Y-Achse) und Flugzeit/Distanz-Angabe (unter X-Achse) am Referenzpunkt sind jetzt auch in der unvergrösserten Übersicht sichtbar, nicht mehr nur bei aktivem Zoom — gleiche Formatierung wie bisher." },
  { v: "4.5.2", note: "Flugbuch/Liste: \"Alle\"-Button (Mehrfachauswahl) markiert bei aktiver Suche jetzt nur noch die aktuell angezeigten Suchergebnisse, nicht mehr das ganze Flugbuch." },
  { v: "4.5.1", note: "Flugbuch/Liste: Das Kat.1/Kat.2-Sortiersystem aus v4.5 war zu kompliziert und wurde vollständig zurückgenommen — wieder wie v4.4.8: feste Jahres-Gruppierung, ein Sortierfeld, einfacher ↑/↓-Umschalter ohne Dropdown." },
  { v: "4.5", note: "Flugbuch/Liste: grundlegend neues Gruppierungs-/Sortiersystem — \"Kat.1\" (Gruppierung, bisher fest Jahr) und \"Kat.2\" (Sortierfeld, bisher Nummer) sind jetzt beide unabhängig aus allen Feldern frei wählbar (inkl. \"Leer\"). Reihenfolge-Dropdown zeigt \"1°\"/\"2°\" mit den tatsächlich gewählten Feldnamen, nur verfügbar wenn beide gesetzt sind." },
  { v: "4.4.9", note: "Flugbuch/Liste: Reihenfolge-Taste (↑/↓) öffnet jetzt ein Dropdown mit \"1° Jahr\", \"2° Sortierfeld\" und \"Beide\" — Jahresgruppen-Reihenfolge war bisher fest auf absteigend fixiert, jetzt separat umkehrbar. Als erweiterbare Liste angelegt für künftige weitere Kategorien." },
  { v: "4.4.8", note: "Flugbuch/Liste: Reise-Feld im Bearbeiten-Menü (Mehrfachauswahl) jetzt ein Aufklappmenü mit bereits definierten Reisen statt Freitext. Eigenständige Reise-Kachel entfernt (nicht mehr nötig), dafür neuer \"Alle\"-Button zur Auswahl aller Flüge. Import: Zellen-Kachel entfernt. Backup: Text \"In iCloud sichern\" → \"Backup sichern\", Wolken-Icon bleibt." },
  { v: "4.4.7", note: "Flugdetail-Bedienleiste: Play-Zurücksetzen und Zoom-Zurücksetzen sind jetzt farblich statt per Text unterschieden — Play-Reset grün wie der Play-Button, Zoom-Kachel und Zoom-Reset beide rot, beide nur noch mit \"↺\" beschriftet." },
  { v: "4.4.6", note: "Flugdetail-Bedienleiste: 6 fest gleich breite Spalten (CSS Grid, gilt jetzt auf allen Bildschirmgrössen) statt variabler Flexbox-Breiten. Play-Zurücksetzen und Zoom-Zurücksetzen haben je eine eigene, immer reservierte Spalte, die leer bleibt statt zu verschwinden, wenn nicht anwendbar." },
  { v: "4.4.5", note: "Flugdetail: Höhenprofil rückt direkt unter die Karte, alle Bedienelemente (Play/Speed/Zurücksetzen/GPS Visualizer/Höhe·Steigen-Sinken/Zoom/Zoom zurücksetzen) sitzen jetzt kompakt mit Icons in einer gemeinsamen Zeile darunter." },
  { v: "4.4.4", note: "Flugliste: grauer Sekundärwert unter dem blauen Primärwert ist jetzt für jede Sortierung individuell definiert (z.B. bei Sortierung nach Startplatz erscheint darunter die Startzeit statt immer der Distanz)." },
  { v: "4.4.3", note: "Schirm-Auswahl (Settings): alle 9 Bilder neu freigestellt (Flood-Fill vom Rand statt globalem Weiss-Schwellwert, damit weisse Chevron-Muster im Design erhalten bleiben statt fälschlich transparent zu werden), Fusssack durchgehend korrekt schwarz, Beschriftungen korrigiert." },
  { v: "4.4.2", note: "Settings > 🪂 Schirme: Auswahl aus 9 Farb-/Muster-Varianten für den Gleitschirm-Marker (Referenzpunkt auf der Karte, Cine-Wiedergabe) — wirkt sofort app-weit, gespeichert für künftige Aufrufe." },
  { v: "4.4.1", note: "Cine-Wiedergabe im Vollbild: aktuelle Höhe (nur Zahl, rot, ohne Rahmen/Badge — analog zur Y-Achse im Profil) jetzt direkt neben dem Gleitschirm-Marker." },
  { v: "4.4", note: "Flugdetail-Karte (Vollbild): neue Cine-Wiedergabe — ▶-Button spielt den Flug mit 1×/2×/5×/10×/20×/50×/100× Geschwindigkeit ab, der Gleitschirm-Marker folgt dabei der Strecke und dreht sich live in Flugrichtung. ↺-Button springt zurück zum Start." },
  { v: "4.3.1", note: "Flugdetail-Karte: Referenzpunkt zeigt jetzt einen stilisierten Gleitschirm (eigenes Foto, freigestellt) statt eines roten Punkts — dreht sich beim Bewegen im Höhenprofil live in die tatsächliche Flugrichtung." },
  { v: "4.3", note: "Flugdetail-Karte läuft jetzt ebenfalls auf dem MapTiler SDK statt der eigenen Canvas-Lösung: native Pinch/Zoom im Vollbild, zuverlässigeres Laden, Geländestil mit deutscher Beschriftung. Höhenprofil-Synchronisierung (Referenzpunkt, Kartenausschnitt folgt dem Zoom-Fenster) vollständig erhalten." },
  { v: "4.2.9", note: "Weltkarte läuft jetzt auf dem MapTiler SDK (wie meintauchbuch) statt Leaflet/OpenTopoMap: Geländestil (Höhenlinien/Relief) mit deutscher Beschriftung, zuverlässigeres Kachel-Laden über MapTilers Infrastruktur." },
  { v: "4.2.8", note: "Weltkarte läuft jetzt auf Leaflet (echtes Pinch-/Doppeltipp-Zoom, träges Pan) statt eigenem Canvas-Renderer. Die Flugdetail-Karte (Höhenprofil-Synchronisierung) ist davon komplett unberührt, bleibt wie bisher." },
  { v: "4.2.7", note: "Weltkarte: Suche hat jetzt dieselbe erweiterbare Zeilen-Baukasten-Ansicht wie die Flugliste (mehrere Bedingungen, UND/ODER) statt nur eines Textfelds. Die drei Umschalter (Start-/Landeplätze, eigener Filter) bleiben jetzt immer auf einer Zeile." },
  { v: "4.2.6", note: "Weltkarte: Suche nutzt jetzt dieselbe erweiterte Syntax wie die Flugliste (feld:wert, Vergleiche, UND/ODER, +/-Wort). Neuer dritter, gelber Filter-Umschalter neben Start-/Landeplätze — frei mit einer eigenen Bedingung (gleiche Syntax) konfigurierbar, z.B. \"passagier:*\", gespeichert für künftige Aufrufe." },
  { v: "4.2.5", note: "Höhenprofil-Zoom: Verschieben per Maus (Klicken+Ziehen) funktioniert jetzt auch am Mac, nicht mehr nur per Touch. Flugbuch-Desktop-Layout deutlich breiter (Liste bis 1400px, Detail bis 1100px, Seitenleiste leicht mitwachsend) statt fest begrenzt." },
  { v: "4.2.4", note: "IGC-Import: Max. Steigen/Sinken wird jetzt über ein 30-Sekunden-Zeitfenster berechnet statt Momentanwert bzw. Thermik-Segment-Mittel — empirisch anhand von 83 eigenen Flügen mit bekannten XContest-Werten hergeleitet (deutlich näher an XContest als vorher). Weiterhin manuell überschreibbar. Hilfe entsprechend ergänzt." },
  { v: "4.2.3", note: "Flugbuch/Detail: neues Feld \"Typ\" direkt nach Gerät/Schirm — nur sichtbar wenn befüllt, sonst dezenter \"+ Typ\"-Link zum erstmaligen Eintragen. Auch per flexiblem CSV-Import befüllbar (Spalten Typ/Type/Schirmtyp/Kategorie)." },
  { v: "4.2.2", note: "IGC-Import: wenn eine Datei zu keiner Flug-Nr. passt, wird jetzt zusätzlich nach Datum abgeglichen (gegen Flüge ohne GPS-Track). Bei mehreren Treffern am gleichen Tag fragt die App aktiv nach, welchem Flug zugeordnet werden soll, statt zu raten. Mehrere IGC-Dateien gleichzeitig laden war bereits möglich." },
  { v: "4.2.1", note: "Flugbuch: \"Kopieren\" (Mehrfachauswahl) hat jetzt eine ⚙️-Spaltenkonfiguration — Spalten an-/abwählbar und per ↑/↓ neu anordenbar, gespeichert und automatisch im Backup erfasst, damit die kopierte Tabelle an externe Tabellenkalkulationen angepasst werden kann." },
  { v: "4.2", note: "Tablet/Desktop-Optimierung (ab 768px Breite): Home mit Foto+Kacheln nebeneinander, Flugbuch mit Master-Detail-Ansicht und kompakter einzeiliger Liste, Statistik-Badges nebeneinander, Wartung-Unterkacheln als feste offene Spalten statt Tabs. iPhone-Ansicht überall unverändert." },
  { v: "4.1.12", note: "Wartung/Reserve: Platzhalter-Titel jetzt \"Reserve 1-3\" statt der alten festen Namen (Schirm 1-4 und Sitz 1-5 waren bereits so). Alle Unterkacheln bleiben editierbar, Werte werden automatisch im Backup erfasst." },
  { v: "4.1.11", note: "Statistik: Passagiere-Badge blendet sich aus, wenn kein Flug einen Passagier hat (Saison rutscht nach). Home: Reisen-Kachel blendet sich aus, wenn keine Reisen erfasst sind." },
  { v: "4.1.10", note: "Statistik/Saison: Kachel \"Total Distanz\" ersetzt durch \"Flugtage\" (Anzahl unterschiedlicher Tage mit mindestens einem Flug)." },
  { v: "4.1.9", note: "Höhenprofil-Zoom: Zeitangabe an der gestrichelten Linie zeigt jetzt Flugdauer seit Start statt absoluter Uhrzeit. Beim Aktivieren eines Zoom-Levels springt die Markierung auf Flugstart (0:00)." },
  { v: "4.1.8", note: "CSV-Import: erkennt jetzt Kopfzeilen und ordnet Spalten flexibel zu (deutsche/englische Bezeichnungen, beliebige Reihenfolge) — nicht mehr auf das feste 53-Spalten-Format angewiesen. Fällt auf das bisherige feste Format zurück, wenn keine Kopfzeile erkannt wird." },
  { v: "4.1.7", note: "Flugdetail: neuer XContest-Button (königsblau) neben dem IGC-Badge, öffnet direkt xcontest.org/world/en/my-flights/." },
  { v: "4.1.6", note: "Kartenansicht (Übersicht + Vollbild): Trackspur jetzt einheitliches kräftiges Dunkelblau statt Höhen-Farbverlauf, etwas breiter. Das Höhenprofil-Diagramm behält seinen eigenen Farbverlauf." },
  { v: "4.1.5", note: "Höhenprofil: Bodenprofil-Raster verdichtet von 40 auf 80 Stützpunkte über die Flugstrecke." },
  { v: "4.1.4", note: "Home/Wartung-Kachel zeigt jetzt zusätzlich zu überfälligen Positionen (rot) auch das nächste anstehende Reserve-Packdatum an — grün, oder gelb falls es noch im laufenden Kalendermonat fällig ist." },
  { v: "4.1.3", note: "Höhenprofil-Zoom: zeigt jetzt zusätzlich Uhrzeit/Distanz (z.B. \"14:33/23.4km\") in Rot unter der X-Achse an der gestrichelten Mittellinie." },
  { v: "4.1.2", note: "Höhenprofil-Zoom: zeigt jetzt zusätzlich die Höhe am Schnittpunkt der gestrichelten Mittellinie mit der Flugspur, neben Minimum/Maximum auf der Y-Achse." },
  { v: "4.1.1", note: "Home/Wartung-Kachel vereinfacht: zeigt nur noch überfällige Positionen (Format \"Reserve Solo extern T.M.JJ\"), sonst \"Alles aktuell\"." },
  { v: "4.1", note: "Wartung: neues Kapitel 🎒 Gurtzeug (5 Positionen, orange), identisch zu Schirm aufgebaut. Titel bei Schirm/Gurtzeug direkt editierbar (nochmal auf den bereits aktiven Titel tippen). Hilfe (ausführlich + Kurzfassung) entsprechend aktualisiert." },
  { v: "4.0.2", note: "Wartung/Reserve: neues Kategorie-Feld vor dem Namen, editierbar, analog zu Schirm." },
  { v: "4.0.1", note: "Höhenprofil: Bodenprofil (Fläche und Linie) konnte bei Zoom über den linken/rechten Achsen-Rand hinausragen, während die Flugspur korrekt am Rand endete — jetzt symmetrisch auf den sichtbaren Bereich begrenzt." },
  { v: "4.0", note: "Neu: Offline-Fähigkeit über Service Worker (network-first mit Cache-Fallback, wie meintauchbuch) — ab dem zweiten erfolgreichen Online-Start funktioniert die App auch ohne Internetverbindung. Nach einem Redeploy wird stets sofort die neueste Version geladen, keine veraltete gecachte Version mehr sichtbar." },
  { v: "3.2.5", note: "Wartung: Schirm/Reserve jetzt echter Umschalter (immer genau eine Sektion offen, statt beide schliessbar). Check-Daten werden auf ein einheitliches Format (TT.MM.JJJJ) normalisiert, auch bereits vorhandene mit uneinheitlichem Format. Statistik: Saison-Auswahl hat jetzt eine \"Alle\"-Option ganz links, danach aktuelles Jahr, -1, -2, -3, ältere unter \"Mehr\"." },
  { v: "3.2.4", note: "Kurzfassung der Anleitung ist jetzt ein Umschalter innerhalb von hilfe.html statt eines separaten PDFs — keine zusätzliche Datei im Repo mehr nötig. Einstellungen → Kurzfassung öffnet direkt diese Ansicht." },
  { v: "3.2.3", note: "Home: Titel jetzt editierbar (antippen öffnet Editor) — beliebige Textteile mit je eigener Farbe, Schriftart (6 Stile) und Schriftgrösse, analog Tauchbuch. Zurücksetzen stellt \"meinflugbuch\" in Standard-Optik wieder her." },
  { v: "3.2.2", note: "Home: Kacheln 20% höher (Foto passt sich automatisch an). Hilfe-Badge auf Flugbuch/Statistik/Reisen/Wartung jetzt inline auf gleicher Zeile wie der Titel statt überlappend darüber schwebend; \"+ Flug\" dafür etwas schmaler." },
  { v: "3.2.1", note: "Ausführliche Anleitung ist jetzt eine eigene In-App-Seite (hilfe.html), analog Tauchbuch — mit Inhaltsverzeichnis und Sprungmarken, kein PDF-Download mehr nötig. Alle ❓-Buttons (Flugbuch/Statistik/Reisen/Wartung/Einstellungen) verlinken jetzt dorthin. Kurzfassung bleibt als PDF." },
  { v: "3.2", note: "Home: Foto füllt jetzt den restlichen Platz (wie Tauchbuch), Kacheln haben feste Höhe. Neu: ❓ Hilfe-Sektion in Einstellungen mit beiden PDF-Anleitungen (ausführlich + Kurzfassung). Roter \"?\"-Hilfe-Badge oben rechts auf Flugbuch/Statistik/Reisen/Wartung, öffnet direkt die ausführliche Anleitung." },
  { v: "3.1.1", note: "Weltkarte-Suche: logische Verknüpfung — mehrere Wörter mit Leerzeichen sind automatisch UND-verknüpft, \"oder\" trennt Alternativen (z.B. \"2026 Brasilien oder Wallis\")." },
  { v: "3.1", note: "Höhenprofil-Zoom: Karte zoomt jetzt synchron mit auf denselben Streckenabschnitt, statt nur einen Punkt zu markieren. Referenzpunkt kräftiges Rot mit weissem Rand. Im Profil selbst zeigt eine dünne gestrichelte Linie die Mitte des Ausschnitts (entspricht dem Kartenpunkt)." },
  { v: "3.0.5", note: "Karte zeigt jetzt einen gelben Referenzpunkt, wenn das Höhenprofil gezoomt ist — folgt dynamisch der Mitte des sichtbaren Ausschnitts, sowohl in der kleinen Vorschau als auch im Vollbild." },
  { v: "3.0.4", note: "Höhenprofil: Verschieben-Regler entfernt — bei aktivem Zoom (>1×) wird stattdessen direkt im Profil per Wischen verschoben, Wischen zwischen Flügen bleibt währenddessen weiterhin komplett blockiert." },
  { v: "3.0.3", note: "Höhenprofil: Wischen zwischen Flügen ist jetzt komplett blockiert, solange das Profil gezoomt ist (>1×) — verhindert Konflikte beim Verschieben im Profil. Zoom-Regler durch einen Button mit Listenauswahl (1-8×) ersetzt." },
  { v: "3.0.2", note: "Höhenprofil: neuer Verschieben-Regler (bei Zoom >1×) — verschiebt das sichtbare Fenster entlang der ganzen Strecke, statt fest auf die Flugmitte zentriert zu bleiben." },
  { v: "3.0.1", note: "Höhenprofil-Zoom: Bodenprofil zeigte beim Zoomen ein Zickzack-Muster (alle Bodenpunkte der ganzen Strecke wurden mitgezeichnet statt nur die sichtbaren) — jetzt korrekt gefiltert. Zoom-/Wisch-Geste zuverlässiger, blockiert das Wischen zwischen Flügen jetzt konsequent während der Geste." },
  { v: "3.0", note: "Neu: Weltkarte (🗺️-Button ersetzt den bisherigen Saison-Button im Flugbuch) — zeigt Start-/Landeplätze aller Flüge (grün/rot), oder nur der in der Listen-Auswahl markierten. Umschalter Start-/Landeplätze, Suche nach Platzname. Saison-Übersicht ist dafür 1:1 in die Statistik-Seite umgezogen (neuer 5. Badge)." },
  { v: "2.9.1", note: "Home: Einstellungen-Zahnrad + Versionsnummer jetzt unten rechts auf dem Foto, auf gleicher Höhe wie der Titel (statt oben). \"flug\" im Titel kräftigeres Orange (#ff9500)." },
  { v: "2.9", note: "Home: Titel \"meinflugbuch\" liegt jetzt direkt auf dem Foto (mit Verlaufs-Schatten für Lesbarkeit), statt in einer eigenen Box darüber." },
  { v: "2.8", note: "Home-Hintergrund auf dasselbe Dunkelblau wie Flugbuch (#040e20) umgestellt, statt dem bisherigen Grau-Blau." },
  { v: "2.7", note: "Neu: Höhenprofil in der Flugdetailansicht (nur bei IGC-Flügen) — zeigt zusätzlich zur Karte den Flugverlauf höhenfarbig über der Strecke, plus braunes Bodenprofil aus echten Höhendaten (Open-Meteo, weltweit). Achsen: m.ü.M. (Höhe) und km (Distanz)." },
  { v: "2.6.1", note: "Import: CSV-Datei- und Zellen-Einfügen-Import nutzen jetzt dieselbe Verarbeitungslogik statt zwei getrennter, leicht auseinandergedrifteter Implementierungen — dabei einen echten Bug gefunden und behoben (Strecken-Feld las in der CSV-Variante die falsche Spalte)." },
  { v: "2.6", note: "IGC-Kennzeichnung in der Detailansicht auf Höhe der Bewertungssterne verschoben (über der Notiz). Suche: alle Felder haben jetzt Operatoren (>, <, >=, <=, ≠, zwischen) — inkl. Start-/Landekoordinaten, Datum (chronologisch statt alphabetisch), Zeit und Text-Felder (alphabetisch)." },
  { v: "2.5", note: "Flugdetail: Abschnitt \"Ausrüstung & Ort\" heisst jetzt \"Flugdaten\", neu mit Entfernung Start-Landung (Luftlinie), Rang+%-Dauer und Rang+%-Distanz (100% = längster/weitester Flug). Suche/Sortierung deckt jetzt alle Flugdaten-Felder ab, inkl. der neuen. Passagier-Suche: \"beliebig\"-Option für Biplace-Flüge unabhängig vom Namen. Die 9 Daten-Kacheln scrollen jetzt zur Flugdaten-Liste. Reisen: Distanz pro Flug ergänzt, Schirm-Name (hellgrün) neben \"Flüge\"-Titel." },
  { v: "2.4", note: "Flugliste: bei aktiver Suche zeigt eine kleine Zeile zwischen Suchfeld und Ergebnissen jetzt die Anzahl Treffer an." },
  { v: "2.3.2", note: "Neu: Flugdetail hat jetzt einen zusätzlichen \"🗺️ In GPS Visualizer öffnen\"-Button (kleine Vorschau + Vollbild) — öffnet den Track in einem neuen Tab bei gpsvisualizer.com, höhenfarbig, metrisch. Läuft direkt aus den lokal gespeicherten Trackdaten, ohne Datei-Hosting." },
  { v: "2.3.1", note: "IGC-Import: Startzeit/Landezeit werden jetzt korrekt von UTC auf Lokalzeit umgerechnet — Geräte-Zeitzone aus dem IGC-Header, falls vorhanden; sonst per echter Zeitzonen-Bibliothek (Koordinaten → Zeitzone → korrekte Sommerzeit-Regel des jeweiligen Landes) statt einer groben Schätzung." },
  { v: "2.3", note: "Kartenkacheln: neuer 🔄-Button in der Vollbildkarte lädt gezielt nur die fehlenden Kacheln nach (statt die ganze Karte neu zu öffnen); ausserdem Gleichzeitigkeit begrenzt und ein zweiter Nachlade-Durchgang, um Serverüberlastung zu vermeiden. IGC-Import liest jetzt auch Schirm-Typ und Passagier (Crew2) aus dem Datei-Header aus, bleibt editierbar." },
  { v: "2.2.3", note: "Startplatz/Landeplatz: bei mehreren unterschiedlichen gespeicherten Koordinaten für denselben Namen wird jetzt nachgefragt, welche gelten soll, statt automatisch die neueste zu übernehmen. Neu: Höhengewinn wird aus dem IGC-Track berechnet (Summe aller Steigraten-Abschnitte), editierbar, erscheint auch als Kachel in der Detailansicht." },
  { v: "2.2.2", note: "IGC-Import: Höhenfeld-Bug behoben — die Höhen-Farbcodierung (und Max-Höhe/Thermik) las bisher versehentlich die Druckhöhe statt der GPS-Höhe, zusätzlich wurden vereinzelte Sensor-Aussetzer (0m) nicht mehr herausgefiltert. Betrifft nur neu importierte IGC-Dateien — bereits vorhandene Flüge müssten für die Korrektur neu importiert werden. Track-Farbskala zusätzlich kräftiger (100% statt 85% Sättigung)." },
  { v: "2.2.1", note: "Flugdetail: Notizen jetzt ohne Feld-Label, volle Breite, linksbündig. Kopfbereich: Import/Backup/Auswahl/Saison/Richtung/Jahr jetzt 6 quadratische Icon-Buttons in einer Zeile, Suchen+Sortieren je halbe Zeilenbreite darunter. Settings-Notizen: Speicherfehler werden jetzt geloggt statt verschluckt." },
  { v: "2.2", note: "Statistik/Reisen: Flug antippen öffnet jetzt die Flugbuch-Detailansicht, Zurück-Pfeil führt genau zur vorherigen Statistik-Kategorie bzw. zu Reisen zurück. Flugbuch-Kopfbereich neu geordnet: Zeile 1 nur Home/Titel/+Flug, Zeile 2 (Import/Backup/Auswahl/Saison) und Zeile 3 (Suchen/Sortierung/Richtung/Jahr) je 4 gleich grosse Buttons. Detailansicht: die 9 Daten-Kacheln kompakter, Bemerkung jetzt zwischen Bewertung und Karte. Koordinaten-Felder: Löschen funktioniert jetzt zuverlässig, Speichern stabiler (kein Doppel-Trigger mehr)." },
  { v: "2.1.1", note: "Erweiterte Suche: kein separater Aufklapp-Button mehr — das Suchfeld erweitert sich automatisch, sobald etwas eingetippt wird, und bleibt dabei weiterhin frei für Freitext." },
  { v: "2.1", note: "Neu: Mehrere Flüge nach Auswahl gemeinsam bearbeiten (gleiche Felder wie Einzelflug, leere Felder bleiben unverändert). Datum jetzt editierbar — nach Änderung werden alle Flüge automatisch chronologisch neu und lückenlos durchnummeriert. Erweiterte Suche in der Flugliste: beliebig viele kombinierbare Suchfelder (UND/ODER), aufklappbar, standardmässig einzeilig." },
  { v: "2.0", note: "App-Titel umbenannt: meinflugApp → meinflugbuch (alles klein, mein/buch weiss, flug weiterhin orange). Kachel/Seite \"Service\" umbenannt in \"Wartung\" (service.html → wartung.html)." },
  { v: "1.22", note: "Flugdetail: Lat/Lon jetzt als ein kombiniertes Eingabefeld, erkennt sowohl \"47.219903, 8.453543\" als auch \"41.86336° 21.52994°\". Auswahl kopieren: Start-/Landung-Spalte enthält jetzt Ortsname, m.ü.M. und Lat/Lon (5 Nachkommastellen) kombiniert, Numbers-freundlich formatiert." },
  { v: "1.21", note: "Flugdetail/Schirm: importierter Schirmname wird jetzt immer korrekt angezeigt, auch wenn er nicht in der Service-Liste registriert ist. Feld zeigt standardmässig nur den Namen als Text; Auswahlliste erscheint erst beim Antippen zum Ändern." },
  { v: "1.20", note: "Kartenvollbild: Wisch-Geste löst nicht mehr versehentlich Flugwechsel aus. Flugliste/Statistik/Reisen: alle Bewertungen (nicht nur 4-5⭐️) werden jetzt überall angezeigt, auch bei Landeplätze. Backup: Notizen werden jetzt mitgesichert und wiederhergestellt." },
  { v: "1.19", note: "Statistik: fehlenden useRef-Import behoben, der beim Öffnen der Tabellen einen Skriptfehler auslöste." },
  { v: "1.18", note: "Flugbuch: eigentliche Ursache der Track/Karten-Dezentrierung behoben — Track wurde durch doppelte Zentrierung auf einer Achse verkleinert statt den Letterbox-Bereich zu füllen." },
  { v: "1.17", note: "Flugbuch: Vollbild-Kartenansicht mit Pinch-Zoom/Verschieben per Fingergeste, Track dort in kräftigem Rot und dicker gezeichnet." },
  { v: "1.16", note: "Flugbuch: Track/Karte-Zentrierung repariert. Settings: Notizen-Feld ergänzt. CSV-Export aus Detailansicht entfernt. Statistik/Schirm: Chip-Zeilen scrollen synchron, Namen bleiben fixiert." },
  { v: "1.15", note: "Flugbuch: Löschen/Leeren bei Start-/Landeplatz-Autovervollständigung repariert (Backspace/Delete löste vorher sofort erneute Vorschläge aus)." },
  { v: "1.14", note: "Flugbuch: Autovervollständigung bei Start-/Landeplatz übernimmt automatisch Koordinaten und Höhe des zuletzt genutzten gleichnamigen Ortes." },
  { v: "1.13", note: "Flugbuch: Feld 'Pilot' entfernt." },
  { v: "1.12", note: "Flugbuch: Startzeit/Landezeit editierbar; Dauer/H.Diff./Ø-Speed automatisch berechnet (nur ohne IGC-Track); Startplatz/Landeplatz mit Inline-Autovervollständigung wie in Tabellenkalkulationen." },
  { v: "1.11", note: "Flugbuch: Ursache behoben, warum CSV-Badge verschwand — IGC-Import überschrieb pdfOnly fälschlich; CSV-Re-Import stellt es korrekt wieder her." },
  { v: "1.10", note: "Flugbuch: PDF-Badge zu CSV umbenannt (nur bei Import, nicht manuell), Import-Badge 'CSV/PDF'→'CSV', Bewertungszahl gelb und kleinerer Stern." },
  { v: "1.9", note: "Flugbuch/Liste: Bewertung ab 4 Sternen direkt vor der Flugzeit angezeigt (orange, z.B. '5⭐️ 1:54')." },
  { v: "1.8", note: "Flugbuch: Pfeile in Detailansicht durch Wisch-Geste ersetzt (links = vorheriger, rechts = nächster Flug)." },
  { v: "1.7", note: "Home/Service: Schirmname statt Kategorie bei Nächster Check. Statistik: Antippen eines Werts öffnet sortierbare Flugliste als Vollbild." },
  { v: "1.6", note: "Flugbuch: ganze Jahres-Gruppen auf einmal auswählbar; Mehrfach-Löschen fragt jetzt nach ganzem Flug oder nur IGC-Track." },
  { v: "1.5", note: "Flugbuch: Bewertungssterne lassen sich durch erneutes Antippen auf 0 zurücksetzen." },
  { v: "1.4", note: "Flugbuch: einzelner Flug als CSV exportierbar, in exakt gleicher Spaltenstruktur wie beim Import (für Numbers/Excel)." },
  { v: "1.3", note: "Flugbuch: Schirm-Feld als Dropdown mit den in Service/Schirm angelegten Namen, analog zu Reise." },
  { v: "1.2", note: "Flugbuch: IGC-Track löschbar (Start/Landung bleiben), zuverlässigeres Springen zum nächsten Feld, doppeltes Kommentarfeld entfernt." },
  { v: "1.1", note: "Home/Service: Kategorie statt Name, Datum in eigener zweiter Zeile. Home/Flugbuch: Chip-Farbe an Statistik angeglichen." },
  { v: "1.0", note: "Erste vollständige Version: Flugbuch, Statistik, Service, Reisen — alle Kernfunktionen umgesetzt und stabil." },
  { v: "0.35", note: "Backup: 'title'-Parameter aus dem Teilen-Aufruf entfernt (vermutliche Ursache der zusätzlichen leeren .txt-Datei)." },
  { v: "0.34", note: "Reisen/Flugbuch: Nummerierung der Flüge innerhalb einer Reise nach Flugnummer statt Datum (robust gegen fehlende Zeitangaben)." },
  { v: "0.33", note: "Flugbuch: kompletter oberer Bereich (inkl. aufgeklappter Menüs) bleibt beim Scrollen fixiert; Jahresgruppierung auch bei Nummer-Sortierung." },
  { v: "0.32", note: "Flugbuch: Sortierung nach Nummer ergänzt und als Standard gesetzt, obere 3 Zeilen beim Scrollen fixiert." },
  { v: "0.31", note: "Home: erneute Prüfung der Zählungen kurz nach dem Laden, damit Reisen-Anzahl auch beim ersten Öffnen korrekt ist." },
  { v: "0.30", note: "Home: Settings-Button mit Log-Files/Versionshistorie. Reisen: Verwaltung auf-/zuklappbar, Anzahl Reisen sichtbar." },
  { v: "0.29", note: "Reisen: Badge+Statistik zu horizontal scrollbaren Spalten zusammengeführt, Verwaltungsbereich separat." },
  { v: "0.28", note: "Flugbuch: Reise-Nr./Reise-Flug-Nr. nach Flugnummer, spaltenartig ausgerichtet, IGC leuchtend grün." },
  { v: "0.27", note: "Reisen: Reihenfolge der Karten per Auf/Ab-Pfeile verschiebbar, Nummerierung passt sich automatisch an." },
  { v: "0.26", note: "Reisen: Dropdown mit bestehenden Reisen + Neuanlage, 'Von...bis...' im Titelfeld der Karte." },
  { v: "0.25", note: "Flugbuch: Massenzuordnung ausgewählter Flüge zu einer Reise über Dropdown im Auswahl-Modus." },
  { v: "0.24", note: "Neue Reisen-Seite: Flüge einer Reise zuordnen (Flugbuch-Dropdown), automatische Auswertung wie Vorlage." },
  { v: "0.23", note: "Statistik/Schirm: Erster Flug und Letzter Flug als Chips ergänzt." },
  { v: "0.22", note: "Flugbuch-Detailansicht: grüner GPX-Download-Button neben IGC-Download." },
  { v: "0.21", note: "Kartenkacheln: automatische Wiederholung bei fehlgeschlagenen OpenTopoMap-Anfragen." },
  { v: "0.20", note: "Backup: Service-Daten (Reserve/Schirm) und künftige Reisen-Daten werden mitgesichert." },
  { v: "0.19", note: "Kartenkacheln: komplette Neufassung der Zeichenlogik gegen Lücken (Offscreen-Kachelraster)." },
  { v: "0.18", note: "Kartenkacheln: Skalierungsfehler behoben, der die Karte in eine Ecke schrumpfen liess." },
  { v: "0.17", note: "Kartenkacheln: lineare Tile-Pixel-Positionierung gegen Rundungsfehler-Lücken." },
  { v: "0.16", note: "Kartenansicht: GPS-Ausreisser werden bei der Kartengrenzen-Berechnung gefiltert." },
  { v: "0.15", note: "Vollbild-Karte: GPX-Button-Position und Deckkraft korrigiert." },
  { v: "0.14", note: "Vollbild-Karte: Doppeltipp durch sichtbaren GPX-Download-Button ersetzt." },
  { v: "0.13", note: "GPX-Export vereinfacht: nur noch Download, kein automatisches Öffnen von gpx.studio." },
  { v: "0.12", note: "GPX-Export: Download statt fragiler URL-Übergabe an gpx.studio (Längenlimit)." },
  { v: "0.11", note: "Flug-Track in der Karte deutlich dicker gezeichnet." },
  { v: "0.10", note: "Flugkarte: Vollbildansicht bei Antippen, leeres Kartenfeld ohne IGC in Flugbuch-Blau." },
  { v: "0.9", note: "Echte Geländekarte (OpenTopoMap) hinter dem GPS-Track im Flugbuch." },
  { v: "0.8", note: "Statistik-Badges neu angeordnet, Home-Service-Kachel zeigt Fälligkeitsdatum." },
  { v: "0.7", note: "Service: Zahlen-Eingabefehler behoben, Statistik-Chips zweizeilig, Koordinaten-Position." },
  { v: "0.6", note: "CSV-Import: Dauer-Format 'Xh Ym' korrekt erkannt (vorher 0h 00m)." },
  { v: "0.5", note: "Diagnose für CSV-Dauer-Werte eingebaut, Statistik-Chips gegen Zeilenumbruch abgesichert." },
  { v: "0.4", note: "CSV-Import: Flugdauer-Format 'H:MM' korrekt in Sekunden umgerechnet." },
  { v: "0.3", note: "Statistik/Schirm: alle Kennzahlen (Zeit/Flug, km/Flug, Höhe, Plätze), Sortierfunktion." },
  { v: "0.2", note: "Neue Statistik-Seite: Schirm, Passagiere, Land-/Startplätze, live aus Flugdaten." },
  { v: "0.1", note: "Erste Versionsnummer eingeführt, Startpunkt der Versionshistorie." },
];

// ── Editable title (ported from Tauchbuch's home.jsx) ──────────────────────
// Each text segment gets its own colour; font family/size apply to the
// whole title. Segments/font are stored together so a full custom title
// (text, colours, font, size) round-trips through Reset cleanly.
const DEFAULT_TITLE_CFG = {
  segments: [
    { text: "mein", color: "#ffffff" },
    { text: "flug", color: "#f59e0b" },
    { text: "buch", color: "#ffffff" },
  ],
  fontFamily: "-apple-system,BlinkMacSystemFont,sans-serif",
  fontSize: 26,
};
const TITLE_FONTS = [
  { label: "Standard", value: "-apple-system,BlinkMacSystemFont,sans-serif" },
  { label: "Serifenschrift", value: "Georgia, 'Times New Roman', serif" },
  { label: "Rund (Verdana)", value: "Verdana, Geneva, sans-serif" },
  { label: "Schreibmaschine", value: "'Courier New', monospace" },
  { label: "Handschrift", value: "'Comic Sans MS', 'Comic Sans', cursive" },
  { label: "Elegant", value: "Didot, Georgia, serif" },
];
const TITLE_SWATCHES = ["#ffffff", "#f59e0b", "#38bdf8", "#4ade80", "#f87171", "#a78bfa"];
let segIdCounter = 0;
const newSegId = () => `seg${Date.now()}_${segIdCounter++}`;

function TitleEditor({ current, onSave, onReset, onClose }) {
  const [segments, setSegments] = useState(
    current.segments.map(s => ({ ...s, _id: newSegId() }))
  );
  const [fontFamily, setFontFamily] = useState(current.fontFamily);
  const [fontSize, setFontSize] = useState(current.fontSize);

  const updateSeg = (id, patch) => setSegments(segs => segs.map(s => s._id===id ? {...s, ...patch} : s));
  const addSeg = () => setSegments(segs => [...segs, { _id: newSegId(), text: "neu", color: "#ffffff" }]);
  const removeSeg = (id) => setSegments(segs => segs.length>1 ? segs.filter(s=>s._id!==id) : segs);

  return (
    <div onClick={onClose} style={{position:"fixed",inset:0,background:"rgba(0,0,0,0.6)",zIndex:300,display:"flex",alignItems:"center",justifyContent:"center",padding:24}}>
      <div onClick={e=>e.stopPropagation()}
        style={{background:"#0a1628",borderRadius:16,padding:"18px 20px",maxWidth:380,width:"100%",border:"1px solid rgba(255,255,255,0.1)",maxHeight:"85vh",overflowY:"auto"}}>
        <div style={{fontSize:15,fontWeight:800,marginBottom:14}}>Titel bearbeiten</div>

        <div style={{marginBottom:12}}>
          <div style={{fontSize:11,color:"rgba(232,244,253,0.5)",marginBottom:6}}>Textteile (je mit eigener Farbe)</div>
          <div style={{display:"flex",flexDirection:"column",gap:8}}>
            {segments.map(seg => (
              <div key={seg._id} style={{display:"flex",alignItems:"center",gap:8}}>
                <input value={seg.text} onChange={e=>updateSeg(seg._id,{text:e.target.value})}
                  style={{flex:1,minWidth:0,boxSizing:"border-box",background:"rgba(255,255,255,0.08)",border:"1px solid rgba(56,189,248,0.4)",borderRadius:8,padding:"6px 9px",color:"#e8f4fd",fontSize:13}} />
                <input type="color" value={seg.color} onChange={e=>updateSeg(seg._id,{color:e.target.value})}
                  style={{width:28,height:26,border:"none",background:"none",cursor:"pointer",padding:0,flexShrink:0}} />
                <button onClick={()=>removeSeg(seg._id)} disabled={segments.length<=1}
                  style={{background:"none",border:"none",color:segments.length<=1?"rgba(232,244,253,0.15)":"#f87171",fontSize:15,cursor:segments.length<=1?"default":"pointer",flexShrink:0,padding:"2px 4px"}}>✕</button>
              </div>
            ))}
          </div>
          <div style={{display:"flex",gap:6,marginTop:8,flexWrap:"wrap"}}>
            {segments.map(seg => (
              <div key={seg._id} style={{display:"flex",gap:4}}>
                {TITLE_SWATCHES.map(c => (
                  <div key={c} onClick={()=>updateSeg(seg._id,{color:c})}
                    title={`"${seg.text}" einfärben`}
                    style={{width:16,height:16,borderRadius:"50%",background:c,cursor:"pointer",border:seg.color===c?"2px solid #7dd3fc":"1px solid rgba(255,255,255,0.25)"}} />
                ))}
              </div>
            ))}
          </div>
          <button onClick={addSeg}
            style={{marginTop:8,background:"rgba(255,255,255,0.06)",border:"1px solid rgba(255,255,255,0.12)",borderRadius:8,padding:"5px 10px",color:"rgba(232,244,253,0.7)",fontSize:12,cursor:"pointer"}}>
            + Textteil
          </button>
        </div>

        <div style={{marginBottom:12}}>
          <div style={{fontSize:11,color:"rgba(232,244,253,0.5)",marginBottom:4}}>Schriftart (für den ganzen Titel)</div>
          <select value={fontFamily} onChange={e=>setFontFamily(e.target.value)}
            style={{width:"100%",boxSizing:"border-box",background:"rgba(255,255,255,0.08)",border:"1px solid rgba(255,255,255,0.12)",borderRadius:8,padding:"7px 10px",color:"#e8f4fd",fontSize:14}}>
            {TITLE_FONTS.map(f => <option key={f.value} value={f.value} style={{background:"#0a1628"}}>{f.label}</option>)}
          </select>
        </div>

        <div style={{marginBottom:16}}>
          <div style={{fontSize:11,color:"rgba(232,244,253,0.5)",marginBottom:4}}>Schriftgrösse: {fontSize}px</div>
          <input type="range" min="16" max="40" value={fontSize} onChange={e=>setFontSize(+e.target.value)}
            style={{width:"100%"}} />
        </div>

        <div style={{textAlign:"center",marginBottom:16,padding:"14px 0",background:"rgba(255,255,255,0.03)",borderRadius:10,whiteSpace:"nowrap",overflow:"hidden",textOverflow:"ellipsis"}}>
          <span style={{fontFamily,fontSize,fontWeight:900,letterSpacing:-0.5}}>
            {segments.map(seg => <span key={seg._id} style={{color:seg.color}}>{seg.text}</span>)}
          </span>
        </div>

        <div style={{display:"flex",gap:8}}>
          <button onClick={onReset}
            style={{flex:1,background:"rgba(255,255,255,0.08)",border:"1px solid rgba(255,255,255,0.12)",borderRadius:10,padding:"9px",color:"rgba(232,244,253,0.7)",fontSize:13,cursor:"pointer"}}>
            Zurücksetzen
          </button>
          <button onClick={()=>onSave({ segments: segments.map(({_id,...s})=>s), fontFamily, fontSize })}
            style={{flex:1,background:"linear-gradient(135deg,#0ea5e9,#0284c7)",color:"#fff",border:"none",borderRadius:10,padding:9,fontSize:13,fontWeight:800,cursor:"pointer"}}>
            Speichern
          </button>
        </div>
      </div>
    </div>
  );
}

function SettingsOverlay({ onClose }) {

  const [openFolder, setOpenFolder] = useState(null); // "logfiles" | "notes" | "gliders" | null
  const [notes, setNotes] = useState("");
  const [notesLoaded, setNotesLoaded] = useState(false);
  const [notesDirty, setNotesDirty] = useState(false);
  const [saveStatus, setSaveStatus] = useState(""); // "", "saving", "saved", "error"
  const [gliderVariant, setGliderVariant] = useState(DEFAULT_GLIDER_VARIANT);
  // Eigenes Flugsymbol (1 von 9, "custom"): ein frei eintippbarer Buchstabe
  // oder Emoji, separat vom gewählten gliderVariant gespeichert, damit man
  // ihn bearbeiten kann ohne ihn zwangsläufig sofort auszuwählen.
  const [gliderCustomChar, setGliderCustomChar] = useState("");
  useEffect(() => {
    (async () => {
      try {
        const r = await window.storage.get("gliderVariant");
        if (r && r.value) setGliderVariant(r.value);
        const c = await window.storage.get("gliderCustomChar");
        if (c && c.value) setGliderCustomChar(c.value);
      } catch (e) { console.error("Schirm-Auswahl: Laden fehlgeschlagen:", e); }
    })();
  }, []);
  const chooseGlider = async (id) => {
    setGliderVariant(id);
    try { await window.storage.set("gliderVariant", id); } catch (e) { console.error("Schirm-Auswahl: Speichern fehlgeschlagen:", e); }
  };
  const setCustomChar = async (char) => {
    setGliderCustomChar(char);
    try { await window.storage.set("gliderCustomChar", char); } catch (e) { console.error("Eigenes Symbol: Speichern fehlgeschlagen:", e); }
  };

  useEffect(() => {
    (async () => {
      try {
        const r = await window.storage.get("settings:notes");
        if (r) setNotes(r.value || "");
      } catch (e) { console.error("Notizen: Laden fehlgeschlagen:", e); }
      setNotesLoaded(true);
    })();
  }, []);

  // Deliberately NOT auto-saving on every keystroke anymore — typed text
  // only lives in local state until "Speichern" is tapped, which is the
  // one and only place that writes to storage. Simpler to reason about
  // and reliable regardless of what caused the earlier silent data loss.
  const saveNotes = async () => {
    setSaveStatus("saving");
    try {
      await window.storage.set("settings:notes", notes);
      setNotesDirty(false);
      setSaveStatus("saved");
      setTimeout(() => setSaveStatus(""), 1500);
    } catch (e) {
      console.error("Notizen: Speichern fehlgeschlagen:", e);
      setSaveStatus("error");
    }
  };

  const logText = VERSION_LOG.map(e => `v${e.v} — ${e.note}`).join("\n");

  return (
    <div style={{position:"fixed",inset:0,background:"rgba(0,0,0,0.6)",zIndex:300,display:"flex",alignItems:"flex-end",justifyContent:"center"}}
      onClick={onClose}>
      <div onClick={e=>e.stopPropagation()}
        style={{background:"#1a1f2b",borderTopLeftRadius:20,borderTopRightRadius:20,width:"100%",maxWidth:480,maxHeight:"80vh",overflowY:"auto",padding:"16px 16px calc(24px + env(safe-area-inset-bottom, 0px))"}}>
        <div style={{display:"flex",justifyContent:"space-between",alignItems:"center",marginBottom:4}}>
          <span style={{fontSize:17,fontWeight:800,color:"#fff"}}>⚙️ Einstellungen</span>
          <button onClick={onClose} style={{background:"rgba(255,255,255,0.08)",border:"none",borderRadius:20,width:30,height:30,color:"#fff",fontSize:16,cursor:"pointer"}}>✕</button>
        </div>
        <div style={{
            fontSize:13, color:"#fff", marginBottom:14,
            WebkitUserSelect:"text", userSelect:"text", WebkitTouchCallout:"default",
          }}>
          {typeof window!=="undefined" ? window.location.href.substring(0, window.location.href.lastIndexOf("/")+1) : ""}
        </div>

        {/* Hilfe: direct link to the in-app help page */}
        <div style={{background:"rgba(255,255,255,0.04)",border:"1px solid rgba(255,255,255,0.08)",borderRadius:12,overflow:"hidden",marginBottom:10}}>
          <div
            style={{padding:"12px 14px",display:"flex",justifyContent:"space-between",alignItems:"center",cursor:"pointer"}}
            onClick={()=>window.location.href="hilfe.html"}>
            <span style={{fontSize:14,fontWeight:700,color:"#e8f4fd"}}>❓ Hilfe</span>
            <span style={{color:"rgba(232,244,253,0.4)",fontSize:13}}>›</span>
          </div>
        </div>

        {/* Schirme: choose which glider marker image is used on the map
            (Weltkarte reference point, cine playback) app-wide */}
        <div style={{background:"rgba(255,255,255,0.04)",border:"1px solid rgba(255,255,255,0.08)",borderRadius:12,overflow:"hidden",marginBottom:10}}>
          <div onClick={()=>setOpenFolder(openFolder==="gliders"?null:"gliders")}
            style={{padding:"12px 14px",display:"flex",justifyContent:"space-between",alignItems:"center",cursor:"pointer"}}>
            <span style={{fontSize:14,fontWeight:700,color:"#e8f4fd"}}>🪂 Schirme</span>
            <span style={{color:"rgba(232,244,253,0.4)",fontSize:13}}>{openFolder==="gliders"?"▾":"▸"}</span>
          </div>
          {openFolder==="gliders" && (
            <div style={{padding:"0 14px 14px"}}>
              <div style={{fontSize:12,color:"rgba(232,244,253,0.5)",marginBottom:10}}>Für den Referenzpunkt auf der Karte und die Cine-Wiedergabe.</div>
              <div style={{display:"grid",gridTemplateColumns:"1fr 1fr 1fr",gap:8}}>
                {GLIDER_VARIANTS.map(v => {
                  const isCustom = v.id === "custom";
                  const isActive = v.id === gliderVariant;
                  const Wrapper = isCustom ? "div" : "button";
                  return (
                    <Wrapper key={v.id} onClick={isCustom ? undefined : ()=>chooseGlider(v.id)}
                      style={{background:isActive?"rgba(74,222,128,0.15)":"rgba(255,255,255,0.05)",border:`2px solid ${isActive?"#4ade80":"rgba(255,255,255,0.1)"}`,borderRadius:10,padding:"8px 6px",cursor:isCustom?"default":"pointer",display:"flex",flexDirection:"column",alignItems:"center",gap:6}}>
                      {v.type === "image" ? (
                        <img src={v.dataUrl} alt={v.label} style={{width:"100%",height:56,objectFit:"contain"}} />
                      ) : isCustom ? (
                        <input value={gliderCustomChar} onChange={e=>setCustomChar(e.target.value.slice(-2))}
                          onFocus={()=>{ if (!isActive) chooseGlider("custom"); }}
                          placeholder="+"
                          style={{width:"100%",height:56,background:"rgba(255,255,255,0.06)",border:"1px solid rgba(255,255,255,0.12)",borderRadius:8,color:"#fff",fontSize:28,textAlign:"center",boxSizing:"border-box"}} />
                      ) : (
                        <div style={{width:"100%",height:56,display:"flex",alignItems:"center",justifyContent:"center",fontSize:32}}>{v.char}</div>
                      )}
                      <span style={{fontSize:10,fontWeight:isActive?800:500,color:isActive?"#4ade80":"rgba(232,244,253,0.7)",textAlign:"center"}}>{v.label}</span>
                    </Wrapper>
                  );
                })}
              </div>
            </div>
          )}
        </div>

        {/* Log Files folder */}
        <div style={{background:"rgba(255,255,255,0.04)",border:"1px solid rgba(255,255,255,0.08)",borderRadius:12,overflow:"hidden",marginBottom:10}}>
          <div onClick={()=>setOpenFolder(openFolder==="logfiles"?null:"logfiles")}
            style={{padding:"12px 14px",display:"flex",justifyContent:"space-between",alignItems:"center",cursor:"pointer"}}>
            <span style={{fontSize:14,fontWeight:700,color:"#e8f4fd"}}>📁 Log Files</span>
            <span style={{color:"rgba(232,244,253,0.4)",fontSize:13}}>{openFolder==="logfiles"?"▾":"▸"}</span>
          </div>
          {openFolder==="logfiles" && (
            <div style={{padding:"0 14px 14px"}}>
              <div style={{background:"rgba(0,0,0,0.3)",borderRadius:8,padding:"10px 12px",fontFamily:"monospace",fontSize:11,color:"rgba(232,244,253,0.75)",whiteSpace:"pre-wrap",maxHeight:280,overflowY:"auto"}}>
                {logText}
              </div>
            </div>
          )}
        </div>

        {/* Notizen: small free-text notes field, persisted across sessions */}
        <div style={{background:"rgba(255,255,255,0.04)",border:"1px solid rgba(255,255,255,0.08)",borderRadius:12,overflow:"hidden"}}>
          <div onClick={()=>setOpenFolder(openFolder==="notes"?null:"notes")}
            style={{padding:"12px 14px",display:"flex",justifyContent:"space-between",alignItems:"center",cursor:"pointer"}}>
            <span style={{fontSize:14,fontWeight:700,color:"#e8f4fd"}}>📝 Notizen{notesDirty?" •":""}</span>
            <span style={{color:"rgba(232,244,253,0.4)",fontSize:13}}>{openFolder==="notes"?"▾":"▸"}</span>
          </div>
          {openFolder==="notes" && notesLoaded && (
            <div style={{padding:"0 14px 14px"}}>
              <textarea value={notes} onChange={e=>{ setNotes(e.target.value); setNotesDirty(true); setSaveStatus(""); }}
                placeholder="Freie Notizen…"
                style={{width:"100%",minHeight:120,background:"rgba(0,0,0,0.3)",border:"1px solid rgba(255,255,255,0.1)",borderRadius:8,padding:"10px 12px",color:"#e8f4fd",fontSize:13,resize:"vertical",boxSizing:"border-box",fontFamily:"inherit"}} />
              <div style={{display:"flex",alignItems:"center",gap:10,marginTop:8}}>
                <button onClick={saveNotes} disabled={saveStatus==="saving"}
                  style={{background:"rgba(34,197,94,0.18)",border:"1px solid rgba(34,197,94,0.4)",borderRadius:10,padding:"8px 16px",color:"#4ade80",fontSize:13,fontWeight:700,cursor:saveStatus==="saving"?"default":"pointer"}}>
                  💾 Speichern
                </button>
                {saveStatus==="saving" && <span style={{fontSize:12,color:"rgba(232,244,253,0.5)"}}>Speichert…</span>}
                {saveStatus==="saved" && <span style={{fontSize:12,color:"#4ade80"}}>✓ Gespeichert</span>}
                {saveStatus==="error" && <span style={{fontSize:12,color:"#f87171"}}>Fehler beim Speichern — nochmal versuchen</span>}
                {saveStatus==="" && notesDirty && <span style={{fontSize:12,color:"rgba(251,191,36,0.8)"}}>Ungespeicherte Änderungen</span>}
              </div>
            </div>
          )}
        </div>
      </div>
    </div>
  );
}

function fmtDateCompact(date) {
  if (!date) return "";
  const d = new Date(date);
  return `${d.getDate()}.${d.getMonth()+1}.${String(d.getFullYear()).slice(-2)}`;
}

function formatServiceStat(entry) {
  return { line1: `${entry.categoryLabel} ${entry.name} ${fmtDateCompact(entry.nextDue)}`, line2: null, color: entry.color || "#f87171" };
}

function HomeApp() {
  const isWide = useIsWide();
  const [photoUrl, setPhotoUrl] = useState(null);
  const fileRef = React.useRef(null);
  const photoCardRef = React.useRef(null);
  const [photoTopOffset, setPhotoTopOffset] = useState(20);
  const [flightCount, setFlightCount] = useState(null);
  const [biplaceCount, setBiplaceCount] = useState(null);
  const [serviceUrgency, setServiceUrgency] = useState({ overdue: [], nextReserve: null });
  const [statistikCounts, setStatistikCounts] = useState({ startSites: null, endSites: null, gliders: null, biplace: null, hikeFlights: null });
  const [showSettings, setShowSettings] = useState(false);
  const [titleCfg, setTitleCfg] = useState(null);
  const [editingTitle, setEditingTitle] = useState(false);

  useEffect(() => {
    try {
      const saved = localStorage.getItem("flugbuch:titleConfig");
      if (saved) {
        const parsed = JSON.parse(saved);
        if (parsed && parsed.segments) setTitleCfg(parsed);
      }
    } catch {}
  }, []);
  const saveTitleCfg = (cfg) => {
    setTitleCfg(cfg);
    setEditingTitle(false);
    try { localStorage.setItem("flugbuch:titleConfig", JSON.stringify(cfg)); } catch (e) { console.error("Titel-Speicherfehler:", e); }
  };
  const resetTitleCfg = () => {
    setTitleCfg(null);
    setEditingTitle(false);
    try { localStorage.removeItem("flugbuch:titleConfig"); } catch {}
  };

  useEffect(() => {
    readServiceUrgency().then(setServiceUrgency);
  }, []);

  useEffect(() => {
    if (!isWide) return; // only relevant for the wide side-by-side layout
    const measure = () => {
      if (photoCardRef.current) setPhotoTopOffset(photoCardRef.current.getBoundingClientRect().top);
    };
    measure();
    window.addEventListener("resize", measure);
    // iOS Safari's address bar/toolbar showing or hiding changes the
    // effective viewport height without always firing a plain "resize"
    // event — visualViewport's own resize event catches that reliably.
    if (window.visualViewport) window.visualViewport.addEventListener("resize", measure);
    // ResizeObserver reacts to the photo card's actual rendered box
    // changing (image finishing decode, font load, layout shift, etc.)
    // rather than guessing with fixed delays — reliable regardless of how
    // long the photo itself takes to load.
    let ro;
    if (photoCardRef.current && typeof ResizeObserver !== "undefined") {
      ro = new ResizeObserver(measure);
      ro.observe(photoCardRef.current);
    }
    return () => {
      window.removeEventListener("resize", measure);
      if (window.visualViewport) window.visualViewport.removeEventListener("resize", measure);
      if (ro) ro.disconnect();
    };
  }, [isWide, photoUrl]);

  useEffect(() => {
    // Load previously saved photo (stored as a base64 data URL, since blob:
    // URLs from createObjectURL don't survive a reload).
    try {
      const saved = localStorage.getItem("flugbuch:homePhoto");
      if (saved) setPhotoUrl(saved);
    } catch {}
  }, []);

  useEffect(() => {
    readFlightStatsFromStorage().then(({ total, biplace, startSites, endSites, gliders, reisen, hikeFlights }) => {
      setFlightCount(total);
      setBiplaceCount(biplace);
      setStatistikCounts({ startSites, endSites, gliders, biplace, reisen, hikeFlights });
    });
    // Safety net: on a very first load, the IndexedDB migration inside the
    // storage shim (flugbuch:* keys copied over from localStorage) can still
    // be in progress when this first read runs, showing stale/zero counts
    // until some other page (e.g. Reisen) has triggered the migration.
    // Re-check once, shortly after, so Home is correct without needing a
    // visit to another page first.
    const t = setTimeout(() => {
      readFlightStatsFromStorage().then(({ total, biplace, startSites, endSites, gliders, reisen, hikeFlights }) => {
        setFlightCount(total);
        setBiplaceCount(biplace);
        setStatistikCounts({ startSites, endSites, gliders, biplace, reisen, hikeFlights });
      });
    }, 1200);
    return () => clearTimeout(t);
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
        { label: `${flightCount ?? "—"} Flüge` },
        { label: `${biplaceCount ?? "—"} Biplace` },
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
        ...(statistikCounts.hikeFlights ? [{ label: `${statistikCounts.hikeFlights} Hike-Flüge` }] : []),
      ],
      href: "statistik.html",
      ready: true,
    },
    {
      id: "service",
      label: "Ausrüstung",
      icon: "🎒",
      color: "#22c55e",
      glow: "rgba(34,197,94,0.5)",
      stats: (() => {
        const overdueStats = (serviceUrgency.overdue||[]).map(formatServiceStat);
        const nextReserveStat = serviceUrgency.nextReserve ? [formatServiceStat(serviceUrgency.nextReserve)] : [];
        const all = [...overdueStats, ...nextReserveStat];
        return all.length ? all : [{ label: "Alles aktuell" }];
      })(),
      href: "ausruestung.html",
      ready: true,
    },
    {
      id: "reisen",
      label: "Reisen",
      icon: "🧭",
      color: "#f5a623",
      glow: "rgba(245,166,35,0.55)",
      stats: [{ label: `${statistikCounts.reisen ?? "—"} Reisen` }],
      href: "reisen.html",
      ready: true,
    },
  ].filter(t => t.id !== "reisen" || statistikCounts.reisen !== 0);

  return (
    <div style={{
      height: "100dvh",
      overflow: "hidden",
      display: "flex",
      flexDirection: isWide ? "row" : "column",
      background: "#040e20",
      color: "#e8f4fd",
      fontFamily: "-apple-system,BlinkMacSystemFont,sans-serif",
    }}>
      {showSettings && <SettingsOverlay onClose={()=>setShowSettings(false)} />}
      {editingTitle && (
        <TitleEditor
          current={titleCfg || DEFAULT_TITLE_CFG}
          onSave={saveTitleCfg}
          onReset={resetTitleCfg}
          onClose={()=>setEditingTitle(false)}
        />
      )}

      {/* Full-bleed photo: extends to the screen's top/left/right edges
          (no padding, no border, no rounding on those sides) so it reads as
          a true hero image rather than a card floating in the layout —
          only the bottom edge is rounded/bordered, where it meets the rest
          of the page. Title sits bottom-left over it. Still tappable
          anywhere on the image to change the photo — just without the
          former small "Bild ändern" caption spelling that out. */}
      <div style={isWide
        ? { flex: "0 0 42%", display: "flex", alignItems: "center", justifyContent: "center", padding: "20px 28px 28px" }
        : { flex: "1 1 auto", minHeight: 0 }}>
        <input ref={fileRef} type="file" accept="image/*" style={{ display: "none" }} onChange={onPickPhoto} />
        <div
          ref={photoCardRef}
          onClick={() => fileRef.current && fileRef.current.click()}
          style={{
            position: "relative",
            overflow: "hidden",
            height: isWide ? undefined : "100%",
            width: isWide ? "100%" : undefined,
            aspectRatio: isWide ? "3/4" : undefined,
            maxHeight: isWide ? "100%" : undefined,
            borderRadius: isWide ? 20 : 0,
            boxShadow: isWide ? "0 12px 40px rgba(0,0,0,0.5)" : "none",
            background: photoUrl
              ? `#000 url(${photoUrl}) center/cover no-repeat`
              : "linear-gradient(180deg, #4a5260 0%, #3d4552 60%, #333a45 100%)",
            cursor: "pointer",
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
          <div style={{ position: "absolute", left: 0, right: 0, bottom: 0, padding: "16px 20px 10px", background: "linear-gradient(0deg, rgba(0,0,0,0.45) 0%, transparent 100%)" }}>
            <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", gap: 10 }}>
              <button onClick={(e)=>{ e.stopPropagation(); setShowSettings(true); }} title="Einstellungen"
                style={{ background: "rgba(255,255,255,0.22)", border: "1px solid rgba(255,255,255,0.4)", borderRadius: 10, width: 32, height: 32, display: "flex", alignItems: "center", justifyContent: "center", fontSize: 17, cursor: "pointer", boxShadow: "0 2px 6px rgba(0,0,0,0.4)", flexShrink: 0, opacity: 0.8 }}>
                ⚙️
              </button>
              <div onClick={(e)=>{ e.stopPropagation(); setEditingTitle(true); }}
                style={{ fontSize: (titleCfg||DEFAULT_TITLE_CFG).fontSize, fontFamily: (titleCfg||DEFAULT_TITLE_CFG).fontFamily, fontWeight: 800, letterSpacing: -0.5, textShadow: "0 2px 8px rgba(0,0,0,0.6)", textAlign: "center", flex: 1, cursor: "pointer" }}>
                {(titleCfg||DEFAULT_TITLE_CFG).segments.map((seg,i) => <span key={i} style={{ color: seg.color }}>{seg.text}</span>)}
              </div>
              <div style={{ fontSize: 11, color: "rgba(232,244,253,0.55)", fontWeight: 700, textShadow: "0 2px 6px rgba(0,0,0,0.85)", flexShrink: 0 }}>
                v{APP_VERSION}
              </div>
            </div>
            <div style={{ textAlign: "center", fontSize: 9, color: "rgba(255,255,255,0.6)", textShadow: "0 1px 4px rgba(0,0,0,0.85)", marginTop: 3 }}>
              © Claude Mair-Noack
            </div>
          </div>
        </div>
      </div>

      <div style={isWide
        ? { width: 1, background: "rgba(255,255,255,0.08)", margin: "20px 0", flexShrink: 0 }
        : { height: 1, background: "rgba(255,255,255,0.08)", margin: "0 20px", flexShrink: 0 }} />

      {/* Tiles — on phone: stacked, each proportionally sized to fill
          remaining space. On tablet/desktop (isWide): still stacked
          (single column) next to the photo, but each tile has a fixed,
          modest height instead of stretching to fill the available space. */}
      <div style={isWide
        ? { padding: `${photoTopOffset}px 24px 20px`, display: "flex", flexDirection: "column", gap: 12, flex: "1 1 auto", minHeight: 0, overflowY: "auto" }
        : { padding: "10px 20px", display: "flex", flexDirection: "column", gap: 9, flex: "0 0 auto" }}>
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
              flex: isWide ? "0 0 auto" : "0 0 auto",
              height: isWide ? 96 : "calc((100vw - 40px) * 0.3326)",
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
            <div style={{ flex: 1, padding: "8px 14px 8px 4px", minWidth: 0, display: "flex", flexDirection: "column", justifyContent: "center", alignItems: "flex-start", textAlign: "left" }}>
              <div style={{ display: "flex", alignItems: "center", gap: 8, marginBottom: 5 }}>
                <div style={{ fontSize: 16, fontWeight: 700, color: t.ready ? "#e8f4fd" : "rgba(232,244,253,0.6)", textAlign: "left" }}>
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
              <div style={{ display: "flex", flexWrap: "wrap", gap: 6, justifyContent: "flex-start" }}>
                {t.stats.map((s) => (
                  <span
                    key={s.label || s.line1}
                    style={{
                      fontSize: 9,
                      fontWeight: s.color ? 700 : 400,
                      color: s.color || "rgba(232,244,253,0.75)",
                      background: "rgba(255,255,255,0.04)",
                      border: "1px solid rgba(255,255,255,0.06)",
                      borderRadius: s.line2 ? 10 : 20,
                      padding: s.line2 ? "2px 6px" : "2px 6px",
                      display: s.line2 ? "flex" : undefined,
                      flexDirection: s.line2 ? "column" : undefined,
                      alignItems: s.line2 ? "flex-start" : undefined,
                      gap: s.line2 ? 1 : undefined,
                    }}
                  >
                    {s.line2 ? (<>
                      <span>{s.line1}</span>
                      <span style={{ opacity: 0.7, fontSize: 8 }}>{s.line2}</span>
                    </>) : (s.label || s.line1)}
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
