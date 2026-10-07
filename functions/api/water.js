// GET /api/water?lat=..&lon=.. — nearest real-time river gauge (Environment and Climate Change Canada)
// and how its current flow compares with the last 14 days. Runs on Cloudflare so the app avoids CORS limits.
import { json } from "../_lib.js";

const BASE = "https://api.weather.gc.ca/collections/hydrometric-realtime/items";
const DAY = 864e5;

const iso = t => new Date(t).toISOString().slice(0, 19) + "Z";
function km(aLat, aLon, bLat, bLon) {
  const R = 6371, r = x => x * Math.PI / 180, dLat = r(bLat - aLat), dLon = r(bLon - aLon);
  const h = Math.sin(dLat / 2) ** 2 + Math.cos(r(aLat)) * Math.cos(r(bLat)) * Math.sin(dLon / 2) ** 2;
  return 2 * R * Math.asin(Math.sqrt(h));
}
// "NASHWAAK RIVER AT DURHAM BRIDGE" -> "Nashwaak River at Durham Bridge"
const titleCase = s => String(s).toLowerCase().replace(/\b([a-z])/g, m => m.toUpperCase()).replace(/\b(At|Near|Above|Below|Of|The|And)\b/g, w => w.toLowerCase());
const num = v => (typeof v === "number" && Number.isFinite(v) ? v : typeof v === "string" && v.trim() !== "" && Number.isFinite(+v) ? +v : null);

async function getFeatures(url) {
  const res = await fetch(url, { headers: { accept: "application/geo+json, application/json" }, cf: { cacheTtl: 900 } });
  if (!res.ok) throw new Error(`gauge service ${res.status}`);
  const body = await res.json();
  return Array.isArray(body.features) ? body.features : [];
}

async function nearestStation(lat, lon) {
  const since = iso(Date.now() - 6 * 3600e3);
  for (const span of [0.3, 0.7, 1.5]) {
    const bbox = [lon - span, lat - span, lon + span, lat + span].map(v => v.toFixed(3)).join(",");
    const feats = await getFeatures(`${BASE}?f=json&bbox=${bbox}&datetime=${since}/..&limit=3000`);
    const seen = new Map();
    for (const f of feats) {
      const p = f.properties || {}, id = p.STATION_NUMBER, c = f.geometry?.coordinates;
      if (!id || !Array.isArray(c) || seen.has(id)) continue;
      if (num(p.DISCHARGE) == null && num(p.LEVEL) == null) continue;
      seen.set(id, { id, name: titleCase(p.STATION_NAME || id), distKm: km(lat, lon, c[1], c[0]) });
    }
    const best = [...seen.values()].sort((a, b) => a.distKm - b.distKm)[0];
    if (best) return best;
  }
  return null;
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
    const station = await nearestStation(lat, lon);
    if (!station) return json({ error: "No real-time river gauge within about 150 km." }, 404);
    const feats = await getFeatures(`${BASE}?f=json&STATION_NUMBER=${encodeURIComponent(station.id)}&datetime=${iso(Date.now() - 14 * DAY)}/..&limit=10000`);
    const obs = feats.map(f => f.properties || {})
      .map(p => ({ t: Date.parse(p.DATETIME), q: num(p.DISCHARGE), h: num(p.LEVEL) }))
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
      station: { id: station.id, name: station.name, distKm: Math.round(station.distKm) },
      time: new Date(last.t).toISOString(),
      level: latest.h, discharge: latest.q,
      measure: useQ ? "discharge" : "level", unit: useQ ? "m³/s" : "m",
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
