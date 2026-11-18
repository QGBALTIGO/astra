import { afterEach, describe, expect, it } from 'vitest';
import { createServer, type Server } from 'node:http';
import { connect, type Socket } from 'node:net';
import { HTTP_SERVER_OPTIONS, configureHttpServer } from './http-server.js';

const servers: Server[] = [];
const sockets: Socket[] = [];

afterEach(async () => {
  for (const socket of sockets.splice(0)) socket.destroy();
  await Promise.all(
    servers.splice(0).map(
      (server) =>
        new Promise<void>((resolve) => {
          server.closeAllConnections();
          server.close(() => resolve());
        })
    )
  );
});

async function listen(server: Server): Promise<number> {
  servers.push(server);
  configureHttpServer(server);
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const address = server.address();
  if (!address || typeof address === 'string') throw new Error('Expected TCP listener');
  return address.port;
}

async function exchange(port: number, input: string): Promise<string> {
  return new Promise((resolve, reject) => {
    const socket = connect(port, '127.0.0.1', () => socket.write(input));
    sockets.push(socket);
    let response = '';
    socket.setTimeout(2000, () => reject(new Error('Request was not bounded')));
    socket.on('data', (data) => {
      response += data.toString();
    });
    socket.on('end', () => resolve(response));
    socket.on('error', reject);
  });
}

describe('HTTP ingress limits', () => {
  it('rejects oversized headers before invoking the application', async () => {
    let requests = 0;
    const server = createServer(HTTP_SERVER_OPTIONS, (_request, response) => {
      requests++;
      response.end('unexpected');
    });
    const port = await listen(server);
    const response = await exchange(
      port,
      `GET / HTTP/1.1\r\nHost: localhost\r\nX-Oversized: ${'x'.repeat(17 * 1024)}\r\n\r\n`
    );
    expect(response).toContain('431 Request Header Fields Too Large');
    expect(requests).toBe(0);
  });

  it('closes incomplete headers before application code runs', async () => {
    let requests = 0;
    const server = createServer(
      { ...HTTP_SERVER_OPTIONS, headersTimeout: 40, connectionsCheckingInterval: 10 },
      () => {
        requests++;
      }
    );
    const port = await listen(server);
    const response = await exchange(port, 'GET / HTTP/1.1\r\nHost: localhost\r\nX-Incomplete: ');
    expect(response).toContain('408 Request Timeout');
    expect(requests).toBe(0);
  });

  it('allows a completed request to stream beyond the upload deadline', async () => {
    const server = createServer(
      {
        ...HTTP_SERVER_OPTIONS,
        headersTimeout: 20,
        requestTimeout: 40,
        connectionsCheckingInterval: 10,
      },
      (_request, response) => {
        response.writeHead(200, { 'Content-Type': 'text/event-stream', Connection: 'close' });
        response.write('data: first\n\n');
        setTimeout(() => response.end('data: done\n\n'), 100);
      }
    );
    const port = await listen(server);
    const response = await exchange(
      port,
      'GET / HTTP/1.1\r\nHost: localhost\r\nConnection: close\r\n\r\n'
    );
    expect(response).toContain('200 OK');
    expect(response).toContain('data: done');
    expect(response).not.toContain('408 Request Timeout');
  });
});
