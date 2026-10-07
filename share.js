"use strict";
/* Share a catch: draws a 1080×1350 card (photo + stats) and opens the phone's share sheet.
   Exact spots and coordinates are never shared; the water name is optional. */

const APP_URL = "firetiger-fishing-log.pages.dev";
let shareCtx = null; // { s: trip, idx: catch index }

function catchesOf(s) { return (s.catches || []).map((c, i) => ({ c, i })); }
function defaultCatch(s) {
  const list = catchesOf(s);
  return (list.find(x => x.c.photo) && list.filter(x => x.c.photo).sort((a, b) => (b.c.lb || 0) - (a.c.lb || 0))[0])
    || list.sort((a, b) => (b.c.lb || 0) - (a.c.lb || 0) || (b.c.inches || 0) - (a.c.inches || 0))[0];
}

function openShare(sid, photoId) {
  const s = state.sessions.find(x => x.id === sid); if (!s || !fishOf(s)) return;
  const pick = photoId ? catchesOf(s).find(x => x.c.photo === photoId) : defaultCatch(s);
  shareCtx = { s, idx: pick.i };
  $("shFish").innerHTML = catchesOf(s).map(({ c, i }) => `<option value="${i}">${esc(c.count > 1 ? `${c.count} × ${c.species}` : c.species)}${sizeOf(c) ? ` · ${esc(sizeOf(c))}` : ""}${c.photo ? " · photo" : ""}</option>`).join("");
  $("shFish").value = String(pick.i);
  $("shFishRow").hidden = (s.catches || []).length < 2;
  $("shMsg").textContent = "";
  $("viewer").hidden = true;
  $("scrim").hidden = false; $("shareSheet").hidden = false; $("shareSheet").scrollTop = 0;
  drawCard();
}
function closeShare() { $("shareSheet").hidden = true; $("scrim").hidden = true; shareCtx = null; }

function shareText() {
  const { s, idx } = shareCtx, c = s.catches[idx];
  const size = [c.lb != null ? fmtW(c.lb) : "", c.inches != null ? fmtL(c.inches) : ""].filter(Boolean).join(", ");
  const what = `${c.count > 1 ? `${c.count} ` : ""}${c.species.toLowerCase()}${size ? ` (${size})` : ""}`;
  const where = $("shWater").checked ? ` at ${s.water}` : "";
  return `${what}${c.lure ? ` on a ${c.lure.toLowerCase()}` : ""}${where}, ${fmtDate(s.date)}. Logged with Firetiger: https://${APP_URL}`;
}

function cover(ctx, img, x, y, w, h) {
  const k = Math.max(w / img.width, h / img.height), sw = w / k, sh = h / k;
  ctx.drawImage(img, (img.width - sw) / 2, (img.height - sh) / 2, sw, sh, x, y, w, h);
}
function tigerStripe(ctx, x, y, w, h, k = 1) {
  ctx.save(); ctx.beginPath(); ctx.rect(x, y, w, h); ctx.clip();
  ctx.fillStyle = "#C8E62E"; ctx.fillRect(x, y, w, h * 0.62);
  ctx.fillStyle = "#F26A1B"; ctx.fillRect(x, y + h * 0.62, w, h * 0.38);
  ctx.fillStyle = "#0D1A20";
  const slant = h / Math.tan(62 * Math.PI / 180);
  for (let sx = x - slant; sx < x + w + slant; sx += 46 * k) {
    for (const [o0, bw0] of [[22, 8], [46, 4]]) { const o = o0 * k, bw = bw0 * k; ctx.beginPath(); ctx.moveTo(sx + o, y + h); ctx.lineTo(sx + o + slant, y); ctx.lineTo(sx + o + slant + bw, y); ctx.lineTo(sx + o + bw, y + h); ctx.fill(); }
  }
  ctx.restore();
}
function fitText(ctx, text, font, max, start) {
  let size = start; do { ctx.font = font.replace("{s}", size); size -= 4; } while (ctx.measureText(text).width > max && size > 24);
}

