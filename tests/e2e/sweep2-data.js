// Second bug sweep, data safety: notes and settings from two devices merge instead of one wiping the other,
// a late weather lookup can't land in a different trip, signing out offline sticks, and notes that are too long
// don't stop trips syncing.
const { chromium } = require('playwright');
const S = process.argv[2], URL0 = process.argv[3] || 'http://localhost:8790/'; const res = []; const ok = (c, m) => res.push((c ? 'PASS ' : 'FAIL ') + m);
const click = (p, sel) => p.$eval(sel, el => el.click());
const errs = [];
function tripWeather(url, t = 31) {
  const u = new URL(url), a = u.searchParams.get('start_date'), b = u.searchParams.get('end_date'), time = [];
  for (let d = new Date(a + 'T00:00:00Z'); d <= new Date(b + 'T00:00:00Z'); d = new Date(+d + 864e5)) for (let h = 0; h < 24; h++) time.push(d.toISOString().slice(0, 10) + 'T' + String(h).padStart(2, '0') + ':00');
  const n = time.length, fill = v => Array(n).fill(v);
  return JSON.stringify({ hourly: { time, temperature_2m: fill(t), weather_code: fill(0), pressure_msl: fill(1010), wind_speed_10m: fill(25), wind_direction_10m: fill(90), precipitation: fill(0) } });
}
async function device(b, { weather = 'abort' } = {}) {
  const ctx = await b.newContext(); const p = await ctx.newPage(); p.ctx = ctx;
  p.on('pageerror', e => errs.push(e.message));
  if (weather === 'abort') await p.route('**/*open-meteo.com/**', r => r.abort());
  await p.route('**/api/water**', r => r.fulfill({ status: 404, body: '{}' }));
  const cdp = await ctx.newCDPSession(p); await cdp.send('WebAuthn.enable');
  const { authenticatorId } = await cdp.send('WebAuthn.addVirtualAuthenticator', { options: { protocol: 'ctap2', transport: 'internal', hasResidentKey: true, hasUserVerification: true, isUserVerified: true, automaticPresenceSimulation: true } });
  p.cdp = cdp; p.auth = authenticatorId; return p;
}
const serverMeta = p => p.evaluate(() => api('/api/sync', { since: 1e9, trips: [] }).then(r => r.meta && r.meta.data));

