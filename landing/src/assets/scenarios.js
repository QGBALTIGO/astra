/** Public, fictional examples. Monetary arithmetic uses integer centavos. */
export const base = Object.freeze({ income: 480000, expenses: 158200, goal: 260000, target: 400000 });
export const scenarios = Object.freeze([
  { id: 'financas', label: 'Finanças', icon: 'wallet', tab: 'transacoes', tag: 'Uma despesa, sem planilha',
    user: 'Astra, gastei R$ 42 no almoço de hoje.', reply: 'Anotado: R$ 42,00 em Alimentação. Seu almoço já está nos registros.',
    record: 'Almoço registrado', detail: 'Alimentação · Hoje, 12/11', amount: 4200, kind: 'expense', cta: 'Despesa adicionada' },
  { id: 'agenda', label: 'Agenda', icon: 'calendar', tab: 'agenda', tag: 'Cada compromisso no seu lugar',
    user: 'Tenho dentista dia 13 de novembro, às 15h. Me avisa uma hora antes.', reply: 'Dentista na agenda: 13/11, às 15h. Lembrete marcado para as 14h.',
    record: 'Dentista', detail: '13 de novembro · 15:00', time: '15:00', note: 'Aviso no WhatsApp às 14h', kind: 'event', cta: 'Compromisso organizado' },
  { id: 'lembretes', label: 'Lembretes', icon: 'bell', tab: 'agenda', tag: 'Lembrar também pode ser leve',
    user: 'Me lembra de pagar a internet dia 15 de novembro às 9h.', reply: 'Combinado. Dia 15/11, às 9h, eu te lembro de pagar a internet pelo WhatsApp.',
    record: 'Pagar a internet', detail: '15 de novembro · 09:00', time: '09:00', note: 'Lembrete no WhatsApp', kind: 'reminder', cta: 'Lembrete programado' },
  { id: 'tarefas', label: 'Tarefas', icon: 'check', tab: 'agenda', tag: 'Uma pendência a menos na cabeça',
    user: 'Adiciona revisar o contrato para dia 16 de novembro às 10h.', reply: 'Tarefa criada: revisar o contrato. Prazo em 16/11, às 10h.',
    record: 'Revisar o contrato', detail: '16 de novembro · 10:00', time: '10:00', note: 'Pendente · Trabalho', kind: 'task', cta: 'Tarefa criada' },
  { id: 'familia', label: 'Família', icon: 'home', tab: 'agenda', tag: 'Os detalhes de quem você cuida',
    user: 'Reunião da escola dia 18 de novembro às 19h. Me lembra às 18h.', reply: 'Reunião da escola registrada para 18/11, às 19h. O lembrete ficou para as 18h.',
    record: 'Reunião da escola', detail: '18 de novembro · 19:00', time: '19:00', note: 'Aviso no WhatsApp às 18h', kind: 'event', cta: 'Rotina familiar organizada' },
  { id: 'trabalho', label: 'Trabalho', icon: 'briefcase', tab: 'transacoes', tag: 'O trabalho feito, o valor anotado',
    user: 'Recebi R$ 850 do projeto de design hoje.', reply: 'Receita registrada: R$ 850,00 pelo projeto de design, na categoria Trabalho.',
    record: 'Projeto de design', detail: 'Trabalho · Hoje, 12/11', amount: 85000, kind: 'income', cta: 'Receita adicionada' },
  { id: 'estudos', label: 'Estudos', icon: 'book', tab: 'agenda', tag: 'Abra espaço para aprender',
    user: 'Me lembra de estudar inglês todo dia às 20h, a partir de 13 de novembro.', reply: 'Lembrete diário criado: estudar inglês às 20h, começando em 13/11.',
    record: 'Estudar inglês', detail: 'A partir de 13/11 · 20:00', time: '20:00', note: 'Repete todos os dias', kind: 'reminder', cta: 'Lembrete recorrente criado' },
  { id: 'metas', label: 'Metas', icon: 'target', tab: 'inicio', tag: 'Seu próximo plano ganha forma',
    user: 'Quero juntar R$ 4.000 para viajar. Já guardei R$ 2.600.', reply: 'Meta Viagem registrada: R$ 2.600,00 de R$ 4.000,00. Você já está em 65% do caminho.',
    record: 'Viagem', detail: 'R$ 2.600 de R$ 4.000', note: '65% do objetivo registrado', kind: 'goal', cta: 'Meta organizada' },
  { id: 'viagens', label: 'Viagens', icon: 'plane', tab: 'transacoes', tag: 'Até fora da rotina, tudo em ordem',
    user: 'Paguei R$ 380 na reserva da pousada para a viagem.', reply: 'Registrei R$ 380,00 em Viagens, com a descrição Reserva da pousada.',
    record: 'Reserva da pousada', detail: 'Viagens · Hoje, 12/11', amount: 38000, kind: 'expense', cta: 'Gasto da viagem registrado' }
]);
export function money(cents) {
  return (cents / 100).toLocaleString('pt-BR', { style: 'currency', currency: 'BRL' });
}
export function scenarioState(scenario) {
  const income = base.income + (scenario.kind === 'income' ? scenario.amount : 0);
  const expenses = base.expenses + (scenario.kind === 'expense' ? scenario.amount : 0);
  const categories = [
    { name: 'Casa', amount: 95000, color: 'navy' },
    { name: 'Alimentação', amount: 37800 + (scenario.id === 'financas' ? scenario.amount : 0), color: 'blue' },
    { name: 'Transporte', amount: 17400, color: 'sky' },
    { name: 'Outros', amount: 8000, color: 'gray' },
    ...(scenario.id === 'viagens' ? [{ name: 'Viagens', amount: scenario.amount, color: 'violet' }] : [])
  ];
  return { income, expenses, balance: income - expenses, categories,
    goalPercent: Math.round(base.goal / base.target * 100) };
}
