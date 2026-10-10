"use strict";
/* fishr Bite Index: the scoring itself, shared by the app (live.js) and the server's bite alerts (functions/_alerts.js),
   so a weekend alert and the Guide tab always agree. Pure functions: no page, no storage. Loaded in the page as a
   plain script and on the server as an import; either way it sets globalThis.BiteCore.

   score(ctx, opts): ctx = { c: {temp, press, dp3, wind, sky}, light, flow, model, sp, recentTemp, front }
                     opts = { log: the angler's trips ([] for none), fmtT: °C -> display text (optional) }
   lightAt(t, sun):  how the light is at time t, from the day's sunrise and sunset
   coldFront(H, t):  a cold front just passed or coming, from hourly pressure and temperature */
(function (G) {
  // Feeding comfort ranges in water °C, from published fisheries guidance. Matched by name.
  // What each fish likes, from fisheries research and long angling experience. The Bite Index starts from these
  // rules for the chosen fish; the angler's own log takes over factor by factor as it builds evidence.
  //   lo–hi: water temperature where they feed best (°C); act: the range they stay active in (sluggish outside it).
  //   light: score for golden hour / near dawn or dusk / daylight / after dark.
  //   cloud: overcast vs clear skies; chop: light wind on the water; note: one line on their habits.
  //   bycatch: caught while fishing for something else, rarely the goal, so it never leads "Best bet" (it can be pinned).
  // Temperatures follow published thermal preferences (e.g. Coker, Portt & Minns 2001, Fisheries and Oceans Canada).
  const SPECIES = [
    { re: /smallmouth/i, name: "Smallmouth", lo: 18, hi: 26, act: [10, 29], light: [12, 6, 0, -4], cloud: 4, chop: 5, note: "feed hardest at dawn and dusk, and on windy, overcast days" },
    { re: /largemouth/i, name: "Largemouth", lo: 20, hi: 28, act: [12, 32], light: [14, 6, -2, 0], cloud: 4, chop: 3, note: "ambush in cover; dawn, dusk and warm nights are best" },
    { re: /brook trout|speckled/i, name: "Brook trout", lo: 10, hi: 17, act: [4, 21], light: [14, 8, -2, -6], cloud: 6, chop: 3, note: "cold-water fish; low light and overcast days, and they slow down above 20°C" },
    { re: /rainbow|steelhead/i, name: "Rainbow trout", lo: 12, hi: 18, act: [6, 21], light: [12, 6, 0, -6], cloud: 5, chop: 3, note: "cool water; morning and evening, and they stay active on cloudy days" },
    { re: /brown trout/i, name: "Brown trout", lo: 12, hi: 19, act: [6, 23], light: [14, 8, -4, 2], cloud: 6, chop: 3, note: "wary and light-shy; the big ones feed at dusk and after dark" },
    { re: /lake trout|splake/i, name: "Lake trout", lo: 8, hi: 12, act: [4, 15], light: [4, 2, 2, -8], cloud: 2, chop: 2, note: "deep, cold water; light matters less than temperature" },
    { re: /salmon/i, name: "Salmon", lo: 12, hi: 18, act: [7, 22], light: [10, 6, -2, -10], cloud: 6, chop: 4, note: "take best in cool water at low light, on a dropping or steady river" },
    { re: /char\b/i, name: "Arctic char", lo: 8, hi: 14, act: [3, 16], light: [8, 4, 0, -8], cloud: 4, chop: 2, note: "very cold water; active through the day in the north" },
    { re: /muskie|muskellunge/i, name: "Muskie", lo: 18, hi: 25, act: [10, 28], light: [8, 4, 4, -12], cloud: 3, chop: 4, note: "daytime ambush hunters; fall is their big feeding season" },
    { re: /pike/i, name: "Pike", lo: 12, hi: 21, act: [4, 25], light: [6, 4, 4, -14], cloud: 0, chop: 4, note: "daylight hunters that stay active in cold water" },
    { re: /pickerel/i, name: "Pickerel", lo: 15, hi: 24, act: [5, 28], light: [6, 4, 4, -14], cloud: 0, chop: 2, note: "daylight ambushers in weedy shallows, active even in cold water" },
    { re: /walleye|sauger/i, name: "Walleye", lo: 15, hi: 22, act: [6, 26], light: [16, 10, -6, 8], cloud: 8, chop: 8, note: "light-shy; dusk, night, overcast and a 'walleye chop' are their time" },
    { re: /white perch/i, name: "White perch", lo: 18, hi: 24, act: [10, 28], light: [10, 6, 0, -4], cloud: 2, chop: 2, note: "school up and feed most at dawn and dusk" },
    { re: /perch/i, name: "Perch", lo: 15, hi: 24, act: [6, 27], light: [4, 2, 6, -14], cloud: 2, chop: 2, note: "daytime schoolers; they stop feeding after dark" },
    { re: /crappie|bluegill|pumpkinseed|sunfish|rock bass/i, name: "Panfish", lo: 18, hi: 27, act: [12, 31], light: [6, 4, 4, -10], cloud: -2, chop: -2, note: "warm, sunny shallows through the day" },
    { re: /catfish|bullhead/i, name: "Catfish", lo: 21, hi: 29, act: [16, 32], light: [6, 6, -6, 12], cloud: 2, chop: 0, note: "feed by smell, mostly at night" },
    { re: /carp/i, name: "Carp", lo: 18, hi: 28, act: [12, 32], light: [4, 2, 2, 0], cloud: 0, chop: 0, note: "warm water; steady feeders whatever the light" },
    { re: /chub|fallfish/i, name: "Chub", lo: 12, hi: 24, act: [8, 27], light: [6, 4, 2, -8], cloud: 2, chop: 0, bycatch: true, note: "daytime river fish, active over a wide range of temperatures" },
    { re: /striped bass|white bass/i, name: "Striped bass", lo: 15, hi: 22, act: [8, 25], light: [14, 8, -4, 6], cloud: 5, chop: 4, note: "low light and moving water; dawn, dusk and night" },
    { re: /whitefish/i, name: "Whitefish", lo: 10, hi: 14, act: [4, 18], light: [6, 4, 2, -8], cloud: 3, chop: 2, note: "cold, deep water; steady through the day" },
  ];
  const SPECIES_TEMPS = SPECIES.map(f => [f.re, f.name, f.lo, f.hi]); // the older shape, kept for callers that use it

  // Roughly where each fish lives (native or well established) in North America, so a fish that isn't found near the
  // angler isn't offered (no walleye in New Brunswick). Approximate on purpose: an angler's own catches always count.
  const MARITIMES = (la, lo) => la > 43.3 && la < 48.1 && lo > -69.1 && lo < -59.7; // NB, NS, PEI
  const NFLD = (la, lo) => la > 46.5 && la < 52 && lo > -59.7 && lo < -52;
  const EAST = lo => lo > -100;
  const RANGE = {
    "Smallmouth": (la, lo) => la > 25 && la < 50 && !NFLD(la, lo),
    "Largemouth": (la, lo) => la > 24 && la < 48 && !MARITIMES(la, lo) && !NFLD(la, lo),
    "Brook trout": la => la > 34,
    "Rainbow trout": la => la > 30,
    "Brown trout": la => la > 30 && la < 56,
    "Lake trout": (la, lo) => la > 41 && !NFLD(la, lo),
    "Salmon": (la, lo) => la > 40 && (lo > -93 || lo < -114),
    "Arctic char": (la, lo) => la > 52 || NFLD(la, lo),
    "Muskie": (la, lo) => la > 36 && la < 50 && lo > -97 && lo < -66.5,
    "Pike": (la, lo) => la > 38 && !MARITIMES(la, lo) && !NFLD(la, lo),
    "Pickerel": (la, lo) => la > 25 && la < 48 && EAST(lo) && lo > -92 && !NFLD(la, lo),
    "Walleye": (la, lo) => la > 30 && !MARITIMES(la, lo) && !NFLD(la, lo),
    "White perch": (la, lo) => la > 33 && la < 48 && lo > -90 && !NFLD(la, lo),
    "Perch": (la, lo) => la > 34 && !NFLD(la, lo),
    "Panfish": (la, lo) => la < 52 && !NFLD(la, lo),
    "Catfish": (la, lo) => la < 50 && !NFLD(la, lo),
    "Carp": (la, lo) => la < 50 && !MARITIMES(la, lo) && !NFLD(la, lo),
    "Chub": (la, lo) => la < 55 && EAST(lo) && !NFLD(la, lo),
    "Striped bass": (la, lo) => (lo > -77.5 && la < 48.3 && !NFLD(la, lo)) || la < 38, // Atlantic coast and its rivers; southern reservoirs
    "Whitefish": (la, lo) => la > 40 && !NFLD(la, lo),
  };
  // Is this fish found around lat/lon? With no location, every fish counts.
  const foundNear = (sp, lat, lon) => lat == null || lon == null || !RANGE[sp] || RANGE[sp](lat, lon);

  // "Best bet": the Bite Index scores each fish an angler goes after and leads with whichever is biting best now.
  // Their fish are the ones they've caught 3 or more of (up to 4, most-caught first). Someone without a log gets the
  // most commonly fished species found around them, from North American angler surveys (bass, trout and walleye lead).
  const POPULAR = ["Smallmouth", "Brook trout", "Walleye", "Largemouth", "Rainbow trout", "Pike", "Perch", "Salmon", "Panfish", "Catfish",
    "Striped bass", "Pickerel", "Brown trout", "Lake trout", "Muskie", "White perch", "Carp", "Whitefish", "Arctic char"];
  function yourFish(log) {
    const n = {};
    for (const s of log || []) for (const c of s.catches || []) { const i = speciesInfo(c.species); if (i) n[i.name] = (n[i.name] || 0) + (+c.count || 0); }
    return Object.entries(n).filter(([, k]) => k >= 3).sort((a, b) => b[1] - a[1]).slice(0, 4).map(([k]) => k);
  }
  function betCandidates(log, lat, lon) {
    const own = yourFish(log).filter(n => !profileOf(n)?.bycatch); // fish they go after, not what came along
    return own.length ? own : POPULAR.filter(n => foundNear(n, lat, lon)).slice(0, 3);
  }
  const speciesInfo = name => { const f = SPECIES.find(x => x.re.test(name || "")); return f ? { ...f } : null; };
  const profileOf = sp => sp ? SPECIES.find(f => f.name === sp) || null : null;
  // The fish an angler catches most, if it's a real share of the catch (at least 40%, and 3 or more fish): the
  // fish the Bite Index scores for by default, in the app and in bite alerts.
  function topSpecies(log) {
    const n = {}; let total = 0;
    for (const s of log || []) for (const c of s.catches || []) { const k = +c.count || 0; total += k; const i = speciesInfo(c.species); if (i) n[i.name] = (n[i.name] || 0) + k; }
    const [name, k] = Object.entries(n).sort((a, b) => b[1] - a[1])[0] || [];
    return name && k >= 3 && k / total >= 0.4 ? name : null;
  }
  const fishOf = s => (s.catches || []).reduce((a, c) => a + (+c.count || 0), 0);
  const fishFor = (s, sp) => sp ? (s.catches || []).filter(c => speciesInfo(c.species)?.name === sp).reduce((a, c) => a + (+c.count || 0), 0) : fishOf(s);
  const r = (x, d = 0) => Math.round(x * 10 ** d) / 10 ** d;

  // Buckets a past trip falls into, to compare like with like.
  const PERIOD_HOUR = { Morning: 8, Midday: 13, Afternoon: 16.5, Evening: 19.5 };
  const clock = t => { const [a, b] = String(t).split(":").map(Number); return a + (b || 0) / 60; };
  // The middle of the trip; a trip past midnight (22:00–02:00) is centred at midnight, not noon.
  const midHour = (a, b) => { if (b < a) b += 24; return ((a + b) / 2) % 24; };
  const tripHour = s => s.start ? (s.end ? midHour(clock(s.start), clock(s.end)) : clock(s.start)) : PERIOD_HOUR[s.period] ?? null;
  const lightOf = h => h == null ? null : h < 5 || h >= 21 ? "dark" : h < 9 || h >= 18 ? "low" : "day";
  const conds = s => s.conditions || [];
  const BUCKETS = {
    light: s => lightOf(tripHour(s)),
    press: s => s.wx?.trend || null,
    level: s => s.flow?.status || (conds(s).includes("High water") ? "High" : conds(s).includes("Low water") ? "Low" : null),
    wind: s => s.wx?.wind != null ? windOf(s.wx.wind) : conds(s).includes("Windy") ? "breezy" : conds(s).includes("Calm") ? "calm" : null,
    sky: s => { const k = s.wx?.sky || (conds(s).includes("Overcast") || conds(s).includes("Rain") ? "Overcast" : conds(s).includes("Sunny") ? "Sunny" : null); return k == null ? null : k === "Sunny" || k === "Clear" ? "clear" : "cloud"; },
  };
  const windOf = k => k == null ? null : k < 6 ? "calm" : k <= 20 ? "light" : k <= 30 ? "breezy" : "strong";

  // How a bucket did in the angler's log: fish per trip in that bucket vs all trips with that information.
  function personalEffect(log, bucketOf, current, sp) {
    if (current == null || !log?.length) return null;
    const rows = log.map(s => ({ b: bucketOf(s), f: fishFor(s, sp) })).filter(x => x.b != null);
    if (rows.length < 8) return null;
    const inB = rows.filter(x => x.b === current); if (inB.length < 3) return null;
    const avg = xs => xs.reduce((a, x) => a + x.f, 0) / xs.length, all = avg(rows), mine = avg(inB);
    if (!all) return null;
    return { p: Math.max(-15, Math.min(15, (mine / all - 1) * 20)), w: inB.length / (inB.length + 6), n: inB.length, mine, all };
  }

  function score(ctx, opts = {}) {
    const { c, light, flow, model, sp, recentTemp, front } = ctx, d = [], log = opts.log || [], fmtT = opts.fmtT || (t => `${r(t)}°C`);
    const unit = sp ? sp.toLowerCase() : "fish", memo = opts.memo || new Map();
    // A factor: a general default, blended with the angler's log once it has evidence for the same conditions.
    const prof = profileOf(sp);
    const factor = (def, label, bucket, current, what, own = false) => { // own: the default came from the fish's profile
      const key = `${bucket}|${current}|${sp || ""}`;
      if (!memo.has(key)) memo.set(key, personalEffect(log, BUCKETS[bucket], current, sp));
      const e = memo.get(key);
      const v = e ? Math.round(def * (1 - e.w) + e.p * e.w) : def;
      const mine = !!e && e.w >= 0.4;
      // Say where the number comes from: the general rule (the fish's own, if one is chosen), and how far this
      // angler's log moved it.
      const sgn = x => (x > 0 ? "+" : x < 0 ? "−" : "±") + Math.abs(x);
      const rule = prof && own ? `The rule for ${sp.toLowerCase()}` : "The general rule";
      const why = mine ? `Your log: ${e.mine.toFixed(1)} ${unit} per trip on ${what}, vs ${e.all.toFixed(1)} across your trips (${e.n} trips). ${def ? `${rule} gives ${sgn(def)}; your log makes it ${sgn(v)}.` : `So it counts ${sgn(v)}.`}`
        : prof && own && v ? `${sp}: ${prof.note}. Until your log has enough ${what} to go on, that rule gives ${sgn(v)}.` : null;
      d.push({ v, label, mine, why });
    };
    const lightNow = light.golden || light.nearHrs <= 3 ? "low" : light.dark ? "dark" : "day"; // within 3 h of sunrise or sunset counts as low light, even after dark
    // Light: golden hour / near dawn or dusk / daylight / after dark. Each fish has its own (walleye love the dark,
    // pike and perch hunt by day); without a fish, the general rule.
    const L = prof ? prof.light : [14, 6, 0, -6];
    if (light.golden) factor(L[0], light.goldenLabel, "light", "low", "dawn and dusk trips", true);
    else if (lightNow === "low") factor(L[1], "Near dawn or dusk", "light", "low", "dawn and dusk trips", true);
    else if (lightNow === "dark") factor(L[3], "After dark", "light", "dark", "night trips", true);
    else factor(L[2], "Daylight", "light", "day", "daytime trips", true);
    if (c.dp3 != null && c.dp3 <= -3) factor(12, "Pressure dropping fast", "press", "Falling", "falling-pressure trips");
    else if (c.press === "Falling") factor(9, "Falling pressure", "press", "Falling", "falling-pressure trips");
    else if (c.press === "Steady") factor(4, "Stable pressure", "press", "Steady", "steady-pressure trips");
    else if (c.press === "Rising") factor(-6, "Rising pressure", "press", "Rising", "rising-pressure trips");
    // Temperature: for a chosen species, its comfort range (using the recent average, which water follows); otherwise air temp.
    if (prof && recentTemp != null) {
      // Their feeding range, then the wider range they stay active in; past that they're sluggish.
      const t = recentTemp, side = t < prof.lo ? "cool" : "warm", [a0, a1] = prof.act;
      const why = `Temperatures here have averaged ${fmtT(r(t, 0))} lately, and water follows that. ${sp} feed best in ${fmtT(prof.lo).replace(/°.*$/, "")}–${fmtT(prof.hi)} water and slow right down below ${fmtT(a0)} or above ${fmtT(a1)}.`;
      d.push(t >= prof.lo && t <= prof.hi ? { v: 10, label: `Good temps for ${unit}`, why }
        : t >= a0 && t <= a1 ? { v: -4, label: `A bit ${side} for ${unit}`, why }
        : { v: -15, label: `Too ${side === "cool" ? "cold" : "warm"} for ${unit}`, why });
    } else if (c.temp != null) {
      if (c.temp >= 15 && c.temp <= 25) d.push({ v: 8, label: "Prime air temp" }); else if (c.temp < 8 || c.temp > 30) d.push({ v: -12, label: c.temp < 8 ? "Cold" : "Heat" });
    }
    if (c.temp > 25 && light.midday) d.push({ v: -8, label: "Midday heat" });
    if (flow) {
      if (flow.status === "High") factor(flow.trend === "rising" ? -15 : -10, flow.trend === "rising" ? "High, rising water" : "High water", "level", "High", "high-water trips");
      else if (flow.status === "Low") factor(-4, "Low water", "level", "Low", "low-water trips");
      else factor(5, "Normal river level", "level", "Normal", "normal-water trips");
    }
    const w = windOf(c.wind);
    if (w === "light") factor(prof ? prof.chop : 4, "Light chop", "wind", "light", "light-wind trips", true);
    else if (w === "strong") factor(-10, "Strong wind", "wind", "strong", "strong-wind trips");
    else if (w) factor(0, w === "calm" ? "Calm" : "Breezy", "wind", w, w === "calm" ? "calm trips" : "breezy trips");
    // Cloud: a fish that likes it dim gets the bonus under cloud and loses a little in bright sun; sun-lovers the reverse.
    const cl = prof ? prof.cloud : 5;
    if (c.sky === "Overcast" || c.sky === "Rain") factor(cl, "Cloud cover", "sky", "cloud", "overcast trips", true);
    else if (c.sky) factor(prof && cl >= 5 ? -2 : prof && cl < 0 ? 2 : 0, "Clear skies", "sky", "clear", "clear-sky trips", true);
    if (front) d.push(front.passed ? { v: front.hrs <= 24 ? -10 : -5, label: front.hrs <= 24 ? "Just after a cold front" : "Day after a cold front", front }
      : { v: 5, label: front.hrs <= 6 ? "Cold front due today" : "Cold front coming", front });
    if (model) d.push({ v: Math.max(-15, Math.min(15, Math.round(model.delta))), label: model.label });
    const total = Math.max(5, Math.min(98, Math.round(50 + d.reduce((a, x) => a + x.v, 0))));
    return { score: total, label: total >= 75 ? "Prime" : total >= 58 ? "Good" : total >= 40 ? "Fair" : "Slow", drivers: d.filter(x => x.v).sort((a, b) => Math.abs(b.v) - Math.abs(a.v)) };
  }

  // The light at time t (ms), given that day's sunrise and sunset (ms). Same rules as the Guide tab's live card.
  function lightAt(t, rise, set) {
    const toRise = rise - t, toSet = set - t, dark = t < rise || t > set;
    const goldenEve = toSet <= 75 * 60e3 && toSet > -20 * 60e3, goldenMorn = toRise <= 20 * 60e3 && toRise > -75 * 60e3;
    return { golden: goldenEve || goldenMorn, goldenLabel: goldenEve ? "Evening golden hour" : "Morning golden hour", dark, nearHrs: Math.min(Math.abs(toRise), Math.abs(toSet)) / 3600e3 };
  }

  // Cold fronts, from the hourly pressure and temperature around now. A front shows as a pressure low followed by a
  // sharp rise, with the day after it clearly colder than the day before. Fish often feed ahead of one and go quiet
  // for a day or so after it. H: [{ time: Date, temp, p }] in order. Returns { passed: true, hrs, drop, rise },
  // { passed: false, hrs, drop } or null.
  function coldFront(H, now) {
    const at = H.findIndex(h => h.time > now) - 1; if (at < 0) return null;
    const ok = h => h && h.p != null && h.temp != null, mean = xs => xs.reduce((a, h) => a + h.temp, 0) / xs.length;
    const win = (a, b) => H.slice(Math.max(0, at + a), Math.max(0, at + b + 1)).filter(ok);
    const low = xs => xs.reduce((m, h) => h.p < m.p ? h : m);
    const pNow = H[at].p;
    if (pNow == null) return null;
    // Passed: the lowest pressure of the last 36 hours was 3+ hours ago, pressure is up 4+ hPa since, and the last 24
    // hours ran 5°C+ colder than the 24 before.
    const back = win(-36, -3), before = win(-47, -24), since = win(-23, 0);
    if (back.length >= 24 && before.length >= 18 && since.length >= 18) {
      const m = low(back), rise = pNow - m.p, drop = mean(before) - mean(since);
      if (rise >= 4 && drop >= 5) return { passed: true, hrs: Math.round((now - m.time) / 36e5), drop, rise };
    }
    // Coming: the forecast has a pressure low in the next 24 hours, a 3+ hPa rise behind it, and the next day 5°C+ colder.
    const ahead = win(1, 24), after = win(1, 36), last = win(-23, 0);
    if (ahead.length >= 18 && last.length >= 18) {
      const m = low(ahead), backUp = Math.max(...after.filter(h => h.time > m.time).map(h => h.p)) - m.p;
      const drop = mean(last) - mean(after.filter(h => h.time > m.time).length >= 6 ? after.filter(h => h.time > m.time) : ahead);
      if (m.p <= pNow - 2 && backUp >= 3 && drop >= 5) return { passed: false, hrs: Math.max(1, Math.round((m.time - now) / 36e5)), drop };
    }
    return null;
  }

  /* ---------- The Guide's call: which water (and lure, spot) did best in conditions like these ---------- */
  // Every past trip is weighted by how similar its conditions were (temperature, time of day, time of year, sky,
  // pressure, river level); waters are ranked by weighted fish per trip, pulled toward the angler's average when the
  // evidence is thin. q = { temp, hour, doy, sky, press, flow }.
  const avgT = s => s.tempLow == null ? null : (s.tempLow + (s.tempHigh ?? s.tempLow)) / 2;
  const dayOfYear = iso => { const d = new Date(iso + "T12:00:00"); return Math.round((d - new Date(d.getFullYear(), 0, 1)) / 864e5); };
  const gauss = (d, sd) => Math.exp(-0.5 * (d / sd) ** 2);
  const tripSky = s => conds(s).includes("Rain") ? "Rain" : conds(s).includes("Overcast") ? "Overcast" : null;
  function similarity(s, q) {
    const k = q.k || 1; // widens every tolerance when nothing in the log is close
    const t = avgT(s);
    const wT = t == null ? 0.35 : gauss(t - q.temp, 3.5 * k);
    const h = tripHour(s);
    const wH = h == null ? 0.5 : gauss(Math.min(Math.abs(h - q.hour), 24 - Math.abs(h - q.hour)), 2.2 * k);
    let dd = Math.abs(dayOfYear(s.date) - q.doy); dd = Math.min(dd, 365 - dd);
    const wS = 0.3 + 0.7 * gauss(dd, 40 * k);
    const sky = tripSky(s);
    const wC = q.sky && sky ? (sky === q.sky || (q.sky !== "Clear" && sky !== "Clear") ? 1.25 : 0.8) : 1;
    const wP = q.press && s.wx?.trend ? (s.wx.trend === q.press ? 1.3 : 0.75) : 1;
    const lvl = BUCKETS.level(s), wF = q.flow && lvl ? (lvl === q.flow ? 1.35 : 0.7) : 1;
    return wT * wH * wS * wC * wP * wF;
  }
  function rankWaters(log, q) {
    const trips = log.filter(s => s.water);
    const scored = trips.map(s => ({ s, w: similarity(s, q), f: fishOf(s) }));
    const totW = scored.reduce((a, x) => a + x.w, 0) || 1;
    const globalRate = scored.reduce((a, x) => a + x.w * x.f, 0) / totW;
    const byWater = new Map();
    for (const x of scored) { if (!byWater.has(x.s.water)) byWater.set(x.s.water, []); byWater.get(x.s.water).push(x); }
    const K = 2; // pulls thin evidence toward the angler's overall average
    // That average only counts waters that can make the list: one big day on a water fished once mustn't lift a
    // water that skunked every time above one that keeps producing.
    const minTrips = (q.k || 1) > 1 ? 1 : 2, eligible = scored.filter(x => byWater.get(x.s.water).length >= minTrips);
    const eW = eligible.reduce((a, x) => a + x.w, 0), prior = eW ? eligible.reduce((a, x) => a + x.w * x.f, 0) / eW : globalRate;
    const rows = [...byWater].map(([water, xs]) => {
      const W = xs.reduce((a, x) => a + x.w, 0), W2 = xs.reduce((a, x) => a + x.w * x.w, 0);
      const fishW = xs.reduce((a, x) => a + x.w * x.f, 0), skunkW = xs.reduce((a, x) => a + x.w * (x.f ? 0 : 1), 0);
      const neff = W2 ? W * W / W2 : 0;
      const similar = xs.filter(x => x.w >= 0.2).sort((a, b) => b.w - a.w);
      return { water, est: (fishW + K * prior) / (W + K), raw: W ? fishW / W : 0, skunk: W ? skunkW / W : 0, neff, W, trips: xs.length, similar, xs };
    }).filter(r => r.trips >= minTrips);
    rows.sort((a, b) => b.est - a.est);
    const sim = scored.filter(x => x.w >= 0.2);
    return { rows, globalRate, nSimilar: sim.length, skunkSimilar: sim.length ? sim.filter(x => !x.f).length / sim.length : 0, anySeason: scored.some(x => { let dd = Math.abs(dayOfYear(x.s.date) - q.doy); return Math.min(dd, 365 - dd) <= 30; }) };
  }
  function bestOf(xs, key) {
    const t = {};
    for (const x of xs) for (const c of x.s.catches || []) { const k = key(c, x.s); if (k) t[k] = (t[k] || 0) + x.w * (+c.count || 0); }
    return Object.entries(t).sort((a, b) => b[1] - a[1])[0]?.[0] || null;
  }
  function bestSpot(xs) {
    const t = {};
    for (const x of xs) if (x.s.spot) t[x.s.spot] = (t[x.s.spot] || 0) + x.w * (x.f + 0.2);
    return Object.entries(t).sort((a, b) => b[1] - a[1])[0]?.[0] || null;
  }
  // Start strict, then widen the tolerances step by step until some water has enough evidence.
  // Always returns a ranking, so the Guide never answers "nothing works".
  const WIDEN = [1, 1.6, 2.5, 4, 8];
  function bestRanking(log, q, minNeff = 1) {
    let res = null;
    for (const k of WIDEN) {
      res = rankWaters(log, { ...q, k });
      const rows = res.rows.filter(x => x.W >= 0.6 && x.neff >= minNeff);
      if (rows.length) return { res, rows, k };
    }
    return { res, rows: res.rows, k: WIDEN[WIDEN.length - 1] };
  }
  // The call in short: the top water, and the spot and lure that did best there in similar trips.
  function bestCall(log, q) {
    const { rows, k } = bestRanking(log, q), top = rows[0];
    if (!top) return null;
    const simTop = top.similar.length ? top.similar : [...top.xs].sort((a, b) => b.w - a.w);
    return { water: top.water, spot: bestSpot(simTop), lure: bestOf(simTop, c => c.lure), est: top.est, k, neff: top.neff };
  }

  G.BiteCore = { SPECIES, SPECIES_TEMPS, speciesInfo, profileOf, topSpecies, foundNear, yourFish, betCandidates, fishFor, windOf, lightOf, tripHour, BUCKETS, personalEffect, score, lightAt, coldFront,
    avgT, dayOfYear, similarity, rankWaters, bestOf, bestSpot, bestRanking, bestCall };
})(typeof globalThis !== "undefined" ? globalThis : self);
