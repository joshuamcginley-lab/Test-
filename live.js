"use strict";
/* Live conditions dashboard on the Guide tab: Bite Index, air, pressure, wind, river, rain, light and moon.
   Reads the `wx` object filled by loadWeather() in forecast.js. Uses globals from app.js and forecast.js. */

let liveLoading = false;

// Sync on opening Guide when we can do it without nagging: location already allowed, or a known spot.
async function autoLive() {
  if (wx && Date.now() - wx.updated < 15 * 60e3) { renderLive(); return; }
  if (liveLoading) return;
  let granted = false;
  try { granted = (await navigator.permissions?.query({ name: "geolocation" }))?.state === "granted"; } catch (e) {}
  const known = state.settings.home || weatherSpot();
  if (!granted && !known) { renderLive(); return; }
  goLive(granted);
}
async function goLive(useGps) {
  liveLoading = true; renderLive();
  let status;
  try { status = await loadWeather(useGps); } finally { liveLoading = false; renderLive(status); }
}

// Without GPS (blocked, no fix, or a laptop), people can type a town. Open-Meteo's free geocoder turns it into
// coordinates, which are kept on this phone as the weather spot.
async function useTown(name) {
  const msg = $("townMsg"); msg.textContent = "Looking it up…";
  try {
    const d = await (await fetch(`https://geocoding-api.open-meteo.com/v1/search?name=${encodeURIComponent(name)}&count=1&language=en&format=json`)).json();
    const g = d.results?.[0];
    if (!g) { msg.textContent = "Couldn't find that one. Try the nearest town or city."; return; }
    state.settings.home = { lat: r(g.latitude, 2), lon: r(g.longitude, 2), name: [g.name, g.admin1].filter(Boolean).join(", ") };
    save(); goLive(false);
  } catch (e) { msg.textContent = "No connection. Try again when you have signal."; }
}
function locationHelp(status) {
  if (status === "denied") return /iPhone|iPad/.test(navigator.userAgent)
    ? "Location is off for fishr. Turn it on in Settings → Privacy &amp; Security → Location Services → Safari Websites → While Using. Or type your town:"
    : "Location is blocked for fishr in this browser. Allow it in the browser's site settings, or type your town:";
  if (status === "error") return "Couldn't reach the weather service. Try again in a minute, or type your town:";
  return status === "town" ? "Type your town and fishr will pull its weather:" : "Couldn't get a GPS fix. Type your town instead:";
}

