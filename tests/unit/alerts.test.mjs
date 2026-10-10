// Bite alerts: web push encryption and signing (checked by decrypting like a phone would), the schedule and
// thresholds, and a full hourly run against made-up weather where Saturday evening is excellent.
import { d1 } from "../helpers/cfmock.mjs";
const F = new URL("../../functions/", import.meta.url).pathname;
const { sendPush, pushHostOk, b64u, unb64u } = await import(F + "_webpush.js");
const A = await import(F + "_alerts.js");
const push = await import(F + "api/push/[action].js");
let pass = 0, failN = 0; const ok = (c, m) => { if (c) pass++; else { failN++; console.log("FAIL:", m); } };
const enc = s => new TextEncoder().encode(s);

// ---- keys: fishr's push key (VAPID) and a "phone" (its subscription keys)
const vapid = await crypto.subtle.generateKey({ name: "ECDSA", namedCurve: "P-256" }, true, ["sign", "verify"]);
const VAPID_PUBLIC = b64u(await crypto.subtle.exportKey("raw", vapid.publicKey)), VAPID_PRIVATE = (await crypto.subtle.exportKey("jwk", vapid.privateKey)).d;
async function phone() {
  const k = await crypto.subtle.generateKey({ name: "ECDH", namedCurve: "P-256" }, true, ["deriveBits"]);
  return { k, p256dh: b64u(await crypto.subtle.exportKey("raw", k.publicKey)), auth: b64u(crypto.getRandomValues(new Uint8Array(16))) };
}
// What a browser does with a push: check the VAPID signature, then decrypt (RFC 8291).
async function receive(req, ph) {
  const authz = req.headers.authorization, [, jwt, k] = authz.match(/^vapid t=([^,]+), k=(.+)$/) || [];
  const [h, b, sig] = jwt.split(".");
  const pub = await crypto.subtle.importKey("raw", unb64u(k), { name: "ECDSA", namedCurve: "P-256" }, false, ["verify"]);
  const valid = await crypto.subtle.verify({ name: "ECDSA", hash: "SHA-256" }, pub, unb64u(sig), enc(`${h}.${b}`));
  const claims = JSON.parse(new TextDecoder().decode(unb64u(b)));
  const body = new Uint8Array(req.body), salt = body.slice(0, 16), rs = new DataView(body.buffer).getUint32(16), idlen = body[20], asPub = body.slice(21, 21 + idlen), ct = body.slice(21 + idlen);
  const asKey = await crypto.subtle.importKey("raw", asPub, { name: "ECDH", namedCurve: "P-256" }, false, []);
  const shared = new Uint8Array(await crypto.subtle.deriveBits({ name: "ECDH", public: asKey }, ph.k.privateKey, 256));
  const hk = async (salt, ikm, info, n) => new Uint8Array(await crypto.subtle.deriveBits({ name: "HKDF", hash: "SHA-256", salt, info }, await crypto.subtle.importKey("raw", ikm, "HKDF", false, ["deriveBits"]), n * 8));
  const cat = (...p) => { const o = new Uint8Array(p.reduce((a, x) => a + x.length, 0)); let i = 0; for (const x of p) { o.set(x, i); i += x.length; } return o; };
  const ikm = await hk(unb64u(ph.auth), shared, cat(enc("WebPush: info\0"), unb64u(ph.p256dh), asPub), 32);
  const cek = await hk(salt, ikm, enc("Content-Encoding: aes128gcm\0"), 16), nonce = await hk(salt, ikm, enc("Content-Encoding: nonce\0"), 12);
  const pt = new Uint8Array(await crypto.subtle.decrypt({ name: "AES-GCM", iv: nonce, tagLength: 128 }, await crypto.subtle.importKey("raw", cek, "AES-GCM", false, ["decrypt"]), ct));
  return { valid, claims, rs, k, payload: JSON.parse(new TextDecoder().decode(pt.slice(0, pt.lastIndexOf(2)))) };
}

