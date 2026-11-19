# VRM Raw Mill Simulator – Fuller Loesche LM 59.42

Simulator interaktif vertical roller mill (VRM) raw meal untuk **process engineer, operator CCR, dan trainee**.
Mencakup alur material input (limestone, clay, silica sand, iron sand) → grinding, separasi, pengeringan → raw meal,
lengkap dengan model 3D semu (SVG isometrik cutaway) yang beranimasi.

> ⚠ **Model semi-empiris untuk edukasi dan analisis what-if, BUKAN digital twin tervalidasi.**
> Spesifikasi mill (diameter meja, jumlah roller, kapasitas, daya, aliran gas, dll.) adalah **asumsi** —
> verifikasi dengan nameplate / dokumen OEM. Koefisien model harus dikalibrasi dengan data plant
> sebelum dipakai untuk keputusan operasi.

---

## 1. Cara menjalankan

Tidak perlu instalasi, npm, build, atau server.

1. Buka `index.html` langsung di browser modern (Chrome, Edge, Firefox).
2. Simulasi langsung berjalan pada kondisi tunak default.

Semua script dimuat sebagai `<script>` klasik (bukan ES module) agar tetap jalan dari `file://`.
Tidak ada library eksternal maupun CDN, sehingga aplikasi berfungsi penuh secara offline.

## 2. Struktur file

```
vrm-simulator/
├── index.html   # layout & struktur tab
├── style.css    # tema HMI gelap, responsif (Grid/Flexbox + CSS variables)
├── config.js    # SEMUA koefisien model, default spesifikasi mill, batas alarm, preset material
├── model.js     # fungsi murni: kimia, mix solver, grinding, separator, drying, energi, sweep, optimizer
├── sim.js       # loop dinamis 1 s: delay belt, lag + dead time, PID, gangguan, interlock, alarm, histori
├── mill3d.js    # render & animasi SVG isometrik (proyeksi 3D sederhana)
├── ui.js        # kontrol, slider, KPI, grafik SVG, tab, skenario, sustainability, kalibrasi, ekspor
└── README.md
```

Urutan pemuatan: `config → model → sim → mill3d → ui`. Semua modul berbagi namespace global `window.VRM`.

## 3. Cara pakai singkat

| Area | Fungsi |
|---|---|
| **Header** | Play/Jeda (Spasi), Reset, percepatan waktu 1×/5×/20×/60×, mode Manual/Auto (PID), Start/Stop mill, skor kesehatan, ekspor CSV, cetak laporan |
| **Sidebar** | Parameter operasi: feed, tekanan gilas, dam ring, rpm separator, fan, suhu hot gas, setpoint suhu outlet & DP, water spray. Slider + input angka (koma atau titik desimal), otomatis di-clamp. Di mode Auto, suhu hot gas & fan dikunci (dikendalikan PID). |
| **Simulasi 3D** | Model cutaway: meja berputar, 4 roller (spin + naik/turun sesuai bed & tekanan), dam ring, nozzle ring, rotor separator, partikel (umpan → meja → naik bersama gas → reject/produk), panah gas berwarna sesuai suhu, getaran membuat mill bergoyang & casing memerah. Putar dengan slider/tombol 1–4 atau Shift+seret, zoom dengan roda mouse, geser dengan seret, hover komponen untuk nilai live. Flowsheet 2D di bawahnya. |
| **Material** | Proporsi 4 komponen (basis kering, auto-normalisasi), oksida, moisture, BWI, ukuran feed. Impor/ekspor JSON. Hasil kimia (LSF/SM/AM, Bogue). **Mix design solver**. |
| **Operasi** | Tuning PID (Kp/Ki/Kd), gangguan (moisture naik, limestone keras, clay lembap, feeder trip, suhu gas turun), noise, parameter dinamika, log alarm. |
| **Kualitas** | Skor kesehatan, kesiapan umpan kiln, target kualitas, kartu KPI dengan band toleransi, penjelasan alarm otomatis (penyebab + saran), tren 30 menit, kurva PSD vs spesifikasi. |
| **Skenario** | Preset (Normal, Clay lembap, Limestone keras, Hemat energi, Substitusi bahan baku alternatif), simpan A/B/C ke localStorage & tabel pembanding, sweep satu parameter, optimizer energi. |
| **Sustainability** | kWh/t (rincian mill/fan/separator), MJ/t, CO₂ listrik + pemanasan, potensi hemat bila R90 dilonggarkan, dampak indikatif ke kiln, saran efisiensi otomatis. |
| **Kalibrasi** | Edit spesifikasi mill & koefisien utama, unggah CSV data plant → R², RMSE, MAE, bias + scatter prediksi vs aktual. Tombol "Coba data contoh" & template CSV. |

