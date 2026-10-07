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
