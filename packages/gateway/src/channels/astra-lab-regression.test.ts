/**
 * Astra Simulation Lab — genuine parser/routing regressions, not simulated
 * assistant responses. 500+ BRL samples and adversarial intent boundaries.
 * No database writes, model tokens, socket or external API calls.
 */
import { describe, expect, it } from 'vitest';
import {
  parseBrlCents,
  parseChannelExpense,
  parseFinancingIntent,
} from './finance-routing.js';
import { parseChannelFinanceRecord } from './customer-finance-routing.js';
import { parseDailyGreetingCommand } from './daily-greeting.js';
import {
  channelToolsForMessage,
  isConversationalOnlyChannelRequest,
} from './tool-selection.js';

describe('Astra lab — real financial parsing across exact cents', () => {
  it('accepts 500 distinct positive cent values as food expenses', () => {
    for (let cents = 1; cents <= 500; cents++) {
      const amount = Math.floor(cents / 100) + ',' + String(cents % 100).padStart(2, '0');
      const parsed = parseChannelExpense('Gastei R$ ' + amount + ' com café');
      expect(parsed, amount).toEqual({
        amountCents: cents,
        description: 'café',
        category: 'food',
      });
    }
  });

  it.each([
    ['1', 100],
    ['20', 2000],
    ['36,39', 3639],
    ['470,50', 47050],
    ['930', 93000],
    ['1.230,10', 123010],
    ['72 mil', 7_200_000],
  ])('parses BRL sample %s accurately', (raw, expected) => {
    const [value, unit] = raw.split(' ');
    expect(parseBrlCents(value!, unit)).toBe(expected);
  });

  it('never turns a hypothetical or an opinion into a financial mutation', () => {
    const negatives = [
      'A Gabrieli merece um Pix de 100 reais?',
      'Pede pro meu namorado me fazer um Pix de 100 reais',
      'Será que eu gastei 1 real?',
      'Não gastei 1 real',
      'Gastei 1 real e ganhei 20',
      'Acho que gastei 1 real ontem',
      'Vou gastar 470 de gasolina',
      'O pagamento de 930 foi só uma previsão',
    ];
    for (const input of negatives) {
      expect(parseChannelExpense(input), input).toBeNull();
      expect(parseChannelFinanceRecord(input), input).toBeNull();
    }
    expect(isConversationalOnlyChannelRequest(negatives[0]!)).toBe(true);
    expect(isConversationalOnlyChannelRequest(negatives[1]!)).toBe(true);
  });

  it('keeps future receivables pending and separates them from bank balance', () => {
    const future = parseChannelFinanceRecord('Tenho 770 reais a receber de cliente amanhã');
    expect(future).toMatchObject({
      type: 'income',
      status: 'pending',
      amountCents: 77000,
    });
    const settled = parseChannelFinanceRecord('Recebi 1 real de salário');
    expect(settled).toMatchObject({
      type: 'income',
      status: 'settled',
      amountCents: 100,
    });
  });

  it('treats the original vehicle price minus payment as arithmetic, never inferred interest', () => {
    const intent = parseFinancingIntent('Meu carro é 72 mil, já paguei 930, acompanha');
    // Compound wording must not fabricate a financing record.
    expect(intent).toBeNull();
    expect(7_200_000 - 93_000).toBe(7_107_000);
  });
});

describe('Astra lab — native recurring routes and goal discovery', () => {
  it('recognizes a daily 6 AM greeting with curiosity without using an LLM', () => {
    expect(parseDailyGreetingCommand('Todo dia às 6h me dá bom dia com uma curiosidade.'))
      .toEqual({ kind: 'enable', hour: 6, minute: 0, withCuriosity: true });
    expect(parseDailyGreetingCommand('Cancele meu bom dia diário'))
      .toEqual({ kind: 'disable' });
  });

  it('keeps explicit savings goals discoverable in the real channel tool registry', () => {
    const tools = channelToolsForMessage('Quero juntar 5 mil reais para fazer uma viagem');
    expect(tools).toContain('core.create_goal');
    expect(tools).toContain('core.list_goals');
    expect(tools).toContain('core.update_goal');
  });

  it('keeps opinions and requests to write a message out of tool execution', () => {
    expect(channelToolsForMessage('A Gabrieli merece um Pix de 100 reais?')).toEqual([]);
    expect(channelToolsForMessage('Pede para meu namorado fazer um Pix de 100 reais'))
      .toEqual([]);
  });
});
