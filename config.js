/* =====================================================================
   config.js — SEMUA koefisien model dan default spesifikasi mill
   ---------------------------------------------------------------------
   File ini adalah satu-satunya tempat angka "kalibrasi" disimpan.
   Bila ingin menyesuaikan model dengan data plant, ubah angka di sini
   (atau lewat tab Kalibrasi di UI, yang menulis ke objek yang sama).

   ⚠ Semua spesifikasi mill di bawah adalah ASUMSI untuk edukasi,
     bukan data resmi OEM. Verifikasi dengan nameplate / dokumen OEM.
   ===================================================================== */

window.VRM = window.VRM || {};

/* ---------- Spesifikasi mill (default asumsi, editable) ---------- */
VRM.DEFAULT_MILL_SPEC = {
  tableDiameter: 5.9,        // m — tafsiran "59" pada LM 59.42
  rollers: 4,                // jumlah roller — tafsiran "4" pada LM 59.42
  designCapacity: 400,       // tph raw meal
  motorPower: 5600,          // kW, daya nominal motor mill
  tableRpm: 24.5,            // rpm, kecepatan meja tetap
  separatorMaxRpm: 110,      // rpm rotor pada 100 %
  gasFlowNominal: 750000,    // Am³/h di outlet mill pada fan 100 %
  maxGasInlet: 400,          // °C, suhu gas inlet maksimum yang diizinkan
  nominalPressure: 95        // bar, tekanan hidrolik nominal (referensi model)
};

/* ---------- Default parameter operasi ---------- */
VRM.DEFAULT_OPERATION = {
  feed: 380,            // tph umpan basah
  pressure: 95,         // bar tekanan gilas (hidrolik)
  dam: 150,             // mm tinggi dam ring
  sepRpm: 70,           // % kecepatan rotor separator
  fan: 80,              // % kecepatan mill fan / bukaan damper
  tIn: 220,             // °C suhu hot gas inlet
  tOutSP: 90,           // °C setpoint suhu outlet (dipakai mode Auto)
  dpSP: 46,             // mbar setpoint DP mill (dipakai mode Auto)
  spray: 2000,          // L/h water spray ke bed
  autoMode: false       // false = Manual, true = Auto (PID aktif)
};

/* ---------- Batas slider operasi (min, max, step, satuan) ---------- */
VRM.OPERATION_LIMITS = {
  feed:     { min: 0,   max: 520,   step: 1,   unit: 't/h',  label: 'Feed rate' },
  pressure: { min: 40,  max: 140,   step: 1,   unit: 'bar',  label: 'Tekanan gilas' },
  dam:      { min: 80,  max: 250,   step: 1,   unit: 'mm',   label: 'Tinggi dam ring' },
  sepRpm:   { min: 30,  max: 100,   step: 0.5, unit: '%',    label: 'Rpm separator' },
  fan:      { min: 40,  max: 100,   step: 0.5, unit: '%',    label: 'Mill fan / damper' },
  tIn:      { min: 120, max: 400,   step: 1,   unit: '°C',   label: 'Suhu hot gas inlet' },
  tOutSP:   { min: 65,  max: 115,   step: 0.5, unit: '°C',   label: 'Setpoint suhu outlet' },
  dpSP:     { min: 25,  max: 80,    step: 0.5, unit: 'mbar', label: 'Setpoint DP mill' },
  spray:    { min: 0,   max: 15000, step: 50,  unit: 'L/h',  label: 'Water spray' }
};

