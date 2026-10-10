// Admin tools for fishr Cloud accounts (admin key only).
// GET  /api/admin/accounts      -> { accounts: [{ id, created, plan, passkeys: [{ label, created, lastUsed }], trips, lastTrip, here }] }
// POST /api/admin/claim-sample  { userId } -> { added, already, notes, total }
// claim-sample copies the showcase season into one account as that angler's own trips (the showcase stays up for
// visitors). The trips keep their ids, so running it twice adds nothing; their phones pick them up on the next sync.
import { json, isAdmin } from "../../_lib.js";
import { db, handle, fail, currentUser, isJson } from "../../_auth.js";

const SAMPLE = "sample/enriched-v1.json";
const ID_RE = /^[A-Za-z0-9._-]{1,64}$/;
// The showcase's notes, the same lines as SAMPLE_NOTES in app.js (a test keeps the two in step).
export const SAMPLE_NOTES = [
  "Evening at Keswick, 19–27°C, chatterbait or white curly tail: strongest producer of the season.",
  "Rain / overcast = reaction baits.",
  "High water after rain = poor. Roughly two-thirds drop in output.",
  "Below ~15°C, catches shift to trout, chub and pickerel. Smallmouth go quiet.",
  "Midday in 25°C+ heat = skunk risk.",
  "Topwater frog hookup rate is 0 for 7. Check hook gap and hookset timing.",
];

// The version with historical weather (saved by /api/sample) if it's been made; otherwise the plain file.
async function sampleTrips(request, env) {
  const saved = env.CATCHES && await env.CATCHES.get(SAMPLE);
  const data = saved ? await saved.json() : await (await env.ASSETS.fetch(new URL("/sample.json", request.url))).json();
  if (!Array.isArray(data) || !data.length) fail("The showcase season couldn't be read.", 500);
  return data;
}

const actions = {
  async accounts({ request, env, DB }) {
    const here = await currentUser(request, env).catch(() => null);
    const { results: users } = await DB.prepare("SELECT id, created, plan FROM users ORDER BY created DESC LIMIT 200").all();
    const { results: keys } = await DB.prepare("SELECT user_id, label, created, last_used FROM passkeys").all();
    const { results: trips } = await DB.prepare("SELECT user_id, COUNT(*) AS n, MAX(updated) AS last FROM trips WHERE deleted = 0 GROUP BY user_id").all();
    const accounts = users.map(u => {
      const t = trips.find(x => x.user_id === u.id);
      return {
        id: u.id, created: u.created, plan: u.plan, trips: t?.n || 0, lastTrip: t?.last || null, here: here?.id === u.id,
        passkeys: keys.filter(k => k.user_id === u.id).map(k => ({ label: k.label, created: k.created, lastUsed: k.last_used })),
      };
    });
    // The one most recently used first.
    const used = a => a.passkeys.reduce((m, k) => (k.lastUsed || "") > m ? k.lastUsed : m, a.lastTrip || a.created);
    accounts.sort((a, b) => b.here - a.here || used(b).localeCompare(used(a)));
    return json({ accounts });
  },

  async "claim-sample"({ request, env, DB, body }) {
    const userId = String(body.userId || "");
    const user = await DB.prepare("SELECT id FROM users WHERE id = ?").bind(userId).first();
    if (!user) fail("No fishr Cloud account with that id.", 404);
    const now = new Date().toISOString();
    const rows = (await sampleTrips(request, env)).filter(s => s && ID_RE.test(String(s.id))).map(s => {
      const { sample, ...trip } = s;
      return { id: String(s.id), data: JSON.stringify({ ...trip, id: String(s.id) }) };
    });
    // Trips already in the account (or deleted from it) are left as they are.
    const have = new Set();
    for (let k = 0; k < rows.length; k += 90) {
      const part = rows.slice(k, k + 90);
      const { results } = await DB.prepare(`SELECT id FROM trips WHERE user_id = ? AND id IN (${part.map(() => "?").join(",")})`).bind(userId, ...part.map(r => r.id)).all();
      for (const r of results) have.add(r.id);
    }
    const add = rows.filter(r => !have.has(r.id));
    if (add.length) {
      // Same as a sync: one new seq for the whole set, so every device picks them all up together.
      await DB.batch([DB.prepare("UPDATE users SET seq = seq + 1 WHERE id = ?").bind(userId), ...add.map(r => DB.prepare(
        `INSERT INTO trips (user_id, id, data, updated, deleted, seq) VALUES (?, ?, ?, ?, 0, (SELECT seq FROM users WHERE id = ?))
         ON CONFLICT (user_id, id) DO NOTHING`).bind(userId, r.id, r.data, now, userId))]);
    }
    // The season's notes join the account's notes (settings are left alone). A later time than the stored one,
    // so phones take the new copy.
    const cur = await DB.prepare("SELECT data, updated FROM meta WHERE user_id = ?").bind(userId).first();
    let data = { notes: [], settings: {} }; try { if (cur) data = { notes: [], settings: {}, ...JSON.parse(cur.data) }; } catch (e) {}
    const newNotes = SAMPLE_NOTES.filter(n => !data.notes.includes(n));
    if (newNotes.length) {
      const updated = cur ? new Date(Math.max(Date.now(), Date.parse(cur.updated) + 1)).toISOString() : now;
      const out = JSON.stringify({ notes: [...data.notes, ...newNotes], settings: data.settings });
      await DB.prepare(cur ? "UPDATE meta SET data = ?, updated = ? WHERE user_id = ?" : "INSERT INTO meta (data, updated, user_id) VALUES (?, ?, ?)").bind(out, updated, userId).run();
    }
    const { n } = await DB.prepare("SELECT COUNT(*) AS n FROM trips WHERE user_id = ? AND deleted = 0").bind(userId).first();
    return json({ added: add.length, already: have.size, notes: newNotes.length, total: n });
  },
};
const METHOD = { accounts: "GET", "claim-sample": "POST" };

export async function onRequest({ request, env, params }) {
  return handle(async () => {
    const action = String(params.action || "");
    if (!Object.hasOwn(actions, action)) fail("Not found.", 404);
    if (request.method !== METHOD[action]) fail("Method not allowed.", 405);
    if (!isAdmin(request, env)) fail("Admin key needed.", 403);
    let body = {};
    if (request.method === "POST") {
      if (!isJson(request)) fail("Send JSON.", 415);
      body = await request.json().catch(() => null);
      if (!body || typeof body !== "object") fail("Send JSON.");
    }
    return actions[action]({ request, env, body, DB: await db(env) });
  });
}
