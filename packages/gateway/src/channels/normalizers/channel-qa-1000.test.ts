/** 1,000 deterministic offline simulations; no real users, Groq calls or writes. */
import { describe, expect, it } from 'vitest';
import type { NormalizedMessage } from '@ownpilot/core/services';
import { whatsappNormalizer } from './whatsapp.js';
import { telegramNormalizer } from './telegram.js';
import { formatChannelTables } from './channel-table-format.js';
import { markdownToTelegramHtml } from '../utils/markdown-telegram.js';
import { userFacingAgentError } from '../../services/middleware/agent-execution.js';

const cases = Array.from({ length: 1000 }, (_, n) => n);
const sampleMessage = (source: 'channel' | 'web'): NormalizedMessage =>
  ({
    id: 'offline-qa',
    sessionId: 'offline-session',
    role: 'user',
    content: 'Oi',
    metadata: { source, platform: 'telegram' },
    timestamp: new Date('2026-11-07T12:00:00Z'),
  }) as NormalizedMessage;

describe('Astra: 1.000 simulações seguras de respostas de canais', () => {
  it.each(cases)('simulação %i: tabelas, mensagens, erros ou limites', (id) => {
    const kind = id % 4;
    const value = (50 + id / 100).toFixed(2).replace('.', ',');
    const title = 'Jogar o lixo fora ' + id;

    if (kind === 0) {
      const table = [
        '**Seus lembretes de hoje**',
        '| Título | Descrição | Prioridade | Status |',
        '| --- | --- | --- | --- |',
        '| ' + title + ' | Em 1 minuto | alta | pendente |',
        '| Almoço ' + id + ' | R$ ' + value + ' | média | concluído |',
      ].join('\n');
      const wa = whatsappNormalizer.normalizeOutgoing(table).join('\n');
      const tg = telegramNormalizer.normalizeOutgoing(table).join('\n');
      expect(wa).toContain('*' + title + '*');
      expect(wa).toContain('Prioridade: alta');
      expect(wa).toContain('R$ ' + value);
      expect(tg).toContain('**' + title + '**');
      expect(markdownToTelegramHtml(tg)).toContain('<b>' + title + '</b>');
      expect(wa).not.toContain('| --- |');
      expect(tg).not.toContain('| Título |');
      return;
    }

    if (kind === 1) {
      const text = [
        'Mostre a tabela, mas preserve o código:',
        '```sql',
        '| coluna | campo |',
        '| --- | --- |',
        '| valor | mantido |',
        '```',
        '| Nome | Gasto |',
        '| --- | --- |',
        '| Café ' + id + ' | R$ ' + value + ' |',
        'Observação: entrada A | entrada B',
      ].join('\n');
      const converted = formatChannelTables(text);
      expect(converted).toContain('| coluna | campo |');
      expect(converted).toContain('• **Café ' + id + '**');
      expect(converted).toContain('Gasto: R$ ' + value);
      expect(converted).toContain('entrada A | entrada B');
      expect(formatChannelTables(converted)).toBe(converted);
      return;
    }

    if (kind === 2) {
      const detail =
        'OpenAI API error: 429 - Rate limit reached for model on tokens per minute (TPM). ' +
        'Used ' + (4000 + id) + ', Requested ' + (2300 + id) + '. ' +
        'Organization org_private_' + id;
      const response = userFacingAgentError(sampleMessage('channel'), detail);
      expect(response).toContain('Groq');
      expect(response).toContain('limite');
      expect(response).not.toContain('org_private');
      expect(response).not.toContain('429');
      expect(response).not.toContain('OpenAI API');
      expect(userFacingAgentError(sampleMessage('web'), detail)).toContain(detail);
      return;
    }

    // 250 varied long messages: preserve Unicode, split safely and strip tags.
    const longText =
      '**Anotações de hoje**\n' +
      ('Paguei R$ ' + value + ' no almoço. 🧾 Lembrete ' + id + '. ').repeat(130 + (id % 50)) +
      '<suggestions>[{"title":"interno"}]</suggestions>';
    for (const normalizer of [whatsappNormalizer, telegramNormalizer]) {
      const parts = normalizer.normalizeOutgoing(longText);
      expect(parts.length).toBeGreaterThan(1);
      for (const part of parts) {
        expect(part.length).toBeLessThanOrEqual(4096);
        expect(part).not.toContain('<suggestions>');
      }
      expect(parts.join('\n')).toContain('R$ ' + value);
    }
  });
});
