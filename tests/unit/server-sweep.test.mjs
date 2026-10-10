// Second bug sweep, server side: every Functions file loads, odd action names are a clean 404, sign-ups and the
// waitlist are rate limited, photo uploads stop reading at the size cap and have a daily cap, and one account
// can't fill the database.
import fs from "node:fs";
import path from "node:path";
import { d1, r2, authenticator } from "../helpers/cfmock.mjs";
const F = new URL("../../functions/", import.meta.url).pathname;
const ORIGIN = "https://fishr.monster";
let pass = 0, failN = 0; const ok = (c, m) => { if (c) pass++; else { failN++; console.log("FAIL:", m); } };

// Every Functions module parses and loads (a syntax error in one would take its route down).
const walk = d => fs.readdirSync(d, { withFileTypes: true }).flatMap(e => e.isDirectory() ? (e.name === "_vendor" ? [] : walk(path.join(d, e.name))) : e.name.endsWith(".js") ? [path.join(d, e.name)] : []);
for (const f of walk(F)) { try { await import(f); ok(true, f); } catch (e) { ok(false, `${path.relative(F, f)} doesn't load: ${e.message}`); } }

const auth = await import(F + "api/auth/[action].js"), photo = await import(F + "api/photo/[id].js"), syncFn = await import(F + "api/sync.js"), wl = await import(F + "api/waitlist.js");
function client(env, ip) {
  let jar = {};
  const call = async (fn, p, { method = "POST", body, params = {}, raw, type, headers: extra = {} } = {}) => {
    const headers = { cookie: Object.entries(jar).map(([k, v]) => `${k}=${v}`).join("; "), "cf-connecting-ip": ip, ...extra };
    if (body !== undefined) headers["content-type"] = "application/json";
    if (type) headers["content-type"] = type;
    const res = await fn({ request: new Request(ORIGIN + p, { method, headers, body: raw ?? (body !== undefined ? JSON.stringify(body) : undefined), duplex: "half" }), env, params });
    for (const c of res.headers.getSetCookie?.() || []) { const [kv] = c.split(";"); const [k, v] = kv.split("="); if (v) jar[k] = v; else delete jar[k]; }
    return { status: res.status, data: (res.headers.get("content-type") || "").includes("json") ? await res.json() : null };
  };
  return {
    auth: (action, body = {}) => call(auth.onRequest, `/api/auth/${action}`, { method: action === "me" ? "GET" : "POST", body: action === "me" ? undefined : body, params: { action } }),
    photo: (id, raw, type = "image/jpeg") => call(photo.onRequest, `/api/photo/${id}`, { method: "PUT", raw, type, params: { id } }),
    sync: body => call(syncFn.onRequestPost, "/api/sync", { body }),
    waitlist: (body, type) => call(wl.onRequestPost, "/api/waitlist", type ? { raw: JSON.stringify(body), type } : { body }),
  };
}
async function signUp(c) {
  const key = await authenticator(), o = await c.auth("register-options", { name: "Test" });
  if (o.status !== 200) return o;
  return c.auth("register", { challengeId: o.data.challengeId, ...(await key.create(o.data.publicKey, ORIGIN)) });
}
const env = { DB: d1(), CATCHES: r2() };

// Action names that exist on every object are not actions.
for (const a of ["constructor", "__proto__", "toString", "hasOwnProperty"]) {
  const r = await client(env, "1.1.1.1").auth(a, { x: 1 });
  ok(r.status === 404, `POST /api/auth/${a}: 404, not a crash (${r.status})`);
}

// New accounts: five per visitor per day.
{
  const results = []; for (let i = 0; i < 6; i++) results.push((await signUp(client(env, "2.2.2.2"))).status);
  ok(results.slice(0, 5).every(s => s === 200) && results[5] === 429, "6th new account from one visitor in a day: 429 " + results);
  ok((await signUp(client(env, "3.3.3.3"))).status === 200, "another visitor can still sign up");
}

