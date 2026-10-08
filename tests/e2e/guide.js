const { chromium, devices } = require('playwright'); const fs = require('fs');
const S = process.argv[2]; const res = []; const ok = (c, m) => res.push((c ? 'PASS ' : 'FAIL ') + m);
(async () => {
  const b = await chromium.launch();
  for (const scheme of ['dark', 'light']) {
    const ctx = await b.newContext({ ...devices['iPhone 13'], colorScheme: scheme }); const p = await ctx.newPage();
    const errs = []; p.on('pageerror', e => errs.push(e.message));
    await p.route('**/api.open-meteo.com/**', r => r.abort()); await p.route('**/api/sample', r => r.fulfill({ contentType: 'application/json', body: fs.readFileSync(S + '/enriched.json') }));
    const click = sel => p.$eval(sel, el => el.click());
    const g = () => p.evaluate(() => ({ open: !$('guide').hidden, step: $('gStepLbl').textContent, title: $('gTitle').textContent, ring: !$('gRing').hidden, next: $('gNext').textContent }));
    await p.goto((process.argv[3] || 'http://localhost:8790/')); await p.evaluate(() => { localStorage.clear(); sessionStorage.clear(); }); await p.reload(); await p.waitForTimeout(1200);
    await click('[data-sample="advice"]'); await p.waitForTimeout(2000);
    let s = await g(); ok(s.open && s.step === '1 of 5' && s.title === 'How fishr works' && !s.ring, `${scheme} guide opens on Copilot tile ` + JSON.stringify(s));
    await p.screenshot({ path: `${S}/guide-${scheme}-1.png` });
    for (let i = 2; i <= 5; i++) {
      await click('#gNext'); await p.waitForTimeout(700); s = await g();
      ok(s.step === `${i} of 5` && s.ring, `${scheme} step ${i}: ${s.title}`);
      if (scheme === 'dark' || i === 3) await p.screenshot({ path: `${S}/guide-${scheme}-${i}.png` });
    }
    ok(s.next === 'Start my data set', 'last step CTA ' + s.next);
    if (scheme === 'dark') {
      await click('#gNext'); await p.waitForTimeout(500);
      const r = await p.evaluate(() => ({ guide: !$('guide').hidden, demo: !!demo, sheet: !$('sheet').hidden, seen: localStorage.getItem('fishr.guide') }));
      ok(!r.guide && !r.demo && r.sheet && r.seen === '1', 'CTA exits sample and opens log form ' + JSON.stringify(r));
      await click('#cancelBtn'); await click('[data-sample="advice"]'); await p.waitForTimeout(1500);
      ok(!(await g()).open, 'guide only shows once');
      await click('#guideOpen'); await p.waitForTimeout(500); ok((await g()).open, 'How fishr works replays');
      await p.keyboard.press('Escape'); await p.waitForTimeout(200);
      const e = await p.evaluate(() => ({ guide: !$('guide').hidden, demo: !!demo, inputsOpen: $('inputsBox').open }));
      ok(!e.guide && e.demo && !e.inputsOpen, 'Escape closes guide, stays in sample ' + JSON.stringify(e));
    } else {
      await p.evaluate(() => localStorage.removeItem('fishr.guide'));
      await click('#gSkip'); await p.evaluate(() => localStorage.removeItem('fishr.guide')); await click('#homeLink'); await click('[data-sample="patterns"]'); await p.waitForTimeout(1200);
      ok(!(await g()).open, 'Insights tile does not open guide');
    }
    ok(!errs.length, scheme + ' no errors ' + errs.join('|'));
    await ctx.close();
  }
  console.log(res.join('\n')); await b.close();
})();
