// POST /api/sync — two-way sync of a signed-in angler's log.
// Body: { since, trips: [{ id, data, updated } | { id, deleted: true, updated }], meta: { data, updated } | null }
// Each trip keeps whichever version was saved last (by its updated time). Deleted trips stay as tombstones so
// other devices learn about the delete. Returns everything changed after `since`, plus notes and settings.
import { json } from "../_lib.js";
import { db, handle, fail, requireUser, requireCloud, isJson } from "../_auth.js";

const MAX_PUSH = 500, PAGE = 1000, MAX_TRIP = 64 * 1024, MAX_TRIPS = 20000;
const MAX_NOTES = 200; // note lines
const MAX_BYTES = 20 * 1024 * 1024; // all of one account's trips; a real season is well under 1 MB
const ID_RE = /^[A-Za-z0-9._-]{1,64}$/;

// Client clocks can be wrong; never accept a time more than a day ahead, or the trip could never be edited again.
function cleanTime(t) {
  const ms = Date.parse(t);
  if (!Number.isFinite(ms)) fail("A trip had a bad timestamp.");
  return new Date(Math.min(ms, Date.now() + 864e5)).toISOString();
}

export async function onRequestPost({ request, env }) {
  return handle(async () => {
    if (!isJson(request)) fail("Send JSON.", 415);
    const user = await requireUser(request, env); requireCloud(user, env);
    const body = await request.json().catch(() => null);
    if (!body || typeof body !== "object") fail("Send JSON.");
    const since = Math.max(0, Number.parseInt(body.since, 10) || 0);
    const push = Array.isArray(body.trips) ? body.trips : [];
    if (push.length > MAX_PUSH) fail(`Send at most ${MAX_PUSH} trips at a time.`);
    const DB = await db(env);

    // Notes and settings, checked before any trip is written: if they can't be stored, the trips still sync and
    // the device is told why (rather than the whole sync failing every time).
    let metaIn = null, metaError = null;
    if (body.meta && typeof body.meta === "object" && body.meta.data && typeof body.meta.data === "object") {
      const notes = Array.isArray(body.meta.data.notes) ? body.meta.data.notes.filter(n => typeof n === "string") : [];
      const data = JSON.stringify({ notes, settings: body.meta.data.settings && typeof body.meta.data.settings === "object" && !Array.isArray(body.meta.data.settings) ? body.meta.data.settings : {} });
      if (notes.length > MAX_NOTES || data.length > MAX_TRIP) metaError = "too-large";
      else if (!Number.isFinite(Date.parse(body.meta.updated))) metaError = "bad-time";
      else metaIn = { data, updated: cleanTime(body.meta.updated), base: typeof body.meta.base === "string" ? body.meta.base : null };
    }

    // A trip the server can't store is skipped (and reported) rather than failing the whole sync.
    const skipped = [];
    const rows = push.map(t => {
      const id = String(t?.id ?? "");
      if (!t || !ID_RE.test(id)) { skipped.push(id.slice(0, 64)); return null; }
      const ms = Date.parse(t.updated);
      if (!Number.isFinite(ms)) { skipped.push(id); return null; }
      const updated = cleanTime(t.updated);
      if (t.deleted) return { id, data: null, updated, deleted: 1 };
      if (!t.data || typeof t.data !== "object" || Array.isArray(t.data)) { skipped.push(id); return null; }
      const data = JSON.stringify({ ...t.data, id });
      if (data.length > MAX_TRIP) { skipped.push(id); return null; }
      return { id, data, updated, deleted: 0 };
    }).filter(Boolean);

    if (rows.length) {
      const { n, bytes } = await DB.prepare("SELECT COUNT(*) AS n, COALESCE(SUM(LENGTH(data)), 0) AS bytes FROM trips WHERE user_id = ?").bind(user.id).first();
      if (n + rows.filter(r => !r.deleted).length > MAX_TRIPS) fail("That's more trips than fishr Cloud holds for one account.", 413);
      // Size after this push: what's stored, minus the versions being replaced, plus the new ones.
      let replaced = 0;
      for (let k = 0; k < rows.length; k += 90) {
        const part = rows.slice(k, k + 90);
        replaced += (await DB.prepare(`SELECT COALESCE(SUM(LENGTH(data)), 0) AS b FROM trips WHERE user_id = ? AND id IN (${part.map(() => "?").join(",")})`).bind(user.id, ...part.map(r => r.id)).first()).b;
      }
      if (bytes - replaced + rows.reduce((a, r) => a + (r.data ? r.data.length : 0), 0) > MAX_BYTES) fail("That's more data than fishr Cloud holds for one account.", 413);
      // One transaction: take the next seq and write the rows with it, so no device can see a later seq first.
      // Last write wins: an incoming version only replaces the stored one if it's newer.
      await DB.batch([DB.prepare("UPDATE users SET seq = seq + 1 WHERE id = ?").bind(user.id), ...rows.map(r => DB.prepare(
        `INSERT INTO trips (user_id, id, data, updated, deleted, seq) VALUES (?, ?, ?, ?, ?, (SELECT seq FROM users WHERE id = ?))
         ON CONFLICT (user_id, id) DO UPDATE SET data = excluded.data, updated = excluded.updated, deleted = excluded.deleted, seq = excluded.seq
         WHERE excluded.updated > trips.updated`).bind(user.id, r.id, r.data, r.updated, r.deleted, user.id))]);
    }

    let metaAccepted = null;
    if (metaIn && metaIn.base == null) {
      // Older app versions: newest time wins.
      await DB.prepare(`INSERT INTO meta (user_id, data, updated) VALUES (?, ?, ?)
        ON CONFLICT (user_id) DO UPDATE SET data = excluded.data, updated = excluded.updated WHERE excluded.updated > meta.updated`)
        .bind(user.id, metaIn.data, metaIn.updated).run();
    } else if (metaIn) {
      // The device says which version it last saw (base). It only wins if nobody has written since then; otherwise
      // it gets the newer copy back, merges, and tries again. The new time is always later than the stored one, so
      // other devices notice the change even if this device's clock is behind.
      const cur = await DB.prepare("SELECT updated FROM meta WHERE user_id = ?").bind(user.id).first();
      if (!cur || cur.updated <= metaIn.base) {
        const later = cur ? new Date(Math.max(Date.parse(metaIn.updated), Date.parse(cur.updated) + 1)).toISOString() : metaIn.updated;
        await DB.prepare(cur
          ? "UPDATE meta SET data = ?, updated = ? WHERE user_id = ? AND updated = ?"
          : "INSERT INTO meta (user_id, data, updated) VALUES (?3, ?1, ?2) ON CONFLICT (user_id) DO NOTHING")
          .bind(...(cur ? [metaIn.data, later, user.id, cur.updated] : [metaIn.data, later, user.id])).run();
        const now = await DB.prepare("SELECT updated FROM meta WHERE user_id = ?").bind(user.id).first();
        metaAccepted = now?.updated === later;
      } else metaAccepted = false;
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
    // Pushes that lost to a newer stored copy: send that copy back so the device doesn't think it won.
    const kept = [];
    for (let k = 0; k < rows.length; k += 90) {
      const part = rows.slice(k, k + 90);
      const { results: cur } = await DB.prepare(`SELECT id, data, updated, deleted FROM trips WHERE user_id = ? AND id IN (${part.map(() => "?").join(",")})`).bind(user.id, ...part.map(r => r.id)).all();
      for (const c of cur) { const mine = part.find(r => r.id === c.id); if (mine && c.updated > mine.updated) kept.push(c.deleted ? { id: c.id, deleted: true, updated: c.updated } : { id: c.id, data: JSON.parse(c.data), updated: c.updated }); }
    }
    const meta = await DB.prepare("SELECT data, updated FROM meta WHERE user_id = ?").bind(user.id).first();
    return json({
      cursor, more, kept, skipped, metaAccepted, metaError,
      trips: results.map(r => r.deleted ? { id: r.id, deleted: true, updated: r.updated } : { id: r.id, data: JSON.parse(r.data), updated: r.updated }),
      meta: meta ? { data: JSON.parse(meta.data), updated: meta.updated } : null,
    });
  });
}
