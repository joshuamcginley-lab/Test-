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

// Upload the card so the link shows the real photo. Returns a short link, or null to fall back to the long one.
let uploaded = { key: null, url: null };
async function uploadCard(blob, d) {
  const { photo, ...meta } = d, key = JSON.stringify(meta) + "|" + (photo || "") + "|" + blob.size;
  if (uploaded.key === key) return uploaded.url;
  if (!navigator.onLine || location.protocol === "file:") return null;
  const fd = new FormData(); fd.append("image", blob, "catch.jpg"); fd.append("meta", JSON.stringify(meta));
  const ctl = new AbortController(), timer = setTimeout(() => ctl.abort(), 10000);
  try {
    const res = await fetch("/api/share", { method: "POST", body: fd, signal: ctl.signal });
    if (!res.ok) return null;
    const { url } = await res.json();
    if (typeof url !== "string" || !/^https?:\/\/[^ ]+\/c\/[A-Za-z0-9]{10}$/.test(url)) return null;
    uploaded = { key, url }; return url;
  } catch (e) { return null; } finally { clearTimeout(timer); }
}

function shareText(link) {
  const d = cardData();
  const size = [d.lb != null ? fmtW(d.lb) : "", d.in != null ? fmtL(d.in) : ""].filter(Boolean).join(", ");
  const what = `${d.ct > 1 ? `${d.ct} ` : ""}${d.sp.toLowerCase()}${size ? ` (${size})` : ""}`;
  return `${what}${d.lu ? ` on a ${d.lu.toLowerCase()}` : ""}${d.w ? ` at ${d.w}` : ""}, ${fmtDate(d.d)}. See it on fishr.ai: ${link || catchLink(d)}`;
}

function cover(ctx, img, x, y, w, h) {
  const k = Math.max(w / img.width, h / img.height), sw = w / k, sh = h / k;
  ctx.drawImage(img, (img.width - sw) / 2, (img.height - sh) / 2, sw, sh, x, y, w, h);
}
function fitText(ctx, text, font, max, start) {
  let size = start; do { ctx.font = font.replace("{s}", size); size -= 4; } while (ctx.measureText(text).width > max && size > 24);
}

