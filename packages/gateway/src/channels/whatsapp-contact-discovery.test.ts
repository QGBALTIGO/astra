import { describe, expect, it, vi } from 'vitest';
import { discoverWhatsAppHistoryContacts } from './whatsapp-contact-discovery.js';
const stamp = (value: unknown) =>
  typeof value === 'number' && value > 0 ? new Date(value * 1000) : null;
const self = (jid: string) => jid === '5511999990000@s.whatsapp.net';
const current = () => true;
const time = 1794690000;
describe('WhatsApp historical contact inventory', () => {
  it('uses authenticated contact phone/LID pairs and rejects conflicting phone pairs', async () => {
    const resolve = vi.fn(async (key) => key.remoteJidAlt ?? key.remoteJid ?? null);
    const rows = await discoverWhatsAppHistoryContacts(
      {
        messages: [],
        chats: [
          { id: '900000000001@lid', conversationTimestamp: time },
          { id: '900000000002@lid', conversationTimestamp: time },
        ],
        contacts: [
          {
            id: '900000000001@lid',
            phoneNumber: '244927000001@s.whatsapp.net',
            name: 'Contato Angola',
          },
          { id: '900000000002@lid', phoneNumber: '5581999990101@s.whatsapp.net' },
          { id: '900000000002@lid', phoneNumber: '5581999990102@s.whatsapp.net' },
        ],
      },
      resolve,
      stamp,
      self,
      current
    );
    expect(rows).toEqual([
      { phone: '244927000001', name: 'Contato Angola', seenAt: new Date(time * 1000) },
    ]);
    expect(resolve).toHaveBeenCalledWith({
      remoteJid: '900000000002@lid',
      remoteJidAlt: undefined,
    });
  });
  it('discovers Brazilian and foreign chats without needing a message body or authorizing them', async () => {
    const input = {
      chats: [
        { id: '244927000001@s.whatsapp.net', conversationTimestamp: time },
        { id: '5581999990101@s.whatsapp.net', conversationTimestamp: time },
      ],
      contacts: [{ id: '244927000001@s.whatsapp.net', name: 'Contato Angola' }],
      messages: [],
    };
    const rows = await discoverWhatsAppHistoryContacts(
      input,
      async (k) => k.remoteJid ?? null,
      stamp,
      self,
      current
    );
    expect(rows).toEqual(
      expect.arrayContaining([
        { phone: '244927000001', name: 'Contato Angola', seenAt: new Date(time * 1000) },
        { phone: '5581999990101', name: undefined, seenAt: new Date(time * 1000) },
      ])
    );
    expect(JSON.stringify(rows)).not.toMatch(/isVerified|active|messageText/);
  });
  it('ignores address-book-only entries, self-chat, groups, broadcasts and invalid clocks', async () => {
    const rows = await discoverWhatsAppHistoryContacts(
      {
        contacts: [{ id: '5511999990102@s.whatsapp.net', name: 'Only address book' }],
        chats: [
          '5511999990000@s.whatsapp.net',
          '123@g.us',
          'status@broadcast',
          '123@newsletter',
        ].map((id) => ({ id, conversationTimestamp: time })),
        messages: [{ key: { remoteJid: '5511999990103@s.whatsapp.net' }, messageTimestamp: null }],
      },
      async (k) => k.remoteJid ?? null,
      stamp,
      self,
      current
    );
    expect(rows).toEqual([]);
  });
  it('resolves LIDs only through verified mappings and deduplicates chat/message observations', async () => {
    const resolve = vi.fn(async (k) =>
      k.remoteJid === '900000000001@lid' ? '5581999990101@s.whatsapp.net' : (k.remoteJid ?? null)
    );
    const rows = await discoverWhatsAppHistoryContacts(
      {
        chats: [{ id: '900000000001@lid', conversationTimestamp: time }],
        messages: [
          {
            key: { remoteJid: '5581999990101@s.whatsapp.net', fromMe: false },
            pushName: 'Ana',
            messageTimestamp: time + 1,
          },
          { key: { remoteJid: '900000000002@lid', fromMe: false }, messageTimestamp: time },
          {
            key: { remoteJid: '5511999990104@s.whatsapp.net', fromMe: true },
            messageTimestamp: time,
          },
        ],
      },
      resolve,
      stamp,
      self,
      current
    );
    expect(rows).toEqual([
      { phone: '5581999990101', name: 'Ana', seenAt: new Date((time + 1) * 1000) },
    ]);
  });
  it('discards discoveries when the authenticated connection changes during resolution', async () => {
    let connected = true;
    const rows = await discoverWhatsAppHistoryContacts(
      {
        messages: [{ key: { remoteJid: '5511999990101@s.whatsapp.net' }, messageTimestamp: time }],
      },
      async () => {
        connected = false;
        return '5511999990101@s.whatsapp.net';
      },
      stamp,
      self,
      () => connected
    );
    expect(rows).toEqual([]);
  });
  it('keeps every contact beyond a normal UI page, with bounded lookup concurrency', async () => {
    let active = 0,
      peak = 0;
    const rows = await discoverWhatsAppHistoryContacts(
      {
        chats: Array.from({ length: 550 }, (_, i) => ({
          id: `55119999${String(i).padStart(5, '0')}@s.whatsapp.net`,
          conversationTimestamp: time,
        })),
        messages: [],
      },
      async (k) => {
        active++;
        peak = Math.max(peak, active);
        await Promise.resolve();
        active--;
        return k.remoteJid ?? null;
      },
      stamp,
      self,
      current
    );
    expect(rows).toHaveLength(550);
    expect(peak).toBeLessThanOrEqual(8);
  });
});
