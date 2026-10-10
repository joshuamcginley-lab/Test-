// GET /api/unsubscribe?e=<email>&t=<signed token> — one-click unsubscribe link for waitlist emails (CASL).
import { unsubToken, removeEmail } from "../_lib.js";

const page = (title, body) => new Response(`<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><meta name="robots" content="noindex"><title>${title} · fishr AI</title>
<style>body{margin:0;min-height:100vh;display:grid;place-items:center;background:#070A14;color:#EEF2E8;font:16px/1.5 system-ui,sans-serif;padding:24px}main{max-width:420px;text-align:center}h1{font-size:26px;letter-spacing:-.02em}a{color:#C4FF2E}</style></head>
<body><main><h1>${title}</h1><p>${body}</p><p><a href="/">Back to fishr AI</a></p></main></body></html>`, { headers: { "content-type": "text/html; charset=utf-8", "cache-control": "no-store" } });

export async function onRequestGet({ request, env }) {
  const u = new URL(request.url), email = (u.searchParams.get("e") || "").trim().toLowerCase(), t = u.searchParams.get("t") || "";
  const want = email && env.CATCHES ? await unsubToken(email, env) : null;
  let diff = want && t.length === want.length ? 0 : 1;
  if (!diff) for (let i = 0; i < want.length; i++) diff |= want.charCodeAt(i) ^ t.charCodeAt(i);
  const good = !diff;
  if (!good) return page("Link not recognised", "This unsubscribe link is incomplete or has expired. You can also remove your address from the <a href=\"/privacy.html#remove\">privacy page</a>.");
  await removeEmail(env, email);
  return page("You're unsubscribed", "We've removed your address from the fishr Pro list. You won't get any more emails from us.");
}
