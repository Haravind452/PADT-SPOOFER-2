import * as fs from 'fs';
import * as path from 'path';
import { spawn, ChildProcess } from 'child_process';
import { config } from '../config';
import { presetFor, type GenRequest, type GenProgress, type GenResult, type ModePreset } from '../types';
import { getBinPeak } from './q11';
import { storage } from './storage';
import { Logger } from '../logger';

export interface GeneratorEvents {
  onLog(line: string): void;
  onProgress(p: GenProgress): void;
  onDone(r: GenResult): void;
}

const POLL_MS = 700;

/**
 * Signal generation via the SignalSim IFdataGen binary (IFdataGen_q11.exe).
 * Mirrors the studio app's GENERATE handler + Gen-Tick timer exactly:
 * scenario JSON, hidden process, size-based progress polling, then the
 * Q11 peak verification (Get-BinPeak, threshold |x| <= 2047).
 */
export class GeneratorService {
  private logger: Logger;
  private events: GeneratorEvents | null = null;
  private proc: ChildProcess | null = null;
  private timer: NodeJS.Timeout | null = null;
  private t0 = 0;
  private outPath: string | null = null;
  private expBytes = 0;
  private running = false;
  private mk: ModePreset | null = null;

  constructor(logger: Logger) {
    this.logger = logger;
  }

  attach(events: GeneratorEvents): void {
    this.events = events;
  }

  isRunning(): boolean {
    return this.running;
  }

  outputFile(): string | null {
    return this.outPath;
  }

