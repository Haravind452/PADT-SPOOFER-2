import * as fs from 'fs';
import * as https from 'https';
import * as path from 'path';
import * as zlib from 'zlib';
import { config } from '../config';
import { Logger } from '../logger';

export interface DownloadResult {
  ok: boolean;
  file?: string;
  fileName?: string;
  utc?: string;
  message?: string;
}

export class RinexService {
  private logger: Logger;

  constructor(logger: Logger) {
    this.logger = logger;
  }

  /**
   * Mirrors Rinex-Utc in the studio app: date parsed from a RINEX filename
   * like *_R_<YYYY><DOY><HHMM>_* -> Jan 1 + (doy-1) days + 10 hours (UTC).
   * Like the original, falls back to the current UTC time when no file or no
   * matching name is given.
   */
  utcFromName(file: string | null): Date {
    if (!file) return new Date();
    const m = path.basename(file).match(/_R_(\d{4})(\d{3})\d{4}_/);
    if (!m) return new Date();
    const yr = parseInt(m[1], 10);
    const doy = parseInt(m[2], 10);
    return new Date(Date.UTC(yr, 0, 1) + (doy - 1) * 86400000 + 10 * 3600000);
  }

  utcString(file: string | null): string {
    return formatUtc(this.utcFromName(file));
  }

  /**
   * Mirrors the "Get latest" handler: download yesterday's broadcast RINEX
   * (WRD mirror first, then IGS), verify size, gunzip into ephemeris/.
   */
  downloadLatest(): Promise<DownloadResult> {
    return new Promise((resolve) => {
      const d = new Date(Date.now() - 86400000);
      const yyyy = d.getFullYear();
      const doy = dayOfYear(d);
      const fname = `BRDC00IGS_R_${yyyy}${pad3(doy)}0000_01D_MN.rnx`;
      const gzPath = path.join(config.signalDir, `${fname}.downloading.gz`);
      const outPath = path.join(config.ephemerisDir, fname);
      const candidates = [
        `https://igs.bkg.bund.de/root_ftp/IGS/BRDC/${yyyy}/${pad3(doy)}/BRDC00WRD_R_${yyyy}${pad3(doy)}0000_01D_MN.rnx.gz`,
        `https://igs.bkg.bund.de/root_ftp/IGS/BRDC/${yyyy}/${pad3(doy)}/BRDC00IGS_R_${yyyy}${pad3(doy)}0000_01D_MN.rnx.gz`,
      ];
      this.logger.log(`Downloading RINEX ${yyyy} DOY ${pad3(doy)} ...`);
      const tryMirror = (idx: number): void => {
        if (idx >= candidates.length) {
          const yy = `${yyyy}`.slice(2);
          this.logger.log(
            `All mirrors failed. Manual (CDDIS login): https://cddis.nasa.gov/archive/gnss/data/daily/${yyyy}/${pad3(doy)}/${yy}p/${fname}.gz`
          );
          resolve({ ok: false, message: 'All mirrors failed.' });
          return;
        }
        downloadToFile(candidates[idx], gzPath)
          .then((size) => {
            if (size <= 100000) {
              this.logger.log('  mirror failed');
              tryMirror(idx + 1);
              return;
            }
            fs.mkdirSync(config.ephemerisDir, { recursive: true });
            gunzipFile(gzPath, outPath);
            this.logger.log(`RINEX ready: ${fname}`);
            resolve({ ok: true, file: outPath, fileName: fname, utc: this.utcString(outPath) });
          })
          .catch(() => {
            this.logger.log('  mirror failed');
            tryMirror(idx + 1);
          });
      };
      tryMirror(0);
    });
  }
}

function downloadToFile(url: string, outFile: string): Promise<number> {
  return new Promise((resolve, reject) => {
    const out = fs.createWriteStream(outFile);
    const req = https.get(
      url,
      { headers: { 'User-Agent': 'bladeRF-GNSS-Studio/1.0' } },
      (res) => {
        if (res.statusCode !== undefined && res.statusCode >= 300 && res.statusCode < 400 && res.headers.location) {
          out.destroy();
          req.destroy();
          const next = new URL(res.headers.location, url).toString();
          downloadToFile(next, outFile).then(resolve, reject);
          return;
        }
        if (res.statusCode !== 200) {
          out.destroy();
          req.destroy();
          reject(new Error(`HTTP ${res.statusCode}`));
          return;
        }
        res.pipe(out);
        out.on('finish', () => {
          const st = fs.statSync(outFile);
          resolve(st.size);
        });
      }
    );
    req.setTimeout(60000, () => {
      out.destroy();
      req.destroy();
      reject(new Error('timeout'));
    });
    req.on('error', (err) => {
      out.destroy();
      reject(err);
    });
  });
}

function gunzipFile(gzPath: string, outPath: string): void {
  const gz = fs.readFileSync(gzPath);
  const data = zlib.gunzipSync(gz);
  fs.writeFileSync(outPath, data);
  try {
    fs.unlinkSync(gzPath);
  } catch {
    // best effort cleanup
  }
}

function dayOfYear(d: Date): number {
  const start = new Date(d.getFullYear(), 0, 0);
  const day = new Date(d.getFullYear(), d.getMonth(), d.getDate());
  return Math.floor((day.getTime() - start.getTime()) / 86400000);
}

function pad3(n: number): string {
  return `${n}`.padStart(3, '0');
}

function formatUtc(d: Date): string {
  const p = (n: number): string => `${n}`.padStart(2, '0');
  return `${d.getUTCFullYear()}-${p(d.getUTCMonth() + 1)}-${p(d.getUTCDate())} ${p(d.getUTCHours())}:${p(d.getUTCMinutes())}:${p(d.getUTCSeconds())}`;
}