import { startPachiBus } from './core.ts';
import { createApi } from './http-api.ts';

const key = process.env.PACHIBUS_API_KEY;
if (!key || key.length < 32) throw new Error('Set PACHIBUS_API_KEY to a random key of at least 32 characters');
const port = Number(process.env.PACHIBUS_PORT ?? 8787);
if (!Number.isInteger(port) || port < 1 || port > 65535) throw new Error('Invalid PACHIBUS_PORT');
const bus = await startPachiBus(import.meta.dirname, {
  // Errors stay on the Linux terminal, never in HTTP responses.
  stderr: text => process.stderr.write(text),
  error: () => console.error('Codex reported a turn error.'),
  serverRequest: request => console.error(`Server request: ${request.method}`),
});
const server = createApi(bus, key);
server.requestTimeout = 15_000;
server.headersTimeout = 10_000;
let shutdownPromise: Promise<void> | undefined;
function shutdown() {
  return shutdownPromise ??= (async () => {
    const closed = new Promise<void>(resolve => server.close(() => resolve()));
    server.closeAllConnections();
    await bus.close();
    await closed;
  })();
}
server.on('error', error => {
  console.error(error.message);
  process.exitCode = 1;
  void shutdown();
});
for (const signal of ['SIGINT', 'SIGTERM']) process.on(signal, () => void shutdown());
server.listen(port, '127.0.0.1', () => {
  console.log(`PachiBus listo en 127.0.0.1:${port}; autenticación Bearer obligatoria.`);
  console.log(`Codex: ${bus.version}. Ctrl+C para cerrar.`);
});
