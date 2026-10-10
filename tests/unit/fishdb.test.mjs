// The fish database behind the Bite Index: each fish's rules, where it lives, and that the rules move the score.
await import("../../bite-core.js");
const C = globalThis.BiteCore;
let pass = 0, failN = 0;
const ok = (c, m) => { if (c) pass++; else { failN++; console.log("FAIL:", m); } };

ok(C.SPECIES.length >= 20 && C.SPECIES.every(f => f.re && f.name && f.lo < f.hi && f.act[0] < f.lo && f.act[1] > f.hi && f.light.length === 4 && typeof f.cloud === "number" && typeof f.chop === "number" && f.note), "every fish has a full profile");
ok(["Muskellunge", "White perch", "Yellow perch", "Northern pike", "Chain pickerel", "Brown bullhead", "Pumpkinseed", "Fallfish"].map(n => C.speciesInfo(n)?.name).join() === "Muskie,White perch,Perch,Pike,Pickerel,Catfish,Panfish,Chub", "common names map to the right fish");

// Where they live.
const near = (la, lo) => C.SPECIES.map(f => f.name).filter(n => C.foundNear(n, la, lo));
const fred = near(45.96, -66.64), tor = near(43.65, -79.38), nl = near(47.56, -52.71);
ok(!fred.includes("Walleye") && !fred.includes("Pike") && !fred.includes("Carp") && ["Smallmouth", "Brook trout", "Salmon", "Muskie", "Pickerel", "Striped bass"].every(n => fred.includes(n)), "Fredericton: no walleye, pike or carp; trout, salmon, bass, muskie, pickerel and stripers " + fred);
ok(["Walleye", "Pike", "Largemouth"].every(n => tor.includes(n)) && !tor.includes("Striped bass"), "Toronto: walleye, pike, largemouth; no striped bass " + tor);
ok(nl.includes("Arctic char") && !nl.includes("Smallmouth") && !nl.includes("Perch"), "Newfoundland: char, but no bass or perch " + nl);
ok(C.foundNear("Walleye", null, null), "no location: every fish is offered");

// The rules move the score the right way.
const at = (sp, o = {}) => C.score({ c: { temp: 20, sky: "Overcast", press: "Steady", wind: 12, ...o.c }, light: { golden: false, nearHrs: 6, dark: true, midday: false, ...o.light }, flow: null, model: null, sp, recentTemp: o.t ?? 19, front: null });
const night = sp => at(sp).score, day = sp => at(sp, { light: { dark: false } }).score;
ok(night("Walleye") > night("Pike") && night("Catfish") > night("Perch"), `after dark: walleye ${night("Walleye")} > pike ${night("Pike")}, catfish ${night("Catfish")} > perch ${night("Perch")}`);
ok(day("Pike") > night("Pike") && day("Perch") > night("Perch") && night("Walleye") > day("Walleye"), "pike and perch are daytime fish; walleye prefer the dark");
const cold = at("Smallmouth", { t: 3 }), trout = at("Brook trout", { t: 6 });
ok(cold.drivers.some(d => d.label === "Too cold for smallmouth" && d.v === -15) && !trout.drivers.some(d => /Too cold/.test(d.label)), "3°C is too cold for smallmouth; 6°C is still fine-ish for brook trout");
const why = at("Walleye").drivers.find(d => d.label === "After dark")?.why || "";
ok(/^Walleye: light-shy/.test(why) && /that rule gives \+8/.test(why), "a fish's rule explains itself: " + why);

// The fish an angler catches most (≥40% of the catch, 3+ fish) is the default.
const T = (sp, n) => ({ date: "2026-06-01", water: "W", catches: [{ species: sp, count: n }] });
ok(C.topSpecies([T("Smallmouth bass", 6), T("Brook trout", 2)]) === "Smallmouth" && C.topSpecies([T("Perch", 1), T("Pike", 1)]) === null && C.topSpecies([]) === null, "top species: a real share of the catch, or none");

// Best bet: an angler's fish (3+ caught, most first), or the common fish found around someone without a log.
const log2 = [T("Smallmouth bass", 9), T("Brook trout", 5), T("Perch", 1)];
ok(C.betCandidates(log2, 45.96, -66.64).join() === "Smallmouth,Brook trout", "their fish: 3+ caught, most first " + C.betCandidates(log2, 45.96, -66.64));
ok(C.betCandidates([], 45.96, -66.64).join() === "Smallmouth,Brook trout,Rainbow trout" && C.betCandidates([], 43.65, -79.38).join() === "Smallmouth,Brook trout,Walleye", "no log: the common local fish (no walleye in NB, walleye in Ontario) " + C.betCandidates([], 45.96, -66.64) + " / " + C.betCandidates([], 43.65, -79.38));
// The lead switches with the conditions: cold water favours trout, warm water bass.
const lead = t => ["Smallmouth", "Brook trout"].map(sp => [sp, at(sp, { t, light: { dark: false, golden: true, goldenLabel: "Evening golden hour" } }).score]).sort((a, b) => b[1] - a[1])[0][0];
ok(lead(6) === "Brook trout" && lead(22) === "Smallmouth", `6°C → ${lead(6)}, 22°C → ${lead(22)}`);
// Bite alerts use the best of the angler's fish for each hour.
const A = await import("../../functions/_alerts.js");
const hours = 24 * 5, t0 = Date.parse("2026-10-14T00:00:00Z") / 1000;
const W = { latitude: 45.96, longitude: -66.64, utc_offset_seconds: -3 * 3600, hourly: { time: Array.from({ length: hours }, (_, i) => t0 + i * 3600), temperature_2m: Array(hours).fill(7), weather_code: Array(hours).fill(3), pressure_msl: Array(hours).fill(1013), wind_speed_10m: Array(hours).fill(10) },
  daily: { time: [0, 1, 2, 3, 4].map(d => t0 + d * 86400), sunrise: [0, 1, 2, 3, 4].map(d => t0 + d * 86400 + 10.5 * 3600), sunset: [0, 1, 2, 3, 4].map(d => t0 + d * 86400 + 21.5 * 3600) } };
const wins = A.scoreWindows(W, { log: log2 }), solo = A.scoreWindows(W, { log: [T("Smallmouth bass", 9)] });
ok(wins.length && wins.every((w, i) => w.score >= solo[i].score) && wins.some((w, i) => w.score > solo[i].score), "alerts: a bass-and-trout angler's cold-water windows score as trout, above bass-only " + wins.slice(0, 2).map(w => w.score) + " vs " + solo.slice(0, 2).map(w => w.score));

console.log(`${pass} passed, ${failN} failed`);
if (failN) process.exit(1);
