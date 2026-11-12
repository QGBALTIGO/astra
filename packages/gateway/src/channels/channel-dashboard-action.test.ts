import { describe, expect, it } from 'vitest';
import { dashboardActionForConfirmedReply as action } from './channel-dashboard-action.js';
const id = 'whatsapp:5511999999999';
describe('Portal links after verified confirmations', () => {
  it('links confirmed financial records and reminders to the relevant customer tab', () => {
    expect(action('✅ *Despesa registrada*\n\n• *Valor:* R$ 1,00', id, 'whatsapp')).toEqual({
      label: 'Acompanhar no painel',
      url: 'https://astra-gateway-production.up.railway.app/cliente/transacoes',
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
  it('does not include user tokens or accept untrusted URL credentials', () => {
    const msg = '✅ *Entrada registrada*\n\n• *Valor:* R$ 25,00';
    expect(action(msg, id, 'whatsapp', 'https://astra.example/private')?.url).toBe(
      'https://astra.example/cliente/transacoes'
    );
    expect(action(msg, id, 'whatsapp', 'https://user:pass@evil.example/?token=1')?.url).toBe(
      'https://astra-gateway-production.up.railway.app/cliente/transacoes'
    );
  });
});
