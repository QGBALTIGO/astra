import { randomUUID } from 'node:crypto';
import { BaseRepository } from './base.js';
import { isRadarNewsCard, type RadarNewsCard } from '../../services/radar/news-cards.js';
import {
  radarInputSchema,
  radarPreferencesSchema,
  RADAR_DEFAULT_PREFERENCES,
  normalizeRadarTarget,
  resourceId,
  type RadarInput,
  type RadarInterest,
  type RadarPreferences,
  type RadarResource,
  type RadarSnapshot,
  type RadarSourceId,
} from '../../services/radar/contracts.js';

export interface RadarInterestRow {
  id: string;
  user_id: string;
  resource_id: string;
  input: RadarInput;
  label: string;
  active: boolean;
  revision: number;
  last_digest_day: string | null;
  threshold_state: boolean | null;
  created_at: string | Date;
  snapshot: RadarSnapshot | null;
  error_code: string | null;
  last_content_key: string | null;
}
export interface RadarDeliveryRow {
  id: string;
  user_id: string;
  interest_id: string | null;
  interest_revision: number;
  preference_revision: number;
  event_key: string;
  payload: {
    title: string;
    text: string;
    source: string;
    url: string;
    itemId?: string;
    at?: string;
    newsPreview?: boolean;
    cards?: RadarNewsCard[];
    totalParts?: number;
    deliveredParts?: Array<{ index: number; transportId: string }>;
  };
  expires_at: string | Date;
  lease_token: string;
}
export function mapRadarInterest(r: RadarInterestRow) {
  return {
    ...r.input,
    id: r.id,
    label: r.label,
    active: r.active,
    revision: r.revision,
    createdAt: new Date(r.created_at).toISOString(),
    snapshot: r.snapshot,
    errorCode: r.error_code,
  } satisfies RadarInterest & { snapshot: RadarSnapshot | null; errorCode: string | null };
}
function privateUser(user: string): void {
  if (!user?.trim() || user === 'default') throw new Error('Entre na sua conta para continuar.');
}
const INTEREST_SELECT = `SELECT i.*,r.snapshot,r.error_code FROM customer_radar_interests i JOIN radar_resources r ON r.id=i.resource_id`;
export class CustomerRadarRepository extends BaseRepository {
  constructor(readonly userId: string) {
    super();
    privateUser(userId);
  }
  async preferences(): Promise<{ preferences: RadarPreferences; revision: number }> {
    const r = await this.queryOne<{ preferences: RadarPreferences; revision: number }>(
      'SELECT preferences,revision FROM customer_radar_preferences WHERE user_id=$1',
      [this.userId]
    );
    return r ?? { preferences: { ...RADAR_DEFAULT_PREFERENCES }, revision: 0 };
  }
  async savePreferences(raw: RadarPreferences) {
    const input = radarPreferencesSchema.parse(raw);
    return this.transaction(async () => {
      await this.execute('SELECT pg_advisory_xact_lock(hashtextextended($1,0))', [
        'radar:' + this.userId,
      ]);
      return this.writePreferences(input);
    });
  }
  /** Caller holds the account lock in its existing transaction; never open a nested one. */
  private async writePreferences(input: RadarPreferences) {
    const r = await this.queryOne<{ preferences: RadarPreferences; revision: number }>(
      `INSERT INTO customer_radar_preferences(user_id,preferences) VALUES($1,$2::jsonb)
    ON CONFLICT(user_id) DO UPDATE SET preferences=$2::jsonb,revision=customer_radar_preferences.revision+1,updated_at=NOW() RETURNING preferences,revision`,
      [this.userId, JSON.stringify(input)]
    );
    await this.execute(
      "UPDATE customer_radar_outbox SET status='cancelled' WHERE user_id=$1 AND status IN ('pending','leased')",
      [this.userId]
    );
    return r!;
  }
  async list(): Promise<ReturnType<typeof mapRadarInterest>[]> {
    return (
      await this.query<RadarInterestRow>(
        INTEREST_SELECT + ' WHERE i.user_id=$1 ORDER BY i.created_at DESC',
        [this.userId]
      )
    ).map(mapRadarInterest);
  }
  /** Explicit chat opt-in starts only the requested topic when the entire Radar was off. */
  async followFromChat(input: RadarInput, label: string, time: string) {
    input = radarInputSchema.parse(input);
    input.target = normalizeRadarTarget(input.source, input.target);
    const rid = resourceId(input.source, input.target, input.query);
    return this.transaction(async () => {
      await this.execute('SELECT pg_advisory_xact_lock(hashtextextended($1,0))', [
        'radar:' + this.userId,
      ]);
      const pref = await this.preferences();
      const nextPreferences = radarPreferencesSchema.parse({
        ...pref.preferences,
        enabled: true,
        time,
      });
      await this.execute(
        `INSERT INTO radar_resources(id,source,target,label,query) VALUES($1,$2,$3,$4,$5) ON CONFLICT(id) DO NOTHING`,
        [rid, input.source, input.target, label, input.query ?? null]
      );
      const row = await this.queryOne<{ id: string }>(
        `INSERT INTO customer_radar_interests(id,user_id,resource_id,input,label) VALUES($1,$2,$3,$4::jsonb,$5)
        ON CONFLICT(user_id,resource_id) DO UPDATE SET active=TRUE,input=EXCLUDED.input,
        revision=customer_radar_interests.revision+1,last_digest_day=NULL,threshold_state=NULL,updated_at=NOW() RETURNING id`,
        [randomUUID(), this.userId, rid, JSON.stringify(input), label]
      );
      let keptPaused = 0;
      if (!pref.preferences.enabled) {
        keptPaused = (
          await this.execute(
            'UPDATE customer_radar_interests SET active=FALSE,revision=revision+1,updated_at=NOW() WHERE user_id=$1 AND id<>$2 AND active=TRUE',
            [this.userId, row!.id]
          )
        ).changes;
      }
      await this.writePreferences(nextPreferences);
      return { interest: mapRadarInterest((await this.get(row!.id))!), keptPaused };
    });
  }
  async get(id: string): Promise<RadarInterestRow | null> {
    return this.queryOne<RadarInterestRow>(INTEREST_SELECT + ' WHERE i.user_id=$1 AND i.id=$2', [
      this.userId,
      id,
    ]);
  }
  async create(raw: RadarInput, label: string) {
    const input = radarInputSchema.parse(raw);
    input.target = normalizeRadarTarget(input.source, input.target);
    const rid = resourceId(input.source, input.target, input.query);
    return this.transaction(async () => {
      await this.execute('SELECT pg_advisory_xact_lock(hashtextextended($1,0))', [
        'radar:' + this.userId,
      ]);
      await this.execute(
        `INSERT INTO radar_resources(id,source,target,label,query) VALUES($1,$2,$3,$4,$5) ON CONFLICT(id) DO NOTHING`,
        [rid, input.source, input.target, label, input.query ?? null]
      );
      const row = await this.queryOne<{ id: string }>(
        `INSERT INTO customer_radar_interests(id,user_id,resource_id,input,label) VALUES($1,$2,$3,$4::jsonb,$5)
     ON CONFLICT(user_id,resource_id) DO NOTHING RETURNING id`,
        [randomUUID(), this.userId, rid, JSON.stringify(input), label]
      );
      if (!row)
        throw new Error('Você já acompanha esse assunto. Edite o acompanhamento existente.');
      return mapRadarInterest((await this.get(row.id))!);
    });
  }
  async change(
    id: string,
    patch: {
      active?: boolean;
      delivery?: RadarInput['delivery'];
      threshold?: string;
      comparison?: RadarInput['comparison'];
      leadMinutes?: number;
    }
  ) {
    return this.transaction(async () => {
      await this.execute('SELECT pg_advisory_xact_lock(hashtextextended($1,0))', [
        'radar:' + this.userId,
      ]);
      const old = await this.get(id);
      if (!old) return null;
      const { active, ...rest } = patch;
      const input = radarInputSchema.parse({ ...old.input, ...rest });
      await this.execute(
        `UPDATE customer_radar_interests SET active=$3,input=$4::jsonb,revision=revision+1,
    last_digest_day=NULL,threshold_state=NULL,updated_at=NOW() WHERE user_id=$1 AND id=$2`,
        [this.userId, id, active ?? old.active, JSON.stringify(input)]
      );
      await this.execute(
        "UPDATE customer_radar_outbox SET status='cancelled' WHERE user_id=$1 AND interest_id=$2 AND status IN ('pending','leased')",
        [this.userId, id]
      );
      return mapRadarInterest((await this.get(id))!);
    });
  }
  async remove(id: string): Promise<boolean> {
    return this.transaction(async () => {
      await this.execute('SELECT pg_advisory_xact_lock(hashtextextended($1,0))', [
        'radar:' + this.userId,
      ]);
      return (
        (
          await this.execute('DELETE FROM customer_radar_interests WHERE user_id=$1 AND id=$2', [
            this.userId,
            id,
          ])
        ).changes > 0
      );
    });
  }
  async history() {
    return this.query<{
      id: string;
      label: string;
      status: string;
      created_at: Date | string;
      sent_at: Date | string | null;
    }>(
      `SELECT o.id,i.label,o.status,o.created_at,o.sent_at FROM customer_radar_outbox o
  LEFT JOIN customer_radar_interests i ON i.id=o.interest_id AND i.user_id=o.user_id
  WHERE o.user_id=$1 ORDER BY o.created_at DESC LIMIT 50`,
      [this.userId]
    );
  }
}
export class RadarRepository extends BaseRepository {
  async refreshReplacedSources(): Promise<void> {
    await this
      .execute(`UPDATE radar_resources SET snapshot=NULL,error_code=NULL,failures=0,next_poll_at=NOW()
      WHERE (leased_until IS NULL OR leased_until<NOW()) AND (
        (source='news' AND (snapshot->>'sourceLabel'='GDELT' OR error_code IS NOT NULL)) OR
        (source='football' AND snapshot->>'sourceLabel'='football-data.org'))`);
  }
  async rememberChoices(source: RadarSourceId, choices: Array<{ id: string; label: string }>) {
    for (const c of choices.slice(0, 8))
      await this.execute(
        'INSERT INTO radar_resources(id,source,target,label) VALUES($1,$2,$3,$4) ON CONFLICT(id) DO NOTHING',
        [resourceId(source, c.id), source, c.id, c.label]
      );
  }
  async choice(source: RadarSourceId, target: string): Promise<string | null> {
    return (
      (
        await this.queryOne<{ label: string }>(
          'SELECT label FROM radar_resources WHERE id=$1 AND source=$2',
          [resourceId(source, target), source]
        )
      )?.label ?? null
    );
  }
  async reserveProvider(provider: string, intervalMs: number): Promise<boolean> {
    return !!(await this.queryOne(
      `INSERT INTO radar_provider_limits(provider,next_request_at) VALUES($1,NOW()+$2*INTERVAL '1 millisecond')
  ON CONFLICT(provider) DO UPDATE SET next_request_at=NOW()+$2*INTERVAL '1 millisecond'
  WHERE radar_provider_limits.next_request_at<=NOW() AND radar_provider_limits.blocked_until<=NOW() RETURNING provider`,
      [provider, intervalMs]
    ));
  }
  async blockProvider(provider: string, seconds: number): Promise<void> {
    await this.execute(
      `UPDATE radar_provider_limits SET blocked_until=GREATEST(blocked_until,NOW()+$2*INTERVAL '1 second') WHERE provider=$1`,
      [provider, Math.max(1, Math.min(seconds, 86400))]
    );
  }
  async claimResources(
    limit = 2
  ): Promise<Array<RadarResource & { query: string | null; lease_token: string }>> {
    const token = randomUUID();
    return this.query(
      `WITH due AS (
   SELECT r.id FROM radar_resources r WHERE r.next_poll_at<=NOW()
   AND (r.leased_until IS NULL OR r.leased_until<NOW())
   AND NOT EXISTS(SELECT 1 FROM radar_provider_limits p WHERE p.provider=CASE r.source
     WHEN 'currency' THEN 'api.frankfurter.dev' WHEN 'ptax' THEN 'olinda.bcb.gov.br'
     WHEN 'football' THEN 'raw.githubusercontent.com' WHEN 'news' THEN 'pt.globalvoices.org'
     WHEN 'series' THEN 'api.tvmaze.com' WHEN 'gazettes' THEN 'api.queridodiario.ok.org.br'
     WHEN 'energy' THEN 'dadosabertos.aneel.gov.br' WHEN 'releases' THEN 'api.github.com' ELSE 'api.met.no' END
     AND (p.next_request_at>NOW() OR p.blocked_until>NOW()))
   AND EXISTS(SELECT 1 FROM customer_radar_interests i
      JOIN customer_accounts a ON a.data_user_id=i.user_id JOIN channel_users u ON u.id=a.channel_user_id
      WHERE i.resource_id=r.id AND i.active AND u.status='active' AND u.is_verified AND NOT u.is_blocked
      AND (u.access_expires_at IS NULL OR u.access_expires_at>NOW()))
   ORDER BY r.next_poll_at LIMIT $1 FOR UPDATE SKIP LOCKED)
   UPDATE radar_resources r SET lease_token=$2,leased_until=NOW()+INTERVAL '180 seconds'
   FROM due WHERE r.id=due.id RETURNING r.id,r.source,r.target,r.label,r.query,r.lease_token`,
      [Math.max(1, Math.min(limit, 10)), token]
    );
  }
  async saveSnapshot(
    id: string,
    token: string,
    snapshot: RadarSnapshot,
    pollSeconds: number
  ): Promise<boolean> {
    return (
      (
        await this.execute(
          `UPDATE radar_resources SET snapshot=$3::jsonb,updated_at=NOW(),error_code=NULL,failures=0,
   next_poll_at=GREATEST(NOW()+INTERVAL '15 seconds',LEAST(NOW()+$4*INTERVAL '1 second', $5::timestamptz)),lease_token=NULL,leased_until=NULL
   WHERE id=$1 AND lease_token=$2 AND leased_until>NOW()`,
          [id, token, JSON.stringify(snapshot), pollSeconds, snapshot.expiresAt]
        )
      ).changes > 0
    );
  }
  async failResource(id: string, token: string, code: string, seconds: number): Promise<void> {
    await this.execute(
      `UPDATE radar_resources SET error_code=$3,failures=LEAST(failures+1,20),next_poll_at=NOW()+$4*INTERVAL '1 second',lease_token=NULL,leased_until=NULL
   WHERE id=$1 AND lease_token=$2`,
      [id, token, code, Math.min(86400, Math.max(seconds, 30))]
    );
  }
  async activeAccounts(
    after: string,
    limit = 100
  ): Promise<
    Array<{
      user_id: string;
      time_zone: string;
      time_zone_source: string;
      current_phone: string;
      preferences: RadarPreferences;
      preference_revision: number;
      interests: RadarInterestRow[];
    }>
  > {
    return this.query(
      `WITH accounts AS(SELECT p.user_id,a.time_zone,a.time_zone_source,a.current_phone,p.preferences,p.revision AS preference_revision FROM customer_radar_preferences p JOIN customer_accounts a ON a.data_user_id=p.user_id
    JOIN channel_users u ON u.id=a.channel_user_id
    WHERE p.user_id>$1 AND p.preferences->>'enabled'='true' AND u.is_verified AND NOT u.is_blocked AND u.status='active'
      AND (u.access_expires_at IS NULL OR u.access_expires_at>NOW())
      AND EXISTS(SELECT 1 FROM customer_radar_interests i WHERE i.user_id=p.user_id AND i.active)
    ORDER BY p.user_id LIMIT $2)
    SELECT accounts.*,(SELECT COALESCE(jsonb_agg(to_jsonb(i)||jsonb_build_object('snapshot',r.snapshot,'error_code',r.error_code) ORDER BY i.created_at,i.id),'[]'::jsonb)
       FROM customer_radar_interests i JOIN radar_resources r ON r.id=i.resource_id WHERE i.user_id=accounts.user_id AND i.active) AS interests
    FROM accounts ORDER BY user_id`,
      [after, limit]
    );
  }
  async queue(
    userId: string,
    interest: RadarInterestRow,
    prefRevision: number,
    eventKey: string,
    payload: RadarDeliveryRow['payload'],
    expiresAt: Date,
    thresholdState?: boolean
  ) {
    return this.transaction(async () => {
      await this.execute('SELECT pg_advisory_xact_lock(hashtextextended($1,0))', [
        'radar:' + userId,
      ]);
      const current = await this.queryOne<{ id: string }>(
        `SELECT i.id FROM customer_radar_interests i JOIN customer_radar_preferences p ON p.user_id=i.user_id
    WHERE i.user_id=$1 AND i.id=$2 AND i.revision=$3 AND i.active AND p.revision=$4 AND p.preferences->>'enabled'='true'`,
        [userId, interest.id, interest.revision, prefRevision]
      );
      if (!current) return false;
      const changed = await this.execute(
        `INSERT INTO customer_radar_outbox(id,user_id,interest_id,interest_revision,preference_revision,event_key,payload,expires_at)
    VALUES($1,$2,$3,$4,$5,$6,$7::jsonb,$8) ON CONFLICT(user_id,event_key) DO NOTHING`,
        [
          randomUUID(),
          userId,
          interest.id,
          interest.revision,
          prefRevision,
          eventKey,
          JSON.stringify(payload),
          expiresAt.toISOString(),
        ]
      );
      if (thresholdState !== undefined)
        await this.execute(
          'UPDATE customer_radar_interests SET threshold_state=$3 WHERE user_id=$1 AND id=$2 AND revision=$4',
          [userId, interest.id, thresholdState, interest.revision]
        );
      return changed.changes > 0;
    });
  }
  async resetThreshold(userId: string, id: string, revision: number) {
    await this.execute(
      'UPDATE customer_radar_interests SET threshold_state=FALSE WHERE user_id=$1 AND id=$2 AND revision=$3 AND active',
      [userId, id, revision]
    );
  }
  async rawInterests(userId: string): Promise<RadarInterestRow[]> {
    return this.query<RadarInterestRow>(
      INTEREST_SELECT + ' WHERE i.user_id=$1 AND i.active ORDER BY i.created_at,i.id',
      [userId]
    );
  }
  async markContent(userId: string, id: string, revision: number, key: string) {
    await this.execute(
      'UPDATE customer_radar_interests SET last_content_key=$4 WHERE user_id=$1 AND id=$2 AND revision=$3 AND active',
      [userId, id, revision, key]
    );
  }
  async queueRequestedDigest(userId: string, preferenceRevision: number, requestId: string) {
    return this.transaction(async () => {
      await this.execute('SELECT pg_advisory_xact_lock(hashtextextended($1,0))', [
        'radar:' + userId,
      ]);
      const key = 'requested:' + requestId;
      if (
        await this.queryOne(
          'SELECT id FROM customer_radar_outbox WHERE user_id=$1 AND event_key=$2',
          [userId, key]
        )
      )
        return 'existing' as const;
      if (
        await this.queryOne(
          "SELECT id FROM customer_radar_outbox WHERE user_id=$1 AND event_key LIKE 'requested:%' AND created_at>NOW()-INTERVAL '60 seconds'",
          [userId]
        )
      )
        return 'rate_limited' as const;
      return (await this.queueDigest(
        userId,
        preferenceRevision,
        '',
        new Date(Date.now() + 300000),
        key
      ))
        ? ('queued' as const)
        : ('unavailable' as const);
    });
  }
  /** Queue an explicitly requested news read without subscribing the customer. */
  async queueNewsPreview(
    userId: string,
    preferenceRevision: number,
    requestId: string,
    cards: readonly RadarNewsCard[]
  ): Promise<'queued' | 'existing' | 'rate_limited' | 'unavailable'> {
    if (
      !userId?.trim() ||
      userId === 'default' ||
      !Number.isInteger(preferenceRevision) ||
      preferenceRevision < 0 ||
      preferenceRevision > 2147483647 ||
      typeof requestId !== 'string' ||
      !requestId ||
      requestId.length > 256 ||
      /[\p{Cc}\p{Cf}]/u.test(requestId) ||
      !Array.isArray(cards) ||
      cards.length < 1 ||
      cards.length > 3 ||
      !cards.every(isRadarNewsCard) ||
      cards.some((card) => {
        if (
          typeof card?.text !== 'string' ||
          !card.text.trim() ||
          card.text.length > 500 ||
          card.urlButton?.label !== 'Ler matéria' ||
          typeof card.urlButton.url !== 'string' ||
          card.urlButton.url.length > 600 ||
          /[\s\p{Cc}\p{Cf}]/u.test(card.urlButton.url)
        )
          return true;
        try {
          const url = new URL(card.urlButton.url);
          return (
            url.protocol !== 'https:' ||
            url.hostname !== 'pt.globalvoices.org' ||
            !!url.port ||
            !!url.username ||
            !!url.password
          );
        } catch {
          return true;
        }
      })
    )
      return 'unavailable';
    const key = 'preview:' + requestId;
    const payload = JSON.stringify({
      title: 'Notícias',
      text: '',
      source: 'Global Voices',
      url: '',
      newsPreview: true,
      cards: cards.map((card) => ({
        text: card.text,
        urlButton: { label: 'Ler matéria', url: card.urlButton.url },
      })),
    });
    return this.transaction(async () => {
      await this.execute('SELECT pg_advisory_xact_lock(hashtextextended($1,0))', [
        'radar:' + userId,
      ]);
      if (
        await this.queryOne(
          'SELECT id FROM customer_radar_outbox WHERE user_id=$1 AND event_key=$2',
          [userId, key]
        )
      )
        return 'existing';
      if (
        await this.queryOne(
          "SELECT id FROM customer_radar_outbox WHERE user_id=$1 AND event_key LIKE 'preview:%' AND created_at>NOW()-INTERVAL '10 seconds'",
          [userId]
        )
      )
        return 'rate_limited';
      // Missing preferences mean OFF/revision 0. Materialize only that default
      // so the outbox FK can retain the requested read without opting into jobs.
      if (preferenceRevision === 0)
        await this.execute(
          `INSERT INTO customer_radar_preferences(user_id,preferences,revision)
           SELECT data_user_id,$2::jsonb,0 FROM customer_accounts WHERE data_user_id=$1
           ON CONFLICT(user_id) DO NOTHING`,
          [userId, JSON.stringify(RADAR_DEFAULT_PREFERENCES)]
        );
      return (await this.queryOne(
        `INSERT INTO customer_radar_outbox(id,user_id,interest_id,interest_revision,preference_revision,event_key,payload,expires_at)
         SELECT $1,p.user_id,NULL,0,p.revision,$3,$4::jsonb,NOW()+INTERVAL '5 minutes'
         FROM customer_radar_preferences p WHERE p.user_id=$2 AND p.revision=$5
         ON CONFLICT(user_id,event_key) DO NOTHING RETURNING id`,
        [randomUUID(), userId, key, payload, preferenceRevision]
      ))
        ? 'queued'
        : 'unavailable';
    });
  }
  async queueDigest(
    userId: string,
    preferenceRevision: number,
    day: string,
    expiresAt: Date,
    requestedKey?: string
  ) {
    return !!(await this.queryOne(
      `INSERT INTO customer_radar_outbox(id,user_id,interest_id,interest_revision,preference_revision,event_key,payload,expires_at)
   SELECT $1,p.user_id,NULL,0,p.revision,$3,'{}'::jsonb,$4 FROM customer_radar_preferences p
   WHERE p.user_id=$2 AND p.revision=$5 AND p.preferences->>'enabled'='true'
   ON CONFLICT(user_id,event_key) DO UPDATE SET status='pending',preference_revision=EXCLUDED.preference_revision,expires_at=EXCLUDED.expires_at
   WHERE customer_radar_outbox.status='cancelled' RETURNING id`,
      [
        randomUUID(),
        userId,
        requestedKey ?? 'digest:' + day,
        expiresAt.toISOString(),
        preferenceRevision,
      ]
    ));
  }
  async claimDeliveries(limit = 2): Promise<RadarDeliveryRow[]> {
    // Once transmission started, a crash is ambiguous: retain status, never blindly replay.
    await this.execute(
      "UPDATE customer_radar_outbox SET status='unknown' WHERE status='sending' AND leased_until<NOW()"
    );
    await this.execute(
      "UPDATE customer_radar_outbox SET status='expired' WHERE status IN ('pending','leased') AND expires_at<=NOW()"
    );
    return this.query(
      `WITH due AS(SELECT id FROM customer_radar_outbox WHERE expires_at>NOW() AND not_before<=NOW()
    AND (status='pending' OR (status='leased' AND leased_until<NOW())) ORDER BY created_at LIMIT $1 FOR UPDATE SKIP LOCKED)
    UPDATE customer_radar_outbox o SET status='leased',lease_token=$2,leased_until=NOW()+INTERVAL '120 seconds'
    FROM due WHERE o.id=due.id RETURNING o.*`,
      [Math.max(1, Math.min(limit, 10)), randomUUID()]
    );
  }
  async deliveryCurrent(row: RadarDeliveryRow): Promise<boolean> {
    return !!(await this.queryOne(
      `SELECT o.id FROM customer_radar_outbox o LEFT JOIN customer_radar_interests i ON i.id=o.interest_id AND i.user_id=o.user_id
   JOIN customer_radar_preferences p ON p.user_id=o.user_id
   WHERE o.id=$1 AND o.lease_token=$2 AND o.user_id=$3 AND o.status='leased' AND o.leased_until>NOW() AND o.expires_at>NOW()
   AND (o.interest_id IS NULL OR (i.active AND i.revision=o.interest_revision)) AND p.revision=o.preference_revision
   AND (p.preferences->>'enabled'='true' OR (o.payload->>'newsPreview'='true' AND o.event_key LIKE 'preview:%'))`,
      [row.id, row.lease_token, row.user_id]
    ));
  }
  async beginDelivery(row: RadarDeliveryRow): Promise<boolean> {
    return this.transaction(async () => {
      await this.execute('SELECT pg_advisory_xact_lock(hashtextextended($1,0))', [
        'radar:' + row.user_id,
      ]);
      return !!(await this.queryOne(
        `UPDATE customer_radar_outbox o SET status='sending'
   FROM customer_radar_preferences p
   WHERE o.id=$1 AND o.lease_token=$2 AND o.user_id=$3 AND o.status='leased' AND o.leased_until>NOW() AND o.expires_at>NOW()
     AND (o.interest_id IS NULL OR EXISTS(SELECT 1 FROM customer_radar_interests i WHERE i.id=o.interest_id AND i.user_id=o.user_id AND i.active AND i.revision=o.interest_revision))
     AND p.user_id=o.user_id AND p.revision=o.preference_revision
     AND (p.preferences->>'enabled'='true' OR (o.payload->>'newsPreview'='true' AND o.event_key LIKE 'preview:%')) RETURNING o.id`,
        [row.id, row.lease_token, row.user_id]
      ));
    });
  }
  /** Revalidate opt-in, expiry and fencing before each remaining message in a batch. */
  async sendingDeliveryCurrent(row: RadarDeliveryRow): Promise<boolean> {
    return !!(await this.queryOne(
      `SELECT o.id FROM customer_radar_outbox o LEFT JOIN customer_radar_interests i ON i.id=o.interest_id AND i.user_id=o.user_id
   JOIN customer_radar_preferences p ON p.user_id=o.user_id
   WHERE o.id=$1 AND o.lease_token=$2 AND o.user_id=$3 AND o.status='sending' AND o.leased_until>NOW() AND o.expires_at>NOW()
   AND (o.interest_id IS NULL OR (i.active AND i.revision=o.interest_revision)) AND p.revision=o.preference_revision
   AND (p.preferences->>'enabled'='true' OR (o.payload->>'newsPreview'='true' AND o.event_key LIKE 'preview:%'))`,
      [row.id, row.lease_token, row.user_id]
    ));
  }
  /**
   * Persist a confirmed part with one fenced update, without holding a database
   * transaction over transport. An uncertain batch is never replayed; these
   * receipts are retained even if an opt-out/expiry happened during the send.
   */
  async recordDeliveryPart(
    row: RadarDeliveryRow,
    index: number,
    transportId: string,
    totalParts: number
  ): Promise<boolean> {
    if (
      !Number.isInteger(index) ||
      !Number.isInteger(totalParts) ||
      totalParts < 1 ||
      totalParts > 10 ||
      index < 0 ||
      index >= totalParts ||
      typeof transportId !== 'string' ||
      !transportId ||
      transportId.length > 256 ||
      /[\s\p{Cc}\p{Cf}]/u.test(transportId)
    )
      return false;
    const parts = `CASE WHEN jsonb_typeof(o.payload->'deliveredParts')='array' THEN o.payload->'deliveredParts' ELSE '[]'::jsonb END`;
    const samePart = `EXISTS(SELECT 1 FROM jsonb_array_elements(${parts}) part WHERE part->'index'=to_jsonb($3::int) AND part->>'transportId'=$4)`;
    return !!(await this.queryOne(
      `UPDATE customer_radar_outbox o
   SET payload=jsonb_set(jsonb_set(o.payload,'{totalParts}',to_jsonb($5::int),true),'{deliveredParts}',
     CASE WHEN ${samePart} THEN ${parts} ELSE ${parts} || jsonb_build_array(jsonb_build_object('index',$3::int,'transportId',$4::text)) END,true)
   WHERE o.id=$1 AND o.lease_token=$2 AND o.user_id=$6 AND o.status='sending'
     AND jsonb_typeof(o.payload)='object'
     AND (NOT(o.payload ? 'deliveredParts') OR jsonb_typeof(o.payload->'deliveredParts')='array')
     AND (NOT(o.payload ? 'totalParts') OR o.payload->'totalParts'=to_jsonb($5::int))
     AND (${samePart} OR (jsonb_array_length(${parts})=$3 AND NOT EXISTS(SELECT 1 FROM jsonb_array_elements(${parts}) part WHERE part->'index'=to_jsonb($3::int))))
   RETURNING o.id`,
      [row.id, row.lease_token, index, transportId, totalParts, row.user_id]
    ));
  }
  async finishDelivery(
    row: RadarDeliveryRow,
    status: 'sent' | 'unknown' | 'cancelled' | 'expired',
    transportId?: string
  ) {
    await this.execute(
      `UPDATE customer_radar_outbox SET status=$3,transport_id=$4,sent_at=CASE WHEN $3='sent' THEN NOW() ELSE sent_at END
   WHERE id=$1 AND lease_token=$2 AND status IN ('leased','sending')`,
      [row.id, row.lease_token, status, transportId ?? null]
    );
  }
  async deferDelivery(row: RadarDeliveryRow, seconds = 60, knownNotSent = false) {
    await this.execute(
      `UPDATE customer_radar_outbox SET status='pending',not_before=NOW()+$3*INTERVAL '1 second',lease_token=NULL,leased_until=NULL WHERE id=$1 AND lease_token=$2 AND (status='leased' OR ($4::boolean AND status='sending'))`,
      [row.id, row.lease_token, seconds, knownNotSent]
    );
  }
  async cleanup() {
    await this.execute(
      "DELETE FROM radar_http_cache WHERE touched_at<NOW()-INTERVAL '7 days' AND (leased_until IS NULL OR leased_until<NOW())"
    );
    await this.execute(
      "DELETE FROM customer_radar_outbox WHERE status IN ('sent','unknown','cancelled','expired') AND created_at<NOW()-INTERVAL '30 days'"
    );
    await this.execute(
      "DELETE FROM radar_resources r WHERE next_poll_at<NOW()-INTERVAL '7 days' AND (leased_until IS NULL OR leased_until<NOW()) AND NOT EXISTS(SELECT 1 FROM customer_radar_interests i WHERE i.resource_id=r.id)"
    );
  }
}
export const radarRepo = new RadarRepository();
