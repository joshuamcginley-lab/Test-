// Second bug sweep, app side: switching °F/°C updates the live card, leaving the sample refreshes it, low light
// after sunset scores as dawn/dusk, older trips with weather count, editing an old trip doesn't invent weather,
// "Temp later" is kept, and a first trip saved before the location arrives still gets its weather.
const { chromium, devices } = require('playwright'); const fs = require('fs');
const S = process.argv[2], URL0 = process.argv[3] || 'http://localhost:8790/'; const res = []; const ok = (c, m) => res.push((c ? 'PASS ' : 'FAIL ') + m);
const live = JSON.parse(fs.readFileSync(S + '/wx.json', 'utf8'));
const pad = n => String(n).padStart(2, '0'), fmt = d => `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}T${pad(d.getHours())}:${pad(d.getMinutes())}`;
const now = new Date(); now.setMinutes(0, 0, 0);
const by = now - new Date(live.hourly.time[48]), shift = s => fmt(new Date(new Date(s).getTime() + by));
live.hourly.time = live.hourly.time.map(shift); live.daily.sunrise = live.daily.sunrise.map(shift); live.daily.sunset = live.daily.sunset.map(shift);
live.current.temperature_2m = 17;
function tripWeather(url) {
  const u = new URL(url), a = u.searchParams.get('start_date'), b = u.searchParams.get('end_date'), time = [];
  for (let d = new Date(a + 'T00:00'); d <= new Date(b + 'T23:00'); d = new Date(+d + 36e5)) time.push(fmt(d));
  const n = time.length, fill = v => Array(n).fill(v);
  return JSON.stringify({ hourly: { time, temperature_2m: fill(30), weather_code: fill(0), pressure_msl: fill(1010), wind_speed_10m: fill(8), wind_direction_10m: fill(90), precipitation: fill(0) } });
}
const ownLog = JSON.parse(fs.readFileSync(S + '/enriched.json', 'utf8')).map(({ sample, ...s }) => s);

