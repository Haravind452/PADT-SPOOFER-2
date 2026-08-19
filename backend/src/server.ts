import * as http from 'http';
import { Server } from 'socket.io';
import { config } from './config';
import { Studio } from './studio';
import { createApp } from './app';
import { attachSocket } from './socket';

const studio = new Studio();
const app = createApp(studio);
const httpServer = http.createServer(app);
const io = new Server({
  cors: {
    origin: true,
    methods: ['GET', 'POST'],
  },
});

attachSocket(io, studio, httpServer);

async function main(): Promise<void> {
  await studio.init();
  // Mirrors the original app's GNSS_UI_SELFTEST=1 smoke test: initialize
  // everything, then exit cleanly without presenting the UI/server.
  if (process.env['GNSS_UI_SELFTEST'] === '1') {
    studio.logger.log('GNSS_UI_SELFTEST - self-test OK, exiting.');
    process.exit(0);
  }
  httpServer.listen(config.port, config.host, () => {
    studio.logger.log(
      `SPOOFER backend listening on http://${config.host}:${config.port}`
    );
  });
}

async function shutdown(signal: string): Promise<void> {
  studio.logger.log(`${signal} received - shutting down (TX stop, generator kill).`);
  // Graceful TX stop (tx stop -> quit -> kill fallback), bounded by a timeout.
  await Promise.race([
    studio.shutdown(),
    new Promise<void>((resolve) => setTimeout(resolve, 4000)),
  ]);
  httpServer.close(() => {
    process.exit(0);
  });
  setTimeout(() => process.exit(0), 3500).unref();
}

process.on('SIGINT', () => {
  void shutdown('SIGINT');
});
process.on('SIGTERM', () => {
  void shutdown('SIGTERM');
});

main().catch((err) => {
  // eslint-disable-next-line no-console
  console.error('Fatal startup error:', err);
  process.exit(1);
});