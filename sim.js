/* =====================================================================
   sim.js — Loop simulasi dinamis (time-step 1 detik simulasi)
   ---------------------------------------------------------------------
   - Delay belt (weigh feeder → mill) & dead time
   - First-order lag untuk bed, suhu, DP, PSD, kimia
   - PID suhu outlet (manipulasi suhu hot gas) & DP (manipulasi fan)
   - Gangguan yang bisa dipicu, interlock trip, evaluasi alarm
   - Histori data untuk tren & ekspor CSV
   ===================================================================== */

window.VRM = window.VRM || {};

VRM.Sim = (function () {
  var M = VRM.Model;
  var cfg = VRM.CONFIG;

  /* ---------------- Utilitas dinamika ---------------- */

  // Delay line: mengembalikan nilai yang di-push n langkah sebelumnya
  function makeDelay(n, init) {
    var buf = [];
    for (var i = 0; i < Math.max(1, n); i++) buf.push(init);
    return {
      push: function (v) { buf.push(v); return buf.shift(); },
      fill: function (v) { for (var i = 0; i < buf.length; i++) buf[i] = v; },
      resize: function (m, v) { buf = []; for (var i = 0; i < Math.max(1, m); i++) buf.push(v); }
    };
  }
  // First-order lag satu langkah
  function lag(y, target, dt, tau) { return y + (target - y) * Math.min(1, dt / Math.max(tau, 0.1)); }
  // Bilangan acak normal (Box-Muller)
  function gauss() { return Math.sqrt(-2 * Math.log(Math.random() + 1e-12)) * Math.cos(2 * Math.PI * Math.random()); }

  /* ---------------- PID ---------------- */

  function makePid() { return { integral: 0, lastPv: null }; }
  // Bumpless: set integral agar output = nilai manipulasi saat ini
  function pidInit(pid, gains, e, uNow) {
    pid.integral = gains.ki > 0 ? (uNow - gains.kp * e) / gains.ki : 0;
    pid.lastPv = null;
  }
  function pidStep(pid, gains, sp, pv, dt) {
    var e = sp - pv;
    var d = pid.lastPv === null ? 0 : -(pv - pid.lastPv) / dt;   // derivatif pada PV (tanpa derivative kick)
    pid.lastPv = pv;
    var newInt = pid.integral + e * dt;
    var u = gains.kp * e + gains.ki * newInt + gains.kd * d;
    // Anti-windup: integral tidak diperbarui bila output jenuh ke arah yang sama
    if ((u > gains.max && e > 0) || (u < gains.min && e < 0)) {
      u = gains.kp * e + gains.ki * pid.integral + gains.kd * d;
    } else {
      pid.integral = newInt;
    }
    return Math.min(gains.max, Math.max(gains.min, u));
  }

  /* ---------------- State ---------------- */

  var S = {};               // state simulasi
  var materials = VRM.deepCopy(VRM.DEFAULT_MATERIALS);
  var ops = VRM.deepCopy(VRM.DEFAULT_OPERATION);
  var disturb = { moistUp: false, hardLS: false, wetClay: false, feederTrip: false, gasDrop: false };
  var settings = { noise: true, speed: 1, playing: true };
  var history = [];
  var alarmLog = [];
  var MAX_HISTORY = 14400;  // 4 jam simulasi
  var pidT = makePid(), pidD = makePid();
  var belt, deadT, deadPSD, deadChem;
  var acc = 0;

  // Material efektif setelah gangguan
  function effectiveMaterials() {
    var m = VRM.deepCopy(materials);
    if (disturb.moistUp) { m[0].moist += 3; m[1].moist += 3; }
    if (disturb.hardLS) { m[0].bwi *= 1.35; }
    if (disturb.wetClay) { m[1].moist += 8; }
    return m;
  }

  function baseInputs(feed, chem) {
    return {
      feed: feed, pressure: ops.pressure, dam: ops.dam, sepRpm: ops.sepRpm, fan: ops.fan,
      // Saat mill stop/trip, damper hot gas menutup → hanya udara resirkulasi ±60 °C
      tIn: S.running ? ops.tIn - (disturb.gasDrop ? 70 : 0) : Math.min(ops.tIn, 60),
      spray: S.running ? ops.spray : 0, running: S.running
    };
  }

  function reset(keepInputs) {
    if (!keepInputs) {
      materials = VRM.deepCopy(VRM.DEFAULT_MATERIALS);
      ops = VRM.deepCopy(VRM.DEFAULT_OPERATION);
    }
    Object.keys(disturb).forEach(function (k) { disturb[k] = false; });
    var chem = M.mixChemistry(materials);
    var d = cfg.dyn;
    S = { t: 0, running: true, tripReason: '', tripTimer: 0, overTimer: 0, hotTimer: 0, noiseLsf: 0, noiseFeed: 0 };
    var ss = M.steadyState(baseInputs(ops.feed, chem), chem, cfg);
    belt = makeDelay(d.beltDelay, { feed: ops.feed, chem: chem });
    deadT = makeDelay(d.deadTemp, ss.tOut);
    deadPSD = makeDelay(d.deadPSD, { r90: ss.r90, r200: ss.r200, xp: ss.xp, n: ss.n });
    deadChem = makeDelay(d.deadChem, { lsf: chem.lsf, sm: chem.sm, am: chem.am });
    // Mulai dari kondisi tunak
    S.bed = ss.bed; S.tOut = ss.tOut; S.dp = ss.dp; S.r90 = ss.r90; S.r200 = ss.r200; S.xp = ss.xp; S.n = ss.n;
    S.lsf = chem.lsf; S.sm = chem.sm; S.am = chem.am; S.moistOut = ss.moistOut; S.pMill = ss.pMill; S.pFan = ss.pFan;
    S.product = ss.product; S.vib = ss.vib; S.cl = ss.cl; S.feedOut = ops.feed; S.feedMill = ops.feed;
    S.ss = ss; S.chem = chem; S.chemMill = chem;
    history = []; alarmLog = [];
    S.alarms = []; S.levels = {};
    if (ops.autoMode) setAuto(true);
    evaluate();
    record();
  }

  /* ---------------- Satu langkah simulasi (1 s) ---------------- */

  function step() {
    var dt = 1, d = cfg.dyn;
    S.t += dt;
    var chem = M.mixChemistry(effectiveMaterials());
    S.chem = chem;

    // --- Weigh feeder → belt (delay) → mill ---
    if (settings.noise) S.noiseFeed = S.noiseFeed * 0.9 + gauss() * 0.004;
    else S.noiseFeed = 0;
    var feederOn = S.running && !disturb.feederTrip;
    S.feedOut = feederOn ? Math.max(0, ops.feed * (1 + S.noiseFeed)) : 0;
    var arr = belt.push({ feed: S.feedOut, chem: chem });
    S.feedMill = S.running ? arr.feed : 0;
    S.chemMill = arr.chem;

    // --- PID (mode Auto) ---
    if (ops.autoMode && S.running) {
      var gT = Object.assign({}, cfg.pid.temp, { max: Math.min(cfg.pid.temp.max, cfg.mill.maxGasInlet) });
      ops.tIn = pidStep(pidT, gT, ops.tOutSP, S.tOut, dt);
      ops.fan = pidStep(pidD, cfg.pid.dp, ops.dpSP, S.dp, dt);
    }
    ops.tIn = Math.min(ops.tIn, cfg.mill.maxGasInlet);

    var inp = baseInputs(S.feedMill, S.chemMill);
    // Kondisi tunak (target ke mana bed bergerak)
    var target = M.steadyState(inp, S.chemMill, cfg);
    if (S.running) S.bed = lag(S.bed, target.bed, dt, d.tauBed);   // saat stop, material diam di meja
    // Kondisi sesaat pada tebal bed aktual
    var now = M.steadyState(inp, S.chemMill, cfg, { bed: S.bed });
    S.ss = now;

    // --- Lag & dead time ---
    S.dp = lag(S.dp, now.dp, dt, d.tauDP);
    S.tOut = lag(S.tOut, deadT.push(now.tOut), dt, d.tauTemp);
    var psd = deadPSD.push({ r90: now.r90, r200: now.r200, xp: now.xp, n: now.n });
    if (now.product > 1) {
      S.r90 = lag(S.r90, psd.r90, dt, d.tauPSD); S.r200 = lag(S.r200, psd.r200, dt, d.tauPSD);
      S.xp = lag(S.xp, psd.xp, dt, d.tauPSD); S.n = lag(S.n, psd.n, dt, d.tauPSD);
    }
    if (settings.noise) S.noiseLsf = S.noiseLsf * 0.995 + gauss() * 0.04; else S.noiseLsf = 0;
    var ch = deadChem.push({ lsf: S.chemMill.lsf, sm: S.chemMill.sm, am: S.chemMill.am });
    S.lsf = lag(S.lsf, ch.lsf + S.noiseLsf, dt, d.tauChem);
    S.sm = lag(S.sm, ch.sm, dt, d.tauChem);
    S.am = lag(S.am, ch.am, dt, d.tauChem);
    // Moisture produk mengikuti suhu outlet aktual (bukan target)
    var c = cfg.coef;
    var mTarget = now.feedWet > 0 ? M.clamp(now.moistOut * Math.exp(-(S.tOut - now.tOut) / c.moistTempScale), 0.05, Math.max(now.moistEff, 0.05)) : 0;
    S.moistOut = lag(S.moistOut, mTarget, dt, 30);
    S.pMill = lag(S.pMill, now.pMill, dt, d.tauPower);
    S.pFan = lag(S.pFan, now.pFan, dt, d.tauPower * 2);
    S.product = lag(S.product, now.product, dt, 60);
    S.cl = lag(S.cl, now.cl, dt, 20);
    S.vib = Math.max(0, lag(S.vib, now.vib, dt, 3) + (settings.noise && S.running ? gauss() * 0.05 : 0));

    // --- Interlock trip ---
    var A = cfg.alarm;
    if (S.running) {
      S.tripTimer = S.vib > A.vibTrip ? S.tripTimer + dt : 0;
      S.overTimer = now.motorLoad > 1.1 ? S.overTimer + dt : 0;
      S.hotTimer = S.tOut > 125 ? S.hotTimer + dt : 0;
      if (S.tripTimer >= d.tripVibDuration) trip('Getaran sangat tinggi (> ' + A.vibTrip + ' mm/s)');
      else if (S.overTimer >= 10) trip('Motor mill overload (> 110 % daya nominal)');
      else if (S.hotTimer >= 10) trip('Suhu outlet sangat tinggi (> 125 °C)');
    }
    evaluate();
    record();
  }

  function trip(reason) {
    S.running = false;
    S.tripReason = reason;
    logAlarm('alarm', 'MILL TRIP: ' + reason);
  }
  // Start ulang mill setelah trip / stop
  function startMill() {
    if (S.running) return;
    S.running = true; S.tripReason = ''; S.tripTimer = 0; S.overTimer = 0; S.hotTimer = 0;
    disturb.feederTrip = false;
    // Asumsi: feed sudah berjalan di belt sebelum roller diturunkan
    belt.fill({ feed: ops.feed, chem: M.mixChemistry(effectiveMaterials()) });
    S.bed = Math.max(S.bed, 45);
    S.vib = Math.min(S.vib, 3);
    logAlarm('info', 'Mill di-start ulang oleh operator');
  }
  function stopMill() { if (S.running) { trip('Stop manual oleh operator'); } }

  /* ---------------- Alarm & evaluasi ---------------- */

  function logAlarm(level, msg) {
    alarmLog.unshift({ t: S.t, level: level, msg: msg });
    if (alarmLog.length > 200) alarmLog.pop();
  }

  function evaluate() {
    var A = cfg.alarm, T = cfg.targets, now = S.ss || {};
    var list = [];
    function add(id, level, title, hint) { list.push({ id: id, level: level, title: title, hint: hint }); }
    var lv = {};

    if (!S.running) add('trip', 'alarm', 'MILL TRIP / STOP: ' + (S.tripReason || '-'), 'Periksa penyebab, lalu tekan "Start mill". Pastikan feed tersedia sebelum start.');
    if (disturb.feederTrip) add('feeder', 'alarm', 'Weigh feeder trip — tidak ada umpan', 'Bed akan menipis dan getaran naik. Pulihkan feeder (klik tombol gangguan lagi) atau stop mill.');

    // Getaran + diagnosis penyebab
    lv.vib = S.vib >= A.vibAlarm ? 'alarm' : S.vib >= A.vibWarn ? 'warn' : 'ok';
    if (lv.vib !== 'ok' && S.running) {
      var why;
      if (S.bed < cfg.coef.bedMinStable) why = 'bed terlalu tipis (' + VRM.fmt(S.bed, 0) + ' mm): naikkan feed atau dam ring, atau kurangi tekanan gilas.';
      else if (ops.pressure > 110) why = 'tekanan gilas terlalu tinggi (' + VRM.fmt(ops.pressure, 0) + ' bar): turunkan tekanan.';
      else if (now.loadRatio > 1.1) why = 'mill overload (load ratio ' + VRM.fmt(now.loadRatio, 2) + '): kurangi feed atau naikkan tekanan.';
      else if (now.moistEff < 2.5) why = 'material terlalu kering: tambah water spray untuk menstabilkan bed.';
      else if (S.bed > 120) why = 'bed terlalu tebal: turunkan dam ring atau feed.';
      else why = 'kombinasi kondisi operasi; periksa bed, tekanan dan feed.';
      add('vib', lv.vib, 'Getaran ' + (lv.vib === 'alarm' ? 'TINGGI' : 'naik') + ' (' + VRM.fmt(S.vib, 1) + ' mm/s)', 'Penyebab: ' + why);
    }
    lv.bed = (S.bed < A.bedLow || S.bed > A.bedHigh) ? 'warn' : 'ok';
    if (S.running && S.bed < A.bedLow) add('bedlow', 'warn', 'Bed tipis (' + VRM.fmt(S.bed, 0) + ' mm)', 'Risiko kontak logam-logam & getaran. Naikkan feed/dam ring atau tambah water spray.');
    if (S.running && S.bed > A.bedHigh) add('bedhigh', 'warn', 'Bed terlalu tebal (' + VRM.fmt(S.bed, 0) + ' mm)', 'DP dan arus motor naik, efisiensi gilas turun. Turunkan dam ring atau feed.');

    lv.dp = S.dp > A.dpHigh ? 'alarm' : S.dp < A.dpLow ? 'warn' : 'ok';
    if (S.dp > A.dpHigh) add('dphigh', 'alarm', 'DP mill tinggi (' + VRM.fmt(S.dp, 1) + ' mbar)', 'Sirkulasi internal tinggi / mendekati overload. Kurangi feed, turunkan rpm separator, atau naikkan tekanan gilas.');
    if (S.running && S.dp < A.dpLow) add('dplow', 'warn', 'DP mill rendah (' + VRM.fmt(S.dp, 1) + ' mbar)', 'Mill kurang beban. Naikkan feed bila kualitas memungkinkan.');

    lv.tOut = (S.tOut > A.tOutHigh || S.tOut < A.tOutLow) ? 'warn' : 'ok';
    if (S.tOut > A.tOutHigh + 10) lv.tOut = 'alarm';
    if (S.tOut > A.tOutHigh) add('thigh', lv.tOut, 'Suhu outlet tinggi (' + VRM.fmt(S.tOut, 1) + ' °C)', 'Kurangi suhu hot gas atau tambah water spray. Risiko kerusakan bag filter.');
    if (S.running && S.tOut < A.tOutLow) add('tlow', 'warn', 'Suhu outlet rendah (' + VRM.fmt(S.tOut, 1) + ' °C)', 'Pengeringan kurang & risiko kondensasi. Naikkan suhu hot gas, kurangi water spray atau feed.');

    lv.moist = S.moistOut > T.moist ? 'alarm' : S.moistOut > T.moist * 0.8 ? 'warn' : 'ok';
    if (S.running && S.moistOut > T.moist) add('moist', 'alarm', 'Moisture raw meal tinggi (' + VRM.fmt(S.moistOut, 2) + ' %)', 'Naikkan suhu outlet (setpoint/hot gas). Umpan basah? Periksa moisture clay/limestone.');

    lv.r90 = S.r90 > T.r90 + 1 ? 'alarm' : S.r90 > T.r90 ? 'warn' : 'ok';
    if (S.running && S.r90 > T.r90) add('r90', lv.r90, 'R90 di atas spec (' + VRM.fmt(S.r90, 1) + ' % > ' + VRM.fmt(T.r90, 1) + ' %)', 'Naikkan rpm separator, turunkan fan, atau kurangi feed.');
    if (S.running && S.r90 < T.r90 - 4) add('overgrind', 'info', 'Over-grinding (R90 ' + VRM.fmt(S.r90, 1) + ' %)', 'Produk lebih halus dari perlu → boros energi. Turunkan rpm separator.');
    lv.r200 = S.r200 > T.r200 ? 'warn' : 'ok';
    if (S.running && S.r200 > T.r200) add('r200', 'warn', 'R200 di atas spec (' + VRM.fmt(S.r200, 2) + ' %)', 'Partikel kasar (quartz) sulit dibakar. Naikkan rpm separator.');

    lv.lsf = Math.abs(S.lsf - T.lsf) > T.lsfTol ? 'alarm' : Math.abs(S.lsf - T.lsf) > T.lsfTol * 0.5 ? 'warn' : 'ok';
    if (lv.lsf === 'alarm') add('lsf', 'warn', 'LSF di luar band (' + VRM.fmt(S.lsf, 1) + ')', 'Sesuaikan proporsi bahan (gunakan Mix design solver di tab Material).');
    lv.sm = Math.abs(S.sm - T.sm) > T.smTol ? 'warn' : 'ok';
    lv.am = Math.abs(S.am - T.am) > T.amTol ? 'warn' : 'ok';

    var load = S.pMill / Math.max(cfg.mill.motorPower, 1);
    lv.power = load > A.powerHigh ? 'alarm' : load > A.powerHigh - 0.1 ? 'warn' : 'ok';
    if (load > A.powerHigh) add('power', 'alarm', 'Daya motor mill tinggi (' + VRM.fmt(load * 100, 0) + ' %)', 'Kurangi tekanan gilas atau feed; periksa tebal bed.');
    lv.pressure = ops.pressure > 125 ? 'alarm' : ops.pressure > 112 ? 'warn' : 'ok';

    if (ops.autoMode && ops.tIn >= Math.min(cfg.pid.temp.max, cfg.mill.maxGasInlet) - 0.5 && S.tOut < ops.tOutSP - 2)
      add('sat', 'warn', 'Hot gas jenuh di batas maksimum', 'Kapasitas pengeringan tidak cukup. Kurangi feed, kurangi water spray, atau tambah sumber panas (HGG).');
    if (S.running && now.vNozzle < 35) add('nozzle', 'warn', 'Kecepatan nozzle ring rendah (' + VRM.fmt(now.vNozzle, 0) + ' m/s)', 'Material jatuh lewat nozzle ring (spillage). Naikkan aliran gas (fan).');
    if (disturb.gasDrop) add('gasdrop', 'info', 'Gangguan: suhu sumber gas turun 70 °C', 'Mode Auto akan mengkompensasi bila masih ada ruang.');

    // Catat aktivasi alarm baru ke log
    var prevIds = (S.alarms || []).map(function (a) { return a.id; });
    list.forEach(function (a) { if (prevIds.indexOf(a.id) < 0 && a.id !== 'trip') logAlarm(a.level, a.title); });
    S.alarms = list;
    S.levels = lv;

    // Skor kesehatan proses
    var score = 100;
    list.forEach(function (a) { score -= a.level === 'alarm' ? 15 : a.level === 'warn' ? 6 : 2; });
    score -= Math.max(0, S.vib - 3) * 2;
    S.health = Math.max(0, Math.min(100, Math.round(score)));

    // Kesiapan umpan kiln (10 menit terakhir)
    var win = history.slice(-600);
    var lsfs = win.map(function (h) { return h.lsf; });
    var mean = lsfs.length ? lsfs.reduce(function (a, b) { return a + b; }, 0) / lsfs.length : S.lsf;
    var sd = lsfs.length > 1 ? Math.sqrt(lsfs.reduce(function (a, b) { return a + (b - mean) * (b - mean); }, 0) / (lsfs.length - 1)) : 0;
    S.kiln = {
      lsfStable: sd < 0.8 && Math.abs(mean - T.lsf) <= T.lsfTol,
      lsfSd: sd, lsfMean: mean,
      r90: S.r90 <= T.r90, r200: S.r200 <= T.r200, moist: S.moistOut <= T.moist,
      running: S.running
    };
    S.kiln.ready = S.kiln.lsfStable && S.kiln.r90 && S.kiln.r200 && S.kiln.moist && S.running;
  }

  function kwht() {
    var pSep = S.ss ? S.ss.pSep : 0;
    return S.product > 1 ? (S.pMill + S.pFan + pSep) / S.product : 0;
  }

  function record() {
    var now = S.ss || {};
    history.push({
      t: S.t, feed: S.feedOut, feedMill: S.feedMill, pressure: ops.pressure, dam: ops.dam, sepRpm: ops.sepRpm,
      fan: ops.fan, tIn: ops.tIn - (disturb.gasDrop ? 70 : 0), spray: ops.spray,
      bed: S.bed, dp: S.dp, vib: S.vib, tOut: S.tOut, r90: S.r90, r200: S.r200,
      lsf: S.lsf, sm: S.sm, am: S.am, moist: S.moistOut, product: S.product,
      pMill: S.pMill, pFan: S.pFan, kwht: kwht(), co2: now.co2 || 0, running: S.running ? 1 : 0
    });
    if (history.length > MAX_HISTORY) history.shift();
  }

  /* ---------------- Mode Auto ---------------- */

  function setAuto(on) {
    ops.autoMode = !!on;
    if (on) {
      pidInit(pidT, cfg.pid.temp, ops.tOutSP - S.tOut, ops.tIn);
      pidInit(pidD, cfg.pid.dp, ops.dpSP - S.dp, ops.fan);
    }
  }

  /* ---------------- Loop waktu nyata ---------------- */

  // Dipanggil tiap frame dengan dt waktu nyata (detik)
  function tick(realDt) {
    if (!settings.playing) return 0;
    acc += realDt * settings.speed;
    var n = 0;
    while (acc >= 1 && n < 300) { step(); acc -= 1; n++; }
    if (acc > 5) acc = 0; // cegah tumpukan bila tab tidak aktif
    return n;
  }

  // Ringkasan state untuk tampilan 3D & UI
  function view() {
    var now = S.ss || {};
    var mill = cfg.mill;
    var gasNom = mill.gasFlowNominal / 3600 * M.gasDensity(90);
    return {
      t: S.t, running: S.running, tripReason: S.tripReason,
      feed: S.feedMill, feedOut: S.feedOut, pressure: ops.pressure, dam: ops.dam, sepRpm: ops.sepRpm,
      rotorRpm: ops.sepRpm / 100 * mill.separatorMaxRpm,   // separator tetap berputar walau mill trip
      fan: ops.fan, gas: now.gas, gasRatio: now.gas / Math.max(gasNom * 0.8, 1), gasAm3h: now.gasAm3h,
      tIn: now.tIn, tOut: S.tOut, vib: S.vib, bed: S.bed, cl: S.cl, loadRatio: now.loadRatio,
      dp: S.dp, vNozzle: now.vNozzle, pMill: S.pMill, pFan: S.pFan, pSep: now.pSep,
      motorLoad: S.pMill / Math.max(mill.motorPower, 1),
      product: S.product, moistOut: S.moistOut, moistFeed: S.chemMill ? S.chemMill.moist : 0,
      r90: S.r90, r200: S.r200, xp: S.xp, n: S.n, cutSize: now.cutSize,
      lsf: S.lsf, sm: S.sm, am: S.am, kwht: kwht(),
      mjt: now.mjt, co2: now.co2, co2Elec: now.co2Elec, co2Heat: now.co2Heat,
      levels: S.levels, alarms: S.alarms, health: S.health, kiln: S.kiln, chem: S.chem
    };
  }

  // Ubah panjang delay bila parameter dinamika diubah
  function rebuildDelays() {
    var d = cfg.dyn;
    belt.resize(d.beltDelay, { feed: S.feedOut, chem: S.chemMill });
    deadT.resize(d.deadTemp, S.tOut);
    deadPSD.resize(d.deadPSD, { r90: S.r90, r200: S.r200, xp: S.xp, n: S.n });
    deadChem.resize(d.deadChem, { lsf: S.lsf, sm: S.sm, am: S.am });
  }

  reset(true);

  return {
    reset: reset, step: step, tick: tick, view: view,
    startMill: startMill, stopMill: stopMill, setAuto: setAuto, rebuildDelays: rebuildDelays,
    get ops() { return ops; },
    get materials() { return materials; },
    set materials(m) { materials = m; },
    setOps: function (o) { Object.assign(ops, o); if (o.autoMode !== undefined) setAuto(o.autoMode); },
    disturb: disturb, settings: settings,
    get history() { return history; },
    get alarmLog() { return alarmLog; },
    get state() { return S; },
    effectiveChem: function () { return M.mixChemistry(effectiveMaterials()); },
    effectiveMaterials: effectiveMaterials,
    currentInputs: function () { return Object.assign(baseInputs(ops.feed, null), { running: true, spray: ops.spray }); }
  };
})();
