// GET /api/sample — the sample season with real historical weather, pressure, wind and rain added to every trip,
// so the demo shows what fishr does with a full season. Looked up once from the Open-Meteo archive, then saved in R2.
import { json } from "../_lib.js";

const VERSION = "sample/enriched-v1.json";
const VARS = "temperature_2m,weather_code,pressure_msl,wind_speed_10m,wind_direction_10m,precipitation";
// Approximate public locations for the sample's waters; anything else uses Fredericton (regional weather is close enough).
const WATERS = {
  "Keswick River": [45.995, -66.835], "Nashwaak River": [46.11, -66.62], "Saint John River": [45.99, -67.24],
  "Oromocto Lake": [45.66, -66.98], "Belleisle Bay": [45.6, -65.95], "Washademoak Lake": [45.87, -65.86],
  "Mactaquac Headpond": [45.975, -66.87], "French Lake": [45.9, -66.25], "Tay River": [46.15, -66.66],
  "Jemseg River": [45.83, -66.1], "Oromocto River": [45.85, -66.48], "Nashwaaksis Stream": [46.02, -66.68],
  "Peniac Stream": [46.03, -66.53], "Cains River": [46.55, -65.93],
};
const HOME = [45.96, -66.64];
const PERIOD_MID = { Morning: 8, Midday: 13, Afternoon: 16, Evening: 19 };
const COMPASS = ["N", "NE", "E", "SE", "S", "SW", "W", "NW"];
const r1 = v => Math.round(v * 10) / 10;
const skyName = c => c == null ? null : c <= 1 ? "Sunny" : c <= 48 ? "Overcast" : "Rain";
const ymd = t => new Date(t).toISOString().slice(0, 10);
function hourOf(s) {
  if (s.start) { const [a, b] = s.start.split(":").map(Number); return Math.round(a + b / 60); }
  return PERIOD_MID[s.period] ?? 12;
}

async function enrich(trips) {
  const groups = new Map();
  for (const s of trips) {
    const [lat, lon] = s.lat != null ? [s.lat, s.lon] : WATERS[s.water] || HOME;
    const k = `${lat.toFixed(2)},${lon.toFixed(2)}`;
    if (!groups.has(k)) groups.set(k, { lat, lon, trips: [] });
    groups.get(k).trips.push(s);
  }
  for (const g of groups.values()) {
    const dates = g.trips.map(s => s.date).sort();
    const start = ymd(Date.parse(dates[0] + "T12:00:00Z") - 2 * 864e5), end = dates[dates.length - 1];
    const res = await fetch(`https://archive-api.open-meteo.com/v1/archive?latitude=${g.lat}&longitude=${g.lon}&start_date=${start}&end_date=${end}&hourly=${VARS}&timezone=America%2FMoncton`);
    if (!res.ok) throw new Error(`archive ${res.status}`);
    const h = (await res.json()).hourly;
    for (const s of g.trips) {
      const hr = hourOf(s), i = h.time.indexOf(`${s.date}T${String(hr).padStart(2, "0")}:00`);
      if (i < 0 || h.temperature_2m[i] == null) continue;
      const p = h.pressure_msl[i], p3 = i >= 3 ? h.pressure_msl[i - 3] : null, dp = p != null && p3 != null ? p - p3 : null;
      const rain48 = h.precipitation.slice(Math.max(0, i - 47), i + 1).reduce((a, v) => a + (v || 0), 0);
      s.wx = {
        t: r1(h.temperature_2m[i]), code: h.weather_code[i], sky: skyName(h.weather_code[i]),
        p: p == null ? null : Math.round(p), dp3: dp == null ? null : r1(dp),
        trend: dp == null ? null : dp >= 1 ? "Rising" : dp <= -1 ? "Falling" : "Steady",
        wind: h.wind_speed_10m[i] == null ? null : Math.round(h.wind_speed_10m[i]),
        windDir: h.wind_direction_10m[i] == null ? "" : COMPASS[Math.round(h.wind_direction_10m[i] / 45) % 8],
        rain48: r1(rain48), at: `${s.date}T${String(hr).padStart(2, "0")}:00`, source: "historical",
      };
    }
  }
  return trips;
}

export async function onRequestGet({ request, env }) {
  const saved = env.CATCHES && await env.CATCHES.get(VERSION);
  if (saved) return new Response(saved.body, { headers: { "content-type": "application/json", "cache-control": "public, max-age=3600" } });

  const base = await env.ASSETS.fetch(new URL("/sample.json", request.url));
  if (!base.ok) return json({ error: "Sample not found." }, 500);
  const trips = await base.json();
  try {
    const out = JSON.stringify(await enrich(trips));
    if (env.CATCHES) await env.CATCHES.put(VERSION, out, { httpMetadata: { contentType: "application/json" } });
    return new Response(out, { headers: { "content-type": "application/json", "cache-control": "public, max-age=3600" } });
  } catch (e) {
    // Weather archive unavailable: serve the plain sample and try again next time.
    return new Response(JSON.stringify(trips), { headers: { "content-type": "application/json", "cache-control": "no-store" } });
  }
}
