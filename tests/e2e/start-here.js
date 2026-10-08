const { chromium, devices } = require('playwright'); const fs = require('fs');
const S = process.argv[2]; const res = []; const ok = (c, m) => res.push((c ? 'PASS ' : 'FAIL ') + m);
(async () => {
  const b = await chromium.launch(); const errs = [];
  for (const scheme of ['dark', 'light']) {
    const ctx = await b.newContext({ ...devices['iPhone 13'], colorScheme: scheme }); const p = await ctx.newPage(); p.on('pageerror', e => errs.push(e.message));
    await p.route('**/api.open-meteo.com/**', r => r.abort()); await p.route('**/api/sample', r => r.fulfill({ contentType: 'application/json', body: fs.readFileSync(S + '/enriched.json') }));
    const click = sel => p.$eval(sel, el => el.click());
    await p.goto((process.argv[3] || 'http://localhost:8790/')); await p.evaluate(() => { localStorage.clear(); sessionStorage.clear(); }); await p.reload(); await p.waitForTimeout(1200);
    const badge = () => p.evaluate(() => { const t = document.querySelector('[data-sample="advice"]'); return t.classList.contains('start-here') && getComputedStyle(t.querySelector('.sc-badge')).display !== 'none'; });
    ok(await badge(), scheme + ': Start here badge on Copilot tile');
    await p.$eval('#welcomeShowcase', e => e.scrollIntoView({ block: 'center' })); await p.waitForTimeout(300);
    await p.screenshot({ path: `${S}/start-here-${scheme}.png` });
    await click('[data-sample="advice"]'); await p.waitForTimeout(2000);
    for (let i = 0; i < 4; i++) { await click('#gNext'); await p.waitForTimeout(600); }
    const last = await p.evaluate(() => ({ close: !$('gClose').hidden, skip: !$('gSkip').hidden, back: !$('gBack').hidden, next: $('gNext').textContent }));
    ok(last.close && !last.skip && !last.back && last.next === 'Start my data set', 'last step: Close + Start my data set ' + JSON.stringify(last));
    if (scheme === 'dark') await p.screenshot({ path: `${S}/guide-last.png` });
    await click('#gClose'); await p.waitForTimeout(400);
    const after = await p.evaluate(() => ({ guide: !$('guide').hidden, demo: !!demo, sheet: !$('sheet').hidden }));
    ok(!after.guide && after.demo && !after.sheet, 'Close leaves you exploring the sample ' + JSON.stringify(after));
    await click('#homeLink'); await p.waitForTimeout(300);
    ok(await badge(), 'badge stays after the guide during the beta (IN_BETA in guide.js)');
    await p.reload(); await p.waitForTimeout(1000); ok(await badge(), 'badge still there after reload during the beta');
    // earlier steps: Skip visible, Close hidden
    await click('[data-sample="advice"]'); await p.waitForTimeout(1500); await click('#guideOpen'); await p.waitForTimeout(400);
    const first = await p.evaluate(() => ({ close: !$('gClose').hidden, skip: !$('gSkip').hidden }));
    ok(!first.close && first.skip, 'step 1: Skip shown, Close hidden');
    await ctx.close();
  }
  ok(!errs.length, 'no errors ' + errs.join('|'));
  console.log(res.join('\n')); await b.close();
})();
