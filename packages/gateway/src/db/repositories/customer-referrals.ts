import { createHash, randomBytes, randomInt, randomUUID } from 'node:crypto';
import { BaseRepository } from './base.js';
import { decryptJsonData, encryptJsonData, isEncryptedEnvelope } from '../data-encryption.js';

export type ReferralStatus = 'registered' | 'approved' | 'requested' | 'paid' | 'rejected';
interface ReferralRow {
  id: string;
  referrer_account_id: string;
  referee_account_id: string;
  status: ReferralStatus;
  reward_cents: number | null;
  cycle_key: string | null;
  subscription_reference: string | null;
  decision_note: string;
  pix_key: string | null;
  payout_reference: string | null;
  created_at: Date | string;
  approved_at: Date | string | null;
  requested_at: Date | string | null;
  paid_at: Date | string | null;
}
export interface CustomerReferralRecord {
  id: string;
  label: string;
  status: ReferralStatus;
  reward: number | null;
  cycle: string | null;
  note: string;
  createdAt: string;
  approvedAt: string | null;
  requestedAt: string | null;
  paidAt: string | null;
}
export class ReferralError extends Error {
  constructor(
    message: string,
    public readonly status = 409
  ) {
    super(message);
  }
}
export const referralTokenHash = (value: string) =>
  createHash('sha256').update(value).digest('hex');
