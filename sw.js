/* Offline support. The app itself is network-first, so a new version arrives
   the next time the app opens online; the large libraries are cache-first. */
var CACHE = 'mileage-log-v1';
var SHELL = ['./', './index.html', './app.js', './ocr.js', './form.js', './manifest.webmanifest', './reminder.ics',
  './vendor/pdf-lib.min.js', './icons/icon-192.png', './icons/apple-touch-icon.png',
  './fonts/manrope-latin-400-normal.woff2', './fonts/manrope-latin-500-normal.woff2', './fonts/manrope-latin-600-normal.woff2',
  './fonts/manrope-latin-700-normal.woff2', './fonts/manrope-latin-800-normal.woff2'];

self.addEventListener('install', function (e) {
  e.waitUntil(caches.open(CACHE).then(function (c) { return c.addAll(SHELL); }).then(function () { return self.skipWaiting(); }));
});
self.addEventListener('activate', function (e) {
  e.waitUntil(caches.keys().then(function (keys) {
    return Promise.all(keys.filter(function (k) { return k !== CACHE; }).map(function (k) { return caches.delete(k); }));
  }).then(function () { return self.clients.claim(); }));
});
function networkFirst(req) {
  return caches.open(CACHE).then(function (c) {
    var net = fetch(req).then(function (r) { if (r && r.ok) c.put(req, r.clone()); return r; });
    var slow = new Promise(function (res) { setTimeout(res, 3500, null); });
    return Promise.race([net.catch(function () { return null; }), slow]).then(function (r) {
      return r || c.match(req, { ignoreSearch: true }).then(function (m) { return m || net; });
    });
  });
}
function cacheFirst(req) {
  return caches.open(CACHE).then(function (c) {
    return c.match(req).then(function (m) {
      return m || fetch(req).then(function (r) { if (r && r.ok) c.put(req, r.clone()); return r; });
    });
  });
}
self.addEventListener('fetch', function (e) {
  var req = e.request;
  if (req.method !== 'GET') return;
  var url = new URL(req.url);
  if (url.origin !== self.location.origin) return;
  e.respondWith(/\/(vendor|fonts|icons)\//.test(url.pathname) ? cacheFirst(req) : networkFirst(req));
});
