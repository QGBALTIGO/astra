import { beforeEach, describe, it, expect, vi } from 'vitest';
import type { ChannelIncomingMessage } from '@ownpilot/core/channels';
const m = vi.hoisted(() => ({
  identity: vi.fn(),
  account: vi.fn(),
  prefs: vi.fn(),
  save: vi.fn(),
  list: vi.fn(),
  context: vi.fn(),
  follow: vi.fn(),
  search: vi.fn(),
  remember: vi.fn(),
  scope: vi.fn(),
  fetch: vi.fn(),
  queueNews: vi.fn(),
}));
vi.mock('@ownpilot/core/channels', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@ownpilot/core/channels')>()),
  getChannelService: () => ({ getChannel: () => ({ getPlatform: () => 'whatsapp' }) }),
}));
vi.mock('../services/customer-identity.js', () => ({
  resolveCustomerPhone: m.identity,
  getCustomerIdentityService: () => ({ getContext: m.context }),
}));
vi.mock('../db/repositories/customer-accounts.js', () => ({
  customerAccountsRepo: { getById: m.account, getByDataUserId: m.account },
}));
vi.mock('../db/repositories/customer-radar.js', () => ({
  radarRepo: { rememberChoices: m.remember, queueNewsPreview: m.queueNews },
  CustomerRadarRepository: class {
    constructor(userId: string) {
      m.scope(userId);
    }
    preferences = m.prefs;
    savePreferences = m.save;
    list = m.list;
    followFromChat = m.follow;
  },
}));
vi.mock('../services/radar/providers.js', () => ({
  searchRadar: m.search,
  fetchRadarResource: m.fetch,
}));
import { tryRadarChannelReply } from './radar.js';
import { processViaBus, processDirectAgent } from './channel-ai-routing.js';
import { radarChatContext, radarChatPending } from '../services/radar/chat-pending.js';
import * as contracts from '../services/radar/contracts.js';
// Load the real manager outside timed cases; source transforms are test-runner
// startup, while each case still exercises the authenticated production handler.
import '../services/radar/chat.js';
const phone = '5567999991234',
  user = 'whatsapp:' + phone;
const message = (text: string) =>
  ({
    id: crypto.randomUUID(),
    platform: 'whatsapp',
    channelPluginId: 'channel.whatsapp',
    platformChatId: phone,
    sender: { platformUserId: phone },
    text,
    metadata: { isGroup: false, fromMe: false },
  }) as ChannelIncomingMessage;