### Deep-link (opsional)

Kondisi awal bisa diatur lewat hash URL, berguna untuk materi training atau berbagi skenario:

```
index.html#tab=tabQual&steps=1800&auto=1&dist=wetClay
index.html#angle=90&feed=200&dam=100&steps=300
index.html#tab=tabScen&action=sweep        (action: sweep | optimize | solve | caldemo)
```

`steps` = jumlah detik simulasi yang langsung dijalankan saat halaman dibuka (maks 14 400).
`dist` = daftar gangguan: `moistUp, hardLS, wetClay, feederTrip, gasDrop`.

## 4. Model proses & rumus

Semua fungsi model ada di `model.js` dan bersifat murni (tanpa DOM/state). Koefisien ada di `config.js` (`VRM.DEFAULT_COEF`).

### 4.1 Kimia raw meal
- Oksida campuran (basis kering): `ox_mix = Σ pᵢ·oxᵢ` (proporsi pᵢ dinormalisasi ke 100 %).
- Basis bebas LOI (≈ klinker): `ox_LF = ox_mix / (1 − LOI/100)`.
- `LSF = 100·CaO / (2,8·SiO₂ + 1,18·Al₂O₃ + 0,65·Fe₂O₃)`
- `SM = SiO₂ / (Al₂O₃ + Fe₂O₃)`, `AM = Al₂O₃ / Fe₂O₃`
- Bogue (basis bebas LOI, di-clamp ≥ 0):
  `C₃S = 4,071C − 7,600S − 6,718A − 1,430F − 2,852SO₃`; `C₂S = 2,867S − 0,7544·C₃S`;
  `C₃A = 2,650A − 1,692F`; `C₄AF = 3,043F`.

### 4.2 Mix design solver
Minimalkan `((LSF−LSFₜ)/tolLSF)² + ((SM−SMₜ)/tolSM)² + ((AM−AMₜ)/tolAM)²`
dengan **coordinate search berpasangan**: pindahkan `step` % dari komponen j ke i bila objektif turun;
step dibagi dua bila tidak ada perbaikan (5 % → 0,002 %). Constraint `pᵢ ≥ 0` dan `Σp = 100` terjaga otomatis.
Multi-start dari 3 titik awal. Disebut *feasible* bila semua modul dalam ½ toleransi; jika tidak, ditampilkan
kompromi terbaik + pesan modul mana yang tidak tercapai.

### 4.3 Grinding, bed, separator (steady-state)
Tebal bed, kapasitas, dan circulating load saling bergantung → diselesaikan dengan **iterasi titik tetap** (damping 0,5).

| Besaran | Rumus |
|---|---|
| Rasio gas | `g = ṁ_gas / ṁ_gas,ref`, ṁ_gas = aliran nominal × fan% |
| Ukuran dari separator | `x_sep = x_ref·(rpm_ref/rpm)^1,1·g^0,6` |
| Daya gilas | `P_grind = k_P·P_hid·√(bed/75)` (× skala kapasitas desain) |
| Faktor efisiensi bed | `f_bed = 1 + ((bed − bed_opt)/lebar)²` |
| Energi gilas spesifik | `e = e_ref·(BWI/BWI_ref)·(x_ref/x_sep)^0,5·f_bed` |
| Kapasitas & load ratio | `cap = P_grind/e`, `L = feed_kering/cap` |
| Circulating load | `CL = CL_ref·(rpm/rpm_ref)^1,3·L^1,2·g^−0,8` |
| Load index | `LI = (feed/feed_ref)·(1+CL)/(1+CL_ref)` |
| Tebal bed | `bed = k_dam·dam·LI^0,45 − k_P,bed·(P − P_nom)` |
| PSD produk | `x′ = x_sep·L^0,3·(BWI/BWI_ref)^0,1`; `R(x) = 100·exp(−(x/x′)ⁿ)` → R90, R200 |
| Cut size (indikatif) | `d50 ≈ 1,15·x_sep` |
| DP mill | `DP = DP_gas·g^1,8 + DP_load·LI + k_dam·(dam−150)` |

