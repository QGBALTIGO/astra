import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { ChannelIncomingMessage } from '@ownpilot/core/channels';
import type { SavedReceivablePlan } from '../db/repositories/customer-receivables.js';
const mocks = vi.hoisted(() => ({
  plans: vi.fn(),
  receivables: vi.fn(),
  receiveNext: vi.fn(),
  scope: vi.fn(),
  account: vi.fn(),
}));
vi.mock('../db/repositories/customer-planning.js', async (original) => ({
  ...(await original<typeof import('../db/repositories/customer-planning.js')>()),
  CustomerPlanningRepository: class {
    list = mocks.plans;
  },
}));
vi.mock('../db/repositories/customer-receivables.js', async (original) => ({
  ...(await original<typeof import('../db/repositories/customer-receivables.js')>()),
  CustomerReceivablesRepository: class {
    constructor(userId: string) {
      mocks.scope(userId);
    }
    list = mocks.receivables;
    receiveNext = mocks.receiveNext;
  },
}));
vi.mock('../db/repositories/customer-accounts.js', () => ({
  customerAccountsRepo: { getByDataUserId: mocks.account },
}));
import { tryCustomerPlanningChannelReply as planningReply } from './customer-planning-routing.js';
const tryCustomerPlanningChannelReply = (
  message: ChannelIncomingMessage,
  userId: string,
  allowed = async () => true
) => planningReply(message, userId, allowed);

const plan = (changes: Partial<SavedReceivablePlan> = {}): SavedReceivablePlan => ({
  id: 'fixture-old-plan',
  borrower: 'Cliente Aurora',
  principal_cents: '10000',
  total_cents: '20000',
  installments: 4,
  local_time: '18:00',
  time_zone: 'America/Cuiaba',
  remaining_cents: '5000',
  paid_cents: '2500',
  currency_balances: [{ currency: 'BRL', pending_cents: '5000', paid_cents: '2500' }],
  ...changes,
});
const incoming = (text: string): ChannelIncomingMessage => ({
  id: 'fixture-plan-message',
  text,
  platform: 'whatsapp',
  channelPluginId: 'channel.whatsapp',
  platformChatId: 'fixture-chat',
  timestamp: new Date('2026-11-17T16:00:00Z'),
  sender: { platform: 'whatsapp', platformUserId: 'fixture-chat' },
  attachments: [],
  metadata: {},
});
beforeEach(() => {
  vi.clearAllMocks();
  mocks.plans.mockResolvedValue([]);
  mocks.receivables.mockResolvedValue([plan()]);
  mocks.account.mockImplementation(async (dataUserId: string) => ({
    id: 'fixture-account',
    dataUserId,
    phoneNumber: 'fixture-chat',
    channelUserId: 'fixture-channel-user',
    authVersion: 1,
    timeZone: 'America/Cuiaba',
  }));
});
describe('named receivable balance shared with planning chat', () => {
  it.each(['revoke', 'relink'])(
    'does not expose a named balance after %s while its query is pending',
    async (change) => {
      let begin!: () => void;
      let release!: (value: unknown) => void;
      const began = new Promise<void>((resolve) => {
        begin = resolve;
      });
      const query = new Promise((resolve) => {
        release = resolve;
      });
      mocks.receivables.mockImplementationOnce(() => {
        begin();
        return query;
      });
      let allowed = true;
      const result = tryCustomerPlanningChannelReply(
        incoming('Quanto resta de Cliente Aurora?'),
        'fixture-user-a',
        async () => allowed
      );
      await began;
      if (change === 'revoke') allowed = false;
      else
        mocks.account.mockResolvedValue({
          id: 'fixture-account',
          dataUserId: 'fixture-user-a',
          phoneNumber: 'new-phone',
          channelUserId: 'fixture-channel-user',
          authVersion: 2,
        });
      release([plan()]);
      const reply = await result;
      expect(reply).toContain('acesso');
      expect(reply).not.toMatch(/R\$|Cliente Aurora|A receber/);
      expect(mocks.receiveNext).not.toHaveBeenCalled();
    }
  );
  it('fails closed for an unauthenticated direct WhatsApp caller', async () => {
    const reply = await planningReply(
      incoming('Quanto resta de Cliente Aurora?'),
      'fixture-user-a'
    );
    expect(reply).toContain('acesso');
    expect(mocks.receivables).not.toHaveBeenCalled();
  });
  it('reads the current ledger balance for an old person without cutting the lookup at100 plans', async () => {
    mocks.receivables.mockResolvedValue([
      ...Array.from({ length: 125 }, (_, index) =>
        plan({ id: `fixture-${index}`, borrower: `Outra Pessoa ${index}` })
      ),
      plan(),
    ]);
    const reply = await tryCustomerPlanningChannelReply(
      incoming('Quanto resta de Cliente Aurora?'),
      'fixture-user-a'
    );
    expect(reply).toContain('A receber:* R$ 50,00');
    expect(reply).not.toMatch(/200,00|150,00/);
    expect(mocks.scope).toHaveBeenCalledWith('fixture-user-a');
    expect(mocks.receiveNext).not.toHaveBeenCalled();
  });
  it('shows outstanding foreign currency instead of claiming a zero or settled balance', async () => {
    mocks.receivables.mockResolvedValue([
      plan({
        remaining_cents: '0',
        paid_cents: '0',
        currency_balances: [{ currency: 'USD', pending_cents: '3500', paid_cents: '0' }],
      }),
    ]);
    const reply = await tryCustomerPlanningChannelReply(
      incoming('Quanto resta de Cliente Aurora?'),
      'fixture-user-a'
    );
    expect(reply).toMatch(/A receber:\* US\$\s*35,00/);
    expect(reply).not.toMatch(/R\$|quitad|tudo pago/);
  });
  it('confirms from the freshly returned ledger after receiving an installment', async () => {
    mocks.receiveNext.mockResolvedValue([
      plan({
        remaining_cents: '0',
        paid_cents: '7500',
        currency_balances: [{ currency: 'BRL', pending_cents: '0', paid_cents: '7500' }],
      }),
    ]);
    const reply = await tryCustomerPlanningChannelReply(
      incoming('Mais uma parcela de Cliente Aurora paga'),
      'fixture-user-a'
    );
    expect(reply).toContain('Parcela recebida');
    expect(reply).toContain('Recebido:* R$ 75,00');
    expect(reply).toContain('A receber:* R$ 0,00');
    expect(reply).not.toMatch(/200,00|150,00|R\$ 50,00/);
    expect(mocks.receiveNext).toHaveBeenCalledWith(
      'fixture-old-plan',
      expect.stringMatching(/^[a-f0-9]{64}$/),
      '2026-11-17'
    );
  });
});
