import type { ChannelToolReceipt } from './response-safety.js';
import { formatAstraMessage } from './response-presentation.js';
import { integrationItems } from '../services/customer-integration-data.js';
import { requiredChannelWeatherTool } from './tool-selection.js';
import { channelOperations } from './receipt-state.js';

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

const object = (value: unknown): Record<string, unknown> | null =>
  value !== null && typeof value === 'object' && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
const count = (value: unknown): value is number =>
  typeof value === 'number' && Number.isSafeInteger(value) && value >= 0;
const amount = (value: unknown): value is number =>
  typeof value === 'number' && Number.isFinite(value) && Math.abs(value) <= 9_007_199_254_740;
const currency = (value: unknown): value is string =>
  typeof value === 'string' && /^[A-Z]{3}$/u.test(value);
function money(value: number, code: string): string {
  return new Intl.NumberFormat('pt-BR', { style: 'currency', currency: code }).format(value);
}
function day(value: unknown): string | null {
  if (typeof value !== 'string' || !/^\d{4}-\d{2}-\d{2}$/u.test(value)) return null;
  const parsed = new Date(value + 'T00:00:00Z');
  return Number.isFinite(parsed.getTime()) && parsed.toISOString().slice(0, 10) === value
    ? value.split('-').reverse().join('/')
    : null;
}
function readPayload(receipt: ChannelToolReceipt): unknown {
  if (receipt.isError) return null;
  try {
    let value: unknown = JSON.parse(receipt.content);
    for (let depth = 0; depth < 4; depth++) {
      const entry = object(value);
      if (!entry) return Array.isArray(value) ? value : null;
      if (entry.success === false || entry.isError === true || entry.error) return null;
      if (!Object.hasOwn(entry, 'result')) return entry;
      // A financial summary's result is its numeric balance, not an adapter envelope.
      if (entry.result === null || typeof entry.result !== 'object')
        return entry.success === undefined ? entry : null;
      value = entry.result;
    }
  } catch {
    // A malformed or failed receipt is never evidence of an empty account.
  }
  return null;
}
const label = (value: unknown) =>
  plain(value)
    .replace(/\b[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}\b/giu, '')
    .trim()
    .slice(0, 160);

function financialRead(name: string, payload: unknown): string | undefined {
  const data = object(payload);
  if (!data) return;
  if (name === 'financial_summary') {
    const period = object(data.period);
    const from = day(period?.from),
      to = day(period?.to);
    const keys = ['income', 'expenses', 'result', 'pendingIncome', 'pendingExpenses'] as const;
    if (
      !from ||
      !to ||
      !currency(data.currency) ||
      keys.some((key) => !amount(data[key])) ||
      keys.some((key) => key !== 'result' && (data[key] as number) < 0)
    )
      return;
    return formatAstraMessage('📊 Resumo financeiro', [
      { label: 'Período', value: `${from} a ${to}` },
      { label: 'Entradas recebidas', value: money(data.income as number, data.currency) },
      { label: 'Despesas pagas', value: money(data.expenses as number, data.currency) },
      { label: 'Resultado realizado', value: money(data.result as number, data.currency) },
      { label: 'A receber', value: money(data.pendingIncome as number, data.currency) },
      { label: 'A pagar', value: money(data.pendingExpenses as number, data.currency) },
    ]);
  }
  if (
    !Array.isArray(data.transactions) ||
    !count(data.total) ||
    !count(data.page) ||
    data.page < 1 ||
    !count(data.pageSize) ||
    data.pageSize < 1 ||
    data.transactions.length > data.pageSize ||
    data.total < data.transactions.length
  )
    return;
  const rows = data.transactions.map(object);
  if (
    rows.some(
      (row) =>
        !row ||
        !label(row.description) ||
        !amount(row.amount) ||
        row.amount < 0 ||
        !currency(row.currency) ||
        !['income', 'expense'].includes(String(row.type)) ||
        !['pending', 'settled'].includes(String(row.status)) ||
        (row.date !== undefined && !day(row.date))
    )
  )
    return;
  if (!rows.length)
    return formatAstraMessage(
      '🔎 Lançamentos',
      [],
      data.total === 0
        ? 'Nenhum lançamento encontrado nesta consulta.'
        : 'Nenhum lançamento nesta página.'
    );
  const lines = rows.slice(0, 5).map((row) => {
    const entry = row!;
    const kind =
      entry.type === 'income'
        ? entry.status === 'pending'
          ? 'A receber'
          : 'Recebido'
        : entry.status === 'pending'
          ? 'A pagar'
          : 'Pago';
    return formatAstraMessage('🔎 ' + label(entry.description), [
      { label: kind, value: money(entry.amount as number, entry.currency as string) },
      ...(entry.date ? [{ label: 'Data', value: day(entry.date)! }] : []),
    ]);
  });
  return (
    lines.join('\n\n') +
    `\n\nExibindo ${lines.length} de ${data.total} lançamentos encontrados · página ${data.page}.` +
    '\nOs valores da lista não representam um saldo total.'
  );
}

