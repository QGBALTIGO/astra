import { beforeEach, describe, expect, it, vi } from 'vitest';

const mockSchedule = vi.hoisted(() => vi.fn());
const mockExpenseTool = vi.hoisted(() => vi.fn());
const mockFinancePermission = vi.hoisted(() => vi.fn());
vi.mock('../tools/channel-reminder-tools.js', () => ({
  executeChannelReminderTool: mockSchedule,
}));
vi.mock('../tools/expense-tools.js', () => ({
  executeExpenseTool: mockExpenseTool,
}));
vi.mock('../services/tool/permission.js', () => ({
  checkToolPermission: mockFinancePermission,
}));

import {
  deterministicChannelReply,
  tryAnswerRecordedExpenses,
  tryScheduleRelativeChannelReminder,
} from './channel-ai-routing.js';

describe('Astra respostas gratuitas e instantâneas', () => {
  it.each(['oi', 'Oi', 'OLÁ!', 'ola...', 'Bom dia!', 'Boa tarde', 'Boa noite?'])(
    'responde saudação %s sem usar o modelo',
    (message) => {
      expect(deterministicChannelReply(message)).toBe('Oi! Como posso ajudar você hoje?');
    }
  );

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
      result: { status: 'pending' },
    });
  });

  it('registra lembrete de 1 minuto sem chamar modelo', async () => {
    const response = await tryScheduleRelativeChannelReminder(message, 'default');
    expect(response).toContain('daqui a 1 minuto');
    expect(response).toContain('jogar o lixo fora');
    expect(mockSchedule).toHaveBeenCalledWith(
      'schedule_channel_reminder',
      { title: 'jogar o lixo fora', delay_minutes: 1 },
      'default'
    );
  });

  it('interpreta horas relativas e preserva o prazo', async () => {
    const response = await tryScheduleRelativeChannelReminder(
      { ...message, text: 'Me avise daqui a 2 horas de ligar para o dentista' },
      'default'
    );
    expect(response).toContain('daqui a 2 horas');
    expect(mockSchedule).toHaveBeenCalledWith(
      'schedule_channel_reminder',
      { title: 'ligar para o dentista', delay_minutes: 120 },
      'default'
    );
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

  it('reconhece duplicidade de lembrete em retries do mesmo evento', async () => {
    mockSchedule.mockResolvedValueOnce({
      success: true,
      result: { status: 'delivered' },
    });
    const response = await tryScheduleRelativeChannelReminder(message, 'default');
    expect(response).toContain('já estava registrado');
  });
});

describe('Consultas financeiras reais, sem IA', () => {
  beforeEach(() => {
    mockExpenseTool.mockReset();
    mockFinancePermission.mockReset();
    mockFinancePermission.mockResolvedValue({ allowed: true });
    mockExpenseTool.mockResolvedValue({
      success: true,
      result: { period: 'this_month', count: 2, totalAmount: 50, byCurrency: { BRL: 50 } },
    });
  });

  it.each([
    ['Quanto gastei esse mês?', 'this_month'],
    ['Quanto eu gastei neste mês', 'this_month'],
    ['Quanto já gastei hoje?', 'today'],
    ['Quanto gastei mês passado?', 'last_month'],
    ['Quanto gastei nesta semana?', 'this_week'],
  ])('consulta %s usando registros do usuário autenticado', async (text, period) => {
    const response = await tryAnswerRecordedExpenses(text, 'canal-user-1');
    expect(response).toContain('R$');
    expect(response).toContain('50,00');
    expect(mockFinancePermission).toHaveBeenCalledWith('canal-user-1', 'core.expense_summary', {
      source: 'chat',
    });
    expect(mockExpenseTool).toHaveBeenCalledWith('expense_summary', { period }, 'canal-user-1');
  });

  it('diferencia valor dito no chat de lançamento salvo no banco', async () => {
    mockExpenseTool.mockResolvedValueOnce({
      success: true,
      result: { period: 'this_month', count: 0, totalAmount: 0, byCurrency: {} },
    });
    const response = await tryAnswerRecordedExpenses('Quanto gastei esse mês?', 'canal-user-1');
    expect(response).toContain('Não encontrei despesas salvas');
    expect(response).toContain('não entram no total');
  });

  it('não soma BRL e USD sem conversão', async () => {
    mockExpenseTool.mockResolvedValueOnce({
      success: true,
      result: { count: 2, byCurrency: { BRL: 50, USD: 100 } },
    });
    const response = await tryAnswerRecordedExpenses('Quanto gastei esse mês?', 'canal-user-1');
    expect(response).toContain('R$');
    expect(response).toContain('US$');
    expect(response).toContain('Não somei moedas diferentes');
  });

  it('respeita grupo desativado e não expõe despesas', async () => {
    mockFinancePermission.mockResolvedValueOnce({
      allowed: false,
      reason: 'Tool group "Finance" is disabled',
    });
    const response = await tryAnswerRecordedExpenses('Quanto gastei hoje?', 'canal-user-1');
    expect(response).toContain('não foi habilitado');
    expect(mockExpenseTool).not.toHaveBeenCalled();
  });

  it('não inventa totais quando o banco falha', async () => {
    mockExpenseTool.mockResolvedValueOnce({
      success: false,
      error: 'PostgreSQL connection failed',
    });
    const response = await tryAnswerRecordedExpenses('Quanto gastei esse mês?', 'canal-user-1');
    expect(response).toContain('Nenhum total foi calculado');
    expect(response).not.toContain('PostgreSQL');
  });

  it.each(['Gastei 50 reais no almoço', 'Quanto custa uma consulta?', 'Qual foi meu gasto médio?'])(
    'mantém outras perguntas %s no fluxo normal',
    async (question) => {
      expect(await tryAnswerRecordedExpenses(question, 'canal-user-1')).toBeNull();
      expect(mockExpenseTool).not.toHaveBeenCalled();
    }
  );
});
