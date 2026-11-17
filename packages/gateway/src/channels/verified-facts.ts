import type { ChannelToolReceipt } from './response-safety.js';
import { formatAstraMessage } from './response-presentation.js';
import { integrationItems } from '../services/customer-integration-data.js';
import { requiredChannelWeatherTool } from './tool-selection.js';
import { channelOperations, isFailedChannelReceipt } from './receipt-state.js';

const plain = (value: unknown) =>
  typeof value === 'string' ? value.replace(/[\r\n*_`<>]/g, ' ').trim() : '';
function result(receipt: ChannelToolReceipt): Record<string, unknown> | null {
  try {
    const data = JSON.parse(receipt.content);
    if (receipt.isError || data.success === false || data.error) return null;
    return data.result ?? data;
  } catch {
    return null;
  }
}

const customerGoalTool =
  /^(?:core[._])?(?:list_customer_goals|(?:create|update|delete)_customer_goal)$/;
export function isCustomerGoalReceipt(receipt: ChannelToolReceipt): boolean {
  return customerGoalTool.test(receipt.name.replace(/__/g, '.'));
}
/** A goal acknowledgement is authored from the committed portal record. */
export function verifiedCustomerGoalReply(receipt: ChannelToolReceipt): string | null {
  if (!isCustomerGoalReceipt(receipt) || isFailedChannelReceipt(receipt)) return null;
  const saved = result(receipt);
  return saved?.kind === 'customer_goal' && typeof saved.reply === 'string' ? saved.reply : null;
}
/** Keep a short AI greeting; numerical and operational facts come only from receipts. */
function opening(text: string): string {
  const first = text.trim().split(/\n/)[0]?.trim() ?? '';
  return first.length <= 100 &&
    /^(?:Oi|Olá|Claro|Certo|Fechado|Vamos|Aqui|Pode deixar)\b/i.test(first) &&
    !/\d|°|salv|guard|registr|confirm|anot|memoriz|criei|agend|cidade|calor|quente|frio|chuv|nuv|temp|clima|sensação|fonte/i.test(
      first
    )
    ? first + '\n\n'
    : '';
}
function condition(value: unknown): string {
  const code = String(value ?? '');
  if (/thunder/.test(code)) return 'Possibilidade de trovoadas';
  if (/snow/.test(code)) return 'Neve prevista';
  if (/sleet/.test(code)) return 'Chuva e neve previstas';
  if (/rain/.test(code)) return 'Chuva prevista';
  if (/fog/.test(code)) return 'Neblina';
  if (/partlycloudy/.test(code)) return 'Parcialmente nublado';
  if (/cloudy/.test(code)) return 'Nublado';
  if (/fair/.test(code)) return 'Poucas nuvens';
  if (/clearsky/.test(code)) return 'Céu aberto';
  return '';
}
/** Only the audited Radar tool's complete reply can finish this narrow channel turn. */
export function verifiedRadarToolReply(
  response: { content: string; toolCalls?: readonly { name: string; arguments?: string }[] },
  results: readonly { content: string; isError: boolean }[]
): string | undefined {
  const calls = response.toolCalls ?? [];
  if (
    !calls.length ||
    calls.length !== results.length ||
    calls.some((c) => !/^(?:core[._])?manage_radar$/.test(c.name.replace(/__/g, '.')))
  )
    return;
  const receipts = results.map((r) => ({ ...r, name: 'core.manage_radar', arguments: '' }));
  // Listing can be intermediate, but a corrected explicit request that has
  // already produced a question/confirmation needs no second model round.
  if (
    calls.some((call, index) => {
      try {
        if (JSON.parse(call.arguments ?? '{}').action !== 'status') return false;
        const data = result(receipts[index]!);
        return !(
          data?.kind === 'radar' &&
          (data.needsTime === true || data.needsSubject === true || data.changed === true)
        );
      } catch {
        return true;
      }
    })
  )
    return;
  if (
    receipts.some((r) => {
      const data = result(r);
      if (data?.kind === 'radar' && typeof data.reply === 'string') return false;
      try {
        const envelope = JSON.parse(r.content);
        return envelope.success !== false || typeof envelope.error !== 'string';
      } catch {
        return true;
      }
    })
  )
    return;
  return verifiedChannelFacts(response.content, receipts);
}
export function verifiedChannelFacts(
  text: string,
  receipts: ChannelToolReceipt[],
  context: { timeZone?: string; requestText?: string } = {}
): string | undefined {
  const goalOperations = channelOperations(receipts);
  if (goalOperations.length && goalOperations.every(isCustomerGoalReceipt)) {
    const changes = goalOperations.filter(
      (receipt) => !receipt.name.endsWith('list_customer_goals')
    );
    return (changes.length ? changes : goalOperations.slice(-1))
      .map(
        (receipt) =>
          verifiedCustomerGoalReply(receipt) ??
          'Não consegui confirmar essa operação de meta agora. Confira o painel antes de tentar novamente.'
      )
      .join('\n\n');
  }
  const radar = receipts.findLast((r) =>
    /^(?:core[._])?manage_radar$/.test(r.name.replace(/__/g, '.'))
  );
  if (
    radar &&
    receipts.every((r) =>
      /^(?:(?:core[._])?manage_radar|search_tools|get_tool_help|use_tool|batch_use_tool)$/.test(
        r.name.replace(/__/g, '.')
      )
    )
  ) {
    const data = result(radar);
    let friendlyError: string | undefined;
    try {
      const envelope = JSON.parse(radar.content);
      if (
        typeof envelope.error === 'string' &&
        envelope.error.length < 400 &&
        /^(?:Me |Entre |Configure |Use |Peça |Envie |Renove |O calendário|Seu |Esse |Essa |Selecione|Escolha|Informe|Confira|Não consegui)/.test(
          envelope.error
        )
      )
        friendlyError = envelope.error;
    } catch {
      /* An invalid receipt cannot become a success acknowledgement. */
    }
    return data?.kind === 'radar' && typeof data.reply === 'string'
      ? opening(text) + data.reply
      : '📡 ' +
          (friendlyError ??
            'Não consegui confirmar essa alteração no Radar agora. Seus assuntos continuam salvos. Pode me pedir para conferir novamente.');
  }
  const digest = receipts.findLast((r) =>
    /^(?:core[._])?manage_email_digest$/.test(r.name.replace(/__/g, '.'))
  );
  const digestResult = digest ? result(digest) : null;
  const digestReply =
    digestResult?.kind === 'email_digest' && typeof digestResult.reply === 'string'
      ? digestResult.reply
      : digest
        ? '📬 Não consegui confirmar o resumo de e-mails agora. Confira sua conexão em Painel → Conexões.'
        : undefined;
  const combined = (weather: string) => [weather, digestReply].filter(Boolean).join('\n\n');
  const weatherReceipts = receipts.filter((r) =>
    /^(?:core[._])?(?:get_local_weather|set_weather_city)$/.test(r.name.replace(/__/g, '.'))
  );
  const read = [...weatherReceipts].reverse().find((r) => r.name.endsWith('get_local_weather'));
  const saved = [...weatherReceipts]
    .reverse()
    .map(result)
    .find((r) => r?.saved === true);
  const data = read ? result(read) : null;
  if (data?.needsCity === true)
    return combined(plain(data.question) || 'Qual é a sua cidade e estado?');
  if (
    data &&
    typeof data.temperatureC === 'number' &&
    Number.isFinite(data.temperatureC) &&
    data.kind === 'model_estimate'
  ) {
    const city = [plain(data.city), plain(data.region)].filter(Boolean).join(', ');
    const fields = [
      {
        label: 'Temperatura',
        value: data.temperatureC.toLocaleString('pt-BR') + ' °C · estimativa',
      },
    ];
    const sky = condition(data.conditionCode);
    if (sky) fields.push({ label: 'Condição', value: sky });
    if (typeof data.humidityPercent === 'number' && Number.isFinite(data.humidityPercent))
      fields.push({ label: 'Umidade', value: Math.round(data.humidityPercent) + '%' });
    if (typeof data.windKmH === 'number' && Number.isFinite(data.windKmH))
      fields.push({ label: 'Vento', value: data.windKmH + ' km/h' });
    return combined(
      opening(text) +
        formatAstraMessage('🌤️ Tempo em ' + city, fields) +
        (saved ? '\n\nCidade guardada para as próximas consultas.' : '')
    );
  }
  if (weatherReceipts.length) {
    if (saved)
      return combined(
        formatAstraMessage(
          '📍 Cidade guardada',
          [
            {
              label: 'Cidade',
              value: [plain(saved.city), plain(saved.region)].filter(Boolean).join(', '),
            },
          ],
          'Ainda não consegui consultar a temperatura agora.'
        )
      );
    return combined('Não consegui consultar o tempo agora. Pode tentar de novo em instantes?');
  }
  if (digestReply) return digestReply;
  if (
    requiredChannelWeatherTool(context.requestText ?? '') &&
    /-?\d+(?:[.,]\d+)?\s*(?:°|graus)|(?:cidade.{0,25}(?:salva|guardada)|(?:salvei|guardei).{0,25}cidade)/i.test(
      text
    )
  )
    return 'Ainda não tenho uma consulta confirmada do tempo. Qual é a sua cidade e estado?';

  if (!/\b(?:evento|compromisso)s?\b/i.test(context.requestText ?? '')) return undefined;
  for (const receipt of [...receipts].reverse()) {
    if (!receipt.name.endsWith('run_connected_action')) continue;
    const value = result(receipt);
    if (value?.source !== 'Google Agenda' || !value.untrustedExternalData) continue;
    const timeZone = context.timeZone || 'UTC';
    const items = integrationItems(
      'googlecalendar',
      value.untrustedExternalData,
      timeZone
    ).items.filter((item) => item.kind === 'event' && item.start);
    if (!items.length) continue;
    const date = new Intl.DateTimeFormat('pt-BR', { timeZone, dateStyle: 'short' });
    const time = new Intl.DateTimeFormat('pt-BR', {
      timeZone,
      hour: '2-digit',
      minute: '2-digit',
      hour12: false,
    });
    return items
      .slice(0, 5)
      .map((item) =>
        formatAstraMessage(
          '📅 Google Agenda',
          [
            { label: 'Evento', value: item.title },
            { label: 'Data', value: date.format(new Date(item.start!)) },
            {
              label: 'Horário',
              value: item.allDay
                ? 'Dia inteiro'
                : time.format(new Date(item.start!)) +
                  (item.end ? ' às ' + time.format(new Date(item.end)) : ''),
            },
          ],
          'Horários no seu fuso: ' + timeZone
        )
      )
      .join('\n\n');
  }
  return undefined;
}
