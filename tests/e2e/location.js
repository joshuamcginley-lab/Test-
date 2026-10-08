const { chromium, devices } = require('playwright'); const fs = require('fs');
const S = process.argv[2], URL0 = process.argv[3]; const res = []; const ok = (c, m) => res.push((c ? 'PASS ' : 'FAIL ') + m);
(async () => {
  const b = await chromium.launch(); const errs = [];
  const ctx = await b.newContext({ ...devices['iPhone 13'], colorScheme: 'light' }); // no geolocation permission = denied
  const p = await ctx.newPage(); p.on('pageerror', e => errs.push(e.message));
  let geo = [];
  await p.route('**/geocoding-api.open-meteo.com/**', r => { geo.push(r.request().url()); const q = new URL(r.request().url()).searchParams.get('name');
    r.fulfill({ contentType: 'application/json', body: JSON.stringify(q.toLowerCase().startsWith('halifax') ? { results: [{ name: 'Halifax', admin1: 'Nova Scotia', latitude: 44.6488, longitude: -63.5752 }] } : {}) }); });
  let wxUrl = null; await p.route('**/api.open-meteo.com/**', r => { wxUrl = r.request().url(); r.fulfill({ contentType: 'application/json', body: fs.readFileSync(S + '/wx.json', 'utf8') }); });
  const click = sel => p.$eval(sel, e => e.click());
  await p.goto(URL0); await p.evaluate(() => { localStorage.clear(); sessionStorage.clear(); localStorage.setItem('fishr.guide', '1'); }); await p.reload(); await p.waitForTimeout(800);
  await p.evaluate(() => loadSample('advice')); await p.waitForTimeout(1200);
  ok(!wxUrl, 'sample does not pull New Brunswick weather for a visitor elsewhere');
  ok(await p.evaluate(() => !!$('liveTown')), 'off card offers "Or type a town"');
  await click('#liveGo'); await p.waitForTimeout(1200);
  let r = await p.evaluate(() => ({ title: document.querySelector('.live-fix b')?.textContent, help: document.querySelector('.live-fix div > span')?.textContent, form: !!$('townForm') }));
  ok(r.title === "Couldn't get your location" && /Location is off for fishr/.test(r.help) && /Safari Websites/.test(r.help) && r.form, 'denied location explains itself ' + JSON.stringify(r));
  await p.$eval('#live', e => e.scrollIntoView({ block: 'center' })); await p.screenshot({ path: S + '/loc-denied.png' });
  await p.fill('#townIn', 'Nowheresville'); await click('#townForm button'); await p.waitForTimeout(500);
  ok(/Couldn't find that one/.test(await p.evaluate(() => $('townMsg').textContent)), 'unknown town message');
  await p.fill('#townIn', 'Halifax'); await click('#townForm button'); await p.waitForTimeout(1800);
  r = await p.evaluate(() => ({ home: state.settings.home, live: !!document.querySelector('.tile.bite'), stored: JSON.parse(localStorage.getItem('firetiger.v1')).settings.home }));
  ok(r.home?.name === 'Halifax, Nova Scotia' && r.home.lat === 44.65 && r.live && r.stored?.name === 'Halifax, Nova Scotia', 'town loads live conditions and is remembered ' + JSON.stringify(r.home));
  ok(/latitude=44\.650&longitude=-63\.580|latitude=44\.65/.test(wxUrl || ''), 'weather fetched for Halifax ' + (wxUrl || '').slice(0, 90));
  await p.screenshot({ path: S + '/loc-halifax.png' });
  // next visit: Resync without GPS falls back to the saved town
  wxUrl = null; await p.evaluate(() => { wx = null; goLive(true); }); await p.waitForTimeout(1800);
  ok(/latitude=44\.65/.test(wxUrl || '') && await p.evaluate(() => !!document.querySelector('.tile.bite')), 'later Go live uses the saved town when GPS is blocked');
  r = await p.evaluate(() => ({ head: document.querySelector('.live-head .mono')?.textContent, where: document.querySelector('.live-where')?.textContent }));
  ok(r.head === 'Halifax, Nova Scotia' && /Location is off, so this is the weather for Halifax, Nova Scotia/.test(r.where) && /Change town/.test(r.where), 'card says where the weather is from ' + JSON.stringify(r));
  await click('#liveChange'); ok(await p.evaluate(() => !!$('townForm')), 'Change town opens the town box');
  await p.screenshot({ path: S + '/loc-change.png' });
  ok(!errs.length, 'no errors ' + errs.join('|'));
  console.log(res.join('\n')); await b.close();
})().catch(e => { console.log(res.join('\n')); console.error('ERR', e.message.split('\n')[0]); process.exit(1); });
