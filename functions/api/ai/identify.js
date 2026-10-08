// fishr ID: name the fish in a photo. The photo isn't stored.
// GET  /api/ai/identify -> { left, limit, signedIn }   today's allowance
// POST /api/ai/identify { image: <base64 JPEG/PNG/WebP>, type } -> { isFish, species, confidence, alternatives, reason, left }
// Anyone can try a few a day (counted by hashed IP); fishr Cloud accounts get more.
import { json } from "../../_lib.js";
import { handle, fail, currentUser } from "../../_auth.js";
import { MODEL, claude, aiError, textOf, allowance, requireAI, usedToday, takeOne, visitorId, SPECIES } from "../../_ai.js";

const TYPES = ["image/jpeg", "image/png", "image/webp"];
const MAX_B64 = 3_000_000; // about 2.2 MB of image; the app sends ~1600 px JPEGs well under this

const SYSTEM = `You identify fish species in anglers' photos for a North American fishing log.
When one of these names fits, use it exactly as written: ${SPECIES.join(", ")}.
Otherwise use the common North American name. If the photo doesn't show a fish, or the fish can't be identified, set is_fish or confidence accordingly instead of guessing.
In reason, give the one or two visible features that decided it, in under 20 words.`;

const SCHEMA = {
  type: "object",
  properties: {
    is_fish: { type: "boolean" },
    species: { type: "string" },
    confidence: { type: "string", enum: ["high", "medium", "low"] },
    alternatives: { type: "array", items: { type: "string" } },
    reason: { type: "string" },
  },
  required: ["is_fish", "species", "confidence", "alternatives", "reason"],
  additionalProperties: false,
};

async function who(request, env) {
  const user = await currentUser(request, env);
  if (!user) return { who: await visitorId(request), kind: "idguest", limit: allowance(env, "idguest") };
  requireAI(user, env);
  return { user, who: user.id, kind: "photo", limit: allowance(env, "photo", user.plan) };
}

export async function onRequestGet({ request, env }) {
  return handle(async () => {
    const a = await who(request, env);
    return json({ signedIn: !!a.user, limit: a.limit, left: Math.max(0, a.limit - await usedToday(env, a.who, a.kind)), ready: !!env.ANTHROPIC_API_KEY });
  });
}

export async function onRequestPost({ request, env }) {
  return handle(async () => {
    if (!(request.headers.get("content-type") || "").includes("application/json")) fail("Send JSON.", 415);
    const body = await request.json().catch(() => null);
    const image = String(body?.image || ""), type = String(body?.type || "image/jpeg");
    if (!TYPES.includes(type)) fail("Photos must be JPEG, PNG or WebP.", 415);
    if (!image || image.length > MAX_B64 || !/^[A-Za-z0-9+/]+=*$/.test(image)) fail("That photo couldn't be read. Try another.", 400);
    const ai = claude(env);
    const a = await who(request, env);
    const { left, release } = await takeOne(env, a.who, a.kind, a.limit);
    let msg;
    try {
      msg = await ai.messages.create({
        model: MODEL, max_tokens: 1024, output_config: { effort: "low", format: { type: "json_schema", schema: SCHEMA } }, system: SYSTEM,
        messages: [{ role: "user", content: [{ type: "image", source: { type: "base64", media_type: type, data: image } }, { type: "text", text: "What fish is this?" }] }],
      });
    } catch (e) { await release(); throw aiError(e); }
    let out = null;
    if (msg.stop_reason !== "refusal") { try { out = JSON.parse(textOf(msg)); } catch {} }
    if (!out) { await release(); fail("Couldn't identify that photo. Try another angle.", 422); }
    const clean = s => String(s || "").trim().slice(0, 60);
    return json({ isFish: !!out.is_fish, species: clean(out.species), confidence: ["high", "medium", "low"].includes(out.confidence) ? out.confidence : "low",
      alternatives: (out.alternatives || []).map(clean).filter(Boolean).slice(0, 2), reason: String(out.reason || "").slice(0, 160), left });
  });
}
