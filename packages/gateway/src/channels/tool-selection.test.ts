import { describe, expect, it } from 'vitest';
import { channelToolsForMessage, recentChannelText } from './tool-selection.js';

const financeTools = [
  'core.record_transaction',
  'core.list_transactions',
  'core.update_transaction',
  'core.delete_transaction',
  'core.financial_summary',
];

describe('channel finance tool selection', () => {
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
