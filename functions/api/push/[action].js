// Bite alerts (web push).
// GET  /api/push/key                        -> { key }   the public push key, or null if alerts aren't set up yet
// POST /api/push/subscribe   {endpoint, keys:{p256dh, auth}, lat, lon, tz, place?}  -> { ok }  (links a fishr Cloud account if signed in)
// POST /api/push/unsubscribe {endpoint}     -> { ok }
// POST /api/push/run?cursor= (x-cron-key)   -> { done, cursor, checked, sent }  called hourly; handles a few subscribers per call
// GET  /api/push/stats       (x-admin-key)  -> { subscribers }
// POST /api/push/test        (x-admin-key) {endpoint} -> { status }  sends a test alert to that device
import { json, isAdmin } from "../../_lib.js";
import { db, isJson, currentUser } from "../../_auth.js";
import { underLimit } from "../../_limits.js";
import { sendPush, pushHostOk } from "../../_webpush.js";
import { decide, decideKeys, fetchSpotWeather, scoreWindows, slotPlan, localParts, tzOk } from "../../_alerts.js";

const BATCH = 3; // subscribers per call: keeps each call well inside Cloudflare's free-plan limits
const idOf = async endpoint => [...new Uint8Array(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(endpoint)))].slice(0, 16).map(b => b.toString(16).padStart(2, "0")).join("");
const sameText = (a, b) => { a = String(a || ""); b = String(b || ""); if (!a || a.length !== b.length) return false; let d = 0; for (let i = 0; i < a.length; i++) d |= a.charCodeAt(i) ^ b.charCodeAt(i); return d === 0; };
const num = v => typeof v === "number" && Number.isFinite(v) ? v : null;

