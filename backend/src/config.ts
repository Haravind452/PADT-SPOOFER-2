import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';

function env(name: string, fallback: string): string {
  const v = process.env[name];
  return v !== undefined && v.length > 0 ? v : fallback;
}

function envInt(name: string, fallback: number): number {
  const v = process.env[name];
  if (v === undefined || v.length === 0) return fallback;
  const n = parseInt(v, 10);
  return Number.isFinite(n) ? n : fallback;
}

function envList(name: string): string[] {
  const v = process.env[name];
  if (v === undefined || v.trim().length === 0) return [];
  return v.split(/\s+/).filter((x) => x.length > 0);
}

export class Config {
  readonly port: number;
  readonly host: string;

  readonly resourcesDir: string;
  readonly binDir: string;
  readonly bladeRFDir: string;
  readonly ephemerisDir: string;
  readonly signalDir: string;
  readonly configsDir: string;

  readonly generatorExe: string;
  readonly generatorWrapper: string[];
  readonly bladeRfCli: string;
  readonly bladeRfCliBundled: boolean;
  readonly bladeRfSearchDir: string;

  readonly genLogFile: string;
  readonly redisUrl: string | null;

  constructor() {
    this.port = envInt('PORT', 3000);
    this.host = env('HOST', '0.0.0.0');

    this.resourcesDir = env('RESOURCES_DIR', path.join(__dirname, '..', 'resources'));
    this.binDir = env('BIN_DIR', path.join(this.resourcesDir, 'bin'));
    this.bladeRFDir = env('BLADERF_DIR', path.join(this.resourcesDir, 'bladeRF'));
    this.ephemerisDir = env('EPHEMERIS_DIR', path.join(this.resourcesDir, 'ephemeris'));
    this.signalDir = env('SIGNAL_DIR', path.join(this.resourcesDir, 'signal'));
    this.configsDir = env('CONFIGS_DIR', path.join(this.resourcesDir, 'configs'));

    let genExe = env('GENERATOR_EXE', path.join(this.binDir, 'IFdataGen_q11.exe'));
    // Mirrors the original studio app: prefer the bundled generator, fall back
    // to the legacy SignalSim install path when the bundled one is missing.
    if (!fsExists(genExe)) {
      const legacy = 'D:\\SignalSim\\IFdataGen\\IFdataGen_q11.exe';
      if (fsExists(legacy)) genExe = legacy;
    }
    this.generatorExe = genExe;
    this.generatorWrapper = envList('GENERATOR_WRAPPER');
    this.bladeRfSearchDir = env('BLADERF_SEARCH_DIR', this.bladeRFDir);

    const bundledCli = path.join(this.bladeRFDir, 'bladeRF-cli.exe');
    this.bladeRfCliBundled = fsExists(bundledCli);
    this.bladeRfCli = env('BLADERF_CLI', this.bladeRfCliBundled ? bundledCli : 'bladeRF-cli');

    this.genLogFile = env('GEN_LOG_FILE', path.join(os.tmpdir(), 'gnss_studio_gen.log'));
    const ru = process.env['REDIS_URL'];
    this.redisUrl = ru !== undefined && ru.length > 0 ? ru : null;
  }

  childEnv(): NodeJS.ProcessEnv {
    const envBase: NodeJS.ProcessEnv = { ...process.env };
    if (this.bladeRfCliBundled) {
      envBase['BLADERF_SEARCH_DIR'] = this.bladeRfSearchDir;
      envBase['PATH'] = this.bladeRFDir + path.delimiter + (process.env['PATH'] ?? '');
    }
    return envBase;
  }

  /**
   * True when the bladeRF CLI is reachable: either the bundled exe exists or
   * `bladeRF-cli` / `bladeRF-cli.exe` is present on PATH.
   */
  bladeRfCliAvailable(): boolean {
    if (this.bladeRfCliBundled) return true;
    if (fsExists(this.bladeRfCli)) return true;
    const parts = (process.env['PATH'] ?? '').split(path.delimiter);
    for (const dir of parts) {
      if (dir.length === 0) continue;
      for (const cand of [this.bladeRfCli, 'bladeRF-cli', 'bladeRF-cli.exe']) {
        if (fsExists(path.join(dir, cand))) return true;
      }
    }
    return false;
  }
}

function fsExists(p: string): boolean {
  try {
    fs.statSync(p);
    return true;
  } catch {
    return false;
  }
}

export const config = new Config();
