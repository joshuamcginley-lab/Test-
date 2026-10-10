// Bite alerts in the app and on the admin page. The browser's push service is stood in for (headless Chrome can't
// reach Google's), so this checks everything fishr does: permission, location, the subscription it sends, turning
// it off, the iPhone Home Screen rule, and a test alert from /admin reaching the device's push address.
const { chromium, devices } = require('playwright');
const S = process.argv[2], URL0 = process.argv[3] || 'http://localhost:8790/'; const res = []; const ok = (c, m) => res.push((c ? 'PASS ' : 'FAIL ') + m);

// Stand-in for PushManager and the notification permission.
const STUB = () => {
  const b64u = b => btoa(String.fromCharCode(...b)).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
  window.__perm = 'default'; window.__permAsked = 0;
  // Like a real browser, the subscription outlives the page (kept for other pages of the site).
  const wrap = j => j && { endpoint: j.endpoint, toJSON: () => j, unsubscribe: async () => { localStorage.removeItem('__fakeSub'); window.__unsubscribed = true; return true; } };
  let sub = wrap(JSON.parse(localStorage.getItem('__fakeSub') || 'null'));
  const pm = {
    getSubscription: async () => (sub = wrap(JSON.parse(localStorage.getItem('__fakeSub') || 'null'))),
    subscribe: async opts => {
      window.__subOpts = { userVisibleOnly: opts.userVisibleOnly, keyLen: opts.applicationServerKey.length };
      const k = await crypto.subtle.generateKey({ name: 'ECDH', namedCurve: 'P-256' }, true, ['deriveBits']);
      const keys = { p256dh: b64u(new Uint8Array(await crypto.subtle.exportKey('raw', k.publicKey))), auth: b64u(crypto.getRandomValues(new Uint8Array(16))) };
      const endpoint = location.origin + '/__push/device1';
      localStorage.setItem('__fakeSub', JSON.stringify({ endpoint, keys }));
      return (sub = wrap({ endpoint, keys }));
    },
  };
  window.PushManager = window.PushManager || function () {};
  Object.defineProperty(ServiceWorkerRegistration.prototype, 'pushManager', { get: () => pm, configurable: true });
  Object.defineProperty(Notification, 'permission', { get: () => window.__perm, configurable: true });
  Notification.requestPermission = async () => { window.__permAsked++; if (window.__perm === 'default') window.__perm = window.__answer || 'granted'; return window.__perm; };
};

