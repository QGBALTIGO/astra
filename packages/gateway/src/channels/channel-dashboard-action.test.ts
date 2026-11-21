import { describe, expect, it } from 'vitest';
import { validateWhatsAppUrlCta } from './plugins/whatsapp/whatsapp-url-cta.js';
import {
  dashboardActionForConfirmedReply as action,
  weatherInfoAction,
} from './channel-dashboard-action.js';
const id = 'whatsapp:5511999999999';
it.each(['whatsapp', 'telegram'])(
  'keeps weather attribution accessible without a source footer on %s',
  (platform) => {
    expect(
      weatherInfoAction(
        '🌤️ *Tempo em Aquidauana*\n\n• *Temperatura:* 35,3 °C · estimativa',
        platform
      )
    ).toEqual({ label: 'Sobre o clima', url: 'https://app.astraacessor.pro/clima-fontes.html' });
    expect(weatherInfoAction('Não consegui consultar a temperatura.', platform)).toBeUndefined();
  }
);
describe('Portal links after verified confirmations', () => {
  it('links an existing financial lookup without calling it a new registration', () => {
    expect(
      action(
        'Aqui está, Kayky.\n\n🔎 *Lançamento encontrado*\n\n• *Valor:* R$ 4,60',
        id,
        'whatsapp'
      )
    ).toEqual({
      label: 'Ver meus lançamentos',
      url: 'https://app.astraacessor.pro/cliente/transacoes',
    });
  });
  it('offers the ledger after an uncertain financial result without implying a successful write', () => {
    expect(
      action(
        '⏳ *Não consegui confirmar esse gasto*\n\nConfira seus lançamentos em Transações no painel antes de reenviar, para evitar duplicidade.',
        id,
        'whatsapp'
      )
    ).toEqual({
      label: 'Conferir lançamentos',
      url: 'https://app.astraacessor.pro/cliente/transacoes',
    });
  });
  it('links confirmed financial records and reminders to the relevant customer tab', () => {
    expect(action('✅ *Despesa registrada*\n\n• *Valor:* R$ 1,00', id, 'whatsapp')).toEqual({
      label: 'Acompanhar no painel',
      url: 'https://app.astraacessor.pro/cliente/transacoes',
    });
    expect(action('✅ *Lembrete agendado*\n\n• *Assunto:* Consulta', id, 'whatsapp')?.url).toMatch(
      /\/cliente\/agenda$/
    );
    expect(action('✅ *Tarefa criada*', id, 'whatsapp')?.url).toMatch(/\/cliente$/);
  });
  it('never links opinions, errors, unverified summaries, Telegram or admin users', () => {
    for (const message of [
      'A Gabrieli merece Pix?',
      'Não consegui registrar.',
      '✅ *Despesa registrada*',
      '📊 *Resumo financeiro*',
    ])
      expect(action(message, id, 'whatsapp')).toBeUndefined();
    expect(
      action('✅ *Despesa registrada*\n• *Valor:* R$ 1,00', 'default', 'whatsapp')
    ).toBeUndefined();
    expect(action('✅ *Despesa registrada*\n• *Valor:* R$ 1,00', id, 'telegram')).toBeUndefined();
  });
  it('checks every generated customer CTA against the real WhatsApp transport validator', () => {
    const samples = [
      '⏳ *Não consegui confirmar esse gasto*',
      '🔎 *Lançamento encontrado*\n\n• *Valor:* R$ 27,00',
      '✅ *Despesa registrada*\n\n• *Valor:* R$ 27,00',
      '✅ *Lembrete agendado*\n\n• *Assunto:* Consulta',
      '✅ *Tarefa criada*',
    ];
    for (const message of samples) {
      const button = action(message, id, 'whatsapp');
      expect(button).toBeDefined();
      expect(() => validateWhatsAppUrlCta(button!)).not.toThrow();
      expect(button!.label.length).toBeLessThanOrEqual(20);
    }
    const climate = weatherInfoAction(
      '🌤️ *Tempo em Ivinhema*\n\n• *Temperatura:* 28 °C · estimativa',
      'whatsapp'
    );
    expect(() => validateWhatsAppUrlCta(climate!)).not.toThrow();
  });
  it('does not include user tokens or accept untrusted URL credentials', () => {
    const msg = '✅ *Entrada registrada*\n\n• *Valor:* R$ 25,00';
    expect(action(msg, id, 'whatsapp', 'https://astra.example/private')?.url).toBe(
      'https://astra.example/cliente/transacoes'
    );
    expect(
      action(msg, id, 'whatsapp', 'https://astra-gateway-production.up.railway.app')?.url
    ).toBe('https://app.astraacessor.pro/cliente/transacoes');
    expect(action(msg, id, 'whatsapp', 'https://user:pass@evil.example/?token=1')?.url).toBe(
      'https://app.astraacessor.pro/cliente/transacoes'
    );
  });
});
