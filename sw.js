// Minimal service worker so Android Chrome treats the site as an installable app.
// App files are fetched from the network first and fall back to the cache when offline.
// Cross-origin requests (map tiles, MapLibre, Firebase) are left to the browser.
const CACHE = "adventuremap-v1";
const SHELL = [
  "./",
  "index.html",
  "app.js",
  "sync.js",
  "site.webmanifest",
  "favicon.svg",
  "icon-192.png",
  "icon-512.png",
  "maskable-192.png",
  "maskable-512.png",
];

self.addEventListener("install", (event) => {
  event.waitUntil(caches.open(CACHE).then((c) => c.addAll(SHELL)).then(() => self.skipWaiting()));
});

self.addEventListener("activate", (event) => {
  event.waitUntil(
    caches.keys()
      .then((keys) => Promise.all(keys.filter((k) => k !== CACHE).map((k) => caches.delete(k))))
      .then(() => self.clients.claim())
  );
});

self.addEventListener("fetch", (event) => {
  const req = event.request;
  if (req.method !== "GET" || new URL(req.url).origin !== self.location.origin) return;
  event.respondWith(
    fetch(req)
      .then((res) => {
        if (res.ok) {
          const copy = res.clone();
          caches.open(CACHE).then((c) => c.put(req, copy));
        }
        return res;
      })
      .catch(() => caches.match(req, { ignoreSearch: true }).then((hit) => hit || caches.match("./")))
  );
});
