// A visitor who isn't from Fredericton tries the showcase: their weather, honest labels, sensible units.
const { chromium, devices } = require('playwright'); const fs = require('fs');
const S = process.argv[2], URL0 = process.argv[3] || 'http://localhost:8790/'; const res = []; const ok = (c, m) => res.push((c ? 'PASS ' : 'FAIL ') + m);
const wxBody = fs.readFileSync(S + '/wx.json', 'utf8');
(async () => {
  const b = await chromium.launch(); const errs = [];
  for (const [who, geo, locale] of [['Halifax', { latitude: 44.65, longitude: -63.57 }, 'en-CA'], ['Chicago', { latitude: 41.88, longitude: -87.63 }, 'en-US']]) {
    const ctx = await b.newContext({ ...devices['iPhone 13'], locale, geolocation: geo, permissions: ['geolocation'] });
    const p = await ctx.newPage(); p.on('pageerror', e => errs.push(e.message));
    let wxAt = null; await p.route('**/api.open-meteo.com/**', r => { wxAt = new URL(r.request().url()).searchParams.get('latitude'); r.fulfill({ contentType: 'application/json', body: wxBody }); });
    await p.goto(URL0); await p.evaluate(() => { localStorage.clear(); sessionStorage.clear(); localStorage.setItem('fishr.guide', '1'); }); await p.reload(); await p.waitForTimeout(800);
    ok(await p.evaluate(() => state.settings.temp) === (locale === 'en-US' ? 'F' : 'C'), `${who}: starts in ${locale === 'en-US' ? '°F' : '°C'}`);
    await p.$eval('[data-sample="advice"]', e => e.click()); await p.waitForTimeout(1400);
    await p.evaluate(() => goLive(true)); await p.waitForTimeout(1500);
    const r = await p.evaluate(() => ({
      drivers: [...document.querySelectorAll('.drivers .drv')].map(d => d.textContent),
      where: document.querySelector('.live-where')?.textContent || '',
      pick: document.querySelector('.showcase-pick')?.textContent || '',
      window: !!document.querySelector('.window'),
      temp: $('aTemp').value, time: $('aTime').value, say: document.querySelector('.v-say')?.textContent || '',
    }));
    ok(r.time === '18:30' && Math.round(+r.temp) === (locale === 'en-US' ? 72 : 22), `${who}: live weather doesn't replace the showcase's July evening (${r.temp} at ${r.time})`);
    ok(/this angler caught|This angler has/.test(r.say) && !/ you caught/.test(r.say), `${who}: the call talks about "this angler", not "you"`);
    ok(Math.abs(+wxAt - geo.latitude) < 0.1, `${who}: live weather is for their location (${wxAt})`);
    ok(!r.drivers.some(d => /Your log/.test(d)), `${who}: Bite Index doesn't claim the sample is their log ${JSON.stringify(r.drivers)}`);
    ok(/Your weather right now/.test(r.where) && /New Brunswick/.test(r.where), `${who}: live card explains the showcase call uses the sample's July evening`);
    ok(/New Brunswick waters/.test(r.pick) && /Log your own trips/.test(r.pick), `${who}: the call says it's the showcase angler's pick`);
    ok(!r.window, `${who}: no "Best window" pointing at New Brunswick waters for their forecast`);
    if (who === 'Halifax') await p.screenshot({ path: S + '/visitor-halifax.png', fullPage: true });
    // Own log: the personal factor and best window come back
    await p.evaluate(async () => { exitSample(); const d = (await (await fetch('sample.json')).json()).map(s => { delete s.sample; s.id = 'own-' + s.id; return s; }); state.sessions = d; save(); render(); goLive(true); });
    await p.waitForTimeout(1500);
    const own = await p.evaluate(() => ({ drivers: [...document.querySelectorAll('.drivers .drv')].map(d => d.textContent).join('|'), pick: !!document.querySelector('.showcase-pick'), where: document.querySelector('.live-where')?.textContent || '' }));
    ok(!own.pick && !/Your weather right now/.test(own.where), `${who}: own log has no showcase notes`);
    await ctx.close();
  }
  ok(!errs.length, 'no page errors ' + errs.join('|'));
  console.log(res.join('\n')); await b.close();
})().catch(e => { console.log(res.join('\n')); console.error('ERR', e.message.split('\n')[0]); process.exit(1); });
