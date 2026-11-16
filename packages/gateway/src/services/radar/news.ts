import { cleanText, publicLink, type RadarItem } from './contracts.js';

export function newsQueryUrl(topic: string, now: Date): string {
  const url = new URL('https://pt.globalvoices.org/wp-json/wp/v2/posts');
  url.searchParams.set('per_page', '20');
  url.searchParams.set('_fields', 'id,date_gmt,title,link');
  url.searchParams.set(
    'after',
    new Date(now.getTime() - 30 * 86400000).toISOString().slice(0, 10) + 'T00:00:00'
  );
  if (!/^(?:notícias|noticias|geral|mundo|últimas|ultimas)$/iu.test(topic.trim()))
    url.searchParams.set('search', topic.normalize('NFC').trim().toLocaleLowerCase('pt-BR'));
  return url.href;
}
function titleText(value: string): string {
  return cleanText(
    value.replace(
      /&#(x[0-9a-f]+|\d+);|&(amp|quot|apos|lt|gt|nbsp);/gi,
      (raw, code: string | undefined, named: string | undefined) => {
        if (code) {
          const n = code.startsWith('x') ? parseInt(code.slice(1), 16) : Number(code);
          return n > 0 && n <= 0x10ffff && !(n >= 0xd800 && n <= 0xdfff)
            ? String.fromCodePoint(n)
            : '';
        }
        return (
          (
            { amp: '&', quot: '"', apos: "'", lt: '<', gt: '>', nbsp: ' ' } as Record<
              string,
              string
            >
          )[named?.toLowerCase() ?? ''] ?? raw
        );
      }
    ),
    220
  );
}
/** Only a publisher's licensed title, date and original link; never article HTML or images. */
export function globalVoicesItems(value: unknown, now: Date): RadarItem[] {
  if (!Array.isArray(value)) throw new Error('Resposta de notícias inválida.');
  const seen = new Set<string>();
  return value.slice(0, 20).flatMap((raw: unknown) => {
    if (!raw || typeof raw !== 'object') return [];
    const r = raw as Record<string, unknown>;
    const title =
      r.title && typeof r.title === 'object'
        ? titleText(String((r.title as Record<string, unknown>).rendered ?? ''))
        : '';
    const link = publicLink(r.link);
    const parsed = link ? new URL(link) : null;
    if (parsed) {
      parsed.hash = '';
      for (const key of [...parsed.searchParams.keys()])
        if (/^utm_|^(?:fbclid|gclid)$/i.test(key)) parsed.searchParams.delete(key);
      parsed.searchParams.sort();
    }
    const url = parsed?.href;
    const stamp =
      typeof r.date_gmt === 'string' && /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}$/.test(r.date_gmt)
        ? Date.parse(r.date_gmt + 'Z')
        : NaN;
    if (
      !url ||
      new URL(url).hostname !== 'pt.globalvoices.org' ||
      !title ||
      seen.has(url) ||
      !Number.isFinite(stamp) ||
      stamp > now.getTime() + 60000 ||
      now.getTime() - stamp > 30 * 86400000
    )
      return [];
    seen.add(url);
    return [
      {
        id: url,
        title,
        url,
        text:
          'Publicado em ' +
          new Intl.DateTimeFormat('pt-BR', {
            timeZone: 'America/Sao_Paulo',
            dateStyle: 'short',
          }).format(new Date(stamp)) +
          ' · Global Voices · CC BY 3.0',
      },
    ];
  });
}
