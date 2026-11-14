import type { ChannelToolReceipt } from './response-safety.js';
import { formatAstraMessage } from './response-presentation.js';
import { integrationItems } from '../services/customer-integration-data.js';
import { requiredChannelWeatherTool } from './tool-selection.js';
import { ASTRA_CUSTOMER_ORIGIN } from '../config/astra-public-urls.js';

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
export function verifiedChannelFacts(
  text: string,
  receipts: ChannelToolReceipt[],
  context: { timeZone?: string; requestText?: string } = {}
): string | undefined {
  const weatherReceipts = receipts.filter((r) =>
    /^(?:core[._])?(?:get_local_weather|set_weather_city)$/.test(r.name.replace(/__/g, '.'))
  );
  const read = [...weatherReceipts].reverse().find((r) => r.name.endsWith('get_local_weather'));
  const saved = [...weatherReceipts]
    .reverse()
    .map(result)
    .find((r) => r?.saved === true);
  const data = read ? result(read) : null;
  if (data?.needsCity === true) return plain(data.question) || 'Qual é a sua cidade e estado?';
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
    return (
      opening(text) +
      formatAstraMessage(
        '🌤️ Tempo em ' + city,
        fields,
        'Fonte: MET Norway · © OpenStreetMap\nFontes e licença: ' +
          ASTRA_CUSTOMER_ORIGIN +
          '/clima-fontes.html'
      ) +
      (saved ? '\n\nCidade guardada para as próximas consultas.' : '')
    );
  }
  if (weatherReceipts.length) {
    if (saved)
      return formatAstraMessage(
        '📍 Cidade guardada',
        [
          {
            label: 'Cidade',
            value: [plain(saved.city), plain(saved.region)].filter(Boolean).join(', '),
          },
        ],
        'Ainda não consegui consultar a temperatura agora.'
      );
    return 'Não consegui consultar o tempo agora. Pode tentar de novo em instantes?';
  }
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