/* ---------- small drawing helpers ---------- */
let sparkSeq = 0;
function spark(vals, { w = 220, h = 48, nowAt = null, warn = false } = {}) {
  const pts = vals.map((v, i) => [i, v]).filter(p => Number.isFinite(p[1]));
  if (pts.length < 2) return "";
  const lo = Math.min(...pts.map(p => p[1])), hi = Math.max(...pts.map(p => p[1])), span = hi - lo || 1;
  const X = i => (i / (vals.length - 1)) * (w - 4) + 2, Y = v => h - 4 - ((v - lo) / span) * (h - 10);
  const line = pts.map((p, k) => `${k ? "L" : "M"}${X(p[0]).toFixed(1)},${Y(p[1]).toFixed(1)}`).join("");
  const id = `sg${++sparkSeq}`, c0 = warn ? "var(--bad)" : "var(--v)";
  const now = nowAt != null && Number.isFinite(vals[nowAt]) ? `<line x1="${X(nowAt)}" x2="${X(nowAt)}" y1="2" y2="${h - 2}" stroke="var(--line-2)" stroke-dasharray="2 3"/><circle cx="${X(nowAt)}" cy="${Y(vals[nowAt])}" r="3.5" fill="var(--ink)" stroke="var(--solid)" stroke-width="2"/>` : "";
  return `<svg class="spark-svg" viewBox="0 0 ${w} ${h}" preserveAspectRatio="none" aria-hidden="true"><defs>
    <linearGradient id="${id}" x1="0" x2="1"><stop offset="0" stop-color="${c0}"/><stop offset="1" stop-color="var(--m)"/></linearGradient>
    <linearGradient id="${id}a" x1="0" y1="0" x2="0" y2="1"><stop offset="0" stop-color="${c0}" stop-opacity=".25"/><stop offset="1" stop-color="${c0}" stop-opacity="0"/></linearGradient></defs>
    <path d="${line}L${X(pts[pts.length - 1][0])},${h}L${X(pts[0][0])},${h}Z" fill="url(#${id}a)"/>
    <path class="spark-line" d="${line}" fill="none" stroke="url(#${id})" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" pathLength="1"/>${now}</svg>`;
}
function ring(score) {
  const R = 46, C = 2 * Math.PI * R;
  return `<svg class="ring" viewBox="0 0 110 110" aria-hidden="true"><defs><linearGradient id="ringG" x1="0" y1="0" x2="1" y2="1"><stop offset="0" stop-color="var(--v)"/><stop offset=".6" stop-color="#FFB21A"/><stop offset="1" stop-color="var(--m)"/></linearGradient></defs>
    <circle cx="55" cy="55" r="${R}" fill="none" stroke="var(--line)" stroke-width="9"/>
    <circle class="ring-arc" cx="55" cy="55" r="${R}" fill="none" stroke="url(#ringG)" stroke-width="9" stroke-linecap="round" transform="rotate(-90 55 55)" stroke-dasharray="${C}" stroke-dashoffset="${C * (1 - score / 100)}" style="--c0:${C}"/></svg>`;
}
function compassSvg(dir) {
  const to = ((dir ?? 0) + 180) % 360; // arrow points where the wind is going
  return `<svg class="compass" viewBox="0 0 64 64" aria-hidden="true"><circle cx="32" cy="32" r="28" fill="none" stroke="var(--line-2)"/>
    ${["N", "E", "S", "W"].map((l, i) => `<text x="${32 + 21 * Math.sin(i * Math.PI / 2)}" y="${32 - 21 * Math.cos(i * Math.PI / 2) + 3.5}" text-anchor="middle" font-size="8" fill="var(--muted)" font-family="Geist Mono,monospace">${l}</text>`).join("")}
    <g transform="rotate(${to} 32 32)"><path d="M32 12 L37 30 L32 27 L27 30 Z" fill="var(--v)"/><path d="M32 52 L32 30" stroke="var(--v)" stroke-width="2" stroke-linecap="round"/></g></svg>`;
}
function moon(date) {
  const syn = 29.530588853, age = ((((date - Date.UTC(2000, 0, 6, 18, 14)) / 864e5) % syn) + syn) % syn;
  const illum = Math.round((1 - Math.cos(2 * Math.PI * age / syn)) / 2 * 100);
  const names = ["New moon", "Waxing crescent", "First quarter", "Waxing gibbous", "Full moon", "Waning gibbous", "Last quarter", "Waning crescent"];
  return { name: names[Math.floor((age / syn) * 8 + 0.5) % 8], illum, age };
}
const fmtClock = d => d.toLocaleTimeString([], { hour: "numeric", minute: "2-digit" });
const fmtDur = ms => { const m = Math.round(ms / 60000), h = Math.floor(m / 60); return h ? `${h}h ${m % 60}m` : `${m}m`; };
const windWord = k => k == null ? "" : k < 6 ? "Calm" : k < 20 ? "Light" : k < 30 ? "Moderate" : k < 45 ? "Strong" : "Gale";

/* ---------- Bite Index: live conditions, weighted by your own log, scored for your fish ---------- */
// Each factor starts from a general default. Once your log has enough trips in the same bucket (falling pressure,
// overcast, low light…), the factor shifts toward what your trips say, and its chip is marked as yours.

