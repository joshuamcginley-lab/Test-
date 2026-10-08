"use strict";
/* fishr AI in the app: Ask fishr on Copilot, and Photo ID on the log form. Both go through our /api/ai endpoints,
   which call Claude. Free during the beta with a fishr Cloud account (a few questions a day each); the showcase
   season can be asked about without an account. Uses globals from app.js, forecast.js and cloud.js. */

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
  box.hidden = aiOff;
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

/* ---------- Photo ID on the log form ---------- */
const blobToB64 = blob => new Promise((res, rej) => { const fr = new FileReader(); fr.onload = () => res(String(fr.result).split(",")[1]); fr.onerror = rej; fr.readAsDataURL(blob); });

async function identifyFish(row, auto) {
  const msg = row.querySelector(".photo-msg"), btn = row.querySelector(".id-photo");
  if (!cloudOn()) {
    if (!auto) msg.textContent = "Photo ID is free in the beta with a fishr Cloud account. Turn it on in Settings → Storage.";
    return;
  }
  const blob = row._photoBlob || (row.dataset.photo && !row.dataset.photoRemoved ? await photoGet(row.dataset.photo).catch(() => null) : null);
  if (!blob) return;
  btn.disabled = true; btn.classList.add("busy"); msg.textContent = "Identifying…";
  try {
    const d = await api("/api/ai/identify", { image: await blobToB64(blob), type: blob.type || "image/jpeg" });
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
