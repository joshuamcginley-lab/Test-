// fishr Cloud accounts: passkey (WebAuthn) sign-in, sessions, and the D1 schema. No passwords, no email.
// The database is bound as DB; tables are created on first use. Photos live in R2 (CATCHES) under u/<user id>/.
import { json } from "./_lib.js";

const SESSION_DAYS = 365;
const enc = new TextEncoder();

/* ---------- schema ---------- */
const ready = new WeakMap(); // one schema check per database per worker
export function db(env) {
  if (!env.DB) throw Object.assign(new Error("Cloud storage isn't set up yet."), { status: 503 });
  if (!ready.has(env.DB)) ready.set(env.DB, env.DB.batch([
    "CREATE TABLE IF NOT EXISTS users (id TEXT PRIMARY KEY, created TEXT NOT NULL, plan TEXT NOT NULL DEFAULT 'free', seq INTEGER NOT NULL DEFAULT 0)",
    "CREATE TABLE IF NOT EXISTS passkeys (id TEXT PRIMARY KEY, user_id TEXT NOT NULL, jwk TEXT NOT NULL, alg INTEGER NOT NULL, counter INTEGER NOT NULL DEFAULT 0, label TEXT, created TEXT NOT NULL, last_used TEXT)",
    "CREATE INDEX IF NOT EXISTS passkeys_user ON passkeys (user_id)",
    "CREATE TABLE IF NOT EXISTS sessions (token TEXT PRIMARY KEY, user_id TEXT NOT NULL, created TEXT NOT NULL, expires TEXT NOT NULL)",
    "CREATE INDEX IF NOT EXISTS sessions_user ON sessions (user_id)",
    "CREATE TABLE IF NOT EXISTS challenges (id TEXT PRIMARY KEY, challenge TEXT NOT NULL, user_id TEXT, kind TEXT NOT NULL, expires TEXT NOT NULL)",
    "CREATE TABLE IF NOT EXISTS trips (user_id TEXT NOT NULL, id TEXT NOT NULL, data TEXT, updated TEXT NOT NULL, deleted INTEGER NOT NULL DEFAULT 0, seq INTEGER NOT NULL, PRIMARY KEY (user_id, id))",
    "CREATE INDEX IF NOT EXISTS trips_seq ON trips (user_id, seq)",
    "CREATE TABLE IF NOT EXISTS meta (user_id TEXT PRIMARY KEY, data TEXT NOT NULL, updated TEXT NOT NULL)",
  ].map(sql => env.DB.prepare(sql))).catch(e => { ready.delete(env.DB); throw e; }));
  return ready.get(env.DB).then(() => env.DB);
}

/* ---------- small helpers ---------- */
export const b64u = bytes => { let s = ""; for (const b of new Uint8Array(bytes)) s += String.fromCharCode(b); return btoa(s).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, ""); };
export const unb64u = s => Uint8Array.from(atob(String(s).replace(/-/g, "+").replace(/_/g, "/") + "===".slice((String(s).length + 3) % 4)), c => c.charCodeAt(0));
export const randomId = (n = 16) => b64u(crypto.getRandomValues(new Uint8Array(n)));
const sha256 = async data => new Uint8Array(await crypto.subtle.digest("SHA-256", typeof data === "string" ? enc.encode(data) : data));
const hex = bytes => [...bytes].map(b => b.toString(16).padStart(2, "0")).join("");
const iso = (ms = 0) => new Date(Date.now() + ms).toISOString();
export const fail = (msg, status = 400) => { throw Object.assign(new Error(msg), { status }); };

// Run a handler and turn thrown errors into JSON responses.
export async function handle(fn) {
  try { return await fn(); }
  catch (e) { return json({ error: e.status ? e.message : "Something went wrong on our end. Try again." }, e.status || 500); }
}

/* ---------- sessions ---------- */
const cookies = request => Object.fromEntries((request.headers.get("cookie") || "").split(/;\s*/).filter(Boolean).map(c => { const i = c.indexOf("="); return [c.slice(0, i), c.slice(i + 1)]; }));

export async function currentUser(request, env) {
  const token = cookies(request).fishr_s; if (!token) return null;
  const DB = await db(env);
  return DB.prepare("SELECT u.id, u.created, u.plan FROM sessions s JOIN users u ON u.id = s.user_id WHERE s.token = ? AND s.expires > ?")
    .bind(hex(await sha256(token)), iso()).first();
}
export async function requireUser(request, env) {
  const u = await currentUser(request, env);
  if (!u) fail("Sign in to fishr Cloud first.", 401);
  return u;
}
// Cloud is free during the beta. Set CLOUD_PRO_ONLY=true in Cloudflare to make it a Pro feature.
export function cloudAllowed(user, env) {
  return String(env.CLOUD_PRO_ONLY || "").toLowerCase() !== "true" || user.plan === "pro";
}
export function requireCloud(user, env) {
  if (!cloudAllowed(user, env)) fail("Cloud sync is part of fishr Pro.", 402);
}

