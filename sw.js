/* Offline/weak-signal resilience service worker
   - Network-first for HTML (so content stays fresh)
   - Cache-first for images/fonts/videos (so UI/video still works when signal drops)
*/
const CACHE_VERSION = "offroad-v1-2026-02-16";
const CORE_CACHE = `core-${CACHE_VERSION}`;
const RUNTIME_CACHE = `runtime-${CACHE_VERSION}`;

// Add any same-origin core files you *always* want available offline.
const CORE_ASSETS = [
  "./",
  "./index.html",
  "./gallery.html"
];

self.addEventListener("install", (event) => {
  event.waitUntil(
    caches.open(CORE_CACHE).then((cache) => cache.addAll(CORE_ASSETS)).catch(() => {})
  );
  self.skipWaiting();
});

self.addEventListener("activate", (event) => {
  event.waitUntil(
    caches.keys().then((keys) =>
      Promise.all(
        keys
          .filter((k) => !k.includes(CACHE_VERSION))
          .map((k) => caches.delete(k))
      )
    )
  );
  self.clients.claim();
});

function isHTML(req){
  return req.mode === "navigate" || (req.headers.get("accept") || "").includes("text/html");
}
function isMedia(req){
  const url = new URL(req.url);
  return /\.(mp4|webm|mov|m4v)(\?|$)/i.test(url.pathname);
}
function isStatic(req){
  const url = new URL(req.url);
  return /\.(png|jpg|jpeg|webp|gif|svg|ico|css|js|woff|woff2|ttf|otf)(\?|$)/i.test(url.pathname);
}

self.addEventListener("fetch", (event) => {
  const req = event.request;
  // Only handle GET
  if(req.method !== "GET") return;

  // Network-first for HTML
  if(isHTML(req)){
    event.respondWith(
      fetch(req)
        .then((res) => {
          const copy = res.clone();
          caches.open(CORE_CACHE).then((c) => c.put(req, copy)).catch(() => {});
          return res;
        })
        .catch(() => caches.match(req).then((m) => m || caches.match("./index.html")))
    );
    return;
  }

  // Cache-first for media + static assets
  if(isMedia(req) || isStatic(req)){
    event.respondWith(
      caches.match(req).then((cached) => {
        if(cached) return cached;
        return fetch(req)
          .then((res) => {
            const copy = res.clone();
            caches.open(RUNTIME_CACHE).then((c) => c.put(req, copy)).catch(() => {});
            return res;
          })
          .catch(() => cached);
      })
    );
    return;
  }

  // Default: try network, fall back to cache
  event.respondWith(fetch(req).catch(() => caches.match(req)));
});
