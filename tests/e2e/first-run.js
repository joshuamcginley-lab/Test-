// A brand-new user, start to finish: the welcome screen, the first trip, and knowing what happens next.
// The first trip must count toward Copilot without the user knowing to tap "Auto-fill".
const { chromium, devices } = require('playwright'); const fs = require('fs');
const S = process.argv[2], URL0 = process.argv[3] || 'http://localhost:8790/'; const res = []; const ok = (c, m) => res.push((c ? 'PASS ' : 'FAIL ') + m);
const live = fs.readFileSync(S + '/wx.json', 'utf8');
// Hourly weather for whatever days a trip asks about: 18°C, overcast, steady.
function tripWeather(url) {
  const u = new URL(url), from = u.searchParams.get('start_date'), to = u.searchParams.get('end_date');
  const time = [];
  for (let d = new Date(from + 'T00:00'); d <= new Date(to + 'T23:00'); d = new Date(+d + 36e5)) {
    const p = n => String(n).padStart(2, '0'); time.push(`${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}T${p(d.getHours())}:00`);
  }
  const n = time.length, fill = v => Array(n).fill(v);
  return JSON.stringify({ hourly: { time, temperature_2m: fill(18), weather_code: fill(3), pressure_msl: fill(1013), wind_speed_10m: fill(8), wind_direction_10m: fill(200), precipitation: fill(0) } });
}

