// POST /api/share — multipart form with `image` (the JPEG catch card) and `meta` (JSON catch details).
// Saves to R2 and returns a short link: { id, url }.
import { newId, cleanMeta, json } from "../_lib.js";

const MAX_BYTES = 1.5 * 1024 * 1024;

export async function onRequestPost({ request, env }) {
  if (!env.CATCHES) return json({ error: "Sharing storage isn't set up yet." }, 503);
  const len = Number(request.headers.get("content-length") || 0);
  if (len > MAX_BYTES + 8192) return json({ error: "Image too large." }, 413);
  if (!(request.headers.get("content-type") || "").startsWith("multipart/form-data")) return json({ error: "Expected a form upload." }, 400);

  let form;
  try { form = await request.formData(); } catch { return json({ error: "Couldn't read the upload." }, 400); }
  const image = form.get("image"), metaRaw = form.get("meta");
  if (!image || typeof image === "string" || typeof metaRaw !== "string" || metaRaw.length > 2048) return json({ error: "Missing image or details." }, 400);
  if (image.size > MAX_BYTES) return json({ error: "Image too large." }, 413);

  const bytes = new Uint8Array(await image.arrayBuffer());
  if (bytes.length < 4 || bytes[0] !== 0xff || bytes[1] !== 0xd8 || bytes[2] !== 0xff) return json({ error: "Only JPEG images are accepted." }, 415);

  let meta;
  try { meta = cleanMeta(JSON.parse(metaRaw)); } catch { meta = null; }
  if (!meta) return json({ error: "Catch details are invalid." }, 400);

  const id = newId();
  await env.CATCHES.put(`c/${id}.jpg`, bytes, {
    httpMetadata: { contentType: "image/jpeg", cacheControl: "public, max-age=31536000, immutable" },
    customMetadata: { meta: JSON.stringify(meta), created: new Date().toISOString() },
  });
  const origin = new URL(request.url).origin;
  return json({ id, url: `${origin}/c/${id}` }, 201);
}
