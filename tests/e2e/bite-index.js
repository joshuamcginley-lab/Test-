// Bite Index: factors learn from the angler's own log, and the score can be for the fish they chase.
// Neither may add clutter for the showcase or a new user.
const { chromium, devices } = require('playwright'); const fs = require('fs');
const S = process.argv[2], URL0 = process.argv[3] || 'http://localhost:8790/'; const res = []; const ok = (c, m) => res.push((c ? 'PASS ' : 'FAIL ') + m);

// The weather fixture, moved so "now" sits 48 hours into it whatever day the tests run.
const wx = JSON.parse(fs.readFileSync(S + '/wx.json', 'utf8'));
const pad = n => String(n).padStart(2, '0'), fmt = d => `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}T${pad(d.getHours())}:${pad(d.getMinutes())}`;
const shift = ms => s => fmt(new Date(new Date(s).getTime() + ms));
const now = new Date(); now.setMinutes(0, 0, 0);
const by = now - new Date(wx.hourly.time[48]);
wx.hourly.time = wx.hourly.time.map(shift(by)); wx.daily.sunrise = wx.daily.sunrise.map(shift(by)); wx.daily.sunset = wx.daily.sunset.map(shift(by));
const wxBody = JSON.stringify(wx);
// The sample season as someone's own log (not flagged as the sample).
const ownLog = JSON.parse(fs.readFileSync(S + '/enriched.json', 'utf8')).map(({ sample, ...s }) => s);