(async () => {
  const b = await chromium.launch(); const errs = [];
  async function open({ geo = true, failFirst = 0 } = {}) {
    const ctx = await b.newContext({ ...devices['iPhone 13'], locale: 'en-CA', ...(geo ? { geolocation: { latitude: 45.96, longitude: -66.64 }, permissions: ['geolocation'] } : {}) });
    const p = await ctx.newPage(); p.on('pageerror', e => errs.push(e.message));
    let fails = failFirst;
    await p.route(/open-meteo\.com\/v1\/(forecast|archive)/, r => {
      const url = r.request().url();
      if (!url.includes('start_date')) return r.fulfill({ contentType: 'application/json', body: live });
      if (fails > 0) { fails--; return r.abort(); }
      r.fulfill({ contentType: 'application/json', body: tripWeather(url) });
    });
    await p.route(/\/api\/water/, r => r.fulfill({ status: 404, body: '{}' }));
    await p.goto(URL0); await p.evaluate(() => { localStorage.clear(); sessionStorage.clear(); localStorage.setItem('fishr.guide', '1'); }); await p.reload(); await p.waitForTimeout(800);
    return { p, ctx, click: sel => p.$eval(sel, e => e.click()) };
  }
  const celebrateText = p => p.evaluate(() => $('celTitle').textContent + ' | ' + $('celSub').textContent);

  // 1. Welcome: one clear "start", no unlabeled icons.
  let { p, ctx, click } = await open();
  let r = await p.evaluate(() => ({
    primary: document.querySelector('#welcomeNew b').textContent, tag: document.querySelector('#welcomeShowcase .showcase-tag').textContent,
    badge: !!document.querySelector('.sc-tile.start-here .sc-badge'), eye: !!document.getElementById('topSample'),
  }));
  ok(r.primary === 'Log your first trip', 'welcome: the main button says what it does ' + r.primary);
  ok(/New here\?/.test(r.tag) && r.badge, 'welcome: showcase reads as the place to look first, Start here badge kept');
  ok(!r.eye, 'no unlabeled eye icon in the top bar');
  r = await p.evaluate(() => ({ tagline: $('tagline').textContent, tile: document.querySelector('.sc-tile.start-here b').textContent, tab: $('tab-advice').textContent.trim(), any: /copilot/i.test(document.body.innerText + document.title + document.querySelector('meta[name=description]').content) }));
  ok(/^The AI fishing guide trained on you/.test(r.tagline) && r.tile === 'Guide' && r.tab === 'Guide' && !r.any, 'Copilot is now the Guide everywhere a user can see ' + JSON.stringify(r));
  await p.screenshot({ path: S + '/first-welcome.png' });

  // 2. First trip form: nothing looks filled in, weather fills itself.
  await click('#welcomeNew'); await p.waitForTimeout(1800);
  r = await p.evaluate(() => ({
    rows: document.querySelectorAll('#catchRows .catch-row').length, add: $('addCatch').textContent,
    tempPh: $('fTlo').placeholder, waterPh: $('fWaterIn').placeholder, temp: $('fTlo').value, asked: localStorage.getItem('fishr.locAsked'), msg: $('wxText').textContent,
  }));
  ok(r.rows === 0 && r.add === '+ Add a fish', 'form starts with no catch row: ' + JSON.stringify({ rows: r.rows, add: r.add }));
  ok(r.tempPh === '' && /^Lake or river/.test(r.waterPh), 'examples no longer look like answers ' + JSON.stringify({ t: r.tempPh, w: r.waterPh }));
  ok(r.temp === '18' && r.asked === '1', 'first trip: asks for location once and fills the temperature ' + JSON.stringify({ temp: r.temp, msg: r.msg }));
  await p.screenshot({ path: S + '/first-form.png' });
  await click('#addCatch'); await p.waitForTimeout(200);
  ok(await p.evaluate(() => document.querySelectorAll('#catchRows .catch-row').length === 1 && $('addCatch').textContent === '+ Add another fish'), 'Add a fish adds a row, then reads "Add another fish"');
  await click('#catchRows .x'); await p.waitForTimeout(100);
  ok(await p.evaluate(() => $('addCatch').textContent === '+ Add a fish'), 'removing the last fish goes back to "Add a fish"');
  await p.fill('#fWaterIn', 'Keswick River'); await click('#saveBtn'); await p.waitForTimeout(400);
  let cel = await celebrateText(p);
  ok(/Skunk logged \| 1 of 10 trips\. Your guide starts making calls at 10\. Skunks count too\./.test(cel), 'saved: says where that leaves Copilot ' + cel);
  r = await p.evaluate(() => state.sessions[0]);
  ok(r.tempLow === 18 && r.wx?.t === 18, 'the skunk counts: it has a temperature and weather');
  await p.waitForTimeout(2600);
  r = await p.evaluate(() => ({ tab: [...document.querySelectorAll('[role=tabpanel]')].find(x => !x.hidden)?.id, card: $('advice').textContent }));
  ok(r.tab === 'panel-advice' && /9 more trips/.test(r.card), 'after the first trip: Copilot shows how many trips to go');
  await p.evaluate(() => showTab('log')); await p.waitForTimeout(300);
  r = await p.evaluate(() => !$('trainStrip').hidden && $('trainStrip').innerText.replace(/\s+/g, ' ').trim());
  ok(/^1 of 10 trips Your guide starts making calls at 10\. Skunks count\.$/.test(r), 'Trips shows progress toward Copilot ' + JSON.stringify(r));
  await p.screenshot({ path: S + '/first-trips.png' });
  // A second trip doesn't ask again: it uses the saved location.
  await click('#dockLog'); await p.waitForTimeout(1500);
  ok(await p.evaluate(() => $('fTlo').value === '18'), 'second trip fills the weather from the saved location');
  await click('#cancelBtn');
  // Copilot: plain words, no engine tag on a phone.
  await p.evaluate(() => showTab('advice')); await p.evaluate(() => goLive(true)); await p.waitForTimeout(1500);
  ok(await p.evaluate(() => $('screenTitle').textContent === 'Guide' && /Your guide needs 9 more trips/.test($('advice').textContent) && getComputedStyle(document.querySelector('.verdict'), '::before').content.includes('Your guide')), 'Guide screen: title and training card say "guide"');
  r = await p.evaluate(() => ({ tag: [...document.querySelectorAll('.model-tag')].some(e => e.checkVisibility()), what: document.querySelector('#inputsBox summary span').textContent, card: $('advice').textContent }));
  ok(!r.tag, 'Copilot: the bite-engine tag is hidden on phones');
  ok(r.what === 'Plan a trip' && !/workspace/.test(r.card) && /1 of 10/i.test(r.card), 'Copilot: plain labels ' + JSON.stringify({ what: r.what }));
  // Ten trips with a temperature: the strip goes away.
  await p.evaluate(() => { for (let i = 0; i < 9; i++) state.sessions.push({ id: 't-f' + i, date: '2026-07-0' + (i + 1), water: 'Keswick River', catches: [], tempLow: 20, tempHigh: 20, updatedAt: new Date().toISOString() }); save(); render(); });
  ok(await p.evaluate(() => $('trainStrip').hidden), '10 trips: progress strip goes away');
  // The sample season lives in Settings now.
  await click('#openSettings'); await click('#settingsSample'); await p.waitForTimeout(1200);
  ok(await p.evaluate(() => !!demo && $('settings').hidden && $('trainStrip').hidden), 'Settings > Show the sample season opens the sample');
  await ctx.close();

  // 3. Location blocked: the form says why the temperature matters, and the trip says it doesn't count yet.
  ({ p, ctx, click } = await open({ geo: false }));
  await click('#welcomeNew'); await p.waitForTimeout(1500);
  r = await p.evaluate(() => $('wxText').textContent);
  ok(/No location, so type the temperature\. A trip needs one to count toward your guide\./.test(r), 'no location: form explains the temperature ' + r);
  await p.fill('#fWaterIn', 'Keswick River'); await click('#saveBtn'); await p.waitForTimeout(400);
  cel = await celebrateText(p);
  ok(/counts toward your guide once it has a temperature: tap the trip to add one/.test(cel), 'saved without a temperature: says it does not count yet ' + cel);
  await p.waitForTimeout(2600);
  await p.evaluate(() => showTab('log')); r = await p.evaluate(() => $('trainStrip').innerText.replace(/\s+/g, ' '));
  ok(/0 of 10 trips/.test(r) && /1 trip has no temperature, so it doesn't count yet\. Add the weather/.test(r), 'Trips points out the trip that doesn\'t count ' + r);
  await click('#tsFill'); await p.waitForTimeout(400);
  ok(await p.evaluate(() => !$('settings').hidden), '"Add the weather" opens Settings at the weather tool');
  await ctx.close();

  // 4. Weather fails while the form is open (no signal): it's added right after saving.
  ({ p, ctx, click } = await open({ failFirst: 1 }));
  await click('#welcomeNew'); await p.waitForTimeout(1500);
  ok(await p.evaluate(() => $('fTlo').value === ''), 'weather lookup failed on the form');
  await p.fill('#fWaterIn', 'Keswick River'); await click('#saveBtn'); await p.waitForTimeout(1500);
  r = await p.evaluate(() => ({ t: state.sessions[0].tempLow, wx: !!state.sessions[0].wx, toast: document.querySelector('.toast')?.textContent || $('toast')?.textContent || '' }));
  ok(r.t === 18 && r.wx, 'weather added after saving ' + JSON.stringify(r));
  ok(/Weather added\. 1 of 10 trips/.test(r.toast), 'and says so ' + r.toast);
  await ctx.close();

  // 5. Keep your trips safe: shown to iPhone users with a log in Safari, until they install or turn on Cloud.
  ({ p, ctx, click } = await open());
  const keep = () => p.evaluate(() => ({ shown: !$('keepSafe').hidden, text: $('keepSafe').textContent.replace(/\s+/g, ' ') }));
  ok(!(await keep()).shown, 'keep-safe: not shown before there is a log');
  await p.evaluate(() => { state.sessions.push({ id: 't-k1', date: '2026-07-01', water: 'Keswick River', catches: [], tempLow: 20, tempHigh: 20, updatedAt: new Date().toISOString() }); save(); render(); });
  let k = await keep();
  ok(k.shown && /Safari can clear a site's data/.test(k.text) && /Add to Home Screen/.test(k.text) && /turn on Cloud/.test(k.text), 'keep-safe: iPhone in Safari is told how to keep the log ' + k.text.slice(0, 80));
  await p.screenshot({ path: S + '/first-keepsafe.png' });
  await p.evaluate(() => loadSample()); await p.waitForTimeout(800);
  ok(!(await keep()).shown, 'keep-safe: hidden in the showcase');
  await p.evaluate(() => exitSample()); await p.waitForTimeout(300);
  await p.evaluate(() => { sync.user = { id: 'u1' }; renderCloud(); });
  ok(!(await keep()).shown, 'keep-safe: hidden once Cloud is on');
  await p.evaluate(() => { sync.user = null; renderCloud(); });
  ok((await keep()).shown, 'keep-safe: back when Cloud is off');
  await click('#ksCloud'); await p.waitForTimeout(300);
  ok(await p.evaluate(() => !$('settings').hidden), '"Turn on Cloud" opens Settings at Storage');
  await p.evaluate(() => closeSheets());
  await click('#ksLater');
  ok(!(await keep()).shown, '"Not now" hides it');
  await p.reload(); await p.waitForTimeout(800);
  ok(!(await keep()).shown, '"Not now" is remembered');
  await ctx.close();
  // Opened from the Home Screen: nothing to say.
  ({ p, ctx, click } = await open());
  await p.addInitScript(() => Object.defineProperty(navigator, 'standalone', { get: () => true }));
  await p.evaluate(() => { state.sessions.push({ id: 't-k2', date: '2026-07-01', water: 'Keswick River', catches: [], updatedAt: new Date().toISOString() }); save(); });
  await p.reload(); await p.waitForTimeout(800);
  ok(!(await keep()).shown, 'keep-safe: hidden when opened from the Home Screen');
  await ctx.close();

  ok(!errs.length, 'no page errors ' + errs.join(' | '));
  console.log(res.join('\n')); await b.close();
})().catch(e => { console.log(res.join('\n')); console.error('ERR', e.message.split('\n')[0]); process.exit(1); });
