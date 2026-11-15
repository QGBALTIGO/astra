import { readdir } from 'node:fs/promises';
import type { WASocket } from '@whiskeysockets/baileys';
import type { WhatsAppContactObservation } from '../../whatsapp-contact-discovery.js';

/** Recover phone metadata already verified by the linked SDK. Read only its
 * bidirectional LID/phone map, never credentials, Signal keys or message bodies.
 * A mapping proves an association, not a past private conversation.
 */
export async function readWhatsAppLinkedPhones(
  socket: WASocket,
  sessionDirectory: string,
  current: () => boolean,
  isSelf: (jid: string) => boolean
): Promise<WhatsAppContactObservation[]> {
  if (!current()) return [];
  const files = await readdir(sessionDirectory, { withFileTypes: true });
  const keys = files
    .filter((file) => file.isFile())
    .map((file) => /^lid-mapping-(\d{1,20})_reverse\.json$/.exec(file.name)?.[1])
    .filter((lid): lid is string => Boolean(lid))
    .sort()
    .slice(0, 10_000);
  const result = new Map<string, WhatsAppContactObservation>();
  for (let offset = 0; offset < keys.length; offset += 250) {
    if (!current()) return [];
    const lids = keys.slice(offset, offset + 250);
    const reverse = await socket.authState.keys.get(
      'lid-mapping',
      lids.map((lid) => lid + '_reverse')
    );
    const pairs = lids.flatMap((lid) => {
      const phone = reverse[lid + '_reverse'];
      return typeof phone === 'string' &&
        /^\d{10,15}$/.test(phone) &&
        !isSelf(phone + '@s.whatsapp.net')
        ? [{ lid, phone }]
        : [];
    });
    if (!pairs.length) continue;
    const forward = await socket.authState.keys.get('lid-mapping', [
      ...new Set(pairs.map((pair) => pair.phone)),
    ]);
    if (!current()) return [];
    for (const { lid, phone } of pairs) {
      // A reverse-only record, conflicting association or LID-shaped input is
      // never enough to invent a phone identity in the authorization directory.
      if (forward[phone] !== lid) continue;
      result.set(phone, { phone, seenAt: new Date() });
    }
  }
  return current() ? [...result.values()] : [];
}
