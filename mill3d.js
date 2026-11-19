/* =====================================================================
   mill3d.js — Model 3D semu (SVG isometrik, cutaway) VRM + animasi
   ---------------------------------------------------------------------
   Cara kerja singkat:
   - Geometri didefinisikan dalam koordinat 3D (meter): z ke atas,
     sumbu putar mill = sumbu z.
   - Fungsi proj() memproyeksikan titik 3D ke layar dengan sudut pandang
     azimut θ (bisa diputar 0–360°) dan elevasi tetap (25°).
   - Benda simetri putar (casing, meja, rotor) digambar dari elips.
     Benda miring (roller, duct, silinder hidrolik) digambar sebagai
     "tabung" = convex hull dua lingkaran ujung + gradient.
   - Setiap frame, lapisan dinamis dibangun ulang sebagai string SVG
     (±200 elemen). Partikel memakai elemen <circle> tetap (maks 120).
   ===================================================================== */

window.VRM = window.VRM || {};

VRM.Mill3D = (function () {
  var NS = 'http://www.w3.org/2000/svg';
  var S = 46;                 // piksel per meter
  var CX = 500, CY = 560;     // titik asal (sumbu mill, z = 0) di layar
  var ELEV = 25 * Math.PI / 180;
  var SIN_E = Math.sin(ELEV), COS_E = Math.cos(ELEV);
  var VIS_BED = 4;            // pembesaran visual tebal bed & dam ring
  var MAX_PARTICLES = 120;

  var deg = Math.PI / 180;
  // Azimut (dunia) komponen non-simetri
  var AZ = { feed: 200 * deg, outlet: 340 * deg, inlet: 160 * deg, motor: 20 * deg };

  // ---- State tampilan & animasi ----
  var svg, layers = {}, particleEls = [], tooltipEl, containerEl;
  var theta = 0;                         // sudut pandang (rad)
  var view = { x: 0, y: 40, w: 1000, h: 780 };
  var showLabels = true;
  var anim = { table: 0, rotor: 0, gas: 0, feeder: 0, shakeX: 0, shakeY: 0, spawnAcc: 0 };
  var particles = [];
  var st = null;                         // state proses terakhir dari sim
  var hoverComp = null, lastMouse = { x: 0, y: 0 };
  var gid = 0, defsBuf = [], gidE = 0, defsExt = [];
  var frameNo = 0, lastTheta = null;

  /* ---------------- Proyeksi & vektor ---------------- */

  function proj(x, y, z) {
    var c = Math.cos(theta), s = Math.sin(theta);
    var xr = x * c - y * s;
    var yr = x * s + y * c;              // positif = mendekati penonton
    return { x: CX + xr * S, y: CY - z * S * COS_E + yr * S * SIN_E, d: yr * COS_E + z * SIN_E };
  }
  function cyl(r, a, z) { return [r * Math.cos(a), r * Math.sin(a), z]; }
  function P(v) { return proj(v[0], v[1], v[2]); }
  function add(a, b) { return [a[0] + b[0], a[1] + b[1], a[2] + b[2]]; }
  function sub(a, b) { return [a[0] - b[0], a[1] - b[1], a[2] - b[2]]; }
  function mul(a, k) { return [a[0] * k, a[1] * k, a[2] * k]; }
  function dot(a, b) { return a[0] * b[0] + a[1] * b[1] + a[2] * b[2]; }
  function cross(a, b) { return [a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0]]; }
  function norm(a) { var l = Math.hypot(a[0], a[1], a[2]) || 1; return [a[0] / l, a[1] / l, a[2] / l]; }
  // Arah menuju penonton dalam koordinat dunia
  // Kedalaman horizontal saja (positif = di depan bidang potong) — untuk memilah depan/belakang
  function horizDepth(v) { return v[0] * Math.sin(theta) + v[1] * Math.cos(theta); }
  function viewDir() { return [Math.sin(theta) * COS_E, Math.cos(theta) * COS_E, SIN_E]; }
  function f1(v) { return Math.round(v * 10) / 10; }

  /* ---------------- Warna ---------------- */

  function hexToRgb(h) { var n = parseInt(h.slice(1), 16); return [(n >> 16) & 255, (n >> 8) & 255, n & 255]; }
  function rgbToHex(c) { return '#' + c.map(function (v) { return ('0' + Math.round(Math.max(0, Math.min(255, v))).toString(16)).slice(-2); }).join(''); }
  function mix(a, b, t) { var A = hexToRgb(a), B = hexToRgb(b); t = Math.max(0, Math.min(1, t)); return rgbToHex([A[0] + (B[0] - A[0]) * t, A[1] + (B[1] - A[1]) * t, A[2] + (B[2] - A[2]) * t]); }
  function shade(h, k) { return k >= 0 ? mix(h, '#ffffff', k) : mix(h, '#000000', -k); }

  // Warna gas berdasarkan suhu: biru → cyan → oranye → merah
  var TEMP_STOPS = [[60, '#3d8bff'], [110, '#3ec6e0'], [170, '#ffc04d'], [240, '#ff8a2f'], [330, '#ff3030']];
  function tempColor(T) {
    if (!Number.isFinite(T)) T = 90;
    if (T <= TEMP_STOPS[0][0]) return TEMP_STOPS[0][1];
    for (var i = 1; i < TEMP_STOPS.length; i++) {
      if (T <= TEMP_STOPS[i][0]) {
        var a = TEMP_STOPS[i - 1], b = TEMP_STOPS[i];
        return mix(a[1], b[1], (T - a[0]) / (b[0] - a[0]));
      }
    }
    return TEMP_STOPS[TEMP_STOPS.length - 1][1];
  }
  var LEVEL_COLOR = { ok: '#0ca30c', warn: '#fab219', alarm: '#d03b3b' };

  /* ---------------- Primitif gambar ---------------- */

  // Elips horizontal (lingkaran r pada ketinggian z)
  function ell(z, r) { var c = proj(0, 0, z); return { cx: c.x, cy: c.y, rx: r * S, ry: r * S * SIN_E }; }

  // Pita belakang (permukaan dalam bagian belakang) antara dua elips
  function backBand(z1, r1, z2, r2) {
    var a = ell(z1, r1), b = ell(z2, r2);
    return 'M' + f1(b.cx - b.rx) + ' ' + f1(b.cy) + ' A' + f1(b.rx) + ' ' + f1(b.ry) + ' 0 0 1 ' + f1(b.cx + b.rx) + ' ' + f1(b.cy) +
      ' L' + f1(a.cx + a.rx) + ' ' + f1(a.cy) + ' A' + f1(a.rx) + ' ' + f1(a.ry) + ' 0 0 0 ' + f1(a.cx - a.rx) + ' ' + f1(a.cy) + ' Z';
  }
  // Pita depan (permukaan luar bagian depan) antara dua elips
  function frontBand(z1, r1, z2, r2) {
    var a = ell(z1, r1), b = ell(z2, r2);
    return 'M' + f1(b.cx - b.rx) + ' ' + f1(b.cy) + ' A' + f1(b.rx) + ' ' + f1(b.ry) + ' 0 0 0 ' + f1(b.cx + b.rx) + ' ' + f1(b.cy) +
      ' L' + f1(a.cx + a.rx) + ' ' + f1(a.cy) + ' A' + f1(a.rx) + ' ' + f1(a.ry) + ' 0 0 1 ' + f1(a.cx - a.rx) + ' ' + f1(a.cy) + ' Z';
  }
  function ellipseEl(z, r, attrs) {
    var e = ell(z, r);
    return '<ellipse cx="' + f1(e.cx) + '" cy="' + f1(e.cy) + '" rx="' + f1(e.rx) + '" ry="' + f1(Math.max(e.ry, 0.1)) + '" ' + attrs + '/>';
  }
  // Busur setengah elips (back = true → bagian belakang/atas)
  function halfArc(z, r, back) {
    var e = ell(z, r);
    return 'M' + f1(e.cx - e.rx) + ' ' + f1(e.cy) + ' A' + f1(e.rx) + ' ' + f1(e.ry) + ' 0 0 ' + (back ? 1 : 0) + ' ' + f1(e.cx + e.rx) + ' ' + f1(e.cy);
  }

  // Convex hull (monotone chain) untuk titik layar
  function hull(pts) {
    pts = pts.slice().sort(function (a, b) { return a.x - b.x || a.y - b.y; });
    function cr(o, a, b) { return (a.x - o.x) * (b.y - o.y) - (a.y - o.y) * (b.x - o.x); }
    var lower = [], upper = [], i;
    for (i = 0; i < pts.length; i++) {
      while (lower.length >= 2 && cr(lower[lower.length - 2], lower[lower.length - 1], pts[i]) <= 0) lower.pop();
      lower.push(pts[i]);
    }
    for (i = pts.length - 1; i >= 0; i--) {
      while (upper.length >= 2 && cr(upper[upper.length - 2], upper[upper.length - 1], pts[i]) <= 0) upper.pop();
      upper.push(pts[i]);
    }
    upper.pop(); lower.pop();
    return lower.concat(upper);
  }
  function polyPath(pts) {
    return 'M' + pts.map(function (p) { return f1(p.x) + ' ' + f1(p.y); }).join(' L') + ' Z';
  }

  // Lingkaran 3D (pusat c, sumbu u, jari-jari r) → titik layar
  function circle3D(c, u, r, n, basis) {
    var v1 = basis ? basis[0] : null, v2 = basis ? basis[1] : null;
    if (!v1) {
      var w = Math.abs(u[2]) < 0.9 ? [0, 0, 1] : [1, 0, 0];
      v1 = norm(cross(u, w)); v2 = cross(u, v1);
    }
    var pts = [];
    for (var i = 0; i < n; i++) {
      var t = i / n * Math.PI * 2;
      pts.push(P(add(c, add(mul(v1, r * Math.cos(t)), mul(v2, r * Math.sin(t))))));
    }
    return { pts: pts, v1: v1, v2: v2 };
  }

  /**
   * Tabung / frustum 3D dari p0 ke p1 (jari-jari r0, r1).
   * opt: {color, comp, cap (bool), spin (sudut tanda putar), opacity, stroke}
   */
  function tube(p0, p1, r0, r1, opt) {
    opt = opt || {};
    var u = norm(sub(p1, p0));
    var c0 = circle3D(p0, u, r0, 18, opt.basis);
    var c1 = circle3D(p1, u, r1, 18, [c0.v1, c0.v2]);
    var h = hull(c0.pts.concat(c1.pts));
    var a = P(p0), b = P(p1);
    var dx = b.x - a.x, dy = b.y - a.y, L = Math.hypot(dx, dy) || 1;
    var px = -dy / L, py = dx / L;
    if (px > 0 || (Math.abs(px) < 1e-6 && py > 0)) { px = -px; py = -py; } // cahaya dari kiri-atas
    var mx = (a.x + b.x) / 2, my = (a.y + b.y) / 2, hw = Math.max(r0, r1) * S;
    var col = opt.color || '#7d8a99';
    // Komponen luar (opt.ext) punya buffer gradient sendiri karena lapisannya dibangun ulang lebih jarang
    var id = opt.ext ? 'te' + (gidE++) : 'tm' + (gid++);
    (opt.ext ? defsExt : defsBuf).push('<linearGradient id="' + id + '" gradientUnits="userSpaceOnUse" x1="' + f1(mx + px * hw) + '" y1="' + f1(my + py * hw) +
      '" x2="' + f1(mx - px * hw) + '" y2="' + f1(my - py * hw) + '"><stop offset="0" stop-color="' + shade(col, 0.35) +
      '"/><stop offset="0.35" stop-color="' + shade(col, 0.1) + '"/><stop offset="0.75" stop-color="' + shade(col, -0.35) +
      '"/><stop offset="1" stop-color="' + shade(col, -0.6) + '"/></linearGradient>');
    var comp = opt.comp ? ' data-comp="' + opt.comp + '"' : '';
    var op = opt.opacity !== undefined ? ' opacity="' + opt.opacity + '"' : '';
    var out = '<g' + comp + op + '><path d="' + polyPath(h) + '" fill="url(#' + id + ')" stroke="' + (opt.stroke || shade(col, -0.65)) + '" stroke-width="0.8"/>';
    if (opt.cap !== false) {
      var vd = viewDir();
      var showEnd = dot(u, vd) > 0;
      var cc = showEnd ? c1 : c0, cen = showEnd ? b : a, rr = showEnd ? r1 : r0;
      out += '<path d="' + polyPath(cc.pts) + '" fill="' + shade(col, showEnd ? 0.05 : -0.2) + '" stroke="' + shade(col, -0.6) + '" stroke-width="0.8"/>';
      if (opt.spin !== undefined) {
        // Tanda putar (jari-jari) pada tutup — menunjukkan rotasi
        var pc = showEnd ? p1 : p0;
        for (var k = 0; k < 3; k++) {
          var t = opt.spin + k * Math.PI * 2 / 3;
          var q = P(add(pc, add(mul(c0.v1, rr * 0.85 * Math.cos(t)), mul(c0.v2, rr * 0.85 * Math.sin(t)))));
          out += '<line x1="' + f1(cen.x) + '" y1="' + f1(cen.y) + '" x2="' + f1(q.x) + '" y2="' + f1(q.y) + '" stroke="' + shade(col, -0.55) + '" stroke-width="2.2" stroke-linecap="round"/>';
        }
        var hub = circle3D(pc, u, rr * 0.22, 12, [c0.v1, c0.v2]);
        out += '<path d="' + polyPath(hub.pts) + '" fill="' + shade(col, -0.4) + '"/>';
      }
    }
    return out + '</g>';
  }

  /* ---------------- Geometri mill ---------------- */

  function geo() {
    var mill = VRM.CONFIG.mill;
    var Rt = Math.max(2, Math.min(4.5, mill.tableDiameter / 2));
    var k = Rt / 2.95;
    return {
      Rt: Rt, k: k,
      tableTop: 0.55,
      // Profil casing (z, r) dari bawah ke atas
      casing: [[-0.4, Rt + 0.6], [3.6, Rt + 0.6], [4.6, Rt + 1.15], [7.2, Rt + 1.15], [8.6, Rt * 0.55]],
      rotorR: 1.9 * k, rotorZ0: 5.0, rotorZ1: 7.3,
      rollerR: 1.1 * k, rollerW: 0.85 * k, contactR: 1.85 * k,
      nRollers: Math.max(2, Math.min(6, Math.round(mill.rollers)))
    };
  }

  /* ---------------- Inisialisasi ---------------- */

  function init(container) {
    containerEl = container;
    svg = document.createElementNS(NS, 'svg');
    svg.setAttribute('class', 'mill-svg');
    svg.setAttribute('preserveAspectRatio', 'xMidYMid meet');
    svg.innerHTML =
      '<defs>' +
      '<linearGradient id="gInner" x1="0" x2="1"><stop offset="0" stop-color="#151b22"/><stop offset="0.5" stop-color="#34404d"/><stop offset="1" stop-color="#151b22"/></linearGradient>' +
      '<linearGradient id="gOuter" x1="0" x2="1"><stop offset="0" stop-color="#9aa6b3"/><stop offset="0.3" stop-color="#6f7c8a"/><stop offset="1" stop-color="#2c343d"/></linearGradient>' +
      '<linearGradient id="gTable" x1="0" x2="1"><stop offset="0" stop-color="#8d98a5"/><stop offset="0.35" stop-color="#5d6875"/><stop offset="1" stop-color="#222a33"/></linearGradient>' +
      '<linearGradient id="gGear" x1="0" x2="1"><stop offset="0" stop-color="#4d6a7f"/><stop offset="0.35" stop-color="#3a5265"/><stop offset="1" stop-color="#16212b"/></linearGradient>' +
      '<radialGradient id="gBed" cx="0.45" cy="0.4" r="0.6"><stop offset="0" stop-color="#b58d5e"/><stop offset="0.7" stop-color="#8a6740"/><stop offset="1" stop-color="#5e4529"/></radialGradient>' +
      '<radialGradient id="gFloor" cx="0.5" cy="0.5" r="0.5"><stop offset="0" stop-color="#000" stop-opacity="0.55"/><stop offset="1" stop-color="#000" stop-opacity="0"/></radialGradient>' +
      '<pattern id="hatch" width="6" height="6" patternUnits="userSpaceOnUse" patternTransform="rotate(45)"><rect width="6" height="6" fill="#8796a5"/><line x1="0" y1="0" x2="0" y2="6" stroke="#4b5866" stroke-width="2"/></pattern>' +
      '<filter id="fShadow" x="-20%" y="-20%" width="140%" height="140%"><feDropShadow dx="3" dy="5" stdDeviation="3" flood-color="#000" flood-opacity="0.55"/></filter>' +
      '<filter id="fGlow" x="-50%" y="-50%" width="200%" height="200%"><feGaussianBlur stdDeviation="2.5"/></filter>' +
      '</defs>' +
      '<g id="m3root">' +
      '<g id="m3floor"></g><g id="m3back"></g><g id="m3gasBack"></g><g id="m3nozzle"></g><g id="m3mid"></g>' +
      '<g id="m3particles"></g><g id="m3gasFront"></g><g id="m3front"></g>' +
      '</g><g id="m3labels"></g>';
    container.appendChild(svg);
    ['m3root', 'm3floor', 'm3back', 'm3gasBack', 'm3nozzle', 'm3mid', 'm3particles', 'm3gasFront', 'm3front', 'm3labels'].forEach(function (id) {
      layers[id] = svg.querySelector('#' + id);
    });
    // Pool partikel tetap (tidak dibuat ulang tiap frame)
    for (var i = 0; i < MAX_PARTICLES; i++) {
      var c = document.createElementNS(NS, 'circle');
      c.setAttribute('r', '2.6'); c.setAttribute('visibility', 'hidden');
      layers.m3particles.appendChild(c); particleEls.push(c);
    }
    tooltipEl = document.createElement('div');
    tooltipEl.className = 'm3-tooltip';
    container.appendChild(tooltipEl);
    bindInteraction();
    applyView();
  }

  /* ---------------- Interaksi: zoom, pan, hover ---------------- */

  function applyView() {
    svg.setAttribute('viewBox', view.x + ' ' + view.y + ' ' + view.w + ' ' + view.h);
  }
  function bindInteraction() {
    var drag = null;
    svg.addEventListener('wheel', function (e) {
      e.preventDefault();
      var r = svg.getBoundingClientRect();
      var mx = view.x + (e.clientX - r.left) / r.width * view.w;
      var my = view.y + (e.clientY - r.top) / r.height * view.h;
      var f = e.deltaY > 0 ? 1.12 : 1 / 1.12;
      var nw = Math.max(250, Math.min(2000, view.w * f));
      f = nw / view.w;
      view.x = mx - (mx - view.x) * f; view.y = my - (my - view.y) * f;
      view.w = nw; view.h = view.h * f;
      applyView();
    }, { passive: false });
    svg.addEventListener('pointerdown', function (e) {
      drag = { x: e.clientX, y: e.clientY, vx: view.x, vy: view.y, rot: e.shiftKey, th: theta };
      svg.setPointerCapture(e.pointerId);
      svg.classList.add('dragging');
    });
    svg.addEventListener('pointermove', function (e) {
      var r = containerEl.getBoundingClientRect();
      lastMouse = { x: e.clientX - r.left, y: e.clientY - r.top };
      if (drag) {
        var rr = svg.getBoundingClientRect();
        if (drag.rot) {
          // Shift + seret = putar tampilan
          setAngle((drag.th / deg) + (e.clientX - drag.x) * 0.5, true);
        } else {
          view.x = drag.vx - (e.clientX - drag.x) / rr.width * view.w;
          view.y = drag.vy - (e.clientY - drag.y) / rr.height * view.h;
          applyView();
        }
        return;
      }
      var t = e.target.closest ? e.target.closest('[data-comp]') : null;
      hoverComp = t ? t.getAttribute('data-comp') : null;
      updateTooltip();
    });
    svg.addEventListener('pointerup', function () { drag = null; svg.classList.remove('dragging'); });
    svg.addEventListener('pointerleave', function () { hoverComp = null; updateTooltip(); });
  }

  function resetView() { view = { x: 0, y: 40, w: 1000, h: 780 }; applyView(); }
  function zoom(f) {
    var cx = view.x + view.w / 2, cy = view.y + view.h / 2;
    view.w = Math.max(250, Math.min(2000, view.w * f)); view.h = view.w * 0.78;
    view.x = cx - view.w / 2; view.y = cy - view.h / 2; applyView();
  }

  var onAngleChange = null;
  function setAngle(d, notify) {
    d = ((d % 360) + 360) % 360;
    theta = d * deg;
    if (notify && onAngleChange) onAngleChange(d);
  }
  function getAngle() { return theta / deg; }

  /* ---------------- Tooltip ---------------- */

  function fmt(v, d) { return VRM.fmt ? VRM.fmt(v, d) : (Number.isFinite(v) ? v.toFixed(d) : '–'); }
  function tooltipText(comp) {
    if (!st) return '';
    var mill = VRM.CONFIG.mill;
    var m = /^roller(\d)$/.exec(comp || '');
    if (m) return '<b>Grinding roller ' + (+m[1] + 1) + '</b>Tekanan hidrolik: ' + fmt(st.pressure, 0) + ' bar<br>Tebal bed di bawah roller: ' + fmt(st.bed, 0) + ' mm<br>Lift roller: ' + fmt(st.bed, 0) + ' mm<br>Getaran: ' + fmt(st.vib, 1) + ' mm/s';
    m = /^hyd(\d)$/.exec(comp || '');
    if (m) return '<b>Silinder hidrolik ' + (+m[1] + 1) + '</b>Tekanan: ' + fmt(st.pressure, 0) + ' bar<br>Nominal: ' + fmt(mill.nominalPressure, 0) + ' bar';
    switch (comp) {
      case 'table': return '<b>Meja gilas</b>Kecepatan: ' + fmt(st.running ? mill.tableRpm : 0, 1) + ' rpm<br>Daya motor mill: ' + fmt(st.pMill, 0) + ' kW (' + fmt(st.motorLoad * 100, 0) + ' %)<br>Diameter: ' + fmt(mill.tableDiameter, 1) + ' m';
      case 'bed': return '<b>Bed material</b>Tebal bed: ' + fmt(st.bed, 0) + ' mm<br>Circulating load: ' + fmt(st.cl * 100, 0) + ' %<br>Load ratio: ' + fmt(st.loadRatio, 2);
      case 'dam': return '<b>Dam ring</b>Tinggi: ' + fmt(st.dam, 0) + ' mm<br>Tebal bed: ' + fmt(st.bed, 0) + ' mm';
      case 'nozzle': return '<b>Nozzle / louvre ring</b>Kecepatan gas: ' + fmt(st.vNozzle, 0) + ' m/s<br>Suhu gas: ' + fmt(st.tIn, 0) + ' °C' + (st.vNozzle < 35 ? '<br><span class="warn">Kecepatan rendah → spillage material</span>' : '');
      case 'separator': return '<b>Separator rotor</b>Kecepatan: ' + fmt(st.rotorRpm, 0) + ' rpm (' + fmt(st.sepRpm, 1) + ' %)<br>Cut size d50 ≈ ' + fmt(st.cutSize, 0) + ' µm<br>R90: ' + fmt(st.r90, 1) + ' % · R200: ' + fmt(st.r200, 2) + ' %';
      case 'casing': return '<b>Rumah mill</b>DP mill: ' + fmt(st.dp, 1) + ' mbar<br>Getaran: ' + fmt(st.vib, 1) + ' mm/s';
      case 'inlet': return '<b>Inlet hot gas</b>Suhu: ' + fmt(st.tIn, 0) + ' °C<br>Aliran gas: ' + fmt(st.gas, 0) + ' kg/s<br>Fan: ' + fmt(st.fan, 1) + ' %';
      case 'outlet': return '<b>Outlet ke cyclone/filter & mill fan</b>Suhu outlet: ' + fmt(st.tOut, 1) + ' °C<br>Aliran: ' + fmt(st.gasAm3h, 0) + ' Am³/h<br>Moisture raw meal: ' + fmt(st.moistOut, 2) + ' %';
      case 'feed': return '<b>Feed chute & rotary feeder</b>Feed masuk mill: ' + fmt(st.feed, 0) + ' t/h<br>Moisture umpan: ' + fmt(st.moistFeed, 1) + ' %';
      case 'gear': return '<b>Gearbox & motor mill</b>Daya: ' + fmt(st.pMill, 0) + ' / ' + fmt(mill.motorPower, 0) + ' kW';
    }
    return '';
  }
  function updateTooltip() {
    var txt = hoverComp ? tooltipText(hoverComp) : '';
    if (!txt) { tooltipEl.style.display = 'none'; return; }
    tooltipEl.innerHTML = txt;
    tooltipEl.style.display = 'block';
    var cw = containerEl.clientWidth;
    var x = lastMouse.x + 16, y = lastMouse.y + 12;
    if (x + 240 > cw) x = lastMouse.x - 250;
    tooltipEl.style.left = x + 'px'; tooltipEl.style.top = y + 'px';
  }

  /* ---------------- Partikel ---------------- */

  function updateParticles(dt, g) {
    var running = st && st.running;
    var feed = st ? st.feed : 0;
    var bedZ = g.tableTop + (st ? st.bed : 70) / 1000 * VIS_BED;
    var gasV = 2.2 * (st ? Math.max(0.2, st.gasRatio) : 1);
    var cl = st ? st.cl : 4;
    var pAccept = 1 / (1 + 0.35 * Math.max(cl, 0));
    var spill = st && st.vNozzle < 35;
    var wTable = running ? VRM.CONFIG.mill.tableRpm / 60 * 2 * Math.PI * 0.35 : 0;

    // Spawn baru sebanding feed
    if (running && feed > 0) {
      anim.spawnAcc += dt * 28 * feed / 400;
      while (anim.spawnAcc >= 1 && particles.length < MAX_PARTICLES) {
        anim.spawnAcc -= 1;
        particles.push({ s: 'fall', r: 0.75 * g.k + Math.random() * 0.2, a: AZ.feed + (Math.random() - 0.5) * 0.15, z: 2.3, vz: 0, j: Math.random() });
      }
      if (anim.spawnAcc > 3) anim.spawnAcc = 0;
    }
    for (var i = particles.length - 1; i >= 0; i--) {
      var p = particles[i];
      switch (p.s) {
        case 'fall':
          p.vz -= 9 * dt; p.z += p.vz * dt; p.r = Math.max(0.15, p.r - 0.5 * dt);
          if (p.z <= bedZ) { p.z = bedZ; p.s = 'table'; p.r = 0.3 + Math.random() * 0.4; p.a += Math.random() * 6.28; }
          break;
        case 'table':
          p.a += wTable * dt; p.z = bedZ;
          if (running) p.r += (0.5 + p.r * 0.45) * dt;
          if (p.r > g.Rt) {
            if (spill && Math.random() < 0.25) { p.s = 'spill'; p.r = g.Rt + 0.3; p.vz = 0; }
            else { p.s = 'lift'; p.r = g.Rt + 0.25 + Math.random() * 0.25; }
          }
          break;
        case 'spill':
          p.vz -= 6 * dt; p.z += p.vz * dt;
          if (p.z < -0.3) { particles.splice(i, 1); continue; }
          break;
        case 'lift':
          p.z += gasV * (0.8 + p.j * 0.5) * dt; p.a += 0.5 * dt;
          if (p.z > 3.6) p.r = Math.min(g.Rt + 0.95, p.r + 0.6 * dt);
          if (gasV < 0.6 && p.z > 2) { p.s = 'reject'; }
          if (p.z > 4.8) p.s = (Math.random() < pAccept) ? 'fine' : 'reject';
          break;
        case 'fine':
          p.r = Math.max(g.rotorR * 0.4, p.r - 1.6 * dt); p.z += gasV * 0.9 * dt;
          if (p.z > 7.4) { p.s = 'exit'; p.a = AZ.outlet; p.r = g.Rt * 0.3; }
          break;
        case 'exit':
          p.r += 3.5 * dt; p.z += 0.25 * dt;
          if (p.r > g.Rt + 3.4) { particles.splice(i, 1); continue; }
          break;
        case 'reject':
          // Kembali ke meja lewat grit cone
          p.r = Math.max(0.35, p.r - 1.4 * dt); p.z -= (p.r > 1.2 ? 0.8 : 2.4) * dt; p.a += 0.3 * dt;
          if (p.z < 2.5) { p.s = 'fall'; p.vz = -1; }
          break;
      }
    }
    // Tulis ke elemen SVG
    var colors = { fall: '#a07850', table: '#8f6a43', lift: '#cfae7a', fine: '#f2e6c9', exit: '#f2e6c9', reject: '#c0915a', spill: '#7a5a3a' };
    for (var j = 0; j < MAX_PARTICLES; j++) {
      var el = particleEls[j];
      if (j < particles.length) {
        var q = particles[j], v = P(cyl(q.r, q.a, q.z));
        el.setAttribute('cx', f1(v.x)); el.setAttribute('cy', f1(v.y));
        el.setAttribute('fill', colors[q.s]);
        el.setAttribute('visibility', 'visible');
      } else if (el.getAttribute('visibility') !== 'hidden') {
        el.setAttribute('visibility', 'hidden');
      }
    }
  }

  /* ---------------- Gambar per frame ---------------- */

  function render(dt) {
    if (!svg) return;
    var g = geo();
    gid = 0; defsBuf = [];
    // Lapisan yang jarang berubah (lantai, casing, komponen luar, label) dibangun ulang
    // tiap 4 frame atau saat sudut pandang berubah → hemat CPU
    var full = (frameNo++ % 4 === 0) || theta !== lastTheta || dt === 0;
    lastTheta = theta;
    if (full) { gidE = 0; defsExt = []; }
    var vib = st ? st.vib : 2;
    var running = st ? st.running : true;
    var bed = st ? st.bed : 70, dam = st ? st.dam : 150;
    var bedZ = g.tableTop + bed / 1000 * VIS_BED;
    var damZ = g.tableTop + dam / 1000 * VIS_BED;
    var tIn = st ? st.tIn : 220, tOut = st ? st.tOut : 90;
    var vibK = Math.max(0, Math.min(1, (vib - 4) / 6));
    var steel = mix('#5f6b78', '#b8322a', vibK);

    // --- Animasi sudut ---
    var mill = VRM.CONFIG.mill;
    if (running) anim.table += mill.tableRpm / 60 * 2 * Math.PI * 0.35 * dt;
    anim.rotor += (st ? st.rotorRpm : 70) / 60 * 2 * Math.PI * 0.25 * dt;
    anim.gas += 60 * (st ? Math.max(0.15, st.gasRatio) : 1) * dt;
    if (running && st && st.feed > 0) anim.feeder += 2.2 * dt;

    // --- Getaran: mill bergoyang ---
    var amp = Math.max(0, vib - 3) * 0.7;
    anim.shakeX = (Math.random() - 0.5) * amp; anim.shakeY = (Math.random() - 0.5) * amp * 0.6;
    layers.m3root.setAttribute('transform', 'translate(' + f1(anim.shakeX) + ' ' + f1(anim.shakeY) + ')');

    // ============ Lantai ============
    if (full) {
      layers.m3floor.innerHTML = ellipseEl(-1.8, g.Rt + 4.6, 'fill="#1b2127" stroke="#2c353f" stroke-width="1"') +
                                 ellipseEl(-1.8, g.Rt + 3.2, 'fill="url(#gFloor)"');
    }

    // ============ Komponen luar (dipisah depan/belakang) ============
    var ext = [];   // {d, svg}
    var R = g.Rt;
    if (full) {
      // Hot gas inlet duct
      var pin0 = cyl(R + 4.0, AZ.inlet, -0.15), pin1 = cyl(R + 0.4, AZ.inlet, -0.15);
      ext.push({ d: horizDepth(cyl(R + 2.2, AZ.inlet, 0)), svg: tube(pin0, pin1, 0.72, 0.72, { ext: true, color: mix('#6b5446', tempColor(tIn), 0.35), comp: 'inlet' }) });
      // Outlet duct ke cyclone/filter
      var po0 = cyl(R * 0.5, AZ.outlet, 8.0), po1 = cyl(R + 3.8, AZ.outlet, 8.7);
      ext.push({ d: horizDepth(cyl(R + 2.0, AZ.outlet, 0)), svg: tube(po0, po1, 0.85, 0.85, { ext: true, color: mix('#5d6773', tempColor(tOut), 0.25), comp: 'outlet' }) });
      // Motor mill (horizontal) di samping gearbox
      var pm0 = cyl(1.9 * g.k, AZ.motor, -1.1), pm1 = cyl(R + 2.2, AZ.motor, -1.1);
      ext.push({ d: horizDepth(cyl(R + 1, AZ.motor, 0)), svg: tube(pm0, pm1, 0.62, 0.62, { ext: true, color: '#3e6a8c', comp: 'gear' }) });
    }
    // Feed chute miring + rotary feeder + hopper.
    // Chute dipotong di dinding casing: bagian luar = komponen luar,
    // bagian dalam digambar di lapisan interior (sebelum roller).
    var pf0 = cyl(R + 2.7, AZ.feed, 8.6), pf1 = cyl(0.75 * g.k, AZ.feed, 2.3);
    var tWall = (R + 2.7 - (R + 1.15)) / (R + 2.7 - 0.75 * g.k);
    var pfW = add(pf0, mul(sub(pf1, pf0), tWall));
    var tang = [-Math.sin(AZ.feed), Math.cos(AZ.feed), 0];
    if (full) {
      var feedSvg = tube(pf0, pfW, 0.34, 0.34, { ext: true, color: '#7c6a55', comp: 'feed' }) +
        tube(add(pf0, mul(tang, -0.55)), add(pf0, mul(tang, 0.55)), 0.55, 0.55, { ext: true, color: '#a07f3e', comp: 'feed', spin: anim.feeder }) +
        tube(add(pf0, [0, 0, 0.5]), add(pf0, [0, 0, 1.8]), 0.38, 0.5, { ext: true, color: '#6d6153', comp: 'feed' });
      ext.push({ d: horizDepth(cyl(R + 2, AZ.feed, 0)), svg: feedSvg });
    }
    var feedInner = tube(pfW, pf1, 0.34, 0.34, { color: '#7c6a55', comp: 'feed', cap: true });

    // Roller, lengan, silinder hidrolik
    var rollers = [];
    var t15 = 15 * deg;
    for (var i = 0; i < g.nRollers; i++) {
      var a = Math.PI / 4 + i * 2 * Math.PI / g.nRollers;
      var radial = [Math.cos(a), Math.sin(a), 0];
      var tg = [-Math.sin(a), Math.cos(a), 0];
      var u = norm([radial[0] * Math.cos(t15), radial[1] * Math.cos(t15), Math.sin(t15)]);
      var nrm = norm(cross(tg, u));              // tegak lurus sumbu dalam bidang radial-vertikal
      if (nrm[2] < 0) nrm = mul(nrm, -1);
      var jitter = (Math.random() - 0.5) * Math.max(0, vib - 2.5) * 0.012;
      var contact = cyl(g.contactR, a, bedZ + jitter);
      var C = add(contact, mul(nrm, g.rollerR));
      var pIn = add(C, mul(u, -g.rollerW / 2)), pOut = add(C, mul(u, g.rollerW / 2));
      var rIn = g.rollerR - g.rollerW / 2 * Math.tan(t15), rOut = g.rollerR + g.rollerW / 2 * Math.tan(t15);
      var spin = -anim.table * g.contactR / g.rollerR;
      var lift = (bed - 70) / 1000 * VIS_BED;
      var pivot = cyl(R + 1.0, a, 1.85);
      var lever = cyl(R + 1.6, a, 0.55 + lift * 1.3);
      var hydBot = cyl(R + 1.6, a, -1.7), hydTop = cyl(R + 1.6, a, -0.25);
      var pLevel = st ? (st.pressure > 125 ? 'alarm' : st.pressure > 112 ? 'warn' : 'ok') : 'ok';
      var armSvg = tube(pOut, pivot, 0.28, 0.24, { color: '#58636f', cap: false, comp: 'roller' + i }) +
                   tube(pivot, lever, 0.22, 0.22, { color: '#58636f', comp: 'hyd' + i });
      // Silinder hidrolik di luar casing → masuk daftar ext
      if (full) {
        var hydSvg = tube(hydBot, hydTop, 0.3, 0.3, { ext: true, color: mix('#4d5a66', LEVEL_COLOR[pLevel], 0.35), comp: 'hyd' + i }) +
                     tube(hydTop, lever, 0.12, 0.12, { ext: true, color: '#c9d1d9', comp: 'hyd' + i });
        ext.push({ d: horizDepth(hydTop), svg: hydSvg });
      }
      rollers.push({
        d: P(C).d,
        svg: armSvg + tube(pIn, pOut, rIn, rOut, { color: '#6b7682', comp: 'roller' + i, spin: spin })
      });
    }

    ext.sort(function (p, q) { return p.d - q.d; });
    var backExt = '', frontExt = '';
    var dCut = 0;   // bidang potong cutaway melewati sumbu mill
    ext.forEach(function (e) { if (e.d < dCut) backExt += e.svg; else frontExt += e.svg; });

    // ============ Lapisan belakang: komponen luar belakang + casing dalam ============
    if (full) {
    var back = '<defs>' + defsExt.join('') + '</defs>' + backExt;
    // Gearbox (di bawah meja)
    back += '<g data-comp="gear"><path d="' + frontBand(-1.8, 2.1 * g.k, -0.4, 2.1 * g.k) + '" fill="url(#gGear)" stroke="#0e151b"/>' +
            ellipseEl(-0.4, 2.1 * g.k, 'fill="#3b5468" stroke="#0e151b"') + '</g>';
    // Permukaan dalam casing bagian belakang (cutaway)
    var cs = g.casing;
    back += '<g data-comp="casing">';
    for (var s = 0; s < cs.length - 1; s++) {
      var bp = backBand(cs[s][0], cs[s][1], cs[s + 1][0], cs[s + 1][1]);
      back += '<path d="' + bp + '" fill="url(#gInner)" stroke="#0c1116" stroke-width="0.8"/>';
      if (vibK > 0) back += '<path d="' + bp + '" fill="#ff2a2a" opacity="' + f1(vibK * 0.35 * 100) / 100 + '"/>';
    }
    // Rangka/rib horizontal pada dinding dalam
    [1.6, 2.6, 5.8].forEach(function (z) {
      var r = z < 3.6 ? R + 0.6 : R + 1.15;
      back += '<path d="' + halfArc(z, r, true) + '" fill="none" stroke="#45515e" stroke-width="1.2" opacity="0.7"/>';
    });
    // Penampang potong dinding (kiri & kanan) — arsiran
    ['L', 'R'].forEach(function (side) {
      var sg = side === 'L' ? -1 : 1, pts1 = [], pts2 = [];
      cs.forEach(function (c) {
        var y = CY - c[0] * S * COS_E;
        pts1.push({ x: CX + sg * c[1] * S, y: y });
        pts2.push({ x: CX + sg * (c[1] + 0.14) * S, y: y });
      });
      var poly = pts1.concat(pts2.reverse());
      back += '<path d="' + polyPath(poly) + '" fill="url(#hatch)" stroke="' + steel + '" stroke-width="1"/>';
    });
    // Tutup atas casing (cincin) & motor separator
    back += ellipseEl(8.6, R * 0.55, 'fill="' + shade(steel, -0.2) + '" stroke="#11181f"');
    back += '</g>';
    layers.m3back.innerHTML = back;
    }   // akhir if (full) lapisan belakang
    var cs = g.casing;

    // ============ Gas (belakang & depan) ============
    var gasBack = '', gasFront = '';
    var cIn = tempColor(tIn), cMid = tempColor(tIn * 0.45 + tOut * 0.55), cOut = tempColor(tOut);
    var dash = 'stroke-dasharray="9 13" stroke-dashoffset="' + f1(-anim.gas) + '"';
    function gasLine(pts, color, w, op) {
      var pp = pts.map(P);
      var d = 'M' + pp.map(function (p) { return f1(p.x) + ' ' + f1(p.y); }).join(' L');
      var last = pp[pp.length - 1], prev = pp[pp.length - 2];
      var ang = Math.atan2(last.y - prev.y, last.x - prev.x);
      var ah = 7;
      var tri = 'M' + f1(last.x + Math.cos(ang) * ah) + ' ' + f1(last.y + Math.sin(ang) * ah) +
        ' L' + f1(last.x + Math.cos(ang + 2.5) * ah) + ' ' + f1(last.y + Math.sin(ang + 2.5) * ah) +
        ' L' + f1(last.x + Math.cos(ang - 2.5) * ah) + ' ' + f1(last.y + Math.sin(ang - 2.5) * ah) + ' Z';
      return '<g opacity="' + op + '"><path d="' + d + '" fill="none" stroke="' + color + '" stroke-width="' + (w + 4) + '" opacity="0.18" stroke-linecap="round"/>' +
        '<path d="' + d + '" fill="none" stroke="' + color + '" stroke-width="' + w + '" ' + dash + ' stroke-linecap="round"/>' +
        '<path d="' + tri + '" fill="' + color + '"/></g>';
    }
    // Inlet
    var inletGas = gasLine([cyl(R + 3.9, AZ.inlet, -0.15), cyl(R + 0.9, AZ.inlet, -0.15), cyl(R + 0.35, AZ.inlet, 0.35)], cIn, 3, 1);
    if (horizDepth(cyl(R + 2, AZ.inlet, 0)) < dCut) gasBack += inletGas; else gasFront += inletGas;
    // Riser di annulus (6 azimut)
    for (var kz = 0; kz < 6; kz++) {
      var az = kz * Math.PI / 3 + 0.3;
      var riser = gasLine([cyl(R + 0.3, az, 0.6), cyl(R + 0.45, az, 3.4), cyl(R + 0.9, az, 4.6), cyl(g.rotorR + 0.35, az, 5.6)],
                          mix(cIn, cMid, 0.5), 2.2, 0.9);
      if (horizDepth(cyl(R, az, 0)) < dCut) gasBack += riser; else gasFront += riser.replace('opacity="0.9"', 'opacity="0.55"');
    }
    // Lewat rotor ke outlet
    gasFront += gasLine([cyl(g.rotorR * 0.6, AZ.outlet + 1.2, 6.2), cyl(0.3, AZ.outlet, 7.3), cyl(R * 0.5, AZ.outlet, 8.0), cyl(R + 3.9, AZ.outlet, 8.7)], cOut, 3, 0.95);
    layers.m3gasBack.innerHTML = gasBack;
    layers.m3gasFront.innerHTML = gasFront;

    // ============ Lapisan tengah: meja, bed, dam, roller, separator ============
    var mid = '';
    // Nozzle ring (annulus di sekeliling meja) — statis, lapisan sendiri, dibangun ulang saat full
    if (full) {
    var noz = '';
    var eo = ell(g.tableTop, R + 0.55), ei = ell(g.tableTop, R);
    var nozzleCol = mix('#2a2f36', tempColor(tIn), 0.45);
    noz += '<g data-comp="nozzle"><path fill-rule="evenodd" d="M' + f1(eo.cx - eo.rx) + ' ' + f1(eo.cy) + ' a' + f1(eo.rx) + ' ' + f1(eo.ry) + ' 0 1 0 ' + f1(2 * eo.rx) + ' 0 a' + f1(eo.rx) + ' ' + f1(eo.ry) + ' 0 1 0 ' + f1(-2 * eo.rx) + ' 0 Z M' +
      f1(ei.cx - ei.rx) + ' ' + f1(ei.cy) + ' a' + f1(ei.rx) + ' ' + f1(ei.ry) + ' 0 1 0 ' + f1(2 * ei.rx) + ' 0 a' + f1(ei.rx) + ' ' + f1(ei.ry) + ' 0 1 0 ' + f1(-2 * ei.rx) + ' 0 Z" fill="' + nozzleCol + '" stroke="#11161c"/>';
    for (var lv = 0; lv < 48; lv++) {
      var la = lv / 48 * Math.PI * 2;
      var l0 = P(cyl(R + 0.05, la, g.tableTop)), l1 = P(cyl(R + 0.5, la + 0.05, g.tableTop));
      noz += '<line x1="' + f1(l0.x) + '" y1="' + f1(l0.y) + '" x2="' + f1(l1.x) + '" y2="' + f1(l1.y) + '" stroke="#12171d" stroke-width="1.3"/>';
    }
    noz += ellipseEl(g.tableTop, R + 0.55, 'fill="' + tempColor(tIn) + '" opacity="0.12" filter="url(#fGlow)"') + '</g>';
    layers.m3nozzle.innerHTML = noz;
    }   // akhir if (full) nozzle ring
    // Sisi meja + tanda putar
    mid += '<g data-comp="table"><path d="' + frontBand(-0.4, R, g.tableTop, R) + '" fill="url(#gTable)" stroke="#0f141a"/>';
    for (var tm = 0; tm < 16; tm++) {
      var ta = anim.table + tm * Math.PI / 8;
      var tp0 = proj(R * Math.cos(ta), R * Math.sin(ta), -0.4);
      if (tp0.d < P([0, 0, -0.4]).d) continue;          // hanya sisi depan
      var tp1 = proj(R * Math.cos(ta), R * Math.sin(ta), g.tableTop);
      mid += '<line x1="' + f1(tp0.x) + '" y1="' + f1(tp0.y) + '" x2="' + f1(tp1.x) + '" y2="' + f1(tp1.y) + '" stroke="#2a323b" stroke-width="2"/>';
    }
    mid += '</g>';
    // Dam ring (bagian belakang, sisi dalam)
    var damCol = '#8a96a3';
    mid += '<path data-comp="dam" d="' + backBand(g.tableTop, R, damZ, R) + '" fill="' + shade(damCol, -0.45) + '" stroke="#1a2027"/>';
    // Bed material + alur radial berputar + jejak roller
    mid += '<g data-comp="bed">' + ellipseEl(bedZ, R - 0.03, 'fill="url(#gBed)" stroke="#4a3620"');
    for (var bg = 0; bg < 12; bg++) {
      var ba = anim.table + bg * Math.PI / 6;
      var b0 = P(cyl(0.9 * g.k, ba, bedZ)), b1 = P(cyl(R - 0.1, ba + 0.25, bedZ));
      mid += '<line x1="' + f1(b0.x) + '" y1="' + f1(b0.y) + '" x2="' + f1(b1.x) + '" y2="' + f1(b1.y) + '" stroke="#6b4f30" stroke-width="1.2" opacity="0.7"/>';
    }
    mid += ellipseEl(bedZ, g.contactR, 'fill="none" stroke="#c9a678" stroke-width="' + f1(g.rollerW * S * 0.5) + '" opacity="0.25"');
    // Kerucut tengah meja
    mid += '<path d="' + frontBand(bedZ, 0.75 * g.k, bedZ + 0.35, 0.25) + '" fill="#6d5236"/>' + ellipseEl(bedZ + 0.35, 0.25, 'fill="#8a6a45"') + '</g>';
    // Dam ring (bagian depan, sisi luar) + bibir atas
    mid += '<g data-comp="dam"><path d="' + frontBand(g.tableTop, R, damZ, R) + '" fill="' + damCol + '" opacity="0.9" stroke="#1a2027"/>' +
           '<path d="' + halfArc(damZ, R, false) + '" fill="none" stroke="#c3ccd5" stroke-width="1.5"/></g>';
    // Bagian dalam feed chute (di dalam casing)
    mid += feedInner;
    // Roller, diurutkan dari jauh ke dekat
    rollers.sort(function (p, q) { return p.d - q.d; });
    mid += '<g filter="url(#fShadow)">' + rollers.map(function (r) { return r.svg; }).join('') + '</g>';

    // Grit cone (transparan) + separator rotor
    mid += '<g data-comp="separator">';
    mid += '<path d="' + backBand(2.4, 0.45, g.rotorZ0, g.rotorR + 0.2) + '" fill="#2b343e" opacity="0.55" stroke="#11171d"/>';
    // Bilah rotor: belakang redup, depan terang
    var nBl = 32, blBack = '', blFront = '';
    var dAxis = P([0, 0, (g.rotorZ0 + g.rotorZ1) / 2]).d;
    for (var bl = 0; bl < nBl; bl++) {
      var ra = anim.rotor + bl * Math.PI * 2 / nBl;
      var q0 = P(cyl(g.rotorR, ra, g.rotorZ0)), q1 = P(cyl(g.rotorR, ra, g.rotorZ1));
      var isFront = proj(Math.cos(ra), Math.sin(ra), 0).d > P([0, 0, 0]).d;
      var ln = '<line x1="' + f1(q0.x) + '" y1="' + f1(q0.y) + '" x2="' + f1(q1.x) + '" y2="' + f1(q1.y) + '" ';
      if (isFront) blFront += ln + 'stroke="#b9c4cf" stroke-width="2.2"/>';
      else blBack += ln + 'stroke="#56616d" stroke-width="1.6"/>';
    }
    mid += '<path d="' + backBand(g.rotorZ0, g.rotorR, g.rotorZ1, g.rotorR) + '" fill="#1d252e" opacity="0.8"/>';
    mid += blBack;
    mid += ellipseEl(g.rotorZ0, g.rotorR, 'fill="none" stroke="#8994a0" stroke-width="2.5"');
    // Poros rotor + motor separator di atas
    var sh0 = P([0, 0, g.rotorZ0]), sh1 = P([0, 0, 9.6]);
    mid += '<line x1="' + f1(sh0.x) + '" y1="' + f1(sh0.y) + '" x2="' + f1(sh1.x) + '" y2="' + f1(sh1.y) + '" stroke="#9aa5b1" stroke-width="5"/>';
    mid += blFront;
    mid += ellipseEl(g.rotorZ1, g.rotorR, 'fill="#3a4551" fill-opacity="0.65" stroke="#aab5c0" stroke-width="2.5"');
    mid += '<path d="' + frontBand(2.4, 0.45, g.rotorZ0, g.rotorR + 0.2) + '" fill="#47525e" opacity="0.28" stroke="#76828f" stroke-width="0.8"/>';
    mid += tube([0, 0, 8.6], [0, 0, 9.9], 0.55, 0.55, { color: '#3e6a8c', comp: 'separator', spin: anim.rotor });
    mid += '</g>';
    if (defsBuf.length) mid = '<defs>' + defsBuf.join('') + '</defs>' + mid;
    defsBuf = [];
    layers.m3mid.innerHTML = mid;

    // ============ Lapisan depan: komponen luar depan + casing hantu ============
    // (gradient komponen luar ada di <defs> lapisan belakang)
    if (full) {
    var front = frontExt;
    front += '<g data-comp="casing" opacity="0.9">';
    for (var s2 = 0; s2 < cs.length - 1; s2++) {
      front += '<path d="' + frontBand(cs[s2][0], cs[s2][1], cs[s2 + 1][0], cs[s2 + 1][1]) + '" fill="' + steel + '" fill-opacity="0.07" stroke="' + shade(steel, 0.3) + '" stroke-width="0.8" stroke-dasharray="5 5" pointer-events="none"/>';
    }
    // Garis tepi potongan (siluet)
    var silL = cs.map(function (c) { return { x: CX - c[1] * S, y: CY - c[0] * S * COS_E }; });
    var silR = cs.map(function (c) { return { x: CX + c[1] * S, y: CY - c[0] * S * COS_E }; });
    front += '<path d="M' + silL.map(function (p) { return f1(p.x) + ' ' + f1(p.y); }).join(' L') + '" fill="none" stroke="' + shade(steel, 0.45) + '" stroke-width="2.5"/>';
    front += '<path d="M' + silR.map(function (p) { return f1(p.x) + ' ' + f1(p.y); }).join(' L') + '" fill="none" stroke="' + shade(steel, 0.45) + '" stroke-width="2.5"/>';
    front += '</g>';
    layers.m3front.innerHTML = front;
    }   // akhir if (full) lapisan depan

    // ============ Partikel ============
    updateParticles(dt, g);

    // ============ Label ============
    if (full) renderLabels(g, bedZ, damZ);
    if (hoverComp) updateTooltip();
  }

  /* ---------------- Label callout dengan nilai live ---------------- */

  function renderLabels(g, bedZ, damZ) {
    if (!showLabels || !st) { layers.m3labels.innerHTML = ''; return; }
    var lv = st.levels || {};
    var R = g.Rt;
    var items = [
      { p: cyl(g.rotorR, -0.2 - theta, 6.6), t: 'Separator', v: fmt(st.rotorRpm, 0) + ' rpm · d50 ' + fmt(st.cutSize, 0) + ' µm', lvl: lv.r90 },
      { p: cyl(g.contactR, Math.PI / 4, bedZ + 0.9), t: 'Roller ×' + g.nRollers, v: fmt(st.pressure, 0) + ' bar', lvl: lv.pressure, rot: true },
      { p: cyl(R * 0.6, Math.PI / 2 - theta + 0.4, bedZ), t: 'Bed / dam ring', v: fmt(st.bed, 0) + ' / ' + fmt(st.dam, 0) + ' mm', lvl: lv.bed },
      { p: cyl(R, Math.PI / 2 - theta - 0.5, 0), t: 'Meja gilas', v: fmt(st.pMill, 0) + ' kW · ' + fmt(st.running ? VRM.CONFIG.mill.tableRpm : 0, 1) + ' rpm', lvl: lv.power },
      { p: cyl(R + 0.4, Math.PI / 2 - theta + 0.9, g.tableTop), t: 'Nozzle ring', v: fmt(st.vNozzle, 0) + ' m/s', lvl: st.vNozzle < 35 ? 'warn' : 'ok' },
      { p: cyl(R + 3.6, AZ.inlet, -0.15), t: 'Hot gas inlet', v: fmt(st.tIn, 0) + ' °C', lvl: 'ok', rot: true },
      { p: cyl(R + 3.5, AZ.outlet, 8.7), t: 'Outlet', v: fmt(st.tOut, 1) + ' °C · DP ' + fmt(st.dp, 1) + ' mbar', lvl: lv.tOut === 'ok' && lv.dp === 'ok' ? 'ok' : (lv.tOut === 'alarm' || lv.dp === 'alarm' ? 'alarm' : 'warn'), rot: true },
      { p: cyl(R + 2.7, AZ.feed, 9.6), t: 'Feed', v: fmt(st.feed, 0) + ' t/h', lvl: 'ok', rot: true },
      { p: [0, 0, 3.0], t: 'Getaran', v: fmt(st.vib, 1) + ' mm/s', lvl: lv.vib }
    ];
    var placed = { L: [], R: [] };
    items.forEach(function (it) {
      var s = P(it.p);
      it.sx = s.x + anim.shakeX; it.sy = s.y + anim.shakeY;
      it.side = it.sx < CX ? 'L' : 'R';
      placed[it.side].push(it);
    });
    var out = '';
    ['L', 'R'].forEach(function (side) {
      var arr = placed[side].sort(function (a, b) { return a.sy - b.sy; });
      var lastY = -1e9;
      arr.forEach(function (it) {
        var ly = Math.max(it.sy, lastY + 40);
        lastY = ly;
        var bx = side === 'L' ? 18 : 812, bw = 170;
        var col = LEVEL_COLOR[it.lvl || 'ok'];
        var ex = side === 'L' ? bx + bw : bx;
        out += '<path d="M' + f1(it.sx) + ' ' + f1(it.sy) + ' L' + f1(side === 'L' ? ex + 18 : ex - 18) + ' ' + f1(ly) + ' L' + f1(ex) + ' ' + f1(ly) + '" fill="none" stroke="#8fa3b8" stroke-width="0.8" opacity="0.6"/>';
        out += '<circle cx="' + f1(it.sx) + '" cy="' + f1(it.sy) + '" r="2.5" fill="#cfe3f7"/>';
        out += '<g transform="translate(' + bx + ' ' + f1(ly - 16) + ')"><rect width="' + bw + '" height="32" rx="4" fill="#0e151c" fill-opacity="0.88" stroke="' + col + '" stroke-width="1"/>' +
               '<rect width="4" height="32" rx="2" fill="' + col + '"/>' +
               '<text x="10" y="13" class="m3-lt">' + it.t + '</text><text x="10" y="27" class="m3-lv">' + it.v + '</text></g>';
      });
    });
    layers.m3labels.innerHTML = out;
  }

  /* ---------------- API publik ---------------- */

  function update(state, dt) {
    st = state;
    render(Math.min(dt, 0.1));
  }

  return {
    init: init, update: update, setAngle: setAngle, getAngle: getAngle,
    setLabels: function (b) { showLabels = !!b; },
    resetView: resetView, zoom: zoom, tempColor: tempColor,
    onAngle: function (fn) { onAngleChange = fn; },
    particleCount: function () { return particles.length; }
  };
})();
