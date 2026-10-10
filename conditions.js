"use strict";
/* Conditions: weather, barometric pressure, wind and recent rain from Open-Meteo (free, no key),
   plus the nearest river gauge from Environment Canada via /api/water. Fills the trip form
   automatically and stores the readings on each trip as `wx` and `flow`. Uses globals from app.js. */

const WX_VARS = "temperature_2m,weather_code,pressure_msl,wind_speed_10m,wind_direction_10m,precipitation";
const COMPASS = ["N", "NE", "E", "SE", "S", "SW", "W", "NW"];
const compass = deg => deg == null ? "" : COMPASS[Math.round(((deg % 360) + 360) % 360 / 45) % 8];
const ymd = d => `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
const skyName = c => c == null ? null : c <= 1 ? "Sunny" : c <= 48 ? "Overcast" : "Rain";
const pressureTrend = dp => dp == null ? null : dp >= 1 ? "Rising" : dp <= -1 ? "Falling" : "Steady";
const PERIOD_MID = { Morning: 8, Midday: 13, Afternoon: 16, Evening: 19 };

// Hourly weather for a place and time. Recent and future dates use the forecast API; older ones the archive.
async function fetchWeather(lat, lon, date, hour) {
  const day = new Date(date + "T12:00:00"), daysAgo = (Date.now() - day) / 864e5;
  const from = ymd(new Date(day - 2 * 864e5));
  const base = daysAgo > 60 ? "https://archive-api.open-meteo.com/v1/archive" : "https://api.open-meteo.com/v1/forecast";
  const res = await fetch(`${base}?latitude=${lat.toFixed(3)}&longitude=${lon.toFixed(3)}&hourly=${WX_VARS}&start_date=${from}&end_date=${date}&timezone=auto`);
  if (!res.ok) throw new Error("weather " + res.status);
  const h = (await res.json()).hourly;
  const i = h.time.indexOf(`${date}T${String(Math.min(23, Math.max(0, Math.round(hour)))).padStart(2, "0")}:00`);
  if (i < 0 || h.temperature_2m[i] == null) throw new Error("no weather for that hour");
  const p = h.pressure_msl[i], p3 = i >= 3 ? h.pressure_msl[i - 3] : null;
  const rain48 = h.precipitation.slice(Math.max(0, i - 47), i + 1).reduce((a, v) => a + (v || 0), 0);
  return {
    t: r(h.temperature_2m[i], 1), code: h.weather_code[i], sky: skyName(h.weather_code[i]),
    p: p == null ? null : Math.round(p), dp3: p != null && p3 != null ? r(p - p3, 1) : null,
    trend: p != null && p3 != null ? pressureTrend(p - p3) : null,
    wind: h.wind_speed_10m[i] == null ? null : Math.round(h.wind_speed_10m[i]), windDir: compass(h.wind_direction_10m[i]),
    rain48: r(rain48, 1), at: `${date}T${String(Math.round(hour)).padStart(2, "0")}:00`,
  };
}

// Nearest river gauge and how today's flow compares with the last two weeks.
// A gauge the angler picked for an area applies within this distance of where they picked it.
const PICK_KM = 15;
const distKm = (a, b) => { const R = 6371, r = x => x * Math.PI / 180, dLat = r(b.lat - a.lat), dLon = r(b.lon - a.lon);
  return 2 * R * Math.asin(Math.sqrt(Math.sin(dLat / 2) ** 2 + Math.cos(r(a.lat)) * Math.cos(r(b.lat)) * Math.sin(dLon / 2) ** 2)); };
const gaugePicks = () => Array.isArray(state.settings.gauges) ? state.settings.gauges.filter(g => g && Number.isFinite(g.lat) && Number.isFinite(g.lon) && /^(ECCC|USGS):[0-9A-Z]{7,15}$/.test(g.station)) : [];
const gaugePickFor = (lat, lon) => gaugePicks().map(g => ({ g, d: distKm(g, { lat, lon }) })).filter(x => x.d <= PICK_KM).sort((a, b) => a.d - b.d)[0]?.g || null;
// Remember a gauge for the area around lat/lon (null = back to the closest). Replaces any pick for the same area.
function setGaugePick(lat, lon, station, name) {
  const rest = gaugePicks().filter(g => distKm(g, { lat, lon }) > PICK_KM);
  state.settings.gauges = station ? [...rest, { lat: r(lat, 3), lon: r(lon, 3), station, name: String(name || "").slice(0, 80) }].slice(-20) : rest;
  save();
}
async function fetchWater(lat, lon) {
  if (location.protocol === "file:") return null;
  const pick = gaugePickFor(lat, lon), base = `/api/water?lat=${lat.toFixed(3)}&lon=${lon.toFixed(3)}`;
  let res = await fetch(pick ? `${base}&station=${pick.station}` : base);
  if (!res.ok && pick) res = await fetch(base); // the picked gauge is offline: fall back to the closest
  if (!res.ok) return null;
  const d = await res.json();
  if (!d || !d.station || !["High", "Normal", "Low"].includes(d.status)) return null;
  const series = Array.isArray(d.series) ? d.series.filter(x => Array.isArray(x) && Number.isFinite(x[0]) && Number.isFinite(x[1])).slice(-120) : [];
  return { source: d.source === "USGS" ? "USGS" : "ECCC", picked: !!d.picked, station: String(d.station.name).slice(0, 80), stationId: String(d.station.id).slice(0, 20), distKm: d.station.distKm, status: d.status, trend: d.trend, pct: d.pct14, value: d.value, unit: d.unit, measure: d.measure, at: d.time, min: d.min, max: d.max, series };
}

/* ---------- where to look up conditions ---------- */
function coordsForWater(name) {
  if (!name) return null;
  const hits = state.sessions.filter(s => s.water && s.water.toLowerCase() === name.toLowerCase() && s.lat != null);
  return hits.length ? { lat: hits[hits.length - 1].lat, lon: hits[hits.length - 1].lon } : null;
}
function knownLocation(waterName) {
  return pinned || coordsForWater(waterName) || state.settings.home || null;
}
function askDevice() {
  return new Promise(res => {
    if (!navigator.geolocation) return res(null);
    navigator.geolocation.getCurrentPosition(p => {
      const c = { lat: r(p.coords.latitude, 3), lon: r(p.coords.longitude, 3) };
      state.settings.home = c; save(); res(c);
    }, () => res(null), { timeout: 12000, maximumAge: 600000 });
  });
}
const tripHourOf = (date, start, period) => start ? hourOf(start) : date === ymd(new Date()) ? new Date().getHours() : PERIOD_MID[period] ?? 12;

/* ---------- trip form ---------- */
let formCond = { wx: null, flow: null };
function condChips(wx, flow) {
  const c = [];
  if (wx) {
    c.push(`${fmtT(wx.t)}${wx.sky ? ` · ${wx.sky.toLowerCase()}` : ""}`);
    if (wx.p) c.push(`${wx.p} hPa${wx.trend ? ` ${wx.trend === "Rising" ? "↑" : wx.trend === "Falling" ? "↓" : "→"} ${wx.trend.toLowerCase()}` : ""}`);
    if (wx.wind != null) c.push(`wind ${wx.wind} km/h ${wx.windDir}`);
    if (wx.rain48 != null) c.push(wx.rain48 >= 0.5 ? `${wx.rain48} mm rain, last 48 h` : "dry last 48 h");
  }
  if (flow) c.push(`${flow.station}: ${flow.status.toLowerCase()} water, ${flow.trend}`);
  return c;
}
function showFormChips() {
  const chips = condChips(formCond.wx, formCond.flow);
  $("wxChips").innerHTML = chips.map(t => `<span class="wx-chip">${esc(t)}</span>`).join("");
  $("fillWx").textContent = chips.length ? "↻ Refresh conditions" : "✦ Auto-fill conditions";
}
function applyToForm(wx, flow) {
  if (wx && $("fTlo").value === "") $("fTlo").value = tOut(r(wx.t, 0));
  const on = new Set([...$("segCond").querySelectorAll('[aria-pressed="true"]')].map(b => b.dataset.v));
  if (wx?.sky && !on.has("Sunny") && !on.has("Overcast") && !on.has("Rain")) on.add(wx.sky);
  if (wx?.wind != null) { if (wx.wind >= 20) on.add("Windy"); else if (wx.wind <= 5) on.add("Calm"); }
  if (flow?.status === "High") on.add("High water");
  if (flow?.status === "Low") on.add("Low water");
  segSet($("segCond"), [...on]);
}
async function fillConditions(allowPrompt) {
  const date = $("fDate").value; if (!date) return;
  let where = knownLocation($("fWaterIn").value.trim());
  if (!where && allowPrompt) { $("wxText").textContent = "Finding you to fill in the weather…"; where = await askDevice(); }
  if (!where) { $("wxText").textContent = allowPrompt ? "No location, so type the temperature. A trip needs one to count toward your guide." : ""; return; }
  if (!navigator.onLine) { $("wxText").textContent = "No signal. Conditions can be filled in later from Settings."; return; }
  $("wxText").textContent = "Pulling conditions…";
  const hour = tripHourOf(date, $("fStart").value, null);
  const recent = (Date.now() - new Date(date + "T12:00:00")) / 864e5 <= 2;
  const [wx, flow] = await Promise.all([
    fetchWeather(where.lat, where.lon, date, hour).catch(() => null),
    recent ? fetchWater(where.lat, where.lon).catch(() => null) : Promise.resolve(null),
  ]);
  if (flow) delete flow.series;
  formCond = { wx: wx || formCond.wx, flow: flow || formCond.flow };
  applyToForm(wx, flow);
  showFormChips();
  $("wxText").textContent = wx || flow ? "" : "Couldn't reach the weather service. Type the temperature instead.";
}
// Called by openSheet: show stored readings, or fetch quietly for a new trip when the location is already known.
function onSheetOpen(s) {
  formCond = { wx: s?.wx || null, flow: s?.flow || null };
  $("wxText").textContent = ""; showFormChips();
  if (s) return;
  if (knownLocation("")) { fillConditions(false); return; }
  // A new trip and fishr doesn't know where you are: ask once, so the weather fills itself in and the trip counts
  // toward Guide. Later trips use the saved spot; "Auto-fill conditions" asks again any time.
  let asked = false; try { asked = localStorage.getItem(LOC_ASKED) === "1"; localStorage.setItem(LOC_ASKED, "1"); } catch (e) {}
  if (!asked) fillConditions(true);
}
const LOC_ASKED = "fishr.locAsked";
// A trip's temperature from its weather, when none was typed: that's what Guide counts and compares.
function tempFromWx(s) { if (s.tempLow == null && s.wx?.t != null) s.tempLow = s.tempHigh = r(s.wx.t, 0); }
// After saving a trip with no weather (no signal, or no location yet), fill it in quietly once fishr knows where.
async function fillTripLater(id) {
  const s0 = state.sessions.find(s => s.id === id);
  if (demo || !s0 || s0.wx || !navigator.onLine) return false;
  const where = (s0.lat != null ? { lat: s0.lat, lon: s0.lon } : null) || coordsForWater(s0.water) || state.settings.home;
  if (!where) return false;
  const wx = await fetchWeather(where.lat, where.lon, s0.date, tripHourOf(s0.date, s0.start, s0.period)).catch(() => null);
  const s = !demo && state.sessions.find(x => x.id === id);
  if (!wx || !s || s.updatedAt !== s0.updatedAt || s.wx) return false; // deleted, edited or filled meanwhile
  s.wx = wx; tempFromWx(s); s.updatedAt = new Date().toISOString();
  save(); render(); return true;
}
$("fillWx").onclick = () => fillConditions(true);
$("fWaterIn").addEventListener("change", () => { if (!formCond.wx && coordsForWater($("fWaterIn").value.trim())) fillConditions(false); });
["fDate", "fStart"].forEach(id => $(id).addEventListener("change", () => { if (formCond.wx) { formCond = { wx: null, flow: null }; showFormChips(); fillConditions(false); } }));

/* ---------- add weather to past trips ---------- */
$("backfillWx").onclick = async () => {
  const msg = $("backfillMsg"); msg.hidden = false;
  if (demo) exitSample(); // this works on the person's own trips
  const todo = state.sessions.filter(s => !s.wx && s.date <= ymd(new Date()));
  if (!todo.length) { msg.textContent = "Every trip already has weather."; return; }
  let home = state.settings.home;
  if (!home && todo.some(s => s.lat == null && !coordsForWater(s.water))) { msg.textContent = "Locating you, for trips without a pinned spot…"; home = await askDevice(); }
  let done = 0, failed = 0;
  for (const s of todo) {
    const where = (s.lat != null ? { lat: s.lat, lon: s.lon } : null) || coordsForWater(s.water) || home;
    if (!where) { failed++; continue; }
    msg.textContent = `Adding weather… ${done + failed + 1} of ${todo.length}`;
    try { s.wx = await fetchWeather(where.lat, where.lon, s.date, tripHourOf(s.date, s.start, s.period)); tempFromWx(s); done++; }
    catch (e) { failed++; }
  }
  save(); render();
  msg.textContent = `Added weather to ${done} trip${done === 1 ? "" : "s"}.${failed ? ` ${failed} couldn't be looked up (no location or no signal).` : ""} Pressure and wind now show in Insights and feed your guide.`;
};
