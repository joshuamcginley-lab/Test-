// Runs every fishr test: server unit tests, then each browser suite against its own fresh local server
// (real Functions code, D1 on node:sqlite, R2 in memory, a fake Claude API). Exits non-zero if anything fails.
//   node tests/run.mjs            everything
//   node tests/run.mjs sweep      just the suites whose name contains "sweep"
//   JOBS=1 node tests/run.mjs     browser suites one at a time (default: 3 at once, the slowest first)
import { spawn, execFileSync } from "node:child_process";
import { readdirSync } from "node:fs";
import { fileURLToPath } from "node:url";
import path from "node:path";

const HERE = path.dirname(fileURLToPath(import.meta.url)), FIX = path.join(HERE, "fixtures");
const only = process.argv[2] || "";
// Suites that check the real daily limits run with the defaults; the rest get room to click around.
const DEFAULT_LIMITS = new Set(["ask-fishr", "fishr-id"]);
const ROOMY = { ID_GUEST: "500", SAMPLE_Q: "500", GUEST_TOTAL: "5000" };
const results = []; let failed = 0;

for (const f of readdirSync(path.join(HERE, "unit")).filter(f => f.endsWith(".mjs") && f.includes(only))) {
  let out = "";
  try { out = execFileSync(process.execPath, ["--no-warnings", path.join(HERE, "unit", f)], { encoding: "utf8" }); } catch (e) { out = (e.stdout || "") + (e.stderr || ""); }
  const m = out.match(/(\d+) passed, (\d+) failed/), fails = out.split("\n").filter(l => l.startsWith("FAIL"));
  const bad = !m || +m[2] > 0;
  if (bad) failed++;
  results.push(`${bad ? "✗" : "✓"} unit/${f}: ${m ? `${m[1]} passed, ${m[2]} failed` : "did not finish"}${fails.length ? "\n    " + fails.join("\n    ") : ""}${!m ? "\n    " + out.trim().split("\n").slice(-3).join("\n    ") : ""}`);
}

// Browser suites run a few at a time, each with its own server and port. The long ones start first so the run
// finishes evenly; results are reported in name order.
const JOBS = Math.max(1, +process.env.JOBS || 3), SLOW = ["sweep", "cloud-sync", "sweep3-data", "bite-index", "first-run", "sweep3-client"];
let port = 8790 + Math.floor(Math.random() * 500);
async function runSuite(f) {
  const name = f.replace(/\.js$/, ""), myPort = ++port, t0 = Date.now();
  const server = spawn(process.execPath, ["--no-warnings", path.join(HERE, "helpers", "devserver.mjs"), String(myPort)], { env: { ...process.env, ...(DEFAULT_LIMITS.has(name) ? {} : ROOMY) }, stdio: "ignore" });
  await new Promise(r => setTimeout(r, 1500));
  const out = await new Promise(resolve => {
    const p = spawn(process.execPath, [path.join(HERE, "e2e", f), FIX, `http://localhost:${myPort}/`], { cwd: HERE });
    let buf = ""; p.stdout.on("data", d => buf += d); p.stderr.on("data", d => buf += d);
    const t = setTimeout(() => { p.kill(); buf += "\nERR timed out"; }, 20 * 60e3);
    p.on("close", code => { clearTimeout(t); resolve({ buf, code }); });
  });
  server.kill();
  const lines = out.buf.split("\n"), pass = lines.filter(l => l.startsWith("PASS")).length;
  const sweep = out.buf.match(/(\d+) pass, (\d+) fail/);
  const fails = lines.filter(l => l.startsWith("FAIL") || l.startsWith("ERR"));
  const bad = out.code !== 0 || fails.length > 0 || (!pass && !sweep);
  if (bad) failed++;
  return { name, line: `${bad ? "✗" : "✓"} e2e/${name}: ${sweep ? `${sweep[1]} passed, ${sweep[2]} failed` : `${pass} passed, ${fails.length} failed`} (${Math.round((Date.now() - t0) / 1000)}s)${fails.length ? "\n    " + fails.slice(0, 8).join("\n    ") : ""}` };
}
const suites = readdirSync(path.join(HERE, "e2e")).filter(f => f.endsWith(".js") && f.includes(only)).sort();
const queue = [...suites].sort((a, b) => { const i = n => { const k = SLOW.indexOf(n.replace(/\.js$/, "")); return k < 0 ? 99 : k; }; return i(a) - i(b); });
const done = [];
await Promise.all(Array.from({ length: Math.min(JOBS, queue.length) }, async () => { while (queue.length) done.push(await runSuite(queue.shift())); }));
results.push(...done.sort((a, b) => a.name.localeCompare(b.name)).map(r => r.line));

console.log(results.join("\n"));
console.log(failed ? `\n${failed} suite(s) failed.` : "\nAll suites passed.");
process.exit(failed ? 1 : 0);
