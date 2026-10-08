// Offline support: app files are cached on install; fonts are cached the first time they load.
const VERSION = "fishr-v51";
const APP = ["./", "index.html", "styles.css", "app.js", "forecast.js", "conditions.js", "live.js", "map.js", "pro.js", "cloud.js", "polish.js", "guide.js", "ai.js", "report.js", "privacy.html", "share.js", "sample.json", "manifest.webmanifest", "icons/favicon-64.png", "icons/mark-128.png", "icons/mark-512.png", "icons/icon-192.png", "icons/apple-touch-icon.png"];

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
    // Network first so updates arrive when online; cache when offline.
    e.respondWith(fetch(req).then(res => {
      const copy = res.clone(); caches.open(VERSION).then(c => c.put(req, copy)); return res;
    }).catch(() => caches.match(req).then(r => r || caches.match("index.html"))));
  } else if (url.hostname.endsWith("fonts.googleapis.com") || url.hostname.endsWith("fonts.gstatic.com")) {
    e.respondWith(caches.match(req).then(hit => hit || fetch(req).then(res => {
      const copy = res.clone(); caches.open(VERSION).then(c => c.put(req, copy)); return res;
    })));
  }
});
