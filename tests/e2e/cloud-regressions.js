// Regression tests for Cloud sync bugs found in the sweep.
const { chromium, devices } = require('playwright'); const fs = require('fs');
const S = process.argv[2], URL0 = process.argv[3]; const res = []; const ok = (c, m) => res.push((c ? 'PASS ' : 'FAIL ') + m);
const trips = p => p.evaluate(() => fetch('/__trips').then(r => r.json()));
async function device(b) {
  const ctx = await b.newContext({ ...devices['iPhone 13'] }); const p = await ctx.newPage(); p.errs = []; p.on('pageerror', e => p.errs.push(e.message));
  await p.route('**/api.open-meteo.com/**', r => r.abort());
  const cdp = await ctx.newCDPSession(p); await cdp.send('WebAuthn.enable');
  const { authenticatorId } = await cdp.send('WebAuthn.addVirtualAuthenticator', { options: { protocol: 'ctap2', transport: 'internal', hasResidentKey: true, hasUserVerification: true, isUserVerified: true, automaticPresenceSimulation: true } });
  p.cdp = cdp; p.auth = authenticatorId; return p;
}
async function start(p, sessions) {
  await p.goto(URL0); await p.evaluate(s => { localStorage.clear(); sessionStorage.clear(); localStorage.setItem('fishr.guide', '1'); localStorage.setItem('firetiger.v1', JSON.stringify({ sessions: s, notes: [], settings: { season: '2026' } })); }, sessions);
  await p.reload(); await p.waitForTimeout(700);
}
const signUp = async p => { await p.evaluate(() => { $('openSettings').click(); }); await p.$eval('#segStore [data-v=cloud]', e => e.click()); await p.$eval('#cloudCreate', e => e.click()); await p.waitForTimeout(2500); await p.evaluate(() => closeSheets()); };
const signIn = async p => { await p.evaluate(() => { $('openSettings').click(); }); await p.$eval('#segStore [data-v=cloud]', e => e.click()); await p.$eval('#cloudSignIn', e => e.click()); await p.waitForTimeout(2500); await p.evaluate(() => closeSheets()); };
const T = (id, water, extra = {}) => ({ id, date: '2026-07-0' + id.slice(-1), water, catches: [], ...extra });
(async () => {
  const b = await chromium.launch();
  // 1. Opening the sample while a sync is uploading photos must not upload the sample or delete the real log.
  { const A = await device(b);
    await start(A, [T('a-1', 'Real One', { updatedAt: '2026-07-01T00:00:00.000Z' }), T('a-2', 'Real Two', { updatedAt: '2026-07-02T00:00:00.000Z', catches: [{ species: 'Bass', count: 1, photo: 'p-slow-abc' }] })]);
    await A.evaluate(async b64 => { await photoPut('p-slow-abc', await (await fetch('data:image/jpeg;base64,' + b64)).blob()); }, fs.readFileSync(S + '/bass.jpg').toString('base64'));
    await signUp(A); // first sync done (photo uploaded)
    // second sync with a slow photo upload, and the sample opened mid-way
    await A.evaluate(async b64 => { await photoPut('p-slow-def', await (await fetch('data:image/jpeg;base64,' + b64)).blob()); state.sessions[0].catches.push({ species: 'Pike', count: 1, photo: 'p-slow-def' }); state.sessions[0].updatedAt = new Date().toISOString(); }, fs.readFileSync(S + '/bass.jpg').toString('base64'));
    await A.route('**/api/photo/p-slow-def', async r => { await new Promise(x => setTimeout(x, 1500)); r.continue(); });
    await A.evaluate(() => { syncNow(); setTimeout(() => loadSample(), 200); }); await A.waitForTimeout(4000);
    const t = await trips(A);
    ok(t.filter(x => !x.deleted).length === 2 && !t.some(x => x.deleted) && !t.some(x => x.id.startsWith('s-')), 'sample opened mid-sync: server still has exactly the 2 real trips ' + JSON.stringify(t.map(x => x.id + (x.deleted ? '(deleted)' : ''))));
    await A.evaluate(() => exitSample());
    ok(await A.evaluate(() => state.sessions.map(s => s.id).sort().join()) === 'a-1,a-2', 'real log intact on the phone');
    // 2. A trip deleted while signed out stays deleted after signing back in.
    const creds = (await A.cdp.send('WebAuthn.getCredentials', { authenticatorId: A.auth })).credentials;
    await A.evaluate(() => { $('openSettings').click(); }); await A.$eval('#cloudSignOut', e => e.click()); await A.$eval('#cloudKeep', e => e.click()); await A.waitForTimeout(800); await A.evaluate(() => closeSheets());
    await A.evaluate(() => { state.sessions = state.sessions.filter(s => s.id !== 'a-1'); save(); });
    await signIn(A); await A.waitForTimeout(500);
    const t2 = await trips(A);
    ok(t2.find(x => x.id === 'a-1')?.deleted === 1 && await A.evaluate(() => !state.sessions.some(s => s.id === 'a-1')), 'trip deleted while signed out stays deleted ' + JSON.stringify(t2.map(x => x.id + (x.deleted ? '(deleted)' : ''))));
    // 3. A second phone with an old copy (no timestamp, e.g. from an old backup) doesn't overwrite the newer edit.
    await A.evaluate(() => { const s = state.sessions.find(s => s.id === 'a-2'); s.water = 'Edited on phone A'; s.updatedAt = new Date().toISOString(); save(); }); await A.waitForTimeout(2500);
    const latest = (await A.cdp.send('WebAuthn.getCredentials', { authenticatorId: A.auth })).credentials; // after A's latest sign-in
    const B = await device(b); await B.cdp.send('WebAuthn.addCredential', { authenticatorId: B.auth, credential: latest[0] });
    await start(B, [T('a-2', 'Old copy from a backup')]); // no updatedAt
    await signIn(B); await B.waitForTimeout(500);
    const t3 = await trips(B), bWater = await B.evaluate(() => state.sessions.find(s => s.id === 'a-2')?.water);
    ok(t3.find(x => x.id === 'a-2')?.water === 'Edited on phone A' && bWater === 'Edited on phone A', `old copy loses to the newer edit (server: ${t3.find(x => x.id === 'a-2')?.water}, phone B: ${bWater})`);
    ok(!A.errs.length && !B.errs.length, 'no page errors ' + [...A.errs, ...B.errs].join('|'));
  }
  console.log(res.join('\n')); await b.close();
})().catch(e => { console.log(res.join('\n')); console.error('ERR', e.message.split('\n')[0]); process.exit(1); });
