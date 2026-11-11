import { describe, expect, it } from 'vitest';
import {
  safeChannelResponse,
  successfulChannelTools,
  type ChannelToolReceipt,
} from './response-safety.js';

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
  it('rebuilds the screenshot UUID acknowledgement from the saved reminder', () => {
    const text = `Lembrete agendado!\nO lembrete foi criado com o ID ${id} e está pendente de envio nesta conversa.`;
    expect(safeChannelResponse(text, [reminder()])).toBe(
      'Lembrete agendado: Meu limite do Codex renova.\nData e hora: 12/11/2026, 11:46.'
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
      'Não consegui confirmar'
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
    expect(reply).toContain('Não consegui confirmar');
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
    expect(reply).toContain('Não consegui confirmar');
    expect(reply).not.toMatch(/core\.|use_tool|schedule_channel_reminder|arguments/);
  });

  it('does not hide a partial failure behind a successful reminder acknowledgement', () => {
    const reply = safeChannelResponse('Tarefa criada. Lembrete agendado.', [
      reminder(),
      { name: 'core.add_task', arguments: '', content: '{"success":false}', isError: true },
    ]);
    expect(reply).toContain('um lembrete salvo');
    expect(reply).toContain('Não consegui confirmar');
    expect(reply).not.toContain('uma tarefa salva');
  });

  it('an ID copied from an old message does not prove a new reminder was saved', () => {
    const reply = safeChannelResponse(`O lembrete foi criado com o ID ${id}.`, []);
    expect(reply).toContain('Não consegui confirmar');
    expect(reply).not.toContain(id);
  });
});
