"use strict";
/* fishr Cloud: an optional passkey account that syncs trips, notes, settings and photos across devices.
   "On this phone" stays the default; nothing leaves the device until someone creates an account.
   Sync compares each trip with what was last synced, so every way the app changes a trip gets picked up.
   Uses globals from app.js. */

const SYNC_KEY = "fishr.sync";
const SYNC_SETTINGS = ["name", "units", "temp", "maps"];
let sync = readSync(); // { user, cursor, hashes: { tripId: [hash, updated] }, metaHash, metaAt, photos: { id: 1 }, lastSync }
function readSync() { try { return JSON.parse(localStorage.getItem(SYNC_KEY)) || {}; } catch (e) { return {}; } }
function writeSync() { try { localStorage.setItem(SYNC_KEY, JSON.stringify(sync)); } catch (e) {} }
const cloudOn = () => !!sync.user;
const passkeysOK = () => !!(window.PublicKeyCredential && navigator.credentials?.create);

/* ---------- helpers ---------- */
const b64u = buf => { let s = ""; for (const b of new Uint8Array(buf)) s += String.fromCharCode(b); return btoa(s).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, ""); };
const unb64u = s => Uint8Array.from(atob(s.replace(/-/g, "+").replace(/_/g, "/") + "===".slice((s.length + 3) % 4)), c => c.charCodeAt(0));
function hashStr(str) { // cyrb53: a fast fingerprint to spot changed trips
  let h1 = 0xdeadbeef, h2 = 0x41c6ce57;
  for (let i = 0; i < str.length; i++) { const c = str.charCodeAt(i); h1 = Math.imul(h1 ^ c, 2654435761); h2 = Math.imul(h2 ^ c, 1597334677); }
  h1 = Math.imul(h1 ^ (h1 >>> 16), 2246822507) ^ Math.imul(h2 ^ (h2 >>> 13), 3266489909);
  h2 = Math.imul(h2 ^ (h2 >>> 16), 2246822507) ^ Math.imul(h1 ^ (h1 >>> 13), 3266489909);
  return (4294967296 * (2097151 & h2) + (h1 >>> 0)).toString(36);
}
async function api(path, body, method) {
  const r = await fetch(path, { method: method || (body ? "POST" : "GET"), credentials: "same-origin",
    headers: body ? { "content-type": "application/json" } : {}, body: body ? JSON.stringify(body) : undefined });
  const d = await r.json().catch(() => ({}));
  if (!r.ok) throw Object.assign(new Error(d.error || "fishr Cloud didn't answer. Try again."), { status: r.status });
  return d;
}
function deviceLabel() {
  const ua = navigator.userAgent;
  const dev = /iPhone/.test(ua) ? "iPhone" : /iPad/.test(ua) ? "iPad" : /Android/.test(ua) ? "Android" : /Mac/.test(ua) ? "Mac" : /Windows/.test(ua) ? "Windows" : /CrOS/.test(ua) ? "Chromebook" : "Device";
  const br = /Edg\//.test(ua) ? "Edge" : /Firefox|FxiOS/.test(ua) ? "Firefox" : /Chrome|CriOS/.test(ua) ? "Chrome" : /Safari/.test(ua) ? "Safari" : "Browser";
  return `${dev} · ${br}`;
}
// The person's own log, even while the sample season is on screen.
const realLog = () => demo || state;

