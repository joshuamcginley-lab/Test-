// Stats "Time on the water" and Insights "Best combinations".
const { chromium, devices } = require('playwright'); const fs = require('fs');
const S = process.argv[2], URL0 = process.argv[3] || 'http://localhost:8790/'; const res = []; const ok = (c, m) => res.push((c ? 'PASS ' : 'FAIL ') + m);
const ownLog = JSON.parse(fs.readFileSync(S + '/enriched.json', 'utf8')).map(({ sample, ...s }) => s);

(async () => {
  const b = await chromium.launch(); const errs = [];
  async function open(log, device = 'iPhone 13', settings = {}) {
    const ctx = await b.newContext({ ...devices[device], locale: 'en-CA' });
    const p = await ctx.newPage(); p.on('pageerror', e => errs.push(e.message));
    await p.route(/open-meteo|\/api\/water/, r => r.abort());
    await p.goto(URL0);
    await p.evaluate(([log, settings]) => { localStorage.clear(); sessionStorage.clear(); localStorage.setItem('fishr.guide', '1'); localStorage.setItem('fishr.keepSafe', String(Date.now()));
      localStorage.setItem('firetiger.v1', JSON.stringify({ sessions: log, notes: [], settings: { temp: 'C', season: 'all', ...settings } })); }, [log, settings]);
    await p.reload(); await p.waitForTimeout(700);
    return { p, ctx };
  }
  const hours = p => p.evaluate(() => { showTab('season'); document.querySelector('#statSeg [data-v=hours]').click(); return $('hoursBox').innerText.replace(/\s+/g, ' ').trim(); });
  const combos = p => p.evaluate(() => { showTab('patterns'); document.querySelector('#insSeg [data-v=combo]').click(); return $('comboBox').innerText.replace(/\s+/g, ' ').trim(); });

  // Expected numbers, worked out here from the same log.
  const ch = t => { const [a, m] = t.split(':').map(Number); return a + m / 60; };
  const timed = ownLog.filter(s => s.start && s.end).map(s => { let h = ch(s.end) - ch(s.start); if (h <= 0) h += 24; return { s, h }; }).filter(x => x.h <= 16);
  const H = timed.reduce((a, x) => a + x.h, 0), F = timed.reduce((a, x) => a + x.s.catches.reduce((c, k) => c + (+k.count || 0), 0), 0);

  let { p, ctx } = await open(ownLog);
  ok(await p.evaluate(() => document.querySelector('#insSeg [aria-pressed=true]').dataset.v) === 'combo', 'Insights opens on Combos');
  let t = await hours(p);
  ok(t.includes(`${Math.round(H)}h on the water`) && t.includes(`${(F / H).toFixed(1)} fish an hour`) && new RegExp(`From the ${timed.length} of ${ownLog.length} trips`, 'i').test(t), `Time on the water: ${Math.round(H)} h, ${(F / H).toFixed(1)}/h from ${timed.length} trips — ${t.slice(0, 120)}`);
  ok(/Nashwaaksis Stream 7\.5 17 2\.3/.test(t) && /Keswick River 37 43 1\.2/.test(t), 'per-water fish per hour, best first');
  await p.screenshot({ path: S + '/stats-hours.png' });

  t = await combos(p);
  const rows = await p.evaluate(() => [...document.querySelectorAll('#comboBox .combos li')].map(li => ({ cls: li.className, k: li.querySelector('b').textContent, d: li.querySelector('span').textContent })));
  const best = rows.filter(r => r.cls === 'go'), worst = rows.filter(r => r.cls === 'no');
  const avg = +t.match(/average ([\d.]+) fish per trip/i)[1];
  ok(best.length >= 1 && best.length <= 3 && best.every(r => +r.d.match(/^([\d.]+)/)[1] >= avg * 1.25 && +r.d.match(/· (\d+) trips/)[1] >= 4), 'best combos: up to 3, each 4+ trips and clearly above average ' + JSON.stringify(best));
  ok(best.every(r => / \+ /.test(r.k) && /^[A-Z0-9]/.test(r.k)), 'each is a stack of conditions, capitalised');
  ok(worst.length <= 1 && worst.every(r => +r.d.match(/^([\d.]+)/)[1] <= avg * 0.6), 'toughest: at most one, clearly below average ' + JSON.stringify(worst));
  // Recompute the first combo by hand from its conditions.
  const first = best[0].k.toLowerCase();
  const check = await p.evaluate(key => { const ts = state.sessions.filter(s => { const t = tripTraits(s).map(x => x[1].toLowerCase()); return key.split(' + ').every(k => t.includes(k)); }); return { n: ts.length, rate: ts.reduce((a, s) => a + fishOf(s), 0) / ts.length }; }, first);
  ok(best[0].d.startsWith(check.rate.toFixed(1)) && best[0].d.includes(`${check.n} trips`), `top combo's numbers check out (${first}: ${check.rate.toFixed(1)} over ${check.n})`);
  await p.screenshot({ path: S + '/insights-combos.png' });
  await p.evaluate(() => { state.settings.temp = 'F'; save(); render(); });
  t = await combos(p);
  ok(!/°C/.test(t), 'temperature ranges follow °F ' + (t.match(/\d+–\d+°F/) || [''])[0]);
  await ctx.close();

  // Small phone: nothing overflows.
  ({ p, ctx } = await open(ownLog, 'iPhone SE'));
  await hours(p); let over = await p.evaluate(() => document.documentElement.scrollWidth > innerWidth || [...document.querySelectorAll('[data-ins=hours] table')].some(t => t.scrollWidth > t.parentElement.clientWidth + 1));
  ok(!over, 'Time card fits a 320px phone');
  await combos(p); over = await p.evaluate(() => document.documentElement.scrollWidth > innerWidth);
  ok(!over, 'Combos fit a 320px phone');
  await ctx.close();

  // Overnight trips count across midnight; a typo'd 20-hour trip is left out; few timed trips show a hint.
  const few = [
    { id: 't1', date: '2026-07-01', start: '22:00', end: '02:00', water: 'A', catches: [{ species: 'Bass', count: 4 }], method: 'Spin', updatedAt: '2026-07-02T00:00:00Z' },
    { id: 't2', date: '2026-07-02', start: '06:00', end: '08:00', water: 'A', catches: [{ species: 'Bass', count: 2 }], method: 'Spin', updatedAt: '2026-07-02T00:00:00Z' },
    { id: 't3', date: '2026-07-03', start: '05:00', end: '01:00', water: 'A', catches: [], method: 'Spin', updatedAt: '2026-07-03T00:00:00Z' },
    { id: 't4', date: '2026-07-04', start: '07:00', water: 'A', catches: [], method: 'Spin', updatedAt: '2026-07-04T00:00:00Z' },
  ];
  ({ p, ctx } = await open(few));
  t = await hours(p);
  ok(/Add a start and end time/.test(t) && /2 of 4 trips have both times/i.test(t), 'under 3 timed trips: a hint, and the overnight one counts while the 20-hour one doesn\'t ' + t.slice(-40));
  await p.evaluate(() => { state.sessions.push({ id: 't5', date: '2026-07-05', start: '18:00', end: '21:00', water: 'A', catches: [], method: 'Spin', updatedAt: '2026-07-05T00:00:00Z' }); save(); render(); });
  t = await hours(p);
  ok(/9h on the water/.test(t) && /0\.7 fish an hour/.test(t) && /3h 00m average trip/.test(t), '22:00–02:00 counts as 4 hours: 9 h, 6 fish → 0.7/h, 3h average ' + t.slice(0, 80));
  t = await combos(p);
  ok(/Best combos show once at least 4 trips share the same conditions/.test(t), 'too few trips: Combos explains what it needs');
  await ctx.close();

  ok(!errs.length, 'no page errors ' + errs.join(' | '));
  console.log(res.join('\n')); await b.close();
})().catch(e => { console.log(res.join('\n')); console.error('ERR', e.message.split('\n')[0]); process.exit(1); });
