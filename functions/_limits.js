// Per-visitor daily limits for endpoints anyone can call without an account (share uploads, crash reports).
// Counted in D1 (table ai_usage, under a hashed IP) so storage can't be filled up by one visitor.
import { db } from "./_auth.js";
import { visitorId } from "./_ai.js";

export async function underLimit(env, request, kind, limit) {
  if (!env.DB) return true; // no database bound: fall back to no limit rather than breaking the feature
  try {
    const row = await (await db(env)).prepare("INSERT INTO ai_usage (user_id, day, kind, n) VALUES (?, ?, ?, 1) ON CONFLICT (user_id, day, kind) DO UPDATE SET n = n + 1 RETURNING n")
      .bind(await visitorId(request), new Date().toISOString().slice(0, 10), kind).first();
    return row.n <= limit;
  } catch (e) { return true; }
}

// Read a request body, stopping as soon as it passes `max` bytes (the size header isn't always sent, e.g. over HTTP/2).
// Returns the bytes, or null when the body is too big.
export async function readCapped(request, max) {
  if (!request.body) return new Uint8Array();
  const reader = request.body.getReader(), parts = []; let size = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    size += value.byteLength;
    if (size > max) { try { await reader.cancel(); } catch (e) {} return null; }
    parts.push(value);
  }
  const out = new Uint8Array(size); let o = 0;
  for (const p of parts) { out.set(p, o); o += p.byteLength; }
  return out;
}
