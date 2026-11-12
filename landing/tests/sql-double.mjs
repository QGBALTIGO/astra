/** Test-only SQL double. No network, real PostgreSQL or customer records. */
export const requests = new Map();
export const unavailableEvents = new Set();
const counters = new Map();
export class SQL {
  constructor() {
    const sql = async (parts, ...values) => {
      const text = parts.join('?').replace(/\s+/g, ' ').trim();
      if (text.startsWith('CREATE ')) return [];
      if (text.startsWith('SELECT id,fingerprint FROM requests')) {
        const row = requests.get(values[0]);
        return row ? [{ id: row.id, fingerprint: row.fingerprint }] : [];
      }
      if (text.startsWith('INSERT INTO requests')) {
        const [
          id,
          requestKey,
          fingerprint,
          email,
          name,
          intent,
          message,
          consentVersion,
          cancellationHash,
        ] = values;
        if (requests.has(requestKey)) return [];
        requests.set(requestKey, {
          id,
          fingerprint,
          email,
          name,
          intent,
          message,
          consentVersion,
          cancellationHash,
        });
        return [{ id }];
      }
      if (text.startsWith('INSERT INTO rate_limits')) {
        const hits = (counters.get(values[0]) || 0) + 1;
        counters.set(values[0], hits);
        return [{ hits }];
      }
      if (text.startsWith('DELETE FROM requests WHERE cancellation_hash=')) {
        for (const [key, row] of requests)
          if (row.cancellationHash === values[0]) requests.delete(key);
        return [];
      }
      if (text.startsWith('INSERT INTO events') && unavailableEvents.has(values[0]))
        throw new Error('synthetic failure detail');
      if (text.startsWith('INSERT INTO events') || text.startsWith('DELETE ')) return [];
      throw Error(`Unimplemented test SQL: ${text}`);
    };
    sql.unsafe = async () => [];
    return sql;
  }
}
