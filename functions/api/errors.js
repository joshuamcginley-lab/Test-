// POST /api/errors — anonymous crash reports from the app (message, file, line, browser, app version).
// GET  /api/errors with x-admin-key -> the 100 most recent reports, for /admin.html.
import { json, isAdmin, newId } from "../_lib.js";
import { underLimit, readCapped } from "../_limits.js";

const clip = (v, n) => (typeof v === "string" ? v.slice(0, n) : typeof v === "number" && Number.isFinite(v) ? v : null);

export async function onRequestPost({ request, env }) {
  if (!env.CATCHES) return json({ ok: false }, 503);
  if (Number(request.headers.get("content-length") || 0) > 8192) return json({ ok: false }, 413);
  const raw = await readCapped(request, 8192);
  if (!raw) return json({ ok: false }, 413);
  let d; try { d = JSON.parse(new TextDecoder().decode(raw)); } catch { return json({ ok: false }, 400); }
  if (!d || typeof d !== "object") return json({ ok: false }, 400);
  if (!(await underLimit(env, request, "errors", 40))) return json({ ok: false }, 429);
  const report = {
    at: new Date().toISOString(), msg: clip(d.msg, 500), src: clip(d.src, 200), line: Number.isFinite(+d.line) ? +d.line : null,
    col: Number.isFinite(+d.col) ? +d.col : null, stack: clip(d.stack, 2000), ua: clip(request.headers.get("user-agent"), 300), version: clip(d.version, 20),
    screen: clip(d.screen, 40), country: request.cf?.country || null,
  };
  if (!report.msg) return json({ ok: false }, 400);
  // Newest first when listed: keys sort by inverted timestamp.
  const key = `errors/${String(9e15 - Date.now()).padStart(16, "0")}-${newId()}.json`;
  await env.CATCHES.put(key, JSON.stringify(report), { httpMetadata: { contentType: "application/json" } });
  // Keep reports for 90 days (as the privacy page promises). Older keys sort after this cutoff.
  const cutoff = `errors/${String(9e15 - (Date.now() - 90 * 864e5)).padStart(16, "0")}`;
  const old = await env.CATCHES.list({ prefix: "errors/", startAfter: cutoff, limit: 100 });
  if (old.objects.length) await env.CATCHES.delete(old.objects.map(o => o.key));
  return json({ ok: true });
}

export async function onRequestGet({ request, env }) {
  if (!isAdmin(request, env)) return json({ error: "Not allowed." }, 403);
  if (!env.CATCHES) return json({ errors: [], more: false });
  const page = await env.CATCHES.list({ prefix: "errors/", limit: 100 });
  const out = [];
  for (const o of page.objects) { const obj = await env.CATCHES.get(o.key); if (obj) try { out.push(await obj.json()); } catch {} }
  return json({ errors: out, more: page.truncated });
}
