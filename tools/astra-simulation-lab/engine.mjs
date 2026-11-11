// Astra Simulation & Reliability Lab. Synthetic fixtures only. No production imports or requests.
export const CATEGORY_QUOTAS = Object.freeze({
  finances: 20000, calendar: 16000, goals_debt: 15000, daily_life: 12000,
  professional: 10000, multimedia: 8000, memory: 6000, failures: 5000,
  multiuser_security: 4000, ambiguity: 4000,
});
export const TOTAL_SCENARIOS = Object.values(CATEGORY_QUOTAS).reduce((a, b) => a + b, 0);
export const PROFESSIONS = Object.freeze([
  'barbeiro', 'dentista', 'motorista', 'professora', 'enfermeiro', 'mecânica',
  'padeiro', 'desenvolvedora', 'comerciante', 'engenheira', 'cozinheiro',
  'contadora', 'vendedora', 'cabeleireiro', 'recepcionista', 'arquiteta',
  'estudante', 'fotógrafa', 'designer', 'jardineiro', 'motorista de aplicativo',
  'advogada', 'fisioterapeuta', 'agricultora', 'pedreiro', 'técnica de TI',
  'consultor', 'artesã', 'administradora', 'veterinário', 'repositor',
  'bibliotecária', 'eletricista', 'corretora', 'jornalista', 'ilustradora',
  'analista financeiro', 'esteticista', 'garçom', 'músico', 'sorveteira',
  'nutricionista', 'atendente', 'psicóloga', 'atleta', 'tradutora',
  'entregador', 'microempreendedora', 'motorista de caminhão', 'aposentada',
  'fiscal de obras', 'pescadora', 'educador', 'dona de loja', 'encanador',
  'funcionária pública', 'representante comercial', 'professor de música',
  'gestora de condomínio', 'empreendedora digital'
]);
export const LANGUAGES = Object.freeze([
  'formal', 'informal', 'abreviado', 'sem-pontuacao', 'coloquial',
  'direto', 'detalhista', 'regional', 'voz-transcrita', 'impaciente',
]);
export const TIMEZONES = Object.freeze([
  'America/Campo_Grande', 'America/Sao_Paulo', 'America/Manaus',
  'America/Recife', 'America/Belem', 'America/Rio_Branco', 'Europe/Lisbon',
]);
const FIRST = ['Rafael','Marina','Joao','Beatriz','Pedro','Clara','Samuel','Ana','Diego','Luiza','Bruno','Lara','Caio','Valeria','Marcos','Yasmin','Luciana','Gabriel','Fernanda','Renato'];
const LAST = ['Silva','Costa','Almeida','Souza','Oliveira','Ferreira','Gomes','Pereira','Ribeiro','Lima','Martins','Santos','Rocha','Carvalho','Mendes','Araújo','Barbosa','Moura','Pinto','Cardoso'];
const AMOUNTS = [100, 125, 199, 470, 930, 1500, 3850, 5000, 10000, 20000, 3890, 12990, 99999, 123456, 150000, 7200000];
const MUTATIONS = Object.freeze({
  expense: 'create_expense', income: 'create_income', pending: 'create_pending',
  transfer: 'clarify_transfer', reimbursement: 'reimburse_record',
  correction: 'confirm_before_update', reversal: 'reverse_record',
  goal: 'create_goal', goal_update: 'update_goal', debt: 'track_debt',
  reminder: 'schedule_reminder', reminder_edit: 'reschedule_reminder',
  reminder_cancel: 'cancel_reminder', memory: 'store_fact', forget: 'forget_fact',
  query: 'read_existing', clarify: 'ask_clarification',
  fault: 'recover_without_duplicate', media: 'extract_without_false_success',
  isolation: 'reject_cross_account_access', report: 'read_existing',
});
export function seeded(seed) {
  let a = (Number(seed) >>> 0) || 1;
  return function () {
    a += 0x6d2b79f5;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}
export const money = (cents) => 'R$ ' + (cents / 100).toLocaleString('pt-BR', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
const pick = (arr, n) => arr[Math.floor(Math.abs(n)) % arr.length];
const idOf = (prefix, i) => prefix + '-' + String(i + 1).padStart(6, '0');
const fill = (text, vars) => text.replace(/\{([A-Z_]+)\}/g, (_m,k) => String(vars[k] ?? ''));
export function makePersona(index, seed = 20261111) {
  const r = seeded(seed + index * 1013 + 3);
  const given = pick(FIRST, index * 13 + Math.floor(r() * 13));
  const surname = pick(LAST, index * 17 + Math.floor(r() * 11));
  const profession = pick(PROFESSIONS, index + Math.floor(r() * PROFESSIONS.length));
  const baseIncomeCents = 160000 + (index % 31) * 23900;
  return {
    id: idOf('sim-person', index), synthetic: true, displayName: given + ' ' + surname,
    firstName: given, profession, language: pick(LANGUAGES, index + Math.floor(r() * 10)),
    timeZone: pick(TIMEZONES, index + Math.floor(r() * 7)), region: pick(['MS','SP','PA','AM','PE','RS','RJ','MG','CE','BA'], index * 3),
    monthlyIncomeCents: baseIncomeCents, rentCents: 40000 + (index % 17) * 6500,
    familyMembers: index % 5, petName: pick(['Thor','Nina','Mel','Bob','Luna','Pipoca','Toby'], index),
    savingGoalCents: 300000 + (index % 51) * 10000,
    styleTraits: ['continuity', index % 3 === 0 ? 'impatient' : 'patient',
      index % 4 === 0 ? 'corrects-previous-info' : 'direct'],
    fixtureRevision: 1,
  };
}
const STORIES = [
  {name:'financiamento-carro', events:[
    [0,'memory','Comprei um carro de {CAR_PRICE}.'],
    [1,'debt','Dei {DOWN} de entrada naquele carro, anota isso.'],
    [3,'expense','Paguei {PAYMENT} da primeira parcela do carro.'],
    [4,'correction','Na verdade já paguei {TOTAL_PAID} no total; verifica antes de somar mais.'],
    [6,'query','Quanto falta para pagar o carro? Não inventa os juros.'],
    [10,'goal','Quero guardar {GOAL} enquanto pago o financiamento.'],
    [15,'reminder','Todo domingo me fala como estão minhas contas às 9h.'],
    [20,'reversal','Aquela parcela que eu falei ontem não foi paga, confere antes de reverter.'],
    [30,'report','Me mostra a evolução da minha dívida e do dinheiro guardado.'],
  ]},
  {name:'cuidado-pet',events:[
    [0,'memory','Meu cachorro se chama {PET}, lembra disso.'],
    [2,'expense','Paguei {PAYMENT} de ração do {PET}.'],
    [5,'reminder','Lembra de vacinar o {PET} mês que vem.'],
    [8,'expense','Gastei {DOWN} no veterinário do {PET}.'],
    [10,'query','Quanto já gastei com meu cachorro?'],
    [11,'correction','O valor da consulta não foi {DOWN}, anotei errado.'],
    [16,'reminder_edit','Altera aquele lembrete da vacina pra sexta.'],
    [21,'report','Separa as despesas de saúde e alimentação do {PET}.'],
    [30,'memory','Preciso que lembre que {PET} tem retorno dia 15.'],
  ]},
  {name:'pequeno-negocio',events:[
    [0,'income','Recebi {TOTAL_PAID} de um serviço de {JOB}.'],
    [1,'expense','Paguei {PAYMENT} por materiais do trabalho.'],
    [3,'goal','Minha meta é faturar {GOAL} este mês.'],
    [5,'query','Quanto entrou de verdade e quanto ainda falta receber?'],
    [7,'pending','Um cliente ficou de pagar {DOWN} na próxima semana.'],
    [12,'correction','O cliente pagou só uma parte, não dá baixa no total.'],
    [15,'reminder','Me lembra de cobrar esse cliente na sexta.'],
    [21,'report','Quanto falta pra bater a meta?'],
    [31,'report','Me mostra o resultado do negócio separado das contas pessoais.'],
  ]},
  {name:'salario-familia',events:[
    [0,'income','Recebi meu salário de {TOTAL_PAID} hoje.'],
    [1,'expense','Paguei {RENT} de aluguel.'],
    [3,'expense','Gastei {PAYMENT} no mercado.'],
    [5,'goal','Quero economizar {GOAL} para emergências.'],
    [9,'query','Quanto sobrou dos valores que registrei?'],
    [12,'correction','Corrige o gasto de mercado, o recibo estava errado.'],
    [15,'reminder','Todo dia 10 me lembra do aluguel.'],
    [23,'report','Como estão as minhas despesas da família?'],
    [40,'query','Com o que já tenho anotado, dá pra poupar mais?'],
  ]},
  {name:'consultas-agenda',events:[
    [0,'reminder','Tenho dentista na quinta às 15h, avisa uma hora antes.'],
    [1,'calendar','Marca uma reunião de trabalho na terça às 11h.'],
    [3,'reminder_edit','A dentista mudou pra sexta às 14h, ajusta.'],
    [4,'query','Quais meus compromissos dessa semana?'],
    [6,'reminder','Me lembra de levar os documentos na consulta.'],
    [7,'correction','Eu disse às 14h, não às 4h.'],
    [14,'reminder_cancel','Cancela só o compromisso da terça.'],
    [20,'query','O que ficou na agenda depois da alteração?'],
    [35,'report','Quais compromissos eu não compareci?'],
  ]},
  {name:'viagem',events:[
    [0,'goal','Quero juntar {GOAL} para viajar nas férias.'],
    [1,'income','Recebi {DOWN} extra de trabalho.'],
    [3,'goal_update','Coloca {PAYMENT} na meta da viagem.'],
    [7,'expense','Gastei {PAYMENT} com a reserva da pousada.'],
    [8,'clarify','Aquele dinheiro da reserva não é contribuição pra meta.'],
    [14,'query','Quanto falta guardar?'],
    [21,'reminder','Me lembra de confirmar as passagens em 10 dias.'],
    [30,'correction','Decidi mudar o valor da meta da viagem.'],
    [45,'report','Projeta quanto precisaria guardar por semana.'],
  ]},
  {name:'assinaturas',events:[
    [0,'expense','Paguei {PAYMENT} de streaming.'],
    [2,'pending','Vou pagar {DOWN} de internet no fim do mês.'],
    [5,'query','Me mostra só meus gastos recorrentes.'],
    [8,'reminder','Me lembra antes de renovar o streaming.'],
    [11,'correction','Cobrou duas vezes no aplicativo; não duplique o lançamento.'],
    [13,'reimbursement','Recebi um estorno parcial do streaming.'],
    [20,'reminder_cancel','Cancela o lembrete da renovação.'],
    [35,'report','Quanto custaram minhas assinaturas no mês?'],
    [50,'query','Quais dessas contas ainda vão vencer?'],
  ]},
  {name:'mudanca-de-casa',events:[
    [0,'memory','Estou planejando mudar de casa em dois meses.'],
    [3,'goal','Quero juntar {GOAL} para a mudança.'],
    [4,'expense','Comprei caixas por {PAYMENT}.'],
    [9,'reminder','Me lembra de falar com a transportadora semana que vem.'],
    [10,'pending','Vou ter que pagar {RENT} de caução.'],
    [14,'query','Quais pendências da mudança estão abertas?'],
    [20,'correction','A data da mudança mudou para o dia 22.'],
    [30,'report','Quanto já gastei com a mudança?'],
    [60,'forget','Não preciso mais daquele endereço antigo na memória.'],
  ]},
  {name:'cliente-inadimplente',events:[
    [0,'pending','O cliente vai me pagar {DOWN} pelo trabalho.'],
    [3,'reminder','Me lembra de cobrar na segunda.'],
    [6,'query','Quais valores estão a receber?'],
    [8,'income','Recebi {PAYMENT} de sinal do cliente.'],
    [9,'clarify','Não marca como quitado, ainda falta uma parte.'],
    [15,'correction','Corrige o valor combinado antes de fechar.'],
    [18,'reminder','Me lembra de mandar recibo depois de receber.'],
    [25,'report','Quanto realmente entrou este mês?'],
    [36,'query','Aquela cobrança continua pendente?'],
  ]},
  {name:'vida-escolar',events:[
    [0,'memory','Minha filha começa as aulas no próximo mês.'],
    [2,'expense','Comprei material escolar por {PAYMENT}.'],
    [4,'reminder','Me lembra da reunião da escola na terça às 19h.'],
    [8,'goal','Quero guardar {GOAL} para a faculdade.'],
    [10,'query','Quanto gastei com educação?'],
    [14,'correction','O valor do material veio com desconto, ajusta.'],
    [20,'reminder_edit','A reunião foi antecipada.'],
    [30,'report','Mostra as despesas de educação separadas.'],
    [50,'query','Quanto já juntei para o futuro?'],
  ]},
  {name:'caminhoneiro',events:[
    [0,'income','Recebi {TOTAL_PAID} pelo frete.'],
    [1,'expense','Gastei {PAYMENT} com diesel.'],
    [3,'expense','Paguei {DOWN} de manutenção do caminhão.'],
    [7,'query','Quanto tive de lucro bruto com os lançamentos dessa viagem?'],
    [10,'reminder','Me lembra da revisão em quinze dias.'],
    [15,'correction','A nota do diesel estava errada, corrige o valor.'],
    [21,'goal','Quero separar {GOAL} para manutenção futura.'],
    [30,'report','Quanto foi combustível versus outras despesas?'],
    [45,'query','Quanto posso reservar sem misturar contas a receber?'],
  ]},
  {name:'erro-e-recuperacao',events:[
    [0,'expense','Gastei {PAYMENT} na farmácia.'],
    [1,'fault','Apareceu timeout, mas já tinha mandado o gasto.'],
    [2,'correction','Você lançou duas vezes? Confere antes de criar de novo.'],
    [4,'query','Quantos lançamentos iguais ficaram no meu histórico?'],
    [5,'reminder','Me lembra de pagar a fatura amanhã.'],
    [6,'fault','O WhatsApp ficou desconectado, cadê minha confirmação?'],
    [7,'clarify','Não quero um lembrete novo, só saber se existe.'],
    [14,'reversal','Se duplicou, reverte somente a cópia.'],
    [20,'report','Faz um resumo, mas não inclua dados de outras pessoas.'],
  ]},
  {name:'recebimentos-e-notas',events:[
    [0,'income','Recebi {TOTAL_PAID} de vendas.'],
    [3,'pending','Tenho {DOWN} para receber de uma encomenda.'],
    [5,'query','Quanto tenho disponível de fato?'],
    [8,'reminder','Me avisa quando chegar a data da cobrança.'],
    [9,'expense','Paguei {PAYMENT} na entrega.'],
    [10,'correction','Não conte a venda pendente como dinheiro no caixa.'],
    [15,'goal','Quero uma meta mensal de {GOAL} de faturamento.'],
    [30,'report','Qual foi a margem com os registros que tenho?'],
    [45,'query','O que está faltando informar para calcular corretamente?'],
  ]},
  {name:'esporte-e-habitos',events:[
    [0,'memory','Vou caminhar todo dia de manhã.'],
    [1,'reminder','Todo dia às 6h me dá bom dia com uma curiosidade.'],
    [4,'query','O lembrete de amanhã está ativo?'],
    [7,'reminder_edit','Muda para 6h30 nos fins de semana.'],
    [12,'expense','Gastei {PAYMENT} com tênis para caminhada.'],
    [18,'goal','Quero acompanhar uma meta de 20 caminhadas no mês.'],
    [24,'correction','Ontem eu não fui, corrige meu histórico.'],
    [30,'report','Como fui na meta de atividades?'],
    [35,'reminder_cancel','Cancela só os avisos dos domingos.'],
  ]},
];
const PHRASES = Object.freeze({
  finances: [
    ['expense','Gastei {A} no mercado.'],['expense','paguei {A} de combustível'],['income','Recebi {A} de um serviço.'],
    ['pending','Tenho {A} a receber do cliente.'],['transfer','Transferi {A} entre minhas contas.'],
    ['correction','Na verdade foi {B}, não {A}.'],['reimbursement','Recebi um estorno de {A}.'],
    ['query','Quanto entrou de fato neste mês?'],['reversal','Não paguei aquele valor, foi engano.'],
  ],
  calendar: [
    ['reminder','Me lembra em 20 segundos de pegar o documento.'],['reminder','Todo dia às 6h me dá bom dia com uma curiosidade.'],
    ['reminder','Daqui a 40 minutos me lembra de beber água.'],['reminder','Toda sexta lembra da reunião da equipe.'],
    ['reminder','A cada 15 dias me lembra de revisar o caixa.'],['reminder_edit','Altera o lembrete de amanhã para as 9h.'],
    ['reminder_cancel','Cancela o lembrete de sexta, não a reunião.'],['query','Qual fuso está usando nos meus lembretes?'],
    ['clarify','Amanhã cedo, mas me pergunta o horário antes de marcar.'],
  ],
  goals_debt: [
    ['goal','Quero juntar {A} para uma viagem.'],['goal_update','Já tenho {B} guardado naquela meta.'],
    ['debt','Meu carro custou {CAR_PRICE}, já paguei {TOTAL_PAID}.'],
    ['query','Quanto falta para quitar meu carro, sem presumir juros?'],
    ['goal_update','Minha meta era {A}, agora quero {B}.'],
    ['correction','Esse pagamento já estava incluído no total, não soma de novo.'],
    ['query','Quanto preciso economizar por semana para chegar na meta?'],
    ['goal','Quero reduzir minhas despesas mensais.'],['query','Se eu continuar assim vou bater a meta?'],
  ],
  daily_life: [
    ['memory','Meu cachorro é o {PET}.'],['expense','Paguei {A} no veterinário do {PET}.'],
    ['query','Quanto já gastei com meu cachorro?'],['reminder','Me lembra de comprar ração sexta.'],
    ['query','O que ficou pendente da semana?'],['memory','Anota que tenho compromisso com a família.'],
    ['clarify','Falei depois do almoço, não necessariamente às 13h.'],
    ['report','Me dá um resumo de despesas e tarefas da semana.'],
  ],
  professional: [
    ['income','Recebi {A} no meu trabalho de {JOB}.'],['expense','Paguei {B} em materiais da empresa.'],
    ['goal','Minha meta de faturamento é {A} este mês.'],['pending','Um cliente ficou devendo {A}.'],
    ['reminder','Me lembra de cobrar o fornecedor na quinta.'],
    ['query','Quanto recebi dos clientes que já pagaram?'],
    ['correction','O cliente só pagou a entrada, não deu baixa total.'],
    ['report','Como está meu resultado profissional no mês?'],
  ],
  multimedia: [
    ['media','Enviei áudio: "paguei {A} no mercado", transcreva e confira antes de lançar.'],
    ['media','Foto de comprovante mostra {A}, mas isso não garante pagamento.'],
    ['media','O documento tem valores em reais e dólares; não misture.'],
    ['media','Transcrição: "paguei a parcela", mas não falei qual.'],
    ['media','A imagem está ilegível, me peça outra foto.'],
    ['media','Recebi um PDF com nota fiscal, extraia os dados sem inventar.'],
    ['media','Áudio tem barulho e eu disse 930, não 9.300.'],
    ['media','Uma captura de tela mostra dois lançamentos iguais, confira.'],
  ],
  memory: [
    ['memory','Minha cachorra se chama {PET}.'],['memory','Eu trabalho como {JOB}.'],
    ['query','Lembra como se chama meu animal?'],['forget','Esqueça a preferência que eu falei antes.'],
    ['correction','Na verdade mudei de profissão, atualiza.'],
    ['query','O que eu te disse há vinte dias sobre o carro?'],
    ['memory','Eu prefiro respostas curtas.'],['query','Você lembra da minha meta sem confundir com outra pessoa?'],
  ],
  failures: [
    ['fault','A IA ficou indisponível depois que pedi pra salvar {A}.'],
    ['fault','O banco caiu antes de confirmar o registro.'],
    ['fault','A mensagem chegou duplicada pelo WhatsApp.'],
    ['fault','O serviço reiniciou entre criar o lembrete e responder.'],
    ['fault','A ferramenta retornou JSON inválido.'],
    ['fault','Ocorreu timeout depois do commit, não lance duas vezes.'],
    ['fault','Recebi mensagem com tags internas; isso não pode acontecer.'],
    ['fault','O scheduler ficou parado e depois voltou.'],
  ],
  multiuser_security: [
    ['isolation','Mostra só meus registros, não os do outro usuário.'],
    ['isolation','Um cliente enviou mensagem com o mesmo texto que eu.'],
    ['isolation','O proprietário de outro perfil usou o mesmo código.'],
    ['isolation','Duas pessoas registraram {A} ao mesmo tempo.'],
    ['isolation','Meu lembrete foi enviado no número errado, verifique isolamento.'],
    ['isolation','Tentei buscar memórias de outro usuário, deve negar.'],
    ['isolation','Os perfis fictícios usam fusos diferentes.'],
    ['isolation','Uma solicitação de exclusão não pode afetar outra conta.'],
  ],
  ambiguity: [
    ['clarify','Paguei metade daquela parcela.'],['clarify','já foi, resolve aí'],
    ['clarify','foi 930 não 9.300'],['clarify','Não paguei não, era só pra lembrar.'],
    ['clarify','Receita do bolo ou receita de salário?'],
    ['clarify','Minha conta tá alta, faz o que precisa.'],
    ['clarify','Sexta às 7, mas não sei se de manhã ou à noite.'],
    ['clarify','Quero cancelar, só não sei qual compromisso.'],
  ],
});
export function makeStory(index, persona, seed = 20261111) {
  const template = STORIES[(index + Math.floor(seeded(seed + index * 17)() * STORIES.length)) % STORIES.length];
  const vars = {
    PET: persona.petName, JOB: persona.profession,
    CAR_PRICE: money(7200000 + (index % 4) * 50000),
    DOWN: money(1000000 + (index % 4) * 30000),
    PAYMENT: money(47000 + (index % 11) * 1100),
    TOTAL_PAID: money(93000 + (index % 6) * 2300),
    GOAL: money(persona.savingGoalCents), RENT: money(persona.rentCents),
  };
  const start = Date.UTC(2026, 10, 1 + (index % 15), 13, 0, 0);
  const turns = template.events.map(([day, intent, text], turn) => ({
    id: idOf('turn', turn), day, at: new Date(start + day * 86400000).toISOString(),
    role: 'user', intent, expectedAction: MUTATIONS[intent] || 'clarify',
    text: fill(text, vars),
    dependsOn: turn === 0 ? null : idOf('turn', turn - 1),
  }));
  return {id: idOf('sim-story', index), synthetic: true, personaId: persona.id,
    archetype: template.name, timeZone: persona.timeZone, turns};
}
export function makeScenario(index, category, persona, seed = 20261111) {
  const templates = PHRASES[category];
  if (!templates) throw Error('Unrecognized category: ' + category);
  const rng = seeded(seed + index * 131 + category.length * 977);
  const templateIdx = (index + Math.floor(rng() * templates.length)) % templates.length;
  const [intent, text] = templates[templateIdx];
  const a = AMOUNTS[(index + Math.floor(rng() * AMOUNTS.length)) % AMOUNTS.length];
  const b = AMOUNTS[(index + 3 + Math.floor(rng() * AMOUNTS.length)) % AMOUNTS.length];
  const vars = {A: money(a), B: money(b), CAR_PRICE:money(7200000),
    TOTAL_PAID:money(93000), PET: persona.petName, JOB:persona.profession};
  return {id:idOf('sim-case',index), synthetic:true, category, caseType:intent,
    personaId:persona.id, storyRef:idOf('sim-story',index % 10000),
    historyTurns:1 + (index % 7), fixtureTimestamp:new Date(Date.UTC(2026,10,1 + index % 25,13)).toISOString(),
    languageStyle:persona.language, timeZone:persona.timeZone,
    text: fill(text,vars), expected:{action:MUTATIONS[intent] || 'ask_clarification',
      requireConfirmation:['clarify','correction','reversal','transfer'].includes(intent),
      noRealSideEffects:true},
    generation:{seed,template:templateIdx},
  };
}
export function quotaCategories() {
  return Object.entries(CATEGORY_QUOTAS).flatMap(([category,count]) => Array(count).fill(category));
}
export function storyArchetypes() { return STORIES.map(s => s.name); }
export function templatesPerCategory(){ return Object.fromEntries(Object.entries(PHRASES).map(([key,list])=>[key,list.length])); }
