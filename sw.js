/* Service worker for House App (home screen + every tool page).
 *
 * Strategy:
 *   HTML / navigation -> network-first, cache fallback. Online you get the newest
 *                        version you deployed; offline you get the last good one.
 *   Icons + manifest  -> cache-first, refreshed in the background.
 *
 * No third-party assets: both pages are fully self-contained, so the whole app
 * works offline once it has been opened online one time.
 *
 * Bump CACHE_VERSION when the file list below changes (added/renamed files).
 * Ordinary edits to the HTML files don't need a bump — network-first picks
 * them up.
 */

var CACHE_VERSION = "v4";
var CACHE_SHELL = "house-app-shell-" + CACHE_VERSION;

var SHELL_ASSETS = [
  "./",
  "./index.html",
  "./energy-tracker.html",
  "./oni-orders.html",
  "./grocery.html",
  "./todo.html",
  "./manifest.webmanifest",
  "./icons/house.svg",
  "./icons/house-32.png",
  "./icons/house-180.png",
  "./icons/house-192.png",
  "./icons/house-512.png",
  "./icons/house-maskable-512.png",
  "./icons/energy.svg",
  "./icons/energy-32.png",
  "./icons/energy-180.png",
  "./icons/energy-192.png",
  "./icons/oni.svg",
  "./icons/oni-32.png",
  "./icons/oni-180.png",
  "./icons/oni-192.png",
  "./icons/grocery.svg",
  "./icons/grocery-32.png",
  "./icons/grocery-180.png",
  "./icons/grocery-192.png",
  "./icons/todo.svg",
  "./icons/todo-32.png",
  "./icons/todo-180.png",
  "./icons/todo-192.png"
];

self.addEventListener("install", function (event) {
  event.waitUntil(
    caches.open(CACHE_SHELL).then(function (cache) {
      // Individually, so one failed asset can't abort the whole install.
      return Promise.all(SHELL_ASSETS.map(function (url) {
        return cache.add(new Request(url, { cache: "reload" })).catch(function (err) {
          console.warn("[sw] precache skipped:", url, err);
        });
      }));
    }).then(function () { return self.skipWaiting(); })
  );
});

self.addEventListener("activate", function (event) {
  event.waitUntil(
    caches.keys().then(function (keys) {
      return Promise.all(keys.filter(function (k) { return k !== CACHE_SHELL; })
        .map(function (k) { return caches.delete(k); }));
    }).then(function () { return self.clients.claim(); })
  );
});

self.addEventListener("fetch", function (event) {
  var req = event.request;
  if (req.method !== "GET") return;
  var url = new URL(req.url);
  if (url.origin !== self.location.origin) return;

  if (req.mode === "navigate" || url.pathname.endsWith(".html") || url.pathname.endsWith("/")) {
    event.respondWith(networkFirst(req));
    return;
  }
  event.respondWith(cacheFirst(req));
});

function networkFirst(req) {
  return caches.open(CACHE_SHELL).then(function (cache) {
    return fetch(req).then(function (res) {
      if (res && res.ok) cache.put(req, res.clone());
      return res;
    }).catch(function () {
      return cache.match(req, { ignoreSearch: true }).then(function (hit) {
        if (hit) return hit;
        return cache.match("./index.html").then(function (home) {
          return home || new Response(
            "<h1>Offline</h1><p>This page hasn't been cached yet. Open it once while online and it will work offline afterwards.</p>",
            { status: 503, headers: { "Content-Type": "text/html; charset=utf-8" } }
          );
        });
      });
    });
  });
}

function cacheFirst(req) {
  return caches.open(CACHE_SHELL).then(function (cache) {
    return cache.match(req, { ignoreSearch: true }).then(function (hit) {
      var net = fetch(req).then(function (res) {
        if (res && res.ok) cache.put(req, res.clone());
        return res;
      });
      if (hit) { net.catch(function () {}); return hit; }
      return net.catch(function () { return new Response("", { status: 504, statusText: "Offline" }); });
    });
  });
}
