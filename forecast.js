"use strict";
/* Fishing forecast: ranks your waters for a given temperature, time, date and sky
   by weighting every past trip by how similar its conditions were. Runs on the phone.
   Uses globals from app.js (state, fishOf, avgT, isPeriod, fmt helpers). */

const MIN_TRIPS = 10;            // trips with a temperature before advice unlocks
const PERIOD_HOUR = { Morning: 8, Midday: 13, Afternoon: 16.5, Evening: 19.5 };
const hourOf = t => { const [a, b] = t.split(":").map(Number); return a + b / 60; };
function tripHour(s) {
  if (s.start) { if (!s.end) return hourOf(s.start); let e = hourOf(s.end); const a = hourOf(s.start); if (e < a) e += 24; return ((a + e) / 2) % 24; } // past midnight: centred on the night
  const p = isPeriod(s); return p ? PERIOD_HOUR[p] : null;
}
const dayOfYear = iso => { const d = new Date(iso + "T12:00:00"); return Math.round((d - new Date(d.getFullYear(), 0, 1)) / 864e5); };

// The ranking itself lives in bite-core.js (shared with bite alerts, so an alert names the same water as the Guide).
const rankWaters = q => BiteCore.rankWaters(state.sessions, q);
const bestOf = (xs, key) => BiteCore.bestOf(xs, key), bestSpot = xs => BiteCore.bestSpot(xs);
const bestRanking = (q, minNeff = 1) => BiteCore.bestRanking(state.sessions, q, minNeff);
const conf = n => n >= 5 ? ["High", "go"] : n >= 2.5 ? ["Medium", "info"] : ["Low", "no"];
const clock = h => { const hh = Math.floor(h) % 24, mm = Math.round((h - Math.floor(h)) * 60); return fmtTime(`${String(hh).padStart(2, "0")}:${String(mm).padStart(2, "0")}`); };