export async function startSession(env, userId, request) {
  const token = randomId(32), DB = await db(env);
  await DB.prepare("INSERT INTO sessions (token, user_id, created, expires) VALUES (?, ?, ?, ?)").bind(hex(await sha256(token)), userId, iso(), iso(SESSION_DAYS * 864e5)).run();
  return sessionCookies(request, token, SESSION_DAYS * 86400);
}
export async function endSession(request, env) {
  const token = cookies(request).fishr_s;
  if (token) await (await db(env)).prepare("DELETE FROM sessions WHERE token = ?").bind(hex(await sha256(token))).run();
  return sessionCookies(request, "", 0);
}
// fishr_s is the real session (script can't read it). fishr_in only tells the app someone is signed in.
function sessionCookies(request, token, maxAge) {
  const secure = new URL(request.url).protocol === "https:" ? "; Secure" : "";
  return [`fishr_s=${token}; Path=/; HttpOnly; SameSite=Lax; Max-Age=${maxAge}${secure}`, `fishr_in=${token ? 1 : ""}; Path=/; SameSite=Lax; Max-Age=${maxAge}${secure}`];
}
export function withCookies(res, list) { for (const c of list) res.headers.append("set-cookie", c); return res; }

/* ---------- challenges ---------- */
export async function newChallenge(env, kind, userId = null) {
  const DB = await db(env), id = randomId(12), challenge = randomId(32);
  await DB.batch([
    DB.prepare("DELETE FROM challenges WHERE expires < ?").bind(iso()),
    DB.prepare("INSERT INTO challenges (id, challenge, user_id, kind, expires) VALUES (?, ?, ?, ?, ?)").bind(id, challenge, userId, kind, iso(5 * 60e3)),
  ]);
  return { id, challenge };
}
// Each challenge works once and only for five minutes.
async function takeChallenge(env, id, kinds) {
  const row = await (await db(env)).prepare("DELETE FROM challenges WHERE id = ? RETURNING challenge, user_id, kind, expires").bind(String(id || "")).first();
  if (!row || !kinds.includes(row.kind) || row.expires < iso()) fail("That sign-in request expired. Try again.");
  return row;
}

/* ---------- WebAuthn ---------- */
function checkClientData(raw, type, challenge, request) {
  let cd; try { cd = JSON.parse(new TextDecoder().decode(raw)); } catch { fail("Passkey response wasn't readable."); }
  if (cd.type !== type) fail("Passkey response was the wrong type.");
  if (cd.challenge !== challenge) fail("That sign-in request expired. Try again.");
  if (cd.origin !== new URL(request.url).origin || cd.crossOrigin) fail("Passkey was made for a different site.");
}
async function parseAuthData(ad, request) {
  if (ad.length < 37) fail("Passkey response was too short.");
  const rpHash = await sha256(new URL(request.url).hostname);
  if (!rpHash.every((b, i) => ad[i] === b)) fail("Passkey belongs to a different site.");
  const flags = ad[32];
  if (!(flags & 1)) fail("Passkey didn't confirm you were there.");
  return { flags, counter: new DataView(ad.buffer, ad.byteOffset + 33, 4).getUint32(0) };
}

// Minimal CBOR reader: enough for WebAuthn attestation objects and COSE keys.
export function cbor(buf) {
  let i = 0; const v = new DataView(buf.buffer, buf.byteOffset, buf.byteLength);
  const len = ai => {
    if (ai < 24) return ai;
    if (ai === 24) return buf[i++];
    if (ai === 25) { const n = v.getUint16(i); i += 2; return n; }
    if (ai === 26) { const n = v.getUint32(i); i += 4; return n; }
    if (ai === 27) { const n = Number(v.getBigUint64(i)); i += 8; return n; }
    throw new Error("cbor");
  };
  const item = () => {
    if (i >= buf.length) throw new Error("cbor");
    const b = buf[i++], mt = b >> 5, ai = b & 31;
    if (mt === 7) { if (ai === 20) return false; if (ai === 21) return true; if (ai === 22 || ai === 23) return null; throw new Error("cbor"); }
    const n = len(ai);
    if (mt === 0) return n;
    if (mt === 1) return -1 - n;
    if (mt === 2) { const out = buf.slice(i, i + n); i += n; return out; }
    if (mt === 3) { const out = new TextDecoder().decode(buf.slice(i, i + n)); i += n; return out; }
    if (mt === 4) { const a = []; for (let k = 0; k < n; k++) a.push(item()); return a; }
    if (mt === 5) { const m = new Map(); for (let k = 0; k < n; k++) { const key = item(); m.set(key, item()); } return m; }
    return item(); // tag: return the tagged value
  };
  const value = item();
  return { value, end: i };
}

// COSE public key -> JWK. ES256 (P-256) and RS256 cover every phone, laptop and password manager.
function coseToJwk(m) {
  const kty = m.get(1), alg = m.get(3);
  if (kty === 2 && alg === -7 && m.get(-1) === 1) return { alg, jwk: { kty: "EC", crv: "P-256", x: b64u(m.get(-2)), y: b64u(m.get(-3)) } };
  if (kty === 3 && alg === -257) return { alg, jwk: { kty: "RSA", n: b64u(m.get(-1)), e: b64u(m.get(-2)), alg: "RS256" } };
  fail("This passkey type isn't supported. Try your phone's built-in passkeys.");
}

