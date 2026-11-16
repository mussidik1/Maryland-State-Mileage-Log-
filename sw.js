/* Offline-first. The app opens from the copy saved on the phone, so a slow or missing
   connection never holds it up. A new version downloads in the background and is used
   the next time the app opens. The photo reader is kept in its own cache, so it works
   offline too and isn't downloaded again with every update.
   RELEASES: bump VERSION here (and in me/sw.js) whenever any app file changes. */
var VERSION = '2026-11-16.1';
var SHELL_CACHE = 'mileage-log-shell-' + VERSION;
var READER_CACHE = 'mileage-log-reader-v7';   // tied to the Tesseract.js version in vendor/tesseract
var SHELL = ['./', './index.html', './app.js', './ocr.js', './form.js', './manifest.webmanifest', './reminder.ics',
  './vendor/pdf-lib.min.js', './icons/icon-192.png', './icons/icon-512.png', './icons/apple-touch-icon.png',
  './fonts/manrope-latin-400-normal.woff2', './fonts/manrope-latin-500-normal.woff2', './fonts/manrope-latin-600-normal.woff2',
  './fonts/manrope-latin-700-normal.woff2', './fonts/manrope-latin-800-normal.woff2'];

self.addEventListener('install', function (e) {
  e.waitUntil(caches.open(SHELL_CACHE).then(function (c) {
    // cache: 'reload' skips the browser's own HTTP cache, so a release is saved whole and current
    return c.addAll(SHELL.map(function (u) { return new Request(u, { cache: 'reload' }); }));
  }).then(function () { return self.skipWaiting(); }));
});

self.addEventListener('activate', function (e) {
  e.waitUntil(caches.keys().then(function (keys) {
    return Promise.all(keys.filter(function (k) {
      // Only this app's old copies. The personal page (me/) keeps its own caches.
      return k.indexOf('mileage-log-') === 0 && k.indexOf('mileage-log-me-') !== 0 && k !== SHELL_CACHE && k !== READER_CACHE;
    }).map(function (k) { return caches.delete(k); }));
  }).then(function () { return self.clients.claim(); }));
});

function fromCache(name, req) {
  return caches.open(name).then(function (c) { return c.match(req, { ignoreSearch: true }); });
}

self.addEventListener('fetch', function (e) {
  var req = e.request;
  if (req.method !== 'GET') return;
  var url = new URL(req.url);
  if (url.origin !== self.location.origin) return;
  var reader = url.pathname.indexOf('/vendor/tesseract/') >= 0;
  e.respondWith(fromCache(reader ? READER_CACHE : SHELL_CACHE, req).then(function (hit) {
    if (hit) return hit;
    return fetch(req).then(function (r) {
      if (reader && r && r.ok) {
        var copy = r.clone();
        caches.open(READER_CACHE).then(function (c) { return c.put(req, copy); }).catch(function () {});
      }
      return r;
    }, function () {
      // Offline and not saved: for a page load, fall back to the app itself.
      if (req.mode === 'navigate') return fromCache(SHELL_CACHE, './index.html');
      return Response.error();
    });
  }));
});
