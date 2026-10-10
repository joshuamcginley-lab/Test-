// Regressions from the third sweep: large-text layouts, the showcase, the trip form, and bad networks/storage.
const { chromium, devices } = require('playwright'); const fs = require('fs');
const S = process.argv[2], URL0 = process.argv[3]; const res = []; const ok = (c, m) => res.push((c ? 'PASS ' : 'FAIL ') + m);
const T = (id, water, extra = {}) => ({ id, date: '2026-06-01', water, catches: [{ species: 'Smallmouth bass', count: 1 }], updatedAt: '2026-06-01T20:00:00.000Z', ...extra });
(async () => {
  const b = await chromium.launch(), errs = [];
  async function open({ dev = 'iPhone 13', root, data, guide = true, auth = false } = {}) {
    const ctx = await b.newContext({ ...devices[dev] });
    if (root) await ctx.addInitScript(r => document.addEventListener('DOMContentLoaded', () => { const st = document.createElement('style'); st.textContent = `html{font-size:${r}px!important}`; document.head.append(st); }), root);
    const p = await ctx.newPage(); p.on('pageerror', e => errs.push(e.message));
    await p.route(/open-meteo|\/api\/water/, r => r.abort());
    if (auth) { const cdp = await ctx.newCDPSession(p); await cdp.send('WebAuthn.enable'); await cdp.send('WebAuthn.addVirtualAuthenticator', { options: { protocol: 'ctap2', transport: 'internal', hasResidentKey: true, hasUserVerification: true, isUserVerified: true, automaticPresenceSimulation: true } }); }
    await p.goto(URL0);
    await p.evaluate(([d, g]) => { localStorage.clear(); if (g) localStorage.setItem('fishr.guide', '1'); localStorage.setItem('fishr.keepSafe', String(Date.now())); if (d) localStorage.setItem('firetiger.v1', JSON.stringify(d)); }, [data || null, guide]);
    await p.reload(); await p.waitForTimeout(800);
    return { p, ctx };
  }
  const own = { sessions: [T('a-1', 'Keswick River')], notes: ['Mine'], settings: { season: '2026' } };

  // The tour fits on a small phone at large text: its buttons are on screen.
  let { p, ctx } = await open({ dev: 'iPhone SE', root: 25.5, data: own, guide: false });
  await p.evaluate(() => loadSample('advice')); await p.waitForTimeout(1500);
  const card = await p.evaluate(() => { const c = document.querySelector('#guide:not([hidden]) .g-card'); if (!c) return null; const r = c.getBoundingClientRect(), n = $('gNext').getBoundingClientRect(); return { top: r.top, bottom: r.bottom, h: innerHeight, scrolls: c.scrollHeight > c.clientHeight }; });
  await p.evaluate(() => { const c = document.querySelector('.g-card'); c.scrollTop = c.scrollHeight; }); await p.waitForTimeout(100);
  const nextOn = await p.evaluate(() => { const n = $('gNext').getBoundingClientRect(); return n.top >= 0 && n.bottom <= innerHeight; });
  ok(card && card.top >= 0 && card.bottom <= card.h && nextOn, 'tour at 1.5x on iPhone SE: the card fits the screen and Next is reachable ' + JSON.stringify(card));
  ok(!/\$\{/.test(await p.evaluate(() => guideSteps().map(s => s.body).join(' '))), 'tour text has no unfilled ${…}');
  await p.evaluate(() => closeGuide());
  // In the showcase, "Delete all trips" isn't offered; Back leaves the showcase, not fishr.
  await p.evaluate(() => $('openSettings').click()); await p.waitForTimeout(200);
  ok(await p.evaluate(() => $('wipeBtn').closest('.set-group').hidden), 'showcase: Start over (Delete all trips) is hidden');
  await p.evaluate(() => closeSheets()); await p.waitForTimeout(600);
  await p.goBack(); await p.waitForTimeout(600);
  ok(await p.evaluate(() => !demo && state.sessions.length === 1 && location.origin !== 'null'), 'Back from the showcase returns to your own log');
  await ctx.close();

  // Empty Insights tables say so.
  ({ p, ctx } = await open({ data: { sessions: [T('e-1', 'Keswick River')], notes: [], settings: { season: '2026' } } }));
  await p.evaluate(() => showTab('patterns'));
  ok(/Not enough trips yet/.test(await p.evaluate(() => $('tTemp').textContent)), 'Insights: an empty table says "Not enough trips yet"');
  // Trip form checks.
  await p.evaluate(() => $('dockLog').click()); await p.waitForTimeout(300);
  const tryForm = async (fill, msg) => { await p.evaluate(fill); await p.$eval('#saveBtn', e => e.click()); await p.waitForTimeout(200); return p.evaluate(() => !$('formErr').hidden ? $('formErr').textContent : ''); };
  await p.fill('#fWaterIn', 'Keswick River');
  ok(/Check the date/.test(await tryForm(() => { $('fDate').value = ''; $('fDate').type = 'text'; $('fDate').value = '12026-10-10'; })), 'a five-digit year is refused');
  await p.evaluate(() => { $('fDate').type = 'date'; $('fDate').value = '2026-07-01'; });
  ok(/Check the temperature/.test(await tryForm(() => { $('fTlo').value = '99999'; })), 'a 99999° temperature is refused');
  await p.evaluate(() => { $('fTlo').value = '20'; $('addCatch').click(); document.querySelector('.c-sp').value = 'Smallmouth bass'; document.querySelector('.c-lb').value = '-5'; });
  ok(/can't be negative/.test(await tryForm(() => {})), 'a negative weight is refused');
  await p.evaluate(() => { document.querySelector('.c-lb').value = '2'; document.querySelector('.c-n').value = '1500'; });
  await p.$eval('#saveBtn', e => e.click()); await p.waitForTimeout(400);
  ok(await p.evaluate(() => state.sessions.some(s => s.date === '2026-07-01' && s.catches[0]?.count === 999)), 'a count over 999 is kept at 999 (same as a backup)');
  // Species list closes once the typed name is exactly a species, so it doesn't cover the count buttons.
  await p.waitForFunction(() => $('celebrate').hidden, null, { timeout: 8000 }).catch(() => {});
  await p.evaluate(() => { $('dockLog').click(); }); await p.waitForTimeout(300); await p.evaluate(() => $('addCatch').click());
  await p.fill('.catch-row .c-sp', 'Smallmouth bass'); await p.waitForTimeout(100);
  ok(await p.evaluate(() => document.querySelector('.combo-list').hidden), 'species list closes on an exact match');
  await p.evaluate(() => closeSheets()); await ctx.close();

  // Long logs: the trip list draws a page at a time.
  const many = Array.from({ length: 400 }, (_, i) => T('m-' + i, 'Lake ' + (i % 9), { date: `2026-${String(5 + (i % 5)).padStart(2, '0')}-${String(1 + (i % 28)).padStart(2, '0')}` }));
  ({ p, ctx } = await open({ data: { sessions: many, notes: [], settings: { season: '2026' } } }));
  await p.evaluate(() => showTab('log'));
  const n1 = await p.evaluate(() => document.querySelectorAll('#entries .entry').length);
  await p.$eval('#moreTrips', e => e.click()); await p.waitForTimeout(200);
  const n2 = await p.evaluate(() => document.querySelectorAll('#entries .entry').length);
  ok(n1 === 150 && n2 === 300 && /250 older|100 older/.test(await p.evaluate(() => $('moreTrips')?.textContent || '')), `400 trips: shows 150, then 300 with "Show more" (${n1}, ${n2})`);
  await ctx.close();

  // Out of storage: deleting a trip or saving notes doesn't claim success.
  ({ p, ctx } = await open({ data: { sessions: [T('q-1', 'Keswick River'), T('q-2', 'Nashwaak River')], notes: ['Old'], settings: { season: '2026' } } }));
  await p.evaluate(() => { const set = Storage.prototype.setItem; Storage.prototype.setItem = function (k, v) { if (k === KEY) throw new DOMException('quota', 'QuotaExceededError'); return set.call(this, k, v); }; });
  await p.evaluate(() => { openSheet(state.sessions[0]); }); await p.$eval('#delBtn', e => e.click()); await p.$eval('#delYes', e => e.click()); await p.waitForTimeout(200);
  const t1 = await p.evaluate(() => $('toast').textContent);
  await p.evaluate(() => closeSheets()); await p.evaluate(() => { showTab('season'); $('editNotes').click(); $('notesText').value = 'New'; $('saveNotes').click(); }); await p.waitForTimeout(200);
  const t2 = await p.evaluate(() => $('toast').textContent);
  ok(!/Trip deleted/.test(t1) && !/Notes saved/.test(t2) && await p.evaluate(() => state.sessions.length === 2 && state.notes.join() === 'Old'), `out of storage: no false "deleted"/"saved" (${t1} / ${t2})`);
  await ctx.close();

  // A 200 that isn't fishr's answer (a Wi-Fi sign-in page) never counts as synced.
  ({ p, ctx } = await open({ data: { sessions: [T('w-1', 'Keswick River')], notes: [], settings: { season: '2026' } }, auth: true }));
  await p.evaluate(() => $('openSettings').click()); await p.$eval('#segStore [data-v=cloud]', e => e.click()); await p.$eval('#cloudCreate', e => e.click()); await p.waitForTimeout(2500); await p.evaluate(() => closeSheets());
  await p.route('**/api/sync', r => r.fulfill({ status: 200, contentType: 'text/html', body: '<html>Please sign in to the Wi-Fi</html>' }));
  await p.evaluate(() => { state.sessions.push({ id: 't-new', date: '2026-07-02', water: 'New Lake', catches: [], updatedAt: new Date().toISOString() }); save(); return syncNow(); }); await p.waitForTimeout(500);
  await p.unroute('**/api/sync'); await p.evaluate(() => syncNow()); await p.waitForTimeout(1500);
  const srv = await p.evaluate(() => fetch('/__trips').then(r => r.json()));
  ok(srv.some(t => t.id === 't-new' && !t.deleted), 'Wi-Fi sign-in page answered a sync: the new trip still reaches the account afterwards');
  ok(/1 trip\b|2 trips/.test(await p.evaluate(() => $('cloudStatus')?.textContent || document.body.textContent)), 'trip count reads naturally');
  await ctx.close();

  ok(!errs.length, 'no page errors ' + errs.join(' | '));
  console.log(res.join('\n')); await b.close();
})().catch(e => { console.log(res.join('\n')); console.error('ERR', e.message.split('\n')[0]); process.exit(1); });
