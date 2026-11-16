import { beforeEach, describe, it, expect, vi } from 'vitest';
import { runInExecContext } from '@ownpilot/core/agent';
const m = vi.hoisted(() => ({
  follow: vi.fn(),
  save: vi.fn(),
  change: vi.fn(),
  search: vi.fn(),
  fetch: vi.fn(),
  context: vi.fn(),
  request: vi.fn(),
  lists: new Map<string, unknown[]>(),
  prefs: new Map<string, unknown>(),
}));
vi.mock('@ownpilot/core/channels', () => ({
  getChannelService: () => ({ getChannel: () => ({ getPlatform: () => 'whatsapp' }) }),
}));
vi.mock('../../db/repositories/customer-accounts.js', () => ({
  customerAccountsRepo: {
    getByDataUserId: async (id: string) => ({
      id: 'account:' + id,
      dataUserId: id,
      phoneNumber: id,
    }),
  },
}));
vi.mock('../customer-identity.js', () => ({
  getCustomerIdentityService: () => ({ getContext: m.context }),
}));
vi.mock('../../db/repositories/customer-radar.js', () => ({
  radarRepo: {
    rememberChoices: vi.fn(),
    queueRequestedDigest: (...args: unknown[]) => m.request(...args),
  },
  CustomerRadarRepository: class {
    constructor(readonly user: string) {}
    list = async () => m.lists.get(this.user) ?? [];
    preferences = async () => ({
      revision: 0,
      preferences: m.prefs.get(this.user) ?? {
        enabled: false,
        time: '07:00',
        quietStart: '22:00',
        quietEnd: '07:00',
      },
    });
    followFromChat = (...args: unknown[]) => m.follow(this.user, ...args);
    savePreferences = (...args: unknown[]) => m.save(this.user, ...args);
    change = (...args: unknown[]) => m.change(this.user, ...args);
  },
}));
vi.mock('./providers.js', () => ({ searchRadar: m.search, fetchRadarResource: m.fetch }));
vi.mock('../email-digest.js', () => ({
  emailDigestTimeRequested: (text: string, hour: number, minute: number) => {
    const match = text.match(/(?:às\s*|as\s*|das\s*|^)(\d{1,2})(?:h|:)?(\d{2})?\b/i);
    return !!match && Number(match[1]) === hour && Number(match[2] ?? 0) === minute;
  },
}));
import { manageRadarChat, clearRadarChatPending } from './chat.js';
import { executeCustomerRadarTool } from '../../tools/customer-radar-tools.js';
const user = 'whatsapp:synthetic-a';
const message = (
  id: string,
  text: string,
  args: Record<string, unknown>,
  overrides: Record<string, unknown> = {}
) =>
  runInExecContext(
    {
      channelIsPrivate: true,
      channelPluginId: 'channel.whatsapp',
      platformChatId: id,
      channelMessageId: crypto.randomUUID(),
      channelRequestText: text,
      externalContentGuard: { seen: false },
      ...overrides,
    } as never,
    () => manageRadarChat(id, args)
  );
