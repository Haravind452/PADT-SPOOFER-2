# SPOOFER

A full functional migration of **bladeRF GNSS Studio** (the original portable
PowerShell/WinForms application) onto a modern web stack:
**Vue 3 + Vuetify** frontend and **Node.js + Express 4 + Socket.io**
backend. The original project remains untouched; this repo reproduces its
behavior: **generate a SC16 Q11 GNSS IF file from coordinates, then transmit
it through a bladeRF SDR**.

> Lab / shielded use only - live GNSS transmission is regulated in most
> jurisdictions. The original application states the same.

---

## What the original application does (source of truth)

The original `bladeRF_GNSS_Studio_Portable` package is a self-contained
Windows tool:

1. **GENERATE** - takes Latitude / Longitude / Altitude, a UTC time, a
   duration, a mode (Fast / GPS / Full) and a RINEX navigation file, writes a
   SignalSim scenario JSON, then runs `bin\IFdataGen_q11.exe -c <json> -t`
   (hidden) to produce an SC16 **Q11** (12-bit) interleaved I/Q IF file
   (`signal\SCENARIO_<mode>.bin`). A `700 ms` timer polls the output file size
   against the expected byte count (`rate x 1e6 x duration x 4`) for the
   progress bar. On completion the output is verified with a peak scan
   (`Get-BinPeak`, threshold `|x| <= 2047` => "Q11 PASS").
2. **TRANSMIT** - spawns `bladeRF-cli -i` (interactive), sets
   `frequency / samplerate / bandwidth / gain tx1`, then
   `tx config file=<bin> format=bin repeat=0|1 buffers=256 samples=65536 xfers=32`
   and `tx start`. Transmit parameters come from the `.tag` file next to the
   `.bin` (`F_S=`/`F_LO=` lines, defaults `1568.286 MHz / 18.48 Msps`). The
   gain slider pushes live `set gain tx1 <n>` commands. Stop = `tx stop`,
   `quit`, kill fallback.
