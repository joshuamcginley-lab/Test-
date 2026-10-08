// fishr Cloud sign-in with passkeys.
// GET  /api/auth/me                 -> { user } (401 if signed out)
// POST /api/auth/register-options  {name}  -> { challengeId, publicKey }   new account, or another passkey when signed in
// POST /api/auth/register          {challengeId, id, clientDataJSON, attestationObject, label} -> { user }
// POST /api/auth/login-options     -> { challengeId, publicKey }
// POST /api/auth/login             {challengeId, id, clientDataJSON, authenticatorData, signature, userHandle} -> { user }
// POST /api/auth/logout
import { json } from "../../_lib.js";
import { db, handle, fail, randomId, currentUser, requireUser, startSession, endSession, withCookies, newChallenge,
  registrationOptions, verifyRegistration, verifyLogin, accountInfo, isJson } from "../../_auth.js";

const cleanLabel = s => String(s || "").replace(/[^\w ·().,'-]/g, "").trim().slice(0, 40) || "Passkey";

const actions = {
  async me({ request, env }) {
    const u = await requireUser(request, env);
    return json({ user: await accountInfo(env, u) });
  },

  async "register-options"({ request, env, body }) {
    const u = await currentUser(request, env), DB = await db(env);
    const userId = u ? u.id : randomId(16);
    const exclude = u ? (await DB.prepare("SELECT id FROM passkeys WHERE user_id = ?").bind(u.id).all()).results.map(r => r.id) : [];
    const { id, challenge } = await newChallenge(env, u ? "add" : "new", userId);
    return json({ challengeId: id, publicKey: registrationOptions(request, userId, challenge, body.name, exclude) });
  },

  async register({ request, env, body }) {
    const { userId, isNew, passkey } = await verifyRegistration(request, env, body);
    const DB = await db(env), now = new Date().toISOString();
    if (!isNew) { const u = await currentUser(request, env); if (!u || u.id !== userId) fail("Sign in again to add a passkey.", 401); }
    if (await DB.prepare("SELECT 1 FROM passkeys WHERE id = ?").bind(passkey.id).first()) fail("This passkey is already linked to an account.", 409);
    const stmts = [];
    if (isNew) stmts.push(DB.prepare("INSERT INTO users (id, created) VALUES (?, ?)").bind(userId, now));
    stmts.push(DB.prepare("INSERT INTO passkeys (id, user_id, jwk, alg, counter, label, created, last_used) VALUES (?, ?, ?, ?, ?, ?, ?, ?)")
      .bind(passkey.id, userId, JSON.stringify(passkey.jwk), passkey.alg, passkey.counter, cleanLabel(body.label), now, now));
    await DB.batch(stmts);
    const user = await DB.prepare("SELECT id, created, plan FROM users WHERE id = ?").bind(userId).first();
    const res = json({ user: await accountInfo(env, user) });
    return isNew ? withCookies(res, await startSession(env, userId, request)) : res;
  },

  async "login-options"({ request, env }) {
    const { id, challenge } = await newChallenge(env, "login");
    return json({ challengeId: id, publicKey: { challenge, rpId: new URL(request.url).hostname, timeout: 120000, userVerification: "preferred" } });
  },

  async login({ request, env, body }) {
    const userId = await verifyLogin(request, env, body);
    const user = await (await db(env)).prepare("SELECT id, created, plan FROM users WHERE id = ?").bind(userId).first();
    if (!user) fail("That account was deleted.", 404);
    return withCookies(json({ user: await accountInfo(env, user) }), await startSession(env, userId, request));
  },

  async logout({ request, env }) {
    return withCookies(json({ ok: true }), await endSession(request, env));
  },
};

export async function onRequest({ request, env, params }) {
  return handle(async () => {
    const fn = actions[params.action];
    if (!fn) fail("Not found.", 404);
    const isGet = params.action === "me";
    if (isGet !== (request.method === "GET")) fail("Method not allowed.", 405);
    let body = {};
    if (!isGet) {
      // JSON only: browsers won't send that cross-site without asking first, which blocks forged requests.
      if (!isJson(request)) fail("Send JSON.", 415);
      body = await request.json().catch(() => ({})) || {};
    }
    return fn({ request, env, body });
  });
}
