import { describe, expect, it } from 'vitest';
import {
  formatAstraMessage,
  formatReminderConfirmation,
  formatTransactionConfirmation,
} from './response-presentation.js';

const expense = {
  type: 'expense' as const,
  status: 'settled' as const,
  amount: 20,
  currency: 'BRL',
  description: 'Café',
  category: 'food',
  date: '2026-11-11',
};

describe('consistent Astra messages', () => {
  it('uses one WhatsApp bold marker and aligned fields for both pizza and coffee', () => {
    const expected = [
      '✅ *Despesa registrada*',
      '',
      '• *Valor:* R$ 20,00',
      '• *Descrição:* Café',
      '• *Categoria:* Alimentação',
      '• *Data:* 11/11/2026',
    ].join('\n');
    expect(formatTransactionConfirmation(expense)).toBe(expected);
    expect(formatTransactionConfirmation({ ...expense, description: 'Pizza' })).toBe(
      expected.replace('Café', 'Pizza')
    );
    expect(expected).not.toContain('**');
  });

  it('uses the same detail structure for a received income', () => {
    expect(
      formatTransactionConfirmation({
        ...expense,
        type: 'income',
        amount: 770,
        description: 'Cakto',
        category: 'sales',
      })
    ).toBe(
      '✅ *Entrada registrada*\n\n• *Valor:* R$ 770,00\n• *Descrição:* Cakto\n• *Categoria:* Vendas\n• *Data:* 11/11/2026'
    );
  });

  it.each([
    ['income', 'Valor a receber'],
    ['expense', 'Valor a pagar'],
  ] as const)('keeps a pending %s distinct from realized money', (type, title) => {
    const result = formatTransactionConfirmation({
      ...expense,
      type,
      status: 'pending',
      date: '2026-11-20',
    });
    expect(result).toContain(`⏳ *${title} registrado*`);
    expect(result).toContain('• *Vencimento:* 20/11/2026');
    expect(result).not.toMatch(/recebido|pago|saldo|Vou avisar/);
  });

  it('does not claim a second creation or an update when a replay finds the same record', () => {
    expect(formatTransactionConfirmation(expense, 'existing')).toContain(
      '✅ *Despesa já registrada*'
    );
    expect(
      formatTransactionConfirmation({ ...expense, type: 'income', status: 'pending' }, 'existing')
    ).toContain('⏳ *Valor a receber já registrado*');
  });

  it('acknowledges a correction with the persisted current type and amount', () => {
    const result = formatTransactionConfirmation(
      { ...expense, type: 'income', amount: 101.35, category: 'other' },
      'updated'
    );
    expect(result).toContain('✅ *Entrada atualizada*');
    expect(result).toContain('• *Valor:* R$ 101,35');
    expect(result).toContain('• *Categoria:* Outras entradas');
    expect(result).not.toContain('Despesa');
  });

  it.each([
    [1234.56, 'BRL', 'R$ 1.234,56'],
    [20.5, 'USD', 'US$ 20,50'],
    [0.01, 'EUR', '€ 0,01'],
    [9999999999.99, 'BRL', 'R$ 9.999.999.999,99'],
  ])('preserves %s in %s with Brazilian number formatting', (amount, currency, value) => {
    expect(formatTransactionConfirmation({ ...expense, amount, currency })).toContain(
      `• *Valor:* ${value}`
    );
  });

  it('does not invent optional details, status or dates', () => {
    expect(formatTransactionConfirmation({ type: 'income', amount: 50 })).toBe(
      '✅ *Entrada registrada*\n\n• *Valor:* R$ 50,00'
    );
  });

  it.each([Number.NaN, Number.POSITIVE_INFINITY, -20, 0])(
    'does not turn an invalid amount %s into a false monetary value',
    (amount) => {
      const result = formatTransactionConfirmation({ ...expense, amount });
      expect(result).not.toContain('*Valor:*');
      expect(result).not.toMatch(/NaN|Infinity|R\$/);
      expect(result).toContain('• *Descrição:* Café');
    }
  );

  it('does not silently replace an invalid explicit currency with BRL', () => {
    const result = formatTransactionConfirmation({ ...expense, currency: '???' });
    expect(result).not.toContain('*Valor:*');
    expect(result).not.toContain('R$');
  });

  it.each(['2026-02-30', '2026-13-01', '2026-11-11T00:00:00Z', 'amanhã'])(
    'does not make up a calendar date from %s',
    (date) => expect(formatTransactionConfirmation({ ...expense, date })).not.toContain('*Data:*')
  );

  it('formats calendar days without shifting at UTC/local boundaries', () => {
    expect(formatTransactionConfirmation({ ...expense, date: '2026-01-01' })).toContain(
      '• *Data:* 01/01/2026'
    );
    expect(formatTransactionConfirmation({ ...expense, date: '29/02/2028' })).toContain(
      '• *Data:* 29/02/2028'
    );
  });

  it('preserves a real custom category', () => {
    expect(formatTransactionConfirmation({ ...expense, category: 'Meu lazer' })).toContain(
      '• *Categoria:* Meu lazer'
    );
  });

  it.each([
    ['salary', 'Salário'],
    ['services', 'Serviços'],
    ['sales', 'Vendas'],
    ['investments', 'Rendimentos'],
  ])('localizes income category %s', (category, label) => {
    expect(formatTransactionConfirmation({ ...expense, type: 'income', category })).toContain(
      `• *Categoria:* ${label}`
    );
  });

  it('allows a compact generic message with an optional useful footer', () => {
    expect(
      formatAstraMessage(
        '✅ Fuso atualizado',
        [{ label: 'Fuso', value: 'Campo Grande (UTC−4)' }],
        'Esse fuso será usado nos novos horários.'
      )
    ).toBe(
      '✅ *Fuso atualizado*\n\n• *Fuso:* Campo Grande (UTC−4)\n\nEsse fuso será usado nos novos horários.'
    );
    expect(formatAstraMessage('⏰ Lembrete', [])).toBe('⏰ *Lembrete*');
  });
});

