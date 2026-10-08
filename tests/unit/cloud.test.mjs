import { d1, r2, authenticator } from "../helpers/cfmock.mjs";
const F = new URL("../../functions/", import.meta.url).pathname;
const FIX = new URL("../fixtures/", import.meta.url).pathname;
const auth = await import(F + "api/auth/[action].js"), syncFn = await import(F + "api/sync.js"), photo = await import(F + "api/photo/[id].js"), account = await import(F + "api/account.js"), mw = await import(F + "_middleware.js");
const ORIGIN = "https://fishr.monster";
let pass = 0, failN = 0;
const ok = (c, m) => { if (c) pass++; else { failN++; console.log("FAIL:", m); } };

function client(env) {
  let jar = {};
  const call = async (fn, path, { method = "POST", body, params = {}, raw, type, origin = ORIGIN } = {}) => {
    const headers = { cookie: Object.entries(jar).map(([k, v]) => `${k}=${v}`).join("; ") };
    if (body !== undefined) headers["content-type"] = "application/json";
    if (type) headers["content-type"] = type;
    const request = new Request(origin + path, { method, headers, body: raw ?? (body !== undefined ? JSON.stringify(body) : undefined) });
    const res = await fn({ request, env, params, next: () => new Response("next") });
    for (const c of res.headers.getSetCookie?.() || []) { const [kv] = c.split(";"); const [k, v] = kv.split("="); if (v) jar[k] = v; else delete jar[k]; }
    const ct = res.headers.get("content-type") || "";
    return { status: res.status, data: ct.includes("json") ? await res.json() : await res.arrayBuffer(), res };
  };
  return {
    jar: () => jar, setJar: j => { jar = { ...j }; },
    auth: (action, o = {}) => call(auth.onRequest, `/api/auth/${action}`, { method: action === "me" ? "GET" : "POST", body: action === "me" ? undefined : (o.body || {}), params: { action }, origin: o.origin }),
    sync: body => call(syncFn.onRequestPost, "/api/sync", { body }),
    photo: (id, method, raw, type) => call(photo.onRequest, `/api/photo/${id}`, { method, raw, type, params: { id } }),
    del: () => call(account.onRequestDelete, "/api/account", { method: "DELETE", body: {} }),
  };
}
async function signUp(c, key, name = "Josh") {
  const o = await c.auth("register-options", { body: { name } });
  const cred = await key.create(o.data.publicKey, ORIGIN);
  return c.auth("register", { body: { challengeId: o.data.challengeId, ...cred, label: "iPhone · Safari" } });
}
async function signIn(c, key, extra = {}) {
  const o = await c.auth("login-options");
  const cred = await key.get(o.data.publicKey, extra.origin || ORIGIN);
  return c.auth("login", { body: { challengeId: o.data.challengeId, ...cred, ...extra.patch } });
}

const env = { DB: d1(), CATCHES: r2() };
// --- no DB
{ const c = client({}); const r = await c.auth("login-options"); ok(r.status === 503, "no DB -> 503 " + r.status); }

// --- registration + me
const A = client(env), keyA = await authenticator();
let r = await A.auth("me"); ok(r.status === 401, "me signed out 401");
r = await signUp(A, keyA); ok(r.status === 200 && r.data.user.id && r.data.user.cloud === true, "register " + JSON.stringify(r.data));
ok(A.jar().fishr_s && A.jar().fishr_in === "1", "cookies set");
ok(r.res.headers.getSetCookie().some(c => /fishr_s=.*HttpOnly.*SameSite=Lax.*Secure/.test(c)), "session cookie flags");
const uid = r.data.user.id;
r = await A.auth("me"); ok(r.status === 200 && r.data.user.passkeys.length === 1 && r.data.user.passkeys[0].label === "iPhone · Safari", "me " + JSON.stringify(r.data));
ok(keyA.userHandle === uid, "user handle is user id");

// replay same challenge
{ const o = await A.auth("register-options", { body: {} }); const k = await authenticator(); const cred = await k.create(o.data.publicKey, ORIGIN);
  r = await A.auth("register", { body: { challengeId: o.data.challengeId, ...cred } }); ok(r.status === 200 && r.data.user.passkeys.length === 2, "add 2nd passkey while signed in");
  ok(o.data.publicKey.excludeCredentials.length === 1 && o.data.publicKey.user.id === uid, "add options exclude + same user");
  r = await A.auth("register", { body: { challengeId: o.data.challengeId, ...cred } }); ok(r.status === 400, "challenge single use"); }
// wrong origin on create
{ const B = client(env), k = await authenticator(); const o = await B.auth("register-options", { body: {} }); const cred = await k.create(o.data.publicKey, "https://evil.example");
  r = await B.auth("register", { body: { challengeId: o.data.challengeId, ...cred } }); ok(r.status === 400 && /different site/.test(r.data.error), "bad origin rejected " + r.data.error); }
// wrong content type
{ const req = new Request(ORIGIN + "/api/auth/login-options", { method: "POST", body: "x", headers: { "content-type": "text/plain" } }); const res = await auth.onRequest({ request: req, env, params: { action: "login-options" } }); ok(res.status === 415, "non-json 415"); }

