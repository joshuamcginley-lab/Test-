const { chromium, devices } = require('playwright'); const fs = require('fs');
const S = process.argv[2]; const res = []; const ok = (c, m) => res.push((c ? 'PASS ' : 'FAIL ') + m);
(async () => {
  const b = await chromium.launch(); const ctx = await b.newContext({ ...devices['iPhone 13'], colorScheme: 'dark', acceptDownloads: true }); const p = await ctx.newPage();
  const errs = []; p.on('pageerror', e => errs.push(e.message));
  await p.route('**/api.open-meteo.com/**', r => r.abort()); await p.route('**/api/sample', r => r.fulfill({ contentType: 'application/json', body: fs.readFileSync(S + '/enriched.json') }));
  const click = sel => p.$eval(sel, el => el.click());
  const st = () => p.evaluate(() => ({ demo: !!demo, welcome: !$('welcome').hidden, tab: document.querySelector('nav.tabs [aria-selected="true"]')?.dataset.tab, settings: !$('settings').hidden }));
  await p.goto((process.argv[3] || 'http://localhost:8790/')); await p.evaluate(() => { localStorage.clear(); sessionStorage.clear(); }); await p.reload(); await p.waitForTimeout(1200);
  await click('[data-sample="patterns"]'); await p.waitForTimeout(1300);
  await click('#openSettings'); await p.waitForTimeout(300);
  let s = await st(); ok(s.demo && s.settings, 'settings opens over sample ' + JSON.stringify(s));
  await click('#closeSettings'); await p.waitForTimeout(300);
  s = await st(); ok(s.demo && !s.welcome && s.tab === 'patterns' && !s.settings, 'closing settings returns to sample Insights ' + JSON.stringify(s));
  await click('#openSettings'); await click('#scrim'); await p.waitForTimeout(200);
  s = await st(); ok(s.demo && s.tab === 'patterns', 'tapping outside also keeps sample');
  // export while in sample gives your own (empty) log, not the sample
  await click('#openSettings');
  const dl = p.waitForEvent('download', { timeout: 5000 }).catch(() => null);
  await p.evaluate(() => { navigator.canShare = undefined; }); await click('#exportJson'); const d = await dl;
  if (d) { const j = JSON.parse(fs.readFileSync(await d.path(), 'utf8')); ok(j.sessions.length === 0 && !j.sessions.some(x => x.sample), 'export in sample = own log only (' + j.sessions.length + ')'); } else ok(false, 'no download');
  await click('#closeSettings');
  // logo from sample -> welcome
  await click('#homeLink'); await p.waitForTimeout(300);
  s = await st(); ok(!s.demo && s.welcome, 'logo leaves sample to welcome ' + JSON.stringify(s));
  // own log: logo -> Copilot
  await p.evaluate(() => { state.sessions.push({ id: 't-z', date: '2026-08-01', water: 'Tay River', catches: [], updatedAt: new Date().toISOString() }); save(); render(); showTab('log'); });
  await click('#openSettings'); await click('#homeLink'); await p.waitForTimeout(300);
  s = await st(); ok(!s.demo && !s.welcome && s.tab === 'advice' && !s.settings, 'logo on own log -> Copilot, closes settings ' + JSON.stringify(s));
  ok(await p.$eval('#homeLink', e => getComputedStyle(e).textDecorationLine === 'none'), 'logo not underlined');
  ok(!errs.length, 'no errors ' + errs.join('|'));
  console.log(res.join('\n')); await b.close();
})();
