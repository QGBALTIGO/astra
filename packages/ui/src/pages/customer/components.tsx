import { useEffect, useId, useRef, useState, type ReactNode } from 'react';
import {
  AlertCircle,
  Calendar,
  ChevronLeft,
  ChevronRight,
  RefreshCw,
  X,
} from '../../components/icons';
import { useFocusTrap } from '../../hooks/useFocusTrap';
import {
  dateInZone,
  dayOffset,
  monthPeriod,
  periodLabel,
  shiftMonth,
  validPeriod,
} from './helpers';
import type { CustomerPeriod } from './types';

export function CustomerBrand({ compact = false }: { compact?: boolean }) {
  return (
    <a
      href="/cliente"
      className={'ac-brand' + (compact ? ' ac-brand--compact' : '')}
      aria-label="Astra, início"
    >
      <img src="/astra-logo.svg" alt="Astra" width="1400" height="355" />
    </a>
  );
}
export function CustomerSkeleton({ label = 'Carregando seus registros…' }: { label?: string }) {
  return (
    <div className="ac-loading" role="status">
      <span className="ac-sr-only">{label}</span>
      <div className="ac-skeleton ac-skeleton--title" />
      <div className="ac-skeleton" />
      <div className="ac-skeleton" />
      <div className="ac-skeleton ac-skeleton--short" />
    </div>
  );
}
export function CustomerError({ error, onRetry }: { error: Error | string; onRetry?: () => void }) {
  return (
    <div className="ac-error" role="alert">
      <AlertCircle aria-hidden="true" />
      <div>
        <p>{typeof error === 'string' ? error : error.message}</p>
        {onRetry ? (
          <button className="ac-button ac-button--quiet" type="button" onClick={onRetry}>
            <RefreshCw aria-hidden="true" />
            Tentar novamente
          </button>
        ) : null}
      </div>
    </div>
  );
}
export function CustomerEmpty({
  title,
  children,
  action,
}: {
  title: string;
  children: ReactNode;
  action?: ReactNode;
}) {
  return (
    <div className="ac-empty">
      <div className="ac-empty-mark">
        <Calendar aria-hidden="true" />
      </div>
      <h3>{title}</h3>
      <p>{children}</p>
      {action}
    </div>
  );
}
export function CustomerDialog({
  title,
  children,
  footer,
  onClose,
  busy = false,
  wide = false,
}: {
  title: string;
  children: ReactNode;
  footer?: ReactNode;
  onClose: () => void;
  busy?: boolean;
  wide?: boolean;
}) {
  const id = useId();
  const ref = useRef<HTMLDivElement>(null);
  useFocusTrap(ref, true);
  useEffect(() => {
    const escape = (event: KeyboardEvent) => {
      if (event.key === 'Escape' && !busy) {
        event.preventDefault();
        onClose();
      }
    };
    document.addEventListener('keydown', escape);
    return () => document.removeEventListener('keydown', escape);
  }, [busy, onClose]);
  return (
    <div
      className="ac-overlay"
      onMouseDown={(event) => {
        if (event.target === event.currentTarget && !busy) onClose();
      }}
    >
      <div
        ref={ref}
        role="dialog"
        aria-modal="true"
        aria-labelledby={id}
        aria-busy={busy}
        className={'ac-dialog' + (wide ? ' ac-dialog--wide' : '')}
      >
        <header className="ac-dialog-head">
          <h2 id={id}>{title}</h2>
          <button
            type="button"
            className="ac-icon-button"
            aria-label="Fechar"
            disabled={busy}
            onClick={onClose}
          >
            <X aria-hidden="true" />
          </button>
        </header>
        <div className="ac-dialog-body">{children}</div>
        {footer ? <footer className="ac-dialog-footer">{footer}</footer> : null}
      </div>
    </div>
  );
}
export function CustomerConfirm({
  title,
  children,
  action,
  onConfirm,
  onClose,
  busy,
  error,
}: {
  title: string;
  children: ReactNode;
  action: string;
  onConfirm: () => void;
  onClose: () => void;
  busy: boolean;
  error?: string | null;
}) {
  return (
    <CustomerDialog
      title={title}
      onClose={onClose}
      busy={busy}
      footer={
        <>
          <button
            type="button"
            className="ac-button ac-button--secondary"
            disabled={busy}
            onClick={onClose}
          >
            Cancelar
          </button>
          <button
            type="button"
            className="ac-button ac-button--danger"
            disabled={busy}
            onClick={onConfirm}
          >
            {busy ? 'Aguarde…' : action}
          </button>
        </>
      }
    >
      <p className="ac-body-copy">{children}</p>
      {error ? <CustomerError error={error} /> : null}
    </CustomerDialog>
  );
}
export function PeriodPicker({
  value,
  onChange,
  timeZone,
}: {
  value: CustomerPeriod;
  onChange: (period: CustomerPeriod) => void;
  timeZone: string;
}) {
  const id = useId();
  const [custom, setCustom] = useState(false);
  const current = monthPeriod(timeZone);
  const previous = monthPeriod(timeZone, -1);
  const today = dateInZone(new Date(), timeZone);
  const last30 = { from: dayOffset(today, -29), to: today };
  const equal = (period: CustomerPeriod) => period.from === value.from && period.to === value.to;
  const preset = custom
    ? 'custom'
    : equal(current)
      ? 'current'
      : equal(previous)
        ? 'previous'
        : equal(last30)
          ? 'last30'
          : 'custom';
  return (
    <div className="ac-period">
      <div className="ac-period-main">
        <button
          type="button"
          className="ac-icon-button"
          aria-label="Mês anterior"
          disabled={!validPeriod(value)}
          onClick={() => {
            setCustom(false);
            onChange(shiftMonth(value, -1));
          }}
        >
          <ChevronLeft aria-hidden="true" />
        </button>
        <span className="ac-period-caption">{periodLabel(value)}</span>
        <button
          type="button"
          className="ac-icon-button"
          aria-label="Próximo mês"
          disabled={!validPeriod(value)}
          onClick={() => {
            setCustom(false);
            onChange(shiftMonth(value, 1));
          }}
        >
          <ChevronRight aria-hidden="true" />
        </button>
        <label className="ac-sr-only" htmlFor={id}>
          Período
        </label>
        <select
          id={id}
          value={preset}
          onChange={(event) => {
            const selected = event.target.value;
            setCustom(selected === 'custom');
            if (selected !== 'custom')
              onChange(
                selected === 'current' ? current : selected === 'previous' ? previous : last30
              );
          }}
        >
          <option value="current">Este mês</option>
          <option value="previous">Mês passado</option>
          <option value="last30">Últimos 30 dias</option>
          <option value="custom">Personalizado</option>
        </select>
      </div>
      {preset === 'custom' ? (
        <div className="ac-period-dates">
          <label>
            De
            <input
              aria-label="Data inicial"
              type="date"
              value={value.from}
              onChange={(event) => onChange({ ...value, from: event.target.value })}
            />
          </label>
          <label>
            Até
            <input
              aria-label="Data final"
              type="date"
              value={value.to}
              onChange={(event) => onChange({ ...value, to: event.target.value })}
            />
          </label>
        </div>
      ) : null}
      {!validPeriod(value) ? (
        <p role="alert" className="ac-field-error">
          Informe um período válido, com a data final após a inicial.
        </p>
      ) : null}
    </div>
  );
}
export function SourceLabel({ source }: { source?: string }) {
  if (!source) return null;
  const label = source.toLowerCase().includes('whatsapp')
    ? 'WhatsApp'
    : ['portal', 'customer', 'panel', 'web'].some((value) => source.toLowerCase().includes(value))
      ? 'Painel'
      : 'Astra';
  return <span className="ac-source">{label}</span>;
}
