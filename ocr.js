/* Odometer reader that runs on the phone: Tesseract (WebAssembly) plus a
   picker that uses the last logged reading to choose the right number.
   Nothing leaves the device. Exposes window.MileageOCR. */
(function (root) {
  'use strict';
  var here = (document.currentScript && document.currentScript.src) || location.href;
  var VENDOR = new URL('vendor/tesseract/', here).href;
  var workerP = null, listener = null, ready = false;

  function loadScript(src) {
    return new Promise(function (resolve, reject) {
      var s = document.createElement('script');
      s.src = src; s.async = true;
      s.onload = resolve;
      s.onerror = function () { reject(new Error('The photo reader did not load. Check your connection and try again.')); };
      document.head.appendChild(s);
    });
  }

  function worker() {
    if (workerP) return workerP;
    workerP = (root.Tesseract ? Promise.resolve() : loadScript(VENDOR + 'tesseract.min.js')).then(function () {
      return root.Tesseract.createWorker('eng', 1, {
        workerPath: VENDOR + 'worker.min.js',
        corePath: VENDOR,
        langPath: VENDOR,
        gzip: true,
        workerBlobURL: false,
        logger: function (m) { if (listener) try { listener(m); } catch (e) {} }
      });
    }).then(function (w) { ready = true; return w; });
    workerP.catch(function () { workerP = null; });
    return workerP;
  }

  /* ---------------------------------------------------------- image prep */
  function loadImage(src) {
    if (src && src.getContext) return Promise.resolve(src);
    return new Promise(function (resolve, reject) {
      var url = URL.createObjectURL(src), img = new Image();
      img.onload = function () { URL.revokeObjectURL(url); resolve(img); };
      img.onerror = function () { URL.revokeObjectURL(url); reject(new Error('Could not open that image.')); };
      img.src = url;
    });
  }
  function toCanvas(img, maxDim) {
    var w = img.naturalWidth || img.width, h = img.naturalHeight || img.height;
    var sc = Math.min(maxDim / Math.max(w, h), 2);
    var c = document.createElement('canvas');
    c.width = Math.max(1, Math.round(w * sc)); c.height = Math.max(1, Math.round(h * sc));
    var ctx = c.getContext('2d');
    ctx.imageSmoothingQuality = 'high';
    ctx.drawImage(img, 0, 0, c.width, c.height);
    return c;
  }
  function percentile(hist, n, q) {
    var t = n * q, a = 0;
    for (var v = 0; v < 256; v++) { a += hist[v]; if (a >= t) return v; }
    return 255;
  }
  // Grayscale, stretch contrast, and flip light-on-dark displays to dark text on light.
  function grayStretch(c) {
    var w = c.width, h = c.height, ctx = c.getContext('2d'), id = ctx.getImageData(0, 0, w, h), p = id.data, n = w * h;
    var g = new Uint8ClampedArray(n), hist = new Uint32Array(256), sum = 0, i, v;
    for (i = 0; i < n; i++) { v = (p[4 * i] * 77 + p[4 * i + 1] * 150 + p[4 * i + 2] * 29) >> 8; g[i] = v; hist[v]++; sum += v; }
    var inv = sum / n < 115, lo = percentile(hist, n, 0.02), hi = percentile(hist, n, 0.995), k = 255 / Math.max(16, hi - lo);
    for (i = 0; i < n; i++) {
      v = (g[i] - lo) * k; v = v < 0 ? 0 : v > 255 ? 255 : v;
      if (inv) v = 255 - v;
      g[i] = v; p[4 * i] = p[4 * i + 1] = p[4 * i + 2] = v; p[4 * i + 3] = 255;
    }
    var out = document.createElement('canvas'); out.width = w; out.height = h;
    out.getContext('2d').putImageData(id, 0, 0);
    return { canvas: out, gray: g, w: w, h: h };
  }
  // Local-mean threshold (handles glare and uneven light).
  function adaptive(G, frac, C) {
    var w = G.w, h = G.h, g = G.gray, r = Math.max(8, Math.round(Math.max(w, h) * frac / 2));
    var W1 = w + 1, I = new Float64Array(W1 * (h + 1)), x, y;
    for (y = 1; y <= h; y++) {
      var row = 0;
      for (x = 1; x <= w; x++) { row += g[(y - 1) * w + x - 1]; I[y * W1 + x] = I[(y - 1) * W1 + x] + row; }
    }
    var out = document.createElement('canvas'); out.width = w; out.height = h;
    var octx = out.getContext('2d'), id = octx.createImageData(w, h), p = id.data;
    for (y = 0; y < h; y++) {
      var y0 = Math.max(0, y - r), y1 = Math.min(h, y + r + 1);
      for (x = 0; x < w; x++) {
        var x0 = Math.max(0, x - r), x1 = Math.min(w, x + r + 1);
        var s = I[y1 * W1 + x1] - I[y0 * W1 + x1] - I[y1 * W1 + x0] + I[y0 * W1 + x0];
        var m = s / ((x1 - x0) * (y1 - y0)), j = y * w + x, v = g[j] < m - C ? 0 : 255;
        p[4 * j] = p[4 * j + 1] = p[4 * j + 2] = v; p[4 * j + 3] = 255;
      }
    }
    octx.putImageData(id, 0, 0);
    return out;
  }

  /* --------------------------------------------------------- recognition */
  // White margin (text touching the edge reads badly), optionally rotated to undo a tilted shot.
  function framed(src, deg) {
    var m = 28, a = (deg || 0) * Math.PI / 180, cw = src.width, ch = src.height;
    var w = Math.ceil(Math.abs(cw * Math.cos(a)) + Math.abs(ch * Math.sin(a))) + 2 * m;
    var h = Math.ceil(Math.abs(cw * Math.sin(a)) + Math.abs(ch * Math.cos(a))) + 2 * m;
    var c = document.createElement('canvas'); c.width = w; c.height = h;
    var x = c.getContext('2d');
    x.fillStyle = '#fff'; x.fillRect(0, 0, w, h);
    x.translate(w / 2, h / 2); if (a) x.rotate(a);
    x.drawImage(src, -cw / 2, -ch / 2);
    return c;
  }
  function recognize(w, canvas, psm, whitelist) {
    return w.setParameters({ tessedit_pageseg_mode: String(psm), tessedit_char_whitelist: whitelist || '' })
      .then(function () { return w.recognize(canvas, {}, { text: true, blocks: true }); })
      .then(function (r) { return r.data; });
  }
  var MAP = { O: '0', o: '0', Q: '0', D: '0', U: '0', u: '0', l: '1', I: '1', i: '1', '|': '1', '!': '1', J: '1', ']': '1', '[': '1',
    Z: '2', z: '2', S: '5', s: '5', B: '8', G: '6', b: '6', g: '9', q: '9', T: '7', A: '4' };
  // Turn one recognized word into odometer digits, or null if it isn't one.
  function clean(tok) {
    var t = String(tok || '').replace(/^[^0-9A-Za-z|!\][]+|[^0-9A-Za-z|!\][]+$/g, '').replace(/(mi|MI|Mi|km|KM)$/, '');
    var core = t.replace(/[,.'’ ]/g, ''), dg = (core.match(/\d/g) || []).length;
    if (core.length < 4 || dg / core.length < 0.65) return null;
    t = t.split('').map(function (ch) { return MAP[ch] || ch; }).join('');
    if (/^\d{1,3}([,.'’ ]\d{3})+$/.test(t)) t = t.replace(/[^0-9]/g, '');   // 119,772
    else if (/[,.]/.test(t)) return null;                                         // 106.5 is a trip meter
    return /^\d{4,7}$/.test(t) ? t : null;
  }
  function candidates(data, pass) {
    var out = [];
    (data.blocks || []).forEach(function (b) {
      (b.paragraphs || []).forEach(function (pa) {
        (pa.lines || []).forEach(function (l) {
          var ws = l.words || [];
          ws.forEach(function (w, i) {
            var h = w.bbox ? w.bbox.y1 - w.bbox.y0 : 0, t = clean(w.text);
            if (t) out.push({ value: +t, digits: t.length, conf: w.confidence || 0, pass: pass, text: w.text, h: h });
            var nx = ws[i + 1];   // "119 772" split into two words
            if (nx && /^\d{1,3}$/.test(w.text) && /^\d{3}$/.test(nx.text)) {
              var j = w.text + nx.text;
              out.push({ value: +j, digits: j.length, conf: Math.min(w.confidence || 0, nx.confidence || 0) - 5, pass: pass, text: w.text + ' ' + nx.text, h: h });
            }
          });
        });
      });
    });
    return out;
  }
  function plausible(v, prev) { return prev != null && v >= prev && v - prev <= 1500; }
  function choose(all, prev) {
    var by = {};
    all.forEach(function (c) {
      var k = c.value, e = by[k];
      if (!e) e = by[k] = { value: c.value, digits: c.digits, conf: 0, hits: 0, h: 0 };
      e.conf = Math.max(e.conf, c.conf); e.hits++; e.h = Math.max(e.h, c.h);
    });
    var list = Object.keys(by).map(function (k) { return by[k]; });
    if (!list.length) return null;
    var maxH = list.reduce(function (a, c) { return Math.max(a, c.h); }, 1);
    list.forEach(function (c) {
      var s = c.conf + 6 * (c.hits - 1) + 10 * (c.h / maxH);
      if (prev != null) {
        var d = c.value - prev;
        if (d >= 0 && d <= 1500) s += 100 - Math.min(40, d / 25);
        else if (Math.abs(d) < 30000 && c.digits === String(prev).length) s += 5;
        else s -= 40;
      } else s += c.digits === 6 ? 15 : c.digits === 5 ? 10 : 0;
      c.score = s;
    });
    // A reading that is a piece of a longer one (24967 inside 134967) is a partial read.
    list.forEach(function (c) {
      var a = String(c.value);
      if (list.some(function (o) { return o.digits > c.digits && String(o.value).indexOf(a) >= 0; })) c.score -= 15;
    });
    list.sort(function (a, b) { return b.score - a.score; });
    var best = list[0], ok = plausible(best.value, prev);
    var level = ok && (best.conf >= 70 || best.hits >= 2) ? 'high' : (ok || (prev == null && best.conf >= 85)) ? 'medium' : 'low';
    var alts = list.slice(1).filter(function (c) {
      var a = String(c.value), b = String(best.value);
      if (b.indexOf(a) >= 0 || a.indexOf(b) >= 0) return false;
      return prev == null ? c.digits >= 5 : plausible(c.value, prev) || Math.abs(c.value - prev) < 3000;
    }).slice(0, 2).map(function (c) { return c.value; });
    return { value: best.value, level: level, conf: Math.round(best.conf), alts: alts };
  }

  /* ----------------------------------------------------------------- API */
  // read(blob, { prev, onProgress, signal }) -> { value, level, conf, alts } or null
  function read(src, opts) {
    opts = opts || {};
    var prev = opts.prev != null && opts.prev !== '' ? +opts.prev : null, stopped = false;
    if (opts.signal) opts.signal.addEventListener('abort', function () { stopped = true; });
    listener = opts.onProgress || null;
    var found = [];
    function check() { if (stopped) { var e = new Error('Stopped'); e.code = 'cancelled'; throw e; } }
    function settled() { var b = choose(found, prev); return b && b.level === 'high' && (b.conf >= 85 || b.hits >= 2); }
    return Promise.all([worker(), loadImage(src)]).then(function (r) {
      check();
      var w = r[0], G = grayStretch(toCanvas(r[1], 1600));
      if (listener) listener({ status: 'reading', progress: 0 });
      // Cheapest first; stop as soon as a reading fits the last one.
      var passes = [
        function () { return recognize(w, framed(G.canvas), 11); },
        function () { return recognize(w, framed(adaptive(G, 0.04, 12)), 11); },
        function () { return recognize(w, framed(G.canvas), 11, '0123456789'); },
        function () { return recognize(w, framed(G.canvas, 9), 11); },
        function () { return recognize(w, framed(G.canvas, -9), 11); }
      ];
      var names = ['gray', 'binary', 'digits', 'rot+9', 'rot-9'];
      function step(i) {
        if (i >= passes.length || settled()) return;
        if (i >= 3) { var b = choose(found, prev); if (b && b.level !== 'low') return; }   // tilt passes only hunt for a missing reading
        return passes[i]().then(function (d) { check(); found = found.concat(candidates(d, names[i])); return step(i + 1); });
      }
      return step(0);
    }).then(function () {
      check();
      listener = null;
      root.MileageOCR._last = found;
      return choose(found, prev);
    }, function (e) { listener = null; throw e; });
  }

  root.MileageOCR = {
    read: read,
    warm: function () { worker().catch(function () {}); },
    isReady: function () { return ready; },
    _clean: clean, _choose: choose
  };
})(window);