### 4.4 Getaran
`v = v₀ + k_tipis·max(0, bed_min − bed)^1,2 + k_P·max(0, P−110)·75/bed + k_tebal·max(0, bed−120) + k_over·max(0, L−1,1) + k_kering·max(0, 2,5 − moisture_efektif)`

Interlock: trip bila getaran > batas trip ≥ 3 s, daya motor > 110 % selama 10 s, atau suhu outlet > 125 °C selama 10 s.
Saat trip, feeder berhenti, meja berhenti, dan damper hot gas menutup (inlet ≈ 60 °C).

### 4.5 Neraca panas & drying
```
ṁ_g·cp_g·(T_in − T_out) + η_gilas·P_mill
   = Q_evap + ṁ_mat·cp_mat·(T_out − T_feed) + ṁ_FA·cp_g·(T_out − T_amb) + Q_loss
Q_evap = ṁ_air,uap·(2500 kJ/kg + cp_uap·(T_out − T_feed))
moisture_produk = m_ref·exp(−(T_out − 90)/14)·√(M_feed/5)·(CL_ref/CL)^0,3   (≤ M_feed)
```
Karena air yang diuapkan bergantung pada moisture produk (yang bergantung pada T_out), T_out diselesaikan dengan
**bisection** pada `g(T) = T_neraca(T) − T`, fungsi monoton turun sehingga akarnya unik.

### 4.6 Energi & emisi
- `P_fan = Q_aktual·(DP_mill + DP_sistem)/η_fan`; `P_sep = (P₀ + k·(rpm/100)²)`
- `kWh/t = (P_mill + P_fan + P_sep)/throughput`
- `MJ/t = ṁ_g·cp_g·(T_in − T_out)·3,6/throughput`
- `CO₂ = kWh/t·EF_grid + MJ/t·fraksi_bahan_bakar·EF_bahan_bakar` (indikatif)
- Dampak kiln (indikatif): `ΔQ_kiln ≈ k·(R90 − 12)` MJ/t klinker

### 4.7 Dinamika (`sim.js`)
- Time-step 1 s simulasi; percepatan 1×/5×/20×/60× (langkah dijalankan berulang per frame).
- Delay belt weigh feeder → mill (default 45 s), termasuk perubahan komposisi.
- Lag orde-1 (+ dead time) untuk bed (τ 40 s), suhu outlet (τ 90 s, dead 10 s), DP (τ 30 s), PSD (τ 60 s, dead 20 s), kimia (τ 150 s, dead 60 s).
- PID posisional dengan derivatif pada PV, anti-windup (integral dibekukan saat jenuh), dan bumpless transfer saat Manual → Auto.
  Loop 1: suhu outlet → suhu hot gas inlet. Loop 2: DP mill → fan %.

### 4.8 Optimizer
Grid search 9×9×9 (feed, rpm separator, tekanan gilas) lalu pattern search lokal. Minimalkan kWh/t dengan constraint
R90 ≤ target, R200 ≤ 1,5×spec, getaran < batas waspada, moisture ≤ batas, DP ≤ batas, daya motor ≤ batas, T_out ≥ batas bawah.

## 5. Daftar asumsi utama

- Penamaan "LM 59.42" ditafsirkan sebagai meja ±5,9 m dan 4 roller (default, bisa diedit).
- Kapasitas desain 400 t/h raw meal, motor 5,6 MW, meja 24,5 rpm, rotor separator maks 110 rpm,
  aliran gas nominal 750 000 Am³/h pada fan 100 %, tekanan hidrolik nominal 95 bar.
- Proporsi bahan dalam basis kering; feed rate dalam t/h basah. Throughput tunak = feed kering + air sisa.
- Densitas gas outlet ≈ 0,97 kg/m³ pada 90 °C (koreksi uap air 0,95).
- 25 % panas pengeringan berasal dari bahan bakar (HGG), sisanya waste heat kiln (koefisien `fuelHeatFrac`).
- EF listrik 0,80 kg CO₂/kWh, EF bahan bakar 0,095 kg CO₂/MJ (indikatif).
- Pembesaran visual tebal bed & dam ring di model 3D: ×4 (supaya perubahan terlihat).

