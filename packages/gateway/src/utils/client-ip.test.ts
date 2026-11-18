import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

describe('explicit managed edge IP source', () => {
  beforeEach(() => {
    vi.resetModules();
    vi.stubEnv('TRUSTED_PROXY', 'true');
    vi.stubEnv('TRUSTED_PROXY_IPS', '*');
    vi.stubEnv('TRUSTED_PROXY_IP_HEADER', 'x-real-ip');
  });
  afterEach(() => vi.unstubAllEnvs());
  const request = (headers: Record<string, string>) => ({
    header: (name: string) => headers[name],
  });

  it('uses the managed edge identity even if a client supplies a different forwarded-for header', async () => {
    const { getClientIp } = await import('./client-ip.js');
    expect(
      getClientIp(request({ 'X-Real-IP': '203.0.113.12', 'X-Forwarded-For': '198.51.100.1' }))
    ).toBe('203.0.113.12');
  });
  it.each(['', 'unknown', '203.0.113.12, 198.51.100.1', '203.0.113.12:444'])(
    'fails closed for missing/malformed trusted identity %s',
    async (value) => {
      const { getClientIp } = await import('./client-ip.js');
      expect(getClientIp(request({ 'X-Real-IP': value, 'X-Forwarded-For': '198.51.100.1' }))).toBe(
        'direct'
      );
    }
  );
  it('supports IPv6 edge client addresses', async () => {
    const { getClientIp } = await import('./client-ip.js');
    expect(getClientIp(request({ 'X-Real-IP': '2001:db8::42' }))).toBe('2001:db8::42');
  });
  it('canonicalizes equivalent IPv6 and IPv4-mapped addresses', async () => {
    const { getClientIp } = await import('./client-ip.js');
    expect(getClientIp(request({ 'X-Real-IP': '2001:0DB8:0:0:0:0:0:0042' }))).toBe('2001:db8::42');
    expect(getClientIp(request({ 'X-Real-IP': '::ffff:203.0.113.12' }))).toBe('203.0.113.12');
    expect(getClientIp(request({ 'X-Real-IP': '::ffff:cb00:710c' }))).toBe('203.0.113.12');
  });
  it.each(['fe80::1%eth0', '1'.repeat(100), '203.0.113.01', 'localhost', 'user@example.test'])(
    'rejects noncanonical or non-IP edge identity %s',
    async (address) => {
      const { getClientIp } = await import('./client-ip.js');
      expect(getClientIp(request({ 'X-Real-IP': address }))).toBe('direct');
    }
  );
  it('ignores even the selected header when proxy trust has not been enabled', async () => {
    vi.stubEnv('TRUSTED_PROXY', 'false');
    const { getClientIp } = await import('./client-ip.js');
    expect(getClientIp(request({ 'X-Real-IP': '203.0.113.12' }))).toBe('direct');
  });
  it('retains the existing nearest-hop behavior for installations that do not select a header', async () => {
    vi.stubEnv('TRUSTED_PROXY_IP_HEADER', '');
    const { getClientIp } = await import('./client-ip.js');
    expect(getClientIp(request({ 'X-Forwarded-For': '198.51.100.1, 203.0.113.12' }))).toBe(
      '203.0.113.12'
    );
  });
  it.each(['unknown', '203.0.113.12,', '203.0.113.12, invalid', '127.1', '[2001:db8::1]'])(
    'rejects malformed nearest-hop identity %s instead of creating an arbitrary bucket',
    async (xff) => {
      vi.stubEnv('TRUSTED_PROXY_IP_HEADER', '');
      const { getClientIp } = await import('./client-ip.js');
      expect(getClientIp(request({ 'X-Forwarded-For': xff }))).toBe('direct');
    }
  );
  it('validates the fallback real-IP source even when no preferred header is selected', async () => {
    vi.stubEnv('TRUSTED_PROXY_IP_HEADER', '');
    const { getClientIp } = await import('./client-ip.js');
    expect(getClientIp(request({ 'X-Real-IP': 'bad-client-key' }))).toBe('direct');
    expect(getClientIp(request({ 'X-Real-IP': ' 203.0.113.12 ' }))).toBe('203.0.113.12');
  });
});
