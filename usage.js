"use strict";
/* Anonymous usage counts. The first time a milestone happens on this phone (opened fishr, logged a 1st, 3rd, 5th or
   10th trip, still logging 2 and 4 weeks later, and so on), the app tells /api/usage its name, once. No trip data,
   location, name or ID is sent. "active" is sent at most once a week, when a trip is logged that week. Settings has
   an off switch. Not sent from a developer's own computer (localhost) unless a test turns it on. */

const USAGE_KEY = "fishr.usage";
const usageOn = () => state.settings.usage !== false && (!/^(localhost|127\.0\.0\.1|\[::1\])$/.test(location.hostname) || localStorage.getItem("fishr.usage.test") === "1");
function usageState() { try { return JSON.parse(localStorage.getItem(USAGE_KEY)) || { sent: {} }; } catch (e) { return { sent: {} }; } }
function usageSave(u) { try { localStorage.setItem(USAGE_KEY, JSON.stringify(u)); } catch (e) {} }
const usageSending = new Set();
async function usage(event) {
  if (!usageOn() || !navigator.onLine) return;
  const u = usageState(); if (event !== "active" && u.sent[event]) return;
  if (usageSending.has(event)) return; usageSending.add(event);
  try {
    const r = await fetch("/api/usage", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ event }), keepalive: true });
    if (r.ok) { const v = usageState(); if (event === "active") v.week = isoWeek(new Date()); else v.sent[event] = 1; usageSave(v); }
  } catch (e) { /* offline: tried again next time */ } finally { usageSending.delete(event); }
}
// Week of the year (ISO), for "logged a trip this week".
const isoWeek = d => { const t = new Date(Date.UTC(d.getFullYear(), d.getMonth(), d.getDate())), day = t.getUTCDay() || 7; t.setUTCDate(t.getUTCDate() + 4 - day);
  const y = new Date(Date.UTC(t.getUTCFullYear(), 0, 1)); return `${t.getUTCFullYear()}-W${String(Math.ceil(((t - y) / 864e5 + 1) / 7)).padStart(2, "0")}`; };
// When a trip was first saved: from its id (t-<time in base 36>-…), falling back to its last edit.
const savedAt = s => { const m = /^t-([0-9a-z]+)-/.exec(s.id || ""), t = m ? parseInt(m[1], 36) : NaN; return t > 1.5e12 && t < 4e12 ? t : Date.parse(s.updatedAt) || null; };

function usageCheck() {
  if (!usageOn()) return;
  usage("open");
  if (demo) usage("showcase");
  const own = (demo ? demo.sessions : state.sessions).filter(s => !s.sample), n = own.length;
  for (const k of [1, 3, 5, 10]) if (n >= k) usage("trip" + k);
  if (own.filter(s => avgT(s) != null).length >= MIN_TRIPS) usage("guide");
  if (typeof cloudOn === "function" && cloudOn()) usage("cloud");
  // Still logging 2 and 4 weeks after the first trip, and weekly actives: from when trips were saved.
  const times = own.map(savedAt).filter(Boolean).sort((a, b) => a - b);
  if (times.length >= 2) {
    const first = times[0], last = times[times.length - 1];
    if (last - first >= 14 * 864e5) usage("retained14");
    if (last - first >= 30 * 864e5) usage("retained30");
  }
  const u = usageState(), week = isoWeek(new Date());
  if (times.length && isoWeek(new Date(times[times.length - 1])) === week && u.week !== week) usage("active");
}
// Checked after anything that changes the app (a trip saved, the sample opened, Cloud turned on) and at start.
{ const _render = render; render = function () { _render(); usageCheck(); }; }
setTimeout(usageCheck, 1500);

// Settings: the off switch.
$("sUsage").checked = state.settings.usage !== false;
$("sUsage").addEventListener("change", () => { state.settings.usage = $("sUsage").checked; save(); if (state.settings.usage) usageCheck(); });
$("openSettings").addEventListener("click", () => { $("sUsage").checked = state.settings.usage !== false; });