## 6. Koefisien yang paling perlu dikalibrasi (urutan disarankan)

Edit lewat tab **Kalibrasi** (runtime) atau langsung di `config.js` (`VRM.DEFAULT_COEF`, permanen).

| # | Koefisien | Data plant yang dibutuhkan | Cara |
|---|---|---|---|
| 1 | `xRef`, `nRef` | R90 & R200 lab pada kondisi normal | Geser `xRef` sampai bias R90 ≈ 0; atur `nRef` dari rasio R90/R200 |
| 2 | `expRpm`, `expGas` | Step test rpm separator & fan vs R90 | Cocokkan kemiringan sweep dengan data |
| 3 | `kPowerPerBar`, `pMillIdle` | Daya motor mill vs tekanan | Regresi linear daya vs P·√bed |
| 4 | `eRef` | Throughput maksimum stabil, circulating load | Atur agar load ratio ≈ 1 pada feed maksimum stabil |
| 5 | `dpGas`, `dpLoad`, `dpDam` | DP saat mill kosong & beban normal | `dpGas` dari DP tanpa feed; `dpLoad` dari selisihnya |
| 6 | `kBedDam`, `kBedPress` | Pengukuran lift roller / tebal bed | Cocokkan bed vs dam & tekanan |
| 7 | `heatLoss`, `falseAirFrac` | T_in, T_out, aliran gas, moisture umpan | Geser sampai bias T_out ≈ 0 |
| 8 | `moistRef`, `moistTempScale` | Moisture raw meal vs T_out | Regresi eksponensial |
| 9 | `bedMinStable`, `kVibThin`, `kVibPress` | Riwayat getaran vs feed/dam/tekanan | Cocokkan titik mulai naiknya getaran |
| 10 | `dpSystem`, `fanEff` | Daya fan, tekanan statis fan | Cocokkan daya fan |
| 11 | `efGrid`, `fuelHeatFrac`, `kilnHeatPerR90` | Faktor emisi lokal, neraca panas kiln, uji burnability | Isi sesuai data plant |

Alur kalibrasi: unggah CSV (`feed, pressure, dam, sepRpm, fan, tIn, spray, R90, R200, kWh_t, DP, tOut, moist`)
→ lihat R² dan bias per variabel → ubah koefisien terkait → unggah ulang hingga R² ≥ 0,8 dan bias kecil.

## 7. Verifikasi yang sudah dilakukan

Diuji di Chrome headless (tanpa error console di semua tab) dengan uji arah respons dinamis (900 s setelah perubahan):

| Uji | Hasil |
|---|---|
| Rpm separator 70 → 85 % | R90 13,2 → 8,0 % ✓ turun |
| Feed 380 → 450 t/h | DP 45,7 → 53,5 mbar ✓ naik |
| Suhu hot gas 220 → 250 °C | Moisture 0,52 → 0,19 % ✓ turun |
| Setpoint outlet 90 → 100 °C (Auto) | Moisture 0,52 → 0,28 % ✓ turun |
| Feed 170 t/h + dam 95 mm | Getaran 1,8 → 7,5 mm/s ✓ naik |
| Tekanan 135 bar | Getaran 1,8 → 3,7 mm/s ✓ naik |
| Dam ring 220 mm | Daya mill 2913 → 3488 kW ✓ naik |
| Limestone keras (BWI +35 %) | R90 13,2 → 16,0 % ✓ naik |
| Weigh feeder trip | bed menipis → getaran → trip mill ✓; start ulang pulih normal ✓ |
| 200 kombinasi operasi acak | 0 nilai NaN/Infinity ✓ |

Performa: render frame 3D rata-rata ±2,5 ms, satu langkah simulasi < 0,3 ms, maksimum 120 partikel.

## 8. Keterbatasan

- Tidak memodelkan keausan roller/meja, distribusi gas non-uniform, perilaku akumulator hidrolik, maupun kurva Tromp separator secara eksplisit.
- PSD diwakili satu distribusi Rosin-Rammler.
- Dampak ke kiln dan CO₂ bersifat indikatif.
- Penyimpanan skenario memakai `localStorage` browser (per perangkat). Bila tidak tersedia, skenario disimpan sementara di memori.
