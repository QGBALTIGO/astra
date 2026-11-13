import { describe, it, expect } from 'vitest';
import { channelFailureKind, channelFailureReply, presentChannelReply } from './channel-failure.js';
import { CHANNEL_UNVERIFIED_REPLY, type ChannelToolReceipt } from './response-safety.js';
import { isConversationalOnlyChannelRequest } from './tool-selection.js';
import { tryAstraAccessReply } from './astra-access.js';

describe('browser onboarding during a provider failure', () => {
  const question =
    'Quero organizar minha semana pelo Astra. Para fazer isso pelo navegador, onde entro e por onde vale começar?';
  it.each([
    question,
    'Como posso planejar a minha semana no painel do Astra?',
    'Quero organizar minha semana pelo navegador. Por onde começar?',
  ])('guides the customer after a provider failure: %s', (request) => {
    expect(tryAstraAccessReply(request)).toBeNull();
    expect(isConversationalOnlyChannelRequest(request)).toBe(true);
    const answer = channelFailureReply(request, 'agent_error');
    expect(answer).toContain('https://app.astraacessor.pro/cliente/entrar');
    expect(answer).toContain('Agenda');
    expect(answer).not.toMatch(/se o pedido envolvia|confira seus registros/i);
  });
  it.each([
    question + ' E marque um compromisso amanhã.',
    'Quero organizar minha semana pelo banco. Para fazer isso pelo navegador, onde entro?',
  ])('preserves the normal processing of %s', (request) => {
    expect(isConversationalOnlyChannelRequest(request)).toBe(false);
  });
});

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
  it('keeps the misspelled access question useful if all models fail', () => {
    expect(channelFailureReply('cpmp acesso o dashboard', 'provider_unavailable')).toContain(
      'https://app.astraacessor.pro/cliente/entrar'
    );
  });
  it('replaces official link origins in model prose without redirecting external links or an embedded return URL', () => {
    const external = 'https://example.org/go?return=https://astraacessor.vercel.app/privacidade';
    const checkout = 'https://pay.cakto.com.br/CubL455';
    const answer =
      '[Site](https://astraacessor.vercel.app/condicoes?q=R%2420#leia), ' +
      external +
      ' e ' +
      checkout +
      '.';
    expect(presentChannelReply(answer, 'cpmp acesso o dashboard')).toBe(
      '[Site](https://astraacessor.pro/condicoes?q=R%2420#leia), ' +
        external +
        ' e ' +
        checkout +
        '.'
    );
  });
  it.each([
    'Preciso mudar a Revisão do orçamento Acácia de sexta para 16h, mantendo meia hora. Se encontrar esse evento, remarca o mesmo; se não encontrar, me avisa.',
    'Remarque a reunião para sexta e me avise se não achar.',
    'Consulta o evento de amanhã; se não localizar, só me avisa.',
  ])('treats an immediate conditional notification as feedback about the event: %s', (q) => {
    const answer = channelFailureReply(q, 'provider_unavailable');
    expect(answer).toMatch(/compromisso|agenda/i);
    expect(answer).not.toMatch(/confirmação do aviso|lembretes|criar outro/i);
    if (q.startsWith('Consulta')) expect(answer).toContain('agenda não abriu');
    else expect(answer).toContain('sem a confirmação desse compromisso');
  });
  it.each([
    'Me avise amanhã se não encontrar o evento.',
    'Se não encontrar esse evento, me avisa amanhã às 9h.',
    'Mude meu lembrete da reunião; se não encontrar, me avisa.',
  ])('preserves actual requests to schedule or modify a reminder: %s', (q) => {
    const answer = channelFailureReply(q, 'timeout');
    expect(answer).toMatch(/confirmação do aviso/);
    expect(answer).not.toContain('confirmação desse compromisso');
  });
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
  it.each([
    ['Não quero cancelar a assinatura. Só quero saber quando vence.', 'Meu planejamento'],
    ['Não apague o aviso! Quero ver a que horas ele toca.', 'lista de avisos'],
    ['Paguei ontem ou foi hoje? É só consulta do gasto.', 'Transações'],
    [
      'Você consegue cancelar assinaturas com o fornecedor ou só acompanha os vencimentos?',
      'cancelamento é com o fornecedor',
    ],
    [
      'Pode registrar gasto em dólar ou precisa ser em reais? Estou perguntando como funciona.',
      'separados por moeda',
    ],
    [
      'Deixa minha tarefa como está. Explica a diferença entre pendente e concluída.',
      'marcada como feita',
    ],
    ['Se eu pedir, você consegue me mostrar só as tarefas concluídas?', 'só as concluídas'],
    ['O aviso chega aqui mesmo no Telegram ou preciso abrir o painel?', 'aqui mesmo na conversa'],
    ['Como funciona o reagendamento de um compromisso?', 'escolha Editar'],
  ])('handles a request for information without implying a write: %s', (input, expected) => {
    const r = channelFailureReply(input, 'provider_unavailable');
    expect(r).toContain(expected);
    expect(r).not.toMatch(
      /confirmação|mudança já aparece|antes de criar|antes de (?:anotar|repetir)/i
    );
  });

  it.each([
    ['Me dá um toque pra pegar a marmita na hora de sair, lá pelas seis?', 'status em Agenda'],
    ['Muda a minha reunião de amanhã pras dez?', 'Antes de pedir outra alteração'],
    ['Em vez das sete, me avisa às oito de levar o casaco?', 'status em Agenda'],
    ['Opa, pode corrigir o lançamento de 12 pra 10 reais?', 'confirmação do lançamento'],
    ['Troca a mensalidade de 10 para 16 reais?', 'confirmação da assinatura'],
    [
      'A tarefa de devolver o livro ainda não acabou. Deixa ela pendente de novo?',
      'confirmação da tarefa',
    ],
    ['Passa pro meu controle os 9 reais do ônibus?', 'confirmação do lançamento'],
    ['Bota na lista de tarefas a devolução do livro?', 'confirmação da tarefa'],
    ['Não vou à reunião. Pode tirar ela da agenda?', 'Antes de pedir outra alteração'],
    [
      'A partir de hoje deixa de acompanhar minha assinatura, pode ser?',
      'confirmação da assinatura',
    ],
    ['Não apague o aviso, mas me lembre de ligar amanhã.', 'status em Agenda'],
    [
      'Como funciona a agenda? Pode criar um compromisso para amanhã?',
      'Antes de pedir outra alteração',
    ],
  ])('keeps a colloquial or compound action safe: %s', (input, expected) => {
    const r = channelFailureReply(input, 'timeout');
    expect(r).toContain(expected);
    expect(r).not.toMatch(/tente novamente|pode me chamar|pergunt\w* de novo|foi criad/i);
  });

  it.each([
    ['Dá um jeito naquele gasto na lista pra mim?', 'Transações no painel'],
    ['A tarefa do mercado, resolve aquela pra mim, pode ser?', 'Consulte a tarefa'],
    ['Quando der a hora, chama aqui pra eu não esquecer do pão, combinado?', 'Agenda no painel'],
    ['Aquela assinatura do jornal, deixa do jeito combinado, beleza?', 'Minhas assinaturas'],
  ])('gives a neutral status check for an ambiguous action: %s', (request, marker) => {
    const r = channelFailureReply(request, 'provider_unavailable');
    expect(r).toContain(marker);
    expect(r).not.toMatch(
      /lista não abriu|dados da assinatura não carregaram|confirmação|pode repetir|de novo|foi salv|foi criad/i
    );
  });

  it.each([
    [
      'Vocês avisam automaticamente se uma assinatura vencer, ou tenho que pedir o aviso?',
      'peça um lembrete separado',
    ],
    [
      'Consigo pedir um lembrete para trocar a senha sem dizer a senha?',
      'Guarde a senha só com você',
    ],
    ['E se dois compromissos coincidirem? Estou aprendendo a usar.', 'comparar os horários'],
  ])(
    'explains an available capability without personal data or writes: %s',
    (request, expected) => {
      expect(channelFailureReply(request, 'timeout')).toContain(expected);
    }
  );
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
