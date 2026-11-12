import { describe, it, expect } from 'vitest';
import { channelFailureKind, channelFailureReply, presentChannelReply } from './channel-failure.js';
import { CHANNEL_UNVERIFIED_REPLY, type ChannelToolReceipt } from './response-safety.js';

const b03 =
  'Para o Astra me avisar um dia antes de uma assinatura vencer, basta eu cadastrar a data de renovação ou preciso pedir um lembrete separado? Só quero entender como funciona.';
const b06 =
  'Minha videochamada de terça, dia 17 de novembro de 2026, é às 14h de Brasília. Que horas são aqui em Cuiabá? Só me diga o horário, que eu mesmo marco.';
const legacy = 'Não consegui processar sua mensagem agora. Tente novamente em instantes.';
const receipt = (name: string, result: unknown, isError = false): ChannelToolReceipt => ({
  name,
  arguments: '',
  content: JSON.stringify(result),
  isError,
});
const calendar = receipt('core.add_calendar_event', {
  event: {
    id: 'internal-private-id',
    title: 'Revisão',
    startTime: '2026-11-13T19:00:00Z',
    timezone: 'America/Cuiaba',
  },
});
describe('channel failure replies', () => {
  it.each([
    ['OpenAI API error: 429 - org_secret', 'rate_limited'],
    ['Anthropic request timed out after 40000 ms', 'timeout'],
    ['Circuit breaker is open', 'provider_unavailable'],
    ['All providers failed', 'provider_unavailable'],
    ['No provider configured', 'provider_configuration'],
    ['Agent is already processing a request', 'agent_busy'],
  ])('classifies %s without forwarding the cause', (raw, kind) => {
    expect(channelFailureKind(raw)).toBe(kind);
    expect(
      channelFailureReply('O que eu decidi sobre o aluguel?', channelFailureKind(raw))
    ).not.toMatch(/OpenAI|Anthropic|HTTP|429|circuit|org_secret|40000|API key/i);
  });
  it.each([
    [b03, 'aviso de renovação'],
    [b06, 'dois fusos'],
    ['Agenda de hoje?', 'Agenda no painel'],
    ['Quais meus lembretes de hoje?', 'Quais são meus lembretes de hoje?'],
    ['Quanto gastei no ônibus?', 'Transações'],
    ['Minhas tarefas de hoje?', 'lista de tarefas'],
    ['Quais assinaturas tenho?', 'Minhas assinaturas'],
    ['O que você acha dessa ideia?', 'responder'],
  ])('keeps %s informational even for old write banners', (input, marker) => {
    for (const text of [
      legacy,
      CHANNEL_UNVERIFIED_REPLY,
      'Essa alteração ainda não está confirmada. Confira seus registros antes de pedir novamente, para evitar duplicidade.',
      '(No response generated)',
    ]) {
      const reply = presentChannelReply(text, input);
      expect(reply).toContain(marker);
      expect(reply).not.toMatch(
        /alteração confirmada|ficou salv|em dobro|antes de (?:repetir|pedir|criar)|nenhum registro|foi registrado|foi agendado|13h|14h|R\$/i
      );
    }
  });
  it.each([
    ['Pode registrar essa despesa para mim?', 'Transações'],
    ['Cancele a assinatura de música', 'Minhas assinaturas'],
    ['Mude o meu compromisso', 'Agenda no painel'],
    ['Pode criar a tarefa de separar os recibos?', 'Consulte a tarefa'],
    ['Me lembre de ligar para a clínica', 'status em Agenda'],
  ])('provides a safe verification path for %s', (input, marker) => {
    const reply = channelFailureReply(input, 'timeout');
    expect(reply).toContain(marker);
    expect(reply).not.toMatch(
      /foi (?:salv|criad|exclu)|não (?:salvei|criei)|nada mudou|tente novamente|pode me (?:chamar|perguntar)/i
    );
  });
  it('a real write invocation outweighs read wording; a failed write never becomes confirmation', () => {
    const r = channelFailureReply('Qual é o meu próximo compromisso?', 'timeout', [
      receipt('core.add_calendar_event', { success: false }, true),
    ]);
    expect(r).toContain('Antes de pedir outra alteração');
    expect(r).not.toMatch(/Compromisso agendado/);
  });
  it('only reports an actual persisted result after AI failure and does not confirm the rest', () => {
    const r = channelFailureReply('Marque a reunião e me avise', 'timeout', [
      calendar,
      receipt('core.schedule_channel_reminder', { success: false }, true),
    ]);
    expect(r).toContain('Revisão');
    expect(r).toContain('15:00');
    expect(r).toContain('outra parte');
    expect(r).not.toMatch(/aviso agendado|internal-private-id|vou avisar/i);
    const invalid = channelFailureReply('Crie uma tarefa', 'timeout', [
      receipt('core.add_task', { success: true }),
    ]);
    expect(invalid).not.toContain('Tarefa criada');
  });
  it('does not mistake a quote or a normal answer for a runtime banner', () => {
    const natural = 'Quando eu disse “' + legacy + '”, a pergunta ficou em aberto.';
    expect(presentChannelReply(natural, b06)).toBe(natural);
    expect(presentChannelReply('Em Cuiabá são 13h.', b06)).toBe('Em Cuiabá são 13h.');
  });
});
