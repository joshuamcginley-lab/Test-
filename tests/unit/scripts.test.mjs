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

console.log(`${pass} passed, ${failN} failed`);
