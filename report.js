"use strict";
/* Anonymous crash reports: if something breaks on someone's phone, send the error (no trip data, no location)
   to /api/errors so it shows up on /admin.html. Loaded before the other scripts so it catches their errors. */
(function () {
  const VERSION = "0.4.2";
  if (/^(localhost|127\.)/.test(location.hostname) || location.protocol === "file:") return;
  const sent = new Set(); let count = 0;
  function send(msg, src, line, col, stack) {
    const key = `${msg}|${src}|${line}`;
    if (!msg || sent.has(key) || count >= 5) return;
    sent.add(key); count++;
    const body = JSON.stringify({ msg: String(msg).slice(0, 500), src: String(src || "").replace(location.origin, "").slice(0, 200), line, col,
      stack: String(stack || "").replace(new RegExp(location.origin.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"), "g"), "").slice(0, 2000),
      version: VERSION, screen: `${screen.width}x${screen.height}` });
    try { fetch("/api/errors", { method: "POST", headers: { "content-type": "application/json" }, body, keepalive: true }).catch(() => {}); } catch (e) {}
  }
  addEventListener("error", e => { if (e.message) send(e.message, e.filename, e.lineno, e.colno, e.error?.stack); });
  addEventListener("unhandledrejection", e => { const r = e.reason; send(r?.message || String(r), "", null, null, r?.stack); });
})();
