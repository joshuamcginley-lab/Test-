// GET /c/<id> — short link for a shared catch. Serves link-preview tags (so iMessage, WhatsApp
// and Facebook show the actual fish), then sends people into the app's catch page.
import { ID_RE, esc, b64url } from "../_lib.js";

export async function onRequestGet({ params, env, request }) {
  const id = String(params.id || "");
  const origin = new URL(request.url).origin;
  const head = ID_RE.test(id) && env.CATCHES ? await env.CATCHES.head(`c/${id}.jpg`) : null;
  if (!head) return Response.redirect(`${origin}/`, 302);

  let meta = {};
  try { meta = JSON.parse(head.customMetadata?.meta || "{}"); } catch {}
  const who = meta.n ? `${meta.n} caught` : "Check out this catch:";
  const fish = meta.ct > 1 ? `${meta.ct} ${String(meta.sp).toLowerCase()}` : `${/^[aeiou]/i.test(meta.sp || "") ? "an" : "a"} ${String(meta.sp || "fish").toLowerCase()}`;
  const size = meta.lb != null ? ` (${meta.lb} lb)` : meta.in != null ? ` (${meta.in}")` : "";
  const title = `${who} ${fish}${size}`;
  const desc = [meta.lu ? `On a ${String(meta.lu).toLowerCase()}` : "", meta.w || "", "Logged with Firetiger Fishing Log"].filter(Boolean).join(" · ");
  const app = `${origin}/#catch=${b64url(JSON.stringify(meta))}&img=${id}`;
  const img = `${origin}/img/${id}`;

  const html = `<!doctype html><html lang="en"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>${esc(title)}</title>
<meta property="og:type" content="website">
<meta property="og:title" content="${esc(title)}">
<meta property="og:description" content="${esc(desc)}">
<meta property="og:image" content="${esc(img)}">
<meta property="og:image:width" content="1080"><meta property="og:image:height" content="1350">
<meta property="og:url" content="${esc(`${origin}/c/${id}`)}">
<meta name="twitter:card" content="summary_large_image">
<meta http-equiv="refresh" content="0;url=${esc(app)}">
<style>body{margin:0;background:#0D1A20;color:#EDF2EA;font:16px system-ui,sans-serif;display:grid;place-items:center;min-height:100vh}a{color:#C8E62E}</style>
</head><body><p><a href="${esc(app)}">Open the catch</a></p><script>location.replace(${JSON.stringify(app)})</script></body></html>`;
  return new Response(html, { headers: { "content-type": "text/html; charset=utf-8", "cache-control": "public, max-age=300" } });
}
