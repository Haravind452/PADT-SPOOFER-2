import * as fs from 'fs';
import * as path from 'path';
import { config } from './config';
import { Logger } from './logger';
import { MODE_PRESETS, DEFAULT_SETTINGS, type AppState, type GenRequest, type GenResult, type GenMode, type TxStartedInfo, type UiSettings } from './types';
import { StorageService } from './services/storage';
import { GeneratorService } from './services/generator';
import { BladeRfService } from './services/bladeRf';
import { RinexService } from './services/rinex';
import { createSettingsStore, type SettingsStore } from './services/settingsStore';

export interface StudioEvents {
  emit(event: string, payload: unknown): void;
}

export class Studio {
  readonly logger: Logger;
  readonly storage: StorageService;
  readonly generator: GeneratorService;
  readonly bladeRf: BladeRfService;
  readonly rinexTool: RinexService;
  readonly settingsStore: SettingsStore;

  rinex: string | null = null;
  txFile: string | null = null;
  settings: UiSettings = { ...DEFAULT_SETTINGS };
  genResult: GenResult | null = null;
  genProgress: { percent: number; elapsedMs: number } | null = null;
  txInfo: TxStartedInfo | null = null;

  private events: StudioEvents | null = null;

  constructor() {
    this.logger = new Logger();
    this.storage = new StorageService();
    this.generator = new GeneratorService(this.logger);
    this.bladeRf = new BladeRfService(this.logger);
    this.rinexTool = new RinexService(this.logger);
    this.settingsStore = createSettingsStore();

    this.generator.attach({
      onLog: (l) => this.logger.log(l),
      onProgress: (p) => {
        this.genProgress = p;
        this.emit('gen:progress', p);
      },
      onDone: (r) => {
        this.genResult = r;
        this.genProgress = { percent: 100, elapsedMs: this.genProgress?.elapsedMs ?? 0 };
        if (r.ok && r.fileName) {
          this.txFile = r.fileName;
          this.bladeRf.loadTag(path.join(config.signalDir, r.fileName));
        }
        this.emit('gen:done', r);
        this.emit('state:sync', this.snapshot());
      },
    });

    this.bladeRf.attach({
      onLog: (l) => this.logger.log(l),
      onStarted: (info) => {
        this.txInfo = info;
        this.emit('tx:started', info);
        this.emit('state:sync', this.snapshot());
      },
      onStopped: () => {
        this.txInfo = null;
        this.emit('tx:stopped', {});
        this.emit('state:sync', this.snapshot());
      },
      onOutput: (line) => this.emit('tx:output', { line }),
    });
  }

  attach(events: StudioEvents): void {
    this.events = events;
    this.logger.onLine((line) => this.emit('log:append', { line }));
  }

  emit(event: string, payload: unknown): void {
    this.events?.emit(event, payload);
  }

  async init(): Promise<void> {
    this.storage.ensureDirs();
    try {
      this.settings = { ...DEFAULT_SETTINGS, ...(await this.settingsStore.load()) };
    } catch {
      this.settings = { ...DEFAULT_SETTINGS };
    }
    const newest = this.storage.newestRinex();
    if (newest) {
      this.rinex = newest;
      const utc = this.rinexTool.utcString(newest);
      if (utc) this.settings.utc = utc;
    }
    const kind = config.generatorExe.includes('IFdataGen_q11') ? 'direct Q11' : 'IQ16 (will need convert)';
    this.logger.log(`Generator: ${config.generatorExe}  [${kind}]`);
    this.logger.log('Ready. Pick coordinates + mode, GENERATE, then START TX. Cold-start the receiver.');
  }

  async saveSettings(s: Partial<UiSettings>): Promise<void> {
    this.settings = { ...this.settings, ...s };
    await this.settingsStore.save(this.settings);
    this.emit('state:sync', this.snapshot());
  }

  isGenerating(): boolean {
    return this.generator.isRunning();
  }

  isTransmitting(): boolean {
    return this.bladeRf.isRunning();
  }

  /** Returns message-box style error text or null when started. */
  startGenerate(req: GenRequest): string | null {
    return this.generator.start(req, this.rinex);
  }

  /** Returns message-box style error text or null when started. */
  startTransmit(file: string | null, gain: number, loop: boolean): string | null {
    const target = file ?? this.txFile;
    if (!target) {
      const err = 'TX file not found. Generate or Browse first.';
      this.logger.log(`TX start failed - ${err}`);
      return err;
    }
    const err = this.bladeRf.start(target, gain, loop);
    if (err) {
      this.logger.log(`TX start failed - ${err}`);
    }
    return err;
  }

  async stopTransmit(): Promise<void> {
    if (!this.bladeRf.isRunning()) {
      this.logger.log('TX stop - already idle.');
      return;
    }
    await this.bladeRf.stop();
  }

  setTxGain(gain: number): void {
    this.bladeRf.setGain(gain);
    this.settings = { ...this.settings, gain };
    this.emit('state:sync', this.snapshot());
  }

  selectRinex(name: string): string | null {
    const full = path.join(config.ephemerisDir, name);
    if (!fs.existsSync(full)) return 'RINEX file not found on server.';
    this.rinex = full;
    this.emit('state:sync', this.snapshot());
    return null;
  }

  matchRinex(): { file: string | null; utc: string | null } {
    this.rinex = this.storage.newestRinex();
    const utc = this.rinexTool.utcString(this.rinex);
    this.emit('state:sync', this.snapshot());
    return { file: this.rinex, utc };
  }

  selectSignal(name: string): string | null {
    const full = path.join(config.signalDir, name);
    if (!fs.existsSync(full)) return 'TX file not found on server.';
    this.txFile = name;
    this.bladeRf.loadTag(full);
    this.emit('state:sync', this.snapshot());
    return null;
  }

  async downloadLatestRinex(): Promise<void> {
    const result = await this.rinexTool.downloadLatest();
    if (result.ok && result.file) {
      this.rinex = result.file;
      this.emit('rinex:ready', { fileName: result.fileName, utc: result.utc });
      this.emit('state:sync', this.snapshot());
    } else {
      this.emit('rinex:status', { message: result.message ?? 'Download failed.' });
    }
  }

  /**
   * Mirrors Form_FormClosing in the original app: graceful TX stop
   * (tx stop -> quit -> kill fallback), then kill the generator.
   */
  async shutdown(): Promise<void> {
    await this.bladeRf.stop();
    this.generator.kill();
  }

  snapshot(): AppState {
    return {
      generating: this.isGenerating(),
      transmitting: this.isTransmitting(),
      rinex: this.rinex ? path.basename(this.rinex) : null,
      txFile: this.txFile,
      txFreqMHz: this.bladeRf.currentTag().fLoMHz,
      txRateMsps: this.bladeRf.currentTag().fSMHz,
      gain: this.settings.gain,
      loop: this.settings.loop,
      genProgress: this.genProgress,
      genResult: this.genResult,
      settings: { ...this.settings },
      logHistory: this.logger.history(),
    };
  }

  modes(): typeof MODE_PRESETS {
    return MODE_PRESETS;
  }

  defaultMode(): GenMode {
    return 'fast';
  }
}
