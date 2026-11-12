/**
 * gateway-client tests — credential header + insecure-target warning.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

describe('gatewayHeaders', () => {
  const savedEnv = { ...process.env };
  let warnSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    // Fresh module each test so the warn-once flag resets.
    vi.resetModules();
    delete process.env.OWNPILOT_API_KEY;
    delete process.env.OWNPILOT_JWT;
    delete process.env.OWNPILOT_GATEWAY_URL;
    warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
  });

  afterEach(() => {
    warnSpy.mockRestore();
    process.env = { ...savedEnv };
  });

  async function loadHeaders() {
    return (await import('./gateway-client.js')).gatewayHeaders;
  }

  it('attaches no Authorization header when no credential is configured', async () => {
    const gatewayHeaders = await loadHeaders();
    const h = gatewayHeaders();
    expect(h.Authorization).toBeUndefined();
    expect(warnSpy).not.toHaveBeenCalled();
  });

  it('attaches a Bearer token from OWNPILOT_API_KEY (preferred over JWT)', async () => {
    process.env.OWNPILOT_API_KEY = 'k1';
    process.env.OWNPILOT_JWT = 'j1';
    const gatewayHeaders = await loadHeaders();
    expect(gatewayHeaders().Authorization).toBe('Bearer k1');
  });

  it('falls back to OWNPILOT_JWT when no API key is set', async () => {
    process.env.OWNPILOT_JWT = 'j1';
    const gatewayHeaders = await loadHeaders();
    expect(gatewayHeaders().Authorization).toBe('Bearer j1');
  });

  it('does NOT warn for a loopback http gateway (default local use)', async () => {
    process.env.OWNPILOT_API_KEY = 'k1';
    process.env.OWNPILOT_GATEWAY_URL = 'http://localhost:8080';
    const gatewayHeaders = await loadHeaders();
    gatewayHeaders();
    expect(warnSpy).not.toHaveBeenCalled();
  });

  it('does NOT warn for an https remote gateway', async () => {
    process.env.OWNPILOT_API_KEY = 'k1';
    process.env.OWNPILOT_GATEWAY_URL = 'https://gw.example.com';
    const gatewayHeaders = await loadHeaders();
    gatewayHeaders();
    expect(warnSpy).not.toHaveBeenCalled();
  });

  it('warns when a credential would be sent cleartext to a non-loopback http host', async () => {
    process.env.OWNPILOT_API_KEY = 'k1';
    process.env.OWNPILOT_GATEWAY_URL = 'http://gw.example.com:8080';
    const gatewayHeaders = await loadHeaders();
    gatewayHeaders();
    expect(warnSpy).toHaveBeenCalledWith(expect.stringContaining('cleartext'));
  });

  it('does not warn on remote http when no credential is set (nothing to leak)', async () => {
    process.env.OWNPILOT_GATEWAY_URL = 'http://gw.example.com:8080';
    const gatewayHeaders = await loadHeaders();
    gatewayHeaders();
    expect(warnSpy).not.toHaveBeenCalled();
  });
});
