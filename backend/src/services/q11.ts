import * as fs from 'fs';

const Q11_MAX = 2047;
const Q11_MIN = -2048;
const DEFAULT_BLOCK = 64 << 20; // int16 samples per block (64 Mi) - mirrors iq16_to_q11.py

export interface CheckQ11Result {
  file: string;
  samples: number;
  pairs: number;
  peakMax: number;
  peakMin: number;
  onRail: number;
  railPct: number;
  withinQ11: boolean;
  verdict: 'PASS' | 'CHECK';
}

/**
 * Mirrors tools/check_q11.py: full-scan I/Q peak + rail fraction.
 */
export function checkQ11(file: string): CheckQ11Result {
  const fd = fs.openSync(file, 'r');
  let pmax = -32768;
  let pmin = 32767;
  let rail = 0;
  let total = 0;
  const buf = Buffer.alloc(DEFAULT_BLOCK * 2);
  try {
    while (true) {
      const rd = fs.readSync(fd, buf, 0, buf.length, null);
      if (rd <= 0) break;
      const n = Math.floor(rd / 2);
      for (let i = 0; i < n; i++) {
        const v = buf.readInt16LE(i * 2);
        if (v > pmax) pmax = v;
        if (v < pmin) pmin = v;
        if (v >= Q11_MAX || v <= Q11_MIN) rail++;
      }
      total += n;
    }
  } finally {
    fs.closeSync(fd);
  }
  const frac = total > 0 ? (100.0 * rail) / total : 0;
  const inRange = pmax <= Q11_MAX && pmin >= Q11_MIN;
  const verdict = inRange && frac < 1.0 ? 'PASS' : 'CHECK';
  return {
    file,
    samples: total,
    pairs: Math.floor(total / 2),
    peakMax: pmax,
    peakMin: pmin,
    onRail: rail,
    railPct: Math.round(frac * 10000) / 10000,
    withinQ11: inRange,
    verdict,
  };
}

/**
 * Mirrors Get-BinPeak in the studio app: reads up to `maxSamples` int16
 * values and returns the maximum absolute magnitude.
 */
export function getBinPeak(file: string, maxSamples = 4_000_000): number {
  const fd = fs.openSync(file, 'r');
  const len = fs.fstatSync(fd).size;
  const take = Math.min(maxSamples, Math.floor(len / 2));
  let peak = 0;
  try {
    const buf = Buffer.alloc(take * 2);
    const rd = fs.readSync(fd, buf, 0, buf.length, null);
    const n = Math.floor(rd / 2);
    for (let i = 0; i < n; i++) {
      let v = buf.readInt16LE(i * 2);
      if (v < 0) v = -v;
      if (v > peak) peak = v;
    }
  } finally {
    fs.closeSync(fd);
  }
  return peak;
}

export interface ConvertResult {
  outFile: string;
  pairs: number;
  mode: string;
}

/**
 * Mirrors tools/iq16_to_q11.py: legacy full-range IQ16 -> SC16 Q11.
 * headroom 0 uses the exact integer path (arithmetic >>4); otherwise a
 * fractional scale of (1/16) * 10^(-headroom/20), then clamp [-2048, 2047].
 * `block` is the int16-sample I/O block size (the python tool's --block).
 */
export function iq16ToQ11(inFile: string, outFile: string, headroom = 0.0, block?: number): ConvertResult {
  if (typeof block !== 'number' || !Number.isInteger(block) || block <= 0) {
    block = DEFAULT_BLOCK;
  }
  const integerPath = headroom === 0.0;
  const fracScale = (1.0 / 16.0) * Math.pow(10.0, -headroom / 20.0);
  const fi = fs.openSync(inFile, 'r');
  const fo = fs.openSync(outFile, 'w');
  let total = 0;
  const readBytes = block * 2;
  const buf = Buffer.alloc(readBytes);
  try {
    while (true) {
      const rd = fs.readSync(fi, buf, 0, buf.length, null);
      if (rd <= 0) break;
      const n = Math.floor(rd / 2);
      const out = Buffer.allocUnsafe(n * 2);
      for (let i = 0; i < n; i++) {
        const x = buf.readInt16LE(i * 2);
        let y: number;
        if (integerPath) {
          y = x >> 4;
        } else {
          y = Math.round(x * fracScale);
        }
        if (y > Q11_MAX) y = Q11_MAX;
        if (y < Q11_MIN) y = Q11_MIN;
        out.writeInt16LE(y, i * 2);
      }
      fs.writeSync(fo, out, 0, n * 2);
      total += n;
    }
  } finally {
    fs.closeSync(fi);
    fs.closeSync(fo);
  }
  const mode = integerPath ? '>>4 integer' : `scale ${fracScale}`;
  return { outFile, pairs: Math.floor(total / 2), mode };
}