/* ---------- passkeys ---------- */
function passkeyError(e) {
  if (e?.name === "NotAllowedError" || e?.name === "AbortError") return "Cancelled. Nothing was changed.";
  if (e?.name === "InvalidStateError") return "This device already has a passkey for your account.";
  if (e?.name === "SecurityError") return "Passkeys only work on fishr.monster.";
  return e?.message || "Something went wrong. Try again.";
}
async function createPasskey() {
  const o = await api("/api/auth/register-options", { name: state.settings.name || "" });
  const pk = o.publicKey;
  const cred = await navigator.credentials.create({ publicKey: { ...pk, challenge: unb64u(pk.challenge), user: { ...pk.user, id: unb64u(pk.user.id) },
    excludeCredentials: pk.excludeCredentials.map(c => ({ ...c, id: unb64u(c.id) })) } });
  return api("/api/auth/register", { challengeId: o.challengeId, id: cred.id, clientDataJSON: b64u(cred.response.clientDataJSON),
    attestationObject: b64u(cred.response.attestationObject), label: deviceLabel() });
}
async function usePasskey() {
  const o = await api("/api/auth/login-options", {});
  const cred = await navigator.credentials.get({ publicKey: { ...o.publicKey, challenge: unb64u(o.publicKey.challenge) } });
  return api("/api/auth/login", { challengeId: o.challengeId, id: cred.id, clientDataJSON: b64u(cred.response.clientDataJSON),
    authenticatorData: b64u(cred.response.authenticatorData), signature: b64u(cred.response.signature),
    userHandle: cred.response.userHandle ? b64u(cred.response.userHandle) : null });
}
async function signedIn(user) {
  if (demo) exitSample();
  sync = { user, cursor: 0, hashes: {}, photos: {} }; writeSync();
  account = user; renderCloud();

// Welcome screen: "Already use fishr Cloud? Sign in" for a new phone.
$("welcomeCloud").hidden = !passkeysOK();
$("welcomeSignIn").onclick = async () => {
  const b = $("welcomeSignIn"); b.disabled = true;
  try { const d = await usePasskey(); await signedIn(d.user); const n = realLog().sessions.length; toast(`Signed in. ${n} trip${n === 1 ? "" : "s"} synced.`); }
  catch (e) { toast(passkeyError(e)); }
  finally { b.disabled = false; }
};
  await syncNow();
  const n = realLog().sessions.length;
  cloudMsg(`Cloud is on. ${n} trip${n === 1 ? "" : "s"} synced.`);
}

/* ---------- sync ---------- */
let syncing = null, again = false, applying = false, syncErr = null, syncTimer = null;
const missingPhotos = new Set();
function syncNow() {
  if (!cloudOn()) return Promise.resolve();
  if (syncing) { again = true; return syncing; }
  syncing = runSync().catch(onSyncError).finally(() => { syncing = null; renderCloud(); if (again) { again = false; syncNow(); } });
  renderCloud();

// Welcome screen: "Already use fishr Cloud? Sign in" for a new phone.
$("welcomeCloud").hidden = !passkeysOK();
$("welcomeSignIn").onclick = async () => {
  const b = $("welcomeSignIn"); b.disabled = true;
  try { const d = await usePasskey(); await signedIn(d.user); const n = realLog().sessions.length; toast(`Signed in. ${n} trip${n === 1 ? "" : "s"} synced.`); }
  catch (e) { toast(passkeyError(e)); }
  finally { b.disabled = false; }
};
  return syncing;
}
function scheduleSync(ms = 1500) { clearTimeout(syncTimer); syncTimer = setTimeout(syncNow, ms); }
function onSyncError(e) {
  if (e.status === 401) { forgetAccount(); toast("Signed out of fishr Cloud. Your trips are still on this phone."); return; }
  syncErr = e.status === 402 ? "Cloud sync is part of fishr Pro. Your trips are safe on this phone." : navigator.onLine ? e.message : "Offline. Changes will sync when you're back online.";
}
function saveQuiet() { applying = true; try { save(); } finally { applying = false; } }

async function runSync() {
  if (!navigator.onLine) throw new Error("offline");
  syncErr = null;
  const log = realLog(), now = new Date().toISOString(), first = sync.metaAt == null;
  await uploadPhotos(log);

  // Trips that changed or were deleted since the last sync.
  const push = [], here = new Set();
  let bumped = false;
  for (const s of log.sessions) {
    here.add(s.id);
    const prev = sync.hashes[s.id];
    if (prev && prev[0] === hashStr(JSON.stringify(s))) continue;
    // Changed without a new timestamp (e.g. placed on the map): stamp it so it wins over the older copy.
    if (!s.updatedAt || (prev && s.updatedAt <= prev[1])) { s.updatedAt = now; bumped = true; }
    push.push({ id: s.id, data: s, updated: s.updatedAt, h: hashStr(JSON.stringify(s)) });
  }
  for (const id of Object.keys(sync.hashes)) if (!here.has(id)) push.push({ id, deleted: true, updated: now });
  if (bumped) saveQuiet();

  // Notes and settings. A device's first sync takes the account's copy before sending its own.
  const meta = { notes: log.notes, settings: Object.fromEntries(SYNC_SETTINGS.map(k => [k, state.settings[k]])) };
  const metaHash = hashStr(JSON.stringify(meta));
  const metaPush = !first && metaHash !== sync.metaHash ? { data: meta, updated: now } : null;

  let since = sync.cursor || 0, i = 0, res;
  do {
    const part = push.slice(i, i + 400);
    res = await api("/api/sync", { since, trips: part.map(({ h, ...t }) => t), meta: i === 0 ? metaPush : null });
    for (const p of part) if (p.deleted) delete sync.hashes[p.id]; else sync.hashes[p.id] = [p.h, p.updated];
    if (i === 0 && metaPush) { sync.metaHash = metaHash; sync.metaAt = now; }
    applyTrips(res.trips);
    since = res.cursor; i += 400;
  } while (i < push.length || res.more);
  applyMeta(res.meta, first, meta);
  sync.cursor = since; sync.lastSync = Date.now(); writeSync();
  await prunePhotos(realLog());
  missingPhotos.clear();
}