// The scoring itself lives in bite-core.js (shared with the server's bite alerts); these are the app's handles on it.
const { SPECIES_TEMPS, speciesInfo, fishFor, coldFront } = BiteCore;

// The species someone could score for: ones they've caught at least 3 of (up to 4), most-caught first.
function biteChoices() {
  if (demo) return [];
  const n = {};
  for (const s of state.sessions) for (const c of s.catches || []) { const i = speciesInfo(c.species); if (i) n[i.name] = (n[i.name] || 0) + (+c.count || 0); }
  return Object.entries(n).filter(([, k]) => k >= 3).sort((a, b) => b[1] - a[1]).slice(0, 4).map(([k]) => k);
}
// Which one the score is for: their pick, or by default the fish they catch most (if it's a real share of the catch).
function biteSpecies(choices) {
  const set = state.settings.biteSpecies;
  if (!choices.length || set === "all") return null;
  if (set && choices.includes(set)) return set;
  const total = state.sessions.reduce((a, s) => a + fishOf(s), 0), top = state.sessions.reduce((a, s) => a + fishFor(s, choices[0]), 0);
  return total && top / total >= 0.4 ? choices[0] : null;
}


const frontWhy = f => f.passed
  ? `A cold front came through about ${f.hrs} hours ago: ${Math.round(tOut(f.drop) - tOut(0))}° colder than the day before and pressure up ${Math.round(f.rise)} hPa since. Fish often go quiet for a day or so after one. Slow down and fish deeper.`
  : `A cold front looks due in about ${f.hrs} hours, with the day after it about ${Math.round(tOut(f.drop) - tOut(0))}° colder. Fish often feed hard ahead of one. Go before it hits.`;

// The Bite Index for the angler's own log (none in the showcase), with the cold-front chip explained in their units.
function biteIndex(ctx) {
  const out = BiteCore.score(ctx, { log: demo ? [] : state.sessions, fmtT });
  for (const d of out.drivers) if (d.front) d.why = frontWhy(d.front);
  return out;
}

