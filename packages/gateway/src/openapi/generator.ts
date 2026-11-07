/**
 * OpenAPI Spec Generator
 *
 * Walks the assembled Hono app's `routes` array at runtime and produces a
 * minimal OpenAPI 3.1 document. We don't have Zod schemas on every route
 * (the codebase predates @hono/zod-openapi), so this generator only
 * documents:
 *   - method + path
 *   - path parameters extracted from `:param` syntax
 *   - a default success/error response envelope shared by every operation
 *
 * Routes that want richer schemas can be migrated to Zod-validated handlers
 * later; this generator gives us a complete inventory immediately.
 */

import type { Hono } from 'hono';

// ---------------------------------------------------------------------------
// Types — only the OpenAPI fields we actually populate
// ---------------------------------------------------------------------------

interface ParameterObject {
  name: string;
  in: 'path' | 'query';
  required: boolean;
  schema: { type: 'string' };
}

interface OperationObject {
  summary: string;
  operationId: string;
  tags: string[];
  parameters?: ParameterObject[];
  responses: Record<string, { description: string; content?: Record<string, { schema: unknown }> }>;
}

interface PathItem {
  get?: OperationObject;
  post?: OperationObject;
  put?: OperationObject;
  patch?: OperationObject;
  delete?: OperationObject;
}

export interface OpenApiSpec {
  openapi: '3.1.0';
  info: { title: string; version: string; description: string };
  servers: Array<{ url: string; description?: string }>;
  tags: Array<{ name: string; description?: string }>;
  paths: Record<string, PathItem>;
  components: { schemas: Record<string, unknown> };
}

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const HTTP_METHODS = ['get', 'post', 'put', 'patch', 'delete'] as const;
type HttpMethod = (typeof HTTP_METHODS)[number];
const HTTP_METHOD_SET = new Set<string>(HTTP_METHODS);

const PATH_PARAM_RE = /:([A-Za-z_][A-Za-z0-9_]*)/g;

// Paths we never document (internal, framework, or non-API).
const EXCLUDED_PREFIXES = ['/health', '/metrics', '/webhooks', '/socket.io', '/api/v2'];
const EXCLUDED_EXACT = new Set(['/', '/api/v1', '/api/v2', '/openapi.json', '/docs']);

// ---------------------------------------------------------------------------
// Shared response envelope (mirrors apiResponse / apiError in routes/helpers.ts)
// ---------------------------------------------------------------------------

const ENVELOPE_SCHEMAS = {
  ApiResponseEnvelope: {
    type: 'object',
    required: ['success', 'meta'],
    properties: {
      success: { type: 'boolean', enum: [true] },
      data: {},
      meta: {
        type: 'object',
        required: ['requestId', 'timestamp'],
        properties: {
          requestId: { type: 'string' },
          timestamp: { type: 'string', format: 'date-time' },
        },
      },
    },
  },
  ApiErrorEnvelope: {
    type: 'object',
    required: ['success', 'error', 'meta'],
    properties: {
      success: { type: 'boolean', enum: [false] },
      error: {
        type: 'object',
        required: ['code', 'message'],
        properties: {
          code: { type: 'string' },
          message: { type: 'string' },
        },
      },
      meta: {
        type: 'object',
        required: ['requestId', 'timestamp'],
        properties: {
          requestId: { type: 'string' },
          timestamp: { type: 'string', format: 'date-time' },
        },
      },
    },
  },
};

const DEFAULT_RESPONSES: OperationObject['responses'] = {
  '200': {
    description: 'Success',
    content: {
      'application/json': { schema: { $ref: '#/components/schemas/ApiResponseEnvelope' } },
    },
  },
  '400': {
    description: 'Validation or input error',
    content: {
      'application/json': { schema: { $ref: '#/components/schemas/ApiErrorEnvelope' } },
    },
  },
  '404': {
    description: 'Not found',
    content: {
      'application/json': { schema: { $ref: '#/components/schemas/ApiErrorEnvelope' } },
    },
  },
  '500': {
    description: 'Internal server error',
    content: {
      'application/json': { schema: { $ref: '#/components/schemas/ApiErrorEnvelope' } },
    },
  },
};

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function isExcluded(path: string): boolean {
  if (EXCLUDED_EXACT.has(path)) return true;
  return EXCLUDED_PREFIXES.some((p) => path === p || path.startsWith(`${p}/`));
}

/** Convert `/foo/:id/bar` → `{ openapiPath: '/foo/{id}/bar', params: ['id'] }`. */
function honoPathToOpenApi(path: string): { openapiPath: string; params: string[] } {
  const params: string[] = [];
  const openapiPath = path.replace(PATH_PARAM_RE, (_, name: string) => {
    params.push(name);
    return `{${name}}`;
  });
  return { openapiPath, params };
}

/** Derive a tag from the first path segment after `/api/v1/`. */
function deriveTag(path: string): string {
  const stripped = path.startsWith('/api/v1/')
    ? path.slice('/api/v1/'.length)
    : path.replace(/^\//, '');
  const first = stripped.split('/')[0] ?? 'root';
  return first || 'root';
}

/** Build a stable operationId: `methodPathSegments`, kebab-cased. */
function buildOperationId(method: string, openapiPath: string): string {
  const segments = openapiPath
    .replace(/\{([^}]+)\}/g, 'by-$1')
    .split('/')
    .filter(Boolean)
    .join('-');
  return `${method.toLowerCase()}-${segments}`;
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

export function generateOpenApiSpec(app: Pick<Hono, 'routes'>, version: string): OpenApiSpec {
  const paths: Record<string, PathItem> = {};
  const tagSet = new Set<string>();

  // Deduplicate (method, path) pairs — Hono can register the same route through
  // multiple `.route()` mountings and we only want to document each operation
  // once. Take the first occurrence.
  const seen = new Set<string>();

  // Stable iteration order: sort by (path, method) so the generated JSON is
  // deterministic across boots.
  const routes = [...app.routes].sort((a, b) => {
    if (a.path !== b.path) return a.path.localeCompare(b.path);
    return a.method.localeCompare(b.method);
  });

  for (const route of routes) {
    const method = route.method.toLowerCase();
    if (!HTTP_METHOD_SET.has(method)) continue; // ALL = middleware
    if (isExcluded(route.path)) continue;

    const key = `${method} ${route.path}`;
    if (seen.has(key)) continue;
    seen.add(key);

    const { openapiPath, params } = honoPathToOpenApi(route.path);
    const tag = deriveTag(route.path);
    tagSet.add(tag);

    const operation: OperationObject = {
      summary: `${route.method.toUpperCase()} ${route.path}`,
      operationId: buildOperationId(method, openapiPath),
      tags: [tag],
      responses: DEFAULT_RESPONSES,
    };

    if (params.length > 0) {
      operation.parameters = params.map((name) => ({
        name,
        in: 'path',
        required: true,
        schema: { type: 'string' },
      }));
    }

    (paths[openapiPath] ??= {})[method as HttpMethod] = operation;
  }

  return {
    openapi: '3.1.0',
    info: {
      title: 'OwnPilot Gateway API',
      version,
      description:
        'Auto-generated inventory of OwnPilot HTTP endpoints. Schemas are minimal — every operation returns the standard ApiResponseEnvelope on success or ApiErrorEnvelope on failure. Path parameters are documented; request/response bodies are not (yet).',
    },
    servers: [{ url: '/', description: 'Same-origin (this gateway)' }],
    tags: [...tagSet].sort().map((name) => ({ name })),
    paths,
    components: { schemas: ENVELOPE_SCHEMAS },
  };
}
