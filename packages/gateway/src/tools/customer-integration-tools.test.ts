import { beforeEach, describe, expect, it, vi } from 'vitest';
import { ToolRegistry } from '@ownpilot/core/tools';
const mockRun = vi.hoisted(() => vi.fn());
vi.mock('../services/customer-integrations.js', () => ({
  customerIntegrationService: { run: mockRun },
}));
import {
  CUSTOMER_INTEGRATION_TOOLS,
  executeCustomerIntegrationTool,
} from './customer-integration-tools.js';
import { executeSearchTools } from './registry/meta-executors.js';

beforeEach(() => mockRun.mockReset().mockResolvedValue({ confirmationRequired: true }));
describe('portable integration action arguments', () => {
  it('decodes JSON arguments and preserves the authenticated customer binding', async () => {
    const fields = {
      calendar_id: 'primary',
      summary: 'Evento fictício',
      timezone: 'America/Cuiaba',
    };
    const result = await executeCustomerIntegrationTool(
      'run_connected_action',
      {
        app: 'googlecalendar',
        action: 'GOOGLECALENDAR_CREATE_EVENT',
        arguments_json: JSON.stringify(fields),
      },
      'customer-a'
    );
    expect(result).toMatchObject({ success: true, result: { confirmationRequired: true } });
    expect(mockRun).toHaveBeenCalledWith(
      'customer-a',
      'googlecalendar',
      'GOOGLECALENDAR_CREATE_EVENT',
      fields,
      undefined,
      undefined
    );
  });
  it.each(['{invalid}', '[]', 'null', '"text"', '1', 'x'.repeat(100001)])(
    'does not execute invalid JSON arguments, case %#',
    async (input) => {
      expect(
        await executeCustomerIntegrationTool(
          'run_connected_action',
          { app: 'gmail', action: 'GMAIL_SEND_EMAIL', arguments_json: input },
          'customer-a'
        )
      ).toMatchObject({ success: false });
      expect(mockRun).not.toHaveBeenCalled();
    }
  );
  it('rejects conflicting legacy and JSON arguments', async () => {
    expect(
      await executeCustomerIntegrationTool(
        'run_connected_action',
        {
          app: 'gmail',
          action: 'GMAIL_SEND_EMAIL',
          arguments: { to: 'one@example.com' },
          arguments_json: '{"to":"two@example.com"}',
        },
        'customer-a'
      )
    ).toMatchObject({ success: false });
    expect(mockRun).not.toHaveBeenCalled();
  });
  it('advertises string arguments so providers do not need free-form object schemas', () => {
    const tool = CUSTOMER_INTEGRATION_TOOLS.find((t) => t.name === 'run_connected_action')!;
    expect(tool.parameters.required).toContain('arguments_json');
    expect(tool.parameters.properties?.arguments_json).toMatchObject({ type: 'string' });
    expect(tool.parameters.properties).not.toHaveProperty('arguments');
  });
});

describe('connected app discovery from a customer request', () => {
  it.each([
    'gmail unread',
    'email send',
    'google calendar create event',
    'google agenda agendar',
    'google calendar delete',
    'google drive create',
    'google sheets append',
    'todoist complete',
    'notion update',
    'trello update',
  ])('finds schema discovery and execution for %s', async (query) => {
    const registry = new ToolRegistry();
    for (const definition of CUSTOMER_INTEGRATION_TOOLS)
      registry.register({ ...definition, name: 'core.' + definition.name }, async () => ({
        content: 'not executed',
      }));
    const result = await executeSearchTools(registry, {
      query,
      mode: 'keyword',
      include_params: false,
      limit: 10,
    });
    expect(result.content).toContain('core.search_connected_actions');
    expect(result.content).toContain('core.run_connected_action');
  });
  it.each([
    'gmail',
    'email',
    'google calendar',
    'google agenda',
    'google drive',
    'google sheets',
    'google planilhas',
    'todoist',
    'notion',
    'trello',
  ])('finds the connection status and executor for %s', async (query) => {
    const registry = new ToolRegistry();
    for (const definition of CUSTOMER_INTEGRATION_TOOLS)
      registry.register({ ...definition, name: 'core.' + definition.name }, async () => ({
        content: 'not executed',
      }));
    const result = await executeSearchTools(registry, {
      query,
      mode: 'keyword',
      include_params: false,
      limit: 10,
    });
    expect(result.content).toContain('core.connected_apps_status');
    expect(result.content).toContain('core.run_connected_action');
  });
});
