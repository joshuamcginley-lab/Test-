// River gauges: Environment and Climate Change Canada in Canada, the U.S. Geological Survey in the US, the closer
// gauge wins near the border, and one service being down doesn't take the other with it. Fetch is faked.
const F = new URL("../../functions/", import.meta.url).pathname;
const { onRequestGet } = await import(F + "api/water.js");
let pass = 0, failN = 0; const ok = (c, m) => { if (c) pass++; else { failN++; console.log("FAIL:", m); } };

const HOUR = 3600e3, now = Date.now();
// 14 days of hourly readings, rising at the end so the latest is in the top 20%.
const hours = [...Array(14 * 24)].map((_, i) => now - (14 * 24 - i) * HOUR);
const valueAt = i => (i > 14 * 24 - 12 ? 900 + i : 400 + (i % 24));

// Fake services. `world` decides who has a gauge where.
let world;
const ecccFeature = (st, t, q) => ({ geometry: { coordinates: [st.lon, st.lat] }, properties: { STATION_NUMBER: st.id, STATION_NAME: st.name, DATETIME: new Date(t).toISOString(), DISCHARGE: q, LEVEL: 1.2 } });
const usgsTs = (st, code, pts, noData = -999999) => ({
  sourceInfo: { siteName: st.name, siteCode: [{ value: st.id }], geoLocation: { geogLocation: { latitude: st.lat, longitude: st.lon } } },
  variable: { variableCode: [{ value: code }], noDataValue: noData }, values: [{ value: pts.map(([t, v]) => ({ dateTime: new Date(t).toISOString(), value: String(v) })) }],
});
const inBox = (st, bbox) => { const [w, s, e, n] = bbox.split(",").map(Number); return st.lon >= w && st.lon <= e && st.lat >= s && st.lat <= n; };
globalThis.fetch = async url => {
  const u = new URL(String(url)), reply = (body, status = 200) => new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
  if (u.hostname === "api.weather.gc.ca") {
    if (world.ecccDown) return reply({}, 503);
    const id = u.searchParams.get("STATION_NUMBER"), bbox = u.searchParams.get("bbox");
    const sts = world.eccc.filter(st => id ? st.id === id : inBox(st, bbox));
    return reply({ features: sts.flatMap(st => id ? hours.map((t, i) => ecccFeature(st, t, valueAt(i))) : [ecccFeature(st, now - HOUR, 50)]) });
  }
  if (u.hostname === "waterservices.usgs.gov") {
    if (world.usgsDown) return reply({}, 500);
    const site = u.searchParams.get("sites"), bbox = u.searchParams.get("bBox");
    const sts = world.usgs.filter(st => site ? st.id === site : inBox(st, bbox));
    if (!sts.length) return new Response("No sites found matching all criteria", { status: 404 });
    return reply({ value: { timeSeries: sts.flatMap(st => st.dead ? [usgsTs(st, "00060", [[now - HOUR, -999999]])]
      : site ? [usgsTs(st, "00060", hours.map((t, i) => [t, valueAt(i)])), usgsTs(st, "00065", hours.map(t => [t, 3.4]))]
      : [usgsTs(st, "00060", [[now - HOUR, 1410]])]) } });
  }
  throw new Error("unexpected fetch " + url);
};
const ask = async (lat, lon) => { const r = await onRequestGet({ request: new Request(`https://fishr.monster/api/water?lat=${lat}&lon=${lon}`) }); return { status: r.status, d: await r.json() }; };

const POTOMAC = { id: "01646500", name: "POTOMAC RIVER NEAR WASH, DC LITTLE FALLS PUMP STA", lat: 38.9498, lon: -77.1276 };
const GALLATIN = { id: "06048650", name: "E GALLATIN R AB WATER RECLAMATION FA NR BOZEMAN MT", lat: 45.70, lon: -111.06 };
const DEAD = { id: "01646000", name: "DIFFICULT RUN NEAR GREAT FALLS, VA", lat: 38.951, lon: -77.128, dead: true };
const SJR = { id: "01AK003", name: "SAINT JOHN RIVER AT FREDERICTON", lat: 45.96, lon: -66.64 };
const DETROIT_US = { id: "04165710", name: "DETROIT RIVER AT FORT WAYNE AT DETROIT, MI", lat: 42.30, lon: -83.09 };
const DETROIT_CA = { id: "02GH003", name: "DETROIT RIVER AT WINDSOR", lat: 42.33, lon: -83.03 };

// US: a USGS gauge, in US units, with a readable name; a gauge with no readings is skipped.
world = { eccc: [], usgs: [DEAD, POTOMAC] };
let r = await ask(38.95, -77.12);
ok(r.status === 200 && r.d.source === "USGS" && r.d.station.id === "01646500", "US spot gets the USGS gauge " + JSON.stringify(r.d.station || r.d));
ok(r.d.station?.name === "Potomac River near Wash, DC Little Falls Pump Station", "USGS name is readable: " + r.d.station?.name);
ok(r.d.unit === "ft³/s" && r.d.measure === "discharge" && r.d.status === "High" && r.d.trend === "rising" && r.d.days === 14 && r.d.series.length > 70, "flow rated against 14 days " + JSON.stringify({ u: r.d.unit, s: r.d.status, t: r.d.trend, d: r.d.days }));
world = { eccc: [], usgs: [GALLATIN] };
r = await ask(45.68, -111.04);
ok(r.d.station?.name === "East Gallatin River above Water Reclamation Fa near Bozeman, MT", "abbreviations expanded: " + r.d.station?.name);

// Canada: unchanged, Environment Canada in metric.
world = { eccc: [SJR], usgs: [] };
r = await ask(45.96, -66.64);
ok(r.status === 200 && r.d.source === "ECCC" && r.d.station.name === "Saint John River at Fredericton" && r.d.unit === "m³/s", "Canada still uses Environment Canada " + JSON.stringify(r.d.station || r.d));

// Border: whichever gauge is closer.
world = { eccc: [DETROIT_CA], usgs: [DETROIT_US] };
r = await ask(42.331, -83.031);
ok(r.d.source === "ECCC" && r.d.station.id === "02GH003", "Windsor side picks the Canadian gauge");
r = await ask(42.30, -83.09);
ok(r.d.source === "USGS" && r.d.station.id === "04165710", "Detroit side picks the US gauge");

// One service down: the other still answers. Both down: an error, not a crash. Nothing nearby: 404.
world = { eccc: [SJR], usgs: [POTOMAC], usgsDown: true };
r = await ask(45.96, -66.64);
ok(r.status === 200 && r.d.source === "ECCC", "USGS down: Canadian spot still works");
world = { eccc: [], usgs: [POTOMAC], ecccDown: true };
r = await ask(38.95, -77.12);
ok(r.status === 200 && r.d.source === "USGS", "Environment Canada down: US spot still works");
world = { eccc: [], usgs: [], ecccDown: true, usgsDown: true };
r = await ask(38.95, -77.12);
ok(r.status === 502 && /Couldn't reach/.test(r.d.error), "both down: 502");
world = { eccc: [], usgs: [] };
r = await ask(40, -40);
ok(r.status === 404 && /No real-time river gauge/.test(r.d.error), "middle of the ocean: 404");
r = await ask("x", 1);
ok(r.status === 400, "bad coordinates: 400");

console.log(`${pass} passed, ${failN} failed`);
