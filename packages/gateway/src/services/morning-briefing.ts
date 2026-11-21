import type { MorningComponents } from '../channels/morning-components.js';
import { verifiedChannelFacts } from '../channels/verified-facts.js';
import { formatAstraMessage } from '../channels/response-presentation.js';
import { customerLocalDay } from './customer-date.js';
import { dailyGreetingText } from './daily-greeting-content.js';
import { customerWeather } from './customer-weather.js';
import { customerIntegrationService } from './customer-integrations.js';
import { buildEmailDigest } from './email-digest.js';
import { getLog } from './log.js';

const log = getLog('MorningBriefing');
/** Bounded diagnostics only: never log provider bodies, location, accounts or message text. */
export function morningWeatherFailureCategory(error: unknown): string {
  if (!(error instanceof Error)) return 'unknown';
  if (error.message === 'briefing_deadline') return 'deadline';
  if (error.message === 'weather_invalid_result') return 'invalid_result';
  if (/desatualizada/u.test(error.message)) return 'stale_forecast';
  if (/veio incompleta/u.test(error.message)) return 'invalid_provider_response';
  if (/consultar o tempo agora/u.test(error.message)) return 'provider_unavailable';
  if (error.name === 'TimeoutError' || error.name === 'AbortError') return 'provider_timeout';
  if (/fetch failed|ENOTFOUND|ECONNRESET|ETIMEDOUT/iu.test(error.message)) return 'network_failure';
  return 'storage_or_unknown';
}

async function beforeDeadline<T>(promise: Promise<T>, deadline: number): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      promise,
      new Promise<never>((_, reject) => {
        timer = setTimeout(
          () => reject(new Error('briefing_deadline')),
          Math.max(0, deadline - Date.now())
        );
        timer.unref?.();
      }),
    ]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}
const emailUnavailable =
  '📬 *E-mails importantes*\nNão consegui consultar seus e-mails agora. Confira a conexão do Gmail em Painel → Conexões.';

/** Independent read-only components: one failed provider never erases the remaining briefing. */
export async function buildMorningBriefing(
  userId: string,
  channelPluginId: string,
  timeZone: string,
  parts: MorningComponents,
  now = new Date()
): Promise<string> {
  const day = customerLocalDay(now, timeZone);
  if (!parts.withWeather && !parts.withEmailDigest)
    return dailyGreetingText(day, !!parts.withCuriosity);
  const started = Date.now();
  const weather = parts.withWeather
    ? beforeDeadline(
        (async () => {
          const data = await customerWeather(userId);
          if (!('needsCity' in data) && !('temperatureC' in data))
            throw new Error('weather_invalid_result');
          // This is the actual service result, rendered by the same fact validator as tool calls.
          const text = verifiedChannelFacts('', [
            {
              name: 'core.get_local_weather',
              arguments: '',
              content: JSON.stringify({ success: true, result: data }),
              isError: false,
            },
          ]);
          return text?.startsWith('🌤️')
            ? text
            : formatAstraMessage(
                '🌤️ Temperatura',
                [],
                text ?? 'Não consegui consultar o tempo agora.'
              );
        })(),
        started + 8000
      )
    : Promise.resolve(null);
  const email = parts.withEmailDigest
    ? beforeDeadline(
        (async () => {
          const binding = await customerIntegrationService.binding(userId, 'gmail');
          const text = await buildEmailDigest(userId, channelPluginId, binding.connection.id, {
            previousDay: parts.emailPreviousDay !== false,
            timeZone,
            now,
            deadline: started + 12000,
          });
          return { text, binding };
        })(),
        started + 12000
      )
    : Promise.resolve(null);
  const [weatherResult, emailResult] = await Promise.allSettled([weather, email]);
  const sections = [dailyGreetingText(day, !!parts.withCuriosity, false)];
  if (parts.withWeather) {
    if (weatherResult.status === 'fulfilled' && weatherResult.value)
      sections.push(weatherResult.value);
    else {
      sections.push('🌤️ *Temperatura*\nNão consegui consultar o tempo agora.');
      log.warn('Componente do resumo indisponível', {
        component: 'weather',
        category:
          weatherResult.status === 'rejected'
            ? morningWeatherFailureCategory(weatherResult.reason)
            : 'empty_result',
      });
    }
  }
  if (parts.withEmailDigest) {
    if (emailResult.status === 'fulfilled' && emailResult.value) {
      try {
        // Cancellation/revocation/relinking during either parallel read must hide old private data.
        const old = emailResult.value.binding;
        const current = await beforeDeadline(
          customerIntegrationService.binding(userId, 'gmail', old.connection.id),
          started + 12000
        );
        if (
          current.connection.id !== old.connection.id ||
          current.account.id !== old.account.id ||
          current.account.phoneNumber !== old.account.phoneNumber
        )
          throw new Error('binding_changed');
        sections.push(emailResult.value.text);
      } catch {
        sections.push(emailUnavailable);
        log.warn('Componente do resumo indisponível', { component: 'email_binding' });
      }
    } else {
      sections.push(emailUnavailable);
      log.warn('Componente do resumo indisponível', { component: 'email' });
    }
  }
  sections.push('Que hoje seja um ótimo dia para você! ✨');
  return sections.join('\n\n');
}