// --- login on another device (synced passkey)
const B = client(env);
r = await signIn(B, keyA); ok(r.status === 200 && r.data.user.id === uid, "login " + JSON.stringify(r.data));
r = await B.auth("me"); ok(r.status === 200, "B me");
// bad signature
{ const C = client(env); const o = await C.auth("login-options"); const cred = await keyA.get(o.data.publicKey, ORIGIN); const sig = Buffer.from(cred.signature, "base64url"); sig[10] ^= 1;
  r = await C.auth("login", { body: { challengeId: o.data.challengeId, ...cred, signature: sig.toString("base64url") } }); ok(r.status >= 400 && !C.jar().fishr_s, "tampered sig rejected " + r.status); }
// wrong origin login
{ const C = client(env); r = await signIn(C, keyA, { origin: "https://fishr.monster.evil.com" }); ok(r.status === 400, "login bad origin"); }
// unknown passkey
{ const C = client(env), k = await authenticator(); r = await signIn(C, k); ok(r.status === 404, "unknown passkey 404"); }
// RSA passkey + counter
{ const C = client(env), k = await authenticator({ rs: true, counter: 5 }); r = await signUp(C, k); ok(r.status === 200, "rsa register " + JSON.stringify(r.data));
  const D = client(env); r = await signIn(D, k); ok(r.status === 200, "rsa login (counter up)");
  const E = client(env); const o = await E.auth("login-options"); const cred = await k.get(o.data.publicKey, ORIGIN, { bump: false });
  r = await E.auth("login", { body: { challengeId: o.data.challengeId, ...cred } }); ok(r.status === 401, "counter replay rejected " + r.status); }

// --- sync
const t1 = { id: "t-1", date: "2026-06-01", water: "Keswick River", catches: [{ species: "Smallmouth Bass", count: 3, photo: "p-abc123-xy1" }], updatedAt: "2026-06-01T12:00:00.000Z" };
r = await A.sync({ since: 0, trips: [{ id: "t-1", data: t1, updated: t1.updatedAt }], meta: { data: { notes: ["n1"], settings: { name: "Josh" } }, updated: "2026-06-01T12:00:00.000Z" } });
ok(r.status === 200 && r.data.trips.length === 1 && r.data.cursor === 1 && r.data.meta.data.settings.name === "Josh", "A push " + JSON.stringify(r.data).slice(0, 200));
r = await B.sync({ since: 0, trips: [] }); ok(r.data.trips[0].data.water === "Keswick River" && r.data.cursor === 1, "B pulls");
const curB = r.data.cursor;
// B edits newer, A edits older (conflict) -> newest wins
r = await B.sync({ since: curB, trips: [{ id: "t-1", data: { ...t1, water: "Nashwaak" }, updated: "2026-06-02T00:00:00.000Z" }] });
r = await A.sync({ since: 1, trips: [{ id: "t-1", data: { ...t1, water: "Old edit" }, updated: "2026-06-01T13:00:00.000Z" }] });
ok(r.data.trips.length === 1 && r.data.trips[0].data.water === "Nashwaak", "LWW keeps newer " + JSON.stringify(r.data.trips));
// meta older doesn't overwrite
r = await A.sync({ since: r.data.cursor, trips: [], meta: { data: { notes: [], settings: {} }, updated: "2026-01-01T00:00:00.000Z" } });
ok(r.data.meta.data.notes[0] === "n1", "older meta ignored");
// delete
r = await A.sync({ since: r.data.cursor, trips: [{ id: "t-1", deleted: true, updated: "2026-06-03T00:00:00.000Z" }] });
r = await B.sync({ since: curB, trips: [] }); ok(r.data.trips.some(t => t.id === "t-1" && t.deleted), "B sees tombstone");
// future timestamp clamped
r = await A.sync({ since: 0, trips: [{ id: "t-2", data: { id: "t-2", date: "2026-06-04", water: "X" }, updated: "2099-01-01T00:00:00.000Z" }] });
ok(r.data.trips.find(t => t.id === "t-2").updated < "2030", "future clamped");
// validation
r = await A.sync({ since: 0, trips: [{ id: "bad id!", data: {}, updated: "2026-01-01T00:00:00Z" }, { id: "good-1", data: { date: "2026-01-02", water: "W" }, updated: "2026-01-02T00:00:00Z" }] });
ok(r.status === 200 && r.data.skipped.includes("bad id!") && r.data.trips.some(t => t.id === "good-1"), "bad trip skipped, the rest still syncs " + JSON.stringify(r.data.skipped));
r = await A.sync({ since: 0, trips: [{ id: "t-3", data: { x: "y".repeat(70000) }, updated: "2026-01-01T00:00:00Z" }] }); ok(r.status === 200 && r.data.skipped.includes("t-3"), "too-large trip skipped");
// a push that loses to a newer stored copy gets the winner back
await A.sync({ since: 0, trips: [{ id: "win-1", data: { date: "2026-01-03", water: "New" }, updated: "2026-05-01T00:00:00Z" }] });
r = await A.sync({ since: 999999, trips: [{ id: "win-1", data: { date: "2026-01-03", water: "Old" }, updated: "2026-04-01T00:00:00Z" }] });
ok(r.data.kept.length === 1 && r.data.kept[0].data.water === "New", "losing push gets the newer copy back " + JSON.stringify(r.data.kept));
// form-style content type is refused
{ const req = new Request(ORIGIN + "/api/sync", { method: "POST", headers: { "content-type": "text/plain; x=application/json", cookie: Object.entries(A.jar()).map(([k, v]) => `${k}=${v}`).join("; ") }, body: "{}" }); const res = await syncFn.onRequestPost({ request: req, env }); ok(res.status === 415, "text/plain disguised as JSON refused"); }
r = await A.sync({ since: 0, trips: Array.from({ length: 501 }, (_, i) => ({ id: "x" + i, deleted: true, updated: "2026-01-01T00:00:00Z" })) }); ok(r.status === 400, "too many 400");
// signed-out sync
{ const C = client(env); r = await C.sync({ since: 0 }); ok(r.status === 401, "sync signed out 401"); }
// pagination: 1200 trips in 3 pushes of 400
{ const P = client(env), k = await authenticator(); await signUp(P, k);
  for (let b = 0; b < 3; b++) await P.sync({ since: 0, trips: Array.from({ length: 400 }, (_, i) => ({ id: `p${b}-${i}`, data: { date: "2026-01-01", water: "W" }, updated: "2026-01-01T00:00:00.000Z" })) });
  let since = 0, got = 0, pages = 0, res; do { res = await P.sync({ since, trips: [] }); got += res.data.trips.length; since = res.data.cursor; pages++; } while (res.data.more && pages < 10);
  ok(got === 1200 && pages === 2, `pagination got ${got} in ${pages}`); }
