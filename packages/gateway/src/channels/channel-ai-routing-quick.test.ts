import { beforeEach, describe, expect, it, vi } from 'vitest';

const mockSchedule = vi.hoisted(() => vi.fn());
const mockExpense = vi.hoisted(() => vi.fn());
vi.mock('../tools/channel-reminder-tools.js', () => ({
  executeChannelReminderTool: mockSchedule,
}));
vi.mock('../tools/expense-tools.js', () => ({
  executeExpenseTool: mockExpense,
}));

import {
  deterministicChannelReply,
  expenseSummaryPeriodForChannel,
  processDirectAgent,
  processViaBus,
  tryExpenseSummaryChannelReply,
  tryScheduleRelativeChannelReminder,
} from './channel-ai-routing.js';

describe('Astra respostas gratuitas e instantâneas', () => {
  it.each([
    ['oi', 'Olá'],
    ['Oi', 'Olá'],
    ['OLÁ!', 'Olá'],
    ['ola...', 'Olá'],
    ['Bom dia!', 'Bom dia'],
    ['Boa tarde', 'Boa tarde'],
    ['Boa noite?', 'Boa noite'],
  ])('responde saudação %s sem usar o modelo', (message, greeting) => {
    expect(deterministicChannelReply(message)).toBe(
      `${greeting}! 😊\n\nComo posso ajudar você hoje?`
    );
  });

  it.each([
    'Oi, me lembre de pagar a conta',
    'Amanhã eu tenho dentista',
    'Quanto gastei hoje?',
    'Bom dia, quero marcar consulta às 10h',
    'Que dia é hoje?',
    'Oi, tudo bem com meus lembretes?',
  ])('encaminha solicitação contextual %s à IA', (message) => {
    expect(deterministicChannelReply(message)).toBeNull();
  });
});

describe('Consulta financeira direta e read-only pelo canal', () => {
  const message = {
    id: 'incoming-finance-1',
    channelPluginId: 'channel.whatsapp',
    platformChatId: 'chat-123',
    text: 'Quanto gastei esse mês?',
  };

  beforeEach(() => {
    mockExpense.mockReset();
    mockExpense.mockResolvedValue({
      success: true,
      result: {
        period: 'this_month',
        count: 1,
        totalAmount: 50,
        byCurrency: { BRL: 50 },
      },
    });
  });

  it.each([
    ['Quanto gastei esse mês?', 'this_month'],
    ['Quanto gastei hoje?', 'today'],
    ['Qual o total dos meus gastos nesta semana?', 'this_week'],
    ['Resumo de despesas do mês passado', 'last_month'],
    ['Quanto gastamos neste ano?', 'this_year'],
  ])('reconhece o período em %s', (text, period) => {
    expect(expenseSummaryPeriodForChannel(text)).toBe(period);
  });

  it('não intercepta uma frase que não pede um total inequívoco', () => {
    expect(expenseSummaryPeriodForChannel('Anote que gastei 50 reais hoje')).toBeNull();
    expect(expenseSummaryPeriodForChannel('Mostre minhas compras recentes')).toBeNull();
  });

  it('consulta o resumo mensal no banco e formata em pt-BR', async () => {
    const response = await tryExpenseSummaryChannelReply(message, 'default');

    expect(mockExpense).toHaveBeenCalledWith(
      'expense_summary',
      { period: 'this_month' },
      'default'
    );
    expect(response).toContain('R$ 50,00');
    expect(response).toContain('neste mês');
    expect(response).toContain('*Lançamentos:* 1');
  });

  it('mantém moedas diferentes separadas', async () => {
    mockExpense.mockResolvedValueOnce({
      success: true,
      result: { count: 2, byCurrency: { BRL: 50, USD: 10 } },
    });

    const response = await tryExpenseSummaryChannelReply(message, 'default');

    expect(response).toContain('R$ 50,00');
    expect(response).toContain('US$ 10,00');
    expect(response).toContain('sem conversão');
  });

  it('não expõe erro interno nem afirma sucesso se o banco falhar', async () => {
    mockExpense.mockResolvedValueOnce({ success: false, error: 'password leaked in DB error' });

    const response = await tryExpenseSummaryChannelReply(message, 'default');

    expect(response).toBe(
      'Não consegui consultar seus gastos agora. Nenhum registro foi alterado.'
    );
    expect(response).not.toContain('password');
  });

  it.each(['channel.whatsapp', 'channel.telegram'])(
    'intercepta a consulta no fluxo %s antes do provedor de IA',
    async (channelPluginId) => {
      const bus = { process: vi.fn() };
      const response = await processViaBus(
        bus as never,
        {
          ...message,
          channelPluginId,
          platform: channelPluginId.split('.')[1],
          attachments: [],
        } as never,
        { sessionId: 'session-1', conversationId: null },
        { ownpilotUserId: 'default' },
        {
          sessionsRepo: {} as never,
          getChannel: () => undefined,
          isAccessAllowed: async () => true,
        }
      );

      expect(response).toContain('R$ 50,00');
      expect(bus.process).not.toHaveBeenCalled();
    }
  );

  it.each(['channel.whatsapp', 'channel.telegram'])(
    'também intercepta a consulta no fallback legado %s',
    async (channelPluginId) => {
      const response = await processDirectAgent(
        {
          ...message,
          channelPluginId,
          platform: channelPluginId.split('.')[1],
          attachments: [],
        } as never,
        'default',
        async () => true
      );

      expect(response).toContain('R$ 50,00');
    }
  );
});

