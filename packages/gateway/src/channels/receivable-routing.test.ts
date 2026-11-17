import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { ChannelIncomingMessage } from '@ownpilot/core/channels';
const mocks = vi.hoisted(() => ({
  scope: vi.fn(),
  totals: vi.fn(),
  list: vi.fn(),
  create: vi.fn(),
  receive: vi.fn(),
  account: vi.fn(),
  writer: vi.fn(),
}));
vi.mock('../db/repositories/customer-receivables.js', async (original) => ({
  ...(await original<typeof import('../db/repositories/customer-receivables.js')>()),
  CustomerReceivablesRepository: class {
    constructor(userId: string) {
      mocks.scope(userId);
    }
    pendingTotals = mocks.totals;
    list = mocks.list;
    create = mocks.create;
    receive = mocks.receive;
  },
}));
vi.mock('../db/repositories/customer-accounts.js', () => ({
  customerAccountsRepo: { getByDataUserId: mocks.account },
}));
vi.mock('./short-channel-reply.js', () => ({ writeShortChannelReply: mocks.writer }));
import { parseReceivablePlans, tryReceivableChannelReply } from './receivable-routing.js';
import { receivableDates, type ReceivablePlan } from '../db/repositories/customer-receivables.js';
const first: ReceivablePlan = {
  borrower: 'Cliente Alfa',
  principal: 500,
  total: 700,
  installments: 10,
  startDate: '2026-11-14',
  localTime: '18:00',
  skipSunday: true,
};
const second: ReceivablePlan = {
  ...first,
  borrower: 'Cliente Beta',
  principal: 800,
  total: 1120,
  localTime: '14:30',
};
const third: ReceivablePlan = {
  ...first,
  borrower: 'Cliente Gama',
  principal: 1250,
  total: 1750,
  localTime: '20:00',
};
const request =
  'Emprestei e quero que registre. Cliente Alfa pegou 500 e paga 700 em 10 parcelas de 70, todo dia menos domingo, às 18h, começando amanhã. Cliente Beta pegou 800 e paga 1.120 em 10 parcelas de 112, todo dia menos domingo, às 14h30, começando amanhã. Cliente Gama pegou 1.250 e paga 1.750 em 10 parcelas de 175, todo dia menos domingo, às 20h, começando amanhã.';
beforeEach(() => {
  mocks.account.mockImplementation(async (dataUserId: string) => ({
    id: 'fixture-account',
    dataUserId,
    phoneNumber: 'fixture-chat',
    channelUserId: 'fixture-channel-user',
    authVersion: 1,
    timeZone: 'America/Cuiaba',
  }));
});

