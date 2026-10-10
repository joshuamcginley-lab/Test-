// fishr AI (Ask fishr and fishr ID): the Claude client, daily allowances, and turning a fishing log into prompt text.
// Needs the ANTHROPIC_API_KEY secret in Cloudflare. Usage is counted per account per day in D1 (table ai_usage).
import Anthropic from "./_vendor/anthropic-sdk.js";
import { db, fail } from "./_auth.js";

export const MODEL = "claude-haiku-5-5";

export function claude(env) {
  if (!env.ANTHROPIC_API_KEY) fail("fishr AI isn't switched on yet.", 503);
  return new Anthropic({ apiKey: env.ANTHROPIC_API_KEY, maxRetries: 1, timeout: 45000 });
}

// Turn SDK errors into messages people can act on; the details stay out of the response.
export function aiError(e) {
  if (e.status && !(e instanceof Anthropic.APIError)) return e; // already one of ours
  if (e instanceof Anthropic.AuthenticationError || e instanceof Anthropic.PermissionDeniedError) return Object.assign(new Error("fishr AI isn't switched on yet."), { status: 503 });
  if (e instanceof Anthropic.RateLimitError) return Object.assign(new Error("fishr AI is busy right now. Try again in a minute."), { status: 503 });
  if (e instanceof Anthropic.BadRequestError) return Object.assign(new Error("fishr AI couldn't read that. Try again."), { status: 400 });
  return Object.assign(new Error("fishr AI didn't answer. Try again in a minute."), { status: 502 });
}

export const textOf = msg => msg.content.filter(b => b.type === "text").map(b => b.text).join("").trim();

/* ---------- daily allowances ---------- */
const int = (v, d) => { const n = Number.parseInt(v, 10); return Number.isFinite(n) && n >= 0 ? n : d; };
// Free during the beta for fishr Cloud accounts. AI_PRO_ONLY=true limits it to Pro accounts.
export function allowance(env, kind, plan) {
  const pro = plan === "pro";
  if (kind === "sample") return int(env.AI_DAILY_SAMPLE, 3);
  if (kind === "idguest") return int(env.AI_DAILY_ID_GUEST, 3);
  if (kind === "chat") return pro ? int(env.AI_DAILY_CHAT_PRO, 50) : int(env.AI_DAILY_CHAT, 5);
  return pro ? int(env.AI_DAILY_PHOTO_PRO, 100) : int(env.AI_DAILY_PHOTO, 10);
}
export function requireAI(user, env) {
  if (String(env.AI_PRO_ONLY || "").toLowerCase() === "true" && user.plan !== "pro") fail("fishr AI is part of fishr Pro.", 402);
}
const today = () => new Date().toISOString().slice(0, 10);

export async function usedToday(env, who, kind) {
  const row = await (await db(env)).prepare("SELECT n FROM ai_usage WHERE user_id = ? AND day = ? AND kind = ?").bind(who, today(), kind).first();
  return row?.n || 0;
}

// Reserve one use before calling Claude (so parallel requests can't overshoot). Returns { left, release }.
// AI_DAILY_TOTAL caps everyone together, so a bad day can't run up the bill.
export async function takeOne(env, who, kind, limit) {
  const DB = await db(env), day = today();
  const bump = (u, k) => DB.prepare("INSERT INTO ai_usage (user_id, day, kind, n) VALUES (?, ?, ?, 1) ON CONFLICT (user_id, day, kind) DO UPDATE SET n = n + 1 RETURNING n").bind(u, day, k).first();
  const drop = (u, k) => DB.prepare("UPDATE ai_usage SET n = n - 1 WHERE user_id = ? AND day = ? AND kind = ? AND n > 0").bind(u, day, k).run();
  const all = await bump("*", "all");
  if (all.n === 1) await DB.prepare("DELETE FROM ai_usage WHERE day < ?").bind(new Date(Date.now() - 7 * 864e5).toISOString().slice(0, 10)).run();
  if (all.n > int(env.AI_DAILY_TOTAL, 300)) { await drop("*", "all"); fail("fishr AI has hit today's limit. It resets at midnight UTC.", 429); }
  // Visitors without an account share a smaller pool, so they can never use up the day for account holders.
  const guest = kind === "sample" || kind === "idguest";
  if (guest && (await bump("*", "guest")).n > int(env.AI_DAILY_GUEST_TOTAL, 100)) {
    await Promise.all([drop("*", "all"), drop("*", "guest")]);
    fail("fishr AI's free tries are used up for today. Turn on fishr Cloud (free) to keep going.", 429);
  }
  const mine = await bump(who, kind);
  if (mine.n > limit) {
    await Promise.all([drop("*", "all"), drop(who, kind), guest && drop("*", "guest")]);
    fail(kind === "idguest" ? `That's today's ${limit} free fishr IDs. Turn on fishr Cloud (free) for more.`
      : kind === "photo" ? `That's all ${limit} fishr IDs for today. More tomorrow.` : `That's all ${limit} questions for today. More tomorrow.`, 429);
  }
  let released = false;
  return { left: limit - mine.n, release: () => released ? null : (released = true, Promise.all([drop("*", "all"), drop(who, kind), guest && drop("*", "guest")])) };
}

