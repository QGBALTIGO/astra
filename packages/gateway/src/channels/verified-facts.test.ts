import { describe, expect, it } from 'vitest';
import { safeChannelResponse, type ChannelToolReceipt } from './response-safety.js';
import {
  verifiedChannelFacts,
  verifiedRadarToolReply,
  verifiedReadChannelFacts,
  verifiedChannelToolReply,
} from './verified-facts.js';
const receipt = (name: string, result: unknown): ChannelToolReceipt => ({
  name: 'core.' + name,
  content: JSON.stringify({ success: true, result }),
  arguments: '',
  isError: false,
});

describe('recovering verified reads without another provider turn', () => {
  const financial = () =>
    receipt('financial_summary', {
      currency: 'BRL',
      period: { from: '2026-11-01', to: '2026-11-30' },
      income: 200,
      expenses: 50,
      result: 150,
      pendingIncome: 770,
      pendingExpenses: 35,
      apiKey: 'private-key',
      userId: 'other-private-id',
    });
  const transaction = (changes = {}) => ({
    id: 'private-row-id',
    userId: 'private-user-id',
    description: 'Pedido do café',
    amount: 70,
    currency: 'BRL',
    type: 'income',
    status: 'pending',
    date: '2026-12-01',
    notes: 'private-notes',
    ...changes,
  });
  const page = (transactions: unknown[], changes = {}) =>
    receipt('list_transactions', {
      transactions,
      total: transactions.length,
      page: 1,
      pageSize: 20,
      ...changes,
    });
  it('renders the whole received page before the memory limit without skipping rows 6–20', () => {
    const rows = Array.from({ length: 20 }, (_, index) =>
      transaction({
        id: `private-${index}`,
        description: `Parcela ${String(index + 1).padStart(2, '0')} de um pedido sintético para verificar a página completa`,
      })
    );
    const result = page(rows, { total: 26 });
    expect(result.content.length).toBeGreaterThan(3072);
    const answer = verifiedChannelToolReply(
      { content: '', toolCalls: [{ name: 'core.list_transactions' }] },
      [result],
      { requestText: 'Quais minhas entradas pendentes?' }
    );
    for (let i = 1; i <= 20; i++) expect(answer).toContain(`Parcela ${String(i).padStart(2, '0')}`);
    expect(answer).toContain('Exibindo 20 de 26');
    expect(answer).toContain('página 2 desta lista');
    expect(answer).not.toMatch(/truncad|private-/);
  });
  it.each([
    'Liste minhas entradas e depois mostre minhas despesas',
    'Liste minhas entradas e registre uma despesa de 10 reais',
    'Mostre minhas entradas e minhas tarefas',
    'Qual o total das minhas entradas?',
  ])('does not early-complete an intermediate finance read: %s', (requestText) => {
    expect(
      verifiedChannelToolReply(
        { content: '', toolCalls: [{ name: 'core.list_transactions' }] },
        [page([transaction()])],
        { requestText }
      )
    ).toBeUndefined();
  });
  it('keeps received and pending amounts separate and limits output to public fields', () => {
    const answer = verifiedReadChannelFacts([financial()]);
    expect(answer).toContain('• *A receber:* R$ 770,00');
    expect(answer).toContain('• *Entradas recebidas:* R$ 200,00');
    expect(answer).toContain('01/11/2026 a 30/11/2026');
    expect(answer).not.toMatch(/private|apiKey|userId/);
  });
  it('never presents a paginated list or mixed currencies as the total receivable balance', () => {
    const answer = verifiedReadChannelFacts([
      page(
        [
          transaction(),
          transaction({ description: 'Serviço externo', amount: 10, currency: 'USD' }),
        ],
        { total: 45, page: 2 }
      ),
    ]);
    expect(answer).toContain('R$ 70,00');
    expect(answer).toMatch(/US\$\s*10,00/);
    expect(answer).toContain('Exibindo 2 de 45 lançamentos encontrados · página 2');
    expect(answer).toContain('não representam um saldo total');
    expect(answer).not.toMatch(/80,00|private|notes|userId/);
  });
  it('only reports an empty list after a complete successful read and retains verified zero totals', () => {
    expect(verifiedReadChannelFacts([page([])])).toContain(
      'Nenhum lançamento encontrado nesta consulta'
    );
    const zero = financial();
    zero.content = zero.content.replace('"pendingIncome":770', '"pendingIncome":0');
    expect(verifiedReadChannelFacts([zero])).toContain('• *A receber:* R$ 0,00');
    expect(verifiedReadChannelFacts([page([], { total: 45, page: 5 })])).toContain(
      'Nenhum lançamento nesta página'
    );
  });
  it.each([
    { isError: true },
    { content: '{"success":false,"result":{"transactions":[],"total":0,"page":1,"pageSize":20}}' },
    { content: '{"success":true,"result":{"success":false,"error":"private-error"}}' },
    { content: 'not JSON' },
    { content: '{"transactions":[],"total":"0","page":1,"pageSize":20}' },
    { content: '{"transactions":[],"page":1,"pageSize":20}' },
  ])('does not turn an error or malformed payload into an invented empty result %j', (changes) => {
    expect(verifiedReadChannelFacts([{ ...page([]), ...changes }])).toBeUndefined();
  });
  it('does not use an older success to hide a later failure or a write', () => {
    expect(
      verifiedReadChannelFacts([financial(), { ...financial(), isError: true }])
    ).toBeUndefined();
    expect(
      verifiedReadChannelFacts([financial(), receipt('record_transaction', { saved: true })])
    ).toBeUndefined();
    expect(verifiedReadChannelFacts([receipt('search_tools', {}), financial()])).toContain(
      '770,00'
    );
  });
  it('preserves the useful part of two reads and identifies the unavailable part', () => {
    const answer = verifiedReadChannelFacts([financial(), { ...page([]), isError: true }]);
    expect(answer).toContain('R$ 770,00');
    expect(answer).toContain('Uma parte da consulta não ficou disponível');
    expect(answer).not.toContain('Nenhum lançamento');
  });
  it('renders legacy and paginated reminders using the customer timezone, not raw local text', () => {
    const items = [
      {
        id: 'private-reminder-id',
        title: 'Revisar pedido',
        quando: '2026-11-17T19:00:00.000Z',
        horarioLocal: 'wrong-time',
        timeZone: 'America/Sao_Paulo',
        status: 'pending',
        secret: 'private-secret',
      },
    ];
    for (const payload of [items, { items, total: 32, page: 2, pageSize: 20, hasMore: true }]) {
      const answer = verifiedReadChannelFacts([receipt('list_channel_reminders', payload)], {
        timeZone: 'America/Cuiaba',
      });
      expect(answer).toContain('15:00');
      expect(answer).toContain('Pendente');
      expect(answer).not.toMatch(/16:00|wrong-time|private|secret/);
    }
  });
  it('recovers an empty or unsafe model reply from the actual read payload', () => {
    const answer = safeChannelResponse('', [financial()], { requestText: 'Resumo financeiro' });
    expect(answer).toContain('R$ 770,00');
    expect(answer).not.toMatch(/não tenho uma alteração confirmada/);
  });
});
describe('verified weather and calendar presentation', () => {
  it.each([{ needsTime: true }, { needsSubject: true }, { changed: true }])(
    'finishes a verified explicit Radar request corrected from model status: %j',
    (outcome) => {
      const data = receipt('manage_radar', {
        kind: 'radar',
        ...outcome,
        reply: 'Resposta verificada.',
      });
      expect(
        verifiedRadarToolReply(
          {
            content: '',
            toolCalls: [{ name: 'core.manage_radar', arguments: '{"action":"status"}' }],
          },
          [data]
        )
      ).toBe('Resposta verificada.');
    }
  );
  it('finishes a verified Radar question with a short AI greeting and no invented confirmation', () => {
    const data = receipt('manage_radar', {
      kind: 'radar',
      changed: false,
      needsTime: true,
      reply: 'Em qual horário você quer receber o resumo?',
    });
    expect(
      verifiedRadarToolReply(
        { content: 'Claro, Kayky!\n\nAtivei às 7h.', toolCalls: [{ name: 'core__manage_radar' }] },
        [data]
      )
    ).toBe('Claro, Kayky!\n\nEm qual horário você quer receber o resumo?');
  });
  it('does not finish another tool, a mixed operation, failed result or malformed receipt as Radar success', () => {
    const valid = receipt('manage_radar', { kind: 'radar', reply: 'Assunto consultado.' });
    expect(
      verifiedRadarToolReply({ content: '', toolCalls: [{ name: 'core.record_transaction' }] }, [
        valid,
      ])
    ).toBeUndefined();
    expect(
      verifiedRadarToolReply(
        {
          content: '',
          toolCalls: [{ name: 'core.manage_radar' }, { name: 'core.record_transaction' }],
        },
        [valid, valid]
      )
    ).toBeUndefined();
    expect(
      verifiedRadarToolReply({ content: '', toolCalls: [{ name: 'core.manage_radar' }] }, [
        { ...valid, isError: true },
      ])
    ).toBeUndefined();
    expect(
      verifiedRadarToolReply({ content: '', toolCalls: [{ name: 'core.manage_radar' }] }, [
        { content: 'not JSON', isError: false },
      ])
    ).toBeUndefined();
  });
  it('finishes a failed Radar attempt safely without asking the model to retry an uncertain action', () => {
    const text = verifiedRadarToolReply(
      { content: '', toolCalls: [{ name: 'core.manage_radar' }] },
      [
        {
          content: JSON.stringify({
            success: false,
            error: 'SQL credentials and provider response must stay private',
          }),
          isError: true,
        },
      ]
    );
    expect(text).toContain('Não consegui confirmar');
    expect(text).not.toMatch(/SQL|credentials|provider response/);
  });
  it('allows an intermediate Radar status lookup before the requested pause or resume', () => {
    const status = receipt('manage_radar', {
      kind: 'radar',
      changed: false,
      reply: 'Seus acompanhamentos',
      interests: [],
    });
    expect(
      verifiedRadarToolReply(
        {
          content: '',
          toolCalls: [{ name: 'core.manage_radar', arguments: '{"action":"status"}' }],
        },
        [status]
      )
    ).toBeUndefined();
  });
  it('retains the email failure status when weather succeeds', () => {
    const weather = receipt('get_local_weather', {
      city: 'Aquidauana',
      region: 'MS',
      temperatureC: 31,
      kind: 'model_estimate',
    });
    const mail = { ...receipt('manage_email_digest', {}), isError: true };
    const text = verifiedChannelFacts('', [weather, mail]);
    expect(text).toContain('31 °C');
    expect(text).toContain('Não consegui confirmar o resumo de e-mails');
  });
  it('keeps the email digest and weather status when one component fails', () => {
    const weather = { ...receipt('get_local_weather', {}), isError: true };
    const text = verifiedChannelFacts('', [
      weather,
      receipt('manage_email_digest', {
        kind: 'email_digest',
        reply: '📬 Seus e-mails importantes: Consulta amanhã.',
      }),
    ]);
    expect(text).toContain('Consulta amanhã');
    expect(text).toContain('Não consegui consultar o tempo');
  });
  it('replaces invented weather values, source and feels-like with the actual lookup', () => {
    const data = receipt('get_local_weather', {
      city: 'Aquidauana',
      region: 'Mato Grosso do Sul',
      temperatureC: 35.3,
      humidityPercent: 43.7,
      windKmH: 14,
      conditionCode: 'partlycloudy_day',
      kind: 'model_estimate',
    });
    const text = safeChannelResponse(
      'Claro, Kayky! 🌤️\n\nTemperatura 30,1 °C, sensação de 33,2 °C. Fonte: Open-Meteo.',
      [data]
    );
    expect(text).toContain('Claro, Kayky!');
    expect(text).toContain('35,3 °C');
    expect(text).toContain('14 km/h');
    expect(text).not.toMatch(/Fonte:|MET Norway|clima-fontes|https?:/);
    expect(text).not.toMatch(/30,1|33,2|sensação|Open-Meteo|\]\(/);
    expect(safeChannelResponse('Aqui sua cidade já está registrada!\n35 °C', [data])).not.toContain(
      'cidade já está registrada'
    );
  });
  it('does not accept a temperature or city-save claim without a matching receipt', () => {
    const context = { requestText: 'Guarde Aquidauana como minha cidade e diga a temperatura' };
    const text = safeChannelResponse('Cidade salva! Agora está 35 °C.', [], context);
    expect(text).not.toMatch(/Cidade salva|35/);
    expect(text).toContain('consulta confirmada');
  });
  it('asks for the missing city and does not pretend the temperature was read after saving only', () => {
    expect(
      safeChannelResponse('Está 35 °C!', [
        receipt('get_local_weather', { needsCity: true, question: 'Qual sua cidade e estado?' }),
      ])
    ).toBe('Qual sua cidade e estado?');
    const text = safeChannelResponse('Cidade salva e está 35 °C.', [
      receipt('set_weather_city', { saved: true, city: 'Aquidauana', region: 'MS' }),
    ]);
    expect(text).toContain('Cidade guardada');
    expect(text).toContain('Ainda não consegui consultar');
    expect(text).not.toContain('35');
  });
  it('shows event times from actual offset timestamps in the customer timezone', () => {
    const data = receipt('run_connected_action', {
      source: 'Google Agenda',
      untrustedExternalData: {
        items: [
          {
            id: 'event-test',
            summary: 'Teste Horizonte',
            start: { dateTime: '2026-11-15T10:00:00-03:00' },
            end: { dateTime: '2026-11-15T10:10:00-03:00' },
          },
        ],
      },
    });
    const text = safeChannelResponse('Evento das 10:00 às 11:10 de Cuiabá.', [data], {
      requestText: 'Confira o evento Teste Horizonte',
      timeZone: 'America/Cuiaba',
    });
    expect(text).toContain('09:00 às 09:10');
    expect(text).not.toContain('11:10');
    expect(text).not.toContain('event-test');
    expect(
      safeChannelResponse('Horário errado.', [data], {
        requestText: 'Confira o evento Teste Horizonte',
        timeZone: 'America/Sao_Paulo',
      })
    ).toContain('10:00 às 10:10');
  });
});
