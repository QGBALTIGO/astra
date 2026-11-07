/**
 * OpenAPI generator tests
 *
 * Pure unit tests against a stub `app.routes` array — no Hono boot, no DB.
 */

import { describe, it, expect } from 'vitest';
import { generateOpenApiSpec } from './generator.js';

// Stub matches the RouterRoute shape we read (basePath / handler are ignored).
function makeRoute(method: string, path: string) {
  const handler = (() => {}) as never;
  return { basePath: '/', path, method, handler };
}

function makeApp(routes: ReturnType<typeof makeRoute>[]) {
  return { routes } as unknown as Parameters<typeof generateOpenApiSpec>[0];
}

describe('generateOpenApiSpec', () => {
  it('produces a valid OpenAPI 3.1 shell', () => {
    const spec = generateOpenApiSpec(makeApp([makeRoute('GET', '/api/v1/health')]), '1.0.0');
    expect(spec.openapi).toBe('3.1.0');
    expect(spec.info.title).toBe('OwnPilot Gateway API');
    expect(spec.info.version).toBe('1.0.0');
    expect(spec.components.schemas.ApiResponseEnvelope).toBeDefined();
    expect(spec.components.schemas.ApiErrorEnvelope).toBeDefined();
  });

  it('converts Hono :param syntax to OpenAPI {param} and adds path parameters', () => {
    const spec = generateOpenApiSpec(
      makeApp([makeRoute('POST', '/api/v1/claws/:clawsId/start')]),
      '1.0.0'
    );

    expect(spec.paths['/api/v1/claws/{clawsId}/start']).toBeDefined();
    const op = spec.paths['/api/v1/claws/{clawsId}/start']!.post!;
    expect(op.parameters).toEqual([
      { name: 'clawsId', in: 'path', required: true, schema: { type: 'string' } },
    ]);
  });

  it('handles multiple path params in one route', () => {
    const spec = generateOpenApiSpec(
      makeApp([makeRoute('GET', '/api/v1/workspaces/:workspaceId/files/:fileId')]),
      '1.0.0'
    );

    const op = spec.paths['/api/v1/workspaces/{workspaceId}/files/{fileId}']!.get!;
    expect(op.parameters?.map((p) => p.name)).toEqual(['workspaceId', 'fileId']);
  });

  it('derives a tag from the first segment after /api/v1/', () => {
    const spec = generateOpenApiSpec(
      makeApp([
        makeRoute('GET', '/api/v1/claws'),
        makeRoute('GET', '/api/v1/claws/:id'),
        makeRoute('GET', '/api/v1/tunnel'),
      ]),
      '1.0.0'
    );
    const tags = spec.tags.map((t) => t.name);
    expect(tags).toContain('claws');
    expect(tags).toContain('tunnel');
    expect(spec.paths['/api/v1/claws']!.get!.tags).toEqual(['claws']);
    expect(spec.paths['/api/v1/tunnel']!.get!.tags).toEqual(['tunnel']);
  });

  it('skips middleware (method=ALL), webhooks, health, metrics, /api/v2 mirror', () => {
    const spec = generateOpenApiSpec(
      makeApp([
        makeRoute('ALL', '/api/v1/*'), // middleware
        makeRoute('GET', '/health'),
        makeRoute('GET', '/metrics'),
        makeRoute('POST', '/webhooks/telegram/abc'),
        makeRoute('GET', '/api/v2/claws'), // v2 mirror
        makeRoute('GET', '/api/v1/claws'),
      ]),
      '1.0.0'
    );
    expect(Object.keys(spec.paths)).toEqual(['/api/v1/claws']);
  });

  it('deduplicates (method, path) pairs registered via multiple mountings', () => {
    const spec = generateOpenApiSpec(
      makeApp([makeRoute('GET', '/api/v1/claws'), makeRoute('GET', '/api/v1/claws')]),
      '1.0.0'
    );
    expect(Object.keys(spec.paths)).toHaveLength(1);
    expect(spec.paths['/api/v1/claws']!.get).toBeDefined();
  });

  it('attaches default success/error envelope responses to every operation', () => {
    const spec = generateOpenApiSpec(makeApp([makeRoute('GET', '/api/v1/claws')]), '1.0.0');
    const op = spec.paths['/api/v1/claws']!.get!;
    expect(op.responses['200']).toBeDefined();
    expect(op.responses['400']).toBeDefined();
    expect(op.responses['404']).toBeDefined();
    expect(op.responses['500']).toBeDefined();
  });

  it('emits deterministic operationIds', () => {
    const spec = generateOpenApiSpec(
      makeApp([makeRoute('POST', '/api/v1/claws/:id/start'), makeRoute('GET', '/api/v1/claws')]),
      '1.0.0'
    );
    expect(spec.paths['/api/v1/claws']!.get!.operationId).toBe('get-api-v1-claws');
    expect(spec.paths['/api/v1/claws/{id}/start']!.post!.operationId).toBe(
      'post-api-v1-claws-by-id-start'
    );
  });

  it('sorts routes for stable output', () => {
    const spec = generateOpenApiSpec(
      makeApp([makeRoute('GET', '/api/v1/zulu'), makeRoute('GET', '/api/v1/alpha')]),
      '1.0.0'
    );
    const pathOrder = Object.keys(spec.paths);
    expect(pathOrder).toEqual(['/api/v1/alpha', '/api/v1/zulu']);
  });
});
