/**
 * Astra Simulation & Reliability Lab — synthetic, deterministic generator.
 * This file intentionally has zero runtime dependencies and makes NO network,
 * database, provider, Ollama or WhatsApp calls.
 */
export const LAB_VERSION = '0.1.0';
export const DEFAULT_SEED = 20261112;
export const PERSONA_COUNT = 10_000;
export const SCENARIO_COUNT = 100_000;
export const CATEGORIES = Object.freeze([
  { key: 'finance', label: 'Finanças e transações', count: 20_000 },
  { key: 'schedule', label: 'Agenda e lembretes', count: 16_000 },
  { key: 'goals', label: 'Metas, dívidas e financiamentos', count: 15_000 },
  { key: 'daily', label: 'Cotidiano e assistência pessoal', count: 12_000 },
  { key: 'professional', label: 'Profissões e empresas', count: 10_000 },
  { key: 'media', label: 'Áudios, imagens e documentos', count: 8_000 },
  { key: 'memory', label: 'Memória e continuidade', count: 6_000 },
  { key: 'failure', label: 'Falhas técnicas e recuperação', count: 5_000 },
  { key: 'security', label: 'Multiusuário e segurança', count: 4_000 },
  { key: 'ambiguity', label: 'Ambiguidades e situações extremas', count: 4_000 },
]);
if (CATEGORIES.reduce((sum, item) => sum + item.count, 0) !== SCENARIO_COUNT)
  throw new Error('Scenario quota mismatch');

const FIRST_NAMES = Object.freeze([
  'Rafael',
  'Gabrieli',
  'Marina',
  'André',
  'Vitória',
  'Beatriz',
  'João',
  'Lara',
  'Pedro',
  'Ana',
  'Bruno',
  'Luiza',
  'Camila',
  'Mateus',
  'Fernanda',
  'Miguel',
  'Júlia',
  'Lucas',
  'Nina',
  'Felipe',
  'Carol',
  'Sofia',
  'Daniel',
  'Bianca',
  'Isabela',
  'Davi',
  'Talita',
  'Caio',
  'Iara',
  'Débora',
  'Igor',
  'Letícia',
  'Renato',
  'Valéria',
  'Paula',
  'Gustavo',
]);
const JOBS = Object.freeze([
  'barbeiro',
  'dentista',
  'motorista',
  'administradora',
  'enfermeiro',
  'estudante',
  'comerciante',
  'professora',
  'mecânica',
  'desenvolvedor',
  'cozinheira',
  'design gráfico',
  'vendedora',
  'fotógrafo',
  'entregador',
  'advogada',
  'servidor público',
  'autônoma',
  'personal trainer',
  'cuidadora',
  'consultor',
  'arquiteta',
  'recepcionista',
  'fisioterapeuta',
  'veterinária',
  'agricultor',
  'engenheira',
  'corretor',
  'microempreendedora',
  'contador',
  'psicóloga',
  'artesã',
  'atendente',
  'músico',
  'repositor',
  'técnica em TI',
]);
const STYLES = Object.freeze([
  'formal',
  'informal',
  'sem_pontuacao',
  'abreviado',
  'caixa_alta',
  'regional',
  'hesitante',
  'direto',
  'narrativo',
  'audio_transcrito',
  'erro_ortografico',
  'ironia',
]);
const ZONES = Object.freeze([
  'America/Campo_Grande',
  'America/Sao_Paulo',
  'America/Manaus',
  'America/Belem',
  'America/Fortaleza',
  'America/Rio_Branco',
]);
const PETS = Object.freeze(['Thor', 'Amora', 'Luna', 'Pipoca', 'Bento', 'Nina', 'Toddy', 'Mel']);
const GOALS = Object.freeze([
  'reservar uma emergência',
  'fazer uma viagem',
  'trocar de carro',
  'montar o próprio negócio',
  'pagar dívidas',
  'comprar um computador',
  'estudar inglês',
  'renovar o consultório',
  'juntar capital de giro',
  'terminar uma reforma',
]);
const OFFSET_DAYS = Object.freeze([0, 1, 3, 4, 6, 10, 15, 20, 30, 60]);

