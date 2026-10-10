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
// fetch with a time limit, so a hung connection (weak signal on the water) can't leave "Syncing…" stuck.
async function fetchT(url, opts = {}, ms = 25000) {
  const ctl = new AbortController(), t = setTimeout(() => ctl.abort(), ms);
  try { return await fetch(url, { ...opts, signal: ctl.signal }); }
  catch (e) {
    if (e.name === "AbortError") throw Object.assign(new Error("fishr took too long to answer. Try again."), { timeout: true });
    throw Object.assign(new Error(navigator.onLine ? "Couldn't reach fishr. Check your connection and try again." : "No signal right now. Try again when you're back in range."), { offline: true });
  }
  finally { clearTimeout(t); }
}
async function api(path, body, method, ms) {
  const r = await fetchT(path, { method: method || (body ? "POST" : "GET"), credentials: "same-origin",
    headers: body ? { "content-type": "application/json" } : {}, body: body ? JSON.stringify(body) : undefined }, ms);
  const d = await r.json().catch(() => null);
  if (!r.ok) throw Object.assign(new Error(d?.error || "fishr Cloud didn't answer. Try again."), { status: r.status });
  // A 200 that isn't fishr's answer (e.g. a Wi-Fi sign-in page) is a failure, never a success.
  if (!d || typeof d !== "object") throw new Error("Couldn't reach fishr Cloud properly. If you're on public Wi-Fi, sign in to it first.");
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
const PREV_KEY = "fishr.sync.prev"; // what this phone last synced, kept after "sign out, keep trips on this phone"
async function signedIn(user) {
  try { localStorage.removeItem(LOGOUT_KEY); } catch (e) {}
  if (demo) exitSample();
  let prev = null; try { prev = JSON.parse(localStorage.getItem(PREV_KEY)); } catch (e) {}
  const same = prev && prev.user === user.id;
  syncGen++;
  sync = { user, cursor: 0, hashes: same ? prev.hashes || {} : {}, photos: same ? prev.photos || {} : {} };
  if (same && prev.metaAt != null) Object.assign(sync, { metaAt: prev.metaAt, metaHash: prev.metaHash, metaData: prev.metaData }); // notes/settings changed while signed out still win
  writeSync();
  try { localStorage.removeItem(PREV_KEY); } catch (e) {}
  account = user; renderCloud();

  await syncNow();
  const n = realLog().sessions.length;
  cloudMsg(`Cloud is on. ${n} trip${n === 1 ? "" : "s"} synced.`);
}

/* ---------- sync ---------- */
let syncing = null, again = false, applying = false, syncErr = null, syncTimer = null, syncGen = 0;
const EPOCH = "1970-01-01T00:00:00.000Z"; // the time given to trips that never had one, so any real edit beats them
const TRIP_ID = /^[A-Za-z0-9._-]{1,64}$/;
const missingPhotos = new Set();
function syncNow() {
  if (!cloudOn()) return Promise.resolve();
  if (syncing) { again = true; return syncing; }
  syncing = runSync().catch(e => { if (e.saveFailed) sync = readSync(); onSyncError(e); }).finally(() => { syncing = null; renderCloud(); if (again) { again = false; syncNow(); } });
  renderCloud();

  return syncing;
}
function scheduleSync(ms = 1500) { clearTimeout(syncTimer); syncTimer = setTimeout(syncNow, ms); }
function onSyncError(e) {
  if (e.status === 401) { forgetAccount(); toast("Signed out of fishr Cloud. Your trips are still on this phone."); return; }
  syncErr = e.status === 402 ? "Cloud sync is part of fishr Pro. Your trips are safe on this phone." : e.saveFailed || navigator.onLine ? e.message : "Offline. Changes will sync when you're back online.";
}
function saveQuiet() { applying = true; try { return save(); } finally { applying = false; } }
// What arrived from the account must be on this phone before the sync can count it as synced. If it can't be saved
// (phone out of storage), stop here: recording it as synced would make the next sync think it had been deleted.
function saveOrStop() { if (saveQuiet() === false) throw Object.assign(new Error("Your phone is out of storage, so fishr couldn't save what synced. Free up some space and it'll sync again."), { saveFailed: true }); }

async function runSync() {
  if (!navigator.onLine) throw new Error("offline");
  syncErr = null;
  const gen = syncGen, live = () => gen === syncGen; // signing out or in mid-sync makes this run stale
  await uploadPhotos();
  if (!live()) return;
  // Read the log only now: the sample season may have been opened while photos uploaded.
  const log = realLog(), now = new Date().toISOString(), first = sync.metaAt == null;
  // The saved log couldn't be read when the app started: it wasn't emptied by the angler, so don't send deletes for
  // it. Start over from the account's copy instead.
  if (typeof logUnreadable !== "undefined" && logUnreadable && !log.sessions.length) { sync.hashes = {}; sync.cursor = 0; logUnreadable = false; }

  // Trips that changed or were deleted since the last sync.
  const push = [], here = new Set();
  let bumped = false;
  for (const s of log.sessions) {
    if (s.sample || !TRIP_ID.test(String(s.id))) continue; // never send sample trips; skip ids the server can't store
    here.add(s.id);
    const prev = sync.hashes[s.id];
    if (prev && prev[0] === hashStr(JSON.stringify(s))) continue;
    if (JSON.stringify(s).length > 60000) continue; // too big to sync; stays on this phone
    let updated = s.updatedAt;
    if (prev && (!updated || updated <= prev[1])) { s.updatedAt = updated = now; bumped = true; } // edited without a new time (e.g. placed on the map)
    else if (!updated) updated = EPOCH; // never synced and no time: an old copy, so it can't beat a real edit elsewhere
    push.push({ id: s.id, data: s, updated, h: hashStr(JSON.stringify(s)) });
  }
  for (const id of Object.keys(sync.hashes)) if (!here.has(id)) push.push({ id, deleted: true, updated: now });
  if (bumped) saveQuiet();

  // Notes and settings. A device's first sync takes the account's copy before sending its own.
  const meta = { notes: log.notes, settings: Object.fromEntries(SYNC_SETTINGS.map(k => [k, state.settings[k]])) };
  const metaHash = hashStr(JSON.stringify(meta));
  // base: the version this device last saw. The server only takes ours if nobody wrote after it; if someone did,
  // we get theirs back, merge in applyMeta, and push the merge on the next round.
  const metaPush = !first && metaHash !== sync.metaHash ? { data: meta, updated: now, base: sync.metaAt || "" } : null;
  let metaErr = null;

  let since = sync.cursor || 0, i = 0, res;
  do {
    const part = push.slice(i, i + 400);
    res = await api("/api/sync", { since, trips: part.map(({ h, ...t }) => t), meta: i === 0 ? metaPush : null });
    if (!live()) return;
    if (!Array.isArray(res.trips) || !Number.isFinite(res.cursor)) throw new Error("fishr Cloud sent back something unexpected. Your changes are safe and will sync next time.");
    for (const p of part) if (p.deleted) delete sync.hashes[p.id]; else sync.hashes[p.id] = [p.h, p.updated];
    if (i === 0 && metaPush) {
      if (res.metaError) metaErr = res.metaError;
      else if (res.metaAccepted !== false) { sync.metaHash = metaHash; sync.metaAt = res.meta?.updated || now; sync.metaData = meta; }
    }
    applyTrips(res.trips);
    applyTrips(res.kept || []); // pushes the server turned down because it holds a newer copy
    since = res.cursor; i += 400;
  } while (i < push.length || res.more);
  applyMeta(res.meta, first, meta);
  sync.cursor = since; sync.lastSync = Date.now(); writeSync();
  if (metaErr) syncErr = metaErr === "too-large" ? "Your notes are too long to sync (200 lines at most). Trips still sync." : "Notes didn't sync. Trips still sync.";
  await prunePhotos();
  missingPhotos.clear();
}

// A trip from the account, in the shapes the app relies on (a date, a list of catches, numeric coordinates).
function safeTrip(d) {
  if (!d || typeof d !== "object" || typeof d.date !== "string" || !/^\d{4}-\d{2}-\d{2}$/.test(d.date) || typeof d.water !== "string") return null;
  const n = v => v == null || v === "" ? null : Number.isFinite(+v) ? +v : null;
  const out = { ...d, catches: Array.isArray(d.catches) ? d.catches.filter(c => c && typeof c === "object") : [] };
  if ("lat" in d) out.lat = n(d.lat); if ("lon" in d) out.lon = n(d.lon);
  return out;
}
function applyTrips(rows) {
  if (!rows.length) return;
  const log = realLog(); let changed = false;
  for (const r of rows) {
    const i = log.sessions.findIndex(s => s.id === r.id), local = i < 0 ? null : log.sessions[i];
    if (local && (local.updatedAt || "") >= r.updated) continue; // this device has the same or a newer copy
    // Deleted here since this phone last had it (e.g. while this sync was on its way): the delete goes up next round.
    if (!local && !r.deleted && sync.hashes[r.id] && r.updated <= sync.hashes[r.id][1]) continue;
    if (r.deleted) {
      delete sync.hashes[r.id];
      if (local) { log.sessions.splice(i, 1); changed = true; photoDel(photoIdsOf(local).filter(id => !log.sessions.some(s => photoIdsOf(s).includes(id)))).catch(() => {}); }
      continue;
    }
    const data = safeTrip({ ...r.data, id: r.id });
    if (!data) continue; // not a trip this app can show
    if (local) log.sessions[i] = data; else log.sessions.push(data);
    sync.hashes[r.id] = [hashStr(JSON.stringify(data)), r.updated]; changed = true;
  }
  if (changed) { saveOrStop(); render(); }
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
    sync.metaData = remote?.data || null;
    saveOrStop(); render();
    if (!remote || hashStr(JSON.stringify({ notes, settings: Object.fromEntries(SYNC_SETTINGS.map(k => [k, state.settings[k]])) })) !== sync.metaHash) again = true;
    return;
  }
  if (!remote || remote.updated <= (sync.metaAt || "")) return;
  // If this phone also changed its notes since the last sync, keep both sides' notes rather than dropping these.
  const mine = hashStr(JSON.stringify({ notes: log.notes, settings: Object.fromEntries(SYNC_SETTINGS.map(k => [k, state.settings[k]])) })) !== sync.metaHash;
  let notes = [...(remote.data.notes || [])];
  if (mine) {
    const base = Array.isArray(sync.metaData?.notes) ? sync.metaData.notes : null;
    if (base) notes = notes.filter(n => !(base.includes(n) && !log.notes.includes(n))); // deleted here since last sync
    for (const n of log.notes) if (!notes.includes(n) && (!base || !base.includes(n))) notes.push(n); // added here
    again = true;
  }
  log.notes = notes;
  // Settings: a setting this phone changed since the last sync keeps its value; the rest follow the account.
  const base = sync.metaData?.settings;
  for (const k of SYNC_SETTINGS) {
    const changedHere = mine && base && state.settings[k] !== base[k];
    if (!changedHere && remote.data.settings?.[k] != null) state.settings[k] = remote.data.settings[k];
  }
  sync.metaAt = remote.updated; sync.metaHash = hashStr(JSON.stringify(remote.data)); sync.metaData = remote.data;
  saveOrStop(); render();
}