(async () => {
  const b = await chromium.launch(); const errs = [];
  async function open(settings = {}, log = ownLog, extra = {}) {
    const ctx = await b.newContext({ ...devices['iPhone 13'], locale: 'en-CA', geolocation: { latitude: 45.96, longitude: -66.64 }, permissions: ['geolocation'] });
    const p = await ctx.newPage(); p.on('pageerror', e => errs.push(e.message)); p.weatherCalls = [];
    await p.route(/open-meteo\.com\/v1\/(forecast|archive)/, r => { const u = r.request().url(); if (u.includes('start_date')) { p.weatherCalls.push(u); return r.fulfill({ contentType: 'application/json', body: tripWeather(u) }); } r.fulfill({ contentType: 'application/json', body: JSON.stringify(live) }); });
    await p.route(/\/api\/water/, r => r.fulfill({ status: 404, body: '{}' }));
    await p.goto(URL0);
    await p.evaluate(([log, settings, extra]) => { localStorage.clear(); localStorage.setItem('fishr.guide', '1'); localStorage.setItem('fishr.keepSafe', String(Date.now())); for (const [k, v] of Object.entries(extra)) localStorage.setItem(k, v);
      localStorage.setItem('firetiger.v1', JSON.stringify({ sessions: log, notes: [], settings: { temp: 'C', ...settings } })); }, [log, settings, extra]);
    await p.reload(); await p.waitForTimeout(700);
    return { p, ctx, click: sel => p.$eval(sel, e => e.click()) };
  }
  const air = p => p.evaluate(() => { const t = [...document.querySelectorAll('.live-rest .tile')].find(x => /Air/.test(x.querySelector('.label')?.textContent)); return t && t.querySelector('.big').textContent.replace(/\s+/g, ''); });

  // °C -> °F in Settings updates the live card straight away (the reported bug), and back.
  let { p, ctx, click } = await open();
  await p.evaluate(() => { showTab('advice'); goLive(true); }); await p.waitForTimeout(1500);
  ok(await air(p) === '17°C', 'air tile starts in °C ' + await air(p));
  await click('#openSettings'); await p.selectOption('#sTemp', 'F'); await p.waitForTimeout(300); await click('#closeSettings'); await p.waitForTimeout(300);
  ok(await air(p) === '63°F', 'switching to °F updates the live card without a resync: ' + await air(p));
  await click('#openSettings'); await p.selectOption('#sTemp', 'C'); await click('#closeSettings'); await p.waitForTimeout(300);
  ok(await air(p) === '17°C', 'and back to °C: ' + await air(p));

  // Leaving the sample from Settings: the live card drops its showcase banner straight away.
  await click('#openSettings'); await click('#settingsSample'); await p.waitForTimeout(1200);
  ok(await p.evaluate(() => /showcase call below/.test($('live').textContent)), 'sample: live card shows the showcase banner');
  await click('#openSettings');
  ok(await p.evaluate(() => $('settingsSample').closest('.set-group').hidden), 'Settings hides "Show the sample season" while in it');
  await click('#closeSettings');
  await p.evaluate(() => goLive(true)); await p.waitForTimeout(1500);
  ok(/Live weather updated\. The showcase call keeps its July evening\./.test(await p.evaluate(() => $('aWeatherMsg').textContent)), 'sample: a live resync leaves a clear message, not "Syncing…"');
  await click('#clearSample'); await p.waitForTimeout(800);
  ok(await p.evaluate(() => !/showcase call below/.test($('live').textContent) && !!document.querySelector('.drivers')), 'after Exit sample the live card is the angler\'s own again');

  // An hour and a half after sunset is low light (+6), not "After dark".
  const chips = await p.evaluate(() => { const keep = state.sessions; state.sessions = []; try { return biteIndex({ c: { temp: 17, press: 'Steady', dp3: 0, wind: 10, sky: 'Clear' }, light: { golden: false, dark: true, nearHrs: 1.5, midday: false }, flow: null, model: null, sp: null, recentTemp: null, front: null }).drivers.map(d => `${d.v} ${d.label}`); } finally { state.sessions = keep; } });
  ok(chips.some(c => /Near dawn or dusk/.test(c)) && !chips.some(c => /After dark/.test(c)), 'after sunset, within 3 hours: dawn/dusk light ' + JSON.stringify(chips));
  await ctx.close();

  // Older trips that got weather but no temperature now count.
  const old = ownLog.slice(0, 12).map((s, i) => i < 6 ? { ...s, tempLow: null, tempHigh: null } : s);
  ({ p, ctx, click } = await open({}, old));
  let r = await p.evaluate(() => state.sessions.filter(s => s.tempLow == null).length);
  ok(r === 0, 'trips with weather but no temperature get one from their weather (' + r + ' left without)');
  await ctx.close();

  // Editing an old trip that has no weather doesn't make some up from where you are now.
  const noWx = [{ id: 't-nw', date: '2026-09-01', water: 'Somewhere far', catches: [], method: 'Spin', updatedAt: '2026-09-02T00:00:00.000Z' }];
  ({ p, ctx, click } = await open({ home: { lat: 45.96, lon: -66.64 } }, noWx, { 'fishr.locAsked': '1' }));
  await p.evaluate(() => { showTab('log'); document.querySelector('.entry[data-id="t-nw"]').click(); }); await p.waitForTimeout(400);
  p.weatherCalls.length = 0;
  await click('#saveBtn'); await p.waitForTimeout(1500);
  r = await p.evaluate(() => state.sessions.find(s => s.id === 't-nw'));
  ok(!r.wx && r.tempLow == null && p.weatherCalls.length === 0, 'editing an old trip without weather leaves it alone ' + JSON.stringify({ wx: !!r.wx, t: r.tempLow, calls: p.weatherCalls.length }));

  // Only "Temp later" typed: it becomes the trip's temperature, not replaced by the weather lookup.
  await p.route(/open-meteo\.com\/v1\/(forecast|archive)/, rr => rr.abort());
  await p.evaluate(() => startNewTrip()); await p.waitForTimeout(800);
  await p.fill('#fWaterIn', 'Keswick River'); await p.evaluate(() => { $('moreDetails').open = true; }); await p.fill('#fThi', '15');
  await p.evaluate(() => { formCond.wx = { t: 30, sky: 'Sunny', at: '2026-10-10T12:00' }; });
  await click('#saveBtn'); await p.waitForTimeout(600);
  r = await p.evaluate(() => state.sessions.find(s => s.water === 'Keswick River'));
  ok(r.tempLow === 15 && r.tempHigh === 15, '"Temp later" 15 is kept, not replaced by the weather\'s 30: ' + JSON.stringify({ lo: r.tempLow, hi: r.tempHigh }));
  await ctx.close();

  // First trip saved before the location arrived: it gets its weather when the location does.
  ({ p, ctx, click } = await open({}, [{ id: 't-first', date: new Date().toISOString().slice(0, 10), water: 'Keswick River', catches: [], method: 'Spin', updatedAt: new Date().toISOString() }], { 'fishr.locAsked': '1' }));
  r = await p.evaluate(async () => ({ first: await fillTripLater('t-first'), home: !!state.settings.home }));
  ok(r.first === false && !r.home, 'no location yet: nothing to fill');
  await p.evaluate(() => askDevice()); await p.waitForTimeout(1500);
  r = await p.evaluate(() => ({ s: state.sessions[0], toast: $('toast').textContent }));
  ok(r.s.wx && r.s.tempLow === 30 && /Weather added/.test(r.toast), 'location arrives: the waiting trip gets its weather ' + JSON.stringify({ t: r.s.tempLow, toast: r.toast }));
  await ctx.close();

  ok(!errs.length, 'no page errors ' + errs.join(' | '));
  console.log(res.join('\n')); await b.close();
})().catch(e => { console.log(res.join('\n')); console.error('ERR', e.message.split('\n')[0]); process.exit(1); });
