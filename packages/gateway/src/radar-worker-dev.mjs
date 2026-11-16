// Development/CI only. Production threads load the compiled radar-worker.js directly.
import { register } from 'tsx/esm/api';
register();
await import('./radar-worker.ts');
