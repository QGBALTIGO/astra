/**
 * Astra outbound quality telemetry.
 *
 * This deliberately does not persist message text, JIDs, telephone numbers,
 * prompts, tool arguments, PIX keys, or names. The regular channel_messages
 * table remains the single source of truth for conversation content.
 *
 * Each successfully acknowledged transport segment creates one small event;
 * the repository makes retries idempotent and maintains compact daily totals.
 */
import { createHash } from 'node:crypto';
import { BaseRepository } from '../db/repositories/base.js';
import { getLog } from './log.js';

const log = getLog('AstraOutboundQuality');
export const QUALITY_DETAIL_RETENTION_DAYS = 14;
export const QUALITY_DAILY_RETENTION_DAYS = 180;

export const QUALITY_FLAG_NAMES = [
  'technical_markup',
  'legacy_error_banner',
  'generic_operation_menu',
  'empty_reply',
] as const;
export type QualityFlag = (typeof QUALITY_FLAG_NAMES)[number];

export interface QualityEvent {
  channelId: string;
  externalId: string;
  text: string;
}

/** Cheap, deterministic classifiers. They produce REVIEW leads, not proof of failure. */
export function classifyOutboundResponse(text: string): QualityFlag[] {
  const flags: QualityFlag[] = [];
  if (!text.trim()) flags.push('empty_reply');
  const normalized = text
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .toLowerCase();
  if (
    /<\s*\/?\s*(?:tool_call|thinking|analysis|function_call|tool_result)\b|stack trace|^\s*at\s+\S+\s+\(.+:\d+:\d+\)/im.test(
      text
    )
  )
    flags.push('technical_markup');
  if (/nao consegui confirmar (?:o pedido|a execucao)/.test(normalized))
    flags.push('legacy_error_banner');
  if (
    /nao entendi bem o que voce quer/.test(normalized) &&
    /\b(?:1[.)]|2[.)]|regist(?:r|e)|crie um lembrete)\b/.test(normalized)
  )
    flags.push('generic_operation_menu');
  return flags;
}

/**
 * Only a channel ID, opaque platform message ID, character count and fixed
 * quality labels are written. A DB outage never changes a confirmed delivery.
 * This is an operational, metadata-only log; it is not model training.
 */
export class OutboundQualityRepository extends BaseRepository {
  async record(data: QualityEvent): Promise<void> {
    if (
      !data.channelId ||
      !data.externalId ||
      data.channelId.length > 128 ||
      data.externalId.length > 256
    )
      return;
    const flags = classifyOutboundResponse(data.text);
    const receiptHash = createHash('sha256')
      .update(data.channelId)
      .update('\0')
      .update(data.externalId)
      .digest('hex');
    await this.query(
      `WITH inserted AS (
        INSERT INTO astra_outbound_quality_events
          (channel_id, external_id, char_count, flags)
        VALUES ($1, $2, $3, $4::jsonb)
        ON CONFLICT (channel_id, external_id) DO NOTHING
        RETURNING channel_id, created_at, flags
      ), counted AS (
        INSERT INTO astra_outbound_quality_daily (day, channel_id, flag, count)
        SELECT (e.created_at AT TIME ZONE 'UTC')::date, e.channel_id, f.flag, 1
        FROM inserted e
        CROSS JOIN LATERAL (
          SELECT 'sent'::text AS flag
          UNION ALL
          SELECT jsonb_array_elements_text(e.flags)
        ) f
        ON CONFLICT (day, channel_id, flag)
          DO UPDATE SET count = astra_outbound_quality_daily.count + EXCLUDED.count
        RETURNING flag
      )
      SELECT count(*) AS counted FROM counted`,
      [
        data.channelId,
        receiptHash,
        Math.min(data.text.length, 65535),
        JSON.stringify(flags),
      ]
    );
  }

  /** No message text, recipient, or chat identifiers are returned. */
  async summary(channelId: string, days = 30): Promise<QualityDigest> {
    if (!channelId || channelId.length > 128) throw new Error('Invalid channel ID');
    const boundedDays = Number.isFinite(days) ? Math.min(180, Math.max(1, Math.trunc(days))) : 30;
    const rows = await this.query<{ flag: string; count: string }>(
      `SELECT flag, COALESCE(SUM(count), 0)::text AS count
       FROM astra_outbound_quality_daily
       WHERE channel_id = $1 AND day >= (CURRENT_DATE - ($2::integer - 1))
       GROUP BY flag`,
      [channelId, boundedDays]
    );
    const totals: Record<string, number> = {};
    for (const row of rows) {
      if (row.flag !== 'sent' && !QUALITY_FLAG_NAMES.some((name) => name === row.flag)) continue;
      totals[row.flag] = Math.max(0, Number(row.count) || 0);
    }
    return {
      channelId,
      days: boundedDays,
      totalSent: totals.sent ?? 0,
      flags: Object.fromEntries(QUALITY_FLAG_NAMES.map((flag) => [flag, totals[flag] ?? 0])) as Record<QualityFlag, number>,
      recommendations: recommendQualityImprovements(totals),
    };
  }

  async cleanupDetail(maxAgeDays = QUALITY_DETAIL_RETENTION_DAYS): Promise<number> {
    const days = Math.min(90, Math.max(1, Math.trunc(maxAgeDays) || 14));
    const result = await this.execute(
      `DELETE FROM astra_outbound_quality_events
       WHERE created_at < NOW() - ($1::integer * INTERVAL '1 day')`,
      [days]
    );
    return result.changes;
  }

  async cleanupDaily(maxAgeDays = QUALITY_DAILY_RETENTION_DAYS): Promise<number> {
    const days = Math.min(365, Math.max(1, Math.trunc(maxAgeDays) || 180));
    const result = await this.execute(
      `DELETE FROM astra_outbound_quality_daily
       WHERE day < CURRENT_DATE - $1::integer`,
      [days]
    );
    return result.changes;
  }
}

export interface QualityDigest {
  channelId: string;
  days: number;
  totalSent: number;
  flags: Record<QualityFlag, number>;
  recommendations: string[];
}

/** Rule-based improvement candidates only; never edits source or prompts. */
export function recommendQualityImprovements(counts: Record<string, number>): string[] {
  const out: string[] = [];
  if ((counts.technical_markup ?? 0) > 0)
    out.push('Reproduzir e corrigir vazamento de tags internas; criar regressão.');
  if ((counts.legacy_error_banner ?? 0) > 0)
    out.push('Investigar fallback e textos antigos de confirmação; criar regressão.');
  if ((counts.generic_operation_menu ?? 0) > 0)
    out.push('Reavaliar pedidos de redação tratados como comandos financeiros.');
  if ((counts.empty_reply ?? 0) > 0)
    out.push('Verificar respostas vazias e estabilidade da entrega do modelo.');
  return out;
}

const defaultRepo = new OutboundQualityRepository();

/** Best-effort capture AFTER successful delivery, with bounded sensitive data. */
export async function recordOutboundQuality(
  channelId: string,
  externalId: string,
  text: string
): Promise<void> {
  try {
    await defaultRepo.record({ channelId, externalId, text });
  } catch {
    // Never log message text, JID, recipient, tool arguments or keys.
    // A failed journal must not make the caller resend an already-sent message.
    log.warn('Outbound quality telemetry unavailable');
  }
}

export const outboundQualityRepo = defaultRepo;
