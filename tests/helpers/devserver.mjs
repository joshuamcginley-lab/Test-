// Serves the app plus the cloud Functions (D1 on node:sqlite, R2 in memory) for e2e tests.
import http from "node:http"; import fs from "node:fs"; import path from "node:path";
import { d1, r2 } from "./cfmock.mjs";
import { fileURLToPath } from "node:url";
const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../.."), F = ROOT + "/functions/", PORT = +process.argv[2] || 8790;
const env = { DB: d1(), CATCHES: r2(), ADMIN_KEY: "test-admin", CLOUD_PRO_ONLY: process.env.PRO_ONLY || "", ANTHROPIC_API_KEY: process.env.NO_AI ? "" : "sk-test", AI_DAILY_ID_GUEST: process.env.ID_GUEST || "", AI_DAILY_SAMPLE: process.env.SAMPLE_Q || "", AI_DAILY_GUEST_TOTAL: process.env.GUEST_TOTAL || "", ASSETS: { fetch: async u => new Response(fs.readFileSync(ROOT + new URL(u).pathname)) } };
// Fake Claude API so tests never spend money: answers depend on what was asked.
const realFetch = globalThis.fetch; globalThis.aiCalls = [];
globalThis.fetch = async (url, init) => {
  const u = String(url instanceof Request ? url.url : url);
  if (!u.startsWith("https://api.anthropic.com/")) return realFetch(url, init);
  const body = JSON.parse(init.body); globalThis.aiCalls.push(body);
  await new Promise(r => setTimeout(r, 400));
  const img = Array.isArray(body.messages.at(-1).content);
  const text = img ? JSON.stringify({ is_fish: true, species: "Smallmouth bass", confidence: "high", alternatives: ["Largemouth bass", "Rock bass"], reason: "Bronze body with dark vertical bars; jaw ends below the eye." })
    : "Fish the Keswick River near the mouth from 6:30 to 8:30 pm. On 10 similar warm evenings there, this log caught 27 fish, mostly smallmouth on a chatterbait.\n- Backup: Peniac Stream, about 1.8 fish per trip.";
  return new Response(JSON.stringify({ id: "msg_t", type: "message", role: "assistant", model: body.model, stop_reason: "end_turn", content: [{ type: "text", text }], usage: { input_tokens: 1, output_tokens: 1 } }), { status: 200, headers: { "content-type": "application/json" } });
};
const ask = await import(F + "api/ai/ask.js"), ident = await import(F + "api/ai/identify.js");
const auth = await import(F + "api/auth/[action].js"), syncFn = await import(F + "api/sync.js"), photo = await import(F + "api/photo/[id].js"), account = await import(F + "api/account.js");
const usage = await import(F + "api/usage.js"), errorsFn = await import(F + "api/errors.js");
const routes = [
  [/^\/api\/usage$/, () => ({ fn: ctx => ctx.request.method === "GET" ? usage.onRequestGet(ctx) : usage.onRequestPost(ctx) })],
  [/^\/api\/errors$/, () => ({ fn: ctx => ctx.request.method === "GET" ? errorsFn.onRequestGet(ctx) : errorsFn.onRequestPost(ctx) })],
  [/^\/api\/auth\/([\w-]+)$/, m => ({ fn: auth.onRequest, params: { action: m[1] } })],
  [/^\/api\/sync$/, () => ({ fn: syncFn.onRequestPost, method: "POST" })],
  [/^\/api\/photo\/([^/]+)$/, m => ({ fn: photo.onRequest, params: { id: decodeURIComponent(m[1]) } })],
  [/^\/api\/ai\/ask$/, () => ({ fn: ctx => ctx.request.method === "GET" ? ask.onRequestGet(ctx) : ask.onRequestPost(ctx) })],
  [/^\/api\/ai\/identify$/, () => ({ fn: ident.onRequestPost, method: "POST" })],
  [/^\/api\/account$/, () => ({ fn: account.onRequestDelete, method: "DELETE" })],
];
const TYPES = { ".html": "text/html", ".js": "text/javascript", ".css": "text/css", ".json": "application/json", ".png": "image/png", ".webmanifest": "application/manifest+json", ".jpg": "image/jpeg" };
http.createServer(async (req, res) => {
  const url = new URL(req.url, `http://localhost:${PORT}`);
  if (url.pathname === "/__trips") { const { db } = await import(F + "_auth.js"); await db(env); res.end(JSON.stringify(env.DB._sql.prepare("SELECT id, json_extract(data, '$.water') AS water, deleted, updated FROM trips ORDER BY id").all())); return; }
  if (url.pathname === "/__ai") { res.end(JSON.stringify(globalThis.aiCalls)); return; }
  if (url.pathname === "/__stats") { const { db } = await import(F + "_auth.js"); await db(env); res.end(JSON.stringify({ trips: env.DB._sql.prepare("SELECT COUNT(*) n FROM trips WHERE deleted=0").get().n, users: env.DB._sql.prepare("SELECT COUNT(*) n FROM users").get().n, photos: env.CATCHES._m.size })); return; }
  for (const [re, mk] of routes) {
    const m = url.pathname.match(re); if (!m) continue;
    const r = mk(m);
    if (r.method && r.method !== req.method) { res.writeHead(405); res.end(); return; }
    const chunks = []; for await (const c of req) chunks.push(c);
    const request = new Request(url, { method: req.method, headers: req.headers, body: ["GET", "HEAD"].includes(req.method) ? undefined : Buffer.concat(chunks) });
    const out = await r.fn({ request, env, params: r.params || {} });
    const headers = {}; out.headers.forEach((v, k) => { if (k !== "set-cookie") headers[k] = v; });
    const sc = out.headers.getSetCookie(); if (sc.length) headers["set-cookie"] = sc;
    res.writeHead(out.status, headers); res.end(Buffer.from(await out.arrayBuffer())); return;
  }
  if (url.pathname.startsWith("/api/")) { res.writeHead(404, { "content-type": "application/json" }); res.end("{}"); return; }
  let p = path.join(ROOT, decodeURIComponent(url.pathname)); if (p.endsWith("/")) p += "index.html";
  fs.readFile(p, (err, data) => { if (err) { res.writeHead(404); res.end(); return; } res.writeHead(200, { "content-type": TYPES[path.extname(p)] || "application/octet-stream" }); res.end(data); });
}).listen(PORT, () => console.log("dev on", PORT));
