/*
 * Vehicle Mileage Log (Appendix 2, State of Maryland Policies and Procedures
 * for Drivers of State Vehicles): layout + renderers.
 *
 * Shared by the logging page (browser) and the monthly job (Node). The page
 * geometry was measured from a photo of the printed form: the outer box is
 * 1300 x 1736 "form units" (FU), 1 FU = 0.36 pt, i.e. 6.5 in wide on a
 * US Letter page.
 *
 *   const pages = MileageForm.layout(data, measure)   // measure(fontKey, size, text) -> pt
 *   const bytes = await MileageForm.buildPdf(PDFLib, data)
 *   const svg   = MileageForm.renderSvg(pages[0])
 */
(function (root, factory) {
  if (typeof module === 'object' && module.exports) module.exports = factory();
  else root.MileageForm = factory();
})(typeof self !== 'undefined' ? self : this, function () {
  'use strict';

  var U = 0.36;                       // pt per form unit
  var PAGE_W = 612, PAGE_H = 792;     // US Letter
  var BOX_X = 72, BOX_TOP = 63;       // pt, outer box position on the page
  var BOX_W = 1300, BOX_H = 1736;     // FU

  // Horizontal rules (FU from the top of the box).
  var Y = {
    titleBottom: 48.0, bBottom: 99.4, cBottom: 166.9, headBottom: 262.6,
    firstLine: 316.7, pitch: 47.44, totalTop: 1645.0, sigTop: 1688.6
  };
  var NROWS = 29;
  var COL = [0, 132, 637, 821.5, 996, 1300];   // Date | Daily Travel | Commute | Ending Odo | Driver
  var HCOL = [0, 353, 736, 1300];              // header rows

  var LINE = 0.6, BORDER = 1.5, HEAD_RULE = 3.0;  // pt
  var LABEL_SIZE = 9, LABEL_SQUEEZE = 0.82;        // Arial Narrow Bold look
  var VALUE_SIZE = 10, ENTRY_SIZE = 9;
  var GRAY = 0.38;

  function px(fu) { return BOX_X + fu * U; }      // FU x -> pt
  function py(fu) { return BOX_TOP + fu * U; }    // FU y -> pt (from page top)

  function rowTop(i) { return i === 0 ? Y.headBottom : Y.firstLine + Y.pitch * (i - 1); }
  function rowBottom(i) { return Y.firstLine + Y.pitch * i; }

  var MONTHS = ['January', 'February', 'March', 'April', 'May', 'June', 'July',
    'August', 'September', 'October', 'November', 'December'];

  function monthLabel(ym) {
    var m = /^(\d{4})-(\d{2})$/.exec(ym || '');
    return m ? MONTHS[+m[2] - 1] + ' ' + m[1] : String(ym || '');
  }
  function shortDate(iso) {
    var m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(iso || '');
    return m ? (+m[2]) + '/' + (+m[3]) : String(iso || '');
  }

  /* Turn free text into stops: "W, JHH, BCoFD" -> ["H","W","JHH","BCoFD","H"]. */
  function parseRoute(text, opts) {
    opts = opts || {};
    var home = opts.home || 'H';
    var parts = String(text || '')
      .split(/\s*(?:,|;|\u2192|->|=>|>|\n)\s*/)
      .map(function (s) { return s.replace(/\s+/g, ' ').trim(); })
      .filter(Boolean);
    if (opts.startHome !== false && (!parts.length || parts[0].toUpperCase() !== home.toUpperCase())) parts.unshift(home);
    if (opts.endHome !== false && parts[parts.length - 1].toUpperCase() !== home.toUpperCase()) parts.push(home);
    return parts;
  }

  /* --------------------------------------------------------------- layout */

  function arrowWidth(size) { return size * 1.55; }   // gap + glyph + gap
  function arrowPath(size) {
    // Filled arrow, origin at the left end of the shaft on its centre line (y down).
    var len = size * 0.95, hl = size * 0.36, hh = size * 0.21, t = size * 0.09;
    var a = len - hl;
    return 'M0,' + (-t / 2) + ' L' + a + ',' + (-t / 2) + ' L' + a + ',' + (-hh) +
      ' L' + len + ',0 L' + a + ',' + hh + ' L' + a + ',' + (t / 2) + ' L0,' + (t / 2) + ' Z';
  }

  // Flow a route into lines no wider than maxW (pt). Place names stay whole
  // unless one alone is wider than a line. Returns [[atom...]...] where
  // atom = {t:'w', text, x} | {t:'a', x}; x is relative to the line start.
  function flowRoute(stops, size, maxW, measure) {
    var aw = arrowWidth(size), space = measure('H', size, ' ');
    var lines = [], cur = [], x = 0;
    function newLine() { if (cur.length) lines.push(cur); cur = []; x = 0; }
    stops.forEach(function (name, i) {
      var hasArrow = i < stops.length - 1;
      var w = measure('H', size, name);
      var unitW = w + (hasArrow ? aw : 0);
      if (x > 0 && x + unitW > maxW) newLine();
      if (unitW <= maxW) {
        cur.push({ t: 'w', text: name, x: x }); x += w;
      } else {
        String(name).split(/\s+/).filter(Boolean).forEach(function (wd, j, arr) {
          var ww = measure('H', size, wd);
          var lead = (x > 0 && j > 0) ? space : 0;
          var glued = (j === arr.length - 1 && hasArrow) ? aw : 0;
          if (x > 0 && x + lead + ww + glued > maxW) { newLine(); lead = 0; }
          cur.push({ t: 'w', text: wd, x: x + lead }); x += lead + ww;
        });
      }
      if (hasArrow) { cur.push({ t: 'a', x: x }); x += aw; }
    });
    newLine();
    return lines.length ? lines : [[]];
  }

  function fitSize(measure, font, text, size, maxW, minSize) {
    var s = size;
    while (s > (minSize || 6) && measure(font, s, text) > maxW) s -= 0.25;
    return s;
  }

  /*
   * data: { month:'2026-06', monthLabel?, budgetCode, driverName, licenseTag,
   *         vehicle, beginOdo, entries:[{date, route:[...]|string, commute,
   *         endOdo, driver}], totalCommute? }
   * measure(fontKey, size, text): width in pt; fontKey 'H' | 'HB' | 'T'.
   * Returns [{items:[...]}...] in pt, origin top-left of the page.
   */
  function layout(data, measure) {
    data = data || {};
    var entries = (data.entries || []).slice().sort(function (a, b) {
      if (a.date !== b.date) return a.date < b.date ? -1 : 1;
      return (+a.endOdo || 0) - (+b.endOdo || 0);
    });
    var routeX = COL[1] + 10, routeMax = (COL[2] - COL[1] - 18) * U;

    // Assign entries to rows, starting a new page when one would not fit.
    var pagesRows = [[]], used = 0;
    entries.forEach(function (e) {
      var stops = Array.isArray(e.route) ? e.route : parseRoute(e.route);
      // Largest size (9 -> 8.5 pt) that still gets the fewest lines.
      var best = flowRoute(stops, 8.5, routeMax, measure).length, size = 8.5, lines;
      for (var s = ENTRY_SIZE; s >= 8.5; s -= 0.25) {
        lines = flowRoute(stops, s, routeMax, measure);
        if (lines.length <= best) { size = s; break; }
      }
      var n = Math.min(lines.length, NROWS);
      if (used + n > NROWS) { pagesRows.push([]); used = 0; }
      pagesRows[pagesRows.length - 1].push({ e: e, lines: lines.slice(0, n), row: used, size: size });
      used += n;
    });

    var total = data.totalCommute != null ? data.totalCommute :
      entries.reduce(function (s, e) { return s + (+e.commute || 0); }, 0);
    var label = data.monthLabel || monthLabel(data.month);

    return pagesRows.map(function (rows, pi) {
      var items = [];
      var many = pagesRows.length > 1;
      drawFrame(items, measure);
      // Header values
      var mLabel = label + (many ? '  (page ' + (pi + 1) + ' of ' + pagesRows.length + ')' : '');
      headerValue(items, measure, mLabel, 'Month/Year:', 21, 80.2, HCOL[1]);
      headerValue(items, measure, data.budgetCode || '', 'Agency Budget Code:', 368, 79.7, HCOL[2]);
      headerValue(items, measure, data.driverName || '', 'Assigned Driver\u2019s Name:', 752, 77.7, HCOL[3]);
      headerValue(items, measure, data.licenseTag || '', 'License Tag:', 22, 128.9, HCOL[1]);
      headerValue(items, measure, data.beginOdo != null && data.beginOdo !== '' ? String(data.beginOdo) : '',
        'Beginning Odometer:', 753, 130.4, HCOL[3]);
      if (data.vehicle) {
        var vs = fitSize(measure, 'H', data.vehicle, 9.5, (HCOL[2] - HCOL[1] - 30) * U, 7);
        items.push({ k: 'text', x: px(378), y: py(160.5), text: data.vehicle, font: 'H', size: vs });
      }
      // Entries
      rows.forEach(function (r) {
        var e = r.e, first = r.row, last = r.row + r.lines.length - 1;
        var base = function (i) { return py(rowBottom(i) - 14.2); };
        var date = shortDate(e.date);
        items.push(centered(measure, 'H', ENTRY_SIZE, date, COL[0], COL[1], base(first)));
        r.lines.forEach(function (line, li) {
          var y = base(first + li), x0 = px(routeX);
          line.forEach(function (at) {
            if (at.t === 'w') items.push({ k: 'text', x: x0 + at.x, y: y, text: at.text, font: 'H', size: r.size });
            else items.push({ k: 'arrow', x: x0 + at.x + r.size * 0.30, y: y - r.size * 0.33, size: r.size });
          });
        });
        if (e.commute !== '' && e.commute != null) items.push(centered(measure, 'H', ENTRY_SIZE, String(e.commute), COL[2], COL[3], base(last)));
        if (e.endOdo !== '' && e.endOdo != null) items.push(centered(measure, 'H', ENTRY_SIZE, String(e.endOdo), COL[3], COL[4], base(last)));
        if (e.driver) {
          var ds = fitSize(measure, 'H', e.driver, ENTRY_SIZE, (COL[5] - COL[4] - 20) * U, 6.5);
          items.push(centered(measure, 'H', ds, e.driver, COL[4], COL[5], base(last)));
        }
      });
      // Signature (when signing): sits on the Assigned Driver's Signature line.
      if (data.signature && data.signature.w && data.signature.h) {
        var sigEnd = 15 + measure('HB', LABEL_SIZE, 'Assigned Driver\u2019s Signature:') * LABEL_SQUEEZE / U;
        var bottom = BOX_H - 3, maxH = 54, maxW = 760, ratio = data.signature.w / data.signature.h;
        var sh = maxH, sw = sh * ratio;
        if (sw > maxW) { sw = maxW; sh = sw / ratio; }
        items.push({ k: 'image', name: 'signature', x: px(sigEnd + 16), y: py(bottom - sh), w: sw * U, h: sh * U });
      }
      // Total (last page only)
      var isLast = pi === pagesRows.length - 1;
      var tLabelEnd = 15 + measure('HB', LABEL_SIZE, 'Total Commute Miles for Month:') * LABEL_SQUEEZE / U;
      items.push({ k: 'text', x: px(tLabelEnd + 12), y: py(1667.5),
        text: isLast ? String(total) : '(continued on next page)', font: 'H', size: isLast ? VALUE_SIZE : 8 });
      return { items: items, rowsUsed: rows.length ? rows[rows.length - 1].row + rows[rows.length - 1].lines.length : 0 };
    });
  }

  function centered(measure, font, size, text, c0, c1, y) {
    var w = measure(font, size, text);
    return { k: 'text', x: px((c0 + c1) / 2) - w / 2, y: y, text: text, font: font, size: size };
  }

  function headerValue(items, measure, value, labelText, labelX, baseFu, cellRight) {
    if (!value) return;
    var lw = measure('HB', LABEL_SIZE, labelText) * LABEL_SQUEEZE / U;  // FU
    var x = labelX + lw + 10;
    var maxW = (cellRight - x - 10) * U;
    var s = fitSize(measure, 'H', value, VALUE_SIZE, maxW, 6.5);
    items.push({ k: 'text', x: px(x), y: py(baseFu), text: value, font: 'H', size: s });
  }

  function hRule(items, x0, x1, yFu, t) {   // FU coords, thickness pt
    items.push({ k: 'rect', x: px(x0) - t / 2, y: py(yFu) - t / 2, w: (x1 - x0) * U + t, h: t, fill: 0 });
  }
  function vRule(items, xFu, y0, y1, t) {
    items.push({ k: 'rect', x: px(xFu) - t / 2, y: py(y0) - t / 2, w: t, h: (y1 - y0) * U + t, fill: 0 });
  }
  function label(items, measure, text, xFu, yFu, align) {
    var w = measure('HB', LABEL_SIZE, text) * LABEL_SQUEEZE;
    var x = px(xFu);
    if (align === 'center') x -= w / 2;
    items.push({ k: 'text', x: x, y: py(yFu), text: text, font: 'HB', size: LABEL_SIZE, squeeze: LABEL_SQUEEZE });
  }

  function drawFrame(items, measure) {
    // Shading first so rules draw over it.
    items.push({ k: 'rect', x: px(COL[2]), y: py(Y.totalTop), w: (COL[5] - COL[2]) * U, h: (Y.sigTop - Y.totalTop) * U, fill: GRAY });
    // Inner horizontal rules
    hRule(items, 0, BOX_W, Y.titleBottom, LINE);
    hRule(items, 0, BOX_W, Y.bBottom, LINE);
    hRule(items, 0, BOX_W, Y.cBottom, LINE);
    for (var i = 0; i < NROWS - 1; i++) hRule(items, 0, BOX_W, rowBottom(i), LINE);
    hRule(items, 0, BOX_W, Y.totalTop, LINE);
    hRule(items, 0, BOX_W, Y.sigTop, LINE);
    hRule(items, 0, BOX_W, Y.headBottom, HEAD_RULE);
    // Vertical rules
    vRule(items, HCOL[1], Y.titleBottom, Y.cBottom, LINE);
    vRule(items, HCOL[2], Y.titleBottom, Y.cBottom, LINE);
    vRule(items, COL[1], Y.cBottom, Y.totalTop, LINE);
    vRule(items, COL[2], Y.cBottom, Y.sigTop, LINE);
    vRule(items, COL[3], Y.cBottom, Y.totalTop, LINE);
    vRule(items, COL[4], Y.cBottom, Y.totalTop, LINE);
    // Outer box
    hRule(items, 0, BOX_W, 0, BORDER);
    hRule(items, 0, BOX_W, BOX_H, BORDER);
    vRule(items, 0, 0, BOX_H, BORDER);
    vRule(items, BOX_W, 0, BOX_H, BORDER);

    // Printed text
    label(items, measure, 'Vehicle Mileage Log', 670, 32.5, 'center');
    label(items, measure, 'Month/Year:', 21, 80.2);
    label(items, measure, 'Agency Budget Code:', 368, 79.7);
    label(items, measure, 'Assigned Driver\u2019s Name:', 752, 77.7);
    label(items, measure, 'License Tag:', 22, 128.9);
    label(items, measure, 'Year/Make/Model:', 368, 129.7);
    label(items, measure, 'Beginning Odometer:', 753, 130.4);
    label(items, measure, 'Date', (COL[0] + COL[1]) / 2, 227.4, 'center');
    label(items, measure, 'Daily Travel Activity', (COL[1] + COL[2]) / 2, 196.3, 'center');
    label(items, measure, '(Must Include All Destinations)', (COL[1] + COL[2]) / 2, 242.5, 'center');
    label(items, measure, 'Commute Miles', (COL[2] + COL[3]) / 2, 197.1, 'center');
    label(items, measure, 'Ending', (COL[3] + COL[4]) / 2, 197.7, 'center');
    label(items, measure, 'Odometer', (COL[3] + COL[4]) / 2, 236.7, 'center');
    label(items, measure, 'Driver\u2019s Name', (COL[4] + COL[5]) / 2, 225.5, 'center');
    label(items, measure, 'Total Commute Miles for Month:', 15, 1667.5);
    label(items, measure, 'Assigned Driver\u2019s Signature:', 15, 1713.9);

    var aw = measure('T', 11.5, 'Appendix 2');
    items.push({ k: 'text', x: px(1303) - aw, y: py(-11), text: 'Appendix 2', font: 'T', size: 11.5 });
    var nw = measure('T', 12, '12');
    items.push({ k: 'text', x: px(622) - nw / 2, y: py(1885), text: '12', font: 'T', size: 12 });
    items.push({ k: 'text', x: px(3.8), y: py(1921), font: 'T', size: 8.9,
      text: 'State of Maryland Policies and Procedures for Drivers of State Vehicles' });
  }

  /* ------------------------------------------------------------- renderers */

  var FONT_NAMES = { H: 'Helvetica', HB: 'HelveticaBold', T: 'TimesRoman' };

  function cleanFor(font) {
    var cache = {};
    return function (str) {
      var out = '';
      for (var i = 0; i < str.length; i++) {
        var ch = str[i];
        if (cache[ch] === undefined) {
          try { font.encodeText(ch); cache[ch] = ch; } catch (e) { cache[ch] = '?'; }
        }
        out += cache[ch];
      }
      return out;
    };
  }

  async function embedFonts(PDFLib, doc) {
    var f = {};
    for (var k in FONT_NAMES) f[k] = await doc.embedFont(PDFLib.StandardFonts[FONT_NAMES[k]]);
    var clean = {};
    for (var k2 in f) clean[k2] = cleanFor(f[k2]);
    var measure = function (key, size, text) { return f[key].widthOfTextAtSize(clean[key](String(text)), size); };
    return { fonts: f, clean: clean, measure: measure };
  }

  async function buildPdf(PDFLib, data) {
    var doc = await PDFLib.PDFDocument.create();
    var E = await embedFonts(PDFLib, doc);
    var pages = layout(data, E.measure);
    doc.setTitle('Vehicle Mileage Log - ' + (data.monthLabel || monthLabel(data.month)));
    doc.setAuthor(data.driverName || '');
    doc.setCreator('Mileage Log');
    var black = PDFLib.rgb(0, 0, 0);
    var sigImg = (data.signature && data.signature.png) ? await doc.embedPng(data.signature.png) : null;
    pages.forEach(function (pg) {
      var page = doc.addPage([PAGE_W, PAGE_H]);
      var keys = {};
      pg.items.forEach(function (it) {
        if (it.k === 'rect') {
          page.drawRectangle({ x: it.x, y: PAGE_H - it.y - it.h, width: it.w, height: it.h,
            color: PDFLib.grayscale(it.fill), borderWidth: 0 });
        } else if (it.k === 'image') {
          if (it.name === 'signature' && sigImg) page.drawImage(sigImg, { x: it.x, y: PAGE_H - it.y - it.h, width: it.w, height: it.h });
        } else if (it.k === 'arrow') {
          page.drawSvgPath(arrowPath(it.size), { x: it.x, y: PAGE_H - it.y, color: black });
        } else if (it.k === 'text') {
          var font = E.fonts[it.font], text = E.clean[it.font](it.text);
          if (it.squeeze && it.squeeze !== 1) {
            var key = keys[it.font] || (keys[it.font] = page.node.newFontDictionary(font.name, font.ref));
            page.pushOperators(
              PDFLib.pushGraphicsState(),
              PDFLib.beginText(),
              PDFLib.setFillingColor(black),
              PDFLib.setFontAndSize(key, it.size),
              PDFLib.setCharacterSqueeze(it.squeeze * 100),
              PDFLib.moveText(it.x, PAGE_H - it.y),
              PDFLib.showText(font.encodeText(text)),
              PDFLib.endText(),
              PDFLib.popGraphicsState()
            );
          } else {
            page.drawText(text, { x: it.x, y: PAGE_H - it.y, size: it.size, font: font, color: black });
          }
        }
      });
    });
    return doc.save();
  }

  function esc(s) {
    return String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
  }

  // SVG of one laid-out page. Pass measure so text is held to the PDF's widths.
  function renderSvg(page, measure, opts) {
    var imgs = (opts && opts.images) || {};
    var fam = { H: "Helvetica, Arial, 'Liberation Sans', sans-serif", HB: "Helvetica, Arial, 'Liberation Sans', sans-serif",
      T: "'Times New Roman', Times, 'Liberation Serif', serif" };
    var out = ['<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ' + PAGE_W + ' ' + PAGE_H + '" width="100%" role="img" aria-label="Vehicle Mileage Log preview">',
      '<rect width="' + PAGE_W + '" height="' + PAGE_H + '" fill="#fff"/>'];
    page.items.forEach(function (it) {
      if (it.k === 'rect') {
        var g = Math.round(it.fill * 255);
        out.push('<rect x="' + it.x.toFixed(2) + '" y="' + it.y.toFixed(2) + '" width="' + it.w.toFixed(2) + '" height="' + it.h.toFixed(2) + '" fill="rgb(' + g + ',' + g + ',' + g + ')"/>');
      } else if (it.k === 'image') {
        if (imgs[it.name]) out.push('<image href="' + esc(imgs[it.name]) + '" x="' + it.x.toFixed(2) + '" y="' + it.y.toFixed(2) + '" width="' + it.w.toFixed(2) + '" height="' + it.h.toFixed(2) + '" preserveAspectRatio="none"/>');
      } else if (it.k === 'arrow') {
        out.push('<path transform="translate(' + it.x.toFixed(2) + ' ' + it.y.toFixed(2) + ')" d="' + arrowPath(it.size) + '" fill="#000"/>');
      } else if (it.k === 'text') {
        var w = measure ? measure(it.font, it.size, it.text) * (it.squeeze || 1) : null;
        out.push('<text x="' + it.x.toFixed(2) + '" y="' + it.y.toFixed(2) + '" font-family="' + fam[it.font] + '" font-size="' + it.size +
          '"' + (it.font === 'HB' ? ' font-weight="bold"' : '') +
          (w ? ' textLength="' + w.toFixed(2) + '" lengthAdjust="spacingAndGlyphs"' : '') + '>' + esc(it.text) + '</text>');
      }
    });
    out.push('</svg>');
    return out.join('');
  }

  // Metrics without building a PDF (browser preview): needs PDFLib loaded.
  async function metrics(PDFLib) {
    var doc = await PDFLib.PDFDocument.create();
    return (await embedFonts(PDFLib, doc)).measure;
  }

  return {
    layout: layout, buildPdf: buildPdf, renderSvg: renderSvg, metrics: metrics,
    parseRoute: parseRoute, monthLabel: monthLabel, shortDate: shortDate,
    ROWS_PER_PAGE: NROWS, VERSION: '1.1.0'
  };
});
