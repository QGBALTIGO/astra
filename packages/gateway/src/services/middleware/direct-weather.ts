/**
 * Simple, read-only weather questions do not need a second model completion.
 * The existing weather tool owns city preferences, provider access and fact validation.
 * Never intercept compound requests, forecasts for another date, or city writes.
 */
import { randomUUID } from 'node:crypto';
import type { MessageMiddleware, MessageProcessingResult, StreamCallbacks } from '@ownpilot/core/services';
import { getExecContext } from '@ownpilot/core/agent';
import { executeCustomerWeatherTool } from '../../tools/customer-weather-tools.js';
import { verifiedChannelFacts } from '../../channels/verified-facts.js';
import { getLog } from '../log.js';

const log = getLog('DirectWeather');
const currentQuestions = [
  /^(?:qual (?:e )?a )?temperatura(?: agora| atual| de hoje)?$/u,
  /^(?:qual (?:e )?o )?clima(?: agora| de hoje)?$/u,
  /^tempo(?: agora| hoje)?$/u,
  /^como (?:esta|ta) o tempo(?: agora| hoje)?$/u,
  /^quantos graus (?:faz|esta fazendo|ta fazendo|esta|ta)(?: agora| hoje)?$/u,
  /^me (?:diga|fala|informe) (?:a )?temperatura(?: agora| de hoje)?$/u,
];

/** A conservative allowlist: unknown phrasing goes to the ordinary agent. */
export function currentWeatherOnlyQuery(text: string): { city?: string } | null {
  const trimmed = text.trim().replace(/\s+/gu, ' ').replace(/[?!.\s]+$/gu, '');
  if (!trimmed || trimmed.length > 140) return null;
  const parts = /^(.*?)(?:\s+em\s+([\p{L}\p{M}\s,.'()–-]{2,100}))?$/iu.exec(trimmed);
  if (!parts) return null;
  const question = (parts[1] ?? '').normalize('NFD').replace(/[\u0300-\u036f]/gu, '').toLowerCase();
  if (!currentQuestions.some((pattern) => pattern.test(question))) return null;
  const city = parts[2]?.trim();
  if (!city) return {};
  // "em minha cidade" means the saved preference, never a geocoding guess.
  if (/^(?:minha cidade|onde moro|aqui)$/iu.test(city)) return {};
  return { city };
}

export function createDirectWeatherMiddleware(): MessageMiddleware {
  return async (message, ctx, next) => {
    const channel = getExecContext();
    const userId = ctx.get<string>('userId') ?? 'default';
    const request =
      message.metadata.source === 'channel' &&
      message.metadata.platform === 'whatsapp' &&
      channel?.channelIsPrivate === true &&
      userId.startsWith('whatsapp:') &&
      !message.attachments?.length
        ? currentWeatherOnlyQuery(message.content)
        : null;
    if (!request) return next();

    const started = Date.now();
    let responseText: string;
    try {
      const weather = await executeCustomerWeatherTool('get_local_weather', request, userId);
      const receipt = {
        name: 'core.get_local_weather',
        arguments: '',
        isError: weather.success === false,
        content: JSON.stringify(weather),
      };
      responseText =
        verifiedChannelFacts('', [receipt], { requestText: message.content }) ??
        'Não consegui consultar o tempo agora. Pode tentar de novo em instantes?';
      log.info('Consulta simples de clima finalizada sem IA', {
        outcome: weather.success ? 'verified' : 'unavailable',
      });
    } catch (error) {
      // No exception text, request text, location or user identifier in telemetry.
      log.warn('Consulta simples de clima indisponível', {
        category: error instanceof Error ? error.name : 'unknown',
      });
      responseText = 'Não consegui consultar o tempo agora. Pode tentar de novo em instantes?';
    }
    const result: MessageProcessingResult = {
      response: {
        id: randomUUID(),
        sessionId: message.sessionId,
        role: 'assistant',
        content: responseText,
        metadata: { ...message.metadata, provider: 'verified-weather' },
        timestamp: new Date(),
      },
      streamed: false,
      durationMs: Date.now() - started,
      stages: ['direct-weather'],
    };
    // The outer persistence and audit stages still run, but there are no AI tokens
    // and no memory-extraction or action side effects for a read-only weather check.
    ctx.set('pipelineResult', result);
    ctx.get<StreamCallbacks>('stream')?.onDone?.(result);
    return result;
  };
}