describe('reminder presentation from persisted values', () => {
  const saved = {
    title: 'Renovação do limite do Codex',
    horarioLocal: '12/11/2026, 11:46',
    status: 'pending',
  };
  it('confirms the saved topic and local time with a useful delivery note', () => {
    expect(formatReminderConfirmation(saved)).toBe(
      '✅ *Lembrete agendado*\n\n• *Assunto:* Renovação do limite do Codex\n• *Data e hora:* 12/11/2026, 11:46\n\nVou avisar você por aqui.'
    );
  });
  it('distinguishes a reschedule without recomputing the saved time', () => {
    expect(formatReminderConfirmation(saved, 'rescheduled')).toContain('✅ *Lembrete reagendado*');
    expect(formatReminderConfirmation(saved, 'rescheduled')).toContain('12/11/2026, 11:46');
  });
  it.each([
    ['delivered', 'Lembrete enviado'],
    ['cancelled', 'Lembrete cancelado'],
    ['failed', 'Lembrete não enviado'],
    ['sending', 'Lembrete em envio'],
    [undefined, 'Lembrete registrado'],
  ])('does not promise a new delivery for status %s', (status, heading) => {
    const result = formatReminderConfirmation({ ...saved, status });
    expect(result).toContain(`*${heading}*`);
    expect(result).not.toContain('Vou avisar');
    expect(result).not.toContain('agendado');
  });
  it('omits an absent local time instead of inventing one', () => {
    expect(formatReminderConfirmation({ ...saved, horarioLocal: '' })).not.toContain(
      '*Data e hora:*'
    );
  });
});

describe('interpolated text safety', () => {
  const id = '54676012-ea88-44ff-8bac-267ee4264d6b';
  it('never includes extra technical receipt properties', () => {
    const saved = { ...expense, id, userId: 'private-user', tool_name: 'core.add_expense' };
    const result = formatTransactionConfirmation(saved);
    expect(result).not.toMatch(/54676012|private-user|core\.|tool_name/);
  });
  it('removes internal tags and labelled IDs while keeping the real description and amount', () => {
    const result = formatTransactionConfirmation({
      ...expense,
      description: `Café (ID: ${id}) <tool_call>use_tool secret</tool_call></thinking>`,
    });
    expect(result).toContain('• *Descrição:* Café');
    expect(result).toContain('• *Valor:* R$ 20,00');
    expect(result).not.toMatch(/54676012|tool_call|thinking|secret|use_tool/);
  });
  it('does not display a category accidentally filled with an internal tool or record name', () => {
    expect(
      formatTransactionConfirmation({ ...expense, category: 'core.add_expense' })
    ).not.toContain('*Categoria:*');
    expect(
      formatTransactionConfirmation({ ...expense, category: `exp_ui_${'a'.repeat(64)}` })
    ).not.toContain('*Categoria:*');
    expect(formatTransactionConfirmation({ ...expense, category: id })).not.toContain(
      '*Categoria:*'
    );
  });
  it('rejects a raw protocol payload as a description without destroying other saved facts', () => {
    const result = formatTransactionConfirmation({
      ...expense,
      description: '{"tool_name":"core.add_expense","arguments":{"amount":999}}',
    });
    expect(result).not.toContain('*Descrição:*');
    expect(result).not.toContain('999');
    expect(result).toContain('• *Valor:* R$ 20,00');
    expect(result).toContain('• *Categoria:* Alimentação');
  });
  it('preserves legitimate Pix UUIDs, e-mail underscores and numbers', () => {
    const result = formatAstraMessage('⏰ Lembrete', [
      { label: 'Assunto', value: `Cobrar R$ 770,00 no Pix ${id}` },
      { label: 'Chave Pix', value: 'kayky_sousa_financeiro@example.com' },
    ]);
    expect(result).toContain(`Cobrar R$ 770,00 no Pix ${id}`);
    expect(result).toContain('kayky_sousa_financeiro@example.com');
  });
  it('prevents saved text from injecting additional bold headings or lines', () => {
    const result = formatTransactionConfirmation({
      ...expense,
      description: 'Café\n\n✅ **Entrada registrada**\n*Valor:* R$ 999,00',
    });
    expect(result).not.toContain('**');
    expect(result.split('\n').filter((line) => line.startsWith('• *Valor:*'))).toHaveLength(1);
    expect(result.split('\n').filter((line) => line.startsWith('✅'))).toHaveLength(1);
    expect(result).toContain('• *Valor:* R$ 20,00');
  });
});