// ECDSA signatures arrive DER-encoded; WebCrypto wants the raw 64-byte r||s.
function derToRaw(der) {
  if (der[0] !== 0x30) fail("Passkey signature wasn't readable.");
  let i = 2; const parts = [];
  for (let k = 0; k < 2; k++) {
    if (der[i++] !== 0x02) fail("Passkey signature wasn't readable.");
    let n = der[i++], p = der.slice(i, i + n); i += n;
    while (p.length > 32 && p[0] === 0) p = p.slice(1);
    const out = new Uint8Array(32); out.set(p, 32 - p.length); parts.push(out);
  }
  const raw = new Uint8Array(64); raw.set(parts[0]); raw.set(parts[1], 32); return raw;
}

async function verifySig({ alg, jwk }, sig, data) {
  if (alg === -7) {
    const key = await crypto.subtle.importKey("jwk", jwk, { name: "ECDSA", namedCurve: "P-256" }, false, ["verify"]);
    return crypto.subtle.verify({ name: "ECDSA", hash: "SHA-256" }, key, derToRaw(sig), data);
  }
  const key = await crypto.subtle.importKey("jwk", jwk, { name: "RSASSA-PKCS1-v1_5", hash: "SHA-256" }, false, ["verify"]);
  return crypto.subtle.verify("RSASSA-PKCS1-v1_5", key, sig, data);
}

// Options for navigator.credentials.create(). Binary fields are base64url; the app converts them.
export function registrationOptions(request, userId, challenge, name, exclude = []) {
  const label = String(name || "").trim().slice(0, 40) || "fishr angler";
  return {
    challenge, timeout: 120000, attestation: "none",
    rp: { name: "fishr.ai", id: new URL(request.url).hostname },
    user: { id: userId, name: label, displayName: label },
    pubKeyCredParams: [{ type: "public-key", alg: -7 }, { type: "public-key", alg: -257 }],
    authenticatorSelection: { residentKey: "required", requireResidentKey: true, userVerification: "preferred" },
    excludeCredentials: exclude.map(id => ({ type: "public-key", id })),
  };
}

export async function verifyRegistration(request, env, body) {
  const ch = await takeChallenge(env, body.challengeId, ["new", "add"]);
  const clientData = unb64u(body.clientDataJSON), att = unb64u(body.attestationObject);
  checkClientData(clientData, "webauthn.create", ch.challenge, request);
  let attObj; try { attObj = cbor(att).value; } catch { fail("Passkey response wasn't readable."); }
  const ad = attObj?.get?.("authData"); if (!(ad instanceof Uint8Array)) fail("Passkey response wasn't readable.");
  const { flags, counter } = await parseAuthData(ad, request);
  if (!(flags & 0x40)) fail("Passkey response had no key in it.");
  const idLen = (ad[53] << 8) | ad[54], credId = ad.slice(55, 55 + idLen);
  let cose; try { cose = cbor(ad.slice(55 + idLen)).value; } catch { fail("Passkey key wasn't readable."); }
  const key = coseToJwk(cose), id = b64u(credId);
  if (id !== body.id) fail("Passkey response didn't match.");
  return { userId: ch.user_id, isNew: ch.kind === "new", passkey: { id, ...key, counter } };
}

export async function verifyLogin(request, env, body) {
  const ch = await takeChallenge(env, body.challengeId, ["login"]);
  const DB = await db(env);
  const pk = await DB.prepare("SELECT * FROM passkeys WHERE id = ?").bind(String(body.id || "")).first();
  if (!pk) fail("That passkey isn't linked to a fishr account. It may have been deleted.", 404);
  const clientData = unb64u(body.clientDataJSON), ad = unb64u(body.authenticatorData), sig = unb64u(body.signature);
  checkClientData(clientData, "webauthn.get", ch.challenge, request);
  const { counter } = await parseAuthData(ad, request);
  if (body.userHandle && body.userHandle !== pk.user_id) fail("Passkey response didn't match.");
  const signed = new Uint8Array(ad.length + 32); signed.set(ad); signed.set(await sha256(clientData), ad.length);
  if (!(await verifySig({ alg: pk.alg, jwk: JSON.parse(pk.jwk) }, sig, signed))) fail("Passkey check failed. Try again.", 401);
  // A counter that goes backwards means a cloned key. Synced passkeys (iCloud, Google) always report 0.
  if (pk.counter > 0 && counter <= pk.counter) fail("Passkey check failed. Try again.", 401);
  await DB.prepare("UPDATE passkeys SET counter = ?, last_used = ? WHERE id = ?").bind(counter, iso(), pk.id).run();
  return pk.user_id;
}

export async function accountInfo(env, user) {
  const { results } = await (await db(env)).prepare("SELECT id, label, created, last_used FROM passkeys WHERE user_id = ? ORDER BY created").bind(user.id).all();
  return { id: user.id, plan: user.plan, created: user.created, cloud: cloudAllowed(user, env), passkeys: results.map(p => ({ label: p.label, created: p.created, lastUsed: p.last_used })) };
}
