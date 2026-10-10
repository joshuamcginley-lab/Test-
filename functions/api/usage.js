// Anonymous usage counts: how many phones reached each milestone, per day. Nothing about the person, their trips
// or their phone is stored: the app sends a milestone name once (the first time it happens on that phone), and
// the server adds 1 to that day's total.
// POST /api/usage {event}            -> { ok }
// GET  /api/usage (x-admin-key)      -> { totals, last30, days: [{day, event, n}] }  for the admin page
import { json, isAdmin } from "../_lib.js";
import { db, isJson } from "../_auth.js";
import { underLimit } from "../_limits.js";

// The milestones the app reports. Anything else is ignored.
export const EVENTS = ["open", "showcase", "trip1", "trip3", "trip5", "trip10", "guide", "retained14", "retained30", "active", "cloud", "ask", "fishrid"];
const DAILY_PER_VISITOR = 60; // far more than one phone sends; stops one visitor inflating the numbers

export async function onRequestPost({ request, env }) {
  if (!env.DB) return json({ ok: true });
  if (!isJson(request)) return json({ error: "Send JSON." }, 415);
  const body = await request.json().catch(() => null);
  const event = typeof body?.event === "string" ? body.event : "";
  if (!EVENTS.includes(event)) return json({ error: "Unknown event." }, 400);
  if (!await underLimit(env, request, "usage", DAILY_PER_VISITOR)) return json({ ok: true }); // quietly drop
  await (await db(env)).prepare("INSERT INTO usage_counts (day, event, n) VALUES (?, ?, 1) ON CONFLICT (day, event) DO UPDATE SET n = n + 1")
    .bind(new Date().toISOString().slice(0, 10), event).run();
  return json({ ok: true });
}

export async function onRequestGet({ request, env }) {
  if (!isAdmin(request, env)) return json({ error: "Not allowed." }, 403);
  if (!env.DB) return json({ totals: {}, last30: {}, days: [] });
  const DB = await db(env), since = new Date(Date.now() - 30 * 864e5).toISOString().slice(0, 10), since120 = new Date(Date.now() - 120 * 864e5).toISOString().slice(0, 10);
  const sum = rows => Object.fromEntries(rows.map(r => [r.event, r.n]));
  const totals = sum((await DB.prepare("SELECT event, SUM(n) AS n FROM usage_counts GROUP BY event").all()).results);
  const last30 = sum((await DB.prepare("SELECT event, SUM(n) AS n FROM usage_counts WHERE day >= ? GROUP BY event").bind(since).all()).results);
  const days = (await DB.prepare("SELECT day, event, n FROM usage_counts WHERE day >= ? AND event = 'active' ORDER BY day").bind(since120).all()).results;
  return json({ totals, last30, days }, 200);
}
