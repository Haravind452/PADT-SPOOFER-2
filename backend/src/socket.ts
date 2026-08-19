import { Server, type Socket } from 'socket.io';
import type { Server as HttpServer } from 'http';
import { Studio } from './studio';
import type { GenRequest, GenMode, TxStartRequest } from './types';

export function attachSocket(io: Server, studio: Studio, httpServer: HttpServer): void {
  io.attach(httpServer);

  studio.attach({
    emit(event, payload) {
      io.emit(event, payload);
    },
  });

  io.on('connection', (socket: Socket) => {
    // eslint-disable-next-line no-console
    console.log(`[RX socket] client connected: ${socket.id} (${socket.handshake.address})`);
    socket.emit('state:sync', studio.snapshot());

    socket.on('settings:save', async (payload: Partial<TxStartRequest> & Record<string, unknown>) => {
      // eslint-disable-next-line no-console
      console.log(`[RX socket] settings:save payload: ${JSON.stringify(payload)}`);
      const gain = typeof payload.gain === 'number' ? payload.gain : studio.settings.gain;
      const loop = typeof payload.loop === 'boolean' ? payload.loop : studio.settings.loop;
      await studio.saveSettings({ gain, loop });
    });

    socket.on('gen:start', (payload: GenRequest, ack?: (r: { error?: string }) => void) => {
      // eslint-disable-next-line no-console
      console.log(`[RX socket] gen:start payload: ${JSON.stringify(payload)}`);
      const clean = cleanGenRequest(payload);
      if (!clean) {
        ack?.({ error: 'Invalid request.' });
        return;
      }
      const error = studio.startGenerate(clean);
      ack?.({ error: error ?? undefined });
      if (!error) {
        socket.emit('state:sync', studio.snapshot());
      }
    });

    socket.on('tx:start', (payload: TxStartRequest, ack?: (r: { error?: string }) => void) => {
      // eslint-disable-next-line no-console
      console.log(`[RX socket] tx:start payload: ${JSON.stringify(payload)}`);
      const file = typeof payload?.file === 'string' && payload.file.length > 0 ? payload.file : null;
      const gain = typeof payload?.gain === 'number' ? payload.gain : studio.settings.gain;
      const loop = typeof payload?.loop === 'boolean' ? payload.loop : studio.settings.loop;
      const error = studio.startTransmit(file, gain, loop);
      ack?.({ error: error ?? undefined });
      if (!error) {
        void studio.saveSettings({ gain, loop });
        socket.emit('state:sync', studio.snapshot());
      }
    });

    socket.on('tx:gain', (payload: { gain: number }) => {
      // eslint-disable-next-line no-console
      console.log(`[RX socket] tx:gain payload: ${JSON.stringify(payload)}`);
      if (typeof payload?.gain === 'number') {
        studio.setTxGain(payload.gain);
      }
    });

    socket.on('tx:stop', async (ack?: (r: { ok: boolean }) => void) => {
      // eslint-disable-next-line no-console
      console.log(`[RX socket] tx:stop (${socket.id})`);
      await studio.stopTransmit();
      ack?.({ ok: true });
    });

    socket.on('rinex:latest', async (_payload: unknown, ack?: (r: { error?: string }) => void) => {
      // eslint-disable-next-line no-console
      console.log(`[RX socket] rinex:latest (${socket.id})`);
      ack?.({});
      await studio.downloadLatestRinex();
    });

    socket.on('rinex:select', (payload: { name?: string }, ack?: (r: { error?: string; utc?: string | null }) => void) => {
      // eslint-disable-next-line no-console
      console.log(`[RX socket] rinex:select payload: ${JSON.stringify(payload)}`);
      if (typeof payload?.name !== 'string') {
        ack?.({ error: 'Invalid file.' });
        return;
      }
      const error = studio.selectRinex(payload.name);
      ack?.({ error: error ?? undefined, utc: error ? null : studio.rinexTool.utcString(studio.rinex) });
    });

    socket.on('rinex:match', (_payload: unknown, ack?: (r: { error?: string; utc?: string | null }) => void) => {
      // eslint-disable-next-line no-console
      console.log(`[RX socket] rinex:match (${socket.id})`);
      const r = studio.matchRinex();
      ack?.({ error: r.file ? undefined : 'No RINEX', utc: r.file ? r.utc : null });
    });

    socket.on('signal:select', (payload: { name?: string }, ack?: (r: { error?: string; tag?: { fLoMHz: number; fSMHz: number } }) => void) => {
      // eslint-disable-next-line no-console
      console.log(`[RX socket] signal:select payload: ${JSON.stringify(payload)}`);
      if (typeof payload?.name !== 'string') {
        ack?.({ error: 'Invalid file.' });
        return;
      }
      const error = studio.selectSignal(payload.name);
      ack?.({ error: error ?? undefined, tag: error ? undefined : studio.bladeRf.currentTag() });
    });
  });
}

function cleanGenRequest(p: GenRequest): GenRequest | null {
  if (!p || typeof p !== 'object') return null;
  const mode: GenMode = (p.mode as GenMode) ?? 'fast';
  const clean: GenRequest = {
    lat: Number(p.lat),
    lon: Number(p.lon),
    alt: Number(p.alt),
    duration: Number(p.duration),
    utc: typeof p.utc === 'string' ? p.utc : '',
    mode,
    outName: typeof p.outName === 'string' ? p.outName : undefined,
  };
  if (!['fast', 'gps', 'full', 'multi'].includes(mode)) return null;
  return clean;
}