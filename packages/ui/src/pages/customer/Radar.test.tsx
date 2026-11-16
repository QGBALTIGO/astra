// @vitest-environment happy-dom
import { act } from 'react';
import { MemoryRouter } from 'react-router';
import { beforeEach, afterEach, describe, it, expect, vi } from 'vitest';
import { CustomerRoutes } from './CustomerApp';
import { customerApi } from './api';
import { testDom, mockCustomerApi, customerFixture, deferred } from './test-fixtures';
import type { CustomerRadarData, RadarInterest } from './radar-types';
let dom: ReturnType<typeof testDom>,
  baseApi: ReturnType<typeof mockCustomerApi>,
  data: CustomerRadarData;
let read: ReturnType<typeof vi.spyOn>,
  create: ReturnType<typeof vi.spyOn>,
  change: ReturnType<typeof vi.spyOn>,
  remove: ReturnType<typeof vi.spyOn>,
  prefs: ReturnType<typeof vi.spyOn>,
  search: ReturnType<typeof vi.spyOn>;
function interest(): RadarInterest {
  return {
    id: 'own-interest',
    source: 'currency',
    target: 'USD',
    label: 'USD',
    active: true,
    revision: 1,
    createdAt: '2026-11-16T12:00:00Z',
    delivery: 'digest',
    leadMinutes: 60,
    errorCode: null,
    snapshot: null,
  };
}
beforeEach(() => {
  dom = testDom();
  baseApi = mockCustomerApi();
  data = {
    catalog: [
      {
        id: 'weather',
        name: 'Clima',
        description: 'Previsão para sua cidade.',
        provider: 'MET Norway',
        url: 'https://api.met.no/',
        license: 'CC BY 4.0',
        hint: 'Cidade e estado',
        needsSearch: true,
        available: true,
      },
      {
        id: 'currency',
        name: 'Moedas',
        description: 'Taxas de referência diárias.',
        provider: 'Frankfurter',
        url: 'https://frankfurter.dev/',
        license: 'Taxas combinadas',
        hint: 'USD, EUR ou GBP',
        needsSearch: false,
        available: true,
      },
      {
        id: 'news',
        name: 'Notícias',
        description: 'Manchetes e links.',
        provider: 'GDELT',
        url: 'https://gdeltproject.org/',
        license: 'Dataset aberto',
        hint: 'Assunto ou cidade',
        needsSearch: false,
        available: true,
      },
      {
        id: 'football',
        name: 'Futebol',
        description: 'Brasileirão Série A.',
        provider: 'football-data.org',
        url: 'https://football-data.org/',
        license: 'Termos do provedor',
        hint: 'Time',
        needsSearch: true,
        available: false,
        disabledReason: 'A fonte gratuita ainda está sendo configurada.',
      },
    ],
    preferences: { enabled: false, time: '07:00', quietStart: '22:00', quietEnd: '07:00' },
    interests: [],
    history: [],
    timeZone: 'America/Campo_Grande',
  };
  read = vi.spyOn(customerApi, 'radar').mockImplementation(async () => structuredClone(data));
  create = vi.spyOn(customerApi, 'radarCreate').mockResolvedValue({});
  change = vi.spyOn(customerApi, 'radarChange').mockResolvedValue({});
  remove = vi.spyOn(customerApi, 'radarRemove').mockResolvedValue({});
  prefs = vi.spyOn(customerApi, 'radarPreferences').mockResolvedValue({});
  search = vi.spyOn(customerApi, 'radarSearch').mockResolvedValue({
    choices: [{ id: '-20.47,-55.79', label: 'Aquidauana, Mato Grosso do Sul, Brasil' }],
  });
});
afterEach(async () => {
  await dom.cleanup();
  vi.restoreAllMocks();
});
const mount = () =>
  dom.render(
    <MemoryRouter initialEntries={['/cliente/radar']}>
      <CustomerRoutes />
    </MemoryRouter>
  );
const source = (name: string) =>
  Array.from(dom.container.querySelectorAll<HTMLButtonElement>('.ac-radar-source')).find(
    (b) => b.querySelector('strong')?.textContent === name
  )!;
