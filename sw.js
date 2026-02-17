/* Offline/weak-signal resilience service worker (Offroad Brothers)
   Goals:
   - Network-first for HTML (fresh content when online)
   - Cache-first for static + media
   - Safari/iOS friendly video playback via Range request support for cached MP4/WebM
*/
const CACHE_VERSION = "offroad-v1-2026-02-17";
const CORE_CACHE = `core-${CACHE_VERSION}`;
const RUNTIME_CACHE = `runtime-${CACHE_VERSION}`;

// Same-origin core files you always want offline.
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
      Promise.all(keys.filter((k) => !k.includes(CACHE_VERSION)).map((k) => caches.delete(k)))
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

async function cachePutSafe(cacheName, request, response){
  try{
    const cache = await caches.open(cacheName);
    await cache.put(request, response);
  }catch(e){}
}

// Range support (Safari/iOS)
async function serveRangeFromCache(event){
  const req = event.request;
  const range = req.headers.get("range");
  if(!range) return null;

  // Match by URL to ignore Range header in cache key.
  const cached = await caches.match(req.url);
  if(!cached) return null;

  // If the cached response is opaque (no-cors), we cannot slice it for Range.
  if(cached.type === 'opaque') return null;

  let buf;
  try{ buf = await cached.arrayBuffer(); }catch(e){ return null; }
  const size = buf.byteLength;

  // Parse: bytes=start-end
  const m = /bytes=(\d*)-(\d*)/i.exec(range);
  if(!m) return cached;

  let start = m[1] ? parseInt(m[1], 10) : 0;
  let end = m[2] ? parseInt(m[2], 10) : (size - 1);

  // Clamp
  if(Number.isNaN(start)) start = 0;
  if(Number.isNaN(end) || end >= size) end = size - 1;
  if(start > end) start = 0;

  const chunk = buf.slice(start, end + 1);

  const headers = new Headers(cached.headers);
  headers.set("Content-Range", `bytes ${start}-${end}/${size}`);
  headers.set("Accept-Ranges", "bytes");
  headers.set("Content-Length", String(chunk.byteLength));

  // Keep original content-type if present; otherwise guess mp4.
  if(!headers.get("Content-Type")) headers.set("Content-Type", "video/mp4");

  return new Response(chunk, { status: 206, statusText: "Partial Content", headers });
}

self.addEventListener("fetch", (event) => {
  const req = event.request;
  if(req.method !== "GET") return;

  // Network-first for HTML
  if(isHTML(req)){
    event.respondWith(
      fetch(req)
        .then((res) => {
          cachePutSafe(CORE_CACHE, req, res.clone());
          return res;
        })
        .catch(() => caches.match(req).then((m) => m || caches.match("./index.html")))
    );
    return;
  }

  // Media (cache-first + Range support)
  if(isMedia(req)){
    event.respondWith((async () => {
      // If it's a Range request, try cache-range first.
      const ranged = await serveRangeFromCache(event);
      if(ranged) return ranged;

      // Otherwise normal cache-first.
      const cached = await caches.match(req.url);
      if(cached) return cached;

      try{
        const res = await fetch(req);
        cachePutSafe(RUNTIME_CACHE, req.url, res.clone());
        return res;
      }catch(e){
        return cached || new Response("", { status: 504, statusText: "Offline" });
      }
    })());
    return;
  }

  // Static assets (cache-first)
  if(isStatic(req)){
    event.respondWith(
      caches.match(req.url).then((cached) => {
        if(cached) return cached;
        return fetch(req)
          .then((res) => {
            cachePutSafe(RUNTIME_CACHE, req.url, res.clone());
            return res;
          })
          .catch(() => cached || new Response("", { status: 504, statusText: "Offline" }));
      })
    );
    return;
  }

  // Default: network, fallback cache
  event.respondWith(fetch(req).catch(() => caches.match(req)));
});
