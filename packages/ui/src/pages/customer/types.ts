export type CustomerTab = 'inicio' | 'transacoes' | 'categorias' | 'agenda' | 'perfil';
export type CustomerTheme = 'light' | 'dark' | 'system';
export interface Customer {
  accountId: string;
  dataUserId: string;
  phoneNumber: string;
  displayName: string;
  timeZone: string;
  currency: 'BRL';
  theme: CustomerTheme;
  hideAmounts: boolean;
  access: { status: 'active' | 'expired'; expiresAt: string | null; canWrite: boolean };
}
export interface CustomerChallenge {
  challengeId: string;
  expiresIn: number;
  retryAfter: number;
  message: string;
}
export interface CustomerSession {
  id: string;
  label: string;
  createdAt: string;
  lastSeenAt: string;
  expiresAt: string;
  current: boolean;
}
export type CustomerAppSlug =
  'gmail' | 'googlecalendar' | 'googledrive' | 'googlesheets' | 'todoist' | 'notion' | 'trello';
export interface CustomerConnectedApp {
  description?: string;
  slug: CustomerAppSlug;
  name: string;
  status: 'connected' | 'disconnected' | 'needs_attention' | 'unavailable';
  connectionId: string | null;
}
export interface CustomerConnectedAppsResponse {
  configured: boolean;
  apps: CustomerConnectedApp[];
}

export interface CustomerIntegrations {
  whatsapp?: {
    available: boolean;
    connected: boolean;
    status: 'connected' | 'disconnected' | 'unavailable';
  };
  googleCalendar: {
    available: boolean;
    connected: boolean;
    status: 'unavailable' | 'disconnected' | 'connected' | 'needs_attention';
    message: string;
  };
  siteUrl: string;
  renewalUrl: string | null;
  supportUrl: string | null;
}
export interface CustomerPeriod {
  from: string;
  to: string;
}
export interface CustomerCategory {
  id: string;
  name: string;
  type: 'income' | 'expense';
  color: string;
  archived: boolean;
}
export interface CustomerTransaction {
  id: string;
  description: string;
  amount: number;
  currency: 'BRL';
  type: 'income' | 'expense';
  status: 'settled' | 'pending';
  categoryId: string;
  categoryName: string;
  categoryColor: string;
  date: string;
  notes: string | null;
  source: string;
  createdAt: string;
  updatedAt: string;
}
export type TransactionInput = Pick<
  CustomerTransaction,
  'description' | 'amount' | 'type' | 'status' | 'categoryId' | 'date' | 'notes'
>;
export interface CustomerTransactionFilters extends CustomerPeriod {
  type?: 'income' | 'expense';
  status?: 'settled' | 'pending';
  categoryId?: string;
  search?: string;
  page: number;
  pageSize: number;
}
export interface CustomerTransactionPage {
  transactions: CustomerTransaction[];
  total: number;
  page: number;
  pageSize: number;
}
export interface CustomerFinanceSummary {
  period: CustomerPeriod;
  income: number;
  expenses: number;
  result: number;
  pendingIncome: number;
  pendingExpenses: number;
  series: { date: string; income: number; expenses: number }[];
  categories: { id: string; name: string; color: string; total: number; percentage: number }[];
  recent: CustomerTransaction[];
}
export type CustomerPlanKind = 'goal' | 'budget' | 'installment' | 'subscription';
export interface CustomerPlanInput {
  kind: CustomerPlanKind;
  title: string;
  amount: number;
  progress?: number;
  categoryId?: string | null;
  installmentsTotal?: number | null;
  installmentsPaid?: number | null;
  nextDueDate?: string | null;
  notes?: string | null;
}
export interface CustomerPlan extends CustomerPlanInput {
  id: string;
  progress: number;
  categoryId: string | null;
  installmentsTotal: number | null;
  installmentsPaid: number | null;
  nextDueDate: string | null;
  notes: string | null;
  createdAt: string;
  updatedAt: string;
}

export type AgendaKind = 'event' | 'task' | 'reminder' | 'bill';
export interface CustomerAgendaItem {
  id: string;
  kind: AgendaKind;
  title: string;
  startAt?: string | null;
  endAt?: string | null;
  dueDate?: string | null;
  completed: boolean;
  description?: string | null;
  timeZone: string;
  reminderAt?: string | null;
  source: string;
  syncStatus?: 'pending' | 'sending' | 'delivered' | 'failed' | 'cancelled' | null;
}
export interface AgendaInput {
  kind: Exclude<AgendaKind, 'bill'>;
  title: string;
  startAt?: string;
  endAt?: string | null;
  dueDate?: string | null;
  description?: string;
  reminderAt?: string | null;
}