export function referralCycle(date = new Date()): string {
  const parts = new Intl.DateTimeFormat('en-CA', {
    year: 'numeric',
    month: '2-digit',
    timeZone: 'America/Sao_Paulo',
  }).formatToParts(date);
  return `${parts.find((part) => part.type === 'year')!.value}-${parts.find((part) => part.type === 'month')!.value}`;
}
export function normalizePixKey(value: string): string {
  const key = value.trim();
  if (/^[^\s@<>]+@[^\s@<>]+\.[^\s@<>]+$/.test(key) && key.length <= 140) return key;
  if (/^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/i.test(key))
    return key.toLowerCase();
  if (/^[\d.\/()\s+-]+$/.test(key)) {
    const digits = key.replace(/\D/g, '');
    if (key.startsWith('+') && /^[1-9]\d{9,14}$/.test(digits)) return '+' + digits;
    if (!key.includes('+') && /^(?:\d{11}|\d{14})$/.test(digits)) return digits;
  }
  throw new ReferralError(
    'Informe um CPF, CNPJ, e-mail, telefone com +DDI ou chave aleatória válida.',
    400
  );
}
function readPix(value: string | null): string | null {
  if (!value) return null;
  const envelope: unknown = JSON.parse(value);
  if (!isEncryptedEnvelope(envelope))
    throw new ReferralError('A chave Pix precisa ser informada novamente.', 503);
  const key = decryptJsonData(envelope).pixKey;
  if (typeof key !== 'string') throw new ReferralError('Não foi possível ler a chave Pix.', 503);
  return key;
}
function iso(value: Date | string | null) {
  return value === null ? null : new Date(value).toISOString();
}
function publicRecord(row: ReferralRow): CustomerReferralRecord {
  return {
    id: row.id,
    label: `Convite AST-${row.id.replaceAll('-', '').slice(-6).toUpperCase()}`,
    status: row.status,
    reward: row.reward_cents === null ? null : row.reward_cents / 100,
    cycle: row.cycle_key,
    note: row.decision_note,
    createdAt: iso(row.created_at)!,
    approvedAt: iso(row.approved_at),
    requestedAt: iso(row.requested_at),
    paidAt: iso(row.paid_at),
  };
}
export class CustomerReferralsRepository extends BaseRepository {
  async code(accountId: string): Promise<string> {
    const code = `AST-${randomBytes(8).toString('hex').toUpperCase()}`;
    await this.execute(
      'INSERT INTO customer_referral_codes(account_id,code) VALUES($1,$2) ON CONFLICT(account_id) DO NOTHING',
      [accountId, code]
    );
    const stored = await this.queryOne<{ code: string }>(
      'SELECT code FROM customer_referral_codes WHERE account_id=$1',
      [accountId]
    );
    if (!stored) throw new ReferralError('Não foi possível criar seu convite.', 503);
    return stored.code;
  }
  async dashboard(accountId: string, page = 1, filter = 'all') {
    const code = await this.code(accountId);
    const selected =
      filter === 'progress'
        ? ['registered', 'requested']
        : filter === 'rewarded'
          ? ['approved', 'requested', 'paid']
          : filter === 'ineligible'
            ? ['rejected']
            : [];
    const records = await this.query<ReferralRow>(
      'SELECT * FROM customer_referrals WHERE referrer_account_id=$1 AND (cardinality($3::text[])=0 OR status=ANY($3::text[])) ORDER BY created_at DESC,id DESC LIMIT 20 OFFSET $2',
      [accountId, (page - 1) * 20, selected]
    );
    const totals = await this.queryOne<{
      available: string;
      paid: string;
      registered: string;
      approved: string;
      total: string;
    }>(
      `SELECT COUNT(*) FILTER(WHERE cardinality($3::text[])=0 OR status=ANY($3::text[]))::text AS total, COALESCE(SUM(reward_cents) FILTER(WHERE status IN ('approved','requested')),0)::text AS available, COALESCE(SUM(reward_cents) FILTER(WHERE status='paid'),0)::text AS paid, COUNT(*) FILTER(WHERE status='registered')::text AS registered, (SELECT COUNT(*)::text FROM customer_referral_audit a JOIN customer_referrals r ON r.id=a.referral_id WHERE r.referrer_account_id=$1 AND a.action='approved' AND a.details->>'cycle'=$2) AS approved FROM customer_referrals WHERE referrer_account_id=$1`,
      [accountId, referralCycle(), selected]
    );
    return {
      code,
      page,
      pageSize: 20,
      total: Number(totals?.total ?? 0),
      records: records.map(publicRecord),
      available: Number(totals?.available ?? 0) / 100,
      paid: Number(totals?.paid ?? 0) / 100,
      awaitingValidation: Number(totals?.registered ?? 0),
      rewardedThisCycle: Number(totals?.approved ?? 0),
      cycle: referralCycle(),
      limit: 5,
      minReward: 20,
      maxReward: 100,
    };
  }
  async visit(code: string, previousToken?: string): Promise<string | null> {
    if (previousToken && /^[a-f0-9]{64}$/.test(previousToken)) {
      const previous = await this.queryOne(
        'SELECT token_hash FROM customer_referral_visits WHERE token_hash=$1 AND expires_at>NOW() AND claimed_at IS NULL',
        [referralTokenHash(previousToken)]
      );
      if (previous) return previousToken;
    }
    const exists = await this.queryOne(
      'SELECT account_id FROM customer_referral_codes WHERE code=$1',
      [code]
    );
    if (!exists) return null;
    const token = randomBytes(32).toString('hex');
    await this.execute(
      "INSERT INTO customer_referral_visits(token_hash,code,expires_at) VALUES($1,$2,NOW()+INTERVAL '30 days')",
      [referralTokenHash(token), code]
    );
    return token;
  }
  async claim(token: string, accountId: string): Promise<boolean> {
    if (!/^[a-f0-9]{64}$/.test(token)) return false;
    return this.transaction(async () => {
      const visit = await this.queryOne<{ token_hash: string; inviter: string; eligible: boolean }>(
        `SELECT v.token_hash,c.account_id AS inviter,(a.created_at>=v.created_at AND u.first_seen_at::timestamptz>=v.created_at AND COALESCE(u.metadata->>'astraTrialReferral','')<>'julio') AS eligible FROM customer_referral_visits v JOIN customer_referral_codes c ON c.code=v.code JOIN customer_accounts a ON a.id=$2 JOIN channel_users u ON u.id=a.channel_user_id WHERE v.token_hash=$1 AND v.expires_at>NOW() AND v.claimed_at IS NULL FOR UPDATE OF v`,
        [referralTokenHash(token), accountId]
      );
      if (!visit || !visit.eligible || visit.inviter === accountId) return false;
      const id = randomUUID();
      const row = await this.queryOne<{ id: string }>(
        `INSERT INTO customer_referrals(id,referrer_account_id,referee_account_id) VALUES($1,$2,$3) ON CONFLICT(referee_account_id) DO NOTHING RETURNING id`,
        [id, visit.inviter, accountId]
      );
      await this.execute(
        'UPDATE customer_referral_visits SET claimed_account_id=$2,claimed_at=NOW() WHERE token_hash=$1',
        [visit.token_hash, accountId]
      );
      if (row) await this.audit(row.id, `customer:${accountId}`, 'registered', {});
      return Boolean(row);
    });
  }
  private async audit(id: string, actor: string, action: ReferralStatus, details: object) {
    await this.execute(
      'INSERT INTO customer_referral_audit(id,referral_id,actor,action,details) VALUES($1,$2,$3,$4,$5::jsonb)',
      [randomUUID(), id, actor, action, JSON.stringify(details)]
    );
  }
  async requestPayout(accountId: string, id: string, inputKey: string) {
    const pixKey = normalizePixKey(inputKey);
    return this.transaction(async () => {
      const row = await this.queryOne<ReferralRow>(
        'SELECT * FROM customer_referrals WHERE id=$1 AND referrer_account_id=$2 FOR UPDATE',
        [id, accountId]
      );
      if (!row) throw new ReferralError('Indicação não encontrada.', 404);
      if (row.status === 'requested' && readPix(row.pix_key) === pixKey) return publicRecord(row);
      if (row.status !== 'approved')
        throw new ReferralError('A recompensa precisa estar aprovada e ainda não solicitada.');
      const updated = await this.queryOne<ReferralRow>(
        "UPDATE customer_referrals SET status='requested',pix_key=$2,requested_at=NOW(),updated_at=NOW() WHERE id=$1 RETURNING *",
        [id, JSON.stringify(encryptJsonData({ pixKey }))]
      );
      await this.audit(id, `customer:${accountId}`, 'requested', {
        pixKeyHash: referralTokenHash(pixKey),
      });
      return publicRecord(updated!);
    });
  }
  async operatorList(status?: ReferralStatus, page = 1) {
    const rows = await this.query<
      ReferralRow & {
        referrer_name: string;
        referrer_phone: string;
        referee_name: string;
        referee_phone: string;
      }
    >(
      `SELECT r.*,a.display_name AS referrer_name,a.current_phone AS referrer_phone,b.display_name AS referee_name,b.current_phone AS referee_phone FROM customer_referrals r JOIN customer_accounts a ON a.id=r.referrer_account_id JOIN customer_accounts b ON b.id=r.referee_account_id ${status ? 'WHERE r.status=$1' : ''} ORDER BY r.created_at DESC,r.id DESC LIMIT 50 OFFSET $${status ? 2 : 1}`,
      status ? [status, (page - 1) * 50] : [(page - 1) * 50]
    );
    return rows.map((row) => ({ ...row, pix_key: readPix(row.pix_key) }));
  }
  async operatorCount(status?: ReferralStatus): Promise<number> {
    const row = await this.queryOne<{ total: string }>(
      `SELECT COUNT(*)::text AS total FROM customer_referrals ${status ? 'WHERE status=$1' : ''}`,
      status ? [status] : []
    );
    return Number(row?.total ?? 0);
  }
  async operatorAction(
    id: string,
    action: 'approve' | 'reject' | 'paid',
    reference: string,
    note: string,
    actor: string
  ) {
    return this.transaction(async () => {
      const row = await this.queryOne<ReferralRow>(
        'SELECT * FROM customer_referrals WHERE id=$1 FOR UPDATE',
        [id]
      );
      if (!row) throw new ReferralError('Indicação não encontrada.', 404);
      if (
        action === 'approve' &&
        ['approved', 'requested', 'paid'].includes(row.status) &&
        row.subscription_reference === reference
      )
        return publicRecord(row);
      if (action === 'paid' && row.status === 'paid' && row.payout_reference === reference)
        return publicRecord(row);
      if (action === 'reject' && row.status === 'rejected' && row.decision_note === note)
        return publicRecord(row);
      let updated: ReferralRow | null;
      if (action === 'approve') {
        if (row.status !== 'registered')
          throw new ReferralError('Esta indicação já recebeu uma decisão.');
        // Serialize all grants for this participant so concurrent reviews cannot exceed five.
        await this.queryOne(
          'SELECT account_id FROM customer_referral_codes WHERE account_id=$1 FOR UPDATE',
          [row.referrer_account_id]
        );
        const cycle = referralCycle();
        const count = await this.queryOne<{ count: string }>(
          "SELECT COUNT(*)::text AS count FROM customer_referral_audit a JOIN customer_referrals r ON r.id=a.referral_id WHERE r.referrer_account_id=$1 AND a.action='approved' AND a.details->>'cycle'=$2",
          [row.referrer_account_id, cycle]
        );
        if (Number(count?.count ?? 0) >= 5)
          throw new ReferralError('O participante já atingiu cinco recompensas neste mês.');
        const reward = randomInt(20, 101) * 100;
        updated = await this.queryOne<ReferralRow>(
          "UPDATE customer_referrals SET status='approved',reward_cents=$2,cycle_key=$3,subscription_reference=$4,decision_note=$5,approved_at=NOW(),updated_at=NOW() WHERE id=$1 RETURNING *",
          [id, reward, cycle, reference, note]
        );
        await this.audit(id, actor, 'approved', {
          subscriptionReference: reference,
          rewardCents: reward,
          cycle,
          note,
        });
      } else if (action === 'reject') {
        if (row.status === 'paid')
          throw new ReferralError(
            'O Pix já foi confirmado. Um pagamento realizado não pode ser apagado do histórico.'
          );
        updated = await this.queryOne<ReferralRow>(
          "UPDATE customer_referrals SET status='rejected',decision_note=$2,reward_cents=NULL,cycle_key=NULL,pix_key=NULL,updated_at=NOW() WHERE id=$1 RETURNING *",
          [id, note]
        );
        await this.audit(id, actor, 'rejected', {
          note,
          previousRewardCents: row.reward_cents,
          previousCycle: row.cycle_key,
        });
      } else {
        if (row.status !== 'requested')
          throw new ReferralError('Confira primeiro a solicitação e a chave Pix do participante.');
        updated = await this.queryOne<ReferralRow>(
          "UPDATE customer_referrals SET status='paid',payout_reference=$2,paid_at=NOW(),updated_at=NOW() WHERE id=$1 RETURNING *",
          [id, reference]
        );
        await this.audit(id, actor, 'paid', { payoutReference: reference, note });
      }
      return publicRecord(updated!);
    });
  }
}
export const customerReferralsRepo = new CustomerReferralsRepository();
