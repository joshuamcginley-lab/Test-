// GET /api/water?lat=..&lon=.. — nearest real-time river gauge and how its current flow compares with the last 14 days.
// Canada: Environment and Climate Change Canada. United States: U.S. Geological Survey. Both are asked and the
// closer gauge wins, which also covers spots near the border. Runs on Cloudflare so the app avoids CORS limits.
import { json } from "../_lib.js";

const ECCC = "https://api.weather.gc.ca/collections/hydrometric-realtime/items";
const USGS = "https://waterservices.usgs.gov/nwis/iv/";
const DAY = 864e5, SPANS = [0.3, 0.7, 1.5];

const iso = t => new Date(t).toISOString().slice(0, 19) + "Z";
function km(aLat, aLon, bLat, bLon) {
  const R = 6371, r = x => x * Math.PI / 180, dLat = r(bLat - aLat), dLon = r(bLon - aLon);
  const h = Math.sin(dLat / 2) ** 2 + Math.cos(r(aLat)) * Math.cos(r(bLat)) * Math.sin(dLon / 2) ** 2;
  return 2 * R * Math.asin(Math.sqrt(h));
}
// "NASHWAAK RIVER AT DURHAM BRIDGE" -> "Nashwaak River at Durham Bridge"
const titleCase = s => String(s).toLowerCase().replace(/\b([a-z])/g, m => m.toUpperCase()).replace(/\b(At|Near|Above|Below|Of|The|And)\b/g, w => w.toLowerCase());
const num = v => (typeof v === "number" && Number.isFinite(v) ? v : typeof v === "string" && v.trim() !== "" && Number.isFinite(+v) ? +v : null);
const bboxAround = (lat, lon, span) => [lon - span, lat - span, lon + span, lat + span].map(v => v.toFixed(3)).join(",");

async function getJson(url, accept = "application/json") {
  const res = await fetch(url, { headers: { accept }, cf: { cacheTtl: 900 } });
  if (res.status === 404) return null; // USGS answers 404 when nothing matches
  if (!res.ok) throw new Error(`gauge service ${res.status}`);
  return res.json();
}

/* ---------- Canada: Environment and Climate Change Canada ---------- */
const eccc = {
  source: "ECCC", units: { q: "m³/s", h: "m" },
  async features(url) { const b = await getJson(url, "application/geo+json, application/json"); return Array.isArray(b?.features) ? b.features : []; },
  async nearest(lat, lon) {
    const since = iso(Date.now() - 6 * 3600e3);
    for (const span of SPANS) {
      const seen = new Map();
      for (const f of await this.features(`${ECCC}?f=json&bbox=${bboxAround(lat, lon, span)}&datetime=${since}/..&limit=3000`)) {
        const p = f.properties || {}, id = p.STATION_NUMBER, c = f.geometry?.coordinates;
        if (!id || !Array.isArray(c) || seen.has(id)) continue;
        if (num(p.DISCHARGE) == null && num(p.LEVEL) == null) continue;
        seen.set(id, { id, name: titleCase(p.STATION_NAME || id), distKm: km(lat, lon, c[1], c[0]) });
      }
      const best = [...seen.values()].sort((a, b) => a.distKm - b.distKm)[0];
      if (best) return best;
    }
    return null;
  },
  async history(id) {
    const feats = await this.features(`${ECCC}?f=json&STATION_NUMBER=${encodeURIComponent(id)}&datetime=${iso(Date.now() - 14 * DAY)}/..&limit=10000`);
    return feats.map(f => f.properties || {}).map(p => ({ t: Date.parse(p.DATETIME), q: num(p.DISCHARGE), h: num(p.LEVEL) }));
  },
};

