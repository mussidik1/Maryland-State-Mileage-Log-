/* Monthly activity report for MIEMSS regional coordinators and associates.
   The categories match the Smartsheet activity form; this file adds them up, writes the
   email summary, builds a PDF, and makes a link that opens the Smartsheet form with the
   numbers already filled in. Exposes window.ActivityReport. */
(function (root) {
  'use strict';
  // [key, button label, label on the Smartsheet form (exact; Smartsheet matches it case-sensitively),
  //  required on the form (0 is entered) or "leave blank if 0", phrase used in summaries]
  var GROUPS = [
    { title: 'Visits', items: [
      ['v_jemsop', 'JEMSOP', '# of Visits to JEMSOPS', 1, 'JEMSOP visit'],
      ['v_ems', 'Local EMS/Fire', '# of Visits to Local EMS/Fire Dept', 1, 'local EMS/Fire visit'],
      ['v_other', '1st response, EM, 911', '# of Visits Other (1st Response, EM, 911 Center)', 1, '1st response/EM/911 visit'],
      ['v_hosp', 'Hospital', '# of Visits to Hospitals', 1, 'hospital visit'],
      ['v_lhd', 'Local health dept', '# of Visits to Local Health Dept.', 1, 'local health dept visit'],
      ['v_health', 'Other health agency', '# of Visits to other Health Agencies & Facilities', 1, 'other health agency visit']
    ] },
    { title: 'Meetings: local', items: [
      ['ml_ems', 'EMS, Fire/Rescue, EM', '# of Local EMS, Fire/Rescue, EM Meetings', 1, 'local EMS/Fire/EM meeting'],
      ['ml_health', 'Health', '# of Local Health Meetings', 1, 'local health meeting'],
      ['ml_hosp', 'Hospital', '# of Hospital Meetings', 1, 'hospital meeting'],
      ['ml_other', 'Other local', '# of Other Local Meetings (if 0 leave blank)', 0, 'other local meeting']
    ] },
    { title: 'Meetings: regional', items: [
      ['mr_ems', 'EMS', '#of Regional EMS Meetings', 1, 'regional EMS meeting'],
      ['mr_health', 'Health/Medical, HCC', '# of Regional Health/Medical, HCC Meetings', 1, 'regional health/HCC meeting'],
      ['mr_fire', 'Fire & EM', '# of Regional Fire & EM Meetings', 1, 'regional fire & EM meeting'],
      ['mr_other', 'Other regional', '# of Other Regional Meetings (if 0 leave blank)', 0, 'other regional meeting']
    ] },
    { title: 'Meetings: state', items: [
      ['ms_miemss', 'MIEMSS', '# of State EMS (MIEMSS) Meetings', 1, 'MIEMSS meeting'],
      ['ms_health', 'Health/Medical', '# of State Health/Medical Meetings', 1, 'state health/medical meeting'],
      ['ms_mdem', 'MDEM / state EM', '# of MDEM or other state EM Related Meetings', 1, 'MDEM/state EM meeting'],
      ['ms_other', 'Other state', '# of Other State Meetings (if 0 leave blank)', 0, 'other state meeting']
    ] },
    { title: 'Vehicle inspections', items: [
      ['i_first', '1st response vehicle', '# of 1st Response Vehicle Inspections', 1, '1st response vehicle inspection'],
      ['i_chase', 'ALS chase vehicle', '# of ALS Chase Vehicle Inspections', 1, 'ALS chase vehicle inspection'],
      ['i_bls', 'BLS ambulance', '# of BLS Ambulance Inspections', 1, 'BLS ambulance inspection'],
      ['i_als', 'ALS ambulance', '# of ALS Ambulance Inscpections', 1, 'ALS ambulance inspection']
    ] },
    { title: 'Assisting other MIEMSS departments', items: [
      ['a_bls', 'BLS testing', 'Assisting Clinician Services with BLS testing', 0, 'BLS testing assist'],
      ['a_narcan', 'Narcan distribution', 'Assisting with distribution of Narcan', 1, 'Narcan distribution']
    ] }
  ];
  // Month-level notes: [key, label in the app, label on the Smartsheet form]
  var NOTES = [
    ['assisting', 'Assisting other MIEMSS departments', 'Assisting Other MIEMSS Dept.s (please explain)'],
    ['projects', 'Local projects your region is heading', 'List Local Projects Your Region is Heading']
  ];

  var ITEMS = [], BYKEY = {};
  GROUPS.forEach(function (g) {
    g.items.forEach(function (a) {
      var it = { k: a[0], short: a[1], label: a[2], req: !!a[3], phrase: a[4], group: g.title };
      ITEMS.push(it); BYKEY[it.k] = it;
    });
  });

  function n(v) { v = parseInt(v, 10); return isFinite(v) && v > 0 ? v : 0; }
  function clean(counts) {
    var out = {};
    Object.keys(counts || {}).forEach(function (k) { if (BYKEY[k] && n(counts[k])) out[k] = n(counts[k]); });
    return out;
  }
  function totals(byDate) {
    var t = {};
    Object.keys(byDate || {}).forEach(function (d) {
      var c = clean(byDate[d]);
      Object.keys(c).forEach(function (k) { t[k] = (t[k] || 0) + c[k]; });
    });
    return t;
  }
  function count(counts) { var c = clean(counts); return Object.keys(c).reduce(function (a, k) { return a + c[k]; }, 0); }
  function plural(phrase, v) {
    if (v === 1) return '1 ' + phrase;
    return /(visit|meeting|inspection|assist)$/.test(phrase) ? v + ' ' + phrase + 's' : phrase + ' ×' + v;
  }
  // "2 hospital visits · 1 regional EMS meeting"
  function summary(counts) {
    var c = clean(counts);
    return ITEMS.filter(function (it) { return c[it.k]; }).map(function (it) { return plural(it.phrase, c[it.k]); }).join(' · ');
  }
  // What goes in each Smartsheet box: required boxes get 0, "leave blank if 0" boxes stay empty.
  function formValue(it, t) { var v = t[it.k] || 0; return v ? String(v) : it.req ? '0' : ''; }

  // A link that opens the Smartsheet form with the numbers filled in (Smartsheet's URL query
  // string defaults). Smartsheet ignores these if the form requires signing in.
  function formLink(base, t, notes) {
    base = String(base || '').trim();
    if (!/^https?:\/\//i.test(base)) return null;
    var parts = [];
    ITEMS.forEach(function (it) {
      var v = formValue(it, t);
      if (v !== '') parts.push(encodeURIComponent(it.label) + '=' + encodeURIComponent(v));
    });
    NOTES.forEach(function (f) {
      var v = notes && notes[f[0]] ? String(notes[f[0]]).trim() : '';
      if (v) parts.push(encodeURIComponent(f[2]) + '=' + encodeURIComponent(v));
    });
    var hash = '', i = base.indexOf('#');
    if (i >= 0) { hash = base.slice(i); base = base.slice(0, i); }
    base = base.replace(/[?&]+$/, '');   // a copied link often ends in "?"
    return base + (base.indexOf('?') >= 0 ? '&' : '?') + parts.join('&') + hash;
  }

  // Plain-text summary for the email body.
  function emailText(info) {
    var t = info.totals, lines = [];
    lines.push('Monthly activity for ' + info.month + (info.name ? ', ' + info.name : '') + '.');
    lines.push('Days with activity: ' + info.days.length + '. Totals in the order of the activity form:');
    GROUPS.forEach(function (g) {
      lines.push('', g.title.toUpperCase());
      g.items.forEach(function (a) {
        var it = BYKEY[a[0]], v = formValue(it, t);
        lines.push(it.label.replace(/^#\s*of\s*/i, '') + ': ' + (v === '' ? '(blank)' : v));
      });
    });
    NOTES.forEach(function (f) {
      var v = info.notes && info.notes[f[0]] ? String(info.notes[f[0]]).trim() : '';
      lines.push('', f[1].toUpperCase(), v || '(none entered)');
    });
    if (info.link) lines.push('', 'Open the Smartsheet form with these numbers filled in:', info.link);
    return lines.join('\n');
  }

  /* --------------------------------------------------------------------------- PDF */
  var WIN_EXTRA = '€‚ƒ„…†‡ˆ‰Š‹ŒŽ‘’“”•–—˜™š›œžŸ';
  function safe(s) {   // keep to characters the built-in PDF fonts can draw
    return String(s == null ? '' : s).replace(/→/g, '›').replace(/[\t\r]/g, ' ').split('').map(function (ch) {
      var c = ch.charCodeAt(0);
      if (ch === '\n') return ch;
      if (c < 32 || (c >= 0x7f && c < 0xa0)) return ' ';
      if (c < 0x100 || WIN_EXTRA.indexOf(ch) >= 0) return ch;
      return '?';
    }).join('');
  }
  function wrap(text, font, size, width) {
    var out = [];
    safe(text).split('\n').forEach(function (para) {
      var words = para.split(/ +/), line = '';
      words.forEach(function (w) {
        var tryLine = line ? line + ' ' + w : w;
        if (font.widthOfTextAtSize(tryLine, size) <= width) { line = tryLine; return; }
        if (line) out.push(line);
        while (font.widthOfTextAtSize(w, size) > width && w.length > 1) {   // a very long word
          var k = w.length - 1;
          while (k > 1 && font.widthOfTextAtSize(w.slice(0, k), size) > width) k--;
          out.push(w.slice(0, k)); w = w.slice(k);
        }
        line = w;
      });
      out.push(line);
    });
    return out;
  }

  // info: { month, name, vehicle, totals, notes, days: [{ date, label, counts, route }], generated }
  async function buildPdf(PDFLib, info) {
    var doc = await PDFLib.PDFDocument.create();
    doc.setTitle(safe('MIEMSS Activity Report - ' + info.month));
    doc.setCreator('Mileage Log');
    var reg = await doc.embedFont(PDFLib.StandardFonts.Helvetica);
    var bold = await doc.embedFont(PDFLib.StandardFonts.HelveticaBold);
    var W = 612, H = 792, M = 54, R = W - M;
    var navy = PDFLib.rgb(0.075, 0.13, 0.23), grey = PDFLib.rgb(0.4, 0.43, 0.49), rule = PDFLib.rgb(0.84, 0.86, 0.89);
    var black = PDFLib.rgb(0, 0, 0), pages = [], page, y;
    function newPage() { page = doc.addPage([W, H]); pages.push(page); y = H - M; }
    function need(h) { if (y - h < M + 24) newPage(); }
    function text(s, x, size, font, color) { page.drawText(safe(s), { x: x, y: y, size: size, font: font || reg, color: color || black }); }
    function right(s, size, font, color) { s = safe(s); page.drawText(s, { x: R - (font || reg).widthOfTextAtSize(s, size), y: y, size: size, font: font || reg, color: color || black }); }

    newPage();
    text('Monthly Activity Report', M, 20, bold, navy); y -= 24;
    text(info.month + (info.name ? '  ·  ' + info.name : ''), M, 12, reg); y -= 16;
    text('Coordinators & associate activity for the MIEMSS monthly activity log' + (info.vehicle ? '  ·  ' + info.vehicle : ''), M, 9, reg, grey); y -= 22;

    GROUPS.forEach(function (g) {
      need(22 + g.items.length * 17);
      text(g.title.toUpperCase(), M, 10, bold, navy); y -= 6;
      page.drawLine({ start: { x: M, y: y }, end: { x: R, y: y }, thickness: 1, color: navy }); y -= 13;
      g.items.forEach(function (a) {
        var it = BYKEY[a[0]], v = formValue(it, info.totals);
        text(it.label, M, 10, reg);
        if (v === '') right('blank', 9, reg, grey); else right(v, 10.5, bold, v === '0' ? grey : black);
        y -= 5;
        page.drawLine({ start: { x: M, y: y }, end: { x: R, y: y }, thickness: 0.5, color: rule }); y -= 12;
      });
      y -= 8;
    });

    NOTES.forEach(function (f) {
      var v = info.notes && info.notes[f[0]] ? String(info.notes[f[0]]).trim() : '';
      var lines = v ? wrap(v, reg, 10, R - M) : ['None entered.'];
      need(26 + lines.length * 13);
      text(f[1].toUpperCase(), M, 10, bold, navy); y -= 6;
      page.drawLine({ start: { x: M, y: y }, end: { x: R, y: y }, thickness: 1, color: navy }); y -= 14;
      lines.forEach(function (l) { text(l, M, 10, reg, v ? black : grey); y -= 13; });
      y -= 10;
    });

    // Day by day, for your records
    need(60);
    text('DAY BY DAY', M, 10, bold, navy); y -= 6;
    page.drawLine({ start: { x: M, y: y }, end: { x: R, y: y }, thickness: 1, color: navy }); y -= 14;
    if (!info.days.length) { text('No activity logged this month.', M, 10, reg, grey); y -= 13; }
    info.days.forEach(function (d) {
      var body = wrap(summary(d.counts), reg, 10, R - M - 80);
      var route = d.route ? wrap(d.route, reg, 8.5, R - M - 80) : [];
      need(body.length * 13 + route.length * 11 + 8);
      text(d.label, M, 10, bold);
      body.forEach(function (l, i) { page.drawText(safe(l), { x: M + 80, y: y - i * 13, size: 10, font: reg }); });
      y -= body.length * 13;
      route.forEach(function (l) { page.drawText(safe(l), { x: M + 80, y: y, size: 8.5, font: reg, color: grey }); y -= 11; });
      y -= 3;
      page.drawLine({ start: { x: M, y: y }, end: { x: R, y: y }, thickness: 0.5, color: rule }); y -= 12;
    });

    pages.forEach(function (p, i) {
      var f = safe('Mileage Log  ·  ' + (info.generated || '') + '  ·  page ' + (i + 1) + ' of ' + pages.length);
      p.drawText(f, { x: M, y: 30, size: 8, font: reg, color: grey });
    });
    return doc.save();
  }

  root.ActivityReport = {
    GROUPS: GROUPS, ITEMS: ITEMS, NOTES: NOTES, item: function (k) { return BYKEY[k]; },
    clean: clean, totals: totals, count: count, summary: summary, plural: plural,
    formValue: formValue, formLink: formLink, emailText: emailText, buildPdf: buildPdf
  };
})(window);