/* ---------- weather (Open-Meteo, free, no key) ---------- */
let wx = null; // { lat, lon, current:{temp,sky}, hourly:[{time:Date, temp, sky}] }
const skyFromCode = c => c == null ? null : c <= 1 ? "Clear" : c <= 48 ? "Overcast" : "Rain";
function weatherSpot() {
  if (demo) return null; // the sample's spots are in New Brunswick, not where the visitor is
  const pins = state.sessions.filter(s => s.lat != null);
  if (!pins.length) return null;
  return { lat: pins.reduce((a, s) => a + s.lat, 0) / pins.length, lon: pins.reduce((a, s) => a + s.lon, 0) / pins.length };
}
async function loadWeather(useGps) {
  const msg = $("aWeatherMsg");
  let where = null, why = null;
  if (useGps && navigator.geolocation) {
    msg.textContent = "Locating…";
    where = await new Promise(res => navigator.geolocation.getCurrentPosition(p => res({ lat: p.coords.latitude, lon: p.coords.longitude }),
      e => { why = e.code === 1 ? "denied" : "nofix"; res(null); }, { timeout: 12000, maximumAge: 600000 }));
  } else if (useGps) why = "nofix";
  // No GPS: fall back to a town the angler typed, then to where their pinned trips are.
  const via = where ? "gps" : state.settings.home ? "town" : "spots";
  where ??= state.settings.home || weatherSpot();
  if (!where) { msg.textContent = "Allow location, or type your town, to pull the weather. You can also type the temperature."; return why || "noloc"; }
  msg.textContent = "Syncing live conditions…";
  try {
    const u = `https://api.open-meteo.com/v1/forecast?latitude=${where.lat.toFixed(3)}&longitude=${where.lon.toFixed(3)}&current=temperature_2m,apparent_temperature,relative_humidity_2m,weather_code,cloud_cover,pressure_msl,wind_speed_10m,wind_direction_10m,wind_gusts_10m&hourly=temperature_2m,weather_code,pressure_msl,wind_speed_10m,precipitation,precipitation_probability&daily=sunrise,sunset&past_days=2&forecast_days=2&timezone=auto&timeformat=unixtime`;
    const [d, flow] = await Promise.all([(await fetch(u, limit())).json(), typeof fetchWater === "function" ? fetchWater(where.lat, where.lon).catch(() => null) : null]);
    // Times come as absolute seconds, so a town in another time zone lines up with this phone's clock.
    const T = t => new Date(typeof t === "number" ? t * 1000 : t);
    const nowIdx = d.hourly.time.findIndex(t => T(t) > new Date()) - 1;
    const p0 = d.current.pressure_msl, p3 = nowIdx >= 3 ? d.hourly.pressure_msl[nowIdx - 3] : null;
    const press = p0 != null && p3 != null ? (p0 - p3 >= 1 ? "Rising" : p0 - p3 <= -1 ? "Falling" : "Steady") : null;
    wx = {
      ...where, current: { temp: d.current.temperature_2m ?? d.hourly.temperature_2m?.[nowIdx] ?? null, sky: skyFromCode(d.current.weather_code), p: p0 == null ? null : Math.round(p0), press,
        dp3: p0 != null && p3 != null ? r(p0 - p3, 1) : null, feels: d.current.apparent_temperature, hum: d.current.relative_humidity_2m, cloud: d.current.cloud_cover,
        wind: d.current.wind_speed_10m, gust: d.current.wind_gusts_10m, dir: d.current.wind_direction_10m, code: d.current.weather_code }, flow,
      hourly: d.hourly.time.map((t, i) => ({ time: T(t), temp: d.hourly.temperature_2m[i], sky: skyFromCode(d.hourly.weather_code[i]), p: d.hourly.pressure_msl?.[i], wind: d.hourly.wind_speed_10m?.[i], rain: d.hourly.precipitation?.[i], pop: d.hourly.precipitation_probability?.[i] })),
      sun: (d.daily?.sunrise || []).map((s, i) => ({ rise: T(s), set: T(d.daily.sunset[i]) })),
      updated: new Date(),
      via, why, place: via === "town" ? state.settings.home.name || null : null,
    };
    const now = new Date();
    // On the sample, Guide keeps its July evening: live weather is yours, the sample's waters aren't.
    if (!demo) {
      $("aTemp").value = wx.current.temp != null ? tOut(r(wx.current.temp, 0)) : "";
      $("aTime").value = `${String(now.getHours()).padStart(2, "0")}:${String(now.getMinutes()).padStart(2, "0")}`;
      $("aDate").value = isoDate(now);
      segSet($("aSky"), [wx.current.sky]);
      segSet($("aPress"), press ? [press] : []);
      segSet($("aFlow"), flow ? [flow.status] : []);
      msg.textContent = `Live conditions synced at ${fmtTime($("aTime").value)}${wx.current.p ? ` · ${wx.current.p} hPa ${press ? press.toLowerCase() : ""}` : ""}${flow ? ` · ${flow.station}: ${flow.status.toLowerCase()} water, ${flow.trend}` : ""}.`;
    } else msg.textContent = "Live weather updated. The showcase call keeps its July evening.";
    renderAdvice();
    if (typeof renderLive === "function") renderLive();
  } catch (e) { msg.textContent = "Couldn't reach the weather service. Type the temperature instead."; return "error"; }
}
const isoDate = d => `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;

// Best window in the next ~30 hours of daylight-ish fishing hours, from the hourly forecast.
function bestWindow() {
  if (!wx) return null;
  const now = Date.now(), hrs = wx.hourly.filter(h => h.time.getTime() >= now - 36e5 && h.time.getTime() <= now + 30 * 36e5 && h.time.getHours() >= 5 && h.time.getHours() <= 21 && h.temp != null);
  if (!hrs.length) return null;
  const scored = hrs.map(h => { const q = { temp: h.temp, hour: h.time.getHours() + 0.5, doy: dayOfYear(isoDate(h.time)), sky: h.sky }; const top = bestRanking(q, 1.5).rows[0]; return { h, top }; }).filter(x => x.top);
  if (!scored.length) return null;
  const peak = scored.reduce((a, b) => b.top.est > a.top.est ? b : a);
  const i = scored.indexOf(peak); let lo = i, hi = i;
  const ok = x => x && x.top.water === peak.top.water && x.top.est >= peak.top.est * 0.85 && Math.abs(x.h.time - scored[lo].h.time) < 6 * 36e5;
  while (ok(scored[lo - 1]) && scored[lo].h.time - scored[lo - 1].h.time === 36e5) lo--;
  while (ok(scored[hi + 1]) && scored[hi + 1].h.time - scored[hi].h.time === 36e5) hi++;
  const a = scored[lo].h, b = scored[hi].h, temps = scored.slice(lo, hi + 1).map(x => x.h.temp);
  const ahead = Math.round((new Date(a.time).setHours(12, 0, 0, 0) - new Date(now).setHours(12, 0, 0, 0)) / 864e5);
  const day = ahead <= 0 ? "Today" : ahead === 1 ? "Tomorrow" : a.time.toLocaleDateString("en-US", { weekday: "long" });
  return { day, from: a.time.getHours(), to: b.time.getHours() + 1, water: peak.top.water, est: peak.top.est, tLo: Math.min(...temps), tHi: Math.max(...temps) };
}

/* ---------- render ---------- */
// On Trips, until Guide unlocks: how far along the log is, and which trips don't count yet.
function renderTrainStrip() {
  const box = $("trainStrip"); if (!box) return;
  const n = state.sessions.filter(s => avgT(s) != null).length, missing = state.sessions.length - n;
  box.hidden = !!demo || !state.sessions.length || n >= MIN_TRIPS;
  if (box.hidden) return;
  box.innerHTML = `<div class="ts-top"><b>${n} of ${MIN_TRIPS} trips</b><span>Your guide starts making calls at ${MIN_TRIPS}. Skunks count.</span></div>
    <div class="meter"><span style="width:${n / MIN_TRIPS * 100}%"></span></div>
    ${missing ? `<p>${missing} trip${missing === 1 ? " has" : "s have"} no temperature, so ${missing === 1 ? "it doesn't" : "they don't"} count yet. <button type="button" class="text-link" id="tsFill">Add the weather</button></p>` : ""}`;
  const f = $("tsFill"); if (f) f.onclick = () => { $("openSettings").click(); $("backfillWx").scrollIntoView({ block: "center" }); };
}
function renderAdvice() {
  const box = $("advice"); if (!box) return;
  const withTemp = state.sessions.filter(s => avgT(s) != null).length;
  if (withTemp < MIN_TRIPS) {
    box.innerHTML = `<div class="verdict locked"><span class="chip info">Training</span><h3>Your guide needs ${MIN_TRIPS - withTemp} more trip${MIN_TRIPS - withTemp === 1 ? "" : "s"} with a temperature</h3><p>Once your log has ${MIN_TRIPS} trips with a temperature, your guide tells you where to fish for the conditions you're in, and when. fishr fills the temperature in when location is on. Skunks count: they teach it what doesn't work.</p><div class="meter"><span style="width:${withTemp / MIN_TRIPS * 100}%"></span></div><p class="label">${withTemp} of ${MIN_TRIPS}</p></div>`;
    return;
  }
  const tv = $("aTemp").value, tm = $("aTime").value, dt = $("aDate").value;
  if (tv === "" || !tm || !dt) { box.innerHTML = `<p class="status">Turn on live conditions above for today's weather, or open “What if?” and enter a temperature and time.</p>`; return; }
  const pick = id => $(id).querySelector('[aria-pressed="true"]')?.dataset.v || null;
  const q = { temp: tIn(Number(tv)), hour: hourOf(tm), doy: dayOfYear(dt), sky: pick("aSky"), press: pick("aPress"), flow: pick("aFlow") };
  const { res, rows, k } = bestRanking(q);
  const top = rows[0], second = rows[1], widened = k > 1;
  const when = `${fmtT(q.temp)} at ${fmtTime(tm)}${q.sky ? `, ${q.sky.toLowerCase()}` : ""}${q.press ? `, pressure ${q.press.toLowerCase()}` : ""}${q.flow ? `, ${q.flow.toLowerCase()} water` : ""}`;
  let html = "";
  if (!top) {
    html = `<div class="verdict"><span class="chip info">Training</span><h3>Log a few more trips</h3><p>Your guide needs trips at a couple of different waters before it can compare them.</p></div>`;
  } else {
    const [cl, cc] = k >= 2.5 ? ["Low", "no"] : k > 1 && top.neff >= 5 ? ["Medium", "info"] : conf(top.neff), simTop = top.similar.length ? top.similar : top.xs.sort((a, b) => b.w - a.w);
    const lure = bestOf(simTop, c => c.lure), spot = bestSpot(simTop), species = bestOf(simTop, c => c.species);
    const nSim = top.similar.length, skunks = top.similar.filter(x => !x.f).length;
    const slow = res.skunkSimilar >= 0.5 && res.nSimilar >= 3;
    const tough = slow && (top.skunk >= 0.5 || top.est < 1);  // even the best option is weak
    const you = demo ? "this angler" : "you";
    const evidence = nSim ? `On ${nSim} similar trip${nSim === 1 ? "" : "s"} there ${you} caught ${top.similar.reduce((a, x) => a + x.f, 0)} fish and got skunked ${skunks === 0 ? "none of the time" : skunks === nSim ? "every time" : `${skunks} time${skunks === 1 ? "" : "s"}`}.` : `${demo ? "This angler has" : "You've"} fished it ${top.trips} time${top.trips === 1 ? "" : "s"}, but never in conditions this close, so treat this as a lean.`;
    const nearT = Math.round(3.5 * k), nearH = Math.round(2.2 * k);
    const widenNote = widened ? `<p class="v-note">Nothing in your log is a close match for ${esc(when)}, so this is based on your nearest trips (within about ${tOut(nearT) - tOut(0)}°${T()} and ${nearH} hours). It gets sharper as you log trips in these conditions.</p>` : "";
    html += `<div class="verdict${slow ? " slow" : ""}">
      <div class="v-top"><span class="chip ${cc}">${widened ? "Closest match · " : ""}${cl} confidence</span><span class="label">${esc(when)}</span></div>
      ${tough ? `<h3>Wait if you can</h3>
      <p class="v-say">${Math.round(res.skunkSimilar * 100)}% of your trips in conditions like this were skunks. If you go anyway, <b>${esc(top.water)}</b> is your best bet, at about ${top.est.toFixed(1)} fish. ${evidence}</p>` : `<h3>Fish ${esc(top.water)}</h3>
      <p class="v-say">Expect about <b>${top.est.toFixed(1)} fish</b>${species ? `, mostly ${esc(species.toLowerCase())}` : ""}. ${evidence}</p>`}
      <ul class="v-tips">${spot ? `<li><span class="label">Spot</span>${esc(spot)}</li>` : ""}${lure ? `<li><span class="label">Tie on</span>${esc(lure)}</li>` : ""}${second ? `<li><span class="label">Backup plan</span>${esc(second.water)} · ~${second.est.toFixed(1)} fish</li>` : ""}</ul>
      ${widenNote}
      ${conditionFacts(q)}
      ${slow && !tough ? `<p class="v-warn"><b>Heads up:</b> ${Math.round(res.skunkSimilar * 100)}% of your trips in conditions like this were skunks, wherever you went.</p>` : ""}
      ${!res.anySeason ? `<p class="v-warn">You haven't logged trips at this time of year, so this is based on temperature and time of day only.</p>` : ""}
    </div>`;
    if (demo) html += `<p class="v-note showcase-pick">This is the showcase angler's pick from their New Brunswick waters. Log your own trips and your guide picks from yours.</p>`;
    const win = demo ? null : bestWindow(); // the forecast is yours, the sample's waters aren't
    if (win) html += `<div class="window"><span class="chip go">Best window</span><span><b>${win.day} ${clock(win.from)}–${clock(win.to)}</b> at ${esc(win.water)}, ${win.tLo === win.tHi ? fmtT(r(win.tLo, 0)) : `${tOut(r(win.tLo, 0))}–${fmtT(r(win.tHi, 0))}`} forecast. Expect about ${win.est.toFixed(1)} fish.</span></div>`;
    // The tables behind the call fold away, so Guide fits on one screen.
    html += `<details class="more math" id="mathBox"${mathOpen ? " open" : ""}><summary><span>See the math</span><span class="more-hint">other waters and your most similar trips</span></summary><div class="more-in">`;
    if (rows.length > 2) html += `<section class="card"><h2>Other predictions</h2><div class="tbl-wrap"><table><tr><th>Water</th><th class="r">Expect</th><th class="r">Skunk risk</th><th class="r">Similar trips</th></tr>${rows.slice(2, 7).map(x => `<tr><td>${esc(x.water)}</td><td class="r">${x.est.toFixed(1)}</td><td class="r${x.skunk >= .5 ? " skunkpct hi" : ""}">${Math.round(x.skunk * 100)}%</td><td class="r">${x.similar.length}</td></tr>`).join("")}</table></div></section>`;
    const basis = simTop.slice(0, 5);
    html += `<section class="card"><h2>Why your guide said this: your most similar trips</h2><div class="tbl-wrap"><table><tr><th>Date</th><th>Temp</th><th>Time</th><th class="r">Fish</th></tr>${basis.map(x => `<tr><td>${fmtDate(x.s.date)}${x.s.spot ? ` · ${esc(x.s.spot)}` : ""}</td><td>${fmtT(avgT(x.s)) || "—"}</td><td>${x.s.start ? fmtTime(x.s.start) : esc(isPeriod(x.s) || "—")}</td><td class="r">${x.f || "skunk"}</td></tr>`).join("")}</table></div></section>`;
    html += `</div></details>`;
  }
  box.innerHTML = html;
  $("mathBox")?.addEventListener("toggle", e => { mathOpen = e.target.open; });
}
let mathOpen = false;

