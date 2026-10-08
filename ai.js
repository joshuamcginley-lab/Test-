"use strict";
/* fishr AI in the app: Ask fishr on Copilot, and fishr ID (name the fish in a photo) from Copilot, the welcome
   screen or the log form. Both go through our /api/ai endpoints,
   which call Claude. Free during the beta: fishr Cloud accounts get a few a day, and anyone can ask about the
   showcase season or try a few fishr IDs without an account. Uses globals from app.js, forecast.js and cloud.js. */

const ASK_CHIPS = {
  own: ["Where should I fish today?", "What's my best lure right now?", "When do I catch the most fish?"],
  sample: ["Where should this angler fish tonight?", "What lure works best in July?", "Does pressure change the bite here?"],
};
const askHist = { own: [], sample: [] }, askInfo = {}, askLoading = {};
let askBusy = false, aiOff = false;
const askMode = () => demo ? "sample" : "own";

// What Copilot is looking at right now: its inputs, plus the live forecast for your own log.
function askConditions() {
  const pick = id => $(id).querySelector('[aria-pressed="true"]')?.dataset.v || null, tv = $("aTemp").value;
  const c = { date: $("aDate").value || null, time: $("aTime").value || null, temp: tv === "" ? null : tIn(Number(tv)), sky: pick("aSky"), pressure: pick("aPress"), flow: pick("aFlow") };
  if (!demo && typeof wx !== "undefined" && wx) {
    if (wx.current?.wind != null) c.wind = Math.round(wx.current.wind);
    const now = Date.now(), day = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];
    c.forecast = (wx.hourly || []).filter(h => h.time.getTime() > now && h.time.getTime() < now + 48 * 36e5 && h.time.getHours() % 3 === 0)
      .map(h => `${day[h.time.getDay()]} ${String(h.time.getHours()).padStart(2, "0")}:00 ${Math.round(h.temp)}°C ${(h.sky || "").toLowerCase()}${h.wind != null ? `, wind ${Math.round(h.wind)} km/h` : ""}${h.pop ? `, ${h.pop}% chance of rain` : ""}`);
  }
  return c;
}

async function askStatus(mode) {
  if (askLoading[mode]) return; askLoading[mode] = true;
  try {
    const d = await api(`/api/ai/ask?mode=${mode}`);
    if (d.ready === false) aiOff = true;
    askInfo[mode] = d;
  } catch (e) { if (e.status === 503) aiOff = true; }
  finally { askLoading[mode] = false; renderAsk(); }
}

function renderAsk() {
  const box = $("ask"); if (!box) return;
  const mode = askMode(), own = mode === "own", gated = own && !cloudOn(), info = askInfo[mode], hist = askHist[mode];
  if (gated) delete askInfo.own;
  if (!gated && !info) askStatus(mode);
  else if (gated && !askInfo.sample) askStatus("sample"); // just to learn whether fishr AI is switched on
  box.hidden = $("fidCard").hidden = $("fidChoice").hidden = aiOff;
  if (aiOff) return;
  $("askSub").textContent = own ? "Answers from your log and today's conditions." : "Ask about this showcase season. Answers come from its 47 trips.";
  $("askGate").hidden = !gated; $("askForm").hidden = gated;
  $("askThread").innerHTML = hist.map(h => `<div class="ask-msg ${h.role}${h.err ? " err" : ""}">${esc(h.text)}</div>`).join("")
    + (askBusy ? `<div class="ask-msg assistant busy" aria-label="fishr is thinking"><i></i><i></i><i></i></div>` : "");
  $("askChips").hidden = gated || hist.length > 0 || askBusy;
  $("askChips").innerHTML = ASK_CHIPS[mode].map(q => `<button type="button" class="ask-chip">${esc(q)}</button>`).join("");
  const out = info && info.left === 0;
  $("askFoot").textContent = gated ? "" : !info?.limit ? "Powered by Claude" : out
    ? (own ? "That's today's free questions. More tomorrow." : "That's today's free questions on the showcase. Start your own log to ask about your fishing.")
    : `${info.left} of ${info.limit} free question${info.limit === 1 ? "" : "s"} left today · Powered by Claude`;
  $("askGo").disabled = askBusy || out; $("askInput").disabled = askBusy || out;
}

