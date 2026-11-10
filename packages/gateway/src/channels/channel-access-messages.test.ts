import { describe, expect, it } from 'vitest';
import { buildAccessMessage, type AccessMessageKind } from './channel-access-messages.js';

const now = new Date('2026-11-10T16:00:00.000Z');
const settings = {
  siteUrl: 'https://astra.example/',
  renewalUrl: 'https://pay.example/astra',
  durationDays: 30,
};
const user = {
  displayName: 'Ana Souza',
  accessExpiresAt: new Date('2026-11-11T15:00:00.000Z'),
};
const kinds: AccessMessageKind[] = [
  'pending_welcome',
  'pending_wait',
  'pending_short',
  'approved',
  'first_authorized',
  'expiring',
  'expired',
  'renewed',
  'revoked',
];

describe('buildAccessMessage', () => {
  it('uses the approved warm pending welcome with a site action', () => {
    expect(buildAccessMessage('pending_welcome', user, settings, now)).toEqual({
      text: [
        'Olá, *Ana*! Que bom ter você por aqui. 💙',
        'Eu sou o *Astra*, seu assistente pessoal no WhatsApp. Estou aqui para ajudar você a organizar *tarefas, lembretes, compromissos e finanças* — e deixar sua rotina mais leve. ✨',
        'Seu acesso está *aguardando liberação*. Assim que estiver tudo pronto, eu te aviso por aqui para começarmos.',
        'Enquanto isso, que tal conhecer um pouco mais sobre o que podemos fazer juntos? 👇',
      ].join('\n\n'),
      urlButton: { label: 'Conhecer o Astra', url: settings.siteUrl },
    });
  });

  it('keeps long and short pending replies distinct without claiming approval', () => {
    const waiting = buildAccessMessage('pending_wait', user, settings, now);
    const short = buildAccessMessage('pending_short', user, settings, now);
    expect(waiting.text).toContain('Oi, *Ana*! Recebi sua mensagem. 💙');
    expect(waiting.text).toContain('ainda não consigo atender seus pedidos.');
    expect(waiting.text).toContain('pelo link abaixo');
    expect(waiting.urlButton?.label).toBe('Conhecer o Astra');
    expect(short.text).toBe(
      '*Ana*, seu acesso ainda está aguardando liberação. ⏳\n\nAssim que estiver ativo, eu te aviso por aqui. Vai ser um prazer ajudar você a organizar sua rotina! 💙'
    );
    expect(short.urlButton).toBeUndefined();
  });

  it('shows approval examples and actual expiry without a payment CTA', () => {
    const approved = buildAccessMessage('approved', user, settings, now);
    expect(approved.text).toContain('*Ana, seu acesso está liberado!* 🎉');
    expect(approved.text).toContain('💬 “Me lembre de pagar a conta amanhã às 9h.”');
    expect(approved.text).toContain('💬 “Gastei R$ 35,90 no almoço.”');
    expect(approved.text).toContain('💬 “Anote uma ideia para o meu projeto.”');
    expect(approved.text).toContain('📅 *Seu acesso está válido até 11/11/2026.*');
    expect(approved.urlButton).toBeUndefined();
  });

  it('welcomes a preauthorized contact as active without a pending or renewal offer', () => {
    const welcome = buildAccessMessage('first_authorized', user, settings, now);
    expect(welcome.text).toContain('Olá, *Ana*! Seja bem-vindo ao *Astra*. 💙');
    expect(welcome.text).toContain('*seu acesso já está liberado*! ✨');
    expect(welcome.text).toContain('É só conversar comigo por aqui, do seu jeito.');
    expect(welcome.text).not.toMatch(/aguardando|renov|vence/iu);
    expect(welcome.urlButton).toBeUndefined();
  });

  it.each(kinds)('does not interpolate a placeholder or unsafe name into %s', (kind) => {
    const message = buildAccessMessage(
      kind,
      { ...user, displayName: 'https://evil.example/ @5567999999999 **👻**' },
      settings,
      now
    );
    expect(message.text).not.toMatch(/evil|5567999999999|undefined|null|\{\{|\*\*/u);
    expect(message.text).not.toContain('Olá, !');
  });

  it.each(['', '   ', 'Sem nome', 'undefined', 'null', '5511999999999'])(
    'uses a natural greeting for an unusable name: %j',
    (displayName) => {
      const message = buildAccessMessage('pending_welcome', { displayName }, settings, now);
      expect(message.text).toMatch(/^Olá! Que bom ter você por aqui\./u);
    }
  );

  it('preserves real accented names while removing markdown, controls and mentions', () => {
    const message = buildAccessMessage(
      'pending_welcome',
      { displayName: '*Jo\u202eão*\n@12345 _Silva_ https://evil.example' },
      settings,
      now
    );
    expect(message.text).toMatch(/^Olá, \*João\*!/u);
    expect(message.text).not.toMatch(/\u202e|12345|Silva|evil/u);
  });

  it('formats Brazilian dates in the configured timezone and safely falls back for invalid zones', () => {
    const nearMidnight = { ...user, accessExpiresAt: new Date('2026-11-11T02:00:00.000Z') };
    const local = buildAccessMessage('approved', nearMidnight, settings, now);
    const utc = buildAccessMessage('approved', nearMidnight, { ...settings, timeZone: 'UTC' }, now);
    const invalid = buildAccessMessage(
      'approved',
      nearMidnight,
      { ...settings, timeZone: 'Invalid/Zone' },
      now
    );
    expect(local.text).toContain('válido até 10/11/2026');
    expect(utc.text).toContain('válido até 11/11/2026');
    expect(invalid).toEqual(local);
  });

  it('says tomorrow or today from the local calendar, not from a fixed elapsed-day assumption', () => {
    const tomorrow = buildAccessMessage('expiring', user, settings, now);
    const today = buildAccessMessage(
      'expiring',
      { ...user, accessExpiresAt: new Date('2026-11-11T02:00:00.000Z') },
      settings,
      now
    );
    expect(tomorrow.text).toContain('*Astra vence amanhã, 11/11/2026*');
    expect(today.text).toContain('*Astra vence hoje, 10/11/2026*');
    expect(tomorrow.urlButton).toEqual({ label: 'Renovar meu acesso', url: settings.renewalUrl });
    expect(tomorrow.text).toContain('por mais 30 dias');
  });

  it('uses an exact future date outside the next local day and expired copy if already elapsed', () => {
    const future = buildAccessMessage(
      'expiring',
      { ...user, accessExpiresAt: new Date('2026-11-20T16:00:00.000Z') },
      settings,
      now
    );
    const late = buildAccessMessage('expiring', { ...user, accessExpiresAt: now }, settings, now);
    expect(future.text).toContain('*Astra vence em 20/11/2026*');
    expect(late).toEqual(
      buildAccessMessage('expired', { ...user, accessExpiresAt: now }, settings, now)
    );
  });

  it('preserves history in expired copy and links to a configured renewal URL', () => {
    const expired = buildAccessMessage('expired', user, settings, now);
    expect(expired.text).toContain('meus atendimentos estão pausados por enquanto.');
    expect(expired.text).toContain('*Seu histórico e seus registros continuam preservados.*');
    expect(expired.text).toContain('renovar seu acesso pelo link abaixo');
    expect(expired.urlButton?.label).toBe('Renovar meu acesso');
  });

  it.each(['expiring', 'expired'] as const)(
    'uses a site CTA and administrative renewal instructions without a checkout URL for %s',
    (kind) => {
      const message = buildAccessMessage(kind, user, { siteUrl: settings.siteUrl }, now);
      expect(message.urlButton).toEqual({ label: 'Conhecer o Astra', url: settings.siteUrl });
      expect(message.text).toContain('fale com o administrador para renovar');
      expect(message.text).not.toMatch(/renovar seu acesso pelo link|30 dias|checkout|pagamento/iu);
    }
  );

  it('does not promise a missing CTA when neither configured URL is valid', () => {
    const invalid = {
      siteUrl: 'javascript:alert(1)',
      renewalUrl: 'https://user:secret@pay.example',
    };
    for (const kind of [
      'pending_welcome',
      'pending_wait',
      'expiring',
      'expired',
      'revoked',
    ] as const) {
      const message = buildAccessMessage(kind, user, invalid, now);
      expect(message.urlButton).toBeUndefined();
      expect(message.text).not.toMatch(/link abaixo|botão abaixo|javascript|secret/iu);
    }
  });

  it.each([null, undefined, new Date('invalid')])(
    'omits invalid/unlimited validity and duration: %s',
    (accessExpiresAt) => {
      for (const kind of ['approved', 'renewed', 'expiring'] as const) {
        const message = buildAccessMessage(kind, { ...user, accessExpiresAt }, settings, now);
        expect(message.text).not.toMatch(/válido até|Nova validade|vence|Invalid|30 dias/iu);
        expect(message.urlButton).toBeUndefined();
      }
    }
  );

  it('uses the explicit renewed duration, including singular, and never assumes 30 days', () => {
    const renewed = buildAccessMessage('renewed', user, settings, now);
    expect(renewed.text).toContain('*Tudo certo, Ana! Seu acesso foi renovado.* 🎉');
    expect(renewed.text).toContain('Temos mais *30 dias*');
    expect(renewed.text).toContain('📅 *Nova validade: 11/11/2026.*');
    expect(renewed.urlButton).toBeUndefined();
    expect(
      buildAccessMessage('renewed', user, { ...settings, durationDays: 1 }, now).text
    ).toContain('Temos mais *1 dia*');
    expect(
      buildAccessMessage('renewed', user, { ...settings, durationDays: 90 }, now).text
    ).toContain('Temos mais *90 dias*');
    for (const durationDays of [undefined, null, 0, -30, 1.5, Number.NaN]) {
      const message = buildAccessMessage('renewed', user, { ...settings, durationDays }, now);
      expect(message.text).not.toMatch(/Temos mais|30 dias|NaN/iu);
      expect(message.text).toContain('Nova validade: 11/11/2026');
    }
  });

  it('does not offer payment for an administrative revocation', () => {
    const revoked = buildAccessMessage('revoked', user, settings, now);
    expect(revoked.text).toContain('fale com o administrador');
    expect(revoked.urlButton).toEqual({ label: 'Conhecer o Astra', url: settings.siteUrl });
    expect(revoked.text).not.toMatch(/renov|pagamento/iu);
  });

  it.each(kinds)(
    'cannot offer renewal or active-access copy to a blocked contact for %s',
    (kind) => {
      const message = buildAccessMessage(kind, { ...user, isBlocked: true }, settings, now);
      expect(message.text).toContain('acesso ao *Astra está indisponível*');
      expect(message.text).not.toMatch(/liberado|renov|válido|30 dias|pagamento/iu);
      expect(message.urlButton).toBeUndefined();
    }
  );
});
