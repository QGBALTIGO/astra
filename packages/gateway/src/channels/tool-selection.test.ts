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

  it.each(['Quero uma receita de bolo', 'Uma receita com frango', 'Receita de sobremesa'])(
    'does not mistake cooking for financial income: %s',
    (text) => expect(channelToolsForMessage(text)).toEqual([])
  );

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
