// Receives workout files shared to the installed app (see "share_target" in site.webmanifest). The page is
// static, so this hands the files to it through a cache and opens it; trackfiles.js picks them up.
const SHARE_CACHE = "adventuremap-shared";

self.addEventListener("install", () => self.skipWaiting());
self.addEventListener("activate", (e) => e.waitUntil(self.clients.claim()));

self.addEventListener("fetch", (e) => {
  const url = new URL(e.request.url);
  if (e.request.method !== "POST" || !url.pathname.endsWith("/share")) return;
  e.respondWith((async () => {
    const form = await e.request.formData();
    const cache = await caches.open(SHARE_CACHE);
    let i = 0;
    // Any file field counts, in case the sharing app names it differently.
    for (const file of [...form.values()].filter((v) => v instanceof File)) {
      await cache.put(`shared/${Date.now()}-${i++}`,
        new Response(file, { headers: { "x-name": encodeURIComponent(file.name || "shared.fit") } }));
    }
    // Text or a link shared alongside (or instead of) a file, kept so the app can say what arrived.
    const words = ["title", "text", "url"].map((k) => form.get(k)).filter((v) => typeof v === "string" && v).join(" ");
    if (words) await cache.put(`shared/${Date.now()}-text`, new Response(words, { headers: { "x-name": "shared-text", "x-text": "1" } }));
    return Response.redirect("./?shared", 303);
  })());
});
