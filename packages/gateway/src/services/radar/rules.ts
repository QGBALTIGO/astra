import {
  localClock,
  inQuietHours,
  thresholdMatches,
  sourceAvailable,
  footballKickoffConfigured,
  type RadarItem,
  type RadarSnapshot,
} from './contracts.js';
import type { RadarInterestRow, RadarDeliveryRow } from '../../db/repositories/customer-radar.js';
import { snapshotFingerprint } from './providers.js';

function scheduledFootballKickoff(
  item: RadarItem,
  snapshot: RadarSnapshot,
  now: Date
): string | null {
  if (
    !footballKickoffConfigured() ||
    !sourceAvailable('football') ||
    item.provider !== 'football-data' ||
    !item.providerMatchId ||
    !/^[A-Za-z0-9_:.-]{1,160}$/.test(item.providerMatchId) ||
    item.status !== 'scheduled' ||
    !item.at ||
    !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,3})?Z$/.test(item.at) ||
    !Number.isFinite(Date.parse(item.at)) ||
    Date.parse(item.at) <= now.getTime() ||
    now.getTime() - Date.parse(snapshot.observedAt) > 30 * 60000
  )
    return null;
  const at = new Date(item.at).toISOString();
  return at.slice(0, 19) === item.at.slice(0, 19) ? at : null;
}
export function freshSnapshot(s: RadarSnapshot | null, now: Date): s is RadarSnapshot {
  return (
    !!s &&
    Number.isFinite(Date.parse(s.observedAt)) &&
    Date.parse(s.observedAt) <= now.getTime() + 60000 &&
    Date.parse(s.expiresAt) > now.getTime()
  );
}
export function dailyWindow(
  now: Date,
  timeZone: string,
  time: string
): { day: string; eligible: boolean } {
  const clock = localClock(now, timeZone);
  const minutes = (s: string) => Number(s.slice(0, 2)) * 60 + Number(s.slice(3));
  const elapsed = minutes(clock.time) - minutes(time);
  return { day: clock.day, eligible: elapsed >= 0 && elapsed < 120 };
}
export function digestSection(
  interest: RadarInterestRow,
  now: Date,
  timeZone: string
): string | null {
  if (
    !sourceAvailable(interest.input.source) ||
    !interest.active ||
    interest.input.delivery !== 'digest' ||
    !freshSnapshot(interest.snapshot, now)
  )
    return null;
  const snap = interest.snapshot;
  const football = interest.input.source === 'football';
  if (
    ['releases', 'energy', 'news'].includes(interest.input.source) &&
    interest.last_content_key === snapshotFingerprint(snap)
  )
    return null;
  const formatter = new Intl.DateTimeFormat('pt-BR', {
    timeZone,
    dateStyle: 'short',
    timeStyle: 'short',
  });
  const lines = snap.items
    .slice(0, 3)
    .map((item) =>
      [
        '• ' + item.title,
        item.at ? '  ' + formatter.format(new Date(item.at)) : null,
        item.text
          ? '  ' +
            (interest.input.source === 'news'
              ? item.text.replace(' · Global Voices · CC BY 3.0', '')
              : item.text)
          : null,
        !football && interest.input.source !== 'news' && item.url ? '  ' + item.url : null,
      ]
        .filter(Boolean)
        .join('\n')
    );
  return (
    (football ? '⚽ ' : '') +
    '*' +
    interest.label +
    '*\n\n' +
    (lines.length
      ? lines.join(football ? '\n\n' : '\n')
      : 'Nenhuma publicação encontrada no período consultado.') +
    (football
      ? ''
      : interest.input.source === 'news'
        ? '\nGlobal Voices · CC BY 3.0'
        : '\nFonte: ' + snap.sourceLabel + ' · ' + snap.sourceUrl)
  );
}
export function digestText(
  interests: RadarInterestRow[],
  now: Date,
  timeZone: string
): string | null {
  const sections = interests
    .map((i) => digestSection(i, now, timeZone))
    .filter((x): x is string => !!x);
  if (!sections.length) return null;
  let text = '📡 *Seu Radar Astra*';
  let shown = 0;
  for (const section of sections) {
    if (text.length + section.length > 3300) break;
    text += '\n\n' + section;
    shown++;
  }
  if (!shown) return null;
  if (shown < sections.length) text += '\n\nMais acompanhamentos estão no seu painel.';
  return text + '\n\nQuer mudar algo? É só me pedir por aqui. Seu Radar também está no painel.';
}
export function interestDecisions(
  interest: RadarInterestRow,
  now: Date,
  timeZone: string
): Array<{
  key: string;
  payload: RadarDeliveryRow['payload'];
  expiresAt: Date;
}> {
  const s = interest.snapshot;
  if (!interest.active || !freshSnapshot(s, now)) return [];
  if (interest.input.delivery === 'matchday') {
    if (interest.input.source !== 'football' || !interest.input.notifyTime) return [];
    const window = dailyWindow(now, timeZone, interest.input.notifyTime);
    if (!window.eligible) return [];
    const clock = localClock(now, timeZone);
    const minutes = (time: string) => Number(time.slice(0, 2)) * 60 + Number(time.slice(3));
    const currentMinute = minutes(clock.time);
    const remainingMinutes = Math.min(
      120 - (currentMinute - minutes(interest.input.notifyTime)),
      1440 - currentMinute
    );
    const windowEnd =
      now.getTime() +
      remainingMinutes * 60000 -
      now.getUTCSeconds() * 1000 -
      now.getUTCMilliseconds();
    return s.items
      .filter(
        (item) =>
          item.date === window.day &&
          !['live', 'finished', 'cancelled', 'unknown'].includes(item.status ?? '') &&
          (!item.at || Date.parse(item.at) > now.getTime())
      )
      .map((item) => ({
        key: interest.id + ':matchday:' + item.id + ':' + item.date,
        payload: {
          title: item.title,
          text: 'Data: ' + item.date!.split('-').reverse().join('/') + ' · horário a confirmar.',
          source: s.sourceLabel,
          url: '',
          itemId: item.id,
          matchDate: item.date,
        },
        expiresAt: new Date(windowEnd),
      }));
  }
  if (interest.input.delivery === 'threshold') {
    const item = s.items.find((i) => i.value);
    if (
      !item?.value ||
      !interest.input.threshold ||
      !interest.input.comparison ||
      interest.threshold_state === true
    )
      return [];
    if (!thresholdMatches(item.value, interest.input.threshold, interest.input.comparison))
      return [];
    return [
      {
        key: interest.id + ':threshold:' + item.id + ':' + item.value,
        payload: {
          title: item.title,
          text: item.text ?? '',
          source: s.sourceLabel,
          url: s.sourceUrl,
          itemId: item.id,
        },
        expiresAt: new Date(Math.min(now.getTime() + 2 * 3600000, Date.parse(s.expiresAt))),
      },
    ];
  }
  if (interest.input.delivery === 'before') {
    const football = interest.input.source === 'football';
    const formatter = new Intl.DateTimeFormat('pt-BR', {
      timeZone,
      dateStyle: 'short',
      timeStyle: 'short',
    });
    return s.items
      .filter(
        (i) =>
          (!football || scheduledFootballKickoff(i, s, now)) &&
          i.at &&
          Date.parse(i.at) > now.getTime() &&
          Date.parse(i.at) - now.getTime() <= interest.input.leadMinutes * 60000
      )
      .map((i) => ({
        key: football
          ? interest.id +
            ':before:football-data:' +
            i.providerMatchId +
            ':' +
            new Date(i.at!).toISOString() +
            ':' +
            interest.input.leadMinutes
          : interest.id + ':before:' + i.id + ':' + i.at,
        payload: {
          title: i.title,
          text: 'Horário informado: ' + formatter.format(new Date(i.at!)) + '.',
          source: s.sourceLabel,
          url: s.sourceUrl,
          itemId: i.id,
          at: football ? new Date(i.at!).toISOString() : i.at,
          ...(football && { provider: i.provider, providerMatchId: i.providerMatchId }),
        },
        expiresAt: new Date(i.at!),
      }));
  }
  return [];
}
export function stillMatchesDelivery(
  interest: RadarInterestRow,
  row: RadarDeliveryRow,
  now: Date,
  timeZone = 'UTC'
): boolean {
  if (
    !interest.active ||
    interest.revision !== row.interest_revision ||
    !freshSnapshot(interest.snapshot, now)
  )
    return false;
  const item = interest.snapshot.items.find((i) => i.id === row.payload.itemId);
  if (!item) return false;
  if (interest.input.delivery === 'matchday') {
    if (
      interest.input.source !== 'football' ||
      !interest.input.notifyTime ||
      !item.date ||
      item.date !== row.payload.matchDate ||
      ['live', 'finished', 'cancelled', 'unknown'].includes(item.status ?? '') ||
      (item.at && !(Date.parse(item.at) > now.getTime())) ||
      !(new Date(row.expires_at).getTime() > now.getTime())
    )
      return false;
    const window = dailyWindow(now, timeZone, interest.input.notifyTime);
    return window.eligible && window.day === item.date;
  }
  if (interest.input.delivery === 'before') {
    if (interest.input.source === 'football') {
      const at = scheduledFootballKickoff(item, interest.snapshot, now);
      return (
        !!at &&
        at === row.payload.at &&
        row.payload.provider === item.provider &&
        row.payload.providerMatchId === item.providerMatchId &&
        new Date(row.expires_at).getTime() > now.getTime()
      );
    }
    return item.at === row.payload.at && !!item.at && Date.parse(item.at) > now.getTime();
  }
  return (
    interest.input.delivery === 'threshold' &&
    !!item.value &&
    !!interest.input.threshold &&
    !!interest.input.comparison &&
    thresholdMatches(item.value, interest.input.threshold, interest.input.comparison)
  );
}
export { localClock, inQuietHours };
