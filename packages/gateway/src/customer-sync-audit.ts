/**
 * Explicit, read-only support command. Never imported by the gateway and never
 * exposed through HTTP. Prints bounded counts for one reported monetary case;
 * no phones, names, account IDs, messages or credentials leave PostgreSQL.
 */
import { spawn } from 'node:child_process';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { releaseBackupPostgresEnvironment } from './release-backup.js';

export function customerSyncAuditSql(reference: string): string {
  const match = /^(\d{4}):(\d{4}-\d{2}-\d{2}):(\d{1,12})$/.exec(reference);
  if (
    !match ||
    +match[3]! < 1 ||
    new Date(match[2]! + 'T00:00:00Z').toISOString().slice(0, 10) !== match[2]
  )
    throw new Error('INVALID_REFERENCE');
  const [, suffix, day, cents] = match;
  return `BEGIN READ ONLY;
SET LOCAL statement_timeout = '8s';
SET LOCAL lock_timeout = '1s';
WITH targets AS (
  SELECT u.id, u.platform_user_id, u.ownpilot_user_id, a.id AS account_id, a.data_user_id,
    CASE WHEN u.platform_user_id ~ '^55[0-9]{2}9[0-9]{8}$'
      THEN left(u.platform_user_id, 4) || substring(u.platform_user_id from 6)
      ELSE u.platform_user_id END AS phone_group
  FROM channel_users u LEFT JOIN customer_accounts a ON a.channel_user_id = u.id
  WHERE u.platform = 'whatsapp' AND right(u.platform_user_id, 4) = '${suffix}'
), report AS (
  SELECT length(t.platform_user_id) AS phone_length,
    t.account_id IS NOT NULL AS has_customer_account,
    t.ownpilot_user_id = t.data_user_id AS channel_and_portal_scope_match,
    (SELECT count(*) FROM customer_sessions s WHERE s.account_id = t.account_id
      AND s.revoked_at IS NULL AND s.expires_at > NOW()) AS active_browser_sessions,
    (SELECT max(s.last_seen_at) FROM customer_sessions s WHERE s.account_id = t.account_id) AS last_portal_read,
    (SELECT jsonb_agg(jsonb_build_object('type', x.transaction_type, 'source', x.source,
       'status', x.status, 'deleted', x.deleted_at IS NOT NULL,
       'created_at', x.created_at, 'visible_in_portal', x.user_id = t.data_user_id,
       'position_by_record', 1 + (SELECT count(*) FROM expenses y WHERE y.user_id = t.data_user_id
         AND y.currency='BRL' AND y.deleted_at IS NULL AND left(y.date,7)=left('${day}',7)
         AND (y.created_at,y.id) > (x.created_at,x.id)),
       'position_by_due_date', 1 + (SELECT count(*) FROM expenses y WHERE y.user_id = t.data_user_id
         AND y.currency='BRL' AND y.deleted_at IS NULL AND left(y.date,7)=left('${day}',7)
         AND (y.date,y.created_at,y.id) > (x.date,x.created_at,x.id)),
       'position_in_activity', 1 + (SELECT count(*) FROM expenses y WHERE y.user_id = t.data_user_id
         AND y.currency='BRL' AND y.deleted_at IS NULL AND left(y.date,7)=left('${day}',7)
         AND (y.updated_at,y.created_at,y.id) > (x.updated_at,x.created_at,x.id)))
       ORDER BY x.created_at)
     FROM expenses x WHERE x.user_id IN (t.ownpilot_user_id, t.data_user_id)
       AND x.currency = 'BRL' AND x.date = '${day}' AND x.amount * 100 = ${cents}) AS matching_records
  FROM targets t
)
SELECT CASE WHEN (SELECT count(DISTINCT phone_group) FROM targets) > 1
  THEN jsonb_build_object('status', 'ambiguous_suffix')
  ELSE jsonb_build_object('status', 'read_only', 'matches', (SELECT count(*) FROM targets),
       'accounts', COALESCE((SELECT jsonb_agg(to_jsonb(report) ORDER BY phone_length) FROM report), '[]'::jsonb)) END;
ROLLBACK;
`;
}

export async function runCustomerSyncAudit(
  env: NodeJS.ProcessEnv = process.env
): Promise<string | null> {
  if (!env.ASTRA_CUSTOMER_SYNC_AUDIT) return null;
  const sql = customerSyncAuditSql(env.ASTRA_CUSTOMER_SYNC_AUDIT);
  const pgEnv = releaseBackupPostgresEnvironment(env);
  return new Promise<string>((resolveResult, reject) => {
    const child = spawn(
      'psql',
      ['-X', '-w', '-q', '-t', '-A', '-v', 'ON_ERROR_STOP=1', '-f', '-'],
      {
        env: { ...pgEnv, PGAPPNAME: 'astra-customer-sync-audit' },
        shell: false,
        stdio: ['pipe', 'pipe', 'ignore'],
      }
    );
    let output = '';
    const timer = setTimeout(() => child.kill('SIGKILL'), 15_000);
    child.stdout.on('data', (chunk: Buffer) => {
      output += chunk.toString('utf8');
      if (output.length > 16_384) child.kill('SIGKILL');
    });
    child.stdin.on('error', () => undefined);
    child.on('error', () => {
      clearTimeout(timer);
      reject(new Error('AUDIT_UNAVAILABLE'));
    });
    child.on('close', (code) => {
      clearTimeout(timer);
      if (code !== 0 || output.length > 16_384) return reject(new Error('AUDIT_UNAVAILABLE'));
      try {
        resolveResult(JSON.stringify(JSON.parse(output.trim())));
      } catch {
        reject(new Error('AUDIT_UNAVAILABLE'));
      }
    });
    child.stdin.end(sql);
  });
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  runCustomerSyncAudit()
    .then((report) => {
      if (report) process.stdout.write('[CustomerSyncAudit] ' + report + '\n');
    })
    .catch(() => {
      // Provider error text can include private connection details.
      process.stderr.write('[CustomerSyncAudit] AUDIT_UNAVAILABLE\n');
      process.exitCode = 1;
    });
}