const submitInterest = async () => {
  const form = dom.container.querySelector<HTMLFormElement>('[role="dialog"] .ac-radar-form');
  expect(form).toBeTruthy();
  await act(async () => {
    form!.dispatchEvent(new Event('submit', { bubbles: true, cancelable: true }));
  });
};
const enableFootball = () => {
  Object.assign(
    data.catalog.find((s) => s.id === 'football')!,
    {
      available: true,
      provider: 'openfootball',
      license: 'CC0 1.0',
    }
  );
  search.mockResolvedValue({ choices: [{ id: 'br:vasco-da-gama', label: 'Vasco' }] });
};
const chooseFootball = async () => {
  enableFootball();
  await mount();
  await dom.click(dom.button('Adicionar assunto'));
  await dom.click(source('Futebol'));
  await dom.fill(dom.field('Time'), 'Vasco');
  await dom.click(dom.button('Buscar'));
  await dom.click(dom.container.querySelector<HTMLInputElement>('input[type="radio"]')!);
};
describe('native customer Radar opt-in and navigation', () => {
  it('shows game-day follows with their chosen time rather than as daily summaries', async () => {
    enableFootball();
    data.interests = [
      {
        ...interest(),
        source: 'football',
        target: 'br:vasco-da-gama',
        label: 'Vasco',
        delivery: 'matchday',
        notifyTime: '09:00',
      },
    ];
    await mount();
    const card = dom.container.querySelector('article[aria-label="Vasco"]')!;
    expect(card.textContent).toContain('Só nos dias de jogo · às 09:00');
    expect(card.textContent).not.toContain('No resumo diário');
  });
  it('creates a game-day follow at the chosen local time without enabling all notifications', async () => {
    await chooseFootball();
    const delivery = dom.field('Como quer receber?') as HTMLSelectElement;
    expect(delivery.value).toBe('matchday');
    expect(Array.from(delivery.options, (o) => o.value)).toEqual(['matchday', 'digest']);
    expect(dom.container.textContent).toContain('o horário de início pode não estar confirmado');
    await dom.fill(dom.field('Horário do aviso no dia do jogo'), '09:00');
    await submitInterest();
    expect(create).toHaveBeenCalledWith(customerFixture.accountId, {
      source: 'football',
      target: 'br:vasco-da-gama',
      delivery: 'matchday',
      notifyTime: '09:00',
      leadMinutes: 60,
    });
    expect(prefs).not.toHaveBeenCalled();
  });
  it('requires a valid game-day clock without inventing a default time', async () => {
    await chooseFootball();
    const clock = dom.field('Horário do aviso no dia do jogo') as HTMLInputElement;
    expect(clock.required).toBe(true);
    expect(clock.value).toBe('');
    await submitInterest();
    expect(create).not.toHaveBeenCalled();
    expect(dom.container.querySelector('[role="alert"]')?.textContent).toContain(
      'Escolha o horário do aviso no dia do jogo.'
    );
    await dom.fill(clock, '24:00');
    await submitInterest();
    expect(create).not.toHaveBeenCalled();
  });
  it('preserves and changes the clock when editing a game-day follow', async () => {
    enableFootball();
    data.interests = [
      {
        ...interest(),
        source: 'football',
        target: 'br:vasco-da-gama',
        label: 'Vasco',
        delivery: 'matchday',
        notifyTime: '09:00',
      },
    ];
    await mount();
    await dom.click(dom.button('Editar Vasco'));
    expect((dom.field('Como quer receber?') as HTMLSelectElement).value).toBe('matchday');
    expect((dom.field('Horário do aviso no dia do jogo') as HTMLInputElement).value).toBe('09:00');
    await dom.fill(dom.field('Horário do aviso no dia do jogo'), '10:30');
    await submitInterest();
    expect(change).toHaveBeenCalledWith(customerFixture.accountId, 'own-interest', {
      delivery: 'matchday',
      notifyTime: '10:30',
      leadMinutes: 60,
    });
    expect(create).not.toHaveBeenCalled();
    expect(prefs).not.toHaveBeenCalled();
  });
  it('keeps daily football summaries as an explicit choice without a game-day clock', async () => {
    await chooseFootball();
    await dom.fill(dom.field('Horário do aviso no dia do jogo'), '09:00');
    await dom.fill(dom.field('Como quer receber?'), 'digest');
    expect(dom.container.querySelector('input[type="time"]')).toBeNull();
    await submitInterest();
    expect(create).toHaveBeenCalledWith(customerFixture.accountId, {
      source: 'football',
      target: 'br:vasco-da-gama',
      delivery: 'digest',
      leadMinutes: 60,
    });
    expect(prefs).not.toHaveBeenCalled();
  });
  it('keeps football cards free of dataset links and preserves useful news article links', async () => {
    Object.assign(
      data.catalog.find((s) => s.id === 'football')!,
      {
        available: true,
        provider: 'openfootball',
        url: 'https://github.com/openfootball/south-america',
        license: 'CC0 1.0',
      }
    );
    const football = {
      ...interest(),
      id: 'team',
      source: 'football' as const,
      target: 'br:cr-flamengo',
      label: 'Flamengo',
      snapshot: {
        items: [
          {
            id: 'match',
            title: 'Flamengo × Palmeiras',
            text: '18/11/2026 · Horário a confirmar.',
            url: 'https://github.com/openfootball/south-america/blob/master/brazil/2026_br1.txt',
          },
        ],
        observedAt: new Date().toISOString(),
        expiresAt: new Date(Date.now() + 60000).toISOString(),
        sourceLabel: 'openfootball',
        sourceUrl: 'https://github.com/openfootball/south-america',
      },
    };
    data.interests = [
      football,
      {
        ...interest(),
        id: 'news',
        source: 'news',
        target: 'mundo',
        label: 'Mundo',
        snapshot: {
          ...football.snapshot,
          items: [
            { id: 'article', title: 'Uma notícia', url: 'https://pt.globalvoices.org/noticia/' },
          ],
          sourceLabel: 'Global Voices',
          sourceUrl: 'https://pt.globalvoices.org/',
        },
      },
    ];
    await mount();
    const team = dom.container.querySelector('article[aria-label="Flamengo"]')!;
    expect(team.textContent).toContain('Flamengo × Palmeiras');
    expect(team.textContent).toContain('Calendário previsto');
    expect(team.querySelector('a')).toBeNull();
    expect(
      dom.container.querySelector('a[href="https://pt.globalvoices.org/noticia/"]')
    ).toBeTruthy();
  });
  it('opens natively without loading finance or creating unwanted subscriptions', async () => {
    await mount();
    expect(dom.container.textContent).toContain('Seu Radar começa pelos seus interesses');
    expect(create).not.toHaveBeenCalled();
    expect(prefs).not.toHaveBeenCalled();
    expect(baseApi.summary).not.toHaveBeenCalled();
    expect(dom.container.querySelector('input[type="checkbox"]')).toBeNull();
    expect(dom.container.textContent).toContain('É só me pedir no WhatsApp');
    await dom.click(dom.button('Ajustar horários e notificações'));
    expect((dom.field('Receber meu Radar') as HTMLInputElement).checked).toBe(false);
    expect(read).toHaveBeenCalledWith(customerFixture.accountId, expect.any(AbortSignal));
  });
  it('shows the unavailable football source honestly rather than creating a fake follow', async () => {
    await mount();
    await dom.click(dom.button('Adicionar assunto'));
    expect(source('Futebol').disabled).toBe(true);
    expect(dom.container.textContent).toContain('ainda está sendo configurada');
    expect(create).not.toHaveBeenCalled();
  });
  it('adds only the selected source without silently enabling WhatsApp', async () => {
    await mount();
    await dom.click(dom.button('Adicionar assunto'));
    await dom.click(source('Moedas'));
    await submitInterest();
    expect(create).toHaveBeenCalledWith(
      customerFixture.accountId,
      expect.objectContaining({ source: 'currency', target: 'USD', delivery: 'digest' })
    );
    expect(prefs).not.toHaveBeenCalled();
    expect(create).toHaveBeenCalledTimes(1);
  });
  it('keeps a failed save open and never claims success', async () => {
    create.mockRejectedValue(new Error('Fonte indisponível'));
    await mount();
    await dom.click(dom.button('Adicionar assunto'));
    await dom.click(source('Moedas'));
    await submitInterest();
    expect(dom.container.querySelector('[role="dialog"]')).toBeTruthy();
    expect(dom.container.querySelector('[role="alert"]')?.textContent).toContain(
      'Fonte indisponível'
    );
    expect(dom.container.textContent).not.toContain('Assunto adicionado ao seu Radar.');
  });
  it('locks duplicate submissions while a save is pending', async () => {
    const pending = deferred<unknown>();
    create.mockReturnValue(pending.promise);
    await mount();
    await dom.click(dom.button('Adicionar assunto'));
    await dom.click(source('Moedas'));
    await submitInterest();
    await submitInterest();
    expect(create).toHaveBeenCalledTimes(1);
    expect(dom.button('Salvando…').disabled).toBe(true);
    await act(async () => pending.resolve({}));
  });
  it('requires selecting a returned city instead of accepting an unverified name', async () => {
    await mount();
    await dom.click(dom.button('Adicionar assunto'));
    await dom.click(source('Clima'));
    await submitInterest();
    expect(create).not.toHaveBeenCalled();
    expect(dom.container.textContent).toContain('Selecione um resultado da busca');
  });
  it('searches a city only after an explicit search action', async () => {
    await mount();
    await dom.click(dom.button('Adicionar assunto'));
    await dom.click(source('Clima'));
    await dom.fill(dom.field('Cidade e estado'), 'Aquidauana');
    expect(search).not.toHaveBeenCalled();
    await dom.click(dom.button('Buscar'));
    expect(search).toHaveBeenCalledTimes(1);
    await dom.click(dom.container.querySelector<HTMLInputElement>('input[type="radio"]')!);
    await submitInterest();
    expect(create).toHaveBeenCalledWith(
      customerFixture.accountId,
      expect.objectContaining({ source: 'weather', target: '-20.47,-55.79' })
    );
  });
  it('discards results that arrive after the user changed the search', async () => {
    const pending = deferred<{ choices: Array<{ id: string; label: string }> }>();
    search.mockReturnValue(pending.promise);
    await mount();
    await dom.click(dom.button('Adicionar assunto'));
    await dom.click(source('Clima'));
    await dom.fill(dom.field('Cidade e estado'), 'Cidade antiga');
    await dom.click(dom.button('Buscar'));
    await dom.fill(dom.field('Cidade e estado'), 'Cidade nova');
    await act(async () => pending.resolve({ choices: [{ id: '0,0', label: 'Resultado antigo' }] }));
    expect(dom.container.textContent).not.toContain('Resultado antigo');
  });
  it('saves the explicit WhatsApp opt-in and preserves the chosen time', async () => {
    await mount();
    await dom.click(dom.button('Ajustar horários e notificações'));
    await dom.click(dom.field('Receber meu Radar') as HTMLElement);
    await dom.fill(dom.field('Horário do resumo'), '08:30');
    await dom.click(dom.button('Salvar preferências'));
    expect(prefs).toHaveBeenCalledWith(customerFixture.accountId, {
      enabled: true,
      time: '08:30',
      quietStart: '22:00',
      quietEnd: '07:00',
    });
  });
  it('pauses only the selected follow', async () => {
    data.interests = [interest()];
    await mount();
    await dom.click(dom.button('Pausar USD'));
    expect(change).toHaveBeenCalledWith(customerFixture.accountId, 'own-interest', {
      active: false,
    });
  });
  it('requires confirmation before deleting a follow', async () => {
    data.interests = [interest()];
    await mount();
    await dom.click(dom.button('Excluir USD'));
    expect(remove).not.toHaveBeenCalled();
    await dom.click(dom.button('Excluir acompanhamento'));
    expect(remove).toHaveBeenCalledWith(customerFixture.accountId, 'own-interest');
  });
  it('does not present sent transport acceptance as confirmed delivery', async () => {
    data.history = [
      {
        id: 'h',
        label: 'Meu resumo',
        status: 'sent',
        created_at: '2026-11-16T12:00:00Z',
        sent_at: '2026-11-16T12:00:01Z',
      },
    ];
    await mount();
    expect(dom.container.textContent).toContain('Enviado');
    expect(dom.container.textContent).not.toContain('Entregue');
  });
  it('allows an expired account to pause and delete, while preventing new activation', async () => {
    baseApi.session.mockResolvedValue({
      customer: {
        ...customerFixture,
        access: { status: 'expired', expiresAt: '2026-01-01T00:00:00Z', canWrite: false },
      },
    });
    data.interests = [interest()];
    await mount();
    expect(dom.button('Adicionar assunto').disabled).toBe(true);
    expect(dom.button('Pausar USD').disabled).toBe(false);
    expect(dom.button('Excluir USD').disabled).toBe(false);
  });
  it('preserves drafts when a background refresh returns older preferences', async () => {
    data.interests = [interest()];
    vi.useFakeTimers();
    try {
      await mount();
      await dom.click(dom.button('Ajustar horários e notificações'));
      await dom.fill(dom.field('Horário do resumo'), '09:15');
      const reads = read.mock.calls.length;
      await act(async () => {
        await vi.advanceTimersByTimeAsync(60000);
      });
      expect(read.mock.calls.length).toBeGreaterThan(reads);
      expect((dom.field('Horário do resumo') as HTMLInputElement).value).toBe('09:15');
    } finally {
      vi.useRealTimers();
    }
  });
});
