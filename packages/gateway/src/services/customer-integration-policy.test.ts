import { describe, it, expect } from 'vitest';
import {
  integrationActionKind,
  validateIntegrationArguments,
  integrationHash,
  integrationFailure,
} from './customer-integration-policy.js';
import type { IntegrationActionSpec } from './composio-service.js';
const spec = (slug = 'GMAIL_FETCH_EMAILS', tags = ['readOnlyHint']): IntegrationActionSpec => ({
  slug,
  tags,
  appName: 'gmail',
  name: 'Consulta',
  description: '',
  version: '1',
  parameters: {
    type: 'object',
    properties: {
      user_id: { type: 'string' },
      limit: { type: 'integer' },
      body: { type: 'string' },
      nested: { type: 'object', additionalProperties: true },
    },
  },
});
describe('customer integration policy', () => {
  it('never interprets a mutating slug as read-only', () =>
    expect(integrationActionKind(spec('GMAIL_SEND_EMAIL'))).toBe('write'));
  it.each([
    'GMAIL_BULK_SEND',
    'GMAIL_DELETE_ALL_MESSAGES',
    'GOOGLEDRIVE_CREATE_PERMISSION',
    'TRELLO_INVITE_MEMBER',
    'NOTION_EXECUTE_CODE',
    'GOOGLESHEETS_EXPORT_DOCUMENT',
  ])('refuses unsafe capability %s', (slug) =>
    expect(() => integrationActionKind(spec(slug))).toThrow()
  );
  it('refuses destructive mailbox actions', () =>
    expect(() =>
      integrationActionKind(spec('GMAIL_DELETE_MESSAGE', ['destructiveHint']))
    ).toThrow());
  it('supports an individually reviewed calendar removal', () =>
    expect(integrationActionKind(spec('GOOGLECALENDAR_DELETE_EVENT', ['destructiveHint']))).toBe(
      'write'
    ));
  it('requires explicit read metadata for unknown verbs', () =>
    expect(() => integrationActionKind(spec('GMAIL_MAGIC', []))).toThrow());
  it('does not accept another mailbox principal', () =>
    expect(() =>
      validateIntegrationArguments({ user_id: 'another@example.test' }, spec())
    ).toThrow());
  it('allows only the connected mailbox', () =>
    expect(() => validateIntegrationArguments({ user_id: 'me', limit: 25 }, spec())).not.toThrow());
  it.each([
    'apiKey',
    'connected_account_id',
    'authConfigId',
    'authorization',
    'headers',
    'baseUrl',
    'ownerId',
  ])('blocks credential override %s even nested', (key) =>
    expect(() => validateIntegrationArguments({ nested: { [key]: 'external' } }, spec())).toThrow()
  );
  it('enforces bounded pages', () =>
    expect(() => validateIntegrationArguments({ limit: 100 }, spec())).toThrow());
  it('rejects undeclared root fields', () =>
    expect(() => validateIntegrationArguments({ unexpected: true }, spec())).toThrow());
  it('does not review hidden HTML as if plain text', () =>
    expect(() =>
      validateIntegrationArguments({ body: 'Olá <a href="https://example.test">amigo</a>' }, spec())
    ).toThrow());
  it('hashes equivalent argument objects identically', () =>
    expect(integrationHash({ a: 1, b: 2 })).toBe(integrationHash({ b: 2, a: 1 })));
  it.each(['A:A', 'A1:Z9000', 'A50:A1', 'A1:AAA2'])(
    'refuses unbounded or inverted sheets ranges %s',
    (range) =>
      expect(() =>
        validateIntegrationArguments(
          { range },
          {
            ...spec(),
            appName: 'googlesheets',
            parameters: { type: 'object', properties: { range: { type: 'string' } } },
          }
        )
      ).toThrow()
  );
  it('accepts a bounded named worksheet range', () =>
    expect(() =>
      validateIntegrationArguments(
        { range: "'Rotina'!A1:D20" },
        {
          ...spec(),
          appName: 'googlesheets',
          parameters: { type: 'object', properties: { range: { type: 'string' } } },
        }
      )
    ).not.toThrow());
  it('does not expose vendor errors or credentials', () =>
    expect(integrationFailure(new Error('HTTP 401 token=secret'))).not.toMatch(/401|secret|token/));
});
