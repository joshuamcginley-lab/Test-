// The app's scripts are plain <script> tags that share one global scope, so a top-level name declared in two
// files (say `const skyOf` in both forecast.js and live.js) throws on load and takes the second file down.
// Compiling them as one script in page order catches that, plus any syntax error.
import fs from "node:fs";
import vm from "node:vm";
const ROOT = new URL("../../", import.meta.url).pathname;
let pass = 0, failN = 0; const ok = (c, m) => { if (c) pass++; else { failN++; console.log("FAIL:", m); } };

const html = fs.readFileSync(ROOT + "index.html", "utf8");
const srcs = [...html.matchAll(/<script[^>]*\ssrc="([^"]+\.js)[^"]*"/g)].map(m => m[1]).filter(s => !/^https?:/.test(s));
ok(srcs.length >= 10, "found the app scripts in index.html: " + srcs.join(", "));
for (const s of srcs) {
  try { new vm.Script(fs.readFileSync(ROOT + s, "utf8"), { filename: s }); ok(true, s); } catch (e) { ok(false, `${s}: ${e.message}`); }
}
// Top-level let/const/class/function names, per file; any repeat across files breaks the page.
const seen = new Map();
for (const s of srcs) {
  const src = fs.readFileSync(ROOT + s, "utf8");
  for (const m of src.matchAll(/^(?:const|let|class|function\*?|async function)\s+([A-Za-z_$][\w$]*)/gm)) {
    const prev = seen.get(m[1]);
    ok(!prev || prev === s, `${m[1]} is declared in both ${prev} and ${s}`);
    if (!prev) seen.set(m[1], s);
  }
}
try { new vm.Script(srcs.map(s => fs.readFileSync(ROOT + s, "utf8")).join("\n;\n"), { filename: "all-scripts.js" }); ok(true, "combined"); }
catch (e) { ok(false, "scripts don't load together: " + e.message); }

// Every script and the stylesheet carry the release number, and the offline cache stores those exact URLs. Without
// it, a phone on a weak signal can get the new page with an old cached script, which crashes before the welcome
// screen shows (that happened when the top-bar Sample button was removed).
{
  const sw = fs.readFileSync(ROOT + "sw.js", "utf8"), v = sw.match(/VERSION = "fishr-v(\d+)"/)?.[1];
  ok(v, "sw.js has a numbered VERSION");
  const assets = [...html.matchAll(/<(?:script[^>]*\ssrc|link[^>]*rel="stylesheet"[^>]*\shref)="([^"]+)"/g)].map(m => m[1]).filter(u => !/^https?:/.test(u));
  ok(assets.length >= 13, "found scripts and stylesheet: " + assets.length);
  for (const a of assets) {
    ok(a.endsWith(`?v=${v}`), `${a} carries ?v=${v} (bump it with the service worker VERSION)`);
    ok(sw.includes(`"${a}"`), `sw.js caches ${a}`);
  }
}

console.log(`${pass} passed, ${failN} failed`);