describe('Agendamento direto e gratuito pelo canal', () => {
  const message = {
    id: 'incoming-1',
    channelPluginId: 'channel.telegram',
    platformChatId: 'chat-123',
    text: 'Me lembre em 1 minuto pra jogar o lixo fora',
  };

  beforeEach(() => {
    mockSchedule.mockReset();
    mockSchedule.mockResolvedValue({
      success: true,
      result: { status: 'pending', title: 'jogar o lixo fora', horarioLocal: '11/11/2026, 10:01' },
    });
  });

  it('registra lembrete de 1 minuto sem chamar modelo', async () => {
    const response = await tryScheduleRelativeChannelReminder(message, 'default');
    expect(response).toContain('11/11/2026, 10:01');
    expect(response).toContain('jogar o lixo fora');
    expect(mockSchedule).toHaveBeenCalledWith(
      'schedule_channel_reminder',
      { title: 'jogar o lixo fora', delay_seconds: 60 },
      'default'
    );
  });

  it('agenda exatamente o pedido de 20 segundos do print sem pedir conversão', async () => {
    mockSchedule.mockResolvedValueOnce({
      success: true,
      result: { status: 'pending', title: 'vê o pc', horarioLocal: '11/11/2026, 10:05:20' },
    });
    const response = await tryScheduleRelativeChannelReminder(
      { ...message, text: 'Me lembre daqui 20 segundos pra vê o pc' },
      'default'
    );
    expect(response).toContain('✅ *Lembrete agendado*');
    expect(response).toContain('• *Assunto:* vê o pc');
    expect(response).toContain('10:05:20');
    expect(mockSchedule).toHaveBeenCalledWith(
      'schedule_channel_reminder',
      { title: 'vê o pc', delay_seconds: 20 },
      'default'
    );
    expect(response).not.toMatch(/quantos minutos|intervalo em minutos/);
  });

  it.each(['bus', 'direct'] as const)(
    'encaminha o pedido em segundos diretamente para persistência pelo fluxo %s',
    async (path) => {
      const input = {
        ...message,
        platform: 'whatsapp' as const,
        channelPluginId: 'channel.whatsapp',
        text: 'Me lembre daqui 20 segundos pra vê o pc',
        timestamp: new Date('2026-11-11T14:05:00Z'),
        attachments: [],
      };
      mockSchedule.mockResolvedValueOnce({
        success: true,
        result: { status: 'pending', title: 'vê o pc', horarioLocal: '11/11/2026, 10:05:20' },
      });
      const bus = { process: vi.fn() };
      const response =
        path === 'bus'
          ? await processViaBus(
              bus as never,
              input as never,
              { sessionId: 'seconds-session', conversationId: null },
              { ownpilotUserId: 'default' },
              {
                sessionsRepo: {} as never,
                getChannel: () => undefined,
                isAccessAllowed: async () => true,
              }
            )
          : await processDirectAgent(input as never, 'default', async () => true);
      expect(response).toContain('✅ *Lembrete agendado*');
      expect(response).toContain('10:05:20');
      expect(mockSchedule).toHaveBeenCalledExactlyOnceWith(
        'schedule_channel_reminder',
        { title: 'vê o pc', delay_seconds: 20 },
        'default'
      );
      expect(bus.process).not.toHaveBeenCalled();
    }
  );

  it.each(['bus', 'direct'] as const)(
    'mantém a verificação de acesso para o pedido em segundos no fluxo %s',
    async (path) => {
      const input = {
        ...message,
        platform: 'whatsapp' as const,
        text: 'Me lembre daqui 20 segundos pra vê o pc',
        attachments: [],
      };
      const bus = { process: vi.fn() };
      const response =
        path === 'bus'
          ? await processViaBus(
              bus as never,
              input as never,
              { sessionId: 'seconds-session', conversationId: null },
              { ownpilotUserId: 'default' },
              {
                sessionsRepo: {} as never,
                getChannel: () => undefined,
                isAccessAllowed: async () => false,
              }
            )
          : await processDirectAgent(input as never, 'default', async () => false);
      expect(response).toContain('inativo');
      expect(mockSchedule).not.toHaveBeenCalled();
      expect(bus.process).not.toHaveBeenCalled();
    }
  );

  it('preserva minutos e segundos combinados e recusa prazo zero antes de gravar', async () => {
    await tryScheduleRelativeChannelReminder(
      { ...message, text: 'Me lembre daqui 1 minuto e 20 segundos pra olhar o pc' },
      'default'
    );
    expect(mockSchedule).toHaveBeenCalledWith(
      'schedule_channel_reminder',
      { title: 'olhar o pc', delay_seconds: 80 },
      'default'
    );
    mockSchedule.mockClear();
    const invalid = await tryScheduleRelativeChannelReminder(
      { ...message, text: 'Me lembre daqui 0 segundos pra olhar o pc' },
      'default'
    );
    expect(invalid).toBeTruthy();
    expect(invalid).not.toMatch(/agendado|salvo/);
    expect(mockSchedule).not.toHaveBeenCalled();
  });

  it('interpreta horas relativas e preserva o prazo', async () => {
    mockSchedule.mockResolvedValueOnce({
      success: true,
      result: {
        status: 'pending',
        title: 'ligar para o dentista',
        horarioLocal: '11/11/2026, 12:00',
      },
    });
    const response = await tryScheduleRelativeChannelReminder(
      { ...message, text: 'Me avise daqui a 2 horas de ligar para o dentista' },
      'default'
    );
    expect(response).toContain('11/11/2026, 12:00');
    expect(mockSchedule).toHaveBeenCalledWith(
      'schedule_channel_reminder',
      { title: 'ligar para o dentista', delay_seconds: 7200 },
      'default'
    );
  });

  it('confirma o horário salvo sem reiniciar o prazo após espera na fila', async () => {
    const response = await tryScheduleRelativeChannelReminder(
      {
        ...message,
        timestamp: new Date('2026-11-11T14:00:00Z'),
      },
      'default'
    );
    expect(response).toContain('10:01');
    expect(response).not.toContain('daqui');
  });

  it('não agenda pedidos vagos nem compromissos sem horário', async () => {
    for (const text of [
      'Amanhã tenho dentista',
      'Me lembre de ir ao dentista amanhã',
      'Quanto eu gastei hoje?',
      'Me avise daqui a pouco',
    ]) {
      expect(await tryScheduleRelativeChannelReminder({ ...message, text }, 'default')).toBeNull();
    }
    expect(mockSchedule).not.toHaveBeenCalled();
  });

  it('não promete notificação quando o registro falhar', async () => {
    mockSchedule.mockResolvedValueOnce({ success: false, error: 'DB indisponível' });
    const response = await tryScheduleRelativeChannelReminder(message, 'default');
    expect(response).toContain('Nenhum aviso foi confirmado');
    expect(response).not.toContain('DB');
  });

  it.each([
    ['delivered', 'Lembrete enviado'],
    ['cancelled', 'Lembrete cancelado'],
    ['failed', 'Lembrete não enviado'],
    ['sending', 'Lembrete em envio'],
  ])(
    'apresenta o estado persistido %s quando recebe o mesmo evento novamente',
    async (status, title) => {
      mockSchedule.mockResolvedValueOnce({
        success: true,
        result: { status, title: 'Assunto salvo', horarioLocal: '11/11/2026, 10:05:20' },
      });
      const response = await tryScheduleRelativeChannelReminder(message, 'default');
      expect(response).toContain(title);
      expect(response).toContain('Assunto salvo');
      expect(response).toContain('10:05:20');
      expect(response).not.toMatch(/Vou avisar|Lembrete agendado/);
    }
  );
});
