/* =====================================================================
   model.js — Fungsi MURNI model proses (tanpa DOM, tanpa state global)
   ---------------------------------------------------------------------
   Isi:
   1. Utilitas angka aman (clamp, safe)
   2. Kimia raw meal (oksida campuran, LSF/SM/AM, Bogue)
   3. Mix design solver (coordinate search)
   4. Model steady-state mill: bed, kapasitas, circulating load, PSD,
      DP, daya, getaran, neraca panas & drying, energi & CO₂
   5. Sweep parameter dan optimizer sederhana

   Semua rumus dijelaskan juga di README.md.
   Model ini SEMI-EMPIRIS untuk edukasi & what-if, BUKAN digital twin.
   ===================================================================== */

window.VRM = window.VRM || {};

VRM.Model = (function () {

  /* ---------------- 1. Utilitas ---------------- */

  // Batasi nilai ke rentang [min, max]; NaN/Infinity diganti nilai fallback
  function clamp(v, min, max, fallback) {
    if (!Number.isFinite(v)) v = (fallback !== undefined) ? fallback : min;
    return Math.min(max, Math.max(min, v));
  }

  // Pastikan angka valid (bukan NaN/Infinity)
  function safe(v, fallback) {
    return Number.isFinite(v) ? v : (fallback || 0);
  }

  // Pangkat aman untuk basis kecil/negatif
  function pow(b, e) { return Math.pow(Math.max(b, 1e-9), e); }

  /* ---------------- 2. Kimia raw meal ---------------- */

  // Normalisasi proporsi agar total 100 %
  function normalizeProps(props) {
    var p = props.map(function (v) { return Math.max(0, safe(v, 0)); });
    var sum = p.reduce(function (a, b) { return a + b; }, 0);
    if (sum <= 0) return p.map(function () { return 100 / p.length; });
    return p.map(function (v) { return v * 100 / sum; });
  }

  // Modul kimia dari oksida (basis apapun, karena berupa rasio)
  function moduli(ox) {
    var denomLsf = 2.8 * ox.SiO2 + 1.18 * ox.Al2O3 + 0.65 * ox.Fe2O3;
    return {
      lsf: safe(100 * ox.CaO / denomLsf, 0),
      sm: safe(ox.SiO2 / (ox.Al2O3 + ox.Fe2O3), 0),
      am: safe(ox.Al2O3 / ox.Fe2O3, 0)
    };
  }

  // Bogue sederhana (basis klinker = bebas LOI), hasil diklamp ≥ 0
  function bogue(oxLF) {
    var C = oxLF.CaO, S = oxLF.SiO2, A = oxLF.Al2O3, F = oxLF.Fe2O3, SO3 = oxLF.SO3;
    var c3s = 4.071 * C - 7.600 * S - 6.718 * A - 1.430 * F - 2.852 * SO3;
    var c2s = 2.867 * S - 0.7544 * Math.max(c3s, 0);
    var c3a = 2.650 * A - 1.692 * F;
    var c4af = 3.043 * F;
    return {
      C3S: Math.max(0, c3s), C2S: Math.max(0, c2s),
      C3A: Math.max(0, c3a), C4AF: Math.max(0, c4af)
    };
  }

  /**
   * Hitung kimia campuran.
   * @param materials array {prop, moist, bwi, size, ox:{...}}
   * @param propsOverride (opsional) proporsi pengganti
   * Proporsi dianggap basis KERING.
   */
  function mixChemistry(materials, propsOverride) {
    var props = normalizeProps(propsOverride || materials.map(function (m) { return m.prop; }));
    var ox = {};
    VRM.OXIDES.forEach(function (k) { ox[k] = 0; });
    var moist = 0, bwi = 0, size = 0;
    materials.forEach(function (m, i) {
      var f = props[i] / 100;
      VRM.OXIDES.forEach(function (k) { ox[k] += f * safe(m.ox[k], 0); });
      moist += f * safe(m.moist, 0);
      bwi += f * safe(m.bwi, 10);
      if (props[i] > 0.5) size = Math.max(size, safe(m.size, 0));
    });
    // Basis bebas LOI (≈ komposisi klinker)
    var lf = 1 - ox.LOI / 100;
    var oxLF = {};
    VRM.OXIDES.forEach(function (k) { oxLF[k] = (k === 'LOI') ? 0 : safe(ox[k] / lf, 0); });
    var mod = moduli(ox);
    return {
      props: props, ox: ox, oxLF: oxLF,
      lsf: mod.lsf, sm: mod.sm, am: mod.am,
      bogue: bogue(oxLF),
      moist: moist, bwi: bwi, maxSize: size,
      sumOx: VRM.OXIDES.reduce(function (a, k) { return a + ox[k]; }, 0)
    };
  }

  /* ---------------- 3. Mix design solver ---------------- */

  // Fungsi objektif: kuadrat selisih ternormalisasi terhadap toleransi
  function mixObjective(chem, t) {
    var a = (chem.lsf - t.lsf) / Math.max(t.lsfTol, 0.1);
    var b = (chem.sm - t.sm) / Math.max(t.smTol, 0.01);
    var c = (chem.am - t.am) / Math.max(t.amTol, 0.01);
    return a * a + b * b + c * c;
  }

  /**
   * Cari proporsi agar LSF/SM/AM mendekati target.
   * Metode: coordinate search berpasangan — pindahkan "step" % dari komponen j
   * ke komponen i bila objektif turun. Constraint ≥0 dan total=100 otomatis terjaga.
   * Dicoba dari beberapa titik awal (multi-start) lalu ambil yang terbaik.
   */
  function solveMix(materials, targets) {
    var n = materials.length;
    var starts = [
      normalizeProps(materials.map(function (m) { return m.prop; })),
      normalizeProps(materials.map(function () { return 1; })),
      normalizeProps([80, 15, 3, 2].slice(0, n))
    ];
    var best = null;
    starts.forEach(function (start) {
      var p = start.slice();
      var f = mixObjective(mixChemistry(materials, p), targets);
      var step = 5;
      var iter = 0;
      while (step > 0.002 && iter < 5000) {
        var improved = false;
        for (var i = 0; i < n; i++) {
          for (var j = 0; j < n; j++) {
            if (i === j || p[j] < 1e-9) continue;
            var d = Math.min(step, p[j]);
            var q = p.slice(); q[i] += d; q[j] -= d;
            var fq = mixObjective(mixChemistry(materials, q), targets);
            iter++;
            if (fq < f - 1e-12) { p = q; f = fq; improved = true; }
          }
        }
        if (!improved) step /= 2;
      }
      if (!best || f < best.f) best = { p: p, f: f };
    });
    var chem = mixChemistry(materials, best.p);
    var dev = { lsf: chem.lsf - targets.lsf, sm: chem.sm - targets.sm, am: chem.am - targets.am };
    var feasible = Math.abs(dev.lsf) <= targets.lsfTol * 0.5 &&
                   Math.abs(dev.sm) <= targets.smTol * 0.5 &&
                   Math.abs(dev.am) <= targets.amTol * 0.5;
    var msg;
    if (feasible) {
      msg = 'Target tercapai dalam setengah toleransi.';
    } else {
      var hints = [];
      if (Math.abs(dev.lsf) > targets.lsfTol * 0.5) hints.push('LSF ' + (dev.lsf > 0 ? 'terlalu tinggi' : 'terlalu rendah'));
      if (Math.abs(dev.sm) > targets.smTol * 0.5) hints.push('SM ' + (dev.sm > 0 ? 'terlalu tinggi' : 'terlalu rendah'));
      if (Math.abs(dev.am) > targets.amTol * 0.5) hints.push('AM ' + (dev.am > 0 ? 'terlalu tinggi' : 'terlalu rendah'));
      msg = 'Target TIDAK feasible dengan 4 bahan ini (' + hints.join(', ') +
            '). Kombinasi oksida bahan baku tidak mampu mencapai target — ' +
            'pertimbangkan bahan korektif lain atau ubah target. Proporsi ditampilkan adalah kompromi terbaik.';
    }
    return { props: best.p, chem: chem, dev: dev, feasible: feasible, message: msg, objective: best.f };
  }

  /* ---------------- 4. Model steady-state mill ---------------- */

  // Rosin-Rammler: residu (%) di atas ukuran x (µm)
  function residue(x, xp, n) {
    return 100 * Math.exp(-pow(x / Math.max(xp, 0.1), n));
  }

  // Densitas gas (kg/m³) pada suhu T (°C), koreksi uap air ≈ 0,95
  function gasDensity(T) { return 1.293 * 273 / (273 + Math.max(T, -50)) * 0.95; }

  // Getaran (mm/s) sebagai fungsi tebal bed & kondisi operasi
  function vibration(bed, P, L, moistEff, running, cfg) {
    var c = cfg.coef;
    if (!running) return 0.3;
    var thin = c.kVibThin * pow(Math.max(0, c.bedMinStable - bed), 1.2);
    var press = c.kVibPress * Math.max(0, P - 110) * (75 / Math.max(bed, 20));
    var thick = c.kVibThick * Math.max(0, bed - 120);
    var over = c.kVibOverload * Math.max(0, L - 1.1);
    var dry = c.kVibDry * Math.max(0, 2.5 - moistEff);
    return c.vibBase + thin + press + thick + over + dry;
  }

  /**
   * Hitung kondisi tunak mill.
   * @param inp  {feed, pressure, dam, sepRpm, fan, tIn, spray, running}
   * @param chem hasil mixChemistry (dipakai: moist, bwi)
   * @param cfg  VRM.CONFIG
   * @param opts {bed: angka} → pakai tebal bed tertentu (untuk dinamika),
   *             tanpa opts → bed dicari dengan iterasi titik tetap
   */
  function steadyState(inp, chem, cfg, opts) {
    opts = opts || {};
    var c = cfg.coef, mill = cfg.mill;
    var running = inp.running !== false;
    var scale = Math.max(mill.designCapacity, 1) / 400;          // skala ukuran mill
    var P = clamp(inp.pressure, 0, 200, 95);
    var dam = clamp(inp.dam, 0, 400, 150);
    var rpm = clamp(inp.sepRpm, 5, 100, 70);
    var fan = clamp(inp.fan, 0, 100, 80);
    var tIn = clamp(inp.tIn, 0, 600, 220);
    var spray = clamp(inp.spray, 0, 50000, 0);
    var feedWet = running ? clamp(inp.feed, 0, 2000, 0) : 0;
    var M = clamp(chem.moist, 0, 40, 5);                          // % moisture umpan
    var bwi = clamp(chem.bwi, 3, 30, 11);
    var feedDry = feedWet * (1 - M / 100);
    var feedRefDry = c.feedRef * scale * (1 - 5.6 / 100);

    // Aliran gas (kg/s): nominal Am³/h di outlet × densitas pada 90 °C
    var gasNom = mill.gasFlowNominal / 3600 * gasDensity(90);
    var gas = gasNom * fan / 100;
    var gr = Math.max(gas / (gasNom * 0.8), 0.05);                // rasio terhadap referensi
    var Pref = mill.nominalPressure;

    // Ukuran karakteristik dari separator (µm): ∝ 1/rpm, naik dengan aliran gas
    var xsep = c.xRef * pow(c.sepRef / rpm, c.expRpm) * pow(gr, c.expGas);

    // Fungsi lokal: semua besaran pada tebal bed tertentu
    function atBed(bed) {
      bed = clamp(bed, 1, 400, 75);
      var fBed = 1 + Math.pow((bed - c.bedOpt) / c.bedWidth, 2);   // efisiensi gilas vs bed
      var pGrind = running ? scale * c.kPowerPerBar * P * Math.sqrt(bed / 75) : 0;
      var eSpec = c.eRef * (bwi / c.bwiRef) * pow(c.xRef / xsep, 0.5) * fBed;
      var cap = Math.max(pGrind / eSpec, 1);                        // t/h kapasitas gilas efektif
      var L = feedDry / cap;                                        // load ratio
      var CL = c.clRef * pow(rpm / c.sepRef, c.expClRpm) * pow(L, c.expClLoad) * pow(gr, -c.expClGas);
      var loadIndex = (feedDry / feedRefDry) * (1 + CL) / (1 + c.clRef);
      var bedNew = c.kBedDam * dam * pow(loadIndex, c.expBedLoad) - c.kBedPress * (P - Pref);
      return { bed: bed, fBed: fBed, pGrind: pGrind, eSpec: eSpec, cap: cap, L: L, CL: CL,
               loadIndex: loadIndex, bedNew: clamp(bedNew, 0, 400, 0) };
    }

    var s;
    if (Number.isFinite(opts.bed)) {
      s = atBed(opts.bed);
    } else {
      var bed = c.bedOpt;
      for (var k = 0; k < 40; k++) {
        s = atBed(bed);
        var nb = 0.5 * bed + 0.5 * s.bedNew;
        if (Math.abs(nb - bed) < 0.01) { bed = nb; break; }
        bed = nb;
      }
      s = atBed(bed);
    }
    var bedTarget = s.bedNew;

    // ---- PSD produk ----
    var Lc = clamp(s.L, 0.3, 2.5, 1);
    var xp = xsep * pow(Lc, c.expLoad) * pow(bwi / c.bwiRef, 0.1);
    var nRR = c.nRef * pow(rpm / c.sepRef, 0.15) * (s.L > 1 ? pow(s.L, -0.2) : 1);
    var r90 = residue(90, xp, nRR), r200 = residue(200, xp, nRR), r45 = residue(45, xp, nRR);
    var cutSize = xsep * 1.15; // d50 separator indikatif (µm)

    // ---- Daya ----
    var pMill = running ? c.pMillIdle * scale + s.pGrind : 0;
    var pSep = running ? (c.pSepBase + c.pSepK * Math.pow(rpm / 100, 2)) * scale : 0;

    // ---- DP mill (mbar) ----
    var dp = c.dpGas * pow(gr, c.expDpGas) + (running ? c.dpLoad * s.loadIndex + c.dpDam * (dam - 150) * Math.min(1, s.loadIndex) : 0);
    dp = Math.max(dp, 1);

    // ---- Neraca panas & drying ----
    var mDry = feedDry / 3.6;                     // kg/s
    var mWater = (feedWet - feedDry) / 3.6;       // kg/s air dari umpan
    var mSpray = spray / 3600;                    // kg/s (1 L ≈ 1 kg)
    var mFa = c.falseAirFrac * gas;               // false air
    var qGrind = c.grindHeatFrac * pMill;         // kW panas dari gilas
    var moistEff = feedWet > 0 ? 100 * (mWater + mSpray) / (feedWet / 3.6) : 0;
    // Moisture produk sebagai fungsi suhu outlet (makin panas makin kering)
    function moistAt(T) {
      if (feedWet <= 0) return 0;
      var m = c.moistRef * Math.exp(-(T - 90) / c.moistTempScale) *
              Math.sqrt(Math.max(moistEff, 0.1) / 5) * pow(c.clRef / Math.max(s.CL, 0.5), 0.3);
      return clamp(m, 0.05, Math.max(moistEff, 0.05), 0.5);
    }
    // Suhu outlet hasil neraca panas bila suhu outlet "tebakan" = T
    // (T menentukan berapa air yang tertinggal di produk → berapa yang diuapkan)
    function balanceAt(T) {
      var mo = moistAt(T);
      var mEv = Math.max(0, mWater + mSpray - mDry * mo / Math.max(100 - mo, 1));
      var A = gas * c.cpGas + mFa * c.cpGas + mDry * c.cpMat + mEv * c.cpVapor;
      var B = gas * c.cpGas * tIn + mFa * c.cpGas * c.tAmb + mDry * c.cpMat * c.tFeed +
              mEv * c.cpVapor * c.tFeed + qGrind - mEv * c.hEvap - c.heatLoss * scale;
      return { T: B / Math.max(A, 1e-3), mEvap: mEv, moist: mo };
    }
    // g(T) = balanceAt(T).T − T turun monoton → akar unik, cari dengan bisection
    var lo = -20, hi = Math.max(tIn, c.tFeed) + 100;
    for (var it = 0; it < 50; it++) {
      var midT = (lo + hi) / 2;
      if (balanceAt(midT).T > midT) lo = midT; else hi = midT;
    }
    var hb = balanceAt((lo + hi) / 2);
    var tOut = clamp((lo + hi) / 2, -20, 600, 90), mEvap = hb.mEvap, moistOut = hb.moist;
    var qEvap = mEvap * (c.hEvap + c.cpVapor * (tOut - c.tFeed)); // kW

    // ---- Fan ----
    var qAct = (gas + mFa + mEvap) / gasDensity(tOut);          // m³/s aktual outlet
    var pFan = qAct * (dp + c.dpSystem) * 100 / c.fanEff / 1000; // kW
    // Kecepatan gas di nozzle ring (luas efektif 50 % annulus)
    var R = mill.tableDiameter / 2;
    var nozzleArea = 0.5 * Math.PI * (Math.pow(R + 0.45, 2) - R * R);
    var vNozzle = (gas / gasDensity(tIn)) / Math.max(nozzleArea, 0.1);

    // ---- Throughput & energi ----
    var product = feedDry * (1 + moistOut / 100);                 // t/h raw meal
    var pTotal = pMill + pFan + pSep;
    var kwht = product > 1 ? pTotal / product : 0;
    var heatUsed = Math.max(0, gas * c.cpGas * (tIn - tOut));     // kW dari hot gas
    var mjt = product > 1 ? heatUsed * 3.6 / product : 0;         // MJ/t
    var co2Elec = kwht * c.efGrid;                                 // kg/t
    var co2Heat = mjt * c.fuelHeatFrac * c.efFuel;                 // kg/t
    var vib = vibration(s.bed, P, s.L, moistEff, running && feedWet >= 0, cfg);

    return {
      running: running, feedWet: feedWet, feedDry: feedDry, product: product,
      bed: s.bed, bedTarget: bedTarget, loadRatio: s.L, cap: s.cap, cl: s.CL, loadIndex: s.loadIndex,
      xp: xp, n: nRR, r45: r45, r90: r90, r200: r200, cutSize: cutSize,
      pMill: pMill, pFan: pFan, pSep: pSep, pTotal: pTotal, kwht: kwht,
      kwhtMill: product > 1 ? pMill / product : 0, kwhtFan: product > 1 ? pFan / product : 0,
      kwhtSep: product > 1 ? pSep / product : 0,
      dp: dp, gas: gas, gasAm3h: qAct * 3600, vNozzle: vNozzle,
      tIn: tIn, tOut: tOut, moistOut: moistOut, moistEff: moistEff, qEvap: qEvap,
      mjt: mjt, co2Elec: co2Elec, co2Heat: co2Heat, co2: co2Elec + co2Heat,
      vib: vib, motorLoad: pMill / Math.max(mill.motorPower, 1)
    };
  }

  /* ---------------- 5. Sweep & optimizer ---------------- */

  // Hitung respons steady-state terhadap satu parameter
  function sweep(inp, chem, cfg, param, min, max, nPts) {
    var pts = [];
    for (var i = 0; i < nPts; i++) {
      var v = min + (max - min) * i / (nPts - 1);
      var x = Object.assign({}, inp); x[param] = v; x.running = true;
      var r = steadyState(x, chem, cfg);
      pts.push({ x: v, r90: r.r90, kwht: r.kwht, product: r.product, vib: r.vib, dp: r.dp, tOut: r.tOut });
    }
    return pts;
  }

  // Cek constraint operasi untuk optimizer
  function feasibleOp(r, cfg) {
    var a = cfg.alarm, t = cfg.targets;
    return r.r90 <= t.r90 && r.r200 <= t.r200 * 1.5 && r.vib < a.vibWarn &&
           r.moistOut <= t.moist && r.dp <= a.dpHigh && r.motorLoad <= a.powerHigh &&
           r.tOut >= a.tOutLow;
  }

  /**
   * Optimizer: grid search kasar + penyempurnaan lokal untuk
   * feed, rpm separator, tekanan gilas → minimalkan kWh/t
   * dengan constraint R90 ≤ target, getaran < batas, moisture ≤ batas.
   */
  function optimize(inp, chem, cfg) {
    var L = VRM.OPERATION_LIMITS;
    var lo = { feed: 200, sepRpm: L.sepRpm.min, pressure: 60 };
    var hi = { feed: L.feed.max, sepRpm: L.sepRpm.max, pressure: 135 };
    var best = null, evals = 0;
    function evalPoint(f, s, p) {
      var x = Object.assign({}, inp, { feed: f, sepRpm: s, pressure: p, running: true });
      var r = steadyState(x, chem, cfg); evals++;
      if (!feasibleOp(r, cfg)) return null;
      return { feed: f, sepRpm: s, pressure: p, r: r };
    }
    var N = 9;
    for (var i = 0; i < N; i++) for (var j = 0; j < N; j++) for (var k = 0; k < N; k++) {
      var f = lo.feed + (hi.feed - lo.feed) * i / (N - 1);
      var s = lo.sepRpm + (hi.sepRpm - lo.sepRpm) * j / (N - 1);
      var p = lo.pressure + (hi.pressure - lo.pressure) * k / (N - 1);
      var e = evalPoint(f, s, p);
      if (e && (!best || e.r.kwht < best.r.kwht)) best = e;
    }
    if (!best) return { ok: false, evals: evals, message: 'Tidak ada kombinasi yang memenuhi semua constraint. Longgarkan target R90/moisture atau periksa suhu gas.' };
    // Penyempurnaan lokal (pattern search)
    var step = { feed: 20, sepRpm: 3, pressure: 4 };
    for (var iter = 0; iter < 60; iter++) {
      var improved = false;
      ['feed', 'sepRpm', 'pressure'].forEach(function (key) {
        [-1, 1].forEach(function (dir) {
          var cand = { feed: best.feed, sepRpm: best.sepRpm, pressure: best.pressure };
          cand[key] = clamp(cand[key] + dir * step[key], lo[key], hi[key]);
          var e = evalPoint(cand.feed, cand.sepRpm, cand.pressure);
          if (e && e.r.kwht < best.r.kwht - 1e-4) { best = e; improved = true; }
        });
      });
      if (!improved) { step.feed /= 2; step.sepRpm /= 2; step.pressure /= 2; }
      if (step.feed < 0.5) break;
    }
    return { ok: true, evals: evals, feed: best.feed, sepRpm: best.sepRpm, pressure: best.pressure, r: best.r,
             message: 'Optimum ditemukan setelah ' + evals + ' evaluasi model.' };
  }

  // Cari rpm separator yang menghasilkan R90 tertentu (bisection)
  function rpmForR90(inp, chem, cfg, r90Target) {
    var lo = VRM.OPERATION_LIMITS.sepRpm.min, hi = VRM.OPERATION_LIMITS.sepRpm.max;
    for (var i = 0; i < 40; i++) {
      var mid = (lo + hi) / 2;
      var r = steadyState(Object.assign({}, inp, { sepRpm: mid, running: true }), chem, cfg);
      if (r.r90 > r90Target) lo = mid; else hi = mid;   // rpm naik → R90 turun
    }
    return (lo + hi) / 2;
  }

  return {
    clamp: clamp, safe: safe, normalizeProps: normalizeProps, moduli: moduli, bogue: bogue,
    mixChemistry: mixChemistry, solveMix: solveMix, residue: residue, gasDensity: gasDensity,
    vibration: vibration, steadyState: steadyState, sweep: sweep, optimize: optimize,
    feasibleOp: feasibleOp, rpmForR90: rpmForR90
  };
})();
