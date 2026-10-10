// Offline support: app files are cached on install; fonts are cached the first time they load.
const VERSION = "fishr-v68";
const APP = ["./", "index.html", "styles.css?v=68", "app.js?v=68", "forecast.js?v=68", "conditions.js?v=68", "bite-core.js?v=68", "live.js?v=68", "map.js?v=68", "pro.js?v=68", "cloud.js?v=68", "polish.js?v=68", "guide.js?v=68", "ai.js?v=68", "report.js?v=68", "privacy.html", "share.js?v=68", "usage.js?v=68", "alerts.js?v=68", "sample.json", "manifest.webmanifest", "icons/favicon-64.png", "icons/mark-128.png", "icons/mark-512.png", "icons/icon-192.png", "icons/apple-touch-icon.png"];

self.addEventListener("install", e => {
  e.waitUntil(caches.open(VERSION).then(c => c.addAll(APP)).then(() => self.skipWaiting()));
});
self.addEventListener("activate", e => {
  e.waitUntil(caches.keys().then(keys => Promise.all(keys.filter(k => k !== VERSION).map(k => caches.delete(k)))).then(() => self.clients.claim()));
});
self.addEventListener("fetch", e => {
  const req = e.request;
  if (req.method !== "GET") return;
  const url = new URL(req.url);
  if (url.origin === location.origin && /^\/(api|c|img)\//.test(url.pathname)) return;
  if (url.origin === location.origin) {
    // Network first so updates arrive when online. On a weak signal (common on the water), fall back to the
    // cached copy after 3 seconds instead of waiting for the network to give up. Only good responses are cached.
    const fromNet = fetch(req).then(res => {
      if (res.ok) { const copy = res.clone(); caches.open(VERSION).then(c => c.put(req, copy)); }
      return res;
    });
    const page = req.mode === "navigate";
    const fromCache = () => caches.match(req).then(r => r || (page ? caches.match("index.html") : undefined));
    e.respondWith(new Promise(resolve => {
      let done = false; const use = r => { if (!done && r) { done = true; resolve(r); } };
      const t = setTimeout(() => fromCache().then(use), 3000);
      fromNet.then(r => { clearTimeout(t); use(r); }).catch(() => { clearTimeout(t); fromCache().then(r => use(r || Response.error())); });
      // If the cache had nothing at 3 s, the network answer (whenever it comes) is still used.
    }));
  } else if (url.hostname.endsWith("fonts.googleapis.com") || url.hostname.endsWith("fonts.gstatic.com")) {
    e.respondWith(caches.match(req).then(hit => hit || fetch(req).then(res => {
      const copy = res.clone(); caches.open(VERSION).then(c => c.put(req, copy)); return res;
    })));
  }
});

// Bite alerts: show the notification the server sent, and open the Guide when it's tapped.
self.addEventListener("push", e => {
  let d = {}; try { d = e.data ? e.data.json() : {}; } catch (x) {}
  e.waitUntil(self.registration.showNotification(d.title || "fishr", {
    body: d.body || "", icon: "icons/icon-192.png", badge: "icons/favicon-64.png", tag: d.tag || "fishr", data: { url: d.url || "./" },
  }));
});
self.addEventListener("notificationclick", e => {
  e.notification.close();
  const url = new URL(e.notification.data?.url || "./", self.registration.scope).href;
  e.waitUntil(self.clients.matchAll({ type: "window", includeUncontrolled: true }).then(list => {
    const open = list.find(c => c.url.startsWith(self.registration.scope));
    if (open) return open.focus().then(c => c.navigate ? c.navigate(url) : c);
    return self.clients.openWindow(url);
  }));
});