beforeEach(() => {
  vi.clearAllMocks();
  m.lists.clear();
  m.prefs.clear();
  clearRadarChatPending(user);
  m.context.mockImplementation(async (id: string) => ({
    account: {
      id,
      dataUserId: id.replace('account:', ''),
      phoneNumber: id.replace('account:', ''),
      timeZone: 'America/Cuiaba',
    },
    customer: { access: { canWrite: true } },
  }));
  m.search.mockResolvedValue([{ id: 'br:cr-flamengo', label: 'Flamengo' }]);
  m.follow.mockImplementation(async (_user: string, input: unknown, label: string) => ({
    interest: { id: 'synthetic-follow', input, label },
    keptPaused: 0,
  }));
  m.save.mockResolvedValue({});
  m.change.mockResolvedValue({ label: 'Tecnologia', source: 'news', active: false });
});
describe('Radar chat consent, continuity and private account scope', () => {
  it('queues an explicitly requested extra digest only for the caller with opt-in active', async () => {
    m.prefs.set(user, { enabled: true, time: '08:00', quietStart: '22:00', quietEnd: '07:00' });
    m.lists.set(user, [{ id: 'topic', active: true, label: 'Flamengo', source: 'football' }]);
    m.request.mockResolvedValueOnce('queued');
    expect((await message(user, 'Envie meu Radar agora', { action: 'send_now' })).queued).toBe(
      true
    );
    expect(m.request).toHaveBeenCalledWith(user, 0, expect.stringContaining('channel.whatsapp:'));
    expect(m.save).not.toHaveBeenCalled();
  });
  it('does not enable a paused Radar or queue an unsolicited extra digest', async () => {
    expect((await message(user, 'Envie meu Radar agora', { action: 'send_now' })).reply).toContain(
      'pausado'
    );
    await expect(
      message(user, 'Como seria enviar meu Radar agora?', { action: 'send_now' })
    ).rejects.toThrow();
    expect(m.request).not.toHaveBeenCalled();
  });
  it('uses the news subject already stated in the real request when the model omits it', async () => {
    m.fetch.mockResolvedValue({
      items: [
        {
          id: 'one',
          title: 'Leitura pública',
          text: 'Publicado em 09/11/2026 · Global Voices · CC BY 3.0',
          url: 'https://pt.globalvoices.org/2026/11/09/example/',
        },
      ],
      sourceLabel: 'Global Voices',
    });
    const result = await message(
      user,
      'Quais notícias do mundo você tem agora? Só consulte, sem ativar envios.',
      { action: 'preview', source: 'news' }
    );
    expect(m.fetch).toHaveBeenCalledWith(
      expect.objectContaining({ target: 'mundo', label: 'mundo' })
    );
    expect(result.reply).toContain('Leitura pública');
    expect(result.reply.match(/CC BY 3\.0/g)).toHaveLength(1);
    expect(m.follow).not.toHaveBeenCalled();
    expect(m.save).not.toHaveBeenCalled();
  });
  it('asks only for a genuinely missing query topic and clears continuity after consulting it', async () => {
    m.fetch.mockResolvedValue({ items: [], sourceLabel: 'Global Voices' });
    expect(
      (await message(user, 'Consulte notícias', { action: 'preview', source: 'news' })).reply
    ).toContain('consultar');
    await message(user, 'Mundo', { action: 'preview', source: 'news', subject: 'Mundo' });
    await message(user, 'Flamengo', { action: 'preview', source: 'football', subject: 'Flamengo' });
    expect(m.fetch).toHaveBeenLastCalledWith(
      expect.objectContaining({ source: 'football', target: 'br:cr-flamengo' })
    );
  });
  it('does not reinterpret a fresh football request as the answer to an earlier news question', async () => {
    m.fetch.mockResolvedValue({ items: [], sourceLabel: 'openfootball' });
    await message(user, 'Consulte notícias', { action: 'preview', source: 'news' });
    await message(user, 'Consulte o calendário de futebol do Flamengo no Radar, sem cadastrar.', {
      action: 'preview',
      source: 'football',
      subject: 'Flamengo',
    });
    expect(m.fetch).toHaveBeenLastCalledWith(
      expect.objectContaining({ source: 'football', target: 'br:cr-flamengo' })
    );
    expect(m.follow).not.toHaveBeenCalled();
  });
  it.each(['Não quero mais notícias', 'Não me mande notícias'])(
    'honors a natural opt-out: %s',
    async (text) => {
      m.lists.set(user, [{ id: 'news-topic', label: 'Tecnologia', source: 'news', active: true }]);
      const result = await message(user, text, { action: 'pause', interestId: 'news-topic' });
      expect(result.changed).toBe(true);
      expect(m.change).toHaveBeenCalledWith(user, 'news-topic', { active: false });
      expect(m.follow).not.toHaveBeenCalled();
    }
  );
  it.each([
    { action: 'follow', source: 'news', subject: 'Tecnologia', time: '08:00' },
    { action: 'resume', interestId: 'news-topic' },
    { action: 'configure', enabled: true, time: '08:00' },
  ])('cannot interpret an opt-out as enabling delivery: %j', async (args) => {
    await expect(message(user, 'Não quero mais notícias', args)).rejects.toThrow();
    expect(m.save).not.toHaveBeenCalled();
    expect(m.follow).not.toHaveBeenCalled();
    expect(m.change).not.toHaveBeenCalled();
  });
  it('asks the missing subject before a clock and never writes a guess', async () => {
    expect(
      (await message(user, 'Quero receber notícias', { action: 'follow', source: 'news' })).reply
    ).toContain('qual assunto');
    expect(m.follow).not.toHaveBeenCalled();
  });
  it('preserves a topic across a short time answer', async () => {
    const first = await message(user, 'Acompanhe o Flamengo', {
      action: 'follow',
      source: 'football',
      subject: 'Flamengo',
    });
    expect(first.needsTime).toBe(true);
    const next = await message(user, 'às 8h', {
      action: 'configure',
      enabled: true,
      time: '08:00',
    });
    expect(next.changed).toBe(true);
    expect(m.follow).toHaveBeenCalledWith(
      user,
      expect.objectContaining({ source: 'football', target: 'br:cr-flamengo' }),
      'Flamengo',
      '08:00'
    );
  });
  it('asks once instead of rejecting an invented default clock and keeps the team for the real answer', async () => {
    const first = await message(user, 'Quero acompanhar o Flamengo no meu Radar todos os dias.', {
      action: 'follow',
      source: 'football',
      subject: 'Flamengo',
      time: '07:00',
    });
    expect(first.needsTime).toBe(true);
    expect(m.follow).not.toHaveBeenCalled();
    const next = await message(user, 'às 8h', {
      action: 'configure',
      enabled: true,
      time: '08:00',
    });
    expect(next.changed).toBe(true);
    expect(m.follow).toHaveBeenCalledWith(
      user,
      expect.objectContaining({ source: 'football', target: 'br:cr-flamengo' }),
      'Flamengo',
      '08:00'
    );
  });
  it('preserves a previously requested time across a missing team answer', async () => {
    expect(
      (
        await message(user, 'Quero receber meu time às 8h', {
          action: 'follow',
          source: 'football',
          time: '08:00',
        })
      ).needsSubject
    ).toBe(true);
    expect(
      (
        await message(user, 'Flamengo', {
          action: 'follow',
          source: 'football',
          subject: 'Flamengo',
        })
      ).changed
    ).toBe(true);
    expect(m.follow).toHaveBeenCalledWith(user, expect.anything(), 'Flamengo', '08:00');
  });
  it('keeps short replies in the same account rather than another customer', async () => {
    await message(user, 'Quero receber notícias de IA', {
      action: 'follow',
      source: 'news',
      subject: 'IA',
    });
    await expect(
      message('whatsapp:synthetic-b', 'às 8h', {
        action: 'follow',
        source: 'news',
        subject: 'IA',
        time: '08:00',
      })
    ).rejects.toThrow();
    expect(m.follow).not.toHaveBeenCalled();
  });
  it('cancelling clears a previously incomplete request', async () => {
    await message(user, 'Acompanhe o Flamengo', {
      action: 'follow',
      source: 'football',
      subject: 'Flamengo',
    });
    clearRadarChatPending(user);
    await expect(
      message(user, 'às 8h', {
        action: 'follow',
        source: 'football',
        subject: 'Flamengo',
        time: '08:00',
      })
    ).rejects.toThrow();
  });
  it.each([
    'Só consulte notícias de IA',
    'Como posso receber notícias?',
    'Não ative notícias de IA',
    'É um exemplo: acompanhe o Flamengo',
  ])('does not turn a query or example into a subscription: %s', async (text) => {
    await expect(
      message(user, text, { action: 'follow', source: 'news', subject: 'IA', time: '08:00' })
    ).rejects.toThrow();
    expect(m.follow).not.toHaveBeenCalled();
  });
  it('requires the schedule actually requested rather than a model-invented clock', async () => {
    expect(
      (
        await message(user, 'Quero receber notícias às 8h', {
          action: 'follow',
          source: 'news',
          subject: 'IA',
          time: '09:00',
        })
      ).needsTime
    ).toBe(true);
    expect(m.follow).not.toHaveBeenCalled();
  });
  it.each([
    { channelIsPrivate: false },
    { platformChatId: 'another-customer' },
    { externalContentGuard: { seen: true } },
    { channelConversationOnly: true },
  ])('rejects an unsafe conversation context', async (overrides) => {
    await expect(
      message(
        user,
        'Acompanhe o Flamengo às 8h',
        { action: 'follow', source: 'football', subject: 'Flamengo', time: '08:00' },
        overrides
      )
    ).rejects.toThrow();
    expect(m.follow).not.toHaveBeenCalled();
  });
  it('rechecks access after external lookup and before saving', async () => {
    m.search.mockImplementation(async () => {
      m.context.mockResolvedValue(null);
      return [{ id: 'br:cr-flamengo', label: 'Flamengo' }];
    });
    await expect(
      message(user, 'Acompanhe o Flamengo às 8h', {
        action: 'follow',
        source: 'football',
        subject: 'Flamengo',
        time: '08:00',
      })
    ).rejects.toThrow('identificação');
    expect(m.follow).not.toHaveBeenCalled();
  });
  it('does not alter a follow belonging to another account', async () => {
    const r = await message(user, 'Pause as notícias', {
      action: 'pause',
      interestId: 'foreign-id',
    });
    expect(r.changed).toBe(false);
    expect(m.change).not.toHaveBeenCalled();
  });
  it('only previews news and fences later writes after external content', async () => {
    m.fetch.mockResolvedValue({
      sourceLabel: 'Global Voices',
      items: [
        {
          title: 'Manchete',
          text: 'Global Voices · CC BY 3.0',
          url: 'https://pt.globalvoices.org/a',
        },
      ],
    });
    const guard = { seen: false };
    const result = await message(
      user,
      'Notícias de IA',
      { action: 'preview', source: 'news', subject: 'IA' },
      { externalContentGuard: guard }
    );
    expect(result.reply).toContain('Manchete');
    expect(guard.seen).toBe(true);
    expect(m.follow).not.toHaveBeenCalled();
  });
  it('handles 500 overlapping synthetic private conversations without crossing recipients', async () => {
    const ids = Array.from({ length: 500 }, (_, i) => 'whatsapp:synthetic-load-' + i);
    const topics = [
      'IA',
      'Tecnologia',
      'Economia',
      'Brasil',
      'Saúde',
      'Cultura',
      'África',
      'Educação',
      'Meio ambiente',
      'Ciência',
    ];
    const result = await Promise.all(
      ids.map((id, i) =>
        message(id, 'Quero receber notícias de ' + topics[i % topics.length] + ' às 8h', {
          action: 'follow',
          source: 'news',
          subject: topics[i % topics.length],
          time: '08:00',
        })
      )
    );
    expect(result.every((r) => r.changed)).toBe(true);
    expect(new Set(m.follow.mock.calls.map((c) => c[0]))).toEqual(new Set(ids));
    expect(m.follow).toHaveBeenCalledTimes(500);
    expect(new Set(m.follow.mock.calls.map((c) => (c[1] as { target: string }).target)).size).toBe(
      10
    );
  });
  it('contains internal database errors without claiming a subscription succeeded', async () => {
    m.follow.mockRejectedValue(Error('SQL secret internals'));
    const r = await runInExecContext(
      {
        channelIsPrivate: true,
        channelPluginId: 'channel.whatsapp',
        platformChatId: user,
        channelMessageId: 'synthetic',
        channelRequestText: 'Quero receber notícias de IA às 8h',
        externalContentGuard: { seen: false },
      } as never,
      () =>
        executeCustomerRadarTool(
          'manage_radar',
          { action: 'follow', source: 'news', subject: 'IA', time: '08:00' },
          user
        )
    );
    expect(r.success).toBe(false);
    expect(JSON.stringify(r)).not.toMatch(/SQL|secret|ativado/);
  });
});
