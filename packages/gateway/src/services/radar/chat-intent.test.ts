import { describe, expect, it } from 'vitest';
import {
  explicitRadarTime,
  gameAlertRequest,
  footballTimingReply,
  radarPreviewRequest,
} from './chat-intent.js';

describe('immediate Radar lookups', () => {
  it.each([
    'Quando o Vasco joga dnv?',
    'Quando o Vasco joga de novo?',
    'Qual é o próximo jogo do Vasco?',
    'Mostre o próximo jogo do Vasco',
  ])('reads the named team without recurring consent: %s', (text) => {
    expect(radarPreviewRequest(text)).toEqual({
      action: 'preview',
      source: 'football',
      subject: 'Vasco',
    });
    expect(gameAlertRequest(text)).toBe(false);
  });
  it.each(['Quais as últimas notícias', 'Me mostre as notícias', 'notícias'])(
    'uses an immediate general news preview: %s',
    (text) => {
      expect(radarPreviewRequest(text)).toEqual({
        action: 'preview',
        source: 'news',
        subject: 'mundo',
      });
    }
  );
  it('keeps a news topic in the lookup', () => {
    expect(radarPreviewRequest('Quais são as últimas notícias sobre tecnologia?')).toEqual({
      action: 'preview',
      source: 'news',
      subject: 'tecnologia',
    });
  });
  it.each([
    'Me avise sempre que tiver jogo do Vasco',
    'Todos do Vasco',
    'Antes do jogo começar',
    'Como faço frango?',
    'Quais as últimas notícias e apague meus gastos',
    'Quando o Vasco joga e me lembre amanhã',
    'Meu amigo disse: quando o Vasco joga dnv?',
    'Quando o time desconhecido joga?',
  ])('leaves other intents intact: %s', (text) => {
    expect(radarPreviewRequest(text)).toBeUndefined();
  });
});

describe('explicit recurring football consent without a model', () => {
  it.each([
    'Antes do jogo começar',
    'Antes do início da partida',
    'uma hora antes do jogo',
    'antes de começar o jogo',
  ])('recognizes a relative football clarification as read-only: %s', (text) => {
    expect(footballTimingReply(text)).toEqual({ kind: 'before' });
    expect(gameAlertRequest(text)).toBe(false);
  });
  it.each([
    'Todos do Vasco',
    'TodosdoVasco',
    'Todos os jogos do Vasco',
    'Todas as partidas do Flamengo',
  ])('keeps an explicitly named canonical team without granting consent: %s', (text) => {
    expect(footballTimingReply(text)).toEqual({
      kind: 'all-team',
      subject: text.includes('Flamengo') ? 'Flamengo' : 'Vasco',
    });
    expect(gameAlertRequest(text)).toBe(false);
  });
  it.each([
    'Não antes do jogo',
    'Antes do meu remédio',
    'Todos os clientes',
    'Todos do time inexistente',
    '"Antes do jogo começar"',
    'Como exemplo: Todos do Vasco',
    'Todos do Vasco, só quero uma sugestão',
    'Gastei 15 no Vasco',
  ])('does not capture unrelated or negated fragments: %s', (text) =>
    expect(footballTimingReply(text)).toBeUndefined()
  );
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
