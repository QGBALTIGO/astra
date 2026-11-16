import { describe, expect, it } from 'vitest';
import { safeChannelResponse, type ChannelToolReceipt } from './response-safety.js';
import { verifiedChannelFacts, verifiedRadarToolReply } from './verified-facts.js';
const receipt = (name: string, result: unknown): ChannelToolReceipt => ({
  name: 'core.' + name,
  content: JSON.stringify({ success: true, result }),
  arguments: '',
  isError: false,
});
describe('verified weather and calendar presentation', () => {
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
