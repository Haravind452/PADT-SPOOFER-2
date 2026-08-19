import * as fs from 'fs';
import * as path from 'path';
import express, { type Express, type Request, type Response } from 'express';
import multer from 'multer';
import { config } from './config';
import { Studio } from './studio';
import { checkQ11, getBinPeak, iq16ToQ11 } from './services/q11';

const MAX_UPLOAD = 4 * 1024 * 1024 * 1024; // 4 GB

export function createApp(studio: Studio): Express {
  const app = express();
  app.use(express.json({ limit: '1mb' }));

  const rinexUpload = multer({
    storage: multer.diskStorage({
      destination: (_req, _file, cb) => {
        fs.mkdirSync(config.ephemerisDir, { recursive: true });
        cb(null, config.ephemerisDir);
      },
      filename: (_req, file, cb) => {
        cb(null, sanitize(file.originalname));
      },
    }),
    limits: { fileSize: MAX_UPLOAD },
  });

  const signalUpload = multer({
    storage: multer.diskStorage({
      destination: (_req, _file, cb) => {
        fs.mkdirSync(config.signalDir, { recursive: true });
        cb(null, config.signalDir);
      },
      filename: (_req, file, cb) => {
        cb(null, sanitize(file.originalname));
      },
    }),
    limits: { fileSize: MAX_UPLOAD },
  });

  app.get('/api/health', (_req: Request, res: Response) => {
    res.json({
      ok: true,
      platform: process.platform,
      node: process.version,
      generator: {
        exe: config.generatorExe,
        found: fs.existsSync(config.generatorExe),
        wrapper: config.generatorWrapper,
        kind: config.generatorExe.includes('IFdataGen_q11') ? 'direct Q11' : 'IQ16 (will need convert)',
      },
      bladeRf: {
        cli: config.bladeRfCli,
        bundled: config.bladeRfCliBundled,
        found: config.bladeRfCliAvailable(),
      },
      dirs: {
        bin: config.binDir,
        bladeRF: config.bladeRFDir,
        ephemeris: config.ephemerisDir,
        signal: config.signalDir,
        configs: config.configsDir,
      },
      genLogFile: config.genLogFile,
      redis: config.redisUrl !== null,
    });
  });

  app.get('/api/state', (_req: Request, res: Response) => {
    res.json(studio.snapshot());
  });

  app.get('/api/modes', (_req: Request, res: Response) => {
    res.json({ modes: studio.modes(), default: studio.defaultMode() });
  });

  app.get('/api/rinex/list', (_req: Request, res: Response) => {
    res.json({ files: studio.storage.listRinex() });
  });

  app.get('/api/signal/list', (_req: Request, res: Response) => {
    res.json({ files: studio.storage.listSignal() });
  });

  app.post('/api/upload/rinex', rinexUpload.single('file'), (req: Request, res: Response) => {
    // eslint-disable-next-line no-console
    console.log(`[RX api] upload/rinex file: ${req.file?.originalname ?? 'none'} -> ${req.file?.filename ?? ''} (${req.file?.size ?? 0} bytes)`);
    if (!req.file) {
      res.status(400).json({ error: 'No file uploaded.' });
      return;
    }
    const name = path.basename(req.file.path);
    studio.selectRinex(name);
    res.json({ ok: true, name, utc: studio.rinexTool.utcString(studio.rinex) });
  });

  app.post('/api/upload/signal', signalUpload.single('file'), (req: Request, res: Response) => {
    // eslint-disable-next-line no-console
    console.log(`[RX api] upload/signal file: ${req.file?.originalname ?? 'none'} -> ${req.file?.filename ?? ''} (${req.file?.size ?? 0} bytes)`);
    if (!req.file) {
      res.status(400).json({ error: 'No file uploaded.' });
      return;
    }
    const name = path.basename(req.file.path);
    studio.selectSignal(name);
    res.json({ ok: true, name });
  });

  app.post('/api/signal/check', (req: Request, res: Response) => {
    // eslint-disable-next-line no-console
    console.log(`[RX api] signal/check body: ${JSON.stringify(req.body)}`);
    const file = resolveSignalPath(req.body?.file);
    if (!file) {
      res.status(400).json({ error: 'Invalid file.' });
      return;
    }
    if (!file.endsWith('.bin')) {
      res.status(400).json({ error: 'Not a .bin file.' });
      return;
    }
    try {
      res.json({ ok: true, result: checkQ11(file) });
    } catch (err) {
      res.status(500).json({ error: `Scan failed: ${(err as Error).message}` });
    }
  });

  app.post('/api/signal/peak', (req: Request, res: Response) => {
    // eslint-disable-next-line no-console
    console.log(`[RX api] signal/peak body: ${JSON.stringify(req.body)}`);
    const file = resolveSignalPath(req.body?.file);
    if (!file) {
      res.status(400).json({ error: 'Invalid file.' });
      return;
    }
    try {
      res.json({ ok: true, peak: getBinPeak(file) });
    } catch (err) {
      res.status(500).json({ error: `Scan failed: ${(err as Error).message}` });
    }
  });

  app.post('/api/signal/convert', (req: Request, res: Response) => {
    // eslint-disable-next-line no-console
    console.log(`[RX api] signal/convert body: ${JSON.stringify(req.body)}`);
    const inFile = resolveSignalPath(req.body?.inFile);
    if (!inFile || !inFile.endsWith('.bin')) {
      res.status(400).json({ error: 'Invalid input file.' });
      return;
    }
    const headroom = typeof req.body?.headroom === 'number' ? req.body.headroom : 0.0;
    const block = typeof req.body?.block === 'number' ? req.body.block : undefined;
    const outName = typeof req.body?.outFile === 'string' && req.body.outFile.length > 0
      ? req.body.outFile
      : inFile.replace(/\.bin$/, '_q11.bin');
    try {
      const result = iq16ToQ11(inFile, outName, headroom, block);
      res.json({ ok: true, ...result });
    } catch (err) {
      res.status(500).json({ error: `Conversion failed: ${(err as Error).message}` });
    }
  });

  return app;
}

function resolveSignalPath(name: unknown): string | null {
  if (typeof name !== 'string' || name.length === 0) return null;
  const p = path.resolve(config.signalDir, name);
  if (!p.startsWith(config.signalDir + path.sep) && p !== config.signalDir) return null;
  return fs.existsSync(p) ? p : null;
}

function sanitize(name: string): string {
  const base = path.basename(name);
  return base.replace(/[^\w.\-]/g, '_');
}