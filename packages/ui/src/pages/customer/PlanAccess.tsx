import { useEffect, useState } from 'react';
import { Link } from 'react-router';
import { Calendar, ChevronRight, ShieldCheck } from '../../components/icons';
import { dateInZone, fullDate, validTimeZone } from './helpers';
import type { Customer } from './types';

export function planAccessState(customer: Customer, now = new Date()) {
  const zone = validTimeZone(customer.timeZone) ? customer.timeZone : 'America/Sao_Paulo';
  const expiry = customer.access.expiresAt ? new Date(customer.access.expiresAt) : null;
  const validExpiry = expiry !== null && Number.isFinite(expiry.getTime());
  const expired = customer.access.status === 'expired' || (validExpiry && expiry <= now);
  const days = validExpiry
    ? Math.round(
        (Date.parse(dateInZone(expiry, zone) + 'T12:00:00Z') -
          Date.parse(dateInZone(now, zone) + 'T12:00:00Z')) /
          86_400_000
      )
    : null;
  const soon = !expired && days !== null && days <= 3;
  const status = expired ? 'expired' : soon ? 'soon' : 'active';
  const label = expired ? 'Plano vencido' : soon ? 'Vence em breve' : 'Plano ativo';
  const date = validExpiry ? fullDate(expiry.toISOString(), zone) : null;
  const dateLabel = date
    ? `${expired ? 'Venceu em' : 'Válido até'} ${date}`
    : customer.access.expiresAt || expired
      ? 'Validade não informada'
      : 'Sem vencimento definido';
  const remaining = expired
    ? 'Renove para continuar criando e editando.'
    : days === null
      ? 'Confira os detalhes do seu acesso no Perfil.'
      : days === 0
        ? 'Vence hoje'
        : days === 1
          ? 'Vence amanhã'
          : `Faltam ${days} dias`;
  return { status, label, dateLabel, remaining, expiry: validExpiry ? expiry.toISOString() : null };
}

export function CustomerPlanAccess({
  customer,
  detailed = false,
}: {
  customer: Customer;
  detailed?: boolean;
}) {
  const [now, setNow] = useState(() => new Date());
  useEffect(() => {
    const timer = window.setInterval(() => setNow(new Date()), 60_000);
    return () => window.clearInterval(timer);
  }, []);
  const access = planAccessState(customer, now);
  return (
    <section
      className={'ac-plan-access' + (detailed ? ' ac-plan-access--detailed' : '')}
      data-status={access.status}
      aria-label="Validade do plano"
    >
      <span className="ac-plan-access-icon">
        <ShieldCheck aria-hidden="true" />
      </span>
      <div className="ac-plan-access-main">
        <span className="ac-plan-access-status">{access.label}</span>
        {access.expiry ? (
          <time dateTime={access.expiry}>{access.dateLabel}</time>
        ) : (
          <span className="ac-plan-access-date">{access.dateLabel}</span>
        )}
      </div>
      <span className="ac-plan-access-remaining">
        <Calendar aria-hidden="true" />
        {access.remaining}
      </span>
      {!detailed ? (
        <Link className="ac-text-link ac-plan-access-link" to="/cliente/perfil">
          Ver plano <ChevronRight aria-hidden="true" />
        </Link>
      ) : null}
    </section>
  );
}
