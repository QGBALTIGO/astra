import test from 'node:test';
import assert from 'node:assert/strict';
import { discoverySource } from '../src/assets/discovery.js';

test('attribution reduces recognized entry signals to a fixed source name', () => {
  assert.equal(discoverySource('?utm_source=chatgpt.com&utm_content=private-text', ''), 'chatgpt');
  assert.equal(discoverySource('', 'https://www.google.com.br/search?q=private-text'), 'google');
  assert.equal(discoverySource('', 'https://www.bing.com/search?q=private-text'), 'bing');
  assert.equal(discoverySource('', 'https://www.perplexity.ai/search/private-text'), 'perplexity');
  assert.equal(discoverySource('', 'https://gemini.google.com/app/private-chat'), 'gemini');
  assert.equal(discoverySource('', 'https://copilot.microsoft.com/chats/private-chat'), 'copilot');
  assert.equal(discoverySource('', 'https://chat.openai.com/c/private-chat'), 'chatgpt');
  assert.equal(discoverySource('?utm_source=gemini', 'https://www.google.com/'), 'gemini');
});

test('lookalike domains, userinfo tricks and embedded provider URLs receive no credit', () => {
  for (const referrer of [
    'https://chatgpt.com.evil.example/',
    'https://notgoogle.com/',
    'https://evil.example/google.com',
    'https://google.com@evil.example/',
    'https://evil.example/?next=https://www.bing.com/',
    'https://user:password@chatgpt.com/',
    'https://gemini.google.com.evil.example/',
  ])
    assert.equal(discoverySource('', referrer), null, referrer);
});

test('malformed, relative and non-web referrers remain unclassified', () => {
  for (const referrer of [
    '',
    null,
    undefined,
    'not a URL',
    '//www.google.com/',
    '/google.com',
    'https://[invalid',
    'javascript://www.google.com/search',
    'file://www.google.com/search',
    'data:text/html,https://chatgpt.com/',
  ])
    assert.equal(discoverySource('', referrer), null, String(referrer));
});

test('unknown, ambiguous and malicious campaign values are never emitted', () => {
  for (const search of [
    '?q=chatgpt.com',
    '?utm_campaign=google',
    '?utm_source=unknown',
    '?utm_source=chatgpt.com.evil.example',
    '?utm_source=https://chatgpt.com',
    '?utm_source=chatgpt-news',
    '?utm_source=__proto__',
    '?utm_source=constructor',
    '?utm_source=%3Cscript%3E',
    '?utm_source=%',
    '?utm_source=chatgpt.com&utm_source=google',
  ])
    assert.equal(discoverySource(search, ''), null, search);
  assert.equal(discoverySource('?utm_source=unknown', 'https://www.bing.com/'), 'bing');
  assert.equal(discoverySource(null, null), null);
});

test('an internal navigation never counts as another attributed entry', () => {
  for (const referrer of [
    'https://astraacessor.pro/?utm_source=chatgpt.com',
    'https://www.astraacessor.pro/financas',
    'https://app.astraacessor.pro/cliente/entrar',
    'https://astraacessor.pro/julio',
    'https://astra-landing-production.up.railway.app/',
  ])
    assert.equal(discoverySource('?utm_source=chatgpt.com', referrer), null, referrer);
});
