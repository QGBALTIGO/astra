import { afterEach, describe, expect, it, vi } from 'vitest';
import { createHmac } from 'node:crypto';

const sms = vi.hoisted(() => ({ processIncomingMessage: vi.fn().mockResolvedValue(undefined) }));
vi.mock('@ownpilot/core/channels', () => ({
  hasChannelService: () => true,
  getChannelService: () => ({
    getChannel: () => ({
      getStatus: () => 'connected',
      getAuthInfo: () => ({ authToken: 'synthetic-twilio-token' }),
    }),
    processIncomingMessage: sms.processIncomingMessage,
  }),
}));

const ENV_KEYS = ['TRUSTED_PROXY', 'TRUSTED_PROXY_IPS'] as const;

function request(url: string, headers: Record<string, string> = {}) {
  return {
    url,
    header: (name: string) => headers[name.toLowerCase()],
  };
}

async function loadIsSecureRequest() {
  vi.resetModules();
  return (await import('./trusted-proxy.js')).isSecureRequest;
}

afterEach(() => {
  for (const key of ENV_KEYS) delete process.env[key];
  vi.resetModules();
});

describe('isSecureRequest', () => {
  it('recognizes HTTPS from the request URL', async () => {
    const isSecureRequest = await loadIsSecureRequest();
    expect(isSecureRequest(request('https://ownpilot.local/path'))).toBe(true);
  });

  it('ignores forwarded scheme headers when proxy trust is disabled', async () => {
    const isSecureRequest = await loadIsSecureRequest();
    expect(
      isSecureRequest(
        request('http://ownpilot.local/path', {
          'x-forwarded-proto': 'https',
        })
      )
    ).toBe(false);
  });

  it('ignores forwarded scheme headers when the trusted proxy allowlist is missing', async () => {
    process.env.TRUSTED_PROXY = 'true';
    const isSecureRequest = await loadIsSecureRequest();
    expect(
      isSecureRequest(
        request('http://ownpilot.local/path', {
          'x-forwarded-proto': 'https',
        })
      )
    ).toBe(false);
  });

  it('accepts forwarded HTTPS only with a configured trusted proxy', async () => {
    process.env.TRUSTED_PROXY = 'true';
    process.env.TRUSTED_PROXY_IPS = '127.0.0.1';
    const isSecureRequest = await loadIsSecureRequest();
    expect(
      isSecureRequest(
        request('http://ownpilot.local/path', {
          'x-forwarded-proto': 'HTTPS',
        })
      )
    ).toBe(true);
  });

  it('preserves trusted X-Forwarded-Scheme compatibility', async () => {
    process.env.TRUSTED_PROXY = 'true';
    process.env.TRUSTED_PROXY_IPS = '127.0.0.1';
    const isSecureRequest = await loadIsSecureRequest();
    expect(
      isSecureRequest(
        request('http://ownpilot.local/path', {
          'x-forwarded-scheme': 'https',
        })
      )
    ).toBe(true);
  });

  it.each(['https,http', 'https://attacker.test', 'javascript', 'https\r\n'])(
    'rejects a malformed forwarded scheme %s',
    async (scheme) => {
      process.env.TRUSTED_PROXY = 'true';
      process.env.TRUSTED_PROXY_IPS = '*';
      const isSecureRequest = await loadIsSecureRequest();
      expect(
        isSecureRequest(request('http://gateway.internal/path', { 'x-forwarded-proto': scheme }))
      ).toBe(false);
    }
  );
});