function reminderRead(payload: unknown, timeZone?: string): string | undefined {
  const data = object(payload);
  const entries = Array.isArray(payload) ? payload : data?.items;
  if (!Array.isArray(entries)) return;
  if (
    data &&
    (!count(data.total) ||
      !count(data.page) ||
      data.page < 1 ||
      !count(data.pageSize) ||
      data.pageSize < 1 ||
      data.total < entries.length ||
      entries.length > data.pageSize ||
      typeof data.hasMore !== 'boolean')
  )
    return;
  const statuses: Record<string, string> = {
    pending: 'Pendente',
    delivered: 'Enviado',
    failed: 'Não enviado',
    cancelled: 'Cancelado',
    sending: 'Em envio',
  };
  const items: string[] = [];
  for (const raw of entries) {
    const item = object(raw);
    if (
      !item ||
      !label(item.title) ||
      !statuses[String(item.status)] ||
      typeof item.quando !== 'string' ||
      !/(?:Z|[+-]\d{2}:\d{2})$/u.test(item.quando)
    )
      return;
    const at = new Date(item.quando);
    if (!Number.isFinite(at.getTime())) return;
    let local: string;
    try {
      const zone = timeZone ?? (typeof item.timeZone === 'string' ? item.timeZone : undefined);
      if (!zone) return;
      local = new Intl.DateTimeFormat('pt-BR', {
        timeZone: zone,
        dateStyle: 'short',
        timeStyle: 'short',
      }).format(at);
    } catch {
      return;
    }
    if (items.length < 5)
      items.push(
        formatAstraMessage('🔔 ' + label(item.title), [
          { label: 'Quando', value: local },
          { label: 'Situação', value: statuses[String(item.status)]! },
        ])
      );
  }
  if (!entries.length)
    return formatAstraMessage(
      '🔔 Seus lembretes',
      [],
      !data || data.total === 0
        ? 'Nenhum lembrete encontrado nesta consulta.'
        : 'Nenhum lembrete nesta página.'
    );
  const total = data?.total ?? entries.length;
  return items.join('\n\n') + `\n\nExibindo ${items.length} de ${total} lembretes desta consulta.`;
}

/** Recover only the current turn's whitelisted reads; never retry a tool or total a page. */
export function verifiedReadChannelFacts(
  receipts: ChannelToolReceipt[],
  context: { timeZone?: string; requestText?: string } = {}
): string | undefined {
  const operations = channelOperations(receipts);
  const name = (receipt: ChannelToolReceipt) =>
    receipt.name.replace(/__/g, '.').replace(/^core\./, '');
  const allowed = new Set(['financial_summary', 'list_transactions', 'list_channel_reminders']);
  if (!operations.length || operations.some((receipt) => !allowed.has(name(receipt)))) return;
  // A failed final read must not be disguised using a prior result from the same tool.
  const latest = new Map(operations.map((receipt) => [name(receipt), receipt]));
  const replies: string[] = [];
  for (const [tool, receipt] of latest) {
    const payload = readPayload(receipt);
    const reply =
      tool === 'list_channel_reminders'
        ? reminderRead(payload, context.timeZone)
        : financialRead(tool, payload);
    if (reply) replies.push(reply);
  }
  if (!replies.length) return;
  if (replies.length < latest.size)
    replies.push('Uma parte da consulta não ficou disponível agora.');
  return replies.join('\n\n');
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