/* ---------- United States: U.S. Geological Survey instantaneous values ---------- */
// Discharge is parameter 00060 (ft³/s), gage height 00065 (ft). Missing readings come back as the series' noDataValue.
const usgsSeries = body => Array.isArray(body?.value?.timeSeries) ? body.value.timeSeries : [];
const usgsValues = ts => {
  const none = ts.variable?.noDataValue;
  return (ts.values?.[0]?.value || []).map(v => ({ t: Date.parse(v.dateTime), v: num(v.value) })).filter(o => Number.isFinite(o.t) && o.v != null && o.v !== none && o.v > -999);
};
// USGS names are abbreviated and capitalized: "E GALLATIN R AB WATER RECLAMATION FA NR BOZEMAN MT"
// -> "East Gallatin River above Water Reclamation Fa near Bozeman, MT".
const STATES = new Set("AL AK AZ AR CA CO CT DE DC FL GA HI ID IL IN IA KS KY LA ME MD MA MI MN MS MO MT NE NV NH NJ NM NY NC ND OH OK OR PA RI SC SD TN TX UT VT VA WA WV WI WY PR".split(" "));
const ABBR = { NR: "near", AB: "above", ABV: "above", BL: "below", BLW: "below", AT: "at", R: "River", RV: "River", RIV: "River", CR: "Creek", CK: "Creek", CRK: "Creek",
  BR: "Branch", FK: "Fork", TRIB: "Tributary", LK: "Lake", RES: "Reservoir", STA: "Station", HWY: "Highway", MTN: "Mountain", SPGS: "Springs", "@": "at" };
const DIRS = { N: "North", S: "South", E: "East", W: "West", NF: "North Fork", SF: "South Fork", EF: "East Fork", WF: "West Fork", MF: "Middle Fork" };
function usgsName(raw) {
  const words = String(raw).replace(/,/g, " , ").trim().split(/\s+/);
  let state = null;
  if (STATES.has(words[words.length - 1]?.toUpperCase())) { state = words.pop().toUpperCase(); if (words[words.length - 1] === ",") words.pop(); }
  const out = words.map((w, i) => {
    const up = w.toUpperCase().replace(/\.$/, "");
    if (i === 0 && DIRS[up]) return DIRS[up];
    if (words[i - 1] === "," && STATES.has(up)) return up; // "WASH, DC LITTLE FALLS"
    if (ABBR[up]) return i ? ABBR[up] : ABBR[up].charAt(0).toUpperCase() + ABBR[up].slice(1);
    if (i && /^(NE|NW|SE|SW)$/.test(up)) return up; // "37TH AVE. NE"
    if (i && up === "IN") return "in";
    return w === "," ? "," : w.charAt(0).toUpperCase() + w.slice(1).toLowerCase();
  }).join(" ").replace(/ ,/g, ",").replace(/\b(At|Near|Above|Below|Of|The|And)\b/g, (m, x, i) => i ? m.toLowerCase() : m);
  return (state ? `${out}, ${state}` : out).replace(/,\s*,/g, ",");
}
const usgs = {
  source: "USGS", units: { q: "ft³/s", h: "ft" },
  async nearest(lat, lon) {
    for (const span of SPANS) {
      const body = await getJson(`${USGS}?format=json&bBox=${bboxAround(lat, lon, span)}&parameterCd=00060,00065&siteStatus=active&modifiedSince=PT6H`);
      const seen = new Map();
      for (const ts of usgsSeries(body)) {
        const s = ts.sourceInfo || {}, id = s.siteCode?.[0]?.value, g = s.geoLocation?.geogLocation;
        if (!id || !/^\d{8,15}$/.test(id) || seen.has(id) || num(g?.latitude) == null || num(g?.longitude) == null || !usgsValues(ts).length) continue;
        seen.set(id, { id, name: usgsName(s.siteName || id), distKm: km(lat, lon, g.latitude, g.longitude) });
      }
      const best = [...seen.values()].sort((a, b) => a.distKm - b.distKm)[0];
      if (best) return best;
    }
    return null;
  },
  async history(id) {
    const body = await getJson(`${USGS}?format=json&sites=${encodeURIComponent(id)}&parameterCd=00060,00065&period=P14D`);
    const byTime = new Map();
    for (const ts of usgsSeries(body)) {
      const key = ts.variable?.variableCode?.[0]?.value === "00060" ? "q" : "h";
      for (const o of usgsValues(ts)) { const r = byTime.get(o.t) || { t: o.t, q: null, h: null }; r[key] = o.v; byTime.set(o.t, r); }
    }
    return [...byTime.values()];
  },
};

