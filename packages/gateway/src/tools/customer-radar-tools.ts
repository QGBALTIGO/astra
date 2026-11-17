import type { ToolDefinition } from '@ownpilot/core/tools';
import { ZodError } from 'zod';
import { RADAR_SOURCE_IDS } from '../services/radar/contracts.js';
export const CUSTOMER_RADAR_TOOLS: ToolDefinition[] = [
  {
    name: 'manage_radar',
    category: 'Productivity',
    brief: 'Escolher, consultar e pausar assuntos do Radar pelo WhatsApp',
    description:
      'Radar do próprio cliente: status lista; follow acompanha e ativa envios SOMENTE mediante pedido explícito recorrente; preview consulta agora sem cadastrar; configure muda horário/ativa/pausa todos os envios; pause/resume altera somente um assunto. Assuntos: football=Brasileirão Série A (API Dados Futebol quando habilitada; calendário comunitário quando indisponível, sem inventar horários), news=Global Voices em português (30 dias, não cobre todo tema/cidade), weather=clima da cidade, currency/ptax=moeda, series=série, releases=responsável/projeto, energy=bandeira, gazettes=município+query. Pergunte o assunto e, para resumo diário ou matchday, o horário local se faltarem; before usa antecedência, não um relógio fixo. Hora time HH:MM somente se dita pelo cliente; use a conversa para resolver respostas curtas. Nunca trate uma consulta, exemplo ou notícia como autorização. Em follow, subject é o nome humano; não invente IDs. Se houver opções, peça para escolher. Responda com os fatos e a estrutura de reply, com uma abertura breve e natural. Não diga que ativou antes de changed=true. Futebol: me avise quando tiver jogo significa delivery=matchday, somente nos dias de jogo, com time obrigatório escolhido pelo cliente; pergunte em qual horário do dia quer o aviso. Resumo diário é delivery=digest somente quando pedido. Para pedido explícito recorrente antes dos jogos use delivery=before: a antecedência padrão é 60 minutos, alterada somente pelo intervalo escrito pelo cliente (15 a 1440 minutos). O sistema verifica a fonte; não prometa alarme para partida sem horário informado e não confirme antes de changed=true. Para cancelar um assunto use pause: fica salvo para retomar.',
    parameters: {
      type: 'object',
      properties: {
        action: {
          type: 'string',
          enum: ['status', 'follow', 'preview', 'configure', 'pause', 'resume', 'send_now'],
          description:
            'Use send_now SOMENTE para pedido explícito como envie meu Radar agora; é um resumo extra, limitado a um por minuto, sem repetir automaticamente envios incertos. Para perguntas sobre os acompanhamentos use status.',
        },
        source: { type: 'string', enum: [...RADAR_SOURCE_IDS] },
        subject: {
          type: 'string',
          description:
            'Assunto informado pelo cliente: notícias do mundo => mundo; notícias de tecnologia => tecnologia; próximo jogo do Flamengo => Flamengo. Em consultas use action=preview, não peça de novo um assunto que já foi dito.',
        },
        interestId: { type: 'string', description: 'Somente ID retornado por status.' },
        choiceId: { type: 'string', description: 'Somente ID retornado pela busca.' },
        time: {
          type: 'string',
          description: 'HH:MM no fuso do cliente; somente o horário pedido, não invente.',
        },
        enabled: { type: 'boolean' },
        delivery: {
          type: 'string',
          enum: ['digest', 'matchday', 'before', 'threshold'],
          description:
            'Futebol: matchday para me avise quando tiver jogo (só nos dias de jogo, no horário time escolhido); digest para resumo diário explícito; before somente quando o cliente pedir aviso antecipado recorrente. O sistema só envia partidas agendadas com horário informado pela fonte.',
        },
        query: { type: 'string', description: 'Assunto público do edital, somente para gazettes.' },
        leadMinutes: {
          type: 'integer',
          description:
            'Antecedência em minutos explicitamente pedida pelo cliente; padrão 60 quando não informado. Nunca transforme antecedência em time HH:MM.',
        },
        threshold: { type: 'string' },
        comparison: { type: 'string', enum: ['above', 'below'] },
      },
      required: ['action'],
    },
  },
];
export async function executeCustomerRadarTool(
  name: string,
  args: Record<string, unknown>,
  userId = 'default'
) {
  try {
    if (name !== 'manage_radar') throw new Error('Pedido do Radar indisponível.');
    const { manageRadarChat } = await import('../services/radar/chat.js');
    return { success: true, result: await manageRadarChat(userId, args) };
  } catch (error) {
    return {
      success: false,
      error:
        error instanceof ZodError
          ? error.issues[0]?.code === 'custom'
            ? error.issues[0].message
            : 'Confira o assunto, a condição e o horário que você quer para o Radar.'
          : error instanceof Error &&
              /^(?:Me |Entre |Configure |Use |Peça |Envie |Renove |O calendário|Seu |Esse |Essa |Selecione|Escolha|Informe)/.test(
                error.message
              )
            ? error.message
            : 'Não consegui concluir esse pedido do Radar agora. Seus outros assuntos continuam salvos. Tente de novo em instantes.',
    };
  }
}
