// POST /api/sync — two-way sync of a signed-in angler's log.
// Body: { since, trips: [{ id, data, updated } | { id, deleted: true, updated }], meta: { data, updated } | null }
// Each trip keeps whichever version was saved last (by its updated time). Deleted trips stay as tombstones so
// other devices learn about the delete. Returns everything changed after `since`, plus notes and settings.
import { json } from "../_lib.js";
import { db, handle, fail, requireUser, requireCloud } from "../_auth.js";

const MAX_PUSH = 500, PAGE = 1000, MAX_TRIP = 64 * 1024, MAX_TRIPS = 20000;
const ID_RE = /^[A-Za-z0-9._-]{1,64}$/;

// Client clocks can be wrong; never accept a time more than a day ahead, or the trip could never be edited again.
function cleanTime(t) {
  const ms = Date.parse(t);
  if (!Number.isFinite(ms)) fail("A trip had a bad timestamp.");
  return new Date(Math.min(ms, Date.now() + 864e5)).toISOString();
}

export async function onRequestPost({ request, env }) {
  return handle(async () => {
    if (!(request.headers.get("content-type") || "").includes("application/json")) fail("Send JSON.", 415);
    const user = await requireUser(request, env); requireCloud(user, env);
    const body = await request.json().catch(() => null);
    if (!body || typeof body !== "object") fail("Send JSON.");
    const since = Math.max(0, Number.parseInt(body.since, 10) || 0);
    const push = Array.isArray(body.trips) ? body.trips : [];
    if (push.length > MAX_PUSH) fail(`Send at most ${MAX_PUSH} trips at a time.`);
    const DB = await db(env);

    const rows = push.map(t => {
      if (!t || !ID_RE.test(String(t.id))) fail("A trip had a bad id.");
      const updated = cleanTime(t.updated);
      if (t.deleted) return { id: t.id, data: null, updated, deleted: 1 };
      if (!t.data || typeof t.data !== "object" || Array.isArray(t.data)) fail("A trip was empty.");
      const data = JSON.stringify({ ...t.data, id: t.id });
      if (data.length > MAX_TRIP) fail("A trip was too large to sync.", 413);
      return { id: t.id, data, updated, deleted: 0 };
    });

    if (rows.length) {
      const { n } = await DB.prepare("SELECT COUNT(*) AS n FROM trips WHERE user_id = ?").bind(user.id).first();
      if (n + rows.filter(r => !r.deleted).length > MAX_TRIPS) fail("That's more trips than fishr Cloud holds for one account.", 413);
      const { seq } = await DB.prepare("UPDATE users SET seq = seq + 1 WHERE id = ? RETURNING seq").bind(user.id).first();
      // Last write wins: an incoming version only replaces the stored one if it's newer.
      await DB.batch(rows.map(r => DB.prepare(
        `INSERT INTO trips (user_id, id, data, updated, deleted, seq) VALUES (?, ?, ?, ?, ?, ?)
         ON CONFLICT (user_id, id) DO UPDATE SET data = excluded.data, updated = excluded.updated, deleted = excluded.deleted, seq = excluded.seq
         WHERE excluded.updated > trips.updated`).bind(user.id, r.id, r.data, r.updated, r.deleted, seq)));
    }

    if (body.meta && typeof body.meta === "object" && body.meta.data && typeof body.meta.data === "object") {
      const data = JSON.stringify({ notes: Array.isArray(body.meta.data.notes) ? body.meta.data.notes.filter(n => typeof n === "string").slice(0, 200) : [],
        settings: body.meta.data.settings && typeof body.meta.data.settings === "object" ? body.meta.data.settings : {} });
      if (data.length > MAX_TRIP) fail("Notes were too large to sync.", 413);
      await DB.prepare(`INSERT INTO meta (user_id, data, updated) VALUES (?, ?, ?)
        ON CONFLICT (user_id) DO UPDATE SET data = excluded.data, updated = excluded.updated WHERE excluded.updated > meta.updated`)
        .bind(user.id, data, cleanTime(body.meta.updated)).run();
    }

    // Changes since the device last synced, oldest first, a page at a time.
    let { results } = await DB.prepare("SELECT id, data, updated, deleted, seq FROM trips WHERE user_id = ? AND seq > ? ORDER BY seq LIMIT ?").bind(user.id, since, PAGE + 1).all();
    let more = false;
    if (results.length > PAGE) {
      // Don't split a batch that shares one seq across pages.
      more = true; results = results.slice(0, PAGE);
      const last = results[results.length - 1].seq, trimmed = results.filter(r => r.seq !== last);
      if (trimmed.length) results = trimmed;
    }
    const cursor = results.length ? results[results.length - 1].seq : since;
    const meta = await DB.prepare("SELECT data, updated FROM meta WHERE user_id = ?").bind(user.id).first();
    return json({
      cursor, more,
      trips: results.map(r => r.deleted ? { id: r.id, deleted: true, updated: r.updated } : { id: r.id, data: JSON.parse(r.data), updated: r.updated }),
      meta: meta ? { data: JSON.parse(meta.data), updated: meta.updated } : null,
    });
  });
}
