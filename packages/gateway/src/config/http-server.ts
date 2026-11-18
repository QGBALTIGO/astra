import type { Server, ServerOptions } from 'node:http';

/** Bound incomplete uploads/headers without imposing a response timeout on SSE. */
export const HTTP_SERVER_OPTIONS: ServerOptions = {
  maxHeaderSize: 16 * 1024,
  headersTimeout: 15_000,
  requestTimeout: 120_000,
  keepAliveTimeout: 5_000,
  connectionsCheckingInterval: 1_000,
};

export function configureHttpServer(server: Server): void {
  server.maxHeadersCount = 100;
  server.maxRequestsPerSocket = 1_000;
}
