import {
  decodeSyncdSnapshot,
  decodePatches,
  extractSyncdPatches,
  type WASocket,
  type WAPatchName,
} from '@whiskeysockets/baileys';
import {
  discoverWhatsAppHistoryContacts,
  type WhatsAppHistoryContactInput,
  type WhatsAppContactObservation,
} from '../../whatsapp-contact-discovery.js';

/** Read the encrypted server directory with the already-linked session.
 * Never call keys.set, resyncAppState or processSyncAction: this lookup must not
 * alter the running client's authentication, synchronization cursors or chats.
 */
export async function readWhatsAppServerContacts(
  socket: WASocket,
  current: () => boolean,
  resolve: (key: {
    remoteJid?: string | null;
    remoteJidAlt?: string | null;
  }) => Promise<string | null>,
  isSelf: (jid: string) => boolean
): Promise<WhatsAppContactObservation[]> {
  const collections: WAPatchName[] = [
    'critical_unblock_low',
    'critical_block',
    'regular_low',
    'regular_high',
    'regular',
  ];
  if (!current()) return [];
  const response = await socket.query(
    {
      tag: 'iq',
      attrs: { to: 's.whatsapp.net', xmlns: 'w:sync:app:state', type: 'set' },
      content: [
        {
          tag: 'sync',
          attrs: {},
          content: collections.map((name) => ({
            tag: 'collection',
            attrs: { name, version: '0', return_snapshot: 'true' },
          })),
        },
      ],
    },
    8_000
  );
  if (!current()) return [];
  const requestOptions = { signal: AbortSignal.timeout(8_000) };
  const decoded = await extractSyncdPatches(response, requestOptions);
  const chats: NonNullable<WhatsAppHistoryContactInput['chats']>[number][] = [];
  const contacts: NonNullable<WhatsAppHistoryContactInput['contacts']>[number][] = [];
  const messages: WhatsAppHistoryContactInput['messages'][number][] = [];
  const seen = Math.floor(Date.now() / 1000);
  const getKey = async (id: string) => {
    if (!current()) throw new Error('WhatsApp connection changed');
    const keys = await socket.authState.keys.get('app-state-sync-key', [id]);
    return keys[id];
  };
  for (const collection of collections) {
    if (!current()) return [];
    const snapshot = decoded[collection]?.snapshot;
    if (!snapshot) continue;
    // Enforce the SDK's MAC verification. Keys and decrypted records stay local.
    const { mutationMap, state } = await decodeSyncdSnapshot(
      collection,
      snapshot,
      getKey,
      undefined,
      true
    );
    const patches = decoded[collection]?.patches ?? [];
    const updates = patches.length
      ? (
          await decodePatches(
            collection,
            patches,
            state,
            getKey,
            requestOptions,
            undefined,
            undefined,
            true
          )
        ).mutationMap
      : {};
    for (const mutation of Object.values({ ...mutationMap, ...updates })) {
      if (mutation.index.some((value) => /@(?:g\.us|broadcast|newsletter)$/.test(value))) continue;
      const jid = mutation.index.find((value) => /@(?:s\.whatsapp\.net|lid)$/.test(value));
      if (!jid) continue;
      const contact = mutation.syncAction.value?.contactAction;
      const action = mutation.syncAction.value;
      // The authenticated read/archive range can carry actual incoming-message
      // keys even when full history has not arrived. A timestamp alone cannot
      // prove that the customer sent a message.
      for (const range of [
        action?.markChatAsReadAction?.messageRange,
        action?.archiveChatAction?.messageRange,
      ]) {
        for (const message of range?.messages ?? []) {
          if (
            message.key?.fromMe !== false ||
            (message.key.remoteJid && message.key.remoteJid !== jid)
          )
            continue;
          const seconds = Number(message.timestamp);
          if (!Number.isFinite(seconds) || seconds <= 0 || seconds * 1000 > Date.now()) continue;
          messages.push({ key: { remoteJid: jid, fromMe: false }, messageTimestamp: seconds });
        }
      }
      const name = contact?.fullName || contact?.firstName || undefined;
      chats.push({ id: jid, name, conversationTimestamp: seen });
      if (contact)
        contacts.push({
          id: jid,
          name,
          lid: contact.lidJid ?? undefined,
          phoneNumber: contact.pnJid ?? undefined,
        });
    }
  }
  const rows = await discoverWhatsAppHistoryContacts(
    { chats, contacts, messages: [] },
    resolve,
    (value) => (typeof value === 'number' ? new Date(value * 1000) : null),
    isSelf,
    current
  );
  const confirmed = new Map(
    (
      await discoverWhatsAppHistoryContacts(
        { contacts, messages },
        resolve,
        (value) => (typeof value === 'number' ? new Date(value * 1000) : null),
        isSelf,
        current
      )
    ).map((row) => [row.phone, row])
  );
  if (!current()) return [];
  return rows.map((row) => {
    const evidence = confirmed.get(row.phone);
    return evidence ? { ...row, seenAt: evidence.seenAt, interactionConfirmed: true } : row;
  });
}
