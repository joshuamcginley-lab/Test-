// Test doubles for Cloudflare bindings: D1 on node:sqlite, R2 in memory, plus a WebAuthn "authenticator".
import { DatabaseSync } from "node:sqlite";
import { webcrypto as wc } from "node:crypto";

export function d1() {
  const sql = new DatabaseSync(":memory:");
  const stmt = (q, args = []) => ({
    _q: q, _a: args,
    bind: (...a) => stmt(q, a),
    first: async col => { const r = sql.prepare(q).get(...args) ?? null; return r && col ? r[col] : r && { ...r }; },
    all: async () => ({ results: sql.prepare(q).all(...args).map(r => ({ ...r })), success: true }),
    run: async () => { const p = sql.prepare(q); if (/returning/i.test(q)) p.all(...args); else p.run(...args); return { success: true }; },
  });
  return {
    prepare: q => stmt(q),
    batch: async list => { sql.exec("BEGIN"); try { const out = []; for (const s of list) out.push(/^\s*(select)|returning/i.test(s._q) ? await s.all() : await s.run()); sql.exec("COMMIT"); return out; } catch (e) { sql.exec("ROLLBACK"); throw e; } },
    _sql: sql,
  };
}

export function r2() {
  const m = new Map();
  const obj = (key, v) => ({ key, httpMetadata: v.meta, body: new Blob([v.buf]).stream(), arrayBuffer: async () => v.buf, text: async () => new TextDecoder().decode(v.buf), json: async () => JSON.parse(new TextDecoder().decode(v.buf)) });
  return {
    _m: m,
    get: async k => m.has(k) ? obj(k, m.get(k)) : null,
    head: async k => m.has(k) ? { key: k } : null,
    put: async (k, v, o = {}) => { const buf = typeof v === "string" ? new TextEncoder().encode(v).buffer : v instanceof ArrayBuffer ? v : await new Response(v).arrayBuffer(); m.set(k, { buf, meta: o.httpMetadata || {} }); },
    delete: async k => { for (const x of [].concat(k)) m.delete(x); },
    list: async ({ prefix = "", cursor, limit = 1000 } = {}) => {
      const keys = [...m.keys()].filter(k => k.startsWith(prefix)).sort(), start = cursor ? +cursor : 0, page = keys.slice(start, start + limit);
      return { objects: page.map(key => ({ key })), truncated: start + limit < keys.length, cursor: String(start + limit) };
    },
  };
}

/* --- CBOR encoder (tests only) --- */
function head(mt, n) {
  if (n < 24) return [mt << 5 | n];
  if (n < 256) return [mt << 5 | 24, n];
  if (n < 65536) return [mt << 5 | 25, n >> 8, n & 255];
  return [mt << 5 | 26, (n >>> 24) & 255, (n >> 16) & 255, (n >> 8) & 255, n & 255];
}
export function cborEnc(v) {
  if (typeof v === "number") return Uint8Array.from(v >= 0 ? head(0, v) : head(1, -1 - v));
  if (typeof v === "string") { const b = new TextEncoder().encode(v); return cat(Uint8Array.from(head(3, b.length)), b); }
  if (v instanceof Uint8Array) return cat(Uint8Array.from(head(2, v.length)), v);
  if (v instanceof Map) return cat(Uint8Array.from(head(5, v.size)), ...[...v].flatMap(([k, x]) => [cborEnc(k), cborEnc(x)]));
  throw new Error("enc");
}
export const cat = (...a) => { const out = new Uint8Array(a.reduce((n, x) => n + x.length, 0)); let i = 0; for (const x of a) { out.set(x, i); i += x.length; } return out; };
export const b64u = b => Buffer.from(b).toString("base64url");
const sha = async d => new Uint8Array(await wc.subtle.digest("SHA-256", typeof d === "string" ? new TextEncoder().encode(d) : d));

// A software passkey: ES256 by default, RS256 optional.
export async function authenticator({ rs = false, counter = 0 } = {}) {
  const kp = rs ? await wc.subtle.generateKey({ name: "RSASSA-PKCS1-v1_5", modulusLength: 2048, publicExponent: new Uint8Array([1, 0, 1]), hash: "SHA-256" }, true, ["sign", "verify"])
    : await wc.subtle.generateKey({ name: "ECDSA", namedCurve: "P-256" }, true, ["sign", "verify"]);
  const credId = wc.getRandomValues(new Uint8Array(16)), jwk = await wc.subtle.exportKey("jwk", kp.publicKey);
  let userHandle = null;
  const authData = async (host, flags, extra = new Uint8Array()) => { const c = new Uint8Array(4); new DataView(c.buffer).setUint32(0, counter); return cat(await sha(host), Uint8Array.from([flags]), c, extra); };
  return {
    id: b64u(credId), get userHandle() { return userHandle; },
    async create(opts, origin) {
      userHandle = opts.user.id;
      const host = new URL(origin).hostname;
      const cose = rs ? new Map([[1, 3], [3, -257], [-1, Buffer.from(jwk.n, "base64url")], [-2, Buffer.from(jwk.e, "base64url")]].map(([k, v]) => [k, v instanceof Buffer ? new Uint8Array(v) : v]))
        : new Map([[1, 2], [3, -7], [-1, 1], [-2, new Uint8Array(Buffer.from(jwk.x, "base64url"))], [-3, new Uint8Array(Buffer.from(jwk.y, "base64url"))]]);
      const att = cat(new Uint8Array(16), Uint8Array.from([0, credId.length]), credId, cborEnc(cose));
      const ad = await authData(host, 0x45, att);
      const cd = JSON.stringify({ type: "webauthn.create", challenge: opts.challenge, origin });
      return { id: b64u(credId), clientDataJSON: b64u(new TextEncoder().encode(cd)), attestationObject: b64u(cborEnc(new Map([["fmt", "none"], ["attStmt", new Map()], ["authData", ad]]))) };
    },
    async get(opts, origin, { bump = true } = {}) {
      if (bump && counter) counter++;
      const ad = await authData(opts.rpId, 0x05), cdBytes = new TextEncoder().encode(JSON.stringify({ type: "webauthn.get", challenge: opts.challenge, origin }));
      const data = cat(ad, await sha(cdBytes));
      let sig = new Uint8Array(rs ? await wc.subtle.sign("RSASSA-PKCS1-v1_5", kp.privateKey, data) : await wc.subtle.sign({ name: "ECDSA", hash: "SHA-256" }, kp.privateKey, data));
      if (!rs) { // raw r||s -> DER
        const int = b => { let i = 0; while (i < b.length - 1 && b[i] === 0) i++; b = b.slice(i); return b[0] & 0x80 ? cat(Uint8Array.from([0]), b) : b; };
        const r = int(sig.slice(0, 32)), s = int(sig.slice(32));
        sig = cat(Uint8Array.from([0x30, r.length + s.length + 4, 2, r.length]), r, Uint8Array.from([2, s.length]), s);
      }
      return { id: b64u(credId), clientDataJSON: b64u(cdBytes), authenticatorData: b64u(ad), signature: b64u(sig), userHandle };
    },
  };
}