// ---- fake network: push services and Open-Meteo
const pushed = []; let pushStatus = 201, weather = null, weatherCalls = 0;
globalThis.fetch = async (url, init = {}) => {
  const u = new URL(String(url));
  if (u.hostname === "api.open-meteo.com") { weatherCalls++; return new Response(JSON.stringify(weather(u)), { headers: { "content-type": "application/json" } }); }
  const headers = Object.fromEntries(Object.entries(init.headers || {}).map(([k, v]) => [k.toLowerCase(), v]));
  pushed.push({ url: String(url), headers, body: init.body });
  return new Response("", { status: pushStatus });
};

// 1. Encryption and signing, checked the way a phone checks them.
{
  const ph = await phone(), env = { VAPID_PUBLIC, VAPID_PRIVATE };
  const status = await sendPush(env, { endpoint: "https://fcm.googleapis.com/fcm/send/abc", p256dh: ph.p256dh, auth: ph.auth }, { title: "Hi", body: "Fish on" });
  const got = await receive(pushed.at(-1), ph);
  ok(status === 201 && got.valid, "VAPID signature verifies with fishr's public key");
  ok(got.claims.aud === "https://fcm.googleapis.com" && got.claims.exp > Date.now() / 1000 && /^https:\/\//.test(got.claims.sub), "VAPID claims: push service, expiry, contact " + JSON.stringify(got.claims));
  ok(got.payload.title === "Hi" && got.payload.body === "Fish on", "payload decrypts to the original message");
  ok(pushed.at(-1).headers["content-encoding"] === "aes128gcm" && pushed.at(-1).headers.ttl && got.rs === 4096 && got.k === VAPID_PUBLIC, "aes128gcm headers, record size, key id");
  const a = new Uint8Array(pushed.at(-1).body); await sendPush(env, { endpoint: "https://fcm.googleapis.com/fcm/send/abc", p256dh: ph.p256dh, auth: ph.auth }, { title: "Hi", body: "Fish on" });
  ok(Buffer.compare(Buffer.from(a), Buffer.from(new Uint8Array(pushed.at(-1).body))) !== 0, "every message is encrypted fresh");
}
// 2. Only real push services.
for (const [e, want] of [["https://fcm.googleapis.com/fcm/send/x", true], ["https://web.push.apple.com/abc", true], ["https://updates.push.services.mozilla.com/wpush/v2/x", true], ["https://wns2-by3p.notify.windows.com/w/?token=x", true],
  ["https://evil.example/collect", false], ["http://fcm.googleapis.com/x", false], ["https://fcm.googleapis.com.evil.example/x", false], ["https://169.254.169.254/latest", false], ["not a url", false]])
  ok(pushHostOk(e) === want, `push host ${want ? "allowed" : "refused"}: ${e}`);

// 3. Schedule.
const plan = (dow, h) => A.slotPlan(dow, h);
ok(JSON.stringify(plan(5, 18).weekend) === '[[1,"am"],[1,"pm"],[2,"am"]]', "Friday 6 pm: Saturday morning, Saturday evening, Sunday morning");
ok(JSON.stringify(plan(6, 8).weekend) === '[[0,"pm"],[1,"am"]]' && !plan(6, 8).weekly.length, "Saturday 8 am: Saturday evening, Sunday morning");
ok(JSON.stringify(plan(6, 18).weekend) === '[[1,"am"]]', "Saturday 6 pm: Sunday morning");
ok(plan(2, 18).weekend.length === 0 && plan(2, 18).weekly.length === 2, "weekday 6 pm: weekly check only");
ok(plan(5, 19) && plan(6, 9) && !plan(5, 20) && !plan(3, 8) && !plan(6, 12), "an hour's grace for a late timer; nothing at other times");
ok(A.localParts(Date.parse("2026-10-16T21:07:00Z"), "America/Moncton").hour === 18 && A.localParts(Date.parse("2026-10-17T01:07:00Z"), "America/Los_Angeles").hour === 18, "local time per subscriber's time zone");
const K = A.decideKeys(Date.parse("2026-10-18T15:00:00Z"), "America/Moncton");
ok(K.weekendKey === "2026-10-17" && K.weekKey === "2026-W42", "Sunday belongs to Saturday's weekend " + JSON.stringify(K));

// 4. Thresholds, with made-up windows: 56 past windows scoring 50–77, and candidates for this weekend.
{
  const now = Date.parse("2026-10-16T21:07:00Z"), tz = "America/Moncton", day = d => new Date(Date.parse("2026-10-16T12:00:00Z") + d * 864e5).toISOString().slice(0, 10);
  const past = []; for (let d = -28; d < 0; d++) for (const part of ["am", "pm"]) past.push({ date: day(d), part, sun: now + d * 864e5, score: 50 + ((d * 7 + (part === "am" ? 3 : 0)) % 28 + 28) % 28, drivers: [] });
  const sun = (d, part) => Date.parse(`${day(d)}T${part === "am" ? "09" : "22"}:30:00Z`);
  const win = (d, part, score) => ({ date: day(d), part, sun: sun(d, part), score, drivers: [{ v: 14, label: "Evening golden hour" }, { v: 9, label: "Falling pressure" }, { v: 5, label: "Cloud cover" }] });
  const sub = { tz, place: "Fredericton" };
  let r = A.decide(sub, [...past, win(1, "am", 80), win(1, "pm", 86), win(2, "am", 84)], now);
  ok(r.send?.kind === "weekend" && r.send.window.part === "pm" && r.send.window.date === day(1) && !r.send.alsoWeekly, "Friday: Saturday evening at 86 (top 10%, 85+) is sent; not good enough to use up the weekly one");
  ok(r.send.title === "Prime window: Saturday evening" && /^One of the best evenings near Fredericton in the past month\. Evening golden hour, falling pressure and cloud cover\. Sunset \d+:\d\d PM\.$/.test(r.send.body), "message: when, where, why, sunset time — " + r.send.body);
  r = A.decide(sub, [...past, win(1, "am", 84), win(1, "pm", 83), win(2, "am", 82)], now);
  ok(!r.send, "nothing at 85+: no alert");
  r = A.decide({ ...sub, weekend: "2026-10-17" }, [...past, win(1, "pm", 88)], now);
  ok(!r.send, "weekend alert already sent: none again");
  r = A.decide(sub, [...past, win(1, "pm", 93)], now);
  ok(r.send?.kind === "weekend" && r.send.alsoWeekly, "93: the weekend alert also counts as the week's best");
  const hot = past.map(w => ({ ...w, score: w.score + 15 })); // a hot month: 65–92
  r = A.decide(sub, [...hot, win(1, "pm", 88)], now);
  ok(!r.send, "88 isn't special after a month like this (not top 10%)");
  const tue = Date.parse("2026-10-13T21:07:00Z");
  r = A.decide(sub, [...past.map(w => ({ ...w, sun: w.sun - 3 * 864e5, date: new Date(Date.parse(w.date) - 3 * 864e5).toISOString().slice(0, 10) })), { ...win(-2, "am", 91), sun: tue + 12 * 36e5 }], tue);
  ok(r.send?.kind === "weekly" && r.send.title === "Best window this week: Wednesday morning", "weekday: tomorrow morning at 91 → weekly alert " + r.send?.title);
  r = A.decide({ ...sub, weekly: "2026-W42" }, [...past, win(1, "pm", 84)], now);
  ok(!r.send, "weekly already used and weekend below the bar: nothing");
}

// 5. A full run: subscribe, Friday 6 pm, made-up weather where Saturday evening is excellent.
const ph = await phone(), env = { DB: d1(), VAPID_PUBLIC, VAPID_PRIVATE, PUSH_CRON_KEY: "cron-secret", PUSH_TEST: "1", PUSH_TEST_HOST: "push.test", ADMIN_KEY: "adm" };
const call = (action, { body, method = "POST", headers = {}, q = "" } = {}) => push.onRequest({ env, params: { action }, request: new Request(`https://fishr.monster/api/push/${action}${q}`, { method, headers: { ...(body ? { "content-type": "application/json" } : {}), "cf-connecting-ip": "7.7.7.7", ...headers }, body: body ? JSON.stringify(body) : undefined }) });
const endpoint = "https://push.test/sub/1";
// Weather: 28 days back and 3 ahead, hourly, Moncton time (UTC-3). Sunrise 07:20, sunset 18:30 local. Ordinary days
// score in the 70s; Saturday 17 Oct afternoon/evening is 20°C, overcast, light wind, pressure falling fast.
weather = u => {
  const off = -3 * 3600, start = Date.parse("2026-09-18T03:00:00Z"), hours = 31 * 24, time = [], T = [], code = [], p = [], w = [];
  for (let i = 0; i < hours; i++) {
    const t = start + i * 36e5, sat = t >= Date.parse("2026-10-17T15:00:00Z") && t <= Date.parse("2026-10-17T23:00:00Z");
    time.push(t / 1000); T.push(sat ? 20 : 12); code.push(sat ? 3 : 0); w.push(10);
    p.push(sat ? 1015 - (t - Date.parse("2026-10-17T15:00:00Z")) / 36e5 * 1.2 : 1015);
  }
  const days = [...Array(31)].map((_, d) => Date.parse("2026-09-18T03:00:00Z") + d * 864e5);
  return { utc_offset_seconds: off, hourly: { time, temperature_2m: T, weather_code: code, pressure_msl: p, wind_speed_10m: w },
    daily: { time: days.map(x => x / 1000), sunrise: days.map(x => (x + 7.33 * 36e5) / 1000), sunset: days.map(x => (x + 18.5 * 36e5) / 1000) } };
};
let r = await call("key", { method: "GET" }); ok((await r.json()).key === VAPID_PUBLIC, "public key served");
r = await call("subscribe", { body: { endpoint: "https://evil.example/x", keys: { p256dh: ph.p256dh, auth: ph.auth }, lat: 45.96, lon: -66.64, tz: "America/Moncton" } });
ok(r.status === 400, "subscribe refuses a non-push address");
r = await call("subscribe", { body: { endpoint, keys: { p256dh: ph.p256dh, auth: ph.auth }, lat: 45.96, lon: -66.64, tz: "Mars/Olympus" } });
ok(r.status === 400, "subscribe refuses a bad time zone");
r = await call("subscribe", { body: { endpoint, keys: { p256dh: ph.p256dh, auth: ph.auth }, lat: 45.96123, lon: -66.64321, tz: "America/Moncton", place: "Fredericton<script>" } });
ok(r.status === 200, "subscribed");
const row = env.DB._sql.prepare("SELECT lat, lon, place FROM push_subs").get();
ok(row.lat === 45.96 && row.lon === -66.64 && row.place === "Frederictonscript", "location kept to ~1 km; place cleaned " + JSON.stringify(row));
r = await call("run", { q: "?now=2026-10-16T21:07:00Z" }); ok(r.status === 403, "run needs the timer's key");
pushed.length = 0; weatherCalls = 0;
r = await call("run", { headers: { "x-cron-key": "cron-secret" }, q: "?now=2026-10-16T21:07:00Z" });
let d = await r.json();
const got = pushed.length ? await receive(pushed[0], ph) : null;
ok(d.sent === 1 && got?.payload.title === "Prime window: Saturday evening", "Friday 6 pm: alert for Saturday evening " + JSON.stringify(d) + " " + got?.payload.title);
ok(/near Frederictonscript in the past month\. .*Sunset 6:30 PM\.$/.test(got?.payload.body || ""), "body names the place and sunset: " + got?.payload.body);
ok(got?.payload.url === "/?go=advice", "tapping opens the Guide");
pushed.length = 0;
r = await call("run", { headers: { "x-cron-key": "cron-secret" }, q: "?now=2026-10-16T21:40:00Z" }); d = await r.json();
ok(d.sent === 0 && pushed.length === 0, "a second call in the same hour sends nothing");
r = await call("run", { headers: { "x-cron-key": "cron-secret" }, q: "?now=2026-10-16T22:07:00Z" }); d = await r.json();
ok(d.sent === 0 && d.checked === 0, "the grace hour after doesn't re-check");
weatherCalls = 0;
r = await call("run", { headers: { "x-cron-key": "cron-secret" }, q: "?now=2026-10-17T11:07:00Z" }); d = await r.json();
ok(d.sent === 0 && weatherCalls === 0, "Saturday 8 am: weekend alert used and weekly used too, so no weather lookup " + JSON.stringify(d));
r = await call("run", { headers: { "x-cron-key": "cron-secret" }, q: "?now=2026-10-14T15:07:00Z" }); d = await r.json();
ok(d.checked === 0 && d.done, "Wednesday noon: nobody due");
// Admin: count and test send.
r = await call("stats", { method: "GET", headers: { "x-admin-key": "adm" } }); d = await r.json();
ok(d.subscribers === 1 && d.ready && d.cron, "admin stats " + JSON.stringify(d));
pushed.length = 0;
r = await call("test", { body: { endpoint }, headers: { "x-admin-key": "adm" } }); d = await r.json();
ok(d.status === 201 && (await receive(pushed[0], ph)).payload.title === "Test: bite alerts work", "admin test alert arrives");
r = await call("test", { body: { endpoint } }); ok(r.status === 403, "test needs the admin key");
pushed.length = 0;
r = await call("selftest", { body: { endpoint } }); d = await r.json();
ok(d.status === 201 && (await receive(pushed[0], ph)).payload.title === "Test: bite alerts work", "a device can send itself a test alert");
r = await call("selftest", { body: { endpoint: "https://push.test/sub/unknown" } }); ok(r.status === 404, "self-test only for a subscribed device");
for (let i = 0; i < 4; i++) await call("selftest", { body: { endpoint } });
r = await call("selftest", { body: { endpoint } }); ok(r.status === 429, "a few self-tests a day, then 429");
// The push service says the subscription is gone: it's removed.
pushStatus = 410;
env.DB._sql.prepare("UPDATE push_subs SET slot = NULL, weekend = NULL, weekly = NULL").run();
await call("run", { headers: { "x-cron-key": "cron-secret" }, q: "?now=2026-10-16T21:07:00Z" });
ok(env.DB._sql.prepare("SELECT COUNT(*) n FROM push_subs").get().n === 0, "an alert the push service says has no subscriber anymore: the subscription is deleted");
await call("subscribe", { body: { endpoint, keys: { p256dh: ph.p256dh, auth: ph.auth }, lat: 45.96, lon: -66.64, tz: "America/Moncton" } });
await call("test", { body: { endpoint }, headers: { "x-admin-key": "adm" } });
ok(env.DB._sql.prepare("SELECT COUNT(*) n FROM push_subs").get().n === 0, "same for a test alert");
pushStatus = 201;
// Unsubscribe.
await call("subscribe", { body: { endpoint, keys: { p256dh: ph.p256dh, auth: ph.auth }, lat: 45.96, lon: -66.64, tz: "America/Moncton" } });
await call("unsubscribe", { body: { endpoint } });
ok(env.DB._sql.prepare("SELECT COUNT(*) n FROM push_subs").get().n === 0, "turning alerts off deletes everything about the device");
// Odd action names.
r = await call("constructor", { body: {} }); ok(r.status === 404, "unknown action: 404");
console.log(`${pass} passed, ${failN} failed`);
