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
  const y = new Date(Date.UTC(t.getUTCFullYear(), 0, 1)); return `${t.getUTCFullYear()}-W${String(Math.ceil(((t - y) / DAY + 1) / 7)).padStart(2, "0")}`; };

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
  const memo = new Map(), log = opts.log || [];
  const hourScore = (i, rise, set) => {
    if (i < 3 || H[i].temp == null) return null;
    const t = +H[i].time, localHour = new Date(t + off).getUTCHours();
    const dp3 = H[i].p != null && H[i - 3].p != null ? Math.round((H[i].p - H[i - 3].p) * 10) / 10 : null;
    const c = { temp: H[i].temp, sky: skyFromCode(H[i].code), press: dp3 == null ? null : dp3 >= 1 ? "Rising" : dp3 <= -1 ? "Falling" : "Steady", dp3, wind: H[i].wind };
    const light = { ...Core.lightAt(t, rise, set), midday: localHour >= 11 && localHour < 15 };
    return Core.score({ c, light, flow: null, model: null, sp: null, recentTemp: null, front: Core.coldFront(H, new Date(t + 1)) }, { log, memo });
  };
  const out = [];
  W.daily.time.forEach((day, d) => {
    const rise = W.daily.sunrise[d] * 1000, set = W.daily.sunset[d] * 1000, date = new Date(day * 1000 + off).toISOString().slice(0, 10);
    for (const [part, from, to, sun] of [["am", rise - 36e5, rise + 3 * 36e5, rise], ["pm", set - 3 * 36e5, set + 36e5, set]]) {
      let best = null;
      H.forEach((x, i) => { if (+x.time >= from && +x.time <= to) { const s = hourScore(i, rise, set); if (s && (!best || s.score > best.score)) best = { ...s, at: +x.time }; } });
      if (best) out.push({ date, part, sun, score: best.score, drivers: best.drivers, at: best.at });
    }
  });
  return out;
}

// The score a window needs to be in the best `top` share of past windows.
export function cutoff(past, top) {
  const s = past.map(w => w.score).sort((a, b) => b - a);
  return s.length ? s[Math.max(0, Math.ceil(s.length * top) - 1)] : Infinity;
}

// This weekend (named by its Saturday) and this week, in the subscriber's time zone.
export function decideKeys(nowMs, tz) {
  const L = localParts(nowMs, tz);
  const sat = new Date(Date.parse(L.date + "T12:00:00Z") + ((6 - L.dow + 7) % 7 - (L.dow === 0 ? 7 : 0)) * DAY).toISOString().slice(0, 10);
  return { weekendKey: sat, weekKey: isoWeek(L.date) };
}
// Decide for one subscriber now. Returns { send: {kind, window, title, body} | null, slotKey, weekendKey, weekKey }.
export function decide(sub, windows, nowMs) {
  const L = localParts(nowMs, sub.tz), plan = slotPlan(L.dow, L.hour);
  if (!plan) return { send: null };
  const slotKey = `${L.date}-${plan.slot}`, { weekendKey, weekKey } = decideKeys(nowMs, sub.tz);
  const today = L.date, past = windows.filter(w => w.date < today);
  const find = ([ahead, part]) => windows.find(w => w.part === part && w.date === new Date(Date.parse(today + "T12:00:00Z") + ahead * DAY).toISOString().slice(0, 10) && w.sun > nowMs);
  const pick = (list, rule) => {
    const bar = Math.max(rule.min, cutoff(past, rule.top));
    return list.map(find).filter(w => w && w.score >= bar).sort((a, b) => b.score - a.score)[0] || null;
  };
  let send = null;
  if (plan.weekend.length && sub.weekend !== weekendKey) { const w = pick(plan.weekend, RULES.weekend); if (w) send = { kind: "weekend", window: w }; }
  if (!send && plan.weekly.length && sub.weekly !== weekKey) { const w = pick(plan.weekly, RULES.weekly); if (w) send = { kind: "weekly", window: w }; }
  // A weekend window good enough to be the week's best uses up the weekly alert too, so it isn't sent twice.
  if (send?.kind === "weekend" && send.window.score >= Math.max(RULES.weekly.min, cutoff(past, RULES.weekly.top))) send.alsoWeekly = true;
  if (send) Object.assign(send, message(send, sub, nowMs));
  return { send, slotKey, weekendKey, weekKey };
}

// The notification text: the projected Bite Index™ up front, then when, where, the top reasons and the sun time.
// "Projected": it's scored from the forecast, so the live score on the day can land a few points either way.
export function message({ kind, window: w }, sub, nowMs) {
  const L = localParts(nowMs, sub.tz), dayName = new Intl.DateTimeFormat("en-US", { timeZone: sub.tz, weekday: "long" }).format(new Date(w.sun));
  const when = w.date === L.date ? (w.part === "am" ? "this morning" : "this evening") : `${dayName} ${w.part === "am" ? "morning" : "evening"}`;
  const reasons = w.drivers.filter(d => d.v > 0).slice(0, 3).map(d => d.label.toLowerCase());
  const list = reasons.length > 1 ? `${reasons.slice(0, -1).join(", ")} and ${reasons[reasons.length - 1]}` : reasons[0] || "conditions lining up";
  const sunTime = new Intl.DateTimeFormat("en-US", { timeZone: sub.tz, hour: "numeric", minute: "2-digit" }).format(new Date(w.sun));
  const where = sub.place ? ` near ${sub.place}` : "";
  const part = w.part === "am" ? "morning" : "evening";
  const title = `Bite Index™ ${w.score} projected: ${when.charAt(0).toUpperCase() + when.slice(1)}`;
  const rated = kind === "weekend" ? `one of your best ${part}s of the month${where}` : `the best window of your week${where}`;
  const body = `Bite Intelligence™ rates it ${rated}. ${list.charAt(0).toUpperCase() + list.slice(1)}. ${w.part === "am" ? "Sunrise" : "Sunset"} ${sunTime}.`;
  return { title, body };
}
