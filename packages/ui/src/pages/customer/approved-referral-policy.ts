import type { CustomerReferralRecord } from './referrals-api';
export type ReferralStatus =
  'trial' | 'awaiting_payment' | 'validating' | 'available' | 'paid' | 'ineligible';
export type ReferralRecord = Omit<CustomerReferralRecord, 'status'> & {
  status: ReferralStatus;
  reason?: string;
  source: CustomerReferralRecord;
};
export const campaign = { minReward: 20, maxReward: 100, rewardLimit: 5 } as const;
export const statusLabels: Record<ReferralStatus, string> = {
  trial: 'Em teste',
  awaiting_payment: 'Aguardando assinatura',
  validating: 'Aguardando validação',
  available: 'Recompensa aprovada',
  paid: 'Pagamento confirmado',
  ineligible: 'Não elegível',
};
export const referralSteps: {
  title: string;
  description: string;
  icon: 'link' | 'whatsapp' | 'sparkles' | 'check';
}[] = [
  {
    title: 'Criar uma conta pelo seu link',
    description:
      'Seu convidado abre o link pessoal antes do primeiro cadastro e entra no painel em até 30 dias, no mesmo navegador.',
    icon: 'link',
  },
  {
    title: 'Ativar o Astra no WhatsApp',
    description: 'Ele confirma o próprio número e começa a usar o assessor pessoal.',
    icon: 'whatsapp',
  },
  {
    title: 'Conhecer o Astra na prática',
    description:
      'Registrar uma movimentação, organizar um compromisso ou criar uma meta são formas de experimentar o assistente.',
    icon: 'sparkles',
  },
  {
    title: 'Concluir uma assinatura elegível',
    description:
      'O pagamento da nova assinatura é conferido manualmente pela equipe. Após a aprovação, sua recompensa aparece no painel e pode ser solicitada por Pix.',
    icon: 'check',
  },
];
export const referralRules = [
  {
    title: 'Uma recompensa entre R$ 20 e R$ 100',
    description:
      'O valor inteiro é aleatório e definido uma única vez depois da validação. Os 81 valores de R$ 20 a R$ 100 têm a mesma chance.',
  },
  {
    title: 'Até 5 recompensas por mês',
    description:
      'O limite considera o mês da aprovação no horário de São Paulo. Uma aprovação anulada antes do Pix permanece na auditoria e continua contando no limite mensal.',
  },
  {
    title: 'Uma pessoa nova, uma indicação',
    description:
      'O convite precisa ser aberto antes do primeiro cadastro e o acesso ao painel deve ocorrer em até 30 dias no mesmo navegador. O primeiro convite válido é preservado. Autoindicações, contas antigas e duplicidades não são elegíveis. A indicação específica de parceiros já registrada é preservada.',
  },
  {
    title: 'Pagamento confirmado primeiro',
    description:
      'Um clique, um teste gratuito ou uma cobrança pendente não libera recompensa. A equipe confere a assinatura paga antes de aprovar. Cancelamentos, reembolsos ou irregularidades podem anular uma recompensa ainda não paga, com o motivo no histórico.',
  },
  {
    title: 'Recebimento manual por Pix',
    description:
      'Depois da aprovação, solicite o pagamento nos detalhes da recompensa e informe uma chave Pix de sua titularidade. A equipe confere os dados, realiza a transferência e registra a confirmação. A solicitação não transfere dinheiro automaticamente.',
  },
  {
    title: 'Seus dados e os do convidado protegidos',
    description:
      'Você acompanha um identificador do convite, datas, situação e recompensa. Nome, telefone e dados de pagamento da pessoa indicada não aparecem no seu painel.',
  },
];
export const referralFaqs = [
  {
    question: 'Quanto posso ganhar por indicação?',
    answer:
      'Uma nova assinatura aprovada gera uma recompensa aleatória em reais inteiros entre R$ 20 e R$ 100. O valor aparece após a validação. São até 5 concessões por participante por mês.',
  },
  {
    question: 'O que faz uma indicação ser aprovada?',
    answer:
      'A pessoa precisa ser um novo cliente, abrir seu link antes do cadastro e acessar o painel em até 30 dias no mesmo navegador. A equipe confere manualmente o pagamento de uma assinatura elegível antes de aprovar.',
  },
  {
    question: 'Quando o valor da recompensa aparece?',
    answer:
      'Depois de a equipe validar a assinatura e aprovar a indicação. Enquanto isso, o painel mostra o andamento sem antecipar um valor.',
  },
  {
    question: 'Como recebo minha recompensa?',
    answer:
      'Abra uma recompensa aprovada, selecione Solicitar Pix e informe uma chave de sua titularidade. A equipe confere os dados, realiza o Pix manualmente e confirma o pagamento no histórico.',
  },
  {
    question: 'Posso ver os dados de quem convidei?',
    answer:
      'O painel apresenta apenas o identificador do convite, a data e a situação. Os dados pessoais do convidado ficam protegidos.',
  },
  {
    question: 'O que acontece se a assinatura for reembolsada?',
    answer:
      'Uma recompensa ainda não paga pode ser anulada pela equipe. O motivo aparece no histórico. Um pagamento já confirmado permanece registrado e não é apagado.',
  },
];
