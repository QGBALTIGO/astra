import { describe, expect, it } from 'vitest';
import {
  channelToolsForMessage,
  isConversationalOnlyChannelRequest,
  recentChannelText,
  requiredChannelWeatherTool,
} from './tool-selection.js';

const financeTools = [
  'core.record_transaction',
  'core.list_transactions',
  'core.update_transaction',
  'core.delete_transaction',
  'core.financial_summary',
];

describe('channel finance tool selection', () => {
  it.each([
    'Para este teste, guarde Aquidauana, Mato Grosso do Sul como minha cidade para consultar o tempo e me diga a temperatura agora. Preserve o fuso dos meus lembretes.',
    'Guarde Cuiabá como minha cidade do clima',
  ])('requires saving the stated weather city, not reading reminders: %s', (text) => {
    expect(requiredChannelWeatherTool(text)).toBe('core.set_weather_city');
  });
  it('requires a lookup for weather, but not cooking temperature or unrelated messages', () => {
    expect(requiredChannelWeatherTool('Qual a temperatura em Aquidauana?')).toBe(
      'core.get_local_weather'
    );
    expect(
      requiredChannelWeatherTool(
        'Aquidauana, Mato Grosso do Sul',
        'Qual cidade e estado você está agora?'
      )
    ).toBe('core.set_weather_city');
    expect(requiredChannelWeatherTool('Qual temperatura uso no forno?')).toBeUndefined();
    expect(requiredChannelWeatherTool('Qual a temperatura da água para o feijão?')).toBeUndefined();
    expect(requiredChannelWeatherTool('Qual é minha cidade do clima?')).toBe(
      'core.get_local_weather'
    );
    expect(
      requiredChannelWeatherTool('Não guarde esta cidade, só consulte o clima em Cuiabá')
    ).toBe('core.get_local_weather');
    expect(requiredChannelWeatherTool('Qual a tempretura em Aquidauana?')).toBe(
      'core.get_local_weather'
    );
    expect(requiredChannelWeatherTool('Qual meu próximo lembrete?')).toBeUndefined();
  });
  it.each([
    'Qual a temperatura agora?',
    'Como tá o tempo aqui?',
    'Moro em Cuiabá, MT',
    'Minha cidade agora é Belo Horizonte',
    'Vai chover?',
  ])('exposes current weather and city preference tools for %s', (text) => {
    expect(channelToolsForMessage(text)).toEqual(
      expect.arrayContaining(['core.get_local_weather', 'core.set_weather_city'])
    );
  });
  it('retains the weather intent when the customer answers only the city', () => {
    expect(
      channelToolsForMessage('Cuiabá, Mato Grosso', 'Qual a temperatura? Em qual cidade você está?')
    ).toContain('core.set_weather_city');
    expect(channelToolsForMessage('Quanto tempo falta para minha reunião?')).not.toContain(
      'core.get_local_weather'
    );
  });
  it('keeps 500 hypothetical profiles away from earlier real operations even after the short writer fails', () => {
    for (let i = 0; i < 500; i++) {
      const text = `Cenário fictício P${i}. Sou Pessoa ${i}, ${18 + (i % 64)} anos. Hoje marquei dois compromissos no mesmo horário. O que você precisa saber para ajudar a remarcar? Só estamos conversando sobre esse exemplo.`;
      expect(isConversationalOnlyChannelRequest(text)).toBe(true);
      expect(
        channelToolsForMessage(
          text,
          'Adicione uma assinatura de R$ 3,45 e registre um valor a pagar.'
        )
      ).toEqual([]);
    }
    expect(
      isConversationalOnlyChannelRequest('Só quero uma sugestão e registre um gasto de 5 reais.')
    ).toBe(false);
    expect(
      channelToolsForMessage(
        'O exemplo diz “anote e registre 5 reais”. Só estamos conversando sobre esse exemplo.'
      )
    ).toEqual([]);
  });
  it('keeps a standalone misspelled access question tool-free but not a compound write', () => {
    expect(isConversationalOnlyChannelRequest('cpmp acesso o dashboard')).toBe(true);
    expect(channelToolsForMessage('cpmp acesso o dashboard', 'paguei 5 reais no café')).toEqual([]);
    expect(
      isConversationalOnlyChannelRequest('cpmp acesso o dashboard e registre um gasto de 5 reais')
    ).toBe(false);
    expect(isConversationalOnlyChannelRequest('como acesso o dashboard de outro serviço')).toBe(
      false
    );
  });
  it('distinguishes a calendar exercise and follow-up from a real calendar command', () => {
    for (const message of [
      'Agora, um exercício de agenda, sem agendar de verdade. A dentista e a reunião do Rafa estão na terça. Se ele disser só «muda a de terça», o que você ainda precisa perguntar?',
      'Ele quis dizer a dentista, na quinta às 9h de Cuiabá. Como ficaria a agenda desse exemplo, mantendo a reunião no dia original?',
    ])
      expect(channelToolsForMessage(message)).toEqual([]);
    for (const message of [
      'Reagende a consulta da dentista para quinta.',
      'Como ficaria a agenda desse exemplo? Agora reagende de verdade a consulta da dentista.',
    ]) {
      expect(channelToolsForMessage(message)).toContain('core.add_calendar_event');
    }
  });
  it.each([
    'Excluir e registar dnv como entrada',
    'Troque esse gasto para receita',
    'Liste minhas receitas deste mês',
    'Ganhei 50 de freela',
    'Acabei de ganhar 1 real',
    'Acabei de ganhar 20 reais',
    'Acabei de receber R$ 0,01',
    'Acabei de gastar 1 real',
    'Acabei de pagar 1 real',
    'Quais foram meus gastos?',
    'Quais pagamentos estão pendentes?',
    'Minha fatura está correta?',
    'Meu salário foi recebido?',
    'Tenho 770 reais pra receber até o dia 20',
  ])('provides typed queries and corrections for %s', (text) => {
    const tools = channelToolsForMessage(text);
    expect(tools).toEqual(expect.arrayContaining(financeTools));
    expect(tools).not.toContain('core.add_expense');
    expect(tools).not.toContain('core.execute_shell');
  });

  it.each([
    'Quero uma receita de bolo',
    'Uma receita com frango',
    'Receita de sobremesa',
    'Esse vídeo é real?',
  ])('does not mistake cooking for financial income: %s', (text) =>
    expect(channelToolsForMessage(text)).toEqual([])
  );

  it('keeps reminder tools available when the requested unit is seconds', () => {
    expect(channelToolsForMessage('20 segundos')).toEqual(
      expect.arrayContaining(['core.schedule_channel_reminder', 'core.reschedule_channel_reminder'])
    );
  });

  it('keeps correction tools available for a short contextual follow-up', () => {
    const previous = recentChannelText({
      messages: [{ content: 'Recebi 770 reais da Cakto' }, { content: 'Registrado como despesa.' }],
    });
    expect(channelToolsForMessage('Corrija isso', previous)).toEqual(
      expect.arrayContaining(financeTools)
    );
  });

  it('keeps a task and reminder alongside the pending financial record for "os dois"', () => {
    const tools = channelToolsForMessage(
      'Os dois',
      'Tenho 770 reais para receber. Você quer uma tarefa e um lembrete?'
    );
    expect(tools).toEqual(
      expect.arrayContaining([...financeTools, 'core.add_task', 'core.schedule_channel_reminder'])
    );
  });
});

