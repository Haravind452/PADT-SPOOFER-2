import * as fs from 'fs';
import * as path from 'path';
import { spawn, ChildProcessWithoutNullStreams } from 'child_process';
import { config } from '../config';
import { storage } from './storage';
import { Logger } from '../logger';
import type { TagInfo, TxStartedInfo } from '../types';

const DEFAULT_TX_FC = 1568.286; // MHz
const DEFAULT_TX_FS = 18.48; // Msps

export interface BladeRfEvents {
  onLog(line: string): void;
  onStarted(info: TxStartedInfo): void;
  onStopped(): void;
  onOutput(line: string): void;
}

/**
 * bladeRF transmission via the interactive bladeRF-cli. Mirrors the studio
 * app: spawn `bladeRF-cli -i`, drive it over stdin, tag-aware file
 * parameters (F_S / F_LO from the .tag file, defaults 1568.286/18.48),
 * live gain changes, and a clean stop (tx stop -> quit -> kill fallback).
 */
export class BladeRfService {
  private logger: Logger;
  private events: BladeRfEvents | null = null;
  private proc: ChildProcessWithoutNullStreams | null = null;
  private tag: TagInfo = { fLoMHz: DEFAULT_TX_FC, fSMHz: DEFAULT_TX_FS };
  private stopping = false;

  constructor(logger: Logger) {
    this.logger = logger;
  }

  attach(events: BladeRfEvents): void {
    this.events = events;
  }

  isRunning(): boolean {
    return this.proc !== null && this.proc.exitCode === null;
  }

  loadTag(binPath: string): TagInfo {
    this.tag = storage.readTag(binPath) ?? { fLoMHz: DEFAULT_TX_FC, fSMHz: DEFAULT_TX_FS };
    return this.tag;
  }

  currentTag(): TagInfo {
    return this.tag;
  }

  /**
   * Mirrors the START TX handler. Returns an error message (message-box
   * text) or null when the TX session started.
   */
  start(file: string, gain: number, loop: boolean): string | null {
    if (this.isRunning()) return 'Transmission already running';
    if (!config.bladeRfCliAvailable()) {
      this.logger.log('ERROR: bladeRF-cli not found on PATH?');
      return 'bladeRF-cli not found / on PATH?';
    }
    const bin = path.resolve(config.signalDir, file);
    if (!fs.existsSync(bin)) {
      return 'TX file not found. Generate or Browse first.';
    }
    this.loadTag(bin);
    const fcHz = Math.round(this.tag.fLoMHz * 1e6);
    const fsHz = Math.round(this.tag.fSMHz * 1e6);
    const rep = loop ? 0 : 1;
    const binDir = path.dirname(bin);
    const binName = path.basename(bin);
    const proc = spawn(config.bladeRfCli, ['-i'], {
      cwd: binDir,
      env: config.childEnv(),
      windowsHide: true,
      stdio: ['pipe', 'pipe', 'pipe'],
    });
    proc.on('error', (err) => {
      this.logger.log('ERROR: bladeRF-cli not found on PATH?');
      this.proc = null;
      if (this.events) this.events.onStopped();
      void err;
    });
    proc.stdout?.on('data', (c: Buffer) => this.forwardOutput(c));
    proc.stderr?.on('data', (c: Buffer) => this.logger.log(`bladeRF: ${c.toString().trimEnd()}`));
    proc.on('close', (code) => {
      this.proc = null;
      if (!this.stopping) {
        this.logger.log(`bladeRF-cli exited (code ${code ?? 'unknown'}).`);
      }
      if (this.events) this.events.onStopped();
    });
    this.proc = proc;
    this.stopping = false;

    this.send(`set frequency tx1 ${fcHz}`);
    this.send(`set samplerate tx1 ${fsHz}`);
    this.send(`set bandwidth tx1 ${fsHz}`);
    this.send(`set gain tx1 ${gain}`);
    this.send(`tx config file=${binName} format=bin repeat=${rep} buffers=256 samples=65536 xfers=32`);
    this.send('tx start');
    this.logger.log(
      `TX ON - ${this.tag.fLoMHz} MHz / ${this.tag.fSMHz} Msps, gain ${gain} dB, ${loop ? 'loop' : 'once'}`
    );
    this.events?.onStarted({
      file: bin,
      freqMHz: this.tag.fLoMHz,
      rateMsps: this.tag.fSMHz,
      gain,
      loop,
    });
    return null;
  }

  /**
   * Mirrors SendCli: writes a line to the interactive CLI, no-op when no
   * session is active.
   */
  send(line: string): void {
    const p = this.proc;
    if (p && p.exitCode === null && p.stdin.writable) {
      p.stdin.write(line + '\n');
    }
  }

  /** Live gain change from the slider. */
  setGain(gain: number): void {
    if (this.isRunning()) {
      this.send(`set gain tx1 ${gain}`);
      this.logger.log(`TX gain set to ${gain} dB`);
    }
  }

  /**
   * Mirrors Stop-Tx: `tx stop`, brief pause, `quit`, wait ~3 s, kill
   * fallback. Resolves when the device is released.
   */
  stop(): Promise<void> {
    return new Promise((resolve) => {
      const p = this.proc;
      if (!p || p.exitCode !== null) {
        this.events?.onStopped();
        resolve();
        return;
      }
      this.stopping = true;
      this.send('tx stop');
      setTimeout(() => {
        this.send('quit');
        const t = setTimeout(() => {
          try {
            p.kill();
          } catch {
            // already gone
          }
        }, 3000);
        p.once('close', () => {
          clearTimeout(t);
          this.proc = null;
          this.logger.log('TX OFF - device released.');
          this.events?.onStopped();
          resolve();
        });
      }, 200);
    });
  }

  /** Hard-kill without graceful commands (used on shutdown). */
  kill(): void {
    if (this.proc && this.proc.exitCode === null) {
      try {
        this.proc.kill();
      } catch {
        // ignore
      }
    }
    this.proc = null;
  }

  private forwardOutput(c: Buffer): void {
    const text = c.toString('utf8');
    for (const line of text.split('\n')) {
      const t = line.trimEnd();
      if (t.length > 0) this.events?.onOutput(t);
    }
  }
}