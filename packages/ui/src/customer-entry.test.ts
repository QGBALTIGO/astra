import { describe, expect, it } from 'vitest';
import { customerEntryPath } from './customer-entry';

describe('entrypoint for a cached PWA or a direct link', () => {
  it.each([
    ['https://app.astraacessor.pro/', '/cliente/entrar'],
    ['https://app.astraacessor.pro/?next=https://example.org', '/cliente/entrar'],
    ['https://app.astraacessor.pro/cliente/agenda?dia=hoje', '/cliente/agenda'],
    ['https://app.astraacessor.pro/login', null],
    ['https://app.astraacessor.pro/clientela', null],
    ['https://astra-gateway-production.up.railway.app/', null],
    ['https://astra-gateway-production.up.railway.app/cliente/entrar', '/cliente/entrar'],
    ['https://app.astraacessor.pro.example.org/', null],
  ] as const)('opens the intended app for %s', (url, expected) => {
    expect(customerEntryPath(new URL(url))).toBe(expected);
  });
});