beforeEach(() => {
  vi.clearAllMocks();
  radarChatPending.clear();
  radarChatContext.clear();
  m.identity.mockResolvedValue({
    accountId: 'a',
    dataUserId: user,
    phoneNumber: phone,
    isCurrent: true,
    retired: false,
  });
  m.account.mockResolvedValue({
    id: 'a',
    dataUserId: user,
    phoneNumber: phone,
    timeZone: 'America/Cuiaba',
  });
  m.context.mockImplementation(async () => ({
    account: await m.account(),
    customer: { access: { canWrite: true } },
  }));
  m.prefs.mockResolvedValue({
    preferences: { enabled: true, time: '07:00', quietStart: '22:00', quietEnd: '07:00' },
  });
  m.save.mockResolvedValue({});
  m.list.mockResolvedValue([{ label: 'USD', active: true }]);
  m.search.mockResolvedValue([{ id: 'br:cr-vasco-da-gama', label: 'Vasco' }]);
  m.follow.mockResolvedValue({ keptPaused: 0 });
  m.queueNews.mockResolvedValue('queued');
  m.fetch.mockResolvedValue({
    items: [
      { id: 'public-fixture', title: 'Vasco × Bahia', text: '19/11/2026 · horário a confirmar' },
    ],
    observedAt: new Date().toISOString(),
  });
});
describe('immediate Radar requests without a provider', () => {
  it.each(['bus', 'direct'] as const)(
    'creates the screenshot price condition through %s without the AI or a fixed reminder',
    async (path) => {
      const model = vi.fn().mockRejectedValue(new Error('Synthetic provider outage'));
      const msg = message('Me avise se o dólar chegar a 5 reais cravado ou menos');
      const result =
        path === 'bus'
          ? await processViaBus(
              { process: model } as never,
              msg,
              { sessionId: 's', conversationId: null },
              { ownpilotUserId: user },
              {
                sessionsRepo: {} as never,
                getChannel: () => undefined,
                isAccessAllowed: async () => true,
              }
            )
          : await processDirectAgent(msg, user, async () => true);
      expect(JSON.stringify(result)).toContain('Alerta de cotação ativado');
      expect(JSON.stringify(result)).toContain('igual ou abaixo');
      expect(JSON.stringify(result)).not.toContain('Lembrete agendado');
      expect(m.follow).toHaveBeenCalledWith(
        expect.objectContaining({
          source: 'ptax',
          target: 'USD',
          delivery: 'threshold',
          threshold: '5',
          comparison: 'at_or_below',
        }),
        'Dólar (USD)',
        '07:00'
      );
      expect(m.scope).toHaveBeenCalledWith(user);
      expect(m.save).not.toHaveBeenCalled();
      expect(model).not.toHaveBeenCalled();
    }
  );
  it.each(['bus', 'direct'] as const)('reads a named football team with %s', async (path) => {
    const model = vi.fn().mockRejectedValue(new Error('Synthetic provider outage'));
    const msg = message('Quando o Vasco joga dnv?');
    const result =
      path === 'bus'
        ? await processViaBus(
            { process: model } as never,
            msg,
            { sessionId: 's', conversationId: null },
            { ownpilotUserId: user },
            {
              sessionsRepo: {} as never,
              getChannel: () => undefined,
              isAccessAllowed: async () => true,
            }
          )
        : await processDirectAgent(msg, user, async () => true);
    expect(JSON.stringify(result)).toContain('Vasco × Bahia');
    expect(m.fetch).toHaveBeenCalledTimes(1);
    expect(m.follow).not.toHaveBeenCalled();
    expect(m.save).not.toHaveBeenCalled();
    expect(model).not.toHaveBeenCalled();
  });
  it('queues article buttons from a read without activating daily delivery', async () => {
    m.search.mockResolvedValue([{ id: 'mundo', label: 'Mundo' }]);
    m.fetch.mockResolvedValue({
      items: [
        {
          id: 'news-fixture',
          title: 'Uma matéria de teste',
          url: 'https://pt.globalvoices.org/2026/11/17/fixture/',
          text: '17/11/2026 · Global Voices · CC BY 3.0',
        },
      ],
    });
    const reply = await tryRadarChannelReply(
      message('Quais as últimas notícias'),
      user,
      async () => true
    );
    expect(reply).toContain('Ler matéria');
    expect(m.queueNews).toHaveBeenCalledTimes(1);
    expect(m.follow).not.toHaveBeenCalled();
    expect(m.save).not.toHaveBeenCalled();
  });
  it('never turns a news preview into an old pending follow request', async () => {
    radarChatPending.set(JSON.stringify([user, 'channel.whatsapp', phone]), {
      accountId: 'a',
      messageId: 'previous-follow-question',
      needs: 'subject',
      expires: Date.now() + 60_000,
      args: { action: 'follow', source: 'news', time: '09:00' },
    });
    m.search.mockResolvedValue([{ id: 'mundo', label: 'Mundo' }]);
    m.fetch.mockResolvedValue({
      items: [
        {
          id: 'news-fixture',
          title: 'Uma matéria de teste',
          url: 'https://pt.globalvoices.org/2026/11/17/fixture/',
          text: '17/11/2026 · Global Voices · CC BY 3.0',
        },
      ],
    });
    const reply = await tryRadarChannelReply(message('notícias'), user, async () => true);
    expect(reply).toContain('Ler matéria');
    expect(m.queueNews).toHaveBeenCalledTimes(1);
    expect(m.follow).not.toHaveBeenCalled();
    expect(m.save).not.toHaveBeenCalled();
  });
  it('withholds a preview when access is revoked while the source responds', async () => {
    let allowed = true;
    m.fetch.mockImplementation(async () => {
      allowed = false;
      return { items: [{ id: 'x', title: 'private-preview' }] };
    });
    const reply = await tryRadarChannelReply(
      message('Quando o Vasco joga dnv?'),
      user,
      async () => allowed
    );
    expect(reply).not.toContain('private-preview');
  });
});
describe('WhatsApp Radar privacy and opt-out', () => {
  it.each(['bus', 'direct'] as const)(
    'clarifies game timing and all-team replies without RAM context or a provider in %s',
    async (path) => {
      const model = vi.fn().mockRejectedValue(new Error('Synthetic provider outage'));
      const route = (msg: ChannelIncomingMessage) =>
        path === 'bus'
          ? processViaBus(
              { process: model } as never,
              msg,
              { sessionId: 's', conversationId: null },
              { ownpilotUserId: user },
              {
                sessionsRepo: {} as never,
                getChannel: () => undefined,
                isAccessAllowed: async () => true,
              }
            )
          : processDirectAgent(msg, user, async () => true);
      const before = await route(message('Antes do jogo começar'));
      expect(before).toContain('faltam horários de início confirmados');
      expect(before).toMatch(/qual time/i);
      expect(before).not.toMatch(/qual (?:partida|jogo)/i);
      const all = await route(message('Todos do Vasco'));
      expect(all).toContain('Vasco');
      expect(all).toContain('no dia de jogo');
      expect(model).not.toHaveBeenCalled();
      expect(m.follow).not.toHaveBeenCalled();
      expect(m.save).not.toHaveBeenCalled();
      expect(radarChatPending.size).toBe(0);
    }
  );
  it.each(['bus', 'direct'] as const)(
    'keeps the football topic after 11 minutes without renewing write consent in %s',
    async (path) => {
      const model = vi.fn().mockRejectedValue(new Error('Synthetic provider outage'));
      const route = (msg: ChannelIncomingMessage) =>
        path === 'bus'
          ? processViaBus(
              { process: model } as never,
              msg,
              { sessionId: 's', conversationId: null },
              { ownpilotUserId: user },
              {
                sessionsRepo: {} as never,
                getChannel: () => undefined,
                isAccessAllowed: async () => true,
              }
            )
          : processDirectAgent(msg, user, async () => true);
      await route(message('Me avise sempre que tiver jogo do Vasco'));
      expect(radarChatPending.size).toBe(1);
      const clock = vi.spyOn(Date, 'now').mockReturnValue(Date.now() + 11 * 60000);
      try {
        const before = await route(message('Antes do jogo começar'));
        expect(before).toContain('faltam horários de início confirmados');
        expect(before).toContain('Vasco');
        expect(before).not.toMatch(/qual (?:partida|jogo|time)/i);
        expect(radarChatPending.size).toBe(0);
        const all = await route(message('Todos do Vasco'));
        expect(all).toContain('Vasco');
        expect(all).toContain('no dia de jogo');
        expect(await tryRadarChannelReply(message('9h'), user, async () => true)).toBeNull();
        expect(model).not.toHaveBeenCalled();
        expect(m.follow).not.toHaveBeenCalled();
        expect(m.save).not.toHaveBeenCalled();
        expect(radarChatPending.size).toBe(0);
      } finally {
        clock.mockRestore();
      }
    }
  );
  it('clears live write consent after a before-kickoff clarification', async () => {
    await tryRadarChannelReply(
      message('Me avise sempre que tiver jogo do Vasco'),
      user,
      async () => true
    );
    expect(radarChatPending.size).toBe(1);
    expect(
      await tryRadarChannelReply(message('Antes do jogo começar'), user, async () => true)
    ).toContain('faltam horários de início confirmados');
    expect(radarChatPending.size).toBe(0);
    expect(await tryRadarChannelReply(message('9h'), user, async () => true)).toBeNull();
    expect(m.follow).not.toHaveBeenCalled();
  });
  it('discards an unfinished Flamengo follow when all Vasco games are only clarified', async () => {
    const model = vi.fn().mockRejectedValue(new Error('Synthetic provider outage'));
    const route = (msg: ChannelIncomingMessage) =>
      processViaBus(
        { process: model } as never,
        msg,
        { sessionId: 's', conversationId: null },
        { ownpilotUserId: user },
        {
          sessionsRepo: {} as never,
          getChannel: () => undefined,
          isAccessAllowed: async () => true,
        }
      );
    expect(await route(message('Me avise sempre que tiver jogo do Flamengo'))).toContain(
      'Em qual horário'
    );
    expect(radarChatPending.size).toBe(1);
    const clarification = await route(message('Todos do Vasco'));
    expect(clarification).toContain('Vasco');
    expect(clarification).not.toContain('Flamengo');
    expect(model).not.toHaveBeenCalled();
    expect(radarChatPending.size).toBe(0);
    expect(await tryRadarChannelReply(message('9h'), user, async () => true)).toBeNull();
    expect(m.follow).not.toHaveBeenCalled();
    expect(m.save).not.toHaveBeenCalled();
  });
  it.each(['cancelar', 'não'])(
    'clears only the retained topic with %s after write consent expires',
    async (text) => {
      await tryRadarChannelReply(
        message('Me avise sempre que tiver jogo do Vasco'),
        user,
        async () => true
      );
      const clock = vi.spyOn(Date, 'now').mockReturnValue(Date.now() + 11 * 60000);
      try {
        expect(await tryRadarChannelReply(message(text), user, async () => false)).toContain(
          'de lado'
        );
        expect(radarChatPending.size).toBe(0);
        expect(radarChatContext.size).toBe(0);
        expect(m.follow).not.toHaveBeenCalled();
        expect(m.save).not.toHaveBeenCalled();
      } finally {
        clock.mockRestore();
      }
    }
  );
  it.each(['account', 'channel', 'expired', 'same-message', 'foreign-owner'] as const)(
    'does not consume another retained context through a %s cancellation',
    async (kind) => {
      await tryRadarChannelReply(
        message('Me avise sempre que tiver jogo do Vasco'),
        user,
        async () => true
      );
      radarChatPending.clear();
      const context = [...radarChatContext.values()][0]!;
      const next = message('cancelar');
      if (kind === 'account') context.accountId = 'other-account';
      if (kind === 'channel') next.channelPluginId = 'other-channel';
      if (kind === 'expired') context.expires = Date.now() - 1;
      if (kind === 'same-message') next.id = context.messageId;
      if (kind === 'foreign-owner') {
        radarChatContext.clear();
        radarChatContext.set(JSON.stringify(['foreign-owner', 'channel.whatsapp', phone]), context);
      }
      expect(await tryRadarChannelReply(next, user, async () => false)).toBeNull();
      expect(radarChatContext.size).toBe(1);
      expect(m.follow).not.toHaveBeenCalled();
      expect(m.save).not.toHaveBeenCalled();
    }
  );
  it('does not turn an unrelated advance-time answer into a football conversation', async () => {
    expect(await tryRadarChannelReply(message('1 hora antes'), user, async () => true)).toBeNull();
    await tryRadarChannelReply(
      message('Me avise sempre que tiver jogo do Vasco'),
      user,
      async () => true
    );
    const reply = await tryRadarChannelReply(message('1 hora antes'), user, async () => true);
    expect(reply).toContain('Vasco');
    expect(reply).toContain('faltam horários de início confirmados');
    expect(radarChatPending.size).toBe(0);
    expect(m.follow).not.toHaveBeenCalled();
  });
  it('retains only read context for 24 hours and asks the team again after expiry', async () => {
    await tryRadarChannelReply(
      message('Me avise sempre que tiver jogo do Vasco'),
      user,
      async () => true
    );
    const startedAt = Date.now();
    const clock = vi.spyOn(Date, 'now').mockReturnValue(startedAt + 60 * 60000);
    try {
      expect(
        await tryRadarChannelReply(message('Antes do jogo começar'), user, async () => true)
      ).toContain('Vasco');
      clock.mockReturnValue(startedAt + 25 * 60 * 60000);
      const expired = await tryRadarChannelReply(
        message('Antes do jogo começar'),
        user,
        async () => true
      );
      expect(expired).toMatch(/qual time/i);
      expect(expired).not.toContain('Vasco');
      expect(m.follow).not.toHaveBeenCalled();
      expect(radarChatPending.size).toBe(0);
    } finally {
      clock.mockRestore();
    }
  });
  it.each(['account', 'channel', 'foreign-owner'] as const)(
    'does not expose a stored football topic through a different %s',
    async (kind) => {
      await tryRadarChannelReply(
        message('Me avise sempre que tiver jogo do Vasco'),
        user,
        async () => true
      );
      const context = [...radarChatContext.values()][0]!;
      radarChatPending.clear();
      if (kind === 'account') context.accountId = 'foreign-account';
      if (kind === 'foreign-owner') {
        radarChatContext.clear();
        radarChatContext.set(JSON.stringify(['foreign-owner', 'channel.whatsapp', phone]), context);
      }
      const next = message('Antes do jogo começar');
      if (kind === 'channel') next.channelPluginId = 'other-channel';
      const reply = await tryRadarChannelReply(next, user, async () => true);
      expect(reply).toMatch(/qual time/i);
      expect(reply).not.toContain('Vasco');
      expect(m.follow).not.toHaveBeenCalled();
    }
  );
  it.each(['group', 'attachment', 'outgoing', 'missing-origin', 'foreign'] as const)(
    'does not process football fragments in %s context',
    async (kind) => {
      const msg = message('Todos do Vasco');
      if (kind === 'group') msg.metadata!.isGroup = true;
      if (kind === 'attachment') msg.attachments = [{}] as never;
      if (kind === 'outgoing') msg.metadata!.fromMe = true;
      if (kind === 'missing-origin') delete msg.metadata!.fromMe;
      expect(
        await tryRadarChannelReply(
          msg,
          kind === 'foreign' ? 'foreign-owner' : user,
          async () => true
        )
      ).toBeNull();
      expect(m.context).not.toHaveBeenCalled();
      expect(m.follow).not.toHaveBeenCalled();
    }
  );
  it.each([
    '"Antes do jogo começar"',
    'Meu cliente disse: todos do Vasco',
    'Todos do Vasco. Só quero uma sugestão.',
  ])('does not execute football fragments quoted or used as an example: %s', async (text) => {
    expect(await tryRadarChannelReply(message(text), user, async () => true)).toBeNull();
    expect(m.context).not.toHaveBeenCalled();
    expect(m.follow).not.toHaveBeenCalled();
  });
  it('revalidates active access before returning a stored football topic', async () => {
    await tryRadarChannelReply(
      message('Me avise sempre que tiver jogo do Vasco'),
      user,
      async () => true
    );
    const reply = await tryRadarChannelReply(
      message('Antes do jogo começar'),
      user,
      async () => false
    );
    expect(reply).toContain('Renove');
    expect(reply).not.toContain('Vasco');
    expect(m.follow).not.toHaveBeenCalled();
  });
  it('does not turn a request for a suggestion into an operational game subscription', async () => {
    const reply = await tryRadarChannelReply(
      message('Me avise sempre que tiver jogo do Vasco às9h. Só quero uma sugestão.'),
      user,
      async () => true
    );
    expect(reply).toBeNull();
    expect(m.follow).not.toHaveBeenCalled();
    expect(radarChatPending.size).toBe(0);
  });
  it('continues a game subscription by the stable account key when the caller uses the phone alias', async () => {
    const stableUserId = 'stable-customer-data';
    m.identity.mockResolvedValue({
      accountId: 'a',
      dataUserId: stableUserId,
      phoneNumber: phone,
      isCurrent: true,
      retired: false,
    });
    m.account.mockResolvedValue({
      id: 'a',
      dataUserId: stableUserId,
      phoneNumber: phone,
      timeZone: 'America/Cuiaba',
    });
    expect(
      await tryRadarChannelReply(
        message('Me avise sempre que tiver jogo do Vasco'),
        user,
        async () => true
      )
    ).toContain('Em qual horário');
    expect(radarChatPending.has(JSON.stringify([stableUserId, 'channel.whatsapp', phone]))).toBe(
      true
    );
    expect(radarChatPending.has(JSON.stringify([user, 'channel.whatsapp', phone]))).toBe(false);
    expect(await tryRadarChannelReply(message('9h'), user, async () => true)).toContain('*09:00*');
    expect(m.follow).toHaveBeenCalledWith(
      expect.objectContaining({ delivery: 'matchday', notifyTime: '09:00' }),
      'Vasco',
      '09:00'
    );
    expect(m.scope.mock.calls.every(([scope]) => scope === stableUserId)).toBe(true);
    expect(radarChatPending.size).toBe(0);
    expect(m.save).not.toHaveBeenCalled();
  });
  it('asks for one clock when an explicit game request contains two possible clocks', async () => {
    expect(
      await tryRadarChannelReply(
        message('Me avise sempre que tiver jogo do Vasco às 9h ou às 10h'),
        user,
        async () => true
      )
    ).toContain('Em qual horário');
    expect(m.follow).not.toHaveBeenCalled();
  });
  it.each(['bus', 'direct'] as const)(
    'handles the explicit game request before a provider call in %s',
    async (path) => {
      const msg = message('Me avise sempre que tiver jogo do Vasco');
      const model = vi.fn().mockRejectedValue(new Error('Synthetic provider outage'));
      const reply =
        path === 'bus'
          ? await processViaBus(
              { process: model } as never,
              msg,
              { sessionId: 's', conversationId: null },
              { ownpilotUserId: user },
              {
                sessionsRepo: {} as never,
                getChannel: () => undefined,
                isAccessAllowed: async () => true,
              }
            )
          : await processDirectAgent(msg, user, async () => true);
      expect(reply).toContain('só nos dias de jogo');
      expect(reply).toContain('Em qual horário');
      expect(reply).not.toContain('resumo diário');
      expect(model).not.toHaveBeenCalled();
      expect(m.follow).not.toHaveBeenCalled();
      expect(await tryRadarChannelReply(message('às 9h'), user, async () => true)).toContain(
        '*09:00*'
      );
      expect(m.follow).toHaveBeenCalledWith(
        expect.objectContaining({
          source: 'football',
          target: 'br:cr-vasco-da-gama',
          delivery: 'matchday',
          notifyTime: '09:00',
        }),
        'Vasco',
        '09:00'
      );
      expect(m.save).not.toHaveBeenCalled();
      expect((await m.account()).timeZone).toBe('America/Cuiaba');
      expect(radarChatPending.size).toBe(0);
    }
  );
  it('asks for the team, then the time, without a model filling in either', async () => {
    expect(
      await tryRadarChannelReply(message('Me avise sempre que tiver jogo'), user, async () => true)
    ).toContain('Qual time');
    expect(await tryRadarChannelReply(message('Vasco'), user, async () => true)).toContain(
      'Em qual horário'
    );
    expect(await tryRadarChannelReply(message('09:15'), user, async () => true)).toContain(
      '*09:15*'
    );
    expect(m.follow).toHaveBeenCalledTimes(1);
  });
  it('accepts a written game-day time without changing the combined digest or the account timezone', async () => {
    expect(
      await tryRadarChannelReply(
        message('Me avise sempre que o Vasco jogar às 9h'),
        user,
        async () => true
      )
    ).toContain('*09:00*');
    expect(m.follow).toHaveBeenCalledTimes(1);
    expect(m.save).not.toHaveBeenCalled();
  });
  it('cancels only a verified pending question even after access expiry', async () => {
    await tryRadarChannelReply(
      message('Me avise sempre que tiver jogo do Vasco'),
      user,
      async () => true
    );
    expect(await tryRadarChannelReply(message('cancelar'), user, async () => false)).toContain(
      'de lado'
    );
    expect(radarChatPending.size).toBe(0);
    expect(m.follow).not.toHaveBeenCalled();
    expect(m.save).not.toHaveBeenCalled();
  });
  it.each(['account', 'channel', 'expired', 'same-message'] as const)(
    'does not consume a pending answer from a different %s',
    async (kind) => {
      const first = message('Me avise sempre que tiver jogo do Vasco');
      await tryRadarChannelReply(first, user, async () => true);
      const entry = [...radarChatPending.values()][0]!;
      const next = message('09:00');
      if (kind === 'account') entry.accountId = 'other-account';
      if (kind === 'channel') next.channelPluginId = 'other-channel';
      if (kind === 'expired') entry.expires = Date.now() - 1;
      if (kind === 'same-message') next.id = first.id;
      expect(await tryRadarChannelReply(next, user, async () => true)).toBeNull();
      expect(m.follow).not.toHaveBeenCalled();
    }
  );
  it('does not create a subscription if access or source availability is revoked', async () => {
    const msg = message('Me avise sempre que tiver jogo do Vasco às 9h');
    expect(await tryRadarChannelReply(msg, user, async () => false)).toContain('Renove');
    const available = vi.spyOn(contracts, 'sourceAvailable').mockReturnValue(false);
    try {
      expect(await tryRadarChannelReply(msg, user, async () => true)).toContain('Não consegui');
      expect(m.follow).not.toHaveBeenCalled();
    } finally {
      available.mockRestore();
    }
  });
  it.each(['group', 'attachment', 'outgoing', 'missing-origin', 'foreign'] as const)(
    'does not execute the explicit game follow in %s context',
    async (kind) => {
      const msg = message('Me avise sempre que tiver jogo do Vasco às 9h');
      if (kind === 'group') msg.metadata!.isGroup = true;
      if (kind === 'attachment') msg.attachments = [{}] as never;
      if (kind === 'outgoing') msg.metadata!.fromMe = true;
      if (kind === 'missing-origin') delete msg.metadata!.fromMe;
      expect(
        await tryRadarChannelReply(
          msg,
          kind === 'foreign' ? 'foreign-owner' : user,
          async () => true
        )
      ).toBeNull();
      expect(m.follow).not.toHaveBeenCalled();
    }
  );
  it('shows the individual game-day clock in the fast status reply', async () => {
    m.list.mockResolvedValue([
      { label: 'Vasco', active: true, delivery: 'matchday', notifyTime: '09:00' },
    ]);
    const reply = await tryRadarChannelReply(message('Meu Radar'), user, async () => true);
    expect(reply).toContain('Vasco · só nos dias de jogo, às 09:00');
    expect(reply).not.toContain('resumo diário');
  });
  it.each(['gastei 10', 'meu Radar'])(
    'ignores incomplete sender metadata for %s safely',
    async (text) => {
      const msg = message(text);
      delete (msg as Partial<ChannelIncomingMessage>).sender;
      expect(await tryRadarChannelReply(msg, user, async () => true)).toBeNull();
      expect(m.identity).not.toHaveBeenCalled();
    }
  );
  it.each([
    'Oi',
    'lembre de pagar amanhã',
    'quais alertas tenho ativos?',
    'parar o lembrete',
    'gastei 10',
  ])('does not read Radar for unrelated text %s', async (t) => {
    expect(await tryRadarChannelReply(message(t), user, async () => true)).toBeNull();
    expect(m.identity).not.toHaveBeenCalled();
  });
  it.each([
    'parar meu Radar',
    'Astra, cancela o Radar!',
    'Pode parar de mandar o radar',
    'Não quero mais receber o Radar.',
  ])('persists opt-out before acknowledging %s even after expiry', async (t) => {
    expect(await tryRadarChannelReply(message(t), user, async () => false)).toContain(
      'Radar pausado'
    );
    expect(m.save).toHaveBeenCalledWith(expect.objectContaining({ enabled: false }));
  });
  it('does not acknowledge a failed persistence', async () => {
    m.save.mockRejectedValueOnce(Error('DB_DOWN'));
    const t = await tryRadarChannelReply(message('parar meu radar'), user, async () => false);
    expect(t).toContain('Não consegui');
    expect(t).not.toContain('Radar pausado');
  });
  it.each(['group', 'attachment', 'retired', 'foreign'] as const)(
    'rejects %s context',
    async (kind) => {
      const msg = message('parar meu radar');
      if (kind === 'group') msg.metadata = { isGroup: true };
      if (kind === 'attachment') msg.attachments = [{}] as never;
      if (kind === 'retired') m.identity.mockResolvedValue({ retired: true });
      expect(
        await tryRadarChannelReply(
          msg,
          kind === 'foreign' ? 'whatsapp:5511999999999' : user,
          async () => true
        )
      ).toBeNull();
      expect(m.save).not.toHaveBeenCalled();
    }
  );
  it('uses the preserved historical account key after a phone change', async () => {
    m.identity.mockResolvedValue({
      accountId: 'a',
      dataUserId: 'whatsapp:old',
      isCurrent: true,
      retired: false,
    });
    m.account.mockResolvedValue({ id: 'a', dataUserId: 'whatsapp:old', phoneNumber: phone });
    expect(await tryRadarChannelReply(message('meu radar'), user, async () => true)).toContain(
      'USD'
    );
  });
  it('does not expose interests after access expiry', async () => {
    const t = await tryRadarChannelReply(message('meu radar'), user, async () => false);
    expect(t).not.toContain('USD');
    expect(m.list).not.toHaveBeenCalled();
  });
  it('discards private interests if the phone is relinked during the read', async () => {
    m.list.mockImplementation(async () => {
      m.identity.mockResolvedValue({ accountId: 'b', isCurrent: true, retired: false });
      return [{ label: 'PRIVATE_INTEREST', active: true }];
    });
    expect(await tryRadarChannelReply(message('meu radar'), user, async () => true)).not.toContain(
      'PRIVATE_INTEREST'
    );
  });
  it.each(['bus', 'direct'] as const)(
    'handles opt-out before inactive-access short circuits in %s',
    async (path) => {
      const text =
        path === 'bus'
          ? await processViaBus(
              { process: vi.fn() } as never,
              message('parar meu radar'),
              { sessionId: 's', conversationId: null },
              { ownpilotUserId: user },
              {
                sessionsRepo: {} as never,
                getChannel: () => undefined,
                isAccessAllowed: async () => false,
              }
            )
          : await processDirectAgent(message('parar meu radar'), user, async () => false);
      expect(text).toContain('Radar pausado');
    }
  );
});
