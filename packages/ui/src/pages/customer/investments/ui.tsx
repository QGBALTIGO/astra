import { createContext, useContext, useId, useRef, type ReactNode } from 'react';
import { CustomerDialog, CustomerEmpty } from '../components';
import './investment-shared.css';

const InvestmentSavingContext = createContext(false);
export function InvestmentSaving({ busy, children }: { busy: boolean; children: ReactNode }) {
  return (
    <InvestmentSavingContext.Provider value={busy}>{children}</InvestmentSavingContext.Provider>
  );
}

export function Modal({
  title,
  subtitle,
  children,
  onClose,
  wide = false,
}: {
  title: string;
  subtitle?: string;
  children: ReactNode;
  onClose: () => void;
  wide?: boolean;
}) {
  const busy = useContext(InvestmentSavingContext);
  return (
    <CustomerDialog title={title} onClose={onClose} wide={wide} busy={busy}>
      <div className="ac-investment-ui">
        {subtitle && <p className="investment-modal-subtitle">{subtitle}</p>}
        <fieldset disabled={busy} className="investment-modal-lock">
          {children}
        </fieldset>
      </div>
    </CustomerDialog>
  );
}

export function Badge({ children, tone = 'neutral' }: { children: ReactNode; tone?: string }) {
  return <span className={`badge ${tone}`}>{children}</span>;
}

export function Empty({
  title,
  description,
  action,
}: {
  title: string;
  description?: string;
  action?: ReactNode;
}) {
  return (
    <CustomerEmpty title={title}>
      {description}
      {action}
    </CustomerEmpty>
  );
}

export function SectionTabs<T extends string>({
  items,
  value,
  onChange,
  label,
  prefix,
}: {
  items: { id: T; label: string }[];
  value: T;
  onChange: (id: T) => void;
  label: string;
  prefix: string;
}) {
  const ref = useRef<HTMLDivElement>(null);
  const fallback = useId();
  const id = prefix || fallback;
  return (
    <div
      className="segmented-control ac-segmented section-tabs"
      ref={ref}
      role="tablist"
      aria-label={label}
      onKeyDown={(event) => {
        if (!['ArrowLeft', 'ArrowRight', 'Home', 'End'].includes(event.key)) return;
        event.preventDefault();
        const index = items.findIndex((item) => item.id === value);
        const nextIndex =
          event.key === 'Home'
            ? 0
            : event.key === 'End'
              ? items.length - 1
              : (index + (event.key === 'ArrowRight' ? 1 : -1) + items.length) % items.length;
        const item = items[nextIndex];
        if (!item) return;
        onChange(item.id);
        ref.current
          ?.querySelectorAll<HTMLButtonElement>('[role="tab"]')
          [nextIndex]?.focus({ preventScroll: true });
      }}
    >
      {items.map((item) => (
        <button
          type="button"
          key={item.id}
          id={`${id}-tab-${item.id}`}
          role="tab"
          aria-selected={value === item.id}
          aria-controls={`${prefix}-content`}
          tabIndex={value === item.id ? 0 : -1}
          onClick={() => onChange(item.id)}
        >
          {item.label}
        </button>
      ))}
    </div>
  );
}
