/* =====================================================================
   ui.js — Antarmuka: kontrol, slider, KPI, grafik, tab, skenario,
           sustainability, kalibrasi, ekspor, dan loop utama
   ===================================================================== */

(function () {
  'use strict';
  var M = VRM.Model, Sim = VRM.Sim, cfg = VRM.CONFIG, fmt = VRM.fmt;
  var LIM = VRM.OPERATION_LIMITS;

  /* =================================================================
     1. Utilitas DOM & angka
     ================================================================= */

  function $(id) { return document.getElementById(id); }
  function esc(s) { return String(s).replace(/[&<>"']/g, function (c) { return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]; }); }

  // Parse angka format Indonesia ("1.234,5") maupun titik desimal ("1.5")
  function parseNum(s) {
    if (typeof s === 'number') return s;
    s = String(s).trim().replace(/\s/g, '');
    if (s.indexOf(',') >= 0) s = s.replace(/\./g, '').replace(',', '.');
    return parseFloat(s);
  }
  // Format untuk kotak input (tanpa pemisah ribuan)
  function inFmt(v, dec) {
    if (!Number.isFinite(v)) return '';
    return v.toLocaleString('id-ID', { maximumFractionDigits: dec === undefined ? 2 : dec, useGrouping: false });
  }
  function clamp(v, a, b) { return Math.min(b, Math.max(a, v)); }

  /**
   * Buat kotak input angka yang tervalidasi dan di-clamp.
   * onChange(v) dipanggil dengan nilai valid.
   */
  function makeNum(value, min, max, dec, onChange, cls) {
    var inp = document.createElement('input');
    inp.type = 'text'; inp.inputMode = 'decimal'; inp.className = 'num' + (cls ? ' ' + cls : '');
    inp.value = inFmt(value, dec);
    inp.addEventListener('change', function () {
      var v = parseNum(inp.value);
      if (!Number.isFinite(v)) {
        inp.classList.add('invalid');
        setTimeout(function () { inp.classList.remove('invalid'); }, 900);
        inp.value = inFmt(inp._last, dec);
        return;
      }
      v = clamp(v, min, max);
      inp._last = v;
      inp.value = inFmt(v, dec);
      onChange(v);
    });
    inp._last = value;
    return inp;
  }
  function labeled(text, input, unit, tip) {
    var l = document.createElement('label');
    l.innerHTML = '<span>' + text + (tip ? ' <span class="tip" tabindex="0" data-tip="' + esc(tip) + '">ⓘ</span>' : '') + '</span>';
    var w = document.createElement('span');
    w.appendChild(input);
    if (unit) { var u = document.createElement('span'); u.className = 'muted'; u.style.marginLeft = '4px'; u.textContent = unit; w.appendChild(u); }
    l.appendChild(w);
    return l;
  }
  function hms(t) {
    t = Math.max(0, Math.floor(t));
    var h = Math.floor(t / 3600), m = Math.floor(t / 60) % 60, s = t % 60;
    return [h, m, s].map(function (x) { return ('0' + x).slice(-2); }).join(':');
  }
  function download(name, text, mime) {
    var blob = new Blob([text], { type: mime || 'text/plain' });
    var a = document.createElement('a');
    a.href = URL.createObjectURL(blob); a.download = name;
    document.body.appendChild(a); a.click();
    setTimeout(function () { URL.revokeObjectURL(a.href); a.remove(); }, 500);
  }
  var LVL_ICON = { ok: '✓', warn: '!', alarm: '✕', info: 'i' };
  var LVL_TEXT = { ok: 'OK', warn: 'Waspada', alarm: 'Alarm', info: 'Info' };

  /* =================================================================
     2. Slider parameter operasi (sidebar)
     ================================================================= */

  var OP_KEYS = ['feed', 'pressure', 'dam', 'sepRpm', 'fan', 'tIn', 'tOutSP', 'dpSP', 'spray'];
  var OP_TIPS = {
    feed: 'Laju umpan basah dari weigh feeder. Masuk mill setelah delay belt (±45 s). Feed naik → bed lebih tebal, DP naik, kWh/t turun.',
    pressure: 'Tekanan hidrolik roller. Naik → gilas lebih kuat, produk lebih halus, bed lebih tipis, daya naik. Terlalu tinggi → getaran.',
    dam: 'Tinggi dam ring di tepi meja. Naik → bed lebih tebal & stabil, tetapi DP dan daya motor naik.',
    sepRpm: 'Kecepatan rotor separator (% dari rpm maks). Naik → cut size kecil → R90 turun; circulating load & DP naik.',
    fan: 'Kecepatan mill fan / bukaan damper. Gas naik → produk lebih kasar, DP naik, kapasitas pengeringan naik, daya fan naik. Mode Auto: diatur PID DP.',
    tIn: 'Suhu gas panas masuk mill (waste gas kiln / HGG). Naik → suhu outlet naik → moisture produk turun. Mode Auto: diatur PID suhu outlet.',
    tOutSP: 'Setpoint suhu outlet untuk PID (aktif di mode Auto). Umumnya 85–95 °C.',
    dpSP: 'Setpoint differential pressure mill untuk PID fan (aktif di mode Auto).',
    spray: 'Air disemprotkan ke bed untuk menstabilkan bed (mengurangi getaran). Menurunkan suhu outlet dan menambah beban panas.'
  };
  var DEC = { feed: 0, pressure: 0, dam: 0, sepRpm: 1, fan: 1, tIn: 0, tOutSP: 1, dpSP: 1, spray: 0 };
  var sliderEls = {};

  function opMax(k) { return k === 'tIn' ? Math.min(LIM.tIn.max, cfg.mill.maxGasInlet) : LIM[k].max; }

  function buildSliders() {
    var host = $('opSliders');
    host.innerHTML = '';
    OP_KEYS.forEach(function (k) {
      var L = LIM[k];
      var wrap = document.createElement('div');
      wrap.className = 'op';
      wrap.innerHTML = '<div class="op-head"><span class="lbl">' + L.label + '</span>' +
        (k === 'tIn' || k === 'fan' ? '<span class="pid-tag" hidden>PID</span>' : '') +
        '<span class="tip" tabindex="0" data-tip="' + esc(OP_TIPS[k]) + '">ⓘ</span></div>';
      var row = document.createElement('div'); row.className = 'op-row';
      var rng = document.createElement('input');
      rng.type = 'range'; rng.min = L.min; rng.max = opMax(k); rng.step = L.step; rng.value = Sim.ops[k];
      rng.setAttribute('aria-label', L.label);
      var num = makeNum(Sim.ops[k], L.min, opMax(k), DEC[k], function (v) { setOp(k, v); });
      var unit = document.createElement('span'); unit.className = 'unit'; unit.textContent = L.unit;
      rng.addEventListener('input', function () { setOp(k, parseFloat(rng.value)); });
      row.appendChild(rng); row.appendChild(num); row.appendChild(unit);
      wrap.appendChild(row);
      var lim = document.createElement('div'); lim.className = 'lim';
      lim.innerHTML = '<span>' + fmt(L.min, 0) + '</span><span class="lmax">' + fmt(opMax(k), 0) + '</span>';
      wrap.appendChild(lim);
      host.appendChild(wrap);
      sliderEls[k] = { wrap: wrap, rng: rng, num: num, lim: lim };
    });
    syncSliders(true);
  }

  function setOp(k, v) {
    v = clamp(v, LIM[k].min, opMax(k));
    var o = {}; o[k] = v;
    Sim.setOps(o);
    var e = sliderEls[k];
    e.rng.value = v;
    if (document.activeElement !== e.num) { e.num.value = inFmt(v, DEC[k]); e.num._last = v; }
  }

  // Sinkronkan tampilan slider dengan nilai ops (mis. saat PID mengubah tIn/fan)
  function syncSliders(force) {
    var auto = Sim.ops.autoMode;
    OP_KEYS.forEach(function (k) {
      var e = sliderEls[k]; if (!e) return;
      var mx = opMax(k);
      if (+e.rng.max !== mx) { e.rng.max = mx; e.lim.querySelector('.lmax').textContent = fmt(mx, 0); }
      var pidCtl = auto && (k === 'tIn' || k === 'fan');
      e.rng.disabled = pidCtl; e.num.disabled = pidCtl;
      e.wrap.classList.toggle('disabled', pidCtl);
      var tag = e.wrap.querySelector('.pid-tag'); if (tag) tag.hidden = !pidCtl;
      if (force || pidCtl || document.activeElement !== e.rng) {
        if (document.activeElement !== e.rng) e.rng.value = Sim.ops[k];
        if (document.activeElement !== e.num) { e.num.value = inFmt(Sim.ops[k], DEC[k]); e.num._last = Sim.ops[k]; }
      }
    });
  }

  /* =================================================================
     3. Header: play, reset, kecepatan, mode, start/stop
     ================================================================= */

  function bindHeader() {
    $('btnPlay').addEventListener('click', togglePlay);
    $('btnReset').addEventListener('click', function () {
      if (!window.confirm('Reset simulasi, material dan parameter operasi ke default?')) return;
      Sim.reset(false);
      buildSliders(); buildMaterialTable(); refreshChem(); setModeUI();
    });
    $('speedSeg').addEventListener('click', function (e) {
      var b = e.target.closest('button'); if (!b) return;
      Sim.settings.speed = +b.dataset.speed;
      Array.prototype.forEach.call(this.children, function (c) { c.classList.toggle('active', c === b); });
    });
    $('modeSeg').addEventListener('click', function (e) {
      var b = e.target.closest('button'); if (!b) return;
      Sim.setAuto(b.dataset.mode === 'auto');
      setModeUI();
    });
    $('btnMill').addEventListener('click', function () {
      if (Sim.state.running) Sim.stopMill(); else Sim.startMill();
      updateHeader(Sim.view());
    });
    $('btnCsv').addEventListener('click', exportCsv);
    $('btnPrint').addEventListener('click', printReport);
    $('btnOpDefault').addEventListener('click', function () {
      var d = VRM.DEFAULT_OPERATION;
      Sim.setOps({ feed: d.feed, pressure: d.pressure, dam: d.dam, sepRpm: d.sepRpm, fan: d.fan, tIn: d.tIn, tOutSP: d.tOutSP, dpSP: d.dpSP, spray: d.spray });
      syncSliders(true);
    });
    document.addEventListener('keydown', function (e) {
      if (e.code === 'Space' && !/INPUT|SELECT|TEXTAREA|BUTTON/.test(document.activeElement.tagName)) { e.preventDefault(); togglePlay(); }
    });
  }
  function togglePlay() {
    Sim.settings.playing = !Sim.settings.playing;
    $('btnPlay').textContent = Sim.settings.playing ? '⏸ Jeda' : '▶ Jalankan';
  }
  function setModeUI() {
    var auto = Sim.ops.autoMode;
    Array.prototype.forEach.call($('modeSeg').children, function (c) { c.classList.toggle('active', (c.dataset.mode === 'auto') === auto); });
    syncSliders(true);
  }
  function updateHeader(v) {
    $('simClock').textContent = hms(v.t);
    var hb = $('healthVal'); hb.textContent = v.health;
    hb.style.color = v.health >= 80 ? 'var(--ok)' : v.health >= 55 ? 'var(--warn)' : 'var(--alarm)';
    var bm = $('btnMill');
    bm.textContent = v.running ? '■ Stop mill' : '▶ Start mill';
    bm.className = 'btn ' + (v.running ? 'btn-danger' : 'btn-ok');
    var tb = $('tripBanner');
    if (!v.running) { tb.hidden = false; tb.textContent = 'MILL TRIP / STOP — ' + v.tripReason; }
    else tb.hidden = true;
  }

  /* =================================================================
     4. Tab
     ================================================================= */

  var activeTab = 'tab3d';
  function bindTabs() {
    $('tabs').addEventListener('click', function (e) {
      var b = e.target.closest('button'); if (!b) return;
      activeTab = b.dataset.tab;
      Array.prototype.forEach.call(this.children, function (c) { c.classList.toggle('active', c === b); });
      document.querySelectorAll('.tab').forEach(function (s) { s.classList.toggle('active', s.id === activeTab); });
      slowUpdate(true);
    });
  }

  /* =================================================================
     5. KPI
     ================================================================= */

  function kpiDefs(v) {
    var T = cfg.targets, A = cfg.alarm, lv = v.levels || {};
    var sm = function (x) { return Math.abs(x) < 0.005 ? 0 : x; };
    return {
      product: { l: 'Throughput', v: v.product, d: 0, u: 't/h', lvl: v.running ? 'ok' : 'alarm', s: 'desain ' + fmt(cfg.mill.designCapacity, 0) + ' t/h' },
      r90: { l: 'R90', v: v.r90, d: 1, u: '%', lvl: lv.r90, s: 'spec ≤ ' + fmt(T.r90, 1) + ' %', band: [0, 30, 0, T.r90] },
      r200: { l: 'R200', v: v.r200, d: 2, u: '%', lvl: lv.r200, s: 'spec ≤ ' + fmt(T.r200, 1) + ' %', band: [0, 5, 0, T.r200] },
      lsf: { l: 'LSF', v: v.lsf, d: 1, u: '', lvl: lv.lsf, s: 'target ' + fmt(T.lsf, 1) + ' ± ' + fmt(T.lsfTol, 1) + ' (Δ ' + fmt(sm(v.lsf - T.lsf), 1) + ')', band: [T.lsf - 3 * T.lsfTol, T.lsf + 3 * T.lsfTol, T.lsf - T.lsfTol, T.lsf + T.lsfTol] },
      sm: { l: 'SM', v: v.sm, d: 2, u: '', lvl: lv.sm, s: 'target ' + fmt(T.sm, 2) + ' ± ' + fmt(T.smTol, 2), band: [T.sm - 3 * T.smTol, T.sm + 3 * T.smTol, T.sm - T.smTol, T.sm + T.smTol] },
      am: { l: 'AM', v: v.am, d: 2, u: '', lvl: lv.am, s: 'target ' + fmt(T.am, 2) + ' ± ' + fmt(T.amTol, 2), band: [T.am - 3 * T.amTol, T.am + 3 * T.amTol, T.am - T.amTol, T.am + T.amTol] },
      moist: { l: 'Moisture raw meal', v: v.moistOut, d: 2, u: '%', lvl: lv.moist, s: 'maks ' + fmt(T.moist, 1) + ' %', band: [0, 2, 0, T.moist] },
      kwht: { l: 'Energi spesifik', v: v.kwht, d: 1, u: 'kWh/t', lvl: 'info', s: 'mill ' + fmt(v.product > 1 ? v.pMill / v.product : 0, 1) + ' · fan ' + fmt(v.product > 1 ? v.pFan / v.product : 0, 1) },
      dp: { l: 'DP mill', v: v.dp, d: 1, u: 'mbar', lvl: lv.dp, s: 'band ' + fmt(A.dpLow, 0) + '–' + fmt(A.dpHigh, 0), band: [20, 80, A.dpLow, A.dpHigh] },
      vib: { l: 'Getaran', v: v.vib, d: 1, u: 'mm/s', lvl: lv.vib, s: 'alarm ' + fmt(A.vibAlarm, 0) + ' · trip ' + fmt(A.vibTrip, 0), band: [0, 13, 0, A.vibWarn] },
      tOut: { l: 'Suhu outlet', v: v.tOut, d: 1, u: '°C', lvl: lv.tOut, s: 'SP ' + fmt(Sim.ops.tOutSP, 0) + ' · band ' + fmt(A.tOutLow, 0) + '–' + fmt(A.tOutHigh, 0), band: [60, 130, A.tOutLow, A.tOutHigh] },
      bed: { l: 'Tebal bed', v: v.bed, d: 0, u: 'mm', lvl: lv.bed, s: 'band ' + fmt(A.bedLow, 0) + '–' + fmt(A.bedHigh, 0), band: [0, 160, A.bedLow, A.bedHigh] },
      power: { l: 'Daya motor mill', v: v.pMill, d: 0, u: 'kW', lvl: lv.power, s: fmt(v.motorLoad * 100, 0) + ' % dari ' + fmt(cfg.mill.motorPower, 0) + ' kW', band: [0, cfg.mill.motorPower * 1.1, 0, cfg.mill.motorPower * A.powerHigh] },
      cl: { l: 'Circulating load', v: v.cl * 100, d: 0, u: '%', lvl: 'info', s: 'load ratio ' + fmt(v.loadRatio, 2) }
    };
  }
  function kpiHtml(k) {
    var lvl = k.lvl || 'ok';
    var band = '';
    if (k.band && Number.isFinite(k.v)) {
      var b = k.band, span = b[1] - b[0] || 1;
      var lo = clamp((b[2] - b[0]) / span * 100, 0, 100), hi = clamp((b[3] - b[0]) / span * 100, 0, 100);
      var pos = clamp((k.v - b[0]) / span * 100, 0, 100);
      band = '<div class="band" title="Pita = rentang target"><div class="b-tol" style="left:' + lo + '%;width:' + (hi - lo) + '%"></div><div class="b-mark" style="left:' + pos + '%"></div></div>';
    }
    return '<div class="kpi ' + lvl + '"><div class="k-lbl"><span>' + k.l + '</span><span class="st-ico st-' + lvl + '">' + LVL_ICON[lvl] + ' ' + LVL_TEXT[lvl] + '</span></div>' +
      '<div class="k-val">' + fmt(k.v, k.d) + '<span class="k-unit">' + k.u + '</span></div><div class="k-sub">' + k.s + '</div>' + band + '</div>';
  }
  function renderKpis(v) {
    var d = kpiDefs(v);
    $('kpiStrip').innerHTML = ['product', 'r90', 'r200', 'lsf', 'moist', 'kwht', 'dp', 'vib', 'tOut', 'bed'].map(function (k) { return kpiHtml(d[k]); }).join('');
    if (activeTab === 'tabQual') {
      $('kpiGrid').innerHTML = ['product', 'r90', 'r200', 'lsf', 'sm', 'am', 'moist', 'kwht', 'dp', 'vib', 'tOut', 'bed', 'power', 'cl'].map(function (k) { return kpiHtml(d[k]); }).join('');
    }
  }

  /* =================================================================
     6. Alarm, kesehatan, kesiapan kiln
     ================================================================= */

  function alarmListHtml(alarms, detailed) {
    var order = { alarm: 0, warn: 1, info: 2 };
    var list = (alarms || []).slice().sort(function (a, b) { return order[a.level] - order[b.level]; });
    if (!list.length) return '<li class="ok">✓ Tidak ada alarm — proses dalam batas normal.</li>';
    return list.map(function (a) {
      return '<li class="' + a.level + '"><div class="a-t">' + LVL_ICON[a.level] + ' ' + esc(a.title) + '</div>' +
        (detailed || a.level !== 'info' ? '<div class="a-h">' + esc(a.hint) + '</div>' : '') + '</li>';
    }).join('');
  }
  function kilnHtml(v) {
    var k = v.kiln || {}, T = cfg.targets;
    var c = k.ready ? 'var(--ok)' : 'var(--alarm)';
    function li(ok, txt) { return '<li><span class="st-' + (ok ? 'ok' : 'alarm') + '">' + (ok ? '✓' : '✕') + '</span> ' + txt + '</li>'; }
    return '<div class="ready"><span class="dot" style="background:' + c + '"></span>' + (k.ready ? 'SIAP diumpankan ke kiln' : 'BELUM SIAP') + '</div><ul class="checks">' +
      li(k.lsfStable, 'LSF stabil 10 menit (rata-rata ' + fmt(k.lsfMean, 1) + ', σ ' + fmt(k.lsfSd, 2) + ')') +
      li(k.r90, 'R90 ' + fmt(v.r90, 1) + ' % ≤ ' + fmt(T.r90, 1) + ' %') +
      li(k.r200, 'R200 ' + fmt(v.r200, 2) + ' % ≤ ' + fmt(T.r200, 1) + ' %') +
      li(k.moist, 'Moisture ' + fmt(v.moistOut, 2) + ' % ≤ ' + fmt(T.moist, 1) + ' %') +
      li(k.running, 'Mill beroperasi') + '</ul>';
  }
  function healthHtml(v) {
    var h = v.health, col = h >= 80 ? '#0ca30c' : h >= 55 ? '#fab219' : '#d03b3b';
    var r = 36, c = 2 * Math.PI * r, off = c * (1 - h / 100);
    var txt = h >= 80 ? 'Proses sehat' : h >= 55 ? 'Perlu perhatian' : 'Kondisi kritis';
    var nA = (v.alarms || []).filter(function (a) { return a.level === 'alarm'; }).length;
    var nW = (v.alarms || []).filter(function (a) { return a.level === 'warn'; }).length;
    return '<div class="health-big"><svg class="ring" viewBox="0 0 86 86"><circle cx="43" cy="43" r="' + r + '" fill="none" stroke="#1f2c38" stroke-width="9"/>' +
      '<circle cx="43" cy="43" r="' + r + '" fill="none" stroke="' + col + '" stroke-width="9" stroke-linecap="round" stroke-dasharray="' + c.toFixed(1) + '" stroke-dashoffset="' + off.toFixed(1) + '" transform="rotate(-90 43 43)"/></svg>' +
      '<div><div class="val" style="color:' + col + '">' + h + '</div><div>' + txt + '</div><div class="muted small">' + nA + ' alarm · ' + nW + ' waspada</div></div></div>' +
      '<p class="muted small">Skor = 100 − 15/alarm − 6/waspada − 2/info − penalti getaran.</p>';
  }

  /* =================================================================
     7. Gangguan
     ================================================================= */

  var DISTS = [
    { k: 'moistUp', t: 'Moisture feed naik (+3 % limestone & clay)' },
    { k: 'hardLS', t: 'Limestone mendadak keras (BWI +35 %)' },
    { k: 'wetClay', t: 'Clay lembap (+8 % H₂O)' },
    { k: 'feederTrip', t: 'Weigh feeder trip' },
    { k: 'gasDrop', t: 'Suhu sumber gas turun (−70 °C)' }
  ];
  function buildDisturb(hostId) {
    var host = $(hostId);
    host.innerHTML = '';
    DISTS.forEach(function (d) {
      var b = document.createElement('button');
      b.className = 'btn'; b.dataset.k = d.k; b.textContent = d.t;
      b.title = 'Klik untuk memicu, klik lagi untuk memulihkan';
      b.addEventListener('click', function () {
        Sim.disturb[d.k] = !Sim.disturb[d.k];
        syncDisturb();
      });
      host.appendChild(b);
    });
  }
  function syncDisturb() {
    document.querySelectorAll('.dist-grid .btn').forEach(function (b) { b.classList.toggle('on', !!Sim.disturb[b.dataset.k]); });
  }

  /* =================================================================
     8. Flowsheet 2D
     ================================================================= */

  var fsBuilt = false;
  function buildFlowsheet() {
    var bins = Sim.materials.map(function (m, i) {
      var x = 12 + i * 64;
      return '<path d="M' + x + ' 14 h52 l-12 40 h-28 z" class="fs-box"/><rect x="' + (x + 12) + '" y="56" width="28" height="8" fill="#2c3e50"/>' +
        '<text x="' + (x + 26) + '" y="80" text-anchor="middle" class="fs-t" id="fsBinN' + i + '"></text>' +
        '<text x="' + (x + 26) + '" y="95" text-anchor="middle" class="fs-v" id="fsBin' + i + '"></text>';
    }).join('');
    var svg = '<svg viewBox="0 0 1100 205" role="img" aria-label="Flowsheet proses">' + bins +
      '<path id="fsBelt" class="fs-flow" d="M12 112 H330 V60 H392" stroke="#a07850"/>' +
      '<text x="150" y="130" text-anchor="middle" class="fs-t">Weigh feeder → belt</text><text x="150" y="146" text-anchor="middle" class="fs-v" id="fsFeed"></text>' +
      '<rect x="392" y="22" width="150" height="118" rx="6" class="fs-box" id="fsMillBox"/>' +
      '<text x="467" y="42" text-anchor="middle" class="fs-t">VRM LM 59.42</text>' +
      '<text x="467" y="62" text-anchor="middle" class="fs-v" id="fsMill1"></text><text x="467" y="80" text-anchor="middle" class="fs-v" id="fsMill2"></text>' +
      '<text x="467" y="98" text-anchor="middle" class="fs-v" id="fsMill3"></text><text x="467" y="116" text-anchor="middle" class="fs-v" id="fsMill4"></text>' +
      '<rect x="392" y="166" width="150" height="34" rx="5" class="fs-box"/><text x="467" y="181" text-anchor="middle" class="fs-t">Hot gas (kiln / HGG)</text><text x="467" y="195" text-anchor="middle" class="fs-v" id="fsHot"></text>' +
      '<path id="fsHotLine" class="fs-flow" d="M467 166 V140"/>' +
      '<path id="fsGas1" class="fs-flow" d="M542 50 H612"/>' +
      '<rect x="612" y="22" width="140" height="72" rx="6" class="fs-box" id="fsFilterBox"/><text x="682" y="40" text-anchor="middle" class="fs-t">Cyclone + bag filter</text>' +
      '<text x="682" y="60" text-anchor="middle" class="fs-v" id="fsF1"></text><text x="682" y="78" text-anchor="middle" class="fs-v" id="fsF2"></text>' +
      '<path id="fsGas2" class="fs-flow" d="M752 50 H812"/>' +
      '<rect x="812" y="22" width="120" height="72" rx="6" class="fs-box"/><text x="872" y="40" text-anchor="middle" class="fs-t">Mill fan</text>' +
      '<text x="872" y="60" text-anchor="middle" class="fs-v" id="fsFan1"></text><text x="872" y="78" text-anchor="middle" class="fs-v" id="fsFan2"></text>' +
      '<path id="fsGas3" class="fs-flow" d="M932 50 H990"/><text x="1040" y="46" text-anchor="middle" class="fs-t">Stack /</text><text x="1040" y="60" text-anchor="middle" class="fs-t">kiln</text>' +
      '<path id="fsProd" class="fs-flow" d="M682 94 V150 H812" stroke="#e6d6b0"/>' +
      '<rect x="812" y="118" width="170" height="82" rx="6" class="fs-box" id="fsSiloBox"/><text x="897" y="136" text-anchor="middle" class="fs-t">Silo raw meal</text>' +
      '<text x="897" y="155" text-anchor="middle" class="fs-v" id="fsS1"></text><text x="897" y="173" text-anchor="middle" class="fs-v" id="fsS2"></text><text x="897" y="191" text-anchor="middle" class="fs-v" id="fsS3"></text>' +
      '</svg>';
    $('flowsheet').innerHTML = svg;
    fsBuilt = true;
  }
  function setText(id, t) { var e = $(id); if (e && e.textContent !== t) e.textContent = t; }
  function flowAnim(id, rate) {
    var e = $(id); if (!e) return;
    if (rate <= 0.02) { e.style.animationPlayState = 'paused'; return; }
    e.style.animationPlayState = 'running';
    e.style.animationDuration = (1.2 / clamp(rate, 0.1, 3)).toFixed(2) + 's';
  }
  function updateFlowsheet(v) {
    if (!fsBuilt) buildFlowsheet();
    var props = M.normalizeProps(Sim.materials.map(function (m) { return m.prop; }));
    Sim.materials.forEach(function (m, i) {
      setText('fsBinN' + i, m.name.slice(0, 11));
      setText('fsBin' + i, fmt(v.feedOut * props[i] / 100, 0) + ' t/h');
    });
    setText('fsFeed', 'WF ' + fmt(v.feedOut, 0) + ' t/h → mill ' + fmt(v.feed, 0) + ' t/h');
    setText('fsMill1', 'DP ' + fmt(v.dp, 1) + ' mbar');
    setText('fsMill2', 'Getaran ' + fmt(v.vib, 1) + ' mm/s');
    setText('fsMill3', 'Daya ' + fmt(v.pMill, 0) + ' kW');
    setText('fsMill4', 'Bed ' + fmt(v.bed, 0) + ' mm');
    setText('fsHot', fmt(v.tIn, 0) + ' °C · ' + fmt(v.gas, 0) + ' kg/s');
    setText('fsF1', 'T out ' + fmt(v.tOut, 1) + ' °C');
    setText('fsF2', fmt(v.gasAm3h / 1000, 0) + ' ribu Am³/h');
    setText('fsFan1', 'Fan ' + fmt(v.fan, 1) + ' %');
    setText('fsFan2', fmt(v.pFan, 0) + ' kW');
    setText('fsS1', fmt(v.product, 0) + ' t/h');
    setText('fsS2', 'R90 ' + fmt(v.r90, 1) + ' % · H₂O ' + fmt(v.moistOut, 2) + ' %');
    setText('fsS3', 'LSF ' + fmt(v.lsf, 1) + ' · SM ' + fmt(v.sm, 2) + ' · AM ' + fmt(v.am, 2));
    var lv = v.levels || {}, LC = { ok: '#34495d', warn: '#fab219', alarm: '#d03b3b' };
    $('fsMillBox').style.stroke = LC[lv.vib === 'ok' && lv.dp === 'ok' ? 'ok' : (lv.vib === 'alarm' || lv.dp === 'alarm' ? 'alarm' : 'warn')];
    $('fsFilterBox').style.stroke = LC[lv.tOut || 'ok'];
    var sl = (lv.r90 === 'ok' && lv.lsf !== 'alarm' && lv.moist === 'ok') ? 'ok' : ((lv.r90 === 'alarm' || lv.moist === 'alarm') ? 'alarm' : 'warn');
    $('fsSiloBox').style.stroke = LC[sl];
    var tc = VRM.Mill3D.tempColor;
    $('fsHotLine').style.stroke = tc(v.tIn);
    ['fsGas1', 'fsGas2', 'fsGas3'].forEach(function (id) { $(id).style.stroke = tc(v.tOut); });
    flowAnim('fsBelt', v.feedOut / 380);
    flowAnim('fsHotLine', v.fan / 80); flowAnim('fsGas1', v.fan / 80); flowAnim('fsGas2', v.fan / 80); flowAnim('fsGas3', v.fan / 80);
    flowAnim('fsProd', v.product / 360);
  }

  /* =================================================================
     9. Tab Material
     ================================================================= */

  var MAT_LIMITS = { prop: [0, 100, 2], moist: [0, 40, 1], bwi: [3, 30, 1], size: [0.1, 300, 0] };
  function buildMaterialTable() {
    var mats = Sim.materials;
    var tbl = $('matTable');
    tbl.innerHTML = '';
    var head = document.createElement('tr');
    head.innerHTML = '<th>Parameter</th>' + mats.map(function (m, i) { return '<th>Komponen ' + (i + 1) + '</th>'; }).join('') + '<th>Campuran</th>';
    tbl.appendChild(head);
    function row(label, cls, cellFn, mixFn) {
      var tr = document.createElement('tr'); if (cls) tr.className = cls;
      var td0 = document.createElement('td'); td0.innerHTML = label; tr.appendChild(td0);
      mats.forEach(function (m, i) { var td = document.createElement('td'); cellFn(td, m, i); tr.appendChild(td); });
      var tdm = document.createElement('td'); tdm.className = 'num mixcell'; tdm.dataset.mix = mixFn || ''; tr.appendChild(tdm);
      tbl.appendChild(tr);
    }
    row('Nama', '', function (td, m) {
      var inp = document.createElement('input'); inp.className = 'txt'; inp.value = m.name; inp.maxLength = 24;
      inp.addEventListener('change', function () { m.name = inp.value.trim() || m.name; inp.value = m.name; fsBuilt = false; });
      td.appendChild(inp);
    });
    row('Proporsi (% kering)', 'sep', function (td, m) {
      td.appendChild(makeNum(m.prop, 0, 100, 2, function (v) { m.prop = v; refreshChem(); }));
    }, 'prop');
    VRM.OXIDES.forEach(function (ox) {
      var lab = ox.replace(/(\d)/g, '<sub>$1</sub>') + ' (%)';
      row(lab, ox === 'LOI' ? 'sep' : '', function (td, m) {
        td.appendChild(makeNum(m.ox[ox], 0, ox === 'LOI' ? 50 : 100, 2, function (v) { m.ox[ox] = v; refreshChem(); }));
      }, 'ox:' + ox);
    });
    row('Total oksida (%)', 'sumrow sep', function (td, m, i) { td.className = 'num'; td.id = 'oxSum' + i; }, 'sumOx');
    row('Moisture (%)', '', function (td, m) { td.appendChild(makeNum(m.moist, 0, 40, 1, function (v) { m.moist = v; refreshChem(); })); }, 'moist');
    row('Grindability BWI (kWh/t)', '', function (td, m) { td.appendChild(makeNum(m.bwi, 3, 30, 1, function (v) { m.bwi = v; refreshChem(); })); }, 'bwi');
    row('Ukuran feed maks (mm)', '', function (td, m) { td.appendChild(makeNum(m.size, 0.1, 300, 0, function (v) { m.size = v; refreshChem(); })); }, 'size');
    refreshChem();
  }

  function refreshChem() {
    var chem = M.mixChemistry(Sim.materials);
    var mats = Sim.materials;
    // Kolom campuran
    document.querySelectorAll('#matTable .mixcell').forEach(function (td) {
      var k = td.dataset.mix, t = '';
      if (k === 'prop') t = fmt(mats.reduce(function (a, m) { return a + m.prop; }, 0), 2) + ' → 100';
      else if (k.indexOf('ox:') === 0) t = fmt(chem.ox[k.slice(3)], 2);
      else if (k === 'sumOx') t = fmt(chem.sumOx, 2);
      else if (k === 'moist') t = fmt(chem.moist, 2);
      else if (k === 'bwi') t = fmt(chem.bwi, 2);
      else if (k === 'size') t = fmt(chem.maxSize, 0);
      td.textContent = t;
    });
    var msgs = [];
    mats.forEach(function (m, i) {
      var s = VRM.OXIDES.reduce(function (a, k) { return a + m.ox[k]; }, 0);
      var e = $('oxSum' + i); if (e) { e.textContent = fmt(s, 2); e.style.color = (s < 95 || s > 102) ? 'var(--warn)' : ''; }
      if (s < 95 || s > 102) msgs.push(m.name + ': total oksida ' + fmt(s, 1) + ' % (wajar 95–102 %)');
    });
    var sumP = mats.reduce(function (a, m) { return a + m.prop; }, 0);
    if (Math.abs(sumP - 100) > 0.05) msgs.push('Total proporsi ' + fmt(sumP, 2) + ' % — dinormalisasi otomatis ke 100 % dalam perhitungan.');
    var mm = $('matMsg'); mm.className = 'msg ' + (msgs.length ? 'warn' : 'ok');
    mm.textContent = msgs.length ? '⚠ ' + msgs.join(' · ') : '✓ Data material valid.';
    renderChemResult(chem);
  }

  function renderChemResult(chem) {
    var T = cfg.targets;
    function st(val, t, tol) { var d = Math.abs(val - t); return d <= tol * 0.5 ? 'ok' : d <= tol ? 'warn' : 'alarm'; }
    var rows = VRM.OXIDES.map(function (k) {
      return '<tr><td>' + k.replace(/(\d)/g, '<sub>$1</sub>') + '</td><td class="num">' + fmt(chem.ox[k], 2) + '</td><td class="num">' + (k === 'LOI' ? '–' : fmt(chem.oxLF[k], 2)) + '</td></tr>';
    }).join('');
    var mods = [['LSF', chem.lsf, T.lsf, T.lsfTol, 1], ['SM', chem.sm, T.sm, T.smTol, 2], ['AM', chem.am, T.am, T.amTol, 2]].map(function (r) {
      var s = st(r[1], r[2], r[3]);
      return '<tr><td>' + r[0] + '</td><td class="num">' + fmt(r[1], r[4]) + '</td><td class="num">' + fmt(r[2], r[4]) + ' ± ' + fmt(r[3], r[4]) + '</td><td class="num">' + fmt(r[1] - r[2], r[4]) + '</td><td><span class="st-' + s + '">' + LVL_ICON[s] + ' ' + LVL_TEXT[s] + '</span></td></tr>';
    }).join('');
    var b = chem.bogue, maxB = 80;
    var bars = [['C₃S', b.C3S], ['C₂S', b.C2S], ['C₃A', b.C3A], ['C₄AF', b.C4AF]].map(function (r) {
      return '<div class="bar-row"><span>' + r[0] + '</span><div class="bar-track"><div class="bar-fill" style="width:' + clamp(r[1] / maxB * 100, 0, 100) + '%"></div></div><span class="v">' + fmt(r[1], 1) + ' %</span></div>';
    }).join('');
    var burn = b.C3S > 65 ? 'C₃S tinggi → burnability lebih sulit (butuh panas & kehalusan lebih).' : b.C3S < 50 ? 'C₃S rendah → mudah dibakar, kekuatan awal klinker lebih rendah.' : 'C₃S dalam rentang umum (50–65 %).';
    $('chemResult').innerHTML =
      '<div class="grid-2" style="margin-bottom:0"><div><table class="chem-table"><tr><th>Oksida</th><th>Basis kering</th><th>Bebas LOI</th></tr>' + rows + '</table></div>' +
      '<div><table><tr><th>Modul</th><th>Aktual</th><th>Target</th><th>Δ</th><th>Status</th></tr>' + mods + '</table>' +
      '<div class="card-title" style="margin-top:10px">Bogue (indikasi, basis klinker)</div><div class="bogue-bars">' + bars + '</div><p class="muted small">' + burn + '</p>' +
      '<p class="muted small">Moisture campuran ' + fmt(chem.moist, 2) + ' % · BWI campuran ' + fmt(chem.bwi, 2) + ' kWh/t · ukuran maks ' + fmt(chem.maxSize, 0) + ' mm</p></div></div>';
  }

  var lastSolve = null;
  function bindMaterial() {
    $('btnNormalize').addEventListener('click', function () {
      var p = M.normalizeProps(Sim.materials.map(function (m) { return m.prop; }));
      Sim.materials.forEach(function (m, i) { m.prop = Math.round(p[i] * 100) / 100; });
      buildMaterialTable();
    });
    $('btnMatDefault').addEventListener('click', function () {
      Sim.materials = VRM.deepCopy(VRM.DEFAULT_MATERIALS); fsBuilt = false; buildMaterialTable();
    });
    $('btnMatExport').addEventListener('click', function () {
      download('material_vrm.json', JSON.stringify({ materials: Sim.materials, targets: cfg.targets }, null, 2), 'application/json');
    });
    $('matImport').addEventListener('change', function () {
      var f = this.files[0]; if (!f) return;
      var r = new FileReader();
      r.onload = function () {
        try {
          var data = JSON.parse(r.result);
          var mats = Array.isArray(data) ? data : data.materials;
          if (!Array.isArray(mats) || mats.length !== 4) throw new Error('harus berisi 4 komponen material');
          var clean = mats.map(function (m, i) {
            var d = VRM.DEFAULT_MATERIALS[i];
            var o = { name: String(m.name || d.name).slice(0, 24), prop: num(m.prop, d.prop, 0, 100), moist: num(m.moist, d.moist, 0, 40), bwi: num(m.bwi, d.bwi, 3, 30), size: num(m.size, d.size, 0.1, 300), ox: {} };
            VRM.OXIDES.forEach(function (k) { o.ox[k] = num(m.ox && m.ox[k], d.ox[k], 0, 100); });
            return o;
          });
          Sim.materials = clean;
          if (data.targets) ['lsf', 'sm', 'am', 'lsfTol', 'smTol', 'amTol', 'r90', 'r200', 'moist'].forEach(function (k) { if (Number.isFinite(+data.targets[k])) cfg.targets[k] = +data.targets[k]; });
          fsBuilt = false; buildMaterialTable(); buildTargetForms();
          $('matMsg').className = 'msg ok'; $('matMsg').textContent = '✓ Material berhasil diimpor dari ' + f.name;
        } catch (e) {
          $('matMsg').className = 'msg err'; $('matMsg').textContent = '✕ Gagal impor JSON: ' + e.message;
        }
      };
      r.readAsText(f);
      this.value = '';
    });
    $('btnSolve').addEventListener('click', function () {
      lastSolve = M.solveMix(Sim.materials, cfg.targets);
      var s = lastSolve, T = cfg.targets;
      var rows = Sim.materials.map(function (m, i) {
        var old = M.normalizeProps(Sim.materials.map(function (x) { return x.prop; }))[i];
        return '<tr><td>' + esc(m.name) + '</td><td class="num">' + fmt(old, 2) + '</td><td class="num">' + fmt(s.props[i], 2) + '</td></tr>';
      }).join('');
      var dev = '<tr><td>LSF</td><td class="num">' + fmt(s.chem.lsf, 2) + '</td><td class="num">' + fmt(T.lsf, 2) + '</td><td class="num">' + fmt(s.dev.lsf, 2) + '</td></tr>' +
        '<tr><td>SM</td><td class="num">' + fmt(s.chem.sm, 3) + '</td><td class="num">' + fmt(T.sm, 2) + '</td><td class="num">' + fmt(s.dev.sm, 3) + '</td></tr>' +
        '<tr><td>AM</td><td class="num">' + fmt(s.chem.am, 3) + '</td><td class="num">' + fmt(T.am, 2) + '</td><td class="num">' + fmt(s.dev.am, 3) + '</td></tr>';
      $('solveResult').innerHTML = '<div class="msg ' + (s.feasible ? 'ok' : 'err') + '">' + (s.feasible ? '✓ ' : '✕ ') + esc(s.message) + '</div>' +
        '<div class="grid-2" style="margin:8px 0 0"><table><tr><th>Komponen</th><th>Saat ini %</th><th>Usulan %</th></tr>' + rows + '</table>' +
        '<table><tr><th>Modul</th><th>Hasil</th><th>Target</th><th>Selisih</th></tr>' + dev + '</table></div>';
      $('btnApplySolve').disabled = false;
    });
    $('btnApplySolve').addEventListener('click', function () {
      if (!lastSolve) return;
      Sim.materials.forEach(function (m, i) { m.prop = Math.round(lastSolve.props[i] * 100) / 100; });
      buildMaterialTable();
      this.disabled = true;
      $('solveResult').insertAdjacentHTML('beforeend', '<div class="msg ok">✓ Proporsi diterapkan. Perubahan kimia raw meal akan terlihat setelah delay belt + waktu tinggal.</div>');
    });
  }
  function num(v, def, a, b) { v = +v; return Number.isFinite(v) ? clamp(v, a, b) : def; }

  /* Form target (kimia di tab Material, kualitas di tab Kualitas) */
  function buildTargetForms() {
    var T = cfg.targets;
    var f1 = $('targetChemForm'); f1.innerHTML = '';
    [['lsf', 'LSF', 80, 110, 1], ['lsfTol', '± LSF', 0.2, 10, 1], ['sm', 'SM', 1.5, 4, 2], ['smTol', '± SM', 0.01, 1, 2], ['am', 'AM', 0.5, 4, 2], ['amTol', '± AM', 0.01, 1, 2]].forEach(function (r) {
      f1.appendChild(labeled(r[1], makeNum(T[r[0]], r[2], r[3], r[4], function (v) { T[r[0]] = v; refreshChem(); }), ''));
    });
    var f2 = $('targetQualForm'); f2.innerHTML = '';
    [['r90', 'R90 maks', 5, 30, 1, '%'], ['r200', 'R200 maks', 0.3, 6, 1, '%'], ['moist', 'Moisture maks', 0.2, 3, 1, '%']].forEach(function (r) {
      f2.appendChild(labeled(r[1], makeNum(T[r[0]], r[2], r[3], r[4], function (v) { T[r[0]] = v; }), r[5]));
    });
    [['vibWarn', 'Getaran waspada', 2, 15, 1, 'mm/s'], ['vibAlarm', 'Getaran alarm', 3, 15, 1, 'mm/s'], ['vibTrip', 'Getaran trip', 4, 20, 1, 'mm/s']].forEach(function (r) {
      f2.appendChild(labeled(r[1], makeNum(cfg.alarm[r[0]], r[2], r[3], r[4], function (v) { cfg.alarm[r[0]] = v; }), r[5]));
    });
  }

  /* =================================================================
     10. Tab Operasi: PID, dinamika, log alarm
     ================================================================= */

  function buildOpsTab() {
    var pf = $('pidForm'); pf.innerHTML = '';
    [['temp', 'Loop 1 — Suhu outlet → suhu hot gas inlet (°C)'], ['dp', 'Loop 2 — DP mill → fan (%)']].forEach(function (r) {
      var blk = document.createElement('div'); blk.className = 'pid-block';
      blk.innerHTML = '<h4>' + r[1] + '</h4>';
      var g = document.createElement('div'); g.className = 'form-grid';
      [['kp', 'Kp', 0, 20, 3], ['ki', 'Ki', 0, 2, 3], ['kd', 'Kd', 0, 100, 2]].forEach(function (p) {
        g.appendChild(labeled(p[1], makeNum(cfg.pid[r[0]][p[0]], p[2], p[3], p[4], function (v) {
          cfg.pid[r[0]][p[0]] = v;
          if (Sim.ops.autoMode) Sim.setAuto(true); // inisialisasi ulang bumpless
        }), ''));
      });
      blk.appendChild(g); pf.appendChild(blk);
    });
    var df = $('dynForm'); df.innerHTML = '';
    [['beltDelay', 'Delay belt', 5, 300], ['tauBed', 'τ bed', 5, 300], ['tauTemp', 'τ suhu', 5, 600], ['deadTemp', 'Dead time suhu', 1, 120],
     ['tauDP', 'τ DP', 2, 300], ['tauPSD', 'τ PSD', 5, 600], ['deadPSD', 'Dead time PSD', 1, 300], ['tauChem', 'τ kimia', 10, 900], ['deadChem', 'Dead time kimia', 1, 600]].forEach(function (r) {
      df.appendChild(labeled(r[1], makeNum(cfg.dyn[r[0]], r[2], r[3], 0, function (v) { cfg.dyn[r[0]] = Math.round(v); Sim.rebuildDelays(); }), 's'));
    });
    $('chkNoise').addEventListener('change', function () { Sim.settings.noise = this.checked; });
  }
  function renderAlarmLog() {
    var log = Sim.alarmLog;
    $('alarmLog').innerHTML = '<tr><th>Waktu</th><th>Kejadian</th></tr>' + (log.length ? log.slice(0, 100).map(function (a) {
      return '<tr><td class="num">' + hms(a.t) + '</td><td><span class="st-' + a.level + '">' + LVL_ICON[a.level] + '</span> ' + esc(a.msg) + '</td></tr>';
    }).join('') : '<tr><td colspan="2" class="muted">Belum ada kejadian.</td></tr>');
  }

  /* =================================================================
     11. Grafik SVG (tanpa library)
     ================================================================= */

  function niceTicks(min, max, count) {
    var span = max - min; if (!(span > 0)) span = 1;
    var step = Math.pow(10, Math.floor(Math.log10(span / count)));
    var err = span / count / step;
    if (err >= 7.5) step *= 10; else if (err >= 3.5) step *= 5; else if (err >= 1.5) step *= 2;
    var ticks = [];
    for (var v = Math.ceil(min / step) * step; v <= max + step * 1e-9; v += step) ticks.push(+v.toFixed(10));
    return ticks;
  }

  /**
   * Gambar grafik garis/scatter satu seri.
   * o: {title, data:[{x,y}], color, type:'line'|'scatter', unit, xUnit, yDec, xDec,
   *     band:[lo,hi], refs:[{y,label}], vline:{x,label}, logX, xMin,xMax,yMin,yMax,
   *     markers:[{x,y,label}], diag (garis y=x), height, xFmt}
   */
  function drawChart(host, o) {
    var W = host.clientWidth;
    if (!W || W < 60) return;
    var H = o.height || 160;
    var m = { l: 46, r: 14, t: o.title ? 22 : 8, b: 26 };
    var data = (o.data || []).filter(function (p) { return Number.isFinite(p.x) && Number.isFinite(p.y); });
    var tx = o.logX ? function (x) { return Math.log10(Math.max(x, 1e-6)); } : function (x) { return x; };
    var xs = data.map(function (p) { return p.x; }), ys = data.map(function (p) { return p.y; });
    var xMin = o.xMin !== undefined ? o.xMin : Math.min.apply(null, xs.length ? xs : [0]);
    var xMax = o.xMax !== undefined ? o.xMax : Math.max.apply(null, xs.length ? xs : [1]);
    if (xMax <= xMin) xMax = xMin + 1;
    var extra = [];
    if (o.band) extra = extra.concat(o.band);
    (o.refs || []).forEach(function (r) { extra.push(r.y); });
    (o.markers || []).forEach(function (r) { extra.push(r.y); });
    var all = ys.concat(extra.filter(Number.isFinite));
    var yMin = o.yMin !== undefined ? o.yMin : Math.min.apply(null, all.length ? all : [0]);
    var yMax = o.yMax !== undefined ? o.yMax : Math.max.apply(null, all.length ? all : [1]);
    if (o.diag) { yMin = xMin = Math.min(xMin, yMin); yMax = xMax = Math.max(xMax, yMax); }
    if (yMax - yMin < 1e-9) { yMax += 1; yMin -= 1; }
    if (o.minSpan && yMax - yMin < o.minSpan) { var mid = (yMax + yMin) / 2; yMin = mid - o.minSpan / 2; yMax = mid + o.minSpan / 2; }
    if (o.yMin === undefined) yMin -= (yMax - yMin) * 0.08;
    if (o.yMax === undefined) yMax += (yMax - yMin) * 0.08;
    var X0 = tx(xMin), X1 = tx(xMax);
    var sx = function (x) { return m.l + (tx(x) - X0) / (X1 - X0) * (W - m.l - m.r); };
    var sy = function (y) { return H - m.b - (y - yMin) / (yMax - yMin) * (H - m.t - m.b); };
    var color = o.color || '#3987e5';
    var s = '<svg viewBox="0 0 ' + W + ' ' + H + '" width="' + W + '" height="' + H + '">';
    if (o.title) s += '<text x="' + m.l + '" y="14" class="c-title">' + o.title + '</text>';
    // Grid & sumbu Y
    niceTicks(yMin, yMax, 4).forEach(function (t) {
      var y = sy(t);
      s += '<line x1="' + m.l + '" x2="' + (W - m.r) + '" y1="' + y.toFixed(1) + '" y2="' + y.toFixed(1) + '" class="c-grid"/>';
      s += '<text x="' + (m.l - 5) + '" y="' + (y + 3).toFixed(1) + '" text-anchor="end" class="c-axis">' + fmt(t, Math.abs(yMax - yMin) < 2 ? 2 : Math.abs(yMax - yMin) < 20 ? 1 : 0) + '</text>';
    });
    // Sumbu X
    var xt = o.logX ? [1, 2, 5, 10, 20, 45, 90, 200, 500, 1000].filter(function (v) { return v >= xMin && v <= xMax; }) : niceTicks(xMin, xMax, Math.max(3, Math.floor(W / 80)));
    xt.forEach(function (t) {
      var x = sx(t);
      s += '<line x1="' + x.toFixed(1) + '" x2="' + x.toFixed(1) + '" y1="' + m.t + '" y2="' + (H - m.b) + '" class="c-grid" opacity="0.5"/>';
      s += '<text x="' + x.toFixed(1) + '" y="' + (H - m.b + 14) + '" text-anchor="middle" class="c-axis">' + (o.xFmt ? o.xFmt(t) : fmt(t, o.xDec || 0)) + '</text>';
    });
    if (o.xUnit) s += '<text x="' + (W - m.r) + '" y="' + (H - 2) + '" text-anchor="end" class="c-axis">' + o.xUnit + '</text>';
    // Band target
    if (o.band) {
      var b0 = sy(Math.min(o.band[1], yMax)), b1 = sy(Math.max(o.band[0], yMin));
      if (b1 > b0) s += '<rect x="' + m.l + '" y="' + b0.toFixed(1) + '" width="' + (W - m.l - m.r) + '" height="' + (b1 - b0).toFixed(1) + '" fill="#8597a8" opacity="0.13"/>';
    }
    (o.refs || []).forEach(function (r) {
      if (r.y < yMin || r.y > yMax) return;
      var y = sy(r.y).toFixed(1);
      s += '<line x1="' + m.l + '" x2="' + (W - m.r) + '" y1="' + y + '" y2="' + y + '" stroke="' + (r.color || '#8597a8') + '" stroke-dasharray="4 3" stroke-width="1"/>';
      s += r.left ? '<text x="' + (m.l + 4) + '" y="' + (+y - 3) + '" class="c-axis">' + r.label + '</text>'
                  : '<text x="' + (W - m.r - 2) + '" y="' + (+y - 3) + '" text-anchor="end" class="c-axis">' + r.label + '</text>';
    });
    if (o.diag) s += '<line x1="' + sx(xMin) + '" y1="' + sy(xMin) + '" x2="' + sx(xMax) + '" y2="' + sy(xMax) + '" stroke="#8597a8" stroke-dasharray="4 3"/>';
    if (o.vline && Number.isFinite(o.vline.x)) {
      var vx = sx(o.vline.x).toFixed(1);
      s += '<line x1="' + vx + '" x2="' + vx + '" y1="' + m.t + '" y2="' + (H - m.b) + '" stroke="#d9e3ec" stroke-dasharray="3 3" opacity="0.6"/>';
      s += '<text x="' + (+vx + 4) + '" y="' + (m.t + 10) + '" class="c-axis">' + o.vline.label + '</text>';
    }
    // Data
    if (o.type === 'scatter') {
      data.forEach(function (p) { s += '<circle cx="' + sx(p.x).toFixed(1) + '" cy="' + sy(p.y).toFixed(1) + '" r="4" fill="' + color + '" stroke="#111921" stroke-width="2"/>'; });
    } else if (data.length) {
      s += '<path d="M' + data.map(function (p) { return sx(p.x).toFixed(1) + ' ' + sy(p.y).toFixed(1); }).join(' L') + '" fill="none" stroke="' + color + '" stroke-width="2" stroke-linejoin="round"/>';
    }
    (o.markers || []).forEach(function (mk) {
      var x = sx(mk.x), y = sy(mk.y);
      s += '<path d="M' + x.toFixed(1) + ' ' + (y - 6).toFixed(1) + ' l6 6 l-6 6 l-6 -6 z" fill="' + (mk.color || '#d9e3ec') + '" stroke="#111921" stroke-width="2"/>';
      if (mk.label) s += '<text x="' + (x + 9).toFixed(1) + '" y="' + (y + (mk.dy || 4)).toFixed(1) + '" class="c-axis" style="fill:#d9e3ec">' + mk.label + '</text>';
    });
    s += '<line class="c-cross" x1="0" x2="0" y1="' + m.t + '" y2="' + (H - m.b) + '" stroke="#d9e3ec" opacity="0" stroke-width="1"/>';
    s += '<circle class="c-dot" r="4" fill="' + color + '" stroke="#111921" stroke-width="2" opacity="0"/>';
    s += '<rect x="' + m.l + '" y="' + m.t + '" width="' + (W - m.l - m.r) + '" height="' + (H - m.t - m.b) + '" fill="transparent" class="c-hit"/></svg><div class="c-tip"></div>';
    host.innerHTML = s;
    host._chart = { data: data, sx: sx, sy: sy, o: o };
    if (!host._bound) {
      host._bound = true;
      host.classList.add('chart');
      host.addEventListener('mousemove', function (e) {
        var c = host._chart; if (!c || !c.data.length) return;
        var svg = host.querySelector('svg'); var r = svg.getBoundingClientRect();
        var px = e.clientX - r.left, py = e.clientY - r.top;
        var best = null, bd = 1e9;
        c.data.forEach(function (p) {
          var d = c.o.type === 'scatter' ? Math.hypot(c.sx(p.x) - px, c.sy(p.y) - py) : Math.abs(c.sx(p.x) - px);
          if (d < bd) { bd = d; best = p; }
        });
        var tip = host.querySelector('.c-tip'), cross = host.querySelector('.c-cross'), dot = host.querySelector('.c-dot');
        if (!best || bd > 40) { tip.style.display = 'none'; cross.setAttribute('opacity', 0); dot.setAttribute('opacity', 0); return; }
        var X = c.sx(best.x), Y = c.sy(best.y);
        cross.setAttribute('x1', X); cross.setAttribute('x2', X); cross.setAttribute('opacity', c.o.type === 'scatter' ? 0 : 0.4);
        dot.setAttribute('cx', X); dot.setAttribute('cy', Y); dot.setAttribute('opacity', 1);
        tip.innerHTML = (c.o.tipX ? c.o.tipX(best.x) : fmt(best.x, c.o.xDec || 0)) + ' → <b>' + fmt(best.y, c.o.yDec === undefined ? 2 : c.o.yDec) + '</b> ' + (c.o.unit || '');
        tip.style.display = 'block';
        var tl = X + 10; if (tl + 160 > r.width) tl = X - 170;
        tip.style.left = tl + 'px'; tip.style.top = Math.max(0, Y - 30) + 'px';
      });
      host.addEventListener('mouseleave', function () {
        var tip = host.querySelector('.c-tip'); if (tip) tip.style.display = 'none';
        var cross = host.querySelector('.c-cross'); if (cross) cross.setAttribute('opacity', 0);
        var dot = host.querySelector('.c-dot'); if (dot) dot.setAttribute('opacity', 0);
      });
    }
  }

  /* =================================================================
     12. Tab Kualitas: tren & PSD
     ================================================================= */

  var TRENDS = [
    { k: 'feedMill', t: 'Feed masuk mill', u: 't/h', d: 0 },
    { k: 'dp', t: 'DP mill', u: 'mbar', d: 1, band: function () { return [cfg.alarm.dpLow, cfg.alarm.dpHigh]; } },
    { k: 'vib', t: 'Getaran', u: 'mm/s', d: 2, band: function () { return [0, cfg.alarm.vibWarn]; }, refs: function () { return [{ y: cfg.alarm.vibTrip, label: 'trip', color: '#d03b3b' }]; } },
    { k: 'tOut', t: 'Suhu outlet', u: '°C', d: 1, band: function () { return [cfg.alarm.tOutLow, cfg.alarm.tOutHigh]; }, refs: function () { return [{ y: Sim.ops.tOutSP, label: 'SP' }]; } },
    { k: 'r90', t: 'R90', u: '%', d: 2, band: function () { return [0, cfg.targets.r90]; } },
    { k: 'lsf', t: 'LSF', u: '', d: 2, band: function () { return [cfg.targets.lsf - cfg.targets.lsfTol, cfg.targets.lsf + cfg.targets.lsfTol]; } }
  ];
  function buildTrends() {
    $('trendGrid').innerHTML = TRENDS.map(function (tr, i) { return '<div id="trend' + i + '"></div>'; }).join('');
  }
  function renderTrends() {
    var hist = Sim.history, win = hist.slice(-1800);
    var tNow = hist.length ? hist[hist.length - 1].t : 0;
    var step = Math.max(1, Math.floor(win.length / 300));
    TRENDS.forEach(function (tr, i) {
      var data = [];
      for (var j = 0; j < win.length; j += step) data.push({ x: (win[j].t - tNow) / 60, y: win[j][tr.k] });
      if (win.length) data.push({ x: 0, y: win[win.length - 1][tr.k] });
      drawChart($('trend' + i), {
        title: tr.t + (tr.u ? ' (' + tr.u + ')' : ''), data: data, unit: tr.u, yDec: tr.d, xMin: -30, xMax: 0, xUnit: 'menit',
        band: tr.band ? tr.band() : null, refs: tr.refs ? tr.refs() : [], height: 150,
        tipX: function (x) { return fmt(x, 1) + ' mnt'; }
      });
    });
  }
  function renderPsd(v) {
    var data = [];
    for (var i = 0; i <= 60; i++) {
      var x = Math.pow(10, i / 20);
      data.push({ x: x, y: 100 - M.residue(x, v.xp, v.n) });
    }
    var T = cfg.targets;
    drawChart($('psdChart'), {
      title: 'Lolos kumulatif (%) — x′ = ' + fmt(v.xp, 1) + ' µm, n = ' + fmt(v.n, 2), data: data, logX: true, xMin: 1, xMax: 1000,
      yMin: 0, yMax: 100, unit: '% lolos', yDec: 1, xUnit: 'ukuran (µm, log)', height: 240, tipX: function (x) { return fmt(x, 0) + ' µm'; },
      refs: [{ y: 100 - T.r90, label: 'spec: lolos 90 µm ≥ ' + fmt(100 - T.r90, 1) + ' %', left: true }],
      markers: [
        { x: 90, y: 100 - v.r90, label: '90 µm: R90 ' + fmt(v.r90, 1) + ' %', color: v.r90 <= T.r90 ? '#0ca30c' : '#d03b3b', dy: 18 },
        { x: 200, y: 100 - v.r200, label: '200 µm: R200 ' + fmt(v.r200, 2) + ' % (spec ≤ ' + fmt(T.r200, 1) + ')', color: v.r200 <= T.r200 ? '#0ca30c' : '#d03b3b', dy: 30 }
      ]
    });
  }

  /* =================================================================
     13. Skenario: preset, simpan/bandingkan, sweep, optimizer
     ================================================================= */

  var PRESETS = [
    { id: 'normal', t: 'Normal', d: 'Material & operasi default.', fn: function () {
      Sim.materials = VRM.deepCopy(VRM.DEFAULT_MATERIALS);
      Sim.setOps(Object.assign(VRM.deepCopy(VRM.DEFAULT_OPERATION), { autoMode: Sim.ops.autoMode }));
    } },
    { id: 'wetclay', t: 'Clay lembap', d: 'Moisture clay 22 % (musim hujan). Mode Auto diaktifkan agar PID mengompensasi suhu.', fn: function () {
      Sim.materials = VRM.deepCopy(VRM.DEFAULT_MATERIALS); Sim.materials[1].moist = 22;
      Sim.setOps({ autoMode: true });
    } },
    { id: 'hardls', t: 'Limestone keras', d: 'BWI limestone 14,5 kWh/t → kapasitas gilas turun, sirkulasi & DP naik, produk lebih kasar.', fn: function () {
      Sim.materials = VRM.deepCopy(VRM.DEFAULT_MATERIALS); Sim.materials[0].bwi = 14.5;
    } },
    { id: 'eco', t: 'Hemat energi', d: 'R90 dinaikkan mendekati batas spec: rpm separator lebih rendah, fan lebih rendah, feed lebih tinggi. Mode Auto.', fn: function () {
      Sim.setOps({ feed: 420, sepRpm: 68.5, pressure: 98, fan: 76, spray: 1200, tOutSP: 88 });
      // Setpoint DP = DP tunak pada titik operasi baru, agar PID fan tidak "melawan" feed yang lebih tinggi
      var ss = M.steadyState(Sim.currentInputs(), Sim.effectiveChem(), cfg);
      Sim.setOps({ dpSP: Math.round(ss.dp * 2) / 2, autoMode: true });
      return 'Setpoint DP diset ke ' + fmt(Sim.ops.dpSP, 1) + ' mbar (DP tunak titik operasi ini).';
    } },
    { id: 'alt', t: 'Substitusi bahan baku alternatif', d: 'Iron sand diganti copper slag, clay dicampur fly ash; proporsi dihitung ulang dengan mix solver.', fn: function () {
      var m = VRM.deepCopy(VRM.DEFAULT_MATERIALS);
      m[1] = { name: 'Clay + fly ash', prop: 13, moist: 11, bwi: 11, size: 30, ox: { SiO2: 55, Al2O3: 20, Fe2O3: 7.5, CaO: 4, MgO: 1.5, K2O: 1.5, Na2O: 0.6, SO3: 0.6, LOI: 8 } };
      m[3] = { name: 'Copper slag', prop: 1.5, moist: 5, bwi: 17, size: 4, ox: { SiO2: 33, Al2O3: 4.5, Fe2O3: 52, CaO: 5.5, MgO: 1.5, K2O: 0.6, Na2O: 0.6, SO3: 0.8, LOI: 0.5 } };
      var s = M.solveMix(m, cfg.targets);
      m.forEach(function (x, i) { x.prop = Math.round(s.props[i] * 100) / 100; });
      Sim.materials = m;
      return s.feasible ? 'Mix solver: target tercapai.' : s.message;
    } }
  ];
  function buildPresets() {
    var row = $('presetRow'); row.innerHTML = '';
    PRESETS.forEach(function (p) {
      var b = document.createElement('button'); b.className = 'btn'; b.textContent = p.t; b.title = p.d;
      b.addEventListener('click', function () {
        var extra = p.fn();
        fsBuilt = false; buildMaterialTable(); setModeUI(); syncSliders(true);
        $('presetMsg').className = 'msg ok';
        $('presetMsg').textContent = '✓ Preset "' + p.t + '" diterapkan: ' + p.d + (extra ? ' ' + extra : '');
      });
      row.appendChild(b);
    });
  }

  // ---- Penyimpanan skenario (localStorage dengan try/catch) ----
  var STORE_KEY = 'vrmSim.scenarios.v1';
  var memStore = {};
  function loadStore() {
    try { var s = window.localStorage.getItem(STORE_KEY); return s ? JSON.parse(s) : {}; }
    catch (e) { return memStore; }
  }
  function saveStore(obj) {
    memStore = obj;
    try { window.localStorage.setItem(STORE_KEY, JSON.stringify(obj)); return true; }
    catch (e) { return false; }
  }
  function snapshotResults(v) {
    return {
      feed: Sim.ops.feed, sepRpm: Sim.ops.sepRpm, pressure: Sim.ops.pressure, product: v.product, r90: v.r90, r200: v.r200,
      lsfDev: v.lsf - cfg.targets.lsf, moist: v.moistOut, kwht: v.kwht, mjt: v.mjt, co2: v.co2, vib: v.vib, t: v.t
    };
  }
  function buildScenarioButtons() {
    var host = $('scenButtons'); host.innerHTML = '';
    ['A', 'B', 'C'].forEach(function (k) {
      var bs = document.createElement('button'); bs.className = 'btn btn-primary'; bs.textContent = 'Simpan ' + k;
      bs.addEventListener('click', function () {
        var st = loadStore();
        st[k] = { savedAt: new Date().toISOString(), ops: VRM.deepCopy(Sim.ops), materials: VRM.deepCopy(Sim.materials), targets: VRM.deepCopy(cfg.targets), res: snapshotResults(Sim.view()) };
        var ok = saveStore(st);
        renderScenarioTable();
        if (!ok) $('scenTable').insertAdjacentHTML('beforebegin', '<div class="msg warn">⚠ localStorage tidak tersedia — skenario hanya disimpan sementara di memori.</div>');
      });
      var bl = document.createElement('button'); bl.className = 'btn'; bl.textContent = 'Muat ' + k;
      bl.addEventListener('click', function () {
        var st = loadStore()[k]; if (!st) return;
        Sim.materials = VRM.deepCopy(st.materials);
        Sim.setOps(st.ops);
        Object.assign(cfg.targets, st.targets || {});
        fsBuilt = false; buildMaterialTable(); buildTargetForms(); setModeUI();
      });
      host.appendChild(bs); host.appendChild(bl);
    });
    var bc = document.createElement('button'); bc.className = 'btn btn-sm'; bc.textContent = 'Hapus semua';
    bc.addEventListener('click', function () { if (window.confirm('Hapus semua skenario tersimpan?')) { saveStore({}); renderScenarioTable(); } });
    host.appendChild(bc);
  }
  function renderScenarioTable() {
    var st = loadStore();
    var cols = [{ name: 'Saat ini', res: snapshotResults(Sim.view()) }];
    ['A', 'B', 'C'].forEach(function (k) { if (st[k]) cols.push({ name: 'Skenario ' + k, res: st[k].res, at: st[k].savedAt }); });
    var rows = [
      ['Feed (t/h)', 'feed', 0, null], ['Rpm separator (%)', 'sepRpm', 1, null], ['Tekanan gilas (bar)', 'pressure', 0, null],
      ['Throughput (t/h)', 'product', 0, 'max'], ['R90 (%)', 'r90', 2, null], ['R200 (%)', 'r200', 2, null],
      ['Deviasi LSF', 'lsfDev', 2, 'absmin'], ['Moisture (%)', 'moist', 2, null], ['kWh/t', 'kwht', 2, 'min'],
      ['MJ/t panas', 'mjt', 0, 'min'], ['CO₂ (kg/t)', 'co2', 1, 'min'], ['Getaran (mm/s)', 'vib', 1, 'min']
    ];
    var h = '<tr><th>Indikator</th>' + cols.map(function (c) { return '<th>' + c.name + (c.at ? '<br><span class="muted small">' + new Date(c.at).toLocaleString('id-ID') + '</span>' : '') + '</th>'; }).join('') + '</tr>';
    rows.forEach(function (r) {
      var vals = cols.map(function (c) { return c.res ? c.res[r[1]] : NaN; });
      var bestIdx = -1;
      if (r[3] && cols.length > 1) {
        var score = vals.map(function (v) { return r[3] === 'max' ? -v : r[3] === 'absmin' ? Math.abs(v) : v; });
        bestIdx = score.indexOf(Math.min.apply(null, score));
      }
      h += '<tr><td>' + r[0] + '</td>' + vals.map(function (v, i) { return '<td class="num' + (i === bestIdx ? ' best' : '') + '">' + fmt(v, r[2]) + (i === bestIdx ? ' ★' : '') + '</td>'; }).join('') + '</tr>';
    });
    $('scenTable').innerHTML = h;
  }

  // ---- Sweep ----
  var SWEEP_PARAMS = ['sepRpm', 'feed', 'pressure', 'dam', 'fan', 'tIn', 'spray'];
  function bindSweep() {
    var sel = $('sweepParam');
    sel.innerHTML = SWEEP_PARAMS.map(function (k) { return '<option value="' + k + '">' + LIM[k].label + ' (' + LIM[k].unit + ')</option>'; }).join('');
    function setRange() { var k = sel.value; $('sweepMin').value = inFmt(k === 'feed' ? 150 : LIM[k].min, 1); $('sweepMax').value = inFmt(opMax(k), 1); }
    sel.addEventListener('change', setRange); setRange();
    $('btnSweep').addEventListener('click', runSweep);
  }
  function runSweep() {
    var k = $('sweepParam').value;
    var mn = parseNum($('sweepMin').value), mx = parseNum($('sweepMax').value);
    if (!Number.isFinite(mn)) mn = LIM[k].min;
    if (!Number.isFinite(mx)) mx = opMax(k);
    mn = clamp(mn, LIM[k].min, opMax(k)); mx = clamp(mx, LIM[k].min, opMax(k));
    if (mx <= mn) mx = Math.min(opMax(k), mn + LIM[k].step * 10);
    var pts = M.sweep(Sim.currentInputs(), Sim.effectiveChem(), cfg, k, mn, mx, 31);
    var host = $('sweepCharts');
    host.innerHTML = '<div id="sw1"></div><div id="sw2"></div><div id="sw3"></div><div id="sw4"></div>';
    var cur = Sim.ops[k], xl = LIM[k].label + ' (' + LIM[k].unit + ')';
    var common = { xUnit: xl, height: 140, vline: { x: cur, label: 'saat ini' }, xDec: LIM[k].step < 1 ? 1 : 0, tipX: function (x) { return fmt(x, 1) + ' ' + LIM[k].unit; } };
    drawChart($('sw1'), Object.assign({ title: 'R90 (%)', data: pts.map(function (p) { return { x: p.x, y: p.r90 }; }), unit: '%', refs: [{ y: cfg.targets.r90, label: 'target' }] }, common));
    drawChart($('sw2'), Object.assign({ title: 'Energi spesifik (kWh/t)', data: pts.map(function (p) { return { x: p.x, y: p.kwht }; }), unit: 'kWh/t' }, common));
    drawChart($('sw3'), Object.assign({ title: 'Throughput (t/h)', data: pts.map(function (p) { return { x: p.x, y: p.product }; }), unit: 't/h', yDec: 0, minSpan: 40 }, common));
    drawChart($('sw4'), Object.assign({ title: 'Getaran (mm/s)', data: pts.map(function (p) { return { x: p.x, y: p.vib }; }), unit: 'mm/s', refs: [{ y: cfg.alarm.vibAlarm, label: 'alarm' }] }, common));
  }

  // ---- Optimizer ----
  var lastOpt = null;
  function bindOptimizer() {
    $('btnOptimize').addEventListener('click', function () {
      $('optResult').innerHTML = '<div class="msg">Menghitung…</div>';
      setTimeout(function () {
        var inp = Sim.currentInputs(), chem = Sim.effectiveChem();
        var cur = M.steadyState(inp, chem, cfg);
        lastOpt = M.optimize(inp, chem, cfg);
        if (!lastOpt.ok) { $('optResult').innerHTML = '<div class="msg err">✕ ' + esc(lastOpt.message) + '</div>'; $('btnApplyOpt').disabled = true; return; }
        var o = lastOpt.r;
        function tr(l, a, b, d) { return '<tr><td>' + l + '</td><td class="num">' + fmt(a, d) + '</td><td class="num">' + fmt(b, d) + '</td></tr>'; }
        $('optResult').innerHTML = '<div class="msg ok">✓ ' + esc(lastOpt.message) + '</div><table><tr><th>Variabel</th><th>Saat ini (tunak)</th><th>Optimum</th></tr>' +
          tr('Feed (t/h)', inp.feed, lastOpt.feed, 0) + tr('Rpm separator (%)', inp.sepRpm, lastOpt.sepRpm, 1) + tr('Tekanan gilas (bar)', inp.pressure, lastOpt.pressure, 1) +
          tr('kWh/t', cur.kwht, o.kwht, 2) + tr('Throughput (t/h)', cur.product, o.product, 0) + tr('R90 (%)', cur.r90, o.r90, 2) + tr('R200 (%)', cur.r200, o.r200, 2) +
          tr('Getaran (mm/s)', cur.vib, o.vib, 2) + tr('Moisture (%)', cur.moistOut, o.moistOut, 2) + tr('DP (mbar)', cur.dp, o.dp, 1) + tr('Suhu outlet (°C)', cur.tOut, o.tOut, 1) +
          '</table><p class="muted small">Constraint: R90 ≤ ' + fmt(cfg.targets.r90, 1) + ' %, R200 ≤ 1,5×spec, getaran &lt; ' + fmt(cfg.alarm.vibWarn, 1) + ' mm/s, moisture ≤ ' + fmt(cfg.targets.moist, 1) +
          ' %, DP ≤ ' + fmt(cfg.alarm.dpHigh, 0) + ' mbar, daya motor ≤ ' + fmt(cfg.alarm.powerHigh * 100, 0) + ' %. Suhu hot gas tetap (' + fmt(inp.tIn, 0) + ' °C). Feed tinggi menurunkan kWh/t karena beban tetap (fan, idle) terbagi lebih banyak ton.</p>';
        $('btnApplyOpt').disabled = false;
      }, 30);
    });
    $('btnApplyOpt').addEventListener('click', function () {
      if (!lastOpt || !lastOpt.ok) return;
      Sim.setOps({ feed: Math.round(lastOpt.feed), sepRpm: Math.round(lastOpt.sepRpm * 2) / 2, pressure: Math.round(lastOpt.pressure) });
      syncSliders(true);
      this.disabled = true;
    });
  }

  /* =================================================================
     14. Sustainability
     ================================================================= */

  var HOURS_YEAR = 7500;
  function renderSustainability(v) {
    var ss = v.product > 1 ? v.product : 0;
    var cards = [
      { l: 'Energi listrik spesifik', v: v.kwht, d: 1, u: 'kWh/t', lvl: 'info', s: 'mill + fan + separator' },
      { l: 'Daya total', v: (v.pMill + v.pFan + (v.pSep || 0)) / 1000, d: 2, u: 'MW', lvl: 'info', s: fmt(ss, 0) + ' t/h raw meal' },
      { l: 'Panas pengeringan', v: v.mjt, d: 0, u: 'MJ/t', lvl: 'info', s: 'panas diserahkan hot gas' },
      { l: 'CO₂ listrik', v: v.co2Elec, d: 1, u: 'kg/t', lvl: 'info', s: 'EF grid ' + fmt(cfg.coef.efGrid, 2) + ' kg/kWh' },
      { l: 'CO₂ pemanasan', v: v.co2Heat, d: 1, u: 'kg/t', lvl: 'info', s: fmt(cfg.coef.fuelHeatFrac * 100, 0) + ' % panas dari bahan bakar' },
      { l: 'CO₂ total (indikatif)', v: v.co2, d: 1, u: 'kg/t', lvl: 'info', s: fmt(v.co2 * ss * HOURS_YEAR / 1000, 0) + ' t CO₂/tahun' }
    ];
    $('susKpi').innerHTML = cards.map(kpiHtml).join('');
    // Rincian energi
    var parts = [['Motor mill', v.pMill], ['Mill fan', v.pFan], ['Separator', v.pSep || 0]];
    var tot = parts.reduce(function (a, p) { return a + p[1]; }, 0) || 1;
    $('energyBreak').innerHTML = parts.map(function (p) {
      return '<div class="bar-row"><span>' + p[0] + '</span><div class="bar-track"><div class="bar-fill" style="width:' + (p[1] / tot * 100).toFixed(1) + '%"></div></div><span class="v">' + fmt(ss ? p[1] / ss : 0, 2) + ' kWh/t</span></div>';
    }).join('') + '<p class="muted small">Pangsa: ' + parts.map(function (p) { return p[0] + ' ' + fmt(p[1] / tot * 100, 0) + ' %'; }).join(' · ') + '. Daya fan ∝ aliran × (DP mill + DP sistem).</p>';

    // Potensi penghematan bila R90 dilonggarkan
    var inp = Sim.currentInputs(), chem = Sim.effectiveChem(), T = cfg.targets;
    var base = M.steadyState(inp, chem, cfg);
    var rows = [0, 1, 2, 3].map(function (dlt) {
      var rpm = M.rpmForR90(inp, chem, cfg, T.r90 + dlt);
      var r = M.steadyState(Object.assign({}, inp, { sepRpm: rpm }), chem, cfg);
      return { d: dlt, rpm: rpm, r: r };
    });
    // Baris pertama = operasi saat ini (basis), lalu R90 = spec, spec+1, +2, +3
    rows.unshift({ d: null, rpm: inp.sepRpm, r: base });
    $('relaxR90').innerHTML = '<table><tr><th>R90</th><th>Rpm sep. (%)</th><th>kWh/t</th><th>Δ kWh/t</th><th>Hemat MWh/tahun</th><th>Hemat t CO₂/tahun</th></tr>' +
      rows.map(function (x) {
        var dk = x.r.kwht - base.kwht;
        var mwh = -dk * x.r.product * HOURS_YEAR / 1000;
        var lbl = x.d === null ? fmt(base.r90, 1) + ' % (saat ini)' : fmt(T.r90 + x.d, 1) + ' %' + (x.d === 0 ? ' (= spec)' : ' (spec +' + x.d + ')');
        return '<tr><td>' + lbl + '</td><td class="num">' + fmt(x.rpm, 1) + '</td><td class="num">' + fmt(x.r.kwht, 2) + '</td><td class="num">' + fmt(dk, 2) +
          '</td><td class="num">' + fmt(mwh, 0) + '</td><td class="num">' + fmt(mwh * cfg.coef.efGrid, 0) + '</td></tr>';
      }).join('') + '</table><p class="muted small">Steady-state dengan input operasi saat ini, hanya rpm separator yang diubah; ' + fmt(HOURS_YEAR, 0) +
      ' jam operasi/tahun. Nilai negatif = konsumsi bertambah. Melonggarkan R90 menghemat energi mill tetapi bisa menaikkan konsumsi panas kiln — lihat dampak di bawah.</p>';

    // Dampak ke kiln (indikatif)
    var dQ = cfg.coef.kilnHeatPerR90 * (v.r90 - 12);
    var b = chem.bogue;
    $('kilnImpact').innerHTML = '<ul class="tips">' +
      '<li>Perubahan panas kiln indikatif vs R90 12 %: <b>' + (dQ >= 0 ? '+' : '') + fmt(dQ, 0) + ' MJ/t klinker</b> (asumsi ' + fmt(cfg.coef.kilnHeatPerR90, 0) + ' MJ/t per 1 % R90).</li>' +
      '<li>R200 ' + fmt(v.r200, 2) + ' %: ' + (v.r200 > T.r200 ? '<span class="st-alarm">partikel kasar (terutama kuarsa > 45 µm) berisiko menaikkan free lime.</span>' : '<span class="st-ok">fraksi kasar terkendali.</span>') + '</li>' +
      '<li>LSF ' + fmt(v.lsf, 1) + ' & C₃S ' + fmt(b.C3S, 0) + ' %: ' + (v.lsf > T.lsf + 1 ? 'LSF tinggi menuntut kehalusan lebih baik untuk burnability yang sama.' : 'kebutuhan kehalusan wajar untuk LSF ini.') + '</li>' +
      '<li>Stabilitas LSF (σ 10 menit ' + fmt(v.kiln ? v.kiln.lsfSd : 0, 2) + '): variasi tinggi membuat operasi kiln tidak stabil, lebih penting daripada nilai rata-rata.</li>' +
      '</ul><p class="muted small">Semua angka dampak kiln bersifat indikatif dan perlu dikalibrasi dengan uji burnability plant.</p>';

    // Saran efisiensi otomatis
    var tips = [];
    if (v.running && v.r90 < T.r90 - 2) {
      var rpmT = M.rpmForR90(inp, chem, cfg, T.r90 - 0.5);
      var rr = M.steadyState(Object.assign({}, inp, { sepRpm: rpmT }), chem, cfg);
      tips.push('R90 ' + fmt(v.r90, 1) + ' % jauh di bawah spec ' + fmt(T.r90, 1) + ' % (over-grinding). Turunkan rpm separator ke ±' + fmt(rpmT, 1) + ' % → hemat ±' + fmt(base.kwht - rr.kwht, 2) + ' kWh/t.');
    }
    if (v.running && v.loadRatio < 0.85) tips.push('Mill kurang beban (load ratio ' + fmt(v.loadRatio, 2) + '). Naikkan feed agar beban tetap (fan, idle motor) terbagi ke lebih banyak ton.');
    if (v.running && v.loadRatio > 1.1) tips.push('Mill overload (load ratio ' + fmt(v.loadRatio, 2) + '). Kurangi feed atau naikkan tekanan gilas — sirkulasi berlebih memboroskan daya fan.');
    if (Sim.ops.fan > 85 && v.dp < 45) tips.push('Fan ' + fmt(Sim.ops.fan, 0) + ' % dengan DP hanya ' + fmt(v.dp, 1) + ' mbar. Turunkan fan (daya fan turun tajam) bila kecepatan nozzle tetap > 35 m/s.');
    if (v.tOut > Sim.ops.tOutSP + 5 || v.tOut > 100) tips.push('Suhu outlet ' + fmt(v.tOut, 1) + ' °C lebih tinggi dari perlu. Kurangi hot gas: panas terbuang ke stack.');
    var sprayMJ = ss ? Sim.ops.spray * 2.7 / ss : 0;
    if (Sim.ops.spray > 3000 && v.vib < 4) tips.push('Water spray ' + fmt(Sim.ops.spray, 0) + ' L/h saat bed stabil menyerap ±' + fmt(sprayMJ, 0) + ' MJ/t panas. Kurangi bertahap sambil memantau getaran.');
    if (v.bed > 100) tips.push('Bed tebal (' + fmt(v.bed, 0) + ' mm) menaikkan daya gilas spesifik. Pertimbangkan dam ring lebih rendah.');
    if (v.mjt > 250) tips.push('Konsumsi panas ' + fmt(v.mjt, 0) + ' MJ/t tinggi. Periksa false air dan moisture umpan (penyimpanan clay tertutup mengurangi beban pengeringan).');
    if (v.kwht > 0 && !tips.length) tips.push('Operasi relatif efisien menurut model. Coba Optimizer di tab Skenario untuk mencari titik kWh/t lebih rendah.');
    if (!v.running) tips.push('Mill sedang berhenti — saran efisiensi tidak relevan.');
    $('susTips').innerHTML = tips.map(function (t) { return '<li>' + esc(t) + '</li>'; }).join('');
  }

  /* =================================================================
     15. Kalibrasi: spesifikasi mill, koefisien, CSV plant
     ================================================================= */

  var SPEC_FIELDS = [
    ['tableDiameter', 'Diameter meja', 'm', 3, 8, 2], ['rollers', 'Jumlah roller', '', 2, 6, 0], ['designCapacity', 'Kapasitas desain', 't/h', 100, 800, 0],
    ['motorPower', 'Daya motor mill', 'kW', 1000, 10000, 0], ['tableRpm', 'Kecepatan meja', 'rpm', 15, 40, 1], ['separatorMaxRpm', 'Rpm maks separator', 'rpm', 40, 200, 0],
    ['gasFlowNominal', 'Aliran gas nominal (fan 100 %)', 'Am³/h', 200000, 1500000, 0], ['maxGasInlet', 'Suhu gas inlet maks', '°C', 200, 450, 0], ['nominalPressure', 'Tekanan hidrolik nominal', 'bar', 50, 140, 0]
  ];
  var COEF_FIELDS = [
    ['xRef', 'x′ referensi (Rosin-Rammler)', 'µm', 'Paling berpengaruh pada R90. Kalibrasi dulu dengan R90 lab.'],
    ['expRpm', 'Eksponen rpm separator', '', 'Sensitivitas R90 terhadap rpm.'],
    ['expGas', 'Eksponen aliran gas', '', 'Sensitivitas R90 terhadap fan.'],
    ['nRef', 'n Rosin-Rammler', '', 'Kemiringan PSD; atur dengan rasio R90/R200.'],
    ['eRef', 'Energi gilas referensi', 'kWh/t', 'Mengatur kapasitas & load ratio.'],
    ['kPowerPerBar', 'Daya per bar tekanan', 'kW/bar', 'Kalibrasi dengan daya motor mill aktual.'],
    ['pMillIdle', 'Daya idle mill', 'kW', ''],
    ['kBedDam', 'Bed per mm dam ring', 'mm/mm', 'Kalibrasi dengan pengukuran lift roller.'],
    ['clRef', 'Circulating load referensi', '–', ''],
    ['dpGas', 'DP akibat gas', 'mbar', 'Kalibrasi DP saat mill kosong.'],
    ['dpLoad', 'DP akibat material', 'mbar', 'Kalibrasi DP saat beban normal.'],
    ['dpSystem', 'DP sistem (siklon, filter)', 'mbar', 'Untuk daya fan.'],
    ['fanEff', 'Efisiensi fan', '–', ''],
    ['bedMinStable', 'Bed minimum stabil', 'mm', 'Di bawah ini getaran naik.'],
    ['kVibThin', 'Koef. getaran bed tipis', '', ''],
    ['heatLoss', 'Rugi panas dinding', 'kW', 'Kalibrasi suhu outlet.'],
    ['falseAirFrac', 'Fraksi false air', '–', ''],
    ['moistRef', 'Moisture produk @ 90 °C', '%', ''],
    ['efGrid', 'EF listrik grid', 'kg CO₂/kWh', ''],
    ['fuelHeatFrac', 'Fraksi panas dari bahan bakar', '–', '0 = seluruhnya waste heat kiln.'],
    ['kilnHeatPerR90', 'Panas kiln per 1 % R90', 'MJ/t klinker', 'Indikatif.']
  ];
  function buildCalibration() {
    var sf = $('millSpecForm'); sf.innerHTML = '';
    SPEC_FIELDS.forEach(function (f) {
      sf.appendChild(labeled(f[1], makeNum(cfg.mill[f[0]], f[3], f[4], f[5], function (v) {
        cfg.mill[f[0]] = f[0] === 'rollers' ? Math.round(v) : v;
        if (f[0] === 'maxGasInlet') { Sim.ops.tIn = Math.min(Sim.ops.tIn, v); cfg.pid.temp.max = Math.min(VRM.DEFAULT_PID.temp.max, v); }
        syncSliders(true);
      }), f[2]));
    });
    var cf = $('coefForm'); cf.innerHTML = '';
    COEF_FIELDS.forEach(function (f) {
      var d = VRM.DEFAULT_COEF[f[0]];
      var mx = d < 2 ? Math.max(1, d * 4) : d * 4;
      cf.appendChild(labeled(f[1], makeNum(cfg.coef[f[0]], 0, mx, d < 1 ? 3 : 2, function (v) { cfg.coef[f[0]] = v; }), f[2], f[3] || null));
    });
  }
  function bindCalibration() {
    $('btnSpecDefault').addEventListener('click', function () { Object.assign(cfg.mill, VRM.deepCopy(VRM.DEFAULT_MILL_SPEC)); cfg.pid.temp.max = VRM.DEFAULT_PID.temp.max; buildCalibration(); syncSliders(true); });
    $('btnCoefDefault').addEventListener('click', function () { Object.assign(cfg.coef, VRM.deepCopy(VRM.DEFAULT_COEF)); buildCalibration(); });
    $('btnCsvTemplate').addEventListener('click', function () {
      download('template_data_plant.csv', makeSampleCsv(), 'text/csv');
    });
    $('btnCsvDemo').addEventListener('click', function () { runCalibration(makeSampleCsv(), 'data contoh sintetis'); });
    $('plantCsv').addEventListener('change', function () {
      var f = this.files[0]; if (!f) return;
      var r = new FileReader();
      r.onload = function () {
        try { runCalibration(String(r.result), f.name); }
        catch (e) { $('calResult').innerHTML = '<div class="msg err">✕ Gagal membaca CSV: ' + esc(e.message) + '</div>'; }
      };
      r.readAsText(f);
      this.value = '';
    });
  }
  // Data contoh sintetis (model + noise acak) — untuk template & mencoba fitur kalibrasi
  function makeSampleCsv() {
    var chem = Sim.effectiveChem(), base = Sim.currentInputs();
    var lines = ['feed,pressure,dam,sepRpm,fan,tIn,spray,R90,R200,kWh_t,DP,tOut,moist'];
    function n(v, s) { return (v * (1 + (Math.random() - 0.5) * 2 * s)).toFixed(3); }
    for (var i = 0; i < 40; i++) {
      var x = Object.assign({}, base, {
        feed: Math.round(330 + Math.random() * 120), pressure: Math.round(85 + Math.random() * 25), sepRpm: +(60 + Math.random() * 20).toFixed(1),
        fan: +(74 + Math.random() * 12).toFixed(1), tIn: Math.round(205 + Math.random() * 40)
      });
      var r = M.steadyState(x, chem, cfg);
      lines.push([x.feed, x.pressure, x.dam, x.sepRpm, x.fan, x.tIn, x.spray, n(r.r90, 0.06), n(r.r200, 0.12), n(r.kwht, 0.03), n(r.dp, 0.04), n(r.tOut, 0.015), n(r.moistOut, 0.15)].join(','));
    }
    return lines.join('\n');
  }
  var CSV_ALIAS = {
    feed: ['feed', 'feed_tph', 'feedrate'], pressure: ['pressure', 'tekanan', 'grinding_pressure'], dam: ['dam', 'dam_ring'], sepRpm: ['seprpm', 'separator', 'sep_rpm'],
    fan: ['fan', 'fan_speed'], tIn: ['tin', 't_in', 'gas_inlet'], spray: ['spray', 'water_spray'],
    R90: ['r90'], R200: ['r200'], kWh_t: ['kwh_t', 'kwht', 'kwh/t', 'kwh_per_t'], DP: ['dp', 'dp_mbar'], tOut: ['tout', 't_out', 'outlet_temp'], moist: ['moist', 'moisture', 'h2o']
  };
  function runCalibration(text, name) {
    var lines = text.replace(/\r/g, '').split('\n').filter(function (l) { return l.trim(); });
    if (lines.length < 3) throw new Error('minimal 1 baris header + 2 baris data');
    var delim = lines[0].indexOf(';') >= 0 ? ';' : ',';
    var hdr = lines[0].split(delim).map(function (h) { return h.trim().toLowerCase(); });
    var idx = {};
    Object.keys(CSV_ALIAS).forEach(function (k) {
      for (var i = 0; i < hdr.length; i++) if (CSV_ALIAS[k].indexOf(hdr[i]) >= 0) { idx[k] = i; break; }
    });
    var outs = [['R90', 'r90', '%'], ['R200', 'r200', '%'], ['kWh_t', 'kwht', 'kWh/t'], ['DP', 'dp', 'mbar'], ['tOut', 'tOut', '°C'], ['moist', 'moistOut', '%']].filter(function (o) { return idx[o[0]] !== undefined; });
    if (!outs.length) throw new Error('tidak ada kolom aktual (R90, R200, kWh_t, DP, tOut, moist)');
    var chem = Sim.effectiveChem(), base = Sim.currentInputs();
    var pairs = {}; outs.forEach(function (o) { pairs[o[0]] = []; });
    var used = 0;
    lines.slice(1).forEach(function (ln) {
      var c = ln.split(delim);
      var val = function (k) { return idx[k] === undefined ? NaN : parseNum(delim === ';' ? c[idx[k]] : String(c[idx[k]]).replace(',', '.')); };
      var x = Object.assign({}, base);
      ['feed', 'pressure', 'dam', 'sepRpm', 'fan', 'tIn', 'spray'].forEach(function (k) { var v = val(k); if (Number.isFinite(v)) x[k] = clamp(v, LIM[k].min, LIM[k].max); });
      var r = M.steadyState(x, chem, cfg);
      used++;
      outs.forEach(function (o) { var a = val(o[0]); if (Number.isFinite(a) && Number.isFinite(r[o[1]])) pairs[o[0]].push({ x: a, y: r[o[1]] }); });
    });
    var rowsHtml = '', charts = '';
    outs.forEach(function (o, i) {
      var p = pairs[o[0]]; if (p.length < 2) return;
      var n = p.length, mean = p.reduce(function (a, q) { return a + q.x; }, 0) / n;
      var ssRes = 0, ssTot = 0, abs = 0, bias = 0;
      p.forEach(function (q) { var e = q.y - q.x; ssRes += e * e; ssTot += (q.x - mean) * (q.x - mean); abs += Math.abs(e); bias += e; });
      var r2 = ssTot > 0 ? 1 - ssRes / ssTot : NaN;
      var cls = r2 >= 0.8 ? 'st-ok' : r2 >= 0.5 ? 'st-warn' : 'st-alarm';
      rowsHtml += '<tr><td>' + o[0] + ' (' + o[2] + ')</td><td class="num">' + n + '</td><td class="num ' + cls + '">' + fmt(r2, 3) + '</td><td class="num">' + fmt(Math.sqrt(ssRes / n), 3) + '</td><td class="num">' + fmt(abs / n, 3) + '</td><td class="num">' + fmt(bias / n, 3) + '</td></tr>';
      charts += '<div id="calc' + i + '"></div>';
    });
    $('calResult').innerHTML = '<div class="msg ok">✓ ' + esc(name) + ': ' + used + ' baris diproses.</div>' +
      '<table><tr><th>Variabel</th><th>n</th><th>R²</th><th>RMSE</th><th>MAE</th><th>Bias (prediksi − aktual)</th></tr>' + rowsHtml + '</table>' +
      '<p class="muted small">R² &lt; 0,5 → koefisien terkait perlu dikalibrasi (lihat README, bagian "Koefisien yang perlu dikalibrasi"). Bias konsisten → geser koefisien referensi (mis. x′ ref untuk R90, heatLoss untuk suhu outlet).</p>' +
      '<div class="trend-grid">' + charts + '</div>';
    outs.forEach(function (o, i) {
      var el = $('calc' + i); if (!el) return;
      drawChart(el, { title: o[0] + ': prediksi (Y) vs aktual (X)', data: pairs[o[0]], type: 'scatter', diag: true, unit: o[2], height: 200, xDec: 1, tipX: function (x) { return 'aktual ' + fmt(x, 2); } });
    });
  }

  /* =================================================================
     16. Ekspor CSV & laporan cetak
     ================================================================= */

  function exportCsv() {
    var h = Sim.history;
    var cols = ['t', 'feed', 'feedMill', 'pressure', 'dam', 'sepRpm', 'fan', 'tIn', 'spray', 'bed', 'dp', 'vib', 'tOut', 'r90', 'r200', 'lsf', 'sm', 'am', 'moist', 'product', 'pMill', 'pFan', 'kwht', 'co2', 'running'];
    var lines = ['waktu,' + cols.join(',')];
    h.forEach(function (r) {
      lines.push(hms(r.t) + ',' + cols.map(function (c) { var v = r[c]; return Number.isFinite(v) ? (+v.toFixed(4)).toString() : ''; }).join(','));
    });
    download('vrm_simulasi_' + hms(Sim.state.t).replace(/:/g, '') + '.csv', lines.join('\n'), 'text/csv');
  }

  function printReport() {
    var v = Sim.view(), o = Sim.ops, T = cfg.targets;
    function tr(a, b) { return '<tr><td>' + a + '</td><td>' + b + '</td></tr>'; }
    var html = '<h1>Laporan Simulasi VRM Raw Mill – LM 59.42</h1>' +
      '<div class="note">Dicetak ' + new Date().toLocaleString('id-ID') + ' · waktu simulasi ' + hms(v.t) + ' · mode ' + (o.autoMode ? 'Auto (PID)' : 'Manual') + '</div>' +
      '<p class="note">Model semi-empiris untuk edukasi dan analisis what-if, bukan digital twin tervalidasi. Spesifikasi mill adalah asumsi.</p>' +
      '<h2>Parameter operasi</h2><table>' + tr('Feed', fmt(o.feed, 0) + ' t/h') + tr('Tekanan gilas', fmt(o.pressure, 0) + ' bar') + tr('Dam ring', fmt(o.dam, 0) + ' mm') +
      tr('Rpm separator', fmt(o.sepRpm, 1) + ' %') + tr('Fan', fmt(o.fan, 1) + ' %') + tr('Suhu hot gas inlet', fmt(v.tIn, 0) + ' °C') + tr('Setpoint suhu outlet', fmt(o.tOutSP, 1) + ' °C') + tr('Water spray', fmt(o.spray, 0) + ' L/h') + '</table>' +
      '<h2>Kualitas & proses</h2><table><tr><th>Indikator</th><th>Nilai</th><th>Target</th></tr>' +
      '<tr><td>Throughput</td><td>' + fmt(v.product, 0) + ' t/h</td><td>–</td></tr>' +
      '<tr><td>R90 / R200</td><td>' + fmt(v.r90, 1) + ' % / ' + fmt(v.r200, 2) + ' %</td><td>≤ ' + fmt(T.r90, 1) + ' / ≤ ' + fmt(T.r200, 1) + ' %</td></tr>' +
      '<tr><td>LSF / SM / AM</td><td>' + fmt(v.lsf, 1) + ' / ' + fmt(v.sm, 2) + ' / ' + fmt(v.am, 2) + '</td><td>' + fmt(T.lsf, 1) + ' / ' + fmt(T.sm, 2) + ' / ' + fmt(T.am, 2) + '</td></tr>' +
      '<tr><td>Moisture raw meal</td><td>' + fmt(v.moistOut, 2) + ' %</td><td>≤ ' + fmt(T.moist, 1) + ' %</td></tr>' +
      '<tr><td>DP / getaran</td><td>' + fmt(v.dp, 1) + ' mbar / ' + fmt(v.vib, 1) + ' mm/s</td><td>–</td></tr>' +
      '<tr><td>Suhu outlet / tebal bed</td><td>' + fmt(v.tOut, 1) + ' °C / ' + fmt(v.bed, 0) + ' mm</td><td>–</td></tr>' +
      '<tr><td>Energi</td><td>' + fmt(v.kwht, 2) + ' kWh/t · ' + fmt(v.mjt, 0) + ' MJ/t</td><td>–</td></tr>' +
      '<tr><td>CO₂ indikatif</td><td>' + fmt(v.co2, 1) + ' kg/t</td><td>–</td></tr>' +
      '<tr><td>Skor kesehatan / kesiapan kiln</td><td>' + v.health + ' / ' + (v.kiln && v.kiln.ready ? 'SIAP' : 'BELUM SIAP') + '</td><td>–</td></tr></table>' +
      '<h2>Material</h2><table><tr><th>Komponen</th><th>Proporsi %</th><th>Moisture %</th><th>BWI</th><th>CaO</th><th>SiO2</th><th>Al2O3</th><th>Fe2O3</th></tr>' +
      Sim.materials.map(function (m) { return '<tr><td>' + esc(m.name) + '</td><td>' + fmt(m.prop, 2) + '</td><td>' + fmt(m.moist, 1) + '</td><td>' + fmt(m.bwi, 1) + '</td><td>' + fmt(m.ox.CaO, 2) + '</td><td>' + fmt(m.ox.SiO2, 2) + '</td><td>' + fmt(m.ox.Al2O3, 2) + '</td><td>' + fmt(m.ox.Fe2O3, 2) + '</td></tr>'; }).join('') + '</table>' +
      '<h2>Alarm aktif</h2>' + ((v.alarms || []).length ? '<table>' + v.alarms.map(function (a) { return tr(LVL_TEXT[a.level], esc(a.title) + ' — ' + esc(a.hint)); }).join('') + '</table>' : '<p>Tidak ada alarm.</p>');
    $('printReport').innerHTML = html;
    window.print();
  }

  /* =================================================================
     17. Tampilan 3D: kontrol sudut, zoom, label
     ================================================================= */

  function bindMillView() {
    VRM.Mill3D.init($('millView'));
    var ang = $('viewAngle');
    function setA(d) { VRM.Mill3D.setAngle(d); ang.value = Math.round(d); $('viewAngleVal').textContent = Math.round(d) + '°'; }
    ang.addEventListener('input', function () { setA(+ang.value); });
    VRM.Mill3D.onAngle(function (d) { ang.value = Math.round(d); $('viewAngleVal').textContent = Math.round(d) + '°'; });
    $('viewSeg').addEventListener('click', function (e) { var b = e.target.closest('button'); if (b) animateAngle(+b.dataset.a); });
    $('zoomIn').addEventListener('click', function () { VRM.Mill3D.zoom(1 / 1.2); });
    $('zoomOut').addEventListener('click', function () { VRM.Mill3D.zoom(1.2); });
    $('viewReset').addEventListener('click', function () { VRM.Mill3D.resetView(); setA(0); });
    $('chkLabels').addEventListener('change', function () { VRM.Mill3D.setLabels(this.checked); });
    function animateAngle(target) {
      var start = VRM.Mill3D.getAngle(), diff = ((target - start + 540) % 360) - 180, t0 = performance.now();
      (function stepA(now) {
        var k = Math.min(1, (now - t0) / 600), e = k < 0.5 ? 2 * k * k : 1 - Math.pow(-2 * k + 2, 2) / 2;
        setA(start + diff * e);
        if (k < 1) requestAnimationFrame(stepA);
      })(t0);
    }
  }

  /* =================================================================
     18. Loop utama
     ================================================================= */

  var lastFrame = performance.now(), lastFast = 0, lastSlow = 0, lastAlarmCount = -1;
  function fastUpdate(v) {
    updateHeader(v);
    renderKpis(v);
    var key = (v.alarms || []).map(function (a) { return a.id + a.level + a.title; }).join('|');
    if (key !== lastAlarmCount) {
      lastAlarmCount = key;
      $('alarmList3d').innerHTML = alarmListHtml(v.alarms, false);
      $('alarmListQual').innerHTML = alarmListHtml(v.alarms, true);
    }
    $('kilnReady3d').innerHTML = kilnHtml(v);
    if (activeTab === 'tab3d') updateFlowsheet(v);
    syncSliders(false);
    syncDisturb();
  }
  function slowUpdate(force) {
    var v = Sim.view();
    if (activeTab === 'tabQual') { $('healthBig').innerHTML = healthHtml(v); $('kilnReady').innerHTML = kilnHtml(v); renderTrends(); renderPsd(v); renderKpis(v); }
    if (activeTab === 'tabOps') renderAlarmLog();
    if (activeTab === 'tabScen') renderScenarioTable();
    if (activeTab === 'tabSus') renderSustainability(v);
    if (activeTab === 'tab3d' && force) updateFlowsheet(v);
  }
  function frame(now) {
    var dt = Math.min(0.25, (now - lastFrame) / 1000);
    lastFrame = now;
    try {
      Sim.tick(dt);
      var v = Sim.view();
      VRM.Mill3D.update(v, Sim.settings.playing ? dt : 0);
      if (now - lastFast > 250) { lastFast = now; fastUpdate(v); }
      if (now - lastSlow > 1000) { lastSlow = now; slowUpdate(false); }
    } catch (e) {
      console.error(e);
    }
    requestAnimationFrame(frame);
  }

  /* =================================================================
     Inisialisasi
     ================================================================= */

  /**
   * Deep-link lewat hash URL, contoh:
   *   index.html#tab=tabQual&steps=900&angle=90&auto=1&dist=wetClay&action=sweep
   * steps = jumlah detik simulasi yang dijalankan langsung saat dibuka.
   */
  function applyHash() {
    var hp;
    try { hp = new URLSearchParams(location.hash.slice(1)); } catch (e) { return; }
    if (hp.get('auto') === '1') { Sim.setAuto(true); setModeUI(); }
    (hp.get('dist') || '').split(',').forEach(function (k) { if (k in Sim.disturb) Sim.disturb[k] = true; });
    ['feed', 'pressure', 'dam', 'sepRpm', 'fan', 'tIn', 'spray'].forEach(function (k) {
      if (hp.get(k) !== null && Number.isFinite(+hp.get(k))) setOp(k, +hp.get(k));
    });
    var n = Math.min(14400, Math.max(0, parseInt(hp.get('steps') || '0', 10) || 0));
    for (var i = 0; i < n; i++) Sim.step();
    if (hp.get('angle') !== null) {
      var a = ((+hp.get('angle') || 0) % 360 + 360) % 360;
      VRM.Mill3D.setAngle(a); $('viewAngle').value = a; $('viewAngleVal').textContent = Math.round(a) + '°';
    }
    var tab = hp.get('tab');
    if (tab) { var b = document.querySelector('#tabs button[data-tab="' + tab + '"]'); if (b) b.click(); }
    var act = hp.get('action');
    if (act === 'sweep') runSweep();
    if (act === 'optimize') $('btnOptimize').click();
    if (act === 'solve') $('btnSolve').click();
    if (act === 'caldemo') $('btnCsvDemo').click();
    if (act === 'preset' && hp.get('preset')) { var p = PRESETS.filter(function (x) { return x.id === hp.get('preset'); })[0]; if (p) { p.fn(); buildMaterialTable(); } }
    syncSliders(true);
  }

  function init() {
    buildSliders();
    bindHeader();
    bindTabs();
    bindMillView();
    buildDisturb('distQuick'); buildDisturb('distFull');
    buildTargetForms();
    buildMaterialTable();
    bindMaterial();
    buildOpsTab();
    buildTrends();
    buildPresets();
    buildScenarioButtons();
    bindSweep();
    bindOptimizer();
    buildCalibration();
    bindCalibration();
    setModeUI();
    applyHash();
    fastUpdate(Sim.view());
    var resizeT;
    window.addEventListener('resize', function () { clearTimeout(resizeT); resizeT = setTimeout(function () { slowUpdate(true); }, 200); });
    requestAnimationFrame(frame);
  }
  init();
})();