(async () => {
  const b = await chromium.launch(); const errs = [];
  async function open({ device = 'iPhone 13', stub = true, noPush = false, answer = 'granted', home = { lat: 45.9612, lon: -66.6431, name: 'Fredericton, New Brunswick' } } = {}) {
    const ctx = await b.newContext({ ...devices[device], locale: 'en-CA', timezoneId: 'America/Moncton' });
    if (stub) await ctx.addInitScript(STUB);
    if (noPush) await ctx.addInitScript(() => { delete window.PushManager; });
    await ctx.addInitScript(a => { window.__answer = a; }, answer);
    const p = await ctx.newPage(); p.on('pageerror', e => errs.push(e.message));
    await p.route(/open-meteo|\/api\/water/, r => r.abort());
    await p.goto(URL0);
    await p.evaluate(home => { localStorage.clear(); localStorage.setItem('fishr.guide', '1'); localStorage.setItem('fishr.keepSafe', String(Date.now()));
      localStorage.setItem('firetiger.v1', JSON.stringify({ sessions: [{ id: 't-a', date: '2026-07-01', water: 'Keswick River', catches: [], method: 'Spin', updatedAt: '2026-07-01T00:00:00Z' }], notes: [], settings: { temp: 'C', home } })); }, home);
    await p.reload(); await p.evaluate(() => navigator.serviceWorker.ready); await p.waitForTimeout(500);
    return { p, ctx, click: sel => p.$eval(sel, e => e.click()) };
  }
  const toggle = async (p, on) => { await p.$eval('#openSettings', e => e.click()); await p.$eval('#sAlerts', (e, on) => { e.checked = on; e.dispatchEvent(new Event('change')); }, on); await p.waitForTimeout(1500); };
  const msg = p => p.evaluate(() => $('alertsMsg').textContent);
  const subs = p => p.evaluate(() => fetch('/__trips').then(() => null)).then(() => null);

  // Turn on: asks permission, subscribes with fishr's key, sends location (rounded), time zone and town.
  let { p, ctx, click } = await open();
  ok(await p.evaluate(() => /bite alerts are in beta now, free/i.test($('settings').textContent) && !/in development/i.test(document.body.innerHTML)), 'Settings: bite alerts listed as a free beta');
  let sent = null; p.on('request', r => { if (r.url().endsWith('/api/push/subscribe')) sent = JSON.parse(r.postData()); });
  await toggle(p, true);
  ok(/^On\. Bite Intelligence™ is now monitoring your personal Bite Index near Fredericton\.$/.test(await msg(p)), 'turned on: ' + await msg(p));
  const so = await p.evaluate(() => ({ asked: window.__permAsked, opts: window.__subOpts, setting: state.settings.alerts }));
  ok(so.asked === 1 && so.opts.userVisibleOnly && so.opts.keyLen === 65 && so.setting === true, 'asked permission once, subscribed with the 65-byte push key, setting saved');
  ok(sent && sent.endpoint.endsWith('/__push/device1') && sent.keys.p256dh && sent.lat === 45.9612 && sent.tz === 'America/Moncton' && sent.place === 'Fredericton', 'sent push address, location, time zone and town ' + JSON.stringify({ lat: sent?.lat, tz: sent?.tz, place: sent?.place }));
  await p.screenshot({ path: S + '/alerts-on.png' });
  // The app's own test button (the only way on iPhone, where the Home Screen app and Safari don't share alerts).
  ok(await p.evaluate(() => !$('alertsTestRow').hidden), 'test button shows once alerts are on');
  await p.$eval('#alertsTest', e => e.click()); await p.waitForTimeout(1500);
  const self = await p.evaluate(() => fetch('/__pushed').then(r => r.json()));
  ok(/^Sent\./.test(await msg(p)) && self.some(x => x.path === '/__push/device1' && x.enc === 'aes128gcm'), 'Settings → Send a test alert reaches this device');
  // The admin page sees the device and can send it a test alert.
  const ap = await ctx.newPage(); ap.on('pageerror', e => errs.push(e.message));
  await ap.goto(URL0 + 'admin.html'); await ap.fill('#key', 'test-admin'); await ap.$eval('#keyForm button[type=submit]', e => e.click()); await ap.waitForTimeout(1200);
  ok(/Push keys set · timer key set · 1 device with alerts on/.test(await ap.evaluate(() => $('alertsStatus').textContent)), 'admin: keys set, 1 device ' + await ap.evaluate(() => $('alertsStatus').textContent));
  await ap.$eval('#testAlert', e => e.click()); await ap.waitForTimeout(1500);
  const pushed = await ap.evaluate(() => fetch('/__pushed').then(r => r.json()));
  ok(/Sent\./.test(await ap.evaluate(() => $('testMsg').textContent)) && pushed.some(x => x.path === '/__push/device1' && x.enc === 'aes128gcm' && /^vapid t=/.test(x.auth) && x.bytes > 100), 'admin test alert: encrypted, signed push reached the device ' + JSON.stringify(pushed.at(-1)));
  await ap.$eval('details', d => d.open = true); await ap.$eval('#mkPush', e => e.click()); await ap.$eval('#mkCron', e => e.click()); await ap.waitForTimeout(300);
  const keys = await ap.evaluate(() => [...document.querySelectorAll('#keyOut input')].map(i => i.value));
  ok(keys.length === 3 && /^[\w-]{87}$/.test(keys[0]) && /^[\w-]{43}$/.test(keys[1]) && /^[\w-]{43}$/.test(keys[2]), 'admin: makes a push key pair and a timer key in the browser');
  await ap.screenshot({ path: S + '/alerts-admin.png', fullPage: true }); await ap.close();
  // Turn off: unsubscribes and the server forgets the device.
  await toggle(p, false);
  const st = await p.evaluate(() => fetch('/api/push/stats', { headers: { 'x-admin-key': 'test-admin' } }).then(r => r.json()));
  ok(/^Off\./.test(await msg(p)) && await p.evaluate(() => window.__unsubscribed && state.settings.alerts === false) && st.subscribers === 0, 'turned off: unsubscribed here and deleted on the server');
  await ctx.close();

  // Permission refused.
  ({ p, ctx } = await open({ answer: 'denied' }));
  await toggle(p, true);
  ok(/Notifications are blocked for fishr/.test(await msg(p)) && !(await p.evaluate(() => $('sAlerts').checked)), 'permission refused: explains, switch stays off');
  await ctx.close();

  // iPhone in Safari (not on the Home Screen): no push in the browser.
  ({ p, ctx } = await open({ stub: false, noPush: true }));
  await toggle(p, true);
  ok(/add fishr to your Home Screen first/.test(await msg(p)), 'iPhone in a browser tab: Home Screen first ' + (await msg(p)).slice(0, 60));
  await ctx.close();

  // Alerts not set up on the server yet (no keys): says so.
  ({ p, ctx } = await open());
  await p.route(/\/api\/push\/key/, r => r.fulfill({ contentType: 'application/json', body: '{"key":null}' }));
  await toggle(p, true);
  ok(/aren't switched on yet/.test(await msg(p)), 'server keys missing: "not switched on yet"');
  await ctx.close();

  // Opened from an alert: lands on the Guide.
  ({ p, ctx } = await open());
  await p.evaluate(() => { showTab('log'); }); await p.goto(URL0 + '?go=advice'); await p.waitForTimeout(800);
  ok(await p.evaluate(() => !$('panel-advice').hidden && location.search === ''), 'tapping an alert opens the Guide (and tidies the address)');
  await ctx.close();

  ok(!errs.length, 'no page errors ' + errs.join(' | '));
  console.log(res.join('\n')); await b.close();
})().catch(e => { console.log(res.join('\n')); console.error('ERR', e.message.split('\n')[0]); process.exit(1); });