/* ---------- Koefisien model (inti kalibrasi) ---------- */
VRM.DEFAULT_COEF = {
  // --- Referensi titik desain ---
  feedRef: 380,          // t/h, feed referensi untuk normalisasi
  bwiRef: 11,            // kWh/t, BWI referensi
  sepRef: 70,            // %, rpm separator referensi

  // --- Separator & PSD (Rosin-Rammler) ---
  xRef: 46,              // µm, ukuran karakteristik x' pada kondisi referensi (≈R90 14 %)
  expRpm: 1.1,           // eksponen: x' ∝ (sepRef/rpm)^expRpm
  expGas: 0.6,           // eksponen: x' ∝ (gas/gasRef)^expGas
  expLoad: 0.30,         // eksponen: x' ∝ loadRatio^expLoad (overload → kasar)
  nRef: 1.0,             // eksponen keseragaman Rosin-Rammler

  // --- Energi gilas ---
  eRef: 6.7,             // kWh/t energi gilas spesifik pada referensi
  pMillIdle: 400,        // kW, daya mill tanpa beban gilas
  kPowerPerBar: 27,      // kW per bar tekanan (pada bed 75 mm)
  bedOpt: 75,            // mm, tebal bed optimum
  bedWidth: 60,          // mm, lebar "jendela" efisiensi bed

  // --- Bed material ---
  kBedDam: 0.5,          // mm bed per mm dam ring (pada load index 1)
  expBedLoad: 0.45,      // eksponen load index pada tebal bed
  kBedPress: 0.2,        // mm penipisan bed per bar di atas nominal

  // --- Circulating load ---
  clRef: 5.0,            // rasio sirkulasi (reject/feed) referensi = 500 %
  expClRpm: 1.3,
  expClLoad: 1.2,
  expClGas: 0.8,

  // --- Differential pressure mill (mbar) ---
  dpGas: 22,             // komponen DP akibat aliran gas pada referensi
  expDpGas: 1.8,
  dpLoad: 26,            // komponen DP akibat material bersirkulasi
  dpDam: 0.06,           // mbar per mm dam ring di atas 150
  dpSystem: 50,          // mbar, rugi tekanan sistem lain (siklon, filter, duct)
  fanEff: 0.80,          // efisiensi fan

  // --- Getaran (mm/s) ---
  vibBase: 1.8,
  bedMinStable: 55,      // mm, di bawah ini getaran naik
  kVibThin: 0.12,
  kVibPress: 0.06,       // mm/s per bar di atas 110 bar
  kVibThick: 0.03,       // mm/s per mm bed di atas 120 mm
  kVibOverload: 6,       // mm/s per satuan loadRatio di atas 1,10
  kVibDry: 0.6,          // mm/s per % moisture efektif di bawah 2,5 %

  // --- Drying & neraca panas ---
  cpGas: 1.05,           // kJ/kg.K
  cpMat: 0.84,           // kJ/kg.K
  cpVapor: 1.9,          // kJ/kg.K
  hEvap: 2500,           // kJ/kg panas laten
  tFeed: 30,             // °C suhu umpan
  tAmb: 30,              // °C ambien
  falseAirFrac: 0.10,    // fraksi false air terhadap gas
  heatLoss: 1500,        // kW rugi panas dinding
  grindHeatFrac: 0.8,    // fraksi daya mill yang menjadi panas
  moistRef: 0.5,         // % moisture produk pada outlet 90 °C
  moistTempScale: 14,    // °C, skala eksponensial pengeringan

  // --- Separator power ---
  pSepBase: 30,
  pSepK: 220,

  // --- Emisi & kiln (indikatif) ---
  efGrid: 0.80,          // kg CO₂/kWh listrik (indikatif grid)
  efFuel: 0.095,         // kg CO₂/MJ bahan bakar (batubara)
  fuelHeatFrac: 0.25,    // fraksi panas pengeringan dari HGG/bahan bakar (sisanya waste heat kiln)
  kilnHeatPerR90: 8      // MJ/t klinker per 1 % R90 di atas 12 % (indikatif)
};

/* ---------- Dinamika (detik simulasi) ---------- */
VRM.DEFAULT_DYNAMICS = {
  beltDelay: 45,     // s, waktu tempuh belt dari weigh feeder ke mill
  tauBed: 40,        // s, konstanta waktu bed
  tauTemp: 90, deadTemp: 10,
  tauDP: 30,
  tauPSD: 60, deadPSD: 20,
  tauChem: 150, deadChem: 60,
  tauPower: 8,
  tripVibDuration: 3 // s di atas batas trip → mill trip
};

