import { Link } from 'react-router-dom';

interface EmptyStateAction {
  label: string;
  href: string;
  ariaLabel: string;
}

interface EmptyStateProps {
  title?: string;
  text: string;
  action?: EmptyStateAction;
}

export default function EmptyState({ title, text, action }: EmptyStateProps) {
  return (
    <div className="rounded-[var(--ik-radius-panel)] border border-[var(--ik-border)] bg-[var(--ik-mist)] p-4">
      {title && <h3 className="text-sm font-bold text-[var(--ik-ink)]">{title}</h3>}
      <p className="mt-1 text-sm leading-relaxed text-[var(--ik-ink-muted)]">{text}</p>
      {action && (
        <Link
          to={action.href}
          aria-label={action.ariaLabel}
          className="ik-button-secondary mt-3 inline-flex min-h-11 items-center justify-center border-2 bg-[var(--ik-surface)] px-4 py-2 font-bold hover:bg-[var(--ik-sage)]"
        >
          {action.label}
        </Link>
      )}
    </div>
  );
}
