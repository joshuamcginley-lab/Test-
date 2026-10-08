"use strict";
const $ = id => document.getElementById(id);
const esc = s => String(s ?? "").replace(/[&<>"']/g, c => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));

// Common North American sport fish, grouped for the species picker. People can still type anything.
const SPECIES_GROUPS = [
  ["Bass", ["Smallmouth bass", "Largemouth bass", "Spotted bass", "Striped bass", "White bass", "Rock bass"]],
  ["Trout, salmon & char", ["Brook trout", "Rainbow trout", "Brown trout", "Lake trout", "Cutthroat trout", "Steelhead", "Atlantic salmon", "Chinook salmon", "Coho salmon", "Sockeye salmon", "Pink salmon", "Arctic char", "Splake"]],
  ["Pike & muskie", ["Northern pike", "Muskie", "Tiger muskie", "Pickerel"]],
  ["Walleye & perch", ["Walleye", "Sauger", "Yellow perch", "White perch"]],
  ["Panfish", ["Bluegill", "Pumpkinseed", "Black crappie", "White crappie", "Redear sunfish", "Green sunfish"]],
  ["Catfish", ["Channel catfish", "Blue catfish", "Flathead catfish", "Bullhead"]],
  ["Other freshwater", ["Common carp", "Chub", "Fallfish", "Freshwater drum", "Lake whitefish", "Burbot", "Bowfin", "Gar", "Sturgeon", "American shad"]],
  ["Saltwater", ["Striped bass", "Bluefish", "Mackerel", "Red drum", "Snook", "Tarpon", "Atlantic cod", "Halibut", "Flounder"]],
];
const SPECIES = [...new Set(SPECIES_GROUPS.flatMap(g => g[1]))];
const LURES = ["Curly tail grub","Chatterbait","Spinnerbait","Crankbait","Jerkbait","Paddle tail","Swimbait","Wacky worm","Ned rig","Drop shot","Texas rig","Tube","Jig","Inline spinner","Spoon","Topwater frog","Popper","Walking bait","Live bait","Worm","Dry fly","Nymph","Streamer","Wet fly"];
const CONDS = ["Sunny","Overcast","Rain","Windy","Calm","High water","Low water","Warm water","Cold front"];
const MONTHS = ["Jan","Feb","Mar","Apr","May","Jun","Jul","Aug","Sep","Oct","Nov","Dec"];
const PERIODS = ["Morning","Midday","Afternoon","Evening"];
const SAMPLE_NOTES = [
  "Evening at Keswick, 19–27°C, chatterbait or white curly tail: strongest producer of the season.",
  "Rain / overcast = reaction baits.",
  "High water after rain = poor. Roughly two-thirds drop in output.",
  "Below ~15°C, catches shift to trout, chub and pickerel. Smallmouth go quiet.",
  "Midday in 25°C+ heat = skunk risk.",
  "Topwater frog hookup rate is 0 for 7. Check hook gap and hookset timing."
];
const KEY = "firetiger.v1";

/* ---------- storage ---------- */
let state = { sessions: [], notes: [], settings: { name: "", units: "imperial", temp: "C", season: null, maps: "auto" } };
let demo = null; // the person's own trips, set aside while the sample season is on screen
function load() {
  try { const raw = localStorage.getItem(KEY); if (raw) { const s = JSON.parse(raw); state = { ...state, ...s, settings: { ...state.settings, ...(s.settings || {}) } }; } }
  catch (e) { console.warn("Could not read saved log", e); }
  // The sample used to be saved into the log; it's view-only now.
  state.sessions = state.sessions.filter(s => !s.sample);
  if (state.notes.join() === SAMPLE_NOTES.join()) state.notes = [];
}
function save() {
  const out = demo ? { ...state, sessions: demo.sessions, notes: demo.notes, settings: { ...state.settings, season: demo.season } } : state;
  try { localStorage.setItem(KEY, JSON.stringify(out)); return true; }
  catch (e) { toast("Couldn't save. Your phone may be out of storage."); return false; }
}
if (navigator.storage && navigator.storage.persist) navigator.storage.persist().catch(() => {});

/* ---------- units ---------- */
const U = () => state.settings.units, T = () => state.settings.temp;
const r = (v, d) => Math.round(v * 10 ** d) / 10 ** d;
const wtOut = lb => lb == null ? null : U() === "metric" ? r(lb * 0.45359, 2) : lb;
const wtIn = v => v == null ? null : U() === "metric" ? r(v / 0.45359, 3) : v;
const lenOut = i => i == null ? null : U() === "metric" ? r(i * 2.54, 1) : i;
const lenIn = v => v == null ? null : U() === "metric" ? r(v / 2.54, 2) : v;
const tOut = c => c == null ? null : T() === "F" ? Math.round(c * 9 / 5 + 32) : c;
const tIn = v => v == null ? null : T() === "F" ? r((v - 32) * 5 / 9, 1) : v;
const wU = () => U() === "metric" ? "kg" : "lb";
const lU = () => U() === "metric" ? "cm" : "in";
const fmtW = lb => lb == null ? "" : `${wtOut(lb)} ${wU()}`;
const fmtL = i => i == null ? "" : U() === "metric" ? `${lenOut(i)} cm` : `${i}"`;
const fmtT = c => c == null ? "" : `${tOut(c)}°${T()}`;

/* ---------- photos (IndexedDB) ---------- */
// Photos are too big for localStorage, so each one is a JPEG blob in IndexedDB keyed by id; catches store the id.
let idbP = null;
function idb() {
  return idbP ??= new Promise((res, rej) => {
    const rq = indexedDB.open("firetiger-photos", 1);
    rq.onupgradeneeded = () => rq.result.createObjectStore("photos");
    rq.onsuccess = () => res(rq.result); rq.onerror = () => rej(rq.error);
  });
}
async function idbDo(mode, fn) {
  const db = await idb();
  return new Promise((res, rej) => {
    const tx = db.transaction("photos", mode), rq = fn(tx.objectStore("photos"));
    tx.oncomplete = () => res(rq?.result); tx.onerror = tx.onabort = () => rej(tx.error);
  });
}
const photoPut = (id, blob) => idbDo("readwrite", s => s.put(blob, id));
const photoGet = id => idbDo("readonly", s => s.get(id));
const photoDel = ids => ids.length ? idbDo("readwrite", s => { ids.forEach(i => s.delete(i)); }) : Promise.resolve();
const photoClear = () => idbDo("readwrite", s => s.clear());
const photoUrls = new Map();
async function photoURL(id) {
  if (photoUrls.has(id)) return photoUrls.get(id);
  // Not on this phone? With Cloud on, fetch it from the account (cloud.js).
  const blob = await photoGet(id).catch(() => null) || (typeof cloudPhoto === "function" ? await cloudPhoto(id) : null); if (!blob) return null;
  const u = URL.createObjectURL(blob); photoUrls.set(id, u); return u;
}
const photoIdsOf = s => (s?.catches || []).map(c => c.photo).filter(Boolean);
async function shrinkPhoto(file, max = 1600) {
  let img;
  try { img = await createImageBitmap(file, { imageOrientation: "from-image" }); }
  catch (e) { img = await new Promise((res, rej) => { const i = new Image(); i.onload = () => res(i); i.onerror = rej; i.src = URL.createObjectURL(file); }); }
  const w = img.width, h = img.height, k = Math.min(1, max / Math.max(w, h));
  const c = document.createElement("canvas"); c.width = Math.round(w * k); c.height = Math.round(h * k);
  c.getContext("2d").drawImage(img, 0, 0, c.width, c.height);
  return new Promise((res, rej) => c.toBlob(b => b ? res(b) : rej(new Error("encode")), "image/jpeg", 0.82));
}
// Fill every <img data-photo> on the page from storage.
function hydratePhotos(root = document) {
  root.querySelectorAll("img[data-photo]:not([src])").forEach(async im => { const u = await photoURL(im.dataset.photo); if (u) im.src = u; else im.closest(".thumb")?.remove(); });
}

/* ---------- maps ---------- */
// Apple devices open Apple Maps, everything else Google Maps, unless overridden in Settings.
const isApple = () => /iPhone|iPad|iPod|Macintosh/.test(navigator.userAgent);
const useApple = () => state.settings.maps === "apple" || (state.settings.maps !== "google" && isApple());
function mapsUrl(lat, lon, label, directions) {
  if (useApple()) return `https://maps.apple.com/?${directions ? "daddr" : "ll"}=${lat},${lon}${!directions && label ? `&q=${encodeURIComponent(label)}` : ""}`;
  return directions ? `https://www.google.com/maps/dir/?api=1&destination=${lat},${lon}` : `https://www.google.com/maps/search/?api=1&query=${lat},${lon}`;
}
const mapsName = () => useApple() ? "Apple Maps" : "Google Maps";
// Read coordinates from typed text or a pasted Apple / Google Maps link.
function parseCoords(text) {
  const t = decodeURIComponent(String(text || "")).trim();
  const pats = [/[?&](?:ll|sll|q|query|destination|daddr|coordinate|center)=(-?\d+\.\d+),\s*(-?\d+\.\d+)/, /!3d(-?\d+\.\d+)!4d(-?\d+\.\d+)/, /@(-?\d+\.\d+),(-?\d+\.\d+)/, /^(-?\d+(?:\.\d+)?)\s*[, ]\s*(-?\d+(?:\.\d+)?)$/];
  for (const re of pats) { const m = t.match(re); if (m) { const lat = +m[1], lon = +m[2]; if (Math.abs(lat) <= 90 && Math.abs(lon) <= 180) return { lat: r(lat, 5), lon: r(lon, 5) }; } }
  return null;
}

/* ---------- derived ---------- */
const fishOf = s => (s.catches || []).reduce((a, c) => a + (+c.count || 0), 0);
const avgT = s => s.tempLow == null ? null : (s.tempLow + (s.tempHigh ?? s.tempLow)) / 2;
function periodOf(start, end) {
  if (!start) return null;
  const h = t => { const [a, b] = t.split(":").map(Number); return a + b / 60; };
  const m = end ? (h(start) + h(end)) / 2 : h(start);
  return m < 11 ? "Morning" : m < 15 ? "Midday" : m < 18 ? "Afternoon" : "Evening";
}
const BAND_C = [[-99, 10], [10, 15], [15, 20], [20, 25], [25, 99]];
function bandLabel(i) {
  const [lo, hi] = BAND_C[i], u = `°${T()}`;
  if (lo === -99) return `Under ${tOut(hi)}${u}`;
  if (hi === 99) return `${tOut(lo)}${u} +`;
  return `${tOut(lo)}–${tOut(hi) - 1}${u}`;
}
const tempBand = t => t == null ? null : BAND_C.findIndex(([lo, hi]) => t >= lo && t < hi);
const fmtDate = d => { const [, m, day] = d.split("-").map(Number); return `${MONTHS[m - 1]} ${day}`; };
function fmtTime(t) { if (!t) return ""; let [h, m] = t.split(":").map(Number); const ap = h >= 12 ? "PM" : "AM"; h = h % 12 || 12; return m ? `${h}:${String(m).padStart(2, "0")} ${ap}` : `${h} ${ap}`; }
function catchSummary(s) {
  if (!fishOf(s)) return "Skunked";
  const by = {}; for (const c of s.catches) by[c.species] = (by[c.species] || 0) + (+c.count || 0);
  return Object.entries(by).map(([k, v]) => `${v} ${k.toLowerCase()}`).join(", ");
}
function sizeOf(c) {
  if (c.size && U() === "imperial") return c.size;
  return [c.lb != null ? fmtW(c.lb) : "", c.inches != null ? fmtL(c.inches) : ""].filter(Boolean).join(" · ");
}
const isPeriod = s => s.period || periodOf(s.start, s.end);
// River level from the gauge reading, or from the High water / Low water tags people set themselves.
const waterLevelOf = s => s.flow?.status || ((s.conditions || []).includes("High water") ? "High" : (s.conditions || []).includes("Low water") ? "Low" : null);

/* ---------- season filter ---------- */
const years = () => [...new Set(state.sessions.map(s => s.date.slice(0, 4)))].sort().reverse();
function view() {
  const y = state.settings.season;
  return y && y !== "all" ? state.sessions.filter(s => s.date.startsWith(y)) : state.sessions;
}
function group(list, keyFn) {
  const m = new Map();
  for (const s of list) {
    const k = keyFn(s); if (k == null || k === -1) continue;
    if (!m.has(k)) m.set(k, { k, n: 0, fish: 0, skunk: 0 });
    const g = m.get(k), f = fishOf(s); g.n++; g.fish += f; if (!f) g.skunk++;
  }
  return [...m.values()];
}

/* ---------- render ---------- */
function render() {
  const ys = years();
  if (!state.settings.season || (state.settings.season !== "all" && !ys.includes(state.settings.season))) state.settings.season = ys[0] || "all";
  $("seasonSel").innerHTML = ys.map(y => `<option value="${y}">${y}</option>`).join("") + `<option value="all">All time</option>`;
  $("seasonSel").value = state.settings.season;
  $("wsLine").textContent = state.sessions.length === 0 ? "" : demo ? "Sample season" : state.settings.name ? `${state.settings.name}'s workspace` : "";
  $("topSample").hidden = !!demo;
  document.title = state.settings.name ? `${state.settings.name}'s workspace · fishr.ai` : "fishr.ai · Know where they're biting";

  const empty = state.sessions.length === 0;
  $("welcome").hidden = !empty; $("main").hidden = empty; $("seasonSel").parentElement.hidden = empty;
  $("hero").hidden = !empty; $("gauges").hidden = empty; $("topSample").hidden = !!demo || empty;
  $("sampleBar").hidden = !demo; if (!demo) $("sampleInfo").hidden = true;
  document.body.classList.toggle("has-dock", !empty);

  const list = view();
  const total = list.reduce((a, s) => a + fishOf(s), 0), n = list.length, sk = list.filter(s => !fishOf(s)).length;
  let pb = null; for (const s of list) for (const c of s.catches || []) if (c.lb && (!pb || c.lb > pb.c.lb)) pb = { c, s };
  const waters = new Set(list.map(s => s.water));
  $("gauges").innerHTML = [
    ["Trips", n, "", `${waters.size} water${waters.size === 1 ? "" : "s"} fished`],
    ["Fish", total, "", `${n ? (total / n).toFixed(1) : 0} per trip`],
    ["Skunked", n ? Math.round(sk / n * 100) : 0, "%", `${sk} of ${n} trips`],
    ["Personal best", pb ? wtOut(pb.c.lb) : "—", pb ? wU() : "", pb ? `${pb.c.species} · ${fmtDate(pb.s.date)}` : "Log a weight to set one"],
  ].map(([l, v, u, d], i) => `<div class="stat${i === 3 ? " pb" : ""}"><span class="k">${l}</span><span class="v">${esc(v)}${u ? `<small>${u}</small>` : ""}</span><span class="d">${esc(d)}</span></div>`).join("");

  if (empty) { fillLists(); return; }

  const sp = {}; for (const s of list) for (const c of s.catches || []) sp[c.species] = (sp[c.species] || 0) + (+c.count || 0);
  const spE = Object.entries(sp).sort((a, b) => b[1] - a[1]), spMax = spE[0]?.[1] || 1;
  $("speciesBars").innerHTML = spE.map(([k, v], i) => `<div class="bar${i === 0 ? " sm" : ""}"><span>${esc(k)}</span><span class="track"><span class="fill" style="width:${v / spMax * 100}%;display:block"></span></span><span class="n">${v}</span></div>`).join("") || `<p class="label">No fish yet this season</p>`;

  const months = {}; for (const s of list) { const m = +s.date.slice(5, 7); months[m] ??= { n: 0, f: 0 }; months[m].n++; months[m].f += fishOf(s); }
  const mk = Object.keys(months).map(Number).sort((a, b) => a - b);
  if (mk.length) {
    const W = 420, H = 200, P = { l: 34, r: 8, t: 18, b: 30 }, rate = mk.map(m => months[m].f / months[m].n), max = Math.max(1, Math.ceil(Math.max(...rate)));
    const bw = (W - P.l - P.r) / mk.length, y = v => H - P.b - (v / max) * (H - P.t - P.b);
    let g = ""; const step = Math.max(1, Math.round(max / 4));
    for (let v = 0; v <= max; v += step) g += `<line x1="${P.l}" x2="${W - P.r}" y1="${y(v)}" y2="${y(v)}" stroke="var(--line)"/><text x="${P.l - 6}" y="${y(v) + 4}" text-anchor="end" font-size="11" fill="var(--muted)" font-family="Geist Mono,monospace">${v}</text>`;
    mk.forEach((m, i) => { const rt = rate[i], x = P.l + i * bw + bw * .18, w = bw * .64; g += `<rect x="${x}" y="${y(rt)}" width="${w}" height="${H - P.b - y(rt)}" rx="6" fill="url(#barGrad)"/><text x="${x + w / 2}" y="${y(rt) - 6}" text-anchor="middle" font-size="12" fill="var(--ink)" font-family="Geist Mono,monospace">${rt.toFixed(1)}</text><text x="${x + w / 2}" y="${H - 10}" text-anchor="middle" font-size="12" fill="var(--muted)">${MONTHS[m - 1]} (${months[m].n})</text>`; });
    $("monthChart").innerHTML = `<svg class="month-chart" viewBox="0 0 ${W} ${H}" role="img" aria-label="Fish per trip by month"><defs><linearGradient id="barGrad" x1="0" y1="0" x2="0" y2="1"><stop offset="0" style="stop-color:var(--v)"/><stop offset="1" style="stop-color:var(--m)"/></linearGradient></defs>${g}</svg><p class="label" style="margin:6px 0 0">Trips per month in brackets</p>`;
  }

  const big = []; for (const s of list) for (const c of s.catches || []) if (c.lb || c.inches) big.push({ c, s });
  big.sort((a, b) => (b.c.lb || 0) - (a.c.lb || 0) || (b.c.inches || 0) - (a.c.inches || 0));
  $("bigFish").innerHTML = `<tr><th>Fish</th><th class="r">${wU()}</th><th class="r">${lU()}</th><th>Where</th><th>Lure</th></tr>` + big.slice(0, 8).map(({ c, s }) => `<tr><td>${c.photo ? `<button type="button" class="thumb sm" data-view="${esc(s.id)}|${esc(c.photo)}" aria-label="View photo"><img data-photo="${esc(c.photo)}" alt=""></button>` : ""}${esc(c.species)}</td><td class="r">${wtOut(c.lb) ?? "—"}</td><td class="r">${lenOut(c.inches) ?? "—"}</td><td>${esc(s.water)} · ${fmtDate(s.date)}</td><td>${esc(c.lure || "—")}</td></tr>`).join("");

  hydratePhotos($("bigFish"));
  $("notesList").innerHTML = state.notes.length ? state.notes.map(t => `<li>${esc(t)}</li>`).join("") : `<li style="display:block;color:var(--muted)">Write down the patterns you've confirmed on the water. They show up here, next to the numbers.</li>`;

  renderPatterns(list); renderLog(); fillLists();
}

function tableHTML(rows, head) {
  const maxR = Math.max(...rows.map(r => r.n ? r.fish / r.n : 0), 0.01);
  return `<tr><th>${head}</th><th class="r">Trips</th><th class="r">Fish</th><th class="r">Per trip</th><th></th><th class="r">Skunk</th></tr>` + rows.map(r => {
    const rate = r.n ? r.fish / r.n : 0, skp = r.n ? Math.round(r.skunk / r.n * 100) : 0;
    return `<tr><td>${esc(r.label ?? r.k)}</td><td class="r">${r.n}</td><td class="r">${r.fish}</td><td class="r">${rate.toFixed(1)}</td><td><span class="spark" style="width:${Math.max(2, rate / maxR * 70)}px"></span></td><td class="r skunkpct${skp >= 50 && r.n >= 2 ? " hi" : ""}">${skp}%</td></tr>`;
  }).join("") || `<tr><td colspan="6" style="color:var(--muted)">Not enough trips yet</td></tr>`;
}

function renderPatterns(list) {
  const water = group(list, s => s.water).sort((a, b) => b.n - a.n || b.fish - a.fish);
  const period = group(list, isPeriod).sort((a, b) => PERIODS.indexOf(a.k) - PERIODS.indexOf(b.k));
  const temp = group(list, s => tempBand(avgT(s))).sort((a, b) => a.k - b.k).map(g => ({ ...g, label: bandLabel(g.k) }));
  $("tWater").innerHTML = tableHTML(water, "Water");
  $("tPeriod").innerHTML = tableHTML(period, "Time");
  $("tTemp").innerHTML = tableHTML(temp, "Avg temp");
  const order = (a, list) => list.indexOf(a.k);
  const press = group(list, s => s.wx?.trend || null).sort((a, b) => order(a, ["Falling", "Steady", "Rising"]) - order(b, ["Falling", "Steady", "Rising"]));
  const flow = group(list, waterLevelOf).sort((a, b) => order(a, ["Low", "Normal", "High"]) - order(b, ["Low", "Normal", "High"]));
  const emptyRow = msg => `<tr><td style="white-space:normal;color:var(--muted)">${msg}</td></tr>`;
  $("pressNote").hidden = !(demo && press.length);
  $("tPress").innerHTML = press.length ? tableHTML(press, "Pressure") : emptyRow("Trips logged with auto-filled conditions show here. For older trips, use Settings → Add weather to past trips.");
  $("tFlow").innerHTML = flow.length ? tableHTML(flow, "River") : emptyRow(demo ? "River gauges only keep about a month of live readings, so the sample season has none. Trips you log get the nearest gauge's level automatically." : "Trips logged with auto-filled conditions show here, or tag trips High water / Low water.");

  const lu = {};
  for (const s of list) for (const c of s.catches || []) { if (!c.lure) continue; lu[c.lure] ??= { fish: 0, trips: new Set(), big: 0 }; lu[c.lure].fish += +c.count || 0; lu[c.lure].trips.add(s); lu[c.lure].big = Math.max(lu[c.lure].big, +c.lb || 0); }
  const lr = Object.entries(lu).sort((a, b) => b[1].fish - a[1].fish);
  $("tLure").innerHTML = `<tr><th>Lure</th><th class="r">Fish</th><th class="r">Trips</th><th class="r">Biggest</th></tr>` + lr.map(([k, v]) => `<tr><td>${esc(k)}</td><td class="r">${v.fish}</td><td class="r">${v.trips.size}</td><td class="r">${v.big ? fmtW(v.big) : "—"}</td></tr>`).join("") + `<tr><td colspan="4" class="label" style="white-space:normal;border:0;padding-top:10px">Counts fish where you picked a lure for that fish.</td></tr>`;

  const out = [];
  const combo = group(list, s => { const p = isPeriod(s); return p ? `${s.water} · ${p}` : null; }).filter(g => g.n >= 3).sort((a, b) => b.fish / b.n - a.fish / a.n);
  if (combo[0]) out.push(["go", "Best bet", `<b>${esc(combo[0].k)}</b>: ${(combo[0].fish / combo[0].n).toFixed(1)} fish per trip over ${combo[0].n} trips, ${Math.round(combo[0].skunk / combo[0].n * 100)}% skunked.`]);
  const hot = list.filter(s => { const p = isPeriod(s); return (p === "Midday" || p === "Afternoon") && avgT(s) != null && avgT(s) >= 25; });
  if (hot.length >= 2) { const z = hot.filter(s => !fishOf(s)).length; out.push(["no", "Watch out", `Midday or afternoon at ${fmtT(25)}+: <b>${z} of ${hot.length}</b> trips skunked, ${(hot.reduce((a, s) => a + fishOf(s), 0) / hot.length).toFixed(1)} fish per trip.`]); }
  const bigL = []; for (const s of list) for (const c of s.catches || []) if (c.lb >= 2 && c.lure) bigL.push(c.lure);
  if (bigL.length >= 2) { const t = {}; bigL.forEach(l => t[l] = (t[l] || 0) + 1); const top = Object.entries(t).sort((a, b) => b[1] - a[1])[0]; out.push(["info", "Big fish", `${top[1]} of ${bigL.length} fish of ${fmtW(2)}+ came on a <b>${esc(top[0].toLowerCase())}</b>.`]); }
  const cold = list.filter(s => avgT(s) != null && avgT(s) < 15);
  if (cold.length >= 2) { const all = cold.reduce((a, s) => a + fishOf(s), 0); const sp = {}; cold.forEach(s => (s.catches || []).forEach(c => sp[c.species] = (sp[c.species] || 0) + c.count)); const top = Object.entries(sp).sort((a, b) => b[1] - a[1])[0]; out.push(["info", "Cold water", `Under ${fmtT(15)}: ${all} fish in ${cold.length} trips${top ? `, mostly ${esc(top[0].toLowerCase())}` : ""}.`]); }
  const meth = group(list, s => s.method).filter(g => g.n >= 2);
  if (meth.length > 1) out.push(["info", "Method", meth.map(g => `${esc(g.k)}: ${(g.fish / g.n).toFixed(1)} per trip`).join(" · ")]);
  $("callouts").innerHTML = out.length ? out.map(([cls, l, t]) => `<div class="callout"><span class="chip ${cls}">${l}</span><span>${t}</span></div>`).join("") : `<div class="callout"><span class="chip info">Patterns</span><span>Log a few more trips and your patterns show up here.</span></div>`;
}

function renderLog() {
  const list = view();
  const fw = $("fWater").value, fs = $("fSpecies").value, fr = $("fResult").value;
  let pbLb = 0; for (const s of list) for (const c of s.catches || []) pbLb = Math.max(pbLb, +c.lb || 0);
  const shown = [...list].sort((a, b) => b.date.localeCompare(a.date) || (b.start || "").localeCompare(a.start || ""))
    .filter(s => (!fw || s.water === fw) && (!fs || (s.catches || []).some(c => c.species === fs)) && (!fr || (fr === "skunk" ? !fishOf(s) : fishOf(s) > 0)));
  $("entries").innerHTML = shown.map(s => {
    const f = fishOf(s), isPb = pbLb && (s.catches || []).some(c => c.lb === pbLb);
    const temp = s.tempLow != null ? (s.tempHigh != null && s.tempHigh !== s.tempLow ? `${tOut(s.tempLow)}–${fmtT(s.tempHigh)}` : fmtT(s.tempLow)) : null;
    const t = [s.start ? fmtTime(s.start) + (s.end ? "–" + fmtTime(s.end) : "") : null, temp, s.wx?.p ? `${s.wx.p} hPa ${s.wx.trend === "Rising" ? "↑" : s.wx.trend === "Falling" ? "↓" : "→"}` : null, s.method && s.method !== "Spin" ? s.method : null, s.event, ...(s.conditions || [])].filter(Boolean).join(" · ");
    const sizes = (s.catches || []).map(sizeOf).filter(Boolean);
    return `<button class="entry${isPb ? " pb" : ""}" type="button" data-id="${esc(s.id)}"><span class="date"><b>${+s.date.slice(8)}</b><span class="m">${MONTHS[+s.date.slice(5, 7) - 1]}</span><small>${esc(isPeriod(s) || "")}</small></span>
      <span class="body"><span class="where">${esc(s.water)}${s.spot ? ` <span>· ${esc(s.spot)}</span>` : ""}</span>${isPb ? `<span class="pbtag">PB</span>` : ""}<br><span class="meta">${esc(t)}</span>${s.lat != null ? ` <span class="maplink" role="link" tabindex="0" data-map="${s.lat},${s.lon}" data-label="${esc([s.water, s.spot].filter(Boolean).join(" · "))}">Map ↗</span>` : ""}
      <div class="catch">${esc(catchSummary(s))}${sizes.length ? ` <span class="meta">(${esc(sizes.join(", "))})</span>` : ""}</div>
      ${photoIdsOf(s).length ? `<span class="thumbs">${(s.catches || []).filter(c => c.photo).map(c => `<span class="thumb" role="button" tabindex="0" data-view="${esc(s.id)}|${esc(c.photo)}" aria-label="View ${esc(c.species)} photo"><img data-photo="${esc(c.photo)}" alt=""></span>`).join("")}</span>` : ""}
      ${s.lureText ? `<div class="lures">${esc(s.lureText)}</div>` : ""}${s.notes ? `<div class="lures"><i>${esc(s.notes)}</i></div>` : ""}</span>
      <span class="tally">${f ? `<b>${f}</b><span>fish</span><span class="share-chip" role="button" tabindex="0" data-share="${esc(s.id)}" aria-label="Share this catch">Share</span>` : `<span class="stamp">Skunked</span>`}</span></button>`;
  }).join("") || `<p class="status">No trips match these filters.</p>`;
  hydratePhotos($("entries"));
}

function fillLists() {
  const all = state.sessions, uniq = a => [...new Set(a.filter(Boolean))].sort();
  const keep = (sel, vals, lbl) => { const v = sel.value; sel.innerHTML = `<option value="">${lbl}</option>` + vals.map(x => `<option${x === v ? " selected" : ""}>${esc(x)}</option>`).join(""); };
  keep($("fWater"), uniq(view().map(s => s.water)), "All waters");
  keep($("fSpecies"), uniq(view().flatMap(s => (s.catches || []).map(c => c.species))), "All species");
  const dl = (id, vals) => $(id).innerHTML = vals.map(v => `<option value="${esc(v)}">`).join("");
  dl("dlWater", uniq(all.map(s => s.water))); dl("dlSpot", uniq(all.map(s => s.spot)));
  dl("dlCombo", uniq(all.map(s => s.combo)));
  dl("dlSpecies", uniq([...SPECIES, ...all.flatMap(s => (s.catches || []).map(c => c.species))]));
  dl("dlLure", uniq([...LURES, ...all.flatMap(s => (s.catches || []).map(c => c.lure))]));
}

/* ---------- tabs & filters ---------- */
const TAB_TITLES = { advice: "Copilot", season: "Stats", patterns: "Insights", log: "Trips" };
function showTab(t) {
  const was = document.querySelector('nav.tabs [aria-selected="true"]')?.dataset.tab;
  for (const b of document.querySelectorAll("nav.tabs button")) b.setAttribute("aria-selected", b.dataset.tab === t);
  for (const p of ["advice", "season", "patterns", "log"]) $("panel-" + p).hidden = p !== t;
  $("screenTitle").textContent = TAB_TITLES[t] || "";
  $("seasonSel").parentElement.classList.toggle("off", t === "advice");
  if (was && was !== t) {
    const panel = $("panel-" + t); panel.classList.remove("enter"); void panel.offsetWidth; panel.classList.add("enter");
    if (typeof haptic === "function") haptic();
    if (window.scrollY > 0) window.scrollTo({ top: 0 });
  }
  try { sessionStorage.setItem("ft-tab", t); } catch (e) {}
  if (t === "advice" && typeof autoLive === "function") autoLive();
  if (t === "log" && typeof renderMap === "function") renderMap();
}
document.querySelector("nav.tabs").addEventListener("click", e => { const b = e.target.closest("button[data-tab]"); if (b) showTab(b.dataset.tab); });
["fWater", "fSpecies", "fResult"].forEach(id => $(id).addEventListener("change", renderLog));
$("seasonSel").addEventListener("change", () => { state.settings.season = $("seasonSel").value; save(); $("fWater").value = ""; $("fSpecies").value = ""; render(); });

/* ---------- trip form ---------- */
let editingId = null, pinned = null;
function catchRow(c = {}) {
  const d = document.createElement("div"); d.className = "catch-row";
  d.innerHTML = `<div class="field sp"><span class="label">Species</span><div class="combo"><input class="c-sp" autocomplete="off" autocapitalize="words" role="combobox" aria-autocomplete="list" aria-expanded="false" value="${esc(c.species || "")}" placeholder="Type or pick a fish" aria-label="Species"><button type="button" class="combo-btn" aria-label="Show fish list" tabindex="-1"><svg viewBox="0 0 24 24" width="18" height="18" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"><path d="M6 9l6 6 6-6"/></svg></button><div class="combo-list" role="listbox" hidden></div></div></div>
  <label class="field"><span class="label">Count</span><input class="c-n" type="number" min="1" inputmode="numeric" value="${esc(c.count || 1)}"></label>
  <label class="field"><span class="label">${wU()} each</span><input class="c-lb" type="number" step="0.01" min="0" inputmode="decimal" value="${esc(wtOut(c.lb) ?? "")}"></label>
  <label class="field"><span class="label">${lU()}</span><input class="c-in" type="number" step="0.5" min="0" inputmode="decimal" value="${esc(lenOut(c.inches) ?? "")}"></label>
  <label class="field lu"><span class="label">Lure</span><input class="c-lu" list="dlLure" autocomplete="off" value="${esc(c.lure || "")}" placeholder="Curly tail grub"></label>
  <button type="button" class="x" aria-label="Remove this fish">✕</button>
  <div class="c-photo"><span class="thumb" hidden><img alt="Fish photo"></span><label class="photo-btn"><input type="file" accept="image/*" hidden><span>+ Add photo</span></label><button type="button" class="id-photo" hidden><svg viewBox="0 0 24 24" aria-hidden="true"><path d="M12 3c.9 4.2 2.8 6.1 7 7-4.2.9-6.1 2.8-7 7-.9-4.2-2.8-6.1-7-7 4.2-.9 6.1-2.8 7-7z" fill="currentColor"/></svg>fishr ID</button><button type="button" class="linkbtn rm-photo" hidden>Remove photo</button><span class="photo-msg"></span></div>`;
  d.querySelector(".x").onclick = () => d.remove();
  speciesPicker(d.querySelector(".combo"));
  const thumb = d.querySelector(".c-photo .thumb"), tImg = thumb.querySelector("img"), btnTxt = d.querySelector(".photo-btn span"), rm = d.querySelector(".rm-photo"), msg = d.querySelector(".photo-msg");
  const idBtn = d.querySelector(".id-photo");
  const showThumb = url => { thumb.hidden = !url; if (url) tImg.src = url; rm.hidden = idBtn.hidden = !url; btnTxt.textContent = url ? "Change photo" : "+ Add photo"; };
  if (c.photo) { d.dataset.photo = c.photo; photoURL(c.photo).then(showThumb); }
  d.querySelector(".c-photo input").addEventListener("change", async e => {
    const f = e.target.files[0]; e.target.value = ""; if (!f) return;
    msg.textContent = "Preparing photo…";
    try { d._photoBlob = await shrinkPhoto(f); d.dataset.photoRemoved = ""; showThumb(URL.createObjectURL(d._photoBlob)); msg.textContent = ""; if (typeof onPhotoReady === "function") onPhotoReady(d); }
    catch (err) { msg.textContent = "Couldn't read that image. Try a JPEG or PNG."; }
  });
  d.setPhoto = blob => { d._photoBlob = blob; d.dataset.photoRemoved = ""; showThumb(URL.createObjectURL(blob)); };
  rm.onclick = () => { d._photoBlob = null; d.dataset.photoRemoved = "1"; showThumb(null); msg.textContent = ""; };
  if (c.size) d.dataset.size = c.size;
  if (c.lb != null) d.dataset.lb = c.lb;
  if (c.inches != null) d.dataset.in = c.inches;
  return d;
}
/* ---------- species picker: type freely, or open a grouped list of common fish ---------- */
function recentSpecies() {
  const n = {}; for (const s of state.sessions) for (const c of s.catches || []) if (c.species) n[c.species] = (n[c.species] || 0) + 1;
  return Object.entries(n).sort((a, b) => b[1] - a[1]).slice(0, 5).map(x => x[0]);
}
function speciesPicker(box) {
  const input = box.querySelector("input"), list = box.querySelector(".combo-list"), btn = box.querySelector(".combo-btn");
  const draw = (q = "") => {
    const ql = q.trim().toLowerCase(), match = s => !ql || s.toLowerCase().includes(ql);
    const groups = [["Your fish", recentSpecies()], ...SPECIES_GROUPS].map(([g, xs]) => [g, xs.filter(match)]).filter(([, xs]) => xs.length);
    const exact = ql && [...recentSpecies(), ...SPECIES].some(s => s.toLowerCase() === ql);
    list.innerHTML = (ql && !exact ? `<button type="button" class="combo-opt custom" data-v="${esc(q.trim())}">Use “${esc(q.trim())}”</button>` : "")
      + groups.map(([g, xs]) => `<div class="combo-group">${esc(g)}</div>` + xs.map(s => `<button type="button" class="combo-opt" role="option" data-v="${esc(s)}">${esc(s)}</button>`).join("")).join("")
      || `<div class="combo-group">No match. Keep typing to use your own name.</div>`;
  };
  const open = q => { draw(q); list.hidden = false; input.setAttribute("aria-expanded", "true"); };
  const close = () => { list.hidden = true; input.setAttribute("aria-expanded", "false"); };
  input.addEventListener("focus", () => open(input.value === "" ? "" : ""));
  input.addEventListener("input", () => open(input.value));
  input.addEventListener("blur", () => setTimeout(close, 150));
  input.addEventListener("keydown", e => {
    if (e.key === "Escape") { close(); e.stopPropagation(); }
    if (e.key === "Enter" && !list.hidden) { e.preventDefault(); const first = list.querySelector(".combo-opt"); if (first && input.value.trim()) { input.value = first.dataset.v; close(); } }
  });
  btn.addEventListener("pointerdown", e => e.preventDefault());
  btn.addEventListener("click", () => { if (list.hidden) { open(""); list.scrollTop = 0; } else close(); });
  list.addEventListener("pointerdown", e => e.preventDefault());
  list.addEventListener("click", e => { const o = e.target.closest(".combo-opt"); if (!o) return; input.value = o.dataset.v; close(); input.dispatchEvent(new Event("change", { bubbles: true })); });
}

$("addCatch").onclick = () => {
  const rows = $("catchRows").querySelectorAll(".catch-row"), last = rows[rows.length - 1];
  const r = catchRow({ species: last?.querySelector(".c-sp").value, lure: last?.querySelector(".c-lu").value });
  $("catchRows").append(r); r.querySelector(".c-sp").focus();
};
function segSet(el, vals) { for (const b of el.querySelectorAll("button")) b.setAttribute("aria-pressed", vals.includes(b.dataset.v)); }
$("segCond").innerHTML = CONDS.map(c => `<button type="button" data-v="${c}" aria-pressed="false">${c}</button>`).join("");
$("segCond").onclick = e => { const b = e.target.closest("button"); if (b) b.setAttribute("aria-pressed", b.getAttribute("aria-pressed") !== "true"); };
$("segMethod").onclick = e => { const b = e.target.closest("button"); if (b) segSet($("segMethod"), [b.dataset.v]); };

function showLoc() {
  const label = [$("fWaterIn").value.trim(), $("fSpot").value.trim()].filter(Boolean).join(" · ");
  $("locText").innerHTML = pinned ? `${pinned.lat.toFixed(5)}, ${pinned.lon.toFixed(5)} · <a href="${mapsUrl(pinned.lat, pinned.lon, label)}" target="_blank" rel="noopener">Open in ${mapsName()}</a> · <button type="button" class="linkbtn" id="unpin" style="margin:0">Remove</button>` : "";
  const u = $("unpin"); if (u) u.onclick = () => { pinned = null; showLoc(); };
  $("pinLoc").textContent = pinned ? "Re-pin location" : "Pin my location";
}
$("fLocPaste").addEventListener("change", () => {
  const v = $("fLocPaste").value.trim(); if (!v) return;
  const c = parseCoords(v);
  if (c) { pinned = c; $("fLocPaste").value = ""; showLoc(); }
  else $("locText").textContent = /goo\.gl|maps\.app/.test(v) ? "Short share links don't include coordinates. In Google Maps, long-press the spot and copy the numbers instead." : "Couldn't find coordinates in that. Paste a map link or numbers like 45.37879, -66.76780.";
});
$("pinLoc").onclick = () => {
  if (!navigator.geolocation) { $("locText").textContent = "This browser can't share location."; return; }
  $("locText").textContent = "Finding you…";
  navigator.geolocation.getCurrentPosition(
    p => { pinned = { lat: r(p.coords.latitude, 5), lon: r(p.coords.longitude, 5) }; showLoc(); },
    err => { $("locText").textContent = err.code === 1 ? "Location is blocked. Allow it in your browser settings to pin spots." : "Couldn't get a fix. Try again in the open."; },
    { enableHighAccuracy: true, timeout: 15000 }
  );
};

function openSheet(s) {
  editingId = s?.id || null;
  $("sheetTitle").textContent = s ? `Edit ${fmtDate(s.date)}` : "Log a trip";
  const d = new Date(), iso = `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
  $("fDate").value = s?.date || iso; $("fStart").value = s?.start || ""; $("fEnd").value = s?.end || "";
  $("fWaterIn").value = s?.water || ""; $("fSpot").value = s?.spot || "";
  $("tloLabel").textContent = `Temp °${T()}`; $("thiLabel").textContent = `Temp later °${T()}`;
  $("moreDetails").open = !!(s && (s.start || s.end || s.notes || s.lat != null || (s.conditions || []).length || s.lureText || s.combo));
  $("fTlo").value = tOut(s?.tempLow) ?? ""; $("fThi").value = s && s.tempHigh !== s.tempLow ? (tOut(s.tempHigh) ?? "") : "";
  $("fCombo").value = s?.combo || ""; $("fLureText").value = s?.lureText || ""; $("fNotes").value = s?.notes || "";
  segSet($("segMethod"), [s?.method || "Spin"]); segSet($("segCond"), s?.conditions || []);
  pinned = s?.lat != null ? { lat: s.lat, lon: s.lon } : null; $("fLocPaste").value = ""; showLoc();
  $("catchRows").innerHTML = ""; (s ? s.catches || [] : [{}]).forEach(c => $("catchRows").append(catchRow(c)));
  $("delBtn").hidden = !s; $("delConfirm").hidden = true; $("formErr").hidden = true;
  $("scrim").hidden = false; $("sheet").hidden = false; $("sheet").scrollTop = 0;
  if (typeof onSheetOpen === "function") onSheetOpen(s);
}
// The logo goes home: out of the sample to the welcome screen, or to Copilot on your own log.
$("homeLink").addEventListener("click", e => {
  e.preventDefault(); closeSheets(); closeViewer();
  if (demo) exitSample(); else if (state.sessions.length) showTab("advice");
  window.scrollTo(0, 0);
});
function closeSheets() { $("scrim").hidden = true; $("sheet").hidden = true; $("settings").hidden = true; $("shareSheet").hidden = true; $("proSheet").hidden = true; $("fidSheet").hidden = true; editingId = null; }
function startNewTrip() { if (demo) exitSample(); openSheet(null); }
$("openNew").onclick = startNewTrip;
$("dockLog").onclick = startNewTrip;
$("welcomeNew").onclick = () => openSheet(null);
$("cancelBtn").onclick = closeSheets; $("scrim").onclick = closeSheets;
document.addEventListener("keydown", e => { if (e.key === "Escape") { if (!$("viewer").hidden) closeViewer(); else closeSheets(); } });
$("entries").addEventListener("click", e => {
  const m = e.target.closest("[data-map]"); if (m) { e.stopPropagation(); openMap(m); return; }
  const v = e.target.closest("[data-view]"); if (v) { e.stopPropagation(); openViewer(v.dataset.view); return; }
  const b = e.target.closest(".entry"); if (!b) return;
  if (demo) { toast("Sample trips can't be edited"); return; }
  openSheet(state.sessions.find(s => s.id === b.dataset.id));
});
function openMap(el) { const [lat, lon] = el.dataset.map.split(",").map(Number); window.open(mapsUrl(lat, lon, el.dataset.label), "_blank", "noopener"); }
$("entries").addEventListener("keydown", e => { const m = e.target.closest("[data-map]"); if (m && (e.key === "Enter" || e.key === " ")) { e.preventDefault(); e.stopPropagation(); openMap(m); return; } const v = e.target.closest("[data-view]"); if (v && (e.key === "Enter" || e.key === " ")) { e.preventDefault(); e.stopPropagation(); openViewer(v.dataset.view); } });
$("bigFish").addEventListener("click", e => { const v = e.target.closest("[data-view]"); if (v) openViewer(v.dataset.view); });

/* ---------- photo viewer ---------- */
async function openViewer(key) {
  const [sid, pid] = key.split("|"), s = state.sessions.find(x => x.id === sid), c = s?.catches.find(x => x.photo === pid);
  const u = await photoURL(pid); if (!u) { toast("Photo not found on this device"); return; }
  $("viewerImg").src = u;
  $("viewerCap").textContent = [c?.species, c ? sizeOf(c) : "", c?.lure, s ? `${s.water} · ${fmtDate(s.date)}` : ""].filter(Boolean).join(" · ");
  $("viewer").dataset.key = key; $("viewer").hidden = false; $("viewerClose").focus();
}
const closeViewer = () => { $("viewer").hidden = true; };
$("viewerClose").onclick = closeViewer;
$("viewer").addEventListener("click", e => { if (e.target === $("viewer")) closeViewer(); });
$("delBtn").onclick = () => { $("delBtn").hidden = true; $("delConfirm").hidden = false; };
$("delYes").onclick = () => {
  const gone = photoIdsOf(state.sessions.find(s => s.id === editingId));
  state.sessions = state.sessions.filter(s => s.id !== editingId); save(); closeSheets(); render(); toast("Trip deleted");
  photoDel(gone).catch(() => {});
};

$("form").addEventListener("submit", async e => {
  e.preventDefault(); $("formErr").hidden = true;
  const date = $("fDate").value, water = $("fWaterIn").value.trim();
  if (!date || !water) { $("formErr").hidden = false; $("formErr").textContent = "Add a date and the water you fished."; return; }
  const num = v => v === "" || v == null ? null : Number(v);
  const rowsEl = [...$("catchRows").querySelectorAll(".catch-row")].filter(row => row.querySelector(".c-sp").value.trim());
  // Save any new photos first; a catch keeps its old photo unless it was removed or replaced.
  $("saveBtn").disabled = true;
  try {
    for (const row of rowsEl) if (row._photoBlob) { const id = `p-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 7)}`; await photoPut(id, row._photoBlob); row._photoBlob = null; row.dataset.newPhoto = id; }
  } catch (err) {
    $("saveBtn").disabled = false; $("formErr").hidden = false; $("formErr").textContent = "Couldn't save the photo. Your phone may be out of storage."; return;
  }
  $("saveBtn").disabled = false;
  const catches = rowsEl.map(row => {
    const lbV = num(row.querySelector(".c-lb").value), inV = num(row.querySelector(".c-in").value);
    // keep stored precision if the shown value wasn't changed
    const lb = row.dataset.lb != null && lbV === wtOut(+row.dataset.lb) ? +row.dataset.lb : wtIn(lbV);
    const inches = row.dataset.in != null && inV === lenOut(+row.dataset.in) ? +row.dataset.in : lenIn(inV);
    const unchanged = row.dataset.lb != null ? lb === +row.dataset.lb : lb == null;
    return { species: row.querySelector(".c-sp").value.trim(), count: Math.max(1, parseInt(row.querySelector(".c-n").value) || 1), lb, inches, lure: row.querySelector(".c-lu").value.trim() || null, size: unchanged ? row.dataset.size || null : null,
      photo: row.dataset.newPhoto || (row.dataset.photoRemoved ? null : row.dataset.photo || null) };
  });
  const tlo = num($("fTlo").value), thi = num($("fThi").value);
  const start = $("fStart").value || null, end = $("fEnd").value || null;
  const prev = state.sessions.find(s => s.id === editingId);
  const keepT = (v, old) => old != null && v === tOut(old) ? old : tIn(v);
  const doc = {
    ...(prev || {}),
    id: editingId || `t-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 6)}`,
    date, start, end, water, spot: $("fSpot").value.trim(), catches,
    tempLow: keepT(tlo, prev?.tempLow), tempHigh: thi == null ? keepT(tlo, prev?.tempLow) : keepT(thi, prev?.tempHigh),
    lureText: $("fLureText").value.trim(), combo: $("fCombo").value.trim(),
    method: $("segMethod").querySelector('[aria-pressed="true"]')?.dataset.v || "Spin",
    period: periodOf(start, end) || prev?.period || null, notes: $("fNotes").value.trim(),
    conditions: [...$("segCond").querySelectorAll('[aria-pressed="true"]')].map(b => b.dataset.v),
    lat: pinned?.lat ?? null, lon: pinned?.lon ?? null, updatedAt: new Date().toISOString(),
    wx: (typeof formCond !== "undefined" && formCond.wx) || prev?.wx || null,
    flow: (typeof formCond !== "undefined" && formCond.flow) || prev?.flow || null,
  };
  if (prev) state.sessions = state.sessions.map(s => s.id === prev.id ? doc : s); else state.sessions.push(doc);
  if (!save()) return;
  const kept = new Set(photoIdsOf(doc)); photoDel(photoIdsOf(prev).filter(id => !kept.has(id))).catch(() => {});
  state.settings.season = date.slice(0, 4); save();
  closeSheets(); render();
  const fc = catches.reduce((a, c) => a + c.count, 0);
  const bestBefore = Math.max(0, ...state.sessions.filter(s => s.id !== doc.id).flatMap(s => (s.catches || []).map(c => +c.lb || 0)));
  const bestNow = Math.max(0, ...catches.map(c => +c.lb || 0));
  const pb = !prev && bestNow > 0 && bestNow > bestBefore && state.sessions.length > 1;
  if (prev) toast("Trip updated. Model retrained.");
  else if (typeof celebrate === "function") celebrate({ fish: fc, pb: pb ? bestNow : null, species: catches.find(c => +c.lb === bestNow)?.species });
  else toast(fc ? `${fc} fish logged. Model retrained.` : "Skunk logged. Still training data.");
});

/* ---------- notes ---------- */
$("editNotes").onclick = () => {
  if (demo) { toast("Exit the sample to write your own notes"); return; } $("notesText").value = state.notes.join("\n"); $("notesEditor").hidden = false; $("notesList").hidden = true; $("editNotes").hidden = true; };
$("cancelNotes").onclick = () => { $("notesEditor").hidden = true; $("notesList").hidden = false; $("editNotes").hidden = false; };
$("saveNotes").onclick = () => { state.notes = $("notesText").value.split("\n").map(s => s.trim()).filter(Boolean); save(); $("cancelNotes").onclick(); render(); toast("Notes saved"); };

/* ---------- sample season ---------- */
// The sample season is shown in place of your trips but never saved over them.
async function loadSample(where) {
  if (demo) { if (where) showSampleView(where); return; }
  try {
    // The showcase version has historical weather added on the server; fall back to the plain file.
    let data = null;
    try { const ctl = new AbortController(), t = setTimeout(() => ctl.abort(), 8000); const r = await fetch("/api/sample", { signal: ctl.signal }); clearTimeout(t); if (r.ok) data = await r.json(); } catch (e) {}
    if (!Array.isArray(data) || !data.length) data = await (await fetch("sample.json")).json();
    data.forEach(s => { s.sample = true; });
    demo = { sessions: state.sessions, notes: state.notes, season: state.settings.season };
    state.sessions = data; state.notes = SAMPLE_NOTES.slice(); state.settings.season = "2026";
    render(); window.scrollTo(0, 0);
    showSampleView(where);
    if (where === "advice" && typeof maybeGuide === "function") maybeGuide(); // first look at Copilot: how it works
    // Picked a tile on the welcome screen? They've read what this is, so keep the explainer closed.
    setSampleInfo(!where);
  } catch (e) { toast("Couldn't load the sample. Check your connection."); }
}
// Open the sample on the part of the app someone asked to see.
function showSampleView(where) {
  if (where === "patterns") showTab("patterns");
  else if (where === "map") { showTab("log"); if (typeof setView === "function") setView("map"); }
  else if (typeof showSampleCopilot === "function") showSampleCopilot(); else showTab("season");
}
function exitSample() {
  if (!demo) return;
  state.sessions = demo.sessions; state.notes = demo.notes; state.settings.season = demo.season; demo = null;
  if (typeof resetAdviceInputs === "function") resetAdviceInputs();
  render(); window.scrollTo(0, 0);
}
$("welcomeShowcase").addEventListener("click", e => { const t = e.target.closest("[data-sample]"); if (t) loadSample(t.dataset.sample); });
$("topSample").onclick = () => loadSample();
$("clearSample").onclick = exitSample;
function setSampleInfo(open) { $("sampleInfo").hidden = !open; $("sampleInfoBtn").setAttribute("aria-expanded", open); }
$("sampleInfoBtn").onclick = () => setSampleInfo($("sampleInfo").hidden);
$("sampleInfoClose").onclick = () => setSampleInfo(false);
$("sampleStart").onclick = () => { setSampleInfo(false); startNewTrip(); };

/* ---------- settings ---------- */
// Settings opens over whatever is on screen (the sample included), so closing it goes back there.
$("openSettings").onclick = () => {
  $("sName").value = state.settings.name; $("sUnits").value = state.settings.units; $("sTemp").value = state.settings.temp; $("sMaps").value = state.settings.maps || "auto";
  $("wipeBtn").hidden = false; $("wipeConfirm").hidden = true; $("backupMsg").hidden = true;
  $("scrim").hidden = false; $("settings").hidden = false; $("settings").scrollTop = 0;
};
$("closeSettings").onclick = closeSheets;
$("sName").addEventListener("input", () => { state.settings.name = $("sName").value.trim(); save(); render(); });
$("sUnits").addEventListener("change", () => { state.settings.units = $("sUnits").value; save(); render(); });
$("sTemp").addEventListener("change", () => { state.settings.temp = $("sTemp").value; save(); render(); });
$("sMaps").addEventListener("change", () => { state.settings.maps = $("sMaps").value; save(); render(); });

function download(name, text, type) {
  const blob = new Blob([text], { type });
  const file = typeof File === "function" ? new File([blob], name, { type }) : null;
  if (file && navigator.canShare && navigator.canShare({ files: [file] }) && /Mobi|Android|iPhone|iPad/.test(navigator.userAgent)) {
    navigator.share({ files: [file], title: name }).catch(() => {});
    return;
  }
  const a = document.createElement("a"); a.href = URL.createObjectURL(blob); a.download = name;
  document.body.append(a); a.click(); a.remove(); setTimeout(() => URL.revokeObjectURL(a.href), 4000);
}
const stamp = () => new Date().toISOString().slice(0, 10);
const toDataURL = blob => new Promise((res, rej) => { const fr = new FileReader(); fr.onload = () => res(fr.result); fr.onerror = rej; fr.readAsDataURL(blob); });
$("exportJson").onclick = async () => {
  const photos = {};
  const own = demo || state; // the person's own log, even while the sample is on screen
  for (const id of own.sessions.flatMap(photoIdsOf)) { const b = await photoGet(id).catch(() => null); if (b) photos[id] = await toDataURL(b); }
  download(`fishing-log-backup-${stamp()}.json`, JSON.stringify({ app: "fishr.ai", version: 2, exportedAt: new Date().toISOString(), ...state, sessions: own.sessions, notes: own.notes, settings: { ...state.settings, season: demo ? demo.season : state.settings.season }, photos }), "application/json");
};
$("exportCsv").onclick = () => {
  const q = v => { const s = String(v ?? ""); return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s; };
  const rows = [["Date", "Start", "End", "Water", "Spot", "Latitude", "Longitude", "Temp low (°C)", "Temp high (°C)", "Method", "Conditions", "Combo", "Species", "Count", "Weight each (lb)", "Length (in)", "Lure", "Has photo", "Lures used", "Notes"]];
  for (const s of [...(demo || state).sessions].sort((a, b) => a.date.localeCompare(b.date))) {
    const base = [s.date, s.start, s.end, s.water, s.spot, s.lat, s.lon, s.tempLow, s.tempHigh, s.method, (s.conditions || []).join("; "), s.combo];
    const tail = [s.lureText, s.notes];
    if (!(s.catches || []).length) rows.push([...base, "(skunked)", 0, "", "", "", "", ...tail]);
    for (const c of s.catches || []) rows.push([...base, c.species, c.count, c.lb, c.inches, c.lure, c.photo ? "yes" : "", ...tail]);
  }
  download(`fishing-log-${stamp()}.csv`, rows.map(r => r.map(q).join(",")).join("\n"), "text/csv");
};
$("importFile").addEventListener("change", async e => {
  const f = e.target.files[0]; if (!f) return;
  if (demo) exitSample();
  try {
    const data = JSON.parse(await f.text());
    if (!Array.isArray(data.sessions)) throw new Error("not a backup");
    const byId = new Map(state.sessions.map(s => [s.id, s]));
    let added = 0;
    for (const s of data.sessions) { if (!s || !s.id || !s.date || !s.water) continue; if (!byId.has(s.id)) added++; byId.set(s.id, s); }
    state.sessions = [...byId.values()];
    if (data.photos && typeof data.photos === "object") for (const [id, url] of Object.entries(data.photos)) { if (typeof url === "string" && url.startsWith("data:image/")) await photoPut(id, await (await fetch(url)).blob()); }
    if (Array.isArray(data.notes) && !state.notes.length) state.notes = data.notes.filter(x => typeof x === "string");
    save(); render();
    $("backupMsg").hidden = false; $("backupMsg").textContent = `Restored. ${added} new trip${added === 1 ? "" : "s"} added.`;
  } catch (err) {
    $("backupMsg").hidden = false; $("backupMsg").textContent = "That file isn't a fishr.ai backup. Pick the .json file from “Save backup”.";
  }
  e.target.value = "";
});
$("wipeBtn").onclick = () => { $("wipeBtn").hidden = true; $("wipeConfirm").hidden = false; };
$("wipeYes").onclick = () => { if (demo) exitSample(); state.sessions = []; state.notes = []; save(); photoClear().catch(() => {}); photoUrls.clear(); closeSheets(); render(); toast("All trips deleted"); };

/* ---------- install ---------- */
let installEvt = null;
window.addEventListener("beforeinstallprompt", e => { e.preventDefault(); installEvt = e; $("installBtn").hidden = false; });
$("installBtn").onclick = async () => { if (!installEvt) return; installEvt.prompt(); await installEvt.userChoice; installEvt = null; $("installBtn").hidden = true; };
if (window.matchMedia("(display-mode: standalone)").matches || navigator.standalone) $("installGroup").hidden = true;

/* ---------- toast ---------- */
function toast(t) { $("toast").textContent = t; $("toast").hidden = false; clearTimeout(toast.t); toast.t = setTimeout(() => $("toast").hidden = true, 2400); }

/* ---------- boot ---------- */
load();
render();
{ let t = null; try { t = sessionStorage.getItem("ft-tab"); } catch (e) {} showTab(t || "advice"); }
window.addEventListener("storage", e => { if (e.key === KEY) { load(); render(); } });
if ("serviceWorker" in navigator && location.protocol !== "file:") navigator.serviceWorker.register("sw.js").catch(() => {});

/* ---------- swipe down to close the bottom sheets ---------- */
// Dragging down from the top of a sheet (or anywhere while it's scrolled to the top) pulls it down;
// past ~110 px, or with a quick flick, it closes. Otherwise it springs back.
document.querySelectorAll(".sheet").forEach(sheet => {
  let startY = null, dy = 0, t0 = 0, dragging = false;
  const reset = () => { sheet.style.transition = "transform .2s ease"; sheet.style.transform = ""; setTimeout(() => { sheet.style.transition = ""; }, 220); };
  sheet.addEventListener("touchstart", e => {
    if (e.touches.length !== 1 || sheet.scrollTop > 0) { startY = null; return; }
    startY = e.touches[0].clientY; dy = 0; t0 = Date.now(); dragging = false;
  }, { passive: true });
  sheet.addEventListener("touchmove", e => {
    if (startY == null) return;
    dy = e.touches[0].clientY - startY;
    if (!dragging && (dy < 8 || sheet.scrollTop > 0)) { if (dy < 0) startY = null; return; }
    dragging = true; e.preventDefault();
    sheet.style.transition = "none"; sheet.style.transform = `translateY(${Math.max(0, dy)}px)`;
  }, { passive: false });
  sheet.addEventListener("touchend", () => {
    if (startY == null || !dragging) { startY = null; return; }
    const fast = dy > 40 && dy / Math.max(1, Date.now() - t0) > 0.6;
    startY = null; dragging = false;
    if (dy > 110 || fast) {
      sheet.style.transition = "transform .18s ease"; sheet.style.transform = "translateY(100%)";
      setTimeout(() => {
        sheet.style.transition = ""; sheet.style.transform = "";
        if (sheet.id === "shareSheet" && typeof closeShare === "function") closeShare(); else closeSheets();
      }, 180);
    } else reset();
  });
  sheet.addEventListener("touchcancel", () => { startY = null; dragging = false; reset(); });
});