function applyTrips(rows) {
  if (!rows.length) return;
  const log = realLog(); let changed = false;
  for (const r of rows) {
    const i = log.sessions.findIndex(s => s.id === r.id), local = i < 0 ? null : log.sessions[i];
    if (local && (local.updatedAt || "") >= r.updated) continue; // this device has the same or a newer copy
    if (r.deleted) {
      delete sync.hashes[r.id];
      if (local) { log.sessions.splice(i, 1); changed = true; photoDel(photoIdsOf(local).filter(id => !log.sessions.some(s => photoIdsOf(s).includes(id)))).catch(() => {}); }
      continue;
    }
    const data = { ...r.data, id: r.id };
    if (local) log.sessions[i] = data; else log.sessions.push(data);
    sync.hashes[r.id] = [hashStr(JSON.stringify(data)), r.updated]; changed = true;
  }
  if (changed) { saveQuiet(); render(); }
}

function applyMeta(remote, first, local) {
  const log = realLog();
  if (first) {
    // Merge: keep notes from both, and the account's settings (but don't lose a name typed on this phone).
    const notes = [...(remote?.data.notes || [])]; for (const n of local.notes) if (!notes.includes(n)) notes.push(n);
    const settings = { ...local.settings, ...(remote?.data.settings || {}) };
    if (!settings.name) settings.name = local.settings.name;
    log.notes = notes; for (const k of SYNC_SETTINGS) if (settings[k] != null) state.settings[k] = settings[k];
    sync.metaAt = remote?.updated || "";
    sync.metaHash = remote ? hashStr(JSON.stringify(remote.data)) : null;
    saveQuiet(); render();
    if (!remote || hashStr(JSON.stringify({ notes, settings: Object.fromEntries(SYNC_SETTINGS.map(k => [k, state.settings[k]])) })) !== sync.metaHash) again = true;
    return;
  }
  if (!remote || remote.updated <= (sync.metaAt || "")) return;
  log.notes = remote.data.notes || [];
  for (const k of SYNC_SETTINGS) if (remote.data.settings?.[k] != null) state.settings[k] = remote.data.settings[k];
  sync.metaAt = remote.updated; sync.metaHash = hashStr(JSON.stringify(remote.data));
  saveQuiet(); render();
}

/* ---------- photos ---------- */
async function uploadPhotos(log) {
  sync.photos ||= {};
  for (const id of new Set(log.sessions.flatMap(photoIdsOf))) {
    if (sync.photos[id]) continue;
    const blob = await photoGet(id).catch(() => null); if (!blob) continue; // on another device; it uploads from there
    const r = await fetch(`/api/photo/${encodeURIComponent(id)}`, { method: "PUT", credentials: "same-origin", headers: { "content-type": blob.type || "image/jpeg" }, body: blob });
    if (r.status === 401 || r.status === 402) throw Object.assign(new Error("photo"), { status: r.status });
    if (r.ok) { sync.photos[id] = 1; writeSync(); }
  }
}
async function prunePhotos(log) {
  const used = new Set(log.sessions.flatMap(photoIdsOf));
  for (const id of Object.keys(sync.photos || {})) {
    if (used.has(id)) continue;
    const r = await fetch(`/api/photo/${encodeURIComponent(id)}`, { method: "DELETE", credentials: "same-origin" }).catch(() => null);
    if (r?.ok) { delete sync.photos[id]; writeSync(); }
  }
}
// Called by photoURL() in app.js when a photo isn't on this phone yet.
async function cloudPhoto(id) {
  if (!cloudOn() || missingPhotos.has(id) || !navigator.onLine) return null;
  try {
    const r = await fetch(`/api/photo/${encodeURIComponent(id)}`, { credentials: "same-origin" });
    if (!r.ok) { missingPhotos.add(id); return null; }
    const blob = await r.blob();
    await photoPut(id, blob).catch(() => {});
    sync.photos ||= {}; sync.photos[id] = 1; writeSync();
    return blob;
  } catch (e) { return null; }
}

