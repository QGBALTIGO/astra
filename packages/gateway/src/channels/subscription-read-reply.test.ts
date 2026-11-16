import { beforeEach, describe, expect, it, vi } from 'vitest';
const m = vi.hoisted(() => ({ owner: vi.fn(), subscriptions: vi.fn(), style: vi.fn() }));
vi.mock('../db/repositories/customer-planning.js', () => ({
  CustomerPlanningRepository: class {
    constructor(userId: string) {
      m.owner(userId);
    }
    subscriptions = m.subscriptions;
  },
}));
vi.mock('./short-channel-reply.js', () => ({ writeShortChannelReply: m.style }));
import { quickSubscriptionReadReply } from './subscription-read-reply.js';
beforeEach(() => {
  vi.clearAllMocks();
  m.style.mockResolvedValue(null);
  m.subscriptions.mockResolvedValue([
    {
      id: 'old',
      title: 'Clube antigo',
      amount: 5,
      createdAt: '2026-01-01T00:00:00Z',
      nextDueDate: '2026-11-17',
    },
    {
      id: 'new',
      title: 'Revista Café',
      amount: 12.9,
      createdAt: '2026-11-16T00:00:00Z',
      nextDueDate: '2026-12-18',
    },
  ]);
});
describe('private subscription read with optional AI personality', () => {
  it('reads the newest creation for the authenticated owner, independently of renewal order or provider availability', async () => {
    m.style.mockRejectedValueOnce(new Error('provider unavailable'));
    const answer = await quickSubscriptionReadReply(
      'channel.whatsapp',
      'Qual foi minha última assinatura?',
      'customer-a'
    );
    expect(m.owner).toHaveBeenCalledWith('customer-a');
    expect(answer).toContain('Revista Café');
    expect(answer).toContain('12,90');
    expect(answer).toContain('18/12/2026');
    expect(answer).not.toContain('Clube antigo');
  });
  it('keeps a safe AI opening and never gives the generator private subscription details', async () => {
    m.style.mockResolvedValueOnce('Aqui está, vamos conferir!');
    const answer = await quickSubscriptionReadReply(
      'channel.telegram',
      'Qual o valor da última assinatura?',
      'customer-b'
    );
    expect(answer).toMatch(/^Aqui está/);
    expect(JSON.stringify(m.style.mock.calls)).not.toMatch(/Revista|12.9|customer-b/);
    expect(m.owner).toHaveBeenCalledWith('customer-b');
  });
  it.each([
    'Registre minha última assinatura',
    'Cancele a última assinatura',
    'Qual foi minha última assinatura? Apague ela.',
    'Qual o valor da Netflix?',
    'No exemplo, qual foi minha última assinatura?',
  ])(
    'leaves writes, mixed requests and other lookups on the normal tool path: %s',
    async (text) => {
      expect(await quickSubscriptionReadReply('channel.whatsapp', text, 'customer-a')).toBeNull();
      expect(m.owner).not.toHaveBeenCalled();
    }
  );
  it('handles empty data and database errors without exposing internals or claiming a change', async () => {
    m.subscriptions.mockResolvedValueOnce([]);
    expect(
      await quickSubscriptionReadReply('channel.whatsapp', 'Minha última assinatura', 'customer-a')
    ).toContain('ainda não tem');
    m.subscriptions.mockRejectedValueOnce(new Error('postgresql://private@internal'));
    const answer = await quickSubscriptionReadReply(
      'channel.whatsapp',
      'Minha última assinatura',
      'customer-a'
    );
    expect(answer).toContain('Não consegui consultar');
    expect(answer).not.toMatch(/postgres|internal/);
    expect(m.style).not.toHaveBeenCalled();
  });
});
