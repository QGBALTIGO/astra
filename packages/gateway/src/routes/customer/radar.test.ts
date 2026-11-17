import { Hono } from 'hono';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { CustomerSessionContext } from '../../middleware/customer-session.js';

vi.mock('../../db/repositories/customer-radar.js', () => ({
  CustomerRadarRepository: class {
    preferences = async () => ({
      preferences: { enabled: false, time: '07:00', quietStart: '22:00', quietEnd: '07:00' },
    });
    list = async () => [];
    history = async () => [];
  },
  radarRepo: {},
}));
vi.mock('../../services/customer-auth.js', () => ({
  getCustomerAuthService: () => ({
    getWhatsAppStartUrl: () => 'https://wa.me/5599000000001',
  }),
}));
import { customerRadarRoutes } from './radar.js';

const app = new Hono<{ Variables: { customer: CustomerSessionContext } }>();
app.use('*', async (c, next) => {
  c.set('customer', {
    accountId: 'synthetic-capability-account',
    dataUserId: 'synthetic-capability-data',
    timeZone: 'America/Cuiaba',
  } as CustomerSessionContext);
  return next();
});
app.route('/radar', customerRadarRoutes);
beforeEach(() => {
  vi.stubEnv('ASTRA_RADAR_ENABLED', 'true');
  vi.stubEnv('ASTRA_FOOTBALL_DATA_KEY', '');
});
afterEach(() => vi.unstubAllEnvs());

describe('customer Radar public pregame capability', () => {
  it('keeps keyless game-day coverage while withholding pregame actions without configuration', async () => {
    const response = await app.request('/radar');
    expect(response.status).toBe(200);
    const { data } = await response.json();
    expect(data.catalog.find((source: { id: string }) => source.id === 'football')).toMatchObject({
      available: true,
      supportsBefore: false,
    });
    expect(
      data.catalog.find((source: { id: string }) => source.id === 'series').supportsBefore
    ).toBe(true);
    expect(data.preferences.enabled).toBe(false);
  });
  it('publishes only a boolean when pregame support is configured', async () => {
    const syntheticKey = 'synthetic-football-fixture-key';
    vi.stubEnv('ASTRA_FOOTBALL_DATA_KEY', syntheticKey);
    const response = await app.request('/radar');
    expect(response.status).toBe(200);
    const payload = await response.json();
    const football = payload.data.catalog.find(
      (source: { id: string }) => source.id === 'football'
    );
    expect(football.supportsBefore).toBe(true);
    expect(JSON.stringify(payload)).not.toContain(syntheticKey);
    expect(JSON.stringify(payload)).not.toContain('ASTRA_FOOTBALL_DATA_KEY');
    expect(payload.data.preferences.enabled).toBe(false);
  });
  it('does not publish pregame capability while the source is disabled', async () => {
    vi.stubEnv('ASTRA_FOOTBALL_DATA_KEY', 'synthetic-football-fixture-key');
    vi.stubEnv('ASTRA_RADAR_ENABLED', 'false');
    const { data } = await (await app.request('/radar')).json();
    expect(
      data.catalog.every((source: { supportsBefore: boolean }) => !source.supportsBefore)
    ).toBe(true);
  });
});
