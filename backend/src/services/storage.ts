import * as fs from 'fs';
import * as path from 'path';
import { config } from '../config';
import type { RinexFileEntry, SignalFileEntry, TagInfo } from '../types';

export interface DirEntry {
  name: string;
  sizeMB: number;
  modified: string;
}

export class StorageService {
  ensureDirs(): void {
    for (const d of [config.signalDir, config.configsDir, config.ephemerisDir]) {
      fs.mkdirSync(d, { recursive: true });
    }
  }

  signalDir(): string {
    return config.signalDir;
  }

  configsDir(): string {
    return config.configsDir;
  }

  ephemerisDir(): string {
    return config.ephemerisDir;
  }

  newestRinex(): string | null {
    const files = fs
      .readdirSync(config.ephemerisDir, { withFileTypes: true })
      .filter((e) => e.isFile() && e.name.toLowerCase().endsWith('.rnx'))
      .map((e) => path.join(config.ephemerisDir, e.name))
      .sort((a, b) => fs.statSync(b).mtimeMs - fs.statSync(a).mtimeMs);
    return files.length > 0 ? files[0] : null;
  }

  isLocked(p: string): boolean {
    if (!fs.existsSync(p)) return false;
    try {
      const fd = fs.openSync(p, 'r+');
      fs.closeSync(fd);
      return false;
    } catch {
      return true;
    }
  }

  listRinex(): RinexFileEntry[] {
    return this.listDir(config.ephemerisDir, /\.rnx$/i);
  }

  listSignal(): SignalFileEntry[] {
    const dir = config.signalDir;
    if (!fs.existsSync(dir)) return [];
    return fs
      .readdirSync(dir, { withFileTypes: true })
      .filter((e) => e.isFile() && e.name.toLowerCase().endsWith('.bin'))
      .map((e) => {
        const full = path.join(dir, e.name);
        const st = fs.statSync(full);
        const tag = this.readTag(full);
        return {
          name: e.name,
          sizeMB: Math.round(st.size / (1024 * 1024) * 10) / 10,
          modified: st.mtime.toISOString(),
          tag,
        };
      })
      .sort((a, b) => a.name.localeCompare(b.name));
  }

  readTag(binPath: string): TagInfo | null {
    const tag = binPath + '.tag';
    if (!fs.existsSync(tag)) return null;
    let fLo = 1568.286;
    let fS = 18.48;
    const text = fs.readFileSync(tag, 'utf8');
    const mS = text.match(/F_S\s*=\s*([\d.]+)/);
    const mLo = text.match(/F_LO\s*=\s*([\d.]+)/);
    if (mS) fS = parseFloat(mS[1]);
    if (mLo) fLo = parseFloat(mLo[1]);
    return { fLoMHz: fLo, fSMHz: fS };
  }

  private listDir(dir: string, filter: RegExp): RinexFileEntry[] {
    if (!fs.existsSync(dir)) return [];
    return fs
      .readdirSync(dir, { withFileTypes: true })
      .filter((e) => e.isFile() && filter.test(e.name))
      .map((e) => {
        const st = fs.statSync(path.join(dir, e.name));
        return {
          name: e.name,
          sizeMB: Math.round(st.size / (1024 * 1024) * 10) / 10,
          modified: st.mtime.toISOString(),
        };
      })
      .sort((a, b) => a.name.localeCompare(b.name));
  }
}

export const storage = new StorageService();