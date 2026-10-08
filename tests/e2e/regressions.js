// Regression tests for the bug sweep: each check reproduces a bug that was fixed.
const { chromium, devices } = require('playwright'); const fs = require('fs');
const S = process.argv[2], URL0 = process.argv[3]; const res = []; const ok = (c, m) => res.push((c ? 'PASS ' : 'FAIL ') + m);
const wxBody = fs.readFileSync(S + '/wx.json', 'utf8');
async function page(b, opts = {}) {
  const ctx = await b.newContext({ ...devices['iPhone 13'], ...opts }); const p = await ctx.newPage(); p.errs = [];
  p.on('pageerror', e => p.errs.push(e.message));
  await p.route('**/api.open-meteo.com/**', r => r.fulfill({ contentType: 'application/json', body: wxBody }));
  return { ctx, p };
}
const own = [{ id: 't-own-1', date: '2026-06-01', water: 'Tay River', catches: [{ species: 'Brook trout', count: 2 }], updatedAt: '2026-06-01T10:00:00.000Z' }];
async function fresh(p, sessions = own) {
  await p.goto(URL0); await p.evaluate(s => { localStorage.clear(); sessionStorage.clear(); localStorage.setItem('fishr.guide', '1'); localStorage.setItem('firetiger.v1', JSON.stringify({ sessions: s, notes: ['n1'], settings: { season: '2026' } })); }, sessions);
  await p.reload(); await p.waitForTimeout(700);
}
(async () => {
  const b = await chromium.launch();
  { // 1. double-tap Sample must not lose the real log
    const { ctx, p } = await page(b); await fresh(p);
    await p.evaluate(() => { loadSample(); loadSample(); loadSample(); }); await p.waitForTimeout(1500);
    await p.evaluate(() => { state.settings.name = 'x'; save(); exitSample(); });
    const r = await p.evaluate(() => ({ mem: state.sessions.map(s => s.id), stored: JSON.parse(localStorage.getItem('firetiger.v1')).sessions.map(s => s.id) }));
    ok(r.mem.join() === 't-own-1' && r.stored.join() === 't-own-1', 'double-tap Sample keeps the real log ' + JSON.stringify(r));
    // 2. sample finishing loading while the trip form is open stays on the own log
    await p.route('**/api/sample', async r => { await new Promise(x => setTimeout(x, 800)); r.fulfill({ status: 404, body: '' }); });
    await p.evaluate(() => { loadSample('advice'); startNewTrip(); }); await p.waitForTimeout(1600);
    ok(await p.evaluate(() => !demo && !$('sheet').hidden), 'sample does not take over while the trip form is open');
    await p.fill('#fWaterIn', 'Form Lake'); await p.$eval('#saveBtn', e => e.click()); await p.waitForTimeout(600);
    ok(await p.evaluate(() => JSON.parse(localStorage.getItem('firetiger.v1')).sessions.some(s => s.water === 'Form Lake')), 'that trip saves to the real log');
    ok(!p.errs.length, 'no errors (1-2) ' + p.errs.join('|')); await ctx.close();
  }
  { // 3. another tab saves while the sample is on screen
    const { ctx, p } = await page(b); await fresh(p);
    const p2 = await ctx.newPage(); await p2.goto(URL0); await p2.waitForTimeout(600);
    await p.evaluate(() => loadSample()); await p.waitForTimeout(1500);
    await p2.evaluate(() => { state.sessions.push({ id: 't-other-tab', date: '2026-06-02', water: 'Other Tab Lake', catches: [], updatedAt: new Date().toISOString() }); save(); });
    await p.waitForTimeout(500);
    const inDemo = await p.evaluate(() => ({ demo: !!demo, sampleShown: state.sessions.length > 10, real: demo.sessions.map(s => s.id) }));
    ok(inDemo.demo && inDemo.sampleShown && inDemo.real.includes('t-other-tab'), 'other tab\'s trip lands in the set-aside log ' + JSON.stringify(inDemo.real));
    await p.evaluate(() => exitSample()); await p.evaluate(() => save());
    ok(await p.evaluate(() => JSON.parse(localStorage.getItem('firetiger.v1')).sessions.some(s => s.id === 't-other-tab')), 'and survives exiting the sample');
    await ctx.close();
  }
  { // 4. °C -> °F converts Copilot's temperature; 5. Copilot refills after leaving the sample
    const { ctx, p } = await page(b, { geolocation: { latitude: 45.96, longitude: -66.64 }, permissions: ['geolocation'] }); await fresh(p);
    await p.evaluate(() => { $('aTemp').value = '22'; $('openSettings').click(); $('sTemp').value = 'F'; $('sTemp').dispatchEvent(new Event('change')); });
    ok(await p.evaluate(() => Math.round(+$('aTemp').value) === 72), '°C to °F converts the Copilot temperature (22 -> 72)');
    await p.evaluate(() => { closeSheets(); state.settings.temp = 'C'; save(); }); await p.evaluate(() => goLive(true)); await p.waitForTimeout(1200);
    await p.evaluate(() => loadSample('advice')); await p.waitForTimeout(1400); await p.evaluate(() => exitSample()); await p.waitForTimeout(300);
    ok(await p.evaluate(() => $('aTemp').value !== '' && !/Tap/.test($('advice').textContent)), 'Copilot is filled in again after leaving the sample');
    ok(!p.errs.length, 'no errors (4-5) ' + p.errs.join('|')); await ctx.close();
  }
  { // 6. restore: hostile backup is cleaned; a newer copy on the phone wins
    const { ctx, p } = await page(b); await fresh(p, [{ ...own[0], water: 'Newer on phone', updatedAt: '2026-09-01T00:00:00.000Z' }]);
    const backup = { app: 'fishr.ai', sessions: [
      { id: 't-own-1', date: '2026-06-01', water: 'Older in backup', catches: [], updatedAt: '2026-01-01T00:00:00.000Z' },
      { id: 't-evil', date: '2026-06-05', water: 'Evil', lat: '"><img src=x onerror="window.__xss=1">', catches: [{ species: 'Bass', count: 1, lb: '<img src=x onerror="window.__xss=2">', photo: '../../x' }] },
      { id: 't-baddate', date: 20260601, water: 'X' } ] };
    fs.writeFileSync(S + '/hostile-backup.json', JSON.stringify(backup));
    await p.evaluate(() => $('openSettings').click()); await p.setInputFiles('#importFile', S + '/hostile-backup.json'); await p.waitForTimeout(800);
    await p.evaluate(() => { closeSheets(); showTab('log'); showTab('season'); }); await p.waitForTimeout(400);
    const r = await p.evaluate(() => ({ xss: window.__xss || 0, ids: state.sessions.map(s => s.id).sort(), mine: state.sessions.find(s => s.id === 't-own-1').water, evil: state.sessions.find(s => s.id === 't-evil') }));
    ok(r.xss === 0 && r.evil && r.evil.lat === null && r.evil.catches[0].lb === null && r.evil.catches[0].photo === null, 'backup fields are type-checked (no script runs) ' + JSON.stringify(r.evil));
    ok(r.ids.join() === 't-evil,t-own-1', 'backup trip with a bad date is skipped ' + r.ids.join());
    ok(r.mine === 'Newer on phone', 'restore keeps the newer copy on the phone');
    ok(!p.errs.length, 'no errors (6) ' + p.errs.join('|')); await ctx.close();
  }
  { // 7. a failed save can't create a duplicate trip
    const { ctx, p } = await page(b); await fresh(p);
    await p.evaluate(() => { window.__realSet = Storage.prototype.setItem; Storage.prototype.setItem = function () { throw new Error('QuotaExceeded'); }; startNewTrip(); });
    await p.fill('#fWaterIn', 'Full Phone Lake'); await p.$eval('#saveBtn', e => e.click()); await p.waitForTimeout(300); await p.$eval('#saveBtn', e => e.click()); await p.waitForTimeout(300);
    await p.evaluate(() => { Storage.prototype.setItem = window.__realSet; }); await p.$eval('#saveBtn', e => e.click()); await p.waitForTimeout(500);
    ok(await p.evaluate(() => state.sessions.filter(s => s.water === 'Full Phone Lake').length) === 1, 'failed saves then a good save = exactly one trip');
    await ctx.close();
  }
  { // 8. fishr ID: an older photo's late answer can't replace the newer one
    const { ctx, p } = await page(b); await fresh(p, []);
    let n = 0;
    await p.route('**/api/ai/identify', async r => { const mine = ++n; await new Promise(x => setTimeout(x, mine === 1 ? 1500 : 200));
      r.fulfill({ contentType: 'application/json', body: JSON.stringify({ isFish: true, species: mine === 1 ? 'OLD PHOTO FISH' : 'New photo fish', confidence: 'high', alternatives: [], reason: '', left: 2 }) }); });
    await p.setInputFiles('#fidChoice .fid-file', S + '/bass.jpg'); await p.waitForTimeout(300);
    await p.setInputFiles('#fidSheet .fid-file', S + '/portrait.jpg'); await p.waitForTimeout(2200);
    ok(await p.evaluate(() => $('fidName')?.textContent) === 'New photo fish', 'fishr ID shows the newest photo\'s answer');
    // 9. a failed second photo hides "Log this catch"
    await p.unroute('**/api/ai/identify'); await p.route('**/api/ai/identify', r => r.fulfill({ status: 429, contentType: 'application/json', body: '{"error":"That\'s today\'s 3 free fishr IDs."}' }));
    await p.setInputFiles('#fidSheet .fid-file', S + '/bass.jpg'); await p.waitForTimeout(1200);
    ok(await p.evaluate(() => $('fidLog').hidden), 'a failed photo hides "Log this catch"');
    ok(!p.errs.length, 'no errors (8-9) ' + p.errs.join('|')); await ctx.close();
  }
  { // 10. offline Copilot doesn't hammer the allowance check
    const { ctx, p } = await page(b); let calls = 0;
    await p.route('**/api/ai/ask?**', r => { calls++; r.abort(); });
    await fresh(p, []); await p.evaluate(() => loadSample('advice')); await p.waitForTimeout(3000);
    ok(calls <= 3, `allowance check doesn't loop when it fails (${calls} calls in 3 s)`);
    await ctx.close();
  }
  { // 11. long toasts fit on a small phone
    const { ctx, p } = await page(b, { ...devices['iPhone SE'] }); await fresh(p, []);
    await p.evaluate(() => toast("Couldn't save. Your phone may be out of storage.")); await p.waitForTimeout(100);
    const r = await p.$eval('#toast', e => { const b = e.getBoundingClientRect(); return { l: Math.round(b.left), r: Math.round(b.right) }; });
    ok(r.l >= 0 && r.r <= 320, 'long toast stays on screen ' + JSON.stringify(r));
    await ctx.close();
  }
  console.log(res.join('\n')); await b.close();
})().catch(e => { console.log(res.join('\n')); console.error('ERR', e.message.split('\n')[0]); process.exit(1); });
