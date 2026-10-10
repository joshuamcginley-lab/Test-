// Web Push without a third-party service: each message is encrypted for the receiving browser (RFC 8291,
// aes128gcm) and signed with fishr's push key (VAPID, RFC 8292). Only Web Crypto, so it runs on Cloudflare as is.
// Keys: VAPID_PUBLIC (base64url, 65-byte P-256 point) and VAPID_PRIVATE (base64url of the private scalar "d"),
// created on /admin and pasted into Cloudflare as secrets.

const enc = s => new TextEncoder().encode(s);
export const b64u = buf => btoa(String.fromCharCode(...new Uint8Array(buf))).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
export const unb64u = s => Uint8Array.from(atob(String(s).replace(/-/g, "+").replace(/_/g, "/") + "===".slice((String(s).length + 3) % 4)), c => c.charCodeAt(0));
const concat = (...parts) => { const out = new Uint8Array(parts.reduce((a, p) => a + p.length, 0)); let o = 0; for (const p of parts) { out.set(p, o); o += p.length; } return out; };

// Push services browsers use. The server only ever posts to these, so a subscription can't point it anywhere else.
const PUSH_HOSTS = [/^fcm\.googleapis\.com$/, /^updates\.push\.services\.mozilla\.com$/, /^(web\.push|[\w-]+\.push)\.apple\.com$/, /^[\w-]+\.notify\.windows\.com$/];
export function pushHostOk(endpoint, env = {}) {
  let u; try { u = new URL(endpoint); } catch (e) { return false; }
  if (env.PUSH_TEST_HOST && u.host === env.PUSH_TEST_HOST) return true; // the test suite's fake push service
  return u.protocol === "https:" && PUSH_HOSTS.some(re => re.test(u.hostname));
}

async function hkdf(salt, ikm, info, bytes) {
  const key = await crypto.subtle.importKey("raw", ikm, "HKDF", false, ["deriveBits"]);
  return new Uint8Array(await crypto.subtle.deriveBits({ name: "HKDF", hash: "SHA-256", salt, info }, key, bytes * 8));
}

// Encrypt a payload for one subscription (keys.p256dh, keys.auth from the browser).
export async function encryptPayload(payload, p256dh, auth) {
  const uaPub = unb64u(p256dh), authSecret = unb64u(auth);
  if (uaPub.length !== 65 || authSecret.length !== 16) throw new Error("bad subscription keys");
  const as = await crypto.subtle.generateKey({ name: "ECDH", namedCurve: "P-256" }, true, ["deriveBits"]);
  const asPub = new Uint8Array(await crypto.subtle.exportKey("raw", as.publicKey));
  const uaKey = await crypto.subtle.importKey("raw", uaPub, { name: "ECDH", namedCurve: "P-256" }, false, []);
  const shared = new Uint8Array(await crypto.subtle.deriveBits({ name: "ECDH", public: uaKey }, as.privateKey, 256));
  const ikm = await hkdf(authSecret, shared, concat(enc("WebPush: info\0"), uaPub, asPub), 32);
  const salt = crypto.getRandomValues(new Uint8Array(16));
  const cek = await hkdf(salt, ikm, enc("Content-Encoding: aes128gcm\0"), 16);
  const nonce = await hkdf(salt, ikm, enc("Content-Encoding: nonce\0"), 12);
  const key = await crypto.subtle.importKey("raw", cek, "AES-GCM", false, ["encrypt"]);
  const ct = new Uint8Array(await crypto.subtle.encrypt({ name: "AES-GCM", iv: nonce, tagLength: 128 }, key, concat(enc(JSON.stringify(payload)), new Uint8Array([2]))));
  const header = new Uint8Array(16 + 4 + 1 + 65);
  header.set(salt, 0); new DataView(header.buffer).setUint32(16, 4096); header[20] = 65; header.set(asPub, 21);
  return concat(header, ct);
}

// The VAPID token proving the message comes from fishr.
async function vapidAuth(endpoint, env) {
  const pub = unb64u(env.VAPID_PUBLIC);
  if (pub.length !== 65 || !env.VAPID_PRIVATE) throw new Error("push keys not set");
  const jwk = { kty: "EC", crv: "P-256", x: b64u(pub.slice(1, 33)), y: b64u(pub.slice(33, 65)), d: env.VAPID_PRIVATE, ext: true };
  const key = await crypto.subtle.importKey("jwk", jwk, { name: "ECDSA", namedCurve: "P-256" }, false, ["sign"]);
  const head = b64u(enc(JSON.stringify({ typ: "JWT", alg: "ES256" })));
  const body = b64u(enc(JSON.stringify({ aud: new URL(endpoint).origin, exp: Math.floor(Date.now() / 1000) + 12 * 3600, sub: env.VAPID_SUBJECT || "https://fishr.monster" })));
  const sig = await crypto.subtle.sign({ name: "ECDSA", hash: "SHA-256" }, key, enc(`${head}.${body}`));
  return `vapid t=${head}.${body}.${b64u(sig)}, k=${env.VAPID_PUBLIC}`;
}

// Send one notification. Returns the push service's HTTP status (201 = accepted; 404/410 = the subscription is gone).
export async function sendPush(env, sub, payload, ttl = 12 * 3600) {
  if (!pushHostOk(sub.endpoint, env)) return 400;
  const body = await encryptPayload(payload, sub.p256dh, sub.auth);
  const res = await fetch(sub.endpoint, {
    method: "POST", body, signal: AbortSignal.timeout(10000),
    headers: { authorization: await vapidAuth(sub.endpoint, env), "content-encoding": "aes128gcm", "content-type": "application/octet-stream", ttl: String(ttl), urgency: "normal" },
  });
  return res.status;
}
