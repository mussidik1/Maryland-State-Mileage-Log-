/* Setup links: me/#s=<code> fills in a new log with a driver's details, then starts the
   regular app. The code lives after the #, so it is never sent to the website. */
(function () {
  'use strict';
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

  function decode(s) {
    s = s.replace(/-/g, '+').replace(/_/g, '/');
    while (s.length % 4) s += '=';
    var bin = atob(s), bytes = new Uint8Array(bin.length);
    for (var i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
    return new TextDecoder().decode(bytes);
  }
  function parse() {
    var m = /[#&]s=([A-Za-z0-9_-]+)/.exec(location.hash || '');
    if (!m) return null;
    try { var d = JSON.parse(decode(m[1])); return d && d.v === 1 ? d : null; } catch (e) { return null; }
  }
  function build(d) {
    var places = ['W'], info = { W: 'Work' };
    (d.x || []).forEach(function (p) {
      if (p && p[0] && places.indexOf(p[0]) < 0) { places.push(p[0]); if (p[1]) info[p[0]] = p[1]; }
    });
    if (d.r) REGION3.forEach(function (p) { if (places.indexOf(p[0]) < 0) { places.push(p[0]); info[p[0]] = p[1]; } });
    return {
      setupDone: true, createdAt: new Date().toISOString(), fromSetupLink: true,
      driverName: d.n || '', driverShort: d.d || '', licenseTag: d.t || '', vehicle: d.m || '', budgetCode: d.b || '',
      defaultCommute: d.c != null ? d.c : '', home: d.h || 'H', places: places, placeInfo: info, sendTo: d.e || ''
    };
  }
  // Write into the same storage the app reads, only if this log has not been set up yet.
  function seed(settings) {
    return new Promise(function (resolve, reject) {
      if (!window.indexedDB) { reject(); return; }
      var r = indexedDB.open('mileage-log', 1);
      r.onupgradeneeded = function () { r.result.createObjectStore('kv'); };
      r.onerror = function () { reject(r.error); };
      r.onsuccess = function () {
        var db = r.result, t = db.transaction('kv', 'readwrite'), st = t.objectStore('kv'), g = st.get('settings');
        g.onsuccess = function () { if (!g.result || !g.result.setupDone) st.put(settings, 'settings'); };
        t.oncomplete = function () { db.close(); resolve(); };
        t.onerror = function () { db.close(); reject(t.error); };
      };
    }).catch(function () {
      try { if (!localStorage.getItem('mileage-log:settings')) localStorage.setItem('mileage-log:settings', JSON.stringify(settings)); } catch (e) {}
    });
  }
  var started = false;
  function startApp() {
    if (started) return; started = true;
    var s = document.createElement('script'); s.src = '../app.js'; document.body.appendChild(s);
  }
  var d = parse();
  if (!d) {   // no setup code: behave like the regular app
    var g = document.querySelector('#gateView h1'), l = document.querySelector('#gateView .lead');
    if (g) g.textContent = 'Add it to your Home Screen first';
    if (l) l.textContent = 'It works like an app from there. On iPhone, the Home Screen version keeps its own copy of your log, so set it up there.';
    startApp(); return;
  }
  var isIOS = /iPad|iPhone|iPod/.test(navigator.userAgent) || (navigator.platform === 'MacIntel' && navigator.maxTouchPoints > 1);
  var standalone = window.navigator.standalone === true || (window.matchMedia && matchMedia('(display-mode: standalone)').matches);
  if (isIOS && !standalone) {
    // On iPhone the Home Screen copy has its own storage, so set it up there: it opens this same link.
    document.getElementById('gateView').classList.remove('hidden');
    document.getElementById('gateSkip').addEventListener('click', function (e) {
      e.stopImmediatePropagation();
      this.disabled = true;
      seed(build(d)).then(startApp);
    }, true);
    return;
  }
  seed(build(d)).then(startApp);
})();