describe('trusted forwarded origin', () => {
  async function helpers() {
    vi.resetModules();
    return import('./trusted-proxy.js');
  }

  it('ignores host/protocol claims without proxy trust', async () => {
    const { getRequestOrigin } = await helpers();
    expect(
      getRequestOrigin(
        request('http://gateway.internal/path', {
          'x-forwarded-proto': 'https',
          'x-forwarded-host': 'attacker.test',
        })
      )
    ).toBe('http://gateway.internal');
  });

  it.each([
    ['https', 'APP.EXAMPLE.TEST:443', 'https://app.example.test'],
    ['http', 'localhost:8080', 'http://localhost:8080'],
    ['HTTPS', '[2001:db8::1]:8443', 'https://[2001:db8::1]:8443'],
  ])('accepts a valid single external origin %s %s', async (scheme, host, expected) => {
    process.env.TRUSTED_PROXY = 'true';
    process.env.TRUSTED_PROXY_IPS = '*';
    const { getRequestOrigin, getRequestUrl } = await helpers();
    const req = request('http://gateway.internal/webhooks/sms', {
      'x-forwarded-proto': scheme,
      'x-forwarded-host': host,
    });
    expect(getRequestOrigin(req)).toBe(expected);
    expect(getRequestUrl(req, '/webhooks/sms')).toBe(`${expected}/webhooks/sms`);
  });

  it.each([
    'app.example.test, attacker.test',
    'user@app.example.test',
    'app.example.test/path',
    'app.example.test\\path',
    'app.example.test?query=true',
    'app.example.test#fragment',
    'https://app.example.test',
    'app.example.test:invalid',
    'app.example.test:99999',
    'app.example.test:',
    '[2001:db8::broken]',
    'app.example.test\t.attacker.test',
    'app.example.test\r\n',
    'a'.repeat(513),
  ])('falls back safely for malformed forwarded host %s', async (host) => {
    process.env.TRUSTED_PROXY = 'true';
    process.env.TRUSTED_PROXY_IPS = '*';
    const { getRequestOrigin } = await helpers();
    expect(
      getRequestOrigin(
        request('http://gateway.internal/path', {
          'x-forwarded-proto': 'https',
          'x-forwarded-host': host,
        })
      )
    ).toBe('http://gateway.internal');
  });
});

describe('SMS signature compatibility through the real webhook handler', () => {
  async function signedRequest(tamper?: 'body' | 'host') {
    process.env.TRUSTED_PROXY = 'true';
    process.env.TRUSTED_PROXY_IPS = '*';
    vi.resetModules();
    sms.processIncomingMessage.mockClear();
    const { Hono } = await import('hono');
    const { createSmsWebhookRoute } = await import('../channels/plugins/sms/webhook.js');
    const app = new Hono();
    app.route('/webhooks/sms', createSmsWebhookRoute());

    const signature = createHmac('sha1', 'synthetic-twilio-token')
      .update(
        'https://app.example.test/webhooks/sms' +
          'Bodyhello + éFrom+15551234567MessageSidSM-testTo+15557654321'
      )
      .digest('base64');
    const body = new URLSearchParams({
      From: '+15551234567',
      Body: tamper === 'body' ? 'modified text' : 'hello + é',
      To: '+15557654321',
      MessageSid: 'SM-test',
    });
    return app.request('http://gateway.internal/webhooks/sms', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/x-www-form-urlencoded',
        'X-Forwarded-Proto': 'https',
        'X-Forwarded-Host': tamper === 'host' ? 'app.example.test/path' : 'app.example.test',
        'X-Twilio-Signature': signature,
      },
      body: body.toString(),
    });
  }

  it('accepts a valid signature using the external HTTPS origin and decoded form fields', async () => {
    const response = await signedRequest();
    expect(response.status).toBe(200);
    expect(await response.text()).toBe('<Response/>');
    expect(sms.processIncomingMessage).toHaveBeenCalledWith(
      expect.objectContaining({ text: 'hello + é', platformChatId: '+15551234567' })
    );
  });

  it.each(['body', 'host'] as const)(
    'rejects a modified %s before channel delivery',
    async (tamper) => {
      const response = await signedRequest(tamper);
      expect(response.status).toBe(403);
      expect(sms.processIncomingMessage).not.toHaveBeenCalled();
    }
  );
});