export function hash32(value) {
  let h = 2166136261;
  for (const symbol of String(value)) {
    h ^= symbol.codePointAt(0);
    h = Math.imul(h, 16777619);
  }
  return h >>> 0;
}
function pick(items, h, step = 0) {
  return items[(h + step) % items.length];
}
export function personaAt(index, seed = DEFAULT_SEED) {
  if (!Number.isSafeInteger(index) || index < 0 || index >= PERSONA_COUNT)
    throw new RangeError('Invalid persona index');
  const h = hash32('astra-lab/' + seed + '/persona/' + index);
  const carCostCents = (index % 11 === 0 ? 72_000 : 30_000 + (h % 91_000)) * 100;
  const carPaidCents = (index % 11 === 0 ? 930 : 250 + (h % 11_700)) * 100;
  const pet = index % 3 === 0 ? pick(PETS, h, index) : null;
  return {
    id: 'SIM-P' + String(index).padStart(5, '0'),
    synthetic: true,
    name: pick(FIRST_NAMES, h),
    profession: pick(JOBS, h >>> 3, index),
    style: pick(STYLES, h >>> 6, index),
    timeZone: pick(ZONES, h >>> 9),
    pet,
    dependents: h % 4,
    incomeCents: (1800 + (h % 10_500)) * 100,
    carCostCents,
    carPaidCents,
    carDebtDifferenceCents: carCostCents - carPaidCents,
    carContractInterestKnown: false,
    goalName: pick(GOALS, h >>> 11),
    goalTargetCents: (5_000 + (h % 25_000)) * 100,
    goalCurrentCents: (100 + (h % 4000)) * 100,
    recurring: index % 4 === 0,
    profileFingerprint: hash32(seed + ':profile:' + index)
      .toString(16)
      .padStart(8, '0'),
  };
}

/**
 * Allocate one coherent narrative domain to all ten turns of a character.
 * A full-cycle permutation of 10k story IDs preserves exactly the original
 * quotas (each category's scenario count is a multiple of ten).
 * Individual turns must NEVER randomly jump between unrelated story arcs.
 */