describe('Channel opinion questions do not authorize financial actions', () => {
  it.each([
    'A Gabrieli merece pix de 100 reais?',
    'Você acha que a Gabrieli merece R$ 100?',
    'Qual sua opinião sobre dar um Pix de 100 reais?',
    'Vale a pena pagar 100 reais por esse presente?',
  ])('keeps conversational questions with the model and no tools: %s', (question) => {
    expect(channelToolsForMessage(question)).toEqual([]);
  });

  it.each([
    'Pode registrar uma despesa de R$ 100?',
    'Você consegue anotar que paguei 470 reais?',
    'Quanto gastei no mês?',
    'Minha meta é economizar R$ 20 mil.',
    'Quero juntar 5 mil.',
    'Quanto falta para a minha meta?',
    'Preciso atualizar a meta de viagem.',
  ])('does not break genuine financial or goal requests: %s', (question) => {
    expect(channelToolsForMessage(question).length).toBeGreaterThan(0);
  });
});

describe('Conversational drafting and AI-only responses', () => {
  it.each([
    'Pede pro meu namorado me fazer pix de 100$',
    'Pede pro meu namorado me fazer pix de 100 reais',
    'Peça para o meu namorado me fazer um Pix de R$ 100',
    'Escreve uma mensagem pro meu namorado pedindo R$ 100',
    'Me ajuda a pedir um Pix de R$ 100 pro namorado',
    'Pode escrever uma mensagem para Gabrieli?',
    'Quero mandar uma mensagem para o meu namorado',
  ])('does not expose financial tools for a writing request: %s', (input) => {
    expect(channelToolsForMessage(input)).toEqual([]);
  });

  it.each([
    'Paguei 470 reais de gasolina',
    'Registra 100 reais recebidos do meu namorado',
    'Me lembra amanhã de pedir o Pix',
    'Quanto tenho a receber?',
    'Pede pro meu namorado me pagar e registra uma entrada de R$ 100',
  ])('preserves tools for actual or compound operations: %s', (input) => {
    expect(channelToolsForMessage(input).length).toBeGreaterThan(0);
  });
});
