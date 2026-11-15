/** One-shot private diagnostic: bounded aggregates, no payloads, writes or public listener. */
import { createRequire } from 'node:module';

const env = process.env;
const config = {
  host: env.PGHOST || env.POSTGRES_HOST,
  port: Number(env.PGPORT || env.POSTGRES_PORT),
  user: env.PGUSER || env.POSTGRES_USER,
  password: env.PGPASSWORD || env.POSTGRES_PASSWORD,
  database: env.PGDATABASE || env.POSTGRES_DB,
  connectionTimeoutMillis: 3000,
  options: '-c default_transaction_read_only=on -c statement_timeout=1000 -c lock_timeout=250',
};
if (!config.host || !config.port || !config.user || !config.password || !config.database) {
  console.log(JSON.stringify({ queueAudit: { status: 'not_configured' } }));
} else {
  const require = createRequire(
    env.ASTRA_QUEUE_AUDIT_PACKAGE || '/app/packages/gateway/package.json'
  );
  const { Client } = require('pg');
  const db = new Client(config);
  try {
    await db.connect();
    await db.query('BEGIN READ ONLY');
    const result = await db.query(`WITH sample AS (
      SELECT name, priority, run_after FROM jobs
      WHERE status = 'available' AND priority > 0 LIMIT 1001
    ) SELECT CASE WHEN name = 'nightly_retention_cleanup' THEN 'retention'
        WHEN name = 'workflow_node' THEN 'workflow' ELSE 'other' END AS kind,
      COUNT(*)::int AS count,
      COUNT(*) FILTER (WHERE run_after <= NOW())::int AS due,
      MIN(priority)::int AS min_priority, MAX(priority)::int AS max_priority
      FROM sample GROUP BY 1 ORDER BY 1`);
    await db.query('COMMIT');
    console.log(
      JSON.stringify({ queueAudit: { status: 'ok', sampleLimit: 1001, groups: result.rows } })
    );
  } catch {
    console.log(JSON.stringify({ queueAudit: { status: 'unavailable' } }));
  } finally {
    await db.end();
  }
}
