import { Hono } from 'hono';
import { beforeEach, describe, expect, it, vi } from 'vitest';
const f = vi.hoisted(() => ({ sync: vi.fn(), getChannel: vi.fn() }));
vi.mock('@ownpilot/core/channels', async (original) => ({
  ...(await original<typeof import('@ownpilot/core/channels')>()),
  hasChannelService: () => true,
  getChannelService: () => ({ getChannel: f.getChannel }),
}));
import { channelRoutes } from './index.js';
const app = (user?: string) => {
  const h = new Hono();
  h.use('*', async (c, next) => {
    if (user) c.set('userId', user);
    await next();
  });
  h.route('/channels', channelRoutes);
  return h;
};
beforeEach(() => {
  vi.clearAllMocks();
  f.sync.mockResolvedValue({ contactsRecovered: 12, historyRequested: true });
  f.getChannel.mockReturnValue({ synchronizeContacts: f.sync });
});
describe('owner-only WhatsApp contact synchronization', () => {
  it('requires authentication and refuses customer identities', async () => {
    expect(
      (await app().request('/channels/channel.whatsapp/contacts/sync', { method: 'POST' })).status
    ).toBe(401);
    expect(
      (
        await app('whatsapp:5511999990001').request('/channels/channel.whatsapp/contacts/sync', {
          method: 'POST',
        })
      ).status
    ).toBe(403);
    expect(f.sync).not.toHaveBeenCalled();
  });
  it('allows only the owner to trigger a contact-only recovery', async () => {
    const r = await app('default').request('/channels/channel.whatsapp/contacts/sync', {
      method: 'POST',
    });
    expect(r.status).toBe(200);
    expect(await r.json()).toMatchObject({
      success: true,
      data: { contactsRecovered: 12, historyRequested: true },
    });
    expect(f.sync).toHaveBeenCalledOnce();
  });
  it('rejects other channels and unavailable transports', async () => {
    expect(
      (await app('default').request('/channels/channel.telegram/contacts/sync', { method: 'POST' }))
        .status
    ).toBe(400);
    f.getChannel.mockReturnValue(undefined);
    expect(
      (await app('default').request('/channels/channel.whatsapp/contacts/sync', { method: 'POST' }))
        .status
    ).toBe(503);
  });
  it('hides provider and database errors from the owner interface', async () => {
    f.sync.mockRejectedValue(new Error('postgresql://private-key@internal'));
    const r = await app('default').request('/channels/channel.whatsapp/contacts/sync', {
      method: 'POST',
    });
    expect(r.status).toBe(503);
    expect(await r.text()).not.toMatch(/private-key|postgresql|internal/);
  });
});
