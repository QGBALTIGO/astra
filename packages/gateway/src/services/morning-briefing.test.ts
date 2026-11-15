import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
const m = vi.hoisted(() => ({ weather: vi.fn(), binding: vi.fn(), digest: vi.fn() }));
vi.mock('./customer-weather.js', () => ({ customerWeather: m.weather }));
vi.mock('./customer-integrations.js', () => ({
  customerIntegrationService: { binding: m.binding },
}));
vi.mock('./email-digest.js', () => ({ buildEmailDigest: m.digest }));
import { buildMorningBriefing } from './morning-briefing.js';
const now = new Date('2026-11-15T11:22:00Z');
const all = {
  withCuriosity: true,
  withWeather: true,
  withEmailDigest: true,
  emailPreviousDay: true,
};
beforeEach(() => {
  vi.clearAllMocks();
  m.weather.mockResolvedValue({
    city: 'Aquidauana',
    region: 'MS',
    temperatureC: 31.2,
    kind: 'model_estimate',
  });
  m.binding.mockResolvedValue({
    account: { id: 'account-a', phoneNumber: '5567999991234' },
    connection: { id: 'owned-a' },
  });
  m.digest.mockResolvedValue('📬 *Seus e-mails importantes*\nDia 14/11/2026\nConsulta amanhã.');
});
afterEach(() => vi.useRealTimers());
describe('composed morning briefing', () => {
  it('keeps parallel customers and their private email results isolated', async () => {
    m.binding.mockImplementation(async (user: string) => ({
      account: { id: user, phoneNumber: user },
      connection: { id: 'connection:' + user },
    }));
    m.digest.mockImplementation(async (user: string) => 'PRIVATE_MAIL_' + user);
    const results = await Promise.all(
      ['user-a', 'user-b'].map((user) =>
        buildMorningBriefing(
          user,
          'channel.whatsapp',
          'America/Campo_Grande',
          { withEmailDigest: true },
          now
        )
      )
    );
    expect(results[0]).toContain('PRIVATE_MAIL_user-a');
    expect(results[0]).not.toContain('PRIVATE_MAIL_user-b');
    expect(results[1]).toContain('PRIVATE_MAIL_user-b');
    expect(results[1]).not.toContain('PRIVATE_MAIL_user-a');
  });
  it('fulfils all screenshot components from verified sources without an agent turn', async () => {
    const result = await buildMorningBriefing(
      'whatsapp:5567999991234',
      'channel.whatsapp',
      'America/Campo_Grande',
      all,
      now
    );
    expect(result).toContain('Bom dia!');
    expect(result).toContain('Curiosidade do dia');
    expect(result).toContain('31,2 °C');
    expect(result).toContain('Consulta amanhã');
    expect(m.weather).toHaveBeenCalledWith('whatsapp:5567999991234');
    expect(m.digest).toHaveBeenCalledWith(
      'whatsapp:5567999991234',
      'channel.whatsapp',
      'owned-a',
      expect.objectContaining({ previousDay: true, timeZone: 'America/Campo_Grande', now })
    );
    expect(m.digest).toHaveBeenCalledTimes(1);
  });
  it('keeps the greeting, curiosity and emails when weather fails', async () => {
    m.weather.mockRejectedValue(new Error('synthetic_timeout_with_private_details'));
    const result = await buildMorningBriefing(
      'whatsapp:5567999991234',
      'channel.whatsapp',
      'America/Campo_Grande',
      all,
      now
    );
    expect(result).toContain('Curiosidade do dia');
    expect(result).toContain('Consulta amanhã');
    expect(result).toContain('Não consegui consultar o tempo');
    expect(result).not.toContain('private_details');
    expect(result).not.toContain('31,2');
  });
  it('keeps weather when Gmail is disconnected and does not claim an empty mailbox', async () => {
    m.binding.mockRejectedValue(new Error('disconnected'));
    const result = await buildMorningBriefing(
      'whatsapp:5567999991234',
      'channel.whatsapp',
      'America/Campo_Grande',
      all,
      now
    );
    expect(result).toContain('31,2 °C');
    expect(result).toContain('Conexões');
    expect(result).toContain('Bom dia!');
    expect(result).not.toContain('Não encontrei mensagens');
    expect(m.digest).not.toHaveBeenCalled();
  });
  it('asks only for the missing city and retains the other sections', async () => {
    m.weather.mockResolvedValue({ needsCity: true, question: 'Qual é sua cidade e estado?' });
    const result = await buildMorningBriefing(
      'whatsapp:5567999991234',
      'channel.whatsapp',
      'America/Campo_Grande',
      all,
      now
    );
    expect(result).toContain('cidade e estado');
    expect(result).toContain('Consulta amanhã');
    expect(result).toContain('Curiosidade do dia');
  });
  it('discards private email content when a binding changes during parallel reads', async () => {
    m.binding
      .mockResolvedValueOnce({
        account: { id: 'account-a', phoneNumber: '5567999991234' },
        connection: { id: 'owned-a' },
      })
      .mockResolvedValueOnce({
        account: { id: 'account-b', phoneNumber: '5511999995678' },
        connection: { id: 'owned-b' },
      });
    const result = await buildMorningBriefing(
      'whatsapp:5567999991234',
      'channel.whatsapp',
      'America/Campo_Grande',
      all,
      now
    );
    expect(result).not.toContain('Consulta amanhã');
    expect(result).toContain('Não consegui consultar seus e-mails');
    expect(result).toContain('31,2');
  });
  it('bounds both stalled components and still delivers the offline greeting and curiosity', async () => {
    vi.useFakeTimers();
    m.weather.mockImplementation(() => new Promise(() => {}));
    m.digest.mockImplementation(() => new Promise(() => {}));
    const pending = buildMorningBriefing(
      'whatsapp:5567999991234',
      'channel.whatsapp',
      'America/Campo_Grande',
      all,
      now
    );
    await vi.advanceTimersByTimeAsync(12001);
    const result = await pending;
    expect(result).toContain('Bom dia!');
    expect(result).toContain('Curiosidade do dia');
    expect(result).toContain('Não consegui consultar o tempo');
    expect(result).toContain('Não consegui consultar seus e-mails');
    expect(vi.getTimerCount()).toBe(0);
  });
  it('does not fetch unrequested components', async () => {
    const result = await buildMorningBriefing(
      'whatsapp:5567999991234',
      'channel.whatsapp',
      'America/Campo_Grande',
      { withCuriosity: true },
      now
    );
    expect(result).toContain('Curiosidade do dia');
    expect(m.weather).not.toHaveBeenCalled();
    expect(m.binding).not.toHaveBeenCalled();
    expect(m.digest).not.toHaveBeenCalled();
  });
});
