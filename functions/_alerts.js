// Bite alerts: decide whether a coming morning or evening is worth a notification, for one subscriber.
//
// Schedule (the subscriber's local time; the hourly job calls in at 8 am and 6 pm):
//   Friday 6 pm     → Saturday morning, Saturday evening, Sunday morning
//   Saturday 8 am   → Saturday evening, Sunday morning
//   Saturday 6 pm   → Sunday morning
//   any day 6 pm    → tomorrow morning and evening, for the one "best window of the week"
// A weekend window qualifies at 85+ AND among the best 10% of the past 4 weeks' mornings and evenings at that spot;
// the weekly one at 90+ AND the best 5%. At most one weekend alert per weekend, one weekly alert per week, and
// never two notifications at once. Scores use the same Bite Index as the app (bite-core.js), with the angler's own
// log when they use fishr Cloud. River level isn't forecast, so it's left out; past and coming windows are scored
// the same way, so the comparison stays fair.
import "../bite-core.js";
const Core = globalThis.BiteCore;

export const RULES = { weekend: { min: 85, top: 0.10 }, weekly: { min: 90, top: 0.05 } };
const DAY = 864e5;
const skyFromCode = c => c == null ? null : c <= 1 ? "Clear" : c <= 48 ? "Overcast" : "Rain";