  /**
   * Starts generation. `rinexPath` is the user-selected RINEX file (mirrors
   * $script:rinex in the original studio app). Returns a message-box style
   * error text or null when generation started.
   */
  start(req: GenRequest, rinexPath: string | null): string | null {
    if (this.running) {
      return 'Generation already in progress';
    }
    if (!fs.existsSync(config.generatorExe)) {
      return `Generator not found:\n${config.generatorExe}`;
    }
    if (!Number.isFinite(req.lat) || req.lat < -90 || req.lat > 90) {
      return 'Latitude must be -90..90';
    }
    if (!Number.isFinite(req.lon) || req.lon < -180 || req.lon > 180) {
      return 'Longitude must be -180..180';
    }
    if (!Number.isFinite(req.alt)) {
      return 'Altitude must be a number';
    }
    if (!Number.isInteger(req.duration) || req.duration < 5) {
      return 'Duration must be >= 5';
    }
    if (!isValidUtc(req.utc)) {
      return 'UTC format: yyyy-MM-dd HH:mm:ss';
    }
    if (!rinexPath || !fs.existsSync(rinexPath)) {
      return "No RINEX. Use 'Get latest' or 'Browse'.";
    }

    const mk = presetFor(req.mode);
    this.mk = mk;
    const base = req.outName && req.outName.length > 0 ? req.outName : `SCENARIO_${req.mode}`;
    let out = path.join(config.signalDir, `${base}.bin`);
    const locked = storage.isLocked(out);
    if (locked) {
      const stamp = stampNow();
      out = path.join(config.signalDir, `${base}_${stamp}.bin`);
      this.logger.log(`Output in use (TX?) - writing ${path.basename(out)}`);
    }
    this.outPath = out;

    const utc = parseUtc(req.utc);
    if (!utc) {
      return 'UTC format: yyyy-MM-dd HH:mm:ss';
    }
    const cfgJson = path.join(config.configsDir, `_studio_${path.basename(out, '.bin')}.json`);
    const sys = mk.signals.map((s) => JSON.stringify(s)).join(',\n      ');
    const cfg = [
      '{',
      `  "version": 1.0,`,
      `  "description": "GNSS Studio scenario (direct SC16 Q11)",`,
      `  "time": { "type": "UTC", "year": ${utc.year}, "month": ${utc.month}, "day": ${utc.day}, "hour": ${utc.hour}, "minute": ${utc.minute}, "second": ${utc.second} },`,
      `  "trajectory": {`,
      `    "name": "point",`,
      `    "initPosition": { "type": "LLA", "format": "d", "longitude": ${num(req.lon)}, "latitude": ${num(req.lat)}, "altitude": ${num(req.alt)} },`,
      `    "initVelocity": { "type": "SCU", "speed": 0, "course": 0 },`,
      `    "trajectoryList": [ { "type": "Const", "time": ${req.duration} } ]`,
      `  },`,
      `  "ephemeris": { "type": "RINEX", "name": "${forward(rinexPath)}" },`,
      `  "output": {`,
      `    "type": "IFdata", "format": "IQ16", "sampleFreq": ${num(mk.rate)}, "centerFreq": ${num(mk.center)},`,
      `    "name": "${forward(out)}", "config": { "elevationMask": 3 },`,
      `    "systemSelect": [`,
      `      ${sys}`,
      `    ]`,
      `  },`,
      `  "power": { "noiseFloor": -172, "initPower": { "unit": "dBHz", "value": 47 }, "elevationAdjust": false }`,
      '}',
    ].join('\n');
    fs.writeFileSync(cfgJson, cfg, 'ascii');

    if (fs.existsSync(out) && !locked) {
      try {
        fs.unlinkSync(out);
      } catch {
        this.logger.log('Cannot overwrite (locked).');
        return 'Cannot overwrite (locked).';
      }
    }
    this.expBytes = Math.round(mk.rate * 1e6 * req.duration * 4);
    this.logger.log(
      `Generate [${req.mode}] ${num(req.lat)},${num(req.lon)},${num(req.alt)}m @ ${utcText(req.utc)}Z ${req.duration}s -> ${path.basename(out)}`
    );

    this.running = true;
    this.t0 = Date.now();
    this.emitProgress(0, 0);

    if (process.platform !== 'win32' && /\.[eE][xX][eE]$/.test(config.generatorExe)) {
      this.logger.log(
        'NOTE: IFdataGen_q11.exe is a Windows binary. On Linux set GENERATOR_WRAPPER=wine or run on Windows.'
      );
    }

    const args = ['-c', cfgJson, '-t'];
    const wrapper = config.generatorWrapper;
    const logStream = fs.createWriteStream(config.genLogFile, { flags: 'a' });
    const exe = wrapper.length > 0 ? wrapper[0] : config.generatorExe;
    const exeArgs = wrapper.length > 0 ? [...wrapper.slice(1), config.generatorExe, ...args] : args;
    let proc: ChildProcess;
    try {
      proc = spawn(exe, exeArgs, {
        cwd: path.join(__dirname, '..', '..'),
        env: config.childEnv(),
        windowsHide: true,
        stdio: ['ignore', 'pipe', 'pipe'],
      });
    } catch {
      this.running = false;
      logStream.close();
      return `Generator not found:\n${config.generatorExe}`;
    }
    this.proc = proc;
    proc.stdout?.on('data', (c: Buffer) => logStream.write(c));
    proc.stderr?.on('data', (c: Buffer) => logStream.write(c));
    proc.on('error', (err) => {
      if (!this.running) return;
      this.running = false;
      this.proc = null;
      this.stopTimer();
      logStream.close();
      const r: GenResult = { ok: false, message: `Generation failed (no file). (${err.message})` };
      this.logger.log('Generation failed (no file).');
      this.outPath = null;
      this.events?.onDone(r);
    });
    proc.on('close', () => {
      logStream.close();
      this.stopTimer();
      if (!this.running) return;
      this.finish();
    });
    if (!this.timer) {
      this.timer = setInterval(() => this.tick(), POLL_MS);
    }
    return null;
  }

  private finish(): void {
    this.running = false;
    this.proc = null;
    const out = this.outPath;
    if (!out || !fs.existsSync(out)) {
      const r: GenResult = { ok: false, message: 'Generation failed (no file).' };
      this.logger.log('Generation failed (no file).');
      this.events?.onDone(r);
      return;
    }
    const peak = getBinPeak(out);
    const mb = Math.round((fs.statSync(out).size / (1024 * 1024)) * 10) / 10;
    this.emitProgress(100, Date.now() - this.t0);
    if (peak <= 2047) {
      const r: GenResult = { ok: true, message: `Q11 PASS  peak |${peak}|  ${mb} MB`, fileName: path.basename(out), sizeMB: mb, peak, q11: true };
      this.logger.log(`Done. Q11 verified (peak |${peak}|). Loaded into transmit.`);
      this.logTxHint(path.basename(out));
      this.events?.onDone(r);
    } else {
      // Mirrors the studio app's Gen-Tick: warn only, never auto-convert.
      // The legacy IQ16 -> Q11 conversion stays a separate manual tool
      // (POST /api/signal/convert / spoofer-tools convert), exactly like the
      // original package's tools/iq16_to_q11.py. The non-Q11 file is left
      // on disk but is NOT loaded into transmit (parity with the original).
      this.logger.log('WARNING: output not Q11.');
      const r: GenResult = { ok: false, message: `peak |${peak}| > 2047 - not Q11!`, fileName: path.basename(out), sizeMB: mb, peak, q11: false };
      this.events?.onDone(r);
    }
  }

