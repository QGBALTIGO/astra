import { describe, expect, it } from 'vitest';
import { stripInternalTags } from './normalizers/base.js';
import {
  safeChannelResponse,
  successfulChannelTools,
  type ChannelToolReceipt,
} from './response-safety.js';
import { channelToolsForMessage } from './tool-selection.js';
import { customerLocalDateTime, withCustomerClock } from '../services/customer-date.js';

const receipt = (
  name: string,
  isError = false,
  content = '{"id":"synthetic"}'
): ChannelToolReceipt => ({ name, isError, content, arguments: '' });

describe('WhatsApp screenshot regressions: no external calls or writes', () => {
  it.each([
    ['Seu nome é Kayky! </thinking>', 'Seu nome é Kayky!'],
    ['<think>private</think>Resposta final', 'Resposta final'],
    ['<thinking>unfinished', ''],
    ['Resposta </think>', 'Resposta'],
    [
      'Antes <tool_call>use_tool<arg_key>arguments</arg_key><arg_value>{"remind_at":"2026-11-20T12:00:00-03:00"}</arg_value></tool_call> depois </thinking>',
      'Antes  depois',
    ],
    ['<tool_call>broken', ''],
    ['<tool_calls><tool_call>inner</tool_call></tool_calls>Pronto', 'Pronto'],
    ['Um texto <strong>legítimo</strong>', 'Um texto <strong>legítimo</strong>'],
  ])('strips protocol without executing it: %s', (input, expected) =>
    expect(stripInternalTags(input)).toBe(expected)
  );

  it('keeps normal name recall without claiming a new memory write', () => {
    expect(safeChannelResponse('Seu nome é Kayky. 😊 </thinking>', [])).toBe(
      'Seu nome é Kayky. 😊'
    );
  });
  it.each([
    '✅ Lembrete agendado! Você será avisado daqui a 40 minutos. </thinking>',
    'Lembrete reagendado para as 18h40.',
    'Pronto, Kayky! Já salvei seu nome na minha memória.',
    'Tarefa criada.',
    'Registrei a entrada de R$770,00.',
    'Corrigi o lançamento para entrada.',
    'Excluí o registro.',
  ])('does not confirm an action from prose alone: %s', (text) =>
    expect(safeChannelResponse(text, [])).toContain('não tenho uma alteração confirmada')
  );

  it('a task is not evidence of a scheduled notification', () => {
    const result = safeChannelResponse('Tarefa criada. Lembrete agendado.', [
      receipt('core.add_task'),
    ]);
    expect(result).toContain('uma tarefa salva');
    expect(result).toContain('ainda não tenho confirmação');
    expect(result).not.toContain('um lembrete salvo');
  });
  it('uses actual nested registry receipts rather than meta tool arguments', () => {
    const meta = {
      ...receipt('use_tool'),
      arguments: '{"tool_name":"core.schedule_channel_reminder"}',
    };
    expect(successfulChannelTools([meta]).size).toBe(0);
    expect(
      successfulChannelTools([meta, receipt('core.schedule_channel_reminder')]).has(
        'schedule_channel_reminder'
      )
    ).toBe(true);
  });
  it('failed and partially failed tool results never prove success', () => {
    const receipts = [
      receipt('core.schedule_channel_reminder', true),
      receipt('core.add_task'),
      receipt('batch_use_tool'),
    ];
    expect(successfulChannelTools(receipts)).toEqual(new Set(['add_task']));
    expect(
      successfulChannelTools([receipt('core.create_memory', false, '{"success":false}')]).size
    ).toBe(0);
  });
  it('allows a confirmed real reminder and removes orphan tags', () => {
    expect(
      safeChannelResponse('Lembrete agendado. </thinking>', [
        receipt('core.schedule_channel_reminder'),
      ])
    ).toBe('Lembrete agendado.');
  });
  it('never forwards tool argument markup even after a successful write', () => {
    const text = '<tool_call>use_tool<arg_value>secret details</arg_value></tool_call>';
    const result = safeChannelResponse(text, [receipt('core.add_task')]);
    expect(result).toContain('uma tarefa salva');
    expect(result).not.toContain('<');
    expect(result).not.toContain('secret');
  });
  it('does not turn a negative statement into success', () =>
    expect(safeChannelResponse('Não consegui agendar seu lembrete.', [])).toBe(
      'Não consegui agendar seu lembrete.'
    ));

  it('uses compact financial tools including correction and deletion', () => {
    const tools = channelToolsForMessage('Excluir e registrar de novo como entrada');
    expect(tools).toContain('core.update_transaction');
    expect(tools).toContain('core.delete_transaction');
    expect(tools).not.toContain('core.add_expense');
    expect(tools).not.toContain('core.execute_shell');
  });
  it('retains multi-turn intent for "os dois"', () => {
    const tools = channelToolsForMessage(
      'Os dois',
      'Posso criar uma tarefa e um lembrete para receber R$770.'
    );
    expect(tools).toContain('core.add_task');
    expect(tools).toContain('core.schedule_channel_reminder');
    expect(tools).toContain('core.record_transaction');
  });
  it('does not send all financial/calendar schemas for a simple name question', () => {
    expect(channelToolsForMessage('Qual meu nome mesmo?')).toEqual([
      'core.create_memory',
      'core.search_memories',
    ]);
    expect(channelToolsForMessage('O que é fotossíntese?')).toEqual([]);
  });
  it('handles relative reminder intent from a transcribed voice message', () =>
    expect(channelToolsForMessage('[Voice message]: Me lembre daqui uns 40 minutos')).toContain(
      'core.schedule_channel_reminder'
    ));

  it('converts 18h40 Campo Grande to 22h40 UTC, not 21h40 UTC', () => {
    expect(customerLocalDateTime('2026-11-10T18:40', 'America/Campo_Grande').toISOString()).toBe(
      '2026-11-10T22:40:00.000Z'
    );
  });
  it.each(['2026-02-30T09:00', '2026-11-20', '2026-11-20T24:00', '2026-11-20T12:60'])(
    'rejects invalid/missing hour %s',
    (value) => expect(() => customerLocalDateTime(value, 'America/Campo_Grande')).toThrow()
  );
  it('rejects a DST gap or repeated local hour instead of guessing', () => {
    expect(() => customerLocalDateTime('2026-03-08T02:30', 'America/New_York')).toThrow();
    expect(() => customerLocalDateTime('2026-11-01T01:30', 'America/New_York')).toThrow();
  });
  it('supports half-hour zones', () =>
    expect(customerLocalDateTime('2026-11-20T12:00', 'Asia/Kolkata').toISOString()).toBe(
      '2026-11-20T06:30:00.000Z'
    ));
  it('keeps exact minutes and refreshed absolute clock, not rounded 14h', () => {
    const prompt = withCustomerClock(
      'Astra',
      'America/Campo_Grande',
      new Date('2026-11-10T18:09:00Z')
    );
    expect(prompt).toContain('14:09');
    expect(prompt).toContain('2026-11-10T18:09:00.000Z');
    expect(
      withCustomerClock(prompt, 'America/Campo_Grande').split('## Astra customer clock')
    ).toHaveLength(2);
  });
});
