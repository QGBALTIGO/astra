import { act, type ReactNode } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { vi } from 'vitest';
import { customerApi } from './api';
import { dateInZone, monthPeriod } from './helpers';
import type {
  Customer,
  CustomerAgendaItem,
  CustomerCategory,
  CustomerFinanceSummary,
  CustomerTransaction,
} from './types';

export const customerFixture: Customer = {
  accountId: 'customer-test',
  dataUserId: 'whatsapp:5567999991234',
  phoneNumber: '5567999991234',
  displayName: 'Marina',
  timeZone: 'America/Campo_Grande',
  currency: 'BRL',
  theme: 'light',
  hideAmounts: false,
  access: { status: 'active', expiresAt: '2099-12-31T12:00:00Z', canWrite: true },
};
export const categoryFixtures: CustomerCategory[] = [
  { id: 'food', name: 'Alimentação', type: 'expense', color: '#0061FD', archived: false },
  { id: 'transport', name: 'Transporte', type: 'expense', color: '#B66F26', archived: false },
  { id: 'salary', name: 'Salário', type: 'income', color: '#207E65', archived: false },
];
export const transactionFixture: CustomerTransaction = {
  id: 'expense-test',
  description: 'Almoço',
  amount: 36.39,
  currency: 'BRL',
  type: 'expense',
  status: 'settled',
  categoryId: 'food',
  categoryName: 'Alimentação',
  categoryColor: '#0061FD',
  date: dateInZone(new Date(), 'America/Campo_Grande'),
  notes: null,
  source: 'whatsapp',
  createdAt: '2026-11-10T16:00:00Z',
  updatedAt: '2026-11-10T16:00:00Z',
};
export const summaryFixture: CustomerFinanceSummary = {
  period: monthPeriod('America/Campo_Grande'),
  income: 5000,
  expenses: 36.39,
  result: 4963.61,
  pendingIncome: 200,
  pendingExpenses: 150,
  series: [{ date: transactionFixture.date, income: 5000, expenses: 36.39 }],
  categories: [
    { id: 'food', name: 'Alimentação', color: '#0061FD', total: 36.39, percentage: 100 },
  ],
  recent: [transactionFixture],
};
export const agendaFixture: CustomerAgendaItem = {
  id: 'task-test',
  kind: 'task',
  title: 'Organizar a semana',
  dueDate: transactionFixture.date,
  completed: false,
  timeZone: customerFixture.timeZone,
  source: 'whatsapp',
};
export const challengeFixture = {
  challengeId: 'challenge-initial',
  expiresIn: 300,
  retryAfter: 60,
  message: 'Se este número tiver acesso ao Astra, você receberá um código pelo WhatsApp.',
};