// Give a use back only when the request never reached the model (bad request, auth, rate limit, no connection).
// Timeouts and server errors may already have run, so they still count.
export function shouldRelease(e) {
  if (e instanceof Anthropic.APIConnectionTimeoutError) return false;
  if (e instanceof Anthropic.APIConnectionError) return true;
  return e instanceof Anthropic.APIError && e.status >= 400 && e.status < 500;
}

// Anonymous visitors asking about the showcase are counted by a hash of their IP (the IP itself isn't stored).
export async function visitorId(request) {
  let ip = request.headers.get("cf-connecting-ip") || "unknown";
  // One IPv6 connection usually owns a whole /64, so count the /64 rather than each address in it.
  if (ip.includes(":")) ip = ip.split(":").slice(0, 4).join(":") + "::/64";
  const buf = await crypto.subtle.digest("SHA-256", new TextEncoder().encode("fishr-visitor:" + ip));
  return "ip:" + [...new Uint8Array(buf)].slice(0, 12).map(b => b.toString(16).padStart(2, "0")).join("");
}

/* ---------- the log as prompt text ---------- */
const clip = (s, n) => { s = String(s ?? "").replace(/\s+/g, " ").trim(); return s.length > n ? s.slice(0, n - 1) + "…" : s; };
const DAYS = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];

