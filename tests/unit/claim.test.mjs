// Admin: list fishr Cloud accounts, and move the showcase season into one of them as that angler's own trips.
import fs from "node:fs";
import { d1, r2, authenticator } from "../helpers/cfmock.mjs";
const F = new URL("../../functions/", import.meta.url).pathname, ROOT = new URL("../../", import.meta.url).pathname;
const auth = await import(F + "api/auth/[action].js"), syncFn = await import(F + "api/sync.js"), admin = await import(F + "api/admin/[action].js");
const ORIGIN = "https://fishr.monster";
let pass = 0, failN = 0;
const ok = (c, m) => { if (c) pass++; else { failN++; console.log("FAIL:", m); } };

const sample = JSON.parse(fs.readFileSync(ROOT + "sample.json", "utf8"));
const env = { DB: d1(), CATCHES: r2(), ADMIN_KEY: "adm", ASSETS: { fetch: async u => new Response(fs.readFileSync(ROOT + new URL(u).pathname)) } };

function client() {
  let jar = {};
  const call = async (fn, path, { method = "POST", body, params = {}, headers = {} } = {}) => {
    const h = { cookie: Object.entries(jar).map(([k, v]) => `${k}=${v}`).join("; "), ...headers };
    if (body !== undefined) h["content-type"] = "application/json";
    const res = await fn({ request: new Request(ORIGIN + path, { method, headers: h, body: body !== undefined ? JSON.stringify(body) : undefined }), env, params });
    for (const c of res.headers.getSetCookie?.() || []) { const [kv] = c.split(";"); const [k, v] = kv.split("="); if (v) jar[k] = v; else delete jar[k]; }
    return { status: res.status, data: await res.json() };
  };
  return {
    auth: (action, body) => call(auth.onRequest, `/api/auth/${action}`, { body: body || {}, params: { action } }),
    sync: body => call(syncFn.onRequestPost, "/api/sync", { body }),
    admin: (action, { body, key = "adm", method } = {}) => call(admin.onRequest, `/api/admin/${action}`, { method: method || (body ? "POST" : "GET"), body, params: { action }, headers: key ? { "x-admin-key": key } : {} }),
  };
}
async function signUp(c, label) {
  const key = await authenticator(), o = await c.auth("register-options", { name: "x" });
  const r = await c.auth("register", { challengeId: o.data.challengeId, ...(await key.create(o.data.publicKey, ORIGIN)), label });
  return r.data.user.id;
}

const josh = client(), other = client();
const joshId = await signUp(josh, "iPhone · Safari"), otherId = await signUp(other, "Pixel · Chrome");
// Josh already has a trip and a note of his own, and has synced once.
let s = await josh.sync({ since: 0, trips: [{ id: "t-own", data: { date: "2026-10-01", water: "Keswick River", catches: [] }, updated: "2026-10-01T12:00:00Z" }], meta: { data: { notes: ["My own note"], settings: { temp: "C" } }, updated: "2026-10-01T12:00:00Z", base: "" } });
const cursor = s.data.cursor;
ok(s.status === 200 && cursor > 0, "Josh synced one trip of his own");

// Admin key needed for both.
let r = await josh.admin("accounts", { key: "" }); ok(r.status === 403, "accounts: admin key needed");
r = await josh.admin("claim-sample", { body: { userId: joshId }, key: "wrong" }); ok(r.status === 403, "claim: admin key needed");
r = await josh.admin("claim-sample", { method: "GET" }); ok(r.status === 405, "claim: POST only");
r = await josh.admin("nope"); ok(r.status === 404, "unknown action: 404");

// The account list: who's who, with the account signed in on this browser first.
r = await other.admin("accounts");
ok(r.status === 200 && r.data.accounts.length === 2 && r.data.accounts[0].id === otherId && r.data.accounts[0].here, "accounts: the one signed in here comes first " + JSON.stringify(r.data.accounts.map(a => a.id)));
r = await josh.admin("accounts"); const a = r.data.accounts[0];
ok(a.id === joshId && a.here && a.trips === 1 && a.passkeys.length === 1 && a.passkeys[0].label === "iPhone · Safari" && a.passkeys[0].lastUsed, "accounts: passkey name, trip count " + JSON.stringify(a));

// Move the showcase into Josh's account.
r = await josh.admin("claim-sample", { body: { userId: "nobody" } }); ok(r.status === 404, "claim: unknown account 404");
r = await josh.admin("claim-sample", { body: { userId: joshId } });
ok(r.status === 200 && r.data.added === sample.length && r.data.already === 0 && r.data.notes === 6 && r.data.total === sample.length + 1, "claim: every showcase trip added " + JSON.stringify(r.data));

// His phone picks them up on its next sync, as ordinary trips (not marked as the sample), with the notes.
s = await josh.sync({ since: cursor, trips: [] });
const got = s.data.trips;
ok(got.length === sample.length && got.every(t => !t.data.sample && t.data.id === t.id) && got.some(t => t.id === sample[0].id && t.data.water === sample[0].water), "his phone gets all " + sample.length + " trips as his own");
ok(s.data.meta.data.notes[0] === "My own note" && s.data.meta.data.notes.length === 7 && s.data.meta.data.settings.temp === "C" && s.data.meta.updated > "2026-10-01T12:00:00Z", "notes added after his own, settings untouched " + JSON.stringify(s.data.meta));
// Uses the weather-enriched copy when the server has made it.
await env.CATCHES.put("sample/enriched-v1.json", JSON.stringify(sample.map(t => ({ ...t, sample: true, wx: { t: 20, source: "historical" } }))));
const fresh = client(), freshId = await signUp(fresh, "iPad");
r = await fresh.admin("claim-sample", { body: { userId: freshId } });
s = await fresh.sync({ since: 0, trips: [] });
ok(r.data.added === sample.length && s.data.trips.every(t => t.data.wx?.source === "historical" && !t.data.sample) && s.data.meta.data.notes.length === 6, "uses the copy with historical weather; a new account gets just the season's notes");

// Again: nothing doubles up, and a trip he deleted stays deleted.
await josh.sync({ since: 0, trips: [{ id: sample[1].id, deleted: true, updated: new Date().toISOString() }] });
r = await josh.admin("claim-sample", { body: { userId: joshId } });
ok(r.status === 200 && r.data.added === 0 && r.data.already === sample.length && r.data.notes === 0 && r.data.total === sample.length, "run twice: nothing added, deleted trip not brought back " + JSON.stringify(r.data));
// Nobody else's account is touched.
r = await other.admin("accounts"); ok(r.data.accounts.find(x => x.id === otherId).trips === 0, "other accounts untouched");

// The server's copy of the showcase notes matches the app's.
const app = fs.readFileSync(ROOT + "app.js", "utf8"), m = app.match(/const SAMPLE_NOTES = (\[[\s\S]*?\]);/);
ok(m && JSON.stringify(eval(m[1])) === JSON.stringify(admin.SAMPLE_NOTES), "SAMPLE_NOTES match app.js");

console.log(`${pass} passed, ${failN} failed`);
if (failN) process.exit(1);