// Photos: the body stops being read at the cap even with no size header; 200 new photos per account per day.
const P = client(env, "4.4.4.4"); await signUp(P);
{
  let pulled = 0; const chunk = new Uint8Array(1024 * 1024);
  const body = new ReadableStream({ pull(ctrl) { pulled++; if (pulled > 50) ctrl.close(); else ctrl.enqueue(chunk); } });
  const r = await P.photo("p-big-1", body);
  ok(r.status === 413 && pulled <= 9, `oversized streamed photo: 413 after reading ${pulled} MB, not 50`);
  const img = new Uint8Array([255, 216, 255, 0, 1, 2]);
  let last; for (let i = 0; i < 201; i++) last = await P.photo(`p-q-${i}`, img);
  ok(last.status === 429, "201st photo in a day: 429 " + last.status);
  ok((await client(env, "4.4.4.4").photo("p-x-1", img)).status === 401, "uploads still need a session");
}

// Sync: an account holds at most about 20 MB of trips; replacing trips doesn't count them twice.
{
  const S = client(env, "5.5.5.5"); await signUp(S);
  const big = (i, tag) => ({ id: `t-${i}`, updated: new Date(Date.now() - 1000 + (tag === "b" ? 500 : 0)).toISOString(), data: { id: `t-${i}`, date: "2026-07-01", water: "W", notes: tag + "x".repeat(60 * 1024) } });
  let r = await S.sync({ since: 0, trips: [...Array(345)].map((_, i) => big(i, "a")) });
  ok(r.status === 413 && /more data than fishr Cloud holds/.test(r.data.error), "pushing ~21 MB: 413 " + r.status);
  r = await S.sync({ since: 0, trips: [...Array(300)].map((_, i) => big(i, "a")) });
  ok(r.status === 200, "~18.5 MB fits " + r.status);
  r = await S.sync({ since: 0, trips: [...Array(300)].map((_, i) => big(i, "b")) });
  ok(r.status === 200, "editing all of those trips again is not counted twice " + r.status);
  r = await S.sync({ since: 0, trips: [...Array(50)].map((_, i) => big(1000 + i, "a")) });
  ok(r.status === 413, "but new trips on top of a full account are refused " + r.status);
}

// Waitlist: JSON only, five per visitor per day.
{
  const W = client(env, "6.6.6.6");
  let r = await W.waitlist({ email: "a@b.co", consent: true }, "text/plain");
  ok(r.status === 415, "waitlist from a plain form: 415 " + r.status);
  const s = []; for (let i = 0; i < 6; i++) s.push((await W.waitlist({ email: `p${i}@b.co`, consent: true })).status);
  ok(s.slice(0, 5).every(x => x === 200) && s[5] === 429, "6th waitlist sign-up from one visitor: 429 " + s);
}

// HSTS on every HTTPS answer, including the www redirect; never on plain http (local development).
{
  const mw = await import(F + "_middleware.js");
  const env = { CANONICAL_HOST: "fishr.monster" }, next = async () => new Response("ok", { headers: { "content-type": "text/plain" } });
  let r = await mw.onRequest({ request: new Request("https://fishr.monster/"), env, next });
  ok(r.status === 200 && r.headers.get("strict-transport-security") === "max-age=15552000" && await r.text() === "ok", "HSTS on pages");
  r = await mw.onRequest({ request: new Request("https://www.fishr.monster/c/abc?x=1"), env, next });
  ok(r.status === 301 && r.headers.get("location") === "https://fishr.monster/c/abc?x=1" && r.headers.get("strict-transport-security"), "www redirect keeps the path and has HSTS");
  r = await mw.onRequest({ request: new Request("http://localhost:8790/"), env: {}, next });
  ok(!r.headers.get("strict-transport-security"), "no HSTS on plain http");
}

console.log(`${pass} passed, ${failN} failed`);
