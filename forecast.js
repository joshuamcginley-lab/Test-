"use strict";
/* Fishing forecast: ranks your waters for a given temperature, time, date and sky
   by weighting every past trip by how similar its conditions were. Runs on the phone.
   Uses globals from app.js (state, fishOf, avgT, isPeriod, fmt helpers). */

const MIN_TRIPS = 10;            // trips with a temperature before advice unlocks
const PERIOD_HOUR = { Morning: 8, Midday: 13, Afternoon: 16.5, Evening: 19.5 };
const hourOf = t => { const [a, b] = t.split(":").map(Number); return a + b / 60; };
function tripHour(s) {
  if (s.start) return s.end ? (hourOf(s.start) + hourOf(s.end)) / 2 : hourOf(s.start);
  const p = isPeriod(s); return p ? PERIOD_HOUR[p] : null;
}
const dayOfYear = iso => { const d = new Date(iso + "T12:00:00"); return Math.round((d - new Date(d.getFullYear(), 0, 1)) / 864e5); };
const gauss = (d, sd) => Math.exp(-0.5 * (d / sd) ** 2);
const skyOf = s => (s.conditions || []).includes("Rain") ? "Rain" : (s.conditions || []).includes("Overcast") ? "Overcast" : null;

function similarity(s, q) {
  const t = avgT(s);
  const wT = t == null ? 0.35 : gauss(t - q.temp, 3.5);
  const h = tripHour(s);
  const wH = h == null ? 0.5 : gauss(Math.min(Math.abs(h - q.hour), 24 - Math.abs(h - q.hour)), 2.2);
  let dd = Math.abs(dayOfYear(s.date) - q.doy); dd = Math.min(dd, 365 - dd);
  const wS = 0.3 + 0.7 * gauss(dd, 40);
  const sky = skyOf(s);
  const wC = q.sky && sky ? (sky === q.sky || (q.sky !== "Clear" && sky !== "Clear") ? 1.25 : 0.8) : 1;
  return wT * wH * wS * wC;
}

function rankWaters(q) {
  const trips = state.sessions.filter(s => s.water);
  const scored = trips.map(s => ({ s, w: similarity(s, q), f: fishOf(s) }));
  const totW = scored.reduce((a, x) => a + x.w, 0) || 1;
  const globalRate = scored.reduce((a, x) => a + x.w * x.f, 0) / totW;
  const byWater = new Map();
  for (const x of scored) { if (!byWater.has(x.s.water)) byWater.set(x.s.water, []); byWater.get(x.s.water).push(x); }
  const K = 2; // pulls thin evidence toward your overall average
  const rows = [...byWater].map(([water, xs]) => {
    const W = xs.reduce((a, x) => a + x.w, 0), W2 = xs.reduce((a, x) => a + x.w * x.w, 0);
    const fishW = xs.reduce((a, x) => a + x.w * x.f, 0), skunkW = xs.reduce((a, x) => a + x.w * (x.f ? 0 : 1), 0);
    const neff = W2 ? W * W / W2 : 0;
    const similar = xs.filter(x => x.w >= 0.2).sort((a, b) => b.w - a.w);
    return { water, est: (fishW + K * globalRate) / (W + K), raw: W ? fishW / W : 0, skunk: W ? skunkW / W : 0, neff, W, trips: xs.length, similar, xs };
  }).filter(r => r.trips >= 2);
  rows.sort((a, b) => b.est - a.est);
  const sim = scored.filter(x => x.w >= 0.2);
  return { rows, globalRate, nSimilar: sim.length, skunkSimilar: sim.length ? sim.filter(x => !x.f).length / sim.length : 0, anySeason: scored.some(x => { let dd = Math.abs(dayOfYear(x.s.date) - q.doy); return Math.min(dd, 365 - dd) <= 30; }) };
}

