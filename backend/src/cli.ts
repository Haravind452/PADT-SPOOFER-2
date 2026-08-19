#!/usr/bin/env node
/**
 * spoofer-tools - standalone CLI port of the original tools/check_q11.py and
 * tools/iq16_to_q11.py (same output text and exit-code semantics).
 *
 *   check <file.bin>                     full Q11 scan (check_q11.py port) - exit 0 PASS / 1 CHECK
 *   peak <file.bin>                      quick peak scan (Get-BinPeak port)  - exit 0
 *   convert <in.bin> <out.bin> [--headroom N] [--block N]  IQ16 -> Q11 (iq16_to_q11.py port)
 *
 * exit codes: 0 success, 1 operation failed / check failed, 2 usage error
 */
import * as fs from 'fs';
import { checkQ11, getBinPeak, iq16ToQ11 } from './services/q11';

const Q11_MIN = -2048;
const Q11_MAX = 2047;
const DEFAULT_BLOCK = 64 << 20;

function fail(message: string): never {
  console.error(message);
  process.exit(1);
}

function usage(): never {
  console.error('usage: spoofer-tools <check|peak|convert> [args]');
  console.error('  check <file.bin>                    full Q11 scan (check_q11.py port)');
  console.error('  peak <file.bin>                     quick peak scan (Get-BinPeak port)');
  console.error('  convert <in.bin> <out.bin> [--headroom N] [--block N]   IQ16 -> Q11 (iq16_to_q11.py port)');
  process.exit(2);
}

const args = process.argv.slice(2);
const cmd = args[0];

if (!cmd || !/^(check|peak|convert)$/.test(cmd)) usage();

if (cmd === 'check') {
  const file = args[1];
  if (!file) usage();
  if (!fs.existsSync(file)) fail(`file not found: ${file}`);
  const r = checkQ11(file);
  console.log(`file        : ${r.file}`);
  console.log(`I/Q values  : ${r.samples.toLocaleString('en-US')}  (${r.pairs.toLocaleString('en-US')} pairs)`);
  console.log(`peak max/min: ${r.peakMax} / ${r.peakMin}`);
  console.log(`on rail     : ${r.onRail.toLocaleString('en-US')}  = ${r.railPct.toFixed(4)}%`);
  console.log(`within Q11  : ${r.withinQ11 ? 'YES' : 'NO (values exceed +/-2047 -- NOT patched?)'}`);
  console.log(`verdict     : ${r.verdict}`);
  process.exit(r.withinQ11 ? 0 : 1);
}

if (cmd === 'peak') {
  const file = args[1];
  if (!file) usage();
  if (!fs.existsSync(file)) fail(`file not found: ${file}`);
  console.log(`peak ${getBinPeak(file)}`);
  process.exit(0);
}

if (cmd === 'convert') {
  const infile = args[1];
  const outfile = args[2];
  if (!infile || !outfile) usage();
  if (!fs.existsSync(infile)) fail(`file not found: ${infile}`);
  let headroom = 0.0;
  let block: number | undefined = DEFAULT_BLOCK;
  for (let i = 3; i < args.length; i++) {
    if (args[i] === '--headroom') {
      const v = Number(args[++i]);
      if (!Number.isFinite(v)) usage();
      headroom = v;
    } else if (args[i] === '--block') {
      const v = Number(args[++i]);
      if (!Number.isInteger(v) || v <= 0) usage();
      block = v;
    } else {
      usage();
    }
  }
  try {
    const r = iq16ToQ11(infile, outfile, headroom, block);
    console.log(`done: ${r.pairs} I/Q pairs -> ${r.outFile}  (${r.mode}, clamp [${Q11_MIN},${Q11_MAX}])`);
    process.exit(0);
  } catch (err) {
    fail(`conversion failed: ${(err as Error).message}`);
  }
}