// One line per trip, oldest first. Weights in lb, lengths in inches, temperatures in °C (how the app stores them).
export function tripLine(s) {
  const d = new Date(s.date + "T12:00:00Z"), parts = [];
  const when = [clip(s.date, 10), DAYS[d.getUTCDay()], s.start ? `${clip(s.start, 5)}${s.end ? "-" + clip(s.end, 5) : ""}` : clip(s.period, 12)].filter(Boolean).join(" ");
  parts.push(when);
  parts.push(clip(s.water, 60) + (s.spot ? ` (${clip(s.spot, 60)})` : ""));
  const w = [];
  if (s.tempLow != null) w.push(s.tempHigh != null && s.tempHigh !== s.tempLow ? `logged ${s.tempLow}-${s.tempHigh}°C` : `logged ${s.tempLow}°C`);
  if (s.wx) {
    const x = s.wx;
    if (x.t != null && s.tempLow == null) w.push(`${x.t}°C`);
    if (x.sky) w.push(clip(x.sky, 12).toLowerCase());
    if (x.p) w.push(`${clip(x.p, 6)} hPa${x.trend ? " " + clip(x.trend, 10).toLowerCase() : ""}`);
    if (x.wind != null) w.push(`wind ${clip(x.wind, 5)} km/h${x.windDir ? " " + clip(x.windDir, 3) : ""}`);
    if (x.rain48 != null) w.push(`${clip(x.rain48, 6)} mm rain in 48h`);
  }
  if (s.flow?.status) w.push(`river ${clip(s.flow.status, 10).toLowerCase()}${s.flow.trend ? " and " + clip(s.flow.trend, 10) : ""}`);
  if (Array.isArray(s.conditions) && s.conditions.length) w.push(clip(s.conditions.join(", "), 120).toLowerCase());
  if (w.length) parts.push(w.join(", "));
  if (s.method) parts.push(clip(s.method, 20));
  const catches = (Array.isArray(s.catches) ? s.catches : []).filter(c => c && c.species).slice(0, 20);
  parts.push(catches.length ? "caught " + catches.map(c => `${clip(c.count || 1, 4)}x ${clip(c.species, 40)}${c.lb != null ? ` ${clip(c.lb, 6)} lb` : c.size ? ` ${clip(c.size, 12)}` : ""}${c.inches != null ? ` ${clip(c.inches, 6)} in` : ""}${c.lure ? ` on ${clip(c.lure, 40)}` : ""}`).join("; ") : "skunked");
  if (s.lureText) parts.push(`lures: ${clip(s.lureText, 80)}`);
  if (s.notes) parts.push(`notes: ${clip(s.notes, 200)}`);
  return parts.join(" | ");
}
export function logText(trips, notes = []) {
  const rows = [...trips].filter(s => s && s.date && s.water).sort((a, b) => String(a.date).localeCompare(String(b.date))).slice(-400);
  const fish = rows.reduce((a, s) => a + (Array.isArray(s.catches) ? s.catches : []).reduce((b, c) => b + (Number(c?.count) || 1), 0), 0);
  // Keep the prompt a sensible size: newest trips first until about 120k characters, then back in date order.
  const lines = []; let size = 0;
  for (const s of [...rows].reverse()) { const l = tripLine(s); if (size + l.length > 120000) break; lines.unshift(l); size += l.length + 1; }
  let out = `${rows.length} trips, ${fish} fish${lines.length < rows.length ? ` (the newest ${lines.length} are listed)` : ""}.\n` + lines.join("\n");
  if (notes.length) out += "\n\nAngler's field notes:\n" + notes.slice(0, 40).map(n => "- " + clip(n, 200)).join("\n");
  return out;
}

// What the app knows about right now (from the Guide tab's inputs and the live forecast), as one short block.
export function conditionsText(c) {
  if (!c || typeof c !== "object") return "No current conditions were sent.";
  const t = (v, n = 40) => (typeof v === "string" || typeof v === "number" ? clip(v, n) : "");
  const lines = [];
  const now = [t(c.date, 10), t(c.time, 5), c.temp != null ? `${t(c.temp, 6)}°C` : "", t(c.sky), c.pressure ? `pressure ${t(c.pressure)}` : "", c.flow ? `river ${t(c.flow)}` : "", c.wind != null ? `wind ${t(c.wind, 6)} km/h` : "", c.place ? `near ${t(c.place, 60)}` : ""].filter(Boolean);
  if (now.length) lines.push("Now: " + now.join(", "));
  if (t(c.front, 160)) lines.push("Front: " + t(c.front, 160));
  if (Array.isArray(c.forecast) && c.forecast.length) lines.push("Forecast: " + c.forecast.slice(0, 16).map(f => t(f, 60)).join("; "));
  return lines.join("\n") || "No current conditions were sent.";
}

// Names the species picker uses, so fishr ID fills in a name the log already knows.
export const SPECIES = ["Smallmouth bass", "Largemouth bass", "Spotted bass", "Striped bass", "White bass", "Rock bass", "Brook trout", "Rainbow trout", "Brown trout", "Lake trout",
  "Cutthroat trout", "Steelhead", "Atlantic salmon", "Chinook salmon", "Coho salmon", "Sockeye salmon", "Pink salmon", "Arctic char", "Splake", "Northern pike", "Muskie", "Tiger muskie",
  "Pickerel", "Walleye", "Sauger", "Yellow perch", "White perch", "Bluegill", "Pumpkinseed", "Black crappie", "White crappie", "Redear sunfish", "Green sunfish", "Channel catfish",
  "Blue catfish", "Flathead catfish", "Bullhead", "Common carp", "Chub", "Fallfish", "Freshwater drum", "Lake whitefish", "Burbot", "Bowfin", "Gar", "Sturgeon", "American shad",
  "Bluefish", "Mackerel", "Red drum", "Snook", "Tarpon", "Atlantic cod", "Halibut", "Flounder"];
