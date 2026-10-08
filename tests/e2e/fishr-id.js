const { chromium, devices } = require('playwright'); const fs = require('fs');
const S = process.argv[2], URL0 = process.argv[3] || (process.argv[3] || 'http://localhost:8790/'); const res = []; const ok = (c, m) => res.push((c ? 'PASS ' : 'FAIL ') + m);
(async () => {
  const b = await chromium.launch(); const errs = [];
  for (const scheme of ['light', 'dark']) {
    const ctx = await b.newContext({ ...devices['iPhone 13'], colorScheme: scheme }); const p = await ctx.newPage(); p.on('pageerror', e => errs.push(e.message));
    await p.route('**/api.open-meteo.com/**', r => r.abort());
    const click = sel => p.$eval(sel, el => el.click());
    await p.goto(URL0); await p.evaluate(() => { localStorage.clear(); sessionStorage.clear(); }); await p.reload(); await p.waitForTimeout(1300);
    ok(await p.evaluate(() => !$('fidChoice').hidden && $('fidChoice').textContent.includes('What did you catch?')), scheme + ': welcome has fishr ID entry');
    if (scheme === 'dark') { await p.$eval('#fidChoice', e => e.scrollIntoView({ block: 'center' })); await p.screenshot({ path: S + '/fid-welcome.png' }); }
    // from the welcome screen, no account
    { const box = await p.$eval('#fidChoice', e => { e.scrollIntoView({ block: 'center' }); const r = e.getBoundingClientRect(); return { x: r.x + r.width / 2, y: r.y + r.height / 2 }; });
      const [fc] = await Promise.all([p.waitForEvent('filechooser', { timeout: 5000 }), p.touchscreen.tap(box.x, box.y)]);
      await fc.setFiles(S + '/bass.jpg'); } await p.waitForTimeout(200);
    ok(await p.evaluate(() => !$('fidSheet').hidden && /Identifying/.test($('fidResult').textContent)), 'sheet opens and identifies');
    await p.waitForTimeout(1300);
    let r = await p.evaluate(() => ({ name: $('fidName')?.textContent, log: !$('fidLog').hidden, foot: $('fidFoot').textContent, img: !!$('fidImg').src, alts: document.querySelectorAll('.fid-alt').length }));
    ok(r.name === 'Smallmouth bass' && r.log && r.img && r.alts === 2 && /free fishr IDs? left today/.test(r.foot), 'result ' + JSON.stringify(r));
    await p.screenshot({ path: `${S}/fid-sheet-${scheme}.png` });
    if (scheme === 'dark') {
      await click('.fid-alt'); ok(await p.evaluate(() => $('fidName').textContent === 'Largemouth bass'), 'tap alternative swaps the name');
      await click('.fid-alt'); // swap back
      await click('#fidLog'); await p.waitForTimeout(500);
      r = await p.evaluate(() => { const row = document.querySelector('#catchRows .catch-row'); return { sheet: !$('sheet').hidden, fid: !$('fidSheet').hidden, sp: row.querySelector('.c-sp').value, thumb: !row.querySelector('.c-photo .thumb').hidden, msg: row.querySelector('.photo-msg').textContent }; });
      ok(r.sheet && !r.fid && r.sp === 'Smallmouth bass' && r.thumb && /Identified by fishr ID/.test(r.msg), 'Log this catch fills the log form ' + JSON.stringify(r));
      await p.screenshot({ path: S + '/fid-logform.png' });
      await p.fill('#fWaterIn', 'Keswick River'); await click('#saveBtn'); await p.waitForTimeout(800);
      r = await p.evaluate(() => ({ n: state.sessions.length, sp: state.sessions[0]?.catches[0]?.species, photo: !!state.sessions[0]?.catches[0]?.photo }));
      ok(r.n === 1 && r.sp === 'Smallmouth bass' && r.photo, 'saved trip keeps species and photo ' + JSON.stringify(r));
      // Copilot card on own log
      await p.evaluate(() => { closeSheets(); showTab('advice'); }); await p.waitForTimeout(500);
      ok(await p.evaluate(() => !document.querySelector('.fid-top').hidden && document.querySelector('.fid-top .fid-file') !== null), 'top bar has fishr ID camera');
      
      // guest allowance runs out (3 per visitor): 1 used, use 2 more, then blocked
      await p.waitForTimeout(1800); // let the "fish logged" celebration finish
      // real tap on the top-bar camera
      { const box = await p.$eval('.fid-top', e => { e.scrollIntoView({ block: 'center' }); const r = e.getBoundingClientRect(); return { x: r.x + r.width / 2, y: r.y + r.height / 2 }; });
        const [fc] = await Promise.all([p.waitForEvent('filechooser', { timeout: 5000 }), p.touchscreen.tap(box.x, box.y)]);
        await fc.setFiles(S + '/bass.jpg'); await p.waitForTimeout(1300); }
      ok(await p.evaluate(() => !$('fidSheet').hidden), 'tapping the top-bar camera opens the picker and the sheet');
      await p.setInputFiles('#fidSheet .fid-file', S + '/bass.jpg'); await p.waitForTimeout(1300);
      await p.setInputFiles('#fidSheet .fid-file', S + '/bass.jpg'); await p.waitForTimeout(1300);
      r = await p.evaluate(() => ({ err: document.querySelector('.fid-err')?.textContent, log: !$('fidLog').hidden }));
      ok(/free fishr IDs/.test(r.err || '') && !r.log, 'guest limit message ' + JSON.stringify(r));
      await click('#fidClose'); ok(await p.evaluate(() => $('fidSheet').hidden && $('scrim').hidden), 'Close closes');
    }
    await ctx.close();
  }
  ok(!errs.length, 'no errors ' + errs.join('|'));
  console.log(res.join('\n')); await b.close();
})().catch(e => { console.log(res.join('\n')); console.error('ERR', e.message.split('\n')[0]); process.exit(1); });