/* ---------- sign out / delete ---------- */
function forgetAccount() { sync = {}; writeSync(); account = null; syncErr = null; renderCloud(); }
async function signOut(removeLocal) {
  try { await api("/api/auth/logout", {}); } catch (e) {}
  forgetAccount();
  if (removeLocal) {
    if (demo) exitSample();
    state.sessions = []; state.notes = []; save(); photoClear().catch(() => {}); photoUrls.clear(); render();
    cloudMsg("Signed out. Your trips were removed from this phone and are still in your account.");
  } else cloudMsg("Signed out. Your trips stay on this phone and in your account.");
}
async function deleteAccount() {
  await api("/api/account", {}, "DELETE");
  forgetAccount();
  cloudMsg("Cloud account deleted. Your trips are still on this phone.");
}

/* ---------- settings UI ---------- */
let account = null, cloudPick = null; // cloudPick: what the switch shows while someone is deciding
function cloudMsg(t) { const m = $("cloudMsg"); m.textContent = t || ""; m.hidden = !t; }
function ago(ms) {
  const s = Math.round((Date.now() - ms) / 1000);
  return s < 45 ? "just now" : s < 3600 ? `${Math.round(s / 60)} min ago` : s < 86400 ? `${Math.round(s / 3600)} h ago` : new Date(ms).toLocaleDateString();
}
function renderCloud() {
  if (!$("cloudGroup")) return;
  const on = cloudOn(), pick = cloudPick || (on ? "cloud" : "local");
  segSet($("segStore"), [pick]);
  $("cloudLocal").hidden = pick !== "local" || on;
  $("cloudJoin").hidden = pick !== "cloud" || on;
  $("cloudOnBox").hidden = !on;
  $("cloudLeave").hidden = !(on && pick === "local");
  $("cloudSignOut").hidden = $("cloudDelete").hidden = !$("cloudLeave").hidden || !$("cloudDeleteConfirm").hidden;
  $("cloudNoPasskeys").hidden = passkeysOK();
  $("cloudCreate").disabled = $("cloudSignIn").disabled = !passkeysOK();
  if (on) {
    $("cloudStatus").innerHTML = syncing ? `<span class="sync-dot busy"></span>Syncing…`
      : syncErr ? `<span class="sync-dot err"></span>${esc(syncErr)}`
      : `<span class="sync-dot"></span>Synced ${sync.lastSync ? ago(sync.lastSync) : "—"} · ${realLog().sessions.length} trips`;
    const keys = account?.passkeys || [];
    $("cloudKeys").innerHTML = keys.length ? `Passkeys: ${keys.map(k => esc(k.label)).join(", ")}` : "";
  }
  $("backupText").textContent = on ? "Your log syncs to fishr Cloud. A backup file is still handy before big changes, and it includes your photos."
    : "Your workspace lives on this device only. Save a backup now and then, and use it to move to a new phone. Backups include your photos.";
  $("wipeWarn").textContent = on ? "This deletes them on every device signed in to your account." : "This can't be undone.";
}
async function busy(btn, fn) {
  const label = btn.textContent; btn.disabled = true; cloudMsg("");
  try { await fn(); } catch (e) { cloudMsg(passkeyError(e)); } finally { btn.disabled = false; btn.textContent = label; renderCloud(); }
}

