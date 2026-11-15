import { beforeEach, expect, it, vi } from 'vitest';
import type { WASocket } from '@whiskeysockets/baileys';
const f = vi.hoisted(() => ({ files: vi.fn(), get: vi.fn(), set: vi.fn() }));
vi.mock('node:fs/promises', () => ({ readdir: f.files }));
import { readWhatsAppLinkedPhones } from './whatsapp-linked-phones.js';
const socket = () => ({ authState: { keys: { get: f.get, set: f.set } } }) as unknown as WASocket;
const file = (name: string, isFile = true) => ({ name, isFile: () => isFile });
beforeEach(() => {
  vi.resetAllMocks();
  f.files.mockResolvedValue([
    file('creds.json'),
    file('session-244927000001.0.json'),
    file('lid-mapping-123_reverse.json'),
    file('lid-mapping-456_reverse.json'),
    file('lid-mapping-789_reverse.json'),
    file('lid-mapping-111_reverse.json', false),
  ]);
  f.get.mockImplementation(async (type: string, keys: string[]) => {
    expect(type).toBe('lid-mapping');
    const records: Record<string, string> = {
      '123_reverse': '244927000001',
      '244927000001': '123',
      '456_reverse': '5581999990101',
      '5581999990101': '456',
      '789_reverse': '5511999900000',
      '5511999900000': 'conflict',
    };
    return Object.fromEntries(keys.map((key) => [key, records[key]]));
  });
});
it('reads only mutually verified phone mappings, without credential or encryption-key reads or writes', async () => {
  const rows = await readWhatsAppLinkedPhones(
    socket(),
    '/isolated/session',
    () => true,
    () => false
  );
  expect(rows.map((row) => row.phone).sort()).toEqual(['244927000001', '5581999990101']);
  expect(f.get.mock.calls.flatMap((call) => call[1])).not.toContain('111_reverse');
  expect(f.set).not.toHaveBeenCalled();
});
it('discards mappings after a connection change', async () => {
  let active = true;
  f.get.mockImplementationOnce(async () => {
    active = false;
    return { '123_reverse': '244927000001' };
  });
  expect(
    await readWhatsAppLinkedPhones(
      socket(),
      '/isolated/session',
      () => active,
      () => false
    )
  ).toEqual([]);
});
it('excludes the authenticated owner and rejects reverse values containing a LID or group JID', async () => {
  f.get.mockResolvedValueOnce({
    '123_reverse': '123@lid',
    '456_reverse': '123@g.us',
    '789_reverse': '5511999900000',
  });
  expect(
    await readWhatsAppLinkedPhones(
      socket(),
      '/isolated/session',
      () => true,
      (jid) => jid === '5511999900000@s.whatsapp.net'
    )
  ).toEqual([]);
  expect(f.get).toHaveBeenCalledTimes(1);
});
