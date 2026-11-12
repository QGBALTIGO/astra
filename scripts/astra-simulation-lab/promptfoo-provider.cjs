'use strict';
/**
 * Opt-in Promptfoo provider with a hard isolation fence.
 * Cannot point at Railway, public hosts or the user's PC Ollama.
 * An independent test adapter MUST validate fake identities and state,
 * return a simulation receipt, and have NO production credentials.
 */
class AstraIsolatedProvider {
  id() {
    return 'astra-isolated-loopback-adapter-not-production';
  }
  async callApi(prompt) {
    if (
      process.env.ASTRA_LAB_ISOLATED !== '1' ||
      process.env.RAILWAY_ENVIRONMENT_ID ||
      process.env.DATABASE_URL ||
      process.env.POSTGRES_HOST ||
      process.env.OLLAMA_HOST
    ) {
      return { error: 'ASTRA_LAB_ISOLATION_GATE_NOT_SATISFIED' };
    }
    const raw = process.env.ASTRA_LAB_ADAPTER_URL;
    if (!raw) return { error: 'ASTRA_LAB_ADAPTER_NOT_CONFIGURED' };
    let url;
    try {
      url = new URL(raw);
      if (
        url.protocol !== 'http:' ||
        !['127.0.0.1', 'localhost', '[::1]'].includes(url.hostname) ||
        url.username || url.password || url.search || url.hash ||
        url.pathname !== '/astra-lab/eval'
      ) throw new Error('unsupported URL');
    } catch {
      return { error: 'ASTRA_LAB_ADAPTER_MUST_BE_LOOPBACK_ONLY' };
    }
    if (typeof prompt !== 'string' || prompt.length > 1000) {
      return { error: 'ASTRA_LAB_INVALID_SYNTHETIC_INPUT' };
    }
    try {
      const response = await fetch(url, {
        method: 'POST',
        redirect: 'error',
        headers: { 'content-type': 'application/json', 'x-astra-lab-isolated': '1' },
        body: JSON.stringify({ synthetic: true, subject: 'SIM-P00000', message: prompt }),
        signal: AbortSignal.timeout(5000),
      });
      if (!response.ok) return { error: 'ASTRA_LAB_ADAPTER_HTTP_FAILURE' };
      const data = await response.json();
      if (data?.synthetic !== true || data?.realUsers === true ||
          typeof data?.reply !== 'string' || data.reply.length > 4000) {
        return { error: 'ASTRA_LAB_ADAPTER_UNVERIFIED_RESPONSE' };
      }
      return {
        output: data.reply,
        metadata: {
          source: 'isolated_adapter',
          synthetic: true,
          stateVerified: data.stateVerified === true,
          toolCalls: Array.isArray(data.toolCalls) ? data.toolCalls.length : null,
        },
      };
    } catch {
      return { error: 'ASTRA_LAB_ADAPTER_UNAVAILABLE' };
    }
  }
}
module.exports = AstraIsolatedProvider;
