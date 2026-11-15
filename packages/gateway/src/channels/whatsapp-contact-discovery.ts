/** Contact inventory only. Historical messages never enter the command/AI pipeline. */
export interface WhatsAppContactObservation {
  phone: string;
  name?: string;
  seenAt: Date;
  /** Explicit private incoming-message evidence, never just an address-book lookup. */
  interactionConfirmed?: boolean;
}
export interface WhatsAppHistoryContactInput {
  chats?: ReadonlyArray<{
    id?: string | null;
    name?: string | null;
    conversationTimestamp?: unknown;
  }>;
  contacts?: ReadonlyArray<{
    id?: string | null;
    lid?: string;
    phoneNumber?: string;
    name?: string | null;
    notify?: string | null;
    verifiedName?: string | null;
  }>;
  messages: ReadonlyArray<{
    key: { remoteJid?: string | null; remoteJidAlt?: string | null; fromMe?: boolean | null };
    pushName?: string | null;
    messageTimestamp?: unknown;
  }>;
}

export async function discoverWhatsAppHistoryContacts(
  input: WhatsAppHistoryContactInput,
  resolve: (key: {
    remoteJid?: string | null;
    remoteJidAlt?: string | null;
  }) => Promise<string | null>,
  timestamp: (value: unknown) => Date | null,
  isSelf: (jid: string) => boolean,
  current: () => boolean
): Promise<WhatsAppContactObservation[]> {
  const names = new Map<string, string>();
  const phoneByLid = new Map<string, string>();
  const ambiguous = new Set<string>();
  for (const c of input.contacts ?? []) {
    const name = c.name || c.notify || c.verifiedName;
    if (c.id && name) names.set(c.id, name);
    const lid = c.lid ?? (c.id?.endsWith('@lid') ? c.id : undefined);
    const phone = c.phoneNumber ?? (c.id?.endsWith('@s.whatsapp.net') ? c.id : undefined);
    if (lid?.endsWith('@lid') && phone && /^[1-9]\d{9,14}(?::\d+)?@s\.whatsapp\.net$/.test(phone)) {
      if (phoneByLid.has(lid) && phoneByLid.get(lid) !== phone) ambiguous.add(lid);
      phoneByLid.set(lid, phone);
      if (name) {
        names.set(lid, name);
        names.set(phone, name);
      }
    }
  }
  const candidates = new Map<
    string,
    { key: { remoteJid: string; remoteJidAlt?: string | null }; name?: string; seenAt: Date }
  >();
  const add = (
    jid: string | null | undefined,
    at: unknown,
    name?: string | null,
    alt?: string | null
  ) => {
    if (!jid || !/@(?:s\.whatsapp\.net|lid)$/.test(jid)) return;
    const seenAt = timestamp(at);
    if (!seenAt || !Number.isFinite(seenAt.getTime())) return;
    const previous = candidates.get(jid);
    if (!previous || previous.seenAt < seenAt)
      candidates.set(jid, {
        key: {
          remoteJid: jid,
          remoteJidAlt: alt ?? (ambiguous.has(jid) ? undefined : phoneByLid.get(jid)),
        },
        name: name || names.get(jid),
        seenAt,
      });
  };
  for (const chat of input.chats ?? []) add(chat.id, chat.conversationTimestamp, chat.name);
  for (const msg of input.messages)
    if (!msg.key.fromMe)
      add(msg.key.remoteJid, msg.messageTimestamp, msg.pushName, msg.key.remoteJidAlt);
  const pending = [...candidates.values()];
  const observed = new Map<string, WhatsAppContactObservation>();
  let index = 0;
  await Promise.all(
    Array.from({ length: Math.min(8, pending.length) }, async () => {
      while (index < pending.length && current()) {
        const item = pending[index++]!;
        const jid = await resolve(item.key);
        if (!current()) return;
        if (!jid || isSelf(jid)) continue;
        const match = /^([1-9]\d{9,14})(?::\d+)?@s\.whatsapp\.net$/.exec(jid);
        if (!match) continue; // A LID is never a phone number.
        const phone = match[1]!;
        const previous = observed.get(phone);
        if (!previous || previous.seenAt < item.seenAt)
          observed.set(phone, { phone, name: item.name, seenAt: item.seenAt });
      }
    })
  );
  return current() ? [...observed.values()] : [];
}
