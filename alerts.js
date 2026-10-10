"use strict";
/* Bite alerts, the app side: the Settings switch. Turning it on asks for notification permission, subscribes this
   device with the browser's push service, and tells fishr where (about 1 km) and in which time zone to check.
   The server decides when to send (functions/_alerts.js); sw.js shows the notification. On iPhone this only works
   once fishr is on the Home Screen. Uses globals from app.js, conditions.js and forecast.js. */

const ALERTS_REFRESH = "fishr.alertsRefreshed";
const pushSupported = () => "serviceWorker" in navigator && "PushManager" in window && "Notification" in window;
const appleDevice = () => /iP(hone|ad|od)/.test(navigator.userAgent) || (navigator.platform === "MacIntel" && navigator.maxTouchPoints > 1);
const homeScreen = () => matchMedia("(display-mode: standalone)").matches || navigator.standalone === true;
const b64uBytes = s => Uint8Array.from(atob(s.replace(/-/g, "+").replace(/_/g, "/") + "===".slice((s.length + 3) % 4)), c => c.charCodeAt(0));
function alertsMsg(t) { const m = $("alertsMsg"); m.textContent = t || ""; m.hidden = !t; }

// Where to check: the saved town or spot, the live weather's location, or ask for it.
async function alertsSpot(ask) {
  const h = state.settings.home;
  if (h && Number.isFinite(h.lat)) return { lat: h.lat, lon: h.lon, place: h.name ? String(h.name).split(",")[0] : null };
  if (typeof wx !== "undefined" && wx && Number.isFinite(wx.lat)) return { lat: wx.lat, lon: wx.lon, place: wx.place ? String(wx.place).split(",")[0] : null };
  if (ask && typeof askDevice === "function") { const c = await askDevice(); if (c) return { lat: c.lat, lon: c.lon, place: null }; }
  return null;
}
async function alertsSubscribe(interactive) {
  if (!pushSupported()) return appleDevice() && !homeScreen()
    ? "On iPhone, add fishr to your Home Screen first (Share, then “Add to Home Screen”), open it from there, and turn this on."
    : "This browser can't show notifications.";
  const key = await fetch("/api/push/key").then(r => r.json()).then(d => d.key).catch(() => null);
  if (!key) return "Bite alerts aren't switched on yet. Check back soon.";
  const perm = interactive ? await Notification.requestPermission() : Notification.permission;
  if (perm !== "granted") return "Notifications are blocked for fishr. Allow them in your phone's settings, then try again.";
  const spot = await alertsSpot(interactive);
  if (!spot) return "fishr needs your location, or a town (Guide → Change town), to know where to check.";
  const reg = await navigator.serviceWorker.ready;
  const sub = (await reg.pushManager.getSubscription()) || await reg.pushManager.subscribe({ userVisibleOnly: true, applicationServerKey: b64uBytes(key) });
  const res = await fetch("/api/push/subscribe", { method: "POST", credentials: "same-origin", headers: { "content-type": "application/json" },
    body: JSON.stringify({ ...sub.toJSON(), lat: spot.lat, lon: spot.lon, tz: Intl.DateTimeFormat().resolvedOptions().timeZone, place: spot.place }) });
  if (!res.ok) return (await res.json().catch(() => ({}))).error || "Couldn't turn on bite alerts. Try again.";
  try { localStorage.setItem(ALERTS_REFRESH, new Date().toDateString()); } catch (e) {}
  return { ok: `On. Bite Intelligence™ is now monitoring your personal Bite Index ${spot.place ? `near ${spot.place}` : "for your waters"}.` };
}
async function alertsUnsubscribe() {
  try {
    const sub = pushSupported() && await (await navigator.serviceWorker.ready).pushManager.getSubscription();
    if (sub) { await fetch("/api/push/unsubscribe", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ endpoint: sub.endpoint }) }); await sub.unsubscribe(); }
  } catch (e) {}
}

$("sAlerts").addEventListener("change", async () => {
  const box = $("sAlerts"); box.disabled = true;
  try {
    if (box.checked) {
      alertsMsg("Turning on…");
      const r = await alertsSubscribe(true).catch(() => "Couldn't turn on bite alerts. Try again.");
      if (r?.ok) { state.settings.alerts = true; save(); alertsMsg(r.ok); } else { box.checked = false; alertsMsg(r); }
    } else { await alertsUnsubscribe(); state.settings.alerts = false; save(); alertsMsg("Off. Nothing about this phone is kept for alerts."); }
  } finally { box.disabled = false; }
});
$("openSettings").addEventListener("click", () => { $("sAlerts").checked = !!state.settings.alerts; alertsMsg(""); });

// Once a day while on, re-send the location so alerts follow a changed town (and the push address stays fresh).
(async () => {
  if (!state.settings.alerts || !pushSupported() || Notification.permission !== "granted") return;
  let last = null; try { last = localStorage.getItem(ALERTS_REFRESH); } catch (e) {}
  if (last === new Date().toDateString()) return;
  setTimeout(() => alertsSubscribe(false).catch(() => {}), 4000);
})();