// What your own log says about pressure and river level, once there are enough trips to compare.
function conditionFacts(q) {
  const out = [], all = state.sessions;
  const avg = xs => xs.reduce((a, s) => a + fishOf(s), 0) / xs.length;
  if (q.press) {
    const same = all.filter(s => s.wx?.trend === q.press), other = all.filter(s => s.wx?.trend && s.wx.trend !== q.press);
    if (same.length >= 3 && other.length >= 3) out.push(`Your ${q.press.toLowerCase()}-pressure trips average <b>${avg(same).toFixed(1)} fish</b> (${same.length} trips) vs ${avg(other).toFixed(1)} otherwise.`);
  }
  if (q.flow) {
    const same = all.filter(s => waterLevelOf(s) === q.flow), other = all.filter(s => waterLevelOf(s) && waterLevelOf(s) !== q.flow);
    if (same.length >= 2 && other.length >= 2) out.push(`Your ${q.flow.toLowerCase()}-water trips average <b>${avg(same).toFixed(1)} fish</b> (${same.length} trips) vs ${avg(other).toFixed(1)} otherwise.`);
  }
  if (wx?.flow && q.flow === wx.flow.status) out.push(`Nearest gauge: ${esc(wx.flow.station)} (${wx.flow.distKm} km), ${wx.flow.status.toLowerCase()} for the last two weeks and ${wx.flow.trend}.`);
  return out.length ? `<p class="v-note">${out.join(" ")}</p>` : "";
}

