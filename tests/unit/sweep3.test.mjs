// Regressions from the third bug sweep: the Guide's ranking, trips past midnight, and river gauge readings.
await import("../../bite-core.js");
const C = globalThis.BiteCore;
let pass = 0, failN = 0;
const ok = (c, m) => { if (c) pass++; else { failN++; console.log("FAIL:", m); } };

// The Guide never names a water that skunked every time over one that keeps producing, even when one big day on a
// water fished once lifts the angler's average.
const T = (id, water, n, start = "18:00", end = "20:00") => ({ id, date: "2026-09-20", water, spot: water + " spot", start, end, tempLow: 18, catches: n ? [{ species: "Smallmouth bass", count: n, lure: "Jig" }] : [] });
const log = [T("c", "Hot Pond", 30), T("a1", "Skunk Lake", 0), T("a2", "Skunk Lake", 0), ...[1, 2, 3, 4].map(i => T("b" + i, "Good River", 1))];
const q = { temp: 18, hour: 19, doy: C.dayOfYear("2026-10-17"), sky: null, press: null, flow: null };
const call = C.bestCall(log, q);
ok(call.water === "Good River", "Guide picks the water that produces, not the one that always skunked: " + call.water);

// A trip from 10 pm to 2 am is a night trip, not a midday one.
ok(C.tripHour({ start: "22:00", end: "02:00" }) === 0 && C.lightOf(C.tripHour({ start: "22:00", end: "02:00" })) === "dark", "22:00–02:00 is centred at midnight " + C.tripHour({ start: "22:00", end: "02:00" }));
ok(C.tripHour({ start: "23:30", end: "00:30" }) === 0 && C.tripHour({ start: "18:00", end: "20:00" }) === 19, "other trips unchanged");
const night = [1, 2, 3, 4].map(i => T("n" + i, "Night Lake", 5, "22:00", "02:00"));
ok(C.similarity(night[0], { ...q, hour: 23.5 }) > 0.5, "a night trip matches a late-night question");

// River gauges: a flat river reads Normal, and a reading tied with the 14-day high still reads High.
const { onRequestGet } = await import("../../functions/api/water.js");
const HOUR = 3600e3, now = Date.now(), hours = [...Array(14 * 24)].map((_, i) => now - (14 * 24 - i) * HOUR);
let series;
globalThis.fetch = async url => {
  const u = new URL(String(url)), reply = b => new Response(JSON.stringify(b), { status: 200, headers: { "content-type": "application/json" } });
  if (u.hostname !== "api.weather.gc.ca") return new Response("none", { status: 404 });
  const f = (t, q) => ({ geometry: { coordinates: [-66.6, 46] }, properties: { STATION_NUMBER: "01AB002", STATION_NAME: "TEST RIVER AT TOWN", DATETIME: new Date(t).toISOString(), DISCHARGE: q, LEVEL: null } });
  return reply({ features: u.searchParams.get("STATION_NUMBER") ? hours.map((t, i) => f(t, series(i))) : [f(now - HOUR, 50)] });
};
const gauge = async fn => { series = fn; return (await onRequestGet({ request: new Request("https://x/api/water?lat=46.0&lon=-66.6"), env: {} })).json(); };
let g = await gauge(() => 50);
ok(g.status === "Normal" && g.pct14 === 0.5, "flat river: Normal " + JSON.stringify({ s: g.status, p: g.pct14 }));
g = await gauge(i => (i < 235 ? 40 : 50));
ok(g.status === "High", "at the 14-day high (tied with 30% of readings): High " + JSON.stringify({ s: g.status, p: g.pct14 }));

