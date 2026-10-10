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

console.log(`${pass} passed, ${failN} failed`);
if (failN) process.exit(1);
