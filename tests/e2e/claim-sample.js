// Admin → fishr Cloud accounts → "Move showcase season here": the showcase trips and notes land in that account
// and sync down to the angler's phone as their own (kept after a reload; the showcase still works for visitors).
const { chromium, devices } = require('playwright');
const S = process.argv[2], URL0 = process.argv[3]; const res = []; const ok = (c, m) => res.push((c ? 'PASS ' : 'FAIL ') + m);
(async () => {
  const b = await chromium.launch(), errs = [];
  const ctx = await b.newContext({ ...devices['iPhone 13'], locale: 'en-CA', timezoneId: 'America/Moncton' });
  const p = await ctx.newPage(); p.on('pageerror', e => errs.push(e.message));
  await p.route(/open-meteo|\/api\/water/, r => r.abort());
  const cdp = await ctx.newCDPSession(p); await cdp.send('WebAuthn.enable');
  await cdp.send('WebAuthn.addVirtualAuthenticator', { options: { protocol: 'ctap2', transport: 'internal', hasResidentKey: true, hasUserVerification: true, isUserVerified: true, automaticPresenceSimulation: true } });
  await p.goto(URL0);
  await p.evaluate(() => { localStorage.clear(); localStorage.setItem('fishr.guide', '1'); localStorage.setItem('fishr.keepSafe', String(Date.now()));
    localStorage.setItem('firetiger.v1', JSON.stringify({ sessions: [{ id: 't-own', date: '2026-10-01', water: 'Keswick River', catches: [], updatedAt: '2026-10-01T12:00:00.000Z' }], notes: ['My own note'], settings: { season: '2026', temp: 'C' } })); });
  await p.reload(); await p.waitForTimeout(700);
  await p.evaluate(() => { $('openSettings').click(); }); await p.$eval('#segStore [data-v=cloud]', e => e.click()); await p.$eval('#cloudCreate', e => e.click()); await p.waitForTimeout(2500); await p.evaluate(() => closeSheets());
  const sampleN = await p.evaluate(() => fetch('sample.json').then(r => r.json()).then(d => d.length));

  // Admin page, same browser: the account signed in here is marked and listed first.
  const ap = await ctx.newPage(); ap.on('pageerror', e => errs.push(e.message));
  await ap.goto(URL0 + 'admin.html'); await ap.fill('#key', 'test-admin'); await ap.$eval('#keyForm button[type=submit]', e => e.click()); await ap.waitForTimeout(1200);
  const first = await ap.evaluate(() => document.querySelector('#accts tr:nth-child(2)')?.innerText || '');
  ok(/Signed in on this browser/.test(first) && /\b1\b/.test(first) && /Move showcase season here/.test(first), 'admin lists the account signed in here first, with 1 trip: ' + first.replace(/\s+/g, ' '));
  let asked = '';
  ap.once('dialog', d => { asked = d.message(); d.accept(); });
  await ap.$eval('[data-claim="0"]', e => e.click()); await ap.waitForTimeout(1500);
  const msg = await ap.evaluate(() => $('acctMsg').textContent);
  ok(/Move the showcase season into the account with/.test(asked) && new RegExp(`^Done: ${sampleN} trips added, 6 notes\\. ${sampleN + 1} trips in the account now\\.`).test(msg), 'confirm, then moved: ' + msg);
  ok(new RegExp(`\\b${sampleN + 1}\\b`).test(await ap.evaluate(() => document.querySelector('#accts tr:nth-child(2)').innerText)), 'list refreshed with the new trip count');
  await ap.screenshot({ path: S + '/claim-admin.png', fullPage: true });
  // Again: nothing doubles.
  ap.once('dialog', d => d.accept()); await ap.$eval('[data-claim="0"]', e => e.click()); await ap.waitForTimeout(1500);
  ok(/^Done: 0 trips added \(\d+ already there\)\./.test(await ap.evaluate(() => $('acctMsg').textContent)), 'a second tap adds nothing');
  await ap.close();

  // The phone syncs: the season is now its own log, with the notes, and stays that way after a reload.
  await p.evaluate(() => syncNow()); await p.waitForTimeout(2500);
  const mine = () => p.evaluate(() => ({ n: state.sessions.length, sample: state.sessions.filter(s => s.sample).length, own: state.sessions.some(s => s.id === 't-own'), notes: state.notes.slice(), demo: !!demo }));
  let m = await mine();
  ok(m.n === sampleN + 1 && !m.sample && m.own && !m.demo, `phone: ${m.n} trips in its own log (not the showcase view) ` + JSON.stringify({ ...m, notes: m.notes.length }));
  ok(m.notes[0] === 'My own note' && m.notes.length === 7, 'phone: notes are his own plus the season\'s ' + m.notes.length);
  await p.reload(); await p.waitForTimeout(1200);
  m = await mine();
  ok(m.n === sampleN + 1 && m.notes.length === 7, 'after a reload: still all there (notes too) ' + JSON.stringify({ n: m.n, notes: m.notes.length }));
  // The Guide and Stats work from the real log now.
  ok(await p.evaluate(() => state.sessions.filter(s => s.catches?.length).length > 10), 'log has the season\'s catches');
  // The showcase still opens (for visitors), and leaving it brings his log back.
  await p.evaluate(() => loadSample()); await p.waitForTimeout(1500);
  const inDemo = await p.evaluate(() => !!demo && state.sessions.every(s => s.sample));
  await p.evaluate(() => exitSample()); await p.waitForTimeout(500);
  m = await mine();
  ok(inDemo && !m.demo && m.n === sampleN + 1, 'showcase still opens, and closing it returns to his log');
  await p.waitForTimeout(2500);
  const server = await p.evaluate(() => fetch('/__trips').then(r => r.json()));
  ok(server.filter(t => !t.deleted).length === sampleN + 1 && !server.some(t => t.deleted), 'server: no trips lost or doubled after all that');
  ok(!errs.length, 'no page errors ' + errs.join(' | '));
  console.log(res.join('\n')); await b.close();
})().catch(e => { console.log(res.join('\n')); console.error('ERR', e.message.split('\n')[0]); process.exit(1); });
