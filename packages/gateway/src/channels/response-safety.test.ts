import { describe, expect, it } from 'vitest';
import {
  CHANNEL_UNVERIFIED_REPLY,
  safeChannelResponse,
  successfulChannelTools,
  type ChannelToolReceipt,
} from './response-safety.js';
import { formatTransactionConfirmation } from './response-presentation.js';

const id = 'f01834d8-a411-4ed6-947c-d35d410184bb';
const reminder = (status = 'pending'): ChannelToolReceipt => ({
  name: 'core.schedule_channel_reminder',
  arguments: '',
  isError: false,
  content: JSON.stringify({
    success: true,
    result: {
      id,
      title: 'Meu limite do Codex renova',
      agendadoPara: '2026-11-12T15:46:00.000Z',
      horarioLocal: '12/11/2026, 11:46',
      timeZone: 'America/Campo_Grande',
      status,
    },
  }),
});

describe('Channel responses use persisted facts without internal details', () => {
  it('returns an ordinary conversational reply without pretending a Pix was made', () => {
    const natural =
      'Acho que sim — se for um carinho espontâneo e couber no seu orçamento, por que não? 😊';
    expect(safeChannelResponse(natural, [])).toBe(natural);
    expect(safeChannelResponse('Registrei uma entrada de R$ 100.', [])).toBe(
      CHANNEL_UNVERIFIED_REPLY
    );
    expect(CHANNEL_UNVERIFIED_REPLY).not.toMatch(/tool_call|thinking|stack|erro interno|⚠️/i);
  });

  it.each([
    '⚠️ *Não consegui confirmar o pedido*\n\nNão consegui confirmar a execução. Confira seus registros antes de tentar novamente.',
    'Não consegui confirmar a execução. Confira seus registros antes de tentar novamente.',
  ])('does not echo the deprecated error banner from old conversation history', (text) => {
    const cleaned = safeChannelResponse(text, []);
    expect(cleaned).toBe(CHANNEL_UNVERIFIED_REPLY);
    expect(cleaned).not.toContain('Não consegui confirmar o pedido');
    expect(cleaned).not.toContain('Não consegui confirmar a execução');
  });

  it('rebuilds the screenshot UUID acknowledgement from the saved reminder', () => {
    const text = `Lembrete agendado!\nO lembrete foi criado com o ID ${id} e está pendente de envio nesta conversa.`;
    expect(safeChannelResponse(text, [reminder()])).toBe(
      '✅ *Lembrete agendado*\n\n• *Assunto:* Meu limite do Codex renova\n• *Data e hora:* 12/11/2026, 11:46\n\nVou avisar você por aqui.'
    );
  });

  it('does not repeat a clean but incorrect time invented by the model', () => {
    const reply = safeChannelResponse('Lembrete agendado hoje às 22h43.', [reminder()]);
    expect(reply).toContain('12/11/2026, 11:46');
    expect(reply).not.toContain('22h43');
    expect(reply).not.toContain(id);
  });

  it.each(['delivered', 'cancelled'])(
    'does not promise another notification for a %s dedupe result',
    (status) => {
      expect(successfulChannelTools([reminder(status)]).has('schedule_channel_reminder')).toBe(
        false
      );
      const reply = safeChannelResponse(`Lembrete agendado! ID ${id}`, [reminder(status)]);
      expect(reply).toContain('Não criei outro aviso');
      expect(reply).not.toContain('agendado!');
      expect(reply).not.toContain(id);
    }
  );

  it('keeps a financial list useful after removing its ID decorations', () => {
    const receipts: ChannelToolReceipt[] = [
      {
        name: 'core.list_transactions',
        arguments: '',
        isError: false,
        content: JSON.stringify({
          success: true,
          result: [{ id, description: 'Entrada Cakto', amount: 770 }],
        }),
      },
    ];
    expect(safeChannelResponse(`1. Entrada Cakto — R$ 770,00 (ID: ${id})`, receipts)).toBe(
      '1. Entrada Cakto — R$ 770,00'
    );
  });

  it('preserves legitimate numbers, dates and a Pix key unrelated to internal records', () => {
    const text = `Chave Pix: ${id}\nValor: R$ 770,00\nData: 20/11/2026`;
    expect(safeChannelResponse(text, [])).toBe(text);
    const subject = `Lembrete: cobrar pelo Pix ${id} amanhã às 12h.`;
    expect(safeChannelResponse(subject, [])).toBe(subject);
  });

  it('a reassuring negative phrase is not evidence of success', () => {
    expect(safeChannelResponse('Não se preocupe, o lembrete foi criado.', [])).toContain(
      'não tenho uma alteração confirmada'
    );
    expect(safeChannelResponse('Não agendei o lembrete.', [])).toBe('Não agendei o lembrete.');
  });

  it('requires both receipts for a combined plural confirmation', () => {
    const reply = safeChannelResponse('Tarefa e lembrete criados!', [
      { name: 'core.add_task', arguments: '', content: '{"id":"task-12345"}', isError: false },
      {
        name: 'core.schedule_channel_reminder',
        arguments: '',
        content: '{"success":false}',
        isError: true,
      },
    ]);
    expect(reply).toContain('uma tarefa salva');
    expect(reply).toMatch(
      /(?:não tenho confirmação|não tenho uma alteração confirmada|ainda não está confirmada)/i
    );
    expect(reply).not.toContain('um lembrete salvo');
  });

  it.each([
    `Referência do lembrete:\n${id}`,
    `ID: exp_ui_${'a'.repeat(64)}`,
    `O código do lançamento é exp_ui_${'a'.repeat(64)}.`,
  ])('does not expose an older labelled record: %s', (text) => {
    const reply = safeChannelResponse(text, []);
    expect(reply).not.toContain(id);
    expect(reply).not.toContain('exp_ui_');
  });

  it('keeps a confirmed read-only reminder list without its IDs', () => {
    const receipt: ChannelToolReceipt = {
      name: 'core.list_channel_reminders',
      arguments: '',
      isError: false,
      content: JSON.stringify([{ id, title: 'Dentista', status: 'pending' }]),
    };
    expect(
      safeChannelResponse(`Lembretes agendados:\nDentista às 14h (ID: ${id})`, [receipt])
    ).toBe('Lembretes agendados:\nDentista às 14h');
  });

  it.each([
    'Não encontrei core.add_expense.',
    'Use use_tool para continuar.',
    'Você pode usar schedule_channel_reminder.',
    '{"tool_name":"core.schedule_channel_reminder","arguments":{"title":"teste"}}',
  ])('never forwards tool protocol or technical names: %s', (text) => {
    const reply = safeChannelResponse(text, []);
    expect(reply).toMatch(
      /(?:não tenho confirmação|não tenho uma alteração confirmada|ainda não está confirmada)/i
    );
    expect(reply).not.toMatch(/core\.|use_tool|schedule_channel_reminder|arguments/);
  });

  it('does not hide a partial failure behind a successful reminder acknowledgement', () => {
    const reply = safeChannelResponse('Tarefa criada. Lembrete agendado.', [
      reminder(),
      { name: 'core.add_task', arguments: '', content: '{"success":false}', isError: true },
    ]);
    expect(reply).toContain('*Lembrete agendado*');
    expect(reply).toMatch(
      /(?:não tenho confirmação|não tenho uma alteração confirmada|ainda não está confirmada)/i
    );
    expect(reply).not.toContain('uma tarefa salva');
  });

  it('preserves an honest partial-failure notice beside a successful reminder', () => {
    const text = 'Não consegui criar a tarefa. O lembrete foi agendado para 12/11 às 11h46.';
    expect(
      safeChannelResponse(`${text} (ID: ${id})`, [
        reminder(),
        {
          name: 'core.add_task',
          arguments: '',
          content: '{"success":false,"error":"save failed"}',
          isError: true,
        },
      ])
    ).toBe(text);
  });

  it('does not discard another successful operation when confirming a reminder', () => {
    const text = 'Tarefa concluída. Lembrete agendado para 12/11 às 11h46.';
    const reply = safeChannelResponse(text, [
      reminder(),
      {
        name: 'core.complete_task',
        arguments: '',
        content: '{"success":true}',
        isError: false,
      },
    ]);
    expect(reply).toContain('*Tarefa concluída*');
    expect(reply).toContain('*Lembrete agendado*');
    expect(reply).toContain('12/11/2026, 11:46');
    expect(reply).not.toMatch(
      /(?:não tenho confirmação|não tenho uma alteração confirmada|ainda não está confirmada)/i
    );
  });

  it('keeps both reminders and their amounts after removing internal IDs', () => {
    const secondId = '8c6bea07-cf9c-4a47-ad27-513b34115070';
    const second = reminder();
    second.content = JSON.stringify({
      success: true,
      result: {
        id: secondId,
        title: 'Receber R$ 770,00',
        horarioLocal: '20/11/2026, 12:00',
        status: 'pending',
      },
    });
    const reply = safeChannelResponse(
      `Lembretes agendados:\nCodex em 12/11 às 11h46 (ID: ${id})\nReceber R$ 770,00 em 20/11 às 12h (ID: ${secondId})`,
      [reminder(), second]
    );
    expect(reply).toContain('Meu limite do Codex renova');
    expect(reply).toContain('12/11/2026, 11:46');
    expect(reply).toContain('Receber R$ 770,00');
    expect(reply).toContain('20/11/2026, 12:00');
    expect(reply.match(/\*Lembrete agendado\*/g)).toHaveLength(2);
    expect(reply).not.toContain(id);
    expect(reply).not.toContain(secondId);
  });

  it('does not claim no new reminder was created when another reminder was saved', () => {
    const text =
      'O lembrete anterior já foi enviado. O novo lembrete foi agendado para 12/11 às 11h46.';
    const pending = reminder();
    pending.content = pending.content.replace(id, '8c6bea07-cf9c-4a47-ad27-513b34115070');
    expect(safeChannelResponse(text, [reminder('delivered'), pending])).toBe(text);
  });

  it('an ID copied from an old message does not prove a new reminder was saved', () => {
    const reply = safeChannelResponse(`O lembrete foi criado com o ID ${id}.`, []);
    expect(reply).toMatch(
      /(?:não tenho confirmação|não tenho uma alteração confirmada|ainda não está confirmada)/i
    );
    expect(reply).not.toContain(id);
  });

  it.each([
    ['income', 20, 'Recebimento', 'Outras entradas'],
    ['expense', 19, 'Café da manhã', 'Alimentação'],
    ['expense', 81, 'Pizza', 'Alimentação'],
  ] as const)(
    'uses the shared visual standard for a %s of %s',
    (type, amount, description, categoryName) => {
      const transaction = {
        id,
        type,
        amount,
        description,
        categoryName,
        date: '2026-11-11',
        status: 'settled' as const,
      };
      const receipt: ChannelToolReceipt = {
        name: 'core.record_transaction',
        arguments: '',
        isError: false,
        content: JSON.stringify({ success: true, result: { transaction } }),
      };
      const expected = formatTransactionConfirmation({ ...transaction, category: categoryName });
      for (const prose of [
        'Confirmei um lançamento financeiro salvo.',
        'Pronto, registrei o valor!',
        `Registro salvo com ID ${id} por core.record_transaction.`,
        '<tool_call>use_tool</tool_call></thinking>',
      ]) {
        expect(safeChannelResponse(prose, [receipt])).toBe(expected);
      }
      expect(expected).not.toContain(id);
      expect(expected).not.toContain('**');
    }
  );

  it('shows the persisted amount and pending status, never invented model details', () => {
    const receipt: ChannelToolReceipt = {
      name: 'core.record_transaction',
      arguments: '{"amount":999}',
      isError: false,
      content: JSON.stringify({
        success: true,
        result: {
          transaction: {
            id,
            type: 'income',
            amount: 770,
            status: 'pending',
            date: '2026-11-20',
            description: 'Cliente',
            categoryName: 'Serviços',
          },
        },
      }),
    };
    const reply = safeChannelResponse('Entrada recebida de R$999 no dia10.', [receipt]);
    expect(reply).toContain('⏳ *Valor a receber registrado*');
    expect(reply).toContain('R$ 770,00');
    expect(reply).toContain('*Vencimento:* 20/11/2026');
    expect(reply).not.toMatch(/999|recebida|dia10/);
  });

  it('keeps both confirmed financial and reminder details in a compound request', () => {
    const receipt: ChannelToolReceipt = {
      name: 'core.record_transaction',
      arguments: '',
      isError: false,
      content: JSON.stringify({
        success: true,
        result: {
          transaction: { id, type: 'income', amount: 20, status: 'settled', date: '2026-11-11' },
        },
      }),
    };
    const reply = safeChannelResponse('Pronto!', [receipt, reminder()]);
    expect(reply).toContain('*Entrada registrada*');
    expect(reply).toContain('R$ 20,00');
    expect(reply).toContain('*Lembrete agendado*');
    expect(reply).toContain('12/11/2026, 11:46');
  });

  it('does not lose a requested read result when standardizing a write', () => {
    const receipt: ChannelToolReceipt = {
      name: 'core.record_transaction',
      arguments: '',
      isError: false,
      content: JSON.stringify({
        success: true,
        result: { transaction: { id, type: 'income', amount: 20 } },
      }),
    };
    const answer = 'Entrada registrada. Seu saldo é R$120,00.';
    expect(
      safeChannelResponse(answer, [
        receipt,
        {
          name: 'core.financial_summary',
          arguments: '',
          content: '{"balance":120}',
          isError: false,
        },
      ])
    ).toBe(answer);
  });

  it('does not decorate an unconfirmed financial operation as a success', () => {
    const receipt: ChannelToolReceipt = {
      name: 'core.record_transaction',
      arguments: '{"type":"income","amount":20}',
      isError: true,
      content: '{"success":false,"error":"database unavailable"}',
    };
    const reply = safeChannelResponse('Registrei a entrada de R$20.', [receipt]);
    expect(reply).toMatch(
      /(?:não tenho confirmação|não tenho uma alteração confirmada|ainda não está confirmada)/i
    );
    expect(reply).not.toContain('✅');
    expect(reply).not.toContain('database');
  });

  it.each(['', 'Pronto!'])(
    'discloses a failed reminder beside a saved income even when model says %s',
    (text) => {
      const receipts: ChannelToolReceipt[] = [
        {
          name: 'core.record_transaction',
          arguments: '{}',
          isError: false,
          content: JSON.stringify({
            transaction: { id, type: 'income', amount: 20, status: 'settled', date: '2026-11-11' },
          }),
        },
        {
          name: 'core.schedule_channel_reminder',
          arguments: '{"title":"teste"}',
          isError: true,
          content: '{"success":false}',
        },
      ];
      const reply = safeChannelResponse(text, receipts);
      expect(reply).toContain('*Entrada registrada*');
      expect(reply).toContain('R$ 20,00');
      expect(reply).toContain('Sobre o agendamento do lembrete, ainda não tenho confirmação');
      expect(reply).not.toContain('*Atualização concluída*');
      expect(reply).not.toContain('*Lembrete agendado*');
    }
  );

  it('formats only the latest state of an idempotent or corrected ledger row', () => {
    const recorded: ChannelToolReceipt = {
      name: 'core.record_transaction',
      arguments: '{}',
      isError: false,
      content: JSON.stringify({ transaction: { id, type: 'expense', amount: 19 } }),
    };
    const updated: ChannelToolReceipt = {
      name: 'core.update_transaction',
      arguments: '{}',
      isError: false,
      content: JSON.stringify({ transaction: { id, type: 'income', amount: 20 } }),
    };
    const reply = safeChannelResponse('Pronto!', [recorded, recorded, updated]);
    expect(reply).toContain('*Entrada atualizada*');
    expect(reply).toContain('R$ 20,00');
    expect(reply).not.toContain('R$ 19,00');
    expect(reply.match(/\*Valor:\*/g)).toHaveLength(1);
  });

  it('does not merge distinct saved records just because their visible fields match', () => {
    const receipts: ChannelToolReceipt[] = ['record-one', 'record-two'].map((recordId) => ({
      name: 'core.record_transaction',
      arguments: '{}',
      isError: false,
      content: JSON.stringify({ transaction: { id: recordId, type: 'income', amount: 20 } }),
    }));
    const reply = safeChannelResponse('Pronto!', receipts);
    expect(reply.match(/\*Entrada registrada\*/g)).toHaveLength(2);
  });

  it('shows the final saved confirmation when a retry recovers the same operation', () => {
    const args = '{"type":"income","amount":20,"description":"Recebimento"}';
    const reply = safeChannelResponse('Pronto!', [
      {
        name: 'core.record_transaction',
        arguments: args,
        content: '{"success":false}',
        isError: true,
      },
      {
        name: 'core.record_transaction',
        arguments: args,
        content: JSON.stringify({
          transaction: { id, type: 'income', amount: 20, description: 'Recebimento' },
        }),
        isError: false,
      },
    ]);
    expect(reply).toContain('*Entrada registrada*');
    expect(reply).toContain('R$ 20,00');
    expect(reply.match(/\*Entrada registrada\*/g)).toHaveLength(1);
    expect(reply).not.toMatch(
      /(?:não tenho confirmação|não tenho uma alteração confirmada|ainda não está confirmada)/i
    );
  });

  it.each([
    'Confirmei um lançamento financeiro salvo.',
    '✅ *Entrada recebida*\n\n• *Valor:* R$ 770,00',
  ])('does not allow decorative success without receipts: %s', (text) => {
    const reply = safeChannelResponse(text, []);
    expect(reply).toMatch(
      /(?:não tenho confirmação|não tenho uma alteração confirmada|ainda não está confirmada)/i
    );
    expect(reply).not.toContain('✅');
  });

  it('presents a successful task completion even without model prose', () => {
    const reply = safeChannelResponse('', [
      {
        name: 'core.complete_task',
        arguments: '{"taskId":"synthetic"}',
        content: '{"success":true}',
        isError: false,
      },
    ]);
    expect(reply).toBe('✅ *Tarefa concluída*');
  });

  it('standardizes an update after its preparatory lookup without dropping a requested summary', () => {
    const receipts: ChannelToolReceipt[] = [
      {
        name: 'core.list_transactions',
        arguments: '{"search":"pizza"}',
        content: '{"transactions":[]}',
        isError: false,
      },
      {
        name: 'core.update_transaction',
        arguments: '{}',
        content: JSON.stringify({ transaction: { id, type: 'income', amount: 20 } }),
        isError: false,
      },
    ];
    expect(safeChannelResponse('Entrada atualizada.', receipts)).toContain(
      '*Entrada atualizada*\n\n• *Valor:* R$ 20,00'
    );
    const withSummary = 'Entrada atualizada. Você ainda tem R$ 200,00 a receber.';
    expect(safeChannelResponse(withSummary, receipts)).toBe(withSummary);
  });
});