// The catch as a plain object: what goes on the card and into the shared link.
function cardData() {
  const { s, idx } = shareCtx, c = s.catches[idx], t = avgT(s);
  return { n: state.settings.name || null, d: s.date, w: $("shWater").checked ? s.water : null, sp: c.species, ct: c.count || 1,
    lb: c.lb ?? null, in: c.inches ?? null, lu: c.lure || s.lureText || null, t: t == null ? null : r(t, 1), photo: c.photo || null };
}
const b64url = s => btoa(String.fromCharCode(...new TextEncoder().encode(s))).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
const unb64url = s => new TextDecoder().decode(Uint8Array.from(atob(s.replace(/-/g, "+").replace(/_/g, "/")), ch => ch.charCodeAt(0)));
function catchLink(d) { const { photo, ...pub } = d; for (const k in pub) if (pub[k] == null) delete pub[k]; return `https://${APP_URL}/#catch=${b64url(JSON.stringify({ v: 1, ...pub }))}`; }
function readCatchLink() {
  const m = location.hash.match(/^#catch=([A-Za-z0-9_-]+)(?:&img=([A-Za-z0-9]{10}))?$/); if (!m) return null;
  try {
    const d = JSON.parse(unb64url(m[1]));
    if (typeof d.sp !== "string" || !/^\d{4}-\d{2}-\d{2}$/.test(d.d)) return null;
    const num = v => typeof v === "number" && isFinite(v) ? v : null, str = (v, n) => typeof v === "string" ? v.slice(0, n) : null;
    return { n: str(d.n, 40), d: d.d, w: str(d.w, 80), sp: d.sp.slice(0, 60), ct: Math.max(1, Math.min(999, num(d.ct) || 1)), lb: num(d.lb), in: num(d.in), lu: str(d.lu, 80), t: num(d.t), photo: null, img: m[2] || null };
  } catch (e) { return null; }
}

function roundRect(ctx, x, y, w, h, rad) { ctx.beginPath(); ctx.moveTo(x + rad, y); ctx.arcTo(x + w, y, x + w, y + h, rad); ctx.arcTo(x + w, y + h, x, y + h, rad); ctx.arcTo(x, y + h, x, y, rad); ctx.arcTo(x, y, x + w, y, rad); ctx.closePath(); }
function glow(ctx, x, y, rad, color) { const g = ctx.createRadialGradient(x, y, 0, x, y, rad); g.addColorStop(0, color); g.addColorStop(1, "rgba(0,0,0,0)"); ctx.fillStyle = g; ctx.fillRect(x - rad, y - rad, rad * 2, rad * 2); }
function gradH(ctx, x0, x1) { const g = ctx.createLinearGradient(x0, 0, x1, 0); g.addColorStop(0, "#C4FF2E"); g.addColorStop(.45, "#7DEB3A"); g.addColorStop(.75, "#FFB21A"); g.addColorStop(1, "#FF6A13"); return g; }

async function renderCard(cv, d) {
  const W = 1080, H = 1350, ctx = cv.getContext("2d");
  cv.width = W; cv.height = H;
  try { await Promise.all(["700 120px Geist", "500 30px 'Geist Mono'", "500 36px Geist"].map(f => document.fonts.load(f))); } catch (e) {}
  const SANS = "Geist, ui-sans-serif, system-ui, sans-serif", MONO = "'Geist Mono', ui-monospace, monospace";
  ctx.fillStyle = "#070A14"; ctx.fillRect(0, 0, W, H);
  glow(ctx, 180, 160, 620, "rgba(155,240,60,.26)"); glow(ctx, 900, 260, 560, "rgba(255,122,26,.26)"); glow(ctx, 600, 1200, 600, "rgba(196,255,46,.08)");

  // header: wordmark + beta pill
  const pad = 64;
  const mark = await new Promise(res => { const i = new Image(); i.onload = () => res(i); i.onerror = () => res(null); i.src = "icons/mark-128.png"; });
  ctx.save(); roundRect(ctx, pad, 50, 48, 48, 12); ctx.clip();
  if (mark) ctx.drawImage(mark, pad, 50, 48, 48); else { ctx.fillStyle = gradH(ctx, pad, pad + 48); ctx.fillRect(pad, 50, 48, 48); }
  ctx.restore();
  ctx.fillStyle = "#EEF2E8"; ctx.font = `650 34px ${SANS}`; ctx.fillText("fishr", pad + 60, 86);
  let wx = pad + 60 + ctx.measureText("fishr").width; ctx.fillStyle = "#8C8CA0"; ctx.fillText(".ai", wx, 86);
  wx += ctx.measureText(".ai").width + 16; ctx.strokeStyle = "rgba(155,240,60,.55)"; ctx.lineWidth = 2; roundRect(ctx, wx, 60, 72, 32, 16); ctx.stroke();
  ctx.fillStyle = "#9BF03C"; ctx.font = `500 16px ${MONO}`; ctx.fillText("BETA", wx + 15, 82);

  // photo panel
  const px = pad, py = 128, pw = W - pad * 2, ph = 640;
  const url = d.photo ? await photoURL(d.photo) : (d.imgUrl || null);
  const img = url ? await new Promise(res => { const i = new Image(); i.onload = () => res(i); i.onerror = () => res(null); i.src = url; }) : null;
  ctx.save(); roundRect(ctx, px, py, pw, ph, 36); ctx.clip();
  if (img) cover(ctx, img, px, py, pw, ph);
  else {
    ctx.fillStyle = "#0D111D"; ctx.fillRect(px, py, pw, ph);
    glow(ctx, px + pw * .3, py + ph * .35, 520, "rgba(155,240,60,.30)"); glow(ctx, px + pw * .75, py + ph * .6, 480, "rgba(255,122,26,.32)"); glow(ctx, px + pw * .5, py + ph, 420, "rgba(196,255,46,.12)");
    const big = await new Promise(res => { const i = new Image(); i.onload = () => res(i); i.onerror = () => res(null); i.src = "icons/mark-512.png"; });
    if (big) ctx.drawImage(big, px + pw / 2 - 210, py + ph / 2 - 210, 420, 420);
  }
  ctx.restore();
  ctx.strokeStyle = "rgba(255,255,255,.12)"; ctx.lineWidth = 2; roundRect(ctx, px, py, pw, ph, 36); ctx.stroke();

  // text
  let y = py + ph + 76;
  ctx.fillStyle = "#8C8CA0"; ctx.font = `500 24px ${MONO}`;
  ctx.fillText(`${fmtDate(d.d).toUpperCase()}${d.w ? ` · ${d.w.toUpperCase()}` : ""}`.slice(0, 60), pad, y);
  y += 92;
  ctx.fillStyle = "#EDEDF3";
  const name = (d.ct > 1 ? `${d.ct}× ` : "") + d.sp;
  fitText(ctx, name, `700 {s}px ${SANS}`, W - pad * 2, 92); ctx.fillText(name, pad, y);

  const stats = [];
  if (d.lb != null) stats.push([String(wtOut(d.lb)), wU()]);
  if (d.in != null) stats.push([String(lenOut(d.in)), U() === "metric" ? "cm" : "in"]);
  if (d.t != null) stats.push([String(tOut(r(d.t, 0))), `°${T()}`]);
  y += 118; let x = pad;
  for (const [k, [v, u]] of stats.slice(0, 3).entries()) {
    ctx.font = `600 100px ${MONO}`; const vw = ctx.measureText(v).width;
    ctx.fillStyle = k === 0 ? gradH(ctx, x, x + vw) : "#EDEDF3"; ctx.fillText(v, x, y); x += vw + 8;
    ctx.fillStyle = "#8C8CA0"; ctx.font = `500 36px ${MONO}`; ctx.fillText(u, x, y); x += ctx.measureText(u).width + 48;
  }
  if (d.lu) { y += 66; ctx.fillStyle = "#C9C9D6"; ctx.font = `500 34px ${SANS}`; let L = `On a ${d.lu.toLowerCase()}`; while (ctx.measureText(L).width > W - pad * 2 && L.length > 10) L = L.slice(0, -2); ctx.fillText(L, pad, y); }

  ctx.fillStyle = "#5E5E72"; ctx.font = `500 21px ${MONO}`;
  ctx.fillText(`✦ LOGGED WITH FISHR.AI · ${APP_URL.toUpperCase()}`, pad, H - 50);
}
async function drawCard() {
  if (!shareCtx) return;
  await renderCard($("shCanvas"), cardData());
  $("shPreview").src = $("shCanvas").toDataURL("image/jpeg", 0.9);
}

async function doShare(saveOnly) {
  if (!shareCtx) return;
  const blob = await new Promise(res => $("shCanvas").toBlob(res, "image/jpeg", 0.92));
  $("shMsg").textContent = "Preparing link…";
  const link = await uploadCard(blob, cardData());
  $("shMsg").textContent = "";
  const name = `catch-${shareCtx.s.date}.jpg`, text = shareText(link);
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

/* ---------- someone opened a shared catch link ---------- */
async function showSharedCatch() {
  const d = readCatchLink(); if (!d) return;
  const size = [d.lb != null ? fmtW(d.lb) : "", d.in != null ? fmtL(d.in) : ""].filter(Boolean).join(" · ");
  $("scTitle").textContent = `${d.n ? `${d.n} caught` : "Check out this catch:"} ${d.ct > 1 ? `${d.ct} ${d.sp.toLowerCase()}` : /^[aeiou]/i.test(d.sp) ? `an ${d.sp.toLowerCase()}` : `a ${d.sp.toLowerCase()}`}`;
  $("scMeta").textContent = [size, d.lu ? `on a ${d.lu.toLowerCase()}` : "", d.w, fmtDate(d.d), d.t != null ? fmtT(r(d.t, 0)) : ""].filter(Boolean).join(" · ");
  const hasLog = state.sessions.length > 0;
  $("scStart").textContent = hasLog ? "Back to my log" : "Start my own fishing log";
  $("scSample").hidden = hasLog;
  $("sharedCatch").hidden = false;
  const drawn = async () => { await renderCard($("scCanvas"), d); $("scImg").src = $("scCanvas").toDataURL("image/jpeg", 0.88); };
  if (d.img) { $("scImg").onerror = () => { $("scImg").onerror = null; drawn(); }; $("scImg").src = `/img/${d.img}`; }
  else await drawn();
}
function leaveShared(then) {
  $("sharedCatch").hidden = true;
  history.replaceState(null, "", location.pathname + location.search);
  then?.();
}
$("scStart").onclick = () => leaveShared(() => { if (!state.sessions.length) openSheet(null); });
$("scSample").onclick = () => leaveShared(loadSample);
window.addEventListener("hashchange", showSharedCatch);
showSharedCatch();
