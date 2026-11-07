import { beforeEach, describe, expect, it, vi } from 'vitest';

const mockSchedule = vi.hoisted(() => vi.fn());
vi.mock('../tools/channel-reminder-tools.js', () => ({
  executeChannelReminderTool: mockSchedule,
}));

import {
  deterministicChannelReply,
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
