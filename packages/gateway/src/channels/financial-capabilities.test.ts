import { describe, expect, it, vi } from 'vitest';
import type { ChannelIncomingMessage } from '@ownpilot/core/channels';
import { financialCapabilityReply } from './financial-capabilities.js';
import { processDirectAgent, processViaBus } from './channel-ai-routing.js';

const dbAccess = vi.hoisted(() =>
  vi.fn(() => {
    throw new Error('Unexpected data access');
  })
);
vi.mock('../db/adapters/index.js', () => ({ getAdapter: dbAccess }));
const cases = [
  ['Dá pra fazer um Pix por aqui?', 'app do seu banco'],
  [
    'Você consegue fazer um Pix por mim ou só registrar o que eu já paguei? É só uma dúvida.',
    'app do seu banco',
  ],
  ['Paga essa fatura pra mim, por favor?', 'app do seu banco'],
  [
    'Se eu tirar uma assinatura do meu planejamento aqui no Astra, isso também cancela a cobrança no fornecedor? Quero entender antes de mexer.',
    'serviço em que você assinou',
  ],
  ['Você pode cancelar a minha assinatura no fornecedor?', 'serviço em que você assinou'],
];

describe('financial capabilities of personal messaging', () => {
  it.each(['whatsapp', 'telegram'] as const)(
    'clarifies payment and cancellation without taking action in %s',
    async (platform) => {
      const user = 'ficticio';
      const bus = {
        process: vi.fn(() => {
          throw new Error('Unexpected model call');
        }),
      };
      const allowed = async () => true;
      for (const [text, nextStep] of cases) {
        const msg: ChannelIncomingMessage = {
          id: 'question',
          text: text!,
          platform,
          channelPluginId: 'channel.' + platform,
          platformChatId: user,
          sender: { platform, platformUserId: user },
          timestamp: new Date(),
          metadata: { isGroup: false, chatType: 'private' },
        };
        const direct = await processDirectAgent(msg, user, allowed);
        const viaBus = await processViaBus(
          bus as never,
          msg,
          { sessionId: 'qa', conversationId: null },
          { ownpilotUserId: user },
          { sessionsRepo: {} as never, getChannel: () => undefined, isAccessAllowed: allowed }
        );
        expect(direct).toContain(nextStep);
        expect(viaBus).toBe(direct);
      }
      expect(dbAccess).not.toHaveBeenCalled();
      expect(bus.process).not.toHaveBeenCalled();
    }
  );
  it.each([
    'Paguei R$ 12 por Pix no almoço.',
    'Me lembra amanhã de pagar a fatura do cartão.',
    'Crie a tarefa Fazer um Pix para a oficina.',
    'Escreva uma mensagem para eu pedir um Pix.',
    'Remova do meu planejamento só a assinatura Revista, se ela estiver cadastrada. Não cancele nada no fornecedor.',
    'Quando renova minha assinatura do jornal?',
  ])('preserves requests for a different operation: %s', (text) => {
    expect(financialCapabilityReply('whatsapp', text)).toBeNull();
  });
  it('leaves other integrations in control of their capabilities', () => {
    expect(financialCapabilityReply('slack', 'Faz um Pix?')).toBeNull();
  });
});