/* ---------- photos ---------- */
async function uploadPhotos() {
  sync.photos ||= {};
  for (const id of new Set(realLog().sessions.filter(s => !s.sample).flatMap(photoIdsOf))) {
    if (sync.photos[id]) continue;
    const blob = await photoGet(id).catch(() => null); if (!blob) continue; // on another device; it uploads from there
    const r = await fetchT(`/api/photo/${encodeURIComponent(id)}`, { method: "PUT", credentials: "same-origin", headers: { "content-type": blob.type || "image/jpeg" }, body: blob }, 60000);
    if (r.status === 401 || r.status === 402) throw Object.assign(new Error("photo"), { status: r.status });
    if (r.ok) { sync.photos[id] = 1; writeSync(); }
  }
}
async function prunePhotos() {
  const used = new Set(realLog().sessions.flatMap(photoIdsOf));
  for (const id of Object.keys(sync.photos || {})) {
    if (used.has(id)) continue;
    const r = await fetchT(`/api/photo/${encodeURIComponent(id)}`, { method: "DELETE", credentials: "same-origin" }).catch(() => null);
    if (r?.ok) { delete sync.photos[id]; writeSync(); }
  }
}
// Called by photoURL() in app.js when a photo isn't on this phone yet.
async function cloudPhoto(id) {
  if (!cloudOn() || missingPhotos.has(id) || !navigator.onLine) return null;
  try {
    const r = await fetchT(`/api/photo/${encodeURIComponent(id)}`, { credentials: "same-origin" });
    if (!r.ok) { missingPhotos.add(id); return null; }
    const blob = await r.blob();
    await photoPut(id, blob).catch(() => {});
    sync.photos ||= {}; sync.photos[id] = 1; writeSync();
    return blob;
  } catch (e) { return null; }
}