/* ---------- wire up ---------- */
function resetAdviceInputs() {
  const now = new Date();
  // Back from the sample: put today's live conditions back if we have them, so Guide isn't blank.
  const c = wx?.current;
  $("aTemp").value = c?.temp != null ? tOut(r(c.temp, 0)) : ""; segSet($("aSky"), c?.sky ? [c.sky] : []); segSet($("aPress"), c?.press ? [c.press] : []); segSet($("aFlow"), wx?.flow ? [wx.flow.status] : []);
  $("aTime").value = `${String(now.getHours()).padStart(2, "0")}:${String(now.getMinutes()).padStart(2, "0")}`;
  $("aDate").value = isoDate(now); $("aWeatherMsg").textContent = "";
}
// Opening the sample lands on the Guide tab with a summer evening filled in, so the call shows straight away.
// The showcase's Guide inputs: a July evening at 22°C. Set whichever tile the showcase was opened from, so the
// Guide tab never contradicts the live card's "the showcase call uses a July evening" note.
function setSampleInputs() {
  $("aTemp").value = tOut(22); $("aTime").value = "18:30"; $("aDate").value = "2026-07-15"; segSet($("aSky"), []); segSet($("aPress"), []); segSet($("aFlow"), []);
  $("aWeatherMsg").textContent = `Sample conditions: a July evening at ${fmtT(22)}. Change them to try others.`;
}
function showSampleCopilot() { setSampleInputs(); showTab("advice"); renderAdvice(); }
(function initAdvice() {
  const now = new Date();
  $("aTime").value = `${String(now.getHours()).padStart(2, "0")}:${String(now.getMinutes()).padStart(2, "0")}`;
  $("aDate").value = isoDate(now);
  $("aTempLabel").textContent = `Temp °${T()}`;
  const single = (id, opts) => {
    $(id).innerHTML = opts.map(c => `<button type="button" data-v="${c}" aria-pressed="false">${c}</button>`).join("");
    $(id).onclick = e => { const b = e.target.closest("button"); if (!b) return; const on = b.getAttribute("aria-pressed") !== "true"; segSet($(id), on ? [b.dataset.v] : []); renderAdvice(); };
  };
  single("aSky", ["Clear", "Overcast", "Rain"]); single("aPress", ["Rising", "Steady", "Falling"]); single("aFlow", ["Low", "Normal", "High"]);
  ["aTemp", "aTime", "aDate"].forEach(id => $(id).addEventListener("input", () => { $("aWeatherMsg").textContent = ""; renderAdvice(); }));
  $("aWeather").onclick = () => loadWeather(true);
  const _render = render;
  render = function () { _render(); $("aTempLabel").textContent = `Temp °${T()}`; renderAdvice(); renderTrainStrip(); };
  renderAdvice(); renderTrainStrip();
})();