async function askFishr(q) {
  q = q.trim(); if (!q || askBusy) return;
  const mode = askMode(), hist = askHist[mode];
  const history = hist.filter(h => !h.err).map(({ role, text }) => ({ role, text }));
  hist.push({ role: "user", text: q }); askBusy = true; $("askInput").value = ""; renderAsk();
  try {
    if (mode === "own") await syncNow(); // so the answer sees your latest trips
    const d = await api("/api/ai/ask", { mode, question: q, history, conditions: askConditions(), units: { weight: state.settings.units, temp: state.settings.temp } });
    hist.push({ role: "assistant", text: d.answer });
    if (askInfo[mode]) askInfo[mode].left = d.left;
  } catch (e) {
    if (e.status === 401 && mode === "own") onSyncError(e);
    if (e.status === 429 && askInfo[mode]) askInfo[mode].left = 0;
    hist.push({ role: "assistant", text: e.message || "fishr AI didn't answer. Try again.", err: true });
  } finally {
    askBusy = false; renderAsk();
    $("askThread").lastElementChild?.scrollIntoView({ block: "nearest", behavior: "smooth" });
  }
}

$("askForm").addEventListener("submit", e => { e.preventDefault(); askFishr($("askInput").value); });
$("askChips").addEventListener("click", e => { const b = e.target.closest(".ask-chip"); if (b) askFishr(b.textContent); });
$("askCloud").onclick = () => {
  $("openSettings").click(); cloudPick = "cloud"; renderCloud();
  setTimeout(() => $("cloudGroup").scrollIntoView({ block: "start", behavior: "smooth" }), 50);
};
{ const _renderForAsk = render; render = function () { _renderForAsk(); renderAsk(); }; }
renderAsk();

/* ---------- fishr ID ---------- */
const blobToB64 = blob => new Promise((res, rej) => { const fr = new FileReader(); fr.onload = () => res(String(fr.result).split(",")[1]); fr.onerror = rej; fr.readAsDataURL(blob); });
const identify = async blob => api("/api/ai/identify", { image: await blobToB64(blob), type: blob.type || "image/jpeg" });
const fidLeft = d => d.left == null ? "" : cloudOn()
  ? `${d.left} fishr ID${d.left === 1 ? "" : "s"} left today · Powered by Claude`
  : `${d.left} free fishr ID${d.left === 1 ? "" : "s"} left today. fishr Cloud (free) gets you more. · Powered by Claude`;

