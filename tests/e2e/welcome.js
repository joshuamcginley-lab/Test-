const { chromium, devices } = require('playwright'); const fs = require('fs');
const S = process.argv[2], URL0 = (process.argv[3] || 'http://localhost:8790/'); const res = []; const ok = (c, m) => res.push((c ? 'PASS ' : 'FAIL ') + m);
const LF = S + '/leaflet';
async function device(b, scheme = 'dark') {
  const ctx = await b.newContext({ ...devices['iPhone 13'], colorScheme: scheme }); const p = await ctx.newPage();
  p.errs = []; p.on('pageerror', e => p.errs.push(e.message));
  await p.route('**/api.open-meteo.com/**', r => r.abort());
  await p.route('**/api/sample', r => r.fulfill({ contentType: 'application/json', body: fs.readFileSync(S + '/enriched.json') }));
  if (fs.existsSync(LF + '/leaflet.js')) { await p.route('**/leaflet/1.9.4/leaflet.js', r => r.fulfill({ contentType: 'text/javascript', body: fs.readFileSync(LF + '/leaflet.js') })); await p.route('**/leaflet/1.9.4/leaflet.css', r => r.fulfill({ contentType: 'text/css', body: fs.readFileSync(LF + '/leaflet.css') })); }
  await p.route(/tile\.openstreetmap\.org/, r => r.abort());
  const cdp = await ctx.newCDPSession(p); await cdp.send('WebAuthn.enable');
  const { authenticatorId } = await cdp.send('WebAuthn.addVirtualAuthenticator', { options: { protocol: 'ctap2', transport: 'internal', hasResidentKey: true, hasUserVerification: true, isUserVerified: true, automaticPresenceSimulation: true } });
  p.cdp = cdp; p.auth = authenticatorId; return p;
}
const fresh = async p => { await p.goto(URL0); await p.evaluate(() => { localStorage.clear(); sessionStorage.clear(); }); await p.reload(); await p.waitForTimeout(1300); };
const click = (p, sel) => p.$eval(sel, el => el.click());
(async () => {
  const b = await chromium.launch();
  for (const scheme of ['light', 'dark']) {
    const p = await device(b, scheme); await fresh(p);
    const v = await p.evaluate(() => ({ welcome: !$('welcome').hidden, demo: !!demo, cloudLink: !$('welcomeCloud').hidden }));
    ok(v.welcome && !v.demo && v.cloudLink, `${scheme}: fresh visit shows welcome, not sample ` + JSON.stringify(v));
    await p.screenshot({ path: `${S}/welcome-${scheme}.png`, fullPage: true });
    if (scheme === 'dark') {
      for (const [t, want] of [['advice', 'advice'], ['patterns', 'patterns'], ['map', 'log']]) {
        await fresh(p); await click(p, `[data-sample="${t}"]`); await p.waitForTimeout(1500);
        const r = await p.evaluate(() => ({ demo: !!demo, tab: document.querySelector('nav.tabs [aria-selected="true"]')?.dataset.tab, info: !$('sampleInfo').hidden, map: !$('mapWrap').hidden }));
        ok(r.demo && r.tab === want && !r.info && (t !== 'map' || r.map), `tile ${t} -> ${JSON.stringify(r)}`);
        if (t === 'patterns') await p.screenshot({ path: `${S}/tile-insights.png` });
      }
      await click(p, '#clearSample'); await p.waitForTimeout(300);
      ok(await p.evaluate(() => !$('welcome').hidden), 'exit sample returns to welcome');
      await click(p, '#openSettings'); await click(p, '#settingsSample'); await p.waitForTimeout(1200);
      ok(await p.evaluate(() => !!demo && !$('sampleInfo').hidden && $('settings').hidden), 'Settings > Show the sample season opens it with the explainer');
    }
    ok(!p.errs.length, scheme + ' no errors ' + p.errs.join('|'));
  }
  // welcome sign-in on a new phone
  const A = await device(b); await fresh(A);
  await A.evaluate(() => { state.sessions.push({ id: 't-x1', date: '2026-08-01', water: 'Tay River', catches: [{ species: 'Brook Trout', count: 4 }], updatedAt: new Date().toISOString() }); save(); render(); });
  await click(A, '#openSettings'); await click(A, '#segStore [data-v=cloud]'); await click(A, '#cloudCreate'); await A.waitForTimeout(2500);
  const B = await device(b);
  const { credentials } = await A.cdp.send('WebAuthn.getCredentials', { authenticatorId: A.auth });
  await B.cdp.send('WebAuthn.addCredential', { authenticatorId: B.auth, credential: credentials[0] });
  await fresh(B); await click(B, '#welcomeSignIn'); await B.waitForTimeout(2500);
  const bs = await B.evaluate(() => ({ welcome: !$('welcome').hidden, n: state.sessions.length, on: cloudOn(), toast: $('toast').textContent }));
  ok(!bs.welcome && bs.n === 1 && bs.on && /Signed in. 1 trip synced/.test(bs.toast), 'welcome sign-in pulls log ' + JSON.stringify(bs));
  ok(!A.errs.length && !B.errs.length, 'no errors ' + [...A.errs, ...B.errs].join('|'));
  console.log(res.join('\n')); await b.close();
})().catch(e => { console.log(res.join('\n')); console.error(e); process.exit(1); });
