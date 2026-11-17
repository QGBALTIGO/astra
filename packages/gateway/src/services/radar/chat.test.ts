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
  preview: vi.fn(),
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
    queueNewsPreview: (...args: unknown[]) => m.preview(...args),
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
import { radarChatPending, radarChatContext } from './chat-pending.js';
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
  vi.unstubAllEnvs();
  vi.clearAllMocks();
  m.fetch.mockReset();
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
  m.preview.mockResolvedValue('queued');
});
describe('Radar chat consent, continuity and private account scope', () => {
  it('follows the stated pregame interval and ignores invented clock and lead arguments', async () => {
    vi.stubEnv('ASTRA_FOOTBALL_DATA_KEY', 'synthetic-test-key');
    m.search.mockResolvedValue([{ id: 'br:cr-vasco-da-gama', label: 'Vasco' }]);
    m.fetch.mockResolvedValue({ items: [], sourceLabel: 'API Dados Futebol' });
    m.prefs.set(user, { enabled: true, time: '07:15', quietStart: '22:00', quietEnd: '07:00' });
    const result = await message(user, 'Me avise 30 minutos antes de todos os jogos do Vasco', {
      action: 'status',
      source: 'football',
      delivery: 'digest',
      time: '18:00',
      leadMinutes: 120,
    });
    expect(result.changed).toBe(true);
    expect(m.follow).toHaveBeenCalledWith(
      user,
      expect.objectContaining({
        target: 'br:cr-vasco-da-gama',
        delivery: 'before',
        leadMinutes: 30,
      }),
      'Vasco',
      '07:15'
    );
    expect(m.save).not.toHaveBeenCalled();
    expect(m.fetch).toHaveBeenCalledTimes(1);
    expect(result.reply).toContain('30 minutos');
    expect(result.reply).toContain('Brasileirão Série A');
    expect(result.reply).not.toContain('18:00');
  });
  it('completes a live recurring question with before instead of inheriting an invented daily clock or lead', async () => {
    vi.stubEnv('ASTRA_FOOTBALL_DATA_KEY', 'synthetic-test-key');
    m.search.mockResolvedValue([{ id: 'br:cr-vasco-da-gama', label: 'Vasco' }]);
    m.fetch.mockResolvedValue({ items: [], sourceLabel: 'API Dados Futebol' });
    await message(user, 'Me avise sempre que tiver jogo do Vasco', {
      action: 'follow',
      time: '14:00',
      leadMinutes: 1440,
    });
    expect(m.follow).not.toHaveBeenCalled();
    const result = await message(user, 'Antes do jogo começar', { action: 'status' });
    expect(result.changed).toBe(true);
    expect(m.follow).toHaveBeenCalledWith(
      user,
      expect.objectContaining({ delivery: 'before', leadMinutes: 60 }),
      'Vasco',
      '07:00'
    );
    expect(radarChatPending.size).toBe(0);
  });
  it('does not turn a retained public topic or a model delivery argument into recurring consent', async () => {
    vi.stubEnv('ASTRA_FOOTBALL_DATA_KEY', 'synthetic-test-key');
    await message(user, 'Me avise sempre que tiver jogo do Vasco', { action: 'follow' });
    [...radarChatPending.values()][0]!.expires = Date.now() - 1;
    const before = await message(user, 'Antes do jogo começar', {
      action: 'follow',
      delivery: 'before',
      leadMinutes: 30,
    });
    expect(before.changed).toBe(false);
    expect(before.reply).toContain('Para ativar');
    expect(
      (await message(user, 'Todos do Vasco', { action: 'follow', delivery: 'before' })).changed
    ).toBe(false);
    expect(m.follow).not.toHaveBeenCalled();
    await expect(
      message(user, 'Quero acompanhar o Vasco', {
        action: 'follow',
        source: 'football',
        subject: 'Vasco',
        delivery: 'before',
        leadMinutes: 30,
      })
    ).rejects.toThrow(/antes dos jogos/);
  });
  it('requires one valid interval and preserves all subscriptions when the provider read fails', async () => {
    vi.stubEnv('ASTRA_FOOTBALL_DATA_KEY', 'synthetic-test-key');
    m.search.mockResolvedValue([{ id: 'br:cr-vasco-da-gama', label: 'Vasco' }]);
    for (const interval of ['5 minutos', '15 ou 30 minutos', '1,5 horas']) {
      const reply = await message(
        user,
        'Me avise ' + interval + ' antes de todos os jogos do Vasco',
        { action: 'follow' }
      );
      expect(reply.changed).toBe(false);
      expect(reply.reply).toContain('uma única antecedência');
    }
    m.fetch.mockRejectedValue(new Error('synthetic provider failure'));
    await expect(
      message(user, 'Me avise 1 hora antes de todos os jogos do Vasco', { action: 'follow' })
    ).rejects.toThrow();
    expect(m.follow).not.toHaveBeenCalled();
    expect(m.save).not.toHaveBeenCalled();
  });
  it('reports the saved before configuration without repeating the follow when the customer says all games', async () => {
    vi.stubEnv('ASTRA_FOOTBALL_DATA_KEY', 'synthetic-test-key');
    m.lists.set(user, [
      {
        id: 'own',
        source: 'football',
        label: 'Vasco',
        active: true,
        delivery: 'before',
        leadMinutes: 30,
      },
    ]);
    m.prefs.set(user, { enabled: true, time: '07:00', quietStart: '22:00', quietEnd: '07:00' });
    const result = await message(user, 'Todos do Vasco', { action: 'follow', delivery: 'before' });
    expect(result.changed).toBe(false);
    expect(result.reply).toContain('30 minutos de antecedência');
    expect(result.reply).not.toContain('Para ativar');
    expect(m.follow).not.toHaveBeenCalled();
  });
  it('renders a published kickoff in the customer timezone during a consultation', async () => {
    m.search.mockResolvedValue([{ id: 'br:cr-vasco-da-gama', label: 'Vasco' }]);
    m.fetch.mockResolvedValue({
      items: [
        {
          id: 'fixture',
          at: '2026-11-19T00:30:00Z',
          title: 'Vasco × Internacional',
          text: 'Horário divulgado',
        },
      ],
    });
    const result = await message(user, 'Quais os próximos jogos do Vasco?', {
      action: 'preview',
      source: 'football',
      subject: 'Vasco',
    });
    expect(result.reply).toContain('18/11/2026, 20:30');
    expect(result.reply).not.toContain('00:30');
    expect(m.follow).not.toHaveBeenCalled();
  });
  it('refuses quoted recurring consent and treats the exact expiry boundary as expired', async () => {
    vi.stubEnv('ASTRA_FOOTBALL_DATA_KEY', 'synthetic-test-key');
    await expect(
      message(user, 'Meu cliente disse: me avise 1 hora antes de todos os jogos do Vasco.', {
        action: 'follow',
        source: 'football',
        subject: 'Vasco',
        delivery: 'before',
        leadMinutes: 60,
      })
    ).rejects.toThrow(/antes dos jogos/);
    await message(user, 'Me avise sempre que tiver jogo do Vasco', { action: 'follow' });
    const pending = [...radarChatPending.values()][0]!;
    const clock = vi.spyOn(Date, 'now').mockReturnValue(pending.expires);
    try {
      await expect(
        message(user, '9h', {
          action: 'follow',
          source: 'football',
          subject: 'Vasco',
          delivery: 'matchday',
          time: '09:00',
        })
      ).rejects.toThrow();
      expect(m.follow).not.toHaveBeenCalled();
    } finally {
      clock.mockRestore();
    }
  });
  it('does not register an old team when a read-only all-team clarification changes the topic', async () => {
    const first = await message(user, 'Me avise sempre que tiver jogo do Flamengo', {
      action: 'follow',
    });
    expect(first.needsTime).toBe(true);
    expect(radarChatPending.size).toBe(1);
    const changedTopic = await message(user, 'Todos do Vasco', { action: 'status' });
    expect(changedTopic.changed).toBe(false);
    expect(changedTopic.reply).toContain('Todos os jogos do Vasco');
    expect(radarChatPending.size).toBe(0);
    await expect(
      message(user, '9h', {
        action: 'follow',
        source: 'football',
        subject: 'Flamengo',
        time: '09:00',
      })
    ).rejects.toThrow();
    expect(m.follow).not.toHaveBeenCalled();
  });
  it('keeps the team after the write question expires but never turns a relative kickoff reply into a follow', async () => {
    m.search.mockResolvedValue([{ id: 'br:cr-vasco-da-gama', label: 'Vasco' }]);
    await message(user, 'Me avise sempre que tiver jogo do Vasco', { action: 'follow' });
    const [key, pending] = [...radarChatPending.entries()][0]!;
    pending.expires = Date.now() - 60000;
    const contextExpiry = radarChatContext.get(key)!.expires;
    const before = await message(user, 'Antes do jogo começar', {
      action: 'follow',
      source: 'football',
      subject: 'outro time',
      time: '09:00',
    });
    expect(before.changed).toBe(false);
    expect(before.reply).toContain('Vasco');
    expect(before.reply).toContain('horários de início confirmados');
    expect(before.reply).not.toContain('qual time');
    expect(radarChatPending.has(key)).toBe(false);
    const all = await message(user, 'TodosdoVasco', { action: 'follow', time: '09:00' });
    expect(all.changed).toBe(false);
    expect(all.reply).toContain('Todos os jogos do Vasco');
    expect(radarChatContext.get(key)!.expires).toBe(contextExpiry);
    expect(m.follow).not.toHaveBeenCalled();
    await expect(
      message(user, '9h', { action: 'follow', source: 'football', subject: 'Vasco', time: '09:00' })
    ).rejects.toThrow();
    expect(m.follow).not.toHaveBeenCalled();
  });
  it('discards a still-valid write draft when the customer asks for a pregame notice', async () => {
    await message(user, 'Me avise sempre que tiver jogo do Vasco', { action: 'follow' });
    expect(radarChatPending.size).toBe(1);
    const result = await message(user, 'Antes do jogo começar', { action: 'status' });
    expect(result.reply).toContain('Vasco');
    expect(result.changed).toBe(false);
    expect(radarChatPending.size).toBe(0);
    expect(m.follow).not.toHaveBeenCalled();
  });
  it('explains relative kickoff limits without context and recognizes a known team after a restart', async () => {
    expect((await message(user, 'Antes do jogo começar', { action: 'status' })).reply).toContain(
      'De qual time'
    );
    const all = await message(user, 'Todos do Vasco', {
      action: 'follow',
      source: 'football',
      time: '09:00',
    });
    expect(all.changed).toBe(false);
    expect(all.reply).toContain('Todos os jogos do Vasco');
    expect(radarChatPending.size).toBe(0);
    expect((await message(user, 'Antes do jogo começar', { action: 'status' })).reply).toContain(
      'Vasco'
    );
    expect(m.follow).not.toHaveBeenCalled();
  });
  it('retains only the public team after a successful football follow or preview', async () => {
    m.search.mockResolvedValue([{ id: 'br:cr-vasco-da-gama', label: 'Vasco' }]);
    await message(user, 'Me avise sempre que tiver jogo do Vasco às 9h', { action: 'follow' });
    expect(radarChatPending.size).toBe(0);
    const context = [...radarChatContext.values()][0]!;
    expect(context.subject).toBe('Vasco');
    expect(context).not.toHaveProperty('args');
    expect(context).not.toHaveProperty('time');
    expect((await message(user, 'Antes do jogo começar', { action: 'status' })).reply).toContain(
      'Vasco'
    );
    expect(m.follow).toHaveBeenCalledTimes(1);
    clearRadarChatPending(user);
    m.fetch.mockResolvedValue({
      items: [],
      observedAt: new Date().toISOString(),
      expiresAt: new Date(Date.now() + 3600000).toISOString(),
      sourceLabel: 'openfootball',
      sourceUrl: 'https://example.org/',
    });
    await message(user, 'Quais os próximos jogos do Vasco?', {
      action: 'preview',
      source: 'football',
      subject: 'Vasco',
    });
    expect([...radarChatContext.values()][0]!.subject).toBe('Vasco');
    expect(radarChatPending.size).toBe(0);
  });
  it('does not leak an expired or foreign context and clears topic continuity on cancellation or opt-out', async () => {
    await message(user, 'Me avise sempre que tiver jogo do Vasco', { action: 'follow' });
    const [key, context] = [...radarChatContext.entries()][0]!;
    context.accountId = 'foreign-account';
    expect(
      (await message(user, 'Antes do jogo começar', { action: 'status' })).reply
    ).not.toContain('Vasco');
    context.accountId = 'account:' + user;
    context.expires = Date.now() - 1;
    expect(
      (await message(user, 'Antes do jogo começar', { action: 'status' })).reply
    ).not.toContain('Vasco');
    expect(radarChatContext.has(key)).toBe(false);
    await message(user, 'Todos do Vasco', { action: 'status' });
    await message(user, 'cancelar', { action: 'status' });
    expect(radarChatContext.size).toBe(0);
    await message(user, 'Todos do Vasco', { action: 'status' });
    await message(user, 'Pare meu Radar', { action: 'configure', enabled: false });
    expect(radarChatContext.size).toBe(0);
    expect(m.follow).not.toHaveBeenCalled();
  });
  it('asks the customer to choose between multiple game-day clocks instead of trusting the model first choice', async () => {
    m.search.mockResolvedValue([{ id: 'br:cr-vasco-da-gama', label: 'Vasco' }]);
    const first = await message(user, 'Me avise sempre que tiver jogo do Vasco às 9h ou às 10h', {
      action: 'follow',
      source: 'football',
      subject: 'Vasco',
      delivery: 'matchday',
      time: '09:00',
    });
    expect(first.needsTime).toBe(true);
    expect(first.changed).toBe(false);
    expect(first.reply).toContain('Em qual horário');
    expect(m.follow).not.toHaveBeenCalled();
    const chosen = await message(user, 'às 10h', { action: 'follow', time: '09:00' });
    expect(chosen.changed).toBe(true);
    expect(m.follow).toHaveBeenCalledWith(
      user,
      expect.objectContaining({
        delivery: 'matchday',
        notifyTime: '10:00',
      }),
      'Vasco',
      '10:00'
    );
  });
  it.each([undefined, '07:00'])(
    'uses the game-day clock actually stated instead of the model time %s',
    async (time) => {
      m.search.mockResolvedValue([{ id: 'br:cr-vasco-da-gama', label: 'Vasco' }]);
      const result = await message(user, 'Me avise sempre que tiver jogo do Vasco às 9h30', {
        action: 'status',
        time,
      });
      expect(result.changed).toBe(true);
      expect(m.follow.mock.calls[0]?.[1]).toMatchObject({
        delivery: 'matchday',
        notifyTime: '09:30',
      });
    }
  );
  it('does not turn a one-off game reminder into a recurring follow', async () => {
    const result = await message(user, 'Me lembre do jogo do Vasco amanhã às 09:00', {
      action: 'follow',
      source: 'football',
      subject: 'Vasco',
      delivery: 'matchday',
      time: '09:00',
    });
    expect(result.changed).toBe(false);
    expect(result.reply).toContain('partida específica');
    expect(m.follow).not.toHaveBeenCalled();
  });
  it('preserves an explicit request not to send daily summaries', async () => {
    m.search.mockResolvedValue([{ id: 'br:cr-vasco-da-gama', label: 'Vasco' }]);
    m.prefs.set(user, { enabled: true, time: '08:00', quietStart: '22:00', quietEnd: '07:00' });
    const first = await message(user, 'Me avise quando tiver jogo do Vasco, mas não todo dia', {
      action: 'follow',
      source: 'football',
      subject: 'Vasco',
      delivery: 'digest',
    });
    expect(first.needsTime).toBe(true);
    expect(first.reply).toContain('só nos dias de jogo');
    await message(user, 'às 09:00', { action: 'status' });
    expect(m.follow.mock.calls[0]?.[1]).toMatchObject({
      delivery: 'matchday',
      notifyTime: '09:00',
    });
  });
  it('never reactivates a game alert when asked to stop it', async () => {
    m.lists.set(user, [
      {
        id: 'vasco',
        label: 'Vasco',
        source: 'football',
        delivery: 'matchday',
        notifyTime: '09:00',
        active: true,
      },
    ]);
    const result = await message(user, 'Pare de me avisar quando tiver jogo do Vasco', {
      action: 'pause',
      interestId: 'vasco',
    });
    expect(result.changed).toBe(true);
    expect(m.change).toHaveBeenCalledWith(user, 'vasco', { active: false });
    expect(m.follow).not.toHaveBeenCalled();
  });
  it('does not queue a nonexistent daily digest when only matchday alerts are active', async () => {
    m.prefs.set(user, { enabled: true, time: '08:00', quietStart: '22:00', quietEnd: '07:00' });
    m.lists.set(user, [
      {
        id: 'vasco',
        label: 'Vasco',
        source: 'football',
        delivery: 'matchday',
        notifyTime: '09:00',
        active: true,
      },
    ]);
    expect((await message(user, 'Envie meu Radar agora', { action: 'send_now' })).reply).toContain(
      'próximos jogos'
    );
    expect(m.request).not.toHaveBeenCalled();
  });
  it('resumes matchday-only preferences without promising a daily digest', async () => {
    m.lists.set(user, [
      {
        id: 'vasco',
        label: 'Vasco',
        source: 'football',
        delivery: 'matchday',
        notifyTime: '09:00',
        active: true,
      },
    ]);
    const result = await message(user, 'Ative meu Radar às 09:00', {
      action: 'configure',
      enabled: true,
      time: '09:00',
    });
    expect(result.changed).toBe(true);
    expect(result.reply).toContain('avisos estão ativados');
    expect(result.reply).not.toContain('Resumo diário');
  });
  it.each(['follow', 'status', 'configure', 'resume', 'send_now'])(
    'treats the exact Vasco game alert request as matchday even when the model selects %s',
    async (action) => {
      m.search.mockResolvedValue([{ id: 'br:cr-vasco-da-gama', label: 'Vasco' }]);
      m.prefs.set(user, { enabled: true, time: '08:00', quietStart: '22:00', quietEnd: '07:00' });
      const first = await message(user, 'Me avise sempre que tiver jogo do Vasco', {
        action,
        source: 'football',
        subject: 'Vasco',
        delivery: 'digest',
        time: '08:00',
      });
      expect(first.needsTime).toBe(true);
      expect(first.reply).toContain('só nos dias de jogo');
      expect(first.reply).toContain('Vasco');
      expect(first.reply).not.toContain('resumo diário');
      expect(m.follow).not.toHaveBeenCalled();
      const saved = await message(user, 'às 09:00', { action: 'status', time: '11:00' });
      expect(saved.changed).toBe(true);
      expect(saved.reply).toContain('só nos dias de jogo');
      expect(saved.reply).toContain('*09:00*');
      expect(saved.reply).not.toContain('Resumo diário');
      expect(m.follow).toHaveBeenCalledWith(
        user,
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
      expect(m.request).not.toHaveBeenCalled();
    }
  );
  it('accepts an explicit game-day clock without moving the existing digest', async () => {
    m.search.mockResolvedValue([{ id: 'br:cr-vasco-da-gama', label: 'Vasco' }]);
    m.prefs.set(user, { enabled: true, time: '08:00', quietStart: '22:00', quietEnd: '07:00' });
    m.lists.set(user, [
      { id: 'other', label: 'Mundo', active: true, source: 'news', delivery: 'digest' },
    ]);
    const result = await message(user, 'Me avise quando o Vasco jogar às 09:00', {
      action: 'follow',
      time: '09:00',
    });
    expect(result.changed).toBe(true);
    expect(m.follow).toHaveBeenCalledWith(
      user,
      expect.objectContaining({ delivery: 'matchday', notifyTime: '09:00' }),
      'Vasco',
      '09:00'
    );
    expect(m.save).not.toHaveBeenCalled();
  });
  it('asks the team before the game-day clock and preserves the requested delivery over short answers', async () => {
    m.search.mockResolvedValue([{ id: 'br:cr-vasco-da-gama', label: 'Vasco' }]);
    expect(
      (await message(user, 'Me lembre sempre que tiver jogo', { action: 'follow' })).needsSubject
    ).toBe(true);
    expect((await message(user, 'Vasco', { action: 'status' })).reply).toContain(
      'só nos dias de jogo'
    );
    expect((await message(user, 'às 9h', { action: 'status' })).changed).toBe(true);
    expect(m.follow.mock.calls[0]?.[1]).toMatchObject({
      delivery: 'matchday',
      notifyTime: '09:00',
    });
  });
  it('asks which team when more than one was named rather than subscribing an invented choice', async () => {
    expect(
      (
        await message(user, 'Me avise sempre dos jogos do Vasco e Flamengo', {
          action: 'follow',
          subject: 'Vasco',
        })
      ).needsSubject
    ).toBe(true);
    expect(m.follow).not.toHaveBeenCalled();
  });
  it('keeps an explicitly requested daily digest as a daily digest', async () => {
    await message(user, 'Me avise todos os dias com um resumo dos jogos do Flamengo às 09:00', {
      action: 'follow',
      source: 'football',
      subject: 'Flamengo',
      time: '09:00',
      delivery: 'digest',
    });
    expect(m.follow.mock.calls[0]?.[1]).toMatchObject({ delivery: 'digest' });
    expect(m.follow.mock.calls[0]?.[1]).not.toHaveProperty('notifyTime');
  });
  it('does not promise kickoff alerts or silently subscribe a daily digest', async () => {
    const result = await message(user, 'Me avise uma hora antes do jogo do Vasco', {
      action: 'follow',
      source: 'football',
      subject: 'Vasco',
      delivery: 'before',
    });
    expect(result.changed).toBe(false);
    expect(result.reply).toContain('horário confirmado');
    expect(result.reply).toContain('só nos dias de jogo');
    expect(m.follow).not.toHaveBeenCalled();
  });
  it('shows matchday time in status without claiming it is a daily digest', async () => {
    m.prefs.set(user, { enabled: true, time: '08:00', quietStart: '22:00', quietEnd: '07:00' });
    m.lists.set(user, [
      {
        id: 'vasco',
        label: 'Vasco',
        source: 'football',
        delivery: 'matchday',
        notifyTime: '09:00',
        active: true,
      },
    ]);
    const result = await message(user, 'Como estão meus avisos?', { action: 'status' });
    expect(result.reply).toContain('só nos dias de jogo, às 09:00');
    expect(result.reply).not.toContain('Resumo diário');
  });
  it('answers a football consultation with the fixtures and no technical source links', async () => {
    m.fetch.mockResolvedValue({
      items: [
        {
          id: 'match',
          title: 'Flamengo × Palmeiras',
          text: '18/11/2026 · Horário a confirmar.',
          url: 'https://github.com/openfootball/south-america/blob/master/brazil/2026_br1.txt',
        },
      ],
      sourceLabel: 'openfootball',
    });
    const result = await message(user, 'Qual é o próximo jogo do Flamengo?', {
      action: 'preview',
      source: 'football',
      subject: 'Flamengo',
    });
    expect(result.reply).toContain('Flamengo × Palmeiras');
    expect(result.reply).toContain('18/11/2026');
    expect(result.reply).not.toMatch(/https?:|github|CC0|openfootball/);
    expect(m.follow).not.toHaveBeenCalled();
  });
  it.each(['resume', 'status', 'send_now'])(
    'keeps explicit recurring consent when the model chooses %s for a paused saved topic',
    async (action) => {
      m.lists.set(user, [
        { id: 'saved-team', active: true, label: 'Flamengo', source: 'football' },
      ]);
      const first = await message(user, 'Quero acompanhar o Flamengo no meu Radar todos os dias.', {
        action,
        interestId: 'saved-team',
      });
      expect(first.needsTime).toBe(true);
      expect(first.reply).toContain('Flamengo');
      expect(m.follow).not.toHaveBeenCalled();
      expect(m.request).not.toHaveBeenCalled();
      const next = await message(user, 'às 15:43', { action: 'configure', time: '09:00' });
      expect(next.changed).toBe(true);
      expect(m.follow).toHaveBeenCalledWith(
        user,
        expect.objectContaining({ source: 'football', target: 'br:cr-flamengo' }),
        'Flamengo',
        '15:43'
      );
    }
  );
  it('parses a pending clock even when the model omits the time argument', async () => {
    await message(user, 'Acompanhe o Flamengo', {
      action: 'follow',
      source: 'football',
      subject: 'Flamengo',
    });
    expect((await message(user, 'às 8h30', { action: 'status' })).changed).toBe(true);
    expect(m.follow).toHaveBeenLastCalledWith(user, expect.anything(), 'Flamengo', '08:30');
  });
  it('does not turn a hypothetical daily follow into consent', async () => {
    await expect(
      message(user, 'Exemplo: quero acompanhar o Flamengo todos os dias.', {
        action: 'follow',
        source: 'football',
        subject: 'Flamengo',
      })
    ).rejects.toThrow();
    expect(m.follow).not.toHaveBeenCalled();
  });
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
    expect(result.reply).toContain('Ler matéria');
    expect(result.reply).not.toContain('https://');
    expect(m.preview).toHaveBeenCalledWith(
      user,
      0,
      expect.stringContaining('channel.whatsapp:'),
      expect.arrayContaining([
        expect.objectContaining({
          text: expect.stringContaining('Leitura pública'),
          urlButton: {
            label: 'Ler matéria',
            url: 'https://pt.globalvoices.org/2026/11/09/example/',
          },
        }),
      ])
    );
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
    expect(result.reply).toContain('Ler matéria');
    expect(m.preview).toHaveBeenCalledWith(
      user,
      0,
      expect.any(String),
      expect.arrayContaining([
        expect.objectContaining({ text: expect.stringContaining('Manchete') }),
      ])
    );
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
