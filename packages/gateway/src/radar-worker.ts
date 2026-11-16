/** Dedicated public-data collector. Deliberately does not boot channels, agents or the HTTP server. */
import 'dotenv/config';
import { initializeAdapter, closeAdapter } from './db/adapters/index.js';
import { startRadarCollectors, stopRadar } from './services/radar/worker.js';
import { getLog } from './services/log.js';
const log = getLog('RadarWorker');
await initializeAdapter();
startRadarCollectors();
const keepAlive = setInterval(() => {}, 60000);
let stopping = false;
async function stop() {
  if (stopping) return;
  stopping = true;
  stopRadar();
  clearInterval(keepAlive);
  await closeAdapter();
}
process.once('SIGTERM', () => void stop());
process.once('SIGINT', () => void stop());
log.info('Coletor Astra Radar iniciado; envio permanece no gateway.');