  /**
   * Mirrors the tail of Generate-Q11.ps1: prints the ready-to-paste
   * bladeRF-cli transmit command for the produced file.
   */
  private logTxHint(fileName: string): void {
    const mk = this.mk;
    if (!mk) return;
    const fcHz = Math.round(mk.center * 1e6);
    const fsHz = Math.round(mk.rate * 1e6);
    this.logger.log(`Transmit it (TX ${num(mk.center)} MHz / ${num(mk.rate)} Msps):`);
    this.logger.log(
      `  bladeRF-cli -e "set frequency tx1 ${fcHz}; set samplerate tx1 ${fsHz}; set bandwidth tx1 ${fsHz}; set gain tx1 55; tx config file=${fileName} format=bin repeat=0 buffers=256 samples=65536 xfers=32; tx start; tx wait"`
    );
  }

  private tick(): void {
    let len = 0;
    if (this.outPath && fs.existsSync(this.outPath)) {
      try {
        len = fs.statSync(this.outPath).size;
      } catch {
        len = 0;
      }
    }
    if (this.expBytes > 0) {
      const pct = Math.min(100, Math.floor((len / this.expBytes) * 100));
      this.emitProgress(pct, Date.now() - this.t0);
    }
    if (!this.proc || this.proc.exitCode === null) {
      return;
    }
    // Process exited between polls; the 'close' event performs the finish.
    this.stopTimer();
  }

  private emitProgress(percent: number, elapsedMs: number): void {
    this.events?.onProgress({ percent, elapsedMs });
  }

  private stopTimer(): void {
    if (this.timer) {
      clearInterval(this.timer);
      this.timer = null;
    }
  }

  /** Kills a running generator (shutdown path - mirrors Form_FormClosing). */
  kill(): void {
    if (this.proc && this.proc.exitCode === null) {
      try {
        this.proc.kill();
      } catch {
        // ignore
      }
    }
    this.stopTimer();
    this.running = false;
    this.proc = null;
  }
}

function isValidUtc(s: string): boolean {
  return parseUtc(s) !== null;
}

function parseUtc(s: string): { year: number; month: number; day: number; hour: number; minute: number; second: number } | null {
  const m = s.match(/^(\d{4})-(\d{2})-(\d{2}) (\d{2}):(\d{2}):(\d{2})$/);
  if (!m) return null;
  const y = parseInt(m[1], 10);
  const mo = parseInt(m[2], 10);
  const d = parseInt(m[3], 10);
  const h = parseInt(m[4], 10);
  const mi = parseInt(m[5], 10);
  const se = parseInt(m[6], 10);
  const dt = new Date(Date.UTC(y, mo - 1, d, h, mi, se));
  if (
    dt.getUTCFullYear() !== y ||
    dt.getUTCMonth() !== mo - 1 ||
    dt.getUTCDate() !== d ||
    dt.getUTCHours() !== h ||
    dt.getUTCMinutes() !== mi ||
    dt.getUTCSeconds() !== se
  ) {
    return null;
  }
  return { year: y, month: mo, day: d, hour: h, minute: mi, second: se };
}

function utcText(s: string): string {
  return s;
}

function num(v: number): string {
  return `${v}`;
}

function forward(p: string): string {
  return p.replace(/\\/g, '/');
}

function stampNow(): string {
  const d = new Date();
  const p = (n: number): string => `${n}`.padStart(2, '0');
  return `${d.getFullYear()}${p(d.getMonth() + 1)}${p(d.getDate())}_${p(d.getHours())}${p(d.getMinutes())}${p(d.getSeconds())}`;
}