// Ask both services; the closer gauge wins. One failing doesn't stop the other.
async function nearestGauge(lat, lon) {
  const found = await Promise.allSettled([eccc, usgs].map(async src => { const s = await src.nearest(lat, lon); return s && { ...s, src }; }));
  const ok = found.filter(r => r.status === "fulfilled" && r.value).map(r => r.value);
  if (!ok.length && found.every(r => r.status === "rejected")) throw new Error("no gauge service answered");
  return ok.sort((a, b) => a.distKm - b.distKm)[0] || null;
}

export async function onRequestGet({ request }) {
  const u = new URL(request.url);
  const lat = num(u.searchParams.get("lat")), lon = num(u.searchParams.get("lon"));
  if (lat == null || lon == null || Math.abs(lat) > 90 || Math.abs(lon) > 180) return json({ error: "Pass lat and lon." }, 400);

  // Cache per ~1 km grid cell for 30 minutes.
  const key = new Request(`${u.origin}/api/water?lat=${lat.toFixed(2)}&lon=${lon.toFixed(2)}`);
  const cache = typeof caches !== "undefined" ? caches.default : null;
  const hit = cache && await cache.match(key);
  if (hit) return hit;

  let out;
  try {
    const station = await nearestGauge(lat, lon);
    if (!station) return json({ error: "No real-time river gauge within about 150 km." }, 404);
    const obs = (await station.src.history(station.id))
      .filter(o => Number.isFinite(o.t) && (o.q != null || o.h != null))
      .sort((a, b) => a.t - b.t);
    if (!obs.length) return json({ error: "That gauge has no recent readings." }, 404);

    // Flow (discharge) says more about fishing conditions than stage; fall back to water level.
    const useQ = obs.filter(o => o.q != null).length >= obs.length / 2;
    const series = obs.map(o => ({ t: o.t, v: useQ ? o.q : o.h })).filter(o => o.v != null);
    const last = series[series.length - 1];
    const sorted = series.map(o => o.v).sort((a, b) => a - b);
    const below = sorted.filter(v => v < last.v).length;
    const pct = sorted.length > 1 ? below / (sorted.length - 1) : 0.5;
    const dayAgo = series.reduce((best, o) => Math.abs(o.t - (last.t - DAY)) < Math.abs(best.t - (last.t - DAY)) ? o : best, series[0]);
    const change = dayAgo.v ? (last.v - dayAgo.v) / Math.abs(dayAgo.v) : 0;
    const latest = obs[obs.length - 1];
    // 4-hour averages for the app's sparkline (about 84 points over 14 days).
    const buckets = new Map();
    for (const o of series) { const k = Math.floor(o.t / (4 * 3600e3)); const b = buckets.get(k) || { t: k * 4 * 3600e3, s: 0, n: 0 }; b.s += o.v; b.n++; buckets.set(k, b); }
    const spark = [...buckets.values()].sort((a, b) => a.t - b.t).map(b => [b.t, Math.round(b.s / b.n * 1000) / 1000]);

    out = {
      source: station.src.source,
      station: { id: station.id, name: station.name, distKm: Math.round(station.distKm) },
      time: new Date(last.t).toISOString(),
      level: latest.h, discharge: latest.q,
      measure: useQ ? "discharge" : "level", unit: station.src.units[useQ ? "q" : "h"],
      value: last.v, pct14: Math.round(pct * 100) / 100,
      status: pct >= 0.8 ? "High" : pct <= 0.2 ? "Low" : "Normal",
      trend: change > 0.05 ? "rising" : change < -0.05 ? "falling" : "steady",
      days: Math.round((last.t - series[0].t) / DAY),
      min: sorted[0], max: sorted[sorted.length - 1], series: spark,
    };
  } catch (e) {
    return json({ error: "Couldn't reach the river gauge service." }, 502);
  }
  const res = new Response(JSON.stringify(out), { headers: { "content-type": "application/json", "cache-control": "public, max-age=1800" } });
  if (cache) await cache.put(key, res.clone());
  return res;
}
