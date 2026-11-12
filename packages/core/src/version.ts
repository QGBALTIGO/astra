/**
 * Version — derived from package.json so it stays in sync.
 *
 * Exposed as a separate sub-path (`@ownpilot/core/version`) so consumers
 * don't need to import the entire core barrel just to read the build version.
 * Used by gateway health, openapi, and bootstrap diagnostics.
 */
import packageJson from '../package.json' with { type: 'json' };

export const VERSION: string = packageJson.version;
