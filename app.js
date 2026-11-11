/* Mileage Log: the State of Maryland Vehicle Mileage Log, kept on the phone.
   Data lives in this browser's storage (IndexedDB); nothing is sent anywhere
   unless the driver shares a PDF or a backup. */
(function () {
  'use strict';
  var VERSION = '1.0.0';
  var MF = window.MileageForm, OCR = window.MileageOCR;
  var $ = function (id) { return document.getElementById(id); };
  var pad = function (n) { return String(n).padStart(2, '0'); };
  var DOW = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];

  function todayISO() { var d = new Date(); return d.getFullYear() + '-' + pad(d.getMonth() + 1) + '-' + pad(d.getDate()); }
  function ymOf(iso) { return String(iso || '').slice(0, 7); }
  function addMonths(ym, n) {
    var p = ym.split('-').map(Number), t = p[0] * 12 + (p[1] - 1) + n;
    return Math.floor(t / 12) + '-' + pad(t % 12 + 1);
  }
  function fmt(n) { return (n == null || n === '' || isNaN(n)) ? '—' : Number(n).toLocaleString('en-US'); }
  function esc(s) { return String(s == null ? '' : s).replace(/[&<>"]/g, function (c) { return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]; }); }
  function uid() { return Date.now().toString(36) + Math.random().toString(36).slice(2, 8); }
  function clone(o) { return JSON.parse(JSON.stringify(o)); }
  function digits(s) { return String(s == null ? '' : s).replace(/[^0-9]/g, ''); }
  function routeHtml(stops) { return stops.map(esc).join('<span class="arrow">→</span>'); }
  function shortName(full) {
    var w = String(full || '').trim().split(/\s+/).filter(Boolean);
    return w.length < 2 ? w.join(' ') : w[0].charAt(0) + '. ' + w[w.length - 1];
  }

  var isIOS = /iPad|iPhone|iPod/.test(navigator.userAgent) || (navigator.platform === 'MacIntel' && navigator.maxTouchPoints > 1);
  var isStandalone = window.navigator.standalone === true || (window.matchMedia && matchMedia('(display-mode: standalone)').matches);

  /* ---------------------------------------------------------------- storage */
  // Key-value store on IndexedDB, with localStorage as a fallback.
  var Store = (function () {
    var NAME = 'mileage-log', ST = 'kv', LS = 'mileage-log:', dbp = null;
    function open() {
      if (dbp) return dbp;
      dbp = new Promise(function (resolve, reject) {
        if (!window.indexedDB) { reject(new Error('no indexedDB')); return; }
        var r;
        try { r = indexedDB.open(NAME, 1); } catch (e) { reject(e); return; }
        r.onupgradeneeded = function () { r.result.createObjectStore(ST); };
        r.onsuccess = function () { resolve(r.result); };
        r.onerror = function () { reject(r.error); };
        r.onblocked = function () { reject(new Error('blocked')); };
      });
      return dbp;
    }
    function run(mode, fn) {
      return open().then(function (db) {
        return new Promise(function (resolve, reject) {
          var t = db.transaction(ST, mode), out = fn(t.objectStore(ST));
          t.oncomplete = function () { resolve(out && 'result' in out ? out.result : undefined); };
          t.onerror = function () { reject(t.error); };
          t.onabort = function () { reject(t.error || new Error('aborted')); };
        });
      });
    }
    var ls = {
      all: function () {
        var o = {};
        for (var i = 0; i < localStorage.length; i++) {
          var k = localStorage.key(i);
          if (k.indexOf(LS) === 0) try { o[k.slice(LS.length)] = JSON.parse(localStorage.getItem(k)); } catch (e) {}
        }
        return Promise.resolve(o);
      },
      set: function (k, v) { try { localStorage.setItem(LS + k, JSON.stringify(v)); return Promise.resolve(); } catch (e) { return Promise.reject(e); } },
      del: function (k) { localStorage.removeItem(LS + k); return Promise.resolve(); },
      clear: function () { return ls.all().then(function (o) { Object.keys(o).forEach(function (k) { localStorage.removeItem(LS + k); }); }); }
    };
    var idb = {
      all: function () {
        return open().then(function (db) {
          return new Promise(function (resolve, reject) {
            var t = db.transaction(ST, 'readonly'), s = t.objectStore(ST), o = {}, c = s.openCursor();
            c.onsuccess = function () { var cur = c.result; if (cur) { o[cur.key] = cur.value; cur.continue(); } };
            t.oncomplete = function () { resolve(o); };
            t.onerror = function () { reject(t.error); };
          });
        });
      },
      set: function (k, v) { return run('readwrite', function (s) { s.put(v, k); }); },
      del: function (k) { return run('readwrite', function (s) { s.delete(k); }); },
      clear: function () { return run('readwrite', function (s) { s.clear(); }); }
    };
    var impl = null;
    function pick() {
      if (impl) return Promise.resolve(impl);
      return open().then(function () { impl = idb; return impl; }, function () { impl = ls; return impl; });
    }
    return {
      all: function () { return pick().then(function (i) { return i.all(); }); },
      set: function (k, v) { return pick().then(function (i) { return i.set(k, v); }); },
      del: function (k) { return pick().then(function (i) { return i.del(k); }); },
      clear: function () { return pick().then(function (i) { return i.clear(); }); },
      kind: function () { return impl === ls ? 'localStorage' : 'indexedDB'; }
    };
  })();

  // Region III hospitals and EMS agencies (abbreviation = full name).
  var REGION3 = [
    ['Bayview', 'Johns Hopkins Bayview Medical Center'], ['JHH', 'The Johns Hopkins Hospital'], ['Mercy', 'Mercy Medical Center'],
    ['STC', 'R Adams Cowley Shock Trauma Center'], ['UMMC', 'University of Maryland Medical Center'],
    ['UMMC Midtown', 'University of Maryland Medical Center Midtown Campus'], ['Harbor', 'MedStar Harbor Hospital'],
    ['Franklin Square', 'MedStar Franklin Square Medical Center'], ['Union Memorial', 'MedStar Union Memorial Hospital'],
    ['Good Sam', 'MedStar Good Samaritan Hospital'], ['Sinai', 'Sinai Hospital of Baltimore'], ['Grace', 'Grace Medical Center'],
    ['Northwest', 'Northwest Hospital'], ['Baltimore VA', 'Baltimore VA Medical Center'], ['GBMC', 'Greater Baltimore Medical Center'],
    ['St. Agnes', 'Ascension Saint Agnes Hospital'], ['St. Joe’s', 'University of Maryland St. Joseph Medical Center'],
    ['Howard General', 'Johns Hopkins Howard County Medical Center (formerly Howard County General Hospital)'],
    ['AAMC', 'Luminis Health Anne Arundel Medical Center'], ['BWMC', 'University of Maryland Baltimore Washington Medical Center'],
    ['Carroll Hospital', 'Carroll Hospital (LifeBridge Health), Westminster'],
    ['UCMC', 'University of Maryland Upper Chesapeake Medical Center, Bel Air'],
    ['UCMC Aberdeen', 'University of Maryland Upper Chesapeake Medical Center Aberdeen'],
    ['AACoFD', 'Anne Arundel County Fire Department'], ['Annapolis FD', 'City of Annapolis Fire Department'],
    ['BCFD', 'Baltimore City Fire Department'], ['BCoFD', 'Baltimore County Fire Department'],
    ['BWI Fire', 'BWI Thurgood Marshall Airport Fire & Rescue'], ['Carroll DFEMS', 'Carroll County Department of Fire & EMS'],
    ['Harford DES', 'Harford County Department of Emergency Services'], ['HCDFRS', 'Howard County Department of Fire & Rescue Services'],
    ['Ft. Meade FES', 'Fort George G. Meade Fire & Emergency Services'], ['APG FES', 'Aberdeen Proving Ground Fire & Emergency Services']
  ];

  var S = {
    settings: null, months: {}, view: ymOf(todayISO()), editId: null, photo: null,
    loaded: false, signature: null, redraw: false, queue: [], measure: null, meta: {}
  };

  function settings() {
    var s = S.settings || {};
    return {
      driverName: s.driverName || '', driverShort: s.driverShort || '', licenseTag: s.licenseTag || '',
      vehicle: s.vehicle || '', budgetCode: s.budgetCode || '',
      defaultCommute: s.defaultCommute != null ? s.defaultCommute : '',
      home: s.home || 'H', places: Array.isArray(s.places) ? s.places : [],
      info: (s.placeInfo && typeof s.placeInfo === 'object') ? s.placeInfo : {},
      fleetEmail: s.fleetEmail || ''
    };
  }
  function headerKey() { var s = settings(); return [s.driverName, s.licenseTag, s.vehicle, s.budgetCode].join('|'); }

  /* ------------------------------------------------------------ month math */
  function trips(key) {
    var m = S.months[key];
    return (m && Array.isArray(m.trips) ? m.trips.slice() : []).sort(function (a, b) {
      return a.date < b.date ? -1 : a.date > b.date ? 1 : (+a.endOdo || 0) - (+b.endOdo || 0);
    });
  }
  function lastTrip(key) { var t = trips(key); return t.length ? t[t.length - 1] : null; }
  function beginOdo(key) {
    var m = S.months[key];
    if (m && m.beginOdo != null && m.beginOdo !== '') return { value: +m.beginOdo, source: 'manual' };
    var prev = lastTrip(addMonths(key, -1));
    if (prev && prev.endOdo) return { value: +prev.endOdo, source: 'carried', from: addMonths(key, -1) };
    return { value: null, source: 'missing' };
  }
  function formData(key) {
    var s = settings();
    return {
      month: key, budgetCode: s.budgetCode, driverName: s.driverName, licenseTag: s.licenseTag,
      vehicle: s.vehicle, beginOdo: beginOdo(key).value,
      entries: trips(key).map(function (t) {
        return { date: t.date, route: t.route, commute: t.commute, endOdo: t.endOdo, driver: t.driver };
      })
    };
  }
  function summarize(m) {
    var t = (m.trips || []);
    return {
      count: t.length,
      totalCommute: t.reduce(function (a, x) { return a + (+x.commute || 0); }, 0),
      lastOdo: t.reduce(function (a, x) { return Math.max(a, +x.endOdo || 0); }, 0) || null
    };
  }
  // Odometer before a trip: the previous trip's ending, or the month's beginning.
  function prevOdoFor(key, date, excludeId) {
    var list = trips(key).filter(function (t) { return t.id !== excludeId && t.date <= date; });
    if (list.length) return { value: +list[list.length - 1].endOdo, label: MF.shortDate(list[list.length - 1].date) };
    var b = beginOdo(key);
    return b.value != null ? { value: b.value, label: 'beginning of month' } : null;
  }
  function nextOdoFor(key, date, excludeId) {
    var list = trips(key).filter(function (t) { return t.id !== excludeId && t.date > date; });
    return list.length ? { value: +list[0].endOdo, label: MF.shortDate(list[0].date) } : null;
  }

  /* --------------------------------------------------------------- writes */
  var queues = {};
  function queued(k, fn) {
    var p = (queues[k] || Promise.resolve()).catch(function () {}).then(fn);
    queues[k] = p;
    return p;
  }
  // Change a month's data (bumps rev, so a form already sent shows as changed).
  function writeMonth(key, mutate) {
    return queued('month:' + key, function () {
      var cur = S.months[key] ? clone(S.months[key]) : { month: key, beginOdo: null, trips: [], rev: 0 };
      mutate(cur);
      cur.month = key;
      cur.rev = (cur.rev || 0) + 1;
      cur.updatedAt = new Date().toISOString();
      S.months[key] = cur;
      return Store.set('month:' + key, cur).then(function () { return cur; });
    });
  }
  function patchMonth(key, patch) {   // bookkeeping that is not a change to the log itself
    if (S.months[key]) Object.assign(S.months[key], patch);
    return queued('month:' + key, function () {
      var cur = S.months[key]; if (!cur) return;
      Object.assign(cur, patch);
      return Store.set('month:' + key, cur);
    });
  }
  function touchFollowing(key) {
    var next = addMonths(key, 1), m = S.months[next];
    if (m && (m.beginOdo == null || m.beginOdo === '') && (m.trips || []).length) return writeMonth(next, function () {});
    return Promise.resolve();
  }
  function saveSettings(patch) {
    var next = Object.assign({}, S.settings || {}, patch, { updatedAt: new Date().toISOString() });
    S.settings = next;
    return queued('settings', function () { return Store.set('settings', next); });
  }
  function saveMeta(patch) {
    S.meta = Object.assign({}, S.meta, patch);
    var snap = clone(S.meta);
    return queued('meta', function () { return Store.set('meta', snap); });
  }

  /* -------------------------------------------------------- PDFs & sharing */
  function pdfName(key) { return 'Vehicle Mileage Log - ' + MF.monthLabel(key) + (settings().licenseTag ? ' (' + settings().licenseTag + ')' : '') + '.pdf'; }
  function signedName(key) { return pdfName(key).replace(/\.pdf$/, '') + ' - signed.pdf'; }
  function stampOf(key, sig) {
    var m = S.months[key];
    return [key, m ? m.rev : 0, headerKey(), beginOdo(key).value, sig ? sig.png.length + ':' + sig.png.slice(-40) : ''].join('|');
  }
  var fileCache = {}, fileOrder = [];
  // Build (or reuse) the PDF as a File. Building is async, so taps use readyFile().
  function getFile(key, sig) {
    var st = stampOf(key, sig);
    if (fileCache[st]) return Promise.resolve(fileCache[st]);
    var d = formData(key); if (sig) d.signature = sig;
    return MF.buildPdf(window.PDFLib, d).then(function (bytes) {
      var f = new File([bytes], sig ? signedName(key) : pdfName(key), { type: 'application/pdf' });
      fileCache[st] = f; fileOrder.push(st);
      while (fileOrder.length > 4) delete fileCache[fileOrder.shift()];
      return f;
    });
  }
  function readyFile(key, sig) { return fileCache[stampOf(key, sig)] || null; }
  function canShare(file) {
    try { return !!(navigator.share && navigator.canShare && navigator.canShare({ files: [file] })); } catch (e) { return false; }
  }
  var shareFiles = canShare(new File(['%PDF-'], 'x.pdf', { type: 'application/pdf' }));
  function download(file) {
    var url = URL.createObjectURL(file), a = document.createElement('a');
    a.href = url; a.download = file.name; a.rel = 'noopener';
    document.body.appendChild(a); a.click();
    setTimeout(function () { URL.revokeObjectURL(url); a.remove(); }, 4000);
  }
  // Call straight from a tap: iPhone opens the share sheet only from one.
  function deliver(file, title, text) {
    if (canShare(file)) {
      var data = { files: [file], title: title };
      if (text) data.text = text;
      return navigator.share(data).then(function () { return 'shared'; }, function (e) {
        if (e && e.name === 'AbortError') return 'cancelled';
        throw e;
      });
    }
    download(file);
    return Promise.resolve('downloaded');
  }

  /* ------------------------------------------------------------ rendering */
  function renderAll() {
    renderHeader(); renderSummary(); renderBegin(); renderChips(); renderEntries(); renderPreview(); renderSignNote();
    if (!S.editId && !$('fCommute').value) $('fCommute').value = settings().defaultCommute;
    if (!S.editId && !$('fDriver').value) $('fDriver').value = settings().driverShort;
    updateRoutePreview(); updateOdoNote();
  }
  function renderHeader() {
    var s = settings();
    $('vehicleLine').textContent = [s.licenseTag, s.vehicle].filter(Boolean).join(' · ') || 'State vehicle';
    $('monthName').textContent = MF.monthLabel(S.view);
    $('nextMonth').disabled = S.view >= ymOf(todayISO());
  }
  function renderSummary() {
    var t = trips(S.view), b = beginOdo(S.view).value, last = t.length ? +t[t.length - 1].endOdo : null;
    $('tDays').textContent = t.length;
    $('tCommute').textContent = fmt(t.reduce(function (a, x) { return a + (+x.commute || 0); }, 0));
    $('tDriven').textContent = (last != null && b != null) ? fmt(last - b) : '—';
    $('tOdo').textContent = last != null ? fmt(last) : (b != null ? fmt(b) : '—');
  }
  var editingBegin = false;
  function renderBegin() {
    var el = $('beginRow'), b = beginOdo(S.view), m = S.months[S.view];
    if (editingBegin || b.source === 'missing') {
      el.innerHTML = '<label class="lbl" for="bInput">Beginning odometer for ' + esc(MF.monthLabel(S.view)) + '</label>' +
        '<input type="text" id="bInput" inputmode="numeric" pattern="[0-9]*" value="' + esc(b.value != null ? b.value : '') + '" placeholder="e.g. 99357">' +
        '<button class="secondary" id="bSave" type="button" style="min-height:42px">Save</button>' +
        (b.source === 'missing' ? '<span class="muted" style="flex-basis:100%;font-size:14px">The ending odometer from your last form. Next month it carries over by itself.</span>' : '') +
        (editingBegin && m && m.beginOdo != null && m.beginOdo !== '' ? '<button class="linkbtn" id="bAuto" type="button">Use last month&#8217;s ending</button>' : '');
      $('bSave').onclick = saveBegin;
      if ($('bAuto')) $('bAuto').onclick = function () { setBegin(null); };
      return;
    }
    var src = b.source === 'carried' ? 'carried over from ' + MF.monthLabel(b.from).split(' ')[0] : 'entered by you';
    el.innerHTML = '<span class="lbl">Beginning odometer</span> <span class="num">' + fmt(b.value) + '</span>' +
      '<span class="muted" style="font-size:14px">' + src + '</span>' +
      '<button class="linkbtn" id="bEdit" type="button" style="margin-left:auto">Change</button>';
    $('bEdit').onclick = function () { editingBegin = true; renderBegin(); $('bInput').focus(); };
  }
  function saveBegin() {
    var v = digits($('bInput').value);
    if (!v) { toast('Enter the beginning odometer'); return; }
    setBegin(+v);
  }
  function setBegin(v) {
    editingBegin = false;
    var key = S.view;
    writeMonth(key, function (m) { m.beginOdo = v; }).then(function () {
      renderAll(); toast('Beginning odometer saved');
    }).catch(writeFailed);
    renderAll();
  }

  function placeCounts() {
    var c = {}, home = settings().home.toUpperCase();
    Object.keys(S.months).forEach(function (k) {
      (S.months[k].trips || []).forEach(function (t) {
        (t.route || []).forEach(function (p) { if (p.toUpperCase() !== home) c[p] = (c[p] || 0) + 1; });
      });
    });
    return c;
  }
  var showAllChips = false;
  // The place being typed: text after the last separator in the route box.
  function routeToken() {
    var v = $('fRoute').value, i = -1;
    [',', ';', '>', '→', '\n'].forEach(function (sep) { i = Math.max(i, v.lastIndexOf(sep)); });
    return { head: v.slice(0, i + 1), tok: v.slice(i + 1).trim() };
  }
  function renderChips() {
    var s = settings(), counts = placeCounts();
    var list = s.places.slice().sort(function (a, b) { return (counts[b] || 0) - (counts[a] || 0); });
    var q = routeToken().tok.toLowerCase();
    if (q) {
      var words = q.split(/\s+/).filter(Boolean);
      var hits = list.filter(function (p) {
        var hay = (p + ' ' + (s.info[p] || '')).toLowerCase();
        return words.every(function (w) { return hay.indexOf(w) >= 0; });
      }).sort(function (a, b) {
        var sa = a.toLowerCase().indexOf(q) === 0 ? 0 : 1, sb = b.toLowerCase().indexOf(q) === 0 ? 0 : 1;
        return sa - sb || (counts[b] || 0) - (counts[a] || 0);
      }).slice(0, 12);
      $('chips').innerHTML = hits.length ? hits.map(function (p) {
        return '<button type="button" class="chip hit" data-place="' + esc(p) + '" data-replace="1">' + esc(p) +
          (s.info[p] ? '<small>' + esc(s.info[p]) + '</small>' : '') + '</button>';
      }).join('') : '<span class="chipnote">No saved place matches. It will be saved as you typed it.</span>';
      return;
    }
    var shown = showAllChips ? list : list.slice(0, 12);
    var html = shown.map(function (p) { return '<button type="button" class="chip" data-place="' + esc(p) + '"' + (s.info[p] ? ' title="' + esc(s.info[p]) + '"' : '') + '>' + esc(p) + '</button>'; });
    html.push('<button type="button" class="chip" data-place="' + esc(s.home) + '" title="Stop at home">' + esc(s.home) + ' (home)</button>');
    if (list.length > 12) html.push('<button type="button" class="chip more" id="moreChips">' + (showAllChips ? 'Fewer' : 'All ' + list.length + ' places') + '</button>');
    $('chips').innerHTML = html.join('');
  }
  $('chips').addEventListener('click', function (e) {
    var b = e.target.closest('button'); if (!b) return;
    if (b.id === 'moreChips') { showAllChips = !showAllChips; renderChips(); return; }
    var p = b.getAttribute('data-place'), inp = $('fRoute');
    if (b.getAttribute('data-replace')) {
      var t = routeToken();
      inp.value = t.head + (t.head ? ' ' : '') + p + ', ';
    } else {
      var v = inp.value.replace(/[\s,]+$/, '');
      inp.value = (v ? (/[;>→]$/.test(v) ? v + ' ' : v + ', ') : '') + p + ', ';
    }
    updateRoutePreview(); renderChips();
  });
  // Keep the keyboard up when tapping a shortcut while typing.
  $('chips').addEventListener('mousedown', function (e) { if (e.target.closest('button') && document.activeElement === $('fRoute')) e.preventDefault(); });
  $('fRoute').addEventListener('input', renderChips);

  function currentStops() {
    return MF.parseRoute($('fRoute').value, { home: settings().home, startHome: $('fStartHome').checked, endHome: $('fEndHome').checked });
  }
  function updateRoutePreview() {
    var raw = $('fRoute').value.trim();
    $('routePrev').innerHTML = raw ? routeHtml(currentStops()) : '<span class="muted">' + esc(settings().home) + ' → … → ' + esc(settings().home) + '</span>';
  }
  ['fRoute', 'fStartHome', 'fEndHome'].forEach(function (id) { $(id).addEventListener('input', updateRoutePreview); $(id).addEventListener('change', updateRoutePreview); });

  function updateOdoNote() {
    var el = $('odoNote'), v = digits($('fOdo').value), date = $('fDate').value;
    el.className = 'odonote';
    if (!date) { el.textContent = ''; return; }
    var key = ymOf(date), prev = prevOdoFor(key, date, S.editId), next = nextOdoFor(key, date, S.editId);
    if (!v) { el.textContent = prev ? 'Last reading: ' + fmt(prev.value) + ' (' + prev.label + ')' : ''; return; }
    v = +v;
    if (prev && v < prev.value) { el.className = 'odonote warn'; el.textContent = 'Lower than the last reading, ' + fmt(prev.value) + ' (' + prev.label + '). Check the number.'; return; }
    if (next && v > next.value) { el.className = 'odonote warn'; el.textContent = 'Higher than the next entry, ' + fmt(next.value) + ' (' + next.label + '). Check the number.'; return; }
    if (prev) {
      var d = v - prev.value;
      el.className = d > 600 ? 'odonote warn' : 'odonote ok';
      el.textContent = '+' + fmt(d) + ' mi since ' + fmt(prev.value) + ' (' + prev.label + ')' + (d > 600 ? '. That is a long day; check the number.' : '');
    } else el.textContent = '';
  }
  ['fOdo', 'fDate'].forEach(function (id) { $(id).addEventListener('input', updateOdoNote); });
  $('fOdo').addEventListener('blur', function () { var d = digits(this.value); this.value = d; updateOdoNote(); });

  function renderEntries() {
    var t = trips(S.view), el = $('entryList');
    $('entriesTitle').textContent = MF.monthLabel(S.view).split(' ')[0];
    if (S.measure && t.length) {
      var pages = MF.layout(formData(S.view), S.measure), rows = pages.length > 1 ? null : pages[0].rowsUsed;
      $('rowsUsed').textContent = rows == null ? pages.length + ' pages' : rows + ' of ' + MF.ROWS_PER_PAGE + ' rows';
    } else $('rowsUsed').textContent = '';
    if (!S.loaded) return;
    if (!t.length) {
      el.innerHTML = '<div class="empty">No days logged for ' + esc(MF.monthLabel(S.view)) + ' yet. Your first entry above starts the sheet.</div>';
      return;
    }
    var prevOdo = beginOdo(S.view).value;
    el.innerHTML = t.map(function (x) {
      var d = new Date(x.date + 'T12:00:00'), delta = (prevOdo != null && x.endOdo) ? (+x.endOdo - prevOdo) : null;
      prevOdo = +x.endOdo || prevOdo;
      var bad = delta != null && (delta < 0 || delta > 600);
      return '<button type="button" class="entry' + (S.editId === x.id ? ' active' : '') + '" data-id="' + esc(x.id) + '">' +
        '<span class="d"><b>' + d.getDate() + '</b><span>' + DOW[d.getDay()] + '</span></span>' +
        '<span class="r">' + routeHtml(x.route || []) + '</span>' +
        '<span class="o"><span class="num">' + fmt(x.endOdo) + '</span>' +
        (delta != null ? '<small class="' + (bad ? 'warn' : '') + '">' + (delta >= 0 ? '+' : '') + fmt(delta) + ' mi</small>' : '') + '</span></button>';
    }).join('');
  }
  $('entryList').addEventListener('click', function (e) {
    var b = e.target.closest('.entry'); if (!b) return;
    startEdit(b.getAttribute('data-id'));
  });

  var pvTimer = null;
  function renderPreview() {
    clearTimeout(pvTimer);
    pvTimer = setTimeout(function () {
      if (!S.measure) return;
      var key = S.view, pages = MF.layout(formData(key), S.measure);
      $('sheets').innerHTML = pages.map(function (p, i) {
        return '<div class="sheet" aria-label="Page ' + (i + 1) + '">' + MF.renderSvg(p, S.measure) + '</div>';
      }).join('');
      getFile(key, null).catch(function () {});   // ready for Save PDF
    }, 120);
  }

  /* ------------------------------------------------------------- the form */
  function resetForm() {
    S.editId = null; clearPhoto();
    $('fDate').value = defaultDate();
    $('fRoute').value = ''; $('fOdo').value = '';
    $('fStartHome').checked = true; $('fEndHome').checked = true;
    $('fCommute').value = settings().defaultCommute; $('fDriver').value = settings().driverShort;
    $('entryTitle').textContent = 'Log a day'; $('saveBtn').textContent = 'Save day';
    $('cancelBtn').classList.add('hidden'); $('deleteBtn').classList.add('hidden');
    $('entryCard').classList.remove('editing'); $('formErr').textContent = '';
    disarmDelete();
    updateRoutePreview(); updateOdoNote(); renderEntries();
  }
  function defaultDate() {
    var t = todayISO();
    if (ymOf(t) === S.view) return t;
    var list = trips(S.view);
    if (!list.length) return S.view + '-01';
    var d = new Date(list[list.length - 1].date + 'T12:00:00'); d.setDate(d.getDate() + 1);
    var iso = d.getFullYear() + '-' + pad(d.getMonth() + 1) + '-' + pad(d.getDate());
    return ymOf(iso) === S.view ? iso : list[list.length - 1].date;
  }
  function stopsToText(t) {
    var home = settings().home.toUpperCase(), r = (t.route || []).slice();
    var sh = r.length && r[0].toUpperCase() === home, eh = r.length > 1 && r[r.length - 1].toUpperCase() === home;
    if (sh) r.shift(); if (eh) r.pop();
    return { text: t.routeText != null ? t.routeText : r.join(', '), startHome: t.startHome != null ? t.startHome : sh, endHome: t.endHome != null ? t.endHome : eh };
  }
  function startEdit(id) {
    var t = trips(S.view).filter(function (x) { return x.id === id; })[0];
    if (!t) return;
    S.editId = id; clearPhoto();
    var r = stopsToText(t);
    $('fDate').value = t.date; $('fRoute').value = r.text;
    $('fStartHome').checked = r.startHome; $('fEndHome').checked = r.endHome;
    $('fOdo').value = t.endOdo || ''; $('fCommute').value = t.commute != null ? t.commute : '';
    $('fDriver').value = t.driver || '';
    $('entryTitle').textContent = 'Edit ' + MF.shortDate(t.date);
    $('saveBtn').textContent = 'Save changes';
    $('cancelBtn').classList.remove('hidden'); $('deleteBtn').classList.remove('hidden');
    $('entryCard').classList.add('editing'); $('formErr').textContent = '';
    disarmDelete();
    updateRoutePreview(); updateOdoNote(); renderEntries();
    $('entryCard').scrollIntoView({ behavior: 'smooth', block: 'start' });
  }
  $('cancelBtn').onclick = resetForm;

  var deleteArmed = null;
  function disarmDelete() { clearTimeout(deleteArmed); deleteArmed = null; $('deleteBtn').textContent = 'Delete'; }
  $('deleteBtn').onclick = function () {
    if (!deleteArmed) {
      $('deleteBtn').textContent = 'Tap again to delete';
      deleteArmed = setTimeout(disarmDelete, 3500);
      return;
    }
    disarmDelete();
    var id = S.editId, key = S.view, t = trips(key).filter(function (x) { return x.id === id; })[0];
    if (!t) return;
    writeMonth(key, function (m) { m.trips = (m.trips || []).filter(function (x) { return x.id !== id; }); })
      .then(function () { toast('Deleted ' + MF.shortDate(t.date)); afterMonthChange(key); })
      .catch(writeFailed);
    resetForm(); renderAll();
  };

  $('saveBtn').onclick = function () {
    var err = $('formErr'); err.textContent = '';
    var date = $('fDate').value, stops = currentStops(), odo = digits($('fOdo').value);
    var home = settings().home.toUpperCase();
    var real = stops.filter(function (p) { return p.toUpperCase() !== home; });
    if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) { err.textContent = 'Pick the date.'; return; }
    if (!real.length && !$('fRoute').value.trim()) { err.textContent = 'Add where you went, e.g. W, JHH.'; return; }
    if (!odo) { err.textContent = 'Add the ending odometer (type it or read it from a photo).'; return; }
    if (S.photo && S.photo.busy) { err.textContent = 'Still reading the photo. One moment, or tap Stop and type it.'; return; }
    var key = ymOf(date), editing = S.editId, old = editing ? findTrip(editing) : null;
    var btn = $('saveBtn'); btn.disabled = true; btn.textContent = 'Saving…';
    var r = { text: $('fRoute').value.replace(/[\s,;]+$/, '').trim(), startHome: $('fStartHome').checked, endHome: $('fEndHome').checked };
    var trip = {
      id: editing || uid(), date: date, route: stops, routeText: r.text, startHome: r.startHome, endHome: r.endHome,
      commute: digits($('fCommute').value) === '' ? '' : +digits($('fCommute').value),
      endOdo: +odo, driver: $('fDriver').value.trim(),
      odoFromPhoto: !!(S.photo && S.photo.read && String(S.photo.read) === odo) || !!(old && old.trip.odoFromPhoto && +old.trip.endOdo === +odo),
      updatedAt: new Date().toISOString(), createdAt: old ? old.trip.createdAt || null : new Date().toISOString()
    };
    var jobs = [];
    if (old && old.key !== key) {
      jobs.push(writeMonth(old.key, function (m) { m.trips = (m.trips || []).filter(function (x) { return x.id !== editing; }); }));
    }
    jobs.push(writeMonth(key, function (m) {
      m.trips = (m.trips || []).filter(function (x) { return x.id !== trip.id; });
      m.trips.push(trip);
    }));
    Promise.all(jobs).then(function () {
      addNewPlaces(real);
      toast((editing ? 'Updated ' : 'Saved ') + MF.shortDate(date) + ' · ' + fmt(+odo));
      afterMonthChange(key);
      if (old && old.key !== key) afterMonthChange(old.key);
      if (S.view !== key) S.view = key;
      resetForm(); renderAll();
      if (S.queue.length) nextQueued();
    }).catch(writeFailed).then(function () {
      btn.disabled = false;
      if (btn.textContent === 'Saving…') btn.textContent = S.editId ? 'Save changes' : 'Save day';
    });
  };
  function findTrip(id) {
    var keys = Object.keys(S.months);
    for (var i = 0; i < keys.length; i++) {
      var t = (S.months[keys[i]].trips || []).filter(function (x) { return x.id === id; })[0];
      if (t) return { key: keys[i], trip: t };
    }
    return null;
  }
  function afterMonthChange(key) { touchFollowing(key).catch(function () {}); renderAll(); }
  function writeFailed(e) {
    try { console.error('save failed', e); } catch (x) {}
    var quota = e && (e.name === 'QuotaExceededError' || /quota/i.test(e.message || ''));
    var msg = quota ? 'This phone is out of storage space for the log. Free up space, then try again.' : 'Could not save on this phone. Try again.';
    $('formErr').textContent = msg; toast(msg);
  }
  function addNewPlaces(stops) {
    var s = settings(), known = {}, add = [];
    s.places.concat([s.home]).forEach(function (p) { known[p.toUpperCase()] = 1; });
    stops.forEach(function (p) { if (!known[p.toUpperCase()]) { known[p.toUpperCase()] = 1; add.push(p); } });
    if (!add.length) return;
    saveSettings({ places: s.places.concat(add) }).catch(function () {});
  }

  /* ------------------------------------------------------ review & sign */
  function titleCase(x) { return String(x || '').toLowerCase().replace(/(^|[\s.'-])([a-z])/g, function (m, a, b) { return a + b.toUpperCase(); }); }
  function shortWhen(iso) {
    var d = new Date(iso);
    return d.toLocaleDateString('en-US', { month: 'short', day: 'numeric' }) + ' at ' + d.toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' });
  }
  function fleetSubject(key) {
    var s = settings();
    return 'Vehicle Mileage Log – ' + MF.monthLabel(key) + (s.licenseTag ? ' – ' + s.licenseTag : '') + (s.driverName ? ' – ' + titleCase(s.driverName) : '');
  }
  function fleetBody(key) {
    var s = settings(), sum = summarize({ trips: trips(key) }), b = beginOdo(key).value;
    return 'Attached is my signed Vehicle Mileage Log for ' + MF.monthLabel(key) + '.\n\n' +
      (s.licenseTag ? 'Vehicle: ' + s.licenseTag + (s.vehicle ? ', ' + s.vehicle : '') + '\n' : '') +
      'Days logged: ' + sum.count + '\nTotal commute miles: ' + sum.totalCommute +
      '\nBeginning odometer: ' + (b != null ? b : '-') + '\nEnding odometer: ' + (sum.lastOdo || '-') + '\n\n' +
      titleCase(s.driverName) + '\n';
  }
  function monthWarnings(key) {
    var w = [], t = trips(key), b = beginOdo(key).value, prev = b, m = S.months[key];
    if (key === ymOf(todayISO())) w.push(MF.monthLabel(key).split(' ')[0] + ' isn’t over yet. Sending now leaves out the rest of the month.');
    if (b == null) w.push('The beginning odometer is missing.');
    t.forEach(function (x) {
      var o = +x.endOdo;
      if (prev != null && o) {
        var d = o - prev;
        if (d < 0) w.push(MF.shortDate(x.date) + ': the odometer is lower than the entry before it.');
        else if (d > 600) w.push(MF.shortDate(x.date) + ': +' + fmt(d) + ' mi since the entry before it.');
      }
      if (o) prev = o;
    });
    if (m && m.submitted) {
      w.push(m.submitted.rev === m.rev ?
        'You already signed and sent this on ' + shortWhen(m.submitted.at) + '. Sending again sends a second copy.' :
        'You changed this month after signing it on ' + shortWhen(m.submitted.at) + '. This sends the corrected version.');
    }
    return w;
  }
  var sigPad = null, spTimer = null, prepTimer = null;
  function currentSig() {
    if (S.signature && !S.redraw) return S.signature;
    if (sigPad && !sigPad.isEmpty()) return sigPad.export();
    return null;
  }
  function signStatus(html, cls) { var el = $('signStatus'); el.className = 'status' + (cls ? ' ' + cls : ''); el.innerHTML = html || ''; }
  function openSign() {
    var key = S.view, s = settings(), sum = summarize({ trips: trips(key) }), b = beginOdo(key).value;
    S.redraw = false;
    $('signTitle').textContent = 'Sign & send ' + MF.monthLabel(key);
    $('signSummary').innerHTML = '<b>' + sum.count + '</b> days · <b>' + fmt(sum.totalCommute) + '</b> commute mi · odometer <b>' +
      fmt(b) + '</b> → <b>' + fmt(sum.lastOdo) + '</b>' + (b != null && sum.lastOdo ? ' (' + fmt(sum.lastOdo - b) + ' mi)' : '');
    var w = monthWarnings(key);
    $('signWarn').innerHTML = w.map(function (x) { return '<li>' + esc(x) + '</li>'; }).join('');
    $('signWarn').classList.toggle('hidden', !w.length);
    $('signTo').value = s.fleetEmail;
    $('signCertify').checked = false;
    $('signCertifyText').textContent = 'I certify this mileage log for ' + MF.monthLabel(key) + ' is accurate.';
    $('signSend').textContent = shareFiles ? 'Sign & send' : 'Sign & download';
    $('signToHint').textContent = shareFiles ? '(add this address in your email app)' : '(attach the PDF to an email to this address)';
    $('signHow').textContent = shareFiles ?
      'Your phone’s share menu opens with the signed PDF. Pick Mail, Outlook or Gmail and send it from your own email.' :
      'The signed PDF downloads. Attach it to an email to fleet.';
    signStatus('');
    $('signSheet').classList.remove('hidden'); document.body.style.overflow = 'hidden';
    renderSigArea(); updateSignButtons();
  }
  function closeSign() { $('signSheet').classList.add('hidden'); document.body.style.overflow = ''; sigPad = null; $('sigArea').innerHTML = ''; }
  $('signBtn').onclick = function () {
    if (!trips(S.view).length) { pvStatus('Nothing logged for ' + esc(MF.monthLabel(S.view)) + ' yet.', 'err'); return; }
    openSign();
  };
  $('signClose').onclick = closeSign;
  $('signSheet').addEventListener('click', function (e) { if (e.target === this) closeSign(); });
  document.addEventListener('keydown', function (e) { if (e.key === 'Escape' && !$('signSheet').classList.contains('hidden')) closeSign(); });
  $('signCertify').addEventListener('change', updateSignButtons);
  $('signCopy').onclick = function () {
    var v = $('signTo').value.trim(); if (!v) return;
    var done = function () { $('signCopy').textContent = 'Copied'; setTimeout(function () { $('signCopy').textContent = 'Copy'; }, 1800); };
    if (navigator.clipboard && navigator.clipboard.writeText) navigator.clipboard.writeText(v).then(done, function () { $('signTo').select(); });
    else { $('signTo').select(); try { document.execCommand('copy'); done(); } catch (e) {} }
  };
  function renderSigArea() {
    var el = $('sigArea');
    if (S.signature && !S.redraw) {
      el.innerHTML = '<div class="sigsaved"><img alt="Your saved signature" src="' + esc(S.signature.png) + '"><button class="linkbtn" type="button" id="sigRedraw">Redraw</button></div>';
      $('sigRedraw').onclick = function () { S.redraw = true; renderSigArea(); updateSignButtons(); };
      sigPad = null; return;
    }
    el.innerHTML = '<div class="f" style="margin-bottom:6px">Your signature <span class="muted" style="font-weight:500">saved on this phone for next month</span></div>' +
      '<div class="pad"><canvas id="sigCanvas" aria-label="Signature pad"></canvas><div class="padline"></div><div class="padhint">Sign here with your finger</div></div>' +
      '<div class="btns" style="margin-top:8px"><button class="secondary" type="button" id="sigClear" style="min-height:40px">Clear</button>' +
      (S.signature ? '<button class="secondary" type="button" id="sigKeep" style="min-height:40px">Keep my saved signature</button>' : '') + '</div>';
    sigPad = makePad($('sigCanvas'), updateSignButtons);
    $('sigClear').onclick = function () { sigPad.clear(); updateSignButtons(); };
    if ($('sigKeep')) $('sigKeep').onclick = function () { S.redraw = false; renderSigArea(); updateSignButtons(); };
  }
  function makePad(canvas, onChange) {
    var ctx = canvas.getContext('2d'), dpr = Math.max(1, window.devicePixelRatio || 1), W = 0, H = 0;
    var p0 = null, p1 = null, drawing = false, box = null, cache = null;
    function size() {
      var r = canvas.getBoundingClientRect();
      if (r.width && (Math.round(r.width) !== Math.round(W) || Math.round(r.height) !== Math.round(H))) {
        W = r.width; H = r.height; canvas.width = Math.round(W * dpr); canvas.height = Math.round(H * dpr);
        ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
        ctx.lineCap = 'round'; ctx.lineJoin = 'round'; ctx.strokeStyle = '#132d6b'; ctx.fillStyle = '#132d6b'; ctx.lineWidth = 2.6;
        box = null; cache = null;
      }
    }
    function pos(e) { var r = canvas.getBoundingClientRect(); return { x: e.clientX - r.left, y: e.clientY - r.top }; }
    function grow(p) {
      if (!box) box = { x0: p.x, y0: p.y, x1: p.x, y1: p.y };
      box.x0 = Math.min(box.x0, p.x); box.y0 = Math.min(box.y0, p.y); box.x1 = Math.max(box.x1, p.x); box.y1 = Math.max(box.y1, p.y);
    }
    canvas.addEventListener('pointerdown', function (e) {
      size(); drawing = true; cache = null;
      try { canvas.setPointerCapture(e.pointerId); } catch (x) {}
      p0 = p1 = pos(e); grow(p1);
      ctx.beginPath(); ctx.arc(p1.x, p1.y, 1.3, 0, Math.PI * 2); ctx.fill();
      e.preventDefault();
    });
    canvas.addEventListener('pointermove', function (e) {
      if (!drawing) return;
      var p2 = pos(e); grow(p2);
      var m1 = { x: (p0.x + p1.x) / 2, y: (p0.y + p1.y) / 2 }, m2 = { x: (p1.x + p2.x) / 2, y: (p1.y + p2.y) / 2 };
      ctx.beginPath(); ctx.moveTo(m1.x, m1.y); ctx.quadraticCurveTo(p1.x, p1.y, m2.x, m2.y); ctx.stroke();
      p0 = p1; p1 = p2; e.preventDefault();
    });
    function end() { if (drawing) { drawing = false; cache = null; if (onChange) onChange(); } }
    canvas.addEventListener('pointerup', end); canvas.addEventListener('pointercancel', end);
    size();
    return {
      isEmpty: function () { return !box || (box.x1 - box.x0 < 14 && box.y1 - box.y0 < 14); },
      clear: function () { size(); ctx.clearRect(0, 0, W, H); box = null; cache = null; },
      export: function () {
        if (!box) return null;
        if (cache) return cache;
        var m = 6, x0 = Math.max(0, box.x0 - m), y0 = Math.max(0, box.y0 - m), x1 = Math.min(W, box.x1 + m), y1 = Math.min(H, box.y1 + m);
        var w = x1 - x0, h = y1 - y0, sc = Math.min(3, 640 / w);
        var c = document.createElement('canvas');
        c.width = Math.max(1, Math.round(w * sc)); c.height = Math.max(1, Math.round(h * sc));
        c.getContext('2d').drawImage(canvas, x0 * dpr, y0 * dpr, w * dpr, h * dpr, 0, 0, c.width, c.height);
        cache = { png: c.toDataURL('image/png'), w: c.width, h: c.height };
        return cache;
      }
    };
  }
  function updateSignButtons() {
    var sig = currentSig(), ok = $('signCertify').checked && !!sig, key = S.view;
    var ready = ok && !!readyFile(key, sig);
    $('signSend').disabled = !ready;
    if (!sig) signStatus('Sign in the box above.');
    else if (!$('signCertify').checked) signStatus('Check the box to certify the log.');
    else if (!ready) signStatus('<span class="spin"></span> Getting the signed PDF ready…');
    else signStatus('');
    renderSignPreview();
    clearTimeout(prepTimer);
    if (ok && !ready) {
      prepTimer = setTimeout(function () {
        getFile(key, sig).then(function () { if (!$('signSheet').classList.contains('hidden')) updateSignButtons(); })
          .catch(function () { signStatus('Couldn’t build the PDF. Close this and try again.', 'err'); });
      }, 60);
    }
  }
  function renderSignPreview() {
    clearTimeout(spTimer);
    spTimer = setTimeout(function () {
      if (!S.measure || $('signSheet').classList.contains('hidden')) return;
      var sig = currentSig(), d = formData(S.view);
      if (sig) d.signature = sig;
      var pages = MF.layout(d, S.measure), last = pages[pages.length - 1];
      $('signPreview').innerHTML = '<div class="sheet">' + MF.renderSvg(last, S.measure, { images: { signature: sig && sig.png } }) + '</div>';
    }, 200);
  }
  function keepSignature(sig) {
    if (S.signature && !S.redraw) return;
    var v = { png: sig.png, w: sig.w, h: sig.h, updatedAt: new Date().toISOString() };
    S.signature = v; S.redraw = false;
    queued('signature', function () { return Store.set('signature', v); }).catch(function () {});
    renderSettingsSig();
  }
  $('signSend').onclick = function () {
    var key = S.view, sig = currentSig(), file = sig && readyFile(key, sig);
    if (!file) { updateSignButtons(); return; }
    var to = $('signTo').value.trim();
    var how = deliver(file, fleetSubject(key), fleetBody(key));   // straight from the tap
    keepSignature(sig);
    if (to !== settings().fleetEmail) saveSettings({ fleetEmail: to }).catch(function () {});
    how.then(function (h) {
      if (h === 'cancelled') { signStatus('Not sent. Tap Sign & send when you’re ready.'); return; }
      var m = S.months[key];
      patchMonth(key, { submitted: { at: new Date().toISOString(), to: to, rev: m ? m.rev : null, how: h } }).catch(function () {});
      closeSign(); renderSignNote();
      toast(h === 'shared' ? 'Signed. Finish sending in your email app.' : 'Signed PDF downloaded');
    }).catch(function (e) {
      var blocked = e && e.name === 'NotAllowedError';
      signStatus(blocked ? 'Your phone blocked the share menu. Tap Sign & send again.' : 'Couldn’t open the share menu here. Try again, or use Save PDF on the main screen.', 'err');
    });
  };
  function renderSignNote() {
    var m = S.months[S.view], el = $('signNote');
    if (m && m.submitted) {
      var same = m.submitted.rev === m.rev, verb = m.submitted.how === 'downloaded' ? 'Signed and downloaded' : 'Signed and shared';
      el.className = 'status ' + (same ? 'ok' : 'err');
      el.textContent = same ? verb + ' on ' + shortWhen(m.submitted.at) + (m.submitted.to ? ' for ' + m.submitted.to : '') + '.' :
        'Changed since you signed it on ' + shortWhen(m.submitted.at) + '. Send the corrected version when you’re ready.';
    } else { el.className = 'status'; el.textContent = ''; }
  }
  function renderSettingsSig() {
    if (S.signature) { $('sSigImg').src = S.signature.png; $('sSigRow').classList.remove('hidden'); }
    else $('sSigRow').classList.add('hidden');
  }
  $('sSigClear').onclick = function () {
    queued('signature', function () { return Store.del('signature'); }).then(function () {
      S.signature = null; renderSettingsSig();
      setStatus('sStatus', 'Signature removed. You’ll sign again next time.', 'ok');
    }).catch(function () { setStatus('sStatus', 'Could not remove it. Try again.', 'err'); });
  };

  /* --------------------------------------------- photo dates and catch-up */
  // Capture time from a JPEG's EXIF (DateTimeOriginal), read from the first bytes.
  function exifTime(buf) {
    try {
      var v = new DataView(buf);
      if (v.byteLength < 4 || v.getUint16(0) !== 0xFFD8) return null;
      var off = 2;
      while (off + 4 <= v.byteLength) {
        var marker = v.getUint16(off), size = v.getUint16(off + 2);
        if ((marker & 0xFF00) !== 0xFF00) return null;
        if (marker === 0xFFE1 && off + 10 < v.byteLength && v.getUint32(off + 4) === 0x45786966) return tiffTime(v, off + 10);
        if (marker === 0xFFDA) return null;
        off += 2 + size;
      }
    } catch (e) {}
    return null;
  }
  function tiffTime(v, start) {
    var le = v.getUint16(start) === 0x4949;
    function u16(o) { return v.getUint16(o, le); }
    function u32(o) { return v.getUint32(o, le); }
    function entries(ifd, tags) {
      var n = u16(ifd), out = {};
      for (var i = 0; i < n; i++) {
        var e = ifd + 2 + i * 12, tag = u16(e);
        if (tags.indexOf(tag) >= 0) out[tag] = { count: u32(e + 4), val: u32(e + 8), at: e + 8 };
      }
      return out;
    }
    function str(ent) {
      var o = ent.count > 4 ? start + ent.val : ent.at, s = '';
      for (var i = 0; i < ent.count - 1 && o + i < v.byteLength; i++) s += String.fromCharCode(v.getUint8(o + i));
      return s;
    }
    var ifd0 = entries(start + u32(start + 4), [0x0132, 0x8769]), raw = null;
    if (ifd0[0x8769]) { var ex = entries(start + ifd0[0x8769].val, [0x9003, 0x9004]); raw = ex[0x9003] ? str(ex[0x9003]) : ex[0x9004] ? str(ex[0x9004]) : null; }
    if (!raw && ifd0[0x0132]) raw = str(ifd0[0x0132]);
    var m = /^(\d{4}):(\d{2}):(\d{2})[ T](\d{2}):(\d{2})/.exec(raw || '');
    return m ? { date: m[1] + '-' + m[2] + '-' + m[3], hh: +m[4], mm: +m[5], src: 'exif' } : null;
  }
  function photoTime(file) {
    return file.slice(0, 262144).arrayBuffer().then(exifTime).catch(function () { return null; }).then(function (t) {
      if (t) return t;
      var lm = file.lastModified;
      if (lm && Date.now() - lm > 10 * 60 * 1000) {
        var d = new Date(lm);
        return { date: d.getFullYear() + '-' + pad(d.getMonth() + 1) + '-' + pad(d.getDate()), hh: d.getHours(), mm: d.getMinutes(), src: 'file' };
      }
      return null;
    });
  }
  function clock(h, m) { return (h % 12 || 12) + ':' + pad(m) + ' ' + (h >= 12 ? 'PM' : 'AM'); }
  function applyPhotoDate(t, inQueue) {
    var el = $('dateHint'), cur = $('fDate').value;
    function show(html) { el.innerHTML = html; el.classList.remove('hidden'); }
    if (!t) { if (inQueue) show('This photo has no date saved in it. Check the date.'); else el.classList.add('hidden'); return; }
    var when = clock(t.hh, t.mm), late = t.hh < 4, src = t.src === 'file' ? ' (from the photo’s file date)' : '';
    var lateNote = late ? ' Taken after midnight; if it was the end of the day before, change the date.' : '';
    if (S.editId) {
      if (t.date !== cur) show('Photo taken <b>' + MF.shortDate(t.date) + '</b> at ' + when + src + '. This entry is dated ' + MF.shortDate(cur) + '.');
      else el.classList.add('hidden');
      return;
    }
    if (t.date !== cur) {
      $('fDate').value = t.date; updateOdoNote();
      show('Dated <b>' + MF.shortDate(t.date) + '</b> from the photo, taken ' + when + src + '.' + lateNote);
    } else if (late) show('Photo taken ' + when + '.' + lateNote);
    else el.classList.add('hidden');
  }
  function startPhoto(item, inQueue) {
    clearPhoto();
    applyPhotoDate(item.t, inQueue);
    var p = S.photo = { busy: true };
    $('photoBox').classList.remove('hidden');
    $('photoStatus').innerHTML = '<span class="spin"></span> Preparing photo…';
    $('photoActions').innerHTML = '';
    downscale(item.file, 1600).then(function (blob) {
      if (S.photo !== p) return;
      p.blob = blob; p.url = URL.createObjectURL(blob);
      $('photoImg').src = p.url;
      readOdometer();
    }).catch(function (e) {
      if (S.photo !== p) return;
      p.busy = false;
      $('photoStatus').textContent = (e && e.message) || 'Could not open that image. Try another photo.';
    });
  }
  function renderQueue() {
    var el = $('queueBar'), n = S.queue.length;
    if (!n) { el.classList.add('hidden'); el.innerHTML = ''; return; }
    el.innerHTML = '<span>Catching up from photos: ' + n + ' more after this one.</span>' +
      '<button class="linkbtn" type="button" id="qSkip">Skip this photo</button>' +
      '<button class="linkbtn" type="button" id="qStop">Stop</button>';
    el.classList.remove('hidden');
    $('qSkip').onclick = nextQueued;
    $('qStop').onclick = function () { S.queue = []; renderQueue(); };
  }
  function nextQueued() {
    if (!S.queue.length) { renderQueue(); return; }
    var item = S.queue.shift();
    resetForm();
    startPhoto(item, true);
    renderQueue();
    $('entryCard').scrollIntoView({ behavior: 'smooth', block: 'start' });
  }
  $('photoBtn').addEventListener('click', function () { if (OCR) OCR.warm(); });
  $('fPhoto').addEventListener('change', function () {
    var files = Array.prototype.slice.call(this.files || []);
    if (!files.length) return;
    Promise.all(files.map(function (f) { return photoTime(f).then(function (t) { return { file: f, t: t }; }); })).then(function (list) {
      list.sort(function (a, b) {
        var ka = a.t ? a.t.date + pad(a.t.hh) + pad(a.t.mm) : '9', kb = b.t ? b.t.date + pad(b.t.hh) + pad(b.t.mm) : '9';
        return ka < kb ? -1 : ka > kb ? 1 : 0;
      });
      S.queue = list.slice(1);
      startPhoto(list[0], list.length > 1);
      renderQueue();
    });
  });

  /* ---------------------------------------------------------- photo + OCR */
  function clearPhoto() {
    if (S.photo && S.photo.url) URL.revokeObjectURL(S.photo.url);
    if (S.photo && S.photo.ctl) S.photo.ctl.abort();
    S.photo = null; $('photoBox').classList.add('hidden'); $('fPhoto').value = '';
    $('dateHint').classList.add('hidden');
  }
  function downscale(file, maxDim) {
    return new Promise(function (resolve, reject) {
      var url = URL.createObjectURL(file), img = new Image();
      img.onload = function () {
        var sc = Math.min(1, maxDim / Math.max(img.naturalWidth, img.naturalHeight));
        var c = document.createElement('canvas');
        c.width = Math.round(img.naturalWidth * sc); c.height = Math.round(img.naturalHeight * sc);
        c.getContext('2d').drawImage(img, 0, 0, c.width, c.height);
        URL.revokeObjectURL(url);
        c.toBlob(function (b) { b ? resolve(b) : reject(new Error('Could not read that image')); }, 'image/jpeg', 0.88);
      };
      img.onerror = function () { URL.revokeObjectURL(url); reject(new Error('Could not open that image. Try another photo.')); };
      img.src = url;
    });
  }
  function readOdometer() {
    var p = S.photo; if (!p || !p.blob) return;
    if (!OCR) {
      p.busy = false;
      $('photoStatus').textContent = 'Photo attached. Type the reading above.';
      photoActions(); return;
    }
    p.busy = true; p.ctl = new AbortController();
    var loading = !OCR.isReady();
    $('photoStatus').innerHTML = '<span class="spin"></span> ' + (loading ? 'Getting the photo reader ready (first time only)…' : 'Reading the odometer…');
    $('photoActions').innerHTML = '<button class="linkbtn" type="button" id="stopRead">Stop</button>';
    $('stopRead').onclick = function () { p.ctl.abort(); };
    var date = $('fDate').value || todayISO(), prev = prevOdoFor(ymOf(date), date, S.editId);
    OCR.read(p.blob, {
      prev: prev ? prev.value : null, signal: p.ctl.signal,
      onProgress: function (m) {
        if (S.photo !== p || !m) return;
        if (m.status === 'reading') { $('photoStatus').innerHTML = '<span class="spin"></span> Reading the odometer…'; return; }
        if (/loading/.test(m.status || '') && m.progress > 0 && m.progress < 1) {
          $('photoStatus').innerHTML = '<span class="spin"></span> Getting the photo reader ready (first time only)… ' + Math.round(m.progress * 100) + '%';
        }
      }
    }).then(function (r) {
      if (S.photo !== p) return;
      p.busy = false;
      if (!r || r.level === 'low') {
        $('photoStatus').innerHTML = 'Couldn’t read the odometer clearly. Type it, or try a closer, straight-on photo.' +
          (r ? '<br>Best guess: <button class="chip alt" type="button" data-v="' + r.value + '">' + fmt(r.value) + '</button>' : '');
        photoActions(); return;
      }
      useReading(r.value);
      $('photoStatus').innerHTML = 'Read <b class="num">' + fmt(r.value) + '</b> from the photo. Check it matches the dash.' +
        ((r.alts || []).length ? '<br>Or: ' + r.alts.map(function (a) { return '<button class="chip alt" type="button" data-v="' + a + '">' + fmt(a) + '</button>'; }).join('') : '');
      photoActions();
    }).catch(function (e) {
      if (S.photo !== p) return;
      p.busy = false;
      $('photoStatus').textContent = e && e.code === 'cancelled' ? 'Stopped. Type the reading instead.' :
        (e && e.message) || 'Couldn’t read the photo. Type the reading instead.';
      photoActions();
    });
  }
  function useReading(v) {
    if (S.photo) S.photo.read = v;
    $('fOdo').value = v; updateOdoNote();
  }
  $('photoStatus').addEventListener('click', function (e) {
    var b = e.target.closest('button[data-v]'); if (!b) return;
    useReading(+b.getAttribute('data-v'));
    $('photoStatus').innerHTML = 'Using <b class="num">' + fmt(+b.getAttribute('data-v')) + '</b>. Check it matches the dash.';
  });
  function photoActions() {
    var h = '<button class="linkbtn" type="button" id="viewPhoto">View</button>';
    h += '<button class="linkbtn" type="button" id="dropPhoto">Remove photo</button>';
    $('photoActions').innerHTML = h;
    $('viewPhoto').onclick = function () { openViewer(S.photo && S.photo.url); };
    $('dropPhoto').onclick = function () { clearPhoto(); };
  }
  function openViewer(src) { if (!src) return; $('viewerImg').src = src; $('viewer').classList.remove('hidden'); $('viewerClose').focus(); }
  $('viewerClose').onclick = function () { $('viewer').classList.add('hidden'); };
  $('viewer').addEventListener('click', function (e) { if (e.target === this) this.classList.add('hidden'); });

  /* ----------------------------------------------------- month navigation */
  $('prevMonth').onclick = function () { S.view = addMonths(S.view, -1); editingBegin = false; resetForm(); renderAll(); };
  $('nextMonth').onclick = function () { if (S.view < ymOf(todayISO())) { S.view = addMonths(S.view, 1); editingBegin = false; resetForm(); renderAll(); } };

  /* ------------------------------------------------------------- save PDF */
  function pvStatus(msg, cls) { setStatus('pvStatus', msg, cls); }
  function setStatus(id, msg, cls) { var el = $(id); el.className = 'status' + (cls ? ' ' + cls : ''); el.innerHTML = msg || ''; }
  $('dlBtn').onclick = function () {
    var key = S.view;
    if (!window.PDFLib) { pvStatus('The PDF tools did not load. Close and reopen the app.', 'err'); return; }
    var f = readyFile(key, null);
    if (!f) {
      pvStatus('<span class="spin"></span> Getting the PDF ready…');
      getFile(key, null).then(function () { pvStatus('Ready. Tap Save PDF again.'); }, function () { pvStatus('Couldn’t build the PDF.', 'err'); });
      return;
    }
    deliver(f, f.name.replace(/\.pdf$/, '')).then(function (h) {
      pvStatus(h === 'downloaded' ? 'PDF downloaded.' : '', h === 'downloaded' ? 'ok' : '');
    }).catch(function () { pvStatus('Couldn’t open the share menu. Tap Save PDF again.', 'err'); });
  };

  /* ------------------------------------------------------------- settings */
  var settingsDirty = false;
  var FIELDS = ['sDriverName', 'sDriverShort', 'sTag', 'sVehicle', 'sBudget', 'sCommute', 'sHome', 'sFleet'];
  function fillSettings() {
    if (settingsDirty) return;
    var s = settings();
    $('sDriverName').value = s.driverName; $('sDriverShort').value = s.driverShort; $('sTag').value = s.licenseTag;
    $('sVehicle').value = s.vehicle; $('sBudget').value = s.budgetCode; $('sCommute').value = s.defaultCommute;
    $('sHome').value = s.home; $('sFleet').value = s.fleetEmail;
    renderPlaces();
  }
  function renderPlaces() {
    var s = settings();
    $('placeList').innerHTML = s.places.length ? s.places.map(function (p, i) {
      return '<span class="chip"' + (s.info[p] ? ' title="' + esc(s.info[p]) + '"' : '') + '>' + esc(p) + '<button type="button" data-i="' + i + '" aria-label="Remove ' + esc(p) + '">×</button></span>';
    }).join('') : '<span class="muted">No saved places yet.</span>';
  }
  FIELDS.forEach(function (id) {
    $(id).addEventListener('change', function () { settingsDirty = true; });
    $(id).addEventListener('input', function () { settingsDirty = true; });
  });
  function savePatch(patch, msg) {
    return saveSettings(patch).then(function () {
      setStatus('sStatus', msg || 'Saved.', 'ok');
      renderAll();
    }, function () { setStatus('sStatus', 'Could not save. Try again.', 'err'); });
  }
  $('placeList').addEventListener('click', function (e) {
    var b = e.target.closest('button[data-i]'); if (!b) return;
    var list = settings().places.slice(), gone = list.splice(+b.getAttribute('data-i'), 1)[0];
    savePatch({ places: list }, 'Removed ' + gone + '.').then(renderPlaces);
  });
  $('sAddPlace').onclick = function () {
    var raw = $('sNewPlace').value, parts = raw.split('=');
    var v = parts[0].replace(/[,;>]/g, ' ').replace(/\s+/g, ' ').trim(); if (!v) return;
    var full = parts.slice(1).join('=').replace(/\s+/g, ' ').trim();
    var list = settings().places.slice(), info = Object.assign({}, settings().info);
    var exists = list.some(function (p) { return p.toUpperCase() === v.toUpperCase(); });
    if (exists && !full) { $('sNewPlace').value = ''; return; }
    if (!exists) list.push(v);
    if (full) info[v] = full;
    $('sNewPlace').value = '';
    savePatch({ places: list, placeInfo: info }, (exists ? 'Updated ' : 'Added ') + v + '.').then(renderPlaces);
  };
  $('sSave').onclick = function () {
    var c = digits($('sCommute').value);
    settingsDirty = false;
    savePatch({
      driverName: $('sDriverName').value.trim(), driverShort: $('sDriverShort').value.trim(),
      licenseTag: $('sTag').value.trim(), vehicle: $('sVehicle').value.trim(), budgetCode: $('sBudget').value.trim(),
      defaultCommute: c === '' ? '' : +c, home: $('sHome').value.trim() || 'H', fleetEmail: $('sFleet').value.trim()
    }, 'Saved. The form updates to match.');
  };
  $('settingsCard').addEventListener('toggle', function () { if (this.open) { fillSettings(); renderBackupNote(); } });

  /* ---------------------------------------------------------------- backup */
  function backupData() {
    return { app: 'mileage-log', version: 1, exportedAt: new Date().toISOString(), settings: S.settings, months: S.months, signature: S.signature };
  }
  function countDays(months) {
    return Object.keys(months || {}).reduce(function (a, k) { return a + ((months[k] && months[k].trips) || []).length; }, 0);
  }
  function renderBackupNote() {
    var last = S.meta.lastBackup, store = Store.kind() === 'localStorage' ? ' (in this browser&#8217;s basic storage)' : '';
    $('bkNote').innerHTML = 'Your log is stored only on this phone' + store + '. Back it up now and then, and before you change phones. ' +
      (last ? 'Last backup: ' + esc(shortWhen(last)) + '.' : 'No backup yet.');
    $('aboutNote').textContent = 'Mileage Log ' + VERSION + '. Photos are read on this phone and never stored or uploaded.';
  }
  $('bkSave').onclick = function () {
    var f = new File([JSON.stringify(backupData())], 'Mileage Log backup ' + todayISO() + '.json', { type: 'application/json' });
    deliver(f, 'Mileage Log backup').then(function (h) {
      if (h === 'cancelled') { setStatus('bkStatus', ''); return; }
      saveMeta({ lastBackup: new Date().toISOString() }).catch(function () {});
      renderBackupNote();
      setStatus('bkStatus', h === 'downloaded' ? 'Backup downloaded. Keep it somewhere safe, like iCloud Drive or your email.' : 'Backup ready. Save it to Files or email it to yourself.', 'ok');
    }).catch(function () { setStatus('bkStatus', 'Couldn’t open the share menu. Tap Back up now again.', 'err'); });
  };
  var restoreFrom = 'settings';
  $('bkRestore').onclick = function () { restoreFrom = 'settings'; $('bkFile').click(); };
  $('uRestore').onclick = function () { restoreFrom = 'setup'; $('bkFile').click(); };
  $('bkFile').addEventListener('change', function () {
    var f = this.files && this.files[0], from = restoreFrom; this.value = '';
    if (!f) return;
    var where = from === 'setup' ? 'uStatus' : 'bkStatus';
    f.text().then(function (txt) { return JSON.parse(txt); }).then(function (data) {
      if (!data || typeof data !== 'object' || !data.settings || typeof data.months !== 'object') throw new Error('not a backup');
      if (from === 'setup' || !countDays(S.months)) return applyRestore(data);
      var n = Object.keys(data.months).length;
      $('bkConfirm').innerHTML = '<div class="confirm"><div>Replace the log on this phone with the backup from <b>' + esc(data.exportedAt ? shortWhen(data.exportedAt) : 'that file') +
        '</b>? It has ' + n + ' month' + (n === 1 ? '' : 's') + ' and ' + countDays(data.months) + ' days. What&#8217;s on this phone now (' + countDays(S.months) + ' days) is replaced.</div>' +
        '<div class="btns"><button class="primary" type="button" id="bkYes">Replace with backup</button><button class="secondary" type="button" id="bkNo">Cancel</button></div></div>';
      $('bkYes').onclick = function () { $('bkConfirm').innerHTML = ''; applyRestore(data); };
      $('bkNo').onclick = function () { $('bkConfirm').innerHTML = ''; };
    }).catch(function () { setStatus(where, 'That file isn’t a Mileage Log backup.', 'err'); });
  });
  function applyRestore(data) {
    var months = {};
    Object.keys(data.months || {}).forEach(function (k) {
      var m = data.months[k];
      if (/^\d{4}-\d{2}$/.test(k) && m && typeof m === 'object') { m.trips = Array.isArray(m.trips) ? m.trips : []; months[k] = m; }
    });
    var st = Object.assign({}, data.settings, { setupDone: true });
    return Store.clear().then(function () {
      var jobs = [Store.set('settings', st), Store.set('meta', { lastBackup: data.exportedAt || null, restoredAt: new Date().toISOString() })];
      Object.keys(months).forEach(function (k) { jobs.push(Store.set('month:' + k, months[k])); });
      if (data.signature && data.signature.png) jobs.push(Store.set('signature', data.signature));
      return Promise.all(jobs);
    }).then(function () {
      S.settings = st; S.months = months; S.signature = data.signature && data.signature.png ? data.signature : null;
      S.meta = { lastBackup: data.exportedAt || null }; settingsDirty = false; fileCache = {}; fileOrder = [];
      S.view = ymOf(todayISO());
      show('main'); resetForm(); renderAll(); fillSettings(); renderSettingsSig(); renderBackupNote();
      toast('Backup restored: ' + countDays(months) + ' days');
    }).catch(function () {
      toast('Couldn’t restore that backup on this phone.');
    });
  }

  /* ----------------------------------------------------------------- setup */
  $('uMonth').textContent = MF.monthLabel(ymOf(todayISO()));
  $('uStart').onclick = function () {
    var name = $('uName').value.replace(/\s+/g, ' ').trim(), tag = $('uTag').value.trim(), err = $('uErr');
    err.textContent = '';
    if (!name) { err.textContent = 'Add your name as it goes on the form.'; $('uName').focus(); return; }
    if (!tag) { err.textContent = 'Add the vehicle’s license tag.'; $('uTag').focus(); return; }
    var commute = digits($('uCommute').value), begin = digits($('uBegin').value);
    var places = ['W'], info = { W: 'Work' };
    if ($('uRegion').checked) REGION3.forEach(function (p) { places.push(p[0]); info[p[0]] = p[1]; });
    var s = {
      setupDone: true, createdAt: new Date().toISOString(),
      driverName: name, driverShort: shortName(name), licenseTag: tag, vehicle: $('uVehicle').value.trim(),
      budgetCode: $('uBudget').value.trim(), defaultCommute: commute === '' ? '' : +commute, home: 'H',
      places: places, placeInfo: info, fleetEmail: $('uFleet').value.trim()
    };
    $('uStart').disabled = true;
    saveSettings(s).then(function () {
      if (begin) return writeMonth(ymOf(todayISO()), function (m) { m.beginOdo = +begin; });
    }).then(function () {
      try { if (navigator.storage && navigator.storage.persist) navigator.storage.persist(); } catch (e) {}
      S.view = ymOf(todayISO());
      show('main'); resetForm(); renderAll(); welcome();
      window.scrollTo(0, 0);
    }).catch(function () {
      err.textContent = 'This browser won’t let the app save. If you’re in a private window, open it in a normal one.';
    }).then(function () { $('uStart').disabled = false; });
  };
  function welcome() {
    banner('<div><b>You&#8217;re set.</b> Log each day below: where you went and the ending odometer (tap <b>Read photo</b> to read it from a picture of the dash). At the end of the month, tap <b>Review, sign &amp; send</b>.</div>' +
      '<div class="row"><a class="linkbtn" href="reminder.ics" target="_blank" rel="noopener">Add a monthly reminder to your calendar</a>' +
      '<button class="linkbtn" type="button" id="welcomeOk">Got it</button></div>', 'info');
    $('welcomeOk').onclick = function () { banner(''); };
  }

  /* ---------------------------------------------------------------- misc */
  var toastT = null;
  function toast(msg) {
    var t = $('toast'); t.textContent = msg; t.classList.remove('hidden');
    clearTimeout(toastT); toastT = setTimeout(function () { t.classList.add('hidden'); }, 2600);
  }
  function banner(html, kind) {
    var b = $('banner');
    if (!html) { b.classList.add('hidden'); b.innerHTML = ''; return; }
    b.className = 'banner' + (kind ? ' ' + kind : ''); b.innerHTML = html;
  }
  function show(view) {
    ['gateView', 'setupView', 'mainView'].forEach(function (id) { $(id).classList.toggle('hidden', id !== view + 'View'); });
  }
  $('gateSkip').onclick = function () { saveMeta({ gateSkipped: true }).catch(function () {}); show('setup'); };

  // Android and desktop Chrome: offer to install as an app.
  var installEvt = null;
  window.addEventListener('beforeinstallprompt', function (e) {
    e.preventDefault(); installEvt = e;
    if (S.meta.installDismissed || !S.settings || !S.settings.setupDone) return;
    if (!$('banner').classList.contains('hidden')) return;
    banner('<div>Install Mileage Log as an app so it opens from your home screen.</div><div class="row">' +
      '<button class="secondary" type="button" id="installYes" style="min-height:40px">Install</button>' +
      '<button class="linkbtn" type="button" id="installNo">Not now</button></div>', 'info');
    $('installYes').onclick = function () { banner(''); installEvt.prompt(); installEvt = null; };
    $('installNo').onclick = function () { banner(''); saveMeta({ installDismissed: true }).catch(function () {}); };
  });

  /* ----------------------------------------------------------------- boot */
  $('fDate').value = todayISO();
  if (window.PDFLib && MF) {
    MF.metrics(window.PDFLib).then(function (m) { S.measure = m; if (S.loaded) { renderPreview(); renderEntries(); } });
  } else {
    pvStatus('The PDF tools did not load. Close and reopen the app.', 'err');
  }
  Store.all().then(function (all) {
    S.settings = all.settings || null;
    S.signature = all.signature && all.signature.png ? all.signature : null;
    S.meta = all.meta || {};
    Object.keys(all).forEach(function (k) { if (k.indexOf('month:') === 0 && all[k]) S.months[k.slice(6)] = all[k]; });
    S.loaded = true;
    if (!S.settings || !S.settings.setupDone) {
      show(isIOS && !isStandalone && !S.meta.gateSkipped ? 'gate' : 'setup');
      return;
    }
    show('main'); renderAll(); fillSettings(); renderSettingsSig();
  }).catch(function () {
    S.loaded = true;
    show('setup');
    setStatus('uStatus', 'This browser won’t let the app save anything. If this is a private window, open the link in a normal one.', 'err');
  });

  if ('serviceWorker' in navigator && (location.protocol === 'https:' || /^(localhost|127\.0\.0\.1)$/.test(location.hostname))) {
    window.addEventListener('load', function () { navigator.serviceWorker.register('sw.js').catch(function () {}); });
  }
})();