/* ---------- PID default ---------- */
VRM.DEFAULT_PID = {
  temp: { kp: 1.6, ki: 0.02, kd: 0,  min: 120, max: 400 }, // manipulasi suhu hot gas inlet
  dp:   { kp: 0.8, ki: 0.03, kd: 0,  min: 40,  max: 100 }  // manipulasi fan %
};

/* ---------- Batas alarm ---------- */
VRM.ALARM_LIMITS = {
  vibWarn: 6, vibAlarm: 8, vibTrip: 11,          // mm/s
  dpLow: 35, dpHigh: 65,                          // mbar
  tOutLow: 75, tOutHigh: 105,                     // °C
  moistMax: 1.0,                                  // % raw meal
  bedLow: 40, bedHigh: 120,                       // mm
  powerHigh: 0.95                                 // fraksi daya motor
};

/* ---------- Target kualitas ---------- */
VRM.DEFAULT_TARGETS = {
  lsf: 96, lsfTol: 2,
  sm: 2.4, smTol: 0.1,
  am: 1.5, amTol: 0.1,
  r90: 14, r200: 1.8,
  moist: 1.0
};

/* ---------- Preset material default (4 komponen) ---------- */
VRM.OXIDES = ['SiO2', 'Al2O3', 'Fe2O3', 'CaO', 'MgO', 'K2O', 'Na2O', 'SO3', 'LOI'];

VRM.DEFAULT_MATERIALS = [
  { name: 'Limestone',   prop: 82.5, moist: 4,  bwi: 10, size: 80,
    ox: { SiO2: 4.5, Al2O3: 1.2, Fe2O3: 0.6, CaO: 51.5, MgO: 1.0, K2O: 0.15, Na2O: 0.05, SO3: 0.1, LOI: 40.8 } },
  { name: 'Clay',        prop: 13.5, moist: 15, bwi: 12, size: 50,
    ox: { SiO2: 58, Al2O3: 16.5, Fe2O3: 7.0, CaO: 2.0, MgO: 1.8, K2O: 2.0, Na2O: 0.8, SO3: 0.3, LOI: 9.5 } },
  { name: 'Silica sand', prop: 2.5,  moist: 6,  bwi: 16, size: 5,
    ox: { SiO2: 88, Al2O3: 4.5, Fe2O3: 1.5, CaO: 1.0, MgO: 0.3, K2O: 0.8, Na2O: 0.3, SO3: 0.1, LOI: 2.0 } },
  { name: 'Iron sand',   prop: 1.5,  moist: 8,  bwi: 13, size: 3,
    ox: { SiO2: 22, Al2O3: 5.5, Fe2O3: 62, CaO: 2.5, MgO: 2.2, K2O: 0.3, Na2O: 0.3, SO3: 0.2, LOI: 1.5 } }
];

/* Format angka Indonesia; NaN/Infinity ditampilkan sebagai "–" */
VRM.fmt = function (v, dec) {
  if (!Number.isFinite(v)) return '–';
  dec = dec || 0;
  if (Math.abs(v) < 0.5 * Math.pow(10, -dec)) v = 0;   // hindari tampilan "-0,00"
  return v.toLocaleString('id-ID', { minimumFractionDigits: dec, maximumFractionDigits: dec });
};

/* Salinan kerja yang dipakai saat runtime (diubah oleh UI / kalibrasi) */
VRM.deepCopy = function (obj) { return JSON.parse(JSON.stringify(obj)); };
VRM.CONFIG = {
  mill: VRM.deepCopy(VRM.DEFAULT_MILL_SPEC),
  coef: VRM.deepCopy(VRM.DEFAULT_COEF),
  dyn: VRM.deepCopy(VRM.DEFAULT_DYNAMICS),
  pid: VRM.deepCopy(VRM.DEFAULT_PID),
  alarm: VRM.deepCopy(VRM.ALARM_LIMITS),
  targets: VRM.deepCopy(VRM.DEFAULT_TARGETS)
};
