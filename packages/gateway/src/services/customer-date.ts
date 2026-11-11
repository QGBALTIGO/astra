/** Calendar days are interpreted in the customer's IANA zone, never the server/browser zone. */
export function validCalendarDay(value: string): boolean {
  return (
    /^\d{4}-\d{2}-\d{2}$/.test(value) &&
    Number.isFinite(Date.parse(`${value}T00:00:00Z`)) &&
    new Date(`${value}T00:00:00Z`).toISOString().slice(0, 10) === value
  );
}

export function customerLocalDay(value: Date | string, timeZone: string): string {
  const parts = new Intl.DateTimeFormat('en-CA', {
    timeZone,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  }).formatToParts(new Date(value));
  const part = (name: string) => parts.find((p) => p.type === name)!.value;
  return `${part('year')}-${part('month')}-${part('day')}`;
}

export function addCalendarDays(day: string, days: number): string {
  return new Date(Date.parse(`${day}T12:00:00Z`) + days * 86_400_000).toISOString().slice(0, 10);
}

/** Refresh the direct-agent fallback clock without accumulating old sections. */
export function withCustomerClock(prompt: string, timeZone: string, now = new Date()): string {
  const marker = '\n\n---\n\n## Astra customer clock';
  const base = prompt.replace(/\n\n---\n\n## Astra customer clock[\s\S]*?(?=\n\n---\n\n|$)/g, '');
  const local = new Intl.DateTimeFormat('pt-BR', {
    timeZone,
    dateStyle: 'full',
    timeStyle: 'short',
  }).format(now);
  return `${base}${marker}\nHorário atual do cliente: ${local}. Fuso IANA: ${timeZone}. Instante UTC: ${now.toISOString()}.\nUse este horário para hoje, amanhã, compromissos e lembretes. Salve instantes como ISO 8601 com o offset correto. O painel e o WhatsApp usam os mesmos registros.`;
}

/** Convert a local midnight into an instant; offset is recalculated across DST boundaries. */
export function customerDayStart(day: string, timeZone: string): Date {
  if (!validCalendarDay(day)) throw new Error('Dia inválido.');
  const wall = Date.parse(`${day}T00:00:00Z`);
  let instant = wall;
  const formatter = new Intl.DateTimeFormat('en-CA', {
    timeZone,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
    hourCycle: 'h23',
  });
  for (let i = 0; i < 4; i++) {
    const parts = formatter.formatToParts(new Date(instant));
    const part = (name: string) => parts.find((p) => p.type === name)!.value;
    const local = Date.parse(
      `${part('year')}-${part('month')}-${part('day')}T${part('hour')}:${part('minute')}:${part('second')}Z`
    );
    const next = instant + wall - local;
    if (next === instant) break;
    instant = next;
  }
  // On the rare dates where midnight does not exist, the first instant of
  // that civil day is the boundary. Search the bounded neighboring window.
  if (customerLocalDay(new Date(instant), timeZone) !== day) {
    let low = wall - 36 * 3_600_000;
    let high = wall + 36 * 3_600_000;
    while (high - low > 1) {
      const mid = Math.floor((low + high) / 2);
      if (customerLocalDay(new Date(mid), timeZone) < day) low = mid;
      else high = mid;
    }
    instant = high;
  }
  return new Date(instant);
}

/** Resolve a wall-clock time in an IANA zone, rejecting missing/repeated DST hours. */
export function customerLocalDateTime(value: string, timeZone: string): Date {
  if (
    !/^\d{4}-\d{2}-\d{2}T(?:[01]\d|2[0-3]):[0-5]\d(?::[0-5]\d)?$/.test(value) ||
    !validCalendarDay(value.slice(0, 10))
  ) {
    throw new Error('Data e hora local inválidas. Use YYYY-MM-DDTHH:mm.');
  }
  const wallText = value.length === 16 ? `${value}:00` : value;
  const wall = Date.parse(`${wallText}Z`);
  const formatter = new Intl.DateTimeFormat('en-CA', {
    timeZone,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
    hourCycle: 'h23',
  });
  const localText = (date: Date) => {
    const parts = formatter.formatToParts(date);
    const part = (name: string) => parts.find((p) => p.type === name)!.value;
    return `${part('year')}-${part('month')}-${part('day')}T${part('hour')}:${part('minute')}:${part('second')}`;
  };
  const candidates = new Set<number>();
  for (const delta of [-36, -12, 0, 12, 36]) {
    const sample = wall + delta * 3_600_000;
    const offset = Date.parse(`${localText(new Date(sample))}Z`) - sample;
    const candidate = wall - offset;
    if (localText(new Date(candidate)) === wallText) candidates.add(candidate);
  }
  if (candidates.size !== 1)
    throw new Error('Horário inexistente ou ambíguo neste fuso. Confirme o horário e o offset.');
  return new Date([...candidates][0]!);
}