// other user can't see A's trips
{ const P = client(env), k = await authenticator(); await signUp(P, k); r = await P.sync({ since: 0, trips: [] }); ok(r.data.trips.length === 0 && r.data.meta === null, "isolation"); }
// Pro gating
{ const env2 = { ...env, CLOUD_PRO_ONLY: "true" }, P = client(env2); P.setJar(A.jar()); r = await P.sync({ since: 0, trips: [] }); ok(r.status === 402, "pro only 402");
  r = await P.auth("me"); ok(r.data.user.cloud === false, "me says cloud false"); }

// --- photos
const img = new Uint8Array([255, 216, 255, 1, 2, 3]).buffer;
r = await A.photo("p-abc123-xy1", "PUT", img, "image/jpeg"); ok(r.status === 200, "photo put");
r = await B.photo("p-abc123-xy1", "GET"); ok(r.status === 200 && r.data.byteLength === 6 && r.res.headers.get("cache-control").startsWith("private"), "photo get by other device");
r = await A.photo("p-abc123-xy1", "PUT", img, "text/html"); ok(r.status === 415, "photo type check");
r = await A.photo("../../x", "GET"); ok(r.status === 404, "photo id check");
{ const C = client(env); r = await C.photo("p-abc123-xy1", "GET"); ok(r.status === 401, "photo signed out"); }
ok(env.CATCHES._m.has(`u/${uid}/p-abc123-xy1`), "photo key scoped");

// --- logout + delete account
r = await B.auth("logout"); ok(r.status === 200 && !B.jar().fishr_s, "logout clears cookie");
r = await B.sync({ since: 0 }); ok(r.status === 401, "logged out session dead");
r = await A.del(); ok(r.status === 200 && !A.jar().fishr_s, "account delete");
ok(![...env.CATCHES._m.keys()].some(k => k.includes(uid)), "photos deleted");
const left = env.DB._sql.prepare("SELECT (SELECT COUNT(*) FROM trips WHERE user_id=?) a, (SELECT COUNT(*) FROM passkeys WHERE user_id=?) b, (SELECT COUNT(*) FROM users WHERE id=?) c, (SELECT COUNT(*) FROM sessions WHERE user_id=?) d").get(uid, uid, uid, uid);
ok(left.a + left.b + left.c + left.d === 0, "rows deleted " + JSON.stringify(left));
{ const C = client(env); r = await signIn(C, keyA); ok(r.status === 404, "login after delete 404"); }

// --- middleware
const mwr = async (host, env) => mw.onRequest({ request: new Request(`https://${host}/c/abc?x=1`), env, next: () => new Response("next") });
r = await mwr("www.fishr.monster", { CANONICAL_HOST: "fishr.monster" }); ok(r.status === 301 && r.headers.get("location") === "https://fishr.monster/c/abc?x=1", "www redirect");
r = await mwr("firetiger-fishing-log.pages.dev", { CANONICAL_HOST: "fishr.monster" }); ok(r.status === 301, "old host redirect");
r = await mwr("abc.firetiger-fishing-log.pages.dev", { CANONICAL_HOST: "fishr.monster" }); ok(r.status === 200, "preview not redirected");
r = await mwr("www.fishr.monster", {}); ok(r.status === 200, "no redirect without var");

console.log(`${pass} passed, ${failN} failed`);