(async () => {
  const b = await chromium.launch();

  // 1. Two devices: A adds a note while B (offline) changes units. Both changes survive.
  const A = await device(b);
  await A.goto(URL0); await A.evaluate(() => { localStorage.clear(); localStorage.setItem('fishr.guide', '1'); localStorage.setItem('firetiger.v1', JSON.stringify({ sessions: [
    { id: 't-a1', date: '2026-06-01', water: 'Keswick River', catches: [], method: 'Spin', updatedAt: '2026-06-01T20:00:00.000Z' }], notes: ['Frogs at dusk'], settings: { name: 'Josh', units: 'imperial', temp: 'C', season: '2026', maps: 'auto' } })); });
  await A.reload(); await A.waitForTimeout(800);
  await click(A, '#openSettings'); await A.waitForTimeout(300); await click(A, '#segStore [data-v=cloud]'); await click(A, '#cloudCreate'); await A.waitForTimeout(2500); await click(A, '#closeSettings');
  const B = await device(b);
  const { credentials } = await A.cdp.send('WebAuthn.getCredentials', { authenticatorId: A.auth });
  await B.cdp.send('WebAuthn.addCredential', { authenticatorId: B.auth, credential: credentials[0] });
  await B.goto(URL0); await B.evaluate(() => { localStorage.clear(); localStorage.setItem('fishr.guide', '1'); }); await B.reload(); await B.waitForTimeout(1000);
  await click(B, '#welcomeSignIn'); await B.waitForTimeout(2500);
  ok(await B.evaluate(() => state.notes.join('|')) === 'Frogs at dusk', 'B signed in and has the notes');
  await B.ctx.setOffline(true);
  await A.evaluate(() => { state.notes = [...state.notes, 'Chartreuse in stained water']; save(); }); await A.waitForTimeout(2500);
  await B.evaluate(() => { $('sUnits').value = 'metric'; $('sUnits').dispatchEvent(new Event('change')); }); await B.waitForTimeout(400);
  await B.ctx.setOffline(false); await B.evaluate(() => dispatchEvent(new Event('online'))); await B.waitForTimeout(3500);
  let m = await serverMeta(A);
  ok(m.notes.includes('Chartreuse in stained water') && m.notes.includes('Frogs at dusk'), "B's settings change doesn't wipe A's new note " + JSON.stringify(m.notes));
  ok(m.settings.units === 'metric', "and B's units change is kept " + m.settings.units);
  await A.evaluate(() => syncNow()); await A.waitForTimeout(1500);
  const a = await A.evaluate(() => ({ notes: state.notes, units: state.settings.units })), bb = await B.evaluate(() => ({ notes: state.notes, units: state.settings.units }));
  ok(a.notes.length === 2 && bb.notes.length === 2 && a.units === 'metric' && bb.units === 'metric', 'both devices end up with both changes ' + JSON.stringify({ a, bb }));

  // 2. Both devices edit notes while apart: nothing is lost.
  await B.ctx.setOffline(true);
  await A.evaluate(() => { state.notes = [...state.notes, 'From A']; save(); }); await A.waitForTimeout(2500);
  await B.evaluate(() => { state.notes = [...state.notes, 'From B']; save(); });
  await B.ctx.setOffline(false); await B.evaluate(() => dispatchEvent(new Event('online'))); await B.waitForTimeout(3500);
  m = await serverMeta(A);
  ok(m.notes.includes('From A') && m.notes.includes('From B'), 'notes added on both devices are both kept ' + JSON.stringify(m.notes));

  // 3. Notes over the limit: trips still sync, and the reason is shown.
  await A.evaluate(() => { state.notes = Array.from({ length: 250 }, (_, i) => 'line ' + i); state.sessions.push({ id: 't-a2', date: '2026-06-02', water: 'Nashwaak', catches: [], method: 'Spin', updatedAt: new Date().toISOString() }); save(); });
  await A.waitForTimeout(3000);
  const ids = await A.evaluate(() => api('/api/sync', { since: 0, trips: [] }).then(r => r.trips.map(t => t.id)));
  ok(ids.includes('t-a2'), 'with 250 note lines, the new trip still reaches the account ' + JSON.stringify(ids));
  await click(A, '#openSettings'); await A.waitForTimeout(500);
  ok(/too long to sync \(200 lines at most\)/.test(await A.evaluate(() => $('cloudStatus').textContent + $('cloudGroup').textContent)), 'Settings says the notes are too long');
  await click(A, '#closeSettings');
  m = await serverMeta(A);
  ok(m.notes.length < 250, 'the server kept the last notes that fit, not a cut-off list');

  // 4. Sign out while offline, removing trips from this phone: it stays signed out after reloading online.
  await B.ctx.setOffline(true);
  await click(B, '#openSettings'); await B.waitForTimeout(300); await click(B, '#cloudSignOut'); await B.waitForTimeout(200); await click(B, '#cloudRemove'); await B.waitForTimeout(800);
  ok(await B.evaluate(() => !cloudOn() && state.sessions.length === 0 && !/fishr_in=1/.test(document.cookie)), 'offline sign-out: signed out here, trips removed, sign-in marker gone');
  await B.ctx.setOffline(false); await B.reload(); await B.waitForTimeout(2500);
  ok(await B.evaluate(() => !cloudOn() && state.sessions.length === 0), 'after reloading online it is still signed out and the trips stay removed');
  ok(await B.evaluate(() => fetch('/api/auth/me').then(r => r.status)) === 401, 'and the server session was ended once back online');
  ok(await B.evaluate(() => localStorage.getItem('fishr.logoutPending')) === null, 'pending sign-out cleared');
  await A.ctx.close(); await B.ctx.close();

  // 5. A late weather lookup from a closed new-trip form never lands in another trip.
  const C = await device(b, { weather: 'slow' });
  await C.route('**/*open-meteo.com/**', async r => { await new Promise(s => setTimeout(s, 2500)); r.fulfill({ contentType: 'application/json', body: tripWeather(r.request().url()) }); });
  await C.goto(URL0);
  await C.evaluate(() => { localStorage.clear(); localStorage.setItem('fishr.guide', '1'); localStorage.setItem('fishr.locAsked', '1'); localStorage.setItem('firetiger.v1', JSON.stringify({ sessions: [
    { id: 't-old', date: '2025-07-15', start: '19:00', water: 'Keswick River', catches: [{ species: 'Smallmouth bass', count: 3 }], method: 'Spin', conditions: ['Overcast'], tempLow: 22, tempHigh: 22,
      wx: { t: 22, code: 3, sky: 'Overcast', p: 1015, wind: 4, windDir: 'S', rain48: 0, at: '2025-07-15T19:00' }, updatedAt: '2025-07-16T00:00:00.000Z' } ],
    notes: [], settings: { name: 'J', units: 'imperial', temp: 'C', season: '2025', maps: 'auto', home: { lat: 45.9, lon: -66.6 } } })); });
  await C.reload(); await C.waitForTimeout(800);
  await C.evaluate(() => showTab('log'));
  await C.evaluate(() => startNewTrip()); await C.waitForTimeout(300); await C.evaluate(() => closeSheets()); await C.waitForTimeout(200);
  await C.evaluate(() => document.querySelector('.entry[data-id="t-old"]').click()); await C.waitForTimeout(3500);
  const f = await C.evaluate(() => ({ cond: [...$('segCond').querySelectorAll('[aria-pressed=true]')].map(x => x.dataset.v), chips: $('wxChips').textContent }));
  ok(f.cond.join() === 'Overcast' && /22/.test(f.chips) && !/31/.test(f.chips), 'old trip form keeps its own weather ' + JSON.stringify(f));
  await C.evaluate(() => { $('fNotes').value = 'fixed a typo'; $('saveBtn').click(); }); await C.waitForTimeout(500);
  const t = await C.evaluate(() => state.sessions.find(s => s.id === 't-old'));
  ok(t.wx.t === 22 && t.wx.at === '2025-07-15T19:00' && t.conditions.join() === 'Overcast' && t.notes === 'fixed a typo', 'saved trip keeps its July weather ' + JSON.stringify({ wx: t.wx.at, c: t.conditions }));
  // Changing the date while a lookup is running fetches for the new date.
  await C.evaluate(() => startNewTrip()); await C.waitForTimeout(300);
  await C.evaluate(() => { $('fDate').value = '2026-07-01'; $('fDate').dispatchEvent(new Event('change')); }); await C.waitForTimeout(6000);
  ok(await C.evaluate(() => formCond.wx?.at?.startsWith('2026-07-01')), 'date changed mid-lookup: weather is for the new date ' + await C.evaluate(() => formCond.wx?.at));
  await C.ctx.close();

  ok(!errs.length, 'no page errors ' + errs.join(' | '));
  console.log(res.join('\n')); await b.close();
})().catch(e => { console.log(res.join('\n')); console.error('ERR', e.message.split('\n')[0]); process.exit(1); });
