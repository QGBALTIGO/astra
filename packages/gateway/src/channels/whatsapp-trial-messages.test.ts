import { describe, expect, it } from 'vitest';
import { buildAccessMessage } from './channel-access-messages.js';

const trial = {
  displayName: 'Ana',
  accessSource: 'trial' as const,
  accessExpiresAt: new Date('2026-11-20T16:25:00Z'),
};
const settings = {
  timeZone: 'America/Campo_Grande',
  renewalUrl: 'https://pay.cakto.com.br/CubL455',
};
describe('WhatsApp trial copy', () => {
  it('welcomes with all primary capabilities, examples and the exact expiry', () => {
    const reply = buildAccessMessage('first_authorized', trial, settings);
    for (const text of [
      'Ana',
      '3 dias',
      '72 horas',
      'Sem cadastro',
      '20/11/2026',
      '12:25',
      'finanças',
      'lembretes',
      'tarefas',
      'metas',
      'memórias',
      'áudios',
      'e-mail',
      'conectar',
    ]) {
      expect(reply.text.toLowerCase()).toContain(text.toLowerCase());
    }
    expect(reply.text).not.toContain('aguardando liberação');
    expect(reply.urlButton).toBeUndefined();
  });
  it('keeps active trial requests on the existing 72-hour window without sending a login flow', () => {
    const reply = buildAccessMessage('trial_active', trial, settings);
    expect(reply.text).toContain('teste grátis do Astra já está em andamento');
    expect(reply.text).toContain('20/11/2026');
    expect(reply.text).toContain('12:25');
    expect(reply.text).not.toMatch(/login|código de 6 dígitos|seu teste começou agora/iu);
    expect(reply.urlButton).toBeUndefined();
  });
  it('acknowledges already-active access without promising a fresh trial', () => {
    const reply = buildAccessMessage('already_active', { ...trial, accessSource: 'cakto' }, settings);
    expect(reply.text).toContain('Seu acesso ao Astra já está ativo');
    expect(reply.text).not.toContain('Seus 3 dias grátis já começaram');
    expect(reply.text).not.toContain('página de login');
    expect(reply.urlButton).toBeUndefined();
  });
  it('uses real line breaks in the trial welcome and offers WhatsApp-first examples', () => {
    const reply = buildAccessMessage('first_authorized', trial, settings);
    expect(reply.text).toContain('💸 *Finanças:');
    expect(reply.text).toContain('\n📅 *Agenda:');
    expect(reply.text).toContain('\n💬 “Gastei R$ 35 no almoço.”');
    expect(reply.text).not.toContain('\\n📅');
    expect(reply.text).not.toMatch(/página de login|precisa acessar a página/iu);
  });
  it('offers the checkout after expiration and promises no automatic charge', () => {
    const reply = buildAccessMessage('expired', trial, settings);
    expect(reply.text).toContain('teste grátis de 3 dias chegou ao fim');
    expect(reply.text).toContain('Nenhuma cobrança automática');
    expect(reply.urlButton).toEqual({ label: 'Continuar com o Astra', url: settings.renewalUrl });
  });
  it('uses the principal checkout when no override was configured', () => {
    expect(buildAccessMessage('expired', trial, { renewalUrl: null }).urlButton?.url).toBe(
      'https://pay.cakto.com.br/CubL455'
    );
  });
  it('preserves the referral checkout only for an enrolled referred trial', () => {
    const referred = buildAccessMessage(
      'expired',
      { ...trial, metadata: { astraTrialReferral: 'julio' } },
      settings
    );
    expect(referred.urlButton?.url).toBe('https://pay.cakto.com.br/CubL455?affiliate=oYTQCyX6');
    expect(
      buildAccessMessage(
        'expired',
        { ...trial, metadata: { astraTrialReferral: 'unknown' } },
        settings
      ).urlButton?.url
    ).toBe(settings.renewalUrl);
  });
  it('confirms a paid subscription without offering a new free trial', () => {
    const reply = buildAccessMessage('subscribed', { ...trial, accessSource: 'cakto' }, settings);
    expect(reply.text).toContain('Assinatura confirmada');
    expect(reply.text).not.toContain('teste grátis');
    expect(reply.urlButton).toBeUndefined();
  });
  it('keeps blocked customers out of commercial messages', () => {
    const reply = buildAccessMessage('expired', { ...trial, isBlocked: true }, settings);
    expect(reply.urlButton).toBeUndefined();
    expect(reply.text).not.toContain('teste grátis');
  });
});
