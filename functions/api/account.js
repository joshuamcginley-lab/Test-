// DELETE /api/account — deletes the signed-in angler's cloud account: every synced trip, note, setting, photo,
// passkey record and session. Trips already on their devices stay there.
import { json } from "../_lib.js";
import { db, handle, fail, requireUser, withCookies, endSession } from "../_auth.js";

export async function onRequestDelete({ request, env }) {
  return handle(async () => {
    if (!(request.headers.get("content-type") || "").includes("application/json")) fail("Send JSON.", 415);
    const user = await requireUser(request, env), DB = await db(env);
    if (env.CATCHES) {
      let cursor;
      do {
        const page = await env.CATCHES.list({ prefix: `u/${user.id}/`, cursor, limit: 1000 });
        if (page.objects.length) await env.CATCHES.delete(page.objects.map(o => o.key));
        cursor = page.truncated ? page.cursor : null;
      } while (cursor);
    }
    const cookies = await endSession(request, env);
    await DB.batch(["trips", "meta", "passkeys", "sessions", "challenges", "ai_usage"].map(t => DB.prepare(`DELETE FROM ${t} WHERE user_id = ?`).bind(user.id))
      .concat(DB.prepare("DELETE FROM users WHERE id = ?").bind(user.id)));
    return withCookies(json({ ok: true }), cookies);
  });
}