// Server: the size cap counts only trips a push will really write; a deleted account's alert device is unlinked;
// unreadable passkey data is a 400.
{
  const { d1, r2, authenticator } = await import("../helpers/cfmock.mjs");
  const auth = await import("../../functions/api/auth/[action].js"), syncFn = await import("../../functions/api/sync.js"), account = await import("../../functions/api/account.js"), push = await import("../../functions/api/push/[action].js");
  const env = { DB: d1(), CATCHES: r2(), VAPID_PUBLIC: "x", VAPID_PRIVATE: "y" }, ORIGIN = "https://fishr.monster";
  let jar = {};
  const call = async (fn, path, { method = "POST", body, params = {} } = {}) => {
    const h = { cookie: Object.entries(jar).map(([k, v]) => `${k}=${v}`).join("; "), "cf-connecting-ip": "5.5.5.5" }; if (body !== undefined) h["content-type"] = "application/json";
    const res = await fn({ request: new Request(ORIGIN + path, { method, headers: h, body: body !== undefined ? JSON.stringify(body) : undefined }), env, params });
    for (const c of res.headers.getSetCookie?.() || []) { const [kv] = c.split(";"); const [k, v] = kv.split("="); if (v) jar[k] = v; else delete jar[k]; }
    return { status: res.status, data: await res.json().catch(() => null) };
  };
  const key = await authenticator(), o = await call(auth.onRequest, "/api/auth/register-options", { body: { name: "x" }, params: { action: "register-options" } });
  let r = await call(auth.onRequest, "/api/auth/register", { body: { challengeId: o.data.challengeId, ...(await key.create(o.data.publicKey, ORIGIN)), clientDataJSON: "%%%" }, params: { action: "register" } });
  ok(r.status === 400 && /readable/.test(r.data.error), "unreadable passkey data: 400, not 500 " + r.status);
  const o2 = await call(auth.onRequest, "/api/auth/register-options", { body: { name: "x" }, params: { action: "register-options" } });
  r = await call(auth.onRequest, "/api/auth/register", { body: { challengeId: o2.data.challengeId, ...(await key.create(o2.data.publicKey, ORIGIN)) }, params: { action: "register" } });
  const uid = r.data.user.id;
  // Fill close to the 20 MB cap, then try to make room with old-timestamped copies that lose last-write-wins.
  const big = "x".repeat(60000), fut = new Date(Date.now() + 864e5 / 2).toISOString();
  for (let k = 0; k < 330; k += 110) await call(syncFn.onRequestPost, "/api/sync", { body: { since: 0, trips: Array.from({ length: 110 }, (_, i) => ({ id: `b-${k + i}`, data: { date: "2026-06-01", water: "W", notes: big }, updated: fut })) } });
  r = await call(syncFn.onRequestPost, "/api/sync", { body: { since: 0, trips: [...Array.from({ length: 100 }, (_, i) => ({ id: `b-${i}`, deleted: true, updated: "2000-01-01T00:00:00Z" })), ...Array.from({ length: 100 }, (_, i) => ({ id: `n-${i}`, data: { date: "2026-06-01", water: "W", notes: big }, updated: fut }))] } });
  ok(r.status === 413, "losing old copies can't make room past the size cap " + r.status);
  // Alert device signed in to the account, then the account is deleted: the device row no longer names it.
  await call(push.onRequest, "/api/push/subscribe", { body: { endpoint: "https://fcm.googleapis.com/fcm/send/z", keys: { p256dh: "BN" + "A".repeat(85), auth: "A".repeat(22) }, lat: 45.9, lon: -66.6, tz: "America/Moncton" }, params: { action: "subscribe" } });
  const before = env.DB._sql.prepare("SELECT user_id FROM push_subs").all();
  await call(account.onRequestDelete, "/api/account", { method: "DELETE", body: {} });
  const after = env.DB._sql.prepare("SELECT user_id FROM push_subs").all();
  ok(before.length === 1 && before[0].user_id === uid && after.length === 1 && after[0].user_id === null, "deleting the account unlinks its alert device " + JSON.stringify({ before, after }));
}

console.log(`${pass} passed, ${failN} failed`);
if (failN) process.exit(1);
