import { useRef, type ReactNode } from 'react';
import { CustomerDialog } from './components';
export {
  ApprovedHeading as PageHeading,
  ApprovedBadge as Badge,
  ApprovedEmpty as Empty,
} from './approved-finance-ui';

/** Keep the approved tab markup while retaining keyboard and accessible panel links. */
export function SectionTabs<T extends string>({
  items,
  value,
  onChange,
  label,
  prefix,
}: {
  items: readonly { id: T; label: string }[];
  value: T;
  onChange: (value: T) => void;
  label: string;
  prefix: string;
}) {
  const ref = useRef<HTMLDivElement>(null);
  return (
    <div
      className="segmented-control section-tabs"
      role="tablist"
      aria-label={label}
      ref={ref}
      onKeyDown={(event) => {
        if (!['ArrowLeft', 'ArrowRight', 'Home', 'End'].includes(event.key)) return;
        event.preventDefault();
        const current = items.findIndex((item) => item.id === value),
          next =
            event.key === 'Home'
              ? 0
              : event.key === 'End'
                ? items.length - 1
                : (current + (event.key === 'ArrowRight' ? 1 : -1) + items.length) % items.length;
        const item = items[next];
        if (!item) return;
        onChange(item.id);
        ref.current
          ?.querySelectorAll<HTMLButtonElement>('[role="tab"]')
          [next]?.focus({ preventScroll: true });
      }}
    >
      {items.map((item) => (
        <button
          type="button"
          key={item.id}
          id={`${prefix}-tab-${item.id}`}
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
export function Modal({
  title,
  subtitle,
  children,
  onClose,
  busy = false,
}: {
  title: string;
  subtitle?: string;
  children: ReactNode;
  onClose: () => void;
  busy?: boolean;
}) {
  return (
    <CustomerDialog title={title} onClose={onClose} busy={busy}>
      {subtitle ? <p className="form-hint">{subtitle}</p> : null}
      {children}
    </CustomerDialog>
  );
}
