// Shared helpers for the catch-sharing endpoints (Cloudflare Pages Functions + R2 bucket bound as CATCHES).
export const ID_RE = /^[A-Za-z0-9]{10}$/;

export function newId() {
  const abc = "ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz23456789";
  const bytes = crypto.getRandomValues(new Uint8Array(10));
  return [...bytes].map(b => abc[b % abc.length]).join("");
}

// Same fields and limits the app uses for #catch= links. Anything else is dropped.
export function cleanMeta(d) {
  if (!d || typeof d !== "object") return null;
  const num = v => (typeof v === "number" && Number.isFinite(v) ? v : null);
  const str = (v, n) => (typeof v === "string" && v.trim() ? v.trim().slice(0, n) : null);
  const sp = str(d.sp, 60), date = typeof d.d === "string" && /^\d{4}-\d{2}-\d{2}$/.test(d.d) ? d.d : null;
  if (!sp || !date) return null;
  const out = { v: 1, n: str(d.n, 40), d: date, w: str(d.w, 80), sp, ct: Math.max(1, Math.min(999, Math.round(num(d.ct) || 1))), lb: num(d.lb), in: num(d.in), lu: str(d.lu, 80), t: num(d.t) };
  for (const k of Object.keys(out)) if (out[k] == null) delete out[k];
  return out;
}

export const esc = s => String(s ?? "").replace(/[&<>"']/g, c => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));

export function b64url(s) {
  const bytes = new TextEncoder().encode(s);
  let bin = ""; for (const b of bytes) bin += String.fromCharCode(b);
  return btoa(bin).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

export const json = (body, status = 200) => new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json", "cache-control": "no-store" } });

// Admin access for /admin.html: the ADMIN_KEY secret set in Cloudflare (WAITLIST_KEY also accepted).
export function isAdmin(request, env) {
  const key = env.ADMIN_KEY || env.WAITLIST_KEY;
  const got = request.headers.get("x-admin-key") || "";
  if (!key || got.length !== key.length) return false;
  let diff = 0; for (let i = 0; i < key.length; i++) diff |= key.charCodeAt(i) ^ got.charCodeAt(i);
  return diff === 0;
}

// Signed unsubscribe token for an email address, so links in emails can't be forged for other people.
export async function unsubToken(email, env) {
  const secret = env.ADMIN_KEY || env.WAITLIST_KEY;
  if (!secret) return null;
  const k = await crypto.subtle.importKey("raw", new TextEncoder().encode(secret), { name: "HMAC", hash: "SHA-256" }, false, ["sign"]);
  const sig = await crypto.subtle.sign("HMAC", k, new TextEncoder().encode("unsub:" + email));
  return [...new Uint8Array(sig)].slice(0, 16).map(b => b.toString(16).padStart(2, "0")).join("");
}

// Remove a waitlist sign-up (same key scheme as /api/waitlist: waitlist/<sha256 of email>.json).
export async function removeEmail(env, email) {
  const buf = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(email));
  const hex = [...new Uint8Array(buf)].map(b => b.toString(16).padStart(2, "0")).join("");
  await env.CATCHES.delete(`waitlist/${hex}.json`);
}
