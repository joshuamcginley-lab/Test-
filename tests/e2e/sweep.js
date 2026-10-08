// Bug sweep: every screen at several sizes, both themes, offline, units. Reports page errors and horizontal overflow.
const { chromium, devices } = require('playwright'); const fs = require('fs');
const S = process.argv[2], URL0 = process.argv[3];
const out = []; const ok = (c, m) => out.push((c ? 'PASS ' : 'FAIL ') + m);
const DEV = [['iPhone SE', devices['iPhone SE']], ['iPhone 13', devices['iPhone 13']], ['Pixel 7', devices['Pixel 7']], ['iPad Mini', devices['iPad Mini']], ['Desktop', { viewport: { width: 1280, height: 860 } }]];
const wxBody = fs.readFileSync(S + '/wx.json', 'utf8');
(async () => {
  const b = await chromium.launch();
  for (const [dname, dev] of DEV) for (const scheme of ['light', 'dark']) {
    const tag = `${dname}/${scheme}`;
    const ctx = await b.newContext({ ...dev, colorScheme: scheme, geolocation: { latitude: 45.96, longitude: -66.64 }, permissions: ['geolocation'] });
    const p = await ctx.newPage(); const errs = [];
    p.on('pageerror', e => errs.push(e.message));
    await p.route('**/api.open-meteo.com/**', r => r.fulfill({ contentType: 'application/json', body: wxBody }));
    await p.route('**/geocoding-api.open-meteo.com/**', r => r.fulfill({ contentType: 'application/json', body: '{"results":[{"name":"Halifax","admin1":"Nova Scotia","latitude":44.65,"longitude":-63.57}]}' }));
    await p.route(/tile\.openstreetmap\.org|cdnjs\.cloudflare\.com/, r => r.abort());
    const overflow = async where => {
      const r = await p.evaluate(() => {
        const W = document.documentElement.clientWidth, sw = document.documentElement.scrollWidth;
        const scrollers = '.live-rest,.ask-chips,.callouts,.ins-seg,.tbl-wrap,.sc-tiles,.leaflet-container,.combo-list,.seg,.filters';
        const bad = [...document.querySelectorAll('body *')].filter(e => { const r = e.getBoundingClientRect(); return r.width && r.right > W + 1 && !e.closest(scrollers) && getComputedStyle(e).position !== 'fixed' && e.offsetParent !== null; })
          .slice(0, 3).map(e => `${e.tagName.toLowerCase()}${e.id ? '#' + e.id : ''}.${[...e.classList].join('.')} r=${Math.round(e.getBoundingClientRect().right)}`);
        return { W, sw, bad };
      });
      ok(r.sw <= r.W + 1 && !r.bad.length, `${tag} ${where}: no sideways overflow${r.bad.length || r.sw > r.W + 1 ? ' ' + JSON.stringify(r) : ''}`);
    };
    const click = sel => p.$eval(sel, e => e.click());
    await p.goto(URL0); await p.evaluate(() => { localStorage.clear(); sessionStorage.clear(); localStorage.setItem('fishr.guide', '1'); }); await p.reload(); await p.waitForTimeout(900);
    await overflow('welcome');
    // sample: every tab and segment
    await click('[data-sample="advice"]'); await p.waitForTimeout(1400);
    await p.evaluate(() => goLive(true)); await p.waitForTimeout(1200);
    await overflow('copilot live');
    await p.evaluate(() => { const m = document.getElementById('mathBox'); if (m) m.open = true; document.getElementById('inputsBox').open = true; }); await p.waitForTimeout(200);
    await overflow('copilot expanded');
    for (const t of ['season', 'patterns', 'log']) {
      await p.evaluate(t => showTab(t), t); await p.waitForTimeout(250);
      const seg = t === 'season' ? 'statSeg' : t === 'patterns' ? 'insSeg' : null;
      if (seg) for (const v of await p.$$eval(`#${seg} button`, bs => bs.map(x => x.dataset.v))) { await click(`#${seg} [data-v="${v}"]`); await p.waitForTimeout(80); await overflow(`${t}:${v}`); }
      else await overflow(t);
    }
    await click('#viewSeg [data-v="map"]'); await p.waitForTimeout(400); await overflow('map (offline tiles)'); await click('#viewSeg [data-v="list"]');
    for (const sheet of ['#openSettings', '#topPro']) { await click(sheet); await p.waitForTimeout(250); await overflow(`sheet ${sheet}`); await p.evaluate(() => closeSheets()); }
    // ask + fishr ID (sample)
    await p.evaluate(() => showTab('advice')); await click('.ask-chip'); await p.waitForTimeout(1500); await overflow('ask answered');
    await p.setInputFiles('.fid-top .fid-file', S + '/portrait.jpg'); await p.waitForTimeout(1500); await overflow('fishr ID sheet');
    ok(await p.evaluate(() => !!document.getElementById('fidName')), `${tag}: fishr ID shows a result`);
    await p.evaluate(() => closeSheets());
    // exit sample -> own log: log, edit, delete a trip with metric + °F
    await click('#clearSample'); await p.waitForTimeout(300);
    ok(await p.evaluate(() => !demo && state.sessions.length === 0 && !$('welcome').hidden), `${tag}: exit sample restores the empty log`);
    await p.evaluate(() => { state.settings.units = 'metric'; state.settings.temp = 'F'; save(); });
    await p.evaluate(() => startNewTrip()); await p.waitForTimeout(300); await overflow('log form');
    await p.fill('#fWaterIn', 'Tay River'); await p.fill('#fTlo', '68');
    await click('#addCatch'); await p.fill('#catchRows .c-sp', 'Brook trout'); await p.fill('#catchRows .c-lb', '1'); await p.fill('#catchRows .c-in', '30');
    await click('#saveBtn'); await p.waitForTimeout(700);
    let t = await p.evaluate(() => state.sessions[0]);
    ok(t && Math.abs(t.tempLow - 20) < 0.11 && Math.abs(t.catches[0].lb - 2.205) < 0.01 && Math.abs(t.catches[0].inches - 11.81) < 0.05, `${tag}: metric/°F stored as lb/in/°C ${JSON.stringify(t && { tl: t.tempLow, lb: t.catches[0].lb, in: t.catches[0].inches })}`);
    ok(await p.evaluate(() => JSON.parse(localStorage.getItem('firetiger.v1')).sessions.length === 1), `${tag}: trip persisted`);
    // edit without changing numbers keeps exact values
    await p.evaluate(() => { showTab('log'); }); await p.waitForTimeout(200); await click('#entries .entry'); await p.waitForTimeout(300);
    await p.evaluate(() => { const d = document.getElementById('fNotes').closest('details'); if (d) d.open = true; }); await p.fill('#fNotes', 'edited'); await click('#saveBtn'); await p.waitForTimeout(700);
    const t2 = await p.evaluate(() => state.sessions[0]);
    ok(t2.notes === 'edited' && t2.tempLow === t.tempLow && t2.catches[0].lb === t.catches[0].lb && t2.catches[0].inches === t.catches[0].inches, `${tag}: editing keeps exact stored values`);
    await p.evaluate(() => { state.settings.units = 'imperial'; state.settings.temp = 'C'; save(); render(); });
    for (const tb of ['advice', 'season', 'patterns', 'log']) { await p.evaluate(x => showTab(x), tb); await p.waitForTimeout(150); await overflow(`own ${tb}`); }
    // offline: app keeps working
    await ctx.setOffline(true);
    await p.evaluate(() => { showTab('advice'); render(); }); await p.waitForTimeout(400);
    await p.evaluate(() => startNewTrip()); await p.fill('#fWaterIn', 'Offline Lake'); await click('#saveBtn'); await p.waitForTimeout(600);
    ok(await p.evaluate(() => state.sessions.length === 2), `${tag}: logging works offline`);
    await ctx.setOffline(false);
    // delete
    await p.evaluate(() => showTab('log')); await click('#entries .entry'); await p.waitForTimeout(200); await click('#delBtn'); await click('#delYes'); await p.waitForTimeout(300);
    ok(await p.evaluate(() => state.sessions.length === 1), `${tag}: delete works`);
    ok(!errs.length, `${tag}: no page errors ${errs.slice(0, 3).join(' | ')}`);
    await ctx.close();
  }
  const fails = out.filter(x => x.startsWith('FAIL'));
  console.log(`${out.length - fails.length} pass, ${fails.length} fail`); console.log(fails.join('\n'));
  await b.close();
})().catch(e => { console.log(out.filter(x => x.startsWith('FAIL')).join('\n')); console.error('ERR', e.message.split('\n').slice(0, 3).join(' ')); process.exit(1); });
