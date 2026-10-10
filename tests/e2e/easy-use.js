// Easier to use for older eyes and cold fingers: text follows the phone's text size (and is unchanged at the
// standard size), and logging controls have 44-point touch areas, with − / + for the fish count.
const { chromium, devices } = require('playwright');
const S = process.argv[2], URL0 = process.argv[3]; const res = []; const ok = (c, m) => res.push((c ? 'PASS ' : 'FAIL ') + m);
(async () => {
  const b = await chromium.launch(), errs = [];
  async function open({ root, dark } = {}) {
    const ctx = await b.newContext({ ...devices['iPhone 13'], colorScheme: dark ? 'dark' : 'light' });
    if (root) await ctx.addInitScript(r => document.addEventListener('DOMContentLoaded', () => { const st = document.createElement('style'); st.textContent = `html{font-size:${r}px!important}`; document.head.append(st); }), root);
    const p = await ctx.newPage(); p.on('pageerror', e => errs.push(e.message));
    await p.route(/open-meteo|\/api\/water|\/api\/sample/, r => r.abort());
    await p.goto(URL0);
    await p.evaluate(() => { localStorage.clear(); localStorage.setItem('fishr.guide', '1'); localStorage.setItem('fishr.keepSafe', String(Date.now())); localStorage.setItem('firetiger.v1', JSON.stringify({ sessions: [{ id: 't-a', date: '2026-07-01', water: 'Keswick River', catches: [] }], notes: [], settings: { season: '2026', temp: 'C' } })); });
    await p.reload(); await p.waitForTimeout(700);
    return { p, ctx };
  }
  const sizes = p => p.evaluate(() => { const f = e => parseFloat(getComputedStyle(e).fontSize); showTab('season'); return { body: f(document.body), h1: f($('screenTitle')), label: f($('wsLine')) }; });

  // Standard text size: exactly the designed sizes.
  let { p, ctx } = await open();
  const std = await sizes(p);
  ok(std.body === 15, 'standard size: body text 15px as designed ' + JSON.stringify(std));
  // Larger Text (iPhone's largest standard setting is 23pt body = 1.35x): text grows, and the page never scrolls sideways.
  const { p: p2, ctx: c2 } = await open({ root: 23 });
  const big = await sizes(p2);
  ok(Math.abs(big.body - 15 * 23 / 17) < 0.2 && Math.abs(big.label - std.label * 23 / 17) < 0.2, `Larger Text: everything scales by 23/17 ${JSON.stringify(big)}`);
  for (const t of ['season', 'patterns', 'advice', 'log']) { await p2.evaluate(t => showTab(t), t); }
  ok(await p2.evaluate(() => document.documentElement.scrollWidth <= document.documentElement.clientWidth), 'Larger Text: no sideways scrolling');
  await p2.evaluate(() => $('dockLog').click()); await p2.waitForTimeout(300);
  const cols = await p2.evaluate(() => { const r = [...document.querySelectorAll('#sheet .row')][0].querySelectorAll('.field'); return r[0].getBoundingClientRect().top === r[1].getBoundingClientRect().top ? 2 : 1; });
  ok(cols === 1, 'Larger Text: paired fields stack so nothing gets cut off');
  // Capped at 1.5x for the accessibility sizes, so the layout holds.
  const { p: p3, ctx: c3 } = await open({ root: 53 });
  ok(Math.abs((await sizes(p3)).body - 22.5) < 0.2, 'accessibility sizes: capped at 1.5x');
  // Smaller text never shrinks fishr below its design (and inputs stay 16px+, so iPhone doesn't zoom on tap).
  const { p: p4, ctx: c4 } = await open({ root: 14 });
  ok((await sizes(p4)).body === 15, 'smaller text setting: stays at the designed size');
  await Promise.all([c2, c3, c4].map(c => c.close()));

  // Logging: − / + for the count.
  await p.evaluate(() => $('dockLog').click()); await p.waitForTimeout(300);
  await p.evaluate(() => $('addCatch').click());
  const step = async d => p.$eval(`.catch-row .step[data-d="${d}"]`, e => e.click());
  await step(1); await step(1); await step(1);
  const n3 = await p.evaluate(() => document.querySelector('.c-n').value);
  await step(-1); await step(-1); await step(-1); await step(-1);
  const n1 = await p.evaluate(() => document.querySelector('.c-n').value);
  await step(1);
  ok(n3 === '4' && n1 === '1', `+ three times: ${n3}; − below 1 stops at ${n1}`);
  await p.evaluate(() => { $('fWaterIn').value = 'Keswick River'; document.querySelector('.c-sp').value = 'Smallmouth bass'; });
  await p.$eval('#saveBtn', e => e.click()); await p.waitForTimeout(400);
  ok(await p.evaluate(() => state.sessions.some(s => s.catches?.[0]?.species === 'Smallmouth bass' && s.catches[0].count === 2)), 'saved with the stepped count (2)');
  // Touch areas: tapping 21px above or below the middle of each small control still hits it.
  await p.waitForFunction(() => $('celebrate').hidden, null, { timeout: 8000 }).catch(() => p.evaluate(() => { $('celebrate').hidden = true; }));
  await p.evaluate(() => $('dockLog').click()); await p.waitForTimeout(300);
  await p.evaluate(() => { $('addCatch').click(); $('moreDetails').open = true; document.activeElement.blur(); }); await p.waitForTimeout(400);
  const hits = await p.evaluate(() => {
    const sel = ['#segCond button', '#segMethod button', '.catch-row .x', '.photo-btn', '#fillWx', '#addCatch', '.combo-btn', '.step'], bad = [];
    for (const s of sel) for (const e of document.querySelectorAll('#sheet ' + s)) {
      e.scrollIntoView({ block: 'center' }); const r = e.getBoundingClientRect(), x = r.left + r.width / 2, y = r.top + r.height / 2;
      for (const [dx, dy] of [[0, -21], [0, 21], [-21, 0], [21, 0]]) { const t = document.elementFromPoint(x + dx, y + dy); const neighbour = dy && t && e.closest('.seg') && t.closest('.seg') === e.closest('.seg'); // chip rows sit 43pt apart: the row below takes over
        if (!t || !(t === e || e.contains(t) || neighbour)) bad.push(`${s} "${e.textContent.trim().slice(0, 12)}" ${dx},${dy} → ${t?.className || t?.tagName}`); }
    }
    return bad;
  });
  ok(!hits.length, 'every small logging control answers a tap 21px from its middle (44-point area; chip rows hand over to the next row, never to nothing) ' + hits.slice(0, 6).join(' | '));
  await p.screenshot({ path: S + '/easy-log.png' });
  await ctx.close();
  // Dark mode: the stepper uses the theme.
  ({ p, ctx } = await open({ dark: true }));
  await p.evaluate(() => { $('dockLog').click(); $('addCatch').click(); document.activeElement.blur(); }); await p.waitForTimeout(400);
  await p.evaluate(() => document.querySelector('.stepper').scrollIntoView({ block: 'center' }));
  const dk = await p.evaluate(() => { const s = getComputedStyle(document.querySelector('.step')); return { c: s.color, bg: getComputedStyle(document.body).backgroundColor }; });
  ok(dk.c !== 'rgb(0, 0, 0)' && dk.c !== dk.bg, 'dark mode: stepper text is light ' + JSON.stringify(dk));
  await p.screenshot({ path: S + '/easy-log-dark.png' });
  await ctx.close();
  ok(!errs.length, 'no page errors ' + errs.join(' | '));
  console.log(res.join('\n')); await b.close();
})().catch(e => { console.log(res.join('\n')); console.error('ERR', e.message.split('\n')[0]); process.exit(1); });