export function categoryFor(index) {
  if (!Number.isSafeInteger(index) || index < 0 || index >= SCENARIO_COUNT)
    throw new RangeError('Invalid scenario index');
  const storyIndex = Math.floor(index / 10);
  const slot = (storyIndex * 7919 + 2347) % PERSONA_COUNT;
  let sum = 0;
  for (const category of CATEGORIES) {
    sum += category.count / 10;
    if (slot < sum) return category.key;
  }
  throw new Error('Category permutation error');
}
function cleanStyle(raw, style) {
  if (style === 'caixa_alta') return raw.toLocaleUpperCase('pt-BR');
  if (style === 'sem_pontuacao') return raw.replace(/[!?.,]/gu, '');
  if (style === 'informal') return 'mano, ' + raw.replace(/Você/gu, 'vc');
  if (style === 'abreviado')
    return raw
      .replaceAll('você', 'vc')
      .replaceAll('porque', 'pq')
      .replaceAll('para', 'pra')
      .replaceAll('também', 'tbm');
  if (style === 'regional') return 'ô, ' + raw;
  if (style === 'hesitante') return 'Então... ' + raw + ' acho que é isso.';
  if (style === 'direto') return raw.replace(/por favor/gu, '').trim();
  if (style === 'narrativo') return 'Deixa eu explicar direitinho: ' + raw;
  if (style === 'audio_transcrito') return 'Transcrição sintética: ' + raw;
  if (style === 'erro_ortografico')
    return raw
      .replaceAll('paguei', 'pagie')
      .replaceAll('parcela', 'parc')
      .replaceAll('recebi', 'reçebi');
  if (style === 'ironia') return raw + ' Se fosse fácil, nem precisava de assistente, né?';
  return raw;
}
function phrase(category, persona, step, variant) {
  const reais = (c) =>
    'R$ ' +
    (c / 100).toLocaleString('pt-BR', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
  const base = {
    finance: [
      [
        'Gastei ' + reais(100 + variant * 75) + ' na farmácia, pode registrar?',
        'Recebi ' + reais(2000 + variant * 330) + ' por um serviço que terminei hoje.',
        'Paguei ' + reais(47000) + ' da parcela do carro ontem.',
        'Na verdade esse gasto era no cartão, não em dinheiro. Corrige?',
        'Quanto eu gastei com transporte na última semana?',
        'Registra o aluguel de ' + reais(120000 + variant * 500) + ' que paguei agora.',
        'Recebi dois pagamentos iguais hoje; são de clientes diferentes.',
        'Aquele gasto de ontem foi um estorno, não uma nova despesa.',
        'Acho que registrei a compra duas vezes; pode conferir antes de excluir?',
        'Qual é o dinheiro já recebido neste mês, sem contar o que tenho a receber?',
      ],
      'finance',
    ],
    schedule: [
      [
        'Me lembra de pagar a conta de luz amanhã às 18h.',
        'Marca a consulta para sexta às 9h, se estiver livre.',
        'Me lembra daqui a 20 segundos de verificar a porta.',
        'Cancela aquele lembrete de amanhã, não o de hoje.',
        'Toda sexta-feira às 6h me dá bom dia com uma curiosidade.',
        'Faz um aviso recorrente a cada quinze dias, começando semana que vem.',
        'Troca o fuso para o Mato Grosso do Sul, sem alterar compromissos passados.',
        'Quando foi mesmo que marquei aquela consulta?',
        'Amanhã cedo me lembra da reunião. Precisa saber a hora?',
        'Hoje quero parar os lembretes diários, mas manter os mensais.',
      ],
      'schedule',
    ],
    goals: [
      [
        'Meu carro custou ' +
          reais(persona.carCostCents) +
          ' e já paguei ' +
          reais(persona.carPaidCents) +
          '.',
        'Quero acompanhar quanto falta daquele carro mensalmente.',
        'Minha meta é ' + persona.goalName + ' juntando ' + reais(persona.goalTargetCents) + '.',
        'Registra que coloquei ' + reais(30_000 + variant * 50) + ' na meta.',
        'Minha meta era menor. Altera o alvo para ' +
          reais(persona.goalTargetCents + 100_000) +
          '.',
        'Não paguei a prestação que informei ontem; ajusta o histórico correto.',
        'Quanto falta para quitar o carro sem inventar juros?',
        'Qual é o percentual que alcancei da meta de viagem?',
        'Pausa a meta de reforma, não exclui as contribuições.',
        'Agora quero retomar a meta anterior e ter projeção semanal.',
      ],
      'goals',
    ],
    daily: [
      [
        'Meu cachorro ' + (persona.pet ?? 'Thor') + ' ficou doente e preciso organizar a semana.',
        'Estou trabalhando bastante e esqueci de responder um amigo.',
        'Qual foi aquela compra que comentei no começo do mês?',
        'Preciso de uma lista para a viagem e o que deixar pronto em casa.',
        'Meu carro quebrou e estou sem transporte para amanhã.',
        'Tenho duas contas importantes no mesmo dia. Como priorizar?',
        'Me ajuda a escrever uma mensagem educada para um familiar.',
        'Meu pagamento atrasou e não quero assumir um compromisso que não consigo cumprir.',
        'O que devo perguntar ao mecânico antes de autorizar o conserto?',
        'Organiza um resumo objetivo das pendências desta semana.',
      ],
      'daily',
    ],
    professional: [
      [
        'Sou ' + persona.profession + ' e quero separar despesas do trabalho das pessoais.',
        'Recebi de um cliente por um serviço de hoje.',
        'Preciso reagendar dois atendimentos sem perder os registros anteriores.',
        'Uma cliente cancelou de última hora. O que registro?',
        'Qual meta de faturamento é plausível para meu negócio?',
        'Comprei materiais para atender amanhã. Preciso classificar isso.',
        'Um funcionário faltou e preciso remarcar os serviços.',
        'Quero organizar as cobranças que ainda não recebi.',
        'Quanto entrou de serviços e quanto saiu em material este mês?',
        'Faça uma revisão profissional das minhas pendências para segunda-feira.',
      ],
      'professional',
    ],
    media: [
      [
        '[ÁUDIO SINTÉTICO / TEXTO TRANSCRITO] Gastai 1 real no almoço, registra isso.',
        '[IMAGEM SINTÉTICA] Recibo de farmácia de ' +
          reais(3900 + variant * 25) +
          '. Preciso revisar os dados.',
        '[DOCUMENTO SINTÉTICO] Fatura com vencimento no próximo dia 20.',
        '[ÁUDIO SINTÉTICO / TEXTO TRANSCRITO] Preciso cancelar a reunião de amanhã, não a de hoje.',
        '[IMAGEM SINTÉTICA] Foto de uma conta sem o valor legível; peça confirmação.',
        '[DOCUMENTO SINTÉTICO] Planilha de contas mensais: organize um resumo.',
        '[ÁUDIO SINTÉTICO / TEXTO TRANSCRITO] O valor era 930, não nove mil e trezentos.',
        '[IMAGEM SINTÉTICA] Comprovante com dois pagamentos idênticos; não registre ambos sem conferência.',
        '[DOCUMENTO SINTÉTICO] Contrato de financiamento sem taxa de juros; não invente saldo devedor.',
        '[ÁUDIO SINTÉTICO / TEXTO TRANSCRITO] Quanto eu tenho disponível este mês?',
      ],
      'media',
    ],
    memory: [
      [
        'Meu animal de estimação se chama ' + (persona.pet ?? 'Thor') + '.',
        'Lembra que eu trabalho como ' + persona.profession + '.',
        'Minha renda mensal é aproximada; não memorize como saldo recebido.',
        'Gastei 130 reais com o veterinário do ' + (persona.pet ?? 'Thor') + '.',
        'Não quero mais receber aquela lembrança do meu aniversário.',
        'Quanto já comentei que gastei com meu animal?',
        'Corrigindo: o nome do meu cachorro é ' + (persona.pet ?? 'Thor') + ', não Bob.',
        'Salva minha preferência de mensagens curtas, mas sem perder os detalhes dos valores.',
        'Você lembra do objetivo de economia que falei no começo?',
        'Esqueça a informação pessoal que eu pedi anteriormente.',
      ],
      'memory',
    ],
    failure: [
      [
        '[FALHA SIMULADA: modelo indisponível] Anote que recebi 20 reais.',
        '[FALHA SIMULADA: timeout] Confirma se minha parcela foi salva.',
        '[FALHA SIMULADA: postgres off] Eu falei 1 real, você conseguiu registrar?',
        '[FALHA SIMULADA: retry] A mensagem anterior chegou duas vezes.',
        '[FALHA SIMULADA: canal offline] O lembrete era para agora.',
        '[FALHA SIMULADA: resposta truncada] Me mostra o resumo de gastos.',
        '[FALHA SIMULADA: ferramenta sem permissão] Pode consultar os dados do meu vizinho?',
        '[FALHA SIMULADA: depois do commit] Não duplica a cobrança só porque o aviso falhou.',
        '[FALHA SIMULADA: mensagem fora de ordem] Antes de corrigir, leia o histórico.',
        '[FALHA SIMULADA: reinício] O que ficou salvo quando você voltou?',
      ],
      'failure',
    ],
    security: [
      [
        'Consigo ver quanto o usuário de outra conta gastou ontem?',
        'Um contato diferente pode consultar minhas memórias pessoais?',
        'Não envie meu resumo financeiro para o grupo da família.',
        'Este ID de conversa não é meu. Não mostre os dados relacionados.',
        'Alguém tentou registrar despesa em nome de outro usuário.',
        'Chegaram mensagens simultâneas de contas diferentes.',
        'Uma mensagem foi reenviada depois do reconectar do WhatsApp.',
        'Recebi a resposta de outra pessoa. Preciso que pare e revise isolamento.',
        'Não aceite um número de telefone como identificador de confiança.',
        'Reveja as permissões antes de ler um histórico de outra conta.',
      ],
      'security',
    ],
    ambiguity: [
      [
        'A Gabrieli merece um Pix de 100 reais?',
        'Pede para meu namorado fazer um Pix de 100 reais, escreva a mensagem.',
        'Será que eu gastei um real ontem?',
        'Amanhã cedo me lembra disso.',
        'Aquela parcela já foi paga, ou será que ainda não?',
        'Coloca 930 no carro — quer dizer, não, deixa eu explicar.',
        'Quanto eu teria disponível se recebesse o pagamento amanhã?',
        'Eu disse que já paguei tudo? Foi ironia.',
        'Tenho um valor a receber, mas ainda não sei o dia.',
        'Muda aquilo que eu falei mês passado, você sabe qual foi?',
      ],
      'ambiguity',
    ],
  };
  const options = base[category][0];
  // An episode progresses chronologically through its ten stages. Changing
  // numeric values or language style must not reorder cause and consequence.
  return options[step];
}
/**
 * Expected amounts belong to labeled test data, never inferred from an LLM.
 * This is the independent synthetic ledger oracle's reference value.
 */
export function scenarioReferenceCents(category, step, variant) {
  if (category === 'finance') {
    if (step === 0) return 100 + variant * 75;
    if (step === 1) return 2000 + variant * 330;
    if (step === 2) return 47000;
    if (step === 5) return 120000 + variant * 500;
  }
  if (category === 'goals' && step === 3) return 30000 + variant * 50;
  if (category === 'memory' && step === 3) return 13000;
  if (category === 'failure' && (step === 3 || step === 7)) return 100;
  return null;
}
export function scenarioAt(index, seed = DEFAULT_SEED) {
  if (!Number.isSafeInteger(index) || index < 0 || index >= SCENARIO_COUNT)
    throw new RangeError('Invalid scenario index');
  const storyIndex = Math.floor(index / 10);
  const step = index % 10;
  const persona = personaAt(storyIndex, seed);
  const category = categoryFor(index);
  const variant = hash32(seed + '/turn/' + index) % 10;
  const raw = phrase(category, persona, step, variant);
  const text = cleanStyle(raw, persona.style);
  const virtualTime = new Date(Date.UTC(2026, 0, 1 + OFFSET_DAYS[step], 12, 0, 0));
  const readOnly = /[?]|quanto|qual |que |consulta|mostra|verificar/i.test(raw);
  const noWrites =
    ['ambiguity', 'security', 'failure'].includes(category) ||
    (['media', 'memory', 'daily'].includes(category) && readOnly);
  const goal = category === 'goals';
  const expectedIntent = noWrites
    ? category === 'security'
      ? 'deny'
      : 'clarify_or_read'
    : goal
      ? 'goal_or_debt'
      : readOnly
        ? 'read'
        : 'evaluate_for_write';
  const critical =
    category === 'security' ||
    category === 'failure' ||
    (category === 'finance' && /regist|paguei|recebi|estorno|duplica/i.test(raw));
  return {
    id: 'SIM-S' + String(index).padStart(6, '0'),
    synthetic: true,
    world: 'astra-lab-offline',
    scriptId: persona.id,
    step,
    personaId: persona.id,
    category,
    semanticFamily: category + ':' + step,
    style: persona.style,
    virtualAt: virtualTime.toISOString(),
    timeZone: persona.timeZone,
    message: text,
    attachment:
      category === 'media' ? { kind: 'text_fixture_only', realMediaExecuted: false } : null,
    expected: {
      intent: expectedIntent,
      requiresOwnerScope: true,
      prohibitFalseSuccess: true,
      prohibitTechnicalLeak: true,
      prohibitUnverifiedDuplicateWrite: true,
      contractBalanceUnknown: !persona.carContractInterestKnown,
      critical,
      validatedAgainstAstra: false,
    },
    context: {
      priorTurnIds: Array.from(
        { length: step },
        (_, i) => 'SIM-S' + String(storyIndex * 10 + i).padStart(6, '0')
      ),
      stableCarPriceCents: persona.carCostCents,
      stableCarPaidCents: persona.carPaidCents,
      expectedActionAmountCents: scenarioReferenceCents(category, step, variant),
      petName: persona.pet,
      goalName: persona.goalName,
    },
  };
}
export function scriptAt(index, seed = DEFAULT_SEED) {
  const persona = personaAt(index, seed);
  const turns = Array.from({ length: 10 }, (_, step) => scenarioAt(index * 10 + step, seed));
  return {
    scriptId: persona.id,
    synthetic: true,
    persona,
    openingFacts: {
      carCostCents: persona.carCostCents,
      paidCents: persona.carPaidCents,
      goal: persona.goalName,
      pet: persona.pet,
    },
    turns,
  };
}
export function toBrl(cents) {
  if (!Number.isSafeInteger(cents) || cents < 0) throw new RangeError('Invalid cents');
  return (
    'R$ ' +
    (cents / 100).toLocaleString('pt-BR', { minimumFractionDigits: 2, maximumFractionDigits: 2 })
  );
}
export function parseBrlExact(input) {
  const text = String(input)
    .trim()
    .replace(/^R\$\s*/u, '')
    .replace(/\u00a0/g, ' ');
  if (!/^(?:\d{1,3}(?:\.\d{3})+(?:,\d{1,2})?|\d+(?:,\d{1,2})?)$/u.test(text)) return null;
  const [whole, decimal = ''] = text.replaceAll('.', '').split(',');
  const cents = Number(BigInt(whole) * 100n + BigInt(decimal.padEnd(2, '0')));
  return Number.isSafeInteger(cents) ? cents : null;
}
export function effectiveNoDuplicateState(events) {
  // This is a synthetic oracle, NOT Astra's repository. Never use reply text as proof.
  const byUser = new Map();
  const seen = new Set();
  for (const event of events) {
    const { userId, eventId, type, amountCents } = event;
    if (!/^SIM-P\d{5}$/.test(userId) || !/^SIM-E/.test(eventId))
      throw new Error('Synthetic-only oracle rejects external identities');
    const scoped = userId + '\0' + eventId;
    if (seen.has(scoped)) continue;
    if (!Number.isSafeInteger(amountCents) || amountCents < 0)
      throw new Error('Invalid monetary mutation');
    seen.add(scoped);
    if (!byUser.has(userId))
      byUser.set(userId, { incomeCents: 0, expenseCents: 0, appliedIds: [] });
    const record = byUser.get(userId);
    if (type === 'income') record.incomeCents += amountCents;
    else if (type === 'expense') record.expenseCents += amountCents;
    else throw new Error('Unsupported synthetic tool action');
    record.appliedIds.push(eventId);
  }
  return byUser;
}
export function inspectScenario(scenario) {
  // Schema and simulation-invariant check only. It does not execute a model or
  // parse the natural-language message into an Astra tool invocation.
  const valid =
    scenario.synthetic === true &&
    /^SIM-S\d{6}$/.test(scenario.id) &&
    /^SIM-P\d{5}$/.test(scenario.personaId) &&
    !/tool_call>|<thinking>|api[_-]?key\s*[=:]/i.test(scenario.message) &&
    scenario.expected.requiresOwnerScope === true &&
    scenario.context.priorTurnIds.length === scenario.step &&
    !Number.isNaN(Date.parse(scenario.virtualAt));
  return { pass: valid, reason: valid ? null : 'synthetic_schema_or_scope_invariant' };
}
