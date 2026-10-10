// Anonymous usage counts, end to end: each milestone is sent once with nothing but its name, the Settings switch
// stops it, retention is measured from when trips were saved, a developer's own computer sends nothing by default,
// and the admin page shows the totals.
const { chromium, devices } = require('playwright');
const S = process.argv[2], URL0 = process.argv[3] || 'http://localhost:8790/'; const res = []; const ok = (c, m) => res.push((c ? 'PASS ' : 'FAIL ') + m);
const DAY = 864e5, id = ms => `t-${ms.toString(36)}-abcd`;

(async () => {
  const b = await chromium.launch(); const errs = [];
  async function open({ test = true, log = null, settings = {} } = {}) {
    const ctx = await b.newContext({ ...devices['iPhone 13'], locale: 'en-CA' });
    const p = await ctx.newPage(); p.on('pageerror', e => errs.push(e.message)); p.sent = [];
    p.on('request', r => { if (r.url().endsWith('/api/usage') && r.method() === 'POST') p.sent.push(r.postData()); });
    await p.route(/open-meteo|\/api\/water/, r => r.abort());
    await p.goto(URL0);
    await p.evaluate(([test, log, settings]) => { localStorage.clear(); sessionStorage.clear(); localStorage.setItem('fishr.guide', '1'); localStorage.setItem('fishr.locAsked', '1'); localStorage.setItem('fishr.keepSafe', String(Date.now()));
      if (test) localStorage.setItem('fishr.usage.test', '1');
      if (log) localStorage.setItem('firetiger.v1', JSON.stringify({ sessions: log, notes: [], settings: { temp: 'C', ...settings } })); }, [test, log, settings]);
    p.sent.length = 0; await p.reload(); await p.waitForTimeout(2200);
    return { p, ctx, events: () => p.sent.map(x => JSON.parse(x).event), click: sel => p.$eval(sel, e => e.click()) };
  }
  const logTrip = async (p, water) => { await p.evaluate(() => startNewTrip()); await p.waitForTimeout(300); await p.fill('#fWaterIn', water); await p.$eval('#saveBtn', e => e.click()); await p.waitForTimeout(2900); };

  // Brand-new visitor.
  let { p, ctx, events, click } = await open();
  ok(JSON.stringify(events()) === '["open"]', 'first visit: "open", once ' + JSON.stringify(events()));
  ok(p.sent.every(x => Object.keys(JSON.parse(x)).join() === 'event'), 'each report carries only the milestone name');
  p.sent.length = 0; await p.reload(); await p.waitForTimeout(2200);
  ok(events().length === 0, 'reloading sends nothing again');
  await p.evaluate(() => loadSample('advice')); await p.waitForTimeout(2000);
  ok(events().join() === 'showcase', 'opening the showcase: "showcase" ' + JSON.stringify(events()));
  await p.evaluate(() => exitSample()); p.sent.length = 0;
  await logTrip(p, 'Keswick River');
  ok(events().includes('trip1') && events().includes('active'), 'first trip: "trip1" and this week\'s "active" ' + JSON.stringify(events()));
  p.sent.length = 0; await logTrip(p, 'Keswick River'); await logTrip(p, 'Nashwaak');
  ok(events().join() === 'trip3', 'third trip: "trip3", and "active" not repeated in the same week ' + JSON.stringify(events()));
  // Off switch.
  await click('#openSettings'); await p.waitForTimeout(200);
  ok(await p.evaluate(() => $('sUsage').checked), 'Settings: usage counts on by default');
  await p.$eval('#sUsage', e => { e.checked = false; e.dispatchEvent(new Event('change')); }); await click('#closeSettings');
  p.sent.length = 0; await logTrip(p, 'A'); await logTrip(p, 'B');
  ok(events().length === 0, 'switched off: nothing is sent (5th trip not reported)');
  await click('#openSettings'); await p.$eval('#sUsage', e => { e.checked = true; e.dispatchEvent(new Event('change')); }); await click('#closeSettings'); await p.waitForTimeout(800);
  ok(events().join() === 'trip5', 'switched back on: the missed milestone is reported ' + JSON.stringify(events()));
  await ctx.close();

  // Retention from when trips were saved: first trip 20 days ago, latest today.
  const now = Date.now();
  const log = [0, 1, 2, 3].map(i => ({ id: id(now - (20 - i * 6.6) * DAY), date: '2026-09-20', water: 'Keswick River', catches: [], method: 'Spin', updatedAt: new Date(now - (20 - i * 6.6) * DAY).toISOString() }));
  ({ p, ctx, events } = await open({ log }));
  ok(events().includes('retained14') && !events().includes('retained30') && events().includes('trip3') && events().includes('active'), 'logging 20 days after the first trip: "retained14", not "retained30" ' + JSON.stringify(events()));
  await ctx.close();

  // A developer's own computer sends nothing unless a test asks for it.
  ({ p, ctx, events } = await open({ test: false, log }));
  ok(events().length === 0, 'localhost without the test flag: nothing sent');
  await ctx.close();

  // Admin page shows the totals.
  ({ p, ctx } = await open({ test: false }));
  await p.goto(URL0 + 'admin.html'); await p.fill('#key', 'test-admin'); await p.$eval('#keyForm button[type=submit]', e => e.click()); await p.waitForTimeout(1500);
  const t = await p.evaluate(() => document.getElementById('usage').innerText.replace(/\s+/g, ' '));
  ok(/Opened fishr 2 /.test(t) && /Logged a 1st trip 2 100%/.test(t) && /3rd trip 2 100%/.test(t) && /Still logging after 2 weeks 1 50%/.test(t), 'admin page: funnel with counts and share of "opened" — ' + t.slice(0, 160));
  ok(await p.evaluate(() => document.querySelectorAll('#weeks div').length === 12), 'admin page: 12-week chart');
  await p.screenshot({ path: S + '/admin-usage.png', fullPage: true });
  await ctx.close();

  ok(!errs.length, 'no page errors ' + errs.join(' | '));
  console.log(res.join('\n')); await b.close();
})().catch(e => { console.log(res.join('\n')); console.error('ERR', e.message.split('\n')[0]); process.exit(1); });
