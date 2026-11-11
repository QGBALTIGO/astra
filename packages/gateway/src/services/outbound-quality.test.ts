import { createHash } from 'node:crypto';
import { beforeEach, describe, expect, it, vi } from 'vitest';

const mockQuery = vi.hoisted(() => vi.fn().mockResolvedValue([]));
const mockExecute = vi.hoisted(() => vi.fn().mockResolvedValue({ changes: 1 }));
const mockWarn = vi.hoisted(() => vi.fn());
const adapter = vi.hoisted(() => ({
  isConnected: vi.fn(() => true),
  query: mockQuery,
  execute: mockExecute,
}));
vi.mock('../db/adapters/index.js', () => ({
  getAdapter: vi.fn(async () => adapter),
}));
vi.mock('./log.js', () => ({
  getLog: () => ({ warn: mockWarn, info: vi.fn(), debug: vi.fn(), error: vi.fn() }),
}));

const {
  classifyOutboundResponse,
  OutboundQualityRepository,
  recordOutboundQuality,
  recommendQualityImprovements,
} = await import('./outbound-quality.js');
const { CORE_TABLES_SQL, CORE_INDEXES_SQL } = await import('../db/schema/core.js');

describe('Astra outbound quality: privacy and reproducibility', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockQuery.mockResolvedValue([]);
    mockExecute.mockResolvedValue({ changes: 1 });
  });

  it('classifies screenshot failures without transmitting or storing content', () => {
    expect(
      classifyOutboundResponse(
        '⚠️ Não consegui confirmar o pedido. Não consegui confirmar a execução.'
      )
    ).toContain('legacy_error_banner');
    expect(
      classifyOutboundResponse('Não entendi bem o que você quer. 1. Registe uma entrada?')
    ).toContain('generic_operation_menu');
    expect(classifyOutboundResponse('<tool_call>{"secret":"xyz"}</tool_call>')).toContain(
      'technical_markup'
    );
    expect(classifyOutboundResponse('   ')).toContain('empty_reply');
    expect(classifyOutboundResponse('Amor, consegue me fazer um Pix de R$ 100? ❤️')).toEqual([]);
  });

  it('writes tiny metadata only, never text, recipient, token or prompt', async () => {
    const repo = new OutboundQualityRepository();
    const privateMessage =
      'Chave Pix: 5511999999999 - Código 194283 - R$ 5000 - senha ultra-privada';
    await repo.record({
      channelId: 'channel.whatsapp',
      externalId: 'opaque-id',
      text: privateMessage,
    });
    expect(mockQuery).toHaveBeenCalledOnce();
    const [sql, values] = mockQuery.mock.calls[0] as [string, unknown[]];
    expect(sql).toContain('ON CONFLICT (channel_id, external_id) DO NOTHING');
    expect(sql).toContain('astra_outbound_quality_daily');
    expect(sql).toContain('SELECT count(*)');
    const receiptHash = createHash('sha256')
      .update('channel.whatsapp')
      .update('\0')
      .update('opaque-id')
      .digest('hex');
    expect(values).toEqual(['channel.whatsapp', receiptHash, privateMessage.length, '[]']);
    expect(JSON.stringify(values)).not.toContain('194283');
    expect(JSON.stringify(values)).not.toContain('ultra-privada');
    expect(JSON.stringify(values)).not.toContain('5511999999999');
  });

  it('makes duplicate deliveries idempotent at SQL boundary', async () => {
    const repo = new OutboundQualityRepository();
    await repo.record({ channelId: 'channel.whatsapp', externalId: 'm-42', text: 'Hi' });
    const sql = mockQuery.mock.calls[0]![0] as string;
    expect(sql).toContain('ON CONFLICT (channel_id, external_id) DO NOTHING');
    expect(sql).toContain('FROM inserted');
    // Both counters and event come from a single CTE. Duplicates yield no
    // inserted row and therefore no extra daily aggregate.
    expect(sql).toContain('count = astra_outbound_quality_daily.count + EXCLUDED.count');
  });

  it('does not log failed or invalid receipt identifiers', async () => {
    const repo = new OutboundQualityRepository();
    await repo.record({ channelId: 'channel.whatsapp', externalId: '', text: 'Hi' });
    await repo.record({ channelId: '', externalId: 'abc', text: 'Hi' });
    expect(mockQuery).not.toHaveBeenCalled();
  });

  it('does not make confirmed delivery fail when quality DB is unavailable', async () => {
    mockQuery.mockRejectedValueOnce(new Error('secret message cannot connect'));
    await expect(
      recordOutboundQuality('channel.whatsapp', 'id-ok', 'private user content')
    ).resolves.toBeUndefined();
    expect(mockWarn).toHaveBeenCalledWith('Outbound quality telemetry unavailable');
    expect(JSON.stringify(mockWarn.mock.calls)).not.toContain('private user content');
    expect(JSON.stringify(mockWarn.mock.calls)).not.toContain('secret message');
  });

  it('returns only summarized counts and conservative improvement candidates', async () => {
    mockQuery.mockResolvedValueOnce([
      { flag: 'sent', count: '42' },
      { flag: 'legacy_error_banner', count: '3' },
      { flag: 'technical_markup', count: '1' },
    ]);
    const report = await new OutboundQualityRepository().summary('channel.whatsapp', 99999);
    expect(report.days).toBe(180);
    expect(report.totalSent).toBe(42);
    expect(report.flags.legacy_error_banner).toBe(3);
    expect(report.flags.generic_operation_menu).toBe(0);
    expect(report.recommendations).toHaveLength(2);
    expect(JSON.stringify(report)).not.toContain('content');
    expect(recommendQualityImprovements({ sent: 10 })).toEqual([]);
  });

  it('bounds detail and aggregate retention and keeps them in the schema', async () => {
    const repo = new OutboundQualityRepository();
    await repo.cleanupDetail(5000);
    await repo.cleanupDaily(5000);
    expect(mockExecute.mock.calls[0]![1]).toEqual([90]);
    expect(mockExecute.mock.calls[1]![1]).toEqual([365]);
    expect(CORE_TABLES_SQL).toContain('CREATE TABLE IF NOT EXISTS astra_outbound_quality_events');
    expect(CORE_TABLES_SQL).toContain('CREATE TABLE IF NOT EXISTS astra_outbound_quality_daily');
    expect(CORE_TABLES_SQL).not.toContain('astra_outbound_quality_events (\n  content TEXT');
    expect(CORE_INDEXES_SQL).toContain('idx_astra_outbound_quality_events_created');
  });
});