$("segStore").onclick = e => {
  const b = e.target.closest("button"); if (!b) return;
  cloudPick = b.dataset.v === (cloudOn() ? "cloud" : "local") ? null : b.dataset.v;
  cloudMsg(""); renderCloud();

// Welcome screen: "Already use fishr Cloud? Sign in" for a new phone.
$("welcomeCloud").hidden = !passkeysOK();
$("welcomeSignIn").onclick = async () => {
  const b = $("welcomeSignIn"); b.disabled = true;
  try { const d = await usePasskey(); await signedIn(d.user); const n = realLog().sessions.length; toast(`Signed in. ${n} trip${n === 1 ? "" : "s"} synced.`); }
  catch (e) { toast(passkeyError(e)); }
  finally { b.disabled = false; }
};
};
$("cloudCreate").onclick = () => busy($("cloudCreate"), async () => { const d = await createPasskey(); cloudPick = null; await signedIn(d.user); });
$("cloudSignIn").onclick = () => busy($("cloudSignIn"), async () => { const d = await usePasskey(); cloudPick = null; await signedIn(d.user); });
$("cloudSyncNow").onclick = () => { cloudMsg(""); syncNow(); };
$("cloudAddKey").onclick = () => busy($("cloudAddKey"), async () => { const d = await createPasskey(); account = d.user; cloudMsg("Passkey added. You can sign in with it on this device."); });
$("cloudKeep").onclick = () => busy($("cloudKeep"), async () => { cloudPick = null; await signOut(false); });
$("cloudRemove").onclick = () => busy($("cloudRemove"), async () => { cloudPick = null; await signOut(true); });
$("cloudStay").onclick = () => { cloudPick = null; renderCloud(); };
$("cloudSignOut").onclick = () => { cloudPick = "local"; cloudMsg(""); renderCloud(); };
$("cloudDelete").onclick = () => { $("cloudDeleteConfirm").hidden = false; renderCloud(); };
$("cloudDeleteNo").onclick = () => { $("cloudDeleteConfirm").hidden = true; renderCloud(); };
$("cloudDeleteYes").onclick = () => busy($("cloudDeleteYes"), async () => { await deleteAccount(); $("cloudDeleteNo").onclick(); });

// Refresh the account details whenever Settings opens.
$("openSettings").addEventListener("click", () => {
  cloudPick = null; cloudMsg(""); $("cloudDeleteNo").onclick(); renderCloud();

// Welcome screen: "Already use fishr Cloud? Sign in" for a new phone.
$("welcomeCloud").hidden = !passkeysOK();
$("welcomeSignIn").onclick = async () => {
  const b = $("welcomeSignIn"); b.disabled = true;
  try { const d = await usePasskey(); await signedIn(d.user); const n = realLog().sessions.length; toast(`Signed in. ${n} trip${n === 1 ? "" : "s"} synced.`); }
  catch (e) { toast(passkeyError(e)); }
  finally { b.disabled = false; }
};
  if (cloudOn()) { api("/api/auth/me").then(d => { account = d.user; renderCloud(); }).catch(e => { if (e.status === 401) onSyncError(e); }); syncNow(); }
});

/* ---------- when to sync ---------- */
const _saveLocal = save;
save = function () { const ok = _saveLocal(); if (ok && cloudOn() && !applying) scheduleSync(); return ok; };
addEventListener("online", () => syncNow());
document.addEventListener("visibilitychange", () => { if (document.visibilityState === "visible" && cloudOn() && Date.now() - (sync.lastSync || 0) > 30e3) syncNow(); });
setInterval(() => { if (document.visibilityState === "visible" && cloudOn()) syncNow(); }, 5 * 60e3);
addEventListener("storage", e => { if (e.key === SYNC_KEY) { sync = readSync(); renderCloud(); } });

// Boot: sync if signed in. If this phone forgot (cleared storage) but the sign-in cookie is still there, pick it back up.
if (cloudOn()) syncNow();
else if (/(^|;\s*)fishr_in=1/.test(document.cookie)) api("/api/auth/me").then(d => signedIn(d.user)).catch(() => {});
renderCloud();

// Welcome screen: "Already use fishr Cloud? Sign in" for a new phone.
$("welcomeCloud").hidden = !passkeysOK();
$("welcomeSignIn").onclick = async () => {
  const b = $("welcomeSignIn"); b.disabled = true;
  try { const d = await usePasskey(); await signedIn(d.user); const n = realLog().sessions.length; toast(`Signed in. ${n} trip${n === 1 ? "" : "s"} synced.`); }
  catch (e) { toast(passkeyError(e)); }
  finally { b.disabled = false; }
};
