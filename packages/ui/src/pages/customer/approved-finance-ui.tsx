import type { ReactNode } from 'react';
import {
  Car,
  CircleDollarSign,
  GraduationCap,
  HeartPulse,
  House,
  Laptop,
  ShoppingBag,
  Sparkles,
  Plane,
  Utensils,
  BriefcaseBusiness,
  Flag,
  ShieldCheck,
} from 'lucide-react';
import { customerApi } from './api';
import type { CustomerTransaction, CustomerTransactionFilters } from './types';

export function ApprovedHeading({
  eyebrow,
  title,
  description,
  action,
}: {
  eyebrow: string;
  title: string;
  description: string;
  action?: ReactNode;
}) {
  return (
    <div className="page-heading">
      <div>
        <div className="eyebrow">{eyebrow}</div>
        <h1>{title}</h1>
        <p>{description}</p>
      </div>
      {action}
    </div>
  );
}
export function ApprovedCategoryIcon({ name = '', color }: { name?: string; color?: string }) {
  const value = name
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .toLocaleLowerCase('pt-BR');
  const explicit = {
    flag: Flag,
    shield: ShieldCheck,
    plane: Plane,
    laptop: Laptop,
    home: House,
    education: GraduationCap,
  }[value as 'flag'];
  const fallbackIcon = /alimenta|comida|mercado|cafe/.test(value)
    ? Utensils
    : /moradia|casa|home/.test(value)
      ? House
      : /transporte|carro|uber/.test(value)
        ? Car
        : /saude/.test(value)
          ? HeartPulse
          : /lazer|assinatura|musica/.test(value)
            ? Sparkles
            : /educa|curso/.test(value)
              ? GraduationCap
              : /salario/.test(value)
                ? BriefcaseBusiness
                : /freelance|tecnolog|notebook/.test(value)
                  ? Laptop
                  : /compra|parcela/.test(value)
                    ? ShoppingBag
                    : /meta|viagem/.test(value)
                      ? Flag
                      : /reserva|seguranca/.test(value)
                        ? ShieldCheck
                        : CircleDollarSign;
  const Icon = explicit || fallbackIcon;
  return (
    <span
      className="category-icon"
      style={{
        color: color || 'var(--blue)',
        background: color ? `color-mix(in srgb, ${color} 12%, transparent)` : undefined,
      }}
    >
      <Icon size={20} strokeWidth={1.8} />
    </span>
  );
}
export function ApprovedBadge({
  children,
  tone = 'neutral',
}: {
  children: ReactNode;
  tone?: string;
}) {
  return <span className={`badge ${tone}`}>{children}</span>;
}
export function ApprovedEmpty({
  title,
  description = 'Seus registros aparecerão aqui.',
  action,
}: {
  title: string;
  description?: string;
  action?: ReactNode;
}) {
  return (
    <div className="empty-state">
      <span className="empty-symbol">
        <Sparkles size={25} />
      </span>
      <h3>{title}</h3>
      <p>{description}</p>
      {action}
    </div>
  );
}
/** Collect every matching server page so category totals and filtered exports are not page-one estimates. */
export async function collectCustomerTransactions(
  filters: CustomerTransactionFilters,
  signal?: AbortSignal
): Promise<CustomerTransaction[]> {
  const result: CustomerTransaction[] = [];
  for (let page = 1; page <= 1000; page++) {
    const current = await customerApi.transactions({ ...filters, page, pageSize: 100 }, signal);
    result.push(...current.transactions);
    if (result.length >= current.total) return result;
    if (!current.transactions.length)
      throw new Error('A lista mudou durante a consulta. Atualize e tente novamente.');
  }
  throw new Error('Há muitos registros neste período. Escolha um intervalo menor.');
}
