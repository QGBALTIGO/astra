import { createRequire } from 'node:module';
import { afterEach, describe, expect, it, vi } from 'vitest';

// Exercise the real transitive dependency used by Baileys. Its console calls
// bypass the configured pino logger, so a logger mock would miss this leak.
const require = createRequire(import.meta.url);
const baileysRequire = createRequire(require.resolve('@whiskeysockets/baileys'));

interface SyntheticSession {
  indexInfo: { closed: number; baseKey: Buffer; baseKeyType: number };
  currentRatchet: { rootKey: Buffer; ephemeralKeyPair: { privKey: Buffer } };
}

interface SignalRecord {
  closeSession(session: SyntheticSession): void;
  openSession(session: SyntheticSession): void;
  isClosed(session: SyntheticSession): boolean;
  setSession(session: SyntheticSession): void;
  getSessions(): SyntheticSession[];
  removeOldSessions(): void;
}

const SessionRecord = baileysRequire('libsignal/src/session_record.js') as new () => SignalRecord;

function syntheticSession(index: number, closed = -1): SyntheticSession {
  return {
    indexInfo: { closed, baseKey: Buffer.alloc(33, index), baseKeyType: 1 },
    currentRatchet: {
      rootKey: Buffer.from('synthetic-root-key'),
      ephemeralKeyPair: { privKey: Buffer.from('synthetic-private-key') },
    },
  };
}

describe('libsignal session logging', () => {
  afterEach(() => vi.restoreAllMocks());

  it('keeps session keys out of lifecycle logs while preserving close/open behavior', () => {
    const info = vi.spyOn(console, 'info').mockImplementation(() => undefined);
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    const record = new SessionRecord();
    const session = syntheticSession(1);

    record.closeSession(session);
    expect(record.isClosed(session)).toBe(true);
    record.closeSession(session);
    record.openSession(session);
    expect(record.isClosed(session)).toBe(false);

    expect(info).toHaveBeenCalled();
    expect(warn).toHaveBeenCalled();
    for (const args of [...info.mock.calls, ...warn.mock.calls]) {
      expect(args).toHaveLength(1);
      expect(typeof args[0]).toBe('string');
    }
  });

  it('removes old sessions without dumping their cryptographic material', () => {
    const info = vi.spyOn(console, 'info').mockImplementation(() => undefined);
    const record = new SessionRecord();
    for (let index = 0; index < 41; index++) {
      record.setSession(syntheticSession(index, index + 1));
    }
    record.removeOldSessions();
    expect(record.getSessions()).toHaveLength(40);
    expect(info).toHaveBeenCalledExactlyOnceWith('Removing old closed session');
  });
});
