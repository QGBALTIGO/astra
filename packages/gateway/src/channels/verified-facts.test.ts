import { describe, expect, it } from 'vitest';
import { safeChannelResponse, type ChannelToolReceipt } from './response-safety.js';
import { verifiedChannelFacts, verifiedRadarToolReply } from './verified-facts.js';
import { channelFailureReply } from './channel-failure.js';
const receipt = (name: string, result: unknown): ChannelToolReceipt => ({
  name: 'core.' + name,
  content: JSON.stringify({ success: true, result }),
  arguments: '',
  isError: false,
});
describe('verified weather and calendar presentation', () => {
  const savedGoal = () =>
    receipt('create_customer_goal', {
      kind: 'customer_goal',
      goal: { id: 'goal-saved', amount: 500, progress: 35 },
      reply: 'Meta salva: R$ 35,00 guardados de R$ 500,00.',
    });
  const weather = () =>
    receipt('get_local_weather', {
      kind: 'model_estimate',
      city: 'Campo Grande',
      region: 'MS',
      temperatureC: 28,
    });
  it('keeps a committed goal confirmation when model finalization fails', () => {
    expect(channelFailureReply('Salve minha meta', 'agent_error', [savedGoal()])).toBe(
      'Meta salva: R$ 35,00 guardados de R$ 500,00.'
    );
  });
  it('keeps the goal and weather facts in a mixed reply without model amounts', () => {
    const text = safeChannelResponse('Meta salva com R$ 9.999. Faz 45 graus.', [
      savedGoal(),
      weather(),
    ]);
    expect(text).toContain('Meta salva: R$ 35,00 guardados de R$ 500,00.');
    expect(text).toContain('28 °C');
    expect(text).not.toMatch(/9\.999|45 graus/);
  });
  it('does not let another lookup admit an invented goal amount', () => {
    const text = safeChannelResponse('Sua meta agora tem R$ 9.999 guardados.', [
      savedGoal(),
      receipt('financial_summary', { balance: 25 }),
    ]);
    expect(text).toContain('Meta salva: R$ 35,00 guardados de R$ 500,00.');
    expect(text).not.toContain('9.999');
    expect(text).toContain('outra consulta');
  });
  it('preserves a failed goal notice beside the verified weather', () => {
    const failed = { ...savedGoal(), isError: true };
    const text = safeChannelResponse('Tudo salvo. Faz 45 graus.', [failed, weather()]);
    expect(text).toContain('Não consegui confirmar');
    expect(text).toContain('28 °C');
    expect(text).not.toContain('Meta salva');
  });
  it('keeps every confirmed operation when a goal, task and weather share a reply', () => {
    const text = safeChannelResponse('Tudo certo.', [
      savedGoal(),
      receipt('add_task', { task: { id: 'task-saved', title: 'Comprar café' } }),
      weather(),
    ]);
    expect(text).toContain('Meta salva: R$ 35,00 guardados de R$ 500,00.');
    expect(text).toContain('Comprar café');
    expect(text).toContain('28 °C');
  });
  it('uses the final saved monetary goal, without repeating a stale lookup or model amount', () => {
    const text = safeChannelResponse('Pronto, guardei R$ 9.999.', [
      receipt('list_customer_goals', { kind: 'customer_goal', reply: 'Guardado R$ 10,00' }),
      receipt('update_customer_goal', {
        kind: 'customer_goal',
        goal: { id: 'goal-a' },
        reply: 'Meta atualizada: R$ 35,00 guardados de R$ 500,00.',
      }),
    ]);
    expect(text).toBe('Meta atualizada: R$ 35,00 guardados de R$ 500,00.');
  });
  it('never turns a failed monetary goal write into a saved confirmation', () => {
    const failed = { ...receipt('create_customer_goal', {}), isError: true };
    const text = safeChannelResponse('Meta salva no painel!', [failed]);
    expect(text).toContain('Não consegui confirmar');
    expect(text).not.toContain('Meta salva');
  });
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
