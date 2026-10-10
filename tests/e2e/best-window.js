// The Guide's "Best window" only calls hours the log has seen: a 0–3°C forecast against a summer log (9–33°C) says
// so instead of promising a fish count; a partly cold day picks the hours inside the log's range.
const { chromium, devices } = require('playwright'); const fs = require('fs');
const S = process.argv[2], URL0 = process.argv[3]; const res = []; const ok = (c, m) => res.push((c ? 'PASS ' : 'FAIL ') + m);
const base = JSON.parse(fs.readFileSync(S + '/wx.json', 'utf8'));
const pad = n => String(n).padStart(2, '0'), fmt = d => `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}T${pad(d.getHours())}:${pad(d.getMinutes())}`;
const now = new Date(); now.setMinutes(0, 0, 0);
const by = now - new Date(base.hourly.time[48]), shift = s => fmt(new Date(new Date(s).getTime() + by));
const weather = tempAt => { const w = JSON.parse(JSON.stringify(base)); w.hourly.time = w.hourly.time.map(shift); w.daily.sunrise = w.daily.sunrise.map(shift); w.daily.sunset = w.daily.sunset.map(shift);
  w.hourly.temperature_2m = w.hourly.time.map(t => tempAt(new Date(t).getHours())); w.current.temperature_2m = tempAt(now.getHours()); return JSON.stringify(w); };
const ownLog = JSON.parse(fs.readFileSync(S + '/enriched.json', 'utf8')).map(({ sample, ...s }) => s);
(async () => {
  const b = await chromium.launch(), errs = [];
  const windowText = async body => {
    const ctx = await b.newContext({ ...devices['iPhone 13'], locale: 'en-CA', geolocation: { latitude: 45.96, longitude: -66.64 }, permissions: ['geolocation'] });
    const p = await ctx.newPage(); p.on('pageerror', e => errs.push(e.message));
    await p.route('**/api.open-meteo.com/**', r => r.fulfill({ contentType: 'application/json', body }));
    await p.route(/\/api\/water/, r => r.abort());
    await p.goto(URL0);
    await p.evaluate(log => { localStorage.clear(); localStorage.setItem('fishr.guide', '1'); localStorage.setItem('fishr.keepSafe', String(Date.now())); localStorage.setItem('firetiger.v1', JSON.stringify({ sessions: log, notes: [], settings: { temp: 'C', season: '2026' } })); }, ownLog);
    await p.reload(); await p.waitForTimeout(800);
    await p.evaluate(() => showTab('advice')); await p.evaluate(() => goLive(true)); await p.waitForTimeout(2000); await p.evaluate(() => render()); await p.waitForTimeout(300);
    const t = await p.evaluate(() => document.querySelector('#panel-advice .window')?.textContent || '');
    await ctx.close(); return t;
  };
  const coldest = Math.min(...ownLog.map(s => s.tempLow).filter(t => t != null));
  let t = await windowText(weather(h => (h % 4)));
  ok(/colder than any trip in your log/.test(t) && new RegExp(`coldest: ${coldest}°C`).test(t) && !/Expect about/.test(t), `0–3°C all day: says it's colder than the log (coldest ${coldest}°C), no fish count — "${t}"`);
  t = await windowText(weather(h => (h >= 12 && h <= 18 ? 17 : 1)));
  const m = t.match(/(\d+) (AM|PM)–(\d+) (AM|PM)/);
  ok(m && m[2] === 'PM' && /17°C/.test(t) && !/colder than/.test(t), `cold morning, mild afternoon: the window is in the afternoon at 17°C — "${t}"`);
  ok(!errs.length, 'no page errors ' + errs.join(' | '));
  console.log(res.join('\n')); await b.close();
})().catch(e => { console.log(res.join('\n')); console.error('ERR', e.message.split('\n')[0]); process.exit(1); });