/* ---------- render ---------- */
function renderLive(status, quiet) {
  const box = $("live"); if (!box) return;
  if (!wx || status === "town") {
    box.innerHTML = liveLoading
      ? `<div class="live-empty"><span class="live-dot"></span><div><b>Syncing 4 data sources…</b><span>Weather models · barometric pressure · river gauges · sun and moon</span></div></div><div class="live-grid">${"<div class='tile skel'></div>".repeat(6)}</div>`
      : ["denied", "nofix", "noloc", "error", "town"].includes(status)
      ? `<div class="live-empty live-fix"><span class="live-dot off"></span><div><b>${status === "error" ? "Couldn't reach live data" : status === "town" ? "Pull the weather for a town" : "Couldn't get your location"}</b><span>${locationHelp(status)}</span>
          <form class="town-form" id="townForm"><input id="townIn" placeholder="Town, e.g. Halifax" autocomplete="address-level2" enterkeyhint="go" aria-label="Your town"><button type="submit" class="btn primary">Use</button></form>
          <span class="town-msg" id="townMsg" role="status"></span></div></div>`
      : `<div class="live-empty"><span class="live-dot off"></span><div><b>Live conditions are off</b><span>Weather, pressure, river levels, sun and moon. <button type="button" class="text-link" id="liveTown">Or type a town</button></span></div><button type="button" class="btn-log" id="liveGo">✦ Go live</button></div>`;
    const g = $("liveGo"); if (g) g.onclick = () => goLive(true);
    const t = $("liveTown"); if (t) t.onclick = () => { renderLive("town"); $("townIn").focus(); };
    const f = $("townForm"); if (f) f.onsubmit = e => { e.preventDefault(); const v = $("townIn").value.trim(); if (v) useTown(v); };
    return;
  }
  const now = new Date(), H = wx.hourly, c = wx.current;
  let ni = H.findIndex(h => h.time > now) - 1; if (ni < 0) ni = 0;
  const slice = (a, b, f) => H.slice(Math.max(0, ni + a), ni + b + 1).map(f);
  const nowIn = a => Math.min(ni, -a);

  // light
  const sun = wx.sun.find(s => s.rise.toDateString() === now.toDateString()) || wx.sun[0];
  const nextSun = wx.sun.find(s => s.rise > now);
  const toRise = sun ? sun.rise - now : null, toSet = sun ? sun.set - now : null;
  const dark = sun && (now < sun.rise || now > sun.set);
  const goldenEve = toSet != null && toSet <= 75 * 60e3 && toSet > -20 * 60e3, goldenMorn = toRise != null && toRise <= 20 * 60e3 && toRise > -75 * 60e3;
  const light = {
    golden: goldenEve || goldenMorn, goldenLabel: goldenEve ? "Evening golden hour" : "Morning golden hour", dark,
    nearHrs: Math.min(Math.abs(toRise ?? 9e9), Math.abs(toSet ?? 9e9)) / 3600e3, midday: now.getHours() >= 11 && now.getHours() < 15,
  };
  const dawn = sun ? (dark && now > sun.set ? (nextSun || sun).rise : sun.rise) : null;
  const lightLine = dark ? (dawn ? `Night · dawn bite window ${fmtClock(new Date(dawn - 30 * 60e3))}–${fmtClock(new Date(+dawn + 60 * 60e3))}` : "Night")
    : goldenEve ? `Golden hour now · sunset ${fmtClock(sun.set)}` : goldenMorn ? `Golden hour now · sunrise ${fmtClock(sun.rise)}`
    : toSet > 0 ? `Golden hour in ${fmtDur(toSet - 75 * 60e3)}` : ""; // same 75 minutes as the Bite Index's golden hour
  const mn = moon(now);

  // model blend, once the log is big enough
  let model = null;
  // Only your own log counts: the sample's waters say nothing about the weather where you are.
  if (!demo && state.sessions.filter(s => avgT(s) != null).length >= MIN_TRIPS && c.temp != null) {
    const q = { temp: c.temp, hour: now.getHours() + now.getMinutes() / 60, doy: dayOfYear(isoDate(now)), sky: c.sky, press: c.press, flow: wx.flow?.status || null };
    const { res, rows } = bestRanking(q);
    if (rows[0] && res.globalRate) model = { delta: (rows[0].est / res.globalRate - 1) * 25, label: `Your log: ${rows[0].water}`, top: rows[0] };
  }
  const choices = biteChoices(), sp = biteSpecies(choices);
  const past = wx.hourly.filter(h => h.time <= now && h.time >= now - 48 * 36e5 && h.temp != null);
  const recentTemp = past.length ? past.reduce((a, h) => a + h.temp, 0) / past.length : null;
  const front = coldFront(H, now);
  const bi = biteIndex({ c, light, flow: wx.flow, model, sp, recentTemp, front });
  // Phones show three chips: keep the strongest one learned from your log among them.
  const mi = bi.drivers.findIndex(x => x.mine);
  const chips = (mi > 2 ? [...bi.drivers.slice(0, 2), bi.drivers[mi], ...bi.drivers.filter((x, i) => i >= 2 && i !== mi)] : bi.drivers).slice(0, 5);

  // series
  const pSeries = slice(-24, 12, h => h.p), tSeries = slice(-6, 12, h => h.temp);
  const rain48 = H.slice(Math.max(0, ni - 47), ni + 1).reduce((a, h) => a + (h.rain || 0), 0);
  const pop12 = Math.max(0, ...H.slice(ni + 1, ni + 13).map(h => h.pop || 0));
  const f = wx.flow;
  const coord = `${Math.abs(wx.lat).toFixed(2)}°${wx.lat >= 0 ? "N" : "S"} ${Math.abs(wx.lon).toFixed(2)}°${wx.lon >= 0 ? "E" : "W"}`;
  const sources = 3 + (f ? 1 : 0);
  const arrow = c.press === "Rising" ? "↑" : c.press === "Falling" ? "↓" : "→";

  box.innerHTML = `
  <div class="live-head">
    <span class="live-dot"></span><b>Live</b><span class="mono">${wx.place ? esc(wx.place) : coord}</span><span>Updated ${fmtClock(wx.updated)}</span><span>${sources} sources</span>
    <button type="button" class="linkbtn" id="liveRefresh">↻ Resync</button>
  </div>
  ${demo ? `<p class="live-where">Your weather right now. The showcase call below uses a July evening on this angler's New Brunswick waters.</p>` : ""}
  ${wx.via !== "gps" ? `<p class="live-where">${wx.why === "denied" ? "Location is off, so this is" : "This is"} the weather for ${wx.place ? esc(wx.place) : "your pinned spots"}. <button type="button" class="text-link" id="liveChange">${wx.place ? "Change town" : "Use a town instead"}</button></p>` : ""}
  <div class="live-grid">
    <div class="tile bite">
      <div class="bite-ring">${ring(bi.score)}<div class="bite-num"><b data-count="${bi.score}">${bi.score}</b><span>/100</span></div></div>
      <div class="bite-txt">
        <span class="label">fishr Bite Index™ ${choices.length ? `<label class="bite-sp"><span aria-hidden="true">${esc(sp || "All fish")}</span><select id="biteSp" aria-label="Score the Bite Index for"><option value="all">All fish</option>${choices.map(n => `<option${n === sp ? " selected" : ""}>${esc(n)}</option>`).join("")}</select></label>` : ""}<span class="model-tag${choices.length ? " has-sp" : ""}">bite-engine v0.3 · k-NN</span></span>
        <strong class="grad-text">${bi.label}</strong>
        <div class="drivers">${chips.map(x => x.why
          ? `<button type="button" class="drv ${x.v > 0 ? "up" : "down"}${x.mine ? " mine" : ""}" data-why="${esc(x.why)}" aria-expanded="false">${x.v > 0 ? "+" : "−"}${Math.abs(x.v)} ${esc(x.label)}</button>`
          : `<span class="drv ${x.v > 0 ? "up" : "down"}">${x.v > 0 ? "+" : "−"}${Math.abs(x.v)} ${esc(x.label)}</span>`).join("")}</div>
        <p class="drv-why" id="drvWhy" hidden></p>
      </div>
    </div>
    <div class="live-rest">
    <div class="tile">
      <span class="label">Air</span>
      <div class="big"><b data-count="${Math.round(tOut(c.temp))}">${Math.round(tOut(c.temp))}</b><small>°${T()}</small></div>
      <span class="sub">Feels ${Math.round(tOut(c.feels))}° · ${c.hum ?? "—"}% humidity · ${c.cloud ?? "—"}% cloud</span>
      ${spark(tSeries, { nowAt: nowIn(-6) })}<span class="axis"><span>−6h</span><span>now</span><span>+12h</span></span>
    </div>
    <div class="tile">
      <span class="label">Barometric pressure</span>
      <div class="big"><b data-count="${c.p ?? 0}">${c.p ?? "—"}</b><small>hPa ${arrow}</small></div>
      <span class="sub">${c.press ? `${c.press}` : "—"}${c.dp3 != null ? ` · ${c.dp3 > 0 ? "+" : ""}${c.dp3} hPa in 3h` : ""}</span>
      ${spark(pSeries, { nowAt: nowIn(-24) })}<span class="axis"><span>−24h</span><span>now</span><span>+12h</span></span>
    </div>
    <div class="tile river${f ? "" : " muted"}">
      <span class="label">River gauge</span>
      ${f ? `<div class="big"><b>${f.value != null ? (f.value >= 100 ? Math.round(f.value) : f.value.toFixed(f.value >= 10 ? 1 : 2)) : "—"}</b><small>${esc(f.unit || "")}</small><span class="gauge-status s-${f.status.toLowerCase()}">${f.status} · ${esc(f.trend)}</span></div>
      <span class="sub">${esc(f.station)} · ${f.distKm} km away${f.picked ? " · your pick" : ""} · <button type="button" class="text-link" id="gaugeChange">Change</button></span>
      <div class="pct"><span style="left:${Math.round((f.pct ?? .5) * 100)}%"></span></div><span class="axis"><span>14-day low</span><span>${Math.round((f.pct ?? .5) * 100)}th percentile</span><span>high</span></span>
      ${f.series?.length > 3 ? spark(f.series.map(x => x[1]), { warn: f.status === "High", nowAt: f.series.length - 1 }) + `<span class="axis"><span>−14d</span><span></span><span>now</span></span>` : ""}`
      : `<span class="sub">No real-time gauge nearby, or the gauge service didn't answer.</span>`}
    </div>
    <div class="tile wind">
      <span class="label">Wind</span>
      <div class="wind-row">${compassSvg(c.dir)}<div class="big"><b data-count="${Math.round(c.wind ?? 0)}">${Math.round(c.wind ?? 0)}</b><small>km/h<br>${compassName(c.dir)}</small></div></div>
      <span class="sub">${windWord(c.wind)} · gusts ${Math.round(c.gust ?? 0)} km/h</span>
    </div>
    <div class="tile">
      <span class="label">Precipitation</span>
      <div class="big"><b>${r(rain48, 1)}</b><small>mm / 48h</small></div>
      <span class="sub">${pop12 ? `${pop12}% chance in the next 12h` : "Dry next 12h"}</span>
      <div class="bars-mini">${H.slice(Math.max(0, ni - 47), ni + 13).map((h, i) => `<span class="${i > 47 ? "fut" : ""}" style="height:${Math.min(100, (h.rain || 0) * 25 + (i > 47 ? (h.pop || 0) * .3 : 0))}%"></span>`).join("")}</div>
      <span class="axis"><span>−48h</span><span>now</span><span>+12h</span></span>
    </div>
    <div class="tile light">
      <span class="label">Light &amp; moon</span>
      <div class="big"><b>${sun ? fmtClock(!dark ? sun.set : now < sun.rise ? sun.rise : (nextSun || sun).rise) : "—"}</b><small>${dark ? "sunrise" : "sunset"}</small></div>
      <span class="sub">${esc(lightLine)}</span>
      <div class="moon"><span class="moon-disc" style="--lit:${mn.illum}%"></span><span>${mn.name} · ${mn.illum}% lit</span></div>
    </div>
    </div>
  </div>
  <div class="live-foot"><b>fishr Bite Index™ v0.3</b> · Proprietary scoring engine fusing live weather, barometric and hydrometric telemetry with a nearest-neighbour model that learns from your trips. Sources: Open-Meteo · ${f?.source === "USGS" ? "U.S. Geological Survey" : "Environment and Climate Change Canada"} · astronomical ephemeris.</div>`;
  $("liveRefresh").onclick = () => goLive(true);
  // Tap a factor chip to see why (factors from your own log, and species temperatures).
  box.querySelector(".drivers").onclick = e => {
    const b = e.target.closest("[data-why]"); if (!b) return;
    const why = $("drvWhy"), open = b.getAttribute("aria-expanded") === "true";
    box.querySelectorAll(".drv[data-why]").forEach(x => x.setAttribute("aria-expanded", "false"));
    why.hidden = open; why.textContent = open ? "" : b.dataset.why; if (!open) b.setAttribute("aria-expanded", "true");
  };
  const spSel = $("biteSp"); if (spSel) spSel.onchange = () => { state.settings.biteSpecies = spSel.value; save(); renderLive(); };
  const ch = $("liveChange"); if (ch) ch.onclick = () => { renderLive("town"); $("townIn").focus(); };
  const gc = $("gaugeChange"); if (gc) gc.onclick = openGaugePicker;
  if (!quiet) countUp(box);
}
/* ---------- choose the river gauge ---------- */
// The closest reporting gauge is used by default. If that's not the angler's water, they pick another one nearby;
// the pick applies to this area (see gaugePickFor in conditions.js), for live conditions and new trips alike.
async function openGaugePicker() {
  if (!wx) return;
  const { lat, lon } = wx, list = $("gaList");
  closeSheets(); $("scrim").hidden = false; $("gaugeSheet").hidden = false;
  list.innerHTML = `<p class="ga-msg">Finding gauges near you…</p>`;
  let gauges = null;
  try { const res = await fetch(`/api/water?lat=${lat.toFixed(3)}&lon=${lon.toFixed(3)}&list=1`); if (res.ok) gauges = (await res.json()).gauges; } catch (e) {}
  if ($("gaugeSheet").hidden) return;
  if (!Array.isArray(gauges) || !gauges.length) { list.innerHTML = `<p class="ga-msg">Couldn't load the gauges near you. Try again in a minute.</p>`; return; }
  const pick = gaugePickFor(lat, lon);
  list.innerHTML = `<button type="button" class="ga-opt${pick ? "" : " on"}" data-st="" role="listitem"><b>Closest (automatic)</b><span>The nearest gauge that's reporting</span></button>`
    + gauges.map(g => { const st = `${g.source}:${g.id}`; return `<button type="button" class="ga-opt${pick?.station === st ? " on" : ""}" role="listitem" data-st="${esc(st)}" data-name="${esc(g.name)}"><b>${esc(g.name)}</b><span>${g.distKm} km · ${g.source === "USGS" ? "U.S. Geological Survey" : "Environment Canada"}</span></button>`; }).join("");
}
$("gaList").onclick = async e => {
  const b = e.target.closest(".ga-opt"); if (!b || !wx) return;
  const st = b.dataset.st || null, name = b.dataset.name || "";
  setGaugePick(wx.lat, wx.lon, st, name);
  closeSheets();
  wx.flow = await fetchWater(wx.lat, wx.lon).catch(() => null);
  if (!demo) { segSet($("aFlow"), wx.flow ? [wx.flow.status] : []); if (wx.flow) $("aWeatherMsg").textContent = `River gauge: ${wx.flow.station}, ${wx.flow.status.toLowerCase()} water, ${wx.flow.trend}.`; }
  renderAdvice(); renderLive();
  toast(!wx.flow ? "Couldn't reach the river gauges just now. Try again in a minute." : st ? (wx.flow.picked ? `Using ${name}` : `${name} isn't reporting right now, so fishr is using the closest gauge.`) : "Using the closest gauge");
};
$("gaClose").onclick = closeSheets;

const compassName = deg => deg == null ? "" : ["N", "NE", "E", "SE", "S", "SW", "W", "NW"][Math.round(((deg % 360) + 360) % 360 / 45) % 8];
function countUp(root) {
  if (matchMedia("(prefers-reduced-motion: reduce)").matches) return;
  root.querySelectorAll("[data-count]").forEach(el => {
    const end = +el.dataset.count; if (!Number.isFinite(end) || end === 0) return;
    const t0 = performance.now(), dur = 700;
    const step = t => { const k = Math.min(1, (t - t0) / dur), e = 1 - (1 - k) ** 3; el.textContent = Math.round(end * e); if (k < 1) requestAnimationFrame(step); };
    requestAnimationFrame(step);
  });
}

renderLive();
// Anything that redraws the app (units changed, sample opened or closed, a trip saved) redraws the live card too,
// without replaying the number animation. Not while the "type your town" box is open.
{ const _render = render; render = function () { _render(); if (wx && !$("townForm")) renderLive(undefined, true); }; }
if (!$("panel-advice").hidden) autoLive();