// The subscriber's local weekday (0 = Sunday), hour and date, from their time zone.
export function localParts(ms, tz) {
  const p = Object.fromEntries(new Intl.DateTimeFormat("en-US", { timeZone: tz, weekday: "short", year: "numeric", month: "2-digit", day: "2-digit", hour: "2-digit", hourCycle: "h23" }).formatToParts(new Date(ms)).map(x => [x.type, x.value]));
  return { dow: ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"].indexOf(p.weekday), hour: +p.hour, date: `${p.year}-${p.month}-${p.day}` };
}
export const tzOk = tz => { try { new Intl.DateTimeFormat("en-US", { timeZone: tz }); return typeof tz === "string" && tz.length < 64; } catch (e) { return false; } };
const isoWeek = date => { const t = new Date(date + "T12:00:00Z"), d = t.getUTCDay() || 7; t.setUTCDate(t.getUTCDate() + 4 - d);
  const y = new Date(Date.UTC(t.getUTCFullYear(), 0, 1)); return `${t.getUTCFullYear()}-W${String(Math.floor((t - y) / DAY / 7) + 1).padStart(2, "0")}`; };
export { isoWeek };

// What this run should look at, for a subscriber at local weekday/hour. Windows are named by days ahead + part.
export function slotPlan(dow, hour) {
  if (hour === 18 || hour === 19) {
    const weekend = dow === 5 ? [[1, "am"], [1, "pm"], [2, "am"]] : dow === 6 ? [[1, "am"]] : [];
    return { slot: "pm", weekend, weekly: [[1, "am"], [1, "pm"]] };
  }
  if ((hour === 8 || hour === 9) && dow === 6) return { slot: "am", weekend: [[0, "pm"], [1, "am"]], weekly: [] };
  return null;
}

// Weather for a spot: the last 28 days and the next 3, hourly, plus sunrise and sunset, in the subscriber's time zone.
export async function fetchSpotWeather(lat, lon, tz) {
  const u = `https://api.open-meteo.com/v1/forecast?latitude=${lat.toFixed(2)}&longitude=${lon.toFixed(2)}&hourly=temperature_2m,weather_code,pressure_msl,wind_speed_10m&daily=sunrise,sunset&past_days=28&forecast_days=3&timezone=${encodeURIComponent(tz)}&timeformat=unixtime`;
  const res = await fetch(u, { cf: { cacheTtl: 1800 }, signal: AbortSignal.timeout(10000) });
  if (!res.ok) throw new Error("weather " + res.status);
  return res.json();
}

// Score every morning and evening window in the weather. A window runs from 1 h before to 3 h after sunrise, or
// 3 h before to 1 h after sunset; its score is its best hour.
export function scoreWindows(W, opts = {}) {
  const h = W.hourly, off = (W.utc_offset_seconds || 0) * 1000;
  const H = h.time.map((t, i) => ({ time: new Date(t * 1000), temp: h.temperature_2m[i], p: h.pressure_msl[i], wind: h.wind_speed_10m[i], code: h.weather_code[i] }));
  const memo = new Map(), log = opts.log || [], sp = Core.topSpecies(log); // scored for their fish, as in the app
  const hourScore = (i, rise, set) => {
    if (i < 3 || H[i].temp == null) return null;
    const t = +H[i].time, localHour = new Date(t + off).getUTCHours();
    const dp3 = H[i].p != null && H[i - 3].p != null ? Math.round((H[i].p - H[i - 3].p) * 10) / 10 : null;
    const c = { temp: H[i].temp, sky: skyFromCode(H[i].code), press: dp3 == null ? null : dp3 >= 1 ? "Rising" : dp3 <= -1 ? "Falling" : "Steady", dp3, wind: H[i].wind };
    const light = { ...Core.lightAt(t, rise, set), midday: localHour >= 11 && localHour < 15 };
    // The last 48 hours' average temperature: water follows it, and each fish has its range.
    const back = H.slice(Math.max(0, i - 48), i).filter(x => x.temp != null), recentTemp = back.length ? back.reduce((a, x) => a + x.temp, 0) / back.length : null;
    return { ...Core.score({ c, light, flow: null, model: null, sp, recentTemp, front: Core.coldFront(H, new Date(t + 1)) }, { log, memo }), c, hour: localHour };
  };
  const out = [];
  W.daily.time.forEach((day, d) => {
    const rise = W.daily.sunrise[d] * 1000, set = W.daily.sunset[d] * 1000, date = new Date(day * 1000 + off).toISOString().slice(0, 10);
    for (const [part, from, to, sun] of [["am", rise - 36e5, rise + 3 * 36e5, rise], ["pm", set - 3 * 36e5, set + 36e5, set]]) {
      let best = null; const hours = [];
      H.forEach((x, i) => { if (+x.time >= from && +x.time <= to) { const s = hourScore(i, rise, set); if (s) { hours.push({ at: +x.time, score: s.score }); if (!best || s.score > best.score) best = { ...s, at: +x.time }; } } });
      if (best) out.push({ date, part, sun, score: best.score, drivers: best.drivers, at: best.at, c: best.c, hour: best.hour, hours });
    }
  });
  return out;
}

// The score a window needs to be in the best `top` share of past windows.
export function cutoff(past, top) {
  const s = past.map(w => w.score).sort((a, b) => b - a);
  return s.length ? s[Math.max(0, Math.ceil(s.length * top) - 1)] : Infinity;
}

// This weekend (named by its Saturday), and the week the weekly check looks into (it looks at tomorrow, so on a
// Sunday that's next week). The weekly allowance belongs to the week of the fishing, not of the send.
export function decideKeys(nowMs, tz) {
  const L = localParts(nowMs, tz);
  const sat = new Date(Date.parse(L.date + "T12:00:00Z") + ((6 - L.dow + 7) % 7 - (L.dow === 0 ? 7 : 0)) * DAY).toISOString().slice(0, 10);
  return { weekendKey: sat, weekKey: isoWeek(new Date(Date.parse(L.date + "T12:00:00Z") + DAY).toISOString().slice(0, 10)) };
}
// Decide for one subscriber now. Returns { send: {kind, window, title, body} | null, slotKey, weekendKey, weekKey }.
export function decide(sub, windows, nowMs, opts = {}) {
  const L = localParts(nowMs, sub.tz), plan = slotPlan(L.dow, L.hour);
  if (!plan) return { send: null };
  const slotKey = `${L.date}-${plan.slot}`, { weekendKey, weekKey } = decideKeys(nowMs, sub.tz);
  const today = L.date, past = windows.filter(w => w.date < today);
  const find = ([ahead, part]) => windows.find(w => w.part === part && w.date === new Date(Date.parse(today + "T12:00:00Z") + ahead * DAY).toISOString().slice(0, 10) && w.sun > nowMs);
  // Good enough for a rule: over its minimum, and in the top share of the month. Ties count too: a score that a fifth
  // of the month also reached isn't "top 10%", whatever the cutoff says.
  const meets = (w, rule) => w.score >= Math.max(rule.min, cutoff(past, rule.top)) && past.filter(p => p.score >= w.score).length <= past.length * rule.top;
  const pick = (list, rule) => {
    return list.map(find).filter(w => w && meets(w, rule)).sort((a, b) => b.score - a.score)[0] || null;
  };
  let send = null;
  if (plan.weekend.length && sub.weekend !== weekendKey) { const w = pick(plan.weekend, RULES.weekend); if (w) send = { kind: "weekend", window: w }; }
  if (!send && plan.weekly.length && sub.weekly !== weekKey) { const w = pick(plan.weekly, RULES.weekly); if (w) send = { kind: "weekly", window: w }; }
  // A weekend window good enough to be the week's best uses up the weekly alert too, so it isn't sent twice.
  if (send?.kind === "weekend" && sub.weekly !== isoWeek(send.window.date) && meets(send.window, RULES.weekly)) send.alsoWeekly = true;
  if (send && (send.kind === "weekly" || send.alsoWeekly)) send.weekKey = isoWeek(send.window.date);
  if (send) Object.assign(send, message(send, sub, nowMs, { past, log: opts.log }));
  return { send, slotKey, weekendKey, weekKey };
}

// The notification, sized for a lock screen (Option C: Bite Intelligence™ is the speaker).
//   Bite Intelligence™: 88 Saturday
//   Peak 5:30–6:30 PM. Keswick River, near mouth · chatterbait. Top 4% of your month.
// Water, spot and lure come from the angler's own log (fishr Cloud), the same way the Guide makes its call; without
// a log, the top reasons stand in. The score is projected from the forecast, so the live one can land a few points off.
const SHORT = { "Evening golden hour": "golden hour", "Morning golden hour": "golden hour", "Prime air temp": "prime temps", "Light chop": "light chop", "Pressure dropping fast": "pressure dropping fast" };
const clip = (t, n) => { t = String(t || "").trim(); const a = [...t]; return a.length > n ? a.slice(0, n - 1).join("").trimEnd() + "…" : t; }; // by character, so an emoji is never cut in half
// "5:30–6:30 PM": the hours within 2 points of the window's best, half an hour either side of them.
function peakSpan(w, tz) {
  const good = (w.hours?.length ? w.hours : [{ at: w.at ?? w.sun, score: w.score }]).filter(h => h.score >= w.score - 2 && Number.isFinite(h.at)).map(h => h.at);
  if (!good.length) return null;
  const fmt = ms => new Intl.DateTimeFormat("en-US", { timeZone: tz, hour: "numeric", minute: "2-digit" }).format(new Date(ms)).replace(":00", "");
  const a = fmt(Math.min(...good) - 18e5), b = fmt(Math.max(...good) + 18e5), am = s => s.slice(-2);
  return am(a) === am(b) ? `${a.slice(0, -3)}–${b}` : `${a}–${b}`;
}
export function message({ kind, window: w }, sub, nowMs, opts = {}) {
  const L = localParts(nowMs, sub.tz), day = new Intl.DateTimeFormat("en-US", { timeZone: "UTC", weekday: "long" }).format(new Date(`${w.date}T12:00:00Z`));
  const when = w.date === L.date ? (w.part === "am" ? "this morning" : "tonight") : day;
  const title = `Bite Intelligence™: ${w.score} ${when}`;
  // How rare it is: the share of the past month's windows that scored this high or higher.
  const past = opts.past || [], share = past.length ? Math.max(1, Math.ceil(past.filter(p => p.score >= w.score).length / past.length * 100)) : null;
  const rank = kind === "weekly" ? "Best of your week." : share ? `Top ${share}% of your month.` : "One of your best this month.";
  // Where and with what, from their own log.
  let call = null;
  if (opts.log?.length && w.c) {
    const r = Core.bestCall(opts.log, { temp: w.c.temp, hour: w.hour ?? 12, doy: Core.dayOfYear(w.date), sky: w.c.sky, press: w.c.press, flow: null });
    if (r && r.k <= 2.5) call = `${clip(r.water, 26)}${r.spot ? `, ${clip(r.spot, 20).toLowerCase()}` : ""}${r.lure ? ` · ${clip(r.lure, 22).toLowerCase()}` : ""}`;
  }
  const reasons = w.drivers.filter(d => d.v > 0).slice(0, 2).map(d => SHORT[d.label] || d.label.toLowerCase()).join(", ");
  const span = peakSpan(w, sub.tz);
  const body = `${span ? `Peak ${span}. ` : ""}${call ? `${call}. ${rank}` : `${rank}${reasons ? ` ${reasons.charAt(0).toUpperCase() + reasons.slice(1)}.` : ""}`}`;
  return { title, body, call };
}
