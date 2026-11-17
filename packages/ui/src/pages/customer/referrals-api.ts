import { customerRequest } from './api';
export type ReferralStatus = 'registered' | 'approved' | 'requested' | 'paid' | 'rejected';
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
export interface ReferralDashboard {
  code: string;
  link: string;
  page: number;
  pageSize: number;
  total: number;
  records: CustomerReferralRecord[];
  available: number;
  paid: number;
  awaitingValidation: number;
  rewardedThisCycle: number;
  cycle: string;
  limit: number;
  minReward: number;
  maxReward: number;
}
export const referralsApi = {
  dashboard: (accountId: string, signal?: AbortSignal, page = 1, filter = 'all') =>
    customerRequest<ReferralDashboard>('/referrals', {
      accountId,
      signal,
      params: { page, filter },
    }),
  claim: (accountId: string, signal?: AbortSignal) =>
    customerRequest<{ claimed: boolean }>('/referrals/claim', {
      accountId,
      method: 'POST',
      body: {},
      signal,
    }),
  payout: (accountId: string, id: string, pixKey: string) =>
    customerRequest<{ record: CustomerReferralRecord }>(
      `/referrals/${encodeURIComponent(id)}/payout`,
      { accountId, method: 'POST', body: { pixKey } }
    ),
};
