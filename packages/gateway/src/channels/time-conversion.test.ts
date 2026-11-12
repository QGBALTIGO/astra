import { describe, expect, it, vi } from 'vitest';
import type { ChannelIncomingMessage } from '@ownpilot/core/channels';
import { tryChannelTimeConversion } from './time-conversion.js';
import { processDirectAgent, processViaBus } from './channel-ai-routing.js';

const fail = vi.hoisted(() =>
  vi.fn(() => {
    throw new Error(
      'A read-only clock conversion must not reach a provider, a database, or the bus'
    );
  })
);
vi.mock('../services/agent/service.js', () => ({ getOrCreateChatAgent: fail, isDemoMode: fail }));
vi.mock('../db/adapters/index.js', () => ({ getAdapter: fail }));
vi.mock('../services/llm/model-routing.js', () => ({ resolveForChannel: fail }));
const received = new Date('2026-11-17T02:00:00Z'); // Still November 16 in Brasília.
const example =
  'Minha videochamada de terça, dia 17 de novembro de 2026, é às 14h de Brasília. Que horas são aqui em Cuiabá? Só me diga o horário, que eu mesmo marco.';

describe('private channel wall-clock conversions', () => {
  it('preserves minutes and the destination civil day for every pair of supported Brazilian panel cities', () => {
    // Known UTC offsets for this specific day. Historical and DST dates are tested separately.
    const places = [
      ['Brasília', -3],
      ['Cuiabá', -4],
      ['Campo Grande', -4],
      ['Manaus', -4],
      ['Rio Branco', -5],
      ['Fernando de Noronha', -2],
    ] as const;
    for (const [from, originOffset] of places)
      for (const [to, targetOffset] of places)
        for (const hour of [0, 12, 23]) {
          const difference = hour + targetOffset - originOffset;
          const expected =
            String((difference + 24) % 24).padStart(2, '0') +
            ':43' +
            (difference < 0 ? ' de 16/11/2026.' : difference >= 24 ? ' de 18/11/2026.' : '');
          expect(
            tryChannelTimeConversion(
              'Converta ' + hour + 'h43 de ' + from + ' para ' + to + ' em 17/11/2026.',
              received
            )
          ).toBe(expected);
        }
  });
  it.each([
    [example, '13:00'],
    ['Converta 17/11/2026 às 14h30 de Brasília para Cuiabá.', '13:30'],
    ['Que horas são em Brasília se em Cuiabá são 14:00 no dia 17/11/2026?', '15:00'],
    ['Converta 00:15 de Brasília para Rio Branco em 01/01/2027.', '22:15 de 31/12/2026.'],
    ['23h45 de Brasília para Lisboa em 17/11/2026.', '02:45 de 18/11/2026.'],
    ['Converta 8h da noite de Manaus para Fernando de Noronha em 17/11/2026.', '22:00'],
    ['Converta 2 da tarde de São Paulo para Mato Grosso do Sul em 17/11/2026.', '13:00'],
    ['Converta meio-dia de Brasília para Campo Grande em 2026-11-17.', '11:00'],
    ['Converta meia-noite de Brasília para Cuiabá em 2026-11-17.', '23:00 de 16/11/2026.'],
    ['Converta 3 e meia da tarde de Brasília para Cuiabá em 18/11/2026.', '14:30'],
    [
      'No dia 18/11/2026, meia-noite e meia em Brasília dá que horas em Cuiabá?',
      '23:30 de 17/11/2026.',
    ],
    ['Quanto fica 14:30 (Brasília) em Cuiabá em 17/11/2026?', '13:30'],
    ['Converta 2026-11-17T14:00 de UTC para Asia/Kathmandu.', '19:45'],
    ['Converta 12h de America/New_York para UTC em 15/07/2026.', '16:00'],
    ['Converta 12h de America/New_York para UTC em 15/01/2026.', '17:00'],
    ['Converta amanhã, terça, às 14h de Brasília para Cuiabá.', '13:00'],
    ['Converta 05:30 de UTC para America/New_York em 01/11/2026.', '01:30 (GMT-04:00)'],
    ['Converta 06:30 de UTC para America/New_York em 01/11/2026.', '01:30 (GMT-05:00)'],
    ['Converta 14h de Etc/GMT+3 para Cuiabá em 17/11/2026.', '13:00'],
  ])('resolves %s', (text, expected) =>
    expect(tryChannelTimeConversion(text, received)).toBe(expected)
  );

  it.each([
    ['Converta quarta, dia 17 de novembro de 2026, às 14h de Brasília para Cuiabá.', 'data'],
    ['Converta 14h de Brasília para Cuiabá em 31/02/2026.', 'data'],
    ['Converta 14h de Brasília para Cuiabá.', 'data'],
    ['Converta hoje, 17/11/2026, às 14h de Brasília para Cuiabá.', 'data'],
    ['Converta 14h de Brasília para Cuiabá em 17/11/2026 e 18/11/2026.', 'data'],
    ['Converta 14h de Brasília para Cuiabá em 17/11/2026 e dia 18.', 'data'],
    ['Converta 14h de UTC +2 para Cuiabá em 17/11/2026.', 'fuso'],
    ['Converta 14h de Brasília em 17/11/2026.', 'fuso'],
    ['Converta 14h de Brasília para o Amazonas em 17/11/2026.', 'fuso'],
    ['Converta 14h de Brasília para America/UnlistedCity em 17/11/2026.', 'fuso'],
    ['Converta 14h CST para Cuiabá em 17/11/2026.', 'fuso'],
    ['Converta 14h de Brasília para Cuiabá ou Manaus em 17/11/2026.', 'fuso'],
    ['Converta 25h de Brasília para Cuiabá em 17/11/2026.', 'horário'],
    ['Converta 14:75 de Brasília para Cuiabá em 17/11/2026.', 'horário'],
    ['Converta 14h e 15h de Brasília para Cuiabá em 17/11/2026.', 'horário'],
    ['Converta 14h15 e meia de Brasília para Cuiabá em 17/11/2026.', 'HH:MM'],
    ['No dia 18/11/2026, em Brasília é meio-dia e quinze. Que horas são em Cuiabá?', 'HH:MM'],
    [
      'No dia 18/11/2026, em Brasília é um quarto para meia-noite. Que horas são em Cuiabá?',
      'HH:MM',
    ],
    ['No dia 18/11/2026, em Brasília são 14:15:45. Que horas são em Cuiabá?', 'HH:MM'],
    ['Converta 01:30 de America/New_York para UTC em 01/11/2026.', 'ocorre duas vezes'],
    ['Converta 02:30 de America/New_York para UTC em 08/03/2026.', 'inexistente'],
  ])('clarifies %s', (text, part) =>
    expect(tryChannelTimeConversion(text, received)).toContain(part)
  );

  it.each([
    'Que horas são agora?',
    'Meu fuso é Cuiabá.',
    'Me lembre em dez minutos de ligar para Brasília.',
    'Marque na minha agenda para 17/11/2026 das 14h às 15h no fuso de Cuiabá: Reunião de Brasília.',
    'Converta 14h de Brasília para Cuiabá em 17/11/2026 e agende a reunião.',
    'Quanto custa o voo de Brasília para Cuiabá às 14h?',
    'Quanto fica a passagem das 14h de Brasília para Cuiabá em 17/11/2026?',
    'Que horas abre o banco em Cuiabá? Disseram às 14h.',
    'Converta reais para dólares.',
  ])('preserves the pre-existing route for %s', (text) =>
    expect(tryChannelTimeConversion(text, received)).toBeNull()
  );

  describe.each(['whatsapp', 'telegram'] as const)('%s', (platform) => {
    describe.each(['bus', 'direct'])(
      '%s without a model, stored state or agenda mutations',
      (path) => {
        it.each([
          [example, '13:00'],
          [
            'No dia 18/11/2026, em Brasília é meia-noite e meia. Que horas são em Cuiabá?',
            '23:30 de 17/11/2026.',
          ],
          ['No dia 18/11/2026, em Brasília é meio-dia e meia. Que horas são em Cuiabá?', '11:30'],
          [
            'No dia 18/11/2026, em Brasília é meio-dia menos dez. Que horas são em Cuiabá?',
            'HH:MM',
          ],
        ])('preserves or clarifies the requested time: %s', async (text, expected) => {
          const message: ChannelIncomingMessage = {
            id: 'fixture',
            platform,
            channelPluginId: 'channel.' + platform,
            platformChatId: 'fixture',
            sender: { platform, platformUserId: 'fixture', displayName: 'Pessoa de teste' },
            text,
            timestamp: received,
            metadata: platform === 'telegram' ? { chatType: 'private' } : { isGroup: false },
          };
          const access = vi.fn(async () => true);
          const reply =
            path === 'bus'
              ? await processViaBus(
                  { process: fail } as never,
                  message,
                  { sessionId: 'fixture', conversationId: null },
                  { ownpilotUserId: 'fixture' },
                  {
                    sessionsRepo: { getById: fail } as never,
                    getChannel: fail,
                    isAccessAllowed: access,
                  }
                )
              : await processDirectAgent(message, 'fixture', access);
          if (expected === 'HH:MM') expect(reply).toContain(expected);
          else expect(reply).toBe(expected);
          expect(access).toHaveBeenCalledTimes(1);
          expect(fail).not.toHaveBeenCalled();
        });
      }
    );
  });
});
