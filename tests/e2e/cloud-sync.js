// fishr Cloud end to end: real Functions (devserver), Chromium virtual passkeys, two "devices".
const { chromium, devices } = require('playwright');
const S = process.argv[2], URL0 = (process.argv[3] || 'http://localhost:8790/');
const res = []; const ok = (c, m) => res.push((c ? 'PASS ' : 'FAIL ') + m);
const stats = async p => p.evaluate(() => fetch('/__stats').then(r => r.json()));
async function device(b, name) {
  const ctx = await b.newContext({ ...devices['iPhone 13'], colorScheme: 'dark' }); const p = await ctx.newPage();
  p.errs = []; p.on('pageerror', e => p.errs.push(name + ': ' + e.message));
  await p.route('**/api.open-meteo.com/**', r => r.abort()); await p.route('**/archive-api.open-meteo.com/**', r => r.abort());
  const cdp = await ctx.newCDPSession(p); await cdp.send('WebAuthn.enable');
  const { authenticatorId } = await cdp.send('WebAuthn.addVirtualAuthenticator', { options: { protocol: 'ctap2', transport: 'internal', hasResidentKey: true, hasUserVerification: true, isUserVerified: true, automaticPresenceSimulation: true } });
  p.cdp = cdp; p.auth = authenticatorId; return p;
}
const click = (p, sel) => p.$eval(sel, el => el.click());
const openSettings = async p => { await click(p, '#openSettings'); await p.waitForTimeout(400); };
(async () => {
  const b = await chromium.launch();
  // ---------- device A: has a log on the phone already ----------
  const A = await device(b, 'A');
  await A.goto(URL0); await A.evaluate(() => { localStorage.clear(); sessionStorage.clear(); localStorage.setItem('firetiger.v1', JSON.stringify({ sessions: [
    { id: 't-a1', date: '2026-06-01', water: 'Keswick River', spot: 'Bridge', catches: [{ species: 'Smallmouth Bass', count: 2, lb: 2.1, photo: 'p-test1-abc' }], method: 'Spin', updatedAt: '2026-06-01T20:00:00.000Z' },
    { id: 't-a2', date: '2026-06-05', water: 'Nashwaak River', catches: [], method: 'Fly' } ], notes: ['Frogs at dusk'], settings: { name: 'Josh', units: 'imperial', temp: 'C', season: '2026', maps: 'auto' } })); });
  await A.reload(); await A.waitForTimeout(1200);
  const jpg = require('fs').readFileSync(S + '/bass.jpg').toString('base64');
  await A.evaluate(async b64 => { const blob = await (await fetch('data:image/jpeg;base64,' + b64)).blob(); await photoPut('p-test1-abc', blob); }, jpg);
  await openSettings(A);
  ok(await A.$eval('#cloudLocal', e => !e.hidden), 'A local by default');
  ok(await A.$eval('#segStore [data-v=local]', e => e.getAttribute('aria-pressed') === 'true'), 'switch shows On this phone');
  await click(A, '#segStore [data-v=cloud]'); await A.waitForTimeout(200);
  ok(await A.$eval('#cloudJoin', e => !e.hidden), 'Cloud shows join box');
  await A.$eval('#cloudGroup', e => e.scrollIntoView()); await A.screenshot({ path: S + '/cloud-join.png' });
  await click(A, '#cloudCreate'); await A.waitForTimeout(2500);
  let st = await stats(A);
  ok(st.users === 1 && st.trips === 2 && st.photos === 1, 'A created account and uploaded log ' + JSON.stringify(st));
  ok(await A.$eval('#cloudOnBox', e => !e.hidden), 'A on box visible');
  const line = await A.$eval('#cloudStatus', e => e.textContent); ok(/Synced just now · 2 trips/.test(line), 'status: ' + line);
  ok(/iPhone · Safari/.test(await A.$eval('#cloudKeys', e => e.textContent)), 'passkey label shown');
  ok(/Cloud is on/.test(await A.$eval('#cloudMsg', e => e.textContent)), 'success msg');
  await A.$eval('#cloudGroup', e => e.scrollIntoView()); await A.screenshot({ path: S + '/cloud-on.png' });
  ok(await A.evaluate(() => document.cookie.includes('fishr_in=1') && !document.cookie.includes('fishr_s')), 'session cookie hidden from script');
  // new trip on A syncs automatically
  await click(A, '#closeSettings');
  await A.evaluate(() => { state.sessions.push({ id: 't-a3', date: '2026-07-01', water: 'French Lake', catches: [{ species: 'Chain Pickerel', count: 1 }], updatedAt: new Date().toISOString() }); save(); render(); });
  await A.waitForTimeout(2500); st = await stats(A); ok(st.trips === 3, 'A auto-synced new trip ' + st.trips);
  // a change that doesn't touch updatedAt (like placing a water on the map) still syncs
  await A.evaluate(() => { const s = state.sessions.find(x => x.id === 't-a2'); s.lat = 46.1; s.lon = -66.6; save(); });
  await A.waitForTimeout(2500);

  // ---------- device B: new phone, same synced passkey ----------
  const B = await device(b, 'B');
  const { credentials } = await A.cdp.send('WebAuthn.getCredentials', { authenticatorId: A.auth });
  ok(credentials.length === 1 && credentials[0].isResidentCredential, 'A has a discoverable passkey');
  await B.cdp.send('WebAuthn.addCredential', { authenticatorId: B.auth, credential: credentials[0] });
  await B.goto(URL0); await B.evaluate(() => { localStorage.clear(); sessionStorage.clear(); }); await B.reload(); await B.waitForTimeout(1800);
  ok(await B.evaluate(() => !demo && !$('welcome').hidden), 'B fresh visit shows welcome');
  await openSettings(B); await click(B, '#segStore [data-v=cloud]'); await click(B, '#cloudSignIn'); await B.waitForTimeout(2500);
  const bState = await B.evaluate(() => ({ demo: !!demo, n: state.sessions.length, ids: state.sessions.map(s => s.id).sort(), notes: state.notes, name: state.settings.name, a2: state.sessions.find(s => s.id === 't-a2') }));
  ok(!bState.demo && bState.n === 3 && bState.notes[0] === 'Frogs at dusk' && bState.name === 'Josh', 'B signed in and pulled log ' + JSON.stringify(bState).slice(0, 160));
  ok(bState.a2 && bState.a2.lat === 46.1, 'map-placed location synced');
  // photo comes from the cloud
  await click(B, '#closeSettings'); await B.evaluate(() => showTab('log')); await B.waitForTimeout(1200);
  const imgOk = await B.evaluate(() => { const im = document.querySelector('img[data-photo="p-test1-abc"]'); return !!(im && im.src && im.src.startsWith('blob:')); });
  ok(imgOk, 'B shows photo downloaded from cloud');
  await B.screenshot({ path: S + '/cloud-b-log.png' });
  // B deletes a trip and edits notes -> A gets both
  await B.evaluate(() => { state.sessions = state.sessions.filter(s => s.id !== 't-a3'); state.notes = ['Frogs at dusk', 'Try the bridge pool']; save(); render(); });
  await B.waitForTimeout(2500);
  await A.evaluate(() => syncNow()); await A.waitForTimeout(800);
  const aState = await A.evaluate(() => ({ ids: state.sessions.map(s => s.id).sort(), notes: state.notes }));
  ok(aState.ids.join() === 't-a1,t-a2' && aState.notes.length === 2, 'A got delete + notes from B ' + JSON.stringify(aState));
  // ---------- sign out on B, keep trips ----------
  await openSettings(B); ok(await B.$eval('#cloudSignOut', e => !e.hidden), 'sign out button visible'); await click(B, '#cloudSignOut'); await B.waitForTimeout(200); ok(await B.$eval('#cloudSignOut', e => e.hidden), 'sign out button hides while choosing');
  ok(await B.$eval('#cloudLeave', e => !e.hidden), 'B shows sign-out choice');
  await B.$eval('#cloudGroup', e => e.scrollIntoView()); await B.screenshot({ path: S + '/cloud-leave.png' });
  await click(B, '#cloudKeep'); await B.waitForTimeout(800);
  const bOut = await B.evaluate(() => ({ on: cloudOn(), n: state.sessions.length, cookie: document.cookie }));
  ok(!bOut.on && bOut.n === 2 && !bOut.cookie.includes('fishr_in=1'), 'B signed out, kept trips ' + JSON.stringify(bOut));
  ok(await B.$eval('#cloudLocal', e => !e.hidden), 'B back to local view');
  // ---------- A deletes the account ----------
  await openSettings(A); await click(A, '#cloudDelete'); await click(A, '#cloudDeleteYes'); await A.waitForTimeout(1200);
  st = await stats(A); ok(st.users === 0 && st.trips === 0 && st.photos === 0, 'account deleted server side ' + JSON.stringify(st));
  const aAfter = await A.evaluate(() => ({ on: cloudOn(), n: state.sessions.length }));
  ok(!aAfter.on && aAfter.n === 2, 'A keeps trips locally ' + JSON.stringify(aAfter));
  // ---------- cancelling the Face ID prompt ----------
  await A.cdp.send('WebAuthn.setUserVerified', { authenticatorId: A.auth, isUserVerified: false }).catch(() => {});
  await A.cdp.send('WebAuthn.setAutomaticPresenceSimulation', { authenticatorId: A.auth, enabled: false }).catch(() => {});
  await click(A, '#segStore [data-v=cloud]');
  await A.evaluate(() => { const orig = navigator.credentials.create.bind(navigator.credentials); navigator.credentials.create = () => Promise.reject(new DOMException('cancelled', 'NotAllowedError')); });
  await click(A, '#cloudCreate'); await A.waitForTimeout(800);
  ok(/Cancelled/.test(await A.$eval('#cloudMsg', e => e.textContent)), 'cancel message');
  st = await stats(A); ok(st.users === 0, 'no account on cancel');
  const errs = [...A.errs, ...B.errs]; ok(!errs.length, 'no page errors ' + errs.join(' | '));
  console.log(res.join('\n'));
  await b.close();
})().catch(e => { console.log(res.join('\n')); console.error(e); process.exit(1); });
