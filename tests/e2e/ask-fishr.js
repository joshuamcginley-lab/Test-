const { chromium, devices } = require('playwright'); const fs = require('fs');
const S = process.argv[2]; const res = []; const ok = (c, m) => res.push((c ? 'PASS ' : 'FAIL ') + m);
(async () => {
  const b = await chromium.launch(); const errs = [];
  const ctx = await b.newContext({ ...devices['iPhone 13'], colorScheme: 'dark' }); const p = await ctx.newPage(); p.on('pageerror', e => errs.push(e.message));
  await p.route('**/api.open-meteo.com/**', r => r.abort());
  const cdp = await ctx.newCDPSession(p); await cdp.send('WebAuthn.enable');
  await cdp.send('WebAuthn.addVirtualAuthenticator', { options: { protocol: 'ctap2', transport: 'internal', hasResidentKey: true, hasUserVerification: true, isUserVerified: true, automaticPresenceSimulation: true } });
  const click = sel => p.$eval(sel, el => el.click());
  const lastAI = () => p.evaluate(() => fetch('/__ai').then(r => r.json()).then(a => a.at(-1)));
  await p.goto((process.argv[3] || 'http://localhost:8790/')); await p.evaluate(() => { localStorage.clear(); sessionStorage.clear(); }); await p.reload(); await p.waitForTimeout(1200);
  // ---- showcase
  await click('[data-sample="advice"]'); await p.waitForTimeout(2000);
  const steps = await p.evaluate(() => $('gStepLbl').textContent); ok(steps === '1 of 5', 'guide now has 5 steps: ' + steps);
  for (let i = 0; i < 3; i++) { await click('#gNext'); await p.waitForTimeout(600); }
  const g4 = await p.evaluate(() => ({ t: $('gTitle').textContent })); ok(g4.t === 'Or just ask', 'guide step 4 is Ask fishr: ' + g4.t);
  await p.screenshot({ path: S + '/ask-guide.png' });
  await click('#gSkip'); await p.waitForTimeout(400);
  let a = await p.evaluate(() => ({ hidden: $('ask').hidden, gate: !$('askGate').hidden, chips: $('askChips').querySelectorAll('.ask-chip').length, foot: $('askFoot').textContent, sub: $('askSub').textContent }));
  ok(!a.hidden && !a.gate && a.chips === 3 && /3 of 3 free questions/.test(a.foot) && /47 trips/.test(a.sub), 'sample ask card ' + JSON.stringify(a));
  await p.$eval('#ask', e => e.scrollIntoView({ block: 'start' })); await p.screenshot({ path: S + '/ask-empty.png' });
  await click('.ask-chip'); await p.waitForTimeout(150);
  ok(await p.evaluate(() => !!document.querySelector('.ask-msg.busy') && $('askInput').disabled), 'thinking dots while waiting');
  await p.waitForTimeout(1200);
  a = await p.evaluate(() => ({ msgs: [...document.querySelectorAll('.ask-msg')].map(m => m.className + ':' + m.textContent.slice(0, 30)), foot: $('askFoot').textContent, chips: $('askChips').hidden }));
  ok(a.msgs.length === 2 && /user:Where should this angler/.test(a.msgs[0]) && /assistant:Fish the Keswick/.test(a.msgs[1]) && /2 of 3/.test(a.foot) && a.chips, 'sample answer shown ' + JSON.stringify(a));
  let req = await lastAI(); ok(req.system.includes('showcase log') && req.messages.at(-1).content.includes('2026-07-15, 18:30, 22°C'), 'sample request used July evening inputs');
  await p.fill('#askInput', 'And what lure?'); await click('#askGo'); await p.waitForTimeout(1300);
  req = await lastAI(); ok(req.messages.length === 3 && req.messages[0].role === 'user' && req.messages[1].role === 'assistant', 'follow-up sends history');
  await p.$eval('#ask', e => e.scrollIntoView({ block: 'start' })); await p.screenshot({ path: S + '/ask-sample.png' });
  // ---- own log, signed out -> gate
  await click('#homeLink'); await p.waitForTimeout(300);
  await p.evaluate(() => { state.sessions.push({ id: 't-own1', date: '2026-09-20', water: 'Tay River', start: '07:00', tempLow: 12, catches: [{ species: 'Brook trout', count: 3, lure: 'Inline spinner' }], updatedAt: new Date().toISOString() }); save(); render(); showTab('advice'); });
  await p.waitForTimeout(400);
  a = await p.evaluate(() => ({ hidden: $('ask').hidden, gate: !$('askGate').hidden, form: !$('askForm').hidden }));
  ok(!a.hidden && a.gate && !a.form, 'own log signed out shows Cloud gate ' + JSON.stringify(a));
  await p.$eval('#ask', e => e.scrollIntoView({ block: 'start' })); await p.screenshot({ path: S + '/ask-gate.png' });
  await click('#askCloud'); await p.waitForTimeout(400);
  ok(await p.evaluate(() => !$('settings').hidden && !$('cloudJoin').hidden), 'Turn on Cloud opens Settings at the join box');
  await click('#cloudCreate'); await p.waitForTimeout(2500); await click('#closeSettings'); await p.waitForTimeout(800);
  a = await p.evaluate(() => ({ gate: !$('askGate').hidden, form: !$('askForm').hidden, foot: $('askFoot').textContent, sub: $('askSub').textContent }));
  ok(!a.gate && a.form && /5 of 5/.test(a.foot) && /your log/.test(a.sub), 'signed in: ask form ' + JSON.stringify(a));
  await click('.ask-chip'); await p.waitForTimeout(1800);
  req = await lastAI(); ok(req.system.includes('Tay River') && req.system.includes('caught 3x Brook trout on Inline spinner') && !req.system.includes('showcase'), 'own question uses own synced log');
  ok(/4 of 5/.test(await p.evaluate(() => $('askFoot').textContent)), 'own allowance counts down');
  // ---- Photo ID: auto on new photo
  await click('#dockLog'); await p.waitForTimeout(400);
  await p.setInputFiles('#catchRows .catch-row .c-photo input[type=file]', S + '/bass.jpg'); await p.waitForTimeout(2000);
  const ph = await p.evaluate(() => { const r = document.querySelector('#catchRows .catch-row'); return { sp: r.querySelector('.c-sp').value, msg: r.querySelector('.photo-msg').textContent, btn: !r.querySelector('.id-photo').hidden }; });
  ok(ph.sp === 'Smallmouth bass' && /high confidence/.test(ph.msg) && /Largemouth bass/.test(ph.msg) && ph.btn, 'photo auto-identified ' + JSON.stringify(ph));
  req = await lastAI(); ok(Array.isArray(req.messages[0].content) && req.messages[0].content[0].type === 'image' && req.output_config.format.type === 'json_schema', 'photo request has image + schema');
  await p.$eval('#catchRows .c-photo', e => e.scrollIntoView({ block: 'center' })); await p.screenshot({ path: S + '/photo-id.png' });
  await click('.id-alt'); ok(await p.evaluate(() => document.querySelector('#catchRows .c-sp').value === 'Largemouth bass'), 'tapping an alternative swaps species');
  // signed out: button explains
  await p.evaluate(() => { forgetAccount(); });
  await click('#catchRows .id-photo'); await p.waitForTimeout(300);
  await p.waitForTimeout(1500);
  ok(/Smallmouth bass/.test(await p.evaluate(() => document.querySelector('#catchRows .photo-msg').textContent)), 'signed-out fishr ID button still identifies (guest allowance)');
  ok(!errs.length, 'no errors ' + errs.join('|'));
  console.log(res.join('\n')); await b.close();
})();
