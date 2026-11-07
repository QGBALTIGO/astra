import { describe, expect, it } from 'vitest';
import { deterministicChannelReply } from './channel-ai-routing.js';

describe('Astra respostas gratuitas e instantâneas', () => {
  it.each(['oi', 'Oi', 'OLÁ!', 'ola...', 'Bom dia!', 'Boa tarde', 'Boa noite?'])(
    'responde saudação %s sem usar o modelo',
    (message) => {
      expect(deterministicChannelReply(message)).toBe(
        'Oi! Como posso ajudar você hoje?'
      );
    }
  );

  it.each([
    'Oi, me lembre de pagar a conta',
    'Amanhã eu tenho dentista',
    'Quanto gastei hoje?',
    'Bom dia, quero marcar consulta às 10h',
    'Que dia é hoje?',
    'Oi, tudo bem com meus lembretes?',
  ])('encaminha solicitação contextual %s à IA', (message) => {
    expect(deterministicChannelReply(message)).toBeNull();
  });
});