describe('general receivable balance before the monthly finance route or provider', () => {
  const incoming = (text: string) =>
    ({
      id: 'fixture-inbound',
      text,
      platform: 'whatsapp',
      channelPluginId: 'channel.whatsapp',
      platformChatId: 'fixture-chat',
      timestamp: new Date('2026-11-17T16:00:00Z'),
      metadata: {},
      attachments: [],
    }) as ChannelIncomingMessage;
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.totals.mockResolvedValue([{ currency: 'BRL', amountCents: 77000, count: 125 }]);
  });
  it.each([
    'Quanto eu tenho a receber?',
    'Quanto tenho a receber?',
    'Quanto eu ainda tenho para receber?',
    'Qual é meu saldo a receber?',
    'Mostre meus recebíveis',
    'Meus valores a receber',
  ])('reads the complete real ledger with no month restriction: %s', async (text) => {
    const canWrite = vi.fn().mockResolvedValue(true);
    const answer = await tryReceivableChannelReply(incoming(text), 'fixture-user-a', canWrite);
    expect(answer).toContain('Valores pendentes registrados');
    expect(answer).toContain('R$ 770,00');
    expect(answer).toContain('Todos os períodos');
    expect(answer).toContain('125');
    expect(mocks.scope).toHaveBeenCalledWith('fixture-user-a');
    expect(mocks.list).not.toHaveBeenCalled();
    expect(mocks.writer).not.toHaveBeenCalled();
    expect(mocks.account).toHaveBeenCalled();
    expect(canWrite).toHaveBeenCalled();
    expect(mocks.create).not.toHaveBeenCalled();
    expect(mocks.receive).not.toHaveBeenCalled();
  });
  it('reports a verified empty balance directly instead of falling through to a monthly total', async () => {
    mocks.totals.mockResolvedValue([]);
    expect(
      await tryReceivableChannelReply(
        incoming('Quanto eu tenho a receber?'),
        'fixture-user',
        vi.fn().mockResolvedValue(true)
      )
    ).toContain('não tem valores pendentes a receber registrados');
  });
  it('keeps currencies separate and returns no private database failure details', async () => {
    mocks.totals.mockResolvedValue([
      { currency: 'BRL', amountCents: 5000, count: 1 },
      { currency: 'USD', amountCents: 1000, count: 1 },
    ]);
    const answer = await tryReceivableChannelReply(
      incoming('Quanto eu tenho a receber?'),
      'fixture-user',
      vi.fn().mockResolvedValue(true)
    );
    expect(answer).toContain('A receber em BRL');
    expect(answer).toContain('A receber em USD');
    expect(answer).toContain('sem conversão');
    expect(answer).not.toContain('60,00');
    mocks.totals.mockRejectedValueOnce(new Error('private-password'));
    const failure = await tryReceivableChannelReply(
      incoming('Quanto eu tenho a receber?'),
      'fixture-user',
      vi.fn().mockResolvedValue(true)
    );
    expect(failure).toContain('Não consegui consultar');
    expect(failure).not.toMatch(/private|password|não tem valores|R\$/);
  });
  it.each([
    'Quanto eu tenho a receber neste mês?',
    'Não consulte meus recebíveis',
    'Quanto eu tenho a receber? E registre 100 reais',
    'Dê um exemplo: quanto eu tenho a receber?',
  ])('does not erase filters, negation or compound instructions: %s', async (text) => {
    expect(await tryReceivableChannelReply(incoming(text), 'fixture-user', vi.fn())).toBeNull();
    expect(mocks.totals).not.toHaveBeenCalled();
  });
  it('does not query another identity, a group or a media caption', async () => {
    const text = 'Quanto eu tenho a receber?';
    expect(await tryReceivableChannelReply(incoming(text), '', vi.fn())).toContain(
      'confirmar sua conversa'
    );
    expect(
      await tryReceivableChannelReply(
        { ...incoming(text), metadata: { isGroup: true } } as never,
        'fixture-user',
        vi.fn().mockResolvedValue(true)
      )
    ).toBeNull();
    expect(
      await tryReceivableChannelReply(
        { ...incoming(text), platformChatId: 'fixture@g.us' },
        'fixture-user',
        vi.fn().mockResolvedValue(true)
      )
    ).toBeNull();
    expect(
      await tryReceivableChannelReply(
        {
          ...incoming(text),
          platform: 'telegram',
          metadata: { chatType: 'group' },
          sender: { platformUserId: 'another-sender', platform: 'telegram' },
        },
        'fixture-user',
        vi.fn().mockResolvedValue(true)
      )
    ).toBeNull();
    expect(
      await tryReceivableChannelReply(
        { ...incoming(text), attachments: [{ type: 'image', url: 'fixture' }] },
        'fixture-user',
        vi.fn().mockResolvedValue(true)
      )
    ).toBeNull();
    expect(mocks.totals).not.toHaveBeenCalled();
  });
});
describe('installment receivable requests', () => {
  it('keeps the three agreed totals, local hours and pending payment dates', () => {
    expect(
      parseReceivablePlans(
        JSON.stringify([first, second, third]),
        request,
        '2026-11-13',
        'America/Cuiaba'
      )
    ).toEqual([first, second, third]);
    expect(
      parseReceivablePlans(
        JSON.stringify(
          [first, second, third].map((p) => [
            p.borrower,
            p.principal,
            p.total,
            p.installments,
            p.startDate,
            p.localTime,
            p.skipSunday,
          ])
        ),
        request,
        '2026-11-13',
        'America/Cuiaba'
      )
    ).toEqual([first, second, third]);
    const dates = receivableDates(first, 'America/Cuiaba');
    expect(dates).toHaveLength(10);
    expect(dates[0]!.toISOString()).toBe('2026-11-14T22:00:00.000Z');
    expect(dates.at(-1)!.toISOString()).toBe('2026-11-25T22:00:00.000Z');
    expect(dates.every((d) => d.getUTCDay() !== 0)).toBe(true);
  });
  it('rejects amounts or hours exchanged between borrowers even when each occurs elsewhere in the request', () => {
    expect(
      parseReceivablePlans(
        JSON.stringify([{ ...first, principal: 800, total: 1120 }, second, third]),
        request,
        '2026-11-13',
        'America/Cuiaba'
      )
    ).toBeNull();
    expect(
      parseReceivablePlans(
        JSON.stringify([{ ...first, localTime: '14:30' }, second, third]),
        request,
        '2026-11-13',
        'America/Cuiaba'
      )
    ).toBeNull();
  });
  it('reads a JSON envelope but refuses omitted or duplicate clients and wrong Sunday rules', () => {
    const rows = [first, second, third];
    const counted = request.replace('Emprestei', 'Emprestei para 3 clientes');
    expect(
      parseReceivablePlans(
        JSON.stringify({ planos: rows }),
        counted,
        '2026-11-13',
        'America/Cuiaba'
      )
    ).toEqual(rows);
    expect(
      parseReceivablePlans(
        JSON.stringify({ planos: rows.slice(0, 2) }),
        counted,
        '2026-11-13',
        'America/Cuiaba'
      )
    ).toBeNull();
    expect(
      parseReceivablePlans(
        JSON.stringify({ planos: [first, first, third] }),
        counted,
        '2026-11-13',
        'America/Cuiaba'
      )
    ).toBeNull();
    expect(
      parseReceivablePlans(
        JSON.stringify({ planos: [{ ...first, skipSunday: false }, second, third] }),
        counted,
        '2026-11-13',
        'America/Cuiaba'
      )
    ).toBeNull();
  });
  it('rejects an invented date and installments that do not sum to the total', () => {
    expect(
      parseReceivablePlans(
        JSON.stringify([{ ...first, startDate: '2026-11-15' }]),
        request,
        '2026-11-13',
        'America/Cuiaba'
      )
    ).toBeNull();
    expect(() => receivableDates({ ...first, total: 700.01 }, 'America/Cuiaba')).toThrow();
  });
});

