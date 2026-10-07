// GET /img/<id> — the shared catch card image from R2.
import { ID_RE } from "../_lib.js";

export async function onRequestGet({ params, env }) {
  const id = String(params.id || "").replace(/\.jpg$/, "");
  if (!ID_RE.test(id) || !env.CATCHES) return new Response("Not found", { status: 404 });
  const obj = await env.CATCHES.get(`c/${id}.jpg`);
  if (!obj) return new Response("Not found", { status: 404 });
  return new Response(obj.body, { headers: { "content-type": "image/jpeg", "cache-control": "public, max-age=31536000, immutable" } });
}
