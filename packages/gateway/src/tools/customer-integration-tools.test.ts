import { describe, expect, it, vi } from 'vitest';
import { ToolRegistry } from '@ownpilot/core/tools';
vi.mock('../services/customer-integrations.js', () => ({ customerIntegrationService: {} }));
import { CUSTOMER_INTEGRATION_TOOLS } from './customer-integration-tools.js';
import { executeSearchTools } from './registry/meta-executors.js';

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
