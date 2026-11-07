// @vitest-environment happy-dom

import { act } from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, flushAsyncUpdates, hasText, render } from '../test-harness';
import { EdgeDevicesPage } from './EdgeDevicesPage';

const { mockList, mockMqttStatus } = vi.hoisted(() => ({
  mockList: vi.fn(),
  mockMqttStatus: vi.fn(),
}));

vi.mock('../api/endpoints/edge', () => ({
  edgeApi: {
    list: (...args: unknown[]) => mockList(...args),
    getMqttStatus: (...args: unknown[]) => mockMqttStatus(...args),
  },
}));

vi.mock('../hooks/useWebSocket', () => ({
  useGateway: () => ({ subscribe: () => () => {} }),
}));

vi.mock('../hooks/useSkipHome', async () => {
  const { useEffect, useRef } = await import('react');
  return {
    useSkipHome: ({
      defaultTab,
      onNavigate,
    }: {
      defaultTab?: string;
      onNavigate?: (tab: string) => void;
    }) => {
      const didNavigate = useRef(false);
      useEffect(() => {
        if (didNavigate.current) return;
        didNavigate.current = true;
        if (defaultTab && onNavigate) onNavigate(defaultTab);
      });
      return { skipHome: true, onSkipHomeChange: () => {} };
    },
  };
});

vi.mock('../components/icons', async () => {
  const { createIconStubs } = await import('../test-harness');
  return createIconStubs();
});

vi.mock('../components/DeviceCard', () => ({ DeviceCard: () => null }));
vi.mock('../components/RegisterDeviceModal', () => ({ RegisterDeviceModal: () => null }));
vi.mock('../components/DeviceDetailDrawer', () => ({ DeviceDetailDrawer: () => null }));
vi.mock('../components/EdgeDevicesOnboarding', () => ({
  EdgeDevicesOnboarding: () => <p>Nenhum dispositivo conectado</p>,
}));
vi.mock('../components/PageHomeTab', () => ({ PageHomeTab: () => null }));
vi.mock('../components/Skeleton', () => ({ SkeletonCard: () => null }));

describe('EdgeDevicesPage', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockList.mockResolvedValue({ devices: [], total: 0 });
    mockMqttStatus.mockResolvedValue({ connected: false });
  });

  afterEach(cleanup);

  it('shows Portuguese labels and loads real device data', async () => {
    const container = render(<EdgeDevicesPage />);
    await flushAsyncUpdates();

    expect(mockList).toHaveBeenCalled();
    expect(hasText(container, 'Dispositivos conectados')).toBe(true);
    expect(hasText(container, 'Cadastrar dispositivo')).toBe(true);
    expect(hasText(container, 'Nenhum dispositivo conectado')).toBe(true);
  });

  it('shows an accessible error instead of masking an API failure as an empty list', async () => {
    mockList.mockRejectedValue(new Error('HTTP 500'));
    const container = render(<EdgeDevicesPage />);
    await flushAsyncUpdates();

    const error = container.querySelector('[role="alert"]');
    expect(error).not.toBeNull();
    expect(hasText(container, 'Não foi possível carregar os dispositivos.')).toBe(true);
    expect(hasText(container, 'Nenhum dispositivo conectado')).toBe(false);
    expect(hasText(container, 'Tentar novamente')).toBe(true);
  });

  it('retries the request and clears the error when the API recovers', async () => {
    mockList
      .mockRejectedValueOnce(new Error('HTTP 500'))
      .mockResolvedValue({ devices: [], total: 0 });
    const container = render(<EdgeDevicesPage />);
    await flushAsyncUpdates();

    const retry = [...container.querySelectorAll('button')].find((button) =>
      button.textContent?.includes('Tentar novamente')
    );
    expect(retry).toBeDefined();
    await act(async () => {
      retry!.click();
    });
    await flushAsyncUpdates();

    expect(mockList.mock.calls.length).toBeGreaterThan(1);
    expect(container.querySelector('[role="alert"]')).toBeNull();
    expect(hasText(container, 'Nenhum dispositivo conectado')).toBe(true);
  });
});
