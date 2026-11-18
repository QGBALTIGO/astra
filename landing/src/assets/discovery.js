// Deliberately bounded attribution: a source name, never a URL or search text.
const campaignSources = new Map([
  ['chatgpt', 'chatgpt'],
  ['chatgpt.com', 'chatgpt'],
  ['google', 'google'],
  ['google.com', 'google'],
  ['bing', 'bing'],
  ['bing.com', 'bing'],
  ['perplexity', 'perplexity'],
  ['perplexity.ai', 'perplexity'],
  ['gemini', 'gemini'],
  ['gemini.google.com', 'gemini'],
  ['copilot', 'copilot'],
  ['copilot.microsoft.com', 'copilot'],
]);
const referralSources = new Map([
  ['chatgpt.com', 'chatgpt'],
  ['www.chatgpt.com', 'chatgpt'],
  ['chat.openai.com', 'chatgpt'],
  ['google.com', 'google'],
  ['www.google.com', 'google'],
  ['google.com.br', 'google'],
  ['www.google.com.br', 'google'],
  ['bing.com', 'bing'],
  ['www.bing.com', 'bing'],
  ['perplexity.ai', 'perplexity'],
  ['www.perplexity.ai', 'perplexity'],
  ['gemini.google.com', 'gemini'],
  ['copilot.microsoft.com', 'copilot'],
]);

export function discoverySource(search, referrer) {
  let host = '';
  try {
    const url = new URL(typeof referrer === 'string' ? referrer : '');
    if (['https:', 'http:'].includes(url.protocol) && !url.username && !url.password)
      host = url.hostname;
  } catch {}
  // Navigation within Astra must not become a new attributed entry.
  if (
    host === 'astraacessor.pro' ||
    host.endsWith('.astraacessor.pro') ||
    host === 'astra-landing-production.up.railway.app'
  )
    return null;
  const sources = new URLSearchParams(typeof search === 'string' ? search : '').getAll(
    'utm_source'
  );
  const campaign = sources.length === 1 ? campaignSources.get(sources[0]) : null;
  return campaign || referralSources.get(host) || null;
}