(async () => {
  const b = await chromium.launch(); const errs = [];
  async function open(device, { log, scheme = 'light', settings = {} } = {}) {
    const ctx = await b.newContext({ ...devices[device], colorScheme: scheme, locale: 'en-CA', geolocation: { latitude: 45.96, longitude: -66.64 }, permissions: ['geolocation'] });
    const p = await ctx.newPage(); p.on('pageerror', e => errs.push(e.message));
    await p.route('**/api.open-meteo.com/**', r => r.fulfill({ contentType: 'application/json', body: wxBody }));
    await p.route(/wateroffice|api\.weather\.gc\.ca/, r => r.abort());
    await p.goto(URL0);
    await p.evaluate(([log, settings]) => { localStorage.clear(); sessionStorage.clear(); localStorage.setItem('fishr.guide', '1');
      if (log) localStorage.setItem('firetiger.v1', JSON.stringify({ sessions: log, notes: [], settings: { temp: 'C', ...settings } })); }, [log, settings]);
    await p.reload(); await p.waitForTimeout(700);
    return { p, ctx };
  }
  const card = p => p.evaluate(() => ({
    score: +document.querySelector('.bite-num b')?.dataset.count,
    pill: document.querySelector('#biteSp') ? { value: $('biteSp').value, options: [...$('biteSp').options].map(o => o.textContent),
      yours: [...document.querySelectorAll('#biteSp optgroup[label="Your fish"] option')].map(o => o.textContent),
      others: [...$('biteSp').options].filter(o => !o.closest('optgroup[label="Your fish"]') && o.value !== 'all').map(o => o.textContent) } : null,
    chips: [...document.querySelectorAll('.drivers .drv')].map(d => ({ t: d.textContent, mine: d.classList.contains('mine'), why: d.dataset.why || '' })),
    overflow: document.documentElement.scrollWidth > innerWidth,
  }));
  // Set the live conditions directly, so each check knows which buckets it's in.
  const setWx = (p, o) => p.evaluate(o => { Object.assign(wx.current, o.current || {}); if (o.temp != null) wx.hourly.forEach(h => h.temp = o.temp); renderLive(); }, o);

  // 1. Own log: species pill, default species, personal chips with a reason.
  let { p, ctx } = await open('iPhone 13', { log: ownLog });
  await p.evaluate(() => showTab('advice')); await p.evaluate(() => goLive(true)); await p.waitForTimeout(1500);
  let r = await card(p);
  ok(r.pill && r.pill.options[0] === 'All fish' && r.pill.yours.length >= 1 && r.pill.yours.length <= 4, 'own log: species pill lists their fish first ' + JSON.stringify(r.pill.yours));
  ok(r.pill.others.includes('Salmon') && r.pill.others.includes('Muskie') && !['Walleye', 'Pike', 'Carp'].some(n => r.pill.others.includes(n)), 'other fish: only ones found around Fredericton (no walleye, pike or carp) ' + JSON.stringify(r.pill.others));
  const counts = await p.evaluate(() => { const n = {}; for (const s of state.sessions) for (const c of s.catches || []) { const i = speciesInfo(c.species); if (i) n[i.name] = (n[i.name] || 0) + (+c.count || 0); } return n; });
  const total = Object.values(counts).reduce((a, x) => a + x, 0), top = Object.entries(counts).sort((a, b) => b[1] - a[1])[0];
  ok(r.pill?.value === (top[1] / total >= 0.4 ? top[0] : 'all'), `defaults to the fish they catch most (${top[0]} ${top[1]}/${total}) → ${r.pill?.value}`);
  ok(r.pill.yours.every(n => counts[n] >= 3), 'only species with 3+ fish are listed as theirs');

  // Personal chips: try each pressure trend; at least one should be backed by their log, with a reason.
  let mineChip = null;
  for (const press of ['Falling', 'Steady', 'Rising']) {
    await setWx(p, { current: { press, dp3: press === 'Falling' ? -1 : press === 'Rising' ? 1 : 0 } });
    r = await card(p); mineChip = mineChip || r.chips.find(c => c.mine);
    // Phones show three chips; a learned one must be among them, not pushed off the end.
    const vis = await p.evaluate(() => [...document.querySelectorAll('.drivers .drv')].filter(d => d.checkVisibility()).map(d => d.classList.contains('mine')));
    if (r.chips.some(c => c.mine)) ok(vis.length <= 3 && vis.includes(true), `${press}: a learned chip is visible on a phone (${vis.length} shown)`);
    ok(new Set(r.chips.map(c => c.t)).size === r.chips.length, `${press}: no chip shown twice`);
  }
  ok(mineChip && /^Your log: [\d.]+ .+ per trip on .+, vs [\d.]+ across your trips \(\d+ trips\)\. (The (general rule|rule for [a-z ]+) gives [+−±]\d+; your log makes it [+−±]\d+|So it counts [+−±]\d+)\.$/.test(mineChip.why), 'a chip learned from their log explains itself ' + JSON.stringify(mineChip));
  // Tapping it shows the reason under the chips; tapping again hides it.
  const sel = `.drv.mine`;
  if (await p.$(sel)) {
    await p.$eval(sel, e => e.click());
    r = await p.evaluate(() => ({ shown: !$('drvWhy').hidden, text: $('drvWhy').textContent, exp: document.querySelector('.drv.mine').getAttribute('aria-expanded') }));
    ok(r.shown && /^Your log:/.test(r.text) && r.exp === 'true', 'tap a learned chip: one line says why');
    await p.screenshot({ path: S + '/bite-why.png' });
    await p.$eval(sel, e => e.click());
    ok(await p.evaluate(() => $('drvWhy').hidden), 'tap again: reason hides');
  } else ok(false, 'no learned chip to tap');

  // Species temperature: comfortable vs too cold changes the score, and says why.
  await p.selectOption('#biteSp', 'Smallmouth').catch(() => {});
  if (await p.evaluate(() => $('biteSp')?.value) !== 'Smallmouth') ok(false, 'Smallmouth not offered in pill');
  await setWx(p, { temp: 22, current: { press: 'Steady', dp3: 0 } }); const warm = await card(p);
  await setWx(p, { temp: 4 }); const cold = await card(p);
  ok(warm.chips.some(c => c.t === '+10 Good temps for smallmouth' && /Smallmouth feed best in 18–26°C water and slow right down below 10°C/.test(c.why)), 'smallmouth: good temps chip ' + JSON.stringify(warm.chips.map(c => c.t)));
  ok(cold.chips.some(c => c.t === '−15 Too cold for smallmouth'), 'smallmouth: too cold chip ' + JSON.stringify(cold.chips.map(c => c.t)));
  ok(warm.score > cold.score, `warm water scores higher for smallmouth (${warm.score} vs ${cold.score})`);
  ok(await p.evaluate(() => JSON.parse(localStorage.getItem('firetiger.v1')).settings.biteSpecies) === 'Smallmouth', 'species choice is saved');
  // Personal chips count only that species' fish.
  await setWx(p, { temp: 22 });
  r = await card(p); const spMine = r.chips.find(c => c.mine);
  ok(!spMine || / smallmouth per trip /.test(spMine.why), 'learned chips use smallmouth counts when scoring for smallmouth ' + (spMine?.why || 'none'));
  await p.selectOption('#biteSp', 'all'); r = await card(p);
  ok(!r.chips.some(c => /for smallmouth/.test(c.t)) && await p.evaluate(() => state.settings.biteSpecies) === 'all', '"All fish" goes back to the general score');
  await p.reload(); await p.waitForTimeout(700); await p.evaluate(() => { showTab('advice'); goLive(true); }); await p.waitForTimeout(1500);
  ok((await card(p)).pill?.value === 'all', '"All fish" is remembered after a reload');
  // Cold fronts, from the hourly pressure and temperature around now.
  const series = kind => p.evaluate(kind => {
    const base = new Date(); base.setMinutes(0, 0, 0); const H = [];
    for (let k = -48; k <= 36; k++) {
      const temp = kind === 'passed' ? (k > -14 ? 8 : 20) : kind === 'coming' ? (k < 8 ? 18 : 6) : 15;
      const pr = kind === 'passed' ? 1000 + Math.abs(k + 10) * 0.8 : kind === 'coming' ? (k <= 0 ? 1010 : k <= 8 ? 1010 - k * 0.75 : 1004 + (k - 8) * 0.8) : 1013;
      H.push({ time: new Date(+base + k * 36e5), temp, p: pr, sky: 'Clear', wind: 10, rain: 0, pop: 0 });
    }
    wx.hourly = H; wx.current.press = 'Steady'; wx.current.dp3 = 0; renderLive();
    const chip = [...document.querySelectorAll('.drivers .drv')].find(d => /cold front/i.test(d.textContent));
    return { chip: chip?.textContent || null, why: chip?.dataset.why || '', visible: !!chip?.checkVisibility(), ask: askConditions().front || null };
  }, kind);
  await p.selectOption('#biteSp', 'all');
  r = await series('passed');
  ok(r.chip === '−10 Just after a cold front' && r.visible, 'front passed 10h ago: −10 chip, shown on a phone ' + JSON.stringify(r.chip));
  ok(/^A cold front came through about 1[01] hours ago: \d+° colder than the day before and pressure up 8 hPa since\./.test(r.why), 'passed front explains itself: ' + r.why);
  ok(/^cold front passed about 1[01] hours ago/.test(r.ask || ''), 'Ask fishr is told about the front: ' + r.ask);
  await p.$eval('.drv[data-why*="cold front"]', e => e.click()).catch(() => {});
  await p.screenshot({ path: S + '/bite-front.png' });
  r = await series('coming');
  ok(r.chip === '+5 Cold front coming' && /due in about [78] hours/.test(r.why), 'front due in 8h: +5 chip ' + JSON.stringify(r));
  r = await series('steady');
  ok(!r.chip && !r.ask, 'steady weather: no front chip, nothing sent to Ask fishr');
  await ctx.close();

  // 2. Showcase and a brand-new user: nothing new on the card.
  ({ p, ctx } = await open('iPhone 13'));
  await p.evaluate(() => loadSample('advice')); await p.waitForTimeout(1200); await p.evaluate(() => goLive(true)); await p.waitForTimeout(1500);
  r = await card(p);
  ok(r.score && !r.pill && !r.chips.some(c => c.mine || /Your log/.test(c.why + c.t)), 'showcase: no species pill and no "your log" chips ' + JSON.stringify(r.chips.map(c => c.t)));
  await ctx.close();
  ({ p, ctx } = await open('iPhone 13', { log: [] }));
  await p.evaluate(() => showTab('advice')); await p.evaluate(() => goLive(true)); await p.waitForTimeout(1500);
  r = await card(p);
  ok(r.score && r.pill?.value === 'all' && !r.pill.yours.length && r.pill.others.includes('Brook trout') && !r.chips.some(c => c.mine), 'new user: can pick the fish they\'re after (found locally), no learned chips ' + JSON.stringify(r.pill));
  // A new angler after brook trout gets the trout's own rules, explained.
  await p.$eval('#biteSp', e => { e.value = 'Brook trout'; e.dispatchEvent(new Event('change')); }); await p.waitForTimeout(300);
  r = await card(p);
  ok(r.pill.value === 'Brook trout' && r.chips.some(c => /for brook trout$/.test(c.t)) && r.chips.some(c => /^Brook trout: cold-water fish/.test(c.why)), 'new user picks brook trout: the score uses trout rules, and says so ' + JSON.stringify(r.chips.map(c => [c.t, c.why.slice(0, 40)])));
  // A few trips isn't enough to learn from: defaults stay.
  await p.evaluate(log => { state.sessions = log.slice(0, 5); renderLive(); }, ownLog); r = await card(p);
  ok(!r.chips.some(c => c.mine), '5 trips: too few to learn from, no learned chips');
  await ctx.close();

  // 3. Layout: no clutter, no sideways scroll, on small and normal phones, light and dark.
  for (const [device, scheme] of [['iPhone SE', 'light'], ['iPhone SE', 'dark'], ['iPhone 13', 'light'], ['iPhone 13', 'dark']]) {
    ({ p, ctx } = await open(device, { log: ownLog, scheme, settings: { biteSpecies: 'Smallmouth' } }));
    await p.evaluate(() => showTab('advice')); await p.evaluate(() => goLive(true)); await p.waitForTimeout(1600);
    r = await p.evaluate(() => {
      const t = document.querySelector('.tile.bite').getBoundingClientRect(), s = $('biteSp')?.getBoundingClientRect(), lbl = document.querySelector('.bite-txt .label').getBoundingClientRect();
      return { over: document.documentElement.scrollWidth > innerWidth, inTile: s && s.right <= t.right + 1 && s.left >= t.left, lblH: lbl.height, font: s && getComputedStyle($('biteSp')).fontSize };
    });
    ok(!r.over && r.inTile, `${device} ${scheme}: pill fits the card, no sideways scroll ${JSON.stringify(r)}`);
    ok(r.lblH < 40, `${device} ${scheme}: title row stays one line (${Math.round(r.lblH)}px)`);
    ok(parseFloat(r.font) >= 16, `${device} ${scheme}: pill font is 16px so iOS won't zoom (${r.font})`);
    await p.$eval('.tile.bite', e => e.scrollIntoView({ block: 'center' }));
    await p.screenshot({ path: `${S}/bite-${device.replace(/\s/g, '').toLowerCase()}-${scheme}.png` });
    await ctx.close();
  }

  ok(!errs.length, 'no page errors ' + errs.join(' | '));
  console.log(res.join('\n')); await b.close();
})().catch(e => { console.log(res.join('\n')); console.error('ERR', e.message.split('\n')[0]); process.exit(1); });