// The fishr ID sheet: pick or take a photo from anywhere, see the species, then log it as a catch.
let fid = null; // { blob, species, isFish }
function showFid(html) { $("fidResult").innerHTML = html; }
// Each "Identify a fish" button holds its own file input (the pattern iOS Safari handles reliably).
document.addEventListener("change", e => {
  if (!e.target.matches?.(".fid-file")) return;
  const f = e.target.files && e.target.files[0]; e.target.value = "";
  if (f) runFishrId(f).catch(err => { console.error(err); toast("fishr ID hit a snag. Try again."); throw err; });
});
async function runFishrId(f) {
  closeSheets(); $("scrim").hidden = false; $("fidSheet").hidden = false; $("fidSheet").scrollTop = 0;
  $("fidLog").hidden = true; $("fidFoot").textContent = ""; $("fidImg").removeAttribute("src"); $("fidImg").parentElement.style.removeProperty("--fid-bg");
  showFid(`<p class="fid-busy"><span class="fid-scan"></span>Identifying…</p>`);
  let blob;
  try { blob = await shrinkPhoto(f); } catch (err) { showFid(`<p class="fid-err">Couldn't read that image. Try a JPEG or PNG.</p>`); return; }
  const url = URL.createObjectURL(blob);
  $("fidImg").src = url; $("fidImg").parentElement.style.setProperty("--fid-bg", `url("${url}")`);
  fid = { blob };
  try {
    const d = await identify(blob);
    fid = { blob, species: d.species, isFish: d.isFish };
    if (!d.isFish) showFid(`<p class="fid-err">That doesn't look like a fish. Try a clearer shot of the whole fish.</p>`);
    else showFid(`<span class="fid-conf ${esc(d.confidence)}">${esc(d.confidence)} confidence</span><h3 class="fid-name" id="fidName">${esc(d.species)}</h3>`
      + (d.reason ? `<p class="fid-why">${esc(d.reason)}</p>` : "")
      + (d.alternatives.length ? `<p class="fid-alts">Could also be: ${d.alternatives.map(a => `<button type="button" class="text-link fid-alt">${esc(a)}</button>`).join(", ")}</p>` : ""));
    $("fidLog").hidden = !d.isFish;
    $("fidFoot").textContent = fidLeft(d);
  } catch (err) {
    if (err.status === 401) onSyncError(err);
    showFid(`<p class="fid-err">${esc(err.message || "Couldn't identify that photo.")}</p>`);
  }
}
$("fidResult").addEventListener("click", e => {
  const b = e.target.closest(".fid-alt"); if (!b || !fid) return;
  const was = fid.species; fid.species = b.textContent; $("fidName").textContent = fid.species; b.textContent = was;
});
$("fidClose").onclick = closeSheets;
$("fidLog").onclick = () => {
  if (!fid?.isFish) return;
  const { blob, species } = fid;
  closeSheets(); startNewTrip();
  const row = $("catchRows").querySelector(".catch-row"); if (!row) return;
  row.querySelector(".c-sp").value = species; row.setPhoto(blob);
  row.querySelector(".photo-msg").innerHTML = `<span class="id-hit">Identified by fishr ID: <b>${esc(species)}</b></span>`;
};

/* ---------- fishr ID on each catch in the log form ---------- */
async function identifyFish(row, auto) {
  const msg = row.querySelector(".photo-msg"), btn = row.querySelector(".id-photo");
  if (auto && !cloudOn()) return; // without Cloud, it only runs when tapped (it counts toward the free tries)
  const blob = row._photoBlob || (row.dataset.photo && !row.dataset.photoRemoved ? await photoGet(row.dataset.photo).catch(() => null) : null);
  if (!blob) return;
  btn.disabled = true; btn.classList.add("busy"); msg.textContent = "Identifying…";
  try {
    const d = await identify(blob);
    if (!d.isFish) { msg.textContent = "That doesn't look like a fish. Try a clearer shot."; return; }
    row.querySelector(".c-sp").value = d.species;
    msg.innerHTML = `<span class="id-hit"><b>${esc(d.species)}</b> · ${esc(d.confidence)} confidence${d.alternatives.length ? `. Or: ${d.alternatives.map(a => `<button type="button" class="text-link id-alt">${esc(a)}</button>`).join(", ")}` : ""}</span>${d.reason ? `<span class="id-why">${esc(d.reason)}</span>` : ""}`;
  } catch (e) {
    if (e.status === 401) onSyncError(e);
    msg.textContent = e.message || "Couldn't identify that photo.";
  } finally { btn.disabled = false; btn.classList.remove("busy"); }
}
// A new photo with no species yet: identify it straight away for Cloud accounts.
function onPhotoReady(row) { if (cloudOn() && !row.querySelector(".c-sp").value.trim()) identifyFish(row, true); }

$("catchRows").addEventListener("click", e => {
  const b = e.target.closest(".id-photo"); if (b) { identifyFish(b.closest(".catch-row"), false); return; }
  const alt = e.target.closest(".id-alt");
  if (alt) { alt.closest(".catch-row").querySelector(".c-sp").value = alt.textContent; alt.closest(".photo-msg").innerHTML = `<span class="id-hit"><b>${esc(alt.textContent)}</b></span>`; }
});
