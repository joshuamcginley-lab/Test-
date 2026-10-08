// fishr Pro waitlist, stored in the R2 bucket bound as CATCHES under waitlist/<sha256 of email>.json.
// GET  /api/waitlist              -> { count }
// POST /api/waitlist {email, name?, consent:true, website:""} -> { ok, count, already }
// GET  /api/waitlist?export=csv with header x-admin-key: <WAITLIST_KEY env var> -> CSV of sign-ups
import { json } from "../_lib.js";

const PREFIX = "waitlist/";
const CONSENT_TEXT = "Email me when fishr Pro opens. I can unsubscribe at any time.";
const EMAIL_RE = /^[^\s@<>"']{1,64}@[^\s@<>"']{1,190}\.[A-Za-z]{2,24}$/;

async function sha256(s) {
  const buf = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(s));
  return [...new Uint8Array(buf)].map(b => b.toString(16).padStart(2, "0")).join("");
}
async function listAll(bucket) {
  const keys = []; let cursor;
  for (let i = 0; i < 20; i++) {
    const page = await bucket.list({ prefix: PREFIX, cursor, limit: 1000 });
    keys.push(...page.objects.map(o => o.key));
    if (!page.truncated) break; cursor = page.cursor;
  }
  return keys;
}

export async function onRequestGet({ request, env }) {
  if (!env.CATCHES) return json({ count: 0 });
  const u = new URL(request.url);
  if (u.searchParams.get("export") === "csv") {
    if (!env.WAITLIST_KEY || request.headers.get("x-admin-key") !== env.WAITLIST_KEY) return json({ error: "Not allowed." }, 403);
    const rows = [["email", "name", "joined", "consent", "country"]];
    for (const key of await listAll(env.CATCHES)) {
      const obj = await env.CATCHES.get(key); if (!obj) continue;
      try { const d = await obj.json(); rows.push([d.email, d.name || "", d.joined, d.consentText, d.country || ""]); } catch {}
    }
    const csv = rows.map(r => r.map(v => /[",\n]/.test(String(v)) ? `"${String(v).replace(/"/g, '""')}"` : v).join(",")).join("\n");
    return new Response(csv, { headers: { "content-type": "text/csv; charset=utf-8", "content-disposition": "attachment; filename=fishr-waitlist.csv", "cache-control": "no-store" } });
  }
  return json({ count: (await listAll(env.CATCHES)).length });
}

export async function onRequestPost({ request, env }) {
  if (!env.CATCHES) return json({ error: "The waitlist isn't set up yet." }, 503);
  let body;
  try { body = await request.json(); } catch { return json({ error: "Send your email address." }, 400); }
  if (body.website) return json({ ok: true, count: 0 }); // honeypot field: bots fill it, people never see it
  const email = String(body.email || "").trim().toLowerCase();
  if (!EMAIL_RE.test(email)) return json({ error: "That email address doesn't look right." }, 400);
  if (body.consent !== true) return json({ error: "Tick the box so we're allowed to email you." }, 400);

  const key = PREFIX + (await sha256(email)) + ".json";
  const already = !!(await env.CATCHES.head(key));
  if (!already) {
    await env.CATCHES.put(key, JSON.stringify({
      email, name: String(body.name || "").trim().slice(0, 60) || null,
      joined: new Date().toISOString(), consent: true, consentText: CONSENT_TEXT,
      country: request.cf?.country || null, source: "app",
    }), { httpMetadata: { contentType: "application/json" } });
  }
  const count = (await listAll(env.CATCHES)).length;
  return json({ ok: true, already, count });
}