const actions = {
  async key({ env }) { return json({ key: env.VAPID_PUBLIC && env.VAPID_PRIVATE ? env.VAPID_PUBLIC : null }); },

  async subscribe({ request, env, body }) {
    const endpoint = String(body.endpoint || ""), p256dh = String(body.keys?.p256dh || ""), auth = String(body.keys?.auth || "");
    const lat = num(body.lat), lon = num(body.lon), tz = String(body.tz || "");
    if (!pushHostOk(endpoint, env) || endpoint.length > 1000) return json({ error: "That isn't a push address fishr can use." }, 400);
    if (!/^[\w-]{80,100}$/.test(p256dh) || !/^[\w-]{16,32}$/.test(auth)) return json({ error: "Missing push keys." }, 400);
    if (lat == null || lon == null || Math.abs(lat) > 90 || Math.abs(lon) > 180 || !tzOk(tz)) return json({ error: "Need your location and time zone." }, 400);
    if (!await underLimit(env, request, "push-sub", 30)) return json({ error: "Too many changes today. Try again tomorrow." }, 429);
    const user = await currentUser(request, env).catch(() => null), now = new Date().toISOString();
    const place = typeof body.place === "string" ? body.place.replace(/[^\p{L}\p{N} ,.'-]/gu, "").slice(0, 40) || null : null;
    await (await db(env)).prepare(`INSERT INTO push_subs (id, endpoint, p256dh, auth, lat, lon, tz, place, user_id, created, updated) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT (id) DO UPDATE SET p256dh = excluded.p256dh, auth = excluded.auth, lat = excluded.lat, lon = excluded.lon, tz = excluded.tz, place = excluded.place, user_id = excluded.user_id, updated = excluded.updated, fails = 0`)
      // About 1 km is plenty for weather, and all that's kept.
      .bind(await idOf(endpoint), endpoint, p256dh, auth, Math.round(lat * 100) / 100, Math.round(lon * 100) / 100, tz, place, user?.id || null, now, now).run();
    return json({ ok: true });
  },

  async unsubscribe({ env, body }) {
    if (body.endpoint) await (await db(env)).prepare("DELETE FROM push_subs WHERE id = ?").bind(await idOf(String(body.endpoint))).run();
    return json({ ok: true });
  },

  async run({ request, env }) {
    if (!sameText(request.headers.get("x-cron-key"), env.PUSH_CRON_KEY) && !isAdmin(request, env)) return json({ error: "Not allowed." }, 403);
    if (!env.VAPID_PUBLIC || !env.VAPID_PRIVATE) return json({ done: true, cursor: "", checked: 0, sent: 0, note: "push keys not set" });
    const DB = await db(env), u = new URL(request.url);
    const now = env.PUSH_TEST === "1" && u.searchParams.get("now") ? Date.parse(u.searchParams.get("now")) : Date.now();
    // Only subscribers whose local time is a send time right now.
    const tzs = (await DB.prepare("SELECT DISTINCT tz FROM push_subs").all()).results.map(r => r.tz).filter(tz => tzOk(tz) && (() => { const L = localParts(now, tz); return !!slotPlan(L.dow, L.hour); })());
    if (!tzs.length) return json({ done: true, cursor: "", checked: 0, sent: 0 });
    const cursor = String(u.searchParams.get("cursor") || "");
    const subs = (await DB.prepare(`SELECT * FROM push_subs WHERE tz IN (${tzs.map(() => "?").join(",")}) AND id > ? ORDER BY id LIMIT ?`).bind(...tzs, cursor, BATCH).all()).results;
    let checked = 0, sent = 0;
    for (const sub of subs) {
      const L = localParts(now, sub.tz), plan = slotPlan(L.dow, L.hour), slotKey = `${L.date}-${plan.slot}`;
      if (sub.slot === slotKey) continue; // already looked at this send time
      // Both alerts already used for this weekend and week: nothing to look up.
      const weekendUsed = !plan.weekend.length || sub.weekend === decideKeys(now, sub.tz).weekendKey, weeklyUsed = !plan.weekly.length || sub.weekly === decideKeys(now, sub.tz).weekKey;
      if (weekendUsed && weeklyUsed) { await DB.prepare("UPDATE push_subs SET slot = ? WHERE id = ?").bind(slotKey, sub.id).run(); continue; }
      checked++;
      let result;
      try {
        const W = await fetchSpotWeather(sub.lat, sub.lon, sub.tz);
        // fishr Cloud anglers get scores weighted by their own log, the same as in the app.
        const log = sub.user_id ? (await DB.prepare("SELECT data FROM trips WHERE user_id = ? AND deleted = 0 LIMIT 2000").bind(sub.user_id).all()).results.map(r => { try { return JSON.parse(r.data); } catch (e) { return null; } }).filter(Boolean) : [];
        result = decide(sub, scoreWindows(W, { log }), now);
      } catch (e) { continue; } // weather service down: leave this send time open so the next hour tries again
      let status = null;
      if (result.send) {
        status = await sendPush(env, sub, { title: result.send.title, body: result.send.body, url: "/?go=advice", tag: "fishr-bite" }).catch(() => 0);
        if (status === 404 || status === 410) { await DB.prepare("DELETE FROM push_subs WHERE id = ?").bind(sub.id).run(); continue; }
        if (status >= 200 && status < 300) sent++;
      }
      const ok = status >= 200 && status < 300;
      await DB.prepare("UPDATE push_subs SET slot = ?, weekend = ?, weekly = ?, fails = ? WHERE id = ?").bind(
        slotKey,
        ok && result.send.kind === "weekend" ? result.weekendKey : sub.weekend,
        ok && (result.send.kind === "weekly" || result.send.alsoWeekly) ? result.weekKey : sub.weekly,
        result.send && !ok ? (sub.fails || 0) + 1 : 0, sub.id).run();
      if (result.send && !ok && (sub.fails || 0) + 1 >= 5) await DB.prepare("DELETE FROM push_subs WHERE id = ?").bind(sub.id).run();
    }
    return json({ done: subs.length < BATCH, cursor: subs.length ? subs[subs.length - 1].id : cursor, checked, sent });
  },

  async stats({ request, env }) {
    if (!isAdmin(request, env)) return json({ error: "Not allowed." }, 403);
    const r = await (await db(env)).prepare("SELECT COUNT(*) AS n, SUM(user_id IS NOT NULL) AS cloud FROM push_subs").first();
    return json({ subscribers: r?.n || 0, cloud: r?.cloud || 0, ready: !!(env.VAPID_PUBLIC && env.VAPID_PRIVATE), cron: !!env.PUSH_CRON_KEY });
  },

  async test({ request, env, body }) {
    if (!isAdmin(request, env)) return json({ error: "Not allowed." }, 403);
    const sub = await (await db(env)).prepare("SELECT * FROM push_subs WHERE id = ?").bind(await idOf(String(body.endpoint || ""))).first();
    if (!sub) return json({ error: "Turn on bite alerts on this device first (Settings in the app)." }, 404);
    const status = await sendPush(env, sub, { title: "Test: bite alerts work", body: "This is what a fishr bite alert looks like. Tap to open the Guide.", url: "/?go=advice", tag: "fishr-test" }).catch(() => 0);
    if (status === 404 || status === 410) await (await db(env)).prepare("DELETE FROM push_subs WHERE id = ?").bind(sub.id).run();
    return json({ status });
  },
};

export async function onRequest({ request, env, params }) {
  if (!Object.hasOwn(actions, params.action)) return json({ error: "Not found." }, 404);
  const isGet = ["key", "stats"].includes(params.action);
  if (isGet !== (request.method === "GET")) return json({ error: "Method not allowed." }, 405);
  if (!env.DB) return json({ error: "Not available." }, 503);
  let body = {};
  if (!isGet) {
    if (params.action !== "run" && !isJson(request)) return json({ error: "Send JSON." }, 415);
    body = params.action === "run" ? {} : await request.json().catch(() => ({})) || {};
  }
  return actions[params.action]({ request, env, body });
}