3. **Get latest** - downloads the previous day's broadcast RINEX from the BKG
   IGS mirrors (`igs.bkg.bund.de`), gunzips it into `ephemeris\`, and matches
   the UTC field from the filename date (`*_R_<YYYY><DOY><HHMM>_*` => Jan 1 +
   DOY - 1 day + 10 h).
4. Helper tools: `tools/check_q11.py` (full Q11 scan: peak max/min, rail
   fraction) and `tools/iq16_to_q11.py` (legacy IQ16 -> Q11 converter, `>>4`
   + clamp). Both are reimplemented natively in TypeScript.

### Modes

| Mode | Signals                                          | Center (MHz) | Rate (Msps) | Approx |
| ---- | ------------------------------------------------ | ------------ | ----------- | ------ |
| fast | GPS L1CA + Galileo E1                            | 1573.42      | 6.00        | ~3 min |
| gps  | GPS L1CA                                         | 1568.286     | 18.48       | ~6 min |
| full | GPS L1CA + L1C, Galileo E1, BDS B1I              | 1568.286     | 18.48       | ~12 min |

---

## Architecture

```
SPOOFER/
├── frontend/                  Vue 3.3 - Vuetify 3.5.9 - TypeScript - Vite
│   ├── index.html
│   ├── package.json
│   ├── tsconfig.json
│   ├── vite.config.ts         dev proxy: /api + /socket.io -> :3000
│   └── src/
│       ├── main.ts            Vuetify dark theme (original palette)
│       └── App.vue            full studio UI (Generate + Transmit + Log)
├── backend/                   Node.js - Express 4 - TypeScript - Socket.io
│   ├── package.json
│   ├── tsconfig.json
│   ├── src/
│   │   ├── server.ts          entrypoint, shutdown (TX stop + generator kill)
│   │   ├── app.ts             Express 4 REST API (multer uploads)
│   │   ├── socket.ts          Socket.io event wiring
│   │   ├── studio.ts          facade: state + service wiring (migrated app logic)
│   │   ├── logger.ts          HH:mm:ss console log with history
│   │   ├── config.ts          env config (defaults match the original paths)
│   │   ├── types.ts           shared domain types (modes, requests, results)
│   │   └── services/
│   │       ├── generator.ts   IFdataGen_q11 process + progress polling + Q11 verify
│   │       ├── bladeRf.ts     interactive bladeRF-cli session (stdin/stdout)
│   │       ├── rinex.ts       RINEX date parsing + BKG/IGS download + gunzip
│   │       ├── q11.ts         checkQ11() + getBinPeak() + iq16ToQ11()  (tools/*.py ports)
│   │       ├── storage.ts     ephemeris/signal/configs listing, locks, .tag reader
│   │       └── settingsStore.ts  in-memory (default) or Redis persistence
│   └── resources/             runtime resources (ported from the original)
│       ├── bin/               IFdataGen_q11.exe + MinGW DLLs
│       ├── bladeRF/           bladeRF-cli.exe + DLLs + FPGA images (*.rbf)
│       ├── ephemeris/         bundled BRDC00IGS RINEX + downloaded files
│       ├── signal/            generated .bin files (runtime, temporary)
│       └── configs/           scenario JSON files (runtime, temporary)
└── README.md
```

The `resources/` tree is copied verbatim from the original portable package:
it contains the same runtime binaries, FPGA images and the bundled RINEX
navigation file, so SPOOFER stays self-contained.

---

## Feature map (original -> new)

| Original (PowerShell)                       | New implementation                                     |
| ------------------------------------------- | ------------------------------------------------------ |
| `bladeRF_GNSS_Studio.ps1` UI + logic        | `frontend/src/App.vue` + `backend/src/studio.ts`        |
| `Generate-Q11.ps1` (CLI, mods multi/gps/fast) | `services/generator.ts` (mode `multi` accepted too)   |
| Gen-Tick 700ms progress                     | `generator.ts` polling timer -> `gen:progress`         |
| Get-BinPeak / Q11 PASS check                | `services/q11.ts:getBinPeak()`                         |
| Load-TxTag (`F_S`/`F_LO`)                   | `services/storage.ts:readTag()`                        |
| `bladeRF-cli -i` stdin session               | `services/bladeRf.ts`                                  |
| START.bat launcher                          | npm scripts (`frontend dev`, `backend start`)          |
| "Get latest" BKG/IGS download + gunzip      | `services/rinex.ts:downloadLatest()`                   |
| tools/check_q11.py                          | `services/q11.ts:checkQ11()` + `POST /api/signal/check`|
| tools/iq16_to_q11.py                        | `services/q11.ts:iq16ToQ11()` + `POST /api/signal/convert` |
| WinForms message boxes (validation text)    | Socket.io ack errors -> frontend snackbar (same strings)|
| `$env:TEMP/gnss_studio_gen.log`             | `GEN_LOG_FILE` (default `<tmp>/gnss_studio_gen.log`)   |
| Form closing cleanup (Stop-Tx, kill gen)    | `server.ts` SIGINT/SIGTERM shutdown handler            |

Every user-visible string (log lines, status texts, validation messages,
TX parameters) matches the original application.

---

## Socket.io events

Client -> server:

| Event            | Payload                                                     |
| ---------------- | ----------------------------------------------------------- |
| `gen:start`      | `{lat, lon, alt, duration, utc, mode, outName?}` (ack error)|
| `tx:start`       | `{file?, gain, loop}` (ack error)                            |
| `tx:gain`        | `{gain}`                                                     |
| `tx:stop`        | -                                                            |
| `rinex:latest`   | -                                                            |
| `rinex:select`   | `{name}` (ack `{error?, utc?}`)                              |
| `rinex:match`    | - (ack `{error?, utc?}`)                                     |
| `signal:select`  | `{name}` (ack `{error?, tag?}`)                              |
| `settings:save`  | `{lat, lon, alt, duration, utc, mode, gain, loop}`           |

Server -> client:

| Event          | Payload                                            |
| -------------- | -------------------------------------------------- |
| `state:sync`   | full snapshot: generating, transmitting, rinex, txFile, txFreqMHz/txRateMsps, gain, loop, genProgress, genResult, settings, logHistory |
| `log:append`   | `{line}` (console log, `[HH:mm:ss]` prefix)        |
| `gen:progress` | `{percent, elapsedMs}`                             |
| `gen:done`     | `{ok, message, fileName?, sizeMB?, peak?, q11?}`   |
| `tx:started`   | `{file, freqMHz, rateMsps, gain, loop}`            |
| `tx:stopped`   | `{}`                                               |
| `tx:output`    | `{line}` (bladeRF-cli stdout, debug)               |
| `rinex:ready`  | `{fileName, utc}`                                  |
| `rinex:status` | `{message}`                                        |

## REST API (Express 4)

| Method | Route                     | Description                                   |
| ------ | ------------------------- | --------------------------------------------- |
| GET    | `/api/health`             | platform, generator/bladeRF presence, dirs   |
| GET    | `/api/state`              | same snapshot as `state:sync`                 |
| GET    | `/api/modes`              | mode presets (text, center, rate, signals)    |
| GET    | `/api/rinex/list`         | `.rnx` files on the server (ephemeris dir)    |
| GET    | `/api/signal/list`        | `.bin` files + parsed `.tag` info             |
| POST   | `/api/upload/rinex`       | multipart `.rnx` upload (selects it)          |
| POST   | `/api/upload/signal`      | multipart `.bin` upload (selects it)          |
| POST   | `/api/signal/check`       | full Q11 scan (check_q11.py port)             |
| POST   | `/api/signal/peak`        | quick peak scan (Get-BinPeak port)            |
| POST   | `/api/signal/convert`     | IQ16 -> Q11 conversion (iq16_to_q11.py port)  |

Combined with the file dialogs in the UI, these routes replace the original
WinForms `OpenFileDialog`s over the network boundary (the server owns the
hardware and files; the browser never touches the filesystem).

---

## Setup

### Prerequisites

- Node.js 18+ (developed against Node 24) and npm.
- For **generation**: the SignalSim generator. SPOOFER bundles the patched
  direct-Q11 Windows build (`backend/resources/bin/IFdataGen_q11.exe`, which
  writes bladeRF-ready samples). On Windows it runs as-is. Generation
  requires a runnable binary; nothing is emulated or stubbed.
- For **transmit**: a bladeRF x40/x115 with WinUSB driver installed (Windows),
  or the platform's native `bladeRF-cli`. SPOOFER bundles
  `backend/resources/bladeRF/bladeRF-cli.exe`, its DLLs and the hosted FPGA
  images (`hostedxA4.rbf` / `hostedxA9.rbf`); `BLADERF_SEARCH_DIR` is set for
  the child process exactly like the original app does. When the CLI is
  missing (e.g. Linux dev box without the binary), the backend reports a
  truthful error - it does not fake TX.
- **Get latest** RINEX download requires internet access to the BKG IGS
  mirror (`igs.bkg.bund.de`).

### Windows driver (WinUSB)

The bladeRF needs the Microsoft **WinUSB** driver before `bladeRF-cli` can
open it. This repo bundles the driver package so no internet/Zadig is needed:

```bash
backend/resources/driver/install-driver.ps1   # run from an elevated prompt (self-elevates)
```

This adds `bladerf-winusb.inf` to the driver store via `pnputil` and binds it
to the bladeRF (2.0 `2cf0:5250`, x40/x115 `2cf0:5246`, bootloader `2cf0:5247`,
FX3 recovery `04b4:00f3`). It references the in-box `winusb.sys`, so no
third-party driver binaries are shipped. Verify afterwards:

```bash
backend\resources\bladeRF\bladeRF-cli.exe -e "version"
```

If the device is not enumerated at all (no entry appears in Device Manager
when plugging it in), check the USB cable (must be data-capable), a direct
USB 3.0 port, and power before retrying.

### Backend

```bash
cd backend
npm install
npm run build       # tsc -> dist/
npm start           # node dist/server.js  (listens on :3000)
npm run dev         # tsx watch (development)
npm run typecheck
```

### Frontend

```bash
cd frontend
npm install
npm run dev         # vite dev server on :5173, proxies /api + /socket.io
npm run build       # vue-tsc typecheck + vite build -> dist/
npm run preview
```

In production, serve the built `frontend/dist` statically from Express (or
any static host) and point it at the backend; the Socket.io client connects
to the same origin by default.

---

## Environment variables (backend)

| Variable             | Default                                            | Purpose                                    |
| -------------------- | -------------------------------------------------- | ------------------------------------------ |
| `PORT`               | `3000`                                             | HTTP + Socket.io port                      |
| `HOST`               | `0.0.0.0`                                          | listen address                             |
| `RESOURCES_DIR`      | `<backend>/resources`                              | root of runtime resources                  |
| `BIN_DIR`            | `<RESOURCES_DIR>/bin`                              | IFdataGen location                         |
| `GENERATOR_EXE`      | `<BIN_DIR>/IFdataGen_q11.exe`                      | generator binary; override for other builds|
| `GENERATOR_WRAPPER`  | *(empty)*                                          | e.g. `wine` to run the Windows exe on Linux|
| `BLADERF_DIR`        | `<RESOURCES_DIR>/bladeRF`                          | bundled bladeRF-cli + FPGA images          |
| `BLADERF_CLI`        | bundled exe, else `bladeRF-cli` from PATH          | bladeRF CLI command                        |
| `BLADERF_SEARCH_DIR` | `<BLADERF_DIR>`                                    | set for the CLI child process              |
| `EPHEMERIS_DIR`      | `<RESOURCES_DIR>/ephemeris`                        | RINEX import/download target               |
| `SIGNAL_DIR`         | `<RESOURCES_DIR>/signal`                           | generated .bin output                      |
| `CONFIGS_DIR`        | `<RESOURCES_DIR>/configs`                          | scenario JSON output                       |
| `GEN_LOG_FILE`       | `${TMPDIR}/gnss_studio_gen.log`                    | generator stdout/stderr log (as original)  |
| `REDIS_URL`          | *(unset)*                                          | optional Redis persistence (see below)     |

---

## Storage / persistence

Parity with the original: the application keeps runtime state in memory and
resets to the original defaults (`37.352721`, `-121.915773`, `20 m`,
duration `60 s`, mode Fast, gain `50 dB`, loop on) on every launch.

- Generated `.bin` files and scenario JSONs are **temporary runtime files**
  (the original treats them the same way). On an ephemeral cloud filesystem
  mount `SIGNAL_DIR`/`CONFIGS_DIR`/`EPHEMERIS_DIR` to a volume if files must
  survive.
- Optional **Redis** persistence: set `REDIS_URL`, and the last used UI
  settings (lat/lon/alt/duration/utc/mode/gain/loop) are saved/restored via
  key `spoofer:studio:ui_settings`. Without `REDIS_URL` a pure in-memory
  store is used and behavior is byte-for-byte the original defaults.
- No SQLite, no local database files, no persistent JSON store.

---

## Hardware behavior (no fakes)

The backend really performs every operation:

1. **Generation** - spawns the generator with `-c <scenario>.json -t`,
   `windowsHide`, stdout/stderr redirected to `GEN_LOG_FILE`, polices the
   expected output size every 700 ms, then scans the produced file and
   reports `Q11 PASS` only when the peak magnitude is `<= 2047` (the same
   criterion as the original). If the file is missing -> `FAILED`.
2. **Transmit** - streams real bladeRF-cli commands over stdin; the gain
   slider issues live `set gain tx1 <n>`; `tx config` uses the file's `.tag`
   parameters with the original fallbacks. Stop sequence: `tx stop` ->
   200 ms -> `quit` -> 3 s kill fallback; on shutdown the same cleanup runs
   and the generator is killed.
3. **RINEX** - real HTTPS download from the BKG mirrors, `>100000` byte
   sanity check, real gunzip.

If a dependency is absent on the current machine (e.g. running the backend
on Linux without a Windows-binary wrapper), the application reports the
failure exactly like the original would ("Generator not found:", "Generation
failed (no file).", "bladeRF-cli not found / on PATH?").

---

## Legal

Transmitting GNSS signals over the air is regulated. Use a shielded
enclosure or a direct cable with attenuator - lab / authorized use only.