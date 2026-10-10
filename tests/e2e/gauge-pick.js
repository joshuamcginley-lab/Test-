// River gauge: closest by default, "Change" to pick another; the pick sticks for that area, applies to new trips,
// falls back to the closest when the picked gauge goes quiet, and "Closest (automatic)" undoes it.
const { chromium, devices } = require('playwright'); const fs = require('fs');
const S = process.argv[2], URL0 = process.argv[3] || 'http://localhost:8790/'; const res = []; const ok = (c, m) => res.push((c ? 'PASS ' : 'FAIL ') + m);
const live = fs.readFileSync(S + '/wx.json', 'utf8');
const ownLog = JSON.parse(fs.readFileSync(S + '/enriched.json', 'utf8')).map(({ sample, ...s }) => s);

const GAUGES = [
  { source: 'ECCC', id: '01AK003', name: 'Saint John River at Fredericton', distKm: 1 },
  { source: 'ECCC', id: '01AL002', name: 'Nashwaak River at Durham Bridge', distKm: 19 },
  { source: 'ECCC', id: '01AM001', name: 'North Branch Oromocto River at Tracy', distKm: 32 },
];
const reading = (g, picked) => ({ source: g.source, station: { id: g.id, name: g.name, distKm: g.distKm }, time: new Date().toISOString(), measure: 'discharge', unit: 'm³/s',
  value: 42.5, pct14: 0.5, status: g.id === '01AL002' ? 'High' : 'Normal', trend: 'steady', days: 14, min: 10, max: 90, series: [], picked });

