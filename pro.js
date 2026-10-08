"use strict";
/* fishr Pro waitlist sheet. Sign-ups go to /api/waitlist (stored in R2) with explicit email consent. */

async function waitlistCount() {
  try { const r = await fetch("/api/waitlist"); if (r.ok) return (await r.json()).count || 0; } catch (e) {}
  return null;
}
function showCount(n) {
  $("wlCount").innerHTML = n == null ? "" : n >= 10
    ? `<span class="live-dot"></span><b>${n.toLocaleString()}</b> anglers on the waitlist`
    : `<span class="live-dot"></span>Be one of the first anglers on the list`;
}
async function openPro() {
  const joined = state.settings.waitlist;
  $("wlForm").hidden = !!joined; $("wlDone").hidden = !joined;
  if (joined) $("wlDone").innerHTML = `<b>You're on the list.</b> We'll email ${esc(joined.email)} when your invite is ready.`;
  $("wlErr").hidden = true;
  $("scrim").hidden = false; $("proSheet").hidden = false; $("proSheet").scrollTop = 0;
  showCount(await waitlistCount());
}
["topPro", "copilotPro", "settingsPro"].forEach(id => $(id).addEventListener("click", () => { closeSheets(); openPro(); }));
$("proClose").onclick = closeSheets;

$("wlForm").addEventListener("submit", async e => {
  e.preventDefault();
  const email = $("wlEmail").value.trim(), err = $("wlErr");
  const fail = m => { err.hidden = false; err.textContent = m; };
  err.hidden = true;
  if (!/^\S+@\S+\.\S+$/.test(email)) return fail("Enter your email address.");
  if (!$("wlConsent").checked) return fail("Tick the box so we're allowed to email you.");
  $("wlGo").disabled = true; $("wlGo").textContent = "Joining…";
  try {
    const res = await fetch("/api/waitlist", { method: "POST", headers: { "content-type": "application/json" },
      body: JSON.stringify({ email, name: $("wlName").value.trim(), consent: true, website: $("wlWebsite").value }) });
    const d = await res.json().catch(() => ({}));
    if (!res.ok) return fail(d.error || "Couldn't join right now. Try again in a minute.");
    state.settings.waitlist = { email, at: new Date().toISOString() }; save();
    $("wlForm").hidden = true; $("wlDone").hidden = false;
    $("wlDone").innerHTML = d.already ? `<b>You're already on the list.</b> We'll email ${esc(email)} when your invite is ready.`
      : `<b>You're #${d.count} on the list.</b> We'll email ${esc(email)} when your invite is ready.`;
    showCount(d.count);
  } catch (e2) { fail("No connection. Try again when you have signal."); }
  finally { $("wlGo").disabled = false; $("wlGo").textContent = "Join the waitlist"; }
});
