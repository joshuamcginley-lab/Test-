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
  const mine = await bump(who, kind);
  if (mine.n > limit) {
    await Promise.all([drop("*", "all"), drop(who, kind)]);
    fail(kind === "idguest" ? `That's today's ${limit} free fishr IDs. Turn on fishr Cloud (free) for more.`
      : kind === "photo" ? `That's all ${limit} fishr IDs for today. More tomorrow.` : `That's all ${limit} questions for today. More tomorrow.`, 429);
  }
  return { left: limit - mine.n, release: () => Promise.all([drop("*", "all"), drop(who, kind)]) };
}

// Anonymous visitors asking about the showcase are counted by a hash of their IP (the IP itself isn't stored).
export async function visitorId(request) {
  const ip = request.headers.get("cf-connecting-ip") || "unknown";
  const buf = await crypto.subtle.digest("SHA-256", new TextEncoder().encode("fishr-visitor:" + ip));
  return "ip:" + [...new Uint8Array(buf)].slice(0, 12).map(b => b.toString(16).padStart(2, "0")).join("");
}

/* ---------- the log as prompt text ---------- */
const clip = (s, n) => { s = String(s ?? "").replace(/\s+/g, " ").trim(); return s.length > n ? s.slice(0, n - 1) + "…" : s; };
const DAYS = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];

// One line per trip, oldest first. Weights in lb, lengths in inches, temperatures in °C (how the app stores them).
export function tripLine(s) {
  const d = new Date(s.date + "T12:00:00Z"), parts = [];
  const when = [s.date, DAYS[d.getUTCDay()], s.start ? `${s.start}${s.end ? "-" + s.end : ""}` : s.period || ""].filter(Boolean).join(" ");
  parts.push(when);
  parts.push(clip(s.water, 60) + (s.spot ? ` (${clip(s.spot, 60)})` : ""));
  const w = [];
  if (s.tempLow != null) w.push(s.tempHigh != null && s.tempHigh !== s.tempLow ? `logged ${s.tempLow}-${s.tempHigh}°C` : `logged ${s.tempLow}°C`);
  if (s.wx) {
    const x = s.wx;
    if (x.t != null && s.tempLow == null) w.push(`${x.t}°C`);
    if (x.sky) w.push(x.sky.toLowerCase());
    if (x.p) w.push(`${x.p} hPa${x.trend ? " " + x.trend.toLowerCase() : ""}`);
    if (x.wind != null) w.push(`wind ${x.wind} km/h${x.windDir ? " " + x.windDir : ""}`);
    if (x.rain48 != null) w.push(`${x.rain48} mm rain in 48h`);
  }
  if (s.flow?.status) w.push(`river ${String(s.flow.status).toLowerCase()}${s.flow.trend ? " and " + s.flow.trend : ""}`);
  if ((s.conditions || []).length) w.push(s.conditions.join(", ").toLowerCase());
  if (w.length) parts.push(w.join(", "));
  if (s.method) parts.push(s.method);
  const catches = (s.catches || []).filter(c => c && c.species);
  parts.push(catches.length ? "caught " + catches.map(c => `${c.count || 1}x ${clip(c.species, 40)}${c.lb != null ? ` ${c.lb} lb` : c.size ? ` ${clip(c.size, 12)}` : ""}${c.inches != null ? ` ${c.inches} in` : ""}${c.lure ? ` on ${clip(c.lure, 40)}` : ""}`).join("; ") : "skunked");
  if (s.lureText) parts.push(`lures: ${clip(s.lureText, 80)}`);
  if (s.notes) parts.push(`notes: ${clip(s.notes, 200)}`);
  return parts.join(" | ");
}
export function logText(trips, notes = []) {
  const rows = [...trips].filter(s => s && s.date && s.water).sort((a, b) => a.date.localeCompare(b.date)).slice(-400);
  const fish = rows.reduce((a, s) => a + (s.catches || []).reduce((b, c) => b + (c.count || 1), 0), 0);
  let out = `${rows.length} trips, ${fish} fish.\n` + rows.map(tripLine).join("\n");
  if (notes.length) out += "\n\nAngler's field notes:\n" + notes.slice(0, 40).map(n => "- " + clip(n, 200)).join("\n");
  return out;
}

// What the app knows about right now (from Copilot's inputs and the live forecast), as one short block.
export function conditionsText(c) {
  if (!c || typeof c !== "object") return "No current conditions were sent.";
  const t = (v, n = 40) => (typeof v === "string" || typeof v === "number" ? clip(v, n) : "");
  const lines = [];
  const now = [t(c.date, 10), t(c.time, 5), c.temp != null ? `${t(c.temp, 6)}°C` : "", t(c.sky), c.pressure ? `pressure ${t(c.pressure)}` : "", c.flow ? `river ${t(c.flow)}` : "", c.wind != null ? `wind ${t(c.wind, 6)} km/h` : "", c.place ? `near ${t(c.place, 60)}` : ""].filter(Boolean);
  if (now.length) lines.push("Now: " + now.join(", "));
  if (Array.isArray(c.forecast) && c.forecast.length) lines.push("Forecast: " + c.forecast.slice(0, 16).map(f => t(f, 60)).join("; "));
  return lines.join("\n") || "No current conditions were sent.";
}

// Names the species picker uses, so fishr ID fills in a name the log already knows.
export const SPECIES = ["Smallmouth bass", "Largemouth bass", "Spotted bass", "Striped bass", "White bass", "Rock bass", "Brook trout", "Rainbow trout", "Brown trout", "Lake trout",
  "Cutthroat trout", "Steelhead", "Atlantic salmon", "Chinook salmon", "Coho salmon", "Sockeye salmon", "Pink salmon", "Arctic char", "Splake", "Northern pike", "Muskie", "Tiger muskie",
  "Pickerel", "Walleye", "Sauger", "Yellow perch", "White perch", "Bluegill", "Pumpkinseed", "Black crappie", "White crappie", "Redear sunfish", "Green sunfish", "Channel catfish",
  "Blue catfish", "Flathead catfish", "Bullhead", "Common carp", "Chub", "Fallfish", "Freshwater drum", "Lake whitefish", "Burbot", "Bowfin", "Gar", "Sturgeon", "American shad",
  "Bluefish", "Mackerel", "Red drum", "Snook", "Tarpon", "Atlantic cod", "Halibut", "Flounder"];