(async () => {
  const b = await chromium.launch(); const errs = [];
  const ctx = await b.newContext({ ...devices['iPhone SE'], locale: 'en-CA', geolocation: { latitude: 45.96, longitude: -66.64 }, permissions: ['geolocation'] });
  const p = await ctx.newPage(); p.on('pageerror', e => errs.push(e.message));
  const calls = []; let offline = new Set();
  await p.route(/open-meteo\.com/, r => r.fulfill({ contentType: 'application/json', body: live }));
  await p.route(/\/api\/water/, r => {
    const u = new URL(r.request().url()); calls.push(u.search);
    if (u.searchParams.get('list') === '1') return r.fulfill({ contentType: 'application/json', body: JSON.stringify({ gauges: GAUGES }) });
    const st = u.searchParams.get('station');
    if (st) { const g = GAUGES.find(x => `${x.source}:${x.id}` === st); return g && !offline.has(st) ? r.fulfill({ contentType: 'application/json', body: JSON.stringify(reading(g, true)) }) : r.fulfill({ status: 404, contentType: 'application/json', body: '{"error":"That gauge isn\'t reporting right now."}' }); }
    r.fulfill({ contentType: 'application/json', body: JSON.stringify(reading(GAUGES[0], false)) });
  });
  const click = sel => p.$eval(sel, e => e.click());
  const tile = () => p.evaluate(() => document.querySelector('.tile.river .sub')?.textContent.replace(/\s+/g, ' ').trim());
  await p.goto(URL0);
  await p.evaluate(log => { localStorage.clear(); localStorage.setItem('fishr.guide', '1'); localStorage.setItem('fishr.locAsked', '1'); localStorage.setItem('fishr.keepSafe', String(Date.now()));
    localStorage.setItem('firetiger.v1', JSON.stringify({ sessions: log, notes: [], settings: { temp: 'C' } })); }, ownLog);
  await p.reload(); await p.waitForTimeout(600);
  await p.evaluate(() => { showTab('advice'); goLive(true); }); await p.waitForTimeout(1500);

  let t = await tile();
  ok(/^Saint John River at Fredericton · 1 km away · Change$/.test(t), 'default: closest gauge, with a Change link: ' + t);
  await click('#gaugeChange'); await p.waitForTimeout(500);
  let r = await p.evaluate(() => ({ open: !$('gaugeSheet').hidden, opts: [...document.querySelectorAll('.ga-opt')].map(o => ({ t: o.querySelector('b').textContent, on: o.classList.contains('on') })), over: document.documentElement.scrollWidth > innerWidth }));
  ok(r.open && r.opts.length === 4 && r.opts[0].t === 'Closest (automatic)' && r.opts[0].on && r.opts[2].t === 'Nashwaak River at Durham Bridge', 'Change lists nearby gauges, "Closest" selected ' + JSON.stringify(r.opts.map(o => o.t)));
  ok(!r.over, 'chooser fits a small phone');
  await p.screenshot({ path: S + '/gauge-pick.png' });

  // Pick the Nashwaak.
  await p.$$eval('.ga-opt', els => els[2].click()); await p.waitForTimeout(800);
  t = await tile();
  ok(/^Nashwaak River at Durham Bridge · 19 km away · your pick · Change$/.test(t), 'picked gauge shows, marked as your pick: ' + t);
  r = await p.evaluate(() => ({ g: state.settings.gauges, flow: $('aFlow').querySelector('[aria-pressed="true"]')?.dataset.v, toast: $('toast').textContent }));
  ok(r.g?.length === 1 && r.g[0].station === 'ECCC:01AL002' && Math.abs(r.g[0].lat - 45.96) < 0.01 && r.flow === 'High' && /Using Nashwaak River/.test(r.toast), 'pick saved for this area; Guide inputs follow it ' + JSON.stringify(r));
  await click('#gaugeChange'); await p.waitForTimeout(500);
  ok(await p.evaluate(() => document.querySelectorAll('.ga-opt.on').length === 1 && document.querySelector('.ga-opt.on b').textContent.startsWith('Nashwaak')), 'chooser shows the current pick');
  await click('#gaClose');

  // Remembered after a reload, and used for a new trip logged here.
  calls.length = 0;
  await p.reload(); await p.waitForTimeout(600); await p.evaluate(() => { showTab('advice'); goLive(true); }); await p.waitForTimeout(1500);
  ok(/^Nashwaak River/.test(await tile()) && calls.some(c => c.includes('station=ECCC:01AL002')), 'pick remembered after reload');
  calls.length = 0;
  await p.evaluate(() => { state.settings.home = { lat: 45.961, lon: -66.641 }; save(); }); // saved after their first trip
  await click('#dockLog'); await p.waitForTimeout(1500);
  ok(calls.some(c => c.includes('station=ECCC:01AL002')), 'new trip here uses the picked gauge ' + JSON.stringify(calls));
  await click('#cancelBtn');

  // Somewhere else (more than 15 km away): the pick doesn't apply.
  calls.length = 0;
  await p.evaluate(async () => { const f = await fetchWater(46.3, -66.2); window._far = f && f.station; });
  ok(await p.evaluate(() => window._far) === 'Saint John River at Fredericton' && !calls.some(c => c.includes('station=')), 'pick only applies near where it was made');

  // Picked gauge goes quiet: falls back to the closest, and says so.
  offline.add('ECCC:01AL002');
  await p.evaluate(() => goLive(true)); await p.waitForTimeout(1500);
  t = await tile();
  ok(/^Saint John River at Fredericton · 1 km away · Change$/.test(t), 'picked gauge offline: closest is used instead ' + t);
  await click('#gaugeChange'); await p.waitForTimeout(400);
  await p.$$eval('.ga-opt', els => els[2].click()); await p.waitForTimeout(800);
  ok(/isn't reporting right now, so fishr is using the closest gauge/.test(await p.evaluate(() => $('toast').textContent)), 'picking an offline gauge says so');
  offline.clear();

  // Back to automatic.
  await click('#gaugeChange'); await p.waitForTimeout(400);
  await p.$$eval('.ga-opt', els => els[0].click()); await p.waitForTimeout(800);
  r = await p.evaluate(() => ({ g: state.settings.gauges, toast: $('toast').textContent }));
  ok(Array.isArray(r.g) && r.g.length === 0 && /Using the closest gauge/.test(r.toast) && /^Saint John River/.test(await tile()), '"Closest (automatic)" removes the pick');

  // List can't load: a message, not a blank sheet.
  await p.unroute(/\/api\/water/); await p.route(/\/api\/water/, r => r.fulfill({ status: 502, body: '{}' }));
  await click('#gaugeChange'); await p.waitForTimeout(500);
  ok(/Couldn't load the gauges near you/.test(await p.evaluate(() => $('gaList').textContent)), 'list failure explained');
  await click('#gaClose');

  ok(!errs.length, 'no page errors ' + errs.join(' | '));
  console.log(res.join('\n')); await b.close();
})().catch(e => { console.log(res.join('\n')); console.error('ERR', e.message.split('\n')[0]); process.exit(1); });