export function mockCustomerApi(customer: Customer = structuredClone(customerFixture)) {
  return {
    session: vi.spyOn(customerApi, 'session').mockResolvedValue({ customer }),
    requestCode: vi.spyOn(customerApi, 'requestCode').mockResolvedValue(challengeFixture),
    verifyCode: vi.spyOn(customerApi, 'verifyCode').mockResolvedValue({ customer }),
    logout: vi.spyOn(customerApi, 'logout').mockResolvedValue({ loggedOut: true }),
    profile: vi.spyOn(customerApi, 'profile').mockResolvedValue({ profile: customer }),
    updateProfile: vi
      .spyOn(customerApi, 'updateProfile')
      .mockImplementation(async (body) => ({ profile: { ...customer, ...body } })),
    sessions: vi.spyOn(customerApi, 'sessions').mockResolvedValue({
      sessions: [
        {
          id: 'current',
          label: 'Chrome neste aparelho',
          createdAt: '2026-11-10T12:00:00Z',
          lastSeenAt: '2026-11-10T16:00:00Z',
          expiresAt: '2099-12-31T12:00:00Z',
          current: true,
        },
        {
          id: 'other',
          label: 'Firefox outro aparelho',
          createdAt: '2026-11-09T12:00:00Z',
          lastSeenAt: '2026-11-09T16:00:00Z',
          expiresAt: '2099-12-31T12:00:00Z',
          current: false,
        },
      ],
    }),
    revokeSession: vi
      .spyOn(customerApi, 'revokeSession')
      .mockResolvedValue({ revoked: true, current: false }),
    revokeOtherSessions: vi
      .spyOn(customerApi, 'revokeOtherSessions')
      .mockResolvedValue({ revoked: 1 }),
    integrations: vi.spyOn(customerApi, 'integrations').mockResolvedValue({
      googleCalendar: {
        available: false,
        connected: false,
        status: 'unavailable',
        message: 'Esta integração ainda não está disponível.',
      },
      whatsapp: { available: true, connected: true, status: 'connected' },
      siteUrl: 'https://astraacessor.vercel.app',
      renewalUrl: null,
      supportUrl: null,
    }),
    categories: vi
      .spyOn(customerApi, 'categories')
      .mockResolvedValue({ categories: structuredClone(categoryFixtures) }),
    summary: vi.spyOn(customerApi, 'summary').mockResolvedValue(structuredClone(summaryFixture)),
    transactions: vi
      .spyOn(customerApi, 'transactions')
      .mockResolvedValue({ transactions: [transactionFixture], total: 1, page: 1, pageSize: 20 }),
    createTransaction: vi
      .spyOn(customerApi, 'createTransaction')
      .mockResolvedValue({ transaction: transactionFixture }),
    updateTransaction: vi
      .spyOn(customerApi, 'updateTransaction')
      .mockResolvedValue({ transaction: transactionFixture }),
    deleteTransaction: vi
      .spyOn(customerApi, 'deleteTransaction')
      .mockResolvedValue({ deleted: true }),
    createCategory: vi
      .spyOn(customerApi, 'createCategory')
      .mockResolvedValue({ category: categoryFixtures[0]! }),
    updateCategory: vi
      .spyOn(customerApi, 'updateCategory')
      .mockResolvedValue({ category: categoryFixtures[0]! }),
    deleteCategory: vi
      .spyOn(customerApi, 'deleteCategory')
      .mockResolvedValue({ deleted: true, archived: false }),
    agenda: vi.spyOn(customerApi, 'agenda').mockResolvedValue({ items: [agendaFixture] }),
    createAgenda: vi.spyOn(customerApi, 'createAgenda').mockResolvedValue({ item: agendaFixture }),
    updateAgenda: vi.spyOn(customerApi, 'updateAgenda').mockResolvedValue({ item: agendaFixture }),
    deleteAgenda: vi.spyOn(customerApi, 'deleteAgenda').mockResolvedValue({ deleted: true }),
    completeTask: vi
      .spyOn(customerApi, 'completeTask')
      .mockResolvedValue({ item: { ...agendaFixture, completed: true } }),
    completeBill: vi.spyOn(customerApi, 'completeBill').mockResolvedValue({ item: agendaFixture }),
    requestPhoneChange: vi
      .spyOn(customerApi, 'requestPhoneChange')
      .mockResolvedValue(challengeFixture),
    confirmOldPhone: vi
      .spyOn(customerApi, 'confirmOldPhone')
      .mockResolvedValue({ ...challengeFixture, challengeId: 'challenge-new-number' }),
    confirmNewPhone: vi
      .spyOn(customerApi, 'confirmNewPhone')
      .mockResolvedValue({ customer: { ...customer, phoneNumber: '5511999995678' } }),
  };
}

export function testDom() {
  let root: Root;
  const container = document.createElement('div');
  document.body.appendChild(container);
  return {
    container,
    async render(node: ReactNode) {
      root ??= createRoot(container);
      await act(async () => root.render(node));
    },
    async cleanup() {
      if (root) await act(async () => root.unmount());
      container.remove();
    },
    button(name: string) {
      const result = Array.from(container.querySelectorAll<HTMLButtonElement>('button')).find(
        (button) =>
          !button.closest('[hidden]') &&
          (button.getAttribute('aria-label') === name ||
            button.textContent?.replace(/\s+/g, ' ').trim() === name)
      );
      if (!result) throw new Error('Button not found: ' + name);
      return result;
    },
    field(name: string) {
      const label = Array.from(container.querySelectorAll('label')).find(
        (label) => !label.closest('[hidden]') && label.textContent?.trim().startsWith(name)
      );
      const control = label?.control ?? label?.querySelector('input, select, textarea');
      if (!control) throw new Error('Field not found: ' + name);
      return control as HTMLInputElement | HTMLSelectElement | HTMLTextAreaElement;
    },
    async click(element: HTMLElement) {
      await act(async () => element.click());
    },
    async fill(element: HTMLInputElement | HTMLSelectElement | HTMLTextAreaElement, value: string) {
      const prototype =
        element instanceof HTMLSelectElement
          ? HTMLSelectElement.prototype
          : element instanceof HTMLTextAreaElement
            ? HTMLTextAreaElement.prototype
            : HTMLInputElement.prototype;
      await act(async () => {
        Object.getOwnPropertyDescriptor(prototype, 'value')!.set!.call(element, value);
        element.dispatchEvent(
          new Event(element instanceof HTMLSelectElement ? 'change' : 'input', { bubbles: true })
        );
      });
    },
    async submit() {
      const form =
        container.querySelector('[role="dialog"] form') ?? container.querySelector('form');
      if (!form) throw new Error('Form not found');
      await act(async () =>
        form.dispatchEvent(new Event('submit', { bubbles: true, cancelable: true }))
      );
    },
    async navigate(tab: string) {
      const link = Array.from(container.querySelectorAll<HTMLAnchorElement>('nav a')).find(
        (a) => a.textContent === tab
      );
      if (!link) throw new Error('Tab not found: ' + tab);
      await act(async () => link.click());
    },
  };
}

export function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (error: unknown) => void;
  const promise = new Promise<T>((yes, no) => {
    resolve = yes;
    reject = no;
  });
  return { promise, resolve, reject };
}
