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

console.log(`${pass} passed, ${failN} failed`);
if (failN) process.exit(1);
