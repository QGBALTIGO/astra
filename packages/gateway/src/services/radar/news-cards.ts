import type { RadarItem } from './contracts.js';
import { renderUrlButtonAsText } from '../../channels/utils/url-button.js';

export interface RadarNewsCard {
  text: string;
  urlButton: { label: 'Ler matéria'; url: string };
}
const plain = (text: string) =>
  text
    .replace(/https?:\/\/\S+/giu, '')
    .replace(/[\r\n*_`<>\p{Cc}\p{Cf}]/gu, ' ')
    .replace(/\s+/gu, ' ')
    .trim();
export function isRadarNewsCard(card: unknown): card is RadarNewsCard {
  if (!card || typeof card !== 'object') return false;
  const c = card as RadarNewsCard;
  if (
    typeof c.text !== 'string' ||
    !c.text.trim() ||
    c.text.length > 500 ||
    /https?:|www\./iu.test(c.text) ||
    c.urlButton?.label !== 'Ler matéria' ||
    typeof c.urlButton.url !== 'string' ||
    c.urlButton.url.length > 600
  )
    return false;
  try {
    const u = new URL(c.urlButton.url);
    return (
      u.protocol === 'https:' &&
      u.hostname === 'pt.globalvoices.org' &&
      u.href.length <= 600 &&
      renderUrlButtonAsText({
        text: c.text,
        urlButton: { label: c.urlButton.label, url: u.href },
      }).length <= 1024 &&
      !u.port &&
      !u.username &&
      !u.password &&
      !/[\p{Cc}\p{Cf}]/u.test(c.urlButton.url)
    );
  } catch {
    return false;
  }
}
export function newsCards(items: readonly RadarItem[], subject: string): RadarNewsCard[] {
  const seen = new Set<string>();
  const selected = items
    .filter((i) => {
      if (!i.url || seen.has(i.url)) return false;
      seen.add(i.url);
      return true;
    })
    .slice(0, 3);
  return selected.flatMap((item, index) => {
    const title = plain(item.title);
    if (!title) return [];
    const date = /Publicado em (\d{2}\/\d{2}\/\d{4})/u.exec(item.text ?? '')?.[1];
    const card: RadarNewsCard = {
      text: `📰 *${plain(subject).slice(0, 65)} · ${index + 1}/${selected.length}*\n\n*${title.length > 220 ? title.slice(0, 217) + '…' : title}*\n\n${date ? '📅 Publicado em ' + date + '\n\n' : ''}Global Voices · CC BY 3.0`,
      urlButton: { label: 'Ler matéria', url: item.url! },
    };
    return isRadarNewsCard(card) ? [card] : [];
  });
}
