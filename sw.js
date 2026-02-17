/* sw.js — safe cache SW (does NOT touch videos) */

const CACHE_VERSION = "v1.0.0";
const STATIC_CACHE = `static-${CACHE_VERSION}`;

// Cache only your site’s own static assets (same-origin).
// Keep this conservative to avoid caching HTML that changes often.
const STATIC_EXTENSIONS = new Set([
  "css", "js", "mjs", "png", "jpg", "jpeg", "webp", "gif", "svg", "ico",
  "woff", "woff2", "ttf", "eot", "otf",
  "json", "txt"
]);

// Media extensions to NEVER intercept/cache (prevents playback issues)
const MEDIA_EXTENSIONS = new Set([
  "mp4", "webm", "mov", "m4v", "mp3", "wav", "ogg", "m4a",
  "m3u8", "ts"
]);

function getExt(url) {
  try {
    const u = new URL(url);
    const path = u.pathname || "";
    const last = path.split(".").pop();
    if (!last || last === path) return "";
    return last.toLowerCase();
  } catch {
    return "";
  }
}

function isSameOrigin(url) {
  try {
    return new URL(url).origin === self.location.origin;
  } catch {
    return false;
  }
}

function isMediaRequest(request) {
  const ext = getExt(request.url);
  if (MEDIA_EXTENSIONS.has(ext)) return true;
  // destination is very reliable for <video>, <audio>, <img>, etc.
  if (request.destination === "video" || request.destination === "audio") return true;
  return false;
}

function hasRangeHeader(request) {
  // Range requests MUST not be interfered with by SW unless you implement full range support.
  return request.headers.has("range");
}

self.addEventListener("install", (event) => {
  // Activate new SW ASAP
  self.skipWaiting();

  // Optional: pre-cache nothing to avoid mistakes.
  // If you want, you can add a tiny app-shell list here later.
  event.waitUntil(Promise.resolve());
});

self.addEventListener("activate", (event) => {
  event.waitUntil((async () => {
    // Remove old caches
    const keys = await caches.keys();
    await Promise.all(
      keys
        .filter((k) => k.startsWith("static-") && k !== STATIC_CACHE)
        .map((k) => caches.delete(k))
    );

    // Take control immediately
    await self.clients.claim();
  })());
});

self.addEventListener("fetch", (event) => {
  const request = event.request;

  // Only handle GET
  if (request.method !== "GET") return;

  // NEVER handle media or Range requests (this fixes your video problem)
  if (isMediaRequest(request) || hasRangeHeader(request)) return;

  // If request is cross-origin, do NOT touch it.
  // (Your videos are on another origin — this is exactly what we want.)
  if (!isSameOrigin(request.url)) return;

  const ext = getExt(request.url);

  // For navigation requests (HTML pages): network-first, fallback to cache.
  // This avoids “stale site” bugs.
  if (request.mode === "navigate") {
    event.respondWith((async () => {
      try {
        const network = await fetch(request);
        // Don’t cache HTML by default (safe). If you want offline later, we can.
        return network;
      } catch (err) {
        // Try cache fallback if something was cached somehow
        const cached = await caches.match(request);
        if (cached) return cached;
        throw err;
      }
    })());
    return;
  }

  // Only cache conservative static extensions (css/js/fonts/images/etc.)
  if (!STATIC_EXTENSIONS.has(ext)) {
    // For anything else same-origin (including HTML fragments), just pass through
    return;
  }

  // Stale-while-revalidate for static assets
  event.respondWith((async () => {
    const cache = await caches.open(STATIC_CACHE);
    const cached = await cache.match(request);

    const fetchPromise = (async () => {
      try {
        const response = await fetch(request);
        // Only cache successful, basic (same-origin) responses
        if (response && response.ok && response.type === "basic") {
          await cache.put(request, response.clone());
        }
        return response;
      } catch {
        // Network failed; if we have cached, use it
        if (cached) return cached;
        throw new Error("Network error and no cache available.");
      }
    })();

    // Serve cached immediately if present, update cache in background
    return cached || fetchPromise;
  })());
});
