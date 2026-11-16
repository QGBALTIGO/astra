import { Worker } from 'node:worker_threads';
import { getLog } from '../log.js';
const log = getLog('RadarRuntime');
let worker: Worker | undefined,
  timer: ReturnType<typeof setTimeout> | undefined,
  running = false,
  failures = 0;
export function radarWorkerEnvironment(env: NodeJS.ProcessEnv): Record<string, string> {
  const names = [
    'NODE_ENV',
    'TZ',
    'LOG_LEVEL',
    'DATABASE_URL',
    'POSTGRES_HOST',
    'POSTGRES_PORT',
    'POSTGRES_USER',
    'POSTGRES_PASSWORD',
    'POSTGRES_DB',
    'OWNPILOT_DATA_DIR',
    'ASTRA_RADAR_ENABLED',
  ];
  const scoped = Object.fromEntries(
    Object.entries(env).filter(([k, v]) => typeof v === 'string' && names.includes(k))
  ) as Record<string, string>;
  return { ...scoped, POSTGRES_POOL_SIZE: '2' };
}
function launch() {
  if (!running || worker) return;
  try {
    const instance = new Worker(
      new URL(
        import.meta.url.endsWith('.ts') ? '../../radar-worker-dev.mjs' : '../../radar-worker.js',
        import.meta.url
      ),
      {
        env: radarWorkerEnvironment(process.env),
        execArgv: [],
        resourceLimits: { maxOldGenerationSizeMb: 128, stackSizeMb: 4 },
      }
    );
    worker = instance;
    instance.on('message', (message) => {
      if (message === 'ready') {
        failures = 0;
        log.info('Coletor Radar pronto em thread separada.');
      }
    });
    instance.on('error', (error: Error & { code?: string }) =>
      log.warn('Coletor Radar interrompido; nova tentativa será agendada.', {
        code: typeof error.code === 'string' ? error.code : 'worker_error',
      })
    );
    instance.on('exit', () => {
      if (worker === instance) worker = undefined;
      if (running) {
        const delay = Math.min(60000, 5000 * 2 ** Math.min(failures++, 4));
        timer = setTimeout(launch, delay);
        timer.unref?.();
      }
    });
  } catch {
    if (running) {
      timer = setTimeout(launch, 60000);
      timer.unref?.();
      log.warn('Coletor Radar não iniciou; nova tentativa será agendada.');
    }
  }
}
/** Independent event loop/heap, sharing the existing container's CPU and RAM allocation. */
export function startRadarRuntime() {
  if (
    running ||
    process.env.ASTRA_RADAR_ENABLED === 'false' ||
    process.env.ASTRA_RADAR_WORKER_MODE === 'external'
  )
    return;
  running = true;
  launch();
}
export async function stopRadarRuntime() {
  running = false;
  failures = 0;
  if (timer) {
    clearTimeout(timer);
    timer = undefined;
  }
  const current = worker;
  if (!current) return;
  await new Promise<void>((resolve) => {
    const timeout = setTimeout(() => {
      void current.terminate().finally(resolve);
    }, 10000);
    timeout.unref?.();
    current.once('exit', () => {
      clearTimeout(timeout);
      resolve();
    });
    current.postMessage('shutdown');
  });
  if (worker === current) worker = undefined;
}
