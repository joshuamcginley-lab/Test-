// A signed-in angler's catch photos, stored privately in R2 under u/<user id>/<photo id>.
// PUT    /api/photo/<id>  (image body)  -> { ok }
// GET    /api/photo/<id>                 -> the image
// DELETE /api/photo/<id>                 -> { ok }
import { json } from "../../_lib.js";
import { handle, fail, requireUser, requireCloud } from "../../_auth.js";

const ID_RE = /^p-[a-z0-9]{1,16}-[a-z0-9]{1,12}$/;
const TYPES = ["image/jpeg", "image/png", "image/webp"];
const MAX = 6 * 1024 * 1024;

export async function onRequest({ request, env, params }) {
  return handle(async () => {
    if (!ID_RE.test(params.id)) fail("Not found.", 404);
    if (!env.CATCHES) fail("Photo storage isn't set up yet.", 503);
    const user = await requireUser(request, env); requireCloud(user, env);
    const key = `u/${user.id}/${params.id}`;

    if (request.method === "GET") {
      const obj = await env.CATCHES.get(key);
      if (!obj) fail("Not found.", 404);
      return new Response(obj.body, { headers: { "content-type": obj.httpMetadata?.contentType || "image/jpeg", "cache-control": "private, max-age=31536000, immutable" } });
    }
    if (request.method === "PUT") {
      const type = (request.headers.get("content-type") || "").split(";")[0].trim();
      if (!TYPES.includes(type)) fail("Photos must be JPEG, PNG or WebP.", 415);
      const buf = await request.arrayBuffer();
      if (!buf.byteLength || buf.byteLength > MAX) fail("That photo is too large.", 413);
      await env.CATCHES.put(key, buf, { httpMetadata: { contentType: type } });
      return json({ ok: true });
    }
    if (request.method === "DELETE") {
      await env.CATCHES.delete(key);
      return json({ ok: true });
    }
    fail("Method not allowed.", 405);
  });
}