async function drawCard() {
  if (!shareCtx) return;
  const { s, idx } = shareCtx, c = s.catches[idx];
  const W = 1080, H = 1350, cv = $("shCanvas"), ctx = cv.getContext("2d");
  cv.width = W; cv.height = H;
  try { await Promise.all(["italic 900 120px Archivo", "600 30px 'Martian Mono'", "600 36px 'Libre Franklin'"].map(f => document.fonts.load(f))); } catch (e) {}
  const DISPLAY = "Archivo, 'Arial Black', sans-serif", MONO = "'Martian Mono', ui-monospace, monospace", BODY = "'Libre Franklin', system-ui, sans-serif";
  ctx.fillStyle = "#0D1A20"; ctx.fillRect(0, 0, W, H);

  const photoH = 780;
  const url = c.photo ? await photoURL(c.photo) : null;
  if (url) {
    const img = await new Promise(res => { const i = new Image(); i.onload = () => res(i); i.onerror = () => res(null); i.src = url; });
    if (img) cover(ctx, img, 0, 0, W, photoH); else tigerStripe(ctx, 0, 0, W, photoH, 4.5);
  } else {
    tigerStripe(ctx, 0, 0, W, photoH, 4.5);
  }
  tigerStripe(ctx, 0, photoH, W, 34);

  const pad = 64; let y = photoH + 34 + 92;
  ctx.fillStyle = "#C8E62E"; ctx.font = `600 26px ${MONO}`; ctx.textBaseline = "alphabetic";
  ctx.fillText(`${fmtDate(s.date).toUpperCase()}${$("shWater").checked ? ` · ${s.water.toUpperCase()}` : ""}`.slice(0, 60), pad, y - 6);
  y += 96;
  ctx.fillStyle = "#EDF2EA";
  const name = (c.count > 1 ? `${c.count}× ` : "") + c.species.toUpperCase();
  fitText(ctx, name, `italic 900 {s}px ${DISPLAY}`, W - pad * 2, 104); ctx.fillText(name, pad, y);

  const stats = [];
  if (c.lb != null) stats.push([String(wtOut(c.lb)), wU()]);
  if (c.inches != null) stats.push([String(lenOut(c.inches)), U() === "metric" ? "cm" : "in"]);
  const t = avgT(s); if (t != null) stats.push([String(tOut(r(t, 0))), `°${T()}`]);
  y += 132; let x = pad;
  for (const [k, [v, u]] of stats.slice(0, 3).entries()) {
    ctx.fillStyle = k === 0 ? "#C8E62E" : "#EDF2EA";
    ctx.font = `italic 900 112px ${DISPLAY}`; ctx.fillText(v, x, y); x += ctx.measureText(v).width + 10;
    ctx.fillStyle = "#8FA3A6"; ctx.font = `italic 800 44px ${DISPLAY}`; ctx.fillText(u, x, y); x += ctx.measureText(u).width + 54;
  }
  ctx.fillStyle = "#EDF2EA"; ctx.font = `600 36px ${BODY}`;
  const lure = c.lure || s.lureText; if (lure) { y += 74; let L = `On a ${lure.toLowerCase()}`; while (ctx.measureText(L).width > W - pad * 2 && L.length > 10) L = L.slice(0, -2); ctx.fillText(L, pad, y); }

  ctx.fillStyle = "#8FA3A6"; ctx.font = `600 22px ${MONO}`;
  ctx.fillText(`LOGGED WITH FIRETIGER · ${APP_URL.toUpperCase()}`, pad, H - 52);

  $("shPreview").src = cv.toDataURL("image/jpeg", 0.9);
}

async function doShare(saveOnly) {
  if (!shareCtx) return;
  const blob = await new Promise(res => $("shCanvas").toBlob(res, "image/jpeg", 0.92));
  const name = `catch-${shareCtx.s.date}.jpg`, text = shareText();
  const file = new File([blob], name, { type: "image/jpeg" });
  if (!saveOnly && navigator.canShare && navigator.canShare({ files: [file] })) {
    try { await navigator.share({ files: [file], text }); $("shMsg").textContent = ""; return; }
    catch (e) { if (e.name === "AbortError") return; }
  }
  if (!saveOnly && navigator.share) {
    try { await navigator.share({ text }); return; } catch (e) { if (e.name === "AbortError") return; }
  }
  const a = document.createElement("a"); a.href = URL.createObjectURL(blob); a.download = name; document.body.append(a); a.click(); a.remove();
  setTimeout(() => URL.revokeObjectURL(a.href), 4000);
  try { await navigator.clipboard.writeText(text); $("shMsg").textContent = "Image saved and caption copied. Paste it into a message with the picture."; }
  catch (e) { $("shMsg").textContent = "Image saved. Attach it to a message to send it."; }
}

/* ---------- wire up ---------- */
$("shFish").addEventListener("change", () => { shareCtx.idx = +$("shFish").value; drawCard(); });
$("shWater").addEventListener("change", drawCard);
$("shGo").onclick = () => doShare(false);
$("shSave").onclick = () => doShare(true);
$("shClose").onclick = closeShare;
$("scrim").addEventListener("click", () => { if (!$("shareSheet").hidden) closeShare(); });
$("viewerShare").onclick = () => { const [sid, pid] = ($("viewer").dataset.key || "").split("|"); openShare(sid, pid); };
// Share buttons on log entries (handled before the entry's own tap-to-edit).
$("entries").addEventListener("click", e => { const b = e.target.closest("[data-share]"); if (b) { e.stopImmediatePropagation(); openShare(b.dataset.share); } }, true);
$("entries").addEventListener("keydown", e => { const b = e.target.closest("[data-share]"); if (b && (e.key === "Enter" || e.key === " ")) { e.preventDefault(); e.stopImmediatePropagation(); openShare(b.dataset.share); } }, true);