function bestOf(xs, key) {
  const t = {};
  for (const x of xs) for (const c of x.s.catches || []) { const k = key(c, x.s); if (k) t[k] = (t[k] || 0) + x.w * (+c.count || 0); }
  return Object.entries(t).sort((a, b) => b[1] - a[1])[0]?.[0] || null;
}
function bestSpot(xs) {
  const t = {};
  for (const x of xs) if (x.s.spot) t[x.s.spot] = (t[x.s.spot] || 0) + x.w * (x.f + 0.2);
  return Object.entries(t).sort((a, b) => b[1] - a[1])[0]?.[0] || null;
}
const conf = n => n >= 5 ? ["High", "go"] : n >= 2.5 ? ["Medium", "info"] : ["Low", "no"];
const clock = h => { const hh = Math.floor(h) % 24, mm = Math.round((h - Math.floor(h)) * 60); return fmtTime(`${String(hh).padStart(2, "0")}:${String(mm).padStart(2, "0")}`); };

/* ---------- weather (Open-Meteo, free, no key) ---------- */
let wx = null; // { lat, lon, current:{temp,sky}, hourly:[{time:Date, temp, sky}] }
const skyFromCode = c => c == null ? null : c <= 1 ? "Clear" : c <= 48 ? "Overcast" : "Rain";
function weatherSpot() {
  const pins = state.sessions.filter(s => s.lat != null);
  if (!pins.length) return null;
  return { lat: pins.reduce((a, s) => a + s.lat, 0) / pins.length, lon: pins.reduce((a, s) => a + s.lon, 0) / pins.length };
}
async function loadWeather(useGps) {
  const msg = $("aWeatherMsg");
  let where = null;
  if (useGps && navigator.geolocation) {
    msg.textContent = "Locating…";
    where = await new Promise(res => navigator.geolocation.getCurrentPosition(p => res({ lat: p.coords.latitude, lon: p.coords.longitude }), () => res(null), { timeout: 12000, maximumAge: 600000 }));
  }
  where ??= weatherSpot();
  if (!where) { msg.textContent = "Allow location, or pin a spot on a trip, to pull the weather. You can also type the temperature."; return; }
  msg.textContent = "Syncing live conditions…";
  try {
    const u = `https://api.open-meteo.com/v1/forecast?latitude=${where.lat.toFixed(3)}&longitude=${where.lon.toFixed(3)}&current=temperature_2m,weather_code&hourly=temperature_2m,weather_code&forecast_days=2&timezone=auto`;
    const d = await (await fetch(u)).json();
    wx = {
      ...where, current: { temp: d.current.temperature_2m, sky: skyFromCode(d.current.weather_code) },
      hourly: d.hourly.time.map((t, i) => ({ time: new Date(t), temp: d.hourly.temperature_2m[i], sky: skyFromCode(d.hourly.weather_code[i]) })),
    };
    const now = new Date();
    $("aTemp").value = tOut(r(wx.current.temp, 0));
    $("aTime").value = `${String(now.getHours()).padStart(2, "0")}:${String(now.getMinutes()).padStart(2, "0")}`;
    $("aDate").value = isoDate(now);
    segSet($("aSky"), [wx.current.sky]);
    msg.textContent = `Live conditions synced at ${fmtTime($("aTime").value)}.`;
    renderAdvice();
  } catch (e) { msg.textContent = "Couldn't reach the weather service. Type the temperature instead."; }
}
const isoDate = d => `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;

// Best window in the next ~30 hours of daylight-ish fishing hours, from the hourly forecast.
function bestWindow() {
  if (!wx) return null;
  const now = Date.now(), hrs = wx.hourly.filter(h => h.time.getTime() >= now - 36e5 && h.time.getTime() <= now + 30 * 36e5 && h.time.getHours() >= 5 && h.time.getHours() <= 21);
  if (!hrs.length) return null;
  const scored = hrs.map(h => { const q = { temp: h.temp, hour: h.time.getHours() + 0.5, doy: dayOfYear(isoDate(h.time)), sky: h.sky }; const top = rankWaters(q).rows.filter(x => x.W >= 0.6 && x.neff >= 1.5)[0]; return { h, top }; }).filter(x => x.top);
  if (!scored.length) return null;
  const peak = scored.reduce((a, b) => b.top.est > a.top.est ? b : a);
  const i = scored.indexOf(peak); let lo = i, hi = i;
  const ok = x => x && x.top.water === peak.top.water && x.top.est >= peak.top.est * 0.85 && Math.abs(x.h.time - scored[lo].h.time) < 6 * 36e5;
  while (ok(scored[lo - 1]) && scored[lo].h.time - scored[lo - 1].h.time === 36e5) lo--;
  while (ok(scored[hi + 1]) && scored[hi + 1].h.time - scored[hi].h.time === 36e5) hi++;
  const a = scored[lo].h, b = scored[hi].h, temps = scored.slice(lo, hi + 1).map(x => x.h.temp);
  const day = a.time.toDateString() === new Date().toDateString() ? "Today" : "Tomorrow";
  return { day, from: a.time.getHours(), to: b.time.getHours() + 1, water: peak.top.water, est: peak.top.est, tLo: Math.min(...temps), tHi: Math.max(...temps) };
}

/* ---------- render ---------- */
function renderAdvice() {
  const box = $("advice"); if (!box) return;
  const withTemp = state.sessions.filter(s => avgT(s) != null).length;
  if (withTemp < MIN_TRIPS) {
    box.innerHTML = `<div class="verdict locked"><span class="chip info">Training</span><h3>Your model needs ${MIN_TRIPS - withTemp} more trip${MIN_TRIPS - withTemp === 1 ? "" : "s"} with a temperature</h3><p>Once your workspace has ${MIN_TRIPS} trips with a temperature, Copilot tells you where to fish for the conditions you're in, and when. Skunks count. They teach it what doesn't work.</p><div class="meter"><span style="width:${withTemp / MIN_TRIPS * 100}%"></span></div><p class="label">${withTemp} of ${MIN_TRIPS}</p></div>`;
    return;
  }
  const tv = $("aTemp").value, tm = $("aTime").value, dt = $("aDate").value;
  if (tv === "" || !tm || !dt) { box.innerHTML = `<p class="status">Tap “Use current weather” or enter a temperature and time.</p>`; return; }
  const q = { temp: tIn(Number(tv)), hour: hourOf(tm), doy: dayOfYear(dt), sky: $("aSky").querySelector('[aria-pressed="true"]')?.dataset.v || null };
  const res = rankWaters(q), rows = res.rows.filter(x => x.W >= 0.6 && x.neff >= 1);  // enough similar evidence to judge
  const top = rows[0];
  const when = `${fmtT(q.temp)} at ${fmtTime(tm)}${q.sky ? `, ${q.sky.toLowerCase()}` : ""}`;
  let html = "";
  if (!top) {
    html = `<div class="verdict"><span class="chip info">No match</span><h3>Nothing in your log looks like ${esc(when)}</h3><p>Fish somewhere new and log it. That's how the model learns these conditions.</p></div>`;
  } else {
    const [cl, cc] = conf(top.neff), simTop = top.similar.length ? top.similar : top.xs.sort((a, b) => b.w - a.w);
    const lure = bestOf(simTop, c => c.lure), spot = bestSpot(simTop), species = bestOf(simTop, c => c.species);
    const nSim = top.similar.length, skunks = top.similar.filter(x => !x.f).length;
    const slow = res.skunkSimilar >= 0.5 && res.nSimilar >= 3;
    const tough = slow && (top.skunk >= 0.5 || top.est < 1);  // even the best option is weak
    const evidence = nSim ? `On ${nSim} similar trip${nSim === 1 ? "" : "s"} there you caught ${top.similar.reduce((a, x) => a + x.f, 0)} fish and got skunked ${skunks === 0 ? "none of the time" : skunks === nSim ? "every time" : `${skunks} time${skunks === 1 ? "" : "s"}`}.` : `You've fished it ${top.trips} times, but never in conditions this close, so treat this as a lean.`;
    html += `<div class="verdict${slow ? " slow" : ""}">
      <div class="v-top"><span class="chip ${cc}">${cl} confidence</span><span class="label">${esc(when)}</span></div>
      ${tough ? `<h3>Wait if you can</h3>
      <p class="v-say">${Math.round(res.skunkSimilar * 100)}% of your trips in conditions like this were skunks. If you go anyway, <b>${esc(top.water)}</b> is your best bet, at about ${top.est.toFixed(1)} fish. ${evidence}</p>` : `<h3>Fish ${esc(top.water)}</h3>
      <p class="v-say">Expect about <b>${top.est.toFixed(1)} fish</b>${species ? `, mostly ${esc(species.toLowerCase())}` : ""}. ${evidence}</p>`}
      <ul class="v-tips">${spot ? `<li><span class="label">Spot</span>${esc(spot)}</li>` : ""}${lure ? `<li><span class="label">Tie on</span>${esc(lure)}</li>` : ""}</ul>
      ${slow && !tough ? `<p class="v-warn"><b>Heads up:</b> ${Math.round(res.skunkSimilar * 100)}% of your trips in conditions like this were skunks, wherever you went.</p>` : ""}
      ${!res.anySeason ? `<p class="v-warn">You haven't logged trips at this time of year, so this is based on temperature and time of day only.</p>` : ""}
    </div>`;
    const win = bestWindow();
    if (win) html += `<div class="window"><span class="chip go">Best window</span><span><b>${win.day} ${clock(win.from)}–${clock(win.to)}</b> at ${esc(win.water)}, ${win.tLo === win.tHi ? fmtT(r(win.tLo, 0)) : `${tOut(r(win.tLo, 0))}–${fmtT(r(win.tHi, 0))}`} forecast. Expect about ${win.est.toFixed(1)} fish.</span></div>`;
    if (rows.length > 1) html += `<section class="card"><h2>Other predictions</h2><div class="tbl-wrap"><table><tr><th>Water</th><th class="r">Expect</th><th class="r">Skunk risk</th><th class="r">Similar trips</th></tr>${rows.slice(1, 6).map(x => `<tr><td>${esc(x.water)}</td><td class="r">${x.est.toFixed(1)}</td><td class="r${x.skunk >= .5 ? " skunkpct hi" : ""}">${Math.round(x.skunk * 100)}%</td><td class="r">${x.similar.length}</td></tr>`).join("")}</table></div></section>`;
    const basis = simTop.slice(0, 5);
    html += `<section class="card"><h2>Why Copilot said this: your most similar trips</h2><div class="tbl-wrap"><table><tr><th>Date</th><th>Temp</th><th>Time</th><th class="r">Fish</th></tr>${basis.map(x => `<tr><td>${fmtDate(x.s.date)}${x.s.spot ? ` · ${esc(x.s.spot)}` : ""}</td><td>${fmtT(avgT(x.s)) || "—"}</td><td>${x.s.start ? fmtTime(x.s.start) : esc(isPeriod(x.s) || "—")}</td><td class="r">${x.f || "skunk"}</td></tr>`).join("")}</table></div></section>`;
  }
  box.innerHTML = html;
}

/* ---------- wire up ---------- */
function resetAdviceInputs() {
  const now = new Date();
  $("aTemp").value = ""; segSet($("aSky"), []);
  $("aTime").value = `${String(now.getHours()).padStart(2, "0")}:${String(now.getMinutes()).padStart(2, "0")}`;
  $("aDate").value = isoDate(now); $("aWeatherMsg").textContent = "";
}
// Opening the sample lands on Copilot with a summer evening filled in, so the call shows straight away.
function showSampleCopilot() {
  $("aTemp").value = tOut(22); $("aTime").value = "18:30"; $("aDate").value = "2026-07-15"; segSet($("aSky"), []);
  $("aWeatherMsg").textContent = "Sample conditions: a July evening at 22°C. Change them to try others.";
  showTab("advice"); renderAdvice();
}
(function initAdvice() {
  const now = new Date();
  $("aTime").value = `${String(now.getHours()).padStart(2, "0")}:${String(now.getMinutes()).padStart(2, "0")}`;
  $("aDate").value = isoDate(now);
  $("aTempLabel").textContent = `Temp °${T()}`;
  $("aSky").innerHTML = ["Clear", "Overcast", "Rain"].map(c => `<button type="button" data-v="${c}" aria-pressed="false">${c}</button>`).join("");
  $("aSky").onclick = e => { const b = e.target.closest("button"); if (!b) return; const on = b.getAttribute("aria-pressed") !== "true"; segSet($("aSky"), on ? [b.dataset.v] : []); renderAdvice(); };
  ["aTemp", "aTime", "aDate"].forEach(id => $(id).addEventListener("input", renderAdvice));
  $("aWeather").onclick = () => loadWeather(true);
  const _render = render;
  render = function () { _render(); $("aTempLabel").textContent = `Temp °${T()}`; renderAdvice(); };
  renderAdvice();
})();