describe('named plan queries and receipt confirmations use the current ledger', () => {
  const saved = {
    id: 'fixture-plan',
    borrower: 'Cliente Aurora',
    principal_cents: '10000',
    total_cents: '20000',
    installments: 4,
    local_time: '18:00',
    time_zone: 'America/Cuiaba',
    remaining_cents: '5000',
    paid_cents: '2500',
    currency_balances: [{ currency: 'BRL', pending_cents: '5000', paid_cents: '2500' }],
  };
  const incoming = (text: string) =>
    ({
      id: 'fixture-plan-inbound',
      text,
      platform: 'whatsapp',
      channelPluginId: 'channel.whatsapp',
      platformChatId: 'fixture-private-chat',
      timestamp: new Date('2026-11-17T16:00:00Z'),
      metadata: {},
      attachments: [],
    }) as ChannelIncomingMessage;
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.list.mockResolvedValue([saved]);
  });
  it('distinguishes the original agreement from the current edited balance', async () => {
    const reply = await tryReceivableChannelReply(
      incoming('Quanto Cliente Aurora me deve?'),
      'fixture-user-a',
      vi.fn().mockResolvedValue(true)
    );
    expect(reply).toContain('Total combinado originalmente:* R$ 200,00');
    expect(reply).toContain('A receber:* R$ 50,00');
    expect(reply).not.toContain('A receber:* R$ 175,00');
    expect(mocks.scope).toHaveBeenCalledWith('fixture-user-a');
  });
  it('finds the named person beyond the former100-plan limit', async () => {
    mocks.list.mockResolvedValue([
      ...Array.from({ length: 125 }, (_, index) => ({
        ...saved,
        id: `other-${index}`,
        borrower: `Pessoa ${index}`,
      })),
      saved,
    ]);
    const reply = await tryReceivableChannelReply(
      incoming('Quanto Cliente Aurora me deve?'),
      'fixture-user-a',
      vi.fn().mockResolvedValue(true)
    );
    expect(reply).toContain('Cliente Aurora');
    expect(reply).toContain('A receber:* R$ 50,00');
    expect(reply).not.toContain('Pessoa 0');
  });
  it('does not hide pending foreign currency behind a BRL zero', async () => {
    mocks.list.mockResolvedValue([
      {
        ...saved,
        remaining_cents: '0',
        currency_balances: [{ currency: 'USD', pending_cents: '3500', paid_cents: '0' }],
      },
    ]);
    const reply = await tryReceivableChannelReply(
      incoming('Quanto Cliente Aurora me deve?'),
      'fixture-user-a',
      vi.fn().mockResolvedValue(true)
    );
    expect(reply).toMatch(/A receber:\* US\$\s*35,00/);
    expect(reply).not.toMatch(/A receber:\* R\$ 0,00|quitad|tudo pago/);
  });
  it('shows the freshly persisted balance after receiving, rather than subtracting from nominal total', async () => {
    mocks.receive.mockResolvedValue([
      {
        ...saved,
        remaining_cents: '0',
        paid_cents: '7500',
        currency_balances: [{ currency: 'BRL', pending_cents: '0', paid_cents: '7500' }],
      },
    ]);
    const canWrite = vi.fn().mockResolvedValue(true);
    const reply = await tryReceivableChannelReply(
      incoming('Recebi 50 de Cliente Aurora'),
      'fixture-user-a',
      canWrite
    );
    expect(reply).toContain('Recebimento confirmado');
    expect(reply).toContain('Recebido:* R$ 75,00');
    expect(reply).toContain('A receber:* R$ 0,00');
    expect(mocks.receive).toHaveBeenCalledWith(
      'fixture-plan',
      50,
      expect.stringMatching(/^[a-f0-9]{64}$/),
      '2026-11-17'
    );
    expect(mocks.writer).not.toHaveBeenCalled();
  });
  it('does not reinterpret a foreign-currency receipt as BRL', async () => {
    const canWrite = vi.fn().mockResolvedValue(true);
    const reply = await tryReceivableChannelReply(
      incoming('Recebi 50 dólares de Cliente Aurora'),
      'fixture-user-a',
      canWrite
    );
    expect(reply).toContain('outra moeda');
    expect(mocks.receive).not.toHaveBeenCalled();
    expect(canWrite).toHaveBeenCalled();
  });
});
