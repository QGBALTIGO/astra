import { beforeEach, describe, expect, it, vi } from 'vitest';

const f = vi.hoisted(() => ({ getByDataUserId: vi.fn(), updateProfile: vi.fn() }));
vi.mock('../db/repositories/customer-accounts.js', () => ({ customerAccountsRepo: f }));

import { tryCustomerTimezoneChannelReply } from './timezone-routing.js';

const userId = 'whatsapp:customer-a';
const account = { id: 'account-a', dataUserId: userId, timeZone: 'America/Sao_Paulo' };
const now = new Date('2026-11-11T12:00:00Z');
const message = (text: string) => ({ text, platform: 'whatsapp' as const });

beforeEach(() => {
  vi.clearAllMocks();
  f.getByDataUserId.mockResolvedValue({ ...account });
  f.updateProfile.mockImplementation(async (_id, patch) => ({ ...account, ...patch }));
});

describe('explicit WhatsApp customer timezone declarations', () => {
  it.each([
    'Meu fuso horário é do Mato Grosso do Sul',
    'Meu fuso é MS.',
    'Astra, defina meu fuso para Mato Grosso do Sul, por favor.',
    'Use o fuso horário do estado de Mato Grosso do Sul',
    'Meu fuso: America/Campo_Grande',
  ])('persists the named zone and confirms the actual offset: %s', async (text) => {
    const reply = await tryCustomerTimezoneChannelReply(message(text), userId, now);

    expect(f.getByDataUserId).toHaveBeenCalledExactlyOnceWith(userId);
    expect(f.updateProfile).toHaveBeenCalledExactlyOnceWith('account-a', {
      timeZone: 'America/Campo_Grande',
    });
    expect(reply).toContain('Mato Grosso do Sul (UTC−4)');
    expect(reply).toContain('*Fuso atualizado*');
    expect(reply).not.toMatch(/GMT-3|UTC−3|reagend|15:00|America\/|account-a/);
    expect(reply).toContain('Os lembretes existentes continuam como estão.');
  });

  it('keeps Mato Grosso distinct from Mato Grosso do Sul', async () => {
    const reply = await tryCustomerTimezoneChannelReply(
      message('Meu fuso é do Mato Grosso'),
      userId,
      now
    );
    expect(f.updateProfile).toHaveBeenCalledExactlyOnceWith('account-a', {
      timeZone: 'America/Cuiaba',
    });
    expect(reply).toContain('Mato Grosso (UTC−4)');
    expect(reply).not.toContain('Mato Grosso do Sul');
  });

  it('does not write again when the declared zone is already saved', async () => {
    f.getByDataUserId.mockResolvedValue({ ...account, timeZone: 'America/Campo_Grande' });
    const reply = await tryCustomerTimezoneChannelReply(message('Meu fuso é MS'), userId, now);

    expect(f.updateProfile).not.toHaveBeenCalled();
    expect(reply).toContain('*Seu fuso horário*');
    expect(reply).toContain('Mato Grosso do Sul (UTC−4)');
  });

  it.each([
    ['2026-07-01T12:00:00Z', 'UTC+1'],
    ['2026-12-01T12:00:00Z', 'UTC'],
  ])('uses runtime seasonal offsets for a named zone at %s', async (instant, offset) => {
    const reply = await tryCustomerTimezoneChannelReply(
      message('Defina meu fuso para Europe/London'),
      userId,
      new Date(instant)
    );

    expect(f.updateProfile).toHaveBeenCalledExactlyOnceWith('account-a', {
      timeZone: 'Europe/London',
    });
    expect(reply).toContain(`(${offset})`);
  });

  it.each([
    'Meu fuso é do Mato Grosso do Sul e me lembre amanhã às 15h',
    'Meu fuso é MS; agende um lembrete',
    'Meu fuso é MS\nMe lembre às 15h',
    'Meu fuso é MS, marque uma consulta',
    'Meu fuso é MS e tenho R$ 770 para receber',
    'Meu fuso é MS remova a transação antiga',
    'Meu fuso é America/Campo_Grande preciso receber 770',
    'Não mude meu fuso para Mato Grosso do Sul',
    'Se meu fuso é MS, que horas são?',
    'Meu fuso é Mato Grosso do Sul?',
    'Estou no Mato Grosso do Sul',
    'Qual o fuso do Mato Grosso do Sul?',
    'Minha mãe mora no Mato Grosso do Sul',
  ])('leaves questions, locations and compound intents to normal routing: %s', async (text) => {
    expect(await tryCustomerTimezoneChannelReply(message(text), userId, now)).toBeNull();
    expect(f.getByDataUserId).not.toHaveBeenCalled();
    expect(f.updateProfile).not.toHaveBeenCalled();
  });

  it.each(['Meu fuso é UTC-3', 'Meu fuso é Brasil', 'Meu fuso é Mars/Olympus'])(
    'asks for a precise place instead of guessing the timezone: %s',
    async (text) => {
      const reply = await tryCustomerTimezoneChannelReply(message(text), userId, now);
      expect(reply).toContain('Me diga a cidade e o estado');
      expect(f.getByDataUserId).not.toHaveBeenCalled();
      expect(f.updateProfile).not.toHaveBeenCalled();
    }
  );

  it('does not alter a shared/owner identity or another channel', async () => {
    expect(
      await tryCustomerTimezoneChannelReply(message('Meu fuso é MS'), 'default', now)
    ).toBeNull();
    expect(
      await tryCustomerTimezoneChannelReply(
        { text: 'Meu fuso é MS', platform: 'telegram' },
        userId,
        now
      )
    ).toBeNull();
    expect(f.getByDataUserId).not.toHaveBeenCalled();
    expect(f.updateProfile).not.toHaveBeenCalled();
  });

  it('never writes to an account outside the authenticated data scope', async () => {
    f.getByDataUserId.mockResolvedValue({ ...account, dataUserId: 'whatsapp:customer-b' });
    const reply = await tryCustomerTimezoneChannelReply(message('Meu fuso é MS'), userId, now);

    expect(f.updateProfile).not.toHaveBeenCalled();
    expect(reply).toContain('Não consegui confirmar');
    expect(reply).not.toContain('customer-b');
  });

  it.each(['missing', 'error', 'different-saved-zone'])(
    'does not confirm a profile update without the persisted timezone (%s)',
    async (failure) => {
      if (failure === 'missing') f.updateProfile.mockResolvedValue(null);
      else if (failure === 'error')
        f.updateProfile.mockRejectedValue(new Error('database unavailable'));
      else f.updateProfile.mockResolvedValue({ ...account });

      const reply = await tryCustomerTimezoneChannelReply(message('Meu fuso é MS'), userId, now);
      expect(reply).toContain('Não consegui confirmar');
      expect(reply).not.toContain('Fuso atualizado');
      expect(reply).not.toContain('database');
    }
  );
});
