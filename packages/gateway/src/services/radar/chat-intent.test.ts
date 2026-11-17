import { describe, expect, it } from 'vitest';
import { explicitRadarTime, gameAlertRequest } from './chat-intent.js';

describe('explicit recurring football consent without a model', () => {
  it.each([
    'Me avise sempre que tiver jogo do Vasco',
    'Me lembre sempre que o Flamengo jogar',
    'Astra, me notifique quando tiver partida do Santos às 09:00',
    'Me avise quando tiver jogo do Vasco, mas não todo dia',
    'Quero ser avisado nos dias de jogo do Palmeiras',
  ])('recognizes the customer request: %s', (text) => expect(gameAlertRequest(text)).toBe(true));
  it.each([
    'Qual o próximo jogo do Vasco?',
    'Me lembre do jogo do Vasco amanhã às 9h',
    'Me avise uma hora antes do jogo de hoje',
    'Pare de me avisar quando tiver jogo do Vasco',
    'Não me avise quando tiver jogo do Vasco',
    'Me avise todos os dias com um resumo dos jogos do Vasco',
    'Como seria me avise sempre que tiver jogo do Vasco?',
    'Meu cliente disse: me avise sempre que tiver jogo do Vasco',
    'Me avise sempre que tiver jogo do Vasco é uma frase de exemplo',
    '"Me avise sempre que tiver jogo do Vasco"',
    'Me avise sempre que tiver jogo do Vasco (apenas explique)',
    'Gastei 15 reais no almoço',
  ])('does not infer recurring consent from %s', (text) =>
    expect(gameAlertRequest(text)).toBe(false)
  );
  it.each([
    ['Me avise sempre quando jogar às 9h', '09:00'],
    ['Me avise sempre quando jogar às 9:30', '09:30'],
    ['Me avise sempre quando jogar às 3 da tarde', '15:00'],
    ['às 07:15', '07:15'],
  ])('uses only the written clock %s', (text, expected) =>
    expect(explicitRadarTime(text)).toBe(expected)
  );
  it.each([
    'Me avise sempre que tiver jogo',
    'Me avise sempre que tiver jogo às 25:00',
    'Me avise sempre que tiver jogo às 9:60',
    'Me avise sempre que tiver jogo às 9h ou às 10h',
    'Me avise sempre que tiver jogo do Vasco às 9h ou às 10h',
  ])('does not invent or choose a clock for %s', (text) =>
    expect(explicitRadarTime(text)).toBeUndefined()
  );
});
