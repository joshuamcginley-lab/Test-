// Regressions from the third sweep: fishr Cloud must never lose, resurrect or double a trip or a note.
const { chromium, devices } = require('playwright'); const fs = require('fs');
const S = process.argv[2], URL0 = process.argv[3]; const res = []; const ok = (c, m) => res.push((c ? 'PASS ' : 'FAIL ') + m);
const SET = { name: 'J', units: 'imperial', temp: 'C', season: '2026', maps: 'auto' };
async function device(b, name) {
  const ctx = await b.newContext({ ...devices['iPhone 13'], serviceWorkers: 'block' }); const p = await ctx.newPage();
  p.errs = []; p.on('pageerror', e => p.errs.push(name + ': ' + e.message));
  await p.route(/open-meteo|\/api\/water/, r => r.abort());
  const cdp = await ctx.newCDPSession(p); await cdp.send('WebAuthn.enable');
  const { authenticatorId } = await cdp.send('WebAuthn.addVirtualAuthenticator', { options: { protocol: 'ctap2', transport: 'internal', hasResidentKey: true, hasUserVerification: true, isUserVerified: true, automaticPresenceSimulation: true } });
  p.cdp = cdp; p.auth = authenticatorId; p.ctx = ctx; return p;
}
const click = (p, sel) => p.$eval(sel, el => el.click());
async function fresh(p, data) {
  await p.goto(URL0); await p.evaluate(d => { localStorage.clear(); localStorage.setItem('fishr.guide', '1'); localStorage.setItem('fishr.keepSafe', String(Date.now())); if (d) localStorage.setItem('firetiger.v1', JSON.stringify(d)); }, data || null);
  await p.reload(); await p.waitForTimeout(900);
}
const signUp = async p => { await click(p, '#openSettings'); await p.waitForTimeout(300); await click(p, '#segStore [data-v=cloud]'); await click(p, '#cloudCreate'); await p.waitForTimeout(2500); await click(p, '#closeSettings'); };
const signIn = async p => { await click(p, '#openSettings'); await p.waitForTimeout(300); await click(p, '#segStore [data-v=cloud]'); await click(p, '#cloudSignIn'); await p.waitForTimeout(2500); await click(p, '#closeSettings'); };
const cloneKey = async (A, B) => { const { credentials } = await A.cdp.send('WebAuthn.getCredentials', { authenticatorId: A.auth }); await B.cdp.send('WebAuthn.addCredential', { authenticatorId: B.auth, credential: credentials.at(-1) }); };
const trips = p => p.evaluate(() => fetch('/__trips').then(r => r.json()));
const T = (id, water, extra = {}) => ({ id, date: '2026-06-01', water, catches: [{ species: 'Walleye', count: 1 }], updatedAt: '2026-06-01T20:00:00.000Z', ...extra });
(async () => {
  const b = await chromium.launch(), errs = [];
  // 1. Phone out of storage while signing in: nothing is ever deleted from the account.
  { const A = await device(b, 'A'), B = await device(b, 'B');
    const sessions = Array.from({ length: 12 }, (_, i) => T('q-' + i, 'Lake ' + i, { notes: 'x'.repeat(300) }));
    await fresh(A, { sessions, notes: [], settings: SET }); await signUp(A);
    await cloneKey(A, B); await fresh(B);
    await B.ctx.addInitScript(() => { const set = Storage.prototype.setItem; Storage.prototype.setItem = function (k, v) { if (k === 'firetiger.v1' && String(v).length > 3000) throw new DOMException('quota', 'QuotaExceededError'); return set.call(this, k, v); }; });
    await B.reload(); await B.waitForTimeout(800); await signIn(B);
    await B.reload(); await B.waitForTimeout(3000);
    const t = (await trips(A)).filter(x => x.id.startsWith('q-'));
    await A.evaluate(() => syncNow()); await A.waitForTimeout(1500);
    ok(t.length === 12 && !t.some(x => x.deleted) && await A.evaluate(() => state.sessions.length) === 12, `out of storage on phone B: the account keeps all 12 trips (deleted ${t.filter(x => x.deleted).length}), phone A too`);
    errs.push(...A.errs, ...B.errs); await A.ctx.close(); await B.ctx.close(); }
  // 2. A saved log that can't be read is restored from the account, not deleted from it.
  { const A = await device(b, 'A');
    await fresh(A, { sessions: [T('u-1', 'Keswick River'), T('u-2', 'Nashwaak River')], notes: [], settings: SET }); await signUp(A);
    await A.evaluate(() => localStorage.setItem('firetiger.v1', '{"sessions":[{broken'));
    await A.reload(); await A.waitForTimeout(3000);
    const t = (await trips(A)).filter(x => x.id.startsWith('u-'));
    ok(!t.some(x => x.deleted) && (await A.evaluate(() => state.sessions.map(s => s.id).sort().join())) === 'u-1,u-2', 'unreadable saved log: trips come back from the account, none deleted');
    errs.push(...A.errs); await A.ctx.close(); }
  // 3. A trip deleted while the sync that sent it is still on its way stays deleted.
  { const A = await device(b, 'A');
    await fresh(A, { sessions: [T('d-keep', 'Keswick River')], notes: [], settings: SET }); await signUp(A);
    await A.route('**/api/sync', async r => { await new Promise(x => setTimeout(x, 3000)); r.continue(); });
    await click(A, '#openNew'); await A.waitForTimeout(300); await A.fill('#fWaterIn', 'Wrong Lake'); await click(A, '#saveBtn'); await A.waitForTimeout(300);
    const id = await A.evaluate(() => state.sessions.find(s => s.water === 'Wrong Lake').id);
    await A.waitForTimeout(2200);
    await A.evaluate(id => openSheet(state.sessions.find(s => s.id === id)), id); await click(A, '#delBtn'); await click(A, '#delYes');
    await A.waitForTimeout(8000); await A.unroute('**/api/sync'); await A.evaluate(() => syncNow()); await A.waitForTimeout(1500);
    await A.reload(); await A.waitForTimeout(2000);
    const srv = (await trips(A)).find(t => t.id === id);
    ok(!(await A.evaluate(() => state.sessions.some(s => s.water === 'Wrong Lake'))) && srv?.deleted === 1, 'deleted mid-sync: stays deleted on the phone and in the account');
    errs.push(...A.errs); await A.ctx.close(); }
  // 4. Restoring a backup brings back trips deleted from the account.
  { const A = await device(b, 'A');
    const sessions = [T('r-1', 'Keswick River'), T('r-2', 'Oromocto Lake')];
    fs.writeFileSync(S + '/sweep3-backup.json', JSON.stringify({ app: 'fishr.ai', version: 2, sessions, notes: [], settings: {}, photos: {} }));
    await fresh(A, { sessions, notes: [], settings: SET }); await signUp(A);
    await click(A, '#openSettings'); await A.waitForTimeout(200); await click(A, '#wipeBtn'); await click(A, '#wipeYes'); await A.waitForTimeout(2500);
    await click(A, '#openSettings'); await A.waitForTimeout(200); await A.setInputFiles('#importFile', S + '/sweep3-backup.json'); await A.waitForTimeout(3500);
    const t = (await trips(A)).filter(x => x.id.startsWith('r-'));
    ok(await A.evaluate(() => state.sessions.length) === 2 && t.every(x => !x.deleted), 'restore after "Delete all trips": the trips stay, on the phone and in the account');
    errs.push(...A.errs); await A.ctx.close(); }
  // 5. Notes: a note deleted on one phone stays deleted when another phone changes a setting; notes that sync in
  //    while the editor is open aren't overwritten.
  { const A = await device(b, 'A'), B = await device(b, 'B');
    await fresh(A, { sessions: [T('n-1', 'Keswick River')], notes: ['Old note', 'Keep me'], settings: SET }); await signUp(A);
    await cloneKey(A, B); await fresh(B); await signIn(B); await B.evaluate(() => syncNow()); await B.waitForTimeout(1500);
    await B.ctx.setOffline(true);
    await A.evaluate(() => showTab('season')); await click(A, '#editNotes'); await A.$eval('#notesText', e => e.value = 'Keep me'); await click(A, '#saveNotes'); await A.waitForTimeout(2500);
    await click(B, '#openSettings'); await B.waitForTimeout(100); await B.$eval('#sUnits', e => { e.value = 'metric'; e.dispatchEvent(new Event('change')); }); await B.waitForTimeout(1500); await click(B, '#closeSettings');
    await B.ctx.setOffline(false); await B.evaluate(() => dispatchEvent(new Event('online'))); await B.waitForTimeout(2000);
    await A.evaluate(() => syncNow()); await A.waitForTimeout(1500);
    ok(JSON.stringify(await A.evaluate(() => state.notes)) === '["Keep me"]' && await A.evaluate(() => state.settings.units) === 'metric', 'note deleted on A stays deleted after B changes units; the units change still syncs');
    await A.evaluate(() => showTab('season')); await click(A, '#editNotes');
    await B.evaluate(() => { state.notes.push('From B'); save(); syncNow(); }); await B.waitForTimeout(1500); await A.evaluate(() => syncNow()); await A.waitForTimeout(1500);
    await A.$eval('#notesText', e => e.value += '\nFrom A'); await click(A, '#saveNotes'); await A.waitForTimeout(2500); await B.evaluate(() => syncNow()); await B.waitForTimeout(1500);
    const na = await A.evaluate(() => state.notes.slice().sort().join('|')), nb = await B.evaluate(() => state.notes.slice().sort().join('|'));
    ok(na === 'From A|From B|Keep me' && nb === na, 'notes editor open while a note synced in: both notes kept on both phones ' + na);
    errs.push(...A.errs, ...B.errs); await A.ctx.close(); await B.ctx.close(); }
  // 6. Species: typing a species exactly and pressing Enter keeps it.
  { const A = await device(b, 'A');
    await fresh(A, { sessions: [T('s-1', 'Keswick River', { catches: [{ species: 'Chain pickerel', count: 1 }] })], notes: [], settings: SET });
    await click(A, '#openNew'); await A.waitForTimeout(300); await click(A, '#addCatch');
    await A.fill('.catch-row .c-sp', 'Pickerel'); await A.press('.catch-row .c-sp', 'Enter');
    ok(await A.$eval('.catch-row .c-sp', e => e.value) === 'Pickerel', 'typed "Pickerel" + Enter stays Pickerel (not the first suggestion)');
    errs.push(...A.errs); await A.ctx.close(); }
  ok(!errs.length, 'no page errors ' + errs.join(' | '));
  console.log(res.join('\n')); await b.close();
})().catch(e => { console.log(res.join('\n')); console.error('ERR', e.message.split('\n')[0]); process.exit(1); });
