import { describe, expect, it } from 'vitest';
import { customerFacingText, savedReminderConfirmation } from './customer-facing-response.js';
import { safeChannelResponse, type ChannelToolReceipt } from './response-safety.js';

const id = '54676012-ea88-44ff-8bac-267ee4264d6b';
function receipt(overrides: Record<string, unknown> = {}): ChannelToolReceipt {
  return {
    name: 'core.schedule_channel_reminder',
    arguments: '{}',
    isError: false,
    content: JSON.stringify({
      success: true,
      result: {
        id,
        title: 'Meu limite do Codex renova',
        agendadoPara: '2026-11-12T15:46:00Z',
        timeZone: 'America/Campo_Grande',
        status: 'pending',
        ...overrides,
      },
    }),
  };
}

describe('customer-facing WhatsApp confirmations', () => {
  it('renders the screenshot case from saved data, not model text', () => {
    const call = receipt();
    const original = call.content;
    const result = safeChannelResponse(
      `Lembrete agendado!\n\nO lembrete foi criado com o ID ${id} e está pendente de envio nesta conversa.`,
      [call]
    );
    expect(result).toContain('*Lembrete agendado!*');
    expect(result).toContain('*Meu limite do Codex renova*');
    expect(result).toContain('12/11/2026 às 11:46');
    expect(result).not.toMatch(/\bID\b|pendente|core\./);
    expect(result).not.toContain(id);
    expect(call.content).toBe(original);
    expect(call.content).toContain(id);
  });

  it('respects a different customer timezone', () => {
    const result = savedReminderConfirmation([receipt({ timeZone: 'America/Sao_Paulo' })]);
    expect(result).toContain('12/11/2026 às 12:46');
  });

  it('distinguishes rescheduling from a new reminder', () => {
    const call = { ...receipt(), name: 'core.reschedule_channel_reminder' };
    expect(savedReminderConfirmation([call])).toContain('*Lembrete reagendado!*');
  });

  it.each(['sent', 'failed', 'cancelled', 'sending'])('does not promise delivery for %s', (status) => {
    expect(savedReminderConfirmation([receipt({ status })])).toBeNull();
  });

  it.each([
    { title: '' },
    { timeZone: 'not/a-timezone' },
    { agendadoPara: 'not a date' },
    { timeZone: null },
  ])('rejects incomplete saved data: %j', (data) => {
    expect(savedReminderConfirmation([receipt(data)])).toBeNull();
  });

  it('does not convert a failed write into a success', () => {
    const call = { ...receipt(), isError: true };
    expect(savedReminderConfirmation([call])).toBeNull();
    expect(safeChannelResponse('Lembrete agendado!', [call])).toContain('Não consegui confirmar');
  });

  it('does not hide failure in a compound request', () => {
    const failed = { ...receipt(), name: 'core.add_task', isError: true };
    expect(savedReminderConfirmation([receipt(), failed])).toBeNull();
    const result = safeChannelResponse('Lembrete agendado! Tarefa criada!', [receipt(), failed]);
    expect(result).toContain('Não consegui confirmar');
    expect(result).not.toContain(id);
  });

  it('preserves money, dates, times, phones and security codes', () => {
    const text = 'R$ 770,00; 12/11/2026 às 11:46. Código 001234. Telefone +55 67 99999-0000.';
    expect(customerFacingText(text)).toBe(text);
  });

  it('removes UUIDs even with a wrapped dash and markdown', () => {
    const wrapped = id.replace('-', '–\n');
    expect(customerFacingText(`Confirmado.\nID: \`${wrapped}\``)).toBe('Confirmado.');
  });

  it('strips implementation details from a response without receipts', () => {
    const text = `Consulte seus lembretes.\n\nID: ${id}\nPendente de envio nesta conversa.`;
    expect(customerFacingText(text)).toBe('Consulte seus lembretes.');
  });

  it('does not forward internal tool names', () => {
    expect(customerFacingText('Use core.schedule_channel_reminder.')).not.toContain('core.');
  });
});