/* ---------- sign out / delete ---------- */
function forgetAccount(keepHistory = true) {
  // Remember what this phone had synced, so deletes made while signed out reach the account on the next sign-in.
  try {
    if (keepHistory && sync.user) localStorage.setItem(PREV_KEY, JSON.stringify({ user: sync.user.id, hashes: sync.hashes || {}, photos: sync.photos || {}, metaAt: sync.metaAt, metaHash: sync.metaHash, metaData: sync.metaData }));
    else if (!keepHistory) localStorage.removeItem(PREV_KEY);
  } catch (e) {}
  syncGen++; sync = {}; writeSync(); account = null; syncErr = null; renderCloud();
}
// Signing out must stick even without signal: if the server can't be told now, this phone drops its sign-in
// marker straight away (so it won't sign itself back in on the next launch) and tells the server when it's online.
const LOGOUT_KEY = "fishr.logoutPending";
async function serverLogout() {
  try { await api("/api/auth/logout", {}); localStorage.removeItem(LOGOUT_KEY); return true; }
  catch (e) {
    try { localStorage.setItem(LOGOUT_KEY, "1"); } catch (x) {}
    document.cookie = "fishr_in=; Path=/; Max-Age=0; SameSite=Lax";
    return false;
  }
}
async function signOut(removeLocal) {
  await serverLogout();
  forgetAccount(!removeLocal);
  if (removeLocal) {
    if (demo) exitSample();
    state.sessions = []; state.notes = []; save(); photoClear().catch(() => {}); photoUrls.clear(); render();
    cloudMsg("Signed out. Your trips were removed from this phone and are still in your account.");
  } else cloudMsg("Signed out. Your trips stay on this phone and in your account.");
}
async function deleteAccount() {
  await api("/api/account", {}, "DELETE");
  forgetAccount(false);
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
      : `<span class="sync-dot"></span>Synced ${sync.lastSync ? ago(sync.lastSync) : "—"} · ${realLog().sessions.length} trip${realLog().sessions.length === 1 ? "" : "s"}`;
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

  if (cloudOn()) { api("/api/auth/me").then(d => { account = d.user; renderCloud(); }).catch(e => { if (e.status === 401) onSyncError(e); }); syncNow(); }
});

