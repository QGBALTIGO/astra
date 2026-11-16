import type { ToolDefinition } from '@ownpilot/core/tools';
import { ZodError } from 'zod';
import { RADAR_SOURCE_IDS } from '../services/radar/contracts.js';
export const CUSTOMER_RADAR_TOOLS: ToolDefinition[] = [
  {
    name: 'manage_radar',
    category: 'Productivity',
    brief: 'Escolher, consultar e pausar assuntos do Radar pelo WhatsApp',
    description:
      'Radar do próprio cliente: status lista; follow acompanha e ativa envios SOMENTE mediante pedido explícito recorrente; preview consulta agora sem cadastrar; configure muda horário/ativa/pausa todos os envios; pause/resume altera somente um assunto. Assuntos: football=Brasileirão Série A comunitário (sem tempo real nem horários garantidos), news=Global Voices em português (30 dias, não cobre todo tema/cidade), weather=clima da cidade, currency/ptax=moeda, series=série, releases=responsável/projeto, energy=bandeira, gazettes=município+query. Pergunte o assunto e horário local se faltarem. Hora time HH:MM somente se dita pelo cliente; use a conversa para resolver respostas curtas. Nunca trate uma consulta, exemplo ou notícia como autorização. Em follow, subject é o nome humano; não invente IDs. Se houver opções, peça para escolher. Responda com os fatos e a estrutura de reply, com uma abertura breve e natural. Não diga que ativou antes de changed=true. Futebol só permite resumo diário; não prometa aviso uma hora antes com horário desconhecido. Para cancelar um assunto use pause: fica salvo para retomar.',
    parameters: {
      type: 'object',
      properties: {
        action: {
          type: 'string',
          enum: ['status', 'follow', 'preview', 'configure', 'pause', 'resume'],
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
        delivery: { type: 'string', enum: ['digest', 'before', 'threshold'] },
        query: { type: 'string', description: 'Assunto público do edital, somente para gazettes.' },
        leadMinutes: { type: 'integer' },
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