/* ---------- when to sync ---------- */
const _saveLocal = save;
save = function () { const ok = _saveLocal(); if (ok && cloudOn() && !applying) scheduleSync(); return ok; };
addEventListener("online", () => { if (pendingLogout()) serverLogout(); else syncNow(); });
document.addEventListener("visibilitychange", () => { if (document.visibilityState === "visible" && cloudOn() && Date.now() - (sync.lastSync || 0) > 30e3) syncNow(); });
setInterval(() => { if (document.visibilityState === "visible" && cloudOn()) syncNow(); }, 5 * 60e3);
addEventListener("storage", e => { if (e.key === SYNC_KEY) { sync = readSync(); renderCloud(); } });

// Boot: finish a sign-out that happened offline. Otherwise sync if signed in, or, if this phone forgot (cleared
// storage) but the sign-in cookie is still there, pick it back up.
function pendingLogout() { try { return localStorage.getItem(LOGOUT_KEY) === "1"; } catch (e) { return false; } }
if (pendingLogout()) { if (navigator.onLine) serverLogout(); }
else if (cloudOn()) syncNow();
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

/* ---------- keep your trips safe ---------- */
// A log kept only in a browser tab can be lost: Safari clears a site's data when it hasn't been opened for a while.
// Until fishr is on the Home Screen or Cloud is on, a small note says so. "Not now" hides it for three weeks.
const KEEP_KEY = "fishr.keepSafe", KEEP_SNOOZE = 21 * 864e5;
const installed = () => matchMedia("(display-mode: standalone)").matches || navigator.standalone === true;
const onApple = () => /iP(hone|ad|od)/.test(navigator.userAgent) || (navigator.platform === "MacIntel" && navigator.maxTouchPoints > 1);
function renderKeepSafe() {
  const box = $("keepSafe"); if (!box) return;
  let snoozed = false; try { snoozed = Date.now() - (+localStorage.getItem(KEEP_KEY) || 0) < KEEP_SNOOZE; } catch (e) {}
  box.hidden = !!demo || !state.sessions.length || installed() || cloudOn() || snoozed;
  if (box.hidden) return;
  const canInstall = typeof installEvt !== "undefined" && !!installEvt;
  box.innerHTML = `<b>Keep your trips safe</b>
    <p>${onApple()
      ? "Safari can clear a site's data if you don't open it for a while. Add fishr to your Home Screen (Share, then “Add to Home Screen”) or turn on Cloud."
      : `Your log lives only in this browser. ${canInstall ? "Install fishr, or turn" : "Turn"} on Cloud to back it up.`}</p>
    <div class="btn-row"><button type="button" class="btn primary sm" id="ksCloud">Turn on Cloud</button>${canInstall ? `<button type="button" class="btn sm" id="ksInstall">Install app</button>` : ""}<button type="button" class="linkbtn" id="ksLater">Not now</button></div>`;
  $("ksCloud").onclick = () => { $("openSettings").click(); cloudPick = "cloud"; renderCloud(); $("cloudGroup").scrollIntoView({ block: "start" }); }; // open on Cloud, ready to create the account
  const ins = $("ksInstall"); if (ins) ins.onclick = () => $("installBtn").click();
  $("ksLater").onclick = () => { try { localStorage.setItem(KEEP_KEY, String(Date.now())); } catch (e) {} box.hidden = true; };
}
{
  const _render = render; render = function () { _render(); renderKeepSafe(); };
  const _renderCloud = renderCloud; renderCloud = function () { _renderCloud(); renderKeepSafe(); };
  addEventListener("appinstalled", renderKeepSafe);
  renderKeepSafe();
}
